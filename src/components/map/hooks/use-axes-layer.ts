import maplibregl, { type Map as MlMap, type Marker } from "maplibre-gl";
import { type RefObject, useEffect, useRef } from "react";
import {
  mapRotationCorrection,
  transformProjectedToWgs84,
  type CrsDef,
} from "#modules/crs";
import type { HelmertParams } from "#modules/helmert/solve";
import {
  AXES_LINE_LAYER_ID,
  AXES_SOURCE_ID,
  IFC_X_AXIS_COLOR,
  IFC_Y_AXIS_COLOR,
  NORTH_AXIS_COLOR,
} from "../style";
import { runWhenMapReady } from "./run-when-map-ready";

const AXIS_LENGTH_METRES = 20;

export interface AxesGeometry {
  origin: [number, number];
  xTip: [number, number];
  yTip: [number, number];
  nTip: [number, number];
  rotationDegrees: number;
  /**
   * Grid convergence at the origin: the signed angle (degrees) between grid
   * north (the blue N arrow) and the map's up direction (true north).
   * Positive = grid north leans east of map up, negative = west. Large for
   * oblique projections — which is why the N arrow visibly diverges from
   * screen-up while `rotationDegrees` (measured against grid north) reads a
   * clean value. `0` when the convergence probe fails.
   */
  convergenceDegrees: number;
}

/**
 * Project a 20m-on-the-ground triad of IFC X (east-ish), IFC Y, and grid
 * north from the Helmert origin into WGS84. Length is in CRS units via
 * `metresPerUnit` so foot-based CRS don't render shrunken axes.
 */
export function computeAxesGeometry(
  parameters: HelmertParams | null,
  activeCrs: CrsDef | null,
): AxesGeometry | null {
  if (!parameters || !activeCrs) {
    return null;
  }
  const lengthCrsUnits = AXIS_LENGTH_METRES / activeCrs.metresPerUnit;
  const { easting, northing, rotation } = parameters;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const project = (x: number, y: number): [number, number] | null => {
    const result = transformProjectedToWgs84(activeCrs, x, y);
    if (result.isErr()) {
      return null;
    }
    return [result.value.longitude, result.value.latitude];
  };

  const origin = project(easting, northing);
  const xTip = project(
    easting + lengthCrsUnits * cos,
    northing + lengthCrsUnits * sin,
  );
  const yTip = project(
    easting - lengthCrsUnits * sin,
    northing + lengthCrsUnits * cos,
  );
  const nTip = project(easting, northing + lengthCrsUnits);
  if (!origin || !xTip || !yTip || !nTip) {
    return null;
  }
  // `mapRotationCorrection` returns −γ (the angle added to the model rotation
  // to convert grid north → true north), so the convergence γ itself is its
  // negation.
  const correction = mapRotationCorrection(activeCrs, easting, northing);
  const convergenceDegrees = correction.isOk()
    ? (-correction.value * 180) / Math.PI
    : 0;
  return {
    origin,
    xTip,
    yTip,
    nTip,
    rotationDegrees: (rotation * 180) / Math.PI,
    convergenceDegrees,
  };
}

interface LabelMarkers {
  x: Marker | null;
  y: Marker | null;
  n: Marker | null;
  angle: Marker | null;
}

/**
 * Renders an IFC coordinate-system overlay at the Helmert origin: IFC X
 * (red) and IFC Y (green) axes rotated by the solved rotation, plus a grid-
 * north reference (blue). Labels and the rotation angle are HTML markers
 * since the app's MapLibre style has no glyph URL.
 */
export function useAxesLayer(
  mapRef: RefObject<MlMap | null>,
  geometry: AxesGeometry | null,
): void {
  const markersRef = useRef<LabelMarkers>({
    x: null,
    y: null,
    n: null,
    angle: null,
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    return runWhenMapReady(map, () => {
      syncLines(map, geometry);
      syncLabels(map, markersRef, geometry);
    });
  }, [mapRef, geometry]);

  useEffect(() => {
    const ref = markersRef;
    return () => {
      ref.current.x?.remove();
      ref.current.y?.remove();
      ref.current.n?.remove();
      ref.current.angle?.remove();
      ref.current = { x: null, y: null, n: null, angle: null };
    };
  }, []);
}

function syncLines(map: MlMap, geometry: AxesGeometry | null): void {
  const existing = map.getSource<maplibregl.GeoJSONSource>(AXES_SOURCE_ID);

  if (!geometry) {
    if (existing) {
      if (map.getLayer(AXES_LINE_LAYER_ID)) {
        map.removeLayer(AXES_LINE_LAYER_ID);
      }
      map.removeSource(AXES_SOURCE_ID);
    }
    return;
  }

  const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { role: "ifc-x" },
        geometry: {
          type: "LineString",
          coordinates: [geometry.origin, geometry.xTip],
        },
      },
      {
        type: "Feature",
        properties: { role: "ifc-y" },
        geometry: {
          type: "LineString",
          coordinates: [geometry.origin, geometry.yTip],
        },
      },
      {
        type: "Feature",
        properties: { role: "north" },
        geometry: {
          type: "LineString",
          coordinates: [geometry.origin, geometry.nTip],
        },
      },
    ],
  };

  if (existing) {
    existing.setData(data);
    return;
  }

  map.addSource(AXES_SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: AXES_LINE_LAYER_ID,
    type: "line",
    source: AXES_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": 3,
      "line-color": [
        "match",
        ["get", "role"],
        "ifc-x",
        IFC_X_AXIS_COLOR,
        "ifc-y",
        IFC_Y_AXIS_COLOR,
        "north",
        NORTH_AXIS_COLOR,
        "#000000",
      ],
    },
  });
}

function syncLabels(
  map: MlMap,
  markersRef: RefObject<LabelMarkers>,
  geometry: AxesGeometry | null,
): void {
  if (!geometry) {
    markersRef.current.x?.remove();
    markersRef.current.y?.remove();
    markersRef.current.n?.remove();
    markersRef.current.angle?.remove();
    markersRef.current = { x: null, y: null, n: null, angle: null };
    return;
  }

  markersRef.current.x = upsertLabel(
    map,
    markersRef.current.x,
    "X",
    IFC_X_AXIS_COLOR,
    geometry.xTip,
  );
  markersRef.current.y = upsertLabel(
    map,
    markersRef.current.y,
    "Y",
    IFC_Y_AXIS_COLOR,
    geometry.yTip,
  );
  // The blue N arrow points to grid north, which diverges from map up by the
  // grid convergence. Label that divergence right on the arrow so it doesn't
  // read as a bug, and explain the full relationship on hover.
  const convergence = geometry.convergenceDegrees;
  const hasConvergence = Math.abs(convergence) >= 0.05;
  const convergenceText = hasConvergence
    ? `${Math.abs(convergence).toFixed(1)}°${convergence < 0 ? "W" : "E"}`
    : "";
  markersRef.current.n = upsertLabel(
    map,
    markersRef.current.n,
    hasConvergence ? `N ${convergenceText}` : "N",
    NORTH_AXIS_COLOR,
    geometry.nTip,
    {
      title: hasConvergence
        ? `Grid north — ${convergenceText} from map up (grid convergence).`
        : "Grid north (aligned with map up here).",
    },
  );
  markersRef.current.angle = upsertLabel(
    map,
    markersRef.current.angle,
    `${geometry.rotationDegrees.toFixed(2)}°`,
    "#1f2937",
    geometry.origin,
    {
      offsetY: 18,
      title:
        `Model rotation ${geometry.rotationDegrees.toFixed(2)}° clockwise from grid north.` +
        (hasConvergence
          ? ` Grid north itself is ${convergenceText} of map up (grid convergence), ` +
            `so the blue N arrow won't point straight up.`
          : ""),
    },
  );
}

interface LabelOptions {
  offsetY?: number;
  /** Native hover tooltip. Also makes the label hoverable (pointer-events). */
  title?: string;
}

function upsertLabel(
  map: MlMap,
  current: Marker | null,
  text: string,
  color: string,
  lngLat: [number, number],
  options: LabelOptions = {},
): Marker {
  if (current) {
    const element = current.getElement();
    if (element.textContent !== text) {
      element.textContent = text;
    }
    if (options.title !== undefined && element.title !== options.title) {
      element.title = options.title;
    }
    element.style.color = color;
    element.style.borderColor = color;
    current.setLngLat(lngLat);
    return current;
  }
  const element = document.createElement("div");
  element.textContent = text;
  if (options.title !== undefined) {
    element.title = options.title;
  }
  element.style.cssText = [
    "font: 600 11px/1 system-ui, sans-serif",
    `color: ${color}`,
    "background: rgba(255,255,255,0.92)",
    "padding: 2px 5px",
    "border-radius: 3px",
    `border: 1px solid ${color}`,
    "box-shadow: 0 1px 2px rgba(0,0,0,0.15)",
    // Labels with a tooltip need to receive hover; the rest stay click-through.
    options.title === undefined ? "pointer-events: none" : "cursor: help",
    "white-space: nowrap",
  ].join(";");
  const marker = new maplibregl.Marker({
    element,
    offset: [0, options.offsetY ?? 0],
  })
    .setLngLat(lngLat)
    .addTo(map);
  return marker;
}
