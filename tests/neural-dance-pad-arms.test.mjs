import test from 'node:test';
import assert from 'node:assert/strict';
import {padReachAngle, padArmState, applyPadArmAngles, applyTravelingWave, capHandsLead, capHandsLeadScreen, capRestHang, capRestUpright, restHangAmount, REST_HANG_ACT, REST_HANG_LAT_MAX, REST_HANG_DROP_MIN, REST_UPRIGHT_SH_MAX, REST_UPRIGHT_SPINE_MAX, resetPadArmSprings, emptyPadFeatures, padDriveActivation} from '../neural-dance/src/pad-arms.js';
import {demoMusicFeatures, DEMO_SECTIONS} from '../neural-dance/src/melody-pad.js';
import {skeletonPose, buildFor, UPPER_ARM} from '../neural-dance/src/skeleton-dancer.js';

const springs = new Map();

function featuresAt(t, extra = {}) {
  return {...demoMusicFeatures(t), ...extra};
}

function stepTo(tSec, {id = 3, band = 2, act = 0.8} = {}) {
  let st = null;
  for (let t = 0; t <= tSec + 1e-9; t += 1 / 60) {
    st = padArmState({id, band, tSec: t, features: featuresAt(Math.min(t, tSec)), sense: 1, act, springs});
  }
  return st;
}

test('padReachAngle goes from down through sides to past vertical', () => {
  assert.ok(padReachAngle(0) < 0.3);
  assert.ok(padReachAngle(0.55) > 1.5 && padReachAngle(0.55) < 2.0);
  assert.ok(padReachAngle(1) > Math.PI);
});

test('drums-only demo section does not raise the arms', () => {
  resetPadArmSprings();
  const st = stepTo(3, {act: 0.2});
  assert.ok(st.blend < 0.05, 'blend ' + st.blend);
  assert.ok(st.raise < 0.05, 'raise ' + st.raise);
});

test('peak section raises arms overhead', () => {
  resetPadArmSprings();
  const st = stepTo(32, {act: 0.85});
  assert.ok(st.raise > 0.72, 'raise ' + st.raise);
  assert.ok(st.overhead > 0, 'overhead ' + st.overhead);
  assert.ok(st.blend > 0.5);
});

test('raised pad pose keeps elbows below wrists (y-down)', () => {
  resetPadArmSprings();
  const peak = DEMO_SECTIONS.find(s => s.id === 'peak');
  let raised = 0, over = 0;
  for (let t = peak.t0; t < peak.t1; t += 1 / 30) {
    const unit = skeletonPose({
      id: 4, band: 2, weight: 0, ease: 0.4, side: -1, armLift: 0.4,
      activation: 0.8, now: t * 1000, periodMs: 500, hush: 1, still: false,
      padFeatures: demoMusicFeatures(t), armPadSense: 1, dynamics: false
    });
    for (const side of ['L', 'R']) {
      const el = unit['el' + side], wr = unit['wrist' + side], hand = unit['hand' + side];
      const raisedArm = hand.y < unit.crown.y + 0.08 || wr.y < el.y + 0.05;
      if (!raisedArm) continue;
      raised++;
      if (el.y < wr.y - 0.002) over++;
    }
  }
  assert.ok(raised > 20, 'expected raised samples, got ' + raised);
  assert.ok(over / raised < 0.02, `elbows above wrists ${over}/${raised} = ${(over / raised * 100).toFixed(2)}%`);
});

test('traveling wave offset is a seesaw or sine across the hands', () => {
  const padArm = {
    blend: 0.9, lead: 1, raise: 0.6, wave: {phase: 0, k: Math.PI, ampRaise: 0, ampSpace: 0.05}
  };
  const joints = {
    handL: {x: -0.4, y: 0.2}, wristL: {x: -0.35, y: 0.25}, elL: {x: -0.25, y: 0.3}, shL: {x: -0.12, y: 0.16},
    shR: {x: 0.12, y: 0.16}, elR: {x: 0.25, y: 0.3}, wristR: {x: 0.35, y: 0.25}, handR: {x: 0.4, y: 0.2}
  };
  const before = {l: joints.handL.y, r: joints.handR.y};
  applyTravelingWave(joints, padArm);
  // k=π, phase=0: left sin(0)=0, right sin(-π)=0 — use phase π/2
  const j2 = {
    handL: {x: -0.4, y: 0.2}, wristL: {x: -0.35, y: 0.25}, elL: {x: -0.25, y: 0.3}, shL: {x: -0.12, y: 0.16},
    shR: {x: 0.12, y: 0.16}, elR: {x: 0.25, y: 0.3}, wristR: {x: 0.35, y: 0.25}, handR: {x: 0.4, y: 0.2}
  };
  applyTravelingWave(j2, {...padArm, wave: {...padArm.wave, phase: Math.PI / 2}});
  assert.ok(Math.abs((j2.handL.y - 0.2) - (0.2 - j2.handR.y)) < 1e-9 || (j2.handL.y < 0.2 && j2.handR.y > 0.2) || (j2.handL.y > 0.2 && j2.handR.y < 0.2),
    `seesaw handL ${j2.handL.y} handR ${j2.handR.y}`);
  assert.notEqual(j2.handL.y, before.l);
});

test('capHandsLead lifts wrists above elbows when raised', () => {
  const joints = {
    elL: {x: -0.2, y: 0.10}, wristL: {x: -0.25, y: 0.16}, handL: {x: -0.28, y: 0.18},
    elR: {x: 0.2, y: 0.10}, wristR: {x: 0.25, y: 0.16}, handR: {x: 0.28, y: 0.18}
  };
  capHandsLead(joints, {flexT: 0.8, lead: 1, minClear: 0.018});
  assert.ok(joints.wristL.y <= joints.elL.y - 0.018 + 1e-9);
  assert.ok(joints.handL.y <= joints.elL.y - 0.018 + 1e-9);
  capHandsLeadScreen(joints, {flexT: 0.8, lead: 1, minClear: 0.016});
  assert.ok(joints.wristR.y <= joints.elR.y - 0.016 + 1e-9);
});

test('rest / empty features leave arms unblended', () => {
  resetPadArmSprings();
  const st = padArmState({id: 1, band: 2, tSec: 1, features: emptyPadFeatures(), sense: 1, act: 0, springs: new Map()});
  assert.equal(st.blend, 0);
  const layered = applyPadArmAngles({aUpperL: 0.1, aUpperR: -0.1, aForeL: 0.4, aForeR: -0.4}, st);
  assert.equal(layered.aUpperL, 0.1);
  assert.equal(layered.aForeR, -0.4);
});


test('restHangAmount is full at activation ≤ 0.15 and off by 0.45', () => {
  assert.equal(restHangAmount(0), 1);
  assert.equal(restHangAmount(REST_HANG_ACT), 1);
  assert.ok(restHangAmount(0.3) > 0 && restHangAmount(0.3) < 1);
  assert.equal(restHangAmount(0.45), 0);
  assert.equal(restHangAmount(1), 0);
});

test('capRestHang tucks cocked-out elbows into a natural hang', () => {
  const shW = 0.125, shWidth = 2 * shW;
  const joints = {
    shL: {x: -shW, y: 0.20}, shR: {x: shW, y: 0.20},
    elL: {x: -shW - 0.12, y: 0.32}, elR: {x: shW + 0.12, y: 0.32},
    wristL: {x: -shW - 0.13, y: 0.46}, wristR: {x: shW + 0.13, y: 0.46},
    handL: {x: -shW - 0.14, y: 0.56}, handR: {x: shW + 0.14, y: 0.56}
  };
  capRestHang(joints, {activation: 0.1, shW, upperLen: UPPER_ARM});
  for (const side of ['L', 'R']) {
    const sh = joints['sh' + side], el = joints['el' + side], hand = joints['hand' + side];
    assert.ok(Math.abs(el.x - sh.x) <= REST_HANG_LAT_MAX * shWidth + 1e-9, 'lat ' + side + '=' + Math.abs(el.x - sh.x));
    assert.ok(el.y - sh.y >= REST_HANG_DROP_MIN * UPPER_ARM - 1e-9, 'drop ' + side + '=' + (el.y - sh.y));
    assert.ok(hand.y >= el.y - 0.01, 'hand hangs below elbow ' + side);
  }
});

test('at activation ≤ 0.15 elbows hang by the sides, not cocked out', () => {
  const ids = [1, 2, 3, 6, 9, 12, 20];
  for (const id of ids) for (const band of [0, 1, 2, 3]) for (const act of [0, 0.08, 0.15]) {
    const pose = skeletonPose({id, band, now: 2000, periodMs: 500, activation: act, hush: 1, still: true, armLift: 0, weight: 0, side: -1, ease: 0, dynamics: false});
    const shWidth = 2 * buildFor(id, band).shW;
    for (const side of ['L', 'R']) {
      const sh = pose['sh' + side], el = pose['el' + side];
      const lat = Math.abs(el.x - sh.x);
      const drop = el.y - sh.y;
      assert.ok(lat <= 0.25 * shWidth + 1e-6, 'id=' + id + ' band=' + band + ' act=' + act + ' ' + side + ' lat=' + lat.toFixed(4) + ' max=' + (0.25 * shWidth).toFixed(4));
      assert.ok(drop >= 0.80 * UPPER_ARM - 1e-6, 'id=' + id + ' band=' + band + ' act=' + act + ' ' + side + ' drop=' + drop.toFixed(4));
    }
  }
});

test('capRestUpright stacks a hunched torso over the hips', () => {
  const joints = {
    hipL: {x: -0.09, y: 0.52, z: 0}, hipR: {x: 0.09, y: 0.52, z: 0},
    shL: {x: -0.20, y: 0.20, z: 0.04}, shR: {x: 0.05, y: 0.20, z: 0.04},
    elL: {x: -0.22, y: 0.38}, elR: {x: 0.07, y: 0.38},
    wristL: {x: -0.23, y: 0.52}, wristR: {x: 0.08, y: 0.52},
    handL: {x: -0.24, y: 0.62}, handR: {x: 0.09, y: 0.62},
    neck: {x: -0.08, y: 0.16, z: 0.05}, head: {x: -0.10, y: 0.06, z: 0.06},
    crown: {x: -0.10, y: 0.01, z: 0.06}, heart: {x: -0.07, y: 0.34, z: 0.03}
  };
  capRestUpright(joints, {activation: 0.1});
  const midHip = (joints.hipL.x + joints.hipR.x) / 2;
  const midSh = (joints.shL.x + joints.shR.x) / 2;
  assert.ok(Math.abs(midSh - midHip) <= REST_UPRIGHT_SH_MAX + 1e-9, 'shoulders ' + midSh + ' vs hips ' + midHip);
  for (const k of ['neck', 'head', 'crown', 'heart']) {
    assert.ok(Math.abs(joints[k].x - midHip) <= REST_UPRIGHT_SPINE_MAX + 1e-9, k + ' x=' + joints[k].x);
    assert.ok(Math.abs(joints[k].z || 0) <= 0.005, k + ' z=' + joints[k].z);
  }
});

test('at activation ≤ 0.15 the spine is vertical and shoulders sit over the hips', () => {
  const ids = [1, 2, 3, 6, 9, 12, 20];
  for (const id of ids) for (const band of [0, 1, 2, 3]) for (const act of [0, 0.08, 0.15]) {
    const pose = skeletonPose({id, band, now: 2000, periodMs: 500, activation: act, hush: 1, still: true, armLift: 0, weight: 0, side: -1, ease: 0, dynamics: false});
    const midHip = (pose.hipL.x + pose.hipR.x) / 2;
    const midSh = (pose.shL.x + pose.shR.x) / 2;
    assert.ok(Math.abs(midSh - midHip) <= REST_UPRIGHT_SH_MAX + 1e-6, 'id=' + id + ' band=' + band + ' act=' + act + ' sh-hip=' + (midSh - midHip).toFixed(4));
    for (const k of ['neck', 'head', 'crown', 'heart']) {
      assert.ok(Math.abs(pose[k].x - midHip) <= REST_UPRIGHT_SPINE_MAX + 1e-6, 'id=' + id + ' ' + k + ' x=' + pose[k].x.toFixed(4));
    }
  }
});


function replayLift({padOn, t0, t1, dt = 1 / 30, still = true, activation = 0.18} = {}) {
  resetPadArmSprings();
  const lifts = [];
  const raises = [];
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    const feat = padOn ? featuresAt(t) : emptyPadFeatures();
    const pose = skeletonPose({
      id: 3, band: 2, weight: 0, ease: 0, side: -1, armLift: 0,
      activation, now: t * 1000, periodMs: 500, hush: 1, still,
      padFeatures: feat, armPadSense: 1, dynamics: false
    });
    const shY = (pose.shL.y + pose.shR.y) * 0.5;
    const handY = (pose.handL.y + pose.handR.y) * 0.5;
    lifts.push(shY - handY);
    raises.push(pose.pad ? pose.pad.raise : 0);
  }
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  return {meanLift: mean(lifts), meanRaise: mean(raises), maxRaise: Math.max(...raises), n: lifts.length};
}

test('mid-level sustained pad clearly raises the arms', () => {
  resetPadArmSprings();
  const springs = new Map();
  let st = null;
  for (let t = 0; t <= 2 + 1e-9; t += 1 / 60) {
    st = padArmState({id: 2, band: 2, tSec: t, features: {env: 0.45, note: 0.35, contour: 0.35, vibrato: 0, onset: 0, subLo: 0.4, subHi: 0.25, crescendo: 0.1}, sense: 1, act: 0.2, springs});
  }
  assert.ok(st.raise > 0.42, 'mid pad raise ' + st.raise);
  assert.ok(st.blend > 0.55, 'mid pad blend ' + st.blend);
  assert.ok(st.overhead < 0.15, 'mid pad should not already be overhead, overhead=' + st.overhead);
});

test('rising / high melody contour lifts arms higher than a low line at the same energy', () => {
  function run(contour) {
    resetPadArmSprings();
    const springs = new Map();
    let st = null;
    for (let t = 0; t <= 2 + 1e-9; t += 1 / 60) {
      st = padArmState({id: 5, band: 3, tSec: t, features: {env: 0.70, note: 0.70, contour, vibrato: 0, onset: 0, subLo: contour < 0.4 ? 0.8 : 0.2, subHi: contour < 0.4 ? 0.2 : 0.8, crescendo: 0.2}, sense: 1, act: 0.4, springs});
    }
    return st;
  }
  const low = run(0.22);
  const high = run(0.78);
  assert.ok(high.raise > low.raise + 0.12, `high ${high.raise} vs low ${low.raise}`);
  assert.ok(high.raise > 0.72, 'high contour should approach overhead, raise=' + high.raise);
});

test('pads-on replay shows a clearly higher mean arm lift than pads-off', () => {
  // Demo swell + rise + peak (6–36 s). Low dancer activation and still=true
  // used to hide the pad overlay (hang cap + live-only hook).
  const off = replayLift({padOn: false, t0: 6, t1: 36, still: true, activation: 0.18});
  const on = replayLift({padOn: true, t0: 6, t1: 36, still: true, activation: 0.18});
  assert.ok(on.n > 200, 'sample count ' + on.n);
  assert.ok(off.meanRaise < 0.05, 'pads-off raise ' + off.meanRaise);
  assert.ok(on.meanRaise > 0.45, 'pads-on raise ' + on.meanRaise);
  assert.ok(on.meanRaise > off.meanRaise + 0.35, `raise on ${on.meanRaise} vs off ${off.meanRaise}`);
  assert.ok(on.meanLift > off.meanLift + 0.08, `hand lift on ${on.meanLift} vs off ${off.meanLift}`);
});

test('arm raise eases in without jerky snaps when a pad appears', () => {
  resetPadArmSprings();
  const springs = new Map();
  let prev = 0;
  let maxJump = 0;
  for (let t = 0; t <= 2 + 1e-9; t += 1 / 60) {
    // Instant onset of a full pad at t=0 — springs must absorb it.
    const st = padArmState({id: 7, band: 2, tSec: t, features: {env: 0.85, note: 0.8, contour: 0.7, vibrato: 0, onset: 0, subLo: 0.3, subHi: 0.7, crescendo: 0.5}, sense: 1, act: 0.6, springs});
    if (t > 0) maxJump = Math.max(maxJump, Math.abs(st.raise - prev));
    prev = st.raise;
  }
  assert.ok(maxJump < 0.12, 'frame-to-frame raise jump ' + maxJump);
});

test('padDriveActivation is 0 at rest and releases hang on a mid pad', () => {
  resetPadArmSprings();
  const quiet = padArmState({id: 1, band: 2, tSec: 1, features: emptyPadFeatures(), sense: 1, act: 0, springs: new Map()});
  assert.equal(padDriveActivation(quiet), 0);
  assert.equal(padDriveActivation(null), 0);
  const springs = new Map();
  let st = null;
  for (let t = 0; t <= 2 + 1e-9; t += 1 / 60) {
    st = padArmState({id: 1, band: 2, tSec: t, features: {env: 0.5, note: 0.4, contour: 0.4, vibrato: 0, onset: 0, subLo: 0.4, subHi: 0.3, crescendo: 0.1}, sense: 1, act: 0.2, springs});
  }
  assert.ok(padDriveActivation(st) >= 0.45, 'drive ' + padDriveActivation(st) + ' should clear hang release');
});

test('silence / drums still leave a low-activation dancer hanging', () => {
  resetPadArmSprings();
  const pose = skeletonPose({
    id: 3, band: 2, weight: 0, ease: 0, side: -1, armLift: 0,
    activation: 0.1, now: 3000, periodMs: 500, hush: 1, still: true,
    padFeatures: emptyPadFeatures(), armPadSense: 1, dynamics: false
  });
  const shWidth = 2 * buildFor(3, 2).shW;
  for (const side of ['L', 'R']) {
    const sh = pose['sh' + side], el = pose['el' + side], hand = pose['hand' + side];
    assert.ok(Math.abs(el.x - sh.x) <= REST_HANG_LAT_MAX * shWidth + 1e-6, 'lat ' + side);
    assert.ok(el.y - sh.y >= REST_HANG_DROP_MIN * UPPER_ARM - 1e-6, 'drop ' + side);
    assert.ok(hand.y >= el.y - 0.02, 'hand hangs ' + side);
  }
  assert.ok((pose.pad?.raise || 0) < 0.05);
});
