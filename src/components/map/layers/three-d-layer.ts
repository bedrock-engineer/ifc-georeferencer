/**
 * MapLibre custom layer hosting a Three.js scene with the IFC mesh.
 *
 * This module imports `three` at the top, so importing it only via dynamic
 * `import()` means Vite code-splits all 3D dependencies into their own chunk —
 * they stay out of the initial bundle until the user flips to the 3D view.
 *
 * The pattern (shared GL context, MercatorCoordinate anchoring, renderer.resetState)
 * mirrors the Flask app's view3D.html.
 */

import type { HelmertParams, XYZ } from "#modules/helmert/solve";
import type { MeshExtract } from "#modules/ifc/worker";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import * as THREE from "three";
import {
  IFCBEAM,
  IFCBUILDINGELEMENTPROXY,
  IFCCOLUMN,
  IFCCOVERING,
  IFCCURTAINWALL,
  IFCDOOR,
  IFCFURNISHINGELEMENT,
  IFCFURNITURE,
  IFCMEMBER,
  IFCOPENINGELEMENT,
  IFCPLATE,
  IFCRAILING,
  IFCROOF,
  IFCSLAB,
  IFCSTAIR,
  IFCSTAIRFLIGHT,
  IFCWALL,
  IFCWALLSTANDARDCASE,
  IFCWINDOW,
} from "web-ifc";

/**
 * Flip to `true` to enable render-pipeline diagnostics: a magenta 200m cube
 * at the mesh centroid, per-frame NDC logs (frames 0/30/90), and dumps from
 * setMeshes/update. Meant for investigating "why isn't the model visible?"
 * regressions — never ship enabled.
 */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
const DEBUG: boolean = false;

type Rgb = [red: number, green: number, blue: number];

/**
 * Fallback colours keyed by IFC line type. Used when web-ifc returns a
 * near-black colour for a mesh — typically because the file has no
 * IfcStyledItem/IfcSurfaceStyle for that product.
 */
const CLASS_COLOURS = new Map<number, Rgb>([
  [IFCWALL, [0.85, 0.78, 0.65]],
  [IFCWALLSTANDARDCASE, [0.85, 0.78, 0.65]],
  [IFCCURTAINWALL, [0.7, 0.85, 0.95]],
  [IFCSLAB, [0.75, 0.75, 0.75]],
  [IFCROOF, [0.66, 0.33, 0.22]],
  [IFCCOVERING, [0.8, 0.8, 0.78]],
  [IFCWINDOW, [0.6, 0.85, 0.95]],
  [IFCDOOR, [0.55, 0.35, 0.18]],
  [IFCCOLUMN, [0.55, 0.55, 0.55]],
  [IFCBEAM, [0.55, 0.4, 0.25]],
  [IFCSTAIR, [0.6, 0.6, 0.6]],
  [IFCSTAIRFLIGHT, [0.6, 0.6, 0.6]],
  [IFCRAILING, [0.35, 0.35, 0.35]],
  [IFCPLATE, [0.65, 0.65, 0.7]],
  [IFCMEMBER, [0.5, 0.5, 0.55]],
  [IFCFURNISHINGELEMENT, [0.55, 0.45, 0.35]],
  [IFCFURNITURE, [0.55, 0.45, 0.35]],
  [IFCOPENINGELEMENT, [0.9, 0.9, 0.9]],
  [IFCBUILDINGELEMENTPROXY, [0.8, 0.8, 0.82]],
]);

const DEFAULT_COLOUR: [number, number, number] = [0.8, 0.8, 0.82];

export interface ThreeDLayer {
  readonly layer: maplibregl.CustomLayerInterface;
  /**
   * Upload meshes. Vertex positions are shifted so the mesh bbox is centered
   * on the origin — this keeps vertex magnitudes small (float32-friendly) and,
   * more importantly, lets the caller anchor the scene at the mesh centroid
   * rather than at the IFC local (0,0,0). Many real-world files (notably
   * Dutch AEC exports) bake RD coordinates into the local frame — the centroid
   * of the geometry is where the building actually is, the local origin is not.
   *
   * Returns the local-frame centroid so the caller can project it through the
   * same Helmert + CRS pipeline used for everything else.
   */
  setMeshes(meshes: Array<MeshExtract>): XYZ | null;
  /**
   * Update where the mesh centroid sits on the globe, plus the rotation/scale
   * portion of the Helmert transform. `anchor` is the WGS84 + altitude of the
   * centroid as computed via applyHelmert(centroid) → projected → WGS84.
   *
   * Both vertices (web-ifc auto-converts to metres) and `parameters`'
   * scale fields (canonical metres — see modules/helmert/solve.ts) are in metres, so
   * the effective per-vertex render scale is just the bare scale fields —
   * typically 1.0 each.
   */
  update(
    anchor: { lng: number; lat: number; altitude: number },
    parameters: HelmertParams,
    mapRotationCorrection: number,
  ): void;
  /** Toggle visibility of IfcSpace meshes (translucent room volumes). */
  setSpacesVisible(visible: boolean): void;
  /**
   * Toggle "see-through-terrain" rendering. When on, the layer clears the
   * depth buffer before rendering its scene, so MapLibre's terrain mesh
   * doesn't occlude IFC geometry that sits below ground (basements,
   * pilings). The IFC still depth-tests against its own fragments so the
   * model looks correct against itself.
   *
   * Trade-off: with the depth buffer wiped, the IFC also draws on top of
   * any other 3D custom layers rendered before it (notably the 3D BAG
   * layer when its overlay is enabled). Acceptable because transparent
   * mode and 3D BAG are different verification flows — sub-ground IFC
   * detail vs. surrounding building context.
   *
   * Driven by the "X-ray" toggle in the Layers panel.
   */
  setTransparentMode(transparent: boolean): void;
  dispose(): void;
}

interface Anchor {
  lng: number;
  lat: number;
  altitude: number;
}

/** Build the scene graph: ambient + two directional lights + an empty model group. */
function createLitScene(): { scene: THREE.Scene; modelGroup: THREE.Group } {
  const scene = new THREE.Scene();
  // IFC group holds the mesh(es). We transform this group — never the scene —
  // so lighting stays in world space.
  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  scene.add(new THREE.AmbientLight(0xFF_FF_EE, 0.9));

  const dir1 = new THREE.DirectionalLight(0xFF_FF_FF, 2);
  dir1.position.set(1, 1, 1);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0xFF_FF_FF, 1.2);
  dir2.position.set(-1, 0.5, -1);
  scene.add(dir2);

  return { scene, modelGroup };
}

/** Dispose geometry + materials of every mesh in the group, then empty it. */
function disposeGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      // THREE.Mesh is generic with `any` defaults, so child.geometry/material
      // widen to `any`. Narrow explicitly before disposing.
      const geometry = child.geometry as THREE.BufferGeometry;
      geometry.dispose();
      const material = child.material as THREE.Material | Array<THREE.Material>;
      if (Array.isArray(material)) {
        for (const m of material) {
          m.dispose();
        }
      } else {
        material.dispose();
      }
    }
  }
  group.clear();
}

/** Combined bbox centroid of all meshes in local IFC coords. */
function computeMeshesCentroid(meshes: Array<MeshExtract>): THREE.Vector3 {
  const bbox = new THREE.Box3();
  const point = new THREE.Vector3();

  for (const mesh of meshes) {
    for (let index = 0; index < mesh.positions.length; index += 3) {
      point.set(
        mesh.positions[index] ?? 0,
        mesh.positions[index + 1] ?? 0,
        mesh.positions[index + 2] ?? 0,
      );
      bbox.expandByPoint(point);
    }
  }

  const center = new THREE.Vector3();
  bbox.getCenter(center);

  return center;
}

/**
 * Copy mesh positions shifted so `center` becomes the origin, attach the
 * source normals from web-ifc, and wrap the result in a THREE.BufferGeometry.
 *
 * Small position magnitudes keep float32 precision sane even when the IFC
 * local frame is at RD coords. We deliberately do NOT call
 * `computeVertexNormals()`: web-ifc emits face-flat normals at hard edges
 * (via duplicated vertices) and smooth normals on curved surfaces, which is
 * exactly what architectural geometry needs. Re-averaging per shared vertex
 * would smooth wall/slab seams into soft gradients.
 */
function createShiftedGeometry(
  mesh: MeshExtract,
  center: THREE.Vector3,
): THREE.BufferGeometry {
  const shifted = new Float32Array(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index += 3) {
    shifted[index] = (mesh.positions[index] ?? 0) - center.x;
    shifted[index + 1] = (mesh.positions[index + 1] ?? 0) - center.y;
    shifted[index + 2] = (mesh.positions[index + 2] ?? 0) - center.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(shifted, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

  return geometry;
}

/**
 * Resolve colour + alpha for a mesh.
 *
 * - IfcSpace volumes render translucent blue so layered rooms read.
 * - Files without IfcStyledItem come back from web-ifc as `(0,0,0,0)` —
 *   both RGB and alpha zero. We detect that as a missing style and fall
 *   back to an opaque class-based palette; using alpha=0 as-is would make
 *   the mesh invisible (notably AC20-FZK-Haus).
 */
function resolveMeshAppearance(mesh: MeshExtract): {
  color: THREE.Color;
  alpha: number;
} {
  if (mesh.isSpace) {
    return { color: new THREE.Color(0.35, 0.65, 0.85), alpha: 0.35 };
  }

  const [r, g, b, a] = mesh.color;
  const isUnstyled = r + g + b < 0.05;

  if (isUnstyled) {
    const fallback = CLASS_COLOURS.get(mesh.ifcClass) ?? DEFAULT_COLOUR;
    return { color: new THREE.Color(...fallback), alpha: 1 };
  }

  return { color: new THREE.Color(r, g, b), alpha: a };
}

function createMeshMaterial(mesh: MeshExtract): THREE.MeshLambertMaterial {
  const { color, alpha } = resolveMeshAppearance(mesh);

  return new THREE.MeshLambertMaterial({
    color,
    transparent: alpha < 1,
    opacity: alpha,
    side: THREE.DoubleSide,
    depthWrite: !mesh.isSpace,
  });
}

/**
 * Build the per-frame model matrix that maps the mesh (Z-up, web-ifc-emitted
 * metres, centered on its bbox) into MapLibre's mercator-world frame.
 *
 * MapLibre v5's custom-layer projection matrix (`defaultProjectionData.mainMatrix`)
 * expects vertices in **mercator coordinates** (0..1 range, with Z also in
 * mercator units). So we translate to the anchor's mercator coord and scale
 * meters → mercator units via `meterInMercatorCoordinateUnits()` — the same
 * factor applied uniformly on all three axes, because mercator Z is already
 * normalised to the same units as mercator X/Y.
 *
 * `parameters.horizontalScale` and `verticalScale` are canonical metres
 * (see modules/helmert/solve.ts) — real, dimensionless Helmert scale factors,
 * typically 1.0. Vertices are also metres (web-ifc auto-conversion), so we
 * apply them bare. Horizontal and vertical are split per the same rule as
 * `applyHelmert`: only the horizontal axes carry projection distortion.
 *
 * The mesh's +Y (north) maps onto mercator -Y (mercator Y grows southward),
 * so Y gets negated in the scale.
 *
 * `mapRotationCorrection` (radians) is added to the Helmert rotation: the
 * Helmert `rotation` is measured against the projected CRS's grid north, but
 * this matrix lives in the web-mercator frame whose up is true north. The two
 * differ by the grid convergence at the anchor (large for oblique projections
 * like Czech Krovák), so without it the model renders rotated off the
 * per-vertex-projected 2D footprint. See modules/crs/map-rotation.ts.
 */
function buildModelMatrix(
  anchor: Anchor,
  parameters: HelmertParams,
  mapRotationCorrection: number,
): THREE.Matrix4 {
  const merc = maplibregl.MercatorCoordinate.fromLngLat(
    [anchor.lng, anchor.lat],
    anchor.altitude,
  );

  const mercPerMetre = merc.meterInMercatorCoordinateUnits();
  const sx = mercPerMetre * parameters.xScale;
  const sy = mercPerMetre * parameters.yScale;
  const sz = mercPerMetre * parameters.zScale;

  return new THREE.Matrix4()
    .makeTranslation(merc.x, merc.y, merc.z)
    .scale(new THREE.Vector3(sx, -sy, sz))
    .multiply(
      new THREE.Matrix4().makeRotationZ(
        parameters.rotation + mapRotationCorrection,
      ),
    );
}

/**
 * Create a 3D custom Maplibre layer. The returned `layer` is added to the map with
 * `map.addLayer(...)`, and removed with `map.removeLayer(id)`.
 */
export function createThreeDLayer(): ThreeDLayer {
  const id = "ifc-3d-model";

  const { scene, modelGroup } = createLitScene();
  const camera = new THREE.PerspectiveCamera();

  let renderer: THREE.WebGLRenderer | null = null;
  let mapReference: MlMap | null = null;

  // Latest anchor + params. See buildModelMatrix — we rebuild each frame.
  let currentAnchor: Anchor | null = null;
  let currentParameters: HelmertParams | null = null;
  let currentMapRotationCorrection = 0;
  let hasMeshes = false;
  let diagnosticFramesLogged = 0;
  // Parallel list of IfcSpace child meshes so setSpacesVisible can flip
  // their THREE.Object3D.visible flag without walking modelGroup every call.
  const spaceMeshes: Array<THREE.Mesh> = [];
  let spacesVisible = true;
  let transparentMode = false;

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
    },

    onRemove() {
      // Dispose THREE resources but leave the GL context alone — it belongs
      // to MapLibre, which will clean it up when the map itself is removed.
      disposeGroup(modelGroup);
      renderer?.dispose();
      renderer = null;
      mapReference = null;
    },

    render(_gl, arguments_) {
      if (
        !renderer ||
        !hasMeshes ||
        !currentAnchor ||
        !currentParameters ||
        !mapReference
      ) {
        return;
      }

      const modelMatrix = buildModelMatrix(
        currentAnchor,
        currentParameters,
        currentMapRotationCorrection,
      );
      // MapLibre v5: the mercator-space projection matrix is
      // `defaultProjectionData.mainMatrix`. The top-level
      // `modelViewProjectionMatrix` is for pixel-space rendering and has a
      // non-standard w-scale that yields invisible geometry when combined
      // with a mercator-unit model matrix.
      const projectionData = arguments_.defaultProjectionData;
      const mvpRaw = projectionData.mainMatrix;

      const mvp = new THREE.Matrix4().fromArray(mvpRaw);

      const combined = mvp.clone().multiply(modelMatrix);
      if (DEBUG) {
        // Log frame 0, 30 (mid-fly), 90 (after flyTo settles) so we can see
        // the NDC position when the camera is at its final zoom/pitch.
        if ([0, 30, 90].includes(diagnosticFramesLogged)) {
          const origin = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(combined);
          const ndc = {
            x: origin.x / origin.w,
            y: origin.y / origin.w,
            z: origin.z / origin.w,
          };
          console.log("[3d-layer] render frame", diagnosticFramesLogged, {
            zoom: mapReference.getZoom().toFixed(2),
            pitch: mapReference.getPitch().toFixed(0),
            cubeOriginNdc: ndc,
            visible:
              Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && Math.abs(ndc.z) < 1,
          });
        }
        diagnosticFramesLogged += 1;
      }
      camera.projectionMatrix = combined;
      // Wipe MapLibre's depth contribution (terrain, raster overlays, custom
      // layers rendered earlier in the frame) when transparent mode is on, so
      // sub-ground IFC fragments aren't depth-clipped by the terrain mesh.
      // Three.js then writes/reads its own depth as usual, so the IFC remains
      // self-consistent (no z-fighting against itself).
      if (transparentMode) {
        renderer.clearDepth();
      }
      renderer.resetState();
      renderer.render(scene, camera);
      mapReference.triggerRepaint();
    },
  };

  return {
    layer,

    setMeshes(meshes) {
      disposeGroup(modelGroup);
      spaceMeshes.length = 0;
      if (meshes.length === 0) {
        console.warn("[3d-layer] setMeshes: 0 meshes received");
        hasMeshes = false;
        return null;
      }

      // Two passes: first the combined centroid, then per-mesh geometry
      // shifted so that centroid lands at the origin. The caller anchors the
      // scene at this centroid via the Helmert transform.
      const center = computeMeshesCentroid(meshes);
      const alphaHistogram = DEBUG ? new Map<string, number>() : null;
      let totalVertices = 0;
      const bbox = DEBUG ? new THREE.Box3() : null;
      const point = DEBUG ? new THREE.Vector3() : null;

      for (const mesh of meshes) {
        const geometry = createShiftedGeometry(mesh, center);
        const material = createMeshMaterial(mesh);
        const threeMesh = new THREE.Mesh(geometry, material);
        // We overwrite camera.projectionMatrix per-frame with MapLibre's MVP
        // (with the model transform already baked in), which makes Three.js
        // frustum culling unreliable — the derived frustum doesn't match the
        // actual view. Skipping culling is cheap for building-scale scenes.
        threeMesh.frustumCulled = false;
        if (mesh.isSpace) {
          threeMesh.visible = spacesVisible;
          spaceMeshes.push(threeMesh);
        }
        modelGroup.add(threeMesh);
        totalVertices += mesh.positions.length / 3;
        if (alphaHistogram) {
          const alphaBucket = mesh.color[3].toFixed(2);
          alphaHistogram.set(
            alphaBucket,
            (alphaHistogram.get(alphaBucket) ?? 0) + 1,
          );
        }
        if (bbox && point) {
          for (let index = 0; index < mesh.positions.length; index += 3) {
            point.set(
              mesh.positions[index] ?? 0,
              mesh.positions[index + 1] ?? 0,
              mesh.positions[index + 2] ?? 0,
            );
            bbox.expandByPoint(point);
          }
        }
      }

      if (DEBUG && bbox) {
        const size = bbox.getSize(new THREE.Vector3());
        console.log("[3d-layer] setMeshes:", {
          meshCount: meshes.length,
          totalVertices,
          centroid: { x: center.x, y: center.y, z: center.z },
          bboxSize: { x: size.x, y: size.y, z: size.z },
          bboxMin: { x: bbox.min.x, y: bbox.min.y, z: bbox.min.z },
          bboxMax: { x: bbox.max.x, y: bbox.max.y, z: bbox.max.z },
          alphaHistogram: alphaHistogram && Object.fromEntries(alphaHistogram),
          firstMeshSample: meshes[0] && {
            color: meshes[0].color,
            isSpace: meshes[0].isSpace,
            ifcClass: meshes[0].ifcClass,
          },
        });

        // Make the debug cube a fixed fraction of the actual mesh extent so
        // it's visible at the same scale as the building regardless of IFC
        // length unit (mm vs m). 30% of the longest axis = always findable
        // but not so big it occludes the model.
        const cubeSize = Math.max(size.x, size.y, size.z) * 0.3;
        const debugCube = new THREE.Mesh(
          new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize),
          new THREE.MeshBasicMaterial({ color: 0xFF_00_FF, wireframe: true }),
        );
        debugCube.frustumCulled = false;
        modelGroup.add(debugCube);
      }

      hasMeshes = true;
      mapReference?.triggerRepaint();
      return { x: center.x, y: center.y, z: center.z };
    },

    setSpacesVisible(visible) {
      if (spacesVisible === visible) {
        return;
      }
      spacesVisible = visible;
      for (const mesh of spaceMeshes) {
        mesh.visible = visible;
      }
      mapReference?.triggerRepaint();
    },

    setTransparentMode(transparent) {
      if (transparentMode === transparent) {
        return;
      }
      transparentMode = transparent;
      mapReference?.triggerRepaint();
    },

    update(anchor, parameters, mapRotationCorrection) {
      if (DEBUG) {
        console.log("[3d-layer] update:", {
          anchor,
          parameters,
          mapRotationCorrection,
          xScale: parameters.xScale,
          yScale: parameters.yScale,
          zScale: parameters.zScale,
        });
      }
      currentAnchor = anchor;
      currentParameters = parameters;
      currentMapRotationCorrection = mapRotationCorrection;
      mapReference?.triggerRepaint();
    },

    dispose() {
      disposeGroup(modelGroup);
      spaceMeshes.length = 0;
      renderer?.dispose();
      renderer = null;
      mapReference = null;
    },
  };
}
