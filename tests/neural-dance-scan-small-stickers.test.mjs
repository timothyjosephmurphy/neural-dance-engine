// Nov 9, 8:12 PM rig (live edd1ed1): after re-Align, Scan stickers found 2 of
// 3. At this phone distance each sticker is ~3x6 to 3x9 px on the 480x360
// detect grid, so the 0.35 aspect gate dropped a whole upright sticker on
// one pixel of rounding (3x9 = 0.33, 2x6 = 0.33), and a sticker that split
// head/body became two dancers 22 stage px apart. Fixtures are white-flash
// camera crops from the live debug feed (x 140-320, y 140-250).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {detectBlankStickers, mergeScanPoints, SCAN_SPLIT_MERGE, tinyStickerAspect} from '../neural-dance/src/blank-scan.js';

// Minimal PNG (8-bit RGB/RGBA, non-interlaced) to RGBA.
function readPng(path) {
  const buf = readFileSync(path);
  let off = 8; let w = 0; let h = 0; let ct = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = new Uint8Array(w * bpp); const cur = new Uint8Array(w * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * bpp + 1)];
    const row = raw.subarray(y * (w * bpp + 1) + 1, (y + 1) * (w * bpp + 1));
    for (let i = 0; i < w * bpp; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255;
    }
    prev.set(cur);
  }
  return {data: out, width: w, height: h};
}

// Sticker centers in crop px (camera 240,175 / 184,203 / 271,205 minus 140,140).
const STICKERS = [{x: 101, y: 35}, {x: 44, y: 63}, {x: 131, y: 65}];

for (const id of ['0034', '0029']) {
  test('white scan at the far phone finds all 3 stickers (frame ' + id + ')', () => {
    const png = readPng(new URL('./fixtures/scan-white-far-' + id + '.png', import.meta.url));
    const blobs = detectBlankStickers(png.data, png.width, png.height, {mode: 'white', sensitivity: 1});
    for (const s of STICKERS) {
      assert.ok(blobs.some(b => Math.hypot(b.x - s.x, b.y - s.y) < 5), 'missed sticker at ' + s.x + ',' + s.y + ' got ' + JSON.stringify(blobs.map(b => [Math.round(b.x), Math.round(b.y), b.area])));
    }
    assert.equal(blobs.length, 3);
  });
}

test('tiny blobs get one pixel of aspect slack; lines and big blobs do not', () => {
  assert.ok(tinyStickerAspect(3, 9) >= 0.35);
  assert.ok(tinyStickerAspect(2, 6) >= 0.35);
  assert.ok(tinyStickerAspect(9, 3) <= 2.6);
  assert.ok(tinyStickerAspect(1, 8) < 0.35);
  assert.equal(tinyStickerAspect(10, 40), 0.25);
  assert.equal(tinyStickerAspect(5, 5), 1);
});

test('a sticker split head/body on the scan merges to one; neighbours stay apart', () => {
  const merged = mergeScanPoints([{x: 569, y: 291}, {x: 573, y: 313}, {x: 502, y: 191}, {x: 378, y: 289}], SCAN_SPLIT_MERGE);
  assert.equal(merged.length, 3);
  assert.ok(SCAN_SPLIT_MERGE < 90);
});
