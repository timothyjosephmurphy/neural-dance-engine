// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Side-sim framing and small motion limits.
// A dancer with both arms at full reach stays inside the canvas. Turns ease
// across the step and never pass 90°. A joint step cannot jump farther than
// the cap. The chakra offset stays inside the body at that height. The hand
// stays on the forearm line (no limp wrist).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };

export const MAX_TURN_RAD = Math.PI / 2;
export const REACH_X = 0.66;     // unit half-width, arms straight out
export const REACH_TOP = -0.08;  // unit y above the nominal head line
export const REACH_BOT = 1.03;
export const MAX_JOINT_STEP = 0.08;

/** Pull each dancer in, then shrink, until the full-reach box is on stage. */
export function containDancers({width, height, margin = 10, reachX = REACH_X, yTop = REACH_TOP, yBot = REACH_BOT, dancers = []} = {}) {
  const W = Math.max(1, +width || 1);
  const H = Math.max(1, +height || 1);
  const m = Math.max(0, +margin || 0);
  const fit = (scale) => (dancers || []).map(d => {
    const h0 = Math.max(1, (+d.yFeet || 0) - (+d.yHead || 0));
    const h = h0 * scale;
    const yFeet = Math.min(+d.yFeet || H * 0.9, H - m);
    const yHead = yFeet - h;
    const reach = reachX * h;
    const lo = m + reach;
    const hi = W - m - reach;
    let x0 = +d.x0 || W / 2;
    if (!(hi > lo)) x0 = W / 2;
    else x0 = clamp(x0, lo, hi);
    const top = yHead + yTop * h;
    const bot = yHead + yBot * h;
    const left = x0 - reach;
    const right = x0 + reach;
    const ok = top >= m - 0.5 && bot <= H - m + 0.5 && left >= m - 0.5 && right <= W - m + 0.5;
    return {x0, yHead, yFeet, h, top, bot, left, right, ok};
  });
  let scale = 1;
  let placed = fit(scale);
  for (let i = 0; i < 16 && placed.some(p => !p.ok); i++) {
    scale *= 0.92;
    placed = fit(scale);
  }
  return {scale, dancers: placed};
}

/**
 * Cap one step's turn so 90° takes at least a beat, then ease across the step.
 * `from` and the result stay inside ±90°.
 */
export function easeTurn(from, delta, frac, stepSec = 1, beatSec = 1) {
  const start = clamp(+from || 0, -MAX_TURN_RAD, MAX_TURN_RAD);
  const beat = Math.max(0.05, +beatSec || 1);
  const step = Math.max(0, +stepSec || 0);
  const room = MAX_TURN_RAD * Math.min(1, step / beat);
  const d = clamp(+delta || 0, -room, room);
  const end = clamp(start + d, -MAX_TURN_RAD, MAX_TURN_RAD);
  const u = smooth(frac);
  return {facing: start + (end - start) * u, end, delta: end - start};
}

/** Keep a chakra-string offset inside the body half-width at that height. */
export function confineLateral(offset, limit) {
  const lim = Math.max(0, +limit || 0);
  if (!(lim > 0)) return 0;
  const off = +offset || 0;
  return Math.tanh(off / lim) * lim;
}

/** Hand continues the forearm. The wrist does not flop off that line. */
export function handOnForearm(elbow, wrist, handLen) {
  if (!elbow || !wrist) return wrist ? {x: wrist.x, y: wrist.y, z: wrist.z || 0} : null;
  const dx = (+wrist.x || 0) - (+elbow.x || 0);
  const dy = (+wrist.y || 0) - (+elbow.y || 0);
  const dz = (+wrist.z || 0) - (+elbow.z || 0);
  const len = Math.hypot(dx, dy, dz) || 1;
  const hand = Math.max(0, +handLen || 0);
  return {
    x: wrist.x + dx / len * hand,
    y: wrist.y + dy / len * hand,
    z: (wrist.z || 0) + dz / len * hand,
  };
}

/** Largest joint step, in the same units as the pose. */
export function jointDisp(prev, next, keys) {
  let max = 0;
  const list = keys || Object.keys(next || {});
  for (const k of list) {
    const a = prev && prev[k], b = next && next[k];
    if (!a || !b || !Number.isFinite(+a.x) || !Number.isFinite(+b.x)) continue;
    const d = Math.hypot((+b.x || 0) - (+a.x || 0), (+b.y || 0) - (+a.y || 0), (+b.z || 0) - (+a.z || 0));
    if (d > max) max = d;
  }
  return max;
}

/** Pull each joint toward `prev` so no joint moves more than `maxStep`. */
export function capJointStep(prev, next, maxStep = MAX_JOINT_STEP, keys) {
  if (!next) return next;
  const cap = Math.max(0, +maxStep || 0);
  const list = keys || Object.keys(next);
  for (const k of list) {
    const a = prev && prev[k], b = next[k];
    if (!a || !b || !Number.isFinite(+a.x) || !Number.isFinite(+b.x)) continue;
    const dx = (+b.x || 0) - (+a.x || 0);
    const dy = (+b.y || 0) - (+a.y || 0);
    const dz = (+b.z || 0) - (+a.z || 0);
    const d = Math.hypot(dx, dy, dz);
    if (!(d > cap) || d < 1e-9) continue;
    const s = cap / d;
    b.x = a.x + dx * s;
    b.y = a.y + dy * s;
    if (Number.isFinite(+b.z) || dz) b.z = (a.z || 0) + dz * s;
  }
  return next;
}

const mod = {MAX_TURN_RAD, REACH_X, REACH_TOP, REACH_BOT, MAX_JOINT_STEP, containDancers, easeTurn, confineLateral, handOnForearm, jointDisp, capJointStep};
export default mod;
