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
      "for d in (MEDIA_DIR, DERIVED_DIR, RENDERS_DIR, HISTORY_DIR):" in src)
check("and so does opening another project",
      src.count("for d in (MEDIA_DIR, DERIVED_DIR, RENDERS_DIR, HISTORY_DIR):") >= 2,
      "otherwise the previous run's working files survive the switch")
check("the rendered clips and their record go with the project",
      src.count("RENDER_JSON)") >= 2 and "(PROJECT_JSON, PROJECT_BAK, RENDER_JSON)" in src,
      "a cleared or switched project must not offer to continue the old render")
check("the zip carries the rendered clips, stored not deflated",
      '"renders/" + f.name, compress_type=zipfile.ZIP_STORED' in src)
check("and opening a zip brings them back",
      'n.startswith("renders/")' in src and 'n == "render.json"' in src)
check("derived working files still never reach the zip",
      "DERIVED_DIR.glob" not in src[src.index("def _save_project_zip"):src.index("def _clear_all")])
check("New Project goes through Clear All",
      "return self._clear_all({\"confirmed\": True})" in src)
check("the derived folder is served to the browser",
      "str(MEDIA_DIR), str(DERIVED_DIR)" in src,
      "a tail or mix that cannot be fetched would break its preview")

# The badge in the top bar exists to catch a cached UI bundle: it only works
# if it names the same version the terminal prints.
tb = open(os.path.join(HERE, "webui", "src", "components", "TopBar.tsx"), encoding="utf-8").read()
ver = re.search(r'PLUGIN_VERSION = "([^"]+)"', src).group(1)
badge = re.search(r'H3D2_BUILD = "([^"]+)"', tb).group(1)
check("the UI's version badge matches the plugin version (%s)" % ver, badge == ver,
      "badge says %s -- a stale badge hides a stale cached UI" % badge)

print()
if fails:
    print("%d WORKSPACE CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL WORKSPACE CHECKS PASSED")
