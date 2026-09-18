import { useEffect } from "react";

/** A real confirm dialog. The click-twice pattern relied on reading a toast,
 *  and when the toast was unreadable it looked like the button did nothing. */
export function Confirm({
  open, title, body, confirmLabel = "Confirm", danger = true, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;
  return (
    <div className="modal" onClick={onCancel} role="presentation">
      <div className="sheet confirm" onClick={(e) => e.stopPropagation()} role="dialog">
        <h3>
          {title}
          <button type="button" className="x" title="Cancel (Esc)" onClick={onCancel}>x</button>
        </h3>
        <div className="body"><p>{body}</p></div>
        <div className="confirm-foot">
          <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
          <button type="button" className={`btn sm ${danger ? "warn" : "go"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
