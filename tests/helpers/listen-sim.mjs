// Offline Listen harness (TJ 6:45 PM, per-band timing).
// Synthesizes drum/bass/pad audio with known hit times, emulates the Web
// Audio AnalyserNode byte spectrum (Blackman window, dB → byte), steps it at
// the live page's frame cadence, and scores each band's onsets/beats.

export const SR = 48000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Biquad (RBJ) in place.
function biquad(buf, type, f0, q, sr = SR) {
  const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; } // band-pass (0 dB peak)
  a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
  return buf;
}

function addAt(out, src, start, gain = 1) {
  const s0 = Math.round(start * SR);
  for (let i = 0; i < src.length; i++) {
    const j = s0 + i;
    if (j >= 0 && j < out.length) out[j] += src[i] * gain;
  }
}

export function kickSample(rand) {
  const n = Math.round(0.35 * SR), b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 48 + 110 * Math.exp(-t / 0.028);
    ph += 2 * Math.PI * f / SR;
    b[i] = Math.sin(ph) * Math.exp(-t / 0.16) * Math.min(1, t / 0.0015);
  }
  // Beater click: 3 ms of high-passed noise.
  const click = new Float32Array(Math.round(0.003 * SR));
  for (let i = 0; i < click.length; i++) click[i] = (rand() * 2 - 1) * (1 - i / click.length);
  biquad(click, 'hp', 2500, 0.7);
  for (let i = 0; i < click.length; i++) b[i] += click[i] * 0.25;
  return b;
}

export function bassSample(freq) {
  const n = Math.round(0.24 * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 0.004) * Math.exp(-t / 0.12);
    // Saw-ish bass: fundamental plus a few harmonics.
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h;
    b[i] = v * env * 0.5;
  }
  return biquad(b, 'lp', 420, 0.7);
}

export function snareSample(rand) {
  const n = Math.round(0.22 * SR), noise = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;
  biquad(noise, 'bp', 1800, 0.9);
  biquad(noise, 'lp', 3500, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    b[i] = (noise[i] * 1.6 * Math.exp(-t / 0.07) + Math.sin(2 * Math.PI * 190 * t) * 0.35 * Math.exp(-t / 0.05)) * Math.min(1, t / 0.001);
  }
  return b;
}

export function hatSample(rand) {
  const n = Math.round(0.09 * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = rand() * 2 - 1;
  biquad(b, 'hp', 7000, 0.7);
  biquad(b, 'hp', 7000, 0.7);
  for (let i = 0; i < n; i++) b[i] *= Math.exp(-(i / SR) / 0.025) * 0.55;
  return b;
}

// Sustained pad (vocal-ish) with vibrato: should not fire anything by itself.
function addPad(out, t0, t1, rand) {
  const s0 = Math.round(t0 * SR), s1 = Math.min(out.length, Math.round(t1 * SR));
  const notes = [220, 277.2, 329.6, 440];
  for (let i = s0; i < s1; i++) {
    const t = i / SR, fade = Math.min(1, (t - t0) / 0.8, (t1 - t) / 0.8);
    let v = 0;
    for (const f of notes) v += Math.sin(2 * Math.PI * f * t + 0.004 * f * Math.sin(2 * Math.PI * 5.5 * t));
    out[i] += v * 0.018 * Math.max(0, fade);
  }
}

// events: {band, t} — band 0 kick, 1 bass, 2 snare/mid, 3 hat.
export function render(events, duration, {pad = [], seed = 7, noise = 0.0015, gains = [0.9, 0.6, 0.55, 0.35]} = {}) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(duration * SR));
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * noise; // room hiss
  for (const [a, b] of pad) addPad(out, a, b, rand);
  for (const e of events) {
    const g = gains[e.band] * (e.gain || 1) * (0.85 + rand() * 0.3);
    const s = e.band === 0 ? kickSample(rand) : e.band === 1 ? bassSample(e.freq || 98) : e.band === 2 ? snareSample(rand) : hatSample(rand);
    addAt(out, s, e.t, g);
  }
  return out;
}

// Groove: four-on-the-floor kick, snare on 2 & 4, hats on 8ths, bass on the "and"s.
export function groove(t0, t1, bpm, {kick = [0, 1, 2, 3], snare = [1, 3], hat8 = true, bass = [0.5, 1.5, 2.5, 3.5]} = {}) {
  const beat = 60 / bpm, ev = [];
  for (let bar = t0; bar < t1 - 1e-6; bar += beat * 4) {
    for (const b of kick) if (bar + b * beat < t1) ev.push({band: 0, t: bar + b * beat});
    for (const b of snare) if (bar + b * beat < t1) ev.push({band: 2, t: bar + b * beat});
    for (const b of bass) if (bar + b * beat < t1) ev.push({band: 1, t: bar + b * beat, freq: 147});
    if (hat8) for (let k = 0; k < 8; k++) if (bar + k * beat / 2 < t1) ev.push({band: 3, t: bar + k * beat / 2});
  }
  return ev;
}

export const SCENARIOS = {
  steady120: () => ({duration: 16, events: groove(0.5, 16, 120), pad: [[0, 16]]}),
  tempoChange: () => ({duration: 18, events: groove(0.5, 9, 100).concat(groove(9, 18, 128)), pad: [[0, 18]]}),
  silenceGap: () => ({duration: 17, events: groove(0.5, 6, 112).concat(groove(11, 17, 112)), pad: [[0, 6], [11, 17]], silence: [6.3, 11]}),
  quiet: () => ({duration: 14, events: groove(0.5, 14, 104), pad: [[0, 14]], gain: 0.25}),
  syncopated: () => ({duration: 16, events: groove(0.5, 16, 96, {kick: [0, 1.5, 2], snare: [1, 3], bass: [0, 0.75, 2.5, 3.25]}), pad: [[0, 16]]})
};

// --- AnalyserNode emulation (Web Audio spec: Blackman, |X|/N, dB, bytes) ---
export function createAnalyser(fftSize = 2048, minDb = -96, maxDb = -24) {
  const N = fftSize, half = N / 2;
  const win = new Float64Array(N);
  for (let n = 0; n < N; n++) win[n] = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / N) + 0.08 * Math.cos(4 * Math.PI * n / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const rev = new Uint32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const bytes = new Uint8Array(half);
  function fft() {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const h = size >> 1, step = -2 * Math.PI / size;
      for (let s = 0; s < N; s += size) for (let k = 0; k < h; k++) {
        const c = Math.cos(step * k), d = Math.sin(step * k);
        const a = s + k, b = a + h;
        const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  return {
    fftSize: N,
    frequencyBinCount: half,
    bytes,
    // Spectrum of the N samples ending at sample index end (exclusive).
    at(signal, end) {
      for (let n = 0; n < N; n++) { const i = end - N + n; re[n] = (i >= 0 && i < signal.length ? signal[i] : 0) * win[n]; im[n] = 0; }
      fft();
      const scale = 255 / (maxDb - minDb);
      for (let k = 0; k < half; k++) {
        const mag = Math.hypot(re[k], im[k]) / N;
        const db = mag > 0 ? 20 * Math.log10(mag) : -1000;
        bytes[k] = Math.max(0, Math.min(255, Math.floor(scale * (db - minDb))));
      }
      return bytes;
    }
  };
}

// Live-page cadence: setTimeout(1000/30 - cost) then rAF on a 60 Hz display.
export function frameTimes(durationMs, {seed = 3, vsync = 1000 / 60, jank = 0.06} = {}) {
  const rand = rng(seed), out = [];
  let t = 50 + rand() * 33;
  while (t < durationMs) {
    out.push(t);
    t += vsync * (rand() < jank ? 3 : 2) + (rand() - 0.5) * 2;
  }
  return out;
}

// Exact JS port of the shipped wasm detect_onsets (legacy baseline).
export function createLegacyDetector() {
  const LO = [40, 120, 300, 5000], HI = [120, 300, 2500, 14000];
  const RATIO = [1.8, 1.75, 1.6, 1.5], MIN = [10, 9, 8, 8], REF = [150, 160, 110, 90];
  const HIST = 16, WARM = 6;
  let prev = null;
  const bands = LO.map(() => ({hist: [], last: -1e300, samples: 0}));
  return {
    process(bytes, sampleRate, fftSize, now, open) {
      const spec = open ? bytes : new Uint8Array(bytes.length);
      if (!prev) { prev = Uint8Array.from(spec); return 0; }
      const hz = sampleRate / fftSize;
      let mask = 0;
      for (let b = 0; b < 4; b++) {
        let i0 = Math.max(1, Math.ceil(LO[b] / hz - 1e-4)), i1 = Math.min(spec.length - 1, Math.ceil(HI[b] / hz - 1e-4) - 1);
        let peak = 0;
        for (let i = i0; i <= i1; i++) { const d = spec[i] - prev[i]; if (d > peak) peak = d; }
        for (let i = i0; i <= i1; i++) prev[i] = spec[i];
        const B = bands[b];
        const sorted = B.hist.slice().sort((x, y) => x - y);
        const n = sorted.length, med = n ? (n & 1 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
        B.samples++;
        const thr = MIN[b] + med * RATIO[b];
        if (B.samples > WARM && peak > thr && now - B.last >= REF[b]) { B.last = now; mask |= 1 << b; }
        B.hist.push(peak); if (B.hist.length > HIST) B.hist.shift();
      }
      return mask;
    }
  };
}

// Score detections {band, t} against truth {band, t}. Window ±tolMs.
export function score(truth, found, band, {tolMs = 70, from = 0, to = Infinity, skipFirstMs = 0} = {}) {
  const T = truth.filter(e => e.band === band && e.t * 1000 >= from + skipFirstMs && e.t * 1000 < to).map(e => e.t * 1000);
  const F = found.filter(e => e.band === band && e.t >= from + skipFirstMs && e.t < to).map(e => e.t).sort((a, b) => a - b);
  const used = new Uint8Array(F.length);
  const errs = [];
  for (const t of T) {
    let best = -1, bd = tolMs;
    for (let i = 0; i < F.length; i++) { if (used[i]) continue; const d = Math.abs(F[i] - t); if (d <= bd) { bd = d; best = i; } }
    if (best >= 0) { used[best] = 1; errs.push(F[best] - t); }
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const med = abs.length ? abs[abs.length >> 1] : NaN;
  const signed = errs.slice().sort((a, b) => a - b);
  return {
    truth: T.length,
    hits: errs.length,
    misses: T.length - errs.length,
    falsePositives: F.length - errs.length,
    medianAbsMs: med,
    medianSignedMs: signed.length ? signed[signed.length >> 1] : NaN,
    p90AbsMs: abs.length ? abs[Math.floor(abs.length * 0.9)] : NaN
  };
}

// Drive a detector through a scenario with the live page's silence gate.
export function run(detector, scenario, {gate = null, fftSize = 2048, frames = null, sens = [1, 1, 1, 1]} = {}) {
  const {duration, events} = scenario;
  const audio = render(events, duration, {pad: scenario.pad || [], gains: [0.9, 0.6, 0.55, 0.35].map(g => g * (scenario.gain || 1))});
  const an = createAnalyser(fftSize);
  const times = frames || frameTimes(duration * 1000);
  const onsets = [], beats = [], timeline = [];
  let last = times[0];
  for (const now of times) {
    const bytes = an.at(audio, Math.floor(now / 1000 * SR));
    let open = true;
    if (gate) {
      const peaks = gate.lib.bandPeaks(bytes, SR, fftSize);
      gate.lib.scale(gate.state, peaks, Math.max(0.001, (now - last) / 1000));
      open = gate.state.open;
    }
    const out = detector.process(bytes, SR, fftSize, now, open, sens);
    const mask = typeof out === 'number' ? out : out.beats;
    const onsetMask = typeof out === 'number' ? out : out.onsets;
    for (let b = 0; b < 4; b++) {
      if (mask & (1 << b)) beats.push({band: b, t: now});
      if (onsetMask & (1 << b)) onsets.push({band: b, t: typeof out === 'number' ? now : out.onsetTime[b]});
    }
    timeline.push({now, open, mask});
    last = now;
  }
  return {onsets, beats, timeline, events};
}
