import type { HelmertParams } from "#modules/helmert/solve";
import type { IfcMetadata } from "#modules/ifc/worker";
import { mapConversionUnitFactor } from "#modules/units/convert";
import { Card } from "../card";
import { NumberField } from "../number-field";
import { ProvenanceBadge, type Provenance } from "../provenance-badge";

interface RotationCardProps {
  parameters: HelmertParams | null;
  provenance: Provenance;
  onParametersChange: (next: HelmertParams) => void;
  metadata: IfcMetadata;
}

function formatScale(n: number): string {
  return Number.parseFloat(n.toFixed(6)).toString();
}

export function RotationCard({
  parameters,
  provenance,
  onParametersChange,
  metadata,
}: RotationCardProps) {
  const hasParams = parameters !== null;
  const fromFile = Boolean(metadata.existingGeoref);
  const hasTrueNorth = Boolean(metadata.trueNorth);

  const angleDegrees = parameters
    ? (parameters.rotation * 180) / Math.PI
    : null;
  const abscissa = parameters ? Math.cos(parameters.rotation) : null;
  const ordinate = parameters ? Math.sin(parameters.rotation) : null;

  function setAngleDegrees(value: number) {
    if (!parameters) {
      return;
    }
    onParametersChange({
      ...parameters,
      rotation: (value * Math.PI) / 180,
    });
  }

  // Pre-4.3 schemas only carry one isotropic Scale; show one numberfield.
  // IFC 4.3 carries per-axis factors via IfcMapConversionScaled; show two
  // numberfields ("Horizontal scale" + "Vertical scale"). The pre-4.3
  // fitter (solveHelmertJoint) sets all three equal anyway, so the choice
  // of UI here matches what the file can carry.
  const isIfc43 = metadata.schema === "IFC4X3";

  // True when reading a 4.3 file authored elsewhere with non-conformal XY
  // scaling. We can't represent xScale ≠ yScale through our two-field UI
  // without lying about which axis is which, so we lock the horizontal
  // field and surface the asymmetry as a read-only note. The user has to
  // edit the file in another tool to change it.
  const hasAsymmetricXY =
    parameters !== null && parameters.xScale !== parameters.yScale;

  // The scale fields edit the dimensionless geometric scale (metres in /
  // metres out). The file stores it multiplied by the project-unit → MapUnit
  // ratio, so a "1" here can land as "0.001" in IfcMapConversion.Scale.
  // Surface the literal on-disk value ONLY when the units diverge — when the
  // project is already in MapUnit the note would just restate the input.
  // The MapUnit factor is the exact one the worker used for E/N/H (already
  // reflects absent→METRE / ePset→project-unit), so no re-derivation here.
  const mapMetresPerUnit = metadata.rawProjectedCrs?.metresPerUnit ?? 1;
  const unitFactor = mapConversionUnitFactor(metadata.metresPerUnit, mapMetresPerUnit);
  const mapUnit = metadata.rawProjectedCrs?.mapUnit;

  function writtenScaleNote(geometricScale: number | null): string | null {
    if (geometricScale == null || unitFactor === 1) {
      return null;
    }
    const written = geometricScale * unitFactor;
    const unitCause = mapUnit
      ? ` (${metadata.lengthUnit} → ${mapUnit})`
      : "";
    return `↳ Writes ${formatScale(written)} to file${unitCause}`;
  }

  function setIsotropicScale(value: number) {
    if (!parameters) {
      return;
    }
    onParametersChange({
      ...parameters,
      xScale: value,
      yScale: value,
      zScale: value,
    });
  }

  function setHorizontalScale(value: number) {
    if (!parameters) {
      return;
    }
    onParametersChange({
      ...parameters,
      xScale: value,
      yScale: value,
    });
  }

  function setVerticalScale(value: number) {
    if (!parameters) {
      return;
    }
    onParametersChange({
      ...parameters,
      zScale: value,
    });
  }

  return (
    <Card
      title="Rotation & scale"
      headerAside={<ProvenanceBadge provenance={provenance} />}
      help={
        <>
          <p>
            The model's rotation around the vertical axis, written as{" "}
            <code>XAxisAbscissa</code> / <code>XAxisOrdinate</code>; the
            direction the local +X axis points in the target CRS. The{" "}
            <strong>Rotation</strong> field shows the same value in degrees for
            convenience.
          </p>

          <p>
            The <strong>Scale</strong> field is the dimensionless geometric
            scale: <code>1</code> means no resizing, other values stretch the
            model to fit your control points. The file stores this in{" "}
            <code>IfcMapConversion.Scale</code> multiplied by the ratio between
            your project length unit and the CRS map unit, so a millimetre
            project with a metre-based CRS writes <code>0.001</code> for an
            identity scale. When the two values differ, the note under the field
            shows what actually gets written.
          </p>

          {isIfc43 && (
            <p>
              IFC 4.3 scales each axis independently via{" "}
              <code>IfcMapConversionScaled</code>'s <code>FactorX/Y/Z</code>.{" "}
              <strong>Horizontal scale</strong> sets <code>FactorX</code> and{" "}
              <code>FactorY</code> together; <strong>Vertical scale</strong>{" "}
              sets <code>FactorZ</code>.
            </p>
          )}
        </>
      }
    >
      <div className="space-y-2">
        <NumberField
          label="Rotation"
          value={angleDegrees}
          onChange={setAngleDegrees}
          isDisabled={!hasParams}
          formatOptions={{
            style: "unit",
            unit: "degree",
            maximumFractionDigits: 6,
          }}
          description={
            abscissa === null || ordinate === null ? null : (
              <span className="tabular-nums">
                ↳ XAxisAbscissa {abscissa.toFixed(6)} · XAxisOrdinate{" "}
                {ordinate.toFixed(6)}
              </span>
            )
          }
        />

        {isIfc43 ? (
          <>
            <NumberField
              label="Horizontal scale"
              value={parameters?.xScale ?? null}
              onChange={setHorizontalScale}
              isDisabled={!hasParams || hasAsymmetricXY}
              step={0.0001}
              formatOptions={{ maximumFractionDigits: 6 }}
              description={
                hasAsymmetricXY
                  ? `↳ FactorX ${parameters.xScale} · FactorY ${parameters.yScale} (file-authored anisotropy; not editable here)`
                  : writtenScaleNote(parameters?.xScale ?? null)
              }
            />
            
            <NumberField
              label="Vertical scale"
              value={parameters?.zScale ?? null}
              onChange={setVerticalScale}
              isDisabled={!hasParams}
              step={0.0001}
              formatOptions={{ maximumFractionDigits: 6 }}
              description={writtenScaleNote(parameters?.zScale ?? null)}
            />
          </>
        ) : (
          <NumberField
            label="Scale"
            value={parameters?.xScale ?? null}
            onChange={setIsotropicScale}
            isDisabled={!hasParams}
            step={0.0001}
            formatOptions={{ maximumFractionDigits: 6 }}
            description={writtenScaleNote(parameters?.xScale ?? null)}
          />
        )}
      </div>

      {!hasTrueNorth && !fromFile && (
        <p className="text-xs italic text-slate-500">
          No TrueNorth in file — assuming grid-aligned. Add survey points or
          edit if the model is rotated.
        </p>
      )}
    </Card>
  );
}
