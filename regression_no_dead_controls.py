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
GONE = [
    ("isRefMod", "the cosmetic RefMod flag on reference images"),
    ("How to use them", "the image-reference mode dropdown"),
    ("Audio source", "the audio source dropdown"),
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

print()
if fails:
    print("%d DEAD-CONTROL CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("NO DEAD CONTROLS")
