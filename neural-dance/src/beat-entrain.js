// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Beat entrainment (TJ Nov 11 2:29 PM): dancers predict their band's beats
// from the locked song tempo and stomp on every predicted beat, instead of
// reacting to each detected attack. A real attack that lands on a predicted
// beat gives that band's dancers an activation boost (onBeat mask).
//
// One shared grid per song: period from the song tempo lock (one BPM per
// song, song-tempo-lock.js), phase from heard onsets. Heard onsets come out of
// the analyser late (FFT window + onset picking), so an onset heard at t is
// placed at t - lagMs on the grid. Only onsets near a beat nudge the phase
// (small, clamped steps); off-grid attacks are syncopation and leave it alone.
// Each band steps at its own ratio of the beat (kick x1, bass x1/2, hats x2),
// only while it is playing. The bar downbeat is learned from where the kick
// lands, so strides go on 1 and 3. O(1) per frame, no allocation.

export const ENTRAIN_LAG_MS = 60;
export const PHASE_GAIN = 0.2;       // share of the error corrected per on-beat onset
export const PHASE_MAX = 0.04;       // largest single nudge, of a beat
export const SYNC_TOL = 0.3;         // |error| beyond this (of a band beat) = syncopation
export const ON_BEAT_MS = [45, 90];  // on-beat window: 12% of the band beat, clamped
export const PRESENT_BARS = 2;       // a band steps only if heard within this
export const BAR = 4;
const GRID_R = [1 / 4, 1 / 3, 1 / 2, 1, 2];

export function snapBandRatio(P, Pb) {
  if (!(P > 0) || !(Pb > 0)) return 0;
  const r = P / Pb;
  let best = 0, err = 0.12;
  for (const g of GRID_R) { const e = Math.abs(Math.log(r / g)); if (e < err) { err = e; best = g; } }
  return best;
}
function wrap(x) { return x - Math.floor(x + 0.5); } // to [-0.5, 0.5)

export function createBeatEntrain({lagMs = ENTRAIN_LAG_MS} = {}) {
  const lastHeard = new Float64Array(4).fill(-1e12);
  const lastStep = new Float64Array(4).fill(-1e12);
  const ratio = new Float64Array(4);
  const subDone = new Int32Array(4);
  const barKick = new Float64Array(BAR);
  const info = {period: new Float64Array(4), locked: [false, false, false, false], pos: new Int32Array(4).fill(-1),
    cyc: new Int32Array(4), accent: new Float64Array(4).fill(1), bar: 0, barBeat: -1, meter: BAR, entrain: true};
  const out = {mask: 0, onBeat: 0, info, active: false, downbeat: false};
  const st = {P: 0, bpm: 0, anchor: -1, beat: 0, beatAt: -1, down: 0, extDown: -1, steps: 0, onBeats: 0, offBeats: 0, nudges: 0, lastErrMs: 0};

  function reset() {
    lastHeard.fill(-1e12); lastStep.fill(-1e12); ratio.fill(0); subDone.fill(0); barKick.fill(0);
    Object.assign(st, {P: 0, bpm: 0, anchor: -1, beat: 0, beatAt: -1, down: 0, extDown: -1, steps: 0, onBeats: 0, offBeats: 0, nudges: 0, lastErrMs: 0});
    out.mask = 0; out.onBeat = 0; out.active = false;
  }

  function ratioFor(b, s) {
    const Pb = s.period ? +s.period[b] : 0;
    const r = snapBandRatio(st.P, Pb);
    if (r > 0) ratio[b] = r; else if (!(ratio[b] > 0)) ratio[b] = b === 3 ? 2 : 1;
    return ratio[b];
  }

  // s: {bpm (song lock, 0 = none), gateOpen, onsets (real onset band mask),
  //     heard (band beats the room heard this frame), period (per-band tracked
  //     beat periods, ms)}
  function step(now, s) {
    out.mask = 0; out.onBeat = 0; out.downbeat = false;
    const bpm = +s.bpm || 0;
    if (!(bpm >= 40 && bpm <= 260)) { out.active = false; st.anchor = -1; st.P = 0; return out; }
    const P = 60000 / bpm;
    if (st.P > 0 && Math.abs(P / st.P - 1) > 1e-6 && st.anchor >= 0) {
      // Re-lock to a new BPM: keep the phase and the bar (beat 0 = last beat).
      const shift = ((st.beat % BAR) + BAR) % BAR;
      const rot = new Float64Array(BAR);
      for (let i = 0; i < BAR; i++) rot[((i - shift) % BAR + BAR) % BAR] = barKick[i];
      barKick.set(rot);
      st.down = ((st.down - shift) % BAR + BAR) % BAR;
      st.anchor = st.beatAt; st.beat = 0;
    }
    st.P = P; st.bpm = bpm;
    const on = s.onsets | 0, heard = s.heard | 0;
    for (let b = 0; b < 4; b++) if ((on | heard) & (1 << b)) lastHeard[b] = now;
    if (s.gateOpen === false) { out.active = st.anchor >= 0; return out; }
    // First onset after a lock places the grid.
    if (st.anchor < 0) {
      if (!on && !heard) return out;
      st.anchor = now - lagMs; st.beat = 0; st.beatAt = st.anchor; subDone.fill(0);
    }
    out.active = true;
    // Heard onsets: on-beat boost and phase nudge.
    if (on) {
      const ta = now - lagMs;
      for (let b = 0; b < 4; b++) {
        if (!(on & (1 << b))) continue;
        const r = ratioFor(b, s), Pb = P / r;
        const x = wrap((ta - st.anchor) / Pb);
        const errMs = x * Pb;
        const tol = Math.max(ON_BEAT_MS[0], Math.min(ON_BEAT_MS[1], 0.12 * Pb));
        if (Math.abs(errMs) <= tol) { out.onBeat |= 1 << b; st.onBeats++; } else st.offBeats++;
        if (Math.abs(x) < SYNC_TOL && r <= 1) {
          const d = Math.max(-PHASE_MAX * P, Math.min(PHASE_MAX * P, PHASE_GAIN * errMs));
          st.anchor += d; st.nudges++; st.lastErrMs = Math.round(errMs);
          if (b === 0 && Math.abs(errMs) <= tol) {
            // Learn the downbeat from where on-beat kicks land in the bar.
            const k = Math.round((ta - st.anchor) / P);
            const place = ((k - 0) % BAR + BAR) % BAR;
            for (let i = 0; i < BAR; i++) barKick[i] *= 0.995;
            barKick[place] += 1;
          }
        }
      }
    }
    // Main beat crossing.
    const kNow = Math.floor((now - st.anchor) / P + 1e-6);
    let fresh = false;
    if (kNow > st.beat) { st.beat = kNow; st.beatAt = st.anchor + kNow * P; subDone.fill(0); fresh = true; }
    let best = 0, sum = 0;
    for (let i = 0; i < BAR; i++) { sum += barKick[i]; if (barKick[i] > barKick[best]) best = i; }
    // Hysteresis: four-on-the-floor kicks give no downbeat; keep the current one.
    if (sum >= 4 && best !== st.down && barKick[best] > 1.25 * barKick[st.down] + 0.5) st.down = best;
    // A learned bar start (groove-learn.js, ND Listen v2) wins while confident.
    const down = st.extDown >= 0 ? st.extDown : st.down;
    const barBeat = ((st.beat - 0 - down) % BAR + BAR) % BAR;
    info.barBeat = barBeat; info.bar = Math.floor((st.beat - down) / BAR);
    if (fresh && barBeat === 0) out.downbeat = true;
    const present = PRESENT_BARS * BAR * P;
    for (let b = 0; b < 4; b++) {
      info.pos[b] = -1; info.cyc[b] = 0;
      if (now - lastHeard[b] > present) continue; // not playing: no steps (sway carries on)
      const r = ratioFor(b, s), Pb = P / r;
      let fire = false, pos = -1, cyc = 0, sub = 0;
      if (r >= 1) {
        const n = Math.round(r);
        if (fresh) fire = true;
        else if (n > 1) {
          const j = Math.floor((now - st.beatAt) / Pb + 1e-6);
          if (j >= 1 && j < n && j > subDone[b]) { fire = true; sub = j; subDone[b] = j; }
        }
        pos = barBeat * n + sub; cyc = BAR * n;
      } else {
        const n = Math.round(1 / r);
        if (fresh && barBeat % n === 0) fire = true;
        pos = Math.floor(barBeat / n); cyc = BAR / n;
      }
      if (!fire || now - lastStep[b] < 0.45 * Pb) continue;
      out.mask |= 1 << b; lastStep[b] = now; st.steps++;
      info.period[b] = Pb; info.locked[b] = true; info.pos[b] = pos; info.cyc[b] = cyc;
      info.accent[b] = sub > 0 ? 0.82 : barBeat === 0 ? 1 : barBeat === 2 ? 0.92 : 0.88;
    }
    return out;
  }
  // Bar start from a confident groove learner: d = clock beat index mod 4 that
  // is beat 1 (-1 = back to the kick-learned downbeat). Takes effect on the
  // next beat crossing.
  function setDownbeat(d) { st.extDown = Number.isInteger(d) && d >= 0 ? d % BAR : -1; return st.extDown; }
  // Predicted audio time of the next main beat (ms), or -1.
  function nextBeat(now) { return st.anchor >= 0 && st.P > 0 ? st.anchor + (Math.floor((now - st.anchor) / st.P) + 1) * st.P : -1; }
  function snapshot() {
    return {active: out.active, bpm: Math.round(st.bpm * 10) / 10, steps: st.steps, onBeats: st.onBeats, offBeats: st.offBeats,
      nudges: st.nudges, lastErrMs: st.lastErrMs, downbeat: st.down, grooveDownbeat: st.extDown, lagMs};
  }
  return {step, reset, snapshot, nextBeat, setDownbeat, state: st};
}
