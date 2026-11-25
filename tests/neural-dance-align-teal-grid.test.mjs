// Nov 9, 8:47 PM rig (live 1710e55): Align kept refusing or landing off.
// Real camera frames from the live debug feed: settled white phase and the
// marker phase. The white grid read faintly green on camera and joined the
// teal box into one big blob, so teal (2) was claimed off a grid crossing at
// (0.637, 0.492) instead of the box at (0.807, 0.428).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {alignFromFrame, chooseAlignQuad} from '../neural-dance/camera-markers.js';

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


function frame(name) {
  const png = readPng(new URL('./fixtures/align-2047-' + name + '.png', import.meta.url));
  return {...png, scale: {scaleX: 640 / 480, scaleY: 480 / 360, width: 480, height: 360}, videoWidth: 640, videoHeight: 480};
}

test('8:47 PM marker frame: all four circles land on their boxes', () => {
  const white = frame('white');
  const read = alignFromFrame(frame('markers'), white.data, {});
  assert.ok(read.corners, read.reason);
  const want = [[0.203, 0.423], [0.807, 0.428], [0.803, 0.736], [0.2, 0.726]];
  read.marks.forEach((m, i) => {
    assert.ok(Math.hypot(m.x - want[i][0], m.y - want[i][1]) < 0.02, 'circle ' + (i + 1) + ' at ' + m.x.toFixed(3) + ',' + m.y.toFixed(3));
  });
});

test('8:47 PM Align picks the marker quad matching the projected stage', () => {
  const read = alignFromFrame(frame('markers'), frame('white').data, {});
  const choice = chooseAlignQuad({markers: read, videoAspect: 4 / 3, stageAspect: 844 / 340});
  assert.equal(choice.ok, true, choice.reason);
  assert.equal(choice.source, 'markers');
  const stage = [[0.04, 0.34], [0.99, 0.34], [0.975, 0.83], [0.04, 0.81]];
  choice.corners.forEach((c, i) => assert.ok(Math.hypot(c.x - stage[i][0], c.y - stage[i][1]) < 0.03, 'corner ' + (i + 1)));
});
