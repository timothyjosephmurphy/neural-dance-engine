// TJ 6:07 PM: re-running Align left an undersized, skewed quad; refine saw a
// steady ~88px error on every pass and refused it as a "jump".
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  REFINE_MAX_SHIFT, coherentCorrection, expectedDots, refineStep, refineTargets, runAlignRefine
} from '../neural-dance/src/align-refine.js';
import {chooseAlignQuad, plausibleAlignQuad} from '../neural-dance/camera-markers.js';

// The quad TJ's phone reported after the 6:07 PM Align (telemetry).
const LIVE_QUAD = [{x: 0.1164, y: 0.2178}, {x: 1.0545, y: 0.2363}, {x: 0.9195, y: 0.9355}, {x: 0.1176, y: 0.8448}];
// Where the stage really sits (smaller and to the left of it).
const TRUE_QUAD = [{x: 0.115, y: 0.286}, {x: 0.866, y: 0.301}, {x: 0.758, y: 0.86}, {x: 0.116, y: 0.788}]; // ~97px worst dot error, like the 88px TJ saw

const worstGap = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

test('a large but coherent refine correction is applied', () => {
  const measured = expectedDots(TRUE_QUAD);
  const before = worstGap(expectedDots(LIVE_QUAD), measured);
  assert.ok(before > REFINE_MAX_SHIFT, 'scenario really exceeds the old max shift: ' + before);
  const step = refineStep(LIVE_QUAD, measured, 640);
  assert.equal(step.ok, true, step.reason);
  assert.ok(worstGap(step.quad, TRUE_QUAD) < 0.005, 'refined to the true stage');
});

test('scattered dots (a misread) are still refused', () => {
  const measured = expectedDots(TRUE_QUAD).map((p, i) => (i === 5 ? {x: p.x + 0.13, y: p.y - 0.09} : p));
  const step = refineStep(LIVE_QUAD, measured, 640);
  assert.equal(step.ok, false);
  assert.equal(step.reason, 'jump too large');
  assert.equal(coherentCorrection(measured, refineTargets(), 0.2), null);
  // Missing corners or too few dots never take the large-correction path.
  const few = expectedDots(TRUE_QUAD).map((p, i) => (i >= 6 ? null : p));
  assert.equal(coherentCorrection(few, refineTargets(), 0.2), null);
});

function paintDots(width, height, dots, r = 5) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 12; data[i + 3] = 255; }
  for (const d of dots) {
    const cx = d.x * width, cy = d.y * height;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 230;
      }
    }
  }
  return data;
}

test('closed-loop refine converges from the 6:07 PM quad to the projected dots', async () => {
  const W = 480, H = 360;
  let mode = 'black';
  const dark = paintDots(W, H, []);
  const lit = paintDots(W, H, expectedDots(TRUE_QUAD));
  const io = {
    show(m) { mode = m; },
    wait: async () => {},
    alive: () => true,
    grab: () => ({data: mode === 'outline' ? lit : dark, width: W, height: H, videoWidth: 640, videoHeight: 480, scale: {scaleX: 640 / W, scaleY: 480 / H}})
  };
  const out = await runAlignRefine(LIVE_QUAD, io, {now: () => 0});
  assert.ok(out.passes.some(p => p.applied), JSON.stringify(out.passes));
  assert.ok(worstGap(out.quad, TRUE_QUAD) < 0.01, 'quad lands on the stage: ' + worstGap(out.quad, TRUE_QUAD) + ' ' + JSON.stringify(out.passes));
});

test('dark-room Align is not refused just for moving away from a bad last quad', () => {
  const markers = {corners: TRUE_QUAD, found: [true, true, true, true]};
  const ok = chooseAlignQuad({markers, previous: LIVE_QUAD, ambientHot: false, videoAspect: 4 / 3});
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.corners, TRUE_QUAD);
  // Lit rooms keep the jump guard.
  const hot = chooseAlignQuad({markers, previous: LIVE_QUAD, ambientHot: true, videoAspect: 4 / 3});
  assert.equal(hot.ok, false);
});

test('aspect check uses the camera frame aspect (4:3 phones)', () => {
  // A 16:9 stage seen square-on by a 4:3 camera.
  const quad = [{x: 0.1, y: 0.2}, {x: 0.9, y: 0.2}, {x: 0.9, y: 0.8}, {x: 0.1, y: 0.8}];
  assert.equal(plausibleAlignQuad(quad, {videoAspect: 4 / 3}).ok, true);
  assert.equal(plausibleAlignQuad(quad, {videoAspect: 16 / 9}).ok, false, 'the old fixed 16:9 refused it');
  const live = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(live, /chooseAlignQuad\(\{[^}]*videoAspect/);
});
