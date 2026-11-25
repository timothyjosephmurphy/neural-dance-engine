// Body physics (TJ 8:46 PM): critically damped / second-order joint tracking
// so pose targets can jump on a beat without the silhouette teleporting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  skeletonPose, stanceWidthFor, restStanceHalf, stanceInShoulderWidths, STANCE_SH_MIN, STANCE_SH_CALM,
  yawExtent, placePoseOnFloor, nextFloorAnchor, updateFloorAnchor, plantedSlipStats, buildFor
} from '../neural-dance/src/skeleton-dancer.js';
import {
  stepSpring, measureJerk, resetBodyDynamics, resetTravel, HIP_TWIST, SHOULDER_TWIST, HIP_YAW_LIM, SH_REL_LIM,
  MAX_BODY_TURN_DEG, TURN_FREQ
} from '../neural-dance/src/skeleton-motion.js';
import {TORSO_CHEST_DEPTH} from '../neural-dance/src/body-shell.js';

const FAMILIES = ['right-up', 'left-up', 'both-left', 'both-right', 'both-up', 'split'];

function replay({dynamics, dtMs = 1000 / 60, durationMs = 8000} = {}) {
  resetBodyDynamics();
  resetTravel();
  const period = 500;
  const strikes = [];
  for (let beat = 0; beat < 24; beat++) {
    strikes.push({t0: beat * (period / 1000), side: beat % 2 ? 1 : -1, energy: 0.85, beat, transfer: true});
  }
  const series = [];
  for (let t = 0; t <= durationMs + 1e-6; t += dtMs) {
    const beat = Math.floor(t / period);
    const ease = (t % period) / period;
    const side = beat % 2 ? 1 : -1;
    // Discrete jumps: activation steps, arm-family swaps, stance changes.
    const act = beat % 4 === 0 ? 0.12 : (beat % 4 === 3 ? 1 : 0.55);
    const family = FAMILIES[beat % FAMILIES.length];
    const unit = skeletonPose({
      id: 7, band: 1, weight: side < 0 ? -1 : 1, ease, side,
      armLift: act, activation: act, now: t, periodMs: period,
      strikes, hush: 1, still: false, beat, stepHz: 2,
      armFamily: family, dynamics, hipTwist: HIP_TWIST, shoulderTwist: SHOULDER_TWIST,
      maxBodyTurn: MAX_BODY_TURN_DEG, turnFreq: TURN_FREQ
    });
    series.push({
      t: t / 1000,
      pts: {
        handL: unit.handL, handR: unit.handR,
        shL: unit.shL, shR: unit.shR,
        hipL: unit.hipL, hipR: unit.hipR,
        groin: unit.groin, elL: unit.elL, elR: unit.elR,
        footL: unit.footL, footR: unit.footR
      }
    });
  }
  return measureJerk(series);
}

test('analytic spring is dt-correct and critically damped at zeta=1', () => {
  // Step response: from 0 toward 1, v=0, ω=8, ζ=1.
  let x = 0, v = 0;
  for (let i = 0; i < 40; i++) {
    const s = stepSpring(x, v, 1, 1 / 60, 8, 1);
    x = s.x; v = s.v;
  }
  assert.ok(x > 0.9 && x <= 1.02, 'settles near the target (x=' + x.toFixed(3) + ')');
  assert.ok(Math.abs(v) < 0.3, 'velocity has nearly died');
  // 8× (1/60) ≈ 4× (2/60). (dt is clamped at 50 ms, so coarser than that is not comparable.)
  let a = {x: 0, v: 0}, b = {x: 0, v: 0};
  for (let i = 0; i < 8; i++) a = stepSpring(a.x, a.v, 1, 1 / 60, 10, 0.85);
  for (let i = 0; i < 4; i++) b = stepSpring(b.x, b.v, 1, 2 / 60, 10, 0.85);
  assert.ok(Math.abs(a.x - b.x) < 0.02, 'dt-correct: ' + a.x.toFixed(4) + ' vs ' + b.x.toFixed(4));
  // Underdamped overshoots, then settles.
  let u = {x: 0, v: 0};
  let maxX = 0;
  for (let i = 0; i < 80; i++) {
    u = stepSpring(u.x, u.v, 1, 1 / 60, 12, 0.65);
    if (u.x > maxX) maxX = u.x;
  }
  assert.ok(maxX > 1.02, 'underdamped follow-through overshoots (max=' + maxX.toFixed(3) + ')');
  assert.ok(Math.abs(u.x - 1) < 0.05, 'then settles (x=' + u.x.toFixed(3) + ')');
});

test('projected volume keeps chest and head depth at a 90° profile', () => {
  const shW = 0.125;
  const chest = yawExtent(shW, TORSO_CHEST_DEPTH * shW, Math.PI / 2);
  const face = yawExtent(shW, TORSO_CHEST_DEPTH * shW, 0);
  assert.ok(Math.abs(face - shW) < 1e-9, 'front-on uses shoulder width');
  assert.ok(Math.abs(chest / shW - TORSO_CHEST_DEPTH) < 1e-9, 'profile chest follows TORSO_CHEST_DEPTH, got ' + (chest / shW).toFixed(3));
  const head = yawExtent(0.86, 0.95, Math.PI / 2);
  assert.ok(Math.abs(head - 0.95) < 1e-9);
  assert.ok(yawExtent(1, 0.55, Math.PI / 2) > 0.5, 'limbs do not collapse to a line');
});

test('narrowest DANCE stance is 0.85–1.0 shoulder widths; rest is hip-width, never feet together', () => {
  const b = buildFor(3, 1);
  const danceCalm = stanceWidthFor(0, b, 0, 0);
  const tall = stanceWidthFor(1, b, 1, 0);
  const hot = stanceWidthFor(1, b, 0, 0);
  const rest = stanceWidthFor(0, b, 0, 1);
  assert.ok(Math.abs(stanceInShoulderWidths(danceCalm, b) - STANCE_SH_CALM) < 0.02);
  assert.ok(Math.abs(stanceInShoulderWidths(tall, b) - STANCE_SH_MIN) < 0.02);
  assert.ok(stanceInShoulderWidths(danceCalm, b) >= STANCE_SH_MIN - 1e-6);
  assert.ok(hot > danceCalm, 'activated dance stance is wider than dance-calm');
  assert.ok(rest < danceCalm, 'rest stance is narrower than the dance floor');
  // TJ 10:30 AM: rest feet sit just under hip width (foot centres at 0.85 of the outer hip width).
  assert.ok(Math.abs(rest - restStanceHalf(b)) < 1e-9, 'rest uses the just-under-hip-width rest stance');
  const pose = skeletonPose({id: 3, band: 1, activation: 0, tall: 1, weight: 0, side: -1, still: true, hush: 0});
  const span = pose.footR.x - pose.footL.x;
  assert.ok(span > 0.7 * 2 * pose.b.hipW, 'rest/tall is not feet-together (span=' + span.toFixed(3) + ')');
});

test('planted foot stays pinned while springs settle the body', () => {
  resetBodyDynamics();
  resetTravel();
  let pin = null;
  for (let t = 0; t <= 2000; t += 1000 / 60) {
    const beat = Math.floor(t / 500);
    const unit = skeletonPose({
      id: 11, band: 1, now: t, periodMs: 500, activation: 0.8, hush: 1,
      side: -1, weight: -1, ease: (t % 500) / 500, beat, dynamics: true
    });
    const key = unit.contactL === 'heel' ? 'heelL' : 'footL';
    const toe = unit[key] || unit.footL;
    const posed = placePoseOnFloor(unit, {cx: 400, cy: 300, baseH: 90, height: 90, side: -1, anchorX: pin ? pin.x : (400 + toe.x * 90)});
    const planted = posed[posed.stance] || posed.footL;
    if (!pin) pin = {x: planted.x, y: planted.y};
    if (unit.liftL < 0.001) {
      assert.ok(Math.abs(planted.x - pin.x) < 1e-6, 'planted foot x slipped at t=' + t);
    }
  }
});

test('joint jerk and acceleration drop once springs are on (before vs after)', () => {
  const before = replay({dynamics: false});
  const after = replay({dynamics: true});
  const ratioJ = after.maxJerk / Math.max(1e-9, before.maxJerk);
  const ratioA = after.maxAcc / Math.max(1e-9, before.maxAcc);
  const report = {
    before: {maxVel: +before.maxVel.toFixed(3), maxAcc: +before.maxAcc.toFixed(2), maxJerk: +before.maxJerk.toFixed(1), n: before.n},
    after: {maxVel: +after.maxVel.toFixed(3), maxAcc: +after.maxAcc.toFixed(2), maxJerk: +after.maxJerk.toFixed(1), n: after.n},
    jerkRatio: +ratioJ.toFixed(3),
    accRatio: +ratioA.toFixed(3)
  };
  console.log('body-physics jerk before/after', JSON.stringify(report));
  assert.ok(before.maxJerk > after.maxJerk, 'smoothed max jerk should be lower (' + before.maxJerk.toFixed(1) + ' → ' + after.maxJerk.toFixed(1) + ')');
  assert.ok(before.maxAcc > after.maxAcc, 'smoothed max acceleration should be lower (' + before.maxAcc.toFixed(2) + ' → ' + after.maxAcc.toFixed(2) + ')');
  assert.ok(ratioJ < 0.45, 'jerk should fall by more than half (ratio ' + ratioJ.toFixed(3) + ')');
  assert.ok(ratioA < 0.55, 'acceleration should fall clearly (ratio ' + ratioA.toFixed(3) + ')');
});

test('body turns and hip/shoulder twist stay within limits and decay in silence', () => {
  resetBodyDynamics();
  resetTravel();
  const strikes = [];
  for (let t0 = 0; t0 <= 6000; t0 += 400) strikes.push({t0: t0 / 1000, side: (Math.floor(t0 / 400) % 2 ? 1 : -1), energy: 1, kind: 'transfer', contact: 'heel'});
  let maxFace = 0, maxHip = 0, maxShRel = 0;
  for (let t = 0; t <= 6000; t += 1000 / 60) {
    const beat = Math.floor(t / 400);
    const unit = skeletonPose({
      id: 5, band: 2, now: t, periodMs: 400, activation: 1, hush: 1,
      side: beat % 2 ? 1 : -1, weight: beat % 2 ? 1 : -1, ease: (t % 400) / 400,
      beat, stepHz: 2.5, maxBodyTurn: 90, turnFreq: 1.2, hipTwist: 0.8, shoulderTwist: 0.75,
      strikes, pulseAmp: 20, pulseHz: 1.05
    });
    const tw = unit.twist || {};
    maxFace = Math.max(maxFace, Math.abs(tw.facing || 0));
    maxHip = Math.max(maxHip, Math.abs(tw.hipYaw || 0));
    maxShRel = Math.max(maxShRel, Math.abs(tw.shRel || 0));
  }
  const deg = r => r * 180 / Math.PI;
  console.log('body-physics turn/twist max', {facing: +deg(maxFace).toFixed(1), hip: +deg(maxHip).toFixed(1), shRel: +deg(maxShRel).toFixed(1)});
  assert.ok(maxFace <= Math.PI / 2 + 1e-3, 'facing stays within ±90° (' + deg(maxFace).toFixed(1) + ')');
  assert.ok(maxHip <= HIP_YAW_LIM + 1e-3, 'hip twist stays within ±' + (HIP_YAW_LIM * 180 / Math.PI).toFixed(0) + '°');
  assert.ok(maxHip >= 12 * Math.PI / 180, 'hips actually twist (' + deg(maxHip).toFixed(1) + ' deg)');
  assert.ok(maxShRel <= 42 * Math.PI / 180 + 1e-3, 'shoulder twist stays within ±42° relative');
  assert.ok(maxShRel >= 28 * Math.PI / 180, 'contra-body twist reaches a human range (' + deg(maxShRel).toFixed(1) + ' deg)');
  // Silence: facing and twist decay toward zero.
  let last = null;
  for (let t = 6000; t <= 9000; t += 1000 / 60) {
    last = skeletonPose({
      id: 5, band: 2, now: t, periodMs: 400, activation: 0, hush: 0,
      side: -1, weight: 0, ease: 0, beat: 0, still: true, maxBodyTurn: 90, turnFreq: 1.2
    });
  }
  const rest = last.twist;
  assert.ok(Math.abs(rest.facing) < 0.08, 'facing drifts home in silence (' + rest.facing.toFixed(3) + ')');
  assert.ok(Math.abs(rest.hipYaw) < 0.05, 'hip twist rests in silence');
});

test('main live dancers request full volume even under the 100 px LOD cutoff', () => {
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  const painter = readFileSync(new URL('../neural-dance/src/skeleton-dancer.js', import.meta.url), 'utf8');
  assert.match(src, /marker\.kind === 'sim'/);
  assert.match(src, /lod: \(marker\.kind === 'sim' && /);
  assert.match(src, /'full'\)/);
  assert.match(painter, /chestHalfD = TORSO_CHEST_DEPTH \* shHalf|TORSO_CHEST_DEPTH \* shHalf/);
});

function plantedSlipStatsPaired(samples) {
  let n = 0, sum = 0, max = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!a.planted || !b.planted || a.side !== b.side) continue;
    const d = Math.hypot(b.x - b.px, (b.z || 0) - (b.pz || 0));
    n++; sum += d; if (d > max) max = d;
  }
  return {frames: n, maxPx: max, meanPx: n ? sum / n : 0};
}
function contactWorld(posed, side) {
  if (side < 0) return (posed.contactL === 'heel' && posed.heelL) ? posed.heelL : posed.footL;
  return (posed.contactR === 'heel' && posed.heelR) ? posed.heelR : posed.footR;
}

function replayTraction({mode, dtMs = 1000 / 30, durationMs = 8000} = {}) {
  resetBodyDynamics();
  resetTravel();
  const period = 450;
  const cx = 400, cy = 300, baseH = 90, height = 90;
  const strikes = [];
  for (let beat = 0; beat < 32; beat++) {
    strikes.push({t0: beat * (period / 1000), side: beat % 2 ? 1 : -1, energy: 0.9, beat, transfer: true});
  }
  let pin = null;
  const samples = [];
  for (let t = 0; t <= durationMs + 1e-6; t += dtMs) {
    const beat = Math.floor(t / period);
    const ease = (t % period) / period;
    const side = beat % 2 ? 1 : -1;
    const silent = t >= 6000;
    const unit = skeletonPose({
      id: 21, band: 1, weight: side, ease, side,
      activation: silent ? 0 : 0.95, now: t, periodMs: period,
      strikes, hush: silent ? 0 : 1, still: silent, beat, stepHz: 1000 / period,
      hipTwist: HIP_TWIST, shoulderTwist: SHOULDER_TWIST,
      maxBodyTurn: MAX_BODY_TURN_DEG, turnFreq: 1.1,
      eightDepth: 0.85, eightVert: 0.8,
      dynamics: true
    });
    const toe = contactWorld(unit, side);
    let posed;
    if (mode === 'naive') {
      // Pre-traction: recompute the plant from the sticker every frame and
      // scale z from the unit toe (a landing at stepZ then snaps back to 0).
      posed = {
        footL: {x: cx + unit.footL.x * height, z: (unit.footL.z || 0) * height},
        footR: {x: cx + unit.footR.x * height, z: (unit.footR.z || 0) * height},
        heelL: unit.heelL ? {x: cx + unit.heelL.x * height, z: (unit.heelL.z || 0) * height} : null,
        heelR: unit.heelR ? {x: cx + unit.heelR.x * height, z: (unit.heelR.z || 0) * height} : null,
        contactL: unit.contactL, contactR: unit.contactR
      };
    } else {
      pin = nextFloorAnchor(pin, {side, unit, cx, baseH});
      posed = placePoseOnFloor(unit, {cx, cy, baseH, height, side, anchorX: pin.x, anchorZ: pin.z});
      updateFloorAnchor(pin, posed, side);
    }
    const plant = contactWorld(posed, side);
    const liftPlant = side < 0 ? unit.liftL : unit.liftR;
    // A heel-toe roll changes WHICH point is the contact; slip is the travel
    // of the current contact point itself since the last frame (TJ 10:31 AM:
    // no popping, so the roll pivots instead of teleporting the foot).
    const s2 = side < 0 ? 'L' : 'R', isHeel = plant === posed['heel' + s2];
    const prevS = samples[samples.length - 1];
    const same = prevS && prevS.side === side && prevS.pts;
    const prevPt = same ? (isHeel ? prevS.pts.heel : prevS.pts.toe) : null;
    samples.push({
      t: t / 1000, side, planted: liftPlant < 0.001,
      x: plant.x, z: plant.z || 0, px: prevPt ? prevPt.x : plant.x, pz: prevPt ? prevPt.z : (plant.z || 0),
      pts: {toe: {x: posed['foot' + s2].x, z: posed['foot' + s2].z || 0}, heel: posed['heel' + s2] ? {x: posed['heel' + s2].x, z: posed['heel' + s2].z || 0} : {x: posed['foot' + s2].x, z: posed['foot' + s2].z || 0}},
      liftL: unit.liftL, liftR: unit.liftR
    });
  }
  if (mode !== 'naive') {
    // Re-express each frame against its own contact point's previous spot.
    return plantedSlipStatsPaired(samples);
  }
  return plantedSlipStats(samples);
}

test('planted foot has roughly zero floor slip with traction (before vs after)', () => {
  const before = replayTraction({mode: 'naive'});
  const after = replayTraction({mode: 'traction'});
  const report = {
    before: {maxPx: +before.maxPx.toFixed(3), meanPx: +before.meanPx.toFixed(3), frames: before.frames},
    after: {maxPx: +after.maxPx.toFixed(3), meanPx: +after.meanPx.toFixed(3), frames: after.frames}
  };
  console.log('planted-foot slip before/after', JSON.stringify(report));
  assert.ok(before.frames > 50 && after.frames > 50, 'enough planted frames to measure');
  assert.ok(before.maxPx > 0.25, 'naive placement should show visible slip (got ' + before.maxPx.toFixed(3) + ' px/frame)');
  assert.ok(after.maxPx < 0.05, 'traction max slip should be ~0 px/frame (got ' + after.maxPx.toFixed(3) + ')');
  assert.ok(after.meanPx < 0.02, 'traction mean slip should be ~0 px/frame (got ' + after.meanPx.toFixed(3) + ')');
  assert.ok(after.maxPx < before.maxPx * 0.1, 'traction should cut slip by more than 10x');
});

test('live floor anchors use sticky world x/z and only move on a transfer or swing', () => {
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(src, /nextFloorAnchor/);
  assert.match(src, /updateFloorAnchor/);
  assert.match(src, /anchorZ: pin\.z/);
  assert.match(src, /wantCollect/);
  assert.doesNotMatch(src, /if \(!moving \|\| hush < 0\.15 \|\| !pin/);
});
