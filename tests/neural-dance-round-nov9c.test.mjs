// Nov 9 evening round: person-leave flash, full shadows, chakras, unique sims,
// projected-light latch veto, additive hue ripples, stable debug table.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  PERSON_CLEAR_MS,
  PERSON_ENTER_FRAMES,
  PERSON_EXIT_FRAMES,
  createPersonOcclusion
} from '../neural-dance/src/person-occlusion.js';
import {
  CONTINUOUS_HITS,
  createScanBook
} from '../neural-dance/src/blank-scan.js';
import {
  crowdFullHeight,
  figureHeight,
  fullFigureContour,
  isTruncatedOrBlob,
  TEMPLATE_SCALE,
  createSilhouetteShow,
  placeContour
} from '../neural-dance/src/silhouette.js';
import {dancerSilhouette, uniqueDancerSilhouette} from '../neural-dance/src/silhouette-dance.js';
import {
  CHAKRA_S,
  chakraPoints,
  drawDancerString,
  stringAxis,
  stringPoints
} from '../neural-dance/src/vibrating-string.js';
import {createWaterRipple, parseHexRgb} from '../neural-dance/src/water-ripple.js';

const cameraJs = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
const liveShow = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');

function mockCtx() {
  const paths = [];
  let path = null;
  const ctx = {
    paths,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: '',
    lineJoin: '',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() { path = {moves: [], fill: null, stroke: null, arc: null}; paths.push(path); },
    moveTo(x, y) { path.moves.push([x, y]); },
    lineTo(x, y) { path.moves.push([x, y]); },
    arc(x, y, r) { path.arc = {x, y, r}; path.moves.push('arc'); },
    closePath() {},
    fill() { path.fill = {style: ctx.fillStyle, alpha: ctx.globalAlpha}; },
    stroke() { path.stroke = {style: ctx.strokeStyle, alpha: ctx.globalAlpha, width: ctx.lineWidth}; }
  };
  return ctx;
}

function fakeRippleCanvas() {
  let field = null;
  return {
    width: 160,
    height: 100,
    get __rippleField() { return field; },
    set __rippleField(v) { field = v; },
    getContext() {
      const self = this;
      return {
        clearRect() {},
        createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}; },
        putImageData(img) {
          // Reconstruct approx colors from shade is hard; shadeToCanvas sets __rippleField.
        },
        drawImage() {},
        imageSmoothingEnabled: true,
        globalCompositeOperation: 'source-over',
        globalAlpha: 1
      };
    }
  };
}

test('after a person leaves, flashRescan fires ~1.5s later and settling stays paused', () => {
  const occ = createPersonOcclusion();
  const stickers = [{x: 100, y: 200}];
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) {
    const d = occ.observe({person: true, stickers, now: i});
    if (i === PERSON_ENTER_FRAMES - 1) assert.equal(d.paused, true);
  }
  let last = null;
  for (let i = 0; i < PERSON_EXIT_FRAMES; i++) last = occ.observe({person: false, stickers, now: 100 + i});
  assert.equal(last.settling, true);
  assert.equal(last.paused, true);
  assert.equal(last.flashRescan, false);
  const clearAt = 100 + PERSON_EXIT_FRAMES - 1;
  assert.equal(occ.observe({person: false, stickers, now: clearAt + PERSON_CLEAR_MS - 1}).flashRescan, false);
  const done = occ.observe({person: false, stickers: [{x: 400, y: 100}], now: clearAt + PERSON_CLEAR_MS});
  assert.equal(done.flashRescan, true);
  assert.equal(done.latch.length, 0);
  assert.match(liveShow, /nd-person-clear-rescan/);
  assert.match(liveShow, /takePersonFlashRequest/);
  assert.match(cameraJs, /data-ripple-layer/);
  assert.match(cameraJs, /vetoSticker\(at\.x, at\.y, Math\.max\(reach, 10\)\)/);
  assert.ok(CONTINUOUS_HITS >= 10);
});

test('elongated slash blobs are rejected in blank-scan and continuous detect', () => {
  const blank = readFileSync(new URL('../neural-dance/src/blank-scan.js', import.meta.url), 'utf8');
  assert.match(blank, /elong > 4\.2/);
  assert.match(blank, /aspect < 0\.35 \|\| aspect > 2\.6/);
  assert.match(cameraJs, /elong > 4\.2/);
  assert.match(cameraJs, /aspect < 0\.35 \|\| aspect > 2\.6/);
});

test('a truncated capture is completed to full human-shadow proportions', () => {
  const full = dancerSilhouette();
  const target = figureHeight(full) * TEMPLATE_SCALE;
  // Knee-cropped: keep only the upper ~55% of the template.
  const top = Math.min(...full.map(p => p.y));
  const bottom = Math.max(...full.map(p => p.y));
  const cut = top + (bottom - top) * 0.55;
  const truncated = full.filter(p => p.y <= cut).map(p => ({x: p.x * 0.9, y: p.y}));
  assert.equal(isTruncatedOrBlob(truncated, target), true);
  const done = fullFigureContour(truncated, 250, 300, target, 7);
  assert.ok(done && done.length >= 12);
  assert.ok(Math.abs(figureHeight(done) - target) < 1.5, 'height ' + figureHeight(done));
  // Legs reach near the template feet.
  const feet = Math.max(...done.map(p => p.y));
  const head = Math.min(...done.map(p => p.y));
  assert.ok((feet - head) / target > 0.98);
});

test('crown heart root lights ride the string and pulse with the beat', () => {
  assert.equal(CHAKRA_S.length, 7);
  assert.deepEqual(CHAKRA_S.map(c => c.id), ['root', 'sacral', 'solar', 'heart', 'throat', 'thirdEye', 'crown']);
  const body = placeContour(dancerSilhouette(), 200, 300, 2);
  const axis = stringAxis(body);
  const pts = stringPoints(axis, {band: 1, now: 0, amplitude: 10, mode: 2, freq: 1});
  const quiet = chakraPoints(pts, {envelope: 0, level: 0});
  const loud = chakraPoints(pts, {envelope: 1, level: 1});
  assert.equal(quiet.length, 7);
  assert.ok(loud[0].radius > quiet[0].radius);
  // Lights sit on the displaced string (same x as sampled wave).
  for (const light of loud) {
    const near = pts.reduce((best, p) => Math.abs(p.s - light.s) < Math.abs(best.s - light.s) ? p : best, pts[0]);
    assert.ok(Math.abs(light.x - near.x) < 2);
  }
  const ctx = mockCtx();
  assert.equal(drawDancerString(ctx, body, {band: 0, now: 100, envelope: 1, samples: new Float32Array(32).fill(0.2)}), true);
  assert.ok(ctx.paths.some(p => p.arc), 'chakra arcs painted');
});

test('each sim dancer gets a unique seeded silhouette of the same size', () => {
  const a = uniqueDancerSilhouette(1);
  const b = uniqueDancerSilhouette(2);
  const a2 = uniqueDancerSilhouette(1);
  const base = dancerSilhouette();
  const dist = (p, q) => p.reduce((s, pt, i) => s + Math.hypot(pt.x - q[i].x, pt.y - q[i].y), 0);
  assert.ok(dist(a, a2) < 1e-9);
  assert.ok(dist(a, b) > 8, 'different ids differ');
  assert.ok(Math.abs(figureHeight(a) - figureHeight(base)) < 12, 'similar height');
  assert.ok(Math.abs(figureHeight(b) - figureHeight(base)) < 12);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = mockCtx();
  show.paint(ctx, [
    {id: 1, x: 200, y: 300, type: 0, kind: 'sim'},
    {id: 2, x: 500, y: 300, type: 1, kind: 'sim'}
  ], {now: 0, paintDots() {}});
  assert.ok(ctx.paths.filter(p => p.fill && p.moves.length > 8).length >= 2);
});

test('ripple impulses carry dancer hue and mix additively toward white', () => {
  const ripple = createWaterRipple({width: 48, height: 32});
  const canvas = fakeRippleCanvas();
  ripple.hit(0.4, 0.5, 1.2, parseHexRgb('#ff0000'));
  ripple.hit(0.42, 0.5, 1.2, parseHexRgb('#00ff00'));
  ripple.step(canvas);
  const field = canvas.__rippleField;
  assert.ok(field && field.colors);
  let maxR = 0;
  let maxG = 0;
  let both = 0;
  for (let i = 0; i < field.colors.r.length; i++) {
    maxR = Math.max(maxR, field.colors.r[i]);
    maxG = Math.max(maxG, field.colors.g[i]);
    if (field.colors.r[i] > 0.05 && field.colors.g[i] > 0.05) both++;
  }
  assert.ok(maxR > 0.2 && maxG > 0.2, 'both hues deposited');
  assert.ok(both > 0, 'overlap cells carry both channels (→ yellow)');
  // Soft knee keeps values finite.
  assert.ok(maxR < 20 && maxG < 20);
});

test('debug Room actions sit above a fixed-height scrolling detected table', () => {
  const actionsAt = debugPage.indexOf('<h2>Room actions</h2>');
  const telemAt = debugPage.indexOf('<h2>Telemetry</h2>');
  assert.ok(actionsAt > 0 && telemAt > actionsAt, 'Room actions before Telemetry');
  assert.match(debugPage, /data-debug-table-wrap/);
  assert.match(debugPage, /max-height:220px/);
  assert.match(debugPage, /overflow:auto/);
});

test('Scan stickers blanks the projector including sims and ripples', () => {
  assert.match(liveShow, /ndScanFlash/);
  assert.match(liveShow, /ndStickerScan/);
  // Hotfix: never clearSim — white cover hides sims; they stay seeded.
  assert.doesNotMatch(liveShow, /nd\.clearSim\(\)/);
  assert.match(liveShow, /setAlignFlash\(doc, 'white'\)/);
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /layer!=='simulation'/);
});

test('lit-room refine uses softer temporal peak and reports px', () => {
  const refine = readFileSync(new URL('../neural-dance/src/align-refine.js', import.meta.url), 'utf8');
  assert.match(refine, /REFINE_PEAK_MIN/);
  assert.match(refine, /ambientHot/);
  assert.match(refine, /convergePx/);
  assert.match(liveShow, /refineAfterAlign\(doc, cam, choice\.corners, alive, settleMs, ambientHot\)/);
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(debug, /data-debug-refine/);
  assert.match(debug, /data-debug-ok-hand/);
});

test('chakras take per-dancer or rainbow hueAt along the string', () => {
  const body = placeContour(dancerSilhouette(), 200, 300, 2);
  const axis = stringAxis(body);
  const pts = stringPoints(axis, {band: 1, now: 0, amplitude: 10, mode: 2, freq: 1});
  const rainbow = chakraPoints(pts, {envelope: 1, level: 1});
  assert.ok(rainbow.every(l => /^hsl\(/.test(l.color)), 'default chakras use hueAt');
  // Tint is subtle — colors stay distinct and ordered, not replaced.
  const tinted = chakraPoints(pts, {envelope: 1, level: 1, hue: '#ff88aa'});
  assert.ok(tinted.every(l => /^hsl\(/.test(l.color)));
  assert.notEqual(tinted[0].color, tinted[2].color);
});
