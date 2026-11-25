// Closed-loop align refinement (TJ, Nov 9 3:45 PM: "draw the parallelogram on
// the projected screen ... in an iterative fashion, so you can error correct").
// After Align, the stage draws an outline with a bright dot at each align
// circle position. The camera finds the dots, compares them to where the
// current quad says they should be, and corrects the quad. A few passes,
// until the error is under a pixel or two. A person or any motion between the
// two dark frames of a pass pauses it; a pass never applies a wild jump.
import {CALIBRATION_MARKERS, CANVAS_H, CANVAS_W, PROJECTION_CORNERS, applyHomography} from '../camera-markers.js';
import {solveLinear} from './geometry.js';
import {anchorsFromCorners, cornersFromAnchors} from './align-anchors.js';
import {gridTargets, pointResiduals, quadFromH, robustHomography} from './align-precision.js';

export const REFINE_MAX_PASSES = 4;
export const REFINE_THRESHOLD_PX = 2; // camera (video) pixels
export const REFINE_MAX_SHIFT = 0.08; // camera 0-1; bigger is a misread, not a correction
export const REFINE_MOTION_PCT = 1.5; // % of pixels whose luma moved >20 between the dark frames
export const REFINE_PERSON_WAIT_MS = 8000;
export const REFINE_DOT_RADIUS = 0.022; // stage width fraction
export const REFINE_SEARCH = 0.09; // camera width fraction around the expected dot
// A large correction is accepted only when every dot agrees on one wall
// homography (TJ 6:07 PM: refine saw a steady 88px error on every pass and
// refused it, leaving an undersized, skewed quad). A misread scatters dots;
// a wrong first-pass quad moves all of them coherently.
export const REFINE_MAX_COHERENT_SHIFT = 0.24;
export const REFINE_COHERENT_RESIDUAL = 0.012; // camera 0-1, LS fit residual
export const REFINE_COHERENT_MIN_DOTS = 8;
export const REFINE_WIDE_SEARCH = 2; // search window multiplier after a refused jump

// The four align-circle corners first (they carry the outline), then the
// edge midpoints and the center. Four points fit any quad exactly, so the
// interior (where the stickers are) was never checked; nine points are fit
// by least squares and the error is measured where the dancers stand.
export function refineTargets(grid = 3) {
  // 4x4 (TJ Nov 11, precision strategy 1): corners first, then the rest.
  if (grid === 4) return gridTargets(4);
  const corners = CALIBRATION_MARKERS.map(m => ({x: m.x, y: m.y}));
  const [tl, tr, br, bl] = corners;
  const mid = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
  return corners.concat([mid(tl, tr), mid(tr, br), mid(br, bl), mid(bl, tl), mid(tl, br)]);
}

// Least-squares stage(0-1) -> camera(0-1) homography from >= 4 pairs, then
// the stage corners in camera space (the stored quad).
export function fitQuadLS(measured, targets = refineTargets()) {
  const pairs = [];
  for (let i = 0; i < targets.length; i++) if (measured[i] && targets[i]) pairs.push([targets[i], measured[i]]);
  if (pairs.length < 4) return null;
  const AtA = Array.from({length: 8}, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (const [s, c] of pairs) {
    add([s.x, s.y, 1, 0, 0, 0, -c.x * s.x, -c.x * s.y], c.x);
    add([0, 0, 0, s.x, s.y, 1, -c.y * s.x, -c.y * s.y], c.y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || !h.every(Number.isFinite)) return null;
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const quad = PROJECTION_CORNERS.map(p => applyHomography(H, p.x / CANVAS_W, p.y / CANVAS_H));
  return quad.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)) ? quad.map(p => ({x: p.x, y: p.y})) : null;
}

// Robust (RANSAC + Huber) version of fitQuadLS: one misread dot (a sticker
// bloom, a shoe) is dropped instead of bending the whole map. Also returns
// the residual of every dot under the fitted map (TJ Nov 11, strategy 1).
export const REFINE_ROBUST_TOL = 0.006; // camera 0-1 (~3 px at 480 wide)
export function fitQuadRobust(measured, targets = refineTargets(), {videoWidth = 480, videoHeight = null, stageWidthCm = null, stageAspect} = {}) {
  const fit = robustHomography(targets, measured, {tol: REFINE_ROBUST_TOL});
  if (!fit || fit.inlierCount < Math.min(6, measured.filter(Boolean).length)) return null;
  const quad = quadFromH(fit.H);
  if (!quad || !quad.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const vh = videoHeight > 0 ? videoHeight : videoWidth * 0.75;
  const points = pointResiduals(fit.H, targets, measured, {videoWidth, videoHeight: vh, stageWidthCm, stageAspect, inliers: fit.inliers});
  return {quad, points, inlierCount: fit.inlierCount};
}

function luma(d, i) {
  return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
}

export function frameMotion(a, b, width, height, step = 4) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (Math.abs(luma(a, i) - luma(b, i)) > 20) sum++;
      n++;
    }
  }
  return n ? (sum / n) * 100 : Infinity;
}

// One bright dot near each expected point (detect pixels). Brightness-weighted
// centroid of the lit-minus-dark pixels above half the window peak.
// Absolute peak floor for dark rooms; under ambient wash the projector
// delta is smaller, so we also accept a relative lift over the window median.
export const REFINE_PEAK_MIN = 18;
export const REFINE_PEAK_ABS = 30;

export function findDots(dark, lit, width, height, expected, radius, {nearest = false} = {}) {
  const out = [];
  for (const e of expected) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) { out.push(null); continue; }
    const x0 = Math.max(0, Math.floor(e.x - radius));
    const x1 = Math.min(width - 1, Math.ceil(e.x + radius));
    const y0 = Math.max(0, Math.floor(e.y - radius));
    const y1 = Math.min(height - 1, Math.ceil(e.y + radius));
    if (x1 <= x0 || y1 <= y0) { out.push(null); continue; }
    let peak = 0;
    let px = -1;
    let py = -1;
    const deltas = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * width + x) * 4;
        const d = luma(lit, i) - luma(dark, i);
        deltas.push(d);
        if (d > peak) { peak = d; px = x; py = y; }
      }
    }
    deltas.sort((a, b) => a - b);
    const med = deltas.length ? deltas[deltas.length >> 1] : 0;
    // Temporal difference must beat ambient wash (TJ 4:52 PM lit-room refine).
    const peakOk = peak >= REFINE_PEAK_ABS || (peak >= REFINE_PEAK_MIN && peak >= med + 12);
    if (!peakOk) { out.push(null); continue; }
    const floor = Math.max(med + 6, peak * 0.45);
    if (nearest) {
      // Wide search: several dots can share the window. Take the bright blob
      // closest to the expected point, not merely the brightest pixel.
      const pick = nearestBrightBlob(dark, lit, width, x0, y0, x1, y1, floor, peak * 0.6, e);
      if (pick) { px = pick.x; py = pick.y; }
    }
    // Only the lit blob that holds the peak: the outline's line ends reach
    // into the search window and used to drag every dot toward the middle.
    const ww = x1 - x0 + 1;
    const seen = new Uint8Array(ww * (y1 - y0 + 1));
    const stack = [[px, py]];
    seen[(py - y0) * ww + (px - x0)] = 1;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let count = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      const d = luma(lit, (y * width + x) * 4) - luma(dark, (y * width + x) * 4) - floor;
      if (d <= 0) continue;
      sx += (x + 0.5) * d;
      sy += (y + 0.5) * d;
      sw += d;
      count++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const k = (ny - y0) * ww + (nx - x0);
        if (seen[k]) continue;
        seen[k] = 1;
        stack.push([nx, ny]);
      }
    }
    out.push(count >= 3 && sw > 0 ? {x: sx / sw, y: sy / sw, pixels: count} : null);
  }
  return out;
}

function nearestBrightBlob(dark, lit, width, x0, y0, x1, y1, floor, minPeak, e) {
  const ww = x1 - x0 + 1;
  const seen = new Uint8Array(ww * (y1 - y0 + 1));
  let best = null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = (y - y0) * ww + (x - x0);
      if (seen[k]) continue;
      const i = (y * width + x) * 4;
      if (luma(lit, i) - luma(dark, i) <= floor) continue;
      let top = 0, tx = x, ty = y, sx = 0, sy = 0, n = 0;
      const stack = [[x, y]];
      seen[k] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const d = luma(lit, (cy * width + cx) * 4) - luma(dark, (cy * width + cx) * 4);
        if (d <= floor) continue;
        if (d > top) { top = d; tx = cx; ty = cy; }
        sx += cx; sy += cy; n++;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
          const kk = (ny - y0) * ww + (nx - x0);
          if (seen[kk]) continue;
          seen[kk] = 1;
          stack.push([nx, ny]);
        }
      }
      if (n < 3 || top < minPeak) continue;
      const dist = Math.hypot(sx / n - e.x, sy / n - e.y);
      if (!best || dist < best.dist) best = {x: tx, y: ty, dist};
    }
  }
  return best;
}

// Expected dot positions (video 0-1) for a quad.
export function expectedDots(quad, targets = refineTargets()) {
  return anchorsFromCorners(quad, targets);
}

// Large but consistent: all four corners plus >= 8 dots, and the least-squares
// homography explains every dot within REFINE_COHERENT_RESIDUAL.
export function coherentCorrection(measured, targets = refineTargets(), worst = Infinity) {
  if (!(worst <= REFINE_MAX_COHERENT_SHIFT)) return null;
  if (!Array.isArray(measured) || measured.slice(0, 4).some(p => !p)) return null;
  if (measured.filter(Boolean).length < REFINE_COHERENT_MIN_DOTS) return null;
  const quad = fitQuadLS(measured, targets);
  if (!quad) return null;
  const predicted = expectedDots(quad, targets);
  if (!predicted) return null;
  let residual = 0;
  for (let i = 0; i < measured.length; i++) {
    if (!measured[i]) continue;
    residual = Math.max(residual, Math.hypot(measured[i].x - predicted[i].x, measured[i].y - predicted[i].y));
  }
  if (!(residual <= REFINE_COHERENT_RESIDUAL)) return null;
  return {quad, residual};
}

// Measured dots (video 0-1) and the current quad to the error and corrected quad.
export function refineStep(quad, measured, videoWidth, targets = refineTargets(), fitOptions = {}) {
  const expected = expectedDots(quad, targets);
  // The four corners are required; interior dots may be blocked (a person,
  // a bright sticker bloom) and the fit uses the rest.
  if (!expected || !Array.isArray(measured) || measured.length !== targets.length || measured.slice(0, 4).some(p => !p) || measured.filter(Boolean).length < 6) {
    return {ok: false, reason: 'dots not found', errorPx: null, quad};
  }
  let worst = 0;
  for (let i = 0; i < measured.length; i++) if (measured[i]) worst = Math.max(worst, Math.hypot(measured[i].x - expected[i].x, measured[i].y - expected[i].y));
  const errorPx = worst * (videoWidth > 0 ? videoWidth : 1);
  if (worst > REFINE_MAX_SHIFT) {
    const coherent = coherentCorrection(measured, targets, worst);
    if (coherent) return {ok: true, reason: 'coherent correction', errorPx, quad: coherent.quad, residual: coherent.residual};
    return {ok: false, reason: 'jump too large', errorPx, quad};
  }
  const robust = fitQuadRobust(measured, targets, {videoWidth, ...fitOptions});
  const next = robust ? robust.quad : fitQuadLS(measured, targets);
  if (!next) return {ok: false, reason: 'not a wall', errorPx, quad};
  return {ok: true, reason: '', errorPx, quad: next, points: robust ? robust.points : null};
}

// The loop. io: show('black'|'outline'|null), wait(), grab() -> detect frame,
// alive(), report(state). Returns {quad, passes, finalErrorPx, converged, stopped}.
export async function runAlignRefine(quad, io, {
  maxPasses = REFINE_MAX_PASSES,
  thresholdPx = REFINE_THRESHOLD_PX,
  personWaitMs = REFINE_PERSON_WAIT_MS,
  now = () => Date.now(),
  ambientHot = false,
  targets = refineTargets(),
  fitOptions = {}
} = {}) {
  const passesBudget = ambientHot ? Math.max(maxPasses, 6) : maxPasses;
  const convergePx = ambientHot ? Math.max(thresholdPx, 3.5) : thresholdPx;
  let current = quad;
  const passes = [];
  let finalErrorPx = null;
  let converged = false;
  let stopped = '';
  let pausedSince = 0;
  let searchMul = 1;
  let points = null;
  const say = (extra) => { if (io.report) io.report({passes: passes.slice(), finalErrorPx, converged, stopped, points, grid: targets.length === 16 ? 4 : 3, ...extra}); };
  for (let pass = 1; pass <= passesBudget;) {
    if (!io.alive()) { stopped = 'cancelled'; break; }
    io.show('black');
    await io.wait();
    const dark1 = io.grab();
    io.show('outline');
    await io.wait();
    const lit = io.grab();
    io.show('black');
    await io.wait();
    const dark2 = io.grab();
    if (!io.alive()) { stopped = 'cancelled'; break; }
    if (!dark1 || !lit || !dark2) { stopped = 'no camera frame'; break; }
    const w = lit.width;
    const h = lit.height;
    const motion = frameMotion(dark1.data, dark2.data, w, h);
    const person = io.personPresent ? !!io.personPresent() : false;
    if (person || motion > REFINE_MOTION_PCT) {
      if (!pausedSince) pausedSince = now();
      passes.push({pass, paused: true, motion: Math.round(motion * 10) / 10, person});
      say({paused: true});
      if (now() - pausedSince > personWaitMs) { stopped = 'person in frame'; break; }
      await (io.pause ? io.pause() : io.wait());
      continue; // same pass number, quad untouched
    }
    pausedSince = 0;
    const scale = lit.scale || {scaleX: 1, scaleY: 1};
    const vw = lit.videoWidth > 0 ? lit.videoWidth : w;
    const vh = lit.videoHeight > 0 ? lit.videoHeight : h;
    const sx = +scale.scaleX > 0 ? +scale.scaleX : 1;
    const sy = +scale.scaleY > 0 ? +scale.scaleY : 1;
    const expected = expectedDots(current, targets);
    if (!expected) { stopped = 'bad quad'; break; }
    const expectedDetect = expected.map(p => ({x: p.x * vw / sx - 0.5, y: p.y * vh / sy - 0.5}));
    // Prefer the later dark frame; if ambient wash is high, blend dark1+dark2
    // so auto-exposure flicker does not erase the temporal difference.
    let darkData = dark2.data;
    const ambient = (() => {
      let s = 0, n = 0;
      for (let i = 0; i < dark2.data.length; i += 64) { s += luma(dark2.data, i); n++; }
      return n ? s / n : 0;
    })();
    if (ambient > 42) {
      const blended = new Uint8ClampedArray(dark2.data.length);
      for (let i = 0; i < blended.length; i++) blended[i] = (dark1.data[i] + dark2.data[i]) >> 1;
      darkData = blended;
    }
    // After a refused jump the true dot can sit outside the normal window
    // (its centroid gets clipped at the edge), so look twice as wide.
    const searchR = Math.max(6, REFINE_SEARCH * w * (ambient > 42 ? 1.25 : 1) * searchMul);
    const dots = findDots(darkData, lit.data, w, h, expectedDetect, searchR, {nearest: searchMul > 1});
    const measured = dots.map(d => d ? {x: d.x * sx / vw, y: d.y * sy / vh} : null);
    const step = refineStep(current, measured, vw, targets, {videoHeight: vh, ...fitOptions});
    if (step.points) points = step.points;
    finalErrorPx = step.errorPx;
    passes.push({pass, errorPx: step.errorPx == null ? null : Math.round(step.errorPx * 10) / 10, applied: step.ok, reason: step.reason});
    if (step.ok) current = step.quad;
    searchMul = (!step.ok && (step.reason === 'jump too large' || step.reason === 'dots not found')) ? REFINE_WIDE_SEARCH : 1;
    say({});
    if (step.ok && step.errorPx <= convergePx) { converged = true; break; }
    pass++;
  }
  if (!converged && !stopped) stopped = 'max passes';
  io.show(null);
  say({done: true});
  return {quad: current, passes, finalErrorPx, converged, stopped, points, targets};
}

// One line for the debug page: per-pass error and the result.
export function refineSummary(refine) {
  if (!refine || !Array.isArray(refine.passes)) return '';
  const parts = refine.passes.map(p => p.paused ? 'p' + p.pass + ' paused (motion)' : 'p' + p.pass + ' ' + (p.errorPx == null ? '—' : p.errorPx.toFixed(1) + 'px') + (p.applied ? '' : ' ✗'));
  let tail = '';
  if (refine.done) tail = refine.converged ? ' · ✓ final ' + (refine.finalErrorPx == null ? '—' : refine.finalErrorPx.toFixed(1) + 'px') : ' · stopped: ' + (refine.stopped || '—') + (refine.finalErrorPx == null ? '' : ' (last ' + refine.finalErrorPx.toFixed(1) + 'px)');
  else tail = ' · running';
  return 'Align refine: ' + (parts.join(' → ') || 'starting') + tail;
}
