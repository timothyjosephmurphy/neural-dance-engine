import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseAlignQuad, detectProjectedBrowserChrome, explainAlignmentQuad, homographyFromNormalized, isValidAlignmentQuad, litRegionBounds} from '../neural-dance/camera-markers.js';
import {blankFrameVerified, blankHoldForLag, createBlankSettle, detectBlankStickers} from '../neural-dance/src/blank-scan.js';
import {createStickerScan} from '../neural-dance/src/scan-session.js';
import {createLatencyTracker, decodeLatencyFrame, renderLatencyFrame} from '../neural-dance/src/latency-code.js';
import {cameraTapToStage, createTrainingLog} from '../neural-dance/src/training-taps.js';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';
import {freshShowState, pressShowControl, reduceShowCommand, SHOW_CONTROLS} from '../neural-dance/src/show-commands.js';
import {createQuadLock} from '../neural-dance/src/quad-lock.js';
import {projectorFrame} from '../neural-dance/src/projector-hold.js';

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

function stickerFrame(width, height, x, y) {
  return paint(width, height, (px, py) => {
    const on = px >= x && px < x + 14 && py >= y && py < y + 20;
    return on ? [18, 16, 14] : [236, 236, 232];
  });
}

function personFrame(width, height) {
  return paint(width, height, (x, y) => {
    const body = x >= width * 0.28 && x < width * 0.62 && y >= height * 0.04 && y < height * 0.96;
    return body ? [150, 96, 72] : [236, 236, 232];
  });
}

test('clear resets sticker detection after a person and a move', () => {
  const width = 160;
  const height = 120;
  const scan = createStickerScan();
  const spots = [[28, 24], [96, 36], [40, 70], [88, 58]];
  for (let cycle = 0; cycle < spots.length; cycle++) {
    const [x, y] = spots[cycle];
    const person = personFrame(width, height);
    assert.equal(scan.storeReference(person, width, height, 'white').ok, false);
    scan.observePerson(person, width, height, cycle * 1000);
    scan.clear();
    assert.equal(scan.reference('white'), null);
    const frame = stickerFrame(width, height, x, y);
    let markers = [];
    for (let hit = 0; hit < 3; hit++) {
      const step = scan.observeBlank(frame, width, height, 'white');
      assert.equal(step.accepted, true, 'cycle ' + cycle);
      markers = step.markers;
    }
    assert.equal(markers.length, 1, 'cycle ' + cycle);
    assert.ok(Math.abs(markers[0].x - (x + 7)) < 10, markers[0].x);
    assert.ok(Math.abs(markers[0].y - (y + 10)) < 10, markers[0].y);
  }
});

test('measured projector lag shifts the blank window', () => {
  const tracker = createLatencyTracker();
  const lag = 140;
  const jitters = [0, 12, -8, 6, -4];
  for (let frame = 0; frame < 40; frame++) tracker.shown(frame, frame * 16);
  const readings = [];
  for (const jitter of jitters) {
    const cameraAt = 400 + jitter;
    const shownAt = cameraAt - lag;
    const frame = Math.round(shownAt / 16) & 0xfff;
    const image = renderLatencyFrame(320, 180, frame);
    const decoded = decodeLatencyFrame(image.rgba, image.width, image.height);
    assert.equal(decoded.frame, frame);
    readings.push(tracker.observe(cameraAt, decoded.frame));
  }
  const stats = readings.at(-1);
  assert.ok(Math.abs(stats.lagMs - lag) < 20, stats.lagMs);
  assert.ok(stats.jitterMs < 20, stats.jitterMs);
  const hold = blankHoldForLag({lagMs: stats.lagMs, jitterMs: stats.jitterMs, baseMs: 200});
  assert.ok(hold >= stats.lagMs + stats.jitterMs);
  const settle = createBlankSettle();
  settle.setLatency(stats.lagMs);
  settle.begin('white');
  assert.equal(settle.frame(0), false);
  assert.equal(settle.frame(16), false);
  assert.equal(settle.frame(16 + stats.lagMs - 1), false);
  assert.equal(settle.frame(16 + stats.lagMs), true);
  const show = paint(80, 60, (x, y) => (x < 20 ? [250, 250, 250] : [12, 12, 12]));
  const white = paint(80, 60, () => [236, 236, 232]);
  assert.equal(blankFrameVerified(show, 80, 60, 'white'), false);
  assert.equal(blankFrameVerified(white, 80, 60, 'white'), true);
});

test('a camera tap maps through the homography and is saved for training', async () => {
  const quad = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}];
  assert.ok(homographyFromNormalized(quad, 1, 1));
  const stage = cameraTapToStage(0.25, 0.5, quad);
  assert.ok(Math.abs(stage.x - 250) < 1, stage.x);
  assert.ok(Math.abs(stage.y - 310) < 1, stage.y);
  const log = createTrainingLog();
  const added = log.add({
    at: 10,
    camera: {x: 0.25, y: 0.5},
    stage,
    detector: {stickers: [], pink: [], markers: [{id: 1, x: 10, y: 12, kind: 'sticker'}]},
    frame: 'data:image/jpeg;base64,QQ=='
  });
  assert.equal(added.stage.x, stage.x);
  const json = log.toJSON();
  assert.equal(json.examples.length, 1);
  assert.equal(json.examples[0].detector.markers[0].id, 1);
  const zip = log.toZip();
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /cameraTapToStage/);
  assert.doesNotMatch(viewer, /getUserMedia/);
});

test('tapped and detected stickers both render a silhouette', () => {
  const width = 80;
  const height = 60;
  const data = paint(width, height, (x, y) => (x >= 30 && x < 48 && y >= 16 && y < 40 ? [20, 18, 16] : [230, 230, 226]));
  const found = detectBlankStickers(data, width, height, {mode: 'white', sensitivity: 0.5});
  assert.equal(found.length, 1);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  show.beat(500, 1);
  const paths = [];
  const dots = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineJoin: '', globalCompositeOperation: 'source-over',
    save() {}, restore() {},
    beginPath() { paths.push({moves: 0, fill: false, stroke: false}); },
    moveTo() { paths.at(-1).moves++; },
    lineTo() { paths.at(-1).moves++; },
    closePath() {},
    fill() { paths.at(-1).fill = true; },
    stroke() { paths.at(-1).stroke = true; }
  };
  show.paint(ctx, [
    {id: 3, x: 40, y: 30, type: 1, kind: 'sticker', contour: found[0].contour},
    {id: 9, x: 120, y: 80, type: 1, kind: 'sticker', manual: true}
  ], {now: 700, waveform: () => [0, 0.4, 1], paintDots(list) { dots.push(...list); }});
  assert.equal(dots.length, 0);
  assert.ok(paths.filter(item => item.fill && item.moves > 4).length >= 2);
});

test('debug and phone controls land on the same state', () => {
  const start = freshShowState({micGranted: true, running: true, markersOn: true});
  for (const control of SHOW_CONTROLS) {
    const phone = reduceShowCommand(start, pressShowControl(control.id, 'phone', start));
    const debug = reduceShowCommand(start, pressShowControl(control.id, 'debug', start));
    assert.deepEqual(phone, debug, control.id);
  }
  const blocked = reduceShowCommand(freshShowState({micGranted: false}), {action: 'listen'});
  assert.equal(blocked.listening, false);
  assert.equal(blocked.mic, 'needs-gesture');
  const granted = reduceShowCommand(freshShowState({micGranted: false}), {action: 'listen', gesture: true});
  assert.equal(granted.listening, true);
  assert.equal(granted.micGranted, true);
});

test('an alternating bad quad does not move a locked screen', () => {
  const lock = createQuadLock();
  const good = [{x: 0.08, y: 0.1}, {x: 0.9, y: 0.12}, {x: 0.88, y: 0.86}, {x: 0.1, y: 0.84}];
  const bad = [{x: 0.4, y: 0.4}, {x: 0.6, y: 0.42}, {x: 0.58, y: 0.7}, {x: 0.42, y: 0.68}];
  for (let i = 0; i < 4; i++) lock.observe(good);
  const locked = lock.quad();
  assert.ok(locked);
  lock.lock();
  for (let i = 0; i < 6; i++) {
    const candidate = i % 2 === 0 ? good : bad;
    const step = lock.observe(candidate.map(point => ({x: point.x + (i % 2 ? 0 : 0.005), y: point.y})));
    assert.equal(step.replaced, false);
    assert.equal(step.quad[0].x, locked[0].x);
  }
  lock.unlock();
  let moved = null;
  for (let i = 0; i < 4; i++) moved = lock.observe(bad);
  assert.equal(moved.replaced, true);
  assert.ok(Math.abs(moved.quad[0].x - bad[0].x) < 0.02);
});

test('align owns the projector for the whole run, including a studio redraw', () => {
  const during = [];
  const samples = [
    {aligning: true, flash: 'black', pattern: false, scan: 'white', latency: true},
    {aligning: true, flash: '', pattern: true, scan: 'black', latency: true},
    {aligning: true, flash: '', pattern: false, scan: 'white', latency: false}
  ];
  for (const sample of samples) {
    const layer = projectorFrame(sample);
    during.push(layer);
    assert.notEqual(layer, 'simulation');
    assert.notEqual(layer, 'scan');
    assert.notEqual(layer, 'latency');
  }
  assert.deepEqual(during, ['black', 'pattern', 'pattern']);
  assert.equal(projectorFrame({aligning: false, pattern: false, scan: '', latency: false}), 'simulation');
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /ndAlignOwn/);
  assert.match(show, /suspendScan/);
});


test('latency-test starts rather than toggles', () => {
  const start = freshShowState({latencyTest: false});
  const once = reduceShowCommand(start, pressShowControl('latency-test', 'debug', start));
  assert.equal(once.latencyTest, true);
  const again = reduceShowCommand(once, pressShowControl('latency-test', 'debug', once));
  assert.equal(again.latencyTest, true, 'a second press still means running, not off');
});

test('blank hold covers settle plus a capture window', () => {
  const hold = blankHoldForLag({lagMs: 220, jitterMs: 0, baseMs: 200});
  assert.ok(hold >= 420, 'hold ' + hold);
  const short = blankHoldForLag({lagMs: 100, jitterMs: 0, baseMs: 200});
  assert.ok(short >= 300, 'short hold ' + short);
});

test('an extrapolated off-screen quad is refused', () => {
  const bad = [
    {x: 0.2, y: 0.3},
    {x: 1.6, y: 0.3},
    {x: 1.6, y: 0.9},
    {x: 0.2, y: 0.9}
  ];
  assert.equal(isValidAlignmentQuad(bad), false);
  const choice = chooseAlignQuad({
    markers: {corners: bad, found: [true, false, false, true], reason: 'Not seeing 2 teal, 3 blue'},
    border: null,
    bright: null
  });
  assert.equal(choice.ok, false);
  assert.equal(choice.corners, null);
  assert.match(choice.reason, /not all four|Not seeing/i);
});

test('soft sync gap still decodes a slightly washed latency strip', () => {
  const frame = 0x4a2;
  const image = renderLatencyFrame(480, 270, frame);
  // Lift blacks and crush whites a bit like a phone AE pass.
  for (let i = 0; i < image.rgba.length; i += 4) {
    const v = image.rgba[i];
    const washed = v < 128 ? Math.min(255, v + 28) : Math.max(0, v - 20);
    image.rgba[i] = image.rgba[i + 1] = image.rgba[i + 2] = washed;
  }
  const decoded = decodeLatencyFrame(image.rgba, image.width, image.height);
  assert.ok(decoded, 'decoder should survive mild washout');
  assert.equal(decoded.frame, frame);
});

test('gray blank verifies and finds a dark sticker', () => {
  const gray = paint(120, 80, () => [168, 168, 168]);
  // Dark sticker near center.
  for (let y = 34; y < 46; y++) {
    for (let x = 52; x < 64; x++) {
      const p = (y * 120 + x) * 4;
      gray[p] = gray[p + 1] = gray[p + 2] = 18;
    }
  }
  assert.equal(blankFrameVerified(gray, 120, 80, 'gray'), true);
  assert.equal(blankFrameVerified(gray, 120, 80, 'black'), false);
  const stickers = detectBlankStickers(gray, 120, 80, {mode: 'white', sensitivity: 0.6});
  assert.ok(stickers.length >= 1, 'dark sticker on gray');
});

test('a skewed phone quad is refused with a reason; projected browser chrome only warns', () => {
  const skewed = [
    {x: 0.333, y: 0.275}, {x: 0.866, y: 0.207}, {x: 0.785, y: 0.908}, {x: 0.421, y: 0.882}
  ];
  assert.equal(isValidAlignmentQuad(skewed), true, 'old loose check still passes');
  const refused = explainAlignmentQuad(skewed);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /skew|parallel|chrome|lit|Fullscreen/i);

  const w = 100, h = 70;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const lit = x > 12 && x < 90 && y > 10 && y < 64;
    const bar = lit && y >= 10 && y <= 16;
    const v = bar ? 235 : lit ? 145 : 18;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  const lit = litRegionBounds(rgba, w, h);
  const chrome = detectProjectedBrowserChrome(rgba, w, h, lit);
  assert.equal(chrome.present, true);
  const good = [{x: 0.14, y: 0.16}, {x: 0.88, y: 0.15}, {x: 0.87, y: 0.9}, {x: 0.13, y: 0.89}];
  const withChrome = explainAlignmentQuad(good, {lit, chrome});
  // 3:14 PM PT: the chrome check refused TJ's fullscreen align. Warning only.
  assert.equal(withChrome.ok, true);
  assert.match(withChrome.warning, /toolbar/i);
  assert.equal(explainAlignmentQuad(good, {lit, chrome: {present: false}}).ok, true);
});

