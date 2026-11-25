// Studio Nov 23 live-show regressions: visit arming, the pause banner,
// clear-floor Scan stickers, debug stills, and low-contrast dancer stickers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANGE_STICKER, blurPlane, detectChangedStickers, dilateMask, suppressShiftedStickers, unpackThumb, warpGridSize} from '../src/painting-diff.js';
import {insetQuad} from '../src/painting-frame.js';
import {createPaintingSession, scannedFigureHeight, SCANNED_FIGURE_MIN, SCANNED_FIGURE_MAX} from '../src/painting-session.js';
import {readFileSync} from 'node:fs';
import {FLASH_FADE_MS, FLASH_MIN_MS, FLASH_POLL_MS, FLASH_STABLE_FRAMES, runStickerFlash} from '../src/sticker-flash.js';
import {CANVAS_H, clearAutoScanMarkersCam, RELOAD_LATCH_KEY, toDancerMarkers} from '../camera-markers.js';
import {mergeScanPoints} from '../src/blank-scan.js';
import {clampFigureHeight, fallbackDancerHeight, MAX_FIGURE_HEIGHT, UNSCANNED_FIGURE_HEIGHT} from '../src/silhouette.js';
import {createStickerScan} from '../src/scan-session.js';
import {
  PERSON_ENTER_FRAMES,
  PERSON_EXIT_FRAMES,
  PERSON_PAUSE_NOTE,
  PERSON_RESUME_NOTE,
  coverageFromRead,
  createPersonOcclusion,
  personCuts,
  syncPersonNote
} from '../src/person-occlusion.js';
import {createVisitScan, VISIT_CLEAR_MS, VISIT_COOLDOWN_MS} from '../src/visit-scan.js';
import {BARE_HOLD_MAX_MS, BARE_HOLD_MIN_MS, currentVisitScan, relearnBarePaintingNow, scanFloorBlocked, scanStickersNow} from '../live-show.js';
import {formatScanMeta, paintLastScan} from '../debug-viewer.js';

test('coverage follows the sensitivity-scaled skin bar', () => {
  const cuts = personCuts(0.35);
  assert.ok(cuts.skin < 0.04);
  assert.ok(cuts.skin <= 0.034);
  const read = {
    background: true,
    skinFraction: 0.034,
    bodyFraction: 0,
    fraction: 0.034,
    staticFraction: 0.8,
    sensitivity: 0.35,
    cuts
  };
  assert.ok(coverageFromRead(read) > 0, 'skin 0.034 at sensitivity 0.35');
  assert.equal(coverageFromRead({...read, skinFraction: 0.01, fraction: 0.01, cuts: personCuts(0)}), 0);
});

test('the pause banner stays up across a motion hold and the settle', () => {
  const gate = createPersonOcclusion({enterFrames: PERSON_ENTER_FRAMES, exitFrames: PERSON_EXIT_FRAMES, clearMs: 1000});
  const el = {hidden: true, textContent: ''};
  const doc = {querySelector(sel) { return sel === '[data-person-note]' ? el : null; }};
  const seen = [];
  const watch = (decision) => {
    syncPersonNote(doc, decision.note || false);
    if (decision.paused) {
      seen.push(decision.note);
      assert.ok(decision.note, 'paused note was ' + decision.note + ' held ' + decision.held);
      assert.equal(el.hidden, false);
      assert.ok(el.textContent);
    }
    return decision;
  };
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) watch(gate.observe({person: true, now: i * 10}));
  const motion = watch(gate.observe({
    person: {present: false, holding: false, motion: 0.08},
    now: 100
  }));
  assert.equal(motion.paused, true);
  assert.equal(motion.held, 'motion');
  assert.equal(motion.note, PERSON_PAUSE_NOTE);
  let settling = null;
  for (let i = 0; i < PERSON_EXIT_FRAMES; i++) {
    settling = watch(gate.observe({person: false, now: 200 + i * 10}));
  }
  assert.equal(settling.settling, true);
  assert.equal(settling.paused, true);
  assert.equal(settling.note, PERSON_RESUME_NOTE);
  assert.equal(el.textContent, PERSON_RESUME_NOTE);
  assert.ok(seen.every(note => note === PERSON_PAUSE_NOTE || note === PERSON_RESUME_NOTE));
});

test('a visit arms on a person even when the settled picture no longer matches', () => {
  const visit = createVisitScan();
  visit.observe({present: true, now: 0, learned: true, sceneMatch: true});
  visit.observe({present: false, now: 100, learned: true, sceneMatch: true});
  assert.equal(visit.observe({present: false, now: 100 + VISIT_CLEAR_MS, learned: true, sceneMatch: true}).scan, true);
  visit.noteResult(1);
  visit.quiet(2000, VISIT_COOLDOWN_MS);
  assert.equal(visit.ready(), false);
  const after = 2000 + VISIT_COOLDOWN_MS;
  assert.equal(visit.observe({present: true, now: after - 10, learned: true, sceneMatch: true}).state, 'idle');
  assert.equal(visit.observe({present: true, now: after, learned: true, sceneMatch: false}).state, 'person');
  assert.equal(visit.ready(), true);
  assert.equal(visit.observe({present: false, now: after + 5, learned: true, sceneMatch: false}).scan, false);
  assert.equal(visit.observe({present: true, now: after + 20, learned: true, sceneMatch: true}).state, 'person');
  assert.equal(visit.ready(), true);
  const left = after + 40;
  visit.observe({present: false, now: left, learned: true, sceneMatch: true});
  assert.equal(visit.observe({present: false, now: left + VISIT_CLEAR_MS, learned: true, sceneMatch: true}).scan, true);
});

function classList(set) {
  return {
    contains: (name) => set.has(name),
    add: (name) => set.add(name),
    remove: (name) => set.delete(name)
  };
}

function stageDoc(cam) {
  const bodySet = new Set();
  const room = {dataset: {}, neuralDance: {redraw() {}}};
  const flash = {hidden: true, dataset: {}, style: {opacity: ''}, removeAttribute(name) { if (name === 'data-mode') this.dataset.mode = ''; }};
  let veil = null;
  const body = {
    classList: classList(bodySet),
    dataset: {},
    appendChild(node) { veil = node; }
  };
  return {
    body,
    createElement() {
      return {setAttribute() {}, style: {}, hidden: false, remove() {}};
    },
    querySelector(sel) {
      if (sel === '[data-align-flash]') return flash;
      if (sel === '[data-align-cancel-zone]') return {hidden: true};
      if (sel === '[data-bare-white]') return veil;
      return null;
    },
    getElementById(id) {
      if (id === 'nd-room-lab') return room;
      if (id === 'nd-camera-mode') return {neuralDanceCamera: cam};
      return null;
    }
  };
}

function camera(over = {}) {
  const frame = {data: new Uint8ClampedArray(8 * 8 * 4).fill(240), width: 8, height: 8};
  const cam = {
    visitSceneRequired: false,
    visitQuietUntil: 0,
    visitScene: null,
    lastPersonRead: null,
    lastOcclusion: null,
    holds: 0,
    reports: [],
    grabFrame: () => frame,
    scanWhiteFrame: () => ({ok: true, count: 1, applied: true}),
    learnPaintingReference: () => true,
    ensureCamera: async () => true,
    personInView: () => false,
    personInWhiteFrame: () => false,
    holdVisit() { cam.holds += 1; },
    setStickerFlashReport(state) { cam.reports.push(state); },
    setVisitState(step) {
      cam.visitState = {state: step.state, label: step.label, coverage: step.coverage};
      return cam.visitState;
    },
    sceneMatchesVisit: () => true,
    noteScanMeta() {}
  };
  return Object.assign(cam, over);
}

test('re-learn arms the next visit and a clear-floor scan is not blocked by a stale person latch', async () => {
  const visit = currentVisitScan();
  visit.quiet(Date.now(), VISIT_COOLDOWN_MS);
  assert.equal(visit.ready(), false);

  const cam = camera();
  const doc = stageDoc(cam);
  const learned = await relearnBarePaintingNow(doc, {holdMs: 0, fadeMs: 0});
  assert.equal(learned, true);
  assert.equal(visit.ready(), true);
  assert.equal(cam.visitSceneRequired, false);
  assert.equal(cam.holds, 0);
  assert.equal(visit.observe({present: true, now: 50, learned: true, sceneMatch: true}).state, 'person');
  visit.observe({present: false, now: 80, learned: true, sceneMatch: true});
  assert.equal(visit.observe({present: false, now: 80 + VISIT_CLEAR_MS, learned: true, sceneMatch: true}).scan, true);

  visit.arm();
  cam.lastPersonRead = {present: true, holding: true};
  cam.lastOcclusion = {paused: true, held: 'person'};
  cam.personInView = () => true;
  assert.equal(scanFloorBlocked(cam), true);
  cam.reports = [];
  cam.holds = 0;
  const deferred = await scanStickersNow(doc, {holdMs: 0, fadeMs: 0, fromDebug: true});
  assert.equal(deferred && deferred.state, 'deferred');
  assert.equal(cam.holds, 0);
  assert.equal(visit.ready(), true);

  cam.lastPersonRead = {present: false, holding: false, skinFraction: 0};
  cam.lastOcclusion = {paused: false, held: ''};
  cam.reports = [];
  cam.holds = 0;
  const aborted = await scanStickersNow(doc, {holdMs: 0, fadeMs: 0, fromDebug: true, alive: () => false});
  assert.equal(aborted && aborted.state, 'aborted');
  assert.ok(!cam.reports.some(state => state.state === 'flashing'));
  assert.equal(cam.holds, 0);
  assert.equal(visit.ready(), true);

  // The studio latch: personInView stays true while the person gate is clear.
  cam.personInView = () => true;
  cam.reports = [];
  assert.equal(scanFloorBlocked(cam), false);
  const scanned = await scanStickersNow(doc, {holdMs: 0, fadeMs: 0, fromDebug: true});
  assert.ok(cam.reports.some(state => state.state === 'fading-in' || state.state === 'flashing'));
  assert.equal(scanned && scanned.state, 'done');

  const book = createStickerScan();
  book.restore([{id: 3, x: 40, y: 50, kind: 'sticker'}, {id: 4, x: 180, y: 90, kind: 'sticker'}]);
  const manuals = [{id: 9, x: 12, y: 14, manual: true}];
  cam.stickerScan = book;
  cam.manuals = {list: () => manuals};
  cam.scanAccum = [{x: 1, y: 1}];
  cam.scanConfirmed = true;
  cam.publishScan = () => { cam.published = book.markers().length; };
  cam.clearAutoScanMarkers = () => clearAutoScanMarkersCam(cam);
  let phase = 'idle';
  cam.lockWhiteBalance = async () => { phase = 'locked'; };
  cam.learnPaintingReference = () => {
    assert.equal(phase, 'locked', 'white balance locks while the flash is still up');
    return true;
  };
  const room = doc.getElementById('nd-room-lab');
  let homes = 0;
  room.neuralDance.commitStickerHomes = () => { homes += 1; };
  const cleared = await relearnBarePaintingNow(doc, {holdMs: 0, fadeMs: 0});
  assert.equal(cleared, true);
  assert.equal(book.markers().length, 0);
  assert.equal(cam.published, 0);
  assert.equal(cam.scanAccum.length, 0);
  assert.equal(homes, 1);
  assert.equal(manuals.length, 1);

  const manual = {state: 'done', count: 4, reason: 'manual flash'};
  cam.reports = [];
  cam.setStickerFlashReport(manual);
  assert.equal(await scanStickersNow(doc, {auto: true}), null);
  assert.equal(await scanStickersNow(doc, {personCheck: true}), null);
  assert.equal(await scanStickersNow(doc, {confident: true}), null);
  assert.equal(cam.reports.length, 1);
  assert.equal(cam.reports[0], manual);
});

test('debug stills name the scan kind and a missing view key', () => {
  const el = {text: ''};
  const doc = {
    querySelector(sel) {
      if (sel === '[data-debug-still-meta]') return {set textContent(value) { el.text = value; }, get textContent() { return el.text; }};
      if (sel === '[data-debug-still-blobs]') return {textContent: ''};
      return null;
    }
  };
  const relearn = {kind: 'relearn', blobs: [{reason: 'accept', u: 0.3, v: 0.6, x: 1, y: 2, area: 10}], rejected: {size: 1}};
  assert.match(formatScanMeta(relearn), /^Re-learn: 1 accepted, 1 rejected/);
  assert.equal(paintLastScan(doc, {painting: {lastScan: relearn}}, {room: 'studio'}), true);
  assert.match(el.text, /Re-learn/);
  assert.match(el.text, /1 accepted, 1 rejected/);
  assert.match(el.text, /view key missing/);
  const scan = {kind: 'scan', blobs: [{reason: 'accept'}, {reason: 'shape'}], rejected: {shape: 1}, settleMs: 900, wb: {locked: true, mode: 'manual'}, gains: [1, 1, 1]};
  assert.match(formatScanMeta(scan), /^Sticker scan: 1 accepted, 1 rejected/);
  const view = {room: 'studio', key: 'k'};
  assert.equal(paintLastScan(doc, {painting: {lastScan: scan}}, view), true);
  assert.match(el.text, /Sticker scan/);
  assert.equal(/view key missing/.test(el.text), false);
});

const CAMEO = [
  '..####..',
  '..####..',
  '.######.',
  '########',
  '########',
  '.######.',
  '.######.',
  '..####..',
  '..#..#..',
  '..#..#..',
  '..#..#..'
];

function paint(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return data;
}

function stampCameo(data, w, h, x0, y0, bw, bh, rgb) {
  for (let y = 0; y < bh; y++) {
    const row = CAMEO[Math.min(CAMEO.length - 1, Math.floor(y * CAMEO.length / bh))];
    for (let x = 0; x < bw; x++) {
      const col = row[Math.min(row.length - 1, Math.floor(x * row.length / bw))];
      if (col !== '#') continue;
      const xx = x0 + x, yy = y0 + y;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
    }
  }
}

function rgbOf(data) {
  const out = new Uint8Array(data.length / 4 * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2];
  }
  return out;
}

test('low-contrast gold and gray dancer silhouettes are found on a full-white warp', () => {
  const w = 960, h = 445;
  const ground = [198, 194, 186];
  const bare = paint(w, h, () => ground);
  const quad = [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}];
  const ref = rgbOf(bare);
  const same = detectChangedStickers(bare, w, h, {quad, reference: ref, inset: 0});
  assert.equal(same.stickers.length, 0, JSON.stringify(same.rejected));
  const drifted = paint(w, h, (x) => ground.map(channel => Math.min(255, channel + Math.round(18 * x / w))));
  const drift = detectChangedStickers(drifted, w, h, {quad, reference: ref, inset: 0});
  assert.equal(drift.stickers.length, 0, JSON.stringify(drift.rejected));
  const live = bare.slice();
  // Matte gold and a gray cameo. The channel step is real but well under a
  // white sticker, which is the studio failure (gold dC ~67, gray dL ~40).
  stampCameo(live, w, h, 180, 80, 18, 48, [168, 124, 48]);
  stampCameo(live, w, h, 520, 140, 18, 48, [142, 140, 136]);
  const found = detectChangedStickers(live, w, h, {quad, reference: ref, inset: 0});
  assert.equal(found.stickers.length, 2, JSON.stringify({rejected: found.rejected, blobs: found.view && found.view.blobs}));
  const spots = found.stickers.map(sticker => sticker.x / w);
  assert.ok(spots.some(u => u > 0.12 && u < 0.35), spots.join(','));
  assert.ok(spots.some(u => u > 0.45 && u < 0.7), spots.join(','));
});

test('scan stills stay unpainted until the uploaded JPEGs load, then reload when the flags flip', () => {
  const loads = [];
  class ViewImage {
    set src(value) { this._src = value; loads.push(this); }
    get src() { return this._src || ''; }
  }
  const previous = globalThis.Image;
  globalThis.Image = ViewImage;
  const held = {text: ''};
  const canvas = {width: 0, height: 0, getContext() { return {drawImage() {}}; }};
  const doc = {
    querySelector(sel) {
      if (sel === '[data-debug-still-meta]') return {set textContent(value) { held.text = value; }, get textContent() { return held.text; }};
      if (sel === '[data-debug-still-blobs]') return {textContent: ''};
      if (sel === '[data-debug-still-before]' || sel === '[data-debug-still-after]' || sel === '[data-debug-still-diff]') return canvas;
      return null;
    }
  };
  try {
    const view = {room: 'studio', key: 'viewer-key'};
    const base = {kind: 'scan', scanId: 4, blobs: [], rejected: {}, images: {before: false, after: false, diff: false}};
    paintLastScan(doc, {painting: {lastScan: base}}, view);
    assert.match(held.text, /stills loading/);
    assert.equal(view.lastScanPainted || '', '');
    assert.equal(loads.length, 0);
    paintLastScan(doc, {painting: {lastScan: {...base, images: {before: true, after: true, diff: true}}}}, view);
    assert.equal(loads.length, 3);
    assert.equal(view.lastScanPainted || '', '');
    assert.match(String(loads[0].src), /scan=4/);
    for (const img of loads) {
      img.naturalWidth = 32;
      img.naturalHeight = 24;
      img.onload();
    }
    assert.match(view.lastScanPainted, /^4:0:111$/);
    const again = loads.length;
    paintLastScan(doc, {painting: {lastScan: {...base, images: {before: true, after: true, diff: true}}}}, view);
    assert.equal(loads.length, again);
  } finally {
    if (previous) globalThis.Image = previous;
    else delete globalThis.Image;
  }
});

test('the white hold waits 600 ms and three stable frames', () => {
  assert.equal(FLASH_MIN_MS, 600);
  assert.equal(FLASH_STABLE_FRAMES, 3);
});

test('a split thin dancer is one figure, edge and unlit borders are not, and a shifting speck is dropped', () => {
  const w = 480, h = 360;
  const quad = [{x: 8, y: 8}, {x: w - 8, y: 8}, {x: w - 8, y: h - 8}, {x: 8, y: h - 8}];
  const ground = [48, 42, 54];
  const bare = paint(w, h, () => ground);
  const ref = rgbOf(bare);
  const split = bare.slice();
  stampCameo(split, w, h, 200, 80, 16, 18, [236, 228, 214]);
  stampCameo(split, w, h, 200, 112, 16, 22, [236, 228, 214]);
  const joined = detectChangedStickers(split, w, h, {quad, reference: ref});
  const pieces = (joined.view && joined.view.blobs || []).filter(blob => blob && blob.u > 0.3 && blob.u < 0.6);
  assert.ok(joined.stickers.length === 1 || pieces.length === 1, JSON.stringify({rejected: joined.rejected, blobs: pieces}));
  const edge = bare.slice();
  stampCameo(edge, w, h, w - 18, 80, 14, 40, [236, 228, 214]);
  const border = detectChangedStickers(edge, w, h, {quad, reference: ref});
  assert.equal(border.stickers.length, 0, JSON.stringify(border.rejected));
  const darkRight = paint(w, h, (x, y) => (x > w * 0.94 ? [18, 16, 20] : [230, 226, 218]));
  const overhang = darkRight.slice();
  stampCameo(overhang, w, h, Math.round(w * 0.9), 70, 14, 36, [40, 36, 34]);
  const masked = detectChangedStickers(overhang, w, h, {quad, reference: rgbOf(darkRight), short: {right: true}});
  assert.equal(masked.stickers.filter(sticker => sticker.x / w > 0.88).length, 0);
  const shifted = suppressShiftedStickers(
    [{u: 0.37, v: 0.16, uvH: 0.05, x: 10, y: 20}],
    [[{u: 0.34, v: 0.14}]]
  );
  assert.equal(shifted.kept.length, 0);
  assert.equal(shifted.dropped.length, 1);
  const dancer = suppressShiftedStickers(
    [{u: 0.4, v: 0.5, uvH: 0.18, x: 40, y: 80}],
    [[{u: 0.37, v: 0.48}]]
  );
  assert.equal(dancer.kept.length, 1);
});

test('a rejected candidate is not baked into the baseline, and sticker height is the painting share of the stage', () => {
  const w = 160, h = 120;
  const quad = [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}];
  const bare = paint(w, h, () => [52, 46, 58]);
  const session = createPaintingSession();
  assert.equal(session.accept(quad), true);
  assert.equal(session.learnReference([{data: bare, width: w, height: h}], 1000), true);
  const withDisk = bare.slice();
  for (let y = 40; y < 78; y++) for (let x = 50; x < 88; x++) {
    if ((x - 69) ** 2 + (y - 59) ** 2 <= 16 * 16) {
      const i = (y * w + x) * 4;
      withDisk[i] = 250; withDisk[i + 1] = 248; withDisk[i + 2] = 240;
    }
  }
  const first = session.scan({data: withDisk, width: w, height: h});
  assert.equal(first.stickers.length, 0);
  assert.ok((first.rejected.shape || 0) + (first.rejected.size || 0) + (first.rejected.highlight || 0) > 0);
  assert.equal(session.commitScan({data: withDisk, width: w, height: h}, 2000), true);
  const second = session.scan({data: withDisk, width: w, height: h});
  const still = (second.rejected.shape || 0) + (second.rejected.size || 0) + (second.rejected.highlight || 0) + (second.rejected['soft-lighting'] || 0);
  assert.ok(still > 0, JSON.stringify(second.rejected));
  const dw = 420, dh = 310;
  const dquad = [{x: 30 / dw, y: 28 / dh}, {x: 390 / dw, y: 28 / dh}, {x: 390 / dw, y: 283 / dh}, {x: 30 / dw, y: 283 / dh}];
  const dbare = paint(dw, dh, () => [52, 46, 58]);
  const dsession = createPaintingSession();
  assert.equal(dsession.accept(dquad), true);
  assert.equal(dsession.learnReference([{data: dbare, width: dw, height: dh}], 1), true);
  const dancer = dbare.slice();
  const rows = ['..####..', '..####..', '..####..', '.######.', '.######.', '########', '########', '########', '.######.', '.######.', '.######.', '.######.', '.######.', '..####..', '..####..', '..####..', '..#..#..', '..#..#..', '..#..#..', '..#..#..', '..#..#..', '..#..#..'];
  for (let y = 0; y < 36; y++) {
    const row = rows[Math.min(rows.length - 1, Math.floor(y * rows.length / 36))];
    for (let x = 0; x < 8; x++) {
      if (row[Math.min(row.length - 1, Math.floor(x * row.length / 8))] !== '#') continue;
      const i = ((120 + y) * dw + (180 + x)) * 4;
      dancer[i] = 236; dancer[i + 1] = 228; dancer[i + 2] = 214;
    }
  }
  const hit = dsession.scan({data: dancer, width: dw, height: dh});
  assert.ok(hit.stickers.length >= 1, JSON.stringify(hit.rejected));
  {
    const height = +hit.stickers[0].projectedHeight;
    const uvH = +hit.stickers[0].uvH;
    const measured = +hit.stickers[0].measuredHeight;
    assert.ok(Math.abs(measured - uvH * CANVAS_H) < 1, 'measured ' + measured + ' uvH ' + uvH);
    assert.equal(height, Math.max(SCANNED_FIGURE_MIN, Math.min(SCANNED_FIGURE_MAX, measured)));
    assert.ok(height >= 105 && height <= MAX_FIGURE_HEIGHT, 'projected ' + height);
    const merged = mergeScanPoints(hit.stickers.map(sticker => ({x: sticker.x, y: sticker.y, kind: 'sticker', projectedHeight: sticker.projectedHeight})));
    assert.equal(merged[0].projectedHeight, hit.stickers[0].projectedHeight);
    const markers = toDancerMarkers([{id: 2, x: 10, y: 20, kind: 'sticker', projectedHeight: height, manual: true}]);
    assert.equal(markers[0].projectedHeight, height);
    assert.equal(markers[0].manual, true);
  }
  assert.equal(clampFigureHeight(125), 125);
  assert.equal(clampFigureHeight(400), MAX_FIGURE_HEIGHT);
  assert.equal(fallbackDancerHeight([]), UNSCANNED_FIGURE_HEIGHT);
  assert.equal(fallbackDancerHeight([{kind: 'sticker', projectedHeight: 110}, {kind: 'sticker', projectedHeight: 140}]), 140);
});

function naiveBlur(src, w, h, radius) {
  const r = Math.max(0, radius | 0);
  if (!r) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = r * 2 + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        acc += src[(y * w + xx) * 3 + c];
      }
      tmp[(y * w + x) * 3 + c] = acc / n;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[(yy * w + x) * 3 + c];
      }
      out[(y * w + x) * 3 + c] = acc / n;
    }
  }
  return out;
}

function naiveDilate(mask, w, h, radius) {
  const r = Math.max(0, radius | 0);
  if (!r) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
  }
  return out;
}

test('runStickerFlash fades white out before the scan, and the blur is linear-time', async () => {
  assert.equal(FLASH_FADE_MS, 120);
  assert.equal(FLASH_MIN_MS, 600);
  assert.equal(FLASH_POLL_MS, 60);
  assert.equal(FLASH_STABLE_FRAMES, 3);
  assert.equal(BARE_HOLD_MIN_MS, 300);
  assert.equal(BARE_HOLD_MAX_MS, 1200);
  const show = readFileSync(new URL('../live-show.js', import.meta.url), 'utf8');
  const scan = show.slice(show.indexOf('function scanStickersNow'), show.indexOf('export async function calibrateStickersNow'));
  assert.match(scan, /extraGrabs:\s*0/);
  assert.match(scan, /frames: \[frame\]\.concat\(extras \|\| \[\]\)/);
  const hold = show.slice(show.indexOf('async function holdWhiteCapture'), show.indexOf('function learnedClock'));
  assert.match(hold, /Math\.max\(BARE_HOLD_MAX_MS,\s*1500\)/);
  const clock = {t: 0};
  const shown = [];
  let hookOpacity = null;
  let scanOpacity = null;
  const out = await runStickerFlash({
    minMs: 0,
    fadeMs: 0,
    extraGrabs: 1,
    show: (alpha) => shown.push(+alpha),
    wait: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    grab: () => ({data: new Uint8ClampedArray(16).fill(240), width: 2, height: 2}),
    personInView: () => false,
    beforeFadeOut: () => { hookOpacity = shown[shown.length - 1]; },
    scan: async () => {
      scanOpacity = shown[shown.length - 1];
      return {ok: true, count: 1};
    }
  });
  assert.equal(out.state, 'done');
  assert.equal(hookOpacity, 1);
  assert.equal(scanOpacity, 0);
  assert.equal(shown[shown.length - 1], 0);
  assert.ok(shown.includes(1));

  const w = 17, h = 11, radius = 4;
  const src = new Float32Array(w * h * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 13) % 251;
  const fast = blurPlane(src, w, h, radius);
  const slow = naiveBlur(src, w, h, radius);
  for (let i = 0; i < fast.length; i++) assert.equal(fast[i], slow[i], 'blur ' + i);
  const tiny = new Float32Array([4, 5, 6]);
  assert.equal(blurPlane(tiny, 1, 1, 0), tiny);
  const wideR = blurPlane(src, w, h, 9);
  const wideN = naiveBlur(src, w, h, 9);
  for (let i = 0; i < wideR.length; i++) assert.equal(wideR[i], wideN[i], 'wide blur ' + i);

  const mask = new Uint8Array(w * h);
  mask[0] = 1;
  mask[3 * w + 5] = 2;
  mask[w * h - 1] = 1;
  const dil = dilateMask(mask, w, h, 3);
  const dilN = naiveDilate(mask, w, h, 3);
  for (let i = 0; i < dil.length; i++) assert.equal(dil[i], dilN[i], 'dilate ' + i);
  assert.equal(dilateMask(mask, w, h, 0), mask);

  const bw = 960, bh = 446, br = 67, dr = 48;
  const big = new Float32Array(bw * bh * 3);
  const bits = new Uint8Array(bw * bh);
  for (let i = 0; i < big.length; i += 17) big[i] = (i % 255);
  for (let i = 0; i < bits.length; i += 97) bits[i] = 1;
  const t0 = performance.now();
  const blurred = blurPlane(big, bw, bh, br);
  const dilated = dilateMask(bits, bw, bh, dr);
  const elapsed = performance.now() - t0;
  assert.ok(blurred[0] >= 0 && dilated[0] === 1);
  assert.ok(elapsed < 400, '960×446 blur+dilate took ' + elapsed.toFixed(1) + ' ms');
});

test('active painting mode runs no live-feed sticker detection when color is auto', () => {
  const session = createPaintingSession();
  assert.equal(session.darkDetectionAllowed(), true);
  const quad = [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.8, y: 0.8}, {x: 0.2, y: 0.8}];
  assert.equal(session.accept(quad), true);
  const frame = {data: new Uint8ClampedArray(32 * 24 * 4).fill(240), width: 32, height: 24};
  assert.equal(session.learnReference([frame], 5), true);
  for (const color of ['auto', 'white', 'dark']) {
    session.setStickerColor(color);
    assert.equal(session.darkDetectionAllowed(), false, color);
    assert.deepEqual(session.observe(frame, {now: 8}), []);
    assert.equal(session.telemetry().found, 0);
    assert.equal(session.telemetry().latched.length, 0);
  }
  const cam = readFileSync(new URL('../camera-markers.js', import.meta.url), 'utf8');
  const detect = cam.slice(cam.indexOf('export function detectCam'), cam.indexOf('export function loopCam'));
  const live = detect.slice(detect.indexOf('if (!flashing)'));
  const guard = live.indexOf('painting.active()');
  assert.ok(guard >= 0 && guard < live.indexOf('collectContinuousStickers'));
  assert.ok(guard < live.indexOf('stickerScan.observe'));
  assert.ok(guard < live.indexOf('driftWatch.check'));
  assert.match(live, /darkDetectionAllowed\(\) \? cam\.collectContinuousStickers/);
  const relearn = readFileSync(new URL('../live-show.js', import.meta.url), 'utf8');
  const body = relearn.slice(relearn.indexOf('function relearnBarePaintingNow'), relearn.indexOf('function commitHomes'));
  assert.match(body, /clearAutoScanMarkers/);
  assert.match(body, /commitHomes\(doc\)/);
});

test('clearAutoScanMarkers publishes an empty scan list and keeps manuals', () => {
  const book = createStickerScan();
  book.restore([{id: 1, x: 10, y: 20, kind: 'sticker'}, {id: 2, x: 30, y: 40, kind: 'sticker'}]);
  const manuals = [{id: 8, x: 1, y: 2, manual: true}];
  const store = new Map();
  store.set(RELOAD_LATCH_KEY, JSON.stringify({
    v: 1,
    pending: true,
    markersOn: true,
    markers: [{id: 1, x: 10, y: 20, kind: 'sticker'}],
    manuals: [{id: 8, x: 1, y: 2, kind: 'sticker', manual: true}]
  }));
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); }
  };
  const prev = globalThis.window;
  globalThis.window = {localStorage: storage};
  try {
    const cam = {
      stickerScan: book,
      manuals: {list: () => manuals},
      scanAuthority: true,
      scanAccum: [{x: 3, y: 4}],
      scanConfirmed: true,
      tracker: {stage: [{id: 1}], replaceStage(list) { this.stage = list; }},
      publishScan() { cam.published = book.markers().slice(); }
    };
    assert.equal(clearAutoScanMarkersCam(cam), 0);
    assert.equal(book.markers().length, 0);
    assert.deepEqual(cam.scanAccum, []);
    assert.equal(cam.scanAuthority, false);
    assert.deepEqual(cam.published, []);
    assert.deepEqual(cam.tracker.stage, []);
    assert.equal(manuals.length, 1);
    const saved = JSON.parse(storage.getItem(RELOAD_LATCH_KEY));
    assert.deepEqual(saved.markers, []);
    assert.equal(saved.manuals.length, 1);
  } finally {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  }
});

test('detectChangedStickers default keeps the full frameQuad in the stills', () => {
  assert.equal(CHANGE_STICKER.inset, 0);
  const w = 220, h = 170;
  const quad = [{x: 16, y: 12}, {x: 204, y: 14}, {x: 198, y: 156}, {x: 18, y: 152}];
  const bare = paint(w, h, () => [198, 194, 186]);
  const ref = rgbOf(bare);
  const live = bare.slice();
  // Cameo standing on the bottom edge of the quad. The old 3% inset cut this off.
  stampCameo(live, w, h, 96, 118, 16, 36, [168, 124, 48]);
  const found = detectChangedStickers(live, w, h, {quad, reference: ref});
  const edgeW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const edgeH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const full = warpGridSize(edgeW, edgeH);
  assert.equal(found.grid.gw, full.gw);
  assert.equal(found.grid.gh, full.gh);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(found.zone[i].x - quad[i].x) < 1e-6, 'zone ' + i);
    assert.ok(Math.abs(found.zone[i].y - quad[i].y) < 1e-6, 'zone ' + i);
  }
  const shrunk = insetQuad(quad, 0.03);
  const small = warpGridSize(
    Math.hypot(shrunk[1].x - shrunk[0].x, shrunk[1].y - shrunk[0].y),
    Math.hypot(shrunk[3].x - shrunk[0].x, shrunk[3].y - shrunk[0].y)
  );
  assert.ok(full.gw > small.gw && full.gh > small.gh, JSON.stringify({full, small}));
  assert.ok(found.view.before && found.view.after && found.view.diff);
  const before = unpackThumb(found.view.before);
  const after = unpackThumb(found.view.after);
  const diff = unpackThumb(found.view.diff);
  assert.ok(before && after && diff);
  assert.equal(before.w, after.w);
  assert.equal(after.w, diff.w);
  assert.equal(before.h, after.h);
  assert.equal(before.h, Math.max(16, Math.round(full.gh * before.w / full.gw)));
  assert.equal(found.stickers.length, 1, JSON.stringify({rejected: found.rejected, blobs: found.view && found.view.blobs}));
  assert.ok(found.stickers[0].y > quad[2].y - 40, JSON.stringify(found.stickers[0]));
  const bareScan = detectChangedStickers(bare, w, h, {quad, reference: ref});
  assert.equal(bareScan.stickers.length, 0, JSON.stringify(bareScan.rejected));
});

test('scanned figure height keeps the measured box and draws at cutout scale', () => {
  assert.equal(SCANNED_FIGURE_MAX, MAX_FIGURE_HEIGHT);
  assert.deepEqual(scannedFigureHeight(0), {});
  // A short white-still box (the old 59.5 px read) draws at the cutout floor.
  const short = scannedFigureHeight(0.096);
  assert.equal(short.measuredHeight, 59.5);
  assert.equal(short.projectedHeight, SCANNED_FIGURE_MIN);
  // A full-size cutout passes through unchanged.
  const tall = scannedFigureHeight(0.2);
  assert.equal(tall.projectedHeight, tall.measuredHeight);
  // A wild trace is capped.
  assert.equal(scannedFigureHeight(0.6).projectedHeight, SCANNED_FIGURE_MAX);
});
