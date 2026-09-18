#!/usr/bin/env python3
"""Guard: the React UI and plugin.py must compute the SAME window plan.

The status bar said 3 windows and then corrected itself to 4 mid-job. Two
copies of the window arithmetic had drifted: webui/src/lib/h3.ts still had the
old compensate-the-request model while plugin.py had been fixed. Whichever one
is wrong, a user watching the status sees one number and WanGP runs another.

This runs the TypeScript through node and the Python directly, over the same
lengths and window/overlap combinations, and fails on any disagreement in
either the output frame count or the window count. When a real Wan2GP tree is
available it checks both against WanGP's own scheduler as well, so "they agree
with each other but are both wrong" also fails.

Needs node and the webui dependencies (npm install in webui/). Skips cleanly
with exit 0 if node or esbuild is unavailable, so it never blocks a
Python-only environment -- it prints SKIPPED so that is never mistaken for a
pass.

    WGP=/path/to/Wan2GP python3 regression_ui_python_agree.py
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEBUI = os.path.join(HERE, "webui")
WGP = os.environ.get("WGP") or "/home/claude/wgpsrc/Wan2GP-main"

COMBOS = [(362, 18), (481, 18), (243, 18), (362, 35), (124, 18)]
LENGTHS = list(range(107, 1500, 3))

if shutil.which("node") is None:
    print("SKIPPED: node not available")
    raise SystemExit(0)
if not os.path.isdir(os.path.join(WEBUI, "node_modules")):
    print("SKIPPED: webui/node_modules missing (run: cd webui && npm install)")
    raise SystemExit(0)

# --------------------------------------------------------------------------
# the TypeScript side
# --------------------------------------------------------------------------
tmp = tempfile.mkdtemp(prefix="h3d2_guard_")
bundle = os.path.join(tmp, "h3.mjs")
try:
    subprocess.run(
        ["npx", "esbuild", "src/lib/h3.ts", "--bundle", "--format=esm",
         "--platform=node", "--outfile=" + bundle, "--log-level=error"],
        cwd=WEBUI, check=True, capture_output=True, text=True, timeout=180)
except Exception as exc:
    print("SKIPPED: could not bundle h3.ts (%s)" % exc)
    raise SystemExit(0)

driver = os.path.join(tmp, "run.mjs")
with open(driver, "w", encoding="utf-8") as fh:
    fh.write(
        "import * as m from %s;\n"
        "const combos = %s;\n"
        "const lengths = %s;\n"
        "const out = [];\n"
        "for (const [win, ovl] of combos)\n"
        "  for (const vl of lengths)\n"
        "    { const d = m.planDurations(vl, win, ovl);\n"
        "      out.push([win, ovl, vl, m.realOutputFrames(vl, win, ovl),"
        " m.realWindowPlan(vl, win, ovl).length, d.windows, d.total,"
        " d.durations.join('|')]); }\n"
        "process.stdout.write(JSON.stringify(out));\n"
        % (json.dumps(bundle), json.dumps(COMBOS), json.dumps(LENGTHS)))

proc = subprocess.run(["node", driver], capture_output=True, text=True, timeout=180)
if proc.returncode != 0:
    print("FAILED: the UI window math would not run under node")
    print(proc.stderr.strip()[:2000])
    raise SystemExit(1)
ts_rows = json.loads(proc.stdout)

# --------------------------------------------------------------------------
# the Python side, lifted out of plugin.py
# --------------------------------------------------------------------------
tree = ast.parse(open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read())
WANTED = {"_wgp_window_plan", "_mirror_norm_up", "_mirror_norm_nearest",
          "_mirror_floor_overlap", "_mirror_window_plan", "_real_plan_windows",
          "real_output_frames", "real_window_count", "solve_video_length",
          "_scheduler_outputs", "plan_duration_frames", "scheduler_window_count"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in WANTED]
py: dict = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "plugin.py", "exec"), py)

GRID = {"FRAMES_MIN": 107, "WINDOW_MIN": 124, "WINDOW_STEP": 17, "WINDOW_OFFSET": 5,
        "OVERLAP_OFFSET": 1, "OVERLAP_MAX": 120}

# --------------------------------------------------------------------------
# WanGP's own scheduler, when we have a tree
# --------------------------------------------------------------------------
real = None
fs_path = os.path.join(WGP, "shared", "utils", "frame_scheduler.py")
if os.path.exists(fs_path):
    spec = importlib.util.spec_from_file_location("wgp_fs", fs_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    real = mod.build_default_window_plan


def real_plan(vl, win, ovl):
    return real(total_frames=vl, window_size=win, default_overlap=ovl,
                discard_last_frames=0, minimum=GRID["FRAMES_MIN"], step=GRID["WINDOW_STEP"],
                frame_offset=GRID["WINDOW_OFFSET"], overlap_offset=GRID["OVERLAP_OFFSET"],
                max_overlap=GRID["OVERLAP_MAX"], first_window_overlap=0,
                first_window_available_overlap=None, initial_shared_frames=0,
                preserve_exact_output_frames=True, output_frame_policy=None)


print("UI vs plugin.py%s" % ("  (and both vs the real WanGP scheduler)" if real else ""))
print("  %d cases: %d lengths x %d window/overlap combinations"
      % (len(ts_rows), len(LENGTHS), len(COMBOS)))

ui_vs_py, vs_real, sched_bad, sched_short = [], [], [], []
for win, ovl, vl, ts_out, ts_n, ts_sw, ts_stot, ts_durs in ts_rows:
    # --- the /duration scheduler path (what a tagged prompt uses) ---
    py_durs, py_outs = py["plan_duration_frames"](vl, win, ovl, GRID)
    if [str(d) for d in py_durs] != ts_durs.split("|") or sum(py_outs) != ts_stot:
        sched_bad.append((win, ovl, vl, ts_durs, ts_stot, "|".join(map(str, py_durs)), sum(py_outs)))
    if sum(py_outs) < vl:
        sched_short.append((win, ovl, vl, sum(py_outs)))
    py_out = py["real_output_frames"](vl, win, ovl, GRID)
    py_n = py["real_window_count"](vl, win, ovl, GRID)
    if (ts_out, ts_n) != (py_out, py_n):
        ui_vs_py.append((win, ovl, vl, ts_out, ts_n, py_out, py_n))
    if real is not None:
        ws = real_plan(vl, win, ovl)
        r_out, r_n = sum(w["output_frames"] for w in ws), len(ws)
        if (ts_out, ts_n) != (r_out, r_n):
            vs_real.append((win, ovl, vl, ts_out, ts_n, r_out, r_n))

failed = False
if ui_vs_py:
    failed = True
    w, o, vl, a, an, b, bn = ui_vs_py[0]
    print("  FAIL %d disagreement(s) between the UI and plugin.py" % len(ui_vs_py))
    print("       first: window=%d overlap=%d video_length=%d -> UI %d frames/%d windows,"
          " Python %d frames/%d windows" % (w, o, vl, a, an, b, bn))
else:
    print("  OK   UI and plugin.py agree on every case (default plan)")

if sched_bad:
    failed = True
    w, o, vl, a, at, b, bt = sched_bad[0]
    print("  FAIL %d /duration-scheduler disagreement(s) between UI and plugin.py" % len(sched_bad))
    print("       first: window=%d overlap=%d timeline=%d -> UI [%s]=%d, Python [%s]=%d"
          % (w, o, vl, a, at, b, bt))
else:
    print("  OK   UI and plugin.py agree on every case (/duration scheduler)")

if sched_short:
    failed = True
    w, o, vl, got = sched_short[0]
    print("  FAIL %d timeline(s) come out SHORT on the scheduler path" % len(sched_short))
    print("       first: window=%d overlap=%d timeline=%d -> only %d frames" % (w, o, vl, got))
else:
    print("  OK   no timeline comes out short on the /duration scheduler path")

if real is not None:
    if vs_real:
        failed = True
        w, o, vl, a, an, b, bn = vs_real[0]
        print("  FAIL %d disagreement(s) with the real WanGP scheduler" % len(vs_real))
        print("       first: window=%d overlap=%d video_length=%d -> ours %d frames/%d windows,"
              " WanGP %d frames/%d windows" % (w, o, vl, a, an, b, bn))
    else:
        print("  OK   both match WanGP's own scheduler exactly")
else:
    print("  --   real WanGP scheduler not found (set WGP=...) -- agreement checked only")

shutil.rmtree(tmp, ignore_errors=True)
print()
if failed:
    print("WINDOW MATH IS INCONSISTENT. The status bar will disagree with what runs.")
    sys.exit(1)
print("UI / PYTHON WINDOW MATH AGREE")
