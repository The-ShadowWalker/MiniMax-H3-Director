#!/usr/bin/env python3
"""Regenerating marked clips in place, end to end, on real video.

The stand-in for Wan2GP here behaves the way the real one does where it
matters: every window is moved onto the model's frame grid (a 120-frame
window comes back 124, or 123 after carried frames), it continues from the
frames it is HANDED -- it finds where they are in the piece by looking at
them -- and a pinned end frame is only honoured if the length the plugin
asked for really lands on it. Nothing it does is taken from the plugin's own
numbers, so a regen that starts or ends a frame off shows up as a stitched
video that stops matching the reference at that join.

Checked: a middle clip (continue from the one before, land on the one after),
the first clips as one stretch (land only), the last clip (continue only),
that neighbours are trimmed rather than skipped, that a wrong length keeps the
old clips, seeds, and that a regenerated group matches the timeline again.
Needs ffmpeg and ffprobe.
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
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

g = types.ModuleType("gradio"); sys.modules["gradio"] = g


class WAN2GPPlugin:
    def __init__(self, *a, **k):
        pass


shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp})
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("h3d_plugin_regen", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
renders = m.renders

TMP = Path(tempfile.mkdtemp(prefix="h3d_regen_"))
WS = TMP / "workspace"
m.WORKSPACE, m.MEDIA_DIR, m.DERIVED_DIR = WS, WS / "media", WS / "derived"
m.RENDERS_DIR, m.RENDER_JSON = WS / "renders", WS / "render.json"
m.PROJECT_JSON, m.PROJECT_BAK, m.HISTORY_DIR = WS / "project.json", WS / "project.json.bak", WS / "history"
m.PLUGIN_DIR = TMP
m.trace = lambda *a, **k: None
for d in (m.MEDIA_DIR, m.DERIVED_DIR):
    d.mkdir(parents=True, exist_ok=True)

p = m.H3Director2Plugin.__new__(m.H3Director2Plugin)
p._grid = dict(m._GRID_FALLBACK)
p._jobstate = {}
p._job = None
p._assemble_settings = lambda pg: {
    "prompt": pg["prompt"], "seed": -1,
    "image_prompt_type": ("S" if (pg.get("media") or {}).get("image_start") else "")
                         + ("E" if (pg.get("media") or {}).get("image_end") else ""),
    "image_start": (pg.get("media") or {}).get("image_start"),
    "image_end": (pg.get("media") or {}).get("image_end")}
p._normalize_audio_guide = lambda st: st
p._strip_unsatisfied = lambda st: st
p._log_prompt = lambda *a, **k: None
p._release_model = lambda *a, **k: None
p._vram_note = lambda: ""
p._start_background_drain = lambda job: None
p._reset_job_state = lambda **k: None

FPS, OVL = 24, 18
WF = [120, 96, 120, 72, 110]
TOTAL = sum(WF)
STARTS = [sum(WF[:i]) for i in range(len(WF))]
OUT = TMP / "wan2gp_outputs"; OUT.mkdir()
REF = TMP / "reference.mkv"
# Timeline frame t is REF frame t + PAD: a regen of the opening clip can start a
# few frames before 0:00, and the stand-in needs picture to show there too.
PAD = 60
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=%d" % FPS,
                "-frames:v", str(TOTAL + 2 * PAD + 100), "-c:v", "ffv1", str(REF)], check=True)


def nframes(path):
    return renders.count_frames("ffprobe", path)


def psnr_series(img_or_clip, start, count):
    """PSNR of one frame against REF frames start..start+count-1."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(REF), "-loop", "1", "-i", str(img_or_clip),
                        "-lavfi", "[0:v]trim=start_frame=%d:end_frame=%d,setpts=N/(%d*TB)[r];"
                                  "[1:v]scale=256:144,format=yuv420p,setpts=N/(%d*TB)[q];[r][q]psnr=stats_file=-"
                                  % (max(0, start), start + count, FPS, FPS),
                        "-frames:v", str(count), "-f", "null", "-"],
                       capture_output=True, text=True)
    return [float(x) for x in re.findall(r"psnr_avg:([0-9.]+|inf)", r.stdout.replace("inf", "99"))]


def locate(image, around, span=60):
    """Where on the timeline this picture is: the frame it matches best."""
    lo = max(0, around + PAD - span)
    vals = psnr_series(image, lo, 2 * span)
    best = max(range(len(vals)), key=lambda i: vals[i])
    return lo + best - PAD, vals[best]


def first_frame(clip, out):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-frames:v", "1", str(out)], check=True)
    return out


jobs = []            # what the stand-in saw, per submit


def fake_wan2gp(extra_frames=0):
    def submit(st):
        k = int(re.search(r"WIN=(\d+)", st["prompt"]).group(1))
        durs = [int(round(float(x) * FPS)) for x in m.H3Director2Plugin._DURATION_TAG.findall(st["prompt"])]
        carry = 0
        info = {"win": k, "durs": durs}
        if st.get("video_source"):
            carry = nframes(st["video_source"])
            pos, q = locate(first_frame(st["video_source"], TMP / "c0.png"), STARTS[k] - carry)
            info.update(carry=carry, carried_from=pos, carry_q=q)
        # Wan2GP's own geometry: each window on the frame grid
        outs = m._scheduler_outputs(([OVL] + durs) if carry else durs, 481, OVL, p._grid)
        outs = outs[1:] if carry else outs
        new = sum(outs) + extra_frames
        if carry:
            x = info["carried_from"]
        elif st.get("image_end"):
            e, q = locate(st["image_end"], STARTS[min(k + len(durs), len(WF) - 1)])
            x = e - (new - 1)
            info.update(landing_at=e)
        else:
            x = STARTS[k]
        n = carry + new
        if st.get("image_end"):
            e, q = locate(st["image_end"], x + n - 1)
            info.update(landing_at=e, landed=(x + n - 1 == e))
        if st.get("image_start"):
            info.update(start_at=x)            # output frame 0 IS the start image only if x is its frame
        info.update(x=x, n=n)
        jobs.append(info)
        out = OUT / ("render_%02d.mp4" % len(jobs))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(REF), "-f", "lavfi", "-i",
                        "sine=frequency=330:sample_rate=48000",
                        "-vf", "trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS" % (x + PAD, x + PAD + n),
                        "-af", "atrim=end=%.4f" % (n / FPS), "-map", "0:v", "-map", "1:a",
                        "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", str(out)],
                       check=True)

        class J:
            done = True
            events = None

            def result(self):
                return types.SimpleNamespace(success=True, generated_files=[str(out)], cancelled=False, errors=[])
        return J()
    return submit


def frame(status, progress=0.0, window=0, windows=0, logs=None, files=None, error="", **k):
    return json.dumps({"status": status, "logs": logs or [], "files": files or [], "error": error})


PROMPTS = ["a quiet street", "a dog runs", "rain starts", "the dog shelters", "sun again"]


def data_for(prompts=PROMPTS, media=None):
    return {"fps": FPS, "target_frames": TOTAL, "project_name": "regen-test",
            "settings": {"prompt": "\n\n".join("WIN=%d %s [/duration=%.4fs]" % (i, t, WF[i] / FPS)
                                                for i, t in enumerate(prompts)),
                         "seed": -1, "sliding_window_size": 243, "sliding_window_overlap": OVL, "fps": FPS,
                         "manual_windows": True, "window_frames": list(WF), "group_windows": 1,
                         "media": dict(media or {}), "model_type": "minimax_h3_hybrid"}}


def record():
    return json.loads(m.RENDER_JSON.read_text())


def stitched_matches(tag):
    rec = record()
    parts = [{"path": str(m.RENDERS_DIR / g["master"]), "trim_start_frames": 0, "trim_end_frames": 0}
             for g in rec["groups"]]
    j = p._join_videos({"parts": parts, "fps": FPS, "dir": str(TMP / "joined"), "name": tag})["path"]
    n = nframes(j)
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", j, "-i", str(REF), "-lavfi",
                        "[1:v]trim=start_frame=%d:end_frame=%d,setpts=N/(%d*TB)[r];[0:v]setpts=N/(%d*TB)[v];"
                        "[v][r]psnr=stats_file=-" % (PAD, PAD + n, FPS, FPS), "-f", "null", "-"],
                       capture_output=True, text=True)
    vals = [float(x) for x in re.findall(r"psnr_avg:([0-9.]+|inf)", r.stdout.replace("inf", "99"))]
    worst = min(vals) if vals else 0
    at = vals.index(worst) if vals else -1
    return n, worst, at


def contiguous():
    gs = record()["groups"]
    return all(gs[i]["start"] + gs[i]["frames_got"] == gs[i + 1]["start"] for i in range(len(gs) - 1)) \
        and gs[0]["start"] == 0 and gs[-1]["start"] + gs[-1]["frames_got"] == TOTAL


def regen(groups, seed="same", submit=None, media=None):
    return [json.loads(f) for f in p._regen_guarded(data_for(media=media), submit or fake_wan2gp(), frame,
                                                    float(FPS), list(WF), groups, seed)]


# ================================================================ the render
print("a grouped render, one window per group:")
fr = [json.loads(f) for f in p._run_groups(data_for(), {"seed": 4321}, fake_wan2gp(), frame, float(FPS),
                                           243, OVL, list(WF), 1)]
check("renders", fr[-1]["status"] == "done", fr[-1])
check("every later group was carried on from exactly the end of the one before",
      all(j["carried_from"] == STARTS[j["win"]] - OVL for j in jobs[1:]),
      [(j["win"], j.get("carried_from"), STARTS[j["win"]] - OVL) for j in jobs[1:]])
n, worst, at = stitched_matches("render")
check("right after the render the full video is up to date", not p._stitch_status(record())["stitch_stale"],
      p._stitch_status(record()))
check("the joined clips are the whole piece, seamless (worst %.1f dB)" % worst, n == TOTAL and worst > 30,
      (n, worst, at))
check("the clips tile the timeline", contiguous())
before = record()

# ================================================================ a middle clip
print("\nregen group 3 (between two clips):")
jobs.clear()
fr = regen([3])
job = jobs[-1] if jobs else {}
check("it is done", fr[-1]["status"] == "done", fr[-1])
check("one job, continuing from the clip before", len(jobs) == 1 and job.get("carry") == OVL, jobs)
check("and it really landed on the next clip's first frame", job.get("landed") is True and job.get("landing_at") == STARTS[3],
      job)
rec = record()
g2, g3 = rec["groups"][1], rec["groups"][2]
shift = STARTS[2] - g3["start"]
check("it started %d frame(s) early, and the clip before gave them up" % shift,
      g2["frames_got"] == before["groups"][1]["frames_got"] - shift and job.get("carried_from") == STARTS[2] - shift - OVL,
      (shift, g2["frames_got"], job))
check("the new clip replaced the old one", g3["master"] != before["groups"][2]["master"]
      and not (m.RENDERS_DIR / before["groups"][2]["master"]).exists() and g3.get("take") == 2)
check("on the render's own seed -- a regen never changes it", g3["seed"] == before["seed"] == rec["seed"],
      (g3["seed"], before["seed"]))
st = p._stitch_status(rec)
check("the full video is now out of date, and it says which clip", st["stitch_stale"] and "G3" in st["stitch_why"], st)
check("the clips still tile the timeline", contiguous(), [(x["start"], x["frames_got"]) for x in rec["groups"]])
check("every clip on disk is the length the record says",
      all(nframes(m.RENDERS_DIR / x["master"]) == x["frames_got"] for x in rec["groups"]))
n, worst, at = stitched_matches("mid")
check("the stitched piece is still seamless at both joins (worst %.1f dB)" % worst, n == TOTAL and worst > 30,
      (n, worst, at))

sres = p._stitch({"name": "after-regen", "dir": str(TMP / "joined")})
check("Stitch brings it up to date", sres.get("ok") and not p._stitch_status(record())["stitch_stale"],
      (sres, p._stitch_status(record())))
check("  ... from the new take", record()["joined_masters"] == [g["master"] for g in record()["groups"]])

# a "new" seed from an older UI is ignored too
_fr = regen([2], seed="new")
check("an old UI asking for a new seed still gets the render's own",
      _fr[-1]["status"] == "done" and record()["groups"][1]["seed"] == record()["seed"], _fr[-1])

# ================================================================ first two, as one stretch
print("\nregen groups 1 and 2 (next to each other, at the start):")
jobs.clear()
fr = regen([1, 2])
check("done, as ONE job", fr[-1]["status"] == "done" and len(jobs) == 1, (fr[-1], len(jobs)))
check("landing exactly on group 3", jobs and jobs[-1].get("landed") is True, jobs)
check("the clips still tile the timeline", contiguous(), [(x["start"], x["frames_got"]) for x in record()["groups"]])
n, worst, at = stitched_matches("first")
check("seamless (worst %.1f dB)" % worst, n == TOTAL and worst > 30, (n, worst, at))

# ================================================================ the last clip
print("\nregen group 5 (the end of the piece):")
jobs.clear()
fr = regen([5], seed="same")
check("done, continuing from group 4 with nothing to land on",
      fr[-1]["status"] == "done" and jobs and jobs[-1].get("carry") == OVL and "landed" not in jobs[-1], jobs)
check("on the render's own seed when asked", record()["groups"][4]["seed"] == record()["seed"])
n, worst, at = stitched_matches("last")
check("seamless (worst %.1f dB)" % worst, n == TOTAL and worst > 30, (n, worst, at))

# ================================================================ a wrong length
print("\nwhen Wan2GP comes back a different length:")
snap = json.dumps(record())
files = sorted(f.name for f in m.RENDERS_DIR.glob("*.mkv"))
fr = regen([4], submit=fake_wan2gp(extra_frames=3))
check("the regen is refused", fr[-1]["status"] == "error" and "not the" in json.dumps(fr[-1]), fr[-1])
check("  ... and the old clips are exactly as they were",
      json.dumps(record()) == snap and sorted(f.name for f in m.RENDERS_DIR.glob("*.mkv")) == files)

# ================================================================ statuses
print("\nregen brings a changed clip back in line:")
changed = PROMPTS[:3] + ["the dog runs home"] + PROMPTS[4:]
st = p._render_state(data_for(changed))
check("changing group 4's prompt marks it redo, and 5 after",
      [c["status"] for c in st["clips"]][3:] == ["redo", "after"], [c["status"] for c in st["clips"]])
jobs.clear()
fr = [json.loads(f) for f in p._regen_guarded(data_for(changed), fake_wan2gp(), frame, float(FPS), list(WF), [4], "new")]
st = p._render_state(data_for(changed))
check("after regenerating group 4 every clip matches the timeline again",
      fr[-1]["status"] == "done" and all(c["status"] == "done" for c in st["clips"]), [c["status"] for c in st["clips"]])
n, worst, at = stitched_matches("changed")
check("and the piece is still seamless (worst %.1f dB)" % worst, n == TOTAL and worst > 30, (n, worst, at))

print("\na piece that opens on a start image and ends on an end image:")
startimg, endimg = TMP / "start.png", TMP / "end.png"
for t, out in ((0, startimg), (TOTAL - 1, endimg)):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(REF), "-vf", "select=eq(n\\,%d)" % (t + PAD),
                    "-frames:v", "1", str(out)], check=True)
PINS = {"image_start": str(startimg), "image_end": str(endimg)}
p._render_discard()
jobs.clear()
fr = [json.loads(f) for f in p._run_groups(data_for(media=PINS), {"seed": 99}, fake_wan2gp(), frame, float(FPS),
                                           243, OVL, list(WF), 1)]
last_job = jobs[-1]
check("renders", fr[-1]["status"] == "done", fr[-1])
check("the first group starts on the start image", jobs[0].get("start_at") == 0, jobs[0])
check("the last group really ends on the end image", last_job.get("landed") is True
      and last_job.get("landing_at") == TOTAL - 1, last_job)
check("  ... and its clip keeps that frame (the piece is exactly the timeline)", contiguous(),
      [(x["start"], x["frames_got"]) for x in record()["groups"]])
n, worst, at = stitched_matches("pins")
check("seamless, first frame to last (worst %.1f dB)" % worst, n == TOTAL and worst > 30, (n, worst, at))
jobs.clear()
fr = regen([1], media=PINS)
check("regen of the opening clip keeps the start image", fr[-1]["status"] == "done"
      and jobs and jobs[-1].get("start_at") == 0 and jobs[-1].get("landed") is True, (fr[-1], jobs))
check("  ... by landing a little into the next clip, which gives those frames up", contiguous(),
      [(x["start"], x["frames_got"]) for x in record()["groups"]])
jobs.clear()
fr = regen([5], media=PINS)
check("regen of the closing clip keeps the end image", fr[-1]["status"] == "done"
      and jobs and jobs[-1].get("landed") is True and jobs[-1].get("landing_at") == TOTAL - 1, (fr[-1], jobs))
n, worst, at = stitched_matches("pins2")
check("and the piece is still seamless, first frame to last (worst %.1f dB)" % worst,
      n == TOTAL and worst > 30 and contiguous(), (n, worst, at))

print("\nwhat the results track is told:")
two = PROMPTS[:1] + ["a CAT runs"] + PROMPTS[2:3] + ["the cat shelters"] + PROMPTS[4:]
st = p._render_state(data_for(two, media=PINS))
check("each clip whose own prompt changed is flagged, not just the first",
      [bool(c.get("changed")) for c in st["clips"]] == [False, True, False, True, False],
      [c.get("changed") for c in st["clips"]])
rec = record(); rec["status"] = "running"; rec["joined"] = None; renders.write_record(m.RENDER_JSON, rec)
st = p._render_state(data_for(media=PINS))
check("every window rendered and matching counts as finished, even if the final join never ran",
      st["complete"] and not st["resumable"], {k: st[k] for k in ("complete", "resumable", "kept_groups")})

print("\nregen refuses when the settings the clips were made with changed:")
d = data_for(media=PINS); d["settings"]["num_inference_steps"] = 40
fr = [json.loads(f) for f in p._regen_guarded(d, fake_wan2gp(), frame, float(FPS), list(WF), [3], "new")]
check("with the setting named", fr[-1]["status"] == "error" and "num_inference_steps" in fr[-1]["error"], fr[-1])

print("\nStitch:")
st_out = p._stitch({"name": "regen-test", "dir": str(TMP / "stitched")})
n = nframes(st_out["path"])
r = subprocess.run(["ffmpeg", "-v", "error", "-i", st_out["path"], "-i", str(REF), "-lavfi",
                    "[1:v]trim=start_frame=%d:end_frame=%d,setpts=N/(%d*TB)[r];[0:v]setpts=N/(%d*TB)[v];"
                    "[v][r]psnr=stats_file=-" % (PAD, PAD + n, FPS, FPS), "-f", "null", "-"],
                   capture_output=True, text=True)
vals = [float(x) for x in re.findall(r"psnr_avg:([0-9.]+|inf)", r.stdout.replace("inf", "99"))]
check("joins every clip into the whole piece, after all the regens (worst %.1f dB)" % min(vals),
      n == TOTAL and min(vals) > 30 and st_out["complete"], (n, min(vals), st_out))
check("  ... written outside the workspace", Path(st_out["path"]).parent == TMP / "stitched")
check("  ... and recorded as the piece's joined video", record()["joined"] == st_out["path"])

shutil.rmtree(TMP, ignore_errors=True)
print()
print("\nhand-set windows always cover exactly the timeline:")
pw = lambda wf, tgt: p._plan_window_frames({"manual_windows": True, "window_frames": wf}, tgt, 243, OVL, True)
check("short of the timeline: the last window takes the rest, no window is added",
      pw([120, 96, 120], 400) == [120, 96, 184], pw([120, 96, 120], 400))
check("past the timeline: the last window gives it up", pw([120, 96, 120], 300) == [120, 96, 84], pw([120, 96, 120], 300))
check("  ... and is dropped only when nothing of it is left", pw([120, 96, 20], 200) == [120, 80], pw([120, 96, 20], 200))
check("exact: untouched", pw([120, 96, 120], 336) == [120, 96, 120])

if fails:
    print("%d REGEN CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL REGEN CHECKS PASSED")
