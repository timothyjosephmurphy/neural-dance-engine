import {readFileSync} from 'node:fs';
// Hotfix on dace406: sim height matches stickers; body motion slowdown;
// root→crown string with fixed chakra hue order.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BODY_MOTION_SLOWDOWN,
  crowdFullHeight,
  createSilhouetteShow,
  figureHeight,
  fullFigureContour,
  placeContour,
  TEMPLATE_SCALE
} from '../neural-dance/src/silhouette.js';
import {dancerSilhouette} from '../neural-dance/src/silhouette-dance.js';
import {
  CHAKRA_S,
  chakraPoints,
  hueAt,
  parseHueDegrees,
  STRING_CROWN_S,
  STRING_ROOT_S,
  STRING_TINT_MIX,
  stringAxis,
  stringPoints
} from '../neural-dance/src/vibrating-string.js';

test('BODY_MOTION_SLOWDOWN defaults to ~4× and is tunable on the show', () => {
  assert.ok(BODY_MOTION_SLOWDOWN >= 3 && BODY_MOTION_SLOWDOWN <= 5);
  const show = createSilhouetteShow();
  assert.equal(show.bodyMotionSlowdown(), BODY_MOTION_SLOWDOWN);
  assert.equal(show.setBodyMotionSlowdown(6), 6);
  assert.equal(show.bodyMotionSlowdown(), 6);
});

test('sim full-figure height equals sticker full-figure height', () => {
  const base = dancerSilhouette();
  const baseH = figureHeight(base);
  // A traced sticker shorter than the TEMPLATE_SCALE default.
  const stickerScale = 0.9; // under the 90 px max (TJ 6:48 PM)
  const stickerContour = placeContour(base, 200, 300, stickerScale);
  const stickerH = figureHeight(stickerContour);
  assert.ok(stickerH < baseH * TEMPLATE_SCALE * 0.9, 'fixture is below old oversized floor');

  const stickers = [{id: 100, x: 200, y: 300, kind: 'sticker', type: 0, contour: stickerContour}];
  const sims = [{id: 1, x: 400, y: 300, kind: 'sim', type: 1}];
  const median = crowdFullHeight([...stickers, ...sims]);
  assert.ok(Math.abs(median - stickerH) < 1.5, 'crowd height tracks sticker median');

  // Sticker drawn height must stay within ±15% of its own traced height.
  const stickerFull = fullFigureContour(stickerContour, 200, 300, stickerH, 100);
  assert.ok(stickerFull);
  const drawnH = figureHeight(stickerFull);
  assert.ok(Math.abs(drawnH - stickerH) / stickerH <= 0.15,
    'drawn sticker height within ±15% of traced (' + drawnH + ' vs ' + stickerH + ')');

  const simContour = fullFigureContour(null, 400, 300, median, 1);
  assert.ok(simContour);
  assert.ok(Math.abs(figureHeight(simContour) - stickerH) / stickerH <= 0.15,
    'sim height matches sticker height');
});

test('string spans root→crown only with fixed red→violet chakra order', () => {
  const body = placeContour(dancerSilhouette(), 100, 200, 2);
  const axis = stringAxis(body);
  const pts = stringPoints(axis, {band: 1, now: 0, amplitude: 0, mode: 1, freq: 1});
  assert.ok(pts && pts.length > 8);
  assert.equal(pts[0].s, 0);
  assert.equal(pts[pts.length - 1].s, 1);
  // Bottom of string is root (lower on stage = larger y); top is crown.
  assert.ok(pts[0].y > pts[pts.length - 1].y, 'root below crown');
  const span = axis.height;
  const expectedRootY = axis.top + span * STRING_ROOT_S;
  const expectedCrownY = axis.top + span * STRING_CROWN_S;
  assert.ok(Math.abs(pts[0].y - expectedRootY) < 0.5);
  assert.ok(Math.abs(pts[pts.length - 1].y - expectedCrownY) < 0.5);
  // Never reaches the feet.
  assert.ok(pts[0].y < axis.bottom - span * 0.2);

  const rootHue = parseHueDegrees(hueAt(0));
  const heartHue = parseHueDegrees(hueAt(0.45));
  const crownHue = parseHueDegrees(hueAt(1));
  assert.ok(rootHue < 25, 'root is red');
  assert.ok(heartHue > 90 && heartHue < 160, 'heart is greenish');
  assert.ok(crownHue > 240, 'crown is violet');
  assert.ok(rootHue < heartHue && heartHue < crownHue, 'order preserved');

  // Tint must not reorder (subtle nudge only).
  const tintedRoot = parseHueDegrees(hueAt(0, 'hsl(30 90% 60%)'));
  const tintedCrown = parseHueDegrees(hueAt(1, 'hsl(30 90% 60%)'));
  assert.ok(tintedRoot < tintedCrown, 'tint preserves root→crown order');
  assert.ok(Math.abs(tintedRoot - rootHue) < 20);

  const lights = chakraPoints(pts, {envelope: 1, level: 1, hue: '#88aaff'});
  // Seven chakras root→crown (TJ t2563u).
  assert.equal(lights.length, 7);
  assert.deepEqual(lights.map(l => l.id), ['root', 'sacral', 'solar', 'heart', 'throat', 'thirdEye', 'crown']);
  const lh = lights.map(l => parseHueDegrees(l.color));
  for (let i = 1; i < lh.length; i++) assert.ok(lh[i - 1] <= lh[i], 'chakra lights keep order under tint ' + lh);
  assert.ok(CHAKRA_S[0].id === 'root' && CHAKRA_S[6].id === 'crown');
});

test('Scan stickers ignores stage-echo so middle stickers are not vetoed', () => {
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /collectScan\(frame, scale, tick\.flash, true\)/);
  assert.match(cam, /White\/black Scan must ignore stage-echo/);
});

test('ripple defaults bright enough for projector rainbow waves', () => {
  const ripple = readFileSync(new URL('../neural-dance/src/water-ripple.js', import.meta.url), 'utf8');
  // Default lowered to 0.20 (TJ 11:31 AM); saved values still win.
  assert.match(ripple, /RIPPLE_DEFAULT_INTENSITY = 0\.20/);
  assert.match(ripple, /energy < 0\.045/);
  assert.match(ripple, /Positive-only additive light/);
  assert.match(ripple, /globalCompositeOperation = 'lighter'/);
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /z-index:3/);
  assert.match(room, /mix-blend-mode:screen/);
  assert.match(room, /migrateRippleDefaultOn/);
});
