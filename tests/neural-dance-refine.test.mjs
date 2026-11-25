// Closed-loop align refinement (TJ, Nov 9 3:45 PM). A simulated camera sees
// the projected outline dots where the TRUE quad puts them; the starting quad
// is off by the 3:48 PM residual ("a little bit to the left").
import test from 'node:test';
import assert from 'node:assert/strict';
import {cornersFromMarkerCenters} from '../neural-dance/camera-markers.js';
import {expectedDots, refineSummary, refineTargets, runAlignRefine} from '../neural-dance/src/align-refine.js';

const VW = 640;
const VH = 480;
const W = 480;
const H = 360;
const scale = {width: W, height: H, scaleX: VW / W, scaleY: VH / H};
// True circle positions from the 3:44 PM rig telemetry (camera 0-1).
const MARKS = [{x: 0.20913640245127585, y: 0.4249740472841739}, {x: 0.8137934320333814, y: 0.42663363291071527}, {x: 0.8032253649635036, y: 0.7367835901595026}, {x: 0.20951388888888886, y: 0.7250767195767196}];
const TRUTH = cornersFromMarkerCenters(MARKS.map(p => ({x: p.x * 1000, y: p.y * 1000})), 1000, 1000);

function frame(dots, blob) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = 40 + ((x * 7 + y * 13) % 3);
      if (dots) for (const d of dots) if (Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) <= 5) v = 235;
      if (blob && x > blob.x && x < blob.x + 60 && y > blob.y && y < blob.y + 150) v = 12;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return {data, width: W, height: H, scale, videoWidth: VW, videoHeight: VH};
}

function rig({personPasses = 0, interiorShift = 0} = {}) {
  const truthDots = expectedDots(TRUTH).map((p, i) => ({x: p.x * W + (i >= 4 ? interiorShift : 0), y: p.y * H}));
  let mode = null;
  let grabs = 0;
  let pass = 0;
  return {
    show(next) { mode = next; },
    wait: async () => {},
    pause: async () => {},
    alive: () => true,
    grab() {
      grabs++;
      // dark1, lit, dark2 per pass; a person walks in on dark2 for the first passes.
      const slot = (grabs - 1) % 3;
      if (slot === 0) pass++;
      const person = pass <= personPasses && slot === 2 ? {x: 200, y: 150} : null;
      return frame(mode === 'outline' ? truthDots : null, person);
    },
    get mode() { return mode; }
  };
}

function worstPx(a, b) {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y))) * VW;
}

test('refine converges from the 3:48 PM left offset to under 2 px within 4 passes', async () => {
  const start = TRUTH.map(p => ({x: p.x - 0.012, y: p.y + 0.004}));
  const io = rig();
  const reports = [];
  const out = await runAlignRefine(start, {...io, report: r => reports.push(r)});
  assert.equal(out.converged, true, JSON.stringify(out.passes));
  assert.ok(out.passes.length <= 4, JSON.stringify(out.passes));
  assert.ok(out.passes[0].errorPx > 5, 'first pass sees the offset: ' + out.passes[0].errorPx);
  assert.ok(out.finalErrorPx < 2, 'final ' + out.finalErrorPx);
  const dotsNow = expectedDots(out.quad);
  assert.ok(worstPx(dotsNow, expectedDots(TRUTH)) < 2, 'quad dots within 2 px of truth');
  assert.equal(io.mode, null, 'outline hidden at the end');
  assert.match(refineSummary(reports.at(-1)), /^Align refine: p1 [\d.]+px → p2 [\d.]+px · ✓ final [\d.]+px$/);
});

test('a person moving in frame pauses refinement without touching the quad, then it resumes', async () => {
  const start = TRUTH.map(p => ({x: p.x - 0.012, y: p.y}));
  const out = await runAlignRefine(start, rig({personPasses: 2}));
  assert.equal(out.passes[0].paused, true);
  assert.equal(out.passes[1].paused, true);
  assert.equal(out.converged, true, JSON.stringify(out.passes));
  assert.ok(out.finalErrorPx < 2);
});

test('a person who stays keeps the original quad and stops after the wait', async () => {
  const start = TRUTH.map(p => ({x: p.x - 0.012, y: p.y}));
  let t = 0;
  const out = await runAlignRefine(start, rig({personPasses: 99}), {now: () => (t += 1000), personWaitMs: 5000});
  assert.equal(out.stopped, 'person in frame');
  assert.deepEqual(out.quad, start);
  assert.ok(out.passes.every(p => p.paused));
});

test('dots that are not there (blocked lens) never change the quad', async () => {
  const start = TRUTH.map(p => ({x: p.x - 0.012, y: p.y}));
  const io = rig();
  const blind = {...io, grab: () => frame(null, null)};
  const out = await runAlignRefine(start, blind);
  assert.equal(out.converged, false);
  assert.deepEqual(out.quad, start);
  assert.equal(out.stopped, 'max passes');
  assert.equal(refineTargets().length, 9);
});

// TJ 4:03 PM: corners on the circles, silhouettes still a little left of the
// stickers in the middle. Four dots fit any quad exactly, so an interior error
// (lens, a bowed screen) was invisible. The middle dots now count.
test('refine measures the interior: a middle that sits 3 px left pulls the fit toward it', async () => {
  const io = rig({interiorShift: -3});
  const out = await runAlignRefine(TRUTH, io);
  const centerTrue = expectedDots(TRUTH)[8].x * W - 3;
  const before = Math.abs(expectedDots(TRUTH)[8].x * W - centerTrue);
  const after = Math.abs(expectedDots(out.quad)[8].x * W - centerTrue);
  assert.ok(out.passes.some(p => p.applied), JSON.stringify(out.passes));
  assert.ok(after < before * 0.6, `center error ${before.toFixed(2)} -> ${after.toFixed(2)} px`);
});

test('a dot is measured from its own blob, not the outline lines that enter its window', async () => {
  const {findDots} = await import('../neural-dance/src/align-refine.js');
  const w = 120;
  const h = 120;
  const dark = new Uint8ClampedArray(w * h * 4).fill(40);
  const lit = new Uint8ClampedArray(w * h * 4).fill(40);
  const put = (x, y) => { const i = (y * w + x) * 4; lit[i] = lit[i + 1] = lit[i + 2] = 230; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x + 0.5 - 50, y + 0.5 - 50) <= 5) put(x, y);
  // A line end entering from the right, a gap away from the dot.
  for (let x = 72; x < 100; x++) for (let y = 49; y <= 51; y++) put(x, y);
  const [dot] = findDots(dark, lit, w, h, [{x: 50, y: 50}], 43);
  assert.ok(Math.abs(dot.x - 50) < 0.3 && Math.abs(dot.y - 50) < 0.3, `${dot.x},${dot.y}`);
});
