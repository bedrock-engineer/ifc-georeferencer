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
 *   - IFC2X3 ePset (no MapUnit, callers pass map = ifc): ratio = 1, Scale
 *     round-trips unchanged
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
