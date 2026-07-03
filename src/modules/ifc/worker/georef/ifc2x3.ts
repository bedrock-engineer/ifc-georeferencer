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
  IFCSIUNIT,
  type IfcAPI,
} from "web-ifc";

import { emitLog } from "#lib/log";
import type { HelmertParams } from "#modules/helmert/solve";
import {
  lengthUnitNameForMetres,
  snapToKnownUnitFactor,
  unitToMetres,
} from "#modules/units/convert";
import {
  buildHelmertFromFields,
  expressIDOf,
  findPrimarySiteId,
  findProjectId,
  mapConversionUnitFactor,
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

  // The bSI ePset backport defines no unit mechanism, and two E/N/H
  // conventions exist in the wild: CRS axis units with Scale as the unit
  // bridge (IfcGref, this tool since the CRS-axis-unit fix) vs. project
  // units with a bare geometric Scale (older versions of this tool).
  // Resolve which one this file uses; see `resolveEpsetLengthUnit`.
  const epsetUnit = resolveEpsetLengthUnit({
    crsMapUnitLabel: rawProjectedCrs?.mapUnit ?? null,
    onDiskScale,
    ifcMetresPerUnit,
  });
  if (epsetUnit.status === "recovered-from-scale") {
    emitLog({
      source: "worker",
      message: `ePSet_MapConversion carries no unit declaration — inferred ${epsetUnit.unitName ?? epsetUnit.metresPerUnit} for Eastings/Northings/OrthogonalHeight from Scale=${onDiskScale}`,
    });
  }

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
      mapUnitMetresPerUnit: epsetUnit.metresPerUnit,
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
    mapUnitStatus: "absent" as const,
    metresPerUnit: ifcMetresPerUnit,
  };
  // The resolution above is the source of truth for how E/N/H were
  // decoded — override whatever the pset-only pre-read put here so the
  // UI's factor pairing (source-card unit row, rotation-card written-
  // scale note) matches the conversion actually applied.
  projectedCrs.metresPerUnit = epsetUnit.metresPerUnit;
  projectedCrs.mapUnitStatus = epsetUnit.status;
  if (projectedCrs.mapUnit == null && epsetUnit.unitName != null) {
    projectedCrs.mapUnit = epsetUnit.unitName;
  }

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
  // free-form properties; readers in the wild may write any subset. The
  // guide's Table 4 defines no MapUnit property, but this tool writes one
  // (mirroring IFC4) and other files may carry it too.
  const mapUnit = optionalPropertyString(crsProperties.MapUnit);
  const mapUnitMetres = mapUnit == null ? null : unitToMetres(mapUnit);
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
    // Provisional factor for the MapConversion-absent case (nothing to
    // decode then; the UI still shows the unit row). When a MapConversion
    // exists, `resolveEpsetLengthUnit` overrides this with the factor E/N/H
    // were actually decoded with.
    metresPerUnit: mapUnitMetres?.isOk()
      ? mapUnitMetres.value
      : ifcMetresPerUnit,
  };
}

/**
 * Which unit ePSet_MapConversion's Eastings/Northings/OrthogonalHeight are
 * in. The bSI guide defines the ePsets with no unit mechanism at all (its
 * ePSet_ProjectedCRS has no MapUnit property; the whole guide assumes
 * metres throughout), so files in the wild follow one of two conventions:
 *
 *  - **CRS axis units**, Scale = geometric × project-unit/CRS-unit ratio
 *    (IfcGref, this tool since the CRS-axis-unit fix) — the IFC4
 *    IfcMapConversion semantic;
 *  - **project units**, Scale = bare geometric (older versions of this
 *    tool, geo.buildingsmart.nl deployments before the fix).
 *
 * Resolution order:
 *  1. The `MapUnit` property on ePSet_ProjectedCRS — off-guide but
 *     explicit in-file data (this tool writes it; so may others).
 *  2. Invert the on-disk Scale (`ifcMetresPerUnit / Scale`) and snap to
 *     the known-unit table. Snapping is what makes this safe: a solved
 *     geometric scale ≠ 1 perturbs the raw quotient (0.0009998 instead of
 *     0.001) and would silently shift Eastings by metres if used raw —
 *     see `snapToKnownUnitFactor`. A snap that lands on the project unit
 *     IS the legacy convention, reported as the project-unit fallback.
 *  3. Project units — the pre-fix assumption, kept as the terminal
 *     fallback so legacy files keep reading identically.
 *
 * The writer also stamps `IfcPropertySingleValue.Unit` on the three
 * length properties (the schema-blessed declaration, for third-party
 * consumers); the reader deliberately does NOT check it — every file
 * that carries it also carries the MapUnit property and a snappable
 * Scale, so reading it back would be dead redundancy today. Add a
 * Unit-attribute step here if Unit-only files ever show up.
 */
function resolveEpsetLengthUnit(arguments_: {
  crsMapUnitLabel: string | null;
  onDiskScale: number;
  ifcMetresPerUnit: number;
}): {
  metresPerUnit: number;
  status: RawProjectedCrs["mapUnitStatus"];
  unitName: string | null;
} {
  const { crsMapUnitLabel, onDiskScale, ifcMetresPerUnit } = arguments_;

  if (crsMapUnitLabel != null) {
    const metres = unitToMetres(crsMapUnitLabel);
    if (metres.isOk()) {
      return {
        metresPerUnit: metres.value,
        status: "explicit",
        unitName: crsMapUnitLabel,
      };
    }
    emitLog({
      level: "warn",
      source: "worker",
      message: `ePSet_ProjectedCRS.MapUnit "${crsMapUnitLabel}" not recognised — falling back to Scale inversion for Eastings/Northings units`,
    });
  }

  const snapped = snapToKnownUnitFactor(ifcMetresPerUnit / onDiskScale);
  if (snapped != null && snapped !== ifcMetresPerUnit) {
    return {
      metresPerUnit: snapped,
      status: "recovered-from-scale",
      unitName: lengthUnitNameForMetres(snapped),
    };
  }
  return {
    metresPerUnit: ifcMetresPerUnit,
    status: "absent",
    unitName: null,
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
 * Eastings/Northings/OrthogonalHeight are written in the **target CRS's
 * axis unit** (`crsMetresPerUnit`, metres for essentially every real CRS),
 * NOT the IFC project's length unit: the values are coordinates *in the
 * TargetCRS*, and 185542000 is not an EPSG:7415 coordinate in any unit
 * that CRS defines. `Scale` carries the bridge, per the IFC4
 * IfcMapConversion semantic the ePsets backport:
 *
 *     Scale = geometric scale × ifcMetresPerUnit / crsMetresPerUnit
 *
 * (an mm project on a metre CRS writes Scale=0.001 — matching IfcGref).
 *
 * The bSI Geo-referencing User Guide v2.0 defines the ePsets without any
 * unit mechanism — no MapUnit property, written under an explicit
 * "everything is metres" simplification — so a bare ePset file cannot
 * self-describe. We compensate twice over:
 *  - the three length properties get the schema-blessed
 *    `IfcPropertySingleValue.Unit` attribute (an IfcSIUnit METRE) when the
 *    CRS axis unit is the metre, overriding the project default that
 *    would otherwise apply to a bare IfcLengthMeasure;
 *  - ePSet_ProjectedCRS gets a `MapUnit` property naming the unit,
 *    mirroring IFC4's IfcProjectedCRS.MapUnit for ePset-convention readers.
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
  crsMetresPerUnit: number,
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

  const crsUnitName = lengthUnitNameForMetres(crsMetresPerUnit);
  const lengthUnitRef = buildLengthUnitRef(
    ifcAPI,
    modelID,
    crsMetresPerUnit,
    crsUnitName,
  );

  const projectedCrsProperties = [
    property(ifcAPI, modelID, "Name", IFCLABEL, crsName),
  ];
  if (crsUnitName != null) {
    projectedCrsProperties.push(
      property(ifcAPI, modelID, "MapUnit", IFCLABEL, crsUnitName),
    );
  }
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

  // On-disk Scale packs unit ratio × geometric scale, same as the IFC4
  // writer. E/N/H are canonical metres divided down to CRS axis units.
  const onDiskScale =
    parameters.xScale *
    mapConversionUnitFactor(ifcMetresPerUnit, crsMetresPerUnit);

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
        parameters.easting / crsMetresPerUnit,
        lengthUnitRef,
      ),
      property(
        ifcAPI,
        modelID,
        "Northings",
        IFCLENGTHMEASURE,
        parameters.northing / crsMetresPerUnit,
        lengthUnitRef,
      ),
      property(
        ifcAPI,
        modelID,
        "OrthogonalHeight",
        IFCLENGTHMEASURE,
        parameters.height / crsMetresPerUnit,
        lengthUnitRef,
      ),
      property(ifcAPI, modelID, "XAxisAbscissa", IFCREAL, xAxisAbscissa),
      property(ifcAPI, modelID, "XAxisOrdinate", IFCREAL, xAxisOrdinate),
      property(ifcAPI, modelID, "Scale", IFCREAL, onDiskScale),
    ],
  );
  writePsetRel(ifcAPI, modelID, ownerHistoryHandle, projectID, mapConvPset);

  emitLog({
    source: "worker",
    message: `ePSet_MapConversion Eastings/Northings/OrthogonalHeight written in ${crsUnitName ?? `${crsMetresPerUnit} m`} (CRS axis unit); Scale=${onDiskScale} bridges project ${ifcMetresPerUnit} m/unit`,
  });
}

/**
 * Build the `IfcPropertySingleValue.Unit` reference for the three length
 * properties: an `IfcSIUnit METRE` when the CRS axis unit is the metre
 * (the ~universal case). Non-SI axis units (foot-based state-plane CRSs)
 * would need the IfcConversionBasedUnit + IfcMeasureWithUnit +
 * IfcDimensionalExponents machinery — not built until a real file needs
 * it; the values are still correct CRS coordinates, and the MapUnit
 * property on ePSet_ProjectedCRS still names the unit. Returns null in
 * that case (property Unit slot stays `$`, with a log-panel note).
 *
 * The unit entity is written up front and shared by handle across all
 * three properties — one `IFCSIUNIT` line in the file, not three.
 */
function buildLengthUnitRef(
  ifcAPI: IfcAPI,
  modelID: number,
  crsMetresPerUnit: number,
  crsUnitName: string | null,
): Handle<unknown> | null {
  if (crsMetresPerUnit !== 1) {
    emitLog({
      level: "warn",
      source: "worker",
      message: `CRS axis unit is ${crsUnitName ?? `${crsMetresPerUnit} m`} — Eastings/Northings/OrthogonalHeight written in that unit, but the property Unit attribute is omitted (only IfcSIUnit METRE is supported).`,
    });
    return null;
  }
  // Same web-ifc constructor quirk as the IFC4 writer: JS args are
  // (UnitType, Prefix, Name); the STEP Dimensions slot is implicit.
  const metreUnit = ifcAPI.CreateIfcEntity(
    modelID,
    IFCSIUNIT,
    { type: 3, value: "LENGTHUNIT" },
    null,
    { type: 3, value: "METRE" },
  );
  ifcAPI.WriteLine(modelID, metreUnit);
  return new Handle(metreUnit.expressID);
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
  // IfcPropertySingleValue.Unit — overrides the project-wide unit for
  // this value per the IFC2x3 schema. Null leaves the slot `$` (value is
  // in the project unit / reader-conventional unit).
  unit: Handle<unknown> | null = null,
): any {
  return ifcAPI.CreateIfcEntity(
    modelID,
    IFCPROPERTYSINGLEVALUE,
    ifcAPI.CreateIfcType(modelID, IFCIDENTIFIER, name),
    null,
    ifcAPI.CreateIfcType(modelID, valueType, value),
    unit,
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
