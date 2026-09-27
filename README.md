<div align="center">

# H3 Director

**A timeline director for MiniMax H3 in Wan2GP.**

Lay out shots, prompts, reference images, control video and a soundtrack on a
frame-accurate timeline. H3 Director works out the windows, lengths and
settings, renders the piece, and lets you fix any part of it without starting over.

![Version](https://img.shields.io/badge/version-1.6.19-blue)
![Wan2GP](https://img.shields.io/badge/for-Wan2GP%2013.10%20to%2013.14-6a5acd)
![Model](https://img.shields.io/badge/model-MiniMax%20H3-ff7a59)

</div>

---

<!-- Add a screenshot of the plugin tab here: ![H3 Director](docs/screenshot.png) -->

## Contents

- [What's new in 1.6](#whats-new-in-16)
- [Features at a glance](#features-at-a-glance)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The screen](#the-screen)
- [The timeline](#the-timeline)
- [Prompts](#prompts)
- [Length and sliding windows](#length-and-sliding-windows)
- [References](#references)
- [Control video and bridges](#control-video-and-bridges)
- [Audio](#audio)
- [Generation settings](#generation-settings)
- [Rendering long pieces in groups](#rendering-long-pieces-in-groups)
- [The results track](#the-results-track)
- [Fixing part of a render](#fixing-part-of-a-render)
- [Stitching the final video](#stitching-the-final-video)
- [The Hybrid model](#the-hybrid-model)
- [Sound design](#sound-design)
- [Export to a DAW](#export-to-a-daw)
- [Projects and saving](#projects-and-saving)
- [Logs and diagnostics](#logs-and-diagnostics)
- [Wan2GP versions](#wan2gp-versions)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## What's new in 1.6

**A results track, and a render you can repair instead of redo.**

- **Results track.** Every finished part of a render appears on a RESULTS lane,
  exactly under the part of the timeline it covers, with a filmstrip of its
  frames. It updates while the render runs.
- **Results monitor.** Double-click a result clip to open a monitor that follows
  the timeline's playhead. Press Play and it plays straight across the joins, so
  a problem you see is exactly where the playhead is.
- **Continue after a crash.** Each finished part is saved at once as a lossless
  clip. After a crash, reboot or Cancel, **Continue** picks up where it stopped,
  on the same seed, carrying on from the last finished frames.
- **Regenerate only what you don't like.** Mark clips on the results track and
  press **Regen marked**. Each one is rendered again in place and joins both of
  its neighbours seamlessly. Everything else is left alone.
- **Split a clip into its windows.** A clip that covers several windows can be
  cut into one clip per window, so one bad window can be redone on its own.
- **Stitch.** Join every clip on the results track into one video, frame-exact
  in picture and sound. The Stitch button tells you when the full video is out
  of date.
- **Type a window's length.** Click the seconds on any sliding window, type the
  length, press Enter.
- **Set the timeline to an audio clip's length at any time**, from the clip's
  own panel.
- **Seamless sound across group joins.** Each part hears the end of the part
  before it, so speech and music carry on instead of restarting.
- **Runs on older and newer Wan2GP alike.** H3 Director reads which Wan2GP it is
  running on and uses the code that version needs. Tested on 13.10, 13.13 and 13.14.
- **Keyboard control of the playhead**: Left / Right, Home / End.

---

## Features at a glance

| | |
|---|---|
| **Timeline editing** | Tracks for injected frames and prompts, control video, clip audio, the soundtrack, and results. Drag, trim and place anything to the frame. |
| **Lengths that add up** | Set the timeline length or match it to a song. Sliding windows, overlap and the model's frame grid are worked out for you. |
| **Hand-set windows** | Drag window boundaries or type exact lengths. The windows always cover the timeline exactly. |
| **Reference images** | Keep characters, outfits and places consistent. Refer to them by number; the numbering in what is sent is corrected for you. |
| **Injected frames** | An image on the timeline becomes a real frame at that point. The first and last become the start and end images. |
| **Control video** | Guide motion and composition from an existing clip, with adjustable denoising strength. |
| **Bridges** | Mark a gap on the control track and it is generated — joining two clips, extending one, or leading into one. |
| **Soundtrack and lip sync** | A song or dialogue on the audio track drives the performance and the lip sync. |
| **Generated audio** | With no soundtrack, H3 generates the audio, with switches to leave out music, speech, ambience or effects. |
| **Render groups** | Long pieces are rendered as a chain of shorter jobs that carry on from each other, so memory starts clean each time. |
| **Continue, regen, split, stitch** | Resume a stopped render, redo any clip in place, split clips into windows, and join everything into one video. |
| **Hybrid AV model** | Build and use a merged FL2VA + Ref2VA checkpoint that takes reference images *and* a soundtrack in one render. |
| **LoRA stack** | LoRAs from Wan2GP's folder, in the order you choose, with a strength per guidance phase. |
| **Saved reference mods** | Use RefMods from the MiniMax H3 RefMods plugin, each with its own strength. |
| **Sound design** | Run MMAudio over any finished video and write the effects as their own track. |
| **DAW export** | Reaper project, marker CSV, Audacity labels or CMX3600 EDL. |
| **Projects** | Autosave, dated history, and full project zips that include every rendered clip. |
| **Built-in manual** | A Help button on the timeline, and hover help on every control. |

---

## Requirements

- A working [Wan2GP](https://github.com/deepbeepmeep/Wan2GP) installation. Tested
  on **13.10**, **13.13** and **13.14**; see [Wan2GP versions](#wan2gp-versions).
- At least one MiniMax H3 model: **FL2VA**, **Ref2VA**, or the **Hybrid** that
  H3 Director can build for you.
- No extra Python packages. The ffmpeg that ships with Wan2GP is used for
  cutting, joining and previews.

## Installation

H3 Director is installed from inside Wan2GP.

1. Open Wan2GP and go to the **Plugin Manager** tab.
2. Find **H3 Director** in the list of community plugins and install it.
3. Restart Wan2GP. A tab named **H3 Director** appears.

Updates and uninstalling are done from the same Plugin Manager.

## Quick start

1. Under **Generation**, pick a pipeline, model size and resolution.
2. Press **Add audio** and drop in a song. Accept the offer to set the timeline
   to its length.
3. Under **References**, add one or two images of your character or place.
4. Press **Add text** and write what happens. Drag the prompt to where it
   happens and stretch it to how long it lasts.
5. Press **Generate**.

> **Tip:** start short. A 15-second test tells you whether the look and the
> references are right in a fraction of the time a full song takes.

---

## The screen

| Area | What it holds |
|---|---|
| **Top bar** | Project name, **Save**, **Save as…**, **Load**, **Restore autosave**, the model in use, and the plugin version. A red **NOT SAVING** badge means the project has not loaded yet, so nothing on screen can overwrite it. |
| **Timeline** | The tracks, the window bands above them and the toolbar. |
| **Left rail** | The panes: **Project**, **References**, **Audio**, **Generation**, **Export**, and the tools **Sound design**, **Hybrid builder** and **Diagnostics**. |
| **Right panel** | Everything about the selected clip: its prompt, file details, timing and options. |
| **Bottom bar** | **Generate**, **Continue**, **Stitch**, **Regen marked**, **Apply to generator**, **Preview schedule**, **Cancel**, and the run status. |

---

## The timeline

### Tracks

| Track | What it does |
|---|---|
| **Injected frames and text prompts** | Images become real frames at that point in the video; the first and last are the start and end images. Text prompts describe what happens at that moment. |
| **Control video** | A video here guides motion and composition. A prompt here with no video under it marks a gap to generate: a [bridge](#control-video-and-bridges). |
| **Clip audio** | The sound of the control videos. Mute a clip's audio, or lock it to its video so they move and trim together. |
| **Audio** | The soundtrack the model performs to. |
| **Results** | What has been rendered, placed exactly where it belongs. See [the results track](#the-results-track). |

### Editing

- **Add text / image / video / audio** on the toolbar, or drag files onto a track.
- Drag a clip to move it; drag its ends to change when it starts and how long it runs.
- Click a clip to select it; **Delete** or **Backspace** removes it.
- Double-click a prompt to write it in a full-size editor, an image to view it,
  or a video to open the control-video monitor.
- **Play** / **Pause** and **Loop** play the timeline; the monitors follow it.
  **Space** plays and pauses.
- **Left / Right** move the playhead one frame (with **Shift**, one second);
  **Home** and **End** jump to the start and the end. Click on the timeline first
  so it has the keyboard.
- **snap** snaps clips to window boundaries. **bands** shows or hides the
  window bands.
- **Clear** empties the timeline. If there are rendered clips, it says so and
  deletes them with it.
- **Help** opens the built-in manual.

---

## Prompts

- **Shot prompts** sit on the top track, at the point and for the length they
  describe. Refer to reference images as `[image 1]`, `[image 2]`, and so on.
- **Global prompt** (Generation pane) is added to every window, or only to the
  first with **Global prompt in every window** turned off. The character count
  sent is shown next to it.
- **Hard-cuts**: list window numbers (for example `2,4`) to start those windows
  as a new shot instead of a continuation.
- **Crossing a window boundary**: a prompt that runs across a boundary is
  flagged, with a **Split at window** button that cuts it exactly there.
- **Durations in prompts**: if your prompts carry `[/duration=…s]` tags, the
  Sliding window tab can **Resize windows to match the prompts**.
- **Preview schedule** shows every window, its length and the exact prompt it
  will receive, without generating anything.

---

## Length and sliding windows

H3 generates in **sliding windows**, one pass each. Each window re-generates a
short **overlap** with the one before it, so the seam matches. You set how long
the timeline is; the windows follow from that.

**Automatic windows.** Set **Win** (window size) and **Ovl** (overlap) on the
toolbar. Both snap to the model's frame grid, and the toolbar tells you when a
typed number moves. The seconds of one window are shown beside **Win**.

**Hand-set windows.** Tick **manual** on the toolbar (or **Set window lengths by
hand** in Generation → Sliding window). Then:

- **Drag** any boundary between two windows.
- **Type an exact length**: click the seconds shown on a window. A box opens
  with the number already selected. Type the seconds and press **Enter**; **Esc**
  cancels. On a window too narrow to show its seconds, double-click the band.
- **+ window** splits the window under the playhead in two.
- **Select** a window (click its band) and press **Delete** to fold it into its
  neighbour.
- In **Generation → Sliding window**: change the number of windows, **Split** or
  fold (**×**) any window, or **Even them out**.

The windows always add up to exactly the timeline. When you change one window,
the ones after it give up or take the difference. When the timeline gets longer
or shorter, only the last window changes. A window outside the model's limits
turns red, and the panel says why.

---

## References

### Images

Add up to nine reference images to keep a character, outfit or place consistent.
Drag to reorder; **Make #1** moves one to the front. Refer to them in a prompt
by position: `[image 1]` is the first.

Start images, end images and injected frames take numbered slots ahead of the
reference sheets. H3 Director shifts the numbers in what it sends, so your
prompt keeps the numbers you typed.

**Reference strength** sets how large the reference sheets are drawn for the
model. If a reference is not coming through, raise it before rewriting the prompt.

### Video and audio references

With a reference-capable model (Ref2VA or the Hybrid) you can also add up to two
reference videos (2–15 s each, 15 s combined) and a reference voice.
**Audio source** follows what is attached, or you can pick a mode to override it.

### Saved reference mods (RefMods)

A RefMod is a reference that was encoded once and saved to a small file. With the
[MiniMax H3 RefMods](https://github.com/g3n3rativ3/MiniMaxH3Mod-for-WanGP) plugin
installed, your saved mods appear at the bottom of the References pane. Add them
in the order they should apply, give each its own **Strength**, and use
**Overall strength** to ease the whole set back at once. Mods are applied to the
first sliding window only; later windows continue from its frames.

---

## Control video and bridges

### Control video

A video on the control track guides motion and composition. Select it to set its
**Denoising strength**: lower follows the clip more closely, 0.5–0.85 is the
useful range, and 1.0 ignores it. For FL2VA, **Control / inject** chooses between
the control video, injected frames, or neither; **Auto** decides from what is on
the timeline.

### Bridges

Double-click the control track (or put a prompt there with no video under it) to
mark a gap to generate. What is around the gap decides what happens:

| Around the gap | What is generated |
|---|---|
| A clip on both sides | A bridge that leaves the first clip and lands on the second |
| A clip before only | The clip is extended forwards |
| A clip after only | New video that leads into it |

Each gap is generated at the length you drew, and the pieces are joined into one
file. The Generation pane shows how much is generated and how much existing clip
is kept.

---

## Audio

### Soundtrack

A song or dialogue on the **Audio** track drives the performance and the lip
sync. When you add audio you are offered to set the timeline to its length. You
can do it later too:

- the **Match audio** button next to **Duration** on the toolbar, or
- select the audio clip and use **Set timeline to this audio** in its panel.

Nothing on the timeline is moved or cut when the length changes. If both the
soundtrack and a control video's audio are present, they are mixed into one
guidance track, and the longer one sets the length.

### Generated audio

With no audio source, H3 generates the whole soundscape. The **Audio** pane can
leave out **music**, **speech or vocals**, **room tone** or **effects**. These are
added to the prompt only when it is sent; what you typed is never changed.

---

## Generation settings

Everything in the **Generation** pane is read live from the model Wan2GP has
loaded, so new options upstream appear on their own.

| Tab | Settings |
|---|---|
| **General** | Pipeline (FL2VA, Ref2VA, Hybrid), model size, checkpoint or finetune (**Auto** picks the first match), PDD 8-step, resolution, steps, seed, flow shift, guidance scale, guidance phases, sampler, videos per prompt, global prompt, hard-cuts, and the live run status. |
| **LoRAs** | Pick from Wan2GP's folder for this model. The stack order is the apply order, with a strength slider per guidance phase. |
| **Steps skipping** | Cache type, when it starts, spectrum skip and FBC threshold. |
| **Post processing** | Temporal upsampling (RIFE ×2 / ×4), spatial upsampling (Lanczos ×1.5 / ×2), film grain. |
| **Quality** | Self Refiner, minimum frames with references, and the H3 options: mask denoising mode and the audio refinement pass. |
| **Sliding window** | Hand-set windows, window count, split, fold, even out, resize to prompts, and render groups. |
| **Misc** | Memory and precision: attention mode and the model's own option groups (text encoder, VAE, DiT priority). |

**Apply to generator** sends the same settings to Wan2GP's own Video Generator
tab and switches to it, if you would rather generate from there.

---

## Rendering long pieces in groups

A long timeline rendered as one job gets heavier as it goes, because Wan2GP holds
every finished window in memory until the job ends. Tick **groups** on the
toolbar to render in **groups** of windows, one job each; **Grp** sets how many
windows go in a group. Memory starts clean at every group. Groups are drawn above
the window bands.

The groups behave like one continuous render:

- Every group runs on the **same seed**. A random seed is fixed once, up front.
- Each group **continues from the last frames of the group before it**, and hears
  their sound, so the picture and the audio both carry on across the join.
- Each group gets **its own slice of the soundtrack**, at the right offset.
- The start image belongs to the first group and the end image to the last, and
  reference numbering is corrected in each group's prompt.

Options in Generation → Sliding window:

- **Unload the model between groups**: slower, but useful if memory creeps up
  from group to group.
- **Hold the look steady between groups**: measures the carried frames against
  the opening look and nudges them back before the next group.

Progress reads *Group 2 of 5 · window 3 of 4*. If your browser tab loses its
connection, the render carries on and the status reattaches when you come back.

---

## The results track

Every finished group appears on the **RESULTS** lane, exactly under the windows it
covers, with a strip of its first, middle and last frames. The part being
rendered shows where the run has got to. Hover a clip for its windows, length,
seed and when it was made.

- **Green**: the clip still matches the timeline.
- **Amber**: something it depends on changed since it was rendered; hover to see
  what.

**Double-click** a clip to open the results monitor. It follows the timeline: it
shows the clip under the playhead and plays when you press Play on the timeline,
straight across the joins. Drag it by its title bar, resize it from the corner,
**Esc** closes it. If the timeline has its own soundtrack, the clip's sound is
muted so you don't hear the song twice; **sound on / off** switches to the
clip's own audio.

Every clip is kept as a **lossless master** in `workspace/renders/`. That is what
Continue, Regen, Split and Stitch all use. The monitor plays a light preview of
the same frames.

### Continue after a crash

Each group is written to disk as soon as it finishes, before the render moves on.
If the render stops (a crash, a reboot, or **Cancel**), the finished groups are
kept. When you open H3 Director again, **Continue** appears with how much is done.
It picks up after the last finished group, on the same seed, carrying on from
that group's last frames. You can switch to a different group size for the part
that is left.

Before anything is kept, it is checked against the timeline as it is now: the
clip is complete, the seed, overlap and shared settings are unchanged, and the
group's own prompts and media are unchanged. The Generation pane shows the
same card, with **Discard** if you would rather start over.

**Generate** never throws finished clips away on its own. Whatever still matches
is kept and only the rest is rendered. When everything is already rendered, or
nothing can be kept, it asks first.

---

## Fixing part of a render

### Regen marked

**Click** clips on the results track to mark them (click again to unmark), then
press **Regen marked**. **Mark changed clips** marks every clip whose own
prompt or media changed since it was rendered.

Each marked clip is rendered again in place. It continues from the end of the
clip before it and lands exactly on the first frame of the clip after it, so both
joins stay seamless. Marked clips next to each other are rendered together as one
piece. A regen always uses the render's own seed, so the new take still matches
its neighbours. The new clip replaces the old one only once it is finished and
checked; if anything fails, the old clip stays.

### Split a clip into its windows

A clip that covers several windows shows dashed lines where they meet and a
yellow **✂ Split** button in its corner. There are three ways to split:

- press **✂ Split** on the clip;
- **right-click** the clip and choose **Split into its windows**;
- mark one or more clips and press **✂ Split marked into windows** next to
  **Regen marked**.

The clip becomes one clip per window, so you can redo just the bad window.
Nothing is rendered: each piece is cut losslessly from the clip, with exactly the
frames and sound it already had. Splitting is not offered while a render is
running.

A clip whose prompt has changed since it was rendered can't be split, because
its pieces could not be checked against the timeline. Split first, then change
the part you want to redo.

**Right-click** any clip for its menu: split, mark or unmark it for regen, or
open it in the monitor.

---

## Stitching the final video

**Stitch** joins every clip on the results track into one video. Each clip is cut
by exact frame count and its sound to exactly the same span, then everything is
encoded once, so picture and sound stay in sync across every join.

After a regen, **Stitch** turns green and reads **Stitch now**. Hover it to see
which clips changed since the last stitch. Each stitch is written as a new
dated file next to the last one, so earlier versions are kept. A render that
finishes normally is stitched automatically.

---

## The Hybrid model

The **Hybrid** combines the FL2VA base with the Ref2VA reference blocks, so one
render can take **reference images and a soundtrack together**:

- the **song** drives the performance and lip sync, the FL2VA way;
- the **reference images** keep characters and places consistent, the Ref2VA way;
- the song is **never** used as a voice to clone; a separate voice reference can
  be added for that.

**Hybrid builder** (under Tools) builds the checkpoint from your FL2VA and Ref2VA
files: pick the two checkpoints, the AdaLN block range to take from Ref2VA, and
where to save it. It searches every checkpoint folder Wan2GP knows about. Once
built, the Hybrid appears in the model list like any other H3 model, and it
works with LoRAs and RefMods.

---

## Sound design

**Sound design** (under Tools) runs MMAudio over a finished video: the last
render, or any file you choose. Pick the method and seed, name the output track
and folder, and optionally write a copy of the video with the new track muxed
in. Your original music is never overwritten.

## Export to a DAW

The **Export** pane writes the timeline for your editor:

| Format | For |
|---|---|
| **Reaper project** (`.RPP`) | Native project with one track per timeline lane, your audio at zero, and a marker at every shot change and window boundary |
| **Marker CSV** | Reaper's Region/Marker Manager, Premiere, Resolve |
| **Audacity labels** | Audacity and anything that reads label files |
| **CMX3600 EDL** | Any editor that reads EDLs |

Choose what to include (guidance music, clip audio, SFX stems, the rendered
video) and where it goes. Media is copied next to the session file so the DAW
finds it.

---

## Projects and saving

- **Autosave** writes the project as you work. Media is copied into the
  workspace once, when you add it.
- **Project history** keeps dated snapshots (the last 30, taken every few minutes
  while you edit). **Restore autosave** reloads the last one.
- **Save** writes a full project zip: settings, timeline, every media file, and
  every rendered clip with its record, so a project opened on another machine can
  still be continued. The clips are stored uncompressed, with a checksum each.
- **Load** opens a project zip or a settings `.json`. **List recent** shows the
  projects you saved before.
- **New project** clears the workspace, keeping your model, resolution and
  sampling settings. **Load demo** opens an example project.
- **Clean unused media** removes files the project no longer uses.

---

## Logs and diagnostics

- Every line H3 Director writes to the Wan2GP console starts with `[H3-D]`,
  including the exact prompt and settings sent for each window or group.
- `workspace/h3-director.log` records the same, written line by line so it
  survives a crash. The previous run is kept as `h3-director.prev.log`. It also
  records the GPU's power draw, temperature and VRAM at each window.
- **Diagnostics** (under Tools) checks that every media file is on disk and the
  wiring to Wan2GP is working, and can print the environment to the console.

## Wan2GP versions

Wan2GP changes often, and H3 Director has to keep working on the version you
have, not only the newest. At startup it reads Wan2GP's version and uses the
code written for that version; the console says which:

```
[H3-D] Wan2GP 13.13 detected; compatibility profile 13.13 and earlier
```

Where it depends on the exact shape of Wan2GP's own code (the Hybrid model's
pipeline), it tries the profile for your version first and falls back to the
others, so a patched Wan2GP, or one that did not change its version number,
still works. A Wan2GP newer than any this release knows uses the newest
profile, and the log says so. When a Wan2GP update does need a change, it is
added as a new profile next to the old ones, so older versions keep working.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The video is shorter than the song | Set the timeline to the song: **Match audio**, or **Set timeline to this audio** on the audio clip. |
| A reference is ignored | Raise **Reference strength**, and check the number in the prompt matches the image's position. |
| The control video has no effect | Its denoising strength is at 1.0. Lower it. |
| Nothing happens after Generate | Look for `[H3-D]` lines in the Wan2GP console; they say what was sent or why it was refused. |
| A render stops between groups | Click anywhere in the Wan2GP page and keep it visible. If the page froze, reload it and press **Continue**. |
| Wan2GP stops at start with *Cannot find empty port 7860* | Another copy of Wan2GP is still running and holding the port. Close it (or end the leftover `python.exe` in Task Manager) and start again. |
| Wan2GP closes with no error | That is the GPU driver, power or memory, not the plugin. Check Windows **Event Viewer → System** for *Kernel-Power 41* or a *Display* / *nvlddmkm* driver reset at that time, then press **Continue**. |
| A clip on the results track is amber | Something it was made from changed. Hover it to see what, then regen it or undo the change. |

---

## Credits

Built for Wan2GP by **The-ShadowWalker**.

MiniMax H3 is by MiniMax. Wan2GP is by
[deepbeepmeep](https://github.com/deepbeepmeep/Wan2GP). This project is
independent of both.
