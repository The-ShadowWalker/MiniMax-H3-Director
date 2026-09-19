import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as PE, type WheelEvent } from "react";
import { Type, Image as ImageIcon, Film, Music, HelpCircle, Play, Pause, Trash2, Repeat } from "lucide-react";
import { useDirector, useWindowStats } from "../lib/store";
import { registerMedia, getMedia, fmtDuration , servedUrl } from "../lib/media";
import { Confirm } from "./Confirm";
import { formatTimecode, stepGrid, H3 } from "../lib/h3";
import type { Segment, TrackId } from "../lib/types";

const TRACKS: { id: TrackId; label: string; h: number }[] = [
  { id: "video", label: "INJECTED FRAMES \u00b7 and text prompts", h: 52 },
  { id: "control", label: "CONTROL VIDEO \u00b7 double-click to add a bridge prompt", h: 40 },
  { id: "clipaudio", label: "CLIP AUDIO", h: 32 },
  { id: "audio", label: "AUDIO", h: 36 },
];

function acceptFor(track: TrackId) {
  if (track === "audio" || track === "clipaudio") return "audio/*,.wav,.mp3,.m4a,.ogg,.flac";
  if (track === "control") return "video/*,.mp4,.mov,.webm,.mkv";
  return "image/*,video/*,.png,.jpg,.webp,.mp4,.mov";
}


/** Waveform for an audio segment. Peaks are computed once per file and cached
 *  by mediaId in media.ts — this only ever draws them. */
function Wave({ seg }: { seg: Segment }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const info = getMedia(seg.mediaId);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const parent = c.parentElement;
    const w = Math.max(1, Math.floor(parent?.clientWidth || 1));
    const h = Math.max(1, Math.floor(parent?.clientHeight || 1));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
    c.style.width = w + "px"; c.style.height = h + "px";
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const peaks = info?.peaks || [];
    if (!peaks.length) return;
    g.fillStyle = seg.muted ? "rgba(13,22,32,.30)" : "rgba(13,22,32,.62)";
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.floor((x / w) * peaks.length)] || 0;
      const bar = Math.max(1, p * (h - 2));
      g.fillRect(x, mid - bar / 2, 1, bar);
    }
  }, [info, seg.muted, seg.length, seg.start]);
  return <canvas ref={ref} className="wave" />;
}

/** A number field you can actually type in.
 *  Binding straight to state rewrites the box on every keystroke, so "44." was
 *  snapped back to "44" and the next digit made "445" - clamped to 600. This
 *  keeps your keystrokes until you commit with Enter or by leaving the field. */
function NumField({
  value, onCommit, className = "nin num", title, step = 0.01, min, max,
}: {
  value: number; onCommit: (n: number) => void; className?: string;
  title?: string; step?: number; min?: number; max?: number;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = parseFloat(text.replace(",", "."));
    if (!Number.isFinite(n)) { setText(String(value)); return; }
    let v = n;
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    onCommit(Number(v.toFixed(4)));
    setText(String(v));
  };
  return (
    <input
      className={className}
      title={title}
      value={text}
      inputMode="decimal"
      onFocus={() => setEditing(true)}
      onChange={(e) => { setEditing(true); setText(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { setEditing(false); setText(String(value)); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const cur = parseFloat(text.replace(",", ".")) || 0;
          const next = cur + (e.key === "ArrowUp" ? step : -step);
          setText(String(Number(next.toFixed(4))));
        }
      }}
    />
  );
}

export function Timeline() {
  const [clearArm, setClearArm] = useState(false);
  const s = useDirector();
  const stats = useWindowStats();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const imgRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);
  const audRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxF = stats.maxF;
  const viewStart = s.viewStart;
  const viewEnd = Math.min(maxF, Math.max(s.viewEnd, viewStart + 8));
  const vis = Math.max(1, viewEnd - viewStart);
  const xOf = (f: number) => ((f - viewStart) / vis) * width;
  const fOf = (x: number) => viewStart + (x / Math.max(1, width)) * vis;

  // Dragging a window boundary. Used by the handle in the band strip and by
  // the full-height one over the tracks, so both behave identically.
  const startEdgeDrag = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const host = el.parentElement;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      s.dragWindowEdge(i, Math.round(fOf(ev.clientX - rect.left)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const dragged = useRef(false);
  const drag = useRef<{
    id: string;
    mode: "move" | "l" | "r";
    start0: number;
    len0: number;
    x0: number;
  } | null>(null);

  const onSegPointer = (e: PE<Element>, seg: Segment, mode: "move" | "l" | "r") => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    s.select(seg.id);
    drag.current = { id: seg.id, mode, start0: seg.start, len0: seg.length, x0: e.clientX };
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    dragged.current = false;
  };

  const onPointerMove = (e: PE<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 2) dragged.current = true;
    const df = ((e.clientX - d.x0) / Math.max(1, width)) * vis;
    if (d.mode === "move") s.moveSeg(d.id, d.start0 + df, d.len0);
    else if (d.mode === "l") {
      const ns = d.start0 + df;
      s.moveSeg(d.id, ns, d.len0 - (ns - d.start0));
    } else s.moveSeg(d.id, d.start0, d.len0 + df);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) {
      e.preventDefault();
      const el = wrapRef.current;
      if (!el) return;
      const x = e.clientX - el.getBoundingClientRect().left;
      const at = fOf(x);
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const span = vis * factor;
      const clamped = Math.max(maxF * 0.08, Math.min(maxF, span));
      let start = at - (at - viewStart) * (clamped / vis);
      let end = start + clamped;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > maxF) {
        start = Math.max(0, maxF - clamped);
        end = maxF;
      }
      s.setView(start, end);
    }
  };

  const onBg = (e: PE<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".seg-c")) return;
    const el = wrapRef.current;
    if (!el) return;
    const x = e.clientX - el.getBoundingClientRect().left;
    s.setPlayhead(fOf(x));
    s.select(null);
  };

  /** Ruler ticks, ported from the working plugin's drawRuler().
   *
   *  Steps are in FRAMES and snapped to a nice-step table, so density stays
   *  constant while zooming, and EVERY tick is labelled - not just the ends of
   *  a window. Four unlabelled subdivisions sit between the labelled marks so
   *  there is always something fine to place against. */
  const ticks: { f: number; label: string; minor?: boolean }[] = [];
  {
    const targetMarks = Math.max(4, Math.floor(width / 90));
    const rawStep = vis / targetMarks;
    const NICE = [1, 2, 5, 10, 15, 24, 30, 48, 60, 120, 240, 480, 960];
    const step = NICE.reduce((p2, c) => (Math.abs(c - rawStep) < Math.abs(p2 - rawStep) ? c : p2));
    const dp = step < s.fps ? 2 : 1;
    const sub = step / 4;

    const firstSub = Math.max(0, Math.ceil(viewStart / sub) * sub);
    for (let f = firstSub; f <= Math.min(viewEnd, maxF); f += sub) {
      if (Math.abs(f / step - Math.round(f / step)) > 1e-6) ticks.push({ f, label: "", minor: true });
    }
    const first = Math.max(0, Math.ceil(viewStart / step) * step);
    for (let f = first; f <= Math.min(viewEnd, maxF); f += step) {
      ticks.push({ f, label: `${(f / s.fps).toFixed(dp)}s` });
    }
  }

  const addFiles = useCallback(
    async (files: FileList | File[], track: TrackId) => {
      for (const file of Array.from(files)) {
        let info;
        try {
          info = await registerMedia(file);              // upload ONCE + probe + thumb + peaks
        } catch (err) {
          const why = String((err as Error)?.message || err);
          console.error("[H3-D] could not ingest", file.name, err);
          s.setToast(`Could not add ${file.name}: ${why}`);
          continue;                                       // one bad file must not stop the rest
        }
        const frames = Math.max(1, Math.round(info.durationSec * s.fps));
        if (info.kind === "audio") {
          // The song defines how long the timeline must be - say so, don't guess.
          s.addSegment("audio", "audio", 0, {
            title: file.name, fileName: file.name, mediaUrl: info.url, mediaId: info.mediaId,
            length: frames || maxF,
          });
          s.setToast(`${file.name} - ${fmtDuration(info.durationSec)} (${frames} frames @ ${s.fps}fps)`);
          if (info.durationSec > 0.5 && Math.abs(info.durationSec - s.duration_sec) > 0.05) {
            if (s.durationLocked) {
              // The length was set deliberately - ask, never overwrite it.
              s.setAskDuration({ seconds: Number(info.durationSec.toFixed(2)), name: file.name });
            } else {
              s.setDuration(Number(info.durationSec.toFixed(2)), { silent: true });
            }
          }
        } else if (info.kind === "video") {
          // Video is guidance: it belongs on CONTROL, never on the top track
          // (which is images and text prompts).
          s.addSegment("control", "control", undefined, {
            title: file.name, fileName: file.name, mediaUrl: info.url, mediaId: info.mediaId,
            thumbLabel: "", length: frames || undefined,
          });
        } else if (info.kind === "image") {
          s.addSegment("image", "video", undefined, {
            title: file.name.replace(/\.[^.]+$/, ""), fileName: file.name,
            mediaUrl: info.url, mediaId: info.mediaId, thumbLabel: "",
            length: Math.round(s.fps),
          });
        } else {
          s.setToast(`Unsupported file: ${file.name} (${file.type || "no MIME type"})`);
        }
      }
    },
    [s, maxF],
  );

  /** Which track row is under this point, and at what frame. Measured from
   *  the actual .trk elements, so window bands, the playhead layer or any
   *  other overlay cannot break it. */
  const trackAt = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    // Read the track id off the ROW ITSELF. Mapping row index to TRACKS[i]
    // silently points at the wrong track the moment the DOM gains or loses an
    // element, which is how a double-click on VIDEO produced a bridge prompt.
    const rows = Array.from(wrap.querySelectorAll<HTMLElement>(".trk[data-track]"));
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const id = row.dataset.track as TrackId | undefined;
        if (!id) return null;
        return { id, frame: fOf(clientX - wrap.getBoundingClientRect().left) };
      }
    }
    return null;
  };

  const onDrop = (e: DragEvent, track: TrackId) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files, track);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        s.togglePlay();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) {
        e.preventDefault();
        s.removeSeg(s.selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  const zLeft = (viewStart / maxF) * 100;
  const zW = ((viewEnd - viewStart) / maxF) * 100;

  return (
    <>
    <Confirm
      open={clearArm}
      title="Clear the timeline?"
      body="Every shot, image, prompt and audio segment on the timeline is removed. References and settings are kept."
      confirmLabel="Clear timeline"
      onCancel={() => setClearArm(false)}
      onConfirm={() => { setClearArm(false); s.clearTimeline(); s.setToast("Timeline cleared"); }}
    />
    <section className="time">
      <div className="tb">
        <button className="btn sm" type="button" title="Add a text prompt to the Injected Frames and Text Prompts track. Double-click it to write in a big editor." onClick={() => s.addSegment("text", "video")}>
          <Type size={12} /> Add text
        </button>
        <button className="btn sm" type="button" title="Add an image as an injected frame. The first and last images become the start and end images." onClick={() => imgRef.current?.click()}>
          <ImageIcon size={12} /> Add image
        </button>
        <button className="btn sm" type="button" title="Add a video to the control track, to guide motion and composition." onClick={() => vidRef.current?.click()}>
          <Film size={12} /> Add video
        </button>
        <button className="btn sm" type="button" title="Add a song or dialogue for the model to perform to. You will be offered the timeline length to match." onClick={() => audRef.current?.click()}>
          <Music size={12} /> Add audio
        </button>
        <input ref={imgRef} type="file" hidden accept="image/*" multiple onChange={(e) => e.target.files && addFiles(e.target.files, "video")} />
        <input ref={vidRef} type="file" hidden accept="video/*" multiple onChange={(e) => e.target.files && addFiles(e.target.files, "video")} />
        <input ref={audRef} type="file" hidden accept="audio/*" multiple onChange={(e) => e.target.files && addFiles(e.target.files, "audio")} />
        <span className="sep" />
        <span className="lbl">FPS</span>
        <NumField value={s.fps} step={1} min={1} max={120} onCommit={(n) => s.setFps(Math.round(n))} />
        <span className="lbl">Duration (s)</span>
        <NumField
          value={s.duration_sec}
          step={0.01}
          min={0.1}
          max={3600}
          title="Any length, decimals included — press Enter or click away to apply"
          onCommit={(n) => s.setDuration(n)}
        />
        {(() => {
          // Longest unmuted audio on the timeline: one click to match it.
          const a = s.timeline.segments
            .filter((x) => x.track === "audio" && x.mediaId)
            .map((x) => getMedia(x.mediaId)?.durationSec || 0)
            .reduce((m, d) => Math.max(m, d), 0);
          if (a <= 0.5 || Math.abs(a - s.duration_sec) < 0.02) return null;
          return (
            <button className="btn sm" type="button"
              title="Set the timeline to the length of the audio track"
              onClick={() => s.setDuration(Number(a.toFixed(2)))}>
              Match audio ({a.toFixed(2)}s)
            </button>
          );
        })()}
        <span className="sep" />
        <span className="lbl">Win</span>
        <input
          className="nin num"
          value={s.timeline.slidingWindowSize}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              s.setWin(
                stepGrid(
                  s.timeline.slidingWindowSize,
                  e.key === "ArrowUp" ? 1 : -1,
                  H3.WINDOW_OFFSET,
                  H3.WINDOW_STEP,
                  H3.WINDOW_MIN,
                  H3.WINDOW_MAX * 4,
                ),
              );
            }
          }}
          onChange={(e) => s.setWin(Number(e.target.value))}
        />
        <span className="lbl">Ovl</span>
        <input
          className="nin num"
          value={s.timeline.slidingWindowOverlap}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              s.setOvl(
                stepGrid(
                  s.timeline.slidingWindowOverlap,
                  e.key === "ArrowUp" ? 1 : -1,
                  H3.OVERLAP_OFFSET,
                  H3.OVERLAP_STEP,
                  H3.OVERLAP_MIN,
                  H3.OVERLAP_MAX,
                ),
              );
            }
          }}
          onChange={(e) => s.setOvl(Number(e.target.value))}
        />
        <span className="wininfo num">
          {stats.windows} windows × {stats.newFrames} new frames
        </span>
        <label
          className="chk"
          title="Set each window's length yourself. Turn this on and the window boundaries below become draggable."
        >
          <input
            type="checkbox"
            checked={!!s.timeline.manualWindows}
            onChange={(e) => {
              s.setManualWindows(e.target.checked);
              if (e.target.checked && !s.timeline.showWindows) {
                // Nothing to drag if the bands are hidden.
                s.patchTimeline({ showWindows: true });
              }
              s.setToast(e.target.checked
                ? "Manual windows on — drag the boundaries in the band strip"
                : "Back to equal windows");
            }}
          />{" "}
          manual
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.timeline.showWindows}
            onChange={(e) => s.patchTimeline({ showWindows: e.target.checked })}
          />{" "}
          bands
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.timeline.snap}
            onChange={(e) => s.patchTimeline({ snap: e.target.checked })}
          />{" "}
          snap
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.timeline.allowPastCap}
            onChange={(e) => s.patchTimeline({ allowPastCap: e.target.checked })}
          />{" "}
          past cap
        </label>
        <span className="sep" />
        <button className="btn sm" type="button" onClick={() => s.togglePlay()}>
          {s.playing ? <Pause size={11} /> : <Play size={11} />} {s.playing ? "Pause" : "Play"}
        </button>
        <button
          className={`btn sm${s.loopPlayback ? " on" : ""}`}
          type="button"
          title={s.loopPlayback ? "Looping — click to play once" : "Play once — click to loop"}
          onClick={() => s.setLoopPlayback(!s.loopPlayback)}
        >
          <Repeat size={11} /> Loop
        </button>
        <button
          className="btn sm dg"
          type="button"
          onClick={() => {
            setClearArm(true);
          }}
        >
          <Trash2 size={11} /> Clear
        </button>
        <button
          className="btn sm"
          type="button"
          title="Open the manual: tracks, lengths, references, bridges and what to do when something looks wrong."
          onClick={() => s.setManualOpen(true)}
        >
          <HelpCircle size={11} /> Help
        </button>
        <span className="tc num">
          {formatTimecode(s.timeline.playhead / s.fps).slice(3)}s / {s.duration_sec.toFixed(2)}s
        </span>
      </div>

      <div
        className="cvwrap"
        ref={wrapRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const hit = trackAt(e.clientX, e.clientY);
          if (!hit) return;
          e.preventDefault();
          onDrop(e, hit.id);
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".seg-c")) return;   // that opens the preview
          const hit = trackAt(e.clientX, e.clientY);
          if (!hit) return;                       // outside every row - hit can be null
          // The track you double-click decides what you get. No guessing:
          // top track = an ordinary text prompt, guidance track = a gap prompt.
          if (hit.id === "video") {
            s.addSegment("text", "video", hit.frame);
            return;
          }
          if (hit.id === "control") {
            s.addSegment("text", "control", hit.frame, {
              title: "Bridge", prompt: "", length: Math.round(s.fps * 3),
            });
            const hasClip = s.timeline.segments.some((x) => x.track === "control" && x.mediaId);
            s.setToast(hasClip
              ? "Bridge prompt added - describe what happens between the clips"
              : "Bridge prompt added - it needs a guidance clip before or after it to do anything");
            return;
          }
        }}
        onWheel={onWheel}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerDown={onBg}

      >
        {s.askDuration && (
          <div className="askbar">
            <span className="sp">
              {s.askDuration.name} is {fmtDuration(s.askDuration.seconds)}. Set the timeline to that length?
            </span>
            <button className="btn sm go" type="button" onClick={() => {
              s.setDuration(s.askDuration!.seconds); s.setAskDuration(null);
            }}>Set to {s.askDuration.seconds}s</button>
            <button className="btn sm" type="button" onClick={() => s.setAskDuration(null)}>
              Keep {s.duration_sec}s
            </button>
          </div>
        )}
        <div className="rul">
          {ticks.map((t) => (
            <span key={`${t.f}-${t.minor ? "m" : "M"}`} className={`tk num${t.minor ? " minor" : ""}`} style={{ left: xOf(t.f) }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="winstrip">
          {s.timeline.showWindows &&
            stats.spans.map((w, i) => (
              <div
                key={w.i}
                className="band"
                style={{
                  left: xOf(w.start),
                  width: Math.max(1, xOf(w.end) - xOf(w.start)),
                  background: i % 2 === 0 ? "rgba(64,118,208,.85)" : "rgba(208,148,64,.85)",
                }}
              />
            ))}
          {s.timeline.showWindows &&
            stats.spans.slice(1).map((w) => (
              <div
                key={`o${w.i}`}
                className="ovl"
                style={{
                  left: xOf(w.start),
                  width: Math.max(2, (s.timeline.slidingWindowOverlap / vis) * width),
                }}
              />
            ))}
          {/* How long each window is, so the size is never a guess. */}
          {s.timeline.showWindows &&
            stats.spans.map((w) => {
              const px = xOf(w.end) - xOf(w.start);
              if (px < 34) return null;
              return (
                <span
                  key={`wl${w.i}`}
                  className="wlab"
                  style={{ left: xOf(w.start) + px / 2 }}
                  title={`Window ${w.i + 1}: ${w.end - w.start} frames`}
                >
                  {((w.end - w.start) / s.fps).toFixed(2)}s
                </span>
              );
            })}
          {/* In manual mode every inner boundary is a handle. */}
          {s.timeline.showWindows && stats.manual &&
            stats.spans.slice(1).map((w) => (
              <div
                key={`wh${w.i}`}
                className="whandle"
                style={{ left: xOf(w.start) }}
                title={`Drag to resize windows ${w.i} and ${w.i + 1}`}
                onPointerDown={startEdgeDrag(w.i)}
              />
            ))}
        </div>
        <div className="tracks">
          {s.timeline.showWindows &&
            stats.spans.map((w, i) => (
              <div
                key={`t${w.i}`}
                className="tint"
                style={{
                  left: xOf(w.start),
                  width: Math.max(1, xOf(w.end) - xOf(w.start)),
                  background: i % 2 === 0 ? "rgba(64,118,208,.05)" : "rgba(208,148,64,.05)",
                }}
              />
            ))}
          {s.timeline.showWindows &&
            stats.spans.slice(1).map((w) => (
              <div key={`bl${w.i}`} className="bline" style={{ left: xOf(w.start) }} />
            ))}
          {/* The band strip is only a few pixels tall, so the boundary is also
              grabbable down the full height of the tracks. */}
          {s.timeline.showWindows && stats.manual &&
            stats.spans.slice(1).map((w) => (
              <div
                key={`th${w.i}`}
                className="whandle tall"
                style={{ left: xOf(w.start) }}
                title={`Drag to resize windows ${w.i} and ${w.i + 1}`}
                onPointerDown={startEdgeDrag(w.i)}
              />
            ))}

          {TRACKS.map((tr, ti) => {
            const segs = s.timeline.segments.filter((x) => x.track === tr.id);
            return (
              <div
                key={tr.id}
                className="trk"
                data-track={tr.id}
                style={{ height: tr.h, borderBottom: ti === TRACKS.length - 1 ? 0 : undefined }}
                onDragOver={(e) => e.preventDefault()}
              >
                <span className="tlab">{tr.label}</span>
                {segs.map((seg, si) => {
                  const videoSegs = s.timeline.segments.filter((x) => x.track === "video").sort((a, b) => a.start - b.start);
                  const idx = videoSegs.findIndex((x) => x.id === seg.id);
                  const GEO: Record<string, { top: number; h: number }> = {
                    video: { top: 14, h: 36 },
                    control: { top: 13, h: 25 }, clipaudio: { top: 11, h: 19 }, audio: { top: 12, h: 22 },
                  };
                  const { top, h } = GEO[tr.id] ?? { top: 12, h: 22 };
                  const muted = seg.muted && tr.id === "clipaudio";
                  return (
                    <div
                      key={seg.id}
                      className={`seg-c${s.selectedId === seg.id ? " sel" : ""}`}
                      style={{
                        left: xOf(seg.start),
                        width: Math.max(8, xOf(seg.start + seg.length) - xOf(seg.start)),
                        top,
                        height: h,
                        background: seg.color,
                        opacity: muted ? 0.45 : 1,
                        color: muted ? "#eafaf4" : "#0d1620",
                      }}
                      onPointerDown={(e) => onSegPointer(e, seg, "move")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (dragged.current) return;   // a drag is not a click
                        s.select(seg.id);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        // A prompt opens the big editor: a text prompt on the
                        // injected-frames track, or a bridge prompt on the
                        // control track (a control segment with no media).
                        if (seg.kind === "text" || (tr.id === "control" && !seg.mediaId)) {
                          s.select(seg.id);
                          s.setPromptEdit(seg.id);
                          return;
                        }
                        const m = getMedia(seg.mediaId);
                        if (m?.kind === "video" && seg.mediaId) {
                          // A video opens the monitor, which follows the playhead.
                          s.setMonitor({ mediaId: seg.mediaId, name: m.name || seg.title || "", start: seg.start });
                          return;
                        }
                        const url = m?.url || servedUrl(m) || (seg.mediaId ? `need:${seg.mediaId}` : seg.mediaUrl);
                        if (url) s.setPreview({ url, kind: seg.kind === "image" ? "image" : seg.kind === "audio" || seg.kind === "clipaudio" ? "audio" : "video", name: seg.fileName || seg.title || "" });
                      }}
                      title={seg.kind === "text" || (tr.id === "control" && !seg.mediaId)
                        ? "Double-click to write this prompt in a big editor"
                        : "Double-click to preview"}
                      data-bridge={tr.id === "control" && !seg.mediaId ? "1" : undefined}
                      data-oor={seg.start >= maxF ? "1" : undefined}
                      data-under={
                        segs.some((o) =>
                          o.id !== seg.id &&
                          o.start < seg.start + seg.length &&
                          o.start + o.length > seg.start)
                          ? "1"
                          : undefined
                      }
                      data-xwin={
                        tr.id === "video" &&
                        stats.spans.some((w) => w.start > seg.start && w.start < seg.start + seg.length)
                          ? "1"
                          : undefined
                      }
                    >
                      {(tr.id === "audio" || tr.id === "clipaudio") && <Wave seg={seg} />}
                      {tr.id !== "audio" && tr.id !== "clipaudio" && !(tr.id === "control" && !seg.mediaId) && (
                        <span className="thumb" style={{ width: tr.id === "control" ? 28 : 34 }}>
                          {(() => {
                            const m = getMedia(seg.mediaId);
                            if (m?.missing) return <span className="miss" title="File not on disk">!</span>;
                            const src = m?.thumb || servedUrl(m) || "";
                            if (src) return <img src={src} alt="" />;
                            return seg.thumbLabel || (idx >= 0 ? String(idx + 1) : "");
                          })()}
                        </span>
                      )}
                      {segs.some((o) => o.id !== seg.id && o.start < seg.start + seg.length && o.start + o.length > seg.start) && (
                        <span className="ovl-badge" title="Another item on this track overlaps this one">overlap</span>
                      )}
                      {s.selectedId === seg.id && (
                        <button type="button" className="seg-x" title="Delete this segment"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); s.removeSeg(seg.id); }}>×</button>
                      )}
                      <span style={{ marginLeft: tr.id === "audio" || tr.id === "clipaudio" ? 0 : tr.id === "control" ? 31 : 37 }}>
                        {tr.id === "video" && idx >= 0 ? `${idx + 1} · ${seg.title}` : muted ? "muted" : seg.title}
                      </span>
                      <span className="handle l" onPointerDown={(e) => onSegPointer(e, seg, "l")} />
                      <span className="handle r" onPointerDown={(e) => onSegPointer(e, seg, "r")} />
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="ph" style={{ left: xOf(s.timeline.playhead) }} />
        </div>
      </div>
      <div
        className="zoom"
        onPointerDown={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const p = (e.clientX - r.left) / r.width;
          const span = viewEnd - viewStart;
          let start = p * maxF - span / 2;
          start = Math.max(0, Math.min(maxF - span, start));
          s.setView(start, start + span);
        }}
      >
        <div className="zwin" style={{ left: `${zLeft}%`, width: `${zW}%` }} />
      </div>
    </section>
    </>
  );
}
