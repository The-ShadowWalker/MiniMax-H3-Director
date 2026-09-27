#!/usr/bin/env python3
"""The Wan2GP version handler (compat.py).

H3 Director must run on older Wan2GP as well as newer. compat.py reads the
running Wan2GP's version and hands out the code that version needs. Checked:

  * the version is read from the running Wan2GP (wgp.WanGP_version), or from
    wgp.py on disk;
  * each known version gets its own profile, a version between two known ones
    gets the one at or below it, and a newer or unreadable one gets the newest,
    with a log line saying so;
  * the Hybrid's pipeline rewrite uses the profile for the version FIRST, and
    falls back to the others when a build's source does not match its number
    (a patched Wan2GP, or one that did not bump its version);
  * against every Wan2GP checkout found here, the version is detected and the
    rewrite applies with the matching profile.

Point WGP_DIRS at checkouts to test (colon-separated), else the ones known in
this workspace are used.
"""
import importlib.util
import os
import sys
import types
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + str(detail)))
    if not ok:
        fails.append(label)


import compat  # noqa: E402

print("reading the version:")
check("'13.14' reads as (13, 14)", compat.parse_version("13.14") == (13, 14))
check("'v13.2' reads as (13, 2)", compat.parse_version("v13.2") == (13, 2))
check("nonsense reads as nothing", compat.parse_version("beta") is None)
fake = types.ModuleType("wgp")
fake.WanGP_version = "13.13"
sys.modules["wgp"] = fake
v, how = compat.detect_version()
check("from the running Wan2GP", v == (13, 13) and how == "wgp.WanGP_version", (v, how))
del sys.modules["wgp"]

print("\nchoosing a profile:")
names = [p["name"] for p in compat.PROFILES]
check("13.13 gets the 13.13 profile", compat.profile_for((13, 13))["name"] == "13.13 and earlier")
check("12.0 gets it too", compat.profile_for((12, 0))["name"] == "13.13 and earlier")
check("13.14 gets the 13.14 profile", compat.profile_for((13, 14))["name"] == "13.14")
check("a newer version gets the newest profile", compat.profile_for((99, 0))["name"] == names[-1])
check("  ... and the log line says it is newer than known", "newer than any" in compat.describe((99, 0)))
check("an unreadable version gets the newest profile, and says so",
      compat.profile_for(None)["name"] == names[-1] and "could not be read" in compat.describe(None))
c = [p["name"] for p in compat.candidates((13, 13))]
check("the version's own profile is tried first, then the rest", c[0] == "13.13 and earlier" and set(c) == set(names), c)
check("a later profile inherits what it does not change",
      all(k in compat.profile_for((13, 14)) for k in compat.PROFILES[0]))

# ---------------------------------------------------------------- real checkouts
print("\nagainst real Wan2GP checkouts:")
dirs = [d for d in (os.environ.get("WGP_DIRS") or "").split(":") if d] or \
    ["/home/claude/wgpsrc/Wan2GP-main", "/home/claude/wgpnew2/Wan2GP-main", "/home/claude/wgp6/Wan2GP-main"]
dirs = [d for d in dirs if (Path(d) / "wgp.py").is_file()]
if not dirs:
    print("  SKIP no Wan2GP checkout found")
spec = importlib.util.spec_from_file_location("h3_hybrid_pipeline_c", os.path.join(HERE, "models", "minimax_h3_hybrid_pipeline.py"))
hp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hp)
import ast  # noqa: E402
import textwrap  # noqa: E402
for d in dirs:
    compat.reset()
    v, how = compat.detect_version(d)
    vs = "%d.%d" % v if v else "?"
    check("%s: version read from wgp.py (%s)" % (d, vs), v is not None, how)
    os.environ["WAN2GP_DIR"] = d
    compat.reset()
    src = (Path(d) / "models" / "minimax_h3" / "pipeline.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    gen = next(item for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == "MiniMaxH3Pipeline"
               for item in node.body if isinstance(item, ast.FunctionDef) and item.name == "generate")
    gsrc = textwrap.dedent(ast.get_source_segment(src, gen))
    try:
        _, how_ = hp.transform_generate_source(gsrc)
        used = next((h[len("profile "):] for h in how_ if h.startswith("profile ")), "?")
        want = compat.profile_for(v)["name"]
        check("  the Hybrid rewrite applies, with the %s profile" % want, used == want, used)
    except hp.HybridPipelineSourceError as exc:
        check("  the Hybrid rewrite applies", False, str(exc).splitlines()[0])

# a build whose number says 13.14 but whose source is still the 13.13 shape
if len(dirs) >= 1:
    old = next((d for d in dirs if compat.detect_version(d)[0] == (13, 13)), None)
    if old:
        compat.reset()
        fake = types.ModuleType("wgp"); fake.WanGP_version = "13.14"
        sys.modules["wgp"] = fake
        src = (Path(old) / "models" / "minimax_h3" / "pipeline.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        gen = next(item for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == "MiniMaxH3Pipeline"
                   for item in node.body if isinstance(item, ast.FunctionDef) and item.name == "generate")
        _, how_ = hp.transform_generate_source(textwrap.dedent(ast.get_source_segment(src, gen)))
        check("a build that says 13.14 but has the old source still works (falls back to the 13.13 profile)",
              "profile 13.13 and earlier" in how_, how_)
        del sys.modules["wgp"]
        compat.reset()

print()
if fails:
    print("%d COMPAT CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL COMPAT CHECKS PASSED")
