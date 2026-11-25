// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Remaining side-sim body motion ported into the live renderer
// (TJ 8:02 / 8:12 PM): spine flex, arm flex, leg waves, glute/thigh
// jiggle, heel-toe footwork, hip figure-eight, and per-dancer stomp
// intensity. Defaults match the side-sim sliders. All of it scales to
// zero in silence (hush=0) and leaves planted feet unmoved in x.

import {pulseWaveAt, pulseDriveHz, pulseTravelTimes, CHAKRA_S} from './vibrating-string.js';
import {clamp, hash01, rotateFacing, yawExtent} from './geometry.js';

export {hash01, rotateFacing, yawExtent};
const HEART_S = 2.0 / 4.0; // root→crown heart chakra (2H from crown, crotch at 4H)

export const SPINE_FLEX = 0.85;
// Human ranges (TJ Nov 10 5:46 PM): the torso may flex; shoulders may leave
// the hips. Caps are the anatomical ceiling; motion is still critically
// damped and driven by music / activation, not noise.
export const SPINE_MAX_SEG_DEG = 16;                 // each station
export const SPINE_MAX_LATERAL = 30 * Math.PI / 180; // lumbar+thoracic side bend
export const SPINE_MAX_FLEX = 40 * Math.PI / 180;    // forward; squat/bow may add more
export const SPINE_MAX_FLEX_SQUAT = 15 * Math.PI / 180;
export const SPINE_MAX_EXT = 10 * Math.PI / 180;     // mild chest-open, not a backbend (was 20°; TJ Nov 11 6:50 PM)
export const SPINE_MAX_CHEST = 30 * Math.PI / 180;   // alias: combined lateral
export const SPINE_MAX_TOTAL = 50 * Math.PI / 180;   // through the neck (flex+neck)
export const SPINE_LAG = 4.0;
export const SH_REL_LIM = 42 * Math.PI / 180;        // axial twist, shoulders vs hips
export const HIP_YAW_LIM = 26 * Math.PI / 180;        // hip yaw vs feet (20–30°); body facing can turn further
const S_ROOT = (CHAKRA_S.find(c => c.id === 'root') || {s: 0}).s;
const S_HEART = (CHAKRA_S.find(c => c.id === 'heart') || {s: 0.417}).s;
const S_THROAT = (CHAKRA_S.find(c => c.id === 'throat') || {s: 0.781}).s;

function pulseOpts(amp, hz, times) {
  return waveOpts(Math.max(1e-6, +amp || 20), hz, times);
}
// Signed string displacement in units of amplitude (~[-1.2, 1.2]).
export function stringAnchorAt(s, tSec, strikes, amp, hz, times) {
  if (!strikes || !strikes.length) return 0;
  const opts = pulseOpts(amp, hz, times);
  return pulseWaveAt(s, tSec, strikes, opts) / opts.amp;
}
export function stringAnchorVel(s, tSec, strikes, amp, hz, times, dt = 1 / 60) {
  const a = stringAnchorAt(s, tSec, strikes, amp, hz, times);
  const b = stringAnchorAt(s, tSec - dt, strikes, amp, hz, times);
  return (a - b) / Math.max(1e-4, dt);
}
// Foot-strike impulses + the same pulse arriving at the pelvis after times.leg.
function hipFootPulseDrive({tSec, strikes, times, planted = -1, still = false, fw = null, stomp = 0} = {}) {
  // Take the dominant (newest / strongest) event rather than summing opposite
  // feet, which cancelled hip twist when strikes alternated every beat.
  let foot = 0, pelvis = 0;
  const list = Array.isArray(strikes) ? strikes : [];
  const ts = times || pulseTravelTimes();
  const stompU = Math.max(0, Math.min(1, +stomp || 0));
  for (const ev of list) {
    const side = ev.side < 0 ? -1 : 1;
    const age = tSec - ev.t0;
    const en = ev.energy != null ? (0.45 + 0.55 * Math.max(0, Math.min(1, +ev.energy || 0))) : 1;
    if (age >= 0 && age < 0.26) {
      const fImp = side * Math.exp(-age / 0.11) * en * (1 + 0.35 * stompU);
      if (Math.abs(fImp) >= Math.abs(foot)) foot = fImp;
    }
    const ageP = age - (ts.leg || 0);
    if (ageP >= -0.03 && ageP < 0.22) {
      const gate = ageP < 0 ? (ageP + 0.03) / 0.03 : Math.exp(-ageP / 0.10);
      const pImp = side * gate * en;
      if (Math.abs(pImp) >= Math.abs(pelvis)) pelvis = pImp;
    }
  }
  const rock = fw ? ((+fw.rockR || 0) - (+fw.rockL || 0)) : 0;
  const art = fw && fw.artEnv ? ((fw.artSide < 0 ? -1 : 1) * fw.artEnv) : 0;
  const weight = still ? 0 : -(planted < 0 ? -1 : 1) * 0.45;
  return {foot: Math.tanh(foot + 0.55 * rock + 0.65 * art + weight * 0.55), pelvis: Math.tanh(pelvis), weight};
}
// Pulse arriving at the heart / throat: a short signed envelope so shoulder
// twist still happens when the standing-wave sine is near a zero crossing.
function chestPulseDrive({tSec, strikes, times} = {}) {
  let heart = 0, throat = 0;
  const list = Array.isArray(strikes) ? strikes : [];
  const ts = times || pulseTravelTimes();
  const str = ts.str || 0, leg = ts.leg || 0;
  const tHeart = leg + str * S_HEART;
  const tThroat = leg + str * S_THROAT;
  for (const ev of list) {
    const side = ev.side < 0 ? -1 : 1;
    const en = ev.energy != null ? (0.45 + 0.55 * Math.max(0, Math.min(1, +ev.energy || 0))) : 1;
    const ageH = tSec - ev.t0 - tHeart;
    if (ageH >= -0.03 && ageH < 0.34) {
      const gate = ageH < 0 ? (ageH + 0.03) / 0.03 : Math.exp(-ageH / 0.16);
      const v = side * gate * en;
      if (Math.abs(v) >= Math.abs(heart)) heart = v;
    }
    const ageT = tSec - ev.t0 - tThroat;
    if (ageT >= -0.03 && ageT < 0.34) {
      const gate = ageT < 0 ? (ageT + 0.03) / 0.03 : Math.exp(-ageT / 0.16);
      const v = side * gate * en;
      if (Math.abs(v) >= Math.abs(throat)) throat = v;
    }
  }
  return {heart: Math.tanh(heart), throat: Math.tanh(throat)};
}
const pickDrive = (a, b) => Math.abs(a) >= Math.abs(b) ? a : b;

// Cervical tilt / turn follows the upper chakra string (heart, throat),
// softly and within a small natural range (TJ Nov 10 6:19 PM).
export const NECK_TILT_MAX = 14 * Math.PI / 180;
export const NECK_TURN_MAX = 16 * Math.PI / 180;
const neckFollowMap = new Map();
export function resetNeckFollow(id) {
  if (id == null) neckFollowMap.clear();
  else neckFollowMap.delete(id | 0);
}
export function neckStringFollow({
  id = 0, tSec = 0, strikes = null, pulseAmp = 0, pulseHz = 0.9, times = null,
  activation = 0, hush = 1, still = false
} = {}) {
  const key = id | 0;
  let st = neckFollowMap.get(key);
  const t = +tSec || 0;
  if (!st || !Number.isFinite(st.t) || Math.abs(t - st.t) > 0.55) st = {t, tilt: {x: 0, v: 0}, turn: {x: 0, v: 0}};
  const dt = Math.max(0, Math.min(0.05, t - st.t));
  st.t = t;
  const env = (still || !(+hush > 0.05)) ? 0 : Math.max(0, Math.min(1, +activation || 0)) * Math.max(0, Math.min(1, +hush || 0));
  const sm = env * env * (3 - 2 * env);
  const has = Array.isArray(strikes) && strikes.length > 0;
  const heart = has ? stringAnchorAt(S_HEART, t, strikes, pulseAmp, pulseHz, times) : 0;
  const throat = has ? stringAnchorAt(S_THROAT, t, strikes, pulseAmp, pulseHz, times) : 0;
  const tiltT = sm * NECK_TILT_MAX * Math.max(-1, Math.min(1, 0.70 * throat + 0.30 * heart));
  const turnT = sm * NECK_TURN_MAX * Math.max(-1, Math.min(1, 0.55 * heart + 0.45 * throat));
  if (dt > 1e-6) {
    st.tilt = stepCritDamp(st.tilt.x, st.tilt.v, tiltT, dt, 10);
    st.turn = stepCritDamp(st.turn.x, st.turn.v, turnT, dt, 10);
  }
  if (neckFollowMap.size > 256) neckFollowMap.clear();
  neckFollowMap.set(key, st);
  return {tilt: st.tilt.x, turn: st.turn.x};
}



export const SH_SHIFT_HEADS = 0.38;                  // shoulder lateral shift
export const SH_SHRUG_HEADS = 0.15;
export const ARM_FLEX = 0.80;
export const LEG_COMPLEX = 0.70;
export const JIGGLE = 0.65;
export const HIP_EIGHT = 0.80;
export const SHOULDER_EIGHT = 0.70;
// Independent multipliers on the 3D Lissajous: front-back (z) and up-down (y).
export const EIGHT_DEPTH = 0.85;
export const EIGHT_VERT = 0.80;
export const SAME_FOOT_THRESH = 0.60;
// Stomp: rest is a soft fraction of the full impact; peak is the existing
// softer-stomp ceiling (TJ Nov 10 6:20 PM).
export const STOMP_PEAK = 0.65; // === STOMP_SOFT / PULSE_SOFT ceiling
export const STOMP_REST_FRAC = 0.20; // ~0.15–0.25 of full at rest
export const STOMP_CALM = STOMP_PEAK * STOMP_REST_FRAC;

export const FOOT_LEN = 0.080;
export const FOOT_HEEL = 0.022;
export const FOOT_TOE = 0.058;
export const FOOT_ANK_H = 0.99 * 0.25 / 7.5; // 0.25 heads above the floor (ankle ~7.25 H)
export const ROCK_MAX = 22 * Math.PI / 180;
// Default feet point +z (toward the audience). A small toe-out keeps them
// from looking bolted parallel; body yaw (applyBodyYaw) can turn them up to 90°.
export const FOOT_TOE_OUT = 12 * Math.PI / 180;

const deg = d => d * Math.PI / 180;
const smoothstep = t => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

export function stompIntensity(activation, hush = 1) {
  const a = clamp(+activation || 0, 0, 1);
  const u = smoothstep(a);
  const s = STOMP_CALM + (STOMP_PEAK - STOMP_CALM) * u;
  return s * clamp(hush == null ? 1 : +hush, 0, 1);
}

export function sameFootThreshSec(periodSec, mul = SAME_FOOT_THRESH) {
  const T = Math.max(0.05, +periodSec || 0.5);
  const m = Number.isFinite(+mul) ? +mul : SAME_FOOT_THRESH;
  return Math.max(0.04, m * T);
}

export function stringPeriodSec(stepHz) {
  const hz = pulseDriveHz(Math.max(0.25, +stepHz || 1));
  return 1 / Math.max(0.25, hz);
}

function stepCritDamp(x, v, u, dt, omega) {
  const w = Math.max(1e-4, omega);
  const y0 = x - u;
  const A = y0;
  const B = v + w * y0;
  const e = Math.exp(-w * dt);
  const y = (A + B * dt) * e;
  const nv = (B - w * (A + B * dt)) * e;
  return {x: y + u, v: nv};
}

const SPINE_JOINTS = [
  {id: 'pelvis', s: 0.070},
  {id: 'lumbar', s: 0.208},
  {id: 'thoracic', s: 0.417},
  {id: 'neck', s: 0.781}
];

function waveOpts(amp, hz, times) {
  return {amp: Math.max(1e-6, +amp || 0), hz: Number.isFinite(+hz) ? +hz : 0.9, times: times || pulseTravelTimes()};
}

function spineInstant(t, list, opts) {
  return SPINE_JOINTS.map(j => {
    const ds = 0.10;
    const d0 = pulseWaveAt(j.s, t, list, opts);
    const dm = pulseWaveAt(Math.max(0, j.s - ds), t, list, opts);
    const dp = pulseWaveAt(Math.min(1, j.s + ds), t, list, opts);
    const ref = Math.max(8, opts.amp);
    const disp = d0 / ref;
    const curv = ((dm - 2 * d0 + dp) / (ds * ds)) * (0.10 * 0.10) / ref;
    return 0.32 * disp + 0.68 * curv;
  });
}

function seedSpineStates(tSec, list, opts, T, r, omega) {
  // Warm the filter once on a new dancer / time jump, then persist.
  const dt = 1 / 30;
  const look = Math.min(0.72, Math.max(0.48, 0.55 * T * r));
  const t0 = tSec - look;
  const states = SPINE_JOINTS.map(() => ({x: 0, v: 0}));
  let inited = false;
  for (let t = t0; t <= tSec + 1e-9; t += dt) {
    const inst = spineInstant(t, list, opts);
    if (!inited) {
      for (let i = 0; i < states.length; i++) { states[i].x = inst[i]; states[i].v = 0; }
      inited = true;
    } else {
      for (let i = 0; i < states.length; i++) {
        states[i] = stepCritDamp(states[i].x, states[i].v, inst[i], dt, omega);
      }
    }
  }
  return states;
}

const spineMap = new Map();
export function resetSpineFlex(id) {
  if (id == null) spineMap.clear();
  else spineMap.delete(id | 0);
}

export function spineFlexState({id = 0, tSec, strikes, activation = 0, amp = 0, hz = 0.9, times, periodSec, hush = 1, amount = SPINE_FLEX, lagMul = SPINE_LAG, squat = 0, tall = 0} = {}) {
  const zero = {
    energy: +activation || 0,
    env: 0,
    angles: {pelvis: 0, lumbar: 0, thoracic: 0, neck: 0, head: 0},
    phi: {pelvis: 0, lumbar: 0, thoracic: 0, neck: 0, head: 0, pitchP: 0, pitchL: 0, pitchT: 0, pitchN: 0, pitchH: 0},
    squat: 0
  };
  const h = clamp(+hush || 0, 0, 1);
  if (!(+tSec >= 0) || !(amount > 0.001)) return zero;
  const T = Math.max(0.25, +periodSec || stringPeriodSec(1));
  const energy = Math.max(0, +activation || 0);
  const r = 1.05 + 0.12 * ((+lagMul || SPINE_LAG) - 2);
  const omegaShape = (2 * Math.PI / T) / r;
  const lagFeel = clamp(0.55 + 0.45 * (4 / Math.max(2, +lagMul || SPINE_LAG)), 0.55, 1);
  const envT = clamp(0.28 + 0.72 * lagFeel * clamp(energy / 0.85, 0, 1.15), 0, 1.2) * h;
  const squatU = clamp(+squat || 0, 0, 1) * h * (1 - clamp(+tall || 0, 0, 1));
  const opts = waveOpts(amp, hz, times);
  const list = Array.isArray(strikes) ? strikes : [];
  const key = id | 0;
  const t = +tSec;
  let st = spineMap.get(key);
  if (!st || !Number.isFinite(st.t) || Math.abs(t - st.t) > 0.55) {
    const joints = h > 0 ? seedSpineStates(t, list, opts, T, r, omegaShape) : SPINE_JOINTS.map(() => ({x: 0, v: 0}));
    st = {t, joints, pitch: {x: 0, v: 0}, lat: {x: 0, v: 0}, env: envT, seeded: true};
  }
  if (!st.pitch) st.pitch = {x: 0, v: 0};
  if (!st.lat) st.lat = {x: 0, v: 0};
  const dt = Math.max(0, Math.min(0.05, t - st.t));
  st.t = t;
  if (dt > 1e-6) {
    const ke = 1 - Math.exp(-dt * 8);
    st.env += (envT - (st.env || 0)) * ke;
  } else if (!Number.isFinite(st.env)) st.env = envT;
  const env = st.env;
  const inst = h > 0 ? spineInstant(t, list, opts) : SPINE_JOINTS.map(() => 0);
  if (dt > 1e-6) {
    for (let i = 0; i < st.joints.length; i++) {
      st.joints[i] = stepCritDamp(st.joints[i].x, st.joints[i].v, inst[i], dt, omegaShape);
    }
  }
  const states = st.joints;
  const Om = 2 * Math.PI / T;
  const w = omegaShape;
  const gainH = (w * w) / Math.hypot(w * w - Om * Om, 2 * w * Om);
  const gainComp = clamp(1 / Math.max(0.22, gainH), 1, 2.2);
  const maxSeg = deg(SPINE_MAX_SEG_DEG);
  // d634f3a used a 2.05 drive gain so high-energy pulses actually reach the cap.
  const scale = amount * env * gainComp * 2.05;
  const angOf = x => clamp(x * scale * maxSeg, -maxSeg, maxSeg);
  const pulseP = angOf(states[0].x);
  const pulseL = angOf(states[1].x);
  const pulseT = angOf(states[2].x);
  const pulseN = angOf(states[3].x);
  const soft = (v, lim) => {
    const a = Math.abs(v), L = Math.max(1e-6, lim);
    if (a <= L) return v;
    // Approach L from below; never exceed the stated cap.
    return Math.sign(v) * L * (a / (a + 0.15 * L));
  };
  // Shared lateral sway (one cycle per beat), plus a little pulse texture.
  // Distributed as a smooth curve so the torso bends, not kinks.
  const swayOsc = Math.sin(2 * Math.PI * t / Math.max(1.2, 3 * T));
  const latTarget = SPINE_MAX_LATERAL * env * (0.95 * swayOsc + 0.12 * (states[1].x || 0) * scale);
  if (dt > 1e-6) st.lat = stepCritDamp(st.lat.x, st.lat.v, latTarget, dt, Math.max(8, omegaShape));
  else if (!Number.isFinite(st.lat.x)) st.lat = {x: latTarget, v: 0};
  const lat = soft(st.lat.x, SPINE_MAX_LATERAL);
  const pelvis = soft(lat * 0.18 + pulseP * 0.22, maxSeg);
  const lumbar = soft(lat * 0.40 + pulseL * 0.22, maxSeg);
  const thoracic = soft(lat * 0.32 + pulseT * 0.22, maxSeg);
  const neckA = soft(lat * 0.10 + pulseN * 0.22, maxSeg);
  const chest = soft(pelvis + lumbar + thoracic, SPINE_MAX_LATERAL);
  const kC = Math.abs(pelvis + lumbar + thoracic) > 1e-9 ? chest / (pelvis + lumbar + thoracic) : 1;
  const phiP = pelvis * kC;
  const phiL = (pelvis + lumbar) * kC;
  const phiT = chest;
  const phiN = soft(phiT + neckA * kC, SPINE_MAX_LATERAL + deg(18));
  const head = clamp(-0.65 * phiN, -deg(18), deg(18));

  // Sagittal: music-driven bow / chest-open, plus squat. Forward (positive,
  // toward the audience) up to ~40° + squat; extension stays a mild chest-open
  // (~10°), not a swayback (TJ Nov 11 6:50 PM).
  const chestWave = inst[2] || 0;
  const bowOsc = Math.sin(2 * Math.PI * t / Math.max(1.6, 4 * T));
  const extOsc = Math.max(0, -bowOsc); // chest-open on the opposite half-cycle
  const bowT = (
    SPINE_MAX_FLEX * env * (0.85 * Math.max(0, bowOsc) + 0.12 * chestWave) * (1 - 0.45 * squatU)
    + (SPINE_MAX_FLEX + SPINE_MAX_FLEX_SQUAT) * squatU
    - SPINE_MAX_EXT * env * extOsc * (1 - squatU) * (0.85 + 0.15 * clamp(+tall || 0, 0, 1))
  );
  if (dt > 1e-6) st.pitch = stepCritDamp(st.pitch.x, st.pitch.v, bowT, dt, Math.max(10, omegaShape));
  else if (!Number.isFinite(st.pitch.x)) st.pitch = {x: bowT, v: 0};
  const flexLim = SPINE_MAX_FLEX + SPINE_MAX_FLEX_SQUAT * squatU;
  let pitch = st.pitch.x;
  pitch = pitch >= 0 ? soft(pitch, flexLim) : soft(pitch, SPINE_MAX_EXT);
  // Distribute as a smooth curve: lumbar takes the most, then thoracic, neck a little.
  const pLumbar = pitch * 0.50;
  const pThor = pitch * 0.85;
  const pNeck = soft(pitch * 1.00, flexLim + deg(12));
  const pHead = clamp(-0.50 * pNeck, -deg(20), deg(22));

  if (spineMap.size > 256) spineMap.clear();
  spineMap.set(key, st);
  return {
    energy,
    env,
    squat: squatU,
    angles: {pelvis, lumbar, thoracic, neck: neckA, head},
    phi: {
      pelvis: phiP, lumbar: phiL, thoracic: phiT, neck: phiN, head: phiN + head,
      pitchP: pitch * 0.15, pitchL: pLumbar, pitchT: pThor, pitchN: pNeck, pitchH: pNeck + pHead
    }
  };
}

export function armPulseEvents(strikes, tSec, times) {
  const ts = times || pulseTravelTimes();
  const tArm = Math.max(0.04, ts.full - (ts.leg + ts.str * HEART_S));
  const heartArrive = ts.leg + ts.str * HEART_S;
  const out = [];
  for (const s of strikes || []) {
    const age = tSec - s.t0 - heartArrive;
    if (age < -0.08 || age > 1.6) continue;
    out.push({age, tArm, side: s.side < 0 ? -1 : 1, energy: Math.max(0, +s.energy || 0)});
  }
  return out;
}

export function armWaveFlex({tSec, strikes, times, hush = 1, amount = ARM_FLEX} = {}) {
  const out = {elL: 0, elR: 0, wrL: 0, wrR: 0};
  const g = (+amount || 0) * clamp(+hush || 0, 0, 1);
  if (!(g > 0.001)) return out;
  const evs = armPulseEvents(strikes, tSec, times);
  const omegaEl = 2 * Math.PI * 3.1;
  const omegaWr = 2 * Math.PI * 3.8;
  const z = 0.78;
  const resp = (age, arrive, omega) => {
    const a = age - arrive;
    if (a < -0.06) return 0;
    const attack = a < 0 ? 0.5 * (1 + Math.cos(Math.PI * a / 0.06)) : 1;
    const wd = omega * Math.sqrt(Math.max(1e-6, 1 - z * z));
    const ring = a >= 0 ? Math.exp(-z * omega * a) * Math.cos(wd * a) : 1;
    return attack * ring;
  };
  for (const e of evs) {
    const fundEl = resp(e.age, e.tArm * 0.38, omegaEl);
    const fundWr = resp(e.age, e.tArm * 0.88, omegaWr);
    const h2El = 0.35 * resp(e.age, e.tArm * 0.38, omegaEl * 1.85);
    const h2Wr = 0.40 * resp(e.age, e.tArm * 0.88, omegaWr * 1.85);
    const el = (fundEl + h2El) * g * (0.7 + 0.3 * (e.energy || 1));
    const wr = (fundWr + h2Wr) * g * (0.7 + 0.3 * (e.energy || 1));
    const biasL = e.side < 0 ? 1.08 : 0.92;
    const biasR = e.side > 0 ? 1.08 : 0.92;
    out.elL += el * biasL;
    out.elR += el * biasR;
    out.wrL += wr * biasL;
    out.wrR += wr * biasR;
  }
  const cap = 1.25;
  out.elL = clamp(out.elL, -cap, cap);
  out.elR = clamp(out.elR, -cap, cap);
  out.wrL = clamp(out.wrL, -cap, cap);
  out.wrR = clamp(out.wrR, -cap, cap);
  return out;
}

export function legWaveState({tSec, strikes, times, hush = 1, amount = LEG_COMPLEX} = {}) {
  const knee = {L: 0, R: 0};
  const hip = {L: 0, R: 0};
  const g = (+amount || 0) * clamp(+hush || 0, 0, 1);
  if (!(g > 0.001)) return {knee, hip};
  const leg = (times || pulseTravelTimes()).leg;
  const k = 2.15;
  for (const s of strikes || []) {
    const age = tSec - s.t0;
    if (age > leg + 0.35 || age < -0.02) continue;
    const uu = clamp(age / Math.max(0.08, leg), 0, 1.2);
    const env = Math.exp(-Math.max(0, age) * 2.1) * (uu <= 1 ? 1 : Math.max(0, 1 - (uu - 1) / 0.2));
    const ph = 2 * Math.PI * (k * uu - 1.15 * age / Math.max(0.08, leg));
    const wave = Math.sin(ph) + 0.45 * Math.sin(2 * ph + 0.4) + 0.22 * Math.sin(3 * ph + 0.8);
    const atKnee = env * wave * (0.45 + 0.55 * Math.sin(Math.PI * clamp(uu / 0.62, 0, 1)));
    const atHip = env * wave * (0.35 + 0.65 * Math.sin(Math.PI * clamp((uu - 0.35) / 0.65, 0, 1)));
    const key = s.side < 0 ? 'L' : 'R';
    knee[key] += atKnee;
    hip[key] += atHip;
  }
  const capK = 0.016 * g;
  const capH = 0.010 * g;
  knee.L = clamp(knee.L * 0.012 * g, -capK, capK);
  knee.R = clamp(knee.R * 0.012 * g, -capK, capK);
  hip.L = clamp(hip.L * 0.008 * g, -capH, capH);
  hip.R = clamp(hip.R * 0.008 * g, -capH, capH);
  return {knee, hip};
}

export function jiggleState({tSec, strikes, side = -1, frac = 0, periodSec = 0.5, hush = 1, amount = JIGGLE, still = false} = {}) {
  const z = {gluteL: 0, gluteR: 0, thighL: 0, thighR: 0};
  const g = (+amount || 0) * clamp(+hush || 0, 0, 1);
  if (!(g > 0.001) || still) return z;
  const omegaG = 2 * Math.PI * 4.6;
  const omegaT = 2 * Math.PI * 5.4;
  const zeta = 0.62;
  const impulse = (age, omega) => {
    if (age < 0 || age > 1.15) return 0;
    const wd = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
    return Math.exp(-zeta * omega * age) * Math.sin(wd * age);
  };
  for (const s of strikes || []) {
    const age = tSec - s.t0;
    const land = impulse(age, omegaG);
    const thighPlant = impulse(age, omegaT);
    const thighFree = impulse(age - 0.06, omegaT * 0.92);
    if (s.side < 0) {
      z.gluteL += land;
      z.thighL += thighPlant * 0.75;
      z.thighR += thighFree * 0.55;
      z.gluteR += land * 0.22;
    } else {
      z.gluteR += land;
      z.thighR += thighPlant * 0.75;
      z.thighL += thighFree * 0.55;
      z.gluteL += land * 0.22;
    }
  }
  const tStep = Math.max(0.2, +periodSec || 0.5);
  const ageXfer = (clamp(+frac || 0, 0, 1) - 0.72) * tStep;
  const xfer = impulse(ageXfer, omegaG * 0.9) * 0.55;
  if (side > 0) { z.gluteL += xfer; z.thighL += xfer * 0.4; }
  else { z.gluteR += xfer; z.thighR += xfer * 0.4; }
  const capG = 0.014 * g;
  const capT = 0.011 * g;
  z.gluteL = clamp(z.gluteL * 0.026 * g, -capG * 0.4, capG);
  z.gluteR = clamp(z.gluteR * 0.026 * g, -capG * 0.4, capG);
  z.thighL = clamp(z.thighL * 0.022 * g, -capT * 0.4, capT);
  z.thighR = clamp(z.thighR * 0.022 * g, -capT * 0.4, capT);
  return z;
}

export function hipFigureEight({tSec, stepHz, phase = 0, hush = 1, still = false, amount = HIP_EIGHT, depth = EIGHT_DEPTH, vert = EIGHT_VERT, activation = 1, strikes = null, pulseAmp = 0, pulseHz = 0.9, times = null, side = 0, footwork = null, stomp = 0, dbl = 0, accent = 0, rate = 1} = {}) {
  const h = Math.max(0, Math.min(1, +hush || 0));
  // Default activation is 1 when omitted so legacy callers keep the old amplitude.
  const act = activation == null || !Number.isFinite(+activation) ? 1 : Math.max(0, Math.min(1, +activation));
  const u = act * act * (3 - 2 * act);
  const g = (+amount || 0) * h * u;
  if (!(g > 0.001) || still || !(+tSec >= 0)) return {x: 0, y: 0, z: 0, twist: 0};
  const hz = Math.max(0.2, +stepHz || 1);
  const rateU = Math.max(0.25, Math.min(1, +rate || 1));
  const th8 = 2 * Math.PI * (tSec * hz * 0.5 * rateU + (+phase || 0) * 0.5);
  const gd = g * (Number.isFinite(+depth) ? +depth : EIGHT_DEPTH);
  const gv = g * (Number.isFinite(+vert) ? +vert : EIGHT_VERT);
  // Hip sway / tilt follows leg pulses arriving at the pelvis and the feet
  // (steps, stomps, heel-toe, weight shift). A quiet Lissajous remains as
  // a bed so the path does not freeze between strikes (TJ Nov 10 6:04 PM).
  const hasPulse = Array.isArray(strikes) && strikes.length > 0;
  // Energy (energy-motion.js): dbl blends a double-time harmonic into the
  // loop (faster hips, same beat phase); accent is the bass-groove kick.
  const d8 = Math.max(0, Math.min(1, +dbl || 0)), k8 = 1 - 0.35 * d8;
  const sin8 = k8 * Math.sin(th8) + d8 * Math.sin(2 * th8);
  const sc8 = k8 * Math.sin(th8) * Math.cos(th8) + d8 * 0.5 * Math.sin(4 * th8);
  const acc = Math.max(-1.2, Math.min(1.2, +accent || 0));
  let sx = sin8 + acc, sy = sc8, sz = k8 * Math.sin(th8 + Math.PI / 4) * Math.cos(th8 + Math.PI / 4) + d8 * 0.5 * Math.sin(2 * th8 + Math.PI / 2), stw = sin8 + 0.6 * acc;
  if (hasPulse) {
    const pelvis = stringAnchorAt(S_ROOT, tSec, strikes, pulseAmp, pulseHz, times);
    const drive = hipFootPulseDrive({tSec, strikes, times, planted: side < 0 ? -1 : 1, still: false, fw: footwork, stomp});
    const lat = Math.max(-1.6, Math.min(1.6, 0.70 * pelvis + 0.55 * drive.foot + 0.18 * sin8 + 0.45 * d8 * Math.sin(2 * th8) + acc));
    sx = lat;
    sy = Math.max(-1, Math.min(1, 0.65 * drive.foot + 0.35 * sc8));
    sz = Math.max(-1, Math.min(1, 0.55 * pelvis + 0.45 * sz));
    stw = Math.max(-1.4, Math.min(1.4, 0.80 * drive.pelvis + 0.35 * drive.foot + 0.6 * acc));
  }
  return {
    x: 0.014 * g * sx,
    y: 0.009 * gv * sy,
    z: 0.022 * gd * sz,
    twist: 0.016 * g * stw
  };
}

// Shoulder roll / tilt / twist on a fairly big figure-eight, opposite the
// hips (contra-body). Scales with this dancer's own activation; almost none
// in silence or at rest.
export function shoulderFigureEight({tSec, stepHz, phase = 0, hush = 1, still = false, amount = SHOULDER_EIGHT, depth = EIGHT_DEPTH, vert = EIGHT_VERT, activation = 0, strikes = null, pulseAmp = 0, pulseHz = 0.9, times = null, rate = 1} = {}) {
  const h = Math.max(0, Math.min(1, +hush || 0));
  const act = Math.max(0, Math.min(1, +activation || 0));
  const u = act * act * (3 - 2 * act);
  const g = (+amount || 0) * h * u;
  if (!(g > 0.001) || still || !(+tSec >= 0)) return {x: 0, y: 0, z: 0, tilt: 0, twist: 0};
  const hz = Math.max(0.2, +stepHz || 1);
  const rateU = Math.max(0.25, Math.min(1, +rate || 1));
  // Same clock as the hip eight, +π so the residual loop stays contra-body
  // when no string pulse is present.
  const th = 2 * Math.PI * (tSec * hz * 0.5 * rateU + (+phase || 0) * 0.5) + Math.PI;
  const gd = g * (Number.isFinite(+depth) ? +depth : EIGHT_DEPTH);
  const gv = g * (Number.isFinite(+vert) ? +vert : EIGHT_VERT);
  const hasPulse = Array.isArray(strikes) && strikes.length > 0;
  let sx = Math.sin(th), sy = Math.sin(th) * Math.cos(th);
  let sz = Math.sin(th + Math.PI / 4) * Math.cos(th + Math.PI / 4);
  let stil = Math.sin(th), stw = Math.sin(2 * th);
  if (hasPulse) {
    // Upper chakra-string sway / velocity (heart, throat) drives shift, shrug, tilt, twist.
    const heart = stringAnchorAt(S_HEART, tSec, strikes, pulseAmp, pulseHz, times);
    const throat = stringAnchorAt(S_THROAT, tSec, strikes, pulseAmp, pulseHz, times);
    const heartV = stringAnchorVel(S_HEART, tSec, strikes, pulseAmp, pulseHz, times);
    const throatV = stringAnchorVel(S_THROAT, tSec, strikes, pulseAmp, pulseHz, times);
    const chest = chestPulseDrive({tSec, strikes, times});
    const waveX = 0.85 * heart + 0.30 * throat;
    const arrX = 0.90 * chest.heart + 0.30 * chest.throat;
    sx = Math.max(-1.15, Math.min(1.15, pickDrive(waveX, arrX)));
    sy = Math.max(-1, Math.min(1, pickDrive(0.70 * Math.tanh(throatV / 8) + 0.40 * throat, 0.85 * chest.throat)));
    sz = Math.max(-1, Math.min(1, 0.70 * heart + 0.30 * sz));
    stil = Math.max(-1, Math.min(1, pickDrive(throat - heart, chest.throat - chest.heart)));
    stw = Math.max(-1.15, Math.min(1.15, pickDrive(0.80 * heart + 0.25 * Math.tanh(heartV / 8), 0.90 * chest.heart)));
  }
  return {
    x: 0.072 * g * sx, // ~0.38–0.40 heads at full amount
    y: 0.072 * gv * sy, // ~0.15 heads shrug/drop
    z: 0.028 * gd * sz,
    tilt: 0.28 * g * stil,
    twist: 0.020 * g * stw
  };
}


function rand(seed, n) {
  const x = Math.sin((+seed || 0) * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function ornamentsFor(id, gridIdx, periodSec) {
  const T = Math.max(0.05, +periodSec || 0.5);
  if (T < 0.30 && (gridIdx % 2 !== 0)) return [];
  const slot = ((gridIdx % 4) + 4) % 4;
  const busy = rand(id, 21 + gridIdx) > 0.18;
  if (!busy && slot === 1) return [];
  if (T < 0.30) return [{f: 0.30, contact: 'toe', kind: 'toeTap'}];
  if (slot === 0) return [
    {f: 0.24, contact: 'toe', kind: 'toeTap'},
    {f: 0.36, contact: 'heel', kind: 'heelDrop'}
  ];
  if (slot === 1) return [{f: 0.32, contact: 'toe', kind: 'toeTap'}];
  if (slot === 2) return [
    {f: 0.22, contact: 'toe', kind: 'rock'},
    {f: 0.36, contact: 'heel', kind: 'heelDrop'}
  ];
  return [{f: 0.28, contact: 'toe', kind: 'ballChange', other: true}];
}

// raw: [{t0, kind?, contact?, other?, plannedTransfer?}]. thresh in seconds.
export function classifyBeats(raw, thresh, opts = {}) {
  const gridTransfers = opts.gridTransfers !== false;
  const out = [];
  let planted = null;
  let lastT = null;
  for (const b of raw || []) {
    const ibi = lastT == null ? Infinity : b.t0 - lastT;
    const forceTransfer = gridTransfers && b.plannedTransfer;
    const transfer = forceTransfer || ibi >= thresh;
    let side, kind, contact;
    if (transfer) {
      if (planted == null) planted = (b.grid == null ? 0 : b.grid) % 2 === 0 ? -1 : 1;
      else planted = -planted;
      if (b.side === -1 || b.side === 1) planted = b.side;
      side = planted;
      kind = 'transfer';
      contact = b.contact || 'heel';
    } else {
      if (planted == null) planted = b.side === 1 ? 1 : -1;
      side = b.other ? -planted : planted;
      kind = (b.kind && b.kind !== 'transfer') ? b.kind : (b.contact === 'heel' ? 'heelDrop' : 'toeTap');
      contact = b.contact || 'toe';
    }
    out.push({
      t0: b.t0,
      grid: b.grid,
      kind,
      contact,
      side,
      planted,
      ibi,
      transfer,
      other: !!b.other && !transfer,
      strength: contact === 'heel' || kind === 'transfer' ? 1 : (kind === 'ballChange' ? 0.55 : 0.72)
    });
    lastT = b.t0;
  }
  return out;
}

export function posedFoot(layout, contact, rock, liftAll) {
  const floorY = 0.99;
  const ang = clamp(rock, 0, 1) * ROCK_MAX;
  const lift = Math.max(0, liftAll || 0);
  const heelX = layout.heelX, toeX = layout.toeX;
  const heelZ = Number.isFinite(+layout.heelZ) ? +layout.heelZ : 0;
  const toeZ = Number.isFinite(+layout.toeZ) ? +layout.toeZ : 0;
  let heel, toe;
  if (lift > 0.001) {
    const midY = floorY - lift;
    const airAng = Math.min(ang + deg(8), deg(26));
    heel = {x: heelX, y: midY - Math.sin(airAng) * FOOT_HEEL, z: heelZ};
    toe = {x: toeX, y: midY + Math.sin(airAng) * 0.12 * FOOT_TOE, z: toeZ};
  } else if (contact === 'heel') {
    heel = {x: heelX, y: floorY, z: heelZ};
    toe = {x: toeX, y: floorY - Math.sin(ang) * FOOT_LEN, z: toeZ};
  } else if (contact === 'toe') {
    toe = {x: toeX, y: floorY, z: toeZ};
    heel = {x: heelX, y: floorY - Math.sin(ang) * FOOT_LEN, z: heelZ};
  } else {
    heel = {x: heelX, y: floorY, z: heelZ};
    toe = {x: toeX, y: floorY, z: toeZ};
  }
  const midX = (heel.x + toe.x) * 0.5;
  const midY = (heel.y + toe.y) * 0.5;
  const midZ = ((heel.z || 0) + (toe.z || 0)) * 0.5;
  // Ankle sits above the mid-foot. (The old xy-normal was unstable once the
  // foot pointed along +z, because heel–toe had almost no screen-x span.)
  const ankle = {x: midX, y: midY - FOOT_ANK_H, z: midZ};
  return {heel, toe, ankle, contact, rock, lift};
}

export function footLayout(side, midX, toeOut = FOOT_TOE_OUT) {
  const out = side < 0 ? -1 : 1;
  const yaw = out * (Number.isFinite(+toeOut) ? +toeOut : FOOT_TOE_OUT);
  // Local foot: heel back (−z), toe toward the audience (+z), then a small toe-out.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Center the foot on the mid-point (ankle above it at z=0) so a forward
  // foot does not plant the ankle in front of the hip and buckle the knee.
  const heelZ = -FOOT_LEN / 2, toeZ = FOOT_LEN / 2;
  // Same convention as rotateFacing(x, z, yaw): {x: x*c + z*s, z: -x*s + z*c}.
  const heel = {x: heelZ * s, z: heelZ * c};
  const toe = {x: toeZ * s, z: toeZ * c};
  return {
    midX,
    midZ: 0,
    heelX: midX + heel.x, heelZ: heel.z,
    toeX: midX + toe.x, toeZ: toe.z,
    out, yaw
  };
}

export function footworkState({
  tSec, periodSec, side = -1, ease = 0, freeLift = 0, jump = 0,
  strikes, id = 0, beat = 0, hush = 1, still = false, activation = 1
} = {}) {
  const flat = {
    still: true,
    contactL: 'flat', contactR: 'flat',
    rockL: 0, rockR: 0,
    liftL: 0, liftR: 0,
    artKind: null, artEnv: 0, artSide: side,
    lastContact: 'flat',
    planted: side < 0 ? -1 : 1
  };
  const h = clamp(+hush || 0, 0, 1);
  if (h <= 0 || still) return flat;
  const stompU = clamp(stompIntensity(activation, h) / Math.max(1e-6, STOMP_PEAK), 0, 1);
  // Rest: softer, slower heel-toe envelopes (no snappy impact).
  const atk = 0.04 + 0.08 * (1 - stompU);
  const dec = 0.10 + 0.10 * (1 - stompU);
  const rockS = 0.20 + 0.80 * stompU;

  const T = Math.max(0.05, +periodSec || 0.5);
  const thresh = sameFootThreshSec(T);
  const planted = side < 0 ? -1 : 1;
  const raw = [];
  const list = Array.isArray(strikes) ? strikes : [];
  for (const s of list) {
    raw.push({
      t0: s.t0,
      grid: Number.isFinite(+s.beat) ? s.beat : beat,
      kind: s.kind || 'transfer',
      contact: s.contact || 'heel',
      other: !!s.other,
      plannedTransfer: s.transfer !== false && !s.ornament,
      side: s.side
    });
  }
  if (!raw.length) {
    raw.push({t0: tSec - clamp(+ease || 0, 0, 1) * T, grid: beat, kind: 'transfer', contact: 'heel', plannedTransfer: true, side: planted});
  }
  const lastGrid = raw.length ? (raw[raw.length - 1].grid | 0) : (beat | 0);
  const lastT0 = raw.length ? raw[raw.length - 1].t0 : tSec;
  for (const o of ornamentsFor(id, lastGrid, T)) {
    const t0 = lastT0 + o.f * T;
    if (t0 > tSec + 0.02) continue;
    raw.push({t0, grid: lastGrid, kind: o.kind, contact: o.contact, other: !!o.other, plannedTransfer: false});
  }
  raw.sort((a, b) => a.t0 - b.t0);
  const evs = classifyBeats(raw, thresh, {gridTransfers: true});
  const past = evs.filter(b => b.t0 <= tSec + 1e-6);
  const last = past.length ? past[past.length - 1] : null;
  let art = last && !last.transfer ? last : null;
  if (art && (tSec - art.t0) > 0.32) art = null;
  const artAge = art ? tSec - art.t0 : (last ? tSec - last.t0 : 1);
  const artEnv = art ? (artAge < atk ? artAge / atk : Math.exp(-Math.max(0, artAge - atk) / dec)) : 0;
  const lastContact = last ? last.contact : 'heel';
  const struckAgo = last ? tSec - last.t0 : (+ease || 0) * T;
  const artKind = art ? art.kind : (last && last.transfer ? 'transfer' : null);
  const artSide = art ? art.side : planted;

  const artic = (which, liftFree) => {
    if (jump > 0) return {contact: 'toe', rock: 0.35 * h, lift: liftFree};
    const isPlanted = which === planted;
    if (!isPlanted) {
      if (artKind === 'ballChange' && artSide === which) {
        return {contact: 'toe', rock: 0.50 * artEnv * h * rockS, lift: 0.006 * (1 - artEnv) * h * rockS};
      }
      return {contact: 'toe', rock: 0.22 * h * rockS, lift: liftFree};
    }
    if (artKind && artSide === which && artEnv > 0.02) {
      if (art && art.contact === 'toe') return {contact: 'toe', rock: 0.78 * artEnv * h * rockS, lift: 0};
      if (art && art.contact === 'heel') return {contact: 'heel', rock: 0.72 * artEnv * h * rockS, lift: 0};
    }
    if (lastContact === 'heel' && artKind === 'transfer' && struckAgo < 0.22) {
      const rec = Math.exp(-struckAgo / 0.11);
      return {contact: rec > 0.35 ? 'heel' : 'flat', rock: 0.55 * rec * h * rockS, lift: 0};
    }
    return {contact: 'flat', rock: 0, lift: 0};
  };
  const leftLanding = planted < 0;
  const aL = artic(-1, leftLanding ? 0 : freeLift);
  const aR = artic(1, leftLanding ? freeLift : 0);
  return {
    still: false,
    contactL: aL.contact, contactR: aR.contact,
    rockL: aL.rock, rockR: aR.rock,
    liftL: aL.lift, liftR: aR.lift,
    artKind, artEnv, artSide, lastContact,
    planted
  };
}

export const HIP_TWIST = 0.80;
export const SHOULDER_TWIST = 0.75;
export const MAX_BODY_TURN_DEG = 90;
export const TURN_FREQ = 0.70;
// Narrowest stance is 0.85–1.0 × shoulder width (full foot span / full shoulder
// span). stanceW and shW are half-widths, so the ratio is stanceW / shW.
export const STANCE_SH_MIN = 0.85;
export const STANCE_SH_CALM = 0.90;
// Resting (silence / calm) stance is hip-width, narrower than the dance floor.
// Active dancing still uses STANCE_SH_MIN (0.85–1.0 shoulder widths).
export const STANCE_HIP_REST = 1.00;
export const VOLUME_LOD_PX = 100; // cheap LOD only for small seed/inset sims

// 1 = fully at rest (silence, still, or calm), 0 = dancing.
// Omitted activation is not treated as calm (legacy poses stay in the dance stance).
export function restBlend({activation, hush = 1, still = false} = {}) {
  if (still || !(+hush > 0.05)) return 1;
  const h = clamp(+hush, 0, 1);
  // Follow the hush ease so the rest pose is reached during the 500 ms fade
  // and is already settled when the stillness hold begins.
  const fromHush = 1 - h;
  if (activation == null || !Number.isFinite(+activation)) return fromHush;
  const act = clamp(+activation, 0, 1);
  // Fully dancing by ~0.18 so mid/high activation (hush=1) is unchanged.
  const u = clamp(act / 0.18, 0, 1);
  const fromAct = 1 - (u * u * (3 - 2 * u));
  return Math.max(fromAct, fromHush);
}

// Analytic spring step. ζ=1 critical; ζ<1 underdamped (follow-through / overshoot).
// Optional constant accel (gravity) shifts the equilibrium by accel/ω².
export function stepSpring(x, v, u, dt, omega, zeta, accel = 0) {
  const w = Math.max(1e-4, omega);
  const z = Math.max(0.05, zeta);
  const dtC = Math.max(0, Math.min(0.05, dt));
  const uEff = u + (accel ? accel / (w * w) : 0);
  const y0 = x - uEff;
  if (dtC <= 1e-6) return {x, v};
  if (Math.abs(z - 1) < 1e-3) {
    const A = y0, B = v + w * y0, e = Math.exp(-w * dtC);
    const y = (A + B * dtC) * e;
    return {x: y + uEff, v: (B - w * (A + B * dtC)) * e};
  }
  if (z < 1) {
    const wd = w * Math.sqrt(Math.max(1e-8, 1 - z * z));
    const A = y0, B = (v + z * w * y0) / wd;
    const e = Math.exp(-z * w * dtC);
    const c = Math.cos(wd * dtC), s = Math.sin(wd * dtC);
    const y = e * (A * c + B * s);
    const nv = -z * w * y + e * (-A * wd * s + B * wd * c);
    return {x: y + uEff, v: nv};
  }
  const sd = w * Math.sqrt(z * z - 1);
  const r1 = -z * w + sd, r2 = -z * w - sd;
  const den = r1 - r2 || 1e-8;
  const C1 = (v - r2 * y0) / den, C2 = y0 - C1;
  const e1 = Math.exp(r1 * dtC), e2 = Math.exp(r2 * dtC);
  const y = C1 * e1 + C2 * e2;
  return {x: y + uEff, v: C1 * r1 * e1 + C2 * r2 * e2};
}

const travelMap = new Map();
// Last facing / walked depth of a dancer (rave phrase decisions read these).
export function travelFacingOf(id) { const st = travelMap.get(id | 0); return st && Number.isFinite(st.facing) ? st.facing : 0; }
export function travelWorldZOf(id) { const st = travelMap.get(id | 0); return st && Number.isFinite(st.worldZ) ? (st.worldZ || 0) + (st.stepZ || 0) : 0; }
export function resetTravel(id) {
  if (id == null) travelMap.clear();
  else travelMap.delete(id | 0);
}

// Incremental body facing + depth step. Persistent state, cheap per frame
// (no lookback). Turn size/frequency scale with activation; facing drifts home.
export const RAVE_TURN_EASE = 0.30; // s, rave 90° turn target ease
export function bodyTravelState({
  id = 0, tSec = 0, side = -1, still = false, activation = 0, hush = 1,
  stepHz = 2, hipTwist = HIP_TWIST, shoulderTwist = SHOULDER_TWIST,
  maxTurnDeg = MAX_BODY_TURN_DEG, turnFreq = TURN_FREQ, phase = 0,
  strikes = null, pulseAmp = 0, pulseHz = 0.9, times = null, footwork = null, stomp = 0, rave = null
} = {}) {
  const key = id | 0;
  let st = travelMap.get(key);
  const t = +tSec || 0;
  if (!st || !Number.isFinite(st.t) || Math.abs(t - st.t) > 0.55 || !Number.isFinite(st.facing + st.vf + st.target + st.stepZ + st.vz + (st.hipYaw || 0) + (st.vHip || 0) + (st.shYaw || 0) + (st.vSh || 0) + (st.worldZ || 0))) {
    st = {t, facing: 0, vf: 0, target: 0, plant: side < 0 ? -1 : 1, stepZ: 0, vz: 0, worldZ: 0};
  }
  const dt = Math.max(0, Math.min(0.05, t - st.t));
  st.t = t;
  const hushU = Math.max(0, Math.min(1, +hush || 0));
  const act = Math.max(0, Math.min(1, +activation || 0));
  const wantStill = still || hushU < 0.5;
  // Stillness springs facing and twist home around the planted ball; do not
  // snap, and do not start a new turn or depth step while quiet.
  if (wantStill) st.target = 0;
  const sm = act * act * (3 - 2 * act);
  const maxTurn = (Math.max(0, Math.min(90, +maxTurnDeg || 0)) * Math.PI) / 180;
  const freq = Math.max(0, +turnFreq || 0);
  const planted = side < 0 ? -1 : 1;
  // Rave repertoire (side-sim parity, PR #97): the phrase decides 90° turns
  // as punctuation on the "1" and forward/back steps; feet still lead (the
  // new facing springs in after the plant). Turn frequency 0 or max turn 0
  // still disables turns.
  const ravePlan = rave && typeof rave === 'object' ? rave : null;
  if (ravePlan && planted !== st.plant && !wantStill && hushU > 0) {
    const tr = +ravePlan.turnRad || 0;
    if (Math.abs(tr) > 0.2 && maxTurn > 1e-4 && freq > 0) {
      st.target = Math.max(-maxTurn, Math.min(maxTurn, st.target + Math.sign(tr) * Math.min(Math.abs(tr), maxTurn)));
    }
    st.worldZ = (st.worldZ || 0) + (st.stepZ || 0);
    st.stepZ = ((+ravePlan.stepF || 0) - 0.55 * (st.worldZ || 0)) * hushU;
    st.plant = planted;
    st.bodyStep = true;
  }
  if (!ravePlan && planted !== st.plant && !wantStill && hushU > 0 && maxTurn > 1e-4) {
    const seed = key * 13.1 + t * 2.37 + (phase || 0);
    const p = (0.05 + 0.40 * sm) * freq;
    if (hash01(seed) < p) {
      const sizeU = 0.16 + 0.84 * sm * sm;
      const mag = (0.20 + 0.80 * hash01(seed + 4.2)) * sizeU * maxTurn;
      const dir = hash01(seed + 8.7) < 0.5 ? -1 : 1;
      st.target = Math.max(-maxTurn, Math.min(maxTurn, st.target + dir * mag));
    }
    st.worldZ = (st.worldZ || 0) + (st.stepZ || 0);
    const raw = (0.018 + 0.070 * sm) * (2 * hash01(seed + 2.1) - 1) * hushU;
    // Bias the swing landing back toward home so wander is walked, not slid.
    st.stepZ = raw - 0.55 * (st.worldZ || 0);
    st.plant = planted;
    st.bodyStep = false;
  }
  // Drift facing back to front; faster in silence / stillness.
  // A rave 90° turn is punctuation: once the energy drops below the turn
  // gate, or the song closes, the body comes back to the front at the
  // stillness rate, so a rest / silence stance never reads as a profile.
  if (ravePlan && ravePlan.open === false) st.target = 0;
  const tau = wantStill || hushU < 0.05 || (ravePlan && (act < 0.42 || ravePlan.open === false)) ? 0.85 : 2.55;
  st.target *= Math.exp(-dt / tau);
  st.target = Math.max(-maxTurn, Math.min(maxTurn, st.target));
  // Heavy torso: slow critically-damped facing.
  // Rave turns land as a 90° target on the "1"; ease that target in so the
  // legs re-solve smoothly (no head jerk from a sudden pivot).
  if (ravePlan) {
    const tgt = wantStill ? 0 : st.target;
    st.tgtS = Number.isFinite(st.tgtS) ? st.tgtS + (tgt - st.tgtS) * (1 - Math.exp(-dt / RAVE_TURN_EASE)) : tgt;
  } else st.tgtS = st.facing;
  const face = stepSpring(st.facing, st.vf, wantStill ? 0 : (ravePlan ? st.tgtS : st.target), dt, 6.2, 1.0);
  st.facing = face.x;
  st.vf = face.v;
  // Local contra-body twist (hips vs shoulders), activation-scaled.
  // Hips follow leg pulses arriving at the pelvis and the feet; shoulders
  // follow the chakra string at the heart/throat, independently (TJ Nov 10 6:04 PM).
  const env = wantStill ? 0 : sm * hushU;
  const th8 = 2 * Math.PI * (t * Math.max(0.05, +stepHz || 2) * 0.5 + (phase || 0) * 0.5);
  const fig8 = Math.sin(th8);
  const hipLim = HIP_YAW_LIM;
  const shRelLim = SH_REL_LIM;
  const hasPulse = Array.isArray(strikes) && strikes.length > 0;
  const footDrive = hipFootPulseDrive({tSec: t, strikes, times, planted, still: wantStill, fw: footwork, stomp});
  const pelvisWave = hasPulse ? stringAnchorAt(S_ROOT, t, strikes, pulseAmp, pulseHz, times) : 0;
  const hipRaw = hasPulse
    ? (0.55 * footDrive.pelvis + 0.50 * pelvisWave + 0.70 * footDrive.foot + 0.18 * fig8)
    : (-(planted) * 0.35 * (still ? 0 : 1) + fig8 * 0.46);
  const hipTarget = Math.max(-hipLim, Math.min(hipLim, hipRaw * (hipTwist || 0) * env * hipLim * 2.25));
  let shRaw;
  if (hasPulse) {
    const heart = stringAnchorAt(S_HEART, t, strikes, pulseAmp, pulseHz, times);
    const throat = stringAnchorAt(S_THROAT, t, strikes, pulseAmp, pulseHz, times);
    const heartV = stringAnchorVel(S_HEART, t, strikes, pulseAmp, pulseHz, times);
    const chest = chestPulseDrive({tSec: t, strikes, times});
    const wave = 0.72 * heart + 0.38 * throat + 0.10 * Math.tanh(heartV / 8);
    const arrival = 1.00 * chest.heart + 0.30 * chest.throat;
    shRaw = pickDrive(wave, arrival);
  } else {
    shRaw = 0.62 * fig8 - 0.38 * planted;
  }
  const shRelTarget = Math.max(-shRelLim, Math.min(shRelLim,
    shRaw * env * (0.75 + 0.35 * (shoulderTwist || 0)) * shRelLim * 1.45));
  const shTargetAbs = st.hipYaw == null ? shRelTarget : (st.hipYaw || 0) + shRelTarget;
  if (st.hipYaw == null) { st.hipYaw = 0; st.vHip = 0; st.shYaw = 0; st.vSh = 0; }
  const hip = stepSpring(st.hipYaw, st.vHip, hipTarget, dt, 18.0, 1.0);
  st.hipYaw = Math.max(-hipLim, Math.min(hipLim, hip.x));
  st.vHip = hip.v;
  const shRelT = Math.max(-shRelLim, Math.min(shRelLim, shTargetAbs - st.hipYaw));
  const sh = stepSpring(st.shYaw, st.vSh, st.hipYaw + shRelT, dt, 20.0, 1.0);
  const shRel = Math.max(-shRelLim, Math.min(shRelLim, sh.x - st.hipYaw));
  st.shYaw = st.hipYaw + shRel;
  st.vSh = sh.v;
  if (travelMap.size > 256) travelMap.clear();
  travelMap.set(key, st);
  return {
    facing: st.facing * hushU,
    hipYaw: st.hipYaw * hushU,
    shYaw: st.shYaw * hushU,
    shRel: shRel * hushU,
    // Rave forward / back steps go along the body's facing (a turned dancer
    // steps toward where it faces, not diagonally across its own stance).
    stepZ: (st.bodyStep ? Math.cos(st.facing) : 1) * (st.stepZ || 0) * hushU,
    stepX: (st.bodyStep ? Math.sin(st.facing) : 0) * (st.stepZ || 0) * hushU,
    env
  };
}

const dynMap = new Map();
export function resetBodyDynamics(id) {
  if (id == null) dynMap.clear();
  else dynMap.delete(id | 0);
}

const JOINT_DYN = {
  // Torso chain shares one critically-damped rate so spine segments cannot
  // jitter against each other (head used to be underdamped at z=0.85).
  groin: {w: 8.0, z: 1.00}, pelvis: {w: 8.0, z: 1.00},
  hipL: {w: 8.0, z: 1.00}, hipR: {w: 8.0, z: 1.00},
  lumbar: {w: 8.0, z: 1.00}, thoracic: {w: 8.0, z: 1.00}, solar: {w: 8.0, z: 1.00},
  heart: {w: 8.0, z: 1.00}, neck: {w: 8.0, z: 1.00},
  shL: {w: 9.0, z: 1.00}, shR: {w: 9.0, z: 1.00},
  crown: {w: 8.0, z: 1.00}, head: {w: 8.0, z: 1.00},
  kneeL: {w: 13.0, z: 0.82}, kneeR: {w: 13.0, z: 0.82},
  elL: {w: 11.0, z: 0.90}, elR: {w: 11.0, z: 0.90},
  ankleL: {w: 14.0, z: 0.85}, ankleR: {w: 14.0, z: 0.85},
  wristL: {w: 12.0, z: 0.90}, wristR: {w: 12.0, z: 0.90},
  handL: {w: 12.0, z: 0.90}, handR: {w: 12.0, z: 0.90},
  footL: {w: 14.0, z: 0.85}, footR: {w: 14.0, z: 0.85},
  heelL: {w: 14.0, z: 0.85}, heelR: {w: 14.0, z: 0.85}
};
const DYN_KEYS = Object.keys(JOINT_DYN);
const G_UNIT = 1.6; // downward ( +y ) acceleration on lifted limbs, unit-pose / s²

// Critically/under-damped tracking of joint targets. Planted feet are pinned
// (no slide). dt is clamped so a hitch cannot explode the integrator.
export function smoothPoseJoints(id, unit, {
  tSec = 0, still = false, hush = 1, side = -1, groove = 0,
  liftL = 0, liftR = 0, contactL = 'flat', contactR = 'flat', enabled = true,
  bpm = 0, omegaScale = 0, followBalls = false
} = {}) {
  if (!unit || enabled === false) return unit;
  const key = id | 0;
  const t = +tSec || 0;
  // Rest/silence eases into the rest pose through the springs. Planted
  // contacts stay pinned (zero ground velocity) even at rest; a narrower
  // rest stance is reached only by a collection swing, never a slide.
  let st = dynMap.get(key);
  // Silence hold (hush==0) is applied below after we have a prior spring
  // state, so the pose stays put instead of snapping to a new rest target.
  if (!st || !Number.isFinite(st.t) || Math.abs(t - st.t) > 0.55) {
    st = {t, j: {}};
    for (const k of DYN_KEYS) {
      const p = unit[k];
      if (p && Number.isFinite(+p.x)) st.j[k] = {x: +p.x, y: +p.y, z: +p.z || 0, vx: 0, vy: 0, vz: 0};
    }
    if (dynMap.size > 256) dynMap.clear();
    dynMap.set(key, st);
    return unit;
  }
  const dt = Math.max(0, Math.min(0.05, t - st.t));
  // Same timestamp (tests, or a second call in one frame): leave the new
  // target in place so we do not freeze the previous pose over a new one.
  if (dt <= 1e-6) return unit;
  st.t = t;
  if (!(+hush > 0)) {
    // Silence hold: keep the last settled joints; do not chase a new target.
    // With the idle groove on, only the feet hold (planted, no slide) and
    // the body follows the small groove target directly.
    const grooving = +groove > 0;
    for (const k of DYN_KEYS) {
      const p = unit[k];
      const rec = st.j[k];
      if (!p || !rec || !Number.isFinite(+rec.x)) continue;
      if (grooving && !/^(foot|heel|ankle)/.test(k)) {
        // Ease into the groove target (no snap when the hush lands at 0).
        const kk = 1 - Math.exp(-dt / 0.15);
        rec.x += (+p.x - rec.x) * kk; rec.y += (+p.y - rec.y) * kk; rec.z += ((+p.z || 0) - rec.z) * kk;
        p.x = rec.x; p.y = rec.y; p.z = rec.z; rec.vx = 0; rec.vy = 0; rec.vz = 0; continue;
      }
      p.x = rec.x; p.y = rec.y; p.z = rec.z;
      rec.vx = 0; rec.vy = 0; rec.vz = 0;
    }
    if (dynMap.size > 256) dynMap.clear();
    dynMap.set(key, st);
    return unit;
  }
  // Tempo-scaled settle: 150–400 ms (ω = 4/τ). Relative joint rates stay the same.
  const tau = (() => {
    const beat = 60 / Math.max(40, +bpm || 112);
    return Math.max(0.15, Math.min(0.40, 0.55 * beat));
  })();
  // Never faster than the designed rates (fast songs already have a shorter
  // target ease); slower songs scale ω down so settle stays in the window.
  const wScale = Math.min(1, (+omegaScale > 0 ? +omegaScale : (4 / tau)) / 12);
  const plantL = !(+liftL > 0.001);
  const plantR = !(+liftR > 0.001);
  const pin = {
    footL: plantL, heelL: plantL, ankleL: plantL && (contactL === 'flat' || contactL === 'heel' || contactL === 'toe'),
    footR: plantR, heelR: plantR, ankleR: plantR && (contactR === 'flat' || contactR === 'heel' || contactR === 'toe')
  };
  for (const k of DYN_KEYS) {
    const p = unit[k];
    if (!p || !Number.isFinite(+p.x)) continue;
    if (pin[k]) {
      let rec = st.j[k];
      // The planted BALL (footL/footR) is the world anchor: freeze its xz so
      // springs cannot skate the contact. The heel and ankle of a planted
      // foot must still be allowed to orbit that ball so the body can yaw
      // (a pivot, not a slide).
      // Footwork plans re-centre their layout in the pose frame every frame
      // (the world pin holds the real contact), so a planted ball follows
      // its target there instead of freezing at a stale pose-frame spot.
      const isBall = !followBalls && (k === 'footL' || k === 'footR');
      if (!rec || rec.swinging) {
        rec = st.j[k] = {x: +p.x, y: +p.y, z: +p.z || 0, vx: 0, vy: 0, vz: 0, swinging: false};
      } else if (isBall) {
        rec.y = +p.y;
        rec.vx = 0; rec.vy = 0; rec.vz = 0;
        rec.swinging = false;
      } else {
        rec.x = +p.x; rec.y = +p.y; rec.z = +p.z || 0;
        rec.vx = 0; rec.vy = 0; rec.vz = 0;
        rec.swinging = false;
      }
      p.x = rec.x; p.y = rec.y; p.z = rec.z;
      continue;
    }
    const spec = JOINT_DYN[k];
    let rec = st.j[k];
    if (!rec) rec = st.j[k] = {x: +p.x, y: +p.y, z: +p.z || 0, vx: 0, vy: 0, vz: 0, swinging: true};
    rec.swinging = true;
    let g = 0;
    if (k === 'handL' || k === 'wristL' || k === 'elL') g = G_UNIT * Math.max(0, 0.55 - Math.min(1, (unit.raise || 0)));
    else if (k === 'handR' || k === 'wristR' || k === 'elR') g = G_UNIT * Math.max(0, 0.55 - Math.min(1, (unit.raise || 0)));
    else if ((k === 'footL' || k === 'heelL' || k === 'ankleL') && +liftL > 0.001) g = G_UNIT;
    else if ((k === 'footR' || k === 'heelR' || k === 'ankleR') && +liftR > 0.001) g = G_UNIT;
    else if (k === 'groin' || k === 'hipL' || k === 'hipR') g = 0.35 * G_UNIT;
    const w = spec.w * wScale;
    const sx = stepSpring(rec.x, rec.vx, +p.x, dt, w, spec.z, 0);
    const sy = stepSpring(rec.y, rec.vy, +p.y, dt, w, spec.z, g);
    const sz = stepSpring(rec.z, rec.vz, +p.z || 0, dt, w, spec.z, 0);
    if (!Number.isFinite(sx.x + sx.v + sy.x + sy.v + sz.x + sz.v)) {
      // TJ 9:08 PM crash hunt: a NaN target or state must not poison this
      // joint for the rest of the show; snap back to the target.
      st.j[k] = {x: +p.x, y: Number.isFinite(+p.y) ? +p.y : 0, z: Number.isFinite(+p.z) ? +p.z : 0, vx: 0, vy: 0, vz: 0};
      continue;
    }
    rec.x = sx.x; rec.vx = sx.v;
    rec.y = sy.x; rec.vy = sy.v;
    rec.z = sz.x; rec.vz = sz.v;
    p.x = rec.x; p.y = rec.y; p.z = rec.z;
  }
  if (dynMap.size > 256) dynMap.clear();
  dynMap.set(key, st);
  return unit;
}

// After a bone-length projection, write the locked joints back into the
// spring state so the next frame does not spring from a stretched pose.
export function commitDynJoints(id, unit) {
  const st = dynMap.get(id | 0);
  if (!st || !st.j || !unit) return;
  for (const k of Object.keys(st.j)) {
    const p = unit[k], rec = st.j[k];
    if (!p || !rec || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
    rec.x = +p.x; rec.y = +p.y; rec.z = +p.z || 0;
  }
}

// Largest joint travel between two unit poses, in body-height units
// (the unit pose is already in body heights: crown~0, feet~1).
const DELTA_KEYS = ['head','neck','shL','shR','elL','elR','wristL','wristR','handL','handR',
  'groin','crown','heart','hipL','hipR','kneeL','kneeR','ankleL','ankleR','footL','footR','heelL','heelR'];
export function maxJointDelta(a, b, keys = DELTA_KEYS) {
  let m = 0, which = null;
  if (!a || !b) return {max: 0, joint: null};
  for (const k of keys) {
    const p = a[k], q = b[k];
    if (!p || !q || !Number.isFinite(+p.x) || !Number.isFinite(+q.x)) continue;
    const d = Math.hypot(+q.x - +p.x, +q.y - +p.y, (+q.z || 0) - (+p.z || 0));
    if (d > m) { m = d; which = k; }
  }
  return {max: m, joint: which};
}

export function measureJerk(series) {
  // series: [{t, pts: {name: {x,y}} }] sampled at ~constant dt
  const names = series[0] && series[0].pts ? Object.keys(series[0].pts) : [];
  let maxAcc = 0, maxJerk = 0, maxVel = 0;
  const prevV = {}, prevA = {};
  for (let i = 1; i < series.length; i++) {
    const dt = Math.max(1e-4, series[i].t - series[i - 1].t);
    for (const n of names) {
      const a = series[i - 1].pts[n], b = series[i].pts[n];
      if (!a || !b) continue;
      const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
      const v = Math.hypot(vx, vy);
      if (v > maxVel) maxVel = v;
      if (prevV[n]) {
        const ax = (vx - prevV[n].x) / dt, ay = (vy - prevV[n].y) / dt;
        const acc = Math.hypot(ax, ay);
        if (acc > maxAcc) maxAcc = acc;
        if (prevA[n]) {
          const jx = (ax - prevA[n].x) / dt, jy = (ay - prevA[n].y) / dt;
          const jerk = Math.hypot(jx, jy);
          if (jerk > maxJerk) maxJerk = jerk;
        }
        prevA[n] = {x: ax, y: ay};
      }
      prevV[n] = {x: vx, y: vy};
    }
  }
  return {maxVel, maxAcc, maxJerk, n: series.length};
}
