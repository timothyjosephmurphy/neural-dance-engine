// Arms raise forward in front of the body (shoulder flexion), TJ Nov 11:
// used in moves (the both-forward arm family) and by the pre-drop build
// (armForward). Bone lengths stay rigid; +z is toward the audience.
import test from 'node:test';
import assert from 'node:assert/strict';
import {skeletonPose, applyArmForward, ARM_LIFT_FAMILIES, armLiftFamilySpec} from '../neural-dance/src/skeleton-dancer.js';

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (+a.z || 0) - (+b.z || 0));

test('both-forward is one of the arm families and reaches forward', () => {
  assert.ok(ARM_LIFT_FAMILIES.includes('both-forward'));
  assert.equal(armLiftFamilySpec('both-forward').forward, 1);
  const up = skeletonPose({id: 3, band: 1, armLift: 0.9, armFamily: 'both-up'});
  const fw = skeletonPose({id: 3, band: 1, armLift: 0.9, armFamily: 'both-forward'});
  for (const s of ['L', 'R']) {
    const sh = fw['sh' + s], hd = fw['hand' + s];
    assert.ok((hd.z || 0) - (sh.z || 0) > 0.12, s + ' hand in front of the shoulder: dz ' + ((hd.z || 0) - (sh.z || 0)).toFixed(3));
    assert.ok(Math.abs(hd.y - sh.y) < 0.09, s + ' hand near shoulder/chest height: ' + (hd.y - sh.y).toFixed(3));
    assert.ok(Math.abs((up['hand' + s].z || 0)) < 0.06, 'both-up stays in the frontal plane');
  }
  assert.ok(fw.armForward > 0.5, 'reports the forward amount');
});

test('armForward keeps every arm bone length', () => {
  const base = skeletonPose({id: 7, band: 2, armLift: 0.3});
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const p = skeletonPose({id: 7, band: 2, armLift: 0.3, armForward: f});
    for (const s of ['L', 'R']) {
      for (const [a, b] of [['sh', 'el'], ['el', 'wrist'], ['wrist', 'hand']]) {
        const want = d3(base[a + s], base[b + s]), got = d3(p[a + s], p[b + s]);
        assert.ok(Math.abs(got - want) < 1e-6, `${a}${s}-${b}${s} ${got.toFixed(5)} vs ${want.toFixed(5)} at ${f}`);
      }
    }
  }
});

test('forward reach rises monotonically with the amount and is smooth', () => {
  let prevZ = -1, prevY = 9;
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const p = skeletonPose({id: 1, band: 1, armLift: 0.3, armForward: f});
    const z = (p.handR.z || 0) - (p.shR.z || 0);
    assert.ok(z >= prevZ - 0.005, 'hand moves forward, not back: ' + z.toFixed(3) + ' at ' + f.toFixed(2));
    if (prevZ > -1) assert.ok(z - prevZ < 0.06, 'no jump: ' + (z - prevZ).toFixed(3));
    assert.ok(p.handR.y <= prevY + 0.005, 'hand rises as it reaches');
    prevZ = z; prevY = p.handR.y;
  }
});

test('no forward reach at rest or in silence', () => {
  const rest = skeletonPose({id: 2, band: 1, armLift: 0, armForward: 0});
  assert.ok(!(rest.armForward > 0));
  const hushed = skeletonPose({id: 2, band: 1, armLift: 0.5, armForward: 1, hush: 0});
  assert.ok(!(hushed.armForward > 0.001), 'hush eases it out');
});

test('applyArmForward ignores missing joints and zero amounts', () => {
  const j = {shL: {x: 0, y: 0}, elL: {x: 0, y: 0.1}, wristL: {x: 0, y: 0.2}, handL: {x: 0, y: 0.25}};
  const copy = JSON.stringify(j);
  applyArmForward(j, 0, 1);
  assert.equal(JSON.stringify(j), copy);
});
