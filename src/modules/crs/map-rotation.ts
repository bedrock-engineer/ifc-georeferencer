import { type Result } from "neverthrow";
import { type CrsDef } from "./types";
import { transformProjectedToWgs84, type TransformError } from "./transform";

/** Grid-north step (canonical metres) used to measure convergence. Building
 * scale; convergence varies so slowly (~0.5°/100km) that the exact length is
 * immaterial. */
const STEP_METRES = 10;

/**
 * Grid convergence correction for the 3D map render.
 *
 * The 3D layer renders the IFC mesh in MapLibre's web-mercator frame, whose
 * +Y is **true north** (meridians are vertical in web mercator). The Helmert
 * `rotation` is measured against the projected CRS's **grid north**. The two
 * differ by the grid convergence γ at the anchor — small near a CRS's central
 * meridian (NL RD, UTM) but large for oblique projections (~7.7° for Czech
 * Krovák, EPSG:2065). Without correcting for it the 3D model renders rotated
 * off the (per-vertex-projected, and therefore correct) 2D footprint by γ.
 *
 * Returns the angle in **radians to ADD** to the Helmert rotation before
 * building the model matrix (i.e. −γ, the grid→true-north rotation). The 2D
 * footprint/axes overlays do not need this: they are projected vertex-by-vertex
 * through proj4 and land at true lng/lat directly.
 *
 * This restores the "Web Mercator rotation correction" the original Flask app
 * applied (see docs/flask-app-walkthrough.md step 4) which the port dropped.
 *
 * `easting`/`northing` are the anchor's projected coordinates in canonical
 * metres (the Helmert translation). Returns `err` only if the anchor or its
 * grid-north neighbour fails to unproject; callers fall back to no correction.
 */
export function mapRotationCorrection(
  crs: CrsDef,
  easting: number,
  northing: number,
): Result<number, TransformError> {
  return transformProjectedToWgs84(crs, easting, northing).andThen((origin) =>
    transformProjectedToWgs84(crs, easting, northing + STEP_METRES).map(
      (north) => {
        // Bearing of the grid-north step, clockwise from true north, via a
        // local equirectangular approximation (the step is metres-scale).
        const lat0 = (origin.latitude * Math.PI) / 180;
        const east = (north.longitude - origin.longitude) * Math.cos(lat0);
        const up = north.latitude - origin.latitude;
        const convergence = Math.atan2(east, up);
        
        return -convergence;
      },
    ),
  );
}
