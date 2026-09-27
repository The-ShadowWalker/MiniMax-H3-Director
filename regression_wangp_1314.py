#!/usr/bin/env python3
"""What WanGP 13.14 changed that touches this plugin.

  * the H3 pipeline's reference caps went from 2 videos / 2 audio to 3 / 3.
    The plugin reads that line, but it only SENDS video_guide + video_guide2
    and one voice reference beside the song -- so its limits must stay at
    what it sends, or the UI offers slots whose files are silently dropped;
  * new flags: audio "D" (audio_guide3), "S" (keep the audio as the
    soundtrack), "1" (excerpts); video "V+*-U" (three videos), "V1-U"
    (excerpts). A flag whose file is not attached must be stripped, and a
    qualifier left without its base (S or 1 without A/K) must go too.

Set WAN2GP_DIR to a WanGP checkout to also read its real pipeline file.
"""
import importlib.util
import os
import sys
import types
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + str(detail)))
    if not ok:
        fails.append(label)


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
spec = importlib.util.spec_from_file_location("h3d_plugin_1314", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.trace = lambda *a, **k: None
p = m.H3Director2Plugin.__new__(m.H3Director2Plugin)

# ---------------------------------------------------------------- flags
print("flags whose file is not attached:")


def strip(st):
    return p._strip_unsatisfied(dict(st))


r = strip({"audio_prompt_type": "ABD", "audio_guide": "s.wav", "audio_guide2": "v.wav"})
check("D without audio_guide3 is dropped", r["audio_prompt_type"] == "AB", r["audio_prompt_type"])
r = strip({"audio_prompt_type": "ABD", "audio_guide": "s.wav", "audio_guide2": "v.wav", "audio_guide3": "w.wav"})
check("  ... and kept with it", r["audio_prompt_type"] == "ABD", r["audio_prompt_type"])
r = strip({"audio_prompt_type": "AS"})
check("AS with no audio at all: nothing is left (the model generates the audio)",
      r["audio_prompt_type"] == "", r["audio_prompt_type"])
r = strip({"audio_prompt_type": "AS", "audio_guide": "s.wav"})
check("AS with the song attached is sent as it is", r["audio_prompt_type"] == "AS", r["audio_prompt_type"])
r = strip({"audio_prompt_type": "K1"})
check("K1 without its source leaves no stray '1'", r["audio_prompt_type"] == "", r["audio_prompt_type"])
r = strip({"video_prompt_type": "IV+*-U", "image_refs": ["a.png"]})
check("three-video mode without videos is dropped", r["video_prompt_type"] == "I", r["video_prompt_type"])
r = strip({"video_prompt_type": "IV+*-U", "image_refs": ["a.png"], "video_guide": "1.mp4", "video_guide2": "2.mp4"})
check("three-video mode with only two videos becomes the two-video mode",
      r["video_prompt_type"] == "IV+-U", r["video_prompt_type"])
r = strip({"video_prompt_type": "IV1-U", "image_refs": ["a.png"]})
check("excerpt mode without its video is dropped", r["video_prompt_type"] == "I", r["video_prompt_type"])
r = strip({"video_prompt_type": "IV+-U", "image_refs": ["a.png"], "video_guide": "1.mp4", "video_guide2": "2.mp4",
           "audio_prompt_type": "AB", "audio_guide": "s.wav", "audio_guide2": "v.wav"})
check("the modes it always sent are untouched", r["video_prompt_type"] == "IV+-U" and r["audio_prompt_type"] == "AB",
      (r["video_prompt_type"], r["audio_prompt_type"]))

# ---------------------------------------------------------------- limits
print("\nreference limits:")
REF2VA = {"guide_custom_choices": {"choices": [("Use Reference Video", "V-U"), ("Use Two Reference Videos", "V+-U"),
                                               ("Use Three Reference Videos", "V+*-U")]},
          "audio_prompt_type_sources": {"selection": ["", "A", "AB", "ABD", "K", "K1", "AS", "KS"]}}
p._model_def_for = lambda mt: REF2VA
for caps, label in (({"total": 12, "images": 9, "videos": 3, "audio": 3, "source": "pipeline.py"}, "WanGP 13.14 (3/3)"),
                    ({"total": 12, "images": 9, "videos": 2, "audio": 2, "source": "pipeline.py"}, "WanGP 13.13 (2/2)")):
    p._caps_cache = caps
    lim = p._ref_limits("minimax_h3_ref2va")
    check("%s: the UI is offered what the plugin sends - 2 videos, 2 audio" % label,
          lim["videos"] == 2 and lim["audio"] == 2 and lim["images"] == 9, lim)

WAN = os.environ.get("WAN2GP_DIR") or ""
if WAN and (Path(WAN) / "models" / "minimax_h3" / "pipeline.py").is_file():
    import re
    src = (Path(WAN) / "models" / "minimax_h3" / "pipeline.py").read_text(encoding="utf-8", errors="ignore")
    mm = re.search(r'len\(refs\)\s*>\s*(\d+).*?==\s*"image".*?>\s*(\d+).*?\("video",\s*"video_audio"\).*?>\s*(\d+).*?'
                   r'\("audio",\s*"video_audio"\).*?>\s*(\d+)', src, re.S)
    check("the cap line in %s still parses" % WAN, bool(mm), "the cap regex no longer matches")
    if mm:
        print("       WanGP enforces: %s refs, %s images, %s videos, %s audio" % mm.groups())

print()
if fails:
    print("%d WANGP 13.14 CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL WANGP 13.14 CHECKS PASSED")
