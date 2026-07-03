import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import {
  directionRatiosToBearing,
  directionRatiosToDegrees,
} from "#state/workspace";
import type {
  MapConversionStatus,
  RawMapConversion,
  RawSourceCrs,
} from "#modules/ifc/worker";
import { Row } from "./row";

function trimZeros(n: number, maxDecimals: number): string {
  return Number.parseFloat(n.toFixed(maxDecimals)).toString();
}

/**
 * Compact label for the SourceCRS row. The row's `SourceCRS` label already
 * tells the user this is a context reference, so the value just needs to
 * identify which context: `Model`, `Plan`, etc. We collapse the common case
 * where ContextIdentifier == ContextType (the boring "Model · Model"). The
 * rare IfcGeometricRepresentationSubContext case is flagged inline since
 * it's technically spec-noncompliant (MapConversion should attach to the
 * parent context, not a body/plan subcontext).
 */
function formatSourceCrs(s: RawSourceCrs): string {
  const id = s.contextIdentifier;
  const type = s.contextType;
  const isSubContext = s.entityName === "IfcGeometricRepresentationSubContext";
  let base: string;
  if (id == null && type == null) {
    base = "—";
  } else if (id != null && type != null && id !== type) {
    base = `${id} (${type})`;
  } else {
    base = id ?? type ?? "—";
  }
  return isSubContext ? `${base} · SubContext` : base;
}

interface MapConversionSectionProps {
  raw: RawMapConversion | null;
  status: MapConversionStatus;
  /**
   * Entity name to render when `raw` is null (the reader had nothing to
   * label). When `raw` is non-null the heading uses `raw.entityName`
   * directly — the reader is authoritative for present data.
   */
  absentEntityName: string;
  /**
   * Short symbol for the MapUnit governing `raw.eastings/northings/
   * orthogonalHeight`. Computed by the parent: file's
   * `IfcProjectedCRS.MapUnit` when set, project length unit otherwise
   * (the IFC spec fallback). The raw values are verbatim on-disk numbers
   * (no read-side conversion applied), so the suffix just labels them.
   */
  mapUnitShort: string;
}

export function MapConversionSection({
  raw,
  status,
  absentEntityName,
  mapUnitShort,
}: MapConversionSectionProps) {
  if (status === "absent" || raw == null) {
    return (
      <div className="border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
        <Row label={absentEntityName} value="Not present" />
      </div>
    );
  }

  const rotationDeg = directionRatiosToDegrees(
    raw.xAxisAbscissa,
    raw.xAxisOrdinate,
  );
  const bearingDeg = directionRatiosToBearing(
    raw.xAxisAbscissa,
    raw.xAxisOrdinate,
  );

  // FactorX/Y/Z rows are rendered exactly when the source entity is IFC
  // 4.3's IfcMapConversionScaled subtype; null on plain IfcMapConversion
  // or ePSet_MapConversion.
  const isScaled = raw.factorX != null;

  return (
    <Disclosure defaultExpanded>
      <Heading level={3}>
        <Button
          slot="trigger"
          className="group flex w-full items-center gap-2 rounded text-left text-xs font-semibold text-slate-700 outline-none transition-colors duration-150 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          <span className="transition-transform group-aria-expanded:rotate-90">
            ▸
          </span>
          <span className="flex-1">{raw.entityName}</span>
          {status === "placeholder" && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              placeholder — ignored
            </span>
          )}
        </Button>
      </Heading>

      <DisclosurePanel>
        <dl className="mt-2 space-y-1 border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          {/* SourceCRS row: which IfcGeometricRepresentationContext the
              MapConversion attaches to. Hidden on ePSet_MapConversion
              (no SourceCRS attribute). Composite value — keeps the
              context identifier/type visible without padding three
              extra rows for a usually-uninteresting "Model · Model" pair. */}
          {raw.sourceCrs != null && (
            <Row label="SourceCRS" value={formatSourceCrs(raw.sourceCrs)} />
          )}
          {/* E/N/H: cap at 3 decimals (mm precision); scale and the trig
              pair keep 6 because a rotation of 0.5° already lives in the
              5th decimal of cos/sin. trimZeros drops trailing zeros so 0
              renders as "0", not "0.000000". */}
          <Row
            label="Eastings"
            value={`${trimZeros(raw.eastings, 3)} ${mapUnitShort}`}
          />
          <Row
            label="Northings"
            value={`${trimZeros(raw.northings, 3)} ${mapUnitShort}`}
          />
          <Row
            label="OrthogonalHeight"
            value={`${trimZeros(raw.orthogonalHeight, 3)} ${mapUnitShort}`}
          />
          <Row label="Scale" value={trimZeros(raw.scale, 6)} />
          <Row label="XAxisAbscissa" value={trimZeros(raw.xAxisAbscissa, 6)} />
          <Row label="XAxisOrdinate" value={trimZeros(raw.xAxisOrdinate, 6)} />
          <Row label="↳ Rotation" value={`${trimZeros(rotationDeg, 4)}°`} />
          <Row label="↳ Bearing" value={`${trimZeros(bearingDeg, 4)}°`} />
          {isScaled &&
            raw.factorX != null &&
            raw.factorY != null &&
            raw.factorZ != null && (
              <>
                <Row label="FactorX" value={trimZeros(raw.factorX, 6)} />
                <Row label="FactorY" value={trimZeros(raw.factorY, 6)} />
                <Row label="FactorZ" value={trimZeros(raw.factorZ, 6)} />
                <Row
                  label="↳ Effective xScale"
                  value={trimZeros(raw.scale * raw.factorX, 6)}
                />
                <Row
                  label="↳ Effective yScale"
                  value={trimZeros(raw.scale * raw.factorY, 6)}
                />
                <Row
                  label="↳ Effective zScale"
                  value={trimZeros(raw.scale * raw.factorZ, 6)}
                />
              </>
            )}
        </dl>
      </DisclosurePanel>
    </Disclosure>
  );
}
