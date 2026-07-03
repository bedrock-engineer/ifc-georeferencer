import type { CrsDef } from "#modules/crs";
import type { Finding, GeorefView } from "./types";

/**
 * Prose for the IFC log panel. One entry per finding kind.
 *
 * The CRS-scoped messages mention `EPSG:X` so users browsing the log can
 * see *which* CRS was the problem — important when they've toggled
 * through several.
 */
export function findingToLogMessage(finding: Finding): string {
  switch (finding.kind) {
    case "unknown-length-unit": {
      return (
        `Unknown IFC length unit '${finding.unit}' — treated as metres at ` +
        `the worker boundary; numeric values may be off by the unit factor`
      );
    }
    case "baked-projected-origin": {
      const { x, y, z } = finding.origin;
      return (
        `IfcSite.ObjectPlacement at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(1)}) ` +
        `looks like baked-in projected coordinates. Per the IFC4 schema, ` +
        `this offset belongs in IfcMapConversion — the entity that ` +
        `transforms the local engineering coordinate system into the map ` +
        `coordinate reference system — not in IfcSite.ObjectPlacement.`
      );
    }
    case "site-outside-crs": {
      const where =
        `EPSG:${finding.crsCode}` +
        (finding.areaOfUse ? ` (${finding.areaOfUse})` : "");
      const tail = finding.hasExistingGeoref
        ? "— not shown on map."
        : "— pick a different CRS, or use the Survey points tab to enter a known point manually.";
      return (
        `IfcSite RefLat/RefLon (${finding.site.latitude.toFixed(6)}, ${finding.site.longitude.toFixed(6)}) ` +
        `is outside ${where} area of use ${tail}`
      );
    }
    case "helmert-outside-crs": {
      const where =
        `EPSG:${finding.crsCode}` +
        (finding.areaOfUse ? ` (${finding.areaOfUse})` : "");
      const source =
        finding.source === "existing-georef"
          ? "Existing IfcMapConversion"
          : "Anchor parameters";
      return (
        `${source} places geometry outside the area of use for ${where} — ` +
        `likely a placeholder transform. Use the Survey points tab to ` +
        `anchor manually, or switch CRS.`
      );
    }
    case "double-baked-origin": {
      const { x, y, z } = finding.origin;
      const where =
        `EPSG:${finding.crsCode}` +
        (finding.areaOfUse ? ` (${finding.areaOfUse})` : "");
      return (
        `IfcSite.ObjectPlacement at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(1)}) m ` +
        `looks like baked-in projected coordinates *and* an IfcMapConversion ` +
        `is present that carries the same offset — applying the Helmert to ` +
        `the baked local origin places geometry outside the area of use for ` +
        `${where} (double-translation). The offset belongs in ` +
        `IfcMapConversion only; zero IfcSite.ObjectPlacement to resolve.`
      );
    }
    case "grid-degraded": {
      return (
        `Precision grid for EPSG:${finding.crsCode} failed to load — ` +
        `coordinates may be off by ~170 m. Retry from the CRS card.`
      );
    }
    case "ifc-site-seed-available": {
      const { latitude, longitude } = finding.proposal.site;
      const { easting, northing } = finding.proposal.params;
      return (
        `No map conversion in file — IfcSite RefLatitude/RefLongitude ` +
        `(${latitude.toFixed(6)}, ${longitude.toFixed(6)}) can seed the anchor: ` +
        `E ${easting.toFixed(2)}, N ${northing.toFixed(2)} in ` +
        `EPSG:${finding.crsCode}. Review it in the Reference point card — ` +
        `authoring tools often export a placeholder site reference.`
      );
    }
  }
}

/**
 * Reason the AnchorCard pick button is blocked, if any. Cascades through
 * the same priority the inline cascade in workspace.tsx used to: a baked
 * origin is the most actionable problem, then "no CRS yet", then the
 * grid-degraded finding (if present in the view).
 */
export function derivePickBlockedReason(
  view: GeorefView,
  activeCrs: CrsDef | null,
): string | null {
  if (view.bakedProjectedOrigin) {
    return (
      "Pick disabled — see the Source card warning about projected " +
      "coordinates baked into IfcSite.ObjectPlacement."
    );
  }
  if (!activeCrs) {
    return "Set a target CRS before picking an anchor.";
  }
  if (view.findings.some((f) => f.kind === "grid-degraded")) {
    return (
      "Pick disabled: precision grid for this CRS isn't loaded — clicking " +
      "would record a ~170 m–wrong survey point. Retry from the CRS card."
    );
  }
  return null;
}

/**
 * Reason the Save button is blocked, if any. Today only the
 * grid-degraded finding blocks save — keep the function small and let
 * future block-reasons accumulate here as branches.
 *
 * Blocking is reserved for *wrong numbers*: grid-degraded means
 * coordinates land ~170 m off and the user can't tell from looking at
 * the file. Interpretive ambiguities (e.g. missing VerticalDatum on a
 * horizontal-only CRS) go through `deriveSaveWarning` instead — the
 * numbers are what the user typed, only the recipient's interpretation
 * is at risk.
 */
export function deriveSaveBlockedReason(view: GeorefView): string | null {
  const degraded = view.findings.find((f) => f.kind === "grid-degraded");
  if (degraded) {
    return (
      `Save blocked: precision grid for EPSG:${degraded.crsCode} failed to ` +
      `load. Retry from the CRS card.`
    );
  }
  return null;
}

/**
 * Non-blocking warning shown above the Save button. Today: saving with a
 * horizontal-only projected CRS and no VerticalDatum produces a file
 * whose OrthogonalHeight is interpretively ambiguous (recipients have to
 * guess NAP / ellipsoidal / local). We surface this so the user can fix
 * it before saving, but don't refuse the write — they may have chosen
 * the CRS deliberately.
 */
export function deriveSaveWarning(
  activeCrs: CrsDef | null,
  verticalDatum: string | null,
): string | null {
  if (activeCrs?.kind !== "projected") {
    return null;
  }
  const missing = verticalDatum === null || verticalDatum.trim().length === 0;
  if (!missing) {
    return null;
  }
  return (
    "Saving without a vertical datum. Recipients may misinterpret " +
    "OrthogonalHeight. Pick a vertical datum, or use a compound CRS " +
    "(e.g. EPSG:7415)."
  );
}
