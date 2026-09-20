import { create } from "zustand";
import type {
  AdvTab,
  GenJob,
  Mode,
  PaneId,
  Pipeline,
  RefImage,
  Segment,
  SessionPayload,
  TrackId,
} from "./types";
import { AUDIO_COLOR, CLIP_AUDIO_COLOR, CONTROL_COLOR, VIDEO_COLORS } from "./types";
import { demoSession, uid } from "./defaults";
import {
  estimateMinutes,
  H3,
  readDurationSeconds,
  realWindows,
  seedWindowFrames,
  snapWindowPair,
  spansFromFrames,
  planDurations,
  validateWindowFrames,
  windowCeilingFrames,
  windowLimitsText,
  windowFloorFrames,
  windowSecondsWarning,
} from "./h3";
import { buildPromptRelay } from "./prompt";
import { assembleWanSettings } from "./session";
import { configurePersist, flushNow, loadProject, markDirty, missingMedia } from "./persist";
import { request, hasParent, send, on } from "./bridge";
import { startAudio, stopAudio, audioFrame, unlockAudio, audioBlockReason } from "./audio";

const LS_KEY = "h3-director-v22";
const pollAt: { last: number } = { last: 0 };

export interface DirectorState extends SessionPayload {
  pane: PaneId;
  mode: Mode;
  advTab: AdvTab;
  selectedId: string | null;
  selectedRef: number | null;
  job: GenJob;
  dirty: boolean;
  wiringOk: boolean;
  lastAutosave?: string;
  viewStart: number;
  viewEnd: number;
  playing: boolean;
  scheduleOpen: boolean;
  toast: string | null;
  preview: { url: string; kind: string; name: string } | null;
  monitor: { mediaId: string; name: string; start: number; x?: number; y?: number } | null;
  /** Segment whose prompt is open in the big editor (double-click a prompt). */
  promptEdit: string | null;
  setPromptEdit: (id: string | null) => void;
  /** The built-in manual (Help button on the timeline). */
  manualOpen: boolean;
  setManualOpen: (v: boolean) => void;
  /** Turn hand-set window lengths on or off. Seeds from the automatic plan. */
  setManualWindows: (on: boolean) => void;
  /** Move the boundary BEFORE window `i` to `frame`, resizing both neighbours. */
  dragWindowEdge: (i: number, frame: number) => void;
  /** Give window `i` exactly this many frames, taking the difference from the
   *  next window so the total still matches the timeline. */
  setWindowFrames: (i: number, frames: number) => void;
  /** Throw away the hand-set layout and go back to equal windows. */
  resetWindowFrames: () => void;
  /** Resize windows to the durations typed into the prompts. */
  applyPromptDurations: () => void;
  /** Divide the timeline evenly into exactly this many windows. */
  setWindowCount: (n: number) => void;
  /** The window picked out on the timeline, or null. Backspace/Delete removes it. */
  selectedWindow: number | null;
  selectWindow: (i: number | null) => void;
  /** Remove the selected window, folding its frames into a neighbour. */
  removeSelectedWindow: () => void;
  /** Put a new window boundary at this frame, splitting whatever window it falls in. */
  addWindowAt: (frame: number) => void;
  /** Split window `i` into two halves. */
  splitWindow: (i: number) => void;
  /** Fold window `i` into its neighbour, removing one window. */
  mergeWindow: (i: number) => void;
  setMonitor: (m: { mediaId: string; name: string; start: number; x?: number; y?: number } | null) => void;
  lockClipAudio: boolean;
  statusOpen: boolean;
  bridgeOk: boolean | null;
  saveInfo: string;
  setPreview: (p: { url: string; kind: string; name: string } | null) => void;
  setLockClipAudio: (v: boolean) => void;
  setStatusOpen: (v: boolean) => void;
  setBridge: (ok: boolean, info?: string) => void;
  // derived helpers as methods
  setPane: (p: PaneId) => void;
  setMode: (m: Mode) => void;
  setAdvTab: (t: AdvTab) => void;
  patch: (p: Partial<SessionPayload>) => void;
  patchAdvanced: (p: Record<string, unknown>) => void;
  patchRefs: (p: Partial<SessionPayload["refs"]>) => void;
  patchAudio: (p: Partial<SessionPayload["audio"]>) => void;
  patchSfx: (p: Partial<SessionPayload["sfx"]>) => void;
  patchExport: (p: Partial<SessionPayload["exportInclude"]>) => void;
  patchBuilder: (p: Partial<SessionPayload["builder"]>) => void;
  patchTimeline: (p: Partial<SessionPayload["timeline"]>) => void;
  setFps: (n: number) => void;
  setDuration: (s: number, opts?: { silent?: boolean }) => void;
  durationLocked: boolean;
  loopPlayback: boolean;
  setLoopPlayback: (v: boolean) => void;
  autoRenumberRefs: boolean;
  installedModels: { model_type: string; name: string; pipeline?: string; size?: string; finetune?: boolean }[];
  askDuration: { seconds: number; name: string } | null;
  setAskDuration: (a: { seconds: number; name: string } | null) => void;
  setWin: (n: number) => void;
  setOvl: (n: number) => void;
  select: (id: string | null) => void;
  selectRef: (i: number | null) => void;
  updateSeg: (id: string, p: Partial<Segment>) => void;
  moveSeg: (id: string, start: number, length?: number) => void;
  addSegment: (kind: Segment["kind"], track: TrackId, atFrame?: number, extra?: Partial<Segment>) => string;
  removeSeg: (id: string) => void;
  splitSegAtWindows: (id: string) => void;
  clearTimeline: () => void;
  addRefImage: (img: RefImage) => void;
  removeRefImage: (id: string) => void;
  reorderRefs: (from: number, to: number) => void;
  makeRefFirst: (id: string) => void;
  setPlayhead: (f: number) => void;
  setView: (start: number, end: number) => void;
  togglePlay: () => void;
  tickPlay: (dtSec: number) => void;
  saveNow: () => SessionPayload;
  currentPayload: () => SessionPayload;
  loadSession: (p: SessionPayload) => void;
  recover: () => boolean;
  resetDemo: () => void;
  newProject: () => void;
  previewSchedule: () => void;
  generate: (scope: "all" | "here") => void;
  cancel: () => void;
  applyToGenerator: () => Promise<void>;
  previewPrompt: () => Promise<void>;
  reattachJob: () => Promise<void>;
  finalPrompt: string;
  finalPromptNote: string;
  tickJob: () => void;
  setToast: (t: string | null) => void;
  setScheduleOpen: (v: boolean) => void;
}

function totalFrames(s: Pick<SessionPayload, "fps" | "duration_sec">) {
  return Math.max(1, Math.round(s.duration_sec * s.fps));
}

function clampSeg(seg: Segment, maxF: number, snap: boolean, win: number, ovl: number, others: Segment[]): Segment {
  let start = Math.max(0, Math.round(seg.start));
  let length = Math.max(4, Math.round(seg.length));
  if (start + length > maxF) {
    if (seg.kind === "audio") {
      length = Math.max(4, maxF - start);
    } else {
      start = Math.min(start, Math.max(0, maxF - length));
      length = Math.min(length, maxF - start);
    }
  }
  if (snap) {
    const wins = realWindows(maxF, win, ovl);
    const edges = [0, maxF, ...wins.flatMap((w) => [w.start, w.end])];
    for (const o of others) {
      if (o.id === seg.id || o.track !== seg.track) continue;
      edges.push(o.start, o.start + o.length);
    }
    const snapTo = (v: number) => {
      let best = v;
      let d = 6;
      for (const e of edges) {
        const dd = Math.abs(e - v);
        if (dd < d) {
          d = dd;
          best = e;
        }
      }
      return best;
    };
    start = snapTo(start);
    const end = snapTo(start + length);
    length = Math.max(4, end - start);
  }
  return { ...seg, start, length };
}

const demo = demoSession();

export const useDirector = create<DirectorState>()((set, get) => ({
      ...demo,
      pane: "refs",
      mode: "basic",
      advTab: "general",
      selectedId: demo.timeline.segments.find((s) => s.track === "video")?.id ?? null,
      selectedRef: 0,
      job: { id: "idle", status: "idle", windowIndex: 0, windows: 0, progress: 0, logs: [] },
      dirty: false,
      wiringOk: true,
      viewStart: 0,
      viewEnd: demo.duration_sec * demo.fps,
      playing: false,
      scheduleOpen: false,
      toast: null,
      preview: null,
      monitor: null,
      setMonitor: (mo) => set({ monitor: mo }),
      promptEdit: null,
      setPromptEdit: (id) => set({ promptEdit: id }),
      manualOpen: false,
      setManualOpen: (v) => set({ manualOpen: v }),

      setManualWindows: (on) =>
        set((st) => {
          const total = totalFrames(st);
          // Turning manual ON hands over the layout that is on screen RIGHT
          // NOW, always. It used to prefer a layout saved earlier in the
          // project, which is why the borders jumped a few frames: the saved
          // one was drawn by an older build, or before the timeline changed.
          // Manual mode is "let me move these borders", not "load some other
          // borders" -- a saved layout is restored by opening the project,
          // which does not come through here.
          const frames = on
            ? seedWindowFrames(
                total, st.timeline.slidingWindowSize, st.timeline.slidingWindowOverlap)
            : st.timeline.windowFrames;

          return {
            timeline: { ...st.timeline, manualWindows: on, windowFrames: frames },
            dirty: (markDirty(), true),
          };
        }),

      dragWindowEdge: (i, frame) =>
        set((st) => {
          const frames = [...(st.timeline.windowFrames || [])];
          if (i < 1 || i >= frames.length) return {};
          const before = frames.slice(0, i - 1).reduce((a, b) => a + b, 0);

          // NOTHING is clamped to the model's limits here. Arranging a layout
          // means putting one window out of range to get the next one right,
          // and a boundary that stops dead is worse than one that lets you
          // overshoot. The limits are reported in the panel, shown on the
          // bands, and enforced at Generate -- not with the mouse.
          //
          // The only floor is one frame, because a window of zero is not a
          // window. The total stays equal to the timeline: what one window
          // gains, the ones after it give up, nearest first.
          let prev = Math.max(1, Math.round(frame) - before);
          const tailTotal = frames.slice(i).reduce((a, b) => a + b, 0);
          const tailCount = frames.length - i;
          prev = Math.min(prev, frames[i - 1] + tailTotal - tailCount);  // leave 1 each
          let delta = prev - frames[i - 1];
          if (delta === 0) return {};

          const tail = frames.slice(i);
          let need = delta;
          for (let k = 0; k < tail.length && need !== 0; k++) {
            if (need > 0) {
              const take = Math.min(tail[k] - 1, need);
              if (take > 0) { tail[k] -= take; need -= take; }
            } else {
              tail[k] += -need;                 // the nearest window absorbs it all
              need = 0;
            }
          }
          const moved = delta - need;
          if (moved === 0) return {};
          frames[i - 1] += moved;
          for (let k = 0; k < tail.length; k++) frames[i + k] = tail[k];
          return { timeline: { ...st.timeline, windowFrames: frames }, dirty: (markDirty(), true) };
        }),

      setWindowFrames: (i, want) =>
        set((st) => {
          const frames = [...(st.timeline.windowFrames || [])];
          if (i < 0 || i >= frames.length) return {};
          const n = Math.max(1, Math.round(want));
          const j = i + 1 < frames.length ? i + 1 : i - 1;
          if (j < 0) {
            frames[i] = n;
          } else {
            // Same rule as dragging: free to be out of range, but the total
            // must keep matching the timeline.
            const pair = frames[i] + frames[j];
            const other = pair - n;
            if (other < 1) return {};
            frames[i] = n;
            frames[j] = other;
          }
          return { timeline: { ...st.timeline, windowFrames: frames }, dirty: (markDirty(), true) };
        }),

      applyPromptDurations: () =>
        set((st) => {
          const lay = windowLayout(st);
          const want = promptDurationFrames(st, lay.spans);
          if (!want.some((x) => x != null)) return {};
          const frames = lay.frames.map((f, i) => (want[i] == null ? f : (want[i] as number)));
          // Whatever the prompts do not account for lands on the last window,
          // so the total still matches the timeline.
          const fixedTo = frames.length - 1;
          const sum = frames.reduce((a, b) => a + b, 0);
          if (sum !== lay.maxF) frames[fixedTo] += lay.maxF - sum;
          const floor = windowFloorFrames();
          const ceil = windowCeilingFrames(lay.ovl);
          if (frames.some((f) => f < floor || f > ceil)) {
            return { toast: "Those prompt lengths do not fit the model's window limits" };
          }
          return {
            timeline: { ...st.timeline, manualWindows: true, windowFrames: frames },
            dirty: (markDirty(), true),
            toast: "Windows resized to match the prompts",
          };
        }),

      selectedWindow: null,
      selectWindow: (i) => set({ selectedWindow: i }),

      removeSelectedWindow: () => {
        const st = get();
        const i = st.selectedWindow;
        const frames = st.timeline.windowFrames || [];
        if (i == null || i < 0 || i >= frames.length) return;
        if (frames.length < 2) { set({ toast: "The last window cannot be removed" }); return; }
        get().mergeWindow(i);
        // Keep a sensible selection: the window that absorbed it.
        set((s2) => ({
          selectedWindow: Math.min(i, (s2.timeline.windowFrames || []).length - 1),
          toast: `Window ${i + 1} removed`,
        }));
      },

      addWindowAt: (frame) =>
        set((st) => {
          const frames = [...(st.timeline.windowFrames || [])];
          if (!frames.length) return {};
          const at = Math.round(frame);
          // Which window does the marker fall in, and how far into it?
          let start = 0;
          for (let i = 0; i < frames.length; i++) {
            const end = start + frames[i];
            if (at > start && at < end) {
              const left = at - start;
              const right = end - at;
              frames.splice(i, 1, left, right);
              return {
                timeline: { ...st.timeline, manualWindows: true, windowFrames: frames },
                selectedWindow: i,
                dirty: (markDirty(), true),
                toast: `Window split at ${(at / Math.max(1, st.fps)).toFixed(2)}s`,
              };
            }
            start = end;
          }
          return { toast: "Move the playhead inside a window to split it there" };
        }),

      setWindowCount: (n) =>
        set((st) => {
          const total = totalFrames(st);
          const count = Math.max(1, Math.min(64, Math.round(n)));
          // Even shares, with the remainder on the last so the total is exact.
          const each = Math.floor(total / count);
          const frames = Array.from({ length: count }, () => Math.max(1, each));
          const sum = frames.reduce((a, b) => a + b, 0);
          frames[count - 1] += total - sum;
          return {
            timeline: { ...st.timeline, manualWindows: true, windowFrames: frames },
            dirty: (markDirty(), true),
          };
        }),

      splitWindow: (i) =>
        set((st) => {
          const frames = [...(st.timeline.windowFrames || [])];
          if (i < 0 || i >= frames.length || frames[i] < 2) return {};
          const half = Math.floor(frames[i] / 2);
          frames.splice(i, 1, half, frames[i] - half);
          return { timeline: { ...st.timeline, windowFrames: frames }, dirty: (markDirty(), true) };
        }),

      mergeWindow: (i) =>
        set((st) => {
          const frames = [...(st.timeline.windowFrames || [])];
          if (frames.length < 2 || i < 0 || i >= frames.length) return {};
          // Fold into the next window, or into the previous one at the end.
          const j = i + 1 < frames.length ? i + 1 : i - 1;
          frames[j] += frames[i];
          frames.splice(i, 1);
          return { timeline: { ...st.timeline, windowFrames: frames }, dirty: (markDirty(), true) };
        }),

      resetWindowFrames: () =>
        set((st) => ({
          timeline: {
            ...st.timeline,
            windowFrames: seedWindowFrames(
              totalFrames(st), st.timeline.slidingWindowSize, st.timeline.slidingWindowOverlap),
          },
          dirty: (markDirty(), true),
        })),
      lockClipAudio: true,
      durationLocked: false,
      loopPlayback: false,
      setLoopPlayback: (v) => set({ loopPlayback: v }),
      autoRenumberRefs: true,
      finalPrompt: "",
      finalPromptNote: "",
      installedModels: [],
      askDuration: null,
      setAskDuration: (a) => set({ askDuration: a }),
      statusOpen: false,
      bridgeOk: null,
      saveInfo: "",
      setPreview: (p) => set({ preview: p }),
      setLockClipAudio: (v) => set({ lockClipAudio: v, dirty: (markDirty(), true) }),
      setStatusOpen: (v) => set({ statusOpen: v }),
      setBridge: (ok, info) => set({ bridgeOk: ok, saveInfo: info ?? get().saveInfo }),

      setPane: (p) => set({ pane: p }),
      setMode: (m) => set({ mode: m }),
      setAdvTab: (t) => set({ advTab: t }),
      patch: (p) => set({ ...p, dirty: (markDirty(), true) }),
      patchAdvanced: (p) => set((s) => ({ advanced: { ...s.advanced, ...p }, dirty: (markDirty(), true) })),
      patchRefs: (p) => set((s) => ({ refs: { ...s.refs, ...p }, dirty: (markDirty(), true) })),
      patchAudio: (p) => set((s) => ({ audio: { ...s.audio, ...p }, dirty: (markDirty(), true) })),
      patchSfx: (p) => set((s) => ({ sfx: { ...s.sfx, ...p }, dirty: (markDirty(), true) })),
      patchExport: (p) =>
        set((s) => ({
          exportInclude: { ...s.exportInclude, ...p } as SessionPayload["exportInclude"],
          dirty: (markDirty(), true),
        })),
      patchBuilder: (p) => set((s) => ({ builder: { ...s.builder, ...p }, dirty: (markDirty(), true) })),
      patchTimeline: (p) =>
        set((s) => ({ timeline: { ...s.timeline, ...p }, dirty: (markDirty(), true) })),

      setFps: (n) => {
        const fps = Math.max(1, Math.min(120, Math.round(n) || 24));
        set((s) => ({
          fps,
          timeline: { ...s.timeline, fps },
          dirty: (markDirty(), true),
        }));
      },
      setDuration: (sec, opts) => {
        if (!opts?.silent) set({ durationLocked: true });
        const duration_sec = Math.max(0.5, Math.min(600, sec));
        set((s) => {
          const maxF = Math.round(duration_sec * s.fps);
          return {
            duration_sec,
            timeline: {
              ...s.timeline,
              durationSec: duration_sec,
              playhead: Math.min(s.timeline.playhead, maxF),
              // Changing the timeline length changes the TIMELINE, nothing
              // else. Stretching the audio and truncating shots to fit was
              // destroying work on every duration edit. Items past the new end
              // stay exactly as they are and are flagged out of range.
              segments: s.timeline.segments,
            },
            viewEnd: Math.max(get().viewEnd, maxF),
            dirty: (markDirty(), true),
          };
        });
      },
      setWin: (n) => {
        const [ws, ov] = snapWindowPair(n, get().timeline.slidingWindowOverlap);
        set((s) => ({
          timeline: { ...s.timeline, slidingWindowSize: ws, slidingWindowOverlap: ov },
          dirty: (markDirty(), true),
        }));
      },
      setOvl: (n) => {
        const [ws, ov] = snapWindowPair(get().timeline.slidingWindowSize, n);
        set((s) => ({
          timeline: { ...s.timeline, slidingWindowSize: ws, slidingWindowOverlap: ov },
          dirty: (markDirty(), true),
        }));
      },
      select: (id) => set({ selectedId: id, pane: id ? get().pane : get().pane }),
      selectRef: (i) => set({ selectedRef: i }),
      updateSeg: (id, p) =>
        set((s) => ({
          timeline: {
            ...s.timeline,
            segments: s.timeline.segments.map((seg) => (seg.id === id ? { ...seg, ...p } : seg)),
          },
          dirty: (markDirty(), true),
        })),
      moveSeg: (id, start, length) =>
        set((s) => {
          const maxF = totalFrames(s);
          const segs = s.timeline.segments;
          const next = segs.map((seg) => {
            if (seg.id !== id) return seg;
            return clampSeg(
              { ...seg, start, length: length ?? seg.length },
              maxF,
              s.timeline.snap,
              s.timeline.slidingWindowSize,
              s.timeline.slidingWindowOverlap,
              segs,
            );
          });
          // Clip audio moves with ITS OWN clip and nothing else. Matching on
          // track alone dragged every companion on the timeline - including
          // when a bridge prompt, which has no audio at all, was nudged.
          let out = next;
          if (s.lockClipAudio) {
            const moved = next.find((x) => x.id === id);
            const before = segs.find((x) => x.id === id);
            if (moved && before) {
              const dStart = moved.start - before.start;
              const dLen = moved.length - before.length;
              if (dStart !== 0 || dLen !== 0) {
                // the partner is the linked one: child of this clip, or its parent
                const partnerId =
                  moved.track === "clipaudio"
                    ? moved.parentId
                    : next.find((x) => x.parentId === moved.id)?.id;
                if (partnerId) {
                  out = next.map((x) =>
                    x.id === partnerId
                      ? { ...x, start: Math.max(0, x.start + dStart), length: Math.max(1, x.length + dLen) }
                      : x,
                  );
                }
              }
            }
          }
          return { timeline: { ...s.timeline, segments: out }, dirty: (markDirty(), true) };
        }),
      addSegment: (kind, track, atFrame, extra) => {
        const s = get();
        const maxF = totalFrames(s);
        const play = atFrame ?? s.timeline.playhead;
        const winLen = Math.min(
          s.timeline.slidingWindowSize,
          Math.max(24, Math.round(s.fps * 4)),
        );
        const defaults: Record<string, Partial<Segment>> = {
          text: {
            title: "New prompt",
            prompt: "",
            thumbLabel: "txt",
            color: VIDEO_COLORS[s.timeline.segments.filter((x) => x.track === "video").length % VIDEO_COLORS.length],
            length: winLen,
          },
          image: { title: "Image", thumbLabel: "img", color: VIDEO_COLORS[1], length: Math.round(s.fps) },
          video: { title: "Video clip", thumbLabel: "vid", color: VIDEO_COLORS[2], length: winLen },
          control: { title: "Control video", thumbLabel: "▶", color: CONTROL_COLOR, length: winLen, influence: 0.3 },
          clipaudio: { title: "clip audio", color: CLIP_AUDIO_COLOR, length: winLen, muted: false },
          audio: { title: "Audio", color: AUDIO_COLOR, length: maxF, start: 0 },
          refimage: { title: "Reference", thumbLabel: "ref", color: "#5aa0d6", length: winLen },
          refvideo: { title: "Ref video", thumbLabel: "refv", color: "#5aa0d6", length: winLen },
          refaudio: { title: "Voice", color: "#d9a441", length: Math.round(s.fps * 4) },
        };
        const id = uid(kind.slice(0, 2));
        const base: Segment = {
          id,
          kind,
          track,
          start: kind === "audio" ? 0 : play,
          length: winLen,
          title: "Segment",
          prompt: "",
          guideStrength: 1,
          usedRefs: s.refs.images.map((_, i) => i + 1).slice(0, 3),
          ...defaults[kind],
          ...extra,
        };
        const clamped = clampSeg(
          base,
          maxF,
          s.timeline.snap,
          s.timeline.slidingWindowSize,
          s.timeline.slidingWindowOverlap,
          s.timeline.segments,
        );
        set({
          timeline: { ...s.timeline, segments: [...s.timeline.segments, clamped] },
          selectedId: id,
          dirty: (markDirty(), true),
        });
        if (kind === "video" || kind === "control") {
          // auto clip-audio companion
          const ca: Segment = {
            id: uid("ca"),
            parentId: id,              // this audio belongs to THAT clip, nothing else
            mediaId: extra?.mediaId,
            kind: "clipaudio",
            track: "clipaudio",
            start: clamped.start,
            length: clamped.length,
            title: extra?.fileName || "clip audio",
            prompt: "",
            fileName: extra?.fileName,
            guideStrength: 1,
            muted: s.audio.controlVideoAudio === "mute",
            usedRefs: [],
            color: CLIP_AUDIO_COLOR,
          };
          set((st) => ({
            timeline: { ...st.timeline, segments: [...st.timeline.segments, ca] },
          }));
        }
        return id;
      },
      splitSegAtWindows: (id) =>
        set((s) => {
          const seg = s.timeline.segments.find((x) => x.id === id);
          if (!seg) return {};
          const total = totalFrames(s);
          const bands = realWindows(total, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap);
          const cuts = bands
            .map((b) => b.start)
            .filter((c) => c > seg.start && c < seg.start + seg.length);
          if (!cuts.length) return {};
          const edges = [seg.start, ...cuts, seg.start + seg.length];
          const parts = [];
          for (let i = 0; i < edges.length - 1; i++) {
            parts.push({
              ...seg,
              id: i === 0 ? seg.id : uid("seg"),
              start: edges[i],
              length: edges[i + 1] - edges[i],
              title: i === 0 ? seg.title : `${seg.title} (${i + 1})`,
            });
          }
          const rest = s.timeline.segments.filter((x) => x.id !== id);
          return {
            timeline: { ...s.timeline, segments: [...rest, ...parts] },
            toast: `Split into ${parts.length} at the window boundaries`,
            dirty: (markDirty(), true),
          };
        }),
      removeSeg: (id) =>
        set((s) => {
          // A clip and its audio are one thing: removing the clip removes the
          // companion, and removing the companion unlinks rather than orphans.
          const gone = new Set([id]);
          for (const x of s.timeline.segments) if (x.parentId === id) gone.add(x.id);
          const kept = s.timeline.segments.filter((x) => !gone.has(x.id));
          if (gone.size > 1) {
            // nothing to say - it is expected that the audio goes too
          }
          return {
            timeline: { ...s.timeline, segments: kept },
            selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId,
            dirty: (markDirty(), true),
          };
        }),
      clearTimeline: () =>
        set((s) => ({
          timeline: { ...s.timeline, segments: [], playhead: 0 },
          selectedId: null,
          dirty: (markDirty(), true),
        })),
      addRefImage: (img) =>
        set((s) => {
          if (s.refs.images.length >= H3.MAX_REF_IMAGES) return s;
          return { refs: { ...s.refs, images: [...s.refs.images, img] }, dirty: (markDirty(), true) };
        }),
      removeRefImage: (id) =>
        set((s) => ({
          refs: { ...s.refs, images: s.refs.images.filter((r) => r.id !== id) },
          dirty: (markDirty(), true),
        })),
      reorderRefs: (from, to) =>
        set((s) => {
          const arr = [...s.refs.images];
          const [item] = arr.splice(from, 1);
          if (!item) return s;
          arr.splice(to, 0, item);
          return { refs: { ...s.refs, images: arr }, dirty: (markDirty(), true) };
        }),
      makeRefFirst: (id) =>
        set((s) => {
          const arr = [...s.refs.images];
          const i = arr.findIndex((r) => r.id === id);
          if (i <= 0) return s;
          const [item] = arr.splice(i, 1);
          if (item) arr.unshift(item);
          return { refs: { ...s.refs, images: arr }, dirty: (markDirty(), true) };
        }),
      setPlayhead: (f) =>
        set((s) => ({
          timeline: { ...s.timeline, playhead: Math.max(0, Math.min(totalFrames(s), Math.round(f))) },
        })),
      setView: (start, end) => set({ viewStart: Math.max(0, start), viewEnd: Math.max(start + 8, end) }),
      togglePlay: () => {
        // unlockAudio() and startAudio() run SYNCHRONOUSLY inside the click so
        // the AudioContext is resumed under a real user gesture.
        const st = get();
        const playing = !st.playing;
        if (playing) {
          unlockAudio();
          startAudio(st.timeline.segments, st.timeline.playhead, st.fps);
          setTimeout(() => {
            const why = audioBlockReason();
            if (why) useDirector.getState().setToast(why);
          }, 900);
        }
        else stopAudio();
        set({ playing });
      },
      tickPlay: (dtSec) => {
        const s = get();
        if (!s.playing) return;
        // The audio clock is the master; the playhead follows it.
        const af = audioFrame(s.fps);
        if (af !== null) {
          const maxA = Math.round(s.duration_sec * s.fps);
          if (af >= maxA) {
            stopAudio();
            if (s.loopPlayback) {
              // Restart from the top instead of stopping at the end.
              set({ timeline: { ...s.timeline, playhead: 0 } });
              startAudio(s.timeline.segments, 0, s.fps);
              return;
            }
            set({ playing: false, timeline: { ...s.timeline, playhead: maxA } });
            return;
          }
          set({ timeline: { ...s.timeline, playhead: Math.max(0, Math.round(af)) } });
          return;
        }
        const maxF = totalFrames(s);
        const next = s.timeline.playhead + dtSec * s.fps;
        if (next >= maxF) {
          stopAudio();
          if (s.loopPlayback) {
            set({ timeline: { ...s.timeline, playhead: 0 } });
            startAudio(s.timeline.segments, 0, s.fps);
            return;
          }
          set({ playing: false, timeline: { ...s.timeline, playhead: maxF } });
        } else {
          set({ timeline: { ...s.timeline, playhead: next } });
        }
      },
      currentPayload: () => {
        const s = get();
        return {
          plugin: s.plugin,
          version: s.version,
          project_name: s.project_name,
          pipeline: s.pipeline,
          size: s.size,
          global_prompt: s.global_prompt,
          fps: s.fps,
          duration_sec: s.duration_sec,
          hardcuts: s.hardcuts,
          savedAt: s.savedAt,
          advanced: s.advanced,
          refs: s.refs,
          audio: s.audio,
          sfx: s.sfx,
          exportInclude: s.exportInclude,
          builder: s.builder,
          timeline: s.timeline,
          lockClipAudio: s.lockClipAudio,
          durationLocked: s.durationLocked,
          loopPlayback: s.loopPlayback,
          autoRenumberRefs: s.autoRenumberRefs,
        } as SessionPayload;
      },
      saveNow: () => {
        const s = get();
        const now = new Date();
        const savedAt = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const payload: SessionPayload = {
          plugin: s.plugin,
          version: s.version,
          project_name: s.project_name,
          pipeline: s.pipeline,
          size: s.size,
          global_prompt: s.global_prompt,
          fps: s.fps,
          duration_sec: s.duration_sec,
          hardcuts: s.hardcuts,
          savedAt,
          advanced: s.advanced,
          refs: s.refs,
          audio: s.audio,
          sfx: s.sfx,
          exportInclude: s.exportInclude,
          builder: s.builder,
          timeline: s.timeline,
        };
        void flushNow();
        set({ savedAt, dirty: false, lastAutosave: savedAt, toast: `Saved ${s.project_name}` });
        return payload;
      },
      loadSession: (p) => {
        set({
          ...p,
          pane: get().pane,
          mode: get().mode,
          advTab: get().advTab,
          selectedId: p.timeline.segments.find((x) => x.track === "video")?.id ?? null,
          selectedRef: 0,
          dirty: false,
          viewStart: 0,
          viewEnd: Math.round(p.duration_sec * p.fps),
          playing: false,
          toast: `Loaded ${p.project_name}`,
          job: { id: "idle", status: "idle", windowIndex: 0, windows: 0, progress: 0, logs: [] },
        });
      },
      recover: () => {
        try {
          void loadProject<SessionPayload>().then((p) => {
            if (p?.timeline) { get().loadSession(p); set({ toast: "Recovered last autosave" }); }
            else set({ toast: "No autosave found" });
          });
          set({ toast: "Recovered last autosave" });
          return true;
        } catch {
          set({ toast: "Autosave was unreadable" });
          return false;
        }
      },
      resetDemo: () => {
        const d = demoSession();
        get().loadSession(d);
        set({ toast: "Loaded Grinch_1 demo" });
      },
      newProject: () => {
        // Model-side settings are carried over: the same checkpoint,
        // resolution and sampling are almost always reused, and re-picking
        // them every time is friction. Everything that describes the PROJECT
        // is reset.
        const cur = get();
        const keepAdvanced: Record<string, unknown> = {};
        const KEEP = [
          "checkpoint", "pdd", "resolution", "resolution_category",
          "steps", "solver", "sample_solver", "guidance", "guidance_phases",
          "flowshift", "switch_threshold", "attention_sparsity",
          "cache_type", "cache_mult", "cache_start", "override_attention",
          "temporal_upsampling", "spatial_upsampling",
          "film_grain_intensity", "film_grain_saturation",
          "self_refiner_setting", "min_frames_if_references",
          "h3_mask_mode", "h3_audio_refinement",
        ];
        for (const k of KEEP) {
          if (cur.advanced[k] !== undefined) keepAdvanced[k] = cur.advanced[k];
        }

        const d = demoSession();
        d.project_name = "untitled";
        d.timeline.segments = [];
        d.timeline.manualWindows = false;      // a new project starts on equal windows
        d.timeline.windowFrames = undefined;
        d.refs = { ...d.refs, images: [], videos: [], audio: [] };
        d.global_prompt = "";
        d.hardcuts = "";
        d.savedAt = undefined;
        d.advanced = { ...d.advanced, ...keepAdvanced };
        d.pipeline = cur.pipeline;          // model identity, not project data
        d.size = cur.size;
        d.fps = cur.fps;
        get().loadSession(d);

        set({
          // Sound design back to defaults, but keep the folders - those are
          // workflow, not project content.
          sfx: {
            enabled: true, method: cur.sfx?.method, prompt: "", negative: "",
            seed: -1, videoPath: "", outName: "", outDir: cur.sfx?.outDir,
            alsoMux: false, lastAudio: "", lastMuxed: "", status: "", message: "",
            no_music: false, no_speech: false, no_ambience: false, no_effects: false,
          },
          job: { ...cur.job, status: "idle", progress: 0, logs: [], files: [] } as GenJob,
          durationLocked: false,
          finalPrompt: "",
          finalPromptNote: "",
          selectedId: null,
          playing: false,
          dirty: true,
          toast: `New project — kept ${cur.pipeline} / ${cur.size}${cur.advanced.checkpoint ? ` / ${String(cur.advanced.checkpoint)}` : ""}${cur.advanced.pdd ? " / PDD 8-step" : ""} and ${String(cur.advanced.resolution ?? "")}`,
        });
      },
      previewSchedule: () => {
        set({ scheduleOpen: true });
        // Ask PYTHON for the prompt so the modal shows exactly what will be
        // submitted - renumbering included. Building it again in JS here is
        // what made Preview disagree with the terminal.
        void (async () => {
          try {
            const plan = assembleWanSettings(get() as unknown as SessionPayload);
            if (!hasParent()) { set({ finalPrompt: String(plan.prompt || "") }); return; }
            const r = await request<{ prompt: string; renumbered: boolean; injected: number;
              video_prompt_type: string; audio_prompt_type: string; image_prompt_type: string;
              refs: number; model_type: string; video_length: number }>(
              "preview_prompt", { settings: plan, target_frames: totalFrames(get()) }, 60000);
            set({
              finalPrompt: String(r?.prompt || ""),
              finalPromptNote: `${r?.model_type} · ${r?.video_length}f · vpt='${r?.video_prompt_type}' apt='${r?.audio_prompt_type}' ipt='${r?.image_prompt_type}' · ${r?.refs} reference image(s)` +
                (r?.renumbered ? ` · image numbers shifted by ${r.injected}` : " · no renumbering needed"),
            });
          } catch (e) {
            set({ finalPromptNote: `Could not reach Python for the final prompt: ${String(e)}` });
          }
        })();
      },
      generate: (scope) => {
        const s = get();
        if (s.job.status === "running") {
          // Never fail silently here. A run that died without reporting back
          // leaves this stuck on "running" and every later Generate became a
          // no-op with no message at all.
          set({ statusOpen: true, pane: "gen" });
          st_checkStuck();
          return;
        }
        const maxF = totalFrames(s);
        // Hand-set windows that no longer add up would silently generate the
        // wrong length. Refuse and say which, rather than find out afterwards.
        const lay = windowLayout(s);
        if (lay.manual) {
          const found = validateWindowFrames(lay.frames, maxF, lay.ovl, s.fps);
          const blocking = found.filter((b) => b.blocking);
          const advisory = found.filter((b) => !b.blocking);
          if (blocking.length) {
            // Stop and say exactly what is wrong and what the limits are, so
            // the layout can be fixed. Nothing was clamped on the way in, so
            // this is the first and only place it is enforced.
            set({
              statusOpen: true, pane: "gen", advTab: "window",
              toast: blocking[0].text,
              job: { ...s.job, logs: [
                ...s.job.logs,
                { t: Date.now(), level: "err" as const,
                  msg: `Cannot generate: ${blocking.length} window problem(s).` },
                ...blocking.map((b) => ({ t: Date.now(), level: "err" as const, msg: b.text })),
                { t: Date.now(), level: "info" as const,
                  msg: windowLimitsText(lay.ovl, s.fps) },
                { t: Date.now(), level: "info" as const,
                  msg: "Adjust the boundaries on the timeline, or press Even them out under Sliding Window." },
              ] },
            });
            return;
          }
          if (advisory.length) {
            // Out of MiniMax's documented range but still generates. Say so
            // and carry on -- it is the user's call, not ours.
            set({
              job: { ...s.job, logs: [
                ...s.job.logs,
                ...advisory.map((b) => ({ t: Date.now(), level: "warn" as const, msg: b.text })),
              ] },
            });
          }
        }
        // Ask for the window count WanGP will really run, so the status does
        // not start at one number and correct itself to another mid-job. The
        // prompt carries /duration tags, so this is the scheduler's count.
        const n = lay.manual
          ? lay.frames.length
          : planDurations(maxF, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap).windows;
        const here = scope === "here";
        const startW = here
          ? realWindows(maxF, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap).findIndex(
              (w) => s.timeline.playhead >= w.start && s.timeline.playhead < w.end,
            )
          : 0;
        // Clear the previous run completely: a stale "output written to..."
        // banner under a new job reads as if the new one already finished.
        const job: GenJob = {
          id: uid("job"), status: "running", files: [], windowIndex: Math.max(0, startW),
          windows: here ? 1 : n, progress: 0, startedAt: Date.now(),
          logs: [{ t: Date.now(), level: "info", msg: `Submitting to Wan2GP — ${s.pipeline} · ${s.advanced.checkpoint} · ${s.advanced.resolution}` }],
        };
        set({ job, pane: "gen", statusOpen: true, finalPrompt: "", finalPromptNote: "" });

        if (!hasParent()) {
          set((st) => ({ job: { ...st.job, status: "error",
            logs: [...st.job.logs, { t: Date.now(), level: "err", msg: "No Wan2GP bridge — this build is running outside the plugin." }] } }));
          return;
        }
        // Save before submitting: a hard boundary, not the debounce.
        void flushNow()
          .then(() => {
            let plan;
            try {
              plan = assembleWanSettings(get() as unknown as SessionPayload);
            } catch (e) {
              // A throw here used to vanish silently and Generate did nothing.
              throw new Error(`Could not build the generation plan: ${String(e)}`);
            }
            const shots = (plan.window_prompts || []).filter(Boolean).length;
            useDirector.setState((c) => ({
              job: { ...c.job, logs: [...c.job.logs,
                { t: Date.now(), level: "info" as const,
                  msg: `Plan: ${plan.model_type} · ${plan.video_length}f @ ${plan.fps}fps · ${shots} window prompt(s) · prompt ${String(plan.prompt || "").length} chars` }] } as GenJob,
            }));
            const hasBridges = s.timeline.segments.some(
              (x) => x.track === "control" && !x.mediaId && String(x.prompt || "").trim());
            if (hasBridges) {
              // Bridge mode: Python runs one pass per gap and joins the result.
              send("bridgerun", {
                fps: s.fps,
                window: s.timeline.slidingWindowSize,
                overlap: s.timeline.slidingWindowOverlap,
                name: s.project_name,
                dir: s.saveDir || "",
                global_prompt: s.global_prompt,
                settings: plan,
                segments: s.timeline.segments.map((x) => ({
                  id: x.id, track: x.track, start: x.start, length: x.length,
                  mediaId: x.mediaId, prompt: x.prompt, title: x.title, fileName: x.fileName,
                })),
              });
              send("log", { message: `bridge run requested: ${plan.model_type}` });
              return;
            }
            send("generate", { scope, target_frames: maxF, playhead: s.timeline.playhead, settings: plan });
            send("log", { message: `generate requested: ${plan.model_type}` });
            setTimeout(() => {
              const st2 = useDirector.getState();
              if (st2.job.status === "running" && st2.job.logs.length < 3) {
                useDirector.setState((c) => ({
                  job: { ...c.job, logs: [...c.job.logs, { t: Date.now(), level: "warn" as const,
                    msg: "No response from Wan2GP yet — the trigger may not have reached Gradio. Diagnostics reports which bridge controls resolved." }] } as GenJob,
                }));
              }
            }, 6000);
          })
          .catch((e) => {
            const msg = String(e?.message || e);
            console.error("[H3-D] generate failed before submit", e);
            useDirector.setState((c) => ({
              job: { ...c.job, status: "error" as const,
                logs: [...c.job.logs, { t: Date.now(), level: "err" as const, msg }] } as GenJob,
              statusOpen: true,
            }));
            useDirector.getState().setToast(msg);
          });
      },
      /** After a refresh or a dropped socket, ask Python what the job is
       *  doing. The run never stopped - only the stream did. */
      reattachJob: async () => {
        if (!hasParent()) return;
        try {
          const r = await request<{
            status: string; progress: number; phase: string; detail: string;
            step: number | null; steps: number | null; unit: string;
            window: number; windows: number; files: string[]; error: string;
            elapsed: number; attached: boolean; can_cancel: boolean;
            log: { level: string; msg: string }[];
          }>("job_state", {}, 20000);
          if (!r || r.status === "idle") {
            // Nothing running server-side: make sure the UI is not stuck.
            useDirector.setState((c) => (c.job.status === "running"
              ? { job: { ...c.job, status: "idle", progress: 0 } as GenJob }
              : {}));
            return;
          }
          useDirector.setState((c) => ({
            statusOpen: true,
            pane: r.status === "running" ? "gen" : c.pane,
            job: {
              ...c.job,
              status: r.status as GenJob["status"],
              progress: r.progress, windowIndex: r.window, windows: r.windows,
              files: r.files, logs: (r.log || []).map((l) => ({
                t: Date.now(), level: l.level as GenJob["logs"][number]["level"], msg: l.msg })),
              phase: r.phase, detail: r.detail, step: r.step, steps: r.steps,
              unit: r.unit, elapsed: r.elapsed,
            } as GenJob,
          }));
          if (r.status === "running") {
            useDirector.getState().setToast("Reconnected to a run already in progress.");
          }
        } catch { /* nothing to re-attach to */ }
      },
      previewPrompt: async () => {
        const st = get();
        let plan;
        try {
          plan = assembleWanSettings(get() as unknown as SessionPayload);
        } catch (e) {
          st.setToast(`Could not build the plan: ${String(e)}`);
          return;
        }
        if (!hasParent()) { st.setToast("No bridge - cannot preview the final prompt."); return; }
        try {
          // Ask PYTHON for the prompt, so what is shown is exactly what will be
          // submitted - renumbering, flag stripping and all.
          const r = await request<{ prompt: string; model_type: string; video_prompt_type: string;
            audio_prompt_type: string; image_prompt_type: string; refs: number; injected: number;
            renumbered: boolean; video_length: number }>("preview_prompt",
            { settings: plan, target_frames: totalFrames(st) }, 60000);
          set({ pane: "gen", statusOpen: true });
          useDirector.setState((c) => ({
            job: { ...c.job, logs: [...c.job.logs,
              { t: Date.now(), level: "info" as const, msg: "----- prompt as it will be SENT -----" },
              ...String(r.prompt || "").split("\n").map((l) => ({ t: Date.now(), level: "info" as const, msg: l || " " })),
              { t: Date.now(), level: "info" as const,
                msg: `model=${r.model_type} length=${r.video_length}f vpt='${r.video_prompt_type}' apt='${r.audio_prompt_type}' ipt='${r.image_prompt_type}' refs=${r.refs} injected=${r.injected}${r.renumbered ? " (numbers shifted)" : ""}` },
            ] } as GenJob,
          }));
          st.setToast("Prompt preview printed below and in the terminal.");
        } catch (e) {
          st.setToast(`Preview failed: ${String(e)}`);
        }
      },
      applyToGenerator: async () => {
        const st = get();
        await flushNow();
        if (!hasParent()) { st.setToast("No Wan2GP bridge - cannot reach the generator."); return; }
        let plan;
        try {
          plan = assembleWanSettings(get() as unknown as SessionPayload);
        } catch (e) {
          st.setToast(`Could not build the settings: ${String(e)}`);
          return;
        }
        // Apply runs a three-stage Gradio chain, so it goes through its own
        // channel and answers with an "apply" frame rather than a reply here.
        send("apply", { settings: plan, target_frames: totalFrames(st) });
        st.setToast("Applying to the Video Generator...");
      },
      cancel: () => {
        if (hasParent()) void request("cancel", {}, 20000).catch(() => undefined);
        // Always release the lock, even if Python never answers.
        setTimeout(() => useDirector.setState((c) => ({
          job: { ...c.job, status: c.job.status === "running" ? "cancelled" : c.job.status } as GenJob,
        })), 1500);
        return set((s) => ({
          job:
            s.job.status === "running"
              ? {
                  ...s.job,
                  status: "cancelled",
                  logs: [...s.job.logs, { t: Date.now(), level: "warn", msg: "Cancel requested." }],
                }
              : s.job,
        }));
      },
      tickJob: () => {
        // Frames normally arrive from the streaming handler. If they stop
        // (dropped socket) fall back to polling the server-side state, so the
        // panel keeps moving and Cancel keeps working.
        const st = get();
        if (st.job.status !== "running" || !hasParent()) return;
        const now = Date.now();
        const last = (st.job as GenJob & { lastFrame?: number }).lastFrame || 0;
        if (now - last < 6000) return;            // the stream is alive
        if (now - (pollAt.last || 0) < 3000) return;
        pollAt.last = now;
        void get().reattachJob();
      },
      setToast: (t) => set({ toast: t }),
      setScheduleOpen: (v) => set({ scheduleOpen: v }),
    }),
);

let genSubscribed = false;

/** Ask Python whether a job is really running. If it is not, clear the stale
 *  state so the next Generate works instead of silently doing nothing. */
function st_checkStuck() {
  const cur = useDirector.getState();
  if (!hasParent()) {
    useDirector.setState({ job: { ...cur.job, status: "idle" } as GenJob });
    cur.setToast("Cleared a stale 'running' state - press Generate again.");
    return;
  }
  void request<{ status: string; attached: boolean }>("job_state", {}, 15000)
    .then((r) => {
      if (r && r.attached && r.status === "running") {
        useDirector.getState().setToast("A run is already in progress - cancel it first.");
        return;
      }
      useDirector.setState((c) => ({
        job: { ...c.job, status: "idle", progress: 0 } as GenJob,
      }));
      useDirector.getState().setToast("That run had already finished - press Generate again.");
    })
    .catch(() => {
      useDirector.setState((c) => ({ job: { ...c.job, status: "idle" } as GenJob }));
      useDirector.getState().setToast("Cleared a stale 'running' state - press Generate again.");
    });
}

export function hydrateDirector() {
  if (typeof window === "undefined") return;
  if (!genSubscribed) {
    genSubscribed = true;
    on("sfx", (d) => {
      const f = d as { status?: string; message?: string; path?: string; muxed?: string };
      useDirector.getState().patchSfx({
        status: f.status, message: f.message,
        ...(f.path ? { lastAudio: f.path } : {}),
        ...(f.muxed ? { lastMuxed: f.muxed } : {}),
      } as never);
      if (f.status === "done" || f.status === "error") {
        useDirector.getState().setToast(f.message || "");
      }
    });
    on("apply", (d) => {
      const r = d as { ok?: boolean; model?: string; status?: string; error?: string };
      useDirector.getState().setToast(
        r.ok ? (r.status || `Applied${r.model ? ` ${r.model}` : ""} - switching to the Video Generator.`)
             : `Apply failed: ${r.error || "unknown"}`);
    });
    on("bridgerun", (d) => {
      const f = d as {
        status?: string; message?: string; progress?: number; pass?: number; passes?: number;
        logs?: { level: string; msg: string }[]; files?: string[]; joined?: string; error?: string;
      };
      useDirector.setState((c) => {
        const added = (f.logs || []).map((l) => ({ t: Date.now(), level: l.level as GenJob["logs"][number]["level"], msg: l.msg }));
        if (f.message) added.push({ t: Date.now(), level: "info" as const, msg: f.message });
        if (f.error) added.push({ t: Date.now(), level: "err" as const, msg: f.error });
        if (f.joined) added.push({ t: Date.now(), level: "ok" as const, msg: `Joined: ${f.joined}` });
        return {
          statusOpen: true,
          job: {
            ...c.job,
            status: (f.status as GenJob["status"]) || c.job.status,
            progress: typeof f.progress === "number" ? f.progress : c.job.progress,
            windowIndex: Math.max(0, (f.pass || 1) - 1),
            windows: f.passes || c.job.windows,
            phase: f.passes ? `pass ${f.pass} of ${f.passes}` : c.job.phase,
            detail: f.message || c.job.detail,
            files: f.joined ? [f.joined, ...(f.files || [])] : (f.files?.length ? f.files : c.job.files),
            logs: added.length ? [...c.job.logs, ...added].slice(-500) : c.job.logs,
            lastFrame: Date.now(),
          } as GenJob,
        };
      });
    });
    on("gen", (d) => {
      const f = d as {
        status?: string; progress?: number; window?: number; windows?: number;
        logs?: { level: string; msg: string }[]; files?: string[]; error?: string;
        phase?: string; detail?: string; step?: number | null; steps?: number | null;
        unit?: string; elapsed?: number;
      };
      useDirector.setState((c) => {
        const added = (f.logs || []).map((l) => ({ t: Date.now(), level: l.level as GenJob["logs"][number]["level"], msg: l.msg }));
        if (f.error) added.push({ t: Date.now(), level: "err" as const, msg: f.error });
        return {
          statusOpen: true,
          job: {
            ...c.job,
            lastFrame: Date.now(),
            status: (f.status as GenJob["status"]) || c.job.status,
            progress: typeof f.progress === "number" ? f.progress : c.job.progress,
            windowIndex: typeof f.window === "number" ? f.window : c.job.windowIndex,
            windows: f.windows || c.job.windows,
            logs: added.length ? [...c.job.logs, ...added].slice(-500) : c.job.logs,
            files: f.files?.length ? f.files : (c.job as GenJob & { files?: string[] }).files,
            phase: f.phase ?? (c.job as GenJob & { phase?: string }).phase,
            detail: f.detail ?? (c.job as GenJob & { detail?: string }).detail,
            step: f.step ?? null,
            steps: f.steps ?? null,
            unit: f.unit || "",
            elapsed: f.elapsed ?? 0,
          } as GenJob,
        };
      });
    });
  }
  configurePersist(
    () => useDirector.getState().currentPayload(),
    (ok, err, info) => {
      const st = useDirector.getState();
      if (ok) {
        const t = new Date();
        const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
        st.setBridge(true, `saved ${hh} - project.json${info ? ` (${info} bytes)` : ""}`);
        useDirector.setState({ savedAt: hh, dirty: false, lastAutosave: hh });
      } else {
        st.setBridge(false, "write FAILED - " + (err || "see terminal"));
        st.setToast("Autosave FAILED - " + (err || "see terminal"));
      }
    },
  );
  void loadProject<SessionPayload>().then((p) => {
    if (p?.timeline) useDirector.getState().loadSession(p);
    const gone = missingMedia();
    if (gone.length) {
      useDirector.getState().setToast(
        `${gone.length} media file${gone.length > 1 ? "s" : ""} could not be found on disk — those items will show as missing.`,
      );
    }
  });
}

/** The window layout in force: hand-set when manual mode is on, else the
 *  automatic plan. Everything that draws or counts windows goes through here
 *  so the timeline, the status and what is generated cannot disagree. */
export function windowLayout(s: Pick<DirectorState, "duration_sec" | "fps" | "timeline">) {
  const maxF = Math.max(1, Math.round(s.duration_sec * s.fps));
  const win = s.timeline.slidingWindowSize;
  const ovl = s.timeline.slidingWindowOverlap;
  const manual = !!s.timeline.manualWindows;
  const frames = manual && s.timeline.windowFrames && s.timeline.windowFrames.length
    ? s.timeline.windowFrames
    : null;
  if (frames) {
    return { maxF, win, ovl, manual: true, frames, spans: spansFromFrames(frames) };
  }
  const spans = realWindows(maxF, win, ovl);
  return {
    maxF, win, ovl, manual: false,
    frames: spans.map((w) => w.end - w.start),
    spans,
  };
}

/**
 * What each window's prompt ASKS for, in frames, or null where no prompt in
 * that window carries a [/duration=..s].
 *
 * A duration typed into a prompt is treated as intent, not instruction: it is
 * never sent to Wan2GP (the relay strips it), it only tells us the window the
 * writer had in mind. Where it disagrees with the window, we say so and offer
 * to resize -- the window is what actually governs.
 */
export function promptDurationFrames(
  s: Pick<DirectorState, "fps" | "timeline">,
  spans: { start: number; end: number }[],
): (number | null)[] {
  const fps = Math.max(1, s.fps || 24);
  const texts = s.timeline.segments
    .filter((x) => x.track === "video" && x.kind === "text" && (x.prompt || "").trim())
    .sort((a, b) => a.start - b.start);
  return spans.map((w) => {
    const inWin = texts.filter((t) => t.start >= w.start && t.start < w.end);
    for (const t of inWin) {
      const sec = readDurationSeconds(t.prompt || "");
      if (sec != null) return Math.round(sec * fps);
    }
    return null;
  });
}

export type PromptWindowMismatch = {
  window: number; promptFrames: number; windowFrames: number; text: string;
};

/** Windows whose prompt asks for a different length than the window has. */
export function usePromptWindowMismatches(): PromptWindowMismatch[] {
  return useDirector((s) => {
    const lay = windowLayout(s);
    const want = promptDurationFrames(s, lay.spans);
    const fps = Math.max(1, s.fps || 24);
    const out: PromptWindowMismatch[] = [];
    want.forEach((w, i) => {
      if (w == null) return;
      const have = lay.frames[i];
      if (Math.abs(w - have) <= 1) return;          // same to within a frame
      out.push({
        window: i + 1, promptFrames: w, windowFrames: have,
        text: `Window ${i + 1}: the prompt asks for ${(w / fps).toFixed(2)}s but the window is ${(have / fps).toFixed(2)}s.`,
      });
    });
    return out;
  });
}

export function useWindowStats() {
  return useDirector((s) => {
    const { maxF, win, ovl, manual, frames, spans } = windowLayout(s);
    const auto = planDurations(maxF, win, ovl);
    const windows = manual ? frames.length : auto.windows;
    const total = manual ? frames.reduce((a, b) => a + b, 0) : auto.total;
    const exact = total === maxF;
    const newFrames = win - ovl;
    const warning = windowSecondsWarning(win, ovl, s.fps);
    const minutes = estimateMinutes(windows, Number(s.advanced.steps) || 20);

    // Hand-set layouts are checked against the model's real limits; the
    // automatic one cannot break them by construction.
    const problems = manual ? validateWindowFrames(frames, maxF, ovl, s.fps) : [];

    let runtHint: string | null = null;
    if (!manual && total > maxF + 1) {
      runtHint = `Generates ${(total / s.fps).toFixed(2)}s to cover a ` +
        `${(maxF / s.fps).toFixed(2)}s timeline (the window grid cannot land exactly).`;
    }
    return {
      maxF, windows, newFrames, exact, warning, minutes, spans, total, runtHint,
      manual, frames, problems,
      floor: windowFloorFrames(),
      ceiling: windowCeilingFrames(ovl),
    };
  });
}

export function selectVideoSegs(s: DirectorState) {
  return s.timeline.segments.filter((x) => x.track === "video").sort((a, b) => a.start - b.start);
}
