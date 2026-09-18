from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from .model_locator import get_checkpoint_roots

try:
    from safetensors import safe_open
    from safetensors.torch import save_file
except Exception:
    safe_open = save_file = None


@dataclass(frozen=True)
class HybridBuildSpec:
    """Immutable recipe for one cached Hybrid checkpoint."""
    base_checkpoint: str
    reference_checkpoint: str
    recipe: str = "ref2va_adaln"
    start_block: int = 30
    end_block: int = 49
    include_final_adaln: bool = False
    version: int = 2

    def fingerprint(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()[:16]

    @property
    def dtype_name(self) -> str:
        # Current builder is intended for BF16 source models.
        return "BF16"

    @property
    def recipe_name(self) -> str:
        name = f"Ref2VA-AdaLN{self.start_block:02d}-{self.end_block:02d}"
        if self.include_final_adaln:
            name += "-FinalAdaLN"
        return name

    def output_filename(self) -> str:
        return (
            "MiniMax-H3-Hybrid-"
            f"{self.dtype_name}-FL2VA-Base-{self.recipe_name}.safetensors"
        )


def _adaln_keys(keys, start, end):
    pat = re.compile(r"^blocks\.(\d+)\.adaln_proj\.linear\.")
    return {
        key for key in keys
        if (m := pat.match(key)) and start <= int(m.group(1)) <= end
    }


def hybrid_exists_and_matches(output_checkpoint, spec):
    """Check the checkpoint's embedded builder metadata; no sidecar JSON needed."""
    p = Path(output_checkpoint)
    if not p.is_file() or safe_open is None:
        return False
    try:
        with safe_open(str(p), framework="pt", device="cpu") as sf:
            meta = sf.metadata() or {}
        return meta.get("hybrid_builder_fingerprint") == spec.fingerprint()
    except Exception:
        return False


def build_hybrid_checkpoint(spec: HybridBuildSpec, output_checkpoint=None, progress_cb=None):
    """Compose one BF16 Hybrid checkpoint from two source safetensors files.

    FL2VA supplies the complete base checkpoint. Selected Ref2VA AdaLN tensors
    replace matching FL2VA tensors. Composition happens on CPU/RAM; no
    inference models are instantiated on GPU.

    A descriptive filename is generated automatically unless output_checkpoint
    is explicitly supplied.
    """
    if safe_open is None or save_file is None:
        raise RuntimeError("safetensors is required to build a Hybrid checkpoint")

    def report(done, total, message):
        if progress_cb:
            progress_cb(done, total, message)

    base = Path(spec.base_checkpoint)
    ref = Path(spec.reference_checkpoint)

    if not base.is_file():
        raise FileNotFoundError(f"FL2VA checkpoint not found: {base}")
    if not ref.is_file():
        raise FileNotFoundError(f"Ref2VA checkpoint not found: {ref}")

    if output_checkpoint:
        out = Path(output_checkpoint)
    else:
        roots = get_checkpoint_roots()
        if not roots:
            raise RuntimeError("WanGP has no configured checkpoint roots.")
        out = roots[0] / spec.output_filename()
    out.parent.mkdir(parents=True, exist_ok=True)

    if hybrid_exists_and_matches(out, spec):
        return {
            "checkpoint": str(out),
            "definition": None,
            "cached": True,
            "fingerprint": spec.fingerprint(),
        }

    report(0, 1, "Opening FL2VA and Ref2VA safetensors on CPU…")
    with safe_open(str(base), framework="pt", device="cpu") as bf, \
         safe_open(str(ref), framework="pt", device="cpu") as rf:

        base_keys = list(bf.keys())
        ref_keys = set(rf.keys())
        replace = _adaln_keys(base_keys, spec.start_block, spec.end_block)

        if spec.include_final_adaln:
            replace |= {
                k for k in ref_keys
                if k.startswith("final_layer.adaln_proj.")
            }

        report(0, len(base_keys), f"Indexed {len(base_keys):,} base tensors; replacing {len(replace):,} AdaLN tensors…")
        missing = replace - ref_keys
        if missing:
            raise RuntimeError(
                "Missing Ref2VA tensors: " + ", ".join(sorted(missing)[:20])
            )

        tensors = {}
        total = len(base_keys)
        for done, key in enumerate(base_keys, 1):
            tensors[key] = rf.get_tensor(key) if key in replace else bf.get_tensor(key)
            if done == 1 or done % 100 == 0 or done == total:
                report(done, total, f"Reading tensors: {done:,}/{total:,}")

        report(total, total, "Writing Hybrid safetensors file…")
        metadata = {
            "format": "pt",
            "minimax_h3_hybrid": "FL2VA base + Ref2VA AdaLN",
            "dtype": spec.dtype_name,
            "recipe": spec.recipe_name,
            "start_block": str(spec.start_block),
            "end_block": str(spec.end_block),
            "include_final_adaln": str(spec.include_final_adaln),
            "hybrid_builder_fingerprint": spec.fingerprint(),
            "source_fl2va": base.name,
            "source_ref2va": ref.name,
        }

        tmp = out.with_suffix(out.suffix + ".building")
        save_file(tensors, str(tmp), metadata=metadata)
        os.replace(tmp, out)
        report(total, total, "Hybrid checkpoint written successfully.")

    return {
        "checkpoint": str(out),
        "definition": None,
        "cached": False,
        "fingerprint": spec.fingerprint(),
    }


def build_with_cache(spec: HybridBuildSpec, output_checkpoint=None, progress_cb=None):
    return build_hybrid_checkpoint(spec, output_checkpoint, progress_cb=progress_cb)
