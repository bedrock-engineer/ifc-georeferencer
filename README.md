# IFC Georeferencer

Georeference an IFC file in your browser. Place the model on a map or
enter your survey points, and download a georeferenced IFC file.

**Your IFC file is never uploaded.** Parsing, georeferencing, and writing
all happen in your browser, and no account is required. (The app does reach
the network for basemaps, address search, and datum-shift grids.)

## What it does

An IFC model's local coordinates (project units from some arbitrary origin on
the construction site) have to be placed in a real-world CRS before the model
can be combined with geodata, planning documents, or other buildings. The IFC
spec defines `IfcMapConversion` and `IfcProjectedCRS` for this; most authoring
tools either don't fill them in or fill them in wrong.

Bridging Geo and BIM today usually takes a specialist and a workflow that
mainstream authoring tools don't support, which makes georeferencing
impractical on small and medium projects. This tool aims to make the step
routine: open a file, place it, save it, with the right IFC entities written
in. It's built for the buildingSMART the Netherlands
[Georefereren IFC](https://www.buildingsmart.nl/projecten/georefereren-ifc)
initiative.

The workflow:

1. **Open** an IFC file. The tool reads whatever georeferencing is already
   there: `IfcSite` lat/lon, `TrueNorth`, an existing `IfcMapConversion`
   (or the IFC4.3 `IfcRigidOperation`), a projected offset baked into the
   site placement, or the IFC2X3 `ePSet_MapConversion` fallback. A
   Level-of-Georeferencing badge (LoGeoRef 10–50) tells you where the file
   stands.
2. **Pick a target CRS** from a searchable index of every projected,
   compound, and vertical EPSG entry, bundled with the app. A separate
   vertical-datum field feeds `IfcProjectedCRS.VerticalDatum`; compound codes
   (e.g. `7415` = RD New + NAP) collapse it into one field.
3. **Anchor the model** one of three ways: set the reference point from
   `IfcSite`, pick a point on the map, or paste surveyed correspondences
   (engineering XYZ ↔ projected XYZ) and solve a Helmert fit. Nudge easting /
   northing / height and rotation by hand; the map updates as you type.
4. **See it in place** the outline on a real basemap with optional overlays, or a 3D preview of your model
   transformed by the current georeferencing parameters.
5. **Save.** The writer rewrites `IfcMapConversion` + `IfcProjectedCRS`
   in-browser and hands you the georeferenced IFC file back as a download.

## Features

- **Survey-point solver.** Paste correspondences from the clipboard (Excel /
  CSV / semicolon-CSV / whitespace) and solve least-squares with
  Levenberg–Marquardt, with per-point residuals on the map and in a histogram.
  Three fit modes: encode the existing `IfcSite` reference alone, refine it
  with extra survey points, or fit points only. A single-point closed form
  covers the case where you have just one known reference.
- **Baked-origin repair.** Detects the two common authoring bugs (a projected
  offset baked into `IfcSite.ObjectPlacement` with no `IfcMapConversion`, and
  the same offset double-counted in both) and migrates or de-duplicates it in
  one click.
- **Precision grids on demand.** CRSs whose default proj4 string is inaccurate
  (e.g. RD New, OSGB36) fetch a GeoTIFF datum-shift grid from cdn.proj.org. The
  Target CRS card shows accuracy state and lets you retry a failed load. The
  CRS index itself ships with the app.
- **Address search.** PDOK Locatieserver autocomplete for NL, Nominatim
  elsewhere, for placing the model when you have no coordinate to anchor to.
- **Maps and overlays.** OpenStreetMap, PDOK topo (BRT) and aerial
  (Luchtfoto), or your own raster XYZ / MapLibre style URL. NL overlays: BGT
  topography, Kadaster parcels, 2D and 3D BAG, and the model's own `IfcSpace`
  boundaries. A 2D ↔ 3D toggle renders the model on the globe.
- **Georeferencing property files.** Export the active CRS, vertical datum, and Helmert
  parameters as a small `.ifcgref.json`, then re-apply it to another file in this app to
  reuse a georeference without manually entry.
- **Demo model.** The MiniBIM model is available so you can try the workflow without a
  file of your own.

## Standards

Follows the two relevant practice guides:

- [Georefereren GeoBIM Praktijkrichtlijn](https://docs.geostandaarden.nl/g4bim/geobim/), Geonovum (NL)
- [User Guide for Geo-referencing in IFC](https://www.buildingsmart.org/wp-content/uploads/2020/02/User-Guide-for-Geo-referencing-in-IFC-v2.0.pdf), buildingSMART Australia

## IFC versions

- **IFC4 / IFC4 ADD1 / IFC4 ADD2 / IFC4.3.** Native `IfcMapConversion`
  - `IfcProjectedCRS` read and write. On IFC4.3 it also reads the
    translation-only `IfcRigidOperation` sibling, and writes
    `IfcMapConversionScaled` when a non-unit vertical scale is needed.
- **IFC2X3.** Falls back to `ePSet_MapConversion` / `ePSet_ProjectedCRS`
  property sets, the convention used before IFC4 added first-class
  georef entities.

## Limitations

- **Datum accuracy outside grid coverage.** We use proj4js with
  GeoTIFF-format datum-shift grids for the CRSs that need them (NL, BE, LUX). Other CRSs use the default proj4 string, which is fine for typical BIM georeferencing (sub-metre) but may lose precision vs. PROJ/pyproj on complex datums. Feel free to open an issue or PR for support for more datum shift grids.
- **No vertical-datum transforms.** Heights round-trip as a single
  `OrthogonalHeight` offset. proj4js can't transform between vertical datums (NAP ↔ ellipsoidal etc.).
- **Large files.** web-ifc runs in a webworker, but opening a multi-GB
  IFC file is still constrained by browser memory.

## Relation to the Flask app

This is a sort of rewrite of the Python/Flask app at
<https://ifcgref.bk.tudelft.nl>, which continues to run. The original
processes files server-side; this version does not upload anything.
The solver logic and IFC version handling are modelled after the Flask
implementation.

## Development

```bash
npm install
npm run dev          # start dev server (rebuilds the CRS index first)
npm run build        # production build
npm run preview      # preview production build
npm run lint         # ESLint
npm run build:crs    # regenerate public/crs-index.json from epsg-index
npm run verify:crs   # check CRS overrides against captured fixtures
npm run knip         # find unused exports
```

### Stack

React 19 + TypeScript + Vite; Tailwind CSS v4; react-aria-components;
[web-ifc](https://github.com/ThatOpen/engine_web-ifc) (WASM) in a Web Worker via [Comlink](https://github.com/googlechromelabs/comlink); [proj4js](https://github.com/proj4js/proj4js) for CRS transforms,
with on-demand GeoTIFF precision grids using [geotiff.js](https://geotiffjs.github.io/); [Zod](https://zod.dev/) for boundary
validation; [ml-levenberg-marquardt](https://github.com/mljs/levenberg-marquardt) for the Helmert solver; [MapLibre GL
JS](https://maplibre.org/maplibre-gl-js/docs/) for the map. Three.js for the 3D view; [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) for 3DTiles from [3D BAG](https://docs.3dbag.nl/en/);
[neverthrow](https://github.com/supermacro/neverthrow) `Result` for error handling.

### Layout

All IFC / CRS / Helmert / units logic lives as pure TypeScript in
`src/modules/` (web-ifc runs in a Web Worker under `modules/ifc/worker`);
React components in `src/components/` call into it via the worker facade and
module barrels. `src/lib/` holds smaller app-level helpers, and `src/state/` holds the shared workspace state.

## Contributing

Contributions welcome, please open an issue before starting anything non-trivial.

## License

Apache License Version 2.0.

## Credits

Developed by [Bedrock.engineer](https://bedrock.engineer) for the
[buildingSMART Nederland](https://www.buildingsmart.nl/) [Georefereren IFC](https://www.buildingsmart.nl/projecten/georefereren-ifc) project.

Inspiration taken from the original [IfcGref app](https://ifcgref.bk.tudelft.nl/) by [Amir Hakim](https://github.com/amiroo4) for the TU Delft 3D Geoinformation research group.
