// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Walkable-surface map for the crowd pages (/neural-dance/demo/, /show/).
// Coordinates are stage px (1000 x 620), the same space the live page maps
// onto the painting. y = 310 (the painting's midline) is the horizon.
//
// HOW TO TWEAK (TJ): open the live page with "Show alignment pattern", note
// where the stage, speakers and dome sit in the 1000 x 620 grid (each grid
// square is 125 x 77.5), then edit the numbers below:
// - floor: the walkable ground in front of the stage. Feet stay inside it.
// - holes: parts of the floor that are really the front faces of the
//   speakers and stage. Nobody stands there (they would be inside the box).
// - surfaces: raised places. `poly` is where feet may stand on top.
//   `access` is the floor spot a climber walks to first, then climbs straight
//   up the face to `entry` (a point on top). `baseY` is the floor line under
//   the surface and sets the dancer's size (perspective).
//   `gate` says who may go up: 'any' (stage) or 'climb' (speakers, dome:
//   only high-stamina, high-energy, rested dancers).
// - dome: `arc` is the top of the dome frame, left base to right base.
//   Climbers walk along it; they never leave the arc.
// Per-browser overrides: localStorage 'nd.crowd.surfaces.v1' with the same
// JSON shape replaces any key here (see crowd-page.js).

export const CROWD_STAGE_W = 1000;
export const CROWD_STAGE_H = 620;

export const CROWD_SURFACES = Object.freeze({
  horizonY: 310,
  // Dancer height (stage px) at the bottom edge; shrinks linearly to the
  // horizon. minHeight keeps far dancers visible.
  nearHeight: 190,
  minHeight: 28,
  // Stage centre: where the crowd is pulled toward.
  stageFront: {x: 456, y: 382},
  floor: [[0, 345], [1000, 345], [1000, 620], [0, 620]],
  holes: [
    [[205, 300], [303, 300], [303, 428], [205, 428]],   // left speaker face
    [[608, 304], [708, 304], [708, 440], [608, 440]],   // right speaker face
    [[303, 330], [608, 330], [608, 380], [303, 380]]    // stage front / deck
  ],
  surfaces: [
    {id: 'stage', gate: 'any', poly: [[310, 334], [602, 334], [602, 372], [310, 372]], baseY: 380, access: [456, 392], entry: [456, 366]},
    {id: 'speakerL', gate: 'climb', poly: [[214, 300], [296, 300], [296, 312], [214, 312]], baseY: 428, access: [255, 440], entry: [255, 306]},
    {id: 'speakerR', gate: 'climb', poly: [[616, 305], [702, 305], [702, 318], [616, 318]], baseY: 440, access: [660, 452], entry: [660, 311]},
    // Props drawn by the fx layer (crowd-props.js), climbable above the
    // horizon. Pole (left): `poly` is a narrow strip up the pole; climbers
    // hold on anywhere on it. Cage (right): `poly` is the front face of the
    // cage; climbers hang on the bars.
    {id: 'pole', gate: 'climb', prop: 'pole', poly: [[134, 214], [146, 214], [146, 414], [134, 414]], baseY: 440, access: [140, 452], entry: [140, 410]},
    {id: 'cage', gate: 'climb', prop: 'cage', poly: [[772, 262], [848, 262], [848, 426], [772, 426]], baseY: 444, access: [810, 456], entry: [810, 422]}
  ],
  // Rope from the dome top. Only a climber already on the dome takes it
  // (rope-swing event): hands on the rope end, body hanging below it.
  rope: {id: 'rope', gate: 'climb', anchor: [450, 186], length: 92, amp: 0.62, periodS: 2.8, baseY: 345},
  dome: {
    id: 'dome', gate: 'climb', baseY: 345,
    // Top of the arch frame, left base -> apex -> right base.
    arc: [[332, 332], [338, 290], [352, 252], [378, 218], [412, 196], [450, 186], [490, 192], [526, 212], [552, 244], [568, 284], [574, 330]],
    access: [[326, 384], [580, 384]]
  }
});

export function mergeSurfaces(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Object.assign({}, base);
  for (const k of Object.keys(base)) if (override[k] !== undefined) out[k] = override[k];
  return out;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function polyBox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return {x0, y0, x1, y1};
}

export function onFloor(map, x, y) {
  if (!pointInPoly(x, y, map.floor)) return false;
  for (const h of map.holes || []) if (pointInPoly(x, y, h)) return false;
  return true;
}

// Nearest legal floor point (feet). Pushes out of holes downward (toward the
// viewer), which is always open floor in front of a box.
export function clampToFloor(map, x, y) {
  const b = polyBox(map.floor);
  let cx = Math.max(b.x0 + 1, Math.min(b.x1 - 1, x));
  let cy = Math.max(b.y0 + 1, Math.min(b.y1 - 1, y));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const h of map.holes || []) {
      if (!pointInPoly(cx, cy, h)) continue;
      const hb = polyBox(h);
      // Out the cheapest side, but never up past the horizon floor edge.
      const opts = [
        {x: hb.x0 - 1, y: cy, d: cx - hb.x0},
        {x: hb.x1 + 1, y: cy, d: hb.x1 - cx},
        {x: cx, y: hb.y1 + 1, d: hb.y1 - cy}
      ].filter(o => o.x > b.x0 && o.x < b.x1 && o.y < b.y1);
      opts.sort((p, q) => p.d - q.d);
      const o = opts[0] || {x: cx, y: hb.y1 + 1};
      cx = o.x; cy = o.y; moved = true;
    }
    if (!moved) break;
  }
  return {x: cx, y: cy};
}

export function clampToPoly(poly, x, y) {
  if (pointInPoly(x, y, poly)) return {x, y};
  const b = polyBox(poly);
  return {x: Math.max(b.x0 + 0.5, Math.min(b.x1 - 0.5, x)), y: Math.max(b.y0 + 0.5, Math.min(b.y1 - 0.5, y))};
}

export function arcPoint(arc, t) {
  const u = Math.max(0, Math.min(1, +t || 0));
  // Even spacing by length.
  const seg = [];
  let total = 0;
  for (let i = 1; i < arc.length; i++) { const l = Math.hypot(arc[i][0] - arc[i - 1][0], arc[i][1] - arc[i - 1][1]); seg.push(l); total += l; }
  let want = u * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const k = seg[i] > 0 ? Math.min(1, want / seg[i]) : 0;
      return {x: arc[i][0] + (arc[i + 1][0] - arc[i][0]) * k, y: arc[i][1] + (arc[i + 1][1] - arc[i][1]) * k};
    }
    want -= seg[i];
  }
  const last = arc[arc.length - 1];
  return {x: last[0], y: last[1]};
}

export function distToArc(arc, x, y) {
  let best = Infinity;
  for (let i = 1; i < arc.length; i++) {
    const ax = arc[i - 1][0], ay = arc[i - 1][1], bx = arc[i][0], by = arc[i][1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

export function surfaceById(map, id) {
  if (id === 'floor') return null;
  if (map.dome && map.dome.id === id) return map.dome;
  if (map.rope && map.rope.id === id) return map.rope;
  return (map.surfaces || []).find(s => s.id === id) || null;
}

// Height in stage px for a dancer whose floor line is at baseY.
export function heightAt(map, baseY) {
  const span = CROWD_STAGE_H - map.horizonY;
  const h = map.nearHeight * Math.max(0, (+baseY || 0) - map.horizonY) / span;
  return Math.max(map.minHeight, Math.min(map.nearHeight, h));
}

// True when feet at (x, y) are on something solid for a dancer in `where`
// state. Climb segments (a straight face from access up to entry, or the
// walk from the floor onto the dome base) count as solid: hands and feet on
// the face.
export function isSupported(map, d, tol = 1.5) {
  if (!d) return false;
  if (d.where === 'floor') return onFloor(map, d.x, d.y) || nearFloor(map, d.x, d.y, tol);
  const s = surfaceById(map, d.surface);
  if (!s) return false;
  if (d.where === 'on') {
    if (s.anchor) {
      // Hanging from the rope: hands at most one rope length from the anchor.
      const hang = 0.85 * heightAt(map, s.baseY);
      return Math.hypot(d.x - s.anchor[0], d.y - hang - s.anchor[1]) <= s.length + tol;
    }
    if (s.arc) return distToArc(s.arc, d.x, d.y) <= tol;
    return pointInPoly(d.x, d.y, s.poly) || distPolyBox(s.poly, d.x, d.y) <= tol;
  }
  if (d.where === 'climb') {
    const seg = climbSegment(map, s, d.side | 0);
    return distSeg(seg, d.x, d.y) <= tol;
  }
  return false;
}

function nearFloor(map, x, y, tol) {
  for (const [dx, dy] of [[tol, 0], [-tol, 0], [0, tol], [0, -tol]]) if (onFloor(map, x + dx, y + dy)) return true;
  return false;
}
function distPolyBox(poly, x, y) {
  const b = polyBox(poly);
  const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1);
  return Math.hypot(dx, dy);
}
function distSeg(seg, x, y) {
  const [a, b] = seg;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
// Rope end position at angle `theta` (radians, 0 = straight down).
export function ropeEnd(rope, theta = 0) {
  return {x: rope.anchor[0] + rope.length * Math.sin(theta), y: rope.anchor[1] + rope.length * Math.cos(theta)};
}

// Floor access point -> point on top.
export function climbSegment(map, s, side = 0) {
  if (s.arc) {
    const acc = s.access[side ? 1 : 0];
    const base = s.arc[side ? s.arc.length - 1 : 0];
    return [acc, base];
  }
  return [s.access, s.entry];
}
