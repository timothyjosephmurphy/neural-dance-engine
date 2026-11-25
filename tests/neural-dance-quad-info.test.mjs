// Nov 9, 8:02 PM (live 7fe9045/f2a3a3f): the debug pink quad no longer matched
// the projected stage after the phone moved, and the debug page could not say
// where the quad came from or whether it was locked ("Quad unlocked" always,
// because the phone never forwarded quadLock). Debug provenance only; the
// camera-to-stage mapping is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {quadSourceOf, readCameraSettings, writeCameraSettings} from '../neural-dance/camera-markers.js';
import {quadSummary} from '../neural-dance/debug-viewer.js';

function memory() {
  const map = new Map();
  return {getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
}
const QUAD = [{x: 0.05, y: 0.33}, {x: 0.97, y: 0.33}, {x: 0.97, y: 0.82}, {x: 0.05, y: 0.82}];

test('quad source labels every commit path', () => {
  assert.equal(quadSourceOf('Screen quad held.', {fromLock: true, quiet: true}), 'border-lock');
  assert.equal(quadSourceOf('Corners set from debug.', {manual: true}), 'debug');
  assert.equal(quadSourceOf('Corners set by hand.', {manual: true}), 'manual');
  assert.equal(quadSourceOf('Aligned to the screen border.'), 'border');
  assert.equal(quadSourceOf('Camera aligned and refined.'), 'align-refined');
  assert.equal(quadSourceOf('Camera aligned to the screen.'), 'align');
});

test('saved quad keeps its source and time across reloads', () => {
  const store = memory();
  writeCameraSettings(store, {corners: QUAD, cornersSource: 'align-refined', cornersAt: 1794283300000, hueTolerance: 40, saturationSensitivity: 0.6, minBlobSize: 20});
  const back = readCameraSettings(store);
  assert.equal(back.cornersSource, 'align-refined');
  assert.equal(back.cornersAt, 1794283300000);
  assert.equal(back.corners.length, 4);
});

test('older saved settings (no provenance) still load', () => {
  const store = memory();
  store.setItem('nd.camera.v3', JSON.stringify({v: 3, corners: QUAD, hueTolerance: 40, saturationSensitivity: 0.6, minBlobSize: 20}));
  const back = readCameraSettings(store);
  assert.equal(back.corners.length, 4);
  assert.equal(back.cornersSource, '');
  assert.equal(back.cornersAt, 0);
});

test('debug quad line shows lock state, source and age', () => {
  const at = Date.UTC(2026, 10, 10, 4, 1);
  assert.equal(quadSummary(null, null), 'Quad unlocked');
  assert.equal(quadSummary({locked: true}, null), 'Quad locked');
  const line = quadSummary({locked: false}, {source: 'align-refined', at}, at + 5 * 60000);
  assert.match(line, /^Quad unlocked · set by Align \+ refine .*\(5 min ago\)$/);
  assert.equal(quadSummary({locked: false}, {source: 'saved', at: 0}), 'Quad unlocked · set by saved (before this build)');
});

test('phone telemetry forwards quadLock and quadInfo to the debug feed', () => {
  const src = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(src, /quadLock: vision\.quadLock/);
  assert.match(src, /quadInfo: vision\.quadInfo/);
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /quadInfo: cam\.committed\.length === 4/);
});
