// Continuous drift correction + post-Align sticker check math (TJ, Nov 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDriftWatch, DRIFT_MAX_STEP} from '../neural-dance/src/drift-watch.js';
import {fitCorrection, applyCorrection, correctQuad, residualStats, verifySummary} from '../neural-dance/src/sticker-verify.js';
import {quadSourceOf} from '../neural-dance/camera-markers.js';
import {driftSummary} from '../neural-dance/debug-viewer.js';

const stickers = [{x: 0.3, y: 0.4}, {x: 0.6, y: 0.5}, {x: 0.45, y: 0.7}];
const quad = () => [{x: 0.1, y: 0.2}, {x: 0.9, y: 0.2}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}];

test('camera drift: all stickers shift together -> damped quad correction, no jumps', () => {
  const w = createDriftWatch();
  w.anchor(stickers);
  const seen = stickers.map(p => ({x: p.x + 0.02, y: p.y + 0.01}));
  let q = quad();
  let applied = 0;
  for (let i = 0; i < 20; i++) {
    const before = q;
    const r = w.check(seen, q);
    if (r.quad) {
      applied++;
      const step = Math.max(...r.quad.map((p, k) => Math.hypot(p.x - before[k].x, p.y - before[k].y)));
      assert.ok(step <= DRIFT_MAX_STEP + 1e-9, 'damped step ' + step);
      q = r.quad;
    }
  }
  assert.ok(applied >= 2);
  assert.ok(Math.abs(q[0].x - 0.12) < 0.004 && Math.abs(q[0].y - 0.21) < 0.004, JSON.stringify(q[0]));
  assert.ok(w.last().residualPx < 2);
});

test('one sticker moved on its own is not camera drift', () => {
  const w = createDriftWatch();
  w.anchor(stickers);
  const moved = stickers.map((p, i) => (i === 1 ? {x: p.x + 0.04, y: p.y} : p));
  for (let i = 0; i < 6; i++) assert.equal(w.check(moved, quad()).applied, false);
  const solo = createDriftWatch();
  solo.anchor([stickers[0]]);
  const r = solo.check([{x: 0.33, y: 0.4}], quad());
  assert.equal(r.applied, false);
  assert.match(r.note, /one sticker/);
});

test('sticker check math: correction moves the quad so dots land on stickers', () => {
  const T0 = {a: 1.03, b: 0, c: -0.02, d: 0, e: 1.01, f: 0.015};
  const dots = stickers.map(p => applyCorrection(T0, p));
  const T = fitCorrection(stickers, dots);
  for (let i = 0; i < 3; i++) {
    const q = applyCorrection(T, stickers[i]);
    assert.ok(Math.hypot(q.x - dots[i].x, q.y - dots[i].y) < 1e-6);
  }
  const moved = correctQuad(quad(), T);
  assert.ok(moved.shift > 0 && moved.shift < 0.05);
  const stats = residualStats([{x: 10, y: 10}, {x: 50, y: 50}], [{x: 13, y: 14}, null]);
  assert.equal(stats.found, 1);
  assert.equal(stats.meanPx, 5);
  assert.match(verifySummary({stickers: 2, before: stats, after: {...stats, meanPx: 0.5}, applied: true, stopped: 'on target'}), /before 5 px .* after 0\.5 px · corrected/);
});

test('border lock never replaces an Align quad; drift shows in debug', () => {
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /borderOwnsQuad = cam\.committed\.length !== 4 \|\| cam\.quadSource === 'border' \|\| cam\.quadSource === 'border-lock'/);
  assert.match(cam, /cam\.driftWatch\.check\(cam\.scanStats\.candidates, cam\.committed\)/);
  assert.match(cam, /drift: cam\.driftWatch\.last\(\)/);
  assert.equal(quadSourceOf('Drift corrected.', {drift: true}), 'drift');
  assert.equal(quadSourceOf('Corrected by the sticker check.'), 'sticker-check');
  assert.match(driftSummary({drift: {residualPx: 2.5, matched: 3, anchors: 3, note: 'corrected', corrections: 2, totalShiftPx: 4.1}, cameraLock: {locked: true, settings: {zoom: 1}}}), /residual 2\.5 px · 3\/3 stickers · corrected · corrections 2 \(4\.1 px total\) · camera focus\/WB locked · zoom 1/);
});

test('debug telemetry forwards verify, drift, camera lock and align progress', async () => {
  const {collectTelemetry, smallJson} = await import('../neural-dance/live-debug.js');
  const vision = {
    align: {found: [true, true, true, true], reason: '', marks: [], progress: {phase: 'white', fraction: 0.4, text: 'Hold still'}},
    scan: {lastScanAt: 1, scanCount: 2, rawCount: 3, rejected: {}, personPause: false, candidates: [], holdMs: 900},
    verify: {before: {medianPx: 13.4}, after: {medianPx: 2.3}, applied: true},
    drift: {state: 'watching', medianPx: 1.1, applied: 0},
    cameraLock: {locked: true, focusMode: 'manual', whiteBalanceMode: 'manual', zoom: 1}
  };
  const doc = {
    getElementById(id) {
      return id === 'nd-camera-mode' ? {querySelector() { return null; }, neuralDanceCamera: {debugState() { return vision; }}} : null;
    },
    querySelector() { return null; },
    body: {classList: {contains() { return false; }}}
  };
  const t = collectTelemetry(doc, 5);
  assert.equal(t.verify.after.medianPx, 2.3);
  assert.equal(t.drift.medianPx, 1.1);
  assert.equal(t.cameraLock.focusMode, 'manual');
  assert.equal(t.align.progress.phase, 'white');
  assert.equal(t.scan.holdMs, 900);
  assert.equal(smallJson({big: 'x'.repeat(5000)}, 100), null);
  assert.equal(smallJson(null), null);
});
