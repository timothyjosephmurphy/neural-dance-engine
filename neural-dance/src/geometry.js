// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Pure geometry shared by the live stage, the debug viewer, and the side sim.
// Pose, paint, and camera policy stay in their own modules; this file is only
// the math those three were each carrying a copy of.

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function smoothstep(u) {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
}

export function deg(d) {
  return d * Math.PI / 180;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerp2(a, b, t) {
  return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
}

// yaw 0 keeps +z in front of the body. Matches the live skeleton and the sim.
export function rotateFacing(x, z, yaw) {
  const c = Math.cos(yaw || 0), s = Math.sin(yaw || 0);
  return {x: x * c + z * s, z: -x * s + z * c};
}

export function unrotateFacing(x, z, yaw) {
  return rotateFacing(x, z, -(yaw || 0));
}

export function yawAbout(p, origin, yaw) {
  const r = rotateFacing(p.x - origin.x, (p.z || 0) - (origin.z || 0), yaw);
  return {x: origin.x + r.x, y: p.y, z: (origin.z || 0) + r.z};
}

// Projected half-width of a body-local ellipse after yaw.
export function yawExtent(halfW, halfD, yaw) {
  const c = Math.cos(yaw || 0), s = Math.sin(yaw || 0);
  return Math.hypot(halfW * c, halfD * s);
}

export function hash01(n) {
  const x = +n || 0;
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// Closest point on segment a→b (midX/midZ) to p, clamped to the segment.
export function projectToSegment(p, a, b) {
  const abx = b.midX - a.midX, abz = b.midZ - a.midZ;
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-10) return {x: a.midX, z: a.midZ};
  let t = ((p.x - a.midX) * abx + (p.z - a.midZ) * abz) / len2;
  t = clamp(t, 0, 1);
  return {x: a.midX + t * abx, z: a.midZ + t * abz};
}

export function clampToRadius(p, foot, r) {
  const dx = p.x - foot.midX, dz = p.z - foot.midZ;
  const d = Math.hypot(dx, dz);
  if (d <= r || d < 1e-9) return {x: p.x, z: p.z};
  return {x: foot.midX + dx * r / d, z: foot.midZ + dz * r / d};
}

function finitePoint(p) {
  if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) return null;
  return {x: +p.x, y: +p.y};
}

// Gaussian elimination with partial pivoting. rows are length-n, values length-n.
export function solveLinear(rows, values) {
  const n = values.length;
  const m = rows.map((row, i) => row.concat(values[i]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const swap = m[col];
      m[col] = m[pivot];
      m[pivot] = swap;
    }
    const div = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map(row => row[n]);
}

// Four plane points to four plane points. 9 row-major coefficients, h33 = 1.
export function solveHomography(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const s = finitePoint(src[i]);
    const d = finitePoint(dst[i]);
    if (!s || !d) return null;
    a.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }
  const h = solveLinear(a, b);
  if (!h) return null;
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  if (H.some(v => !Number.isFinite(v))) return null;
  return H;
}

export function applyHomography(H, x, y) {
  if (!H || H.length !== 9) return null;
  const w = H[6] * x + H[7] * y + H[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-8) return null;
  const px = (H[0] * x + H[1] * y + H[2]) / w;
  const py = (H[3] * x + H[4] * y + H[5]) / w;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return {x: px, y: py};
}

// Projector corners are 1 TL, 2 TR, 3 BR, 4 BL. A stored quad that arrived
// rotated or mirrored is put back in that order before the homography, so
// corner 1 always maps to the projector origin.
export function orderProjectorCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const pts = [];
  for (const corner of corners) {
    const x = +corner.x;
    const y = +corner.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({x, y});
  }
  const byY = pts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = byY.slice(2).sort((a, b) => b.x - a.x);
  return [top[0], top[1], bottom[0], bottom[1]];
}

// Sticker height in the source space, mapped by sending the top and bottom
// of the sticker through the same homography the dancer position uses.
export function projectedStickerHeight(H, x, y, heightPx) {
  const h = Math.abs(+heightPx);
  if (!(h > 0) || !H) return 0;
  const top = applyHomography(H, x, y - h / 2);
  const bot = applyHomography(H, x, y + h / 2);
  if (!top || !bot) return 0;
  return Math.hypot(bot.x - top.x, bot.y - top.y);
}

// object-fit: contain. The camera preview is a short wide strip, so the
// video picture sits inside the element with bars. Pointers and the overlay
// bitmap only agree inside this rectangle.
export function containedVideoRect(rect, videoW, videoH) {
  const bw = +rect.width;
  const bh = +rect.height;
  const vw = +videoW;
  const vh = +videoH;
  if (!(bw > 0) || !(bh > 0) || !(vw > 0) || !(vh > 0)) return null;
  const scale = Math.min(bw / vw, bh / vh);
  const width = vw * scale;
  const height = vh * scale;
  return {
    left: +rect.left + (bw - width) / 2,
    top: +rect.top + (bh - height) / 2,
    width,
    height,
    scale
  };
}

export function invertHomography(H) {
  if (!H || H.length !== 9) return null;
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det
  ];
}

// Least squares, four or more pairs. h33 = 1. Same layout as solveHomography.
export function solveHomographyN(src, dst) {
  const pairs = [];
  const n = Math.min(src ? src.length : 0, dst ? dst.length : 0);
  for (let i = 0; i < n; i++) {
    const s = finitePoint(src[i]);
    const d = finitePoint(dst[i]);
    if (s && d) pairs.push([s, d]);
  }
  if (pairs.length < 4) return null;
  if (pairs.length === 4) return solveHomography(pairs.map(p => p[0]), pairs.map(p => p[1]));
  const AtA = Array.from({length: 8}, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (const [s, d] of pairs) {
    add([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y], d.x);
    add([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y], d.y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.some(v => !Number.isFinite(v))) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function homographyResidual(H, src, dst) {
  let sum = 0;
  let n = 0;
  const count = Math.min(src ? src.length : 0, dst ? dst.length : 0);
  for (let i = 0; i < count; i++) {
    if (!src[i] || !dst[i]) continue;
    const p = applyHomography(H, +src[i].x, +src[i].y);
    if (!p) continue;
    sum += Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
    n++;
  }
  return n ? sum / n : Infinity;
}

// Normalized video (0..1) -> stage px, turned into the video-pixel homography
// the rest of the show already applies.
export function videoHomographyFromNorm(normH, videoW, videoH) {
  if (!normH || !(videoW > 0) || !(videoH > 0)) return null;
  const src = [{x: 0, y: 0}, {x: videoW, y: 0}, {x: videoW, y: videoH}, {x: 0, y: videoH}];
  const dst = src.map(p => applyHomography(normH, p.x / videoW, p.y / videoH));
  if (dst.some(p => !p)) return null;
  return solveHomography(src, dst);
}

export function calibrationGrid(n = 3) {
  const count = Math.max(2, n | 0);
  const pts = [];
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) pts.push({x: (i + 1) / (count + 1), y: (j + 1) / (count + 1)});
  }
  return pts;
}

export function detectDiffPeaks(dark, lit, width, height, {minDelta = 40, minSep = 12, limit = 12} = {}) {
  const w = width | 0;
  const h = height | 0;
  if (!dark || !lit || dark.length < w * h * 4 || lit.length < w * h * 4) return [];
  const peaks = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const d = (lit[i] + lit[i + 1] + lit[i + 2]) - (dark[i] + dark[i + 1] + dark[i + 2]);
      if (d < minDelta) continue;
      let local = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = ((y + dy) * w + (x + dx)) * 4;
        const e = (lit[j] + lit[j + 1] + lit[j + 2]) - (dark[j] + dark[j + 1] + dark[j + 2]);
        if (e > d) { local = false; break; }
      }
      if (local) peaks.push({x, y, d});
    }
  }
  peaks.sort((a, b) => b.d - a.d);
  const kept = [];
  for (const peak of peaks) {
    if (kept.some(k => Math.hypot(k.x - peak.x, k.y - peak.y) < minSep)) continue;
    kept.push(peak);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function matchPeaks(peaks, predicted, maxDist) {
  const used = new Set();
  const limit = +maxDist;
  return (predicted || []).map(pred => {
    if (!pred || !Number.isFinite(+pred.x) || !Number.isFinite(+pred.y)) return null;
    let best = -1;
    let bestD = limit;
    for (let i = 0; i < peaks.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(peaks[i].x - pred.x, peaks[i].y - pred.y);
      if (d <= bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    used.add(best);
    return peaks[best];
  });
}

// Detect px -> video px -> stage px -> projector element px. The CSS warp is
// not applied: dancers are drawn in pre-warp stage space, and the projector
// element is the screen. A second warp would slide the glow off the sticker.
export function mapStickerToScreen({detectX, detectY, scaleX = 1, scaleY = 1, homography, viewW, viewH, stageW = 1000, stageH = 620}) {
  const video = {x: (detectX + 0.5) * scaleX, y: (detectY + 0.5) * scaleY};
  const stage = applyHomography(homography, video.x, video.y);
  if (!stage) return null;
  const screen = {
    x: stage.x / stageW * viewW,
    y: stage.y / stageH * viewH
  };
  return {video, stage, screen};
}

export function mapScreenToDetect({screenX, screenY, scaleX = 1, scaleY = 1, homography, viewW, viewH, stageW = 1000, stageH = 620}) {
  const inv = invertHomography(homography);
  if (!inv || !(scaleX > 0) || !(scaleY > 0)) return null;
  const stage = {x: screenX / viewW * stageW, y: screenY / viewH * stageH};
  const video = applyHomography(inv, stage.x, stage.y);
  if (!video) return null;
  return {stage, video, detect: {x: video.x / scaleX - 0.5, y: video.y / scaleY - 0.5}};
}
