// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Stickers are whatever changed on the painting since the last white capture.
// Color and brightness both count (gold, silver, pink, blue, white). A bright
// brushstroke that was already in the baseline does not. Large or skinny
// regions are a person, a hand, or a stroke, not a sticker. A slow lighting
// change and a clipped sun bloom are not stickers either: only a crisp blob
// that matches a Cameo dancer silhouette is.

import {pointInQuad} from './painting-frame.js';

export const CHANGE_STICKER = {
  lumDelta: 42,
  colorDelta: 56,
  minArea: 10,
  maxArea: 0.18,
  maxSide: 0.42,
  minFill: 0.34,
  maxAspect: 2.6,
  // Stills stay on the full painting. Detection pulls in from the edge so
  // the frame, the browser chrome, and an unlit overhang are not dancers.
  inset: 0,
  detectInset: 0.03,
  dedupe: 10,
  blur: 2
};

// Rectified scan grid. Continuous tracking stays on the 480-wide detect
// canvas. A white-hold scan feeds native video, and the warp follows that
// quad up to about 960 px so a dancer's limbs stay a few pixels wide.
// Share of the hot-pixel bars a pixel needs to join a piece it touches.
export const STICKER_WEAK = 0.6;
export const WARP_MAX_W = 960;
export const WARP_MAX_H = 720;
const WARP_REF_W = 360;

export function warpGridSize(edgeW, edgeH) {
  const ew = Math.max(1, +edgeW || 1);
  const eh = Math.max(1, +edgeH || 1);
  const fit = Math.min(1, WARP_MAX_W / ew, WARP_MAX_H / eh);
  return {
    gw: Math.max(24, Math.round(ew * fit)),
    gh: Math.max(24, Math.round(eh * fit))
  };
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function pixelChanged(r, g, b, r0, g0, b0, opts = CHANGE_STICKER) {
  const dl = Math.abs(lum(r, g, b) - lum(r0, g0, b0));
  const dc = Math.max(Math.abs(r - r0), Math.abs(g - g0), Math.abs(b - b0));
  return dl >= opts.lumDelta || dc >= opts.colorDelta;
}

function refChannels(reference, pixels) {
  if (!reference) return 0;
  if (reference.length === pixels * 4) return 4;
  if (reference.length === pixels * 3) return 3;
  return 0;
}

function refRgb(reference, channels, i) {
  const o = i * channels;
  return [reference[o], reference[o + 1], reference[o + 2]];
}

function lerp2(a, b, t) {
  return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
}
function quadPoint(quad, u, v) {
  return lerp2(lerp2(quad[0], quad[1], u), lerp2(quad[3], quad[2], u), v);
}
function sampleRgb(src, channels, w, h, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const at = (xx, yy) => {
    const i = (yy * w + xx) * channels;
    return [src[i], src[i + 1], src[i + 2]];
  };
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  const mix = (p, q, t) => p + (q - p) * t;
  return [0, 1, 2].map(k => mix(mix(a[k], b[k], tx), mix(c[k], d[k], tx), ty));
}
function rectify(src, channels, w, h, quad, gw, gh) {
  const out = new Float32Array(gw * gh * 3);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const u = gw <= 1 ? 0 : x / (gw - 1);
    const v = gh <= 1 ? 0 : y / (gh - 1);
    const p = quadPoint(quad, u, v);
    const rgb = sampleRgb(src, channels, w, h, p.x, p.y);
    const o = (y * gw + x) * 3;
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2];
  }
  return out;
}
// Median of one channel, using only midtones so a clipped sun does not set the gain.
function midtoneMedian(buf, c, lo = 30, hi = 220) {
  const n = (buf.length / 3) | 0;
  const vals = [];
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const m = Math.max(buf[o], buf[o + 1], buf[o + 2]);
    if (m >= lo && m <= hi) vals.push(buf[o + c]);
  }
  const col = vals.length >= 16 ? vals : null;
  if (!col) {
    const all = new Float32Array(n);
    for (let i = 0; i < n; i++) all[i] = buf[i * 3 + c];
    all.sort();
    return all[n >> 1] || 1;
  }
  col.sort((a, b) => a - b);
  return col[col.length >> 1] || 1;
}
// Put this capture on the same gain and white balance as the baseline.
// Scaled RGB is clamped: an unclipped product above 255 was inflating deltas
// on already-bright sun pixels.
function matchCapture(src, ref) {
  const out = new Float32Array(src.length);
  const gains = [1, 1, 1];
  for (let c = 0; c < 3; c++) {
    gains[c] = midtoneMedian(ref, c) / Math.max(1, midtoneMedian(src, c));
    for (let i = c; i < src.length; i += 3) {
      const v = src[i] * gains[c];
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return {rgb: out, gains};
}
// Separable box blur. Each window is 2*radius+1 samples with the edge pixel
// repeated past the border, matching the old clamped nested loops, in O(W*H).
export function blurPlane(src, w, h, radius) {
  const r = Math.max(0, radius | 0);
  if (!r) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = r * 2 + 1;
  const padW = w + r * 2;
  const padH = h + r * 2;
  const pad = new Float64Array(Math.max(padW, padH));
  const prefix = new Float64Array(pad.length + 1);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const left = src[row * 3 + c];
      const right = src[(row + w - 1) * 3 + c];
      for (let i = 0; i < r; i++) pad[i] = left;
      for (let x = 0; x < w; x++) pad[r + x] = src[(row + x) * 3 + c];
      for (let i = 0; i < r; i++) pad[r + w + i] = right;
      prefix[0] = 0;
      for (let i = 0; i < padW; i++) prefix[i + 1] = prefix[i] + pad[i];
      for (let x = 0; x < w; x++) tmp[(row + x) * 3 + c] = (prefix[x + span] - prefix[x]) / span;
    }
  }
  for (let c = 0; c < 3; c++) {
    for (let x = 0; x < w; x++) {
      const top = tmp[x * 3 + c];
      const bottom = tmp[((h - 1) * w + x) * 3 + c];
      for (let i = 0; i < r; i++) pad[i] = top;
      for (let y = 0; y < h; y++) pad[r + y] = tmp[(y * w + x) * 3 + c];
      for (let i = 0; i < r; i++) pad[r + h + i] = bottom;
      prefix[0] = 0;
      for (let i = 0; i < padH; i++) prefix[i + 1] = prefix[i] + pad[i];
      for (let y = 0; y < h; y++) out[(y * w + x) * 3 + c] = (prefix[y + span] - prefix[y]) / span;
    }
  }
  return out;
}
// Square dilation, separable. A pixel is set when any sample in the clamped
// (2*radius+1) square is set — the same mask the nested loops wrote.
export function dilateMask(mask, w, h, radius) {
  const r = Math.max(0, radius | 0);
  if (!r) return mask;
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const prefix = new Uint32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    prefix[0] = 0;
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + (mask[row + x] ? 1 : 0);
    for (let x = 0; x < w; x++) {
      const lo = x > r ? x - r : 0;
      const hi = x + r < w ? x + r : w - 1;
      if (prefix[hi + 1] !== prefix[lo]) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    prefix[0] = 0;
    for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y > r ? y - r : 0;
      const hi = y + r < h ? y + r : h - 1;
      if (prefix[hi + 1] !== prefix[lo]) out[y * w + x] = 1;
    }
  }
  return out;
}
// A clipped sun, or a pixel inside the dilated baseline highlight, only counts
// when the change is chromatic. A luminance bloom stays quiet.
function pixelHot(hp, cur, base, idx, hi, opts) {
  const o = idx * 3;
  const r = hp[o], g = hp[o + 1], b = hp[o + 2];
  const dl = Math.abs(lum(r, g, b));
  const dc = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
  const mean = (r + g + b) / 3;
  const spread = Math.max(Math.abs(r - mean), Math.abs(g - mean), Math.abs(b - mean));
  const baseMax = Math.max(base[o], base[o + 1], base[o + 2]);
  const curMax = Math.max(cur[o], cur[o + 1], cur[o + 2]);
  const nearClip = hi || baseMax >= 230 || curMax >= 230;
  // A sticker laid on clipped sky darkens it to a clearly unclipped tone. A
  // bloom or sun drift brightens, or stays near clip, so this cannot fire.
  if (nearClip && -lum(r, g, b) >= opts.lumDelta * 1.5 && curMax < 200) return true;
  if (nearClip) {
    if (spread < 22) return false;
    if (baseMax >= 230 && curMax >= 230 && spread < 48) return false;
    return dc >= opts.colorDelta || spread >= 28;
  }
  return dl >= opts.lumDelta || dc >= opts.colorDelta;
}
function hotCount(hp, cur, base, highlight, w, h, x, y, opts) {
  if (!pixelHot(hp, cur, base, y * w + x, highlight[y * w + x], opts)) return 0;
  let hot = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    if (pixelHot(hp, cur, base, yy * w + xx, highlight[yy * w + xx], opts)) hot++;
  }
  return hot;
}
function edgeContrast(mask, mag, w, h, minX, minY, maxX, maxY, ring = 3) {
  let inner = 0, inN = 0, outer = 0, outN = 0, bound = 0, boundN = 0;
  const band = Math.max(2, ring | 0);
  // band 3 keeps the tuned split: interior at >=2 px, halo at 2–3 px.
  const innerAt = Math.max(2, Math.round(band * 2 / 3));
  const x0 = Math.max(0, minX - band), y0 = Math.max(0, minY - band);
  const x1 = Math.min(w - 1, maxX + band), y1 = Math.min(h - 1, maxY + band);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    let nearest = band + 6;
    if (mask[i]) {
      for (let dy = -band; dy <= band; dy++) for (let dx = -band; dx <= band; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx]) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d < nearest) nearest = d;
        }
      }
      if (nearest >= innerAt) { inner += mag[i]; inN++; }
      else { bound += mag[i]; boundN++; }
    } else {
      for (let dy = -band; dy <= band; dy++) for (let dx = -band; dx <= band; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx]) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d < nearest) nearest = d;
      }
      if (nearest >= innerAt && nearest <= band) { outer += mag[i]; outN++; }
    }
  }
  const edge = boundN ? bound / boundN : (inN ? inner / inN : 0);
  const outMean = outN ? outer / outN : 0;
  return {crisp: edge - outMean, inner: inN ? inner / inN : edge, outer: outMean};
}
function planeRgb(buf) {
  const out = new Uint8ClampedArray(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}
function heatRgb(mag, n) {
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, mag[i] / 110));
    const o = i * 3;
    out[o] = t < 0.5 ? (30 + 80 * t) | 0 : (70 + 185 * (t - 0.5) * 2) | 0;
    out[o + 1] = t < 0.5 ? (24 + 40 * t) | 0 : (44 + 200 * (t - 0.5) * 2) | 0;
    out[o + 2] = t < 0.5 ? (48 + 160 * t * 2) | 0 : (208 - 150 * (t - 0.5) * 2) | 0;
  }
  return out;
}
function strokeBox(rgb, w, h, x0, y0, x1, y1, color) {
  const plot = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 3;
    rgb[o] = color[0]; rgb[o + 1] = color[1]; rgb[o + 2] = color[2];
  };
  for (let t = 0; t < 2; t++) {
    for (let x = x0; x <= x1; x++) { plot(x, y0 + t); plot(x, y1 - t); }
    for (let y = y0; y <= y1; y++) { plot(x0 + t, y); plot(x1 - t, y); }
  }
}
function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToBytes(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function scaleRgb(src, w, h, tw) {
  const th = Math.max(16, Math.round(h * tw / w));
  const out = new Uint8ClampedArray(tw * th * 3);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, (y * h / th) | 0);
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, (x * w / tw) | 0);
      const s = (sy * w + sx) * 3, d = (y * tw + x) * 3;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
    }
  }
  return {rgb: out, w: tw, h: th};
}
function quant555(rgb) {
  const n = (rgb.length / 3) | 0;
  const out = new Uint8Array(n * 2);
  for (let i = 0, p = 0; i < n; i++, p += 2) {
    const o = i * 3;
    const R = Math.max(0, Math.min(31, Math.round(rgb[o] * 31 / 255)));
    const G = Math.max(0, Math.min(31, Math.round(rgb[o + 1] * 31 / 255)));
    const B = Math.max(0, Math.min(31, Math.round(rgb[o + 2] * 31 / 255)));
    const v = (R << 10) | (G << 5) | B;
    out[p] = (v >> 8) & 255;
    out[p + 1] = v & 255;
  }
  return out;
}
function lzPack(src) {
  const out = [];
  const n = src.length;
  const W = 96;
  let i = 0;
  while (i < n) {
    let bestL = 0, bestD = 0;
    const maxL = Math.min(63, n - i);
    const from = Math.max(0, i - W);
    if (maxL >= 4) {
      for (let j = i - 1; j >= from; j--) {
        if (src[j] !== src[i]) continue;
        let l = 1;
        while (l < maxL && src[j + l] === src[i + l]) l++;
        if (l > bestL) { bestL = l; bestD = i - j; if (l >= 24) break; }
      }
    }
    if (bestL >= 4 && bestD > 0) {
      out.push(0x80 | bestL, (bestD >> 8) & 255, bestD & 255);
      i += bestL;
      continue;
    }
    const start = i;
    i++;
    while (i < n && i - start < 128) {
      let stop = false;
      if (i + 3 < n) {
        const f2 = Math.max(0, i - 48);
        for (let j = i - 1; j >= f2; j--) {
          if (src[j] === src[i] && src[j + 1] === src[i + 1] && src[j + 2] === src[i + 2] && src[j + 3] === src[i + 3]) { stop = true; break; }
        }
      }
      if (stop) break;
      i++;
    }
    const len = i - start;
    out.push(len - 1);
    for (let k = 0; k < len; k++) out.push(src[start + k]);
  }
  return Uint8Array.from(out);
}
function lzUnpack(src, expect) {
  const out = new Uint8Array(expect);
  let i = 0, o = 0;
  while (i < src.length && o < expect) {
    const b = src[i++];
    if (b & 0x80) {
      const len = b & 0x7f;
      if (i + 1 >= src.length) return null;
      const dist = (src[i] << 8) | src[i + 1];
      i += 2;
      if (!(dist > 0) || dist > o) return null;
      for (let k = 0; k < len && o < expect; k++) out[o] = out[o - dist], o++;
    } else {
      const len = b + 1;
      if (i + len > src.length) return null;
      for (let k = 0; k < len && o < expect; k++) out[o++] = src[i++];
    }
  }
  return o === expect ? out : null;
}
// Rectified debug thumbnail. Width stays at or under 120 so three photographic
// frames (before, after, diff) fit the telemetry budget. A browser canvas
// sends JPEG; Node and a canvas miss keep the ndt1 fallback.
export const THUMB_MAX_W = 120;
function jpegRgb(rgb, w, h, tw, th, quality) {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return '';
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') return '';
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') return '';
    const image = ctx.createImageData(tw, th);
    for (let y = 0; y < th; y++) {
      const sy = Math.min(h - 1, (y * h / th) | 0);
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(w - 1, (x * w / tw) | 0);
        const s = (sy * w + sx) * 3;
        const d = (y * tw + x) * 4;
        image.data[d] = rgb[s];
        image.data[d + 1] = rgb[s + 1];
        image.data[d + 2] = rgb[s + 2];
        image.data[d + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (typeof url === 'string' && url.startsWith('data:image/jpeg') && url.length > 32) return url;
  } catch { /* ndt1 fallback */ }
  return '';
}
function jpegThumb(rgb, w, h, maxW) {
  const cap = Math.max(32, Math.min(THUMB_MAX_W, maxW | 0 || THUMB_MAX_W));
  const tw = Math.min(cap, w);
  const th = Math.max(16, Math.round(h * tw / Math.max(1, w)));
  return jpegRgb(rgb, w, h, tw, th, 0.62);
}
// Warp-resolution JPEG for the debug still upload. Node keeps the ndt1 thumb.
export function packScanStill(rgb, w, h) {
  if (!rgb || !(w > 1) || !(h > 1)) return '';
  const jpeg = jpegRgb(rgb, w, h, w, h, 0.82);
  if (jpeg) return jpeg;
  return packThumb(rgb, w, h);
}
export function packThumb(rgb, w, h, maxW = THUMB_MAX_W) {
  if (!rgb || !(w > 1) || !(h > 1)) return '';
  const cap = Math.max(32, Math.min(THUMB_MAX_W, maxW | 0 || THUMB_MAX_W));
  const jpeg = jpegThumb(rgb, w, h, cap);
  if (jpeg) return jpeg;
  const tw = Math.min(cap, w);
  const scaled = tw === w ? {rgb, w, h} : scaleRgb(rgb, w, h, tw);
  const q = quant555(scaled.rgb);
  const z = lzPack(q);
  const head = new Uint8Array(8 + z.length);
  head[0] = scaled.w >> 8; head[1] = scaled.w & 255;
  head[2] = scaled.h >> 8; head[3] = scaled.h & 255;
  head[4] = (q.length >>> 24) & 255; head[5] = (q.length >> 16) & 255;
  head[6] = (q.length >> 8) & 255; head[7] = q.length & 255;
  head.set(z, 8);
  return 'ndt1:' + bytesToB64(head);
}
export function unpackThumb(text) {
  if (typeof text !== 'string' || text.slice(0, 5) !== 'ndt1:') return null;
  let raw;
  try { raw = b64ToBytes(text.slice(5)); } catch { return null; }
  if (!raw || raw.length < 8) return null;
  const w = (raw[0] << 8) | raw[1];
  const h = (raw[2] << 8) | raw[3];
  const n = ((raw[4] << 24) | (raw[5] << 16) | (raw[6] << 8) | raw[7]) >>> 0;
  if (!(w >= 16) || !(h >= 16) || w > 240 || h > 240 || n !== w * h * 2) return null;
  const pix = lzUnpack(raw.subarray(8), n);
  if (!pix) return null;
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, p = 0; p < n; i += 3, p += 2) {
    const v = (pix[p] << 8) | pix[p + 1];
    rgb[i] = Math.round(((v >> 10) & 31) * 255 / 31);
    rgb[i + 1] = Math.round(((v >> 5) & 31) * 255 / 31);
    rgb[i + 2] = Math.round((v & 31) * 255 / 31);
  }
  return {w, h, rgb};
}

function shrinkThumb(packed, maxW) {
  const img = unpackThumb(packed);
  if (!img) return '';
  if (img.w <= maxW) return packed;
  return packThumb(img.rgb, img.w, img.h, maxW);
}

// Keep lastScan when the thumbnails are heavy: shrink them, and only then
// drop the pictures. Metadata and the candidate rows stay.
export function fitScanPayload(scan, cap = 130000) {
  if (!scan || typeof scan !== 'object') return null;
  const under = (value) => {
    let text;
    try { text = JSON.stringify(value); } catch { return null; }
    if (!text || text.length > cap) return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  const full = under(scan);
  if (full) return full;
  for (const tw of [96, 72]) {
    const next = {
      ...scan,
      before: shrinkThumb(scan.before, tw),
      after: shrinkThumb(scan.after, tw),
      diff: shrinkThumb(scan.diff, tw)
    };
    const got = under(next);
    if (got) return got;
  }
  const bare = {...scan};
  delete bare.before;
  delete bare.after;
  delete bare.diff;
  const kept = under(bare);
  if (kept) return kept;
  return under({
    kind: scan.kind || 'scan',
    at: scan.at || 0,
    settleMs: scan.settleMs,
    wb: scan.wb || null,
    gains: scan.gains || null,
    blobs: Array.isArray(scan.blobs) ? scan.blobs.slice(0, 8) : [],
    rejected: scan.rejected || null
  });
}

// WebSocket lastScan: scores and flags only. The sharp JPEGs go over HTTP.
export function slimScanTelemetry(scan) {
  if (!scan || typeof scan !== 'object') return null;
  const blobs = Array.isArray(scan.blobs) ? scan.blobs.slice(0, 12) : [];
  const rejected = scan.rejected && typeof scan.rejected === 'object' ? scan.rejected : null;
  let rejectedN = 0;
  if (rejected) for (const key of Object.keys(rejected)) rejectedN += +rejected[key] || 0;
  const accepted = blobs.filter(blob => blob && blob.reason === 'accept').length;
  const images = {
    before: !!(scan.before || (scan.images && scan.images.before)),
    after: !!(scan.after || (scan.images && scan.images.after)),
    diff: !!(scan.diff || (scan.images && scan.images.diff))
  };
  return {
    kind: scan.kind === 'relearn' ? 'relearn' : 'scan',
    at: +scan.at || 0,
    scanId: scan.scanId != null ? scan.scanId : (+scan.at || 0),
    settleMs: Number.isFinite(+scan.settleMs) ? Math.round(+scan.settleMs) : null,
    wb: scan.wb && typeof scan.wb === 'object' ? {locked: scan.wb.locked === true, mode: typeof scan.wb.mode === 'string' ? scan.wb.mode : null} : null,
    gains: Array.isArray(scan.gains) ? scan.gains.slice(0, 3).map(n => +n) : null,
    blobs,
    rejected,
    accepted,
    rejectedN,
    images,
    compare: scan.compare !== false
  };
}

// Medoids of 801 Cameo dancer figures, each an aspect-preserving 16×16 grid
// (longest side 16, centered, row-major, MSB = left). Mirror-invariant.
const DANCER_TEMPLATE_HEX = [
  '00000000024007e007c00fc00fc00fc00f800f800f800fc007e0038001000000',
  '00200020002001c003c003c003c003c007c001c001e001600160034002800200',
  '004007d03ff03ff01ff83ff03ff01ff01ff81ff80ff007e007c003c000800000',
  '0000000000082b301fb47ffe7dfc7d343dbc7fbe7fff7fd60818000000000000',
  '0280030003000380018001800180038003c001c001c001c001c001c001800000',
  '018001c001a002e003c0038003800380078007800380038003c007e001600000',
  '00000a001a000f000f0007000f8007800f8007f80fe00f000c000c0008000800',
  '0200008004800380038003800380038003800380028002c00240030003200020',
  '000000000000000000000f1c7ffe3ff0fff07fe0e03000000000000000000000',
  '00400f4007c00780078007c00fc0078003c003c003e003e00340062006000200',
  '00000200038003c0038003800380078006000700030003000300060003000200',
  '00200020004003c001c001c001c000c001c001c0034002400040014001000000',
  '08000800078007800b80078007c003e001e000f000e000c000e0008001000000',
  '06000600038007c007f8079007800780078006c004c00cc01840104010400060',
  '00000080004699ec5bef7dfffefe3ffe39ee39ee3dfe7ffe7ffc3daa4c000000',
  '0400060007000f800f601f0017800f0007000e000a000e000e00060006000600'
];
// Real dancers land near solidity 0.92 (IoU ~0.64–0.73, circularity
// ~0.49–0.53) from 480p through 1080p. Above solidFloor, a filled oval
// is rounder than 0.62 or misses the silhouette, so it still fails.
export const DANCER_GATE = {
  minIoU: 0.30,
  maxCircularity: 0.8,
  maxSolidity: 0.93,
  solidFloor: 0.90,
  solidIoU: 0.55,
  solidCircularity: 0.58,
  maxHoleFrac: 0.26,
  minAspect: 0.16,
  maxAspect: 1.8
};

export function dancerShapeReject(fig) {
  if (!fig) return true;
  const solid = +fig.solidity || 0;
  const iou = +fig.templateIoU || 0;
  const circ = +fig.circularity || 0;
  const aspect = +fig.aspect || 0;
  const highSolid = solid > DANCER_GATE.solidFloor;
  const solidFail = solid > DANCER_GATE.maxSolidity
    || (highSolid && (iou < DANCER_GATE.solidIoU || circ > DANCER_GATE.solidCircularity));
  return iou < DANCER_GATE.minIoU || solidFail || circ > DANCER_GATE.maxCircularity
    || aspect < DANCER_GATE.minAspect || aspect > DANCER_GATE.maxAspect;
}

function bitsFromHex(hex) {
  const bits = new Uint8Array(256);
  for (let row = 0; row < 16; row++) {
    const v = parseInt(hex.slice(row * 4, row * 4 + 4), 16);
    for (let x = 0; x < 16; x++) if ((v >>> (15 - x)) & 1) bits[row * 16 + x] = 1;
  }
  return bits;
}
function flipBits(bits) {
  const out = new Uint8Array(256);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + (15 - x)] = bits[y * 16 + x];
  return out;
}
const DANCER_TEMPLATES = DANCER_TEMPLATE_HEX.map(bitsFromHex);
const DANCER_FLIPPED = DANCER_TEMPLATES.map(flipBits);
export function dancerTemplateGrid(index = 0) {
  const bits = DANCER_TEMPLATES[index] || DANCER_TEMPLATES[0];
  return bits;
}

function gridIoU(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < 256; i++) {
    const onA = a[i], onB = b[i];
    if (onA || onB) union++;
    if (onA && onB) inter++;
  }
  return union ? inter / union : 0;
}
// Longest side of the ink becomes 16. The figure stays in proportion and sits
// in the middle of the 16×16. Row-major, and the caller compares both mirrors.
function packDancerGrid(pix, gw, minX, minY, bw, bh) {
  const bits = new Uint8Array(256);
  const long = Math.max(bw, bh, 1);
  const nw = Math.max(1, Math.min(16, Math.round(bw * 16 / long)));
  const nh = Math.max(1, Math.min(16, Math.round(bh * 16 / long)));
  const ox = (16 - nw) >> 1, oy = (16 - nh) >> 1;
  for (let p = 0; p < pix.length; p++) {
    const i = pix[p], x = i % gw, y = (i / gw) | 0;
    const ix = ox + Math.min(nw - 1, Math.floor((x - minX) * nw / bw));
    const iy = oy + Math.min(nh - 1, Math.floor((y - minY) * nh / bh));
    bits[iy * 16 + ix] = 1;
  }
  return bits;
}
function templateIoU(bits) {
  let best = 0;
  for (let t = 0; t < DANCER_TEMPLATES.length; t++) {
    const a = gridIoU(bits, DANCER_TEMPLATES[t]);
    const b = gridIoU(bits, DANCER_FLIPPED[t]);
    if (a > best) best = a;
    if (b > best) best = b;
  }
  return best;
}
function hullArea(pix, gw) {
  const pts = [];
  for (let p = 0; p < pix.length; p++) {
    const i = pix[p], x = i % gw, y = (i / gw) | 0;
    pts.push(x, y, x + 1, y, x + 1, y + 1, x, y + 1);
  }
  const n = pts.length >> 1;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o, a, b) => {
    const ox = pts[o * 2], oy = pts[o * 2 + 1];
    return (pts[a * 2] - ox) * (pts[b * 2 + 1] - oy) - (pts[a * 2 + 1] - oy) * (pts[b * 2] - ox);
  };
  const lower = [], upper = [];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop(); upper.pop();
  const h = lower.concat(upper);
  if (h.length < 3) return pix.length;
  let area = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    area += pts[a * 2] * pts[b * 2 + 1] - pts[b * 2] * pts[a * 2 + 1];
  }
  return Math.abs(area) / 2;
}
function gridMetrics(bits) {
  const pix = [];
  let minX = 16, minY = 16, maxX = 0, maxY = 0, n = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!bits[y * 16 + x]) continue;
    pix.push(y * 16 + x); n++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!n) return {circularity: 0, solidity: 1, holeFrac: 0};
  let perim = 0;
  for (let p = 0; p < pix.length; p++) {
    const i = pix[p], x = i % 16, y = (i / 16) | 0;
    if (x === 0 || !bits[i - 1]) perim++;
    if (x === 15 || !bits[i + 1]) perim++;
    if (y === 0 || !bits[i - 16]) perim++;
    if (y === 15 || !bits[i + 16]) perim++;
  }
  const circularity = perim > 0 ? (4 * Math.PI * n) / (perim * perim) : 0;
  const solidity = Math.min(1, n / Math.max(1, hullArea(pix, 16)));
  const seen = new Uint8Array(256), qq = [];
  const push = (x, y) => {
    if (x < minX - 1 || y < minY - 1 || x > maxX + 1 || y > maxY + 1) return;
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = y * 16 + x;
    if (bits[i] || seen[i]) return;
    seen[i] = 1; qq.push(i);
  };
  for (let x = Math.max(0, minX - 1); x <= Math.min(15, maxX + 1); x++) { push(x, Math.max(0, minY - 1)); push(x, Math.min(15, maxY + 1)); }
  for (let y = Math.max(0, minY - 1); y <= Math.min(15, maxY + 1); y++) { push(Math.max(0, minX - 1), y); push(Math.min(15, maxX + 1), y); }
  for (let h = 0; h < qq.length; h++) {
    const i = qq[h], x = i % 16, y = (i / 16) | 0;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  let holes = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (!bits[y * 16 + x] && !seen[y * 16 + x]) holes++;
  return {circularity, solidity, holeFrac: holes / Math.max(1, n + holes)};
}
function boxGap(a, b) {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - (Math.min(a.maxX, b.maxX) + 1));
  const dy = Math.max(0, Math.max(a.minY, b.minY) - (Math.min(a.maxY, b.maxY) + 1));
  return Math.hypot(dx, dy);
}

// A thin cutout breaks into limb-sized pieces. Join pieces that sit within
// about 1.5 sticker-widths, without gluing two already-whole dancers together
// or a horizontal run of specks into one sticker.
function mergeNearbyFragments(parts, bridge, minArea, maxSide, stickerW) {
  const n = parts.length;
  const parent = new Uint32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    let y = i;
    while (parent[y] !== x) { const z = parent[y]; parent[y] = x; y = z; }
    return x;
  };
  const whole = (p) => (p.maxY - p.minY + 1) >= stickerW * 2.2 && p.n >= minArea;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (boxGap(parts[i], parts[j]) > bridge) continue;
    if (whole(parts[i]) && whole(parts[j])) continue;
    const minX = Math.min(parts[i].minX, parts[j].minX);
    const minY = Math.min(parts[i].minY, parts[j].minY);
    const maxX = Math.max(parts[i].maxX, parts[j].maxX);
    const maxY = Math.max(parts[i].maxY, parts[j].maxY);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw > maxSide || bh > maxSide) continue;
    if (bw > bh * 1.35 && bw > stickerW * 2) continue;
    const a = find(i), b = find(j);
    if (a !== b) parent[b] = a;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(parts[i]);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const pix = [];
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    let hiN = 0, peakL = 0, peakC = 0, sx = 0, sy = 0;
    for (const p of list) {
      for (let k = 0; k < p.pix.length; k++) pix.push(p.pix[k]);
      if (p.minX < minX) minX = p.minX;
      if (p.minY < minY) minY = p.minY;
      if (p.maxX > maxX) maxX = p.maxX;
      if (p.maxY > maxY) maxY = p.maxY;
      hiN += p.hiN;
      if (p.peakL > peakL) peakL = p.peakL;
      if (p.peakC > peakC) peakC = p.peakC;
      sx += p.sx;
      sy += p.sy;
    }
    out.push({pix, n: pix.length, minX, minY, maxX, maxY, hiN, peakL, peakC, sx, sy});
  }
  return out;
}

// Dark margin of a white frame along a side the projector does not cover.
function unlitEdgeMask(plane, gw, gh, short) {
  const mask = new Uint8Array(gw * gh);
  if (!plane || !short || typeof short !== 'object') return mask;
  const sides = ['left', 'right', 'top', 'bottom'].filter(k => short[k]);
  if (!sides.length) return mask;
  const lums = new Float32Array(gw * gh);
  const sample = [];
  const margin = Math.max(2, Math.round(0.12 * Math.min(gw, gh)));
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const o = (y * gw + x) * 3;
    const L = lum(plane[o], plane[o + 1], plane[o + 2]);
    lums[y * gw + x] = L;
    if (x >= margin && x < gw - margin && y >= margin && y < gh - margin) sample.push(L);
  }
  sample.sort((a, b) => a - b);
  const med = sample.length ? sample[sample.length >> 1] : 180;
  const darkCut = Math.min(160, med * 0.72);
  const colDark = (x) => {
    let n = 0, d = 0;
    for (let y = 0; y < gh; y++) { n++; if (lums[y * gw + x] < darkCut) d++; }
    return n > 0 && d / n >= 0.5;
  };
  const rowDark = (y) => {
    let n = 0, d = 0;
    for (let x = 0; x < gw; x++) { n++; if (lums[y * gw + x] < darkCut) d++; }
    return n > 0 && d / n >= 0.5;
  };
  const paintCol = (x0, x1) => {
    for (let x = x0; x < x1; x++) for (let y = 0; y < gh; y++) mask[y * gw + x] = 1;
  };
  const paintRow = (y0, y1) => {
    for (let y = y0; y < y1; y++) for (let x = 0; x < gw; x++) mask[y * gw + x] = 1;
  };
  const limitX = Math.round(gw * 0.22);
  const limitY = Math.round(gh * 0.22);
  if (short.right) {
    let reach = 0;
    for (let x = gw - 1; x >= Math.max(0, gw - limitX); x--) {
      if (!colDark(x)) break;
      reach = gw - x;
    }
    const pad = Math.max(reach, Math.round(gw * 0.035));
    paintCol(Math.max(0, gw - pad), gw);
  }
  if (short.left) {
    let reach = 0;
    for (let x = 0; x < Math.min(gw, limitX); x++) {
      if (!colDark(x)) break;
      reach = x + 1;
    }
    const pad = Math.max(reach, Math.round(gw * 0.035));
    paintCol(0, Math.min(gw, pad));
  }
  if (short.bottom) {
    let reach = 0;
    for (let y = gh - 1; y >= Math.max(0, gh - limitY); y--) {
      if (!rowDark(y)) break;
      reach = gh - y;
    }
    const pad = Math.max(reach, Math.round(gh * 0.035));
    paintRow(Math.max(0, gh - pad), gh);
  }
  if (short.top) {
    let reach = 0;
    for (let y = 0; y < Math.min(gh, limitY); y++) {
      if (!rowDark(y)) break;
      reach = y + 1;
    }
    const pad = Math.max(reach, Math.round(gh * 0.035));
    paintRow(0, Math.min(gh, pad));
  }
  return mask;
}

function gridBoxToCamera(zone, gw, gh, minX, minY, maxX, maxY) {
  const u0 = gw <= 1 ? 0 : minX / (gw - 1);
  const v0 = gh <= 1 ? 0 : minY / (gh - 1);
  const u1 = gw <= 1 ? 1 : maxX / (gw - 1);
  const v1 = gh <= 1 ? 1 : maxY / (gh - 1);
  const corners = [quadPoint(zone, u0, v0), quadPoint(zone, u1, v0), quadPoint(zone, u0, v1), quadPoint(zone, u1, v1)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of corners) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return {x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2};
}

function shapeOf(mask, gw, gh, pix, minX, minY, maxX, maxY) {
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const aspect = bw / Math.max(1, bh);
  const bits = packDancerGrid(pix, gw, minX, minY, bw, bh);
  const grid = gridMetrics(bits);
  return {aspect, ...grid, templateIoU: templateIoU(bits)};
}

// reference: RGB bytes (w*h*3) or RGBA (w*h*4) of the last white capture.
// Both pictures are pulled into the same F1–F4 grid, matched for exposure
// from midtones, high-pass filtered so a slow light gradient cancels, and a
// pixel counts only when it and at least five of its 3×3 still differ (a 1–2 px
// shift does not, and a narrow dancer limb is not eroded away). Blobs then
// have to be a crisp dancer-silhouette sticker.
export function detectChangedStickers(rgba, width, height, {quad, reference = null, ...opts} = {}) {
  const P = {...CHANGE_STICKER, ...opts};
  const w = width | 0, h = height | 0;
  if (!rgba || !quad || quad.length !== 4) return {ok: false, stickers: [], reason: 'no painting quad'};
  const channels = refChannels(reference, w * h);
  if (!channels) return {ok: false, stickers: [], reason: 'Learn the painting first.'};
  // Full-frame warp so Before / After / Diff stills are not cropped. The
  // detection inset is applied on the mask below.
  const zone = quad;
  const edgeW = Math.hypot(zone[1].x - zone[0].x, zone[1].y - zone[0].y);
  const edgeH = Math.hypot(zone[3].x - zone[0].x, zone[3].y - zone[0].y);
  const grid = warpGridSize(edgeW, edgeH);
  const gw = grid.gw;
  const gh = grid.gh;
  const emptyRejected = {outside: 0, size: 0, shape: 0, hollow: 0, highlight: 0, 'soft-lighting': 0};
  if (!(gw > 4) || !(gh > 4)) return {ok: true, stickers: [], rejected: emptyRejected, zone, grid};
  const refPlane = rectify(reference, channels, w, h, zone, gw, gh);
  const matched = matchCapture(rectify(rgba, 4, w, h, zone, gw, gh), refPlane);
  // Blur, edge band, and dedupe stay the same physical size as the 360-wide
  // grid the gates were tuned on. Below that width the old pixel constants hold.
  // A full 960-wide warp used to blur by ~5 px. That dissolved matte gold and
  // gray cameos (about 15 px wide under white light) before the size gate.
  const spatial = Math.max(1, gw / WARP_REF_W);
  // Only the full ~960 warp. A 2× detect grid (~720) still needs the scaled
  // blur so a slender dancer stays one piece. At 960 the scaled blur is ~5 px
  // and it dissolves a ~15 px matte cameo.
  const fullWarp = gw >= 900;
  if (fullWarp) P.lumDelta = Math.min(P.lumDelta, 32);
  const blurR = fullWarp ? 1 : Math.max(1, Math.round(P.blur * spatial));
  const edgeRing = Math.max(3, Math.round(3 * spatial));
  const dedupe = P.dedupe * Math.max(1, w / 480);
  const cur = blurPlane(matched.rgb, gw, gh, blurR);
  const base = blurPlane(refPlane, gw, gh, blurR);
  const signed = new Float32Array(cur.length);
  for (let i = 0; i < signed.length; i++) signed[i] = cur[i] - base[i];
  // Wide enough that a window-sized gradient subtracts out, and at least
  // ~16 px on a 240-wide grid so a narrow dancer is not a soft halo.
  const stickerW = Math.max(8, Math.round(0.085 * Math.min(gw, gh)));
  const radius = Math.max(6, Math.round(stickerW * 1.75), Math.round(gw * 16 / 240));
  const smooth = blurPlane(signed, gw, gh, radius);
  const hp = new Float32Array(signed.length);
  for (let i = 0; i < hp.length; i++) hp[i] = signed[i] - smooth[i];
  const seed = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    const o = i * 3;
    if (Math.max(refPlane[o], refPlane[o + 1], refPlane[o + 2]) >= 230) seed[i] = 1;
  }
  const highlight = dilateMask(seed, gw, gh, Math.max(3, Math.round(stickerW * 1.25)));
  const mask = new Uint8Array(gw * gh);
  const strict = new Uint8Array(gw * gh);
  const mag = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    const o = i * 3;
    const r = hp[o], g = hp[o + 1], b = hp[o + 2];
    // Channel step, not only luminance: a blue sticker can match the paint's
    // brightness and still be a hard color edge.
    mag[i] = Math.max(Math.abs(lum(r, g, b)), Math.abs(r), Math.abs(g), Math.abs(b));
  }
  const detectInset = Math.max(0, Math.min(0.2, Number.isFinite(+P.detectInset) ? +P.detectInset : 0.03));
  const unlit = unlitEdgeMask(matched.rgb, gw, gh, P.short);
  const weak = new Uint8Array(gw * gh);
  const weakOpts = {...P, lumDelta: P.lumDelta * STICKER_WEAK, colorDelta: P.colorDelta * STICKER_WEAK};
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const uEdge = gw <= 1 ? 0 : x / (gw - 1);
    const vEdge = gh <= 1 ? 0 : y / (gh - 1);
    if (uEdge < detectInset || vEdge < detectInset || uEdge > 1 - detectInset || vEdge > 1 - detectInset) continue;
    if (unlit[y * gw + x]) continue;
    const hot = hotCount(hp, matched.rgb, refPlane, highlight, gw, gh, x, y, P);
    // Five of nine keeps a 5–8 px limb. All nine is the core used when a
    // wider blob's shape is scored, so a filled cameo does not turn solid.
    if (hot >= 5) mask[y * gw + x] = 1;
    if (hot >= 9) strict[y * gw + x] = 1;
    if (hot < 5 && hotCount(hp, matched.rgb, refPlane, highlight, gw, gh, x, y, weakOpts) >= 5) weak[y * gw + x] = 1;
  }
  // Hysteresis: a matte or low-contrast cutout only clears the full bar in a
  // few spots. Grow each hot piece through connected pixels that clear a
  // lower bar, so the whole figure reaches the size gate as one piece. Weak
  // pixels with no hot neighbour are never added, so faint noise stays out.
  {
    const stack = [];
    for (let i = 0; i < gw * gh; i++) if (mask[i]) stack.push(i);
    while (stack.length) {
      const i = stack.pop();
      const x = i % gw, y = (i / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        if (weak[j] && !mask[j]) { mask[j] = 1; stack.push(j); }
      }
    }
  }
  // ~11 px on 240×170 and ~24 px on 360×255. A 5×25 dancer (area 17 at the
  // old cap) passes; a 2–3 px speckle stays under the floor. On a full warp
  // the same physical cameo is a smaller share of the grid, so the floor
  // drops from 24 to 16 reference pixels (gold landed at area 81, under 112).
  const areaFloor = fullWarp ? 16 : 24;
  const minArea = Math.max(6, Math.round(gw * gh * areaFloor / (360 * 255)));
  const maxArea = Math.max(minArea + 1, Math.round(P.maxArea * gw * gh));
  const maxSide = Math.max(8, Math.round(P.maxSide * Math.min(gw, gh)));
  const seen = new Uint8Array(gw * gh), qq = new Int32Array(gw * gh), out = [];
  const rejected = {outside: 0, size: 0, shape: 0, hollow: 0, highlight: 0, 'soft-lighting': 0};
  const accepted = [], denied = [], draws = [], holdouts = [], parts = [];
  for (let s0 = 0; s0 < gw * gh; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    let head = 0, tail = 0;
    qq[tail++] = s0;
    seen[s0] = 1;
    const pix = [];
    let sx = 0, sy = 0, minX = gw, minY = gh, maxX = 0, maxY = 0, hiN = 0;
    let peakL = 0, peakC = 0;
    while (head < tail) {
      const i = qq[head++];
      pix.push(i);
      const x = i % gw, y = (i / gw) | 0;
      sx += x; sy += y;
      if (highlight[i]) hiN++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const o = i * 3;
      const dl = Math.abs(lum(cur[o], cur[o + 1], cur[o + 2]) - lum(base[o], base[o + 1], base[o + 2]));
      const dc = Math.max(Math.abs(cur[o] - base[o]), Math.abs(cur[o + 1] - base[o + 1]), Math.abs(cur[o + 2] - base[o + 2]));
      if (dl > peakL) peakL = dl;
      if (dc > peakC) peakC = dc;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        if (mask[j] && !seen[j]) { seen[j] = 1; qq[tail++] = j; }
      }
    }
    parts.push({pix, n: pix.length, minX, minY, maxX, maxY, hiN, peakL, peakC, sx, sy});
  }
  const bridge = Math.round(1.5 * stickerW);
  const merged = mergeNearbyFragments(parts, bridge, minArea, maxSide, stickerW);
  for (let pi = 0; pi < merged.length; pi++) {
    const part = merged[pi];
    const pix = part.pix;
    const n = part.n;
    const minX = part.minX, minY = part.minY, maxX = part.maxX, maxY = part.maxY;
    const hiN = part.hiN, peakL = part.peakL, peakC = part.peakC;
    const sx = part.sx, sy = part.sy;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect0 = bw / Math.max(1, bh);
    const wide = aspect0 >= 0.45 && bh / Math.max(1, bw) >= 0.45;
    let shapePix = pix, sx0 = minX, sy0 = minY, sx1 = maxX, sy1 = maxY;
    if (wide) {
      const core = pix.filter(i => strict[i]);
      if (core.length >= Math.max(6, Math.round(6 * spatial))) {
        shapePix = core;
        sx0 = gw; sy0 = gh; sx1 = 0; sy1 = 0;
        for (let p = 0; p < core.length; p++) {
          const i = core[p], x = i % gw, y = (i / gw) | 0;
          if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
          if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
        }
      }
    }
    const fig = shapeOf(mask, gw, gh, shapePix, sx0, sy0, sx1, sy1);
    const cx = sx / n, cy = sy / n;
    const edge = edgeContrast(mask, mag, gw, gh, minX, minY, maxX, maxY, edgeRing);
    const u = cx / Math.max(1, gw - 1);
    const v = cy / Math.max(1, gh - 1);
    const at = quadPoint(zone, u, v);
    // A narrow dancer has little interior, so the blur shoulder sits close to
    // the core. Wide soft light still has to fall off outside its mask.
    const thin = bw / Math.max(1, bh) < 0.45;
    const crispFail = edge.crisp < 18 || (!thin && edge.outer > 12 && edge.outer > edge.inner * 0.62);
    // A high-pass ridge beside a real edge can look like a thin dancer while
    // the exposure-matched pixels themselves barely changed.
    const faint = peakL < P.lumDelta && peakC < P.colorDelta;
    // IoU alone lets a standing oval through. A high-solidity blob also has
    // to be a low-circularity silhouette, not a filled disc.
    const shapeFail = dancerShapeReject(fig);
    let reason = '';
    if (n < minArea || n > maxArea || bw > maxSide || bh > maxSide) reason = 'size';
    // Neutral sun stays under this. Matte gold on a bright ground peaks near
    // dC 67, so a full warp uses 60 and still rejects the darker gray (dC ~42).
    else if (hiN / n >= 0.55 && peakC < (fullWarp ? 60 : 70)) reason = 'highlight';
    else if (crispFail || faint) reason = 'soft-lighting';
    else if (fig.holeFrac > DANCER_GATE.maxHoleFrac) reason = 'hollow';
    else if (shapeFail) reason = 'shape';
    else if (!pointInQuad(zone, at.x, at.y)) reason = 'outside';
    const uvH = bh / Math.max(1, gh);
    const rec = {
      u: +u.toFixed(3), v: +v.toFixed(3), x: +at.x.toFixed(1), y: +at.y.toFixed(1),
      area: n, uvH: +uvH.toFixed(4), peakL: +peakL.toFixed(1), peakC: +peakC.toFixed(1), crisp: +edge.crisp.toFixed(1),
      templateIoU: +fig.templateIoU.toFixed(2), solidity: +fig.solidity.toFixed(2),
      circularity: +fig.circularity.toFixed(2), holeFrac: +fig.holeFrac.toFixed(2),
      aspect: +fig.aspect.toFixed(2), reason: reason || 'accept'
    };
    if (reason) {
      rejected[reason]++;
      denied.push(rec);
      draws.push({minX, minY, maxX, maxY, accept: false});
      // A rejected piece large enough to be a real sticker stays on the
      // previous baseline so the next scan can still see it.
      if (n >= minArea * 0.6) holdouts.push(gridBoxToCamera(zone, gw, gh, minX, minY, maxX, maxY));
      continue;
    }
    if (out.some(o => Math.hypot(o.x - at.x, o.y - at.y) <= dedupe)) continue;
    out.push({x: at.x, y: at.y, u: +u.toFixed(3), v: +v.toFixed(3), uvH: +uvH.toFixed(4), area: n, w: bw, h: bh, kind: 'sticker'});
    accepted.push(rec);
    draws.push({minX, minY, maxX, maxY, accept: true});
  }
  denied.sort((a, b) => b.peakL - a.peakL);
  const heat = heatRgb(mag, gw * gh);
  const acceptColor = [50, 230, 110], rejectColor = [240, 70, 80];
  for (let d = 0; d < draws.length; d++) {
    const box = draws[d];
    strokeBox(heat, gw, gh, box.minX, box.minY, box.maxX, box.maxY, box.accept ? acceptColor : rejectColor);
  }
  const gains = matched.gains.map(g => Math.round(g * 1000) / 1000);
  const view = {
    gains,
    before: packScanStill(planeRgb(base), gw, gh),
    after: packScanStill(planeRgb(cur), gw, gh),
    diff: packScanStill(heat, gw, gh),
    blobs: accepted.concat(denied.slice(0, 8)),
    rejected: {...rejected},
    holdouts
  };
  return {ok: true, stickers: out, rejected, zone, grid, view};
}

// A blob has to show up in `need` of the captured white frames (same place).
export function keepStableStickers(lists, {need = 2, radius = 12} = {}) {
  const frames = (lists || []).filter(list => Array.isArray(list));
  if (!frames.length) return [];
  const want = Math.max(1, Math.min(need, frames.length));
  const last = frames[frames.length - 1];
  const out = [];
  for (const sticker of last) {
    if (!sticker) continue;
    let seen = 0;
    for (const list of frames) {
      if (list.some(other => other && Math.hypot(other.x - sticker.x, other.y - sticker.y) <= radius)) seen++;
    }
    if (seen >= want && !out.some(other => Math.hypot(other.x - sticker.x, other.y - sticker.y) <= radius)) out.push(sticker);
  }
  return out;
}

// A small blob that slides between scans (a cable) is not a new dancer.
// Taller stickers are left alone. `history` is earlier scans of {u, v}.
export function suppressShiftedStickers(stickers, history, {maxUvH = 0.1, minShift = 0.012, maxShift = 0.09} = {}) {
  const kept = [];
  const dropped = [];
  const prior = Array.isArray(history) ? history : [];
  for (const sticker of stickers || []) {
    const uvH = +sticker.uvH;
    if (!sticker || !(uvH > 0) || uvH >= maxUvH || !Number.isFinite(+sticker.u) || !Number.isFinite(+sticker.v)) {
      kept.push(sticker);
      continue;
    }
    let shifted = false;
    for (const scan of prior) {
      for (const spot of scan || []) {
        if (!spot) continue;
        const d = Math.hypot(+spot.u - +sticker.u, +spot.v - +sticker.v);
        if (d >= minShift && d <= maxShift) shifted = true;
      }
    }
    if (shifted) dropped.push(sticker);
    else kept.push(sticker);
  }
  return {kept, dropped};
}

// New dancers are the blobs that are not already a dancer. A center on top of
// an older sticker still counts when it is farther than `radius` (the overlap
// case). Exact same center is the same sticker and is not spawned again.
export function mergeNewStickers(previous, found, radius = 6) {
  const prev = (previous || []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  const fresh = [];
  for (const sticker of found || []) {
    if (!sticker || !Number.isFinite(+sticker.x) || !Number.isFinite(+sticker.y)) continue;
    if (prev.some(p => Math.hypot(p.x - sticker.x, p.y - sticker.y) <= radius)) continue;
    if (fresh.some(p => Math.hypot(p.x - sticker.x, p.y - sticker.y) <= radius)) continue;
    fresh.push(sticker);
  }
  return {fresh, all: prev.concat(fresh)};
}
