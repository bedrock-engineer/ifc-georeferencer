import { type CrsDef } from "#modules/crs/types";
import { LENGTH_UNITS, unitToMetres, type UnitDescriptor } from "./convert";

export type { UnitDescriptor } from "./convert";

const UNKNOWN: UnitDescriptor = { label: "unknown", short: "u", intl: null };

function lookupByMetres(metresPerUnit: number): UnitDescriptor | null {
  const match = LENGTH_UNITS.find(
    (unit) => Math.abs(unit.metres - metresPerUnit) < 1e-12,
  );
  if (!match) {
    return null;
  }
  return { label: match.label, short: match.short, intl: match.intl };
}

/**
 * Describe an IFC length unit by name (as read from IfcUnitAssignment, e.g.
 * "MILLIMETRE", "METER"). Falls back to the lowercased name when the unit
 * isn't in the conversion table — at least the user sees the file's own
 * spelling rather than a generic "unknown".
 */
export function describeIfcUnit(name: string): UnitDescriptor {
  const metres = unitToMetres(name);
  if (metres.isErr()) {
    return { label: name.toLowerCase(), short: "u", intl: null };
  }
  return lookupByMetres(metres.value) ?? UNKNOWN;
}

/**
 * Describe a projected CRS's native unit via its metresPerUnit factor.
 * proj4 doesn't always populate a `units` string, so we key on the ratio
 * instead. Falls back to "<m> m" for unrecognised ratios so the header
 * strip still names the unit numerically.
 */
export function describeCrsUnit(crs: CrsDef | null): UnitDescriptor {
  if (!crs) {
    return UNKNOWN;
  }
  const match = lookupByMetres(crs.metresPerUnit);
  if (match) {
    return match;
  }
  return { label: `${crs.metresPerUnit} m`, short: "u", intl: null };
}

/**
 * Build `Intl.NumberFormatOptions` for a unit descriptor's `intl` id.
 * When the unit isn't Intl-renderable (US survey foot before the alias,
 * nautical mile, custom unknown unit), the field falls back to plain
 * decimal — column header / label still names the unit. Shared between
 * the anchor and survey-points cards so they format identically.
 */
export function numberFieldFormatForIntl(
  intlUnit: string | null,
): Intl.NumberFormatOptions {
  return intlUnit
    ? {
        style: "unit",
        unit: intlUnit,
        unitDisplay: "short",
        maximumFractionDigits: 3,
      }
    : { maximumFractionDigits: 3 };
}
