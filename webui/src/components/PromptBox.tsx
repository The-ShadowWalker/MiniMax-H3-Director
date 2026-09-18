import { useEffect, useRef, useState } from "react";

/** A prompt field you can actually read.
 *
 *  The inline box stays compact, but the corner control pops it out to a large
 *  editor over the app so long shot descriptions can be worked on properly.
 *  It is also drag-resizable in place for smaller adjustments. */
export function PromptBox({
  value, onChange, placeholder, rows = 4, label = "Prompt",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  label?: string;
}) {
  const [big, setBig] = useState(false);
  const bigRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!big) return;
    bigRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(false);
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) setBig(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big]);

  const chars = value.length;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <>
      <div className="pbox">
        {/* The control lives ABOVE the field: inside it, it sat on the
            scrollbar and the native resize grip. */}
        <div className="pbox-head">
          <span className="pbox-lbl">{label}</span>
          <span className="pbox-count num">{chars ? `${words}w / ${chars}c` : ""}</span>
          <button
            type="button"
            className="pbox-x"
            title="Expand this prompt (Esc or Ctrl+Enter to come back)"
            onClick={() => setBig(true)}
          >
            ⤢ Expand
          </button>
        </div>
        <textarea
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>

      {big && (
        <div className="modal" onClick={() => setBig(false)} role="presentation">
          <div className="sheet pbig" onClick={(e) => e.stopPropagation()} role="dialog">
            <h3>
              {label}
              <button type="button" className="x" title="Close (Esc)" onClick={() => setBig(false)}>
                ×
              </button>
            </h3>
            <div className="body">
              <textarea
                ref={bigRef}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
              />
            </div>
            <div className="pbig-foot">
              <span className="num">{words} words · {chars} characters</span>
              <button type="button" className="btn sm go" onClick={() => setBig(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
