import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./app.tsx";
import { emitLog } from "#lib/log";
import { prefetchCrsManifest } from "#modules/crs";

// Safety net for promise rejections nobody caught. User-action flows
// (Save, repair, sidecar apply) keep their inline try/catch — they need
// per-card UX feedback the global listener can't give. This catches the
// rest: forgotten `.catch` in new code, background work that rejected
// unexpectedly, anything that would otherwise be a silent dead operation.
// Routes to the ops panel; console.error preserves the stack for the
// (BIM-pro) user who's debugging their own file.
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = event.reason;
  console.error(reason);
  emitLog({
    level: "error",
    message: `Unhandled error: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
});

void prefetchCrsManifest();

const reactScan = false;

// react-scan: dev-only render diagnostics. Vite replaces `import.meta.env.DEV`
// with `false` in production builds, so the dynamic import + the entire branch
// are dead-code-eliminated from the prod bundle.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (import.meta.env.DEV && reactScan) {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
