// Melody/Pad (arms) band — port of the side-sim detector (not wired into
// the live / sim pages yet). See docs/port-melody-pad-arms.md.
//
// Melody/Pad (arms) band: sustained mid-high tonal energy for strings / synth,
// plus a waveform reading (contour, phrase, vibrato, tonal onsets) so the arms
// can dance to the shape of the line — not only a slow envelope.
//
// Band: 500 Hz–4000 Hz. Hats (5–14 kHz) and snare/kick-click transients are
// rejected. Short *tonal* stabs (staccato synth) are allowed through a faster
// "note" envelope. Envelope attack 220 ms, release 1.15 s.

export const MELODY_PAD = Object.freeze({
  loHz: 500,
  hiHz: 4000,
  midSplitHz: 1500,
  snareLoHz: 1800,
  snareHiHz: 4500,
  hatLoHz: 5000,
  hatHiHz: 14000,
  attackSec: 0.22,
  releaseSec: 1.15,
  contourAttackSec: 0.12,
  contourReleaseSec: 0.28,
  noteAttackSec: 0.08,
  noteReleaseSec: 0.22,
  peakHalfLifeSec: 5.0,
  floorHalfLifeSec: 14.0,
  medianWinSec: 0.40,
  noteWinSec: 0.10,
  confirmSec: 0.28,
  spikeRatio: 0.45,
  tonalMin: 0.40,
  crestMin: 1.75,
  onsetRefractorySec: 0.11,
  stabHoldSec: 0.040,
});

export const DEMO_DURATION = 54;
export const DEMO_SECTIONS = Object.freeze([
  { id: 'drums',    t0: 0,  t1: 6,  label: 'Drums only — arms stay down' },
  { id: 'swell',    t0: 6,  t1: 14, label: 'Slow pad swell' },
  { id: 'rise',     t0: 14, t1: 22, label: 'Rising melodic line' },
  { id: 'arpeggio', t0: 22, t1: 28, label: 'Staccato synth arpeggio' },
  { id: 'peak',     t0: 28, t1: 36, label: 'High strings crescendo — arms overhead' },
  { id: 'call',     t0: 36, t1: 42, label: 'Call and response' },
  { id: 'break',    t0: 42, t1: 46, label: 'Breakdown — drums only' },
  { id: 'build',    t0: 46, t1: 54, label: 'Final build — arms overhead' },
]);

export function demoSectionAt(tSec) {
  const t = ((+tSec % DEMO_DURATION) + DEMO_DURATION) % DEMO_DURATION;
  for (const s of DEMO_SECTIONS) if (t >= s.t0 && t < s.t1) return { ...s, t, local: t - s.t0 };
  return { ...DEMO_SECTIONS[DEMO_SECTIONS.length - 1], t, local: t - DEMO_SECTIONS[DEMO_SECTIONS.length - 1].t0 };
}

export function hann(n) {
  const w = new Float64Array(n);
  if (n < 2) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export function fftRadix2(c) {
  const n = c.length >>> 1;
  if (n < 2 || (n & (n - 1))) throw new Error('fft size must be a power of 2');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = i << 1, b = j << 1;
      const tr = c[a], ti = c[a + 1];
      c[a] = c[b]; c[a + 1] = c[b + 1];
      c[b] = tr; c[b + 1] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const p = (i + k) << 1;
        const q = (i + k + half) << 1;
        const rr = wr * c[q] - wi * c[q + 1];
        const ii = wr * c[q + 1] + wi * c[q];
        c[q] = c[p] - rr; c[q + 1] = c[p + 1] - ii;
        c[p] += rr; c[p + 1] += ii;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
  return c;
}

export function rfftMags(samples, window) {
  const n = samples.length;
  const c = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const w = window ? window[i] : 1;
    c[i * 2] = samples[i] * w;
    c[i * 2 + 1] = 0;
  }
  fftRadix2(c);
  const mags = new Float64Array((n >> 1) + 1);
  const scale = 2 / n;
  mags[0] = Math.abs(c[0]) / n;
  for (let i = 1; i < n >> 1; i++) {
    const re = c[i * 2], im = c[i * 2 + 1];
    mags[i] = Math.hypot(re, im) * scale;
  }
  mags[n >> 1] = Math.abs(c[n]) / n;
  return mags;
}

export function bytesFromMags(mags) {
  const out = new Uint8Array(mags.length);
  for (let i = 0; i < mags.length; i++) {
    const db = 20 * Math.log10(Math.max(1e-12, mags[i]));
    const v = Math.round(((db + 96) / 96) * 255);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

function magAt(spec, i, isByte) {
  const x = isByte ? spec[i] / 255 : spec[i];
  return x < 0 ? 0 : x;
}

function bandStats(magsOrBytes, hz, lo, hi, isByte) {
  const i0 = Math.max(1, Math.floor(lo / hz));
  const i1 = Math.min(magsOrBytes.length - 1, Math.ceil(hi / hz));
  if (i1 < i0) return { mean: 0, peak: 0, harmonic: 0, n: 0, nPeaks: 0, centroidHz: 0, peakHz: 0 };
  let sum = 0, peak = 0, peakI = i0, n = 0;
  const vs = [];
  for (let i = i0; i <= i1; i++) {
    const v = magAt(magsOrBytes, i, isByte);
    vs.push(v);
    sum += v;
    if (v > peak) { peak = v; peakI = i; }
    n++;
  }
  let harm = 0, wSum = 0, wfSum = 0, nPeaks = 0;
  const strong = Math.max(peak * 0.25, 1e-6);
  for (let k = 0; k < vs.length; k++) {
    const v = vs[k];
    const l = k > 0 ? vs[k - 1] : 0;
    const r = k < vs.length - 1 ? vs[k + 1] : 0;
    const isPeak = v >= l && v >= r && v > 1.15 * ((l + r) * 0.5 + 1e-9);
    if (isPeak && v >= strong) nPeaks++;
    const h = isPeak ? v : v * 0.22;
    harm += h;
    wSum += h;
    wfSum += h * ((i0 + k) * hz);
  }
  const mean = n ? sum / n : 0;
  return {
    mean, peak, harmonic: n ? harm / n : 0, n, nPeaks,
    centroidHz: wSum > 1e-12 ? wfSum / wSum : 0,
    peakHz: peakI * hz,
  };
}

function logContour(hz, lo, hi) {
  if (!(hz > 0)) return 0;
  const a = Math.log(Math.max(lo, hz) / lo);
  const b = Math.log(hi / lo);
  return Math.max(0, Math.min(1, a / Math.max(1e-6, b)));
}

export function createMelodyPadAnalyzer(opts = {}) {
  const C = { ...MELODY_PAD, ...opts };
  const hist = [];
  let now = 0;
  let env = 0, note = 0, peak = 0, notePeak = 0, floor = 0;
  let confirm = 0;
  let contour = 0.35, slowContour = 0.35, vibrato = 0;
  let onset = 0, lastOnset = -10, prevNote = 0, prevRawC = 0.35, stabHold = 0, pendingOnset = -1;
  let subLo = 0, subHi = 0, crescendo = 0, prevEnv = 0;
  let peakHz = 0;
  const winSec = C.medianWinSec || 0.40;
  const noteWin = C.noteWinSec || 0.10;
  const confirmSec = C.confirmSec || 0.28;
  const spikeRatio = C.spikeRatio == null ? 0.45 : C.spikeRatio;

  function percentile(vals, p) {
    if (!vals.length) return 0;
    const a = vals.slice().sort((x, y) => x - y);
    const i = Math.max(0, Math.min(a.length - 1, Math.floor(p * (a.length - 1))));
    return a[i];
  }

  function processSpectrum(spec, sampleRate, fftSize, dt, isByte) {
    const hz = sampleRate / fftSize;
    const pad = bandStats(spec, hz, C.loHz, C.hiHz, isByte);
    const low = bandStats(spec, hz, C.loHz, C.midSplitHz, isByte);
    const high = bandStats(spec, hz, C.midSplitHz, C.hiHz, isByte);
    const snare = bandStats(spec, hz, C.snareLoHz, C.snareHiHz, isByte);
    const hatHi = Math.min(C.hatHiHz, sampleRate * 0.49);
    const hat = hatHi > C.hatLoHz + 50
      ? bandStats(spec, hz, C.hatLoHz, hatHi, isByte)
      : { mean: 0, harmonic: 0 };
    const step = Math.max(1e-3, Math.min(0.25, dt || 1 / 60));
    now += step;

    const e = pad.harmonic;
    const crest = pad.mean > 1e-9 ? pad.peak / pad.mean : 1;
    const tonal = pad.mean > 1e-9 ? pad.harmonic / pad.mean : 0;
    const nPeaks = pad.nPeaks || 0;
    const tonalCand = now > 0.12 && pad.harmonic > 8e-5 && tonal >= C.tonalMin && crest >= C.crestMin && nPeaks >= 2 && nPeaks <= 16 && !(hat.mean > pad.harmonic * 2.2);
    // Clicks and snares are brief; require ~40 ms of continuous tone (staccato 16ths still pass).
    if (tonalCand) stabHold += step; else stabHold = 0;
    const tonalStab = stabHold >= (C.stabHoldSec || 0.040);

    hist.push({ t: now, e, lo: low.harmonic, hi: high.harmonic, cHz: pad.centroidHz, pHz: pad.peakHz, tonal, tonalStab });
    const cutoff = now - winSec;
    while (hist.length && hist[0].t < cutoff) hist.shift();

    const vals = hist.map((h) => h.e);
    const p30 = percentile(vals, 0.30);
    let mean = 0;
    for (const v of vals) mean += v;
    mean = vals.length ? mean / vals.length : 0;
    const spiked = mean > 1e-12 && p30 < spikeRatio * mean;
    const sustained = spiked ? 0 : p30;

    if (sustained > 1e-7) confirm = Math.min(confirmSec, confirm + step);
    else confirm = Math.max(0, confirm - step * 1.6);
    const confirmed = confirm >= confirmSec * 0.92;

    if (confirmed && sustained > peak) peak = sustained;
    else peak *= Math.exp(-step * Math.LN2 / C.peakHalfLifeSec);

    let target = 0;
    if (confirmed && peak > 1e-8) target = Math.max(0, Math.min(1, sustained / (peak * 0.92)));
    const tau = target > env ? C.attackSec : C.releaseSec;
    env += (1 - Math.exp(-step / Math.max(1e-3, tau))) * (target - env);
    if (env < 0.002) env = 0;

    // Faster tonal "note" layer: catches staccato synth without opening for snares.
    const short = hist.filter((h) => h.t >= now - noteWin);
    const shortP = percentile(short.map((h) => h.e), 0.40);
    let noteTarget = 0;
    if (confirmed) noteTarget = target;
    else if (tonalStab && shortP > 3e-5) {
      if (shortP > notePeak) notePeak = shortP;
      const locPeak = Math.max(notePeak, 3e-5);
      noteTarget = Math.max(0, Math.min(1, shortP / (locPeak * 0.90)));
    }
    notePeak *= Math.exp(-step * Math.LN2 / 6);
    const nTau = noteTarget > note ? C.noteAttackSec : C.noteReleaseSec;
    note += (1 - Math.exp(-step / Math.max(1e-3, nTau))) * (noteTarget - note);
    if (note < 0.002) note = 0;

    const fluxNote = Math.max(0, note - prevNote);
    const rawC = logContour(pad.centroidHz || pad.peakHz, C.loHz, C.hiHz);
    const pitchJump = tonalStab && pad.centroidHz > 0 && Math.abs(rawC - prevRawC) > 0.08;
    if (pad.centroidHz > 0) prevRawC = rawC;
    const flux = hist.length >= 2 ? Math.max(0, e - hist[hist.length - 2].e) : 0;
    const fluxRel = e > 1e-6 ? flux / e : 0;
    // Prefer attacks that rise out of a quieter 100 ms window (staccato notes),
    // not clicks on top of an already-held pad (kicks under a swell).
    const noteAttack = fluxRel > 0.4 && e > 8e-5 && shortP < 0.55 * e;
    if (noteAttack || (tonalCand && (fluxNote > 0.08 || pitchJump))) {
      pendingOnset = now;
    }
    if (pendingOnset >= 0 && now - pendingOnset > 0.09) pendingOnset = -1;
    if (tonalStab && pendingOnset >= 0 && (now - lastOnset) > C.onsetRefractorySec) {
      onset = 1;
      lastOnset = now;
      pendingOnset = -1;
    } else {
      onset *= Math.exp(-step / 0.16);
      if (onset < 0.02) onset = 0;
    }
    prevNote = note;

    // Melodic contour from harmonic-weighted centroid, only while a tone is present.
    const voice = confirmed || (tonalStab && note > 0.18);
    if (voice && (pad.centroidHz > 0)) {
      const cTau = rawC > contour ? C.contourAttackSec : C.contourReleaseSec;
      contour += (1 - Math.exp(-step / Math.max(1e-3, cTau))) * (rawC - contour);
      peakHz = pad.peakHz || peakHz;
    } else {
      contour += (1 - Math.exp(-step / 0.80)) * (0.35 - contour);
    }
    slowContour += (1 - Math.exp(-step / 1.15)) * (contour - slowContour);
    const vibRaw = (contour - slowContour) * 6;
    vibrato += (1 - Math.exp(-step / 0.07)) * (Math.max(-1, Math.min(1, vibRaw)) - vibrato);

    const loVals = hist.map((h) => h.lo);
    const hiVals = hist.map((h) => h.hi);
    const loS = spiked ? 0 : percentile(loVals, 0.30);
    const hiS = spiked ? 0 : percentile(hiVals, 0.30);
    const denom = Math.max(1e-8, loS + hiS);
    const loT = (confirmed || tonalStab) ? loS / Math.max(1e-8, (loS + hiS) * 0.5 + peak * 0.5) : 0;
    const hiT = (confirmed || tonalStab) ? hiS / Math.max(1e-8, (loS + hiS) * 0.5 + peak * 0.5) : 0;
    void denom;
    subLo += (1 - Math.exp(-step / 0.16)) * (Math.max(0, Math.min(1, loT)) - subLo);
    subHi += (1 - Math.exp(-step / 0.16)) * (Math.max(0, Math.min(1, hiT)) - subHi);

    const dEnv = (env - prevEnv) / Math.max(step, 1e-3);
    const cresT = Math.max(0, Math.min(1, dEnv / 0.7));
    crescendo += (1 - Math.exp(-step / 0.28)) * (cresT - crescendo);
    prevEnv = env;

    floor = p30;
    return {
      env, note, raw: sustained, energy: e, sustained, flux,
      snr: mean > 1e-12 ? p30 / mean : 0,
      snareFlux: snare.mean, hatFlux: hat.mean, trans: spiked && !tonalStab ? 1 : 0,
      crest, tonal, target, floor, peak, confirm, confirmed, tonalStab, nPeaks,
      contour, vibrato, onset, subLo, subHi, crescendo,
      centroidHz: pad.centroidHz, peakHz, section: '',
    };
  }

  return {
    constants: C,
    processBytes(bytes, sampleRate, fftSize, dt) {
      if (!bytes || bytes.length < 8) {
        return processSpectrum(new Uint8Array(8), sampleRate || 44100, fftSize || 16, dt, true);
      }
      return processSpectrum(bytes, sampleRate, fftSize, dt, true);
    },
    processMags(mags, sampleRate, fftSize, dt) {
      return processSpectrum(mags, sampleRate, fftSize, dt, false);
    },
    snapshot() { return { env, note, peak, floor, now, confirm, contour, vibrato, onset, subLo, subHi }; },
    reset() {
      hist.length = 0;
      now = 0;
      env = note = peak = notePeak = floor = 0;
      confirm = 0;
      contour = slowContour = 0.35;
      vibrato = onset = subLo = subHi = crescendo = 0;
      lastOnset = -10; prevNote = 0; prevEnv = 0; peakHz = 0; stabHold = 0; prevRawC = 0.35; pendingOnset = -1;
    },
    setEnv(v) { env = Math.max(0, Math.min(1, +v || 0)); },
  };
}

function fade(x) {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
}

// Scripted features for the in-sim "Demo music" control (file:// safe).
// Timings match DEMO_SECTIONS / the generated demo track.
export function demoMusicFeatures(tSec) {
  const sec = demoSectionAt(tSec);
  const t = sec.t;
  const z = {
    env: 0, note: 0, contour: 0.35, vibrato: 0, onset: 0,
    subLo: 0, subHi: 0, crescendo: 0, target: 0, confirmed: false,
    trans: 0, section: sec.label, sectionId: sec.id,
    centroidHz: 0, peakHz: 0,
  };
  const pulse = (phase, width) => {
    const d = ((phase % 1) + 1) % 1;
    return d < width ? 1 - d / width : 0;
  };

  if (sec.id === 'drums' || sec.id === 'break') return z;

  if (sec.id === 'swell') {
    const u = fade(sec.local / 5.0);
    z.env = u * 0.72; z.note = z.env;
    z.contour = 0.22 + 0.08 * u;
    z.subLo = z.env; z.subHi = z.env * 0.35;
    z.crescendo = sec.local < 5.5 ? 0.55 * (1 - sec.local / 8) : 0.1;
    z.vibrato = 0.12 * u * Math.sin(t * 2 * Math.PI * 0.35);
    z.confirmed = z.env > 0.2;
  } else if (sec.id === 'rise') {
    const u = sec.local / 8;
    z.env = 0.78; z.note = 0.8;
    z.contour = 0.28 + 0.62 * fade(u);
    z.subLo = 0.7 * (1 - u); z.subHi = 0.35 + 0.65 * u;
    z.crescendo = 0.35;
    z.vibrato = 0.2 * Math.sin(t * 2 * Math.PI * 5.5);
    // gentle note-change accents each second
    z.onset = pulse(sec.local, 0.12);
    z.confirmed = true;
  } else if (sec.id === 'arpeggio') {
    z.env = 0.45; z.note = 0.55 + 0.35 * Math.abs(Math.sin(sec.local * Math.PI * 4));
    const stepN = Math.floor(sec.local / 0.125) % 4;
    z.contour = 0.30 + stepN * 0.14;
    z.onset = pulse(sec.local / 0.125, 0.35);
    z.subLo = stepN < 2 ? 0.8 : 0.25;
    z.subHi = stepN < 2 ? 0.25 : 0.8;
    z.vibrato = 0.08;
    z.confirmed = true;
  } else if (sec.id === 'peak') {
    const u = fade(Math.min(1, sec.local / 5.5));
    z.env = 0.82 + 0.18 * u;
    z.note = z.env;
    z.contour = 0.72 + 0.26 * u;
    z.subLo = 0.3; z.subHi = z.env;
    z.crescendo = sec.local < 6 ? 0.85 : 0.15;
    z.vibrato = 0.18 * Math.sin(t * 2 * Math.PI * 5.8);
    z.confirmed = true;
  } else if (sec.id === 'call') {
    const bar = Math.floor(sec.local / 1.0) % 2; // 0 call (low), 1 response (high)
    const inN = sec.local % 1.0;
    z.env = 0.62; z.note = 0.7;
    z.contour = bar === 0 ? 0.28 + 0.1 * inN : 0.72 + 0.12 * inN;
    z.subLo = bar === 0 ? 0.9 : 0.2;
    z.subHi = bar === 0 ? 0.2 : 0.9;
    z.onset = pulse(inN, 0.18);
    z.vibrato = 0.12;
    z.confirmed = true;
  } else if (sec.id === 'build') {
    const u = fade(Math.min(1, sec.local / 4.2));
    const fall = sec.local > 5.5 ? fade((sec.local - 5.5) / 2.5) : 0;
    z.env = Math.max(0, (0.7 + 0.3 * u) * (1 - fall));
    z.note = z.env;
    z.contour = (0.55 + 0.42 * u) * (1 - 0.4 * fall);
    z.subLo = 0.4 * z.env; z.subHi = z.env;
    z.crescendo = fall ? 0 : 0.8;
    z.vibrato = 0.16 * z.env * Math.sin(t * 2 * Math.PI * 5.6);
    z.onset = u > 0.2 && !fall ? pulse(sec.local, 0.1) : 0;
    z.confirmed = z.env > 0.15;
  }
  z.target = z.env;
  z.centroidHz = 500 * Math.pow(4000 / 500, z.contour);
  z.peakHz = z.centroidHz;
  return z;
}

export function demoPadEnvelope(tSec) {
  return demoMusicFeatures(tSec).env;
}
