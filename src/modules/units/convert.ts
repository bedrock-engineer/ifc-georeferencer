import { ok, err, type Result } from "neverthrow";

export interface UnitError {
  kind: "unknown-unit";
  name: string;
}

/**
 * Display descriptor for a length unit, derived from {@link LENGTH_UNITS}.
 */
export interface UnitDescriptor {
  /** Long form for header strips, e.g. "millimetre". */
  label: string;
  /** Short symbol for tabular values, e.g. "mm". */
  short: string;
  /** `Intl.NumberFormat` "simple unit" identifier (US spelling), or null if
   *  Intl can't render this unit (e.g. decimetre, US survey foot, nautical
   *  mile — passing an unsanctioned id to Intl throws). */
  intl: string | null;
}

export interface LengthUnit extends UnitDescriptor {
  /** IFC name spellings this unit matches (uppercase). Both the SI "-METRE"
   *  and US "-METER" forms, plus any prefix-combined SI form a file might
   *  write (e.g. "MILLIMETRE"). */
  names: ReadonlyArray<string>;
  /** Metres per one unit. The canonical conversion ratio. */
  metres: number;
}

/**
 * The single source of truth for length units: the metres-per-unit factor
 * and the display strings, in one place. Everything else in the units layer
 * (`unitToMetres`, the name↔metres reverse lookup in ./format, the IfcSIUnit
 * prefix resolver `nameToMetresPerUnit` in the worker) derives from this.
 *
 * Factors mirror the unit_mapping table from the original Flask app
 * (app.py:191-220), extended with decimetre and US survey foot.
 */
export const LENGTH_UNITS: ReadonlyArray<LengthUnit> = [
  {
    names: ["METRE", "METER"],
    metres: 1,
    label: "metre",
    short: "m",
    intl: "meter",
  },
  {
    names: ["MILLIMETRE", "MILLIMETER"],
    metres: 0.001,
    label: "millimetre",
    short: "mm",
    intl: "millimeter",
  },
  {
    names: ["CENTIMETRE", "CENTIMETER"],
    metres: 0.01,
    label: "centimetre",
    short: "cm",
    intl: "centimeter",
  },
  {
    names: ["DECIMETRE", "DECIMETER"],
    metres: 0.1,
    label: "decimetre",
    short: "dm",
    // Intl has no sanctioned "decimeter" id; null falls back to plain decimal.
    intl: null,
  },
  {
    names: ["KILOMETRE", "KILOMETER"],
    metres: 1000,
    label: "kilometre",
    short: "km",
    intl: "kilometer",
  },
  {
    names: ["INCH"],
    metres: 0.0254,
    label: "inch",
    short: "in",
    intl: "inch",
  },
  {
    names: ["FOOT"],
    metres: 0.3048,
    label: "foot",
    short: "ft",
    intl: "foot",
  },
  {
    // US-survey-foot differs from international foot by ~2 ppm. Intl has no
    // separate id, so we alias the label/intl to "foot" for display — the
    // conversion stays correct in `metres`, only the rendered symbol is shared.
    names: ["US_SURVEY_FOOT"],
    metres: 1200 / 3937,
    label: "US survey foot",
    short: "ft",
    intl: "foot",
  },
  {
    names: ["YARD"],
    metres: 0.9144,
    label: "yard",
    short: "yd",
    intl: "yard",
  },
  {
    names: ["MILE"],
    metres: 1609.344,
    label: "mile",
    short: "mi",
    intl: "mile",
  },
  {
    names: ["NAUTICAL_MILE"],
    metres: 1852,
    label: "nautical mile",
    short: "NM",
    intl: null,
  },
];

const METRES_BY_NAME: ReadonlyMap<string, number> = new Map(
  LENGTH_UNITS.flatMap((unit) => unit.names.map((name) => [name, unit.metres])),
);

/**
 * Length unit name (as read from IfcUnitAssignment, e.g. "MILLIMETRE",
 * "METER") to its conversion factor in metres. Case-insensitive. Returns
 * `err({ kind: "unknown-unit" })` for names not in {@link LENGTH_UNITS} so
 * callers can decide whether to warn and fall back to metres.
 */
export function unitToMetres(name: string): Result<number, UnitError> {
  const value = METRES_BY_NAME.get(name.toUpperCase());
  if (value === undefined) {
    return err({ kind: "unknown-unit", name });
  }
  return ok(value);
}

/**
 * Snap a derived metres-per-unit factor to the nearest entry in
 * {@link LENGTH_UNITS}, or null when nothing is within tolerance.
 *
 * Used by the IFC2X3 ePset reader to disambiguate the two Eastings/
 * Northings unit conventions found in the wild by inverting the on-disk
 * Scale (`derived = ifcMetresPerUnit / onDiskScale`). The inversion
 * assumes the geometric ground-to-grid scale is ≈ 1, so `derived` lands
 * *near* a real unit factor but rarely exactly on it — e.g. an mm file
 * with a solved Helmert scale of 1.0002 yields 0.0009998, and using that
 * raw would shift Eastings by ~37 m at RD coordinates. Snapping recovers
 * the exact unit (real unit ratios are discrete) and thereby the exact
 * geometric scale.
 *
 * Tolerance is 5% in log-space: wide enough for any plausible geometric
 * scale contamination (ground-to-grid factors deviate from 1 by ~1e-4),
 * narrow enough that no two table entries are conflated — the closest
 * pair with distinct factors (yard at 0.9144 vs metre) is ~9% apart.
 * (Foot vs US survey foot differ by 2 ppm — below what a scale-
 * contaminated quotient can resolve, so whichever is nearer wins; the
 * same aliasing `nameToMetresPerUnit` accepts.)
 */
export function snapToKnownUnitFactor(derived: number): number | null {
  if (!Number.isFinite(derived) || derived <= 0) {
    return null;
  }
  let best: { metres: number; distance: number } | null = null;
  for (const unit of LENGTH_UNITS) {
    const distance = Math.abs(Math.log(derived / unit.metres));
    if (best === null || distance < best.distance) {
      best = { metres: unit.metres, distance };
    }
  }
  if (best === null || best.distance > Math.log(1.05)) {
    return null;
  }
  return best.metres;
}

/**
 * IFC unit name for an exact metres-per-unit factor ("METRE",
 * "MILLIMETRE", "FOOT", …), or null for unrecognised ratios. Used by the
 * IFC2X3 ePset writer to spell the MapUnit property from a CRS's
 * metresPerUnit. Exact match (the factor comes from our own tables or
 * proj4's, both discrete), not a snap.
 */
export function lengthUnitNameForMetres(metresPerUnit: number): string | null {
  const match = LENGTH_UNITS.find(
    (unit) => Math.abs(unit.metres - metresPerUnit) < 1e-12,
  );
  // Index 0 is the canonical SI spelling ("METRE", not "METER").
  return match?.names[0] ?? null;
}

/**
 * The `IfcMapConversion.Scale` unit-conversion ratio: source-unit (IFC
 * project length unit) ↔ MapUnit. Codebase canonical is dimensionless
 * geometric scale (metres in, metres out — see `modules/helmert/solve.ts`),
 * but IFC stores Scale as this dimensionful ratio. Read inverts; write
 * applies:
 *
 *     scale_from_file = internal × mapConversionUnitFactor(ifc, map)
 *     internal = scale_from_file / mapConversionUnitFactor(ifc, map)
 *
 * Worked cases:
 *   - mm IFC + METRE map: ratio = 0.001 (an identity transform writes 0.001)
 *   - metric IFC + METRE map: ratio = 1 (identity writes 1)
 *   - metric IFC + FOOT map: ratio = 1/0.3048 ≈ 3.28
 *   - IFC2X3 ePset: same formula with the target CRS's axis unit standing
 *     in for MapUnit (mm IFC + metre CRS writes 0.001, like IfcGref)
 *
 * Skipping this conversion shrinks the rendered model by 1000× for an mm
 * project + METRE MapUnit — the 3D layer disappears and the footprint
 * collapses to a dot.
 */
export function mapConversionUnitFactor(
  ifcMetresPerUnit: number,
  mapUnitMetresPerUnit: number,
): number {
  return ifcMetresPerUnit / mapUnitMetresPerUnit;
}
