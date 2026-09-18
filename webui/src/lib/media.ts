/** Media ingest: upload once to Python, probe duration, build a thumbnail,
 *  compute waveform peaks. Everything is cached by mediaId so autosave never
 *  recomputes and never re-uploads. */
import { uploadMedia } from "./persist";
import { request, hasParent } from "./bridge";

export interface MediaInfo {
  mediaId: string;
  path?: string;
  servedUrl?: string;
  missing?: boolean;
  name: string;
  url: string;
  kind: "image" | "video" | "audio" | "other";
  durationSec: number;
  width: number;
  height: number;
  thumb: string;
  peaks: number[];
  sampleRate: number;
  channels: number;
}

const cache = new Map<string, MediaInfo>();
export function getMedia(id?: string | null): MediaInfo | undefined {
  return id ? cache.get(id) : undefined;
}
export function allMedia(): MediaInfo[] {
  return Array.from(cache.values());
}

export function kindOf(file: File): MediaInfo["kind"] {
  const t = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (t.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "tiff"].includes(ext)) return "image";
  if (t.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)) return "video";
  if (t.startsWith("audio/") || ["wav", "mp3", "flac", "m4a", "ogg", "aac"].includes(ext)) return "audio";
  return "other";
}

/** MIME type is unreliable — .webp and .avif often arrive with an EMPTY type.
 *  Always fall back to the extension. */
export function acceptAttr(kinds: MediaInfo["kind"][]): string {
  const map: Record<string, string[]> = {
    image: ["image/*", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp", ".gif", ".tiff"],
    video: ["video/*", ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"],
    audio: ["audio/*", ".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"],
    other: [],
  };
  return kinds.flatMap((k) => map[k] || []).join(",");
}

function probeAV(url: string, video: boolean): Promise<{ d: number; w: number; h: number }> {
  return new Promise((resolve) => {
    const el = document.createElement(video ? "video" : "audio") as HTMLVideoElement;
    let done = false;
    const finish = (d: number, w: number, h: number) => {
      if (done) return;
      done = true;
      resolve({ d, w, h });
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(el.duration || 0, el.videoWidth || 0, el.videoHeight || 0);
    el.onerror = () => finish(0, 0, 0);
    setTimeout(() => finish(el.duration || 0, el.videoWidth || 0, el.videoHeight || 0), 8000);
    el.src = url;
  });
}

function imageThumb(url: string): Promise<{ thumb: string; w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const scale = Math.min(1, 96 / Math.max(1, img.height));
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      try { resolve({ thumb: c.toDataURL("image/jpeg", 0.7), w: img.width, h: img.height }); }
      catch { resolve({ thumb: url, w: img.width, h: img.height }); }
    };
    img.onerror = () => resolve({ thumb: "", w: 0, h: 0 });
    img.src = url;
  });
}

function videoThumb(url: string): Promise<string> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let done = false;
    const fail = () => { if (!done) { done = true; resolve(""); } };
    v.preload = "auto";
    v.muted = true;
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.2, (v.duration || 1) / 10); } catch { fail(); } };
    v.onseeked = () => {
      if (done) return;
      done = true;
      const c = document.createElement("canvas");
      const scale = Math.min(1, 96 / Math.max(1, v.videoHeight));
      c.width = Math.max(1, Math.round(v.videoWidth * scale));
      c.height = Math.max(1, Math.round(v.videoHeight * scale));
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL("image/jpeg", 0.7)); } catch { resolve(""); }
    };
    v.onerror = fail;
    setTimeout(fail, 10000);
    v.src = url;
  });
}

/** Peaks for the waveform. Computed ONCE per file and cached — never on autosave. */
let cacheKeyForDecode = "";
async function computePeaks(file: File, buckets = 1600): Promise<{ peaks: number[]; d: number; sr: number; ch: number }> {
  try {
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return { peaks: [], d: 0, sr: 0, ch: 0 };
    const ctx = new Ctx();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    try {
      const { cacheBuffer } = await import("./audio");
      cacheBuffer(cacheKeyForDecode, buf);   // playback reuses this decode
    } catch { /* audio module optional */ }
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    const peaks: number[] = [];
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const s = i * step;
      for (let j = 0; j < step && s + j < ch.length; j += 2) {
        const v = Math.abs(ch[s + j]);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
    }
    const out = { peaks, d: buf.duration, sr: buf.sampleRate, ch: buf.numberOfChannels };
    try { await ctx.close(); } catch { /* ignore */ }
    return out;
  } catch (e) {
    console.error("[H3-D] waveform decode failed", e);
    return { peaks: [], d: 0, sr: 0, ch: 0 };
  }
}

/** The one entry point. Uploads once, derives everything, caches by mediaId. */
export async function registerMedia(file: File): Promise<MediaInfo> {
  const kind = kindOf(file);
  const url = URL.createObjectURL(file);
  const up = await uploadMedia(file);
  const mediaId = up?.mediaId || `local_${file.name}_${file.size}`;

  const hit = cache.get(mediaId);
  if (hit) { URL.revokeObjectURL(url); return hit; }

  const info: MediaInfo = {
    mediaId, name: file.name, url, kind,
    durationSec: 0, width: 0, height: 0, thumb: "", peaks: [], sampleRate: 0, channels: 0,
  };

  if (kind === "image") {
    const t = await imageThumb(url);
    info.thumb = t.thumb; info.width = t.w; info.height = t.h;
  } else if (kind === "video") {
    const [p, t] = await Promise.all([probeAV(url, true), videoThumb(url)]);
    info.durationSec = p.d; info.width = p.w; info.height = p.h; info.thumb = t;
  } else if (kind === "audio") {
    cacheKeyForDecode = mediaId;
    const [p, w] = await Promise.all([probeAV(url, false), computePeaks(file)]);
    info.durationSec = w.d || p.d;
    info.peaks = w.peaks; info.sampleRate = w.sr; info.channels = w.ch;
  }

  info.path = (up as { path?: string })?.path;
  setFileBase((up as { fileBase?: string })?.fileBase || fileBase);
  cache.set(mediaId, info);

  // Persist what we just derived — this is what makes a reload work.
  if (hasParent()) {
    void request("put_media_meta", {
      mediaId, name: info.name, kind: info.kind, durationSec: info.durationSec,
      width: info.width, height: info.height, sampleRate: info.sampleRate,
      channels: info.channels, thumb: info.thumb,
      peaks: info.peaks.map((p) => Math.round(p * 255)),   // 1 byte per bucket
      file: up?.name || info.name,
    }, 30000).catch((e) => console.error("[H3-D] put_media_meta failed", e));
  }
  return info;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00.00";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function fmtBytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}


/* ------------------------------------------------------------------ *
 * Restore across reloads.
 *
 * blob: URLs die with the page and this cache is in memory, so on load
 * NOTHING would resolve. Python keeps a .meta.json beside every media file
 * holding the duration, thumbnail and waveform peaks derived here at upload,
 * so a reload rebuilds the whole cache instantly without re-reading a byte
 * of the media itself.
 * ------------------------------------------------------------------ */

let fileBase = "";

export function setFileBase(base: string) {
  fileBase = base || "";
}

/** A URL the browser can actually load for this media, or "" if we must inline. */
export function servedUrl(info: MediaInfo | undefined): string {
  if (!info) return "";
  if (info.url && info.url.startsWith("blob:")) return info.url;
  if (info.servedUrl) return info.servedUrl;
  if (fileBase && info.path) {
    const origin = (window.location && window.location.origin) || "";
    const base = origin && origin !== "null" ? origin : "";
    info.servedUrl = `${base}${fileBase}${encodeURIComponent(info.path)}`;
    return info.servedUrl;
  }
  return "";
}

/** Rebuild the cache from what Python stored. Called on every project load. */
export function hydrateMedia(
  manifest: Record<string, Partial<MediaInfo> & { peaks?: number[]; thumb?: string }> | undefined,
  base?: string,
  missing?: string[],
): void {
  if (base !== undefined) setFileBase(base);
  if (!manifest) return;
  for (const [id, m] of Object.entries(manifest)) {
    const prev = cache.get(id);
    const info: MediaInfo = {
      mediaId: id,
      name: m.name || prev?.name || id,
      url: prev?.url || "",
      path: m.path || prev?.path,
      kind: (m.kind as MediaInfo["kind"]) || prev?.kind || "other",
      durationSec: m.durationSec ?? prev?.durationSec ?? 0,
      width: m.width ?? prev?.width ?? 0,
      height: m.height ?? prev?.height ?? 0,
      thumb: m.thumb || prev?.thumb || "",
      peaks: (m.peaks && m.peaks.length
        ? (Math.max(...m.peaks) > 1 ? m.peaks.map((v) => v / 255) : m.peaks)
        : prev?.peaks) || [],
      sampleRate: m.sampleRate ?? prev?.sampleRate ?? 0,
      channels: m.channels ?? prev?.channels ?? 0,
    };
    cache.set(id, info);
  }
  for (const id of missing || []) {
    const prev = cache.get(id);
    cache.set(id, {
      mediaId: id, name: prev?.name || id, url: "", kind: prev?.kind || "other",
      durationSec: 0, width: 0, height: 0, thumb: "", peaks: [], sampleRate: 0, channels: 0,
      missing: true,
    });
  }
  console.log(`[H3-D] media cache restored: ${Object.keys(manifest).length} items, ${(missing || []).length} missing`);
}

/** Full bytes, fetched only when something actually needs to play or display
 *  at full size. Cached as a blob URL so a second open is instant. */
export async function ensureBytes(id: string): Promise<string> {
  const info = cache.get(id);
  if (!info || info.missing) return "";
  if (info.url) return info.url;
  const served = servedUrl(info);
  if (served) return served;
  if (!hasParent()) return "";
  try {
    const r = await request<{ b64: string; name: string }>("media_bytes", { mediaId: id }, 180000);
    if (!r?.b64) return "";
    const bin = atob(r.b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr]));
    info.url = url;
    return url;
  } catch (e) {
    console.error("[H3-D] media_bytes failed", id, e);
    return "";
  }
}
