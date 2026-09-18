/**
 * H3 Director — iframe <-> Gradio parent bridge.
 *
 * NAMESPACE: every message is tagged h3d2_parent / h3d2_frame.
 * The working MiniMax-H3-Director plugin uses 'wdc_parent'. If both plugins
 * are installed and share a tag, each iframe receives the other's messages and
 * neither logs an error. Do not reuse a tag.
 */

export const PARENT_TAG = "h3d2_parent";
export const FRAME_TAG = "h3d2_frame";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const pending = new Map<string, Pending>();
let seq = 0;

function nextId() {
  seq += 1;
  return `r${seq}_${Date.now().toString(36)}`;
}

export function hasParent(): boolean {
  try {
    return typeof window !== "undefined" && window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

/** Fire-and-forget message to Python. */
export function send(cmd: string, data: Record<string, unknown> = {}): void {
  if (!hasParent()) return;
  try {
    window.parent.postMessage({ source: FRAME_TAG, cmd, data }, "*");
  } catch (e) {
    console.error("[H3-D] send failed", cmd, e);
  }
}

/** Request/response. Rejects on timeout so a dead bridge never hangs the UI. */
export function request<T = unknown>(cmd: string, data: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
  if (!hasParent()) return Promise.reject(new Error("no parent bridge"));
  const id = nextId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge timeout: ${cmd}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      window.parent.postMessage({ source: FRAME_TAG, cmd, data, id }, "*");
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

type Handler = (data: Record<string, unknown>) => void;
const handlers = new Map<string, Set<Handler>>();

export function on(cmd: string, fn: Handler): () => void {
  if (!handlers.has(cmd)) handlers.set(cmd, new Set());
  handlers.get(cmd)!.add(fn);
  return () => handlers.get(cmd)?.delete(fn);
}

export function startBridge(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data;
    // Strict tag check: anything not addressed to THIS plugin is ignored.
    if (!m || typeof m !== "object" || m.source !== PARENT_TAG) return;

    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(String(m.error)));
      else p.resolve(m.data);
      return;
    }
    const set = handlers.get(String(m.cmd || ""));
    if (set) for (const fn of set) { try { fn(m.data || {}); } catch (e) { console.error("[H3-D] handler", e); } }
  });

  // Relay iframe errors into the SAME terminal Python logs to.
  window.addEventListener("error", (e) => {
    send("js_error", { message: String(e.message), src: String(e.filename || ""), line: e.lineno || 0 });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    send("js_error", { message: "unhandled rejection: " + String(e.reason) });
  });

  send("ready", { version: "2.0.0" });
}
