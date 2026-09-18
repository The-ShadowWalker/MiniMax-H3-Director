export type Pipeline = "Hybrid" | "FL2VA" | "Ref2VA";
export type CheckpointSize = "Full 33B" | "Pruned 20B";
export type PaneId =
  | "project"
  | "refs"
  | "audio"
  | "gen"
  | "sfx"
  | "export"
  | "builder"
  | "diag";
export type AdvTab = "general" | "loras" | "skip" | "post" | "quality" | "window" | "misc";
export type Mode = "basic" | "advanced";

export type SegKind = "text" | "image" | "video" | "audio" | "clipaudio" | "control" | "refimage" | "refvideo" | "refaudio";
export type TrackId = "video" | "control" | "clipaudio" | "audio";

export interface Segment {
  parentId?: string;
  trimStart?: number;
  gain?: number;
  denoiseStrength?: number;
  mediaId?: string;
  id: string;
  kind: SegKind;
  track: TrackId;
  start: number; // frames
  length: number; // frames
  title: string;
  prompt: string;
  fileName?: string;
  mediaUrl?: string;
  thumbLabel?: string;
  guideStrength: number;
  muted?: boolean;
  /** 0–1; control video influence. 0 = ignored. */
  influence?: number;
  /** Per-segment reference chips (1-based indices into refs.images). */
  usedRefs: number[];
  color?: string;
}

export interface RefImage {
  mediaId?: string;
  id: string;
  name: string;
  label: string;
  url?: string;
  isRefMod?: boolean;
}

export interface RefClip {
  mediaId?: string;
  id: string;
  name: string;
  url?: string;
  durationSec: number;
}

export interface JobLog {
  t: number;
  msg: string;
  level: "info" | "ok" | "warn" | "err";
}

export interface GenJob {
  files?: string[];
  phase?: string;
  detail?: string;
  step?: number | null;
  steps?: number | null;
  unit?: string;
  elapsed?: number;
  lastFrame?: number;
  id: string;
  status: "idle" | "queued" | "running" | "done" | "cancelled" | "error";
  windowIndex: number;
  windows: number;
  progress: number; // 0–1
  startedAt?: number;
  finishedAt?: number;
  logs: JobLog[];
  resultNote?: string;
}

export interface SessionPayload {
  lockClipAudio?: boolean;
  saveDir?: string;
  autoRenumberRefs?: boolean;
  exportDir?: string;
  plugin: string;
  version: string;
  project_name: string;
  pipeline: Pipeline;
  size: CheckpointSize;
  global_prompt: string;
  fps: number;
  duration_sec: number;
  hardcuts: string;
  savedAt?: string;
  advanced: Record<string, unknown>;
  refs: {
    images: RefImage[];
    videos: RefClip[];
    audio: RefClip[];
    imageMode: string;
    imageDetail: number;
    removeBg: boolean;
  };
  audio: {
    source: string;
    controlVideoAudio: string;
  };
  sfx: {
    // post-production sound design (MMAudio and friends)
    enabled?: boolean;
    method?: string;
    prompt?: string;
    negative?: string;
    seed?: number;
    videoPath?: string;
    outDir?: string;
    outName?: string;
    alsoMux?: boolean;
    lastAudio?: string;
    lastMuxed?: string;
    status?: string;
    message?: string;
    no_music?: boolean;
    no_speech?: boolean;
    no_ambience?: boolean;
    no_effects?: boolean;
    // legacy fields kept so older sessions still load
    engine?: string;
    sensitivity?: number;
    window?: number;
    preserveMusic?: boolean;
    noAddedMusic?: boolean;
    noSpeech?: boolean;
    analysed?: boolean;
  };
  exportInclude: Record<string, boolean>;
  builder: {
    fl2va: string;
    ref2va: string;
    startBlock: number;
    endBlock: number;
    includeFinal: boolean;
    saveTo: string;
    status: string;
  };
  timeline: {
    fps: number;
    durationSec: number;
    slidingWindowSize: number;
    slidingWindowOverlap: number;
    showWindows: boolean;
    snap: boolean;
    allowPastCap: boolean;
    playhead: number;
    segments: Segment[];
  };
}

export const PIPELINE_CHOICES: { value: Pipeline; label: string }[] = [
  { value: "Hybrid", label: "Hybrid AV — reference images + exact soundtrack" },
  { value: "FL2VA", label: "FL2VA — create or continue a shot" },
  { value: "Ref2VA", label: "Ref2VA — follow reference images / video / audio" },
];

export const SIZE_CHOICES: { value: CheckpointSize; label: string }[] = [
  { value: "Full 33B", label: "Full 33B — best quality" },
  { value: "Pruned 20B", label: "Pruned 20B — smaller / faster" },
];

export const RESOLUTIONS: { group: string; value: string; label: string }[] = [
  { group: "480p", value: "480x832", label: "480×832 (9:16)" },
  { group: "480p", value: "832x480", label: "832×480 (16:9)" },
  { group: "720p", value: "704x1280", label: "704×1280 (9:16)" },
  { group: "720p", value: "720x1280", label: "720×1280 (9:16)" },
  { group: "720p", value: "1280x720", label: "1280×720 (16:9)" },
  { group: "720p", value: "1024x1024", label: "1024×1024 (1:1)" },
  { group: "1080p", value: "1088x1920", label: "1088×1920 (9:16)" },
  { group: "1080p", value: "1920x1088", label: "1920×1088 (16:9)" },
];

export const SAMPLE_SOLVERS = ["Euler", "RES multistep", "Ralston 2S"] as const;
export const CACHE_TYPES = [
  { value: "", label: "None" },
  { value: "spectrum", label: "Spectrum Feature Forecasting" },
  { value: "first_block", label: "First Block Cache" },
] as const;
export const FBC_STRENGTHS = [
  { value: 0.06, label: "Low (0.06)" },
  { value: 0.08, label: "Balanced (0.08)" },
  { value: 0.1, label: "High (0.10)" },
  { value: 0.12, label: "Very High (0.12)" },
  { value: 0.14, label: "Maximum (0.14)" },
] as const;
export const ATTENTION_CHOICES = [
  { value: "", label: "Default Attention Mode" },
  { value: "sol", label: "sol — sparse attention (BF16, Triton 3.6+, RTX 40/50)" },
] as const;
export const TEXT_ENCODER_CHOICES = [
  { value: "", label: "Default (Qwen3-VL BF16)" },
  { value: "bf16", label: "Qwen3-VL BF16" },
  { value: "int8", label: "Qwen3-VL Quanto INT8" },
  { value: "nvfp4_awq", label: "Qwen3-VL NVFP4 AWQ" },
  { value: "gguf_q4_k_m", label: "Qwen3-VL GGUF Q4_K_M" },
  { value: "gguf_q2_k", label: "Qwen3-VL GGUF Q2_K" },
] as const;
export const VIDEO_VAE_CHOICES = [
  { value: "", label: "Original VAE (default)" },
  { value: "fp8mix", label: "FP8 Mixed Precision" },
] as const;
export const PRIORITY_CHOICES = [
  { value: "", label: "Lower VRAM (default)" },
  { value: "lower_ram", label: "Lower RAM" },
] as const;

export const IMAGE_REF_MODES = [
  { value: "I", label: "Reference images (Ref2VA)" },
  { value: "KI", label: "First image sets dimensions" },
  { value: "", label: "Generate without reference images" },
] as const;

export const AUDIO_SOURCES_HYBRID = [
  { value: "A", label: "Soundtrack drives generation" },
  { value: "", label: "Generate audio from prompt" },
  { value: "K", label: "Soundtrack + reference voice" },
] as const;

export const CONTROL_AUDIO_MODES = [
  { value: "mix", label: "Mixed into guidance" },
  { value: "mute", label: "Muted — reference only" },
] as const;

export const FL2VA_GUIDE = [
  { value: "auto", label: "Auto — decide from the timeline" },
  { value: "GV", label: "Use Control Video" },
  { value: "KFI", label: "Inject Frames" },
  { value: "none", label: "Neither — text / keyframes only" },
] as const;

export const VIDEO_COLORS = ["#7f77dd", "#8f88e2", "#6e67c8", "#9a93ea"];
export const CONTROL_COLOR = "#5dcaa5";
export const CLIP_AUDIO_COLOR = "#1d9e75";
export const AUDIO_COLOR = "#ef9f27";
