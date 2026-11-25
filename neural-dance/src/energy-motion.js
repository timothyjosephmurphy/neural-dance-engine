// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Energy-driven expressive motion (TJ Nov 11 3:10-4:17 PM), shared by the
// live dancers and the side sim:
//  - Hips: the figure-8 grows and speeds up with the energy of the band the
//    dancer listens to (subtle when quiet, big when that band is hot). Speed
//    is a double-time harmonic blended in, so the loop stays phase-locked to
//    the beat clock. The bass GROOVE adds hip accents on bass onsets
//    (syncopation included), sized by bass energy.
//  - Shoulders and arms swell with SUSTAINED mid/high (pad / melody) energy,
//    not onsets: shoulder rolls and arm raises / sweeps.
//  - Claps: near or at peak, on the backbeats (2 and 4) of the locked grid,
//    preferring bars where a snare / clap transient lands there. Hands meet
//    in front of the chest (overhead at peak), with a floor ripple. At fast
//    tempos claps stay sparse (even bars only).
//  - Tempo feel: above ~110 BPM, hip figure-8s, sways and arm swings run at
//    half-time (one sway per two beats). Full-time at slower songs.
//  - Transitions ease over 150–400 ms (scaled to tempo) and peak on the beat.
// Everything is eased (attack/release envelopes, springs); per-dancer cost is
// a handful of multiply-adds.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = u => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };

// Half-time feel (TJ Nov 11 7:10 PM): above this BPM, one sway / figure-8
// / arm swing per two beats, so a fast groove does not look busy.
export const HALF_TIME_BPM = 110;
export function halfTimeFeel(bpm) { return (+bpm || 0) >= HALF_TIME_BPM; }
// 1 = full-time (one sway per beat), 0.5 = half-time (one sway per two beats).
export function swayRate(bpm) { return halfTimeFeel(bpm) ? 0.5 : 1; }

// Pose / hit ease window: 150–400 ms, about half a beat, shorter at fast tempos.
export const EASE_MIN_S = 0.15, EASE_MAX_S = 0.40;
export function easeWindowS(bpm) {
  const beat = 60 / Math.max(40, +bpm || 112);
  return clamp(0.55 * beat, EASE_MIN_S, EASE_MAX_S);
}
// Critically damped omega that settles in about one ease window (4/τ).
export function easeOmega(bpm) { return 4 / easeWindowS(bpm); }


// ---- band energy relative to the song's running level -------------------
export const ENERGY_ATTACK_S = 0.22;
export const ENERGY_RELEASE_S = 0.9;
export const RUNNING_TAU_S = 14;
export const SUSTAIN_TAU_S = 1.8;
// rel = 0 at half the running level, 1 at 1.35x it; blended with the
// absolute level so a uniformly loud song still reads loud.
export function relativeEnergy(level, running) {
  const lv = clamp(+level || 0, 0, 1.5), m = Math.max(0.04, +running || 0);
  const rel = clamp((lv - 0.5 * m) / (0.85 * m), 0, 1);
  return clamp(0.55 * rel + 0.45 * clamp(lv / 0.85, 0, 1), 0, 1);
}

export function createEnergyTracker() {
  const run = new Float64Array(4), env = new Float64Array(4), sus = new Float64Array(4);
  const out = {env, sustained: sus, t: -1};
  let last = -1, seeded = false;
  function reset() { run.fill(0); env.fill(0); sus.fill(0); last = -1; seeded = false; out.t = -1; }
  // now ms, levels [kick, bass, mid, high] 0..1, open: music present.
  function process(now, levels, open = true) {
    const dt = last < 0 ? 0 : clamp((now - last) / 1000, 0, 0.25);
    last = now; out.t = now;
    for (let b = 0; b < 4; b++) {
      const lv = open && levels ? clamp(+levels[b] || 0, 0, 1.5) : 0;
      if (!seeded) run[b] = Math.max(0.08, lv);
      else if (open) run[b] += (Math.max(0.04, lv) - run[b]) * (1 - Math.exp(-dt / RUNNING_TAU_S));
      const target = open ? relativeEnergy(lv, run[b]) : 0;
      const tau = target > env[b] ? ENERGY_ATTACK_S : ENERGY_RELEASE_S;
      env[b] += (target - env[b]) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);
      sus[b] += (target - sus[b]) * (dt > 0 ? 1 - Math.exp(-dt / SUSTAIN_TAU_S) : 0);
    }
    seeded = true;
    return out;
  }
  return {process, reset, state: out};
}

// ---- hips ----------------------------------------------------------------
export const HIP_AMP_MIN = 0.35, HIP_AMP_MAX = 1.85;
export const HIP_DOUBLE_FROM = 0.55, HIP_DOUBLE_SPAN = 0.35, HIP_DOUBLE_MAX = 0.55;
// e: band energy 0..1. amp multiplies the figure-8 amount; dbl blends in the
// double-time harmonic (faster-looking hips, still on the beat grid).
export function hipEnergyScale(e, bpm) {
  const u = smooth(clamp(+e || 0, 0, 1));
  // Double-time harmonic is busy at fast tempos; half-time drops it.
  const dbl = halfTimeFeel(bpm) ? 0
    : HIP_DOUBLE_MAX * smooth((clamp(+e || 0, 0, 1) - HIP_DOUBLE_FROM) / HIP_DOUBLE_SPAN);
  return {amp: HIP_AMP_MIN + (HIP_AMP_MAX - HIP_AMP_MIN) * u, dbl};
}
// Figure-8 path at loop angle th with double-time blend dbl (0..~0.55).
export function eightPath(th, dbl = 0) {
  const d = clamp(+dbl || 0, 0, 1), k = 1 - 0.35 * d;
  return {
    x: k * Math.sin(th) + d * Math.sin(2 * th),
    y: k * Math.sin(th) * Math.cos(th) + d * 0.5 * Math.sin(4 * th),
    z: k * Math.sin(th + Math.PI / 4) * Math.cos(th + Math.PI / 4) + d * 0.5 * Math.sin(2 * th + Math.PI / 2)
  };
}

// Bass-groove hip accents: each bass onset kicks the pelvis sideways
// (alternating, like weight thrown on the syncopation) and settles on a
// critically damped spring. value() is in figure-8 x units (~-1..1).
export const ACCENT_OMEGA = 14, ACCENT_GAIN = 1.15, ACCENT_MIN_GAP_MS = 110;
export const ACCENT_WEAK = 0.28;
export function accentMinGapMs(bpm) {
  if (!halfTimeFeel(bpm)) return ACCENT_MIN_GAP_MS;
  const beatMs = 60000 / Math.max(40, +bpm || 120);
  return Math.max(ACCENT_MIN_GAP_MS, 1.75 * beatMs);
}
export function createGrooveAccent() {
  let x = 0, v = 0, last = -1, side = 1, lastHit = -1e12, bpm = 0;
  function reset() { x = 0; v = 0; last = -1; side = 1; lastHit = -1e12; }
  function setTempo(b) { bpm = +b || 0; }
  function hit(now, energy) {
    if (now - lastHit < accentMinGapMs(bpm)) return false;
    // At half-time, skip weak onsets so not every bass hit starts a new move.
    if (halfTimeFeel(bpm) && (+energy || 0) < ACCENT_WEAK) return false;
    lastHit = now; side = -side;
    v += side * ACCENT_GAIN * ACCENT_OMEGA * clamp(0.35 + 0.65 * (+energy || 0), 0, 1);
    return true;
  }
  function step(now) {
    const dt = last < 0 ? 0 : clamp((now - last) / 1000, 0, 0.05);
    last = now;
    // critically damped toward 0
    const w = ACCENT_OMEGA, a = -2 * w * v - w * w * x;
    v += a * dt; x += v * dt;
    x = clamp(x, -1.2, 1.2);
    return x;
  }
  return {hit, step, reset, setTempo, value: () => x};
}

// ---- shoulders and arms ----------------------------------------------------
// sustained: slow envelope of the dancer's own melodic band (mid / high);
// pad: the melody-pad envelope when available. Returns 0..1 swell.
export const ARM_SWELL_FROM = 0.18, ARM_SWELL_SPAN = 0.5;
export function armSwell(sustained, pad = 0) {
  const s = Math.max(clamp(+sustained || 0, 0, 1), 0.9 * clamp(+pad || 0, 0, 1));
  return smooth((s - ARM_SWELL_FROM) / ARM_SWELL_SPAN);
}
// Which band's sustained energy moves this dancer's arms: its own melodic
// band; kick/bass dancers follow the mid band at a lower weight.
export function melodicSustain(band, sustained) {
  const b = ((band | 0) % 4 + 4) % 4;
  if (!sustained) return 0;
  if (b === 2) return +sustained[2] || 0;
  if (b === 3) return Math.max(+sustained[3] || 0, 0.8 * (+sustained[2] || 0));
  return 0.7 * Math.max(+sustained[2] || 0, +sustained[3] || 0);
}
export function armEnergyDrive(swell) {
  const s = clamp(+swell || 0, 0, 1);
  // Slightly quieter than the first preview (TJ Nov 11 7:10 PM: a little busy).
  return {padSense: 1 + 0.75 * s, shoulder: 0.6 + 0.7 * s, lift: 0.35 * s, sweep: 0.7 * s};
}

// ---- claps -----------------------------------------------------------------
export const CLAP_ACT = 0.80;        // near peak (dancer activation 0..1)
export const CLAP_ACT_NO_SNARE = 0.92;
export const CLAP_BEATS = [1, 3];   // bar beats 0..3: the backbeats 2 and 4
export const CLAP_LEAD_S = 0.15;    // hands travel in before the beat
export const CLAP_HOLD_S = 0.03;
export const CLAP_RELEASE_S = 0.24;
export const CLAP_RIPPLE = 0.55;    // ring size vs a stomp
export function clapEligible({act = 0, hot = false, rest = false, barBeat = -1, snare = 0, bpm = 0, bar = 0} = {}) {
  if (rest) return false;                                // cooldown: no claps
  if (!CLAP_BEATS.includes(barBeat | 0)) return false;
  // Fast tempos: only even bars, so claps stay sparse (one bar in two).
  if (halfTimeFeel(bpm) && ((bar | 0) & 1)) return false;
  const a = +act || 0;
  if (hot) return true;
  return a >= ((+snare || 0) >= 0.5 ? CLAP_ACT : CLAP_ACT_NO_SNARE);
}
// dt = now - beat time (s). 0 before the lead-in, 1 when the hands meet.
// lead defaults to CLAP_LEAD_S; pass easeWindowS(bpm) so the rise scales
// with tempo (150–400 ms) and the pose peaks on the beat, not after it.
export function clapEnvelope(dt, lead = CLAP_LEAD_S) {
  const leadS = clamp(+lead || CLAP_LEAD_S, EASE_MIN_S, EASE_MAX_S);
  const t = +dt;
  if (!Number.isFinite(t) || t < -leadS || t > CLAP_HOLD_S + CLAP_RELEASE_S) return 0;
  if (t < 0) return smooth((t + leadS) / leadS);
  if (t <= CLAP_HOLD_S) return 1;
  return 1 - smooth((t - CLAP_HOLD_S) / CLAP_RELEASE_S);
}
// Snare-on-backbeat pattern: EMA per bar beat of snare onsets heard there.
export function createSnarePattern() {
  const w = new Float64Array(4);
  return {
    note(barBeat, snare) { const b = ((barBeat | 0) % 4 + 4) % 4; w[b] += ((snare ? 1 : 0) - w[b]) * 0.25; },
    backbeat() { return Math.max(w[1], w[3]); },
    reset() { w.fill(0); },
    state: w
  };
}

// Pose: blend each arm toward a 2-bone IK reach whose hands meet in front of
// the chest (overhead=0) or above the head (overhead=1). Bone lengths kept.
function sub(a, c) { return {x: a.x - c.x, y: a.y - c.y, z: (+a.z || 0) - (+c.z || 0)}; }
function len(v) { return Math.hypot(v.x, v.y, v.z); }
function unit(v) { const l = len(v) || 1; return {x: v.x / l, y: v.y / l, z: v.z / l}; }
function mixU(a, c, t) { return unit({x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t}); }
function put(from, d, l) { return {x: from.x + d.x * l, y: from.y + d.y * l, z: (+from.z || 0) + d.z * l}; }
function ik3(S, T, l1, l2, pole) {
  const d = sub(T, S); let L = len(d);
  const maxL = (l1 + l2) * 0.999; if (L > maxL) L = maxL;
  const dir = unit(d);
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // pole direction orthogonal to dir
  const pd = pole.x * dir.x + pole.y * dir.y + pole.z * dir.z;
  const pp = unit({x: pole.x - pd * dir.x, y: pole.y - pd * dir.y, z: pole.z - pd * dir.z});
  const el = {x: S.x + dir.x * a + pp.x * h, y: S.y + dir.y * a + pp.y * h, z: (+S.z || 0) + dir.z * a + pp.z * h};
  const wr = {x: S.x + dir.x * L, y: S.y + dir.y * L, z: (+S.z || 0) + dir.z * L};
  return {el, wr};
}
// TJ arm rule (Nov 11 5:46 PM): in side view no elbow / wrist / hand goes
// further back than the back of the head. Re-aim a bone forward if it would.
export const HEAD_BACK_Z = 0.066; // head radius behind the shoulder line (units)
function aimFront(from, d, l, backZ) {
  if (!(l > 0) || (+from.z || 0) + d.z * l >= backZ) return d;
  const dz = clamp((backZ - (+from.z || 0)) / l, -1, 1);
  const k = Math.sqrt(Math.max(0, 1 - dz * dz)) / (Math.hypot(d.x, d.y) || 1);
  return {x: d.x * k, y: d.y * k, z: dz};
}
export function applyClap(j, amount, overhead = 0, backZ = null) {
  const w = clamp(+amount || 0, 0, 1);
  if (!(w > 0.001) || !j || !j.shL || !j.shR) return j;
  const oh = clamp(+overhead || 0, 0, 1);
  const shW = Math.abs(j.shR.x - j.shL.x) || 0.2;
  const mid = {x: (j.shL.x + j.shR.x) / 2, y: (j.shL.y + j.shR.y) / 2, z: ((+j.shL.z || 0) + (+j.shR.z || 0)) / 2};
  const reach = j.elL && j.wristL ? len(sub(j.elL, j.shL)) + len(sub(j.wristL, j.elL)) : 2 * shW;
  // Reachable meet point: in front of the chest, or overhead (arms ~85% extended).
  const chest = {x: mid.x, y: mid.y + 0.30 * reach, z: mid.z + 0.62 * reach};
  const up = {x: mid.x, y: mid.y - Math.sqrt(Math.max(0, (0.86 * reach) ** 2 - (0.5 * shW) ** 2)), z: mid.z + 0.12 * reach};
  const meet = {x: mid.x, y: chest.y + (up.y - chest.y) * oh, z: chest.z + (up.z - chest.z) * oh};
  const zBack = Number.isFinite(+backZ) && backZ !== null ? +backZ : mid.z - HEAD_BACK_Z;
  for (const s of ['L', 'R']) {
    const sh = j['sh' + s], el = j['el' + s], wr = j['wrist' + s], hd = j['hand' + s];
    if (!sh || !el || !wr || !hd) continue;
    const side = s === 'L' ? -1 : 1;
    const lu = len(sub(el, sh)), lf = len(sub(wr, el)), lh = len(sub(hd, wr));
    const T = {x: meet.x + side * 0.012, y: meet.y, z: meet.z};
    const pole = {x: side, y: oh ? 0.2 : 1, z: -0.3};
    const r = ik3(sh, T, lu, lf, pole);
    const handDir = unit({x: -side * 0.08, y: oh ? -1 : -0.55, z: oh ? 0.15 : 0.8}); // palms together, fingers forward-up
    const du = mixU(unit(sub(el, sh)), unit(sub(r.el, sh)), w);
    const df = mixU(unit(sub(wr, el)), unit(sub(r.wr, r.el)), w);
    const dh = mixU(unit(sub(hd, wr)), handDir, w);
    const e2 = put(sh, aimFront(sh, du, lu, zBack), lu);
    const w2 = put(e2, aimFront(e2, df, lf, zBack), lf);
    const h2 = put(w2, aimFront(w2, dh, lh, zBack), lh);
    j['el' + s] = e2; j['wrist' + s] = w2; j['hand' + s] = h2;
  }
  return j;
}
