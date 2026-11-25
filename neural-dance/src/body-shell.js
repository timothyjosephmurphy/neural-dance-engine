// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Transparent 3D body shell — the exact painter the side sim uses
// (tapered limb chains, volumetric torso, key-light shading). Live and
// the official sim both import this so the figure cannot drift.
//
// Pose is already in pixel space (`placePose` or the sim's unit×height).
// `lod: 'cheap'` skips the volumetric torso stations and uses a flatter
// path so 24 small seed sims stay on the iPhone 13 budget.

import {rotateFacing, yawExtent} from './skeleton-motion.js';

export const KEY_LIGHT = (() => {
  const l = Math.hypot(-0.62, -0.48) || 1;
  return {x: -0.62 / l, y: -0.48 / l};
})();
export const FILL_FRONT = 'rgba(8, 10, 18, 0.92)';
export const FILL_BACK = 'rgba(3, 4, 9, 0.94)';

function ellipse(g, x, y, rx, ry, rot, a0, a1) {
  const aStart = a0 || 0;
  const aEnd = a1 == null ? Math.PI * 2 : a1;
  const native = g.ellipse;
  if (typeof native === 'function' && native !== ellipse) {
    native.call(g, x, y, rx, ry, rot || 0, aStart, aEnd);
    return;
  }
  if (typeof g.arc !== 'function') return;
  if (typeof g.save === 'function' && typeof g.translate === 'function' && typeof g.scale === 'function') {
    g.save();
    g.translate(x, y);
    if (rot) g.rotate(rot);
    g.scale(rx || 1, ry || 1);
    g.arc(0, 0, 1, aStart, aEnd);
    g.restore();
    return;
  }
  g.arc(x, y, Math.max(rx || 0, ry || 0), aStart, aEnd);
}

function withSave(g, fn) {
  if (typeof g.save === 'function') g.save();
  try { fn(); } finally { if (typeof g.restore === 'function') g.restore(); }
}


function lerpPt(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: (a.z || 0) + ((b.z || 0) - (a.z || 0)) * t
  };
}

function smoothEdge(g, arr) {
  const m = arr.length;
  if (m === 1) return;
  if (m === 2) { g.lineTo(arr[1].x, arr[1].y); return; }
  for (let i = 0; i < m - 1; i++) {
    const mx = (arr[i].x + arr[i + 1].x) * 0.5;
    const my = (arr[i].y + arr[i + 1].y) * 0.5;
    if (i === 0) g.lineTo(mx, my);
    else g.quadraticCurveTo(arr[i].x, arr[i].y, mx, my);
  }
  g.lineTo(arr[m - 1].x, arr[m - 1].y);
}

export function addTaperedChain(g, pts, radii) {
  if (!pts || pts.length < 2) return;
  const n = pts.length;
  const left = [], right = [];
  const tang = [];
  for (let i = 0; i < n; i++) {
    let tx, ty;
    if (i === 0) { tx = pts[1].x - pts[0].x; ty = pts[1].y - pts[0].y; }
    else if (i === n - 1) { tx = pts[i].x - pts[i - 1].x; ty = pts[i].y - pts[i - 1].y; }
    else { tx = pts[i + 1].x - pts[i - 1].x; ty = pts[i + 1].y - pts[i - 1].y; }
    const len = Math.hypot(tx, ty) || 1e-6;
    tang.push(Math.atan2(ty, tx));
    const nx = -ty / len, ny = tx / len;
    const r = Math.max(0.6, radii[i]);
    left.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r });
    right.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r });
  }
  g.moveTo(left[0].x, left[0].y);
  smoothEdge(g, left);
  const last = pts[n - 1], first = pts[0];
  g.arc(last.x, last.y, Math.max(0.6, radii[n - 1]), tang[n - 1] - Math.PI / 2, tang[n - 1] + Math.PI / 2);
  const rightRev = right.slice().reverse();
  smoothEdge(g, rightRev);
  g.arc(first.x, first.y, Math.max(0.6, radii[0]), tang[0] + Math.PI / 2, tang[0] - Math.PI / 2);
  g.closePath();
}

// Thigh volume (TJ Nov 10 4:10 PM, refined 7:54 PM): the hip joint is the
// OUTER attachment (greater trochanter). A natural inner-thigh gap is
// expected. Anatomical stations: widest at the top (~0.55–0.6 head), a
// slight inner and outer curve, a narrower knee, a calf bulge on the upper
// back third, then a slim ankle. Bone lengths are unchanged — only the
// shell radii and a small centerline offset change.
export function thighChain(pose, side, radiusFn) {
  const left = side < 0;
  const hip = left ? pose.hipL : pose.hipR;
  const knee = left ? pose.kneeL : pose.kneeR;
  const ankle = left ? (pose.ankleL || pose.footL) : (pose.ankleR || pose.footR);
  const jig = pose.jiggle || { thighL: 0, thighR: 0 };
  const jv = left ? (jig.thighL || 0) : (jig.thighR || 0);
  const h = pose.height || 200;
  const lw = (pose.b && pose.b.legW) || { hip: 0.038, knee: 0.022, ank: 0.016 };
  const s = typeof radiusFn === 'function' ? radiusFn : (u, z) => u * h;
  const topR = s(lw.hip || 0.038) + jv * h * 0.35;
  const kneeR = s(lw.knee || 0.022, knee && knee.z);
  const calfR = s(lw.calf || (lw.knee || 0.022) * 1.32, knee && knee.z);
  const ankR = s(lw.ank || 0.016, ankle && ankle.z);
  const out = left ? -1 : 1;
  const station = (a, b, t, r, ox = 0, bz = 0) => {
    const p = lerpPt(a, b, t);
    return { pt: { x: p.x + out * ox, y: p.y, z: p.z + bz }, r };
  };
  // ox is a slight outward curve (does not change the top radius / rest gap).
  // Calf bulge sits on the posterior upper third (negative z, facing the audience is +z).
  const seq = [
    station(hip, knee, 0.00, topR, 0),
    station(hip, knee, 0.16, topR * 0.97, h * 0.0035),
    station(hip, knee, 0.44, topR * 0.84, h * 0.0075),
    station(hip, knee, 0.80, kneeR * 1.12, h * 0.0025),
    station(hip, knee, 1.00, kneeR, 0),
    station(knee, ankle, 0.10, kneeR * 1.02, 0),
    station(knee, ankle, 0.32, calfR, h * 0.0015, -h * 0.012),
    station(knee, ankle, 0.62, (calfR + ankR) * 0.52, 0, -h * 0.004),
    station(knee, ankle, 1.00, ankR, 0)
  ];
  return {
    pts: seq.map(q => q.pt),
    r: seq.map(q => q.r),
    top: hip,
    hip,
    kneeR,
    calfR,
    ankR,
    topR
  };
}

// Upper arm: deltoid cap at the shoulder, then a bicep / tricep swell.
// Forearm: wider near the elbow, tapering to the wrist. Hand: a simple mitten.
export function armChain(pose, side, radiusFn) {
  const left = side < 0;
  const sh = left ? pose.shL : pose.shR;
  const el = left ? pose.elL : pose.elR;
  const wr = left ? (pose.wristL || pose.handL) : (pose.wristR || pose.handR);
  const hand = left ? pose.handL : pose.handR;
  const h = pose.height || 200;
  const aw = (pose.b && pose.b.armW) || { sh: 0.026, el: 0.018, wr: 0.013, hand: 0.011 };
  const s = typeof radiusFn === 'function' ? radiusFn : (u, z) => u * h;
  const delR = s(aw.del || (aw.sh || 0.026) * 1.28, sh && sh.z);
  const biR = s(aw.bi || (aw.sh || 0.026) * 1.10, el && el.z);
  const elR = s(aw.el || 0.018, el && el.z);
  const faR = s(aw.fa || (aw.el || 0.018) * 1.22, el && el.z);
  const wrR = s(aw.wr || 0.013, wr && wr.z);
  const palmR = s((aw.hand || 0.011) * 1.70, hand && hand.z);
  const tipR = s((aw.hand || 0.011) * 1.20, hand && hand.z);
  const inw = left ? 1 : -1; // palms face the thighs at rest
  const palm = lerpPt(wr, hand, 0.55);
  const mitten = {
    x: palm.x + inw * h * 0.004,
    y: palm.y,
    z: palm.z
  };
  const seq = [
    { pt: sh, r: delR },
    { pt: lerpPt(sh, el, 0.12), r: delR * 0.96 },
    { pt: lerpPt(sh, el, 0.28), r: (delR + biR) * 0.46 },
    { pt: lerpPt(sh, el, 0.50), r: biR },
    { pt: lerpPt(sh, el, 0.84), r: (biR + elR) * 0.52 },
    { pt: el, r: elR },
    { pt: lerpPt(el, wr, 0.12), r: faR },
    { pt: lerpPt(el, wr, 0.48), r: (faR + wrR) * 0.62 },
    { pt: wr, r: wrR },
    { pt: mitten, r: palmR },
    { pt: hand, r: tipR }
  ];
  return { pts: seq.map(q => q.pt), r: seq.map(q => q.r), delR, biR, elR, faR, wrR, palmR };
}

// Closed foot: heel, arch, ball and toe around a sole that sits on the floor
// when planted and follows the heel / toe pivots otherwise (TJ Nov 10 7:55 PM).
export function footShape(pose, side, radiusFn) {
  const left = side < 0;
  const heel = left ? (pose.heelL || pose.footL) : (pose.heelR || pose.footR);
  const toe = left ? (pose.toeL || pose.footL) : (pose.toeR || pose.footR);
  const ankle = left ? (pose.ankleL || pose.footL) : (pose.ankleR || pose.footR);
  const contact = left ? pose.contactL : pose.contactR;
  const h = pose.height || 200;
  const lw = (pose.b && pose.b.legW) || { ank: 0.016, foot: 0.015 };
  const s = typeof radiusFn === 'function' ? radiusFn : (u, z) => u * h;
  const half = s(lw.foot || 0.015) * 1.55;          // ~0.35 head wide sole
  const heelW = half * 1.12;
  const ballW = half * 1.18;
  const toeW = half * 0.72;
  const ankR = s(lw.ank || 0.016, ankle && ankle.z);
  const hx = toe.x - heel.x, hy = toe.y - heel.y;
  const hz = (toe.z || 0) - (heel.z || 0);
  const horiz = Math.hypot(hx, hz) || 1e-6;
  const ax = hx / horiz, az = hz / horiz;
  const px = -az, pz = ax;
  const planted = (!contact || contact === 'flat') && Math.abs(hy) <= Math.max(1.2, 0.007 * h);
  const floorY = Number.isFinite(+pose.floorY) ? +pose.floorY : Math.max(heel.y, toe.y);
  const soleY = (t) => {
    if (planted) {
      const lo = Math.max(heel.y, toe.y);
      return (Math.abs(floorY - lo) <= Math.max(2, 0.012 * h)) ? floorY : lo;
    }
    return heel.y + hy * t;
  };
  const along = (t, back = 0) => ({
    x: heel.x + hx * t - ax * back,
    y: soleY(t),
    z: (heel.z || 0) + hz * t - az * back
  });
  const edge = (t, w, back = 0) => {
    const p = along(t, back);
    return { x: p.x + px * w, y: p.y, z: p.z + pz * w };
  };
  // When the foot is not planted, let the arch rise slightly above the chord.
  const archLift = planted ? 0 : Math.max(0.8, h * 0.008);
  const archL = edge(0.34, -heelW * 0.82);
  const archR = edge(0.34, heelW * 0.82);
  if (archLift) { archL.y -= archLift; archR.y -= archLift; }
  // Instep: 0.55 of the way heel -> toe. It used to be (heel.x + toe.x) * 0.55,
  // i.e. 1.1 x the absolute screen x, so the foot outline shot a pale wedge
  // sideways across the floor, longer the further right the dancer stood:
  // the 'shadows' on the right-hand Kick/Bass insets (TJ Nov 11 3:16 PM).
  const instep = {
    x: heel.x + hx * 0.55 + ax * half * 0.2,
    y: ankle.y * 0.42 + soleY(0.55) * 0.58,
    z: (heel.z || 0) + hz * 0.55
  };
  const heelBack = along(0, half * 0.9);
  const toeTip = along(1.08, -toeW * 0.35);
  const anklePt = { x: ankle.x - ax * ankR * 0.2, y: ankle.y, z: (ankle.z || 0) - az * ankR * 0.15 };
  // Sole around heel–arch–ball–toe, then up the heel counter to the ankle
  // and forward over the instep. closePath returns to the starting heel edge.
  const loop = [
    edge(0, -heelW, half * 0.35),
    archL,
    edge(0.72, -ballW),
    edge(1, -toeW, -toeW * 0.1),
    toeTip,
    edge(1, toeW, -toeW * 0.1),
    edge(0.72, ballW),
    archR,
    edge(0, heelW, half * 0.35),
    heelBack,
    anklePt,
    instep
  ];
  return {
    kind: 'foot',
    heel, toe, ankle,
    planted,
    floorY: soleY(0),
    sole: [along(0), along(0.34), along(0.72), along(1)],
    outline: loop,
    half, heelW, ballW, toeW
  };
}

// Readable feet (TJ Nov 11 5:46 PM: "it looks like it ends in balls at the
// ends of the legs"). The closed foot used to be filled only with the dark
// shell, so on the near-black floor it vanished and the legs read as ending
// in the ankle knobs. This pass draws each foot as a pale shape with a lit
// rim and a bright flat sole: heel bump, sole on the floor, ball and toe,
// along the heel -> toe (walking) direction. Lengthened along that axis so
// it reads as a foot at preview scale: in profile an elongated foot, facing
// front a short wedge (the axis is foreshortened there).
export const FOOT_READ_LENGTH = 1.32;      // drawn length / heel-toe chord (profile)
export const FOOT_READ_FILL = 'rgba(214, 222, 242, 0.30)';
export const FOOT_READ_RIM = 'rgba(228, 234, 250, 0.82)';
export const FOOT_READ_SOLE = 'rgba(246, 249, 255, 0.95)';

export function footReadShape(pose, side) {
  const sh = footShape(pose, side);
  if (!sh) return null;
  const h = +pose.height || 200;
  const heel = sh.heel, toe = sh.toe, ankle = sh.ankle || sh.heel;
  const hz0 = +heel.z || 0, tz0 = +toe.z || 0;
  const dx = toe.x - heel.x, dz = tz0 - hz0;
  const horiz = Math.hypot(dx, dz);
  const ax = horiz > 1e-6 ? dx / horiz : 0, az = horiz > 1e-6 ? dz / horiz : 1;
  const px = -az, pz = ax;
  const floor = sh.floorY;
  const ay = (toe.y - heel.y);
  const soleAt = (t) => ({
    x: heel.x + dx * t, z: hz0 + dz * t,
    y: sh.planted ? floor : heel.y + ay * t
  });
  // Ankle height over the sole; a foot needs some body even when the rig's
  // ankle sits low, so the top line never flattens to a sliver.
  const s30 = soleAt(0.3);
  const hA = Math.max(h * 0.022, s30.y - ankle.y);
  const k = FOOT_READ_LENGTH;
  const tBack = -0.10, tTip = 1 + (k - 1) * 0.85;
  const w = (t) => t < 0.15 ? sh.heelW * 0.92 : t < 0.8 ? sh.heelW + (sh.ballW - sh.heelW) * ((t - 0.15) / 0.65) : sh.ballW + (sh.toeW - sh.ballW) * Math.min(1, (t - 0.8) / (tTip - 0.8));
  const topH = (t) => {
    if (t <= 0.35) return hA * (t < 0 ? 0.55 : 0.55 + 0.45 * (t / 0.35));
    const u = Math.min(1, (t - 0.35) / (tTip - 0.35));
    return Math.max(h * 0.007, hA * (1 - u) * (1 - 0.35 * u) + hA * 0.16 * u);
  };
  const pts3 = [];
  const sole = [];
  for (const t of [tBack, 0, 0.2, 0.45, 0.7, 0.9, tTip - 0.12, tTip]) {
    const c = soleAt(t), ww = t === tTip ? w(t) * 0.55 : w(t);
    for (const sgn of [-1, 1]) {
      const q = {x: c.x + px * ww * sgn, y: c.y, z: c.z + pz * ww * sgn};
      pts3.push(q); sole.push(q);
    }
    const tw = ww * 0.55;
    for (const sgn of [-1, 1]) pts3.push({x: c.x + px * tw * sgn, y: c.y - topH(t), z: c.z + pz * tw * sgn});
  }
  pts3.push({x: ankle.x, y: ankle.y, z: +ankle.z || 0});
  const hull = convexHull2(pts3);
  // Sole: the two sole points farthest apart on screen (heel bump -> toe tip
  // in profile; across the wedge facing front).
  let a = sole[0], b = sole[1], best = -1;
  for (let i = 0; i < sole.length; i++) for (let j = i + 1; j < sole.length; j++) {
    const d = (sole[i].x - sole[j].x) ** 2 + (sole[i].y - sole[j].y) ** 2;
    if (d > best) { best = d; a = sole[i]; b = sole[j]; }
  }
  return {...sh, outline: hull, soleLine: [a, b], readLength: k, heelBack: soleAt(tBack), toeTip: soleAt(tTip), ankleH: hA};
}

function convexHull2(pts) {
  const p = pts.filter(q => Number.isFinite(q.x) && Number.isFinite(q.y)).map(q => ({x: q.x, y: q.y, z: q.z})).sort((a, b) => (Math.abs(a.x - b.x) > 1e-7 ? a.x - b.x : a.y - b.y));
  if (p.length < 3) return p;
  // Tolerance so near-collinear points drop the same way wherever the dancer
  // stands (the shell must shift rigidly with the dancer).
  let span = 1;
  for (const q of p) span = Math.max(span, Math.abs(q.x - p[0].x), Math.abs(q.y - p[0].y));
  const eps = span * span * 1e-7;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= eps) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= eps) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

export function paintFootRead(g, pose) {
  if (!g || !pose) return 0;
  const h = +pose.height || 200;
  const shapes = [];
  for (const side of [-1, 1]) {
    let sh = null;
    try { sh = footReadShape(pose, side); } catch (e) { sh = null; }
    if (sh && sh.outline && sh.outline.length >= 3) shapes.push(sh);
  }
  if (!shapes.length) return 0;
  // Both feet in one path: one fill, one rim stroke, one sole stroke (cheap
  // enough for 24+ seed sims on the iPhone 13).
  withSave(g, () => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    for (const sh of shapes) {
      const pts = sh.outline;
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.closePath();
    }
    g.fillStyle = FOOT_READ_FILL;
    g.fill();
    g.strokeStyle = FOOT_READ_RIM;
    g.lineWidth = Math.max(1, h * 0.0042);
    g.stroke();
    g.beginPath();
    for (const sh of shapes) { const [a, b] = sh.soleLine; g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
    g.strokeStyle = FOOT_READ_SOLE;
    g.lineWidth = Math.max(1.3, h * 0.006);
    g.stroke();
  });
  return shapes.length;
}

export function addFootPath(g, shape, scale = 1) {
  const outline = shape && shape.outline;
  if (!outline || outline.length < 3) return;
  const k = Number.isFinite(+scale) ? Math.max(0.2, Math.min(1, +scale)) : 1;
  const ankle = shape.ankle || outline[outline.length - 1];
  const midX = (shape.heel.x + shape.toe.x) * 0.5;
  const midY = (shape.floorY + ankle.y) * 0.5;
  const pts = k >= 0.999 ? outline : outline.map(p => ({
    x: midX + (p.x - midX) * k,
    y: midY + (p.y - midY) * k
  }));
  g.moveTo(pts[0].x, pts[0].y);
  smoothEdge(g, pts);
  g.closePath();
}

// Projected half-width of a body-local ellipse (halfW in x, halfD in z) after yaw.
// At 0° this is halfW; at ±90° it is halfD, so a chest of depth TORSO_CHEST_DEPTH
// × shoulder width never collapses to a line in profile.

// Resting torso profile: z0 along the facing axis, as a fraction of shoulder
// half-width (chest / waist) or hip half-width (hip / seat). A real standing
// spine is a mild S — slight chest, slight lumbar hollow, gentle seat. The
// previous values (chest 0.22, hip −0.12, seat −0.34) thrust the chest
// forward and scooped a deep indent into the backside
// (TJ Nov 11 6:50 PM: "straighten the spine to make it like a real spine").
export const TORSO_CHEST_Z = 0.10;   // * shW, modest pec / sternum (was 0.22)
export const TORSO_WAIST_Z = 0.02;   // * shW (was 0.05)
export const TORSO_HIP_Z = -0.05;    // * hipW, slight posterior (was −0.12)
export const TORSO_SEAT_Z = -0.14;   // * hipW, gentle glute (was −0.34)
// Chest size (TJ Nov 11 6:58 PM): a little slimmer, less barrel-shaped.
// Depth is half-depth as a fraction of shoulder half-width (was 0.65).
// Width is half-width in height units (was 0.108). Ribs stay wider than the waist.
export const TORSO_CHEST_DEPTH = 0.52; // * shW half-depth
export const TORSO_CHEST_W = 0.098;    // half-width (height units)
export const TORSO_WAIST_W = 0.068;    // unchanged; chest stays clearly wider

export function torsoStations(pose) {
  const h = pose.height || 200;
  const b = pose.b || {};
  const yaw = (pose.twist && pose.twist.facing) || 0;
  const jig = pose.jiggle || { gluteL: 0, gluteR: 0, thighL: 0, thighR: 0 };
  const shW = (b.shW || 0.125) * h;
  const chestW = (b.chestW || TORSO_CHEST_W) * h;
  const waistW = (b.waistW || TORSO_WAIST_W) * h;
  const neckW = (b.neckW || 0.038) * h;
  const hipW = (b.hipW || 0.09) * h;
  const del = (b.deltoid || 0.018) * h;
  const chestHalfD = TORSO_CHEST_DEPTH * shW;
  const pelvisHalfD = 0.70 * hipW;        // full pelvis depth = 0.70 × hip width
  const neck = pose.neck;
  const heart = pose.heart;
  const solar = pose.solar || { x: (pose.heart.x * 0.4 + pose.groin.x * 0.6), y: pose.heart.y * 0.4 + pose.groin.y * 0.6, z: ((pose.heart.z || 0) + (pose.groin.z || 0)) * 0.5 };
  const groin = pose.groin;
  const shMid = {
    x: (pose.shL.x + pose.shR.x) * 0.5,
    y: (pose.shL.y + pose.shR.y) * 0.5,
    z: ((pose.shL.z || 0) + (pose.shR.z || 0)) * 0.5,
  };
  const hipMid = {
    x: (pose.hipL.x + pose.hipR.x) * 0.5,
    y: (pose.hipL.y + pose.hipR.y) * 0.5,
    z: ((pose.hipL.z || 0) + (pose.hipR.z || 0)) * 0.5,
  };
  const station = (spine, halfW, halfD, z0, y) => {
    const mid = rotateFacing(0, z0, yaw);
    const ext = Math.max(1.2, yawExtent(halfW, halfD, yaw));
    return {
      xL: spine.x + mid.x - ext,
      xR: spine.x + mid.x + ext,
      midX: spine.x + mid.x,
      y: y != null ? y : spine.y,
      z: (spine.z || 0) + mid.z,
      ext, z0, halfW, halfD,
    };
  };
  const glute = (jig.gluteL + jig.gluteR) * 0.5 * h;
  const head = pose.head;
  const headR = (Number.isFinite(+pose.headR) && +pose.headR > 1)
    ? +pose.headR
    : ((pose.b && Number.isFinite(+pose.b.headR)) ? pose.b.headR * h : h * 0.066);
  // Chin sits on the neck (slight overlap so the head is not floating).
  const chinY = head && Number.isFinite(+head.y) ? (head.y + headR * 0.92) : (neck.y - h * 0.04);
  const chinX = head && Number.isFinite(+head.x) ? head.x : (neck && neck.x) || shMid.x;
  const chinZ = head && Number.isFinite(+head.z) ? +head.z : ((neck && neck.z) || 0);
  const headH = Math.max(headR * 2, h * 0.12);
  // Chin-to-shoulder-line ~0.3–0.4 head: nape/base of neck, then trapezius to acromion.
  const napeY = Math.min(shMid.y - h * 0.018, chinY + 0.36 * headH);
  return {
    yaw, shW, chestHalfD, pelvisHalfD, headH, chinY,
    chin:  station({x: chinX, y: chinY, z: chinZ}, neckW * 0.92, neckW * 0.82, 0.005 * shW, chinY),
    yoke:  station(neck, neckW * 1.05, neckW * 0.92, 0.015 * shW, napeY),
    neck:  station(neck, neckW, neckW * 0.90, 0.02 * shW, neck ? neck.y : (chinY + napeY) * 0.5),
    nape:  station(neck || shMid, neckW * 1.18, neckW, 0.03 * shW, napeY),
    sh:    station(shMid, shW + del, chestHalfD, 0.07 * shW, shMid.y),
    chest: station(heart, chestW, chestHalfD, TORSO_CHEST_Z * shW, heart.y),
    waist: station(solar, waistW, 0.55 * shW, TORSO_WAIST_Z * shW, solar.y),
    hip:   station(hipMid, hipW + glute * 0.6, pelvisHalfD, TORSO_HIP_Z * hipW, hipMid.y + glute * 0.15),
    // Shallow crotch only — never a skirt to the feet (TJ Nov 10 3:19 PM).
    seat:  station(groin, hipW * 0.78 + glute * 0.4, pelvisHalfD, TORSO_SEAT_Z * hipW, groin.y + Math.min(h * 0.03, h * 0.018 + glute * 0.35)),
  };
}

// Flank of the torso (nape -> shoulder -> chest -> waist -> hip) as C1-smooth
// quadratic pairs. TJ Nov 11 5:35 PM: "spiky chest again when it turns
// sideways ... it's the outline of the chest". In profile the chest station
// sits 0.22 shW forward of the spine, so it is the widest knot on the front
// flank; the old per-segment quads met there with a ~53 deg tangent break (and
// ~75 deg at the bare front shoulder, which the arm no longer covers in
// profile), so the outline came to a point. Each segment is now two quads
// whose shared mid point lies on the line between their controls, so the
// outline is C1 at every knot. Tangents are monotone (Fritsch-Carlson in y):
// a widest knot gets a vertical tangent, never an overshoot, and every
// control stays between its knots. Facing the audience the outline is the
// old one exactly (the trapezius / deltoid corner sits under the arm); the
// smooth flank blends in with |sin(yaw)|.
export const FLANK_SMOOTH_FROM = 0.08;
export const FLANK_SMOOTH_FULL = 0.55;
export function flankSmoothness(yaw) {
  const s = Math.abs(Math.sin(+yaw || 0));
  const t = Math.max(0, Math.min(1, (s - FLANK_SMOOTH_FROM) / (FLANK_SMOOTH_FULL - FLANK_SMOOTH_FROM)));
  return t * t * (3 - 2 * t);
}

// One flank, top to bottom. `prev` is the point before the first knot (the
// neck column), so the top tangent continues that straight line. `side` -1 /
// +1 only mirrors the trapezius control. Returns [{a, q1, m, q2, b}] per
// segment.
export function torsoFlank(prev, knots, side, p, h) {
  const n = knots.length;
  const [N, S, C, W, H] = knots;
  const o = side < 0 ? 1 : -1; // old right control used +0.05, left -0.05
  // Old (front-view) single-quad controls, kept exactly for p = 0.
  const front = [
    { x: N.x - (S.x - N.x) * 0.05 * o, y: N.y + (S.y - N.y) * 0.45 },
    { x: S.x, y: (S.y + C.y) * 0.5 },
    { x: (C.x + W.x) * 0.5, y: (C.y + W.y) * 0.5 },
    { x: (W.x + H.x) * 0.5, y: W.y + (H.y - W.y) * 0.55 },
  ];
  const segs = [];
  for (let i = 0; i < n - 1; i++) {
    const a = knots[i], b = knots[i + 1], q = front[i];
    segs.push({ a, b, q1: { x: (a.x + q.x) * 0.5, y: (a.y + q.y) * 0.5 }, q2: { x: (q.x + b.x) * 0.5, y: (q.y + b.y) * 0.5 } });
  }
  // Smooth flank needs y to increase down the flank; a folded torso keeps the
  // old outline rather than inventing tangents.
  const minDy = Math.max(0.5, h * 0.004);
  let ok = true;
  for (let i = 0; ok && i < n - 1; i++) if (!(knots[i + 1].y - knots[i].y > minDy)) ok = false;
  if (ok) {
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((knots[i + 1].x - knots[i].x) / (knots[i + 1].y - knots[i].y));
    const m = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const a = d[i - 1], b = d[i];
      m[i] = (a * b <= 0) ? 0 : 2 / (1 / a + 1 / b);
    }
    // Top: continue the neck column if it comes from above, limited like FC.
    let m0 = d[0];
    if (prev && knots[0].y - prev.y > minDy) m0 = (knots[0].x - prev.x) / (knots[0].y - prev.y);
    m[0] = (m0 * d[0] <= 0) ? 0 : Math.sign(d[0]) * Math.min(Math.abs(m0), 3 * Math.abs(d[0]));
    // Bottom (hip -> crotch corner stays): follow the last chord.
    m[n - 1] = d[n - 2];
    for (let i = 0; i < n - 1; i++) {
      const a = knots[i], b = knots[i + 1], dy = b.y - a.y;
      const s1 = { x: a.x + m[i] * dy / 3, y: a.y + dy / 3 };
      const s2 = { x: b.x - m[i + 1] * dy / 3, y: b.y - dy / 3 };
      const sg = segs[i];
      // The chest knot (index 2) is always C1 (it came to a point in some
      // front-view poses too); every other knot follows the profile blend.
      const w1 = i === 2 ? 1 : p, w2 = i + 1 === 2 ? 1 : p;
      sg.q1 = { x: sg.q1.x + (s1.x - sg.q1.x) * w1, y: sg.q1.y + (s1.y - sg.q1.y) * w1 };
      sg.q2 = { x: sg.q2.x + (s2.x - sg.q2.x) * w2, y: sg.q2.y + (s2.y - sg.q2.y) * w2 };
    }
  }
  for (const sg of segs) sg.m = { x: (sg.q1.x + sg.q2.x) * 0.5, y: (sg.q1.y + sg.q2.y) * 0.5 };
  return segs;
}

export function addTorsoPath(g, pose) {
  const h = pose.height || 200;
  const S = torsoStations(pose);
  const chinL = { x: S.chin.xL, y: S.chin.y }, chinR = { x: S.chin.xR, y: S.chin.y };
  const neckL = { x: S.neck.xL, y: S.neck.y }, neckR = { x: S.neck.xR, y: S.neck.y };
  const napeL = { x: (S.nape || S.yoke).xL, y: (S.nape || S.yoke).y };
  const napeR = { x: (S.nape || S.yoke).xR, y: (S.nape || S.yoke).y };
  const shL = { x: S.sh.xL, y: S.sh.y }, shR = { x: S.sh.xR, y: S.sh.y };
  const chestL = { x: S.chest.xL, y: S.chest.y }, chestR = { x: S.chest.xR, y: S.chest.y };
  const waistL = { x: S.waist.xL, y: S.waist.y }, waistR = { x: S.waist.xR, y: S.waist.y };
  const hipL = { x: S.hip.xL, y: S.hip.y }, hipR = { x: S.hip.xR, y: S.hip.y };
  const seat = { x: S.seat.midX, y: S.seat.y };
  const yoke = { x: S.yoke.midX, y: S.yoke.y };
  const p = flankSmoothness(S.yaw);
  // Visible neck column under the chin, tapering into the trapezius slope
  // down to the shoulders (TJ Nov 10 6:19 PM). The trapezius control is a
  // lerp from the nape toward the acromion, never (y + y) * k of absolute
  // screen y (headless "shrug", TJ Nov 11, live 2ed1636).
  const flankL = torsoFlank(neckL, [napeL, shL, chestL, waistL, hipL], -1, p, h);
  const flankR = torsoFlank(neckR, [napeR, shR, chestR, waistR, hipR], 1, p, h);
  g.moveTo(chinL.x, chinL.y);
  g.lineTo(neckL.x, neckL.y);
  g.lineTo(napeL.x, napeL.y);
  for (const sg of flankL) {
    g.quadraticCurveTo(sg.q1.x, sg.q1.y, sg.m.x, sg.m.y);
    g.quadraticCurveTo(sg.q2.x, sg.q2.y, sg.b.x, sg.b.y);
  }
  // Hip → seat → hip is C1 at both hips so the backside is a gentle glute,
  // not a 75–100° indent (TJ Nov 11 6:50 PM). Midpoints sit on the control
  // chords, same construction as the smooth flank.
  {
    const lastL = flankL[flankL.length - 1];
    const lastR = flankR[flankR.length - 1];
    const unit = (t) => {
      const L = Math.hypot(t.x, t.y) || 1;
      return {x: t.x / L, y: t.y / L};
    };
    const inL = unit({x: hipL.x - lastL.q2.x, y: hipL.y - lastL.q2.y});
    const outR = unit({x: lastR.q2.x - hipR.x, y: lastR.q2.y - hipR.y});
    const bottom = {x: seat.x, y: seat.y};
    const alongH = unit({x: hipR.x - hipL.x, y: hipR.y - hipL.y});
    const dL = Math.hypot(bottom.x - hipL.x, bottom.y - hipL.y);
    const dR = Math.hypot(hipR.x - bottom.x, hipR.y - bottom.y);
    const kL = dL / 3, kR = dR / 3;
    const capY = (p) => ({x: p.x, y: Math.min(p.y, bottom.y)});
    const qL = capY({x: hipL.x + inL.x * kL, y: hipL.y + inL.y * kL});
    const qLB = {x: bottom.x - alongH.x * kL, y: bottom.y - alongH.y * kL};
    const qRB = {x: bottom.x + alongH.x * kR, y: bottom.y + alongH.y * kR};
    const qR = capY({x: hipR.x - outR.x * kR, y: hipR.y - outR.y * kR});
    const mL = {x: (qL.x + qLB.x) * 0.5, y: (qL.y + qLB.y) * 0.5};
    const mR = {x: (qR.x + qRB.x) * 0.5, y: (qR.y + qRB.y) * 0.5};
    g.quadraticCurveTo(qL.x, qL.y, mL.x, mL.y);
    g.quadraticCurveTo(qLB.x, qLB.y, bottom.x, bottom.y);
    g.quadraticCurveTo(qRB.x, qRB.y, mR.x, mR.y);
    g.quadraticCurveTo(qR.x, qR.y, hipR.x, hipR.y);
  }
  for (let i = flankR.length - 1; i >= 0; i--) {
    const sg = flankR[i];
    g.quadraticCurveTo(sg.q2.x, sg.q2.y, sg.m.x, sg.m.y);
    g.quadraticCurveTo(sg.q1.x, sg.q1.y, sg.a.x, sg.a.y);
  }
  g.lineTo(neckR.x, neckR.y);
  g.lineTo(chinR.x, chinR.y);
  g.quadraticCurveTo(yoke.x, Math.min(yoke.y, chinL.y), chinL.x, chinL.y);
  g.closePath();
}

export function traceBody(g, pose) {
  const h = pose.height || 200;
  const s = (u) => u * h;
  addTorsoPath(g, pose);
  const armL = armChain(pose, -1, s);
  const armR = armChain(pose, 1, s);
  addTaperedChain(g, armL.pts, armL.r);
  addTaperedChain(g, armR.pts, armR.r);
  const thL = thighChain(pose, -1, s);
  const thR = thighChain(pose, 1, s);
  addTaperedChain(g, thL.pts, thL.r);
  addTaperedChain(g, thR.pts, thR.r);
  addFootPath(g, footShape(pose, -1, s));
  addFootPath(g, footShape(pose, 1, s));
  const rx = pose.headRx || pose.headR * 0.86;
  const ry = pose.headR;
  const hrot = pose.headRot || 0;
  g.moveTo(pose.head.x + rx, pose.head.y);
  ellipse(g, pose.head.x, pose.head.y, rx, ry, hrot, 0, Math.PI * 2);
  g.closePath();
}


function depthScale(z, h) {
  const u = (z || 0) / Math.max(8, (h || 200) * 0.08);
  return 1 + 0.48 * Math.max(-1.15, Math.min(1.15, u));
}
export function limbBundles(pose) {
  const h = pose.height || 200;
  const s = (u, z) => u * h * depthScale(z, h);
  const armL = armChain(pose, -1, s);
  const armR = armChain(pose, 1, s);
  const thL = thighChain(pose, -1, s);
  const thR = thighChain(pose, 1, s);
  return {
    armL: { pts: armL.pts, r: armL.r },
    armR: { pts: armR.pts, r: armR.r },
    legL: { pts: thL.pts, r: thL.r },
    legR: { pts: thR.pts, r: thR.r },
    footL: footShape(pose, -1, s),
    footR: footShape(pose, 1, s),
  };
}

function keyNormal(tx, ty) {
  const len = Math.hypot(tx, ty) || 1e-6;
  let nx = -ty / len, ny = tx / len;
  if (nx * KEY_LIGHT.x + ny * KEY_LIGHT.y < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}

function shadeCapsule(g, a, b, ra, rb, back) {
  const n = keyNormal(b.x - a.x, b.y - a.y);
  const rMid = Math.max(0.8, (ra + rb) * 0.5);
  const cx = (a.x + b.x) * 0.5, cy = (a.y + b.y) * 0.5;
  const ext = rMid + 1.5;
  const grad = g.createLinearGradient(
    cx + n.x * ext, cy + n.y * ext,
    cx - n.x * ext, cy - n.y * ext
  );
  const hi = back ? 0.07 : 0.14;
  const core = back ? 0.38 : 0.26;
  grad.addColorStop(0.00, `rgba(200, 218, 245, ${hi})`);
  grad.addColorStop(0.18, `rgba(150, 172, 205, ${hi * 0.32})`);
  grad.addColorStop(0.42, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.58, `rgba(0, 0, 0, ${core})`);
  grad.addColorStop(0.86, `rgba(0, 0, 0, ${core * 0.65})`);
  grad.addColorStop(1.00, `rgba(0, 0, 0, ${back ? 0.16 : 0.09})`);
  // Fill the capsule directly. clip()+save() is redundant (fill already
  // uses this path) and WebKit can throw on a degenerate clip, leaking
  // the save() for the rest of a long show.
  g.beginPath();
  addTaperedChain(g, [a, b], [ra, rb]);
  g.fillStyle = grad;
  g.fill();
}

function shadeChain(g, pts, radii, back) {
  for (let i = 0; i < pts.length - 1; i++) {
    shadeCapsule(g, pts[i], pts[i + 1], radii[i], radii[i + 1], back);
  }
}

function strokeKeyRim(g, pts, radii, back) {
  if (!pts || pts.length < 2) return;
  const edge = [];
  for (let i = 0; i < pts.length; i++) {
    let tx, ty;
    if (i === 0) { tx = pts[1].x - pts[0].x; ty = pts[1].y - pts[0].y; }
    else if (i === pts.length - 1) { tx = pts[i].x - pts[i - 1].x; ty = pts[i].y - pts[i - 1].y; }
    else { tx = pts[i + 1].x - pts[i - 1].x; ty = pts[i + 1].y - pts[i - 1].y; }
    const n = keyNormal(tx, ty);
    const r = Math.max(0.6, radii[i]);
    edge.push({ x: pts[i].x + n.x * r, y: pts[i].y + n.y * r });
  }
  withSave(g, () => {
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = back ? 'rgba(180, 200, 230, 0.07)' : 'rgba(205, 222, 245, 0.15)';
    g.lineWidth = Math.max(1.1, (radii[0] + radii[radii.length - 1]) * 0.16);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(edge[0].x, edge[0].y);
    for (let i = 1; i < edge.length; i++) g.lineTo(edge[i].x, edge[i].y);
    g.stroke();
  });
}

export function paintShadedLimb(g, bundle, back) {
  g.fillStyle = back ? FILL_BACK : FILL_FRONT;
  g.beginPath();
  if (bundle && bundle.kind === 'foot') addFootPath(g, bundle);
  else addTaperedChain(g, bundle.pts, bundle.r);
  g.fill();
  if (bundle && bundle.kind === 'foot') {
    if (bundle.sole && bundle.sole.length >= 2) {
      g.strokeStyle = back ? 'rgba(0, 0, 0, 0.18)' : 'rgba(0, 0, 0, 0.12)';
      g.lineWidth = Math.max(1, (bundle.half || 4) * 0.12);
      g.beginPath();
      g.moveTo(bundle.sole[0].x, bundle.sole[0].y);
      for (let i = 1; i < bundle.sole.length; i++) g.lineTo(bundle.sole[i].x, bundle.sole[i].y);
      g.stroke();
    }
  } else {
    shadeChain(g, bundle.pts, bundle.r, back);
    strokeKeyRim(g, bundle.pts, bundle.r, back);
  }
}

export function shadeTorsoAndHead(g, pose) {
  const h = pose.height || 200;
  g.fillStyle = FILL_FRONT;
  g.beginPath();
  addTorsoPath(g, pose);
  g.fill();
  const vol = torsoStations(pose);
  const mid = {
    x: vol.chest.midX,
    y: (pose.neck.y + pose.groin.y) * 0.5,
  };
  const ext = Math.max(h * 0.14, vol.chest.ext * 1.15, vol.sh.ext * 0.9);
  const grad = g.createLinearGradient(
    mid.x + KEY_LIGHT.x * ext, mid.y + KEY_LIGHT.y * ext,
    mid.x - KEY_LIGHT.x * ext, mid.y - KEY_LIGHT.y * ext
  );
  grad.addColorStop(0.00, 'rgba(200, 218, 245, 0.15)');
  grad.addColorStop(0.20, 'rgba(150, 172, 205, 0.05)');
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.62, 'rgba(0, 0, 0, 0.30)');
  grad.addColorStop(1.00, 'rgba(0, 0, 0, 0.12)');
  g.fillStyle = grad;
  g.beginPath();
  addTorsoPath(g, pose);
  g.fill();
  // Facing shade: nearer / front of the volume is lighter, far side darker,
  // with a thin rim on the occluding contour so profile reads as a solid body.
  const fwd = rotateFacing(0, 1, vol.yaw);
  const fx = mid.x + fwd.x * ext, fy = mid.y;
  const bx = mid.x - fwd.x * ext, by = mid.y;
  const fgrad = g.createLinearGradient(fx, fy, bx, by);
  fgrad.addColorStop(0.00, 'rgba(200, 218, 245, 0.10)');
  fgrad.addColorStop(0.28, 'rgba(0, 0, 0, 0)');
  fgrad.addColorStop(0.62, 'rgba(0, 0, 0, 0.16)');
  fgrad.addColorStop(1.00, 'rgba(0, 0, 0, 0.28)');
  g.fillStyle = fgrad;
  g.beginPath();
  addTorsoPath(g, pose);
  g.fill();
  withSave(g, () => {
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(205, 222, 245, 0.13)';
    g.lineWidth = Math.max(1.2, h * 0.006);
    g.beginPath();
    addTorsoPath(g, pose);
    g.stroke();
  });

  const rx = pose.headRx || pose.headR * 0.86;
  const ry = pose.headR;
  const hx = pose.head.x, hy = pose.head.y;
  const hrot = pose.headRot || 0;
  g.fillStyle = FILL_FRONT;
  g.beginPath();
  ellipse(g, hx, hy, rx, ry, hrot, 0, Math.PI * 2);
  g.fill();
  const heg = g.createLinearGradient(
    hx + KEY_LIGHT.x * rx, hy + KEY_LIGHT.y * ry,
    hx - KEY_LIGHT.x * rx, hy - KEY_LIGHT.y * ry
  );
  heg.addColorStop(0.00, 'rgba(200, 218, 245, 0.16)');
  heg.addColorStop(0.28, 'rgba(150, 172, 205, 0.05)');
  heg.addColorStop(0.55, 'rgba(0, 0, 0, 0.08)');
  heg.addColorStop(1.00, 'rgba(0, 0, 0, 0.22)');
  g.fillStyle = heg;
  g.beginPath();
  ellipse(g, hx, hy, rx, ry, hrot, 0, Math.PI * 2);
  g.fill();
  withSave(g, () => {
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(205, 222, 245, 0.14)';
    g.lineWidth = Math.max(1.1, rx * 0.10);
    const ang = Math.atan2(KEY_LIGHT.y, KEY_LIGHT.x) - hrot;
    g.beginPath();
    ellipse(g, hx, hy, rx, ry, hrot, ang - 0.95, ang + 0.95);
    g.stroke();
  });
}

export function paintTorsoHints(g, pose) {
  const h = pose.height || 200;
  withSave(g, () => {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  addTorsoPath(g, pose);
  g.clip();
  g.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  g.lineWidth = Math.max(0.8, h * 0.0036);
  const stern = { x: pose.heart.x, y: pose.heart.y - h * 0.015 };
  g.globalAlpha = 0.65;
  g.beginPath();
  g.moveTo(stern.x - h * 0.008, stern.y);
  g.quadraticCurveTo(pose.heart.x - h * 0.05, pose.heart.y + h * 0.012, pose.shL.x + h * 0.03, pose.heart.y + h * 0.018);
  g.stroke();
  g.beginPath();
  g.moveTo(stern.x + h * 0.008, stern.y);
  g.quadraticCurveTo(pose.heart.x + h * 0.05, pose.heart.y + h * 0.012, pose.shR.x - h * 0.03, pose.heart.y + h * 0.018);
  g.stroke();
  g.globalAlpha = 0.38;
  const solar = pose.solar || { x: pose.heart.x, y: pose.heart.y + h * 0.06 };
  g.beginPath();
  g.moveTo(solar.x - h * 0.055, solar.y);
  g.quadraticCurveTo(solar.x, solar.y + h * 0.012, solar.x + h * 0.055, solar.y);
  g.stroke();
  g.beginPath();
  g.moveTo(solar.x - h * 0.048, solar.y + h * 0.022);
  g.quadraticCurveTo(solar.x, solar.y + h * 0.032, solar.x + h * 0.048, solar.y + h * 0.022);
  g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(0, 0, 0, 0.13)';
  g.beginPath();
  ellipse(g, pose.hipL.x, pose.hipL.y + h * 0.016, h * 0.028, h * 0.020, 0.15, 0, Math.PI * 2);
  ellipse(g, pose.hipR.x, pose.hipR.y + h * 0.016, h * 0.028, h * 0.020, -0.15, 0, Math.PI * 2);
  g.fill();
  });
}

export function paintJointHints(g, pose) {
  const h = pose.height || 200;
  withSave(g, () => {
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  g.lineWidth = Math.max(0.9, h * 0.0038);
  g.globalAlpha = 0.5;
  for (const sh of [pose.shL, pose.shR]) {
    g.beginPath();
    g.arc(sh.x, sh.y, h * 0.022, Math.PI * 0.15, Math.PI * 0.95);
    g.stroke();
  }
  const crease = (joint, a, b) => {
    const tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    const w = h * 0.011;
    g.beginPath();
    g.moveTo(joint.x - nx * w, joint.y - ny * w);
    g.lineTo(joint.x + nx * w, joint.y + ny * w);
    g.stroke();
  };
  crease(pose.elL, pose.shL, pose.elL);
  crease(pose.elR, pose.shR, pose.elR);
  crease(pose.kneeL, pose.hipL, pose.kneeL);
  crease(pose.kneeR, pose.hipR, pose.kneeR);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(190, 210, 240, 0.10)';
  g.lineWidth = Math.max(1.2, h * 0.007);
  g.globalAlpha = 1;
  const ankleL = pose.ankleL || pose.footL;
  const ankleR = pose.ankleR || pose.footR;
  for (const [knee, ankle] of [[pose.kneeL, ankleL], [pose.kneeR, ankleR]]) {
    const n = keyNormal(ankle.x - knee.x, ankle.y - knee.y);
    const mid = { x: (knee.x + ankle.x) * 0.5, y: (knee.y + ankle.y) * 0.5 };
    g.beginPath();
    g.moveTo(knee.x + n.x * h * 0.012, knee.y + n.y * h * 0.012);
    g.lineTo(mid.x + n.x * h * 0.016, mid.y + n.y * h * 0.016);
    g.lineTo(ankle.x + n.x * h * 0.010, ankle.y + n.y * h * 0.010);
    g.stroke();
  }
  });
}

export function drawShadowFigure(g, pose, dancerOrOpts, lights, pulsePts, weight) {
  // Accept (g, pose, options) or the sim's (g, pose, dancer, lights, pulsePts, weight).
  let dancer = dancerOrOpts;
  if (dancerOrOpts && typeof dancerOrOpts === 'object' && (dancerOrOpts.lod || dancerOrOpts.skipBloom != null || (dancerOrOpts.lights != null && dancerOrOpts.x == null && dancerOrOpts.kind == null))) {
    const opt = dancerOrOpts;
    lights = opt.lights;
    pulsePts = opt.pulsePts;
    if (opt.weight != null) weight = opt.weight;
    dancer = opt.dancer;
  }

  // Live poses carry the head radius as a unit (b.headR); the side sim's
  // carry pixels (headR). Without this the head gradient threw on every live
  // frame (non-finite createLinearGradient), paintShadowFigure caught it and
  // fell back to the cheap stick capsules: no shell, no glow (TJ 1:17 PM).
  if (!(+pose.headR > 0)) {
    const hr = pose.b && +pose.b.headR > 0 ? +pose.b.headR * (pose.height || 200) : (pose.height || 200) * 0.06;
    pose = {...pose, headR: hr};
  }
  const hgt = pose.height || 200;
  const wgt = Number.isFinite(+weight) ? +weight : 0;
  // Free (unplanted) side sits slightly in front so overlaps read in depth.
  const tw = pose.twist || {};
  const zL = (tw.zShL || 0) + (tw.zHipL || 0);
  const zR = (tw.zShR || 0) + (tw.zHipR || 0);
  const leftFront = (tw.zShL != null || tw.zHipL != null) ? (zL >= zR) : (wgt >= 0);
  const bundles = limbBundles(pose);
  const backArm = leftFront ? bundles.armR : bundles.armL;
  const frontArm = leftFront ? bundles.armL : bundles.armR;
  const backLeg = leftFront ? bundles.legR : bundles.legL;
  const frontLeg = leftFront ? bundles.legL : bundles.legR;
  const backFoot = leftFront ? bundles.footR : bundles.footL;
  const frontFoot = leftFront ? bundles.footL : bundles.footR;

  const vopt = dancerOrOpts && typeof dancerOrOpts === 'object' && dancerOrOpts.lod ? dancerOrOpts : null;
  if (vopt && vopt.lod === 'full' && vopt.volume) {
    drawVolumeBody(g, pose, {glow: vopt.glow, flash: vopt.flash, pulses: vopt.pulses || pulsePts, torso: vopt.torso, order: [backArm, backLeg, backFoot, frontLeg, frontFoot, frontArm]});
    paintFootRead(g, pose);
    return;
  }

  withSave(g, () => {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // Contact shadow used to be a per-frame shadowBlur of the whole silhouette.
  // That blur is a CPU gaussian and is what made the sim hitch. The fill is
  // already near-black, so the body reads the same without it.
  g.fillStyle = FILL_FRONT;
  g.beginPath();
  traceBody(g, pose);
  g.fill();

  paintShadedLimb(g, backArm, true);
  paintShadedLimb(g, backLeg, true);
  if (backFoot) paintShadedLimb(g, backFoot, true);
  shadeTorsoAndHead(g, pose);
  paintTorsoHints(g, pose);
  paintShadedLimb(g, frontLeg, false);
  if (frontFoot) paintShadedLimb(g, frontFoot, false);
  paintShadedLimb(g, frontArm, false);
  paintJointHints(g, pose);
  });
  paintFootRead(g, pose);
  if (pose && pose.mittenThumb) paintMittenThumb(g, pose);
  const opt = dancerOrOpts && typeof dancerOrOpts === 'object' && dancerOrOpts.lod ? dancerOrOpts : null;
  if (opt && opt.lod === 'full' && opt.shellGlow !== false) {
    paintShellGlow(g, pose, {glow: opt.glow, flash: opt.flash, lights: lights || opt.lights, rim: opt.rim});
  }
}

// Thumb nub on the mitten, on the inner side of the forearm. Only when the
// pose asks for it (the side sim does). Live poses leave this off.
function paintMittenThumb(g, pose) {
  if (!g || !pose) return;
  const h = pose.height || 200;
  g.save();
  g.fillStyle = FILL_FRONT;
  for (const side of [-1, 1]) {
    const wr = side < 0 ? (pose.wristL || pose.handL) : (pose.wristR || pose.handR);
    const hd = side < 0 ? pose.handL : pose.handR;
    if (!wr || !hd || !Number.isFinite(+wr.x) || !Number.isFinite(+hd.x)) continue;
    const dx = hd.x - wr.x, dy = hd.y - wr.y;
    const len = Math.hypot(dx, dy) || 1;
    const inward = side < 0 ? 1 : -1;
    const px = -dy / len * inward, py = dx / len * inward;
    const x = wr.x + dx * 0.42 + px * h * 0.016;
    const y = wr.y + dy * 0.42 + py * h * 0.016;
    g.beginPath();
    g.arc(x, y, Math.max(1.6, h * 0.013), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

// Shell glow (TJ Nov 10 1:16 PM: "not really seeing the transparent shell
// with the glow"). Ported from the side sim (static/neural-dance/sim): chakra
// lights wrap the body from inside. Everything here is clipped to the body
// outline (no #828 blooms). A fine key-side rim line keeps the shell readable
// on a projector over the near-black floor; FILL_FRONT alone is invisible there.
export const SHELL_GLOW = 0.67;
export const SHELL_GLOW_FLOOR = 0.35;  // rest-level chakra light so the shell reads at defaults
export const SHELL_RIM_ALPHA = 0.42;
export const SHELL_CHAKRA_HUES = {root: 0, sacral: 28, solar: 52, heart: 125, throat: 205, thirdEye: 250, crown: 285};
const SHELL_CHAKRA_S = [['root', 0.0], ['sacral', 0.135], ['solar', 0.281], ['heart', 0.5], ['throat', 0.781], ['thirdEye', 0.917], ['crown', 1.0]];
const SHELL_REGION_R = {root: 0.16, sacral: 0.14, solar: 0.14, heart: 0.16, throat: 0.10, thirdEye: 0.11, crown: 0.12};

export function shellChakraLights(pose, flash = 0) {
  const groin = pose && pose.groin, head = pose && (pose.head || pose.crown);
  if (!groin || !head || !Number.isFinite(+groin.x) || !Number.isFinite(+head.x)) return [];
  const hgt = +pose.height || 100;
  const f = Math.max(0, Math.min(1, +flash || 0));
  return SHELL_CHAKRA_S.map(([id, s]) => ({
    id, hue: SHELL_CHAKRA_HUES[id],
    x: groin.x + (head.x - groin.x) * s,
    y: groin.y + (head.y - groin.y) * s,
    radius: SHELL_REGION_R[id] * hgt * 0.5,
    flash: f
  }));
}

// Semi-transparent volumetric body (TJ Nov 10 1:51 PM: "a semi-transparent
// three-dimensional body that's lit up by the pulses that flow through it").
// Replaces the dark FILL_FRONT look on the live stage and insets:
//  - a see-through cool tint (stage and chakra string show through),
//  - rounded shading per limb/torso: additive concentric passes, so each
//    cylinder has a brighter core falling off toward its edges,
//  - a fine key-side rim so the outline reads on a projector,
//  - inner light: the chakra column at rest, plus each traveling pulse
//    (legs, arms, string) as a local glow in its colour, and a torso-wide
//    bloom in the chakra colour when the pulse arrives in the torso.
// Everything after the tint is clipped to the body (no #828 blooms).
export const VOLUME_TINT = 'rgba(150, 172, 220, 0.16)';
export const VOLUME_PASSES = [[0.95, 0.09], [0.4, 0.13]]; // [width x diameter, alpha]: rounded core, edge falloff
export const VOLUME_RIM = 'rgba(196, 214, 248, 0.55)';
export const PULSE_LIGHT_R = 0.11;   // x height, local pulse glow radius
export const TORSO_LIGHT_R = 0.26;   // x height, arrival glow through the torso
export function chakraHueAt(s) {
  const u = Math.max(0, Math.min(1, +s || 0));
  for (let i = 1; i < SHELL_CHAKRA_S.length; i++) {
    const [ida, sa] = SHELL_CHAKRA_S[i - 1], [idb, sb] = SHELL_CHAKRA_S[i];
    if (u <= sb) {
      const t = (u - sa) / Math.max(1e-6, sb - sa);
      return SHELL_CHAKRA_HUES[ida] + (SHELL_CHAKRA_HUES[idb] - SHELL_CHAKRA_HUES[ida]) * t;
    }
  }
  return SHELL_CHAKRA_HUES.crown;
}
function volumeChain(g, bundle) {
  // Fill the anatomical outline (variable radius) so pulse light follows
  // the same limb volume as the tinted shell. Two fills per limb stays
  // cheap enough for 24 sims.
  if (!bundle) return;
  if (g.strokeStyle) g.fillStyle = g.strokeStyle;
  if (bundle.kind === 'foot' && bundle.outline) {
    for (const [wk, a] of VOLUME_PASSES) {
      g.globalAlpha = a;
      g.beginPath();
      addFootPath(g, bundle, wk);
      g.fill();
    }
    return;
  }
  if (!bundle.pts) return;
  const pts = bundle.pts.filter(Boolean), r = bundle.r;
  if (pts.length < 2) return;
  for (const [wk, a] of VOLUME_PASSES) {
    g.globalAlpha = a;
    g.beginPath();
    addTaperedChain(g, pts, r.map(v => Math.max(0.6, (+v || 0) * wk)));
    g.fill();
  }
}
export function drawVolumeBody(g, pose, {glow = SHELL_GLOW, flash = 0, pulses = null, torso = null, order = null} = {}) {
  const hgt = +pose.height || 100;
  const amt = Number.isFinite(+glow) ? Math.max(0, +glow) : SHELL_GLOW;
  const fl = Math.max(SHELL_GLOW_FLOOR, Math.min(1, +flash || 0));
  withSave(g, () => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Build the outline once (Path2D) for tint, clip and rim.
    const path = typeof Path2D === 'function' ? new Path2D() : null;
    if (path) traceBody(path, pose);
    const outline = () => { if (path) return path; g.beginPath(); traceBody(g, pose); return undefined; };
    g.fillStyle = VOLUME_TINT;
    { const o = outline(); o ? g.fill(o) : g.fill(); }
    if (typeof g.clip === 'function') { const o = outline(); o ? g.clip(o) : g.clip(); }
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgb(176, 196, 236)';
    // Torso tapers to the nape; a narrower neck column carries the head
    // so it sits on the neck instead of floating or fusing to the shoulders.
    const groin = pose.groin, neck = pose.neck || pose.head, head = pose.head;
    const shW = Math.hypot((pose.shR.x - pose.shL.x), (pose.shR.y - pose.shL.y)) || hgt * 0.22;
    const headR = (Number.isFinite(+pose.headR) && +pose.headR > 1) ? +pose.headR
      : ((pose.b && Number.isFinite(+pose.b.headR)) ? pose.b.headR * hgt : hgt * 0.066);
    const neckHalf = (pose.b && Number.isFinite(+pose.b.neckW) ? pose.b.neckW * hgt : headR * 0.47);
    const prevCap = g.lineCap;
    g.lineCap = 'butt';
    if (groin && neck) {
      const napeY = head ? Math.min(((pose.shL.y + pose.shR.y) * 0.5) - hgt * 0.018, head.y + headR * 0.92 + 0.36 * headR * 2) : neck.y;
      const nape = {x: neck.x, y: napeY, z: neck.z || 0};
      volumeChain(g, {pts: [groin, nape], r: [shW * 0.42, Math.max(neckHalf * 1.2, shW * 0.16)]});
      if (head) {
        const chin = {x: head.x, y: head.y + headR * 0.92, z: head.z || 0};
        volumeChain(g, {pts: [nape, neck, chin], r: [neckHalf * 1.18, neckHalf, neckHalf * 0.92]});
      }
    }
    g.lineCap = prevCap || 'round';
    const list = order || (() => { const b = limbBundles(pose); return [b.armL, b.legL, b.footL, b.legR, b.footR, b.armR]; })();
    for (const bundle of list) volumeChain(g, bundle);
    if (pose.head) volumeChain(g, {pts: [{x: pose.head.x, y: pose.head.y - 0.01}, pose.head], r: [pose.headR * 0.95, pose.headR * 0.95]});
    g.globalAlpha = 1;
    if (amt > 0 && typeof g.createRadialGradient === 'function' && groin && pose.head) {
      // Chakra column at rest: one gradient along the spine.
      const head = pose.head;
      const lin = typeof g.createLinearGradient === 'function' ? g.createLinearGradient(groin.x, groin.y, head.x, head.y) : null;
      if (lin) {
        const a = Math.min(1, (0.05 + 0.22 * fl) * amt);
        for (const [id, s0] of SHELL_CHAKRA_S) lin.addColorStop(s0, 'hsla(' + SHELL_CHAKRA_HUES[id] + ', 95%, 62%, ' + a.toFixed(3) + ')');
        g.strokeStyle = lin;
        g.lineWidth = shW * 0.55;
        g.lineCap = 'butt';
        g.beginPath(); g.moveTo(groin.x, groin.y); g.lineTo(head.x, head.y); g.stroke();
        g.lineCap = prevCap || 'round';
      }
      const light = (x, y, r, hue, a) => {
        if (!(a > 0.004) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'hsla(' + hue + ', 100%, 72%, ' + Math.min(1, a).toFixed(3) + ')');
        grad.addColorStop(0.45, 'hsla(' + hue + ', 95%, 60%, ' + Math.min(1, a * 0.45).toFixed(3) + ')');
        grad.addColorStop(1, 'hsla(' + hue + ', 90%, 50%, 0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      };
      const k = Math.max(0.6, amt / SHELL_GLOW);
      if (torso && torso.a > 0) light(torso.x, torso.y, TORSO_LIGHT_R * hgt, torso.hue, torso.a * k);
      if (Array.isArray(pulses)) for (const p of pulses) if (p) light(+p.x, +p.y, (p.r || PULSE_LIGHT_R) * hgt, Number.isFinite(+p.hue) ? +p.hue : 200, (Number.isFinite(+p.a) ? +p.a : 0.8) * k);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.strokeStyle = VOLUME_RIM;
    g.lineWidth = Math.max(1.2, hgt * 0.01) * 2;
    // Torso + head only. Stroking the compound traceBody path also strokes
    // the inner edge of each closed leg capsule, which reads as two thin
    // strands dropping from the groin to the feet (TJ Nov 10 3:19 PM).
    g.beginPath();
    addTorsoPath(g, pose);
    if (pose.head) {
      const rx = pose.headRx || (pose.headR || 0) * 0.86, ry = pose.headR || 0;
      if (ry > 0) {
        if (typeof g.ellipse === 'function') g.ellipse(pose.head.x, pose.head.y, rx, ry, pose.headRot || 0, 0, Math.PI * 2);
        else { g.moveTo(pose.head.x + rx, pose.head.y); g.arc(pose.head.x, pose.head.y, Math.max(rx, ry), 0, Math.PI * 2); }
      }
    }
    g.stroke();
  });
}

// Lite see-through body for small seed sims (TJ Nov 11 3:13 PM: sims drew as
// stick figures). Same anatomical outline, tint and rim as drawVolumeBody, but
// no clip, no per-limb concentric passes and no radial gradients, so 24+
// small sims stay inside the iPhone 13 frame budget.
export function drawVolumeBodyLite(g, pose, {glow = SHELL_GLOW, pulses = null, torso = null} = {}) {
  if (!g || !pose || !pose.groin || !pose.shL || !pose.shR) return false;
  const hgt = +pose.height || 100;
  const amt = Number.isFinite(+glow) ? Math.max(0, +glow) : SHELL_GLOW;
  if (!(+pose.headR > 0)) pose = {...pose, headR: (pose.b && +pose.b.headR > 0 ? +pose.b.headR : 0.066) * hgt};
  withSave(g, () => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Outline from the same limb chains (computed once) as traceBody.
    const b = limbBundles(pose);
    g.fillStyle = VOLUME_TINT;
    g.beginPath();
    addTorsoPath(g, pose);
    for (const c of [b.armL, b.armR, b.legL, b.legR]) if (c && c.pts && c.pts.length > 1) addTaperedChain(g, c.pts, c.r);
    if (b.footL) addFootPath(g, b.footL);
    if (b.footR) addFootPath(g, b.footR);
    if (pose.head) {
      const rx = pose.headRx || pose.headR * 0.86;
      g.moveTo(pose.head.x + rx, pose.head.y);
      ellipse(g, pose.head.x, pose.head.y, rx, pose.headR, pose.headRot || 0, 0, Math.PI * 2);
      g.closePath();
    }
    g.fill();
    // One soft core per limb (roundness cue), additive like the full body.
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(176, 196, 236, ' + VOLUME_PASSES[1][1] + ')';
    for (const bundle of [b.armL, b.legL, b.legR, b.armR]) {
      if (!bundle || !bundle.pts || bundle.pts.length < 2) continue;
      let r = 0;
      for (const x of bundle.r) r += +x || 0;
      g.lineWidth = Math.max(0.8, (r / bundle.r.length) * 2 * VOLUME_PASSES[1][0]);
      g.beginPath();
      g.moveTo(bundle.pts[0].x, bundle.pts[0].y);
      for (let i = 1; i < bundle.pts.length; i++) g.lineTo(bundle.pts[i].x, bundle.pts[i].y);
      g.stroke();
    }
    const head = pose.head;
    if (amt > 0 && head) {
      // Chakra column, one flat stroke in the heart hue.
      g.strokeStyle = 'hsla(' + SHELL_CHAKRA_HUES.heart + ', 95%, 62%, ' + Math.min(1, 0.12 * amt).toFixed(3) + ')';
      const shW = Math.hypot(pose.shR.x - pose.shL.x, pose.shR.y - pose.shL.y) || hgt * 0.22;
      g.lineWidth = shW * 0.4;
      g.beginPath(); g.moveTo(pose.groin.x, pose.groin.y); g.lineTo(head.x, head.y); g.stroke();
    }
    const k = Math.max(0.6, amt / SHELL_GLOW);
    const light = (x, y, r, hue, a) => {
      if (!(a > 0.004) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      g.fillStyle = 'hsla(' + hue + ', 100%, 66%, ' + Math.min(1, 0.3 * a).toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'hsla(' + hue + ', 100%, 74%, ' + Math.min(1, 0.5 * a).toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r * 0.45, 0, Math.PI * 2); g.fill();
    };
    if (torso && torso.a > 0) light(+torso.x, +torso.y, TORSO_LIGHT_R * hgt * 0.6, torso.hue, torso.a * k);
    if (Array.isArray(pulses)) for (const q of pulses) if (q) light(+q.x, +q.y, (q.r || PULSE_LIGHT_R) * hgt * 0.6, Number.isFinite(+q.hue) ? +q.hue : 200, (Number.isFinite(+q.a) ? +q.a : 0.8) * k);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = VOLUME_RIM;
    g.lineWidth = Math.max(1, hgt * 0.01) * 1.6;
    g.beginPath();
    addTorsoPath(g, pose);
    if (head) {
      const rx = pose.headRx || pose.headR * 0.86, ry = pose.headR;
      if (typeof g.ellipse === 'function') { g.moveTo(head.x + rx, head.y); g.ellipse(head.x, head.y, rx, ry, pose.headRot || 0, 0, Math.PI * 2); }
      else { g.moveTo(head.x + rx, head.y); g.arc(head.x, head.y, Math.max(rx, ry), 0, Math.PI * 2); }
    }
    g.stroke();
  });
  paintFootRead(g, pose);
  return true;
}

export function paintShellGlow(g, pose, {glow = SHELL_GLOW, flash = 0, lights = null, rim = true} = {}) {
  if (!g || !pose || typeof g.save !== 'function') return false;
  const hgt = +pose.height || 100;
  const amt = Number.isFinite(+glow) ? Math.max(0, +glow) : SHELL_GLOW;
  const list = Array.isArray(lights) && lights.length ? lights : shellChakraLights(pose, flash);
  g.save();
  try {
    g.beginPath();
    traceBody(g, pose);
    if (typeof g.clip === 'function') g.clip();
    g.globalCompositeOperation = 'lighter';
    if (amt > 0 && typeof g.createRadialGradient === 'function') {
      for (const L of list) {
        if (!L || !Number.isFinite(+L.x) || !Number.isFinite(+L.y)) continue;
        const fl = Math.max(SHELL_GLOW_FLOOR, Math.min(1, +L.flash || 0));
        const r = Math.max(2, (+L.radius || 0.06 * hgt) * (2.0 + 2.2 * fl));
        const a = Math.min(1, (0.06 + 0.40 * fl) * amt);
        const ox = KEY_LIGHT.x * r * 0.2, oy = KEY_LIGHT.y * r * 0.2;
        const x = L.x + ox, y = L.y + oy;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        const hue = Number.isFinite(+L.hue) ? +L.hue : 200;
        grad.addColorStop(0, 'hsla(' + hue + ', 95%, 70%, ' + a.toFixed(3) + ')');
        grad.addColorStop(0.4, 'hsla(' + hue + ', 90%, 58%, ' + (a * 0.45).toFixed(3) + ')');
        grad.addColorStop(1, 'hsla(' + hue + ', 85%, 50%, 0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (rim) {
      // Fine rim inside the outline (clip keeps the outer half off the floor).
      // Torso + head only — not the inner thigh edges of the leg capsules
      // (TJ Nov 10 3:19 PM: strands between the legs down to the feet).
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(178, 198, 238, ' + SHELL_RIM_ALPHA + ')';
      g.lineWidth = Math.max(1.2, hgt * 0.012) * 2;
      g.lineJoin = 'round';
      g.beginPath();
      addTorsoPath(g, pose);
      if (pose.head) {
        const rx = pose.headRx || (pose.headR || 0) * 0.86, ry = pose.headR || 0;
        if (ry > 0) {
          if (typeof g.ellipse === 'function') g.ellipse(pose.head.x, pose.head.y, rx, ry, pose.headRot || 0, 0, Math.PI * 2);
          else { g.moveTo(pose.head.x + rx, pose.head.y); g.arc(pose.head.x, pose.head.y, Math.max(rx, ry), 0, Math.PI * 2); }
        }
      }
      g.stroke();
    }
  } finally {
    g.restore();
  }
  return true;
}

// Map a live unit pose through `xy` (stage→screen) and paint the sim shell.
// Used by paintShadowFigure when lod is 'full'.
export function paintSimShell(ctx, pose, xy, options = {}) {
  if (!ctx || !pose) return false;
  const map = typeof xy === 'function' ? xy : (x, y) => ({x, y});
  const scale = Number.isFinite(+options.scale) && +options.scale > 0 ? +options.scale : 1;
  const placed = {b: pose.b, height: (pose.height || 80) * scale, twist: pose.twist, jiggle: pose.jiggle};
  for (const k of Object.keys(pose)) {
    if (k === 'b' || k === 'height' || k === 'twist' || k === 'jiggle') continue;
    const p = pose[k];
    if (!p || typeof p !== 'object' || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) {
      placed[k] = p;
      continue;
    }
    const q = map(p.x, p.y);
    placed[k] = {x: q.x, y: q.y};
    if (Number.isFinite(+p.z)) placed[k].z = +p.z * scale;
  }
  if (!placed.height) placed.height = (pose.height || 80) * scale;
  if (typeof ctx.save !== 'function' || typeof ctx.arc !== 'function') return false;
  const alpha = Number.isFinite(+options.alpha) ? Math.max(0, Math.min(1, +options.alpha)) : 1;
  ctx.save();
  if (alpha < 1 && typeof ctx.globalAlpha === 'number') ctx.globalAlpha = (ctx.globalAlpha || 1) * alpha;
  try {
    drawShadowFigure(ctx, placed, {weight: options.weight, lights: options.lights, pulsePts: options.pulsePts, skipBloom: true, lod: options.lod});
  } finally {
    ctx.restore();
  }
  return true;
}
