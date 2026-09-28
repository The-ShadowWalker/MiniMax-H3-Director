#!/usr/bin/env python3
"""Crash recovery for grouped renders, end to end, on real video.

Wan2GP is replaced by a renderer that cuts real frames out of one long
reference clip at the position each group asks for. So a group that starts a
frame early or late, a master cut in the wrong place, or a Continue that picks
up from the wrong tail all show up the same way they would on a real piece:
the finished video stops matching the reference at that join.

What is checked:
  * each finished group is saved as a master exactly its slot long, and the
    record names it only once it is safely on disk;
  * a crash keeps every finished group, and Continue picks up after them on
    the same seed, from the last master's tail, re-rendering nothing;
  * the joined video is the full timeline and matches the reference at every
    join, crash or no crash;
  * anything that no longer matches -- a changed prompt, setting, seed or
    overlap, a damaged or missing clip -- stops what can be kept at that
    group, and says why;
  * the clips and the record travel with the project zip.
Needs ffmpeg and ffprobe on PATH.
"""
import ast
import importlib.util
import inspect
import json
import os
import re
import shutil
import subprocess
import time
import sys
import tempfile
import types
import zipfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + str(detail)))
    if not ok:
        fails.append(label)


if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
    print("SKIP: ffmpeg/ffprobe not found")
    sys.exit(0)

# ---------------------------------------------------------------- load plugin
g = types.ModuleType("gradio")


class _C:
    def __init__(s, *a, **k):
        pass


for n in ("Column", "Row", "Textbox", "Button", "HTML", "Markdown", "State", "Blocks"):
    setattr(g, n, _C)
g.update = lambda *a, **k: {}
sys.modules["gradio"] = g


class WAN2GPPlugin:
    def __init__(self, *a, **k):
        pass


shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp})
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("h3d_plugin_resume", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
renders = m.renders

TMP = Path(tempfile.mkdtemp(prefix="h3d_resume_"))
WS = TMP / "workspace"
for name, sub in (("WORKSPACE", ""), ("MEDIA_DIR", "media"), ("DERIVED_DIR", "derived"),
                  ("RENDERS_DIR", "renders")):
    setattr(m, name, WS / sub if sub else WS)
m.RENDER_JSON = WS / "render.json"
m.PROJECT_JSON = WS / "project.json"
m.PROJECT_BAK = WS / "project.json.bak"
m.PLUGIN_DIR = TMP
m.trace = lambda *a, **k: None
for d in ("media", "derived"):
    (WS / d).mkdir(parents=True, exist_ok=True)

p = m.H3Director2Plugin.__new__(m.H3Director2Plugin)
p._grid = dict(m._GRID_FALLBACK)
p._jobstate = {}
p._job = None
SONG = {"path": None}      # set for the soundtrack checks: the project's song


def _assemble(pg):
    st = {"prompt": pg["prompt"], "seed": pg.get("seed", -1),
          "image_prompt_type": "S" if (pg.get("media") or {}).get("image_start") else ""}
    if SONG["path"]:
        st["audio_guide"] = SONG["path"]
    return st


p._assemble_settings = _assemble
p._normalize_audio_guide = lambda st: st
p._strip_unsatisfied = lambda st: st
p._log_prompt = lambda *a, **k: None
p._release_model = lambda *a, **k: None
p._vram_note = lambda: ""
p._start_background_drain = lambda job: None
p._reset_job_state = lambda **k: None

FPS = 24
OVL = 18
WF = [120, 96, 120, 72, 110]          # hand-set windows, deliberately uneven
TOTAL = sum(WF)
OUT = TMP / "wan2gp_outputs"
OUT.mkdir()
REF = TMP / "reference.mkv"           # frame n of the piece, losslessly
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                "testsrc2=size=256x144:rate=%d" % FPS, "-frames:v", str(TOTAL),
                "-c:v", "ffv1", str(REF)], check=True)


def blocks(prompts):
    return "\n\n".join("WIN=%d %s [/duration=%.4fs]" % (i, t, WF[i] / FPS) for i, t in enumerate(prompts))


PROMPTS = ["a quiet street", "a dog runs", "rain starts", "the dog shelters", "sun again"]


def data_for(prompts=PROMPTS, seed=-1, steps=30, group=2, ovl=OVL):
    return {"fps": FPS, "target_frames": TOTAL, "project_name": "resume-test",
            "settings": {"prompt": blocks(prompts), "seed": seed, "num_inference_steps": steps,
                         "sliding_window_size": 243, "sliding_window_overlap": ovl, "fps": FPS,
                         "manual_windows": True, "window_frames": list(WF),
                         "group_windows": group, "media": {"image_start": "m_start"},
                         "model_type": "minimax_h3_hybrid"}}


class FakeJob:
    def __init__(self, files, cancelled=False):
        self.done = True
        self.events = None
        self._r = types.SimpleNamespace(success=True, generated_files=files,
                                        cancelled=cancelled, errors=[])

    def result(self):
        return self._r


submitted = []
tail_audio = []   # (window, first carried frame, its sound as f32 mono 16 kHz)
tails = []     # (window, carried frames are exactly the reference's frames before it)


# WanGP's own muxer for a continuation, when its source is at hand: the output
# is the source's frames followed by the new ones, and its sound is the
# source's sound (silence when it has none) followed by the generated sound.
WAN_MUX = None
for _cand in (os.environ.get("WAN2GP_DIR") or "", os.path.join(HERE, "..", "Wan2GP-main"),
              "/home/claude/wgpnew2/Wan2GP-main"):
    _f = os.path.join(_cand, "shared", "utils", "audio_video.py") if _cand else ""
    if _f and os.path.isfile(_f):
        _src = open(_f, encoding="utf-8").read()
        _fn = next(n for n in ast.parse(_src).body
                   if isinstance(n, ast.FunctionDef) and n.name == "combine_and_concatenate_video_with_audio_tracks")
        _ns = {"subprocess": subprocess, "_ffmpeg_binary": lambda: "ffmpeg",
               "get_mp4_audio_codec_settings": lambda k: {"codec": "aac", "bitrate": "128k"},
               # WanGP 13.14 builds the encoder arguments with this helper
               "get_video_audio_encode_args": lambda k: ["-c:a", "aac", "-b:a", "128k"],
               "get_audio_file_channels": lambda pth: int(json.loads(subprocess.run(
                   ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                    "-of", "json", str(pth)], capture_output=True, text=True).stdout)["streams"][0]["channels"])}
        exec(compile(ast.Module(body=[_fn], type_ignores=[]), _f, "exec"), _ns)
        WAN_MUX = _ns["combine_and_concatenate_video_with_audio_tracks"]
        break


def make_submit(crash_at=None, cancel_at=None, overshoot=0, wan_mux=False):
    """overshoot: return that many frames MORE than asked, with the audio
    running 0.3s past the picture -- Wan2GP does not always land exactly.
    wan_mux: build a continuation's output the way WanGP does (see WAN_MUX)."""
    def submit(st):
        submitted.append(dict(st))
        k = int(re.search(r"WIN=(\d+)", st["prompt"]).group(1))
        if crash_at is not None and len(submitted) == crash_at:
            raise RuntimeError("simulated crash")
        if cancel_at is not None and len(submitted) == cancel_at:
            return FakeJob([], cancelled=True)
        carry = OVL if st.get("video_source") else 0
        g0 = sum(WF[:k]) - carry
        if carry:
            # What a real model continues from: the frames it is handed must
            # be the piece's own frames just before this group's slot.
            worst, count = matches_reference(st["video_source"], start=g0)
            tails.append((k, worst > 30 and count == OVL, round(worst, 1), count))
            # and the SOUND of those frames, which WanGP hands H3 as what they
            # sound like -- without it the next clip's audio starts blind
            r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(st["video_source"]), "-map", "0:a:0?",
                                "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True)
            tail_audio.append((k, g0, r.stdout))
        n = int(st["video_length"]) + overshoot
        out = OUT / ("render_%02d_%d.mp4" % (len(submitted), k))
        # With a song, the model sings along to the slice it was handed, the
        # way H3 follows its audio guide; otherwise a plain tone.
        song = st.get("audio_guide")
        if wan_mux and carry and WAN_MUX and song:
            # source frames + new frames; generated sound covers the new
            # frames only, and goes after the source's own sound
            vid = OUT / ("wm_v_%02d.mkv" % len(submitted))
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(st["video_source"]), "-i", str(REF),
                            "-filter_complex",
                            "[0:v]setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS[b];"
                            "[a][b]concat=n=2:v=1:a=0[v]" % (g0 + carry, g0 + n),
                            "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(vid)], check=True)
            new_a = OUT / ("wm_a_%02d.wav" % len(submitted))
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "%.6f" % (carry / FPS), "-i", str(song),
                            "-t", "%.6f" % ((n - carry) / FPS), "-c:a", "pcm_s16le", str(new_a)], check=True)
            src_a = OUT / ("wm_s_%02d.wav" % len(submitted))
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(st["video_source"]), "-map", "0:a:0",
                                "-c:a", "pcm_s16le", str(src_a)], capture_output=True)
            WAN_MUX(str(out), str(vid), [str(src_a)] if r.returncode == 0 else [], [str(new_a)],
                    carry / FPS, 48000, new_audio_from_start=True)
            return FakeJob([str(out)])
        aud = ["-i", str(song)] if song else ["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000"]
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(REF), *aud,
                        "-vf", "trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS" % (g0, g0 + n),
                        "-map", "0:v", "-map", "1:a",
                        "-af", "atrim=end=%.4f" % (n / FPS + (0.3 if overshoot else 0)),
                        "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", str(out)], check=True)
        return FakeJob([str(out)])
    return submit


def frame(status, progress=0.0, window=0, windows=0, logs=None, files=None, error="", **k):
    return json.dumps({"status": status, "progress": progress, "logs": logs or [],
                       "files": files or [], "error": error})


def run(data, submit, resume=False, group=2):
    frames = [json.loads(f) for f in p._run_groups(
        data, {"seed": data["settings"]["seed"]}, submit, frame, float(FPS), 243,
        int(data["settings"]["sliding_window_overlap"]), list(WF), group, resume=resume)]
    return frames


def nframes(path):
    return renders.count_frames("ffprobe", path)


def matches_reference(path, start=0):
    """Worst per-frame PSNR of `path` against the reference from `start`.
    One frame of misalignment on this moving pattern drops it far below 30."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-i", str(REF),
                        # Pair frames by INDEX, not timestamp: Matroska rounds
                        # timestamps to the millisecond.
                        # The reference is cut to the same length (the psnr
                        # filter's own shortest= drops the final frame).
                        "-lavfi", "[1:v]trim=start_frame=%d:end_frame=%d,setpts=N/(%d*TB)[ref];"
                                  "[0:v]setpts=N/(%d*TB)[v];[v][ref]psnr=stats_file=-"
                                  % (int(start), int(start) + nframes(path), FPS, FPS),
                        "-f", "null", "-"],
                       capture_output=True, text=True)
    vals = [float(x) for x in re.findall(r"psnr_avg:([0-9.]+|inf)", r.stdout.replace("inf", "99"))]
    return (min(vals) if vals else 0.0), len(vals)


def record():
    return json.loads(m.RENDER_JSON.read_text())


# ================================================================ crash
print("a render that crashes in its third group:")
submitted.clear()
fr = run(data_for(), make_submit(crash_at=3))
check("the run reports the failure", fr[-1]["status"] == "error", fr[-1])
rec = record()
check("the record keeps the two finished groups", len(rec["groups"]) == 2, len(rec["groups"]))
check("and is still marked unfinished", rec["status"] == "running")
check("a random seed was fixed once and recorded", rec["seed"] >= 0
      and all(s.get("seed") == rec["seed"] for s in submitted), [s.get("seed") for s in submitted])
seed_first = rec["seed"]
# 1.5.7 lost this: a bad log call after measuring the look threw, and every
# group after the first quietly started a new scene instead of continuing.
check("every group after the first continues from the one before (not a fresh start)",
      len(submitted) >= 2 and all(s.get("video_source") and "V" in (s.get("image_prompt_type") or "")
                                  for s in submitted[1:]),
      [(bool(s.get("video_source")), s.get("image_prompt_type")) for s in submitted])
for gi, g in enumerate(rec["groups"]):
    mp = m.RENDERS_DIR / g["master"]
    check("group %d's master is exactly its slot (%d frames)" % (gi + 1, g["frames"]),
          mp.is_file() and nframes(mp) == g["frames"] == sum(g["windows"]),
          (nframes(mp) if mp.is_file() else "missing", g["frames"]))
    codec = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name",
                            "-of", "csv=p=0", str(mp)], capture_output=True, text=True).stdout.split()
    check("group %d's master is lossless FFV1 with PCM audio" % (gi + 1),
          codec == ["ffv1", "pcm_s24le"], codec)
    worst, count = matches_reference(mp, start=g["start"])
    check("group %d's master is the reference at its slot (worst PSNR %.1f dB)" % (gi + 1, worst),
          worst > 30 and count == g["frames"], (worst, count))
slip, _ = matches_reference(m.RENDERS_DIR / rec["groups"][1]["master"], start=rec["groups"][1]["start"] + 1)
check("(the comparison itself catches a one-frame slip: %.1f dB)" % slip, slip < 30, slip)
check("no half-written file is left behind",
      not list(m.RENDERS_DIR.glob("*.partial*")) and not Path(str(m.RENDER_JSON) + ".tmp").exists())
check("every master carries a sha256 for the provenance record",
      all(len(g.get("sha256", "")) == 64 for g in rec["groups"]))

# ================================================================ state
print("\nwhat the resume card is told:")
state = p._render_state(data_for())
check("it can be continued", state["resumable"], state)
check("4 of 5 windows are kept", state["kept_windows"] == 4 and state["total_windows"] == 5, state)
check("2 groups are kept", state["kept_groups"] == 2)
check("with the seconds done and to go",
      abs(state["kept_seconds"] - sum(WF[:4]) / FPS) < 0.01
      and abs(state["total_seconds"] - TOTAL / FPS) < 0.01, state)

print("\nthe results track is told:")
clips = state.get("clips") or []
check("one clip per finished group, at its place on the timeline",
      [(c["group"], c["start"], c["frames_got"]) for c in clips]
      == [(1, 0, WF[0] + WF[1]), (2, WF[0] + WF[1], WF[2] + WF[3])], clips)
check("both are marked done", [c["status"] for c in clips] == ["done", "done"])
sc = p._render_state(data_for(prompts=PROMPTS[:2] + ["snow starts"] + PROMPTS[3:]))["clips"]
check("a changed prompt marks that group redo, with the reason",
      [c["status"] for c in sc] == ["done", "redo"] and "group 2" in sc[1]["why"], sc)
sc = p._render_state(data_for(steps=40))["clips"]
check("a changed shared setting marks the first redo and the rest after",
      [c["status"] for c in sc] == ["redo", "after"], [c["status"] for c in sc])
poster = p._render_poster({"master": clips[0]["master"]})
import base64 as _b64
jpg = _b64.b64decode(poster["data"].split(",", 1)[1])
check("each clip has a filmstrip poster", poster["data"].startswith("data:image/jpeg;base64,")
      and jpg[:2] == b"\xff\xd8" and len(jpg) > 500, len(jpg))
check("  ... cached, not re-rendered", p._render_poster({"master": clips[0]["master"]})["data"] == poster["data"])
vw, vh = [int(x) for x in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
          "stream=width,height", "-of", "csv=p=0", str(m.RENDERS_DIR / clips[0]["master"])],
          capture_output=True, text=True).stdout.strip().split(",")]
p16 = p._render_poster({"master": clips[0]["master"], "count": 11})
sw, sh = [int(x) for x in subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
          "-i", "pipe:0"], input=_b64.b64decode(p16["data"].split(",", 1)[1]), capture_output=True).stdout.decode().strip().split(",")]
check("a wider clip gets more frames: asked for 11, it gets the next strip size up (16)", p16["count"] == 16, p16["count"])
check("  ... each frame at the video's own shape, not stretched (%dx%d tiles for %dx%d video)"
      % (p16["tile_w"], p16["tile_h"], vw, vh),
      abs(p16["tile_w"] / p16["tile_h"] - vw / vh) < 0.03 and sw == 16 * p16["tile_w"] and sh == p16["tile_h"],
      (p16["tile_w"], p16["tile_h"], sw, sh))
fr_ = p16["frames"]
check("  ... spread evenly through the clip, first stretch to last",
      fr_ == sorted(fr_) and len(set(fr_)) == 16 and fr_[0] < clips[0]["frames_got"] / 16
      and fr_[-1] >= clips[0]["frames_got"] * 15 / 16, fr_)
check("  ... never more frames than the clip has", p._render_poster({"master": clips[0]["master"], "count": 10 ** 6})["count"]
      <= clips[0]["frames_got"])
pv = p._render_preview({"master": clips[0]["master"]})
pv_codecs = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,pix_fmt",
                            "-of", "csv=p=0", pv["file"]], capture_output=True, text=True).stdout.split()
check("each clip has a browser-playable preview for the viewer (H.264 + AAC)",
      pv_codecs[:1] == ["h264,yuv420p"] and "aac" in pv_codecs, pv_codecs)
check("  ... exactly as long as the clip", nframes(pv["file"]) == clips[0]["frames_got"],
      (nframes(pv["file"]), clips[0]["frames_got"]))
check("  ... made once, when the group was saved",
      p._render_preview({"master": clips[0]["master"]})["file"] == pv["file"])
check("  ... and the viewer can have its bytes when the served URL is unreachable",
      len(p._render_preview({"master": clips[0]["master"], "b64": True}).get("b64", "")) > 100)
try:
    p._render_poster({"master": "../../etc/passwd"})
    check("a poster can only come from a rendered clip", False)
except ValueError:
    check("a poster can only come from a rendered clip", True)

# the checks that stop what can be kept
print("\nwhat stops a finished group being kept:")
s2 = p._render_state(data_for(prompts=PROMPTS[:1] + ["a CAT runs"] + PROMPTS[2:]))
check("a changed prompt in group 1 keeps nothing", s2["kept_groups"] == 0 and not s2["resumable"], s2)
check("  ... and says which group", "group 1" in (s2.get("reason") or ""), s2.get("reason"))
s3 = p._render_state(data_for(prompts=PROMPTS[:2] + ["snow starts"] + PROMPTS[3:]))
check("a changed prompt in group 2 keeps group 1", s3["kept_groups"] == 1 and s3["resumable"], s3)
s4 = p._render_state(data_for(prompts=PROMPTS[:4] + ["night falls"]))
check("a changed prompt in a group not yet rendered keeps both", s4["kept_groups"] == 2, s4)
s5 = p._render_state(data_for(steps=40))
check("a changed shared setting keeps nothing, and names it",
      s5["kept_groups"] == 0 and "num_inference_steps" in (s5.get("reason") or ""), s5.get("reason"))
s6 = p._render_state(data_for(seed=12345))
check("a different explicit seed keeps nothing", s6["kept_groups"] == 0 and "seed" in s6["reason"], s6)
s7 = p._render_state(data_for(seed=seed_first))
check("the recorded seed typed in by hand is fine", s7["kept_groups"] == 2, s7)
s8 = p._render_state(data_for(ovl=35))
check("a changed overlap keeps nothing", s8["kept_groups"] == 0 and "overlap" in s8["reason"], s8)
d9 = data_for(); d9["settings"]["group_windows"] = 1; d9["settings"]["release_between_groups"] = True
check("group size and model release do not count as changes",
      p._render_state(d9)["kept_groups"] == 2)

m2 = m.RENDERS_DIR / rec["groups"][1]["master"]
saved = m2.read_bytes()
m2.write_bytes(saved[: len(saved) // 2])
s10 = p._render_state(data_for())
check("a damaged clip is caught before it is used",
      s10["kept_groups"] == 1 and "damaged" in (s10.get("reason") or ""), s10)
m2.unlink()
s11 = p._render_state(data_for())
check("a missing clip is caught", s11["kept_groups"] == 1 and "missing" in s11["reason"], s11)
m2.write_bytes(saved)
check("  ... and all is well once it is back", p._render_state(data_for())["kept_groups"] == 2)

# ================================================================ zip round trip
print("\nthe clips travel with the project:")
m.PROJECT_JSON.write_text(json.dumps({"app": m.PLUGIN_ID, "project_name": "resume-test", "media": {}}))
z = p._save_project_zip({"dir": str(TMP / "projects"), "name": "resume-test"})
with zipfile.ZipFile(z["path"]) as zf:
    info = {i.filename: i for i in zf.infolist()}
check("the zip holds the record and both clips",
      "render.json" in info and sum(n.startswith("renders/") for n in info) == 2, sorted(info))
check("the clips are stored, not deflated",
      all(i.compress_type == zipfile.ZIP_STORED for n, i in info.items() if n.startswith("renders/")))
backup = TMP / "ws_backup"
shutil.copytree(WS, backup)
p._clear_all({"confirmed": True})
check("Clear All removes the clips and the record",
      not list(m.RENDERS_DIR.glob("*")) and not m.RENDER_JSON.exists())
check("  ... so there is nothing to continue", not p._render_state(data_for())["has_record"])
p._open_project_zip({"path": z["path"]})
check("opening the zip brings them back", m.RENDER_JSON.exists() and len(list(m.RENDERS_DIR.glob("*.mkv"))) == 2)
check("  ... and the render can still be continued", p._render_state(data_for())["resumable"])

# ================================================================ continue
print("\nContinue:")
submitted.clear()
tails.clear()
fr = run(data_for(), make_submit(), resume=True)
check("the run finishes", fr[-1]["status"] == "done", fr[-1])
check("only the unfinished group is rendered", len(submitted) == 1, len(submitted))
st = submitted[0]
check("it is the fifth window", st["prompt"].startswith("WIN=4"), st["prompt"][:20])
check("on the seed the finished groups used", st["seed"] == seed_first, (st["seed"], seed_first))
check("continuing from the last clip's tail", bool(st.get("video_source")) and "V" in st["image_prompt_type"])
check("  ... which is that clip's last %d frames exactly" % OVL,
      nframes(st["video_source"]) == OVL and tails and tails[-1][1], tails[-1:] if tails else None)
check("the start image is not sent to a later group", "S" not in st["image_prompt_type"].replace("V", "")
      or not st["image_prompt_type"].startswith("S"))
joined = fr[-1]["files"][0]
check("the joined video is the whole timeline (%d frames)" % TOTAL, nframes(joined) == TOTAL, nframes(joined))
worst, count = matches_reference(joined)
check("and matches the reference at every frame, joins included (worst PSNR %.1f dB)" % worst,
      worst > 30 and count == TOTAL, (worst, count))
check("it is written beside Wan2GP's renders, not into the workspace",
      Path(joined).parent == OUT, joined)
rec = record()
check("the record is closed", rec["status"] == "complete" and rec["joined"] == joined)
check("with all three groups", len(rec["groups"]) == 3)
st2 = p._render_state(data_for())
check("a finished render offers no Continue", not st2["resumable"] and st2["complete"], st2)

# ================================================================ cancel, regroup
print("\ncancel, then continue at a different group size:")
submitted.clear()
fr = run(data_for(), make_submit(cancel_at=2))
check("a fresh Generate starts over", submitted[0]["prompt"].startswith("WIN=0"))
check("  ... and clears the previous render's clips first",
      len(list(m.RENDERS_DIR.glob("*.mkv"))) == 1, sorted(f.name for f in m.RENDERS_DIR.glob("*")))
check("a cancel says the finished groups are kept",
      fr[-1]["status"] == "cancelled" and "Continue" in json.dumps(fr[-1]["logs"]), fr[-1])
seed2 = record()["seed"]
submitted.clear()
fr = run(data_for(group=1), make_submit(), resume=True, group=1)
check("Continue at one window per group renders the rest one by one",
      [re.search(r"WIN=(\d+)", s["prompt"]).group(1) for s in submitted] == ["2", "3", "4"],
      [s["prompt"][:6] for s in submitted])
check("on the same seed", all(s["seed"] == seed2 for s in submitted))
joined = fr[-1]["files"][0]
worst, count = matches_reference(joined)
check("the joined video still matches the reference (worst PSNR %.1f dB)" % worst,
      worst > 30 and count == TOTAL and nframes(joined) == TOTAL, (worst, count, nframes(joined)))

print("\nWan2GP returning more than it was asked for:")
submitted.clear()
tails.clear()
fr = run(data_for(), make_submit(overshoot=3))
joined = fr[-1]["files"][0] if fr[-1]["status"] == "done" else None
check("the run finishes", bool(joined), fr[-1])
if joined:
    worst, count = matches_reference(joined)
    check("the joins neither skip nor repeat a frame (worst PSNR %.1f dB)" % worst,
          worst > 30 and count == TOTAL and nframes(joined) == TOTAL, (worst, count, nframes(joined)))
check("each later group was handed exactly the frames before its slot",
      len(tails) == 2 and all(ok for _, ok, _, _ in tails), tails)

print("\nthe soundtrack across the joins:")
import numpy as np
SR = 16000


def pcm(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1",
                        "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


SONG_FILE = TMP / "song.wav"
# A sweep with a wobble: no stretch of it sounds like any other, so a repeat or
# a skip at a join shows up as the audio landing at the wrong moment.
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                "aevalsrc=0.5*sin(2*PI*(200+120*t)*t)+0.3*sin(2*PI*(90+9*t*t)*t):s=48000:d=%.3f"
                % (TOTAL / FPS + 1.0), "-c:a", "pcm_s16le", str(SONG_FILE)], check=True)
song = pcm(SONG_FILE)


def lag_at(audio, t, span=0.25, search=1.0):
    """Where, in the song, the audio heard at time t actually comes from,
    as seconds late (+) or early (-)."""
    a = audio[int(t * SR):int((t + span) * SR)]
    lo = max(0, int((t - search) * SR))
    hi = min(len(song), int((t + search + span) * SR))
    ref = song[lo:hi]
    best, where = -1e9, 0
    for i in range(0, len(ref) - len(a), 4):
        c = float(np.dot(ref[i:i + len(a)], a))
        if c > best:
            best, where = c, i
    return (lo + where) / SR - t


SONG["path"] = str(SONG_FILE)
try:
    runs = [("straight through", make_submit()),
            ("Wan2GP returning more than asked", make_submit(overshoot=3))]
    if WAN_MUX:
        runs.append(("muxed the way WanGP muxes a continuation", make_submit(wan_mux=True)))
    else:
        print("  (WanGP source not found: its continuation muxing is not simulated)")
    for label, submit in runs:
        submitted.clear()
        tail_audio.clear()
        fr = run(data_for(), submit)
        joined = fr[-1]["files"][0] if fr[-1]["status"] == "done" else None
        check("%s: the run finishes" % label, bool(joined), fr[-1])
        if not joined:
            continue
        check("%s: every group was handed its own stretch of the song" % label,
              all(s.get("audio_guide") and s["audio_guide"] != SONG["path"] for s in submitted),
              [s.get("audio_guide") for s in submitted])
        tail_audio_seen = [x for x in tail_audio]
        check("%s: the carried frames bring their sound, exactly as long as them" % label,
              len(tail_audio_seen) == 2 and all(abs(len(b) / 4 / SR - OVL / FPS) < 0.03 for _, _, b in tail_audio_seen),
              [(k, len(b) / 4 / SR) for k, _, b in tail_audio_seen])
        for k, g0, b in tail_audio_seen:
            a = np.frombuffer(b, dtype=np.float32)
            if len(a) > SR // 10:
                t = g0 / FPS
                seg = song[int(t * SR):int(t * SR) + len(a)]
                n_ = min(len(seg), len(a))
                c = float(np.dot(seg[:n_], a[:n_]) / (np.linalg.norm(seg[:n_]) * np.linalg.norm(a[:n_]) + 1e-9))
                check("%s: window %d's carried sound is the previous clip's last %d frames' sound (corr %.3f)"
                      % (label, k + 1, OVL, c), c > 0.95, c)
        aud = pcm(joined)
        check("%s: the stitched audio is the length of the piece (%.2fs)" % (label, TOTAL / FPS),
              abs(len(aud) / SR - TOTAL / FPS) < 0.06, len(aud) / SR)
        joins = [sum(WF[:2]), sum(WF[:4])]
        for j in joins:
            t = j / FPS
            lags = [lag_at(aud, t - 0.4), lag_at(aud, t + 0.05), lag_at(aud, t + 0.8)]
            check("%s: the audio at the join at %.2fs neither repeats nor skips (off by %s ms)"
                  % (label, t, "/".join("%+.0f" % (1000 * x) for x in lags)),
                  all(abs(x) < 0.012 for x in lags), lags)
finally:
    SONG["path"] = None

print("\nsplitting a clip into its windows:")
submitted.clear()
fr = run(data_for(), make_submit())
joined0 = fr[-1]["files"][0]
before = record()
g1 = before["groups"][0]
check("(a finished render in groups of two windows)", fr[-1]["status"] == "done"
      and g1["n_windows"] == 2 and len(before["groups"]) == 3, [x["n_windows"] for x in before["groups"]])
out = p._render_split({**data_for(), "group": 1})
after = record()
check("G1 became two clips, one per window", out.get("pieces") == 2 and len(after["groups"]) == 4
      and [x["n_windows"] for x in after["groups"][:2]] == [1, 1]
      and [x["first_window"] for x in after["groups"][:2]] == [0, 1], [x["master"] for x in after["groups"]])
for x in after["groups"][:2]:
    mp = m.RENDERS_DIR / x["master"]
    worst, count = matches_reference(mp, start=x["start"])
    check("  window %d's clip is exactly its frames (%d, worst PSNR %.1f dB)" % (x["first_window"] + 1, x["frames_got"], worst),
          nframes(mp) == x["frames_got"] == WF[x["first_window"]] and worst > 30 and count == x["frames_got"],
          (nframes(mp), x["frames_got"], worst, count))
    codec = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(mp)],
                           capture_output=True, text=True).stdout.split()
    check("  ... still lossless FFV1 with PCM audio", codec == ["ffv1", "pcm_s24le"], codec)
check("the old clip is gone", not (m.RENDERS_DIR / g1["master"]).exists())
rs = p._render_state(data_for())
check("the timeline check keeps every clip", rs["kept_groups"] == 4 and rs["complete"], (rs.get("kept_groups"), rs.get("reason")))
check("the stitched video is still counted as up to date (same frames)", not rs["stitch_stale"], rs.get("stitch_why"))
st = p._stitch({"name": "after-split", "dir": str(TMP / "split")})
worst, count = matches_reference(st["path"])
check("stitching the split clips gives the same piece, frame for frame (worst %.1f dB)" % worst,
      worst > 30 and count == TOTAL and nframes(st["path"]) == TOTAL, (worst, count))
try:
    p._render_split({**data_for(), "group": 1})
    check("a one-window clip cannot be split again", False)
except ValueError as e:
    check("a one-window clip cannot be split again", "single window" in str(e), str(e))
check("the pieces were copied frame for frame, not encoded again", out.get("copied") is True, out)
check("every piece keeps its own check of its window", all(len(x.get("window_hashes") or []) == 1 for x in after["groups"][:2]))
p._job = object()
try:
    p._render_split({**data_for(), "group": 3})
    check("not while a render is running", False)
except ValueError as e:
    check("not while a render is running", "running" in str(e), str(e))
p._job = None

# The UI's way: it starts, answers at once, and tells how far it has got.
g3_master = record()["groups"][2]["master"]
# window 3's prompt is changed first: the clip is still split, and only the
# piece for window 3 is then shown as changed
changed = data_for(prompts=PROMPTS[:2] + ["rain starts, HARDER"] + PROMPTS[3:])
st0 = p._render_split_start({**changed, "group": 3})
check("a split started from the page answers at once", st0.get("started") and st0.get("pieces") == 2, st0)
try:
    p._stitch({"name": "x", "dir": str(TMP / "split")})
    busy_ok = p._split_state().get("state") != "running"   # already finished: nothing to refuse
except ValueError as e:
    busy_ok = "split" in str(e)
check("  ... nothing else that rewrites the clips can start meanwhile", busy_ok)
seen_states = []
for _ in range(600):
    js = p._split_state()
    seen_states.append((js.get("state"), js.get("done"), js.get("total")))
    if js.get("state") != "running":
        break
    time.sleep(0.05)
check("  ... split_state reports it running, then done", js.get("state") == "done" and js.get("total") == 2
      and js.get("done") == 2, seen_states[-3:])
check("  ... and the lock is off once it has finished", not getattr(p, "_splitting", False))
rec3 = record()
check("  ... G3 became two clips", len(rec3["groups"]) == len(after["groups"]) + 1
      and [x["n_windows"] for x in rec3["groups"][2:4]] == [1, 1], [x["n_windows"] for x in rec3["groups"]])
check("  ... and the old clip is gone", not (m.RENDERS_DIR / g3_master).exists())
rs3 = p._render_state(changed)
flags = [c.get("changed") for c in rs3["clips"]]
check("a clip whose prompt changed is still split, and only the piece whose prompt changed shows as changed",
      flags == [False, False, True, False, False], flags)
try:
    p._render_split_start({**data_for(), "group": 99})
    check("a split that cannot be done says so straight away", False)
except ValueError as e:
    check("a split that cannot be done says so straight away", "no clip" in str(e), str(e))

print("\nthe run is active from first group to last:")
seen = []
actives = []
def peeking_submit(st, _inner=make_submit()):
    rs = p._render_state(data_for())
    seen.append(rs["running"])
    actives.append((rs.get("active") or {}).get("start"))
    return _inner(st)
list(p._groups_guarded(data_for(), {"seed": -1}, peeking_submit, frame, float(FPS), 243, OVL,
                       list(WF), 2))
check("the resume card is told a run is going, between groups too", seen and all(seen), seen)
check("and that it is over once it is", not p._render_state(data_for())["running"])
check("the results track is told which part is rendering now",
      actives == [0, WF[0] + WF[1], sum(WF[:4])], actives)
check("  ... and nothing once the run is over", p._render_state(data_for())["active"] is None)

print("\nseed 0 means random, as the run reads it:")
submitted.clear()
fr = run(data_for(seed=0), make_submit(crash_at=3))
check("a render on seed 0 can be continued", p._render_state(data_for(seed=0))["resumable"],
      p._render_state(data_for(seed=0)).get("reason"))

print("\nwhen ffprobe itself fails:")
real_count = renders.count_frames
masters_before = sorted(f.name for f in m.RENDERS_DIR.glob("*.mkv"))
rec = record()
for g in rec["groups"]:
    g.pop("bytes", None)          # force a real count
renders.write_record(m.RENDER_JSON, rec)
p.__dict__.pop("_frame_cache", None)
def broken(*a, **k):
    raise renders.ProbeError("ffprobe could not run")
renders.count_frames = broken
submitted.clear()
fr = run(data_for(), make_submit(), resume=True)
renders.count_frames = real_count
check("Continue stops and says why", fr[-1]["status"] == "error" and "Nothing was removed" in fr[-1]["error"], fr[-1])
check("  ... having rendered nothing", not submitted)
check("  ... and removed nothing", sorted(f.name for f in m.RENDERS_DIR.glob("*.mkv")) == masters_before)
check("the resume card does not call the clips damaged",
      "damaged" not in (p._render_state(data_for()).get("reason") or ""))

print("\na gap in the record:")
rec = record()
g2 = dict(rec["groups"][1])
rec["groups"] = [rec["groups"][0], dict(g2, first_window=g2["first_window"] + 1)]
renders.write_record(m.RENDER_JSON, rec)
s12 = p._render_state(data_for())
check("groups that do not follow on are not kept", s12["kept_groups"] == 1 and "gap" in (s12["reason"] or ""), s12)

print("\nthe zip:")
extra = m.RENDERS_DIR / "stray.mkv"
extra.write_bytes(b"x")
z = p._save_project_zip({"dir": str(TMP / "projects2"), "name": "z2"})
with zipfile.ZipFile(z["path"]) as zf:
    names = zf.namelist()
check("holds only the clips the record names", "renders/stray.mkv" not in names
      and sorted(n[8:] for n in names if n.startswith("renders/"))
      == sorted(g["master"] for g in record()["groups"]), names)
check("and no temporary file is left beside it", not list((TMP / "projects2").glob("*.partial")))
extra.unlink()

print("\na one-group render hands back Wan2GP's file:")
submitted.clear()
fr = list(json.loads(f) for f in p._run_groups(
    data_for(), {"seed": -1}, make_submit(), frame, float(FPS), 243, OVL, list(WF), 9, resume=False))
check("not the master in the workspace", fr[-1]["status"] == "done"
      and Path(fr[-1]["files"][0]).parent == OUT, fr[-1].get("files"))

print("\na fresh Generate that does not know about the unfinished render:")
submitted.clear()
run(data_for(), make_submit(crash_at=3))            # leaves a resumable render
p._wangp_session = types.SimpleNamespace(submit_task=make_submit())
masters_before = sorted(f.name for f in m.RENDERS_DIR.glob("*.mkv"))
submitted.clear()
d = data_for()
out = [json.loads(f)["data"] for f in p._generate_stream(json.dumps({"data": d}))]
check("keeps the finished groups: only what is not rendered yet is rendered",
      out[-1]["status"] == "done" and [re.search(r"WIN=(\d+)", x["prompt"]).group(1) for x in submitted] == ["4"],
      [x["prompt"][:6] for x in submitted])
check("  ... and nothing finished was removed",
      set(masters_before) <= set(f.name for f in m.RENDERS_DIR.glob("*.mkv")))
submitted.clear()
d = data_for()
out = [json.loads(f)["data"] for f in p._generate_stream(json.dumps({"data": d}))]
check("with everything rendered, Generate holds rather than replace anything",
      out[-1]["status"] == "error" and "Nothing was replaced" in out[-1]["error"] and not submitted, out[-1])
submitted.clear()
d["discard_ok"] = True
out = [json.loads(f)["data"] for f in p._generate_stream(json.dumps({"data": d}))]
revs = [f.get("render_rev") for f in out]
check("every progress frame carries the results-track revision", all(isinstance(r, int) for r in revs), revs[:5])
check("  ... and it moves on as groups start and are saved", len(set(revs)) >= 1 + 2 * 3 and revs == sorted(revs),
      revs)
check("with the user's go-ahead it starts over", out[-1]["status"] == "done"
      and submitted and submitted[0]["prompt"].startswith("WIN=0"), out[-1])
submitted.clear()
d2 = data_for(); d2["resume"] = True
run(data_for(), make_submit(crash_at=2))            # group 1 done, group 2 crashed
submitted.clear()
out = [json.loads(f)["data"] for f in p._generate_stream(json.dumps({"data": d2}))]
check("Continue through the real entry point picks up after the finished group",
      out[-1]["status"] == "done" and [re.search(r"WIN=(\d+)", x["prompt"]).group(1) for x in submitted] == ["2", "4"],
      [x["prompt"][:6] for x in submitted])

print("\nContinue with nothing to keep:")
m2 = sorted(m.RENDERS_DIR.glob("*.mkv"))[0]
m2.unlink()
rec = record(); rec["status"] = "running"; renders.write_record(m.RENDER_JSON, rec)
submitted.clear()
fr = run(data_for(), make_submit(), resume=True)
check("refuses rather than silently starting over",
      fr[-1]["status"] == "error" and "Nothing to continue" in fr[-1]["error"] and not submitted, fr[-1])

if not os.environ.get("KEEP_TMP"):
    shutil.rmtree(TMP, ignore_errors=True)
else:
    print("kept", TMP)
print()
if fails:
    print("%d RESUME CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL RESUME CHECKS PASSED")
