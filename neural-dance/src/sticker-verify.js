// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Post-Align sticker check (TJ, Nov 10 10:26 AM: "Look at how the projection
// is offset from the stickers"). Align fits the screen; what the show needs is
// that a dancer drawn for a sticker lands ON that sticker. So: project a dot
// where the current map puts each sticker, find the dot in the camera,
// measure how far it lands from the sticker, and correct the quad by the
// camera-space transform that moves the dots onto the stickers. Then measure
// again, and keep the correction only if the residual went down.

import {findDots} from './align-refine.js';

export const VERIFY_DOT_RADIUS = 0.018; // stage width fraction
export const VERIFY_SEARCH = 0.13; // detect-frame width fraction around each sticker
export const VERIFY_OK_PX = 3; // mean residual (detect px, 480-wide frame) that needs no correction
export const VERIFY_MAX_SHIFT = 0.2; // biggest corner move a correction may make (camera 0-1)
export const VERIFY_MAX_PASSES = 3;
export const VERIFY_FRAMES = 3; // frames averaged per capture
export const VERIFY_AFFINE_SPREAD = 0.004; // ~ (6% of frame)^2: below this, stickers are too bunched for an affine

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Camera-space correction Q with Q(src[i]) ≈ dst[i]:
// 1 point translation, 2 points similarity, 3+ points least-squares affine.
export function fitCorrection(src, dst) {
  const n = Math.min(src.length, dst.length);
  if (!n) return null;
  if (n === 1) {
    const dx = dst[0].x - src[0].x;
    const dy = dst[0].y - src[0].y;
    return {kind: 'shift', a: 1, b: 0, c: dx, d: 0, e: 1, f: dy};
  }
  // Spread of the points: affine only when they span a real area, else a
  // similarity (shift + scale + rotation) that cannot shear wild corners.
  let area = 0;
  if (n >= 3) {
    const cx = src.reduce((s, p) => s + p.x, 0) / n;
    const cy = src.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of src.slice(0, n)) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
    area = Math.sqrt(Math.max(0, sxx * syy - sxy * sxy)) / n; // ~ spread^2
  }
  if (n === 2 || area < VERIFY_AFFINE_SPREAD) {
    // x' = s*x - r*y + tx ; y' = r*x + s*y + ty (least squares)
    const N = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const v = [0, 0, 0, 0];
    const add = (row, val) => { for (let r = 0; r < 4; r++) { for (let c = 0; c < 4; c++) N[r][c] += row[r] * row[c]; v[r] += row[r] * val; } };
    for (let i = 0; i < n; i++) {
      add([src[i].x, -src[i].y, 1, 0], dst[i].x);
      add([src[i].y, src[i].x, 0, 1], dst[i].y);
    }
    const s = solve(N, v);
    if (!s) return null;
    return {kind: 'similarity', a: s[0], b: -s[1], c: s[2], d: s[1], e: s[0], f: s[3]};
  }
  // Normal equations for x' = a x + b y + c, y' = d x + e y + f.
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Atx = [0, 0, 0];
  const Aty = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const row = [src[i].x, src[i].y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) AtA[r][c] += row[r] * row[c];
      Atx[r] += row[r] * dst[i].x;
      Aty[r] += row[r] * dst[i].y;
    }
  }
  const px = solve(AtA, Atx);
  const py = solve(AtA, Aty);
  if (!px || !py) return null;
  return {kind: 'affine', a: px[0], b: px[1], c: px[2], d: py[0], e: py[1], f: py[2]};
}

export function applyCorrection(T, p) {
  return {x: T.a * p.x + T.b * p.y + T.c, y: T.d * p.x + T.e * p.y + T.f};
}

export function correctQuad(quad, T) {
  if (!T || !Array.isArray(quad) || quad.length !== 4) return null;
  const next = quad.map(p => applyCorrection(T, p));
  const shift = Math.max(...next.map((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y)));
  return {quad: next, shift};
}

// stickers: [{x, y}] detect px. dots: [{x, y} | null] detect px.
export function residualStats(stickers, dots) {
  const list = [];
  for (let i = 0; i < stickers.length; i++) {
    const d = dots[i];
    if (!d) continue;
    list.push({i, dx: d.x - stickers[i].x, dy: d.y - stickers[i].y, px: Math.hypot(d.x - stickers[i].x, d.y - stickers[i].y)});
  }
  if (!list.length) return {found: 0, meanPx: null, maxPx: null, meanDx: null, meanDy: null, per: []};
  const mean = (k) => list.reduce((s, r) => s + r[k], 0) / list.length;
  return {
    found: list.length,
    meanPx: +mean('px').toFixed(2),
    maxPx: +Math.max(...list.map(r => r.px)).toFixed(2),
    meanDx: +mean('dx').toFixed(2),
    meanDy: +mean('dy').toFixed(2),
    per: list.map(r => ({i: r.i, dx: +r.dx.toFixed(2), dy: +r.dy.toFixed(2), px: +r.px.toFixed(2)}))
  };
}

function averageRgba(frames) {
  const list = frames.filter(f => f && f.data);
  if (!list.length) return null;
  const last = list[list.length - 1];
  if (list.length === 1) return last;
  const len = last.data.length;
  const out = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const f of list) s += f.data[i];
    out[i] = Math.round(s / list.length);
  }
  return {...last, data: out};
}

// io: {
//   stickers() -> [{x, y}] sticker centers, camera 0-1 (quad-free),
//   quad() -> current quad (camera 0-1), setQuad(quad) -> bool,
//   stageOf(quad, {x, y} camera 0-1) -> {x, y} stage 0-1,
//   show(dots | 'black' | null), wait(ms), grab(), alive(), report(state)
// }
export async function runStickerVerify(io, {settleMs = 900, frames = VERIFY_FRAMES, maxPasses = VERIFY_MAX_PASSES} = {}) {
  const report = (s) => { if (io.report) { try { io.report(s); } catch { /* cosmetic */ } } };
  const stickers = (io.stickers() || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 12);
  const startQuad = io.quad();
  const state = {stickers: stickers.length, passes: [], before: null, after: null, applied: false, stopped: '', done: false};
  if (!stickers.length || !Array.isArray(startQuad)) {
    state.stopped = !stickers.length ? 'no stickers' : 'no quad';
    state.done = true;
    report(state);
    return state;
  }
  const capture = async (mode) => {
    io.show(mode);
    await io.wait(settleMs);
    const got = [];
    for (let i = 0; i < frames; i++) {
      if (!io.alive()) return null;
      got.push(io.grab());
      if (i + 1 < frames) await io.wait(70);
    }
    return averageRgba(got);
  };
  const measure = async (quad) => {
    const dots = stickers.map(p => io.stageOf(quad, p));
    const dark = await capture('black');
    if (!dark || !io.alive()) return null;
    const lit = await capture(dots);
    if (!lit || !io.alive()) return null;
    const radius = VERIFY_SEARCH * lit.width;
    const px = stickers.map(p => ({x: p.x * lit.width, y: p.y * lit.height}));
    const found = findDots(dark.data, lit.data, lit.width, lit.height, px, radius, {nearest: true});
    return {found, stats: residualStats(px, found), width: lit.width, height: lit.height};
  };
  let quad = startQuad.map(p => ({x: p.x, y: p.y}));
  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      const m = await measure(quad);
      if (!m) { state.stopped = 'cancelled'; break; }
      const entry = {stats: m.stats, applied: false, kind: '', shift: 0};
      state.passes.push(entry);
      if (pass === 0) state.before = m.stats;
      state.after = m.stats;
      report(state);
      if (!m.stats.found) { state.stopped = 'dots not seen'; break; }
      if (m.stats.meanPx <= VERIFY_OK_PX) { state.stopped = 'on target'; break; }
      if (pass + 1 >= maxPasses) { state.stopped = 'pass limit'; break; }
      // Q maps where a sticker is to where its dot landed; the projector's
      // true stage corners are Q(current corners).
      const src = [];
      const dst = [];
      m.found.forEach((d, i) => {
        if (!d) return;
        src.push({x: stickers[i].x, y: stickers[i].y});
        dst.push({x: d.x / m.width, y: d.y / m.height});
      });
      const T = fitCorrection(src, dst);
      const next = T && correctQuad(quad, T);
      if (!next || !(next.shift <= VERIFY_MAX_SHIFT) || !io.setQuad(next.quad)) {
        state.stopped = next && next.shift > VERIFY_MAX_SHIFT ? 'correction too large' : 'correction refused';
        break;
      }
      entry.applied = true;
      entry.kind = T.kind;
      entry.shift = +next.shift.toFixed(4);
      quad = next.quad;
      state.applied = true;
    }
    // Keep a correction only if it helped.
    if (state.applied && state.before && state.after && state.after.meanPx != null && state.before.meanPx != null &&
        state.after.meanPx >= state.before.meanPx) {
      io.setQuad(startQuad);
      state.applied = false;
      state.stopped = 'reverted: residual did not improve';
    }
  } finally {
    io.show(null);
  }
  state.done = true;
  report(state);
  return state;
}

export function verifySummary(v) {
  if (!v) return '';
  if (!v.before) return 'Sticker check: ' + (v.stopped || 'not run');
  const b = v.before;
  const a = v.after || b;
  return 'Sticker check: ' + b.found + '/' + v.stickers + ' dots · before ' + b.meanPx + ' px (dx ' + b.meanDx + ', dy ' + b.meanDy + ')' +
    ' · after ' + a.meanPx + ' px' + (v.applied ? ' · corrected' : '') + (v.stopped ? ' · ' + v.stopped : '');
}
