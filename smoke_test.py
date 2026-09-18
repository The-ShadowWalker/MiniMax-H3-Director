"""Smoke test: executes plugin.py against the REAL WAN2GPPlugin class source
and the REAL _component_constructor_accepts_api, extracted from Wan2GP."""
import ast, sys, types, importlib.util, inspect
WGP = "/home/claude/wgpsrc/Wan2GP-main"
src = open(WGP + "/shared/utils/plugins.py", encoding="utf-8").read()
tree = ast.parse(src)

wanted = {"WAN2GPPlugin", "PluginTab", "InsertAfterRequest", "PluginDeepyTool"}
chunks = []
for node in tree.body:
    if isinstance(node, (ast.ClassDef,)) and node.name in wanted:
        seg = ast.get_source_segment(src, node)
        for d in node.decorator_list:                 # get_source_segment drops decorators
            seg = "@" + ast.get_source_segment(src, d) + "\n" + seg
        chunks.append(seg)
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id == "_DEEPY_TOOL_NAME_RE":
                chunks.append(ast.get_source_segment(src, node))
# the real accepts-api check, verbatim
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == "_component_constructor_accepts_api":
        fn_src = ast.get_source_segment(src, node)
        fn_src = "\n".join(l[4:] if l.startswith("    ") else l for l in fn_src.split("\n"))
        fn_src = fn_src.replace("@staticmethod\n", "")
        chunks.append(fn_src)

g = types.ModuleType("gradio")
class _C:
    def __init__(s,*a,**k): pass
    def __enter__(s): return s
    def __exit__(s,*a): return False
    def click(s,*a,**k): return None
for n in ("Column","Row","Textbox","Button","HTML","Markdown","Tabs","TabItem","Accordion","File",
          "Files","Dropdown","Slider","Checkbox","Number","Gallery","State","Text","Video","Image","Blocks","Group"):
    setattr(g, n, _C)
g.update = lambda *a, **k: {}; g.Info = lambda *a, **k: None; g.Error = Exception
g.components = types.SimpleNamespace(Component=_C)
sys.modules["gradio"] = g

ns = {"gr": g, "inspect": inspect, "re": __import__("re")}
exec("from dataclasses import dataclass, field\nfrom typing import Dict, List, Any, Union, Optional\nimport gradio as gr\n" + "\n\n".join(chunks), ns)
WAN2GPPlugin = ns["WAN2GPPlugin"]
accepts_api = ns["_component_constructor_accepts_api"]
print("extracted REAL WAN2GPPlugin + accepts_api from Wan2GP source")

shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp})

spec = importlib.util.spec_from_file_location("h3d2_plugin", "plugin.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

p = m.get_plugin()
assert isinstance(p, WAN2GPPlugin), "FAIL: not a WAN2GPPlugin"
p.setup_ui()
assert p.tabs, "FAIL: setup_ui registered NO tab"
print("TAB REGISTERED:", [(k, v.label) for k, v in p.tabs.items()])
print("custom_js snippets:", len(p.custom_js_snippets), "| bytes:", len(p.custom_js_snippets[0]))
print("component requests:", p.component_requests)
ctor = p.tabs[m.PLUGIN_ID].component_constructor
acc = accepts_api(ctor)
print("accepts api_session (=> wrapped in plugin_ui_context, _wangp_session set):", acc)
assert acc, "FAIL: constructor would not be wrapped -> queue never pumps"
ctor(None)
print("BUILT UI OK")
h = p._iframe_html()
assert "src='data:text/html;base64," in h, "FAIL: not a data: URL iframe"
print("iframe: data: URL,", len(h), "bytes")
r = p._on_bridge('{"cmd":"save_project_json","data":{"payload":{"project_name":"x","timeline":{}}},"id":"r1"}')
print("bridge save:", r[:70])
r2 = p._on_bridge('{"cmd":"load_project_json","data":{},"id":"r2"}')
print("bridge load:", r2[:70])
print("\nALL CHECKS PASSED")
