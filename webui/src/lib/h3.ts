/** MiniMax H3 sliding-window grid — matches Wan2GP handler + original plugin. */

export const H3 = {
  WINDOW_OFFSET: 5,
  WINDOW_STEP: 17,
  OVERLAP_OFFSET: 1,
  OVERLAP_STEP: 17,
  WINDOW_MIN: 124,
  WINDOW_MAX: 481,
  // Smallest legal GENERATED frame count (model_def.frames_minimum). Not the
  // same as WINDOW_MIN, which is the smallest sliding-window SIZE the slider
  // offers. The scheduler snaps against this one.
  FRAMES_MIN: 107,
  WINDOW_DEFAULT: 362,
  OVERLAP_MIN: 1,
  OVERLAP_MAX: 120,
  OVERLAP_DEFAULT: 18,
  FPS: 24,
  MAX_WINDOW_SEC: 15,
  STEPS_DEFAULT: 20,
  FLOW_SHIFT: 12,
  GUIDANCE: 1,
  MAX_REF_IMAGES: 9,
  MAX_REF_VIDEOS: 3,
  MAX_REF_AUDIO: 3,
  MAX_TOTAL_REFS: 12,
};

/** Overwrite grid constants with values DERIVED from Wan2GP's model_def.
 *  Python is the source of truth; these literals are only a cold-start fallback. */
export const LIMITS = { videos: 2, audio: 2, images: 9, source: "fallback" as string };

/** Set from Wan2GP's own model_def. If a three-video mode ever appears
 *  upstream, the third slot enables itself with no code change. */
export function applyRefLimits(l: Partial<typeof LIMITS>) {
  if (typeof l.videos === "number") LIMITS.videos = l.videos;
  if (typeof l.audio === "number") LIMITS.audio = l.audio;
  if (typeof l.images === "number") LIMITS.images = l.images;
  if (l.source) LIMITS.source = l.source;
}

export function applyH3Grid(g: Partial<Record<keyof typeof H3, number>>) {
  for (const k of Object.keys(g) as (keyof typeof H3)[]) {
    const v = g[k];
    if (typeof v === "number" && Number.isFinite(v)) (H3 as Record<string, number>)[k] = v;
  }
}

export function snapGrid(v: number, offset: number, step: number, lo: number, hi?: number) {
  let n = Math.floor(Number.isFinite(v) ? v : lo);
  if (hi != null) n = Math.min(hi, n);
  let s = Math.floor((n - offset) / step) * step + offset;
  if (s < lo) s = lo;
  if (hi != null && s > hi) s -= step;
  return s;
}

export function snapH3Window(v: number) {
  return snapGrid(v, H3.WINDOW_OFFSET, H3.WINDOW_STEP, H3.WINDOW_MIN, H3.WINDOW_MAX * 4);
}

export function snapH3Overlap(v: number) {
  return snapGrid(v, H3.OVERLAP_OFFSET, H3.OVERLAP_STEP, H3.OVERLAP_MIN, H3.OVERLAP_MAX);
}

export function snapWindowPair(winSize: number, winOverlap: number): [number, number] {
  let ws = snapH3Window(winSize);
  let ov = snapH3Overlap(winOverlap);
  while (ov >= ws && ov > H3.OVERLAP_MIN) ov -= H3.OVERLAP_STEP;
  return [ws, Math.max(H3.OVERLAP_MIN, ov)];
}

export function stepGrid(v: number, dir: 1 | -1, offset: number, step: number, lo: number, hi: number) {
  const k = Math.floor((v - offset) / step);
  const on = (v - offset) % step === 0;
  let s = (on ? k + dir : dir > 0 ? k + 1 : k) * step + offset;
  return Math.max(lo, Math.min(hi, s));
}

export function assembledLength(requestFrames: number, win: number, ovl: number): [number, number] {
  const req = Math.max(1, Math.floor(requestFrames));
  if (req <= win) return [req, 1];
  const n = 1 + Math.ceil((req - win) / Math.max(1, win - ovl));
  return [req + (n - 1) * ovl, n];
}

export function compensateRequest(
  targetFrames: number,
  win: number,
  ovl: number,
): { request: number; windows: number; assembled: number; exact: boolean } {
  const target = Math.max(1, Math.floor(targetFrames));
  const w = Math.max(2, Math.floor(win));
  const o = Math.max(0, Math.min(Math.floor(ovl), w - 1));
  let fallback: ReturnType<typeof compensateRequest> | null = null;
  for (let req = target; req > Math.max(0, target - 6000); req--) {
    const [out, n] = assembledLength(req, w, o);
    if (out === target) return { request: req, windows: n, assembled: out, exact: true };
    if (out < target && !fallback) {
      fallback = { request: req, windows: n, assembled: out, exact: false };
    }
  }
  if (fallback) return fallback;
  const [out, n] = assembledLength(target, w, o);
  return { request: target, windows: n, assembled: out, exact: out === target };
}

// ---------------------------------------------------------------------------
// WanGP's real window plan, ported from shared/utils/frame_scheduler.py
// ---------------------------------------------------------------------------
// This mirrors build_default_window_plan(). video_length is the FINAL OUTPUT
// length: window 1 outputs `window_size`, later windows output
// `window_size - overlap`, and the tail takes whatever is left, snapped to the
// nearest legal frame count. The overlap is NOT added back at each join --
// assembledLength()/compensateRequest() above assume it is, which is why a
// timeline used to come out short and a song ran off the end of the picture.
//
// Keep this in step with plugin.py's _mirror_window_plan; regression_output_
// length.py checks the Python side against the real WanGP module.

function normUp(n: number, minimum: number, step: number, offset: number) {
  n = Math.max(minimum, n);
  step = Math.max(1, step);
  offset = Math.max(0, offset);
  return step > 1 ? Math.ceil(Math.max(0, n - offset) / step) * step + offset : n;
}

function normNearest(n: number, minimum: number, step: number, offset: number) {
  n = Math.max(minimum, n);
  step = Math.max(1, step);
  if (step <= 1) return n;
  offset = Math.max(0, offset);
  let lower = Math.floor((n - offset) / step) * step + offset;
  if (lower < minimum) lower = normUp(minimum, minimum, step, offset);
  const upper = normUp(n, minimum, step, offset);
  return n - lower <= upper - n ? lower : upper;
}

function floorOverlap(n: number, step: number, offset: number) {
  n = Math.max(0, Math.floor(n));
  if (n === 0) return 0;
  step = Math.max(1, Math.floor(step));
  offset = Math.max(0, Math.floor(offset));
  if (offset === 0) return Math.floor(n / step) * step;
  return n < offset ? 0 : Math.floor((n - offset) / step) * step + offset;
}

/** One window as WanGP will run it. */
export type PlannedWindow = { outputFrames: number; overlapFrames: number; frameNum: number };

/** The windows WanGP will ACTUALLY run for this video_length. */
export function realWindowPlan(videoLength: number, win: number, ovl: number): PlannedWindow[] {
  const minimum = H3.FRAMES_MIN;
  const step = H3.WINDOW_STEP;
  const frameOffset = H3.WINDOW_OFFSET;
  const overlapOffset = H3.OVERLAP_OFFSET;
  const maxOverlap = H3.OVERLAP_MAX;

  const geometry = (outputFrames: number, overlapFrames: number): PlannedWindow => {
    outputFrames = Math.max(1, Math.floor(outputFrames));
    overlapFrames = Math.max(0, Math.floor(overlapFrames));
    let overlaps: number[];
    if (overlapFrames === 0) {
      overlaps = [0];
    } else {
      let limit = Math.max(overlapFrames, maxOverlap);
      limit = floorOverlap(limit, step, overlapOffset);
      const preferred = floorOverlap(Math.min(overlapFrames, limit), step, overlapOffset);
      overlaps = [];
      if (preferred > 0) for (let o = preferred; o <= limit; o += Math.max(1, step)) overlaps.push(o);
      else overlaps = [0];
    }
    let best: PlannedWindow | null = null;
    let bestScore: [number, number, number] | null = null;
    for (const o of overlaps) {
      let frameNum = normNearest(outputFrames + o, minimum, step, frameOffset);
      if (frameNum <= o) frameNum = normUp(o + 1, minimum, step, frameOffset);
      const adjusted = frameNum - o;
      const score: [number, number, number] = [
        Math.abs(adjusted - outputFrames), Math.abs(o - overlapFrames), frameNum,
      ];
      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
      ) {
        bestScore = score;
        best = { outputFrames: adjusted, overlapFrames: o, frameNum };
      }
    }
    return best as PlannedWindow;
  };

  let total = Math.max(1, Math.floor(videoLength));
  const windowSize = normUp(Math.max(2, Math.floor(win)), minimum, step, frameOffset);
  const defaultOverlap = Math.max(0, Math.min(Math.floor(ovl), windowSize - 1));
  const capacity = Math.max(1, windowSize);
  const out: PlannedWindow[] = [geometry(Math.min(total, capacity), 0)];
  let requested = Math.min(total, capacity);
  let guard = 0;
  while (requested < total && guard++ < 512) {
    const chunk = Math.min(total - requested, Math.max(1, windowSize - defaultOverlap));
    out.push(geometry(chunk, defaultOverlap));
    requested += chunk;
  }
  return out;
}

/** How many frames WanGP will really produce for this video_length. */
export function realOutputFrames(videoLength: number, win: number, ovl: number): number {
  return realWindowPlan(videoLength, win, ovl).reduce((s, w) => s + w.outputFrames, 0);
}

/**
 * Smallest video_length whose REAL output covers `target` frames, plus what
 * that plan actually looks like. Covering rather than landing exactly matters:
 * undershooting cuts the end off a soundtrack.
 */
export function solveVideoLength(
  targetFrames: number,
  win: number,
  ovl: number,
): { request: number; windows: number; assembled: number; exact: boolean; runt: boolean } {
  const target = Math.max(1, Math.floor(targetFrames));
  const step = Math.max(1, H3.WINDOW_STEP);
  let best: { request: number; out: number; plan: PlannedWindow[] } | null = null;
  for (let vl = Math.max(1, target - 3 * step); vl <= target + 3 * step; vl++) {
    const plan = realWindowPlan(vl, win, ovl);
    const out = plan.reduce((s, w) => s + w.outputFrames, 0);
    if (out >= target && (best === null || out < best.out)) {
      best = { request: vl, out, plan };
      if (out === target) break;
    }
  }
  if (best === null) {
    const plan = realWindowPlan(target, win, ovl);
    const out = plan.reduce((s, w) => s + w.outputFrames, 0);
    best = { request: target, out, plan };
  }
  // A "runt" tail is a final window that contributes far less than it costs:
  // it still runs a full pass, mostly re-generating the overlap.
  const last = best.plan[best.plan.length - 1];
  const runt = best.plan.length > 1 && last.outputFrames * 3 < best.plan[0].outputFrames;
  return {
    request: best.request,
    windows: best.plan.length,
    assembled: best.out,
    exact: best.out === target,
    runt,
  };
}

// ---------------------------------------------------------------------------
// the SCHEDULER path: per-window [/duration=] tags
// ---------------------------------------------------------------------------
// Every prompt block here carries a /duration tag, which puts WanGP on its
// scheduler: each window OUTPUTS exactly what it declares and the overlap is
// generated on top, so three 15s windows really are 45s of video. The default
// plan above behaves differently (windows 2+ output window - overlap), and
// mixing the two is what made a genuine 3-window job report 4.
// Mirrors plugin.py's _scheduler_outputs / plan_duration_frames.

/** Output frames per window when each window declares its own duration. */
export function schedulerOutputs(durations: number[], win: number, ovl: number): number[] {
  const minimum = H3.FRAMES_MIN;
  const step = H3.WINDOW_STEP;
  const offset = H3.WINDOW_OFFSET;
  const overlapOffset = H3.OVERLAP_OFFSET;
  const maxOverlap = H3.OVERLAP_MAX;

  const geometry = (outputFrames: number, overlapFrames: number): number => {
    outputFrames = Math.max(1, Math.floor(outputFrames));
    overlapFrames = Math.max(0, Math.floor(overlapFrames));
    let overlaps: number[];
    if (overlapFrames === 0) {
      overlaps = [0];
    } else {
      let limit = floorOverlap(Math.max(overlapFrames, maxOverlap), step, overlapOffset);
      const preferred = floorOverlap(Math.min(overlapFrames, limit), step, overlapOffset);
      overlaps = [];
      if (preferred > 0) for (let o = preferred; o <= limit; o += Math.max(1, step)) overlaps.push(o);
      else overlaps = [0];
    }
    let bestAdj = 0;
    let bestScore: [number, number, number] | null = null;
    for (const o of overlaps) {
      let frameNum = normNearest(outputFrames + o, minimum, step, offset);
      if (frameNum <= o) frameNum = normUp(o + 1, minimum, step, offset);
      const adjusted = frameNum - o;
      const score: [number, number, number] = [
        Math.abs(adjusted - outputFrames), Math.abs(o - overlapFrames), frameNum,
      ];
      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
      ) {
        bestScore = score;
        bestAdj = adjusted;
      }
    }
    return bestAdj;
  };

  return durations.map((d, i) => geometry(d, i === 0 ? 0 : ovl));
}

/**
 * Per-window durations whose REAL outputs cover `target`, in the fewest
 * windows. Every window but the last declares a full `win`; the last declares
 * only what is still needed, so there is no runt tail.
 */
export function planDurations(
  targetFrames: number,
  win: number,
  ovl: number,
): { durations: number[]; outputs: number[]; windows: number; total: number } {
  const target = Math.max(1, Math.floor(targetFrames));
  const w = Math.max(2, Math.floor(win));
  for (let n = 1; n <= 128; n++) {
    const base: number[] = [];
    for (let i = 0; i < n - 1; i++) base.push(w);
    for (let d = 1; d <= w; d++) {
      const durations = base.concat([d]);
      const outputs = schedulerOutputs(durations, w, ovl);
      const total = outputs.reduce((s, x) => s + x, 0);
      if (total >= target) return { durations, outputs, windows: n, total };
    }
  }
  const durations = [w];
  const outputs = schedulerOutputs(durations, w, ovl);
  return { durations, outputs, windows: 1, total: outputs[0] };
}

/** Largest output reachable in `n` windows -- what a timeline can hold. */
export function capacityForWindows(n: number, win: number, ovl: number): number {
  const windowSize = Math.max(2, Math.floor(win));
  const overlap = Math.max(0, Math.min(Math.floor(ovl), windowSize - 1));
  return windowSize + Math.max(0, n - 1) * Math.max(1, windowSize - overlap);
}

export type WindowSpan = { i: number; start: number; end: number };

/**
 * The windows that will actually be generated, as timeline spans.
 *
 * One span per prompt block, sized by what that window really outputs -- so
 * the bands on the timeline, the /duration tag written into each block and the
 * window count in the status all come from the same plan. This drives the
 * BLOCK COUNT, so it must agree with plugin.py's scheduler_window_count();
 * regression_ui_python_agree.py checks that.
 */
export function realWindows(totalFrames: number, win: number, ovl: number): WindowSpan[] {
  const total = Math.max(1, Math.floor(totalFrames));
  const { outputs } = planDurations(total, win, ovl);
  const spans: WindowSpan[] = [];
  let start = 0;
  for (let i = 0; i < outputs.length; i++) {
    const end = i === outputs.length - 1 ? total : Math.min(total, start + outputs[i]);
    spans.push({ i, start: Math.min(start, total), end: Math.max(Math.min(start, total), end) });
    start += outputs[i];
    if (start >= total && i < outputs.length - 1) {
      // Remaining windows would be empty: keep one span per window anyway so
      // the block count still matches, pinned at the end of the timeline.
      for (let j = i + 1; j < outputs.length; j++) spans.push({ i: j, start: total, end: total });
      break;
    }
  }
  return spans;
}

/** Stride windows matching the timeline canvas (size − overlap). */
export function strideWindows(totalFrames: number, win: number, ovl: number, max = 500): WindowSpan[] {
  if (totalFrames <= 0 || win <= 0) return [{ i: 0, start: 0, end: Math.max(1, totalFrames) }];
  const ws = Math.max(1, win);
  const ov = Math.max(0, Math.min(ovl, ws - 1));
  const stride = Math.max(1, ws - ov);
  const out: WindowSpan[] = [];
  let s = 0;
  let i = 0;
  while (s < totalFrames && i < max) {
    out.push({ i, start: s, end: Math.min(s + ws, totalFrames) });
    if (s + ws >= totalFrames) break;
    s += stride;
    i++;
  }
  return out;
}

export function windowSecondsWarning(winSize: number, winOverlap: number, fps: number): string | null {
  const secs = Math.max(1, winSize - winOverlap) / Math.max(1, fps);
  if (secs > H3.MAX_WINDOW_SEC + 0.001) {
    return `Window is ${secs.toFixed(1)}s of new content per pass — MiniMax H3 documents 4–15s per generation window. It will still generate, but a smaller window or larger overlap holds identity better.`;
  }
  return null;
}

export function formatTimecode(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const tenth = Math.floor((r - whole) * 10);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenth}`;
}

export function estimateMinutes(windows: number, steps: number): number {
  // Empirical-ish: ~1.2 min per window-step-unit at 20 steps / Hybrid 33B.
  return Math.max(1, Math.round(windows * (steps / 20) * 24));
}
