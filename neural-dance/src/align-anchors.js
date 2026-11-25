// Align anchors: the four green alignment circles (Nov 9, TJ: "the pink ones
// are not on the green ones"). The camera-to-stage quad is still stored as the
// stage corners, but the debug view shows and drags the points where the
// align circles sit on the stage, so the pink handles land on the green
// circles, and a handle dragged near a detected circle snaps onto it.
import {CALIBRATION_MARKERS, CANVAS_H, CANVAS_W, PROJECTION_CORNERS, applyHomography, cornersFromMarkerCenters, solveHomography} from '../camera-markers.js';
import {solveLinear} from './geometry.js';

export const ANCHOR_SNAP_RADIUS = 0.06;
// Stickers count only on the floor the align circles bound, plus this margin
// (stage units 0-1). Projected UI and its glow sit outside it.
export const PLAY_MARGIN = 0.05;
export const PLAY_TOP = 0.16;
// Continuous detection: keep blobs this far inside the play rect (TJ 4:34 PM
// lower-right build-pill / corner glare). Scan stickers may still use the
// looser play rect.
export const PLAY_EDGE_INSET = 0.04;

function finite(p) {
  return p && Number.isFinite(+p.x) && Number.isFinite(+p.y);
}

// Stage corners (camera 0-1) to the camera positions of the align circles.
export function anchorsFromCorners(corners, markers = CALIBRATION_MARKERS) {
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(finite)) return null;
  const toCamera = solveHomography(PROJECTION_CORNERS, corners.map(p => ({x: +p.x, y: +p.y})));
  if (!toCamera) return null;
  const out = [];
  for (const m of markers) {
    const at = applyHomography(toCamera, m.x * CANVAS_W, m.y * CANVAS_H);
    if (!finite(at)) return null;
    out.push({x: at.x, y: at.y});
  }
  return out;
}

// A full homography through the inset circles is exact when the four points
// agree. One noisy circle puts the vanishing line just outside the box and
// the stage's top edge flies off the painting. An affine map cannot do that.
function affineStageCorners(anchors, markers) {
  const AtA = Array.from({length: 6}, () => new Array(6).fill(0));
  const Atb = new Array(6).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 6; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 6; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < 4; i++) {
    const s = markers[i];
    const d = anchors[i];
    if (!s || !finite(d)) return null;
    add([s.x, s.y, 1, 0, 0, 0], d.x);
    add([0, 0, 0, s.x, s.y, 1], d.y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.length !== 6 || !h.every(Number.isFinite)) return null;
  return [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}].map(p => ({
    x: h[0] * p.x + h[1] * p.y + h[2],
    y: h[3] * p.x + h[4] * p.y + h[5]
  }));
}

// Expected extension past the circles is 0.18/0.64 of their span. Past about
// twice that, the homography has left the wall.
function extrapolationWild(corners, anchors) {
  const xs = anchors.map(p => p.x);
  const ys = anchors.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = Math.max(1e-6, x1 - x0), sy = Math.max(1e-6, y1 - y0);
  return corners.some(p => p.x < x0 - 0.55 * sx || p.x > x1 + 0.55 * sx || p.y < y0 - 0.55 * sy || p.y > y1 + 0.55 * sy);
}

// Align circle positions (camera 0-1) back to stage corners (camera 0-1).
export function cornersFromAnchors(anchors, markers = CALIBRATION_MARKERS) {
  if (!Array.isArray(anchors) || anchors.length !== 4 || !anchors.every(finite)) return null;
  const S = 1000;
  const projective = cornersFromMarkerCenters(anchors.map(p => ({x: +p.x * S, y: +p.y * S})), S, S, markers);
  if (projective && !extrapolationWild(projective, anchors)) return projective;
  return affineStageCorners(anchors, markers) || projective;
}

// A dragged handle within radius of a detected circle lands on its center.
// The circle with the handle's own number wins; otherwise the nearest one.
export function snapAnchor(spot, index, marks, radius = ANCHOR_SNAP_RADIUS) {
  if (!finite(spot)) return spot;
  const list = Array.isArray(marks) ? marks : [];
  const own = list[index];
  if (finite(own) && Math.hypot(own.x - spot.x, own.y - spot.y) <= radius) return {x: +own.x, y: +own.y, snapped: index};
  let best = -1;
  let dist = radius;
  list.forEach((m, i) => {
    if (!finite(m)) return;
    const d = Math.hypot(m.x - spot.x, m.y - spot.y);
    if (d <= dist) { dist = d; best = i; }
  });
  return best >= 0 ? {x: +list[best].x, y: +list[best].y, snapped: best} : {x: spot.x, y: spot.y};
}

// Stage point (stage px) on the stickered floor: inside the align circles
// plus a margin, below the top band, and outside every UI rect.
export function stickerInPlay(x, y, exclusions = [], markers = CALIBRATION_MARKERS, options = {}) {
  if (!Number.isFinite(+x) || !Number.isFinite(+y)) return false;
  const inset = Number.isFinite(+options.edgeInset) ? Math.max(0, +options.edgeInset) : 0;
  const xs = markers.map(m => m.x);
  const ys = markers.map(m => m.y);
  const left = (Math.min(...xs) - PLAY_MARGIN + inset) * CANVAS_W;
  const right = (Math.max(...xs) + PLAY_MARGIN - inset) * CANVAS_W;
  const top = Math.max(PLAY_TOP, Math.min(...ys) - PLAY_MARGIN + inset) * CANVAS_H;
  const bottom = (Math.max(...ys) + PLAY_MARGIN - inset) * CANVAS_H;
  if (x < left || x > right || y < top || y > bottom) return false;
  for (const r of exclusions || []) {
    if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return false;
  }
  return true;
}
