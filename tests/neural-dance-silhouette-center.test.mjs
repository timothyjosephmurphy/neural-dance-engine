// TJ, Nov 9 4:02-4:03 PM: silhouettes sat about half a dancer-width left of
// the stickers, and sim dancers were drawn several times a sticker's size.
import test from 'node:test';
import assert from 'node:assert/strict';
import {areaCentroid, createSilhouetteShow} from '../neural-dance/src/silhouette.js';
import {retainContour} from '../neural-dance/src/blank-scan.js';
import {dancerRingRadius, simSilhouetteMarkers} from '../neural-dance/room-lab.js';

function recorder() {
  const fills = [];
  let path = [];
  const target = {
    beginPath() { path = []; },
    moveTo(x, y) { path.push({x, y}); },
    lineTo(x, y) { path.push({x, y}); },
    fill() { if (path.length >= 3) fills.push(path.slice()); },
    createRadialGradient() { return {addColorStop() {}}; },
    createLinearGradient() { return {addColorStop() {}}; }
  };
  const ctx = new Proxy(target, {
    get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); },
    set() { return true; }
  });
  return {ctx, fills};
}

// A dancer outline (stage px) roughly the size of TJ's stickers.
function dancer(cx, cy, h = 60) {
  const w = h * 0.45;
  const pts = [[0, -0.5], [0.15, -0.42], [0.12, -0.3], [0.5, -0.2], [0.5, -0.12], [0.18, -0.12], [0.22, 0.5], [0.08, 0.5], [0, 0.1], [-0.08, 0.5], [-0.22, 0.5], [-0.18, -0.12], [-0.5, -0.12], [-0.5, -0.2], [-0.12, -0.3], [-0.15, -0.42]];
  return pts.map(([x, y]) => ({x: cx + x * w * 2, y: cy + y * h}));
}

function bbox(points) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return {w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
}

// 7-chakra port (TJ t2563u): every dancer is an articulated shadow figure.
// The show reports each figure's stage center and full height.
function painted(markers) {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const {ctx, fills} = recorder();
  show.paint(ctx, markers, {now: 0});
  assert.ok(fills.length >= markers.length, 'each dancer fills a dark body');
  const figs = show.figureHeights();
  assert.equal(figs.length, markers.length);
  return figs;
}

test('the silhouette center equals the sticker center, even when the traced outline drifted', () => {
  const sticker = {x: 568, y: 291};
  // Outline re-traced from the part of the sticker left of its own glow:
  // half a dancer-width (12 px) left of the latched point.
  const marker = {id: 1, kind: 'sticker', type: 0, x: sticker.x, y: sticker.y, contour: dancer(sticker.x - 12, sticker.y)};
  const fills = painted([marker]);
  assert.ok(fills.length >= 1, 'silhouette filled');
  const c = fills[0];
  assert.ok(Math.abs(c.x - sticker.x) < 0.5 && Math.abs(c.y - sticker.y) < 0.5, `center ${c.x.toFixed(2)},${c.y.toFixed(2)}`);
});

test('three rig stickers: every silhouette lands on its sticker', () => {
  const spots = [{x: 495, y: 411}, {x: 568, y: 291}, {x: 371, y: 292}];
  const markers = spots.map((s, i) => ({id: i + 1, kind: 'sticker', type: i, x: s.x, y: s.y, contour: dancer(s.x - 9, s.y + 2)}));
  const fills = painted(markers);
  assert.equal(fills.length, 3);
  fills.forEach((f, i) => {
    const c = f;
    assert.ok(Math.hypot(c.x - spots[i].x, c.y - spots[i].y) < 0.5, `sticker ${i + 1}: ${c.x.toFixed(1)},${c.y.toFixed(1)}`);
  });
});

test('sim dancers are drawn the same size as the sticker dancers', () => {
  const sticker = {id: 1, kind: 'sticker', type: 0, x: 400, y: 300, contour: dancer(400, 300, 60)};
  const sims = simSilhouetteMarkers([{id: 7, x: 700, y: 300, type: 2}]);
  assert.equal(sims[0].kind, 'sim');
  const fills = painted([sticker].concat(sims));
  assert.equal(fills.length, 2);
  const a = {h: fills[0].height};
  const b = {h: fills[1].height};
  assert.ok(Math.abs(b.h - a.h) / a.h < 0.05, `sticker ${a.h.toFixed(1)} px tall, sim ${b.h.toFixed(1)} px`);
  const c = fills[1];
  assert.ok(Math.hypot(c.x - 700, c.y - 300) < 0.5);
  // The engine ring (the dancer's aura in the dancer layer): same for a
  // wandering sim (high activity) and a resting sticker in silhouette mode.
  assert.equal(dancerRingRadius(1, 2.4, true), dancerRingRadius(0, 1, true));
  assert.ok(dancerRingRadius(1, 2.4, false) > dancerRingRadius(0, 1, false));
});

test('a latched outline is not replaced by a fragment of itself', () => {
  const full = dancer(300, 300, 60);
  const fragment = dancer(306, 318, 24);
  assert.equal(retainContour(full, fragment), full);
  const similar = dancer(301, 300, 58);
  assert.equal(retainContour(full, similar), similar);
});
