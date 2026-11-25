# Offline Listen labeler (never shipped)

Python wrapper around [madmom](https://github.com/CPJKU/madmom) (and optionally
[BeatNet](https://github.com/mjhydri/BeatNet)) that writes
`nd-listen-corpus-v1` JSON for any WAV. It does **not** go into the Neural
Dance Worker, pages, or `test:show`.

## License caveats

- madmom **source** is BSD. Its **pretrained models** are
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Use
  this tool only for offline, non-commercial labeling. Do not vendor the
  models or this venv into the shipped product.
- BeatNet’s own code is CC BY 4.0 and it depends on madmom. It is optional
  and not installed by default.

## Setup (on the box)

Python headers are required to build madmom. A uv-managed CPython works
(system `python3.13-dev` was not available on this image):

```bash
uv python install 3.13.18
uv venv .venv-listen-label --python 3.13.18
uv pip install --python .venv-listen-label/bin/python \
    -r tools/listen-label/requirements.txt
```

The venv lives at `.venv-listen-label` and is gitignored / outside
this repository. madmom is pinned to commit
`27f032e8947204902c675e5e341a3faf5dc86dae` (`0.17.dev0`), which installs on
Python 3.13 (the 0.16.1 PyPI release does not).

Optional BeatNet (heavy: pulls PyTorch):

```bash
uv pip install --python .venv-listen-label/bin/python BeatNet
# then:  …/python tools/listen-label/label.py song.wav --backend beatnet
```

## Usage

```bash
.venv-listen-label/bin/python tools/listen-label/label.py \
    clip.wav \
    --id my-clip \
    --meter 5/4 --grouping 3,2 \
    --license CC0-1.0 \
    --source-name "…" --source-author "…" --source-url "https://…"
```

`--meter` is taken as announced truth when the file’s author states it (odd
meters are otherwise easy for a 3/4–4/4-biased DBN to misread). Per-band
hits are a simple envelope-peak picker, recorded as
`provenance.bands: "envelope-peak"` — not the Listen detector under test.
