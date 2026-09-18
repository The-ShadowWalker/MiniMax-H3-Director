"use client";

import { useEffect, useMemo } from "react";
import { hydrateDirector, useDirector, useWindowStats } from "../lib/store";
import { TopBar } from "./TopBar";
import { Timeline } from "./Timeline";
import { Rail } from "./Rail";
import { Stage } from "./Stage";
import { Inspector } from "./Inspector";
import { ActionBar } from "./ActionBar";
import { Preview } from "./Preview";
import { VideoMonitor } from "./VideoMonitor";
import { PromptEditor } from "./PromptEditor";
import { Manual } from "./Manual";
import type { PaneId } from "../lib/types";
import { buildPromptRelay } from "../lib/prompt";
import { estimateMinutes, realWindows, solveVideoLength, windowSecondsWarning } from "../lib/h3";

const MOBILE_PANES: { id: PaneId | "timeline"; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "refs", label: "Refs" },
  { id: "gen", label: "Gen" },
  { id: "audio", label: "Audio" },
  { id: "project", label: "Project" },
  { id: "sfx", label: "SFX" },
  { id: "export", label: "Export" },
  { id: "builder", label: "Hybrid" },
  { id: "diag", label: "Diag" },
];

export function DirectorApp() {
  const s = useDirector();
  const stats = useWindowStats();

  useEffect(() => {
    hydrateDirector();
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      const st = useDirector.getState();
      if (st.playing) st.tickPlay(dt);
      if (st.job.status === "running") st.tickJob();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!s.toast) return;
    const t = setTimeout(() => useDirector.getState().setToast(null), 2600);
    return () => clearTimeout(t);
  }, [s.toast]);

  useEffect(() => {
    const t = setInterval(() => {
      const st = useDirector.getState();
      if (st.dirty) st.saveNow();
    }, 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!s.scheduleOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") s.setScheduleOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.scheduleOpen, s]);

  const schedule = useMemo(() => {
    if (!s.scheduleOpen) return null;
    const maxF = Math.max(1, Math.round(s.duration_sec * s.fps));
    const { windows: n } = solveVideoLength(maxF, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap);
    const wins = realWindows(maxF, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap);
    const relay = buildPromptRelay(s, wins);
    return {
      windows: relay.windows,
      warning: windowSecondsWarning(s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap, s.fps),
      minutes: estimateMinutes(n, Number(s.advanced.steps) || 20),
    };
  }, [s]);

  return (
    <div className="app">
      <TopBar />

      <Timeline />
      <Rail />
      <Stage />
      <Inspector />
      <ActionBar />
      {s.toast && <div className="toast">{s.toast}</div>}
      {s.scheduleOpen && schedule && (
        <div className="modal" onClick={() => s.setScheduleOpen(false)} role="presentation">
          <div
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="sched-title"
          >
            <h3 id="sched-title">
              Preview schedule
              <button type="button" className="x" title="Close (Esc)"
                onClick={() => s.setScheduleOpen(false)}>×</button>
            </h3>
            <div className="body">
              <div className="note ok">
                {stats.windows} windows · {stats.newFrames} new frames · {String(s.advanced.steps)} Euler steps · est.{" "}
                {schedule.minutes} min
              </div>
              {schedule.warning && <div className="note">{schedule.warning}</div>}
              <div className="card">
                <h4>Prompt as it will be SENT</h4>
                {s.finalPromptNote && <div className="note ok">{s.finalPromptNote}</div>}
                <pre>{s.finalPrompt || "Asking Wan2GP…"}</pre>
              </div>
              <div className="note">
                Per-window breakdown below shows your prompts as you wrote them. The card above is
                the assembled result actually submitted.
              </div>
              {schedule.windows.map((w) => (
                <div key={w.i} className="card">
                  <h4>
                    Window {w.i + 1} · frames {w.start}–{w.end}
                  </h4>
                  <pre>{w.prompt}</pre>
                </div>
              ))}
              <div className="row">
                <label />
                <button className="btn go" type="button" onClick={() => s.setScheduleOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <Preview />
      <VideoMonitor />
      <PromptEditor />
      <Manual />
    </div>
  );
}
