#!/usr/bin/env python3
"""Offline beat / downbeat / meter labeler for the Neural Dance Listen corpus.

This tool is NEVER shipped. It lives in a venv on the box
(.venv-listen-label) and writes nd-listen-corpus-v1 JSON next to
a WAV. madmom source is BSD; its pretrained models are CC BY-NC-SA 4.0, so
this is for offline non-commercial labeling only.

Usage:
  .venv-listen-label/bin/python tools/listen-label/label.py \\
      tests/fixtures/listen-corpus/real/foo.wav \\
      --id real-foo --meter 7/8 --grouping 3,2,2 \\
      --source-name "…" --source-url "…" --license CC0-1.0

  # Also try BeatNet, if the extra extra is installed (optional):
  …/python tools/listen-label/label.py foo.wav --backend beatnet

Backends:
  madmom   (default)  DBN beat + downbeat tracker. beats_per_bar defaults to
                      3,4,5,6,7 so odd meters are in the search space.
  beatnet  (optional) mjhydri/BeatNet offline mode (CC-BY-4.0 code; uses madmom).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import wave
from pathlib import Path

SCHEMA = "nd-listen-corpus-v1"
BAND_NAMES = ["kick", "bass", "mid", "hat"]
# Same edges as neural-dance/src/band-onsets.js LISTEN_BAND_HZ.
BAND_HZ = [(35, 90), (190, 450), (480, 4500), (5000, 14000)]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def wav_info(path: Path) -> tuple[int, float]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        return sr, n / float(sr)


def parse_meter(s: str | None):
    if not s:
        return None
    s = s.strip().replace(" ", "")
    if s in ("3+3+2", "8/8"):
        return {"label": "3+3+2", "numerator": 8, "denominator": 8, "grouping": [3, 3, 2]}
    if "/" in s:
        a, b = s.split("/", 1)
        return {"label": s, "numerator": int(a), "denominator": int(b), "grouping": None}
    raise SystemExit(f"cannot parse meter {s!r}")


def apply_grouping(meter: dict, grouping: list[int] | None):
    if grouping:
        meter["grouping"] = grouping
        if meter["label"] not in ("3+3+2",) and sum(grouping) == meter["numerator"]:
            pass
        if grouping == [3, 3, 2]:
            meter["label"] = "3+3+2"
            meter["numerator"] = 8
            meter["denominator"] = 8
    if meter.get("grouping") is None:
        if meter["label"] == "6/8":
            meter["grouping"] = [3, 3]
        elif meter["label"] == "7/8":
            meter["grouping"] = [3, 2, 2]
        elif meter["label"] == "5/4":
            meter["grouping"] = [3, 2]
        elif meter["label"] == "4/4":
            meter["grouping"] = [2, 2]
        elif meter["label"] == "3/4":
            meter["grouping"] = [3]
        else:
            meter["grouping"] = [meter["numerator"]]
    return meter


def load_audio_mono(path: Path):
    import numpy as np
    from scipy.io import wavfile

    sr, data = wavfile.read(str(path))
    if data.dtype == np.int16:
        x = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        x = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        x = (data.astype(np.float32) - 128) / 128.0
    else:
        x = data.astype(np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1)
    return sr, x


def envelope_band_hits(sr: int, audio, min_sep: float = 0.12):
    """Conservative band-limited envelope peak picker. Not the Listen detector.

    Provenance should be recorded as 'envelope-peak'. Review before treating
    these as exact ground truth.
    """
    import numpy as np
    from scipy.signal import butter, filtfilt, find_peaks

    hits = {name: [] for name in BAND_NAMES}
    ny = sr / 2.0
    for name, (lo, hi) in zip(BAND_NAMES, BAND_HZ):
        lo_n = max(lo / ny, 1e-4)
        hi_n = min(hi / ny, 0.999)
        if hi_n <= lo_n:
            continue
        b, a = butter(2, [lo_n, hi_n], btype="band")
        try:
            y = filtfilt(b, a, audio)
        except ValueError:
            continue
        env = np.abs(y)
        win = max(3, int(0.012 * sr) | 1)
        kernel = np.ones(win) / win
        env = np.convolve(env, kernel, mode="same")
        height = max(float(np.percentile(env, 90)) * 0.85, 1e-4)
        prominence = height * 0.35
        distance = max(1, int(min_sep * sr))
        peaks, _ = find_peaks(env, height=height, prominence=prominence, distance=distance)
        hits[name] = [round(p / sr, 6) for p in peaks.tolist()]
    return hits


def label_madmom(path: Path, beats_per_bar: list[int], fps: int = 100):
    from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor
    from madmom.features.downbeats import (
        DBNDownBeatTrackingProcessor,
        RNNDownBeatProcessor,
    )

    act_beats = RNNBeatProcessor()(str(path))
    beat_times = DBNBeatTrackingProcessor(fps=fps)(act_beats)
    act_down = RNNDownBeatProcessor()(str(path))
    down_proc = DBNDownBeatTrackingProcessor(beats_per_bar=beats_per_bar, fps=fps)
    numbered = down_proc(act_down)  # rows: [time, beat_number] (1-based)
    return beat_times, numbered


def label_beatnet(path: Path):
    try:
        from BeatNet.BeatNet import BeatNet
    except ImportError as e:
        raise SystemExit(
            "BeatNet is not installed. Optional extra only; madmom is the default.\n"
            "  uv pip install --python .venv-listen-label/bin/python BeatNet\n"
            f"Original import error: {e}"
        ) from e
    # Offline inference. estimator=1 is the official offline/DBN path in BeatNet.
    model = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    times = model.process(str(path))
    # times: Nx2 array of [time, beat_number_in_bar] (1 = downbeat), typically.
    import numpy as np

    arr = np.asarray(times)
    if arr.size == 0:
        return [], []
    if arr.ndim == 1:
        return arr.tolist(), []
    beat_times = arr[:, 0].tolist()
    numbered = arr.tolist()
    return beat_times, numbered


def snap_times(times, grid, tol=0.08):
    if not grid:
        return [round(t, 6) for t in times]
    out = []
    for t in times:
        best = min(grid, key=lambda g: abs(g - t))
        out.append(round(best if abs(best - t) <= tol else t, 6))
    seen, uniq = set(), []
    for t in sorted(out):
        key = round(t, 4)
        if key not in seen:
            seen.add(key)
            uniq.append(t)
    return uniq


def pulse_index(t, pulses, tol=0.08):
    if not pulses:
        return None
    best_i, best_d = None, 1e9
    for i, p in enumerate(pulses):
        d = abs(p - t)
        if d < best_d:
            best_i, best_d = i, d
    return best_i if best_d <= tol else None


def energy_phase(pulses, numerator, audio, sr):
    """Pick phase 0..N-1 whose pulse times have the most low-band energy."""
    import numpy as np
    from scipy.signal import butter, filtfilt

    if numerator <= 0 or len(pulses) < numerator or audio is None:
        return 0
    ny = sr / 2.0
    b, a = butter(2, min(120 / ny, 0.99), btype="low")
    y = filtfilt(b, a, audio)
    env = np.abs(y)
    win = max(1, int(0.03 * sr))
    scores = []
    for phase in range(numerator):
        s = 0.0
        n = 0
        for t in pulses[phase::numerator]:
            i = int(round(t * sr))
            lo, hi = max(0, i - win), min(len(env), i + win)
            s += float(env[lo:hi].mean()) if hi > lo else 0.0
            n += 1
        scores.append(s / max(n, 1))
    return int(max(range(numerator), key=lambda i: scores[i]))


def tactus_from_grouping(pulses, downbeats, grouping):
    """Metric beats: grouping onsets inside each bar, walked along the pulse grid."""
    if not pulses or not downbeats or not grouping:
        return list(pulses)
    beats = []
    for d in downbeats:
        i0 = pulse_index(d, pulses)
        if i0 is None:
            beats.append(round(d, 6))
            continue
        acc = 0
        for g in grouping:
            j = i0 + acc
            if 0 <= j < len(pulses):
                beats.append(round(pulses[j], 6))
            acc += g
    seen, uniq = set(), []
    for t in sorted(beats):
        k = round(t, 4)
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


def downbeats_from_numbered(numbered) -> list[float]:
    out = []
    for row in numbered:
        t, n = float(row[0]), float(row[1])
        if int(round(n)) == 1:
            out.append(round(t, 6))
    return out


def infer_meter_from_numbered(numbered, announced=None):
    """Infer a simple n/4 (or n/8) label from madmom/BeatNet beat numbers."""
    counts = []
    last = None
    for row in numbered:
        n = int(round(float(row[1])))
        if n == 1 and last is not None:
            counts.append(last)
        last = n
    if not counts and last is not None:
        counts.append(last)
    if not counts:
        return announced
    best = max(set(counts), key=counts.count)
    if announced:
        return announced
    if best == 8:
        return {"label": "3+3+2", "numerator": 8, "denominator": 8, "grouping": [3, 3, 2]}
    if best in (6, 7):
        grouping = [3, 3] if best == 6 else [3, 2, 2]
        return {"label": f"{best}/8", "numerator": best, "denominator": 8, "grouping": grouping}
    return {"label": f"{best}/4", "numerator": best, "denominator": 4, "grouping": None}


def choose_downbeats(pulses, numbered, meter, audio, sr):
    """Prefer announced-meter phase on the pulse grid, fallback to tracker downbeats."""
    numerator = (meter or {}).get("numerator") or 4
    announced_phase = energy_phase(pulses, numerator, audio, sr)
    energy_downs = [round(t, 6) for t in pulses[announced_phase::numerator]]
    tracked = []
    if numbered is not None and len(numbered):
        tracked = snap_times(downbeats_from_numbered(numbered), pulses)
    # Drum loops almost always start on 1. If the first pulse is near the
    # start of the file and its mean low-band energy is within 75% of the
    # best phase, prefer phase 0 even when a later accent is slightly louder.
    if pulses and pulses[0] <= 0.35 and audio is not None:
        scores = []
        ny_win = max(1, int(0.03 * sr))
        # energy_phase already picked the winner; recompute cheaply via helper.
        from math import inf
        best = energy_phase(pulses, numerator, audio, sr)
        # Rebuild scores by calling energy_phase's method: compare phase 0 vs best
        # through a second energy_phase-style pass is wasteful; use ratio of
        # mean energy already implied: if best is 0, we're done. Otherwise
        # compute both means.
        def mean_energy(phase):
            import numpy as np
            from scipy.signal import butter, filtfilt
            ny = sr / 2.0
            b, a = butter(2, min(120 / ny, 0.99), btype="low")
            y = filtfilt(b, a, audio)
            env = np.abs(y)
            win = max(1, int(0.03 * sr))
            s, n = 0.0, 0
            for t in pulses[phase::numerator]:
                i = int(round(t * sr))
                lo, hi = max(0, i - win), min(len(env), i + win)
                s += float(env[lo:hi].mean()) if hi > lo else 0.0
                n += 1
            return s / max(n, 1)
        e0, ebest = mean_energy(0), mean_energy(best)
        if best == 0 or (ebest > 0 and e0 >= 0.75 * ebest):
            return [round(t, 6) for t in pulses[0::numerator]]
    return energy_downs or tracked or ([pulses[0]] if pulses else [])


def build_label(args, beats, numbered, bands, sr, duration, sha):
    announced = parse_meter(args.meter)
    grouping = None
    if args.grouping:
        grouping = [int(x) for x in args.grouping.split(",") if x.strip()]
    if announced:
        announced = apply_grouping(announced, grouping)
    meter = infer_meter_from_numbered(numbered, announced) if numbered is not None else announced
    if meter is None:
        meter = {"label": "unknown", "numerator": 0, "denominator": 4, "grouping": []}
    else:
        meter = apply_grouping(meter, grouping or meter.get("grouping"))
    if announced:
        meter = announced

    audio, asr = args._audio
    pulses = [round(float(t), 6) for t in beats]
    down = choose_downbeats(pulses, numbered, meter, audio, asr)
    grouping = meter.get("grouping") or [meter.get("numerator") or 4]
    if meter.get("denominator") == 8 or meter.get("label") == "3+3+2":
        beat_list = tactus_from_grouping(pulses, down, grouping)
    else:
        beat_list = list(pulses)

    wav_rel = args.rel_wav or Path(args.wav).name
    label = {
        "schema": SCHEMA,
        "id": args.id or Path(args.wav).stem,
        "wav": wav_rel,
        "kind": "real",
        "license": args.license,
        "licenseUrl": args.license_url,
        "source": {
            "name": args.source_name,
            "author": args.source_author,
            "url": args.source_url,
            "notes": args.source_notes,
        },
        "seed": None,
        "sampleRate": sr,
        "channels": 1,
        "duration": round(duration, 6),
        "sha256": sha,
        "meter": meter,
        "tempo": tempo_from_beats(pulses, beat_list, meter),
        "swing": None,
        "pulses": pulses,
        "beats": beat_list,
        "downbeats": down,
        "bands": bands,
        "events": [
            {"band": i, "t": t}
            for i, name in enumerate(BAND_NAMES)
            for t in bands.get(name, [])
        ],
        "bandNames": BAND_NAMES,
        "provenance": {
            "beats": args.backend,
            "downbeats": args.backend,
            "meter": "announced" if args.meter else args.backend,
            "bands": "envelope-peak" if bands and any(bands.values()) else "unlabeled",
        },
        "degradations": [],
        "hatAudible": True,
        "regions": {},
        "notes": args.notes or "",
    }
    return label


def tempo_from_beats(pulses, beats, meter):
    import numpy as np

    # Additive meters have uneven tactus IOIs; tempo comes from the pulse grid.
    if meter and meter.get("label") == "6/8":
        grid, unit = (beats if beats and len(beats) >= 2 else pulses), "dotted-quarter"
    elif meter and (meter.get("denominator") == 8 or meter.get("label") == "3+3+2"):
        grid, unit = (pulses if pulses and len(pulses) >= 2 else beats), "eighth"
    else:
        grid, unit = (beats if beats and len(beats) >= 2 else pulses), "quarter"
    if not grid or len(grid) < 2:
        return {"kind": "constant", "bpm": None, "unit": unit}
    ioi = float(np.median(np.diff(grid)))
    bpm = 60.0 / ioi if ioi > 0 else None
    return {"kind": "constant", "bpm": None if bpm is None else round(bpm, 2), "unit": unit}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("wav", help="Input WAV (mono or stereo)")
    p.add_argument("-o", "--output", help="Output JSON path (default: alongside the WAV)")
    p.add_argument("--id", help="Clip id (default: wav stem)")
    p.add_argument("--rel-wav", help="wav field written into the JSON (repo-relative)")
    p.add_argument("--meter", help="Announced meter, e.g. 4/4, 7/8, 3+3+2. Overrides inferred meter.")
    p.add_argument("--grouping", help="Comma-separated grouping, e.g. 3,2,2")
    p.add_argument("--backend", choices=["madmom", "beatnet"], default="madmom")
    p.add_argument("--beats-per-bar", default="3,4,5,6,7", help="madmom DBN bar lengths to search")
    p.add_argument("--no-bands", action="store_true", help="Do not run the envelope-peak band picker")
    p.add_argument("--license", default="CC0-1.0")
    p.add_argument("--license-url", default="https://creativecommons.org/publicdomain/zero/1.0/")
    p.add_argument("--source-name", default="")
    p.add_argument("--source-author", default="")
    p.add_argument("--source-url", default="")
    p.add_argument("--source-notes", default="")
    p.add_argument("--notes", default="")
    args = p.parse_args(argv)

    path = Path(args.wav).resolve()
    if not path.is_file():
        raise SystemExit(f"wav not found: {path}")
    sr_hdr, duration = wav_info(path)
    sha = sha256_file(path)
    sr, audio = load_audio_mono(path)
    args._audio = (audio, sr)

    bpb = [int(x) for x in args.beats_per_bar.split(",") if x.strip()]
    if args.backend == "madmom":
        beats, numbered = label_madmom(path, bpb)
    else:
        beats, numbered = label_beatnet(path)

    bands = {"kick": [], "bass": [], "mid": [], "hat": []}
    if not args.no_bands:
        bands = envelope_band_hits(sr, audio)

    label = build_label(args, beats, numbered, bands, sr, duration, sha)
    out = Path(args.output) if args.output else path.with_suffix(".json")
    out.write_text(json.dumps(label, indent=2) + "\n")
    print(f"wrote {out}  beats={len(label['beats'])} downbeats={len(label['downbeats'])} meter={label['meter']['label']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
