// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Per-band Listen timing (TJ 6:45 PM): "picking out the correct waveform for
// each of the parts, timing-wise." Each dancer band gets its own onset
// detector and its own beat tracker, so kick dancers lock to the kick, bass
// dancers to the bass line, mid dancers to snare/vocals, and hi-hat dancers
// to the hats.
//
// Input is the AnalyserNode byte spectrum the page already reads every frame
// (no new audio nodes, so the working mic stream is never touched).
//   1. Onsets: SuperFlux-style spectral flux per band (rise over the
//      previous frame's 3-bin max, so vibrato and held notes do not fire),
//      adaptive threshold median + k·MAD over ~1.5 s, per-band refractory.
//   2. Latency: the detection frame lags the hit by the analyser window plus
//      frame cadence; a per-band constant (calibrated offline) gives each
//      onset an estimated true time.
//   3. Tracking: inter-onset-interval clustering gives a band period; a
//      gentle phase-locked loop (PLL) pulls the beat grid onto the onsets.
//      Once a band's grid has been confirmed by several hits in a row its
//      beats are emitted on the grid (on time, not late). Otherwise onsets are
//      emitted as they are heard. A locked grid bridges at most one missed hit
//      and then stops, so silence still falls back to the shared beat tiers.
// All buffers are preallocated: per-frame cost is one pass over the bins.

// Display bands (rings, meters, gate) stay [40,120] [120,300] [300,2500]
// [5000,14000]. Detection bands start the mid band above bass harmonics.
export const LISTEN_BAND_HZ = [[35, 90], [190, 450], [480, 4500], [5000, 14000]];
export const METER_BAND_HZ = [[40, 120], [120, 300], [300, 2500], [5000, 14000]];
// Hat band edges from the real sample rate and the mic's usable bandwidth.
// A 16 kHz / voice-band phone mic never reaches 5–14 kHz, so the hat read
// exactly 0 on the iPhone; the band now slides under the top edge.
export function hatBandHz(sampleRate, topHz = 0, base = [5000, 14000]) {
  const nyq = (+sampleRate > 0 ? +sampleRate : 48000) / 2;
  let hi = Math.min(base[1], nyq * 0.95);
  if (topHz > 1500) hi = Math.min(hi, topHz);
  const lo = Math.max(2500, Math.min(base[0], hi * 0.55));
  return [lo, Math.max(lo + 200, hi)];
}
// Phone mics (energy stops below ~6 kHz) were measured live putting bass
// notes at 100-190 Hz, between the kick and the default bass band; on such
// mics the bass band reaches down to 100 Hz. Full-range mics keep 190-450.
export const PHONE_BASS_HZ = [100, 450];
export function isPhoneMic(topHz) { return topHz > 1500 && topHz < 6000; }
export function listenBandsHz(sampleRate, topHz = 0) {
  return [LISTEN_BAND_HZ[0], isPhoneMic(topHz) ? PHONE_BASS_HZ : LISTEN_BAND_HZ[1], LISTEN_BAND_HZ[2], hatBandHz(sampleRate, topHz, LISTEN_BAND_HZ[3])];
}
export function meterBandsHz(sampleRate, topHz = 0) {
  return [METER_BAND_HZ[0], METER_BAND_HZ[1], METER_BAND_HZ[2], hatBandHz(sampleRate, topHz, METER_BAND_HZ[3])];
}
// Highest bin with signal (byte > 8 ≈ 6 dB over the −96 dB floor): fast
// attack, ~20 s release, so one quiet moment does not shrink the hat band.
export function trackMicTopHz(prev, bytes, sampleRate, fftSize, dt = 1 / 60) {
  if (!bytes || !(sampleRate > 0) || !(fftSize > 0)) return +prev || 0;
  const hz = sampleRate / fftSize;
  let i = bytes.length - 1;
  while (i > 0 && bytes[i] <= 8) i--;
  if (i <= 0) return +prev || 0; // silence: keep the last estimate
  const top = (i + 1) * hz;
  const p = +prev || 0;
  if (top >= p) return top;
  return p - (p - top) * Math.min(1, Math.max(0, +dt || 0) / 20);
}
// Band sliders were tuned for the legacy detector. The per-band detector
// divides its threshold by the gain, so 2.25–3× made it ~3× too eager:
// use √slider (1 stays 1, 3 → 1.73, 0 still mutes). Legacy is unchanged.
// Recommended band sliders for the level-adaptive per-band detector
// (TJ 8:12 PM; corpus sweep weighted to phone-mic/hat-cut clips + the live
// 7:45/8:13 captures): Kick 2.25, Bass 1.1, Snare/mid 1.0, Hi-hat 3.
export const BAND_SENS_RECOMMENDED = Object.freeze([2.25, 1.1, 1.0, 3]);
export function detectorSensGain(slider) {
  const s = +slider;
  if (!Number.isFinite(s)) return 1;
  return s > 0 ? Math.sqrt(s) : 0;
}
// Byte -> compressed magnitude: log(1 + GAMMA·|X|), |X| from the analyser's
// -96..-24 dB byte scale. Flux in this domain weights real energy, so window
// leakage a few bins away (tiny in linear terms) no longer looks like a hit.
const GAMMA = 300;
const LUT = new Float32Array(256);
for (let v = 1; v < 256; v++) LUT[v] = Math.log1p(GAMMA * Math.pow(10, (v / 255 * 72 - 96) / 20));
const HIST = 48;                       // ~1.6 s of flux history at 30 fps
const K_MAD = [2.6, 3.4, 3.4, 3.0];
const MIN_FLUX = [0.02, 0.02, 0.01, 0.01]; // mean compressed rise per bin
// TJ 7:43 PM live phone: the input sat ~40 dB under the corpus level (mic
// top ~3.5-4 kHz), so these absolute floors were above every mid/hat/bass
// rise and only the kick fired. The floor now scales with the band's recent
// level (peak hold, ~4 s half-life) against a nominal music level, so a quiet
// phone mic gets a proportionally lower floor; loud rooms are unchanged.
const LEVEL_REF = [0.5, 0.2, 0.06, 0.01];
// Lowest floor scale per band. Kick keeps its absolute floor (few bins, so
// room noise flickers there and the live kick already fires); bass may drop
// to half; mid and hat (many bins, smooth noise flux) to 5%.
const LEVEL_FLOOR_MIN = [1, 0.25, 0.05, 0.05];
const LEVEL_HALF_LIFE_MS = 4000;
// Level-relative floor: a fraction of the band's recent strongest rise
// (half-life ~2 s), so a loud kick's click in the mid band or a bass note's
// lobe in the kick band stays under threshold at any room volume.
const REL_PEAK = [0.45, 0.3, 0.25, 0.2];
const PEAK_HALF_LIFE_MS = 2000;
const REFRACTORY_MS = [130, 130, 100, 80];
// Detection lag (ms) from the true hit to the frame that sees it: a per-band
// analyser part (2048 FFT, Blackman) plus half the frame interval, measured
// with tests/helpers/listen-sim.mjs (28/36/30/29 ms at the live ~30 fps).
export const DETECT_LAG_MS = [11, 19, 13, 12];
const MIN_PERIOD = 200;
const MAX_PERIOD = 1400;
const IOI_RING = 12;
const TRACK_WINDOW_MS = 6000;
const LOCK_ON = 0.5;
const LOCK_HOLD = 0.35;
const FORGET_MS = 3000;
const MASK_RATIO = 2.2;   // neighbour rose this many times harder → its hit
// MASKED_BY[b*4+o]: band o can mask band b. Kick<->bass (kick pitch sweep,
// bass-note window lobe) and mid->bass (snare body). Mid and hat are never
// masked: they measured clean, and a hat on the snare is a real hat.
const NEIGHBOR = new Uint8Array([0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function median(buf, n, tmp) {
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = v;
  }
  const m = n >> 1;
  return n & 1 ? tmp[m] : (tmp[m - 1] + tmp[m]) * 0.5;
}

function createTracker() {
  return {
    ring: new Float64Array(IOI_RING), n: 0, head: 0,
    period: 0, next: 0, conf: 0, locked: false,
    lastOnset: -1e12, lastEmit: -1e12, emittedG: -1e12,
    pendT: new Float64Array(8), pendOk: new Uint8Array(8), pendN: 0
  };
}

function resetTracker(tr) {
  tr.n = 0; tr.head = 0; tr.period = 0; tr.next = 0; tr.conf = 0; tr.locked = false;
  tr.lastOnset = -1e12; tr.lastEmit = -1e12; tr.emittedG = -1e12; tr.pendN = 0;
}

// Most supported period among recent consecutive IOIs (Dixon-style clustering).
function estimatePeriod(tr, now) {
  const n = tr.n;
  if (n < 3) return 0;
  let best = 0, bestScore = 0;
  for (let a = 1; a < n; a++) {
    const ia = (tr.head - a + IOI_RING) % IOI_RING, ib = (tr.head - a - 1 + IOI_RING) % IOI_RING;
    if (now - tr.ring[ib] > TRACK_WINDOW_MS) break;
    let c = tr.ring[ia] - tr.ring[ib];
    while (c > 0 && c < MIN_PERIOD) c *= 2;
    if (!(c >= MIN_PERIOD && c <= MAX_PERIOD)) continue;
    let score = 0, sum = 0, w = 0;
    for (let i = 0; i < n; i++) {
      const ti = tr.ring[(tr.head - 1 - i + IOI_RING) % IOI_RING];
      if (now - ti > TRACK_WINDOW_MS) break;
      for (let j = i + 1; j < n && j <= i + 4; j++) {
        const tj = tr.ring[(tr.head - 1 - j + IOI_RING) % IOI_RING];
        if (now - tj > TRACK_WINDOW_MS) break;
        const d = ti - tj, k = Math.round(d / c);
        if (k < 1 || k > 4) continue;
        const err = Math.abs(d - k * c);
        if (err < 0.07 * c) { const s = 1 / k; score += s; sum += s * d / k; w += s; }
      }
    }
    if (score > bestScore + 1e-9) { bestScore = score; best = w > 0 ? sum / w : c; }
  }
  return bestScore >= 1.5 ? best : 0;
}

export function createBandOnsets({lagMs: lagBase = DETECT_LAG_MS, leadMs = null, levelFloor = true} = {}) {
  const levelPeak = new Float32Array(4);
  const lagMs = new Float32Array(4);
  // Grid beats go out on the frame nearest their true time: half a frame early.
  let frameMs = 33;
  let prev = null;          // previous frame, compressed (zeros while the gate is closed)
  let prevMax = null;       // 3-bin max of prev
  let primed = false;
  let lastBins = 0;
  const hist = [0, 1, 2, 3].map(() => new Float32Array(HIST));
  const histN = new Int32Array(4), histI = new Int32Array(4);
  const tmp = new Float32Array(HIST), dev = new Float32Array(HIST);
  const lastOnset = new Float64Array(4).fill(-1e12);
  // Raw detector onsets per band (before grid/pattern), for telemetry.
  const onsetCount = new Int32Array(4);
  const samples = new Int32Array(4);
  const novelty = new Float32Array(4);
  const peak = new Float32Array(4);
  let lastNow = 0;
  const trackers = [0, 1, 2, 3].map(createTracker);
  const range = new Int32Array(8);
  let rangeKey = '';
  const out = {
    onsets: 0, beats: 0, predicted: 0,
    onsetTime: new Float64Array(4),
    flux: new Float32Array(4),
    threshold: new Float32Array(4),
    level: new Float32Array(4),
    period: new Float32Array(4),
    locked: [false, false, false, false]
  };

  function ranges(sampleRate, fftSize, bins, bandsHz) {
    const edges = bandsHz && bandsHz.length === 4 ? bandsHz : LISTEN_BAND_HZ;
    const key = sampleRate + ':' + fftSize + ':' + bins + ':' + edges[3][0] + ':' + edges[3][1];
    if (key === rangeKey) return;
    rangeKey = key;
    const hz = sampleRate / fftSize;
    for (let b = 0; b < 4; b++) {
      let i0 = Math.ceil(edges[b][0] / hz - 1e-4), i1 = Math.ceil(edges[b][1] / hz - 1e-4) - 1;
      if (i0 < 1) i0 = 1;
      if (i1 > bins - 2) i1 = bins - 2;
      range[b * 2] = i0; range[b * 2 + 1] = i1;
    }
  }

  function reset() {
    primed = false;
    levelPeak.fill(0);
    lastBins = 0;
    for (let b = 0; b < 4; b++) {
      histN[b] = 0; histI[b] = 0; samples[b] = 0; lastOnset[b] = -1e12; peak[b] = 0;
      resetTracker(trackers[b]);
      out.period[b] = 0; out.locked[b] = false; out.flux[b] = 0; out.threshold[b] = 0;
    }
    out.onsets = out.beats = out.predicted = 0;
    frameMs = 33;
  }

  // Confirm or reject grid beats whose window has passed; returns nothing.
  function settle(tr, now, tol, lag) {
    let w = 0;
    for (let i = 0; i < tr.pendN; i++) {
      if (now - tr.pendT[i] > tol + lag + 40) {
        tr.conf = tr.conf * 0.7 + (tr.pendOk[i] ? 0.3 : 0);
      } else { tr.pendT[w] = tr.pendT[i]; tr.pendOk[w] = tr.pendOk[i]; w++; }
    }
    tr.pendN = w;
    if (tr.locked) { if (tr.conf < LOCK_HOLD) tr.locked = false; }
    else if (tr.conf >= LOCK_ON) tr.locked = true;
  }

  function onOnset(tr, t) {
    tr.ring[tr.head] = t; tr.head = (tr.head + 1) % IOI_RING; if (tr.n < IOI_RING) tr.n++;
    tr.lastOnset = t;
    const est = estimatePeriod(tr, t);
    if (!(tr.period > 0)) {
      if (est > 0) { tr.period = est; tr.next = t + est; tr.conf = 0; tr.pendN = 0; }
      return NaN;
    }
    const p = tr.period;
    const g = tr.next - p * Math.round((tr.next - t) / p);
    const e = t - g;
    const tol = Math.max(35, 0.12 * p);
    if (est > 0 && Math.abs(est - p) > 0.1 * p) {
      // Tempo change, or the grid was at double/half the band's real period
      // (a snare on 2 and 4 also sits on a quarter-note grid): re-seed here.
      tr.period = est; tr.next = t + est; tr.conf *= 0.5; tr.locked = false; tr.pendN = 0;
      return NaN;
    }
    if (Math.abs(e) <= tol) {
      // Gentle PLL: half the phase error, a tenth into the period.
      tr.next += 0.5 * e;
      tr.period = Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, p + 0.08 * e));
      for (let i = 0; i < tr.pendN; i++) if (Math.abs(tr.pendT[i] - g) < 1) tr.pendOk[i] = 1;
      if (est > 0) tr.period = tr.period * 0.85 + est * 0.15;
      return g;
    }
    return NaN;
  }

  // bytes: analyser bytes; open: silence gate; sens: per-band sliders (0 mutes).
  function process(bytes, sampleRate, fftSize, now, open, sens, bandsHz) {
    out.onsets = 0; out.beats = 0; out.predicted = 0;
    const bins = bytes ? bytes.length : 0;
    if (bins < 8 || !(sampleRate > 0) || !(fftSize > 0)) return out;
    if (bins !== lastBins || !prev) {
      prev = new Float32Array(bins); prevMax = new Float32Array(bins);
      lastBins = bins; primed = false;
    }
    ranges(sampleRate, fftSize, bins, bandsHz);
    const live = open !== false;
    const step = primed ? Math.max(0, Math.min(500, now - lastNow)) : 0;
    lastNow = now;
    const decay = Math.pow(0.5, step / PEAK_HALF_LIFE_MS);
    const levelDecay = Math.pow(0.5, step / LEVEL_HALF_LIFE_MS);
    if (step > 0 && step < 200) frameMs += (step - frameMs) * 0.1;
    const lead = leadMs == null ? frameMs * 0.5 : +leadMs || 0;
    for (let b = 0; b < 4; b++) lagMs[b] = lagBase[b] + frameMs * 0.5;
    for (let b = 0; b < 4; b++) {
      const i0 = range[b * 2], i1 = range[b * 2 + 1];
      let flux = 0, level = 0;
      if (i1 >= i0) {
        for (let i = i0; i <= i1; i++) {
          const v = live ? LUT[bytes[i]] : 0;
          level += v;
          const d = v - prevMax[i];
          if (d > 0) flux += d;
        }
        flux /= (i1 - i0 + 1);
        level /= (i1 - i0 + 1);
      }
      levelPeak[b] = live && level > levelPeak[b] * levelDecay ? level : levelPeak[b] * levelDecay;
      out.level[b] = levelPeak[b];
      out.flux[b] = flux;
      peak[b] *= decay;
      const n = histN[b];
      let thr = Infinity;
      if (n >= 8) {
        const h = hist[b];
        const med = median(h, n, tmp);
        for (let i = 0; i < n; i++) dev[i] = Math.abs(h[i] - med);
        const mad = median(dev, n, tmp);
        const floor = levelFloor ? MIN_FLUX[b] * Math.min(1, Math.max(LEVEL_FLOOR_MIN[b], levelPeak[b] / LEVEL_REF[b])) : MIN_FLUX[b];
        thr = Math.max(floor + med + K_MAD[b] * mad, REL_PEAK[b] * peak[b]);
      }
      const s = sens ? +sens[b] : 1;
      const gain = Number.isFinite(s) ? detectorSensGain(s) : 1;
      thr = gain > 0 ? thr / gain : Infinity;
      out.threshold[b] = thr;
      samples[b]++;
      const over = primed && live && flux > thr && now - lastOnset[b] >= REFRACTORY_MS[b];
      novelty[b] = over ? flux / thr : 0;
      if (live && flux > peak[b]) peak[b] = flux;
      const h = hist[b];
      // Onset frames enter the history clipped so one huge hit cannot mask the next.
      h[histI[b]] = over && n >= 8 ? Math.min(flux, thr) : flux;
      histI[b] = (histI[b] + 1) % HIST;
      if (histN[b] < HIST) histN[b]++;
    }
    // Cross-band masking: a kick's pitch sweep leaks into the bass band and a
    // bass note's window lobe into the kick band. A band whose rise is small next to a neighbour that fired and
    // rose much harder in the same frame is that neighbour's hit. Real
    // simultaneous hits (kick + bass note) both rise and both fire.
    for (let b = 0; b < 4; b++) {
      const z = novelty[b];
      if (!(z > 0)) continue;
      let masked = false;
      for (let o = 0; o < 4; o++) {
        if (o === b || !(novelty[o] > 0) || !NEIGHBOR[b * 4 + o]) continue;
        if (out.flux[o] > MASK_RATIO * out.flux[b]) { masked = true; break; }
      }
      if (masked) continue;
      lastOnset[b] = now;
      out.onsets |= 1 << b;
      onsetCount[b]++;
      out.onsetTime[b] = now - lagMs[b];
    }
    for (let i = 0; i < bins; i++) prev[i] = live ? LUT[bytes[i]] : 0;
    for (let i = 1; i < bins - 1; i++) {
      const a = prev[i - 1], c = prev[i], d = prev[i + 1];
      prevMax[i] = a > c ? (a > d ? a : d) : (c > d ? c : d);
    }
    primed = true;

    for (let b = 0; b < 4; b++) {
      const tr = trackers[b];
      const lag = lagMs[b];
      const s = sens ? +sens[b] : 1;
      const muted = Number.isFinite(s) && !(s > 0);
      if (now - tr.lastOnset > FORGET_MS && tr.period > 0) resetTracker(tr);
      const hit = (out.onsets >> b) & 1;
      const wasLocked = tr.locked;
      const g0 = hit ? onOnset(tr, out.onsetTime[b]) : NaN;
      const p = tr.period;
      const tol = p > 0 ? Math.max(35, 0.12 * p) : 35;
      // Grid beats due by now (true time). Each joins the pending list.
      if (p > 0) {
        while (tr.next <= now + lead) {
          const g = tr.next;
          tr.next += p;
          if (tr.pendN < 8) { tr.pendT[tr.pendN] = g; tr.pendOk[tr.pendN] = hit && Math.abs(out.onsetTime[b] - g) <= tol ? 1 : 0; tr.pendN++; }
          const bridging = now - tr.lastOnset <= 1.6 * p;
          if (tr.locked && bridging && !muted && Math.abs(tr.emittedG - g) > tol && now - tr.lastEmit >= 0.35 * p && now - g < 0.5 * p + lead) {
            tr.lastEmit = now;
            tr.emittedG = g;
            out.beats |= 1 << b;
            out.predicted |= 1 << b;
          }
        }
        settle(tr, now, tol, lag);
      }
      if (hit && !muted) {
        if (wasLocked && g0 === g0) {
          // On-grid hit: emit unless its grid beat already went out on time.
          if (Math.abs(tr.emittedG - g0) > 1) { tr.emittedG = g0; tr.lastEmit = now; out.beats |= 1 << b; }
        } else if (!wasLocked || now - tr.lastEmit >= 0.35 * p) {
          // Unlocked: every onset as heard. Locked: off-grid hits spaced out.
          tr.lastEmit = now; out.beats |= 1 << b;
        }
      }
      out.period[b] = p;
      out.locked[b] = tr.locked;
    }
    return out;
  }

  function snapshot() {
    return [0, 1, 2, 3].map(b => ({
      period: Math.round(trackers[b].period),
      locked: trackers[b].locked,
      conf: Math.round(trackers[b].conf * 100) / 100,
      // Live phone flux sits around 0.001-0.05: keep 4 decimals (0.1 read as 0).
      flux: Math.round(out.flux[b] * 1e4) / 1e4,
      threshold: Number.isFinite(out.threshold[b]) ? Math.round(out.threshold[b] * 1e4) / 1e4 : null,
      level: Math.round(out.level[b] * 1e3) / 1e3,
      onsets: onsetCount[b]
    }));
  }

  return {process, reset, snapshot, state: out};
}
