/* eslint-disable @typescript-eslint/no-explicit-any,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
*/

import {
  type IfcAPI,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCPROJECT,
  IFCUNITASSIGNMENT,
} from "web-ifc";
import type { XYZ } from "#modules/helmert/solve";
import { emitLog } from "#lib/log";
import { unitToMetres } from "#modules/units/convert";
import { isValidLatLon } from "#lib/validators";
import { getApi } from "./api";
import {
  type ActiveCoordinateOperation,
  type ExistingGeoref,
  type MapConversionStatus,
  type RawMapConversion,
  type RawProjectedCrs,
  type RawRigidOperation,
  readExistingGeoref,
} from "./georef";
import { type IfcSchema, parseSchema } from "./schema";
import {
  dmsToDecimal,
  expressIDOf,
  findPrimarySiteId,
  firstOf,
  rawValue,
  stringOrNull,
} from "./shared";

/**
 * Verbatim-from-file IfcSite attributes (inherited from IfcRoot /
 * IfcObject / IfcSpatialStructureElement plus IfcSite-specific fields).
 * Same intent as `RawProjectedCrs` / `RawMapConversion`: surface every
 * field for the source-side disclosure so users can audit the entity
 * without re-opening the IFC.
 *
 * Coordinates are boundary-converted at read time:
 * `refLatitude`/`refLongitude` are decimal degrees (dmsToDecimal applied)
 * and `refElevation` is in metres (× ifcMetresPerUnit applied) — matches
 * the rest of the worker boundary discipline.
 */
export interface RawSite {
  entityName: string;
  globalId: string | null;
  name: string | null;
  description: string | null;
  objectType: string | null;
  longName: string | null;
  /**
   * Flattened `IfcSite.ObjectPlacement.RelativePlacement` (an
   * `IfcAxis2Placement3D`). Carries Location (metres), Axis (Z-direction
   * ratios), and RefDirection (X-direction ratios). Surfaced verbatim so
   * the IfcSite section can flag non-default rotation, which composes
   * with IfcMapConversion's `XAxisAbscissa/Ordinate` and is a common
   * source of "model is rotated wrong" bugs.
   */
  placement: RawAxis2Placement | null;
  refLatitude: number | null;
  refLongitude: number | null;
  /** Metres. */
  refElevation: number | null;
  landTitleNumber: string | null;
  address: RawPostalAddress | null;
}

/**
 * Verbatim-from-file IfcGeometricRepresentationContext attributes.
 * Surfaced for the source-side disclosure — same intent as `RawSite` /
 * `RawProjectedCrs` / `RawMapConversion`.
 *
 * `precision` is boundary-converted to metres (× ifcMetresPerUnit).
 * `worldCoordinateSystem.location` is also in metres. Direction ratios
 * (`axis`, `refDirection`, `trueNorth`) are unitless per IFC spec, no
 * conversion.
 */
export interface RawGeometricRepresentationContext {
  entityName: string;
  contextIdentifier: string | null;
  contextType: string | null;
  coordinateSpaceDimension: number | null;
  /** Geometric tolerance, in metres. */
  precision: number | null;
  worldCoordinateSystem: RawAxis2Placement | null;
  /**
   * Same value surfaced at top-level `IfcMetadata.trueNorth`. Duplicated
   * here so the verbatim disclosure is self-contained.
   */
  trueNorth: { abscissa: number; ordinate: number } | null;
}

/** Flattened IfcAxis2Placement (2D or 3D). */
export interface RawAxis2Placement {
  /** Location coordinates in metres. Always 3D; z=0 for IfcAxis2Placement2D. */
  location: { x: number; y: number; z: number } | null;
  /** Z-axis direction ratios. Null on 2D placements. */
  axis: [number, number, number] | null;
  /** X-axis direction ratios (3D) or 2D ref direction (z=0). */
  refDirection: [number, number, number] | null;
}

/** Flattened IfcPostalAddress. */
export interface RawPostalAddress {
  purpose: string | null;
  description: string | null;
  userDefinedPurpose: string | null;
  internalLocation: string | null;
  addressLines: Array<string> | null;
  postalBox: string | null;
  town: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface IfcMetadata {
  schema: IfcSchema;
  /** Set if the IfcSite has RefLatitude/RefLongitude */
  siteReference: {
    latitude: number;
    longitude: number;
    elevation: number;
  } | null;
  /** Verbatim-from-file IfcSite attributes (all fields). */
  rawSite: RawSite | null;
  /** Local origin from IfcSite.ObjectPlacement.RelativePlacement */
  localOrigin: XYZ | null;
  /** Length unit name from IfcUnitAssignment, e.g. "METRE", "MILLIMETRE" */
  lengthUnit: string;
  /**
   * Resolved metres-per-IFC-unit factor — the canonical conversion ratio
   * computed once at the worker boundary so render-side code (survey card
   * display, solver entry) doesn't re-look it up. Falls back to 1 for
   * unknown units; the worker emits a `warn` log in that case so the user
   * sees that downstream values are unconvertible.
   */
  metresPerUnit: number;
  /** TrueNorth direction (XAxisOrdinate, XAxisAbscissa) if present */
  trueNorth: { abscissa: number; ordinate: number } | null;
  /** Verbatim-from-file IfcGeometricRepresentationContext attributes. */
  rawGeometricRepresentationContext: RawGeometricRepresentationContext | null;
  /** Existing georeferencing if the file is already georeferenced */
  existingGeoref: ExistingGeoref | null;
  /** See GeorefRead.targetCrsHint. */
  targetCrsHint: string | null;
  /** See GeorefRead.verticalDatumHint. */
  verticalDatumHint: string | null;
  /** Verbatim-from-file IfcProjectedCRS / ePSet_ProjectedCRS attributes. */
  rawProjectedCrs: RawProjectedCrs | null;
  /** Verbatim-from-file IfcMapConversion / ePSet_MapConversion fields. */
  rawMapConversion: RawMapConversion | null;
  mapConversionStatus: MapConversionStatus;
  /** Verbatim-from-file IfcRigidOperation fields (IFC 4.3+ only). */
  rawRigidOperation: RawRigidOperation | null;
  /** Which IfcCoordinateOperation subtype drove `existingGeoref`. */
  activeCoordinateOperation: ActiveCoordinateOperation;
}

/**
 * Worker-side unit boundary. The codebase-wide canonical is metres (see
 * `modules/helmert/solve.ts`); every IfcLengthMeasure-typed value read by this module
 * is multiplied by this factor exactly once, here. The inverse multiplier
 * is applied symmetrically by the write path (`writeMapConversion`).
 * Unknown units fall back to 1.
 */
export function deriveIfcMetresPerUnit(
  ifcAPI: IfcAPI,
  modelID: number,
): number {
  const project = firstOf(ifcAPI, modelID, IFCPROJECT);
  const lengthUnit = readLengthUnit(ifcAPI, modelID, project);
  const result = unitToMetres(lengthUnit);
  return result.isOk() ? result.value : 1;
}

export async function readMetadata(modelID: number): Promise<IfcMetadata> {
  const ifcAPI = await getApi();
  const schema = parseSchema(ifcAPI.GetModelSchema(modelID));

  const site = readSiteEntity(ifcAPI, modelID);
  const project = firstOf(ifcAPI, modelID, IFCPROJECT);
  const lengthUnit = readLengthUnit(ifcAPI, modelID, project);
  const lengthUnitMetres = unitToMetres(lengthUnit);
  const ifcMetresPerUnit = lengthUnitMetres.isOk() ? lengthUnitMetres.value : 1;
  if (lengthUnitMetres.isErr()) {
    emitLog({
      level: "warn",
      source: "worker",
      message:
        `Unknown IFC length unit '${lengthUnitMetres.error.name}' — ` +
        `treated as metres at the worker boundary; numeric values may be ` +
        `off by the unit factor`,
    });
  }

  // Read context first so the georef reader can use TrueNorth as the
  // rotation seed for the IfcRigidOperation fallback path (4.3 only).
  const context = findGeometricContext(ifcAPI, modelID, project);
  const trueNorth = readTrueNorth(context);
  const trueNorthRotation = trueNorth
    ? Math.atan2(trueNorth.abscissa, trueNorth.ordinate)
    : 0;
  const georef = readExistingGeoref(
    ifcAPI,
    modelID,
    schema,
    ifcMetresPerUnit,
    trueNorthRotation,
  );
  const metadata: IfcMetadata = {
    schema,
    siteReference: readSiteReference(site, ifcMetresPerUnit),
    rawSite: readRawSite(site, ifcMetresPerUnit),
    localOrigin: readLocalOrigin(site, ifcMetresPerUnit),
    lengthUnit,
    metresPerUnit: ifcMetresPerUnit,
    trueNorth,
    rawGeometricRepresentationContext: readRawGeometricRepresentationContext(
      context,
      ifcMetresPerUnit,
    ),
    existingGeoref: georef.existingGeoref,
    targetCrsHint: georef.targetCrsHint,
    verticalDatumHint: georef.verticalDatumHint,
    rawProjectedCrs: georef.rawProjectedCrs,
    rawMapConversion: georef.rawMapConversion,
    mapConversionStatus: georef.mapConversionStatus,
    rawRigidOperation: georef.rawRigidOperation,
    activeCoordinateOperation: georef.activeCoordinateOperation,
  };

  emitLog({
    source: "worker",
    message: `Read metadata: ${metadata.schema}, unit=${metadata.lengthUnit}${
      metadata.siteReference
        ? `, IfcSite ref=${metadata.siteReference.latitude.toFixed(6)},${metadata.siteReference.longitude.toFixed(6)}`
        : ""
    }`,
  });

  return metadata;
}

/**
 * Read the primary IfcSite without flattening its geometric Representation.
 */
function readSiteEntity(ifcAPI: IfcAPI, modelID: number): any {
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  if (siteID == null) {
    return null;
  }
  const site = ifcAPI.GetLine(modelID, siteID, false);
  if (!site) {
    return null;
  }
  site.ObjectPlacement = flattenReference(
    ifcAPI,
    modelID,
    site.ObjectPlacement,
  );
  site.SiteAddress = flattenReference(ifcAPI, modelID, site.SiteAddress);
  return site;
}

/**
 * Resolve a single Handle attribute to its flattened entity, leaving the
 * attribute null when it's absent or unresolvable. Lets `readSiteEntity`
 * expand the specific sub-references it needs without a full-site
 * GetLine(flatten=true) — keeping the downstream readers' nested-object
 * access (`placement.RelativePlacement.Location`, `address.Town`) working.
 */
function flattenReference(ifcAPI: IfcAPI, modelID: number, ref: any): any {
  const id = expressIDOf(ref);
  if (id == null) {
    return null;
  }
  try {
    return ifcAPI.GetLine(modelID, id, true);
  } catch {
    return null;
  }
}

function readSiteReference(
  site: any,
  ifcMetresPerUnit: number,
): { latitude: number; longitude: number; elevation: number } | null {
  if (!site) {
    return null;
  }

  const lat = dmsToDecimal(site.RefLatitude);
  const lon = dmsToDecimal(site.RefLongitude);
  if (lat == null || lon == null || !isValidLatLon({ lat, lon })) {
    return null;
  }
  const elev = Number(rawValue(site.RefElevation) ?? 0) * ifcMetresPerUnit;
  return { latitude: lat, longitude: lon, elevation: elev };
}

function readRawSite(site: any, ifcMetresPerUnit: number): RawSite | null {
  if (!site) {
    return null;
  }
  const lat = dmsToDecimal(site.RefLatitude);
  const lon = dmsToDecimal(site.RefLongitude);
  const elev = rawValue(site.RefElevation);
  return {
    entityName: "IfcSite",
    globalId: stringOrNull(site.GlobalId),
    name: stringOrNull(site.Name),
    description: stringOrNull(site.Description),
    objectType: stringOrNull(site.ObjectType),
    longName: stringOrNull(site.LongName),
    placement: readAxis2Placement(
      site.ObjectPlacement?.RelativePlacement,
      ifcMetresPerUnit,
    ),
    refLatitude: lat,
    refLongitude: lon,
    refElevation: elev == null ? null : Number(elev) * ifcMetresPerUnit,
    landTitleNumber: stringOrNull(site.LandTitleNumber),
    address: readPostalAddress(site.SiteAddress),
  };
}

function readPostalAddress(address: any): RawPostalAddress | null {
  if (!address) {
    return null;
  }
  const lines = rawValue(address.AddressLines);
  const addressLines = Array.isArray(lines)
    ? lines.map((l) => String(rawValue(l) ?? "")).filter((s) => s.length > 0)
    : null;
  return {
    purpose: stringOrNull(address.Purpose),
    description: stringOrNull(address.Description),
    userDefinedPurpose: stringOrNull(address.UserDefinedPurpose),
    internalLocation: stringOrNull(address.InternalLocation),
    addressLines: addressLines && addressLines.length > 0 ? addressLines : null,
    postalBox: stringOrNull(address.PostalBox),
    town: stringOrNull(address.Town),
    region: stringOrNull(address.Region),
    postalCode: stringOrNull(address.PostalCode),
    country: stringOrNull(address.Country),
  };
}

function readLocalOrigin(site: any, ifcMetresPerUnit: number): XYZ | null {
  if (!site) {
    return null;
  }
  const placement = site.ObjectPlacement;
  if (!placement) {
    return null;
  }
  const rel = placement.RelativePlacement;
  const coords: Array<any> | undefined = rel?.Location?.Coordinates;
  if (!Array.isArray(coords) || coords.length < 3) {
    return null;
  }
  return {
    x: Number(rawValue(coords[0])) * ifcMetresPerUnit,
    y: Number(rawValue(coords[1])) * ifcMetresPerUnit,
    z: Number(rawValue(coords[2])) * ifcMetresPerUnit,
  };
}

function readLengthUnit(ifcAPI: IfcAPI, modelID: number, project: any): string {
  // Prefer IfcProject.UnitsInContext, fall back to any IfcUnitAssignment.
  const assignment =
    project?.UnitsInContext ?? firstOf(ifcAPI, modelID, IFCUNITASSIGNMENT);
  if (!assignment?.Units) {
    return "METRE";
  }
  for (const unit of assignment.Units) {
    // UnitType is also enum-wrapped in newer web-ifc versions, so unwrap
    // before comparing — otherwise `{type, value: "LENGTHUNIT"} !== "LENGTHUNIT"`
    // skips every unit and we fall through to the METRE fallback.
    if (rawValue(unit?.UnitType) !== "LENGTHUNIT") {
      continue;
    }
    // IfcSIUnit: combine optional Prefix + Name -> e.g. MILLI + METRE -> MILLIMETRE.
    // web-ifc wraps enums as `{type, value}` — without rawValue we'd get
    // `[object Object][object Object]` and fall through to METRE.
    if (unit.Name) {
      const prefix = rawValue(unit.Prefix) ?? "";
      const name = rawValue(unit.Name) ?? "";
      return `${String(prefix)}${String(name)}`;
    }
    // IfcConversionBasedUnit: use Name directly.
    const name = rawValue(unit.Name);
    if (typeof name === "string") {
      return name;
    }
  }
  return "METRE";
}

/**
 * Pick the IfcGeometricRepresentationContext we treat as authoritative.
 * Walks `IfcProject.RepresentationContexts` and prefers a context that
 * already carries TrueNorth (matches the previous reader's behaviour);
 * falls back to the first IfcGeometricRepresentationContext otherwise.
 * Both the top-level `metadata.trueNorth` and the verbatim
 * `rawGeometricRepresentationContext` disclosure read from this single
 * picked entity, so the UI's TrueNorth and "which context did we read?"
 * stay consistent.
 */
function findGeometricContext(
  ifcAPI: IfcAPI,
  modelID: number,
  project: any,
): any {
  const contexts: Array<any> | undefined = project?.RepresentationContexts;
  if (Array.isArray(contexts)) {
    for (const context of contexts) {
      if (context?.TrueNorth) {
        return context;
      }
    }
  }
  return firstOf(ifcAPI, modelID, IFCGEOMETRICREPRESENTATIONCONTEXT);
}

function readTrueNorth(
  context: any,
): { abscissa: number; ordinate: number } | null {
  const ratios: Array<any> | undefined = context?.TrueNorth?.DirectionRatios;
  if (!Array.isArray(ratios) || ratios.length < 2) {
    return null;
  }
  return {
    abscissa: Number(rawValue(ratios[0])),
    ordinate: Number(rawValue(ratios[1])),
  };
}

function readRawGeometricRepresentationContext(
  context: any,
  ifcMetresPerUnit: number,
): RawGeometricRepresentationContext | null {
  if (!context) {
    return null;
  }
  const dim = rawValue(context.CoordinateSpaceDimension);
  const precision = rawValue(context.Precision);
  return {
    entityName: "IfcGeometricRepresentationContext",
    contextIdentifier: stringOrNull(context.ContextIdentifier),
    contextType: stringOrNull(context.ContextType),
    coordinateSpaceDimension: dim == null ? null : Number(dim),
    precision: precision == null ? null : Number(precision) * ifcMetresPerUnit,
    worldCoordinateSystem: readAxis2Placement(
      context.WorldCoordinateSystem,
      ifcMetresPerUnit,
    ),
    trueNorth: readTrueNorth(context),
  };
}

function readAxis2Placement(
  placement: any,
  ifcMetresPerUnit: number,
): RawAxis2Placement | null {
  if (!placement) {
    return null;
  }
  const coords: Array<any> | undefined = placement.Location?.Coordinates;
  const location =
    Array.isArray(coords) && coords.length >= 2
      ? {
          x: Number(rawValue(coords[0])) * ifcMetresPerUnit,
          y: Number(rawValue(coords[1])) * ifcMetresPerUnit,
          z:
            coords.length >= 3
              ? Number(rawValue(coords[2])) * ifcMetresPerUnit
              : 0,
        }
      : null;
  return {
    location,
    axis: readDirectionRatios3(placement.Axis),
    refDirection: readDirectionRatios3(placement.RefDirection),
  };
}

function readDirectionRatios3(direction: any): [number, number, number] | null {
  const ratios: Array<any> | undefined = direction?.DirectionRatios;
  if (!Array.isArray(ratios) || ratios.length < 2) {
    return null;
  }
  return [
    Number(rawValue(ratios[0])),
    Number(rawValue(ratios[1])),
    ratios.length >= 3 ? Number(rawValue(ratios[2])) : 0,
  ];
}
