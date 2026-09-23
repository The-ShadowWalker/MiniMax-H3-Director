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
  // MiniMax documents 4-15 seconds per generation window. Wan2GP's own slider
  // goes to 481 frames (20.04s), so beyond 15s is out of spec but still runs.
  MAX_WINDOW_SEC: 15,
  OFFICIAL_MIN_SEC: 4,
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

/**
 * The nearest value on the model's own grid.
 *
 * The model can only generate window sizes on a `offset + step*k` grid, so a
 * typed number has to land on one. This used to floor, which is why typing
 * 240 (wanting 10s) dropped to 226 = 9.42s even though 243 = 10.13s was three
 * frames away: the box looked like it was refusing the number rather than
 * rounding it. Wan2GP's own normalize_output_frame_count rounds to nearest
 * too, so nearest is also the behaviour that matches the backend.
 */
export function snapGrid(v: number, offset: number, step: number, lo: number, hi?: number) {
  let n = Math.round(Number.isFinite(v) ? v : lo);
  if (hi != null) n = Math.min(hi, n);
  let s = Math.round((n - offset) / step) * step + offset;
  if (s < lo) s = lo;
  if (hi != null && s > hi) s -= step;
  return s;
}

/** The grid values either side of `v`, for telling someone what they can have. */
export function windowGridNeighbours(v: number): { below: number; above: number } {
  const { WINDOW_OFFSET: o, WINDOW_STEP: st, WINDOW_MIN: lo, WINDOW_MAX: hi } = H3;
  const clamp = (x: number) => Math.max(lo, Math.min(hi, x));
  const k = Math.floor((v - o) / st);
  return { below: clamp(k * st + o), above: clamp((k + 1) * st + o) };
}

/** Every window size the model actually offers, with its length in seconds. */
export function windowGridChoices(fps: number): { frames: number; sec: number }[] {
  const out: { frames: number; sec: number }[] = [];
  const f = Math.max(1, fps || 24);
  for (let v = H3.WINDOW_MIN; v <= H3.WINDOW_MAX; v += H3.WINDOW_STEP) {
    out.push({ frames: v, sec: v / f });
  }
  return out;
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

// ---------------------------------------------------------------------------
// manual windows: the user sets each window's length by hand
// ---------------------------------------------------------------------------
// WanGP's scheduler takes each window's /duration independently, so windows do
// not have to be equal. Two hard limits come from the model, not from us:
//   * a window cannot output fewer frames than the model's minimum; and
//   * a window's PASS is its output plus the overlap, which must stay inside
//     the model's largest window.

/** Fewest OUTPUT frames a single window can produce. */
export function windowFloorFrames(): number {
  return H3.FRAMES_MIN;
}

/**
 * The largest window still INSIDE MiniMax's documented 15 seconds.
 *
 * Not simply 15 x fps. The model only accepts frame counts on its own grid,
 * and near 15s that grid offers 345 (14.375s) or 362 (15.083s) -- there is no
 * exact 15s. 362 is what Wan2GP ships as the default window, so 362 IS the
 * fifteen-second window as far as this model is concerned.
 *
 * Comparing against a literal 360 made the DEFAULT layout flag itself: a plain
 * 60s timeline seeds to [362, 361, 361, 356] and the first three were reported
 * as out of spec the moment manual mode was switched on.
 */
export function windowSpecMaxFrames(fps: number): number {
  const f = Math.max(1, fps || 24);
  const want = H3.MAX_WINDOW_SEC * f;
  const step = H3.WINDOW_STEP;
  const offset = H3.WINDOW_OFFSET;
  const lower = Math.floor((want - offset) / step) * step + offset;
  const upper = lower + step;
  const nearest = want - lower <= upper - want ? lower : upper;
  // Never report the model's own default window as out of spec.
  return Math.max(nearest, H3.WINDOW_DEFAULT);
}

/** Most OUTPUT frames a single window can produce at this overlap. */
export function windowCeilingFrames(ovl: number): number {
  return Math.max(H3.FRAMES_MIN, H3.WINDOW_MAX - Math.max(0, Math.floor(ovl)));
}

/** Turn per-window lengths into timeline spans. */
export function spansFromFrames(frames: number[]): WindowSpan[] {
  const out: WindowSpan[] = [];
  let at = 0;
  frames.forEach((f, i) => {
    out.push({ i, start: at, end: at + Math.max(1, Math.round(f)) });
    at += Math.max(1, Math.round(f));
  });
  return out;
}

/** The seconds a [/duration=..s] in a prompt asks for, or null if there is none. */
export function readDurationSeconds(text: string): number | null {
  const m = /\[\s*\/\s*duration\s*=\s*([0-9]*\.?[0-9]+)\s*s\s*\]/i.exec(text || "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type WindowProblem = {
  window: number | null;
  text: string;
  kind: "total" | "floor" | "ceiling" | "spec";
  /** blocking problems make the generation wrong; advisory ones only risk quality. */
  blocking: boolean;
};

/**
 * Everything wrong with a hand-set window layout.
 *
 * Two different limits, and they are not the same thing:
 *
 *   BLOCKING  - the model cannot do it. Fewer frames than frames_minimum, or a
 *               pass (window + overlap) larger than the biggest window Wan2GP
 *               offers. These produce a wrong or failed generation.
 *   ADVISORY  - MiniMax documents 4-15 seconds per window. Past 15s still runs
 *               and Wan2GP's own slider allows it; quality is the risk, so it
 *               is said plainly and left to the user.
 *
 * Nothing here clamps anything. Window lengths are free to be wrong while a
 * layout is being arranged -- you often have to put one window out of range to
 * get the next one right. This just reports.
 */
export function validateWindowFrames(
  frames: number[],
  totalFrames: number,
  ovl: number,
  fps: number,
): WindowProblem[] {
  const problems: WindowProblem[] = [];
  const f = Math.max(1, fps || 24);
  const floor = windowFloorFrames();
  const ceil = windowCeilingFrames(ovl);
  const specMax = windowSpecMaxFrames(f);
  const sum = frames.reduce((a, b) => a + Math.max(0, Math.round(b)), 0);

  if (sum !== totalFrames) {
    const diff = sum - totalFrames;
    problems.push({
      window: null, kind: "total", blocking: true,
      text: diff > 0
        ? `The windows total ${(sum / f).toFixed(2)}s, ${(diff / f).toFixed(2)}s MORE than the ${(totalFrames / f).toFixed(2)}s timeline.`
        : `The windows total ${(sum / f).toFixed(2)}s, ${(-diff / f).toFixed(2)}s SHORT of the ${(totalFrames / f).toFixed(2)}s timeline.`,
    });
  }
  frames.forEach((raw, i) => {
    const n = Math.round(raw);
    // The LAST window of a multi-window layout is allowed to be short. That is
    // how WanGP's own plan ends -- the pass is padded up to the model's minimum
    // and the extra frames are trimmed off the output -- so flagging it here
    // would paint the automatic layout red for doing the normal thing. A lone
    // window below the minimum has nothing to trim from and is still an error.
    const tail = i === frames.length - 1 && frames.length > 1;
    if (n < floor && tail) {
      /* fine: WanGP pads this pass and trims the result */
    } else if (n < floor) {
      problems.push({
        window: i + 1, kind: "floor", blocking: true,
        text: `Window ${i + 1} is ${(n / f).toFixed(2)}s. The model cannot generate less than ${(floor / f).toFixed(2)}s (${floor} frames).`,
      });
    } else if (n > ceil) {
      problems.push({
        window: i + 1, kind: "ceiling", blocking: true,
        text: `Window ${i + 1} is ${(n / f).toFixed(2)}s. With overlap ${ovl} that needs a ${n + ovl}-frame pass, past the ${H3.WINDOW_MAX}-frame maximum — ${(ceil / f).toFixed(2)}s is the most a window can be.`,
      });
    } else if (n > specMax) {
      problems.push({
        window: i + 1, kind: "spec", blocking: false,
        text: `Window ${i + 1} is ${(n / f).toFixed(2)}s. MiniMax documents ${H3.OFFICIAL_MIN_SEC}-${H3.MAX_WINDOW_SEC}s per window — it will still generate, but quality past ${H3.MAX_WINDOW_SEC}s is not something the model promises.`,
      });
    }
  });
  return problems;
}

/** The limits, in words, for a warning that has to explain itself. */
export function windowLimitsText(ovl: number, fps: number): string {
  const f = Math.max(1, fps || 24);
  return `Each window must be ${(windowFloorFrames() / f).toFixed(2)}s to ` +
    `${(windowCeilingFrames(ovl) / f).toFixed(2)}s at overlap ${ovl}, and MiniMax ` +
    `documents ${H3.OFFICIAL_MIN_SEC}-${H3.MAX_WINDOW_SEC}s per window ` +
    `(${(windowSpecMaxFrames(f) / f).toFixed(2)}s on this model's frame grid). ` +
    `The lengths must also add up to the timeline.`;
}

/**
 * The layout manual mode starts from.
 *
 * FIRST CHOICE: exactly the boundaries automatic mode is already drawing. If
 * all you did was tick the box, nothing on screen should move -- the bands
 * used to shift by a few frames because automatic draws the scheduler's
 * snapped OUTPUT lengths while manual seeded an even division.
 *
 * FALLBACK: an even division, used when the automatic layout cannot be edited
 * as-is -- on a short timeline it ends in a runt (a 16s timeline draws as
 * [362, 22], and 22 frames is far below what the model can generate). Taking
 * that as a starting point would show red the instant manual mode was opened.
 */
export function seedWindowFrames(totalFrames: number, win: number, ovl: number): number[] {
  const total = Math.max(1, Math.round(totalFrames));

  const drawn = realWindows(total, win, ovl)
    .map((w) => Math.max(0, w.end - w.start))
    .filter((n) => n > 0);
  // Whatever automatic mode has drawn is exactly what WanGP's own scheduler
  // does, so it is always a layout the model can run -- hand it straight over
  // and the borders do not move by so much as a frame. It is deliberately NOT
  // validated first: a layout that ends in a short tail window is what the
  // automatic plan produces anyway, and rejecting it here was the only reason
  // the bands ever jumped.
  const drawnSum = drawn.reduce((a, b) => a + b, 0);
  if (drawn.length && drawnSum === total) return drawn;

  // --- even division ---
  const specMax = windowSpecMaxFrames(H3.FPS);
  const hardMax = windowCeilingFrames(ovl);
  const floor = windowFloorFrames();
  const per = Math.max(1, Math.min(win || specMax, specMax, hardMax));
  let n = Math.max(1, Math.ceil(total / per));
  const most = Math.max(1, Math.floor(total / floor));
  if (n > most) n = most;

  const each = Math.floor(total / n);
  const frames = Array.from({ length: n }, () => each);
  let left = total - each * n;
  for (let i = 0; i < n && left > 0; i++, left--) frames[i] += 1;
  return frames;
}

/** Would switching to manual keep the boundaries exactly where they are? */
export function seedMatchesAuto(totalFrames: number, win: number, ovl: number): boolean {
  const total = Math.max(1, Math.round(totalFrames));
  const drawn = realWindows(total, win, ovl).map((w) => w.end - w.start).filter((n) => n > 0);
  const seed = seedWindowFrames(total, win, ovl);
  return drawn.length === seed.length && drawn.every((n, i) => n === seed[i]);
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

// ---------------------------------------------------------------------------
// Audio source
// ---------------------------------------------------------------------------

/** The stored value meaning "explicitly no audio input", since "" is Auto. */
export const AUDIO_MODE_NONE = "none";

/** The mode to send, or null when Auto should decide. */
export function chosenAudioMode(stored: string): string | null {
  if (!stored) return null;                       // Auto
  return stored === AUDIO_MODE_NONE ? "" : stored;
}

/** What the relay will send as `audio_prompt_type`, given what is attached.
 *
 *  Mirrors plugin.py's own derivation: a soundtrack (or clip audio) on the
 *  timeline gives "A", a voice reference gives "B", both give "AB", nothing
 *  gives "" and the model generates the audio from the prompt. The rail icon
 *  and the Audio-source picker both read this, so they cannot disagree.
 */
export function deriveAudioMode(hasTrack: boolean, hasVoiceRef: boolean): string {
  return (hasTrack ? "A" : "") + (hasVoiceRef ? "B" : "");
}

/** Is `mode` satisfied by what is attached? "" needs nothing at all. */
export function audioModeReady(mode: string, hasTrack: boolean, hasVoiceRef: boolean): boolean {
  if (!mode) return true;
  if (mode.includes("A") && !hasTrack) return false;
  if (mode.includes("B") && !hasVoiceRef) return false;
  return true;
}

/** What is missing for `mode`, in words, or "" when it is ready. */
export function audioModeGap(mode: string, hasTrack: boolean, hasVoiceRef: boolean): string {
  if (mode.includes("A") && !hasTrack) return "needs an audio track";
  if (mode.includes("B") && !hasVoiceRef) return "needs a voice reference";
  return "";
}

// ---------------------------------------------------------------------------
// Render groups
// ---------------------------------------------------------------------------
// A long timeline rendered as ONE Wan2GP job keeps every finished window in
// memory and never lets the VRAM baseline reset, which is what makes a twenty
// clip piece die partway through. Rendered in groups, each group is its own
// job: Wan2GP's accumulator and its VRAM baseline both start clean each time.

/** Which windows fall in which group. */
export type WindowGroup = { index: number; first: number; last: number; frames: number };

export function planGroups(windowFrames: number[], perGroup: number): WindowGroup[] {
  const per = Math.max(1, Math.round(perGroup || 1));
  const out: WindowGroup[] = [];
  for (let i = 0; i < windowFrames.length; i += per) {
    const slice = windowFrames.slice(i, i + per);
    out.push({
      index: out.length,
      first: i,
      last: i + slice.length - 1,
      frames: slice.reduce((a, b) => a + b, 0),
    });
  }
  return out;
}

/** Roughly how much system RAM one group's finished frames occupy.
 *
 *  Wan2GP converts each finished window to uint8 before adding it to the list
 *  it stitches from, so it is one byte per channel: frames x w x h x 3. That
 *  list is what grows through a render, and it is the reason a long job gets
 *  heavier as it goes.
 */
export function groupRamGiB(frames: number, width: number, height: number): number {
  return (frames * width * height * 3) / 1024 ** 3;
}

/** A sensible group size for a given memory budget.
 *
 *  Picks the most windows whose finished frames stay under `budgetGiB`, so the
 *  default follows the resolution rather than being a number someone guessed.
 *  Always at least one window, and never more windows than exist.
 */
export function defaultGroupWindows(
  windowFrames: number[], width: number, height: number, budgetGiB = 3,
): number {
  if (!windowFrames.length) return 1;
  const avg = windowFrames.reduce((a, b) => a + b, 0) / windowFrames.length;
  const perWindow = groupRamGiB(avg, width, height);
  if (!(perWindow > 0)) return Math.min(4, windowFrames.length);
  const fits = Math.floor(budgetGiB / perWindow);
  return Math.max(1, Math.min(windowFrames.length, fits || 1));
}
