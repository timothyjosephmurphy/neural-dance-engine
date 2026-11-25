// Lighting-tolerant sticker scan: sun bloom and gradients are not stickers,
// a crisp dancer silhouette is, and a visit does not stack while the show moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dancerTemplateGrid, detectChangedStickers, unpackThumb} from '../neural-dance/src/painting-diff.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {createVisitScan, VISIT_CLEAR_MS, VISIT_COOLDOWN_MS, VISIT_COVERAGE_ON} from '../neural-dance/src/visit-scan.js';
import {manualWhiteBalanceMode} from '../neural-dance/camera-markers.js';
import {packPaintingTelemetry} from '../neural-dance/live-debug.js';
import {formatScanBlob, formatScanMeta, paintLastScan} from '../neural-dance/debug-viewer.js';

const QUAD = [{x: 20, y: 16}, {x: 140, y: 16}, {x: 140, y: 100}, {x: 20, y: 100}];

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = fill(i % w, (i / w) | 0);
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return data;
}
function put(data, w, x, y, rgb) {
  if (x < 0 || y < 0) return;
  const i = (y * w + x) * 4;
  if (i < 0 || i + 2 >= data.length) return;
  data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
}
function blob(data, w, x, y, bw, bh, rgb) {
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) put(data, w, xx, yy, rgb);
}
function sunset(w, h) {
  return paint(w, h, (x, y) => {
    if (y < 40) return [220, 120, 48];
    if ((x + y) % 17 === 0) return [245, 210, 140];
    return [150, 48, 32];
  });
}
function sunScene(w, h, bloom) {
  return paint(w, h, (x, y) => {
    const d = Math.hypot(x - 104, y - 22);
    const core = bloom ? 12 : 7;
    const halo = bloom ? 26 : 14;
    if (d <= core) return bloom ? [255, 255, 250] : [255, 250, 232];
    if (d <= halo) {
      const t = (d - core) / Math.max(1, halo - core);
      if (bloom) return [255, Math.round(252 - 40 * t * t), Math.round(240 - 170 * Math.pow(t, 0.4))];
      return [255, Math.round(228 - 80 * t), Math.round(150 - 90 * t)];
    }
    if (y < 44) return [214, 118, 46];
    if ((x * 3 + y * 5) % 19 === 0) return [236, 198, 116];
    return [146, 44, 28];
  });
}
function ramp(src, w, h) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const add = 78 * (x / Math.max(1, w - 1));
    const s = (y * w + x) * 4;
    out[s] = Math.min(255, src[s] + add);
    out[s + 1] = Math.min(255, src[s + 1] + add * 0.62);
    out[s + 2] = Math.min(255, src[s + 2] + add * 0.22);
    out[s + 3] = 255;
  }
  return out;
}
const DANCER = dancerTemplateGrid(0);
function dancer(data, w, x, y, rgb) {
  for (let ty = 0; ty < 16; ty++) for (let tx = 0; tx < 16; tx++) {
    if (!DANCER[ty * 16 + tx]) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(data, w, x + tx * 2 + dx, y + ty * 2 + dy, rgb);
  }
}
function disk(data, w, cx, cy, rx, ry, rgb) {
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    if ((x - cx) ** 2 / (rx * rx) + (y - cy) ** 2 / (ry * ry) <= 1) put(data, w, x, y, rgb);
  }
}
function softBlob(data, w, h, cx, cy, sigma, rgb) {
  const rad = Math.ceil(sigma * 3);
  for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const a = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
    const i = (y * w + x) * 4;
    data[i] = data[i] * (1 - a) + rgb[0] * a;
    data[i + 1] = data[i + 1] * (1 - a) + rgb[1] * a;
    data[i + 2] = data[i + 2] * (1 - a) + rgb[2] * a;
  }
}
function ring(data, w, cx, cy, r0, r1, rgb) {
  for (let y = cy - r1 - 1; y <= cy + r1 + 1; y++) for (let x = cx - r1 - 1; x <= cx + r1 + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= r0 && d <= r1) put(data, w, x, y, rgb);
  }
}
function rgbOf(rgba) {
  const out = new Uint8Array(rgba.length / 4 * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
  }
  return out;
}
function detail(found) {
  return JSON.stringify({rejected: found.rejected, blobs: found.view && found.view.blobs});
}
function mem() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('a clipped blooming sun and a smooth light gradient are not stickers', () => {
  const w = 160, h = 120;
  const bare = sunScene(w, h, false);
  const bloom = sunScene(w, h, true);
  const sun = detectChangedStickers(bloom, w, h, {quad: QUAD, reference: rgbOf(bare)});
  assert.equal(sun.stickers.length, 0, detail(sun));
  const graded = detectChangedStickers(ramp(sunset(w, h), w, h), w, h, {quad: QUAD, reference: rgbOf(sunset(w, h))});
  assert.equal(graded.stickers.length, 0, detail(graded));
});

test('a crisp dancer sticker of any color is one sticker on that same scene', () => {
  const w = 160, h = 120;
  const bare = sunScene(w, h, false);
  const ref = rgbOf(bare);
  const colors = [[250, 250, 248], [212, 175, 55], [198, 198, 204], [230, 80, 140], [40, 90, 210]];
  for (const rgb of colors) {
    const frame = sunScene(w, h, true);
    dancer(frame, w, 44, 48, rgb);
    const found = detectChangedStickers(frame, w, h, {quad: QUAD, reference: ref});
    assert.equal(found.stickers.length, 1, rgb.join(',') + ' ' + detail(found));
  }
  const graded = ramp(sunset(w, h), w, h);
  dancer(graded, w, 44, 48, [40, 90, 210]);
  const onRamp = detectChangedStickers(graded, w, h, {quad: QUAD, reference: rgbOf(sunset(w, h))});
  assert.equal(onRamp.stickers.length, 1, detail(onRamp));
  const hit = onRamp.view.blobs.find(b => b.reason === 'accept');
  assert.ok(hit.templateIoU >= 0.32 && hit.solidity <= 0.85 && hit.circularity <= 0.8 && hit.holeFrac <= 0.2);
  assert.ok(hit.aspect >= 0.2 && hit.aspect <= 1.8);
});

test('a rendered dancer template passes; a circle, oval, hollow ring, and streak do not', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const ref = rgbOf(bare);
  const figure = new Uint8ClampedArray(bare);
  dancer(figure, w, 48, 40, [230, 80, 140]);
  const yes = detectChangedStickers(figure, w, h, {quad: QUAD, reference: ref});
  assert.equal(yes.stickers.length, 1, detail(yes));
  const shapes = [
    ['circle', (frame) => disk(frame, w, 80, 60, 11, 11, [250, 250, 248])],
    ['oval', (frame) => disk(frame, w, 80, 60, 14, 18, [250, 250, 248])],
    ['ring', (frame) => ring(frame, w, 80, 60, 5, 9, [255, 246, 220])],
    ['streak', (frame) => blob(frame, w, 36, 64, 48, 3, [250, 250, 248])]
  ];
  for (const [name, draw] of shapes) {
    const frame = new Uint8ClampedArray(bare);
    draw(frame);
    const found = detectChangedStickers(frame, w, h, {quad: QUAD, reference: ref});
    assert.equal(found.stickers.length, 0, name + ' ' + detail(found));
  }
  const ringFrame = new Uint8ClampedArray(bare);
  ring(ringFrame, w, 80, 60, 5, 9, [255, 246, 220]);
  const ringFound = detectChangedStickers(ringFrame, w, h, {quad: QUAD, reference: ref});
  assert.ok((ringFound.view.blobs || []).some(b => b.reason === 'hollow' && b.holeFrac > 0.2), detail(ringFound));
});

test('a soft blob and a hollow bloom ring are rejected for edge or shape', () => {
  const w = 160, h = 120;
  const bare = sunset(w, h);
  const ref = rgbOf(bare);
  const soft = new Uint8ClampedArray(bare);
  softBlob(soft, w, h, 78, 68, 9, [250, 248, 240]);
  const softFound = detectChangedStickers(soft, w, h, {quad: QUAD, reference: ref});
  assert.equal(softFound.stickers.length, 0, detail(softFound));
  const softN = (softFound.rejected['soft-lighting'] || 0) + (softFound.rejected.shape || 0) + (softFound.rejected.hollow || 0);
  assert.ok(softN > 0, detail(softFound));
  const hollow = new Uint8ClampedArray(bare);
  ring(hollow, w, 80, 68, 6, 9, [255, 246, 220]);
  const ringFound = detectChangedStickers(hollow, w, h, {quad: QUAD, reference: ref});
  assert.equal(ringFound.stickers.length, 0, detail(ringFound));
  const ringN = (ringFound.rejected.hollow || 0) + (ringFound.rejected.shape || 0) + (ringFound.rejected['soft-lighting'] || 0);
  assert.ok(ringN > 0, detail(ringFound));
  const reasons = (ringFound.view.blobs || []).map(b => b.reason);
  assert.ok(reasons.every(r => r === 'hollow' || r === 'shape' || r === 'soft-lighting' || r === 'size' || r === 'highlight' || r === 'outside'), reasons.join(','));
});

test('show animation after a scan does not re-arm and stack scans', () => {
  const visit = createVisitScan();
  const caps = [];
  const tick = (present, now, sceneMatch) => {
    const step = visit.observe({present, now, learned: true, sceneMatch});
    if (step.scan) caps.push(now);
    return step;
  };
  tick(true, 0, true);
  tick(false, 100, true);
  assert.equal(tick(false, 100 + VISIT_CLEAR_MS, true).scan, true);
  visit.noteResult(1);
  visit.quiet(2000, VISIT_COOLDOWN_MS);
  const t0 = 2000 + VISIT_COOLDOWN_MS + 80;
  // The show changes the picture and is not a person. A real visitor
  // (present, even when the picture no longer matches) is allowed to arm.
  for (let i = 0; i < 8; i++) tick(false, t0 + i * 700, false);
  assert.deepEqual(caps, [100 + VISIT_CLEAR_MS]);
  const settled = t0 + 8 * 700;
  tick(false, settled, true);
  tick(false, settled + VISIT_CLEAR_MS, true);
  tick(true, settled + VISIT_CLEAR_MS + 50, true);
  tick(false, settled + VISIT_CLEAR_MS + 80, true);
  assert.equal(tick(false, settled + VISIT_CLEAR_MS + 80 + VISIT_CLEAR_MS, true).scan, true);
  assert.equal(caps.length, 2);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const obs = show.slice(show.indexOf('visitCoveragePresent'), show.indexOf('setVisitState'));
  assert.match(obs, /sceneMatchesVisit/);
  assert.equal(/sceneMatch:\s*true/.test(obs), false);
  assert.match(obs, /visitCoveragePresent/);
  assert.equal(VISIT_COVERAGE_ON, 0.055);
});

test('manual white balance locks only when the track allows it', () => {
  assert.equal(manualWhiteBalanceMode({whiteBalanceMode: ['continuous', 'manual']}), 'manual');
  assert.equal(manualWhiteBalanceMode({whiteBalanceMode: ['continuous']}), null);
  assert.equal(manualWhiteBalanceMode(null), null);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const relearn = show.slice(show.indexOf('function relearnBarePaintingNow'), show.indexOf('function commitHomes'));
  const hook = relearn.slice(relearn.indexOf('beforeFadeOut'), relearn.indexOf('grab:'));
  assert.match(hook, /lockWhiteBalance/);
  assert.doesNotMatch(hook, /learnPaintingReference/);
  const scanCb = relearn.slice(relearn.indexOf('async (frame)'), relearn.indexOf('beforeFadeOut'));
  assert.match(scanCb, /learnPaintingReference/);
  assert.doesNotMatch(scanCb, /lockWhiteBalance/);
});

test('lastScan diagnostics populate and survive a cleared sticker list', () => {
  const w = 160, h = 120;
  const barePx = sunScene(w, h, false);
  const withDancer = sunScene(w, h, true);
  dancer(withDancer, w, 42, 62, [230, 80, 140]);
  const quad = QUAD.map(p => ({x: p.x / w, y: p.y / h}));
  const session = createPaintingSession({storage: mem()});
  assert.equal(session.accept(quad), true);
  assert.equal(session.learnReference([{data: barePx, width: w, height: h}], 1000), true);
  const learned = session.telemetry().lastScan;
  assert.equal(learned.kind, 'relearn');
  assert.equal(learned.compare, false);
  assert.equal(learned.before || '', '');
  assert.match(formatScanMeta(learned), /no earlier picture/);
  const scan = session.scan({data: withDancer, width: w, height: h});
  assert.equal(scan.stickers.length, 1, JSON.stringify(scan.rejected));
  session.noteScanMeta({settleMs: 1120, wb: {locked: true, mode: 'manual'}, kind: 'scan'});
  const last = session.telemetry().lastScan;
  assert.equal(last.kind, 'scan');
  assert.equal(last.settleMs, 1120);
  assert.equal(last.wb.locked, true);
  assert.equal(last.wb.mode, 'manual');
  assert.equal(last.gains.length, 3);
  const before = unpackThumb(last.before);
  const after = unpackThumb(last.after);
  const diff = unpackThumb(last.diff);
  assert.ok(before && after && diff);
  assert.ok(before.w >= 96 && before.w <= 136, 'thumb width ' + before.w);
  assert.equal(before.w, after.w);
  assert.ok(last.blobs.some(b => b.reason === 'accept' && b.area > 0 && Number.isFinite(+b.peakL) && Number.isFinite(+b.crisp)));
  let changed = 0;
  for (let i = 0; i < before.rgb.length; i += 30) if (Math.abs(before.rgb[i] - after.rgb[i]) > 12) changed++;
  assert.ok(changed > 4, 'before and after thumbnails differ');
  session.observe({data: barePx, width: w, height: h}, {blocked: true});
  assert.equal(session.telemetry().latched.length, 0);
  assert.equal(session.telemetry().lastScan.at, last.at);
  assert.equal(session.telemetry().lastScan.diff, last.diff);
  const packed = packPaintingTelemetry(session.telemetry());
  assert.equal(packed.lastScan.before, undefined);
  assert.equal(packed.lastScan.images.before, true);
  assert.equal(packed.lastScan.images.diff, true);
  assert.equal(packed.latched.length, 0);
  assert.ok(JSON.stringify(packed).length < 100000);
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(page, /data-debug-last-scan/);
  assert.match(page, /data-debug-still-before/);
  assert.match(page, /data-debug-still-diff/);
  const held = {meta: 'Last scan: none yet', blobs: ''};
  const doc = {
    querySelector(sel) {
      if (sel === '[data-debug-still-meta]') return {set textContent(v) { held.meta = v; }, get textContent() { return held.meta; }};
      if (sel === '[data-debug-still-blobs]') return {set textContent(v) { held.blobs = v; }, get textContent() { return held.blobs; }};
      if (sel === '[data-debug-still-before]' || sel === '[data-debug-still-after]' || sel === '[data-debug-still-diff]') {
        return {width: 0, height: 0, getContext() { return {createImageData(w0, h0) { return {data: new Uint8ClampedArray(w0 * h0 * 4), width: w0, height: h0}; }, putImageData() {}}; }};
      }
      return null;
    }
  };
  assert.equal(paintLastScan(doc, {painting: packed, stickers: []}), true);
  assert.match(held.meta, /settle 1120 ms/);
  assert.match(held.meta, /WB locked manual/);
  assert.match(held.blobs, /accept/);
  const line = formatScanBlob(last.blobs.find(b => b.reason === 'accept'));
  assert.match(line, /dL /);
  assert.match(line, /iou /);
  assert.match(line, /solid /);
  assert.match(line, /circ /);
  assert.match(line, /hole /);
  assert.match(line, /aspect /);
  assert.match(formatScanMeta(last), /gains /);
  const text = held.meta;
  assert.equal(paintLastScan(doc, {painting: {latched: []}, stickers: []}), false);
  assert.equal(held.meta, text);
});
