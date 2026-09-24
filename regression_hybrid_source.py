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


def _stub_source():
    """A file-backed class carrying the REAL generate() body where possible.

    The body is what matters -- it holds the lines the transforms match. Only
    the signature is simplified, because its defaults reference pipeline
    constants that cannot be imported without torch. Written to a real file so
    `inspect.getsource` behaves exactly as it does on a user's machine.
    """
    if PIPE:
        real = _generate_source(PIPE)
        if real:
            body = real[real.index("):") + 2:]
            return ("class MiniMaxH3Pipeline:\n    def generate(self, **kwargs):"
                    + "\n".join("    " + l for l in body.split("\n")))
    return ("class MiniMaxH3Pipeline:\n"
            "    def generate(self, audio_prompt_type=None, waveform=None,\n"
            "                 input_ref_images=None, refinement_mode=False):\n"
            "        if not self.reference_mode and any(flag in (audio_prompt_type or \"\")\n"
            "                                           for flag in \"AK\") and waveform is not None:\n"
            "            self._add_audio_reference(waveform)\n"
            "        return \"generated\"\n")


open(STOCK, "w", encoding="utf-8").write(_stub_source())
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

    # The H3 image-mode plugin (wan2gp-minimax-h3-image) is exactly this shape:
    # a bare `def generate`, no functools.wraps, the real function kept on
    # `_h3_image_mode_original`. That attribute is better than re-reading the
    # file -- it is the function object itself, with its own module globals.
    def image_mode(self, *a, **k):
        return orig(self, *a, **k)
    image_mode._h3_image_mode_wrapper = True
    image_mode._h3_image_mode_original = orig
    Cls.generate = image_mode

    check("a wrapper that kept the original is followed to it",
          hp._deep_unwrap(Cls.generate) is orig,
          "inspect.unwrap alone stops on the wrapper")
    rebuilt = hp._build_generate(Cls.generate, owner=Cls)
    check("and the Hybrid builds anyway, with both transforms",
          sorted(getattr(rebuilt, "_hybrid_transforms", [])) ==
          ["audio_reference_gate", "target_audio_gate"],
          str(getattr(rebuilt, "_hybrid_transforms", None)))
    check("the walk back cannot loop forever",
          hp._deep_unwrap(orig) is orig, "a self-referencing attribute would hang the load")

    Cls.generate = foreign
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

# --- a plugin that patches a helper AFTER the Hybrid was built --------------
# The rebuilt generate runs against a copy of the pipeline module's globals.
# Without a refresh, whether another plugin's patch applies to the Hybrid would
# depend on which plugin loaded first -- while working fine on stock H3.
print("\na helper patched after the Hybrid was built:")
import types

mod = types.ModuleType("pipe")


def _as_video(v):
    return "ORIGINAL"


mod._as_video = _as_video
mod.SOME_STATE = 7
ns = {"_as_video": _as_video, "SOME_STATE": 7, "generate": "the rebuilt fn"}


def _patched(v):
    return "PATCHED"


mod._as_video = _patched
mod.SOME_STATE = 99
hp._sync_module_globals(ns, mod, skip="generate")
check("a helper replaced later is picked up", ns["_as_video"] is _patched,
      "the Hybrid would ignore a patch every stock H3 model honours")
check("module state is left alone", ns["SOME_STATE"] == 7,
      "only functions and classes are followed")
check("the rebuilt generate is not overwritten", ns["generate"] == "the rebuilt fn")
check("no names are invented", set(ns) == {"_as_video", "SOME_STATE", "generate"})
try:
    hp._sync_module_globals(ns, None)
    check("a module that cannot be read is survivable", True)
except Exception as exc:
    check("a module that cannot be read is survivable", False, str(exc))

print()
if fails:
    print("%d HYBRID SOURCE CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL HYBRID SOURCE CHECKS PASSED")
