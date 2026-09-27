#!/usr/bin/env python3
"""A grouped render must not stall when the browser page misses WanGP's queue
trigger for the next group.

WanGP only queues a job submitted from inside a click once the browser page
passes a trigger back (load_queue_trigger). For the second and later groups
that trigger rides the same stream as the progress updates. If the page misses
it, WanGP prints "queue suspended while waiting for Media Generator to get
browser focus" and the render sits there for ever.

_AdmissionWatch notices WanGP saying so and hands the trigger to the page
again, under a new value (an unchanged value fires nothing), until the job is
taken. What is checked:
  * nothing is resent while WanGP is working normally;
  * after WanGP reports it is waiting, the trigger is resent, with a new value
    each time, through WanGP's own follow-up list for that click;
  * it stops as soon as the job is taken, and gives up after a cap;
  * with no word from WanGP at all, it still resends after the fallback wait;
  * when WanGP's call cannot be found it says so instead of failing;
  * the group loop and the regen loop both use it.
When the WanGP source is next to this folder (or WAN2GP_DIR points at it), the
REAL _WrappedCallState is used, and the job attribute names are checked
against WanGP's own SessionJob, so an API change there fails here.
"""
import ast
import importlib.util
import os
import sys
import threading
import types
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(label, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + label + ("" if ok else "  -- " + str(detail)))
    if not ok:
        fails.append(label)


# ---------------------------------------------------------------- load plugin
g = types.ModuleType("gradio")


class _C:
    def __init__(s, *a, **k):
        pass


for n in ("Column", "Row", "Textbox", "Button", "HTML", "Markdown", "State", "Blocks"):
    setattr(g, n, _C)
g.update = lambda *a, **k: {}
sys.modules["gradio"] = g


class WAN2GPPlugin:
    def __init__(self, *a, **k):
        pass


shared = types.ModuleType("shared"); shared.__path__ = []
su = types.ModuleType("shared.utils"); su.__path__ = []
sp = types.ModuleType("shared.utils.plugins"); sp.WAN2GPPlugin = WAN2GPPlugin
sys.modules.update({"shared": shared, "shared.utils": su, "shared.utils.plugins": sp})
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("h3d_plugin_admission", os.path.join(HERE, "plugin.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
said = []
m.trace = lambda msg, *a, **k: said.append(str(msg))

# ------------------------------------------------ WanGP's own call state
WAN = os.environ.get("WAN2GP_DIR") or ""
for cand in (WAN, os.path.join(HERE, "..", "Wan2GP-main"), "/home/claude/wgpnew2/Wan2GP-main"):
    if cand and os.path.isfile(os.path.join(cand, "shared", "api_webui.py")):
        WAN = cand
        break
else:
    WAN = ""

State = None
if WAN:
    src = open(os.path.join(WAN, "shared", "api_webui.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "_WrappedCallState")
    ns = {"threading": threading, "Any": Any, "_NO_YIELDED_RESULT": object(), "SessionJob": object}
    exec(compile(ast.Module(body=[cls], type_ignores=[]), "api_webui", "exec"), ns)
    State = ns["_WrappedCallState"]
    api = open(os.path.join(WAN, "shared", "api.py"), encoding="utf-8").read()
    for name in ("_webui_load_queue_token", "def webui_load_queue_token", "def webui_owner_call_id",
                 "def webui_submission_ready"):
        check("WanGP SessionJob still has %s" % name.replace("def ", ""), name in api)
    check("WanGP session still looks calls up with _get_wrapped_call",
          "def _get_wrapped_call(self, call_id" in src)
    check("WanGP still forwards follow-up triggers from the call's list",
          "pop_ready_followup_load_queue_token" in src and "def add_followup_job" in src)
    check("WanGP still says 'browser focus' when it is waiting on the page", "browser focus" in src)
    print("  (using WanGP's real _WrappedCallState from %s)" % WAN)
else:
    print("  (WanGP source not found: using a stand-in for its call state)")

    class State:  # the same behaviour, reduced
        def __init__(self, n):
            self._followup_jobs = []
            self._followup_enabled = False

        def enable_followup_queue_triggers(self):
            self._followup_enabled = True

        def add_followup_job(self, job):
            if self._followup_enabled:
                self._followup_jobs.append(job)

        def pop_ready_followup_load_queue_token(self):
            for i, job in enumerate(self._followup_jobs):
                if job.webui_submission_ready:
                    self._followup_jobs.pop(i)
                    return job.webui_load_queue_token
            return ""


class Job:
    def __init__(self, token="1790391939535251400", call="call1"):
        self._webui_load_queue_token = token
        self._webui_owner_call_id = call
        self.done = False

    @property
    def webui_load_queue_token(self):
        return self._webui_load_queue_token

    @property
    def webui_owner_call_id(self):
        return self._webui_owner_call_id

    @property
    def webui_submission_ready(self):
        return True


class Session:
    def __init__(self):
        self.calls = {}

    def _get_wrapped_call(self, call_id):
        return self.calls.get(call_id)


class Ev:
    def __init__(self, kind, data):
        self.kind, self.data = kind, data


class Txt:
    def __init__(self, text):
        self.text = text


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def setup():
    owner = types.SimpleNamespace()
    owner._wangp_session = Session()
    owner._jobstate = {"log": []}
    st = State(1)
    st.enable_followup_queue_triggers()      # as after the click's first job
    owner._wangp_session.calls["call1"] = st
    job = Job()
    clk = Clock()
    return owner, st, job, clk, m._AdmissionWatch(owner, job, "Group 3", clock=clk)


def drain(st):
    out = []
    while True:
        t = st.pop_ready_followup_load_queue_token()
        if not t:
            return out
        out.append(t)


# 1. WanGP working normally: nothing is resent.
owner, st, job, clk, w = setup()
w.saw(Ev("status", Txt("Queued in WanGP...")))
clk.t += 8
w.saw(Ev("progress", types.SimpleNamespace(progress=3, phase="denoising", status="")))
for _ in range(200):
    clk.t += 1
    check_note = w.tick()
    if check_note:
        break
check("taken normally: nothing resent", not w.pokes and not drain(st), w.pokes)

# Waiting in WanGP's queue behind another job counts as taken.
owner, st, job, clk, w = setup()
w.saw(Ev("status", Txt("Waiting in WanGP queue...")))
clk.t += 100
check("waiting in WanGP's own queue: nothing resent", w.tick() == "" and not drain(st))

# 2. WanGP says it is waiting on the page: resend, with a new value each time.
owner, st, job, clk, w = setup()
w.saw(Ev("status", Txt("Queued in WanGP...")))
clk.t += 10
w.saw(Ev("status", Txt("Waiting for WanGP Media Generator to get browser focus...")))
clk.t += 2
check("not resent at once", w.tick() == "" and not drain(st))
clk.t += 3
note = w.tick()
got = drain(st)
check("resent after WanGP reports waiting", bool(note) and got == ["1790391939535251400.1"], (note, got))
check("the resend is logged for the page and the terminal",
      any("waiting for WanGP" in x["msg"] for x in owner._jobstate["log"])
      and any("Sent it again" in s for s in said) and any("click anywhere" in s for s in said))
clk.t += 10
check("not resent again straight away", w.tick() == "" and not drain(st))
clk.t += 25
note = w.tick()
got = drain(st)
check("resent again with another new value", bool(note) and got == ["1790391939535251400.2"], got)
w.saw(Ev("progress", types.SimpleNamespace(progress=1, phase="loading", status="")))
clk.t += 100
check("stops once the job is taken", w.tick() == "" and not drain(st))
check("says it was taken after the nudges", any("took the job after 2" in s for s in said))

# 3. Cap.
owner, st, job, clk, w = setup()
w.saw(Ev("status", Txt("Waiting for WanGP Media Generator to get browser focus...")))
n = 0
for _ in range(2000):
    clk.t += 5
    if w.tick():
        n += 1
check("gives up after the cap", n == m._AdmissionWatch.MAX_POKES, n)

# 4. No word from WanGP at all: still resent after the fallback wait.
owner, st, job, clk, w = setup()
clk.t += m._AdmissionWatch.FALLBACK - 1
check("fallback: not before its time", w.tick() == "")
clk.t += 2
note = w.tick()
check("fallback: resent", bool(note) and drain(st) == ["1790391939535251400.1"])

# A finished job is never touched.
owner, st, job, clk, w = setup()
w.saw(Ev("status", Txt("Waiting for WanGP Media Generator to get browser focus...")))
job.done = True
clk.t += 100
check("a finished job is left alone", w.tick() == "" and not drain(st))

# 5. WanGP's call cannot be found.
owner, st, job, clk, w = setup()
owner._wangp_session.calls.clear()
w.saw(Ev("status", Txt("Waiting for WanGP Media Generator to get browser focus...")))
clk.t += 10
note = w.tick()
check("missing call: reported, no crash", "could not" in note and any("cannot resend" in s for s in said), note)
owner2 = types.SimpleNamespace(_jobstate={})
w2 = m._AdmissionWatch(owner2, Job(), "Group 2", clock=clk)
w2.saw(Ev("status", Txt("... browser focus ...")))
clk.t += 10
check("no session at all: reported, no crash", "could not" in w2.tick())

# 6. Both render loops use it.
src = open(os.path.join(HERE, "plugin.py"), encoding="utf-8").read()
tree = ast.parse(src)
fns = {n.name: ast.get_source_segment(src, n) for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
for name in ("_run_groups", "_submit_and_wait"):
    body = fns.get(name, "")
    check("%s watches admission" % name, "_AdmissionWatch(" in body and "watch.saw(ev)" in body
          and "watch.tick()" in body)

print("\n%d failure(s)" % len(fails) if fails else "\nall admission checks passed")
sys.exit(1 if fails else 0)
