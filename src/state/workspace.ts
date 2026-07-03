/**
 * Pure logic called from the Workspace component. These helpers own all
 * the proj4 / Helmert assembly that the UI layer used to do inline, so
 * workspace.tsx is left with state + JSX wiring.
 */

import {
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
} from "neverthrow";

import {
  lookupCrs,
  parseEpsgCode,
  transformProjectedToWgs84,
  transformWgs84ToProjected,
  type CrsDef,
  type CrsError,
  type TransformError,
} from "#modules/crs";
import {
  solveSinglePointFallback,
  type HelmertParams,
  type PointPair,
  type SolveRequest,
  type SurveySource,
  type XYZ,
} from "#modules/helmert/solve";
import type { ExistingGeoref, IfcMetadata } from "#modules/ifc/worker";
import { selectWriteTarget } from "#modules/ifc/worker/georef/select-target";

/**
 * Where a value in the sidebar came from. Displayed as a badge on each
 * card. "derived" is used for per-field badges (e.g. rotation from
 * TrueNorth) independent of the anchor kind.
 */
export type Provenance =
  | "file"
  | "derived"
  | "map"
  | "manual"
  | "survey"
  | "default";

/**
 * Anchor couples Helmert params with the provenance of where they came
 * from, so the two can never drift apart. The kind strings line up with
 * `Provenance` on purpose — a manual/map/survey/file anchor maps 1:1 to
 * the badge shown in the sidebar.
 *
 * `survey.points` is the point list that produced `params` — kept on the
 * anchor so the residuals chart can render iff the live params still
 * descend from a least-squares fit. `edited` / `picked` / `resetToFile`
 * naturally drop it; `paramsReplaced` (CRS swap) drops it too because
 * the points were captured in the previous CRS's frame.
 *
 * Single-point fallback solves leave `points` undefined — there are no
 * residuals to chart with one constraint.
 */
export type Anchor =
  | { kind: "default" }
  | { kind: "file"; params: HelmertParams }
  | { kind: "manual"; params: HelmertParams }
  | { kind: "map"; params: HelmertParams }
  | { kind: "survey"; params: HelmertParams; points?: Array<PointPair> };

export function anchorParams(anchor: Anchor): HelmertParams | null {
  return anchor.kind === "default" ? null : anchor.params;
}

/** Survey-fit residuals points iff the live anchor still descends from
 *  a multi-point fit (drops on edit/pick/reset/CRS-swap). */
export function anchorSurveyPoints(anchor: Anchor): Array<PointPair> | null {
  return anchor.kind === "survey" && anchor.points ? anchor.points : null;
}

/**
 * Provenance for the anchor badge. When no anchor is set but
 * `effectiveParameters` was seeded from IfcSite lat/lon, we surface that
 * as "file" — the user is looking at a value derived from file contents,
 * not a placeholder.
 */
export function anchorProvenance(
  anchor: Anchor,
  hasEffectiveParameters: boolean,
): Provenance {
  if (anchor.kind === "default") {
    return hasEffectiveParameters ? "file" : "default";
  }
  return anchor.kind;
}

/**
 * Actions are scoped to anchor transitions — where the structural
 * coupling between params and provenance lives. Orthogonal UI flags
 * (busy, pickingAnchor, downloadUrl, epsgCode) stay as plain useState
 * in the component.
 *
 * `paramsReplaced` covers both rotation/scale tweaks and CRS-swap
 * reprojections: both "just update numbers" while preserving where the
 * anchor originally came from.
 */
export type AnchorAction =
  | { type: "edited"; params: HelmertParams }
  | { type: "resetToFile" }
  | { type: "picked"; params: HelmertParams }
  | { type: "solved"; params: HelmertParams; points?: Array<PointPair> }
  | { type: "paramsReplaced"; params: HelmertParams };

export function initialAnchor(metadata: IfcMetadata): Anchor {
  return metadata.existingGeoref
    ? { kind: "file", params: metadata.existingGeoref.helmert }
    : { kind: "default" };
}

/**
 * Reducer factory that closes over `existing` so `resetToFile` can pull
 * the file-provided Helmert without the caller having to thread it
 * through the action payload. Re-invoked each render — `useReducer`
 * picks up the latest closure for the next dispatch, so this stays in
 * sync with the current metadata.
 */
export function makeAnchorReducer(existing: ExistingGeoref | null) {
  return function anchorReducer(state: Anchor, action: AnchorAction): Anchor {
    switch (action.type) {
      case "edited": {
        return { kind: "manual", params: action.params };
      }
      case "resetToFile": {
        if (!existing) {
          return state;
        }
        return { kind: "file", params: existing.helmert };
      }
      case "picked": {
        return { kind: "map", params: action.params };
      }
      case "solved": {
        return action.points
          ? { kind: "survey", params: action.params, points: action.points }
          : { kind: "survey", params: action.params };
      }
      case "paramsReplaced": {
        if (state.kind === "default") {
          return state;
        }
        // CRS swap: the survey points are tied to the previous CRS's
        // frame, so the residuals would be wrong against the reprojected
        // params. Keep the badge, drop the points; user re-solves to
        // restore the chart in the new CRS.
        if (state.kind === "survey") {
          return { kind: "survey", params: action.params };
        }
        return { ...state, params: action.params };
      }
    }
  };
}

/**
 * Seed the target-CRS input from whatever the file told us:
 *   1. A fully solved IfcMapConversion → use its TargetCRS.
 *   2. A Revit-style placeholder that still named a CRS → use the hint.
 *   3. Nothing → empty string, user picks from the combobox.
 */
export function initialEpsgFromMetadata(metadata: IfcMetadata): string {
  if (metadata.existingGeoref) {
    const code = parseEpsgCode(metadata.existingGeoref.targetCrsName);
    if (code != null) {
      return String(code);
    }
  }
  if (metadata.targetCrsHint) {
    const code = parseEpsgCode(metadata.targetCrsHint);
    if (code != null) {
      return String(code);
    }
  }
  return "";
}

/**
 * Convert the IFC TrueNorth direction ratios to a rotation in radians.
 *
 * TrueNorth encodes `(sin θ, cos θ)` (north-vector in the local frame), so
 * recovery is `atan2(abscissa, ordinate)`. This is the mirror of the
 * IfcMapConversion XAxis recovery — see `docs/helmert-parameters.md`.
 *
 * Pass `null` (no TrueNorth in file) to get 0.
 */
export function trueNorthRotation(
  trueNorth: { abscissa: number; ordinate: number } | null,
): number {
  return trueNorth ? Math.atan2(trueNorth.abscissa, trueNorth.ordinate) : 0;
}

/** Convert IFC direction ratios (X-axis components) to a rotation in degrees. */
export function directionRatiosToDegrees(
  abscissa: number,
  ordinate: number,
): number {
  return (Math.atan2(ordinate, abscissa) * 180) / Math.PI;
}

/**
 * Convert IFC direction ratios to a surveyor's bearing — CW from grid north,
 * normalised to [0, 360). IFC stores CCW-from-east in `(abscissa, ordinate)`;
 * surveyors and GIS people think CW-from-north. Same formula works for
 * IfcMapConversion's X-axis (engineering X in map frame) and for TrueNorth's
 * (sin θ, cos θ) encoding (true north in engineering frame) — the bearing
 * just has different meaning depending on what the direction represents.
 */
export function directionRatiosToBearing(
  abscissa: number,
  ordinate: number,
): number {
  return (90 - directionRatiosToDegrees(abscissa, ordinate) + 360) % 360;
}

/**
 * When the user swaps the target CRS, keep the anchor's *geographic*
 * position fixed: round-trip (E,N) through lat/lon so the pin on the map
 * doesn't jump. Rotation and height are preserved — grid convergence
 * between projections is typically <1° and most swaps share a vertical
 * datum.
 */
export type ReprojectError =
  | TransformError
  | { kind: "lookup-failed"; cause: CrsError };

/**
 * Round-trip the anchor's planar position through WGS84 lat/lon so it
 * lands at the same geographic point in the new CRS. Owns the proj4
 * registration step — both source and target codes are looked up before
 * the transform runs, so the caller doesn't need to pre-register.
 */
export function reprojectAnchorOnCrsChange(arguments_: {
  parameters: HelmertParams;
  previousEpsg: number;
  nextEpsg: number;
}): ResultAsync<HelmertParams, ReprojectError> {
  const { parameters, previousEpsg, nextEpsg } = arguments_;
  return ResultAsync.combine([lookupCrs(previousEpsg), lookupCrs(nextEpsg)])
    .mapErr<ReprojectError>((cause) => ({ kind: "lookup-failed", cause }))
    .andThen(([previousDef, nextDef]) => {
      const ll = transformProjectedToWgs84(
        previousDef,
        parameters.easting,
        parameters.northing,
      );
      if (ll.isErr()) {
        return errAsync<HelmertParams, ReprojectError>(ll.error);
      }
      const projected = transformWgs84ToProjected({
        def: nextDef,
        longitude: ll.value.longitude,
        latitude: ll.value.latitude,
        elevation: parameters.height,
      });
      if (projected.isErr()) {
        return errAsync<HelmertParams, ReprojectError>(projected.error);
      }
      return okAsync<HelmertParams, ReprojectError>({
        ...parameters,
        easting: projected.value.x,
        northing: projected.value.y,
      });
    });
}

/**
 * Project the IfcSite RefLatitude/RefLongitude/RefElevation through the
 * active CRS. Single point of truth shared by the solver feed
 * (`buildSurveySource`), the file-load seed (`deriveSeededParameters`),
 * and the locked anchor row in the survey-points card. Returns `null`
 * when the file has no IfcSite reference; `Result` distinguishes the
 * present-but-projection-failed case so callers can branch.
 */
export function projectIfcSite(
  metadata: IfcMetadata,
  activeCrs: CrsDef,
): Result<XYZ, TransformError> | null {
  const site = metadata.siteReference;
  if (!site) {
    return null;
  }
  return transformWgs84ToProjected({
    def: activeCrs,
    longitude: site.longitude,
    latitude: site.latitude,
    elevation: site.elevation,
  });
}

export type SurveySourceError =
  | { kind: "no-site-ref"; message: string }
  | { kind: "projection-failed"; message: string };

/**
 * Assemble the SurveySource for the solver. The IfcSite point pair is
 * materialised here because it requires projecting lat/lon through proj4 —
 * which we keep out of the UI layer.
 */
export function buildSurveySource(arguments_: {
  request: SolveRequest;
  metadata: IfcMetadata;
  activeCrs: CrsDef;
}): Result<SurveySource, SurveySourceError> {
  const { request, metadata, activeCrs } = arguments_;
  if (request.mode === "ignore-existing") {
    return ok({ kind: "ignore-existing", userPoints: request.userPoints });
  }
  const projected = projectIfcSite(metadata, activeCrs);
  if (projected === null || !metadata.localOrigin) {
    return err({
      kind: "no-site-ref",
      message: "No IfcSite reference available for this mode",
    });
  }
  if (projected.isErr()) {
    return err({
      kind: "projection-failed",
      message: `Projection failed: ${String(projected.error.cause)}`,
    });
  }
  const ifcSitePoint: PointPair = {
    local: metadata.localOrigin,
    target: projected.value,
  };
  if (request.mode === "use-existing") {
    return ok({ kind: "use-existing", ifcSitePoint });
  }
  return ok({
    kind: "add-to-existing",
    ifcSitePoint,
    userPoints: request.userPoints,
  });
}

/**
 * Convert a map-picked WGS84 point into a HelmertParams: project through
 * the active CRS and either patch the existing anchor's E/N/H or seed a
 * fresh one (scale=1, rotation=TrueNorth) when the user hasn't solved yet.
 */
export function applyPickedAnchor(arguments_: {
  point: { longitude: number; latitude: number };
  metadata: IfcMetadata;
  activeCrs: CrsDef;
  base: HelmertParams | null;
}): Result<HelmertParams, TransformError> {
  const { point, metadata, activeCrs, base } = arguments_;
  const projected = transformWgs84ToProjected({
    def: activeCrs,
    longitude: point.longitude,
    latitude: point.latitude,
    elevation: 0,
  });
  if (projected.isErr()) {
    return err(projected.error);
  }
  if (base) {
    return ok({
      ...base,
      easting: projected.value.x,
      northing: projected.value.y,
    });
  }
  // Convention: a map click describes the location of the IFC project's
  // spatial root (local (0,0,0)) — same convention as the IfcSite seed.
  // Elevation is 0 because the picker doesn't sample terrain (Mapterhorn's
  // vertical datum varies by region); user enters OrthogonalHeight in the
  // anchor card.
  return ok(
    solveSinglePointFallback(
      { local: { x: 0, y: 0, z: 0 }, target: { ...projected.value, z: 0 } },
      { trueNorthRotation: trueNorthRotation(metadata.trueNorth) },
    ),
  );
}

/**
 * Predict which entity the writer will emit for the current (schema ×
 * original-file-state × params) triple, so the SaveCard can show a live
 * "Will write" indicator that updates as the user edits rotation/scale.
 *
 * Shares `selectWriteTarget` with the worker dispatcher — the two
 * cannot drift on rule changes. Returns null when there are no params
 * to save (no anchor yet); the indicator stays hidden in that case.
 *
 * Side effects are derived here (not in `selectWriteTarget`) because they
 * depend on file state the dispatcher doesn't need — RefLat/RefLon sync
 * fires iff the file has an IfcSite. See `SiteReferenceSync` for why
 * RefElevation is deliberately excluded.
 */
export interface PredictedWriteEntity {
  /** "IfcRigidOperation" / "IfcMapConversion" / "IfcMapConversionScaled" / "ePSet_MapConversion". */
  entityName: string;
  /** Short qualifier shown next to the entity name, or empty when none. */
  note: string;
  /**
   * Side-effect clauses the writer will also perform. Rendered separated
   * by middle dots after the primary entity in the indicator. Empty when
   * there are no side effects to disclose (e.g. files without an IfcSite
   * — the worker's `syncSiteReference` no-ops there).
   */
  sideEffects: ReadonlyArray<string>;
}

export function predictWriteEntity(
  metadata: IfcMetadata,
  parameters: HelmertParams | null,
): PredictedWriteEntity | null {
  if (!parameters) {
    return null;
  }
  const target = selectWriteTarget({
    schema: metadata.schema,
    params: parameters,
    fileHadRigidOperation: metadata.rawRigidOperation !== null,
  });
  const sideEffects = metadata.rawSite ? ["syncs IfcSite RefLat/RefLon"] : [];
  return { entityName: target.entity, note: target.note, sideEffects };
}
