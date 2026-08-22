/**
 * Global (non-country) basemaps + terrain. OSM tiles are a fallback
 * basemap for anywhere outside Dutch PDOK coverage; Mapterhorn is the
 * global Terrarium-encoded DEM driving terrain drape + elevation queries.
 */

import type { SourceSpecification } from "maplibre-gl";
import type { BasemapDef } from "./types";

export const OSM: BasemapDef = {
  id: "osm",
  label: "OpenStreetMap",
  region: "global",
  source: {
    type: "raster",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    maxzoom: 19,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  layer: { id: "osm", type: "raster", source: "osm" },
};

export const OPENTOPOMAP: BasemapDef = {
  id: "opentopomap",
  label: "OpenTopoMap",
  region: "global",
  source: {
    type: "raster",
    tiles: [
      "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
      "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
      "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
    ],
    tileSize: 256,
    maxzoom: 17,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | map style © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
  },
  layer: { id: "opentopomap", type: "raster", source: "opentopomap" },
};

export const MAPTERHORN_SOURCE_ID = "mapterhorn";

export const MAPTERHORN_TERRAIN: SourceSpecification = {
  type: "raster-dem",
  tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
  tileSize: 512,
  encoding: "terrarium",
  maxzoom: 14,
  attribution:
    '© <a href="https://mapterhorn.com/">Mapterhorn</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)',
};
