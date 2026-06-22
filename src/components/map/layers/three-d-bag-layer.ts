/**
 * MapLibre custom layer hosting a 3d-tiles-renderer TilesRenderer for the
 * Dutch 3D BAG tileset (buildings, LoD 2.2). Pattern follows MapLibre's
 * official "Add 3D tiles using threejs" example, tiles arrive in ECEF,
 * we rebase them around the tileset's bounding-sphere centre into a local
 * ENU frame via `ellipsoid.getEastNorthUpFrame`, then map that frame into
 * MapLibre's Mercator units via MercatorCoordinate at the same centre.
 */

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin } from "3d-tiles-renderer/plugins";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { emitLog } from "#lib/log";

export interface ThreeDBagLayer {
  readonly layer: maplibregl.CustomLayerInterface;
  dispose(): void;
}

// PDOK 3D Basisvoorziening (Kadaster) — LoD 2.2 buildings with LoD 1.3
// fallback where AHN is unavailable. Same pipeline as the matching terrain
// collection (`terreinen`), so vertical datum assumptions are internally
// consistent
const TILESET_URL =
  "https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/gebouwen/3dtiles?f=json";

// NL geoid undulation (NLGEO2018): WGS84 ellipsoid sits ~43 m above NAP
// across the Netherlands (range ~40–44 m). 3D BAG's cesium3dtiles export
// converts NAP → ellipsoidal heights using the NLGEO2018 grid, so buildings
// at NAP 0 have ellipsoidal heights of ~+43 m. Used as the layer anchor
// altitude so vertices land in NAP-space (matching Mapterhorn/AHN terrain
// over NL); see the per-frame comment below for the full derivation.
const NL_GEOID_UNDULATION_M = 43;

export function createThreeDBagLayer(): ThreeDBagLayer {
  const id = "bag3d-tiles";

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xFF_FF_FF, 2.5));

  const dir = new THREE.DirectionalLight(0xFF_FF_FF, 1.2);
  dir.position.set(1, 1, 1);
  scene.add(dir);

  // `camera` is what we feed to three's renderer (its projectionMatrix
  // already includes mvp × localTransform). `tilesCamera` is what
  // 3d-tiles-renderer uses for frustum culling and LOD selection — it
  // needs the real view/projection matrices in tile-local space.
  //
  // matrixAutoUpdate must be false on tilesCamera because we write
  // matrixWorld directly each frame; otherwise tiles.update() internally
  // triggers updateMatrixWorld() which rebuilds it from the (unset)
  // position/quaternion and clobbers our values.
  const camera = new THREE.PerspectiveCamera();
  const tilesCamera = new THREE.PerspectiveCamera();
  tilesCamera.matrixAutoUpdate = false;
  tilesCamera.matrixWorldAutoUpdate = false;

  let renderer: THREE.WebGLRenderer | null = null;
  let mapReference: MlMap | null = null;
  let tiles: TilesRenderer | null = null;
  // ENU→ECEF frame at the tileset centroid, captured once so tile vertices
  // (rebased to ENU_A via its inverse on tiles.group) keep float32 precision.
  // Per-frame we rebase from ENU_A to ENU_M at the current map centre so the
  // Mercator linearisation (meterInMercatorCoordinateUnits) is sampled where
  // the user is actually looking — otherwise tiles 30+ km from the anchor
  // shift by hundreds of metres.
  let enuToEcefA: THREE.Matrix4 | null = null;

  const layer: maplibregl.CustomLayerInterface = {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      mapReference = map;
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;

      tiles = new TilesRenderer(TILESET_URL);
      // 3D BAG .glb tiles are Meshopt-compressed (EXT_meshopt_compression);
      // three's GLTFLoader needs the decoder wired up explicitly before the
      // first tile is parsed.
      tiles.registerPlugin(
        new GLTFExtensionsPlugin({ meshoptDecoder: MeshoptDecoder }),
      );
      scene.add(tiles.group);
      tiles.setCamera(tilesCamera);
      tiles.setResolutionFromRenderer(tilesCamera, renderer);

      let tileErrorEmitted = false;

      tiles.addEventListener("load-error", ({ error, url }) => {
        console.warn("[3D BAG] tile load failed", url, error);
        // Individual tile failures are normal on the edges of the tileset; only
        // surface the first one so a bad network doesn't spam the log.
        if (!tileErrorEmitted) {
          tileErrorEmitted = true;
          emitLog({
            level: "warn",
            message: `3D BAG tile load failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });

      let firstContentLogged = false;
      tiles.addEventListener("load-content", () => {
        if (firstContentLogged) {
          return;
        }
        firstContentLogged = true;
        console.log("[3D BAG] first tile content loaded", {
          visibleTiles: tiles?.visibleTiles.size,
          activeTiles: tiles?.activeTiles.size,
          groupChildren: tiles?.group.children.length,
        });
      });

      tiles.addEventListener("load-tileset", () => {
        if (enuToEcefA || !tiles) {
          return;
        }

        // Tiles arrive in ECEF. We pick the bounding-sphere centre as the
        // ENU anchor A and use the renderer's own ellipsoid to build its
        // ENU_A→ECEF frame. Its inverse rebases every tile vertex from ECEF
        // into local metres (X=east, Y=north, Z=up, origin at centre) —
        // small magnitudes so float32 stays precise.
        const sphere = new THREE.Sphere();
        tiles.getBoundingSphere(sphere);

        const center = sphere.center.clone();
        const cart = { lat: 0, lon: 0, height: 0 };
        tiles.ellipsoid.getPositionToCartographic(center, cart);

        console.log("[3D BAG] tileset anchor", {
          lng: (cart.lon * 180) / Math.PI,
          lat: (cart.lat * 180) / Math.PI,
          height: cart.height,
          radius: sphere.radius,
        });

        const frame = new THREE.Matrix4();
        tiles.ellipsoid.getEastNorthUpFrame(
          cart.lat,
          cart.lon,
          cart.height,
          frame,
        );
        enuToEcefA = frame;
        tiles.group.matrix.copy(frame).invert();
        tiles.group.matrixAutoUpdate = false;
        tiles.group.updateMatrixWorld(true);
      });
    },

    onRemove() {
      tiles?.dispose();
      tiles = null;
      renderer?.dispose();
      renderer = null;
      mapReference = null;
      enuToEcefA = null;
    },

    render(_gl, arguments_) {
      if (!renderer || !tiles || !mapReference) {
        return;
      }

      // tiles.update() must run at least once to trigger the root tileset
      // fetch — that fetch is what eventually fires load-tileset and sets
      // enuToEcefA. If we gated tiles.update() on enuToEcefA being ready,
      // we'd deadlock (no fetch → no load-tileset → no anchor → no fetch).
      if (!enuToEcefA) {
        tiles.update();
        mapReference.triggerRepaint();
        return;
      }

      // Per-frame: anchor the local→Mercator linearisation at the map's
      // current centre (ENU_M). Compose with ENU_A→ENU_M so tile vertices,
      // which live in ENU_A, end up in the frame where the linearisation is
      // accurate. rebase = enuToEcefM⁻¹ · enuToEcefA.
      const mapCenter = mapReference.getCenter();
      const latRad = (mapCenter.lat * Math.PI) / 180;
      const lonRad = (mapCenter.lng * Math.PI) / 180;

      const enuToEcefM = new THREE.Matrix4();
      tiles.ellipsoid.getEastNorthUpFrame(latRad, lonRad, 0, enuToEcefM);
      const rebase = enuToEcefM.clone().invert().multiply(enuToEcefA);

      // BAG vertices carry ellipsoidal heights (NAP + geoid undulation).
      // Mapterhorn serves AHN NAP values labelled as altitude, so MapLibre
      // renders terrain at altitude = NAP. ENU_M is built at ellipsoidal 0
      // at the map centre, so a vertex at ellipsoidal H_v ends up at scene
      // altitude = anchor + H_v. For that to equal H_v − undulation (= NAP
      // of the vertex, matching the terrain's altitude space), the anchor
      // must be −undulation. Adding terrainElev here would co-move the
      // anchor with the terrain and cancel out, which was the old bug:
      // buildings floated ~(H_v − undulation) m above terrain inland —
      // e.g. ~100 m over the Limburg plateau.
      const merc = maplibregl.MercatorCoordinate.fromLngLat(
        [mapCenter.lng, mapCenter.lat],
        -NL_GEOID_UNDULATION_M,
      );
      const s = merc.meterInMercatorCoordinateUnits();
      // ENU_M (X=east, Y=north, Z=up, metres) → Mercator units. Mercator Y
      // grows southward, hence -s on Y.
      const localTransform = new THREE.Matrix4()
        .makeTranslation(merc.x, merc.y, merc.z)
        .scale(new THREE.Vector3(s, -s, s));

      camera.projectionMatrix
        .fromArray(
          arguments_.defaultProjectionData
            .mainMatrix as unknown as Array<number>,
        )
        .multiply(localTransform)
        .multiply(rebase);

      // Reconstruct a view matrix for the tiles camera so 3d-tiles-renderer
      // can cull and pick LODs against the real map frustum.
      const P = new THREE.Matrix4().fromArray(
        arguments_.projectionMatrix as unknown as Array<number>,
      );

      const invP = P.clone().invert();

      const V = new THREE.Matrix4().multiplyMatrices(
        invP,
        camera.projectionMatrix,
      );

      tilesCamera.projectionMatrix.copy(P);
      tilesCamera.matrixWorldInverse.copy(V);
      tilesCamera.matrixWorld.copy(V).invert();

      renderer.resetState();
      renderer.render(scene, camera);
      tiles.update();
      mapReference.triggerRepaint();
    },
  };

  return {
    layer,
    dispose() {
      tiles?.dispose();
      tiles = null;
      renderer?.dispose();
      renderer = null;
      mapReference = null;
      enuToEcefA = null;
    },
  };
}
