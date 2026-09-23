#!/usr/bin/env python3
"""Working files must not become project content.

Continuation tails, per-group audio slices, bridge edge frames and mixed
guidance audio are all DERIVED -- regenerable, sometimes large, and owned by
the run rather than the project. They were being written into media/, and
media/ is what the project zip contains: so every save carried them, every
open restored them, and they piled up run after run.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read()
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


check("there is a separate folder for derived working files",
      'DERIVED_DIR = WORKSPACE / "derived"' in src)

# Nothing derived may be written into media/.
DERIVED = [
    ("tail_", "continuation tails"),
    ("grpaud_", "per-group audio slices"),
    ("bridge_last_", "bridge edge frames"),
    ("bridge_first_", "bridge edge frames"),
    ("mix_", "mixed guidance audio"),
]
for needle, what in DERIVED:
    bad = re.search(r'MEDIA_DIR\s*/\s*\(\s*"%s' % re.escape(needle), src)
    check("%s are not written into media/" % what, not bad,
          "they would be saved into the project zip and restored from it")
    good = re.search(r'DERIVED_DIR\s*/\s*\(\s*"%s' % re.escape(needle), src)
    check("  ... they go to the derived folder instead", bool(good))

# The zip is built from media/ -- that is exactly why the split matters.
check("the project zip is still built from media/ alone",
      'zf.write(f, "media/" + f.name)' in src,
      "if this changes, check what else it now sweeps up")

check("Clear All takes the derived folder too",
      "for d in (MEDIA_DIR, DERIVED_DIR):" in src)
check("and so does opening another project",
      src.count("for d in (MEDIA_DIR, DERIVED_DIR):") >= 2,
      "otherwise the previous run's working files survive the switch")
check("New Project goes through Clear All",
      "return self._clear_all({\"confirmed\": True})" in src)
check("the derived folder is served to the browser",
      "str(MEDIA_DIR), str(DERIVED_DIR)" in src,
      "a tail or mix that cannot be fetched would break its preview")

print()
if fails:
    print("%d WORKSPACE CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL WORKSPACE CHECKS PASSED")
