// Lit-room Align + person-pause (TJ 4:42–4:44 PM).
import test from 'node:test';
import {findDots, REFINE_PEAK_MIN, refineStep, expectedDots} from '../neural-dance/src/align-refine.js';
import assert from 'node:assert/strict';
import {
  calibrationBlobOnBorder,
  chooseAlignQuad,
  plausibleAlignQuad,
  findCalibrationMarkers,
  alignFromFrame
} from '../neural-dance/camera-markers.js';
import {
  PERSON_REBASE_LUMA,
  personInFrame
} from '../neural-dance/src/person-occlusion.js';

function paint(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return data;
}

test('person pause re-baselines on a global ambient luma jump and stays clear', () => {
  assert.ok(PERSON_REBASE_LUMA >= 20);
  const w = 80, h = 60;
  // Empty dim floor reference.
  const reference = new Float32Array(w * h).fill(70);
  // Same empty stage after lamps turn on — everything brighter, no person.
  const lit = paint(w, h, () => [140, 130, 110]);
  const hit = personInFrame(lit, w, h, {reference, sensitivity: 0.35});
  assert.equal(hit.present, false, 'ambient wash must not look like a person');
  assert.equal(hit.holding, false);
});

test('a tall dark body still pauses when the floor reference matches', () => {
  const w = 80, h = 60;
  const reference = new Float32Array(w * h).fill(160);
  const frame = paint(w, h, (x, y) => {
    // Tall person silhouette in the middle.
    if (x > 30 && x < 50 && y > 8 && y < 55) return [40, 35, 30];
    return [160, 155, 150];
  });
  const hit = personInFrame(frame, w, h, {reference, sensitivity: 0.35});
  assert.equal(hit.present, true);
});

test('calibration blobs on the image border are rejected', () => {
  assert.equal(calibrationBlobOnBorder({x: 2, y: 40, area: 40}, 160, 90), true);
  assert.equal(calibrationBlobOnBorder({x: 30, y: 20, area: 40}, 160, 90), false);
});

test('plausibleAlignQuad refuses a tall bezel-snapped trapezoid and keeps previous', () => {
  const previous = [
    {x: 0.12, y: 0.14}, {x: 0.88, y: 0.14},
    {x: 0.88, y: 0.86}, {x: 0.12, y: 0.86}
  ];
  // Skewed tilted trap like TJ's second lit-room shot — jumps far from last good.
  const bad = [
    {x: 0.00, y: 0.00}, {x: 0.55, y: 0.35},
    {x: 0.99, y: 0.95}, {x: 0.25, y: 0.55}
  ];
  const check = plausibleAlignQuad(bad, {previous, ambientHot: true, maxCornerShift: 0.12});
  assert.equal(check.ok, false);
  assert.match(check.reason, /too bright|border|bezel|aspect|jump|parallel|implausible/i);
  assert.equal(check.previous, previous);
});

test('chooseAlignQuad falls back to previous instead of applying a skewed lit-room quad', () => {
  const previous = [
    {x: 0.12, y: 0.14}, {x: 0.88, y: 0.14},
    {x: 0.88, y: 0.86}, {x: 0.12, y: 0.86}
  ];
  const skewed = [
    {x: 0.05, y: 0.02}, {x: 0.7, y: 0.25},
    {x: 0.95, y: 0.9}, {x: 0.2, y: 0.7}
  ];
  const choice = chooseAlignQuad({
    markers: {corners: skewed, found: [true, true, true, true], reason: ''},
    previous,
    ambientHot: true
  });
  assert.equal(choice.ok, false);
  assert.match(choice.reason, /too bright|implausible|parallel|jump|aspect|border/i);
  assert.deepEqual(choice.previous, previous);
});

test('temporal difference finds inset circles that absolute chroma misses on a warm wall', () => {
  const w = 160, h = 100;
  // Ambient-washed wall (warm) — absolute chroma sees wall edges.
  const off = paint(w, h, (x, y) => {
    // Physical screen bezel: darker rim.
    if (x < 4 || y < 3 || x > w - 5 || y > h - 4) return [60, 50, 40];
    return [180, 150, 110];
  });
  const on = new Uint8ClampedArray(off);
  // Inset colored circles at ~18%/82%.
  const spots = [
    [0.18, 0.18, [220, 40, 30]],
    [0.82, 0.18, [30, 200, 160]],
    [0.82, 0.82, [40, 60, 220]],
    [0.18, 0.82, [220, 200, 40]]
  ];
  for (const [nx, ny, rgb] of spots) {
    const cx = Math.round(nx * (w - 1));
    const cy = Math.round(ny * (h - 1));
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      if (dx * dx + dy * dy > 25) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      on[i] = rgb[0]; on[i + 1] = rgb[1]; on[i + 2] = rgb[2];
    }
  }
  const temporal = findCalibrationMarkers(on, w, h, undefined, off);
  assert.ok(temporal, 'temporal difference must find all four circles');
  for (let i = 0; i < 4; i++) {
    assert.ok(temporal[i]);
    assert.equal(calibrationBlobOnBorder(temporal[i], w, h), false);
  }
  const frame = {data: on, width: w, height: h, videoWidth: w, videoHeight: h};
  const read = alignFromFrame(frame, off);
  assert.ok(read.corners, 'alignFromFrame with baseline yields a quad');
  const check = plausibleAlignQuad(read.corners, {ambientHot: false});
  assert.equal(check.ok, true, check.reason);
  // Under ambientHot the same good inset-extrapolated quad still passes.
  assert.equal(plausibleAlignQuad(read.corners, {ambientHot: true}).ok, true);
});

test('findDots recovers washed temporal dots under ambient floor', () => {
  const w = 64, h = 48;
  const dark = new Uint8ClampedArray(w * h * 4);
  const lit = new Uint8ClampedArray(w * h * 4);
  // Warm ambient floor ~80 luma
  for (let i = 0; i < dark.length; i += 4) {
    dark[i] = dark[i+1] = dark[i+2] = 80; dark[i+3] = 255;
    lit[i] = lit[i+1] = lit[i+2] = 80; lit[i+3] = 255;
  }
  // Soft projector dots: +22 luma (below old absolute 30 floor)
  const dots = [[10, 10], [54, 10], [10, 38], [54, 38], [32, 10], [54, 24], [32, 38], [10, 24], [32, 24]];
  for (const [x, y] of dots) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 4;
      lit[i] = lit[i+1] = lit[i+2] = 102;
    }
  }
  const found = findDots(dark, lit, w, h, dots.map(([x,y]) => ({x,y})), 8);
  const hits = found.filter(Boolean).length;
  assert.ok(hits >= 6, 'ambient temporal dots found ' + hits);
  assert.ok(REFINE_PEAK_MIN <= 18);
});
