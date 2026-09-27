"""What a grouped render has finished, kept so a crash costs one group, not all.

A grouped render writes each finished group as a MASTER clip -- trimmed to its
exact slot on the timeline and stored losslessly -- and then records it in
render.json. The record is what Continue works from after a crash, a reboot or
a cancel: it says which groups are done, on which seed, from which inputs.

Two rules keep a resumed piece identical to one that ran straight through:

  * Nothing is trusted on its word. Every finished group is re-checked before
    Continue uses it: the file is there, it has the frame count it was written
    with, and the prompts, media and settings that made it have not changed
    since. The first group that fails a check is re-rendered, and so is
    everything after it, because each group continues from the one before.

  * Nothing is recorded before it is safely on disk. A master is written under
    a temporary name, flushed, and only then renamed into place; the record is
    updated after that, flushed and renamed the same way. A reboot mid-group
    can lose that group, never a finished one, and never leaves the record
    pointing at half a file.

This module has no Wan2GP or Gradio imports, so it can be tested on its own.
"""
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

RECORD_VERSION = 1

# Plan keys that do not decide what a finished group LOOKS like. They are
# compared some other way (the layout, the seed), belong to one group rather
# than all of them (the prompt, the media), or only steer how the run is
# carried out (group size, releasing the model, holding the look).
NOT_SHARED = frozenset({
    "prompt", "window_prompts", "media", "numbering_offset", "injected_count",
    "seed", "video_length", "manual_windows", "window_frames",
    "group_windows", "release_between_groups", "hold_look_between_groups",
})


# ---------------------------------------------------------------- hashing
def _canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str)


def short_hash(obj):
    return hashlib.sha256(_canon(obj).encode("utf-8")).hexdigest()[:16]


def shared_hashes(plan):
    """One hash per setting that applies to every group, keyed by name, so a
    mismatch can say WHICH setting changed rather than just that one did."""
    return {k: short_hash(v) for k, v in (plan or {}).items() if k not in NOT_SHARED}


def group_hash(pg):
    """The inputs that belong to ONE group: its own prompt blocks, the media it
    is sent (a middle group has no start or end image) and the picture-number
    shift that goes with that media."""
    return short_hash({
        "prompt": pg.get("prompt") or "",
        "media": pg.get("media") or {},
        "numbering_offset": pg.get("numbering_offset"),
    })


def file_sha256(path, block=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(block), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- disk safety
def fsync_file(path):
    """Force a finished file out of the OS write cache. A hard reboot throws
    away anything still sitting there, and the reboots are what this is for."""
    try:
        fd = os.open(str(path), os.O_RDWR | getattr(os, "O_BINARY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def fsync_dir(path):
    """Make a rename durable. POSIX only -- Windows cannot open a directory
    for this and does not need it for NTFS renames to survive."""
    if os.name == "nt":
        return
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def replace_retry(src, dst, tries=20, wait=0.25):
    """os.replace, patient about Windows.

    On Windows a rename fails with PermissionError while anything else holds
    the target open -- Defender or the search indexer scanning a file that
    just appeared, or the resume card reading render.json at that moment.
    Those holds last a moment, so wait and try again rather than give up on
    recording the render.
    """
    for i in range(tries):
        try:
            os.replace(str(src), str(dst))
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(wait)


def write_record(path, rec):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    replace_retry(tmp, path)
    fsync_dir(path.parent)


def load_record(path, app=None):
    path = Path(path)
    if not path.is_file():
        return None
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(rec, dict) or rec.get("version") != RECORD_VERSION:
        return None
    if app and rec.get("app") not in (None, app):
        return None
    if not isinstance(rec.get("groups"), list):
        rec["groups"] = []
    return rec


def new_record(app, seed, fps, ovl, window_frames, per_group, shared):
    return {
        "version": RECORD_VERSION, "app": app, "status": "running",
        "seed": int(seed), "fps": float(fps), "overlap": int(ovl),
        "window_frames": [int(x) for x in window_frames],
        "group_size": int(per_group), "shared": dict(shared),
        "groups": [], "joined": None,
    }


# ---------------------------------------------------------------- ffmpeg
def probe_streams(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries",
         "stream=index,codec_type,pix_fmt,sample_rate,channels", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=120)
    try:
        return json.loads(out.stdout or "{}").get("streams") or []
    except Exception:
        return []


class ProbeError(RuntimeError):
    """ffprobe could not read a file. Not the same as the file being bad:
    antivirus holding it, or ffprobe missing, must never be taken as
    "damaged" -- that would throw away finished work."""


def count_frames(ffprobe, path):
    """Frames in the first video stream, counted from the container's packets.
    Exact for these files (one packet per frame) and nothing is decoded.
    Durations are not used -- Matroska rounds timestamps to the millisecond,
    which at 24fps is enough to lose or gain a frame in the arithmetic.

    Raises ProbeError when ffprobe itself fails. A readable file with no
    video frames counts as 0."""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets",
             "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProbeError("ffprobe could not run on %s: %s" % (Path(path).name, exc))
    txt = (out.stdout or "").strip().split("\n")[0].strip().rstrip(",")
    if out.returncode != 0 and not txt:
        # A truncated Matroska file still demuxes up to the damage and
        # returns 0; a non-zero exit with nothing counted is ffprobe failing.
        raise ProbeError("ffprobe failed on %s: %s"
                         % (Path(path).name, (out.stderr or "").strip()[:200]))
    try:
        return int(txt)
    except ValueError:
        return 0


def make_master(ffmpeg, ffprobe, src, dst, head, frames, fps):
    """Cut one group's slot out of its render, losslessly.

    `head` frames come off the front (the overlap carried from the group before
    it, which this group regenerated) and exactly `frames` are kept, so the
    master's length IS its slot on the timeline. The cut is by frame index, not
    by time, so it cannot land a frame early or late.

    FFV1 keeps every pixel exactly as Wan2GP produced it, in the source's own
    pixel format, with a checksum on every slice so damage is detectable later.
    The audio is decoded once to 24-bit PCM, so it is not re-compressed either.
    Returns the frame count of what was written.
    """
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    streams = probe_streams(ffprobe, src)
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError("%s has no video stream" % src.name)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    pix = video.get("pix_fmt") or "yuv420p"
    head, frames, fps = int(head), int(frames), float(fps)

    tmp = dst.with_name(dst.stem + ".partial" + dst.suffix)
    cmd = [ffmpeg, "-y", "-v", "error", "-i", str(src),
           "-map", "0:v:0",
           "-vf", "trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS" % (head, head + frames),
           "-c:v", "ffv1", "-level", "3", "-g", "1", "-slicecrc", "1", "-pix_fmt", pix]
    if has_audio:
        cmd += ["-map", "0:a:0",
                "-af", "atrim=start=%.6f:end=%.6f,asetpts=PTS-STARTPTS"
                       % (head / fps, (head + frames) / fps),
                "-c:a", "pcm_s24le"]
    cmd += ["-f", "matroska", str(tmp)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
        fsync_file(tmp)
        replace_retry(tmp, dst)
        fsync_dir(dst.parent)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return count_frames(ffprobe, dst)


def _carry_cut(ffmpeg, ffprobe, master, start, end, fps, out):
    """Frames [start, end) of a master, WITH their sound, for the next group
    (or a regen) to continue from.

    The sound matters as much as the picture. WanGP hands a continuation
    source's audio to H3 as the audio of the carried frames, exactly as it
    does between sliding windows inside one job. Without it the model makes
    up the overlap's sound blind, and the next clip's audio starts its own
    way -- a phrase or beat that repeats at the join while the picture runs
    on smoothly. WanGP also puts that same audio back in front of what it
    generates, so the render still lines up with its frames, and the overlap
    is cut off it like before.

    Picture: lossless H.264. Sound: cut to exactly the same frames' span."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        has_audio = any(st.get("codec_type") == "audio" for st in probe_streams(ffprobe, master))
    except Exception:
        has_audio = False
    fps = float(fps)
    cmd = [ffmpeg, "-y", "-v", "error", "-i", str(master), "-map", "0:v:0",
           "-vf", "trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS" % (start, end),
           "-c:v", "libx264", "-crf", "0", "-preset", "veryfast",
           "-pix_fmt", "yuv420p", "-r", "%g" % fps]
    if has_audio:
        cmd += ["-map", "0:a:0",
                "-af", "atrim=start=%.6f:end=%.6f,asetpts=PTS-STARTPTS,apad,atrim=end=%.6f"
                       % (start / fps, end / fps, (end - start) / fps),
                "-c:a", "aac", "-b:a", "320k"]
    else:
        cmd += ["-an"]
    cmd += [str(out)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=1800)
    return str(out)


def master_tail(ffmpeg, ffprobe, master, n, fps, out):
    """The last `n` frames of a master, with their sound, for the next group
    to continue from.

    Cut by frame index for the same reason as the master itself, so a resumed
    group starts from exactly the pixels -- and the sound -- it would have had
    if the run had never stopped.
    """
    total = count_frames(ffprobe, master)
    n = max(1, min(int(n), total))
    return _carry_cut(ffmpeg, ffprobe, master, total - n, total, fps, out)


def master_frames_at(ffmpeg, ffprobe, master, n, end_offset, fps, out):
    """`n` frames of a master ending `end_offset` frames before its end, with
    their sound.

    A regen that has to start a few frames early (to land exactly on the next
    clip) continues from frames a little before the previous clip's end, so
    its carried frames are taken from there, by frame index."""
    total = count_frames(ffprobe, master)
    end = max(1, total - int(end_offset))
    n = max(1, min(int(n), end))
    return _carry_cut(ffmpeg, ffprobe, master, end - n, end, fps, out)


def first_frame_png(ffmpeg, master, out, index=0):
    """Frame `index` of a clip (the first, by default), losslessly, for a
    regen to land on."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(master),
                    "-vf", "select=eq(n\\,%d)" % int(index), "-frames:v", "1", str(out)],
                   check=True, capture_output=True, timeout=300)
    return str(out)


def stretches(indices):
    """Consecutive runs: [1, 2, 4, 6, 7] -> [[1, 2], [4], [6, 7]]. Marked clips
    next to each other are regenerated as ONE piece, so the join between them
    is made the same way a continuous render makes it."""
    runs = []
    for i in sorted(set(int(x) for x in indices)):
        if runs and i == runs[-1][-1] + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


# ---------------------------------------------------------------- checking
def check(rec, cur, frames_of, group_hash_for, renders_dir):
    """How much of a recorded render can be kept, measured against the plan
    as it is NOW.

    `cur` holds the current layout: window_frames, overlap, fps, seed (-1 for
    random), shared (from shared_hashes). `frames_of(path)` counts a file's
    frames. `group_hash_for(first_window, n_windows, group_index)` computes the
    hash the CURRENT plan gives those windows. Masters are named relative to
    `renders_dir`, so a project unpacked on another machine still resolves.

    Groups are checked in order and the first failure stops the walk: every
    group continues from the one before it, so nothing after a changed or
    damaged group can be kept either.
    """
    out = {"has_record": bool(rec), "status": (rec or {}).get("status"),
           "kept": [], "reason": None, "notes": [], "recorded": 0,
           "seed": (rec or {}).get("seed")}
    if not rec:
        return out
    groups = rec.get("groups") or []
    out["recorded"] = len(groups)
    if not groups:
        return out

    if int(cur.get("overlap") or 0) != int(rec.get("overlap") or 0):
        out["reason"] = ("the overlap changed (%s -> %s frames) since those groups were rendered"
                         % (rec.get("overlap"), cur.get("overlap")))
        return out
    if abs(float(cur.get("fps") or 0) - float(rec.get("fps") or 0)) > 1e-6:
        out["reason"] = "the frame rate changed since those groups were rendered"
        return out
    want_seed = int(cur.get("seed") if cur.get("seed") is not None else -1)
    if want_seed >= 0 and want_seed != int(rec.get("seed", -1)):
        out["reason"] = ("the seed changed (%s -> %s); the finished groups were made on %s"
                         % (rec.get("seed"), want_seed, rec.get("seed")))
        return out
    was, now = rec.get("shared") or {}, cur.get("shared") or {}
    changed = sorted(k for k in set(was) | set(now) if was.get(k) != now.get(k))
    if changed:
        out["reason"] = ("settings that apply to every group changed: %s"
                         % ", ".join(changed[:8]) + (" ..." if len(changed) > 8 else ""))
        return out

    wf = [int(x) for x in cur.get("window_frames") or []]
    expect_w0 = 0
    for gi, g in enumerate(groups):
        label = "group %d" % (gi + 1)
        w0, n = int(g.get("first_window", -1)), int(g.get("n_windows", 0))
        wins = [int(x) for x in g.get("windows") or []]
        if w0 != expect_w0:
            # Groups must follow on from each other with nothing missing in
            # between, or Continue would skip the windows of the gap.
            out["reason"] = "the render record has a gap before %s" % label
            break
        if n <= 0 or wf[w0:w0 + n] != wins:
            out["reason"] = "the windows under %s were changed on the timeline" % label
            break
        path = Path(renders_dir) / str(g.get("master") or "")
        if not g.get("master") or not path.is_file():
            out["reason"] = "%s's clip is missing from the workspace" % label
            break
        if g.get("bytes") is not None and path.stat().st_size == int(g["bytes"]):
            # Written, flushed and renamed into place whole, and still exactly
            # the size it was then: counting its frames would mean reading
            # gigabytes to learn nothing new.
            got = int(g.get("frames_got", -1))
        else:
            try:
                got = frames_of(path)
            except ProbeError as exc:
                # Not the clip's fault, so nothing is judged and nothing is
                # removed: Continue stops and says why instead.
                out["error"] = "could not check %s's clip (%s)" % (label, exc)
                out["reason"] = out["error"]
                break
        if got != int(g.get("frames_got", -1)):
            out["reason"] = ("%s's clip is damaged or incomplete (%d frame(s) on disk, %s written)"
                             % (label, got, g.get("frames_got")))
            break
        if group_hash_for(w0, n, gi) != g.get("hash"):
            out["reason"] = "the prompt or media for %s changed since it was rendered" % label
            break
        if int(g.get("frames_got", 0)) != int(g.get("frames", 0)):
            out["notes"].append("%s came back %+d frame(s) from its slot when it was rendered"
                                % (label, int(g["frames_got"]) - int(g["frames"])))
        out["kept"].append(g)
        expect_w0 = w0 + n
    return out
