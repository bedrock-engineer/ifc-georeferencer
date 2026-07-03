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
  findProjectId,
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
 * IFC2X3 has no native IfcMapConversion. The bSI Geo-referencing User
 * Guide v2.0 backports IFC4 as two property sets on IfcProject:
 * ePSet_MapConversion holds the 7 transform fields, ePSet_ProjectedCRS
 * holds the target CRS name. The guide's casing is `ePSet_`, which is
 * what the writer emits; files in the wild also use `ePset_`, so the
 * reader matches pset names case-insensitively.
 * Older tools, like IfcGref and earlier versions of
 * this tool, attached the psets to IfcSite instead; read both hosts,
 * preferring IfcProject when a pset exists on each.
 *
 * Implementation note: we read every rel with `flatten=false` so references
 * stay as cheap Handle objects. Only when RelatedObjects contains a host
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
  const projectID = findProjectId(ifcAPI, modelID);
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  const hostIDs = [projectID, siteID].filter((id) => id != null);
  if (hostIDs.length === 0) {
    return absentGeorefRead(null);
  }

  let mapConvID: number | null = null;
  let mapConvOnProject = false;
  let projectedCrsID: number | null = null;
  let projectedCrsOnProject = false;

  for (const { psetID, name, hostID } of iterateHostPsets(
    ifcAPI,
    modelID,
    hostIDs,
  )) {
    const onProject = hostID === projectID;
    if (
      name === "epset_mapconversion" &&
      (mapConvID == null || (onProject && !mapConvOnProject))
    ) {
      mapConvID = psetID;
      mapConvOnProject = onProject;
    } else if (
      name === "epset_projectedcrs" &&
      (projectedCrsID == null || (onProject && !projectedCrsOnProject))
    ) {
      projectedCrsID = psetID;
      projectedCrsOnProject = onProject;
    }
    if (mapConvOnProject && projectedCrsOnProject) {
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
  // ePSet_ProjectedCRS has no Name property in some files; fall back to the
  // ePSet_MapConversion's TargetCRS so we still surface a hint.
  if (rawProjectedCrs && rawProjectedCrs.name == null) {
    rawProjectedCrs.name = optionalPropertyString(mcProperties.TargetCRS);
  }
  const onDiskScale = optionalPropertyNumber(mcProperties.Scale, 1);
  const onDiskXAbs = optionalPropertyNumber(mcProperties.XAxisAbscissa, 1);
  const onDiskXOrd = optionalPropertyNumber(mcProperties.XAxisOrdinate, 0);
  const onDiskE = optionalPropertyNumber(mcProperties.Eastings, 0);
  const onDiskN = optionalPropertyNumber(mcProperties.Northings, 0);
  const onDiskH = optionalPropertyNumber(mcProperties.OrthogonalHeight, 0);
  // ePSet_MapConversion has no MapUnit concept; values are conventionally
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

  // If the file had only ePSet_MapConversion (no ePSet_ProjectedCRS), we
  // still need a non-null rawProjectedCrs so `classifyGeorefRead` can
  // surface the targetCrsName hint from MC.TargetCRS.
  const projectedCrs = rawProjectedCrs ?? {
    entityName: "ePSet_ProjectedCRS",
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
    // ePSet_MapConversion E/N/H are in project units, so the factor used
    // to reach canonical metres is the project's (Scale round-trips at 1).
    metresPerUnit: ifcMetresPerUnit,
  };

  return classifyGeorefRead({
    helmert,
    rawProjectedCrs: projectedCrs,
    rawMapConversion: {
      entityName: "ePSet_MapConversion",
      eastings: onDiskE,
      northings: onDiskN,
      orthogonalHeight: onDiskH,
      scale: onDiskScale,
      xAxisAbscissa: onDiskXAbs,
      xAxisOrdinate: onDiskXOrd,
      factorX: null,
      factorY: null,
      factorZ: null,
      // ePSet_MapConversion has no SourceCRS attribute — it's a free-form
      // property set on IfcProject, not the IfcCoordinateOperation entity.
      sourceCrs: null,
    },
  });
}

function readRawProjectedCrsIfc2x3(
  crsProperties: Record<string, unknown>,
  ifcMetresPerUnit: number,
): RawProjectedCrs {
  // ePSet_ProjectedCRS mirrors the IFC4 IfcProjectedCRS attributes as
  // free-form properties; readers in the wild may write any subset.
  const mapUnit = optionalPropertyString(crsProperties.MapUnit);
  return {
    entityName: "ePSet_ProjectedCRS",
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
 * ePSet_MapConversion has no MapUnit concept; values are conventionally in
 * the IFC project's length unit. We divide `Eastings/Northings/
 * OrthogonalHeight` by `ifcMetresPerUnit` at this boundary, symmetric with
 * the read path (where `buildHelmertFromFields` is called with
 * `mapUnitMetresPerUnit: ifcMetresPerUnit`). `Scale` is dimensionless and
 * round-trips unchanged for IFC2X3 (the source-unit / MapUnit ratio is 1
 * when both sides are the project length unit).
 *
 * The psets attach to IfcProject, per the bSI Geo-referencing User Guide
 * v2.0 ("for the IFC2x3 implementation the ePSets are linked to
 * ifcProject as the geo-referencing specification applies to the entire
 * project"). Any pre-existing psets on IfcSite (the older convention)
 * are removed so the file doesn't carry two competing georefs.
 */
export function writeGeorefIfc2x3(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  ifcMetresPerUnit: number,
): void {
  const projectID = findProjectId(ifcAPI, modelID);
  if (projectID == null) {
    const message = "No IfcProject found in IFC2X3 model";
    emitLog({ level: "error", source: "worker", message });
    throw new Error(message);
  }

  removeExistingGeorefIfc2x3(ifcAPI, modelID, projectID);

  // Reuse the project's OwnerHistory; don't fabricate a new one.
  const projectRaw = ifcAPI.GetLine(modelID, projectID, false);
  const ownerHistoryHandle = projectRaw.OwnerHistory;

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
    "ePSet_ProjectedCRS",
    ownerHistoryHandle,
    projectedCrsProperties,
  );
  writePsetRel(
    ifcAPI,
    modelID,
    ownerHistoryHandle,
    projectID,
    projectedCrsPset,
  );

  const mapConvPset = buildPset(
    ifcAPI,
    modelID,
    "ePSet_MapConversion",
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
  writePsetRel(ifcAPI, modelID, ownerHistoryHandle, projectID, mapConvPset);
}

/**
 * Iterate every IfcRelDefinesByProperties whose RelatedObjects includes one
 * of the hosts, yielding the rel ID, pset ID, lowercased pset name, and the
 * matched host ID. Shared by the ePSet read path and the ePSet remove path —
 * both need the same cheap-lookup-first traversal.
 */
function* iterateHostPsets(
  ifcAPI: IfcAPI,
  modelID: number,
  hostIDs: ReadonlyArray<number>,
): Generator<{
  relID: number;
  psetID: number;
  name: string;
  pset: any;
  hostID: number;
}> {
  const relIds = ifcAPI.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (let index = 0; index < relIds.size(); index++) {
    const relID = relIds.get(index);
    const rel = ifcAPI.GetLine(modelID, relID, false);
    const related = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [];
    const hostID = hostIDs.find((id) =>
      related.some((o: any) => expressIDOf(o) === id),
    );
    if (hostID == null) {
      continue;
    }
    const psetID = expressIDOf(rel.RelatingPropertyDefinition);
    if (psetID == null) {
      continue;
    }
    const pset = ifcAPI.GetLine(modelID, psetID, false);
    const name = String(rawValue(pset?.Name) ?? "").toLowerCase();
    yield { relID, psetID, name, pset, hostID };
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
 * Delete existing ePSet_MapConversion / ePSet_ProjectedCRS property sets
 * and their IfcRelDefinesByProperties from an IFC2X3 model so a subsequent
 * write doesn't create duplicates. Sweeps both IfcProject (where we write)
 * and IfcSite (the older convention this tool and others used), so a
 * rewrite migrates legacy site-attached psets to the project.
 *
 * Deletes the rel, the pset, and every IfcPropertySingleValue inside it.
 */
function removeExistingGeorefIfc2x3(
  ifcAPI: IfcAPI,
  modelID: number,
  projectID: number,
): void {
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  const hostIDs = siteID == null ? [projectID] : [projectID, siteID];
  for (const { relID, psetID, name, pset } of iterateHostPsets(
    ifcAPI,
    modelID,
    hostIDs,
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
  hostID: number,
  pset: any,
): void {
  const rel = ifcAPI.CreateIfcEntity(
    modelID,
    IFCRELDEFINESBYPROPERTIES,
    ifcAPI.CreateIFCGloballyUniqueId(modelID),
    ownerHistory,
    null,
    null,
    [new Handle(hostID)],
    pset,
  );
  ifcAPI.WriteLine(modelID, rel);
}
