import { type Map as MlMap } from "maplibre-gl";
import { type RefObject, useEffect, useRef, useState } from "react";

import { emitLog } from "#lib/log";
import type { CrsDef } from "#modules/crs";
import type { HelmertParams } from "#modules/helmert/solve";
import type { IfcFacade } from "#modules/ifc/facade";
import { getIfc } from "../../../ifc-api";
import { applyAnchor } from "../apply-anchor";
import type { ViewMode } from "../controls/view-toggle";
import type { ThreeDLayer } from "../layers/three-d-layer";
import { TERRAIN_CONFIG } from "../style";

interface ThreeDState {
  view: ViewMode;
  parameters: HelmertParams | null;
  activeCrs: CrsDef | null;
  showSpaces: boolean;
  xray: boolean;
}

interface MeshOrigin {
  x: number;
  y: number;
  z: number;
}

type Meshes = Awaited<ReturnType<IfcFacade["extractMeshes"]>>;

/**
 * 3D layer lifecycle: add the Three.js IFC layer when view === "3d",
 * anchor it (and re-anchor on param/CRS changes), tear it down when
 * leaving 3D. Three.js is dynamically imported so it stays out of the
 * initial bundle.
 */
export function useThreeDLayer(
  mapRef: RefObject<MlMap | null>,
  { view, parameters, activeCrs, showSpaces, xray }: ThreeDState,
): { isLoading: boolean } {
  const threeDRef = useRef<ThreeDLayer | null>(null);
  const meshOriginRef = useRef<MeshOrigin | null>(null);
  // Cache meshes so toggling back to 3D doesn't re-fetch. The ref resets
  // naturally when Workspace remounts on file change (key={filename}).
  const meshCacheRef = useRef<Promise<Meshes> | null>(null);
  // Read by `setup` for the layer's *initial* visibility / transparency,
  // written by the toggle effects below so a flip during in-flight mesh
  // load isn't lost. Kept out of the setup effect's deps so toggling
  // doesn't re-anchor.
  const showSpacesRef = useRef(showSpaces);
  const xrayRef = useRef(xray);

  // Drives the "Loading 3D model…" overlay in MapView. True while the
  // dynamic three.js import and mesh extraction are in flight; falls back
  // to false on completion, teardown, or cancellation.
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (view !== "3d") {
      setIsLoading(false);
      // Terrain is a 3D-only concern. Clearing it in 2D keeps the flat view
      // on MapLibre's plain raster path, which avoids the terrain
      // render-to-texture bug that leaves the basemap unpainted after a
      // programmatic camera jump. See style.ts.
      if (map.getTerrain()) {
        map.setTerrain(null);
      }
      teardown(map, threeDRef, meshOriginRef);
      return;
    }

    // Entering 3D: drape needs the DEM, and applyAnchor samples it via
    // queryTerrainElevation. Set it before setup runs.
    if (!map.getTerrain()) {
      map.setTerrain(TERRAIN_CONFIG);
    }

    // MapView disables the 3D toggle when these are missing, so reaching
    // 3D without them is only possible in a transient render — no-op.
    if (!parameters || !activeCrs) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    setup(map, {
      parameters,
      activeCrs,
      showSpacesRef,
      xrayRef,
      threeDRef,
      meshOriginRef,
      meshCacheRef,
      isCancelled: () => cancelled,
    })
      .catch((error: unknown) => {
        emitLog({
          level: "error",
          message: `3D layer setup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      setIsLoading(false);
    };
  }, [mapRef, view, parameters, activeCrs]);

  useEffect(() => {
    showSpacesRef.current = showSpaces;
    threeDRef.current?.setSpacesVisible(showSpaces);
  }, [showSpaces]);

  useEffect(() => {
    xrayRef.current = xray;
    threeDRef.current?.setTransparentMode(xray);
  }, [xray]);

  return { isLoading };
}

function teardown(
  map: MlMap,
  threeDRef: RefObject<ThreeDLayer | null>,
  meshOriginRef: RefObject<MeshOrigin | null>,
): void {
  const threeD = threeDRef.current;

  if (!threeD) {
    return;
  }

  map.easeTo({ pitch: 0, bearing: 0, duration: 300 });

  if (map.getLayer(threeD.layer.id)) {
    map.removeLayer(threeD.layer.id);
  }

  threeD.dispose();
  threeDRef.current = null;
  meshOriginRef.current = null;
}

async function setup(
  map: MlMap,
  context: {
    parameters: HelmertParams;
    activeCrs: CrsDef;
    showSpacesRef: RefObject<boolean>;
    xrayRef: RefObject<boolean>;
    threeDRef: RefObject<ThreeDLayer | null>;
    meshOriginRef: RefObject<MeshOrigin | null>;
    meshCacheRef: RefObject<Promise<Meshes> | null>;
    isCancelled: () => boolean;
  },
): Promise<void> {
  // Lazy-load three.js + our threeDLayer module.
  const { createThreeDLayer } = await import("../layers/three-d-layer");
  if (context.isCancelled()) {
    return;
  }

  // Fetch (or reuse cached) meshes from the facade.
  const cached = context.meshCacheRef.current;
  const promise = cached ?? getIfc().extractMeshes();
  context.meshCacheRef.current = promise;

  const meshes = await promise;

  if (context.isCancelled()) {
    return;
  }

  // Create the layer once per 3D session; param changes only re-anchor.
  const isInitialPlacement = context.threeDRef.current === null;
  if (!context.threeDRef.current) {
    const layer = createThreeDLayer();

    context.threeDRef.current = layer;
    layer.setSpacesVisible(context.showSpacesRef.current);
    layer.setTransparentMode(context.xrayRef.current);
    context.meshOriginRef.current = layer.setMeshes(meshes);

    if (!map.getLayer(layer.layer.id)) {
      map.addLayer(layer.layer);
    }
  }

  const meshOrigin = context.meshOriginRef.current;

  if (!meshOrigin) {
    emitLog({
      level: "warn",
      message: "No mesh geometry available — nothing to anchor in 3D view.",
    });
    return;
  }

  applyAnchor(
    context.threeDRef.current,
    context.parameters,
    context.activeCrs,
    map,
    meshOrigin,
    isInitialPlacement,
  );
}
