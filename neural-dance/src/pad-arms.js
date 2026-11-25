// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Melody/Pad arm mapping shared by the live show and the official sim
// (v3: hands lead, elbows stay below the wrists when raised, traveling
// seesaw / sine wave along the arms). Springs are per-dancer so motion
// stays weighted and cannot jerk.

import {stepSpring} from './skeleton-motion.js';
import {clamp, deg} from './geometry.js';

const EMPTY_FEATURES = Object.freeze({
  env: 0, note: 0, contour: 0.35, vibrato: 0, onset: 0,
  subLo: 0, subHi: 0, crescendo: 0
});

const defaultSprings = new Map();

export function resetPadArmSprings(id) {
  if (id == null) defaultSprings.clear();
  else {
    const prefix = String(id) + ':';
    for (const k of [...defaultSprings.keys()]) {
      if (k === String(id) || k.startsWith(prefix) || k.endsWith(':' + id)) defaultSprings.delete(k);
    }
  }
}

function mix(a, c, t) { return a + (c - a) * t; }

function stepPadSpring(st, target, dt, omega, zeta, lo, hi) {
  const next = stepSpring(st.x, st.v, target, dt, omega, zeta);
  st.x = next.x;
  st.v = next.v;
  if (st.x < lo) { st.x = lo; st.v = Math.max(0, st.v); }
  if (st.x > hi) { st.x = hi; st.v = Math.min(0, st.v); }
  return st;
}

export function bandKindName(band) {
  if (band === 'bass' || band === 'mid' || band === 'high') return band;
  const b = ((band | 0) % 4 + 4) % 4;
  return b <= 1 ? 'bass' : b === 2 ? 'mid' : 'high';
}

// 0 → slightly abducted down; 0.55 → out to the sides; 1 → past vertical, crossing.
export function padReachAngle(raise) {
  const r = Math.max(0, Math.min(1, raise));
  if (r < 0.55) {
    const u = r / 0.55;
    const s = u * u * (3 - 2 * u);
    return (10 + (100 - 10) * s) * Math.PI / 180;
  }
  const u = (r - 0.55) / 0.45;
  const s = u * u * (3 - 2 * u);
  return (100 + ((180 + 18) - 100) * s) * Math.PI / 180;
}

export function padArmState({
  id = 0, band = 0, tSec = 0, features = null, sense = 1, act = 0, springs = defaultSprings
} = {}) {
  const kind = bandKindName(band);
  const f = features && typeof features === 'object' ? features : EMPTY_FEATURES;
  const env = Math.max(0, Math.min(1, (+f.env || 0)));
  const note = Math.max(0, Math.min(1, (+f.note || 0)));
  let contour = Math.max(0, Math.min(1, f.contour == null ? 0.35 : +f.contour));
  const subLo = Math.max(0, Math.min(1, +f.subLo || 0));
  const subHi = Math.max(0, Math.min(1, +f.subHi || 0));
  if (kind === 'bass') contour = contour * 0.45 + subLo * 0.55;
  else if (kind === 'high') contour = contour * 0.45 + subHi * 0.55;
  const cres = Math.max(0, Math.min(1, +f.crescendo || 0));
  const vib = Math.max(-1, Math.min(1, +f.vibrato || 0));
  const onset = Math.max(0, Math.min(1, +f.onset || 0));
  const senseN = Number.isFinite(+sense) ? +sense : 1;
  const actN = Math.max(0, Math.min(1, +act || 0));
  // Stronger Melody/Pad drive (TJ 2:03 PM PT): a sustained pad visibly raises
  // and sweeps the arms; a rising / high melody climbs further. Still 0 when
  // env and note are quiet (drums / silence).
  let base = senseN * env * (0.48 + 0.55 * contour)
           + senseN * 0.55 * note * (0.45 + 0.70 * contour);
  const pitchHeight = Math.max(0, contour - 0.18);
  base += senseN * Math.max(env, note * 0.85) * pitchHeight * 0.35;
  const over = (env > 0.84 ? (env - 0.84) / 0.14 : 0);
  const overC = contour > 0.42 ? Math.min(1, (contour - 0.42) / 0.28) : 0;
  const overU = Math.max(0, Math.min(1, over)) * overC;
  const overS = overU * overU * (3 - 2 * overU);
  let targetRaise = Math.max(0, Math.min(1, base + (1 - base) * overS));
  if (targetRaise > 0.68 && actN > 0.5 && env > 0.7) targetRaise = Math.max(targetRaise, 0.92 + 0.08 * actN);
  targetRaise = Math.max(0, Math.min(1, targetRaise));
  const targetExt = Math.max(0, Math.min(1, 0.22 * env + 0.20 * cres + 0.16 * note));
  const phase0 = kind === 'bass' ? 0.0 : kind === 'high' ? 2.1 : 1.1;
  const phrase = (subHi - subLo) * 1.05 + 0.48 * Math.sin(tSec * 2 * Math.PI * 0.14 + phase0);
  const targetSweep = Math.max(-1, Math.min(1, phrase * Math.max(env, note * 0.75)));
  const key = (id | 0) + ':' + kind;
  let st = springs.get(key);
  if (!st || tSec < st.t - 1e-4) {
    st = {
      raise: {x: targetRaise, v: 0},
      ext: {x: targetExt, v: 0},
      sweep: {x: targetSweep, v: 0},
      wrist: {x: 0, v: 0},
      cVel: {x: 0, v: 0},
      dir: {x: 0, v: 0},
      sine: {x: 0, v: 0},
      see: {x: 0, v: 0},
      k: {x: Math.PI, v: 0},
      phase: 0,
      _prevC: contour,
      t: tSec
    };
  }
  if (!st.cVel) st.cVel = {x: 0, v: 0};
  if (!st.dir) st.dir = {x: 0, v: 0};
  if (!st.sine) st.sine = {x: 0, v: 0};
  if (!st.see) st.see = {x: 0, v: 0};
  if (!st.k) st.k = {x: Math.PI, v: 0};
  if (st.phase == null) st.phase = 0;
  let dt = tSec - st.t;
  if (dt > 0) {
    const heavy = kind === 'bass';
    const light = kind === 'high';
    // Heavy pads stay a slow flowing lift; melody (high) is a bit quicker,
    // but zeta stays high so the motion cannot snap.
    stepPadSpring(st.raise, targetRaise, dt, heavy ? 3.8 : light ? 5.6 : 4.8, heavy ? 0.95 : 0.90, -0.02, 1.06);
    stepPadSpring(st.ext, targetExt, dt, 4.0, 0.92, -0.02, 1.05);
    stepPadSpring(st.sweep, targetSweep, dt, 3.6, 0.92, -1.15, 1.15);
    const wTarget = Math.max(env, note) * (0.40 * vib + 0.70 * onset);
    if (onset > 0.45 && onset > (st._lastOnset || 0) + 0.20) st.wrist.v += (light ? 2.8 : 2.1) * onset;
    st._lastOnset = onset;
    stepPadSpring(st.wrist, wTarget, dt, 6.2, 0.82, -1.2, 1.2);
    const cVelRaw = (contour - (st._prevC == null ? contour : st._prevC)) / Math.max(dt, 1e-3);
    st._prevC = contour;
    stepPadSpring(st.cVel, Math.max(-1, Math.min(1, cVelRaw * 2.0)), dt, 2.6, 0.90, -1, 1);
    const subBias = subHi - subLo;
    const dirTarget = Math.max(-1, Math.min(1, subBias * 0.75 + st.cVel.x * 0.55));
    stepPadSpring(st.dir, dirTarget, dt, 2.2, 0.92, -1.2, 1.2);
    const sineT = Math.max(0, Math.min(1, env * (0.75 + 0.25 * cres) * (1 - 0.3 * onset)));
    const seeT = Math.max(0, Math.min(1, Math.max(env, note) * (0.35 + 0.55 * Math.abs(subBias) + 0.35 * Math.abs(st.cVel.x) + 0.2 * note)));
    stepPadSpring(st.sine, sineT, dt, 2.4, 0.90, 0, 1.02);
    stepPadSpring(st.see, seeT, dt, 2.8, 0.90, 0, 1.02);
    const kTarget = Math.PI * (1 + st.sine.x);
    stepPadSpring(st.k, kTarget, dt, 2.0, 0.95, Math.PI * 0.75, Math.PI * 2.15);
    const hz = 0.28 + 0.55 * st.sine.x + 0.22 * st.see.x;
    const dir = st.dir.x >= 0 ? 1 : -1;
    st.phase += dir * 2 * Math.PI * hz * dt;
    st.t = tSec;
  }
  springs.set(key, st);
  const raise = Math.max(0, Math.min(1, st.raise.x));
  const extend = Math.max(0, Math.min(1, st.ext.x));
  const sweep = Math.max(-1, Math.min(1, st.sweep.x));
  const wrist = Math.max(-1, Math.min(1, st.wrist.x));
  const overhead = raise > 0.72 ? (raise - 0.72) / 0.28 : 0;
  const oh01 = Math.max(0, Math.min(1, overhead));
  const blend2 = raise <= 0 ? 0 : Math.min(0.98, 0.40 + 0.60 * raise);
  const lead = raise <= 0.18 ? 0 : raise >= 0.48 ? 1 : (() => { const u = (raise - 0.18) / 0.30; return u * u * (3 - 2 * u); })();
  const ohFac = 1 - 0.62 * oh01;
  const sine = st.sine ? Math.max(0, Math.min(1, st.sine.x)) : 0;
  const see = st.see ? Math.max(0, Math.min(1, st.see.x)) : 0;
  const ampRaise = (0.13 + 0.24 * see + 0.10 * sine) * Math.max(raise, note * 0.50) * ohFac;
  const ampSpace = (0.038 + 0.056 * sine + 0.022 * see) * Math.max(raise, 0.18 * note) * (1 - 0.28 * oh01);
  return {
    x: raise, raise, extend, sweep, wrist, lead,
    undulate: wrist, accent: Math.max(0, onset * 0.8 + Math.max(0, wrist) * 0.3),
    overhead: oh01,
    blend: raise < 0.01 ? 0 : blend2,
    wave: {
      phase: st.phase || 0,
      k: st.k ? st.k.x : Math.PI,
      ampRaise, ampSpace,
      sine, seesaw: see,
      dir: st.dir ? st.dir.x : 0
    },
    env, note, contour, target: targetRaise, act: actN, features: f
  };
}

export function applyPadArmAngles(base, padArm) {
  const aUpperL = base.aUpperL, aUpperR = base.aUpperR, aForeL = base.aForeL, aForeR = base.aForeR;
  if (!padArm || !(padArm.blend > 0.002)) {
    return {aUpperL, aUpperR, aForeL, aForeR, wrAddL: 0, wrAddR: 0, padArm: padArm || null};
  }
  const wave = padArm.wave || {phase: 0, k: Math.PI, ampRaise: 0, ampSpace: 0};
  const wL = wave.ampRaise * Math.sin(wave.phase);
  const wR = wave.ampRaise * Math.sin(wave.phase - (wave.k || Math.PI));
  const raiseL = Math.max(0, Math.min(1, padArm.raise + wL));
  const raiseR = Math.max(0, Math.min(1, padArm.raise + wR));
  const reachL = padReachAngle(raiseL);
  const reachR = padReachAngle(raiseR);
  const oh = padArm.overhead;
  const swp = padArm.sweep * deg(28) * (1 - 0.72 * oh);
  const und = padArm.undulate * deg(10);
  const acc = padArm.accent * deg(12);
  const lyrUL = -reachL + swp + und;
  const lyrUR = reachR + swp + und * 0.85;
  const lead = padArm.lead || 0;
  const bendMag = mix(deg(16), mix(deg(20), deg(8), oh), 0.4 * padArm.extend) + acc * 0.45 + und * 0.35;
  const lyrFL = lyrUL + mix(bendMag, -bendMag, lead);
  const lyrFR = lyrUR + mix(-bendMag, bendMag, lead);
  const b = padArm.blend;
  return {
    aUpperL: mix(aUpperL, lyrUL, b),
    aUpperR: mix(aUpperR, lyrUR, b),
    aForeL: mix(aForeL, lyrFL, b),
    aForeR: mix(aForeR, lyrFR, b),
    wrAddL: padArm.wrist * deg(16) + padArm.undulate * deg(12),
    wrAddR: -(padArm.wrist * deg(16) + padArm.undulate * deg(12)),
    padArm
  };
}

export function applyTravelingWave(joints, padArm) {
  if (!joints || !padArm || !(padArm.blend > 0.002) || !padArm.wave || !(padArm.wave.ampSpace > 0.001)) return joints;
  const A = padArm.wave.ampSpace;
  const ph = padArm.wave.phase;
  const kk = padArm.wave.k || Math.PI;
  const add = (p, s, w) => {
    if (!p) return p;
    const y = -A * w * Math.sin(ph - kk * s);
    const x = 0.22 * A * w * Math.cos(ph - kk * s);
    return {x: p.x + x, y: p.y + y, z: p.z};
  };
  joints.handL = add(joints.handL, 0.00, 1.00);
  joints.wristL = add(joints.wristL, 0.10, 0.95);
  joints.elL = add(joints.elL, 0.24, 0.72);
  joints.shL = add(joints.shL, 0.38, 0.16);
  joints.shR = add(joints.shR, 0.62, 0.16);
  joints.elR = add(joints.elR, 0.76, 0.72);
  joints.wristR = add(joints.wristR, 0.90, 0.95);
  joints.handR = add(joints.handR, 1.00, 1.00);
  return joints;
}


// At rest / low activation (TJ 11:55 AM): arms hang by the sides, upper arm
// near vertical, elbows slightly bent and close to the torso but outside its
// outline — never cocked out. Abduction and lift blend in as activation rises.
export const REST_HANG_ACT = 0.15;
export const REST_HANG_RELEASE = 0.45;
// ~5–10° abduction at rest: lat/upper ≈ sin(7.5°) ≈ 0.13 of upper arm,
// which is ~0.10 of full shoulder width (TJ Nov 10 6:19 PM).
export const REST_HANG_LAT_MAX = 0.14; // elbow lateral offset, fraction of shoulder width
export const REST_HANG_DROP_MIN = 0.92; // nearly vertical upper arm
export const REST_HANG_LAT_REST = 0.10;
export const REST_HANG_DROP_REST = 0.98;

export function restHangAmount(activation) {
  const a = Math.max(0, +activation || 0);
  if (a <= REST_HANG_ACT) return 1;
  if (a >= REST_HANG_RELEASE) return 0;
  const u = (a - REST_HANG_ACT) / (REST_HANG_RELEASE - REST_HANG_ACT);
  return 1 - u * u * (3 - 2 * u);
}

export function capRestHang(joints, {activation = 0, shW = 0.125, upperLen = 0.19, foreLen = 0.16, handLen = 0.11} = {}) {
  const w = restHangAmount(activation);
  if (!(w > 0.002) || !joints) return joints;
  const shWidth = 2 * Math.max(0.04, Number.isFinite(+shW) ? +shW : 0.125);
  const maxLat = REST_HANG_LAT_MAX * shWidth;
  const minDrop = REST_HANG_DROP_MIN * upperLen;
  const restLat = Math.min(maxLat, REST_HANG_LAT_REST * shWidth);
  const restDrop = Math.max(minDrop, Math.sqrt(Math.max(0, upperLen * upperLen - restLat * restLat)));

  const side = (sh, el, wrist, hand, sign) => {
    if (!sh || !el) return {el, wrist, hand};
    const targetX = sh.x + sign * restLat;
    const targetY = sh.y + restDrop;
    let x = el.x + (targetX - el.x) * w;
    let y = el.y + (targetY - el.y) * w;
    let dx = x - sh.x, dy = y - sh.y;
    // Keep the elbow outside the torso (outward from the shoulder) and
    // within the rest abduction cap.
    if (sign < 0) dx = Math.max(-maxLat, Math.min(-restLat * 0.4, dx));
    else dx = Math.min(maxLat, Math.max(restLat * 0.4, dx));
    if (dy < minDrop) dy = minDrop;
    const span = Math.hypot(dx, dy);
    if (span > 1e-9) {
      const s = upperLen / span;
      dx *= s; dy *= s;
    } else {
      dx = sign * restLat; dy = restDrop;
    }
    if (Math.abs(dx) > maxLat) {
      dx = sign * maxLat;
      dy = Math.max(minDrop, Math.sqrt(Math.max(0, upperLen * upperLen - dx * dx)));
    }
    if (dy < minDrop) {
      dy = minDrop;
      const rem = Math.sqrt(Math.max(0, upperLen * upperLen - dy * dy));
      dx = sign * Math.min(maxLat, rem);
    }
    // Upper arm hangs close to the torso, slightly behind the shoulder line
    // (not dangling forward). Hands stay by the thighs, palms inward.
    const back = 0.012 * upperLen * w;
    const newEl = {x: sh.x + dx, y: sh.y + dy, z: (sh.z || 0) - back + ((el.z || 0) - (sh.z || 0)) * (1 - w)};
    const place = (from, to, len, hang, zOff = 0) => {
      if (!to || !from) return to;
      let ox = (to.x - from.x) * (1 - 0.45 * w) + (sign * 0.02 * len) * w;
      let oy = (to.y - from.y) * (1 - w) + hang * len * w;
      if (oy < 0.12 * len && w > 0.55) oy = 0.12 * len;
      const n = Math.hypot(ox, oy) || len;
      const z = (from.z || 0) + zOff * w + ((to.z || 0) - (from.z || 0)) * (1 - w);
      return {x: from.x + ox / n * len, y: from.y + oy / n * len, z};
    };
    const newWrist = place(newEl, wrist, foreLen, 0.94, 0.006 * foreLen);
    const newHand = place(newWrist || newEl, hand, handLen, 0.96, 0.010 * handLen);
    return {el: newEl, wrist: newWrist, hand: newHand};
  };
  const L = side(joints.shL, joints.elL, joints.wristL, joints.handL, -1);
  joints.elL = L.el; joints.wristL = L.wrist; joints.handL = L.hand;
  const R = side(joints.shR, joints.elR, joints.wristR, joints.handR, 1);
  joints.elR = R.el; joints.wristR = R.wrist; joints.handR = R.hand;
  return joints;
}

// At rest / low activation (TJ 11:55 / 12:03 PM): spine vertical, shoulders
// over the hips, no hunch. Arms ride with the shoulders so the hang cap
// still applies. Lateral lean and forward flex blend back in as activation
// rises, on the same schedule as restHangAmount.
export const REST_UPRIGHT_SH_MAX = 0.02;    // mid-shoulder x vs mid-hip, height units
export const REST_UPRIGHT_SPINE_MAX = 0.02; // neck/head/crown/heart x vs mid-hip
const REST_UPRIGHT_SPINE = ['lumbar', 'sacral', 'solar', 'heart', 'thoracic', 'throat', 'thirdEye', 'neck', 'crown', 'head'];
const REST_UPRIGHT_ARMS = ['elL', 'elR', 'wristL', 'wristR', 'handL', 'handR'];

export function capRestUpright(joints, {activation = 0} = {}) {
  const w = restHangAmount(activation);
  if (!(w > 0.002) || !joints) return joints;
  const hipL = joints.hipL, hipR = joints.hipR;
  if (!hipL || !hipR) return joints;
  const midHipX = (hipL.x + hipR.x) * 0.5;
  const midHipZ = ((hipL.z || 0) + (hipR.z || 0)) * 0.5;
  const shL = joints.shL, shR = joints.shR;
  if (shL && shR) {
    const midShX = (shL.x + shR.x) * 0.5;
    const midShZ = ((shL.z || 0) + (shR.z || 0)) * 0.5;
    const dx = (midHipX - midShX) * w;
    const dz = (midHipZ - midShZ) * w;
    shL.x += dx; shR.x += dx;
    shL.z = (shL.z || 0) + dz;
    shR.z = (shR.z || 0) + dz;
    for (const k of REST_UPRIGHT_ARMS) {
      const pnt = joints[k];
      if (pnt) { pnt.x += dx; pnt.z = (pnt.z || 0) + dz; }
    }
  }
  const straighten = (pnt) => {
    if (!pnt || !Number.isFinite(+pnt.x)) return;
    pnt.x += (midHipX - pnt.x) * w;
    pnt.z = (pnt.z || 0) + (midHipZ - (pnt.z || 0)) * w;
  };
  for (const k of REST_UPRIGHT_SPINE) straighten(joints[k]);
  if (joints.spine && typeof joints.spine === 'object') {
    for (const k of REST_UPRIGHT_SPINE) straighten(joints.spine[k]);
  }
  return joints;
}

export function capHandsLead(joints, {flexT = 0, lead = 0, minClear = 0.018} = {}) {
  if (!joints) return joints;
  if (!((flexT > 0.55) || (lead > 0.45))) return joints;
  const cap = (el, wrist, hand, elPush) => {
    if (!el || !wrist || !hand) return {el, wrist, hand};
    if (wrist.y > el.y - minClear) {
      const lift = wrist.y - (el.y - minClear);
      wrist = {x: wrist.x, y: wrist.y - lift, z: wrist.z};
      hand = {x: hand.x, y: hand.y - lift * 1.12, z: hand.z};
      el = {x: el.x, y: el.y + lift * elPush, z: el.z};
    }
    if (hand.y > el.y - minClear) {
      const lift = hand.y - (el.y - minClear);
      hand = {x: hand.x, y: hand.y - lift, z: hand.z};
      wrist = {x: wrist.x, y: wrist.y - lift * 0.55, z: wrist.z};
    }
    return {el, wrist, hand};
  };
  let fix = cap(joints.elL, joints.wristL, joints.handL, 0.16);
  joints.elL = fix.el; joints.wristL = fix.wrist; joints.handL = fix.hand;
  fix = cap(joints.elR, joints.wristR, joints.handR, 0.16);
  joints.elR = fix.el; joints.wristR = fix.wrist; joints.handR = fix.hand;
  return joints;
}

// Tighter post-yaw cap so screen-space foreshortening cannot lift an elbow over its wrist.
export function capHandsLeadScreen(joints, {flexT = 0, lead = 0, minClear = 0.016} = {}) {
  if (!joints) return joints;
  if (!((flexT > 0.55) || (lead > 0.45))) return joints;
  const cap = (el, wrist, hand) => {
    if (!el || !wrist || !hand) return {el, wrist, hand};
    if (wrist.y > el.y - minClear) {
      const lift = wrist.y - (el.y - minClear);
      wrist = {x: wrist.x, y: wrist.y - lift, z: wrist.z};
      hand = {x: hand.x, y: hand.y - lift * 1.1, z: hand.z};
      el = {x: el.x, y: el.y + lift * 0.12, z: el.z};
    }
    if (hand.y > el.y - minClear) {
      const lift = hand.y - (el.y - minClear);
      hand = {x: hand.x, y: hand.y - lift, z: hand.z};
      wrist = {x: wrist.x, y: wrist.y - lift * 0.5, z: wrist.z};
    }
    return {el, wrist, hand};
  };
  let fix = cap(joints.elL, joints.wristL, joints.handL);
  joints.elL = fix.el; joints.wristL = fix.wrist; joints.handL = fix.hand;
  fix = cap(joints.elR, joints.wristR, joints.handR);
  joints.elR = fix.el; joints.wristR = fix.wrist; joints.handR = fix.hand;
  return joints;
}

// Map pad presence onto the rest-hang activation scale so a pad or melody
// can release the hang cap even when dancer onset-activation is low. Silence
// and drums (raise/env/note ≈ 0) still fully hang. A 1.2 scale lets a mid
// pad at normal music levels clear the 0.45 release threshold.
export function padDriveActivation(padArm) {
  if (!padArm) return 0;
  const raise = Math.max(0, +padArm.raise || 0);
  const env = Math.max(0, +padArm.env || 0);
  const note = Math.max(0, +padArm.note || 0);
  const blend = Math.max(0, +padArm.blend || 0);
  return Math.min(1, Math.max(raise, env, note * 0.9, blend) * 1.2);
}

export function emptyPadFeatures() {
  return {...EMPTY_FEATURES};
}

export {EMPTY_FEATURES};
