import { useMemo } from "react";
import { Button } from "../../input/button";
import type { HelmertParams } from "#modules/helmert/solve";
import {
  type AnchorValidation,
  type CrsDef,
  validateProjectedAnchor,
} from "#modules/crs";
import {
  describeCrsUnit,
  numberFieldFormatForIntl,
} from "#modules/units/format";
import { CardHelpButton } from "../help-popover";
import { NumberField } from "../number-field";
import { ProvenanceBadge, type Provenance } from "../provenance-badge";
import type { SeedProposal } from "#state/georef-status/types";

interface AnchorCardProps {
  parameters: HelmertParams | null;
  /**
   * Resolved target CRS, used to sanity-check the typed Easting/Northing
   * against the published area of use. `null` when no CRS is resolved yet —
   * the validation simply doesn't run.
   */
  activeCrs: CrsDef | null;
  provenance: Provenance;
  isPicking: boolean;
  canResetToFile: boolean;
  /**
   * If non-null, the map-click pick is disabled because committing a
   * WGS84-derived value through degraded transforms would produce a
   * ~170 m–wrong survey point. See docs/crs-datum-grids.md (Q11).
   */
  pickBlockedReason?: string | null;
  /**
   * IfcSite-derived anchor seed on offer — rendered as an inline
   * accept/ignore prompt instead of auto-filling the fields, because
   * site refs are often placeholders. Null once anchored or dismissed.
   */
  seedProposal: SeedProposal | null;
  onAcceptSeed: () => void;
  onDismissSeed: () => void;
  onEdit: (next: HelmertParams) => void;
  onStartPick: () => void;
  onCancelPick: () => void;
  onResetToFile: () => void;
}

export function AnchorCard({
  parameters,
  activeCrs,
  provenance,
  isPicking,
  canResetToFile,
  pickBlockedReason,
  seedProposal,
  onAcceptSeed,
  onDismissSeed,
  onEdit,
  onStartPick,
  onCancelPick,
  onResetToFile,
}: AnchorCardProps) {
  const hasParams = parameters !== null;
  const pickDisabled = pickBlockedReason != null;

  const validation = useMemo<AnchorValidation>(() => {
    if (
      !parameters ||
      !activeCrs ||
      !Number.isFinite(parameters.easting) ||
      !Number.isFinite(parameters.northing)
    ) {
      return { kind: "ok" };
    }
    return validateProjectedAnchor({
      easting: parameters.easting,
      northing: parameters.northing,
      def: activeCrs,
    });
  }, [parameters, activeCrs]);

  const isInvalid = validation.kind !== "ok";
  const errorMessage =
    isInvalid && activeCrs ? describeValidation(validation, activeCrs) : null;

  // Display E/N/H in the active CRS's axis unit. NumberField uses
  // Intl.NumberFormat for the suffix only — it does NOT convert the
  // value. We divide canonical metres by `metresPerUnit` on the way in
  // so the displayed digits match the CRS axis unit, and multiply back
  // on `onChange` so internal HelmertParams stay metres-canonical.
  // Pre-CRS-resolution (`activeCrs == null`) the factor is 1, the unit
  // is unknown, and the field renders as plain decimal in metres.
  const crsUnitFormat = useMemo(
    () => numberFieldFormatForIntl(describeCrsUnit(activeCrs).intl),
    [activeCrs],
  );
  const crsMetresPerUnit = activeCrs?.metresPerUnit ?? 1;

  const eastingNative =
    parameters?.easting == null ? null : parameters.easting / crsMetresPerUnit;
  const northingNative =
    parameters?.northing == null
      ? null
      : parameters.northing / crsMetresPerUnit;
  const heightNative =
    parameters?.height == null ? null : parameters.height / crsMetresPerUnit;

  function updateEasting(value: number) {
    if (!parameters) {
      return;
    }
    onEdit({ ...parameters, easting: value * crsMetresPerUnit });
  }
  function updateNorthing(value: number) {
    if (!parameters) {
      return;
    }
    onEdit({ ...parameters, northing: value * crsMetresPerUnit });
  }
  function updateHeight(value: number) {
    if (!parameters) {
      return;
    }
    onEdit({ ...parameters, height: value * crsMetresPerUnit });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-1">
        <CardHelpButton label="Help: Reference point">
          <p>
            Where the model's local origin sits in the target CRS: Easting,
            Northing, and Orthogonal Height.
          </p>
          <p>
            Edit the fields directly, or click <strong>Pick on map</strong> and
            click a location to set Easting/Northing from there.
          </p>
          <p>
            <strong>Reset to file</strong> restores the values from the original
            IFC.
          </p>
        </CardHelpButton>
        <ProvenanceBadge provenance={provenance} />
      </div>

      {seedProposal && !isPicking && (
        <SeedProposalNotice
          proposal={seedProposal}
          activeCrs={activeCrs}
          onAccept={onAcceptSeed}
          onDismiss={onDismissSeed}
        />
      )}

      <div className="space-y-2">
        <NumberField
          label="Easting"
          value={eastingNative}
          onChange={updateEasting}
          isDisabled={!hasParams}
          isInvalid={isInvalid}
          formatOptions={crsUnitFormat}
        />

        <NumberField
          label="Northing"
          value={northingNative}
          onChange={updateNorthing}
          isDisabled={!hasParams}
          isInvalid={isInvalid}
          errorMessage={errorMessage}
          formatOptions={crsUnitFormat}
        />

        <NumberField
          label="Orthogonal Height"
          value={heightNative}
          onChange={updateHeight}
          isDisabled={!hasParams}
          formatOptions={crsUnitFormat}
        />
      </div>

      <div className="flex gap-2">
        <Button
          variant={isPicking ? "warning" : "secondary"}
          size="sm"
          onPress={isPicking ? onCancelPick : onStartPick}
          isDisabled={!isPicking && pickDisabled}
          className="flex-1"
        >
          {isPicking ? "Cancel pick" : "Pick on map"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          isDisabled={!canResetToFile || isPicking}
          onPress={onResetToFile}
          className="flex-1"
        >
          Reset to file
        </Button>
      </div>

      {isPicking && (
        <p className="text-xs text-amber-700">
          Click the map to set the anchor. Press Esc to cancel.
        </p>
      )}

      {pickBlockedReason && !isPicking && (
        <p className="text-xs text-red-700">{pickBlockedReason}</p>
      )}
    </div>
  );
}

interface SeedProposalNoticeProps {
  proposal: SeedProposal;
  activeCrs: CrsDef | null;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * Inline accept/ignore prompt for the IfcSite-derived anchor seed. The
 * seed is deliberately not auto-applied: RefLatitude/RefLongitude is
 * whatever the authoring tool exported, and placeholder locations are
 * common (Revit's untouched default is in Boston). The IfcSite marker is
 * already on the map, so the user can eyeball it before committing.
 */
function SeedProposalNotice({
  proposal,
  activeCrs,
  onAccept,
  onDismiss,
}: SeedProposalNoticeProps) {
  const { latitude, longitude } = proposal.site;
  const metresPerUnit = activeCrs?.metresPerUnit ?? 1;
  const unit = describeCrsUnit(activeCrs).short;
  const easting = (proposal.params.easting / metresPerUnit).toFixed(2);
  const northing = (proposal.params.northing / metresPerUnit).toFixed(2);

  return (
    <div className="space-y-2 rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
      <p>
        This file locates its IfcSite at {formatLatitude(latitude)},{" "}
        {formatLongitude(longitude)} — Easting {easting} {unit}, Northing{" "}
        {northing} {unit} in the target CRS.
      </p>
      <p>
        Authoring tools often export a placeholder location. Check the IfcSite
        marker on the map before using it as the anchor.
      </p>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onPress={onAccept}>
          Use as anchor
        </Button>
        <Button variant="secondary" size="sm" onPress={onDismiss}>
          Ignore
        </Button>
      </div>
    </div>
  );
}

function formatLatitude(latitude: number): string {
  return `${Math.abs(latitude).toFixed(6)}°${latitude >= 0 ? "N" : "S"}`;
}

function formatLongitude(longitude: number): string {
  return `${Math.abs(longitude).toFixed(6)}°${longitude >= 0 ? "E" : "W"}`;
}

function describeValidation(
  validation: AnchorValidation,
  def: CrsDef,
): string | null {
  if (validation.kind === "outside-area-of-use") {
    const area = def.areaOfUse ? ` (${def.areaOfUse})` : "";
    return (
      `Easting/Northing falls outside EPSG:${def.code}'s area of use${area}.` +
      ` Likely wrong CRS — check the CRS card.`
    );
  }
  if (validation.kind === "inverse-failed") {
    return (
      `Easting/Northing can't be inverse-projected in EPSG:${def.code}.` +
      ` This value is likely out-of-range for the chosen projected CRS.`
    );
  }
  return null;
}
