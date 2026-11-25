// Perspective stage floor (TJ 2:12 PM): receding ground, ripples on the plane.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {echoGridLike} from '../neural-dance/camera-markers.js';
import {
  PERSPECTIVE_DEFAULT,
  PERSPECTIVE_PREF_KEY,
  STAGE_W,
  STAGE_H,
  FLOOR_GRID_STROKE,
  FLOOR_GRID_WIDTH,
  clampPerspective,
  floorHomography,
  floorTrapezoid,
  vanishingPoint,
  projectFloor,
  unprojectFloor,
  screenToFloorUV,
  warpImageData,
  savedPerspective,
  savePerspective,
  drawSacredFloor
} from '../neural-dance/src/perspective-floor.js';

const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');

test('perspective strength clamps and defaults to moderate', () => {
  assert.equal(PERSPECTIVE_DEFAULT, 0.5);
  assert.equal(clampPerspective(undefined), 0.5);
  assert.equal(clampPerspective(NaN), 0.5);
  assert.equal(clampPerspective(-1), 0);
  assert.equal(clampPerspective(2), 1);
  assert.equal(clampPerspective(0.25), 0.25);
});

test('strength 0 is an identity mapping', () => {
  const warp = floorHomography(0);
  assert.equal(warp.identity, true);
  assert.deepEqual(projectFloor(warp, 200, 400), {x: 200, y: 400});
  assert.deepEqual(unprojectFloor(warp, 200, 400), {x: 200, y: 400});
  assert.deepEqual(screenToFloorUV(0, 0, warp), {x: 0, y: 0});
  assert.deepEqual(screenToFloorUV(STAGE_W, STAGE_H, warp), {x: 1, y: 1});
});

test('default moderate floor recedes: far edge narrower, vanishing point above, depth compresses', () => {
  const warp = floorHomography(PERSPECTIVE_DEFAULT);
  assert.equal(warp.identity, false);
  const trap = floorTrapezoid(PERSPECTIVE_DEFAULT);
  const farW = trap[1].x - trap[0].x;
  const nearW = trap[2].x - trap[3].x;
  assert.ok(farW < nearW - 80, `far ${farW} should be clearly narrower than near ${nearW}`);
  assert.ok(nearW > STAGE_W * 0.9, 'near edge stays nearly full width');
  const vp = vanishingPoint(PERSPECTIVE_DEFAULT);
  assert.equal(vp.finite, true);
  assert.ok(Math.abs(vp.x - STAGE_W / 2) < 1, 'vanishing point is centered');
  assert.ok(vp.y < -200, `vanishing point sits above the frame, got ${vp.y}`);
  const back = projectFloor(warp, 500, 155).y - projectFloor(warp, 500, 0).y;
  const front = projectFloor(warp, 500, 620).y - projectFloor(warp, 500, 465).y;
  assert.ok(front > back * 1.15, `front spacing ${front} should exceed back spacing ${back}`);
});

test('a ring in floor space is wider in front than in back', () => {
  const warp = floorHomography(PERSPECTIVE_DEFAULT);
  const widthAt = (cy, r = 80) => {
    const left = projectFloor(warp, 500 - r, cy);
    const right = projectFloor(warp, 500 + r, cy);
    return right.x - left.x;
  };
  const front = widthAt(520);
  const back = widthAt(120);
  assert.ok(front > back * 1.12, `front ring ${front} should be wider than back ${back}`);
});

test('project / unproject round-trips a dancer foot on the perspective floor', () => {
  const warp = floorHomography(PERSPECTIVE_DEFAULT);
  const feet = [[280, 430], [520, 400], [780, 440], [200, 180], [800, 200]];
  for (const [x, y] of feet) {
    const uv = screenToFloorUV(x, y, warp);
    const floor = {x: uv.x * STAGE_W, y: uv.y * STAGE_H};
    const back = projectFloor(warp, floor.x, floor.y);
    assert.ok(Math.hypot(back.x - x, back.y - y) < 0.75, `foot (${x},${y}) missed by ${Math.hypot(back.x - x, back.y - y)}`);
  }
});

test('a floor-space splat warps back to the screen foot that sourced it', () => {
  const warp = floorHomography(PERSPECTIVE_DEFAULT);
  const sw = 100, sh = 62, dw = 100, dh = 62;
  const src = new Uint8ClampedArray(sw * sh * 4);
  const stamp = (fx, fy) => {
    const cx = Math.round(fx / STAGE_W * (sw - 1));
    const cy = Math.round(fy / STAGE_H * (sh - 1));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
        const o = (y * sw + x) * 4;
        src[o] = src[o + 1] = src[o + 2] = src[o + 3] = 255;
      }
    }
  };
  const foot = {x: 280, y: 430};
  const uv = screenToFloorUV(foot.x, foot.y, warp);
  stamp(uv.x * STAGE_W, uv.y * STAGE_H);
  const out = warpImageData(src, sw, sh, dw, dh, warp.inv);
  const sx = Math.round(foot.x / STAGE_W * (dw - 1));
  const sy = Math.round(foot.y / STAGE_H * (dh - 1));
  let peak = 0, peakAt = null;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const a = out[(y * dw + x) * 4 + 3];
      if (a > peak) { peak = a; peakAt = {x, y}; }
    }
  }
  assert.ok(peak > 80, 'warped splat is visible');
  assert.ok(Math.hypot(peakAt.x - sx, peakAt.y - sy) <= 2, `peak at ${peakAt.x},${peakAt.y} not at foot ${sx},${sy}`);
});

test('the dim floor grid stays echo-safe and the live path uses the projective floor', () => {
  assert.equal(FLOOR_GRID_STROKE, 'rgba(145,150,180,.22)');
  assert.equal(FLOOR_GRID_WIDTH, 1.4);
  // Composite the stroke over the locked stage fill #080910.
  // r=145,g=150,b=180 against 8,9,16
  const r = Math.round(145 * 0.22 + 8 * 0.78);
  const g = Math.round(150 * 0.22 + 9 * 0.78);
  const b = Math.round(180 * 0.22 + 16 * 0.78);
  assert.equal(echoGridLike(r, g, b), true);
  assert.match(room, /setPerspective/);
  assert.match(livePage, /data-control="floor-perspective"[^>]*value="0\.50"/);
  assert.match(debugPage, /data-debug-control="floor-perspective"[^>]*value="0\.50"/);
});

test('perspective pref persists a chosen strength and falls back to moderate', () => {
  const store = {};
  const box = {getItem: k => store[k], setItem: (k, v) => { store[k] = v; }};
  assert.equal(savedPerspective(box), PERSPECTIVE_DEFAULT);
  assert.equal(savePerspective(box, 0.75), 0.75);
  assert.equal(store[PERSPECTIVE_PREF_KEY], JSON.stringify(0.75));
  assert.equal(savedPerspective(box), 0.75);
  assert.equal(savePerspective(box, 4), 1);
});

test('drawSacredFloor strokes the rings and crosses through the warp', () => {
  const warp = floorHomography(PERSPECTIVE_DEFAULT);
  const strokes = [];
  let path = [];
  const ctx = {
    save() {},
    restore() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['M', x, y]); },
    lineTo(x, y) { path.push(['L', x, y]); },
    stroke() { strokes.push(path.slice()); },
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: ''
  };
  drawSacredFloor(ctx, null, warp);
  assert.equal(ctx.strokeStyle, FLOOR_GRID_STROKE);
  assert.equal(ctx.lineWidth, FLOOR_GRID_WIDTH);
  // 3 ellipses + 4 cross lines
  assert.equal(strokes.length, 7);
  const ring = strokes[0];
  assert.ok(ring.length > 50, 'ellipse is densely sampled');
  const xs = ring.map(p => p[1]);
  const ys = ring.map(p => p[2]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(width > height, 'a projected floor ring is wider than it is tall');
});
