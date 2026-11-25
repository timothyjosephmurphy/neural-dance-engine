// Copyright (c) 2026 Timothy Joseph Murphy
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {chooseAlignQuad, fitScreenBorder, frameStagePoint, CANVAS_W} from '../neural-dance/camera-markers.js';
import {detectBlankStickers} from '../neural-dance/src/blank-scan.js';
const hasStudioFixtures = existsSync(new URL('./fixtures/screen-border-240.rgb', import.meta.url));

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

test('a screen that nearly fills the frame and a small dark sticker', () => {
  const width = 160;
  const height = 120;
  const data = paint(width, height, (x, y) => {
    const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
    if (border) return [8, 8, 10];
    const onSticker = x >= 54 && x < 62 && y >= 62 && y < 74 && !(x === 58);
    if (onSticker) return [28, 26, 24];
    if (x === 58 && y >= 62 && y < 74) return [236, 236, 232];
    return [214, 214, 210];
  });
  const border = fitScreenBorder(data, width, height);
  assert.equal(border.ok, true, border.reason);
  assert.ok(Math.abs(border.corners[0].x - 4 / width) < 0.06, border.corners[0].x);
  assert.ok(Math.abs(border.corners[2].x - (width - 5) / width) < 0.08);
  const stickers = detectBlankStickers(data, width, height, {mode: 'white', sensitivity: 1});
  assert.equal(stickers.length, 1, 'the white grid line must not split or hide the sticker');
  assert.ok(Math.abs(stickers[0].x / width - 0.36) < 0.08, stickers[0].x);
  assert.ok(Math.abs(stickers[0].y / height - 0.56) < 0.08, stickers[0].y);
  const mapped = frameStagePoint(stickers[0].x, stickers[0].y, width, height);
  assert.ok(mapped.x > 0 && mapped.x < CANVAS_W);
  const choice = chooseAlignQuad({
    markers: {corners: null, reason: 'Marker phase: corner 3 not found.'},
    border,
    bright: {ok: false, corners: null, coverage: 0.42, fill: 0.3, reason: 'White phase: bright region too small.'}
  });
  assert.equal(choice.source, 'border');
  assert.equal(choice.ok, true);
  const markersWin = chooseAlignQuad({
    markers: {corners: border.corners},
    border,
    bright: {ok: false, coverage: 0.4, fill: 0.3, reason: 'mask'}
  });
  assert.equal(markersWin.source, 'markers');
  assert.match(markersWin.warning, /coverage 40%/);
});

test('TJ screen photo has one dark sticker inside the black border', { skip: !hasStudioFixtures }, () => {
  const meta = JSON.parse(readFileSync(new URL('./fixtures/screen-border-240.json', import.meta.url), 'utf8'));
  const raw = readFileSync(new URL('./fixtures/screen-border-240.rgb', import.meta.url));
  const rgba = new Uint8ClampedArray(meta.width * meta.height * 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
    rgba[i] = raw[p];
    rgba[i + 1] = raw[p + 1];
    rgba[i + 2] = raw[p + 2];
    rgba[i + 3] = 255;
  }
  const border = fitScreenBorder(rgba, meta.width, meta.height);
  assert.equal(border.ok, true, border.reason);
  const stickers = detectBlankStickers(rgba, meta.width, meta.height, {mode: 'white', sensitivity: 1});
  const near = stickers.filter(blob => Math.abs(blob.x / meta.width - meta.sticker[0]) < 0.08 && Math.abs(blob.y / meta.height - meta.sticker[1]) < 0.08);
  assert.equal(near.length, 1, stickers.map(blob => [Math.round(blob.x), Math.round(blob.y), blob.area]).join(' | '));
});
