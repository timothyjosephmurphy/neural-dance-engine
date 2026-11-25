# Port plan: Melody/Pad arms band (waveform + overhead)

Status: **wired into live and the official sim (not yet deployed).** This port landed in PR #77 (`0b1b237`) and is part of the live show. Shared modules:

- `neural-dance/src/melody-pad.js` — 500–4000 Hz Melody/Pad analyzer
- `neural-dance/src/pad-arms.js` — v3 hands-lead + traveling seesaw/sine wave
- `neural-dance/src/body-shell.js` — the transparent 3D tapered shell (full LOD)

Live `paintShadowFigure` uses the shared shell at `lod: 'full'` and keeps the
lighter stroke capsules at `lod: 'cheap'` (24-sim / iPhone 13 budget). Official
sim imports the same modules (inlined shell remains as a fallback until the
import resolves). Stance caps in `skeleton-motion.js` are unchanged.

## What already works (offline side sim)

An external side-sim page (not in this repo):

- Melody/Pad band, gold meter, slider **Arms ← strings/synth**.
- **Demo music** dropdown (full 54 s loop or one section). Mic **Listen** still wins when it is on.
- Arms **interpret the waveform**, not only a slow envelope (see mapping below).
- At peak (strong pad + high contour, and/or high activation on top) arms go **fully overhead**; hands can meet/cross above the head.
- Rest is unchanged: hands down at the sides, blend = 0.
- Proof was a 54 s side-sim recording with section labels and muxed music.

The analyzer is `neural-dance/src/melody-pad.js`.

## Waveform → arm mapping (port this after the motion branch lands)

All targets go through well-damped springs (bass slightly heavier, high slightly lighter). No jerk; accents add a little spring *velocity* so they have follow-through.

| Feature | Source | Arm response |
|---|---|---|
| `env` | Slow sustained energy, 500–4000 Hz, 220 ms attack / 1.15 s release. Drums rejected. | Overall presence. Blend is 0 at rest. |
| `contour` | Log spectral centroid in 500–4000 Hz (only while a tone is confirmed). 120/280 ms. | **Height / reach.** Low line stays lower; a rising melody climbs. |
| `crescendo` | Smoothed positive derivative of `env`. | **Elbow extension** (open, lyrical). |
| `subLo` / `subHi` | Same process, split at 1500 Hz. | **Sweep / phrase path.** Bass dancer leans on `subLo`, high on `subHi`, mid on the full contour (call-and-response reads as left/right or dancer-to-dancer). |
| `vibrato` | Contour minus a 1.15 s slow centroid, scaled. | Gentle **wrist / forearm undulation**. |
| `onset` / `note` | Faster tonal envelope (80/220 ms) plus a decaying onset pulse. Short *tonal* stabs (staccato synth) pass; snares/kicks do not (55 ms continuous-tone hold, 2–16 strong partials). | Soft **wrist/elbow accents** on note changes. |
| Peak | `env` ≳ 0.88 and contour ≳ 0.42, or that plus high `armLift` activation. | Raise eases to 1: arms **past vertical**, hands above the head, able to meet/cross. |

Reach curve (angle from downward): 10° at rest → ~100° at mid (out to the sides) → 198° at peak (18° past vertical, inward).

Suggested hook, once `skeletonPose` is stable: pass a `padArm` argument `{raise, extend, sweep, wrist, undulate, accent, overhead, blend}` computed next to `smoothArmActivation` / `armLiftAmount`, and layer it on the existing lift the same way the side sim does. Do not replace the rest pose.

## Listen / live wiring

In `neural-dance/room-lab.js`, beside `createBandOnsets`:

- One `createMelodyPadAnalyzer()`.
- Each spectrum frame: `pad.processBytes(bytes, sr, fftSize, dt)`.
- Publish `pad` / `envelopes.pad` plus `contour`, `note`, `onset`, `subLo`, `subHi` on `debugAudio()`. This is **not** a fifth dancer onset band.
- When the silence gate closes, `pad.reset()` so arms settle.

Do **not** change `LISTEN_BAND_HZ`. Mid and hat still own steps.

## Controls

- Slider label exactly: **Arms ← strings/synth** (0–2, default 1).
- Meter: **Melody/Pad**, gold `#f0c878`.
- Sim page: **Demo music** dropdown (off / full loop / section). Keep Listen working.

## Constants

```
loHz: 500
hiHz: 4000
midSplitHz: 1500
attackSec: 0.22
releaseSec: 1.15
contourAttackSec: 0.12
contourReleaseSec: 0.28
noteAttackSec: 0.08
noteReleaseSec: 0.22
stabHoldSec: 0.040
medianWinSec: 0.40
confirmSec: 0.28
spikeRatio: 0.45
```

## Deploy

Side-sim review first. Then PR this wiring, `npm run test:show`, merge (merge commit), one deploy, verify `version.json`. No force-push. No merge until the figure-8 / rest-stance motion work has landed, so this stays a clean rebase onto that.


## v3 pose: hands lead, traveling wave (side-sim proven)

Still not wired into `skeleton-dancer.js` / `skeleton-motion.js`. Port this after TJ approves a live hook.

### Hands lead, elbows stay lower

On the v2 film, **35.1%** of raised arm-slots had the elbow above its wrist (swell 95%, arpeggio 54%, call 58%). That was a downward forearm bend once the upper arm was out, plus a crescendo→extend term that did not correct it, and a hands-above-elbows cap that only ran on activation lift (off in the film).

v3:

- Once `raise` passes ~0.18–0.48, elbow flexion continues the lift (hands lead, elbows follow lower).
- Crescendo/`extend` only mildly straightens the arm; it no longer shoves elbows up.
- A screen-space cap after yaw keeps `wrist.y` and `hand.y` above `elbow.y` whenever `lead > 0.45` (or activation mid/high). Rest is unchanged: hands stay down, elbows naturally above the hands.
- After: **0.41%** of raised arm-slots (brief transitions only: swell start, breakdown release, start of the final build).

### Traveling wave

A damped wave runs along the span `handL–wristL–elL–shL–shR–elR–wristR–handR`.

| Mode | When | Spatial *k* | Look |
|---|---|---|---|
| Seesaw | Moving melody / sub-band split (`subHi−subLo`, contour velocity), arpeggio, rising line, build | ≈π | One hand high, the other low |
| Sine through both arms | Held pad/strings (`env` high, onset low), swell, high-strings peak, call-and-response | ≈2π | Visible S-wave, phase offsets along the chain |

Travel direction follows a sprung `subHi−subLo` + contour velocity. Amplitude is sprung and shrinks at overhead peaks so both hands can still meet above the head. Frequency ~0.3–1 Hz.

Suggested hook: extend the `padArm` payload with `{ lead, wave: { phase, k, ampRaise, ampSpace, sine, seesaw, dir } }` and apply the same lead-flexion, chain offsets, and post-yaw cap beside `smoothArmActivation`.
