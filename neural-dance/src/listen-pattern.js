// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Listen v2: groove pattern learning (TJ 7:10 PM), behind ?listen=pattern.
// Sits on top of band-onsets.js (per-band hits) and learns the repeating
// pattern so dancers can step on predicted hits, on time.
//
//   1. Pulse: the tatum (smallest repeating step) from all bands' onsets, by
//      a chance-corrected grid fit; a gentle PLL follows drift and rubato.
//   2. Cycle: any length 2..32 tatums, chosen by per-band periodicity, so
//      odd and additive meters (5/4, 7/8 as 3+2+2, 3+3+2) are not forced
//      onto 4/4. Accents choose the downbeat and the 2/3/4 grouping.
//   3. Template per band and cycle position: hit probability, timing offset
//      (swing, push/pull) and strength, each an online average that decays,
//      so moving accents are relearned in a few cycles.
//   4. Anticipation: positions the template expects (p >= 0.55) fire on
//      their predicted time; unexpected hits still fire as heard.
//   5. Fallback: on surprise (template stops predicting), silence or a big
//      tempo change the layer goes inactive and per-band beats pass through
//      unchanged. Up to 3 templates are kept and recalled when a groove returns.
// No allocation per frame; work per tatum is ~bands x positions.

const RING = 128;          // tatum ticks kept
const MAX_L = 32;
const ONS = 96;            // merged onsets kept for tatum estimation
const BAND_W = [1, 0.7, 0.9, 0.45];
const ACCENT_W = [1, 0.35, 0.55, 0.08];
const P_FIRE = 0.55;
const TEMPLATE_RATE = 0.3; // per-cycle learning rate (decay of old cycles)
const MEMORY = 3;
export const RATIOS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3, 4];
const SNAP_TOL = 0.07; // ~7% in tempo
const RATIO_TEXT = new Map([[1 / 4, '\u00bc'], [1 / 3, '\u2153'], [1 / 2, '\u00bd'], [2 / 3, '\u2154'], [1, '1'], [3 / 2, '1.5'], [2, '2'], [3, '3'], [4, '4']]);
// Nearest simple ratio of the shared beat for a band period, or 0.
export function snapRatio(pulse, period, tol = SNAP_TOL) {
  if (!(pulse > 0) || !(period > 0)) return 0;
  const x = pulse / period;
  let best = 0, bd = 1e9;
  for (const r of RATIOS) { const d = Math.abs(Math.log(x / r)); if (d < bd) { bd = d; best = r; } }
  return bd < tol ? best : 0;
}

// Cross-band coupling (TJ 7:28 PM): each band's tempo snaps to a simple
// ratio of the shared beat (kick 120, bass 60 = x1/2, hat 240 = x2, 3:2 for a
// triplet feel). A band that keeps disagreeing (~1.5 s) drifts free until it
// agrees again; brief wobbles stay snapped. Snapped periods are exact
// fractions of the pattern grid, so their phase follows the shared downbeat.
export function createCoupler() {
  const ratio = new Float64Array(4), disagree = new Float32Array(4);
  let last = 0;
  return {
    reset() { ratio.fill(0); disagree.fill(0); last = 0; },
    update(periods, now, pulse, out) {
      const dt = last ? Math.min(250, now - last) : 16;
      last = now;
      const k = 1 - Math.exp(-dt / 1500);
      for (let b = 0; b < 4; b++) {
        const raw = periods ? +periods[b] : 0;
        let r = 0;
        if (pulse > 0 && raw > 0) {
          const s = snapRatio(pulse, raw);
          disagree[b] += ((s ? 0 : 1) - disagree[b]) * k;
          if (s) r = s;
          else if (disagree[b] < 0.6 && ratio[b] > 0) r = ratio[b];
        } else disagree[b] = 0;
        ratio[b] = r;
        out.ratio[b] = r;
        out.free[b] = pulse > 0 && raw > 0 && r === 0;
        out.period[b] = r > 0 ? pulse / r : raw;
      }
      return out;
    }
  };
}

export function ratioText(r) { return RATIO_TEXT.get(r) || ''; }

// Inset label text for a band, e.g. '7/8 \u00b7 124 BPM' (the band on the
// beat) or '240 BPM (\u00d72)'. Empty when nothing is known.
export function bandLabel(state, band) {
  if (!state) return '';
  const bpm = state.bandBpm ? state.bandBpm[band] | 0 : 0;
  if (!(bpm > 0)) return state.meter || '';
  const r = state.ratio ? state.ratio[band] : 0;
  const head = state.meter && (r === 1 || !r && band === 0) ? state.meter + ' \u00b7 ' : '';
  const tail = r > 0 && r !== 1 ? ' (\u00d7' + ratioText(r) + ')' : state.free && state.free[band] ? ' (free)' : '';
  return head + bpm + ' BPM' + tail;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function createListenPattern() {
  const onT = new Float64Array(ONS), onW = new Float32Array(ONS), onB = new Uint8Array(ONS);
  let onN = 0, onHead = 0;
  // Tick grid: tick n is at t0 + n * T.
  let T = 0, t0 = 0, nextTick = 0, ticksDone = 0, lastEstimate = -1e12;
  const tickStr = new Float32Array(RING * 4), tickOff = new Float32Array(RING * 4); // closed ticks
  const PEND = 64;
  const pendStr = new Float32Array(PEND * 4), pendOff = new Float32Array(PEND * 4); // open ticks
  // Cycle and template.
  let L = 0, conf = 0, active = false, cyclesLearned = 0, downbeat = 0, surprise = 0.5;
  const prob = new Float32Array(MAX_L * 4), off = new Float32Array(MAX_L * 4), str = new Float32Array(MAX_L * 4);
  const emittedTick = new Float64Array(4).fill(-1e9);
  const groups = new Int8Array(MAX_L);
  let groupN = 0, meter = '', swing = false, lastOnset = -1e12, offGrid = 0, held = false, heldT = 0, realign = 0, regridAt = 0;
  const memory = [];
  const scoreL = new Float32Array(MAX_L + 1);
  const out = {beats: 0, predicted: 0, active: false, meter: '', bpm: 0, bandBpm: new Float32Array(4), ratio: new Float64Array(4), free: [false, false, false, false], period: new Float32Array(4), confidence: 0, tatumMs: 0, cycle: 0};

  function reset() {
    onN = 0; onHead = 0; T = 0; t0 = 0; nextTick = 0; ticksDone = 0; lastEstimate = -1e12;
    tickStr.fill(0); tickOff.fill(0); pendStr.fill(0); pendOff.fill(0);
    L = 0; conf = 0; active = false; cyclesLearned = 0; downbeat = 0; surprise = 0.5;
    prob.fill(0); off.fill(0); str.fill(0); emittedTick.fill(-1e9);
    groupN = 0; meter = ''; swing = false; lastOnset = -1e12; offGrid = 0; held = false; heldT = 0; realign = 0;
    out.beats = out.predicted = 0; out.active = false; out.meter = ''; out.bpm = 0; out.confidence = 0; out.tatumMs = 0; out.cycle = 0;
    out.bandBpm.fill(0); out.ratio.fill(0); out.period.fill(0); out.free.fill(false); coupler.reset();
  }

  function addOnset(t, w, b) {
    onT[onHead] = t; onW[onHead] = w; onB[onHead] = b;
    onHead = (onHead + 1) % ONS; if (onN < ONS) onN++;
  }

  // Chance-corrected grid fit of pairwise onset gaps; the largest step that
  // explains nearly as much as the best one is the tatum.
  function estimateTatum(now) {
    let best = 0, bestFit = 0;
    const fits = [];
    for (let cand = 90; cand <= 460; cand *= 1.015) {
      // Soft fit: detection jitter (~15 ms per onset) blurs pair gaps.
      const sig = Math.max(12, 0.05 * cand);
      let hit = 0, all = 0;
      for (let i = 0; i < onN; i++) {
        const ia = (onHead - 1 - i + ONS) % ONS;
        const ta = onT[ia];
        if (now - ta > 4500) break;
        for (let j = i + 1; j < onN; j++) {
          const ib = (onHead - 1 - j + ONS) % ONS;
          const d = ta - onT[ib];
          if (d > 2000) break;
          if (d < 60) continue;
          const w = onW[ia] * onW[ib];
          const k = Math.max(1, Math.round(d / cand));
          const dev = (d - k * cand) / sig;
          all += w;
          hit += w * Math.exp(-0.5 * dev * dev);
        }
      }
      if (!(all > 0)) return 0;
      const chance = Math.min(0.95, Math.max(12, 0.05 * cand) * 2.5066 / cand);
      const fit = (hit / all - chance) / (1 - chance);
      fits.push(cand, fit);
      if (fit > bestFit) { bestFit = fit; best = cand; }
    }
    if (bestFit < 0.35) return 0;
    for (let i = fits.length - 2; i >= 0; i -= 2) if (fits[i + 1] >= 0.94 * bestFit) return fits[i];
    return best;
  }

  // Phase of the grid: weighted circular mean of recent onset times mod T.
  function phaseFor(period, now) {
    let sx = 0, sy = 0;
    for (let i = 0; i < onN; i++) {
      const ia = (onHead - 1 - i + ONS) % ONS;
      if (now - onT[ia] > 4000) break;
      const a = 2 * Math.PI * (onT[ia] / period);
      sx += Math.cos(a) * onW[ia]; sy += Math.sin(a) * onW[ia];
    }
    const ph = Math.atan2(sy, sx) / (2 * Math.PI);
    return (ph < 0 ? ph + 1 : ph) * period;
  }

  function startGrid(period, now) {
    T = period;
    const ph = phaseFor(period, now);
    // Tick 0 sits ~4 s back so the onsets already heard fill the first
    // ticks at once (faster lock); the latest ticks are still open.
    const back = Math.min(4000, (PEND - 8) * T);
    const base = Math.floor((now - back - ph) / T) * T + ph;
    t0 = base; nextTick = 0; ticksDone = 0;
    tickStr.fill(0); tickOff.fill(0); pendStr.fill(0); pendOff.fill(0);
    L = 0; active = false; conf = 0; cyclesLearned = 0; surprise = 0.5; realign = 0;
    prob.fill(0); off.fill(0); str.fill(0); emittedTick.fill(-1e9);
    // Re-place recent onsets on the new grid.
    for (let i = onN - 1; i >= 0; i--) {
      const ia = (onHead - 1 - i + ONS) % ONS;
      place(onT[ia], onW[ia], onB[ia]);
    }
  }

  // Back from a break at the same tempo: new phase, same template; the bar
  // position is found by matching the next cycle of ticks to the template.
  function regrid(period, now) {
    const keepL = L, keepC = cyclesLearned;
    const p = prob.slice(), o = off.slice(), st = str.slice();
    startGrid(period, now);
    L = keepL; cyclesLearned = keepC; prob.set(p); off.set(o); str.set(st);
    surprise = 0.3; realign = L; regridAt = now - 600;
    held = false;
  }

  function align() {
    let best = 0, bestS = -1;
    for (let sh = 0; sh < L; sh++) {
      let sc = 0;
      for (let i = 1; i <= L; i++) {
        const n = nextTick - i, slot = ((n % RING) + RING) % RING * 4;
        const pos = (((n + sh) % L) + L) % L;
        for (let b = 0; b < 4; b++) sc += tickStr[slot + b] * (prob[pos * 4 + b] - 0.3);
      }
      if (sc > bestS) { bestS = sc; best = sh; }
    }
    // Rotate the template so absolute tick n maps to position n mod L.
    if (best) {
      const p = prob.slice(0, L * 4), o = off.slice(0, L * 4), st = str.slice(0, L * 4);
      for (let q = 0; q < L; q++) for (let b = 0; b < 4; b++) {
        const src = ((q + best) % L) * 4 + b;
        prob[q * 4 + b] = p[src]; off[q * 4 + b] = o[src]; str[q * 4 + b] = st[src];
      }
      downbeat = ((downbeat - best) % L + L) % L;
    }
  }

  function place(t, w, b) {
    if (!(T > 0)) return -1;
    const k = Math.round((t - t0) / T);
    if (k < nextTick || k >= nextTick + PEND) return -1;
    const o = t - (t0 + k * T);
    // Far off the grid (e.g. 8ths on a quarter grid): not this tatum's hit.
    if (Math.abs(o) > 0.3 * T) { offGrid += (1 - offGrid) * 0.05; return -1; }
    offGrid *= 0.985;
    const slot = ((k % PEND) + PEND) % PEND * 4 + b;
    if (w > pendStr[slot]) { pendStr[slot] = w; pendOff[slot] = t - (t0 + k * T); }
    return k;
  }

  // Periodicity of the band strength sequences over the last ticks.
  function chooseCycle() {
    const N = Math.min(ticksDone, 96);
    if (N < 16) return 0;
    let best = 0, bestScore = -1;
    const maxL = Math.min(MAX_L, Math.floor(N / 2.5));
    for (let l = 2; l <= maxL; l++) {
      let num = 0, den = 0;
      for (let b = 0; b < 4; b++) {
        let sxy = 0, sxx = 0, syy = 0, mean = 0;
        for (let i = 0; i < N; i++) mean += tickStr[(((nextTick - 1 - i) % RING) + RING) % RING * 4 + b];
        mean /= N;
        let v = 0;
        for (let i = 0; i < N - l; i++) {
          const x = tickStr[(((nextTick - 1 - i) % RING) + RING) % RING * 4 + b] - mean;
          const y = tickStr[(((nextTick - 1 - i - l) % RING) + RING) % RING * 4 + b] - mean;
          sxy += x * y; sxx += x * x; syy += y * y; v += x * x;
        }
        const r = sxx > 1e-6 && syy > 1e-6 ? sxy / Math.sqrt(sxx * syy) : 0;
        const wgt = BAND_W[b] * v / N;
        num += wgt * r; den += wgt;
      }
      const s = den > 0 ? num / den : 0;
      scoreL[l] = s;
      if (s - 0.002 * l > bestScore) { bestScore = s - 0.002 * l; best = l; }
    }
    if (!(scoreL[best] > 0.45)) return 0;
    // Smallest divisor of the best length that repeats as well.
    for (let d = 2; d < best; d++) if (best % d === 0 && scoreL[d] >= 0.85 * scoreL[best]) return d;
    return best;
  }

  function relabel() {
    // Downbeat: strongest kick-weighted accent.
    const acc = new Float32Array(L);
    let mean = 0, bestA = -1;
    for (let p = 0; p < L; p++) {
      let a = 0;
      for (let b = 0; b < 4; b++) a += ACCENT_W[b] * prob[p * 4 + b] * (0.5 + str[p * 4 + b]);
      acc[p] = a; mean += a;
      // Downbeat: kick (and bass) land there; the backbeat snare does not.
      const d = prob[p * 4] * (0.5 + str[p * 4]) + 0.25 * prob[p * 4 + 1] - 0.5 * prob[p * 4 + 2] + 0.1 * a;
      if (d > bestA + 1e-6) { bestA = d; downbeat = p; }
    }
    mean /= L;
    // Grouping into 2s/3s/4s from the downbeat (DP: reward strong starts).
    const bestS = new Float32Array(L + 1).fill(-1e9), from = new Int8Array(L + 1);
    bestS[0] = 0;
    for (let i = 0; i < L; i++) {
      if (bestS[i] <= -1e8) continue;
      const a = acc[(downbeat + i) % L] - mean;
      for (let g = 2; g <= 4; g++) {
        if (i + g > L) continue;
        const s = bestS[i] + a - (g === 4 ? 0.02 : 0) - (g === 3 ? 0.005 : 0);
        if (s > bestS[i + g]) { bestS[i + g] = s; from[i + g] = g; }
      }
    }
    // Prefer equal groups (2s, 3s or 4s) unless an additive grouping is
    // clearly better: odd meters must earn their label.
    let maxA = 0;
    for (let p = 0; p < L; p++) maxA = Math.max(maxA, acc[p] - mean);
    let eqG = 0, eqS = -1e9;
    for (let g = 2; g <= 4; g++) {
      if (L % g || L === g) continue;
      let sc = 0;
      for (let i = 0; i < L; i += g) sc += acc[(downbeat + i) % L] - mean;
      sc -= (g === 4 ? 0.02 : 0) + (g === 3 ? 0.005 : 0);
      if (sc > eqS) { eqS = sc; eqG = g; }
    }
    groupN = 0;
    if (eqG && eqS >= bestS[L] - 0.25 * maxA) {
      for (let i = 0; i < L; i += eqG) groups[groupN++] = eqG;
    } else if (bestS[L] > -1e8) {
      const tmp = [];
      for (let i = L; i > 0; i -= from[i]) tmp.push(from[i]);
      tmp.reverse();
      for (const g of tmp) groups[groupN++] = g;
    } else { groups[0] = L; groupN = 1; }
    let equal = true;
    for (let i = 1; i < groupN; i++) if (groups[i] !== groups[0]) equal = false;
    if (!equal) {
      // Additive meters read long groups first (3+3+2, 3+2+2): rotate the
      // grouping to its largest reading and move the downbeat with it.
      let bestR = 0, bestKey = '';
      for (let r = 0; r < groupN; r++) {
        let key = '';
        for (let i = 0; i < groupN; i++) key += groups[(r + i) % groupN];
        if (key > bestKey) { bestKey = key; bestR = r; }
      }
      let shift = 0;
      for (let i = 0; i < bestR; i++) shift += groups[i];
      const rot = Array.from(groups.slice(0, groupN));
      for (let i = 0; i < groupN; i++) groups[i] = rot[(bestR + i) % groupN];
      downbeat = (downbeat + shift) % L;
    }
    const g0 = groups[0];
    swing = false;
    if (equal && g0 === 3) {
      // Swing: the middle triplet step is (almost) never hit.
      let mid = 0, edge = 0;
      for (let i = 0, s = 0; i < groupN; i++, s += 3) {
        for (let b = 0; b < 4; b++) { mid += prob[((downbeat + s + 1) % L) * 4 + b]; edge += prob[((downbeat + s + 2) % L) * 4 + b]; }
      }
      swing = edge > 0.8 * groupN && mid < 0.45 * edge;
    }
    if (T >= 330) meter = (L <= 2 || L === 4 ? 4 : L) + '/4'; // each step is a beat
    else if (equal && (g0 === 2 || g0 === 4)) meter = (groupN <= 2 ? 4 : groupN) + '/4';
    else if (equal && g0 === 3) meter = swing ? (groupN <= 2 ? 4 : groupN) + '/4 swing' : (L === 3 ? 6 : L) + '/8';
    else if (L % 2 === 0 && Array.from(groups.slice(0, groupN)).every(g => g % 2 === 0)) meter = (L / 2) + '/4';
    else {
      let parts = '';
      for (let i = 0; i < groupN; i++) parts += (i ? '+' : '') + groups[i];
      meter = L + '/8 (' + parts + ')';
    }
  }

  function beatMs() {
    if (!(T > 0) || !groupN) return 0;
    if (T >= 330) return T;
    if (swing || groups[0] === 3 && groupN > 0) {
      let equal = true;
      for (let i = 1; i < groupN; i++) if (groups[i] !== groups[0]) equal = false;
      if (equal) return T * groups[0];
    }
    let g = groups[0];
    let equal = true;
    for (let i = 1; i < groupN; i++) if (groups[i] !== groups[0]) equal = false;
    if (!equal) return T * 2; // additive meters: quarter = 2 steps
    while (T * g > 1000 && g % 2 === 0) g >>= 1;
    return T * g;
  }

  function remember() {
    if (!(L > 0) || cyclesLearned < 3) return;
    const snap = {L, T, prob: prob.slice(0, L * 4), off: off.slice(0, L * 4), str: str.slice(0, L * 4)};
    memory.unshift(snap);
    if (memory.length > MEMORY) memory.pop();
  }

  // A remembered groove matches the fresh template: adopt it whole.
  function recall() {
    for (const m of memory) {
      if (m.L !== L || Math.abs(m.T - T) > 0.08 * T) continue;
      for (let shift = 0; shift < L; shift++) {
        let sxy = 0, sxx = 0, syy = 0;
        for (let p = 0; p < L; p++) for (let b = 0; b < 4; b++) {
          const x = prob[p * 4 + b] - 0.3, y = m.prob[((p + shift) % L) * 4 + b] - 0.3;
          sxy += x * y; sxx += x * x; syy += y * y;
        }
        if (sxx > 0 && syy > 0 && sxy / Math.sqrt(sxx * syy) > 0.8) {
          for (let p = 0; p < L; p++) for (let b = 0; b < 4; b++) {
            const q = ((p + shift) % L) * 4 + b;
            prob[p * 4 + b] = m.prob[q]; off[p * 4 + b] = m.off[q]; str[p * 4 + b] = m.str[q];
          }
          cyclesLearned = Math.max(cyclesLearned, 3);
          return true;
        }
      }
    }
    return false;
  }

  // A template that repeats inside itself (two bars of the same bar)
  // folds to the shorter cycle.
  function fold() {
    for (let d = 2; d < L; d++) {
      if (L % d) continue;
      let ok = true;
      for (let p = d; p < L && ok; p++) for (let b = 0; b < 4; b++) {
        if (Math.abs(prob[p * 4 + b] - prob[(p % d) * 4 + b]) > 0.35) { ok = false; break; }
      }
      if (!ok) continue;
      const reps = L / d;
      for (let p = 0; p < d; p++) for (let b = 0; b < 4; b++) {
        let sp = 0, so = 0, ss = 0;
        for (let r = 0; r < reps; r++) { const k = (p + r * d) * 4 + b; sp += prob[k]; so += off[k]; ss += str[k]; }
        prob[p * 4 + b] = sp / reps; off[p * 4 + b] = so / reps; str[p * 4 + b] = ss / reps;
      }
      prob.fill(0, d * 4); off.fill(0, d * 4); str.fill(0, d * 4);
      L = d;
      return true;
    }
    return false;
  }

  // A two-beat cycle under a 4/4 label: which of the two cycles starts the
  // bar? The one whose downbeat step hits harder (kick/bass) over the ring.
  let barHalf = 0;
  function pickBarHalf(n) {
    if (!(L > 0)) return;
    const N = Math.min(ticksDone, RING - 1);
    let a = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const m = n - i;
      if (((m - downbeat) % L + L) % L) continue;
      const slot = ((m % RING) + RING) % RING * 4;
      const v = tickStr[slot] * 1 + tickStr[slot + 1] * 0.6 + tickStr[slot + 3] * 0.2 - tickStr[slot + 2] * 0.3;
      if ((((m - downbeat) / L) % 2 + 2) % 2 === 0) a += v; else b += v;
    }
    barHalf = b > a * 1.05 ? 1 : 0;
  }

  // Every other step empty: the grid is twice too fine. Keep even steps.
  function coarsen() {
    if (L % 2 || L < 4) return false;
    let odd = 0, even = 0;
    for (let p = 0; p < L; p++) for (let b = 0; b < 4; b++) { if (p % 2) odd += prob[p * 4 + b]; else even += prob[p * 4 + b]; }
    let shift = 0;
    if (even < odd) { const tmp = even; even = odd; odd = tmp; shift = 1; }
    if (!(even > 0.5) || odd > 0.12 * even) return false;
    const h = L >> 1;
    for (let p = 0; p < h; p++) for (let b = 0; b < 4; b++) {
      const src = (2 * p + shift) * 4 + b;
      prob[p * 4 + b] = prob[src]; off[p * 4 + b] = off[src]; str[p * 4 + b] = str[src];
    }
    prob.fill(0, h * 4); off.fill(0, h * 4); str.fill(0, h * 4);
    // Absolute tick n of the old grid -> n/2 on the new one.
    t0 += shift * T; T *= 2; L = h;
    nextTick = Math.ceil((nextTick - shift) / 2);
    pendStr.fill(0); pendOff.fill(0);
    return true;
  }

  // Template offsets are relative: keep their mean at zero and move the
  // grid instead, so the PLL and the template cannot drift together.
  function anchor() {
    let m = 0, w = 0;
    for (let p = 0; p < L; p++) for (let b = 0; b < 4; b++) {
      const k = p * 4 + b;
      if (prob[k] >= 0.5) { m += off[k] * prob[k]; w += prob[k]; }
    }
    if (!(w > 0)) return;
    m /= w;
    for (let p = 0; p < L; p++) for (let b = 0; b < 4; b++) off[p * 4 + b] -= m;
    t0 += m;
  }

  function finalizeTick(n) {
    const slot = ((n % RING) + RING) % RING * 4;
    const ps = ((n % PEND) + PEND) % PEND * 4;
    for (let b = 0; b < 4; b++) { tickStr[slot + b] = pendStr[ps + b]; tickOff[slot + b] = pendOff[ps + b]; }
    pendStr.fill(0, ps, ps + 4); pendOff.fill(0, ps, ps + 4);
    // PLL: phase error against the template's learned offsets.
    let e = 0, ew = 0;
    const pos = L > 0 ? ((n % L) + L) % L : 0;
    for (let b = 0; b < 4; b++) {
      const w = tickStr[slot + b];
      if (w > 0) { e += (tickOff[slot + b] - (L > 0 ? off[pos * 4 + b] : 0)) * w; ew += w; }
    }
    if (ew > 0) {
      const err = clamp(e / ew, -0.3 * T, 0.3 * T);
      // Phase step plus a small period step, pivoting on this tick so a
      // period change does not move the grid at tick n.
      const newT = clamp(T + 0.01 * err, 60, 600);
      t0 += 0.2 * err + n * (T - newT);
      T = newT;
    }
    if (realign > 0) {
      ticksDone++;
      if (t0 + n * T >= regridAt && --realign === 0) align();
      return;
    }
    if (L > 0) {
      // Fast first cycles (1, 1/2, 1/3...), then a steady decay of old cycles.
      const rate = Math.max(TEMPLATE_RATE, 1 / (cyclesLearned + 1));
      let brier = 0, cnt = 0;
      for (let b = 0; b < 4; b++) {
        const k = pos * 4 + b;
        const hit = tickStr[slot + b] > 0 ? 1 : 0;
        // Surprise = how often the hits we would predict fail to come.
        if (cyclesLearned >= 1 && prob[k] >= P_FIRE) { brier += (1 - hit) * BAND_W[b]; cnt += BAND_W[b]; }
        prob[k] += (hit - prob[k]) * rate;
        if (hit) {
          off[k] += (tickOff[slot + b] - off[k]) * rate;
          str[k] += (Math.min(1.5, tickStr[slot + b]) - str[k]) * rate;
        }
      }
      if (cnt > 0) surprise += (brier / cnt - surprise) * 0.1;
      if (pos === L - 1) {
        cyclesLearned++;
        if (cyclesLearned >= 2) { coarsen(); fold(); }
        pickBarHalf(n);
        anchor();
        if (cyclesLearned === 2) recall();
        relabel();
      }
    }
    ticksDone++;
  }

  // info: band-onsets output for this frame. sens: per-band sliders.
  function process(info, now, sens) {
    out.beats = 0; out.predicted = 0;
    if (!info) return out;
    const onsets = info.onsets | 0;
    for (let b = 0; b < 4; b++) {
      if (!(onsets & (1 << b))) continue;
      const t = info.onsetTime[b];
      const thr = info.threshold ? +info.threshold[b] : 0;
      const w = BAND_W[b] * clamp(thr > 0 && Number.isFinite(thr) ? 0.6 + 0.4 * Math.min(2, info.flux[b] / thr) / 2 : 1, 0.5, 1);
      addOnset(t, w, b);
      lastOnset = now;
      place(t, w, b);
    }
    // Silence / break: forget the grid (keep templates in memory).
    if (T > 0 && now - lastOnset > Math.max(2500, 4 * (L || 4) * T * 0.5)) {
      if (active || L > 0) remember();
      // Hold tempo and template through the break; re-find the phase and
      // the bar position when the groove comes back.
      if (L > 0 && cyclesLearned >= 2) { held = true; heldT = T; }
      T = 0; active = false; onN = 0;
      if (!held) L = 0;
    }
    // (Re)estimate the tatum every second until a cycle is locked, then
    // every 4 s to catch tempo changes the PLL cannot follow.
    if (now - lastEstimate > (active ? 4000 : held ? 500 : 1000) && onN >= (held ? 8 : 16)) {
      lastEstimate = now;
      let est = estimateTatum(now);
      // Many hits between grid points: the real step is half as long.
      if (T > 0 && !active && offGrid > 0.3 && T / 2 >= 90) { est = T / 2; offGrid = 0; }
      if (est > 0) {
        if (!(T > 0) && held && Math.abs(est / heldT - 1) < 0.06) regrid(heldT, now);
        else if (!(T > 0)) { held = false; startGrid(est, now); }
        else {
          const ratio = est / T;
          const near = [1, 2, 0.5, 3, 1 / 3].some(r => Math.abs(ratio / r - 1) < 0.06);
          const stuck = !(L > 0) && ticksDone >= 48 && Math.abs(ratio / 2 - 1) < 0.06;
          if (!near || est === T / 2 || stuck) { remember(); startGrid(est, now); }
          else if (!active && Math.abs(ratio - 1) >= 0.06 && Math.abs(ratio - 1) < 0.2) startGrid(est, now);
        }
      }
    }
    if (T > 0) {
      // Close ticks whose onsets can no longer arrive (detection lag ~60 ms).
      while (t0 + (nextTick + 0.5) * T < now - 60) { finalizeTick(nextTick); nextTick++; }
      if (!(L > 0) && ticksDone >= 16 && ticksDone % 4 === 0) {
        const l = chooseCycle();
        if (l > 0) {
          // Align positions so absolute tick n maps to n mod L.
          L = l; cyclesLearned = 0; surprise = 0.2;
          prob.fill(0); off.fill(0); str.fill(0);
        }
      } else if (L > 0 && ticksDone % (L * 4) === 0 && cyclesLearned >= 4) {
        const l = chooseCycle();
        if (l > 0 && l !== L && (scoreL[l] > scoreL[L] + 0.08 || L % l === 0)) { remember();
          if (l % L === 0) {
            // Longer cycle (e.g. 2-bar): tile the template, keep what we know.
            for (let p = L; p < l; p++) for (let b = 0; b < 4; b++) { const src = (p % L) * 4 + b; prob[p * 4 + b] = prob[src]; off[p * 4 + b] = off[src]; str[p * 4 + b] = str[src]; }
            L = l; cyclesLearned = 2;
          } else { L = l; cyclesLearned = 0; surprise = 0.2; prob.fill(0); off.fill(0); str.fill(0); }
        }
      }
    }
    conf = L > 0 ? clamp(1 - surprise / 0.4, 0, 1) : 0;
    const wasActive = active;
    active = L > 0 && T > 0 && realign === 0 && cyclesLearned >= 2 && conf >= (wasActive ? 0.35 : 0.5);
    const lead = 16;
    for (let b = 0; b < 4; b++) {
      const s = sens ? +sens[b] : 1;
      const muted = Number.isFinite(s) && !(s > 0);
      if (muted) continue;
      if (active) {
        // Predicted hits for the open ticks.
        for (let m = nextTick; m <= nextTick + 2; m++) {
          const pos = ((m % L) + L) % L;
          const k = pos * 4 + b;
          if (prob[k] < P_FIRE) continue;
          const tm = t0 + m * T + off[k];
          if (tm <= now + lead && tm > now - 0.5 * T && emittedTick[b] !== m) {
            emittedTick[b] = m;
            out.beats |= 1 << b; out.predicted |= 1 << b;
          }
        }
        // Unexpected hits still fire as heard (one per tick).
        if (onsets & (1 << b)) {
          const k = Math.round((info.onsetTime[b] - t0) / T);
          if (emittedTick[b] !== k && Math.abs(emittedTick[b] - k) > 0) { emittedTick[b] = k; out.beats |= 1 << b; }
        }
      } else if (info.beats & (1 << b)) {
        out.beats |= 1 << b;
        if (T > 0) emittedTick[b] = Math.round((now - t0) / T);
      }
    }
    out.active = active;
    out.meter = L > 0 && cyclesLearned >= 2 ? meter : '';
    const bm = beatMs();
    out.bpm = bm > 0 && out.meter ? Math.round(60000 / bm) : 0;
    couple(info, now, bm > 0 && out.meter ? bm : 0);
    out.confidence = Math.round(conf * 100) / 100;
    out.tatumMs = Math.round(T);
    out.cycle = L;
    return out;
  }

  const coupler = createCoupler();
  function couple(info, now, pulse) {
    coupler.update(info.period, now, pulse, out);
    for (let b = 0; b < 4; b++) out.bandBpm[b] = out.period[b] > 0 ? Math.round(60000 / out.period[b]) : out.bpm;
  }

  // Downbeat times are tick indices with (n - downbeat) % L === 0.
  function nextDownbeat(now) {
    if (!(L > 0) || !(T > 0) || !out.meter) return -1;
    // A 4/4 label on a two-beat cycle: the bar is two cycles.
    const bar = /^4\/4/.test(out.meter) && groupN <= 2 && groups[0] !== 3 ? 2 * L : L;
    const first = bar === L ? downbeat : downbeat + barHalf * L;
    let n = Math.ceil((now - t0) / T);
    while (((n - first) % bar + bar) % bar !== 0) n++;
    return t0 + n * T;
  }

  function snapshot() {
    return {surprise: +surprise.toFixed(3), cyclesLearned, active, meter: out.meter, bpm: out.bpm, bandBpm: Array.from(out.bandBpm), ratio: Array.from(out.ratio, r => ratioText(r) || null), free: out.free.slice(), confidence: out.confidence, tatumMs: Math.round(T), cycle: L, downbeat, groups: Array.from(groups.slice(0, groupN)), memory: memory.length};
  }

  return {process, reset, snapshot, nextDownbeat, state: out};
}
