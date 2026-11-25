// Copyright (c) 2026 Timothy Joseph Murphy
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {CANVAS_H, CANVAS_W, detectStickerBlobs, detectionSize, homographyFromNormalized, projectDetectPoint, projectVideoPoint} from '../neural-dance/camera-markers.js';
const hasStudioFixtures = existsSync(new URL('./fixtures/nd-spurious-480.ppm', import.meta.url));
import {
  SCAN_DURATION_MS,
  SCAN_HITS,
  CONTINUOUS_HITS,
  CONTINUOUS_MISSES,
  SCAN_INTERVAL_MS,
  SCAN_MIN_INTERVAL_MS,
  SCAN_MISSES,
  clampScanDuration,
  clampScanInterval,
  createScanBook,
  createScanClock,
  blankFrameVerified,
  detectBlankStickers,
  frameMatchesFlash,
  luminancePlane,
  nextScanMode,
  readScanSettings,
  writeScanSettings
} from '../neural-dance/src/blank-scan.js';

const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
const show = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');

function paint(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

test('a 480×360 detect grid lands on the same stage point as the 640×480 video', () => {
  const videoW = 640;
  const videoH = 480;
  const scale = detectionSize(videoW, videoH);
  assert.equal(scale.width, 480);
  assert.equal(scale.height, 360);
  assert.ok(Math.abs(scale.scaleX - videoW / 480) < 1e-9);
  assert.ok(Math.abs(scale.scaleY - videoH / 360) < 1e-9);
  const H = homographyFromNormalized([{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}], videoW, videoH);
  const vx = 400;
  const vy = 180;
  const full = projectVideoPoint(H, vx, vy);
  const dx = vx / scale.scaleX - 0.5;
  const dy = vy / scale.scaleY - 0.5;
  const mapped = projectDetectPoint(H, dx, dy, scale);
  assert.ok(Math.abs(mapped.x - full.x) < 0.6, mapped.x + ' vs ' + full.x);
  assert.ok(Math.abs(mapped.y - full.y) < 0.6, mapped.y + ' vs ' + full.y);
  const forgot = projectVideoPoint(H, dx, dy);
  assert.ok(Math.hypot(forgot.x - full.x, forgot.y - full.y) > 40, 'detect pixels are not video pixels');
  assert.ok(full.x > 0 && full.x < CANVAS_W && full.y > 0 && full.y < CANVAS_H);
});

test('blank scans stay at least two seconds apart and only sample the flash', () => {
  assert.equal(clampScanInterval(500), SCAN_MIN_INTERVAL_MS);
  assert.equal(clampScanInterval(99999), 12000);
  assert.equal(clampScanDuration(10), 150);
  assert.equal(clampScanDuration(900), 250);
  assert.equal(SCAN_INTERVAL_MS, 4000);
  assert.equal(SCAN_DURATION_MS >= 150 && SCAN_DURATION_MS <= 250, true);
  assert.equal(nextScanMode('black'), 'gray');
  assert.equal(nextScanMode('gray'), 'white');
  assert.equal(nextScanMode('white'), 'off');
  assert.equal(nextScanMode('off'), 'black');

  const clock = createScanClock({mode: 'black'});
  assert.equal(clock.tick(0).flash, null);
  assert.equal(clock.tick(SCAN_INTERVAL_MS - 1).flash, null);
  const started = clock.tick(SCAN_INTERVAL_MS);
  assert.equal(started.started, true);
  assert.equal(started.flash, 'black');
  assert.equal(started.detect, false);
  const open = clock.tick(SCAN_INTERVAL_MS + 80);
  assert.equal(open.detect, true);
  assert.equal(open.flash, 'black');
  let starts = 1;
  for (let t = SCAN_INTERVAL_MS + 10; t < SCAN_INTERVAL_MS + SCAN_DURATION_MS; t += 10) {
    const tick = clock.tick(t);
    assert.equal(tick.started || false, false);
    if (tick.started) starts++;
  }
  const done = clock.tick(SCAN_INTERVAL_MS + SCAN_DURATION_MS);
  assert.equal(done.done, true);
  assert.equal(done.flash, null);
  assert.equal(clock.tick(SCAN_INTERVAL_MS + SCAN_DURATION_MS + 100).flash, null);
  const again = clock.tick(SCAN_INTERVAL_MS * 2);
  assert.equal(again.started, true);
  assert.equal(starts, 1);

  const blocked = createScanClock({intervalMs: 2000, mode: 'black'});
  blocked.tick(0);
  assert.equal(blocked.tick(2000, {blocked: true}).flash, null);
  assert.equal(blocked.tick(2100, {blocked: true}).flash, null);
  assert.equal(blocked.tick(2200).flash, 'black');
  const off = createScanClock({mode: 'off'});
  off.tick(0);
  assert.equal(off.tick(SCAN_MIN_INTERVAL_MS).flash, null);
});

test('stickers latch after three blank scans and do not drift', () => {
  const book = createScanBook();
  assert.equal(SCAN_HITS, 3);
  assert.ok(SCAN_MISSES >= 3);
  assert.equal(book.observe([{x: 100, y: 80, kind: 'sticker'}]).length, 0);
  assert.equal(book.observe([{x: 110, y: 84, kind: 'sticker'}]).length, 0);
  const latched = book.observe([{x: 105, y: 82, kind: 'sticker'}]);
  assert.equal(latched.length, 1);
  assert.equal(latched[0].kind, 'sticker');
  const anchorX = latched[0].x;
  const anchorY = latched[0].y;
  assert.ok(Math.abs(anchorX - 105) < 1 && Math.abs(anchorY - 82) < 1);
  book.observe([{x: anchorX + 6, y: anchorY + 4, kind: 'sticker'}]);
  book.observe([{x: anchorX + 9, y: anchorY - 3, kind: 'sticker'}]);
  assert.equal(book.markers()[0].x, anchorX);
  assert.equal(book.markers()[0].y, anchorY);
  book.observe([{x: 400, y: 200, kind: 'sticker'}]);
  assert.equal(book.markers().length, 1, 'one sighting does not add a marker');
  book.observe([{x: 168, y: 80, kind: 'sticker'}]);
  book.observe([{x: 172, y: 84, kind: 'sticker'}]);
  assert.equal(book.markers()[0].x, anchorX, 'one far hit does not move a latched dot');
  const moved = book.observe([{x: 170, y: 82, kind: 'sticker'}]);
  assert.ok(Math.abs(moved[0].x - 170) < 4 && Math.abs(moved[0].y - 82) < 4);
  for (let i = 0; i < SCAN_MISSES - 1; i++) book.observe([]);
  assert.equal(book.markers().length, 1);
  book.observe([]);
  assert.equal(book.markers().length, 0);

  const kept = createScanBook();
  kept.restore([{id: 7, x: 20, y: 30, kind: 'sticker'}]);
  assert.equal(kept.markers()[0].id, 7);
  kept.observe([{x: 22, y: 31, kind: 'sticker'}]);
  assert.equal(kept.markers().length, 1);
  assert.equal(kept.markers()[0].id, 7);
});

test('a blank frame finds a sticker and a lit frame does not count as the flash', () => {
  const width = 80;
  const height = 60;
  const white = paint(width, height, (x, y) => (x >= 20 && x < 38 && y >= 12 && y < 36 ? [24, 22, 20] : [236, 236, 232]));
  const line = paint(width, height, (x, y) => (y === 30 ? [255, 255, 255] : [236, 236, 232]));
  const black = paint(width, height, (x, y) => (x >= 44 && x < 62 && y >= 10 && y < 34 ? [210, 48, 36] : [6, 6, 8]));
  assert.equal(detectBlankStickers(white, width, height, {mode: 'white'}).length, 1);
  assert.equal(detectBlankStickers(line, width, height, {mode: 'white'}).length, 0);
  const red = detectBlankStickers(black, width, height, {mode: 'black'});
  assert.equal(red.length, 1, 'a red sticker shows up on a black flash');
  assert.equal(frameMatchesFlash(white, width, height, 'black', null, 180), false);
  assert.equal(frameMatchesFlash(black, width, height, 'black', null, 180), true);
  assert.equal(frameMatchesFlash(white, width, height, 'white', null, 40), true);
  assert.equal(frameMatchesFlash(white, width, height, 'white', null, 220), false);

  const memory = {store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }, setItem(k, v) { this.store.set(k, String(v)); }};
  assert.equal(readScanSettings(memory).mode, 'off');
  assert.equal(readScanSettings(memory).intervalMs, 4000);
  assert.equal(writeScanSettings(memory, {mode: 'white', intervalMs: 100, durationMs: 10}), true);
  const saved = readScanSettings(memory);
  assert.equal(saved.mode, 'white');
  assert.equal(saved.intervalMs, 2000);
  assert.equal(saved.durationMs, 150);
  const patch = sanitizeDebugPatch({scanMode: 'off', scanInterval: 1, scanDuration: 999});
  assert.equal(patch.scanMode, 'off');
  assert.equal(patch.scanInterval, 2);
  assert.equal(patch.scanDuration, 250);
  assert.doesNotMatch(livePage, /data-scan-mode/);
  assert.match(livePage, /data-capture-floor[^>]*>Capture empty floor/);
  assert.match(readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8'), /rejectSummary/);
  assert.doesNotMatch(debugPage, /data-debug-scan/);
  assert.match(debugPage, /data-debug-action="scan-stickers">Scan stickers</);
  assert.match(debugPage, /data-debug-control="scan-interval"/);
  assert.match(debugPage, /data-debug-control="scan-duration"/);
  assert.match(debugPage, /min="2"/);
  assert.doesNotMatch(show, /t \* PULSE_REACH/);
  assert.match(show, /throbScale\((?:bodyEnv|env)\)/);
});

function readPpm(url) {
  const raw = readFileSync(url);
  let i = 0;
  const token = () => {
    while (i < raw.length && (raw[i] === 32 || raw[i] === 10 || raw[i] === 13 || raw[i] === 9)) i++;
    while (raw[i] === 35) {
      while (raw[i] !== 10 && i < raw.length) i++;
      while (i < raw.length && (raw[i] === 32 || raw[i] === 10 || raw[i] === 13 || raw[i] === 9)) i++;
    }
    const start = i;
    while (i < raw.length && raw[i] !== 32 && raw[i] !== 10 && raw[i] !== 13 && raw[i] !== 9) i++;
    return raw.toString('ascii', start, i);
  };
  assert.equal(token(), 'P6');
  const width = +token();
  const height = +token();
  assert.equal(+token(), 255);
  if (raw[i] === 10 || raw[i] === 13) i++;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, n = 0; n < width * height; n++, p += 3) {
    const o = n * 4;
    rgba[o] = raw[i + p];
    rgba[o + 1] = raw[i + p + 1];
    rgba[o + 2] = raw[i + p + 2];
    rgba[o + 3] = 255;
  }
  return {rgba, width, height};
}

test('the live projector photo has one dark sticker and not the glowing dots', { skip: !hasStudioFixtures }, () => {
  const photo = readPpm(new URL('./fixtures/nd-spurious-480.ppm', import.meta.url));
  assert.equal(photo.width, 480);
  assert.equal(photo.height, 360);
  const bright = detectBlankStickers(photo.rgba, photo.width, photo.height, {mode: 'black', sensitivity: 0.5});
  assert.equal(bright.length, 0, 'a lit screen is not a black flash');
  const stickers = detectBlankStickers(photo.rgba, photo.width, photo.height, {mode: 'white', sensitivity: 0.5});
  assert.equal(stickers.length, 1, stickers.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0) + ' a' + blob.area).join(' | '));
  assert.ok(Math.abs(stickers[0].x / photo.width - 0.39) < 0.04, stickers[0].x);
  assert.ok(Math.abs(stickers[0].y / photo.height - 0.46) < 0.04, stickers[0].y);
  const floor = luminancePlane(photo.rgba, photo.width, photo.height);
  const again = detectBlankStickers(photo.rgba, photo.width, photo.height, {mode: 'white', sensitivity: 0.5, reference: floor});
  assert.equal(again.length, 0, 'the empty floor reference hides stickers that were already in the picture');
});

test('continuous detector finds the live center dark sticker that blank-only misses on a lit frame', { skip: !hasStudioFixtures }, () => {
  const photo = readPpm(new URL('./fixtures/nd-live-center-sticker-480.ppm', import.meta.url));
  assert.equal(photo.width, 480);
  assert.equal(photo.height, 360);
  assert.equal(blankFrameVerified(photo.rgba, photo.width, photo.height, 'gray'), false);
  assert.equal(blankFrameVerified(photo.rgba, photo.width, photo.height, 'white'), false);
  const continuous = detectStickerBlobs(photo.rgba, photo.width, photo.height, {stickerSensitivity: 1});
  const near = continuous.filter(b => Math.hypot(b.x - 259, b.y - 214) < 80);
  assert.ok(near.length >= 1, 'expected continuous blob near stage center, got ' + continuous.slice(0, 6).map(b => b.x.toFixed(0) + ',' + b.y.toFixed(0) + ' a' + b.area).join(' | '));
  assert.ok(near[0].area >= 20 && near[0].area <= 120, 'area ' + near[0].area);
});

test('unpaired debug banner is fixed outside the controls chrome', () => {
  assert.match(livePage, /\[data-debug-pair-banner\]\{position:fixed/);
  assert.match(livePage, /<button type="button" data-debug-pair-banner hidden>/);
  assert.match(livePage, /Safari, Chrome, and the Home Screen app each need their own pair/);
  const chrome = livePage.slice(livePage.indexOf('class="nd-live-chrome"'), livePage.indexOf('id="nd-camera-mode"'));
  assert.doesNotMatch(chrome, /data-debug-pair-banner/);
});

test('live show defaults blank flash off; flash toggle lives on debug only', () => {
  const clock = createScanClock();
  assert.equal(clock.mode, 'off');
  assert.equal(clock.tick(SCAN_INTERVAL_MS).flash, null);
  assert.equal(readScanSettings({getItem(){ return null; }}).mode, 'off');
  assert.doesNotMatch(livePage, /data-scan-mode/);
  const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(debugPage, /data-debug-scan/);
  assert.match(debugPage, /data-debug-action="scan-stickers">Scan stickers</);
});

test('live build stamp is a fixed corner label outside the controls bar', () => {
  assert.match(livePage, /\[data-nd-build\]\{position:fixed/);
  assert.match(livePage, /#nd-room-lab\[data-nd-scan-until\] \[data-nd-build\]/);
  assert.doesNotMatch(livePage, /#nd-room-lab\[data-nd-scan-mode\] \[data-nd-build\]/);
  assert.match(livePage, /<span data-nd-build title="Build">/);
  const dock = livePage.slice(livePage.indexOf('id="nd-live-dock"'), livePage.indexOf('data-live-details'));
  assert.doesNotMatch(dock, /data-nd-build/);
});

test('continuous latch needs about a second of stable hits before markers appear', () => {
  assert.ok(CONTINUOUS_HITS >= 8, 'hits ' + CONTINUOUS_HITS);
  assert.ok(CONTINUOUS_MISSES >= CONTINUOUS_HITS, 'misses ' + CONTINUOUS_MISSES);
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES});
  for (let i = 0; i < CONTINUOUS_HITS - 1; i++) {
    assert.equal(book.observe([{x: 200, y: 180, kind: 'sticker'}]).length, 0, 'frame ' + i);
  }
  const latched = book.observe([{x: 202, y: 181, kind: 'sticker'}]);
  assert.equal(latched.length, 1);
  assert.ok(Math.hypot(latched[0].x - 200, latched[0].y - 180) < 10);
});

