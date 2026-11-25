// Copyright (c) 2026 Timothy Joseph Murphy
// SPDX-License-Identifier: MIT

// Live rig regression (Nov 9 2026, 2:58 PM PT, build aae7e41). Camera frame,
// stage echo, and quad came from the studio debug feed; ground truth is TJ's
// debug taps on both real stickers. On aae7e41 the dim floor grid vetoed both
// stickers (rawCount 0) so nothing ever latched.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {applyHomography, continuousStagePoint, createStageEcho, detectStickerBlobs, detectionSize, homographyFromNormalized, videoPointFromDetect} from '../neural-dance/camera-markers.js';
import {CONTINUOUS_HITS, CONTINUOUS_LATCHED_MISSES, CONTINUOUS_MISSES, createScanBook, mergeScanPoints} from '../neural-dance/src/blank-scan.js';
import {projectedFromEcho} from '../neural-dance/src/person-occlusion.js';
import {migrateSimDefaultOff, readRoomSettings, ROOM_KEY, SIM_DEFAULT_OFF_KEY} from '../neural-dance/room-lab.js';

function readPpm(name) {
  const raw = readFileSync(new URL('./fixtures/' + name, import.meta.url));
  let i = 0;
  const token = () => {
    while (i < raw.length && (raw[i] === 32 || raw[i] === 10 || raw[i] === 13 || raw[i] === 9)) i++;
    const start = i;
    while (i < raw.length && raw[i] !== 32 && raw[i] !== 10 && raw[i] !== 13 && raw[i] !== 9) i++;
    return raw.toString('ascii', start, i);
  };
  assert.equal(token(), 'P6');
  const width = +token();
  const height = +token();
  token();
  i++;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = raw[i + p * 3];
    rgba[p * 4 + 1] = raw[i + p * 3 + 1];
    rgba[p * 4 + 2] = raw[i + p * 3 + 2];
    rgba[p * 4 + 3] = 255;
  }
  return {rgba, width, height};
}

const has1457 = existsSync(new URL('./fixtures/nd-rig-1457.json', import.meta.url));
const meta = has1457 ? JSON.parse(readFileSync(new URL('./fixtures/nd-rig-1457.json', import.meta.url), 'utf8')) : null;
const H = has1457 ? homographyFromNormalized(meta.quad, meta.videoWidth, meta.videoHeight) : null;
const scale = has1457 ? detectionSize(meta.videoWidth, meta.videoHeight) : null;
const stage = has1457 ? readPpm('nd-rig-1457-stage-160.ppm') : null;
const stageRgb = has1457 ? new Uint8Array(stage.width * stage.height * 3) : null;
if (has1457) {
  for (let p = 0; p < stage.width * stage.height; p++) {
    stageRgb[p * 3] = stage.rgba[p * 4];
    stageRgb[p * 3 + 1] = stage.rgba[p * 4 + 1];
    stageRgb[p * 3 + 2] = stage.rgba[p * 4 + 2];
  }
}

// The live continuous path: detect -> map -> echo veto -> scan book, 100 ms per detect.
import {stickerInPlay} from '../neural-dance/src/align-anchors.js';

function replay(frame, ms) {
  const echo = createStageEcho();
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, latchedMisses: CONTINUOUS_LATCHED_MISSES});
  let firstLatch = null;
  let everShown = 0;
  let markers = [];
  for (let now = 0; now <= ms; now += 100) {
    echo.ingest(stageRgb, now);
    const points = [];
    for (const blob of detectStickerBlobs(frame.rgba, frame.width, frame.height, {stickerSensitivity: 0.5, homography: H, scale, exclude: []})) {
      const video = videoPointFromDetect(blob.x, blob.y, scale);
      const at = applyHomography(H, video.x, video.y);
      // Same gates as the live continuous path: the stickered floor, then the echo veto.
      if (at && stickerInPlay(at.x, at.y) && !echo.vetoSticker(at.x, at.y)) points.push(continuousStagePoint(blob, scale, H, at));
    }
    markers = book.observe(mergeScanPoints(points, 48));
    if (markers.length && firstLatch == null) firstLatch = now;
    everShown = Math.max(everShown, markers.length);
  }
  return {markers, firstLatch, everShown, echo};
}

test('rig 2:58 PM: both real stickers latch within ~2 s at TJ tapped spots and stay', { skip: !has1457 }, () => {
  const run = replay(readPpm('nd-rig-1457-cam-480.ppm'), 6000);
  assert.ok(run.firstLatch != null && run.firstLatch <= 2500, 'latched at ' + run.firstLatch + ' ms');
  assert.equal(run.markers.length, 2, JSON.stringify(run.markers));
  for (const truth of meta.truth) {
    const near = run.markers.some(m => Math.hypot(m.x - truth.x, m.y - truth.y) <= 28);
    assert.ok(near, 'no marker near tap ' + JSON.stringify(truth) + ' in ' + JSON.stringify(run.markers));
  }
  // Each latched sticker carries its silhouette in stage pixels, around the sticker.
  for (const m of run.markers) {
    assert.ok(Array.isArray(m.contour) && m.contour.length >= 3, 'no silhouette contour');
    const cx = m.contour.reduce((a, p) => a + p.x, 0) / m.contour.length;
    const cy = m.contour.reduce((a, p) => a + p.y, 0) / m.contour.length;
    assert.ok(Math.hypot(cx - m.x, cy - m.y) <= 30, 'silhouette off its sticker: ' + cx.toFixed(0) + ',' + cy.toFixed(0) + ' vs ' + m.x.toFixed(0) + ',' + m.y.toFixed(0));
  }
});

test('rig 2:58 PM: empty scene (stickers painted out) stays empty, no flicker markers', { skip: !has1457 }, () => {
  const run = replay(readPpm('nd-rig-1457-empty-480.ppm'), 6000);
  assert.equal(run.everShown, 0, JSON.stringify(run.markers));
});

test('static dim floor grid does not veto stickers or blind the person mask', { skip: !has1457 }, () => {
  const echo = createStageEcho();
  for (let now = 0; now <= 4000; now += 100) echo.ingest(stageRgb, now);
  for (const truth of meta.truth) assert.equal(echo.vetoSticker(truth.x, truth.y), false, JSON.stringify(truth));
  const projected = projectedFromEcho(echo, (x, y) => {
    const video = videoPointFromDetect(x, y, scale);
    return applyHomography(H, video.x, video.y);
  });
  let cells = 0;
  let covered = 0;
  for (let y = 150; y < 300; y += 6) {
    for (let x = 80; x < 460; x += 6) {
      cells++;
      if (projected(x, y)) covered++;
    }
  }
  assert.ok(covered / cells < 0.1, 'person mask covered ' + (covered / cells).toFixed(2));
});

test('moving bright projection is still vetoed after the floor settles', { skip: !has1457 }, () => {
  const echo = createStageEcho();
  for (let now = 0; now <= 4000; now += 100) echo.ingest(stageRgb, now);
  const moved = new Uint8Array(stageRgb);
  // a cyan ring pulse appears at stage (700, 200)
  const cx = Math.round(700 / 1000 * 159);
  const cy = Math.round(200 / 620 * 99);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const o = ((cy + dy) * 160 + cx + dx) * 3;
    moved[o] = 40; moved[o + 1] = 90; moved[o + 2] = 110;
  }
  echo.ingest(moved, 4100);
  assert.equal(echo.vetoSticker(700, 200), true);
  assert.equal(echo.veto(700, 200), true);
});

test('latched sticker stays through long misses (its own dot hides it) but a pending one drops', () => {
  const book = createScanBook({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, latchedMisses: CONTINUOUS_LATCHED_MISSES});
  for (let i = 0; i < CONTINUOUS_HITS; i++) book.observe([{x: 400, y: 300, kind: 'sticker'}]);
  assert.equal(book.markers().length, 1);
  for (let i = 0; i < 600; i++) book.observe([]);
  assert.equal(book.markers().length, 1);
  book.observe([{x: 700, y: 200, kind: 'sticker'}]);
  for (let i = 0; i < CONTINUOUS_MISSES; i++) book.observe([]);
  assert.equal(book.markers().length, 1);
});

function memory(init = {}) {
  const data = {...init};
  return {getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data};
}

test('one-time migration drops a stale persisted sim dancer, then respects later choices', () => {
  const box = memory({[ROOM_KEY]: JSON.stringify({v: 1, gravity: 2.5, sim: [{x: 300, y: 200}], simDancers: true})});
  assert.equal(readRoomSettings(box).simDancers, true);
  assert.equal(migrateSimDefaultOff(box), true);
  const after = readRoomSettings(box);
  assert.equal(after.simDancers, false);
  assert.equal(after.gravity, 2.5);
  assert.equal(box.data[SIM_DEFAULT_OFF_KEY], '1');
  box.setItem(ROOM_KEY, JSON.stringify({v: 1, sim: [{x: 1, y: 2}], simDancers: true}));
  assert.equal(migrateSimDefaultOff(box), false);
  assert.equal(readRoomSettings(box).simDancers, true);
});

// ---- 3:14-3:17 PM PT hotfix (ebf3e94 rig) ----
import {explainAlignmentQuad, personStageInside} from '../neural-dance/camera-markers.js';
import {personInFrame} from '../neural-dance/src/person-occlusion.js';

const has1517 = existsSync(new URL('./fixtures/nd-rig-1517.json', import.meta.url));
const rig17 = has1517 ? JSON.parse(readFileSync(new URL('./fixtures/nd-rig-1517.json', import.meta.url), 'utf8')) : null;
function personOn(camName, stageName, meta) {
  const cam = readPpm(camName);
  const st = readPpm(stageName);
  const rgb = new Uint8Array(st.width * st.height * 3);
  for (let p = 0; p < st.width * st.height; p++) { rgb[p * 3] = st.rgba[p * 4]; rgb[p * 3 + 1] = st.rgba[p * 4 + 1]; rgb[p * 3 + 2] = st.rgba[p * 4 + 2]; }
  const echo = createStageEcho();
  echo.ingest(rgb, 0);
  const h = homographyFromNormalized(meta.quad, meta.videoWidth, meta.videoHeight);
  const sc = detectionSize(meta.videoWidth, meta.videoHeight);
  const projected = projectedFromEcho(echo, (x, y) => {
    const video = videoPointFromDetect(x, y, sc);
    return applyHomography(h, video.x, video.y);
  });
  return personInFrame(cam.rgba, cam.width, cam.height, {sensitivity: 0.35, projected, inside: (x, y) => personStageInside(h, x, y, sc)});
}

test('rig 3:17 PM: TJ standing in frame triggers person pause', { skip: !has1517 }, () => {
  const hit = personOn('nd-rig-1517-person-480.ppm', 'nd-rig-1517-person-stage-160.ppm', rig17.person);
  assert.equal(hit.present, true, JSON.stringify(hit));
});

test('rig 3:17 PM: same rig with nobody in frame does not pause', { skip: !has1517 }, () => {
  const hit = personOn('nd-rig-1517-empty-480.ppm', 'nd-rig-1517-empty-stage-160.ppm', rig17.empty);
  assert.equal(hit.present, false, JSON.stringify(hit));
  assert.equal(hit.holding, false, JSON.stringify(hit));
});

test('align: fullscreen-like normal quad aligns even if chrome is suspected (warning only)', () => {
  const quad = [{x: 0.1, y: 0.12}, {x: 0.9, y: 0.1}, {x: 0.92, y: 0.88}, {x: 0.08, y: 0.9}];
  const plain = explainAlignmentQuad(quad, {});
  assert.equal(plain.ok, true);
  const chrome = explainAlignmentQuad(quad, {chrome: {present: true}, lit: {minX: 0.1, minY: 0.05, maxX: 0.9, maxY: 0.9}});
  assert.equal(chrome.ok, true, chrome.reason);
  assert.match(chrome.warning, /toolbar/);
  // TJ's 3:14 PM quad was refused as "too skewed or too small".
  if (has1517) assert.equal(explainAlignmentQuad(rig17.quad1514, {}).ok, true);
});

test('align: still refuses missing corners, non-convex, and wildly skewed quads', () => {
  assert.equal(explainAlignmentQuad([{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}]).ok, false);
  assert.equal(explainAlignmentQuad([{x: 0.1, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.9, y: 0.1}, {x: 0.1, y: 0.9}]).ok, false);
  assert.equal(explainAlignmentQuad([{x: 0.1, y: 0.1}, {x: 0.9, y: 0.6}, {x: 0.95, y: 0.65}, {x: 0.05, y: 0.9}]).ok, false);
});

test('a static yellow dancer bloom still vetoes stickers (no self-latching)', { skip: !has1457 }, () => {
  const echo = createStageEcho();
  const bloom = new Uint8Array(stageRgb);
  const cx = Math.round(300 / 1000 * 159);
  const cy = Math.round(450 / 620 * 99);
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.hypot(dx, dy);
    if (d < 1.5) continue; // dark center, as the projected dot looks to the camera
    const o = ((cy + dy) * 160 + cx + dx) * 3;
    const k = Math.max(0, 1 - d / 5);
    bloom[o] = 40 + 160 * k; bloom[o + 1] = 34 + 130 * k; bloom[o + 2] = 12;
  }
  for (let now = 0; now <= 8000; now += 100) echo.ingest(bloom, now);
  assert.equal(echo.vetoSticker(300, 450), true);
  for (const truth of meta.truth) assert.equal(echo.vetoSticker(truth.x, truth.y), false);
});

test('align 3:29 PM: TJ hand-set near-rectangular quads pass; refusals carry their numbers', () => {
  if (has1517) {
    const manual = explainAlignmentQuad(rig17.quad1529manual, {});
    assert.equal(manual.ok, true, manual.reason);
  }
  // TJ's description of the quad he sees (480x360 camera view).
  const seen = [[178, 270], [463, 263], [462, 352], [180, 350]].map(([x, y]) => ({x: x / 480, y: y / 360}));
  assert.equal(explainAlignmentQuad(seen, {}).ok, true);
  const bad = explainAlignmentQuad([{x: 0.1, y: 0.3}, {x: 0.9, y: 0.2}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.6}]);
  assert.equal(bad.ok, false);
  assert.ok(Array.isArray(bad.skew) && bad.skew.length === 2);
  assert.match(bad.reason, /\d\.\d\d/);
});

import {LIGHT_MODE_KEY, LIGHT_SILHOUETTE_MIGRATED_KEY, migrateLightSilhouetteDefault, readLightMode, writeLightMode} from '../neural-dance/room-lab.js';

test('light mode defaults to silhouette; dot stays available and persists', () => {
  const box = memory();
  assert.equal(readLightMode(box), 'silhouette');
  assert.equal(writeLightMode(box, 'dot'), true);
  assert.equal(readLightMode(box), 'dot');
  assert.equal(writeLightMode(box, 'bogus'), false);
  assert.equal(readLightMode(box), 'dot');
});

test('one-time migration flips a saved dot to silhouette, then respects later choices', () => {
  const box = memory({[LIGHT_MODE_KEY]: 'dot'});
  assert.equal(migrateLightSilhouetteDefault(box), true);
  assert.equal(readLightMode(box), 'silhouette');
  assert.equal(box.data[LIGHT_SILHOUETTE_MIGRATED_KEY], '1');
  writeLightMode(box, 'dot');
  assert.equal(migrateLightSilhouetteDefault(box), false);
  assert.equal(readLightMode(box), 'dot');
});

test('the live room starts in the saved or default light mode and saves changes', () => {
  const roomJs = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(roomJs, /migrateLightSilhouetteDefault\(null\)/);
  assert.match(roomJs, /readLightMode\(null\)/);
  assert.match(roomJs, /setLightMode\(mode\)\{[^}]*writeLightMode\(null,next\)/);
  assert.match(roomJs, /toggleLightMode\(\)\{[^}]*writeLightMode\(null,next\)/);
});
