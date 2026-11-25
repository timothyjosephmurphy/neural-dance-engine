// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 11 6:50 PM: "The bend in the back is way too dramatic. It's got an
// unnatural indent in the backside, and the chest is pushed too far out.
// Straighten the spine to make it like a real spine."
//
// The torso stations used to sit the chest 0.22·shW in front of the spine
// and the seat 0.34·hipW behind the groin, and addTorsoPath met the hips
// with a 75–100° crotch corner — a swayback even with a straight skeleton.
// Sweep yaws and dance poses: mild S, no deep scoop, no chest thrust, a
// smooth hip-to-seat join, and spine flex that stays in a human range.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTorsoPath, torsoStations,
  TORSO_CHEST_Z, TORSO_WAIST_Z, TORSO_HIP_Z, TORSO_SEAT_Z,
  TORSO_CHEST_DEPTH, TORSO_CHEST_W, TORSO_WAIST_W
} from '../neural-dance/src/body-shell.js';
import {skeletonPose, placePose} from '../neural-dance/src/skeleton-dancer.js';
import {
  spineFlexState, resetSpineFlex, SPINE_FLEX,
  SPINE_MAX_SEG_DEG, SPINE_MAX_LATERAL, SPINE_MAX_FLEX,
  SPINE_MAX_FLEX_SQUAT, SPINE_MAX_EXT
} from '../neural-dance/src/skeleton-motion.js';

const DEG = Math.PI / 180;

function recorder() {
  const ops = [];
  let cur = null;
  return {
    ops,
    moveTo(x, y) { cur = {x, y}; ops.push({k: 'M', a: cur, b: cur}); },
    lineTo(x, y) { const b = {x, y}; ops.push({k: 'L', a: cur, b}); cur = b; },
    quadraticCurveTo(cx, cy, x, y) { const b = {x, y}; ops.push({k: 'Q', a: cur, c: {x: cx, y: cy}, b}); cur = b; },
    closePath() {}, arc() {}, ellipse() {}
  };
}
const tanIn = op => op.k === 'Q' ? {x: op.b.x - op.c.x, y: op.b.y - op.c.y} : {x: op.b.x - op.a.x, y: op.b.y - op.a.y};
const tanOut = op => op.k === 'Q' ? {x: op.c.x - op.a.x, y: op.c.y - op.a.y} : {x: op.b.x - op.a.x, y: op.b.y - op.a.y};
const angle = (u, v) => {
  const l = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  return l < 1e-12 ? 0 : Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / l))) / DEG;
};
const same = (p, q, h) => Math.hypot(p.x - q.x, p.y - q.y) < h * 1e-5;
const atYaw = (pose, yaw) => ({...pose, twist: {...(pose.twist || {}), facing: yaw}});

function sample(op, n = 16) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    if (op.k === 'Q') out.push({
      x: u * u * op.a.x + 2 * u * t * op.c.x + t * t * op.b.x,
      y: u * u * op.a.y + 2 * u * t * op.c.y + t * t * op.b.y
    });
    else out.push({x: op.a.x + (op.b.x - op.a.x) * t, y: op.a.y + (op.b.y - op.a.y) * t});
  }
  return out;
}

function pathOf(pose) {
  const rec = recorder();
  addTorsoPath(rec, pose);
  return {ops: rec.ops, S: torsoStations(pose), h: pose.height};
}

// Signed facing: +1 if chest mid is to the +x of the heart (or of the hip mid).
function fwdSign(S, pose) {
  const d = S.chest.midX - (pose.heart ? pose.heart.x : S.hip.midX);
  if (Math.abs(d) > 1e-6) return Math.sign(d);
  const d2 = S.chest.midX - S.hip.midX;
  return Math.sign(d2) || 1;
}
const backX = (st, fwd) => fwd > 0 ? Math.min(st.xL, st.xR) : Math.max(st.xL, st.xR);
const frontX = (st, fwd) => fwd > 0 ? Math.max(st.xL, st.xR) : Math.min(st.xL, st.xR);

function hipSeatBreak(ops, S, h) {
  const hips = [{x: S.hip.xL, y: S.hip.y}, {x: S.hip.xR, y: S.hip.y}];
  let worst = 0;
  for (let i = 0; i + 1 < ops.length; i++) {
    const a = ops[i], b = ops[i + 1];
    if (a.k === 'M' || b.k === 'M') continue;
    for (const hp of hips) {
      if (same(a.b, hp, h)) worst = Math.max(worst, angle(tanIn(a), tanOut(b)));
    }
  }
  return worst;
}

// How far the waist-back sits forward of the chest-back → hip-back chord, in heights.
function waistHollow(S, pose) {
  const fwd = fwdSign(S, pose);
  const yC = S.chest.y, yW = S.waist.y, yH = S.hip.y;
  const t = (yW - yC) / Math.max(1e-6, yH - yC);
  const chord = backX(S.chest, fwd) + (backX(S.hip, fwd) - backX(S.chest, fwd)) * t;
  const post = (x) => -fwd * x;
  return (post(chord) - post(backX(S.waist, fwd))) / pose.height;
}

function chestFrontOverShoulder(S, pose) {
  const fwd = fwdSign(S, pose);
  const post = (x) => -fwd * x;
  return (post(frontX(S.sh, fwd)) - post(frontX(S.chest, fwd))) / pose.height;
}

const POSES = [];
for (const band of [0, 1, 2, 3]) {
  for (const now of [0, 800, 1600, 2400, 4000, 5600]) {
    const dancing = now > 0;
    const unit = skeletonPose({
      id: 7 + band * 5, band,
      weight: band % 2 ? 0.4 : -0.3,
      ease: dancing ? 0.3 : 0,
      side: band % 2 ? 1 : -1,
      now,
      activation: dancing ? 0.35 + 0.25 * band : 0,
      hush: dancing ? 1 : 0,
      still: !dancing
    });
    const posed = placePose(unit, 300 + band * 200, 80 + band * 40, 180 + band * 20);
    posed._rest = !dancing;
    POSES.push(posed);
  }
}

test('torso profile offsets are a mild S, not a swayback', () => {
  assert.ok(TORSO_CHEST_Z <= 0.12, 'chest sits at most 0.12 shW in front of the spine (was 0.22)');
  assert.ok(TORSO_CHEST_Z >= 0.04, 'a little chest remains so the profile still reads as a body');
  assert.ok(TORSO_WAIST_Z <= 0.05);
  assert.ok(TORSO_HIP_Z >= -0.08 && TORSO_HIP_Z <= 0, 'hips are only slightly back');
  assert.ok(TORSO_SEAT_Z >= -0.18 && TORSO_SEAT_Z < TORSO_HIP_Z, 'gentle seat, behind the hips, not a deep shelf (was −0.34)');
  // TJ Nov 11 6:58 PM: a little slimmer, less barrel-chested; ribs stay wider than the waist.
  assert.ok(TORSO_CHEST_DEPTH <= 0.56 && TORSO_CHEST_DEPTH >= 0.44, 'chest depth is slimmer than the old 0.65 shW barrel, still human');
  assert.ok(TORSO_CHEST_W <= 0.102 && TORSO_CHEST_W >= 0.090, 'chest width is a little slimmer than the old 0.108');
  assert.ok(TORSO_CHEST_W > TORSO_WAIST_W * 1.25, 'ribs / chest stay clearly wider than the waist');
});

test('profile and three-quarter outlines: no chest thrust, no deep lumbar scoop, smooth hip-seat', () => {
  let worstThrust = 0, worstFront = 0, worstHollow = 0, worstBreak = 0, at = '';
  for (const [pi, pose] of POSES.entries()) {
    for (let d = 0; d <= 360; d += 15) {
      const yaw = d * DEG;
      const p = atYaw(pose, yaw);
      const {ops, S, h} = pathOf(p);
      const br = hipSeatBreak(ops, S, h);
      if (br > worstBreak) { worstBreak = br; at = `break pose ${pi} yaw ${d}`; }
      const profile = Math.abs(Math.sin(yaw)) >= 0.9; // ~65° and flatter
      const turned = Math.abs(Math.sin(yaw)) >= 0.7;  // ~45° and flatter
      if (!turned) continue;
      const shW = S.shW;
      const hipW = (p.b.hipW || 0.09) * h;
      const fwd = fwdSign(S, p);
      const chestThrust = fwd * (S.chest.midX - p.heart.x) / shW;
      const hollow = waistHollow(S, p);
      // Chest-vs-shoulder is only meaningful at rest in true profile:
      // dancing moves the shoulders (figure-eight, shrug) independently.
      const atRest = !!pose._rest;
      if (profile && atRest) {
        const front = chestFrontOverShoulder(S, p);
        if (front > worstFront) { worstFront = front; }
      }
      if (chestThrust > worstThrust) { worstThrust = chestThrust; }
      // The back-chord hollow is a profile measurement; at three-quarter the
      // mix of width and depth inflates it, so only score true profile.
      if (profile && hollow > worstHollow) { worstHollow = hollow; }
      assert.ok(chestThrust <= 0.12 + 1e-6, `chest mid ${chestThrust.toFixed(3)} shW at pose ${pi} yaw ${d}`);
      const seatBack = -fwd * (S.seat.midX - p.groin.x) / hipW;
      assert.ok(seatBack <= 0.18 + 1e-6, `seat ${seatBack.toFixed(3)} hipW at pose ${pi} yaw ${d}`);
    }
  }
  // Old hip-to-seat corner was 75–102°. A rounded glute is nearly C1.
  assert.ok(worstBreak <= 12, `hip-to-seat tangent break ${worstBreak.toFixed(1)} deg (${at})`);
  // Construction jut is ~0.4 % of height; allow a little for rest shoulder-back.
  assert.ok(worstFront <= 0.016, `rest profile chest sticks ${ (worstFront * 100).toFixed(2) } % of height past the shoulders`);
  assert.ok(worstHollow <= 0.025, `lumbar scoop ${ (worstHollow * 100).toFixed(2) } % of height`);
  assert.ok(worstThrust <= 0.12, `chest mid thrust ${worstThrust.toFixed(3)} shW`);
});

test('spine flex stays in a realistic range across moves, and still flexes', () => {
  resetSpineFlex();
  const strikes = [];
  for (let i = 0; i < 24; i++) strikes.push({t0: i * 0.45, side: i % 2 ? 1 : -1, energy: 0.6 + 0.4 * (i % 3) / 2});
  let maxSeg = 0, maxLat = 0, maxFlex = 0, maxExt = 0, maxEnvFlex = 0;
  const cases = [
    {activation: 1, squat: 0, tall: 0, amount: SPINE_FLEX},
    {activation: 1, squat: 0.7, tall: 0, amount: SPINE_FLEX},
    {activation: 1, squat: 0, tall: 1, amount: SPINE_FLEX},
    {activation: 0.4, squat: 0, tall: 0, amount: SPINE_FLEX},
    {activation: 1, squat: 0, tall: 0, amount: 1.5}
  ];
  for (const [ci, c] of cases.entries()) {
    resetSpineFlex(ci + 1);
    for (let t = 0; t <= 6; t += 1 / 60) {
      const sp = spineFlexState({
        id: ci + 1, tSec: t, strikes, amp: 32, hz: 1.1, hush: 1,
        periodSec: 0.5, ...c
      });
      const flexLim = SPINE_MAX_FLEX + SPINE_MAX_FLEX_SQUAT * (c.squat || 0) * (1 - (c.tall || 0));
      for (const k of ['pelvis', 'lumbar', 'thoracic', 'neck']) {
        maxSeg = Math.max(maxSeg, Math.abs(sp.angles[k]));
      }
      maxLat = Math.max(maxLat, Math.abs(sp.phi.pelvis), Math.abs(sp.phi.lumbar), Math.abs(sp.phi.thoracic));
      // Reconstruct the sagittal bow from the distributed pitches (pitchT = 0.85 * pitch).
      const pitch = (sp.phi.pitchT || 0) / 0.85;
      if (pitch > maxFlex) maxFlex = pitch;
      if (pitch < 0 && -pitch > maxExt) maxExt = -pitch;
      if (c.activation >= 0.9 && c.squat < 0.1) maxEnvFlex = Math.max(maxEnvFlex, Math.abs(pitch), Math.abs(sp.phi.thoracic));
      assert.ok(pitch <= flexLim + 1e-4, `flex ${ (pitch / DEG).toFixed(1) }° over ${ (flexLim / DEG).toFixed(1) }° at t=${t.toFixed(2)} case ${ci}`);
      assert.ok(-pitch <= SPINE_MAX_EXT + 1e-4, `extension ${ (-pitch / DEG).toFixed(1) }° over ${ (SPINE_MAX_EXT / DEG).toFixed(1) }° at t=${t.toFixed(2)} case ${ci}`);
    }
  }
  assert.ok(maxSeg <= SPINE_MAX_SEG_DEG * DEG + 1e-6, `per-station ${ (maxSeg / DEG).toFixed(1) }°`);
  assert.ok(maxLat <= SPINE_MAX_LATERAL + 1e-6, `lateral ${ (maxLat / DEG).toFixed(1) }°`);
  assert.ok(maxExt <= SPINE_MAX_EXT + 1e-6, `extension ${ (maxExt / DEG).toFixed(1) }° (cap ${ (SPINE_MAX_EXT / DEG).toFixed(1) }°)`);
  assert.ok(maxFlex <= SPINE_MAX_FLEX + SPINE_MAX_FLEX_SQUAT + 1e-6, `flex ${ (maxFlex / DEG).toFixed(1) }°`);
  assert.ok(maxEnvFlex > 6 * DEG, 'spine still flexes while dancing (' + (maxEnvFlex / DEG).toFixed(1) + ' deg)');
});
