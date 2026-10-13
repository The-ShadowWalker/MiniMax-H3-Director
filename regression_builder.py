#!/usr/bin/env python3
"""The Hybrid builder finds Wan2GP's model folders on ANY install.

It used to offer one hard-coded folder (D:\\Wan2GP\\ckpts) and its buttons did
nothing. Now every folder comes from the running Wan2GP. Checked here with a
made-up install that looks nothing like the developer's:

  * Wan2GP's root is the folder its wgp.py was loaded from, even when the
    current folder is somewhere else;
  * its model folders are its configured checkpoint paths, relative ones
    ("ckpts") taken from that root, absolute ones (another drive) as they are,
    the first one first;
  * H3 models are found in those folders and their subfolders, and where
    Wan2GP itself would find them -- but the whole Wan2GP install is not
    walked through;
  * the FL2VA and Ref2VA BF16 models are picked by default;
  * a build goes to Wan2GP's first model folder unless another is chosen, the
    Ref2VA AdaLN blocks asked for really are the Ref2VA ones, and the result is
    registered in that Wan2GP's finetunes folder by its full path.

Needs safetensors (pip install safetensors numpy); torch is not needed here.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + str(detail)))
    if not ok:
        fails.append(label)


try:
    import numpy as np
    import safetensors
    from safetensors.numpy import save_file as np_save
except ImportError:
    print("SKIP: safetensors / numpy not installed")
    sys.exit(0)

# ---------------------------------------------------------------- a made-up install
TMP = Path(tempfile.mkdtemp(prefix="h3d_builder_"))
WGP = TMP / "Some Folder" / "WanGP"              # not D:\Wan2GP, with a space in it
OTHER = TMP / "OtherDrive" / "AI models"         # a second "drive"
(WGP / "ckpts" / "minimax").mkdir(parents=True)
(WGP / "plugins" / "x").mkdir(parents=True)
(WGP / "finetunes").mkdir()
OTHER.mkdir(parents=True)
(WGP / "wgp.py").write_text("WanGP_version = '13.14'\n")

BLOCKS = 4


def model(path, value):
    t = {"blocks.%d.adaln_proj.linear.weight" % i: np.full((2, 2), value + i, dtype=np.float32)
         for i in range(BLOCKS)}
    t["blocks.0.attn.weight"] = np.full((2, 2), value, dtype=np.float32)
    t["final_layer.adaln_proj.weight"] = np.full((2,), value, dtype=np.float32)
    np_save(t, str(path))


model(WGP / "ckpts" / "minimax" / "MiniMax-H3-FL2VA_bf16.safetensors", 100)
model(OTHER / "MiniMax-H3-Ref2VA_bf16.safetensors", 200)
model(OTHER / "MiniMax-H3-FL2VA_pruned_int8.safetensors", 300)
model(WGP / "plugins" / "x" / "MiniMax-H3-deep-copy.safetensors", 400)  # inside the install: not a model folder
(WGP / "ckpts" / "unrelated.safetensors").write_bytes(b"x")

# the running Wan2GP and its file locator, configured like a real one
wgp = types.ModuleType("wgp"); wgp.__file__ = str(WGP / "wgp.py")
fl = types.ModuleType("shared.utils.files_locator")
fl._checkpoints_paths = ["ckpts", str(OTHER), "."]
fl.default_checkpoints_paths = ["ckpts", "."]


def locate_file(name, error_if_none=True):
    for root in fl._checkpoints_paths:
        r = Path(root) if Path(root).is_absolute() else WGP / root
        if (r / name).is_file():
            return str(r / name)
    return None


fl.locate_file = locate_file

# ---------------------------------------------------------------- load the plugin
g = types.ModuleType("gradio")
g.update = lambda *a, **k: {}
sys.modules["gradio"] = g


class WAN2GPPlugin:
    def __init__(self, *a, **k):
        pass


shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
su.files_locator = fl
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp,
                    "shared.utils.files_locator": fl, "wgp": wgp})
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("h3d_plugin_builder", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.trace = lambda *a, **k: None
p = m.H3Director2Plugin.__new__(m.H3Director2Plugin)
p._job = None
p._jobstate = {}
refreshed = []
p.refresh_model_defs = lambda: refreshed.append(1)

hb, loc = p._hb()
# torch is not needed to test the merge: the same calls, on numpy
hb.safe_open = lambda path, framework="pt", device="cpu": safetensors.safe_open(path, framework="np")
hb.save_file = np_save

os.chdir(str(TMP))          # Wan2GP's folder is NOT the current folder
print("where Wan2GP is:")
check("Wan2GP's root is where its wgp.py is, not the current folder", loc.wan2gp_root() == WGP.resolve(),
      loc.wan2gp_root())
roots = [Path(r) for r in loc.checkpoint_roots_for_ui()]
check("its model folders are the ones it is configured with, relative ones from its own root",
      roots == [(WGP / "ckpts").resolve(), OTHER.resolve(), WGP.resolve()], roots)

print("\nthe builder's scan:")
sc = p._builder_scan()
names = sorted(c["name"] for c in sc["checkpoints"])
check("finds the H3 models in every model folder, subfolders included",
      names == ["MiniMax-H3-FL2VA_bf16.safetensors", "MiniMax-H3-FL2VA_pruned_int8.safetensors",
                "MiniMax-H3-Ref2VA_bf16.safetensors"], names)
check("  ... and does not walk through the whole Wan2GP install", "MiniMax-H3-deep-copy.safetensors" not in names)
check("the FL2VA BF16 model is picked, not the pruned one",
      Path(sc["fl2va"]).name == "MiniMax-H3-FL2VA_bf16.safetensors", sc["fl2va"])
check("the Ref2VA BF16 model is picked, on the other drive", Path(sc["ref2va"]) == (OTHER / "MiniMax-H3-Ref2VA_bf16.safetensors").resolve(),
      sc["ref2va"])
check("the default place to save is Wan2GP's first model folder",
      Path(sc["default_root"]) == (WGP / "ckpts").resolve(), sc["default_root"])
check("nothing in it names the developer's drive", "D:" not in json.dumps(sc))

print("\nbuilding:")
st = p._builder_build_start({"fl2va": sc["fl2va"], "ref2va": sc["ref2va"], "start_block": 1, "end_block": 2,
                             "include_final": False, "save_to": ""})
check("a build starts and answers at once", st.get("started"), st)
for _ in range(400):
    j = p._builder_job
    if j["state"] != "running":
        break
    time.sleep(0.05)
check("it finishes", j["state"] == "done", j)
res = j.get("result") or {}
out = Path(res.get("checkpoint", ""))
check("saved in Wan2GP's first model folder when no other is chosen", out.parent == (WGP / "ckpts").resolve(), out)
if out.is_file():
    with safetensors.safe_open(str(out), framework="np") as f:
        v = {i: float(f.get_tensor("blocks.%d.adaln_proj.linear.weight" % i)[0, 0]) for i in range(BLOCKS)}
        other = float(f.get_tensor("blocks.0.attn.weight")[0, 0])
    check("blocks 1-2 come from Ref2VA, the others from FL2VA",
          v == {0: 100.0, 1: 201.0, 2: 202.0, 3: 103.0} and other == 100.0, v)
reg = Path(res.get("definition", ""))
check("registered in THIS Wan2GP's finetunes folder", reg.parent == (WGP / "finetunes").resolve() and reg.is_file(), reg)
if reg.is_file():
    d = json.loads(reg.read_text())["model"]
    check("  ... pointing at the checkpoint by its full path, as a prebuilt Hybrid",
          d["URLs"] == [str(out)] and d["architecture"] == "minimax_h3_hybrid" and d["hybrid_prebuilt"] is True, d)
check("  ... and Wan2GP's model list is refreshed", refreshed == [1], refreshed)

st = p._builder_build_start({"fl2va": sc["fl2va"], "ref2va": sc["ref2va"], "start_block": 0, "end_block": 3,
                             "include_final": True, "save_to": str(OTHER)})
for _ in range(400):
    if p._builder_job["state"] != "running":
        break
    time.sleep(0.05)
out2 = Path((p._builder_job.get("result") or {}).get("checkpoint", ""))
check("a folder chosen by hand is used", out2.parent == OTHER.resolve() and out2.is_file(), p._builder_job)

for bad, why in (({"fl2va": str(TMP / "nope.safetensors"), "ref2va": sc["ref2va"]}, "FL2VA"),
                 ({"fl2va": sc["fl2va"], "ref2va": sc["ref2va"], "start_block": 9, "end_block": 3}, "blocks")):
    try:
        p._builder_build_start(bad)
        check("refuses a bad request (%s)" % why, False)
    except ValueError as e:
        check("refuses a bad request (%s), saying why" % why, why in str(e), str(e))

print()
if fails:
    print("%d BUILDER CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL BUILDER CHECKS PASSED")
