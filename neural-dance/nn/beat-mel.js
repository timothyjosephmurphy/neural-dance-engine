// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Streaming log-mel front end matching Beat This! (CPJKU, MIT) LogMelSpect:
// 22050 Hz mono, n_fft 1024, hop 441 (50 frames/s), periodic Hann, |STFT|
// scaled by 1/sqrt(n_fft), 128 Slaney mel bands 30-11000 Hz (no norm),
// log1p(1000 * mel). Input at any sample rate is resampled with a windowed
// sinc. Pure JS, no allocation per frame.

export const SR = 22050, N_FFT = 1024, HOP = 441, N_MELS = 128, FPS = SR / HOP;

function hzToMelSlaney(f) {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp;
}
function melToHzSlaney(m) {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
}
// torchaudio.functional.melscale_fbanks(513, 30, 11000, 128, 22050, norm=None, mel_scale='slaney')
export function melFilterbank(nFreqs = N_FFT / 2 + 1, fMin = 30, fMax = 11000, nMels = N_MELS, sr = SR) {
  const allFreqs = new Float64Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) allFreqs[i] = (sr / 2) * i / (nFreqs - 1);
  const mMin = hzToMelSlaney(fMin), mMax = hzToMelSlaney(fMax);
  const fPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) fPts[i] = melToHzSlaney(mMin + (mMax - mMin) * i / (nMels + 1));
  const fb = new Float32Array(nFreqs * nMels); // [freq][mel]
  for (let m = 0; m < nMels; m++) {
    const fd0 = fPts[m + 1] - fPts[m], fd1 = fPts[m + 2] - fPts[m + 1];
    for (let i = 0; i < nFreqs; i++) {
      const down = (allFreqs[i] - fPts[m]) / fd0, up = (fPts[m + 2] - allFreqs[i]) / fd1;
      const v = Math.max(0, Math.min(down, up));
      fb[i * nMels + m] = v;
    }
  }
  return fb;
}

// In-place radix-2 complex FFT.
function makeFft(n) {
  const rev = new Uint32Array(n); const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// Streaming windowed-sinc resampler (any rate -> 22050 Hz), polyphase table.
export function createResampler(inRate, outRate = SR, zeros = 16, phases = 512) {
  const ratio = inRate / outRate;               // input samples per output sample
  const cutoff = Math.min(1, outRate / inRate) * 0.94;
  const half = Math.ceil(zeros / cutoff), taps = 2 * half;
  const table = new Float32Array((phases + 1) * taps);
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases; let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = (j - half + 1) - frac, w = 0.5 + 0.5 * Math.cos(Math.PI * x / (half + 1));
      const h = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x) * w;
      table[p * taps + j] = h; sum += h;
    }
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  const buf = new Float32Array(1 << 16); let len = 0, pos = half;
  let out = new Float32Array(4096);
  return {
    // Returns a view of the new output samples (valid until the next call).
    push(input) {
      if (len + input.length > buf.length) { const keep = Math.floor(pos) - half; buf.copyWithin(0, keep, len); len -= keep; pos -= keep; }
      buf.set(input, len); len += input.length;
      const need = Math.ceil(input.length / ratio) + 4; if (out.length < need) out = new Float32Array(need);
      let n = 0;
      while (pos + half + 1 < len) {
        const c = Math.floor(pos), p = Math.round((pos - c) * phases), o = p * taps, base = c - half + 1;
        let s = 0; for (let j = 0; j < taps; j++) s += buf[base + j] * table[o + j];
        out[n++] = s; pos += ratio;
      }
      return out.subarray(0, n);
    }
  };
}

// Mel frame stream. push(samples22k) calls onFrame(melFrame Float32Array(128)) per hop.
export function createMelStream(onFrame) {
  const fb = melFilterbank(); const fft = makeFft(N_FFT);
  const win = new Float64Array(N_FFT); for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
  const ring = new Float32Array(N_FFT + HOP * 64); let n = N_FFT / 2; // center=True: half-window of leading zeros
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), mag = new Float64Array(N_FFT / 2 + 1);
  const mel = new Float32Array(N_MELS); const scale = 1 / Math.sqrt(N_FFT);
  return {
    push(x) {
      let i = 0;
      while (i < x.length) {
        const take = Math.min(x.length - i, ring.length - n);
        ring.set(x.subarray(i, i + take), n); n += take; i += take;
        while (n >= N_FFT) {
          for (let k = 0; k < N_FFT; k++) { re[k] = ring[k] * win[k]; im[k] = 0; }
          fft(re, im);
          for (let k = 0; k <= N_FFT / 2; k++) mag[k] = Math.hypot(re[k], im[k]) * scale;
          mel.fill(0);
          for (let k = 0; k <= N_FFT / 2; k++) { const v = mag[k]; if (!v) continue; const row = k * N_MELS; for (let m = 0; m < N_MELS; m++) { const w = fb[row + m]; if (w) mel[m] += v * w; } }
          for (let m = 0; m < N_MELS; m++) mel[m] = Math.log1p(1000 * mel[m]);
          onFrame(mel);
          ring.copyWithin(0, HOP, n); n -= HOP;
        }
      }
    }
  };
}
