import { useRef } from "react";
import { useDirector } from "../lib/store";
import { request } from "../lib/bridge";
import { flushNow } from "../lib/persist";
import { downloadJson, readSessionFile } from "../lib/session";

const H3D2_BUILD = "2.43.1";

export function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useDirector();
  const chip = `${s.pipeline} · ${s.size.replace("Full ", "").replace("Pruned ", "Pruned ")} · AdaLN${s.builder.startBlock}–${s.builder.endBlock} · ${String(s.advanced.resolution).replace("x", "×")}`;

  return (
    <header className="top">
      <div className="mark">
        MiniMax H3 <span>Director</span>
      </div>
      <div className="chipf">
        <span className={s.dirty ? "dot warn" : "dot"} />
        <b>{s.project_name}</b>
        <span style={{ color: "var(--ink3)" }}>{s.savedAt ? `saved ${s.savedAt}` : s.dirty ? "unsaved" : "demo"}</span>
      </div>
      <button
        className="btn sm"
        type="button"
        title="Save the full project zip (settings, timeline and every media file)"
        onClick={async () => {
          try {
            let dir = s.saveDir || "";
            if (!dir) {
              // Nowhere chosen yet - ask, rather than picking for them.
              const pick = await request<{ dir?: string; cancelled?: boolean }>("browse_dir", {}, 180000);
              if (!pick?.dir) { s.setToast("Save cancelled"); return; }
              dir = pick.dir;
              s.patch({ saveDir: dir });
            }
            await flushNow();
            const r = await request<{ ok: boolean; path?: string; incomplete?: string[] }>(
              "save_project_zip", { name: s.project_name, dir }, 180000);
            if (r?.incomplete?.length) s.setToast(`SAVE INCOMPLETE - missing: ${r.incomplete.join(", ")}`);
            else s.setToast(`Saved to ${r?.path || dir}`);
          } catch (e) {
            s.setToast(`Save failed: ${String(e)}`);
          }
        }}
      >
        Save
      </button>
      <button className="btn sm" type="button" title="Choose a different folder and save there"
        onClick={async () => {
          try {
            const pick = await request<{ dir?: string }>("browse_dir", {}, 180000);
            if (!pick?.dir) return;
            s.patch({ saveDir: pick.dir });
            await flushNow();
            const r = await request<{ path?: string }>("save_project_zip",
              { name: s.project_name, dir: pick.dir }, 180000);
            s.setToast(`Saved to ${r?.path || pick.dir}`);
          } catch (e) { s.setToast(`Save failed: ${String(e)}`); }
        }}>
        Save as…
      </button>
      <button className="btn sm" type="button" title="Open a project zip, or a settings .json"
        onClick={async () => {
          // A zip carries the media too, so prefer the native picker for it
          // and fall back to the browser input for a bare .json.
          try {
            const pick = await request<{ path?: string; cancelled?: boolean }>("browse_zip", {}, 180000);
            if (pick?.path) {
              const r = await request<{ payload?: unknown; restored?: number; name?: string;
                media?: Record<string, never>; missing?: string[]; fileBase?: string }>(
                "open_project_zip", { path: pick.path }, 180000);
              if (r?.payload) {
                const { hydrateMedia } = await import("../lib/media");
                hydrateMedia(r.media, r.fileBase, r.missing);
                s.loadSession(r.payload as never);
                s.setToast(`Opened ${r.name} - ${r.restored} media file(s) restored`);
              }
              return;
            }
            if (pick?.cancelled) return;
          } catch { /* no picker - fall through to the browser input */ }
          fileRef.current?.click();
        }}>
        Load
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.json,.h3director.json,application/json,application/zip"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            s.loadSession(await readSessionFile(f));
          } catch (err) {
            s.setToast(err instanceof Error ? err.message : "Could not load");
          }
        }}
      />
      <button className="btn sm" type="button"
        title="Reload the last autosaved project."
        onClick={() => s.recover()}>
        Restore autosave
      </button>
      <div style={{ flex: 1 }} />

      <div className="chipf num">{chip}</div>
      <span className="build-badge" title="Plugin UI build — if this does not match the version in the terminal, the browser is showing a cached bundle">v{H3D2_BUILD}</span>
    </header>
  );
}
