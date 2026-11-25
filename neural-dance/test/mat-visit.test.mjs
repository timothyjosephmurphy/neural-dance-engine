// Real-frame follow-ups: high-saturation black frame, thin mat, slanted
// keystone, explicit Detect past a shifted prior, and visit coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectPaintingFrameSweep, fitMatBorder, frameFitsPrior, innerMatTrapezoid, pointInQuad, sideEdgeClass} from '../src/painting-frame.js';
import {createPaintingSession} from '../src/painting-session.js';
import {coverageFromRead, createStaticBackground, isSkinTone, personInFrame, PERSON_BG_STABLE_MS, PERSON_LARGE_HOLD, PERSON_MOTION_HOLD, PERSON_SKIN_FRACTION} from '../src/person-occlusion.js';
import {createVisitScan, VISIT_CLEAR_MS, visitCoveragePresent} from '../src/visit-scan.js';

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return data;
}

// Near-black frame with inflated saturation, a 5 px white mat, and a
// keystone that is wider at the top. A dark block sits outside the frame.
function thinMatScene() {
  const w = 480, h = 360;
  const inner = [{x: 78, y: 158}, {x: 418, y: 170}, {x: 396, y: 292}, {x: 100, y: 280}];
  const outer = [{x: 64, y: 144}, {x: 432, y: 156}, {x: 410, y: 306}, {x: 86, y: 294}];
  const opening = [{x: 83, y: 163}, {x: 413, y: 175}, {x: 391, y: 287}, {x: 105, y: 275}];
  const frame = [46, 10, 8];
  const rgba = paint(w, h, (x, y) => {
    let c = [168, 96, 44];
    if (x < 40) c = frame;
    if (x >= 170 && x <= 290 && y >= 28 && y <= 150) c = frame;
    if (pointInQuad(outer, x, y)) c = frame;
    if (pointInQuad(inner, x, y)) c = [220, 214, 206];
    if (pointInQuad(opening, x, y)) c = [86, 28, 36];
    return c;
  });
  return {rgba, w, h, inner};
}

test('high-saturation black frame and a 5 px mat lock the slanted inner trapezoid', () => {
  const {rgba, w, h, inner} = thinMatScene();
  const border = fitMatBorder(rgba, w, h);
  assert.ok(border && border.matSides >= 3, 'border ' + (border && border.matSides));
  assert.equal(innerMatTrapezoid(border.quad, h), true);
  const found = detectPaintingFrameSweep(rgba, w, h);
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.edge, 'border');
  assert.equal(innerMatTrapezoid(found.quad, h), true);
  const top = Math.hypot(found.quad[1].x - found.quad[0].x, found.quad[1].y - found.quad[0].y);
  const bot = Math.hypot(found.quad[2].x - found.quad[3].x, found.quad[2].y - found.quad[3].y);
  assert.ok(top > bot + 12, 'flattened ' + top.toFixed(1) + ' ' + bot.toFixed(1));
  found.quad.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - inner[i].x, p.y - inner[i].y) < 8, 'corner ' + i + ' ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
  });
  assert.ok(Math.min(found.quad[0].x, found.quad[3].x) > 55, 'left edge climbed into the outer block');
  assert.ok(Math.min(found.quad[0].y, found.quad[1].y) > 140, 'top edge climbed into the speaker');
});

test('explicit Detect accepts a high-confidence mat past a shifted prior', () => {
  const {rgba, w, h, inner} = thinMatScene();
  const found = detectPaintingFrameSweep(rgba, w, h);
  assert.equal(found.edge, 'border');
  const truth = inner.map(p => ({x: p.x / w, y: p.y / h}));
  const shifted = truth.map(p => ({x: p.x - 0.1, y: p.y + 0.04}));
  assert.equal(frameFitsPrior(truth, shifted), false);
  const frame = {data: rgba, width: w, height: h};
  const session = createPaintingSession();
  assert.equal(session.lockFrame(shifted), true);
  const blocked = session.detect(frame);
  assert.equal(blocked.ok, false);
  assert.equal(session.frameLocked(), true);
  assert.ok(Math.abs(session.frameQuad()[0].x - shifted[0].x) < 1e-6);
  const forced = session.detect(frame, {force: true});
  assert.equal(forced.ok, true, forced.reason);
  assert.equal(forced.edge, 'border');
  assert.equal(session.frameLocked(), true);
  assert.ok(Math.abs(session.frameQuad()[0].x - shifted[0].x) < 1e-6, 'the saved quad stays until Accept');
  const pending = session.pending();
  assert.ok(pending);
  pending.forEach((p, i) => {
    assert.ok(Math.hypot(p.x * w - inner[i].x, p.y * h - inner[i].y) < 10, 'pending ' + i);
  });
  assert.equal(innerMatTrapezoid(pending.map(p => ({x: p.x * w, y: p.y * h})), h), true);
});

function wall(w, h, rgb) {
  return paint(w, h, () => rgb);
}
function learn(bg, rgba, w, h, n = 6) {
  let read = null;
  for (let i = 0; i < n; i++) {
    read = personInFrame(rgba, w, h, {background: bg, step: 4});
    bg.update(read.cells, read.cols, read.rows, {clear: true, now: i * 200});
  }
  return read;
}

test('cold start stays idle, a person in a light change stays present, and a pure light change does not visit', () => {
  const w = 160, h = 120;
  const empty = wall(w, h, [176, 176, 172]);
  const cold = createStaticBackground();
  assert.equal(cold.ready(), false);
  const early = personInFrame(empty, w, h, {background: cold, step: 4});
  assert.equal(early.background, false);
  assert.equal(coverageFromRead(early), 0);
  const visit = createVisitScan();
  assert.equal(visit.observe({
    present: visitCoveragePresent(coverageFromRead(early), false, false, false),
    now: 0, learned: true, sceneMatch: true
  }).state, 'idle');

  const bg = createStaticBackground();
  learn(bg, empty, w, h);
  assert.equal(bg.ready(), true);
  const settled = personInFrame(empty, w, h, {background: bg, step: 4});
  assert.equal(settled.present, false);
  assert.equal(coverageFromRead(settled), 0);

  const person = paint(w, h, (x, y) => {
    // Darker than the shifted wall, so a real face still counts in a light change.
    if (x > 50 && x < 110 && y > 20 && y < 110) return [100, 60, 38];
    return [210, 70, 36];
  });
  const seen = personInFrame(person, w, h, {background: bg, step: 4});
  assert.equal(seen.globalChange, true, 'static ' + seen.staticFraction);
  assert.equal(seen.present, true);
  assert.ok(seen.skinFraction >= PERSON_SKIN_FRACTION || seen.bodyFraction >= PERSON_LARGE_HOLD || seen.fraction >= PERSON_SKIN_FRACTION);
  assert.ok(coverageFromRead(seen) > 0);

  const lamp = wall(w, h, [210, 70, 36]);
  const light = personInFrame(lamp, w, h, {background: bg, step: 4});
  assert.equal(light.globalChange, true);
  assert.equal(light.present, false);
  assert.equal(coverageFromRead(light), 0);
  const armed = createVisitScan();
  assert.equal(armed.observe({
    present: visitCoveragePresent(coverageFromRead(light), false, light.present, false),
    now: 1000, learned: true, sceneMatch: true
  }).scan, false);
  assert.equal(armed.observe({
    present: false, now: 1000 + VISIT_CLEAR_MS, learned: true, sceneMatch: true
  }).scan, false);

  const show = readFileSync(new URL('../live-show.js', import.meta.url), 'utf8');
  assert.match(show, /personBackgroundReady/);
  assert.match(show, /visitCoveragePresent/);
  assert.match(show, /sceneMatchesVisit/);
});

test('a green projector line on the white mat still scores as a mat edge', () => {
  const w = 220, h = 160;
  const quad = [{x: 40, y: 28}, {x: 180, y: 28}, {x: 180, y: 132}, {x: 40, y: 132}];
  const rgba = paint(w, h, (x, y) => {
    const inside = x >= 40 && x <= 180 && y >= 28 && y <= 132;
    if (!inside) return [18, 16, 16];
    if (x >= 43 && x <= 49 && y >= 36 && y <= 124) return [30, 220, 40];
    if (x < 62 || x > 158 || y < 46 || y > 116) return [222, 216, 208];
    return [72, 28, 38];
  });
  const left = sideEdgeClass(rgba, w, h, quad, 3, 4);
  assert.equal(left.kind, 'mat', JSON.stringify(left));
  assert.ok(left.inn > 80, left.inn);
  const plain = sideEdgeClass(rgba, w, h, quad, 1);
  assert.equal(plain.kind, 'mat', JSON.stringify(plain));
});

test('a cabinet edge above the painting does not steal the right mat', () => {
  const w = 480, h = 360;
  const inner = [{x: 72, y: 156}, {x: 404, y: 164}, {x: 386, y: 248}, {x: 90, y: 240}];
  const outer = [{x: 56, y: 140}, {x: 420, y: 148}, {x: 402, y: 262}, {x: 74, y: 254}];
  const opening = [{x: 80, y: 164}, {x: 396, y: 172}, {x: 378, y: 240}, {x: 98, y: 232}];
  const frame = [42, 10, 8];
  const rgba = paint(w, h, (x, y) => {
    let c = [176, 150, 96];
    if (y >= 43 && y <= 148 && x < 430) c = [214, 208, 198];
    if (y >= 43 && y <= 148 && x >= 430 && x <= 462) c = frame;
    if (pointInQuad(outer, x, y)) c = frame;
    if (pointInQuad(inner, x, y)) c = [220, 214, 206];
    if (pointInQuad(opening, x, y)) c = [80, 26, 34];
    return c;
  });
  const found = fitMatBorder(rgba, w, h);
  assert.ok(found, 'border missing');
  assert.ok(found.matSides >= 3, 'sides ' + found.matSides);
  assert.ok(found.quad[1].x < 430, 'top-right followed the cabinet ' + found.quad[1].x.toFixed(1));
  assert.ok(Math.abs(found.quad[1].x - inner[1].x) < 16, 'tr ' + found.quad[1].x.toFixed(1));
  assert.ok(Math.abs(found.quad[2].x - inner[2].x) < 16, 'br ' + found.quad[2].x.toFixed(1));
});

test('warm-up does not latch a person, and raw motion is not coverage', () => {
  const w = 160, h = 120;
  const bg = createStaticBackground();
  assert.equal(bg.ready(), false);
  const frame = paint(w, h, (x, y) => (x > 40 && x < 120 && y > 8 && y < 112 ? [180, 120, 80] : [48, 44, 40]));
  const early = personInFrame(frame, w, h, {background: bg, step: 4});
  assert.equal(early.present, false);
  assert.equal(early.holding, false);
  const bare = personInFrame(frame, w, h, {step: 4});
  assert.equal(bare.present, true);
  const quiet = coverageFromRead({
    background: true, globalChange: false, present: false,
    skinFraction: 0, bodyFraction: 0, fraction: 0,
    staticFraction: 0.997, motion: 0.69
  });
  assert.equal(quiet, 0);
  const hung = coverageFromRead({
    background: true, globalChange: false, present: false,
    skinFraction: 0.01, bodyFraction: 0, fraction: 0.01,
    staticFraction: 0.94, motion: 0
  });
  assert.equal(hung, 0);
});

test('a globally stale warm room is not a person and recovery does not scan', () => {
  assert.equal(isSkinTone(200, 150, 110), true);
  const w = 160, h = 120;
  const bg = createStaticBackground();
  learn(bg, wall(w, h, [176, 176, 172]), w, h);
  const warm = wall(w, h, [200, 150, 110]);
  const read = personInFrame(warm, w, h, {background: bg, step: 4});
  assert.equal(read.globalChange, true, 'static ' + read.staticFraction);
  assert.equal(read.present, false);
  assert.equal(read.holding, false);
  assert.ok(read.skinFraction < PERSON_SKIN_FRACTION, 'skin ' + read.skinFraction);
  assert.equal(coverageFromRead(read), 0);
  const visit = createVisitScan();
  let scanned = false;
  for (let t = 0; t <= 28000; t += 400) {
    const step = visit.observe({
      present: visitCoveragePresent(coverageFromRead(read), false, read.present, false, false),
      now: t, learned: true, sceneMatch: true
    });
    if (step.scan) scanned = true;
  }
  visit.observe({present: true, now: 28000, learned: true, sceneMatch: true});
  visit.cancel();
  const recovered = visit.observe({present: false, now: 28000 + VISIT_CLEAR_MS, learned: true, sceneMatch: true});
  assert.equal(scanned, false);
  assert.equal(recovered.scan, false);
  assert.equal(visitCoveragePresent(0.018, false, false, true, true), true);
  assert.equal(visitCoveragePresent(0.018, false, false, false, true), false);
  assert.equal(visitCoveragePresent(0.018, false, false, true, false), false);
});

test('a brief global flash does not re-learn, and a still empty room does', () => {
  const w = 80, h = 60;
  const bg = createStaticBackground({stableMs: 1000});
  const gray = wall(w, h, [176, 176, 172]);
  const warm = wall(w, h, [200, 150, 110]);
  learn(bg, gray, w, h);
  const shifted = personInFrame(warm, w, h, {background: bg, step: 4});
  assert.equal(shifted.globalChange, true);
  assert.equal(shifted.present, false);
  assert.equal(bg.update(shifted.cells, shifted.cols, shifted.rows, {clear: true, now: 100, global: true}), true);
  bg.update(shifted.cells, shifted.cols, shifted.rows, {clear: true, now: 400, global: true});
  const flashed = personInFrame(warm, w, h, {background: bg, step: 4});
  assert.equal(flashed.globalChange, true, 'a 300 ms flash left the reference');
  for (let t = 1000; t <= 5000; t += 200) {
    const again = personInFrame(warm, w, h, {background: bg, step: 4});
    bg.update(again.cells, again.cols, again.rows, {clear: true, now: t, global: !!again.globalChange});
  }
  const healed = personInFrame(warm, w, h, {background: bg, step: 4});
  assert.equal(healed.globalChange, false, 'static ' + healed.staticFraction);
  assert.ok(healed.staticFraction > 0.8, 'static ' + healed.staticFraction);
  assert.ok(PERSON_BG_STABLE_MS >= 1000);
});

test('motion or an open visit keeps off-painting skin during a global change', () => {
  const w = 80, h = 60;
  const bg = createStaticBackground();
  const gray = wall(w, h, [176, 176, 172]);
  const warm = wall(w, h, [200, 150, 110]);
  learn(bg, gray, w, h);
  const quiet = personInFrame(warm, w, h, {background: bg, step: 4});
  assert.ok(quiet.motion < PERSON_MOTION_HOLD, 'motion ' + quiet.motion);
  assert.equal(quiet.globalChange, true);
  assert.ok(quiet.skinFraction < PERSON_SKIN_FRACTION, 'quiet skin ' + quiet.skinFraction);
  assert.equal(quiet.present, false);
  const dark = personInFrame(wall(w, h, [16, 16, 16]), w, h, {background: bg, step: 4});
  const moving = personInFrame(warm, w, h, {background: bg, step: 4, previous: dark.grid});
  assert.ok(moving.motion >= PERSON_MOTION_HOLD, 'motion ' + moving.motion);
  assert.ok(moving.skinFraction >= PERSON_SKIN_FRACTION, 'moving skin ' + moving.skinFraction);
  assert.equal(moving.present, true);
  const visiting = personInFrame(warm, w, h, {background: bg, step: 4, inVisit: true});
  assert.equal(visiting.motion, 0);
  assert.equal(visiting.present, true);
  assert.ok(visiting.skinFraction >= PERSON_SKIN_FRACTION);
});

test('warm sunset paint inside the frame does not pause, and a paused stale background absorbs still cells', () => {
  const w = 160, h = 120;
  const quad = [{x: 36, y: 28}, {x: 124, y: 30}, {x: 120, y: 92}, {x: 40, y: 90}];
  const wall = [168, 168, 164];
  const cool = [120, 118, 114];
  const warm = [200, 150, 110];
  const empty = paint(w, h, (x, y) => pointInQuad(quad, x, y) ? cool : wall);
  const sunset = paint(w, h, (x, y) => pointInQuad(quad, x, y) ? warm : wall);
  const bg = createStaticBackground({stableMs: 1000});
  learn(bg, empty, w, h);
  assert.equal(bg.ready(), true);
  const read = personInFrame(sunset, w, h, {background: bg, step: 4, contentQuad: quad});
  assert.equal(read.present, false, 'skin ' + read.skinFraction + ' body ' + read.bodyFraction);
  assert.ok(read.skinFraction < PERSON_SKIN_FRACTION);
  assert.equal(coverageFromRead(read), 0);
  const open = personInFrame(sunset, w, h, {background: bg, step: 4});
  assert.equal(open.present, true, 'the same warm block outside the frame gate is still skin');
  assert.equal(bg.update(read.cells, read.cols, read.rows, {clear: true, now: 5000, global: true}), true);
  assert.equal(bg.update(read.cells, read.cols, read.rows, {clear: false, now: 5000, global: true}), true);
  for (let t = 5200; t <= 8000; t += 200) {
    bg.update(read.cells, read.cols, read.rows, {clear: false, now: t, global: true});
  }
  const healed = personInFrame(sunset, w, h, {background: bg, step: 4, contentQuad: quad});
  assert.equal(healed.present, false);
  assert.ok(healed.staticFraction > 0.8, 'static ' + healed.staticFraction);
  const hand = paint(w, h, (x, y) => {
    if (x > 70 && x < 108 && y > 36 && y < 100) return [140, 90, 60];
    return pointInQuad(quad, x, y) ? warm : wall;
  });
  const seen = personInFrame(hand, w, h, {background: bg, step: 4, contentQuad: quad});
  assert.equal(seen.present, true, 'a darker hand over the painting still counts');
  assert.ok(coverageFromRead(seen) > 0);
});
