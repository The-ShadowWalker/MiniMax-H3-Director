<div align="center">

# H3 Director

**A timeline for Wan2GP's MiniMax H3 video models.**

Lay out your shots, prompts, references and soundtrack on a timeline.
H3 Director works out the settings and generates the video.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Wan2GP](https://img.shields.io/badge/for-Wan2GP-6a5acd)
![Model](https://img.shields.io/badge/model-MiniMax%20H3-ff7a59)

</div>

---

<img width="1914" height="998" alt="Screenshot 2026-09-23 194130" src="https://github.com/user-attachments/assets/c90dffcf-fc9a-4f37-bfd7-caf6827674f8" />

## Overview

H3 Director installs as a Wan2GP plugin and adds its own tab. Instead of filling
in a generation form and working out frame counts by hand, you build the video on
a timeline: images where you want them, prompts where things happen, a song on
the audio track.

It runs inside Wan2GP and uses Wan2GP's own generation engine. Everything it
sends is something you could have entered in the Generator tab yourself.

## Features

| | |
|---|---|
| **Timeline editing** | Three tracks — injected frames and text prompts, control video, and audio. Drag, trim and place anything on a frame-accurate timeline. |
| **Length that matches** | Set the timeline to your soundtrack and the finished video covers it. Sliding windows, overlap and the model's frame grid are handled for you. |
| **Reference images** | Keep characters, outfits and places consistent across a whole video. Refer to them by number in a prompt; the numbering is kept correct automatically. |
| **Injected frames** | Drop an image at any point and it becomes a real frame there. The first and last become start and end images. |
| **Bridges** | Mark a gap and it gets generated — joining two clips, extending one forwards, or leading into one. The pieces are joined into a single file. |
| **Control video** | Guide motion and composition from an existing video, with adjustable denoising strength. |
| **Generated audio** | With no soundtrack supplied, the model creates the audio to match the picture, with switches for music, speech, ambience and effects. |
| **Sound design** | Run MMAudio over any finished video, and optionally write the effects as a separate track for mixing in a DAW. |
| **LoRA stack** | LoRAs read from Wan2GP's own folder, applied in the order you choose, with a strength slider per guidance phase. |
| **Live progress** | Real per-window progress from Wan2GP, and a run that survives a dropped browser connection. |
| **DAW export** | Export the timeline for your editor, including a Reaper project. |
| **Built-in manual** | A Help button on the timeline, and hover help throughout. |

## Requirements

- A working [Wan2GP](https://github.com/deepbeepmeep/Wan2GP) installation
- A MiniMax H3 model — FL2VA, Ref2VA, or a hybrid that accepts both reference
  images and a soundtrack in the same generation
- No additional Python packages

## Installation

Install it from inside Wan2GP.

1. Open Wan2GP and go to the **Plugin Manager** tab.
2. Paste this repository's URL into the install field:

   ```
   https://github.com/The-ShadowWalker/H3-Director
   ```

3. Install, then restart Wan2GP. A tab named **H3 Director** appears.

Once the plugin is listed in Wan2GP's community catalogue you can install it
from the Plugin Manager's list instead, without pasting a URL.

To uninstall, remove it from the Plugin Manager.

## Quick start

1. Choose a model and resolution under **Gen**.
2. Drop a song on the audio track, and accept the offer to match the timeline to
   its length.
3. Add one or two reference images under **References**.
4. Add a text prompt to the top track describing what happens.
5. Press **Generate**.

> **Tip** — start short. A 15-second test shows whether the look and the
> references are right, in a fraction of the time a full song takes.

## The timeline

What a clip means depends on the track it sits on.

| Track | What it does |
|---|---|
| **Injected Frames and Text Prompts** | Images become real frames at that point in the video; the first and last become the start and end images. Text prompts describe what happens at that moment. |
| **Control** | A video guides motion and composition, with denoising strength deciding how closely. A text prompt here with no video marks a gap to generate. |
| **Audio** | A song or dialogue for the model to perform to. Dropping audio offers to set the timeline to its length. |

Double-click a clip to preview it, a video to open the monitor, or a prompt to
write it in a full-size editor.

## Length and sliding windows

MiniMax H3 generates in **sliding windows** — one pass each, with a short overlap
re-generated at every join so the seam matches. At the default window size and
24fps, one window is a little over 15 seconds of video.

You set the timeline length; the number of windows follows. The finished video
covers what you asked for, rounded up to the nearest frame count the model
accepts. The Sliding window panel shows how many windows you will get before you
commit.

## References

Reference images keep a character, outfit or location consistent. Refer to them
in a prompt by number:

```
<Subject 1>: a figure in a dark leather trench coat and tall black hat,
referencing Picture 1.
```

Start images, end images and injected frames all occupy numbered slots ahead of
the reference sheets. H3 Director adjusts the numbering in what it sends, so the
prompt you wrote keeps the numbers you typed.

> **Tip** — if a reference is not asserting itself, raise **Reference sheet size**
> before rewriting the prompt. It usually matters more than the wording.

## Bridges

Place a text prompt on the **control** track with no video under it and you have
marked a gap to generate. What sits around it decides what happens:

| Neighbours | Result |
|---|---|
| A clip either side | A bridge leaving the first and arriving at the second |
| A clip before only | The clip is extended forwards |
| A clip after only | New video leading into it |

Each gap generates at its own length — the length of the segment you drew — and
the pieces are joined into one file. Reference images and injected frames work
inside a bridge as they do anywhere else.

## Audio and sound design

With a song on the audio track, the model performs to it. With nothing there, it
**generates** the audio to match the picture — the mode the no-music and
no-speech switches apply to.

**Sound design** runs MMAudio over a finished video. It works on anything you
have already made, not only the current project, and can write the effects as a
separate track so you can mix them yourself.

## LoRAs

LoRAs are read from Wan2GP's folder for the current model. Choose one from the
dropdown and it is added to the stack; add another and it goes below. The order
shown is the order they are applied, and the arrows change it.

Each LoRA has a strength slider — one per guidance phase when the model runs more
than one, letting a LoRA act differently early and late in denoising.

> A LoRA only takes effect when its trigger word appears in the prompt.

## Saving

Projects autosave as you work. Autosave writes the project file only — media is
copied into the workspace once when you add it. Only the current project is kept
on disk, so nothing accumulates.

**Save project** writes a complete zip wherever you choose. **New project**
clears the workspace, keeping your model, resolution and size.

## Troubleshooting

Every line the plugin writes to the Wan2GP console is prefixed `[H3-D]`,
including the prompt and settings actually sent.

| Symptom | Cause |
|---|---|
| Video is shorter than the song | Timeline length does not match the track — use **Match audio** |
| A reference is ignored | Raise **Reference sheet size**, and check the number matches the sheet's position |
| Control video has no effect | At denoising strength 1.0 with Whole Frame it is skipped by design — lower it |
| Nothing happens after Generate | Check the console for `[H3-D]` lines |

## Credits

Built for Wan2GP by **The-ShadowWalker**.

MiniMax H3 is by MiniMax. Wan2GP is by
[deepbeepmeep](https://github.com/deepbeepmeep/Wan2GP). This project is
independent of both.

## Licence

No licence has been set. Add a `LICENSE` file before publishing if you want one —
without it, GitHub treats the code as all rights reserved.
