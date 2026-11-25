// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 10 1:12 PM: Align found 2 of 3 stickers. The missed one is a
// dancing figure with spread arms and legs; its blob filled < 0.34 of its
// box on the white flash and was rejected as "not compact". These tests pin
// 3/3 on a white flash, no spurious blobs, and gap scans never dropping a
// confirmed sticker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {detectBlankStickers, STICKER_COMPACT_MIN} from '../neural-dance/src/blank-scan.js';
import {keepConfirmedStickers, matchScanIds} from '../neural-dance/src/song-gap-scan.js';

const W = 480;
const H = 360;
const FLOOR = 205;
const VINYL = 50;

function frame(fill = FLOOR) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = fill; rgba[i * 4 + 1] = fill + 4; rgba[i * 4 + 2] = fill; rgba[i * 4 + 3] = 255; }
  return rgba;
}
function dot(rgba, x, y, v = VINYL) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = (y * W + x) * 4;
  rgba[p] = v; rgba[p + 1] = v + 4; rgba[p + 2] = v;
}
function paint(rgba, ox, oy, art, v = VINYL) {
  art.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') dot(rgba, ox + x, oy + y, v); }));
}
// Compact upright figure (fills ~0.5 of its box).
const SOLID = ['.##.', '####', '####', '.##.', '.##.', '.#.#', '.#.#'];
// TJ's left sticker: spread arms and legs, 2 px limbs (fills ~0.28 of its box).
const DANCING = [
  '....##....',
  '....##....',
  '#...##...#',
  '.#..##..#.',
  '..######..',
  '....##....',
  '....##....',
  '...#..#...',
  '..#....#..',
  '.#......#.',
  '#........#'
];
function fill(art) {
  let n = 0; for (const r of art) for (const c of r) if (c === '#') n++;
  return n / (art.length * art[0].length);
}

test('the dancing-figure art is below the old compactness cut (the 1:12 PM miss)', () => {
  assert.ok(fill(DANCING) < STICKER_COMPACT_MIN, 'fill ' + fill(DANCING));
});

test('white flash: 3/3 stickers including a spread-limb dancing figure', () => {
  const rgba = frame();
  paint(rgba, 170, 200, DANCING);
  paint(rgba, 268, 205, SOLID);
  paint(rgba, 238, 170, SOLID);
  const blobs = detectBlankStickers(rgba, W, H, {mode: 'white', sensitivity: 0.5});
  assert.equal(blobs.length, 3, JSON.stringify(blobs.map(b => [b.x | 0, b.y | 0, b.area])));
  assert.ok(blobs.some(b => Math.abs(b.x - 175) < 4 && Math.abs(b.y - 205) < 4), 'dancing figure found');
});

test('white flash: no spurious stickers from thin crossings, faint shapes or noise', () => {
  const rgba = frame();
  // Thin X (a seam or cable crossing), 1 px lines.
  for (let k = 0; k < 14; k++) { dot(rgba, 60 + k, 80 + k); dot(rgba, 73 - k, 80 + k); }
  // A faint spread figure (shadow, not vinyl): same shape, lum 140.
  paint(rgba, 330, 120, DANCING, 140);
  // Speckle noise.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) dot(rgba, 30 + Math.floor(rnd() * 420), 30 + Math.floor(rnd() * 300), 150 + Math.floor(rnd() * 40));
  const blobs = detectBlankStickers(rgba, W, H, {mode: 'white', sensitivity: 0.5});
  assert.equal(blobs.length, 0, JSON.stringify(blobs.map(b => [b.x | 0, b.y | 0, b.area])));
});

test('a weaker gap scan never removes a confirmed sticker', () => {
  const prev = [{id: 4, x: 506, y: 191}, {id: 5, x: 574, y: 291}, {id: 6, x: 380, y: 285}];
  const seen = [{x: 509, y: 190}, {x: 575, y: 294}]; // sticker 6 hidden this time
  const kept = keepConfirmedStickers(prev, matchScanIds(prev, seen, 36), 36);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map(p => p.id).sort(), [4, 5, 6]);
  const six = kept.find(p => p.id === 6);
  assert.equal(six.x, 380);
  assert.equal(six.y, 285);
  // Seen stickers take the fresh position, not a duplicate.
  assert.equal(kept.find(p => p.id === 4).x, 509);
});

test('a gap scan that sees a new sticker adds it once and keeps the rest', () => {
  const prev = [{id: 4, x: 506, y: 191}, {id: 5, x: 574, y: 291}];
  const seen = [{x: 506, y: 192}, {x: 380, y: 285}];
  const kept = keepConfirmedStickers(prev, matchScanIds(prev, seen, 36), 36);
  assert.equal(kept.length, 3);
  assert.equal(kept.filter(p => Math.hypot(p.x - 380, p.y - 285) < 2).length, 1);
});
