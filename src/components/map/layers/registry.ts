/**
 * Flat registry consumed by `style.ts`, `LayersPanel`, and
 * `useMapLayers`. The order of `BASEMAPS` sets the default (first entry
 * is visible at startup). Reorder or push onto these arrays to add new
 * countries / providers
 */

import {
  MAPTERHORN_SOURCE_ID,
  MAPTERHORN_TERRAIN,
  OPENTOPOMAP,
  OSM,
} from "./global";
import {
  BAG_3D,
  PDOK_BAG_2D,
  PDOK_BGT,
  PDOK_BRT,
  PDOK_KADASTER,
  PDOK_LUCHTFOTO,
} from "./nl-pdok";
import type { BasemapDef, OverlayDef } from "./types";

export const BASEMAPS: ReadonlyArray<BasemapDef> = [
  OSM,
  OPENTOPOMAP,
  PDOK_BRT,
  PDOK_LUCHTFOTO,
];

export const OVERLAYS: ReadonlyArray<OverlayDef> = [
  PDOK_BGT,
  PDOK_KADASTER,
  PDOK_BAG_2D,
  BAG_3D,
];

export const TERRAIN = {
  sourceId: MAPTERHORN_SOURCE_ID,
  source: MAPTERHORN_TERRAIN,
} as const;

export type BasemapId = string;
export type OverlayId = string;

export const DEFAULT_BASEMAP_ID: BasemapId = BASEMAPS[0]?.id ?? "osm";

export const INITIAL_OVERLAYS: Record<OverlayId, boolean> = Object.fromEntries(
  OVERLAYS.map((o) => [o.id, false]),
);
