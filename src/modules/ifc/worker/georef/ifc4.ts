/* eslint-disable @typescript-eslint/no-explicit-any,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
*/

import {
  type IfcAPI,
  Handle,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCGEOMETRICREPRESENTATIONSUBCONTEXT,
  IFCIDENTIFIER,
  IFCLABEL,
  IFCLENGTHMEASURE,
  IFCMAPCONVERSION,
  IFCMAPCONVERSIONSCALED,
  IFCPROJECTEDCRS,
  IFCREAL,
  IFCRIGIDOPERATION,
  IFCSIUNIT,
} from "web-ifc";
import type { HelmertParams } from "#modules/helmert/solve";
import { emitLog } from "#lib/log";
import {
  buildHelmertFromFields,
  expressIDOf,
  isMapUnitAbsent,
  isMapUnitNameMissing,
  nameToMetresPerUnit,
  mapConversionUnitFactor,
  rawValue,
  readMapUnitMetresPerUnit,
  rotationToAxisPair,
} from "../shared";
import {
  absentGeorefRead,
  classifyGeorefRead,
  deriveVerticalDatumHint,
  type ExistingGeoref,
  type GeorefRead,
  type RawProjectedCrs,
  type RawRigidOperation,
  type RawSourceCrs,
} from "./shared";

/**
 * IFC4+ read path. Looks for a native IfcMapConversion entity and reads
 * its six Helmert fields + the referenced IfcProjectedCRS attributes.
 *
 * Falls back to IfcRigidOperation (IFC 4.3 sibling — translation only)
 * when no MapConversion exists. RigidOp drives a HelmertParams with the
 * file's TrueNorth as rotation seed and unit scale, since the entity by
 * definition carries no rotation or scale. Skips RigidOp when its
 * TargetCRS is geographic (the map pipeline only handles projected); the
 * RigidOp is still surfaced in the raw display. A placeholder
 * MapConversion (Revit-style E=N=0) wins over a RigidOp present in the
 * same file — the combo is rare enough not to special-case.
 */
export function readGeorefIfc4(
  ifcAPI: IfcAPI,
  modelID: number,
  ifcMetresPerUnit: number,
  trueNorthRotation: number,
): GeorefRead {
  // IfcRigidOperation is an IFC 4.3-only sibling of IfcMapConversion —
  // GetLineIDsWithType returns 0 entries on pre-4.3 schemas, so this read
  // is safe to attempt unconditionally. The result feeds two paths: raw
  // display (always), and fallback driver when MapConversion is absent
  // or placeholder (handled below).
  const rigidOpResult = readRigidOperationIfc4(
    ifcAPI,
    modelID,
    ifcMetresPerUnit,
    trueNorthRotation,
  );
  const rawRigidOperation = rigidOpResult.raw;

  // `includeInherited: true` makes the query also return IfcMapConversionScaled
  // instances (an IFC 4.3 subtype that adds FactorX/Y/Z for non-isotropic
  // scaling). We dispatch on the entity's type tag below.
  const ids = ifcAPI.GetLineIDsWithType(modelID, IFCMAPCONVERSION, true);
  // web-ifc 0.0.77 leaves stale entries in the type index after
  // DeleteLine + WriteLine of a fresh entity (the "repair baked
  // placement" flow runs both in the same model session). Iterate
  // until we find a line GetLine can actually resolve; the deleted
  // entries return undefined.
  const mc = firstResolvableLine(ifcAPI, modelID, ids, /* flatten */ true);
  
  if (!mc) {
    // No MapConversion. If we have a usable RigidOp-derived georef, it
    // drives the anchor; otherwise return the absent shape. Either way
    // the raw RigidOp is preserved for the source-card display.
    if (rigidOpResult.driverGeoref) {
      return {
        ...rigidOpResult.driverGeoref,
        rawMapConversion: null,
        mapConversionStatus: "absent",
        rawRigidOperation,
        activeCoordinateOperation: "rigid-operation",
      };
    }
    return { ...absentGeorefRead(null), rawRigidOperation };
  }

  const target: any = mc.TargetCRS;
  const rawSourceCrs = readRawSourceCrsIfc4(mc.SourceCRS);
  const onDiskScale = optionalNumber(mc.Scale, 1);
  const onDiskXAbs = optionalNumber(mc.XAxisAbscissa, 1);
  const onDiskXOrd = optionalNumber(mc.XAxisOrdinate, 0);
  const onDiskE = optionalNumber(mc.Eastings, 0);
  const onDiskN = optionalNumber(mc.Northings, 0);
  const onDiskH = optionalNumber(mc.OrthogonalHeight, 0);

  // Eastings/Northings/OrthogonalHeight live in IfcProjectedCRS.MapUnit,
  // not in the IFC project's length unit (see Revit-authored mm files
  // that nonetheless write Eastings in metres because MapUnit=METRE).
  // Pass on-disk Scale so a malformed MapUnit (Name=$) can be recovered
  // by inverting the spec-conventional source-unit/MapUnit ratio.
  const mapUnitMetresPerUnit = readMapUnitMetresPerUnit(
    target,
    ifcMetresPerUnit,
    onDiskScale,
  );

  const mapUnitStatus = computeMapUnitStatus({
    target,
    mapUnitMetresPerUnit,
    ifcMetresPerUnit,
  });

  const rawProjectedCrs = readRawProjectedCrsIfc4(
    target,
    mapUnitStatus,
    mapUnitMetresPerUnit,
  );

  switch (mapUnitStatus) {
    case "absent": {
      emitLog({
        source: "worker",
        message: `IfcProjectedCRS.MapUnit absent — defaulting to METRE (will write IfcSIUnit METRE on save).`,
      });

      break;
    }
    case "recovered-from-scale": {
      emitLog({
        level: "warn",
        source: "worker",
        message: `IfcProjectedCRS.MapUnit malformed (Name absent) — recovered ${mapUnitMetresPerUnit} m/unit from IfcMapConversion.Scale (${onDiskScale}).`,
      });

      break;
    }
    case "malformed-fallback": {
      emitLog({
        level: "warn",
        source: "worker",
        message: `IfcProjectedCRS.MapUnit malformed (Name absent) — Scale recovery failed; falling back to project length unit (${ifcMetresPerUnit} m).`,
      });

      break;
    }
    // No default
  }

  // IFC 4.3 IfcMapConversionScaled: per-spec, effective per-axis scale is
  // Scale × Factor<axis>. FactorX/Y/Z default to 1 when the entity is plain
  // IfcMapConversion (the fields don't exist; rawValue returns undefined →
  // optionalNumber falls back to 1).
  const isScaled = mc.type === IFCMAPCONVERSIONSCALED;
  const factorX = isScaled ? optionalNumber(mc.FactorX, 1) : 1;
  const factorY = isScaled ? optionalNumber(mc.FactorY, 1) : 1;
  const factorZ = isScaled ? optionalNumber(mc.FactorZ, 1) : 1;

  const helmert = buildHelmertFromFields(
    {
      scale: onDiskScale,
      xAxisAbscissa: onDiskXAbs,
      xAxisOrdinate: onDiskXOrd,
      eastings: onDiskE,
      northings: onDiskN,
      orthogonalHeight: onDiskH,
      factorX,
      factorY,
      factorZ,
    },
    { mapUnitMetresPerUnit, ifcMetresPerUnit },
  );

  if (isScaled && factorX !== factorY) {
    emitLog({
      level: "warn",
      source: "worker",
      message: `IfcMapConversionScaled has FactorX (${factorX}) ≠ FactorY (${factorY}) — non-conformal projection or unusual workflow. Using FactorX for both axes; the asymmetry will not survive a save through this tool.`,
    });
  }

  const classified = classifyGeorefRead({
    helmert,
    rawProjectedCrs,
    rawMapConversion: {
      entityName: isScaled ? "IfcMapConversionScaled" : "IfcMapConversion",
      eastings: onDiskE,
      northings: onDiskN,
      orthogonalHeight: onDiskH,
      scale: onDiskScale,
      xAxisAbscissa: onDiskXAbs,
      xAxisOrdinate: onDiskXOrd,
      factorX: isScaled ? factorX : null,
      factorY: isScaled ? factorY : null,
      factorZ: isScaled ? factorZ : null,
      sourceCrs: rawSourceCrs,
    },
  });

  return {
    ...classified,
    rawRigidOperation,
  };
}

interface RigidOperationReadResult {
  /** Verbatim-from-file fields for the source-card display, or null if no entity. */
  raw: RawRigidOperation | null;
  /**
   * Set when the RigidOp is usable as the active transform: entity present,
   * TargetCRS is `IfcProjectedCRS`, and the file's MapUnit / unit boundary
   * could be resolved. The HelmertParams carries the TrueNorth-seeded
   * rotation. Null when the RigidOp is absent, or when TargetCRS is
   * geographic (the map pipeline only handles projected) — in the geographic
   * case the raw is still surfaced for display.
   *
   * `rawProjectedCrs` is parallel to the MapConversion path: same shape,
   * built from the same `target` entity, so the source-card's ProjectedCRS
   * section renders identically regardless of which CoordinateOperation
   * subtype drove the anchor.
   */
  driverGeoref: {
    existingGeoref: ExistingGeoref;
    rawProjectedCrs: RawProjectedCrs | null;
    targetCrsHint: string | null;
    verticalDatumHint: string | null;
  } | null;
}

/**
 * Read the first IfcRigidOperation entity in the model, if any. IFC 4.3
 * introduces this as a translation-only sibling of IfcMapConversion. The
 * raw fields are always returned for the source-card disclosure; the
 * driver-georef is returned only when the entity can position the model on
 * the map (TargetCRS is projected). Returns null on pre-4.3 schemas
 * (`IFCRIGIDOPERATION` type-id query yields 0 results there).
 *
 * `trueNorthRotation` seeds rotation: RigidOp by definition has none, so we
 * use the file's TrueNorth as the rotation guess — same convention as the
 * single-point Helmert fallback. The user can override via the rotation card.
 */
function readRigidOperationIfc4(
  ifcAPI: IfcAPI,
  modelID: number,
  ifcMetresPerUnit: number,
  trueNorthRotation: number,
): RigidOperationReadResult {
  const ids = ifcAPI.GetLineIDsWithType(modelID, IFCRIGIDOPERATION);
  const op = firstResolvableLine(ifcAPI, modelID, ids, /* flatten */ true);
  if (!op) {
    return { raw: null, driverGeoref: null };
  }
  const heightRaw = rawValue(op.Height);
  const target: any = op.TargetCRS;
  const targetCrsName = target ? optionalString(target.Name) : null;
  const raw: RawRigidOperation = {
    firstCoordinate: optionalNumber(op.FirstCoordinate, 0),
    secondCoordinate: optionalNumber(op.SecondCoordinate, 0),
    height: heightRaw == null ? null : Number(heightRaw),
    targetCrsName,
  };

  // The map pipeline only handles projected CRSs. Geographic targets (and
  // any other CoordinateReferenceSystemSelect) get surfaced as raw display
  // but don't feed existingGeoref — the model can't be positioned.
  if (target?.type !== IFCPROJECTEDCRS) {
    emitLog({
      source: "worker",
      message: `Read IfcRigidOperation${targetCrsName ? ` (target ${targetCrsName})` : ""} — non-projected TargetCRS, not positioning on map`,
    });
    return { raw, driverGeoref: null };
  }

  // Unit boundary mirrors IfcMapConversion exactly: FirstCoordinate /
  // SecondCoordinate / Height live in IfcProjectedCRS.MapUnit (same
  // convention authoring tools use for MapConversion E/N/H), with METRE
  // fallback when MapUnit is absent. No on-disk Scale to invert here —
  // RigidOp doesn't carry one — so the malformed-recovery branch of
  // readMapUnitMetresPerUnit doesn't fire.
  const mapUnitMetresPerUnit = readMapUnitMetresPerUnit(
    target,
    ifcMetresPerUnit,
  );
  const mapUnitStatus = computeMapUnitStatus({
    target,
    mapUnitMetresPerUnit,
    ifcMetresPerUnit,
  });
  const rawProjectedCrs = readRawProjectedCrsIfc4(
    target,
    mapUnitStatus,
    mapUnitMetresPerUnit,
  );

  const helmert: HelmertParams = {
    easting: raw.firstCoordinate * mapUnitMetresPerUnit,
    northing: raw.secondCoordinate * mapUnitMetresPerUnit,
    height: (raw.height ?? 0) * mapUnitMetresPerUnit,
    rotation: trueNorthRotation,
    xScale: 1,
    yScale: 1,
    zScale: 1,
  };

  emitLog({
    source: "worker",
    message: `Read IfcRigidOperation (target ${targetCrsName ?? "?"}, E=${raw.firstCoordinate}, N=${raw.secondCoordinate}${raw.height == null ? "" : `, H=${raw.height}`}, rotation seeded from TrueNorth: ${trueNorthRotation.toFixed(4)} rad)`,
  });

  return {
    raw,
    driverGeoref: {
      existingGeoref: { targetCrsName: targetCrsName ?? "", helmert },
      rawProjectedCrs,
      targetCrsHint: targetCrsName,
      verticalDatumHint: deriveVerticalDatumHint(rawProjectedCrs),
    },
  };
}

/**
 * Read the IfcGeometricRepresentationContext (or rare SubContext) that
 * IfcMapConversion.SourceCRS points to. The link is otherwise invisible in
 * the source card, and matters when a file carries multiple contexts
 * (Model/Plan/Body) — MapConversion is attached to exactly one of them.
 *
 * `source` is the flattened SourceCRS attribute from `GetLine(..., true)`.
 * Per IfcCoordinateReferenceSystemSelect the value is *normally* an
 * IfcGeometricRepresentationContext; we don't try to handle IfcGeographicCRS
 * here (rare, not used by any tool that authors a MapConversion).
 */
function readRawSourceCrsIfc4(source: any): RawSourceCrs | null {
  if (!source) {
    return null;
  }
  const entityName =
    source.type === IFCGEOMETRICREPRESENTATIONSUBCONTEXT
      ? "IfcGeometricRepresentationSubContext"
      : "IfcGeometricRepresentationContext";
  return {
    entityName,
    contextIdentifier: optionalString(source.ContextIdentifier),
    contextType: optionalString(source.ContextType),
  };
}

function readRawProjectedCrsIfc4(
  target: any,
  mapUnitStatus: RawProjectedCrs["mapUnitStatus"],
  mapUnitMetresPerUnit: number,
): RawProjectedCrs | null {
  if (!target) {
    return null;
  }
  return {
    entityName: "IfcProjectedCRS",
    name: optionalString(target.Name),
    description: optionalString(target.Description),
    geodeticDatum: optionalString(target.GeodeticDatum),
    verticalDatum: optionalString(target.VerticalDatum),
    mapProjection: optionalString(target.MapProjection),
    mapZone: optionalString(target.MapZone),
    mapUnit: readMapUnitLabel(target.MapUnit),
    mapUnitStatus,
    metresPerUnit: mapUnitMetresPerUnit,
  };
}

/**
 * Resolve `mapUnitStatus` from the on-disk MapUnit shape plus the
 * recovered metres-per-unit factor. Discriminates the four cases the
 * source-card badge needs to distinguish:
 *
 *  - MapUnit attribute absent → `'absent'` (reader defaulted to METRE)
 *  - MapUnit present, Name empty, recovery yielded ≠ project unit
 *    → `'recovered-from-scale'` (algebraic Scale-inversion succeeded)
 *  - MapUnit present, Name empty, recovery yielded == project unit
 *    → `'malformed-fallback'` (recovery couldn't disambiguate)
 *  - Otherwise → `'explicit'` (mapUnit string is the source of truth,
 *    whether recognised or not; UI displays it verbatim)
 */
function computeMapUnitStatus(arguments_: {
  target: any;
  mapUnitMetresPerUnit: number;
  ifcMetresPerUnit: number;
}): RawProjectedCrs["mapUnitStatus"] {
  const { target, mapUnitMetresPerUnit, ifcMetresPerUnit } = arguments_;
  if (isMapUnitAbsent(target)) {
    return "absent";
  }
  if (isMapUnitNameMissing(target)) {
    return mapUnitMetresPerUnit === ifcMetresPerUnit
      ? "malformed-fallback"
      : "recovered-from-scale";
  }
  return "explicit";
}

/**
 * Combine an IfcSIUnit's Prefix + Name into a single readable label
 * ("MILLIMETRE", "METRE", …). Falls back to a free-form Name string for
 * IfcConversionBasedUnit. Null when MapUnit is unset.
 */
function readMapUnitLabel(mapUnit: any): string | null {
  if (!mapUnit) {
    return null;
  }
  const prefix = optionalString(mapUnit.Prefix) ?? "";
  const name = optionalString(mapUnit.Name);
  if (name == null) {
    return null;
  }
  return `${prefix}${name}`;
}

function optionalString(v: unknown): string | null {
  const raw = rawValue(v);
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw;
}

function optionalNumber(v: unknown, fallback: number): number {
  const raw = rawValue(v);
  if (raw == null) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Hand-constructs IfcProjectedCRS + IfcMapConversion for IFC4 schemas and
 * attaches them to the first IfcGeometricRepresentationContext (which acts
 * as the SourceCRS, per the IFC4 IfcCoordinateReferenceSystemSelect rule).
 *
 * Mirrors `set_mapconversion_crs_ifc4` in georeference_ifc/main.py.
 *
 * `parameters` are codebase-canonical (metres + dimensionless scale, see
 * `modules/helmert/solve.ts`). We preserve the file's existing
 * `IfcProjectedCRS.MapUnit` when present (so a foot-authored file stays
 * foot across save → reload) and fall back to a fresh `IfcSIUnit METRE`
 * for fresh files. The on-disk Scale follows the IFC convention
 * (source-unit ↔ MapUnit ratio); the on-disk Eastings/Northings/
 * OrthogonalHeight are in the MapUnit, so canonical-metres parameters
 * are divided by `mapUnitMetresPerUnit` at this boundary.
 */
export function writeGeorefIfc4(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  ifcMetresPerUnit: number,
): void {
  const setup = setupIfc4GeorefWrite(
    ifcAPI,
    modelID,
    epsgCode,
    verticalDatum,
    parameters.rotation,
  );

  // Plain IfcMapConversion packs unit ratio × geometric scale into Scale.
  // Routed here only for isotropic params (xScale = yScale = zScale): on
  // pre-4.3 solveHelmertJoint sets all three equal; on 4.3 with anisotropic
  // params the dispatcher in writeMapConversion picks the Scaled writer.
  const onDiskScale =
    parameters.xScale *
    mapConversionUnitFactor(ifcMetresPerUnit, setup.mapUnitMetresPerUnit);

  const [easting, northing, height] = lengthTripleInMapUnit(
    ifcAPI,
    modelID,
    parameters,
    setup.mapUnitMetresPerUnit,
  );

  // IfcMapConversion(SourceCRS, TargetCRS, Eastings, Northings,
  //                  OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale)
  const mapConversion = ifcAPI.CreateIfcEntity(
    modelID,
    IFCMAPCONVERSION,
    new Handle(setup.sourceContextID),
    setup.projectedCRS,
    easting,
    northing,
    height,
    ifcAPI.CreateIfcType(modelID, IFCREAL, setup.xAxisAbscissa),
    ifcAPI.CreateIfcType(modelID, IFCREAL, setup.xAxisOrdinate),
    ifcAPI.CreateIfcType(modelID, IFCREAL, onDiskScale),
  );

  // WriteLine recursively writes nested entities (the projectedCRS) first,
  // assigns expressIDs, and replaces them with Handles.
  ifcAPI.WriteLine(modelID, mapConversion);
}

/**
 * Hand-constructs IfcProjectedCRS + IfcMapConversionScaled (IFC 4.3 only).
 * Used when the fitter produced anisotropic per-axis scales (typically from
 * `solveHelmertSplit`) — the Scaled subtype carries `FactorX/Y/Z` so the
 * file faithfully encodes the asymmetry instead of flattening to one Scale.
 *
 * Spec mapping: effective per-axis scale on disk is `Scale × Factor<axis>`.
 * We put the unit-conversion ratio in Scale (so it stays a unit-conversion
 * field, matching the inherited semantic) and the geometric per-axis values
 * in Factors. For MapUnit=METRE this gives Scale = ifcMetresPerUnit and
 * FactorX/Y/Z = the dimensionless geometric scales.
 */
export function writeGeorefIfc4Scaled(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  ifcMetresPerUnit: number,
): void {
  const setup = setupIfc4GeorefWrite(
    ifcAPI,
    modelID,
    epsgCode,
    verticalDatum,
    parameters.rotation,
  );

  // Per spec, effective per-axis scale on disk is Scale × Factor<axis>.
  // Scale carries the source-unit → MapUnit ratio (no geometric component);
  // FactorX/Y/Z carry the dimensionless geometric scales (typically 1.0).
  const onDiskScale = mapConversionUnitFactor(
    ifcMetresPerUnit,
    setup.mapUnitMetresPerUnit,
  );

  const [e, n, h] = lengthTripleInMapUnit(
    ifcAPI,
    modelID,
    parameters,
    setup.mapUnitMetresPerUnit,
  );

  // IfcMapConversionScaled(SourceCRS, TargetCRS, Eastings, Northings,
  //                        OrthogonalHeight, XAxisAbscissa, XAxisOrdinate,
  //                        Scale, FactorX, FactorY, FactorZ)
  const mapConversion = ifcAPI.CreateIfcEntity(
    modelID,
    IFCMAPCONVERSIONSCALED,
    new Handle(setup.sourceContextID),
    setup.projectedCRS,
    e,
    n,
    h,
    ifcAPI.CreateIfcType(modelID, IFCREAL, setup.xAxisAbscissa),
    ifcAPI.CreateIfcType(modelID, IFCREAL, setup.xAxisOrdinate),
    ifcAPI.CreateIfcType(modelID, IFCREAL, onDiskScale),
    ifcAPI.CreateIfcType(modelID, IFCREAL, parameters.xScale),
    ifcAPI.CreateIfcType(modelID, IFCREAL, parameters.yScale),
    ifcAPI.CreateIfcType(modelID, IFCREAL, parameters.zScale),
  );

  ifcAPI.WriteLine(modelID, mapConversion);
}

/**
 * IFC 4.3 IfcRigidOperation writer — translation-only sibling of
 * IfcMapConversion. Used by the dispatcher in `writeMapConversion` when
 * the file originally carried a RigidOp and the user hasn't introduced
 * rotation or scale (those would force an upgrade to IfcMapConversion,
 * which the dispatcher takes care of). Round-trip-safe with the reader:
 * load → save without edits leaves the entity type and translation values
 * unchanged.
 *
 * `parameters.rotation` and the scale fields are ignored on this path —
 * the dispatcher only routes here when they're at identity, so the
 * RigidOp encoding loses nothing. If the dispatcher routed wrong, the
 * file would silently drop a rotation/scale the user intended; the
 * dispatcher's tolerance check is the safety net.
 */
export function writeGeorefIfc4Rigid(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  parameters: HelmertParams,
  // Signature parity with the other two IFC4 writers; the dispatcher routes
  // here only when params are at identity rotation/scale, so this writer
  // ignores `rotation` (no XAxis pair on RigidOp). ifcMetresPerUnit is still
  // used: FirstCoordinate/SecondCoordinate/Height go through the same
  // MapUnit boundary as MapConversion's E/N/H — same convention authoring
  // tools use, same path through `lengthTripleInMapUnit`.
  _ifcMetresPerUnit: number,
): void {
  const setup = setupIfc4GeorefWrite(
    ifcAPI,
    modelID,
    epsgCode,
    verticalDatum,
    /* rotation, unused on this path */ 0,
  );

  const [first, second, height] = lengthTripleInMapUnit(
    ifcAPI,
    modelID,
    parameters,
    setup.mapUnitMetresPerUnit,
  );

  // IfcRigidOperation(SourceCRS, TargetCRS, FirstCoordinate,
  //                   SecondCoordinate, Height?)
  // Height is optional per spec. We always emit it for round-trip
  // symmetry with the reader (which defaults missing Height to 0 in
  // metres anyway); omitting it on a 0-height fixture would change the
  // entity's STEP arity across save → reload for no benefit.
  const rigidOperation = ifcAPI.CreateIfcEntity(
    modelID,
    IFCRIGIDOPERATION,
    new Handle(setup.sourceContextID),
    setup.projectedCRS,
    first,
    second,
    height,
  );

  ifcAPI.WriteLine(modelID, rigidOperation);
}

/**
 * Build the three `IfcLengthMeasure` handles the IFC4+ writers feed into
 * IfcMapConversion's (E, N, H), IfcMapConversionScaled's (E, N, H), and
 * IfcRigidOperation's (FirstCoordinate, SecondCoordinate, Height). All
 * three entities place these fields at the same MapUnit boundary, so
 * the divide-by-MapUnit conversion is identical — and was previously
 * inlined verbatim three times.
 */
function lengthTripleInMapUnit(
  ifcAPI: IfcAPI,
  modelID: number,
  parameters: HelmertParams,
  mapUnitMetresPerUnit: number,
): [first: any, second: any, height: any] {
  return [
    ifcAPI.CreateIfcType(
      modelID,
      IFCLENGTHMEASURE,
      parameters.easting / mapUnitMetresPerUnit,
    ),
    ifcAPI.CreateIfcType(
      modelID,
      IFCLENGTHMEASURE,
      parameters.northing / mapUnitMetresPerUnit,
    ),
    ifcAPI.CreateIfcType(
      modelID,
      IFCLENGTHMEASURE,
      parameters.height / mapUnitMetresPerUnit,
    ),
  ];
}

interface Ifc4WriteSetup {
  sourceContextID: number;
  projectedCRS: any;
  mapUnitMetresPerUnit: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
}

/**
 * Shared prelude for writeGeorefIfc4 / writeGeorefIfc4Scaled: snapshot the
 * file's MapUnit, delete existing georef entities, locate the source
 * IfcGeometricRepresentationContext, build the new IfcProjectedCRS, and
 * resolve the axis pair from the rotation. The two writers differ only in
 * the MapConversion entity they build with this setup — that logic stays
 * in each writer so the entity shape (positional CreateIfcEntity args,
 * spec mapping comment) stays line-aligned with its definition.
 *
 * Throws if no IfcGeometricRepresentationContext exists; every IFC4 model
 * is required to carry at least one, so there's nothing to recover to.
 */
function setupIfc4GeorefWrite(
  ifcAPI: IfcAPI,
  modelID: number,
  epsgCode: number,
  verticalDatum: string | null,
  rotation: number,
): Ifc4WriteSetup {
  // Snapshot the file's MapUnit *before* removeExistingGeorefIfc4 deletes
  // the IfcProjectedCRS that referenced it. The entity itself (an
  // IfcSIUnit or IfcConversionBasedUnit, typically shared with
  // IfcUnitAssignment) is not cascade-deleted; we re-reference it on the
  // new IfcProjectedCRS by handle.
  const preservedMapUnit = findPreservableMapUnit(ifcAPI, modelID);
  removeExistingGeorefIfc4(ifcAPI, modelID);

  const contextIds = ifcAPI.GetLineIDsWithType(
    modelID,
    IFCGEOMETRICREPRESENTATIONCONTEXT,
  );
  if (contextIds.size() === 0) {
    const message = "No IfcGeometricRepresentationContext found in model";
    emitLog({ level: "error", source: "worker", message });
    throw new Error(message);
  }
  const sourceContextID = contextIds.get(0);

  const verticalDatumValue =
    verticalDatum && verticalDatum.length > 0
      ? ifcAPI.CreateIfcType(modelID, IFCIDENTIFIER, verticalDatum)
      : null;

  const { mapUnitRef, mapUnitMetresPerUnit } = resolveMapUnitForWrite(
    ifcAPI,
    modelID,
    preservedMapUnit,
  );

  // IfcProjectedCRS(Name, Description, GeodeticDatum, VerticalDatum,
  //                 MapProjection, MapZone, MapUnit)
  const projectedCRS = ifcAPI.CreateIfcEntity(
    modelID,
    IFCPROJECTEDCRS,
    ifcAPI.CreateIfcType(modelID, IFCLABEL, `EPSG:${epsgCode}`),
    null,
    null,
    verticalDatumValue,
    null,
    null,
    mapUnitRef,
  );

  const { xAxisAbscissa, xAxisOrdinate } = rotationToAxisPair(rotation);

  return {
    sourceContextID,
    projectedCRS,
    mapUnitMetresPerUnit,
    xAxisAbscissa,
    xAxisOrdinate,
  };
}

/**
 * Delete every IfcCoordinateOperation entity (IfcMapConversion, IFC 4.3
 * IfcMapConversionScaled subtype via includeInherited, and IFC 4.3
 * IfcRigidOperation as a sibling) plus IfcProjectedCRS, so a subsequent
 * write doesn't leave duplicate or orphaned operations.
 *
 * RigidOp deletion fires on every IFC4+ write regardless of whether the
 * file had one — `GetLineIDsWithType` for IFCRIGIDOPERATION returns 0 on
 * pre-4.3 schemas, so the loop is a safe no-op. This keeps the "write
 * MapConversion to a file that had RigidOp + edited rotation" case clean:
 * the stale RigidOp doesn't survive to confuse the next reader.
 */
function removeExistingGeorefIfc4(ifcAPI: IfcAPI, modelID: number): void {
  // Delete CoordinateOperation entities first (they reference
  // IfcProjectedCRS). includeInherited on the MapConversion query brings
  // in IfcMapConversionScaled instances.
  const mcIds = ifcAPI.GetLineIDsWithType(modelID, IFCMAPCONVERSION, true);
  for (let index = 0; index < mcIds.size(); index++) {
    ifcAPI.DeleteLine(modelID, mcIds.get(index));
  }
  const rigidIds = ifcAPI.GetLineIDsWithType(modelID, IFCRIGIDOPERATION);
  for (let index = 0; index < rigidIds.size(); index++) {
    ifcAPI.DeleteLine(modelID, rigidIds.get(index));
  }
  const crsIds = ifcAPI.GetLineIDsWithType(modelID, IFCPROJECTEDCRS);
  for (let index = 0; index < crsIds.size(); index++) {
    ifcAPI.DeleteLine(modelID, crsIds.get(index));
  }
}

/**
 * Locate the file's existing IfcProjectedCRS.MapUnit so the writer can
 * re-reference it on the new IfcProjectedCRS — preserving the author's
 * stated unit across a save round-trip instead of rewriting it to METRE.
 *
 * Returns null when (a) the file has no IfcMapConversion, (b) the
 * MapConversion's TargetCRS has no MapUnit set, or (c) the MapUnit's
 * Prefix+Name combination isn't in our conversion table. In all three
 * cases the writer falls back to constructing a fresh IfcSIUnit METRE,
 * matching the pre-fix behaviour. We refuse to preserve an unrecognised
 * MapUnit because we'd have no way to convert the canonical-metres
 * HelmertParams to its on-disk values.
 *
 * Call this *before* removeExistingGeorefIfc4 — that helper deletes the
 * IfcMapConversion we're reading. The MapUnit entity itself (an
 * IfcSIUnit or IfcConversionBasedUnit, typically shared with
 * IfcUnitAssignment) is not cascade-deleted, so the returned expressID
 * stays valid after the remove.
 */
function findPreservableMapUnit(
  ifcAPI: IfcAPI,
  modelID: number,
): { expressID: number; metresPerUnit: number } | null {
  // Prefer the MapConversion's TargetCRS (the common case). Fall back to
  // IfcRigidOperation's TargetCRS for RigidOp-only files (IFC 4.3) — the
  // entity sits under the same IfcCoordinateOperation umbrella and points
  // at the same IfcProjectedCRS shape, so the MapUnit handle is equally
  // valid to preserve. GetLineIDsWithType returns 0 entries on pre-4.3
  // schemas, so the RigidOp branch is a safe no-op on older files.
  const target =
    findFirstTargetCrs(
      ifcAPI,
      modelID,
      IFCMAPCONVERSION,
      /* inherited */ true,
    ) ?? findFirstTargetCrs(ifcAPI, modelID, IFCRIGIDOPERATION, false);
  const mapUnit = target?.MapUnit;
  if (!mapUnit) {
    return null;
  }
  const expressID = expressIDOf(mapUnit);
  if (expressID === null) {
    return null;
  }
  const prefix = String(rawValue(mapUnit.Prefix) ?? "");
  const name = String(rawValue(mapUnit.Name) ?? "");
  if (name.length === 0) {
    return null;
  }
  const metresPerUnit = nameToMetresPerUnit(prefix, name);
  if (metresPerUnit == null) {
    return null;
  }
  return { expressID, metresPerUnit };
}

/**
 * First-resolvable TargetCRS of the given IfcCoordinateOperation subtype.
 * Returns null when no entity exists or the entity carries no TargetCRS.
 * Shared by `findPreservableMapUnit` so both MapConversion and RigidOp
 * paths use the same flatten-and-extract logic.
 */
function findFirstTargetCrs(
  ifcAPI: IfcAPI,
  modelID: number,
  typeId: number,
  includeInherited: boolean,
): any {
  const ids = ifcAPI.GetLineIDsWithType(modelID, typeId, includeInherited);
  const op = firstResolvableLine(ifcAPI, modelID, ids, /* flatten */ true);
  return op?.TargetCRS ?? null;
}

/**
 * Pick the MapUnit entity reference to use for the new IfcProjectedCRS,
 * with its metresPerUnit. Either reuses the file's existing entity by
 * handle (preserving the author's unit) or constructs a fresh
 * IfcSIUnit METRE for files that had no recognised MapUnit.
 */
function resolveMapUnitForWrite(
  ifcAPI: IfcAPI,
  modelID: number,
  preserved: { expressID: number; metresPerUnit: number } | null,
): { mapUnitRef: any; mapUnitMetresPerUnit: number } {
  if (preserved) {
    return {
      mapUnitRef: new Handle(preserved.expressID),
      mapUnitMetresPerUnit: preserved.metresPerUnit,
    };
  }
  // IfcSIUnit STEP attrs are (Dimensions, UnitType, Prefix, Name) but
  // web-ifc's JS constructor takes only (UnitType, Prefix, Name) — the
  // Dimensions slot is implicit (always $ in the serializer). Passing a
  // leading null for Dimensions silently shifts every subsequent arg by
  // one and drops Name, producing `IFCSIUNIT($,$,.LENGTHUNIT.,$)` —
  // which the reader then flags as malformed-with-empty-Name.
  const metreUnit = ifcAPI.CreateIfcEntity(
    modelID,
    IFCSIUNIT,
    { type: 3, value: "LENGTHUNIT" },
    null,
    { type: 3, value: "METRE" },
  );
  return { mapUnitRef: metreUnit, mapUnitMetresPerUnit: 1 };
}

/**
 * Iterate a type-index result and return the first entity GetLine can
 * actually resolve. web-ifc 0.0.77 leaves stale entries in the type
 * index after DeleteLine in the same model session — the type-index
 * IDs survive, but `GetLine` returns undefined for them. Naive
 * `ids.get(0)` followed by `.TargetCRS` then crashes with "Cannot read
 * properties of undefined (reading 'TargetCRS')". Same workaround for
 * write-then-read flows (baked-origin repair) and read paths in
 * general — cheap and safe everywhere.
 */
function firstResolvableLine(
  ifcAPI: IfcAPI,
  modelID: number,
  ids: { size: () => number; get: (index: number) => number },
  flatten: boolean,
): any {
  const total = ids.size();
  for (let index = 0; index < total; index++) {
    const id = ids.get(index);
    let entity: any;
    try {
      entity = ifcAPI.GetLine(modelID, id, flatten);
    } catch {
      continue;
    }
    if (entity) {
      return entity;
    }
  }
  return null;
}
