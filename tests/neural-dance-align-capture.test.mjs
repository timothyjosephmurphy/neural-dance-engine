// Align holds each pattern until the camera has captured it (TJ, Nov 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ALIGN_HOLD, ALIGN_HOLD_TOTAL_MS, averageFrames, averageQuads, exposureSteady, frameLuma,
  holdForCapture, largestCluster, ambientRatio, ALIGN_AMBIENT_HOT_RATIO} from '../neural-dance/src/align-capture.js';
import {alignProgressText, alignProgressFraction} from '../neural-dance/live-show.js';
import {alignProgressLine} from '../neural-dance/debug-viewer.js';

function flat(level, w = 40, h = 30) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = level; data[i + 3] = 255; }
  return {data, width: w, height: h};
}

function fakeClock() {
  let t = 0;
  return {now: () => t, wait: async (ms) => { t += ms; }};
}

const quad = (dx = 0) => [{x: 0.1 + dx, y: 0.1}, {x: 0.9 + dx, y: 0.1}, {x: 0.9 + dx, y: 0.8}, {x: 0.1 + dx, y: 0.8}];

test('hold times: each pattern stays up 0.7-3.6 s, worst case under 20 s with a retry', () => {
  assert.ok(ALIGN_HOLD.black.minMs >= 700 && ALIGN_HOLD.black.maxMs <= 3600);
  assert.ok(ALIGN_HOLD.white.minMs >= 1000 && ALIGN_HOLD.white.maxMs <= 3600);
  assert.ok(ALIGN_HOLD.marker.maxMs >= 3000 && ALIGN_HOLD.marker.tries >= 2);
  assert.ok(ALIGN_HOLD_TOTAL_MS < 20000, String(ALIGN_HOLD_TOTAL_MS));
  for (const spec of Object.values(ALIGN_HOLD)) assert.ok(spec.agree >= 3);
});

test('exposure still moving: the hold waits instead of reading', async () => {
  const clock = fakeClock();
  let level = 20;
  const grab = () => { level = Math.min(200, level * 1.4); return flat(Math.round(level)); };
  const held = await holdForCapture({grab, now: clock.now, wait: clock.wait, spec: ALIGN_HOLD.black, measure: () => ({ok: true})});
  assert.equal(held.ok, true);
  // Brightness ramps 20 -> 200 first; frames are only kept once it is flat.
  assert.ok(frameLuma(held.frame) > 190, String(frameLuma(held.frame)));
  assert.ok(held.elapsedMs >= ALIGN_HOLD.black.minMs);
});

test('marker reads must agree; a stray read does not count and the larger cluster wins', async () => {
  const clock = fakeClock();
  const reads = [quad(), quad(0.05), quad(), quad(0.05), quad(), quad(0.05), quad(), quad(0.05)];
  let i = 0;
  const held = await holdForCapture({
    grab: () => flat(60), now: clock.now, wait: clock.wait, spec: ALIGN_HOLD.marker,
    measure: () => ({ok: true, corners: reads[i++ % reads.length]})
  });
  assert.equal(held.ok, true);
  assert.ok(Math.abs(held.corners[0].x - 0.1) < 1e-9, JSON.stringify(held.corners[0]));
  const pool = [quad(0.05), quad(), quad(), quad(0.05)].map(c => ({result: {corners: c}}));
  assert.ok(Math.abs(largestCluster(pool)[0].result.corners[0].x - 0.15) < 1e-9, 'tie goes to the earliest read');
});

test('nothing captured: the hold ends at its max dwell and says why', async () => {
  const clock = fakeClock();
  const held = await holdForCapture({grab: () => flat(30), now: clock.now, wait: clock.wait, spec: ALIGN_HOLD.marker, measure: () => ({ok: false})});
  assert.equal(held.ok, false);
  assert.ok(held.elapsedMs >= ALIGN_HOLD.marker.maxMs && held.elapsedMs < ALIGN_HOLD.marker.maxMs + 300);
  assert.equal(held.reason, 'nothing detected');
  const none = await holdForCapture({grab: () => null, now: clock.now, wait: clock.wait, spec: ALIGN_HOLD.black});
  assert.equal(none.reason, 'no camera frame');
});

test('averaging: frames and corners are means (sub-pixel)', () => {
  const avg = averageFrames([flat(10), flat(11), flat(13)]);
  assert.equal(avg.data[0], 11);
  assert.equal(avg.averaged, 3);
  const q = averageQuads([quad(0), quad(0.001), quad(0.002)]);
  assert.ok(Math.abs(q[0].x - 0.101) < 1e-9);
  assert.equal(exposureSteady(100, 103), true);
  assert.equal(exposureSteady(100, 130), false);
});

test('room light is judged from one white frame, not the black frame exposure', () => {
  const w = 60, h = 40;
  const frame = (wall, screen) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const inside = x >= 15 && x < 45 && y >= 10 && y < 30;
      const v = inside ? screen : wall;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    return {data, width: w, height: h};
  };
  const corners = [{x: 0.25, y: 0.25}, {x: 0.75, y: 0.25}, {x: 0.75, y: 0.75}, {x: 0.25, y: 0.75}];
  assert.ok(ambientRatio(frame(30, 240), corners) < ALIGN_AMBIENT_HOT_RATIO);
  assert.ok(ambientRatio(frame(150, 240), corners) > ALIGN_AMBIENT_HOT_RATIO);
});

test('progress: countdown text, bar fraction, and the debug line', () => {
  const state = {phase: 'Markers', step: 3, steps: 3, attempt: 2, tries: 2, agree: 2, need: 3, frames: 14, settled: true, elapsedMs: 9000, totalMs: 16050};
  assert.match(alignProgressText(state), /^Align 3\/3 markers · try 2\/2 · 2\/3 frames · ~8 s$/);
  const f = alignProgressFraction(state);
  assert.ok(f > 0.85 && f <= 1);
  assert.match(alignProgressLine({align: {progress: state}}), /align 3\/3 markers try 2\/2 agree 2\/3 frames 14/);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /holdForCapture/);
  assert.match(show, /Showing the corners again/);
  assert.match(show, /isValidAlignmentQuad\(read\.corners\)/, 'bowtie marker quads never count');
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /setAlignProgress\(state\)/);
});
