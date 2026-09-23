"""MiniMaxH3HybridPipeline — the plugin's own H3 pipeline.

Pass-along v2.1 sections 7, 9, 13, 24 (STEP 2/3), 41 and 43 all name this
class as the first backend deliverable:

    WAN2GP EXISTING WINDOW ENGINE
                 |
        wan_model.generate(...)
                 |
        MiniMaxH3HybridPipeline
                 |
        Hybrid conditioning
                 |
             H3 Hybrid

It preserves the stock ``generate()`` contract exactly, so Wan2GP's window
engine, media handling and progress reporting call it like any other H3
model.  Per section 13/25 it REUSES Ref2VA reference conditioning, FL2VA
target-audio conditioning, H3 continuation and the H3 VAEs.  It is not a
second Wan2GP.


WHY THIS IS NOT A PLAIN SUBCLASS
--------------------------------
The two conditioning decisions the Hybrid needs to change are inline
boolean expressions in the middle of the stock ``generate()`` body, and
they read ``self.reference_mode``:

    697  if not self.reference_mode and (input_ref_images or ...):
             raise ValueError("Image, video, and audio references require
                               the Ref2VA checkpoint")
    714  if self.reference_mode:            # attach image references
    719  if self.reference_mode and "V" ... # attach video references
    731  if self.reference_mode and not refinement_mode and "A" in apt:
             self._add_audio_reference(...) # <-- VOICE CLONING. Not wanted.
    735  if (refinement_mode or not self.reference_mode) and ... :
             target_audio_condition = ...   # <-- LIP SYNC. Wanted.
    741  if self.reference_mode:            # visual/audio ref count check
    1064 if self.reference_mode:

Hybrid needs ``reference_mode`` TRUE at 697/714/719/741/1064 and FALSE at
731/735.  No single boolean value satisfies both, so simply subclassing
and setting the attribute cannot work.  (Setting it False everywhere is
the exact mistake that produced "Image, video, and audio references
require the Ref2VA checkpoint".)

So at class-construction time this module performs ONE mechanical
transformation on the stock source: it replaces those two boolean
expressions -- and nothing else -- with calls to two methods:

    self._hybrid_should_add_audio_reference(refinement_mode, audio_prompt_type)
    self._hybrid_should_condition_target_audio(refinement_mode, audio_prompt_type, waveform)

The Hybrid POLICY then lives in ordinary, readable, overridable Python
methods on this class rather than in string edits.  Changing the policy
later needs no source patching at all.

If the stock source ever changes shape, the transformation refuses to
apply and raises with the relevant source dumped.  It never guesses.
"""

import inspect
import re
import textwrap


class HybridPipelineSourceError(RuntimeError):
    """Raised when the installed Wan2GP H3 pipeline no longer matches."""


# --------------------------------------------------------------------------
# The two conditions we take ownership of.
#
# `literal` is tried first and must match EXACTLY ONCE.  `pattern` is a
# whitespace/line-wrap tolerant fallback anchored on the same operands, and
# must also match exactly once.  Nothing else is ever rewritten.
# --------------------------------------------------------------------------
_TRANSFORMS = (
    {
        "name": "audio_reference_gate",
        "purpose": "song must NOT become a voice-clone reference",
        # Two upstream shapes are known. Older H3 pipelines have no
        # `refinement_mode` parameter at all; newer ones add `and not
        # refinement_mode`. Both are accepted. Anchored on "A" so the
        # adjacent "B"/audio_guide2 line is never touched.
        "pattern": re.compile(
            r'if\s+self\.reference_mode\s+and\s+'
            r'(?:self\.fixed_prompt\s+is\s+None\s+and\s+)?'
            r'(?:not\s+refinement_mode\s+and\s+)?'
            r'"A"\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)\s*:'
        ),
        "replacement": (
            'if self._hybrid_should_add_audio_reference('
            '{refinement}, audio_prompt_type):'
        ),
    },
    {
        "name": "target_audio_gate",
        "purpose": "song MUST drive FL2VA target-audio conditioning (lip sync)",
        # Older: `not self.reference_mode and ...`
        # Newer: `(refinement_mode or not self.reference_mode) and ...`
        "pattern": re.compile(
            r'if\s+(?:\(\s*refinement_mode\s+or\s+not\s+self\.reference_mode'
            r'(?:\s+or\s+self\.fixed_prompt\s+is\s+not\s+None)?\s*\)'
            r'|not\s+self\.reference_mode)\s+and\s+'
            r'any\(\s*flag\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)\s+'
            r'for\s+flag\s+in\s+"AK"\s*\)\s+'
            r'and\s+waveform\s+is\s+not\s+None\s*:'
        ),
        "replacement": (
            'if self._hybrid_should_condition_target_audio('
            '{refinement}, audio_prompt_type, waveform):'
        ),
    },
)


def _refinement_expr(source: str) -> str:
    """What to pass as `refinement_mode`, since older pipelines lack it.

    Referencing a name the installed pipeline does not define would turn a
    clean refusal into a NameError deep inside generate(), so when the
    parameter is absent we pass a literal False -- which is exactly what
    its default is in the versions that do have it.
    """
    return "refinement_mode" if re.search(r"\brefinement_mode\b", source) else "False"


def _source_excerpt(source: str) -> str:
    """The lines a human needs in order to fix a failed transformation."""
    lines = source.splitlines()
    wanted = set()
    for i, line in enumerate(lines):
        if "reference_mode" in line or "audio_prompt_type" in line or "waveform" in line:
            wanted.update(range(max(0, i - 2), min(len(lines), i + 3)))
    out, prev = [], None
    for i in sorted(wanted):
        if prev is not None and i != prev + 1:
            out.append("  ...")
        out.append(f"  {i + 1:4d}: {lines[i]}")
        prev = i
    return "\n".join(out) if out else "  (no candidate lines found at all)"


def transform_generate_source(source: str):
    """Apply both transforms to `source`. Returns (new_source, how).

    Both must apply. A partial application is refused -- opening the target
    audio path without closing the voice-clone path (or the reverse) would
    silently produce the wrong conditioning rather than an error.
    """
    refinement = _refinement_expr(source)
    how = []
    for spec in _TRANSFORMS:
        pattern = spec["pattern"]
        replacement = spec["replacement"].format(refinement=refinement)
        found = pattern.findall(source)
        if len(found) == 1:
            source = pattern.sub(lambda _m: replacement, source, count=1)
            how.append(spec["name"])
            continue
        raise HybridPipelineSourceError(
            "Wan2GP MiniMax H3 pipeline has changed shape: could not take "
            f'ownership of {spec["name"]} ({spec["purpose"]}); '
            f"matches={len(found)} (expected exactly 1).\n"
            "This plugin will NOT guess at an unknown pipeline.\n"
            "Relevant source from the installed MiniMaxH3Pipeline.generate():\n"
            + _source_excerpt(source)
        )
    if refinement == "False":
        how.append("no-refinement_mode")
    return source, how


def _refmods_module():
    """H3 Director's own refmods bridge, or None.

    Imported lazily and by several names because this module is loaded as part
    of the plugin package (whose name is whatever folder the user cloned into)
    and, in the test harness, on its own.
    """
    global _REFMODS
    if _REFMODS is not False:
        return _REFMODS
    _REFMODS = None
    pkg = (__package__ or "").rsplit(".", 1)[0]
    for name in ([pkg + ".refmods"] if pkg else []) + ["refmods"]:
        try:
            import importlib
            _REFMODS = importlib.import_module(name)
            break
        except Exception:
            continue
    return _REFMODS


_REFMODS = False  # False = not looked yet, None = not found


def _has_anchors(source):
    """Does this source look like the real generate() at all?

    The transforms need specific lines. Whether those lines have MOVED is a
    different question from whether we are even looking at the right
    function, and the two need different answers.
    """
    return any(w in source for w in ("reference_mode", "audio_prompt_type", "waveform"))


def _source_from_disk(owner, name):
    """Pull `name`'s source straight out of the class's own .py file.

    `inspect.getsource` reads whatever object is bound right now. Another
    plugin that replaces MiniMaxH3Pipeline.generate with its own function and
    does NOT set `__wrapped__` (functools.wraps sets it; a bare assignment
    does not) makes that object a five-line forwarder, and we would be
    transforming the forwarder instead of the pipeline -- which fails with
    every anchor missing and reads, wrongly, as "Wan2GP has changed".

    The file on disk cannot be monkeypatched, so it is the ground truth.
    Returns None if it cannot be read; the caller then reports what it found.
    """
    try:
        import ast
        path = inspect.getsourcefile(owner)
        if not path:
            return None
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == owner.__name__:
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                            and item.name == name:
                        return textwrap.dedent(ast.get_source_segment(text, item) or "") or None
    except Exception:
        return None
    return None


def _describe(fn):
    """Where a function came from, for an error a person can act on."""
    try:
        return "%s.%s (%s)" % (getattr(fn, "__module__", "?"),
                               getattr(fn, "__qualname__", getattr(fn, "__name__", "?")),
                               inspect.getsourcefile(fn) or "unknown file")
    except Exception:
        return getattr(fn, "__name__", "?")


def _build_generate(base_generate, owner=None):
    """Rebuild `generate` with the two conditions delegated to methods."""
    original = inspect.unwrap(base_generate)
    source = textwrap.dedent(inspect.getsource(original))

    # Something else owns generate() and hid the real one behind it. Go to the
    # file instead of guessing, and say so -- their wrapper will not run on the
    # Hybrid, and that is worth knowing before a render, not after.
    if not _has_anchors(source) and owner is not None:
        from_disk = _source_from_disk(owner, "generate")
        if from_disk and _has_anchors(from_disk):
            print("[H3 Hybrid] generate() is currently %s, which does not carry "
                  "__wrapped__, so the real pipeline source was read from %s "
                  "instead. That plugin's wrapper will NOT run on the Hybrid."
                  % (_describe(original), inspect.getsourcefile(owner)))
            source = from_disk
        else:
            raise HybridPipelineSourceError(
                "MiniMaxH3Pipeline.generate has been replaced by %s, which does "
                "not set __wrapped__, so the real pipeline source cannot be "
                "reached through it -- and it could not be read from the class's "
                "own file either.\nThis is NOT a Wan2GP change: another plugin is "
                "patching the H3 pipeline ahead of H3 Director. Disable that "
                "plugin, or load it after this one, and try again."
                % _describe(original))

    source, how = transform_generate_source(source)

    namespace = dict(vars(inspect.getmodule(original)))
    namespace["__builtins__"] = __builtins__
    exec(compile(source, "<MiniMaxH3HybridPipeline.generate>", "exec"), namespace)
    fn = namespace[original.__name__]

    # ---- saved reference mods (RefMods) ---------------------------------
    # The RefMods plugin injects by wrapping MiniMaxH3Pipeline.generate with
    # functools.wraps. `inspect.unwrap` above walks __wrapped__ straight back
    # past that wrapper to the original function, so on the Hybrid the wrapper
    # never runs: a selection would be accepted, carried all the way to
    # generate(), and then quietly ignored. Doing the injection here puts the
    # Hybrid back on the same footing as the stock model. The work itself is
    # still theirs -- refmods.apply_to_kwargs only calls their _inject_refmods,
    # which is also where the "first window only" rule lives.
    def generate_with_refmods(self, *args, **kwargs):
        refmods = _refmods_module()
        if refmods is None:
            return fn(self, *args, **kwargs)
        refmods.refresh_pipeline_globals(namespace)
        return fn(self, *args, **refmods.apply_to_kwargs(self, kwargs))

    generate_with_refmods.__name__ = original.__name__
    generate_with_refmods._hybrid_transforms = how
    generate_with_refmods._hybrid_rebuilt = fn
    return generate_with_refmods


_CLASS = None


def get_hybrid_pipeline_class():
    """Build (once) and return the MiniMaxH3HybridPipeline class.

    Built lazily so importing this module never drags in Wan2GP or torch.
    """
    global _CLASS
    if _CLASS is not None:
        return _CLASS

    from models.minimax_h3.pipeline import MiniMaxH3Pipeline

    class MiniMaxH3HybridPipeline(MiniMaxH3Pipeline):
        """H3 pipeline for the merged FL2VA-base + Ref2VA-AdaLN checkpoint.

        Reference images are conditioned the Ref2VA way; the supplied song
        is conditioned the FL2VA way, as target audio, which is what drives
        the performance and lip sync.
        """

        hybrid_mode = True

        generate = _build_generate(MiniMaxH3Pipeline.generate,
                                   owner=MiniMaxH3Pipeline)

        # ---- conditioning policy -----------------------------------------
        # These two methods ARE the hybrid. Everything else is stock H3.

        def _hybrid_should_add_audio_reference(self, refinement_mode, audio_prompt_type):
            """Never. The song is the performance, not a voice to imitate.

            Stock Ref2VA passes the waveform to `_add_audio_reference`,
            which appends it to `refs` as a voice-cloning exemplar. That is
            explicitly not wanted (pass-along RULE 6: do not treat Ref2VA
            audio-reference input as equivalent to target-song audio).
            """
            return False

        def _hybrid_should_condition_target_audio(self, refinement_mode,
                                                  audio_prompt_type, waveform):
            """Always, when a song is present. This is the lip-sync path.

            Stock behaviour refuses this whenever reference_mode is set, so
            the Hybrid could never receive target audio. The resulting
            `target_audio_condition` is copied into the leading audio
            latents and then frozen, so every later step reads
            `audio[..., target_audio_condition_latents:]`.

            The "AK" flag set and the `waveform is not None` guard are kept
            exactly as stock -- only the reference_mode veto is dropped.
            """
            return (any(flag in (audio_prompt_type or "") for flag in "AK")
                    and waveform is not None)

        # ---- introspection -----------------------------------------------

        @classmethod
        def hybrid_transforms(cls):
            return list(getattr(cls.generate, "_hybrid_transforms", []))

    _CLASS = MiniMaxH3HybridPipeline
    return _CLASS


def install(pipeline):
    """Promote an already-constructed stock H3 pipeline to the Hybrid class.

    Wan2GP builds the pipeline itself, so we re-class the live instance
    rather than constructing a second one (which would load every weight
    twice). `reference_mode` stays True: Ref2VA reference conditioning is
    half of what the Hybrid is for.
    """
    cls = get_hybrid_pipeline_class()
    pipeline.__class__ = cls
    pipeline.reference_mode = True
    print("[H3 Hybrid] MiniMaxH3HybridPipeline installed ("
          + "; ".join(cls.hybrid_transforms()) + ")")
    print("[H3 Hybrid]   song -> FL2VA target audio (lip sync); "
          "images -> Ref2VA references; song NOT used as a voice-clone reference")
    return pipeline
