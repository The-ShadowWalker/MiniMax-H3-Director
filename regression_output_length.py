#!/usr/bin/env python3
"""Guard: a normal generation must produce at least the timeline length.

This exists because of the chopped-soundtrack bug. The plugin used to send a
`video_length` that had (windows - 1) * overlap subtracted from it, on the
belief that WanGP re-adds the overlap at every join. It does not: WanGP's
build_default_window_plan() treats video_length as the FINAL OUTPUT length and
shares it out across the windows. So a 3-window 24fps job came out 36 frames --
1.5s -- short, the tail window rounded down by up to 8 more, and a song that
ran past the end of the picture got cut off.

The check: for a wide spread of timeline lengths, the video_length the plugin
chooses must produce at least that many frames when fed to WanGP's OWN
scheduler. It is compared against the real Wan2GP module when one is
available, which also pins the plugin's internal mirror to it.

    WGP=/path/to/Wan2GP python3 regression_output_length.py
"""

from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WGP = os.environ.get("WGP") or "/home/claude/wgpsrc/Wan2GP-main"

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not ok:
        print("  FAIL " + label + (("  -- " + detail) if detail else ""))
        FAILURES.append(label + (("  -- " + detail) if detail else ""))


def ok_summary(label: str) -> None:
    print("  OK   " + label)


# --------------------------------------------------------------------------
# load the plugin's length math without importing all of plugin.py
# --------------------------------------------------------------------------
import ast

plugin_src = open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read()
tree = ast.parse(plugin_src)
WANTED = {
    "_wgp_window_plan", "_mirror_norm_up", "_mirror_norm_nearest",
    "_mirror_floor_overlap", "_mirror_window_plan", "_real_plan_windows",
    "real_output_frames", "real_window_count", "solve_video_length",
    "_scheduler_outputs", "plan_duration_frames", "scheduler_window_count",
    "compensate_request", "assembled_length",
}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in WANTED]
missing = WANTED - {n.name for n in nodes}
if missing:
    print("plugin.py is missing: %s" % ", ".join(sorted(missing)))
    raise SystemExit(2)

ns: dict = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "plugin.py", "exec"), ns)
solve_video_length = ns["solve_video_length"]
real_output_frames = ns["real_output_frames"]
mirror_plan = ns["_mirror_window_plan"]

# --------------------------------------------------------------------------
# the real WanGP scheduler, if we have a tree to read it from
# --------------------------------------------------------------------------
real_plan = None
fs_path = os.path.join(WGP, "shared", "utils", "frame_scheduler.py")
if os.path.exists(fs_path):
    spec = importlib.util.spec_from_file_location("wgp_fs", fs_path)
    fs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fs)          # standalone: skips the torch-heavy package __init__
    real_plan = fs.build_default_window_plan
    print("real WanGP scheduler: %s" % fs_path)
else:
    print("real WanGP scheduler: NOT FOUND (set WGP=...) -- mirror-only run")

# H3's grid, as the model definition reports it
GRID = {
    "WINDOW_MIN": 107, "WINDOW_STEP": 17, "WINDOW_OFFSET": 5,
    "WINDOW_DEFAULT": 362, "OVERLAP_OFFSET": 1, "OVERLAP_MAX": 120,
    "OVERLAP_DEFAULT": 18, "FPS": 24,
}
FPS, WIN, OVL = 24, 362, 18


def real_output(video_length: int, win: int = WIN, ovl: int = OVL) -> int:
    windows = real_plan(
        total_frames=video_length, window_size=win, default_overlap=ovl,
        discard_last_frames=0, minimum=GRID["WINDOW_MIN"], step=GRID["WINDOW_STEP"],
        frame_offset=GRID["WINDOW_OFFSET"], overlap_offset=GRID["OVERLAP_OFFSET"],
        max_overlap=GRID["OVERLAP_MAX"], first_window_overlap=0,
        first_window_available_overlap=None, initial_shared_frames=0,
        preserve_exact_output_frames=True, output_frame_policy=None)
    return sum(w["output_frames"] for w in windows)


# --------------------------------------------------------------------------
# 1. the plugin's mirror must agree with the real scheduler, frame for frame
# --------------------------------------------------------------------------
if real_plan is not None:
    print("\nplugin mirror vs the real WanGP scheduler:")
    mismatches = []
    for vl in range(GRID["WINDOW_MIN"], 1500):
        mine = sum(w["output_frames"] for w in mirror_plan(
            total_frames=vl, window_size=WIN, default_overlap=OVL, discard_last_frames=0,
            minimum=GRID["WINDOW_MIN"], step=GRID["WINDOW_STEP"],
            frame_offset=GRID["WINDOW_OFFSET"], overlap_offset=GRID["OVERLAP_OFFSET"],
            max_overlap=GRID["OVERLAP_MAX"], first_window_overlap=0,
            first_window_available_overlap=None, initial_shared_frames=0))
        theirs = real_output(vl)
        if mine != theirs:
            mismatches.append((vl, mine, theirs))
    check("mirror matches the real scheduler for every length 107..1500",
          not mismatches,
          "%d mismatch(es), first: video_length=%d mirror=%d real=%d"
          % (len(mismatches), *mismatches[0]) if mismatches else "")
    if not mismatches:
        ok_summary("mirror matches the real scheduler for every length 107..1500")

# --------------------------------------------------------------------------
# 2. the timeline must never come out short
# --------------------------------------------------------------------------
print("\ntimeline coverage (the chopped-soundtrack bug):")
measure = real_output if real_plan is not None else (
    lambda vl: real_output_frames(vl, WIN, OVL, GRID))

short, worst_over = [], 0
for target in range(120, 1600):
    vl = solve_video_length(target, WIN, OVL, GRID)
    out = measure(vl)
    if out < target:
        short.append((target, vl, out))
    worst_over = max(worst_over, out - target)

check("no timeline length 120..1600 comes out short", not short,
      "%d short, first: target=%d -> video_length=%d -> output=%d (%d frames missing)"
      % (len(short), short[0][0], short[0][1], short[0][2], short[0][0] - short[0][2]) if short else "")
if not short:
    ok_summary("no timeline length 120..1600 comes out short")
    print("       (worst overshoot across that range: +%d frame(s) = %.2fs)"
          % (worst_over, worst_over / FPS))

# --------------------------------------------------------------------------
# 3. the exact case Dave reported: ~44.6s song, 3+ windows
# --------------------------------------------------------------------------
print("\nDave's case -- 44.6s song at 24fps:")
song_seconds = 44.6
target = round(song_seconds * FPS)
vl = solve_video_length(target, WIN, OVL, GRID)
out = measure(vl)
check("a %.1fs timeline produces at least %.1fs of video" % (song_seconds, song_seconds),
      out >= target,
      "target=%d video_length=%d output=%d (%.2fs)" % (target, vl, out, out / FPS))
if out >= target:
    ok_summary("target=%d -> video_length=%d -> output=%d frames (%.2fs), song is %.2fs"
               % (target, vl, out, out / FPS, song_seconds))

# the old behaviour, kept here so the regression is visible if anyone reverts
old_req = ns["compensate_request"](target, WIN, OVL)
old_out = measure(old_req)
print("       old compensate_request would have sent %d -> %d frames (%.2fs): %.2fs of song lost"
      % (old_req, old_out, old_out / FPS, song_seconds - old_out / FPS))
check("the new solver beats the old compensation on this case", out > old_out,
      "new=%d old=%d" % (out, old_out))

# --------------------------------------------------------------------------
# 4. a few overlap/window combinations, not just the defaults
# --------------------------------------------------------------------------
print("\nother window/overlap combinations:")
combos = [(362, 18), (362, 35), (362, 1), (243, 18), (481, 18), (124, 18)]
for win, ovl in combos:
    bad = []
    for target in range(150, 1300, 7):
        vl = solve_video_length(target, win, ovl, GRID)
        out = (real_output(vl, win, ovl) if real_plan is not None
               else real_output_frames(vl, win, ovl, GRID))
        if out < target:
            bad.append((target, vl, out))
    check("window=%d overlap=%d never comes out short" % (win, ovl), not bad,
          "%d short, first target=%d -> output=%d" % (len(bad), bad[0][0], bad[0][2]) if bad else "")
    if not bad:
        ok_summary("window=%d overlap=%d never comes out short" % (win, ovl))

# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# 5. the /duration scheduler path, against WanGP's REAL build_frame_scheduler
# --------------------------------------------------------------------------
# This is the path a tagged prompt actually takes, and the one that gives a
# 45s timeline three 15s windows instead of four with a runt tail.
if real_plan is not None and hasattr(fs, "build_frame_scheduler"):
    print("\n/duration scheduler vs the real WanGP build_frame_scheduler:")

    def real_sched(durations, target, win, ovl):
        prompts = ["[/duration=%.4fs]\nx" % (d / FPS) for d in durations]
        sc, err = fs.build_frame_scheduler(
            prompts, total_frames=target, fps=float(FPS), window_size=win,
            default_overlap=ovl, minimum=GRID["WINDOW_MIN"], step=GRID["WINDOW_STEP"],
            frame_offset=GRID["WINDOW_OFFSET"], overlap_offset=GRID["OVERLAP_OFFSET"],
            max_overlap=GRID["OVERLAP_MAX"],
            supported_model_commands=["duration", "overlap", "new_shot", "loras_mult"],
            allow_new_shot=True, first_window_overlap_frames=0, initial_shared_frames=0,
            discard_last_frames=0, preserve_exact_output_frames=True, output_frame_policy=None)
        if err:
            return None, err, 0
        return sum(w["output_frames"] for w in sc["windows"]), None, len(sc["windows"])

    for win, ovl in [(362, 18), (481, 18), (243, 18), (362, 35)]:
        short, mism, errs, overs = [], [], [], []
        for target in range(150, 1500, 11):
            durations, outputs = ns["plan_duration_frames"](target, win, ovl, GRID)
            got, err, nwin = real_sched(durations, target, win, ovl)
            if err:
                errs.append((target, err)); continue
            if got < target:
                short.append((target, got))
            else:
                overs.append(got - target)
            if nwin != len(durations):
                mism.append((target, nwin, len(durations)))
            if sum(outputs) != got:
                mism.append((target, sum(outputs), got))
        check("window=%d overlap=%d: real scheduler never comes out short" % (win, ovl),
              not short and not errs,
              "%d short (first target=%d -> %d), %d error(s)"
              % (len(short), short[0][0] if short else 0, short[0][1] if short else 0, len(errs)))
        check("window=%d overlap=%d: our plan matches the real scheduler" % (win, ovl),
              not mism,
              "%d mismatch(es), first %s" % (len(mism), mism[0]) if mism else "")
        if not short and not errs and not mism:
            ok_summary("window=%d overlap=%d: matches, worst overshoot +%d frame(s)"
                       % (win, ovl, max(overs) if overs else 0))

    # Dave's case, end to end through the real scheduler
    t = round(44.6 * FPS)
    durations, _ = ns["plan_duration_frames"](t, 362, 18, GRID)
    got, err, nwin = real_sched(durations, t, 362, 18)
    check("a 44.6s song: 3 windows and the whole song",
          err is None and nwin == 3 and got >= t,
          "windows=%s total=%s err=%s" % (nwin, got, err))
    if err is None:
        ok_summary("44.6s song -> %d windows declaring %s -> %d frames (%.2fs)"
                   % (nwin, durations, got, got / FPS))

# --------------------------------------------------------------------------
# 6. a prompt that already carries its own [/duration=] tag
# --------------------------------------------------------------------------
# A project prompt written elsewhere (or imported from the older plugin) often
# begins with its own [/duration=15s]. The relay adds one per window too, so a
# block ends up with two. WanGP still makes ONE window per block -- but the
# plugin used to count tags, so five 15s blocks were re-fitted as ten 7.6s
# windows and every window came out half length.
print("\nblocks carrying an extra /duration tag:")

import re as _re
_cls = None
for _n in ast.parse(plugin_src).body:
    if isinstance(_n, ast.ClassDef) and any(
            isinstance(f, ast.FunctionDef) and f.name == "_fix_duration_tags" for f in _n.body):
        _cls = _n
        break

if _cls is None:
    check("plugin defines _fix_duration_tags", False, "method not found")
else:
    _methods = [f for f in _cls.body if isinstance(f, ast.FunctionDef)
                and f.name in ("_fix_duration_tags", "_refit_durations")]
    for _m in _methods:
        _m.decorator_list = []
    _ns = dict(ns)
    _ns["re"] = _re
    _ns["trace"] = lambda *a, **k: None
    exec(compile(ast.Module(body=_methods, type_ignores=[]), "plugin.py", "exec"), _ns)

    class _Host:
        _grid = GRID
        _DURATION_TAG = _re.compile(r"\[\s*/\s*duration\s*=\s*([0-9]*\.?[0-9]+)\s*s\s*\]", _re.I)
        _fix_duration_tags = _ns["_fix_duration_tags"]
        _refit_durations = _ns["_refit_durations"]

    _host = _Host()

    def _windows_from(prompt, target, win=WIN, ovl=OVL):
        out = _host._fix_duration_tags(prompt, target, win, ovl, FPS)
        declared = [round(float(x) * FPS) for x in _Host._DURATION_TAG.findall(out)]
        outs = ns["_scheduler_outputs"](declared, win, ovl, GRID)
        return declared, outs, out

    # five 15s blocks, each ALSO carrying the user's own tag
    _target = 1800
    _clean, _dirty = [], []
    for _i in range(5):
        _clean.append("[/duration=15.08s]\nshot %d" % (_i + 1))
        _dirty.append("[/duration=15.08s]\n[/duration=15s] shot %d" % (_i + 1))
    _cd, _co, _ = _windows_from("\n\n".join(_clean), _target)
    _dd, _do, _dout = _windows_from("\n\n".join(_dirty), _target)

    check("an extra tag per block does not change the window count",
          len(_dd) == len(_cd) == 5,
          "clean=%d windows, with extra tags=%d windows" % (len(_cd), len(_dd)))
    check("an extra tag per block does not halve the windows",
          _do == _co,
          "clean outputs %s, with extra tags %s" % (_co, _do))
    check("each block ends up with exactly one duration tag",
          all(len(_Host._DURATION_TAG.findall(b)) == 1
              for b in _re.split(r"\n\s*\n", _dout) if b.strip()),
          "a block still carries more than one tag")
    check("the timeline is still covered",
          sum(_do) >= _target,
          "%d frames for a %d-frame timeline" % (sum(_do), _target))
    if _do == _co and sum(_do) >= _target and len(_dd) == 5:
        ok_summary("5 blocks x 2 tags -> %d windows of %s frames = %d (%.2fs), timeline %d"
                   % (len(_do), _do[0], sum(_do), sum(_do) / FPS, _target))

print()
if FAILURES:
    print("%d of %d OUTPUT LENGTH CHECK(S) FAILED" % (len(FAILURES), CHECKS))
    for f in FAILURES:
        print("  - " + f)
    print("\nGenerations will be shorter than the timeline. Do not ship.")
    sys.exit(1)

print("ALL %d OUTPUT LENGTH CHECKS PASSED" % CHECKS)
