// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// White stickers on the painting (TJ Nov 11 3:41-4:06 PM). The colour
// detector looks for dark, saturated blobs and latched dark paint instead.
// A white sticker is a small bright, low-saturation blob that stands out
// from its local surround, on light sky and on dark ground alike, and sits
// inside the painting (never on the frame / corner labels). Run it on the
// scan's white-flash frame (projected content becomes uniform light, so a
// projected dancer cannot pass for a sticker); on normal frames a stored
// bare-painting reference, when given, must also show the blob is new.

import {pointInQuad, insetQuad} from './painting-frame.js';

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export const WHITE_STICKER = {
  radius: 7,          // local-surround box radius (px at 480 wide)
  minRise: 16,        // brighter than the surround by at least this (a figure on a bright ray is dimmer)
  riseFrac: 0.12,     // ...or this fraction of the surround
  minLum: 85,
  maxSat: 0.30,       // white figures only; yellow paint and the projected ring stay out
  minArea: 8,
  maxArea: 170,
  minH: 6,
  maxW: 18,
  maxH: 34,
  minAspect: 1.15,    // the figures are taller than wide
  refRise: 18,        // vs bare reference (when given)
  inset: 0.04         // a tight frame must still include the figures
};

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, n = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w) { acc += src[y * w + x + r]; n++; }
      if (x - r - 1 >= 0) { acc -= src[y * w + x - r - 1]; n--; }
      if (x >= 0) tmp[y * w + x] = acc / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
      if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
      if (y >= 0) out[y * w + x] = acc / n;
    }
  }
  return out;
}

// quad: painting frame inner edge in this frame's px. reference: optional
// Float32Array/Uint8Array luminance of the bare painting (same size).
export function detectWhiteStickers(rgba, width, height, {quad, reference = null, projected = null, ...opts} = {}) {
  const P = {...WHITE_STICKER, ...opts};
  const w = width | 0, h = height | 0;
  if (!rgba || !quad || quad.length !== 4) return {ok: false, stickers: [], reason: 'no painting quad'};
  const zone = insetQuad(quad, P.inset);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const c of zone) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return {ok: true, stickers: [], rejected: {area: 0, shape: 0, ref: 0, projected: 0}, zone};
  // Work on the painting's bounding box (plus the blur radius) only: about a
  // third of the camera frame, so ~3x cheaper per detect tick on the phone.
  const bx0 = Math.max(0, x0 - P.radius), by0 = Math.max(0, y0 - P.radius);
  const bx1 = Math.min(w - 1, x1 + P.radius), by1 = Math.min(h - 1, y1 + P.radius);
  const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1;
  const L = new Float32Array(cw * ch), S = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const p = ((y + by0) * w + x + bx0) * 4, i = y * cw + x;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    L[i] = lum(r, g, b);
    const mx = Math.max(r, g, b);
    S[i] = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const samples = [];
  for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x += 3) {
    if (!pointInQuad(zone, x, y)) continue;
    samples.push(L[(y - by0) * cw + (x - bx0)]);
  }
  if (samples.length) {
    samples.sort((a, b) => a - b);
    const med = samples[samples.length >> 1];
    const scale = Math.min(1, w / 480);
    P.minH = Math.max(3, Math.round(P.minH * scale));
    P.minArea = Math.max(4, Math.round(P.minArea * scale));
    // A white scan sheet lifts the whole painting. The figures are a smaller
    // step above that sheet, and they stay small on a 480-wide detect grid.
    if (med >= 190) {
      P.minRise = Math.min(P.minRise, 8);
      P.minLum = Math.min(P.minLum, 70);
      P.maxSat = Math.max(P.maxSat, 0.4);
      P.minAspect = Math.min(P.minAspect, 1);
    }
  }
  const bg = boxBlur(L, cw, ch, P.radius);
  const mask = new Uint8Array(cw * ch);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y - by0) * cw + (x - bx0);
    if (L[i] < P.minLum || S[i] > P.maxSat) continue;
    const rise = L[i] - bg[i];
    if (reference) {
      // With a bare-painting reference the blob is what is NEW: painted
      // highlights (speaker edges, sky streaks) are in the reference too, and
      // a sticker on the light sky stays separate from the streak it touches.
      if (L[i] - reference[y * w + x] < P.refRise || rise < P.minRise * 0.5) continue;
    } else if (rise < Math.max(P.minRise, bg[i] * P.riseFrac)) continue;
    if (!pointInQuad(zone, x, y)) continue;
    mask[i] = 1;
  }
  const seen = new Uint8Array(cw * ch), q = new Int32Array(cw * ch), out = [], rejected = {area: 0, shape: 0, ref: 0, projected: 0};
  for (let s0 = 0; s0 < cw * ch; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    let head = 0, tail = 0; q[tail++] = s0; seen[s0] = 1;
    let n = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = 0, maxY = 0, lsum = 0, rsum = 0;
    while (head < tail) {
      const i = q[head++], lx = i % cw, ly = (i / cw) | 0, x = lx + bx0, y = ly + by0;
      n++; sx += x; sy += y; lsum += L[i]; rsum += reference ? L[i] - reference[y * w + x] : 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = lx + dx, Y = ly + dy; if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
        const j = Y * cw + X; if (mask[j] && !seen[j]) { seen[j] = 1; q[tail++] = j; }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (n < P.minArea || n > P.maxArea) { rejected.area++; continue; }
    if (bh < P.minH || bw > P.maxW || bh > P.maxH || bh / bw < P.minAspect) { rejected.shape++; continue; }
    const cx = sx / n, cy = sy / n;
    if (reference && rsum / n < P.refRise) { rejected.ref++; continue; }
    if (projected && projected(cx, cy)) { rejected.projected++; continue; }
    out.push({x: cx, y: cy, area: n, w: bw, h: bh, lum: lsum / n, kind: 'sticker', color: 'white'});
  }
  return {ok: true, stickers: out, rejected, zone};
}

// Score detections against labels: every positive found within `radius`,
// and no detection within `radius` of a negative.
export function scoreWhiteStickers(found, positives = [], negatives = [], radius = 10) {
  const hit = p => found.some(f => Math.hypot(f.x - p.x, f.y - p.y) <= radius);
  const missed = positives.filter(p => !hit(p));
  const falseAt = negatives.filter(n => hit(n));
  const extra = found.filter(f => !positives.some(p => Math.hypot(f.x - p.x, f.y - p.y) <= radius));
  return {found: positives.length - missed.length, positives: positives.length, missed, falseAt, extra};
}

// Projected dancers sweep across the painting; a sticker does not move. A
// blob only latches after it is seen at the same spot in `hits` of the last
// `window` frames (or in one white-flash frame, flash=true).
export function createWhiteStickerTracker({hits = 4, window = 6, radius = 8} = {}) {
  let history = [];
  return {
    push(found, {flash = false} = {}) {
      history.push((found || []).map(f => ({x: f.x, y: f.y})));
      if (history.length > window) history = history.slice(-window);
      if (flash) return (found || []).map(f => ({...f, latched: true}));
      const out = [];
      for (const f of history[history.length - 1]) {
        let n = 0, sx = 0, sy = 0;
        for (const frame of history) {
          const m = frame.find(g => Math.hypot(g.x - f.x, g.y - f.y) <= radius);
          if (m) { n++; sx += m.x; sy += m.y; }
        }
        if (n >= hits && !out.some(o => Math.hypot(o.x - f.x, o.y - f.y) <= radius)) out.push({x: sx / n, y: sy / n, kind: 'sticker', color: 'white', seen: n});
      }
      return out;
    },
    clear() { history = []; }
  };
}
