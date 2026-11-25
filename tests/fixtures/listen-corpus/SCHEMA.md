# nd-listen-corpus-v1

Offline regression corpus for Neural Dance Listen v2 (beat-pattern learning).
The pattern-learning worktree (`feat/listen-pattern`, worker `3d6330b1`) should
consume clips from this folder by path and this JSON format.

Times are **seconds** from the start of the sibling WAV. WAVs are 16-bit PCM
mono, 48 kHz. Band indices match the live Listen detectors: `0 kick`, `1 bass`,
`2 mid` (snare), `3 hat`.

## Layout

```
tests/fixtures/listen-corpus/
  manifest.json          # index of every clip
  SCHEMA.md              # this file
  README.md              # how to generate, label, and score
  synthetic/<id>.wav     # deterministic generated grooves
  synthetic/<id>.json    # exact ground truth
  real/SOURCES.md        # license + attribution for real recordings
  real/<id>.wav
  real/<id>.json
  baseline/results.md    # current per-band + legacy scores
  baseline/results.json
```

## JSON fields

```json
{
  "schema": "nd-listen-corpus-v1",
  "id": "syn-7-8-322-210",
  "wav": "synthetic/syn-7-8-322-210.wav",
  "kind": "synthetic",
  "license": "CC0-1.0",
  "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
  "source": {"name": "…", "author": "…", "url": "…", "notes": "…"},
  "seed": 78210,
  "sampleRate": 48000,
  "channels": 1,
  "duration": 16.0,
  "sha256": "…",
  "meter": {
    "label": "7/8",
    "numerator": 7,
    "denominator": 8,
    "grouping": [3, 2, 2]
  },
  "tempo": {
    "kind": "constant",
    "bpm": 210,
    "unit": "eighth"
  },
  "swing": null,
  "pulses": [0.5, 0.786, 1.071],
  "beats": [0.5, 1.357, 1.929],
  "downbeats": [0.5, 2.5],
  "bands": {"kick": [0.5], "bass": [0.5], "mid": [1.357], "hat": [0.5, 0.786]},
  "events": [{"band": 0, "t": 0.5}],
  "bandNames": ["kick", "bass", "mid", "hat"],
  "provenance": {
    "beats": "synthetic-exact",
    "downbeats": "synthetic-exact",
    "meter": "announced",
    "bands": "synthetic-exact"
  },
  "degradations": [],
  "hatAudible": true,
  "regions": {"breaks": [], "fills": []},
  "notes": ""
}
```

### Timing arrays

- `pulses` — isochronous (or swung, when `swing` is set) counting pulse at the
  meter’s denominator, except in 6/8 where pulses are the six eighths.
- `beats` — the tactus you would tap. Equal quarters in 3/4, 4/4, and 5/4;
  two dotted-quarters per bar in 6/8; the **uneven grouping onsets** in 7/8
  (`3+2+2`) and `3+3+2`.
- `downbeats` — start of each bar (score unit 0 of that bar).
- `bands.*` / `events` — per-band hit times. For synthetic clips these are
  exact. For real clips they are `envelope-peak` proposals (see provenance)
  and should not be treated as hand-audited truth.

Beats and downbeats **continue through breaks**. Band hits do not.

### `tempo.kind`

- `constant` — `bpm` + `unit` (`quarter`, `eighth`, or `dotted-quarter`)
- `linear-drift` — `bpmStart`, `bpmEnd`, `units` (score length of the drift)
- `rubato` — sinusoidal instantaneous-BPM wander (`depth`, `periodUnits`, `phi`)
- `step` — piecewise constant, `steps: [{u, bpm}, …]` in score units

`swing` is `null` or `{ratio: [2, 1], label: "2:1"}` (or `[3, 2]`). The ratio
is long:short for a pair of eighths inside a quarter.

### `degradations` and `hatAudible`

Phone-mic clips list some of `room-reverb`, `phone-mic-100-8k`,
`phone-mic-100-5k`, `noise`, `lowpass-5k`. When `hatAudible` is `false`, hat
energy was removed (5 kHz low-pass, matching the iPhone hat-zero finding);
hat times are still labeled so a detector’s miss can be measured.

### `provenance`

| value             | meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `synthetic-exact` | taken from the generator’s score                     |
| `announced`       | taken from the recording’s author/description        |
| `madmom`          | offline madmom DBN                                   |
| `beatnet`         | optional BeatNet backend                             |
| `envelope-peak`   | band-limited envelope peaks, not the Listen detector |
| `unlabeled`       | empty array                                          |
| `manual`          | hand-edited                                          |

## Detector interface (for metrics)

`node scripts/listen-corpus-metrics.mjs --detector ./path/to/module.mjs`

The module may export either or both of:

```js
export function createDetector(opts) {
  return {
    process(bytes, sampleRate, fftSize, now, open, sens) {
      // Same contract as tests/helpers/listen-sim.mjs and
      // neural-dance/src/band-onsets.js (createBandOnsets().process).
      // Return a mask, or {onsets, beats, onsetTime, downbeats?, downbeatTime?, meter?}.
      return {onsets, beats, onsetTime, downbeats, downbeatTime, meter};
    },
    snapshot() { return {meter}; },
    reset() {}
  };
}

export async function detectOffline(samples, sampleRate, opts) {
  return {
    beats: [/* seconds */],
    downbeats: [/* seconds */],
    meter: '7/8', // or {label, numerator, denominator, grouping}
    bands: {kick: [], bass: [], mid: [], hat: []},
    onsets: [{band: 0, t: 0.5}]
  };
}
```

Scoring (see `tests/helpers/listen-corpus.mjs`):

- Beat / downbeat / per-band onset **F-measure at 70 ms**
- **Anticipation error**: median signed (detected − truth) in milliseconds
  (negative = early)
- **Meter accuracy**: exact match of normalized labels (`4/4`, `3/4`, `6/8`,
  `5/4`, `7/8`, `3+3+2`). `null` if the detector emits no meter.

The first 1200 ms of each clip is skipped (Listen warm-up), matching
`scripts/listen-timing-report.mjs`.
