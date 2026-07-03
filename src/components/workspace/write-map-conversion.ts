import { type CrsDef, transformProjectedToWgs84 } from "#modules/crs";
import type { HelmertParams } from "#modules/helmert/solve";
import type { IfcFacade } from "#modules/ifc/facade";
import type { SiteReferenceSync } from "#modules/ifc/worker";
import { emitLog } from "../../lib/log";

/**
 * Write IfcMapConversion + IfcProjectedCRS to the open model, computing
 * the IfcSite sync and normalising the vertical datum identically across
 * call sites (save flow vs. immediate worker mutation from the baked-
 * origin repair). Keeping this shared avoids the two places drifting on
 * decisions like "compound CRS encodes datum in Name, so don't write
 * VerticalDatum on top".
 */
export async function writeMapConversionToWorker(arguments_: {
  ifc: IfcFacade;
  parameters: HelmertParams;
  activeCrs: CrsDef;
  verticalDatum: string | null;
}): Promise<void> {
  const { ifc, parameters, activeCrs, verticalDatum } = arguments_;

  const siteReference = deriveSiteReference(activeCrs, parameters);

  // For compound the vertical datum is already encoded in Name, so
  // writing VerticalDatum on top would be redundant (and risks
  // contradicting Name on stale state). For projected, normalise
  // empty/whitespace strings to null so the worker doesn't emit a
  // blank IfcIdentifier.
  const trimmedDatum = verticalDatum?.trim();
  const datumToWrite =
    activeCrs.kind === "compound" || !trimmedDatum ? null : trimmedDatum;

  await ifc.writeMapConversion(
    activeCrs.code,
    datumToWrite,
    parameters,
    siteReference,
    // The IFC2X3 ePset writer expresses E/N/H in the CRS's axis unit;
    // resolved here because the worker has no proj4.
    activeCrs.metresPerUnit,
  );
}

/**
 * Reverse-project (Eastings, Northings) through the target CRS to WGS84
 * so the worker can overwrite IfcSite.RefLatitude/RefLongitude. Returns
 * null if proj4 throws — the MapConversion is still authoritative in that
 * case, so we just skip the sync and log a warning.
 *
 * RefElevation deliberately not synced: see `SiteReferenceSync` docstring
 * for the vertical-datum reasoning.
 */
function deriveSiteReference(
  activeCrs: CrsDef,
  parameters: HelmertParams,
): SiteReferenceSync | null {
  const wgs84 = transformProjectedToWgs84(
    activeCrs,
    parameters.easting,
    parameters.northing,
  );
  if (wgs84.isErr()) {
    emitLog({
      level: "warn",
      message: `Could not reverse-project anchor for IfcSite sync; skipping.`,
    });
    return null;
  }
  return {
    latitude: wgs84.value.latitude,
    longitude: wgs84.value.longitude,
  };
}
