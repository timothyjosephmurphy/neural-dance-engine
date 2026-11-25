import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  SILHOUETTE_SHADOW,
  paintInnerChakraGlow,
  paintSilhouette,
  placeContour,
  createSilhouetteShow
} from '../neural-dance/src/silhouette.js';
import {dancerSilhouette} from '../neural-dance/src/silhouette-dance.js';

test('silhouette fill is a dark shadow, not bright white', () => {
  assert.match(SILHOUETTE_SHADOW, /rgba\(6,\s*8,\s*14/i);
  const fills = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    set fillStyle(v) { fills.push(String(v)); },
    get fillStyle() { return fills[fills.length - 1]; },
    strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineJoin: '', lineCap: '',
    createRadialGradient() {
      return {addColorStop() {}};
    },
    arc() {}, clip() {}
  };
  const pts = placeContour(dancerSilhouette(), 100, 100, 1.2);
  paintSilhouette(ctx, pts, {alpha: 0.8});
  assert.ok(fills.some(f => /rgba\(6,\s*8,\s*14/i.test(f) || f === SILHOUETTE_SHADOW));
  assert.ok(!fills.some(f => /255,\s*220,\s*176/.test(f)), 'no warm-white body fill');
});

test('inner chakra glow clips to the silhouette', () => {
  let clipped = false;
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, clip() { clipped = true; },
    createRadialGradient() { return {addColorStop() {}}; },
    arc() {},
    fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over'
  };
  const pts = placeContour(dancerSilhouette(), 0, 0, 1);
  paintInnerChakraGlow(ctx, pts, [{x: 0, y: -20, radius: 3, alpha: 0.8, color: 'hsl(0 95% 62%)'}]);
  assert.equal(clipped, true);
});

test('live show still draws the chakra string over the shadow body', () => {
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  // Order inside paint(): shadow figure → inner glow → string (7-chakra port).
  const paintFn = src.slice(src.indexOf('export function paintSilhouetteFrame'));
  const shadowAt = paintFn.indexOf('paintShadowFigure(ctx, posed');
  const glowAt = paintFn.indexOf('paintSilhouetteHalo(ctx');
  const stringAt = paintFn.indexOf('drawDancerString(ctx, axisContour');
  assert.ok(shadowAt >= 0 && glowAt > shadowAt && stringAt > glowAt,
    `order shadow=${shadowAt} glow=${glowAt} string=${stringAt}`);
});
