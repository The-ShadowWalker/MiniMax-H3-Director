/**
 * JSON-only incremental persistence.
 *
 * An edit does NOT write. It marks dirty. A debounced flusher writes
 * project.json and nothing else. Media is written once, when it arrives,
 * by a separate path (uploadMedia) — never again on autosave.
 */
import { hasParent, request, send } from "./bridge";

const LS_FALLBACK = "h3d2:project";
const IDLE_MS = 750;
const MAX_MS = 30000;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastFlush = Date.now();
let getPayload: (() => unknown) | null = null;
let onSaved: ((ok: boolean, err?: string, info?: number) => void) | null = null;

export function configurePersist(fn: () => unknown, saved?: (ok: boolean, err?: string, info?: number) => void) {
  getPayload = fn;
  onSaved = saved || null;
}

async function writeNow(): Promise<boolean> {
  if (!getPayload) return false;
  const payload = getPayload();
  lastFlush = Date.now();
  if (timer) { clearTimeout(timer); timer = null; }
  if (!hasParent()) {
    try { localStorage.setItem(LS_FALLBACK, JSON.stringify(payload)); onSaved?.(true); return true; }
    catch (e) { onSaved?.(false, String(e)); return false; }
  }
  try {
    const r = await request<{ ok: boolean; bytes?: number }>("save_project_json", { payload });
    onSaved?.(true, undefined, r?.bytes);
    return true;
  } catch (e) {
    // Never silently swallow a failed save — the user must know.
    console.error("[H3-D] autosave failed", e);
    onSaved?.(false, String(e));
    return false;
  }
}

/** Called by every edit. Cheap: schedules, does not write. */
export function markDirty(): void {
  if (Date.now() - lastFlush >= MAX_MS) { void writeNow(); return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void writeNow(); }, IDLE_MS);
}

/** Hard boundaries: before generate, before export, on blur, on unload. */
export function flushNow(): Promise<boolean> {
  return writeNow();
}

export async function loadProject<T = unknown>(): Promise<T | null> {
  if (!hasParent()) {
    try { const raw = localStorage.getItem(LS_FALLBACK); return raw ? (JSON.parse(raw) as T) : null; }
    catch { return null; }
  }
  try {
    const res = (await request<{
      payload?: T;
      media?: Record<string, never>;
      missing?: string[];
      fileBase?: string;
    }>("load_project_json")) || {};
    // Rebuild the media cache BEFORE the payload is applied, so thumbnails,
    // waveforms and durations are already there when the timeline first draws.
    const { hydrateMedia } = await import("./media");
    hydrateMedia(res.media, res.fileBase, res.missing);
    if (res.missing?.length) {
      console.warn("[H3-D] media missing on disk:", res.missing.join(", "));
      lastMissing = res.missing;
    } else {
      lastMissing = [];
    }
    return (res.payload as T) ?? null;
  } catch (e) {
    console.error("[H3-D] load failed", e);
    return null;
  }
}

let lastMissing: string[] = [];
export function missingMedia(): string[] { return lastMissing; }

export function installFlushBoundaries(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeunload", () => { void writeNow(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) void writeNow(); });
  window.addEventListener("blur", () => { void writeNow(); });
}

/** Media is copied ONCE, on arrival.
 *
 *  The bytes go through Gradio's OWN upload endpoint, exactly as the working
 *  plugin does it. Pushing a video through the bridge textbox as base64 means a
 *  24 MB clip becomes a 32 MB form value, which Gradio rejects with a size
 *  error that reads as though the file is at fault. Base64 stays only as a
 *  fallback for small files when the endpoint is unavailable.
 */
export async function uploadMedia(file: File): Promise<{ mediaId: string; name: string; path?: string; fileBase?: string } | null> {
  if (!hasParent()) return null;

  // 1. Gradio's upload endpoint - returns a server-side path.
  try {
    const fd = new FormData();
    fd.append("files", file, file.name);
    const origin = (window.location && window.location.origin) || "";
    const base = origin && origin !== "null" ? origin : "";
    for (const ep of ["/gradio_api/upload", "/upload"]) {      // Gradio 5, then 4
      try {
        const res = await fetch(base + ep, { method: "POST", body: fd });
        if (!res.ok) continue;
        const paths = await res.json();
        const serverPath = Array.isArray(paths) ? paths[0] : paths;
        if (serverPath) {
          return await request<{ mediaId: string; name: string; path?: string; fileBase?: string }>(
            "adopt_media", { name: file.name, path: String(serverPath) }, 600000);
        }
      } catch (e) {
        console.warn("[H3-D] upload via", ep, "failed", e);
      }
    }
  } catch (e) {
    console.warn("[H3-D] upload endpoint unavailable", e);
  }

  // 2. Fallback: inline the bytes. Only sane for small files.
  const MAX_INLINE = 12 * 1024 * 1024;
  if (file.size > MAX_INLINE) {
    throw new Error(
      `${(file.size / 1048576).toFixed(1)} MB is too large to send inline and Gradio's upload ` +
      `endpoint did not respond. Reload the Wan2GP page and try again.`);
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const CH = 0x2000;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CH) {
      const end = Math.min(i + CH, bytes.length);
      let chunk = "";
      for (let j = i; j < end; j++) chunk += String.fromCharCode(bytes[j]);
      parts.push(chunk);
    }
    return await request<{ mediaId: string; name: string; path?: string; fileBase?: string }>(
      "upload_media", { name: file.name, b64: btoa(parts.join("")) }, 600000);
  } catch (e) {
    console.error("[H3-D] inline upload failed", file.name, e);
    throw e;
  }
}
