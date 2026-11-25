// Nov 9, 3:54 PM (TJ): a hard-to-see third sticker, sensitivity raised, and
// ~20 spots latched, many outside the pink quad: projected blooms fed back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTINUOUS_SENS_CAP, ECHO_H, ECHO_W, applyHomography, continuousSensitivity, continuousVetoReach, createStageEcho, detectStickerBlobs, homographyFromNormalized} from '../neural-dance/camera-markers.js';
import {stickerInPlay} from '../neural-dance/src/align-anchors.js';

// Rig quad at 3:54 PM (camera 0-1), after the 18/82 align fix.
const QUAD = [{x: 0.04678806096457987, y: 0.33935331403708296}, {x: 1.0010260540571652, y: 0.334538084661847}, {x: 0.973590848571296, y: 0.8275558715891531}, {x: 0.05100608296478533, y: 0.8025092982268434}];

function litFloor(W, H, blooms, stickers) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 150 + (((x * 31 + y * 17) % 7) - 3);
    for (const b of blooms) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < 10) v = 240;
      else if (d < 34) v = Math.max(v, 240 - (d - 10) * 3.9);
      // Dim fringe just outside the glow: the projector's falloff ring.
      if (d >= 34 && d < 40) v -= 6;
    }
    // Dancer-ish sticker: torso plus arms, so it is not a solid rectangle.
    for (const s of stickers) if ((Math.abs(x - s.x) < 2 && Math.abs(y - s.y) < 7) || (Math.abs(y - s.y + 2) < 1.5 && Math.abs(x - s.x) < 6) || (Math.abs(y - s.y - 6) < 2 && Math.abs(Math.abs(x - s.x) - 3) < 1.5)) v = 60;
    const i = (y * W + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, v));
    rgba[i + 3] = 255;
  }
  return rgba;
}

test('the slider tops out for lit frames; the veto reaches further as it rises', () => {
  assert.equal(CONTINUOUS_SENS_CAP, 0.6);
  assert.equal(continuousSensitivity(1), 0.6);
  assert.equal(continuousSensitivity(0.35), 0.35);
  assert.equal(continuousVetoReach(0.5), 5);
  assert.equal(continuousVetoReach(1), 9);
});

test('at full sensitivity, projected glow on a lit floor does not become stickers; the real one does', () => {
  const W = 480;
  const H = 360;
  const blooms = [{x: 120, y: 120}, {x: 300, y: 110}, {x: 380, y: 260}, {x: 150, y: 270}];
  const real = {x: 250, y: 200};
  const rgba = litFloor(W, H, blooms, [real]);
  const raw = detectStickerBlobs(rgba, W, H, {stickerSensitivity: 1});
  const safe = detectStickerBlobs(rgba, W, H, {stickerSensitivity: continuousSensitivity(1)});
  const isReal = b => Math.hypot(b.x - real.x, b.y - real.y) < 6;
  assert.ok(safe.some(isReal), 'real sticker still found');
  assert.equal(safe.filter(b => !isReal(b)).length, 0, 'no glow spots: ' + JSON.stringify(safe.map(b => [Math.round(b.x), Math.round(b.y)])));
  // Elongation limits now cut most slash-like glow blobs even before the
  // continuous veto. The continuous path must still keep only the real sticker.
  assert.ok(safe.length >= 1);
  assert.ok(raw.some(isReal), 'uncapped still finds the real sticker');
});

test('a high slider widens the bloom veto around projected light', () => {
  const echo = createStageEcho();
  const rgb = new Uint8ClampedArray(ECHO_W * ECHO_H * 3);
  // A warm bloom at stage (500, 310).
  const cx = Math.round(500 / 1000 * (ECHO_W - 1));
  const cy = Math.round(310 / 620 * (ECHO_H - 1));
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const o = ((cy + dy) * ECHO_W + (cx + dx)) * 3;
    rgb[o] = 250; rgb[o + 1] = 210; rgb[o + 2] = 90;
  }
  echo.ingest(rgb, 1000);
  const far = 500 + 7.5 * (1000 / (ECHO_W - 1)); // ~47 stage px away
  assert.equal(echo.vetoSticker(far, 310, continuousVetoReach(0.5)), false);
  assert.equal(echo.vetoSticker(far, 310, continuousVetoReach(1)), true);
});

test('rig 3:54 PM: spots outside the quad or at its corners are rejected', () => {
  const H = homographyFromNormalized(QUAD, 1, 1);
  const at = (x, y) => applyHomography(H, x, y);
  for (const [x, y, label] of [[0.06, 0.79, 'corner 4'], [0.02, 0.6, 'left of the quad'], [0.5, 0.3, 'above the quad'], [0.99, 0.82, 'corner 3']]) {
    const p = at(x, y);
    assert.equal(stickerInPlay(p.x, p.y), false, label + ' ' + JSON.stringify(p));
  }
  for (const s of [{x: 375, y: 294}, {x: 569, y: 293}]) assert.equal(stickerInPlay(s.x, s.y), true);
});

// 3:56 PM rig frame (2b62353): the third sticker sits on the vertical grid
// line below center (camera 240,236). Missed at every slider position because
// the global cut used the whole-quad median (63; the 18/82 quad now reaches the
// dim stage edges) instead of the floor around the sticker (~82).
import {readFileSync as readFix, existsSync} from 'node:fs';
const has1556 = existsSync(new URL('./fixtures/nd-rig-1556-cam-480.ppm', import.meta.url));
function ppm(name) {
  const raw = readFix(new URL('./fixtures/' + name, import.meta.url));
  let i = 0;
  const tok = () => { while (/\s/.test(String.fromCharCode(raw[i]))) i++; const s = i; while (!/\s/.test(String.fromCharCode(raw[i]))) i++; return raw.toString('ascii', s, i); };
  tok(); const w = +tok(); const h = +tok(); tok(); i++;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) { rgba[k * 4] = raw[i + k * 3]; rgba[k * 4 + 1] = raw[i + k * 3 + 1]; rgba[k * 4 + 2] = raw[i + k * 3 + 2]; rgba[k * 4 + 3] = 255; }
  return {rgba, w, h};
}
const Q1556 = [{x: 0.046902620998946216, y: 0.3395678255653183}, {x: 0.9988859069373957, y: 0.33511291844684526}, {x: 0.9753477762359525, y: 0.8278094138007638}, {x: 0.05071280147144717, y: 0.8025178245655992}];

test('rig 3:56 PM: the lower-midline sticker on the grid line is found at default sensitivity, nothing spurious in play', { skip: !has1556 }, () => {
  const {rgba, w, h} = ppm('nd-rig-1556-cam-480.ppm');
  const H = homographyFromNormalized(Q1556, 640, 480);
  const scale = {width: w, height: h, scaleX: 640 / w, scaleY: 480 / h};
  for (const s of [0.5, continuousSensitivity(0.72), continuousSensitivity(1)]) {
    const blobs = detectStickerBlobs(rgba, w, h, {stickerSensitivity: s, homography: H, scale});
    const inPlay = blobs.filter(b => {
      const at = applyHomography(H, (b.x + 0.5) * 640 / w, (b.y + 0.5) * 480 / h);
      return stickerInPlay(at.x, at.y);
    });
    assert.ok(inPlay.some(b => Math.hypot(b.x - 240, b.y - 236) < 5), 'sens ' + s + ': third sticker ' + JSON.stringify(blobs.map(b => [Math.round(b.x), Math.round(b.y)])));
    assert.equal(inPlay.length, 1, 'sens ' + s + ': only the sticker in play');
  }
});
