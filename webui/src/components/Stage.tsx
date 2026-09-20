type SessionPayloadLike = Record<string, unknown>;
import { useEffect, useRef, useState, type ReactNode } from "react";
import { helpFor } from "../lib/help";
import { useDirector, usePromptWindowMismatches, useWindowStats } from "../lib/store";
import {
  ATTENTION_CHOICES,
  CACHE_TYPES,
  FBC_STRENGTHS,
  FL2VA_GUIDE,
  PIPELINE_CHOICES,
  PRIORITY_CHOICES,
  RESOLUTIONS,
  SAMPLE_SOLVERS,
  SIZE_CHOICES,
  TEXT_ENCODER_CHOICES,
  VIDEO_VAE_CHOICES,
  type AdvTab,
  type RefMod,
} from "../lib/types";
import { assembleWanSettings, downloadJson } from "../lib/session";
import { H3, LIMITS } from "../lib/h3";
import { registerMedia, getMedia, acceptAttr, fmtDuration, kindOf, servedUrl } from "../lib/media";
import { request, send } from "../lib/bridge";
import { PromptBox } from "./PromptBox";
import { Confirm } from "./Confirm";

function Row({
  label,
  children,
  value,
  help,
}: {
  label: string;
  children?: ReactNode;
  value?: string;
  help?: string;
}) {
  // Hover help comes from the shared table keyed by label, so a control gets
  // explained by being labelled rather than by someone remembering a title
  // attribute at each call site. `help` overrides it where a row needs its own.
  const tip = help ?? helpFor(label);
  return (
    <div className="row" title={tip}>
      <label className={tip ? "has-help" : undefined}>{label}</label>
      {children}
      {value != null && <span className="v num">{value}</span>}
    </div>
  );
}

export function Stage() {
  const s = useDirector();
  return (
    <main className="stage">
      {s.pane === "project" && <ProjectPane />}
      {s.pane === "refs" && <RefsPane />}
      {s.pane === "audio" && <AudioPane />}
      {s.pane === "gen" && <GenPane />}
      {s.pane === "sfx" && <SfxPane />}
      {s.pane === "export" && <ExportPane />}
      {s.pane === "builder" && <BuilderPane />}
      {s.pane === "diag" && <DiagPane />}
    </main>
  );
}

function ProjectPane() {
  const s = useDirector();
  const [saveDir, setSaveDir] = useState(s.saveDir || "");
  const [saveName, setSaveName] = useState(s.project_name || "project");
  const [busy, setBusy] = useState("");
  const [recent, setRecent] = useState<{ name: string; path: string; modified: string }[]>([]);
  const [newArm, setNewArm] = useState(false);

  const saveZip = async () => {
    setBusy("Saving...");
    try {
      const r = await request<{ ok: boolean; path?: string; incomplete?: string[] }>(
        "save_project_zip", { name: saveName, dir: saveDir }, 120000,
      );
      if (r?.incomplete?.length) {
        s.setToast(`SAVE INCOMPLETE — missing: ${r.incomplete.join(", ")}`);
      } else {
        s.patch({ saveDir });
        s.setToast(`Saved to ${r?.path || saveDir}`);
      }
    } catch (e) {
      s.setToast(`Save failed: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const pickDir = async () => {
    try {
      const r = await request<{ dir?: string; cancelled?: boolean }>("browse_dir", {}, 180000);
      if (r?.dir) { setSaveDir(r.dir); s.patch({ saveDir: r.dir }); }
      else if (r?.cancelled) s.setToast("Folder pick cancelled");
    } catch {
      s.setToast("No folder picker available — type the path instead");
    }
  };

  return (
    <div className="pane on">
      <div className="bar"><h2>Project</h2></div>

      <div className="card">
        <h4>Identity</h4>
        <Row label="Project name">
          <input type="text" value={s.project_name} onChange={(e) => { s.patch({ project_name: e.target.value }); setSaveName(e.target.value); }} />
        </Row>
        <div className="note ok">Duration and FPS live in the timeline toolbar, where you can see their effect.</div>
      </div>

      <div className="card">
        <h4>Autosave</h4>
        <Row label="Status">
          <span className={`v ${s.bridgeOk === false ? "bad" : s.bridgeOk ? "good" : ""}`}>
            {s.bridgeOk === false
              ? "NOT CONNECTED — nothing is being written"
              : s.bridgeOk === null
                ? "waiting for first write..."
                : s.saveInfo || "connected"}
          </span>
        </Row>
        <Row label="">
          <button className="btn sm" type="button" onClick={() => void s.saveNow()}>Save now</button>
          <button className="btn sm" type="button" onClick={() => s.recover()}>Recover last autosave</button>
        </Row>
        <div className="note">
          Autosave writes <code>workspace/project.json</code> only — never media, never a zip.
          It fires about a second after you stop editing, and always before Generate.
        </div>
      </div>

      <div className="card">
        <h4>Open a saved project</h4>
        <Row label="">
          <button className="btn sm" type="button" onClick={async () => {
            try {
              const pick = await request<{ path?: string; cancelled?: boolean }>("browse_zip", {}, 180000);
              if (!pick?.path) return;
              const r = await request<{ payload?: SessionPayloadLike; restored?: number; name?: string; media?: Record<string, never>; missing?: string[]; fileBase?: string }>(
                "open_project_zip", { path: pick.path }, 180000);
              if (r?.payload) {
                const { hydrateMedia } = await import("../lib/media");
                hydrateMedia(r.media, r.fileBase, r.missing);
                s.loadSession(r.payload as never);
                s.setToast(`Opened ${r.name} — ${r.restored} media file(s) restored`);
              }
            } catch (e) { s.setToast(`Open failed: ${String(e)}`); }
          }}>Browse for a project zip…</button>
          <button className="btn sm" type="button" onClick={async () => {
            try {
              const r = await request<{ projects: { name: string; path: string; modified: string }[]; dir: string }>("list_projects", { dir: saveDir }, 30000);
              setRecent(r?.projects || []);
              if (!r?.projects?.length) s.setToast(`No projects in ${r?.dir}`);
            } catch (e) { s.setToast(`Could not list: ${String(e)}`); }
          }}>List recent</button>
        </Row>
        {!!recent.length && (
          <div className="gen-log">
            {recent.map((pr) => (
              <div key={pr.path} className="logline">
                <button className="btn sm" type="button" onClick={async () => {
                  try {
                    const r = await request<{ payload?: unknown; restored?: number; name?: string; media?: Record<string, never>; missing?: string[]; fileBase?: string }>(
                      "open_project_zip", { path: pr.path }, 180000);
                    if (r?.payload) {
                      const { hydrateMedia } = await import("../lib/media");
                      hydrateMedia(r.media, r.fileBase, r.missing);
                      s.loadSession(r.payload as never);
                      s.setToast(`Opened ${r.name} — ${r.restored} media file(s) restored`);
                      setRecent([]);
                    }
                  } catch (e) { s.setToast(`Open failed: ${String(e)}`); }
                }}>Open</button>{" "}
                {pr.name} <span className="num" style={{ color: "var(--ink3)" }}>{pr.modified}</span>
              </div>
            ))}
          </div>
        )}
        <div className="note">Opening a project clears the workspace and unpacks everything from the zip.</div>
      </div>

      <div className="card">
        <h4>Save project (full zip)</h4>
        <Row label="File name">
          <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="project name" />
        </Row>
        <Row label="Save folder">
          <input type="text" value={saveDir} onChange={(e) => setSaveDir(e.target.value)} placeholder="leave blank for the plugin's projects folder" />
          <button className="btn sm" type="button" onClick={() => void pickDir()}>Browse</button>
        </Row>
        <Row label="">
          <button className="btn sm go" type="button" disabled={!!busy} onClick={() => void saveZip()}>
            {busy || "Save project zip"}
          </button>
          <button className="btn sm" type="button" onClick={() => downloadJson(s.saveNow())}>Download JSON</button>
        </Row>
        <div className="note">The zip carries the settings, the timeline and every media file, so the project survives even if the originals move.</div>
      </div>

      <Confirm
        open={newArm}
        title="Start a new project?"
        body="This clears the timeline, media, references, prompts and sound design, and wipes the workspace folder. Your model, PDD setting, resolution, size and sampling are kept. Save the project first if you want to come back to it."
        confirmLabel="Clear and start new"
        onCancel={() => setNewArm(false)}
        onConfirm={async () => {
          setNewArm(false);
          try { await request("new_project", { confirmed: true }, 60000); } catch { /* local only */ }
          s.newProject();
        }}
      />

      <div className="card">
        <h4>Workspace</h4>
        <Row label="">
          <button className="btn sm" type="button" onClick={async () => {
            try {
              const r = await request<{ removed: string[]; freed: number }>("prune_media", {}, 60000);
              if (!r?.removed?.length) { s.setToast("Nothing unused to clean up"); return; }
              const go = await request<{ removed: string[]; freed: number }>("prune_media", { confirmed: true }, 60000);
              s.setToast(`Removed ${go.removed.length} unused file(s), reclaimed ${(go.freed / 1048576).toFixed(1)} MB`);
            } catch (e) { s.setToast(`Cleanup failed: ${String(e)}`); }
          }}>Clean unused media</button>
        </Row>
        <div className="note">
          Only the project currently open lives in <code>workspace/</code>. This removes media
          nothing references any more; anything added in the last ten minutes is left alone so an
          undo is still safe.
        </div>
      </div>

      <div className="card">
        <h4>Session</h4>
        <div className="note">
          New project clears the timeline, media, references, prompts and sound design, and wipes
          the workspace. It <b>keeps</b> your model, PDD setting, resolution, size and sampling —
          those carry over so you can start the next piece straight away.
        </div>
        <Row label="">
          <button className="btn sm" type="button" onClick={() => s.resetDemo()}>Load demo</button>
          <button className="btn sm" type="button" onClick={() => setNewArm(true)}>New project</button>
        </Row>
      </div>
    </div>
  );
}

function MiniWave({ peaks }: { peaks: number[] }) {
  if (!peaks.length) return <span>{"\u266A"}</span>;
  const N = 34;
  return (
    <svg viewBox={`0 0 ${N} 20`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
      {Array.from({ length: N }).map((_, i) => {
        const p = peaks[Math.floor((i / N) * peaks.length)] || 0;
        const h = Math.max(1, p * 18);
        return <rect key={i} x={i} y={(20 - h) / 2} width={0.7} height={h} fill="var(--sig)" />;
      })}
    </svg>
  );
}

/** Open a reference in the viewer.
 *
 *  Always opens, even when the file is gone: passing the media id through as
 *  `need:` lets the viewer say "no longer on disk" rather than the click
 *  appearing to be ignored, which is what happened before -- a reference whose
 *  file had not been restored simply swallowed both the double-click and the
 *  zoom button. */
function openRefPreview(
  s: { setPreview: (p: { url: string; kind: string; name: string }) => void },
  kind: "image" | "video" | "audio",
  ref: { mediaId?: string; url?: string; name?: string },
) {
  const mi = getMedia(ref.mediaId);
  const url = mi?.url || servedUrl(mi) || (ref.mediaId ? `need:${ref.mediaId}` : ref.url || "need:");
  s.setPreview({ url, kind, name: ref.name || "reference" });
}

function RefsPane() {
  const s = useDirector();
  const fileRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);
  const audRef = useRef<HTMLInputElement>(null);
  const total = s.refs.images.length + s.refs.videos.length + s.refs.audio.length;

  /** Route by what the file IS, so dropping anywhere in the pane works. */
  const addAnyRefFiles = async (files: File[]) => {
    const imgs: File[] = [], vids: File[] = [], auds: File[] = [], other: File[] = [];
    for (const f of files) {
      const k = kindOf(f);
      (k === "image" ? imgs : k === "video" ? vids : k === "audio" ? auds : other).push(f);
    }
    if (imgs.length) await addRefFiles(imgs);
    if (vids.length) await addRefVideos(vids);
    if (auds.length) await addRefAudio(auds);
    for (const f of other) s.setToast(`${f.name} is not an image, video or audio file`);
  };

  const addRefFiles = async (files: File[]) => {
    for (const f of files) {
      const m = await registerMedia(f);
      if (m.kind !== "image") { s.setToast(`${f.name} is not an image`); continue; }
      if (s.refs.images.length >= H3.MAX_REF_IMAGES) { s.setToast(`Reference images are capped at ${H3.MAX_REF_IMAGES}`); break; }
      s.addRefImage({ id: `r_${m.mediaId}`, mediaId: m.mediaId, name: f.name.replace(/\.[^.]+$/, ""),
        label: f.name.split(/[._]/)[0] ?? "ref", url: m.url });
    }
  };
  const addRefVideos = async (files: File[]) => {
    for (const f of files) {
      const m = await registerMedia(f);
      if (m.kind !== "video") { s.setToast(`${f.name} is not a video`); continue; }
      if (s.refs.videos.length >= LIMITS.videos) { s.setToast(`Wan2GP accepts ${LIMITS.videos} reference video(s) for this model`); break; }
      s.patchRefs({ videos: [...s.refs.videos, { id: `rv_${m.mediaId}`, mediaId: m.mediaId, name: f.name, url: m.url, durationSec: m.durationSec }] });
    }
  };
  const addRefAudio = async (files: File[]) => {
    for (const f of files) {
      const m = await registerMedia(f);
      if (m.kind !== "audio") { s.setToast(`${f.name} is not an audio file`); continue; }
      if (s.refs.audio.length >= LIMITS.audio) { s.setToast(`Wan2GP accepts ${LIMITS.audio} reference audio file(s) for this model`); break; }
      s.patchRefs({ audio: [...s.refs.audio, { id: `ra_${m.mediaId}`, mediaId: m.mediaId, name: f.name, url: m.url, durationSec: m.durationSec }] });
    }
  };

  const drag = useRef<number | null>(null);
  const selected = s.selectedRef != null ? s.refs.images[s.selectedRef] : undefined;

  return (
    <div className="pane on">
      <div className="bar">
        <h2>References</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <span className="pill">Images {s.refs.images.length}/9</span>
          <span className="pill">Video {s.refs.videos.length}/3</span>
          <span className="pill">Audio {s.refs.audio.length}/3</span>
          <span className={`pill${total > 12 ? " w" : total >= 7 ? " w" : ""}`}>Total {total}/12</span>
        </div>
      </div>
      <div className="grp">
        <div className="gl">
          <h3>Images</h3>
          <em>drag to reorder · #1 is the main subject</em>
          <div className="sp">
            <button className="btn sm" type="button" disabled={!selected} onClick={() => selected && s.makeRefFirst(selected.id)}>
              Make #1
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={!selected}
              onClick={() => selected && s.removeRefImage(selected.id)}
            >
              Remove
            </button>
            <button className="btn sm" type="button" onClick={() => s.patchRefs({ images: [] })}>
              Clear all
            </button>
          </div>
        </div>
        <Row label="Reference strength" value={`${Number(s.advanced.image_refs_relative_size ?? 100)}%`}>
          <input type="range" min={50} max={400} step={5}
            value={Number(s.advanced.image_refs_relative_size ?? 100)}
            onChange={(e) => s.patchAdvanced({ image_refs_relative_size: Number(e.target.value) })} />
        </Row>
        <p className="hint">
          How large the sheets are rendered into the conditioning. Raise it when a reference is not
          asserting itself — especially on a bridge, where the continuation carries the source
          clip's look and can drown out the sheets.
        </p>
        <div
          className="refs dropzone"
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("over"); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("over")}
          onDrop={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove("over");
            void addRefFiles(Array.from(e.dataTransfer.files || []));
          }}
        >
          {s.refs.images.map((r, i) => (
            <div
              key={r.id}
              className={`ref${s.selectedRef === i ? " sel" : ""}`}
              draggable
              onClick={() => s.selectRef(i)}
              onDragStart={() => {
                drag.current = i;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                // A tile covers most of the zone, so a dropped FILE lands here
                // far more often than on the empty area. Handle it instead of
                // swallowing the event as a failed reorder.
                if (e.dataTransfer?.files?.length) {
                  e.preventDefault();
                  e.stopPropagation();
                  void addRefFiles(Array.from(e.dataTransfer.files));
                  drag.current = null;
                  return;
                }
                if (drag.current != null) s.reorderRefs(drag.current, i);
                drag.current = null;
              }}
            >
              <div
                className="th"
                title="Double-click to view it full size"
                onDoubleClick={(ev) => { ev.stopPropagation(); openRefPreview(s, "image", r); }}
              >{(() => {
                const mi = getMedia(r.mediaId);
                if (mi?.missing) return <span className="miss" title="File not on disk">!</span>;
                const src = mi?.thumb || servedUrl(mi) || r.url;
                return src ? <img src={src} alt="" /> : r.label;
              })()}</div>
              <button type="button" className="zoom-b" title="View full size"
                onClick={(ev) => { ev.stopPropagation(); openRefPreview(s, "image", r); }}>⤢</button>
              <div className="mt">
                <span className="ix num">{i + 1}</span>
                <span className="nm">{r.name}</span>
              </div>
            </div>
          ))}
          {s.refs.images.length < H3.MAX_REF_IMAGES && (
            <button className="slot" type="button" onClick={() => fileRef.current?.click()}>
              + add image or drop here
              <br />
              {H3.MAX_REF_IMAGES - s.refs.images.length} left
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={acceptAttr(["image"])}
          multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void addRefFiles(fs); }}
        />
        <Row label="Reference detail" value={`${s.refs.imageDetail}%`}>
          <input
            type="range"
            min={10}
            max={100}
            value={s.refs.imageDetail}
            onChange={(e) => s.patchRefs({ imageDetail: Number(e.target.value) })}
          />
        </Row>
        <Row label="Remove background">
          <input type="checkbox" checked={s.refs.removeBg} onChange={(e) => s.patchRefs({ removeBg: e.target.checked })} />
          <span style={{ flex: 1 }} />
        </Row>
      </div>
      <div className="grp">
        <div className="gl">
          <h3>Reference video</h3>
          <em>2–15s each · 15s combined</em>
        </div>
        <div
          className="refs dropzone"
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("over"); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("over")}
          onDrop={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.remove("over"); void addRefVideos(Array.from(e.dataTransfer.files || [])); }}
        >
          {s.refs.videos.map((v) => {
            const m = getMedia(v.mediaId);
            return (
              <div key={v.id} className="ref">
                <div
                  className="th"
                  title="Double-click to play it"
                  onDoubleClick={() => openRefPreview(s, "video", v)}
                >{m?.missing ? <span className="miss">!</span> : m?.thumb ? <img src={m.thumb} alt="" /> : "\u25B6"}</div>
                <button type="button" className="zoom-b" title="View full size"
                  onClick={() => openRefPreview(s, "video", v)}>⤢</button>
                <div className="mt">
                  <span className="nm">{v.name}</span>
                  <span className="ix num">{m?.durationSec ? fmtDuration(m.durationSec) : ""}</span>
                </div>
                <button type="button" className="x-b" title="Remove"
                  onClick={() => s.patchRefs({ videos: s.refs.videos.filter((q) => q.id !== v.id) })}>×</button>
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, 3 - s.refs.videos.length) }).map((_, i) => {
            const slotNo = s.refs.videos.length + i + 1;
            const blocked = slotNo > LIMITS.videos;   // read from Wan2GP's own model_def
            return (
              <button key={i} className={`slot${blocked ? " off" : ""}`} type="button" disabled={blocked}
                title={blocked ? `Wan2GP reports ${LIMITS.videos} reference video slot(s) for this model (${LIMITS.source}). This slot enables itself if that changes.` : ""}
                onClick={() => !blocked && vidRef.current?.click()}>
                + clip {slotNo}
                {blocked && <><br /><small>waiting on Wan2GP</small></>}
              </button>
            );
          })}
        </div>
        <input
          ref={vidRef}
          type="file"
          hidden
          accept={acceptAttr(["video"])}
          multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void addRefVideos(fs); }}
        />
      </div>
      <div className="grp">
        <div className="gl">
          <h3>Reference audio</h3>
          <em>voice samples · 2–15s each</em>
        </div>
        <div
          className="refs dropzone"
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("over"); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("over")}
          onDrop={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.remove("over"); void addRefAudio(Array.from(e.dataTransfer.files || [])); }}
        >
          {s.refs.audio.map((v) => {
            const m = getMedia(v.mediaId);
            return (
              <div key={v.id} className="ref">
                <div
                  className="th mini-wave"
                  title="Double-click to play it"
                  onDoubleClick={() => openRefPreview(s, "audio", v)}
                ><MiniWave peaks={m?.peaks || []} /></div>
                <button type="button" className="zoom-b" title="Play"
                  onClick={() => openRefPreview(s, "audio", v)}>⤢</button>
                <div className="mt">
                  <span className="nm">{v.name}</span>
                  <span className="ix num">{m?.durationSec ? fmtDuration(m.durationSec) : ""}</span>
                </div>
                <button type="button" className="x-b" title="Remove"
                  onClick={() => s.patchRefs({ audio: s.refs.audio.filter((q) => q.id !== v.id) })}>×</button>
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, 3 - s.refs.audio.length) }).map((_, i) => {
            const slotNo = s.refs.audio.length + i + 1;
            const blocked = slotNo > LIMITS.audio;
            return (
              <button key={i} className={`slot${blocked ? " off" : ""}`} type="button" disabled={blocked}
                title={blocked ? `Wan2GP reports ${LIMITS.audio} reference audio slot(s) for this model (${LIMITS.source}).` : ""}
                onClick={() => !blocked && audRef.current?.click()}>
                + voice {slotNo}
                {blocked && <><br /><small>waiting on Wan2GP</small></>}
              </button>
            );
          })}
        </div>
        <input
          ref={audRef}
          type="file"
          hidden
          accept={acceptAttr(["audio"])}
          multiple
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void addRefAudio(fs);
          }}
        />
        <div className="note">Voice samples only shape audio the model generates. With a guidance track supplied, they have no effect.</div>
      </div>
      <RefModsGroup />
    </div>
  );
}

/** Saved reference mods (RefMods).
 *
 *  A RefMod is a reference image or video that has already been VAE-encoded
 *  and saved to a small file, so it can be reused without keeping the original
 *  picture around. They are made and stored by a separate Wan2GP plugin --
 *  "MiniMax H3 RefMods" -- and some people prefer working that way to
 *  attaching the reference images themselves. Both can be used at once.
 *
 *  Picks stack in order, each with its own strength, the same way the LoRA
 *  list works, because the order they apply in is something you want to
 *  control. Nothing is shown here that the library does not really hold: with
 *  the plugin absent, this says so rather than offering an empty picker.
 */
type RefModInfo = {
  name: string;
  kind: string;
  mode: string;
  tokens: number;
  description: string;
  size_mb: number;
};
type RefModList = { available: boolean; why: string; mods: RefModInfo[] };

const refmodCache: { list: RefModList | null } = { list: null };

function useRefMods() {
  const [list, setList] = useState<RefModList | null>(refmodCache.list);
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    setBusy(true);
    try {
      const r = await request<RefModList>("list_refmods", {}, 30000);
      refmodCache.list = r;
      setList(r);
    } catch (e) {
      const bad: RefModList = { available: false, why: String(e), mods: [] };
      refmodCache.list = bad;
      setList(bad);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (refmodCache.list) { setList(refmodCache.list); return; }
    void reload();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
  return { list, busy, reload };
}

/** A copy of `rows` with the entry at `i` moved one place in `dir`. Not
 *  generic: a bare `<T>` reads as a JSX element to the build guard's scanner,
 *  and this list only ever holds one kind of row. */
function moved(rows: RefMod[], i: number, dir: number): RefMod[] {
  const out = [...rows];
  const j = i + dir;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function RefModsGroup() {
  const s = useDirector();
  const { list, busy, reload } = useRefMods();
  const picked = s.refs.refmods || [];
  const library = list?.mods || [];
  const byName = new Map(library.map((m) => [m.name, m]));
  const unused = library.filter((m) => !picked.some((p) => p.name === m.name));

  const set = (rows: typeof picked) => s.patchRefs({ refmods: rows });

  return (
    <div className="grp">
      <div className="gl">
        <h3>Saved reference mods</h3>
        <em>pre-encoded references · applied in order</em>
      </div>

      {list && !list.available && (
        <div className="note">
          {list.why}. Mods are made and saved by the <b>MiniMax H3 RefMods</b> plugin;
          install and enable it in Wan2GP and they appear here.
          <button className="btn sm" type="button" style={{ marginLeft: 8 }}
            disabled={busy} onClick={() => void reload()}>
            {busy ? "Looking…" : "Look again"}
          </button>
        </div>
      )}

      {list && list.available && (
        <>
          <div className="lora-stack">
            {picked.map((row, i) => {
              const info = byName.get(row.name);
              return (
                <div className="lora on" key={row.name + i}>
                  <div className="lora-head">
                    <span className="lora-ord" title="Apply order">{i + 1}</span>
                    <span className="lora-name" title={info?.description || row.name}>{row.name}</span>
                    <span className="pill" title={info
                      ? `${info.kind} mod${info.mode ? ", " + info.mode + " mode" : ""}, ${info.tokens} tokens`
                      : "This mod is no longer in the library — it will be skipped"}>
                      {info ? info.kind : "missing"}
                    </span>
                    <button className="btn sm" type="button" disabled={i === 0}
                      title="Apply this mod earlier"
                      onClick={() => set(moved(picked, i, -1))}>&uarr;</button>
                    <button className="btn sm" type="button" disabled={i === picked.length - 1}
                      title="Apply this mod later"
                      onClick={() => set(moved(picked, i, 1))}>&darr;</button>
                    <button className="btn sm warn" type="button" title="Remove this mod"
                      onClick={() => set(picked.filter((_, j) => j !== i))}>&times;</button>
                  </div>
                  <div className="lora-w">
                    <Row label="Strength" value={row.strength.toFixed(2)}>
                      <input
                        type="range" min={0} max={2} step={0.05} value={row.strength}
                        title="How strongly this mod is applied. 1.00 is the strength it was saved at."
                        onChange={(e) => set(picked.map((r, j) =>
                          j === i ? { ...r, strength: Number(e.target.value) } : r))}
                      />
                    </Row>
                  </div>
                </div>
              );
            })}
            {picked.length === 0 && (
              <div className="note">
                {library.length === 0
                  ? "The RefMods plugin is installed but you have not saved any mods yet."
                  : "No mods picked — the reference images above are used on their own."}
              </div>
            )}
          </div>

          {unused.length > 0 && (
            <div className="row" style={{ marginTop: 9 }}>
              <label>Add a mod</label>
              <select
                value=""
                title="Each mod you pick is added below the last. The order here is the order they are applied in."
                onChange={(e) => {
                  const name = e.target.value;
                  if (name) set([...picked, { name, strength: 1 }]);
                }}
              >
                <option value="">Pick a saved mod…</option>
                {unused.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} — {m.kind}{m.mode ? ` · ${m.mode}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {picked.length > 0 && (
            <Row label="Overall strength"
                 value={(s.refs.refmodRetention ?? 1).toFixed(2)}>
              <input
                type="range" min={0} max={2} step={0.05}
                value={s.refs.refmodRetention ?? 1}
                title="One multiplier over every mod's own strength. Useful for easing the whole set back without touching each slider."
                onChange={(e) => s.patchRefs({ refmodRetention: Number(e.target.value) })}
              />
            </Row>
          )}

          <div className="note">
            Only the <b>first sliding window</b> receives these. Later windows continue from the
            previous window's own frames, so a mod re-applied at every boundary would show up as a
            visible jump — the RefMods plugin injects on window 1 only, and H3 Director keeps that
            behaviour.
          </div>
        </>
      )}
    </div>
  );
}

function AudioPane() {
  const s = useDirector();
  return (
    <div className="pane on">
      <div className="bar">
        <h2>Audio</h2>
      </div>
      <div className="card">
        <h4>Exclude from generated audio</h4>
        <div className="note">
          These only apply when <b>no audio source is attached</b> — then H3 generates the whole
          soundscape. With a song or clip audio supplied, that track is the output and nothing is
          generated, so the toggles are ignored.
        </div>
        <div className="two">
          {([
            ["gen_no_music", "No music", "Generated music cannot be separated out afterwards."],
            ["gen_no_speech", "No speech or vocals", "Stops invented dialogue and singing."],
            ["gen_no_ambience", "No room tone", "Effects only, no background bed."],
            ["gen_no_effects", "No effects", "Ambience only."],
          ] as [string, string, string][]).map(([k, label, hint]) => (
            <Row key={k} label={label}>
              <input type="checkbox" checked={!!s.advanced[k]}
                onChange={(e) => s.patchAdvanced({ [k]: e.target.checked })} />
              <span className="hint" style={{ flex: 1 }}>{hint}</span>
            </Row>
          ))}
        </div>
        <div className="note">
          Added to the prompt only when it is sent — what you typed is never changed. H3 has no
          negative prompt, so exclusions have to be stated as directions.
        </div>
      </div>

      <div className="card">
        <h4>Guidance</h4>
        <div className="note">
          Both audio lanes mix to one guidance track before generation. Longest wins, so a short clip can't truncate the song.
        </div>
      </div>
      <div className="card">
        <h4>Original music</h4>
        <div className="note ok">Kept untouched and exported separately. Sound design never overwrites it.</div>
      </div>
    </div>
  );
}

interface BridgeSummaryData {
  hasBridges: boolean; clipFrames: number; generateFrames: number; totalFrames: number;
  plans: { id: string; mode: string; seconds: number; valid: boolean; warning?: string }[];
  invalid: string[];
}

/** With bridges on the guidance track the output length comes from the GAPS,
 *  not the timeline. Without them, nothing changes. */
function BridgeSummary() {
  const s = useDirector();
  const [d, setD] = useState<BridgeSummaryData | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<BridgeSummaryData>("plan_bridges", {
          fps: s.fps,
          window: s.timeline.slidingWindowSize,
          overlap: s.timeline.slidingWindowOverlap,
          segments: s.timeline.segments.map((x) => ({
            id: x.id, track: x.track, start: x.start, length: x.length,
            mediaId: x.mediaId, prompt: x.prompt, title: x.title, fileName: x.fileName,
          })),
        }, 30000);
        setD(r || null);
      } catch { setD(null); }
    })();
  }, [s.timeline.segments, s.fps, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap]);

  if (!d?.hasBridges) return null;
  const f = (n: number) => `${(n / s.fps).toFixed(2)}s`;
  return (
    <div className="note ok" style={{ marginBottom: 8 }}>
      <b>Bridge mode.</b> Length comes from the gaps, not the timeline.
      {" "}Generating {f(d.generateFrames)} across {d.plans.filter((p) => p.valid).length} gap(s);
      {" "}{f(d.clipFrames)} of existing clip is kept as-is, joining to {f(d.totalFrames)}.
      {d.invalid.length > 0 && (
        <> {d.invalid.length} gap(s) have nothing to bridge and are skipped.</>
      )}
    </div>
  );
}

function GenPane() {

  const statusRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const jobStatus = useDirector((z) => z.job.status);
  const logCount = useDirector((z) => z.job.logs.length);
  useEffect(() => {
    if (jobStatus === "running") statusRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [jobStatus]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // follow the tail
  }, [logCount]);

  const s = useDirector();
  const stats = useWindowStats();
  const tabs: { id: AdvTab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "loras", label: "LoRAs" },
    { id: "skip", label: "Steps skipping" },
    { id: "post", label: "Post processing" },
    { id: "quality", label: "Quality" },
    { id: "window", label: "Sliding window" },
    { id: "misc", label: "Misc" },
  ];
  const groups = [...new Set(RESOLUTIONS.map((r) => r.group))];
  const group = String(s.advanced.resolution_category || "720p");
  const resInGroup = RESOLUTIONS.filter((r) => r.group === group);

  return (
    <div className="pane on">
      <div className="bar">
        <h2>Generation</h2>

        <span className="pill">Est. {stats.minutes} min</span>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={s.advTab === t.id ? "on" : ""} onClick={() => s.setAdvTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {s.advTab === "general" && (
        <>
          <div className="card">
            <BridgeSummary />
            <h4>Global prompt</h4>
            <PromptBox
              label="Global prompt"
              rows={4}
              value={s.global_prompt}
              placeholder="Applies to every window that has no prompt of its own. Style, look, camera language."
              onChange={(v) => s.patch({ global_prompt: v })}
            />
            <div className="note">
              Used as the body for any shot with an empty prompt, and prepended to the relay.
              Per-shot prompts on the timeline override it.
            </div>
          </div>

          <div className="card">
            <h4>Model</h4>
            <Row label="PDD 8-step">
              <input
                type="checkbox"
                checked={!!s.advanced.pdd}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (on) {
                    // PDD locks steps to 8, one guidance phase and Euler.
                    // Remember what they were, so turning it off is a real undo.
                    s.patchAdvanced({
                      pdd: true,
                      pre_pdd: {
                        steps: s.advanced.steps,
                        guidance_phases: s.advanced.guidance_phases,
                        sample_solver: s.advanced.sample_solver ?? s.advanced.solver,
                        solver: s.advanced.solver,
                      },
                      steps: 8,
                      guidance_phases: 1,
                      sample_solver: "euler",
                      solver: "euler",
                    });
                  } else {
                    // Turning PDD off used to set only `pdd: false` and leave
                    // steps at 8, so the generation still ran as an 8-step PDD
                    // job. Put back what was there, or the normal defaults.
                    const prev = (s.advanced.pre_pdd || {}) as Record<string, unknown>;
                    const prevSteps = Number(prev.steps);
                    const prevPhases = Number(prev.guidance_phases);
                    s.patchAdvanced({
                      pdd: false,
                      steps: Number.isFinite(prevSteps) && prevSteps > 0 && prevSteps !== 8
                        ? prevSteps : H3.STEPS_DEFAULT,
                      guidance_phases: Number.isFinite(prevPhases) && prevPhases > 0
                        ? prevPhases : 1,
                      sample_solver: String(prev.sample_solver || "euler"),
                      solver: String(prev.solver || prev.sample_solver || "euler"),
                      pre_pdd: undefined,
                    });
                    s.setToast(`PDD off — back to ${
                      Number.isFinite(prevSteps) && prevSteps > 0 && prevSteps !== 8
                        ? prevSteps : H3.STEPS_DEFAULT} steps`);
                  }
                }}
              />
              <span className="hint" style={{ flex: 1 }}>
                {s.advanced.pdd
                  ? "8 steps, 1 phase, Euler — locked by the PDD checkpoint."
                  : "Merges four learned denoising intervals per step: 32 intervals in 8 evaluations."}
              </span>
            </Row>
            <div className="two">
              <Row label="Pipeline">
                <select value={s.pipeline} onChange={(e) => s.patch({ pipeline: e.target.value as typeof s.pipeline })}>
                  {PIPELINE_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.value}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Size">
                <select value={s.size} onChange={(e) => s.patch({ size: e.target.value as typeof s.size })}>
                  {SIZE_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.value}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Checkpoint / finetune">
              <select value={String(s.advanced.checkpoint ?? "")} onChange={(e) => s.patchAdvanced({ checkpoint: e.target.value })}>
                <option value="">Auto (first match for pipeline + size)</option>
                {s.installedModels.map((mm) => (
                  <option key={mm.model_type} value={mm.model_type}>
                    {mm.name}{mm.pipeline ? ` — ${mm.pipeline} / ${mm.size}` : ""}{(mm as { finetune?: boolean }).finetune ? " (finetune)" : ""} [{mm.model_type}]
                  </option>
                ))}
              </select>
            </Row>
            <Row label="">
              <button className="btn sm" type="button" onClick={async () => {
                try {
                  const r = await request<{ models: { model_type: string; name: string }[]; limits: Record<string, number> }>("list_models", { model_type: s.advanced.checkpoint || "" }, 30000);
                  const { applyRefLimits } = await import("../lib/h3");
                  if (r?.limits) applyRefLimits(r.limits as never);
                  useDirector.setState({ installedModels: r?.models || [] });
                  s.setToast(`${r?.models?.length || 0} H3 model(s) found`);
                } catch (e) { s.setToast(`Rescan failed: ${String(e)}`); }
              }}>Rescan models</button>
            </Row>
            {!s.installedModels.length && (
              <div className="note">Wan2GP reported no MiniMax H3 models. Press Rescan, or open Diagnostics and press Check media, which lists every model Wan2GP knows and marks which were matched.</div>
            )}
              <Row label="Resolution">
                <select
                  value={String(s.advanced.resolution)}
                  onChange={(e) => {
                    const hit = RESOLUTIONS.find((r) => r.value === e.target.value);
                    s.patchAdvanced({ resolution: e.target.value, resolution_category: hit?.group ?? group });
                  }}
                >
                  {resInGroup.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Row>
            </div>
            <Row label="Category">
              <select
                value={group}
                onChange={(e) => {
                  const g = e.target.value;
                  const first = RESOLUTIONS.find((r) => r.group === g);
                  s.patchAdvanced({ resolution_category: g, resolution: first?.value ?? s.advanced.resolution });
                }}
              >
                {groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </Row>
          </div>
          <div className="card">
            <h4>Sampling</h4>
            {s.advanced.pdd && (
              <div className="note">Steps, guidance phases and the solver are fixed by the PDD checkpoint.</div>
            )}
            <GuidancePhases />
            <div className="two">
              <Row label="Number of Inference Steps" value={String(s.advanced.steps)}>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={Number(s.advanced.steps)}
                  disabled={!!s.advanced.pdd}
                onChange={(e) => s.patchAdvanced({ steps: Number(e.target.value) })}
                />
              </Row>
        <Row label="Seed">
                <input type="text" value={String(s.advanced.seed)} onChange={(e) => s.patchAdvanced({ seed: Number(e.target.value) })} />
              </Row>
              <Row label="Flow Shift" value={Number(s.advanced.flowshift).toFixed(1)}>
                <input
                  type="range"
                  min={1}
                  max={25}
                  step={0.5}
                  value={Number(s.advanced.flowshift)}
                  onChange={(e) => s.patchAdvanced({ flowshift: Number(e.target.value) })}
                />
              </Row>
              <Row label="Guidance scale" value={Number(s.advanced.guidance).toFixed(1)}>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={0.1}
                  value={Number(s.advanced.guidance)}
                  onChange={(e) => s.patchAdvanced({ guidance: Number(e.target.value) })}
                />
              </Row>
              <Row label="Sample Solver">
                <select value={String(s.advanced.solver ?? "euler")} disabled={!!s.advanced.pdd}
                  onChange={(e) => s.patchAdvanced({ solver: e.target.value, sample_solver: e.target.value })}>
                  {/* VALUES must be exactly what pipeline.py accepts:
                      euler | er_sde | res_multistep | ralston_2s */}
                  <option value="euler">Euler</option>
                  <option value="er_sde">ER SDE</option>
                  <option value="res_multistep">RES Multistep</option>
                  <option value="ralston_2s">Ralston 2S (~2x slower)</option>
                </select>
              </Row>
              <Row label="Videos per prompt" value={String(s.advanced.repeat)}>
                <input
                  type="range"
                  min={1}
                  max={25}
                  value={Number(s.advanced.repeat)}
                  onChange={(e) => s.patchAdvanced({ repeat: Number(e.target.value) })}
                />
              </Row>
            </div>
            {s.pipeline === "FL2VA" && (
              <Row label="Control / inject">
                <select value={String(s.advanced.fl2va_guide_mode)} onChange={(e) => s.patchAdvanced({ fl2va_guide_mode: e.target.value })}>
                  {FL2VA_GUIDE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            <Row label="Hard-cuts">
              <input
                type="text"
                placeholder="window numbers, e.g. 2,4"
                value={s.hardcuts}
                onChange={(e) => s.patch({ hardcuts: e.target.value })}
              />
            </Row>
          </div>
          <div className={`card${s.job.status === "running" ? " status-live" : ""}`} ref={statusRef}>
            <h4>Status {s.job.status === "running" ? "\u00b7 running" : ""}</h4>
            <div className={`prog ${s.job.status === "error" ? "err" : s.job.status === "idle" ? "idle" : ""}`}>
              <span style={{ width: `${Math.max(s.job.status === "running" ? 2 : 0, Math.round((s.job.progress || 0) * 100))}%` }} />
            </div>
            {(() => {
              const j = s.job as typeof s.job & {
                phase?: string; detail?: string; step?: number | null; steps?: number | null;
                unit?: string; elapsed?: number;
              };
              const pretty = (p?: string) =>
                ({ encoding_text: "Encoding the prompt", inference: "Denoising",
                   inference_stage_1: "Denoising (stage 1)", inference_stage_2: "Denoising (stage 2)",
                   inference_stage_3: "Denoising (stage 3)", decoding: "Decoding video",
                   finished: "Finished" } as Record<string, string>)[p || ""] ||
                (p ? p.replace(/_/g, " ") : "");
              const mm = Math.floor((j.elapsed || 0) / 60);
              const ss = Math.round((j.elapsed || 0) % 60);
              return (
                <>
                  <div className="row" style={{ marginTop: 8 }}>
                    <label>Doing</label>
                    <span className="v">
                      {pretty(j.phase) || (s.job.status === "running" ? "Starting…" : "—")}
                      {j.step && j.steps ? ` — ${j.unit || "step"} ${j.step} of ${j.steps}` : ""}
                    </span>
                  </div>
                  <div className="row">
                    <label>Window</label>
                    <span className="v num">
                      {s.job.windows ? `${s.job.windowIndex + 1} of ${s.job.windows}` : "—"}
                    </span>
                  </div>
                  <div className="row">
                    <label>State</label>
                    <span className={`v ${s.job.status === "error" ? "bad" : s.job.status === "done" ? "good" : ""}`}>
                      {s.job.status} · {Math.round((s.job.progress || 0) * 100)}% · {mm}:{String(ss).padStart(2, "0")} elapsed
                    </span>
                  </div>
                  {j.detail && (
                    <div className="row"><label>Detail</label><span className="v">{j.detail}</span></div>
                  )}
                </>
              );
            })()}
            {s.bridgeOk === false && (
              <div className="logline err">No Wan2GP bridge — nothing will actually run.</div>
            )}
            <div className="gen-log" ref={logRef}>
              {s.job.logs.length === 0 && <div className="logline">Idle. Press Generate to start.</div>}
              {s.job.logs.map((l, i) => (
                <div key={i} className={`logline ${l.level}`}>{l.msg}</div>
              ))}
            </div>
            {!!(s.job as { files?: string[] }).files?.length && (
              <div className="note ok">Output: {((s.job as { files?: string[] }).files || []).join(", ")}</div>
            )}
          </div>
        </>
      )}
      {s.advTab === "loras" && <LoraTab />}
      {s.advTab === "skip" && (
        <div className="card">
          <h4>Steps skipping</h4>
          <Row label="Cache">
            <select value={String(s.advanced.cache_type)} onChange={(e) => s.patchAdvanced({ cache_type: e.target.value })}>
              {CACHE_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Starts after %" value={String(s.advanced.cache_start)}>
            <input
              type="range"
              min={0}
              max={100}
              value={Number(s.advanced.cache_start)}
              onChange={(e) => s.patchAdvanced({ cache_start: Number(e.target.value) })}
            />
          </Row>
          {s.advanced.cache_type === "spectrum" && (
            <Row label="Spectrum skip" value={Number(s.advanced.cache_mult).toFixed(2)}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={Number(s.advanced.cache_mult)}
                onChange={(e) => s.patchAdvanced({ cache_mult: Number(e.target.value) })}
              />
            </Row>
          )}
          {s.advanced.cache_type === "first_block" && (
            <Row label="FBC threshold">
              <select
                value={String(s.advanced.cache_strength)}
                onChange={(e) => s.patchAdvanced({ cache_strength: Number(e.target.value) })}
              >
                {FBC_STRENGTHS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
          )}
        </div>
      )}
      {s.advTab === "post" && (
        <div className="card">
          <h4>Post processing</h4>
          <div className="two">
            <Row label="Temporal Upsampling">
              <select value={String(s.advanced.temporal_upsampling ?? "")} onChange={(e) => s.patchAdvanced({ temporal_upsampling: e.target.value })}>
                <option value="">Disabled</option>
                <option value="rife2">RIFE x2</option>
                <option value="rife4">RIFE x4</option>
              </select>
            </Row>
            <Row label="Spatial Upsampling">
              <select value={String(s.advanced.spatial_upsampling ?? "")} onChange={(e) => s.patchAdvanced({ spatial_upsampling: e.target.value })}>
                <option value="">Disabled</option>
                <option value="lanczos1.5">Lanczos x1.5</option>
                <option value="lanczos2">Lanczos x2</option>
              </select>
            </Row>
            <Row label="Film Grain Intensity">
              <input type="number" min={0} max={1} step={0.01} value={Number(s.advanced.film_grain_intensity ?? 0)}
                onChange={(e) => s.patchAdvanced({ film_grain_intensity: Number(e.target.value) })} />
            </Row>
            <Row label="Film Grain Saturation">
              <input type="number" min={0} max={1} step={0.01} value={Number(s.advanced.film_grain_saturation ?? 0.5)}
                onChange={(e) => s.patchAdvanced({ film_grain_saturation: Number(e.target.value) })} />
            </Row>
          </div>
          <div className="note">
            Upsampler values are "&lt;method&gt;&lt;multiplier&gt;" strings; empty means disabled.
            Film grain is off while intensity is 0.
          </div>
        </div>
      )}
      {s.advTab === "quality" && (
        <>
          <div className="card">
            <h4>Quality</h4>
            <div className="two">
              <Row label="Self Refiner">
                <select value={String(s.advanced.self_refiner_setting ?? 0)} onChange={(e) => s.patchAdvanced({ self_refiner_setting: Number(e.target.value) })}>
                  <option value="0">Off</option>
                  <option value="1">On</option>
                  <option value="2">On (stronger)</option>
                </select>
              </Row>
              <Row label="Min Frames If References">
                <input type="number" min={0} step={1} value={Number(s.advanced.min_frames_if_references ?? 0)}
                  onChange={(e) => s.patchAdvanced({ min_frames_if_references: Number(e.target.value) })} />
              </Row>
            </div>
            <div className="note">
              H3 shows only these two. Perturbation, CFG zero/star, adaptive projected guidance and
              motion amplitude are gated on flags H3 does not declare, so Wan2GP hides them too.
            </div>
          </div>
          <div className="card">
            <h4>H3 specific</h4>
            <div className="two">
              <Row label="Mask Denoising Mode">
                <select value={String(s.advanced.h3_mask_mode ?? "grouped_rows")} onChange={(e) => s.patchAdvanced({ h3_mask_mode: e.target.value })}>
                  <option value="grouped_rows">Grouped rows</option>
                  <option value="shared_timestep">Shared timestep</option>
                </select>
              </Row>
              <Row label="Audio Refinement Extra Phase">
                <select value={String(s.advanced.h3_audio_refinement ?? "none")} onChange={(e) => s.patchAdvanced({ h3_audio_refinement: e.target.value })}>
                  <option value="none">None</option>
                  <option value="enabled">Enabled (6 extra steps, denoising 0.5)</option>
                </select>
              </Row>
            </div>
            <div className="note">
              Mask denoising mode only applies with a control video. Audio refinement is hidden by
              Wan2GP when the audio prompt carries A or K outside reference mode.
            </div>
          </div>
          <div className="card" data-moved="window">
            <h4>Sliding window</h4>
            <div className="note">
              Window {s.timeline.slidingWindowSize}f / overlap {s.timeline.slidingWindowOverlap}f → {stats.windows} windows,
              {" "}{stats.newFrames} new frames each. {stats.warning ?? "Within H3's 15s-per-window guidance."}
              <br />Size and overlap come from the timeline so the bands on screen are the windows actually generated.
              {stats.runtHint ? <><br /><span className="warn">{stats.runtHint}</span></> : null}
            </div>
          </div>
        </>
      )}
      {s.advTab === "window" && (
        <div className="card">
          <h4>Sliding Window</h4>
          <div className="note">
            Window {s.timeline.slidingWindowSize}f / overlap {s.timeline.slidingWindowOverlap}f -&gt; {stats.windows} windows.
            <br />
            Size and overlap are set on the timeline toolbar, not here, so the bands drawn on screen
            are always the windows actually generated. Prompts and injected frames are placed
            against those bands.
          </div>

          <label className="chk" title="Give each window its own length instead of letting them come out equal. Drag the boundaries on the timeline, or type a length below.">
            <input
              type="checkbox"
              checked={!!s.timeline.manualWindows}
              onChange={(e) => s.setManualWindows(e.target.checked)}
            />
            Set window lengths by hand
          </label>

          {!s.timeline.manualWindows && (
            <div className="note ok">
              Windows come out equal, with the last one taking what is left. Your window size and
              overlap are never changed to make the arithmetic work.
            </div>
          )}

          {s.timeline.manualWindows && (
            <>
              <div className="note">
                Drag the boundaries on the timeline, or use the sliders below. Nothing is clamped
                while you arrange — a window may sit out of range until you fix its neighbour.
                <br />
                <b>Hard limits:</b> {(stats.floor / s.fps).toFixed(2)}s to {(stats.ceiling / s.fps).toFixed(2)}s
                per window at overlap {s.timeline.slidingWindowOverlap}, and the lengths must add up
                to the {(stats.maxF / s.fps).toFixed(2)}s timeline. Generate refuses outside those.
                <br />
                <b>MiniMax documents {H3.OFFICIAL_MIN_SEC}–{H3.MAX_WINDOW_SEC}s per window.</b>{" "}
                Longer still generates; quality past {H3.MAX_WINDOW_SEC}s is not something the model promises.
              </div>

              <Row label="Windows">
                <button
                  className="btn sm"
                  type="button"
                  disabled={stats.frames.length <= 1}
                  title="One window fewer — the last two are folded together."
                  onClick={() => s.setWindowCount(stats.frames.length - 1)}
                >
                  &minus;
                </button>
                <span className="v num" style={{ minWidth: 28, textAlign: "center" }}>
                  {stats.frames.length}
                </span>
                <button
                  className="btn sm"
                  type="button"
                  title="One window more — the timeline is divided evenly again."
                  onClick={() => s.setWindowCount(stats.frames.length + 1)}
                >
                  +
                </button>
                <span className="hint" style={{ flex: 1 }}>
                  Evenly divided: {(stats.maxF / Math.max(1, stats.frames.length) / s.fps).toFixed(2)}s each.
                  Split or fold single windows below.
                </span>
              </Row>

              <div className="winlist">
                {stats.frames.map((f, i) => (
                  <div className="row" key={i}>
                    <label title={`Window ${i + 1} of ${stats.frames.length}`}>Window {i + 1}</label>
                    <input
                      type="range"
                      min={stats.floor}
                      max={stats.ceiling}
                      step={1}
                      value={f}
                      onChange={(e) => s.setWindowFrames(i, Number(e.target.value))}
                    />
                    <span className="v num">{(f / s.fps).toFixed(2)}s</span>
                    <span className="v num dim">{f}f</span>
                    <button
                      className="btn sm"
                      type="button"
                      disabled={f < 2}
                      title="Split this window into two halves"
                      onClick={() => s.splitWindow(i)}
                    >
                      Split
                    </button>
                    <button
                      className="btn sm warn"
                      type="button"
                      disabled={stats.frames.length < 2}
                      title="Fold this window into its neighbour"
                      onClick={() => s.mergeWindow(i)}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>

              <Row label="">
                <button
                  className="btn sm"
                  type="button"
                  title="Go back to equal windows with the last one taking the remainder."
                  onClick={() => s.resetWindowFrames()}
                >
                  Even them out
                </button>
                <span className="hint" style={{ flex: 1 }}>
                  Total {(stats.total / s.fps).toFixed(2)}s of {(stats.maxF / s.fps).toFixed(2)}s
                </span>
              </Row>

              <PromptWindowWarning />

              {stats.problems.length > 0 ? (
                <div className={stats.problems.some((p) => p.blocking) ? "warnbox" : "warnbox soft"}>
                  {stats.problems.map((pr, i) => (
                    <div key={i}>
                      <b>{pr.blocking ? "Blocks generation:" : "Out of spec:"}</b> {pr.text}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="note ok">
                  {stats.frames.length} window(s) adding up to the timeline exactly.
                </div>
              )}
            </>
          )}
        </div>
      )}
      {s.advTab === "misc" && (
        <div className="card">
          <h4>Memory and precision</h4>
          <div className="two">
            <Row label="Attention">
              <select
                value={String(s.advanced.override_attention)}
                onChange={(e) => s.patchAdvanced({ override_attention: e.target.value })}
              >
                {ATTENTION_CHOICES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Text encoder">
              <select value={String(s.advanced.text_encoder)} onChange={(e) => s.patchAdvanced({ text_encoder: e.target.value })}>
                {TEXT_ENCODER_CHOICES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Video VAE">
              <select value={String(s.advanced.video_vae)} onChange={(e) => s.patchAdvanced({ video_vae: e.target.value })}>
                {VIDEO_VAE_CHOICES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="DiT priority">
              <select value={String(s.advanced.priority)} onChange={(e) => s.patchAdvanced({ priority: e.target.value })}>
                {PRIORITY_CHOICES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
          </div>
        </div>
      )}
    </div>
  );
}

interface SfxMethod {
  value: string; label: string;
  needs_prompt?: boolean; needs_negative_prompt?: boolean; needs_audio_source?: boolean;
}


interface LoraInfo { model_type: string; supported: boolean; loras: string[]; max_phases: number; lora_phases?: number; error?: string }

/** One shared fetch of Wan2GP's LoRA list per checkpoint.
 *  The Sampling card needs max_phases to offer the phase count, and the LoRA
 *  tab needs the list itself, so both read from here rather than each firing
 *  their own request. */
const loraCache: { key: string; info: LoraInfo | null } = { key: "", info: null };

function useLoraInfo(): { info: LoraInfo | null; busy: boolean; reload: () => Promise<void> } {
  const s = useDirector();
  const key = String(s.advanced.checkpoint || "");
  const [info, setInfo] = useState<LoraInfo | null>(loraCache.key === key ? loraCache.info : null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    try {
      const r = await request<LoraInfo>("list_loras", { model_type: key }, 60000);
      loraCache.key = key; loraCache.info = r;
      setInfo(r);
    } catch (e) {
      const bad: LoraInfo = { model_type: "", supported: false, loras: [], max_phases: 1, error: String(e) };
      loraCache.key = key; loraCache.info = bad;
      setInfo(bad);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (loraCache.key === key && loraCache.info) { setInfo(loraCache.info); return; }
    void reload();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [key]);

  return { info, busy, reload };
}

/** How many guidance phases the model runs. This belongs with the model
 *  settings rather than the LoRA tab: the phase count is a property of the
 *  checkpoint, and the LoRA sliders merely follow it. */
/** A duration typed into a prompt that disagrees with its window. The window
 *  governs; this offers to move the window to the prompt instead. */
function PromptWindowWarning() {
  const s = useDirector();
  const mism = usePromptWindowMismatches();
  if (mism.length === 0) return null;
  return (
    <div className="warnbox">
      {mism.map((m) => <div key={m.window}>{m.text}</div>)}
      <div style={{ marginTop: 4 }}>
        <button
          className="btn sm"
          type="button"
          title="Resize the windows so they match the durations written in the prompts."
          onClick={() => s.applyPromptDurations()}
        >
          Resize windows to match the prompts
        </button>
        <span className="hint" style={{ marginLeft: 8 }}>
          Otherwise the window lengths are what gets generated.
        </span>
      </div>
    </div>
  );
}

function GuidancePhases() {
  const s = useDirector();
  const { info } = useLoraInfo();
  const { phases, maxPhases } = usePhaseCount(info);
  return (
    <Row label="Guidance phases">
      <select
        value={String(phases)}
        disabled={!!s.advanced.pdd || maxPhases < 2}
        title="Denoising can run in more than one guidance phase. Each phase can carry its own LoRA strength."
        onChange={(e) => s.patchAdvanced({ guidance_phases: Number(e.target.value) })}
      >
        {Array.from({ length: maxPhases }).map((_, i) => (
          <option key={i + 1} value={i + 1}>{i + 1} phase{i > 0 ? "s" : ""}</option>
        ))}
      </select>
      <span className="hint" style={{ flex: 1 }}>
        {s.advanced.pdd
          ? "Fixed at 1 by the PDD checkpoint."
          : maxPhases < 2
            ? "This model runs a single guidance phase."
            : "Two phases let a LoRA act differently early and late in denoising."}
      </span>
    </Row>
  );
}

/** Phase count actually in force: the model's ceiling, and 1 when PDD locks it. */
function usePhaseCount(info: LoraInfo | null): { phases: number; maxPhases: number } {
  const s = useDirector();
  const maxPhases = Math.max(1, Number(info?.lora_phases ?? info?.max_phases ?? 1));
  const phases = s.advanced.pdd
    ? 1
    : Math.min(maxPhases, Math.max(1, Number(s.advanced.guidance_phases ?? 1)));
  return { phases, maxPhases };
}

/** LoRA picker: real list from Wan2GP, multi-select, and a strength slider per
 *  LoRA per guidance phase. The multiplier string is built from these, since
 *  hand-typing "1;1 0.8;0.5" is how it goes wrong. */
function LoraTab() {
  const s = useDirector();
  const { info, busy, reload } = useLoraInfo();
  const { phases } = usePhaseCount(info);
  const [pick, setPick] = useState("");

  // `loras` is an ORDERED list: Wan2GP applies them in the order sent, so the
  // order here is the order they take effect. Adding appends to the end.
  const active = Array.isArray(s.advanced.loras) ? (s.advanced.loras as string[]) : [];
  const weights = (s.advanced.lora_weights as Record<string, number[]>) || {};

  const setWeight = (name: string, phase: number, v: number) => {
    const cur = Array.isArray(weights[name]) ? [...weights[name]] : [Number(weights[name] ?? 1)];
    while (cur.length < phases) cur.push(cur[cur.length - 1] ?? 1);
    cur[phase] = v;
    s.patchAdvanced({ lora_weights: { ...weights, [name]: cur } });
  };
  const add = (name: string) => {
    if (!name || active.includes(name)) return;
    s.patchAdvanced({ loras: [...active, name] });
    if (!weights[name]) s.patchAdvanced({ lora_weights: { ...weights, [name]: [1] } });
  };
  const remove = (name: string) => s.patchAdvanced({ loras: active.filter((x) => x !== name) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= active.length) return;
    const next = [...active];
    [next[i], next[j]] = [next[j], next[i]];
    s.patchAdvanced({ loras: next });
  };

  const available = (info?.loras || []).filter((l) => !active.includes(l));

  return (
    <>
      <div className="card">
        <h4>LoRAs</h4>
        <Row label="Add a LoRA">
          <select
            value={pick}
            title="Every LoRA Wan2GP has for this model. Picking one adds it to the bottom of the stack below."
            onChange={(e) => { add(e.target.value); setPick(""); }}
          >
            <option value="">{available.length ? "Choose a LoRA\u2026" : "None left to add"}</option>
            {available.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="btn sm" type="button" disabled={busy}
            title="Re-read Wan2GP's LoRA folder for this model."
            onClick={() => void reload()}>
            {busy ? "Scanning\u2026" : "Rescan folder"}
          </button>
        </Row>
        {info?.error && <div className="note">Could not list LoRAs: {info.error}</div>}
        {info && !info.error && info.supported === false && (
          <div className="note">This model does not accept LoRAs.</div>
        )}
        {info && info.supported && (info.loras || []).length === 0 && (
          <div className="note">
            No LoRAs found for <code>{info.model_type}</code>. Drop .safetensors files in Wan2GP's
            LoRA folder for this model and press Rescan.
          </div>
        )}

        {active.length === 0 ? (
          <div className="note">
            Nothing selected. Pick one above — they stack in the order you add them.
          </div>
        ) : (
          <div className="lora-stack">
            {active.map((name, i) => {
              const w = Array.isArray(weights[name]) ? weights[name] : [Number(weights[name] ?? 1)];
              return (
                <div key={name} className="lora on">
                  <div className="lora-head">
                    <span className="lora-ord" title="Apply order">{i + 1}</span>
                    <span className="lora-name" title={name}>{name}</span>
                    <button className="btn sm" type="button" disabled={i === 0}
                      title="Apply this LoRA earlier" onClick={() => move(i, -1)}>&uarr;</button>
                    <button className="btn sm" type="button" disabled={i === active.length - 1}
                      title="Apply this LoRA later" onClick={() => move(i, 1)}>&darr;</button>
                    <button className="btn sm warn" type="button"
                      title="Remove this LoRA" onClick={() => remove(name)}>&times;</button>
                  </div>
                  <div className="lora-w">
                    {Array.from({ length: phases }).map((_, ph) => (
                      <div className="row" key={ph}>
                        <label title={phases > 1
                          ? "Strength during this guidance phase."
                          : "How strongly this LoRA is applied."}>
                          {phases > 1 ? `Phase ${ph + 1}` : "Strength"}
                        </label>
                        <input
                          type="range" min={0} max={2} step={0.05}
                          value={Number(w[ph] ?? w[w.length - 1] ?? 1)}
                          onChange={(e) => setWeight(name, ph, Number(e.target.value))}
                        />
                        <span className="v num">{Number(w[ph] ?? w[w.length - 1] ?? 1).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {active.length > 0 && (
          <div className="note ok">
            Sent as <code>{active.join(" ")}</code> with multipliers{" "}
            <code>
              {active.map((n) => {
                const w = Array.isArray(weights[n]) ? weights[n] : [Number(weights[n] ?? 1)];
                return Array.from({ length: phases })
                  .map((_, i) => Number(w[i] ?? w[w.length - 1] ?? 1))
                  .join(";");
              }).join(" ")}
            </code>
          </div>
        )}

        <div className="note">
          A LoRA only fires when its trigger word appears in the prompt. Space separates LoRAs and
          semicolons separate phases — built for you from the sliders above.
        </div>
      </div>
    </>
  );
}

function SfxPane() {
  const s = useDirector();
  const [methods, setMethods] = useState<SfxMethod[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const sfx = s.sfx as typeof s.sfx & {
    enabled?: boolean; method?: string; prompt?: string; negative?: string;
    seed?: number; videoPath?: string; outDir?: string; outName?: string;
    alsoMux?: boolean; lastAudio?: string; lastMuxed?: string;
    status?: string; message?: string;
  };

  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ soundtrack: SfxMethod[]; error?: string }>("sfx_methods", {}, 30000);
        setMethods(r?.soundtrack || []);
        if (r?.error) setLoadErr(r.error);
        if (!sfx.method && r?.soundtrack?.length) {
          const first = r.soundtrack.find((m) => m.value);
          if (first) s.patchSfx({ method: first.value });
        }
      } catch (e) { setLoadErr(String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = methods.find((m) => m.value === sfx.method);
  const lastOutput = (s.job as { files?: string[] }).files?.[0] || "";
  const running = sfx.status === "running";
  const off = sfx.enabled === false;

  return (
    <div className="pane on">
      <div className="bar">
        <h2>Sound design</h2>
        <span className="pill">post production</span>
      </div>

      <div className="card">
        <label className="chk">
          <input type="checkbox" checked={sfx.enabled !== false}
            onChange={(e) => s.patchSfx({ enabled: e.target.checked })} />
          Enable sound design
        </label>
        <div className="note">
          This runs <b>after</b> a video exists and never touches generation. It writes the audio
          as its own file so you can edit it in a DAW before mixing. Muxing a copy is optional.
        </div>
        {loadErr && <div className="note">Wan2GP reported no audio processors: {loadErr}</div>}
      </div>

      <div className="card" style={off ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
        <h4>Source video</h4>
        <Row label="File">
          <input type="text" value={sfx.videoPath || ""} placeholder="pick a rendered video, or use the last output"
            onChange={(e) => s.patchSfx({ videoPath: e.target.value })} />
          <button className="btn sm" type="button" onClick={async () => {
            try {
              const r = await request<{ path?: string }>("browse_video", {}, 180000);
              if (r?.path) s.patchSfx({ videoPath: r.path });
            } catch (e) { s.setToast(String(e)); }
          }}>Browse…</button>
        </Row>
        {lastOutput && (
          <Row label="">
            <button className="btn sm" type="button" onClick={() => s.patchSfx({ videoPath: lastOutput })}>
              Use last generated output
            </button>
          </Row>
        )}
        <div className="note">Any video works — it does not have to be one made in this session.</div>
      </div>

      <div className="card" style={off ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
        <h4>Soundtrack</h4>
        <Row label="Method">
          <select value={sfx.method || ""} onChange={(e) => s.patchSfx({ method: e.target.value })}>
            {methods.length === 0 && <option value="">(none registered)</option>}
            {methods.map((m) => <option key={m.value || "none"} value={m.value}>{m.label}</option>)}
          </select>
        </Row>
        {current?.needs_prompt && (
          <PromptBox label="Sound prompt" rows={3} value={sfx.prompt || ""}
            placeholder="What should be heard: footsteps on concrete, keyboard clicks, room tone…"
            onChange={(v) => s.patchSfx({ prompt: v })} />
        )}
        {current?.needs_negative_prompt && (
          <PromptBox label="Negative sound prompt" rows={2} value={sfx.negative || ""}
            placeholder="What to avoid: music, speech, hiss…"
            onChange={(v) => s.patchSfx({ negative: v })} />
        )}
              <div className="rh2" style={{ marginTop: 10 }}>Exclude from the generated sound</div>
        <div className="two">
          {([
            ["no_music", "No music", "Generated music cannot be separated out later — leave this on if you are adding your own track."],
            ["no_speech", "No speech or vocals", "Stops invented dialogue, singing and narration."],
            ["no_ambience", "No room tone or ambience", "Effects only, no background bed."],
            ["no_effects", "No effects (ambience only)", "The inverse — background bed without foley hits."],
          ] as [string, string, string][]).map(([k, label, hint]) => (
            <Row key={k} label={label}>
              <input type="checkbox"
                checked={!!(sfx as Record<string, unknown>)[k]}
                onChange={(e) => s.patchSfx({ [k]: e.target.checked } as never)} />
              <span className="hint" style={{ flex: 1 }}>{hint}</span>
            </Row>
          ))}
        </div>
        <div className="note">
          These are added to the negative prompt when the job is sent. Your typed prompts are never
          changed, so the same prompt can be reused with different exclusions.
        </div>

        <Row label="Seed">
          <input type="number" value={sfx.seed ?? -1}
            onChange={(e) => s.patchSfx({ seed: Number(e.target.value) })} />
          <span className="hint" style={{ flex: 1 }}>-1 is random. Fix it to reproduce a take.</span>
        </Row>
      </div>

      <div className="card" style={off ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
        <h4>Output</h4>
        <Row label="Track name">
          <input type="text" value={sfx.outName || ""} placeholder="&lt;video name&gt;_sfx"
            onChange={(e) => s.patchSfx({ outName: e.target.value })} />
        </Row>
        <Row label="Folder">
          <input type="text" value={sfx.outDir || ""} placeholder="beside the video"
            onChange={(e) => s.patchSfx({ outDir: e.target.value })} />
          <button className="btn sm" type="button" onClick={async () => {
            try {
              const r = await request<{ dir?: string }>("browse_dir", {}, 180000);
              if (r?.dir) s.patchSfx({ outDir: r.dir });
            } catch (e) { s.setToast(String(e)); }
          }}>Browse…</button>
        </Row>
        <label className="chk">
          <input type="checkbox" checked={!!sfx.alsoMux}
            onChange={(e) => s.patchSfx({ alsoMux: e.target.checked })} />
          Also write a copy of the video with this track muxed in
        </label>
        <div className="note">
          The separate audio file is always written — that is the one you take into your DAW.
        </div>
        <Row label="">
          <button className="btn sm go" type="button" disabled={running || off}
            onClick={() => {
              s.patchSfx({ status: "running", message: "Starting…" });
              send("sfx", {
                enabled: sfx.enabled !== false,
                video_path: sfx.videoPath || lastOutput,
                method: sfx.method, prompt: sfx.prompt, negative_prompt: sfx.negative,
                seed: sfx.seed ?? -1, out_dir: sfx.outDir, out_name: sfx.outName,
                also_mux: !!sfx.alsoMux,
                no_music: !!(sfx as Record<string, unknown>).no_music,
                no_speech: !!(sfx as Record<string, unknown>).no_speech,
                no_ambience: !!(sfx as Record<string, unknown>).no_ambience,
                no_effects: !!(sfx as Record<string, unknown>).no_effects,
              });
            }}>
            {running ? "Working…" : "Generate sound"}
          </button>
        </Row>
        {sfx.message && (
          <div className={`note ${sfx.status === "error" ? "" : "ok"}`}>{sfx.message}</div>
        )}
        {sfx.lastAudio && (
          <div className="note ok">Audio track: <code>{sfx.lastAudio}</code></div>
        )}
        {sfx.lastMuxed && (
          <div className="note ok">Muxed video: <code>{sfx.lastMuxed}</code></div>
        )}
        {sfx.lastAudio && sfx.videoPath && !sfx.lastMuxed && (
          <Row label="">
            <button className="btn sm" type="button" onClick={async () => {
              try {
                const r = await request<{ path: string }>("sfx_mux",
                  { video_path: sfx.videoPath, audio_path: sfx.lastAudio, out_dir: sfx.outDir }, 600000);
                s.patchSfx({ lastMuxed: r?.path });
              } catch (e) { s.setToast(`Mux failed: ${String(e)}`); }
            }}>Mux this track into the video now</button>
          </Row>
        )}
      </div>
    </div>
  );
}

function ExportPane() {
  const s = useDirector();
  const [fmt, setFmt] = useState<"reaper" | "markers_csv" | "audacity" | "edl">("reaper");
  const [name, setName] = useState(s.project_name || "project");
  const [dir, setDir] = useState(s.exportDir || "");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const keys: { k: keyof typeof s.exportInclude; label: string }[] = [
    { k: "originalMusic", label: "Guidance music track" },
    { k: "previewMix", label: "Clip audio (control video)" },
    { k: "sfxStems", label: "SFX stems" },
    { k: "video", label: "Rendered video as a reference item" },
  ];

  const FORMATS: Record<string, { label: string; ext: string; blurb: string }> = {
    reaper: { label: "Reaper project", ext: ".RPP", blurb: "A native .RPP with the tempo, your audio placed at zero, one track per timeline lane, and a marker at every shot change and window boundary." },
    markers_csv: { label: "Marker CSV", ext: ".csv", blurb: "Reaper's View \u2192 Region/Marker Manager imports this. Also read by Premiere and Resolve." },
    audacity: { label: "Audacity labels", ext: ".txt", blurb: "Tab-separated label track. Audacity, and anything that reads label files." },
    edl: { label: "CMX3600 EDL", ext: ".edl", blurb: "Generic edit decision list for NLEs that do not read the above." },
  };

  const pickDir = async () => {
    try {
      const r = await request<{ dir?: string; cancelled?: boolean }>("browse_dir", {}, 180000);
      if (r?.dir) { setDir(r.dir); s.patch({ exportDir: r.dir }); }
    } catch { s.setToast("No folder picker available \u2014 type the path instead"); }
  };

  const doExport = async () => {
    setBusy("Exporting...");
    setNote("");
    try {
      const r = await request<{ ok: boolean; path?: string; error?: string }>("export_daw", {
        format: fmt, name, dir,
        fps: s.fps,
        duration_sec: s.duration_sec,
        include: s.exportInclude,
        segments: s.timeline.segments.map((x) => ({
          id: x.id, kind: x.kind, track: x.track, start: x.start, length: x.length,
          title: x.title, muted: !!x.muted, mediaId: x.mediaId, fileName: x.fileName,
        })),
        windows: useDirector.getState().timeline.slidingWindowSize,
        overlap: useDirector.getState().timeline.slidingWindowOverlap,
      }, 120000);
      if (r?.ok) { s.patch({ exportDir: dir }); setNote(`Written to ${r.path}`); s.setToast(`Exported ${FORMATS[fmt].label}`); }
      else setNote(`Export failed: ${r?.error || "unknown"}`);
    } catch (e) {
      setNote(`Export failed: ${String(e)}`);
    } finally { setBusy(""); }
  };

  return (
    <div className="pane on">
      <div className="bar"><h2>Export to DAW</h2></div>

      <div className="card">
        <div className="note">
          <b>Saving the project lives in the Project tab.</b> That is where the name, the folder
          and the full project zip are. This tab only builds a session for a DAW.
          <br />
          <button className="btn sm" type="button" style={{ marginTop: 6 }} onClick={() => s.setPane("project")}>
            Go to Project
          </button>
        </div>
      </div>

      <div className="card">
        <h4>Format</h4>
        <Row label="DAW">
          <select value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)}>
            {Object.entries(FORMATS).map(([k, v]) => (
              <option key={k} value={k}>{v.label} ({v.ext})</option>
            ))}
          </select>
        </Row>
        <div className="note">{FORMATS[fmt].blurb}</div>
      </div>

      <div className="card">
        <h4>Include</h4>
        <div className="two">
          {keys.map(({ k, label }) => (
            <Row key={k} label={label}>
              <input type="checkbox" checked={!!s.exportInclude[k]} onChange={(e) => s.patchExport({ [k]: e.target.checked })} />
              <span style={{ flex: 1 }} />
            </Row>
          ))}
        </div>
      </div>

      <div className="card">
        <h4>Destination</h4>
        <Row label="Session name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="session name" />
        </Row>
        <Row label="Folder">
          <input type="text" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="leave blank for the plugin's exports folder" />
          <button className="btn sm" type="button" onClick={() => void pickDir()}>Browse</button>
        </Row>
        <Row label="">
          <button className="btn sm go" type="button" disabled={!!busy} onClick={() => void doExport()}>
            {busy || `Export ${FORMATS[fmt].ext}`}
          </button>
        </Row>
        {note && <div className={`note ${note.startsWith("Export failed") ? "" : "ok"}`}>{note}</div>}
        <div className="note">
          Media is copied next to the session file so the DAW can find it. Reaper opens the
          .RPP directly; the audio sits at 00:00:00 so it lines up with the timeline exactly.
        </div>
      </div>
    </div>
  );
}

function BuilderPane() {
  const s = useDirector();
  return (
    <div className="pane on">
      <div className="bar">
        <h2>Hybrid builder</h2>
        <span className="pill">BF16</span>
      </div>
      <div className="card">
        <div className="two">
          <Row label="FL2VA base">
            <select value={s.builder.fl2va} onChange={(e) => s.patchBuilder({ fl2va: e.target.value })}>
              <option>MiniMax-H3-FL2VA_bf16</option>
            </select>
          </Row>
          <Row label="Ref2VA reference">
            <select value={s.builder.ref2va} onChange={(e) => s.patchBuilder({ ref2va: e.target.value })}>
              <option>MiniMax-H3-Ref2VA_bf16</option>
            </select>
          </Row>
          <Row label="AdaLN start block">
            <input type="text" value={s.builder.startBlock} onChange={(e) => s.patchBuilder({ startBlock: Number(e.target.value) || 0 })} />
          </Row>
          <Row label="AdaLN end block">
            <input type="text" value={s.builder.endBlock} onChange={(e) => s.patchBuilder({ endBlock: Number(e.target.value) || 0 })} />
          </Row>
          <Row label="Include final AdaLN">
            <input
              type="checkbox"
              checked={s.builder.includeFinal}
              onChange={(e) => s.patchBuilder({ includeFinal: e.target.checked })}
            />
            <span style={{ flex: 1 }} />
          </Row>
          <Row label="Save to">
            <select value={s.builder.saveTo} onChange={(e) => s.patchBuilder({ saveTo: e.target.value })}>
              <option>D:\Wan2GP\ckpts</option>
            </select>
          </Row>
        </div>
        <Row label="">
          <button
            className="btn sm"
            type="button"
            onClick={() => s.patchBuilder({ status: "Rescanned — using the two BF16 checkpoints from the mock recipe." })}
          >
            Rescan model locations
          </button>
          <button
            className="btn sm"
            type="button"
            onClick={() =>
              s.patchBuilder({
                status: `Build finished — AdaLN ${s.builder.startBlock}–${s.builder.endBlock} merged into FL2VA. Register the finetune in Wan2GP to generate with it.`,
              })
            }
          >
            Build / use hybrid
          </button>
        </Row>
        <div className="note ok">{s.builder.status}</div>
      </div>
    </div>
  );
}

function DiagPane() {
  const s = useDirector();
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    const lines: string[] = [];
    try {
      const { allMedia, getMedia } = await import("../lib/media");
      const { audioDiagnostics } = await import("../lib/audio");

      const ids = new Set<string>();
      for (const seg of s.timeline.segments) if (seg.mediaId) ids.add(seg.mediaId);
      for (const r of s.refs.images) if (r.mediaId) ids.add(r.mediaId);
      for (const r of s.refs.videos) if (r.mediaId) ids.add(r.mediaId);
      for (const r of s.refs.audio) if (r.mediaId) ids.add(r.mediaId);

      lines.push(`Timeline references ${ids.size} media item(s); cache holds ${allMedia().length}.`);
      const missing: string[] = [];
      for (const id of ids) {
        const m = getMedia(id);
        if (!m || m.missing) { missing.push(id); continue; }
        lines.push(`  OK  ${m.name}  ${m.kind}  ${m.durationSec ? m.durationSec.toFixed(2) + "s" : ""}${m.width ? ` ${m.width}x${m.height}` : ""}${m.peaks.length ? ` peaks:${m.peaks.length}` : ""}${m.thumb ? " thumb" : " NO THUMB"}`);
      }
      for (const id of missing) lines.push(`  MISSING  ${id} - no file on disk`);

      const ad = audioDiagnostics();
      lines.push("");
      lines.push(`AudioContext: ${ad.context}${ad.sampleRate ? ` @ ${ad.sampleRate} Hz` : ""}, ${ad.decoded} buffer(s) decoded, ${ad.voices} voice(s) playing.`);
      if (ad.context === "not created") lines.push("  Press Play once - the context is only created inside a click.");
      if (ad.context === "suspended") lines.push("  Suspended: the browser has not granted playback yet.");

      const audible = s.timeline.segments.filter((x) => (x.track === "audio" || x.track === "clipaudio") && !x.muted && x.mediaId);
      lines.push(`Audible segments: ${audible.length}${audible.length ? "" : " - nothing to hear on Play."}`);

      lines.push("");
      lines.push(s.bridgeOk === false ? "Bridge: NOT CONNECTED" : `Bridge: ${s.saveInfo || "connected"}`);
      lines.push(`Installed H3 models: ${s.installedModels.length ? s.installedModels.map((m) => m.model_type).join(", ") : "NONE - Wan2GP reported no MiniMax H3 models"}`);

      try {
        const r = await request<{ report: string[] }>("diagnose", {}, 60000);
        if (r?.report) { lines.push(""); lines.push(...r.report); }
      } catch (e) { lines.push(`Python diagnostics unavailable: ${String(e)}`); }
    } catch (e) {
      lines.push(`Diagnostics failed: ${String(e)}`);
    }
    setOut(lines.join("\n"));
    setBusy(false);
  };

  return (
    <div className="pane on">
      <div className="bar"><h2>Diagnostics</h2></div>
      <div className="card">
        <h4>Check media and wiring</h4>
        <Row label="">
          <button className="btn sm go" type="button" disabled={busy} onClick={() => void check()}>
            {busy ? "Checking..." : "Check media"}
          </button>
          <button className="btn sm" type="button" onClick={() => { void request("print_env", {}, 30000); s.setToast("Environment printed to the terminal"); }}>
            Print environment to terminal
          </button>
        </Row>
        {out && <pre className="gen-log" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{out}</pre>}
      </div>
    </div>
  );
}
