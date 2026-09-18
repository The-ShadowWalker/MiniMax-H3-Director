"""Wan2GP model handler for the MiniMax H3 Hybrid AV plugin.

This handler deliberately reuses Wan2GP's stock MiniMax H3 loader/pipeline and
adds only two things:
  1) FL2VA-base + Ref2VA-AdaLN overlay loading; and
  2) a Hybrid pipeline mode that permits Ref2VA visual references and FL2VA
     target/source soundtrack conditioning in the same H3 generation call.
"""
from __future__ import annotations

import inspect
import os
import re
import textwrap
from functools import lru_cache

import torch

from shared.utils import files_locator as fl
from shared.utils.hf import build_hf_url

from models.minimax_h3 import minimax_h3_handler as _stock

HYBRID_ARCH = "minimax_h3_hybrid"
HYBRID_PRUNED_ARCH = "minimax_h3_hybrid_pruned"
FL2VA_ARCH = _stock.FL2VA_ARCHITECTURE
FL2VA_PRUNED_ARCH = _stock.FL2VA_PRUNED_ARCHITECTURE

REPO_ID = _stock.REPO_ID

OVERLAY_FILES = {
    HYBRID_ARCH: "MiniMax-H3-Ref2VA_bf16.safetensors",
    HYBRID_PRUNED_ARCH: "MiniMax-H3-Ref2VA-pruned_rank8_bf16.safetensors",
}
BASE_ARCH = {
    HYBRID_ARCH: FL2VA_ARCH,
    HYBRID_PRUNED_ARCH: FL2VA_PRUNED_ARCH,
}


def _overlay_for(effective: str) -> str:
    """Overlay filename for an architecture, without KeyError.

    These lookups sit inside dict.get(key, DEFAULT) calls, where Python
    evaluates DEFAULT eagerly -- so a bare OVERLAY_FILES[effective] raised
    even when model_def already supplied its own hybrid_overlay_filename.
    """
    return OVERLAY_FILES.get(effective, OVERLAY_FILES[HYBRID_ARCH])


def _effective_model_type(base_model_type: str, model_def: dict | None = None, model_type: str | None = None) -> str:
    """Resolve which HYBRID ARCHITECTURE this is -- never the model id.

    wgp.py calls load_model as:
        load_model(local_model_file_list, runtime_model_type or model_type,
                   base_model_type, model_def, ...)
    so `model_type` is the FINETUNE ID for anything registered in finetunes/
    (e.g. "MiniMax-H3-Hybrid-BF16-FL2VA-Base-Ref2VA-AdaLN30-49"), while
    `base_model_type` is the architecture. The old order preferred
    model_type, so every finetune resolved to its own id: OVERLAY_FILES[id]
    raised KeyError, and BASE_ARCH.get(id, FL2VA_ARCH) silently returned the
    FULL base for a PRUNED finetune.

    Architecture first, then base_model_type, then model_type -- and only
    accept a value that is actually one of our architectures.
    """
    known = (HYBRID_ARCH, HYBRID_PRUNED_ARCH)
    model_def = model_def or {}
    for candidate in (model_def.get("architecture"), base_model_type,
                      model_def.get("model_type"), model_type):
        if candidate in known:
            return str(candidate)
    # Not one of ours: hand back the most architecture-like value we have so
    # callers can still make a sensible decision, but never a finetune id.
    return str(model_def.get("architecture") or base_model_type or model_type or "")


def _is_hybrid(base_model_type: str, model_def: dict | None = None, model_type: str | None = None) -> bool:
    return _effective_model_type(base_model_type, model_def, model_type) in (HYBRID_ARCH, HYBRID_PRUNED_ARCH)


def _hybrid_base(base_model_type: str, model_def: dict | None = None, model_type: str | None = None) -> str:
    effective = _effective_model_type(base_model_type, model_def, model_type)
    return BASE_ARCH.get(effective, FL2VA_ARCH)


# --- H3 Director: co-existence guard ---
# This backend also ships inside MiniMax-H3-Hybrid-AV-Universal. While BOTH
# plugins are installed, whichever registers first owns the architecture and
# the second must not re-register it. Once the old plugin is removed this
# guard simply never fires.
def _already_registered(arch):
    try:
        import wgp  # type: ignore
        return arch in getattr(wgp, "model_types_handlers", {})
    except Exception:
        return False


def _register_hybrid_lora_architectures():
    """Teach Wan2GP's AdaLN LoRA converter about the hybrid architectures.

    `lora_affine.py:_ARCHITECTURES` maps a model_type to the affine package
    used when converting an AdaLN LoRA between compression widths. It lists
    only the four stock H3 architectures, so loading ANY AdaLN LoRA (the PDD
    8-step accelerator, for one) against a hybrid raised:

        ValueError: Unsupported MiniMax H3 architecture for AdaLN LoRA
                    conversion: minimax_h3_hybrid

    It throws during the lookup, before doing any work — and for a BF16 hybrid
    there is no work to do. Both the checkpoint and the PDD LoRAs use the FULL
    AdaLN width (FULL_TIME_DIM = 2688), and convert_adaln_loras returns early
    when source == target:

        if source_width == target_width and hybrid_ref2va_blocks is None:
            return 0, architecture, source_width, target_width

    So the entry only has to exist. It maps to "fl2va" because a hybrid is an
    FL2VA base with Ref2VA AdaLN merged into a block range — the affine package
    is never loaded on the full-width path, so the choice does not affect the
    weights. A future PRUNED hybrid would use compressed tables and would need
    real per-block handling instead; it is refused loudly below rather than
    silently converted with the wrong map.
    """
    try:
        from models.minimax_h3 import lora_affine
    except Exception as exc:
        print(f"[H3 Hybrid] AdaLN LoRA converter not present ({exc}); nothing to register.")
        return
    table = getattr(lora_affine, "_ARCHITECTURES", None)
    if not isinstance(table, dict):
        return
    added = []
    for arch in (HYBRID_ARCH, HYBRID_PRUNED_ARCH):
        if arch not in table:
            table[arch] = "fl2va"
            added.append(arch)
    if added:
        print(f"[H3 Hybrid] Registered {', '.join(added)} with the AdaLN LoRA "
              "converter (full-width AdaLN, so conversion is a no-op).")


def _install_hybrid_generate(pipeline):
    """Promote the stock H3 pipeline to the plugin's own MiniMaxH3HybridPipeline.

    Was ~130 lines of string-editing against Wan2GP's generate() source.
    The hybrid conditioning policy now lives in real, overridable methods on
    MiniMaxH3HybridPipeline (models/minimax_h3_hybrid_pipeline.py), per
    pass-along v2.1 section 24 STEP 2/3. The generate() contract is unchanged,
    so Wan2GP's sliding-window engine, media and progress handling all call it
    exactly as they call stock H3.
    """
    from .minimax_h3_hybrid_pipeline import install as _install_hybrid_pipeline
    return _install_hybrid_pipeline(pipeline)


def _overlay_adaln_from_checkpoint(transformer, overlay_path: str, dtype):
    """Overlay all per-block Ref2VA AdaLN projection weights onto the already
    loaded FL2VA transformer.

    This mirrors the default Scott Mudge Hybrid Loader preset:
        ref2va_adaln_over_fl2va

    The overlay is loaded through Wan2GP's MMGP offload loader, so the full
    second checkpoint is not materialized as a second Python state dict.
    """
    if not overlay_path or not os.path.isfile(overlay_path):
        raise FileNotFoundError(f"MiniMax H3 Hybrid overlay checkpoint not found: {overlay_path}")

    from mmgp import offload

    kept_count = {"n": 0}

    def preprocess(state_dict):
        # Keep exactly blocks.N.adaln_proj.linear.{weight,bias} plus quantized
        # sibling tensors if a future H3 checkpoint stores those projections in
        # a quantized representation.
        keep = {}
        for key, value in state_dict.items():
            if key.startswith("model.diffusion_model."):
                key = key[len("model.diffusion_model."):]
            elif key.startswith("diffusion_model."):
                key = key[len("diffusion_model."):]
            if key.startswith("blocks.") and ".adaln_proj.linear." in key:
                keep[key] = value
            elif key.endswith(".comfy_quant") or key.endswith("_scale"):
                parent = key[:-len(".comfy_quant")] if key.endswith(".comfy_quant") else key[:-len("_scale")]
                if parent.startswith("blocks.") and ".adaln_proj.linear." in parent:
                    keep[key] = value
        kept_count["n"] = len(keep)
        return keep

    # This is a PARTIAL load by design: only the per-block AdaLN projections are
    # overlaid onto an already fully-loaded FL2VA transformer. Every other
    # parameter is therefore absent from the filtered state dict, and mmgp's
    # load_model_data raises `Missing keys: [...]` unless told that a partial
    # load is intended. ignore_missing_keys=True is the supported switch for
    # exactly this case (mmgp/offload.py: `if len(missing_keys) > 0 and not
    # ignore_missing_keys: raise`). The underlying call is
    # load_state_dict(strict=False, assign=True), so untouched parameters keep
    # their loaded FL2VA values -- nothing is zeroed or left on meta.
    offload.load_model_data(
        transformer,
        overlay_path,
        writable_tensors=False,
        default_dtype=dtype,
        preprocess_sd=preprocess,
        ignore_missing_keys=True,
        ignore_unused_weights=True,
    )

    if kept_count["n"] == 0:
        raise RuntimeError(
            "MiniMax H3 Hybrid overlay matched ZERO tensors in "
            f"'{overlay_path}'. Expected keys of the form "
            "blocks.N.adaln_proj.linear.{weight,bias}. The overlay checkpoint "
            "is either not a Ref2VA checkpoint or uses a different key layout."
        )

    # Terminal trace (Dave wants tracing in the console, not a log file).
    print(f"[H3 Hybrid] AdaLN overlay applied: {kept_count['n']} tensors from {os.path.basename(overlay_path)}")
    return transformer


def _is_prebuilt_hybrid(model_def, model_filename):
    """Is the checkpoint we just loaded already a merged hybrid?

    Three signals, cheapest first:
      1) hybrid_prebuilt: true in the model definition (what
         _register_hybrid_finetune writes for anything the builder makes);
      2) an explicitly emptied hybrid_overlay_filename (opt-out);
      3) the builder's own filename shape, so finetunes registered by older
         plugin versions -- which have no hybrid_prebuilt flag -- are still
         recognised without needing to be rebuilt.
    """
    model_def = model_def or {}
    if model_def.get("hybrid_prebuilt"):
        return "model definition flag"
    if "hybrid_overlay_filename" in model_def and not model_def.get("hybrid_overlay_filename"):
        return "overlay explicitly disabled"
    raw = model_filename if isinstance(model_filename, (list, tuple)) else [model_filename]
    # Split on BOTH separators explicitly: os.path.basename follows the host
    # OS, so a Windows path inspected anywhere else would come back whole.
    names = [str(f).replace("\\", "/").rsplit("/", 1)[-1] for f in raw if f]
    for name in names:
        low = name.lower()
        if "hybrid" in low and "adaln" in low:
            return f"filename '{name}'"
    return None


class family_handler:
    """Adapter around Wan2GP's built-in MiniMax H3 family handler."""

    @staticmethod
    def query_supported_types():
        return [HYBRID_ARCH, HYBRID_PRUNED_ARCH]

    @staticmethod
    def query_family_maps():
        # Keep the Hybrid models in the MiniMax H3 family and map them to the
        # FL2VA base architecture for shared defaults/compatibility handling.
        return {
            HYBRID_ARCH: FL2VA_ARCH,
            HYBRID_PRUNED_ARCH: FL2VA_PRUNED_ARCH,
        }, {}

    @staticmethod
    def query_model_family():
        return "minimax_h3"

    @staticmethod
    def query_family_infos():
        return {"minimax_h3": (70, "MiniMax H3")}

    @staticmethod
    def get_rgb_factors(base_model_type):
        return _stock.family_handler.get_rgb_factors(_hybrid_base(base_model_type))

    @staticmethod
    def register_lora_cli_args(parser, lora_root):
        # Dropped from the stock handler in the Jan-2026 lora-layout migration.
        # Forward when it exists, no-op when it does not, so neither version
        # of Wan2GP crashes on startup.
        stock = getattr(_stock.family_handler, "register_lora_cli_args", None)
        if stock is None:
            return None
        return stock(parser, lora_root)

    @staticmethod
    def get_lora_dir(base_model_type, *legacy):
        """LoRA location for the hybrid -- the same one stock MiniMax H3 uses.

        Two Wan2GP contracts exist and this must satisfy both:

          NEW (wgp.py:2532)  probes ``signature(get_dir).bind(base_model_type)``
            first; on success it calls ``get_dir(base_model_type)`` and expects
            a LoRA CONFIG KEY, which it then feeds to ``resolve_lora_dir``.
          LEGACY             calls ``get_dir(base_model_type, args, lora_root)``
            and expects a fully RESOLVED PATH.

        The ``*legacy`` star-arg is what makes the new probe bind, so the new
        Wan2GP takes the key branch; when we are called with three arguments we
        are on the legacy contract and must hand back a path instead.

        The v2.43.2 crash was this method insisting on three parameters while
        the stock handler had been cut down to one: the new probe failed, wgp
        fell back to the 3-arg call, and our 3-arg forward hit a 1-arg stock
        function -- taking Wan2GP's whole startup down with it.
        """
        base = _hybrid_base(base_model_type)
        stock = getattr(_stock.family_handler, "get_lora_dir", None)

        key_or_path = None
        stock_returned_key = True
        if stock is not None:
            try:
                inspect.signature(stock).bind(base)
            except TypeError:
                # Legacy stock handler: needs args + lora_root, returns a path.
                stock_returned_key = False
                try:
                    key_or_path = stock(base, *legacy[:2]) if len(legacy) >= 2 else None
                except Exception:
                    key_or_path = None
            else:
                try:
                    key_or_path = stock(base)
                except Exception:
                    key_or_path = None

        if key_or_path is None:
            # Stock gave us nothing usable -- fall back to H3's own family key.
            key_or_path = "minimax_h3"
            stock_returned_key = True

        if not legacy:
            # New contract: hand back the key untouched and let wgp resolve it.
            return key_or_path if stock_returned_key else key_or_path

        # Legacy contract: the caller wants a real path.
        if not stock_returned_key:
            return key_or_path
        lora_root = legacy[1] if len(legacy) > 1 else "loras"
        try:
            from shared.lora_paths import resolve_lora_dir  # type: ignore
            lora_config = getattr(legacy[0], "lora_config", None) if legacy else None
            return resolve_lora_dir(key_or_path, lora_root, lora_config)
        except Exception:
            return os.path.join(lora_root or "loras", str(key_or_path))

    @staticmethod
    def set_cache_parameters(cache_type, base_model_type, model_def, inputs, skip_steps_cache):
        return _stock.family_handler.set_cache_parameters(cache_type, _hybrid_base(base_model_type), model_def, inputs, skip_steps_cache)

    @staticmethod
    def query_model_def(base_model_type, model_def):
        effective = _effective_model_type(base_model_type, model_def)
        base = _hybrid_base(base_model_type, model_def, effective)
        result = _stock.family_handler.query_model_def(base, model_def)

        # Start from FL2VA's target-audio behavior, then add Ref2VA's visual
        # reference capabilities.
        result.update({
            "name": model_def.get("name") or ("MiniMax H3 Hybrid AV Pruned 20B" if "pruned" in effective else "MiniMax H3 Hybrid AV 33B"),
            "architecture": effective,
            "base_model_type": base,
            "hybrid_h3": True,
            "hybrid_overlay_filename": model_def.get("hybrid_overlay_filename", _overlay_for(effective)),
            "sliding_window": True,
            "video_continuation": True,
            "audio_guide_window_slicing": True,
            "video_length_not_limited_by_audio": True,
            "output_audio_is_input_audio": True,
            "image_prompt_types_allowed": "TSEVL",
            "end_frames_always_enabled": True,
            "reference_image_enabled": True,
            # Stock query_model_def() is called with the FL2VA base, whose
            # branch sets one_image_ref_only=True (FL2VA takes a single
            # first/last-frame image). Ref2VA's branch does NOT set it, and the
            # Hybrid conditions references the Ref2VA way -- Dave's baseline is
            # a 5-reference-sheet shot (pass-along 6/28). Left inherited,
            # wgp.py:1366 rejected any task with more than one reference image:
            # "Only one Reference Image is supported by this model mode".
            "one_image_ref_only": False,
            "return_image_refs_tensor": False,
            "fit_into_canvas_image_refs": 0,
            "any_image_refs_relative_size": True,
            "image_refs_relative_size": {"min": 50, "max": 400, "step": 1},
            "image_ref_choices": {
                "choices": [
                    ("Generate without Reference Images", ""),
                    ("Use Reference Images", "I"),
                    ("First Reference Image is the Main Subject / Landscape, defines Output Dimensions, and may be followed by other Reference Images", "KI"),
                ],
                "letters_filter": "KI",
                "default": "I",
                "label": "Reference Images",
            },
            # Kept in sync with the stock Ref2VA handler's guide_custom_choices.
            # These letters DRIFT: upstream's own fix_settings migration for
            # settings_version < 2.76 rewrites a bare "V" to "GV" and appends
            # "U" to reference videos. This list had the pre-2.76 spelling, so
            # "Provide Generic Control Video" sent "V" with no "G" -- which is
            # a REFERENCE video (15s cap, pinned to frame 0), not a control
            # video -- and "G" was stripped by the letters_filter anyway, so
            # control video was unreachable from the Hybrid. Re-diff this
            # against the stock handler after every Wan2GP update.
            "guide_custom_choices": {
                "choices": [
                    ("Generate without a Reference or Control Video", ""),
                    ("Use One Reference Video", "V-U"),
                    ("Use Two Reference Videos", "V+-U"),
                    ("Transfer Depth Map From Control Video", "DV"),
                    ("Provide Generic Control Video", "GV"),
                ],
                "letters_filter": "UGPDEV+-",
                "default": "",
                "label": "Reference / Control Video",
            },
            "preprocess_video_guide2": True,
            "reference_video_max_frames": 15 * 24,
            "reference_video_max_size": (768, 1344),
            "any_audio_prompt": True,
            "audio_prompt_choices": True,
            "audio_guide_label": "Source Audio / Soundtrack",
            # "B" is the Ref2VA VOICE reference (audio_guide2), kept distinct
            # from "A" (the song -> target audio -> lip sync). Without "B" in
            # the selection a voice sample would be silently dropped.
            "audio_prompt_type_sources": {
                "selection": ["", "A", "B", "AB"],
                "labels": {
                    "": "Generate Video and Audio from Text Prompt",
                    "A": "Generate Video based on Soundtrack and Text Prompt",
                    "B": "Generate Audio in a Reference Voice (no soundtrack)",
                    "AB": "Soundtrack + Reference Voice (voice is inert while a soundtrack is supplied)",
                },
                # Must include B or the voice reference is stripped here.
                "letters_filter": "AB",
                "label": "Audio Source",
                "show_label": True,
                "default": "A",
            },
            # Combined Hybrid prompt help: visual reference language from
            # Ref2VA, soundtrack behavior from FL2VA.
            "prompt_infos": _stock.REF2VA_PROMPT_INFOS,
            "infos": _stock.REF2VA_INFOS + _stock.H3_RUNTIME_INFOS + (_stock.PRUNED_INFOS if "pruned" in effective else ""),
        })
        return result

    @staticmethod
    def validate_generative_settings(base_model_type, model_def, inputs):
        # Validate H3's normal sliding-window overlap first.
        error = _stock.family_handler.validate_generative_settings(_hybrid_base(base_model_type, model_def), model_def, inputs)
        if error:
            return error
        images = inputs.get("image_refs") or []
        if len(images) > 9:
            return "MiniMax H3 Hybrid accepts at most 9 reference images"
        audio_type = inputs.get("audio_prompt_type") or ""
        if "A" in audio_type and not inputs.get("audio_guide"):
            return "MiniMax H3 Hybrid soundtrack mode requires a Source Audio / Soundtrack file"
        return None

    @staticmethod
    def query_model_files(computeList, base_model_type, model_def=None):
        model_def = model_def or {}
        effective = _effective_model_type(base_model_type, model_def)
        base = _hybrid_base(base_model_type, model_def, effective)
        downloads = _stock.family_handler.query_model_files(computeList, base, model_def)
        if not isinstance(downloads, list):
            downloads = [downloads]
        overlay = model_def.get("hybrid_overlay_filename", _overlay_for(effective))
        downloads.append({
            "repoId": model_def.get("hybrid_overlay_repo_id", REPO_ID),
            "sourceFolderList": [model_def.get("hybrid_overlay_source_folder", "")],
            "fileList": [[overlay]],
        })
        return downloads

    @staticmethod
    def load_model(model_filename, model_type, base_model_type, model_def,
                   quantizeTransformer=False, text_encoder_quantization=None,
                   dtype=torch.bfloat16, VAE_dtype=torch.float32,
                   mixed_precision_transformer=False, save_quantized=False,
                   submodel_no_list=None, text_encoder_filename=None, **kwargs):
        # Must run BEFORE any LoRA loads: wgp calls the AdaLN converter from
        # load_loras_into_model, after load_model returns.
        _register_hybrid_lora_architectures()

        effective = _effective_model_type(base_model_type, model_def, model_type)
        base = _hybrid_base(base_model_type, model_def, effective)

        # WanGP's generic model loader supplies the selected BASE checkpoint
        # path. The Ref2VA checkpoint is an auxiliary asset declared by
        # query_model_files and located by its stable filename here.
        pipeline, pipe = _stock.family_handler.load_model(
            model_filename=model_filename,
            model_type=model_type,
            base_model_type=base,
            model_def=model_def,
            quantizeTransformer=quantizeTransformer,
            text_encoder_quantization=text_encoder_quantization,
            dtype=dtype,
            VAE_dtype=VAE_dtype,
            mixed_precision_transformer=mixed_precision_transformer,
            save_quantized=save_quantized,
            submodel_no_list=submodel_no_list,
            text_encoder_filename=text_encoder_filename,
            **kwargs,
        )

        # A checkpoint produced by this plugin's Hybrid Builder ALREADY has the
        # Ref2VA AdaLN tensors merged in. Overlaying again at load time is at
        # best wasted I/O and at worst overwrites the built block range (e.g. a
        # 30-49 build) with the full 0-49 overlay, silently discarding the
        # recipe. Detect a prebuilt checkpoint and skip the runtime overlay.
        prebuilt = _is_prebuilt_hybrid(model_def, model_filename)
        if prebuilt:
            print(f"[H3 Hybrid] Prebuilt hybrid checkpoint detected ({prebuilt}); "
                  "skipping the runtime AdaLN overlay.")
        else:
            overlay_name = model_def.get("hybrid_overlay_filename", _overlay_for(effective))
            overlay_path = fl.locate_file(overlay_name, error_if_none=False)
            if overlay_path is None:
                raise FileNotFoundError(
                    f"MiniMax H3 Hybrid overlay checkpoint '{overlay_name}' was not found. "
                    "The model plugin should download it automatically; check the Wan2GP model/plugin files."
                )
            _overlay_adaln_from_checkpoint(pipeline.transformer, overlay_path, dtype)

        _install_hybrid_generate(pipeline)

        # The stock handler's pipe dictionary already contains all shared H3
        # components. Keep it intact so MMGP offload/job/media handling stays
        # exactly the same as official H3.
        return pipeline, pipe

    @staticmethod
    def fix_settings(base_model_type, settings_version, model_def, ui_defaults):
        """Version-gated MIGRATION only -- never force current values here.

        wgp.py calls this on EVERY settings load (wgp.py:3177, and again via
        get_factory_settings AFTER model_def["settings"] has been applied).
        The old body unconditionally did:

            ui_defaults.update({"audio_prompt_type": "A",
                                "video_prompt_type": "I",
                                "sliding_window_size": 362,
                                "sliding_window_overlap": 18})

        so it overwrote whatever the plugin had just sent. That is what put
        "I" into video_prompt_type on a task carrying no image_refs, which
        wgp.py:1361 then rejects with "You must provide at least one
        Reference Image". It also reset the sliding window on every load.

        Wan2GP's own H3 handler only ever makes settings_version-gated
        edits here. Factory defaults belong in update_default_settings(),
        which still sets them for a brand-new model.
        """
        _stock.family_handler.fix_settings(_hybrid_base(base_model_type, model_def), settings_version, model_def, ui_defaults)

    @staticmethod
    def update_default_settings(base_model_type, model_def, ui_defaults):
        _stock.family_handler.update_default_settings(_hybrid_base(base_model_type, model_def), model_def, ui_defaults)
        ui_defaults.update({
            "audio_prompt_type": "A",
            "video_prompt_type": "I",
            "sliding_window_size": 362,
            "sliding_window_overlap": 18,
        })
