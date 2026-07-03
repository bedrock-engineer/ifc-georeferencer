import { type CrsDef, projectLocalToWgs84 } from "#modules/crs";
import {
  solveSinglePointFallback,
  type HelmertParams,
  type XYZ,
} from "#modules/helmert/solve";
import type { IfcMetadata } from "#modules/ifc/worker";
import {
  anchorParams,
  projectIfcSite,
  trueNorthRotation,
  type Anchor,
} from "#state/workspace";
import { deriveMapReferences } from "./references";
import type { Finding, GeorefView, SeedProposal } from "./types";

/** ~10 km. Sites larger than this on a side are unusual; UTM/RD/state-plane
 *  coords are typically 100k–10M, so a "local origin" of that magnitude is
 *  almost certainly baked-in projected coordinates. */
const BAKED_PROJECTED_THRESHOLD_M = 10_000;

/** Per buildingSMART "User Guide for Geo-referencing in IFC" §3.3,
 *  Important Note 5 — projected coords don't belong in
 *  IfcSite.ObjectPlacement. We can't usefully georeference such files.
 *
 *  Used both at file-load (to emit a one-shot warning) and inside the
 *  view derivation (downstream consumers gate pick/save and suppress
 *  helmert-outside-crs on it).
 *
 *  Short-circuits on `existingGeoref`: when an IfcMapConversion is
 *  present, this detector says nothing — the dedicated
 *  `double-baked-origin` finding inside `deriveGeorefView` handles the
 *  baked-IfcSite-with-existing-MC case with a more specific message. */
export function detectBakedProjectedOrigin(metadata: IfcMetadata): XYZ | null {
  if (metadata.existingGeoref) {
    return null;
  }

  const origin = metadata.localOrigin;

  if (!origin) {
    return null;
  }

  if (Math.hypot(origin.x, origin.y) < BAKED_PROJECTED_THRESHOLD_M) {
    return null;
  }

  return origin;
}

/** Companion to `detectBakedProjectedOrigin` for the "I already have an
 *  IfcMapConversion *and* my IfcSite carries projected coords" case. The
 *  baked detector won't fire (existingGeoref short-circuits), and
 *  `helmert-outside-crs` would fire with a misleading "placeholder
 *  transform" message. Returns the baked offset when the combo lands
 *  geometry outside the CRS — the symptom that makes the file unusable
 *  without intervention. */
function detectDoubleBakedOrigin(arguments_: {
  metadata: IfcMetadata;
  effectiveParameters: HelmertParams | null;
}): XYZ | null {
  const { metadata, effectiveParameters } = arguments_;

  if (!metadata.existingGeoref) {
    return null;
  }

  const origin = metadata.localOrigin;

  if (!origin) {
    return null;
  }

  if (Math.hypot(origin.x, origin.y) < BAKED_PROJECTED_THRESHOLD_M) {
    return null;
  }

  // Gate on the symptom: only flag when the Helmert + baked origin
  // actually lands outside the CRS. A file with baked IfcSite + a
  // compensating zero-translation IfcMapConversion is geometrically fine
  // (spec-quibbles aside) and there's no user-visible problem to surface.
  if (effectiveParameters !== null) {
    return null;
  }

  return origin;
}

/**
 * Files with IfcSite RefLat/RefLon but no IfcMapConversion carry enough
 * info to place the model. Project lat/lon through the active CRS (scale
 * 1, rotation = TrueNorth) and package the result with its source
 * lat/lon as a `SeedProposal`. The caller gates on usability (site
 * inside the CRS bbox, Helmert projects cleanly) before offering it.
 */
function deriveSeedProposal(
  metadata: IfcMetadata,
  activeCrs: CrsDef,
): SeedProposal | null {
  const site = metadata.siteReference;
  const projected = projectIfcSite(metadata, activeCrs);
  if (!site || projected === null || projected.isErr()) {
    return null;
  }

  // Convention: IfcSite RefLatitude/RefLongitude describes the location
  // of the IFC project's spatial root (local (0,0,0)) — keep the literal
  // `local` here to make the assumption explicit, since `localOrigin` may
  // be non-zero on this metadata. Algebra lives in `solveSinglePointFallback`.
  const params = solveSinglePointFallback(
    { local: { x: 0, y: 0, z: 0 }, target: projected.value },
    { trueNorthRotation: trueNorthRotation(metadata.trueNorth) },
  );

  return {
    site: { latitude: site.latitude, longitude: site.longitude },
    params,
  };
}

/**
 * Sanity-gate: applying the helmert to localOrigin must land inside the
 * active CRS's bbox. Without this, files with placeholder
 * IfcMapConversion values (e.g. (E,N)=(0,0) plus TrueNorth-baked
 * rotation, or non-zero values that combine with localOrigin to land
 * near the CRS false-origin) fire a proj4js "Failed to find a grid shift
 * table" warning per footprint vertex. One pre-check costs at most one
 * warning per (params, CRS) change and hides the rest. See
 * docs/crs-datum-grids.md.
 */
function computeEffectiveParameters(arguments_: {
  rawParameters: HelmertParams | null;
  activeCrs: CrsDef | null;
  localOrigin: XYZ | null;
}): HelmertParams | null {
  const { rawParameters, activeCrs, localOrigin } = arguments_;
  if (!rawParameters) {
    return null;
  }

  if (!activeCrs) {
    return rawParameters;
  }

  return helmertProjectsInsideCrs(rawParameters, activeCrs, localOrigin)
    ? rawParameters
    : null;
}

function helmertProjectsInsideCrs(
  parameters: HelmertParams,
  activeCrs: CrsDef,
  localOrigin: XYZ | null,
): boolean {
  return projectLocalToWgs84(
    localOrigin ?? { x: 0, y: 0, z: 0 },
    parameters,
    activeCrs,
  ).isOk();
}

/**
 * Derive the full view from `(metadata, activeCrs, anchor)`. Pure — wrap
 * in `useMemo` at the call site. CRS-scoped findings appear in
 * `findings`; file-scoped findings are emitted at file-load time
 * (see `app.tsx::handleFile` → `detectBakedProjectedOrigin`).
 */
export function deriveGeorefView(arguments_: {
  metadata: IfcMetadata;
  activeCrs: CrsDef | null;
  anchor: Anchor;
}): GeorefView {
  const { metadata, activeCrs, anchor } = arguments_;

  // Parameters come from the anchor alone — the IfcSite seed is offered
  // separately (see `seedProposal` below), never auto-applied.
  const rawParameters = anchorParams(anchor);

  const effectiveParameters = computeEffectiveParameters({
    rawParameters,
    activeCrs,
    localOrigin: metadata.localOrigin,
  });

  const provenance = anchor.kind;

  const references = deriveMapReferences(
    metadata,
    effectiveParameters,
    activeCrs,
  );

  // The IfcSite seed is never auto-applied: bogus RefLat/RefLon values
  // are common in the wild (Revit's untouched default is in Boston), so
  // it's offered as a proposal the anchor card renders, and only an
  // explicit accept turns it into an anchor. Offered only when there's
  // no anchor yet and the seed is actually usable: site ref inside the
  // CRS's area of use AND the seeded Helmert projects cleanly. Outside
  // either gate, `site-outside-crs` / the solver path tell the story.
  const proposed =
    rawParameters === null && activeCrs
      ? deriveSeedProposal(metadata, activeCrs)
      : null;
  const seedProposal =
    proposed &&
    activeCrs &&
    !references.siteOutsideBbox &&
    helmertProjectsInsideCrs(proposed.params, activeCrs, metadata.localOrigin)
      ? proposed
      : null;

  const bakedProjectedOrigin = detectBakedProjectedOrigin(metadata);
  const doubleBakedOrigin = activeCrs
    ? detectDoubleBakedOrigin({ metadata, effectiveParameters })
    : null;

  const findings: Array<Finding> = [];

  if (activeCrs) {
    if (seedProposal) {
      findings.push({
        kind: "ifc-site-seed-available",
        proposal: seedProposal,
        crsCode: activeCrs.code,
      });
    }

    if (activeCrs.accuracy.kind === "degraded-override-failed") {
      findings.push({
        kind: "grid-degraded",
        crsCode: activeCrs.code,
        reason: activeCrs.accuracy.reason,
      });
    }

    if (references.siteOutsideBbox && metadata.siteReference) {
      findings.push({
        kind: "site-outside-crs",
        site: {
          latitude: metadata.siteReference.latitude,
          longitude: metadata.siteReference.longitude,
        },
        crsCode: activeCrs.code,
        areaOfUse: activeCrs.areaOfUse ?? null,
        hasExistingGeoref: metadata.existingGeoref !== null,
      });
    }

    if (doubleBakedOrigin) {
      findings.push({
        kind: "double-baked-origin",
        origin: doubleBakedOrigin,
        crsCode: activeCrs.code,
        areaOfUse: activeCrs.areaOfUse ?? null,
      });
    }

    // Suppressed when baked-origin (no MC) or double-baked-origin (with
    // MC) already explains the underlying cause: the bbox mismatch is a
    // downstream symptom and the generic "placeholder transform" wording
    // would misdirect the user away from the real fix.
    if (
      !bakedProjectedOrigin &&
      !doubleBakedOrigin &&
      rawParameters !== null &&
      effectiveParameters === null
    ) {
      findings.push({
        kind: "helmert-outside-crs",
        source: metadata.existingGeoref ? "existing-georef" : "anchor-params",
        crsCode: activeCrs.code,
        areaOfUse: activeCrs.areaOfUse ?? null,
      });
    }
  }

  return {
    editableParameters: rawParameters,
    effectiveParameters,
    seedProposal,
    provenance,
    references,
    bakedProjectedOrigin,
    doubleBakedOrigin,
    findings,
  };
}
