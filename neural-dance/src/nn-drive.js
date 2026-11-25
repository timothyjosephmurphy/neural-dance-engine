// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Beat This! drives the dancers (TJ 9:49 PM "make the smarter beat tracker
// drive the dancers"). Per frame, choose who times the steps:
//
//   pattern  the per-band pattern tracker's beats (listen-pattern.js), exactly
//            as before. Used while nn is off, loading, slow, unsure or unlocked.
//   nn       the neural beat grid (beat-grid.js) times every band: each band
//            that is playing steps on the grid at its own ratio of the beat
//            (kick x1, bass x1/2, hats x2 ...), with its place in the bar, so
//            steps land on the beat, strides line up with the bar and
//            downbeats are accented.
//
// Handover: nn takes over only after its confidence stays >= ENTER for
// ENTER_MS and gives back as soon as it drops below EXIT (hysteresis). For
// HANDOVER_MS after any switch, a band never steps again sooner than ~half its
// beat, so the switch cannot double-step. Silence: no beats while the gate is
// closed (the room also zeroes them). O(1) per frame, no allocation.
import {snapRatio} from './listen-pattern.js';

export const NN_ENTER = 0.5, NN_EXIT = 0.3, ENTER_MS = 1500, HANDOVER_MS = 2000, PRESENT_MS = 2500;
// Agreement with what the room hears: circular mean of the pattern tracker's
// beats on the nn grid (1 = on the grid, 0 = unrelated, -1 = half a beat off).
// Heard beats come out of the analyser a little late (FFT window + onset
// picking, ~30-120 ms), so a steady lag of up to LAG_MAX of a beat counts as on.
export const AGREE_ENTER = 0.35, AGREE_EXIT = 0.1, AGREE_RATE = 0.08;
// Fast check so a tempo change hands back within a few heard beats.
const FAST_RATE = 0.2, FAST_EXIT = -0.4;
const LAG_MIN = -0.06, LAG_MAX = 0.22; // of a beat
function agreement(re, im) {
  const r = Math.hypot(re, im); if (!(r > 0)) return 0;
  const a = Math.atan2(im, re) / (2 * Math.PI);
  if (a >= LAG_MIN && a <= LAG_MAX) return r;
  const d = a < LAG_MIN ? a - LAG_MIN : a - LAG_MAX;
  return r * Math.cos(2 * Math.PI * d);
}
const GRID_R = [1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4];
const onGrid = r => GRID_R.some(g => Math.abs(g - r) < 1e-6);
// Accent by place in the bar (TJ: accents on downbeats, bar-level variation).
export function accentFor(barBeat, meter, sub, bar) {
  if (sub > 0) return 0.82;
  if (barBeat === 0) return bar % 4 === 0 ? 1 : 0.97;
  if (meter >= 4 && meter % 2 === 0 && barBeat === meter / 2) return 0.92;
  return 0.88;
}

export function createNnDrive({enter = NN_ENTER, exit = NN_EXIT, enterMs = ENTER_MS, handoverMs = HANDOVER_MS, presentMs = PRESENT_MS} = {}) {
  const lastHit = new Float64Array(4).fill(-1e12), lastEmit = new Float64Array(4).fill(-1e12), subJ = new Int32Array(4);
  const info = {period: new Float64Array(4), locked: [false, false, false, false], pos: new Int32Array(4).fill(-1), cyc: new Int32Array(4), accent: new Float64Array(4).fill(1), bar: 0, barBeat: -1, meter: 0};
  const out = {mask: 0, info: null, source: 'pattern', downbeat: false, conf: 0};
  const st = {agree: 0, agreeN: 0, fast: 0, zr: 0, zi: 0, fr: 0, fi: 0, lag: 0, source: 'pattern', okSince: -1, switchAt: -1e12, switches: 0, beatAt: -1, period: 0, barBeat: -1, bar: 0, meter: 0, k: 0, nnBeats: 0, patternBeats: 0};
  function reset() {
    lastHit.fill(-1e12); lastEmit.fill(-1e12); subJ.fill(0);
    Object.assign(st, {agree: 0, agreeN: 0, fast: 0, zr: 0, zi: 0, fr: 0, fi: 0, lag: 0, source: 'pattern', okSince: -1, switchAt: -1e12, beatAt: -1, period: 0, barBeat: -1, bar: 0, meter: 0, k: 0});
  }
  function refractory(now, b, P) { return now - lastEmit[b] < Math.max(90, 0.45 * P); }
  // s: {gateOpen, grid (beat-grid state or null when nn is not running),
  //     patternMask, patternInfo ({period, locked} as passed to the show),
  //     ratio (coupled band ratios, 0 = none), gtPeriod (locked tempo or 0)}
  function step(now, s) {
    const g = s.grid, pm = s.patternMask | 0, pinfo = s.patternInfo || null;
    for (let b = 0; b < 4; b++) if (pm & (1 << b)) lastHit[b] = now;
    out.downbeat = false;
    const gp = +s.gtPeriod || 0;
    const usable = !!(g && g.locked && g.period > 0 && s.gateOpen !== false && (!(gp > 0) || Math.abs(g.period / gp - 1) < 0.035));
    const conf = usable ? +g.conf || 0 : 0;
    out.conf = conf;
    // Do the beats the room hears sit on the nn grid? (Two trackers can both be
    // sure yet half a beat apart; then the heard pattern keeps the steps.)
    if (usable && pm && g.next > 0) {
      for (let b = 0; b < 4; b++) {
        if (!(pm & (1 << b))) continue;
        let r = s.ratio ? +s.ratio[b] : 0;
        if (!(r > 0) && pinfo && pinfo.period && +pinfo.period[b] > 0) r = snapRatio(g.period, +pinfo.period[b]);
        if (!(r > 0) || !onGrid(r)) continue;
        const n = r >= 1 ? Math.round(r) : 1;
        const x = (now - g.next) / g.period * n;
        const cr = Math.cos(2 * Math.PI * x), ci = Math.sin(2 * Math.PI * x);
        // Sub-beat bands (hats at x2) cannot tell on-beat from half a beat off: light weight.
        const w = n > 1 ? 0.25 : 1;
        st.zr += (cr - st.zr) * AGREE_RATE * w; st.zi += (ci - st.zi) * AGREE_RATE * w;
        st.fr += (cr - st.fr) * FAST_RATE * w; st.fi += (ci - st.fi) * FAST_RATE * w; st.agreeN++;
        st.agree = agreement(st.zr, st.zi); st.fast = agreement(st.fr, st.fi);
        st.lag = Math.atan2(st.zi, st.zr) / (2 * Math.PI) * g.period;
      }
    } else if (!usable) { st.agree = st.fast = st.zr = st.zi = st.fr = st.fi = st.lag = 0; st.agreeN = 0; }
    const agreeOk = st.agreeN >= 8 && st.agree >= (st.source === 'nn' ? AGREE_EXIT : AGREE_ENTER) && st.fast >= FAST_EXIT;
    // Who drives (hysteresis).
    if (st.source === 'nn') {
      if (!usable || conf < exit || !agreeOk) { st.source = 'pattern'; st.switchAt = now; st.switches++; st.okSince = -1; }
    } else if (usable && conf >= enter && agreeOk) {
      if (st.okSince < 0) st.okSince = now;
      if (now - st.okSince >= enterMs) { st.source = 'nn'; st.switchAt = now; st.switches++; st.beatAt = -1; subJ.fill(0); }
    } else st.okSince = -1;
    out.source = st.source;
    if (s.gateOpen === false) { out.mask = 0; out.info = pinfo; return out; }
    const handover = now - st.switchAt < handoverMs;
    if (st.source === 'pattern') {
      let m = pm;
      if (handover && m) {
        for (let b = 0; b < 4; b++) if (m & (1 << b)) {
          const P = pinfo && pinfo.period && +pinfo.period[b] > 0 ? +pinfo.period[b] : 500;
          if (refractory(now, b, P)) m &= ~(1 << b);
        }
      }
      for (let b = 0; b < 4; b++) if (m & (1 << b)) lastEmit[b] = now;
      if (m) st.patternBeats++;
      out.mask = m; out.info = pinfo; return out;
    }
    // nn drives.
    const P = g.period;
    if (g.beat) {
      st.beatAt = g.beatAt > 0 ? g.beatAt : now; st.period = P; st.barBeat = g.barBeat; st.bar = g.bar; st.meter = g.meter || 4; st.k = g.k;
      subJ.fill(0);
      if (g.downbeat) out.downbeat = true;
    }
    let m = 0;
    const meter = st.meter || 4;
    for (let b = 0; b < 4; b++) {
      info.pos[b] = -1; info.cyc[b] = 0;
      if (now - lastHit[b] > presentMs) continue; // band not playing: no steps
      let r = s.ratio ? +s.ratio[b] : 0;
      if (!(r > 0) && pinfo && pinfo.period && +pinfo.period[b] > 0) r = snapRatio(P, +pinfo.period[b]);
      if (!(r > 0) || !onGrid(r)) { // free band: its own beats, as heard
        if (pm & (1 << b)) {
          const Pb = pinfo && pinfo.period && +pinfo.period[b] > 0 ? +pinfo.period[b] : P;
          if (!(handover && refractory(now, b, Pb))) { m |= 1 << b; lastEmit[b] = now; }
          info.period[b] = Pb; info.locked[b] = !!(pinfo && pinfo.locked && pinfo.locked[b]); info.accent[b] = 1;
        }
        continue;
      }
      if (st.beatAt < 0) continue;
      let fire = false, pos = -1, cyc = 0, sub = 0;
      if (r >= 1) {
        const n = Math.round(r);
        if (g.beat) { fire = true; sub = 0; }
        else {
          const j = Math.floor((now - st.beatAt + 8) / (P / n));
          if (j >= 1 && j < n && j > subJ[b]) { fire = true; sub = j; subJ[b] = j; }
        }
        pos = st.barBeat * n + sub; cyc = meter * n;
      } else {
        const n = Math.round(1 / r);
        if (g.beat) {
          const place = meter % n === 0 ? st.barBeat : st.k;
          if (((place % n) + n) % n === 0) fire = true;
        }
        if (meter % n === 0) { pos = Math.floor(st.barBeat / n); cyc = meter / n; }
      }
      if (!fire) continue;
      const Pb = P / r;
      if (refractory(now, b, Pb)) continue;
      m |= 1 << b; lastEmit[b] = now;
      info.period[b] = Pb; info.locked[b] = true; info.pos[b] = pos; info.cyc[b] = cyc;
      info.accent[b] = accentFor(st.barBeat, meter, sub, st.bar);
    }
    info.bar = st.bar; info.barBeat = st.barBeat; info.meter = meter;
    if (m) st.nnBeats++;
    out.mask = m; out.info = info; return out;
  }
  function snapshot() { return {source: st.source, conf: Math.round(out.conf * 100) / 100, agree: Math.round(st.agree * 100) / 100, heardLagMs: Math.round(st.lag), switches: st.switches, meter: st.meter, bar: st.bar, barBeat: st.barBeat, nnBeats: st.nnBeats, patternBeats: st.patternBeats}; }
  return {step, reset, snapshot, state: st};
}
