import test from 'node:test';
import assert from 'node:assert/strict';
import {headLook, HEAD_YAW_MAX, HEAD_YAW_REST} from '../neural-dance/src/head-look.js';

test('independent head looks stay within natural neck yaw and are calmer at rest', () => {
  let restPeak = 0, highPeak = 0, hushPeak = 0;
  for (let i = 0; i < 80; i++) {
    const t = i * 0.25;
    const rest = headLook({tSec: t, activation: 0.04, hush: 1, bpm: 112, seed: 4.2});
    const high = headLook({tSec: t, activation: 0.95, hush: 1, bpm: 112, seed: 4.2});
    const hush = headLook({tSec: t, activation: 0.95, hush: 0, bpm: 112, seed: 4.2});
    restPeak = Math.max(restPeak, Math.abs(rest.yaw));
    highPeak = Math.max(highPeak, Math.abs(high.yaw));
    hushPeak = Math.max(hushPeak, Math.abs(hush.yaw));
    assert.ok(Math.abs(rest.yaw) <= HEAD_YAW_MAX + 1e-9);
    assert.ok(Math.abs(high.yaw) <= HEAD_YAW_MAX + 1e-9);
    assert.ok(Math.abs(high.tilt) <= 8 * Math.PI / 180 + 1e-9);
  }
  assert.ok(restPeak <= HEAD_YAW_REST * 1.25, 'rest looks stay small, got ' + (restPeak * 180 / Math.PI).toFixed(1) + ' deg');
  assert.ok(highPeak > restPeak, 'looks grow with activation');
  assert.ok(hushPeak < 1e-6, 'hush silences independent looks');
  assert.ok(HEAD_YAW_MAX * 180 / Math.PI <= 30.0001);
});

test('looks are eased: nearby times do not whip the head', () => {
  let maxJump = 0;
  let prev = headLook({tSec: 0, activation: 0.8, hush: 1, bpm: 124, seed: 1.7});
  for (let i = 1; i < 40; i++) {
    const cur = headLook({tSec: i * 0.05, activation: 0.8, hush: 1, bpm: 124, seed: 1.7});
    maxJump = Math.max(maxJump, Math.abs(cur.yaw - prev.yaw));
    prev = cur;
  }
  assert.ok(maxJump < 8 * Math.PI / 180, 'no whip in 50 ms, jump=' + (maxJump * 180 / Math.PI).toFixed(2) + ' deg');
});
