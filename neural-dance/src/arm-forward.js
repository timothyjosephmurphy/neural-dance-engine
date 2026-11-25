// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Shared by the live dancers (skeleton-dancer.js) and the side sim.
import {clamp, smoothstep} from './geometry.js';

// Phrases (4 beats) on which a dancer uses the forward reach: about one in
// four, per-dancer seed, never two in a row.
export function forwardPhrase(seed, phrase) {
  const h = p => { const s = Math.sin(((seed | 0) * 7.13 + (p | 0) * 3.71 + 0.5) * 12.9898) * 43758.5453; return s - Math.floor(s); };
  return h(phrase) < 0.26 && !(h(phrase - 1) < 0.26);
}

// Pure-time envelope for a forward phrase (side sim renders any t): eases in
// over the first beat and out over the last, so it is 0 at both phrase edges.
export function forwardEnvelope(seed, tSec, bpm = 120) {
  const beats = Math.max(0, +tSec || 0) * Math.max(40, +bpm || 120) / 60;
  const phrase = Math.floor(beats / 4), u = beats / 4 - phrase;
  if (!forwardPhrase(seed, phrase)) return 0;
  return smoothstep(u * 4) * smoothstep((1 - u) * 4);
}

// Shoulder flexion (TJ Nov 11: arms raise forward in front of the body, for
// moves and the pre-drop build). Blends each arm's bone directions toward a
// forward reach (+z is toward the audience), so bone lengths never change.
// fwd 0..1 per side; the reach angle rises from ~72° (forward, hands at
// chest height) to ~88° (level with the shoulder) as it commits.
export const ARM_FORWARD_DEG = [72, 88];
export function applyArmForward(j, fwdL, fwdR) {
  const sub = (a, c) => ({x: a.x - c.x, y: a.y - c.y, z: (+a.z || 0) - (+c.z || 0)});
  const len = v => Math.hypot(v.x, v.y, v.z);
  const unit = v => { const l = len(v) || 1; return {x: v.x / l, y: v.y / l, z: v.z / l}; };
  const mixU = (a, c, t) => unit({x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t});
  const put = (from, dir, l) => ({x: from.x + dir.x * l, y: from.y + dir.y * l, z: (+from.z || 0) + dir.z * l});
  for (const [s, f] of [['L', fwdL], ['R', fwdR]]) {
    const w = smoothstep(clamp(+f || 0, 0, 1));
    if (!(w > 0.001)) continue;
    const sh = j['sh' + s], el = j['el' + s], wr = j['wrist' + s], hd = j['hand' + s];
    if (!sh || !el || !wr || !hd) continue;
    const inward = s === 'L' ? 1 : -1; // toward the body midline
    const th = (ARM_FORWARD_DEG[0] + (ARM_FORWARD_DEG[1] - ARM_FORWARD_DEG[0]) * w) * Math.PI / 180;
    const upper = sub(el, sh), fore = sub(wr, el), hand = sub(hd, wr);
    const lu = len(upper), lf = len(fore), lh = len(hand);
    const tu = unit({x: inward * 0.10 * Math.sin(th), y: Math.cos(th), z: Math.sin(th)});
    const thF = th + 8 * Math.PI / 180; // soft elbow, forearm angled up a touch
    const tf = unit({x: inward * 0.22 * Math.sin(thF), y: Math.cos(thF), z: Math.sin(thF)});
    const du = mixU(unit(upper), tu, w), df = mixU(unit(fore), tf, w), dh = mixU(unit(hand), tf, w);
    const e2 = put(sh, du, lu), w2 = put(e2, df, lf), h2 = put(w2, dh, lh);
    j['el' + s] = e2; j['wrist' + s] = w2; j['hand' + s] = h2;
  }
  return j;
}

// Rear arm limit (TJ Nov 11 5:46 PM: "they sometimes reach a little bit far
// behind the body when they go backwards. Make it stop just behind their
// head. Elbows can't go past the head backwards."). Runs on the final 3D
// joints of every arm move (raise, swing, pad / melody, rotation, rave
// phrases, forward reach), live and side sim. "Back" is the shoulder girdle's
// rear normal; the limit is the back of the skull (head centre depth minus
// its front-back radius) plus a small margin. Each segment is turned about
// its parent joint (shoulder -> elbow -> wrist -> hand), so bone lengths are
// exact, and the depth is eased with a soft knee so the arm never snaps.
export const ARM_BACK_MARGIN_HEAD = 0.18;   // margin behind the skull, in head radii
export const ARM_BACK_KNEE_HEAD = 0.30;     // soft-limit knee width, in head radii
export const HEAD_DEPTH_K = 0.95;           // front-back skull radius / headR (b.headRz)

function softAbove(x, k) {
  // Identity for x >= k; below that an exponential approach to 0 (C1 at k),
  // so the result is always > 0 (never past the limit) and never jumps.
  if (x >= k) return x;
  return k * Math.exp((x - k) / k);
}

// Body forward (+z toward the audience at facing 0) from the shoulder line;
// L sits at -x, so forward = (-r.z, r.x) for r = shR - shL.
export function girdleForward(shL, shR, fallbackYaw = 0) {
  if (shL && shR) {
    const rx = shR.x - shL.x, rz = (+shR.z || 0) - (+shL.z || 0);
    const l = Math.hypot(rx, rz);
    if (l > 1e-6) return {x: -rz / l, z: rx / l};
  }
  const y = +fallbackYaw || 0;
  return {x: Math.sin(y), z: Math.cos(y)};
}

export function armBackLimit(head, headR, fwd, opts = {}) {
  const rz = headR * (opts.depthK != null ? opts.depthK : HEAD_DEPTH_K);
  const margin = headR * (opts.margin != null ? opts.margin : ARM_BACK_MARGIN_HEAD);
  return head.x * fwd.x + (+head.z || 0) * fwd.z - rz - margin;
}

// j: {head, shL, shR, elL, elR, wristL, wristR, handL, handR} with x, y, z
// in one unit space (y down). headR in the same units. Mutates j.
export function limitArmsBehindHead(j, headR, opts = {}) {
  if (!j || !j.head || !(headR > 0)) return j;
  const f = opts.forward || girdleForward(j.shL, j.shR, opts.yaw);
  const limit = armBackLimit(j.head, headR, f, opts);
  const knee = headR * (opts.knee != null ? opts.knee : ARM_BACK_KNEE_HEAD);
  const depth = p => p.x * f.x + (+p.z || 0) * f.z;
  let moved = 0;
  for (const s of ['L', 'R']) {
    const keys = ['sh' + s, 'el' + s, 'wrist' + s, 'hand' + s];
    if (!keys.every(k => j[k] && Number.isFinite(+j[k].x) && Number.isFinite(+j[k].y))) continue;
    const orig = keys.map(k => ({x: +j[k].x, y: +j[k].y, z: +j[k].z || 0}));
    const out = [orig[0]];
    for (let i = 1; i < keys.length; i++) {
      const P = out[i - 1];
      // Child carried with its (possibly turned) parent, segment kept rigid.
      const vx = orig[i].x - orig[i - 1].x, vy = orig[i].y - orig[i - 1].y, vz = orig[i].z - orig[i - 1].z;
      const l = Math.hypot(vx, vy, vz);
      if (!(l > 1e-9)) { out.push({x: P.x, y: P.y, z: P.z}); continue; }
      const C = {x: P.x + vx, y: P.y + vy, z: P.z + vz};
      const dC = depth(C);
      const dT = limit + softAbove(dC - limit, knee);
      if (dT - dC < 1e-9) { out.push(C); continue; }
      // Turn the segment about P so its depth component is (dT - dP), keeping
      // the direction of the part perpendicular to forward (bone length exact).
      const ux = vx / l, uy = vy / l, uz = vz / l;
      const a = ux * f.x + uz * f.z;
      const a2 = clamp((dT - depth(P)) / l, -1, 1);
      if (a2 <= a) { out.push(C); continue; }
      let px = ux - a * f.x, py = uy, pz = uz - a * f.z;
      let pl = Math.hypot(px, py, pz);
      if (!(pl > 1e-6)) { px = 0; py = 1; pz = 0; pl = 1; }
      const q = Math.sqrt(Math.max(0, 1 - a2 * a2)) / pl;
      out.push({x: P.x + l * (a2 * f.x + px * q), y: P.y + l * (py * q), z: P.z + l * (a2 * f.z + pz * q)});
      moved++;
    }
    for (let i = 1; i < keys.length; i++) {
      const src = j[keys[i]];
      const hadZ = src.z != null;
      j[keys[i]] = hadZ || opts.keepZ !== false ? {...src, x: out[i].x, y: out[i].y, z: out[i].z} : {...src, x: out[i].x, y: out[i].y};
    }
  }
  j.armBackMoved = moved;
  return j;
}
