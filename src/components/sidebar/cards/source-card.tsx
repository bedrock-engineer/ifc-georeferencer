import type { XYZ } from "#modules/helmert/solve";
import { type LoGeoref } from "#modules/ifc/lo-geo-ref";
import type { IfcMetadata, RawProjectedCrs } from "#modules/ifc/worker";
import { lengthUnitNameForMetres, unitToMetres } from "#modules/units/convert";
import { describeIfcUnit } from "#modules/units/format";
import { Button } from "../../input/button";
import { Card } from "../card";
import { GeometricContextSection } from "./source-card/geometric-context-section";
import { MapConversionSection } from "./source-card/map-conversion-section";
import { ProjectedCrsSection } from "./source-card/projected-crs-section";
import { RigidOperationSection } from "./source-card/rigid-operation-section";
import { Row } from "./source-card/row";
import { SiteSection } from "./source-card/site-section";
import { SidecarControls } from "./sidecar-controls";

interface SourceCardProps {
  filename: string;
  metadata: IfcMetadata;
  /**
   * True when the file's IfcSite RefLat/RefLon falls outside the active
   * CRS area of use. The map skips the marker; this card flags the value
   * inline so the user notices the discrepancy.
   */
  siteOutsideBbox: boolean;
  /** EPSG code of the active CRS, used in the outside-bbox tooltip. */
  activeCrsCode: number | null;
  /**
   * When the file's IfcSite placement looks like projected coordinates
   * baked into IfcSite.ObjectPlacement (per `detectBakedProjectedOrigin`),
   * this carries the offending XYZ so the card can render a top-level
   * notice. The placement value itself is shown inside the IfcSite section
   * (ObjectPlacement.Location row). Mutually exclusive with
   * `doubleBakedOrigin`.
   */
  bakedProjectedOrigin: XYZ | null;
  /**
   * Counterpart of `bakedProjectedOrigin` for files that *also* have an
   * IfcMapConversion carrying the same offset (double-baked). The notice
   * here proposes a different fix — just zero the IfcSite placement,
   * leave the existing IfcMapConversion alone. Mutually exclusive with
   * `bakedProjectedOrigin`. */
  doubleBakedOrigin: XYZ | null;
  /**
   * True when a target CRS is selected. The "Move offset to
   * IfcMapConversion" action needs a CRS to be meaningful (the offset is
   * interpreted in CRS units on write), so the button is disabled until
   * the user picks one.
   */
  hasActiveCrs: boolean;
  /**
   * True while either baked-origin repair handler is running. Shared
   * pending flag — at most one of the two notices is visible at a time
   * (the underlying detectors are mutually exclusive), so collisions
   * aren't possible.
   */
  isRepairingBakedOrigin: boolean;
  /** Adopt the baked offset as the IfcMapConversion anchor. The
   *  click handler zeros the site placement in the worker immediately,
   *  refreshes metadata, and dispatches the anchor — so the notice
   *  itself naturally disappears on the next render (bakedProjectedOrigin
   *  detector returns null on the refreshed metadata). */
  onAdoptBakedOrigin: () => void;
  /** Zero IfcSite.ObjectPlacement.RelativePlacement.Location without
   *  touching IfcMapConversion. Used by the double-baked notice — the
   *  existing IfcMapConversion is already correct on its own, the IfcSite
   *  placement is the duplicate that needs to go. */
  onClearSitePlacement: () => void;
  /** Fly the map camera to the IfcSite RefLat/RefLon — backs the site
   *  section's "Zoom to IfcSite" button. */
  onZoomToSite: (site: { lat: number; lon: number }) => void;
  canDownloadSidecar: boolean;
  onDownloadSidecar: () => void;
  onApplySidecar: (file: File) => void;
}

export function SourceCard({
  filename,
  metadata,
  siteOutsideBbox,
  activeCrsCode,
  bakedProjectedOrigin,
  doubleBakedOrigin,
  hasActiveCrs,
  isRepairingBakedOrigin,
  onAdoptBakedOrigin,
  onClearSitePlacement,
  onZoomToSite,
  canDownloadSidecar,
  onDownloadSidecar,
  onApplySidecar,
}: SourceCardProps) {
  const level = detectLevelOfGeoref(metadata);
  // Resolve the entity names the source-side UI should display. When the
  // reader found an entity, use its self-reported name. When it didn't,
  // fall back to what the schema would expect — the single place in the
  // UI that maps schema → expected entity name.
  const isEpsetSchema = metadata.schema === "IFC2X3";
  const projectLengthUnit = describeIfcUnit(metadata.lengthUnit);
  // MapConversion E/N/H are on-disk values in MapUnit when present.
  // When MapUnit is absent: IFC4 reader defaults to METRE (projected CRS
  // axes are metres by universal convention — see readMapUnitMetresPerUnit);
  // the IFC2X3 ePset reader resolves per `resolveEpsetLengthUnit` (property
  // Unit attribute, MapUnit pset property, Scale inversion, then project
  // units). Display the unit the reader *actually decoded with*: the
  // explicit name when the file carries one, else the name recovered from
  // the resolved metres-per-unit factor, else the schema fallback.
  const mapUnitName = metadata.rawProjectedCrs?.mapUnit ?? null;
  const resolvedUnitName = metadata.rawProjectedCrs
    ? lengthUnitNameForMetres(metadata.rawProjectedCrs.metresPerUnit)
    : null;
  const mapUnitFallbackName = isEpsetSchema ? metadata.lengthUnit : "METRE";
  const mapUnitShort = describeIfcUnit(
    mapUnitName ?? resolvedUnitName ?? mapUnitFallbackName,
  ).short;
  // Badge text for the MapUnit row when the reader couldn't pin down a
  // unit from an explicit declaration. Picked from (status, schema): IFC4
  // defaults to METRE on absent; the malformed-shift pattern (Revit +
  // ifcopenshell round-trip, e.g. via the old Flask app) is either
  // recovered from Scale or falls back to project unit; IFC2X3 ePset
  // infers from Scale or falls back to project unit (the legacy ePset
  // convention).
  const mapUnitFallbackLabel = describeMapUnitFallback({
    status: metadata.rawProjectedCrs?.mapUnitStatus ?? "absent",
    isEpsetSchema,
    projectLengthUnitShort: projectLengthUnit.short,
    resolvedUnitShort: mapUnitShort,
  });

  const mapConversionEntity =
    metadata.rawMapConversion?.entityName ??
    (isEpsetSchema ? "ePSet_MapConversion" : "IfcMapConversion");
  // For the LoGeoRef caption: name the entity that's actually driving the
  // anchor, so a RigidOp-positioned file reads "IfcRigidOperation present,
  // file is georeferenced" rather than the misleading "IfcMapConversion …".
  const activeCoordinateOperationEntity =
    metadata.activeCoordinateOperation === "rigid-operation"
      ? "IfcRigidOperation"
      : mapConversionEntity;

  const projectedCrsEntity =
    metadata.rawProjectedCrs?.entityName ??
    (isEpsetSchema ? "ePSet_ProjectedCRS" : "IfcProjectedCRS");

  return (
    <Card title="Source" headerAside={<LevelBadge level={level} />}>
      <dl className="space-y-1 text-sm">
        <Row label="Name" value={filename} />

        <Row label="Schema" value={metadata.schema} />

        <Row
          label="Length unit"
          value={<LengthUnitValue name={metadata.lengthUnit} />}
        />
      </dl>

      {bakedProjectedOrigin && (
        <BakedProjectedOriginNotice
          origin={bakedProjectedOrigin}
          hasActiveCrs={hasActiveCrs}
          isPending={isRepairingBakedOrigin}
          onAdopt={onAdoptBakedOrigin}
        />
      )}

      {doubleBakedOrigin && (
        <DoubleBakedOriginNotice
          origin={doubleBakedOrigin}
          isPending={isRepairingBakedOrigin}
          onClear={onClearSitePlacement}
        />
      )}

      <p className="text-xs text-slate-500">
        {loGeorefDescription(level, activeCoordinateOperationEntity)}
      </p>

      {isEpsetSchema && (
        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          IFC2x3 has no native <code>IfcMapConversion</code> or{" "}
          <code>IfcProjectedCRS</code> entity. Georeferencing is encoded as
          property sets on <code>IfcProject</code> or <code>IfcSite</code> (
          <code>ePSet_MapConversion</code>, <code>ePSet_ProjectedCRS</code>) —
          readable by tools that look for these psets, but not part of the IFC
          spec. This app writes these to <code>IfcProject</code>.
        </p>
      )}

      <div className="space-y-2">
        <SiteSection
          raw={metadata.rawSite}
          placementLocation={metadata.localOrigin}
          outsideBbox={siteOutsideBbox}
          activeCrsCode={activeCrsCode}
          projectLengthUnitShort={projectLengthUnit.short}
          projectMetresPerUnit={metadata.metresPerUnit}
          onZoomToSite={onZoomToSite}
        />

        <GeometricContextSection
          raw={metadata.rawGeometricRepresentationContext}
        />

        <ProjectedCrsSection
          raw={metadata.rawProjectedCrs}
          absentEntityName={projectedCrsEntity}
          absentMapUnitLabel={mapUnitFallbackLabel}
        />

        <MapConversionSection
          raw={metadata.rawMapConversion}
          status={metadata.mapConversionStatus}
          absentEntityName={mapConversionEntity}
          mapUnitShort={mapUnitShort}
        />
        <RigidOperationSection
          raw={metadata.rawRigidOperation}
          role={deriveRigidOperationRole(metadata)}
          mapUnitShort={mapUnitShort}
        />
      </div>

      <SidecarControls
        canDownload={canDownloadSidecar}
        onDownload={onDownloadSidecar}
        onApply={onApplySidecar}
      />
    </Card>
  );
}

const LEVEL_BADGE_COLOUR: Record<LoGeoref, string> = {
  l50: "bg-emerald-100 text-emerald-800",
  l20: "bg-sky-100 text-sky-800",
  le10: "bg-slate-100 text-slate-600",
};

interface LevelBadgeProps {
  level: LoGeoref;
}

function LevelBadge({ level }: LevelBadgeProps) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${LEVEL_BADGE_COLOUR[level]}`}
    >
      {loGeorefLabel(level)}
    </span>
  );
}

function loGeorefLabel(level: LoGeoref) {
  switch (level) {
    case "le10": {
      return "LoGeoRef ≤ 10";
    }
    case "l20": {
      return "LoGeoRef 20–40";
    }
    case "l50": {
      return "LoGeoRef 50";
    }
  }
}

function loGeorefDescription(
  level: LoGeoref,
  conversionEntity: string,
): string {
  switch (level) {
    case "le10": {
      return `No IfcSite reference and no ${conversionEntity}. File has no usable geo information.`;
    }
    case "l20": {
      return `IfcSite RefLatitude/RefLongitude present, but no ${conversionEntity}.`;
    }
    case "l50": {
      return `${conversionEntity} present, file is georeferenced.`;
    }
  }
}

function detectLevelOfGeoref(metadata: IfcMetadata): LoGeoref {
  if (metadata.existingGeoref) {
    return "l50";
  }
  if (metadata.siteReference) {
    return "l20";
  }
  return "le10";
}

/**
 * Map the worker's `activeCoordinateOperation` discriminator into the
 * heading-badge role for `RigidOperationSection`. When a RigidOp entity
 * is in the file, this is exactly its role; "inactive" is the
 * present-but-not-positionable case (geographic TargetCRS).
 */
function deriveRigidOperationRole(
  metadata: IfcMetadata,
): "active" | "overridden" | "inactive" {
  if (metadata.activeCoordinateOperation === "rigid-operation") {
    return "active";
  }
  if (metadata.activeCoordinateOperation === "map-conversion") {
    return "overridden";
  }
  return "inactive";
}

function LengthUnitValue({ name }: { name: string }) {
  if (unitToMetres(name).isOk()) {
    return <>{name}</>;
  }
  return (
    <span
      className="text-rose-700"
      title={`Unrecognised IFC length unit '${name}' — treated as metres at the worker boundary; numeric values may be off by the unit factor.`}
    >
      <span aria-hidden="true" className="mr-1">
        ⚠
      </span>
      {name}
    </span>
  );
}

interface DoubleBakedOriginNoticeProps {
  origin: XYZ;
  isPending: boolean;
  onClear: () => void;
}

/** Renders when IfcSite.ObjectPlacement carries a projected offset *and*
 *  IfcMapConversion carries the same offset — the two compound and place
 *  geometry outside the active CRS. The fix is non-destructive: just
 *  zero the IfcSite placement, leave the existing IfcMapConversion as
 *  the sole carrier. No CRS needed for this action (the IfcMapConversion
 *  is already authored), hence no `hasActiveCrs` gate. */
function DoubleBakedOriginNotice({
  origin,
  isPending,
  onClear,
}: DoubleBakedOriginNoticeProps) {
  return (
    <div className="space-y-2 border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p>
        <code>IfcSite.ObjectPlacement</code> carries{" "}
        <code>
          ({origin.x.toFixed(2)}, {origin.y.toFixed(2)}, {origin.z.toFixed(2)})
          m
        </code>{" "}
        that duplicates the offset already in <code>IfcMapConversion</code>.
        Applying the Helmert to the baked placement places geometry outside the
        active CRS (double-translation). The offset belongs in{" "}
        <code>IfcMapConversion</code> only.
      </p>
      <Button
        variant="secondary"
        size="sm"
        isPending={isPending}
        onPress={onClear}
      >
        {isPending ? "Clearing…" : "Remove duplicate offset from IfcSite"}
      </Button>
    </div>
  );
}

interface BakedProjectedOriginNoticeProps {
  origin: XYZ;
  hasActiveCrs: boolean;
  isPending: boolean;
  onAdopt: () => void;
}

function BakedProjectedOriginNotice({
  origin,
  hasActiveCrs,
  isPending,
  onAdopt,
}: BakedProjectedOriginNoticeProps) {
  return (
    <div className="space-y-2 border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p>
        <code>IfcSite.ObjectPlacement</code> carries{" "}
        <code>
          ({origin.x.toFixed(2)}, {origin.y.toFixed(2)}, {origin.z.toFixed(2)})
          m
        </code>{" "}
        that looks like projected coordinates baked into the placement. Per the{" "}
        <a
          href="https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/ifcrepresentationresource/lexical/ifcmapconversion.htm"
          className="underline transition-colors duration-100 hover:text-amber-950 focus-visible:text-amber-950 focus-visible:outline-1 focus-visible:outline-amber-700"
          target="_blank"
          rel="noreferrer"
        >
          IFC4 spec
        </a>{" "}
        this offset belongs in <code>IfcMapConversion</code> — the entity that
        transforms the local engineering coordinate system into the map
        coordinate reference system.
      </p>
      <div className="space-y-1">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!hasActiveCrs}
          isPending={isPending}
          onPress={onAdopt}
        >
          {isPending ? "Moving offset…" : "Move offset to IfcMapConversion"}
        </Button>
        {!hasActiveCrs && (
          <p className="text-amber-800">
            Pick a target CRS first — the offset is interpreted in CRS units on
            write.
          </p>
        )}
        <p className="text-amber-800">
          Rotation in the placement (if any) stays where it is. Verify
          orientation in the rotation card after.
        </p>
      </div>
    </div>
  );
}

function describeMapUnitFallback({
  status,
  isEpsetSchema,
  projectLengthUnitShort,
  resolvedUnitShort,
}: {
  status: RawProjectedCrs["mapUnitStatus"];
  isEpsetSchema: boolean;
  projectLengthUnitShort: string;
  resolvedUnitShort: string;
}) {
  // Status comes from the reader's classification of the MapUnit entity.
  // The schema axis matters for `absent` (IFC4 defaults to METRE, IFC2X3
  // ePset falls back to project units — the legacy ePset convention) and
  // for `recovered-from-scale` (IFC4's is a malformed-IfcSIUnit repair;
  // the ePset one is the normal path for IfcGref-style files, which have
  // no way to declare a unit).
  switch (status) {
    case "explicit": {
      // Only reached when raw.mapUnit happens to be null while status is
      // 'explicit' — shouldn't happen, defensive fallback.
      return "—";
    }
    case "absent": {
      return isEpsetSchema
        ? `absent — using project unit (${projectLengthUnitShort})`
        : "absent — assumed METRE";
    }
    case "recovered-from-scale": {
      return isEpsetSchema
        ? `no unit declared — inferred ${resolvedUnitShort} from Scale`
        : "malformed — recovered METRE from Scale";
    }
    case "malformed-fallback": {
      return `malformed — fell back to project unit (${projectLengthUnitShort})`;
    }
  }
}
