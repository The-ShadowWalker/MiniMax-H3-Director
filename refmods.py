"""Talk to the installed MiniMax H3 RefMods plugin.

A RefMod is a reference image or video that has already been VAE-encoded and
saved to a small .safetensors file, so it can be reused in later generations
without re-encoding the original -- and without keeping the original around.
They are made, stored and injected by a separate Wan2GP plugin,
`MiniMaxH3Mod-for-WanGP`. Some people prefer working that way to attaching the
reference pictures themselves, so H3 Director offers saved mods alongside its
own reference slots.

This module owns the whole relationship with that plugin:

  * finding it (it is a sibling plugin, and its folder name is whatever the
    user cloned it as, so it is found by what it contains, never by name),
  * listing the mods the user has saved,
  * handing its own injection routine a selection at generation time.

NOTHING here reimplements the RefMod maths. The latent packing, strength
curves, token budgets and sentinel objects all stay in that plugin, which owns
them; if it is not installed, H3 Director simply does not offer the feature.

WHY H3 DIRECTOR HAS TO INJECT AT ALL
------------------------------------
The RefMods plugin injects by wrapping `MiniMaxH3Pipeline.generate` with
`functools.wraps`. H3 Director's hybrid pipeline does not call that wrapper:
`_build_generate` rebuilds `generate` from source, and `inspect.unwrap` walks
`__wrapped__` straight back past the wrapper to the original function. So on
the Hybrid model the wrapper never runs, and a RefMod selection would be
silently ignored -- no error, just a normal render. `apply_to_kwargs` below is
called from the Hybrid pipeline in the wrapper's place, and delegates to the
plugin's own `_inject_refmods`, so the behaviour is theirs, not a copy.
"""

import importlib
import json
import os
import sys

# The custom_settings key the RefMods plugin reads its selection from. Kept as
# a literal so this module can identify the plugin before importing it.
SETTING_GENERATE = "h3_refmod_state"

_cache = {"tried": False, "patches": None, "storage": None, "why": ""}


def _log(msg):
    try:
        from . import plugin as _p  # type: ignore
        _p.trace("refmods: " + str(msg))
    except Exception:
        print("[H3-D] refmods: %s" % msg)


def _looks_like_patches(mod):
    return getattr(mod, "SETTING_GENERATE", None) == SETTING_GENERATE


def _find_loaded():
    """The plugin is already imported in almost every real session: Wan2GP
    imports every enabled plugin at startup. Finding it in sys.modules avoids
    guessing at its folder name entirely."""
    for name, mod in list(sys.modules.items()):
        if mod is None or not name.endswith(".patches"):
            continue
        if _looks_like_patches(mod):
            pkg = name[: -len(".patches")]
            storage = sys.modules.get(pkg + ".storage")
            if storage is None:
                try:
                    storage = importlib.import_module(pkg + ".storage")
                except Exception as exc:
                    _log("found %s but its storage module would not import: %r" % (pkg, exc))
                    return None, None
            return mod, storage
    return None, None


def _find_on_disk():
    """Fallback: the plugin is installed but not imported (disabled, or a
    Wan2GP build that imports plugins lazily). Wan2GP puts `plugins/` on
    sys.path, so a folder there is importable by its own name."""
    roots = [os.path.join(os.getcwd(), "plugins"), "plugins"]
    seen = set()
    for root in roots:
        root = os.path.abspath(root)
        if root in seen or not os.path.isdir(root):
            continue
        seen.add(root)
        for entry in sorted(os.listdir(root)):
            patches_py = os.path.join(root, entry, "patches.py")
            if not os.path.isfile(patches_py):
                continue
            try:
                with open(patches_py, "r", encoding="utf-8", errors="replace") as fh:
                    if SETTING_GENERATE not in fh.read():
                        continue
            except Exception:
                continue
            if root not in sys.path:
                sys.path.insert(0, root)
            try:
                patches = importlib.import_module(entry + ".patches")
                storage = importlib.import_module(entry + ".storage")
            except Exception as exc:
                # Found, but broken. Saying "not installed" here would send
                # someone off to install what they already have.
                _cache["why"] = ("the MiniMax H3 RefMods plugin is installed but would not "
                                 "load (%s: %s) -- check Wan2GP's console" % (type(exc).__name__, exc))
                _log("found %s but it would not import: %r" % (entry, exc))
                continue
            if _looks_like_patches(patches):
                return patches, storage
    return None, None


def _resolve():
    if _cache["tried"]:
        return _cache["patches"], _cache["storage"]
    _cache["tried"] = True
    try:
        patches, storage = _find_loaded()
        if patches is None:
            patches, storage = _find_on_disk()
    except Exception as exc:
        patches, storage = None, None
        _cache["why"] = "looking for the RefMods plugin failed: %r" % (exc,)
        _log(_cache["why"])
    if patches is None:
        if not _cache["why"]:
            _cache["why"] = ("the MiniMax H3 RefMods plugin is not installed, so there are "
                             "no saved mods to use")
    else:
        _log("using %s" % getattr(patches, "__name__", "?"))
    _cache["patches"], _cache["storage"] = patches, storage
    return patches, storage


def reset():
    """Forget what was found. Only for tests and for a plugin enabled after
    H3 Director first looked."""
    _cache.update({"tried": False, "patches": None, "storage": None, "why": ""})


def available():
    """(usable, why-not). `why` is written for a person, not a log."""
    patches, storage = _resolve()
    if patches is None or storage is None:
        return False, _cache["why"]
    if not hasattr(storage, "list_refmods_info"):
        return False, ("the installed RefMods plugin is a version H3 Director does not "
                       "know how to read (no list_refmods_info)")
    if not hasattr(patches, "_inject_refmods"):
        return False, ("the installed RefMods plugin is a version H3 Director does not "
                       "know how to drive (no _inject_refmods)")
    return True, ""


def list_mods():
    """Every saved mod, as {name, kind, mode, tokens, description, size_mb}.

    Returns [] rather than raising when the plugin is missing -- a reference
    panel with nothing in it is the honest answer, and the UI says why.
    """
    ok, _why = available()
    if not ok:
        return []
    _patches, storage = _resolve()
    try:
        rows = storage.list_refmods_info(recursive=True)
    except Exception as exc:
        _log("could not list saved mods: %r" % (exc,))
        return []
    out = []
    for r in rows or []:
        if not isinstance(r, dict) or not r.get("name"):
            continue
        out.append({
            "name": r.get("name"),
            "kind": r.get("kind") or "image",
            "mode": r.get("mode") or "",
            "tokens": int(r.get("tokens") or 0),
            "description": r.get("description") or "",
            "size_mb": float(r.get("size_mb") or 0.0),
        })
    return out


def build_state(rows, retention=1.0):
    """The JSON the RefMods plugin expects in custom_settings[h3_refmod_state].

    `rows` is what the UI sends: [{name, strength, copies}, ...] in the order
    they should apply. A row with no name, or strength <= 0, is dropped here
    rather than sent for the other plugin to ignore.
    """
    clean = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or row.get("mod") or "").strip()
        if not name:
            continue
        try:
            strength = float(row.get("strength", 1.0))
        except Exception:
            strength = 1.0
        if strength <= 0:
            continue
        try:
            copies = int(row.get("copies", 1))
        except Exception:
            copies = 1
        clean.append({"mod": name, "strength": round(strength, 4),
                      "copies": max(1, min(10, copies))})
    if not clean:
        return None
    try:
        retention = float(retention)
    except Exception:
        retention = 1.0
    return json.dumps({
        "rows": clean,
        "retention": max(0.0, min(2.0, retention)),
        "curve": None,
        "scramble_seed": -1,
    })


def apply_to_kwargs(pipeline_self, kwargs):
    """Inject the selected mods into a generate() call, in the Hybrid pipeline.

    Called instead of the RefMods plugin's own generate wrapper, which the
    Hybrid pipeline bypasses (see the module docstring). Returns the kwargs to
    use: on any failure the originals, unchanged, so a bad mod file costs the
    references and not the render.
    """
    custom = kwargs.get("custom_settings")
    state_json = custom.get(SETTING_GENERATE) if isinstance(custom, dict) else None
    if not state_json:
        return kwargs
    ok, why = available()
    if not ok:
        _log("a RefMod selection was submitted but %s; generating without it" % why)
        return kwargs
    patches, _storage = _resolve()
    try:
        return patches._inject_refmods(pipeline_self, kwargs, state_json)
    except Exception as exc:
        _log("injection failed, generating without the mods: %r" % (exc,))
        return kwargs


def refresh_pipeline_globals(namespace):
    """Point a rebuilt generate() at the RefMods plugin's patched helpers.

    The Hybrid's generate is compiled against a COPY of the H3 pipeline
    module's globals, taken when the class was first built. `_as_video` and
    `_resize_video` are plain module-level functions there, and the RefMods
    plugin replaces them so a saved-mod sentinel passes through instead of
    being treated as pixels. If that copy was taken before the plugin patched
    them, the copy still holds the originals and a video mod dies on
    `'_RefModVideoSentinel' object has no attribute 'ndim'`. Re-reading them
    from the live module at call time removes the ordering question entirely.
    """
    try:
        mod = importlib.import_module("models.minimax_h3.pipeline")
    except Exception:
        return
    for name in ("_as_video", "_resize_video"):
        live = getattr(mod, name, None)
        if live is not None and namespace.get(name) is not live:
            namespace[name] = live


def custom_setting_defs():
    """The custom_settings entries the Hybrid model has to declare for a
    selection to survive task validation.

    Wan2GP's `collect_custom_settings_from_inputs` drops every custom_settings
    entry whose id the target model does not declare -- silently, with no error
    anywhere -- so without this the payload is built correctly and then wiped
    one step later. The RefMods plugin declares these on the stock H3 handler;
    the Hybrid handler delegates to it, so they usually arrive on their own.
    Declaring them here too costs nothing and removes the dependency on which
    plugin loaded first.
    """
    ok, _why = available()
    if not ok:
        return []
    return [{
        "id": SETTING_GENERATE,
        "name": "H3RefModState",
        "label": "RefMods selection (managed by H3 Director / the RefMods plugin -- leave blank)",
        "type": "text",
        "default": "",
    }]
