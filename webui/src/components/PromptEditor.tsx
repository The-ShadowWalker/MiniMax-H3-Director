import { useEffect, useRef } from "react";
import { useDirector } from "../lib/store";

/**
 * The big prompt editor, opened by double-clicking a prompt on the timeline.
 *
 * Two kinds of prompt land here and they are not the same thing, so the editor
 * says which one you are in:
 *   - a TEXT prompt on the Injected Frames and Text Prompts track, which
 *     describes what happens at that point in the video; and
 *   - a BRIDGE prompt on the control track, which marks a gap to generate
 *     between (or after, or before) the clips around it.
 */
export function PromptEditor() {
  const s = useDirector();
  const id = s.promptEdit;
  const seg = id ? s.timeline.segments.find((x) => x.id === id) : null;
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!seg) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") s.setPromptEdit(null);
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) s.setPromptEdit(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seg, s]);

  if (!seg) return null;

  const isBridge = seg.track === "control" && !seg.mediaId;
  const value = seg.prompt || "";
  const secs = (seg.length / Math.max(1, s.fps)).toFixed(2);
  const at = (seg.start / Math.max(1, s.fps)).toFixed(2);

  return (
    <div className="pe-back" onMouseDown={() => s.setPromptEdit(null)}>
      <div className="pe-win" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pe-head">
          <span className="pe-title">
            {isBridge ? "Bridge prompt" : "Text prompt"}
          </span>
          <span className="pe-meta">
            {at}s &middot; {secs}s long
          </span>
          <button
            className="btn sm"
            type="button"
            title="Close (Esc, or Ctrl+Enter)"
            onClick={() => s.setPromptEdit(null)}
          >
            Done
          </button>
        </div>
        <textarea
          ref={ref}
          value={value}
          spellCheck={false}
          placeholder={
            isBridge
              ? "Describe what happens across this gap. The clips on either side decide whether it bridges between them, extends the one before, or leads into the one after."
              : "Describe what happens at this point in the video."
          }
          onChange={(e) => s.updateSeg(seg.id, { prompt: e.target.value })}
        />
        <div className="pe-foot">
          <span>
            {value.length} characters &middot;{" "}
            {value.trim() ? value.trim().split(/\s+/).length : 0} words
          </span>
          <span className="hint">
            {isBridge
              ? "The length of this segment is the length that gets generated."
              : "Reference images keep the numbers you type here; what Wan2GP receives is adjusted for you."}
          </span>
        </div>
      </div>
    </div>
  );
}
