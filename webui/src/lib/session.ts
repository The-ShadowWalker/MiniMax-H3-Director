import { buildPromptRelay } from "./prompt";
import { chosenAudioMode, defaultGroupWindows, realWindows, spansFromFrames } from "./h3";
import { groupWindowsFor } from "./groups";
import type { SessionPayload } from "./types";

export function downloadJson(payload: SessionPayload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(payload.project_name)}.h3director.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  void stamp;
}

export function safeName(name: string) {
  return (name || "h3_project").replace(/[^\w.-]+/g, "_").slice(0, 80);
}

export async function readSessionFile(file: File): Promise<SessionPayload> {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") throw new Error("Not a session file");
  if (!data.timeline) throw new Error("Missing timeline in session");
  return data as SessionPayload;
}

/** What Python needs to build the real WanGP settings dict.
 *  Media is referenced by mediaId — Python owns the paths, so it resolves them
 *  and strips any flag whose file is missing. Sending paths from here was what
 *  produced "Prompt cannot be empty" style failures: the UI does not know them. */
export function buildGenerationPlan(p: SessionPayload) {
  const fps = p.fps || 24;
  const total = Math.round(p.duration_sec * fps);
  // Hand-set windows when manual mode is on, otherwise the automatic plan.
  const manual = !!p.timeline.manualWindows && !!(p.timeline.windowFrames || []).length;
  const wins = manual
    ? spansFromFrames(p.timeline.windowFrames as number[])
    : realWindows(total, p.timeline.slidingWindowSize, p.timeline.slidingWindowOverlap);
  const { combined, windows } = buildPromptRelay(p, wins);

  const segs = p.timeline.segments || [];
  const onVideo = segs.filter((x) => x.track === "video").sort((a, b) => a.start - b.start);
  const images = onVideo.filter((x) => x.kind === "image" && x.mediaId);
  const first = images[0];
  const last = images.length > 1 ? images[images.length - 1] : undefined;

  const control = segs.find((x) => x.track === "control" && x.mediaId);
  // Per-clip value wins over the global default: the setting belongs to the clip.
  const denoise =
    typeof control?.denoiseStrength === "number" ? control.denoiseStrength
    : typeof p.advanced.denoising_strength === "number" ? p.advanced.denoising_strength
    : 0.75;
  const song = segs.find((x) => x.track === "audio" && x.mediaId && !x.muted);
  const clipAudio = segs.find((x) => x.track === "clipaudio" && x.mediaId && !x.muted);

  return {
    model_type: modelTypeFor(p),
    prompt: combined,
    window_prompts: windows.map((w) => w.prompt),
    multi_prompts_gen_type: "PW",
    video_length: total,
    fps,
    sliding_window_size: p.timeline.slidingWindowSize,
    sliding_window_overlap: p.timeline.slidingWindowOverlap,

    seed: p.advanced.seed,
    repeat_generation: p.advanced.repeat,
    num_inference_steps: p.advanced.pdd ? 8 : p.advanced.steps,
    guidance_phases: p.advanced.pdd ? 1 : p.advanced.guidance_phases,
    sample_solver: p.advanced.pdd ? "euler" : String(p.advanced.sample_solver || p.advanced.solver || "euler"),
    flow_shift: p.advanced.flowshift,
    guidance_scale: p.advanced.guidance,
    switch_threshold: p.advanced.switch_threshold,
    attention_sparsity: p.advanced.attention_sparsity,
    skip_steps_cache_type: p.advanced.cache_type,
    skip_steps_multiplier: p.advanced.cache_mult,
    skip_steps_start_step_perc: p.advanced.cache_start,
    override_attention: p.advanced.override_attention,
    // What the model itself offers (text encoder, video VAE, DiT priority),
    // keyed by the group so Python can put each one in the right slot.
    model_configs: (p.advanced.model_configs || {}) as Record<string, string>,
    resolution: String(p.advanced.resolution).replace("\u00d7", "x"),
    activated_loras: p.advanced.loras,
    lora_weights: p.advanced.lora_weights,
    temporal_upsampling: p.advanced.temporal_upsampling ?? "",
    spatial_upsampling: p.advanced.spatial_upsampling ?? "",
    film_grain_intensity: p.advanced.film_grain_intensity ?? 0,
    film_grain_saturation: p.advanced.film_grain_saturation ?? 0.5,
    self_refiner_setting: p.advanced.self_refiner_setting ?? 0,
    min_frames_if_references: p.advanced.min_frames_if_references ?? 0,
    // How large the reference sheets are rendered into the conditioning.
    // Higher = the sheet asserts itself more strongly.
    image_refs_relative_size: p.advanced.image_refs_relative_size ?? 100,

    // media, BY ID — Python resolves and validates these
    media: {
      ref_images: (p.refs.images || []).map((r) => r.mediaId).filter(Boolean),
      ref_videos: (p.refs.videos || []).map((r) => r.mediaId).filter(Boolean),
      ref_audio: (p.refs.audio || []).map((r) => r.mediaId).filter(Boolean),
      image_start: first?.mediaId,
      image_end: last?.mediaId,
      control_video: control?.mediaId,
      audio_guide: song?.mediaId,
      clip_audio: clipAudio?.mediaId,
    },
    // Injected frames come FIRST in image_refs, so they push every reference
    // sheet's number up. Python rewrites the SENT prompt to match; the stored
    // prompt keeps the numbers you typed. It is a no-op when nothing occupies
    // a slot ahead of the sheets, so it never needed to be a user choice.
    denoising_strength: denoise,
    auto_renumber_refs: true,
    // Only applied when nothing supplies the audio (the model generates it).
    gen_no_music: !!p.advanced.gen_no_music,
    gen_no_speech: !!p.advanced.gen_no_speech,
    gen_no_ambience: !!p.advanced.gen_no_ambience,
    gen_no_effects: !!p.advanced.gen_no_effects,
    // Everything that occupies a numbered slot AHEAD of the reference sheets:
    // the start image, the end image, and any injected frames. Two timeline
    // images used as start+end are why [image 1] had to be written as
    // [image 3] to reach the first sheet.
    injected_count: images.filter((x) => x !== first && x !== last).length,
    numbering_offset:
      (first ? 1 : 0) + (last ? 1 : 0) +
      images.filter((x) => x !== first && x !== last).length,
    // When the windows were set by hand, their lengths ARE the plan: Python
    // writes one /duration tag per window from these instead of working out
    // equal ones.
    manual_windows: manual,
    window_frames: manual ? (p.timeline.windowFrames as number[]) : undefined,
    // Saved reference mods: which ones, how strongly, in apply order. The
    // relay turns this into the custom_settings payload the RefMods plugin
    // reads; it is dropped entirely when nothing is picked.
    refmods: (p.refs.refmods || [])
      .filter((m) => m && m.name && m.strength > 0)
      .map((m) => ({ name: m.name, strength: m.strength })),
    refmod_retention: p.refs.refmodRetention ?? 1,
    // Render in groups of this many sliding windows, one Wan2GP job each.
    group_windows: groupWindowsFor(p),
    release_between_groups: p.timeline.releaseBetweenGroups === true,
    hold_look_between_groups: p.timeline.holdLookBetweenGroups === true,
    // Audio source. Sent ONLY when it was chosen by hand; on Auto the relay
    // derives it from what is attached, which is what it has always done.
    ...(chosenAudioMode(p.audio.source) !== null
      ? { audio_prompt_type: chosenAudioMode(p.audio.source) as string,
          audio_prompt_type_set: true }
      : {}),
    reference_mode: p.pipeline !== "FL2VA",
  };
}

function modelTypeFor(p: SessionPayload) {
  const pruned = p.size === "Pruned 20B";
  const base =
    p.pipeline === "Hybrid" ? "minimax_h3_hybrid"
    : p.pipeline === "Ref2VA" ? "minimax_h3_ref2va"
    : "minimax_h3_fl2va";
  // An explicitly chosen checkpoint IS the model. Pipeline and Size DESCRIBE a
  // checkpoint, they never constrain it — gating here is what made a restored
  // Hybrid session silently load the stock FL2VA base.
  const chosen = String(p.advanced.checkpoint || "").trim();
  if (chosen && chosen.toLowerCase() !== "auto") return chosen;
  return `${base}${pruned ? "_pruned" : ""}${p.advanced.pdd ? "_pdd" : ""}`;
}

/** Kept for the older call sites. */
export function assembleWanSettings(p: SessionPayload) {
  return buildGenerationPlan(p);
}
