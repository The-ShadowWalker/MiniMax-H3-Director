#!/usr/bin/env python3
"""Guard: the hybrid handler must stay compatible with Wan2GP's handler contract.

This exists because of the v2.43.2 startup crash. Wan2GP changed
`get_lora_dir` from a 3-arg "return a resolved path" call to a 1-arg
"return a LoRA config key" call, and dropped `register_lora_cli_args`
entirely. Our handler forwarded the old shapes, so the moment the new
Wan2GP reached `get_lora_dir` while building the model dropdown, it took
the entire app's startup down.

Nothing in the plugin noticed, because the mismatch only shows up at
runtime inside Wan2GP. This guard makes it a build-time failure instead:

  1. every method we forward to the stock handler still exists there, and
     our signature can actually accept what Wan2GP will pass;
  2. `get_lora_dir` satisfies BOTH Wan2GP contracts, whichever stock
     handler it is paired with, and never raises.

Run it against the Wan2GP release you are targeting:

    WGP=/path/to/Wan2GP python3 regression_handler_contract.py
"""

from __future__ import annotations

import ast
import inspect
import os
import re
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HANDLER = os.path.join(HERE, "models", "minimax_h3_hybrid_handler.py")

# Point WGP at the Wan2GP you are running against; the default is just the
# newest tree this was last developed on.
WGP = os.environ.get("WGP") or "/home/claude/wgpnew2/Wan2GP-main"
STOCK = os.path.join(WGP, "models", "minimax_h3", "minimax_h3_handler.py")

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    print(("  OK   " if ok else "  FAIL ") + label + (("  -- " + detail) if detail and not ok else ""))
    if not ok:
        FAILURES.append(label + (("  -- " + detail) if detail else ""))


def signatures(path: str) -> dict[str, list[str]]:
    """Map method name -> parameter names, for every def in the file."""
    out: dict[str, list[str]] = {}
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            a = node.args
            params = [p.arg for p in (a.posonlyargs + a.args)]
            if a.vararg:
                params.append("*" + a.vararg.arg)
            if a.kwarg:
                params.append("**" + a.kwarg.arg)
            out.setdefault(node.name, params)
    return out


def forwarded_names(path: str) -> set[str]:
    src = open(path, encoding="utf-8").read()
    return set(re.findall(r"_stock\.family_handler\.([A-Za-z_][A-Za-z0-9_]*)", src))


def extract(names: set[str]) -> dict[str, ast.FunctionDef]:
    tree = ast.parse(open(HANDLER, encoding="utf-8").read())
    out: dict[str, ast.FunctionDef] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            out[node.name] = node
    return out


def load(func_nodes: dict[str, ast.FunctionDef], stock_cls) -> dict:
    """Compile the isolated methods with a stand-in _stock module."""
    mod = types.ModuleType("stock_mod")
    mod.family_handler = stock_cls
    g: dict = {
        "inspect": inspect,
        "os": os,
        "_stock": mod,
        "_hybrid_base": lambda bmt, *a, **k: "minimax_h3_fl2va",
    }
    for node in func_nodes.values():
        exec(compile(ast.Module(body=[node], type_ignores=[]), HANDLER, "exec"), g)
    return g


# --------------------------------------------------------------------------
# 1. every forward still lands on something that exists, with a workable arity
# --------------------------------------------------------------------------

print("Stock handler:", STOCK)
if not os.path.exists(STOCK):
    print("\nCannot find the stock MiniMax H3 handler.")
    print("Set WGP to the Wan2GP checkout you are targeting, e.g.")
    print("    WGP=/path/to/Wan2GP python3 regression_handler_contract.py")
    raise SystemExit(2)

stock_sigs = signatures(STOCK)
ours = signatures(HANDLER)
forwards = forwarded_names(HANDLER)

print("\nforwards to the stock handler (%d):" % len(forwards))

# Methods we deliberately call defensively (getattr + fallback) because the
# stock handler may or may not have them. Listed here so a disappearing
# method is a known, handled absence rather than a silent crash.
DEFENSIVE = {"register_lora_cli_args", "get_lora_dir"}

for name in sorted(forwards):
    present = name in stock_sigs
    if present:
        check("stock handler still has %s()" % name, True)
    else:
        check(
            "stock handler dropped %s() -- our forward must be defensive" % name,
            name in DEFENSIVE,
            "add a getattr()/fallback around this forward, or drop it",
        )

# --------------------------------------------------------------------------
# 2. arity: what Wan2GP passes us must bind to what we declare
# --------------------------------------------------------------------------

print("\narity vs the stock handler:")
for name in sorted(forwards):
    if name not in stock_sigs or name not in ours:
        continue
    if name in DEFENSIVE:
        continue  # handled by the contract replay below
    theirs = [p for p in stock_sigs[name] if not p.startswith("*")]
    mine = ours[name]
    if any(p.startswith("*") for p in mine):
        check("%s accepts the stock arity" % name, True)
        continue
    mine_plain = [p for p in mine if not p.startswith("*")]
    check(
        "%s accepts the stock arity" % name,
        len(mine_plain) >= len(theirs),
        "wgp/stock passes %d (%s), we declare %d (%s)"
        % (len(theirs), ", ".join(theirs), len(mine_plain), ", ".join(mine_plain)),
    )

# --------------------------------------------------------------------------
# 3. get_lora_dir must satisfy BOTH Wan2GP contracts and never raise
# --------------------------------------------------------------------------

print("\nget_lora_dir contract replay:")

nodes = extract({"get_lora_dir", "register_lora_cli_args"})
if "get_lora_dir" not in nodes:
    check("handler defines get_lora_dir", False, "method not found")
else:

    class StockNew:
        """Current contract: one arg, returns a LoRA config key."""

        @staticmethod
        def get_lora_dir(base_model_type):
            return "minimax_h3"

    class StockLegacy:
        """Pre-2026 contract: three args, returns a resolved path."""

        @staticmethod
        def get_lora_dir(base_model_type, args, lora_root):
            return os.path.join(lora_root, "minimax_h3")

        @staticmethod
        def register_lora_cli_args(parser, lora_root):
            return "registered"

    class StockGone:
        """Stock dropped the method entirely."""

    class FakeArgs:
        lora_config = None

    for stock_name, stock in [("new stock", StockNew), ("legacy stock", StockLegacy), ("stock w/o method", StockGone)]:
        g = load(nodes, stock)
        get_dir = g["get_lora_dir"]

        # --- replay new Wan2GP (wgp.py get_lora_dir) exactly ---
        try:
            inspect.signature(get_dir).bind("minimax_h3_hybrid")
            bound = True
        except TypeError:
            bound = False
        check(
            "new wgp: 1-arg probe binds (%s)" % stock_name,
            bound,
            "probe fails -> wgp falls back to the 3-arg call that caused the v2.43.2 crash",
        )
        if bound:
            try:
                key = get_dir("minimax_h3_hybrid")
                ok = isinstance(key, str) and key and os.sep not in key and "/" not in key
                check(
                    "new wgp: returns a bare LoRA key (%s)" % stock_name,
                    ok,
                    "got %r -- wgp feeds this to resolve_lora_dir, so it must be a key, not a path" % (key,),
                )
            except Exception as exc:
                check("new wgp: call does not raise (%s)" % stock_name, False, "%s: %s" % (type(exc).__name__, exc))

        # --- replay the legacy 3-arg fallback ---
        try:
            path = get_dir("minimax_h3_hybrid", FakeArgs, "loras")
            check(
                "legacy wgp: returns a path (%s)" % stock_name,
                isinstance(path, str) and bool(path),
                "got %r" % (path,),
            )
        except Exception as exc:
            check("legacy wgp: call does not raise (%s)" % stock_name, False, "%s: %s" % (type(exc).__name__, exc))

    # register_lora_cli_args must tolerate the method being gone
    if "register_lora_cli_args" in nodes:
        for stock_name, stock in [("legacy stock", StockLegacy), ("new stock", StockNew), ("stock w/o method", StockGone)]:
            g = load(nodes, stock)
            try:
                g["register_lora_cli_args"](object(), "loras")
                check("register_lora_cli_args survives %s" % stock_name, True)
            except Exception as exc:
                check(
                    "register_lora_cli_args survives %s" % stock_name,
                    False,
                    "%s: %s" % (type(exc).__name__, exc),
                )

# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# A method the STOCK handler has gained.
#
# The checks above compare the methods the Hybrid already defines. They cannot
# see a method upstream ADDED, which is the more dangerous shape: wgp.py calls
# most handler methods through getattr(..., None), so a Hybrid missing one is
# not an error -- the behaviour simply never happens, with nothing in the log.
# That is how the 2026-09-20 "Auto" Video VAE would have quietly fallen back to
# the original VAE on the Hybrid only.
print("\nmethods the stock handler has:")


def class_methods(path, cls):
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == cls:
            return {m.name for m in node.body if isinstance(m, ast.FunctionDef)}
    return set()


stock_methods = class_methods(STOCK, "family_handler")
hybrid_methods = class_methods(HANDLER, "family_handler")
# Private helpers are upstream's business; the Hybrid only has to keep up with
# the public contract wgp.py actually reaches for.
missing = sorted(m for m in stock_methods - hybrid_methods if not m.startswith("_"))
check("the Hybrid handles every method the stock handler offers", not missing,
      "stock has, Hybrid does not: " + ", ".join(missing) +
      " -- forward it, or add it to KNOWN_NOT_FORWARDED with the reason")
print("       %d stock methods, %d on the Hybrid" % (len(stock_methods), len(hybrid_methods)))

# --------------------------------------------------------------------------
# The model's own option groups must NOT be typed out in the UI.
#
# The Text Encoder / Video VAE / DiT priority dropdowns were once three
# hardcoded lists. They went stale the moment upstream added the INT8 ConvRot
# VAE and renamed the default to "Auto", and they were built on a fixed
# slot->meaning assumption that is not true: in this very file system_configs2
# is the Video VAE in one branch and the DiT priority in another. They are now
# read from the model at runtime. This makes sure they stay that way.
print("\nmodel option groups:")
ui_src = open(os.path.join(HERE, "webui", "src", "lib", "types.ts"), encoding="utf-8").read()
stage_src = open(os.path.join(HERE, "webui", "src", "components", "Stage.tsx"), encoding="utf-8").read()
plugin_src = open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read()
session_src = open(os.path.join(HERE, "webui", "src", "lib", "session.ts"), encoding="utf-8").read()

for gone in ("TEXT_ENCODER_CHOICES", "VIDEO_VAE_CHOICES", "PRIORITY_CHOICES"):
    check("%s is not typed out in the UI any more" % gone,
          gone not in ui_src and gone not in stage_src,
          "a hardcoded list goes stale the next time upstream adds an option")

check("the relay reads the groups from the model definition",
      "_config_groups" in plugin_src and "CONFIG_GROUP_KEYS" in plugin_src)
check("and hands them to the UI with the model list",
      '"config_groups"' in plugin_src)
check("the UI sends the choice back keyed by group",
      "model_configs" in session_src,
      "sending by slot POSITION would land options in the wrong group")
check("and the relay turns it into Wan2GP's own `config` string",
      '_config_selection' in plugin_src and 'st["config"]' in plugin_src)

# Wan2GP's own slot order has to match what the relay assumes.
groups_py = os.path.join(WGP, "shared", "config_groups.py")
if os.path.exists(groups_py):
    src = open(groups_py, encoding="utf-8").read()
    sys_keys = re.search(r"SYSTEM_CONFIG_KEYS\s*=\s*\(([^)]*)\)", src)
    user_key = re.search(r'USER_CONFIG_KEY\s*=\s*"([^"]+)"', src)
    if sys_keys and user_key:
        upstream = tuple(re.findall(r'"([^"]+)"', sys_keys.group(1))) + (user_key.group(1),)
        ours = re.search(r"CONFIG_GROUP_KEYS\s*=\s*\(([^)]*)\)", plugin_src)
        mine = tuple(re.findall(r'"([^"]+)"', ours.group(1))) if ours else ()
        check("the relay's slot order matches Wan2GP's", mine == upstream,
              "Wan2GP: %s   relay: %s" % (str(upstream), str(mine)))
        print("       slots: " + ", ".join(upstream))
    else:
        check("Wan2GP's config slot order could be read", False,
              "shared/config_groups.py changed shape")
else:
    print("       (shared/config_groups.py not present -- older Wan2GP)")

print()
if FAILURES:
    print("%d of %d HANDLER CONTRACT CHECK(S) FAILED" % (len(FAILURES), CHECKS))
    for f in FAILURES:
        print("  - " + f)
    print("\nWan2GP will crash at startup with this handler. Do not ship.")
    sys.exit(1)

print("ALL %d HANDLER CONTRACT CHECKS PASSED" % CHECKS)
print("(checked against %s)" % WGP)
