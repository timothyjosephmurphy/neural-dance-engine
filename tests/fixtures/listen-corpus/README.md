# Listen pattern-learning corpus

Ground-truth WAV + JSON for the Listen v2 beat-pattern work. **Offline only:
this folder is not part of the live Worker or `test:show`.** The
`feat/listen-pattern` worker can consume it at:

`tests/fixtures/listen-corpus/` (schema `nd-listen-corpus-v1`, see SCHEMA.md).

## How to run

From a checkout of this branch (`test/listen-pattern-corpus`):

```bash
# 1. Rebuild every synthetic clip (deterministic seeds → WAV + JSON + manifest)
node scripts/listen-corpus-generate.mjs

# 2. Fetch the CC0 real loops and label beats/downbeats/meter (needs the
#    box venv and ffmpeg). Skip labeling with --skip-label.
node scripts/listen-corpus-fetch-real.mjs

# 3. Score the current per-band detector and the legacy baseline, write the table
node scripts/listen-corpus-metrics.mjs --write tests/fixtures/listen-corpus/baseline

# 4. Score a pattern-learning detector module
node scripts/listen-corpus-metrics.mjs --detector /path/to/pattern-detector.mjs
```

Label any other WAV with the same JSON format (venv is **outside** the repo
and is never shipped):

```bash
.venv-listen-label/bin/python tools/listen-label/label.py \
    path/to/song.wav --meter 7/8 --grouping 3,2,2 \
    --source-name "…" --source-url "…" --license CC0-1.0
```

A small unit test (not in `test:show`) checks schema, seeds, and meter math:

```bash
node --test tests/listen-corpus.test.mjs
```

## What is in here

Synthetic grooves (exact labels, seed in each JSON): 4/4, 3/4, 6/8, 5/4,
7/8 (3+2+2), 3+3+2, 2:1 and 3:2 swing, ±8% gradual tempo drift, rubato, a
2-bar break, a 2-bar fill, moving accents, a mid-song tempo step, a phone-mic
simulation (100 Hz–8 kHz, room reverb, noise), and a 5 kHz-cut variant that
mirrors the iPhone hat-zero finding (plus the same cut on a 7/8 clip).

Real recordings: five CC0 Freesound drum loops (3/4, 6/8, 5/4, 7/8, 110 BPM
shuffle). Source, license, and attribution are in `real/SOURCES.md`.
