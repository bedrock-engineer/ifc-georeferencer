import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import type { RawRigidOperation } from "#modules/ifc/worker";
import { Row } from "./row";

function trimZeros(n: number, maxDecimals: number): string {
  return Number.parseFloat(n.toFixed(maxDecimals)).toString();
}

/**
 * Where this IfcRigidOperation sits in the active-transform decision:
 *  - `active`     → drives `existingGeoref` (no usable IfcMapConversion)
 *  - `overridden` → present, but IfcMapConversion drives instead
 *  - `inactive`   → present but target is non-projected (geographic) so the
 *                   map pipeline can't position it; no driver role available
 *
 * Drives the heading badge and the FirstCoordinate / SecondCoordinate unit
 * suffix (only labelled when active, since that's the only case where the
 * MapUnit boundary is meaningful for the user to verify).
 */
type RigidOperationRole = "active" | "overridden" | "inactive";

interface RigidOperationSectionProps {
  raw: RawRigidOperation | null;
  role: RigidOperationRole;
  /** Short symbol for the MapUnit. Used only when role is "active". */
  mapUnitShort: string;
}

/**
 * IFC 4.3 IfcRigidOperation — translation-only sibling of IfcMapConversion.
 * Hidden when no entity is in the file (most files); when present, the
 * heading badge reflects whether this entity is driving the anchor or has
 * been overridden by a sibling IfcMapConversion.
 */
export function RigidOperationSection({
  raw,
  role,
  mapUnitShort,
}: RigidOperationSectionProps) {
  if (raw == null) {
    return null;
  }

  return (
    <Disclosure defaultExpanded>
      <Heading level={3}>
        <Button
          slot="trigger"
          className="group flex w-full items-center gap-2 rounded text-left text-xs font-semibold text-slate-700 outline-none transition-colors duration-150 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          <span className="transition-transform group-aria-expanded:rotate-90">
            ▸
          </span>
          <span className="flex-1">IfcRigidOperation</span>
          {role === "active" && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
              active transform
            </span>
          )}
          {role === "overridden" && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700">
              overridden by IfcMapConversion
            </span>
          )}
          {role === "inactive" && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              non-projected target — not positioned
            </span>
          )}
        </Button>
      </Heading>

      <DisclosurePanel>
        <dl className="mt-2 space-y-1 border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          <Row
            label="FirstCoordinate"
            value={
              role === "active"
                ? `${trimZeros(raw.firstCoordinate, 3)} ${mapUnitShort}`
                : trimZeros(raw.firstCoordinate, 3)
            }
          />

          <Row
            label="SecondCoordinate"
            value={
              role === "active"
                ? `${trimZeros(raw.secondCoordinate, 3)} ${mapUnitShort}`
                : trimZeros(raw.secondCoordinate, 3)
            }
          />

          <Row
            label="Height"
            value={
              raw.height == null
                ? "—" // prettier-ignore
                : (role === "active"
                  ? `${trimZeros(raw.height, 3)} ${mapUnitShort}`
                  : trimZeros(raw.height, 3))
            }
          />
          <Row label="TargetCRS" value={raw.targetCrsName ?? "—"} />
        </dl>
      </DisclosurePanel>
    </Disclosure>
  );
}
