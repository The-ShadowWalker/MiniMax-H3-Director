import React from "react";
import { createRoot } from "react-dom/client";
import { DirectorApp } from "./components/DirectorApp";
import { startBridge, on, request } from "./lib/bridge";
import { installFlushBoundaries } from "./lib/persist";
import { applyH3Grid, applyRefLimits } from "./lib/h3";
import { useDirector } from "./lib/store";
import "./styles.css";

startBridge();
installFlushBoundaries();

// Python is the source of truth for the window grid: it derives these from
// Wan2GP's model_def rather than trusting the literals compiled in here.
on("h3_grid", (d) => {
  applyH3Grid((d || {}) as Record<string, number>);
  useDirector.getState().setToast(null);
});
on("bridge_ready", (d) => {
  const f = d as { found?: string[]; expected?: string[] };
  const ok = (f.found || []).length === (f.expected || []).length;
  useDirector.getState().setBridge(ok, ok
    ? "bridge ready"
    : `bridge INCOMPLETE — missing ${(f.expected || []).filter((x) => !(f.found || []).includes(x)).join(", ")}`);
  console.log("[H3-D] bridge_ready", f);
});
on("bridge_error", (d) => {
  const msg = String((d as { message?: string }).message || "bridge error");
  console.error("[H3-D]", msg);
  useDirector.getState().setBridge(false, msg);
  useDirector.getState().setToast(msg);
});
on("toast", (d) => useDirector.getState().setToast(String((d as { message?: string }).message || "")));

/** The first call fires before the bridge controls exist and before Wan2GP has
 *  built the session, which is why the list was empty until Rescan. Retry with
 *  backoff until models come back. */
async function loadModels(attempt = 0): Promise<void> {
  try {
    const r = await request<{ models: { model_type: string; name: string }[]; limits: Record<string, number> }>(
      "list_models", { model_type: useDirector.getState().advanced?.checkpoint || "" }, 30000,
    );
    if (r?.limits) applyRefLimits(r.limits as never);
    if (r?.models?.length) {
      useDirector.setState({ installedModels: r.models });
      console.log(`[H3-D] ${r.models.length} H3 model(s) installed`);
      return;
    }
  } catch (e) {
    console.warn(`[H3-D] list_models attempt ${attempt + 1} failed`, e);
  }
  if (attempt < 8) {
    setTimeout(() => void loadModels(attempt + 1), Math.min(4000, 500 * (attempt + 1)));
  } else {
    useDirector.getState().setToast("Wan2GP reported no MiniMax H3 models — press Rescan in Generation.");
  }
}
on("bridge_ready", () => void loadModels());   // retry once the bridge is confirmed
void loadModels();
void useDirector.getState().reattachJob();   // a run may still be going from before a refresh

const el = document.getElementById("root");
if (el) createRoot(el).render(<React.StrictMode><DirectorApp /></React.StrictMode>);
