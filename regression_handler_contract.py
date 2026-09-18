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

WGP = os.environ.get("WGP") or "/home/claude/wgpsrc/Wan2GP-main"
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

print()
if FAILURES:
    print("%d of %d HANDLER CONTRACT CHECK(S) FAILED" % (len(FAILURES), CHECKS))
    for f in FAILURES:
        print("  - " + f)
    print("\nWan2GP will crash at startup with this handler. Do not ship.")
    sys.exit(1)

print("ALL %d HANDLER CONTRACT CHECKS PASSED" % CHECKS)
print("(checked against %s)" % WGP)
