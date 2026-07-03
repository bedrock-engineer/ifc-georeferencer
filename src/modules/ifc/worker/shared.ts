/* eslint-disable @typescript-eslint/no-explicit-any,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return
*/

/* web-ifc's public API is typed as `any` for entity reads
   (GetLine, CreateIfcType, GetLineType) and variadic `any[]` for writes
   (CreateIfcEntity). Every IFC entity traversal in this file flows from
   those `any` returns, so the unsafe-* family fires on ~every line. Not
   worth hand-writing per-entity interfaces for a WASM interop shim. */

import { type IfcAPI, IFCPROJECT, IFCRELAGGREGATES, IFCSITE } from "web-ifc";
import type { HelmertParams } from "#modules/helmert/solve";
import { mapConversionUnitFactor, unitToMetres } from "#modules/units/convert";

/**
 * Returns the flattened first entity of a given type, or null if there are none.
 * "Flattened" means references like ObjectPlacement, RelativePlacement, Location
 * are recursively expanded into nested objects instead of left as Handle refs.
 */
export function firstOf(ifcAPI: IfcAPI, modelID: number, type: number): any {
  const ids = ifcAPI.GetLineIDsWithType(modelID, type);
  if (ids.size() === 0) {
    return null;
  }
  return ifcAPI.GetLine(modelID, ids.get(0), true);
}

/** Unwrap an IFC value wrapper (IfcLabel, IfcLengthMeasure, IfcReal, etc.). */
export function rawValue(v: any): any {
  if (v == undefined) {
    return null;
  }
  if (typeof v === "object" && "value" in v) {
    return v.value;
  }
  return v;
}

/**
 * Unwrap an IFC string-valued field (IfcLabel / IfcText / IfcIdentifier) to
 * a JS string, mapping null/undefined and empty strings to `null`.
 */
export function stringOrNull(v: any): string | null {
  const raw = rawValue(v);
  if (raw == null) {
    return null;
  }
  const s = String(raw);
  return s.length > 0 ? s : null;
}

/**
 * IfcCompoundPlaneAngleMeasure → decimal degrees. Web-ifc returns the value in
 * one of two shapes depending on schema/path:
 *   - bare array of numbers (IFC2X3 path)
 *   - typed wrapper `{ type, value: [...] }` (IFC4X3 path, seen on Revit's
 *     Snowdon Towers export) — looked like a SELECT-wrapped measure
 * We `rawValue` first so both end up as the inner number array.
 */
export function dmsToDecimal(parts: any): number | null {
  const unwrapped = rawValue(parts);
  if (!Array.isArray(unwrapped) || unwrapped.length < 3) {
    return null;
  }
  const nums = unwrapped.map((p) => Number(rawValue(p)));
  const [d = 0, m = 0, s = 0, micro = 0] = nums;
  const sign = d < 0 || m < 0 || s < 0 || micro < 0 ? -1 : 1;
  const abs =
    Math.abs(d) +
    Math.abs(m) / 60 +
    (Math.abs(s) + Math.abs(micro) / 1e6) / 3600;
  return sign * abs;
}

/**
 * Decimal degrees → IfcCompoundPlaneAngleMeasure `[d, m, s, microseconds]`.
 * Inverse of `dmsToDecimal`. IFC convention: all four components share the
 * same sign (S/W are negative on every part, not just the degrees).
 */
export function decimalToDms(
  decimal: number,
): [number, number, number, number] {
  const sign = decimal < 0 ? -1 : 1;
  const abs = Math.abs(decimal);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const secondsFloat = (minutesFloat - minutes) * 60;
  const seconds = Math.floor(secondsFloat);
  const microseconds = Math.round((secondsFloat - seconds) * 1e6);
  return [sign * degrees, sign * minutes, sign * seconds, sign * microseconds];
}

export function expressIDOf(o: any): number | null {
  if (o == undefined || typeof o !== "object") {
    return null;
  }
  if (typeof o.expressID === "number") {
    return o.expressID;
  }
  // Handle objects expose their target expressID as `.value`.
  if (typeof o.value === "number") {
    return o.value;
  }
  return null;
}

/**
 * An IfcMapConversion with horizontal translation `(E, N) = (0, 0)` is
 * semantically meaningless regardless of the other fields:
 *
 *   - All-zeros + identity is the classic Revit "georef placeholder."
 *   - Zeros + a non-identity scale/rotation/H is a partial placeholder
 *     we've seen in real files (e.g. the project's TrueNorth baked into
 *     the rotation, OrthogonalHeight set, but horizontal still zero).
 *
 * In every variant, applying the transform lands all geometry at the
 * projected CRS's false origin in plan view — which for grid-backed CRSs
 * (RD, BD72, …) un-projects to a Bessel/Lambert lat/lon outside the
 * grid's domain and triggers proj4js's "Failed to find a grid shift
 * table" warning, plus an unusable display.
 *
 * Treat any horizontal-zero helmert as a placeholder and rely on the
 * downstream "use IfcSite reference" / "enter survey points manually"
 * paths instead.
 */
export function isTrivialHelmert(h: HelmertParams): boolean {
  return h.easting === 0 && h.northing === 0;
}

// `mapConversionUnitFactor` (the IfcMapConversion.Scale unit-conversion ratio) lives
// in the units module so both the worker and React cards can call it without
// pulling web-ifc into the component bundle. Re-exported here so the worker's
// existing `../shared` importers resolve unchanged.
export { mapConversionUnitFactor } from "#modules/units/convert";

/**
 * Build HelmertParams from the six raw numeric fields read off either an
 * IfcMapConversion entity (IFC4+) or an ePSet_MapConversion property bag
 * (IFC2X3). Callers pass already-unwrapped values; missing fields get the
 * identity defaults (scale=1, abscissa=1, rest=0).
 *
 * Two unit conversions happen at this boundary:
 *
 * 1. **Translation fields** (`Eastings`, `Northings`, `OrthogonalHeight`)
 *    — IFC 4.x stores these in `IfcProjectedCRS.MapUnit`, *not* the IFC
 *    project's length unit. We multiply by `mapUnitMetresPerUnit` to land
 *    in canonical metres. (IFC2X3 ePset has no MapUnit entity; the IFC2X3
 *    reader resolves the unit per `resolveEpsetLengthUnit` — MapUnit pset
 *    property or Scale inversion — and passes the result here.)
 *
 * 2. **`Scale`** — strip the on-disk source-unit/MapUnit ratio via
 *    `mapConversionUnitFactor` (see above) to land in dimensionless canonical.
 */
export function buildHelmertFromFields(
  fields: {
    scale?: unknown;
    xAxisAbscissa?: unknown;
    xAxisOrdinate?: unknown;
    eastings?: unknown;
    northings?: unknown;
    orthogonalHeight?: unknown;
    /**
     * IFC 4.3 IfcMapConversionScaled per-axis factors. Default to 1 when
     * absent (plain IfcMapConversion / ePSet_MapConversion). Per spec,
     * effective per-axis scale is `scale × factor<axis>`.
     */
    factorX?: unknown;
    factorY?: unknown;
    factorZ?: unknown;
  },
  units: {
    mapUnitMetresPerUnit: number;
    ifcMetresPerUnit: number;
  },
): HelmertParams {
  const { mapUnitMetresPerUnit, ifcMetresPerUnit } = units;
  const scale =
    Number(fields.scale ?? 1) /
    mapConversionUnitFactor(ifcMetresPerUnit, mapUnitMetresPerUnit);
  const factorX = Number(fields.factorX ?? 1);
  const factorY = Number(fields.factorY ?? 1);
  const factorZ = Number(fields.factorZ ?? 1);
  return {
    xScale: scale * factorX,
    yScale: scale * factorY,
    zScale: scale * factorZ,
    rotation: Math.atan2(
      Number(fields.xAxisOrdinate ?? 0),
      Number(fields.xAxisAbscissa ?? 1),
    ),
    easting: Number(fields.eastings ?? 0) * mapUnitMetresPerUnit,
    northing: Number(fields.northings ?? 0) * mapUnitMetresPerUnit,
    height: Number(fields.orthogonalHeight ?? 0) * mapUnitMetresPerUnit,
  };
}

/**
 * Resolve metres-per-unit from an IfcSIUnit/IfcConversionBasedUnit's
 * Prefix + Name pair. Returns null when the name isn't in our table —
 * callers decide whether to fall back to a project default (read path)
 * or refuse to preserve an unrecognised MapUnit (write path).
 *
 * Handles both branches:
 *  - **IfcSIUnit** (METRE with optional prefix): combine `Prefix + Name`
 *    and resolve through the SI table.
 *  - **IfcConversionBasedUnit** (FOOT, INCH, US-survey-foot, …): use
 *    `Name` directly through the shared `unitToMetres` table. We don't
 *    read `ConversionFactor` for arbitrary precision; for the units we
 *    care about (international foot, inch, yard, mile) the name-based
 *    factor is exact, and US-survey-foot is rare enough as a MapUnit
 *    that the 2 ppm aliasing to international foot is tolerable.
 */
export function nameToMetresPerUnit(
  prefix: string,
  name: string,
): number | null {
  // IfcSIUnit: the prefix-combined form ("MILLI" + "METRE") is itself a key
  // in LENGTH_UNITS. IfcConversionBasedUnit: prefix is empty, so this first
  // lookup is the bare name and the fallback never fires.
  const combined = unitToMetres(`${prefix}${name}`);
  if (combined.isOk()) {
    return combined.value;
  }
  const bare = unitToMetres(name);
  return bare.isOk() ? bare.value : null;
}

/**
 * Resolve the metres-per-unit factor for `IfcProjectedCRS.MapUnit`. If
 * MapUnit is set (the typical Revit / modern-tool case), parse it.
 *
 * When MapUnit is entirely absent, **default to METRE** (1.0), not the
 * project length unit. The IFC4 spec literally says "fall back to
 * IfcProject.UnitInContext" here, but that's widely ignored: projected
 * CRS axes are metres by universal geodetic convention (UTM, RD, all
 * Lambert variants, …), and file authors invariably write E/N as
 * projected metres regardless of project unit. Flask / pyproj-based
 * tools don't even read MapUnit — they trust the CRS axis is metres.
 * Defaulting to METRE matches what authors mean; the writer emits a
 * fresh `IfcSIUnit METRE` on save so files self-heal into
 * spec-compliance on round-trip. `projectFallback` is retained only as
 * a final fallback for malformed/unrecognised entries.
 *
 * Recovery from a malformed MapUnit (seen on Revit exports that shift
 * IfcSIUnit attributes by one slot, leaving Name=$ and the UnitType
 * enum sitting in the Prefix slot): when `onDiskScale` is provided and
 * the file authored Scale per spec convention as the source-unit/MapUnit
 * ratio, invert it to recover the MapUnit factor:
 *
 *     on_disk_scale = ifc_m_per_unit / map_m_per_unit
 *     map_m_per_unit = ifc_m_per_unit / on_disk_scale
 *
 * No-op when the file's Scale is 1 (no unit ratio) — the derivation
 * collapses to `projectFallback`, matching the previous behaviour.
 */
export function readMapUnitMetresPerUnit(
  projectedCrs: any,
  projectFallback: number,
  onDiskScale?: number,
): number {
  const mapUnit = projectedCrs?.MapUnit;
  if (!mapUnit) {
    return 1;
  }
  const prefix = String(rawValue(mapUnit.Prefix) ?? "");
  const name = String(rawValue(mapUnit.Name) ?? "");
  if (name.length === 0) {
    return deriveMapUnitFromScale(projectFallback, onDiskScale);
  }
  return nameToMetresPerUnit(prefix, name) ?? projectFallback;
}

/**
 * Reverse the spec-conventional on-disk Scale to recover `mapUnit`
 * metres-per-unit. Bounded to [1e-6, 1e6] m/unit to reject garbage
 * factors (real-world units span 0.0254 m for inch up to 1609.34 m for
 * mile). Falls through to `projectFallback` when `onDiskScale` is
 * absent, non-finite, non-positive, or yields an out-of-range factor.
 */
function deriveMapUnitFromScale(
  projectFallback: number,
  onDiskScale: number | undefined,
): number {
  if (
    onDiskScale == undefined ||
    !Number.isFinite(onDiskScale) ||
    onDiskScale <= 0
  ) {
    return projectFallback;
  }
  const derived = projectFallback / onDiskScale;
  if (!Number.isFinite(derived) || derived < 1e-6 || derived > 1e6) {
    return projectFallback;
  }
  return derived;
}

/**
 * True when `IfcProjectedCRS.MapUnit` is present but missing its `Name`
 * (the malformation `readMapUnitMetresPerUnit` recovers from). Lets
 * callers decide whether the recovery fired and whether to surface it.
 */
export function isMapUnitNameMissing(projectedCrs: any): boolean {
  const mapUnit = projectedCrs?.MapUnit;
  if (!mapUnit) {
    return false;
  }
  const name = String(rawValue(mapUnit.Name) ?? "");
  return name.length === 0;
}

/**
 * True when `IfcProjectedCRS.MapUnit` is entirely absent (the attribute
 * is `$`). Distinct from `isMapUnitNameMissing` — that one fires for
 * MapUnit-present-but-malformed. Lets the IFC4 reader log that it
 * defaulted to METRE for an absent MapUnit.
 */
export function isMapUnitAbsent(projectedCrs: any): boolean {
  return !projectedCrs?.MapUnit;
}

/** IfcMapConversion stores rotation as a unit vector (cos θ, sin θ). */
export function rotationToAxisPair(rotation: number): {
  xAxisAbscissa: number;
  xAxisOrdinate: number;
} {
  return {
    xAxisAbscissa: Math.cos(rotation),
    xAxisOrdinate: Math.sin(rotation),
  };
}

/**
 * Express ID of the model's IfcProject, or null if the model has none
 * (invalid per schema, but be defensive). IFC allows exactly one
 * IfcProject per file, so the first hit is the project.
 */
export function findProjectId(ifcAPI: IfcAPI, modelID: number): number | null {
  const ids = ifcAPI.GetLineIDsWithType(modelID, IFCPROJECT);
  return ids.size() === 0 ? null : ids.get(0);
}

/**
 * Express ID of the IfcSite we treat as the model's primary spatial site,
 * or null if the model has no site.
 *
 * Single-site models (the overwhelming majority) return that one site
 * directly — byte-identical to the old "first site" behavior. The
 * disambiguation only engages when a file carries more than one IfcSite,
 * which in practice means one real spatial site plus stray geometry that
 * an exporter mistyped as IfcSite. In that case we prefer the site aggregated
 * directly under the IfcProject — the spec-correct spatial container —
 * because orphan geometry is never wired into the IfcRelAggregates spatial
 * tree. Falls back to the first site if none is aggregated under the
 * project, so we're never worse than the old behavior.
 */
export function findPrimarySiteId(
  ifcAPI: IfcAPI,
  modelID: number,
): number | null {
  const ids = ifcAPI.GetLineIDsWithType(modelID, IFCSITE);
  if (ids.size() === 0) {
    return null;
  }
  if (ids.size() === 1) {
    return ids.get(0);
  }
  const [aggregated] = sitesAggregatedUnderProject(ifcAPI, modelID);
  return aggregated ?? ids.get(0);
}

/**
 * Express IDs of IfcSites that appear as RelatedObjects of an
 * IfcRelAggregates whose RelatingObject is an IfcProject — i.e. the sites
 * that sit directly in the project's spatial decomposition, sorted
 * ascending for a deterministic tiebreak. Best-effort: a malformed or
 * stale relation is skipped rather than thrown, since the caller always
 * has the first-site fallback.
 */
function sitesAggregatedUnderProject(
  ifcAPI: IfcAPI,
  modelID: number,
): Array<number> {
  const siteIds = new Set<number>();
  const rels = ifcAPI.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  for (let index = 0; index < rels.size(); index++) {
    try {
      const rel = ifcAPI.GetLine(modelID, rels.get(index), false);
      const relatingId = expressIDOf(rel.RelatingObject);
      if (relatingId == null) {
        continue;
      }
      if (ifcAPI.GetLineType(modelID, relatingId) !== IFCPROJECT) {
        continue;
      }
      const related: unknown = rel.RelatedObjects;
      if (!Array.isArray(related)) {
        continue;
      }
      for (const child of related) {
        const childId = expressIDOf(child);
        if (
          childId != null &&
          ifcAPI.GetLineType(modelID, childId) === IFCSITE
        ) {
          siteIds.add(childId);
        }
      }
    } catch {
      // Stale/malformed relation — skip; first-site fallback covers us.
    }
  }
  return [...siteIds].toSorted((a, b) => a - b);
}
