// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Jointed warp of a dancer's own filled silhouette.
// The joints only move contour points. Nothing here draws a stick figure.
// On a body beat the dancer shifts weight foot-to-foot (hips over the planted
// foot, free leg lightens/lifts). Envelope eases back to rest between beats.
// variationFor(id) keeps the shift and the sway a little different per dancer.
// A glowing bow arcs foot→groin→foot; foot-strikes send energy up the leg.

// Standing dancer in local pixels, head toward -y, feet toward +y, centered near 0.
// The sim places copies of this outline. A camera sticker uses its own contour instead.
export const DANCER_SILHOUETTE = [
  {x: 0, y: -46},
  {x: 6, y: -44},
  {x: 8, y: -38},
  {x: 6, y: -32},
  {x: 14, y: -30},
  {x: 24, y: -20},
  {x: 26, y: -8},
  {x: 18, y: -6},
  {x: 12, y: -22},
  {x: 10, y: -12},
  {x: 12, y: 8},
  {x: 14, y: 28},
  {x: 8, y: 42},
  {x: 3, y: 42},
  {x: 2, y: 16},
  {x: 0, y: 8},
  {x: -2, y: 16},
  {x: -3, y: 42},
  {x: -8, y: 42},
  {x: -14, y: 28},
  {x: -12, y: 8},
  {x: -10, y: -12},
  {x: -12, y: -22},
  {x: -18, y: -6},
  {x: -26, y: -8},
  {x: -24, y: -20},
  {x: -14, y: -30},
  {x: -6, y: -32},
  {x: -8, y: -38},
  {x: -6, y: -44}
];

export function dancerSilhouette() {
  return DANCER_SILHOUETTE.map(point => ({x: point.x, y: point.y}));
}

// Lithe per-dancer sim silhouette (TJ 5:18 PM): slender dancer build with
// long limbs, narrow waist, smooth curves — varied by id, never chunky/blocky.
export function uniqueDancerSilhouette(id) {
  const seed = id | 0;
  const [a, b, c] = hashUnit(seed);
  const [d, e, f] = hashUnit(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b));
  const [g, h, i] = hashUnit(Math.imul(seed + 17, 0xc2b2ae35));
  // Lithe base proportions (applied before per-id pose).
  const waist = 0.62 + a * 0.12;          // narrow waist
  const shoulder = 0.78 + b * 0.22;       // modest shoulders
  const hip = 0.72 + c * 0.18;            // slim hips
  const limbLen = 1.08 + d * 0.16;        // longer arms/legs
  const stance = 0.82 + e * 0.36;         // foot spacing
  const armSpread = (f - 0.5) * 0.55;     // arm angle (rad)
  const legSpread = (g - 0.5) * 0.32;
  const headTilt = (h - 0.5) * 0.28;
  const lean = (i - 0.5) * 0.12;
  const box = boundsOf(DANCER_SILHOUETTE);
  const cx = box.left + box.width * 0.5;
  const cy = box.top + box.height * 0.5;
  const leftShoulder = {x: box.left + box.width * 0.30, y: box.top + box.height * 0.20};
  const rightShoulder = {x: box.left + box.width * 0.70, y: box.top + box.height * 0.20};
  const pelvis = {x: cx, y: box.top + box.height * 0.50};
  const neck = {x: cx, y: box.top + box.height * 0.14};
  const slimmed = DANCER_SILHOUETTE.map(point => {
    const u = (point.x - box.left) / box.width;
    const v = (point.y - box.top) / box.height;
    const w = regionWeights(u, v);
    let x = point.x;
    let y = point.y;
    // Slenderize: pinch waist, slim torso, lengthen limbs vertically.
    const waistBand = Math.exp(-Math.pow((v - 0.42) / 0.12, 2));
    const widthScale =
      1
      - (1 - waist) * waistBand * 0.85
      + (shoulder - 1) * (w.leftArm + w.rightArm + w.torso * 0.35 + w.head * 0.1)
      + (hip - 1) * (w.leftLeg * 0.4 + w.rightLeg * 0.4 + w.torso * 0.25);
    x = cx + (x - cx) * Math.max(0.45, widthScale);
    // Lengthen legs and arms away from joints.
    if (w.leftLeg + w.rightLeg > 0.2) {
      y = pelvis.y + (y - pelvis.y) * limbLen;
    }
    if (w.leftArm + w.rightArm > 0.25) {
      const shoulderPivot = u < 0.5 ? leftShoulder : rightShoulder;
      const dx = x - shoulderPivot.x;
      const dy = y - shoulderPivot.y;
      x = shoulderPivot.x + dx * (0.9 + 0.25 * limbLen);
      y = shoulderPivot.y + dy * limbLen;
    }
    // Stance / limb spread.
    x = cx + (x - cx) * (1 + (stance - 1) * (w.leftLeg + w.rightLeg) * 0.9);
    const leftArm = rotateAround({x, y}, leftShoulder, armSpread * (0.7 + w.leftArm));
    const rightArm = rotateAround({x, y}, rightShoulder, -armSpread * (0.65 + w.rightArm));
    const leftLeg = rotateAround({x, y}, pelvis, legSpread * w.leftLeg);
    const rightLeg = rotateAround({x, y}, pelvis, -legSpread * 0.95 * w.rightLeg);
    const tilted = rotateAround({x, y}, neck, headTilt * w.head);
    x = x
      + w.leftArm * (leftArm.x - x)
      + w.rightArm * (rightArm.x - x)
      + w.leftLeg * (leftLeg.x - x)
      + w.rightLeg * (rightLeg.x - x)
      + w.head * (tilted.x - x);
    y = y
      + w.leftArm * (leftArm.y - y)
      + w.rightArm * (rightArm.y - y)
      + w.leftLeg * (leftLeg.y - y)
      + w.rightLeg * (rightLeg.y - y)
      + w.head * (tilted.y - y);
    x += lean * box.width * (w.torso * 0.75 + w.head * 0.5);
    return {x, y};
  });
  // Smooth organic outline: Chaikin subdivision (more vertices, soft curves).
  return smoothClosedContour(slimmed, 2);
}

// Chaikin corner-cutting on a closed polygon → soft dancer curves.
export function smoothClosedContour(points, passes = 2) {
  let pts = copyPoints(points);
  if (pts.length < 4) return pts;
  const nPass = Math.max(0, Math.min(4, passes | 0));
  for (let p = 0; p < nPass; p++) {
    const next = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75
      });
    }
    pts = next;
  }
  return pts;
}

function hashUnit(id) {
  let x = (Math.abs(id | 0) + 1) >>> 0;
  const out = [];
  for (let i = 0; i < 3; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0;
    out.push(x / 4294967296);
  }
  return out;
}

// lead is which way the first step travels. Scales stay near 1.
export function variationFor(id) {
  const [lead, step, sway] = hashUnit(id);
  const [phase] = hashUnit(Math.imul((id | 0) + 3, 0x27d4eb2d));
  return {
    lead: lead < 0.5 ? -1 : 1,
    stepScale: 0.75 + step * 0.5,
    swayScale: 0.7 + sway * 0.6,
    // Offset beat phase so sims don't twitch in lockstep (TJ 5:18 PM).
    phase: phase * Math.PI * 2
  };
}

// 1 on the beat, 0 once a full interval has passed. Flat at both ends.
export function beatEnvelope(elapsed, interval) {
  if (!(interval > 0) || !Number.isFinite(+elapsed)) return 0;
  if (elapsed <= 0) return 1;
  const t = elapsed / interval;
  if (t >= 1) return 0;
  const s = t * t * (3 - 2 * t);
  return 1 - s;
}

function clamp01(t) {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

// u,v are 0..1 inside the silhouette bounds. v = 0 is the head.
// Weights overlap so the outline stays one filled shape.
export function regionWeights(u, v) {
  const head = 1 - smoothstep(0.14, 0.28, v);
  const armBand = smoothstep(0.12, 0.22, v) * (1 - smoothstep(0.40, 0.56, v));
  const leftArm = armBand * (1 - smoothstep(0.22, 0.42, u));
  const rightArm = armBand * smoothstep(0.58, 0.78, u);
  const leg = smoothstep(0.50, 0.66, v);
  const leftLeg = leg * (1 - smoothstep(0.40, 0.55, u));
  const rightLeg = leg * smoothstep(0.45, 0.60, u);
  const torso = Math.max(0.001, (1 - head) * (1 - leg) * (1 - Math.max(leftArm, rightArm)));
  const sum = head + leftArm + rightArm + torso + leftLeg + rightLeg;
  return {
    head: head / sum,
    leftArm: leftArm / sum,
    rightArm: rightArm / sum,
    torso: torso / sum,
    leftLeg: leftLeg / sum,
    rightLeg: rightLeg / sum
  };
}

function boundsOf(points) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.y < top) top = point.y;
    if (point.x > right) right = point.x;
    if (point.y > bottom) bottom = point.y;
  }
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1e-6, right - left),
    height: Math.max(1e-6, bottom - top)
  };
}

function rotateAround(point, origin, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + c * dx - s * dy,
    y: origin.y + s * dx + c * dy
  };
}

function copyPoints(points) {
  const out = [];
  for (const point of points || []) {
    if (!point || !Number.isFinite(+point.x) || !Number.isFinite(+point.y)) continue;
    out.push({x: +point.x, y: +point.y});
  }
  return out;
}

// envelope 0 returns the same positions unless an explicit weight is passed.
// plantedSide: +1 = right foot planted, -1 = left foot planted.

// Ease-in (slow, then accelerating) — lands exactly at 1. Power 3–4, or expo.
export function easeInPower(t, power = 4) {
  const u = Math.max(0, Math.min(1, +t || 0));
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return Math.pow(u, power);
}

export function easeInExpo(t) {
  const u = Math.max(0, Math.min(1, +t || 0));
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return Math.pow(2, 10 * u - 10);
}

// Continuous planted weight from `from` → `to` in [-1, 1].
// First `hold` of the interval stays put (brief settle), then eases in and
// arrives at `to` exactly when t === 1 (the beat).
export function shiftWeight(from, to, t, options = {}) {
  const a = Math.max(-1, Math.min(1, +from || 0));
  const b = Math.max(-1, Math.min(1, +to || 0));
  const u = Math.max(0, Math.min(1, +t || 0));
  const hold = Math.max(0, Math.min(0.4, +options.hold || 0.12));
  const power = Math.max(2, Math.min(6, +options.power || 4));
  if (u <= hold) return a;
  const s = (u - hold) / Math.max(1e-6, 1 - hold);
  return a + (b - a) * easeInPower(s, power);
}

export function plantedSide(beatIndex, variation) {
  const lead = variation && Number.isFinite(+variation.lead) ? Math.sign(+variation.lead) || 1 : 1;
  return lead * (((beatIndex | 0) % 2 === 0) ? 1 : -1);
}

// Approximate left/right feet and groin from a standing silhouette contour.
export function footLandmarks(contour) {
  const clean = copyPoints(contour);
  if (clean.length < 3) return null;
  const box = boundsOf(clean);
  const midX = box.left + box.width * 0.5;
  const groinY = box.top + box.height * 0.52;
  const footBand = box.top + box.height * 0.88;
  let leftFoot = null;
  let rightFoot = null;
  let leftBest = Infinity;
  let rightBest = -Infinity;
  for (const p of clean) {
    if (p.y < footBand) continue;
    if (p.x <= midX && p.x < leftBest) {
      leftBest = p.x;
      leftFoot = {x: p.x, y: p.y};
    }
    if (p.x >= midX && p.x > rightBest) {
      rightBest = p.x;
      rightFoot = {x: p.x, y: p.y};
    }
  }
  // Fallback to box corners if contour is sparse.
  if (!leftFoot) leftFoot = {x: box.left + box.width * 0.28, y: box.bottom};
  if (!rightFoot) rightFoot = {x: box.left + box.width * 0.72, y: box.bottom};
  // Nudge feet to ground line for a stable bow base.
  leftFoot = {x: leftFoot.x, y: Math.max(leftFoot.y, box.bottom - box.height * 0.02)};
  rightFoot = {x: rightFoot.x, y: Math.max(rightFoot.y, box.bottom - box.height * 0.02)};
  const groin = {x: midX, y: groinY};
  return {leftFoot, rightFoot, groin, box};
}

// Curved bow from foot to foot through the groin; apex leans toward planted foot.
export function legBowPoints(contour, options = {}) {
  const marks = footLandmarks(contour);
  if (!marks) return null;
  const envelope = Math.max(0, Math.min(1, +options.envelope || 0));
  // Continuous weight in [-1, 1]; sign-only still works for older callers.
  const planted = Number.isFinite(+options.planted) ? Math.max(-1, Math.min(1, +options.planted)) : 1;
  const {leftFoot, rightFoot, groin, box} = marks;
  // Steady bow: lean follows weight, size does not pop with the envelope.
  const lean = box.width * 0.07 * planted;
  const drop = box.height * 0.035;
  const apex = {
    x: groin.x + lean,
    y: groin.y + drop
  };
  return {
    left: leftFoot,
    right: rightFoot,
    apex,
    groin,
    planted,
    envelope
  };
}

// Soft quadratic samples along the bow (for painting).
export function sampleLegBow(bow, segments = 16) {
  if (!bow || !bow.left || !bow.right || !bow.apex) return [];
  const n = Math.max(4, segments | 0);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * bow.left.x + 2 * u * t * bow.apex.x + t * t * bow.right.x,
      y: u * u * bow.left.y + 2 * u * t * bow.apex.y + t * t * bow.right.y,
      t
    });
  }
  return out;
}

// Foot-strike energy path: foot → root (leg) then root → crown (string s).
// progress 0..1: 0–0.38 travels the leg; 0.38–1 climbs the chakra string.
export function footStrikeTravel(progress) {
  const p = Math.max(0, Math.min(1, +progress || 0));
  if (p <= 0.38) {
    return {phase: 'leg', u: p / 0.38, stringS: -1};
  }
  const u = (p - 0.38) / 0.62;
  return {phase: 'string', u, stringS: u};
}

export function deformSilhouette(contour, options = {}) {
  const clean = copyPoints(contour);
  if (clean.length < 3) return clean;
  const envelope = +options.envelope || 0;
  const hasWeight = Number.isFinite(+options.weight);
  if (!(envelope > 0) && !hasWeight) return clean;
  const variation = options.variation || variationFor(options.id | 0);
  const beatIndex = options.beatIndex | 0;
  const box = boundsOf(clean);
  const planted = hasWeight
    ? Math.max(-1, Math.min(1, +options.weight))
    : plantedSide(beatIndex, variation);
  const phase = Number.isFinite(+variation.phase) ? +variation.phase : 0;
  const amount = hasWeight ? Math.max(0.7, envelope || 1) : envelope;
  const phased = amount * (0.82 + 0.18 * Math.cos(phase + beatIndex));
  const shiftAmp = box.width * 0.07 * (variation.stepScale || 1) * phased;
  const sway = 0.42 * (variation.swayScale || 1) * phased;
  const leftPivot = {x: box.left + box.width * 0.30, y: box.top + box.height * 0.24};
  const rightPivot = {x: box.left + box.width * 0.70, y: box.top + box.height * 0.24};
  const pelvis = {x: box.left + box.width * 0.5, y: box.top + box.height * 0.50};
  const armSign = planted >= 0 ? 1 : -1;
  return clean.map(point => {
    const u = (point.x - box.left) / box.width;
    const v = (point.y - box.top) / box.height;
    const weight = regionWeights(u, v);
    const rightAmt = (planted + 1) * 0.5;
    const leftAmt = 1 - rightAmt;
    const plantedW = weight.rightLeg * rightAmt + weight.leftLeg * leftAmt;
    const freeW = weight.leftLeg * rightAmt + weight.rightLeg * leftAmt;
    // Hips / torso / head sway over the planted foot.
    const hipLean = shiftAmp * planted * (
      weight.torso * 0.85
      + weight.head * 0.45
      + plantedW * 0.18
      - freeW * 0.12
    );
    // Free leg lightens and lifts; planted leg stays grounded (tiny settle).
    const freeLift = box.height * 0.045 * phased * freeW;
    const plantSettle = box.height * 0.008 * phased * plantedW;
    // Free foot tucks slightly inward (not a scissor open).
    const freeTuck = -planted * box.width * 0.025 * phased * freeW;
    let x = point.x + hipLean + freeTuck;
    let y = point.y - freeLift + plantSettle;
    // Soft arm sway (lithe, not twitchy).
    const spunLeft = rotateAround(point, leftPivot, sway * armSign * 0.9);
    const spunRight = rotateAround(point, rightPivot, -sway * 0.8 * armSign);
    x += weight.leftArm * (spunLeft.x - point.x) + weight.rightArm * (spunRight.x - point.x);
    y += weight.leftArm * (spunLeft.y - point.y) + weight.rightArm * (spunRight.y - point.y);
    // Tiny pelvis rotate toward planted for the bow feel.
    const spunPelvis = rotateAround({x, y}, pelvis, 0.12 * planted * phased * (weight.torso * 0.4 + plantedW * 0.3));
    x += (weight.torso * 0.35 + plantedW * 0.25) * (spunPelvis.x - x);
    y += (weight.torso * 0.35 + plantedW * 0.25) * (spunPelvis.y - y);
    return {x, y};
  });
}
