// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import {applyHomography, lerp2, orderProjectorCorners, solveHomography} from './geometry.js';

// Painting surface (TJ Nov 11 3:41-3:51 PM). Finds the framed painting's black
// frame in a camera frame and returns its inner edge as a camera-space quad.
// That quad is the projection mask: alignment patterns, stickers and dancers
// stay inside it, and the show blacks out everything outside it.
//
// Method: dark, low-saturation pixels (dilated so projected light grazing the
// frame does not break the ring) -> largest connected dark component -> flood
// the non-dark pixels from the image border; what is left enclosed by that
// component is the painting interior. Corners are the extreme points of the
// interior along the two diagonals, refined by a least-squares line per side.

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export const FRAME_MIN_AREA = 0.04;   // interior share of the frame (camera)
export const FRAME_MAX_AREA = 0.85;

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

function lineFit(points) {
  // Total least squares line through points: returns {cx, cy, dx, dy}.
  let n = 0, sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; n++; }
  if (n < 2) return null;
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) { const a = p.x - cx, b = p.y - cy; xx += a * a; yy += b * b; xy += a * b; }
  const t = 0.5 * Math.atan2(2 * xy, xx - yy);
  return {cx, cy, dx: Math.cos(t), dy: Math.sin(t)};
}
function intersect(a, b) {
  if (!a || !b) return null;
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / den;
  return {x: a.cx + a.dx * t, y: a.cy + a.dy * t};
}

export function detectPaintingFrame(rgba, width, height, options = {}) {
  const w = width | 0, h = height | 0;
  if (!rgba || w < 16 || h < 16 || rgba.length < w * h * 4) return {ok: false, reason: 'no frame'};
  const step = Math.max(1, options.step | 0 || Math.round(Math.max(w, h) / 240));
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step), n = cols * rows;
  const L = new Float32Array(n), S = new Float32Array(n);
  const sorted = [];
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const x = Math.min(w - 1, gx * step), y = Math.min(h - 1, gy * step), p = (y * w + x) * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const i = gy * cols + gx;
    L[i] = lum(r, g, b);
    const mx = Math.max(r, g, b);
    S[i] = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
    sorted.push(L[i]);
  }
  sorted.sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const cut = Number.isFinite(+options.darkCut) ? +options.darkCut : Math.max(30, Math.min(100, median * 0.42));
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = L[i] <= cut ? 1 : 0;
  // Dilate twice (8-neighbour) to close small gaps from projected light.
  let m = dark;
  for (let k = 0; k < (options.dilate ?? 2); k++) {
    const o = new Uint8Array(n);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1 && !v; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < cols && Y < rows && m[Y * cols + X]) v = 1;
      }
      o[y * cols + x] = v;
    }
    m = o;
  }
  // Connected dark components; keep the one whose enclosed hole is largest.
  const label = new Int32Array(n).fill(-1);
  const comps = [];
  const q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!m[s] || label[s] >= 0) continue;
    const id = comps.length; let head = 0, tail = 0; q[tail++] = s; label[s] = id; let area = 0;
    while (head < tail) {
      const i = q[head++]; area++;
      const x = i % cols, y = (i / cols) | 0;
      if (x > 0 && m[i - 1] && label[i - 1] < 0) { label[i - 1] = id; q[tail++] = i - 1; }
      if (x < cols - 1 && m[i + 1] && label[i + 1] < 0) { label[i + 1] = id; q[tail++] = i + 1; }
      if (y > 0 && m[i - cols] && label[i - cols] < 0) { label[i - cols] = id; q[tail++] = i - cols; }
      if (y < rows - 1 && m[i + cols] && label[i + cols] < 0) { label[i + cols] = id; q[tail++] = i + cols; }
    }
    comps.push(area);
  }
  const order = comps.map((a, i) => [a, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(x => x[1]);
  let best = null;
  for (const id of order) {
    // Flood the complement of this component from the border.
    const out = new Uint8Array(n);
    let head = 0, tail = 0;
    const push = i => { if (!out[i] && label[i] !== id) { out[i] = 1; q[tail++] = i; } };
    for (let x = 0; x < cols; x++) { push(x); push((rows - 1) * cols + x); }
    for (let y = 0; y < rows; y++) { push(y * cols); push(y * cols + cols - 1); }
    while (head < tail) {
      const i = q[head++]; const x = i % cols, y = (i / cols) | 0;
      if (x > 0) push(i - 1); if (x < cols - 1) push(i + 1); if (y > 0) push(i - cols); if (y < rows - 1) push(i + cols);
    }
    const hole = [];
    for (let i = 0; i < n; i++) if (!out[i] && label[i] !== id) hole.push(i);
    const frac = hole.length / n;
    if (frac < (options.minArea ?? FRAME_MIN_AREA) || frac > FRAME_MAX_AREA) continue;
    if (!best || hole.length > best.hole.length) best = {id, hole};
  }
  if (!best) return {ok: false, reason: 'no enclosed frame found', median, cut};
  // Boundary points of the hole, then the 4 diagonal-extreme corners.
  const inHole = new Uint8Array(n);
  for (const i of best.hole) inHole[i] = 1;
  const edge = [];
  for (const i of best.hole) {
    const x = i % cols, y = (i / cols) | 0;
    if (!inHole[i - 1] || !inHole[i + 1] || !inHole[i - cols] || !inHole[i + cols]) edge.push({x: x * step, y: y * step});
  }
  const ext = (f, sign) => edge.reduce((b, p) => (b == null || sign * f(p) > sign * f(b) ? p : b), null);
  let tl = ext(p => p.x + p.y, -1), br = ext(p => p.x + p.y, 1), tr = ext(p => p.x - p.y, 1), bl = ext(p => p.x - p.y, -1);
  // Refine with a line per side from edge points between the coarse corners.
  const side = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const pts = edge.filter(p => {
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
      const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
      return t > 0.15 && t < 0.85 && d < Math.max(3 * step, len * 0.04);
    });
    return pts.length >= 4 ? lineFit(pts) : null;
  };
  // The dark mask was dilated, so the hole edge sits inside the real frame
  // edge. Push each side out past that dilation, plus a short step, so the
  // quad lands on the frame's inner edge instead of a painted edge inside it.
  const dilate = options.dilate ?? 2;
  const grow = dilate * step + Math.min(3, step * 0.5);
  const hc = {x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4};
  const outward = line => {
    if (!line) return null;
    let nx = -line.dy, ny = line.dx;
    if ((line.cx - hc.x) * nx + (line.cy - hc.y) * ny < 0) { nx = -nx; ny = -ny; }
    return {...line, cx: line.cx + nx * grow, cy: line.cy + ny * grow};
  };
  const top = outward(side(tl, tr)), right = outward(side(tr, br)), bottom = outward(side(br, bl)), left = outward(side(bl, tl));
  const refined = [intersect(left, top), intersect(top, right), intersect(right, bottom), intersect(bottom, left)];
  const coarse = [tl, tr, br, bl];
  const quad = refined.map((p, i) => (p && Math.hypot(p.x - coarse[i].x, p.y - coarse[i].y) < Math.max(w, h) * 0.08 ? p : coarse[i]))
    .map(p => ({x: Math.min(w, Math.max(0, p.x + step * 0.5)), y: Math.min(h, Math.max(0, p.y + step * 0.5))}));
  const area = quadArea(quad) / (w * h);
  return {ok: true, quad, area, median, cut, refined: refined.every(Boolean)};
}

// Under the white flash the black frame reads ~65 and the unlit wall can be
// as dark, so one cut does not fit every frame. Sweep cuts, keep the ok fits,
// and return the quad most other cuts agree with (median of that cluster).
export const FRAME_SWEEP_CUTS = [null, 60, 80, 100, 120, 140, 160];
export const FRAME_JUMP_AREA = 0.28;
export const FRAME_JUMP_CORNER = 0.06;

function pxSample(rgba, w, h, x, y) {
  const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
  const p = (iy * w + ix) * 4;
  const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
  const L = lum(r, g, b);
  const mx = Math.max(r, g, b);
  const sat = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
  // Projected rays and the on-screen overlay are not the mat. The mat is
  // bright and nearly neutral.
  const overlay = (g > 145 && g > r + 35 && g > b + 25) || (r > 160 && b > 110 && r > g + 40);
  return {lum: L, sat, skip: overlay};
}

function sideGeom(quad, i) {
  const a = quad[i], b = quad[(i + 1) % 4];
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let ix = -(b.y - a.y), iy = b.x - a.x;
  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;
  if ((cx - mx) * ix + (cy - my) * iy < 0) { ix = -ix; iy = -iy; }
  return {a, b, ix, iy};
}

function edgeKind(inn, out, n) {
  if (!n) return {kind: 'none', inn: 0, out: 0};
  inn /= n; out /= n;
  let kind = 'mixed';
  if (out < 110 && inn > out + 22 && inn > 80) kind = 'mat';
  else if (out > inn + 24 && out > 120) kind = 'outside';
  return {kind, inn, out};
}

// Brightest clear pixel inward, darkest clear pixel outward. A green or
// magenta projector stroke on the mat is skipped instead of counted as black.
function matStripClass(rgba, w, h, quad, i) {
  if (!quad || quad.length !== 4) return {kind: 'none', inn: 0, out: 0};
  const {a, b, ix, iy} = sideGeom(quad, i);
  const along = [0.25, 0.375, 0.5, 0.625, 0.75];
  const inward = [3, 5, 7, 9, 11];
  const outward = [4, 7, 10];
  let inn = 0, out = 0, n = 0;
  for (let s = 0; s < along.length; s++) {
    const x = a.x + (b.x - a.x) * along[s], y = a.y + (b.y - a.y) * along[s];
    let bestIn = null, bestOut = null;
    for (let d = 0; d < inward.length; d++) {
      const p = pxSample(rgba, w, h, x + ix * inward[d], y + iy * inward[d]);
      if (p.skip) continue;
      if (!bestIn || p.lum > bestIn.lum) bestIn = p;
    }
    for (let d = 0; d < outward.length; d++) {
      const p = pxSample(rgba, w, h, x - ix * outward[d], y - iy * outward[d]);
      if (p.skip) continue;
      if (!bestOut || p.lum < bestOut.lum) bestOut = p;
    }
    if (!bestIn || !bestOut) continue;
    inn += bestIn.lum;
    out += bestOut.lum;
    n++;
  }
  return edgeKind(inn, out, n);
}

// Shared edge: light mat just inside, dark frame just outside. `outside`
// means the side left that contour (cabinet, outer wall). A projector
// overlay on one side of the sample is ignored, not entered as zero.
export function sideEdgeClass(rgba, w, h, quad, i, dist = 12) {
  if (!quad || quad.length !== 4) return {kind: 'none', inn: 0, out: 0};
  if (!(dist > 6)) return matStripClass(rgba, w, h, quad, i);
  const {a, b, ix, iy} = sideGeom(quad, i);
  let inn = 0, out = 0, n = 0;
  for (let s = 0.35; s <= 0.65; s += 0.15) {
    const x = a.x + (b.x - a.x) * s, y = a.y + (b.y - a.y) * s;
    const inner = pxSample(rgba, w, h, x + ix * dist, y + iy * dist);
    const outer = pxSample(rgba, w, h, x - ix * dist, y - iy * dist);
    if (inner.skip || outer.skip) continue;
    inn += inner.lum;
    out += outer.lum;
    n++;
  }
  if (!n) return matStripClass(rgba, w, h, quad, i);
  return edgeKind(inn, out, n);
}

export function quadEdgeClasses(rgba, w, h, quad) {
  return [0, 1, 2, 3].map(i => sideEdgeClass(rgba, w, h, quad, i));
}

export function quadConvex(q) {
  if (!q || q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-4) continue;
    if (!sign) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return sign !== 0;
}

export function quadAspect(q) {
  const width = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
  const height = (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2;
  return height > 1 ? width / height : 0;
}

// Normalised quads. True when the new outline is a different contour.
export function quadJumped(prev, next) {
  if (!prev || !next || prev.length !== 4 || next.length !== 4) return false;
  let shift = 0;
  for (let i = 0; i < 4; i++) shift += Math.hypot(prev[i].x - next[i].x, prev[i].y - next[i].y);
  const area = q => {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
    return Math.abs(a) / 2;
  };
  const pa = area(prev), na = area(next);
  const ratio = pa > 1e-4 ? Math.abs(na - pa) / pa : 0;
  return shift / 4 > FRAME_JUMP_CORNER || ratio > FRAME_JUMP_AREA;
}

export function createFrameSmoother({need = 3, alpha = 0.45} = {}) {
  let hist = [];
  let held = null;
  const copy = q => q.map(p => ({x: p.x, y: p.y}));
  return {
    push(quad) {
      if (!quad || quad.length !== 4) return held ? copy(held) : null;
      const next = quad.map(p => ({x: +p.x, y: +p.y}));
      if (held && quadJumped(held, next)) {
        hist.push(next);
        if (hist.length > need) hist = hist.slice(-need);
        if (!(hist.length >= need && hist.every(q => !quadJumped(q, next)))) return copy(held);
        held = next;
        hist = [];
        return copy(held);
      }
      hist = [];
      if (!held) { held = next; return copy(held); }
      const k = Math.min(1, Math.max(0.05, +alpha || 0.45));
      held = held.map((p, i) => lerp2(p, next[i], k));
      return copy(held);
    },
    reset() { hist = []; held = null; }
  };
}

// First dark band in from each side whose inner face is the light mat.
// Projected green/magenta strokes are skipped. Every side uses this same
// light→dark step, so one side cannot snap to the cabinet or the outer wall.
export function fitMatRing(rgba, w, h) {
  if (!rgba || w < 16 || h < 16) return null;
  const px = (x, y) => pxSample(rgba, w, h, x, y);
  function scan(fixed, horizontal, dir) {
    const span = horizontal ? w : h;
    const end = Math.round(span * (dir > 0 ? 0.8 : 0.2));
    const start = dir > 0 ? 1 : span - 2;
    let dark = -1;
    for (let t = start; dir > 0 ? t < end : t > end; t += dir) {
      const x = horizontal ? t : fixed, y = horizontal ? fixed : t;
      const s = px(x, y);
      if (s.skip) continue;
      if (s.lum < 88) { if (dark < 0) dark = t; }
      else if (dark >= 0) {
        const dw = Math.abs(t - dark);
        const nearBorder = t < span * 0.04 || t > span * 0.96;
        if (!nearBorder && dw >= 5 && dw <= 200) {
          let peak = 0, sat = 0, n = 0, bright = 0;
          for (let k = 2; k < 12; k++) {
            const q = px(horizontal ? t + dir * k : fixed, horizontal ? fixed : t + dir * k);
            if (q.skip) continue;
            peak = Math.max(peak, q.lum);
            sat += q.sat;
            n++;
            if (q.lum > 125 && q.sat < 0.4) bright++;
          }
          // The mat has to start at this edge, not a bright speck inside the frame.
          if (peak > 130 && n >= 4 && bright >= 3 && sat / n < 0.4) return t;
        }
        dark = -1;
      }
    }
    return null;
  }
  const pointsOf = (horizontal, dir, from, to, step) => {
    const pts = [];
    for (let u = from; u < to; u += step) {
      const hit = scan(u, horizontal, dir);
      if (hit == null) continue;
      pts.push(horizontal ? {x: hit, y: u} : {x: u, y: hit});
    }
    return pts.length >= 8 ? pts : null;
  };
  // A slanted mat: one horizontal top would climb into the cabinet on the
  // far side. Fit each side, drop points that leave that line.
  const robustLine = (pts) => {
    let line = lineFit(pts);
    if (!line) return null;
    const dist = p => Math.abs(line.dx * (p.y - line.cy) - line.dy * (p.x - line.cx));
    const ds = pts.map(dist).sort((a, b) => a - b);
    const med = ds[ds.length >> 1] || 1;
    const kept = pts.filter(p => dist(p) <= Math.max(8, med * 2.4));
    if (kept.length >= 6) line = lineFit(kept) || line;
    return line;
  };
  const sy = Math.max(1, (h / 64) | 0), sx = Math.max(1, (w / 64) | 0);
  const leftPts = pointsOf(true, 1, Math.round(h * 0.16), Math.round(h * 0.84), sy);
  const rightPts = pointsOf(true, -1, Math.round(h * 0.16), Math.round(h * 0.84), sy);
  const topPts = pointsOf(false, 1, Math.round(w * 0.22), Math.round(w * 0.78), sx);
  const bottomPts = pointsOf(false, -1, Math.round(w * 0.22), Math.round(w * 0.78), sx);
  if (!leftPts || !rightPts || !topPts || !bottomPts) return null;
  const axis = (pts, horizontal) => {
    const v = pts.map(p => horizontal ? p.x : p.y).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const left = axis(leftPts, true), right = axis(rightPts, true);
  const top = axis(topPts, false), bottom = axis(bottomPts, false);
  if (!(right > left + w * 0.2 && bottom > top + h * 0.12)) return null;
  // Follow a real slant, but only a little way off the median so a cabinet
  // edge cannot pull a corner out of the mat.
  const along = (line, horizontal, at) => {
    if (!line) return null;
    const dir = horizontal ? line.dy : line.dx;
    const span = horizontal ? line.dx : line.dy;
    if (Math.abs(span) < 0.35) return null;
    const t = horizontal ? (at - line.cx) / line.dx : (at - line.cy) / line.dy;
    const got = horizontal ? line.cy + t * line.dy : line.cx + t * line.dx;
    if (!Number.isFinite(got)) return null;
    return got;
  };
  const clampOff = (got, base, limit) => (got == null || Math.abs(got - base) > limit) ? base : got;
  const limX = w * 0.06, limY = h * 0.12;
  const topL = robustLine(topPts), botL = robustLine(bottomPts);
  const leftL = robustLine(leftPts), rightL = robustLine(rightPts);
  const tl = {x: clampOff(along(leftL, false, top), left, limX), y: clampOff(along(topL, true, left), top, limY)};
  const tr = {x: clampOff(along(rightL, false, top), right, limX), y: clampOff(along(topL, true, right), top, limY)};
  const br = {x: clampOff(along(rightL, false, bottom), right, limX), y: clampOff(along(botL, true, right), bottom, limY)};
  const bl = {x: clampOff(along(leftL, false, bottom), left, limX), y: clampOff(along(botL, true, left), bottom, limY)};
  const quad = [tl, tr, br, bl];
  const area = quadArea(quad) / (w * h);
  const aspect = quadAspect(quad);
  if (!(area > FRAME_MIN_AREA && area < FRAME_MAX_AREA) || !(aspect > 1.05 && aspect < 3.8)) return null;
  if (!quadConvex(quad)) return null;
  const classes = quadEdgeClasses(rgba, w, h, quad);
  if (classes.some(c => c.kind === 'outside')) return null;
  const matSides = classes.filter(c => c.kind === 'mat').length;
  return {quad, area, aspect, confidence: Math.max(matSides, 1) / 4, classes, matSides};
}

// Interior of the colourful painting (not the pale mat, not a window). The
// top edge is found by walking out from here, so a cabinet above the frame
// is never the first dark band.
function paintingInterior(rgba, w, h) {
  const step = Math.max(2, Math.round(Math.max(w, h) / 140));
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step), n = cols * rows;
  const paint = new Uint8Array(n);
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const s = pxSample(rgba, w, h, Math.min(w - 1, gx * step), Math.min(h - 1, gy * step));
    if (!s.skip && s.sat > 0.22 && s.lum > 40 && s.lum < 235) paint[gy * cols + gx] = 1;
  }
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  let best = null;
  for (let s = 0; s < n; s++) {
    if (!paint[s] || seen[s]) continue;
    let head = 0, tail = 0, area = 0;
    let x0 = cols, y0 = rows, x1 = 0, y1 = 0;
    q[tail++] = s; seen[s] = 1;
    while (head < tail) {
      const i = q[head++]; area++;
      const x = i % cols, y = (i / cols) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && paint[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
      if (x < cols - 1 && paint[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
      if (y > 0 && paint[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; q[tail++] = i - cols; }
      if (y < rows - 1 && paint[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; q[tail++] = i + cols; }
    }
    if (!best || area > best.area) best = {area, x0, y0, x1, y1};
  }
  if (!best || best.area < 24) return null;
  return {
    x0: best.x0 * step, y0: best.y0 * step,
    x1: Math.min(w - 1, (best.x1 + 1) * step), y1: Math.min(h - 1, (best.y1 + 1) * step)
  };
}

// Walk out from the painting through the light mat and stop at the first
// dark frame. Background edges past that frame (cabinet, window) never win.
export function fitMatOutward(rgba, w, h, interior) {
  if (!rgba || w < 16 || h < 16) return null;
  const box = interior && Number.isFinite(+interior.x0) ? interior : paintingInterior(rgba, w, h);
  if (!box) return null;
  const px = (x, y) => pxSample(rgba, w, h, x, y);
  function ray(x, y, dx, dy, limit) {
    let seenMat = 0, dark = 0, firstDark = null;
    for (let k = 0; k < limit; k++) {
      x += dx; y += dy;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
      const s = px(x, y);
      if (s.skip) { dark = 0; firstDark = null; continue; }
      if (s.lum > 125 && s.sat < 0.42) { seenMat++; dark = 0; firstDark = null; continue; }
      if (s.lum < 82 && s.sat < 0.5) {
        if (!firstDark) firstDark = {x, y};
        dark++;
        // Inner edge of the frame: the first dark pixel, confirmed by a
        // second so a speck does not win. The last bright mat pixel sits
        // inside the opening.
        if (seenMat >= 3 && dark >= 2 && firstDark) return firstDark;
        continue;
      }
      dark = 0;
      firstDark = null;
    }
    return null;
  }
  const samples = (from, to, n, at) => {
    const pts = [];
    const count = Math.max(6, n);
    for (let i = 1; i < count; i++) pts.push(at(from + (to - from) * i / count));
    return pts;
  };
  const top = samples(box.x0, box.x1, 14, x => ray(x, box.y0, 0, -1, Math.round(h * 0.45))).filter(Boolean);
  const bottom = samples(box.x0, box.x1, 14, x => ray(x, box.y1, 0, 1, Math.round(h * 0.45))).filter(Boolean);
  const left = samples(box.y0, box.y1, 10, y => ray(box.x0, y, -1, 0, Math.round(w * 0.4))).filter(Boolean);
  const right = samples(box.y0, box.y1, 10, y => ray(box.x1, y, 1, 0, Math.round(w * 0.4))).filter(Boolean);
  if (top.length < 4 || bottom.length < 4 || left.length < 4 || right.length < 4) return null;
  const med = (pts, horizontal) => {
    const v = pts.map(p => horizontal ? p.x : p.y).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const leftX = med(left, true), rightX = med(right, true);
  const topY = med(top, false), botY = med(bottom, false);
  if (!(rightX > leftX + w * 0.2 && botY > topY + h * 0.12)) return null;
  const quad = [
    {x: leftX, y: topY},
    {x: rightX, y: topY},
    {x: rightX, y: botY},
    {x: leftX, y: botY}
  ];
  const area = quadArea(quad) / (w * h);
  const aspect = quadAspect(quad);
  if (!(area > FRAME_MIN_AREA && area < FRAME_MAX_AREA) || !(aspect > 1.05 && aspect < 3.8)) return null;
  if (!quadConvex(quad)) return null;
  const classes = quadEdgeClasses(rgba, w, h, quad);
  if (classes.some(c => c.kind === 'outside')) return null;
  const matSides = classes.filter(c => c.kind === 'mat').length;
  return {quad, area, aspect, confidence: Math.max(matSides, 1) / 4, classes, matSides, edge: 'outward'};
}

// A mat edge is light just inside and not a dark cabinet/wall on both faces.
export function matEdgeOk(classes) {
  if (!Array.isArray(classes) || classes.length !== 4) return false;
  for (const side of classes) {
    if (!side || side.kind === 'outside') return false;
    if (side.kind !== 'mat' && side.inn < 45 && side.out < 45) return false;
  }
  return true;
}

// Nearest handle across the green frame (F1–F4) and the pink projector (1–4).
// spot and handles share one coordinate space. limit is the max distance.
export function nearestHandle(spot, groups, limit) {
  if (!spot || !Number.isFinite(+spot.x) || !Number.isFinite(+spot.y)) return null;
  const max = +limit;
  if (!(max >= 0)) return null;
  let best = null, bestD = max + 1;
  for (const group of groups || []) {
    const handles = group && group.handles;
    if (!group || !Array.isArray(handles)) continue;
    for (let index = 0; index < handles.length; index++) {
      const corner = handles[index];
      if (!corner || !Number.isFinite(+corner.x) || !Number.isFinite(+corner.y)) continue;
      const dist = Math.hypot(+corner.x - spot.x, +corner.y - spot.y);
      if (dist <= max && dist < bestD) {
        best = {kind: group.kind, index};
        bestD = dist;
      }
    }
  }
  return best;
}

// Auto frame fit may only nudge the pink projector quad (or the saved
// corners). 3.5% of that quad's size. The top edge must not rise above
// pink corners 1–2 (image y grows downward).
export const FRAME_PRIOR_TOL = 0.035;
export function frameFitsPrior(quad, prior, tol = FRAME_PRIOR_TOL) {
  const q = orderProjectorCorners(quad);
  const p = orderProjectorCorners(prior);
  if (!q || !p) return false;
  const xs = p.map(c => c.x);
  const ys = p.map(c => c.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(size > 1e-6)) return false;
  const limit = Math.max(0, +tol || 0) * size;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(q[i].x - p[i].x, q[i].y - p[i].y) > limit) return false;
  }
  // Automatic drift may not climb. An explicit Detect of a scored inner mat
  // does not use this check.
  if (Math.min(q[0].y, q[1].y) < Math.min(p[0].y, p[1].y) - 0.002) return false;
  return true;
}

// When a detection is rejected: manual lock, then the last good frame, then
// the projector quad expanded a little. Sticker scan uses this instead of no quad.
export function frameFallback({lastGood = null, manual = null, proj = null, expand = 0.08} = {}) {
  const ok = q => Array.isArray(q) && q.length === 4 && q.every(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  const copy = q => q.map(p => ({x: +p.x, y: +p.y}));
  if (ok(manual)) return {quad: copy(manual), source: 'manual frame lock'};
  if (ok(lastGood)) return {quad: copy(lastGood), source: 'last good frame'};
  if (!ok(proj)) return null;
  const cx = proj.reduce((s, p) => s + p.x, 0) / 4;
  const cy = proj.reduce((s, p) => s + p.y, 0) / 4;
  const k = 1 + Math.max(0, Math.min(0.25, +expand || 0));
  return {quad: proj.map(p => ({x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k})), source: 'projector quad'};
}

function topSkewBad(quad, h) {
  if (!quad || quad.length !== 4) return true;
  const skew = Math.abs(quad[0].y - quad[1].y);
  const top = Math.min(quad[0].y, quad[1].y);
  const bot = Math.max(quad[2].y, quad[3].y);
  const fh = bot - top;
  if (!(fh > h * 0.1)) return true;
  if (skew > fh * 0.45 && skew > h * 0.1) return true;
  const fw = Math.max(quad[1].x, quad[2].x) - Math.min(quad[0].x, quad[3].x);
  const side = Math.max(Math.abs(quad[0].x - quad[3].x), Math.abs(quad[1].x - quad[2].x));
  if (fw > 8 && side > fw * 0.45) return true;
  return false;
}

// Camera above the painting: top edge longer, left and right lean inward
// toward the bottom. A rectangle or a cabinet-climbed quad is not this.
export function innerMatTrapezoid(quad, h) {
  if (!quad || quad.length !== 4 || !quadConvex(quad)) return false;
  if (h && topSkewBad(quad, h)) return false;
  const top = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const bot = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  if (!(top > bot + Math.max(2, top * 0.02))) return false;
  const inset = Math.max(1, top * 0.01);
  if (!(quad[0].x + inset < quad[3].x && quad[1].x > quad[2].x + inset)) return false;
  return true;
}

// Deterministic 2D pair consensus. Pairs run along the side, not across a
// constant-x or constant-y band, so a slanted edge is not clipped and a short
// cabinet or speaker edge cannot outvote the long mat line.
function ransacSideLine(pts, alongY) {
  if (!pts || pts.length < 4) return null;
  const n = pts.length;
  const stride = n <= 96 ? 1 : Math.max(1, Math.floor(n / 28));
  let best = null, bestScore = -1;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const a = pts[i], b = pts[j];
      const du = alongY ? b.y - a.y : b.x - a.x;
      const dv = alongY ? b.x - a.x : b.y - a.y;
      if (Math.abs(du) < 20) continue;
      if (Math.abs(dv / du) > 0.45) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const nx = -dy / len, ny = dx / len;
      const inliers = [];
      let umin = Infinity, umax = -Infinity;
      for (let k = 0; k < n; k++) {
        const p = pts[k];
        if (Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny) > 3.5) continue;
        inliers.push(p);
        const u = alongY ? p.y : p.x;
        if (u < umin) umin = u;
        if (u > umax) umax = u;
      }
      if (inliers.length < 4) continue;
      const score = inliers.length + (umax - umin) * 0.02;
      if (score > bestScore) { bestScore = score; best = inliers; }
    }
  }
  let cur = best && best.length >= 4 ? best : pts.slice();
  let line = lineFit(cur);
  if (!line) return null;
  for (let pass = 0; pass < 2; pass++) {
    const dist = p => Math.abs(line.dx * (p.y - line.cy) - line.dy * (p.x - line.cx));
    const ds = cur.map(dist).sort((a, b) => a - b);
    const med = ds[ds.length >> 1] || 1;
    const cut = Math.max(2.5, med * 2.2);
    const next = cur.filter(p => dist(p) <= cut);
    if (next.length < 4 || next.length === cur.length) break;
    cur = next;
    line = lineFit(cur) || line;
  }
  return line;
}

// Ambient black frame, then the crisp white mat. Rays walk in from the image
// border. Left, right, and bottom only take a dark run that starts near the
// border, so dark paint in the opening cannot win. The top run may be thicker:
// a speaker sitting on the frame is the same black mass, and the mat is still
// the edge that follows it.
export function fitMatBorder(rgba, w, h) {
  if (!rgba || w < 32 || h < 32 || rgba.length < w * h * 4) return null;
  const px = (x, y) => pxSample(rgba, w, h, x, y);
  // Near-black paint reads as high saturation. A dark pixel is the frame
  // when it is simply that dark, or dark and not strongly coloured.
  const dark = s => s && !s.skip && (s.lum <= 70 || (s.lum <= 98 && s.sat < 0.7));
  const light = s => s && !s.skip && s.lum >= 105 && s.sat < 0.65;
  function walk(x, y, dx, dy, limit, near, minRun, maxRun) {
    let traveled = 0, darkAt = -1, gap = 0;
    while (traveled < limit) {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const s = px(x, y);
      if (!s.skip) {
        if (dark(s)) {
          gap = 0;
          if (darkAt < 0) {
            if (traveled > near) return null;
            darkAt = traveled;
          }
        } else if (darkAt >= 0 && !light(s) && gap < 2 && s.lum < 120) {
          gap++;
        } else if (darkAt >= 0) {
          const run = traveled - darkAt;
          if (run >= minRun && run <= maxRun && light(s)) {
            let peak = s.lum, n = 0, sat = 0, xx = x, yy = y;
            for (let k = 0; k < 20 && xx >= 0 && yy >= 0 && xx < w && yy < h; k++) {
              const q = px(xx, yy);
              if (q.skip) { xx += dx; yy += dy; continue; }
              if (!light(q)) break;
              peak = Math.max(peak, q.lum);
              sat += q.sat;
              n++;
              xx += dx;
              yy += dy;
            }
            if (n >= 4 && peak >= 115 && sat / n < 0.65) return {x, y};
          }
          if (run >= minRun && traveled > near) return null;
          darkAt = -1;
          gap = 0;
        }
      }
      x += dx;
      y += dy;
      traveled++;
    }
    return null;
  }
  const collect = (horizontal, dir, from, to, step, near, minRun, maxRun, limit) => {
    const pts = [];
    for (let u = from; u < to; u += step) {
      const hit = horizontal
        ? walk(dir > 0 ? 0 : w - 1, u | 0, dir, 0, limit, near, minRun, maxRun)
        : walk(u | 0, dir > 0 ? 0 : h - 1, 0, dir, limit, near, minRun, maxRun);
      if (hit) pts.push(hit);
    }
    return pts;
  };
  const stepY = Math.max(2, Math.round(h / 90));
  const stepX = Math.max(2, Math.round(w / 90));
  const span = Math.max(w, h);
  const sideNear = Math.round(span * 0.36);
  const sideMax = Math.round(span * 0.30);
  const topNear = Math.round(h * 0.55);
  const topMax = Math.round(h * 0.52);
  const minRun = 6;
  const x0 = Math.round(w * 0.14), x1 = Math.round(w * 0.86);
  const topPts = collect(false, 1, x0, x1, stepX, topNear, minRun, topMax, Math.round(h * 0.78));
  const botPts = collect(false, -1, x0, x1, stepX, sideNear, minRun, sideMax, Math.round(h * 0.78));
  if (topPts.length < 5 || botPts.length < 5) return null;
  // Top and bottom first, so a cabinet sitting above the painting is outside
  // the band where the left and right mat edges are sampled.
  const top = ransacSideLine(topPts, false), bottom = ransacSideLine(botPts, false);
  if (!top || !bottom) return null;
  const yOn = (line, x) => {
    if (!line || Math.abs(line.dx) < 1e-4) return null;
    return line.cy + ((x - line.cx) / line.dx) * line.dy;
  };
  const topAt0 = yOn(top, 0), topAtW = yOn(top, w), botAt0 = yOn(bottom, 0), botAtW = yOn(bottom, w);
  if (![topAt0, topAtW, botAt0, botAtW].every(Number.isFinite)) return null;
  const yMin = Math.max(Math.round(h * 0.08), Math.floor(Math.min(topAt0, topAtW) - 8));
  const yMax = Math.min(Math.round(h * 0.92), Math.ceil(Math.max(botAt0, botAtW) + 8));
  if (!(yMax > yMin + 8)) return null;
  const leftPts = collect(true, 1, yMin, yMax, stepY, sideNear, minRun, sideMax, Math.round(w * 0.78));
  const rightPts = collect(true, -1, yMin, yMax, stepY, sideNear, minRun, sideMax, Math.round(w * 0.78));
  if (leftPts.length < 5 || rightPts.length < 4) return null;
  const left = ransacSideLine(leftPts, true), right = ransacSideLine(rightPts, true);
  if (!left || !right) return null;
  const raw = [intersect(left, top), intersect(top, right), intersect(right, bottom), intersect(bottom, left)];
  if (!raw.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const quad = raw.map(p => ({
    x: Math.min(w - 1, Math.max(0, p.x)),
    y: Math.min(h - 1, Math.max(0, p.y))
  }));
  if (!quadConvex(quad) || topSkewBad(quad, h)) return null;
  const area = quadArea(quad) / (w * h);
  const aspect = quadAspect(quad);
  if (!(area > FRAME_MIN_AREA && area < FRAME_MAX_AREA) || !(aspect > 1.05 && aspect < 3.8)) return null;
  const fw = ((quad[1].x + quad[2].x) - (quad[0].x + quad[3].x)) / 2;
  const fh = ((quad[2].y + quad[3].y) - (quad[0].y + quad[1].y)) / 2;
  if (!(fw > w * 0.2 && fh > h * 0.12)) return null;
  const classes = [0, 1, 2, 3].map(i => matStripClass(rgba, w, h, quad, i));
  if (classes.some(c => c.kind === 'outside')) return null;
  const matSides = classes.filter(c => c.kind === 'mat').length;
  if (matSides < 3) return null;
  return {quad, area, aspect, confidence: matSides / 4, classes, matSides, edge: 'border'};
}

export function detectPaintingFrameSweep(rgba, width, height, options = {}) {
  const fits = [];
  for (const cut of options.cuts || FRAME_SWEEP_CUTS) {
    const r = detectPaintingFrame(rgba, width, height, cut == null ? options : {...options, darkCut: cut});
    if (r.ok) fits.push({...r, cutUsed: cut == null ? r.cut : cut});
  }
  if (!fits.length) {
    const border = fitMatBorder(rgba, width, height);
    if (border && border.matSides >= 3 && innerMatTrapezoid(border.quad, height)) {
      return {
        ok: true, quad: border.quad, area: border.area, votes: 0, fits: 0, cuts: [],
        confidence: border.confidence, edge: 'border'
      };
    }
    return {ok: false, reason: 'no enclosed frame found at any threshold', tried: (options.cuts || FRAME_SWEEP_CUTS).length};
  }
  const tol = Math.max(width, height) * 0.02;
  const near = (a, b) => a.quad.every((p, i) => Math.hypot(p.x - b.quad[i].x, p.y - b.quad[i].y) <= tol);
  let best = null;
  for (const f of fits) {
    const group = fits.filter(g => near(f, g));
    if (!best || group.length > best.length) best = group;
  }
  const med = arr => { const v = arr.slice().sort((a, b) => a - b); return v[v.length >> 1]; };
  const seed = [0, 1, 2, 3].map(i => ({x: med(best.map(f => f.quad[i].x)), y: med(best.map(f => f.quad[i].y))}));
  const seedClass = quadEdgeClasses(rgba, width, height, seed);
  const seedMat = seedClass.filter(c => c.kind === 'mat').length;
  const seedLeft = seedClass.some(c => c.kind === 'outside') || seedMat < 3;
  const ring = fitMatRing(rgba, width, height);
  // A seed on the mat (white flash) is kept. A seed that left the mat yields
  // to a walk outward from the painting when that walk's top sits clearly
  // lower than the border-inward ring (off the cabinet, not up into it).
  const outward = seedLeft ? fitMatOutward(rgba, width, height) : null;
  let picked = ring && seedLeft ? ring : null;
  if (outward && seedLeft) {
    const topOf = q => Math.min(q[0].y, q[1].y);
    const better = !picked || topOf(outward.quad) > topOf(picked.quad) + height * 0.06;
    if (better) picked = outward;
  }
  const border = fitMatBorder(rgba, width, height);
  const scoredMat = border && border.matSides >= 3 && innerMatTrapezoid(border.quad, height);
  // A scored inner-mat keystone always beats the seed, including one that
  // climbed into a speaker. A border that is not that trapezoid does not
  // override the seed (a cabinet edge can still look like four mat sides).
  if (scoredMat) picked = border;
  // Outward walk found no mat band. Do not adopt a border-inward ring that
  // is not a mat edge (cabinet, window). The session uses the fallback chain.
  // A missing ring still keeps the seed, which is how a white-flash frame lands.
  if (seedLeft && !outward && picked && picked.edge !== 'border' && !matEdgeOk(picked.classes)) {
    return {ok: false, reason: 'no mat band', confidence: 0, edge: 'none', votes: best.length, fits: fits.length};
  }
  if (!picked && topSkewBad(seed, height)) {
    return {ok: false, reason: 'frame climbed off the mat', confidence: seedMat / 4, edge: 'none', votes: best.length, fits: fits.length};
  }
  const quad = picked ? picked.quad : seed;
  const edge = picked && picked.edge ? picked.edge : (picked ? 'mat' : 'seed');
  const confidence = picked ? picked.confidence : seedMat / 4;
  return {
    ok: true,
    quad,
    area: quadArea(quad) / (width * height),
    votes: best.length,
    fits: fits.length,
    cuts: best.map(f => f.cutUsed),
    confidence,
    edge
  };
}

// Normalised camera quad (0..1) for persistence with the alignment.
export function normalizeQuad(quad, width, height) {
  return quad.map(p => ({x: p.x / width, y: p.y / height}));
}

export function pointInQuad(q, x, y) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// Shrink a quad toward its centroid (fraction 0..1) — e.g. keep stickers off
// the frame / corner labels.
export function insetQuad(q, fraction) {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const k = 1 - Math.max(0, Math.min(0.9, +fraction || 0));
  return q.map(p => ({x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k}));
}

// Stickers on the painting count inside the green frame, a little in from
// the inner edge so the frame moulding itself does not latch.
export const FRAME_CONTAIN_INSET = 0.03;
export function frameContainsPoint(quad, x, y, inset = FRAME_CONTAIN_INSET) {
  if (!Array.isArray(quad) || quad.length !== 4 || !Number.isFinite(+x) || !Number.isFinite(+y)) return false;
  const zone = inset > 0 ? insetQuad(quad, inset) : quad;
  return pointInQuad(zone, +x, +y);
}

// ---- Projector warp: put the stage canvas onto the painting -------------
// projQuad: where the projector's FULL canvas lands in the camera (normalised
// camera coords, from Align / Auto align with no warp). frameQuad: the frame's
// inner edge in the camera (same coords). The warp target is where the
// canvas corners must go, in canvas px, so the stage lands on the frame.

export function solveHomography4(src, dst) {
  return solveHomography(src, dst);
}
export function applyH(H, x, y) {
  const p = applyHomography(H, x, y);
  return p || {x: NaN, y: NaN};
}
const box = (W, H) => [{x: 0, y: 0}, {x: W, y: 0}, {x: W, y: H}, {x: 0, y: H}];

// Coverage: the mask is the frame AND the projector's reach. Corners the
// projector cannot reach are clamped to the canvas edge and reported.
export function projectorWarpTarget(projQuad, frameQuad, W = 1000, H = 620) {
  if (!Array.isArray(projQuad) || projQuad.length !== 4 || !Array.isArray(frameQuad) || frameQuad.length !== 4) return null;
  const canvasToCam = solveHomography4(box(W, H), projQuad);
  const camToCanvas = canvasToCam && solveHomography4(projQuad, box(W, H));
  if (!camToCanvas) return null;
  const raw = frameQuad.map(p => applyH(camToCanvas, p.x, p.y));
  if (!raw.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const tol = 0.005;
  const short = {top: false, bottom: false, left: false, right: false};
  const target = raw.map(p => {
    if (p.y < -tol * H) short.top = true;
    if (p.y > H * (1 + tol)) short.bottom = true;
    if (p.x < -tol * W) short.left = true;
    if (p.x > W * (1 + tol)) short.right = true;
    return {x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y))};
  });
  const missing = Object.keys(short).filter(k => short[k]);
  return {target, raw, short, warning: coverageWarning(missing)};
}
export function coverageWarning(missing) {
  if (!missing || !missing.length) return '';
  return "Projector doesn't cover the " + missing.join(' and ') + ' of the painting';
}

// Fine pass: Align with the warp on measured where the warped stage really
// lands (measuredQuad, camera). Move each target corner by the camera error
// mapped back into canvas px through the unwarped projector calibration.
export function refineWarpTarget(target, measuredQuad, frameQuad, projQuad, W = 1000, H = 620) {
  const camToCanvas = solveHomography4(projQuad, box(W, H));
  if (!camToCanvas || !target || !measuredQuad || measuredQuad.length !== 4) return null;
  let worst = 0;
  const next = target.map((t, i) => {
    const want = applyH(camToCanvas, frameQuad[i].x, frameQuad[i].y);
    const got = applyH(camToCanvas, measuredQuad[i].x, measuredQuad[i].y);
    const dx = want.x - got.x, dy = want.y - got.y;
    worst = Math.max(worst, Math.hypot(dx, dy));
    return {x: Math.min(W, Math.max(0, t.x + dx)), y: Math.min(H, Math.max(0, t.y + dy))};
  });
  return {target: next, errorPx: worst};
}

// CSS matrix3d that maps an element of size w x h (CSS px) so its corners
// land on target (canvas px of a W x H canvas drawn at w x h).
export function warpMatrix3d(target, w, h, W = 1000, H = 620) {
  const sx = w / W, sy = h / H;
  const M = solveHomography4(box(w, h), target.map(p => ({x: p.x * sx, y: p.y * sy})));
  if (!M) return '';
  const [a, b, c, d, e, f, g, k] = M;
  return 'matrix3d(' + [a, d, 0, g, b, e, 0, k, 0, 0, 1, 0, c, f, 0, 1].map(v => +v.toFixed(9)).join(',') + ')';
}

// White flash judged over the painting only (mat + painted surface lit by
// the projector): a colourful painting never has the flat spread of a white
// wall, so the plain check (mean >= 150, spread <= 80) failed on every scan.
export function paintingFlashLit(stats) {
  if (!stats) return false;
  return stats.mean >= 130 && stats.median >= 120 && stats.p10 >= 70;
}

// Several detections must agree before a frame is offered (a person or a
// flash in front of the frame gives a wrong quad).
export function stableFrameQuad(quads, tolerance = 0.02) {
  const ok = (quads || []).filter(Boolean);
  if (ok.length < 3) return null;
  const last = ok.slice(-3);
  for (let i = 0; i < 4; i++) for (const q of last) {
    if (Math.hypot(q[i].x - last[0][i].x, q[i].y - last[0][i].y) > tolerance) return null;
  }
  return last[0].map((_, i) => ({x: last.reduce((s, q) => s + q[i].x, 0) / 3, y: last.reduce((s, q) => s + q[i].y, 0) / 3}));
}

export const PAINTING_KEY = 'nd.paintingSurface.v1';
export function readPaintingSurface(storage) {
  try {
    const raw = storage && storage.getItem(PAINTING_KEY);
    const d = raw ? JSON.parse(raw) : null;
    if (!d || !Array.isArray(d.frameQuad) || d.frameQuad.length !== 4) return null;
    return d;
  } catch { return null; }
}
export function writePaintingSurface(storage, data) {
  try {
    if (!storage) return false;
    if (!data) storage.removeItem(PAINTING_KEY);
    else storage.setItem(PAINTING_KEY, JSON.stringify(data));
    return true;
  } catch { return false; }
}
