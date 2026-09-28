import { useDirector, useWindowStats } from "../lib/store";
import { Confirm } from "./Confirm";

function mmss(sec: number) {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function ActionBar() {
  const s = useDirector();
  const stats = useWindowStats();
  const running = s.job.status === "running" || s.stitching;
  const sp = s.splitting;
  // nothing that renders or rewrites the clips may start while one is cut
  const busy = running || !!sp;
  const r = s.render;
  const canContinue = !!r?.resumable && !busy;
  const marks = s.regenMarks;
  const splittable = marks.filter((g) => ((r?.clips || []).find((c) => c.group === g)?.n_windows || 0) > 1).length;
  const stale = !!r?.stitch_stale && !running;
  // Clips whose OWN prompt or media changed ("redo"). The ones after a change
  // ("after") are only stale for a straight-through render; a regen lands on
  // them, so they stay as they are.
  const changed = (r?.clips || []).filter((c) => c.changed ?? c.status === "redo").map((c) => c.group);
  return (
    <div className="act">
      <button className="btn go" type="button" disabled={busy}
        title={canContinue
          ? "Render what is not rendered yet. Finished clips that still match the timeline are kept."
          : "Generate the whole timeline here, in this tab."}
        onClick={() => s.generate("all")}>
        Generate
      </button>
      {!!r?.clips?.length && (
        <button className={`btn${stale ? " go" : ""}`} type="button" data-testid="stitch"
          data-stale={stale ? "1" : undefined} disabled={busy}
          title={stale
            ? `The full video is out of date: ${r.stitch_why || "a clip changed"}. Join every clip on the results track into one new video.`
            : `Join every clip on the results track into one video again.${r.joined ? ` Last stitched: ${r.joined}` : ""}`}
          onClick={() => void s.stitch()}>
          {s.stitching ? "Stitching..." : stale ? `Stitch now (${r.clips.length} clips)` : `Stitch (${r.clips.length})`}
        </button>
      )}
      {canContinue && (
        <button className="btn go" type="button" data-testid="continue-render"
          title={`Pick up the unfinished render after its last finished group, on the same seed. ${r?.kept_windows} of ${r?.total_windows} windows are done.`}
          onClick={() => s.continueRender()}>
          Continue ({mmss(r?.kept_seconds || 0)} of {mmss(r?.total_seconds || 0)} done)
        </button>
      )}
      {marks.length > 0 && (
        <>
          <button className="btn go" type="button" data-testid="regen-marked" disabled={busy}
            title={`Render the marked clips again, in place, on the render's own seed${r?.seed != null ? ` (${r.seed})` : ""} so they still match the clips around them. Each one continues from the clip before it and lands exactly on the clip after it; nothing else is touched.`}
            onClick={() => s.regenMarked()}>
            Regen marked ({marks.length})
          </button>
          {splittable > 0 && (
            <button className="btn" type="button" data-testid="split-marked" disabled={busy}
              title="Cut each marked clip that covers several windows into one clip per window, so just one part can be regenerated. Nothing is rendered; every piece keeps exactly the frames and sound it has."
              onClick={() => void s.splitMarked()}>
              &#x2702; Split marked into windows ({splittable})
            </button>
          )}
          <button className="btn sm" type="button" title="Unmark every clip" onClick={() => s.clearRegenMarks()}>clear marks</button>
        </>
      )}
      {!marks.length && changed.length > 0 && !busy && (
        <button className="btn" type="button" data-testid="mark-changed"
          title="Mark every clip whose prompt or media changed since it was rendered, ready to regenerate"
          onClick={() => changed.forEach((g) => s.toggleRegenMark(g))}>
          Mark changed clips ({changed.length})
        </button>
      )}
      <button className="btn" type="button" disabled={busy}
        title="Send these settings to Wan2GP's Video Generator tab and switch to it."
        onClick={() => void s.applyToGenerator()}>
        Apply to generator
      </button>
      <button className="btn" type="button" title="Show the windows, their lengths and the prompt each one will receive, without generating anything." onClick={() => s.previewSchedule()}>
        Preview schedule
      </button>
      <button className="btn" type="button"
        title="Stop the run after the window in progress. In groups, the finished groups are kept and Continue picks up from them."
        onClick={() => s.cancel()} disabled={!running}>
        Cancel
      </button>
      {running && (
        <button className="btn" type="button"
          title="The run finished or died without reporting back — clear the status so Generate works again"
          onClick={() => void s.reattachJob()}>
          Reset status
        </button>
      )}
      {sp && (
        <div className="splitstat" data-testid="split-status" role="status"
          title="Cutting the clip into one clip per window. Nothing is rendered; it only takes a moment per piece, longer for a long clip.">
          <span className="spin" aria-hidden="true" />
          <span>
            &#x2702; Splitting G{sp.group}{sp.batch ? ` (${sp.batch.k} of ${sp.batch.of})` : ""} -{" "}
            {sp.step === "starting" || sp.step === "reading the clip"
              ? "reading the clip"
              : sp.done >= sp.total && sp.total > 0
                ? "saving"
                : `piece ${Math.min(sp.done + 1, Math.max(1, sp.total))} of ${sp.total}`}
            {sp.elapsed >= 1 ? ` · ${mmss(sp.elapsed)}` : ""} - please wait
          </span>
          <span className="bar"><i style={{ width: `${sp.total ? Math.round((100 * sp.done) / sp.total) : 0}%` }} /></span>
        </div>
      )}
      {!sp && s.splitMsg && (
        <div className={`splitstat ${s.splitMsg.kind}`} data-testid="split-msg" role="alert">
          <span>{s.splitMsg.text}</span>
          <button className="btn sm" type="button" title="Close" onClick={() => s.setSplitMsg(null)}>&#x2715;</button>
        </div>
      )}
      <div className="stat">
        <span>{running ? `Window ${s.job.windowIndex + 1}/${s.job.windows}` : s.job.status === "done" ? "Done" : "Ready"}</span>
        <span className="num">
          {stats.windows} windows · {String(s.advanced.steps)} steps · est. {stats.minutes} min
        </span>
        <span style={{ color: "var(--ok)" }}>Wiring OK</span>
      </div>
      <Confirm
        open={s.startOverArm}
        title="Render the finished clips again?"
        body={(() => {
          const n = r?.recorded_groups ?? r?.clips?.length ?? 0;
          const all = !!r?.complete && (r?.kept_groups ?? 0) === n;
          return (all
            ? `All ${n} groups are rendered and still match the timeline.`
            : `The ${n} finished clip(s) cannot be kept: ${r?.reason || "they no longer match the timeline"}.`) +
            " Rendering again replaces them with new clips. To redo only some, cancel this, mark those clips on the results track and use Regen marked.";
        })()}
        confirmLabel="Render again"
        onCancel={() => s.setStartOverArm(false)}
        onConfirm={() => { s.setStartOverArm(false); s.generate("all", { fresh: true }); }}
      />
    </div>
  );
}
