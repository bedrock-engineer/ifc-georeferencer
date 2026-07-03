/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-argument,
*/

import { IFCLENGTHMEASURE, IFCRIGIDOPERATION, type IfcAPI } from "web-ifc";

import { emitLog } from "#lib/log";
import type { HelmertParams } from "#modules/helmert/solve";
import { getApi } from "../api";
import { deriveIfcMetresPerUnit } from "../metadata";
import { parseSchema, type IfcSchema } from "../schema";
import { decimalToDms, findPrimarySiteId } from "../shared";
import { readGeorefIfc2x3, writeGeorefIfc2x3 } from "./ifc2x3";
import {
  readGeorefIfc4,
  writeGeorefIfc4,
  writeGeorefIfc4Rigid,
  writeGeorefIfc4Scaled,
} from "./ifc4";
import { selectWriteTarget, type WriteTarget } from "./select-target";
import type { GeorefRead, SiteReferenceSync } from "./shared";

export type {
  ActiveCoordinateOperation,
  ExistingGeoref,
  GeorefRead,
  MapConversionStatus,
  RawMapConversion,
  RawProjectedCrs,
  RawRigidOperation,
  RawSourceCrs,
  SiteReferenceSync,
} from "./shared";

/**
 * Read existing georeferencing from a model, picking the right path for the
 * schema: IFC4+ native IfcMapConversion vs. IFC2X3 ePSet convention.
 *
 * `ifcMetresPerUnit` is the boundary multiplier — IfcLengthMeasure-typed
 * fields (Eastings/Northings/OrthogonalHeight) are scaled to metres here so
 * downstream HelmertParams are unit-free in the codebase-wide canonical.
 *
 * `trueNorthRotation` seeds rotation for the IfcRigidOperation fallback
 * (IFC 4.3 only). RigidOp is translation-only, so when it drives the anchor
 * we use the file's TrueNorth as the rotation guess — same convention as
 * the single-point Helmert fallback. Pass 0 when the file has no TrueNorth.
 * Unused on the MapConversion path (rotation comes from XAxis fields) and
 * on IFC2X3 (no RigidOp entity).
 */
export function readExistingGeoref(
  ifcAPI: IfcAPI,
  modelID: number,
  schema: IfcSchema,
  ifcMetresPerUnit: number,
  trueNorthRotation: number,
): GeorefRead {
  if (schema === "IFC2X3") {
    return readGeorefIfc2x3(ifcAPI, modelID, ifcMetresPerUnit);
  }
  return readGeorefIfc4(ifcAPI, modelID, ifcMetresPerUnit, trueNorthRotation);
}

export async function writeMapConversion(
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  siteReference: SiteReferenceSync | null,
  // Target CRS axis-unit factor, resolved on the main thread (the worker
  // has no proj4). Consumed only by the IFC2X3 ePset writer; IFC4+ writers
  // derive their unit from the file's IfcProjectedCRS.MapUnit instead.
  crsMetresPerUnit: number,
): Promise<void> {
  const ifcAPI = await getApi();
  const schema = parseSchema(ifcAPI.GetModelSchema(modelID));
  const ifcMetresPerUnit = deriveIfcMetresPerUnit(ifcAPI, modelID);

  // Sync IfcSite.RefLatitude/RefLongitude to the new MapConversion so
  // Level-20-only consumers see a consistent location, and so the next
  // re-load of this file doesn't show stale coordinates from the file's
  // original export. RefElevation is preserved verbatim (see
  // `SiteReferenceSync` for the vertical-datum reasoning).
  if (siteReference) {
    syncSiteReference(ifcAPI, modelID, siteReference);
  }

  const fileHadRigidOperation =
    schema === "IFC4X3" && fileHasRigidOperation(ifcAPI, modelID);
  const target = selectWriteTarget({
    schema,
    params: parameters,
    fileHadRigidOperation,
  });

  // IFC4+ writers preserve the file's existing IfcProjectedCRS.MapUnit
  // when present (so a foot-authored file stays foot across save →
  // reload) and fall back to IfcSIUnit METRE for fresh files. They also
  // convert canonical-metres E/N/H to MapUnit at the boundary; see
  // `writeGeorefIfc4` for the formula.
  switch (target.entity) {
    case "ePSet_MapConversion": {
      writeGeorefIfc2x3(
        ifcAPI,
        modelID,
        epsgCode,
        verticalDatum,
        parameters,
        ifcMetresPerUnit,
        crsMetresPerUnit,
      );
      break;
    }
    case "IfcMapConversionScaled": {
      writeGeorefIfc4Scaled(
        ifcAPI,
        modelID,
        epsgCode,
        verticalDatum,
        parameters,
        ifcMetresPerUnit,
      );
      break;
    }
    case "IfcRigidOperation": {
      writeGeorefIfc4Rigid(
        ifcAPI,
        modelID,
        epsgCode,
        verticalDatum,
        parameters,
        ifcMetresPerUnit,
      );
      break;
    }
    case "IfcMapConversion": {
      writeGeorefIfc4(
        ifcAPI,
        modelID,
        epsgCode,
        verticalDatum,
        parameters,
        ifcMetresPerUnit,
      );
      break;
    }
  }

  emitLog({
    source: "worker",
    message: formatWriteOutcome(target, epsgCode, verticalDatum, parameters),
  });
}

function formatWriteOutcome(
  target: WriteTarget,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
): string {
  const verticalSuffix = verticalDatum ? `, vertical=${verticalDatum}` : "";
  const head = `Wrote ${target.entity} (EPSG:${epsgCode}${verticalSuffix}`;
  switch (target.entity) {
    case "IfcRigidOperation": {
      return `${head}, translation-only, preserving original entity type)`;
    }
    case "IfcMapConversionScaled": {
      return `${head}, xScale=${parameters.xScale.toFixed(6)}, yScale=${parameters.yScale.toFixed(6)}, zScale=${parameters.zScale.toFixed(6)}, rot=${parameters.rotation.toFixed(4)} rad)`;
    }
    case "IfcMapConversion": {
      const body = `scale=${parameters.xScale.toFixed(6)}, rot=${parameters.rotation.toFixed(4)} rad`;
      const suffix = target.upgradeFromRigid
        ? "; upgraded from IfcRigidOperation — RigidOp can't carry rotation or scale"
        : "";
      return `${head}, ${body}${suffix})`;
    }
    case "ePSet_MapConversion": {
      return `${head}, scale=${parameters.xScale.toFixed(6)}, rot=${parameters.rotation.toFixed(4)} rad)`;
    }
  }
}

/**
 * True when the model carries at least one direct IfcRigidOperation entity
 * (not via inheritance — IfcMapConversion subtypes are queried separately).
 * Always false on pre-4.3 schemas (the type id resolves but the index
 * is empty). Cheap; called once per write.
 */
function fileHasRigidOperation(ifcAPI: IfcAPI, modelID: number): boolean {
  return ifcAPI.GetLineIDsWithType(modelID, IFCRIGIDOPERATION).size() > 0;
}

/**
 * Overwrite IfcSite.RefLatitude/RefLongitude with a lat/lon derived from
 * the new MapConversion. No-op if the model has no IfcSite (IFC4 allows
 * that — MapConversion attaches to the geometric representation context,
 * not the site). RefElevation is left untouched; see `SiteReferenceSync`
 * for the vertical-datum reasoning.
 */
function syncSiteReference(
  ifcAPI: IfcAPI,
  modelID: number,
  ref: SiteReferenceSync,
): void {
  const siteID = findPrimarySiteId(ifcAPI, modelID);
  if (siteID == null) {
    return;
  }
  // GetLine with flatten=false keeps Handles to referenced entities
  // (OwnerHistory, ObjectPlacement, ...) intact — WriteLine expects those
  // as handles, not as expanded nested objects.
  const site = ifcAPI.GetLine(modelID, siteID, false);
  // IfcSite has 14 attributes; optional ones (Description, ObjectType,
  // Representation, LandTitleNumber, SiteAddress, ...) are returned as
  // `undefined` when absent in the STEP file. ToRawLineData's serializer
  // then fails with "Cannot convert undefined to int". Normalize to null
  // so every attribute has an explicit value before WriteLine serializes.
  for (const key of Object.keys(site)) {
    if (site[key] === undefined) {
      site[key] = null;
    }
  }
  // web-ifc's CreateIfcType initialiser for IFCCOMPOUNDPLANEANGLEMEASURE
  // expects pre-wrapped `[{value:d},{value:m},...]` (it calls
  // `v.map(x => x.value)` internally) — passing plain numbers produces a
  // broken instance whose inner array is `[undefined, ...]` and then
  // WriteLine throws "Cannot convert undefined to int". We build the shape
  // GetLine would return directly: `{ type: 10, value: [d, m, s, us] }`
  // (`type: 10` is the IfcCompoundPlaneAngleMeasure tape-item tag).
  site.RefLatitude = { type: 10, value: decimalToDms(ref.latitude) };
  site.RefLongitude = { type: 10, value: decimalToDms(ref.longitude) };
  // Recreate RefElevation with its existing value: the IfcLengthMeasure
  // wrapper GetLine returns isn't accepted by the browser-bundled web-ifc's
  // Embind float.toWireType (ASSERTIONS=1 — Node bundle silently passes
  // it through), so WriteLine throws "Cannot read properties of undefined
  // (reading 'name')". CreateIfcType yields a shape the serializer accepts.
  if (site.RefElevation != null) {
    site.RefElevation = ifcAPI.CreateIfcType(
      modelID,
      IFCLENGTHMEASURE,
      Number(site.RefElevation.value),
    );
  }
  ifcAPI.WriteLine(modelID, site);
  emitLog({
    source: "worker",
    message: `Synced IfcSite RefLat/RefLon to ${ref.latitude.toFixed(6)},${ref.longitude.toFixed(6)} (RefElevation left unchanged — vertical datum unknown)`,
  });
}
