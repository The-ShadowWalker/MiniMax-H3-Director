import { useEffect, useState } from "react";
import { useDirector } from "../lib/store";

/**
 * The built-in manual, opened by the Help button on the timeline.
 *
 * It is deliberately part of the bundle rather than a link: the plugin runs
 * inside Wan2GP on a machine that may have no browser tab to spare, and a
 * manual that is one click from the timeline is a manual people actually read.
 */

type Section = { id: string; title: string; body: JSX.Element };

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Getting started",
    body: (
      <>
        <p>
          H3 Director is a timeline in front of Wan2GP's MiniMax H3 models. You lay out what
          happens and when, and it assembles the settings Wan2GP needs. Everything it sends is
          something you could have typed into the Generator tab yourself — it just keeps the
          arithmetic straight.
        </p>
        <ol>
          <li>Pick a model and resolution under <b>Gen</b>.</li>
          <li>Set the timeline length, or drop a song on the audio track and let it set the length.</li>
          <li>Add reference images under <b>References</b> so characters stay consistent.</li>
          <li>Write prompts on the timeline where you want things to happen.</li>
          <li>Press <b>Generate</b>.</li>
        </ol>
        <p className="tip">
          Work in short pieces first. A 15-second test tells you whether the look and the
          references are right for a fraction of the time a full song takes.
        </p>
      </>
    ),
  },
  {
    id: "timeline",
    title: "The timeline",
    body: (
      <>
        <p>There are three tracks, and what you drop on each one means something different.</p>
        <dl>
          <dt>Injected Frames and Text Prompts</dt>
          <dd>
            Images placed here are injected as real frames at that point in the video, and text
            prompts here describe what happens at that moment. The first and last images on this
            track become the start and end images.
          </dd>
          <dt>Control</dt>
          <dd>
            A video here guides the generation — motion and composition are followed, with
            Denoising Strength deciding how closely. A <b>text prompt with no video</b> on this
            track marks a gap to generate: that is a bridge (see below).
          </dd>
          <dt>Audio</dt>
          <dd>
            A song or dialogue the model performs to. Dropping audio here offers to set the
            timeline to its length, so the video covers the whole track.
          </dd>
        </dl>
        <p>
          Double-click a clip to preview it, a video to open the monitor, or a prompt to write it
          in a large editor. Drag the ends of any segment to change when it starts and how long it
          runs.
        </p>
      </>
    ),
  },
  {
    id: "length",
    title: "Length and sliding windows",
    body: (
      <>
        <p>
          H3 generates in <b>sliding windows</b>. Each window is one pass; the overlap is a short
          stretch re-generated at each join so the seam matches. The window size is roughly how
          much video one pass produces — about 15 seconds at the default 362 frames and 24fps.
        </p>
        <p>
          You set the timeline length; the number of windows follows from it. The Sliding window
          panel shows how many you will get. A longer timeline is not more risky, but it is longer
          to render — and a mistake costs you every window, not just one.
        </p>
        <p className="tip">
          The timeline length is what comes out. If a song is 44.6 seconds, set 44.6 and the
          generated video covers it, rounded up slightly to land on a legal frame count.
        </p>
      </>
    ),
  },
  {
    id: "groups",
    title: "Long pieces: render groups",
    body: (
      <>
        <p>
          A long timeline rendered as one job gets heavier as it goes — Wan2GP keeps every
          finished window in memory until the job ends — which is why a twenty-clip piece can
          die partway through. <b>Grp</b> on the timeline toolbar splits the run into groups of
          sliding windows, one job each, so memory starts clean at every group.
        </p>
        <p>
          Groups behave like sliding windows one level up, so the piece stays consistent: every
          group runs on the <b>same seed</b>, each one <b>continues from the last frames</b> of
          the group before it, and each gets <b>its own slice of the song</b> at the right
          offset so the words and sounds carry on instead of restarting.
        </p>
        <p>
          The default group size follows your output resolution; type a number in <b>Grp</b> to
          override it. Nothing is joined until every group is finished, and the model is
          released once at the end rather than between groups, which would only force a reload.
        </p>
        <p className="tip">
          The log prints VRAM headroom at every window. A baseline that creeps down group to
          group means something is being retained; a steady one that fails suddenly means that
          window was simply too big for what was left.
        </p>
      </>
    ),
  },
  {
    id: "refs",
    title: "Reference images",
    body: (
      <>
        <p>
          References under the <b>References</b> section keep a character, outfit or place
          consistent. Refer to them in a prompt by number — <code>[image 1]</code> or{" "}
          <code>&lt;Picture 1&gt;</code> — counting the reference sheets in the order they appear
          there.
        </p>
        <p>
          You never have to renumber them. A start image, an end image and any injected frames all
          occupy numbered slots ahead of the sheets, so the plugin shifts the numbers in what it
          sends while your prompt keeps the numbers you typed. If nothing sits ahead of the
          sheets, nothing is changed.
        </p>
        <p className="tip">
          If a reference is not asserting itself, raise <b>Reference sheet size</b> before you
          rewrite the prompt. It usually matters more than the wording.
        </p>
        <h4>Saved reference mods (RefMods)</h4>
        <p>
          A RefMod is a reference that has already been encoded and saved to a small file, so it
          can be reused without keeping the original picture or clip around. Some people prefer
          working that way to attaching the reference images themselves — you can use both in the
          same generation.
        </p>
        <p>
          Mods are made and stored by a separate plugin, <b>MiniMax H3 RefMods</b>. With it
          installed, everything you have saved appears at the bottom of the References pane: pick
          them in the order they should apply, give each one its own strength, and use{" "}
          <b>Overall strength</b> to ease the whole set back at once. Without that plugin the
          panel says so rather than offering a picker it cannot fill.
        </p>
        <p>
          Only the <b>first sliding window</b> receives them. Later windows continue from the
          previous window's own frames, so a mod re-applied at every boundary would show up as a
          visible jump at each one.
        </p>
      </>
    ),
  },
  {
    id: "bridge",
    title: "Bridges: continuing and joining video",
    body: (
      <>
        <p>
          Put a text prompt on the <b>control</b> track with no video under it and you have marked
          a gap. What the clips around it look like decides what happens:
        </p>
        <dl>
          <dt>Between two clips</dt>
          <dd>A bridge: new video that leaves the first clip and arrives at the second.</dd>
          <dt>After a clip, nothing following</dt>
          <dd>The clip is extended forwards.</dd>
          <dt>Before a clip, nothing preceding</dt>
          <dd>New video is generated that leads into it.</dd>
        </dl>
        <p>
          Each gap generates at its own length — the length of the segment you drew — and the
          pieces are joined into one file at the end. Reference images and injected frames work
          inside a bridge as they do anywhere else.
        </p>
      </>
    ),
  },
  {
    id: "audio",
    title: "Audio and sound design",
    body: (
      <>
        <p>
          With a song on the audio track the model performs to it. With nothing there, it{" "}
          <b>generates</b> the audio to match the picture — that is the mode the no-music and
          no-speech switches apply to.
        </p>
        <p>
          <b>Sound design</b> under Tools runs MMAudio over a finished video. It can run on
          anything you already made, not only this project, and it can write the effects as a
          separate track so you can mix them yourself.
        </p>
      </>
    ),
  },
  {
    id: "loras",
    title: "LoRAs",
    body: (
      <>
        <p>
          The LoRA list is read from Wan2GP's folder for the current model. Choose one from the
          dropdown and it is added to the stack; add another and it goes below the first. The
          order in the stack is the order they are applied, and the arrows change it.
        </p>
        <p>
          Each LoRA gets a strength slider — one per guidance phase when the model runs more than
          one, which lets a LoRA act differently early and late in denoising. The phase count
          lives under <b>Gen</b>, with the model settings, because it is a property of the
          checkpoint.
        </p>
        <p className="tip">A LoRA only does anything when its trigger word is in the prompt.</p>
      </>
    ),
  },
  {
    id: "saving",
    title: "Saving, and where files go",
    body: (
      <>
        <p>
          The project autosaves as you work. Autosave writes the project file only — media is
          copied into the workspace once when you add it, and is not copied again. Only the
          current project is ever on disk, so nothing accumulates.
        </p>
        <p>
          <b>Save project</b> writes a zip with everything in it, wherever you choose.{" "}
          <b>New project</b> clears the workspace and starts over, keeping the model, resolution
          and size you had set.
        </p>
      </>
    ),
  },
  {
    id: "trouble",
    title: "When something goes wrong",
    body: (
      <>
        <dl>
          <dt>The video is shorter than the song</dt>
          <dd>
            Check the timeline length matches the track — the <b>Match audio</b> button beside the
            duration sets it exactly.
          </dd>
          <dt>A reference is being ignored</dt>
          <dd>
            Raise the reference sheet size, and check the number in the prompt matches the sheet's
            position in the References list.
          </dd>
          <dt>The control video is not influencing anything</dt>
          <dd>
            At Denoising Strength 1.0 with Whole Frame, the control video is skipped by design.
            Lower the strength.
          </dd>
          <dt>Nothing happens after Generate</dt>
          <dd>
            Look at the Wan2GP console. Every line from this plugin is prefixed{" "}
            <code>[H3-D]</code>, and the prompt and settings actually sent are logged there.
          </dd>
        </dl>
      </>
    ),
  },
];

export function Manual() {
  const s = useDirector();
  const [open, setOpen] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") s.setManualOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  if (!s.manualOpen) return null;

  return (
    <div className="man-back" onMouseDown={() => s.setManualOpen(false)}>
      <div className="man-win" onMouseDown={(e) => e.stopPropagation()}>
        <div className="man-head">
          <span className="man-title">H3 Director — manual</span>
          <button className="btn sm" type="button" onClick={() => s.setManualOpen(false)}>
            Close
          </button>
        </div>
        <div className="man-body">
          <nav className="man-nav">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`man-link${open === sec.id ? " on" : ""}`}
                onClick={() => setOpen(sec.id)}
              >
                {sec.title}
              </button>
            ))}
          </nav>
          <article className="man-text">
            {SECTIONS.filter((sec) => sec.id === open).map((sec) => (
              <div key={sec.id}>
                <h3>{sec.title}</h3>
                {sec.body}
              </div>
            ))}
          </article>
        </div>
      </div>
    </div>
  );
}
