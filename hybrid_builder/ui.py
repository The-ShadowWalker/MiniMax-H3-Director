"""Hybrid Builder UI helpers with WanGP multi-path discovery."""
from dataclasses import dataclass
from .builder import HybridBuildSpec
from .model_locator import discover_h3_checkpoints, checkpoint_roots_for_ui

@dataclass
class HybridBuilderUIState:
    start_block:int=30
    end_block:int=49
    include_final_adaln:bool=False
    output_root:str=""

    def validate(self):
        if not 0<=self.start_block<=49 or not 0<=self.end_block<=49:
            raise ValueError("Block values must be between 0 and 49.")
        if self.start_block>self.end_block:
            raise ValueError("Start block cannot exceed end block.")

def discover_models():
    return [{"label":f"{p.name}  [{p.parent}]","path":str(p)}
            for p in discover_h3_checkpoints()]

def discover_roots():
    return checkpoint_roots_for_ui()

def build_recipe_spec(base_checkpoint,reference_checkpoint,state):
    state.validate()
    return HybridBuildSpec(base_checkpoint=base_checkpoint,
        reference_checkpoint=reference_checkpoint,start_block=state.start_block,
        end_block=state.end_block,include_final_adaln=state.include_final_adaln)

def ui_definition():
    return {"title":"MiniMax H3 Hybrid Builder",
        "description":"Uses every checkpoint location configured in WanGP; multiple drives are supported.",
        "model_discovery":{"provider":"WanGP shared.utils.files_locator","all_checkpoint_roots":True,"recursive":True},
        "controls":[
            {"id":"hybrid_base_model","label":"Base Model (FL2VA BF16)","type":"model_selector","refreshable":True},
            {"id":"hybrid_reference_model","label":"Reference Model (Ref2VA BF16)","type":"model_selector","refreshable":True},
            {"id":"hybrid_start_block","label":"Ref2VA AdaLN Start Block","type":"integer","min":0,"max":49,"default":30},
            {"id":"hybrid_end_block","label":"Ref2VA AdaLN End Block","type":"integer","min":0,"max":49,"default":49},
            {"id":"hybrid_final_adaln","label":"Include Ref2VA Final AdaLN","type":"checkbox","default":False},
            {"id":"hybrid_output_root","label":"Save Hybrid To","type":"checkpoint_root_selector","refreshable":True},
            {"id":"hybrid_build","label":"Build / Use Hybrid","type":"button"}],
        "refresh_after_build":True}
