import type { SessionPayload, Segment } from "./types";
import type { WindowSpan } from "./h3";
import { formatTimecode } from "./h3";

function clean(text: string) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function segsForWindow(segs: Segment[], w: WindowSpan): Segment[] {
  return segs
    .filter((s) => s.track === "video" && s.start < w.end && s.start + s.length > w.start)
    .sort((a, b) => a.start - b.start);
}

export function buildPromptRelay(session: SessionPayload, wins: WindowSpan[]) {
  const fps = session.fps || 24;
  const hard = new Set(
    (session.hardcuts || "")
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter((t) => /^\d+$/.test(t))
      .map((t) => parseInt(t, 10)),
  );
  const windows = wins.map((w) => {
    const covering = segsForWindow(session.timeline.segments, w);
    const bits: string[] = [];
    if (hard.has(w.i + 1)) bits.push("[/new_shot]");
    const dur = (w.end - w.start) / fps;
    bits.push(`[/duration=${dur.toFixed(2)}s]`);
    // The global prompt goes in ONCE per window, ahead of the shots. It used
    // to be substituted for every empty segment, so a 15s single window came
    // out repeating it once per gap.
    const global = clean(session.global_prompt || "");
    if (global) bits.push(global);
    const written = covering.filter((seg) => clean(seg.prompt).length > 0);
    if (written.length === 0) {
      // nothing further: the global prompt above is the whole instruction
    } else {
      let last = "";
      for (const seg of written) {
        const body = clean(seg.prompt);
        if (body === last) continue;          // never repeat the same line twice
        last = body;
        const t0 = formatTimecode(seg.start / fps);
        const t1 = formatTimecode((seg.start + seg.length) / fps);
        bits.push(`[${t0}:${t1}] ${body}`);
      }
    }
    const prompt = bits.filter(Boolean).join("\n");
    return { i: w.i, start: w.start, end: w.end, prompt };
  });
  const combined = windows.map((w) => w.prompt).join("\n\n");
  return { windows, combined };
}

export function applyPrompt(session: SessionPayload, wins: WindowSpan[]) {
  const { windows, combined } = buildPromptRelay(session, wins);
  return {
    prompt: combined,
    multi_prompts_gen_type: "PW",
    video_length: Math.round(session.duration_sec * session.fps),
    sliding_window_size: session.timeline.slidingWindowSize,
    sliding_window_overlap: session.timeline.slidingWindowOverlap,
    windows,
  };
}
