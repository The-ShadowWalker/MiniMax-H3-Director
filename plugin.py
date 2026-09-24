"""
H3 Director — React UI hosted inside Gradio, loading with Wan2GP.

NAMESPACE: everything here is h3d2 / H3D2. It is designed to be installed
ALONGSIDE the working MiniMax-H3-Director plugin without collision. See
namespace-separation-checklist.md. Do not reuse 'wdc_parent', '[H3]', or the
h3d- elem_id prefix.

PERSISTENCE: autosave writes project.json and NOTHING else. Media is copied
once, on arrival. The zip is built only on an explicit Save Project.
"""

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

try:
    from . import refmods
except ImportError:  # loaded flat (tests, and older plugin loaders)
    import refmods

PLUGIN_VERSION = "1.5.7"
PLUGIN_ID = "h3_director2"
PLUGIN_NAME = "H3 Director"
LOG_PREFIX = "[H3-D]"

PLUGIN_DIR = Path(__file__).resolve().parent
ASSETS_DIR = PLUGIN_DIR / "assets"
WORKSPACE = PLUGIN_DIR / "workspace"
MEDIA_DIR = WORKSPACE / "media"
# Working files the plugin DERIVES: continuation tails, per-group audio slices,
# bridge edge frames, mixed guidance audio. They were being written into
# media/, which meant every one of them was saved into the project zip, came
# back out of it on open, and piled up run after run -- none of it content the
# project actually owns. They live here instead: never zipped, wiped with the
# project, and cleared at the start of every generation.
DERIVED_DIR = WORKSPACE / "derived"
PROJECT_JSON = WORKSPACE / "project.json"
PROJECT_BAK = WORKSPACE / "project.json.bak"

IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif", ".gif", ".tiff"]
VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]
AUDIO_EXTS = [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"]



def _tc(seconds, fps=24.0):
    """HH:MM:SS:FF timecode."""
    total = max(0.0, float(seconds))
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    sec = int(total % 60)
    fr = int(round((total - int(total)) * fps))
    if fr >= int(round(fps)):
        fr = int(round(fps)) - 1
    return "%02d:%02d:%02d:%02d" % (h, m, sec, fr)


def _rpp_src(path):
    ext = path.suffix.lower()
    if ext == ".wav":
        return "WAVE"
    if ext == ".mp3":
        return "MP3"
    if ext in (".flac",):
        return "FLAC"
    if ext in (".ogg", ".opus"):
        return "VORBIS"
    return "WAVE"


# --------------------------------------------------------------------------
# logging — terminal, AND a file that survives a crash
# --------------------------------------------------------------------------
# This used to be terminal-only on purpose: no stray log files. That rule cost
# the one thing worth having when a machine reboots mid-render -- the console
# goes with it and there is nothing left to read. Every line is flushed as it
# is written, so the file ends at whatever the plugin was doing in the instant
# the machine went down. The previous run is kept alongside it.
LOG_FILE = WORKSPACE / "h3-director.log"
LOG_FILE_PREV = WORKSPACE / "h3-director.prev.log"


class _FlushingFileHandler(logging.FileHandler):
    """Flush and fsync every record.

    A buffered handler loses the last few KB on a hard reset -- which is
    exactly the part that says what was happening when it died.
    """

    def emit(self, record):
        super().emit(record)
        try:
            self.flush()
            os.fsync(self.stream.fileno())
        except Exception:
            pass


log = logging.getLogger("h3_director2")
if not log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter(LOG_PREFIX + " %(asctime)s %(levelname).1s %(message)s", "%H:%M:%S"))
    log.addHandler(_h)
    try:
        WORKSPACE.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists():
            try:
                if LOG_FILE_PREV.exists():
                    LOG_FILE_PREV.unlink()
                LOG_FILE.replace(LOG_FILE_PREV)
            except Exception:
                pass
        _f = _FlushingFileHandler(str(LOG_FILE), mode="a", encoding="utf-8")
        _f.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname).1s %(message)s", "%Y-%m-%d %H:%M:%S"))
        log.addHandler(_f)
    except Exception as _exc:          # a read-only workspace must not stop the plugin
        print(LOG_PREFIX + " could not open the crash log (%s); terminal only" % _exc)
    log.setLevel(logging.INFO)
    log.propagate = False


def trace(msg):
    try:
        log.info(msg)
    except Exception:
        pass


# --------------------------------------------------------------------------
# atomic JSON write — never a half-written project
# --------------------------------------------------------------------------
def _atomic_write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        fh.flush()
        os.fsync(fh.fileno())
    # Only project.json gets a rollback copy. Writing "<x>.bak" beside every
    # JSON littered the media folder with files that then looked like media.
    if path == PROJECT_JSON and path.exists():
        try:
            shutil.copy2(path, PROJECT_BAK)
        except Exception as exc:
            trace("bak copy failed: %s" % exc)
    os.replace(tmp, path)


def _safe_ext(name: str, default: str = ".bin") -> str:
    ext = os.path.splitext(name or "")[1].lower()
    if ext and len(ext) <= 6 and all(c.isalnum() or c == "." for c in ext):
        return ext
    return default


# --------------------------------------------------------------------------
# the H3 window grid — DERIVED from Wan2GP's model_def, never hardcoded
# --------------------------------------------------------------------------
_GRID_FALLBACK = {
    "WINDOW_OFFSET": 5, "WINDOW_STEP": 17, "WINDOW_MIN": 124, "WINDOW_MAX": 481,
    # smallest legal GENERATED frame count (model_def.frames_minimum) -- not
    # WINDOW_MIN, which is the smallest sliding-window SIZE the UI offers
    "FRAMES_MIN": 107,
    "WINDOW_DEFAULT": 362, "OVERLAP_OFFSET": 1, "OVERLAP_STEP": 17,
    "OVERLAP_MIN": 1, "OVERLAP_MAX": 120, "OVERLAP_DEFAULT": 18,
    "FPS": 24, "MAX_REF_IMAGES": 9, "MAX_REF_VIDEOS": 3, "MAX_REF_AUDIO": 3,
}


def derive_h3_grid(model_def: dict | None) -> dict:
    """Read the grid out of the model definition. Falls back only if absent."""
    grid = dict(_GRID_FALLBACK)
    if not isinstance(model_def, dict):
        trace("grid: no model_def, using fallback literals")
        return grid
    try:
        if "frames_minimum" in model_def:
            grid["FRAMES_MIN"] = int(model_def["frames_minimum"])
            grid["WINDOW_MIN"] = int(model_def["frames_minimum"])
        if "frames_steps" in model_def:
            grid["WINDOW_STEP"] = int(model_def["frames_steps"])
        if "frames_offset" in model_def:
            grid["WINDOW_OFFSET"] = int(model_def["frames_offset"])
        for src, dst in (
            ("overlap_min", "OVERLAP_MIN"), ("overlap_max", "OVERLAP_MAX"),
            ("overlap_step", "OVERLAP_STEP"), ("overlap_offset", "OVERLAP_OFFSET"),
            ("overlap_default", "OVERLAP_DEFAULT"),
        ):
            if src in model_def:
                grid[dst] = int(model_def[src])
        trace("grid derived from model_def: win_min=%s step=%s ovl=%s..%s/%s"
              % (grid["WINDOW_MIN"], grid["WINDOW_STEP"], grid["OVERLAP_MIN"],
                 grid["OVERLAP_MAX"], grid["OVERLAP_STEP"]))
    except Exception as exc:
        trace("grid derive failed (%s); using fallback" % exc)
    return grid


# --------------------------------------------------------------------------
# window arithmetic — mirrors the plugin's v1.17.0 _compensate_request
# --------------------------------------------------------------------------
def assembled_length(request_frames: int, win: int, ovl: int) -> int:
    if win <= ovl:
        return request_frames
    stride = win - ovl
    windows = max(1, -(-max(1, request_frames - win) // stride) + 1 if request_frames > win else 1)
    return request_frames + (windows - 1) * ovl


def compensate_request(target: int, win: int, ovl: int) -> int:
    """Find the request whose ASSEMBLED output equals target exactly.
    The user's win/ovl are never altered — only the internal request.

    ONLY the bridge/continuation path still uses this. For a normal
    generation it was wrong: see solve_video_length() below.
    """
    if target <= win:
        return target
    stride = max(1, win - ovl)
    best = target
    for windows in range(1, 512):
        req = target - (windows - 1) * ovl
        if req <= 0:
            break
        got_windows = 1 if req <= win else (-(-(req - win) // stride) + 1)
        if got_windows == windows and assembled_length(req, win, ovl) == target:
            best = req
            break
    return best


# --------------------------------------------------------------------------
# real output length — asks WanGP's own scheduler instead of guessing
# --------------------------------------------------------------------------
# A normal generation does NOT re-add the overlap at every join. WanGP's
# build_default_window_plan() treats video_length as the FINAL OUTPUT length
# and shares it out over the windows: window 1 outputs `window_size`, every
# later window outputs `window_size - overlap`, and the tail window takes the
# remainder. So video_length already IS the output length.
#
# compensate_request() assumed the opposite and shaved (windows - 1) * overlap
# off every request. On a 3-window 24fps job that is 36 frames -- 1.5s -- of
# video that never got generated, which is why a song ran past the end of the
# picture and got cut off. The tail window then rounds to the nearest legal
# frame count on top of that, losing up to another 8 frames.
#
# Rather than model any of this ourselves again, ask WanGP. The plugin runs
# inside WanGP, so its scheduler is importable; the mirror below is only for
# when it is not (guards, or a Wan2GP without this module).
def _wgp_window_plan():
    try:
        from shared.utils.frame_scheduler import build_default_window_plan
        return build_default_window_plan
    except Exception:
        return None


def _mirror_norm_up(n, minimum, step, offset):
    n = max(minimum, n)
    step = max(1, step)
    offset = max(0, offset)
    return -(-max(0, n - offset) // step) * step + offset if step > 1 else n


def _mirror_norm_nearest(n, minimum, step, offset):
    n = max(minimum, n)
    step = max(1, step)
    if step <= 1:
        return n
    offset = max(0, offset)
    lower = ((n - offset) // step) * step + offset
    if lower < minimum:
        lower = _mirror_norm_up(minimum, minimum, step, offset)
    upper = _mirror_norm_up(n, minimum, step, offset)
    return lower if n - lower <= upper - n else upper


def _mirror_floor_overlap(n, step, offset):
    n = max(0, int(n))
    if n == 0:
        return 0
    step = max(1, int(step))
    offset = max(0, int(offset))
    if offset == 0:
        return n // step * step
    return 0 if n < offset else (n - offset) // step * step + offset


def _mirror_window_plan(*, total_frames, window_size, default_overlap, discard_last_frames,
                        minimum, step, frame_offset=1, overlap_offset=1, max_overlap=None,
                        first_window_overlap=0, first_window_available_overlap=None,
                        initial_shared_frames=0, **_ignored):
    """Faithful stand-in for WanGP's build_default_window_plan (nearest policy)."""
    def geometry(output_frames, overlap_frames, discard):
        output_frames = max(1, int(output_frames))
        overlap_frames = max(0, int(overlap_frames))
        if overlap_frames == 0:
            overlaps = [0]
        else:
            limit = overlap_frames if max_overlap is None else max(overlap_frames, int(max_overlap))
            limit = _mirror_floor_overlap(limit, step, overlap_offset)
            preferred = _mirror_floor_overlap(min(overlap_frames, limit), step, overlap_offset)
            overlaps = list(range(preferred, limit + 1, max(1, int(step)))) if preferred > 0 else [0]
        best = None
        for ovl in overlaps:
            frame_num = _mirror_norm_nearest(output_frames + ovl + discard, minimum, step, frame_offset)
            if frame_num <= ovl + discard:
                frame_num = _mirror_norm_up(ovl + discard + 1, minimum, step, frame_offset)
            adjusted = frame_num - ovl - discard
            score = (abs(adjusted - output_frames), abs(ovl - overlap_frames), frame_num)
            if best is None or score < best[0]:
                best = (score, adjusted, ovl)
        return best[1]

    total_frames = max(1, int(total_frames))
    window_size = _mirror_norm_up(window_size, minimum, step, frame_offset)
    first_overlap = max(0, int(first_window_overlap))
    if first_window_available_overlap is not None:
        first_overlap = min(first_overlap, max(0, int(first_window_available_overlap)))
    first_overlap = _mirror_floor_overlap(first_overlap, step, overlap_offset)
    total_frames = max(1, total_frames - min(max(0, int(initial_shared_frames)), first_overlap))
    capacity = max(1, window_size - first_overlap)
    sliding = total_frames > capacity
    first_discard = max(0, int(discard_last_frames)) if sliding else 0
    first_output = min(total_frames, max(1, capacity - first_discard))
    outputs = [geometry(first_output, first_overlap, first_discard)]
    requested = first_output
    while requested < total_frames:
        chunk = min(total_frames - requested, max(1, window_size - default_overlap - discard_last_frames))
        outputs.append(geometry(chunk, default_overlap, discard_last_frames))
        requested += chunk
    return [{"output_frames": n} for n in outputs]


def _real_plan_windows(video_length: int, win: int, ovl: int, grid: dict) -> list:
    """The window list WanGP will ACTUALLY build for this video_length."""
    kw = dict(
        total_frames=int(video_length), window_size=int(win), default_overlap=int(ovl),
        discard_last_frames=0,
        minimum=int(grid.get("FRAMES_MIN", grid.get("WINDOW_MIN", 107))),
        step=int(grid.get("WINDOW_STEP", 17)),
        frame_offset=int(grid.get("WINDOW_OFFSET", 5)),
        overlap_offset=int(grid.get("OVERLAP_OFFSET", 1)),
        max_overlap=grid.get("OVERLAP_MAX"),
        first_window_overlap=0, first_window_available_overlap=None,
        initial_shared_frames=0,
    )
    plan = _wgp_window_plan()
    if plan is not None:
        try:
            return list(plan(**kw))
        except Exception:
            pass
    return list(_mirror_window_plan(**kw))


def real_output_frames(video_length: int, win: int, ovl: int, grid: dict) -> int:
    """How many frames WanGP will ACTUALLY produce for this video_length."""
    return sum(w["output_frames"] for w in _real_plan_windows(video_length, win, ovl, grid))


# --------------------------------------------------------------------------
# the SCHEDULER path: per-window [/duration=] tags
# --------------------------------------------------------------------------
# When every prompt block carries a /duration tag, WanGP ignores the default
# window plan entirely (wgp.py: default_requested_frames_to_generate =
# frame_scheduler["predicted_total_frames"]) and gives each window exactly the
# duration it declares, with the overlap added ON TOP of it. That is why the
# original plugin got three 15s windows out of a 45s timeline: a window that
# declares 362 frames OUTPUTS 362 new frames and runs a 380-frame pass.
#
# The default plan behaves differently -- window 2 onward output only
# `window - overlap` (14.33s), because there the overlap is taken OUT of the
# window rather than added to it. Mixing the two models is what produced a
# 4-window plan with a 21-frame runt for a job that is genuinely 3 windows.
def _scheduler_outputs(durations, win: int, ovl: int, grid: dict) -> list:
    """Output frames per window when each window declares its own duration."""
    minimum = int(grid.get("FRAMES_MIN", grid.get("WINDOW_MIN", 107)))
    step = int(grid.get("WINDOW_STEP", 17))
    offset = int(grid.get("WINDOW_OFFSET", 5))
    overlap_offset = int(grid.get("OVERLAP_OFFSET", 1))
    max_overlap = grid.get("OVERLAP_MAX")

    def geometry(output_frames, overlap_frames):
        output_frames = max(1, int(output_frames))
        overlap_frames = max(0, int(overlap_frames))
        if overlap_frames == 0:
            overlaps = [0]
        else:
            limit = overlap_frames if max_overlap is None else max(overlap_frames, int(max_overlap))
            limit = _mirror_floor_overlap(limit, step, overlap_offset)
            preferred = _mirror_floor_overlap(min(overlap_frames, limit), step, overlap_offset)
            overlaps = list(range(preferred, limit + 1, max(1, step))) if preferred > 0 else [0]
        best = None
        for o in overlaps:
            frame_num = _mirror_norm_nearest(output_frames + o, minimum, step, offset)
            if frame_num <= o:
                frame_num = _mirror_norm_up(o + 1, minimum, step, offset)
            adjusted = frame_num - o
            score = (abs(adjusted - output_frames), abs(o - overlap_frames), frame_num)
            if best is None or score < best[0]:
                best = (score, adjusted)
        return best[1]

    return [geometry(d, 0 if i == 0 else ovl) for i, d in enumerate(durations)]


def plan_duration_frames(target: int, win: int, ovl: int, grid: dict):
    """Per-window durations whose REAL outputs cover `target`.

    Every window but the last declares a full `win`; the last declares only
    what is still needed. Returns (durations, outputs) -- the smallest number
    of windows that covers the timeline, so there is no runt tail.
    """
    target = max(1, int(target))
    win = max(2, int(win))
    for n in range(1, 129):
        base = [win] * (n - 1)
        for d in range(1, win + 1):
            durations = base + [d]
            outputs = _scheduler_outputs(durations, win, ovl, grid)
            if sum(outputs) >= target:
                return durations, outputs
    return [win], _scheduler_outputs([win], win, ovl, grid)


def scheduler_window_count(target: int, win: int, ovl: int, grid: dict) -> int:
    """How many /duration windows a timeline of `target` frames needs."""
    return max(1, len(plan_duration_frames(target, win, ovl, grid)[0]))


def real_window_count(video_length: int, win: int, ovl: int, grid: dict) -> int:
    """How many sliding windows WanGP will ACTUALLY run -- what progress shows."""
    return max(1, len(_real_plan_windows(video_length, win, ovl, grid)))


def solve_video_length(target: int, win: int, ovl: int, grid: dict) -> int:
    """Smallest video_length whose REAL output covers `target` frames.

    Covering rather than merely approaching matters: an undershoot cuts the
    end off a soundtrack, which is exactly the bug this replaced. The
    overshoot is at most a few frames.
    """
    target = int(target)
    if target <= 0:
        return target
    step = max(1, int(grid.get("WINDOW_STEP", 17)))
    lo = max(1, target - 3 * step)
    best = None
    for vl in range(lo, target + 3 * step + 1):
        out = real_output_frames(vl, win, ovl, grid)
        if out >= target and (best is None or out < best[1]):
            best = (vl, out)
            if out == target:
                break
    if best is not None:
        return best[0]
    # Nothing in range covered the target (very unusual) -- never return
    # something SHORTER than the caller asked for.
    return target


# --------------------------------------------------------------------------
# the bridge JS installed in the PARENT page
# --------------------------------------------------------------------------
_BRIDGE_JS = r"""
console.log("[H3-D] bridge injected");
window.H3D2 = window.H3D2 || {};
window.H3D2.PARENT_TAG = "h3d2_parent";
window.H3D2.FRAME_TAG  = "h3d2_frame";

function h3d2Root() {
  if (window.gradioApp) return window.gradioApp();
  const app = document.querySelector("gradio-app");
  return app ? (app.shadowRoot || app) : document;
}

function h3d2Frame() {
  const f = document.querySelector("#h3d2-frame") || h3d2Root().querySelector("#h3d2-frame");
  return f && f.contentWindow ? f.contentWindow : null;
}

window.H3D2.toFrame = function (msg) {
  const w = h3d2Frame();
  if (!w) { return; }
  try { w.postMessage(Object.assign({ source: window.H3D2.PARENT_TAG }, msg), "*"); } catch (e) {}
};

/* Write into a hidden Gradio Textbox.
   Gradio is Svelte: assigning el.value directly does NOT register. The value
   must go through the NATIVE prototype setter, and BOTH input and change must
   be dispatched, or the component keeps its old value and the handler that
   runs next reads stale/empty data. */
function h3d2Set(elemId, value) {
  const root = h3d2Root();
  const el = root.querySelector(
    "#" + elemId + " textarea, #" + elemId + " input[type='text'], #" + elemId + " input:not([type='hidden'])"
  );
  if (!el) { console.warn("[H3-D] element not found:", elemId); return false; }
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter && setter.call(el, value);
  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function h3d2ClickTrigger(elemId) {
  const root = h3d2Root();
  const btn = root.querySelector("#" + elemId + " button") || root.querySelector("#" + elemId);
  if (!btn) { console.error("[H3-D] trigger not found:", elemId); return false; }
  btn.click();
  return true;
}

/* Set the payload, give Svelte time to propagate it, THEN click.
   Clicking on the same tick sends the PREVIOUS value. */
function h3d2Dispatch(boxId, triggerId, payload, delay) {
  if (!h3d2Set(boxId, JSON.stringify(payload))) {
    window.H3D2.toFrame({ cmd: "bridge_error", data: { message: "control " + boxId + " missing" } });
    return;
  }
  setTimeout(function () {
    if (!h3d2ClickTrigger(triggerId)) {
      window.H3D2.toFrame({ cmd: "bridge_error", data: { message: "trigger " + triggerId + " missing" } });
    }
  }, delay || 250);
}

window.H3D2.pump    = function (p) { h3d2Dispatch("h3d2-req",    "h3d2-go",    p, 120); };
window.H3D2.pumpGen   = function (p) { h3d2Dispatch("h3d2-genreq",   "h3d2-gengo",   p, 300); };
window.H3D2.pumpApply = function (p) { h3d2Dispatch("h3d2-applyreq", "h3d2-applygo", p, 300); };

window.addEventListener("message", function (ev) {
  const m = ev.data;
  if (!m || typeof m !== "object" || m.source !== window.H3D2.FRAME_TAG) { return; }
  if (m.cmd === "generate") { window.H3D2.pumpGen({ cmd: "generate", data: m.data || {} }); return; }
  if (m.cmd === "apply") { window.H3D2.pumpApply({ cmd: "apply", data: m.data || {} }); return; }
  if (m.cmd === "sfx") { h3d2Dispatch("h3d2-sfxreq", "h3d2-sfxgo", { cmd: "sfx", data: m.data || {} }, 300); return; }
  if (m.cmd === "bridgerun") { h3d2Dispatch("h3d2-brreq", "h3d2-brgo", { cmd: "bridgerun", data: m.data || {} }, 300); return; }
  window.H3D2.pump({ cmd: m.cmd, data: m.data || {}, id: m.id || null });
});

function h3d2Watch(elemId, label) {
  const box = h3d2Root().querySelector("#" + elemId + " textarea, #" + elemId + " input");
  if (!box) { setTimeout(function () { h3d2Watch(elemId, label); }, 400); return; }
  let last = "";
  setInterval(function () {
    const v = box.value || "";
    if (v && v !== last) {
      last = v;
      try { window.H3D2.toFrame(JSON.parse(v)); } catch (e) { console.error("[H3-D] bad " + label + " frame", e); }
    }
  }, 120);
}
h3d2Watch("h3d2-resp", "resp");
h3d2Watch("h3d2-genout", "gen");
h3d2Watch("h3d2-applyout", "apply");
h3d2Watch("h3d2-sfxout", "sfx");
h3d2Watch("h3d2-brout", "bridgerun");

/* If the UI never boots, say so in the page instead of leaving a blank panel.
   The iframe sends "ready" as soon as its script runs. */
window.H3D2.booted = false;
window.addEventListener("message", function (ev) {
  const m = ev.data;
  if (m && typeof m === "object" && m.source === window.H3D2.FRAME_TAG && m.cmd === "ready") {
    window.H3D2.booted = true;
    console.log("[H3-D] UI booted");
  }
});
setTimeout(function () {
  if (window.H3D2.booted) { return; }
  const host = document.querySelector("#h3d2-host") || h3d2Root().querySelector("#h3d2-host");
  if (!host) { return; }
  const f = document.querySelector("#h3d2-frame");
  const src = f ? String(f.getAttribute("src") || "").slice(0, 60) : "(no iframe)";
  const note = document.createElement("div");
  note.style.cssText = "padding:14px;margin:8px 0;border:1px solid #d9a441;border-radius:6px;" +
    "background:#2e2510;color:#e8eaed;font:12px/1.6 ui-monospace,monospace";
  note.innerHTML = "<b>H3 Director: the UI did not start.</b><br>" +
    "iframe src begins: " + src + "<br>" +
    "Open the browser console (F12) - the first error there says why. " +
    "Common causes: assets/index.html missing or truncated, or the page blocking the frame.";
  host.appendChild(note);
  console.error("[H3-D] UI did not boot within 8s");
}, 8000);

/* Report which controls resolved, so a missing one is visible immediately. */
setTimeout(function () {
  const root = h3d2Root();
  const ids = ["h3d2-req", "h3d2-go", "h3d2-genreq", "h3d2-gengo", "h3d2-genout", "h3d2-resp",
               "h3d2-applyreq", "h3d2-applygo", "h3d2-applyout"];
  const found = ids.filter(function (i) { return !!root.querySelector("#" + i); });
  console.log("[H3-D] bridge controls " + found.length + "/" + ids.length + " resolved:", found.join(", "));
  window.H3D2.toFrame({ cmd: "bridge_ready", data: { found: found, expected: ids } });
}, 1500);
"""


# --------------------------------------------------------------------------
class H3Director2Plugin(WAN2GPPlugin):
    """React UI in an iframe; Python owns files and generation."""

    def __init__(self):
        super().__init__()
        self.name = PLUGIN_NAME
        self.version = PLUGIN_VERSION
        self.description = "Timeline director for MiniMax H3 with a React UI."
        self._grid = dict(_GRID_FALLBACK)
        self._job = None
        self._events = []
        self._files = []
        self._status = "idle"
        self._progress = 0.0
        self._window = 0
        self._windows = 0
        self._served = None
        self._caps_cache = None
        self._stream_owner = None
        self._jobstate = None
        self._apply_refresh = None
        self._apply_status = ""
        WORKSPACE.mkdir(parents=True, exist_ok=True)
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        DERIVED_DIR.mkdir(parents=True, exist_ok=True)
        try:
            self._sweep_sidecar_strays()
        except Exception as exc:
            trace("sidecar sweep: %s" % exc)

    # ---------------- Wan2GP entry point ----------------
    def setup_ui(self):
        self.request_component("state")
        self.request_component("main_tabs")
        self.request_component("refresh_form_trigger")
        self.request_component("model_choice_target")
        self.request_global("get_model_def")
        self.request_global("get_model_defs")
        self.request_global("get_model_name")
        self.request_global("get_base_model_type")
        self.request_global("get_current_model_settings")
        self.request_global("switch_to_model")
        self.request_global("load_settings_from_file")
        self.request_global("goto_media_tab")
        self.add_custom_js(_BRIDGE_JS)
        self.add_tab(tab_id=PLUGIN_ID, label=PLUGIN_NAME, component_constructor=self._build_ui)
        trace("setup_ui: tab '%s' registered (v%s)" % (PLUGIN_NAME, PLUGIN_VERSION))
        # What this machine is, once per run, at the top of the crash log.
        try:
            import platform
            import subprocess
            trace("machine: %s | python %s" % (platform.platform(), platform.python_version()))
            gpu = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total,driver_version,power.limit",
                 "--format=csv,noheader"],
                capture_output=True, text=True, timeout=5)
            for g in (gpu.stdout or "").strip().splitlines():
                trace("gpu: %s" % g.strip())
        except Exception:
            pass
        trace("crash log: %s (the previous run is kept as %s)"
              % (LOG_FILE, LOG_FILE_PREV.name))

    def _build_ui(self, api_session):
        """One positional param => Wan2GP builds self._wangp_session and calls
        this inside plugin_ui_context(), so every click here is wrapped and the
        queue pumps. Do not remove the parameter."""
        trace("_build_ui  workspace=%s" % WORKSPACE)
        try:
            self._grid = derive_h3_grid(self._model_def())
        except Exception as exc:
            trace("grid derive at build: %s" % exc)

        style = ("<style>#h3d2-host,#h3d2-host>div{padding:0!important;margin:0!important}"
                 "#h3d2-host iframe{display:block}</style>")
        with gr.Column(elem_id="h3d2-plugin"):
            gr.HTML(value=style + self._iframe_html(), elem_id="h3d2-host", min_height=None)
            req = gr.Textbox(label="req", visible=False, elem_id="h3d2-req")
            resp = gr.Textbox(label="resp", visible=False, elem_id="h3d2-resp")
            go = gr.Button("go", visible=False, elem_id="h3d2-go")
            go.click(fn=self._on_bridge, inputs=[req], outputs=[resp], show_progress="hidden")

            # Generation needs its OWN streaming handler: the wrapper only
            # pumps WanGP's queue while a generator is actively draining
            # job.events, so it cannot share the request/response button.
            genreq = gr.Textbox(label="genreq", visible=False, elem_id="h3d2-genreq")
            genout = gr.Textbox(label="genout", visible=False, elem_id="h3d2-genout")

            # Hidden trigger clicked by the iframe, AND a real button, exactly as
            # the working plugin does it. Registered with self.state as the last
            # input and NO show_progress - matching its call shape, because that
            # is what plugin_ui_context()'s wrapper is known to work with.
            gengo = gr.Button("gen", visible=False, elem_id="h3d2-gengo")
            state_in = getattr(self, "state", None)
            gen_inputs = [genreq, state_in] if state_in is not None else [genreq]
            gengo.click(fn=self._generate_stream, inputs=gen_inputs, outputs=[genout])

            # APPLY: three chained events, ported from the working plugin.
            # Settings must be SEEDED before the switch, wgp returns a model
            # target XOR a refresh timestamp, and stage 3 must suppress the
            # target or the first click double-switches and does nothing.
            brreq = gr.Textbox(label="brreq", visible=False, elem_id="h3d2-brreq")
            brout = gr.Textbox(label="brout", visible=False, elem_id="h3d2-brout")
            brgo = gr.Button("br", visible=False, elem_id="h3d2-brgo")
            brgo.click(fn=self._bridge_run_stream, inputs=[brreq], outputs=[brout])

            sfxreq = gr.Textbox(label="sfxreq", visible=False, elem_id="h3d2-sfxreq")
            sfxout = gr.Textbox(label="sfxout", visible=False, elem_id="h3d2-sfxout")
            sfxgo = gr.Button("sfx", visible=False, elem_id="h3d2-sfxgo")
            sfxgo.click(fn=self._sfx_generate_stream, inputs=[sfxreq], outputs=[sfxout])

            applyreq = gr.Textbox(label="applyreq", visible=False, elem_id="h3d2-applyreq")
            applyout = gr.Textbox(label="applyout", visible=False, elem_id="h3d2-applyout")
            applygo = gr.Button("apply", visible=False, elem_id="h3d2-applygo")
            apply_inputs = [applyreq, state_in] if state_in is not None else [applyreq]

            mct = getattr(self, "model_choice_target", None)
            tabs = getattr(self, "main_tabs", None)
            rft = getattr(self, "refresh_form_trigger", None)
            if mct is not None and tabs is not None:
                ev = applygo.click(fn=self._apply_stage1, inputs=apply_inputs, outputs=[mct, applyout])
                ev = ev.then(fn=self._apply_stage2, inputs=[state_in] if state_in is not None else None,
                             outputs=[tabs])
                if rft is not None:
                    ev.then(fn=self._apply_stage3, inputs=None, outputs=[rft, mct, applyout])
                trace("apply: three-stage chain registered")
            else:
                applygo.click(fn=self._apply_fallback, inputs=apply_inputs, outputs=[applyout])
                trace("apply: targets unavailable, using the fallback handler")

    # ---------------- iframe host ----------------
    def _iframe_html(self) -> str:
        """Host the UI in an iframe.

        Preferred: serve assets/index.html over Gradio's file route, so the
        iframe src is a short URL. Inlining it as a data: URL means ~390 KB of
        base64 in a single HTML attribute, which is fragile and floods the
        terminal whenever anything echoes the component value.
        """
        index = ASSETS_DIR / "index.html"
        if not index.exists():
            trace("assets/index.html MISSING - build webui first")
            return ("<div style='padding:16px;color:#d9a441;font-family:monospace'>"
                    "H3 Director: assets/index.html missing - build the UI first.</div>")

        size = index.stat().st_size
        src = self._served_asset_url(index)
        if src:
            # Cache buster. Serving over a URL (rather than a data: URL) means
            # the browser caches index.html, so an updated plugin kept showing
            # the OLD interface until a hard refresh. Version + mtime changes
            # on every rebuild, so the new bundle is always fetched.
            stamp = "%s-%d" % (PLUGIN_VERSION, int(index.stat().st_mtime))
            src += ("&" if "?" in src else "?") + "h3d2v=" + stamp
            trace("UI cache key %s" % stamp)
        if src:
            trace("UI served from %s (%.0f KB)" % (index.name, size / 1024.0))
        else:
            import base64 as _b64
            src = "data:text/html;base64," + _b64.b64encode(
                index.read_bytes()).decode("ascii")
            trace("UI inlined as a data URL (%.0f KB) - static serving unavailable"
                  % (size / 1024.0))

        return (
            "<iframe id='h3d2-frame' title='H3 Director' "
            "allow='autoplay; encrypted-media; clipboard-write; fullscreen' "
            "sandbox='allow-scripts allow-same-origin allow-pointer-lock allow-downloads allow-modals' "
            "style='width:100%%;height:calc(100vh - 210px);min-height:620px;border:none;"
            "border-radius:8px;display:block;background:#141619;' "
            "src='%s'></iframe>" % src
        )

    def _served_asset_url(self, path):
        """Register the assets folder with Gradio and return a servable URL."""
        try:
            import gradio as _gr
            fn = getattr(_gr, "set_static_paths", None)
            if not callable(fn):
                return ""
            fn(paths=[str(ASSETS_DIR), str(MEDIA_DIR), str(DERIVED_DIR)])
            return "/gradio_api/file=" + str(path).replace("\\", "/")
        except Exception as exc:
            trace("static asset registration failed: %s" % exc)
            return ""

    # ---------------- bridge dispatch ----------------
    def _on_bridge(self, raw):
        """Every handler is wrapped: never raise into the Gradio event chain."""
        try:
            msg = json.loads(raw or "{}")
        except Exception as exc:
            return json.dumps({"cmd": "error", "data": {"message": "bad request: %s" % exc}})

        cmd = str(msg.get("cmd") or "")
        data = msg.get("data") or {}
        mid = msg.get("id")

        try:
            if cmd == "ready":
                out = {"grid": self._grid}
                self._grid = derive_h3_grid(self._model_def())
                return json.dumps({"cmd": "h3_grid", "data": self._grid, "id": None})
            if cmd == "save_project_json":
                out = self._save_project_json(data.get("payload"))
            elif cmd == "load_project_json":
                out = self._load_project_json()
            elif cmd == "adopt_media":
                out = self._adopt_media(data)
            elif cmd == "upload_media":
                out = self._upload_media(data)
            elif cmd == "save_project_zip":
                out = self._save_project_zip(data)
            elif cmd == "list_loras":
                out = self._list_loras(data)
            elif cmd == "sfx_methods":
                out = self._sfx_methods()
            elif cmd == "plan_bridges":
                out = self._plan_bridges(data)
            elif cmd == "bridge_frames":
                out = self._bridge_frames(data)
            elif cmd == "join_videos":
                out = self._join_videos(data)
            elif cmd == "probe_video":
                out = self._probe_video(data)
            elif cmd == "browse_video":
                out = self._browse_video()
            elif cmd == "sfx_mux":
                out = self._sfx_mux(data)
            elif cmd == "preview_prompt":
                out = self._preview_prompt(data)
            elif cmd == "put_media_meta":
                out = self._put_media_meta(data)
            elif cmd == "media_bytes":
                out = self._media_bytes(data)
            elif cmd == "export_daw":
                out = self._export_daw(data)
            elif cmd == "browse_dir":
                out = self._browse_dir()
            elif cmd == "job_state":
                out = self._job_state()
            elif cmd == "cancel":
                out = self._cancel()
            elif cmd == "browse_zip":
                out = self._browse_zip()
            elif cmd == "open_project_zip":
                out = self._open_project_zip(data)
            elif cmd == "list_projects":
                out = self._list_projects(data)
            elif cmd == "list_models":
                models = self._list_h3_models()
                asked = self._normalize_checkpoint(data.get("model_type"))
                if not asked:
                    # Prefer a reference-capable model: FL2VA declares
                    # one_image_ref_only, so probing it reports images=1 and
                    # wrongly caps the reference gallery.
                    ref_first = [m for m in models if m["reference"]]
                    asked = (ref_first or models or [{"model_type": ""}])[0]["model_type"]
                out = {"models": models, "probed": asked, "limits": self._ref_limits(asked),
                       "config_groups": self._config_groups(asked),
                       "audio_modes": self._audio_modes(asked)}
            elif cmd == "list_refmods":
                ok, why = refmods.available()
                out = {"available": ok, "why": why, "mods": refmods.list_mods()}
            elif cmd == "new_project":
                out = self._new_project(data)
            elif cmd == "prune_media":
                out = self._prune_media(data)
            elif cmd == "clear_all":
                out = self._clear_all(data)
            elif cmd == "diagnose":
                out = {"report": self._diagnose()}
            elif cmd == "print_env":
                out = {"ok": True, "printed": self._print_env()}
            elif cmd == "log":
                trace("ui: %s" % data.get("message"))
                out = {"ok": True}
            elif cmd == "js_error":
                trace("iframe JS: %s (%s:%s)" % (data.get("message"), data.get("src"), data.get("line")))
                out = {"ok": True}
            else:
                out = {"ok": False, "error": "unknown cmd %s" % cmd}
            return json.dumps({"cmd": cmd + ":ok", "data": out, "id": mid})
        except Exception as exc:
            trace("bridge %s FAILED: %s" % (cmd, exc))
            return json.dumps({"cmd": cmd + ":err", "error": str(exc), "id": mid})

    # ---------------- persistence ----------------
    def _save_project_json(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        payload = dict(payload)
        payload["app"] = PLUGIN_ID            # refuse to open in the other plugin
        payload["plugin_version"] = PLUGIN_VERSION
        _atomic_write_json(PROJECT_JSON, payload)
        return {"ok": True, "bytes": PROJECT_JSON.stat().st_size}

    def _load_project_json(self):
        for path in (PROJECT_JSON, PROJECT_BAK):
            if not path.exists():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                trace("%s unreadable (%s)" % (path.name, exc))
                continue
            app = payload.get("app")
            if app and app != PLUGIN_ID:
                raise ValueError("project belongs to '%s', not %s" % (app, PLUGIN_ID))
            if path is PROJECT_BAK:
                trace("recovered from project.json.bak")
            media, missing = self._media_manifest(payload)
            if missing:
                trace("LOAD INCOMPLETE - media on disk missing for: %s" % ", ".join(missing))
            return {"payload": payload, "media": media, "missing": missing,
                    "fileBase": self._file_base()}
        return {"payload": None}

    def _upload_media(self, data):
        """Copied ONCE, on arrival. Never rewritten by autosave."""
        name = str(data.get("name") or "upload.bin")
        b64 = data.get("b64") or ""
        blob = base64.b64decode(b64)
        digest = hashlib.sha256(blob).hexdigest()[:16]
        media_id = "m_%s" % digest
        dest = MEDIA_DIR / (media_id + _safe_ext(name))
        if dest.exists():
            trace("media dedup %s (%s)" % (media_id, name))
        else:
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(blob)
            trace("media + %s -> %s (%d bytes)" % (name, dest.name, len(blob)))
        return {"mediaId": media_id, "name": name, "file": dest.name,
                "path": str(dest), "fileBase": self._file_base()}

    def _adopt_media(self, data):
        """Take a file Gradio already uploaded and copy it into the workspace.

        Gradio writes uploads to a TEMP directory that is cleaned up later, so
        the path it returns cannot be stored - the file has to be copied in and
        content-addressed like any other media."""
        name = str(data.get("name") or "upload.bin")
        src = Path(str(data.get("path") or ""))
        if not src.is_file():
            raise ValueError("Gradio reported %s but it is not on disk" % src)
        h = hashlib.sha256()
        with open(src, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        media_id = "m_%s" % h.hexdigest()[:16]
        dest = MEDIA_DIR / (media_id + _safe_ext(name))
        if dest.exists():
            trace("media dedup %s (%s)" % (media_id, name))
        else:
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            trace("media adopted %s -> %s (%.1f MB)"
                  % (name, dest.name, dest.stat().st_size / 1048576.0))
        return {"mediaId": media_id, "name": name, "file": dest.name,
                "path": str(dest), "fileBase": self._file_base()}

    def _save_project_zip(self, data):
        target = (data.get("dir") or "").strip() or str(PLUGIN_DIR / "projects")
        Path(target).mkdir(parents=True, exist_ok=True)
        if not PROJECT_JSON.exists():
            raise ValueError("nothing to save yet")
        payload = json.loads(PROJECT_JSON.read_text(encoding="utf-8"))

        # INCOMPLETE check moved to SAVE time: a broken zip is the real damage.
        wanted = payload.get("media") or {}
        missing = [k for k, v in wanted.items()
                   if not (MEDIA_DIR / str((v or {}).get("file") or "")).exists()]
        name = str(data.get("name") or payload.get("project_name") or "project").strip()
        safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip() or "project"
        out = Path(target) / ("%s.zip" % safe)
        if out.exists():
            out = Path(target) / ("%s-%s.zip" % (safe, time.strftime("%Y%m%d-%H%M%S")))

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("project.json", json.dumps(payload, ensure_ascii=False))
            for f in sorted(MEDIA_DIR.glob("*")):
                if f.is_file():
                    zf.write(f, "media/" + f.name)
        if missing:
            trace("SAVE INCOMPLETE — missing media: %s" % ", ".join(missing))
            return {"ok": False, "path": str(out), "incomplete": missing}
        trace("saved %s" % out)
        return {"ok": True, "path": str(out)}

    def _clear_all(self, data):
        if not data.get("confirmed"):
            return {"ok": False, "needs_confirm": True}
        freed = 0
        for d in (MEDIA_DIR, DERIVED_DIR):
            for f in d.glob("*"):
                if f.is_file():      # media AND its .meta.json sidecar
                    freed += f.stat().st_size
                    f.unlink()
                    trace("cleared %s" % f.name)
        for p in (PROJECT_JSON, PROJECT_BAK):
            if p.exists():
                p.unlink()
        trace("Clear All: reclaimed %.1f MB" % (freed / 1048576.0))
        return {"ok": True, "freed": freed}

    # ---------------- Wan2GP model access ----------------
    def _model_def(self):
        """Uses the global requested in setup_ui — Wan2GP injects it onto self."""
        fn = getattr(self, "get_model_def", None)
        if not callable(fn):
            trace("get_model_def not injected yet; using fallback grid")
            return None
        for mt in ("minimax_h3_fl2va", "minimax_h3_ref2va"):
            try:
                d = fn(mt)
                if isinstance(d, dict) and d:
                    trace("model_def read for %s" % mt)
                    return d
            except Exception as exc:
                trace("get_model_def(%s): %s" % (mt, exc))
        return None




    # ---------------- the installed model roster ----------------
    _H3_HINTS = ("minimax_h3", "minimax-h3", "minimaxh3", "h3_fl2va", "h3_ref2va",
                 "h3_hybrid", "fl2va", "ref2va")

    def _looks_like_h3(self, model_type, mdef):
        """Match on EVERY field a custom finetune might carry it in.

        Filtering by family="minimax_h3" silently drops built finetunes: the
        family filter matches metadata["family"], and a registered hybrid
        checkpoint does not necessarily carry that value. So enumerate
        everything and decide here."""
        meta = mdef.get("metadata") or {}
        haystack = " ".join(str(v or "").lower() for v in (
            model_type,
            mdef.get("architecture"),
            mdef.get("base_model_type"),
            meta.get("family"),
            meta.get("family_label"),
            meta.get("base_model_type"),
            meta.get("architecture"),
            mdef.get("name"),
            (mdef.get("model") or {}).get("name") if isinstance(mdef.get("model"), dict) else "",
        ))
        return any(h in haystack for h in self._H3_HINTS)

    def _raw_model_defs(self):
        """Every model Wan2GP knows, with NO filters. Tries each API in turn."""
        # DOTTED access on purpose: _callback_uses_api_session() inspects
        # co_names, and getattr(self, "_wangp_session") puts the name in
        # co_consts instead - so the handler is never wrapped and the WanGP
        # queue never pumps. The task is admitted and then nothing happens.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        attempts = []
        if session is not None:
            attempts += [("session.list_model_defs()", lambda: session.list_model_defs()),
                         ("session.get_model_defs()", lambda: session.get_model_defs())]
        inj = getattr(self, "get_model_defs", None)
        if callable(inj):
            attempts.append(("global get_model_defs()", lambda: inj()))
        for label, fn in attempts:
            try:
                defs = fn()
            except Exception as exc:
                trace("%s failed: %s" % (label, exc))
                continue
            items = []
            if isinstance(defs, dict):
                items = [(k, v if isinstance(v, dict) else {}) for k, v in defs.items()]
            elif isinstance(defs, list):
                for d in defs:
                    if not isinstance(d, dict):
                        continue
                    mid = d.get("model_type") or d.get("id")
                    if mid:
                        items.append((str(mid), d))
            if items:
                trace("%s -> %d model(s)" % (label, len(items)))
                return items
            trace("%s returned nothing" % label)
        return []

    def _list_h3_models(self):
        """The H3 models Wan2GP ACTUALLY has, INCLUDING built finetunes such as
        a registered Hybrid checkpoint. Never build an id by concatenation."""
        out = []
        skipped = []
        for mid, mdef in self._raw_model_defs():
            if not self._looks_like_h3(mid, mdef):
                skipped.append(mid)
                continue
            arch = str(mdef.get("architecture") or mdef.get("base_model_type") or mid).lower()
            blob = (mid + " " + arch).lower()
            pipeline = "Hybrid" if "hybrid" in blob else ("Ref2VA" if "ref2va" in blob else "FL2VA")
            name = mdef.get("name")
            if not name and isinstance(mdef.get("model"), dict):
                name = mdef["model"].get("name")
            out.append({
                "model_type": mid,
                "name": str(name or mid),
                "pipeline": pipeline,
                "size": "Pruned 20B" if "pruned" in blob else "Full 33B",
                "architecture": arch,
                "pdd": bool(mdef.get("pdd")) or mid.lower().endswith("_pdd"),
                "reference": pipeline in ("Ref2VA", "Hybrid"),
                "finetune": bool((mdef.get("metadata") or {}).get("finetune")),
                "visible": bool(mdef.get("visible", True)),
            })
        out.sort(key=lambda x: (x["pipeline"], x["model_type"]))
        trace("H3 models: %d matched%s" % (len(out), (" (" + ", ".join(m["model_type"] for m in out) + ")") if out else ""))
        if not out and skipped:
            trace("no H3 match among %d model(s): %s" % (len(skipped), ", ".join(skipped[:25])))
        return out

    def _model_def_for(self, model_type):
        # DOTTED access on purpose: _callback_uses_api_session() inspects
        # co_names, and getattr(self, "_wangp_session") puts the name in
        # co_consts instead - so the handler is never wrapped and the WanGP
        # queue never pumps. The task is admitted and then nothing happens.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        try:
            if session is not None and model_type and hasattr(session, "get_model_def"):
                return session.get_model_def(model_type) or {}
        except Exception as exc:
            trace("get_model_def(%s): %s" % (model_type, exc))
        return {}

    # Wan2GP's own slot order for the model-config groups. The MEANING of a
    # slot is not fixed: on one H3 branch system_configs2 is the Video VAE, on
    # another it is the DiT priority. So the groups are read from the model
    # itself and matched by their _name, never by position.
    CONFIG_GROUP_KEYS = ("system_configs", "system_configs2", "system_configs3", "configs")

    def _audio_modes(self, model_type):
        """The audio source modes THIS model declares, and its default.

        The UI used to carry its own hardcoded list, which had drifted: it
        offered "K", which is not in the model's selection at all. Read live,
        like the other option groups.
        """
        mdef = self._model_def_for(model_type)
        src = mdef.get("audio_prompt_type_sources")
        if not isinstance(src, dict):
            return {"selection": [], "labels": {}, "default": ""}
        labels = src.get("labels") if isinstance(src.get("labels"), dict) else {}
        return {
            "selection": [str(x) for x in (src.get("selection") or [])],
            "labels": {str(k): str(v) for k, v in labels.items()},
            "default": str(src.get("default") or ""),
        }

    def _config_groups(self, model_type):
        """The model's own option groups: [{key, name, default_label, options}].

        These used to be three dropdowns typed out in the UI -- Text Encoder,
        Video VAE, DiT priority -- built from a snapshot of one H3 variant and
        never sent anywhere. Reading them live means a new option upstream (the
        INT8 ConvRot VAE, say) appears on its own instead of going stale, and
        the option lands in the slot THIS model puts it in.
        """
        mdef = self._model_def_for(model_type)
        groups = []
        for key in self.CONFIG_GROUP_KEYS:
            block = mdef.get(key)
            if not isinstance(block, dict):
                continue
            options = [{"id": cid, "name": (cdef or {}).get("name", cid)}
                       for cid, cdef in block.items()
                       if cid not in ("_name", "_default_label") and isinstance(cdef, dict)]
            if not options:
                continue
            groups.append({
                "key": key,
                "name": block.get("_name") or key,
                "default_label": block.get("_default_label", "Default"),
                "options": options,
            })
        return groups

    def _config_selection(self, plan):
        """Turn {group key: option id} into the comma-joined `config` string.

        Wan2GP splits this by position across CONFIG_GROUP_KEYS and blanks any
        id that is not in that slot's group, so an id sent against the wrong
        slot is discarded without a word -- which is why the keys travel from
        the UI rather than the positions.
        """
        chosen = plan.get("model_configs")
        if not isinstance(chosen, dict) or not chosen:
            return ""
        valid = {g["key"]: {o["id"] for o in g["options"]}
                 for g in self._config_groups(plan.get("model_type") or plan.get("checkpoint"))}
        parts, dropped = [], []
        for key in self.CONFIG_GROUP_KEYS:
            want = str(chosen.get(key) or "")
            if want and want not in valid.get(key, set()):
                dropped.append("%s=%s" % (key, want))
                want = ""
            parts.append(want)
        if dropped:
            trace("model config: dropping %s - this model does not offer it"
                  % ", ".join(dropped))
        return ",".join(parts).rstrip(",")

    def _pipeline_caps(self):
        """Read the reference caps WanGP actually ENFORCES.

        They are not in model_def - they are hardcoded in
        models/minimax_h3/pipeline.py:
            if len(refs) > 12 or sum(... "image") > 9
               or sum(... "video") > 2 or sum(... "audio") > 2:
                raise ValueError("WanGP supports at most 12 ... 9 images, 2
                videos, and 2 audio clips")
        The MODEL handles three of each; this is WanGP's limiter. Parsing the
        real line means the day it is raised we pick it up with no code change,
        instead of waiting for a new UI mode to appear in the choice list.
        """
        if getattr(self, "_caps_cache", None) is not None:
            return self._caps_cache
        caps = {}
        try:
            import wgp as _wgp  # type: ignore
            root = Path(getattr(_wgp, "__file__", "")).resolve().parent
        except Exception:
            root = Path.cwd()
        src_path = root / "models" / "minimax_h3" / "pipeline.py"
        try:
            src = src_path.read_text(encoding="utf-8", errors="ignore")
            m = re.search(
                r'len\(refs\)\s*>\s*(\d+).*?'
                r'==\s*"image".*?>\s*(\d+).*?'
                r'\("video",\s*"video_audio"\).*?>\s*(\d+).*?'
                r'\("audio",\s*"video_audio"\).*?>\s*(\d+)',
                src, re.S)
            if m:
                caps = {"total": int(m.group(1)), "images": int(m.group(2)),
                        "videos": int(m.group(3)), "audio": int(m.group(4)),
                        "source": "pipeline.py"}
                trace("reference caps read from pipeline.py: %s" % caps)
            else:
                trace("could not parse the reference cap line in %s" % src_path.name)
        except Exception as exc:
            trace("pipeline cap probe: %s" % exc)
        self._caps_cache = caps
        return caps

    def _ref_limits(self, model_type):
        """How many reference videos / audio this model accepts, read from its
        OWN choice lists.

        The video modes live under guide_custom_choices["choices"] as
        (label, value) TUPLES - not ["selection"], which is only used by
        audio_prompt_type_sources. Reading the wrong key made every model look
        like it allowed one video. FL2VA really does allow one (it declares
        only "Use Control Video"); Ref2VA and Hybrid declare "Use Two
        Reference Videos" / V+-U and allow two."""
        mdef = self._model_def_for(model_type)
        vids = auds = 1
        values = []
        try:
            guide = mdef.get("guide_custom_choices") or {}
            for entry in (guide.get("choices") or []):
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    values.append(str(entry[1]))
                else:
                    values.append(str(entry))
            for entry in (guide.get("selection") or []):   # tolerate either shape
                values.append(str(entry))
            for v in values:
                if "V+" in v:
                    vids = max(vids, 2)
                if "V++" in v or "V3" in v:
                    vids = max(vids, 3)
        except Exception as exc:
            trace("ref video limit probe: %s" % exc)
        try:
            sources = (mdef.get("audio_prompt_type_sources") or {}).get("selection") or []
            letters = set("".join(str(v) for v in sources))
            if "B" in letters:
                auds = 2
            if "C" in letters:
                auds = 3
        except Exception as exc:
            trace("ref audio limit probe: %s" % exc)
        if not mdef:
            vids, auds = 2, 2

        # The enforced cap wins over the UI choice list: the model takes three
        # of each, WanGP currently allows two, and the cap is what actually
        # raises. When it is raised upstream the slots light up on their own.
        caps = self._pipeline_caps()
        cap_src = ""
        if caps:
            vids = min(max(vids, 1), caps.get("videos", vids)) if caps.get("videos") else vids
            auds = min(max(auds, 1), caps.get("audio", auds)) if caps.get("audio") else auds
            if caps.get("videos"):
                vids = caps["videos"]
            if caps.get("audio"):
                auds = caps["audio"]
            cap_src = "pipeline.py"

        limits = {"videos": vids, "audio": auds,
                  "max_ref_seconds": float(mdef.get("reference_video_max_frames", 15 * 24)) / 24.0,
                  "images": 1 if mdef.get("one_image_ref_only") else (caps or {}).get("images", 9),
                  "model": model_type,
                  "modes": ",".join(v for v in values if v) or "none",
                  "total": (caps or {}).get("total", 12),
                  "source": cap_src or ("model_def" if mdef else "fallback")}
        trace("ref limits for %s: videos=%s audio=%s images=%s (modes: %s)"
              % (model_type, vids, auds, limits["images"], limits["modes"]))
        return limits

    def _normalize_checkpoint(self, value):
        """The UI can hand back a display NAME ("Hybrid BF16 AdaLN30-49") or a
        label ("Name  [model_type]") instead of the id. Stored raw, that matches
        no installed model. Map it back, or return "" so Auto resolves."""
        raw = str(value or "").strip()
        if not raw:
            return ""
        models = self._list_h3_models()
        for m in models:
            if raw == m["model_type"]:
                return raw
        if raw.endswith("]") and "[" in raw:
            inner = raw[raw.rfind("[") + 1:-1].strip()
            for m in models:
                if inner == m["model_type"]:
                    trace("checkpoint label -> %s" % inner)
                    return inner
        for m in models:
            if raw.lower() == str(m["name"]).lower():
                trace("checkpoint name %r -> %s" % (raw, m["model_type"]))
                return m["model_type"]
        low = raw.lower()
        hits = [m for m in models if low in str(m["name"]).lower() or low in m["model_type"].lower()]
        if len(hits) == 1:
            trace("checkpoint %r matched %s" % (raw, hits[0]["model_type"]))
            return hits[0]["model_type"]

        # Loose match: compare on alphanumerics only, so "Hybrid BF16
        # AdaLN30-49" still finds "MiniMax-H3-Hybrid-BF16-...-AdaLN30-49" even
        # when the roster entry carries no display name to match against.
        def squash(x):
            return re.sub(r"[^a-z0-9]", "", str(x).lower())

        key = squash(raw)
        if key:
            loose = [m for m in models
                     if key and (key in squash(m["model_type"]) or key in squash(m["name"]))]
            if len(loose) == 1:
                trace("checkpoint %r loosely matched %s" % (raw, loose[0]["model_type"]))
                return loose[0]["model_type"]
            # every token present, in order
            toks = [t for t in re.split(r"[^A-Za-z0-9]+", raw) if t]
            if toks:
                scored = []
                for m in models:
                    hay = squash(m["model_type"]) + " " + squash(m["name"])
                    if all(squash(t) in hay for t in toks):
                        scored.append(m)
                if len(scored) == 1:
                    trace("checkpoint %r matched %s on all tokens" % (raw, scored[0]["model_type"]))
                    return scored[0]["model_type"]
        trace("checkpoint %r matches no installed model" % raw)
        return ""

    def _pick_model_type(self, plan):
        """Never silently substitute a model: if a checkpoint was chosen and
        cannot be matched, refuse rather than generate with a different one."""
        asked = str(plan.get("model_type") or "").strip()
        resolved = self._normalize_checkpoint(asked)
        if resolved:
            return resolved
        models = self._list_h3_models()
        if not models:
            raise ValueError("Wan2GP reports no MiniMax H3 models installed.")
        if asked:
            raise ValueError(
                "'%s' does not match an installed model, and I will not silently "
                "generate with a different one. Installed: %s"
                % (asked, ", ".join(m["model_type"] for m in models)))
        pipeline = str(plan.get("pipeline") or "")
        size = str(plan.get("size") or "")
        for m in models:
            if m["pipeline"] == pipeline and m["size"] == size:
                return m["model_type"]
        return models[0]["model_type"]

    def _validate_model_type(self, model_type):
        """Refuse loudly rather than let WanGP fail with a useless message, and
        never silently substitute a different model."""
        if self._model_def_for(model_type):
            return model_type
        roster = [m["model_type"] for m in self._list_h3_models()]
        raise ValueError(
            "Wan2GP has no model called '%s'. Installed H3 models: %s. "
            "Pick one in Generation > Model > Checkpoint."
            % (model_type, ", ".join(roster) or "none found")
        )


    # ---------------- LoRAs ----------------
    def _list_loras(self, data):
        """The LoRAs Wan2GP has for this model, plus how many guidance phases
        it supports - the multiplier format depends on that."""
        mt = self._normalize_checkpoint(data.get("model_type")) or ""
        if not mt:
            models = self._list_h3_models()
            mt = models[0]["model_type"] if models else ""
        out = {"model_type": mt, "supported": False, "loras": [], "max_phases": 1, "error": ""}
        # DOTTED access on purpose: _callback_uses_api_session() inspects
        # co_names, and getattr(self, "_wangp_session") puts the name in
        # co_consts instead - so the handler is never wrapped and the WanGP
        # queue never pumps. The task is admitted and then nothing happens.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        try:
            if session is not None and hasattr(session, "list_loras") and mt:
                r = session.list_loras(mt) or {}
                out["supported"] = bool(r.get("supported"))
                out["loras"] = [str(x) for x in (r.get("loras") or [])]
        except Exception as exc:
            out["error"] = str(exc)
            trace("list_loras failed: %s" % exc)
        mdef = self._model_def_for(mt)
        try:
            out["max_phases"] = int(mdef.get("guidance_max_phases", 1) or 1)
            if mdef.get("lock_guidance_phases"):
                out["locked_phases"] = int(mdef.get("guidance_phases", out["max_phases"]) or 1)
            out["lora_phases"] = int(mdef.get("lora_multiplier_phases", out["max_phases"]) or 1)
        except Exception as exc:
            trace("phase probe: %s" % exc)
        trace("loras for %s: %d found, max_phases=%s lora_phases=%s"
              % (mt, len(out["loras"]), out["max_phases"], out.get("lora_phases")))
        return out

    def _lora_multipliers(self, plan):
        """Build the multipliers string WanGP expects.

        Space separates LoRAs, semicolons separate guidance phases:
          one phase  -> "1 0.8"
          two phases -> "1;1 0.8;0.5"
        A phase count that does not match what the model runs is silently
        mis-parsed, so it is derived from the phases actually being sent.
        """
        loras = [str(x) for x in (plan.get("activated_loras") or []) if x]
        if not loras:
            return ""
        weights = plan.get("lora_weights") or {}
        phases = int(plan.get("guidance_phases") or 1)
        parts = []
        for name in loras:
            w = weights.get(name)
            if isinstance(w, (list, tuple)):
                vals = [float(v) for v in w][:max(1, phases)]
            elif w is None:
                vals = [1.0]
            else:
                vals = [float(w)]
            while len(vals) < phases:
                vals.append(vals[-1])
            parts.append(";".join(("%g" % v) for v in vals[:phases]))
        out = " ".join(parts)
        trace("lora multipliers (%d lora(s), %d phase(s)): %s" % (len(loras), phases, out))
        return out


    # ---------------- bridging two clips ----------------
    def _plan_bridges(self, data):
        """Work out what each bridge prompt on the CONTROL track should do.

        A text segment sitting on the control track marks a gap to be filled.
        What it becomes depends on its neighbours on that track:

          clip A | prompt | clip B   BRIDGE  - continue from A, land on B
          clip A | prompt |          EXTEND AFTER  - continue from A, run free
                 | prompt | clip B   EXTEND BEFORE - run free, land on B

        Extending BEFORE is worth spelling out: generation only runs forward,
        so a clip cannot be continued backwards. Instead the new material is
        generated to END on the existing clip's first frame, then placed in
        front of it - same result, opposite direction.
        """
        fps = float(data.get("fps") or 24)
        segs = list(data.get("segments") or [])
        control = sorted([x for x in segs if x.get("track") == "control"],
                         key=lambda x: float(x.get("start") or 0))
        plans = []
        for i, seg in enumerate(control):
            if seg.get("mediaId"):
                continue                      # a real clip, not a gap to fill
            if not str(seg.get("prompt") or "").strip():
                continue                      # an empty marker says nothing
            before = next((c for c in reversed(control[:i]) if c.get("mediaId")), None)
            after = next((c for c in control[i + 1:] if c.get("mediaId")), None)
            if before and after:
                mode, why = "bridge", "continue from the clip before and land on the clip after"
            elif before:
                mode, why = "extend_after", "continue forward from the clip before"
            elif after:
                mode, why = "extend_before", "generate forward and land on the clip after, then place it in front"
            else:
                # Nothing to continue from and nothing to land on. A prompt
                # here describes no relationship between clips, so it is an
                # ordinary generation and belongs on the top prompt track.
                mode, why = "invalid", ("no clip before or after, so there is nothing to bridge - "
                                        "move this to the top prompt track")
            # A bridge generates ITS OWN length, not the timeline's. The clips
            # either side already exist as video and are never regenerated, so
            # a 5s clip plus a 10s bridge is a 15s timeline with 10s to make.
            length = int(seg.get("length") or 0)
            win = int(data.get("window") or self._grid["WINDOW_DEFAULT"])
            ovl = int(data.get("overlap") or self._grid["OVERLAP_DEFAULT"])
            floor = int(self._grid.get("WINDOW_MIN", 0) or 0)
            warn = ""
            if floor and length < floor:
                warn = ("%d frames is below this model's %d-frame minimum - "
                        "lengthen the bridge or it cannot be generated" % (length, floor))
            req = compensate_request(length, win, ovl) if length else 0
            passes = 1 if req <= win else 1 + -(-(req - win) // max(1, win - ovl))
            # Injected images inside this gap. Positions are 1-BASED AND
            # RELATIVE TO THE GENERATED CLIP - wgp does
            #     frames_positions_list.append(int(pos) - 1 + alignment_shift)
            # so a timeline frame means nothing to it. The clip also opens with
            # the carried overlap on a continuation, which shifts everything
            # again, so the shift is applied per pass, not here.
            gap_start = int(seg.get("start") or 0)
            gap_end = gap_start + length
            injected = []
            for img in segs:
                if img.get("track") != "video" or not img.get("mediaId"):
                    continue
                if str(img.get("kind") or "") not in ("image", ""):
                    continue
                pos = int(img.get("start") or 0)
                if gap_start <= pos < gap_end:
                    injected.append({
                        "mediaId": img.get("mediaId"),
                        "name": img.get("fileName") or img.get("title"),
                        "timelineFrame": pos,
                        "offsetInGap": pos - gap_start,        # before any carry
                    })
            injected.sort(key=lambda x: x["offsetInGap"])

            plans.append({
                "id": seg.get("id"),
                "mode": mode,
                "why": why,
                "start": int(seg.get("start") or 0),
                "length": length,
                "seconds": round(length / fps, 2) if fps else 0,
                "frames": length,
                "request": req,
                "windows": passes,
                "warning": warn,
                "injected": injected,
                "prompt": str(seg.get("prompt") or "")[:400],
                "fromMediaId": (before or {}).get("mediaId"),
                "fromName": (before or {}).get("fileName") or (before or {}).get("title"),
                "toMediaId": (after or {}).get("mediaId"),
                "toName": (after or {}).get("fileName") or (after or {}).get("title"),
                "flags": ("VE" if mode == "bridge"
                          else "V" if mode == "extend_after"
                          else "E" if mode == "extend_before" else ""),
                "valid": mode != "invalid",
            })
        # Total length of the finished piece: existing clips + generated gaps.
        clip_frames = sum(int(c.get("length") or 0) for c in control if c.get("mediaId"))
        gen_frames = sum(p["frames"] for p in plans if p["valid"])
        bad = [p for p in plans if not p["valid"]]
        trace("bridge plan: %d gap(s) on the control track (%s)%s"
              % (len(plans), ", ".join(p["mode"] for p in plans) or "none",
                 "  [%d invalid]" % len(bad) if bad else ""))
        if plans:
            trace("bridge lengths: %d frame(s) of existing clip + %d to generate = %d total"
                  % (clip_frames, gen_frames, clip_frames + gen_frames))
        return {"plans": plans,
                "order": [p["id"] for p in plans if p["valid"]],
                "invalid": [p["id"] for p in bad],
                "clipFrames": clip_frames,
                "generateFrames": gen_frames,
                "totalFrames": clip_frames + gen_frames,
                "hasBridges": any(p["valid"] for p in plans)}

    def _bridge_settings(self, plan_item, frames):
        """Turn one plan entry into the media block for its generation pass.

        Only `bridge` and `extend_after` continue from a clip. `extend_before`
        must NOT: there is nothing before it to continue from, so it is an
        ordinary generation that simply has to LAND on the next clip's first
        frame.
        """
        media = {}
        mode = plan_item.get("mode")
        if mode in ("bridge", "extend_after") and frames.get("fromPath"):
            media["video_source"] = frames["fromPath"]
        if mode in ("bridge", "extend_before") and frames.get("firstFrame"):
            media["image_end"] = frames["firstFrame"]
        return media

    def _injected_for_pass(self, plan_item, carry):
        """Resolve this gap's injected images into paths and 1-based positions
        WITHIN THE GENERATED CLIP.

        A continuation opens with `carry` frames lifted from the clip before
        it, so every position moves along by that much. Without this an image
        meant for the middle of a bridge lands wherever the timeline frame
        happened to point, which for a gap starting at 360 is off the end.
        """
        out = {"paths": [], "positions": [], "dropped": []}
        for item in (plan_item.get("injected") or []):
            src = self._media_path(item.get("mediaId"))
            if src is None:
                out["dropped"].append(item.get("name") or item.get("mediaId"))
                continue
            pos = int(item.get("offsetInGap") or 0) + int(carry) + 1   # 1-based
            out["paths"].append(str(src))
            out["positions"].append(pos)
        if out["paths"]:
            trace("injected frames for this pass: %s (carry %d shifted them)"
                  % (", ".join("%s@%d" % (os.path.basename(p2), q)
                               for p2, q in zip(out["paths"], out["positions"])), carry))
        for name in out["dropped"]:
            trace("injected image %s has no file on disk - dropped" % name)
        return out

    def _ffprobe_duration(self, path_in):
        try:
            import subprocess
            exe = shutil.which("ffprobe") or "ffprobe"
            out = subprocess.run(
                [exe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(path_in)],
                capture_output=True, text=True, timeout=120)
            return float((out.stdout or "0").strip() or 0)
        except Exception as exc:
            trace("ffprobe failed for %s: %s" % (os.path.basename(str(path_in)), exc))
            return 0.0

    def _luma_stats(self, path_in, frames=0):
        """Average brightness and contrast of a clip, 0-255.

        Long continuations drift: every window is generated from the encoded
        frames of the one before it, and whatever small bias that round trip
        has is inherited and re-applied by the next window. Over twenty
        windows it shows as the picture getting steadily brighter and softer.

        Nothing here changes the render. It measures, so the drift is a number
        in the log instead of a feeling about the finished video.
        """
        try:
            import subprocess
            args = [self._ffmpeg(), "-v", "error", "-i", str(path_in)]
            if frames:
                args += ["-frames:v", str(int(frames))]
            args += ["-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                     "-f", "null", "-"]
            out = subprocess.run(args, capture_output=True, text=True, timeout=600)
            vals = [float(m) for m in re.findall(
                r"lavfi\.signalstats\.YAVG=([0-9.]+)", out.stdout or "")]
            if not vals:
                return None
            mean = sum(vals) / len(vals)
            var = sum((v - mean) ** 2 for v in vals) / len(vals)
            return {"y": mean, "spread": var ** 0.5, "frames": len(vals)}
        except Exception as exc:
            trace("could not measure brightness of %s: %s"
                  % (os.path.basename(str(path_in)), exc))
            return None

    def _hold_look(self, tail_path, ref, cap=0.02):
        """Nudge the carried frames back toward the look the piece opened with.

        The correction is applied to the SEED frames of the next group, not to
        anything already rendered, so it steers what comes next rather than
        grading what is done. It is capped per join -- a full correction would
        snap the picture at the boundary, which reads worse than the drift it
        is fixing. Across several joins the cap still holds the ramp down.
        """
        now = self._luma_stats(tail_path)
        if not now or not ref or ref.get("y", 0) <= 1:
            return tail_path, None
        drift = (now["y"] - ref["y"]) / ref["y"]
        if abs(drift) < 0.004:
            return tail_path, drift
        # ffmpeg's eq brightness is an offset in -1..1 over the full range.
        want = -drift * ref["y"] / 255.0
        adj = max(-cap, min(cap, want))
        src = Path(tail_path)
        out = DERIVED_DIR / (src.stem + "_held.mp4")
        try:
            import subprocess
            subprocess.run([self._ffmpeg(), "-y", "-i", str(src),
                            "-vf", "eq=brightness=%.5f" % adj, "-an",
                            "-c:v", "libx264", "-crf", "0", "-preset", "veryfast",
                            "-pix_fmt", "yuv420p", str(out)],
                           check=True, capture_output=True, timeout=1800)
        except Exception as exc:
            trace("could not hold the look (%s); carrying the frames as they are" % exc)
            return tail_path, drift
        return str(out), drift

    def _probe_video(self, data):
        src = self._media_path(data.get("mediaId")) or Path(str(data.get("path") or ""))
        if not src or not Path(src).is_file():
            raise ValueError("no such video")
        d = self._ffprobe_duration(src)
        return {"path": str(src), "duration": d, "frames": int(round(d * float(data.get("fps") or 24)))}

    def _source_tail(self, src, frames, fps):
        """Write just the LAST `frames` of a clip, to hand to video_source.

        estimate_first_window_overlap_frames() sizes the first window from the
        SOURCE CLIP'S OWN LENGTH. Passing a 15s clip therefore claims the whole
        window as overlap and the run splits in two, regenerating the source -
        which is the distorted copy you kept getting. keep_frames_video_source
        is meant to bound that, but it is not being honoured here, so the clip
        itself is trimmed instead. A short tail cannot be misread.
        """
        src = Path(src)
        n = max(1, int(frames))
        DERIVED_DIR.mkdir(parents=True, exist_ok=True)
        out = DERIVED_DIR / ("tail_%s_%d.mp4" % (src.stem, n))
        if out.exists():
            return str(out)
        total = self._ffprobe_duration(src)
        start = max(0.0, total - (n / float(fps)))
        import subprocess
        # LOSSLESS. These frames are not output -- they are the context the
        # next window or group generates from, so they decide its look. A
        # visually-lossless crf still shifts pixels, and a shift in the seed
        # frames is a shift in everything that follows them. The clip is a
        # fraction of a second, so the file size does not matter.
        subprocess.run([self._ffmpeg(), "-y", "-ss", "%.4f" % start, "-i", str(src),
                        "-frames:v", str(n), "-an",
                        "-c:v", "libx264", "-crf", "0", "-preset", "veryfast",
                        "-pix_fmt", "yuv420p", "-r", "%g" % fps, str(out)],
                       check=True, capture_output=True, timeout=1800)
        trace("source tail: last %d frame(s) of %s (%.2fs of %.2fs) -> %s"
              % (n, src.name, n / float(fps), total, out.name))
        return str(out)

    def _bridge_frames(self, data):
        """Pull the LAST frame of clip A and the FIRST frame of clip B.

        The bridge is generated as a continuation of A (video_source) that ends
        on B's opening frame (image_end), so the three pieces line up instead
        of cutting. Both frames are written into the workspace as real files,
        because WanGP wants paths, not objects.
        """
        a = self._media_path(data.get("fromMediaId"))
        b = self._media_path(data.get("toMediaId"))
        if a is None and b is None:
            raise ValueError("need at least one clip to bridge from or to")
        import subprocess
        exe = self._ffmpeg()
        out = {}
        if a is not None:
            last = DERIVED_DIR / ("bridge_last_%s.png" % a.stem)
            if not last.exists():
                subprocess.run([exe, "-y", "-sseof", "-0.2", "-i", str(a),
                                "-update", "1", "-frames:v", "1", str(last)],
                               check=True, capture_output=True, timeout=600)
            out["fromPath"] = str(a)
            out["lastFrame"] = str(last)
            out["fromDuration"] = self._ffprobe_duration(a)
            trace("bridge: last frame of %s -> %s" % (a.name, last.name))
        if b is not None:
            first = DERIVED_DIR / ("bridge_first_%s.png" % b.stem)
            if not first.exists():
                subprocess.run([exe, "-y", "-i", str(b), "-frames:v", "1", str(first)],
                               check=True, capture_output=True, timeout=600)
            out["toPath"] = str(b)
            out["firstFrame"] = str(first)
            out["toDuration"] = self._ffprobe_duration(b)
            trace("bridge: first frame of %s -> %s" % (b.name, first.name))
        return out

    def _join_videos(self, data):
        """Concatenate the pieces into one continuous file.

        A generated bridge carries frames at BOTH ends that must not survive
        the join:

          * the FRONT holds the overlap carried from the clip before it - those
            frames are the clip's own tail regenerated, so keeping them repeats
            that moment
          * the LAST frame is the landing frame, which is the first frame of the
            clip that follows

        So each part declares its own trims rather than the join guessing.
        """
        raw = data.get("parts") or []
        fps = float(data.get("fps") or 24)
        parts = []
        for entry in raw:
            if isinstance(entry, dict):
                pth = str(entry.get("path") or "")
                head = int(entry.get("trim_start_frames") or 0)
                tail = int(entry.get("trim_end_frames") or 0)
            else:
                pth, head, tail = str(entry), 0, 0
            if os.path.isfile(pth):
                parts.append({"path": pth, "head": head, "tail": tail})
        if len(parts) < 2:
            raise ValueError("need at least two existing files to join")

        outdir = Path(str(data.get("dir") or "").strip() or Path(parts[0]["path"]).parent)
        outdir.mkdir(parents=True, exist_ok=True)
        name = "".join(c for c in str(data.get("name") or "joined") if c.isalnum() or c in "-_ ") or "joined"
        out = outdir / ("%s.mp4" % name)
        if out.exists():
            out = outdir / ("%s-%s.mp4" % (name, time.strftime("%Y%m%d-%H%M%S")))

        import subprocess, tempfile
        exe = self._ffmpeg()
        staged = []
        tmpdir = Path(tempfile.mkdtemp(prefix="h3d2join_"))
        try:
            for i, part in enumerate(parts):
                src, head, tail = part["path"], part["head"], part["tail"]
                dur = self._ffprobe_duration(src)
                start = head / fps
                keep = dur - start - (tail / fps)
                if keep <= 1.0 / fps:
                    trace("join: %s would be empty after trimming %d/%d frames - kept whole"
                          % (os.path.basename(src), head, tail))
                    start, keep = 0.0, dur
                elif head or tail:
                    trace("join: %s trim head=%df tail=%df -> %.3fs of %.3fs"
                          % (os.path.basename(src), head, tail, keep, dur))
                dst = tmpdir / ("p%02d.mp4" % i)
                cmd = [exe, "-y"]
                if start > 0:
                    cmd += ["-ss", "%.4f" % start]
                cmd += ["-i", src, "-t", "%.4f" % keep,
                        "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                        "-pix_fmt", "yuv420p", "-r", "%g" % fps,
                        "-c:a", "aac", "-b:a", "192k", str(dst)]
                subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
                staged.append(dst)

            listing = tmpdir / "list.txt"
            listing.write_text("".join("file '%s'\n" % p2.as_posix() for p2 in staged), encoding="utf-8")
            subprocess.run([exe, "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                            "-c", "copy", str(out)], check=True, capture_output=True, timeout=3600)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        total = self._ffprobe_duration(out)
        trace("joined %d part(s) -> %s (%.2fs)" % (len(parts), out.name, total))
        return {"ok": True, "path": str(out), "duration": total, "parts": len(parts)}

    # ---------------- sound design (post production) ----------------
    def _audio_api(self):
        from postprocessing import audio_processors as ap
        return ap


    # ---------------- running a bridge sequence ----------------
    def _bridge_run_stream(self, raw):
        """Generate every bridge on the guidance track, then join the lot.

        Sequencing lives here rather than in the browser: each pass must finish
        before the next begins, the run has to survive a dropped connection,
        and the join needs the real output paths and their trims.
        """
        def frame(status, msg="", progress=0.0, pass_no=0, passes=0, logs=None,
                  files=None, joined="", error=""):
            # A frame that only reaches the browser is invisible when something
            # goes wrong: the terminal showed the plan and then nothing at all.
            if error:
                trace("bridge run ERROR: %s" % error)
            elif status in ("done", "cancelled"):
                trace("bridge run %s: %s" % (status, msg))
            return json.dumps({"cmd": "bridgerun", "data": {
                "status": status, "message": msg, "progress": round(progress, 4),
                "pass": pass_no, "passes": passes, "logs": logs or [],
                "files": files or [], "joined": joined, "error": error,
                "t": time.time()}})

        try:
            msg = json.loads(raw or "{}")
            data = msg.get("data") or {}
        except Exception as exc:
            yield frame("error", error="bad request: %s" % exc)
            return

        fps = float(data.get("fps") or 24)
        plan = self._plan_bridges({"segments": data.get("segments"), "fps": fps,
                                   "window": data.get("window"), "overlap": data.get("overlap")})
        todo = [q for q in plan["plans"] if q["valid"]]
        if not todo:
            yield frame("error", error="No usable bridge prompts on the guidance track.")
            return

        # DOTTED on purpose: _callback_uses_api_session() reads co_names, so
        # getattr(self, "_wangp_session") would leave this handler unwrapped
        # and the WanGP queue would never pump.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        submit = getattr(session, "submit_task", None) if session is not None else None
        if not callable(submit):
            yield frame("error", error="no WanGP session - reopen the tab")
            return

        base = dict(data.get("settings") or {})
        outputs = {}
        yield frame("running", "%d bridge pass(es) to generate." % len(todo), 0.0, 0, len(todo))

        for n, item in enumerate(todo, 1):
            if item.get("warning"):
                yield frame("error", error=item["warning"])
                return
            try:
                frames_io = self._bridge_frames({"fromMediaId": item.get("fromMediaId"),
                                                 "toMediaId": item.get("toMediaId")})
            except Exception as exc:
                yield frame("error", error="could not read the clip edges: %s" % exc)
                return

            plan_settings = dict(base)
            # Compose the pass prompt the same way a normal window is built:
            # the GLOBAL prompt first, then this gap's own text. Sending only
            # the gap text strips the style direction the rest of the piece
            # gets, which is why a bridge came out looser and rougher than an
            # ordinary generation.
            gap_text = str(item.get("prompt") or "").strip()
            global_text = str(data.get("global_prompt") or "").strip()
            pieces = [t for t in (global_text, gap_text) if t]
            plan_settings["prompt"] = "\n".join(pieces) if pieces else gap_text
            if global_text:
                trace("pass %d prompt: global (%d chars) + gap (%d chars)"
                      % (n, len(global_text), len(gap_text)))

            # Renumbering for THIS pass: only the frames injected into this gap
            # sit ahead of the sheets, not the whole timeline's worth.
            plan_settings["numbering_offset"] = len(item.get("injected") or [])
            media = dict(plan_settings.get("media") or {})
            # A bridge is a CONTINUATION, not a guided shot: a control video
            # would fight the source clip for the motion.
            media.pop("control_video", None)
            media.update(self._bridge_settings(item, frames_io))
            plan_settings["media"] = media

            # Bridge passes are intentionally ONE WanGP generation window.
            # Never let the ordinary paragraph/window splitter reinterpret a
            # bridge prompt as multiple windows. WanGP's FG mode means the
            # complete prompt is one prompt; its V continuation flag remains
            # responsible for carrying the source video into the generated
            # continuation.
            plan_settings["multi_prompts_gen_type"] = "FG"
            plan_settings["video_prompt_type"] = ""
            trace("bridge pass: forced multi_prompts_gen_type='FG' (single prompt/window)")

            try:
                settings = self._assemble_settings(plan_settings)
                settings = self._normalize_audio_guide(settings)
                trace("bridge assembled: model=%s ipt=%r vpt=%r refs=%d prompt_mode=%r"
                      % (settings.get("model_type"), settings.get("image_prompt_type", ""),
                         settings.get("video_prompt_type", ""), len(settings.get("image_refs") or []),
                         settings.get("multi_prompts_gen_type", "")))
            except Exception as exc:
                yield frame("error", error="pass %d refused: %s" % (n, exc))
                return

            win = int(settings.get("sliding_window_size") or self._grid["WINDOW_DEFAULT"])
            ovl = int(settings.get("sliding_window_overlap") or self._grid["OVERLAP_DEFAULT"])
            trim_head = 0
            trim_tail = 1 if settings.get("image_end") else 0
            carry = int(ovl) if settings.get("video_source") else 0
            inj = self._injected_for_pass(item, carry)
            if inj["paths"]:
                # Injected frames and reference sheets SHARE image_refs, split
                # by count: the first nb_frames_positions entries are the
                # injections. So they must come FIRST, and "F" must be in
                # video_prompt_type or wgp discards frames_positions entirely.
                sheets = list(settings.get("image_refs") or [])
                settings["image_refs"] = inj["paths"] + sheets
                settings["frames_positions"] = " ".join(str(q) for q in inj["positions"])
                vpt_now = settings.get("video_prompt_type", "") or ""
                if "F" not in vpt_now:
                    settings["video_prompt_type"] = vpt_now + "F"
                if "I" not in settings["video_prompt_type"] and sheets:
                    settings["video_prompt_type"] += "I"
                trace("pass %d: %d injected + %d sheet(s), frames_positions=%r, vpt=%r"
                      % (n, len(inj["paths"]), len(sheets),
                         settings["frames_positions"], settings["video_prompt_type"]))
            if settings.get("video_source"):
                # Hand over ONLY the tail. The full clip makes WanGP claim the
                # whole first window as overlap and regenerate the source.
                try:
                    settings["video_source"] = self._source_tail(
                        settings["video_source"], ovl, fps)
                except Exception as exc:
                    trace("could not trim the source tail (%s); using the whole clip" % exc)
                cont = self._continuation_plan(item["frames"], win, ovl)
                if cont["truncated"]:
                    # A continuation runs in ONE window, so the bridge is capped
                    # at window - overlap. Clamp and SAY SO rather than refusing:
                    # the overshoot is usually a fraction of a second.
                    note = ("bridge shortened to %.2fs - a continuation runs in one window, so "
                            "the most this model can add at window %d / overlap %d is %.2fs; "
                            "you asked for %.2fs"
                            % (cont["new_material"] / fps, win, ovl,
                               cont["new_material"] / fps, item["frames"] / fps))
                    trace(note)
                    yield frame("running", note, (n - 1) / len(todo), n, len(todo),
                                logs=[{"level": "warn", "msg": note}])
                settings["video_length"] = cont["video_length"]
                # The source itself is already reduced to exactly the carried
                # overlap frames. Do not ask WanGP to trim it again from the
                # front; doing so can change the continuation context.
                settings["keep_frames_video_source"] = ""
                trim_head = int(ovl)
                req = cont["video_length"]
                # WanGP's continuation semantics: video_length is the generated
                # request and the source overlap is carried separately. With the
                # tail clip at `ovl` frames this MUST fit one window.
                planned_windows = self._windows_for(req, win, ovl)
                if planned_windows != 1:
                    raise RuntimeError(
                        "bridge continuation would use %d sliding windows (request=%d, window=%d, overlap=%d); "
                        "refusing because a second window would regenerate the carried source"
                        % (planned_windows, req, win, ovl))
                trace("bridge continuation: EXACTLY 1 WanGP window (request=%d, source_tail=%d, window=%d, overlap=%d)"
                      % (req, ovl, win, ovl))
            else:
                req = self._legal_frames(compensate_request(item["frames"], win, ovl))
                settings["video_length"] = req
            # Do NOT add a [/duration] directive here. WanGP's normal
            # continuation scheduler uses the explicit video_length together
            # with the carried source overlap. A duration tag describes output
            # frames and can create a remainder, which is exactly the failure
            # mode this bridge path is designed to prevent.
            tagged = self._DURATION_TAG.search(settings.get("prompt", ""))
            if tagged:
                settings["prompt"] = self._DURATION_TAG.sub("", settings["prompt"], count=1).lstrip()
                trace("bridge pass: removed a [/duration=] tag - it would split the window")
            trace("bridge pass %d/%d: %s, %d frames (request %d), ipt=%r, trim head=%d tail=%d"
                  % (n, len(todo), item["mode"], item["frames"], req,
                     settings.get("image_prompt_type", ""), trim_head, trim_tail))
            self._log_prompt("BRIDGE PASS %d" % n, settings)

            yield frame("running", "Pass %d of %d - %s, %.2fs"
                        % (n, len(todo), item["mode"].replace("_", " "), item["seconds"]),
                        (n - 1) / len(todo), n, len(todo))

            try:
                job = submit(settings)
            except Exception as exc:
                yield frame("error", error="pass %d submit failed: %s" % (n, exc))
                return
            self._job = job
            self._reset_job_state(status="running", started=time.time(), windows=item["windows"])
            self._start_background_drain(job)

            last = 0.0
            self._stream_owner = id(job)
            while not getattr(job, "done", False):
                stream = getattr(job, "events", None)
                if stream is not None:
                    try:
                        ev = stream.get(timeout=0.25)
                        while ev is not None:
                            self._absorb_event(ev)
                            try:
                                ev = stream.get_nowait()
                            except Exception:
                                ev = None
                    except Exception:
                        pass
                else:
                    time.sleep(0.25)
                now = time.time()
                if now - last >= 1.0:
                    last = now
                    st = getattr(self, "_jobstate", {}) or {}
                    inner = float(st.get("progress") or 0)
                    yield frame("running",
                                "Pass %d of %d - %s" % (n, len(todo), st.get("phase") or "working"),
                                (n - 1 + inner) / len(todo), n, len(todo))

            self._stream_owner = None
            try:
                result = job.result()
            except Exception as exc:
                yield frame("error", error="pass %d failed: %s" % (n, exc))
                return
            self._job = None
            if not getattr(result, "success", False):
                errs = getattr(result, "errors", None) or ["no output"]
                yield frame("error", error="pass %d: %s" % (n, "; ".join(str(e) for e in errs)))
                return
            made = [str(f) for f in (getattr(result, "generated_files", None) or [])]
            if not made:
                yield frame("error", error="pass %d produced no file" % n)
                return
            if len(made) != 1:
                trace("BRIDGE SAFETY: WanGP returned %d files for one-window continuation: %s"
                      % (len(made), ", ".join(os.path.basename(x) for x in made)))
                yield frame("error", error=(
                    "pass %d produced %d output files; expected exactly 1 continuation window. "
                    "The pass was not accepted to prevent a degraded second-window continuation."
                    % (n, len(made))))
                return
            # The pass file can come back LONGER than requested - the extra
            # frames at the end are appended reference sheets, not generated
            # content, which is why the tail showed a character sheet. Trim the
            # surplus as well as the landing frame.
            produced = int(round(self._ffprobe_duration(made[0]) * fps))
            surplus = max(0, produced - int(req))
            if surplus:
                trace("pass %d produced %d frame(s) for a %d-frame request - trimming %d "
                      "surplus frame(s) from the end (appended reference sheets)"
                      % (n, produced, req, surplus))
            outputs[item["id"]] = {"path": made[0],
                                   "trim_start_frames": int(trim_head),
                                   "trim_end_frames": int(trim_tail) + surplus,
                                   # a pass can save more than one file (one per
                                   # window); all of them are superseded by the
                                   # join and must be cleaned up, not just made[0]
                                   "all_files": made}
            trace("bridge pass %d generated: %s   (this is the GAP only, %.2fs)"
                  % (n, made[0], self._ffprobe_duration(made[0])))
            yield frame("running", "Pass %d done." % n, n / len(todo), n, len(todo),
                        logs=[{"level": "ok", "msg": "Pass %d: %s" % (n, made[0])}])

        # ---- stitch clips and bridges together, in timeline order ----
        control = sorted([x for x in (data.get("segments") or []) if x.get("track") == "control"],
                         key=lambda x: float(x.get("start") or 0))
        parts = []
        for seg in control:
            if seg.get("mediaId"):
                pth = self._media_path(seg.get("mediaId"))
                if pth:
                    parts.append({"path": str(pth), "trim_start_frames": 0, "trim_end_frames": 0})
            elif seg.get("id") in outputs:
                parts.append(outputs[seg["id"]])
        made_files = [o["path"] for o in outputs.values()]
        if len(parts) < 2:
            yield frame("done", "Generated, but there was nothing to join to.",
                        1.0, len(todo), len(todo), files=made_files)
            return

        yield frame("running", "Joining %d piece(s)..." % len(parts), 0.98, len(todo), len(todo))
        # The finished video must NOT land in workspace/media - that folder is
        # working media and Clear All wipes it. Prefer the chosen save folder,
        # then wherever WanGP put the pass, then a plugin outputs folder.
        # Beside WanGP's own output - the folder the user already has
        # configured. Never invent a folder, and never workspace/media.
        out_dir = str(Path(made_files[0]).parent) if made_files else ""
        if not out_dir:
            out_dir = str(data.get("dir") or "").strip()
        if not out_dir:
            raise ValueError("nowhere to write the joined file")
        try:
            joined = self._join_videos({"parts": parts, "fps": fps,
                                        "name": str(data.get("name") or "bridged"),
                                        "dir": out_dir})
        except Exception as exc:
            yield frame("error", error="join failed: %s" % exc, files=made_files)
            return

        # Remove the raw pass files: every frame of them is in the joined
        # result, so keeping them just accumulates duplicates in the outputs
        # folder run after run.
        removed = 0
        if True:  # raw per-pass files are always cleaned up: every frame is in the join
            for o in outputs.values():
                for f in (o.get("all_files") or [o["path"]]):
                    try:
                        if os.path.isfile(f) and os.path.abspath(f) != os.path.abspath(joined["path"]):
                            os.remove(f)
                            removed += 1
                    except Exception as exc:
                        trace("could not remove the raw pass %s: %s" % (os.path.basename(f), exc))
        trace("FINAL: %s (%.2fs from %d piece(s))%s"
              % (joined["path"], joined["duration"], joined["parts"],
                 "  [%d raw pass file(s) removed - fully contained in the result]" % removed
                 if removed else ""))
        yield frame("done", "Joined %d piece(s) into %.2fs - final file: %s"
                    % (joined["parts"], joined["duration"], os.path.basename(joined["path"])),
                    1.0, len(todo), len(todo),
                    files=made_files, joined=joined["path"])

    def _sfx_methods(self):
        """The REAL soundtrack + voice methods Wan2GP has registered.
        Never hardcode these - the plugin's own copies of upstream choice
        lists have drifted three times already."""
        out = {"soundtrack": [], "voice": [], "error": ""}
        try:
            ap = self._audio_api()
            for label, value in ap.soundtrack_choices(include_none=True, include_control=True):
                meta = ap.method_metadata(value) if value else {}
                out["soundtrack"].append({
                    "value": value, "label": label,
                    "needs_prompt": bool(meta.get("needs_prompt")),
                    "needs_negative_prompt": bool(meta.get("needs_negative_prompt")),
                    "needs_audio_source": bool(meta.get("needs_audio_source")),
                })
            for label, value in ap.voice_replacement_choices(include_none=True):
                meta = ap.method_metadata(value) if value else {}
                out["voice"].append({"value": value, "label": label,
                                     "needs_voice_sample": bool(meta.get("needs_voice_sample"))})
            trace("sfx methods: %d soundtrack, %d voice"
                  % (len(out["soundtrack"]), len(out["voice"])))
        except Exception as exc:
            out["error"] = str(exc)
            trace("sfx methods unavailable: %s" % exc)
        return out

    # Exclusion terms appended to the SOUND negative prompt at send time.
    # Kept out of the stored prompt so the same prompt can be reused with the
    # toggles flipped - the same rule as image renumbering.
    _SFX_EXCLUDE = {
        "no_music": ["music", "background music", "soundtrack", "melody",
                     "instrumental", "score", "singing"],
        "no_speech": ["speech", "dialogue", "voice", "vocals", "talking",
                      "narration", "whispering"],
        "no_ambience": ["room tone", "ambience", "background noise", "wind", "hum"],
        "no_effects": ["sound effects", "foley", "impacts"],
    }

    def _sfx_negative(self, base, data):
        """Append exclusions to the negative prompt WITHOUT touching what the
        user typed. Generated music is the thing that cannot be edited out
        later, so excluding it up front matters more than it looks."""
        terms = []
        for flag, words in self._SFX_EXCLUDE.items():
            if data.get(flag):
                terms.extend(words)
        if not terms:
            return base
        have = {t.strip().lower() for t in str(base or "").split(",") if t.strip()}
        add = [t for t in terms if t.lower() not in have]
        if not add:
            return base
        merged = ", ".join([t for t in [str(base or "").strip().rstrip(",")] if t] + add)
        trace("sfx negative prompt + %d exclusion term(s): %s" % (len(add), ", ".join(add[:8])))
        return merged

    def _browse_video(self):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Choose a video to add sound to",
                filetypes=[("Video", "*.mp4 *.mov *.mkv *.webm *.avi *.m4v"), ("All files", "*.*")])
            root.destroy()
            return {"path": chosen} if chosen else {"cancelled": True}
        except Exception as exc:
            raise RuntimeError("no file picker on this machine - type the path instead (%s)" % exc)

    def _sfx_outdir(self, video_path, override=""):
        if override:
            d = Path(override)
        else:
            d = Path(video_path).parent
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _sfx_generate_stream(self, raw):
        """Generate a soundtrack for a video and save it as its OWN audio file.

        generate_soundtrack(..., output_path=...) writes audio only
        (audio_file_only=True inside MMAudio), so the result is a separate
        track ready for a DAW - muxing is a separate, optional step.
        """
        def frame(status, msg="", path="", muxed="", progress=0.0):
            return json.dumps({"cmd": "sfx", "data": {
                "status": status, "message": msg, "path": path, "muxed": muxed,
                "progress": round(progress, 3), "t": time.time()}})

        try:
            data = (json.loads(raw or "{}") or {}).get("data") or {}
        except Exception as exc:
            yield frame("error", "bad request: %s" % exc)
            return

        if not data.get("enabled", True):
            yield frame("idle", "Sound design is switched off.")
            return

        video = str(data.get("video_path") or "").strip()
        if not video or not os.path.isfile(video):
            yield frame("error", "No video selected. Pick a rendered file, or use the last output.")
            return

        method = str(data.get("method") or "").strip()
        if not method:
            yield frame("error", "Choose a soundtrack method.")
            return

        prompt = str(data.get("prompt") or "")
        neg = self._sfx_negative(str(data.get("negative_prompt") or ""), data)
        seed = int(data.get("seed") or -1)
        duration = float(data.get("duration") or 0)
        outdir = self._sfx_outdir(video, str(data.get("out_dir") or "").strip())
        stem = Path(video).stem
        name = str(data.get("out_name") or "").strip() or ("%s_sfx" % stem)
        safe = "".join(c for c in name if c.isalnum() or c in "-_ .").strip() or ("%s_sfx" % stem)
        out_audio = outdir / ("%s.m4a" % safe)

        yield frame("running", "Loading the audio model and analysing %s..." % Path(video).name, progress=0.1)
        try:
            ap = self._audio_api()
            trace("sfx: method=%s video=%s -> %s" % (method, video, out_audio))
            produced = ap.generate_soundtrack(
                method,
                video_path=video,
                prompt=prompt,
                negative_prompt=neg,
                seed=seed,
                duration=duration,
                output_path=str(out_audio),
                verbose_level=1,
            )
        except Exception as exc:
            trace("sfx FAILED: %s" % exc)
            yield frame("error", str(exc))
            return

        produced = str(produced or out_audio)
        if not os.path.isfile(produced):
            yield frame("error", "the processor reported success but wrote no file")
            return
        size = os.path.getsize(produced)
        trace("sfx wrote %s (%.1f MB)" % (produced, size / 1048576.0))

        muxed = ""
        if data.get("also_mux"):
            try:
                muxed = self._mux_audio_into_video(video, produced, outdir, safe)
            except Exception as exc:
                trace("sfx mux failed: %s" % exc)
                yield frame("done", "Audio written, but muxing failed: %s" % exc, produced, "", 1.0)
                return

        yield frame("done", "Sound effects saved as a separate track (%.1f MB)." % (size / 1048576.0),
                    produced, muxed, 1.0)

    def _mux_audio_into_video(self, video, audio, outdir, stem):
        """Optional convenience copy with the new track muxed in. The separate
        audio file is always kept - it is the thing you take into a DAW."""
        out = Path(outdir) / ("%s_with_sfx%s" % (stem, Path(video).suffix or ".mp4"))
        import subprocess
        cmd = [self._ffmpeg(), "-y", "-i", str(video), "-i", str(audio),
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-shortest", str(out)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=1800)
        trace("muxed -> %s" % out)
        return str(out)

    def _sfx_mux(self, data):
        video = str(data.get("video_path") or "")
        audio = str(data.get("audio_path") or "")
        if not os.path.isfile(video) or not os.path.isfile(audio):
            raise ValueError("need an existing video and audio file")
        outdir = self._sfx_outdir(video, str(data.get("out_dir") or ""))
        return {"ok": True, "path": self._mux_audio_into_video(
            video, audio, outdir, Path(video).stem)}

    # ---------------- diagnostics ----------------
    def _diagnose(self):
        r = []
        # DOTTED access on purpose: _callback_uses_api_session() inspects
        # co_names, and getattr(self, "_wangp_session") puts the name in
        # co_consts instead - so the handler is never wrapped and the WanGP
        # queue never pumps. The task is admitted and then nothing happens.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        r.append("Python side:")
        r.append("  workspace: %s" % WORKSPACE)
        media = [f for f in MEDIA_DIR.glob("*") if f.is_file() and not f.name.endswith(".meta.json")]
        total = sum(f.stat().st_size for f in media)
        r.append("  media on disk: %d file(s), %.1f MB" % (len(media), total / 1048576.0))
        r.append("  project.json: %s" % ("present" if PROJECT_JSON.exists() else "NOT WRITTEN YET"))
        r.append("  WanGP session: %s" % (type(session).__name__ if session is not None else "NONE - generation impossible"))
        if session is not None:
            r.append("  submit_task: %s" % ("available" if callable(getattr(session, "submit_task", None)) else "MISSING"))
            r.append("  list_model_defs: %s" % ("available" if hasattr(session, "list_model_defs") else "MISSING"))
        models = self._list_h3_models()
        r.append("  H3 models matched: %s" % (", ".join(m["model_type"] for m in models) or "NONE"))
        raw = self._raw_model_defs()
        r.append("  Wan2GP knows %d model(s) in total:" % len(raw))
        for mid, mdef in raw:
            meta = mdef.get("metadata") or {}
            r.append("    %-52s arch=%-24s family=%-14s finetune=%s%s"
                     % (mid[:52], str(mdef.get("architecture"))[:24], str(meta.get("family"))[:14],
                        bool(meta.get("finetune")), "  <-- H3" if self._looks_like_h3(mid, mdef) else ""))
        if models:
            r.append("  reference limits: %s" % self._ref_limits(models[0]["model_type"]))
        r.append("  file serving: %s" % (self._file_base() or "unavailable - previews inline bytes"))
        r.append("  ffmpeg: %s" % self._ffmpeg())
        job = getattr(self, "_job", None)
        r.append("  active job: %s" % (type(job).__name__ if job is not None else "none"))
        for line in r:
            trace(line.strip())
        return r

    def _print_env(self):
        import platform
        lines = [
            "python %s on %s" % (platform.python_version(), platform.platform()),
            "plugin %s at %s" % (PLUGIN_VERSION, PLUGIN_DIR),
            "workspace %s" % WORKSPACE,
        ]
        try:
            import gradio as _g
            lines.append("gradio %s" % getattr(_g, "__version__", "?"))
        except Exception:
            pass
        for line in lines:
            trace(line)
        return lines

    # ---------------- opening a saved project ----------------
    def _browse_zip(self):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Open an H3 Director project",
                filetypes=[("H3 Director project", "*.zip"), ("All files", "*.*")])
            root.destroy()
            return {"path": chosen} if chosen else {"cancelled": True}
        except Exception as exc:
            trace("browse_zip unavailable: %s" % exc)
            raise RuntimeError("no file picker on this machine - type the path instead")

    def _list_projects(self, data):
        folder = Path((data.get("dir") or "").strip() or (PLUGIN_DIR / "projects"))
        out = []
        if folder.is_dir():
            for f in sorted(folder.glob("*.zip"), key=lambda x: -x.stat().st_mtime):
                out.append({"name": f.stem, "path": str(f), "bytes": f.stat().st_size,
                            "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))})
        return {"projects": out[:60], "dir": str(folder)}

    def _open_project_zip(self, data):
        """Opening a project WIPES the workspace and unpacks the zip into it.
        The zip carries everything, so there is nothing to ask about."""
        src = Path(str(data.get("path") or ""))
        if not src.is_file():
            raise ValueError("no such project file: %s" % src)
        with zipfile.ZipFile(src) as zf:
            names = zf.namelist()
            if "project.json" not in names:
                raise ValueError("%s is not an H3 Director project (no project.json)" % src.name)
            raw = zf.read("project.json").decode("utf-8")
            payload = json.loads(raw)
            app = payload.get("app")
            if app and app != PLUGIN_ID:
                raise ValueError("that project belongs to '%s', not %s" % (app, PLUGIN_ID))

            for d in (MEDIA_DIR, DERIVED_DIR):
                for f in d.glob("*"):
                    if f.is_file():
                        f.unlink()
            for p2 in (PROJECT_JSON, PROJECT_BAK):
                if p2.exists():
                    p2.unlink()
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)

            restored = 0
            for n in names:
                if n.startswith("media/") and not n.endswith("/"):
                    dest = MEDIA_DIR / Path(n).name
                    dest.write_bytes(zf.read(n))
                    restored += 1
            _atomic_write_json(PROJECT_JSON, payload)
        trace("opened %s: %d media file(s) restored" % (src.name, restored))
        media, missing = self._media_manifest(payload)
        return {"ok": True, "payload": payload, "media": media, "missing": missing,
                "fileBase": self._file_base(), "restored": restored, "name": src.stem}

    # ---------------- workspace hygiene ----------------
    def _new_project(self, data):
        """A new project wipes the workspace. Only the project currently open
        is ever on disk, so nothing accumulates."""
        if not data.get("confirmed"):
            return {"ok": False, "needs_confirm": True}
        return self._clear_all({"confirmed": True})

    def _prune_media(self, data):
        """Delete media the current project.json does not reference.
        Never automatic - it is offered, and it reports what it removed."""
        if not PROJECT_JSON.exists():
            return {"ok": True, "removed": [], "freed": 0}
        payload = json.loads(PROJECT_JSON.read_text(encoding="utf-8"))
        keep, _ = self._media_manifest(payload)
        keep_ids = set(keep.keys())
        cutoff = time.time() - 600          # protect anything just added / undoable
        removed, freed = [], 0
        for f in sorted(MEDIA_DIR.glob("*")):
            if not f.is_file():
                continue
            mid = f.name.split(".")[0]
            if mid in keep_ids or f.stat().st_mtime > cutoff:
                continue
            if not data.get("confirmed"):
                removed.append(f.name)
                freed += f.stat().st_size
                continue
            freed += f.stat().st_size
            removed.append(f.name)
            f.unlink()
            trace("pruned %s" % f.name)
        if data.get("confirmed"):
            trace("prune: removed %d files, reclaimed %.1f MB" % (len(removed), freed / 1048576.0))
        return {"ok": True, "removed": removed, "freed": freed, "dry_run": not data.get("confirmed")}

    # ---------------- settings assembly (paths + flags live HERE) ----------------
    def _assemble_settings(self, plan):
        """Turn the UI's plan into a real WanGP settings dict.

        Two rules that cost the original plugin releases:
          * WanGP ABORTS if a flag promises a file that is not attached, so any
            unsatisfied letter must be stripped - LONGER composites first.
          * image_refs / image_start / image_end must be PATHS, not objects.
        """
        media = plan.get("media") or {}

        def path(mid):
            p = self._media_path(mid) if mid else None
            return str(p) if p else None

        def paths(ids):
            out = []
            for mid in (ids or []):
                p = path(mid)
                if p:
                    out.append(p)
                elif mid:
                    trace("assemble: media %s missing, dropped" % mid)
            return out

        prompt = str(plan.get("prompt") or "").strip()
        prompt = self._renumber_refs(prompt, plan)
        prompt = self._apply_audio_exclusions(prompt, plan, st_audio=media)
        if not prompt:
            raise ValueError(
                "Prompt is empty. Add a text prompt on the timeline, or a global "
                "prompt under Generation, before generating."
            )

        st = {
            "prompt": prompt,
            "multi_prompts_gen_type": plan.get("multi_prompts_gen_type") or "PW",
            "sliding_window_size": int(plan.get("sliding_window_size") or self._grid["WINDOW_DEFAULT"]),
            "sliding_window_overlap": int(plan.get("sliding_window_overlap") or self._grid["OVERLAP_DEFAULT"]),
        }
        for key in ("seed", "repeat_generation", "num_inference_steps", "guidance_phases",
                    "sample_solver", "flow_shift", "guidance_scale", "switch_threshold",
                    "attention_sparsity", "skip_steps_cache_type", "skip_steps_multiplier",
                    "skip_steps_start_step_perc", "override_attention", "resolution",
                    "temporal_upsampling",
                    "spatial_upsampling", "film_grain_intensity", "film_grain_saturation",
                    "self_refiner_setting", "min_frames_if_references",
                    "image_refs_relative_size", "keep_frames_video_source"):
            if plan.get(key) is not None:
                st[key] = plan[key]

        # pipeline.py raises on anything outside this set, and a Gradio label
        # ("Euler") is not a value ("euler"). Normalise, never pass through.
        _SOLVERS = {"euler": "euler", "er sde": "er_sde", "er_sde": "er_sde",
                    "res multistep": "res_multistep", "res_multistep": "res_multistep",
                    "ralston 2s": "ralston_2s", "ralston_2s": "ralston_2s",
                    "ralston 2s (~2x slower)": "ralston_2s"}
        raw_solver = str(st.get("sample_solver") or "euler").strip()
        solver = _SOLVERS.get(raw_solver.lower())
        if solver is None:
            solver = "euler"
            trace("unknown sample_solver %r, using euler" % raw_solver)
        elif solver != raw_solver:
            trace("sample_solver %r -> %r" % (raw_solver, solver))
        st["sample_solver"] = solver

        # "" is the no-cache sentinel, NOT "none".
        if str(st.get("skip_steps_cache_type") or "").lower() in ("none", "off"):
            st["skip_steps_cache_type"] = ""

        loras = [str(x) for x in (plan.get("activated_loras") or []) if x]
        if loras:
            st["activated_loras"] = loras
            st["loras_multipliers"] = self._lora_multipliers(plan)

        # ---- the model's own option groups (text encoder, VAE, priority) ----
        # One comma-joined string, one slot per group, in Wan2GP's own order.
        config_sel = self._config_selection(plan)
        if config_sel:
            st["config"] = config_sel
            trace("model config: %s" % config_sel)

        # ---- saved reference mods (RefMods) ----
        # A mod is a reference that was VAE-encoded once and saved; the RefMods
        # plugin owns the file format and the injection. All that travels from
        # here is the selection, in the custom_settings channel it reads.
        refmod_rows = plan.get("refmods") or []
        if refmod_rows:
            state = refmods.build_state(refmod_rows, plan.get("refmod_retention", 1.0))
            ok, why = refmods.available()
            if state and ok:
                custom = dict(st.get("custom_settings") or {})
                custom[refmods.SETTING_GENERATE] = state
                st["custom_settings"] = custom
                trace("refmods: %d selected (%s)"
                      % (len(refmod_rows),
                         ", ".join("%s@%.2f" % (r.get("name"), float(r.get("strength", 1)))
                                   for r in refmod_rows if isinstance(r, dict))))
                trace("refmods: only the FIRST sliding window receives them - "
                      "later windows continue from the previous window's frames")
            elif state:
                trace("refmods: %d selected but %s; generating without them"
                      % (len(refmod_rows), why))

        ref_images = paths(media.get("ref_images"))
        start_img = path(media.get("image_start"))
        end_img = path(media.get("image_end"))
        control = path(media.get("control_video"))
        ref_videos = paths(media.get("ref_videos"))[:2]
        song = path(media.get("audio_guide"))
        clip_audio = path(media.get("clip_audio"))
        ref_audio = paths(media.get("ref_audio"))[:2]

        # ---- image_prompt_type: S=start, E=end ----
        ipt = ""
        # V = Continue Video. H3 declares image_prompt_types_allowed "TSEVL",
        # and WanGP carries overlapping frames and the source audio across, so
        # a continuation reads as one take rather than a cut. This must be
        # added BEFORE image_prompt_type is stored, or it is silently dropped.
        cont = path(media.get("video_source"))
        if cont:
            st["video_source"] = cont
            ipt += "V"
            trace("continuation from %s" % os.path.basename(cont))
        if start_img:
            st["image_start"] = start_img
            ipt += "S"
        if end_img and end_img != start_img:
            st["image_end"] = end_img
            ipt += "E"
        if ipt:
            st["image_prompt_type"] = ipt

        # ---- video_prompt_type: I=image refs, G+V=control video, V=reference video ----
        vpt = ""
        if ref_images:
            st["image_refs"] = ref_images
            vpt += "I"
        if control:
            st["video_guide"] = control
            vpt += "GV"
            # *** A CONTROL VIDEO IS IGNORED ENTIRELY AT denoising_strength 1.0.
            # pipeline.py:625
            #   video_to_video = control_video and not audio_from_control_video
            #                    and (float(denoising_strength) < 1.0 or input_masks is not None)
            # and the clip's pixels are encoded ONLY inside `if video_to_video:`.
            # At 1.0 with no mask the clip is accepted, passed to the model and
            # never looked at - audio and lip sync still work, so it looks
            # connected while motion transfer silently does nothing. Nothing
            # here ever sent denoising_strength, so it defaulted to 1.0.
            ds = plan.get("denoising_strength")
            if ds is None:
                ds = 0.75
            try:
                ds = float(ds)
            except Exception:
                ds = 0.75
            if ds >= 1.0:
                trace("denoising_strength %.2f would make the control video a NO-OP; "
                      "clamping to 0.95. Use 0.5-0.85 (lower follows the clip more closely)." % ds)
                ds = 0.95
            st["denoising_strength"] = ds
            trace("control video: denoising_strength=%.2f" % ds)
        elif ref_videos:
            st["video_guide"] = ref_videos[0]
            if len(ref_videos) > 1:
                st["video_guide2"] = ref_videos[1]
            vpt += "V+-U" if len(ref_videos) > 1 else "V-U"
        if vpt:
            st["video_prompt_type"] = vpt

        # ---- audio_prompt_type: A=song drives lip sync, B=voice reference ----
        apt = ""
        guide = song or clip_audio
        if song and clip_audio and song != clip_audio:
            mixed = self._mix_audio([song, clip_audio])
            guide = mixed or song
        if guide:
            st["audio_guide"] = guide
            apt += "A"
        if ref_audio:
            st["audio_guide2"] = ref_audio[0]
            apt += "B"
        # The audio mode is DERIVED from what is actually attached. An explicit
        # choice from the UI overrides it -- someone may want a voice reference
        # ignored, or the model to generate the audio even with a track on the
        # timeline. Letters whose media is missing are stripped further down by
        # _strip_unsatisfied, so an override can never promise what is not there.
        want_apt = plan.get("audio_prompt_type")
        if isinstance(want_apt, str) and want_apt != apt and plan.get("audio_prompt_type_set"):
            trace("audio source: %r chosen by hand (attached media suggests %r)"
                  % (want_apt, apt))
            apt = want_apt
        if apt:
            st["audio_prompt_type"] = apt

        for key in ("audio_guide", "audio_guide2", "video_guide", "video_guide2",
                    "image_start", "image_end"):
            v = st.get(key)
            if isinstance(v, str) and v:
                ext = os.path.splitext(v)[1].lower()
                if ext not in (set(IMAGE_EXTS) | set(VIDEO_EXTS) | set(AUDIO_EXTS)):
                    trace("dropping %s: %r is not a media file" % (key, os.path.basename(v)))
                    st.pop(key, None)

        guide = st.get("video_guide")
        if guide and st.get("video_length"):
            n = int(st["video_length"])
            valid = ((n - 5) // 17) * 17 + 5
            if valid != n:
                trace("control frames: %d is not 5+17k; WanGP will trim to %d (%d frame(s) lost)"
                      % (n, valid, n - valid))

        st = self._strip_unsatisfied(st)
        st["model_type"] = self._validate_model_type(self._pick_model_type(plan))
        st["base_model_type"] = st["model_type"]
        if ref_images:
            trace("reference sheets: %d at %s%% relative size"
                  % (len(ref_images), st.get("image_refs_relative_size", 100)))
        trace("assemble: vpt=%r apt=%r ipt=%r refs=%d prompt=%d chars"
              % (st.get("video_prompt_type", ""), st.get("audio_prompt_type", ""),
                 st.get("image_prompt_type", ""), len(ref_images), len(prompt)))
        return st

    def _preview_prompt(self, data):
        """Build the settings exactly as Generate would and report the FINAL
        prompt, so what is previewed is what gets submitted."""
        plan = dict(data.get("settings") or {})
        before = str(plan.get("prompt") or "")
        st = self._assemble_settings(plan)
        target = int(data.get("target_frames") or 0)
        if target:
            _w = int(st.get("sliding_window_size") or self._grid["WINDOW_DEFAULT"])
            _o = int(st.get("sliding_window_overlap") or self._grid["OVERLAP_DEFAULT"])
            st["video_length"] = solve_video_length(target, _w, _o, self._grid)
            st["prompt"] = self._fix_duration_tags(
                st.get("prompt", ""), target, _w, _o,
                float(plan.get("fps") or 24))
        self._log_prompt("PREVIEW", st)
        return {
            "prompt": st.get("prompt", ""),
            "model_type": st.get("model_type", ""),
            "video_prompt_type": st.get("video_prompt_type", ""),
            "audio_prompt_type": st.get("audio_prompt_type", ""),
            "image_prompt_type": st.get("image_prompt_type", ""),
            "refs": len(st.get("image_refs") or []),
            "injected": int(plan.get("numbering_offset") or plan.get("injected_count") or 0),
            "renumbered": st.get("prompt", "") != before,
            "video_length": st.get("video_length", 0),
        }

    def _check_prompt_blocks(self, prompt):
        """With multi_prompts_gen_type "PW", Wan2GP splits the prompt on BLANK
        LINES - one block per window. A block without a /duration tag becomes a
        window with no frames allocated, which fails as "Sliding window N would
        generate no frame". Catch it here rather than after the model loads."""
        blocks = [b for b in re.split(r"\n\s*\n", (prompt or "").replace("\r\n", "\n")) if b.strip()]
        if len(blocks) <= 1:
            return True, ""
        missing = [i + 1 for i, b in enumerate(blocks) if not self._DURATION_TAG.search(b)]
        if missing:
            return False, (
                "Prompt block%s %s ha%s no [/duration=] tag. Wan2GP treats every "
                "blank-line-separated block as its own sliding window, so this "
                "would fail with 'Sliding window %d would generate no frame'."
                % ("s" if len(missing) > 1 else "", ", ".join(map(str, missing)),
                   "ve" if len(missing) > 1 else "s", missing[0]))
        trace("prompt blocks: %d, each with a duration tag" % len(blocks))
        return True, ""

    def _log_prompt(self, label, st):
        """Print the exact submitted prompt. Without this there is no way to
        tell from the terminal whether renumbering actually took effect."""
        trace("---------- %s: prompt as sent (%d chars) ----------"
              % (label, len(str(st.get("prompt") or ""))))
        for line in str(st.get("prompt") or "").split("\n"):
            trace("  | %s" % line)
        trace("  | model=%s length=%s vpt=%r apt=%r ipt=%r refs=%d"
              % (st.get("model_type"), st.get("video_length"),
                 st.get("video_prompt_type", ""), st.get("audio_prompt_type", ""),
                 st.get("image_prompt_type", ""), len(st.get("image_refs") or [])))
        # Sampling, spelled out. An 8-step job that should have been 20 was
        # invisible here, so "it generates as if PDD were still on" could only
        # be found by reading the UI state rather than the log.
        _loras = st.get("activated_loras") or st.get("loras") or []
        trace("  | steps=%s solver=%s guidance=%s phases=%s flow_shift=%s%s"
              % (st.get("num_inference_steps"), st.get("sample_solver"),
                 st.get("guidance_scale", st.get("guidance")),
                 st.get("guidance_phases"), st.get("flow_shift"),
                 ("  loras=%s mult=%r" % (len(_loras), st.get("loras_multipliers", ""))) if _loras else "  loras=none"))
        if st.get("video_source"):
            src = st["video_source"]
            trace("  | video_source=%s (%.2fs) keep_frames_video_source=%r frames_positions=%r"
                  % (os.path.basename(src), self._ffprobe_duration(src),
                     st.get("keep_frames_video_source", ""), st.get("frames_positions", "")))
        trace("---------- end %s ----------" % label)

    # Directives appended to the SENT prompt when the model is generating its
    # own audio. H3 has no negative prompt, so exclusions have to be stated in
    # the prompt itself - and only what is sent is changed, never what is typed.
    _GEN_EXCLUDE = {
        "gen_no_music": "Do not generate any music, score, singing or instrumental backing.",
        "gen_no_speech": "Do not generate any speech, dialogue, narration or singing.",
        "gen_no_ambience": "Do not generate room tone, ambience or background noise.",
        "gen_no_effects": "Do not generate sound effects or foley.",
    }

    def _apply_audio_exclusions(self, prompt, plan, st_audio=None):
        """Add the directives INSIDE each window block, never after it.

        With multi_prompts_gen_type "PW", split_prompt_units() divides the
        prompt on BLANK LINES - one block per window. A directive appended to
        the end of the whole prompt therefore becomes an extra window with no
        /duration, and the scheduler fails with "Sliding window N would
        generate no frame". So each block gets its own copy, on the last line.
        """
        flags = [k for k in self._GEN_EXCLUDE if plan.get(k)]
        if not flags:
            return prompt
        media = st_audio if st_audio is not None else (plan.get("media") or {})
        if media.get("audio_guide") or media.get("clip_audio"):
            trace("audio exclusions skipped: an audio source is attached, so "
                  "nothing is generated to exclude")
            return prompt

        directive = " ".join(self._GEN_EXCLUDE[k] for k in flags)
        blocks = re.split(r"\n\s*\n", prompt.replace("\r\n", "\n"))
        out_blocks = []
        added = 0
        for b in blocks:
            body = b.rstrip()
            if not body.strip():
                continue
            if directive not in body:
                body = body + " " + directive
                added += 1
            out_blocks.append(body)
        trace("audio exclusions added inside %d window block(s) (never as a new block)" % added)
        return "\n\n".join(out_blocks)

    def _renumber_refs(self, prompt, plan):
        """Shift image numbers in the prompt so the user never has to.

        Injected frames and reference sheets share image_refs, split BY COUNT:
        the first N entries are the injected frames, the rest are the sheets.
        So adding an injected frame pushes every reference sheet's number up by
        one. Rather than make the user rewrite prompts every time, the STORED
        prompt keeps its original numbering and only what is SENT is adjusted.

        This is not a user choice: it is a no-op unless something actually
        occupies a numbered slot ahead of the sheets. A prompt for the first
        window, or one with no start/end image and no injected frames, comes
        through untouched -- there is nothing to shift it past.
        """
        media = plan.get("media") or {}
        # Anything occupying a numbered slot AHEAD of the reference sheets:
        # the start image, the end image, and any injected frames. The UI sends
        # the total as numbering_offset; injected_count is the older field.
        offset = plan.get("numbering_offset")
        if offset is None:
            offset = int(plan.get("injected_count") or 0)
            offset += 1 if media.get("image_start") else 0
            offset += 1 if media.get("image_end") else 0
        offset = int(offset or 0)
        refs = len([m for m in (media.get("ref_images") or []) if m])
        if offset <= 0 or refs <= 0:
            return prompt
        injected = offset

        pattern = re.compile(r"(\[\s*image\s*|<\s*Picture\s*)(\d+)(\s*\]|\s*>)", re.IGNORECASE)
        shifted = []

        def bump(m):
            n = int(m.group(2))
            new = n + injected
            shifted.append("%d->%d" % (n, new))
            return "%s%d%s" % (m.group(1), new, m.group(3))

        out = pattern.sub(bump, prompt)
        if shifted:
            trace("renumbered %d image reference(s), offset %d (start/end/injected ahead of the sheets): %s"
                  % (len(shifted), offset, ", ".join(shifted[:10])))
        return out

    def _strip_unsatisfied(self, st):
        """Drop flags whose file is not attached, and ALWAYS send the key.

        Removing the key entirely is not the same as clearing it.
        clean_settings() does
            merged = get_factory_settings(model_type)
            merged.update({k: v for k, v in params.items() if v is not None ...})
        so an ABSENT key falls back to the model's factory default - and H3's
        default audio_prompt_type is "A", which then fails validation with
        "You must provide an Audio Source". An explicit "" overrides it.

        Empty audio is a valid mode: with no source the model GENERATES the
        audio, which is how sound effects get made.
        """
        vpt = st.get("video_prompt_type", "") or ""
        if not st.get("image_refs"):
            vpt = vpt.replace("I", "")
        if not st.get("video_guide"):
            for token in ("V+-U", "V-U", "GV", "DV", "V"):   # longest first
                vpt = vpt.replace(token, "")
        st["video_prompt_type"] = vpt

        apt = st.get("audio_prompt_type", "") or ""
        if not st.get("audio_guide"):
            apt = apt.replace("A", "").replace("K", "")
        if not st.get("audio_guide2"):
            apt = apt.replace("B", "")
        st["audio_prompt_type"] = apt
        if not apt:
            st.pop("audio_guide", None)
            st.pop("audio_guide2", None)
            trace("no audio source: audio_prompt_type='' (the model will GENERATE the audio)")

        ipt = st.get("image_prompt_type", "") or ""
        if not st.get("image_start"):
            ipt = ipt.replace("S", "")
        if not st.get("image_end"):
            ipt = ipt.replace("E", "")
        if not st.get("video_source"):
            ipt = ipt.replace("V", "")
        st["image_prompt_type"] = ipt
        return st

    def _mix_audio(self, paths_in):
        """Mix the song and the clip's own audio into one guide track.
        Losing a layer beats failing the generation, so any error falls back."""
        real = [p for p in paths_in if p and os.path.exists(p)]
        if len(real) < 2:
            return real[0] if real else None
        try:
            exe = self._ffmpeg()
            DERIVED_DIR.mkdir(parents=True, exist_ok=True)
            out = DERIVED_DIR / ("mix_%s.wav"
                                 % hashlib.sha256("|".join(real).encode()).hexdigest()[:12])
            if out.exists():
                return str(out)
            cmd = [exe]
            for r in real:
                cmd += ["-i", r]
            cmd += ["-filter_complex", "amix=inputs=%d:duration=longest:normalize=0" % len(real),
                    "-ac", "2", "-y", str(out)]
            import subprocess
            subprocess.run(cmd, check=True, capture_output=True, timeout=600)
            trace("mixed %d audio layers -> %s" % (len(real), out.name))
            return str(out)
        except Exception as exc:
            trace("audio mix failed (%s); using the first layer only" % exc)
            return real[0]

    def _ffmpeg(self):
        try:
            from shared.utils.video_decode import resolve_media_binary
            found = resolve_media_binary("ffmpeg")
            if found:
                return found
        except Exception:
            pass
        return shutil.which("ffmpeg") or "ffmpeg"

    # ---------------- apply to Wan2GP's generator ----------------
    def _push_settings_to_wangp(self, settings, state):
        """Hand settings over the way WanGP's own Load Settings button does.

        load_settings_from_file(state, file_path) takes a PATH to a JSON file,
        not a dict. Image fields STAY IN THE JSON as string paths - WanGP reads
        them back itself, and popping them out deletes the start and reference
        images from everything that gets applied.
        """
        lsf = getattr(self, "load_settings_from_file", None)
        if not callable(lsf):
            raise RuntimeError("this WanGP build does not expose load_settings_from_file")
        out = dict(settings)
        for k in ("image_refs", "image_start", "image_end"):
            v = out.get(k)
            if v is not None:
                out[k] = [str(x) for x in v] if isinstance(v, (list, tuple)) else str(v)
        import tempfile
        path = os.path.join(tempfile.gettempdir(), "h3_director2_apply_settings.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, default=str)
        ret = lsf(state, path)
        refresh_val, target_val = None, None
        if isinstance(ret, (list, tuple)):
            refresh_val = ret[0] if len(ret) > 0 else None
            target_val = ret[1] if len(ret) > 1 else None
        trace("apply.loader_ret refresh=%s target=%s"
              % (type(refresh_val).__name__,
                 target_val if isinstance(target_val, str) else "update"))
        return refresh_val, target_val

    def _apply_stage1(self, raw, state=None):
        """Seed the settings, THEN switch - switch_to_model() rebuilds the form
        from state, so settings pushed afterwards are lost."""
        self._apply_refresh = None
        self._apply_status = ""
        try:
            data = (json.loads(raw or "{}") or {}).get("data") or {}
            settings = self._assemble_settings(data.get("settings") or {})
            settings = self._normalize_audio_guide(settings)
            target = int(data.get("target_frames") or 0)
            if target:
                _w = int(settings.get("sliding_window_size") or self._grid["WINDOW_DEFAULT"])
                _o = int(settings.get("sliding_window_overlap") or self._grid["OVERLAP_DEFAULT"])
                settings["video_length"] = solve_video_length(target, _w, _o, self._grid)
                settings["prompt"] = self._fix_duration_tags(
                    settings.get("prompt", ""), target, _w, _o,
                    float((data.get("settings") or {}).get("fps") or 24))
            mt = settings.get("model_type")

            # Inject the image objects into live state: WanGP's JSON load does
            # not rehydrate image_refs / image_start / image_end by itself.
            try:
                if isinstance(state, dict) and mt:
                    slot = state.setdefault("all_settings", {}).setdefault(mt, {})
                    slot.update(settings)
            except Exception as exc:
                trace("apply: state seed failed: %s" % exc)

            refresh_val, target_val = self._push_settings_to_wangp(settings, state)
            self._apply_status = "Applied %s to the Video Generator." % mt

            # A STRING target means wgp took the model-switch branch and has
            # already staged everything; firing a refresh as well stomps it.
            if isinstance(target_val, str) and target_val:
                self._apply_refresh = None
                trace("apply.stage1.switching model=%s" % target_val.split("|")[0])
                return target_val, json.dumps({"cmd": "apply", "data": {"ok": True, "model": mt}})
            self._apply_refresh = refresh_val
            trace("apply.stage1.no_switch (already on the model)")
            return gr.update(), json.dumps({"cmd": "apply", "data": {"ok": True, "model": mt}})
        except Exception as exc:
            trace("apply FAILED: %s" % exc)
            self._apply_status = str(exc)
            return gr.update(), json.dumps({"cmd": "apply", "data": {"ok": False, "error": str(exc)}})

    def _apply_stage2(self, state=None):
        goto = getattr(self, "goto_media_tab", None)
        if callable(goto):
            try:
                return goto(state)
            except Exception as exc:
                trace("goto_media_tab failed: %s" % exc)
        return gr.update()

    def _apply_stage3(self):
        """Refresh ONLY when the model did not change, and always suppress the
        loader's model target here - stage 1 already switched."""
        refresh = self._apply_refresh
        self._apply_refresh = None
        msg = json.dumps({"cmd": "apply", "data": {"ok": True, "status": self._apply_status}})
        if refresh is None:
            return gr.update(), gr.update(), msg
        return (refresh if isinstance(refresh, str) else str(time.time())), gr.update(), msg

    def _apply_fallback(self, raw, state=None):
        try:
            data = (json.loads(raw or "{}") or {}).get("data") or {}
            settings = self._assemble_settings(data.get("settings") or {})
            self._push_settings_to_wangp(settings, state)
            return json.dumps({"cmd": "apply", "data": {"ok": True,
                    "status": "Settings sent. Open the Video Generator tab."}})
        except Exception as exc:
            return json.dumps({"cmd": "apply", "data": {"ok": False, "error": str(exc)}})

    # ---------------- media restore ----------------
    def _meta_path(self, media_id):
        return MEDIA_DIR / ("%s.meta.json" % media_id)

    def _put_media_meta(self, data):
        """The browser derives duration, thumbnail and waveform peaks once, at
        upload. We persist them beside the file so a reload restores everything
        WITHOUT re-reading the media."""
        media_id = str(data.get("mediaId") or "")
        if not media_id:
            raise ValueError("mediaId required")
        meta = {
            "mediaId": media_id,
            "name": str(data.get("name") or ""),
            "kind": str(data.get("kind") or ""),
            "durationSec": float(data.get("durationSec") or 0),
            "width": int(data.get("width") or 0),
            "height": int(data.get("height") or 0),
            "sampleRate": int(data.get("sampleRate") or 0),
            "channels": int(data.get("channels") or 0),
            "thumb": str(data.get("thumb") or ""),
            "peaks": list(data.get("peaks") or []),
            "file": str(data.get("file") or ""),
        }
        _atomic_write_json(self._meta_path(media_id), meta)
        return {"ok": True}

    def _sweep_sidecar_strays(self):
        """Remove <id>.meta.json.bak / .tmp left by earlier builds - they were
        being resolved as media and passed to WanGP."""
        removed = 0
        for f in MEDIA_DIR.glob("*"):
            n = f.name.lower()
            if f.is_file() and (n.endswith(".meta.json.bak") or n.endswith(".tmp")):
                try:
                    f.unlink()
                    removed += 1
                except Exception as exc:
                    trace("could not remove stray %s: %s" % (f.name, exc))
        if removed:
            trace("removed %d stray sidecar file(s) that could be mistaken for media" % removed)
        return removed

    def _media_manifest(self, payload):
        """Every mediaId the project references, with its stored meta.
        Reports which ones have no bytes on disk instead of failing quietly."""
        wanted = set()

        def walk(node):
            if isinstance(node, dict):
                mid = node.get("mediaId")
                if isinstance(mid, str) and mid:
                    wanted.add(mid)
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(payload)
        out, missing = {}, []
        for mid in sorted(wanted):
            src = self._media_path(mid)
            if src is None:
                missing.append(mid)
                continue
            meta = {}
            mp = self._meta_path(mid)
            if mp.exists():
                try:
                    meta = json.loads(mp.read_text(encoding="utf-8"))
                except Exception as exc:
                    trace("meta unreadable for %s: %s" % (mid, exc))
            meta["mediaId"] = mid
            meta["file"] = src.name
            meta["path"] = str(src)
            meta["bytes"] = src.stat().st_size
            out[mid] = meta
        trace("media manifest: %d resolved, %d missing" % (len(out), len(missing)))
        return out, missing

    def _media_bytes(self, data):
        """On-demand bytes for the preview window, when the served URL is not
        reachable. Refused above a sane size so we never push a huge video
        through the bridge."""
        mid = str(data.get("mediaId") or "")
        src = self._media_path(mid)
        if src is None:
            raise ValueError("no media on disk for %s" % mid)
        size = src.stat().st_size
        limit = int(data.get("limit") or 64 * 1024 * 1024)
        if size > limit:
            raise ValueError("%s is %.1f MB - too large to inline; open it from %s"
                             % (src.name, size / 1048576.0, src))
        return {"mediaId": mid, "name": src.name, "bytes": size,
                "b64": base64.b64encode(src.read_bytes()).decode("ascii")}

    def _file_base(self):
        """Gradio serves files under /gradio_api/file=<path>, but only for
        allowed paths. Try to register ours; report whether it worked."""
        if getattr(self, "_served", None) is not None:
            return self._served
        self._served = ""
        try:
            import gradio as _gr
            fn = getattr(_gr, "set_static_paths", None)
            if callable(fn):
                fn(paths=[str(MEDIA_DIR)])
                self._served = "/gradio_api/file="
                trace("media served via %s%s" % (self._served, MEDIA_DIR))
        except Exception as exc:
            trace("static path registration failed (%s); preview will inline bytes" % exc)
        return self._served

    # ---------------- DAW export ----------------
    def _export_daw(self, data):
        fmt = str(data.get("format") or "reaper").lower()
        name = str(data.get("name") or "session").strip()
        safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip() or "session"
        target = Path((data.get("dir") or "").strip() or (PLUGIN_DIR / "exports"))
        target.mkdir(parents=True, exist_ok=True)

        fps = float(data.get("fps") or 24.0)
        segs = list(data.get("segments") or [])
        include = data.get("include") or {}

        # Copy referenced media next to the session so the DAW can resolve it.
        media_out = target / ("%s_media" % safe)
        placed = []
        for seg in segs:
            if seg.get("track") not in ("audio", "clipaudio"):
                continue
            if seg.get("track") == "clipaudio" and not include.get("previewMix", True):
                continue
            if seg.get("track") == "clipaudio" and seg.get("muted"):
                continue
            src = self._media_path(seg.get("mediaId"))
            if not src:
                continue
            media_out.mkdir(parents=True, exist_ok=True)
            dest = media_out / src.name
            if not dest.exists():
                shutil.copy2(src, dest)
            placed.append((seg, dest))

        markers = self._markers(segs, fps)
        if fmt == "reaper":
            out = target / ("%s.RPP" % safe)
            out.write_text(self._rpp(safe, fps, placed, markers, media_out), encoding="utf-8")
        elif fmt == "markers_csv":
            out = target / ("%s.csv" % safe)
            rows = ["#,Name,Start,End,Length"]
            for i, (t, label) in enumerate(markers, 1):
                rows.append("M%d,%s,%s,%s,0" % (i, label.replace(",", " "), _tc(t), _tc(t)))
            out.write_text("\n".join(rows) + "\n", encoding="utf-8")
        elif fmt == "audacity":
            out = target / ("%s.txt" % safe)
            out.write_text("".join("%.6f\t%.6f\t%s\n" % (t, t, label) for t, label in markers), encoding="utf-8")
        elif fmt == "edl":
            out = target / ("%s.edl" % safe)
            lines = ["TITLE: %s" % safe, "FCM: NON-DROP FRAME", ""]
            for i, (t, label) in enumerate(markers, 1):
                lines.append("%03d  AX       V     C        %s %s %s %s" % (i, _tc(t, fps), _tc(t, fps), _tc(t, fps), _tc(t, fps)))
                lines.append("* FROM CLIP NAME: %s" % label)
            out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        else:
            raise ValueError("unknown export format '%s'" % fmt)

        trace("export %s -> %s (%d markers, %d audio items)" % (fmt, out, len(markers), len(placed)))
        return {"ok": True, "path": str(out), "markers": len(markers), "items": len(placed)}

    def _media_path(self, media_id):
        """The media file itself - never a sidecar.

        This used to exclude only ".meta.json", so "<id>.meta.json.bak" slipped
        through and was handed to WanGP as audio_guide, which then died inside
        librosa with "Format not recognised". Whitelist real media extensions
        instead of trying to blacklist every sidecar shape.
        """
        if not media_id:
            return None
        allowed = set(IMAGE_EXTS) | set(VIDEO_EXTS) | set(AUDIO_EXTS)
        # Accept a real path as well as an id: extracted bridge frames and
        # anything picked from disk are referenced by path, not by mediaId.
        try:
            cand = Path(str(media_id))
            if cand.is_absolute() and cand.is_file() and cand.suffix.lower() in allowed:
                return cand
        except Exception:
            pass
        if any(sep in str(media_id) for sep in ("/", "\\")):
            return None
        best = None
        for f in MEDIA_DIR.glob("%s.*" % media_id):
            if not f.is_file():
                continue
            name = f.name.lower()
            if ".meta.json" in name or name.endswith(".bak") or name.endswith(".tmp"):
                continue
            if f.suffix.lower() not in allowed:
                continue
            if best is None:
                best = f
        return best

    def _markers(self, segs, fps):
        """A marker at every shot change, so the beats line up in the DAW."""
        out = []
        for seg in sorted(segs, key=lambda x: x.get("start", 0)):
            if seg.get("track") != "video":
                continue
            out.append((float(seg.get("start", 0)) / fps, str(seg.get("title") or seg.get("kind") or "shot")))
        return out

    def _rpp(self, name, fps, placed, markers, media_out):
        """Minimal but valid Reaper project. Audio sits at 0 so it lines up
        with the timeline exactly; one track per timeline lane."""
        L = []
        L.append('<REAPER_PROJECT 0.1 "7.0" %d' % int(time.time()))
        L.append("  RIPPLE 0")
        L.append("  TEMPO 120 4 4")
        L.append('  VIDEO_CONFIG 0 0 %g' % fps)
        for i, (t, label) in enumerate(markers, 1):
            L.append('  MARKER %d %.6f "%s" 0 0 1 B' % (i, t, label.replace('"', "'")))
        by_track = {}
        for seg, dest in placed:
            by_track.setdefault(seg.get("track"), []).append((seg, dest))
        for track_id, items in by_track.items():
            L.append("  <TRACK")
            L.append('    NAME "%s"' % ("Guidance music" if track_id == "audio" else "Clip audio"))
            L.append("    VOLPAN 1 0 -1 -1 1")
            for seg, dest in items:
                start = float(seg.get("start", 0)) / fps
                length = float(seg.get("length", 0)) / fps
                L.append("    <ITEM")
                L.append("      POSITION %.6f" % start)
                L.append("      LENGTH %.6f" % max(0.01, length))
                L.append('      NAME "%s"' % str(seg.get("fileName") or dest.name).replace('"', "'"))
                L.append("      <SOURCE %s" % _rpp_src(dest))
                L.append('        FILE "%s"' % (media_out.name + "/" + dest.name))
                L.append("      >")
                L.append("    >")
            L.append("  >")
        L.append(">")
        return "\n".join(L) + "\n"

    # ---------------- folder picker ----------------
    def _browse_dir(self):
        """Native folder dialog on the machine running Wan2GP (it is local)."""
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askdirectory(title="Choose a folder for H3 Director projects")
            root.destroy()
            if chosen:
                trace("browse_dir -> %s" % chosen)
                return {"dir": chosen}
            return {"cancelled": True}
        except Exception as exc:
            trace("browse_dir unavailable: %s" % exc)
            raise RuntimeError("no folder picker on this machine - type the path instead")

    # ---------------- generation ----------------
    # ---------------- long timelines, rendered in groups ----------------

    def _audio_slice(self, src, start_sec, length_sec):
        """A piece of the soundtrack, for one group.

        Each group is its own Wan2GP job, and a job always starts its audio
        guide at 0:00. Without slicing, every group would be driven by the
        opening of the song and the lip sync would reset at each boundary.
        """
        src = Path(src)
        DERIVED_DIR.mkdir(parents=True, exist_ok=True)
        out = DERIVED_DIR / ("grpaud_%s_%.3f_%.3f%s"
                           % (src.stem, float(start_sec), float(length_sec), src.suffix or ".wav"))
        if out.exists():
            return str(out)
        import subprocess
        subprocess.run([self._ffmpeg(), "-y", "-ss", "%.4f" % float(start_sec),
                        "-t", "%.4f" % float(length_sec), "-i", str(src),
                        "-vn", "-c:a", "pcm_s16le", str(out)],
                       check=True, capture_output=True, timeout=1800)
        return str(out)

    def _release_model(self):
        """Wan2GP's own "unload everything" -- the Configuration tab button.

        Drops the model, frees the offload object, flushes torch's caches and
        empties CUDA, and marks the model for reload. Between groups this is
        what makes each group start from the same clean slate as a fresh run,
        rather than inheriting whatever the last one left behind. It costs a
        model reload at the start of the next group.
        """
        try:
            import wgp
            fn = getattr(wgp, "release_model", None)
            if not callable(fn):
                trace("release between groups: this WanGP has no release_model()")
                return False
            fn()
            trace("released the model between groups (%s)" % (self._vram_note() or "no GPU"))
            return True
        except Exception as exc:
            trace("release between groups failed (%s); continuing" % exc)
            return False

    def _group_plan(self, window_frames, per_group):
        """Split the windows into groups of at most `per_group` windows.

        Returns [{"windows": [frames...], "frames": n, "start": first_frame}].
        """
        groups, cur, start, at = [], [], 0, 0
        per = max(1, int(per_group))
        for n in window_frames:
            cur.append(int(n))
            at += int(n)
            if len(cur) >= per:
                groups.append({"windows": cur, "frames": sum(cur), "start": start})
                start, cur = at, []
        if cur:
            groups.append({"windows": cur, "frames": sum(cur), "start": start})
        return groups

    def _run_groups(self, data, base, submit, frame, fps, win, ovl, window_frames, per_group):
        """Render the timeline as several jobs, then join them.

        Each group is one Wan2GP job covering `per_group` sliding windows. The
        point is that Wan2GP resets between jobs -- the frame accumulator that
        holds the stitched video and the VRAM baseline both start clean -- so a
        twenty-clip piece stops being one ever-growing render.

        Groups are NOT independent takes. Every group after the first continues
        from the last `overlap` frames of the one before it, exactly the way a
        sliding window continues inside a single job, and every group runs on
        the SAME seed. The carried frames are regenerated by the new group, so
        they are trimmed off its front at the join rather than appearing twice.
        """
        groups = self._group_plan(window_frames, per_group)
        n_groups = len(groups)
        # Work from the PLAN, not from `base`. `base` has already been through
        # _assemble_settings, which renumbered the prompt's picture numbers for
        # a run that has the start image, the end image and every injected
        # frame. A group that does not have the start image needs a different
        # shift, so slicing the finished prompt would leave every group after
        # the first pointing at the wrong reference sheets.
        plan0 = dict(data.get("settings") or {})
        media0 = dict(plan0.get("media") or {})
        base_offset = plan0.get("numbering_offset")
        if base_offset is None:
            base_offset = int(plan0.get("injected_count") or 0) \
                + (1 if media0.get("image_start") else 0) \
                + (1 if media0.get("image_end") else 0)
        base_offset = int(base_offset or 0)
        blocks = [b for b in re.split(r"\n\s*\n", (plan0.get("prompt") or "").replace("\r\n", "\n")) if b.strip()]
        # One prompt block per window is the contract the relay already builds
        # to. If that does not hold, every group gets the whole prompt rather
        # than a silently wrong slice of it.
        # One prompt block per window is what makes a group a slice of the
        # timeline. Without it there is no honest way to give a group its own
        # share, and the old fallback -- hand every group the whole prompt --
        # was far worse than not grouping: each group rendered the ENTIRE
        # piece, so six groups meant six full renders. Refuse instead.
        if len(blocks) != len(window_frames):
            msg = ("Cannot render in groups: the prompt has %d block(s) but the "
                   "timeline plans %d window(s). Turn groups off, or make the "
                   "prompt one block per window." % (len(blocks), len(window_frames)))
            trace("groups REFUSED: " + msg)
            yield frame("error", error=msg)
            return
        per_window_prompts = True

        # One seed for the whole piece. -1 means "pick one", and picking it
        # here rather than per job is what keeps the groups consistent.
        seed = int(base.get("seed") or -1)
        if seed < 0:
            seed = int(time.time()) % 2147483647
            trace("groups: seed was random; fixed at %d so every group matches" % seed)

        # Releasing the model BETWEEN groups is off by default, and the reason
        # is that it buys nothing where it matters: the finished frames are
        # held in `frames_already_processed`, a local inside Wan2GP's
        # generate_media, so they are freed when the group's job returns --
        # not by unloading the model. Releasing between groups only forces a
        # full model reload before the next one. It stays available for the
        # case it does help, a VRAM baseline that creeps across groups.
        release_between = bool((data.get("settings") or {}).get("release_between_groups", False))

        total_windows = len(window_frames)
        trace("groups: %d group(s) of up to %d window(s) covering %d window(s) / %d frames"
              % (n_groups, per_group, total_windows, sum(window_frames)))
        yield frame("running", 0.0, 0, total_windows,
                    [{"level": "info", "msg": "Rendering in %d group(s) of up to %d window(s)."
                      % (n_groups, per_group)}])

        # The look the piece opens with, measured off the first group once it
        # exists, and what every later join is compared against.
        hold_look = bool((data.get("settings") or {}).get("hold_look_between_groups", False))
        look_ref = None

        parts, made_files, done_windows = [], [], 0
        prev_out = None
        w_at = 0

        for gi, grp in enumerate(groups):
            n_win = len(grp["windows"])
            head_trim = 0
            first_group, last_group = gi == 0, gi == n_groups - 1

            # The start image belongs to the first group and the end image to
            # the last; a middle group has neither. Each one occupies a
            # numbered slot ahead of the reference sheets, so dropping one has
            # to drop the shift with it or the prompt's picture numbers move.
            pg = dict(plan0)
            media_g = dict(media0)
            offset_g = base_offset
            if not first_group and media_g.pop("image_start", None):
                offset_g -= 1
            if not last_group and media_g.pop("image_end", None):
                offset_g -= 1
            pg["media"] = media_g
            pg["numbering_offset"] = max(0, offset_g)
            if per_window_prompts:
                pg["prompt"] = "\n\n".join(blocks[w_at:w_at + n_win])

            try:
                st = self._normalize_audio_guide(self._assemble_settings(pg))
            except Exception as exc:
                yield frame("error", error="group %d refused: %s" % (gi + 1, exc))
                return
            st["seed"] = seed
            if offset_g != base_offset:
                trace("group %d: picture numbers shifted by %d, not %d "
                      "(this group has no %s image)"
                      % (gi + 1, offset_g, base_offset,
                         "start" if not first_group else "end"))

            # A continued group REGENERATES the carried overlap at its front,
            # exactly as window N regenerates window N-1's tail inside a single
            # job. So the job has to be overlap frames LONGER than the group's
            # own share of the timeline, and the audio has to start that much
            # earlier -- otherwise the group lands short and the song drifts
            # out of sync with the picture by one overlap at every boundary.
            carry = int(ovl) if prev_out else 0
            audio_at = (grp["start"] - carry) / fps
            audio_len = (grp["frames"] + carry) / fps

            # Its slice of the song, so the words and sounds continue from
            # where the last group left off instead of restarting at 0:00.
            song = st.get("audio_guide")
            if song and os.path.isfile(str(song)):
                try:
                    st["audio_guide"] = self._audio_slice(song, max(0.0, audio_at), audio_len)
                except Exception as exc:
                    trace("group %d: could not slice the soundtrack (%s); using the whole file"
                          % (gi + 1, exc))

            if prev_out:
                # Continue from the previous group's tail, the same way a
                # sliding window continues inside one job.
                try:
                    tail = self._source_tail(prev_out, ovl, fps)
                    # Measure the drift at every join, and say so. This is the
                    # "it gets brighter and brighter" report turned into a
                    # number: if the tail reads the same as the opening, the
                    # cause is somewhere else and the log rules it out.
                    if look_ref:
                        if hold_look:
                            tail, drift = self._hold_look(tail, look_ref)
                        else:
                            now = self._luma_stats(tail)
                            drift = ((now["y"] - look_ref["y"]) / look_ref["y"]) if now else None
                        if drift is not None:
                            note = ("look drift at join %d: the carried frames are %+.1f%% "
                                    "brighter than the opening%s"
                                    % (gi, 100 * drift,
                                       "; nudged back" if hold_look else ""))
                            trace(note)
                            yield frame("running", note, gi / float(n_groups), gi + 1, n_groups,
                                        logs=[{"level": "info", "msg": note}])
                    st["video_source"] = tail
                    st["keep_frames_video_source"] = ""
                    ipt = st.get("image_prompt_type", "") or ""
                    if "V" not in ipt:
                        st["image_prompt_type"] = ipt + "V"
                    # A continuation regenerates the carried frames, so they
                    # are dropped from the front of this group at the join.
                    head_trim = carry
                    st.pop("image_start", None)
                    trace("group %d: continuing from %d carried frame(s)" % (gi + 1, ovl))
                except Exception as exc:
                    trace("group %d: could not carry the tail (%s); starting fresh" % (gi + 1, exc))

            # On the /duration path the TAGS govern the length and
            # video_length is ignored by Wan2GP; it still matters on the
            # default-plan path. Setting it either way is correct and costs
            # nothing, but it is not a promise -- the check after the job is.
            st["video_length"] = int(grp["frames"]) + carry
            st = self._strip_unsatisfied(st)
            want_frames = int(grp["frames"]) + carry

            yield frame("running", done_windows / max(1, total_windows), done_windows, total_windows,
                        [{"level": "info", "msg": "Group %d of %d: %d window(s), %.2fs"
                          % (gi + 1, n_groups, n_win, grp["frames"] / fps)}])
            self._log_prompt("GROUP %d/%d" % (gi + 1, n_groups), st)

            try:
                job = submit(st)
            except Exception as exc:
                yield frame("error", error="group %d submit failed: %s" % (gi + 1, exc))
                return
            self._job = job
            self._reset_job_state(status="running", started=time.time(), windows=n_win)
            self._stream_owner = id(job)
            self._start_background_drain(job)

            last = 0.0
            while not getattr(job, "done", False):
                stream = getattr(job, "events", None)
                if stream is not None:
                    try:
                        ev = stream.get(timeout=0.25)
                        while ev is not None:
                            self._absorb_event(ev)
                            try:
                                ev = stream.get_nowait()
                            except Exception:
                                ev = None
                    except Exception:
                        pass
                else:
                    time.sleep(0.25)
                now = time.time()
                if now - last >= 1.0:
                    last = now
                    js = getattr(self, "_jobstate", {}) or {}
                    inner = float(js.get("progress") or 0)
                    # The window number Wan2GP reports is within THIS group's
                    # job, so it has to be clamped to the group and offset by
                    # the groups already done -- otherwise window 4 of group 5
                    # is announced as window 22 of 20.
                    in_group = max(0, min(int(js.get("window") or 0), n_win - 1))
                    yield frame("running",
                                (done_windows + inner * n_win) / max(1, total_windows),
                                done_windows + in_group, total_windows,
                                phase=str(js.get("phase") or ""),
                                detail="Group %d of %d \u00b7 window %d of %d%s"
                                       % (gi + 1, n_groups, in_group + 1, n_win,
                                          (" \u00b7 " + str(js.get("detail"))) if js.get("detail") else ""))

            self._stream_owner = None
            try:
                result = job.result()
            except Exception as exc:
                yield frame("error", error="group %d failed: %s" % (gi + 1, exc))
                return
            self._job = None
            if getattr(result, "cancelled", False):
                yield frame("cancelled", done_windows / max(1, total_windows), done_windows, total_windows)
                return
            if not getattr(result, "success", False):
                errs = getattr(result, "errors", None) or ["no output"]
                yield frame("error", error="group %d: %s" % (gi + 1, "; ".join(str(e) for e in errs)))
                return
            made = [str(f) for f in (getattr(result, "generated_files", None) or [])]
            if not made:
                yield frame("error", error="group %d produced no file" % (gi + 1))
                return

            prev_out = made[-1]
            made_files.extend(made)
            if look_ref is None:
                # The opening second of the finished first group: the look the
                # rest of the piece is measured against.
                look_ref = self._luma_stats(prev_out, frames=int(fps))
                if look_ref:
                    trace("look reference: the piece opens at brightness %.1f/255"
                          % look_ref["y"])
            # What the group actually produced, against what this slice of the
            # timeline needed. A continuation carrying an overlap alongside
            # per-window /duration tags is the one combination that cannot be
            # checked ahead of time, so it is checked here: a group that comes
            # back the wrong length would otherwise only show up as a finished
            # video that drifts out of sync with the song.
            try:
                got = int(round(self._ffprobe_duration(prev_out) * fps))
                if abs(got - want_frames) > 2:
                    note = ("group %d produced %d frame(s) (%.2fs) for a %d-frame "
                            "(%.2fs) slice -- the joined video will be %+d frame(s) "
                            "off here" % (gi + 1, got, got / fps, want_frames,
                                          want_frames / fps, got - want_frames))
                    trace("LENGTH WARNING: " + note)
                    yield frame("running", done_windows / max(1, total_windows),
                                done_windows, total_windows,
                                [{"level": "warn", "msg": note}])
                else:
                    trace("group %d length OK: %d frame(s) (%.2fs)" % (gi + 1, got, got / fps))
            except Exception as exc:
                trace("group %d: could not measure the output (%s)" % (gi + 1, exc))
            parts.append({"path": prev_out, "trim_start_frames": head_trim, "trim_end_frames": 0})
            done_windows += n_win
            w_at += n_win
            yield frame("running", done_windows / max(1, total_windows), done_windows, total_windows,
                        [{"level": "ok", "msg": "Group %d done: %s"
                          % (gi + 1, os.path.basename(prev_out))}])

            if release_between and gi < n_groups - 1:
                self._release_model()
            elif gi < n_groups - 1:
                trace("group %d done; keeping the model loaded for the next group (%s)"
                      % (gi + 1, self._vram_note() or "no GPU"))

        # ---- everything is rendered: let the model go, then stitch ----
        # Nothing is joined until every group is finished, and each group's
        # frames left memory when its job ended -- joining as we went would put
        # the whole video back in one process and undo the point of grouping.
        # ffmpeg concatenates the finished files straight off disk with a
        # stream copy, so the join itself holds nothing either.
        self._release_model()

        if len(parts) < 2:
            yield frame("done", 1.0, total_windows, total_windows,
                        files=[p["path"] for p in parts])
            return
        yield frame("running", 0.99, total_windows, total_windows,
                    [{"level": "info", "msg": "Joining %d group(s)..." % len(parts)}])
        try:
            joined = self._join_videos({
                "parts": parts, "fps": fps,
                "dir": str(data.get("export_dir") or "").strip() or None,
                "name": (str(data.get("project_name") or "h3-director") + "-full"),
            })["path"]
        except Exception as exc:
            trace("joining the groups failed: %s" % exc)
            yield frame("done", 1.0, total_windows, total_windows, files=made_files,
                        logs=[{"level": "err",
                               "msg": "Groups rendered but could not be joined (%s). "
                                      "Each group's own file is listed above." % exc}])
            return
        yield frame("done", 1.0, total_windows, total_windows,
                    files=[joined] + made_files,
                    logs=[{"level": "ok", "msg": "Joined %d group(s): %s" % (len(parts), joined)}])

    def _generate_stream(self, raw, state=None):
        """Gradio generator: submits, then DRAINS job.events while yielding.

        This must stay running for the whole job. WanGP's plugin_ui_context()
        wrapper only pumps the WebUI queue while this generator is actively
        draining the event stream - a submit-and-return handler leaves the task
        admitted and then stuck. It must also reference self._wangp_session by
        that literal name or the wrapper never attaches at all.
        """
        trace("generate_stream ENTERED (%d bytes of plan)" % len(raw or ""))

        def frame(status, progress=0.0, window=0, windows=0, logs=None, files=None, error="",
                  phase="", detail="", step=None, steps=None, unit="", elapsed=0.0):
            return json.dumps({"cmd": "gen", "data": {
                "status": status, "progress": round(progress, 4), "window": window,
                "windows": windows, "logs": logs or [], "files": files or [],
                "error": error, "phase": phase, "detail": detail,
                "step": step, "steps": steps, "unit": unit,
                "elapsed": round(elapsed, 1), "t": time.time()}})

        try:
            msg = json.loads(raw or "{}")
            data = msg.get("data") or {}
        except Exception as exc:
            yield frame("error", error="bad request: %s" % exc)
            return

        try:
            settings = self._assemble_settings(data.get("settings") or {})
            settings = self._normalize_audio_guide(settings)
        except Exception as exc:
            trace("generate refused: %s" % exc)
            yield frame("error", error=str(exc))
            return

        # A bridge pass overrides the timeline length: only the gap is made.
        bridge_frames = int(data.get("bridge_frames") or 0)
        target = bridge_frames or int(data.get("target_frames") or 0)
        if bridge_frames:
            trace("bridge pass: generating %d frame(s) for this gap, not the timeline length"
                  % bridge_frames)
        win = int(settings.get("sliding_window_size") or self._grid["WINDOW_DEFAULT"])
        ovl = int(settings.get("sliding_window_overlap") or self._grid["OVERLAP_DEFAULT"])
        windows = self._windows_for(target, win, ovl)
        if target:
            fps_now = float(data.get("fps") or (data.get("settings") or {}).get("fps") or 24) or 24.0
            # Which of WanGP's two length models applies is decided by the
            # prompt: any /duration tag puts it on the SCHEDULER, where each
            # window outputs what it declares. Without tags the DEFAULT window
            # plan applies, where video_length is the whole output length.
            tagged = bool(self._DURATION_TAG.search(settings.get("prompt", "")))
            plan_in = data.get("settings") or {}
            manual_windows = None
            if plan_in.get("manual_windows"):
                wf = [int(x) for x in (plan_in.get("window_frames") or []) if int(x) > 0]
                if wf:
                    manual_windows = wf
                    total_wf = sum(wf)
                    if total_wf != target:
                        trace("length WARNING: hand-set windows total %d frame(s) (%.2fs) but the "
                              "timeline is %d (%.2fs)"
                              % (total_wf, total_wf / fps_now, target, target / fps_now))
            if bridge_frames:
                # A bridge pass keeps the continuation arithmetic it already
                # had -- its geometry carries a source clip, which neither of
                # these models covers.
                req = compensate_request(target, win, ovl)
                trace("bridge length: gap=%d -> video_length=%d (continuation arithmetic)"
                      % (target, req))
            elif tagged:
                # The tags govern; video_length is not what sets the length.
                req = solve_video_length(target, win, ovl, self._grid)
                windows = (len(manual_windows) if manual_windows
                           else scheduler_window_count(target, win, ovl, self._grid))
                trace("length: target=%d (%.2fs) -> SCHEDULER path, %d window(s) from /duration tags%s"
                      % (target, target / fps_now, windows,
                         " (set by hand)" if manual_windows else ""))
            else:
                req = solve_video_length(target, win, ovl, self._grid)
                out = real_output_frames(req, win, ovl, self._grid)
                # Progress must count the windows WanGP will really run.
                windows = real_window_count(req, win, ovl, self._grid)
                trace("length: target=%d (%.2fs) win=%d ovl=%d -> video_length=%d -> WanGP outputs %d frames (%.2fs) in %d window(s)%s"
                      % (target, target / fps_now, win, ovl, req, out, out / fps_now, windows,
                         "" if out == target else " [%+d frame(s)]" % (out - target)))
                if out < target:
                    trace("length WARNING: output is SHORT of the timeline by %d frame(s); "
                          "a soundtrack longer than the video will be cut off" % (target - out))
            settings["video_length"] = req
            settings["prompt"] = self._fix_duration_tags(
                settings.get("prompt", ""), target, win, ovl, fps_now,
                manual=manual_windows)

        # DOTTED access on purpose: _callback_uses_api_session() inspects
        # co_names, and getattr(self, "_wangp_session") puts the name in
        # co_consts instead - so the handler is never wrapped and the WanGP
        # queue never pumps. The task is admitted and then nothing happens.
        session = self._wangp_session if hasattr(self, "_wangp_session") else None
        submit = getattr(session, "submit_task", None) if session is not None else None
        if not callable(submit):
            yield frame("error", error="This WanGP build does not expose submit_task - use Apply to generator.")
            return

        ok, why = self._check_prompt_blocks(settings.get("prompt", ""))
        if not ok:
            trace("REFUSING to submit: %s" % why)
            yield frame("error", why)
            return
        # ---- long timelines: render in groups of windows ----
        # One Wan2GP job per group instead of one for the whole timeline. Its
        # frame accumulator and its VRAM baseline both reset when a job ends,
        # so five groups of four windows behave like five short renders rather
        # than one very long one. Each group continues from the last one with
        # the same overlap and the same seed, so it knows where to carry on.
        group_windows = int((data.get("settings") or {}).get("group_windows") or 0)
        if group_windows > 0 and target and not bridge_frames:
            fps_g = float(data.get("fps") or (data.get("settings") or {}).get("fps") or 24) or 24.0
            plan_in_g = data.get("settings") or {}
            hand = [int(x) for x in (plan_in_g.get("window_frames") or []) if int(x) > 0] \
                if plan_in_g.get("manual_windows") else []
            if hand:
                plan_wf = hand
            elif tagged:
                # The prompt carries /duration tags, so the SCHEDULER decides
                # the windows -- one per prompt block -- and the default plan
                # does not apply. Splitting on the default plan gave 22 windows
                # for a 20-block prompt, the block count stopped matching, and
                # every group was handed the WHOLE prompt: six groups each
                # rendering all 20 windows.
                plan_wf = plan_duration_frames(int(target), win, ovl, self._grid)[1]
            else:
                plan_wf = [w["output_frames"] for w in
                           _real_plan_windows(int(target), win, ovl, self._grid)]
            if len(plan_wf) > group_windows:
                yield from self._run_groups(
                    data, settings, submit, frame, fps_g, win, ovl,
                    plan_wf, group_windows)
                return
            trace("groups: %d window(s) fits in one group of %d - rendering normally"
                  % (len(plan_wf), group_windows))

        self._log_prompt("SUBMIT", settings)
        yield frame("running", 0.0, 0, windows, [{"level": "info", "msg": "Submitting %s, %d frames..." % (settings.get("model_type"), settings.get("video_length", 0))}])

        try:
            job = submit(settings)
        except Exception as exc:
            trace("submit_task raised: %s" % exc)
            yield frame("error", error="submit_task failed: %s" % exc)
            return
        self._job = job
        self._reset_job_state(status="running", started=time.time(), windows=windows,
                              log=[{"level": "ok", "msg": "WanGP admitted the task."}])
        self._stream_owner = id(job)
        self._start_background_drain(job)
        trace("queued %s" % type(job).__name__)

        # job.events carries TYPED events: kind "progress" holds a ProgressUpdate
        # (phase, status, progress 0-100, current_step, total_steps, unit),
        # "status" a string, "output" a produced file. Reading only .status and
        # ignoring .progress is why the UI could show nothing but elapsed time.
        started = time.time()
        last_yield = 0.0
        phase = ""
        detail = ""
        pct = 0.0
        cur = tot = None
        unit = ""
        window = 0
        pending = [{"level": "ok", "msg": "WanGP admitted the task."}]
        seen_phase = set()

        def absorb(ev):
            nonlocal phase, detail, pct, cur, tot, unit, window
            kind = str(getattr(ev, "kind", "") or "")
            d = getattr(ev, "data", None)
            if kind == "progress" and d is not None:
                p_new = getattr(d, "phase", None)
                if p_new and p_new != phase:
                    phase = str(p_new)
                    if phase not in seen_phase:
                        seen_phase.add(phase)
                        pending.append({"level": "info", "msg": "-> %s" % phase.replace("_", " ")})
                raw = getattr(d, "progress", None)
                if raw is not None:
                    pct = max(0.0, min(1.0, float(raw) / 100.0))
                cur = getattr(d, "current_step", None)
                tot = getattr(d, "total_steps", None)
                unit = str(getattr(d, "unit", "") or "")
                detail = str(getattr(d, "status", "") or "")
                m = re.search(r"[Ww]indow\s+(\d+)", detail)
                if m:
                    window = max(0, int(m.group(1)) - 1)
            elif kind in ("status", "stream") and d is not None:
                txt = str(getattr(d, "text", d) or "").strip()
                if txt and txt != detail:
                    detail = txt
                    pending.append({"level": "info", "msg": txt})
            elif kind == "output" and isinstance(d, dict):
                pth = d.get("path")
                if pth:
                    pending.append({"level": "ok", "msg": "Output: %s" % pth})

        while not getattr(job, "done", False):
            try:
                stream = getattr(job, "events", None)
                if stream is not None:
                    ev = stream.get(timeout=0.25)
                    while ev is not None:
                        absorb(ev)
                        self._absorb_event(ev)
                        try:
                            ev = stream.get_nowait()
                        except Exception:
                            ev = None
                else:
                    time.sleep(0.25)
            except Exception:
                time.sleep(0.05)

            now = time.time()
            if now - last_yield >= 0.5:          # ~2 updates/sec, never per event
                last_yield = now
                # A real step count beats the coarse percentage when both exist.
                prog = (float(cur) / float(tot)) if (cur and tot) else pct
                out, pending[:] = list(pending), []
                yield frame("running", prog, window, windows, out,
                            phase=phase, detail=detail, step=cur, steps=tot,
                            unit=unit, elapsed=now - started)

        self._stream_owner = None          # hand back to the background drain
        files, errs, status = [], [], "done"
        try:
            result = job.result()
            if getattr(result, "cancelled", False):
                status = "cancelled"
            elif getattr(result, "success", False):
                files = [str(f) for f in (getattr(result, "generated_files", None) or [])]
            else:
                status = "error"
                errs = [str(e) for e in (getattr(result, "errors", None) or ["WanGP returned no output"])]
        except Exception as exc:
            status = "error"
            errs = ["job.result() raised: %s" % exc]

        for e in errs:
            pending.append({"level": "err", "msg": e})
        if files:
            pending.append({"level": "ok", "msg": "Finished: " + ", ".join(files)})
        trace("job %s (%d file(s))" % (status, len(files)))
        self._job = None
        yield frame(status, 1.0 if status == "done" else 0.0, windows, windows, pending, files,
                    "; ".join(errs), phase="finished" if status == "done" else status,
                    detail="%d file(s)" % len(files), elapsed=time.time() - started)

    def _normalize_audio_guide(self, settings):
        """WanGP calls soundfile on audio_guide, so a video container there
        fails deep inside generation. Convert at this boundary."""
        p = settings.get("audio_guide")
        if not p:
            return settings
        if os.path.splitext(str(p))[1].lower() not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"):
            return settings
        try:
            out = MEDIA_DIR / ("aud_%s.wav" % hashlib.sha256(str(p).encode()).hexdigest()[:12])
            if not out.exists():
                import subprocess
                subprocess.run([self._ffmpeg(), "-i", str(p), "-vn", "-ac", "2", "-y", str(out)],
                               check=True, capture_output=True, timeout=900)
            settings["audio_guide"] = str(out)
            trace("extracted audio from video container -> %s" % out.name)
        except Exception as exc:
            trace("audio extraction failed (%s); dropping the A flag" % exc)
            settings.pop("audio_guide", None)
            settings = self._strip_unsatisfied(settings)
        return settings

    # ---------------- surviving a dropped connection ----------------
    def _reset_job_state(self, **kw):
        st = {"status": "idle", "progress": 0.0, "phase": "", "detail": "",
              "step": None, "steps": None, "unit": "", "window": 0, "windows": 0,
              "files": [], "error": "", "started": 0.0, "log": []}
        st.update(kw)
        self._jobstate = st
        return st

    def _job_state(self):
        """Server-side truth about the running job.

        The job runs in WanGP's queue, not in the browser, so a dropped
        websocket only loses the STREAM - never the work. The UI re-attaches to
        this after a refresh instead of being stranded with a frozen panel and
        a dead Cancel button.
        """
        st = dict(getattr(self, "_jobstate", None) or self._reset_job_state())
        job = getattr(self, "_job", None)
        st["attached"] = job is not None
        st["elapsed"] = round(time.time() - st["started"], 1) if st.get("started") else 0.0
        st["log"] = st.get("log", [])[-120:]
        st["can_cancel"] = bool(job is not None and not getattr(job, "done", False))
        return st

    def _start_background_drain(self, job):
        """Keep draining job.events even with nobody watching.

        The wrapper only pumps WanGP's queue while something is draining the
        stream. If the client disconnects and the streaming handler dies, an
        undrained queue can stall the run - so a daemon thread takes over and
        keeps the state up to date for whoever reconnects.
        """
        import threading

        def pump():
            try:
                while not getattr(job, "done", False):
                    if getattr(self, "_stream_owner", None) is not None:
                        time.sleep(0.4)          # a live client is draining
                        continue
                    stream = getattr(job, "events", None)
                    if stream is None:
                        time.sleep(0.4)
                        continue
                    try:
                        ev = stream.get(timeout=0.4)
                        while ev is not None:
                            self._absorb_event(ev)
                            try:
                                ev = stream.get_nowait()
                            except Exception:
                                ev = None
                    except Exception:
                        pass
                self._finish_job(job)
            except Exception as exc:
                trace("background drain stopped: %s" % exc)

        t = threading.Thread(target=pump, name="h3d2-drain", daemon=True)
        t.start()
        trace("background drain started (survives a dropped connection)")
        return t

    def _gpu_health(self):
        """Power draw, temperature and clocks, via nvidia-smi.

        A machine that reboots mid-render is not failing in Python -- Python
        cannot restart a PC. It is power, heat or a driver reset. None of that
        shows up in a traceback, so the numbers are logged as the render goes:
        with a flushed log, the last line before the reboot says what the card
        was drawing and how hot it was in the instant it went down.
        """
        try:
            import subprocess
            out = subprocess.run(
                ["nvidia-smi",
                 "--query-gpu=power.draw,power.limit,temperature.gpu,clocks.sm,utilization.gpu",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5)
            line = (out.stdout or "").strip().splitlines()
            if not line:
                return ""
            f = [x.strip() for x in line[0].split(",")]
            if len(f) < 5:
                return ""
            return ("GPU %sW of %sW | %s\u00b0C | %s MHz | %s%% busy"
                    % (f[0], f[1], f[2], f[3], f[4]))
        except Exception:
            return ""

    def _vram_note(self):
        """GPU memory, in words, or "" when there is no GPU to ask.

        Logged at every window boundary. A late-window CUDA OOM is impossible
        to tell apart from an over-large setting after the fact: both end with
        the same traceback. With a reading per window you can see whether the
        headroom is creeping down run-to-run (something is being retained) or
        is steady right up to a single spike (the window itself is too big for
        what is left). `cached` is memory PyTorch is holding but not using --
        when that grows while free memory does not, the pool is fragmenting.
        """
        try:
            import torch
            if not torch.cuda.is_available():
                return ""
            free, total = torch.cuda.mem_get_info()
            alloc = torch.cuda.memory_allocated()
            reserved = torch.cuda.memory_reserved()
            g = float(1024 ** 3)
            return ("VRAM free %.2f / %.2f GiB | in use %.2f | cached %.2f"
                    % (free / g, total / g, alloc / g, (reserved - alloc) / g))
        except Exception:
            return ""

    def _absorb_event(self, ev):
        st = getattr(self, "_jobstate", None) or self._reset_job_state()
        kind = str(getattr(ev, "kind", "") or "")
        d = getattr(ev, "data", None)
        if kind == "progress" and d is not None:
            ph = getattr(d, "phase", None)
            if ph and str(ph) != st.get("phase"):
                st["phase"] = str(ph)
                st.setdefault("log", []).append({"level": "info", "msg": "-> %s" % str(ph).replace("_", " ")})
            raw = getattr(d, "progress", None)
            if raw is not None:
                st["progress"] = max(0.0, min(1.0, float(raw) / 100.0))
            st["step"] = getattr(d, "current_step", None)
            st["steps"] = getattr(d, "total_steps", None)
            st["unit"] = str(getattr(d, "unit", "") or "")
            st["detail"] = str(getattr(d, "status", "") or "")
            m = re.search(r"[Ww]indow\s+(\d+)", st["detail"])
            if m:
                st["window"] = max(0, int(m.group(1)) - 1)
                # Tracked separately from st["window"], which starts at 0 and
                # so would never look like a change on window 1 -- the first
                # window is the baseline every later reading is compared to.
                was = st.get("vram_at")
                if st["window"] != was:
                    st["vram_at"] = st["window"]
                    parts = [x for x in (self._vram_note(), self._gpu_health()) if x]
                    if parts:
                        line = "window %d: %s" % (st["window"] + 1, "  |  ".join(parts))
                        st.setdefault("log", []).append({"level": "info", "msg": line})
                        trace(line)
        elif kind in ("status", "stream") and d is not None:
            txt = str(getattr(d, "text", d) or "").strip()
            if txt:
                st["detail"] = txt
                st.setdefault("log", []).append({"level": "info", "msg": txt})
        elif kind == "output" and isinstance(d, dict) and d.get("path"):
            st.setdefault("log", []).append({"level": "ok", "msg": "Output: %s" % d["path"]})
        st["log"] = st.get("log", [])[-400:]

    def _finish_job(self, job):
        st = getattr(self, "_jobstate", None) or self._reset_job_state()
        try:
            result = job.result()
            if getattr(result, "cancelled", False):
                st["status"] = "cancelled"
            elif getattr(result, "success", False):
                st["status"] = "done"
                st["progress"] = 1.0
                st["files"] = [str(f) for f in (getattr(result, "generated_files", None) or [])]
                st.setdefault("log", []).append({"level": "ok", "msg": "Finished: " + (", ".join(st["files"]) or "no file")})
            else:
                st["status"] = "error"
                for e in (getattr(result, "errors", None) or ["WanGP returned no output"]):
                    st["error"] = str(e)
                    st.setdefault("log", []).append({"level": "err", "msg": str(e)})
        except Exception as exc:
            st["status"] = "error"
            st["error"] = str(exc)
        self._job = None
        trace("job %s (recorded for reconnecting clients)" % st["status"])

    _DURATION_TAG = re.compile(r"\[/duration=([0-9.]+)s\]")

    def _fix_duration_tags(self, prompt, target, win, ovl, fps, manual=None):
        """Make the per-window [/duration=] tags cover the TIMELINE.

        Every block carrying a /duration tag puts WanGP on its scheduler path,
        where each window OUTPUTS exactly what it declares and the overlap is
        generated on top. So three 15s windows really are 45s of video.

        Work BY BLOCK, never by tag. WanGP splits the prompt on blank lines and
        makes one window per block; a block holding two tags is still one
        window, and Wan2GP simply takes the last tag it sees. Counting tags
        instead of blocks is what halved every window when a prompt arrived
        with a [/duration=] already typed into it: five blocks carrying two
        tags each were re-fitted as ten windows of 7.6s.

        Any extra tags inside a block are dropped, so only one survives.
        """
        if not target or fps <= 0:
            return prompt
        text = (prompt or "").replace("\r\n", "\n")
        blocks = re.split(r"(\n\s*\n)", text)          # keep the separators
        idx = [i for i in range(0, len(blocks), 2) if blocks[i].strip()]
        tagged = [i for i in idx if self._DURATION_TAG.search(blocks[i])]
        if not tagged:
            return prompt

        n = len(tagged)
        old_total = sum(float(t) for t in self._DURATION_TAG.findall(text)) * fps

        if manual:
            # The user set these lengths by hand. Honour them exactly; the UI
            # has already checked them against the model's floor and ceiling
            # and against the timeline total.
            durations = [max(1, int(d)) for d in manual]
            outputs = _scheduler_outputs(durations, win, ovl, self._grid)
            trace("window lengths set by hand: %s frame(s) = %s"
                  % (durations, ", ".join("%.2fs" % (d / float(fps)) for d in durations)))
        else:
            durations, outputs = plan_duration_frames(int(target), win, ovl, self._grid)
        if len(durations) != n:
            # The blocks are the user's per-window prompts, so their count is
            # theirs to keep -- spread the timeline over exactly this many.
            trace("duration tags: %d block(s) present but this %d-frame timeline "
                  "would prefer %d window(s); fitting to the blocks"
                  % (n, int(target), len(durations)))
            durations, outputs = self._refit_durations(int(target), win, ovl, n)

        for slot, i in enumerate(tagged):
            frames = durations[slot] if slot < len(durations) else durations[-1]
            replacement = "[/duration=%.2fs]" % (frames / float(fps))
            seen = {"n": 0}

            def sub(_m, _rep=replacement, _seen=seen):
                _seen["n"] += 1
                # One tag per block: the first becomes the real duration, any
                # others are removed rather than left to override it.
                return _rep if _seen["n"] == 1 else ""

            blocks[i] = self._DURATION_TAG.sub(sub, blocks[i])
            if seen["n"] > 1:
                trace("block %d carried %d duration tag(s); kept one"
                      % (slot + 1, seen["n"]))

        out = "".join(blocks)
        total = sum(outputs)
        trace("duration tags: %d window(s) declaring %s -> WanGP outputs %s = %d frames (%.2fs), "
              "timeline %d (%.2fs)%s"
              % (len(durations), durations, outputs, total, total / float(fps),
                 int(target), int(target) / float(fps),
                 "" if total >= target else "  *** SHORT ***"))
        if abs(sum(durations) - old_total) > 1:
            trace("duration tags rewritten: %.0f -> %d declared frames" % (old_total, sum(durations)))
        if total < target:
            trace("length WARNING: the windows total %d frame(s), %d short of the timeline; "
                  "a longer soundtrack will be cut off" % (total, int(target) - total))
        return out

    def _refit_durations(self, target, win, ovl, n):
        """Spread `target` over exactly `n` windows when the block count is fixed.

        Used only when the prompt's block count disagrees with what the
        timeline needs -- the blocks carry the user's per-window prompts, so
        the count is theirs to keep, not ours to change.
        """
        n = max(1, int(n))
        lo, hi = 1, max(2, int(win))
        best = [win] * n
        # Largest even share that still covers, else every window at `win`.
        for share in range(hi, lo - 1, -1):
            durations = [share] * n
            if sum(_scheduler_outputs(durations, win, ovl, self._grid)) < target:
                break
            best = durations
        return best, _scheduler_outputs(best, win, ovl, self._grid)

    def _legal_frames(self, n):
        """Snap to the model's frame grid, FLOORING like wgp does.

        H3 accepts offset + step*k only (5 + 17k here, minimum 107). 360 is not
        on the grid; it floors to 345. Sending an off-grid length leaves a
        short tail that the VAE cannot decode:
            RuntimeError: MiniMax H3 VAE decoded 0 frames, expected 5
        """
        offset = int(self._grid.get("WINDOW_OFFSET", 5) or 5)
        step = max(1, int(self._grid.get("WINDOW_STEP", 17) or 17))
        floor = int(self._grid.get("WINDOW_MIN", 0) or 0)
        n = int(n)
        legal = ((max(0, n - offset)) // step) * step + offset
        if floor and legal < floor:
            legal = ((max(0, floor - offset) + step - 1) // step) * step + offset
        return legal

    def _legal_frames_up(self, n):
        """Snap UP to the frame grid. Used where a shortfall matters."""
        offset = int(self._grid.get("WINDOW_OFFSET", 5) or 5)
        step = max(1, int(self._grid.get("WINDOW_STEP", 17) or 17))
        floor = int(self._grid.get("WINDOW_MIN", 0) or 0)
        n = max(int(n), floor)
        return ((max(0, n - offset) + step - 1) // step) * step + offset

    def _continuation_plan(self, desired, win, ovl):
        """Everything a continuation pass needs, worked out from WanGP's own
        window planner. Used ONLY by bridge passes - the normal generate path
        is untouched.

        estimate_first_window_overlap_frames() returns the SOURCE CLIP'S WHOLE
        FRAME COUNT when keep_frames_video_source is empty. build_default_window_plan
        then does
            first_window_capacity = window_size - first_window_overlap
        so a 360-frame source against a 362-frame window leaves a capacity of 4,
        the run explodes into dozens of tiny windows, and the last one dies as
            MiniMax H3 VAE decoded 0 frames, expected 5

        Pinning keep_frames_video_source to the overlap gives a full-size first
        window and one clean pass.
        """
        keep = max(1, int(ovl))
        capacity = max(1, int(win) - keep)

        # The carried frames are trimmed off at the join, so ASK for the wanted
        # length PLUS the carry - otherwise every bridge comes out short by the
        # overlap. Snap up so it is never under, then clamp to what one window
        # can hold.
        # The HARD ceiling is capacity + the one shared frame. Using
        # capacity + keep here let the request exceed what a single window can
        # hold, so the run spilled into a second window and re-encoded the
        # source clip - which is why the output looked like the original video,
        # distorted, with the prompt barely applied.
        shared = 1
        want_total = self._legal_frames_up(int(desired) + keep)
        ceiling = self._legal_frames(capacity + shared)
        request = min(want_total, ceiling)
        new_material = max(0, request - keep)
        truncated = new_material < int(desired)
        trace("continuation plan: wanted %d new frame(s) -> request %d "
              "(keep_frames_video_source=%d carried, trimmed at the join) "
              "= %d new, capacity %d%s"
              % (desired, request, keep, new_material, capacity,
                 "  CLAMPED" if truncated else ""))
        return {"video_length": request, "keep_frames_video_source": str(keep),
                "capacity": capacity, "truncated": truncated,
                "new_material": new_material}

    def _continuation_length(self, desired, win, ovl):
        """Length to REQUEST when continuing from a clip.

        wgp.py:1499
            full_video_length = video_length if video_source is None
                                else video_length + sliding_window_overlap - 1
        so a continuation is longer than what is asked for. The request has to
        be reduced by that carry, and the TOTAL has to land on the grid, or the
        run spills into an extra window with an undecodable tail.
        """
        carry = max(0, int(ovl) - 1)
        full = self._legal_frames(int(desired) + carry)
        req = max(self._legal_frames(0), full - carry)
        trace("continuation length: wanted %d, carry %d -> full %d (legal), request %d"
              % (desired, carry, full, req))
        return req

    def _windows_for(self, target, win, ovl):
        if not target or win <= ovl:
            return 1
        req = compensate_request(target, win, ovl)
        stride = win - ovl
        return 1 if req <= win else (-(-(req - win) // stride) + 1)

    def _push(self, level, msg):
        self._events.append({"level": level, "msg": msg})
        trace("%s: %s" % (level, msg))

    def _cancel_click(self):
        self._cancel()
        return "Cancel requested."

    def _cancel(self):
        job = self._job
        if job is not None and not getattr(job, "done", False):
            try:
                job.cancel()
                self._push("warn", "Cancel requested.")
            except Exception as exc:
                self._push("err", "cancel failed: %s" % exc)
        return {"ok": True}


# --------------------------------------------------------------------------
def get_plugin():
    return H3Director2Plugin()


plugin_class = H3Director2Plugin
