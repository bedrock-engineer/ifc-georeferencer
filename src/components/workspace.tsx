import {
  Activity,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";

import {
  buildSidecar,
  localOriginsEqual,
  parseSidecar,
  sidecarFilenameFor,
  sidecarToParams,
  type SidecarError,
} from "#lib/ifcgref-sidecar";
import { triggerDownload } from "#lib/download";
import { emitLog } from "#lib/log";
import { type HelmertParams } from "#modules/helmert/solve";
import type { IfcMetadata } from "#modules/ifc/worker";
import { getIfc } from "../ifc-api";
import { deriveGeorefView } from "#state/georef-status/derive-view";
import {
  derivePickBlockedReason,
  deriveSaveBlockedReason,
  deriveSaveWarning,
  findingToLogMessage,
} from "#state/georef-status/format";
import { deriveOverlaySignals } from "#state/georef-status/overlay-signals";
import { deriveMapReferences } from "#state/georef-status/references";
import { findingKey, type MapOverlaySignals } from "#state/georef-status/types";
import {
  anchorParams,
  anchorSurveyPoints,
  initialAnchor,
  makeAnchorReducer,
  predictWriteEntity,
} from "#state/workspace";
import { MapView, type MapViewHandle } from "./map/map-view";
import { AnchorCard } from "./sidebar/cards/anchor-card";
import { RotationCard } from "./sidebar/cards/rotation-card";
import { SaveCard } from "./sidebar/cards/save-card";
import { SourceCard } from "./sidebar/cards/source-card";
import { SurveyPointsCard } from "./sidebar/cards/survey-points-card";
import { TargetCrsCard } from "./sidebar/cards/target-crs-card";
import { Sidebar } from "./sidebar/sidebar";
import { createHelmertSolver } from "./workspace/helmert-solve";
import { useAnchorPick } from "./workspace/use-anchor-pick";
import { useExtractedFootprint } from "./workspace/use-extracted-footprint";
import { useExtractedSpaces } from "./workspace/use-extracted-spaces";
import { useIfcWrite } from "./workspace/use-ifc-write";
import { useTargetCrs } from "./workspace/use-target-crs";
import { writeMapConversionToWorker } from "./workspace/write-map-conversion";

export interface WorkspaceProps {
  filename: string;
  metadata: IfcMetadata;
  onError: (message: string) => void;
}

export function Workspace({
  filename,
  metadata: initialMetadata,
  onError,
}: WorkspaceProps) {
  // Metadata lives locally so in-place worker mutations (e.g. site-
  // placement zero from the baked-origin warning) can refresh it without
  // bouncing through app.tsx. The prop only seeds — a new file remounts
  // Workspace via `key={filename}` at the parent, which re-seeds.
  const [metadata, setMetadata] = useState(initialMetadata);

  // Bumped after a worker mutation that invalidates extracted geometry
  // (footprint/spaces). The extraction hooks re-fetch on epoch change.
  const [extractEpoch, setExtractEpoch] = useState(0);

  const [anchor, dispatchAnchor] = useReducer(
    makeAnchorReducer(metadata.existingGeoref),
    metadata,
    initialAnchor,
  );

  function reportError(message: string) {
    emitLog({ level: "error", message });
    onError(message);
  }

  const { epsgCode, crsState, activeCrs, changeEpsg, replaceEpsg } =
    useTargetCrs({
      metadata,
      currentParams: anchorParams(anchor),
      onReproject: (params) => {
        dispatchAnchor({ type: "paramsReplaced", params });
        frameNow(nextSignalsAfter(params));
      },
      onError: reportError,
    });

  // Vertical datum is independent of the horizontal CRS lookup. IFC
  // stores it as a free-form IfcIdentifier, not an EPSG code, so it lives
  // here as a plain string. Initialised from the file's existing hint.
  const [verticalDatum, setVerticalDatum] = useState<string | null>(
    metadata.verticalDatumHint,
  );

  // The wide georef view: effective Helmert + provenance + map references
  // + bakedProjectedOrigin + CRS-scoped findings, in one pure derivation.
  // The bbox sanity-gate proj4 round-trip happens inside `deriveGeorefView`
  // and is what makes `useMemo` worth it (one transform per change vs. one
  // per render). See docs/crs-datum-grids.md.
  const view = useMemo(
    () => deriveGeorefView({ metadata, activeCrs, anchor }),
    [metadata, activeCrs, anchor],
  );

  // Single emitter for CRS-scoped findings. Dedupes by `findingKey`
  const seenFindingsRef = useRef<Set<string>>(new Set());
  useEffect(
    function emitNewFindings() {
      for (const finding of view.findings) {
        const key = findingKey(finding);
        if (seenFindingsRef.current.has(key)) {
          continue;
        }
        seenFindingsRef.current.add(key);
        emitLog({ level: "warn", message: findingToLogMessage(finding) });
      }
    },
    [view.findings],
  );

  // `editableParameters` drives the editing surfaces (AnchorCard,
  // RotationCard) so a wildly out-of-area typed value stays visible and
  // the inline validator can fire. `effectiveParameters` is the gated
  // value — null when the helmert would project outside the active
  // CRS — and feeds everything that would crash or render NaN on bad
  // input (map overlays, write, framing, pick). See GeorefView docs.
  const { editableParameters, effectiveParameters, provenance, references } =
    view;
  const pickBlockedReason = derivePickBlockedReason(view, activeCrs);
  const saveBlockedReason = deriveSaveBlockedReason(view);
  const saveWarning = deriveSaveWarning(activeCrs, verticalDatum);

  const footprintLocal = useExtractedFootprint(extractEpoch);
  const spacesLocal = useExtractedSpaces(extractEpoch);

  // Camera framing is event-driven: solve, pick, reset, reproject, sidecar
  // each call `frameNow` directly. The two effects below cover data-arrival
  // syncs that don't have an event source — `effectiveParameters` arriving
  // from CRS-driven seeding, and `footprintLocal` resolving from the worker.
  const coordinateOperationLabel = deriveCoordinateOperationLabel(metadata);
  const overlaySignals = useMemo<MapOverlaySignals>(
    () =>
      deriveOverlaySignals({
        references,
        effectiveParameters,
        activeCrs,
        footprintLocal,
        spacesLocal,
        coordinateOperationLabel,
      }),
    [
      references,
      effectiveParameters,
      activeCrs,
      footprintLocal,
      spacesLocal,
      coordinateOperationLabel,
    ],
  );

  const mapViewRef = useRef<MapViewHandle>(null); // expose maplibre-gl a bit
  const hasFramedRef = useRef(false);
  const framedWithFootprintRef = useRef(false);

  function frameNow(signals: MapOverlaySignals) {
    hasFramedRef.current = true;
    if (signals.footprint !== null) {
      framedWithFootprintRef.current = true;
    }
    mapViewRef.current?.frameToContent(signals);
  }

  // Recompute overlay signals from a "next" params value before the dispatch
  // has committed — used by event handlers so the imperative frame call
  // doesn't have to wait a render cycle for `overlaySignals` to update.
  function nextSignalsAfter(params: HelmertParams): MapOverlaySignals {
    const nextReferences = deriveMapReferences(metadata, params, activeCrs);
    return deriveOverlaySignals({
      references: nextReferences,
      effectiveParameters: params,
      activeCrs,
      footprintLocal,
      spacesLocal,
      coordinateOperationLabel,
    });
  }

  useEffect(
    function frameOnFirstAppearance() {
      if (!hasFramedRef.current && effectiveParameters) {
        frameNow(overlaySignals);
      }
    },
    [effectiveParameters, overlaySignals],
  );

  useEffect(
    function promoteToFootprint() {
      if (
        hasFramedRef.current &&
        !framedWithFootprintRef.current &&
        effectiveParameters &&
        overlaySignals.footprint !== null
      ) {
        frameNow(overlaySignals);
      }
    },
    [overlaySignals, effectiveParameters],
  );

  const solve = createHelmertSolver({
    metadata,
    activeCrs,
    onSolved: ({ params, points }) => {
      dispatchAnchor({ type: "solved", params, points });
      frameNow(nextSignalsAfter(params));
    },
    onError: reportError,
  });

  // Residuals points live on `anchor.survey.points` so they stay in
  // lockstep with provenance — editing/picking/resetting/CRS-swapping
  // the anchor drops the points and the chart disappears.
  const lastFitPoints = anchorSurveyPoints(anchor);

  const { busy, write } = useIfcWrite({
    filename,
    parameters: effectiveParameters,
    activeCrs,
    verticalDatum,
    onError: reportError,
  });

  const {
    isPickingAnchor,
    start: startPickAnchor,
    cancel: cancelPickAnchor,
    handlePicked: handleAnchorPicked,
  } = useAnchorPick({
    metadata,
    activeCrs,
    base: effectiveParameters,
    onPicked: (params) => {
      dispatchAnchor({ type: "picked", params });
      frameNow(nextSignalsAfter(params));
    },
    onError: reportError,
  });

  // "Move offset to IfcMapConversion" from the baked-origin warning.
  // Both mutations happen on click (not at save), so the source card
  // re-reflects the repaired file immediately: localOrigin → (0,0,0),
  // baked-origin detector stops firing, IfcMapConversion section shows
  // the new anchor instead of "placeholder — ignored", and LoGeoRef
  // level promotes to 50. On save, useIfcWrite writes MapConversion
  // again with whatever the user edited in between — write is idempotent
  // (remove existing + write new). Caller-side: button is disabled until
  // a CRS is selected, so `activeCrs` should be non-null by the time we
  // get here. Defensive guard for bakedProjectedOrigin is here in case
  // the warning's visibility ever drifts from this handler's.
  //
  // useTransition gates the button into a pending state while the three
  // worker calls run (zero placement → write MC → re-read metadata). On
  // large IFCs this can take a few seconds; without the pending state
  // the user can't tell whether the click landed.
  // One shared pending flag for both baked-origin repair paths. The two
  // notices that fire these handlers are mutually exclusive (one needs
  // `existingGeoref`, the other its absence), so only one button can be
  // in flight at a time — splitting into two flags would be ceremony.
  const [isRepairingBakedOrigin, startRepair] = useTransition();

  function handleAdoptBakedOriginAsAnchor() {
    if (!view.bakedProjectedOrigin || !activeCrs) {
      return;
    }
    const baked = view.bakedProjectedOrigin;
    const params: HelmertParams = {
      easting: baked.x,
      northing: baked.y,
      height: baked.z,
      xScale: 1,
      yScale: 1,
      zScale: 1,
      rotation: 0,
    };
    const ifc = getIfc();
    startRepair(async () => {
      try {
        await ifc.zeroSitePlacementLocation();
      } catch (error) {
        reportError(
          `Failed to zero IfcSite.ObjectPlacement: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      try {
        await writeMapConversionToWorker({
          ifc,
          parameters: params,
          activeCrs,
          verticalDatum,
        });
      } catch (error) {
        reportError(
          `Failed to write IfcMapConversion: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      try {
        const fresh = await ifc.readMetadata();
        // Batched into one render so we never flash a "stale localOrigin
        // + new params" view (which would land the helmert outside the
        // CRS bbox and gate save off mid-render). React 18 batches state
        // updates inside async event handlers across awaits.
        setMetadata(fresh);
        dispatchAnchor({ type: "edited", params });
        setExtractEpoch((previous) => previous + 1);
        // Let the framing effects re-fire when fresh footprint/refs land.
        hasFramedRef.current = false;
        framedWithFootprintRef.current = false;
        emitLog({
          message: `Moved IfcSite placement offset (${baked.x.toFixed(2)}, ${baked.y.toFixed(2)}, ${baked.z.toFixed(2)}) m into IfcMapConversion anchor`,
        });
      } catch (error) {
        reportError(
          `Failed to refresh metadata after repair: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  // "Remove duplicate offset from IfcSite" from the double-baked-origin
  // notice. Unlike the adopt-baked-origin path above, we do *not* touch
  // IfcMapConversion — the file already has a real one that carries the
  // same offset; that's the whole double-baked condition. Just zero the
  // IfcSite placement so the combo stops double-translating, then re-read
  // metadata so localOrigin → (0,0,0) on the source card and the
  // double-baked detector stops firing.
  function handleClearSitePlacement() {
    if (!view.doubleBakedOrigin) {
      return;
    }
    const offset = view.doubleBakedOrigin;
    const ifc = getIfc();
    startRepair(async () => {
      try {
        await ifc.zeroSitePlacementLocation();
      } catch (error) {
        reportError(
          `Failed to zero IfcSite.ObjectPlacement: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      try {
        const fresh = await ifc.readMetadata();
        setMetadata(fresh);
        setExtractEpoch((previous) => previous + 1);
        // Let the framing effects re-fire once effectiveParameters
        // promotes from null back to a real value (the whole reason we
        // did this).
        hasFramedRef.current = false;
        framedWithFootprintRef.current = false;
        emitLog({
          message: `Zeroed IfcSite.ObjectPlacement (was (${offset.x.toFixed(2)}, ${offset.y.toFixed(2)}, ${offset.z.toFixed(2)}) m, duplicated by IfcMapConversion)`,
        });
      } catch (error) {
        reportError(
          `Failed to refresh metadata after zeroing site placement: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  function handleDownloadSidecar() {
    if (!effectiveParameters || !activeCrs) {
      return;
    }

    const sidecar = buildSidecar({
      filename,
      schema: metadata.schema,
      localOrigin: metadata.localOrigin,
      activeCrs,
      verticalDatum,
      parameters: effectiveParameters,
    });
    const json = JSON.stringify(sidecar, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    triggerDownload(blob, sidecarFilenameFor(filename));

    emitLog({
      message:
        `Exported .ifcgref.json file (EPSG:${activeCrs.code}` +
        (verticalDatum ? `, vertical=${verticalDatum}` : "") +
        ")",
    });
  }

  async function handleApplySidecar(file: File) {
    let text: string;

    try {
      text = await file.text();
    } catch (error) {
      reportError(`Couldn't read .ifcgref.json file: ${String(error)}`);
      return;
    }

    const parsed = parseSidecar(text);
    if (parsed.isErr()) {
      reportError(sidecarErrorMessage(parsed.error));
      return;
    }

    const sidecar = parsed.value;
    const params = sidecarToParams(sidecar);
    const originsMatch = localOriginsEqual(
      sidecar.source.localOrigin,
      metadata.localOrigin,
    );

    replaceEpsg(String(sidecar.projectedCrs.epsg));
    setVerticalDatum(sidecar.projectedCrs.verticalDatum);
    dispatchAnchor({ type: "edited", params });

    // Sidecar apply may change the active CRS (resolves async via
    // useCrsResolution). Reset the framed-state so `frameOnFirstAppearance`
    // takes over once `effectiveParameters` lands inside the new CRS's
    // bbox — calling `frameNow` synchronously here would project through
    // the *old* CRS when the sidecar EPSG differs.
    hasFramedRef.current = false;
    framedWithFootprintRef.current = false;

    emitLog({
      level: originsMatch ? "info" : "warn",
      message:
        `Applied .ifcgref.json from "${sidecar.source.filename}" ` +
        `(EPSG:${sidecar.projectedCrs.epsg}, exported ${sidecar.exportedAt})` +
        (originsMatch
          ? ""
          : " — source localOrigin differs from this file; verify placement"),
    });
  }

  return (
    <>
      <Sidebar
        saveCard={
          <SaveCard
            busy={busy}
            canWrite={
              effectiveParameters !== null && saveBlockedReason === null
            }
            blockedReason={saveBlockedReason}
            warning={saveWarning}
            predictedWriteEntity={predictWriteEntity(
              metadata,
              effectiveParameters,
            )}
            onWrite={write}
          />
        }
      >
        <SourceCard
          filename={filename}
          metadata={metadata}
          siteOutsideBbox={references.siteOutsideBbox}
          activeCrsCode={activeCrs?.code ?? null}
          bakedProjectedOrigin={view.bakedProjectedOrigin}
          doubleBakedOrigin={view.doubleBakedOrigin}
          hasActiveCrs={activeCrs !== null}
          isRepairingBakedOrigin={isRepairingBakedOrigin}
          onAdoptBakedOrigin={handleAdoptBakedOriginAsAnchor}
          onClearSitePlacement={handleClearSitePlacement}
          onZoomToSite={(site) => {
            mapViewRef.current?.flyToSite(site);
          }}
          canDownloadSidecar={
            effectiveParameters !== null && activeCrs !== null
          }
          onDownloadSidecar={handleDownloadSidecar}
          onApplySidecar={(file) => {
            void handleApplySidecar(file);
          }}
        />

        <TargetCrsCard
          epsgCode={epsgCode}
          crsState={crsState}
          onChange={(code) => {
            void changeEpsg(code);
          }}
          fromFile={Boolean(metadata.existingGeoref?.targetCrsName)}
          verticalDatum={verticalDatum}
          onVerticalDatumChange={setVerticalDatum}
        />

        <Tabs defaultSelectedKey="reference" className="space-y-2">
          <TabList
            aria-label="Georeferencing method"
            className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1 text-xs font-medium"
          >
            <Tab
              id="reference"
              className="cursor-pointer rounded px-3 py-1.5 text-center text-slate-600 outline-none transition-[background-color,color,box-shadow] duration-150 data-focus-visible:ring-2 data-focus-visible:ring-slate-500 data-hovered:text-slate-900 data-selected:bg-white data-selected:text-slate-900 data-selected:shadow-sm"
            >
              Reference point
            </Tab>

            <Tab
              id="survey"
              className="cursor-pointer rounded px-3 py-1.5 text-center text-slate-600 outline-none transition-[background-color,color,box-shadow] duration-150 data-focus-visible:ring-2 data-focus-visible:ring-slate-500 data-hovered:text-slate-900 data-selected:bg-white data-selected:text-slate-900 data-selected:shadow-sm"
            >
              Survey points
            </Tab>
          </TabList>

          <TabPanel id="reference" shouldForceMount>
            {({ isInert }) => (
              <Activity mode={isInert ? "hidden" : "visible"}>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <AnchorCard
                    parameters={editableParameters}
                    activeCrs={activeCrs}
                    provenance={provenance}
                    isPicking={isPickingAnchor}
                    canResetToFile={Boolean(metadata.existingGeoref)}
                    pickBlockedReason={pickBlockedReason}
                    onEdit={(params) => {
                      dispatchAnchor({ type: "edited", params });
                    }}
                    onStartPick={startPickAnchor}
                    onCancelPick={cancelPickAnchor}
                    onResetToFile={() => {
                      dispatchAnchor({ type: "resetToFile" });
                      const fileParams = metadata.existingGeoref?.helmert;
                      if (fileParams) {
                        frameNow(nextSignalsAfter(fileParams));
                      }
                    }}
                  />
                </div>
              </Activity>
            )}
          </TabPanel>

          <TabPanel id="survey" shouldForceMount>
            {({ isInert }) => (
              <Activity mode={isInert ? "hidden" : "visible"}>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <SurveyPointsCard
                    metadata={metadata}
                    activeCrs={activeCrs}
                    busy={busy}
                    onSolve={solve}
                    lastFitPoints={lastFitPoints}
                    currentParams={effectiveParameters}
                  />
                </div>
              </Activity>
            )}
          </TabPanel>
        </Tabs>

        <RotationCard
          parameters={editableParameters}
          provenance={provenance}
          onParametersChange={(params: HelmertParams) => {
            dispatchAnchor({ type: "edited", params });
          }}
          metadata={metadata}
        />
      </Sidebar>

      <MapView
        ref={mapViewRef}
        parameters={effectiveParameters}
        activeCrs={activeCrs}
        overlaySignals={overlaySignals}
        isPickingAnchor={isPickingAnchor}
        onAnchorPicked={handleAnchorPicked}
        onCancelPickAnchor={cancelPickAnchor}
        residualsPoints={lastFitPoints}
        hasSpaces={(spacesLocal?.length ?? 0) > 0}
      />
    </>
  );
}

/**
 * Pick the entity name to render on the coordinate-operation map marker.
 * Tracks `activeCoordinateOperation`: when IfcRigidOperation drives the
 * anchor, the marker reads "IfcRigidOperation" rather than the misleading
 * "IfcMapConversion". For MapConversion-driven and IFC2X3 paths we prefer
 * the actual entity name (handles IfcMapConversionScaled) and fall back to
 * the schema-default ePset / native label.
 */
function deriveCoordinateOperationLabel(metadata: IfcMetadata): string {
  if (metadata.activeCoordinateOperation === "rigid-operation") {
    return "IfcRigidOperation";
  }

  if (metadata.rawMapConversion?.entityName) {
    return metadata.rawMapConversion.entityName;
  }

  return metadata.schema === "IFC2X3"
    ? "ePSet_MapConversion"
    : "IfcMapConversion";
}

function sidecarErrorMessage(error: SidecarError): string {
  switch (error.kind) {
    case "invalid-json": {
      return "ifcgref.json file isn't valid JSON.";
    }
    case "unsupported-version": {
      return `ifcgref.json formatVersion ${String(error.got)} isn't supported by this build of ifcgref.`;
    }
    case "schema-mismatch": {
      return "ifcgref.json shape doesn't match the expected schema.";
    }
  }
}
