// Visible inner skeleton for the Neural Dance side simulation.
// Not wired into the live renderer in this PR — side sim first, pending preview.
//
// Bones follow the existing posed joints exactly (same rigid lengths).
// Soft bone-white base, lit by passing pulses (pulse hue glow).

import {TORSO_CHEST_W} from './body-shell.js';

export const BONE_WHITE = { r: 232, g: 226, b: 210 };
export const DEFAULT_ON = true;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, +v || 0)); }

function hypot2(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return Math.hypot(dx, dy);
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: ((a.z || 0) + ((b.z || 0) - (a.z || 0)) * t) };
}

function mid(a, b) { return lerp(a, b, 0.5); }

function perp(a, b, scale) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  return { x: -dy / d * scale, y: dx / d * scale };
}

function dir(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  return { x: dx / d, y: dy / d, d };
}

function along(pts) {
  if (!pts || pts.length < 2) return [];
  const out = [];
  let acc = 0;
  out.push({ ...pts[0], s: 0, acc: 0 });
  for (let i = 1; i < pts.length; i++) {
    acc += hypot2(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    out.push({ ...pts[i], acc });
  }
  const total = acc || 1;
  for (const p of out) p.s = p.acc / total;
  return out;
}

function sample(pts, t) {
  const u = clamp(t, 0, 1);
  if (!pts || !pts.length) return null;
  if (pts.length === 1) return { ...pts[0] };
  const path = along(pts);
  const target = u * path[path.length - 1].acc;
  for (let i = 1; i < path.length; i++) {
    if (path[i].acc >= target) {
      const span = path[i].acc - path[i - 1].acc || 1e-6;
      const lt = (target - path[i - 1].acc) / span;
      return lerp(path[i - 1], path[i], lt);
    }
  }
  return { ...path[path.length - 1] };
}

function tangentAt(pts, t) {
  const a = sample(pts, Math.max(0, t - 0.03));
  const b = sample(pts, Math.min(1, t + 0.03));
  if (!a || !b) return { x: 0, y: 1 };
  return dir(a, b);
}

/**
 * Named bone records, each anchored on the posed joints so lengths stay
 * identical to the current rigid rig. `kind` is used by tests and lighting.
 * `shape` selects how the painter draws the bone (no continuous spine rod).
 */
export function bonePolylines(pose) {
  if (!pose || !pose.hipL || !pose.shL) return [];
  const h = pose.height || 200;
  const head = pose.head, neck = pose.neck, crown = pose.crown || pose.head;
  const groin = pose.groin;
  const hipL = pose.hipL, hipR = pose.hipR;
  const kneeL = pose.kneeL, kneeR = pose.kneeR;
  const ankleL = pose.ankleL || pose.footL, ankleR = pose.ankleR || pose.footR;
  const heelL = pose.heelL || pose.footL, heelR = pose.heelR || pose.footR;
  const toeL = pose.toeL || pose.footL, toeR = pose.toeR || pose.footR;
  const shL = pose.shL, shR = pose.shR;
  const elL = pose.elL, elR = pose.elR;
  const wrL = pose.wristL || pose.handL, wrR = pose.wristR || pose.handR;
  const hdL = pose.handL, hdR = pose.handR;
  const pelvis = (pose.spine && pose.spine.pelvis) || mid(hipL, hipR);
  const lumbar = (pose.spine && pose.spine.lumbar) || lerp(pelvis, neck, 0.35);
  const thoracic = (pose.spine && pose.spine.thoracic) || lerp(pelvis, neck, 0.7);
  const heart = pose.heart || thoracic;
  const solar = pose.solar || lerp(heart, groin, 0.45);
  const shMid = mid(shL, shR);
  const bones = [];

  const add = (kind, pts, width, s, extra) => {
    const ok = (pts || []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
    if (ok.length < 1) return;
    bones.push({ kind, pts: ok, width: width || h * 0.01, s: s == null ? 0.5 : s, ...(extra || {}) });
  };

  // Spine curve used only to place discrete vertebrae (pelvis → base of skull).
  // Deliberately not painted as a continuous rod.
  const skullBase = crown && neck ? lerp(neck, crown, 0.55) : (crown || neck);
  const spinePts = [pelvis, lumbar, thoracic, neck, skullBase].filter(Boolean);

  // 14 separate vertebral bodies: 4 lumbar (largest), 5 thoracic, 5 cervical (smallest).
  // Regions are parameterized along the pelvis → skull-base curve, with gaps
  // between bodies so they cannot visually fuse into a rod.
  const regions = [
    { kind: 'lumbar', n: 4, t0: 0.06, t1: 0.36, w: 0.030, len: 0.018, layer: 2 },
    { kind: 'thoracic', n: 5, t0: 0.40, t1: 0.70, w: 0.022, len: 0.014, layer: 2 },
    { kind: 'cervical', n: 5, t0: 0.74, t1: 0.97, w: 0.018, len: 0.012, layer: 2 },
  ];
  for (const rg of regions) {
    for (let i = 0; i < rg.n; i++) {
      const u = rg.n === 1 ? 0.5 : i / (rg.n - 1);
      const t = rg.t0 + (rg.t1 - rg.t0) * u;
      const c = sample(spinePts, t);
      const tg = tangentAt(spinePts, t);
      if (!c) continue;
      add('vertebra', [c], h * rg.w, t, {
        shape: 'vertebra',
        region: rg.kind,
        bodyW: h * rg.w,
        bodyL: h * rg.len,
        tx: tg.x, ty: tg.y,
        layer: rg.layer,
      });
    }
  }

  // Ribcage sits on the CHEST only: clavicles / sternum down to the bottom of
  // the chest, well above the belly and pelvis, leaving an abdominal gap.
  const notch = { x: shMid.x, y: shMid.y - h * 0.010, z: shMid.z };
  const chestTop = notch;
  // Bottom of chest: a little below the heart, clearly above the solar plexus.
  // Reference for rib attachments: a little below the heart, clearly above
  // the solar plexus. The painted sternum ends at the last rib attach so it
  // does not hang a xiphoid tip below the costal margin.
  const chestBot = lerp(heart, solar, 0.12);
  const chestW = (pose.b && pose.b.chestW ? pose.b.chestW : TORSO_CHEST_W) * h;
  const shW = (pose.b && pose.b.shW ? pose.b.shW : 0.125) * h;
  // Fill the chest: upper ribs reach under the clavicles (just inside the
  // shell), lower ribs stay in the chest (not the waist) and leave a gap.
  // The costal margin is a rounded arch — never a sharp downward V / xiphoid
  // spike at the bottom of the cage (TJ, Nov 11 12:24 AM).
  const nRibs = 6;
  // A little slimmer than 0.94 / 0.70 so the cage isn't barrel-chested, but
  // still clearly wider than the waist (TJ Nov 11 6:58 PM).
  const topRx = shW * 0.88;
  const botRx = Math.max(chestW * 0.82, shW * 0.62);
  for (let i = 0; i < nRibs; i++) {
    const t = i / (nRibs - 1);
    const rx = topRx + (botRx - topRx) * t;
    const drop = h * (0.004 + 0.006 * t);
    // Last ribs attach short of the sternum tip and approach it from the side
    // so the infrasternal angle stays obtuse, not a pokey point.
    const attach = 0.08 + t * 0.70; // last pair at 0.78, not piled on the tip
    const sternumPt = lerp(chestTop, chestBot, attach);
    // Ribs attach to thoracic vertebrae (chest stretch of the spine curve).
    const back = sample(spinePts, 0.56 + t * 0.16);
    if (!back) continue;
    const approaches = {};
    for (const side of [-1, 1]) {
      const outer = {
        x: (sternumPt.x + back.x) * 0.5 + side * rx,
        y: (sternumPt.y + back.y) * 0.5 + drop,
        z: (sternumPt.z || 0),
      };
      const approach = {
        x: sternumPt.x + side * Math.max(h * 0.024, rx * 0.18),
        y: sternumPt.y,
        z: sternumPt.z || 0,
      };
      const pts = [back, outer];
      if (i >= nRibs - 2) pts.push(approach);
      // The last pair stops at the side approach instead of meeting at a
      // single downward tip. A shallow costal arch closes the margin.
      if (i < nRibs - 1) pts.push(sternumPt);
      if (i === nRibs - 1) approaches[side] = approach;
      add('rib', pts, h * (0.0065 - 0.001 * t), 0.50 + t * 0.08, {
        shape: 'rib',
        layer: 3,
      });
    }
    if (i === nRibs - 1 && approaches[-1] && approaches[1]) {
      const L = approaches[-1], R = approaches[1];
      const archMid = {
        x: (L.x + R.x) * 0.5,
        y: Math.max(L.y, R.y) + h * 0.003,
        z: L.z || 0,
      };
      add('costalArch', [L, archMid, R], h * 0.0055, 0.58, { shape: 'rib', layer: 3 });
    }
  }
  const lastAttach = lerp(chestTop, chestBot, 0.08 + 0.70);
  const sternumBot = { x: lastAttach.x, y: lastAttach.y + h * 0.002, z: lastAttach.z };
  add('sternum', [chestTop, sternumBot], h * 0.011, 0.55, { shape: 'shaft', midW: h * 0.009, endW: h * 0.008, headR: 0, tailR: h * 0.005, layer: 3 });

  // Pelvis: two iliac bowls cupping the hips, a sacral wedge, a short pubic arch.
  // Not a single crossbar. The hip–hip record is kept for joint tests and is
  // drawn as a thin sacral/pubic span under the bowls, not the main shape.
  const iliacCrestL = { x: hipL.x - h * 0.012, y: Math.min(hipL.y, pelvis.y) - h * 0.028 };
  const iliacCrestR = { x: hipR.x + h * 0.012, y: Math.min(hipR.y, pelvis.y) - h * 0.028 };
  const pubis = { x: groin.x, y: groin.y + h * 0.004 };
  add('pelvisBowl', [
    { x: pelvis.x - h * 0.008, y: pelvis.y - h * 0.012 },
    iliacCrestL,
    { x: hipL.x - h * 0.022, y: hipL.y - h * 0.006 },
    { x: hipL.x - h * 0.010, y: hipL.y + h * 0.016 },
    { x: (hipL.x + pubis.x) * 0.5, y: pubis.y + h * 0.004 },
    pubis,
  ], h * 0.012, 0.08, { shape: 'bowl', layer: 1 });
  add('pelvisBowl', [
    { x: pelvis.x + h * 0.008, y: pelvis.y - h * 0.012 },
    iliacCrestR,
    { x: hipR.x + h * 0.022, y: hipR.y - h * 0.006 },
    { x: hipR.x + h * 0.010, y: hipR.y + h * 0.016 },
    { x: (hipR.x + pubis.x) * 0.5, y: pubis.y + h * 0.004 },
    pubis,
  ], h * 0.012, 0.08, { shape: 'bowl', layer: 1 });
  add('sacrum', [
    { x: pelvis.x, y: pelvis.y - h * 0.018 },
    { x: pelvis.x - h * 0.016, y: pelvis.y + h * 0.008 },
    { x: pelvis.x, y: pelvis.y + h * 0.022 },
    { x: pelvis.x + h * 0.016, y: pelvis.y + h * 0.008 },
  ], h * 0.009, 0.08, { shape: 'bowl', closed: true, layer: 1 });
  add('pelvisCrossbar', [hipL, hipR], h * 0.007, 0.08, { shape: 'poly', layer: 1, faint: true });

  // Clavicle / shoulder girdle: shL → sternal notch → shR, slight upward bow.
  add('clavicle', [shL, { x: (shL.x + notch.x) * 0.5, y: notch.y - h * 0.006 }, notch], h * 0.010, 0.62, { shape: 'poly', layer: 4 });
  add('clavicle', [notch, { x: (shR.x + notch.x) * 0.5, y: notch.y - h * 0.006 }, shR], h * 0.010, 0.62, { shape: 'poly', layer: 4 });
  add('shoulderGirdle', [shL, shR], h * 0.004, 0.62, { shape: 'poly', layer: 4, faint: true });

  // Humerus: tapered shaft, large head at the shoulder, flared elbow knobs.
  const addHumerus = (sh, el) => {
    if (!sh || !el) return;
    add('humerus', [sh, el], h * 0.016, 0.55, {
      shape: 'shaft',
      midW: h * 0.011,
      endW: h * 0.015,
      headR: h * 0.016,   // humeral head
      tailR: h * 0.012,   // elbow
      layer: 5,
    });
  };
  addHumerus(shL, elL);
  addHumerus(shR, elR);

  // Twin radius + ulna, clearly separated, slight taper, knobs at the elbow.
  const splitFore = (el, wr, sign) => {
    if (!el || !wr) return;
    const o = perp(el, wr, h * 0.013 * sign);
    const ulnaA = { x: el.x + o.x * 0.55, y: el.y + o.y * 0.55 };
    const ulnaB = { x: wr.x + o.x * 0.85, y: wr.y + o.y * 0.85 };
    const radA = { x: el.x - o.x * 0.55, y: el.y - o.y * 0.55 };
    const radB = { x: wr.x - o.x * 0.85, y: wr.y - o.y * 0.85 };
    add('ulna', [ulnaA, ulnaB], h * 0.008, 0.5, {
      shape: 'shaft', midW: h * 0.0065, endW: h * 0.008, headR: h * 0.009, tailR: h * 0.006, layer: 5,
    });
    add('radius', [radA, radB], h * 0.0075, 0.5, {
      shape: 'shaft', midW: h * 0.006, endW: h * 0.0085, headR: h * 0.007, tailR: h * 0.0075, layer: 5,
    });
  };
  splitFore(elL, wrL, 1);
  splitFore(elR, wrR, -1);

  // Femur: large head in the hip bowl, tapered shaft, two condyles at the knee.
  const addFemur = (hip, kn) => {
    if (!hip || !kn) return;
    add('femur', [hip, kn], h * 0.018, 0.15, {
      shape: 'shaft',
      midW: h * 0.013,
      endW: h * 0.018,
      headR: h * 0.018,     // femoral head
      tailR: h * 0.014,     // condyles (painter splits them)
      condyles: true,
      layer: 5,
    });
  };
  addFemur(hipL, kneeL);
  addFemur(hipR, kneeR);

  // Twin tibia + fibula. Tibia is the thicker medial bone; fibula is thinner
  // and starts a little below the knee.
  const splitShin = (kn, an, sign) => {
    if (!kn || !an) return;
    const o = perp(kn, an, h * 0.013 * sign);
    const tg = dir(kn, an);
    const tibA = { x: kn.x + o.x * 0.25 + tg.x * h * 0.008, y: kn.y + o.y * 0.25 + tg.y * h * 0.008 };
    const tibB = { x: an.x + o.x * 0.35, y: an.y + o.y * 0.35 };
    const fibA = { x: kn.x - o.x * 0.85 + tg.x * h * 0.018, y: kn.y - o.y * 0.85 + tg.y * h * 0.018 };
    const fibB = { x: an.x - o.x * 1.05, y: an.y - o.y * 1.05 };
    add('tibia', [tibA, tibB], h * 0.010, 0.08, {
      shape: 'shaft', midW: h * 0.009, endW: h * 0.012, headR: h * 0.011, tailR: h * 0.008, layer: 5,
    });
    add('fibula', [fibA, fibB], h * 0.006, 0.08, {
      shape: 'shaft', midW: h * 0.0048, endW: h * 0.0055, headR: h * 0.0055, tailR: h * 0.005, layer: 5,
    });
  };
  splitShin(kneeL, ankleL, 1);
  splitShin(kneeR, ankleR, -1);

  // Kneecaps sit on the front of each knee joint.
  const addPatella = (hip, kn, an) => {
    if (!kn) return;
    const up = hip ? dir(kn, hip) : { x: 0, y: -1 };
    const c = { x: kn.x + up.x * h * 0.006, y: kn.y + up.y * h * 0.006 };
    add('kneecap', [c], h * 0.012, 0.12, {
      shape: 'patella', rx: h * 0.011, ry: h * 0.013, layer: 6,
    });
  };
  addPatella(hipL, kneeL, ankleL);
  addPatella(hipR, kneeR, ankleR);

  // Simple hand: palm + four finger rays + a thumb.
  const handBones = (wr, hd, outward) => {
    if (!wr || !hd) return;
    add('hand', [wr, hd], h * 0.008, 0.45, { shape: 'shaft', midW: h * 0.007, endW: h * 0.009, headR: 0, tailR: h * 0.006, layer: 5 });
    const vx = hd.x - wr.x, vy = hd.y - wr.y;
    const px = -vy * 0.22, py = vx * 0.22;
    for (let i = 0; i < 4; i++) {
      const t = (i - 1.5) / 2.2;
      const tip = { x: hd.x + vx * 0.45 + px * t, y: hd.y + vy * 0.45 + py * t };
      add('finger', [hd, tip], h * 0.0045, 0.42, { shape: 'poly', layer: 5 });
    }
    const thumb = { x: wr.x + vx * 0.45 + outward * py * 1.6, y: wr.y + vy * 0.45 + outward * -px * 1.6 };
    add('finger', [wr, thumb], h * 0.005, 0.42, { shape: 'poly', layer: 5 });
  };
  handBones(wrL, hdL, -1);
  handBones(wrR, hdR, 1);

  // Arch: calcaneus → midfoot → ball, then short toe rays inside the box
  // (not splayed claw lines perpendicular to the sole).
  const footBones = (an, heel, toe) => {
    if (!an || !heel || !toe) return;
    const along = (u) => ({
      x: heel.x + (toe.x - heel.x) * u,
      y: heel.y + (toe.y - heel.y) * u,
      z: ((heel.z || 0) + ((toe.z || 0) - (heel.z || 0)) * u),
    });
    const calcaneus = along(-0.06);
    const midFoot = along(0.45);
    const ball = along(0.82);
    add('calcaneus', [calcaneus, midFoot], h * 0.010, 0.02, { shape: 'shaft', midW: h * 0.011, endW: h * 0.008, headR: h * 0.009, tailR: 0, layer: 5 });
    add('foot', [midFoot, ball], h * 0.008, 0.02, { shape: 'shaft', midW: h * 0.009, endW: h * 0.007, headR: 0, tailR: 0, layer: 5 });
    const hx = toe.x - heel.x, hz = (toe.z || 0) - (heel.z || 0);
    const hy = toe.y - heel.y;
    const plen = Math.hypot(hx, hy) || 1;
    const sx = -hy / plen * h * 0.006, sy = hx / plen * h * 0.006;
    for (let i = 0; i < 3; i++) {
      const t = (i - 1) / 2;
      const root = { x: ball.x + sx * t, y: ball.y + sy * t, z: ball.z };
      const tip = { x: toe.x + sx * t * 0.6, y: toe.y + sy * t * 0.6, z: (toe.z || 0) };
      add('metatarsal', [root, tip], h * 0.004, 0.02, { shape: 'poly', layer: 5 });
    }
  };
  footBones(ankleL, heelL, toeL);
  footBones(ankleR, heelR, toeR);

  // Jaw record for tests; the painter draws the full skull (cranium + jaw + sockets).
  if (head && neck) {
    const jaw = lerp(head, neck, 0.62);
    add('jaw', [head, jaw], h * 0.008, 0.9, { shape: 'poly', layer: 7, skip: true });
  }

  return bones;
}

export function pulseGlowAt(x, y, pulses, lights, height) {
  const h = height || 200;
  let glow = 0, hue = 40, r = 0, g = 0, b = 0, w = 0;
  const consider = (px, py, strength, hueDeg, radius) => {
    if (!(strength > 0.02) || !Number.isFinite(px) || !Number.isFinite(py)) return;
    const d = Math.hypot(x - px, y - py);
    const u = strength * Math.max(0, 1 - d / Math.max(8, radius));
    if (u <= 0) return;
    const rad = ((hueDeg || 0) * Math.PI) / 180;
    r += u * (0.55 + 0.45 * Math.cos(rad));
    g += u * (0.45 + 0.40 * Math.cos(rad - 2.1));
    b += u * (0.40 + 0.45 * Math.cos(rad + 2.1));
    w += u;
    if (u > glow) { glow = u; hue = hueDeg || hue; }
  };
  for (const L of lights || []) {
    consider(L.x, L.y, (L.flash || L.pulse || 0) * 0.9, L.hue, (L.radius || 10) * 3.2);
  }
  for (const p of pulses || []) {
    consider(p.x, p.y, p.strength || 0, p.hue, h * 0.13);
  }
  return { glow: clamp(glow, 0, 1), hue, wr: w, r, g, b };
}

function cssBone(base, glow) {
  const u = clamp(glow.glow, 0, 1);
  const wr = glow.wr || u;
  let r = BONE_WHITE.r, g = BONE_WHITE.g, b = BONE_WHITE.b;
  if (wr > 0.01) {
    const pr = 255 * clamp(glow.r / wr, 0, 1);
    const pg = 255 * clamp(glow.g / wr, 0, 1);
    const pb = 255 * clamp(glow.b / wr, 0, 1);
    r = r + (pr - r) * Math.min(1, u * 1.15);
    g = g + (pg - g) * Math.min(1, u * 1.15);
    b = b + (pb - b) * Math.min(1, u * 1.15);
  }
  const a = 0.50 + 0.42 * u;
  return {
    stroke: `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${a})`,
    glow: u,
    hue: glow.hue,
    fill: `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.38 + 0.40 * u})`,
    fillSoft: `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.22 + 0.28 * u})`,
    r, g, b,
  };
}

function applyStyle(ctx, style, width) {
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.fill;
  if (width != null) ctx.lineWidth = width;
}

function strokePoly(ctx, pts, width, style) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = style.stroke;
  ctx.stroke();
}

function paintShaft(ctx, a, b, bone, style) {
  const midW = bone.midW || bone.width * 0.6;
  const endW = bone.endW || midW * 1.2;
  const headR = bone.headR || 0;
  const tailR = bone.tailR || 0;
  const tg = dir(a, b);
  const px = -tg.y, py = tg.x;
  const insetA = headR * 0.45;
  const insetB = tailR * 0.45;
  const a2 = { x: a.x + tg.x * insetA, y: a.y + tg.y * insetA };
  const b2 = { x: b.x - tg.x * insetB, y: b.y - tg.y * insetB };
  const midP = mid(a2, b2);
  const wA = endW * 0.85, wM = midW, wB = endW;
  ctx.beginPath();
  ctx.moveTo(a2.x + px * wA, a2.y + py * wA);
  ctx.quadraticCurveTo(midP.x + px * wM, midP.y + py * wM, b2.x + px * wB, b2.y + py * wB);
  ctx.lineTo(b2.x - px * wB, b2.y - py * wB);
  ctx.quadraticCurveTo(midP.x - px * wM, midP.y - py * wM, a2.x - px * wA, a2.y - py * wA);
  ctx.closePath();
  applyStyle(ctx, style, Math.max(0.8, bone.width * 0.45));
  ctx.fill();
  ctx.stroke();
  if (headR > 0.4) {
    ctx.beginPath();
    ctx.ellipse(a.x, a.y, headR, headR * 0.92, Math.atan2(tg.y, tg.x), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (tailR > 0.4) {
    if (bone.condyles) {
      const ox = px * tailR * 0.7, oy = py * tailR * 0.7;
      const cx = b.x - tg.x * tailR * 0.1, cy = b.y - tg.y * tailR * 0.1;
      ctx.beginPath();
      ctx.ellipse(cx + ox, cy + oy, tailR * 0.72, tailR * 0.62, Math.atan2(tg.y, tg.x), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx - ox, cy - oy, tailR * 0.72, tailR * 0.62, Math.atan2(tg.y, tg.x), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, tailR * 0.9, tailR * 0.8, Math.atan2(tg.y, tg.x), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function paintVertebra(ctx, bone, style) {
  const c = bone.pts[0];
  const w = bone.bodyW || bone.width;
  const len = bone.bodyL || w * 0.65;
  const ang = Math.atan2(bone.ty || 1, bone.tx || 0);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.ellipse(0, 0, len * 0.52, w * 0.52, 0, 0, Math.PI * 2);
  applyStyle(ctx, style, Math.max(0.8, w * 0.18));
  ctx.fill();
  ctx.stroke();
  // Short transverse processes so stacked bodies read as vertebrae, not beads.
  ctx.beginPath();
  ctx.moveTo(0, -w * 0.62);
  ctx.lineTo(0, w * 0.62);
  ctx.lineWidth = Math.max(0.7, w * 0.16);
  ctx.stroke();
  ctx.restore();
}

function paintBowl(ctx, pts, width, style, closed) {
  if (!pts || pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.closePath();
  ctx.fillStyle = style.fillSoft || style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = width;
  ctx.fill();
  ctx.stroke();
}

function paintSkull(ctx, pose, style, h) {
  const head = pose.head;
  if (!head || !Number.isFinite(head.x)) return;
  const rx = pose.headRx || pose.headR * 0.86 || h * 0.055;
  const ry = pose.headR || h * 0.064;
  const yaw = pose.headYaw || (pose.twist && pose.twist.headYaw) || 0;
  const rot = pose.headTilt || pose.headRot || 0;
  const yawK = Math.cos(yaw);
  // Keep the vault inside the head silhouette (the outer bezier is 1.18× crx).
  const crx = rx * (0.55 + 0.47 * Math.abs(yawK)) / 1.20;
  const cry = ry * 0.96;
  ctx.save();
  ctx.translate(head.x + Math.sin(yaw) * rx * 0.28, head.y);
  ctx.rotate(rot);
  applyStyle(ctx, style, Math.max(1.15, h * 0.0085));
  // Solid vault so the skull does not read as a hollow ring, even when a
  // pulse or the chakra string crosses the face.
  const solid = `rgba(${style.r | 0}, ${style.g | 0}, ${style.b | 0}, ${0.78 + 0.16 * style.glow})`;
  ctx.fillStyle = solid;

  // Cranium: egg-shaped vault, fuller at the top/back, not a circle.
  ctx.beginPath();
  ctx.moveTo(0, -cry * 1.12);
  ctx.bezierCurveTo(crx * 1.05, -cry * 1.12, crx * 1.18, -cry * 0.15, crx * 0.95, cry * 0.18);
  ctx.bezierCurveTo(crx * 0.72, cry * 0.42, crx * 0.42, cry * 0.48, 0, cry * 0.46);
  ctx.bezierCurveTo(-crx * 0.42, cry * 0.48, -crx * 0.72, cry * 0.42, -crx * 0.95, cry * 0.18);
  ctx.bezierCurveTo(-crx * 1.18, -cry * 0.15, -crx * 1.05, -cry * 1.12, 0, -cry * 1.12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Mandible: a real jaw hanging from the sides, chin toward the neck.
  ctx.beginPath();
  ctx.moveTo(-crx * 0.82, cry * 0.18);
  ctx.quadraticCurveTo(-crx * 0.90, cry * 0.62, -crx * 0.46, cry * 1.02);
  ctx.quadraticCurveTo(0, cry * 1.26, crx * 0.46, cry * 1.02);
  ctx.quadraticCurveTo(crx * 0.90, cry * 0.62, crx * 0.82, cry * 0.18);
  ctx.quadraticCurveTo(crx * 0.35, cry * 0.48, 0, cry * 0.50);
  ctx.quadraticCurveTo(-crx * 0.35, cry * 0.48, -crx * 0.82, cry * 0.18);
  ctx.closePath();
  ctx.fillStyle = solid;
  ctx.fill();
  ctx.stroke();

  // Eye sockets (dark openings) and a small nasal cavity.
  const socket = (sx) => {
    ctx.beginPath();
    ctx.ellipse(sx, cry * 0.04, crx * 0.28, cry * 0.22, sx > 0 ? 0.12 : -0.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 14, 18, 0.78)';
    ctx.fill();
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = Math.max(0.7, h * 0.004);
    ctx.stroke();
  };
  socket(-crx * 0.36);
  socket(crx * 0.36);
  ctx.beginPath();
  ctx.moveTo(0, cry * 0.20);
  ctx.lineTo(-crx * 0.11, cry * 0.44);
  ctx.lineTo(crx * 0.11, cry * 0.44);
  ctx.closePath();
  ctx.fillStyle = 'rgba(16, 14, 18, 0.70)';
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function paintOne(ctx, bone, style) {
  if (bone.skip) return;
  const shape = bone.shape || 'poly';
  if (shape === 'shaft' && bone.pts.length >= 2) {
    paintShaft(ctx, bone.pts[0], bone.pts[bone.pts.length - 1], bone, style);
    return;
  }
  if (shape === 'vertebra') {
    paintVertebra(ctx, bone, style);
    return;
  }
  if (shape === 'patella') {
    const c = bone.pts[0];
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, bone.rx || bone.width, bone.ry || bone.width, 0, 0, Math.PI * 2);
    applyStyle(ctx, style, Math.max(0.8, bone.width * 0.35));
    ctx.fill();
    ctx.stroke();
    return;
  }
  if (shape === 'bowl') {
    paintBowl(ctx, bone.pts, Math.max(0.9, bone.width), style, bone.closed);
    return;
  }
  if (shape === 'rib' || shape === 'poly') {
    const w = bone.faint ? Math.max(0.6, bone.width * 0.55) : Math.max(0.8, bone.width);
    const st = bone.faint ? { ...style, stroke: style.stroke.replace(/[\d.]+\)$/, '0.28)') } : style;
    strokePoly(ctx, bone.pts, w, st);
  }
}

/**
 * Paint the inner skeleton, clipped by the caller to the body shell if desired.
 * Soft bone-white, with a light additive glow where pulses pass.
 */
export function paintInnerBones(ctx, pose, options = {}) {
  if (!ctx || !pose) return 0;
  const bones = bonePolylines(pose);
  if (!bones.length) return 0;
  const h = pose.height || 200;
  const pulses = options.pulses || [];
  const lights = options.lights || [];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const ordered = bones.slice().sort((a, b) => (a.layer || 5) - (b.layer || 5));
  let painted = 0;
  for (const bone of ordered) {
    if (bone.skip) continue;
    const midP = sample(bone.pts, 0.5) || bone.pts[0];
    const glow = pulseGlowAt(midP.x, midP.y, pulses, lights, h);
    const style = cssBone(BONE_WHITE, glow);
    paintOne(ctx, bone, style);
    if (style.glow > 0.14 && bone.shape !== 'vertebra') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * style.glow;
      paintOne(ctx, bone, style);
      ctx.restore();
    }
    painted++;
  }

  // Skull last, so the vault and sockets sit on top of the neck vertebrae.
  if (pose.head && Number.isFinite(pose.head.x)) {
    const glow = pulseGlowAt(pose.head.x, pose.head.y, pulses, lights, h);
    const style = cssBone(BONE_WHITE, glow);
    paintSkull(ctx, pose, style, h);
    if (style.glow > 0.08) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.40 * style.glow;
      paintSkull(ctx, pose, style, h);
      ctx.restore();
    }
    painted++;
  }

  ctx.restore();
  return painted;
}

/** Joint-endpoint check helper for tests: a bone of `kind` starts and ends on these joints. */
export function boneFollowsJoints(bones, kind, a, b, tol) {
  const list = (bones || []).filter(k => k.kind === kind);
  if (!list.length || !a || !b) return false;
  const t = tol == null ? 0.75 : +tol;
  return list.some(bone => {
    const p0 = bone.pts[0], p1 = bone.pts[bone.pts.length - 1];
    const d00 = hypot2(p0.x, p0.y, a.x, a.y) + hypot2(p1.x, p1.y, b.x, b.y);
    const d01 = hypot2(p0.x, p0.y, b.x, b.y) + hypot2(p1.x, p1.y, a.x, a.y);
    return Math.min(d00, d01) <= t * 2;
  });
}

const api = {
  BONE_WHITE, DEFAULT_ON,
  bonePolylines, pulseGlowAt, paintInnerBones, boneFollowsJoints,
};

export default api;

if (typeof globalThis !== 'undefined') {
  globalThis.NDInnerBones = api;
}
