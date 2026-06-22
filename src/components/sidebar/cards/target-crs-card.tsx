import { useTransition } from "react";
import { type CrsLookupState } from "#modules/crs";
import {
  isRetryableOverrideError,
  type AccuracyStatus,
  type OverrideError,
} from "#modules/crs/types";
import { retryCrsOverride } from "#modules/crs/manifest";
import { Button } from "../../input/button";
import { Card } from "../card";
import { ProvenanceBadge, type Provenance } from "../provenance-badge";
import { CrsField } from "./target-crs-card/crs-field";
import { VerticalDatumPicker } from "./target-crs-card/vertical-datum-picker";

interface TargetCrsCardProps {
  epsgCode: string;
  crsState: CrsLookupState;
  onChange: (code: string) => void;
  fromFile: boolean;
  verticalDatum: string | null;
  onVerticalDatumChange: (value: string | null) => void;
}

export function TargetCrsCard({
  epsgCode,
  crsState,
  onChange,
  fromFile,
  verticalDatum,
  onVerticalDatumChange,
}: TargetCrsCardProps) {
  const provenance: Provenance = fromFile ? "file" : "default";

  // Vertical datum field is only meaningful when the chosen horizontal CRS
  // is projected-only — for a compound it's already encoded in the Name,
  // for an unresolved/invalid input there's nothing to attach it to. The
  // save-time guard in use-ifc-write.ts mirrors this rule.
  const showVerticalDatum =
    crsState.kind === "ready" && crsState.def.kind === "projected";

  return (
    <Card
      title="Target CRS"
      headerAside={<ProvenanceBadge provenance={provenance} />}
      help={
        <>
          <p>
            The Projected CRS to georeference into. Enter an EPSG code (e.g.{" "}
            <code>28992</code> for RD New, <code>32631</code> for UTM zone 31N).
            The resolved name and area of use appear below the input.
          </p>
          <p>
            If the file already has an IfcProjectedCRS, it's used as the
            default. For horizontal-only CRSs, a vertical datum picker appears
            so you can pair it with NAP, EGM2008, etc.
          </p>
        </>
      }
    >
      <CrsField initialCode={epsgCode} onCommit={onChange} />

      <LookupDisplay state={crsState} />

      {showVerticalDatum && (
        <VerticalDatumPicker
          initialValue={verticalDatum}
          onCommit={onVerticalDatumChange}
        />
      )}
    </Card>
  );
}

interface LookupDisplayProps {
  state: CrsLookupState;
}

/**
 * Renders the resolved CRS name/area (or a loading/error placeholder)
 * directly off the state Workspace already computed.
 */
function LookupDisplay({ state }: LookupDisplayProps) {
  if (state.kind === "invalid-code") {
    return <p className="text-xs text-slate-400">Enter an EPSG code.</p>;
  }

  if (state.kind === "resolving") {
    if (state.phase === "grid") {
      return (
        <p className="text-xs text-amber-700">
          Loading precision grid for EPSG:{state.code}… The model can't be
          placed accurately on the map until this finishes.
        </p>
      );
    }
    return (
      <p className="text-xs text-slate-500">Looking up EPSG:{state.code}…</p>
    );
  }

  if (state.kind === "error") {
    return (
      <p className="text-xs text-red-700">
        EPSG:{state.code} — {state.errorKind.replaceAll("-", " ")}
      </p>
    );
  }

  const { def } = state;

  return (
    <div className="space-y-1 border border-slate-100 bg-slate-50 p-2 text-xs">
      <div className="font-medium text-slate-900">{def.name}</div>

      {def.areaOfUse && <div className="text-slate-600">{def.areaOfUse}</div>}

      <AccuracyBadge def={def} />
    </div>
  );
}

interface AccuracyBadgeProps {
  def: { code: number; accuracy: AccuracyStatus };
}

/**
 * Per-CRS accuracy strip rendered under the name/area in the CRS card.
 * The single source of truth users consult when something else (Save
 * button, anchor picker, search) is disabled — so disabled-elsewhere
 * tooltips can point back here. See docs/crs-datum-grids.md.
 */
function AccuracyBadge({ def }: AccuracyBadgeProps) {
  const { accuracy } = def;
  if (accuracy.kind === "trusted-default") {
    // No badge — clean. The default proj4 string is exact for this CRS.
    return null;
  }
  if (accuracy.kind === "trusted-override") {
    return <div className="text-emerald-700">✓ {accuracy.note}</div>;
  }
  return <DegradedOverrideBadge code={def.code} accuracy={accuracy} />;
}

interface DegradedOverrideBadgeProps {
  code: number;
  accuracy: Extract<AccuracyStatus, { kind: "degraded-override-failed" }>;
}

function DegradedOverrideBadge({ code, accuracy }: DegradedOverrideBadgeProps) {
  const retryable = isRetryableOverrideError(accuracy.reason);
  const [isRetrying, startRetryTransition] = useTransition();
  const label = isRetrying
    ? "Retrying…"
    : (retryable
      ? "Retry grid load"
      : "Cannot retry — file an issue");
  return (
    <div className="space-y-1 border border-red-300 bg-red-50 p-2 text-red-800">
      <div>⚠ {accuracy.note}</div>
      <div className="text-[11px] text-red-700">
        {humanReadableOverrideError(accuracy.reason)}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onPress={() => {
          startRetryTransition(async () => {
            await retryCrsOverride(code);
          });
        }}
        isDisabled={!retryable || isRetrying}
      >
        {label}
      </Button>
    </div>
  );
}

function humanReadableOverrideError(reason: OverrideError): string {
  switch (reason.kind) {
    case "grid-fetch-network": {
      return "Network error fetching the precision grid. Check your connection.";
    }
    case "grid-fetch-not-found": {
      return `Grid file not found on cdn.proj.org (HTTP ${reason.status}). The URL may have moved.`;
    }
    case "grid-import-failed": {
      return "Couldn't load the GeoTIFF parser chunk.";
    }
    case "grid-parse-failed": {
      return "Grid file appears to be corrupted or in an unexpected format.";
    }
  }
}
