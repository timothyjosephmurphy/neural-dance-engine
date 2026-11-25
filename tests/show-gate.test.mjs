// Show-night gate. One sticker per photo fixture, Align finishes every phase,
// and a latched sticker still draws its silhouette. Uncaught rejections fail the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {beginAlign} from '../neural-dance/live-show.js';
import {ensureControlsPill, stageMarkerFromDetect} from '../neural-dance/camera-markers.js';
import {blankLuminanceMatches, createBlankSettle, createScanBook, createScanClock, detectBlankStickers, frameMatchesFlash, luminancePlane, pointInQuad, retainContour, scanBlankFrame} from '../neural-dance/src/blank-scan.js';
import {personInFrame} from '../neural-dance/src/person-occlusion.js';
import {contourArea, createSilhouetteShow} from '../neural-dance/src/silhouette.js';

const leaks = [];
process.on('unhandledRejection', (reason) => {
  leaks.push(reason instanceof Error ? reason.message : String(reason));
});

const fixtureDir = new URL('./fixtures/', import.meta.url);

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

function readRgb(url, width, height) {
  const raw = readFileSync(url);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
    rgba[i] = raw[p];
    rgba[i + 1] = raw[p + 1];
    rgba[i + 2] = raw[p + 2];
    rgba[i + 3] = 255;
  }
  return {rgba, width, height};
}

const hasStudioFixtures = ['nd-spurious-480.ppm', 'screen-border-240.rgb', 'nd-undercam-480.ppm'].every(
  name => existsSync(new URL(name, fixtureDir))
);

function stickerCount(frame) {
  const bright = detectBlankStickers(frame.rgba, frame.width, frame.height, {mode: 'black', sensitivity: 0.5});
  assert.equal(bright.length, 0, 'a lit show photo is not a black flash');
  return detectBlankStickers(frame.rgba, frame.width, frame.height, {mode: 'white', sensitivity: 0.5});
}

test('show photos each contain exactly one dark sticker', { skip: !hasStudioFixtures }, () => {
  const asked = ['nd-sticker-test.jpg', 'nd-screen-border.jpg'];
  const missing = asked.filter(name => !existsSync(new URL(name, fixtureDir)));
  const alignShots = readdirSync(fixtureDir).filter(name => /^nd-align-.*\.jpg$/i.test(name));
  console.log('show fixtures present: nd-spurious.jpg, nd-spurious-480.ppm, screen-border-240.rgb');
  console.log('show fixtures not in this environment: ' + (missing.concat(alignShots.length ? [] : ['nd-align-*.jpg']).join(', ') || 'none'));

  assert.equal(existsSync(new URL('nd-spurious.jpg', fixtureDir)), true);
  const spurious = stickerCount(readPpm(new URL('nd-spurious-480.ppm', fixtureDir)));
  assert.equal(spurious.length, 1, spurious.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0)).join(' | '));
  assert.ok(Math.abs(spurious[0].x / 480 - 0.39) < 0.04);
  assert.ok(Math.abs(spurious[0].y / 360 - 0.46) < 0.04);

  const meta = JSON.parse(readFileSync(new URL('screen-border-240.json', fixtureDir), 'utf8'));
  const border = stickerCount(readRgb(new URL('screen-border-240.rgb', fixtureDir), meta.width, meta.height));
  const near = border.filter(blob => Math.abs(blob.x / meta.width - meta.sticker[0]) < 0.08 && Math.abs(blob.y / meta.height - meta.sticker[1]) < 0.08);
  assert.equal(near.length, 1, border.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0)).join(' | '));
  assert.equal(border.length, 1, 'the border photo should not add a second sticker');

  assert.equal(existsSync(new URL('nd-undercam.jpg', fixtureDir)), true);
  const under = stickerCount(readPpm(new URL('nd-undercam-480.ppm', fixtureDir)));
  assert.equal(under.length, 1, under.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0)).join(' | '));
  assert.ok(Math.abs(under[0].x / 480 - 0.52) < 0.04, under[0].x);
  assert.ok(Math.abs(under[0].y / 360 - 0.60) < 0.04, under[0].y);
});

function flashFrames() {
  const width = 160;
  const height = 90;
  const dark = new Uint8ClampedArray(width * height * 4);
  const bright = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < dark.length; i += 4) {
    dark[i] = dark[i + 1] = dark[i + 2] = 16;
    dark[i + 3] = 255;
    bright[i] = bright[i + 1] = bright[i + 2] = 16;
    bright[i + 3] = 255;
  }
  for (let y = 6; y < 84; y++) {
    for (let x = 10; x < 150; x++) {
      const i = (y * width + x) * 4;
      bright[i] = bright[i + 1] = bright[i + 2] = 236;
    }
  }
  const frame = (data) => ({data, width, height, videoWidth: width, videoHeight: height});
  return {dark: frame(dark), bright: frame(bright)};
}

test('Align runs black, white, and marker phases without throwing', async () => {
  const flash = flashFrames();
  let grabs = 0;
  const said = [];
  const note = (text) => { said.push(String(text)); };
  const cam = {
    async ensureCamera() {},
    grabFrame() {
      grabs += 1;
      return grabs === 1 ? flash.dark : flash.bright;
    },
    setNormalizedCorners() { return false; },
    setMarkersEnabled() {},
    cancelCalibration() {},
    setScanReference() { return true; },
    setAlignOverlay() {},
    startCornerDraft() {}
  };
  const classes = new Set();
  const status = {
    _text: '',
    set textContent(value) { this._text = String(value); note(value); },
    get textContent() { return this._text; }
  };
  const banner = {
    hidden: true,
    dataset: {},
    set textContent(value) { note(value); },
    get textContent() { return ''; }
  };
  const doc = {
    body: {classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }},
    getElementById(id) {
      if (id === 'nd-room-lab') {
        return {
          dataset: {},
          querySelector(sel) { return String(sel).includes('align') && String(sel).includes('action') ? {textContent: 'Align projector', setAttribute() {}} : status; }
        };
      }
      if (id === 'nd-camera-mode') return {neuralDanceCamera: cam};
      return null;
    },
    querySelector(sel) {
      const key = String(sel);
      if (key.includes('data-align-banner')) return banner;
      if (key.includes('cal-pattern')) return {hidden: true};
      if (key.includes('lock-outline')) return {hidden: true};
      if (key.includes('exit-align') || key.includes('cancel-align') || key.includes('align-readout') || key.includes('cancel-zone')) return {hidden: true};
      return null;
    }
  };
  await beginAlign(doc, {alignSettleMs: 0, alignPhaseMs: 2500});
  assert.ok(said.some(line => line.includes('Black phase')), said.join(' | '));
  assert.ok(said.some(line => line.includes('White phase')), said.join(' | '));
  assert.ok(said.some(line => line.includes('Marker phase')), said.join(' | '));
  // Refusal keeps the last good quad and exits Align (no drag-corner draft on
  // the projector). nd-live-aligning is cleared (TJ 4:43–4:44 PM).
  assert.equal(classes.has('nd-live-aligning'), false);
  assert.equal(classes.has('nd-live-placing'), false);
  assert.equal(leaks.length, 0, leaks.join(' | '));
});

function paintRgba(width, height, colorAt) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = colorAt(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

// TJ's far-back photo (nd-blobs.jpg) shows the symptoms only: false dots,
// growing white blobs, the real sticker missed, Controls gone. The phone and
// arm in that photo are the camera, so the file is not a camera frame.
test('an empty floor yields no dancer blobs and silhouettes do not grow', () => {
  const width = 160;
  const height = 120;
  const floor = paintRgba(width, height, () => [232, 232, 228]);
  const reference = luminancePlane(floor, width, height);
  const emptyPerson = personInFrame(floor, width, height, {reference});
  assert.equal(emptyPerson.present, false);
  assert.equal(emptyPerson.bodyFraction, 0);
  assert.equal(detectBlankStickers(floor, width, height, {mode: 'white', reference}).length, 0);

  const projected = floor.slice();
  for (let n = 0; n < 6; n++) {
    const x0 = 12 + (n % 3) * 48;
    const y0 = 8 + Math.floor(n / 3) * 56;
    for (let y = y0; y < y0 + 40; y++) {
      for (let x = x0; x < x0 + 28; x++) {
        const i = (y * width + x) * 4;
        projected[i] = 255;
        projected[i + 1] = 250;
        projected[i + 2] = 240;
      }
    }
  }
  assert.equal(frameMatchesFlash(projected, width, height, 'black', null, 180), false, 'projected dancers are not a black blank');
  assert.equal(detectBlankStickers(projected, width, height, {mode: 'white', reference}).length, 0, 'bright projected shapes are not stickers');
  const person = personInFrame(projected, width, height, {reference});
  assert.equal(person.present, false, 'projected light is not a person');

  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const paths = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineJoin: '', globalCompositeOperation: 'source-over',
    save() {}, restore() {}, beginPath() { paths.push({fill: false, stroke: false, moves: 0}); },
    moveTo() { paths[paths.length - 1].moves++; }, lineTo() { paths[paths.length - 1].moves++; }, closePath() {},
    fill() { paths[paths.length - 1].fill = true; }, stroke() { paths[paths.length - 1].stroke = true; }
  };
  show.paint(ctx, [], {now: 0, paintDots() {}});
  show.beat(500, 1);
  show.paint(ctx, [], {now: 700, paintDots() {}});
  assert.equal(paths.length, 0, 'an empty floor does not grow a silhouette');

  const small = [{x: 40, y: 30}, {x: 70, y: 28}, {x: 68, y: 80}, {x: 42, y: 78}];
  const grown = [{x: 10, y: 10}, {x: 140, y: 12}, {x: 136, y: 110}, {x: 8, y: 108}];
  assert.equal(retainContour(small, grown), small);
  const book = createScanBook();
  for (let i = 0; i < 3; i++) book.observe([{x: 100, y: 80, kind: 'sticker', contour: small}]);
  book.observe([{x: 100, y: 80, kind: 'sticker', contour: grown}]);
  assert.equal(contourArea(book.markers()[0].contour), contourArea(small));
});

test('one dark sticker on a lit floor is the only detection', () => {
  const width = 160;
  const height = 120;
  const rgba = paintRgba(width, height, (x, y) => {
    const sticker = x >= 74 && x < 86 && y >= 52 && y < 70;
    return sticker ? [22, 18, 16] : [236, 236, 232];
  });
  const reference = luminancePlane(paintRgba(width, height, () => [236, 236, 232]), width, height);
  const found = detectBlankStickers(rgba, width, height, {mode: 'white', sensitivity: 0.5, reference});
  assert.equal(found.length, 1, found.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0)).join(' | '));
  assert.ok(Math.abs(found[0].x / width - 0.5) < 0.08);
  assert.ok(Math.abs(found[0].y / height - 0.5) < 0.08);
});

test('a verified blank finds the debug-camera sticker and ignores projected blobs', () => {
  const spec = JSON.parse(readFileSync(new URL('fixtures/nd-debug-cam.json', import.meta.url), 'utf8'));
  const width = spec.width;
  const height = spec.height;
  const quad = spec.quad;
  const sticker = spec.sticker;
  const blobs = spec.blobs;
  const inside = (x, y) => pointInQuad(x, y, quad);
  const near = (x, y, reach) => blobs.some(([cx, cy]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= reach * reach);
  const show = paintRgba(width, height, (x, y) => {
    if (!inside(x, y)) return [8, 8, 10];
    if (x >= sticker.x && x < sticker.x + sticker.w && y >= sticker.y && y < sticker.y + sticker.h) return [14, 12, 10];
    if (near(x, y, 22)) return [255, 236, 186];
    return [22, 20, 28];
  });
  assert.equal(blankLuminanceMatches(show, width, height, 'white', inside), false);
  assert.equal(blankLuminanceMatches(show, width, height, 'black', inside), false);
  assert.equal(scanBlankFrame(show, width, height, {settled: true, mode: 'white', inside}).length, 0);
  assert.equal(scanBlankFrame(show, width, height, {settled: true, mode: 'black', inside, projected: (x, y) => near(x, y, 22)}).length, 0);
  assert.equal(scanBlankFrame(show, width, height, {settled: false, mode: 'white', inside}).length, 0);

  const white = paintRgba(width, height, (x, y) => {
    if (x >= sticker.x && x < sticker.x + sticker.w && y >= sticker.y && y < sticker.y + sticker.h) return [18, 16, 14];
    return [236, 236, 232];
  });
  const found = scanBlankFrame(white, width, height, {settled: true, mode: 'white', sensitivity: 0.5, inside});
  assert.equal(found.length, 1, found.map(blob => blob.x.toFixed(0) + ',' + blob.y.toFixed(0)).join(' | '));
  assert.ok(Math.abs(found[0].x - (sticker.x + sticker.w / 2)) < 8);
  assert.ok(Math.abs(found[0].y - (sticker.y + sticker.h / 2)) < 8);

  const ghosts = paintRgba(width, height, (x, y) => near(x, y, 6) ? [230, 230, 220] : [10, 10, 12]);
  const open = scanBlankFrame(ghosts, width, height, {settled: true, mode: 'black', sensitivity: 0.5, inside});
  assert.ok(open.length > 0, 'projected dots would latch if the drawn light were not removed');
  const subtracted = scanBlankFrame(ghosts, width, height, {settled: true, mode: 'black', sensitivity: 0.5, inside, projected: (x, y) => near(x, y, 6)});
  assert.equal(subtracted.length, 0);

  const settle = createBlankSettle();
  settle.begin('white');
  assert.equal(settle.frame(0), false);
  assert.equal(settle.frame(16), false);
  // Default camera latency is 220 ms after two rAF ticks.
  assert.equal(settle.frame(235), false);
  assert.equal(settle.frame(236), true);
});

test('Controls stay reachable after scan cycles', () => {
  const reveal = {hidden: true};
  const dock = {hidden: false};
  const classes = new Set(['nd-live-hidden']);
  const doc = {
    body: {classList: {contains(name) { return classes.has(name); }}},
    querySelector(sel) {
      if (String(sel).includes('reveal')) return reveal;
      if (String(sel).includes('nd-live-chrome')) return dock;
      return null;
    }
  };
  const clock = createScanClock({intervalMs: 2000, durationMs: 200, mode: 'white'});
  let now = 1000;
  for (let i = 0; i < 12; i++) {
    now += 400;
    const tick = clock.tick(now, {});
    if (!tick.flash) ensureControlsPill(doc);
  }
  assert.equal(ensureControlsPill(doc), true);
  assert.equal(reveal.hidden, false, 'the Controls pill is visible when the dock is hidden');
  classes.delete('nd-live-hidden');
  dock.hidden = true;
  assert.equal(ensureControlsPill(doc), true);
  assert.equal(dock.hidden, false, 'the dock comes back when the show is not hiding it');
});

test('a latched sticker renders its silhouette', () => {
  const width = 80;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = x >= 30 && x < 48 && y >= 16 && y < 40;
      data[i] = dark ? 20 : 230;
      data[i + 1] = dark ? 18 : 230;
      data[i + 2] = dark ? 16 : 226;
      data[i + 3] = 255;
    }
  }
  const found = detectBlankStickers(data, width, height, {mode: 'white', sensitivity: 0.5});
  assert.equal(found.length, 1);
  assert.ok(found[0].contour && found[0].contour.length >= 6);
  const placed = stageMarkerFromDetect(found[0], {width, height, scaleX: 1, scaleY: 1}, null);
  assert.ok(placed.contour && placed.contour.length >= 6);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  show.beat(500, 1);
  const paths = [];
  let path = null;
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineJoin: '',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() { path = {moves: [], fill: false, stroke: false}; paths.push(path); },
    moveTo() { path.moves.push(1); },
    lineTo() { path.moves.push(1); },
    closePath() {},
    fill() { path.fill = true; },
    stroke() { path.stroke = true; }
  };
  const dots = [];
  show.paint(ctx, [{id: 3, x: placed.x, y: placed.y, type: 1, kind: 'sticker', contour: placed.contour}], {
    now: 700,
    waveform: () => [0, 0.5, 1, 0.25],
    paintDots(list) { dots.push(...list); }
  });
  assert.equal(dots.length, 0);
  assert.ok(paths.some(item => item.fill && item.moves.length > 4));
  assert.ok(paths.some(item => item.stroke));
  assert.equal(leaks.length, 0, leaks.join(' | '));
});
