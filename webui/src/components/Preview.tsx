import { useEffect, useState } from "react";
import { useDirector } from "../lib/store";
import { ensureBytes } from "../lib/media";

/** Full-size viewer for any timeline or reference item. Opened by double-click
 *  on a segment, or the zoom button on a reference tile. */
export function Preview() {
  const s = useDirector();
  const p = s.preview;
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") s.setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, s]);
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    setSrc(""); setErr("");
    if (!p) return;
    if (p.url && !p.url.startsWith("need:")) { setSrc(p.url); return; }
    const id = p.url.slice(5);
    void ensureBytes(id).then((u) => {
      if (u) setSrc(u);
      else setErr("This file is no longer on disk. Open the project zip to restore it.");
    });
  }, [p]);
  if (!p) return null;
  return (
    <div className="pv-back" onClick={() => s.setPreview(null)}>
      <div className="pv" onClick={(e) => e.stopPropagation()}>
        <div className="pv-h">
          <span className="pv-n">{p.name}</span>
          <button type="button" className="btn sm" onClick={() => s.setPreview(null)}>Close (Esc)</button>
        </div>
        <div className="pv-b">
          {err && <div className="logline err" style={{ padding: 20 }}>{err}</div>}
          {!err && !src && <div className="logline" style={{ padding: 20 }}>Loading…</div>}
          {!err && src && p.kind === "image" && <img src={src} alt={p.name} />}
          {!err && src && p.kind === "video" && <video src={src} controls autoPlay loop />}
          {!err && src && p.kind === "audio" && <audio src={src} controls autoPlay />}
        </div>
      </div>
    </div>
  );
}
