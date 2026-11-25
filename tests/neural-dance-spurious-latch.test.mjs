// Hotfix: break project→detect latch chains (TJ 4:34–4:38 PM).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  CANVAS_H,
  CANVAS_W,
  ECHO_H,
  ECHO_W,
  NEAR_LATCH_GAP,
  UI_EXCLUSION_SELECTORS,
  createStageEcho,
  nearProjectedSims,
  rippleEnergyByte
} from '../neural-dance/camera-markers.js';
import {PLAY_EDGE_INSET, PLAY_MARGIN, stickerInPlay} from '../neural-dance/src/align-anchors.js';
import {CONTINUOUS_AUTO_LATCHED_MISSES, CONTINUOUS_HITS, CONTINUOUS_LATCHED_MISSES, CONTINUOUS_MISSES, createScanBook, mergeScanPoints} from '../neural-dance/src/blank-scan.js';
import {combineDancerStickers, DANCER_CAP, markerStickerId} from '../neural-dance/room-lab.js';
import {FLASH_FADE_MS} from '../neural-dance/src/sticker-flash.js';

const cameraJs = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
const roomJs = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
const showJs = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
const flashJs = readFileSync(new URL('../neural-dance/src/sticker-flash.js', import.meta.url), 'utf8');

test('continuous path composites the ripple layer into the stage echo', () => {
  assert.match(cameraJs, /data-ripple-layer/);
  assert.match(cameraJs, /globalCompositeOperation = 'lighter'/);
});

test('play edge inset rejects blobs near the quad edge; scan can use zero inset', () => {
  assert.ok(PLAY_EDGE_INSET >= 0.04);
  // A point near the lower-right of the align-circle play rect.
  const right = (0.82 + PLAY_MARGIN - 0.01) * CANVAS_W;
  const bottom = (0.82 + PLAY_MARGIN - 0.01) * CANVAS_H;
  assert.equal(stickerInPlay(right, bottom, [], undefined, {edgeInset: 0}), true);
  assert.equal(stickerInPlay(right, bottom, [], undefined, {edgeInset: PLAY_EDGE_INSET}), false);
});

test('build pill and live chrome are masked; corner pad is always present', () => {
  assert.ok(UI_EXCLUSION_SELECTORS.includes('[data-nd-build]'));
  assert.match(cameraJs, /CANVAS_W \* 0\.78/);
  assert.match(cameraJs, /CANVAS_H \* 0\.82/);
  assert.match(cameraJs, /data-nd-build/);
});

test('new continuous latches keep ~1.5 dancer widths from existing ones', () => {
  assert.ok(NEAR_LATCH_GAP >= 80);
  assert.match(cameraJs, /NEAR_LATCH_GAP/);
  assert.match(cameraJs, /nearKnownSticker\(at\.x, at\.y, NEAR_LATCH_GAP\)/);
});

test('elongated slash shapes are rejected by continuous blob detect', () => {
  assert.match(cameraJs, /elong > 4\.2/);
  assert.match(cameraJs, /aspect < 0\.35 \|\| aspect > 2\.6/);
});

test('continuous latch never calls clearSim; sims are vetoed and preferred in the dancer merge', () => {
  assert.doesNotMatch(cameraJs, /nd\.clearSim\(\)/);
  assert.match(cameraJs, /nearSimDancer/);
  assert.match(cameraJs, /nearProjectedSims/);
  assert.match(cameraJs, /ndStickerScan/);
  assert.match(roomJs, /Sims first so a sticker latch never displaces/);
  const sims = Array.from({length: 24}, (_, i) => ({id: i + 1, x: 100 + (i % 6) * 120, y: 100 + Math.floor(i / 6) * 100, type: i % 4}));
  const marks = Array.from({length: 30}, (_, i) => ({id: i + 1, x: 50 + i * 10, y: 50, type: 0, kind: 'sticker'}));
  const merged = combineDancerStickers(sims, marks, DANCER_CAP);
  assert.equal(merged.filter(d => d.kind === 'sim').length, 24, 'all 24 sims retained');
  assert.ok(merged.filter(d => d.kind === 'sticker').length <= DANCER_CAP - 24);
  assert.equal(merged.find(d => d.id === 1).kind, 'sim');
  assert.equal(nearProjectedSims(100, 100, sims), true);
  assert.equal(nearProjectedSims(900, 500, sims), false);
});

test('seed 24 sims for 30 s of frames: 0 new stickers, 24 sims retained', () => {
  // Seed layout mirrors prototypePositions RNG.
  let seed = 0x5eed;
  const rand = () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const CX = 500, CY = 310, SX = 1.18, SY = 0.72;
  const sims = [];
  for (let i = 0; i < 24; i++) {
    const a = rand() * Math.PI * 2;
    const r = 50 + rand() * 260;
    sims.push({id: i + 1, x: CX + Math.cos(a) * r * SX * 0.94, y: CY + Math.sin(a) * r * SY * 0.94, type: i % 4});
  }
  assert.equal(sims.length, 24);

  // Paint bright sim silhouettes into the stage echo (what the camera sees projected).
  const rgb = new Uint8Array(ECHO_W * ECHO_H * 3);
  for (const d of sims) {
    const cx = Math.max(0, Math.min(ECHO_W - 1, Math.round(d.x / CANVAS_W * (ECHO_W - 1))));
    const cy = Math.max(0, Math.min(ECHO_H - 1, Math.round(d.y / CANVAS_H * (ECHO_H - 1))));
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= ECHO_W || y >= ECHO_H) continue;
        const o = (y * ECHO_W + x) * 3;
        rgb[o] = 210; rgb[o + 1] = 200; rgb[o + 2] = 170;
      }
    }
  }

  const echo = createStageEcho();
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, latchedMisses: CONTINUOUS_LATCHED_MISSES});
  let everLatched = 0;
  // 30 s at 100 ms detects = 300 frames. Candidates sit on every sim (the bug).
  for (let now = 0; now <= 30000; now += 100) {
    echo.ingest(rgb, now);
    const points = [];
    for (const d of sims) {
      // Echo veto + explicit sim proximity both refuse a new latch.
      if (echo.vetoSticker(d.x, d.y, 10)) continue;
      if (nearProjectedSims(d.x, d.y, sims, NEAR_LATCH_GAP)) continue;
      points.push({x: d.x, y: d.y, kind: 'sticker'});
    }
    // Also throw a few corner glare candidates like the live bug.
    for (const glare of [{x: 900, y: 560}, {x: 860, y: 540}, {x: 80, y: 80}]) {
      if (echo.vetoSticker(glare.x, glare.y, 10)) continue;
      if (nearProjectedSims(glare.x, glare.y, sims, NEAR_LATCH_GAP)) continue;
      if (!stickerInPlay(glare.x, glare.y, [], undefined, {edgeInset: PLAY_EDGE_INSET})) continue;
      points.push({...glare, kind: 'sticker'});
    }
    const markers = book.observe(mergeScanPoints(points, 48));
    everLatched = Math.max(everLatched, markers.length);
  }
  assert.equal(everLatched, 0, 'no sticker latched over 30 s with 24 projected sims');
  assert.equal(book.markers().length, 0);
  // Sims themselves stay in the dancer merge even if stickers somehow arrived.
  const fakeStickers = Array.from({length: 10}, (_, i) => ({id: i + 1, x: 40 + i * 20, y: 40, type: 0, kind: 'sticker'}));
  const merged = combineDancerStickers(sims, fakeStickers);
  assert.equal(merged.filter(d => d.kind === 'sim').length, 24);
  assert.equal(merged.filter(d => d.id === markerStickerId(1)).length, 1);
});

test('Scan stickers fades ~120 ms in and out; continuous is gated by ndStickerScan', () => {
  assert.equal(FLASH_FADE_MS, 120);
  assert.match(flashJs, /FLASH_FADE_MS = 120/);
  assert.match(flashJs, /fadeFlash/);
  assert.match(flashJs, /fading-in/);
  assert.match(showJs, /ndStickerScan/);
  assert.match(showJs, /style\.opacity/);
  assert.match(cameraJs, /stickerScanHoldActive/);
  assert.match(cameraJs, /ndStickerScan/);
});

test('Align from debug keeps messages off the projector; refusals keep the last good quad', () => {
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(debug, /beginAlign\(doc, \{fromDebug: true\}\)/);
  assert.match(debug, /scanStickersNow\(doc, \{fromDebug: true\}\)/);
  assert.match(show, /nd-align-from-debug/);
  assert.match(show, /keepLastGood/);
  assert.match(show, /markerBaseline/);
  assert.match(show, /ambientHot/);
  assert.match(show, /plausibleAlignQuad|chooseAlignQuad\(\{[^}]*ambientHot/);
  assert.match(cameraJs, /plausibleAlignQuad/);
  assert.match(cameraJs, /calibrationBlobOnBorder/);
  assert.match(cameraJs, /Align failed: too bright/);
});

function paintRing(rgb, cx, cy, r0, r1, color) {
  const [R, G, B] = color;
  for (let y = 0; y < ECHO_H; y++) {
    for (let x = 0; x < ECHO_W; x++) {
      const sx = x / (ECHO_W - 1) * CANVAS_W;
      const sy = y / (ECHO_H - 1) * CANVAS_H;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < r0 || d > r1) continue;
      const o = (y * ECHO_W + x) * 3;
      rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
    }
  }
}

test('dim purple ripple rings veto sticker candidates, including the dark trough', () => {
  const echo = createStageEcho();
  const stage = new Uint8Array(ECHO_W * ECHO_H * 3); // dark floor, no grid even
  const ripple = new Uint8Array(ECHO_W * ECHO_H * 3);
  // Dim purple caustic like the live camera (lum well under the old 22/72 cuts
  // once downsampled, and not "grid-like" but easy to miss in the composite).
  paintRing(ripple, 500, 310, 40, 70, [48, 24, 72]);
  paintRing(ripple, 500, 310, 90, 120, [40, 20, 64]);
  echo.ingest(stage, 0, ripple);
  // Center of the rings — the dark trough the camera reads as a sticker.
  assert.equal(echo.vetoSticker(500, 310), true);
  assert.equal(echo.veto(500, 310), true);
  // On the ring itself.
  assert.equal(echo.vetoSticker(500 + 55, 310), true);
  // Far from the rings, empty floor is still open for a real sticker.
  assert.equal(echo.vetoSticker(80, 80), false);
  assert.ok(rippleEnergyByte(48, 24, 72) >= 6);
});

test('stage-only dim floor without a ripple plane still leaves empty floor open', () => {
  const echo = createStageEcho();
  const stage = new Uint8Array(ECHO_W * ECHO_H * 3);
  echo.ingest(stage, 0);
  assert.equal(echo.vetoSticker(500, 310), false);
});

test('auto-latched stickers expire after a few seconds of misses; Scan stickers stay', () => {
  const book = createScanBook({
    hits: CONTINUOUS_HITS,
    misses: CONTINUOUS_MISSES,
    latchedMisses: 1e9,
    autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES
  });
  for (let i = 0; i < CONTINUOUS_HITS; i++) book.observe([{x: 400, y: 300, kind: 'sticker'}]);
  assert.equal(book.markers().length, 1);
  assert.equal(book.markers()[0].scanned, false);
  for (let i = 0; i < CONTINUOUS_AUTO_LATCHED_MISSES - 1; i++) book.observe([]);
  assert.equal(book.markers().length, 1, 'still inside the grace window');
  book.observe([]);
  assert.equal(book.markers().length, 0, 'ghost without a sticker expires');

  const scanned = createScanBook({
    hits: CONTINUOUS_HITS,
    misses: CONTINUOUS_MISSES,
    latchedMisses: 1e9,
    autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES
  });
  scanned.restore([{x: 400, y: 300, kind: 'sticker', id: 1}]);
  assert.equal(scanned.markers()[0].scanned, true);
  for (let i = 0; i < 200; i++) scanned.observe([]);
  assert.equal(scanned.markers().length, 1, 'Scan-placed sticker is not dropped when its own glow hides it');
});

test('after Scan stickers, continuous detect cannot add a new dancer', () => {
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES});
  book.restore([
    {id: 1, x: 565, y: 310, kind: 'sticker'},
    {id: 2, x: 390, y: 307, kind: 'sticker'},
    {id: 3, x: 782, y: 278, kind: 'sticker'}
  ]);
  for (let i = 0; i < 50; i++) {
    book.observe([
      {x: 565, y: 310, kind: 'sticker'},
      {x: 390, y: 307, kind: 'sticker'},
      {x: 782, y: 278, kind: 'sticker'},
      {x: 242, y: 113, kind: 'sticker'},
      {x: 537, y: 157, kind: 'sticker'}
    ], {allowNew: false});
  }
  assert.equal(book.markers().length, 3);
  const xs = book.markers().map(m => Math.round(m.x)).sort((a, b) => a - b);
  assert.deepEqual(xs, [390, 565, 782]);
});

test('a stable painting sticker can open a track; a floor hit still cannot', () => {
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES});
  const painting = {x: 200, y: 80, kind: 'sticker'};
  const floor = {x: 500, y: 400, kind: 'sticker'};
  book.observe([painting, floor], {
    allowNew: false,
    latchNew: true,
    allowPoint: (spot) => Math.hypot(spot.x - painting.x, spot.y - painting.y) <= 48
  });
  assert.equal(book.markers().length, 1, 'the painting hit latches; the floor hit does not');
  assert.ok(Math.hypot(book.markers()[0].x - painting.x, book.markers()[0].y - painting.y) < 1);
});

test('Scan stickers becomes the authority; ripple layer is searched on the projector host', () => {
  assert.match(cameraJs, /allowNew: false/);
  assert.match(cameraJs, /CONTINUOUS_AUTO_LATCHED_MISSES/);
  assert.match(cameraJs, /findRippleLayer/);
  assert.match(cameraJs, /scannedOnly/);
});

// TJ 10:03 AM Nov 10: live dancers popped up, moved a little, and vanished
// every ~5 s. Continuous-detected stickers expired after 30 misses while
// their own projected dancer hid them from the camera, then re-latched once
// the stage went dark. Self-occluded frames must not count as misses.
test('a latched sticker hidden by its own projected dancer is not dropped', () => {
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, latchedMisses: 1e9, autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES});
  for (let i = 0; i < CONTINUOUS_HITS; i++) book.observe([{x: 400, y: 300, kind: 'sticker'}]);
  assert.equal(book.markers().length, 1);
  const id = book.markers()[0].id;
  // 5 minutes of 100 ms frames with the dancer lit over the sticker.
  for (let i = 0; i < 3000; i++) book.observe([], {covered: (x, y) => Math.hypot(x - 400, y - 300) < 60});
  assert.equal(book.markers().length, 1, 'kept under its own glow');
  assert.equal(book.markers()[0].id, id, 'same dancer id (no re-latch flicker)');
  // A ghost on a dark stage still expires.
  for (let i = 0; i < CONTINUOUS_AUTO_LATCHED_MISSES; i++) book.observe([], {covered: () => false});
  assert.equal(book.markers().length, 0, 'expires once the stage over it is dark and it is gone');
  // A throwing predicate cannot crash detection.
  const b2 = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES});
  for (let i = 0; i < CONTINUOUS_HITS; i++) b2.observe([{x: 10, y: 10, kind: 'sticker'}]);
  assert.doesNotThrow(() => b2.observe([], {covered: () => { throw new Error('x'); }}));
});

test('continuous detection passes the self-occlusion check from the stage echo', () => {
  assert.match(cameraJs, /covered: \(x, y\) => cam\.echo\.veto\(x, y\) \|\| cam\.echo\.vetoSticker\(x, y, 10\)/);
});
