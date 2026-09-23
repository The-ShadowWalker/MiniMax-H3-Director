#!/usr/bin/env python3
"""The log has to survive the machine going down.

A render that reboots the PC leaves no traceback and no console -- Python
cannot restart a machine, so whatever happened is below the application, and
the only evidence is whatever reached the disk before the power cut. That
means every line flushed as it is written, not buffered.
"""
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


sys.modules.setdefault("gradio", types.ModuleType("gradio"))
for n in ("shared", "shared.utils"):
    sys.modules.setdefault(n, types.ModuleType(n))
_m = types.ModuleType("shared.utils.plugins")
_m.WAN2GPPlugin = object
sys.modules["shared.utils.plugins"] = _m

spec = importlib.util.spec_from_file_location("h3d_crashlog", os.path.join(HERE, "plugin.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

check("the plugin opens a log file", mod.LOG_FILE.exists(), str(mod.LOG_FILE))

marker = "crash-log probe %d" % os.getpid()
mod.trace(marker)
# Read it back with the handler still OPEN. That is the crash case: nothing
# closed the file, nothing ran at exit, the machine simply stopped.
try:
    body = open(mod.LOG_FILE, encoding="utf-8").read()
except Exception as exc:
    body = ""
    check("the log can be read while the plugin still holds it", False, str(exc))
check("a line is on disk the moment it is written", marker in body,
      "the line was still in a buffer -- a hard reset would have lost it")

handlers = [type(h).__name__ for h in mod.log.handlers]
check("the terminal still gets everything too",
      any("StreamHandler" == h for h in handlers), str(handlers))
check("and the file handler flushes rather than buffering",
      any("Flushing" in h for h in handlers), str(handlers))

src = open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read()
check("the previous run is kept, not overwritten",
      "LOG_FILE.replace(LOG_FILE_PREV)" in src,
      "a crash followed by a restart would erase the evidence of the crash")
check("a workspace it cannot write to does not stop the plugin",
      "could not open the crash log" in src)
check("the machine and GPU are recorded at startup",
      'trace("machine: %s' in src and 'trace("gpu: %s"' in src,
      "a crash report without the hardware in it is half a report")
check("power, temperature and clocks are logged as it renders",
      "_gpu_health" in src and "power.draw" in src,
      "a reboot under load is power or heat, and neither is in a traceback")
check("and they sit on the per-window line",
      "self._vram_note(), self._gpu_health()" in src)

print()
if fails:
    print("%d CRASH-LOG CHECK(S) FAILED" % len(fails))
    sys.exit(1)
print("ALL CRASH-LOG CHECKS PASSED")
