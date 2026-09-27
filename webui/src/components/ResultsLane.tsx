import { useEffect, useRef, useState } from "react";
import { useDirector, type RenderClip } from "../lib/store";
import { request, hasParent } from "../lib/bridge";

/** Poster strips by clip file and size: a re-rendered clip gets a new size,
 *  so it gets a new strip, and an unchanged one is never fetched twice. */
const posters = new Map<string, string>();
const asking = new Set<string>();
const keyOf = (c: { master?: string | null; bytes?: number | null }) => `${c.master}:${c.bytes ?? ""}`;

function mmss(frames: number, fps: number) {
  const t = Math.max(0, Math.round(frames / (fps || 24)));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const STATUS_TEXT: Record<RenderClip["status"], string> = {
  done: "finished",
  redo: "will be rendered again",
  after: "will be rendered again",
  unchecked: "could not be checked",
};

/**
 * The results track: every finished render group, placed at exactly the part
 * of the timeline it covers. The clips come from the render record Python
 * keeps, not from the timeline's own segments -- they are what WAS rendered,
 * so they are saved, reopened and cleared with the record, and nothing here
 * can be dragged out of place.
 */
export function ResultsLane({ xOf }: { xOf: (frame: number) => number }) {
  const render = useDirector((z) => z.render);
  const fps = useDirector((z) => z.fps);
  const groupsOn = useDirector((z) => !!z.timeline.groupsOn);
  const setResultView = useDirector((z) => z.setResultView);
  const setPlayhead = useDirector((z) => z.setPlayhead);
  const marks = useDirector((z) => z.regenMarks);
  const toggleMark = useDirector((z) => z.toggleRegenMark);
  const running = useDirector((z) => z.job.status === "running");
  const splitClip = useDirector((z) => z.splitClip);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last mark made by a single click, so a SLOW double-click -- slower
  // than the wait below, well inside what Windows counts as a double-click --
  // can take it back.
  const lastMark = useRef<{ group: number; t: number } | null>(null);
  const [, bump] = useState(0);
  // Right-click menu on a clip: everything a clip can do, in one place.
  const [menu, setMenu] = useState<{ x: number; y: number; c: RenderClip } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const clips = render?.clips || [];
  const active = render?.active || null;

  // Fetch any poster strip not seen before.
  useEffect(() => {
    if (!hasParent()) return;
    for (const c of clips) {
      const k = keyOf(c);
      if (!c.master || posters.has(k) || asking.has(k)) continue;
      asking.add(k);
      void request<{ data: string }>("render_poster", { master: c.master }, 120000)
        .then((r) => { if (r?.data) { posters.set(k, r.data); bump((n) => n + 1); } })
        .catch(() => undefined)
        .finally(() => asking.delete(k));
    }
  }, [clips]);

  return (
    <div className="trk results" data-lane="results" style={{ height: 44 }}>
      <span className="tlab">RESULTS · finished render groups</span>
      {!clips.length && !active && (
        <span className="rempty" data-testid="results-empty">
          {groupsOn
            ? "Each group appears here, in place, as soon as it is rendered."
            : "Turn on groups (toolbar) to render in groups: each one appears here as it finishes, and a crash keeps them."}
        </span>
      )}
      {clips.map((c) => {
        const left = xOf(c.start);
        const width = Math.max(6, xOf(c.start + (c.frames_got || c.frames)) - left);
        const img = posters.get(keyOf(c));
        const last = c.first_window + c.n_windows;
        return (
          <div
            key={`${c.group}-${c.master}`}
            className="rclip"
            data-status={c.status}
            data-group={c.group}
            data-start={c.start}
            data-frames={c.frames_got}
            data-marked={marks.includes(c.group) ? "1" : undefined}
            onClick={(e) => {
              // A click marks the clip to be rendered again -- but only once it
              // is clear it was not the first half of a double-click, which
              // opens the monitor instead and must not mark anything.
              e.stopPropagation();
              if (e.detail > 1 || running) return;
              clickTimer.current = setTimeout(() => {
                clickTimer.current = null;
                toggleMark(c.group);
                lastMark.current = { group: c.group, t: Date.now() };
              }, 260);
            }}
            style={{ left, width, backgroundImage: img ? `url(${img})` : undefined }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
              setMenu({ x: e.clientX, y: e.clientY, c });
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
              else if (lastMark.current && lastMark.current.group === c.group && Date.now() - lastMark.current.t < 700) {
                toggleMark(c.group);               // undo the mark the first click made
              }
              lastMark.current = null;
              // The monitor follows the playhead, so put the playhead on this clip.
              setPlayhead(c.start);
              setResultView({ group: c.group, opened: Date.now() });
            }}
            title={[
              `Group ${c.group}: window${c.n_windows > 1 ? "s" : ""} ${c.first_window + 1}${c.n_windows > 1 ? `–${last}` : ""}`,
              `${mmss(c.start, fps)}–${mmss(c.start + c.frames_got, fps)} · ${c.frames_got} frames` +
                (c.frames_got !== c.frames ? ` (slot ${c.frames})` : ""),
              `seed ${c.seed}${c.finished ? ` · rendered ${c.finished}` : ""}`,
              `${STATUS_TEXT[c.status]}${c.why ? ` — ${c.why}` : ""}`,
              marks.includes(c.group) ? "Marked to regenerate - click to unmark" : "Click to mark for regen",
              "Double-click to open the results monitor here",
              c.n_windows > 1 ? `Split it into its ${c.n_windows} windows with the Split button, or right-click` : "Right-click for more",
            ].join("\n")}
          >
            <span className="rlab">G{c.group}{c.take && c.take > 1 ? ` · take ${c.take}` : ""}</span>
            {marks.includes(c.group) && <span className="rmark" title="Marked to regenerate">&#x21bb;</span>}
            {/* where the windows inside it meet */}
            {c.n_windows > 1 && (c.windows || []).slice(0, -1).map((_, k) => {
              const at = (c.windows || []).slice(0, k + 1).reduce((a, b) => a + b, 0);
              return <span key={k} className="rwin" style={{ left: xOf(c.start + at) - left }} />;
            })}
            {c.n_windows > 1 && !running && (
              <button type="button" className="rsplit" data-testid={`split-${c.group}`}
                title={`Split G${c.group} into ${c.n_windows} clips, one per window, so a single part can be regenerated. Nothing is re-rendered: each piece is the exact frames it already has.`}
                onClick={(e) => { e.stopPropagation(); void splitClip(c.group); }}
                onDoubleClick={(e) => e.stopPropagation()}>
                &#x2702; Split
              </button>
            )}
          </div>
        );
      })}
      {menu && (
        <div className="rmenu" data-testid="clip-menu" style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="rmenu-h">G{menu.c.group} · window{menu.c.n_windows > 1 ? `s ${menu.c.first_window + 1}–${menu.c.first_window + menu.c.n_windows}` : ` ${menu.c.first_window + 1}`}</div>
          <button type="button" disabled={running || menu.c.n_windows < 2} data-testid="menu-split"
            title={menu.c.n_windows < 2 ? "This clip is already a single window" : undefined}
            onClick={() => { const g = menu.c.group; setMenu(null); void splitClip(g); }}>
            &#x2702; Split into its {menu.c.n_windows > 1 ? `${menu.c.n_windows} windows` : "windows"}
          </button>
          <button type="button" disabled={running} data-testid="menu-mark"
            onClick={() => { const g = menu.c.group; setMenu(null); toggleMark(g); }}>
            {marks.includes(menu.c.group) ? "Unmark" : "Mark to regenerate"}
          </button>
          <button type="button" data-testid="menu-open"
            onClick={() => { const c = menu.c; setMenu(null); setPlayhead(c.start); setResultView({ group: c.group, opened: Date.now() }); }}>
            Open in the monitor
          </button>
        </div>
      )}
      {active && (
        <div
          className="rclip live"
          data-status="rendering"
          style={{
            left: xOf(active.start),
            width: Math.max(6, xOf(active.start + active.frames) - xOf(active.start)),
          }}
          title={`Group ${active.group} is rendering now`}
        >
          <span className="rlab">G{active.group} · rendering</span>
        </div>
      )}
    </div>
  );
}
