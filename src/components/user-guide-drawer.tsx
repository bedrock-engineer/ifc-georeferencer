import { Cross1Icon } from "@radix-ui/react-icons";
import { Button } from "./input/button";

const style = { gridArea: "guide" };

interface UserGuideDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UserGuideDrawer({ isOpen, onClose }: UserGuideDrawerProps) {
  return (
    <aside
      id="user-guide-drawer"
      aria-label="User guide"
      aria-hidden={!isOpen}
      // The drawer column animates from 0 to 360px; `inert` keeps focus and
      // assistive tech out while the column is collapsed.
      inert={!isOpen}
      style={style}
      className="flex h-full flex-col overflow-hidden border-l border-slate-200 bg-white"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">User guide</h2>

        <Button
          variant="ghost"
          size="sm"
          aria-label="Close user guide"
          onPress={onClose}
        >
          <Cross1Icon />
        </Button>
      </header>

      <div className="min-w-[360px] flex-1 overflow-y-auto px-4 py-4 text-sm text-slate-700">
        <GuideContent />
      </div>
    </aside>
  );
}

function GuideContent() {
  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Load an IFC, pick a target CRS, anchor the model on the map, download a
        georeferenced copy. Your file never leaves your browser.
      </p>

      <Section title="1. Load a file">
        <p>
          Drop an <Code>.ifc</Code> file on the home screen, click{" "}
          <Code>or choose a file</Code>, or hit{" "}
          <Code>Try the MiniBIM demo</Code>. Use{" "}
          <Code>Load different IFC file</Code> in the header to swap files
          without reloading.
        </p>
      </Section>

      <Section title="2. Pick a target CRS">
        <p>
          In the <Code>Target CRS</Code> card, type an EPSG code (e.g.{" "}
          <Code>7415</Code> = RD New + NAP) or part of the CRS name. The
          vertical datum goes in the second field unless you picked a compound
          CRS.
        </p>

        <p>
          If the file already has <Code>IfcProjectedCRS</Code>, the code is
          pre-filled and the model is placed on the map immediately.
        </p>
      </Section>

      <Section title="3. Anchor the model">
        <p>The Reference point tab gives you three ways to set the anchor:</p>
        <ol className="ml-4 list-decimal space-y-1">
          <li>
            <strong>From IfcSite.</strong> If the file has{" "}
            <Code>RefLatitude</Code>/<Code>RefLongitude</Code>, the app projects
            them through the CRS and reads <Code>TrueNorth</Code> for the
            rotation.
          </li>

          <li>
            <strong>Pick on map.</strong> Click <Code>Pick on map</Code>, then
            click where the model belongs. <Kbd>Esc</Kbd> cancels the picking
            action.
          </li>

          <li>
            <strong>Type values directly.</strong> Edit Easting / Northing /
            Orthogonal Height. The map updates live.
          </li>
        </ol>

        <p className="text-xs text-slate-500">
          The top-left address search drops a marker. PDOK for NL, Nominatim
          elsewhere.
        </p>
      </Section>

      <Section title="4. Or fit from survey points">
        <p>
          The Survey points tab does a least-squares fit when you have known
          correspondences. Six columns: engineering <Code>X Y Z</Code> then
          projected <Code>X&apos; Y&apos; Z&apos;</Code>. Paste from Excel, CSV,
          or whitespace-separated text. Click <Code>Solve</Code>.
        </p>

        <p className="text-xs text-slate-500">
          Two or more points give a full 4-parameter horizontal fit. One point
          (or zero plus an <Code>IfcSite</Code> seed) uses{" "}
          <Code>TrueNorth</Code> verbatim and is under-determined. Residuals
          appear under the table after a solve.
        </p>
      </Section>

      <Section title="5. Check rotation & scale">
        <p>
          Rotation is in degrees clockwise from grid north. It's seeded from{" "}
          <Code>TrueNorth</Code> in the file, or from the solver after a
          survey-point fit. If the model looks skew on the map relative to its
          surroundings, nudge the angle until it lines up. The raw{" "}
          <Code>XAxisAbscissa</Code> / <Code>XAxisOrdinate</Code> pair that goes
          into <Code>IfcMapConversion</Code> is shown under the field for
          reference.
        </p>

        <p>
          Pre-4.3 schemas carry a single <Code>Scale</Code>. IFC 4.3 can
          apply a factor to each axis independently via{" "}
          <Code>IfcMapConversionScaled</Code>'s <Code>FactorX/Y/Z</Code>.
          This tool edits them as <Code>Horizontal scale</Code> (X and Y
          together) and <Code>Vertical scale</Code>; when they differ, the
          file is saved with <Code>IfcMapConversionScaled</Code> instead of
          plain <Code>IfcMapConversion</Code>.
        </p>
      </Section>

      <Section title="6. Save">
        <p>
          Click <Code>Download georeferenced IFC</Code>. The writer rewrites
          the georeferencing entities in-browser and offers{" "}
          <Code>{`<name>_georeferenced.ifc`}</Code> as a download. The Save
          card shows which entity will be written:{" "}
          <Code>IfcMapConversion</Code> + <Code>IfcProjectedCRS</Code> on
          IFC4, <Code>IfcMapConversionScaled</Code> (per-axis scale) or{" "}
          <Code>IfcRigidOperation</Code> (translation-only) on IFC 4.3, and
          the <Code>ePSet_MapConversion</Code> property set on{" "}
          <Code>IfcProject</Code> on IFC 2x3.
        </p>

        <p>
          You can use <Code>Download .ifcgref.json</Code> on the Source card to
          save just the georeferencing parameters as a JSON file. You can upload
          this file to another IFC model. This is useful for georeferencing
          multiple files with the same parameters.
        </p>
      </Section>

      <Section title="Map layers & basemaps">
        <p>
          The <Code>Layers</Code> panel in the top-right corner of the map
          controls what the map shows.
        </p>

        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Basemap.</strong> Switch between{" "}
            <Code>OpenStreetMap</Code>, <Code>Topo NL (BRT)</Code>, and{" "}
            <Code>Luchtfoto NL</Code>. The Dutch layers are only available
            when the map is over the Netherlands.
          </li>

          <li>
            <strong>Custom basemap.</strong> Click the <Code>+</Code> next to{" "}
            <Code>Basemap</Code> and enter a name and an XYZ tile URL with{" "}
            <Code>{"{z}/{x}/{y}"}</Code> placeholders (e.g. swisstopo, GRB
            Vlaanderen). Remove one again with the <Code>×</Code> next to its
            name.
          </li>

          <li>
            <strong>X-ray.</strong> Shows IFC geometry below ground
            (basements, pilings) through the terrain. Only applies in 3D
            view, so switch to <Code>3D</Code> first.
          </li>

          <li>
            <strong>Spaces.</strong> The <Code>IFC content</Code> section has
            a <Code>Spaces</Code> checkbox to show or hide{" "}
            <Code>IfcSpace</Code> geometry. It only appears when the file
            contains spaces.
          </li>

          <li>
            <strong>Overlays.</strong> Dutch reference layers (<Code>BGT</Code>
            , <Code>Kadaster</Code>, <Code>2D BAG</Code>, <Code>3D BAG</Code>)
            can be shown on top of the basemap to check the model against its
            surroundings.
          </li>
        </ul>
      </Section>

      <Section title="Diagnostics">
        <p>
          The <Code>Diagnostics</Code> panel at the bottom of the screen logs
          every meaningful IFC read or write: parse summary, georef detection,
          CRS resolution, solver result, save. Open it when something looks
          wrong; the answer is usually in there.
        </p>
      </Section>

      <Section title="Number field shortcuts">
        <ul className="ml-1 space-y-1">
          <ShortcutRow keys={["↑", "↓"]} desc="step by default amount" />

          <ShortcutRow keys={["PgUp", "PgDn"]} desc="step 10×" />

          <ShortcutRow keys={["Home", "End"]} desc="min / max" />

          <ShortcutRow keys={["Scroll"]} desc="step when focused" />
          {/* <ShortcutRow keys={["Esc"]} desc="cancel anchor pick" /> */}
        </ul>
      </Section>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      <div className="space-y-2 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

interface CodeProps {
  children: React.ReactNode;
}

function Code({ children }: CodeProps) {
  return (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800">
      {children}
    </code>
  );
}

interface KbdProps {
  children: React.ReactNode;
}

function Kbd({ children }: KbdProps) {
  return (
    <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
      {children}
    </kbd>
  );
}

interface ShortcutRowProps {
  keys: ReadonlyArray<string>;
  desc: string;
}

function ShortcutRow({ keys, desc }: ShortcutRowProps) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="flex gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      <span className="text-xs text-slate-600">{desc}</span>
    </li>
  );
}
