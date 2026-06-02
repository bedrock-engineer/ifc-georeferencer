import { useState } from "react";
import {
  Button as AriaButton,
  Checkbox,
  Dialog,
  DialogTrigger,
  Input,
  Label,
  OverlayArrow,
  Popover,
  RadioGroup,
  Switch,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components";
import { PlusIcon } from "@radix-ui/react-icons";
import { Button } from "../../input/button";
import { RadioButton } from "../../input/radio-button";
import {
  type CustomBasemap,
  describeCustomBasemapUrlError,
  parseCustomBasemapUrl,
} from "../layers/custom-basemap";
import {
  BASEMAPS,
  OVERLAYS,
  type BasemapId,
  type OverlayId,
} from "../layers/registry";
import type { LayerRegion } from "../layers/types";
import type { MapScope } from "./use-scope";

interface LayersPanelProps {
  basemap: BasemapId;
  overlays: Record<OverlayId, boolean>;
  customBasemaps: ReadonlyArray<CustomBasemap>;
  /** Current geographic scope of the map (tracks `useMapMapScope`). */
  scope: MapScope;
  /** True when the loaded file contains IfcSpace entities. */
  hasSpaces: boolean;
  showSpaces: boolean;
  /** When on, the 3D layer clears the depth buffer before rendering so the
   *  terrain mesh doesn't occlude IFC geometry that sits below ground
   *  (basements, pilings). Only applicable in 3D view. */
  xray: boolean;
  /** Whether the map is currently in 3D view. Drives the x-ray toggle's
   *  enabled state — it has no effect in 2D. */
  isThreeD: boolean;
  onShowSpacesChange: (next: boolean) => void;
  onXrayChange: (next: boolean) => void;
  onBasemapChange: (id: BasemapId) => void;
  onOverlaysChange: (next: Record<OverlayId, boolean>) => void;
  onAddCustomBasemap: (b: CustomBasemap) => void;
  onRemoveCustomBasemap: (id: string) => void;
}

const HEADING =
  "text-[11px] font-semibold uppercase tracking-wider text-slate-500";
// Layout-only classes; focus/disabled/cursor live in the shared RadioButton
// and are mirrored here on the Checkbox row so both rows look the same.
const ROW = "flex items-center gap-1.5 py-0.5";
const CHECKBOX_ROW =
  "group flex cursor-pointer items-center gap-1.5 py-0.5 outline-none data-focus-visible:ring-2 data-focus-visible:ring-slate-500 data-disabled:cursor-not-allowed data-disabled:opacity-50";

const NL_ONLY_TITLE = "Only available in the Netherlands";

function CheckboxIndicator() {
  return (
    <span className="flex size-3 items-center justify-center rounded-sm border border-slate-400 group-data-selected:border-slate-900 group-data-selected:bg-slate-900">
      <svg
        viewBox="0 0 10 10"
        aria-hidden="true"
        className="hidden size-2.5 text-white group-data-selected:block"
      >
        <path
          d="M2 5.2 L4.2 7.4 L8 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

// A layer is unreachable from the current viewport when it has no data
// where the map is looking. We only disable picker rows the user *could*
// toggle — an already-selected NL layer stays enabled so the user can
// always switch away (otherwise they'd be stuck with an undismissable
// overlay until they pan back to NL).
function isOutOfMapScope(region: LayerRegion, scope: MapScope): boolean {
  return region === "nl" && scope === "world";
}

/**
 * Rendered into the map via `PortalControl`. Built-in basemaps + overlays
 * come from the layer registry; custom basemaps are user-added at runtime
 * and live alongside them in the same RadioGroup.
 */
export function LayersPanel({
  basemap,
  overlays,
  customBasemaps,
  scope,
  hasSpaces,
  showSpaces,
  xray,
  isThreeD,
  onShowSpacesChange,
  onXrayChange,
  onBasemapChange,
  onOverlaysChange,
  onAddCustomBasemap,
  onRemoveCustomBasemap,
}: LayersPanelProps) {
  return (
    <div className="min-w-35 space-y-1.5 rounded bg-white p-2.5 text-xs text-slate-900 shadow-[0_0_0_2px_rgba(0,0,0,0.1)]">
      <RadioGroup
        value={basemap}
        onChange={onBasemapChange}
        className="flex flex-col"
      >
        <div className="flex items-center justify-between gap-2">
          <Label className={HEADING}>Basemap</Label>
          <AddCustomBasemapButton
            existingIds={[
              ...BASEMAPS.map((b) => b.id),
              ...customBasemaps.map((b) => b.id),
            ]}
            onAdd={onAddCustomBasemap}
          />
        </div>
        {BASEMAPS.map((b) => {
          const outOfMapScope = isOutOfMapScope(b.region, scope);
          const isActive = b.id === basemap;
          return (
            <RadioButton
              key={b.id}
              value={b.id}
              isDisabled={outOfMapScope && !isActive}
              className={ROW}
            >
              <span title={outOfMapScope ? NL_ONLY_TITLE : undefined}>
                {b.label}
              </span>
            </RadioButton>
          );
        })}
        {customBasemaps.map((b) => (
          <div key={b.id} className="flex items-center gap-1.5">
            <RadioButton value={b.id} className={`${ROW} flex-1 min-w-0`}>
              <span className="truncate" title={b.url}>
                {b.label}
              </span>
            </RadioButton>
            <AriaButton
              aria-label={`Remove ${b.label}`}
              onPress={() => {
                onRemoveCustomBasemap(b.id);
              }}
              className="cursor-pointer rounded px-1 text-slate-400 outline-none hover:text-slate-700 data-focus-visible:ring-2 data-focus-visible:ring-slate-500"
            >
              ×
            </AriaButton>
          </div>
        ))}
      </RadioGroup>
      <Switch
        isSelected={xray}
        onChange={onXrayChange}
        isDisabled={!isThreeD}
        className="group flex cursor-pointer items-center justify-between gap-2 py-0.5 outline-none data-focus-visible:ring-2 data-focus-visible:ring-slate-500 data-disabled:cursor-not-allowed data-disabled:opacity-50"
      >
        <span
          title={
            isThreeD
              ? "Show IFC geometry below ground (basements, pilings) through the terrain mesh."
              : "Only applies in 3D view."
          }
        >
          X-ray
        </span>
        <span className="flex h-3.5 w-6 items-center rounded-full bg-slate-300 px-0.5 transition-colors group-data-selected:bg-slate-900">
          <span className="size-2.5 rounded-full bg-white transition-transform group-data-selected:translate-x-2.5" />
        </span>
      </Switch>
      {hasSpaces && (
        <div className="flex flex-col pt-1">
          <span className={HEADING}>IFC content</span>
          <Checkbox
            isSelected={showSpaces}
            onChange={onShowSpacesChange}
            className={CHECKBOX_ROW}
          >
            <CheckboxIndicator />
            <span>Spaces</span>
          </Checkbox>
        </div>
      )}
      {OVERLAYS.length > 0 && (
        <div className="flex flex-col pt-1">
          <span className={HEADING}>Overlays</span>
          {OVERLAYS.map((o) => {
            const checked = Boolean(overlays[o.id]);
            const outOfMapScope = isOutOfMapScope(o.region, scope);
            return (
              <Checkbox
                key={o.id}
                isSelected={checked}
                isDisabled={outOfMapScope && !checked}
                onChange={(isSelected) => {
                  onOverlaysChange({ ...overlays, [o.id]: isSelected });
                }}
                className={CHECKBOX_ROW}
              >
                <CheckboxIndicator />
                <span title={outOfMapScope ? NL_ONLY_TITLE : undefined}>
                  {o.label}
                </span>
              </Checkbox>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface AddCustomBasemapButtonProps {
  existingIds: ReadonlyArray<string>;
  onAdd: (b: CustomBasemap) => void;
}

function AddCustomBasemapButton({
  existingIds,
  onAdd,
}: AddCustomBasemapButtonProps) {
  return (
    <DialogTrigger>
      <TooltipTrigger delay={300}>
        <AriaButton
          aria-label="Add custom basemap"
          className="flex size-5 cursor-pointer items-center justify-center rounded text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-900 aria-expanded:bg-slate-200 aria-expanded:text-slate-900 data-focus-visible:ring-2 data-focus-visible:ring-slate-500"
        >
          <PlusIcon />
        </AriaButton>
        <Tooltip
          placement="top"
          className="max-w-xs rounded bg-slate-900 px-2 py-1 text-xs text-white shadow-md data-entering:animate-in data-entering:fade-in data-exiting:animate-out data-exiting:fade-out"
        >
          <OverlayArrow>
            <svg width={8} height={8} viewBox="0 0 8 8" className="fill-slate-900">
              <path d="M0 0 L4 4 L8 0" />
            </svg>
          </OverlayArrow>
          Add a custom basemap
        </Tooltip>
      </TooltipTrigger>
      <Popover
        placement="bottom end"
        className="w-72 rounded border border-slate-200 bg-white p-3 shadow-md outline-none"
      >
        <Dialog className="outline-none">
          {({ close }) => (
            <AddCustomBasemapForm
              existingIds={existingIds}
              onAdd={(b) => {
                onAdd(b);
                close();
              }}
              onCancel={close}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

interface AddCustomBasemapFormProps {
  existingIds: ReadonlyArray<string>;
  onAdd: (b: CustomBasemap) => void;
  onCancel: () => void;
}

function AddCustomBasemapForm({
  existingIds,
  onAdd,
  onCancel,
}: AddCustomBasemapFormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  // `null` while the user hasn't tried to submit yet — keeps the fields neutral
  // until they actually commit, instead of nagging on every keystroke.
  const [submittedNameError, setSubmittedNameError] = useState<string | null>(
    null,
  );
  const [submittedUrlError, setSubmittedUrlError] = useState<string | null>(
    null,
  );

  const trimmedName = name.trim();
  const liveUrlResult =
    url.trim().length === 0 ? null : parseCustomBasemapUrl(url);
  const liveUrlError =
    submittedUrlError ??
    (liveUrlResult?.isErr()
      ? describeCustomBasemapUrlError(liveUrlResult.error)
      : null);
  const nameError = submittedNameError;

  function handleSubmit() {
    const urlResult = parseCustomBasemapUrl(url);
    const nameInvalid = trimmedName.length === 0;
    if (nameInvalid) {
      setSubmittedNameError("Enter a name.");
    }
    if (urlResult.isErr()) {
      setSubmittedUrlError(describeCustomBasemapUrlError(urlResult.error));
    }
    if (nameInvalid || urlResult.isErr()) {
      return;
    }
    onAdd({
      id: makeUniqueId(existingIds),
      label: trimmedName,
      url: urlResult.value,
    });
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <TextField
        value={name}
        onChange={(value) => {
          setName(value);
          if (submittedNameError !== null) {
            setSubmittedNameError(null);
          }
        }}
        isInvalid={nameError !== null}
      >
        <Label className="text-xs font-medium text-slate-700">Name</Label>
        <Input
          autoFocus
          placeholder="e.g. GRB Vlaanderen"
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:border-slate-500 data-invalid:border-amber-500"
        />
        <Text
          slot="description"
          className={
            nameError === null
              ? "mt-1 block text-[11px] text-slate-500"
              : "mt-1 block text-[11px] text-amber-700"
          }
        >
          {nameError ?? "Shown in the basemap list."}
        </Text>
      </TextField>

      <TextField
        type="url"
        value={url}
        onChange={(value) => {
          setUrl(value);
          if (submittedUrlError !== null) {
            setSubmittedUrlError(null);
          }
        }}
        isInvalid={liveUrlError !== null}
      >
        <Label className="text-xs font-medium text-slate-700">
          XYZ tile URL
        </Label>
        <Input
          placeholder="https://…/{z}/{x}/{y}.png"
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-slate-500 data-invalid:border-amber-500"
        />
        <Text
          slot="description"
          className={
            liveUrlError === null
              ? "mt-1 block text-[11px] text-slate-500"
              : "mt-1 block text-[11px] text-amber-700"
          }
        >
          {liveUrlError ??
            "Use {z}, {x}, {y} placeholders. Example: swisstopo, GRB Vlaanderen."}
        </Text>
      </TextField>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onPress={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Add
        </Button>
      </div>
    </form>
  );
}

function makeUniqueId(existing: ReadonlyArray<string>): string {
  // Stable enough for client-only state — survives reload via localStorage.
  // Doesn't have to be globally unique, just unique within the panel.
  let candidate: string;
  do {
    candidate = `cb-${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.includes(candidate));
  return candidate;
}
