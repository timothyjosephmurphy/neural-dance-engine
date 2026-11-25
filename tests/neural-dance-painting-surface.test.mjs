// Painting surface (TJ Nov 11 3:41-3:51 PM): static-content person gate,
// manual taps that never toggle off, Clear keeps hand-placed markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStaticBackground, personInFrame} from '../neural-dance/src/person-occlusion.js';
import {createManualStickers, resolveStageTap, mergeLatchedStickers} from '../neural-dance/src/debug-manual-stickers.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'tests/fixtures/painting');
const hasWhiteStickers = existsSync(join(fixture, 'white-stickers.rgb.gz'));
const hasPaintingPpm = existsSync(join(fixture, '155432-camera-FLASH.ppm'));
const read = p => readFileSync(join(root, p), 'utf8');

// Synthetic stage: grey wall with a dark "painting" block (static), optional person.
function scene({w = 160, h = 120, person = null, gain = 1} = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 125;
    if (x >= 30 && x < 130 && y >= 20 && y < 90) v = y < 50 ? 120 : 28; // light sky / dark ground
    if ((x >= 28 && x < 32) || (x >= 128 && x < 132)) if (y >= 18 && y < 92) v = 15; // frame
    let r = v, g = v, b = v * 0.95;
    if (person && x >= person.x && x < person.x + person.w && y >= person.y && y < person.y + person.h) { r = 40; g = 36; b = 34; }
    const i = (y * w + x) * 4;
    px[i] = Math.min(255, r * gain); px[i + 1] = Math.min(255, g * gain); px[i + 2] = Math.min(255, b * gain); px[i + 3] = 255;
  }
  return {px, w, h};
}

test('a static dark painting is not a person once the background is learned; a person still is', () => {
  const bg = createStaticBackground();
  const empty = scene();
  const before = personInFrame(empty.px, empty.w, empty.h, {step: 2});
  assert.equal(before.present, true, 'without the reference the dark painting reads as a large occluder (old false positive)');
  for (let i = 0; i < 8; i++) { const r = personInFrame(empty.px, empty.w, empty.h, {step: 2, background: bg}); bg.update(r.cells, r.cols, r.rows); }
  assert.equal(bg.ready(), true);
  const after = personInFrame(empty.px, empty.w, empty.h, {step: 2, background: bg});
  assert.equal(after.present, false);
  assert.equal(after.holding, false);
  assert.ok(after.staticFraction > 0.8);
  // Brighter room (projector / lamps): normalised reference still matches.
  const bright = scene({gain: 1.3});
  assert.equal(personInFrame(bright.px, bright.w, bright.h, {step: 2, background: bg}).present, false);
  // A person standing in front of the wall and the painting.
  const tj = scene({person: {x: 60, y: 10, w: 34, h: 110}});
  const seen = personInFrame(tj.px, tj.w, tj.h, {step: 2, background: bg});
  assert.equal(seen.present, true);
});

test('recorded painting frames: main false-positive is gone, TJ in frame is caught', {skip: !existsSync(join(fixture, 'person-replay.json'))}, () => {
  const rows = JSON.parse(readFileSync(join(fixture, 'person-replay.json'), 'utf8'));
  for (const r of rows) assert.equal(r.present, r.expect, r.t + ' expected ' + r.expect);
});

test('camera wiring: learner seeded, only learns while clear, reset on alignment', () => {
  const cam = read('neural-dance/camera-markers.js');
  assert.match(cam, /cam\.personBackground = createStaticBackground\(\)/);
  assert.match(cam, /background: cam\.personBackground/);
  assert.match(cam, /cam\.personBackground\.update\(person\.cells, person\.cols, person\.rows, \{clear: !decision\.paused && !person\.holding, now, global: !!person\.globalChange\}\)/);
  assert.match(cam, /homographyFromNormalized\(cam\.committed[^\n]*\n\s*cam\.personBackground\.reset\(\)/);
});

test('a plain tap never removes a manual marker; long-press / remove mode does', () => {
  const book = createManualStickers();
  book.apply(resolveStageTap([], 300, 200));
  const list = book.list();
  assert.equal(list.length, 1);
  // Second tap on the same sticker: moves it, never removes or duplicates.
  const again = resolveStageTap(list, 304, 203);
  assert.equal(again.action, 'add-manual-sticker');
  book.apply(again);
  assert.equal(book.list().length, 1);
  assert.equal(book.list()[0].x, 304);
  const rm = resolveStageTap(book.list(), 304, 203, undefined, {remove: true});
  assert.equal(rm.action, 'remove-manual-sticker');
  book.apply(rm);
  assert.equal(book.list().length, 0);
  const viewer = read('neural-dance/debug-viewer.js');
  // Viewer: removal only via an explicit gesture (long-press / X / Remove mode).
  assert.match(viewer, /createDancerGesture\(\)/);
  assert.match(viewer, /intent\.type === 'ask-remove'/);
  assert.match(read('neural-dance/src/debug-manual-dancers.js'), /LONG_PRESS_MS = 600/);
});

test('manual markers survive auto re-latching and Clear auto markers', () => {
  const manual = [{id: 500003, x: 551, y: 337, kind: 'sticker', manual: true}];
  const auto = [{id: 27, x: 743, y: 171, kind: 'sticker'}, {id: 28, x: 273, y: 216, kind: 'sticker'}];
  const merged = mergeLatchedStickers(auto, manual);
  assert.ok(merged.some(m => m.id === 500003 && m.manual));
  const near = mergeLatchedStickers([{id: 31, x: 560, y: 340, kind: 'sticker'}], manual);
  assert.equal(near.length, 1, 'tap near an auto marker replaces it');
  assert.equal(near[0].id, 500003);
  const cam = read('neural-dance/camera-markers.js');
  assert.match(cam, /function forgetLatchedMarkersCam\(cam, \{manual = false\} = \{\}\) \{\n\s*if \(manual\) cam\.manuals\.clear\(\);/);
  assert.match(cam, /command\.action === 'clear-manual-markers'[\s\S]{0,80}forgetLatchedMarkers\(\{manual: true\}\)/);
  assert.equal(sanitizeDebugPatch({action: 'clear-manual-markers'}).action, 'clear-manual-markers');
  const page = read('src/pages/neural-dance/debug/index.astro');
  assert.match(page, /data-debug-clear-manual/);
  assert.match(page, /data-debug-remove-mode/);
  assert.match(read('neural-dance/debug-viewer.js'), /Tap again to remove hand-placed markers/);
});

// ---- White stickers on the painting (TJ 4:06 PM gate) ----------------------
// Labelled positives: white-on-light, white-on-dark (pass 0), the sticker at
// the '233' spot (pass 3). Confirmed negatives: the seven live auto markers
// TJ rejected at 4:06 PM (232-257, all dark paint). Every positive must latch
// on every scored frame, and nothing may latch at a negative.
test('white-sticker gate: all labelled positives latch, zero markers at confirmed negatives', { skip: !hasWhiteStickers }, async () => {
  const {gunzipSync} = await import('node:zlib');
  const {detectWhiteStickers, createWhiteStickerTracker, scoreWhiteStickers} = await import('../neural-dance/src/white-stickers.js');
  const meta = JSON.parse(readFileSync(join(fixture, 'white-stickers.json'), 'utf8'));
  const blob = gunzipSync(readFileSync(join(fixture, 'white-stickers.rgb.gz')));
  const W = 480, H = 360, cw = meta.w, ch = meta.h;
  const frameAt = offset => {
    // Rebuild a full 480x360 frame (outside the crop stays black).
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = offset + (y * cw + x) * 3, d = ((y + meta.y0) * W + x + meta.x0) * 4;
      rgba[d] = blob[s]; rgba[d + 1] = blob[s + 1]; rgba[d + 2] = blob[s + 2]; rgba[d + 3] = 255;
    }
    return rgba;
  };
  const lumOf = px => { const o = new Float32Array(W * H); for (let i = 0; i < o.length; i++) o[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; return o; };
  for (const [name, set] of Object.entries(meta.sets)) {
    const refPx = frameAt(set.reference);
    const frame = {quad: set.quad};
    const ref = lumOf(refPx);
    const tracker = createWhiteStickerTracker();
    let scored = 0;
    set.frames.forEach((f, i) => {
      const r = detectWhiteStickers(frameAt(f.offset), W, H, {quad: frame.quad, reference: ref});
      assert.ok(r.ok);
      const latched = tracker.push(r.stickers);
      if (i < 5) return; // tracker warm-up (4 of 6 frames)
      const sc = scoreWhiteStickers(latched, set.positives, set.negatives);
      assert.deepEqual(sc.missed, [], `${name} ${f.src}: missed positives`);
      assert.deepEqual(sc.falseAt, [], `${name} ${f.src}: marker at a confirmed negative`);
      assert.deepEqual(sc.extra, [], `${name} ${f.src}: unlabelled latch`);
      scored++;
    });
    assert.ok(scored >= 4, `${name}: scored ${scored} frames`);
    // The bare reference against itself latches nothing.
    const self = detectWhiteStickers(refPx, W, H, {quad: frame.quad, reference: ref});
    assert.equal(self.stickers.length, 0, `${name}: bare painting vs itself`);
  }
});

test('white-sticker detector stays off the frame: nothing outside the inset painting quad', async () => {
  const {detectWhiteStickers} = await import('../neural-dance/src/white-stickers.js');
  const W = 160, H = 120, px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 30; px[i * 4 + 3] = 255; }
  const blob = (cx, cy) => { for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 2; x <= cx + 2; x++) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = 230; } };
  blob(80, 60); blob(12, 60); // one on the painting, one on the frame/label
  const quad = [{x: 20, y: 15}, {x: 140, y: 15}, {x: 140, y: 105}, {x: 20, y: 105}];
  const r = detectWhiteStickers(px, W, H, {quad});
  assert.equal(r.stickers.length, 1);
  assert.ok(Math.abs(r.stickers[0].x - 80) < 1.5 && Math.abs(r.stickers[0].y - 60) < 1.5);
});

// ---- Frame detection under the white flash (multi-threshold sweep) ---------
function readPpmSimple(path) {
  const raw = readFileSync(path);
  const head = raw.toString('ascii', 0, 32).split(/\s+/);
  assert.equal(head[0], 'P6');
  const w = +head[1], h = +head[2];
  const start = raw.length - w * h * 3, rgba = new Uint8ClampedArray(w * h * 4);
  for (let n = 0; n < w * h; n++) { rgba[n * 4] = raw[start + n * 3]; rgba[n * 4 + 1] = raw[start + n * 3 + 1]; rgba[n * 4 + 2] = raw[start + n * 3 + 2]; rgba[n * 4 + 3] = 255; }
  return {rgba, w, h};
}
test('painting frame found under the white flash and in show light, same quad (pass 3)', { skip: !hasPaintingPpm }, async () => {
  const {detectPaintingFrameSweep} = await import('../neural-dance/src/painting-frame.js');
  const meta = JSON.parse(readFileSync(join(fixture, 'white-stickers.json'), 'utf8'));
  const truth = meta.sets.pass3.quad;
  for (const name of ['155814-camera-FLASH.ppm', '155819-camera-ALIGN.ppm']) {
    const {rgba, w, h} = readPpmSimple(join(fixture, name));
    const r = detectPaintingFrameSweep(rgba, w, h);
    assert.ok(r.ok, name + ': ' + r.reason);
    r.quad.forEach((p, i) => assert.ok(Math.hypot(p.x - truth[i].x, p.y - truth[i].y) <= 10, `${name} corner ${i}: ${p.x.toFixed(1)},${p.y.toFixed(1)}`));
  }
  // Pass 2 (before TJ lowered the painting): found, and clearly higher.
  const {rgba, w, h} = readPpmSimple(join(fixture, '155432-camera-FLASH.ppm'));
  const r2 = detectPaintingFrameSweep(rgba, w, h);
  assert.ok(r2.ok);
  assert.ok(truth[0].y - r2.quad[0].y > 20, 'pass 2 frame sits above pass 3');
});

// ---- Painting session: Detect → Accept → learn bare painting → white latch ---
function memStore() { const m = new Map(); return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; }
test('painting session: accept learns the bare painting and live frames do not latch stickers', { skip: !hasWhiteStickers }, async () => {
  const {gunzipSync} = await import('node:zlib');
  const {createPaintingSession, REFERENCE_FRAMES} = await import('../neural-dance/src/painting-session.js');
  const meta = JSON.parse(readFileSync(join(fixture, 'white-stickers.json'), 'utf8'));
  const blob = gunzipSync(readFileSync(join(fixture, 'white-stickers.rgb.gz')));
  const W = 480, H = 360;
  const frameAt = offset => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < meta.h; y++) for (let x = 0; x < meta.w; x++) {
      const s = offset + (y * meta.w + x) * 3, d = ((y + meta.y0) * W + x + meta.x0) * 4;
      data[d] = blob[s]; data[d + 1] = blob[s + 1]; data[d + 2] = blob[s + 2]; data[d + 3] = 255;
    }
    return {data, width: W, height: H};
  };
  const set = meta.sets.pass3;
  const store = memStore();
  const session = createPaintingSession({storage: store});
  assert.equal(session.active(), false);
  assert.equal(session.darkDetectionAllowed(), true, 'dark detection unchanged off the painting');
  assert.ok(session.accept(set.quad.map(p => ({x: p.x / W, y: p.y / H}))));
  assert.equal(session.stickerColor(), 'white', 'Accept switches to white stickers');
  assert.equal(session.darkDetectionAllowed(), false, 'dark paint must not latch (TJ 4:06 PM)');
  const bare = frameAt(set.reference);
  // Person in frame / flash frames do not feed the reference.
  session.observe(bare, {blocked: true});
  session.observe(bare, {flashing: true});
  assert.equal(session.telemetry().reference.frames, 0);
  for (let i = 0; i < REFERENCE_FRAMES; i++) assert.deepEqual(session.observe(bare, {now: i}), []);
  assert.ok(session.referenceReady());
  let latched = [];
  for (const f of set.frames) latched = session.observe(frameAt(f.offset));
  assert.deepEqual(latched, []);
  assert.equal(session.telemetry().found, 0);
  session.setStickerColor('auto');
  assert.equal(session.darkDetectionAllowed(), false, 'auto still skips live detection on a frame');
  assert.deepEqual(session.observe(frameAt(set.frames[0].offset)), []);
  session.setStickerColor('white');
  // Show-light frames are not the white baseline, so a reload has to Relearn.
  const again = createPaintingSession({storage: store});
  assert.equal(again.active(), true);
  assert.equal(again.stickerColor(), 'white');
  assert.equal(again.referenceReady(), false);
  assert.equal(again.baselineReady(), false);
  again.clear();
  assert.equal(createPaintingSession({storage: store}).active(), false);
});

test('painting warp: projector footprint mapped onto the frame; uncovered top is reported', async () => {
  const {projectorWarpTarget, warpMatrix3d} = await import('../neural-dance/src/painting-frame.js');
  const proj = [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}];
  const frame = [{x: 0.3, y: 0.3}, {x: 0.7, y: 0.3}, {x: 0.7, y: 0.7}, {x: 0.3, y: 0.7}];
  const t = projectorWarpTarget(proj, frame, 1000, 620);
  assert.ok(Math.abs(t.target[0].x - 250) < 1e-6 && Math.abs(t.target[0].y - 155) < 1e-6);
  assert.equal(t.warning, '');
  assert.match(warpMatrix3d(t.target, 1000, 620), /^matrix3d\(/);
  const high = projectorWarpTarget(proj, [{x: 0.3, y: 0.05}, {x: 0.7, y: 0.05}, {x: 0.7, y: 0.7}, {x: 0.3, y: 0.7}], 1000, 620);
  assert.equal(high.short.top, true);
  assert.match(high.warning, /top/);
});

test('painting wiring: debug patches, white-flash over the painting, dark gate, ID tags hidden', () => {
  assert.deepEqual(sanitizeDebugPatch({action: 'frame-detect'}), {action: 'frame-detect'});
  assert.deepEqual(sanitizeDebugPatch({action: 'sticker-color', value: 'white'}), {action: 'sticker-color', value: 'white'});
  assert.equal(sanitizeDebugPatch({action: 'sticker-color', value: 'pink'}), null);
  const acc = sanitizeDebugPatch({action: 'frame-accept', quad: [{x: 0.1, y: 0.2}, {x: 0.9, y: 0.2}, {x: 0.9, y: 0.8}, {x: 9, y: 0.8}]});
  assert.equal(acc.quad[3].x, 1.15);
  const cam = readFileSync(join(root, 'neural-dance/camera-markers.js'), 'utf8');
  assert.match(cam, /cam\.painting\.darkDetectionAllowed\(\) \? cam\.collectContinuousStickers/);
  assert.match(cam, /tick\.flash === 'white' && cam\.painting\.active\(\) && paintingFlashLit\(cam\.paintingStats\(frame\)\)/);
  assert.match(cam, /layer\.style\.transform = m/);
  const sil = readFileSync(join(root, 'neural-dance/src/silhouette.js'), 'utf8');
  assert.match(sil, /if \(opts\.idTags !== false\) paintSmallText\(ctx, '#'/);
  const room = readFileSync(join(root, 'neural-dance/room-lab.js'), 'utf8');
  assert.match(room, /idTags:!\(document\.body&&document\.body\.classList\.contains\('nd-painting'\)\)/);
  const page = readFileSync(join(root, 'src/pages/neural-dance/debug/index.astro'), 'utf8');
  for (const sel of ['frame-detect', 'frame-retry', 'painting-reference', 'frame-clear', 'scan-stickers', 'snap-projector-frame']) assert.ok(page.includes(`data-debug-action="${sel}"`), sel);
  assert.match(page, /data-debug-corners-mode[^>]*aria-pressed="true"/);
  assert.equal(sanitizeDebugPatch({action: 'snap-projector-frame'}).action, 'snap-projector-frame');
  assert.ok(page.includes('data-debug-frame-accept') && page.includes('data-debug-corners-mode'));
});

// ---- Manual dancers: move by id, nonce ack, gesture intents (TJ 4:31 PM) ----
test('manual dancers: move by id, acked by nonce; gestures never remove on a plain tap', async () => {
  const {createDancerGesture, createAckTracker, hitCorner, stageToCamera, clientToCamera} = await import('../neural-dance/src/debug-manual-dancers.js');
  const book = createManualStickers();
  const a = book.apply({action: 'add-manual-sticker', x: 300, y: 200}).added;
  const b = book.apply({action: 'add-manual-sticker', x: 600, y: 300}).added;
  const mv = book.apply(sanitizeDebugPatch({action: 'move-manual-sticker', id: b.id, x: 640, y: 320, nonce: 'm1-a'}));
  assert.equal(mv.moved.id, b.id);
  assert.deepEqual(book.list().map(s => [s.id, s.x, s.y]), [[a.id, 300, 200], [b.id, 640, 320]]);
  assert.equal(sanitizeDebugPatch({action: 'move-manual-sticker', id: b.id, x: 1, y: 2, nonce: 'bad nonce!'}).nonce, undefined);
  assert.equal(sanitizeDebugPatch({action: 'add-manual-sticker', x: 1, y: 2, nonce: 'm1-b'}).nonce, 'm1-b');
  const g = createDancerGesture();
  const dancer = {kind: 'dancer', dancer: {id: a.id}};
  g.down({x: 10, y: 10}, dancer, 0); assert.equal(g.up({x: 11, y: 10}, 100).type, 'select');
  g.down({x: 10, y: 10}, dancer, 0); assert.equal(g.up({x: 10, y: 10}, 700).type, 'ask-remove');
  g.down({x: 10, y: 10}, dancer, 0); g.move({x: 40, y: 10}); assert.equal(g.up({x: 40, y: 10}, 100).type, 'move-dancer');
  g.down({x: 10, y: 10}, {kind: 'corner', index: 2}, 0); assert.equal(g.up({x: 12, y: 10}, 100).type, 'place', 'still tap near a corner places');
  g.down({x: 10, y: 10}, {kind: 'empty'}, 0); g.move({x: 60, y: 10}); assert.equal(g.up({x: 60, y: 10}, 100), null, 'slide on empty feed does nothing');
  const rect = {left: 0, top: 0, width: 400, height: 300};
  assert.equal(hitCorner([{x: 0.5, y: 0.5}], {x: 0.5 + 30 / 400, y: 0.5}, rect), -1, '30 px away is not a corner grab');
  assert.equal(hitCorner([{x: 0.5, y: 0.5}], {x: 0.5 + 20 / 400, y: 0.5}, rect), 0);
  assert.deepEqual(clientToCamera(200, 150, {left: 0, top: 0, width: 400, height: 300}), {x: 0.5, y: 0.5});
  const c = stageToCamera(500, 310, [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}]);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9 && Math.abs(c.y - 0.5) < 1e-9);
  const acks = createAckTracker({timeoutMs: 1000});
  acks.add({nonce: 'n1', action: 'add-manual-sticker', at: 0});
  acks.add({nonce: 'n2', action: 'add-manual-sticker', at: 0});
  const r = acks.update({manualAck: {nonce: 'n1', ok: true, id: 5}}, 10);
  assert.equal(r.acked[0].id, 5);
  assert.equal(acks.update(null, 2000).late.length, 1);
});

test('frame fit stops on the inner dark edge, not the last mat pixel inside the opening', async () => {
  const {fitMatOutward} = await import('../neural-dance/src/painting-frame.js');
  const w = 160, h = 110;
  const px = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, r, g, b) => { const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 210, 210, 208);
  for (let y = 4; y <= 104; y++) for (let x = 8; x <= 150; x++) put(x, y, 18, 18, 20);
  for (let y = 22; y <= 86; y++) for (let x = 28; x <= 130; x++) put(x, y, 188, 186, 180);
  for (let y = 40; y <= 70; y++) for (let x = 50; x <= 110; x++) put(x, y, 40, 90, 180);
  const fit = fitMatOutward(px, w, h);
  assert.ok(fit, 'outward walk found the frame');
  const left = Math.min(fit.quad[0].x, fit.quad[3].x);
  const top = Math.min(fit.quad[0].y, fit.quad[1].y);
  assert.ok(left < 28 && left >= 25, 'left edge is the dark frame, not inside the mat: ' + left);
  assert.ok(top < 22 && top >= 19, 'top edge is the dark frame, not inside the mat: ' + top);
});
