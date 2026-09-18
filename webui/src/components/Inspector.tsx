import { useDirector, useWindowStats } from "../lib/store";
import { formatTimecode, realWindows } from "../lib/h3";
import { getMedia, fmtDuration , servedUrl } from "../lib/media";
import { useState } from "react";
import { PromptBox } from "./PromptBox";
import { useEffect } from "react";
import { request } from "../lib/bridge";

interface BridgePlanItem {
  id: string; mode: string; why: string; seconds: number; flags: string;
  fromName?: string; toName?: string;
  frames?: number; request?: number; windows?: number; warning?: string;
}

/** What a gap on the guidance track will actually do, resolved by Python from
 *  the clips either side of it. */
function BridgePlan({ segId }: { segId: string }) {
  const s = useDirector();
  const [plan, setPlan] = useState<BridgePlanItem | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ plans: BridgePlanItem[] }>("plan_bridges", {
          fps: s.fps,
          segments: s.timeline.segments.map((x) => ({
            id: x.id, track: x.track, start: x.start, length: x.length,
            mediaId: x.mediaId, prompt: x.prompt, title: x.title, fileName: x.fileName,
          })),
        }, 30000);
        setPlan((r?.plans || []).find((x) => x.id === segId) || null);
      } catch (e) { setErr(String(e)); }
    })();
  }, [segId, s.timeline.segments, s.fps]);

  const LABEL: Record<string, string> = {
    bridge: "Bridge between two clips",
    extend_after: "Extend the clip before",
    extend_before: "Extend in front of the clip after",
    invalid: "Nothing to bridge",
  };
  return (
    <div className="fs">
      <div className="rh2">Bridge</div>
      {err && <p className="hint">Could not work out the plan: {err}</p>}
      {!plan && !err && <p className="hint">Add a prompt to describe what happens here.</p>}
      {plan && plan.mode === "invalid" && (
        <div className="warnbox">
          <div className="rh2" style={{ color: "var(--warn)" }}>Nothing to bridge</div>
          <p className="hint">
            There is no guidance clip before or after this, so there is nothing to continue from
            or land on. An ordinary prompt belongs on the top track with the images.
          </p>
          <button type="button" className="btn sm" onClick={() => {
            s.updateSeg(segId, { track: "video" } as never);
            s.setToast("Moved to the prompt track");
          }}>Move to the prompt track</button>
        </div>
      )}
      {plan && plan.mode !== "invalid" && (
        <>
          <div className="row"><label>Will do</label><span className="v">{LABEL[plan.mode] || plan.mode}</span></div>
          {plan.fromName && <div className="row"><label>Continue from</label><span className="v">{plan.fromName}</span></div>}
          {plan.toName && <div className="row"><label>Land on</label><span className="v">{plan.toName}</span></div>}
          <div className="row">
            <label>Will generate</label>
            <span className="v num">
              {plan.seconds}s · {plan.frames} frames{plan.windows && plan.windows > 1 ? ` · ${plan.windows} windows` : ""}
            </span>
          </div>
          <p className="hint">
            The gap's own length is what gets made — the clips either side already exist and are
            never regenerated. The timeline just holds them end to end.
          </p>
          {plan.warning && <div className="warnbox"><p className="hint">{plan.warning}</p></div>}
          <div className="row"><label>Flags</label><span className="v num">{plan.flags || "none"}</span></div>
          <p className="hint">{plan.why}</p>
          {plan.mode === "extend_before" && (
            <p className="hint">
              Generation only runs forward, so this is made to END on the next clip's first frame
              and placed in front of it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function Inspector() {
  const s = useDirector();
  const stats = useWindowStats();
  const video = s.timeline.segments.filter((x) => x.track === "video").sort((a, b) => a.start - b.start);
  const seg = s.timeline.segments.find((x) => x.id === s.selectedId) ?? video[0];
  if (!seg) {
    return (
      <aside className="insp">
        <div className="ih">
          <div className="ik">Timeline selection</div>
          <div className="ih-row">
            <h3>Nothing selected</h3>
          </div>
        </div>
        <div className="ib">
          <div className="fs">
            <p style={{ fontSize: 12, color: "var(--ink2)" }}>
              Click a segment on the timeline. Double-click a gap on VIDEO to add a text prompt. Drop files onto a track.
            </p>
          </div>
        </div>
      </aside>
    );
  }
  const idx = video.findIndex((x) => x.id === seg.id);
  const win = stats.spans.find((w) => seg.start >= w.start && seg.start < w.end);
  const next = idx >= 0 ? video[idx + 1] : undefined;
  const control = s.timeline.segments.find((x) => x.track === "control" && x.start < seg.start + seg.length && x.start + x.length > seg.start);

  return (
    <aside className="insp">
      <div className="ih">
        <div className="ik">
          Timeline selection
          {idx >= 0 ? ` · segment ${idx + 1} of ${video.length}` : ` · ${seg.track}`}
        </div>
        <div className="ih-row">
          <h3>{seg.title}</h3>
        </div>
      </div>
      <div className="ib">
        {(() => {
          const total = Math.round(s.duration_sec * s.fps);
          const bands = realWindows(total, s.timeline.slidingWindowSize, s.timeline.slidingWindowOverlap);
          const cuts = bands.map((b) => b.start).filter((c) => c > seg.start && c < seg.start + seg.length);
          if (!cuts.length) return null;
          return (
            <div className="fs warnbox">
              <div className="rh2" style={{ color: "var(--warn)" }}>
                Crosses {cuts.length === 1 ? "a window boundary" : `${cuts.length} window boundaries`}
              </div>
              <p className="hint">
                This shot spans more than one window, so its prompt is sent to each of them and the
                model restarts the shot at every join. Split it to give each window its own prompt.
              </p>
              <button type="button" className="btn sm" onClick={() => s.splitSegAtWindows(seg.id)}>
                Split at window {cuts.length === 1 ? "boundary" : "boundaries"}
              </button>
            </div>
          );
        })()}
        <div className="fs">
          <button type="button" className="btn sm warn" onClick={() => s.removeSeg(seg.id)}>
            Delete this segment
          </button>
        </div>
        {(() => {
          const m = getMedia(seg.mediaId);
          const url = m?.url || servedUrl(m) || (seg.mediaId ? `need:${seg.mediaId}` : seg.mediaUrl);
          if (!url && !m) return null;
          const isAudio = seg.track === "audio" || seg.track === "clipaudio";
          return (
            <div className="fs">
              {m?.thumb && (
                <button type="button" className="mprev" onClick={() => s.setPreview({ url: m.url || servedUrl(m) || `need:${m.mediaId}`, kind: seg.kind === "image" ? "image" : "video", name: m.name })} title="Click to view full size">
                  <img src={m.thumb} alt="" />
                </button>
              )}
              {m && (
                <>
                  <div className="row"><label>File</label><span className="v" style={{overflow:"hidden",textOverflow:"ellipsis"}}>{m.name}</span></div>
                  {m.durationSec > 0 && (
                    <div className="row"><label>Duration</label><span className="v num">{fmtDuration(m.durationSec)} · {Math.round(m.durationSec * s.fps)}f</span></div>
                  )}
                  {m.width > 0 && (
                    <div className="row"><label>Size</label><span className="v num">{m.width}x{m.height}</span></div>
                  )}
                  {m.sampleRate > 0 && (
                    <div className="row"><label>Audio</label><span className="v num">{(m.sampleRate/1000).toFixed(1)} kHz · {m.channels === 1 ? "mono" : "stereo"}</span></div>
                  )}
                </>
              )}
              {url && (
                <button type="button" className="btn" onClick={() => s.setPreview({ url, kind: isAudio ? "audio" : seg.kind === "image" ? "image" : "video", name: m?.name || seg.title })}>
                  Open full size
                </button>
              )}
            </div>
          );
        })()}

        {seg.track === "control" && !seg.mediaId && (
          <BridgePlan segId={seg.id} />
        )}
        {seg.track === "control" && seg.mediaId && (
          <div className="fs">
            <div className="rh2">Control video</div>
            <div className="row">
              <label>Denoising strength</label>
              <input
                type="range" min={0.3} max={1} step={0.05}
                value={typeof seg.denoiseStrength === "number" ? seg.denoiseStrength : 0.75}
                onChange={(e) => s.updateSeg(seg.id, { denoiseStrength: Number(e.target.value) })}
              />
              <span className="v num">
                {(typeof seg.denoiseStrength === "number" ? seg.denoiseStrength : 0.75).toFixed(2)}
              </span>
            </div>
            <p className="hint">
              {(seg.denoiseStrength ?? 0.75) >= 1
                ? "At 1.00 the model never encodes the clip — the control video is ignored entirely."
                : "Lower follows the clip's motion more closely. 0.5–0.85 is the useful range; 1.00 ignores it completely."}
            </p>
          </div>
        )}
        {(seg.track === "clipaudio" || seg.track === "control") && (
          <div className="fs">
            <div className="rh2">Control video audio</div>
            <label className="chk">
              <input
                type="checkbox"
                checked={!!s.timeline.segments.find((x) => x.track === "clipaudio" && (s.lockClipAudio || x.id === seg.id))?.muted}
                onChange={(e) => {
                  const targets = s.timeline.segments.filter((x) => x.track === "clipaudio" && (s.lockClipAudio || x.id === seg.id));
                  targets.forEach((t) => s.updateSeg(t.id, { muted: e.target.checked }));
                }}
              />
              Mute this clip's audio
            </label>
            <label className="chk">
              <input type="checkbox" checked={s.lockClipAudio} onChange={(e) => s.setLockClipAudio(e.target.checked)} />
              Lock audio to video (move and trim together)
            </label>
            <p className="hint">
              {s.lockClipAudio
                ? "The clip's audio follows the video when you move or trim it."
                : "Unlocked — the audio can be positioned independently of its video."}
            </p>
          </div>
        )}

        <div className="fs">
          <div className="row">
            <label>Starts</label>
            <span className="v num">{formatTimecode(seg.start / s.fps)}</span>
          </div>
          <div className="row">
            <label>Length</label>
            <input
              type="range"
              min={1}
              max={Math.max(2, s.duration_sec)}
              step={0.1}
              value={seg.length / s.fps}
              onChange={(e) => s.moveSeg(seg.id, seg.start, Number(e.target.value) * s.fps)}
            />
            <span className="v num">{(seg.length / s.fps).toFixed(1)}s</span>
          </div>
          <div className="row">
            <label>Window</label>
            <span className="v num">{win ? `${win.i + 1} of ${stats.windows}` : "—"}</span>
          </div>
        </div>
        {(seg.track === "video" || (seg.track === "control" && !seg.mediaId)) && (
          <div className="fs">
            <h4>Prompt</h4>
            <PromptBox
              label={seg.track === "control" ? `Bridge prompt — ${seg.title || "bridge"}` : `Shot prompt — ${seg.title || seg.kind}`}
              value={seg.prompt || ""}
              placeholder={seg.track === "control"
                ? "What happens between the clips — the motion that carries one into the next."
                : "What happens in this shot. Reference images as [image 1], [image 2]…"}
              onChange={(v) => s.updateSeg(seg.id, { prompt: v, title: seg.title })}
            />
            {next ? (
              <div className="note ok">Continues into segment {idx + 2}. Subject, lighting and camera direction carry forward.</div>
            ) : (
              <div className="note ok">Last segment — a hard cut can be marked in Generation if you need a clean join.</div>
            )}
          </div>
        )}
        {seg.track === "video" && (
          <div className="fs">
            <h4>References used here</h4>
            <div className="chips">
              {s.refs.images.map((r, i) => {
                const on = seg.usedRefs.includes(i + 1);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`chip${on ? " on" : ""}`}
                    onClick={() => {
                      const set = new Set(seg.usedRefs);
                      if (on) set.delete(i + 1);
                      else set.add(i + 1);
                      s.updateSeg(seg.id, { usedRefs: [...set].sort((a, b) => a - b) });
                    }}
                  >
                    {i + 1} {r.label}
                  </button>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 9 }}>
              <label>Guide strength</label>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(seg.guideStrength * 100)}
                onChange={(e) => s.updateSeg(seg.id, { guideStrength: Number(e.target.value) / 100 })}
              />
              <span className="v num">{seg.guideStrength.toFixed(2)}</span>
            </div>
          </div>
        )}
        <div className="fs">
          <h4>Control video</h4>
          <div className="row">
            <label>Clip</label>
            <select
              value={control?.id ?? ""}
              onChange={() => {
                /* selection is timeline-driven */
              }}
            >
              <option value="">{control ? control.title : "None in this segment"}</option>
              {control && <option value={control.id}>{control.title}</option>}
            </select>
          </div>
          <div className="row">
            <label>Influence</label>
            <input
              type="range"
              min={0}
              max={100}
              disabled={!control}
              value={Math.round((control?.influence ?? 0) * 100)}
              onChange={(e) => control && s.updateSeg(control.id, { influence: Number(e.target.value) / 100 })}
            />
            <span className="v num">{control ? (control.influence ?? 0).toFixed(2) : "—"}</span>
          </div>
          <div className="hint">At zero the clip is ignored entirely.</div>
        </div>
        {(
          // Everything is always visible - nothing is hidden behind a mode.
          true
        ) ? (
          <div className="fs">
            <h4>Advanced for this segment</h4>
            <div className="row">
              <label>Title</label>
              <input type="text" value={seg.title} onChange={(e) => s.updateSeg(seg.id, { title: e.target.value })} />
            </div>
            <div className="row">
              <label />
              <button className="btn sm dg" type="button" onClick={() => s.removeSeg(seg.id)}>
                Delete segment
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
