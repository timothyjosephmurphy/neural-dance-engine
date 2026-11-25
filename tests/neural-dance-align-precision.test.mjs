// Projector alignment precision (TJ Nov 11, strategies 1, 3, 4): robust
// multi-point homography, per-point residuals, Gray-code structured light,
// crosshair / walk verification, saved calibration, 1-point recheck.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyH, fitHomography, robustHomography, quadFromH, hFromQuad, invertH, gridTargets,
  pointResiduals, residualStats, precisionSummary,
  grayEncode, grayDecode, grayBitsFor, grayCellLit, decodeGraySamples,
  structuredLayout, structuredPatterns, runStructuredLight, detectDiffBlobs, lumaOf,
  matchStickers, crosshairOffsets, crosshairCorrection, CROSSHAIR_TARGETS, verdictFor,
  saveCalibration, readSavedCalibration, recheckResult, readGridSize, writeGridSize,
  readStageWidthCm, writeStageWidthCm
} from '../neural-dance/src/align-precision.js';
import {fitCorrection} from '../neural-dance/src/sticker-verify.js';
import {refineTargets, fitQuadLS, refineStep, expectedDots} from '../neural-dance/src/align-refine.js';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gauss(r) { return (r() + r() + r() + r() - 2) * 1.2247; }
// A keystoned floor seen from a phone above it (camera 0-1).
const TRUE_QUAD = [{x: 0.12, y: 0.22}, {x: 0.9, y: 0.18}, {x: 0.86, y: 0.84}, {x: 0.08, y: 0.8}];
const H_TRUE = hFromQuad(TRUE_QUAD);
const maxCorner = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

function memStore() {
  const m = new Map();
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
}

test('fitHomography recovers an exact map from 4 and from 16 points', () => {
  const tg = gridTargets(4);
  const cam = tg.map(t => applyH(H_TRUE, t.x, t.y));
  const H4 = fitHomography(tg.slice(0, 4), cam.slice(0, 4));
  const H16 = fitHomography(tg, cam);
  assert.ok(maxCorner(quadFromH(H4), TRUE_QUAD) < 1e-9);
  assert.ok(maxCorner(quadFromH(H16), TRUE_QUAD) < 1e-9);
  const inv = invertH(H16);
  const back = applyH(inv, cam[7].x, cam[7].y);
  assert.ok(Math.hypot(back.x - tg[7].x, back.y - tg[7].y) < 1e-9);
});

test('noisy 3x3 and 4x4 grids: least squares beats any 4 corners alone', () => {
  for (const n of [3, 4]) {
    const tg = gridTargets(n);
    assert.equal(tg.length, n * n);
    let errFit = 0, errCorners = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      const sigma = 1.2 / 480; // ~1.2 camera px of centroid noise
      const cam = tg.map(t => { const p = applyH(H_TRUE, t.x, t.y); return {x: p.x + gauss(r) * sigma, y: p.y + gauss(r) * sigma}; });
      const fit = robustHomography(tg, cam, {tol: 0.006});
      assert.ok(fit && fit.inlierCount === tg.length, 'all inliers n=' + n);
      errFit += maxCorner(quadFromH(fit.H), TRUE_QUAD);
      errCorners += maxCorner(quadFromH(fitHomography(tg.slice(0, 4), cam.slice(0, 4))), TRUE_QUAD);
    }
    assert.ok(errFit < errCorners * 0.8, `n=${n} fit ${errFit} vs corners ${errCorners}`);
    assert.ok(errFit / 30 * 480 < 3, 'mean corner error under 3 px');
  }
});

test('RANSAC + Huber rejects a misread dot and flags it in the residuals', () => {
  const tg = gridTargets(3);
  const r = rng(7);
  const cam = tg.map(t => { const p = applyH(H_TRUE, t.x, t.y); return {x: p.x + gauss(r) * 0.001, y: p.y + gauss(r) * 0.001}; });
  cam[5] = {x: cam[5].x + 0.05, y: cam[5].y - 0.03}; // a bloom pulled dot #6 ~28 px
  const plain = fitHomography(tg, cam);
  const robust = robustHomography(tg, cam, {tol: 0.006});
  assert.equal(robust.inliers[5], false);
  assert.equal(robust.inlierCount, 8);
  assert.ok(maxCorner(quadFromH(robust.H), TRUE_QUAD) * 480 < 2, 'robust stays on truth');
  assert.ok(maxCorner(quadFromH(plain), TRUE_QUAD) > maxCorner(quadFromH(robust.H), TRUE_QUAD) * 3, 'plain LS is dragged');
  const pts = pointResiduals(robust.H, tg, cam, {videoWidth: 480, videoHeight: 360, stageWidthCm: 400, inliers: robust.inliers});
  assert.equal(pts.length, 9);
  assert.equal(pts[5].inlier, false);
  assert.ok(pts[5].px > 20, 'outlier residual reported in px: ' + pts[5].px);
  assert.ok(pts[5].cm > 3, 'and in cm: ' + pts[5].cm);
  const stats = residualStats(pts);
  assert.deepEqual(stats.outliers, [5]);
  assert.ok(stats.maxPx < 2 && stats.rmsPx < 1.2, JSON.stringify(stats));
  const text = precisionSummary({kind: 'grid', grid: 3, ok: true, points: pts, stats, stageWidthCm: 400, verdict: verdictFor(stats)});
  assert.match(text, /Grid fit 3×3/);
  assert.match(text, /ignored #6/);
  assert.match(text, /#6 \d+\.\d px \/ \d+\.\d cm ✗/);
});

test('residuals: px from camera offsets, cm from the stage width and aspect', () => {
  const tg = [{x: 0.5, y: 0.5}];
  const p = applyH(H_TRUE, 0.5, 0.5);
  const pts = pointResiduals(H_TRUE, tg, [{x: p.x + 10 / 480, y: p.y}], {videoWidth: 480, videoHeight: 360, stageWidthCm: 300});
  assert.ok(Math.abs(pts[0].px - 10) < 0.01);
  assert.ok(pts[0].cm > 3 && pts[0].cm < 10, String(pts[0].cm));
  const none = pointResiduals(H_TRUE, tg, [{x: p.x + 10 / 480, y: p.y}], {videoWidth: 480, videoHeight: 360});
  assert.equal(none[0].cm, null);
  assert.match(precisionSummary({kind: 'grid', ok: true, points: none, stats: residualStats(none), stageWidthCm: null}), /set stage width for cm/);
});

test('refine uses the robust fit: same answer on clean dots, ignores one bad dot', () => {
  const tg = refineTargets();
  const truthQuad = TRUE_QUAD;
  const dots = expectedDots(truthQuad, tg);
  const ls = fitQuadLS(dots, tg);
  assert.ok(maxCorner(ls, truthQuad) < 1e-6);
  const start = truthQuad.map(p => ({x: p.x + 0.01, y: p.y - 0.008}));
  const clean = refineStep(start, dots, 480, tg);
  assert.equal(clean.ok, true);
  assert.ok(maxCorner(clean.quad, truthQuad) < 1e-6);
  assert.equal(clean.points.length, 9);
  const bad = dots.map(p => ({...p}));
  bad[8] = {x: bad[8].x + 0.03, y: bad[8].y + 0.02};
  const step = refineStep(start, bad, 480, tg);
  assert.equal(step.ok, true);
  assert.ok(maxCorner(step.quad, truthQuad) * 480 < 0.5, 'center outlier ignored');
  assert.equal(step.points[8].inlier, false);
  // 4x4 grid flows through refine too.
  const t16 = gridTargets(4);
  const d16 = expectedDots(truthQuad, t16);
  const s16 = refineStep(start, d16, 480, t16);
  assert.equal(s16.ok, true);
  assert.equal(s16.points.length, 16);
  assert.ok(maxCorner(s16.quad, truthQuad) < 1e-6);
});

test('Gray code: encode/decode round trip, one bit between neighbours', () => {
  for (let n = 0; n < 4096; n++) assert.equal(grayDecode(grayEncode(n)), n);
  for (let n = 1; n < 64; n++) {
    const x = grayEncode(n) ^ grayEncode(n - 1);
    assert.equal(x & (x - 1), 0, 'single bit flip');
  }
  assert.equal(grayBitsFor(18), 5);
  assert.equal(grayBitsFor(12), 4);
  assert.equal(grayBitsFor(16), 4);
  assert.equal(grayCellLit(5, 0, 5), !grayCellLit(5, 0, 5, true));
});

test('Gray decode with on/off differencing survives room light and a dark floor', () => {
  const bits = 5;
  for (let cell = 0; cell < 18; cell++) {
    // Ambient 90 on both captures, projector adds 40 (a gray floor in a lit room).
    const pos = [], neg = [];
    for (let b = 0; b < bits; b++) {
      pos.push(90 + (grayCellLit(cell, b, bits) ? 40 : 0));
      neg.push(90 + (grayCellLit(cell, b, bits, true) ? 40 : 0));
    }
    const d = decodeGraySamples(pos, neg);
    assert.equal(d.ok, true);
    assert.equal(d.value, cell);
  }
  const weak = decodeGraySamples([100, 101], [100, 100]);
  assert.equal(weak.ok, false, 'no contrast: refuse');
});

// Software camera for structured light: stage -> camera homography, room
// light, projector gain, sensor noise, and a 2x2 supersample per pixel.
function softCamera({H = H_TRUE, W = 240, Hh = 180, ambient = 60, gain = 150, noise = 3, seed = 3, drift = 0} = {}) {
  const Hinv = invertH(H);
  const r = rng(seed);
  let pattern = 'black';
  let frames = 0;
  const layout = structuredLayout();
  const litAt = (sx, sy) => {
    if (sx < 0 || sy < 0 || sx >= 1 || sy >= 1) return 0;
    if (pattern === 'white') return 1;
    if (!pattern || pattern === 'black') return 0;
    if (pattern.kind === 'gray') {
      const c = Math.floor((pattern.axis === 'x' ? sx : sy) * pattern.cells);
      return grayCellLit(c, pattern.bit, pattern.bits, pattern.inverse) ? 1 : 0;
    }
    if (pattern.kind === 'dots') {
      const rad = (pattern.radius || 0.014);
      for (const d of pattern.dots || layout.dots) if (Math.hypot(sx - d.x, (sy - d.y) * 390 / 844) <= rad) return 1;
      return 0;
    }
    return 0;
  };
  return {
    show(p) { pattern = p; },
    grab() {
      frames++;
      const data = new Uint8ClampedArray(W * Hh * 4);
      const g = gain * (1 + drift * Math.sin(frames));
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        let acc = 0;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const s = applyH(Hinv, (x + ox) / W, (y + oy) / Hh);
          acc += s ? litAt(s.x, s.y) : 0;
        }
        const v = ambient + g * acc / 4 + gauss(r) * noise;
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
      return {data, width: W, height: Hh, videoWidth: W, videoHeight: Hh};
    },
    get frames() { return frames; }
  };
}

test('structured light: dots + Gray code find the floor map with no prior quad', async () => {
  const cam = softCamera();
  const reports = [];
  const out = await runStructuredLight({
    show: (p) => cam.show(p), grab: () => cam.grab(), wait: async () => {}, now: () => 0, alive: () => true,
    report: (s) => reports.push(s)
  }, {scale: 0, stageWidthCm: 420, stageAspect: 844 / 390});
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.expected, 24);
  assert.ok(out.found >= 22, 'dots named: ' + out.found);
  const err = maxCorner(out.quad, TRUE_QUAD) * 240;
  assert.ok(err < 1.5, 'corner error ' + err.toFixed(2) + ' px at 240 wide');
  assert.ok(out.stats.rmsPx < 0.8, JSON.stringify(out.stats));
  assert.ok(out.points.every(p => !p.found || p.cm != null));
  assert.ok(reports.some(r => /Stripes X bit 1/.test(r.message)));
  assert.equal(reports[reports.length - 1].state, 'done');
  // 2 (black/white) + 2*(5+4) stripes + 2 (black/dots) patterns.
  assert.equal(structuredPatterns(structuredLayout()).length, 18);
});

test('structured light: bright room and a mis-named dot still fit', async () => {
  const cam = softCamera({ambient: 150, gain: 70, noise: 4, seed: 9});
  const out = await runStructuredLight({show: (p) => cam.show(p), grab: () => cam.grab(), wait: async () => {}, now: () => 0, alive: () => true}, {scale: 0});
  assert.equal(out.ok, true, out.reason);
  assert.ok(maxCorner(out.quad, TRUE_QUAD) * 240 < 2);
});

test('structured light: no projector light -> clear refusal, projector released', async () => {
  const shows = [];
  const flat = () => ({data: new Uint8ClampedArray(64 * 48 * 4).fill(40), width: 64, height: 48});
  const out = await runStructuredLight({show: (p) => shows.push(p), grab: flat, wait: async () => {}, now: () => 0, alive: () => true}, {scale: 0});
  assert.equal(out.ok, false);
  assert.match(out.reason, /dots|camera/);
  assert.equal(shows[shows.length - 1], null);
  const cancelled = await runStructuredLight({show: (p) => shows.push(p), grab: flat, wait: async () => {}, now: () => 0, alive: () => false}, {scale: 0});
  assert.equal(cancelled.reason, 'cancelled');
});

test('detectDiffBlobs: sub-pixel centroids, ignores a uniform exposure lift', () => {
  const W = 80, Hh = 60;
  const dark = new Uint8Array(W * Hh).fill(30);
  const lit = new Uint8Array(W * Hh).fill(36); // auto exposure lifted everything a bit
  const cx = 40.3, cy = 22.7;
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < 3) lit[y * W + x] = 200;
  }
  const blobs = detectDiffBlobs(dark, lit, W, Hh);
  assert.equal(blobs.length, 1);
  assert.ok(Math.abs(blobs[0].x - cx) < 0.35 && Math.abs(blobs[0].y - cy) < 0.35, JSON.stringify(blobs[0]));
  assert.equal(lumaOf({data: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1})[0], 255);
});

test('crosshair check: offsets in cm, correction pulls the map onto the stickers', () => {
  // The map in use is shifted/scaled from the truth; stickers sit where the
  // crosshairs actually landed on the floor.
  const used = TRUE_QUAD.map(p => ({x: 0.5 + (p.x - 0.5) * 1.04 + 0.012, y: 0.5 + (p.y - 0.5) * 0.98 - 0.006}));
  const Hused = hFromQuad(used);
  const Hinv = invertH(Hused);
  // Camera sees crosshair i at H_true(target); the used map reads it as stage:
  const found = CROSSHAIR_TARGETS.map(t => { const c = applyH(H_TRUE, t.x, t.y); return applyH(Hinv, c.x, c.y); });
  const stickersStagePx = found.map(f => ({x: f.x * 1000, y: f.y * 620}));
  const matched = matchStickers(CROSSHAIR_TARGETS, stickersStagePx.concat([{x: 90, y: 90}]));
  assert.ok(matched.every(Boolean));
  const before = crosshairOffsets(CROSSHAIR_TARGETS, matched, {quad: used, stageWidthCm: 400});
  const statsB = residualStats(before);
  assert.ok(statsB.maxCm > 2, 'off before: ' + statsB.maxCm);
  const fix = crosshairCorrection(used, CROSSHAIR_TARGETS, matched, fitCorrection);
  assert.ok(fix && fix.shift < 0.1);
  const after = crosshairOffsets(CROSSHAIR_TARGETS, fix.after, {quad: fix.quad, stageWidthCm: 400});
  const statsA = residualStats(after);
  assert.ok(statsA.maxCm < statsB.maxCm / 3, `after ${statsA.maxCm} vs before ${statsB.maxCm}`);
  assert.ok(maxCorner(fix.quad, TRUE_QUAD) < maxCorner(used, TRUE_QUAD) / 2);
  // A sticker far from every crosshair never matches.
  assert.deepEqual(matchStickers([{x: 0.5, y: 0.5}], [{x: 900, y: 100}]), [null]);
});

test('saved calibration, grid size, stage width and 1-point recheck', () => {
  const s = memStore();
  assert.equal(readSavedCalibration(s).last, null);
  saveCalibration(s, {quad: TRUE_QUAD, source: 'auto', rmsPx: 0.6, maxCm: 1.1, grid: 3});
  for (let k = 0; k < 7; k++) saveCalibration(s, {quad: TRUE_QUAD, source: 'grid' + k});
  const saved = readSavedCalibration(s);
  assert.equal(saved.history.length, 5);
  assert.equal(saved.last.source, 'grid6');
  assert.equal(saveCalibration(s, {quad: [1, 2]}), null);
  assert.equal(readGridSize(s), 3);
  writeGridSize(s, 4);
  assert.equal(readGridSize(s), 4);
  assert.equal(readStageWidthCm(s), null);
  assert.equal(writeStageWidthCm(s, 412.4), 412);
  assert.equal(readStageWidthCm(s), 412);
  assert.equal(writeStageWidthCm(s, 5), null);
  const c = applyH(H_TRUE, 0.5, 0.51);
  const good = recheckResult(TRUE_QUAD, {x: c.x + 0.5 / 480, y: c.y}, {stageWidthCm: 400});
  assert.equal(good.ok, true);
  assert.match(good.verdict, /still aligned/);
  const moved = recheckResult(TRUE_QUAD, {x: c.x + 12 / 480, y: c.y + 4 / 360}, {stageWidthCm: 400});
  assert.match(moved.verdict, /moved/);
  assert.match(precisionSummary(moved), /1-point recheck/);
  assert.equal(recheckResult(TRUE_QUAD, null).ok, false);
});

test('debug wiring: actions and stage width pass the sanitizer, panel text renders', async () => {
  const {sanitizeDebugPatch} = await import('../neural-dance/debug-protocol.js');
  for (const action of ['auto-align', 'xhair-show', 'xhair-measure', 'xhair-fix', 'walk-start', 'walk-next', 'precision-stop', 'recheck-align', 'align-grid', 'restore-calibration']) {
    assert.deepEqual(sanitizeDebugPatch({action}), {action});
  }
  assert.deepEqual(sanitizeDebugPatch({stageWidthCm: 99999}), {stageWidthCm: 2000});
  assert.equal(sanitizeDebugPatch({action: 'rm -rf'}), null);
  const {precisionPanelText} = await import('../neural-dance/debug-viewer.js');
  assert.match(precisionPanelText(null), /not run yet/);
  const text = precisionPanelText({text: 'Auto align (structured light): ✓ tight', grid: 4, stageWidthCm: 420, saved: {savedAt: Date.now(), source: 'auto', maxCm: 0.8}});
  assert.match(text, /Refine grid 4×4 · stage 420 cm wide · saved auto/);
});

test('live page exports the precision tools and keeps Align intact', async () => {
  const show = await import('../neural-dance/live-show.js');
  for (const name of ['autoAlignNow', 'crosshairCheckNow', 'walkCheckNow', 'recheckAlignNow', 'applyPrecisionAction', 'precisionTelemetry', 'cancelPrecision', 'beginAlign', 'cancelAlign']) {
    assert.equal(typeof show[name], 'function', name);
  }
  const t = show.precisionTelemetry();
  assert.ok(t && 'grid' in t && 'stageWidthCm' in t && t.busy === false);
  const {readFileSync} = await import('node:fs');
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  for (const a of ['auto-align', 'xhair-show', 'xhair-measure', 'xhair-fix', 'walk-start', 'walk-next', 'recheck-align', 'restore-calibration', 'align-grid']) assert.match(page, new RegExp('data-debug-action="' + a + '"'));
  assert.match(page, /<pre [^>]*data-debug-precision[ >]/);
});
