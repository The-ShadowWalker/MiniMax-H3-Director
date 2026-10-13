"""Where Wan2GP keeps its models, on any install.

Nothing here assumes a drive, a folder name or how Wan2GP was installed. The
answers come from the running Wan2GP:

  * its root is the folder its own wgp.py was loaded from;
  * its model folders are the checkpoint paths it is configured with
    (Settings -> checkpoints paths, kept by shared.utils.files_locator), with
    relative entries such as "ckpts" taken relative to that root -- not to
    whatever the current folder happens to be;
  * the stock H3 models are also looked up exactly the way Wan2GP looks up a
    file it is about to load (files_locator.locate_file), so wherever Wan2GP
    finds them, so does the builder.
"""
import os
import sys
from pathlib import Path

# The two stock BF16 models a Hybrid is built from.
STOCK_FL2VA = "MiniMax-H3-FL2VA_bf16.safetensors"
STOCK_REF2VA = "MiniMax-H3-Ref2VA_bf16.safetensors"


def wan2gp_root():
    """The folder of the running Wan2GP (where its wgp.py is)."""
    mod = sys.modules.get("wgp")
    f = getattr(mod, "__file__", None) if mod is not None else None
    if f:
        return Path(f).resolve().parent
    env = os.environ.get("WAN2GP_DIR")
    if env and (Path(env) / "wgp.py").is_file():
        return Path(env).resolve()
    here = Path.cwd()
    for p in (here, *here.parents):
        if (p / "wgp.py").is_file():
            return p.resolve()
    return here.resolve()


def _configured_paths():
    try:
        from shared.utils import files_locator as fl
        roots = getattr(fl, "_checkpoints_paths", None) or getattr(fl, "default_checkpoints_paths", None)
        if roots:
            return [str(p) for p in roots if str(p).strip()]
    except Exception:
        pass
    return ["ckpts", "."]


def get_checkpoint_roots():
    """Wan2GP's model folders, absolute, first one first (that is where Wan2GP
    puts what it downloads), without duplicates."""
    base = wan2gp_root()
    out, seen = [], set()
    for raw in _configured_paths():
        p = Path(os.path.expandvars(raw)).expanduser()
        if not p.is_absolute():
            p = base / p
        try:
            p = p.resolve()
        except OSError:
            continue
        k = str(p).casefold()
        if k not in seen:
            seen.add(k)
            out.append(p)
    return out


def locate_checkpoint(filename):
    """A model file, found the way Wan2GP finds it."""
    p = Path(filename).expanduser()
    if p.is_absolute():
        return p.resolve() if p.is_file() else None
    try:
        from shared.utils import files_locator as fl
        found = fl.locate_file(filename, error_if_none=False)
        if found:
            q = Path(found)
            if not q.is_absolute():
                q = wan2gp_root() / q
            if q.is_file():
                return q.resolve()
    except Exception:
        pass
    for root in get_checkpoint_roots():
        q = root / filename
        if q.is_file():
            return q.resolve()
    return None


def _is_h3(name):
    n = name.lower()
    return n.endswith(".safetensors") and ("h3" in n or "minimax" in n)


def discover_h3_checkpoints():
    """Every H3 model file in Wan2GP's model folders.

    A dedicated model folder is searched with its subfolders. Wan2GP's own
    root (the default "." entry) is searched only at its top level: going
    down into it would walk the whole install -- plugins, outputs, the
    Python environment -- and find nothing Wan2GP would load from there."""
    found, seen = [], set()

    def add(p):
        k = str(p).casefold()
        if k not in seen:
            seen.add(k)
            found.append(p)

    base = wan2gp_root()
    for root in get_checkpoint_roots():
        if not root.is_dir():
            continue
        walk = root.glob("*.safetensors") if root == base else root.rglob("*.safetensors")
        try:
            for p in walk:
                if p.is_file() and _is_h3(p.name):
                    add(p.resolve())
        except OSError:
            continue
    for name in (STOCK_FL2VA, STOCK_REF2VA):
        p = locate_checkpoint(name)
        if p is not None:
            add(p)
    return sorted(found, key=lambda p: (p.name.lower(), str(p).lower()))


def checkpoint_roots_for_ui():
    return [str(p) for p in get_checkpoint_roots()]
