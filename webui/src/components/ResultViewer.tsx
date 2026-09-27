import { useEffect, useRef, useState } from "react";
import { useDirector, type RenderClip } from "../lib/store";
import { request, hasParent } from "../lib/bridge";

/** Where each clip's preview can be played from, by clip file and size. */
const urls = new Map<string, string>();
const keyOf = (c: RenderClip) => `${c.master}:${c.bytes ?? ""}`;

async function previewUrl(c: RenderClip): Promise<string> {
  const k = keyOf(c);
  const known = urls.get(k);
  if (known) return known;
  if (!hasParent()) return "";
  const r = await request<{ file: string; fileBase: string }>("render_preview", { master: c.master }, 600000);
  if (!r?.file) return "";
  let url = "";
  if (r.fileBase) {
    const origin = (window.location && window.location.origin) || "";
    url = `${origin && origin !== "null" ? origin : ""}${r.fileBase}${encodeURIComponent(r.file)}`;
  }
  if (url) urls.set(k, url);
  return url;
}

const renderBusy = () => useDirector.getState().job.status === "running";

/** The same preview carried through the bridge, for when the served URL
 *  cannot be reached from this frame. */
async function previewBlob(c: RenderClip): Promise<string> {
  const r = await request<{ b64: string; mime?: string }>("render_preview", { master: c.master, b64: true }, 600000);
  if (!r?.b64) return "";
  const bin = atob(r.b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: r.mime || "video/mp4" }));
  urls.set(keyOf(c), url);
  return url;
}

/**
 * The results monitor. Like the control-video monitor, it is driven by the
 * TIMELINE: it shows the rendered clip under the playhead, at the playhead,
 * and plays when the timeline plays -- so a problem you see here is exactly
 * where the playhead is, over the prompts and windows that made it.
 *
 * Two video elements take turns: the clip after the current one is loaded and
 * waiting, so when the playhead crosses into it the picture switches at once.
 * The clips were cut to their slots when saved, so the playhead maps straight
 * onto them with nothing to offset.
 */
export function ResultViewer() {
  const view = useDirector((z) => z.resultView);
  const setView = useDirector((z) => z.setResultView);
  const render = useDirector((z) => z.render);
  const fps = useDirector((z) => z.fps) || 24;
  const playhead = useDirector((z) => z.timeline.playhead);
  const playing = useDirector((z) => z.playing);
  const hasSong = useDirector((z) => z.timeline.segments.some((x) => x.track === "audio" && x.mediaId && !x.muted));
  const clips = (render?.clips || []).slice().sort((a, b) => a.start - b.start);

  const vids = [useRef<HTMLVideoElement | null>(null), useRef<HTMLVideoElement | null>(null)];
  const loaded = useRef<[string, string]>(["", ""]);       // clip key loaded in each element
  const [front, setFront] = useState(0);
  const [note, setNote] = useState("");
  // The timeline plays its own soundtrack; the rendered clips carry theirs.
  // Both at once is the song twice, so the clip is muted when there is one.
  const [muted, setMuted] = useState<boolean | null>(null);
  const isMuted = muted ?? hasSong;

  const at = clips.findIndex((c) => playhead >= c.start && playhead < c.start + (c.frames_got || c.frames));
  const cur = at >= 0 ? clips[at] : undefined;
  const next = at >= 0 ? clips[at + 1] : clips.find((c) => c.start > playhead);

  /** Make sure element e holds clip c. */
  const ensure = async (e: number, c: RenderClip) => {
    const el = vids[e].current;
    if (!el) return false;
    const k = keyOf(c);
    if (loaded.current[e] === k) return true;
    loaded.current[e] = k;
    let src = "";
    try { src = await previewUrl(c); } catch (err) { setNote(`Could not prepare group ${c.group}: ${String(err)}`); }
    // Never push video bytes through the bridge while a render runs: that
    // stream also carries the render's own updates and WanGP's queue trigger.
    if (!src && !renderBusy()) { try { src = await previewBlob(c); } catch { /* reported below */ } }
    if (loaded.current[e] !== k) return false;             // something else was asked for meanwhile
    if (!src) { setNote(`Group ${c.group} has no preview to play.`); return false; }
    el.src = src;
    el.load();
    return true;
  };

  // Follow the playhead: the clip under it in front, the next one waiting.
  useEffect(() => {
    if (!view) return;
    void (async () => {
      if (cur) {
        const k = keyOf(cur);
        let f = front;
        if (loaded.current[f] !== k) {
          // Already waiting in the other element? Switch to it at once.
          if (loaded.current[1 - f] === k) { f = 1 - f; setFront(f); }
          else await ensure(f, cur);
        }
        const el = vids[f].current;
        if (el) {
          const want = (playhead - cur.start) / fps;
          // While playing, only correct real drift so playback stays smooth;
          // while scrubbing, follow exactly.
          if (Math.abs(el.currentTime - want) > (playing ? 0.25 : 0.04)) {
            try { el.currentTime = Math.max(0, want); } catch { /* not seekable yet */ }
          }
          el.muted = isMuted;
          if (playing && el.paused) el.play().catch(() => undefined);
          if (!playing && !el.paused) el.pause();
        }
        vids[1 - f].current?.pause();
        if (next) void ensure(1 - f, next);
      } else {
        vids.forEach((v) => v.current?.pause());
        if (next) void ensure(front, next);
      }
    })();
  }, [view, cur ? keyOf(cur) : "", next ? keyOf(next) : "", Math.floor(playhead), playing, isMuted]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing lets go of the files too, so the players hold no connection to
  // WanGP open while nobody is watching.
  const close = () => {
    vids.forEach((v) => {
      const el = v.current;
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      try { el.load(); } catch { /* nothing loaded */ }
    });
    loaded.current = ["", ""];
    setView(null);
  };

  if (!view) return null;
  const inClip = cur ? (playhead - cur.start) / fps : 0;
  return (
    <div className="monitor rviewer" data-testid="result-viewer" style={{ left: view.x ?? 60, top: view.y ?? 70 }}>
      <div
        className="monitor-h"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const el = e.currentTarget.parentElement as HTMLElement;
          e.preventDefault();
          const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
          const move = (ev: PointerEvent) => {
            const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + ev.clientX - sx));
            const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy));
            setView({ ...view, x: nx, y: ny });
          };
          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <span className="monitor-n" data-testid="rv-title">
          Results · {cur ? `group ${cur.group}` : "no rendered clip at the playhead"}
        </span>
        <button type="button" className="x" title="Close (Esc)" onClick={close}>x</button>
      </div>
      <div className="rv-stage">
        {[0, 1].map((e) => (
          <video
            key={e}
            ref={vids[e]}
            playsInline
            preload="auto"
            data-front={front === e && cur ? "1" : undefined}
            style={{ visibility: front === e && cur ? "visible" : "hidden" }}
            onError={() => {
              // The served URL did not play here: fetch the same preview
              // through the bridge and try again.
              const c = clips.find((x) => keyOf(x) === loaded.current[e]);
              if (!c || urls.get(keyOf(c))?.startsWith("blob:")) return;
              if (renderBusy()) { setNote(`Group ${c.group} can be played once the render finishes.`); return; }
              urls.delete(keyOf(c));
              void previewBlob(c).then((u) => {
                const el = vids[e].current;
                if (!u || !el || loaded.current[e] !== keyOf(c)) return;
                el.src = u; el.load();
              }).catch(() => setNote(`Group ${c.group} would not play.`));
            }}
          />
        ))}
        {!cur && <div className="rv-empty">Move the playhead over a clip on the results track.</div>}
      </div>
      <div className="monitor-f rv-ctl num">
        <span className="rv-time" data-testid="rv-time">
          {cur ? `G${cur.group} · ${inClip.toFixed(2)}s into the clip` : "—"}
        </span>
        <span className="rv-hint">follows the playhead - press Play on the timeline</span>
        <button type="button" className="btn sm" data-testid="rv-mute"
          title={hasSong ? "The timeline is playing its own soundtrack; unmute to hear the clip's audio instead" : "Mute the clip's audio"}
          onClick={() => setMuted(!isMuted)}>{isMuted ? "sound off" : "sound on"}</button>
        {note && <span className="rv-note">{note}</span>}
      </div>
    </div>
  );
}
