#!/usr/bin/env python3
"""Two things that keep a project from being lost.

1. Batched bridge requests. Requests that leave the UI together travel as one
   batch; each must come back with its own answer and id, and one failing
   request must not take the others with it.

2. Project history. One .bak is one save deep, and a project that failed to
   load once had the demo saved over it on two focus changes in a row -- both
   copies gone. The first save after the plugin starts now keeps a dated copy
   of what was on disk, then one every few minutes, capped.
"""
import importlib.util
import json
import os
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


g = types.ModuleType("gradio")
sys.modules["gradio"] = g


class WAN2GPPlugin:
    def __init__(self, *a, **k):
        pass


shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp})
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("h3d_plugin_bridge", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

TMP = Path(tempfile.mkdtemp(prefix="h3d_bridge_"))
WS = TMP / "workspace"
m.WORKSPACE, m.MEDIA_DIR, m.DERIVED_DIR = WS, WS / "media", WS / "derived"
m.RENDERS_DIR, m.RENDER_JSON = WS / "renders", WS / "render.json"
m.PROJECT_JSON, m.PROJECT_BAK, m.HISTORY_DIR = WS / "project.json", WS / "project.json.bak", WS / "history"
m.trace = lambda *a, **k: None
for d in (m.MEDIA_DIR, m.DERIVED_DIR):
    d.mkdir(parents=True, exist_ok=True)
p = m.H3Director2Plugin.__new__(m.H3Director2Plugin)
p._grid = dict(m._GRID_FALLBACK)

print("a batch of requests:")
items = [
    {"cmd": "save_project_json", "data": {"payload": {"project_name": "Real", "timeline": {"segments": []}}}, "id": "a1"},
    {"cmd": "load_project_json", "data": {}, "id": "a2"},
    {"cmd": "no_such_thing", "data": {}, "id": "a3"},
    {"cmd": "log", "data": {"message": "fire and forget"}},
]
out = json.loads(p._on_bridge(json.dumps({"cmd": "batch", "id": "b1", "data": {"items": items}})))
answers = out.get("data", {}).get("items", [])
check("comes back as one answer, under the batch's id", out.get("cmd") == "batch:ok" and out.get("id") == "b1", out)
check("holding one answer per request, in order", [a.get("id") for a in answers] == ["a1", "a2", "a3", None],
      [a.get("id") for a in answers])
check("each is its own command's answer",
      answers[0]["cmd"] == "save_project_json:ok" and answers[1]["cmd"] == "load_project_json:ok")
check("the load sees the save made just before it in the same batch",
      answers[1]["data"]["payload"]["project_name"] == "Real")
check("an unknown command fails alone", answers[2]["data"].get("ok") is False and answers[3]["cmd"] == "log:ok",
      answers[2:])

print("\nproject history:")
p._snapshotted = False
m.PROJECT_JSON.write_text(json.dumps({"project_name": "My Real Project"}))
p._save_project_json({"project_name": "Grinch_1", "timeline": {}})       # the demo, after a failed load
p._save_project_json({"project_name": "Grinch_1", "timeline": {}, "x": 1})
hist = sorted(m.HISTORY_DIR.glob("project-*.json"))
check("the first save of a session keeps what was on disk",
      len(hist) == 1 and json.loads(hist[0].read_text())["project_name"] == "My Real Project",
      [h.name for h in hist])
check("so the project survives two bad saves in a row (the .bak does not)",
      json.loads(m.PROJECT_BAK.read_text())["project_name"] == "Grinch_1")
for i in range(5):
    p._save_project_json({"project_name": "edit %d" % i})
check("saves in quick succession do not pile up copies", len(list(m.HISTORY_DIR.glob("project-*.json"))) == 1)
for i in range(40):
    p._snapshot_at = 0                      # as if the interval had passed
    (m.HISTORY_DIR / ("project-20200101-%06d.json" % i)).write_text("{}") if i < 35 else None
    p._save_project_json({"project_name": "edit later %d" % i})
check("the history is capped", len(list(m.HISTORY_DIR.glob("project-*.json"))) == m.HISTORY_KEEP,
      len(list(m.HISTORY_DIR.glob("project-*.json"))))
check("  ... dropping the oldest", not (m.HISTORY_DIR / "project-20200101-000000.json").exists())
p._clear_all({"confirmed": True})
check("Clear All takes the history with the project", not list(m.HISTORY_DIR.glob("*")))

print("\nclearing the results track:")
m.RENDERS_DIR.mkdir(parents=True, exist_ok=True)
(m.RENDERS_DIR / "group_w001-004.mkv").write_bytes(b"x" * 10)
m.RENDER_JSON.write_text("{}", encoding="utf-8")
for n in ("preview_group_w001-004_10.mp4", "poster_group_w001-004_10.jpg", "tail_a_group_w001-004_18.mp4",
          "m_keepme.png"):
    (m.DERIVED_DIR / n).write_bytes(b"x")
p._job = object()
r = json.loads(p._on_bridge(json.dumps({"cmd": "render_discard", "id": "d1", "data": {}})))
check("refused while a render is running, and nothing is deleted",
      r["cmd"].endswith(":err") and "running" in r.get("error", "")
      and (m.RENDERS_DIR / "group_w001-004.mkv").exists() and m.RENDER_JSON.exists(), r)
r = json.loads(p._on_bridge(json.dumps({"cmd": "clear_all", "id": "d0", "data": {"confirmed": True}})))
check("so is Clear All / New project", r["cmd"].endswith(":err") and (m.RENDERS_DIR / "group_w001-004.mkv").exists(), r)
p._job = None
r = json.loads(p._on_bridge(json.dumps({"cmd": "render_discard", "id": "d2", "data": {}})))
check("otherwise the clips and the record go", r["data"].get("ok") and not any(m.RENDERS_DIR.iterdir())
      and not m.RENDER_JSON.exists(), r)
check("  ... with the previews, posters and carried tails made from them",
      sorted(f.name for f in m.DERIVED_DIR.iterdir()) == ["m_keepme.png"], sorted(f.name for f in m.DERIVED_DIR.iterdir()))

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print()
if fails:
    print("%d BRIDGE/HISTORY CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL BRIDGE/HISTORY CHECKS PASSED")
