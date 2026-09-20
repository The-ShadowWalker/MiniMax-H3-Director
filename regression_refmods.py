#!/usr/bin/env python3
"""Saved reference mods (RefMods) really reach the model.

RefMods are made and stored by a separate Wan2GP plugin. Everything that can
go wrong between picking one in H3 Director and the model seeing it is silent:

  * the selection is dropped by Wan2GP because the Hybrid model did not
    declare the custom_settings id it travels in -- no error, just a render
    that ignored the mods;
  * the RefMods plugin's own injection never runs, because it patches
    MiniMaxH3Pipeline.generate with functools.wraps and H3 Director's Hybrid
    rebuilds generate from source via inspect.unwrap, which walks straight
    past the wrapper;
  * a video mod reaches a rebuilt generate() whose captured module globals
    still hold the UNPATCHED _as_video / _resize_video, and dies on
    "'_RefModVideoSentinel' object has no attribute 'ndim'".

Each of those produces either nothing or a crash deep inside a render, so
they are checked here with a stand-in for the plugin instead.
"""
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import refmods  # noqa: E402

fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


# ---------------------------------------------------------------- stand-in
class _Sentinel:
    def __init__(self, name):
        self.name = name


def make_stub(name="stub_refmods"):
    """A module pair shaped like the real plugin's patches + storage."""
    patches = types.ModuleType(name + ".patches")
    patches.SETTING_GENERATE = "h3_refmod_state"
    patches.seen = []

    def _inject_refmods(pipeline_self, kwargs, state_json):
        state = json.loads(state_json)
        patches.seen.append(state)
        # The real one only injects into the first window; mirror that so the
        # bridge is exercised the same way.
        if int(kwargs.get("window_no", 1)) > 1:
            return kwargs
        out = dict(kwargs)
        out["input_ref_images"] = list(out.get("input_ref_images") or []) + [
            _Sentinel(r["mod"]) for r in state["rows"]]
        return out

    patches._inject_refmods = _inject_refmods

    storage = types.ModuleType(name + ".storage")
    storage.list_refmods_info = lambda folder=None, recursive=False: [
        {"name": "characters/tanya", "kind": "image", "mode": "encode",
         "tokens": 4096, "description": "face", "size_mb": 1.2},
        {"name": "wolf_run", "kind": "video", "mode": "training",
         "tokens": 1024, "description": "", "size_mb": 0.4},
    ]
    sys.modules[name + ".patches"] = patches
    sys.modules[name + ".storage"] = storage
    return patches, storage


# ------------------------------------------------------- without the plugin
refmods.reset()
ok, why = refmods.available()
check("with no RefMods plugin installed, the feature reports itself off", not ok)
check("and says so in words a person can act on", "not installed" in why, why)
check("the library is empty rather than an error", refmods.list_mods() == [])

kwargs = {"custom_settings": {"h3_refmod_state": json.dumps({"rows": [{"mod": "x"}]})}}
check("a selection submitted anyway is ignored, not raised",
      refmods.apply_to_kwargs(None, kwargs) is kwargs)
check("and the Hybrid declares no custom settings for it",
      refmods.custom_setting_defs() == [])

# ---------------------------------------------------------- with the plugin
print()
stub_patches, _stub_storage = make_stub()
refmods.reset()
ok, why = refmods.available()
check("an installed RefMods plugin is found by what it contains", ok, why)

mods = refmods.list_mods()
check("its saved mods are listed", [m["name"] for m in mods] == ["characters/tanya", "wolf_run"],
      str(mods))
check("with the kind carried through", [m["kind"] for m in mods] == ["image", "video"])

defs = refmods.custom_setting_defs()
check("the Hybrid now declares h3_refmod_state",
      [d["id"] for d in defs] == ["h3_refmod_state"], str(defs))

# ------------------------------------------------------------- state format
print()
state = refmods.build_state(
    [{"name": "characters/tanya", "strength": 0.8},
     {"name": "wolf_run", "strength": 1.25, "copies": 2}], retention=0.9)
parsed = json.loads(state)
check("the selection keeps the order it was picked in",
      [r["mod"] for r in parsed["rows"]] == ["characters/tanya", "wolf_run"])
check("each mod carries its own strength",
      [r["strength"] for r in parsed["rows"]] == [0.8, 1.25])
check("the overall strength travels separately", parsed["retention"] == 0.9)
check("a mod at strength 0 is dropped, not sent",
      json.loads(refmods.build_state([{"name": "a", "strength": 0},
                                      {"name": "b", "strength": 1}]))["rows"]
      == [{"mod": "b", "strength": 1.0, "copies": 1}])
check("an empty selection produces no payload at all",
      refmods.build_state([]) is None and refmods.build_state([{"name": "", "strength": 1}]) is None)

# ---------------------------------------------------------------- injection
print()
stub_patches.seen.clear()
kwargs = {"custom_settings": {"h3_refmod_state": state}, "window_no": 1,
          "input_ref_images": ["a live reference"]}
out = refmods.apply_to_kwargs(object(), kwargs)
names = [x.name for x in out["input_ref_images"] if isinstance(x, _Sentinel)]
check("the mods are handed to the plugin's own injection",
      names == ["characters/tanya", "wolf_run"], str(names))
check("live reference images are kept alongside them",
      out["input_ref_images"][0] == "a live reference")
check("the plugin saw exactly one selection", len(stub_patches.seen) == 1)

later = refmods.apply_to_kwargs(object(), dict(kwargs, window_no=3))
check("later sliding windows are left alone (no reference at every boundary)",
      [x for x in later["input_ref_images"] if isinstance(x, _Sentinel)] == [])

# A broken mod file must cost the references, not the render.
def _boom(*a, **k):
    raise RuntimeError("corrupt mod file")


stub_patches._inject_refmods = _boom
survived = refmods.apply_to_kwargs(object(), kwargs)
check("a mod that fails to load does not take the generation down with it",
      survived is kwargs)

# ------------------------------------------- the globals a video mod needs
print()
pipeline_mod = types.ModuleType("models.minimax_h3.pipeline")
pipeline_mod._as_video = lambda v: "ORIGINAL"
pipeline_mod._resize_video = lambda v, h, w: "ORIGINAL"
sys.modules["models"] = types.ModuleType("models")
sys.modules["models.minimax_h3"] = types.ModuleType("models.minimax_h3")
sys.modules["models.minimax_h3.pipeline"] = pipeline_mod

namespace = {"_as_video": pipeline_mod._as_video, "_resize_video": pipeline_mod._resize_video}
pipeline_mod._as_video = lambda v: "PATCHED"        # the plugin patches these
pipeline_mod._resize_video = lambda v, h, w: "PATCHED"
refmods.refresh_pipeline_globals(namespace)
check("a rebuilt generate() picks up the plugin's patched _as_video",
      namespace["_as_video"](None) == "PATCHED")
check("and its patched _resize_video",
      namespace["_resize_video"](None, 1, 1) == "PATCHED")

# ------------------------------------ the Hybrid's rebuilt generate() wiring
print()
import functools  # noqa: E402
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "h3_hybrid_pipeline_under_test",
    os.path.join(HERE, "models", "minimax_h3_hybrid_pipeline.py"))
hybrid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hybrid)
hybrid._REFMODS = refmods          # it looks this up lazily; hand it ours


# A stand-in for Wan2GP's generate(), carrying the two lines the Hybrid takes
# ownership of, so _build_generate has something real to transform.
def stock_generate(self, *args, **kwargs):
    audio_prompt_type = kwargs.get("audio_prompt_type")
    waveform = kwargs.get("waveform")
    refinement_mode = False
    if self.reference_mode and "A" in (audio_prompt_type or ""):
        pass
    if (refinement_mode or not self.reference_mode) and any(
            flag in (audio_prompt_type or "") for flag in "AK") and waveform is not None:
        pass
    return kwargs


# Exactly what the RefMods plugin does to it.
@functools.wraps(stock_generate)
def refmod_wrapped(self, *args, **kwargs):
    raise AssertionError("the RefMods wrapper should never run on the Hybrid")


check("inspect.unwrap really does walk past the RefMods wrapper",
      __import__("inspect").unwrap(refmod_wrapped) is stock_generate,
      "if this ever stops being true the Hybrid would inject twice")

stub_patches._inject_refmods = _inject_saved = None  # restore a working one
stub_patches._inject_refmods = make_stub()[0]._inject_refmods
refmods.reset()

built = hybrid._build_generate(refmod_wrapped)


class _FakePipeline:
    reference_mode = True

    # The transform rewrites both gates into these two methods, so a stand-in
    # pipeline has to answer them -- which also proves the rewrite happened.
    def _hybrid_should_add_audio_reference(self, refinement_mode, audio_prompt_type):
        return False

    def _hybrid_should_condition_target_audio(self, refinement_mode, audio_prompt_type, waveform):
        return waveform is not None


out = built(_FakePipeline(), custom_settings={"h3_refmod_state": state},
            window_no=1, input_ref_images=[])
names = [x.name for x in out.get("input_ref_images", []) if isinstance(x, _Sentinel)]
check("the Hybrid's rebuilt generate injects the mods itself",
      names == ["characters/tanya", "wolf_run"], str(names))
check("and still reports which transforms it applied",
      set(built._hybrid_transforms) >= {"audio_reference_gate", "target_audio_gate"},
      str(getattr(built, "_hybrid_transforms", None)))

plain = built(_FakePipeline(), input_ref_images=[])
check("a generation with no mods picked is untouched",
      plain.get("input_ref_images") == [])

print()
if fails:
    print("%d REFMOD CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL %d REFMOD CHECKS PASSED" % (24 + 4))
