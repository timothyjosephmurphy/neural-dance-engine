// Shared Listen v2 corpus helpers: WAV I/O, phone-mic degradations, scoring,
// and the offline detector runner used by the generator and metrics script.
// Schema: tests/fixtures/listen-corpus/SCHEMA.md (nd-listen-corpus-v1).
//
// The pattern-learning worker (feat/listen-pattern) should import score(),
// fMeasure(), runDetectorOnAudio(), and evaluateClip() from this file.

import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createAnalyser, frameTimes, score as scoreEvents} from './listen-sim.mjs';

export const SCHEMA = 'nd-listen-corpus-v1';
export const BAND_NAMES = ['kick', 'bass', 'mid', 'hat'];
export const DEFAULT_SR = 48000;
export const BEAT_TOL_MS = 70;

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// RBJ biquad, in place. type: 'lp' | 'hp' | 'bp'
export function biquad(buf, type, f0, q, sr) {
  const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
  return buf;
}

export function peakNormalize(buf, peak = 0.95) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  if (m > 0) {
    const g = peak / m;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

// Schroeder-style room reverb (4 combs + 2 allpasses). Deterministic.
export function roomReverb(input, sr, {mix = 0.24, decay = 0.72} = {}) {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map(s => Math.max(2, Math.round(s * sr)));
  const allps = [0.005, 0.0168].map(s => Math.max(2, Math.round(s * sr)));
  const wet = new Float32Array(input.length);
  for (const D of combs) {
    const buf = new Float32Array(D);
    let i = 0;
    for (let n = 0; n < input.length; n++) {
      const y = buf[i];
      buf[i] = input[n] + decay * y;
      wet[n] += y;
      i++; if (i === D) i = 0;
    }
  }
  for (let n = 0; n < wet.length; n++) wet[n] *= 0.25;
  for (const D of allps) {
    const buf = new Float32Array(D);
    let i = 0, g = 0.5;
    for (let n = 0; n < wet.length; n++) {
      const x = wet[n];
      const xm = buf[i];
      const y = -g * x + xm;
      buf[i] = x + g * y;
      wet[n] = y;
      i++; if (i === D) i = 0;
    }
  }
  const out = new Float32Array(input.length);
  const dry = 1 - mix;
  for (let n = 0; n < out.length; n++) out[n] = input[n] * dry + wet[n] * mix;
  return out;
}

export function addNoise(buf, amp, seed) {
  const rand = rng(seed);
  // One-pole pink-ish hiss.
  let pink = 0;
  for (let i = 0; i < buf.length; i++) {
    const w = rand() * 2 - 1;
    pink = pink * 0.93 + w * 0.07;
    buf[i] += (w * 0.35 + pink * 0.65) * amp;
  }
  return buf;
}

// Phone-mic simulation: room reverb, then band-limit, then sensor noise.
// hatCut: also drop everything above 5 kHz (mirrors the iPhone hat-zero finding).
export function phoneMic(buf, sr, {hatCut = false, noise = 0.006, seed = 9, mix = 0.24} = {}) {
  let out = roomReverb(buf, sr, {mix});
  biquad(out, 'hp', 100, 0.7, sr);
  biquad(out, 'hp', 100, 0.7, sr);
  const lp = hatCut ? 5000 : 8000;
  biquad(out, 'lp', lp, 0.7, sr);
  biquad(out, 'lp', lp, 0.7, sr);
  addNoise(out, noise, seed);
  return peakNormalize(out, 0.95);
}

export function writeWav16Mono(path, samples, sr = DEFAULT_SR) {
  const n = samples.length;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24);
  wav.writeUInt32LE(sr * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return writeFile(path, wav);
}

// PCM WAV reader: 16 or 24-bit, mono or stereo (mixdown), any sample rate.
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12, sr = 0, ch = 0, bits = 0, dataStart = 0, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const fmt = buf.readUInt16LE(off + 8);
      ch = buf.readUInt16LE(off + 10);
      sr = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
      if (fmt !== 1 && fmt !== 3) throw new Error('unsupported WAV format ' + fmt);
      parseWav._fmt = fmt;
    } else if (id === 'data') {
      dataStart = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!sr || !ch || !dataStart) throw new Error('WAV missing fmt/data');
  const fmt = parseWav._fmt || 1;
  const stride = (bits / 8) * ch;
  const nFrames = Math.floor(dataLen / stride);
  const samples = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const p = dataStart + i * stride + c * (bits / 8);
      if (fmt === 3 && bits === 32) acc += buf.readFloatLE(p);
      else if (bits === 16) acc += buf.readInt16LE(p) / 32768;
      else if (bits === 24) {
        const b0 = buf[p], b1 = buf[p + 1], b2 = buf[p + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        acc += v / 8388608;
      } else if (bits === 32 && fmt === 1) acc += buf.readInt32LE(p) / 2147483648;
      else throw new Error('unsupported WAV bits=' + bits + ' fmt=' + fmt);
    }
    samples[i] = acc / ch;
  }
  return {samples, sampleRate: sr, channels: 1, bits};
}

export async function readWav(path) {
  return parseWav(await readFile(path));
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

// --- Tempo maps: score units → seconds ---------------------------------

// unit is the note value that "bpm" counts (quarter, eighth, dotted-quarter).
export function unitSeconds(unit) {
  if (unit === 'eighth') return 0.5;
  if (unit === 'dotted-quarter') return 1.5;
  return 1; // quarter
}

// Build a function u → t (seconds) from a tempo spec.
export function makeTimeMap(tempo, {t0 = 0.5, units = 64} = {}) {
  const kind = tempo.kind || 'constant';
  if (kind === 'constant') {
    const spu = 60 / tempo.bpm;
    return u => t0 + u * spu;
  }
  if (kind === 'linear-drift') {
    const b0 = tempo.bpmStart, b1 = tempo.bpmEnd, uMax = tempo.units ?? units;
    if (Math.abs(b1 - b0) < 1e-9) {
      const spu = 60 / b0;
      return u => t0 + u * spu;
    }
    // bpm(u) = b0 + (b1-b0)*u/uMax;  dt/du = 60/bpm(u)
    const k = (b1 - b0) / uMax;
    return u => t0 + (60 / k) * Math.log((b0 + k * u) / b0);
  }
  if (kind === 'step') {
    // tempo.steps: [{u, bpm}, ...] in score units, piecewise constant.
    const steps = (tempo.steps || []).slice().sort((a, b) => a.u - b.u);
    const spu0 = 60 / (steps[0]?.bpm || tempo.bpm);
    return u => {
      let t = t0, uCursor = 0, bpm = steps[0]?.bpm || tempo.bpm;
      for (const s of steps) {
        if (s.u <= 0) { bpm = s.bpm; continue; }
        const upto = Math.min(u, s.u);
        if (upto > uCursor) t += (upto - uCursor) * (60 / bpm);
        uCursor = upto;
        bpm = s.bpm;
        if (uCursor >= u) return t;
      }
      return t + (u - uCursor) * (60 / bpm);
    };
  }
  if (kind === 'rubato') {
    // Numeric integral of 60 / (bpm * (1 + depth * sin(2π u/period + phi))).
    const bpm = tempo.bpm, depth = tempo.depth ?? 0.08, period = tempo.periodUnits ?? 8;
    const phi = tempo.phi ?? 0, step = tempo.integrateStep ?? 1 / 32;
    const cache = [t0];
    let t = t0, uAcc = 0;
    // lazily fill
    return u => {
      if (u < 0) return t0 + u * (60 / bpm);
      const n = Math.max(0, Math.ceil(u / step));
      while (cache.length <= n) {
        const uu = uAcc + step * 0.5;
        const inst = bpm * (1 + depth * Math.sin(2 * Math.PI * uu / period + phi));
        t += step * (60 / inst);
        uAcc += step;
        cache.push(t);
      }
      const i = Math.floor(u / step), frac = u / step - i;
      const a = cache[i], b = cache[Math.min(i + 1, cache.length - 1)];
      return a + (b - a) * frac;
    };
  }
  throw new Error('unknown tempo kind ' + kind);
}

export function almostEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// --- Scoring ------------------------------------------------------------

export function fMeasure(hits, misses, fps) {
  const p = hits + fps > 0 ? hits / (hits + fps) : 0;
  const r = hits + misses > 0 ? hits / (hits + misses) : 0;
  const f = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return {precision: p, recall: r, f};
}

// Score a list of times (seconds) against truth times (seconds).
export function scoreTimes(truthSec, foundSec, {tolMs = BEAT_TOL_MS, from = 0, to = Infinity, skipFirstMs = 0} = {}) {
  const lo = from + skipFirstMs / 1000, hi = to;
  const T = truthSec.filter(t => t >= lo && t < hi).slice().sort((a, b) => a - b);
  const F = foundSec.filter(t => t >= lo && t < hi).slice().sort((a, b) => a - b);
  const used = new Uint8Array(F.length);
  const errs = []; // found - truth, seconds
  for (const t of T) {
    let best = -1, bd = tolMs / 1000;
    for (let i = 0; i < F.length; i++) {
      if (used[i]) continue;
      const d = Math.abs(F[i] - t);
      if (d <= bd) { bd = d; best = i; }
    }
    if (best >= 0) { used[best] = 1; errs.push(F[best] - t); }
  }
  const hits = errs.length;
  const misses = T.length - hits;
  const fps = F.length - hits;
  const fm = fMeasure(hits, misses, fps);
  const signedMs = errs.map(e => e * 1000).sort((a, b) => a - b);
  const absMs = signedMs.map(Math.abs).sort((a, b) => a - b);
  const mid = a => a.length ? a[a.length >> 1] : NaN;
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  return {
    truth: T.length,
    hits,
    misses,
    falsePositives: fps,
    ...fm,
    // Anticipation error: median signed (detected − truth) in ms. Negative = early.
    anticipationMs: mid(signedMs),
    meanSignedMs: mean(signedMs),
    medianAbsMs: mid(absMs),
    p90AbsMs: absMs.length ? absMs[Math.floor(absMs.length * 0.9)] : NaN
  };
}

export function normalizeMeterLabel(meter) {
  if (!meter) return null;
  if (typeof meter === 'string') {
    const s = meter.trim().replace(/\s+/g, '');
    if (/^3\+3\+2$/.test(s) || s === '8/8') return s === '8/8' ? '3+3+2' : s;
    return s;
  }
  if (meter.label) {
    const s = String(meter.label).trim().replace(/\s+/g, '');
    if (s === '8/8' || s === '3+3+2') return '3+3+2';
    return s;
  }
  if (meter.grouping && meter.grouping.join('+') === '3+3+2') return '3+3+2';
  if (meter.numerator && meter.denominator) return meter.numerator + '/' + meter.denominator;
  return null;
}

export function meterMatch(truthMeter, detectedMeter) {
  const a = normalizeMeterLabel(truthMeter);
  const b = normalizeMeterLabel(detectedMeter);
  if (!a || !b) return null; // not provided
  return a === b;
}

// Drive a frame-based detector (listen-sim / band-onsets process interface)
// over a Float32Array. Collects onsets, beats, and optional downbeats/meter.
export function runDetectorOnAudio(detector, samples, sampleRate, {
  gate = null,
  fftSize = 2048,
  frames = null,
  sens = [1, 1, 1, 1],
  duration = null
} = {}) {
  const dur = duration ?? (samples.length / sampleRate);
  const an = createAnalyser(fftSize);
  const times = frames || frameTimes(dur * 1000);
  const onsets = [], beats = [], downbeats = [];
  let last = times[0] ?? 0;
  let lastMeter = null;
  for (const now of times) {
    const bytes = an.at(samples, Math.floor(now / 1000 * sampleRate));
    let open = true;
    if (gate) {
      const peaks = gate.lib.bandPeaks(bytes, sampleRate, fftSize);
      gate.lib.scale(gate.state, peaks, Math.max(0.001, (now - last) / 1000));
      open = gate.state.open;
    }
    const out = detector.process(bytes, sampleRate, fftSize, now, open, sens);
    const mask = typeof out === 'number' ? out : out.beats;
    const onsetMask = typeof out === 'number' ? out : out.onsets;
    const downMask = typeof out === 'number' ? 0 : (out.downbeats || 0);
    for (let b = 0; b < 4; b++) {
      if (mask & (1 << b)) beats.push({band: b, t: now / 1000, tMs: now});
      if (onsetMask & (1 << b)) {
        const tMs = typeof out === 'number' ? now : (Number.isFinite(out.onsetTime?.[b]) ? out.onsetTime[b] : now);
        onsets.push({band: b, t: tMs / 1000, tMs});
      }
    }
    if (downMask) {
      const tMs = Number.isFinite(out.downbeatTime) ? out.downbeatTime : now;
      downbeats.push(tMs / 1000);
    }
    if (typeof out === 'object' && out && (out.meter || out.meterLabel)) {
      lastMeter = out.meter || out.meterLabel;
    }
    last = now;
  }
  if (!lastMeter && detector.snapshot) {
    const snap = detector.snapshot();
    if (snap && (snap.meter || snap.meterLabel)) lastMeter = snap.meter || snap.meterLabel;
  }
  if (!lastMeter && detector.state && (detector.state.meter || detector.state.meterLabel)) {
    lastMeter = detector.state.meter || detector.state.meterLabel;
  }
  return {onsets, beats, downbeats, meter: lastMeter, duration: dur, sampleRate};
}

export function bandTimes(events, band) {
  return events.filter(e => e.band === band).map(e => (typeof e.t === 'number' && e.t < 1000 && e.tMs == null) ? e.t : (e.tMs != null ? e.tMs / 1000 : e.t));
}

// Evaluate one clip label JSON + detector result.
// skipFirstMs: ignore the Listen warm-up window (matches listen-timing-report).
export function evaluateClip(label, result, {tolMs = BEAT_TOL_MS, skipFirstMs = 1200} = {}) {
  const opt = {tolMs, skipFirstMs};
  const bands = {};
  for (let b = 0; b < 4; b++) {
    const name = BAND_NAMES[b];
    const truth = (label.bands && label.bands[name]) || [];
    const onset = scoreTimes(truth, bandTimes(result.onsets || [], b), opt);
    const beat = scoreTimes(truth, bandTimes(result.beats || [], b), opt);
    bands[name] = {onset, beat};
  }
  const truthBeats = label.beats || [];
  const truthDown = label.downbeats || [];
  // Global beat: union of all band beats, de-duplicated within 30 ms, vs metric beats.
  const allBeats = (result.beats || []).map(e => (e.tMs != null ? e.tMs / 1000 : e.t)).sort((a, b) => a - b);
  const merged = [];
  for (const t of allBeats) {
    if (!merged.length || t - merged[merged.length - 1] > 0.03) merged.push(t);
    else merged[merged.length - 1] = 0.5 * (merged[merged.length - 1] + t);
  }
  // Kick-band beats often track the tactus in 4/4; also report that view.
  const kickBeats = bandTimes(result.beats || [], 0);
  const globalBeat = scoreTimes(truthBeats, merged, opt);
  const kickAsBeat = scoreTimes(truthBeats, kickBeats, opt);
  const downProvided = (result.downbeats && result.downbeats.length > 0) || result.downbeatsProvided === true;
  const downbeat = downProvided
    ? scoreTimes(truthDown, result.downbeats || [], opt)
    : null;
  const meter = meterMatch(label.meter, result.meter);
  const hatAudible = label.hatAudible !== false;
  // Anticipation: prefer global beat signed error, else mean of band onset signed errors.
  const anticipationMs = Number.isFinite(globalBeat.anticipationMs)
    ? globalBeat.anticipationMs
    : bands.kick.onset.anticipationMs;
  return {
    id: label.id,
    meter: {
      truth: normalizeMeterLabel(label.meter),
      detected: normalizeMeterLabel(result.meter),
      match: meter, // true / false / null (detector did not emit a meter)
      accuracy: meter == null ? null : (meter ? 1 : 0)
    },
    downbeat: downbeat ? {provided: true, ...downbeat} : {provided: false, f: null, anticipationMs: null},
    beat: globalBeat,
    kickAsBeat,
    bands,
    hatAudible,
    anticipationMs,
    degradations: label.degradations || [],
    regions: label.regions || {}
  };
}

// Flatten one evaluateClip() result into a row for console.table / CSV.
export function resultRow(ev, detectorName) {
  const bandF = name => ev.bands[name]?.onset?.f;
  return {
    id: ev.id,
    detector: detectorName,
    meterTruth: ev.meter.truth,
    meterDet: ev.meter.detected,
    meterOk: ev.meter.match,
    downF: ev.downbeat.provided ? +ev.downbeat.f.toFixed(3) : null,
    beatF: +ev.beat.f.toFixed(3),
    beatAntMs: Number.isFinite(ev.beat.anticipationMs) ? +ev.beat.anticipationMs.toFixed(1) : null,
    kickBeatF: ev.kickAsBeat && ev.kickAsBeat.f != null ? +ev.kickAsBeat.f.toFixed(3) : null,
    kickOnsetF: bandF('kick') != null ? +bandF('kick').toFixed(3) : null,
    bassOnsetF: bandF('bass') != null ? +bandF('bass').toFixed(3) : null,
    midOnsetF: bandF('mid') != null ? +bandF('mid').toFixed(3) : null,
    hatOnsetF: bandF('hat') != null ? +bandF('hat').toFixed(3) : null,
    hatAudible: ev.hatAudible,
    degradations: (ev.degradations || []).join(',')
  };
}

export {scoreEvents};
