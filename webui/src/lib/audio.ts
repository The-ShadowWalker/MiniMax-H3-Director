/** Audio playback via Web Audio.
 *
 * <audio> elements kept failing here: the iframe is a data: URL with an opaque
 * origin, so a src assigned after an await loses the click's user activation
 * and play() is rejected silently - Play looked like it worked and was mute.
 *
 * One AudioContext, created and resumed inside the click handler and reused.
 * Decoded buffers are cached by mediaId (we already decode for the waveform,
 * so the cost is paid once). */
import { getMedia, servedUrl, ensureBytes } from "./media";
import type { Segment } from "./types";

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();
const pendingDecode = new Set<string>();
interface Playing { src: AudioBufferSourceNode; gain: GainNode }
let playing: Playing[] = [];
let active = false;
let startedAtCtx = 0;
let startedAtFrame = 0;

/** Must run inside a real user gesture. Safe to call repeatedly. */
let lastBlockReason = "";
export function audioBlockReason(): string { return lastBlockReason; }

export function unlockAudio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) { lastBlockReason = "This browser has no Web Audio support."; return null; }
      ctx = new Ctx();
    }
    if (ctx.state === "suspended") {
      void ctx.resume().then(() => {
        if (ctx && ctx.state === "suspended") {
          // Almost always the iframe missing allow="autoplay".
          lastBlockReason =
            "The browser is refusing audio in this frame (AudioContext stayed suspended). " +
            "Reload the Wan2GP page; if it persists the iframe is missing allow=\"autoplay\".";
          console.error("[H3-D]", lastBlockReason);
        } else {
          lastBlockReason = "";
        }
      }).catch((e) => {
        lastBlockReason = `AudioContext.resume() rejected: ${String(e)}`;
        console.error("[H3-D]", lastBlockReason);
      });
    } else {
      lastBlockReason = "";
    }
    return ctx;
  } catch (e) {
    lastBlockReason = `AudioContext unavailable: ${String(e)}`;
    console.error("[H3-D]", lastBlockReason);
    return null;
  }
}

export function cacheBuffer(mediaId: string, buf: AudioBuffer): void {
  buffers.set(mediaId, buf);
}

async function bufferFor(mediaId: string): Promise<AudioBuffer | null> {
  const hit = buffers.get(mediaId);
  if (hit) return hit;
  if (pendingDecode.has(mediaId)) return null;
  pendingDecode.add(mediaId);
  try {
    const c = unlockAudio();
    if (!c) return null;
    const info = getMedia(mediaId);
    const url = info?.url || servedUrl(info) || (await ensureBytes(mediaId));
    if (!url) return null;
    const bytes = await (await fetch(url)).arrayBuffer();
    const decoded = await c.decodeAudioData(bytes);
    buffers.set(mediaId, decoded);
    return decoded;
  } catch (e) {
    console.error("[H3-D] could not decode audio", mediaId, e);
    return null;
  } finally {
    pendingDecode.delete(mediaId);
  }
}

function stopNodes() {
  for (const p of playing) {
    try { p.src.stop(); } catch { /* already stopped */ }
    try { p.src.disconnect(); p.gain.disconnect(); } catch { /* ignore */ }
  }
  playing = [];
}

export function stopAudio(): void {
  active = false;
  stopNodes();
}

/** Start from the playhead. Call SYNCHRONOUSLY from the click handler. */
export function startAudio(segments: Segment[], playhead: number, fps: number): void {
  const c = unlockAudio();
  if (!c) return;
  active = true;
  stopNodes();
  startedAtCtx = c.currentTime;
  startedAtFrame = playhead;

  const audible = segments.filter(
    (s) => (s.track === "audio" || s.track === "clipaudio") && !s.muted && s.mediaId,
  );
  if (!audible.length) {
    console.warn("[H3-D] nothing audible on the timeline");
    lastBlockReason = "No unmuted audio segment on the timeline.";
    return;
  }
  lastBlockReason = "";

  for (const seg of audible) {
    void bufferFor(seg.mediaId as string).then((buf) => {
      if (!buf || !active || !ctx) return;
      const segStartSec = seg.start / fps;
      const segEndSec = (seg.start + seg.length) / fps;
      const nowSec = startedAtFrame / fps + (ctx.currentTime - startedAtCtx);
      if (nowSec >= segEndSec) return;

      const when = ctx.currentTime + Math.max(0, segStartSec - nowSec);
      const offset = Math.max(0, nowSec - segStartSec) + (seg.trimStart || 0) / fps;
      if (offset >= buf.duration) return;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = typeof seg.gain === "number" ? Math.max(0, Math.min(1, seg.gain)) : 1;
      src.connect(gain).connect(ctx.destination);
      const dur = Math.min(buf.duration - offset, segEndSec - Math.max(nowSec, segStartSec));
      try {
        src.start(when, offset, Math.max(0.01, dur));
        playing.push({ src, gain });
      } catch (e) {
        console.error("[H3-D] audio start failed", seg.id, e);
      }
    });
  }
}

/** Where the audio clock actually is, in frames. */
export function audioFrame(fps: number): number | null {
  if (!active || !ctx) return null;
  return startedAtFrame + (ctx.currentTime - startedAtCtx) * fps;
}

export function isAudioActive(): boolean { return active; }

export function audioDiagnostics() {
  return {
    context: ctx ? ctx.state : "not created",
    sampleRate: ctx ? ctx.sampleRate : 0,
    decoded: buffers.size,
    voices: playing.length,
  };
}
