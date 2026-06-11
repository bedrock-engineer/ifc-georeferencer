/* eslint-disable @typescript-eslint/no-explicit-any,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-call,
*/

import {
  Handle,
  IFCIDENTIFIER,
  IFCLABEL,
  IFCLENGTHMEASURE,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCREAL,
  IFCRELDEFINESBYPROPERTIES,
  type IfcAPI,
} from "web-ifc";

import { emitLog } from "#lib/log";
import type { HelmertParams } from "#modules/helmert/solve";
import {
  buildHelmertFromFields,
  expressIDOf,
  findPrimarySiteId,
  rawValue,
  rotationToAxisPair,
} from "../shared";
import {
  absentGeorefRead,
  classifyGeorefRead,
  type GeorefRead,
  type RawProjectedCrs,
} from "./shared";

/**
 * IFC2X3 has no native IfcMapConversion. The community convention is
 * two property sets on IfcSite: ePset_MapConversion holds the 7
 * transform fields, ePset_ProjectedCRS holds the target CRS name. Accept
 * both `ePset_` and `ePSet_` casings — files in the wild use both.
 *
 * Implementation note: we read every rel with `flatten=false` so references
 * stay as cheap Handle objects. Only when RelatedObjects contains the site
 * do we fetch the pset by ID, and only on a name match do we read its
 * properties. Old code used `flatten=true` and recursively materialised
 * every rel's entire subtree — a factor-of-hundreds multiplier vs. the
 * cheap-check-first path below.
 */
export function readGeorefIfc2x3(
  ifcAPI: IfcAPI,
  modelID: number,
  ifcMetresPerUnit: number,
): GeorefRead {
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  if (siteID == null) {
    return absentGeorefRead(null);
  }

  let mapConvID: number | null = null;
  let projectedCrsID: number | null = null;

  for (const { psetID, name } of iterateSitePsets(ifcAPI, modelID, siteID)) {
    if (name === "epset_mapconversion") {
      mapConvID = psetID;
    } else if (name === "epset_projectedcrs") {
      projectedCrsID = psetID;
    }
    if (mapConvID != null && projectedCrsID != null) {
      break;
    }
  }

  const crsProperties =
    projectedCrsID == null
      ? {}
      : readPsetProperties(ifcAPI, modelID, projectedCrsID);
      
  const rawProjectedCrs =
    projectedCrsID == null
      ? null
      : readRawProjectedCrsIfc2x3(crsProperties, ifcMetresPerUnit);

  if (mapConvID == null) {
    return absentGeorefRead(rawProjectedCrs);
  }

  const mcProperties = readPsetProperties(ifcAPI, modelID, mapConvID);
  // ePset_ProjectedCRS has no Name property in some files; fall back to the
  // ePset_MapConversion's TargetCRS so we still surface a hint.
  if (rawProjectedCrs && rawProjectedCrs.name == null) {
    rawProjectedCrs.name = optionalPropertyString(mcProperties.TargetCRS);
  }
  const onDiskScale = optionalPropertyNumber(mcProperties.Scale, 1);
  const onDiskXAbs = optionalPropertyNumber(mcProperties.XAxisAbscissa, 1);
  const onDiskXOrd = optionalPropertyNumber(mcProperties.XAxisOrdinate, 0);
  const onDiskE = optionalPropertyNumber(mcProperties.Eastings, 0);
  const onDiskN = optionalPropertyNumber(mcProperties.Northings, 0);
  const onDiskH = optionalPropertyNumber(mcProperties.OrthogonalHeight, 0);
  // ePset_MapConversion has no MapUnit concept; values are conventionally
  // in the IFC project's length unit. Pass `ifcMetresPerUnit` for both
  // factors so the scale ratio is 1 (on-disk Scale == internal scale).
  const helmert = buildHelmertFromFields(
    {
      scale: onDiskScale,
      xAxisAbscissa: onDiskXAbs,
      xAxisOrdinate: onDiskXOrd,
      eastings: onDiskE,
      northings: onDiskN,
      orthogonalHeight: onDiskH,
    },
    {
      mapUnitMetresPerUnit: ifcMetresPerUnit,
      ifcMetresPerUnit,
    },
  );

  // If the file had only ePset_MapConversion (no ePset_ProjectedCRS), we
  // still need a non-null rawProjectedCrs so `classifyGeorefRead` can
  // surface the targetCrsName hint from MC.TargetCRS.
  const projectedCrs = rawProjectedCrs ?? {
    entityName: "ePset_ProjectedCRS",
    name: optionalPropertyString(mcProperties.TargetCRS),
    description: null,
    geodeticDatum: null,
    verticalDatum: null,
    mapProjection: null,
    mapZone: null,
    mapUnit: null,
    // ePset has no malformed-shift problem; "absent" here means the
    // pset's MapUnit property is missing/blank, and the IFC2X3 reader
    // falls back to project units (not METRE — see source-card label).
    mapUnitStatus: "absent" as const,
    // ePset_MapConversion E/N/H are in project units, so the factor used
    // to reach canonical metres is the project's (Scale round-trips at 1).
    metresPerUnit: ifcMetresPerUnit,
  };

  return classifyGeorefRead({
    helmert,
    rawProjectedCrs: projectedCrs,
    rawMapConversion: {
      entityName: "ePset_MapConversion",
      eastings: onDiskE,
      northings: onDiskN,
      orthogonalHeight: onDiskH,
      scale: onDiskScale,
      xAxisAbscissa: onDiskXAbs,
      xAxisOrdinate: onDiskXOrd,
      factorX: null,
      factorY: null,
      factorZ: null,
      // ePset_MapConversion has no SourceCRS attribute — it's a free-form
      // property set on IfcSite, not the IfcCoordinateOperation entity.
      sourceCrs: null,
    },
  });
}

function readRawProjectedCrsIfc2x3(
  crsProperties: Record<string, unknown>,
  ifcMetresPerUnit: number,
): RawProjectedCrs {
  // ePset_ProjectedCRS mirrors the IFC4 IfcProjectedCRS attributes as
  // free-form properties; readers in the wild may write any subset.
  const mapUnit = optionalPropertyString(crsProperties.MapUnit);
  return {
    entityName: "ePset_ProjectedCRS",
    name: optionalPropertyString(crsProperties.Name),
    description: optionalPropertyString(crsProperties.Description),
    geodeticDatum: optionalPropertyString(crsProperties.GeodeticDatum),
    verticalDatum: optionalPropertyString(crsProperties.VerticalDatum),
    mapProjection: optionalPropertyString(crsProperties.MapProjection),
    mapZone: optionalPropertyString(crsProperties.MapZone),
    mapUnit,
    // ePset has no malformed-shift problem (it's a free-form pset, not
    // an IfcSIUnit entity reference). Only two states: present or absent.
    mapUnitStatus: mapUnit == null ? "absent" : "explicit",
    // The IFC2X3 reader converts ePset E/N/H with the project factor
    // (no MapUnit concept), so that's the factor the UI must pair with.
    metresPerUnit: ifcMetresPerUnit,
  };
}

function optionalPropertyString(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) {
    return null;
  }
  return v;
}

function optionalPropertyNumber(v: unknown, fallback: number): number {
  if (v == null) {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Mirrors `set_mapconversion_crs_ifc2x3` in georeference_ifc/main.py, which
 * goes through ifcopenshell.api's pset helpers. Here we build the entities
 * directly via web-ifc because there is no equivalent high-level API.
 *
 * `parameters` are codebase-canonical (metres + dimensionless scale).
 * ePset_MapConversion has no MapUnit concept; values are conventionally in
 * the IFC project's length unit. We divide `Eastings/Northings/
 * OrthogonalHeight` by `ifcMetresPerUnit` at this boundary, symmetric with
 * the read path (where `buildHelmertFromFields` is called with
 * `mapUnitMetresPerUnit: ifcMetresPerUnit`). `Scale` is dimensionless and
 * round-trips unchanged for IFC2X3 (the source-unit / MapUnit ratio is 1
 * when both sides are the project length unit).
 */
export function writeGeorefIfc2x3(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  ifcMetresPerUnit: number,
): void {
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  if (siteID == null) {
    const message = "No IfcSite found in IFC2X3 model";
    emitLog({ level: "error", source: "worker", message });
    throw new Error(message);
  }

  removeExistingGeorefIfc2x3(ifcAPI, modelID, siteID);

  // Reuse the site's OwnerHistory; don't fabricate a new one.
  const siteRaw = ifcAPI.GetLine(modelID, siteID, false);
  const ownerHistoryHandle = siteRaw.OwnerHistory;

  const crsName = `EPSG:${epsgCode}`;
  const { xAxisAbscissa, xAxisOrdinate } = rotationToAxisPair(
    parameters.rotation,
  );

  const projectedCrsProperties = [
    property(ifcAPI, modelID, "Name", IFCLABEL, crsName),
  ];
  if (verticalDatum && verticalDatum.length > 0) {
    projectedCrsProperties.push(
      property(ifcAPI, modelID, "VerticalDatum", IFCIDENTIFIER, verticalDatum),
    );
  }
  const projectedCrsPset = buildPset(
    ifcAPI,
    modelID,
    "ePset_ProjectedCRS",
    ownerHistoryHandle,
    projectedCrsProperties,
  );
  writePsetRel(ifcAPI, modelID, ownerHistoryHandle, siteID, projectedCrsPset);

  const mapConvPset = buildPset(
    ifcAPI,
    modelID,
    "ePset_MapConversion",
    ownerHistoryHandle,
    [
      property(ifcAPI, modelID, "TargetCRS", IFCLABEL, crsName),
      property(
        ifcAPI,
        modelID,
        "Eastings",
        IFCLENGTHMEASURE,
        parameters.easting / ifcMetresPerUnit,
      ),
      property(
        ifcAPI,
        modelID,
        "Northings",
        IFCLENGTHMEASURE,
        parameters.northing / ifcMetresPerUnit,
      ),
      property(
        ifcAPI,
        modelID,
        "OrthogonalHeight",
        IFCLENGTHMEASURE,
        parameters.height / ifcMetresPerUnit,
      ),
      property(ifcAPI, modelID, "XAxisAbscissa", IFCREAL, xAxisAbscissa),
      property(ifcAPI, modelID, "XAxisOrdinate", IFCREAL, xAxisOrdinate),
      property(ifcAPI, modelID, "Scale", IFCREAL, parameters.xScale),
    ],
  );
  writePsetRel(ifcAPI, modelID, ownerHistoryHandle, siteID, mapConvPset);
}

/**
 * Iterate every IfcRelDefinesByProperties whose RelatedObjects includes the
 * site, yielding the rel ID, pset ID, and lowercased pset name. Shared by
 * the ePSet read path and the ePSet remove path — both need the same
 * cheap-lookup-first traversal.
 */
function* iterateSitePsets(
  ifcAPI: IfcAPI,
  modelID: number,
  siteID: number,
): Generator<{ relID: number; psetID: number; name: string; pset: any }> {
  const relIds = ifcAPI.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (let index = 0; index < relIds.size(); index++) {
    const relID = relIds.get(index);
    const rel = ifcAPI.GetLine(modelID, relID, false);
    const related = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [];
    if (!related.some((o: any) => expressIDOf(o) === siteID)) {
      continue;
    }
    const psetID = expressIDOf(rel.RelatingPropertyDefinition);
    if (psetID == null) {
      continue;
    }
    const pset = ifcAPI.GetLine(modelID, psetID, false);
    const name = String(rawValue(pset?.Name) ?? "").toLowerCase();
    yield { relID, psetID, name, pset };
  }
}

/**
 * Read name/value pairs from an IfcPropertySet by express ID, doing only
 * shallow lookups (one GetLine per IfcPropertySingleValue). The IfcValue
 * wrapped inside NominalValue is inline, so no further flattening is needed.
 */
function readPsetProperties(
  ifcAPI: IfcAPI,
  modelID: number,
  psetID: number,
): Record<string, unknown> {
  const pset = ifcAPI.GetLine(modelID, psetID, false);
  const properties = Array.isArray(pset?.HasProperties)
    ? pset.HasProperties
    : [];
  const out: Record<string, unknown> = {};
  for (const handle of properties) {
    const id = expressIDOf(handle);
    if (id == null) {
      continue;
    }
    const property = ifcAPI.GetLine(modelID, id, false);
    const name = rawValue(property?.Name);
    if (typeof name !== "string") {
      continue;
    }
    out[name] = rawValue(property?.NominalValue);
  }

  return out;
}

/**
 * Delete existing ePset_MapConversion / ePset_ProjectedCRS property sets
 * and their IfcRelDefinesByProperties from an IFC2X3 model so a subsequent
 * write doesn't create duplicates.
 *
 * Deletes the rel, the pset, and every IfcPropertySingleValue inside it.
 */
function removeExistingGeorefIfc2x3(
  ifcAPI: IfcAPI,
  modelID: number,
  siteID: number,
): void {
  for (const { relID, psetID, name, pset } of iterateSitePsets(
    ifcAPI,
    modelID,
    siteID,
  )) {
    if (name !== "epset_mapconversion" && name !== "epset_projectedcrs") {
      continue;
    }
    const properties = pset?.HasProperties;
    if (Array.isArray(properties)) {
      for (const singleValue of properties) {
        const singleValueID = expressIDOf(singleValue);
        if (singleValueID != null) {
          ifcAPI.DeleteLine(modelID, singleValueID);
        }
      }
    }
    ifcAPI.DeleteLine(modelID, psetID);
    ifcAPI.DeleteLine(modelID, relID);
  }
}

function property(
  ifcAPI: IfcAPI,
  modelID: number,
  name: string,
  valueType: number,
  value: number | string,
): any {
  return ifcAPI.CreateIfcEntity(
    modelID,
    IFCPROPERTYSINGLEVALUE,
    ifcAPI.CreateIfcType(modelID, IFCIDENTIFIER, name),
    null,
    ifcAPI.CreateIfcType(modelID, valueType, value),
    null,
  );
}

function buildPset(
  ifcAPI: IfcAPI,
  modelID: number,
  name: string,
  ownerHistory: any,
  properties: Array<any>,
): any {
  return ifcAPI.CreateIfcEntity(
    modelID,
    IFCPROPERTYSET,
    ifcAPI.CreateIFCGloballyUniqueId(modelID),
    ownerHistory,
    ifcAPI.CreateIfcType(modelID, IFCLABEL, name),
    null,
    properties,
  );
}

function writePsetRel(
  ifcAPI: IfcAPI,
  modelID: number,
  ownerHistory: any,
  siteID: number,
  pset: any,
): void {
  const rel = ifcAPI.CreateIfcEntity(
    modelID,
    IFCRELDEFINESBYPROPERTIES,
    ifcAPI.CreateIFCGloballyUniqueId(modelID),
    ownerHistory,
    null,
    null,
    [new Handle(siteID)],
    pset,
  );
  ifcAPI.WriteLine(modelID, rel);
}
