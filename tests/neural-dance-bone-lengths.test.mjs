// Rigid bone lengths (TJ Nov 10 6:27 PM): pelvis-to-neck and each spine /
// limb segment stay within ±1% over a high-activation run. Vertical energy
// comes from knees, ankles and pelvis height, not from stretching the spine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  skeletonPose, dist3, BONE_LEN, lockPoseBones,
  resetBodyDynamics, HEAD_H
} from '../neural-dance/src/skeleton-dancer.js';
import {resetTravel, resetSpineFlex, resetNeckFollow} from '../neural-dance/src/skeleton-motion.js';

function resetAll() {
  resetTravel(); resetBodyDynamics(); resetSpineFlex();
  if (typeof resetNeckFollow === 'function') resetNeckFollow();
}

function bones(p) {
  const midSh = p.shL && p.shR ? {
    x: (p.shL.x + p.shR.x) * 0.5,
    y: (p.shL.y + p.shR.y) * 0.5,
    z: ((+p.shL.z || 0) + (+p.shR.z || 0)) * 0.5
  } : null;
  const pelvis = p.pelvis || (p.hipL && p.hipR ? {
    x: (p.hipL.x + p.hipR.x) * 0.5,
    y: (p.hipL.y + p.hipR.y) * 0.5,
    z: ((+p.hipL.z || 0) + (+p.hipR.z || 0)) * 0.5
  } : p.groin);
  const chin = p.head && p.b ? {x: p.head.x, y: p.head.y + p.b.headR, z: p.head.z || 0} : null;
  const napeY = p.neck ? p.neck.y + (BONE_LEN.neckShoulder * 0.5) : 0;
  const nape = p.neck ? {x: p.neck.x, y: napeY, z: p.neck.z || 0} : null;
  const out = {
    pelvisLumbar: dist3(pelvis, p.lumbar),
    lumbarThoracic: dist3(p.lumbar, p.thoracic),
    thoracicNeck: dist3(p.thoracic, p.neck),
    neckHead: dist3(p.neck, p.head),
    neckCrown: dist3(p.neck, p.crown),
    neckShoulder: dist3(p.neck, midSh),
    upperArmL: dist3(p.shL, p.elL),
    upperArmR: dist3(p.shR, p.elR),
    forearmL: dist3(p.elL, p.wristL),
    forearmR: dist3(p.elR, p.wristR),
    handL: dist3(p.wristL, p.handL),
    handR: dist3(p.wristR, p.handR),
    thighL: dist3(p.hipL, p.kneeL),
    thighR: dist3(p.hipR, p.kneeR),
    shinL: dist3(p.kneeL, p.ankleL),
    shinR: dist3(p.kneeR, p.ankleR)
  };
  out.pelvisToNeck = (out.pelvisLumbar || 0) + (out.lumbarThoracic || 0) + (out.thoracicNeck || 0);
  return out;
}

const REST = { ...BONE_LEN, pelvisToNeck: BONE_LEN.pelvisLumbar + BONE_LEN.lumbarThoracic + BONE_LEN.thoracicNeck, neck: (0.5 * HEAD_H) /* chin is headR below head center, neck-head is Y_NECK-0.5H, chin-neck = Y_NECK-H = BONE_NECK_HEAD - 0.5H wait */ };
// chin = head.y + headR; neck-head = BONE_NECK_HEAD; chin-neck = BONE_NECK_HEAD - headR = (Y_NECK-0.5H)-0.5H = Y_NECK-HEAD_H = 0.20 H
REST.upperArmL = BONE_LEN.upperArm; REST.upperArmR = BONE_LEN.upperArm;
REST.forearmL = BONE_LEN.forearm; REST.forearmR = BONE_LEN.forearm;
REST.handL = BONE_LEN.hand; REST.handR = BONE_LEN.hand;
REST.thighL = BONE_LEN.thigh; REST.thighR = BONE_LEN.thigh;
REST.shinL = BONE_LEN.shin; REST.shinR = BONE_LEN.shin;

test('all bone lengths stay within ±1% over a 60 s high-activation run', () => {
  resetAll();
  const strikes = [];
  for (let t0 = 0; t0 <= 60000; t0 += 480) strikes.push({t0: t0 / 1000, side: (Math.floor(t0 / 480) % 2 ? 1 : -1), energy: 1, kind: 'transfer', contact: 'heel'});
  const maxDev = {};
  const worst = {};
  const keys = Object.keys(REST);
  for (const k of keys) { maxDev[k] = 0; worst[k] = 0; }
  const N = 60 * 30;
  for (let i = 0; i < N; i++) {
    const t = 1000 + i * (1000 / 30);
    const beat = Math.floor((t - 1000) / 480);
    const squat = (i % 200) < 40 ? 0.9 : ((i % 200) < 80 ? 0.3 : 0);
    const tall = (i % 300) > 240 ? 1 : 0;
    const p = skeletonPose({
      id: 4, band: 2, now: t, periodMs: 480, activation: 1, hush: 1, squat, tall,
      side: beat % 2 ? 1 : -1, weight: beat % 2 ? 1 : -1, ease: ((t - 1000) % 480) / 480,
      beat, stepHz: 1000 / 480, hipTwist: 0.8, shoulderTwist: 0.75,
      maxBodyTurn: 90, turnFreq: 1.2, pulseAmp: 20, pulseHz: 1.05, strikes
    });
    const b = bones(p);
    for (const k of keys) {
      if (!(REST[k] > 0) || !(b[k] > 0)) continue;
      const dev = Math.abs(b[k] - REST[k]) / REST[k];
      if (dev > maxDev[k]) { maxDev[k] = dev; worst[k] = b[k]; }
    }
  }
  const report = {};
  for (const k of keys) report[k] = maxDev[k] ? +(maxDev[k] * 100).toFixed(3) : 0;
  console.log('bone length max deviation %', JSON.stringify(report));
  const offenders = Object.entries(maxDev).filter(([, d]) => d > 0.01);
  assert.equal(offenders.length, 0, 'bones drifted more than 1%: ' + offenders.map(([k, d]) => k + '=' + (d * 100).toFixed(2) + '%').join(', '));
});

test('lockPoseBones is a no-op on an already rigid rest pose', () => {
  resetAll();
  const p = skeletonPose({id: 3, band: 1, activation: 0, hush: 1, still: true, now: 4000, periodMs: 480});
  const before = bones(p);
  lockPoseBones(p);
  const after = bones(p);
  for (const k of ['pelvisLumbar', 'thoracicNeck', 'neckHead', 'upperArmL', 'thighL', 'shinL']) {
    if (!(before[k] > 0)) continue;
    assert.ok(Math.abs(after[k] - before[k]) / before[k] < 0.002, k + ' moved');
  }
});
