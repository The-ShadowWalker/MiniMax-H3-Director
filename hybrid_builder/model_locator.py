"""WanGP checkpoint discovery adapter."""
from pathlib import Path

def get_checkpoint_roots():
    try:
        from shared.utils import files_locator as fl
        roots=getattr(fl,"_checkpoints_paths",None)
        if roots:
            return [Path(p).expanduser().resolve() for p in roots if str(p).strip()]
        roots=getattr(fl,"default_checkpoints_paths",["ckpts","."])
        return [Path(p).expanduser().resolve() for p in roots]
    except Exception:
        return [Path("ckpts").resolve(),Path(".").resolve()]

def locate_checkpoint(filename):
    p=Path(filename).expanduser()
    if p.is_absolute(): return p.resolve() if p.is_file() else None
    try:
        from shared.utils import files_locator as fl
        found=fl.locate_file(filename,error_if_none=False)
        if found: return Path(found).resolve()
    except Exception: pass
    for root in get_checkpoint_roots():
        q=root/filename
        if q.is_file(): return q.resolve()
    return None

def discover_h3_checkpoints():
    found=[]; seen=set()
    for root in get_checkpoint_roots():
        if not root.is_dir(): continue
        for p in root.rglob("*.safetensors"):
            if not p.is_file(): continue
            n=p.name.lower()
            if "h3" not in n and "minimax" not in n: continue
            k=str(p.resolve()).casefold()
            if k not in seen:
                seen.add(k); found.append(p.resolve())
    return sorted(found,key=lambda p:(p.name.lower(),str(p).lower()))

def checkpoint_roots_for_ui():
    return [str(p) for p in get_checkpoint_roots()]
