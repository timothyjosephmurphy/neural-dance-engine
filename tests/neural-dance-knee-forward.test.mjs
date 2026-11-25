import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ikJointForward, jointForwardOffset, jointIsForward, footForward,
} from '../neural-dance/src/leg-ik.js';
import {kneeIK, kneeBend} from '../neural-dance/src/skeleton-dancer.js';
import {MOVE_IDS} from '../neural-dance/src/rave-moves.js';

const THIGH = 0.245, SHIN = 0.246;

function hipAnkle(yaw, side, bent = 0.08) {
  const hip = {x: side * 0.09, y: 0.50, z: 0};
  const reach = THIGH + SHIN - bent;
  const ankle = {
    x: hip.x + Math.sin(yaw) * 0.01,
    y: hip.y + reach,
    z: hip.z + Math.cos(yaw) * 0.01,
  };
  const heel = {
    x: ankle.x - Math.sin(yaw) * 0.03,
    y: 0.99,
    z: ankle.z - Math.cos(yaw) * 0.03,
  };
  const toe = {
    x: ankle.x + Math.sin(yaw) * 0.06,
    y: 0.99,
    z: ankle.z + Math.cos(yaw) * 0.06,
  };
  return {hip, ankle, heel, toe, fwd: footForward(heel, toe, yaw)};
}

test('forward-pole IK never bends a knee backward for yaw 0–360°', () => {
  const bad = [];
  for (let deg = 0; deg < 360; deg += 15) {
    const yaw = deg * Math.PI / 180;
    for (const side of [-1, 1]) {
      const {hip, ankle, fwd} = hipAnkle(yaw, side);
      const knee = ikJointForward(hip, ankle, THIGH, SHIN, fwd);
      const off = jointForwardOffset(hip, knee, ankle, fwd);
      if (!(off >= -1e-4) || !jointIsForward(hip, knee, ankle, fwd)) {
        bad.push({deg, side, off});
      }
    }
  }
  assert.equal(bad.length, 0, 'backward knees at ' + JSON.stringify(bad.slice(0, 6)));
});

test('near-straight legs stay unflipped (no hyperextension pop)', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const {hip, ankle, fwd} = hipAnkle(yaw, 1, 0.006);
    const knee = ikJointForward(hip, ankle, THIGH, SHIN, fwd);
    assert.ok(jointIsForward(hip, knee, ankle, fwd, -2e-4), 'yaw ' + yaw);
  }
});

export function liveKneeSweep() {
  const bad = [];
  for (let deg = 0; deg < 360; deg += 15) {
    const yaw = deg * Math.PI / 180;
    for (const side of [-1, 1]) {
      const {hip, ankle, fwd} = hipAnkle(yaw, side);
      const knee = kneeIK(hip, ankle, THIGH, SHIN, side, fwd);
      const off = jointForwardOffset(hip, knee, ankle, fwd);
      if (!(off >= -1e-4)) bad.push({deg, side, off});
    }
  }
  return bad;
}

test('live kneeIK follows the foot heading for yaw 0–360° (portable fix)', () => {
  const bad = liveKneeSweep();
  assert.equal(bad.length, 0, 'live backward knees at ' + JSON.stringify(bad.slice(0, 6)));
  assert.ok(MOVE_IDS.length >= 8, 'rave move list is present for the sim sweep');
});
