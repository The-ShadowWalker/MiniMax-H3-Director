import type { SessionPayload } from "./types";
import { defaultGroupWindows, realWindows, spansFromFrames } from "./h3";

/** The windows this timeline will run, hand-set or planned. */
export function windowFramesFor(p: SessionPayload): number[] {
  const total = Math.max(1, Math.round(p.duration_sec * (p.fps || 24)));
  const manual = !!p.timeline.manualWindows && !!(p.timeline.windowFrames || []).length;
  const spans = manual
    ? spansFromFrames(p.timeline.windowFrames as number[])
    : realWindows(total, p.timeline.slidingWindowSize, p.timeline.slidingWindowOverlap);
  return spans.map((w) => w.end - w.start);
}

/** Output width and height, from the chosen resolution ("1280x720"). */
export function outputSize(p: SessionPayload): { w: number; h: number } {
  const m = String(p.advanced.resolution ?? "").replace("×", "x").match(/(\d+)\s*x\s*(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 720 };
}

/**
 * How many windows go in one render group.
 *
 * Zero means the timeline is short enough to render in one job, which is what
 * it has always done. Otherwise it is the hand-set number, or one worked out
 * from the resolution: the finished frames of a group sit in system RAM until
 * the job ends, so a bigger frame means fewer windows before that becomes a
 * problem.
 */
export function groupWindowsFor(p: SessionPayload): number {
  if (!p.timeline.groupsOn) return 0;          // off = one job, as before
  const wf = windowFramesFor(p);
  const set = Number(p.timeline.groupWindows || 0);
  if (set > 0) return Math.min(set, wf.length);
  const { w, h } = outputSize(p);
  const auto = defaultGroupWindows(wf, w, h);
  return auto >= wf.length ? 0 : auto;   // 0 = one job, as before
}
