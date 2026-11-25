// TJ 6:28 / 6:36 PM (da32850): with a far camera (small quad) sims drew far
// larger than sticker height and the page crashed. Heights are bounded in
// stage px, independent of the camera quad.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSilhouetteShow, medianStickerHeight, clampFigureHeight, DEFAULT_FIGURE_HEIGHT, LEGACY_FIGURE_HEIGHT, MIN_FIGURE_HEIGHT, MAX_FIGURE_HEIGHT} from '../neural-dance/src/silhouette.js';
import {simSilhouetteMarkers} from '../neural-dance/room-lab.js';

function recorder() {
  const fills = [];
  let path = [];
  const target = {
    beginPath() { path = []; },
    moveTo(x, y) { path.push({x, y}); },
    lineTo(x, y) { path.push({x, y}); },
    fill() { if (path.length >= 8) fills.push(path.slice()); },
    createRadialGradient() { return {addColorStop() {}}; },
    createLinearGradient() { return {addColorStop() {}}; },
    canvas: {width: 1000, height: 620}
  };
  const ctx = new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
  return {ctx, fills};
}
const spanY = pts => Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
function dancer(cx, cy, h) {
  const w = h * 0.45;
  const pts = [[0, -0.5], [0.15, -0.42], [0.12, -0.3], [0.5, -0.2], [0.5, -0.12], [0.18, -0.12], [0.22, 0.5], [0.08, 0.5], [0, 0.1], [-0.08, 0.5], [-0.22, 0.5], [-0.18, -0.12], [-0.5, -0.12], [-0.5, -0.2], [-0.12, -0.3], [-0.15, -0.42]];
  return pts.map(([x, y]) => ({x: cx + x * w * 2, y: cy + y * h}));
}
function simHeights(markers) {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const {ctx, fills} = recorder();
  const sims = simSilhouetteMarkers(Array.from({length: 24}, (_, i) => ({id: 100 + i, x: 100 + (i % 8) * 110, y: 120 + Math.floor(i / 8) * 180, type: i % 4})));
  show.paint(ctx, markers.concat(sims), {now: 0, xy: (x, y) => ({x, y})});
  assert.ok(fills.length >= 24, 'figures painted');
  // Articulated figures report their full stage-px height.
  return show.figureHeights().filter(f => f.kind === 'sim').map(f => f.height);
}

test('default sim size is 90 stage px (~60% of the old 149.6) when no sticker is traced', () => {
  assert.equal(DEFAULT_FIGURE_HEIGHT, 90);
  assert.ok(Math.abs(LEGACY_FIGURE_HEIGHT - 149.6) < 1e-9);
  assert.ok(DEFAULT_FIGURE_HEIGHT / LEGACY_FIGURE_HEIGHT >= 0.55 && DEFAULT_FIGURE_HEIGHT / LEGACY_FIGURE_HEIGHT <= 0.65);
  assert.equal(medianStickerHeight([]), DEFAULT_FIGURE_HEIGHT);
  const hs = simHeights([]);
  assert.ok(hs.length >= 24);
  assert.ok(Math.max(...hs) <= DEFAULT_FIGURE_HEIGHT * 1.12, 'max ' + Math.max(...hs).toFixed(1));
});

test('a small far-camera quad cannot inflate sims: heights stay bounded in stage px', () => {
  // Same physical sticker seen through a large quad (60 stage px) and through
  // a tiny far quad (projected ~5x larger, 300 / 900 stage px).
  for (const h of [120, 300, 520, 900]) {
    const sticker = {id: 1, kind: 'sticker', type: 0, x: 500, y: 300, contour: dancer(500, 300, h)};
    const med = medianStickerHeight([sticker]);
    // A real cutout (~120 px) is kept. A wild quad trace above the ceiling
    // is ignored so it cannot inflate the sims.
    if (h <= MAX_FIGURE_HEIGHT) assert.ok(Math.abs(med - h) < 1e-6, h + ' median ' + med);
    else assert.equal(med, DEFAULT_FIGURE_HEIGHT);
    const hs = simHeights([sticker]);
    const cap = h <= MAX_FIGURE_HEIGHT ? h : DEFAULT_FIGURE_HEIGHT;
    assert.ok(Math.max(...hs) <= cap * 1.12, h + ': max ' + Math.max(...hs).toFixed(1));
  }
  assert.equal(clampFigureHeight(5), MIN_FIGURE_HEIGHT);
  assert.equal(clampFigureHeight(NaN), DEFAULT_FIGURE_HEIGHT);
  assert.equal(clampFigureHeight(125), 125);
  assert.equal(clampFigureHeight(400), MAX_FIGURE_HEIGHT);
});

test('normal close-range stickers keep sticker-height sims (66d1597 behavior)', () => {
  const sticker = {id: 1, kind: 'sticker', type: 0, x: 500, y: 300, contour: dancer(500, 300, 60)};
  assert.ok(Math.abs(medianStickerHeight([sticker]) - 60) < 1e-6);
  const hs = simHeights([sticker]);
  assert.ok(Math.max(...hs) < 60 * 1.12 && Math.min(...hs) > 60 * 0.85, hs.map(v => v.toFixed(0)).join(','));
});

test('one bad frame does not stop the room; the live page never self-pauses for slowness', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /frameErrors\+\+/);
  assert.match(src, /if\(frameErrors>=30\)\{if\(!isLiveShowPage\(\)\)\{stop\('Paused'\);return;\}/);
  assert.match(src, /if\(!isLiveShowPage\(\)\)\{stop\('Paused to keep the browser responsive'\);return;\}/);
  const sil = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(sil, /Math\.min\(90, Math\.max\(18, \(\+light\.radius \|\| 4\) \* 9\)\)/);
});

test('Seed 24 spreads the sims: no two 90 px figures overlap, corners stay free for insets', async () => {
  const {spreadPositions} = await import('../neural-dance/src/sim-layout.js');
  const {insetRects} = await import('../neural-dance/src/skeleton-dancer.js');
  const p = spreadPositions();
  assert.equal(p.length, 24);
  const halfW = 22; // ~0.45 × 90 / 2 plus arms
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    const dx = Math.abs(p[i][0] - p[j][0]);
    const dy = Math.abs(p[i][1] - p[j][1]);
    assert.ok(dx >= 2 * halfW || dy >= DEFAULT_FIGURE_HEIGHT, 'sims ' + i + ',' + j + ' overlap');
  }
  for (const r of insetRects(1000, 620, 4)) {
    for (const [x, y] of p) {
      const inX = x + halfW > r.x + 6 && x - halfW < r.x + r.w - 6;
      const inY = y + 45 > r.y + 6 && y - 45 < r.y + r.h - 6;
      assert.ok(!(inX && inY), 'sim at ' + x + ',' + y + ' under an inset');
    }
  }
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /function prototypePositions\(\)\{return spreadPositions\(\);\}/);
  assert.match(room, /if\(isLegacySeed\(saved\.sim\)\)seedSimList\(\)/);
});

test('each corner inset is drawn from the same per-dancer state as its stage dancer', () => {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  for (let i = 0; i < 6; i++) { show.beat(1000 + i * 500, 1); show.beat(1000 + i * 500, 2); show.beat(1000 + i * 500, 4); show.beat(1000 + i * 500, 8); }
  const {ctx} = recorder();
  const sims = simSilhouetteMarkers(Array.from({length: 24}, (_, i) => ({id: 100 + i, x: 150 + (i % 6) * 140, y: 160 + Math.floor(i / 6) * 100, type: i % 4})));
  show.paint(ctx, sims, {now: 3700, xy: (x, y) => ({x, y})});
  const insets = show.insetStates();
  assert.equal(insets.length, 4);
  const stage = new Map(show.figureHeights().map(f => [f.id, f]));
  for (const inset of insets) {
    const src = stage.get(inset.id);
    assert.ok(src, 'inset ' + inset.id + ' has a stage dancer');
    for (const k of ['band', 'travelS', 'planted', 'strikeU', 'stringPhase']) assert.equal(inset[k], src[k], k);
  }
  assert.deepEqual(insets.map(s => s.band).sort(), [0, 1, 2, 3]);
});
