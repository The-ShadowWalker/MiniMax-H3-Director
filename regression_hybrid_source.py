#!/usr/bin/env python3
"""The Hybrid reads generate() off whatever is bound. That is not safe.

The Hybrid is built by rebuilding the stock `MiniMaxH3Pipeline.generate` with
two conditions delegated to methods, which means it has to READ that function's
source. `inspect.getsource` reads whatever object is bound to the name at the
time. Two things can be in the way:

  * a wrapper that uses functools.wraps -- harmless, because wraps sets
    __wrapped__ and inspect follows it back to the real function;
  * a wrapper that is a bare assignment -- NOT harmless, because there is
    nothing to follow, so the source read is the five-line forwarder.

The second one produced a bug report that read as though Wan2GP had changed:
"matches=0 ... (no candidate lines found at all)". Nothing had changed. Another
plugin owned generate(). These checks cover both the recovery (read the class's
own file, which cannot be monkeypatched) and the wording of the refusal, and
they verify the transforms still apply to the INSTALLED Wan2GP.
"""
import ast
import importlib.util
import inspect
import os
import sys
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


spec = importlib.util.spec_from_file_location(
    "h3_hybrid_pipeline", os.path.join(HERE, "models", "minimax_h3_hybrid_pipeline.py"))
hp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hp)


def _wan2gp_pipeline():
    """The installed Wan2GP's H3 pipeline file, if this machine has one."""
    for base in (os.environ.get("WAN2GP_DIR"), "/home/claude/wgpnew2/Wan2GP-main",
                 os.path.join(HERE, "..", "..", ".."), "D:\\Wan2GP"):
        if not base:
            continue
        p = os.path.join(base, "models", "minimax_h3", "pipeline.py")
        if os.path.isfile(p):
            return p
    return None


def _generate_source(path):
    text = open(path, encoding="utf-8").read()
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, ast.ClassDef) and node.name == "MiniMaxH3Pipeline":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "generate":
                    return textwrap.dedent(ast.get_source_segment(text, item))
    return None


# --- against the Wan2GP actually installed here -----------------------------
print("the installed Wan2GP:")
PIPE = _wan2gp_pipeline()
if not PIPE:
    print("  SKIP no Wan2GP checkout found -- set WAN2GP_DIR to check against one")
else:
    src = _generate_source(PIPE)
    check("MiniMaxH3Pipeline.generate was found in the installed pipeline", bool(src))
    if src:
        check("it looks like the real generate(), not a forwarder", hp._has_anchors(src))
        try:
            _, how = hp.transform_generate_source(src)
            ok, detail = sorted(how) == ["audio_reference_gate", "target_audio_gate"], str(how)
        except hp.HybridPipelineSourceError as exc:
            ok, detail = False, str(exc).splitlines()[0]
        check("both Hybrid transforms still apply to it", ok, detail)
        print("       " + PIPE)

# --- a foreign wrapper in front of generate() -------------------------------
print("\nanother plugin owning generate():")
STOCK = os.path.join(HERE, "_regr_stockpipe.py")
open(STOCK, "w", encoding="utf-8").write(
    "class MiniMaxH3Pipeline:\n"
    "    def generate(self, audio_prompt_type=None, waveform=None,\n"
    "                 input_ref_images=None, refinement_mode=False):\n"
    "        if not self.reference_mode and any(flag in (audio_prompt_type or \"\")\n"
    "                                           for flag in \"AK\") and waveform is not None:\n"
    "            self._add_audio_reference(waveform)\n"
    "        return \"generated\"\n")
sys.path.insert(0, HERE)
try:
    import _regr_stockpipe

    Cls = _regr_stockpipe.MiniMaxH3Pipeline
    orig = Cls.generate

    def foreign(self, *a, **k):          # a bare assignment: no __wrapped__
        return orig(self, *a, **k)

    Cls.generate = foreign

    bare = textwrap.dedent(inspect.getsource(inspect.unwrap(Cls.generate)))
    check("a bare wrapper hides the real source from inspect",
          not hp._has_anchors(bare),
          "if this ever passes, the report's failure mode is gone from Python itself")

    back = hp._source_from_disk(Cls, "generate")
    check("the real source is recovered from the class's own file",
          bool(back) and hp._has_anchors(back),
          "recovery is what turns this from a dead end into a warning")
    check("and it is the whole method, not a fragment",
          bool(back) and back.strip().startswith("def generate("))

    # A class whose file holds nothing useful: the refusal must point at the
    # plugin in the way, NOT at Wan2GP. Getting this wrong sent a user
    # hunting through Wan2GP release notes for a change that never happened.
    class Elsewhere:
        pass

    try:
        hp._build_generate(foreign, owner=Elsewhere)
        check("an unrecoverable case refuses", False, "it built something anyway")
    except hp.HybridPipelineSourceError as exc:
        msg = str(exc)
        check("an unrecoverable case refuses", True)
        check("the refusal names the plugin that took generate()",
              "has been replaced by" in msg and "foreign" in msg, msg.splitlines()[0][:110])
        check("it says plainly that this is not a Wan2GP change",
              "NOT a Wan2GP change" in msg,
              "the old wording sent a user looking for a Wan2GP change that never happened")
        check("and it says what to do about it",
              "Disable that plugin" in msg or "load it after" in msg)
finally:
    sys.path.remove(HERE)
    try:
        os.remove(STOCK)
    except OSError:
        pass
    for junk in ("__pycache__/_regr_stockpipe.cpython-%d%d.pyc"
                 % sys.version_info[:2],):
        try:
            os.remove(os.path.join(HERE, junk))
        except OSError:
            pass

print()
if fails:
    print("%d HYBRID SOURCE CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL HYBRID SOURCE CHECKS PASSED")
