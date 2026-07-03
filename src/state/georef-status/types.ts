import type { LngLat } from "#modules/crs";
import type { OverrideError } from "#modules/crs/types";
import type { HelmertParams, XYZ } from "#modules/helmert/solve";
import type { Provenance } from "#state/workspace";

export interface MapReferences {
  /** WGS84 image of local (0,0,0) under the current Helmert. */
  mapConversion: LngLat | null;
  /** IfcSite RefLat/RefLon, when present and within the active CRS bbox. */
  siteReference: LngLat | null;
  /** True when IfcSite ref exists, an active CRS exists, and the value
   * falls outside the CRS area of use. */
  siteOutsideBbox: boolean;
}

/**
 * Everything the 2D map overlays + camera framing care about, in WGS84.
 * Derived in Workspace and threaded through MapView as a single prop so
 * the framing imperative API can take a snapshot synchronously when an
 * event handler computes "the next" signals from new params.
 */
export interface MapOverlaySignals {
  /** Footprint convex hull as a closed ring of WGS84 lng/lat. */
  footprint: Array<[number, number]> | null;
  /** Per-IfcSpace convex-hull polygons, each projected to WGS84. */
  spaces: ReadonlyArray<SpaceOverlay> | null;
  /**
   * Live anchor — WGS84 image of local (0,0,0) under the current Helmert.
   * from IfcMapConversion; or with IFC 4.3 support from IfcRigidOperation.
   */
  mapConversion: LngLat | null;
  /**
   * Entity name to render next to the coordinate-operation marker glyph.
   * Tracks the active driver: "IfcMapConversion" / "IfcRigidOperation"
   * (or "ePSet_MapConversion" on IFC2x3). Empty/unused when
   * `mapConversion` is null.
   */
  coordinateOperationLabel: string;
  /** IfcSite RefLat/RefLon (already filtered for outside-bbox cases). */
  siteReference: LngLat | null;
}

export interface SpaceOverlay {
  expressID: number;
  name: string | null;
  longName: string | null;
  /** Closed ring of [lng, lat]. */
  polygon: Array<[number, number]>;
}

/**
 * One thing the tool noticed about the current (file × CRS × anchor)
 * state.
 *
 * Findings split by *cause*:
 *   - File-scoped (`unknown-length-unit`, `baked-projected-origin`) are
 *     pure file-load consequences. They never re-fire and are emitted at
 *     the file-load boundary (`worker/metadata.ts` for unit;
 *     `app.tsx::handleFile` for baked-origin), not from a render-time
 *     effect.
 *   - CRS-scoped (`site-outside-crs`, `helmert-outside-crs`,
 *     `double-baked-origin`, `grid-degraded`) can transition when the
 *     user picks a different CRS. They flow through `GeorefView.findings`
 *     and are deduplicated by `${kind}:${crsCode}` so the log doesn't
 *     repeat per slider edit or CRS round-trip.
 */
export type Finding =
  | { kind: "unknown-length-unit"; unit: string }
  | { kind: "baked-projected-origin"; origin: XYZ }
  | {
      /** IfcSite.ObjectPlacement carries projected coordinates *and* an
       * IfcMapConversion is present that compounds with them — applying
       * the Helmert to the baked local origin lands geometry outside the
       * active CRS's area of use. More specific than `helmert-outside-crs`
       * (which only knows "the transform doesn't work") because it names
       * the root cause: two carriers of the offset, double-translation. */
      kind: "double-baked-origin";
      origin: XYZ;
      crsCode: number;
      areaOfUse: string | null;
    }
  | {
      kind: "site-outside-crs";
      site: LngLat;
      crsCode: number;
      areaOfUse: string | null;
      /** When false, the IfcSite seed was the only fallback the app could
       * try — message guidance shifts toward "pick a different CRS / use
       * survey points" rather than just "not shown on map". */
      hasExistingGeoref: boolean;
    }
  | {
      kind: "helmert-outside-crs";
      source: "existing-georef" | "anchor-params";
      crsCode: number;
      areaOfUse: string | null;
    }
  | { kind: "grid-degraded"; crsCode: number; reason: OverrideError };

/**
 * Stable identifier for a finding, used to dedupe log emissions.
 * File-scoped kinds use `kind` alone (they can't repeat). CRS-scoped
 * kinds include `crsCode` so picking a *different* failing CRS re-emits,
 * but toggling away and back doesn't.
 */
export function findingKey(finding: Finding): string {
  switch (finding.kind) {
    case "unknown-length-unit":
    case "baked-projected-origin": {
      return finding.kind;
    }
    case "site-outside-crs":
    case "helmert-outside-crs":
    case "double-baked-origin":
    case "grid-degraded": {
      return `${finding.kind}:${finding.crsCode}`;
    }
  }
}

/**
 * The wide view of "what's the world right now": Helmert (split into
 * editable vs effective — see below), provenance for the badge, WGS84
 * anchors for the map, the baked-origin value (used for both
 * pickBlockedReason and to suppress helmert-outside-crs), and the list
 * of currently-true CRS-scoped findings. Pure derivation — wrap in
 * `useMemo` at the call site.
 *
 * Two parameter tracks intentionally:
 *
 * - `editableParameters` — what the user is currently editing (or seeded
 *   from IfcSite / file). Survives projection failure, so the editing
 *   surface (AnchorCard / RotationCard) keeps showing the typed value
 *   and its inline validator gets to run. Null only when there's nothing
 *   to edit yet (no file, no CRS, no seed).
 *
 * - `effectiveParameters` — same value, gated by a project-through-proj4
 *   check (`helmertProjectsInsideCrs`). Drives everything that would
 *   crash or render NaN on bad input: map overlays, 3D layer, camera
 *   framing, IFC write, sidecar export, anchor pick. Null whenever the
 *   current Helmert would land outside the active CRS's domain.
 *
 * The two diverge exactly when the user has typed an out-of-area value;
 * downstream consumers see the gated null while the editing UI keeps
 * showing what the user typed (and surfaces an inline validation
 * error). Editing cards consume `editableParameters`; everything else
 * consumes `effectiveParameters`.
 */
export interface GeorefView {
  editableParameters: HelmertParams | null;
  effectiveParameters: HelmertParams | null;
  provenance: Provenance;
  references: MapReferences;
  bakedProjectedOrigin: XYZ | null;
  /** Set when `existingGeoref` is present *and* `IfcSite.ObjectPlacement`
   *  carries a baked offset *and* the combo lands geometry outside the
   *  active CRS. The "remove duplicate offset from IfcSite" notice in
   *  the source card binds to this — distinct from `bakedProjectedOrigin`
   *  (no MC) because the fix is different (just zero the placement; the
   *  existing IfcMapConversion is already the source of truth). */
  doubleBakedOrigin: XYZ | null;
  findings: ReadonlyArray<Finding>;
}
