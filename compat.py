"""Which Wan2GP this is, and the code each Wan2GP version needs.

H3 Director has to run on the Wan2GP you have, not only the newest one. When
Wan2GP changes something this plugin depends on, the fix goes in here as a new
PROFILE for that version, next to the profiles for the versions before it --
nothing older is edited or removed. At startup the plugin reads Wan2GP's
version and uses the profile for it:

  * a known version gets its own profile;
  * a version between two known ones gets the newest profile at or below it;
  * a version NEWER than any known profile gets the newest profile, and says so;
  * a version that cannot be read gets the newest profile, and says so.

Where the plugin rewrites Wan2GP source (the Hybrid model's pipeline), the
version is only the first guess: every profile is tried, the chosen one
first, and the first that fits the installed source exactly is used. So a
build that has not bumped its version number, or a patched one, still works,
and the log says which profile actually applied.

To support a new Wan2GP: add a profile at the END of PROFILES with the new
`since` version and only what changed, then add that Wan2GP to the tests.
"""

import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# The profiles, oldest first. Each one lists what differs for Wan2GP versions
# from `since` onward. Keys a profile does not set are inherited from the one
# before it, so a new profile only has to say what changed.
# ---------------------------------------------------------------------------
PROFILES = [
    {
        "since": (0, 0),
        "name": "13.13 and earlier",
        # MiniMaxH3Pipeline.generate(): the two conditions the Hybrid takes
        # over. `literal` fragments are regexes; each must match exactly once.
        "hybrid_audio_reference_gate": (
            r'if\s+self\.reference_mode\s+and\s+'
            r'(?:self\.fixed_prompt\s+is\s+None\s+and\s+)?'
            r'(?:not\s+refinement_mode\s+and\s+)?'
            r'"A"\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)\s*:'
        ),
        "hybrid_target_audio_gate": (
            r'if\s+(?:\(\s*refinement_mode\s+or\s+not\s+self\.reference_mode'
            r'(?:\s+or\s+self\.fixed_prompt\s+is\s+not\s+None)?\s*\)'
            r'|not\s+self\.reference_mode)\s+and\s+'
            r'any\(\s*flag\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)\s+'
            r'for\s+flag\s+in\s+"AK"\s*\)\s+'
            r'and\s+waveform\s+is\s+not\s+None\s*:'
        ),
        # audio_prompt_type letters this Wan2GP understands
        "audio_letters": "ABK2",
        # video_prompt_type reference-video modes, longest first
        "video_ref_modes": ("V+-U", "V-U"),
    },
    {
        "since": (13, 14),
        "name": "13.14",
        # 13.14 added its own "S" (keep the audio as the soundtrack) flag to
        # both conditions.
        "hybrid_audio_reference_gate": (
            r'if\s+self\.reference_mode\s+and\s+'
            r'(?:self\.fixed_prompt\s+is\s+None\s+and\s+)?'
            r'(?:not\s+refinement_mode\s+and\s+)?'
            r'"A"\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)'
            r'\s+and\s+not\s+soundtrack\s*:'
        ),
        "hybrid_target_audio_gate": (
            r'if\s+\(\s*refinement_mode\s+or\s+soundtrack\s+or\s+not\s+self\.reference_mode'
            r'(?:\s+or\s+self\.fixed_prompt\s+is\s+not\s+None)?\s*\)\s+and\s+'
            r'any\(\s*flag\s+in\s+\(\s*audio_prompt_type\s+or\s+""\s*\)\s+'
            r'for\s+flag\s+in\s+"AK"\s*\)\s+'
            r'and\s+waveform\s+is\s+not\s+None\s*:'
        ),
        # D = third audio guide, S = keep as soundtrack, 1 = excerpts
        "audio_letters": "ABDKS12",
        # three reference videos, and excerpts from one
        "video_ref_modes": ("V+*-U", "V1-U", "V+-U", "V-U"),
    },
]


def _resolved(i):
    """Profile i with everything it inherits from the ones before it."""
    out = {}
    for p in PROFILES[:i + 1]:
        out.update(p)
    return out


def parse_version(text):
    """"13.14" -> (13, 14); anything unreadable -> None."""
    m = re.match(r"\s*v?(\d+)(?:\.(\d+))?", str(text or ""))
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2) or 0))


def detect_version(wgp_root=None):
    """(version tuple or None, how it was found).

    The running Wan2GP registers itself as the `wgp` module, so its
    WanGP_version is read from there. Outside Wan2GP (the tests, or a
    plugin loaded early) wgp.py is read from disk instead.
    """
    mod = sys.modules.get("wgp")
    v = parse_version(getattr(mod, "WanGP_version", None)) if mod is not None else None
    if v:
        return v, "wgp.WanGP_version"
    roots = [wgp_root] if wgp_root else []
    if mod is not None and getattr(mod, "__file__", None):
        roots.append(Path(mod.__file__).resolve().parent)
    roots += [os.environ.get("WAN2GP_DIR"), os.getcwd()]
    for root in roots:
        if not root:
            continue
        f = Path(root) / "wgp.py"
        try:
            head = f.read_text(encoding="utf-8", errors="ignore")[:20000] if f.is_file() else ""
        except OSError:
            head = ""
        m = re.search(r'^WanGP_version\s*=\s*["\']([^"\']+)["\']', head, re.M)
        if m and parse_version(m.group(1)):
            return parse_version(m.group(1)), str(f)
    return None, "not found"


def profile_index_for(version):
    """Index of the profile for `version`: the newest one at or below it."""
    if version is None:
        return len(PROFILES) - 1
    best = 0
    for i, p in enumerate(PROFILES):
        if tuple(p["since"]) <= tuple(version):
            best = i
    return best


def profile_for(version):
    return _resolved(profile_index_for(version))


def candidates(version):
    """Every profile, the one for `version` first, then newest to oldest."""
    first = profile_index_for(version)
    order = [first] + [i for i in range(len(PROFILES) - 1, -1, -1) if i != first]
    return [_resolved(i) for i in order]


def describe(version, how=""):
    """One line for the log: what was found and what will be used."""
    p = profile_for(version)
    newest = tuple(PROFILES[-1]["since"])
    if version is None:
        return ("Wan2GP version could not be read (%s); using the newest compatibility "
                "profile (%s)" % (how or "unknown", p["name"]))
    vs = "%d.%d" % version
    if tuple(version) > newest and len(PROFILES) > 1:
        return ("Wan2GP %s is newer than any this plugin knows; using the newest "
                "compatibility profile (%s) - if something fails, the log says what" % (vs, p["name"]))
    return "Wan2GP %s detected; compatibility profile %s" % (vs, p["name"])


_STATE = {}


def current():
    """(version, profile, log line), worked out once per process."""
    if "profile" not in _STATE:
        v, how = detect_version()
        _STATE.update(version=v, how=how, profile=profile_for(v), line=describe(v, how))
    return _STATE["version"], _STATE["profile"], _STATE["line"]


def reset():
    """Forget the cached answer (tests)."""
    _STATE.clear()
