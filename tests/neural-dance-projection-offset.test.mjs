// Projector glow was up and to the right of the stickers. The preview
// letterbox, the detect grid, and a second CSS warp were not the same space.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  applyHomography, calibrationGrid, detectDiffPeaks, homographyResidual,
  mapScreenToDetect, mapStickerToScreen, matchPeaks, solveHomographyN
} from '../neural-dance/src/geometry.js';
import {
  CANVAS_H, CANVAS_W, clientToNormalized, clientToVideoNormalized,
  containedVideoRect, homographyFromNormalized, readStickerCal, writeStickerCal
} from '../neural-dance/camera-markers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/frame-bugs');
const hasStudioFixtures = existsSync(dir);

test('object-fit contain maps a click on the picture into video space, not the letterbox', () => {
  const box = {left: 10, top: 20, width: 390, height: 78};
  const videoW = 640;
  const videoH = 480;
  const media = containedVideoRect(box, videoW, videoH);
  assert.ok(media.width < box.width - 40, 'the 4:3 picture does not fill the short strip');
  const clickX = media.left + 1;
  const clickY = media.top + media.height / 2;
  const video = clientToVideoNormalized(clickX, clickY, box, videoW, videoH);
  const element = clientToNormalized(clickX, clickY, box);
  assert.ok(video.x < 0.03, 'video x ' + video.x);
  assert.ok(Math.abs(video.y - 0.5) < 0.03, 'video y ' + video.y);
  assert.ok(element.x > 0.2, 'element box still includes the side bars');
});

test('sticker -> stage -> screen round-trips, and a second warp does not', () => {
  const pink = [
    {x: 0.18, y: 0.28}, {x: 0.84, y: 0.30},
    {x: 0.86, y: 0.78}, {x: 0.16, y: 0.76}
  ];
  const videoW = 640;
  const videoH = 480;
  const H = homographyFromNormalized(pink, videoW, videoH);
  const scaleX = videoW / 480;
  const scaleY = videoH / 360;
  const forward = mapStickerToScreen({
    detectX: 200, detectY: 150, scaleX, scaleY, homography: H, viewW: 390, viewH: 844
  });
  const back = mapScreenToDetect({
    screenX: forward.screen.x, screenY: forward.screen.y,
    scaleX, scaleY, homography: H, viewW: 390, viewH: 844
  });
  assert.ok(Math.abs(back.detect.x - 200) < 0.05, 'detect x ' + back.detect.x);
  assert.ok(Math.abs(back.detect.y - 150) < 0.05, 'detect y ' + back.detect.y);
  assert.ok(forward.stage.x > 0 && forward.stage.x < CANVAS_W);
  assert.ok(forward.stage.y > 0 && forward.stage.y < CANVAS_H);
  const warp = homographyFromNormalized(
    [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.12}, {x: 0.88, y: 0.9}, {x: 0.12, y: 0.88}],
    390, 844
  );
  const twice = applyHomography(warp, forward.screen.x, forward.screen.y);
  assert.ok(Math.hypot(twice.x - forward.screen.x, twice.y - forward.screen.y) > 5);
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /layer\.style\.transform = m/);
  assert.match(cam, /Do not also fold it into the homography/);
});

test('a 3x3 dot grid fits a homography and reports the residual in stage px', { skip: !hasStudioFixtures }, () => {
  const grid = calibrationGrid(3);
  assert.equal(grid.length, 9);
  const stage = grid.map(p => ({x: p.x * CANVAS_W, y: p.y * CANVAS_H}));
  const camera = grid.map(p => ({x: 0.18 + p.x * 0.64, y: 0.22 + p.y * 0.58}));
  const H = solveHomographyN(camera, stage);
  const residual = homographyResidual(H, camera, stage);
  assert.ok(residual < 0.5, 'residual ' + residual);
  const mid = applyHomography(H, camera[4].x, camera[4].y);
  assert.ok(Math.hypot(mid.x - stage[4].x, mid.y - stage[4].y) < 0.5);
  const dark = new Uint8ClampedArray(40 * 30 * 4);
  const lit = new Uint8ClampedArray(dark);
  const paint = (x, y) => { const i = (y * 40 + x) * 4; lit[i] = lit[i + 1] = lit[i + 2] = 255; lit[i + 3] = 255; };
  for (const p of [[8, 6], [20, 6], [32, 8], [8, 15], [20, 16], [31, 15], [9, 24], [20, 24], [32, 23]]) paint(p[0], p[1]);
  const peaks = detectDiffPeaks(dark, lit, 40, 30, {minDelta: 30, minSep: 4, limit: 9});
  assert.equal(peaks.length, 9);
  const matched = matchPeaks(peaks, [{x: 8, y: 6}, {x: 21, y: 7}, {x: 100, y: 100}], 3);
  assert.ok(matched[0]);
  assert.equal(matched[2], null);
  const store = {bag: new Map(), getItem(k) { return this.bag.has(k) ? this.bag.get(k) : null; }, setItem(k, v) { this.bag.set(k, String(v)); }, removeItem(k) { this.bag.delete(k); }};
  writeStickerCal(store, {H, residual, at: 1});
  const saved = readStickerCal(store);
  assert.ok(Math.abs(saved.residual - residual) < 1e-6);
  assert.equal(saved.H.length, 9);
  const png = readFileSync(join(dir, 'projection-offset-1145.png'));
  let w = 0;
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') w = png.readUInt32BE(off + 8);
    off += 12 + len;
  }
  assert.ok(w > 400, 'fixture width ' + w);
});
