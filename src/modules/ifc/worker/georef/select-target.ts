import { isPureTranslation, type HelmertParams } from "#modules/helmert/solve";
import type { IfcSchema } from "../schema";

/**
 * Which IFC entity the writer will emit for a given (schema, params,
 * original-file-state) triple. Single source of truth for the dispatch
 * rule — consumed by the worker's `writeMapConversion` to call the right
 * writer, and by the UI's `predictWriteEntity` to render the "Will write"
 * indicator. Keeping these two in sync mechanically prevents the badge
 * from silently disagreeing with what gets saved.
 *
 * `upgradeFromRigid` only matters on the `IfcMapConversion` branch — it
 * disambiguates "fresh MC" from "the file had a RigidOp but the user
 * introduced rotation/scale so we're upgrading the entity type".
 */
export type WriteTarget =
  | { entity: "ePSet_MapConversion"; note: "" }
  | { entity: "IfcMapConversionScaled"; note: "anisotropic scale" }
  | { entity: "IfcRigidOperation"; note: "translation-only" }
  | { entity: "IfcMapConversion"; note: string; upgradeFromRigid: boolean };

export interface WriteTargetInputs {
  schema: IfcSchema;
  params: HelmertParams;
  /**
   * True when the model on disk carries an `IfcRigidOperation` entity at
   * read time (independent of whether the user has since edited the
   * anchor). Drives the round-trip-preservation rule: keep the entity
   * type when params remain pure-translation, upgrade to MapConversion
   * otherwise.
   *
   * Always false for non-4.3 schemas — the entity didn't exist.
   */
  fileHadRigidOperation: boolean;
}

export function selectWriteTarget({
  schema,
  params,
  fileHadRigidOperation,
}: WriteTargetInputs): WriteTarget {
  if (schema === "IFC2X3") {
    return { entity: "ePSet_MapConversion", note: "" };
  }

  // IFC 4.3 IfcMapConversionScaled is the only entity that can carry
  // per-axis Factors. Any non-isotropic params on 4.3 routes here; on
  // pre-4.3 the params are collapsed to one Scale by the writer (the
  // solver only produces anisotropic params on 4.3 — split fit path).
  const isAnisotropic =
    params.xScale !== params.yScale || params.yScale !== params.zScale;
  if (schema === "IFC4X3" && isAnisotropic) {
    return { entity: "IfcMapConversionScaled", note: "anisotropic scale" };
  }

  // IFC 4.3 round-trip preservation: if the file originally had RigidOp
  // and the user hasn't introduced rotation or scale, save RigidOp again.
  // Any deliberate edit (rotation slider, non-1 scale typed in) crosses
  // `isPureTranslation`'s 1e-9 thresholds and forces the upgrade below.
  if (
    schema === "IFC4X3" &&
    fileHadRigidOperation &&
    isPureTranslation(params)
  ) {
    return { entity: "IfcRigidOperation", note: "translation-only" };
  }

  const upgradeFromRigid = schema === "IFC4X3" && fileHadRigidOperation;
  return {
    entity: "IfcMapConversion",
    note: upgradeFromRigid
      ? `upgraded from IfcRigidOperation — rotation ${params.rotation.toFixed(4)} rad`
      : "",
    upgradeFromRigid,
  };
}
