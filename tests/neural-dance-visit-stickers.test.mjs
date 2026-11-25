// Visit scan, painting-diff stickers, rolling baseline, and the white hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CHANGE_STICKER, dancerTemplateGrid, detectChangedStickers, keepStableStickers, mergeNewStickers, pixelChanged} from '../neural-dance/src/painting-diff.js';
import {createVisitScan, sceneClose, sceneSignature, VISIT_CLEAR_MS, VISIT_COOLDOWN_MS} from '../neural-dance/src/visit-scan.js';
import {paintWhiteFade} from '../neural-dance/live-show.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {clampQuadToFrame} from '../neural-dance/camera-markers.js';
import {FLASH_FADE_MS, runStickerFlash} from '../neural-dance/src/sticker-flash.js';
import {cacheControlFor} from '../worker/index.mjs';

const QUAD = [{x: 20, y: 16}, {x: 140, y: 16}, {x: 140, y: 100}, {x: 20, y: 100}];

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = fill(i % w, (i / w) | 0);
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return data;
}
function blob(data, w, x, y, bw, bh, rgb) {
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    const i = (yy * w + xx) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
  }
}
const DANCER = dancerTemplateGrid(0);
function stamp(data, w, x, y, rgb) {
  for (let ty = 0; ty < 16; ty++) for (let tx = 0; tx < 16; tx++) {
    if (!DANCER[ty * 16 + tx]) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const xx = x + tx * 2 + dx, yy = y + ty * 2 + dy;
      const i = (yy * w + xx) * 4;
      if (i < 0 || i + 2 >= data.length) continue;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
    }
  }
}
function sunset(w, h) {
  return paint(w, h, (x, y) => {
    if (y < 40) return [220, 120, 48];
    if ((x + y) % 17 === 0) return [245, 210, 140];
    return [150, 48, 32];
  });
}
function rgbOf(rgba) {
  const out = new Uint8Array(rgba.length / 4 * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
  }
  return out;
}
function mem() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('a changed colored sticker counts; an unchanged bright stroke does not', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const ref = rgbOf(bare);
  const gold = new Uint8ClampedArray(bare);
  const pink = new Uint8ClampedArray(bare);
  const blue = new Uint8ClampedArray(bare);
  const white = new Uint8ClampedArray(bare);
  stamp(gold, w, 48, 40, [212, 175, 55]);
  stamp(pink, w, 48, 40, [230, 80, 140]);
  stamp(blue, w, 48, 40, [40, 90, 210]);
  stamp(white, w, 48, 40, [250, 250, 248]);
  for (const frame of [gold, pink, blue, white]) {
    const found = detectChangedStickers(frame, w, h, {quad: QUAD, reference: ref});
    assert.equal(found.ok, true);
    assert.equal(found.stickers.length, 1);
    assert.ok(found.stickers[0].x > 45 && found.stickers[0].x < 100);
  }
  const same = detectChangedStickers(bare, w, h, {quad: QUAD, reference: ref});
  assert.equal(same.stickers.length, 0);
  assert.equal(pixelChanged(245, 210, 140, 245, 210, 140), false);
  assert.equal(pixelChanged(212, 175, 55, 150, 48, 32), true);
  assert.ok(CHANGE_STICKER.colorDelta >= 20 && CHANGE_STICKER.lumDelta >= 12);
});

function shiftGain(src, w, h, dx, dy, gain) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.max(0, Math.min(w - 1, x - dx));
    const sy = Math.max(0, Math.min(h - 1, y - dy));
    const s = (sy * w + sx) * 4, d = (y * w + x) * 4;
    out[d] = Math.min(255, src[s] * gain);
    out[d + 1] = Math.min(255, src[s + 1] * gain * 0.97);
    out[d + 2] = Math.min(255, src[s + 2] * gain * 1.04);
    out[d + 3] = 255;
  }
  return out;
}

test('the same painting under a new exposure and a 2 px shift is not a sticker; one added sticker is', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const again = shiftGain(bare, w, h, 2, 1, 1.12);
  const same = detectChangedStickers(again, w, h, {quad: QUAD, reference: rgbOf(bare)});
  assert.equal(same.stickers.length, 0);
  const added = new Uint8ClampedArray(again);
  stamp(added, w, 56, 40, [30, 70, 220]);
  const found = detectChangedStickers(added, w, h, {quad: QUAD, reference: rgbOf(bare)});
  assert.equal(found.stickers.length, 1);
});

test('stickers outside the frame polygon are ignored, and a large region is not a sticker', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const ref = rgbOf(bare);
  const outside = new Uint8ClampedArray(bare);
  blob(outside, w, 4, 50, 10, 14, [250, 250, 250]);
  const out = detectChangedStickers(outside, w, h, {quad: QUAD, reference: ref});
  assert.equal(out.stickers.length, 0);
  const person = new Uint8ClampedArray(bare);
  blob(person, w, 40, 30, 70, 60, [40, 36, 34]);
  const body = detectChangedStickers(person, w, h, {quad: QUAD, reference: ref});
  assert.equal(body.stickers.length, 0);
  assert.ok(body.rejected.size > 0);
});

test('a sticker has to hold still across frames, and two hits on the same spot are one', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const ref = rgbOf(bare);
  const moved = new Uint8ClampedArray(bare);
  const held = new Uint8ClampedArray(bare);
  stamp(moved, w, 36, 36, [230, 80, 140]);
  stamp(held, w, 70, 48, [212, 175, 55]);
  const a = detectChangedStickers(moved, w, h, {quad: QUAD, reference: ref}).stickers;
  const b = detectChangedStickers(held, w, h, {quad: QUAD, reference: ref}).stickers;
  const stable = keepStableStickers([a, b, b], {need: 2, radius: 12});
  assert.equal(stable.length, 1);
  assert.ok(stable[0].x > 60);
  const twin = new Uint8ClampedArray(bare);
  stamp(twin, w, 48, 40, [250, 250, 250]);
  stamp(twin, w, 48, 40, [250, 250, 250]);
  const duped = detectChangedStickers(twin, w, h, {quad: QUAD, reference: ref});
  assert.equal(duped.stickers.length, 1);
});

test('a second scan finds only the new sticker, including one overlapping an older one', () => {
  const w = 160, h = 120;
  const barePx = sunset(w, h);
  const withA = new Uint8ClampedArray(barePx);
  stamp(withA, w, 40, 40, [212, 175, 55]);
  const overlap = new Uint8ClampedArray(withA);
  stamp(overlap, w, 56, 38, [40, 90, 210]);
  const quad = QUAD.map(p => ({x: p.x / w, y: p.y / h}));
  const store = mem();
  const session = createPaintingSession({storage: store});
  assert.equal(session.accept(quad), true);
  assert.equal(session.frameLocked(), true);
  const bare = {data: barePx, width: w, height: h};
  assert.equal(session.learnReference([bare], 1000), true);
  assert.equal(session.baselineReady(), false);
  const first = session.scan({data: withA, width: w, height: h});
  assert.equal(first.stickers.length, 1);
  assert.equal(session.commitScan({data: withA, width: w, height: h}, 2000), true);
  const second = session.scan({data: overlap, width: w, height: h});
  assert.equal(second.stickers.length, 1, 'the overlapping sticker is the only new one');
  assert.ok(second.stickers[0].x > first.stickers[0].x);
  assert.equal(session.commitScan({data: overlap, width: w, height: h}, 3000), true);
  const third = session.scan({data: overlap, width: w, height: h});
  assert.equal(third.stickers.length, 0, 'the same scan again adds nothing');
  const reloaded = createPaintingSession({storage: store});
  assert.equal(reloaded.referenceReady(), true);
  assert.equal(reloaded.baselineReady(), true);
  assert.equal(reloaded.scan({data: overlap, width: w, height: h}).stickers.length, 0);
  assert.equal(reloaded.learnReference([bare], 4000), true);
  assert.equal(reloaded.baselineReady(), false);
  assert.equal(reloaded.scan({data: withA, width: w, height: h}).stickers.length, 1);
  const kept = mergeNewStickers([{x: 100, y: 80}], [{x: 101, y: 80}, {x: 140, y: 80}], 6);
  assert.equal(kept.fresh.length, 1);
  assert.equal(kept.all.length, 2);
});

test('a visit scans once after the frame has been clear, and never while someone is there', () => {
  assert.ok(VISIT_CLEAR_MS >= 1000 && VISIT_CLEAR_MS <= 2000);
  const visit = createVisitScan();
  assert.equal(visit.observe({present: false, now: 0, learned: true}).scan, false);
  assert.equal(visit.observe({present: true, now: 100, learned: true}).label, 'Person in frame');
  assert.equal(visit.observe({present: true, now: 5000, learned: true}).scan, false);
  const early = visit.observe({present: false, now: 5100, learned: true});
  assert.equal(early.scan, false);
  assert.equal(early.label, 'Clear');
  const back = visit.observe({present: true, now: 5200, learned: true});
  assert.equal(back.scan, false);
  visit.observe({present: false, now: 5300, learned: true});
  const ready = visit.observe({present: false, now: 5300 + VISIT_CLEAR_MS, learned: true});
  assert.equal(ready.scan, true);
  assert.equal(ready.label, 'Scanning');
  assert.equal(visit.observe({present: false, now: 9000, learned: true, scanning: true}).label, 'Scanning');
  assert.equal(visit.noteResult(2), '2 new stickers');
  assert.equal(visit.observe({present: false, now: 9100, learned: true}).label, '2 new stickers');
  assert.equal(visit.observe({present: false, now: 9100, learned: false}).label, 'Clear');
});

test('saved frame corners stay inside the camera and round-trip', () => {
  const outside = [{x: -0.2, y: 0.1}, {x: 1.4, y: 0.12}, {x: 1.2, y: 0.9}, {x: 0.05, y: 1.3}];
  const clamped = clampQuadToFrame(outside);
  assert.ok(clamped.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
  assert.equal(clamped[0].x, 0);
  assert.equal(clamped[1].x, 1);
  const store = mem();
  const session = createPaintingSession({storage: store});
  assert.equal(session.lockFrame(outside), true);
  assert.equal(session.frameQuad()[1].x, 1);
  const again = createPaintingSession({storage: store});
  assert.equal(again.frameLocked(), true);
  assert.equal(again.frameQuad()[0].x, 0);
  assert.equal(again.frameQuad()[3].y, 1);
});

test('capture runs only at full white, after the fade and the hold', async () => {
  const clock = {t: 0};
  const shown = [];
  let scannedAt = null;
  const out = await runStickerFlash({
    minMs: 1000,
    maxMs: 1600,
    show: (alpha) => shown.push(+alpha),
    wait: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    grab: () => ({data: new Uint8ClampedArray(16).fill(240), width: 2, height: 2}),
    personInView: () => false,
    scan: () => {
      scannedAt = clock.t;
      assert.equal(shown[shown.length - 1], 0, 'white is down before the diff');
      assert.ok(shown.includes(1));
      return {ok: true, count: 1};
    },
    report: () => {}
  });
  assert.equal(out.state, 'done');
  assert.equal(shown[0], 0);
  assert.equal(shown[shown.length - 1], 0);
  assert.ok(shown.includes(1));
  assert.ok(scannedAt >= FLASH_FADE_MS + 1000, 'captured at ' + scannedAt);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const relearn = show.slice(show.indexOf('function relearnBarePaintingNow'), show.indexOf('function commitHomes'));
  assert.ok(relearn.indexOf('coverStageWhite(doc, true') < relearn.indexOf('await'));
  assert.ok(relearn.indexOf('holdWhiteCapture') < relearn.indexOf('cam.learnPaintingReference([frame]'));
  const scan = show.slice(show.indexOf('function scanStickersNow'), show.indexOf('export async function calibrateStickersNow'));
  assert.ok(scan.indexOf('holdWhiteCapture') < scan.indexOf('cam.scanWhiteFrame(frame'));
  const hold = show.slice(show.indexOf('async function holdWhiteCapture'), show.indexOf('function learnedClock'));
  assert.match(hold, /runStickerFlash/);
  assert.match(hold, /minMs: BARE_HOLD_MIN_MS/);
});

test('debug and live pages show the build, and html and js are not cached', () => {
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.match(debug, /data-debug-build-server/);
  assert.match(debug, /data-debug-visit/);
  assert.match(readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8'), /person /);
  assert.match(readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8'), /visitCoveragePresent/);
  assert.match(readFileSync(new URL('../neural-dance/src/visit-scan.js', import.meta.url), 'utf8'), /VISIT_COVERAGE_ON = 0\.055/);
  assert.match(debug, /data-nd-build|data-debug-build-local/);
  assert.match(live, /<span data-nd-build title="Build">/);
  assert.match(cacheControlFor('/neural-dance/live/', 'text/html'), /no-store/);
  assert.match(cacheControlFor('/neural-dance/debug/', ''), /no-store/);
  assert.match(cacheControlFor('/neural-dance/camera-markers.js', 'text/javascript'), /no-store/);
  assert.equal(cacheControlFor('/fonts/fonts.css', 'text/css'), '');
  const wrangler = readFileSync(new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  assert.match(wrangler, /\/neural-dance\/live/);
  assert.match(wrangler, /\/neural-dance\/\*\.js/);
});

test('one visit produces one capture; the white fade does not start another', () => {
  assert.ok(VISIT_COOLDOWN_MS >= 2500 && VISIT_COOLDOWN_MS <= 4000);
  const visit = createVisitScan();
  const caps = [];
  const tick = (present, now, extra = {}) => {
    const step = visit.observe({present, now, learned: true, sceneMatch: true, ...extra});
    if (step.scan) caps.push(now);
    return step;
  };
  tick(true, 0);
  tick(false, 100);
  assert.equal(tick(false, 100 + VISIT_CLEAR_MS).scan, true);
  assert.deepEqual(caps, [100 + VISIT_CLEAR_MS]);
  // The capture and its fade look like a person, then the show returns.
  assert.equal(tick(true, 2000, {scanning: true, sceneMatch: false}).scan, false);
  visit.noteResult(1);
  visit.quiet(2200, VISIT_COOLDOWN_MS);
  assert.equal(tick(true, 2500, {sceneMatch: false}).scan, false);
  assert.equal(tick(false, 4000, {sceneMatch: false}).scan, false);
  assert.equal(tick(false, 2200 + VISIT_COOLDOWN_MS + 100, {sceneMatch: false}).scan, false);
  // Settled on the post-scan picture. That re-arms the detector; it does not scan.
  const settled = 2200 + VISIT_COOLDOWN_MS + 100;
  assert.equal(tick(false, settled, {sceneMatch: true}).scan, false);
  assert.equal(tick(false, settled + VISIT_CLEAR_MS, {sceneMatch: true}).scan, false);
  tick(true, settled + VISIT_CLEAR_MS + 100, {sceneMatch: true});
  tick(false, settled + VISIT_CLEAR_MS + 200, {sceneMatch: true});
  assert.equal(tick(false, settled + VISIT_CLEAR_MS + 200 + VISIT_CLEAR_MS, {sceneMatch: true}).scan, true);
  assert.equal(caps.length, 2);
  const show = sceneSignature({data: new Uint8ClampedArray(16).fill(40), width: 2, height: 2});
  const same = sceneSignature({data: new Uint8ClampedArray(16).fill(40), width: 2, height: 2});
  const moved = sceneSignature({data: new Uint8ClampedArray(16).fill(200), width: 2, height: 2});
  assert.equal(sceneClose(show, same), true);
  assert.equal(sceneClose(show, moved), false);
});

test('the live projector fades the white overlay and fills the canvas only at full white', () => {
  const dataset = {};
  const flash = {hidden: true, dataset: {}, style: {opacity: ''}};
  const veil = {hidden: true, style: {opacity: ''}, setAttribute() {}, remove() {}};
  const room = {dataset, neuralDance: {redraw() {}}};
  const cls = new Set();
  const doc = {
    body: {classList: {contains: (n) => cls.has(n), add: (n) => cls.add(n), remove: (n) => cls.delete(n)}, appendChild() {}},
    getElementById(id) { return id === 'nd-room-lab' ? room : null; },
    querySelector(sel) {
      if (sel === '[data-align-flash]') return flash;
      if (sel === '[data-bare-white]') return veil;
      if (sel === '[data-align-cancel-zone]') return {hidden: false};
      return null;
    },
    createElement() { return veil; }
  };
  paintWhiteFade(doc, 0.4);
  assert.equal(flash.style.opacity, '0.4');
  assert.equal(veil.style.opacity, '0.4');
  assert.equal(dataset.ndAlignFlash, undefined);
  assert.equal(dataset.ndAlignFlashAlpha, '0.4');
  assert.equal(dataset.ndStickerScan, '1');
  paintWhiteFade(doc, 1);
  assert.equal(flash.style.opacity, '1');
  assert.equal(dataset.ndAlignFlash, 'white');
  assert.equal(dataset.ndAlignFlashAlpha, undefined);
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.match(page, /data-align-flash/);
  assert.match(page, /\[data-align-flash\]\[data-mode="white"\]\{background:#fff\}/);
});
