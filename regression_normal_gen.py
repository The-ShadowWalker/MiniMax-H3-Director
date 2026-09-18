"""Regression guard: the NORMAL generate path must stay unaffected by the
bridge work. Run after any change to _assemble_settings or the bridge code."""
import ast, json, base64, sys, types, importlib.util

WGP = "/home/claude/wgpsrc/Wan2GP-main"

def load_plugin():
    src = open(WGP + "/shared/utils/plugins.py", encoding="utf-8").read()
    tree = ast.parse(src)
    chunks = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in (
                "WAN2GPPlugin", "PluginTab", "InsertAfterRequest", "PluginDeepyTool"):
            seg = ast.get_source_segment(src, node)
            for d in node.decorator_list:
                seg = "@" + ast.get_source_segment(src, d) + "\n" + seg
            chunks.append(seg)
    g = types.ModuleType("gradio")
    class _C:
        def __init__(s, *a, **k): pass
        def __enter__(s): return s
        def __exit__(s, *a): return False
        def click(s, *a, **k): return None
    for n in ("Column","Row","Textbox","Button","HTML","Markdown","Tabs","TabItem","Accordion",
              "File","Files","Dropdown","Slider","Checkbox","Number","Gallery","State","Blocks","Group"):
        setattr(g, n, _C)
    g.update = lambda *a, **k: {}; g.Info = lambda *a, **k: None; g.Error = Exception
    g.components = types.SimpleNamespace(Component=_C)
    sys.modules["gradio"] = g
    ns = {"gr": g}
    exec("from dataclasses import dataclass, field\nfrom typing import Dict, List, Any, Union, Optional\nimport inspect, re\n"
         "import gradio as gr\n" + "\n\n".join(chunks), ns)
    sh = types.ModuleType("shared"); su = types.ModuleType("shared.utils")
    sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = ns["WAN2GPPlugin"]
    sys.modules.update({"shared": sh, "shared.utils": su, "shared.utils.plugins": sp})
    spec = importlib.util.spec_from_file_location("h3d2", "plugin.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    p = mod.get_plugin(); p.setup_ui(); p.tabs[mod.PLUGIN_ID].component_constructor(None)
    class S:
        def list_model_defs(s, **k): return [{"model_type": "H", "architecture": "minimax_h3_hybrid"}]
        def get_model_defs(s, **k): return s.list_model_defs()
        def get_model_def(s, mt): return {
            "architecture": "minimax_h3_hybrid",
            "guide_custom_choices": {"choices": [("Two Reference Videos", "V+-U"),
                                                 ("Generic Control Video", "GV")]},
            "audio_prompt_type_sources": {"selection": ["", "A", "B", "AB"]}}
    p._wangp_session = S()
    return p, mod

BRIDGE_ONLY = ("video_source", "keep_frames_video_source", "frames_positions")
FAIL = []

def check(label, cond, detail=""):
    print(("  OK   " if cond else "  FAIL ") + label + ("  " + detail if detail and not cond else ""))
    if not cond: FAIL.append(label)

def main():
    p, mod = load_plugin()
    up = lambda n, b: json.loads(p._on_bridge(json.dumps(
        {"cmd": "upload_media", "data": {"name": n, "b64": base64.b64encode(b).decode()}, "id": "1"})))["data"]["mediaId"]
    img1, img2 = up("r1.webp", b"a"), up("r2.jpg", b"b")
    song, ctrl = up("s.wav", b"c"), up("g.mp4", b"d")

    cases = {
        "text only":                    {"media": {}},
        "refs only":                    {"media": {"ref_images": [img1, img2]}},
        "refs + song":                  {"media": {"ref_images": [img1], "audio_guide": song}},
        "refs + control video":         {"media": {"ref_images": [img1], "control_video": ctrl}},
        "start + end images":           {"media": {"image_start": img1, "image_end": img2}},
        "everything":                   {"media": {"ref_images": [img1, img2], "audio_guide": song,
                                                   "control_video": ctrl, "image_start": img1}},
    }
    for label, extra in cases.items():
        plan = {"model_type": "H", "prompt": "a shot", "sliding_window_size": 362,
                "sliding_window_overlap": 18, "sample_solver": "euler"}
        plan.update(extra)
        st = p._assemble_settings(plan)
        leaked = [k for k in BRIDGE_ONLY if k in st]
        check("normal gen keeps bridge keys out: %s" % label, not leaked, str(leaked))
        for key in ("video_prompt_type", "audio_prompt_type", "image_prompt_type"):
            check("  %s always sent: %s" % (key, label), key in st)
        if extra["media"].get("control_video"):
            ds = st.get("denoising_strength")
            check("  control video gets a usable strength: %s" % label,
                  ds is not None and ds < 1.0, repr(ds))

    src = open("plugin.py", encoding="utf-8").read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_generate_stream":
            body = ast.get_source_segment(src, node)
            for name in ("_injected_for_pass", "_continuation_plan", "_bridge_frames",
                         "keep_frames_video_source", "frames_positions", "video_source"):
                check("_generate_stream never references %s" % name, name not in body)
        if isinstance(node, ast.FunctionDef) and node.name in ("_generate_stream", "_bridge_run_stream"):
            attrs = {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)}
            check("%s is wrapped (queue pumps)" % node.name,
                  bool(attrs & {"_api", "_wangp_session"}))

    print("\n" + ("ALL NORMAL-GEN CHECKS PASSED" if not FAIL else "FAILURES: %s" % FAIL))
    return 1 if FAIL else 0

if __name__ == "__main__":
    raise SystemExit(main())
