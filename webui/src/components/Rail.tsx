import { FolderOpen, Images, Music, Sparkles, Waves, Download, Blocks, Stethoscope } from "lucide-react";
import { useDirector, useWindowStats } from "../lib/store";
import type { PaneId } from "../lib/types";

/** Every rail button is the same height and every icon the same box, so the
 *  column reads as one list rather than a set of mismatched blocks. */
const ICON = 15;

export function Rail() {
  const s = useDirector();
  const stats = useWindowStats();
  // Green means "the chosen audio mode is satisfied", not merely "a file
  // exists". Each mode needs something different, and generating from the
  // prompt needs nothing at all.
  const hasTrack = s.timeline.segments.some(
    (x) => (x.track === "audio" || x.track === "clipaudio") && !x.muted && (x.mediaId || x.mediaUrl));
  const hasVoiceRef = s.refs.audio.length > 0;
  const src = String(s.audio?.source ?? "");
  const audioReady =
    src === ""  ? true                      // generated from the prompt
    : src === "A" ? hasTrack                // soundtrack drives generation
    : src === "K" ? hasTrack && hasVoiceRef // soundtrack + reference voice
    : hasTrack || hasVoiceRef;
  const audioSub =
    src === ""  ? "generated from the prompt"
    : src === "A" ? (hasTrack ? "soundtrack on the timeline" : "needs an audio track")
    : src === "K" ? (hasTrack && hasVoiceRef ? "soundtrack + voice reference"
        : !hasTrack ? "needs an audio track" : "needs a voice reference")
    : (hasTrack ? "audio track loaded" : "no audio");
  const done = {
    project: !!s.project_name && s.project_name !== "untitled",
    refs: s.refs.images.length + s.refs.videos.length + s.refs.audio.length > 0,
    audio: audioReady,
    gen: s.job.status === "done" || s.job.status === "running",
    sfx: !!(s.sfx as { lastAudio?: string }).lastAudio,
    export: !!s.exportDir,
  };
  const items: { id: PaneId; icon: JSX.Element; label: string; sub: string; ok?: boolean }[] = [
    { id: "project", icon: <FolderOpen size={ICON} />, label: "Project", sub: `${s.project_name} \u00b7 ${s.duration_sec}s`, ok: done.project },
    { id: "refs", icon: <Images size={ICON} />, label: "References", sub: `${s.refs.images.length + s.refs.videos.length + s.refs.audio.length} files`, ok: done.refs },
    { id: "audio", icon: <Music size={ICON} />, label: "Audio", sub: audioSub, ok: done.audio },
    { id: "gen", icon: <Sparkles size={ICON} />, label: "Generation", sub: `${s.advanced.steps} steps \u00b7 ${stats.windows || 0} windows`, ok: done.gen },
    { id: "export", icon: <Download size={ICON} />, label: "Export", sub: s.exportDir ? "folder set" : "", ok: done.export },
  ];
  const tools: { id: PaneId; icon: JSX.Element; label: string; sub: string; ok?: boolean }[] = [
    { id: "sfx", icon: <Waves size={ICON} />, label: "Sound design",
      sub: (s.sfx as { lastAudio?: string }).lastAudio ? "track written" : "not run", ok: done.sfx },
    { id: "builder", icon: <Blocks size={ICON} />, label: "Hybrid builder", sub: "" },
    { id: "diag", icon: <Stethoscope size={ICON} />, label: "Diagnostics", sub: s.bridgeOk === false ? "bridge down" : stats.windows ? "wiring OK" : "" },
  ];
  const Btn = (it: { id: PaneId; icon: JSX.Element; label: string; sub: string; ok?: boolean }) => (
    <button key={it.id} type="button" className={`st${s.pane === it.id ? " on" : ""}`} onClick={() => s.setPane(it.id)}>
      <span className={`g${it.ok ? " ok" : ""}`}>{it.icon}</span>
      <div>
        {it.label}
        <small>{it.sub || "\u00a0"}</small>
      </div>
    </button>
  );
  return (
    <nav className="rail">
      <div className="rh">Workflow</div>
      {items.map(Btn)}
      <div className="rh">Tools</div>
      {tools.map(Btn)}
    </nav>
  );
}
