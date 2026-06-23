/**
 * App-specific visual tokens plus the derived MapLibre `StyleSpecification`.
 * Basemap + overlay definitions live in `./layers/` — `STYLE` here just
 * assembles them into the shape MapLibre wants at startup.
 */

import type {
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { BASEMAPS, OVERLAYS, TERRAIN } from "./layers/registry";

export const ACCENT_COLOR = "#0f766e";

export const FOOTPRINT_SOURCE_ID = "ifc-footprint";
export const FOOTPRINT_FILL_LAYER_ID = "ifc-footprint-fill";
export const FOOTPRINT_LINE_LAYER_ID = "ifc-footprint-line";

export const SPACES_SOURCE_ID = "ifc-spaces";
export const SPACES_FILL_LAYER_ID = "ifc-spaces-fill";
export const SPACES_LINE_LAYER_ID = "ifc-spaces-line";
export const SPACES_COLOR = "#2563eb";

export const AXES_SOURCE_ID = "ifc-axes";
export const AXES_LINE_LAYER_ID = "ifc-axes-line";
export const IFC_X_AXIS_COLOR = "#dc2626";
export const IFC_Y_AXIS_COLOR = "#16a34a";
export const NORTH_AXIS_COLOR = "#1d4ed8";

export const RESIDUALS_SOURCE_ID = "helmert-residuals";
export const RESIDUALS_FIT_LAYER_ID = "helmert-residuals-fit";
export const RESIDUAL_FIT_COLOR = "#0f766e";

/** Narrow `LayerSpecification` to layers that carry a source reference. */
function sourceIdOf(layer: LayerSpecification): string {
  if ("source" in layer && typeof layer.source === "string") {
    return layer.source;
  }
  throw new Error(
    `Registry layer '${layer.id}' has no string source — basemaps/overlays must reference a source by id.`,
  );
}

function buildStyle(): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    [TERRAIN.sourceId]: TERRAIN.source,
  };
  const layers: Array<LayerSpecification> = [];

  for (const [index, basemap] of BASEMAPS.entries()) {
    sources[sourceIdOf(basemap.layer)] = basemap.source;
    // First basemap is visible at startup; the rest are hidden.
    layers.push(
      index === 0
        ? basemap.layer
        : { ...basemap.layer, layout: { visibility: "none" } },
    );
  }

  for (const overlay of OVERLAYS) {
    if (overlay.kind !== "raster") {
      continue;
    }
    sources[sourceIdOf(overlay.layer)] = overlay.source;
    layers.push({ ...overlay.layer, layout: { visibility: "none" } });
  }

  // Terrain is intentionally NOT set here. It's only needed in the 3D view
  // (drape + `queryTerrainElevation` for model placement), and enabling it in
  // the flat 2D view triggers a MapLibre bug: after a programmatic camera jump
  // (e.g. framing a loaded model) the terrain render-to-texture pass leaves the
  // basemap raster unpainted until the user pans/zooms. So `useThreeDLayer`
  // toggles terrain on entering 3D via `setTerrain(TERRAIN_CONFIG)` and clears
  // it on returning to 2D. The DEM source still lives in `sources` so
  // `setTerrain` can reference it by id.
  return {
    version: 8,
    sources,
    layers,
  };
}

/** Terrain config applied via `map.setTerrain` in 3D view (see above). */
export const TERRAIN_CONFIG = {
  source: TERRAIN.sourceId,
  exaggeration: 1,
} as const;

export const STYLE: StyleSpecification = buildStyle();
