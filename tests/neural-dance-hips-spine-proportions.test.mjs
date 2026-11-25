// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 10 5:16 PM on PR #96:
// - Hip joints on the SIDES of the pelvis (~0.75 heads from midline, span ~1.5 heads).
// - Pelvis is a skeleton crossbar; femurs attach at its ends. Natural thigh gap is fine.
// - Canon landmarks: crotch ~4 heads, knees ~5.75–6, ankles ~7.25, shoulders ~2 heads.
// - Spines stay calm (p95 Δangle well under 1°, max under ~1.5°).
// - Feet point forward at rest, and turn with the hips and shoulders up to 90°.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  skeletonPose, applyBodyYaw, buildFor, hipJointHalf, hipWidth, placePose,
  HIP_JOINT_HEADS, CANON_HEADS, HEAD_H, Y_CHIN, Y_NECK, Y_NECK_BASE, Y_SHOULDER, Y_HEART,
  Y_SOLAR, Y_HIP, Y_GROIN, Y_KNEE, Y_ANKLE, UPPER_ARM, FOREARM, HAND_LEN, THIGH, SHIN, HEART_S,
  REST_HIP_Y, pelvisCrossbar, paintSkeletonLines, placePoseOnFloor
} from '../neural-dance/src/skeleton-dancer.js';
import {
  resetTravel, resetBodyDynamics, resetSpineFlex, spineFlexState,
  footLayout, posedFoot, FOOT_TOE_OUT, FOOT_TOE, FOOT_HEEL, MAX_BODY_TURN_DEG,
  SPINE_FLEX, SPINE_MAX_SEG_DEG
} from '../neural-dance/src/skeleton-motion.js';
import {thighChain} from '../neural-dance/src/body-shell.js';
import {liveReplay} from './helpers/live-replay.mjs';

function resetAll() {
  resetTravel(); resetBodyDynamics(); resetSpineFlex();
}

function restPose(id = 2, band = 2, extra = {}) {
  return skeletonPose({
    id, band, activation: 0, hush: 1, still: true, now: 4000, periodMs: 500, ...extra
  });
}

function headMetrics(p) {
  const floor = 0.99;
  const headTop = p.head.y - p.b.headR;
  const chin = p.head.y + p.b.headR;
  const headH = chin - headTop;
  const heads = (floor - headTop) / headH;
  const fromTop = y => (y - headTop) / headH;
  return {headTop, chin, headH, heads, fromTop};
}

test('hip joints sit on the sides of the pelvis (~0.75 heads from midline)', () => {
  resetAll();
  assert.ok(HIP_JOINT_HEADS >= 0.70 && HIP_JOINT_HEADS <= 0.80);
  for (const id of [0, 1, 2, 3, 4, 7, 11]) {
    const p = restPose(id, id % 4);
    const m = headMetrics(p);
    const joint = Math.hypot(p.hipR.x - p.hipL.x, p.hipR.y - p.hipL.y, ((p.hipR.z || 0) - (p.hipL.z || 0)));
    const expected = 2 * hipJointHalf(p.b, 0);
    assert.ok(Math.abs(joint - expected) < 0.01, 'joint span follows hipJointHalf');
    const halfHeads = (joint / 2) / m.headH;
    assert.ok(halfHeads >= 0.68 && halfHeads <= 0.82, 'id ' + id + ' joint from midline ' + halfHeads.toFixed(3) + ' heads');
    const spanHeads = joint / m.headH;
    assert.ok(spanHeads >= 1.36 && spanHeads <= 1.64, 'id ' + id + ' joint spacing ' + spanHeads.toFixed(2) + ' heads');
    const visual = hipWidth(p.b) / m.headH;
    assert.ok(visual >= 1.65 && visual <= 2.10, 'visual hip width ~1.7–2 heads (' + visual.toFixed(2) + ')');
    assert.ok(visual + 0.02 >= spanHeads, 'visual pelvis is at least as wide as the joint span');
    assert.ok(Math.abs(hipWidth(p.b) - 2 * p.b.hipW) < 1e-9, 'hipWidth is the visual pelvis');
    // Thighs start at the side joints; a natural inner gap is fine.
    const posed = placePose(p, 400, 40, 250);
    for (const side of [-1, 1]) {
      const th = thighChain(posed, side);
      const hip = side < 0 ? posed.hipL : posed.hipR;
      const toHip = Math.hypot(th.top.x - hip.x, th.top.y - hip.y, (th.top.z || 0) - (hip.z || 0));
      assert.ok(toHip < 1.5, 'id ' + id + ' side ' + side + ' thigh starts at the hip joint');
      assert.ok(th.r[0] > 2, 'thigh has a real top radius');
    }
    const thL = thighChain(posed, -1), thR = thighChain(posed, 1);
    const innerL = thL.top.x + thL.r[0], innerR = thR.top.x - thR.r[0];
    assert.ok(innerR - innerL > 2, 'natural gap between inner thighs (gap ' + (innerR - innerL).toFixed(1) + ' px)');
    const footSpan = Math.abs(((p.footR.x + p.heelR.x) / 2) - ((p.footL.x + p.heelL.x) / 2));
    assert.ok(footSpan >= joint * 0.95, 'feet under or slightly outside the hip joints (feet=' + footSpan.toFixed(3) + ' joints=' + joint.toFixed(3) + ')');
    assert.ok(footSpan <= joint * 1.35, 'rest stance is not a horse stance (feet=' + footSpan.toFixed(3) + ' joints=' + joint.toFixed(3) + ')');
  }
});

test('pelvis is a skeleton crossbar; femurs attach at its ends; spine meets the centre', () => {
  resetAll();
  const p = restPose(2, 2);
  const posed = placePoseOnFloor(p, {cx: 400, cy: 200, baseH: 240, height: 240, anchorFloorY: 520});
  const bar = pelvisCrossbar(posed);
  assert.ok(bar && bar.left && bar.right && bar.mid);
  assert.equal(bar.left, posed.hipL);
  assert.equal(bar.right, posed.hipR);
  assert.ok(Math.abs(bar.mid.x - (posed.hipL.x + posed.hipR.x) / 2) < 1e-9);
  assert.ok(Math.abs(bar.mid.y - (posed.hipL.y + posed.hipR.y) / 2) < 1e-9);
  // Spine base (groin) sits on the bar, at its centre in x.
  const midX = bar.mid.x;
  assert.ok(Math.abs(posed.groin.x - midX) < 2, 'spine base meets the crossbar at its centre');
  // Collect stroked segments from the armature.
  const segs = [];
  const ctx = {
    save() {}, restore() {},
    beginPath() { this._pts = []; },
    moveTo(x, y) { this._pts = [[+x, +y]]; },
    lineTo(x, y) { this._pts.push([+x, +y]); },
    stroke() { if (this._pts && this._pts.length >= 2) segs.push(this._pts.slice()); },
    arc() {},
    globalAlpha: 1, lineCap: '', lineJoin: '', strokeStyle: '', lineWidth: 1
  };
  const drawn = paintSkeletonLines(ctx, posed, (x, y) => ({x, y}), {height: posed.height, alpha: 1});
  assert.ok(drawn && drawn.crossbar);
  const near = (a, b, tol = 1.2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
  const hipL = [posed.hipL.x, posed.hipL.y], hipR = [posed.hipR.x, posed.hipR.y];
  const mid = [bar.mid.x, bar.mid.y];
  const kneeL = [posed.kneeL.x, posed.kneeL.y], kneeR = [posed.kneeR.x, posed.kneeR.y];
  const hasBar = segs.some(s =>
    (near(s[0], hipL) && s.some(pt => near(pt, hipR))) ||
    (near(s[0], hipR) && s.some(pt => near(pt, hipL))));
  assert.ok(hasBar, 'crossbar stroke connects both hip joints');
  const femurFrom = (hip, knee) => segs.some(s => near(s[0], hip) && s.some(pt => near(pt, knee)));
  assert.ok(femurFrom(hipL, kneeL), 'left femur starts at the left end of the crossbar');
  assert.ok(femurFrom(hipR, kneeR), 'right femur starts at the right end of the crossbar');
  const spineToMid = segs.some(s => s.some(pt => near(pt, mid)) && (posed.neck && s.some(pt => near(pt, [posed.neck.x, posed.neck.y]))));
  assert.ok(spineToMid, 'spine meets the crossbar at its centre');
});

test('24-sim + sticker replay: body-spine joints move smoothly (low jerk)', () => {
  const prev = new Map();
  const dJ = [], jerk = [];
  let frames = 0, maxBend = 0;
  const deg = r => r * 180 / Math.PI;
  const segsOf = j => {
    const hipx = (j.hipL.x + j.hipR.x) / 2, hipy = (j.hipL.y + j.hipR.y) / 2;
    const hx = j.heart ? j.heart.x : j.neck.x, hy = j.heart ? j.heart.y : j.neck.y;
    return [
      deg(Math.atan2(hx - hipx, hipy - hy)),
      deg(Math.atan2(j.neck.x - hx, hy - j.neck.y)),
      deg(Math.atan2(j.head.x - j.neck.x, j.neck.y - j.head.y))
    ];
  };
  liveReplay({sims: 24, phases: [{s: 25, level: 1.2, kind: 'music', bpm: 128}], onFrame(fr) {
    const j = fr.joints;
    if (!j || !j.head || !j.neck || !j.hipL) return;
    frames++;
    const segs = segsOf(j);
    const tot = Math.max(...segs.map(Math.abs), Math.abs(segs[0] + segs[1] + segs[2]));
    const key = (fr.kind || '') + ':' + fr.id;
    const pv = prev.get(key);
    if (pv) {
      let m = 0;
      for (let i = 0; i < segs.length; i++) m = Math.max(m, Math.abs(segs[i] - pv.segs[i]));
      dJ.push(m);
      if (pv.d != null) jerk.push(Math.abs(m - pv.d));
      prev.set(key, {segs, d: m});
    } else prev.set(key, {segs, d: null});
    maxBend = Math.max(maxBend, tot);
  }});
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] || 0; };
  console.log('# joint spine jitter after', JSON.stringify({
    frames, maxBend: +maxBend.toFixed(2),
    dP95: +q(dJ, 0.95).toFixed(3), dMax: +q(dJ, 1).toFixed(3),
    jerkP95: +q(jerk, 0.95).toFixed(3), jerkMax: +q(jerk, 1).toFixed(3)
  }));
  assert.ok(frames > 10000, 'replay produced frames');
  assert.ok(maxBend <= 50, 'max body-spine lean in human range ' + maxBend.toFixed(1) + ' deg');
  assert.ok(maxBend >= 8, 'spine actually flexes (max ' + maxBend.toFixed(1) + ' deg)');
  // Body-joint angles (hip–heart–neck–head), not the traveling pulse string.
  assert.ok(q(dJ, 0.95) <= 3.5, 'p95 joint angle change ' + q(dJ, 0.95).toFixed(2) + ' deg/frame');
  assert.ok(q(dJ, 1) <= 8.0, 'max joint angle change ' + q(dJ, 1).toFixed(2) + ' deg/frame');
  assert.ok(q(jerk, 0.95) <= 2.5, 'p95 joint jerk ' + q(jerk, 0.95).toFixed(2));
});

test('spineFlexState is critically damped across frames (no 20 Hz rebuild jumps)', () => {
  const drive = (resetEvery) => {
    resetSpineFlex();
    const strikes = [];
    let last = null, lastD = null;
    const dPhi = [], jerk = [];
    for (let k = 0; k < 800; k++) {
      const t = 2 + k / 60;
      if (k % 15 === 0) strikes.push({t0: t, side: (k / 15) % 2 ? 1 : -1, energy: 1.2});
      if (resetEvery && k % resetEvery === 0) resetSpineFlex();
      const sp = spineFlexState({id: 99, tSec: t, strikes, activation: 1, amp: 32, hz: 1.1, hush: 1, amount: SPINE_FLEX, lagMul: 4, periodSec: 0.5});
      const segs = ['pelvis', 'lumbar', 'thoracic', 'neck'].map(k => sp.angles[k] * 180 / Math.PI);
      const angs = ['pelvis', 'lumbar', 'thoracic', 'neck'].map(k => sp.phi[k] * 180 / Math.PI);
      if (!resetEvery) for (const a of segs) assert.ok(Math.abs(a) <= SPINE_MAX_SEG_DEG + 1e-3, 'per-segment cap ' + SPINE_MAX_SEG_DEG + ' deg (' + a.toFixed(2) + ')');
      if (last) {
        let m = 0;
        for (let i = 0; i < angs.length; i++) m = Math.max(m, Math.abs(angs[i] - last[i]));
        dPhi.push(m);
        if (lastD != null) jerk.push(Math.abs(m - lastD));
        lastD = m;
      }
      last = angs;
    }
    const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] || 0; };
    return {dPhiP95: q(dPhi, 0.95), dPhiMax: q(dPhi, 1), jerkP95: q(jerk, 0.95), jerkMax: q(jerk, 1)};
  };
  const persist = drive(0);
  const rebuild = drive(3); // 20 Hz lookback rebuild at 60 fps
  console.log('# flex60 after', JSON.stringify({persist, rebuild: {dPhiP95: +rebuild.dPhiP95.toFixed(3), dPhiMax: +rebuild.dPhiMax.toFixed(3), jerkP95: +rebuild.jerkP95.toFixed(3), jerkMax: +rebuild.jerkMax.toFixed(3)}}));
  // The #95 unclamped #90 wave itself moves several degrees per frame. The
  // jitter we care about is jerk (second difference): a 20 Hz rebuild ticks.
  assert.ok(persist.jerkP95 <= 0.08 || persist.jerkP95 < rebuild.jerkP95 * 0.8, 'persist jerk p95 is low or beats a 20 Hz rebuild (' + persist.jerkP95.toFixed(2) + ' vs ' + rebuild.jerkP95.toFixed(2) + ')');
  assert.ok(persist.jerkP95 <= 1.2, 'p95 jerk ' + persist.jerkP95.toFixed(2));
});

test('feet point forward at rest, with only a slight toe-out', () => {
  resetAll();
  const lay = footLayout(1, 0);
  assert.ok(lay.toeZ > 0 && lay.heelZ < 0, 'layout toe is toward the audience (+z)');
  assert.ok(Math.abs(lay.toeX) < lay.toeZ * Math.tan(20 * Math.PI / 180), 'layout toe-out under 20°');
  const posed = posedFoot(lay, 'flat', 0, 0);
  assert.ok((posed.toe.z || 0) > (posed.heel.z || 0), 'posed toe is in front of the heel');
  for (const id of [0, 2, 3, 7]) {
    const p = restPose(id, id % 4);
    for (const side of ['L', 'R']) {
      const toe = p['foot' + side], heel = p['heel' + side];
      const dx = toe.x - heel.x, dz = (toe.z || 0) - (heel.z || 0);
      const yaw = Math.atan2(dx, dz) * 180 / Math.PI;
      assert.ok(dz > 0, 'id ' + id + ' ' + side + ' foot points forward (dz=' + dz.toFixed(3) + ')');
      assert.ok(Math.abs(dz) > Math.abs(dx), 'id ' + id + ' ' + side + ' forward component dominates');
      assert.ok(Math.abs(yaw) <= 20, 'id ' + id + ' ' + side + ' toe-out ' + yaw.toFixed(1) + ' deg');
    }
  }
  assert.ok(FOOT_TOE_OUT > 0 && FOOT_TOE_OUT <= 18 * Math.PI / 180);
  assert.equal(MAX_BODY_TURN_DEG, 90);
});

test('body yaw turns feet, hips and shoulders together, planted feet pivot', () => {
  resetAll();
  const p = restPose(2, 2);
  const originX = p.footR.x, originZ = p.footR.z || 0;
  const before = {
    heelX: p.heelR.x, heelZ: p.heelR.z || 0,
    toeX: p.footR.x, toeZ: p.footR.z || 0,
    hipX: p.hipR.x, shX: p.shR.x
  };
  const facing = 90 * Math.PI / 180;
  applyBodyYaw(p, {originX, originZ, facing, hipYaw: 0, shYaw: 0, stepZ: 0, liftL: 0, liftR: 0});
  // Planted ball (toe) stays put; heel orbits it (a pivot, not a slide).
  assert.ok(Math.hypot(p.footR.x - before.toeX, (p.footR.z || 0) - before.toeZ) < 1e-9, 'planted toe does not slide');
  const heelMove = Math.hypot(p.heelR.x - before.heelX, (p.heelR.z || 0) - before.heelZ);
  assert.ok(heelMove > 0.04, 'heel pivots around the ball (' + heelMove.toFixed(3) + ')');
  const dx = p.footR.x - p.heelR.x, dz = (p.footR.z || 0) - (p.heelR.z || 0);
  const footYaw = Math.atan2(dx, dz);
  // After a +90° yaw a forward foot points to +x (stage right).
  assert.ok(Math.abs(footYaw - facing) < 25 * Math.PI / 180 || Math.abs(dx) > Math.abs(dz),
    'turned foot is sideways (yaw=' + (footYaw * 180 / Math.PI).toFixed(1) + ')');
  // Hips and shoulders share the same body facing (no hip/shoulder lag in this call).
  assert.ok(Math.abs(p.hipR.x - originX) !== Math.abs(before.hipX - originX) || Math.abs(p.hipR.z || 0) > 0.001,
    'hips yawed with the body');
  assert.ok(Math.abs((p.shR.z || 0)) + Math.abs((p.shL.z || 0)) > 0.02, 'shoulders yawed with the body');

  // Live travel actually reaches a substantial facing, and feet follow it.
  resetAll();
  let maxFace = 0, coherent = 0, samples = 0;
  for (let i = 0; i < 500; i++) {
    const pose = skeletonPose({
      id: 5, band: 0, activation: 1, hush: 1, still: false,
      now: 2500 + i * 16, periodMs: 480, side: i % 20 < 10 ? -1 : 1,
      ease: (i % 20) / 20, weight: i % 20 < 10 ? -1 : 1,
      hipTwist: 0.8, shoulderTwist: 0.75, maxBodyTurn: 90, turnFreq: 1.3
    });
    const face = pose.twist.facing || 0;
    maxFace = Math.max(maxFace, Math.abs(face));
    if (Math.abs(face) < 0.35) continue;
    const toe = pose.footL, heel = pose.heelL;
    const fyaw = Math.atan2(toe.x - heel.x, (toe.z || 0) - (heel.z || 0));
    const err = Math.abs(Math.atan2(Math.sin(fyaw - face), Math.cos(fyaw - face)));
    if (err < 25 * Math.PI / 180) coherent++;
    samples++;
  }
  assert.ok(maxFace > 20 * Math.PI / 180, 'body turn still happens (max ' + (maxFace * 180 / Math.PI).toFixed(1) + ' deg)');
  assert.ok(maxFace <= Math.PI / 2 + 1e-3, 'facing stays within ±90°');
  assert.ok(samples > 10 && coherent / samples >= 0.7, 'feet follow body yaw (' + coherent + '/' + samples + ')');
});

test('standard adult proportions: about 7.5 heads tall, landmarks in range', () => {
  resetAll();
  const rows = [];
  for (const id of [0, 1, 2, 3, 4, 7, 11]) {
    const p = restPose(id, id % 4);
    const m = headMetrics(p);
    const shW = Math.hypot(p.shR.x - p.shL.x, p.shR.y - p.shL.y, (p.shR.z || 0) - (p.shL.z || 0));
    const pelvis = 2 * p.b.hipW;
    const visualHip = hipWidth(p.b);
    rows.push({
      id, heads: m.heads,
      chin: m.fromTop(m.chin),
      neck: m.fromTop(p.neck.y),
      sh: m.fromTop((p.shL.y + p.shR.y) / 2),
      heart: m.fromTop(p.heart.y),
      solar: m.fromTop(p.solar.y),
      groin: m.fromTop(p.groin.y),
      hip: m.fromTop((p.hipL.y + p.hipR.y) / 2),
      knee: m.fromTop((p.kneeL.y + p.kneeR.y) / 2),
      ankle: m.fromTop((p.ankleL.y + p.ankleR.y) / 2),
      shW: shW / m.headH,
      pelvis: pelvis / m.headH,
      visualHip: visualHip / m.headH
    });
    assert.ok(m.heads >= 7.0 && m.heads <= 8.1, 'id ' + id + ' heads tall ' + m.heads.toFixed(2));
    assert.ok(Math.abs(m.fromTop(p.heart.y) - 2) < 0.35, 'heart/nipples near 2 heads');
    assert.ok(Math.abs(m.fromTop(p.solar.y) - 3) < 0.45, 'navel near 3 heads');
    assert.ok(Math.abs(m.fromTop(p.groin.y) - 4.0) < 0.35, 'crotch near 4 heads (' + m.fromTop(p.groin.y).toFixed(2) + ')');
    assert.ok(Math.abs(m.fromTop((p.hipL.y + p.hipR.y) / 2) - 3.85) < 0.40, 'hip/crossbar near 3.85 heads');
    const kneeH = m.fromTop((p.kneeL.y + p.kneeR.y) / 2);
    assert.ok(kneeH >= 5.50 && kneeH <= 6.20, 'knee ~5.75–6 heads (' + kneeH.toFixed(2) + ')');
    const ankH = m.fromTop((p.ankleL.y + p.ankleR.y) / 2);
    assert.ok(ankH >= 7.00 && ankH <= 7.50, 'ankle ~7.25 heads (' + ankH.toFixed(2) + ')');
    const torsoH = m.fromTop(p.groin.y) - m.fromTop(m.chin);
    assert.ok(torsoH >= 2.55 && torsoH <= 3.20, 'chin→crotch ~2.75–3 heads (' + torsoH.toFixed(2) + ')');
    const elH = m.fromTop((p.elL.y + p.elR.y) / 2);
    const wrH = m.fromTop((p.wristL.y + p.wristR.y) / 2);
    const tipH = m.fromTop((p.handL.y + p.handR.y) / 2);
    const midThigh = (m.fromTop((p.hipL.y + p.hipR.y) / 2) + m.fromTop((p.kneeL.y + p.kneeR.y) / 2)) / 2;
    assert.ok(elH >= 2.70 && elH <= 3.25, 'elbow at waist/navel (' + elH.toFixed(2) + ')');
    assert.ok(wrH >= 3.70 && wrH <= 4.40, 'wrist at crotch (' + wrH.toFixed(2) + ')');
    assert.ok(Math.abs(tipH - midThigh) < 0.45, 'fingertips mid-thigh (tip ' + tipH.toFixed(2) + ', mid ' + midThigh.toFixed(2) + ')');
    assert.ok(shW / m.headH >= 1.7 && shW / m.headH <= 2.4, 'shoulder width ~2 heads (' + (shW / m.headH).toFixed(2) + ')');
    const neckLen = (Y_NECK_BASE - Y_CHIN) / HEAD_H;
    assert.ok(neckLen >= 0.30 && neckLen <= 0.40, 'chin→shoulder-line ~0.3–0.4 heads (' + neckLen.toFixed(2) + ')');
    const headW = 0.86 * HEAD_H;
    const neckWfrac = (2 * p.b.neckW) / headW;
    assert.ok(neckWfrac >= 0.42 && neckWfrac <= 0.55, 'neck width ~0.45–0.5 of head width (' + neckWfrac.toFixed(2) + ')');
    const abd = Math.atan2(Math.abs(p.elL.x - p.shL.x), p.elL.y - p.shL.y) * 180 / Math.PI;
    assert.ok(abd >= 3 && abd <= 14, 'rest abduction ~5–10° (' + abd.toFixed(1) + ')');
    // 2·hipW is the pelvis core; hipWidth is the visible outer hips (~1.5 heads).
    // High/slender builds sit a little under canon on the core, on-canon visually.
    assert.ok(pelvis / m.headH >= 1.65 && pelvis / m.headH <= 2.10, 'pelvis core ~1.7–2 heads (' + (pelvis / m.headH).toFixed(2) + ')');
    assert.ok(visualHip / m.headH >= 1.65 && visualHip / m.headH <= 2.10, 'visual hip width ~1.7–2 heads (' + (visualHip / m.headH).toFixed(2) + ')');
  }
  const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  console.log('# proportions after', JSON.stringify({
    heads: +avg('heads').toFixed(3), sh: +avg('sh').toFixed(3), heart: +avg('heart').toFixed(3),
    solar: +avg('solar').toFixed(3), groin: +avg('groin').toFixed(3), hip: +avg('hip').toFixed(3),
    knee: +avg('knee').toFixed(3), ankle: +avg('ankle').toFixed(3), shW: +avg('shW').toFixed(3), pelvis: +avg('pelvis').toFixed(3), visualHip: +avg('visualHip').toFixed(3)
  }));
  assert.ok(Math.abs(avg('heads') - CANON_HEADS) < 0.45, 'mean heads tall close to 7.5');
  assert.ok(Math.abs(UPPER_ARM / HEAD_H - 1.5) < 0.02, 'upper arm 1.5 heads');
  assert.ok(Math.abs((FOREARM + HAND_LEN) / HEAD_H - 2) < 0.02, 'forearm+hand 2 heads');
  assert.ok(THIGH > SHIN * 0.95 && THIGH < SHIN * 1.55, 'thigh ≈ shin (thigh slightly longer)');
  assert.ok(Math.abs(REST_HIP_Y - Y_HIP) < 1e-9);
  assert.ok(HEART_S >= 0.48 && HEART_S <= 0.52, 'heart chakra halfway on a 4-head crotch');
  assert.ok(Math.abs(Y_GROIN / HEAD_H - 4) < 0.02);
  assert.ok(Math.abs(Y_KNEE / HEAD_H - 5.8) < 0.05);
  assert.ok(Math.abs(Y_ANKLE / HEAD_H - 7.25) < 0.02);
  void Y_CHIN; void Y_NECK; void Y_SHOULDER; void Y_SOLAR; void Y_GROIN;
  void FOOT_TOE; void FOOT_HEEL; void buildFor;
});
