// Nov 9, 8:21 PM (live 414018c): Align committed a quad ~85 px off; refine
// saw the corners on all 4 passes and refused each jump, yet the toast said
// "✓ Camera aligned". The quad is unchanged; only the message is honest now.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ALIGN_REFINE_WARN_PX, alignLooksOff} from '../neural-dance/live-show.js';

const RIG_8_21 = {
  passes: [
    {pass: 1, paused: true, motion: 74.5, person: false},
    {pass: 1, errorPx: 85.7, applied: false, reason: 'jump too large'},
    {pass: 2, errorPx: 84.8, applied: false, reason: 'jump too large'},
    {pass: 3, errorPx: 84.8, applied: false, reason: 'jump too large'},
    {pass: 4, errorPx: 84.7, applied: false, reason: 'jump too large'}
  ],
  finalErrorPx: 84.65, converged: false, stopped: 'max passes', done: true
};

test('8:21 PM refine report flags the Align as off', () => {
  assert.equal(alignLooksOff(RIG_8_21), true);
});

test('good, corrected, unmeasured, or lit-room aligns are not flagged', () => {
  assert.equal(alignLooksOff({passes: [{pass: 1, errorPx: 1.4, applied: false, reason: 'converged'}], finalErrorPx: 1.4}), false);
  assert.equal(alignLooksOff({passes: [{pass: 1, errorPx: 60, applied: true}], finalErrorPx: 3}), false);
  assert.equal(alignLooksOff({passes: [{pass: 1, errorPx: null, applied: false, reason: 'dots not found'}], finalErrorPx: null}), false);
  assert.equal(alignLooksOff(RIG_8_21, true), false);
  assert.equal(alignLooksOff(null), false);
  assert.equal(alignLooksOff({...RIG_8_21, finalErrorPx: ALIGN_REFINE_WARN_PX}), false);
});

test('Align toast uses the warning, not a checkmark, when refine says it is off', () => {
  const src = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(src, /const off = alignLooksOff\(lastRefine, ambientHot\)/);
  assert.match(src, /⚠ Align looks off by/);
});

// 8:26-8:27 PM: the right marker quad (stage band ~2.6:1 on the camera, iPhone
// landscape Safari ~2.48:1 viewport) was refused, and a whole-screen quad won.
import {alignMaxAspect, chooseAlignQuad} from '../neural-dance/camera-markers.js';
const GOOD_8_12 = [{x: 0.0406, y: 0.3406}, {x: 0.9912, y: 0.3373}, {x: 0.9744, y: 0.8308}, {x: 0.0415, y: 0.809}];

test('iPhone-landscape stage quad is accepted when the viewport is that wide', () => {
  const before = chooseAlignQuad({markers: {corners: GOOD_8_12, found: [true, true, true, true]}, videoAspect: 4 / 3});
  assert.equal(before.ok, false);
  assert.match(before.reason, /aspect 2\.6/);
  const after = chooseAlignQuad({markers: {corners: GOOD_8_12, found: [true, true, true, true]}, videoAspect: 4 / 3, stageAspect: 844 / 340});
  assert.equal(after.ok, true);
  assert.equal(after.source, 'markers');
});

test('aspect cap: unchanged without a viewport, follows a wide one, bounded', () => {
  assert.equal(alignMaxAspect(null), 2.35);
  assert.equal(alignMaxAspect(16 / 9), 2.35);
  assert.ok(Math.abs(alignMaxAspect(844 / 340) - 3.103) < 0.01);
  assert.equal(alignMaxAspect(10), 4);
});

test('live Align passes the projected stage shape', () => {
  const src = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(src, /chooseAlignQuad\(\{[^}]*stageAspect\}\)/);
});
