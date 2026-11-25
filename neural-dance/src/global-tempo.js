// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Global song tempo for Listen (TJ 7:43 PM: "BPM ... fluctuates between 50
// and 200. It should figure it out pretty quickly for the song").
//
// Onset-strength envelope = the per-band spectral flux band-onsets already
// computes (each band normalised by its own running level, summed), binned
// at 10 ms over the last 6 s. Every 250 ms: autocorrelation, a comb over
// 1x/2x/3x/4x the lag (so the true beat beats its half/double), a
// log-Gaussian tempo prior around 120 BPM (70-180 BPM), parabolic peak
// refinement. Lock once ~2.5 s of estimates agree; once locked a different
// tempo (>8% away, not just its half/double/2:3) must hold for ~4 s before
// the lock moves. A PLL on band onsets keeps the beat phase.
// Per-frame work: a few adds; per estimate ~0.15 M multiply-adds.

const BIN_MS = 10;
const WIN = 600;               // 6 s
const MIN_LAG = 30, MAX_LAG = 100; // 600..200 BPM -> 200..60 BPM
const EST_EVERY_MS = 250;
const PRIOR_BPM = 120, PRIOR_OCT = 0.55;
const MIN_BPM = 70, MAX_BPM = 180;
const CHANGE_MARGIN = 1.3; // a new tempo must explain the music this much better
const LOCK_AGREE = 0.04, LOCK_SPAN_MS = 2000, LOCK_MIN_CONF = 0.08;
const CHANGE_TOL = 0.08, CHANGE_HOLD_MS = 4000;
const SILENCE_HOLD_MS = 10000; // longer silence: keep the lock, but the next song may re-confirm it
const BAND_W = [1, 0.7, 0.9, 0.5];
const PHASE_W = [1, 0.6, 0.8, 0.35];
const EQUIV = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3];

function prior(bpm) {
  if (!(bpm >= 50 && bpm <= 240)) return 0;
  const o = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCT;
  const soft = Math.exp(-0.5 * o * o);
  return bpm < MIN_BPM || bpm > MAX_BPM ? soft * 0.35 : soft;
}

// a and b are the same tempo up to a simple ratio (half/double/2:3...).
export function tempoRelation(a, b, tol = 0.05) {
  if (!(a > 0) || !(b > 0)) return 0;
  for (const r of EQUIV) if (Math.abs(Math.log(a / (b * r))) < tol) return r;
  return 0;
}

export function createGlobalTempo() {
  const env = new Float32Array(WIN);
  const x = new Float32Array(WIN);
  const acf = new Float32Array(4 * MAX_LAG + 2);
  const score = new Float32Array(MAX_LAG + 2);
  const norm = new Float32Array(4);
  let lastBin = -1, lastEst = -1e12, firstSound = -1, lastSound = -1e12, resumed = false, resumeAt = -1;
  const hist = []; // {t, bpm, conf}
  const shown = []; // {t, bpm} for the 10 s std
  const out = {bpm: 0, period: 0, locked: false, conf: 0, estimate: 0, timeToLockMs: 0, lockedAt: -1,
    std10: 0, next: 0, beat: false, candidate: 0, held: false};
  let cand = 0, candSince = -1;

  function reset() {
    env.fill(0); lastBin = -1; lastEst = -1e12; firstSound = -1; lastSound = -1e12; norm.fill(0); resumed = false; resumeAt = -1;
    hist.length = 0; shown.length = 0; cand = 0; candSince = -1;
    Object.assign(out, {bpm: 0, period: 0, locked: false, conf: 0, estimate: 0, timeToLockMs: 0, lockedAt: -1, std10: 0, next: 0, beat: false, candidate: 0, held: false});
  }

  function addFrame(now, flux, open) {
    const bin = Math.floor(now / BIN_MS);
    if (lastBin < 0) lastBin = bin - 1;
    if (bin - lastBin > WIN) { env.fill(0); lastBin = bin - 1; }
    for (let b = lastBin + 1; b <= bin; b++) env[((b % WIN) + WIN) % WIN] = 0;
    lastBin = Math.max(lastBin, bin);
    if (!open || !flux) return 0;
    let o = 0;
    for (let b = 0; b < 4; b++) {
      const f = +flux[b] > 0 ? +flux[b] : 0;
      // Running level per band (~3 s) so a loud kick cannot drown the hats.
      norm[b] += (f - norm[b]) * 0.02;
      if (norm[b] > 1e-3) o += BAND_W[b] * Math.min(6, f / (norm[b] * 3 + 1e-3));
    }
    const i = ((bin % WIN) + WIN) % WIN;
    if (o > env[i]) env[i] = o;
    if (o > 0.05) { if (firstSound < 0) firstSound = now; lastSound = now; }
    return o;
  }

  function estimate(now) {
    // Only the part of the window that has heard sound (fast first lock).
    const n = Math.min(WIN, Math.max(0, Math.floor((now - firstSound) / BIN_MS)));
    if (n < 150) return null;
    const off = WIN - n;
    // Oldest -> newest, light smoothing (frames land 16-33 ms apart).
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const k = (((lastBin - n + 1 + i) % WIN) + WIN) % WIN;
      const a = env[(k - 1 + WIN) % WIN], c = env[k], d = env[(k + 1) % WIN];
      x[i] = 0.25 * a + 0.5 * c + 0.25 * d;
      mean += x[i];
    }
    mean /= n;
    let e0 = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; e0 += x[i] * x[i]; }
    if (!(e0 > 1e-6)) return null;
    const maxL = Math.min(4 * MAX_LAG, n - Math.max(50, n >> 2));
    for (let L = MIN_LAG >> 1; L <= maxL; L++) {
      let s = 0;
      for (let i = L; i < n; i++) s += x[i] * x[i - L];
      acf[L] = s / (e0 * (n - L) / n);
    }
    void off;
    const at = L => { const f = Math.floor(L), u = L - f; return f + 1 <= maxL ? acf[f] * (1 - u) + acf[f + 1] * u : 0; };
    let best = 0, bestS = -1e9;
    for (let L = MIN_LAG; L <= MAX_LAG; L++) {
      let s = acf[L], w = 1;
      for (let k = 2; k <= 4 && k * L <= maxL; k++) { s += at(k * L) / k; w += 1 / k; }
      s /= w;
      score[L] = s;
      const v = s * prior(60000 / (L * BIN_MS));
      if (v > bestS) { bestS = v; best = L; }
    }
    if (!(score[best] > 0)) return null;
    // Parabolic refinement on the raw comb score.
    let L = best;
    if (best > MIN_LAG && best < MAX_LAG) {
      const a = score[best - 1], b = score[best], c = score[best + 1], den = a - 2 * b + c;
      if (den < 0) L = best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    // How well the current lock still explains the music (best of its octave family).
    let held = 0;
    if (out.locked) {
      const lag = out.period / BIN_MS;
      for (const f of [1, 0.5, 2]) {
        const q = Math.round(lag * f);
        if (q >= MIN_LAG && q <= MAX_LAG) held = Math.max(held, Math.max(score[q - 1] || 0, score[q], score[q + 1] || 0) * prior(60000 / (q * BIN_MS)));
      }
    }
    return {bpm: 60000 / (L * BIN_MS), conf: Math.max(0, Math.min(1, score[best])), margin: held > 0 ? bestS / held : 99};
  }

  function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; }

  function decide(now, est) {
    if (est) hist.push({t: now, bpm: est.bpm, conf: est.conf});
    while (hist.length && now - hist[0].t > 8000) hist.shift();
    out.estimate = est ? Math.round(est.bpm * 10) / 10 : 0;
    out.conf = est ? Math.round(est.conf * 100) / 100 : out.conf * 0.9;
    if (!out.locked) {
      const recent = hist.filter(h => now - h.t <= LOCK_SPAN_MS && h.conf >= LOCK_MIN_CONF);
      if (recent.length >= Math.floor(LOCK_SPAN_MS / EST_EVERY_MS) - 1) {
        const m = median(recent.map(h => h.bpm));
        // Most of the last ~2.5 s agree (one odd estimate does not block it).
        if (recent.filter(h => Math.abs(h.bpm / m - 1) <= LOCK_AGREE).length >= 0.8 * recent.length) {
          setLocked(now, m);
          if (out.timeToLockMs === 0 && firstSound >= 0) out.timeToLockMs = Math.round(now - firstSound);
        }
      }
      return;
    }
    if (!est || est.conf < LOCK_MIN_CONF * 0.5) return;
    if (resumed && (resumeAt < 0 || now - resumeAt < WIN * BIN_MS)) return; // window still holds silence
    const rel = tempoRelation(est.bpm, out.bpm, CHANGE_TOL);
    if (rel === 1) {
      // Same tempo: follow slow drift gently; drop any change candidate.
      out.bpm += (est.bpm - out.bpm) * 0.08;
      out.period = 60000 / out.bpm;
      cand = 0; candSince = -1; resumed = false;
      return;
    }
    if (rel) { resumed = false; return; } // half / double / 2:3 of the lock: same song tempo
    // The lock still fits nearly as well: noisy music, not a tempo change.
    if (!resumed && est.margin < CHANGE_MARGIN) { cand = 0; candSince = -1; out.candidate = 0; return; }
    if (cand > 0 && Math.abs(est.bpm / cand - 1) <= LOCK_AGREE * 1.5) {
      cand += (est.bpm - cand) * 0.2;
      if (now - candSince >= CHANGE_HOLD_MS) { setLocked(now, cand); cand = 0; candSince = -1; resumed = false; }
    } else { cand = est.bpm; candSince = now; }
    out.candidate = Math.round(cand);
  }

  function setLocked(now, bpm) {
    const first = !out.locked;
    out.locked = true;
    out.bpm = bpm;
    out.period = 60000 / bpm;
    out.lockedAt = now;
    if (first && !(out.next > 0)) out.next = now + out.period;
  }

  // flux: band-onsets per-band flux; info: band-onsets output (onsets for phase).
  function process(now, flux, open, info) {
    out.beat = false;
    addFrame(now, flux, open);
    if (now - lastEst >= EST_EVERY_MS) {
      lastEst = now;
      const active = now - lastSound < 1500;
      decide(now, active ? estimate(now) : null);
      // Soak (Nov 9): silence never releases the lock or lets garbage in. The
      // last tempo is held; after a long gap the next song may move it, but
      // only after CHANGE_HOLD_MS of agreeing estimates once the 6 s window
      // holds new music (no octave/garbage jumps on resume).
      if (out.locked && now - lastSound > SILENCE_HOLD_MS) { resumed = true; resumeAt = -1; hist.length = 0; cand = 0; candSince = -1; out.candidate = 0; }
      if (resumed && resumeAt < 0 && active) resumeAt = now;
      out.held = out.locked && now - lastSound > 1500;
      if (out.locked) shown.push({t: now, bpm: out.bpm});
      while (shown.length && now - shown[0].t > 10000) shown.shift();
      if (shown.length > 2) {
        let m = 0; for (const s of shown) m += s.bpm; m /= shown.length;
        let v = 0; for (const s of shown) v += (s.bpm - m) * (s.bpm - m);
        out.std10 = Math.round(Math.sqrt(v / shown.length) * 100) / 100;
      } else out.std10 = 0;
    }
    if (out.locked && out.period > 0) {
      // Phase PLL: band onsets near a beat pull the grid toward them.
      if (info && info.onsets) {
        for (let b = 0; b < 4; b++) {
          if (!(info.onsets & (1 << b))) continue;
          const t = info.onsetTime[b];
          const g = out.next - out.period * Math.round((out.next - t) / out.period);
          const e = t - g;
          if (Math.abs(e) < 0.2 * out.period) out.next += 0.25 * PHASE_W[b] * e;
        }
      }
      while (out.next < now - out.period) out.next += out.period;
      if (now >= out.next - 8) { out.beat = true; out.next += out.period; }
    }
    return out;
  }

  function snapshot() {
    return {bpm: out.locked ? Math.round(out.bpm * 10) / 10 : 0, locked: out.locked, held: out.held, estimate: out.estimate,
      conf: out.conf, timeToLockMs: out.timeToLockMs, std10: out.std10, candidate: out.candidate};
  }

  return {process, reset, snapshot, state: out};
}

// Band agreement with the shared beat (TJ 7:43 PM: band conf should rise
// when hits agree). A hit agrees when it lands within ~12% of a grid step
// of the beat subdivided for the band's tempo ratio.
export function createBandAgreement() {
  const conf = new Float32Array(4);
  return {
    reset() { conf.fill(0); },
    update(info, gt, ratio) {
      if (!info || !gt || !gt.locked || !(gt.period > 0)) { for (let b = 0; b < 4; b++) conf[b] *= 0.999; return conf; }
      for (let b = 0; b < 4; b++) {
        const r = ratio ? +ratio[b] : 0;
        if (!(info.onsets & (1 << b))) {
          // No raw onset (e.g. masked under the kick), but the band's own locked
          // grid beats at a tempo that matches the song: that agrees too.
          if ((info.beats & (1 << b)) && info.locked && info.locked[b] && r > 0 && info.period &&
              Math.abs(info.period[b] * r / gt.period - 1) <= 0.06) conf[b] += (1 - conf[b]) * 0.1;
          continue;
        }
        const div = r >= 4 ? 4 : r >= 3 ? 3 : r === 1.5 ? 3 : r >= 2 || (r > 0.6 && r < 0.7) ? 2 : 1;
        const unit = gt.period / div;
        const t = info.onsetTime[b];
        const d = Math.abs(t - (gt.next - unit * Math.round((gt.next - t) / unit)));
        const ok = d <= Math.max(30, 0.12 * unit) ? 1 : 0;
        conf[b] += (ok - conf[b]) * 0.15;
      }
      return conf;
    },
    conf
  };
}
