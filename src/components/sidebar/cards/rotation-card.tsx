import type { HelmertParams } from "#modules/helmert/solve";
import type { IfcMetadata } from "#modules/ifc/worker";
import { Card } from "../card";
import { NumberField } from "../number-field";
import { ProvenanceBadge, type Provenance } from "../provenance-badge";

interface RotationCardProps {
  parameters: HelmertParams | null;
  provenance: Provenance;
  onParametersChange: (next: HelmertParams) => void;
  metadata: IfcMetadata;
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
                  : "↳ FactorX · FactorY"
              }
            />
            
            <NumberField
              label="Vertical scale"
              value={parameters?.zScale ?? null}
              onChange={setVerticalScale}
              isDisabled={!hasParams}
              step={0.0001}
              formatOptions={{ maximumFractionDigits: 6 }}
              description="↳ FactorZ"
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
