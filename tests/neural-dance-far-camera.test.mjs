// TJ 6:31 / 6:35 PM: camera moved far back and angled; the projected screen is
// ~25-30% of the frame (center-left). Align must find the small keystoned
// screen (coarse-to-fine), and sticker detection must scale with the quad.
// Background is TJ's real far-camera frame (debug telemetry, 6:3x PM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {alignFromFrame, applyHomography, chooseAlignQuad, detectStickerBlobs, fitBrightQuad, fitScreenBorder,
  homographyFromNormalized, roiFromQuad, solveHomography, stickerQuadScale, ALIGN_MIN_AREA} from '../neural-dance/camera-markers.js';

function readPpm(url) {
  const raw = readFileSync(url);
  let i = 0;
  const tok = () => { while (/\s/.test(String.fromCharCode(raw[i]))) i++; const s = i; while (!/\s/.test(String.fromCharCode(raw[i]))) i++; return raw.toString('ascii', s, i); };
  tok(); const w = +tok(); const h = +tok(); tok(); i++;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) { data[k * 4] = raw[i + k * 3]; data[k * 4 + 1] = raw[i + k * 3 + 1]; data[k * 4 + 2] = raw[i + k * 3 + 2]; data[k * 4 + 3] = 255; }
  return {data, width: w, height: h};
}
const FAR_PHOTO = new URL('./fixtures/nd-far-angled-cam-480.ppm', import.meta.url);
const hasStudioFixtures = existsSync(FAR_PHOTO);
const PHOTO = hasStudioFixtures ? readPpm(FAR_PHOTO) : null;
// Screen as seen in that frame (detect px), scaled about (150,150) by k.
const SCREEN = [{x: 182.5, y: 97.5}, {x: 376, y: 105}, {x: 374, y: 215}, {x: 172.5, y: 202.5}];
const STAGE = [{x: 0, y: 0}, {x: 1000, y: 0}, {x: 1000, y: 620}, {x: 0, y: 620}];

function synth({k = 1, sat = 1, gain = 1, screen = null, stickers = []} = {}) {
  const {width: w, height: h} = PHOTO;
  const SC = screen || SCREEN.map(p => ({x: 150 + (p.x - 150) * k, y: 150 + (p.y - 150) * k}));
  const toStage = solveHomography(SC, STAGE);
  const paint = fn => {
    const d = new Uint8ClampedArray(PHOTO.data);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = applyHomography(toStage, x + 0.5, y + 0.5);
      if (!s || s.x < 0 || s.y < 0 || s.x > 1000 || s.y > 620) continue;
      const p = (y * w + x) * 4;
      const c = fn(s.x, s.y, [PHOTO.data[p], PHOTO.data[p + 1], PHOTO.data[p + 2]], x, y);
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
    }
    return {data: d, width: w, height: h};
  };
  const dark = paint((sx, sy, c) => c.map(v => v * 0.55));
  const bright = paint(() => [205, 205, 198]);
  const size = 620 * 0.16;
  const marks = [[0.18, 0.18, [220, 50, 45]], [0.82, 0.18, [40, 200, 160]], [0.82, 0.82, [60, 100, 230]], [0.18, 0.82, [225, 215, 80]]];
  const marker = paint((sx, sy, c) => {
    for (const [mx, my, col] of marks) {
      const X = mx * 1000, Y = my * 620;
      if (Math.abs(sx - X) <= size / 2 && Math.abs(sy - Y) <= size / 2) { const g = (col[0] + col[1] + col[2]) / 3; return col.map(v => (g + (v - g) * sat) * gain); }
      if (Math.abs(sx - X) <= size * 0.62 && Math.abs(sy - Y) <= size * 0.62) return [8, 8, 10];
    }
    if ((sx / 125) % 1 < 0.03 || (sy / 77.5) % 1 < 0.04) return [150, 150, 150];
    return c.map(v => v * 0.55);
  });
  // Lit stage floor with small dark stickers (camera px radius r).
  const floor = paint((sx, sy, c, x, y) => {
    for (const st of stickers) if (Math.hypot(x + 0.5 - st.x, y + 0.5 - st.y) <= st.r) return [30, 28, 26];
    return [150, 150, 146];
  });
  const truth = SC.map(p => ({x: p.x / w, y: p.y / h}));
  return {dark, bright, marker, floor, truth, SC};
}

const frame = f => ({...f, videoWidth: 640, videoHeight: 480, scale: {scaleX: 640 / 480, scaleY: 480 / 360}});
function alignPipeline(s) {
  const bright = fitBrightQuad(s.dark.data, s.bright.data, 480, 360);
  const read = alignFromFrame(frame(s.marker), s.bright.data, {roi: bright.corners ? roiFromQuad(bright.corners) : null});
  const border = fitScreenBorder(s.bright.data, 480, 360);
  return chooseAlignQuad({markers: read, border, bright, videoAspect: 4 / 3});
}
const worst = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

test('far camera: small screen (~10-20% of frame) aligns within 2% of the frame', { skip: !hasStudioFixtures }, () => {
  for (const opt of [{k: 1}, {k: 0.75}, {k: 0.75, sat: 0.5, gain: 0.6}, {k: 0.55, sat: 0.5, gain: 0.6}, {k: 0.45, sat: 0.5, gain: 0.6}]) {
    const s = synth(opt);
    const choice = alignPipeline(s);
    assert.ok(choice.ok, JSON.stringify(opt) + ': ' + choice.reason);
    assert.ok(worst(choice.corners, s.truth) < 0.02, JSON.stringify(opt) + ' off by ' + worst(choice.corners, s.truth).toFixed(3) + ' via ' + choice.source);
  }
});

test('far camera: angled (keystoned) small screen aligns in a dark room', { skip: !hasStudioFixtures }, () => {
  const s = synth({screen: [{x: 120, y: 110}, {x: 265, y: 95}, {x: 262, y: 190}, {x: 118, y: 172}], sat: 0.6, gain: 0.7});
  const choice = alignPipeline(s);
  assert.ok(choice.ok, choice.reason);
  assert.ok(worst(choice.corners, s.truth) < 0.04, 'off by ' + worst(choice.corners, s.truth).toFixed(3));
  assert.ok(ALIGN_MIN_AREA <= 0.02);
});

test('far camera: small stickers in a small quad are detected (blob limits follow the quad)', { skip: !hasStudioFixtures }, () => {
  const k = 0.75;
  const SC = SCREEN.map(p => ({x: 150 + (p.x - 150) * k, y: 150 + (p.y - 150) * k}));
  // Three stickers inside the play area, ~2 px radius (area ~12 px < the old 14 px floor).
  const toCam = solveHomography(STAGE, SC);
  const stickers = [[300, 300], [500, 420], [700, 260]].map(([x, y]) => ({...applyHomography(toCam, x, y), r: 2.0}));
  const s = synth({k, stickers});
  const H = homographyFromNormalized(s.truth, 640, 480);
  const scale = {width: 480, height: 360, scaleX: 640 / 480, scaleY: 480 / 360};
  const blobs = detectStickerBlobs(s.floor.data, 480, 360, {stickerSensitivity: 1, homography: H, scale});
  for (const st of stickers) {
    assert.ok(blobs.some(b => Math.hypot(b.x - st.x, b.y - st.y) < 3), 'sticker at ' + st.x.toFixed(0) + ',' + st.y.toFixed(0) + ' found; got ' + JSON.stringify(blobs.map(b => [Math.round(b.x), Math.round(b.y), b.area])));
  }
  assert.equal(stickerQuadScale(0.6), 1, 'close range unchanged');
  assert.ok(stickerQuadScale(0.08) < 0.25);
});
