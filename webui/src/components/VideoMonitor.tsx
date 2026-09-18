import { useEffect, useRef } from "react";
import { useDirector } from "../lib/store";
import { getMedia, servedUrl, ensureBytes } from "../lib/media";

/** A floating monitor that follows the playhead.
 *
 *  Opened by double-clicking a video segment. It scrubs with the timeline and
 *  plays and pauses with the transport, so the guide clip can be watched
 *  against the shots laid over it. */
export function VideoMonitor() {
  const s = useDirector();
  const ref = useRef<HTMLVideoElement | null>(null);
  const mon = s.monitor;

  useEffect(() => {
    if (!mon?.mediaId) return;
    const v = ref.current;
    if (!v) return;
    const m = getMedia(mon.mediaId);
    const direct = m?.url || servedUrl(m);
    if (direct) { v.src = direct; return; }
    void ensureBytes(mon.mediaId).then((u) => { if (u && ref.current) ref.current.src = u; });
  }, [mon?.mediaId]);

  // Follow the playhead, and only re-seek on real drift so scrubbing stays smooth.
  useEffect(() => {
    const v = ref.current;
    if (!v || !mon) return;
    const want = Math.max(0, (s.timeline.playhead - (mon.start || 0)) / s.fps);
    if (Number.isFinite(want) && Math.abs(v.currentTime - want) > 0.2) {
      try { v.currentTime = want; } catch { /* not seekable yet */ }
    }
  }, [s.timeline.playhead, s.fps, mon]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (s.playing) v.play().catch(() => undefined);
    else v.pause();
  }, [s.playing]);

  if (!mon) return null;
  return (
    <div className="monitor" style={{ left: mon.x ?? 24, top: mon.y ?? 80 }}>
      <div
        className="monitor-h"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;   // close button
          const el = e.currentTarget.parentElement as HTMLElement;
          e.preventDefault();
          try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
          const sx = e.clientX, sy = e.clientY;
          const ox = el.offsetLeft, oy = el.offsetTop;
          const move = (ev: PointerEvent) => {
            // Keep it on screen: a window dragged past the edge is as good as gone.
            const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + ev.clientX - sx));
            const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy));
            s.setMonitor({ ...mon, x: nx, y: ny });
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <span className="monitor-n">{mon.name || "Monitor"}</span>
        <button type="button" className="x" title="Close" onClick={() => s.setMonitor(null)}>x</button>
      </div>
      <video ref={ref} muted playsInline />
      <div className="monitor-f num">
        follows the playhead - press Play on the timeline
      </div>
    </div>
  );
}
