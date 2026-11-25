// Frame + sticker fixtures from the live camera (TJ Nov 17).
// The green quad must stay on the light mat (not the cabinet or the outer
// wall) and both white figure stickers on the painting must be found.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {detectPaintingFrameSweep, quadEdgeClasses, createFrameSmoother, quadJumped, frameFallback, nearestHandle} from '../neural-dance/src/painting-frame.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {detectWhiteStickers} from '../neural-dance/src/white-stickers.js';
import {livePaintingLabel, livePersonLabel} from '../neural-dance/live-show.js';

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

function frameOf(name) {
  const {rgba, w, h} = readPng(join(dir, name));
  const found = detectPaintingFrameSweep(rgba, w, h);
  assert.equal(found.ok, true, name + ' ' + found.reason);
  const classes = quadEdgeClasses(rgba, w, h, found.quad);
  assert.equal(classes.some(c => c.kind === 'outside'), false, name + ' left the mat: ' + classes.map(c => c.kind).join(','));
  return {rgba, w, h, quad: found.quad, classes};
}

test('the four live frames stay on the mat, not the cabinet or the outer wall', { skip: !hasStudioFixtures }, () => {
  const shots = ['frame-detect.png', 'frame-left.png', 'frame-conflict.png', 'missed-right-sticker.png'].map(frameOf);
  for (const shot of shots) {
    const [tl, tr, br, bl] = shot.quad;
    assert.ok(tl.x > shot.w * 0.08 && bl.x > shot.w * 0.08, 'left edge is on the wall');
    assert.ok(tr.x < shot.w * 0.97 && br.x < shot.w * 0.97, 'right edge left the camera');
    assert.ok(tr.y > shot.h * 0.12 && tl.y > shot.h * 0.05, 'top edge is in the cabinet');
    assert.ok(br.y > tr.y && bl.y > tl.y, 'the quad is upside down');
  }
  // The right side of the painting sits lower in the picture than the left.
  // A flat top climbs into the cabinet above that corner.
  const sticker = shots[3];
  assert.ok(sticker.quad[1].y > sticker.quad[0].y + 40, 'top-right should follow the mat down, not up into the cabinet');
});

test('both white figure stickers are found; the dimmer one on the right is not dropped', { skip: !hasStudioFixtures }, () => {
  const {rgba, w, h, quad} = frameOf('missed-right-sticker.png');
  const dw = 480, dh = Math.round(h * 480 / w);
  const small = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const X = Math.min(w - 1, ((x + 0.5) * w / dw) | 0);
    const Y = Math.min(h - 1, ((y + 0.5) * h / dh) | 0);
    const s = (Y * w + X) * 4, d = (y * dw + x) * 4;
    small[d] = rgba[s]; small[d + 1] = rgba[s + 1]; small[d + 2] = rgba[s + 2]; small[d + 3] = 255;
  }
  const sx = dw / w, sy = dh / h;
  const found = detectWhiteStickers(small, dw, dh, {quad: quad.map(p => ({x: p.x * sx, y: p.y * sy}))});
  const hit = (x, y) => found.stickers.some(s => Math.hypot(s.x / sx - x, s.y / sy - y) < 45);
  assert.equal(hit(340, 410), true, 'left sticker missing ' + JSON.stringify(found.stickers));
  assert.equal(hit(570, 440), true, 'right sticker missing ' + JSON.stringify(found.stickers));
});

test('a jumped quad is held, and a steady one is smoothed', { skip: !hasStudioFixtures }, () => {
  const smooth = createFrameSmoother();
  const a = [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.8, y: 0.8}, {x: 0.2, y: 0.8}];
  assert.deepEqual(smooth.push(a), a);
  const jump = [{x: 0.05, y: 0.05}, {x: 0.95, y: 0.05}, {x: 0.95, y: 0.95}, {x: 0.05, y: 0.95}];
  assert.equal(quadJumped(a, jump), true);
  assert.deepEqual(smooth.push(jump), a);
  const nudge = a.map(p => ({x: p.x + 0.01, y: p.y}));
  const next = smooth.push(nudge);
  assert.ok(next[0].x > a[0].x && next[0].x < nudge[0].x);
});

test('a rejected frame falls back to the manual lock, then last good, then an expanded projector quad', { skip: !hasStudioFixtures }, () => {
  const last = [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.25}, {x: 0.78, y: 0.7}, {x: 0.22, y: 0.72}];
  const manual = last.map(p => ({x: p.x + 0.02, y: p.y}));
  const proj = [{x: 0.35, y: 0.35}, {x: 0.65, y: 0.35}, {x: 0.66, y: 0.6}, {x: 0.34, y: 0.6}];
  assert.equal(frameFallback({lastGood: last, manual, proj}).source, 'manual frame lock');
  assert.equal(frameFallback({lastGood: last, proj}).source, 'last good frame');
  assert.equal(frameFallback({manual, proj}).source, 'manual frame lock');
  const fb = frameFallback({proj});
  assert.equal(fb.source, 'projector quad');
  assert.ok(fb.quad[0].x < proj[0].x && fb.quad[1].x > proj[1].x, 'projector quad is expanded');
  const store = {mem: new Map(), getItem(k) { return this.mem.has(k) ? this.mem.get(k) : null; }, setItem(k, v) { this.mem.set(k, String(v)); }, removeItem(k) { this.mem.delete(k); }};
  const session = createPaintingSession({storage: store});
  assert.equal(session.lockFrame(manual), true);
  const blocked = session.detect({data: new Uint8ClampedArray(16), width: 2, height: 2});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.fallback, 'manual frame lock');
  assert.equal(session.frameLocked(), true);
  assert.equal(session.scanQuad()[0].x, manual[0].x);
  session.unlockFrame();
  assert.equal(session.frameLocked(), false);
  assert.match(readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8'), /Frame: manual \(locked\)/);
  assert.match(readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8'), /Frame: manual \(locked\)/);
});

test('the nearer handle wins, and a green corner is not the pink one', { skip: !hasStudioFixtures }, () => {
  const pink = [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.8, y: 0.8}, {x: 0.2, y: 0.8}];
  const green = [{x: 0.3, y: 0.3}, {x: 0.7, y: 0.3}, {x: 0.7, y: 0.7}, {x: 0.3, y: 0.7}];
  const groups = [{kind: 'proj', handles: pink}, {kind: 'frame', handles: green}];
  assert.deepEqual(nearestHandle({x: 0.31, y: 0.31}, groups, 0.08), {kind: 'frame', index: 0});
  assert.deepEqual(nearestHandle({x: 0.19, y: 0.2}, groups, 0.08), {kind: 'proj', index: 0});
  assert.equal(nearestHandle({x: 0.5, y: 0.5}, groups, 0.08), null);
  const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(viewer, /fillText\('F' \+ \(index \+ 1\)/);
  assert.match(viewer, /frameLock: 'set'/);
  assert.match(cam, /fillText\('F' \+ \(i \+ 1\)/);
  assert.match(cam, /painting\.lockFrame\(next\)/);
  assert.match(cam, /painting\.lockFrame\(patch\.frameQuad\)/);
});

test('the cabinet photo does not keep a border-inward ring that misses the mat', { skip: !hasStudioFixtures }, () => {
  const {rgba, w, h} = readPng(join(dir, 'camera-frame-cabinet-0959.png'));
  const found = detectPaintingFrameSweep(rgba, w, h);
  assert.equal(found.ok, false, found.reason);
  assert.equal(found.reason, 'no mat band');
  const proj = [{x: 0.18, y: 0.32}, {x: 0.82, y: 0.36}, {x: 0.84, y: 0.78}, {x: 0.16, y: 0.76}];
  const fb = frameFallback({proj});
  assert.equal(fb.source, 'projector quad');
  const session = createPaintingSession();
  const result = session.detect({data: rgba, width: w, height: h}, {proj});
  assert.equal(result.ok, false);
  assert.equal(result.fallback, 'projector quad');
  const zone = session.scanQuad().map(p => ({x: p.x * w, y: p.y * h}));
  const stickers = detectWhiteStickers(rgba, w, h, {quad: zone});
  assert.ok(stickers.stickers.length >= 2, 'fallback region found ' + stickers.stickers.length);
});

test('live and debug status name the frame confidence, sticker count, and person pause', { skip: !hasStudioFixtures }, () => {
  assert.equal(livePaintingLabel({active: true, reference: {ready: true}}), 'Painting: on · bare learned');
  assert.equal(livePaintingLabel({active: true, reference: {ready: true}, confidence: 0.8, latched: [{}, {}]}), 'Painting: on · bare learned · frame 80% · stickers: 2 (latched)');
  assert.equal(livePersonLabel({paused: true, note: 'person in frame, detection paused'}), 'Person: paused · person in frame, detection paused');
  assert.equal(livePersonLabel({settling: true}), 'Person: resuming');
  const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(live, /data-live-painting/);
  assert.match(live, /data-live-person/);
  assert.match(debug, /data-debug-person/);
  const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /Frame/);
  assert.match(viewer, /Projector/);
});
