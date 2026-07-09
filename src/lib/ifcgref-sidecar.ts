/**
 * `.ifcgref.json` sidecar — a portable snapshot of a file's
 * IfcMapConversion + IfcProjectedCRS, so the same georeferencing can be
 * applied to a sibling discipline model (architectural / structural / MEP)
 * without re-deriving the parameters.
 *
 * # Schema evolution
 *
 * The schema is keyed by `formatVersion: 1`. Default rule for changes is
 * **additive only**: new fields land as `.optional()` with a default, so v1
 * sidecars keep parsing under the v2 schema and no migration code is
 * needed. Bump `formatVersion` only on a *breaking* change (rename,
 * removal, semantic shift) — at that point convert the schema to a
 * discriminated union on `formatVersion` and migrate v1 → v2 inside
 * `parseSidecar` before returning. Unknown future versions are rejected
 * with `unsupported-version` so a sidecar from a newer build doesn't get
 * half-parsed by an older one.
 *
 * `app.version` is diagnostic-only and is never branched on.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { CrsDef } from "#modules/crs";
import type { HelmertParams, XYZ } from "#modules/helmert/solve";
import type { IfcSchema } from "#modules/ifc/worker";

const xyzSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const VERSION = 1 as const;

const sidecarSchema = z.object({
  formatVersion: z.literal(VERSION),
  app: z.object({
    name: z.literal("ifcgref"),
    version: z.string(),
  }),
  exportedAt: z.string(),
  source: z.object({
    filename: z.string(),
    schema: z.string(),
    localOrigin: xyzSchema.nullable(),
  }),
  projectedCrs: z.object({
    epsg: z.number().int().positive(),
    name: z.string(),
    description: z.string().nullable(),
    verticalDatum: z.string().nullable(),
  }),
  mapConversion: z.object({
    eastings: z.number(),
    northings: z.number(),
    orthogonalHeight: z.number(),
    xAxisAbscissa: z.number(),
    xAxisOrdinate: z.number(),
    horizontalXScale: z.number(),
    horizontalYScale: z.number(),
    verticalScale: z.number(),
  }),
});

export type Sidecar = z.infer<typeof sidecarSchema>;

interface BuildSidecarInput {
  filename: string;
  schema: IfcSchema;
  localOrigin: XYZ | null;
  activeCrs: CrsDef;
  verticalDatum: string | null;
  parameters: HelmertParams;
}

export function buildSidecar(input: BuildSidecarInput): Sidecar {
  const { parameters: p } = input;
  return {
    formatVersion: VERSION,
    app: { name: "ifcgref", version: __APP_VERSION__ },
    exportedAt: new Date().toISOString(),
    source: {
      filename: input.filename,
      schema: input.schema,
      localOrigin: input.localOrigin,
    },
    projectedCrs: {
      epsg: input.activeCrs.code,
      name: input.activeCrs.name,
      description: input.activeCrs.areaOfUse,
      verticalDatum: input.verticalDatum,
    },
    mapConversion: {
      eastings: p.easting,
      northings: p.northing,
      orthogonalHeight: p.height,
      xAxisAbscissa: Math.cos(p.rotation),
      xAxisOrdinate: Math.sin(p.rotation),
      horizontalXScale: p.xScale,
      horizontalYScale: p.yScale,
      verticalScale: p.zScale,
    },
  };
}

export type SidecarError =
  | { kind: "invalid-json"; cause: unknown }
  | { kind: "unsupported-version"; got: unknown }
  | { kind: "schema-mismatch"; cause: z.ZodError };

export function parseSidecar(text: string): Result<Sidecar, SidecarError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err({ kind: "invalid-json", cause: error });
  }

  // Pre-check version and app before Zod so the user gets a precise error
  // instead of a generic schema mismatch when they hand us, say, a future
  // v2 sidecar or an unrelated JSON file with no `app.name` field.
  if (typeof raw === "object" && raw !== null) {
    const anyRaw = raw as { formatVersion?: unknown; app?: { name?: unknown } };
    if (anyRaw.formatVersion !== undefined && anyRaw.formatVersion !== 1) {
      return err({ kind: "unsupported-version", got: anyRaw.formatVersion });
    }
  }

  const parsed = sidecarSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ kind: "schema-mismatch", cause: parsed.error });
  }
  return ok(parsed.data);
}

/**
 * Reconstruct `HelmertParams` (canonical metres, dimensionless scales)
 * from a parsed sidecar. Rotation is recovered from the cos/sin pair via
 * atan2, mirroring how the worker reads `XAxisAbscissa`/`XAxisOrdinate`
 * out of IfcMapConversion.
 */
export function sidecarToParams(sidecar: Sidecar): HelmertParams {
  const m = sidecar.mapConversion;
  return {
    easting: m.eastings,
    northing: m.northings,
    height: m.orthogonalHeight,
    rotation: Math.atan2(m.xAxisOrdinate, m.xAxisAbscissa),
    xScale: m.horizontalXScale,
    yScale: m.horizontalYScale,
    zScale: m.verticalScale,
  };
}

/**
 * `Foo.ifc` → `Foo.ifcgref.json`. Strips the `.ifc` (case-insensitive) so
 * importing the sidecar back doesn't turn into `Foo.ifc.ifcgref.json`.
 */
export function sidecarFilenameFor(sourceFilename: string): string {
  const stripped = sourceFilename.replace(/\.ifc$/i, "");
  return `${stripped}.ifcgref.json`;
}

/**
 * Strict equality on the local-origin XYZ. A single floating-point bit of
 * difference between source and current origin means the parameters were
 * fitted against a different local frame and re-applying them will land
 * the model in the wrong place. We don't try to be tolerant — the user
 * downstream sees an amber log line, not a hard refusal.
 */
export function localOriginsEqual(a: XYZ | null, b: XYZ | null): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
