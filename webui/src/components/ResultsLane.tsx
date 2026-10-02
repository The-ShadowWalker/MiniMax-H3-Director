import { useEffect, useRef, useState } from "react";
import { useDirector, splitPlan, type RenderClip } from "../lib/store";
import { request, hasParent } from "../lib/bridge";

/** Filmstrips by clip file and size: a re-rendered clip gets a new size, so
 *  it gets a new strip, and an unchanged one is never fetched twice. Each is
 *  `count` frames spread evenly through the clip, side by side, every one at
 *  the video's own shape (tile_w x tile_h). The best one fetched is kept. */
interface Strip { data: string; count: number; tile_w: number; tile_h: number }
const posters = new Map<string, Strip>();
const asking = new Set<string>();
const keyOf = (c: { master?: string | null; bytes?: number | null }) => `${c.master}:${c.bytes ?? ""}`;
/** The strip sizes Python makes (plugin.py POSTER_COUNTS). */
const COUNTS = [4, 8, 16, 32, 48];
const bucket = (k: number) => COUNTS.find((c) => c >= k) ?? COUNTS[COUNTS.length - 1];
/** A clip's picture area on the track: its height minus the border. */
const TILE_H = 26;

/** How many frames fit across a clip `width` pixels wide at their true shape. */
function framesAcross(width: number, strip: Strip | undefined, aspect: number) {
  const a = strip && strip.tile_h ? strip.tile_w / strip.tile_h : aspect;
  return Math.max(1, Math.ceil(width / (TILE_H * a)));
}

/** The frames laid along a clip, each at its true shape, like an editor's
 *  filmstrip. Each tile shows the frame from the moment under its middle. */
function Filmstrip({ strip, width }: { strip: Strip; width: number }) {
  const tw = TILE_H * (strip.tile_w / Math.max(1, strip.tile_h));
  const n = Math.max(1, Math.ceil(width / tw));
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const at = Math.min(0.999, ((i + 0.5) * tw) / Math.max(1, width));
    const j = Math.min(strip.count - 1, Math.floor(at * strip.count));
    tiles.push(
      <span key={i} className="rtile" data-frame={j}
        style={{
          left: i * tw, width: tw,
          backgroundImage: `url(${strip.data})`,
          backgroundSize: `${strip.count * tw}px ${TILE_H}px`,
          backgroundPosition: `${-j * tw}px 0`,
        }} />,
    );
  }
  return <span className="rstrip" data-testid="filmstrip" data-count={strip.count} data-tiles={n}>{tiles}</span>;
}

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
  const splitClip = useDirector((z) => z.splitClip);
  const splitting = useDirector((z) => z.splitting);
  // the windows as they are on screen, so Split shows as soon as one is cut
  const durationSec = useDirector((z) => z.duration_sec);
  const timeline = useDirector((z) => z.timeline);
  const layoutSrc = { duration_sec: durationSec, fps, timeline };
  // no split, mark or regen while a render, stitch or split is going on
  const busy = useDirector((z) => z.job.status === "running" || z.stitching || !!z.splitting);
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

  // The video's shape, for sizing a clip's strip before the first one arrives.
  const aspect = useDirector((z) => {
    const m = /^(\d+)\s*[x×]\s*(\d+)/.exec(String(z.advanced.resolution || ""));
    return m ? Number(m[1]) / Math.max(1, Number(m[2])) : 16 / 9;
  });
  // What each clip needs: enough frames to fill its width on screen at their
  // true shape. A wider clip (or a zoom in) asks for a bigger strip.
  const needs = clips.filter((c) => !!c.master).map((c) => {
    const left = xOf(c.start);
    const width = Math.max(6, xOf(c.start + (c.frames_got || c.frames)) - left);
    const have = posters.get(keyOf(c));
    const count = Math.min(bucket(framesAcross(width, have, aspect)), Math.max(1, c.frames_got || c.frames || 1));
    return { c, count, have };
  });
  const needKey = needs.map((x) => `${keyOf(x.c)}#${x.count}`).join("|");
  useEffect(() => {
    if (!hasParent()) return;
    for (const { c, count, have } of needs) {
      const k = keyOf(c);
      if (have && have.count >= count) continue;
      const ask = `${k}#${count}`;
      if (asking.has(ask)) continue;
      asking.add(ask);
      void request<Strip & { master: string }>("render_poster", { master: c.master, count }, 120000)
        .then((r) => {
          if (!r?.data) return;
          const cur = posters.get(k);
          if (!cur || r.count > cur.count) {
            posters.set(k, { data: r.data, count: r.count || 1, tile_w: r.tile_w || 16, tile_h: r.tile_h || 9 });
            bump((n) => n + 1);
          }
        })
        .catch(() => undefined)
        .finally(() => asking.delete(ask));
    }
  }, [needKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // where Split would cut, from the windows on screen right now: the
        // timeline's new windows if they were re-cut inside it, else the
        // windows it was rendered with
        const plan = splitPlan(c, layoutSrc);
        const pieces = plan?.pieces || 0;
        const recut = plan?.mode === "timeline";
        const cuts = plan?.cuts || [];
        return (
          <div
            key={`${c.group}-${c.master}`}
            className="rclip"
            data-status={c.status}
            data-group={c.group}
            data-start={c.start}
            data-frames={c.frames_got}
            data-marked={marks.includes(c.group) ? "1" : undefined}
            data-splitting={splitting?.group === c.group ? "1" : undefined}
            onClick={(e) => {
              // A click marks the clip to be rendered again -- but only once it
              // is clear it was not the first half of a double-click, which
              // opens the monitor instead and must not mark anything.
              e.stopPropagation();
              if (e.detail > 1 || busy) return;
              clickTimer.current = setTimeout(() => {
                clickTimer.current = null;
                toggleMark(c.group);
                lastMark.current = { group: c.group, t: Date.now() };
              }, 260);
            }}
            style={{ left, width }}
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
              pieces > 1
                ? recut
                  ? `Its window was cut into ${pieces} on the timeline: Split cuts the clip to match, or right-click`
                  : `Split it into its ${pieces} windows with the Split button, or right-click`
                : "Right-click for more",
            ].join("\n")}
          >
            {img && <Filmstrip strip={img} width={width} />}
            <span className="rlab">G{c.group}{c.take && c.take > 1 ? ` · take ${c.take}` : ""}</span>
            {marks.includes(c.group) && <span className="rmark" title="Marked to regenerate">&#x21bb;</span>}
            {/* where the windows inside it meet */}
            {pieces > 1 && cuts.map((at, k) =>
              <span key={k} className="rwin" style={{ left: xOf(c.start + at) - left }} />)}
            {splitting?.group === c.group && (
              <span className="rsplitting" data-testid={`splitting-${c.group}`}>
                <i style={{ width: `${splitting.total ? Math.round((100 * splitting.done) / splitting.total) : 0}%` }} />
                <span className="spin" aria-hidden="true" />
                &#x2702; Splitting... {splitting.total ? `${Math.min(splitting.done + 1, splitting.total)}/${splitting.total}` : ""}
              </span>
            )}
            {pieces > 1 && !busy && (
              <button type="button" className="rsplit" data-testid={`split-${c.group}`}
                title={recut
                  ? `Cut G${c.group} at the timeline's new windows into ${pieces} clips, one per window, so a single part can be regenerated. Nothing is re-rendered: each piece is the exact frames it already has.`
                  : `Split G${c.group} into ${pieces} clips, one per window, so a single part can be regenerated. Nothing is re-rendered: each piece is the exact frames it already has.`}
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
          <button type="button" disabled={busy || (splitPlan(menu.c, layoutSrc)?.pieces || 0) < 2} data-testid="menu-split"
            title={(splitPlan(menu.c, layoutSrc)?.pieces || 0) < 2 ? "This clip is already a single window" : undefined}
            onClick={() => { const g = menu.c.group; setMenu(null); void splitClip(g); }}>
            &#x2702; {(() => {
              const mp = splitPlan(menu.c, layoutSrc);
              return mp?.mode === "timeline"
                ? `Split at the new windows (${mp.pieces})`
                : `Split into its ${mp && mp.pieces > 1 ? `${mp.pieces} windows` : "windows"}`;
            })()}
          </button>
          <button type="button" disabled={busy} data-testid="menu-mark"
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
