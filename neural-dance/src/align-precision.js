// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Projector alignment precision (TJ, Nov 11: "come up with some strategies
// for making the alignment more precise" -> 1, 3 and 4 approved).
//   1. Multi-point fit: a 3x3 / 4x4 grid of dots, one robust (RANSAC + Huber)
//      homography over all of them, and a residual per dot in camera px and
//      floor cm so the operator sees WHICH dot is off.
//   3. Structured light: the projector flashes Gray-code stripes (each bit as
//      a pattern and its inverse, so room light cancels) and a dot grid; the
//      camera finds the dots to sub-pixel, the stripes name each dot, and the
//      homography falls out with no corners clicked and no prior quad.
//   4. Verification: crosshairs on the floor, a sticker on each, offsets in
//      cm, optional correction; a 5-mark walk check; a 1-point recheck.
// Everything here is pure math or io-injected loops: it runs only while the
// operator aligns, never per show frame.

import {applyHomography as applyH, solveLinear} from './geometry.js';

export {applyH};

// ---------------------------------------------------------------- matrices

export function mulH(A, B) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[r * 3 + k] * B[k * 3 + c];
    out[r * 3 + c] = s;
  }
  return out;
}

export function invertH(H) {
  if (!H) return null;
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d
  ].map(v => v / det);
  return normalizeH(inv);
}

function normalizeH(H) {
  if (!H || !H.every(Number.isFinite)) return null;
  const s = Math.abs(H[8]) > 1e-12 ? H[8] : 1;
  return H.map(v => v / s);
}


// Hartley normalization: centroid to the origin, mean distance sqrt(2).
function normalizer(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return {T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], Tinv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1]};
}

function finitePt(p) {
  return !!p && Number.isFinite(+p.x) && Number.isFinite(+p.y);
}

// Weighted least-squares homography src -> dst (>= 4 pairs), normalized DLT.
export function fitHomography(src, dst, weights = null) {
  const idx = [];
  for (let i = 0; i < Math.min(src.length, dst.length); i++) {
    if (finitePt(src[i]) && finitePt(dst[i]) && (!weights || weights[i] > 0)) idx.push(i);
  }
  if (idx.length < 4) return null;
  const S = idx.map(i => ({x: +src[i].x, y: +src[i].y}));
  const D = idx.map(i => ({x: +dst[i].x, y: +dst[i].y}));
  const ns = normalizer(S);
  const nd = normalizer(D);
  const AtA = Array.from({length: 8}, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs, w) => {
    for (let r = 0; r < 8; r++) {
      if (row[r] === 0) continue;
      Atb[r] += w * row[r] * rhs;
      for (let c = 0; c < 8; c++) AtA[r][c] += w * row[r] * row[c];
    }
  };
  for (let k = 0; k < idx.length; k++) {
    const s = applyH(ns.T, S[k].x, S[k].y);
    const d = applyH(nd.T, D[k].x, D[k].y);
    const w = weights ? +weights[idx[k]] : 1;
    add([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y], d.x, w);
    add([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y], d.y, w);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  return normalizeH(mulH(nd.Tinv, mulH(Hn, ns.T)));
}

export function reprojectionErrors(H, src, dst) {
  return src.map((s, i) => {
    const d = dst[i];
    if (!finitePt(s) || !finitePt(d)) return null;
    const p = applyH(H, +s.x, +s.y);
    return p ? Math.hypot(p.x - d.x, p.y - d.y) : Infinity;
  });
}

function triArea(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

function degenerate(pts, minArea) {
  for (let i = 0; i < 4; i++) {
    const tri = pts.filter((_, k) => k !== i);
    if (triArea(tri[0], tri[1], tri[2]) < minArea) return true;
  }
  return false;
}

function spanArea(pts) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return Math.max(1e-12, (x1 - x0) * (y1 - y0));
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function* subsetsOf4(n) {
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) yield [a, b, c, d];
}

// RANSAC (MSAC cost) over 4-point subsets, then Huber IRLS on the inliers.
// tol: inlier distance in dst units. Small sets (<= 16 points, 1820
// subsets) are searched exhaustively, so the result is deterministic.
export const ROBUST_DEFAULTS = {tol: 0.006, iterations: 400, huberIters: 6, seed: 1, exhaustiveMax: 16};
export function robustHomography(src, dst, options = {}) {
  const opt = {...ROBUST_DEFAULTS, ...options};
  const valid = [];
  for (let i = 0; i < Math.min(src.length, dst.length); i++) if (finitePt(src[i]) && finitePt(dst[i])) valid.push(i);
  const n = valid.length;
  if (n < 4) return null;
  const S = valid.map(i => ({x: +src[i].x, y: +src[i].y}));
  const D = valid.map(i => ({x: +dst[i].x, y: +dst[i].y}));
  const tol = opt.tol;
  const minS = spanArea(S) * 1e-3;
  const minD = spanArea(D) * 1e-3;
  let best = null;
  const tryIdx = (q) => {
    const s4 = q.map(k => S[k]);
    const d4 = q.map(k => D[k]);
    if (degenerate(s4, minS) || degenerate(d4, minD)) return;
    const H = fitHomography(s4, d4);
    if (!H) return;
    const err = reprojectionErrors(H, S, D);
    let cost = 0;
    let count = 0;
    for (const e of err) {
      const v = e == null ? Infinity : e;
      if (v <= tol) { cost += v * v; count++; } else cost += tol * tol;
    }
    if (!best || count > best.count || (count === best.count && cost < best.cost)) best = {H, count, cost};
  };
  if (n === 4) tryIdx([0, 1, 2, 3]);
  else if (n <= opt.exhaustiveMax) { for (const q of subsetsOf4(n)) tryIdx(q); }
  else {
    const r = rng(opt.seed);
    for (let it = 0; it < opt.iterations; it++) {
      const q = new Set();
      while (q.size < 4) q.add(Math.floor(r() * n));
      tryIdx([...q]);
    }
  }
  let H = best && best.count >= 4 ? best.H : fitHomography(S, D);
  if (!H) return null;
  // Huber IRLS on everything within 3 tol of the consensus model; the
  // weight falls off past tol/2 so one sloppy dot cannot drag the fit.
  const k = tol / 2;
  let inl = reprojectionErrors(H, S, D).map(e => e != null && e <= tol * 3);
  for (let it = 0; it < opt.huberIters; it++) {
    const err = reprojectionErrors(H, S, D);
    const w = err.map((e, i) => (!inl[i] || e == null || !Number.isFinite(e)) ? 0 : (e <= k ? 1 : k / e));
    if (w.filter(v => v > 0).length < 4) break;
    const next = fitHomography(S, D, w);
    if (!next) break;
    H = next;
    inl = reprojectionErrors(H, S, D).map(e => e != null && e <= tol * 3);
  }
  const errs = reprojectionErrors(H, S, D);
  const inliers = errs.map(e => e != null && e <= tol);
  const inErr = errs.filter((e, i) => inliers[i]);
  const rms = inErr.length ? Math.sqrt(inErr.reduce((a, e) => a + e * e, 0) / inErr.length) : null;
  const max = inErr.length ? Math.max(...inErr) : null;
  const fullErr = new Array(Math.min(src.length, dst.length)).fill(null);
  const fullIn = new Array(fullErr.length).fill(false);
  valid.forEach((i, k2) => { fullErr[i] = errs[k2]; fullIn[i] = inliers[k2]; });
  return {H, inliers: fullIn, errors: fullErr, inlierCount: inErr.length, count: n, rms, max};
}

// Stage (0-1) corners in camera 0-1 for a stage -> camera homography: the
// stored quad (top left, top right, bottom right, bottom left).
export const STAGE_CORNERS = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}];
export function quadFromH(H) {
  const q = STAGE_CORNERS.map(p => applyH(H, p.x, p.y));
  return q.every(Boolean) ? q.map(p => ({x: p.x, y: p.y})) : null;
}

export function hFromQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4 || !quad.every(finitePt)) return null;
  return fitHomography(STAGE_CORNERS, quad.map(p => ({x: +p.x, y: +p.y})));
}

// ------------------------------------------------------------ grid targets

// Grid of targets inside the align circles (stage 0-1). n = 3 keeps the
// order refine always used (corners, edge midpoints, center); n = 4 lists
// the four corners first, then the other twelve row by row.
export const GRID_BOUNDS = {x0: 0.18, x1: 0.82, y0: 0.18, y1: 0.82};
export function gridTargets(n = 3, b = GRID_BOUNDS) {
  const size = n === 4 ? 4 : 3;
  const at = (i, j) => ({x: b.x0 + (b.x1 - b.x0) * i / (size - 1), y: b.y0 + (b.y1 - b.y0) * j / (size - 1)});
  const last = size - 1;
  const corners = [at(0, 0), at(last, 0), at(last, last), at(0, last)];
  if (size === 3) {
    const [tl, tr, br, bl] = corners;
    const mid = (a, c) => ({x: (a.x + c.x) / 2, y: (a.y + c.y) / 2});
    return corners.concat([mid(tl, tr), mid(tr, br), mid(br, bl), mid(bl, tl), mid(tl, br)]);
  }
  const rest = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    if ((i === 0 || i === last) && (j === 0 || j === last)) continue;
    rest.push(at(i, j));
  }
  return corners.concat(rest);
}

export const GRID_KEY = 'nd.align.grid.v1';
export function readGridSize(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    return s && s.getItem(GRID_KEY) === '4' ? 4 : 3;
  } catch { return 3; }
}
export function writeGridSize(storage, n) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (s) s.setItem(GRID_KEY, n === 4 ? '4' : '3');
  } catch { /* private mode */ }
  return n === 4 ? 4 : 3;
}

// ------------------------------------------------------- residual reporting

// The stage size on the floor. TJ measures the projected width once per
// venue; height follows from the projected aspect (iPhone 13 landscape 844x390).
export const STAGE_CM_KEY = 'nd.align.stageCm.v1';
export const DEFAULT_STAGE_ASPECT = 844 / 390;
export function readStageWidthCm(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const v = s ? +s.getItem(STAGE_CM_KEY) : NaN;
    return Number.isFinite(v) && v >= 50 && v <= 2000 ? v : null;
  } catch { return null; }
}
export function writeStageWidthCm(storage, cm) {
  const v = +cm;
  if (!(Number.isFinite(v) && v >= 50 && v <= 2000)) return null;
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (s) s.setItem(STAGE_CM_KEY, String(Math.round(v)));
  } catch { /* private mode */ }
  return Math.round(v);
}

function stageCm(dx, dy, stageWidthCm, stageAspect) {
  if (!(stageWidthCm > 0)) return null;
  const aspect = stageAspect > 0 ? stageAspect : DEFAULT_STAGE_ASPECT;
  return Math.hypot(dx * stageWidthCm, dy * stageWidthCm / aspect);
}

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// One row per target: how far the measured dot sits from where the fitted
// map puts it, in camera px (video width) and on the floor in cm.
//   H        stage(0-1) -> camera(0-1)
//   targets  stage 0-1; measured camera 0-1 (null = not found)
export function pointResiduals(H, targets, measured, {videoWidth = 480, videoHeight = 360, stageWidthCm = null, stageAspect = DEFAULT_STAGE_ASPECT, inliers = null} = {}) {
  const Hinv = invertH(H);
  return targets.map((t, i) => {
    const m = measured[i];
    if (!finitePt(m)) return {i, found: false};
    const p = applyH(H, t.x, t.y);
    if (!p) return {i, found: false};
    const dxPx = (m.x - p.x) * videoWidth;
    const dyPx = (m.y - p.y) * videoHeight;
    const back = Hinv ? applyH(Hinv, m.x, m.y) : null;
    const cm = back ? stageCm(back.x - t.x, back.y - t.y, stageWidthCm, stageAspect) : null;
    return {i, found: true, px: r2(Math.hypot(dxPx, dyPx)), dx: r1(dxPx), dy: r1(dyPx), cm: r1(cm), inlier: inliers ? !!inliers[i] : true};
  });
}

export function residualStats(points) {
  const found = (points || []).filter(p => p && p.found);
  const used = found.filter(p => p.inlier !== false);
  if (!used.length) return {found: found.length, used: 0, rmsPx: null, maxPx: null, maxCm: null, worst: null, outliers: found.filter(p => p.inlier === false).map(p => p.i)};
  const rms = Math.sqrt(used.reduce((a, p) => a + p.px * p.px, 0) / used.length);
  let worst = used[0];
  for (const p of used) if (p.px > worst.px) worst = p;
  const cms = used.map(p => p.cm).filter(v => v != null);
  return {
    found: found.length,
    used: used.length,
    rmsPx: r2(rms),
    maxPx: r2(worst.px),
    maxCm: cms.length ? r1(Math.max(...cms)) : null,
    worst: {i: worst.i, px: worst.px, cm: worst.cm},
    outliers: found.filter(p => p.inlier === false).map(p => p.i)
  };
}

const label = (i) => '#' + (i + 1);
function pxCm(px, cm) {
  return (px == null ? '—' : px.toFixed(1) + ' px') + (cm == null ? '' : ' / ' + cm.toFixed(1) + ' cm');
}

// Debug-page text for whatever ran last (grid refine, auto align, crosshair
// check, walk check, recheck). Line 1 is the verdict, line 2 every point.
export function precisionSummary(rep) {
  if (!rep || typeof rep !== 'object') return '';
  const kind = {grid: 'Grid fit', auto: 'Auto align (structured light)', crosshair: 'Crosshair check', walk: 'Walk check', recheck: '1-point recheck'}[rep.kind] || 'Precision';
  if (rep.state && rep.state !== 'done') {
    return kind + ': ' + (rep.message || rep.state);
  }
  const s = rep.stats || {};
  let head = kind + (rep.grid ? ' ' + rep.grid + '×' + rep.grid : '') + ': ';
  if (rep.ok === false) head += '✗ ' + (rep.reason || 'failed');
  else head += (rep.verdict ? rep.verdict + ' · ' : '') + 'rms ' + (s.rmsPx == null ? '—' : s.rmsPx.toFixed(1) + ' px') +
    ' · worst ' + (s.worst ? label(s.worst.i) + ' ' + pxCm(s.worst.px, s.worst.cm) : '—');
  if (s.outliers && s.outliers.length) head += ' · ignored ' + s.outliers.map(label).join(' ');
  if (rep.applied) head += ' · corrected' + (rep.after && rep.after.maxCm != null ? ' → worst ' + rep.after.maxCm.toFixed(1) + ' cm' : '');
  if (rep.stageWidthCm == null && rep.ok !== false) head += ' · set stage width for cm';
  const pts = Array.isArray(rep.points) ? rep.points : [];
  const line = pts.map(p => label(p.i) + ' ' + (p.found ? pxCm(p.px, p.cm) + (p.inlier === false ? ' ✗' : '') : 'not seen')).join(' · ');
  return line ? head + '\n' + line : head;
}

// ------------------------------------------------------------- Gray code

export function grayEncode(n) { return (n ^ (n >>> 1)) >>> 0; }
export function grayDecode(g) {
  let n = g >>> 0;
  for (let s = 1; s < 32; s <<= 1) n ^= n >>> s;
  return n >>> 0;
}
export function grayBitsFor(count) {
  let b = 1;
  while ((1 << b) < count) b++;
  return b;
}
// Whether cell `cell` is lit for bit `bit` (0 = most significant) of a
// `bits`-bit code; `inverse` flips it (the differencing partner).
export function grayCellLit(cell, bit, bits, inverse = false) {
  const on = ((grayEncode(cell) >>> (bits - 1 - bit)) & 1) === 1;
  return inverse ? !on : on;
}

// Decode one position from per-bit samples: pos[k], neg[k] are the camera
// brightness with bit k's pattern and its inverse. Room light and surface
// color hit both, so the sign of pos - neg is the bit.
export function decodeGraySamples(pos, neg, minContrast = 6) {
  let code = 0;
  let weakest = Infinity;
  for (let k = 0; k < pos.length; k++) {
    const d = pos[k] - neg[k];
    code = (code << 1) | (d > 0 ? 1 : 0);
    weakest = Math.min(weakest, Math.abs(d));
  }
  return {value: grayDecode(code), code, contrast: weakest, ok: weakest >= minContrast};
}

// --------------------------------------------------- structured light: layout

// Dots sit at the centers of every third Gray cell, so a decode that is off
// by one cell (a stripe edge through the dot) still names the right dot.
export const SL_DEFAULTS = {gx: 6, gy: 4, cellsPerDot: 3, dotRadius: 0.014};
export function structuredLayout({gx = SL_DEFAULTS.gx, gy = SL_DEFAULTS.gy, cellsPerDot = SL_DEFAULTS.cellsPerDot} = {}) {
  const cellsX = gx * cellsPerDot;
  const cellsY = gy * cellsPerDot;
  const dots = [];
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) dots.push({i, j, x: (i + 0.5) / gx, y: (j + 0.5) / gy});
  return {gx, gy, cellsPerDot, cellsX, cellsY, bitsX: grayBitsFor(cellsX), bitsY: grayBitsFor(cellsY), dots};
}

// The pattern sequence the projector shows (after black + white).
export function structuredPatterns(layout) {
  const list = [];
  for (let b = 0; b < layout.bitsX; b++) for (const inverse of [false, true]) list.push({kind: 'gray', axis: 'x', bit: b, bits: layout.bitsX, cells: layout.cellsX, inverse});
  for (let b = 0; b < layout.bitsY; b++) for (const inverse of [false, true]) list.push({kind: 'gray', axis: 'y', bit: b, bits: layout.bitsY, cells: layout.cellsY, inverse});
  return list;
}

// Paint one pattern into a 2D context (projector canvas). Shared by the live
// page and the tests so both draw exactly the same thing.
export function paintStructuredPattern(ctx, width, height, pattern, layout = structuredLayout()) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  if (pattern === 'white' || (pattern && pattern.kind === 'white')) ctx.fillRect(0, 0, width, height);
  else if (pattern && pattern.kind === 'gray') {
    const n = pattern.cells;
    for (let c = 0; c < n; c++) {
      if (!grayCellLit(c, pattern.bit, pattern.bits, pattern.inverse)) continue;
      if (pattern.axis === 'x') {
        const x0 = Math.round(c * width / n);
        const x1 = Math.round((c + 1) * width / n);
        ctx.fillRect(x0, 0, x1 - x0, height);
      } else {
        const y0 = Math.round(c * height / n);
        const y1 = Math.round((c + 1) * height / n);
        ctx.fillRect(0, y0, width, y1 - y0);
      }
    }
  } else if (pattern && pattern.kind === 'dots') {
    const r = Math.max(3, (pattern.radius || SL_DEFAULTS.dotRadius) * width);
    for (const d of pattern.dots || layout.dots) {
      ctx.beginPath();
      ctx.arc(d.x * width, d.y * height, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ------------------------------------------------ structured light: camera

// Luma plane of an RGBA frame (Uint8, ~0.2 ms at 480x360 on an iPhone 13).
export function lumaOf(frame) {
  if (!frame || !frame.data) return null;
  const n = frame.width * frame.height;
  const out = new Uint8Array(n);
  const d = frame.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  return out;
}

export function meanLuma(L, step = 7) {
  if (!L) return null;
  let s = 0, n = 0;
  for (let i = 0; i < L.length; i += step) { s += L[i]; n++; }
  return n ? s / n : null;
}

// Fraction of sampled pixels whose luma moved more than `delta`.
export function changedFraction(a, b, delta = 20, step = 5) {
  if (!a || !b || a.length !== b.length) return 1;
  let c = 0, n = 0;
  for (let i = 0; i < a.length; i += step) { if (Math.abs(a[i] - b[i]) > delta) c++; n++; }
  return n ? c / n : 1;
}

// Fraction of sampled pixels that got brighter by more than `delta`.
export function brightenedFraction(before, after, delta = 25, step = 5) {
  if (!before || !after || before.length !== after.length) return 0;
  let c = 0, n = 0;
  for (let i = 0; i < before.length; i += step) { if (after[i] - before[i] > delta) c++; n++; }
  return n ? c / n : 0;
}

// 4x4 block means: sensor noise drops ~4x, a pattern switch or a rolling-
// shutter tear does not, so "two frames agree" stays meaningful at high gain.
export function blockMeans(L, width, height, k = 4) {
  if (!L) return null;
  const bw = Math.floor(width / k);
  const bh = Math.floor(height / k);
  const out = new Uint8Array(bw * bh);
  const inv = 1 / (k * k);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      for (let y = by * k; y < by * k + k; y++) {
        const row = y * width + bx * k;
        for (let x = 0; x < k; x++) s += L[row + x];
      }
      out[by * bw + bx] = Math.round(s * inv);
    }
  }
  return out;
}

function averageLuma(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i] + 1) >> 1;
  return out;
}

// Every bright blob of lit - dark: hysteresis threshold off the frame's own
// noise (median + 8 MAD), brightness-weighted centroid = sub-pixel center.
export function detectDiffBlobs(dark, lit, width, height, {minPixels = 3, maxFraction = 0.02, minDelta = 18, maxAspect = 3.2} = {}) {
  if (!dark || !lit || dark.length !== lit.length) return [];
  const n = width * height;
  const hist = new Uint32Array(511);
  for (let i = 0; i < n; i += 3) hist[lit[i] - dark[i] + 255]++;
  const total = hist.reduce((a, v) => a + v, 0);
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 511; v++) { acc += hist[v]; if (acc >= q * total) return v - 255; }
    return 255;
  };
  const med = pct(0.5);
  const madHist = new Uint32Array(511);
  for (let v = 0; v < 511; v++) madHist[Math.min(510, Math.abs(v - 255 - med))] += hist[v];
  let acc = 0;
  let mad = 0;
  for (let v = 0; v < 511; v++) { acc += madHist[v]; if (acc >= total / 2) { mad = v; break; } }
  const hi = Math.max(minDelta, med + 8 * Math.max(1, mad));
  const lo = Math.max(med + 3 * Math.max(1, mad), hi * 0.45);
  const seen = new Uint8Array(n);
  const maxPixels = Math.max(minPixels + 1, Math.round(n * maxFraction));
  const blobs = [];
  const stack = new Int32Array(n);
  let top = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || lit[start] - dark[start] < hi) continue;
    top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let sw = 0, sx = 0, sy = 0, count = 0, peak = 0;
    let x0 = width, x1 = 0, y0 = height, y1 = 0;
    while (top) {
      const p = stack[--top];
      const d = lit[p] - dark[p];
      const x = p % width;
      const y = (p - x) / width;
      const w = d - lo;
      sw += w; sx += (x + 0.5) * w; sy += (y + 0.5) * w; count++;
      if (d > peak) peak = d;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (y > 0) push(p - width);
      if (y < height - 1) push(p + width);
    }
    if (count < minPixels || count > maxPixels || !(sw > 0)) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.max(bw / bh, bh / bw) > maxAspect) continue;
    blobs.push({x: sx / sw, y: sy / sw, pixels: count, peak, w: bw, h: bh});
  }
  return blobs;
  function push(q) {
    if (seen[q]) return;
    if (lit[q] - dark[q] < lo) return;
    seen[q] = 1;
    stack[top++] = q;
  }
}

// Byte-identical on a sparse sample: a repeated video frame (live sensor
// noise always moves some pixels between real frames).
export function sameFrame(a, b, step = 97) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += step) if (a[i] !== b[i]) return false;
  return true;
}

// Same dot set in two frames: equal count, every dot within tol px of one.
export function sameDots(a, b, tol = 0.6) {
  if (!a || !b || a.length !== b.length) return false;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    if (best > tol) return false;
  }
  return true;
}

// Mean of a (2r+1)^2 patch, clamped to the frame.
export function patchMean(L, width, height, x, y, r = 1) {
  const cx = Math.round(x - 0.5);
  const cy = Math.round(y - 0.5);
  let s = 0, n = 0;
  for (let yy = Math.max(0, cy - r); yy <= Math.min(height - 1, cy + r); yy++) {
    for (let xx = Math.max(0, cx - r); xx <= Math.min(width - 1, cx + r); xx++) { s += L[yy * width + xx]; n++; }
  }
  return n ? s / n : 0;
}

// Name each blob by the Gray code under it. planes: {x: [{pos, neg}], y: [...]}.
export function identifyDots(blobs, planes, layout, width, height, {minContrast = 6} = {}) {
  const byId = new Map();
  for (const b of blobs) {
    const sample = (list) => decodeGraySamples(
      list.map(p => patchMean(p.pos, width, height, b.x, b.y)),
      list.map(p => patchMean(p.neg, width, height, b.x, b.y)),
      minContrast
    );
    const dx = sample(planes.x);
    const dy = sample(planes.y);
    if (!dx.ok || !dy.ok) continue;
    if (dx.value >= layout.cellsX || dy.value >= layout.cellsY) continue;
    const i = Math.floor(dx.value / layout.cellsPerDot);
    const j = Math.floor(dy.value / layout.cellsPerDot);
    const id = j * layout.gx + i;
    const score = Math.min(dx.contrast, dy.contrast) * Math.sqrt(b.pixels);
    const prev = byId.get(id);
    if (!prev || score > prev.score) byId.set(id, {id, i, j, x: b.x, y: b.y, pixels: b.pixels, score, cell: [dx.value, dy.value]});
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// io: {show(pattern|'black'|null), grab() -> frame, wait(ms), now(), alive(), report(state)}
// pattern: 'black' | 'white' | {kind:'gray'...} | {kind:'dots'}
// Returns {ok, quad, H, points, stats, found, expected, latencyMs, reason, frames}.
export const SL_TIMING = {sampleMs: 50, blackMinMs: 700, maxSettleMs: 2400, minPatternMs: 160, maxPatternMs: 1600, agreeDelta: 14, agreeFrac: 0.004, switchFrac: 0.002, dotAgreePx: 0.6};
export async function runStructuredLight(io, options = {}) {
  const layout = options.layout || structuredLayout(options);
  const scale = Number.isFinite(+options.scale) ? Math.max(0, +options.scale) : 1;
  const T = {...SL_TIMING, ...(options.timing || {})};
  const now = typeof io.now === 'function' ? io.now : () => Date.now();
  const wait = (ms) => (io.wait ? io.wait(ms) : new Promise(r => setTimeout(r, ms)));
  const alive = () => (io.alive ? io.alive() : true);
  const state = {kind: 'auto', state: 'running', message: 'Starting', step: 0, steps: 0, ok: null, frames: 0};
  const report = (extra = {}) => { Object.assign(state, extra); if (io.report) { try { io.report({...state}); } catch { /* cosmetic */ } } };
  const patterns = structuredPatterns(layout);
  state.steps = patterns.length + 4;
  let width = 0, height = 0, frameMeta = null;
  let lastFrameObj = null;
  let lastLuma = null;
  const grabLuma = () => {
    const f = io.grab();
    if (!f || !f.data || f === lastFrameObj) return null;
    lastFrameObj = f;
    if (!width) { width = f.width; height = f.height; frameMeta = f; }
    if (f.width !== width || f.height !== height) return null;
    const L = lumaOf(f);
    // The same video frame read twice (camera slower than our polling in a
    // dark room) is not a second opinion: skip exact repeats.
    if (lastLuma && sameFrame(lastLuma, L)) return null;
    lastLuma = L;
    state.frames++;
    return L;
  };
  // Hold a pattern until two back-to-back frames agree (no tear, no
  // switching) and brightness is steady; average those two.
  // Hold a pattern until two back-to-back frames agree (no tear, no
  // switching) and brightness is steady; average those two. accept(L) must
  // also pass: the frame really shows the new pattern, not the old one
  // still in flight (AirPlay / HDMI lag, a short latency estimate).
  const steady = async (minMs, maxMs, accept = null) => {
    if (minMs > 0) await wait(minMs);
    const start = now();
    let prev = null;
    let prevB = null;
    let prevMean = null;
    let last = null;
    for (let guard = 0; guard < 400; guard++) {
      if (!alive()) return null;
      const L = grabLuma();
      if (L) {
        const B = blockMeans(L, width, height);
        const m = meanLuma(B, 1);
        const ok = !accept || accept(L, B);
        if (ok) last = L;
        if (ok && prev && changedFraction(prevB, B, T.agreeDelta, 1) <= T.agreeFrac && prevMean != null && Math.abs(m - prevMean) <= Math.max(1.5, 0.04 * Math.max(m, prevMean))) return averageLuma(prev, L);
        prev = ok ? L : null;
        prevB = ok ? B : null;
        prevMean = ok ? m : null;
      }
      if (scale > 0 && now() - start > maxMs) break;
      if (scale === 0 && guard > 12) break;
      await wait(scale > 0 ? T.sampleMs : 0);
    }
    return last;
  };
  const differsFrom = (ref) => {
    const refB = ref ? blockMeans(ref, width, height) : null;
    return (L, B) => !refB || changedFraction(refB, B, 25, 1) >= T.switchFrac;
  };
  const fail = (reason) => { io.show(null); report({state: 'done', ok: false, reason}); return {ok: false, reason, frames: state.frames, kind: 'auto'}; };

  // 1. Black, then white: measures the phone -> projector -> camera delay so
  // every later pattern waits just long enough.
  report({message: 'Black', step: 1});
  io.show('black');
  const dark = await steady(T.blackMinMs * scale, T.maxSettleMs * scale);
  if (!alive()) return fail('cancelled');
  if (!dark) return fail('no camera frame');
  report({message: 'White (measuring projector delay)', step: 2});
  io.show('white');
  const t0 = now();
  let latencyMs = null;
  for (let guard = 0; guard < 200; guard++) {
    if (!alive()) return fail('cancelled');
    const L = grabLuma();
    // 40 levels, not 25: auto exposure still creeping up on the black frame
    // must not read as the projector turning on.
    if (L && brightenedFraction(dark, L, 40) > 0.01) { latencyMs = now() - t0; break; }
    if (scale > 0 && now() - t0 > T.maxSettleMs) break;
    if (scale === 0 && guard > 8) break;
    await wait(scale > 0 ? T.sampleMs : 0);
  }
  if (latencyMs == null && scale > 0) return fail('the camera never saw the projector light up');
  const white = await steady(0, T.maxSettleMs * scale, differsFrom(dark));
  if (!white) return fail('no camera frame');
  const patternMs = Math.round(Math.min(T.maxPatternMs, Math.max(T.minPatternMs, (latencyMs || 0) * 1.3 + 140)) * scale);
  // 2. Gray-code stripes, each bit then its inverse.
  const planes = {x: [], y: []};
  let previous = white;
  for (let k = 0; k < patterns.length; k += 2) {
    const pair = [];
    for (const p of [patterns[k], patterns[k + 1]]) {
      report({message: 'Stripes ' + p.axis.toUpperCase() + ' bit ' + (p.bit + 1) + '/' + p.bits + (p.inverse ? ' (inverse)' : ''), step: 3 + k + (p.inverse ? 1 : 0)});
      io.show(p);
      const L = await steady(patternMs, patternMs + T.maxPatternMs * scale, differsFrom(previous));
      if (!alive()) return fail('cancelled');
      if (!L) return fail('no camera frame');
      pair.push(L);
      previous = L;
    }
    planes[patterns[k].axis].push({pos: pair[0], neg: pair[1]});
  }
  // 3. Black, then the dot grid (both dim, so auto-exposure stays put).
  report({message: 'Dots', step: patterns.length + 3});
  io.show('black');
  const dark2 = await steady(patternMs, patternMs + T.maxPatternMs * scale, differsFrom(previous));
  if (!alive()) return fail('cancelled');
  if (!dark2) return fail('no camera frame');
  io.show({kind: 'dots', dots: layout.dots, radius: options.dotRadius || SL_DEFAULTS.dotRadius});
  // Dots: two frames in a row with the same dots at the same sub-pixel
  // spots. A rolling-shutter tear cuts dots in half and moves their
  // centroids, but touches too few pixels for the block test to see.
  let lit = null;
  {
    if (patternMs > 0) await wait(patternMs);
    const start = now();
    let prev = null;
    let prevBlobs = null;
    for (let guard = 0; guard < 400; guard++) {
      if (!alive()) break;
      const L = grabLuma();
      if (L) {
        const blobs = detectDiffBlobs(dark2, L, width, height);
        if (blobs.length >= 6 && prevBlobs && sameDots(prevBlobs, blobs, T.dotAgreePx)) { lit = averageLuma(prev, L); break; }
        if (blobs.length >= 6) { prev = L; prevBlobs = blobs; lit = lit || L; }
      }
      if (scale > 0 && now() - start > T.maxPatternMs * 2) break;
      if (scale === 0 && guard > 12) break;
      await wait(scale > 0 ? T.sampleMs : 0);
    }
  }
  io.show(null);
  if (!alive()) return fail('cancelled');
  if (!dark2 || !lit) return fail('no camera frame');
  const blobs = detectDiffBlobs(dark2, lit, width, height);
  const named = identifyDots(blobs, planes, layout, width, height, options);
  const expected = layout.dots.length;
  if (named.length < 6) return fail('found ' + named.length + ' of ' + expected + ' dots (need 6) · ' + blobs.length + ' blobs');
  const targets = layout.dots.map(d => ({x: d.x, y: d.y}));
  const measured = targets.map(() => null);
  for (const d of named) measured[d.id] = {x: d.x / width, y: d.y / height};
  const fit = robustHomography(targets, measured, {tol: options.tol || 0.005});
  if (!fit || fit.inlierCount < 6) return fail('dots did not agree on one floor map');
  const quad = quadFromH(fit.H);
  if (!quad || (io.validQuad && !io.validQuad(quad))) return fail('the fitted quad is not a usable stage');
  const vw = frameMeta && frameMeta.videoWidth > 0 ? frameMeta.videoWidth : width;
  const vh = frameMeta && frameMeta.videoHeight > 0 ? frameMeta.videoHeight : height;
  const points = pointResiduals(fit.H, targets, measured, {videoWidth: vw, videoHeight: vh, stageWidthCm: options.stageWidthCm, stageAspect: options.stageAspect, inliers: fit.inliers});
  const stats = residualStats(points);
  const out = {kind: 'auto', ok: true, quad, H: fit.H, points, stats, found: named.length, expected, blobs: blobs.length, latencyMs, frames: state.frames, stageWidthCm: options.stageWidthCm == null ? null : options.stageWidthCm};
  report({state: 'done', ok: true, points, stats, found: named.length, expected, latencyMs});
  return out;
}

// ------------------------------------------------------ verification pass

// Crosshair spots (stage 0-1), inside the sticker play area: four quarter
// points and the center. Walk check uses the same five in this order.
export const CROSSHAIR_TARGETS = [
  {x: 0.25, y: 0.3}, {x: 0.75, y: 0.3}, {x: 0.75, y: 0.72}, {x: 0.25, y: 0.72}, {x: 0.5, y: 0.51}
];
export const CROSSHAIR_MATCH = 0.07; // stage width fraction: a sticker farther than this is not on the crosshair

// Paint numbered crosshairs: a lit disc (so a sticker on it is lit and
// detectable) with tick marks that stop short of the center, where the
// sticker goes.
export function paintCrosshairs(ctx, width, height, targets = CROSSHAIR_TARGETS, {only = null, numbers = true} = {}) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const R = Math.max(14, 0.05 * width);
  targets.forEach((t, i) => {
    if (only != null && only !== i) return;
    const x = t.x * width;
    const y = t.y * height;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(2, width / 400);
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath();
      ctx.moveTo(x + ux * R * 0.42, y + uy * R * 0.42);
      ctx.lineTo(x + ux * R * 0.92, y + uy * R * 0.92);
      ctx.stroke();
    }
    if (numbers) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold ' + Math.round(R * 0.8) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + R * 1.55, y - R * 1.05);
    }
  });
  ctx.restore();
}

// Match sticker stage points (stage px, 1000 x 620 like the stage canvas) to
// targets (stage 0-1). Greedy nearest, each sticker used once.
export function matchStickers(targets, stickers, {stageW = 1000, stageH = 620, radius = CROSSHAIR_MATCH} = {}) {
  const pts = (stickers || []).filter(finitePt).map(p => ({x: +p.x / stageW, y: +p.y / stageH}));
  const pairs = [];
  targets.forEach((t, i) => pts.forEach((p, k) => {
    const d = Math.hypot((p.x - t.x), (p.y - t.y) * stageH / stageW);
    if (d <= radius) pairs.push({i, k, d});
  }));
  pairs.sort((a, b) => a.d - b.d);
  const out = targets.map(() => null);
  const used = new Set();
  for (const pr of pairs) {
    if (out[pr.i] || used.has(pr.k)) continue;
    out[pr.i] = pts[pr.k];
    used.add(pr.k);
  }
  return out;
}

// Offsets for a crosshair / walk check. found[i] = where the current map
// puts the sticker (stage 0-1); the crosshair was drawn at targets[i].
export function crosshairOffsets(targets, found, {quad = null, videoWidth = 480, videoHeight = 360, stageWidthCm = null, stageAspect = DEFAULT_STAGE_ASPECT} = {}) {
  const H = quad ? hFromQuad(quad) : null;
  return targets.map((t, i) => {
    const f = found[i];
    if (!finitePt(f)) return {i, found: false};
    const dxS = f.x - t.x;
    const dyS = f.y - t.y;
    let px = null;
    if (H) {
      const a = applyH(H, t.x, t.y);
      const b = applyH(H, f.x, f.y);
      if (a && b) px = Math.hypot((b.x - a.x) * videoWidth, (b.y - a.y) * videoHeight);
    }
    const aspect = stageAspect > 0 ? stageAspect : DEFAULT_STAGE_ASPECT;
    return {i, found: true, px: r2(px), cm: r1(stageCm(dxS, dyS, stageWidthCm, stageAspect)),
      dxCm: stageWidthCm > 0 ? r1(dxS * stageWidthCm) : null, dyCm: stageWidthCm > 0 ? r1(dyS * stageWidthCm / aspect) : null, inlier: true};
  });
}

// Correct the quad so each crosshair's stage point maps onto where the
// camera saw its sticker: camera-space affine (>= 3 spread points),
// similarity (2) or shift (1), applied to the quad corners.
export function crosshairCorrection(quad, targets, found, fitCorrection) {
  const H = hFromQuad(quad);
  if (!H || typeof fitCorrection !== 'function') return null;
  const src = [];
  const dst = [];
  targets.forEach((t, i) => {
    const f = found[i];
    if (!finitePt(f)) return;
    const a = applyH(H, t.x, t.y); // where the map says the crosshair is
    const b = applyH(H, f.x, f.y); // where the camera saw the sticker
    if (a && b) { src.push(a); dst.push(b); }
  });
  if (!src.length) return null;
  const T = fitCorrection(src, dst);
  if (!T) return null;
  const next = quad.map(p => ({x: T.a * p.x + T.b * p.y + T.c, y: T.d * p.x + T.e * p.y + T.f}));
  const shift = Math.max(...next.map((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y)));
  // Where each sticker lands under the corrected map (stage 0-1).
  const Hn = hFromQuad(next);
  const Hinv = Hn && invertH(Hn);
  const after = targets.map((t, i) => {
    const f = found[i];
    if (!finitePt(f) || !Hinv) return null;
    const cam = applyH(H, f.x, f.y);
    return cam ? applyH(Hinv, cam.x, cam.y) : null;
  });
  return {quad: next, shift, kind: T.kind, after};
}

// Verdict for an operator: within a sticker radius is fine for the show.
export const VERDICT_GOOD_CM = 2;
export const VERDICT_OK_CM = 5;
export function verdictFor(stats) {
  if (!stats || stats.maxCm == null) {
    if (!stats || stats.maxPx == null) return '';
    return stats.maxPx <= 3 ? '✓ tight' : stats.maxPx <= 8 ? '~ usable' : '⚠ off';
  }
  return stats.maxCm <= VERDICT_GOOD_CM ? '✓ tight' : stats.maxCm <= VERDICT_OK_CM ? '~ usable' : '⚠ off';
}

// --------------------------------------------------------- persistence

export const SAVED_KEY = 'nd.align.saved.v1';
export function readSavedCalibration(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = s && s.getItem(SAVED_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return {last: null, history: []};
    const ok = (e) => e && Array.isArray(e.quad) && e.quad.length === 4 && e.quad.every(finitePt);
    return {last: ok(data.last) ? data.last : null, history: Array.isArray(data.history) ? data.history.filter(ok).slice(0, 5) : []};
  } catch { return {last: null, history: []}; }
}
export function saveCalibration(storage, entry) {
  if (!entry || !Array.isArray(entry.quad) || entry.quad.length !== 4 || !entry.quad.every(finitePt)) return null;
  const clean = {
    quad: entry.quad.map(p => ({x: +(+p.x).toFixed(6), y: +(+p.y).toFixed(6)})),
    source: String(entry.source || '').slice(0, 24),
    savedAt: Number.isFinite(+entry.savedAt) ? +entry.savedAt : Date.now(),
    rmsPx: entry.rmsPx == null ? null : +entry.rmsPx,
    maxPx: entry.maxPx == null ? null : +entry.maxPx,
    maxCm: entry.maxCm == null ? null : +entry.maxCm,
    grid: entry.grid | 0 || null
  };
  const prev = readSavedCalibration(storage);
  const history = [clean].concat(prev.history).slice(0, 5);
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (s) s.setItem(SAVED_KEY, JSON.stringify({last: clean, history}));
  } catch { /* private mode: nothing saved */ }
  return clean;
}

// 1-point recheck: the dot at the stage center, compared with where the
// saved map puts it. Shift only (a bumped tripod), reported in px and cm.
export const RECHECK_TARGET = {x: 0.5, y: 0.51};
export const RECHECK_OK_CM = 2;
export const RECHECK_OK_PX = 4;
export function recheckResult(quad, measured, {videoWidth = 480, videoHeight = 360, stageWidthCm = null, stageAspect = DEFAULT_STAGE_ASPECT, target = RECHECK_TARGET} = {}) {
  const H = hFromQuad(quad);
  if (!H) return {kind: 'recheck', state: 'done', ok: false, reason: 'no saved alignment'};
  if (!finitePt(measured)) return {kind: 'recheck', state: 'done', ok: false, reason: 'the center dot was not seen (someone in the way, or the map is far off: run Auto align)'};
  const points = pointResiduals(H, [target], [measured], {videoWidth, videoHeight, stageWidthCm, stageAspect});
  const stats = residualStats(points);
  const p = points[0];
  const good = p.cm != null ? p.cm <= RECHECK_OK_CM : p.px <= RECHECK_OK_PX;
  return {kind: 'recheck', state: 'done', ok: true, points, stats, verdict: good ? '✓ still aligned' : '⚠ moved: run Auto align', stageWidthCm};
}
