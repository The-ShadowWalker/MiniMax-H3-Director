#!/usr/bin/env python3
"""A control that does not reach the generator must not be on screen.

The UI once showed a "RefMod" badge on a reference image, an image-reference
mode dropdown ("How to use them"), an "Audio source" dropdown and a
"Control-video audio" dropdown. None of the four reached Wan2GP: the relay
works out video_prompt_type and audio_prompt_type from what is actually on the
timeline, so the dropdowns moved a value that nothing ever read. A control that
looks like it does something and does not is worse than no control -- it tells
you a feature is handled when it is not.

This guard fails if a value the UI puts in the payload is never mentioned in
plugin.py, and if any of those four controls comes back.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION = os.path.join(HERE, "webui", "src", "lib", "session.ts")
STAGE = os.path.join(HERE, "webui", "src", "components", "Stage.tsx")
PLUGIN = os.path.join(HERE, "plugin.py")
BUNDLE = os.path.join(HERE, "assets", "index.html")

# Carried for the record, not acted on. These are not controls: nothing on
# screen offers to change them, so they promise nothing.
INFORMATIONAL = {
    "window_prompts",      # the per-window text, for reading back; the combined
                           # prompt is what is actually sent
    "auto_renumber_refs",  # always true -- renumbering is unconditional
    "reference_mode",      # derived from the pipeline, which picks model_type
}

fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


session = open(SESSION, encoding="utf-8").read()
plugin = open(PLUGIN, encoding="utf-8").read()
stage = open(STAGE, encoding="utf-8").read()

# Keys the UI puts into the payload handed to Python.
keys = sorted(set(re.findall(r"^\s{4}([a-z][a-z0-9_]{3,})\s*:", session, re.M)))
dead = [k for k in keys
        if k not in INFORMATIONAL and not re.search(r"\b%s\b" % re.escape(k), plugin)]
check("every value the UI sends is read by plugin.py", not dead,
      "plugin.py never mentions: " + ", ".join(dead))
print("       %d payload keys checked, %d carried for the record"
      % (len(keys), len(INFORMATIONAL)))

# The controls that were removed, by the text a user would have seen.
#
# "RefMod" itself is NOT banned any more: saved reference mods became a real,
# wired feature, so the word now appears on a panel that does something. What
# stays banned is the cosmetic flag the old badge hung off -- `isRefMod`, a
# field set on one demo reference and read by nothing. The rule below is the
# honest one: the word may appear only while the wiring behind it exists.
# "Audio source" came back, and that was the right call: removing it was too
# blunt. The relay never read it, but the UI did -- the Audio rail icon's lit
# state and caption were both driven by it, so deleting the control froze the
# stored mode at "A" and the icon stopped lighting up for anyone generating
# audio from the prompt. It is now Auto by default, overridable, and its
# choices come from the model. So like RefMod, the rule is not "must be gone"
# but "must be backed by wiring" -- checked below.
GONE = [
    ("isRefMod", "the cosmetic RefMod flag on reference images"),
    ("How to use them", "the image-reference mode dropdown"),
    ("Control-video audio", "the control-video audio dropdown"),
]
for needle, what in GONE:
    check("%s is gone from the UI source" % what, needle not in stage,
          "Stage.tsx still contains %r" % needle)

if os.path.exists(BUNDLE):
    built = open(BUNDLE, encoding="utf-8", errors="replace").read()
    for needle, what in GONE:
        check("%s is gone from the built bundle" % what, needle not in built,
              "assets/index.html still contains %r" % needle)
else:
    print("       (bundle not built -- source checked only)")

# Saved reference mods are the opposite case: a label that must stay backed by
# real wiring. If the panel is on screen, the command it reads from and the
# value it sends both have to exist, or it is the RefMod badge all over again.
if "RefMod" in stage:
    check("the RefMods panel has a command to list the library",
          '"list_refmods"' in plugin, "plugin.py has no list_refmods command")
    check("and the selection is sent to the generator",
          'plan.get("refmods")' in plugin, "plugin.py never reads the selection")
    check("and the relay puts it where the RefMods plugin reads it",
          "SETTING_GENERATE" in plugin and "custom_settings" in plugin,
          "nothing writes custom_settings[h3_refmod_state]")



# --------------------------------------------------------------------------
# Model option groups: the choice must land in the slot THIS model uses.
#
# Wan2GP splits the `config` string by position across
# (system_configs, system_configs2, system_configs3, configs) and silently
# blanks any id not present in that slot's group. The slot meaning is not
# fixed: in the stock H3 handler, system_configs2 is the DiT Denoising
# Priority on one branch and the Video VAE on another. Sending by position
# would therefore drop the choice on one of them, with no error.
print()
import types as _types  # noqa: E402


class _Relay:
    """Just the two methods under test, with a model definition supplied."""
    CONFIG_GROUP_KEYS = ("system_configs", "system_configs2", "system_configs3", "configs")

    def __init__(self, mdef):
        self._mdef = mdef

    def _model_def_for(self, _model_type):
        return self._mdef


import importlib.util as _ilu  # noqa: E402
_spec = _ilu.spec_from_loader("h3d_plugin_src", loader=None)
_src = open(PLUGIN, encoding="utf-8").read()
for _name in ("_config_groups", "_config_selection"):
    _m = re.search(r"\n    def %s\(self.*?(?=\n    def )" % _name, _src, re.S)
    assert _m, _name
    _body = "\n".join(l[4:] if l.startswith("    ") else l for l in _m.group(0).split("\n"))
    exec(compile("class _Add:\n" + "\n".join("    " + l for l in _body.split("\n")),
                 "<relay>", "exec"), globals())
    setattr(_Relay, _name, getattr(globals()["_Add"], _name))

trace = lambda *a, **k: None  # noqa: E731  (the relay logs; the test does not)

REF2VA = {  # the shape the Hybrid inherits: VAE in slot 2, priority in slot 3
    "system_configs": {"_name": "Text Encoder", "int8": {"name": "INT8"}},
    "system_configs2": {"_name": "Video VAE", "_default_label": "Auto",
                        "bf16": {"name": "BF16"}, "int8_convrot": {"name": "INT8 ConvRot"}},
    "system_configs3": {"_name": "DiT Denoising Priority", "lower_ram": {"name": "Lower RAM"}},
}
OTHER = {  # the other branch: priority in slot 2, no VAE group at all
    "system_configs": {"_name": "Text Encoder", "int8": {"name": "INT8"}},
    "system_configs2": {"_name": "DiT Denoising Priority", "lower_ram": {"name": "Lower RAM"}},
}

r = _Relay(REF2VA)
names = [g["name"] for g in r._config_groups("x")]
check("the groups are read from the model, in its own order",
      names == ["Text Encoder", "Video VAE", "DiT Denoising Priority"], str(names))

sel = r._config_selection({"model_configs": {"system_configs": "int8",
                                             "system_configs2": "int8_convrot",
                                             "system_configs3": "lower_ram"}})
check("each choice lands in its own slot", sel == "int8,int8_convrot,lower_ram", sel)

sel = r._config_selection({"model_configs": {"system_configs2": "int8_convrot"}})
check("an unset group leaves its slot empty", sel == ",int8_convrot", repr(sel))

# The same VAE choice against the branch that has no VAE group must be dropped,
# not written into slot 2 where it would mean the DiT priority.
r2 = _Relay(OTHER)
sel = r2._config_selection({"model_configs": {"system_configs2": "int8_convrot"}})
check("a choice this model does not offer is dropped, not misfiled",
      sel == "", repr(sel))
sel = r2._config_selection({"model_configs": {"system_configs2": "lower_ram"}})
check("and the option it DOES offer in that slot still goes through",
      sel == ",lower_ram", repr(sel))
check("no selection at all sends nothing",
      r._config_selection({}) == "" and r._config_selection({"model_configs": {}}) == "")

# The audio source picker: on screen, so it has to reach the generator.
if "Audio source" in stage:
    print()
    check("the three options are the plugin's own labels",
          "Soundtrack drives generation" in stage
          and "Generate audio from prompt" in stage
          and "Soundtrack + reference voice" in stage,
          "the control was rebuilt with Wan2GP's internal labels instead")
    check("a hand-picked mode is sent",
          "audio_prompt_type_set" in session,
          "session.ts never sends the override")
    check("and the relay honours it over what it derived",
          'plan.get("audio_prompt_type")' in plugin and "audio_prompt_type_set" in plugin,
          "plugin.py derives the mode and ignores the choice")
    check("Auto sends nothing, so the relay keeps deriving",
          "chosenAudioMode" in session,
          "the override would be sent even on Auto")

print()
if fails:
    print("%d DEAD-CONTROL CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("NO DEAD CONTROLS")
