// Sticker latch, frame prior, pink homography, and lit-room Align.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyHomography, orderProjectorCorners, projectedStickerHeight} from '../neural-dance/src/geometry.js';
import {frameFitsPrior} from '../neural-dance/src/painting-frame.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {detectWhiteStickers} from '../neural-dance/src/white-stickers.js';
import {CANVAS_H, CANVAS_W, chooseAlignQuad, differenceImage, homographyFromNormalized, noteScanSample} from '../neural-dance/camera-markers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/frame-bugs');
const hasStudioFixtures = existsSync(dir);

function readPng(path) {
  const buf = readFileSync(path);
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = new Uint8Array(w * bpp);
  const cur = new Uint8Array(w * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * bpp + 1)];
    const row = raw.subarray(y * (w * bpp + 1) + 1, (y + 1) * (w * bpp + 1));
    for (let i = 0; i < w * bpp; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = 255;
    }
    prev.set(cur);
  }
  return {rgba: out, w, h};
}

function mem() {
  const m = new Map();
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
}

test('a frame that climbs above pink 1-2 keeps the projector prior', { skip: !hasStudioFixtures }, () => {
  const {rgba, w, h} = readPng(join(dir, 'spurious-stickers-frame-1104.png'));
  const prior = [
    {x: 0.18, y: 0.30},
    {x: 0.84, y: 0.28},
    {x: 0.86, y: 0.78},
    {x: 0.16, y: 0.80}
  ];
  const climbed = prior.map((p, i) => ({x: p.x, y: i < 2 ? p.y - 0.12 : p.y}));
  assert.equal(frameFitsPrior(climbed, prior), false);
  assert.equal(frameFitsPrior(prior.map(p => ({x: p.x + 0.01, y: p.y + 0.01})), prior), true);
  const store = mem();
  const session = createPaintingSession({storage: store});
  const result = session.detect({data: rgba, width: w, height: h}, {proj: prior});
  const quad = result.quad || session.scanQuad();
  assert.ok(quad && quad.length === 4);
  assert.ok(Math.min(quad[0].y, quad[1].y) >= Math.min(prior[0].y, prior[1].y) - 0.01, 'top ' + quad.map(p => p.y.toFixed(3)).join(','));
  const again = createPaintingSession({storage: store});
  assert.ok(again.frameQuad(), 'accepted frame reloads');
  assert.ok(Math.min(...again.frameQuad().map(p => p.y).slice(0, 2)) >= Math.min(prior[0].y, prior[1].y) - 0.01);
});

test('a sticker maps through the pink quad, and its height follows that homography', () => {
  const pink = [
    {x: 0.20, y: 0.30},
    {x: 0.80, y: 0.32},
    {x: 0.82, y: 0.78},
    {x: 0.18, y: 0.76}
  ];
  const swapped = [pink[1], pink[0], pink[3], pink[2]];
  assert.deepEqual(orderProjectorCorners(swapped).map(p => p.x), orderProjectorCorners(pink).map(p => p.x));
  const H = homographyFromNormalized(pink, 1, 1);
  const origin = applyHomography(H, pink[0].x, pink[0].y);
  assert.ok(Math.hypot(origin.x, origin.y) < 1.5, JSON.stringify(origin));
  const far = applyHomography(H, pink[2].x, pink[2].y);
  assert.ok(Math.hypot(far.x - CANVAS_W, far.y - CANVAS_H) < 1.5, JSON.stringify(far));
  const green = pink.map((p, i) => ({x: p.x, y: i < 2 ? p.y - 0.12 : p.y}));
  const Hg = homographyFromNormalized(green, 1, 1);
  const sticker = {x: 0.5, y: 0.55};
  const onPink = applyHomography(H, sticker.x, sticker.y);
  const onGreen = applyHomography(Hg, sticker.x, sticker.y);
  assert.ok(Math.hypot(onPink.x - onGreen.x, onPink.y - onGreen.y) > 20, 'green frame must not be the projector map');
  const camH = 0.04;
  const got = projectedStickerHeight(H, sticker.x, sticker.y, camH);
  const top = applyHomography(H, sticker.x, sticker.y - camH / 2);
  const bot = applyHomography(H, sticker.x, sticker.y + camH / 2);
  const expect = Math.hypot(bot.x - top.x, bot.y - top.y);
  assert.ok(Math.abs(got - expect) < 1e-6);
  assert.ok(got > 8 && got < CANVAS_H, 'projected height ' + got);
});

test('the scan fixture finds the two centre dancer stickers', { skip: !hasStudioFixtures }, () => {
  const {rgba, w, h} = readPng(join(dir, 'scan-zero-stickers-1109.png'));
  const quad = [
    {x: 0.16 * w, y: 0.28 * h},
    {x: 0.86 * w, y: 0.27 * h},
    {x: 0.88 * w, y: 0.78 * h},
    {x: 0.14 * w, y: 0.80 * h}
  ];
  const found = detectWhiteStickers(rgba, w, h, {quad});
  const centre = found.stickers.filter(s => s.x > w * 0.35 && s.x < w * 0.72 && s.y > h * 0.42 && s.y < h * 0.68);
  assert.ok(centre.length >= 2, 'centre stickers ' + centre.length + ' of ' + found.stickers.length);
});

test('difference imaging drops room light, and a bad aspect keeps locked corners', () => {
  const on = new Uint8ClampedArray(16);
  const off = new Uint8ClampedArray(16);
  on.set([200, 40, 40, 255, 180, 160, 120, 255, 10, 10, 10, 255, 30, 200, 160, 255]);
  off.set([20, 10, 10, 255, 180, 160, 120, 255, 10, 10, 10, 255, 20, 20, 20, 255]);
  const diff = differenceImage(on, off);
  assert.ok(diff[0] > 100, 'changed pixel stays');
  assert.equal(diff[4], 0, 'unchanged room light is black');
  const previous = [
    {x: 0.12, y: 0.16}, {x: 0.88, y: 0.16},
    {x: 0.88, y: 0.84}, {x: 0.12, y: 0.84}
  ];
  const flat = [
    {x: 0.08, y: 0.40}, {x: 0.92, y: 0.40},
    {x: 0.92, y: 0.52}, {x: 0.08, y: 0.52}
  ];
  const kept = chooseAlignQuad({
    markers: {corners: flat, found: [true, true, true, true], reason: ''},
    previous,
    ambientHot: true,
    locked: true,
    videoAspect: 4 / 3
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.source, 'locked');
  assert.match(kept.warning, /locked corners/i);
  assert.deepEqual(kept.corners, previous);
  const stats = {scanCount: 0, rawCount: 0};
  noteScanSample(stats, 4);
  assert.equal(stats.scanCount, 1);
  assert.equal(stats.rawCount, 4);
});
