// Synthetic sticker figures for the sticker-pose tests: capsule limbs on a
// mask from known joints, then traced like the camera scan does.
import {traceContour, sanitizeContour} from '../neural-dance/src/silhouette.js';

export const POSES = {
  // Joints as [x, y] in figure-height units, x right of the axis, y from the top.
  armsDown: {hand: [[-0.14, 0.48], [0.14, 0.48]], elbow: [[-0.13, 0.34], [0.13, 0.34]], foot: [[-0.07, 0.99], [0.07, 0.99]]},
  armsUp: {hand: [[-0.17, -0.06], [0.17, -0.06]], elbow: [[-0.17, 0.07], [0.17, 0.07]], foot: [[-0.08, 0.99], [0.08, 0.99]]},
  tPose: {hand: [[-0.42, 0.20], [0.42, 0.20]], elbow: [[-0.26, 0.20], [0.26, 0.20]], foot: [[-0.09, 0.99], [0.09, 0.99]]},
  // TJ's spread dancing sticker: arms out and up, legs wide.
  dancing: {hand: [[-0.36, 0.02], [0.36, 0.02]], elbow: [[-0.24, 0.12], [0.24, 0.12]], foot: [[-0.2, 0.99], [0.2, 0.99]]},
  oneUp: {hand: [[-0.16, -0.06], [0.14, 0.48]], elbow: [[-0.17, 0.07], [0.13, 0.34]], foot: [[-0.07, 0.99], [0.12, 0.99]]},
};

export function figureJoints(name, H, cx, top) {
  const p = POSES[name];
  const P = ([x, y]) => ({x: cx + x * H, y: top + y * H});
  const j = {
    head: P([0, 0.07]), neck: P([0, 0.14]), shL: P([-0.105, 0.19]), shR: P([0.105, 0.19]),
    hipL: P([-0.075, 0.52]), hipR: P([0.075, 0.52]),
    elL: P(p.elbow[0]), elR: P(p.elbow[1]), handL: P(p.hand[0]), handR: P(p.hand[1]),
    footL: P(p.foot[0]), footR: P(p.foot[1]),
  };
  j.kneeL = {x: (j.hipL.x + j.footL.x) / 2, y: top + 0.76 * H};
  j.kneeR = {x: (j.hipR.x + j.footR.x) / 2, y: top + 0.76 * H};
  j.height = H;
  return j;
}

export function stickerContour(name, {H = 180, cx = 200, top = 40, W = 420, Hh = 300} = {}) {
  const j = figureJoints(name, H, cx, top);
  const mask = new Uint8Array(W * Hh);
  const disc = (x, y, r) => {
    for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue;
      if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) mask[yy * W + xx] = 1;
    }
  };
  const cap = (a, b, r) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)) + 1; for (let i = 0; i <= n; i++) disc(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, r); };
  disc(j.head.x, j.head.y, 0.068 * H);
  cap(j.head, {x: cx, y: j.shL.y + 2}, 0.03 * H);
  // torso
  for (let y = j.shL.y; y <= j.hipL.y; y++) { const u = (y - j.shL.y) / (j.hipL.y - j.shL.y); const half = (0.11 * (1 - u) + 0.085 * u) * H; for (let x = cx - half; x <= cx + half; x++) disc(x, y, 0.6); }
  cap(j.shL, j.elL, 0.028 * H); cap(j.elL, j.handL, 0.024 * H); disc(j.handL.x, j.handL.y, 0.03 * H);
  cap(j.shR, j.elR, 0.028 * H); cap(j.elR, j.handR, 0.024 * H); disc(j.handR.x, j.handR.y, 0.03 * H);
  cap(j.hipL, j.kneeL, 0.04 * H); cap(j.kneeL, j.footL, 0.032 * H);
  cap(j.hipR, j.kneeR, 0.04 * H); cap(j.kneeR, j.footR, 0.032 * H);
  // Seed at the first filled pixel in raster order, like blank-scan does.
  let seed = null;
  for (let i = 0; i < mask.length && !seed; i++) if (mask[i]) seed = {x: i % W, y: Math.floor(i / W)};
  const raw = traceContour(mask, W, Hh, seed, 100000);
  const contour = sanitizeContour(traceContour(mask, W, Hh, seed), 64); // live default: 48 points
  return {contour, raw, joints: j};
}
