import { useDirector, useWindowStats } from "../lib/store";

export function ActionBar() {
  const s = useDirector();
  const stats = useWindowStats();
  const running = s.job.status === "running";
  return (
    <div className="act">
      <button className="btn go" type="button" disabled={running}
        title="Generate the whole timeline here, in this tab."
        onClick={() => s.generate("all")}>
        Generate
      </button>
      <button className="btn" type="button" disabled={running}
        title="Send these settings to Wan2GP's Video Generator tab and switch to it."
        onClick={() => void s.applyToGenerator()}>
        Apply to generator
      </button>
      <button className="btn" type="button" title="Show the windows, their lengths and the prompt each one will receive, without generating anything." onClick={() => s.previewSchedule()}>
        Preview schedule
      </button>
      <button className="btn" type="button" title="Stop the run after the window in progress." onClick={() => s.cancel()} disabled={!running}>
        Cancel
      </button>
      {running && (
        <button className="btn" type="button"
          title="The run finished or died without reporting back — clear the status so Generate works again"
          onClick={() => void s.reattachJob()}>
          Reset status
        </button>
      )}
      <div className="stat">
        <span>{running ? `Window ${s.job.windowIndex + 1}/${s.job.windows}` : s.job.status === "done" ? "Done" : "Ready"}</span>
        <span className="num">
          {stats.windows} windows · {String(s.advanced.steps)} steps · est. {stats.minutes} min
        </span>
        <span style={{ color: "var(--ok)" }}>Wiring OK</span>
      </div>
    </div>
  );
}
