import type { RefImage, Segment, SessionPayload } from "./types";
import { H3 } from "./h3";

function id(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export const DEMO_REFS: RefImage[] = [
  { id: "r1", name: "island_sheet", label: "sky island" },
  { id: "r2", name: "alien_identity", label: "alien" },
  { id: "r3", name: "alien_sheet_4", label: "detail" },
  { id: "r4", name: "wolf_ref", label: "wolf" },
  { id: "r5", name: "falls_env", label: "waterfall" },
  { id: "r6", name: "outfit", label: "costume" },
  { id: "r7", name: "mount_sheet", label: "mount" },
];

const FPS = 24;
const DUR = 60;
const WIN = 15 * FPS; // visual 15s blocks matching the mockup

export function demoSegments(): Segment[] {
  const prompts = [
    {
      title: "Establish island",
      prompt:
        "The alien from Picture 3 stands on the floating island from Picture 1, wind moving the grass, camera drifting slowly forward.",
      thumb: "island",
      refs: [1, 2, 3, 7],
    },
    {
      title: "Mount the animal",
      prompt:
        "The alien from Picture 2 mounts the wolf from Picture 4 at the island edge. Costume from Picture 6 catches the wind. Camera arcs around as they settle into the saddle.",
      thumb: "alien",
      refs: [2, 4, 6, 7],
    },
    {
      title: "Launch",
      prompt:
        "They launch from the island into open sky. Control video drives the flight path. Hair and cloak trail, camera tracking just behind the right shoulder.",
      thumb: "launch",
      refs: [2, 6, 7],
    },
    {
      title: "Toward the falls",
      prompt:
        "They dive toward the waterfall from Picture 5. Spray catches sidelight. Continues from the launch — same subject, lighting and camera direction carry forward.",
      thumb: "falls",
      refs: [2, 5, 7],
    },
  ];
  const segs: Segment[] = prompts.map((p, i) => ({
    id: `v${i + 1}`,
    kind: "text" as const,
    track: "video" as const,
    start: i * WIN,
    length: WIN,
    title: p.title,
    prompt: p.prompt,
    thumbLabel: p.thumb,
    guideStrength: 1,
    usedRefs: p.refs,
    color: i === 0 ? "#7f77dd" : "#8f88e2",
  }));
  segs.push({
    id: "c1",
    kind: "control",
    track: "control",
    start: 2 * WIN,
    length: Math.round(7.9 * FPS),
    title: "flight_reference.mp4",
    prompt: "",
    fileName: "flight_reference.mp4",
    thumbLabel: "▶",
    guideStrength: 0.3,
    influence: 0.3,
    usedRefs: [],
    color: "#5dcaa5",
  });
  segs.push({
    id: "ca1",
    kind: "clipaudio",
    track: "clipaudio",
    start: 2 * WIN,
    length: Math.round(7.9 * FPS),
    title: "muted",
    prompt: "",
    fileName: "flight_reference.mp4",
    guideStrength: 1,
    muted: true,
    usedRefs: [],
    color: "#1d9e75",
  });
  segs.push({
    id: "a1",
    kind: "audio",
    track: "audio",
    start: 0,
    length: DUR * FPS,
    title: "grinch_theme.wav",
    prompt: "",
    fileName: "grinch_theme.wav",
    guideStrength: 1,
    usedRefs: [],
    color: "#ef9f27",
  });
  return segs;
}

export function demoSession(): SessionPayload {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return {
    plugin: "MiniMaxH3HybridAVUniversal",
    version: "2.2.0",
    project_name: "Grinch_1",
    pipeline: "Hybrid",
    size: "Full 33B",
    global_prompt: "",
    fps: FPS,
    duration_sec: DUR,
    hardcuts: "",
    savedAt: `${hh}:${mm}`,
    advanced: {
      checkpoint: "Hybrid BF16 AdaLN30-49",
      resolution: "704x1280",
      resolution_category: "720p",
      seed: -1,
      repeat: 1,
      steps: H3.STEPS_DEFAULT,
      flowshift: H3.FLOW_SHIFT,
      guidance: H3.GUIDANCE,
      solver: "euler",
      cache_type: "",
      cache_mult: 0.5,
      cache_strength: 0.08,
      cache_start: 0,
      override_attention: "",
      text_encoder: "",
      video_vae: "",
      priority: "",
      loras: [],
      loras_mult: "",
      start_tau: 0.0,
      guidance_phases: 1,
      phase2_noise: 0,
      fl2va_guide_mode: "auto",
      denoising: 1,
      mask_mode: "",
      masking_strength: 1,
    },
    refs: {
      images: DEMO_REFS,
      videos: [],
      audio: [],
      imageMode: "I",
      imageDetail: 100,
      removeBg: false,
      refmods: [],
      refmodRetention: 1,
    },
    audio: {
      source: "A",
      controlVideoAudio: "mute",
    },
    sfx: {
      engine: "auto",
      sensitivity: 60,
      window: 4,
      preserveMusic: true,
      noAddedMusic: true,
      noSpeech: true,
      analysed: false,
    },
    exportInclude: {
      video: true,
      originalMusic: true,
      previewMix: true,
      sfxStems: false,
      sfxCsv: false,
      finalMix: false,
    },
    builder: {
      fl2va: "MiniMax-H3-FL2VA_bf16",
      ref2va: "MiniMax-H3-Ref2VA_bf16",
      startBlock: 30,
      endBlock: 49,
      includeFinal: false,
      saveTo: "D:\\Wan2GP\\ckpts",
      status: "Blocks 30–49 tested: reference identity holds while audio drives lip sync.",
    },
    timeline: {
      fps: FPS,
      durationSec: DUR,
      slidingWindowSize: H3.WINDOW_DEFAULT,
      slidingWindowOverlap: H3.OVERLAP_DEFAULT,
      showWindows: true,
      snap: true,
      allowPastCap: false,
      playhead: Math.round(18.4 * FPS),
      segments: demoSegments(),
    },
  };
}

export function emptySession(): SessionPayload {
  const s = demoSession();
  s.project_name = "untitled";
  s.savedAt = undefined;
  s.timeline.segments = [];
  s.timeline.playhead = 0;
  s.timeline.durationSec = 15;
  s.refs.images = [];
  s.global_prompt = "";
  return s;
}

export function uid(prefix = "s"): string {
  return id(prefix);
}
