import type { Map as MlMap } from "maplibre-gl";
import {
  mapRotationCorrection,
  projectLocalToWgs84,
  type CrsDef,
} from "#modules/crs";
import type { HelmertParams, XYZ } from "#modules/helmert/solve";
import { emitLog } from "../../lib/log";
import type { ThreeDLayer } from "./layers/three-d-layer";

/**
 * Project the mesh centroid through the Helmert transform + proj4 to get the
 * WGS84 anchor, then push it into the 3D layer. Anchoring at the centroid
 * (rather than the IFC local origin) is load-bearing: Dutch AEC exports often
 * bake RD coordinates into the local frame, so local (0,0,0) can project to
 * somewhere hundreds of km from the actual building.
 *
 * `flyCamera` only flies on the initial placement — without it the 2D
 * `fitBounds` can leave the map far from where the 3D model will render.
 * Subsequent param tweaks (rotation, E/N sliders) re-anchor in place so
 * editing doesn't fight the user's camera (forced pitch/zoom snap-back was
 * jarring). The ZoomToModel control is the explicit re-frame affordance.
 */
export function applyAnchor(
  layer: ThreeDLayer,
  parameters: HelmertParams,
  activeCrs: CrsDef,
  map: MlMap,
  meshOrigin: XYZ,
  flyCamera: boolean,
): void {
  // Both meshOrigin (web-ifc auto-converts to metres) and parameters
  // (canonical metres — see modules/helmert/solve.ts) are in metres. The proj4
  // boundary inside projectLocalToWgs84 converts to CRS-native units.
  const result = projectLocalToWgs84(meshOrigin, parameters, activeCrs);
  if (result.isErr()) {
    emitLog({
      level: "error",
      message: `Anchor placement failed: ${
        result.error.cause instanceof Error
          ? result.error.cause.message
          : String(result.error.cause)
      }`,
    });
    return;
  }
  const ll = result.value;
  // MapLibre's MercatorCoordinate altitude is absolute (above the ellipsoid,
  // NOT relative to terrain).
  //
  // Two modes:
  //
  // 1. OrthogonalHeight set: trust `parameters.height` as the absolute height
  //    in the target CRS's vertical datum. Terrain is rendered, so the model
  //    lines up with it on a correctly georef'd file.
  //
  // 2. No OrthogonalHeight (IfcSite-only mode): sample Mapterhorn at the
  //    anchor to land the model on terrain visually so horizontal placement
  //    is verifiable. The sample never feeds back into parameters.height —
  //    vertical datums vary across DEM sources and we don't want to invent
  //    authority. User refines OrthogonalHeight by hand in the anchor card.
  //
  // Transparent-basemap mode is handled inside the 3D layer (depth-clear)
  // rather than here, so this function stays altitude-mode oblivious.
  let baseAltitude: number;
  let altitudeSource: string;
  if (parameters.height === 0) {
    baseAltitude = map.queryTerrainElevation([ll.longitude, ll.latitude]) ?? 0;
    altitudeSource = "terrain";
  } else {
    baseAltitude = parameters.height;
    altitudeSource = "OrthogonalHeight";
  }
  const absoluteAltitude = baseAltitude + meshOrigin.z;
  // The 3D layer renders in web mercator (up = true north); `parameters.rotation`
  // is measured against the projected CRS's grid north. Correct for the grid
  // convergence at the anchor so the model overlays the per-vertex-projected 2D
  // footprint. Falls back to 0 (no correction) if the probe fails to unproject.
  const correction = mapRotationCorrection(
    activeCrs,
    parameters.easting,
    parameters.northing,
  );

  const rotationCorrection = correction.isOk() ? correction.value : 0;
  
  layer.update(
    { lng: ll.longitude, lat: ll.latitude, altitude: absoluteAltitude },
    parameters,
    rotationCorrection,
  );

  if (flyCamera) {
    map.flyTo({
      center: [ll.longitude, ll.latitude],
      zoom: Math.max(map.getZoom(), 17),
      pitch: 60,
      duration: 500,
    });
  }

  emitLog({
    message: `3D model anchored at ${ll.longitude.toFixed(6)}, ${ll.latitude.toFixed(6)} (alt=${absoluteAltitude.toFixed(2)}m via ${altitudeSource}, scale=${parameters.xScale.toFixed(4)}, rot=${parameters.rotation.toFixed(4)} rad, grid-convergence=${((rotationCorrection * 180) / Math.PI).toFixed(3)}°, meshOrigin=(${meshOrigin.x.toFixed(2)}, ${meshOrigin.y.toFixed(2)}, ${meshOrigin.z.toFixed(2)}))`,
  });
}
