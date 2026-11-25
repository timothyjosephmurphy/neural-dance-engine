// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Synthetic checks for the Nov 23 studio replay fixes: a close-up person in a
// global change, flash and dimming that must not read as a person, a dark
// cutout on clipped sky, a low-contrast cutout measured whole, and the visit
// scene grabbed only with nobody in frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {coverageFromRead, createStaticBackground, personInFrame, PERSON_SHADE_CORR} from '../src/person-occlusion.js';
import {detectChangedStickers} from '../src/painting-diff.js';

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return data;
}
// Deterministic painted texture: stripes and blocks of mid tones.
function texture(x, y) {
  const a = ((x * 7 + y * 3) >> 4) % 5, b = ((x >> 3) + (y >> 4)) % 3;
  const t = 90 + a * 22 + b * 14;
  return [t, Math.max(0, t - 20 + b * 10), Math.max(0, t - 35 + a * 6)];
}
const W = 160, H = 120;
function learned() {
  const bg = createStaticBackground();
  const empty = paint(W, H, texture);
  for (let i = 0; i < 8; i++) {
    const r = personInFrame(empty, W, H, {background: bg, step: 2});
    bg.update(r.cells, r.cols, r.rows, {clear: true, now: i * 100});
  }
  assert.equal(bg.ready(), true);
  assert.ok(bg.level() > 0, 'the learned picture keeps the empty frame median');
  return bg;
}

test('a head and shoulders close to the camera is a person even when every cell reads changed', () => {
  const bg = learned();
  // Hair fills the lower middle from the bottom edge; the camera exposes up
  // for the dark patch, so the rest of the painting reads brighter.
  const close = paint(W, H, (x, y) => {
    if (y > 40 && x > 35 && x < 125) return [34, 28, 26];
    const [r, g, b] = texture(x, y);
    return [Math.min(255, r * 1.3), Math.min(255, g * 1.3), Math.min(255, b * 1.3)];
  });
  const read = personInFrame(close, W, H, {background: bg, step: 2});
  assert.equal(read.globalChange, true, 'static ' + read.staticFraction);
  assert.equal(read.brightening, false);
  assert.equal(read.edgeOccluder, true, 'dark ' + read.darkFraction);
  assert.ok(read.darkShade < PERSON_SHADE_CORR, 'shade ' + read.darkShade);
  assert.equal(read.present, true);
  assert.ok(coverageFromRead(read) > 0.2, 'coverage ' + coverageFromRead(read));
});

test('a white flash and a dimmed projection are not a person', () => {
  const bg = learned();
  const flash = paint(W, H, (x, y) => {
    const [r, g, b] = texture(x, y);
    return [Math.min(255, r * 1.9), Math.min(255, g * 1.9), Math.min(255, b * 1.9)];
  });
  const washed = personInFrame(flash, W, H, {background: bg, step: 2});
  assert.equal(washed.brightening, true, 'level ' + washed.levelRatio);
  assert.equal(washed.present, false);
  assert.equal(washed.holding, false);
  assert.equal(coverageFromRead(washed), 0);
  // The projector dims most of the painting (exposure recovery after a flash,
  // a dark show cue). The texture survives, so it is shading, not a body.
  const dim = paint(W, H, (x, y) => {
    const [r, g, b] = texture(x, y);
    const k = x > 8 && x < 152 && y > 10 ? 0.2 + 0.7 * (x / W) : 1;
    return [r * k, g * k, b * k];
  });
  const shaded = personInFrame(dim, W, H, {background: bg, step: 2});
  if (shaded.globalChange && shaded.darkFraction > 0.04) assert.ok(shaded.darkShade >= PERSON_SHADE_CORR, 'shade ' + shaded.darkShade);
  assert.equal(shaded.present, false, JSON.stringify({g: shaded.globalChange, dark: shaded.darkFraction, shade: shaded.darkShade}));
  assert.equal(coverageFromRead(shaded), 0);
});

const FIGURE = ['..####..', '..####..', '..####..', '.######.', '.######.', '########', '########', '########', '.######.', '.######.', '.######.', '.######.', '.######.', '..####..', '..####..', '..####..', '..#..#..', '..#..#..', '..#..#..', '..#..#..', '..#..#..', '..#..#..'];
function stamp(data, w, x0, y0, fw, fh, color) {
  for (let y = 0; y < fh; y++) {
    const row = FIGURE[Math.min(FIGURE.length - 1, Math.floor(y * FIGURE.length / fh))];
    for (let x = 0; x < fw; x++) {
      if (row[Math.min(row.length - 1, Math.floor(x * row.length / fw))] !== '#') continue;
      const c = typeof color === 'function' ? color(y / fh) : color;
      const i = ((y0 + y) * w + (x0 + x)) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
  }
}
function rgbRef(rgba) {
  const out = new Uint8Array(rgba.length / 4 * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2]; }
  return out;
}

test('a dark cutout on clipped sky is found, and a brighter bloom there is not', () => {
  const w = 360, h = 255;
  const quad = [{x: 0, y: 0}, {x: w - 1, y: 0}, {x: w - 1, y: h - 1}, {x: 0, y: h - 1}];
  const sky = paint(w, h, (x, y) => y < 150 ? [236, 246, 250] : [70, 90, 130]);
  const withCutout = sky.slice();
  stamp(withCutout, w, 170, 80, 16, 44, [96, 112, 128]);
  const hit = detectChangedStickers(withCutout, w, h, {quad, reference: rgbRef(sky)});
  assert.equal(hit.stickers.length, 1, JSON.stringify(hit.rejected));
  assert.ok(Math.abs(hit.stickers[0].u - 178 / (w - 1)) < 0.03);
  const bloom = sky.slice();
  stamp(bloom, w, 170, 80, 16, 44, [255, 255, 255]);
  const none = detectChangedStickers(bloom, w, h, {quad, reference: rgbRef(sky)});
  assert.equal(none.stickers.length, 0, JSON.stringify(none.view.blobs));
});

test('a matte cutout that only clears the hot bar at its head is measured past the head', () => {
  const w = 360, h = 255;
  const quad = [{x: 0, y: 0}, {x: w - 1, y: 0}, {x: w - 1, y: h - 1}, {x: 0, y: h - 1}];
  const ground = paint(w, h, () => [120, 120, 126]);
  const after = ground.slice();
  // The head steps 70 below the paint; the body only 40 (under the 42 hot
  // bar, over its STICKER_WEAK share). Without the grow step the box stopped
  // at the head (23 px of 80).
  stamp(after, w, 170, 60, 40, 80, (t) => t < 0.3 ? [50, 50, 56] : [80, 80, 86]);
  const hit = detectChangedStickers(after, w, h, {quad, reference: rgbRef(ground)});
  assert.equal(hit.stickers.length, 1, JSON.stringify(hit.rejected));
  assert.ok(hit.stickers[0].h >= 32, 'height ' + hit.stickers[0].h);
});

test('the post-scan visit picture is grabbed only with nobody in frame', () => {
  const cam = readFileSync(new URL('../camera-markers.js', import.meta.url), 'utf8');
  const fn = cam.slice(cam.indexOf('considerVisitScene() {'), cam.indexOf('sceneMatchesVisit() {'));
  assert.match(fn, /if \(cam\.personBlocked\) return;/);
  assert.ok(fn.indexOf('cam.personBlocked') < fn.indexOf('cam.visitScene = sceneSignature'));
});
