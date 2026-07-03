import type { HelmertParams } from "#modules/helmert/solve";
import { emitLog } from "#lib/log";
import { isTrivialHelmert } from "../shared";

export interface ExistingGeoref {
  targetCrsName: string;
  helmert: HelmertParams;
}

/**
 * Verbatim-from-file IfcProjectedCRS attributes (IFC4) or ePSet_ProjectedCRS
 * properties (IFC2X3). All seven fields are surfaced even when null so the
 * source-side UI can render "Not present" rows uniformly.
 */
export interface RawProjectedCrs {
  /**
   * Name of the actual entity these fields came from — `"IfcProjectedCRS"`
   * on IFC4+ and `"ePSet_ProjectedCRS"` on IFC2x3. Single source of truth
   * for the source-side UI's heading; the UI does not re-derive from
   * schema.
   */
  entityName: string;
  name: string | null;
  description: string | null;
  geodeticDatum: string | null;
  verticalDatum: string | null;
  mapProjection: string | null;
  mapZone: string | null;
  /**
   * Combined IfcSIUnit `Prefix + Name` (e.g. "METRE", "MILLIMETRE") or the
   * raw string from ePSet_ProjectedCRS. Null when MapUnit is unset OR
   * present-but-malformed (`Name=$`) — the badge in the source-card
   * disambiguates via `mapUnitStatus`.
   */
  mapUnit: string | null;
  /**
   * Provenance for the metres-per-unit factor the reader resolved. Drives
   * the source-card MapUnit-row badge so users see how the absent /
   * malformed cases were handled.
   *
   * IFC4:
   *  - `explicit`              — mapUnit string is the source of truth
   *  - `absent`                — MapUnit attribute is `$`, defaulted to METRE
   *  - `recovered-from-scale`  — malformed Name=$, recovered via Scale inversion
   *  - `malformed-fallback`    — malformed Name=$, recovery failed → project unit
   *
   * IFC2X3 ePset (see `resolveEpsetLengthUnit`):
   *  - `explicit`              — MapUnit pset property named the unit
   *  - `recovered-from-scale`  — unit snapped from inverting on-disk Scale
   *  - `absent`                — no declaration, fell back to project units
   *                              (the legacy ePset convention)
   */
  mapUnitStatus:
    "explicit" | "absent" | "recovered-from-scale" | "malformed-fallback";
  /**
   * MapUnit resolved to metres-per-unit — the *exact* factor the reader
   * used to convert this entity's Eastings/Northings/OrthogonalHeight into
   * canonical metres (so it already reflects the absent→METRE,
   * recovered-from-scale, and IFC2X3-ePset→project-unit decisions). The UI
   * pairs it with the project length factor to show the literal
   * `IfcMapConversion.Scale` that a save will write, since the editable
   * scale field holds the dimensionless geometric value (metres in /
   * metres out) and the on-disk Scale is that × this unit ratio.
   */
  metresPerUnit: number;
}

/**
 * Verbatim-from-file IfcRigidOperation fields. IFC 4.3-only entity that's a
 * sibling of IfcMapConversion under IfcCoordinateOperation — translation
 * only, no rotation, no scale. Surfaced read-only for the source card; the
 * active georef workflow keeps using IfcMapConversion.
 *
 * Coordinates are on-disk values (the IfcLengthMeasure literal), not
 * boundary-converted to metres — same convention as RawMapConversion. The
 * MapUnit on the linked IfcProjectedCRS tells the user what they're in.
 */
export interface RawRigidOperation {
  firstCoordinate: number;
  secondCoordinate: number;
  /** Optional per IFC 4.3 spec — unset means a 2D rigid operation. */
  height: number | null;
  /** Name of the linked TargetCRS (IfcProjectedCRS / IfcGeographicCRS), if any. */
  targetCrsName: string | null;
}

/**
 * Verbatim-from-file IfcMapConversion values *before* the read-side unit
 * conversions in `buildHelmertFromFields`. Surfaced for the source-side UI
 * so a BIM professional can see exactly what's on disk without re-opening
 * the IFC in a text editor (matches what the Flask app's result page
 * exposes via `IfcMapConversion.__dict__`).
 */
export interface RawMapConversion {
  /**
   * Name of the actual entity these fields came from —
   * `"IfcMapConversion"` (IFC4+ plain), `"IfcMapConversionScaled"` (IFC4.3
   * subtype with FactorX/Y/Z), or `"ePSet_MapConversion"` (IFC2x3 convention).
   *  Single source of truth for the source-side UI's heading.
   */
  entityName: string;
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  scale: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  /**
   * Set only when the source entity is IFC 4.3's `IfcMapConversionScaled`
   * subtype. Per spec, effective per-axis on-disk scaling is
   * `scale × factor<axis>`. Null on plain `IfcMapConversion` /
   * `ePSet_MapConversion`.
   */
  factorX: number | null;
  factorY: number | null;
  factorZ: number | null;
  /**
   * Verbatim attributes of the IfcGeometricRepresentationContext that
   * `IfcMapConversion.SourceCRS` points to. Useful when a file carries
   * multiple contexts (Model/Plan/Body) — the MapConversion is attached
   * to a specific one, and the link is otherwise invisible. Null on IFC2X3
   * (ePSet_MapConversion has no SourceCRS attribute).
   */
  sourceCrs: RawSourceCrs | null;
}

/**
 * Verbatim IfcGeometricRepresentationContext fields surfaced for the
 * MapConversion source-side display. `entityName` distinguishes a top-level
 * `IfcGeometricRepresentationContext` from an `IfcGeometricRepresentation
 * SubContext` — the latter is technically a spec violation as SourceCRS
 * (MapConversion should attach to the parent context, not a Body/Plan
 * subcontext), but files in the wild do it.
 */
export interface RawSourceCrs {
  entityName: string;
  contextIdentifier: string | null;
  contextType: string | null;
}

/**
 * Whether the file carries a usable IfcMapConversion. "absent" means the
 * file has no MapConversion entity at all; "placeholder" means it has one
 * but `isTrivialHelmert` flagged it (Revit-style E=N=0); "real" means the
 * transform is meaningful and feeds `existingGeoref`.
 */
export type MapConversionStatus = "real" | "placeholder" | "absent";

export type ActiveCoordinateOperation =
  "map-conversion" | "rigid-operation" | "none";

export interface GeorefRead {
  existingGeoref: ExistingGeoref | null;
  /**
   * EPSG name harvested from IfcProjectedCRS even when the accompanying
   * IfcMapConversion is a Revit-style placeholder (E=N=H=0, Scale=1,
   * rotation≈0). Such a transform is geometrically meaningless — applying
   * it lands coordinates near the CRS's false origin — so we strip it
   * from `existingGeoref` and surface the intended CRS here. The UI
   * pre-fills the EPSG input from the hint but keeps Helmert params null
   * so the user still has to solve from IfcSite ref or survey points.
   */
  targetCrsHint: string | null;
  /**
   * Vertical datum identifier from IfcProjectedCRS.VerticalDatum (IFC4) or
   * the `VerticalDatum` property on `ePSet_ProjectedCRS` (IFC2X3). The
   * IFC 4.3 spec recommends EPSG-namespaced values (e.g. `EPSG:5181` for
   * DHHN92, `EPSG:5709` for NAP), but it's an IfcIdentifier so older files
   * may carry plain short labels like `NAP` or be unset entirely (the
   * common case — the original Flask-based ifcgref never populated this
   * field, and most BIM exporters skip it). The string is round-tripped
   * verbatim; the UI lets users either pick a manifest entry (writes EPSG
   * form) or type a custom label.
   */
  verticalDatumHint: string | null;
  /** Verbatim-from-file IfcProjectedCRS / ePSet_ProjectedCRS attributes. */
  rawProjectedCrs: RawProjectedCrs | null;
  /** Verbatim-from-file IfcMapConversion / ePSet_MapConversion fields. */
  rawMapConversion: RawMapConversion | null;
  mapConversionStatus: MapConversionStatus;
  /**
   * Verbatim-from-file IfcRigidOperation fields. Always null on IFC2X3
   * (entity didn't exist) and on IFC4 / IFC4X1 / IFC4X2 (entity is 4.3+
   * only). Multiple IfcRigidOperation entities are rare in practice; we
   * surface the first one read.
   */
  rawRigidOperation: RawRigidOperation | null;
  /**
   * Which entity drove `existingGeoref`. Source-card uses it to show the
   * active-transform heading; save-card uses it to seed the "Will write"
   * indicator. See `ActiveCoordinateOperation` for the precedence rules.
   */
  activeCoordinateOperation: ActiveCoordinateOperation;
}

/**
 * The WGS84 anchor synced onto IfcSite when writing a new MapConversion.
 * Computed on the main thread by reverse-projecting (Eastings, Northings)
 * through the target CRS, so the worker doesn't need proj4.
 *
 * Elevation deliberately absent: `IfcSite.RefElevation`'s vertical datum is
 * unspecified by the spec (file-author intent), and proj4js can't transform
 * between vertical datums (no geoid grids). Copying `OrthogonalHeight`
 * verbatim onto `RefElevation` is "right iff both fields share a datum",
 * which we can't verify. We leave the file's original `RefElevation`
 * untouched on save.
 */
export interface SiteReferenceSync {
  latitude: number;
  longitude: number;
}

/**
 * Vertical-datum hint surfaced to the UI. Null when the file's
 * IfcProjectedCRS / ePSet_ProjectedCRS doesn't carry one (the common case
 * — most BIM exporters skip the field) or the field is empty. Shared by
 * the IFC4 MC reader, the IFC4 RigidOp fallback reader, the IFC2X3 ePset
 * reader, and the absent-georef terminator, so the empty-string vs null
 * rule lives in one place.
 */
export function deriveVerticalDatumHint(
  rawProjectedCrs: RawProjectedCrs | null,
): string | null {
  const verticalDatum = rawProjectedCrs?.verticalDatum;
  return verticalDatum && verticalDatum.length > 0 ? verticalDatum : null;
}

/**
 * Shared terminator for both read paths: if the Helmert is Revit's
 * placeholder (zeros + identity), emit a log and keep only the CRS hint;
 * otherwise return it as a real existingGeoref. VerticalDatum is always
 * surfaced as a hint regardless — it lives on IfcProjectedCRS, not on
 * IfcMapConversion, so a placeholder transform doesn't invalidate it.
 */
export function classifyGeorefRead(input: {
  helmert: HelmertParams;
  rawProjectedCrs: RawProjectedCrs | null;
  rawMapConversion: RawMapConversion;
}): GeorefRead {
  const { helmert, rawProjectedCrs, rawMapConversion } = input;
  const targetCrsName = rawProjectedCrs?.name ?? "";
  const hint = targetCrsName || null;
  const verticalHint = deriveVerticalDatumHint(rawProjectedCrs);
  if (isTrivialHelmert(helmert)) {
    emitLog({
      source: "worker",
      message: `${rawMapConversion.entityName} is a placeholder (zeros/identity) — ignoring transform, keeping ${targetCrsName} as CRS hint`,
    });
    return {
      existingGeoref: null,
      targetCrsHint: hint,
      verticalDatumHint: verticalHint,
      rawProjectedCrs,
      rawMapConversion,
      mapConversionStatus: "placeholder",
      rawRigidOperation: null,
      activeCoordinateOperation: "none",
    };
  }
  return {
    existingGeoref: { targetCrsName, helmert },
    targetCrsHint: hint,
    verticalDatumHint: verticalHint,
    rawProjectedCrs,
    rawMapConversion,
    mapConversionStatus: "real",
    rawRigidOperation: null,
    activeCoordinateOperation: "map-conversion",
  };
}

/** Empty result for files with no IfcMapConversion / ePSet_MapConversion. */
export function absentGeorefRead(
  rawProjectedCrs: RawProjectedCrs | null,
): GeorefRead {
  return {
    existingGeoref: null,
    targetCrsHint: rawProjectedCrs?.name ?? null,
    verticalDatumHint: deriveVerticalDatumHint(rawProjectedCrs),
    rawProjectedCrs,
    rawMapConversion: null,
    mapConversionStatus: "absent",
    rawRigidOperation: null,
    activeCoordinateOperation: "none",
  };
}
