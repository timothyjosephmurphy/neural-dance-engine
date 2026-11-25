// Studio recording fixes: photographic lastScan survives the wire, a keystoned
// black frame with a speaker on top locks to the white mat, a slender dancer
// passes on size, and visit coverage of 0.074 scans once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DANCER_GATE, dancerShapeReject, detectChangedStickers, fitScanPayload, slimScanTelemetry, unpackThumb, warpGridSize, WARP_MAX_W} from '../neural-dance/src/painting-diff.js';
import {packPaintingTelemetry} from '../neural-dance/live-debug.js';
import {detectPaintingFrameSweep, fitMatBorder, pointInQuad, quadEdgeClasses} from '../neural-dance/src/painting-frame.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {createVisitScan, VISIT_CLEAR_MS, VISIT_COOLDOWN_MS, VISIT_COVERAGE_OFF, VISIT_COVERAGE_ON, visitCoveragePresent} from '../neural-dance/src/visit-scan.js';
import {paintingStatusText} from '../neural-dance/debug-viewer.js';
import {cleanTelemetry} from '../worker/neural-dance-debug.mjs';

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return data;
}
function put(data, w, h, x, y, rgb) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
}
function rgbOf(rgba) {
  const out = new Uint8Array(rgba.length / 4 * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
  }
  return out;
}
function hash01(x, y) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const s = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
  return s(s(hash01(x0, y0), hash01(x0 + 1, y0), tx), s(hash01(x0, y0 + 1), hash01(x0 + 1, y0 + 1), tx), ty);
}
function photo(x, y, shift) {
  const n = valueNoise(x / 28 + shift, y / 24) * 0.62
    + valueNoise(x / 11 + 2, y / 13) * 0.28
    + valueNoise(x / 5, y / 6 + shift) * 0.1;
  const ink = valueNoise(x / 46, y / 32);
  const r = 40 + ink * 90 + n * 70;
  const g = 28 + ink * 40 + n * 55;
  const b = 36 + (1 - ink) * 70 + n * 40;
  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
}

test('photographic lastScan keeps before, after, and diff under the wire budget', () => {
  const w = 480, h = 360;
  const quad = [{x: 46, y: 42}, {x: 434, y: 50}, {x: 420, y: 318}, {x: 58, y: 308}];
  const bare = paint(w, h, (x, y) => photo(x, y, 0));
  const live = paint(w, h, (x, y) => {
    const c = photo(x + 1.5, y, 0.4);
    return [Math.min(255, c[0] + 8), c[1], Math.max(0, c[2] - 6)];
  });
  const found = detectChangedStickers(live, w, h, {quad, reference: rgbOf(bare)});
  assert.ok(found.ok && found.view, found.reason);
  const scan = {
    kind: 'scan', at: 10, settleMs: 900,
    wb: {locked: true, mode: 'manual'}, gains: found.view.gains,
    before: found.view.before, after: found.view.after, diff: found.view.diff,
    blobs: found.view.blobs, rejected: found.view.rejected
  };
  const painting = {active: true, stickerColor: 'white', latched: [], frameLocked: false, lastScan: scan};
  for (const key of ['before', 'after', 'diff']) {
    const img = unpackThumb(scan[key]);
    assert.ok(img && img.w >= 64 && img.w <= 136 && img.h >= 16 && img.rgb.length === img.w * img.h * 3, key + ' ' + (img && img.w));
  }
  let differ = 0;
  const before = unpackThumb(scan.before);
  const after = unpackThumb(scan.after);
  for (let i = 0; i < before.rgb.length; i += 9) if (Math.abs(before.rgb[i] - after.rgb[i]) > 4) differ++;
  assert.ok(differ > 20, 'before and after are the same picture');
  const packed = packPaintingTelemetry(painting);
  assert.ok(packed && packed.lastScan, 'lastScan was deleted');
  assert.equal(packed.lastScan.before, undefined);
  assert.equal(packed.lastScan.after, undefined);
  assert.equal(packed.lastScan.diff, undefined);
  assert.equal(packed.lastScan.images.before, true);
  assert.equal(packed.lastScan.images.after, true);
  assert.equal(packed.lastScan.images.diff, true);
  assert.equal(packed.lastScan.kind, 'scan');
  assert.ok(Array.isArray(packed.lastScan.blobs));
  const wire = {t: 10, fps: 12, painting: packed};
  assert.ok(JSON.stringify(wire).length < 20000, JSON.stringify(wire).length);
  const cleaned = cleanTelemetry(wire);
  assert.ok(cleaned && cleaned.painting && cleaned.painting.lastScan);
  assert.equal(cleaned.painting.lastScan.before, undefined);
  const bulky = {painting: {lastScan: scan}, pad: 'q'.repeat(100000)};
  const bulkyLen = JSON.stringify(bulky).length;
  assert.ok(bulkyLen > 100000, bulkyLen);
  const kept = cleanTelemetry(bulky);
  assert.ok(kept && kept.painting.lastScan);
  assert.equal(kept.painting.lastScan.before, undefined);
  assert.equal(kept.painting.lastScan.kind, 'scan');
  assert.equal(slimScanTelemetry(scan).images.diff, true);
  const huge = {
    kind: 'scan', at: 5,
    blobs: [{reason: 'accept', area: 17, u: 0.4, v: 0.6}],
    rejected: {size: 1},
    before: 'x'.repeat(200000), after: 'y'.repeat(200000), diff: 'z'.repeat(80000)
  };
  const fit = fitScanPayload(huge, 130000);
  assert.ok(fit && fit.blobs && fit.blobs[0].area === 17);
  assert.ok(!fit.before && !fit.after && !fit.diff);
  const viaPack = packPaintingTelemetry({active: true, stickerColor: 'white', latched: [], lastScan: huge});
  assert.ok(viaPack && viaPack.lastScan && viaPack.lastScan.blobs[0].area === 17);
});

// Camera above the painting: the mat is a keystone, wider at the top, with a
// black speaker sitting on the top of the black frame.
function keystoneScene() {
  const w = 480, h = 360;
  const inner = [{x: 64, y: 152}, {x: 424, y: 162}, {x: 406, y: 294}, {x: 82, y: 284}];
  const outer = [{x: 46, y: 134}, {x: 442, y: 144}, {x: 424, y: 310}, {x: 64, y: 300}];
  const opening = [{x: 88, y: 172}, {x: 412, y: 178}, {x: 396, y: 276}, {x: 108, y: 268}];
  const rgba = paint(w, h, (x, y) => {
    const j = ((x * 13 + y * 7) % 5) - 2;
    let c = [158 + j, 92 + j, 42 + j];
    if (x > w * 0.72 && !pointInQuad(outer, x, y)) c = [24 + j, 24 + j, 28 + j];
    if (x >= 168 && x <= 300 && y >= 36 && y <= 148) c = [14, 14, 16];
    if (pointInQuad(outer, x, y)) c = [16 + (j > 0 ? 1 : 0), 16, 18];
    if (pointInQuad(inner, x, y)) c = [214, 208 + j, 200];
    if (pointInQuad(opening, x, y)) c = [78 + j, 26, 34];
    return c;
  });
  return {rgba, w, h, inner};
}
function widths(q) {
  return {
    top: Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y),
    bot: Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)
  };
}
function assertKeystone(quad, label) {
  const truth = [{x: 64, y: 152}, {x: 424, y: 162}, {x: 406, y: 294}, {x: 82, y: 284}];
  const got = widths(quad);
  const want = widths(truth);
  assert.ok(got.top > got.bot + 20, label + ' flattened ' + got.top.toFixed(1) + ' vs ' + got.bot.toFixed(1));
  assert.ok(Math.abs(got.top - want.top) < 8, label + ' top width ' + got.top.toFixed(1));
  assert.ok(Math.abs(got.bot - want.bot) < 8, label + ' bottom width ' + got.bot.toFixed(1));
  quad.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - truth[i].x, p.y - truth[i].y) < 6, label + ' corner ' + i + ' ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
  });
  assert.ok(Math.abs(quad[0].x - quad[3].x) > 10, label + ' left edge is vertical');
  assert.ok(Math.abs(quad[1].x - quad[2].x) > 10, label + ' right edge is vertical');
  assert.ok(Math.min(quad[0].y, quad[1].y) > 130, label + ' climbed into the speaker');
}

test('keystoned black frame with a speaker on top locks to the slanted white mat', () => {
  const {rgba, w, h} = keystoneScene();
  const border = fitMatBorder(rgba, w, h);
  assert.ok(border && border.matSides >= 3, border && border.matSides);
  assertKeystone(border.quad, 'border');
  const found = detectPaintingFrameSweep(rgba, w, h);
  assert.equal(found.ok, true, found.reason);
  assertKeystone(found.quad, 'sweep');
  const classes = quadEdgeClasses(rgba, w, h, found.quad);
  assert.ok(classes.filter(c => c.kind === 'mat').length >= 3, classes.map(c => c.kind).join(','));
  assert.equal(classes.some(c => c.kind === 'outside'), false);
});

test('a failed Detect keeps a locked manual frame', () => {
  const manual = [{x: 0.2, y: 0.42}, {x: 0.84, y: 0.44}, {x: 0.8, y: 0.78}, {x: 0.18, y: 0.76}];
  const session = createPaintingSession();
  assert.equal(session.lockFrame(manual), true);
  const failed = session.detect({data: new Uint8ClampedArray(24 * 24 * 4), width: 24, height: 24});
  assert.equal(failed.ok, false);
  assert.equal(failed.fallback, 'manual frame lock');
  assert.equal(session.frameLocked(), true);
  assert.equal(session.frameQuad()[0].x, manual[0].x);
  assert.equal(session.frameQuad()[1].y, manual[1].y);
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  const branch = cam.slice(cam.indexOf("command.action === 'frame-detect' || command.action === 'frame-retry'"), cam.indexOf("command.action === 'frame-accept'"));
  assert.equal(branch.includes('unlockFrame'), false);
  const lockedText = paintingStatusText({
    frameLocked: true,
    pendingInfo: {ok: false, reason: 'frame left the projector prior'},
    active: true, stickerColor: 'white', reference: {ready: true}, latched: []
  });
  assert.equal(lockedText.includes('no frame found:'), false);
  assert.match(lockedText, /Frame: manual \(locked\)/);
  const openText = paintingStatusText({
    frameLocked: false,
    pendingInfo: {ok: false, reason: 'no mat band'},
    active: false, stickerColor: 'dark', reference: {ready: false, frames: 0, need: 4}, latched: []
  });
  assert.match(openText, /no frame found: no mat band/);
});

// A connected 8-wide cameo. The shoulders set the bbox width so a 2 px blur
// cannot shrink the aspect below the dancer gate.
const SLENDER = [
  '..####..',
  '..####..',
  '..####..',
  '.######.',
  '.######.',
  '########',
  '########',
  '########',
  '.######.',
  '.######.',
  '.######.',
  '.######.',
  '.######.',
  '..####..',
  '..####..',
  '..####..',
  '..#..#..',
  '..#..#..',
  '..#..#..',
  '..#..#..',
  '..#..#..',
  '..#..#..'
];
function stampSlender(data, w, h, x0, y0, bw, bh, rgb) {
  for (let y = 0; y < bh; y++) {
    const row = SLENDER[Math.min(SLENDER.length - 1, Math.floor(y * SLENDER.length / bh))];
    for (let x = 0; x < bw; x++) {
      const col = row[Math.min(row.length - 1, Math.floor(x * row.length / bw))];
      if (col === '#') put(data, w, h, x0 + x, y0 + y, rgb);
    }
  }
}
function disk(data, w, h, cx, cy, rx, ry, rgb) {
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    if ((x - cx) ** 2 / (rx * rx) + (y - cy) ** 2 / (ry * ry) <= 1) put(data, w, h, x, y, rgb);
  }
}
function ring(data, w, h, cx, cy, r0, r1, rgb) {
  for (let y = cy - r1 - 1; y <= cy + r1 + 1; y++) for (let x = cx - r1 - 1; x <= cx + r1 + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= r0 && d <= r1) put(data, w, h, x, y, rgb);
  }
}
function detail(found) {
  return JSON.stringify({rejected: found.rejected, blobs: found.view && found.view.blobs});
}

test('a slender dancer passes and sun, gradient, circle, oval, ring, and streak do not', () => {
  const w = 420, h = 310;
  const quad = [{x: 30, y: 28}, {x: 390, y: 28}, {x: 390, y: 283}, {x: 30, y: 283}];
  const base = () => [52, 46, 58];
  const bare = paint(w, h, base);
  const ref = rgbOf(bare);
  const dancer = paint(w, h, base);
  stampSlender(dancer, w, h, 180, 120, 8, 36, [236, 228, 214]);
  const hit = detectChangedStickers(dancer, w, h, {quad, reference: ref});
  assert.equal(hit.stickers.length, 1, detail(hit));
  const smallW = 280, smallH = 210;
  const smallQuad = [{x: 20, y: 16}, {x: 260, y: 16}, {x: 260, y: 186}, {x: 20, y: 186}];
  const smallBare = paint(smallW, smallH, (x, y) => base(x, y));
  const small = paint(smallW, smallH, (x, y) => base(x, y));
  stampSlender(small, smallW, smallH, 120, 70, 5, 25, [236, 228, 214]);
  const thin = detectChangedStickers(small, smallW, smallH, {quad: smallQuad, reference: rgbOf(smallBare)});
  assert.equal(thin.stickers.length, 1, detail(thin));
  const speckle = paint(w, h, base);
  for (let y = 140; y < 143; y++) for (let x = 200; x < 203; x++) put(speckle, w, h, x, y, [240, 240, 236]);
  put(speckle, w, h, 90, 150, [240, 236, 230]);
  put(speckle, w, h, 91, 150, [240, 236, 230]);
  const specks = detectChangedStickers(speckle, w, h, {quad, reference: ref});
  assert.equal(specks.stickers.length, 0, detail(specks));
  const shapes = [
    ['circle', (frame) => disk(frame, w, h, 200, 160, 16, 16, [250, 248, 240])],
    ['oval', (frame) => disk(frame, w, h, 200, 160, 12, 22, [250, 248, 240])],
    ['ring', (frame) => ring(frame, w, h, 200, 160, 8, 14, [255, 246, 220])],
    ['streak', (frame) => { for (let x = 150; x < 230; x++) for (let y = 170; y < 174; y++) put(frame, w, h, x, y, [250, 248, 240]); }]
  ];
  for (const [name, draw] of shapes) {
    const frame = paint(w, h, base);
    draw(frame);
    const found = detectChangedStickers(frame, w, h, {quad, reference: ref});
    assert.equal(found.stickers.length, 0, name + ' ' + detail(found));
  }
  const sun = paint(w, h, (x, y) => {
    const d = Math.hypot(x - 210, y - 70);
    if (d < 18) return [255, 255, 250];
    if (d < 40) return [255, Math.round(240 - d), Math.round(200 - d * 2)];
    return base(x, y);
  });
  const bloom = detectChangedStickers(sun, w, h, {quad, reference: ref});
  assert.equal(bloom.stickers.length, 0, detail(bloom));
  const graded = paint(w, h, (x, y) => {
    const c = base(x, y);
    const add = 70 * (x / (w - 1));
    return [Math.min(255, c[0] + add), Math.min(255, c[1] + add * 0.6), Math.min(255, c[2] + add * 0.2)];
  });
  const ramp = detectChangedStickers(graded, w, h, {quad, reference: ref});
  assert.equal(ramp.stickers.length, 0, detail(ramp));
});

test('visit coverage 0.074 scans once and returns to idle', () => {
  assert.equal(VISIT_COVERAGE_ON, 0.055);
  assert.ok(VISIT_COVERAGE_OFF < VISIT_COVERAGE_ON);
  assert.equal(visitCoveragePresent(0.074, false, false, false), true);
  assert.equal(visitCoveragePresent(0.05, false, false, false), false);
  assert.equal(visitCoveragePresent(0.05, false, false, true), true);
  assert.equal(visitCoveragePresent(0.03, false, false, true), false);
  assert.equal(visitCoveragePresent(0.074, true, false, true), false);
  const visit = createVisitScan();
  let latched = false;
  const caps = [];
  const tick = (cov, now, sceneMatch = true) => {
    const present = visitCoveragePresent(cov, false, false, latched);
    latched = present && cov >= VISIT_COVERAGE_OFF;
    const step = visit.observe({present, now, learned: true, sceneMatch});
    if (step.scan) caps.push(now);
    return step;
  };
  assert.equal(tick(0.074, 0).state, 'person');
  assert.equal(tick(0, 120).scan, false);
  assert.equal(tick(0, 120 + VISIT_CLEAR_MS).scan, true);
  visit.noteResult(1);
  assert.equal(visit.observe({present: false, now: 120 + VISIT_CLEAR_MS + 20, learned: true, sceneMatch: true}).state, 'idle');
  visit.quiet(4000, VISIT_COOLDOWN_MS);
  const mid = 4000 + 400;
  assert.equal(tick(0.074, mid).scan, false);
  assert.equal(tick(0, mid + VISIT_CLEAR_MS).scan, false);
  assert.deepEqual(caps, [120 + VISIT_CLEAR_MS]);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const obs = show.slice(show.indexOf('visitCoveragePresent'), show.indexOf('setVisitState'));
  assert.match(obs, /visitCoveragePresent/);
  assert.match(obs, /sceneMatchesVisit/);
  assert.equal(/sceneMatch:\s*true/.test(obs), false);
});

test('dancer solidity gate admits a 0.92 cameo and the warp stays capped', () => {
  assert.equal(DANCER_GATE.maxSolidity, 0.93);
  assert.equal(DANCER_GATE.solidCircularity, 0.58);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.66, circularity: 0.45, aspect: 0.4}), false);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.67, circularity: 0.49, aspect: 0.4}), false);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.64, circularity: 0.53, aspect: 0.4}), false);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.66, circularity: 0.52, aspect: 0.4}), false);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.65, circularity: 0.65, aspect: 0.42}), true);
  assert.equal(dancerShapeReject({solidity: 0.94, templateIoU: 0.7, circularity: 0.4, aspect: 0.4}), true);
  assert.equal(dancerShapeReject({solidity: 0.92, templateIoU: 0.4, circularity: 0.45, aspect: 0.4}), true);
  const wide = warpGridSize(1400, 800);
  assert.ok(wide.gw <= WARP_MAX_W && wide.gw >= 900, JSON.stringify(wide));
  assert.ok(Math.abs(wide.gw / wide.gh - 1400 / 800) < 0.05, JSON.stringify(wide));
  const phone = warpGridSize(360, 255);
  assert.equal(phone.gw, 360);
  assert.equal(phone.gh, 255);
});

test('a detect-size dancer passes on the full quad, and a disk does not at either size', () => {
  function atScale(scale) {
    const w = Math.round(420 * scale), h = Math.round(310 * scale);
    const quad = [{x: 30, y: 28}, {x: 390, y: 28}, {x: 390, y: 283}, {x: 30, y: 283}].map(p => ({x: p.x * scale, y: p.y * scale}));
    const base = () => [52, 46, 58];
    const bare = paint(w, h, base);
    const dancer = paint(w, h, base);
    stampSlender(dancer, w, h, 180 * scale, 120 * scale, 8 * scale, 36 * scale, [236, 228, 214]);
    const hit = detectChangedStickers(dancer, w, h, {quad, reference: rgbOf(bare)});
    const circle = paint(w, h, base);
    disk(circle, w, h, 200 * scale, 160 * scale, 16 * scale, 16 * scale, [250, 248, 240]);
    const round = detectChangedStickers(circle, w, h, {quad, reference: rgbOf(bare)});
    return {hit, round, grid: hit.grid};
  }
  const low = atScale(1);
  const high = atScale(2);
  assert.equal(low.hit.stickers.length, 1, detail(low.hit));
  assert.equal(low.hit.grid.gw, 360);
  assert.equal(low.hit.grid.gh, 255);
  assert.ok(high.grid.gw > low.grid.gw && high.grid.gw <= WARP_MAX_W, JSON.stringify(high.grid));
  assert.equal(high.grid.gw, warpGridSize(720, 510).gw);
  assert.equal(high.grid.gh, warpGridSize(720, 510).gh);
  assert.equal(low.round.stickers.length, 0, detail(low.round));
  assert.equal(high.round.stickers.length, 0, detail(high.round));
  const accepted = (high.hit.view.blobs || []).filter(blob => blob.reason === 'accept');
  for (const blob of accepted) assert.ok(blob.solidity <= DANCER_GATE.maxSolidity, JSON.stringify(blob));
  for (const sticker of high.hit.stickers) {
    assert.ok(sticker.x > 60 + 2 && sticker.x < 780 - 2 && sticker.y > 56 + 2 && sticker.y < 566 - 2);
  }
});
