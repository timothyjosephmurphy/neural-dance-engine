// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Sticker pose (TJ, Nov 11 3:07 PM): each live dancer's silhouette lines up
// with the sticker it was scanned from. The traced sticker figure (stage px,
// i.e. projector space after the camera quad / homography) is fitted to the
// skeleton's key joints: head, shoulders, hands, hips and feet. That fitted
// layout is the dancer's home pose. The dancer eases back into it on phrase
// downbeats (every 4-8 bars) and whenever it is resting or at low
// activation, blending in and out with a critically damped weight (no snaps).
//
// All work is per dancer per frame on <= 64 contour points (fit is cached
// per contour), so 24 dancers stay inside the iPhone budget.

export const HEAD_BAND = 0.14;     // top share of the height that is the head
export const FOOT_BAND = 0.09;     // bottom share that holds the feet
export const SHOULDER_Y = 0.19;    // of height from the top
export const HIP_Y = 0.52;
export const SHOULDER_HALF = 0.105; // anatomical fallback half-widths (of height)
export const HIP_HALF = 0.075;
export const HAND_MIN_REACH = 0.16; // |dx| below this: arms hang at the sides
export const PHRASE_BARS_MIN = 4, PHRASE_BARS_MAX = 8;
export const PHRASE_PEAK = 0.85;   // phrase-downbeat return strength
export const REST_PEAK = 1;        // full home pose at rest / silence
export const REST_ACT_LO = 0.08, REST_ACT_HI = 0.30;
export const BLEND_OMEGA = 7;      // rad/s, critically damped weight spring
export const FIT_TOL = 0.06;       // test tolerance, share of figure height

function bounds(pts) {
  let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
  for (const p of pts) {
    if (p.y < top) top = p.y; if (p.y > bottom) bottom = p.y;
    if (p.x < left) left = p.x; if (p.x > right) right = p.x;
  }
  return {top, bottom, left, right};
}

// x extent of the polygon at height y (scanline), or null.
function spanAt(pts, y) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      const x = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
      if (x < lo) lo = x; if (x > hi) hi = x;
    }
  }
  return hi > lo ? {lo, hi} : null;
}

// Fit the skeleton's key joints to a traced sticker figure (stage px).
// cx: the dancer's axis (sticker centre x). Returns stage-px joints, or null.
export function fitStickerPose(contour, cx = null) {
  if (!Array.isArray(contour) || contour.length < 6) return null;
  const pts = contour.filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  if (pts.length < 6) return null;
  const b = bounds(pts);
  if (!(b.bottom - b.top > 4)) return null;
  const axis = Number.isFinite(+cx) ? +cx : (b.left + b.right) / 2;
  // Head top: the highest point near the body axis. Raised hands can reach
  // higher, so the figure height runs head top -> feet, not bbox top.
  const near = 0.08 * (b.bottom - b.top);
  let headTop = Infinity;
  for (const p of pts) if (Math.abs(p.x - axis) < near && p.y < headTop) headTop = p.y;
  if (!Number.isFinite(headTop)) headTop = b.top;
  const H = b.bottom - headTop;
  if (!(H > 4)) return null;
  const at = f => headTop + f * H;
  let hx = 0, hn = 0;
  for (const p of pts) if (p.y <= at(HEAD_BAND) && Math.abs(p.x - axis) < 0.1 * H) { hx += p.x; hn++; }
  const head = {x: hn ? hx / hn : axis, y: at(0.07)};
  // Shoulders and hips: centred on the polygon at that level, anatomical widths.
  const shS = spanAt(pts, at(SHOULDER_Y));
  const shMid = shS && (shS.hi - shS.lo) < 0.5 * H ? (shS.lo + shS.hi) / 2 : (head.x + axis) / 2;
  const shHalf = SHOULDER_HALF * H;
  const shL = {x: shMid - shHalf, y: at(SHOULDER_Y)};
  const shR = {x: shMid + shHalf, y: at(SHOULDER_Y)};
  const hipS = spanAt(pts, at(HIP_Y));
  const hipMid = hipS && (hipS.hi - hipS.lo) < 0.45 * H ? (hipS.lo + hipS.hi) / 2 : axis;
  const hipHalf = HIP_HALF * H;
  const hipL = {x: hipMid - hipHalf, y: at(HIP_Y)};
  const hipR = {x: hipMid + hipHalf, y: at(HIP_Y)};
  // Torso half-width model (of H) by height share: points outside it belong
  // to the arms.
  const torsoHalf = f => f < SHOULDER_Y ? 0.06 : f > 0.5 ? 0.18 : 0.12 + (0.095 - 0.12) * Math.min(1, (f - SHOULDER_Y) / (HIP_Y - SHOULDER_Y)); // > 0.5: thighs
  // Hands: the arm point farthest from its shoulder on each side. Raised or
  // outstretched arms (above the shoulders or well clear of the torso) win;
  // otherwise the arm hangs and its hand is the side extreme by the hips.
  const hand = side => {
    const sh = side < 0 ? shL : shR;
    const mid = (shMid + hipMid) / 2;
    let best = null, bestD = -1, hang = null, hangD = -1;
    for (const p of pts) {
      const f = (p.y - headTop) / H;
      if (f > 0.6) continue;
      const dx = (p.x - mid) * side;
      if (dx < (torsoHalf(Math.max(0, f)) + 0.015) * H) continue;
      const d = Math.hypot(p.x - sh.x, p.y - sh.y);
      if (f < SHOULDER_Y + 0.04 || dx > 0.22 * H) { if (d > bestD) { bestD = d; best = p; } }
      else if (d > hangD) { hangD = d; hang = p; }
    }
    if (!best || bestD < 0.12 * H) best = hang;
    if (!best) return {x: shMid + side * 0.13 * H, y: at(0.47), hanging: true}; // arm along the body
    // Contour tip = fingertips; the joint is the hand centre a little inside.
    const ux = best.x - sh.x, uy = best.y - sh.y, d = Math.hypot(ux, uy) || 1;
    const k = Math.max(0, d - 0.025 * H) / d;
    return {x: sh.x + ux * k, y: sh.y + uy * k, hanging: false};
  };
  const handL = hand(-1), handR = hand(1);
  // Feet: extreme points of the bottom band on each side of the hips.
  const foot = side => {
    let best = null;
    for (const p of pts) {
      if (p.y < b.bottom - FOOT_BAND * H) continue;
      if (!best || (p.x - hipMid) * side > (best.x - hipMid) * side) best = p;
    }
    const x = best ? best.x - side * 0.02 * H : hipMid + side * 0.05 * H;
    // Never cross the midline; a single blob of feet splits evenly.
    const minOut = 0.035 * H;
    return {x: side < 0 ? Math.min(x, hipMid - minOut) : Math.max(x, hipMid + minOut), y: b.bottom - 0.01 * H};
  };
  const footL = foot(-1), footR = foot(1);
  return {height: H, top: headTop, bottom: b.bottom, axis, head, shL, shR, hipL, hipR, handL, handR, footL, footR};
}

// Mean distance (share of height) between fitted joints and reference joints.
export function fitError(fit, ref, keys = ['head', 'shL', 'shR', 'hipL', 'hipR', 'handL', 'handR', 'footL', 'footR']) {
  if (!fit || !ref) return Infinity;
  let s = 0, n = 0;
  for (const k of keys) if (fit[k] && ref[k]) { s += Math.hypot(fit[k].x - ref[k].x, fit[k].y - ref[k].y); n++; }
  return n ? s / n / fit.height : Infinity;
}

// Per-dancer phrase length in bars (4 or 8), stable for an id.
export function phraseBarsFor(id) {
  const h = Math.abs(Math.sin((id | 0) * 12.9898 + 4.1414) * 43758.5453) % 1;
  return h < 0.5 ? PHRASE_BARS_MIN : PHRASE_BARS_MAX;
}

function smooth01(u) { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); }

// Target weight from the phrase clock and the dancer's activity.
// beat: continuous beat position (beat index + fraction) on the dancer's
// grid; bars: phrase length; activation 0..1; hush 0..1 (0 = silence).
export function stickerPoseTarget({beat = 0, bars = PHRASE_BARS_MIN, activation = 0, hush = 1, beatsPerBar = 4} = {}) {
  const span = Math.max(1, bars * beatsPerBar);
  const u = ((beat % span) + span) % span; // beats since the phrase downbeat
  // Arrive on the downbeat: ease in over the last beat of the phrase, hold
  // 1.5 beats, ease out over 1.5 beats.
  let phrase = 0;
  if (u >= span - 1) phrase = smooth01(u - (span - 1));
  else if (u < 1.5) phrase = 1;
  else if (u < 3) phrase = 1 - smooth01((u - 1.5) / 1.5);
  const act = Math.max(0, Math.min(1, +activation || 0));
  const lowAct = 1 - smooth01((act - REST_ACT_LO) / (REST_ACT_HI - REST_ACT_LO));
  const quiet = 1 - Math.max(0, Math.min(1, +hush));
  const rest = Math.max(lowAct, quiet);
  return Math.min(1, Math.max(PHRASE_PEAK * phrase, REST_PEAK * rest));
}

// Critically damped follower: no step in position or velocity.
export function createStickerPoseBlend() {
  const st = new Map();
  return {
    // nowMs: frame clock; the first call for an id starts from 0 (eases in).
    step(id, target, nowMs) {
      let s = st.get(id);
      if (!s) { s = {w: 0, v: 0, t: nowMs}; if (st.size > 256) st.clear(); st.set(id, s); }
      const dt = Math.max(0, Math.min(0.1, ((+nowMs || 0) - (+s.t || 0)) / 1000));
      s.t = nowMs;
      const w0 = BLEND_OMEGA;
      // Semi-implicit critically damped spring.
      const a = w0 * w0 * (target - s.w) - 2 * w0 * s.v;
      s.v += a * dt; s.w += s.v * dt;
      if (s.w < 0) { s.w = 0; s.v = Math.max(0, s.v); }
      if (s.w > 1) { s.w = 1; s.v = Math.min(0, s.v); }
      return s.w;
    },
    get(id) { const s = st.get(id); return s ? s.w : 0; },
    reset(id) { if (id == null) st.clear(); else st.delete(id); },
  };
}

function lerp(a, b, w) { return a + (b - a) * w; }

// 2D two-bone IK: joint between A and C with lengths l1, l2, bending to side.
function ik2(A, C, l1, l2, side) {
  const dx = C.x - A.x, dy = C.y - A.y;
  const d0 = Math.hypot(dx, dy) || 1e-6;
  const d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, d0));
  const ux = dx / d0, uy = dy / d0;
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let px = -uy, py = ux;
  if (px * side < 0) { px = -px; py = -py; }
  return {x: A.x + ux * a + px * h, y: A.y + uy * a + py * h};
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function shift(p, dx, dy, w = 1) { if (p) { p.x += dx * w; p.y += dy * w; } }

// Blend a placed pose (stage px, in place) toward the fitted sticker pose.
// w 0..1. Head, shoulders, hips and hands blend; feet are left to the step
// system so traction is never broken.
export function blendStickerPose(posed, fit, w) {
  if (!posed || !fit || !(w > 0.001)) return posed;
  const k = Math.min(1, w);
  const H = +posed.height > 0 ? +posed.height : fit.height;
  // Torso stays upright (TJ: dancers come back to centre, no lasting lean):
  // the whole upper body slides to the sticker's centre line (<= 4% of H),
  // shoulders and head only offset a little relative to the hips.
  const clamp = (v, c) => Math.max(-c, Math.min(c, v));
  const UPPER = ['hipL', 'hipR', 'groin', 'pelvis', 'lumbar', 'solar', 'thoracic', 'heart', 'shL', 'shR', 'neck', 'head', 'crown', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR'];
  if (posed.hipL && posed.hipR) {
    const midX = (posed.hipL.x + posed.hipR.x) / 2;
    const dx = clamp((fit.hipL.x + fit.hipR.x) / 2 - midX, 0.04 * H) * k;
    for (const j of UPPER) shift(posed[j], dx, 0);
    // Knees follow the hips with the ankles fixed (bone lengths kept).
    for (const s of ['L', 'R']) {
      const hip = posed['hip' + s], kn = posed['knee' + s], an = posed['ankle' + s];
      if (!hip || !kn || !an || !dx) continue;
      const l1 = Math.hypot(kn.x - (hip.x - dx), kn.y - hip.y), l2 = dist(kn, an);
      const e = ik2(hip, an, l1, l2, (kn.x - hip.x) * (an.y - hip.y) - (kn.y - hip.y) * (an.x - hip.x) >= 0 ? 1 : -1);
      kn.x = e.x; kn.y = e.y;
    }
  }
  if (posed.shL && posed.shR && posed.hipL && posed.hipR) {
    const midX = (posed.shL.x + posed.shR.x) / 2;
    const hipFit = (fit.hipL.x + fit.hipR.x) / 2, shFit = (fit.shL.x + fit.shR.x) / 2;
    const want = midX + clamp(shFit - hipFit, 0.015 * H) - clamp(midX - (posed.hipL.x + posed.hipR.x) / 2, 0.015 * H);
    const dx = clamp(want - midX, 0.015 * H) * k;
    for (const j of ['shL', 'shR', 'neck', 'head', 'crown', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) shift(posed[j], dx, 0);
    for (const j of ['thoracic', 'heart']) shift(posed[j], dx, 0, 0.5);
  }
  const headRef = posed.head || posed.crown;
  if (headRef && posed.neck) {
    const dx = clamp(fit.head.x - headRef.x, 0.015 * H) * k;
    shift(posed.head, dx, 0); shift(posed.crown, dx, 0); shift(posed.neck, dx * 0.5, 0);
  }
  // Arms: hands blend toward the sticker hands, elbows by IK (bone lengths kept).
  for (const s of ['L', 'R']) {
    const sh = posed['sh' + s], el = posed['el' + s], wr = posed['wrist' + s], hd = posed['hand' + s];
    const tgt = fit['hand' + s];
    if (!sh || !el || !hd || !tgt) continue;
    const l1 = dist(sh, el), l2 = wr ? dist(el, wr) : dist(el, hd), l3 = wr ? dist(wr, hd) : 0;
    const reach = l1 + l2 + l3;
    let tx = lerp(hd.x, tgt.x, k), ty = lerp(hd.y, tgt.y, k);
    const dx = tx - sh.x, dy = ty - sh.y, d = Math.hypot(dx, dy) || 1;
    if (d > reach * 0.999) { tx = sh.x + dx / d * reach * 0.999; ty = sh.y + dy / d * reach * 0.999; }
    // Wrist sits l3 short of the hand along the shoulder->hand line.
    const dd = Math.hypot(tx - sh.x, ty - sh.y) || 1;
    const wrT = l3 > 0 ? {x: tx - (tx - sh.x) / dd * l3, y: ty - (ty - sh.y) / dd * l3} : {x: tx, y: ty};
    // Keep the elbow on the side it already bends to.
    const e = ik2(sh, wrT, l1, l2, (el.x - sh.x) * (wrT.y - sh.y) - (el.y - sh.y) * (wrT.x - sh.x) >= 0 ? 1 : -1);
    const ez = Number.isFinite(+el.z) ? el.z * (1 - k) : el.z;
    el.x = e.x; el.y = e.y; if (ez !== undefined) el.z = ez;
    if (wr) { wr.x = wrT.x; wr.y = wrT.y; if (Number.isFinite(+wr.z)) wr.z *= 1 - k; }
    hd.x = tx; hd.y = ty; if (Number.isFinite(+hd.z)) hd.z *= 1 - k;
  }
  // Feet stay with the step system. Shifting a swing foot toward the sticker
  // and letting go at touchdown made it land off target and snap back while
  // planted (7.5 px slip in the live replay), so the fitted feet are only
  // used for the fit check, never written onto the posed figure.
  return posed;
}

// Cache fits per dancer; refit only when the contour really changes.
export function createStickerPoseCache() {
  const memo = new Map();
  return {
    fit(id, contour, cx) {
      if (!contour || contour.length < 6) return null;
      const b = bounds(contour);
      const sig = Math.round(b.top) + ':' + Math.round(b.bottom) + ':' + Math.round(b.left) + ':' + Math.round(b.right) + ':' + contour.length;
      const m = memo.get(id);
      if (m && m.sig === sig) return m.fit;
      const f = fitStickerPose(contour, cx);
      if (memo.size > 256) memo.clear();
      memo.set(id, {sig, fit: f});
      return f;
    },
    clear() { memo.clear(); },
  };
}
