// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {applyDebugPatch, collectTelemetry} from '../neural-dance/live-debug.js';
import {CANVAS_H, CANVAS_W, DEFAULTS, ECHO_H, ECHO_W, createMarkerTracker, createStageEcho, homographyFromNormalized, markersFromFrame, projectVideoPoint, toDancerMarkers} from '../neural-dance/camera-markers.js';
import {
  PERSON_CLEAR_MS,
  PERSON_ENTER_FRAMES,
  PERSON_EXIT_FRAMES,
  PERSON_PAUSE_NOTE,
  PERSON_RESUME_NOTE,
  PERSON_SENSITIVITY_DEFAULT,
  PERSON_STAY_RADIUS,
  coverageFromRead,
  createPersonOcclusion,
  createStaticBackground,
  gateStickerBlobs,
  isSkinTone,
  personCuts,
  personInFrame,
  projectedFromEcho,
  readPersonPause,
  stickerStagePoints,
  stickersThatStayed,
  syncPersonNote,
  writePersonPause
} from '../neural-dance/src/person-occlusion.js';
import {
  MANUAL_HIT_RADIUS,
  createManualStickers,
  mergeLatchedStickers,
  resolveStageTap
} from '../neural-dance/src/debug-manual-stickers.js';

const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
const camera = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
const publisher = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');

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

function fillRect(data, width, x0, y0, w, h, rgb) {
  const height = data.length / 4 / width;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  }
}

test('a person pauses sticker detection, and after the clear wait flashRescan asks for Scan stickers', () => {
  assert.equal(PERSON_PAUSE_NOTE, 'person in frame, detection paused');
  assert.ok(PERSON_CLEAR_MS >= 1000 && PERSON_CLEAR_MS <= 2000);
  assert.equal(PERSON_STAY_RADIUS, 80);

  const wall = [170, 165, 160];
  const width = 80;
  const height = 60;
  const plain = paint(width, height, () => wall);
  assert.equal(personInFrame(plain, width, height).present, false);

  const sticker = plain.slice();
  fillRect(sticker, width, 10, 10, 6, 6, [20, 18, 16]);
  assert.equal(personInFrame(sticker, width, height).present, false, 'a vinyl-sized dark blob is not a person');

  const note = plain.slice();
  fillRect(note, width, 8, 8, 18, 14, [240, 80, 150]);
  assert.equal(personInFrame(note, width, height).present, false, 'a pink note is not a person');
  assert.equal(isSkinTone(240, 80, 150), false);
  assert.equal(isSkinTone(255, 146, 125), false);

  const dancer = plain.slice();
  fillRect(dancer, width, 20, 10, 30, 30, [255, 146, 125]);
  assert.equal(personInFrame(dancer, width, height).present, false, 'a neon dancer does not pause detection');

  const body = plain.slice();
  fillRect(body, width, 26, 8, 28, 42, [40, 36, 34]);
  const seen = personInFrame(body, width, height);
  assert.equal(seen.present, true);
  assert.ok(seen.bodyFraction >= 0.08);

  const face = plain.slice();
  fillRect(face, width, 30, 16, 14, 16, [200, 150, 120]);
  assert.equal(isSkinTone(200, 150, 120), true);
  assert.equal(personInFrame(face, width, height).present, true, 'a skin-toned face pauses detection');

  const hidden = personInFrame(body, width, height, {
    inside(x, y) { return !(x >= 26 && x < 54 && y >= 8 && y < 50); }
  });
  assert.equal(hidden.present, false, 'a body outside the projection quad is ignored');

  const occlusion = createPersonOcclusion();
  const before = [{x: 100, y: 200}, {x: 400, y: 80}];
  assert.equal(occlusion.observe({person: false, stickers: before, now: 0}).paused, false);
  const intruder = [{x: 10, y: 10}, {x: 900, y: 500}];
  for (let i = 0; i < PERSON_ENTER_FRAMES - 1; i++) {
    const arming = occlusion.observe({person: true, stickers: intruder, now: 40 + i});
    assert.equal(arming.paused, false, 'a person has to hold for several frames');
  }
  const paused = occlusion.observe({person: true, stickers: intruder, now: 50});
  assert.equal(paused.paused, true);
  assert.equal(paused.note, PERSON_PAUSE_NOTE);
  assert.equal(paused.rescan, false);
  for (let i = 0; i < PERSON_EXIT_FRAMES - 1; i++) {
    const held = occlusion.observe({person: false, stickers: before, now: 200 + i});
    assert.equal(held.paused, true);
    assert.equal(held.settling, false);
  }
  const settling = occlusion.observe({person: false, stickers: before, now: 210});
  assert.equal(settling.paused, true);
  assert.equal(settling.settling, true);
  assert.equal(settling.note, PERSON_RESUME_NOTE);
  assert.equal(occlusion.observe({person: false, stickers: before, now: 210 + PERSON_CLEAR_MS - 1}).rescan, false);
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) occlusion.observe({person: true, stickers: [], now: 400 + i});
  let still = null;
  for (let i = 0; i < PERSON_EXIT_FRAMES; i++) still = occlusion.observe({person: false, stickers: before, now: 500 + i});
  assert.equal(still.settling, true);
  const resumedAt = 500 + PERSON_EXIT_FRAMES - 1;
  assert.equal(occlusion.observe({person: false, stickers: before, now: resumedAt + PERSON_CLEAR_MS - 1}).rescan, false);
  const rescanned = occlusion.observe({
    person: false,
    stickers: [{x: 120, y: 210}, {x: 700, y: 400}],
    now: resumedAt + PERSON_CLEAR_MS
  });
  assert.equal(rescanned.rescan, true);
  assert.equal(rescanned.flashRescan, true);
  assert.equal(rescanned.paused, false);
  assert.equal(rescanned.latch.length, 0, 'flash rescan replaces autos; no stayed-only latch');
  assert.deepEqual(stickersThatStayed([{x: 0, y: 0}], [{x: PERSON_STAY_RADIUS + 1, y: 0}]), []);
  assert.equal(stickersThatStayed([{x: 0, y: 0}], [{x: PERSON_STAY_RADIUS, y: 0}]).length, 1);

  const dropped = gateStickerBlobs(
    [{x: 1, y: 2, kind: 'pink'}, {x: 3, y: 4, kind: 'sticker'}],
    {paused: true, rescan: false}
  );
  assert.deepEqual(dropped.map(blob => blob.kind), ['pink']);
  const kept = gateStickerBlobs(
    [{x: 3, y: 4, kind: 'sticker'}, {x: 30, y: 4, kind: 'sticker'}],
    {paused: false, rescan: true, latch: [{x: 12, y: 8}]},
    (blob) => (blob.x === 3 ? {x: 12, y: 8} : {x: 400, y: 8})
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].x, 3);

  const noteEl = {hidden: true, textContent: ''};
  const doc = {querySelector(sel) { return sel === '[data-person-note]' ? noteEl : null; }};
  assert.equal(syncPersonNote(doc, true), true);
  assert.equal(noteEl.hidden, false);
  assert.equal(noteEl.textContent, PERSON_PAUSE_NOTE);
  syncPersonNote(doc, false);
  assert.equal(noteEl.hidden, true);
});

test('the camera hook signals flashRescan after a person leaves so Scan stickers can replace autos', () => {
  const wall = [157, 117, 96];
  const ink = [100, 104, 93];
  const width = 160;
  const height = 120;
  const cross = (x, y, cx, cy) => (y >= cy && y < cy + 14 && x === cx + 6) || (x >= cx && x < cx + 14 && y === cy + 6);
  const frameOf = (origins) => paint(width, height, (x, y) => origins.some(([cx, cy]) => cross(x, y, cx, cy)) ? ink : wall);
  const H = homographyFromNormalized([{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}], width, height);
  const tracker = createMarkerTracker();
  const occlusion = createPersonOcclusion();
  const settings = {...DEFAULTS, minBlobSize: 8, detectionMode: 'stickers'};
  const scale = {scaleX: 1, scaleY: 1};
  const project = (blob) => projectVideoPoint(H, blob.x, blob.y);
  const home = frameOf([[40, 40]]);
  const preview = markersFromFrame({data: home, width, height}, settings, H, scale, createMarkerTracker(), 0, {latch: false});
  const previewStickers = preview.blobs.filter(blob => blob.kind === 'sticker');
  assert.equal(previewStickers.length, 1, 'the home cross is one sticker');
  function step(data, now, person, book = occlusion, marks = tracker) {
    let decision = null;
    const result = markersFromFrame({data, width, height}, settings, H, scale, marks, now, {
      latch: true,
      beforeLatch(blobs) {
        decision = book.observe({
          person,
          stickers: stickerStagePoints(blobs, project),
          now
        });
        return gateStickerBlobs(blobs, decision, project);
      }
    });
    if (decision && decision.rescan) marks.commitStage((decision.latch || []).map(spot => ({x: spot.x, y: spot.y, kind: 'sticker'})));
    return {
      decision,
      markers: decision && decision.rescan ? toDancerMarkers(marks.stage()) : result.markers
    };
  }
  const first = step(home, 0, false);
  assert.equal(first.decision.paused, false);
  assert.equal(first.markers.length, 0, 'the sticker is seen but not latched before the person arrives');
  let blocked = null;
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) blocked = step(home, 80 + i, true);
  assert.equal(blocked.decision.note, PERSON_PAUSE_NOTE);
  assert.equal(blocked.markers.length, 0);
  let waiting = null;
  for (let i = 0; i < PERSON_EXIT_FRAMES; i++) waiting = step(home, 120 + i, false);
  assert.equal(waiting.decision.settling, true);
  assert.equal(waiting.decision.rescan, false);
  const both = frameOf([[40, 40], [110, 78]]);
  const clearAt = 120 + PERSON_EXIT_FRAMES - 1;
  const done = step(both, clearAt + PERSON_CLEAR_MS, false);
  assert.equal(done.decision.rescan, true);
  assert.equal(done.decision.flashRescan, true);
  assert.equal(done.decision.latch.length, 0, JSON.stringify(done.decision.latch));

  const moved = createPersonOcclusion();
  const movedTracker = createMarkerTracker();
  movedStep(home, 0, false);
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) movedStep(home, 10 + i, true);
  let leaving = null;
  for (let i = 0; i < PERSON_EXIT_FRAMES; i++) leaving = movedStep(frameOf([[110, 78]]), 40 + i, false);
  assert.equal(leaving.decision.rescan, false);
  assert.equal(leaving.decision.settling, true);
  const shiftedAt = 40 + PERSON_EXIT_FRAMES - 1;
  const shifted = movedStep(frameOf([[110, 78]]), shiftedAt + PERSON_CLEAR_MS, false);
  assert.equal(shifted.decision.rescan, true);
  assert.equal(shifted.decision.flashRescan, true);
  assert.equal(shifted.decision.latch.length, 0);

  function movedStep(data, now, person) {
    return step(data, now, person, moved, movedTracker);
  }
});

test('debug stage taps add and remove manual stickers through the existing room patch', () => {
  assert.equal(MANUAL_HIT_RADIUS >= 24, true);
  const empty = resolveStageTap([{id: 3, x: 100, y: 200, kind: 'pink'}], 100, 200);
  assert.equal(empty.action, 'add-manual-sticker');
  assert.equal(empty.x, 100);
  assert.equal(empty.y, 200);
  const book = createManualStickers();
  const added = book.apply(empty);
  assert.equal(added.changed, true);
  assert.equal(added.stickers.length, 1);
  assert.equal(added.stickers[0].manual, true);
  assert.equal(added.stickers[0].kind, 'sticker');
  // A plain tap never toggles a marker off (TJ Nov 11 3:49 PM); removal is
  // explicit (long-press / Remove mode).
  const again = resolveStageTap(added.stickers, 100 + MANUAL_HIT_RADIUS - 1, 200);
  assert.equal(again.action, 'add-manual-sticker');
  const near = resolveStageTap(added.stickers, 100 + MANUAL_HIT_RADIUS - 1, 200, undefined, {remove: true});
  assert.equal(near.action, 'remove-manual-sticker');
  assert.equal(near.id, added.stickers[0].id);
  assert.equal(resolveStageTap(added.stickers, 900, 600, undefined, {remove: true}), null);
  const beside = resolveStageTap(added.stickers, 100 + MANUAL_HIT_RADIUS + 2, 200);
  assert.equal(beside.action, 'add-manual-sticker');
  book.apply(beside);
  assert.equal(book.list().length, 2);
  book.apply(near);
  assert.equal(book.list().length, 1);
  assert.equal(book.list()[0].x, beside.x);
  const merged = mergeLatchedStickers(
    [{id: 4, x: 10, y: 12, kind: 'pink'}],
    book.list()
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find(marker => marker.manual).kind, 'sticker');

  const sent = sanitizeDebugPatch({action: 'add-manual-sticker', x: 1400, y: -8});
  assert.equal(sent.action, 'add-manual-sticker');
  assert.equal(sent.x, 1000);
  assert.equal(sent.y, 0);
  const gone = sanitizeDebugPatch({action: 'remove-manual-sticker', id: added.stickers[0].id, x: 12, y: 900});
  assert.equal(gone.action, 'remove-manual-sticker');
  assert.equal(gone.id, added.stickers[0].id);
  assert.equal(gone.y, 620);
  assert.equal(sanitizeDebugPatch({action: 'add-manual-sticker'}), null);
  assert.equal(sanitizeDebugPatch({action: 'remove-manual-sticker'}), null);
  assert.equal(sanitizeDebugPatch({action: 'add-sim', x: 10, y: 12}).action, 'add-sim');

  const calls = [];
  const doc = {
    getElementById(id) {
      if (id !== 'nd-camera-mode') return null;
      return {
        querySelector() { return null; },
        neuralDanceCamera: {
          applyManualSticker(patch) { calls.push(patch); },
          debugState() {
            return {
              occlusion: {paused: true, settling: false, note: PERSON_PAUSE_NOTE},
              markers: [{id: 500001, x: 12, y: 20, kind: 'sticker', manual: true}]
            };
          }
        }
      };
    },
    querySelector() { return null; },
    body: {classList: {contains() { return false; }}}
  };
  assert.equal(applyDebugPatch(doc, {action: 'add-manual-sticker', x: 30, y: 40}), true);
  assert.equal(calls[0].action, 'add-manual-sticker');
  assert.equal(calls[0].x, 30);
  const telemetry = collectTelemetry(doc, 5);
  assert.equal(telemetry.occlusion.note, PERSON_PAUSE_NOTE);
  assert.equal(telemetry.occlusion.paused, true);
  assert.equal(telemetry.markers[0].manual, true);

  assert.match(livePage, /data-person-note hidden role="status">person in frame, detection paused/);
  assert.match(debugPage, /data-person-note hidden role="status">person in frame, detection paused/);
  assert.match(debugPage, /data-debug-stage|projected stage|manual sticker/i);
  assert.match(livePage, /data-person-pause aria-pressed="true"/);
  assert.match(livePage, />Pause on</);
  assert.match(debugPage, /data-debug-person-pause aria-pressed="true">Person pause: on/);
  assert.match(debugPage, /Person sensitivity/);
  assert.match(debugPage, /data-debug-control="person"/);
  assert.match(camera, /from '\.\/src\/person-occlusion\.js'/);
  assert.match(camera, /projectedFromEcho/);
  assert.equal(sanitizeDebugPatch({personPause: false}).personPause, false);
  assert.equal(sanitizeDebugPatch({personPause: true}).personPause, true);
  assert.equal(sanitizeDebugPatch({personSensitivity: 4}).personSensitivity, 1);
  assert.equal(sanitizeDebugPatch({personSensitivity: -0.2}).personSensitivity, 0);
  assert.equal(sanitizeDebugPatch({action: 'reload'}).action, 'reload');
  assert.equal(PERSON_SENSITIVITY_DEFAULT < 0.5, true);
  assert.match(camera, /beforeLatch\(videoBlobs\)/);
  assert.match(camera, /applyManualSticker\(patch\)/);
  assert.match(viewer, /resolveStageTap\(view\.telemetry && view\.telemetry\.markers/);
  assert.match(viewer, /syncPersonNote\(view\.doc/);
  assert.match(viewer, /type: 'reload'/);
  assert.match(viewer, /data-debug-person-pause/);
  assert.match(publisher, /applyManualSticker\(clean\)/);
  assert.match(publisher, /occlusion: vision\.occlusion/);
  assert.match(publisher, /message.type === 'reload'|isReloadMessage/);
});

test('a projected screen with pulses and silhouettes does not pause, and a person-sized occluder does', () => {
  const width = 160;
  const height = 120;
  const wall = [170, 165, 160];
  const pulseA = [92, 225, 230];
  const pulseB = [255, 209, 102];
  const silhouette = [255, 220, 176];
  const person = [40, 36, 34];
  const graphic = (x, y) => (x >= 8 && x < 78 && y >= 18 && y < 28) || (x >= 8 && x < 78 && y >= 48 && y < 58) || (x >= 24 && x < 60 && y >= 8 && y < 112);
  const occluder = (x, y) => x >= 100 && x < 140 && y >= 8 && y < 112;
  const screen = paint(width, height, (x, y) => {
    if (x >= 24 && x < 60 && y >= 8 && y < 112) return silhouette;
    if (x >= 8 && x < 78 && y >= 18 && y < 28) return pulseA;
    if (x >= 8 && x < 78 && y >= 48 && y < 58) return pulseB;
    return wall;
  });
  const withPerson = screen.slice();
  for (let y = 8; y < 112; y++) {
    for (let x = 100; x < 140; x++) {
      const i = (y * width + x) * 4;
      withPerson[i] = person[0];
      withPerson[i + 1] = person[1];
      withPerson[i + 2] = person[2];
    }
  }
  const bare = personInFrame(screen, width, height);
  assert.equal(bare.present, false, 'projected light is brighter than the floor and is not a person');
  const wide = paint(width, height, (x, y) => (y >= 50 && y < 80 ? person : wall));
  assert.equal(personInFrame(wide, width, height).present, false, 'a wide short mass is not a person');

  const echo = createStageEcho();
  const rgb = new Uint8Array(ECHO_W * ECHO_H * 3);
  const stageAt = (x, y) => ({x: (x + 0.5) / width * CANVAS_W, y: (y + 0.5) / height * CANVAS_H});
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!graphic(x, y)) continue;
      const at = stageAt(x, y);
      const cx = Math.max(0, Math.min(ECHO_W - 1, Math.round(at.x / CANVAS_W * (ECHO_W - 1))));
      const cy = Math.max(0, Math.min(ECHO_H - 1, Math.round(at.y / CANVAS_H * (ECHO_H - 1))));
      const i = (cy * ECHO_W + cx) * 3;
      rgb[i] = 255;
      rgb[i + 1] = 220;
      rgb[i + 2] = 180;
    }
  }
  echo.ingest(rgb, 0);
  const projected = projectedFromEcho(echo, stageAt);
  assert.equal(typeof projected, 'function');
  assert.equal(echo.veto(stageAt(40, 40).x, stageAt(40, 40).y), true);
  assert.equal(echo.veto(stageAt(120, 60).x, stageAt(120, 60).y), false);
  const ignored = personInFrame(screen, width, height, {projected});
  assert.equal(ignored.present, false, 'pulses and the silhouette are subtracted with the stage echo');
  const seen = personInFrame(withPerson, width, height, {projected, sensitivity: PERSON_SENSITIVITY_DEFAULT});
  assert.equal(seen.present, true, 'a person-sized occluder still pauses');
  assert.ok(seen.aspect >= personCuts(PERSON_SENSITIVITY_DEFAULT).aspect);
  const loose = personCuts(1);
  const strict = personCuts(0);
  assert.ok(strict.fraction > loose.fraction);
  assert.ok(strict.aspect > loose.aspect);

  const gate = createPersonOcclusion();
  for (let i = 0; i < PERSON_ENTER_FRAMES + 3; i++) {
    const decision = gate.observe({person: ignored, stickers: [{x: 20, y: 20}], now: i * 100});
    assert.equal(decision.paused, false);
  }
  let paused = null;
  for (let i = 0; i < PERSON_ENTER_FRAMES; i++) {
    paused = gate.observe({person: seen, stickers: [{x: 20, y: 20}], now: 5000 + i * 100});
    if (i < PERSON_ENTER_FRAMES - 1) assert.equal(paused.paused, false);
  }
  assert.equal(paused.paused, true);
  assert.equal(paused.note, PERSON_PAUSE_NOTE);
  const flicker = gate.observe({person: {present: false, holding: true}, stickers: [{x: 20, y: 20}], now: 6000});
  assert.equal(flicker.paused, true, 'hysteresis keeps the pause while the region is still person-sized');
  assert.equal(flicker.settling, false);

  const memory = {store: new Map(), getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }, setItem(key, value) { this.store.set(key, String(value)); }};
  assert.equal(readPersonPause(memory).enabled, true);
  assert.equal(readPersonPause(memory).sensitivity, PERSON_SENSITIVITY_DEFAULT);
  assert.equal(writePersonPause(memory, {enabled: false, sensitivity: 0.8}), true);
  assert.equal(readPersonPause(memory).enabled, false);
  assert.equal(readPersonPause(memory).sensitivity, 0.8);

  const tuned = [];
  assert.equal(applyDebugPatch({
    getElementById(id) {
      if (id !== 'nd-camera-mode') return null;
      return {neuralDanceCamera: {applyTuning(patch) { tuned.push(patch); }}};
    }
  }, {personPause: false, personSensitivity: 0.2}), true);
  assert.equal(tuned[0].personPause, false);
  assert.equal(tuned[0].personSensitivity, 0.2);
});

test('personInFrame does not need an align quad to see a body', () => {
  const width = 120;
  const height = 90;
  const wall = [40, 42, 38];
  const skin = [190, 140, 120];
  const paint = (fill) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = fill(x, y);
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    return rgba;
  };
  const body = paint((x, y) => (x > 45 && x < 75 && y > 15 && y < 85) ? skin : wall);
  // A broken inside() that rejects the body region must not be required — callers
  // should omit inside so a skewed align quad cannot hide the person.
  assert.equal(personInFrame(body, width, height).present, true);
  const hidden = personInFrame(body, width, height, {inside: () => false});
  assert.equal(hidden.present, false, 'inside:false proves the gate can hide a person');
});

test('a person lit by the projector registers, and a white flash does not', () => {
  const width = 160;
  const height = 120;
  const paint = (fill) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = fill(x, y);
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    return rgba;
  };
  const painting = (x, y) => (x > 20 && x < 140 && y > 12 && y < 108) ? [32, 28, 36] : [18, 18, 20];
  const empty = paint(painting);
  const bg = createStaticBackground();
  for (let i = 0; i < 8; i++) {
    const read = personInFrame(empty, width, height, {step: 2, background: bg});
    bg.update(read.cells, read.cols, read.rows);
  }
  assert.equal(personInFrame(empty, width, height, {step: 2, background: bg}).present, false);
  const lit = paint((x, y) => {
    if (x > 62 && x < 98 && y > 16 && y < 108) return [150, 96, 70];
    return painting(x, y);
  });
  const seen = personInFrame(lit, width, height, {step: 2, background: bg});
  assert.equal(seen.present, true);
  // Skin or a dark body: the lit face/arm reads as skin, not as any changed cell.
  assert.ok(seen.fraction > 0.04, 'body ' + seen.bodyFraction + ' skin ' + seen.skinFraction);
  const coverage = coverageFromRead(seen);
  assert.ok(coverage > 0.04, 'coverage ' + coverage);
  const flash = paint(() => [244, 244, 242]);
  const washed = personInFrame(flash, width, height, {step: 2, background: bg});
  assert.equal(washed.present, false);
  assert.equal(coverageFromRead(washed), 0);
});
