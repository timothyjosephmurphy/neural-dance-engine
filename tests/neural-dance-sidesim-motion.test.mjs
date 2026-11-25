import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  skeletonPose, landGive, STOMP_SOFT, stanceWidthFor, buildFor, placePoseOnFloor,
  stompIntensity, STOMP_CALM, STOMP_PEAK, STOMP_REST_FRAC, SPINE_FLEX, SPINE_LAG, ARM_FLEX,
  LEG_COMPLEX, JIGGLE, HIP_EIGHT, SHOULDER_EIGHT, SAME_FOOT_THRESH,
  hipFigureEight, shoulderFigureEight, classifyBeats, sameFootThreshSec,
  spineFlexState, armWaveFlex, jiggleState, footworkState,
  EIGHT_DEPTH, EIGHT_VERT, restBlend, STANCE_HIP_REST
} from '../neural-dance/src/skeleton-dancer.js';
import {createPulseNetwork, dancerIntake, createDancerEnergy} from '../neural-dance/src/song-energy.js';
import {impulseFromDancer} from '../neural-dance/src/water-ripple.js';
import {cleanShowTuning, DEFAULT_SHOW_TUNING, paintLegEnergy} from '../neural-dance/src/silhouette.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';

const hush0 = {tSec: 2.4, stepHz: 2, phase: 0.37, hush: 0, still: false, amount: 1, activation: 1};

test('side-sim motion defaults match the requested slider values', () => {
  assert.equal(SPINE_FLEX, 0.85);  // music-driven human flex (TJ Nov 10 5:46 PM)
  assert.equal(SPINE_LAG, 4);
  assert.equal(ARM_FLEX, 0.8);
  assert.equal(LEG_COMPLEX, 0.7);
  assert.equal(JIGGLE, 0.65);
  assert.equal(HIP_EIGHT, 0.8);
  assert.equal(SHOULDER_EIGHT, 0.7);
  assert.equal(SAME_FOOT_THRESH, 0.6);
  assert.equal(DEFAULT_SHOW_TUNING.hipEight, 0.8);
  assert.equal(DEFAULT_SHOW_TUNING.shoulderEight, 0.7);
});

test('stomp intensity is per-dancer: light tap when calm, softer-stomp ceiling at peak', () => {
  assert.equal(STOMP_PEAK, STOMP_SOFT);
  assert.ok(STOMP_REST_FRAC >= 0.15 && STOMP_REST_FRAC <= 0.25, 'rest stomp is 15–25% of full');
  assert.ok(Math.abs(stompIntensity(0) / STOMP_PEAK - STOMP_REST_FRAC) < 1e-9);
  assert.ok(stompIntensity(0) < 0.25, 'calm is a light tap (' + stompIntensity(0) + ')');
  assert.ok(Math.abs(stompIntensity(0) - STOMP_CALM) < 1e-9);
  assert.ok(Math.abs(stompIntensity(1) - STOMP_SOFT) < 1e-9, 'peak is the softer-stomp ceiling');
  assert.ok(stompIntensity(0.2) < stompIntensity(0.8), 'harder as this dancer activates');
  assert.equal(stompIntensity(1, 0), 0, 'silence hushes the stomp');
  assert.ok(Math.abs(landGive(0) - STOMP_SOFT) < 1e-9, 'legacy landGive stays at the ceiling');
  assert.ok(landGive(0, false, 0) < 0.25, 'calm landGive is a light tap');
  assert.ok(Math.abs(landGive(0, false, 1) - STOMP_SOFT) < 1e-9);
  assert.equal(landGive(0, true, 1), 0, 'no jolt while airborne');
});

test('floor ripple splash follows each dancer’s own stomp, not a shared level', () => {
  assert.equal(impulseFromDancer({activity: 1}, 0), 0, 'activity trickle is gone');
  assert.equal(impulseFromDancer({activity: 0}, 1), 0, 'shared envelope is not a source');
  assert.equal(impulseFromDancer({activity: 0, activation: 1, stomp: 0.5}, 1), 0, 'a continuous stomp level is silent');
  const calm = impulseFromDancer({stompHit: STOMP_CALM}, 1);
  const peak = impulseFromDancer({stompHit: STOMP_PEAK}, 1);
  const mid = impulseFromDancer({stompHit: 0.4}, 1);
  assert.ok(calm < 0.25, 'calm ripple is a light tap (' + calm + ')');
  assert.ok(peak > mid && mid > calm, 'ripple grows with this stomp’s strength');
  assert.ok(peak <= STOMP_SOFT + 1e-9, 'never above the softer-stomp ceiling');
  const byStomp = impulseFromDancer({activity: 0, stompHit: 0.2}, 1);
  assert.ok(Math.abs(byStomp - 0.2) < 1e-9 || byStomp >= 0.2 * 0.99);
});

test('same-band dancers keep independent received energy (no copied state)', () => {
  const layout = [
    {id: 1, x: 220, y: 260, type: 0},
    {id: 2, x: 380, y: 280, type: 1},
    {id: 3, x: 540, y: 250, type: 2},
    {id: 4, x: 700, y: 300, type: 0}
  ];
  const net = createPulseNetwork({linkR: 200});
  net.setDancers(layout);
  net.hit(0, 0);
  // Own kick arm raises activity for both kick dancers, but is not copied as received.
  assert.ok(net.activity(1) >= 0.9 && net.activity(4) >= 0.9);
  assert.ok(net.received(1) < net.activity(1) * 0.85, 'received is not the dancer’s own arm');
  assert.ok(net.received(4) < net.activity(4) * 0.85);
  assert.ok(Math.abs(net.received(1) - net.received(4)) > 1e-6, 'different neighborhoods, different received after a kick');
  const rec1Kick = net.received(1);
  net.hit(1, 50); // bass next to dancer 1
  assert.ok(net.received(1) > rec1Kick, 'dancer 1 receives more once the bass neighbor arms');
  net.hit(2, 80); // mid next to dancer 4
  assert.ok(net.received(4) > 0, 'dancer 4 receives from the mid neighbor');
  assert.ok(Math.abs(net.received(1) - net.received(4)) > 1e-6, 'received energy stays per-dancer');
  const snap = net.snapshot();
  assert.ok(snap.every(d => Number.isFinite(+d.received)));
});

test('same-foot threshold is 0.60× step period: close hits stay on the same foot', () => {
  const T = 0.5;
  const thresh = sameFootThreshSec(T);
  assert.ok(Math.abs(thresh - 0.60 * T) < 1e-9);
  const evs = classifyBeats([
    {t0: 0, grid: 0, plannedTransfer: true, contact: 'heel'},
    {t0: 0.20, grid: 0, plannedTransfer: false, contact: 'toe', kind: 'toeTap'},
    {t0: 0.55, grid: 1, plannedTransfer: true, contact: 'heel'}
  ], thresh);
  assert.equal(evs[0].transfer, true);
  assert.equal(evs[1].transfer, false, '0.20s < 0.30s threshold is same-foot');
  assert.equal(evs[1].side, evs[0].side);
  assert.equal(evs[2].transfer, true);
  assert.equal(evs[2].side, -evs[0].side);
});

test('spine, arms, jiggle, hip/shoulder eights go still in silence', () => {
  const strikes = [{t0: 2.0, side: -1, energy: 1}];
  assert.equal(spineFlexState({tSec: 2.4, strikes, activation: 1, amp: 20, periodSec: 1, hush: 0}).env, 0);
  const af = armWaveFlex({tSec: 2.4, strikes, hush: 0, amount: 1});
  assert.equal(af.elL, 0);
  assert.equal(jiggleState({tSec: 2.4, strikes, hush: 0, amount: 1}).gluteL, 0);
  const hip = hipFigureEight(hush0);
  const sh = shoulderFigureEight(hush0);
  assert.equal(hip.x, 0);
  assert.equal(sh.x, 0);
  assert.equal(sh.tilt, 0);
  const unit = skeletonPose({id: 3, band: 1, now: 2400, periodMs: 500, strikes, activation: 1, hush: 0, still: false, armLift: 1});
  const rest = skeletonPose({id: 3, band: 1, activation: 1, armLift: 1});
  assert.ok(Math.abs(unit.shL.x - rest.shL.x) < 1e-9 && Math.abs(unit.hipL.x - rest.hipL.x) < 1e-9, 'hushed pose matches rest');
});

test('shoulder figure-eight is contra-body to the hips, bigger, and scales with activation', () => {
  const args = {tSec: 1.15, stepHz: 2, phase: 0.37, hush: 1, still: false};
  const hip = hipFigureEight({...args, amount: HIP_EIGHT});
  const sh = shoulderFigureEight({...args, amount: SHOULDER_EIGHT, activation: 1});
  assert.ok(Math.hypot(sh.x, sh.y) > Math.hypot(hip.x, hip.y), 'shoulder loop is fairly big relative to the hip loop');
  assert.ok(sh.x * hip.x <= 0, 'shoulders run against the hips (contra-body x)');
  assert.ok(Math.abs(sh.tilt) > 0.01, 'includes a visible shoulder roll/tilt');
  const calm = shoulderFigureEight({...args, activation: 0});
  const mid = shoulderFigureEight({...args, activation: 0.4});
  assert.equal(calm.x, 0);
  assert.ok(Math.hypot(mid.x, mid.y) < Math.hypot(sh.x, sh.y));
  const low = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 0.05, hush: 1, shoulderEight: 0.7, hipEight: 0.8});
  const high = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 1, hush: 1, shoulderEight: 0.7, hipEight: 0.8});
  // Same-activation, no-eight baselines: at rest the spine is upright and
  // shoulders sit over the hips, so a high-activation rest pose is the wrong
  // reference for a nearly-calm dancer.
  const low0 = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 0.05, hush: 1, shoulderEight: 0, hipEight: 0});
  const high0 = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 1, hush: 1, shoulderEight: 0, hipEight: 0});
  const shSpan = (u) => Math.hypot(u.shR.x - u.shL.x, u.shR.y - u.shL.y);
  // High activation moves the shoulder axis more than a nearly-calm dancer.
  const dHigh = Math.hypot(high.shL.x - high0.shL.x, high.shL.y - high0.shL.y);
  const dLow = Math.hypot(low.shL.x - low0.shL.x, low.shL.y - low0.shL.y);
  assert.ok(dHigh > dLow + 0.002, 'shoulder figure-8 grows with this dancer’s activation');
  assert.ok(Math.abs(shSpan(high) - shSpan(low)) < 0.08 || Math.abs(high.shR.y - high.shL.y) > Math.abs(low.shR.y - low.shL.y) - 1e-9);
});

test('heel-toe footwork pins the planted contact; free foot may lift', () => {
  const strikes = [{t0: 1.0, side: -1, energy: 1, beat: 2, transfer: true, contact: 'heel'}];
  const unit = skeletonPose({id: 7, band: 1, now: 1100, periodMs: 500, strikes, side: -1, ease: 0.05, activation: 0.6, hush: 1, weight: -1});
  assert.ok(unit.heelL && unit.footL);
  assert.ok(unit.contactL === 'heel' || unit.contactL === 'flat' || unit.contactL === 'toe');
  const posed = placePoseOnFloor(unit, {cx: 400, cy: 300, baseH: 200, height: 200, side: -1});
  // Planted contact sits on the floor (y == floorY).
  const key = posed.stance;
  assert.ok(Math.abs(posed[key].y - posed.floorY) < 1e-6, 'planted contact on the floor');
});

test('planted feet do not slide when stance width and figure-eights change', () => {
  const build = buildFor(8, 1);
  let pin = null;
  for (const act of [0.1, 0.5, 1]) {
    const unit = skeletonPose({id: 8, band: 1, now: 2000, periodMs: 500, activation: act, hush: 1, side: -1, weight: -1, ease: 0, hipEight: 0.8, shoulderEight: 0.7});
    const w = stanceWidthFor(act, build, 0);
    if (!pin) pin = {x: 400 + unit.footL.x * 180, y: null};
    const posed = placePoseOnFloor(unit, {cx: 400, cy: 300, baseH: 180, height: 180, side: -1, anchorX: pin.x});
    if (pin.y == null) pin.y = posed.footL.y;
    assert.ok(Math.abs(posed[posed.stance].x - pin.x) < 1e-6, 'stance foot x stays pinned at act ' + act);
  }
});

test('debug tuning accepts hip and shoulder figure-8 sliders', () => {
  const t = cleanShowTuning({hipEight: 1.1, shoulderEight: 0.4, eightDepth: 1.2, eightVert: 0.5});
  assert.equal(t.hipEight, 1.1);
  assert.equal(t.shoulderEight, 0.4);
  assert.equal(t.eightDepth, 1.2);
  assert.equal(t.eightVert, 0.5);
  assert.equal(cleanShowTuning({hipEight: 9}).hipEight, 1.5);
  assert.equal(cleanShowTuning({eightDepth: 9}).eightDepth, 1.5);
  const patch = sanitizeDebugPatch({hipEight: 0.55, shoulderEight: 0.9, eightDepth: 0.4, eightVert: 1.1});
  assert.equal(patch.hipEight, 0.55);
  assert.equal(patch.shoulderEight, 0.9);
  assert.equal(patch.eightDepth, 0.4);
  assert.equal(patch.eightVert, 1.1);
});

test('legacy skeletonPose (no now) keeps the previous rest geometry', () => {
  const a = skeletonPose({id: 3, band: 1, armLift: 0.5, activation: 0.5, weight: -1, ease: 0, side: -1});
  const b = skeletonPose({id: 3, band: 1, armLift: 0.5, activation: 0.5, weight: -1, ease: 0, side: -1});
  assert.equal(a.footL.y, 0.99);
  assert.equal(a.footR.y, 0.99);
  assert.equal(a.shL.x, b.shL.x);
  assert.equal(a.jiggle.gluteL, 0);
});

test('hip and shoulder figure-eights are 3D Lissajous paths (x, y, z) scaled by activation', () => {
  const args = {tSec: 1.15, stepHz: 2, phase: 0.37, hush: 1, still: false};
  const hip = hipFigureEight({...args, amount: 0.8, depth: 1, vert: 1, activation: 1});
  const sh = shoulderFigureEight({...args, amount: 0.7, depth: 1, vert: 1, activation: 1});
  assert.ok(Math.abs(hip.z) > 1e-4, 'hip eight has depth');
  assert.ok(Math.abs(hip.y) > 1e-5, 'hip eight has vertical');
  assert.ok(Math.abs(sh.z) > 1e-4, 'shoulder eight has depth');
  assert.ok(hip.x * sh.x <= 0, 'shoulders stay contra-body in x');
  const flat = hipFigureEight({...args, depth: 0, vert: 0, activation: 1});
  assert.ok(Math.abs(flat.z) < 1e-15, "depth slider at 0 removes z");
  assert.ok(Math.abs(flat.y) < 1e-15, "vert slider at 0 removes y");
  assert.ok(Math.abs(flat.x) > 1e-4, 'lateral amount is independent of depth/vert sliders');
  const deep = hipFigureEight({...args, depth: 1.5, vert: 0.2, activation: 1});
  const tall = hipFigureEight({...args, depth: 0.2, vert: 1.5, activation: 1});
  assert.ok(Math.abs(deep.z) > Math.abs(hip.z), 'depth slider scales z');
  assert.ok(Math.abs(tall.y) > Math.abs(hip.y), 'vert slider scales y');
  const calm = hipFigureEight({...args, activation: 0});
  assert.ok(Math.abs(calm.x) < 1e-15 && Math.abs(calm.z) < 1e-15, "zero activation stills the eight");
  const hush = hipFigureEight({...args, activation: 1, hush: 0});
  assert.ok(Math.abs(hush.z) < 1e-15, "hush stills the eight");
  const low = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 0.08, hush: 1, eightDepth: 1, eightVert: 1, hipEight: 0.8, shoulderEight: 0.7});
  const high = skeletonPose({id: 4, band: 0, now: 1150, periodMs: 500, activation: 1, hush: 1, eightDepth: 1, eightVert: 1, hipEight: 0.8, shoulderEight: 0.7});
  assert.ok(Math.abs((high.groin && high.groin.z) || 0) + Math.abs((high.hipL && high.hipL.z) || 0) >
            Math.abs((low.groin && low.groin.z) || 0) + Math.abs((low.hipL && low.hipL.z) || 0) - 1e-9,
            'live pose carries more figure-8 depth when activated');
});

test('resting stance is hip-width with straight knees and arms hanging', () => {
  assert.equal(STANCE_HIP_REST, 1);
  assert.ok(restBlend({activation: 0, hush: 1, still: false}) > 0.99);
  assert.ok(restBlend({activation: 1, hush: 1, still: false}) < 0.05);
  assert.equal(restBlend({activation: 1, hush: 0, still: false}), 1);
  const rest = skeletonPose({id: 6, band: 1, now: 2000, periodMs: 500, activation: 0, hush: 0, still: true, armLift: 1, weight: 0, side: -1, ease: 0, dynamics: false});
  const dance = skeletonPose({id: 6, band: 1, now: 2000, periodMs: 500, activation: 1, hush: 1, still: false, armLift: 1, weight: -1, side: -1, ease: 0.4, dynamics: false});
  const b = buildFor(6, 1);
  const restW = (rest.footR.x - rest.footL.x) / 2;
  assert.ok(Math.abs(restW / (b.hipW || rest.b.hipW) - 1) < 0.2, 'rest feet sit under the hips (w=' + restW.toFixed(3) + ')');
  assert.ok(restW < stanceWidthFor(1, b, 0, 0) - 0.005, 'rest is narrower than the dance floor');
  const kneeBend = (hip, knee, ank) => {
    const d = Math.hypot(ank.x - hip.x, ank.y - hip.y);
    const via = Math.hypot(knee.x - hip.x, knee.y - hip.y) + Math.hypot(ank.x - knee.x, ank.y - knee.y);
    return via - d;
  };
  assert.ok(kneeBend(rest.hipL, rest.kneeL, rest.ankleL) < 0.012, 'left knee is nearly straight at rest');
  assert.ok(kneeBend(rest.hipR, rest.kneeR, rest.ankleR) < 0.012, 'right knee is nearly straight at rest');
  assert.ok(rest.raise < 0.05, 'arms are not lifted at rest');
  assert.ok(rest.handL.y > rest.elL.y - 0.02 && rest.handR.y > rest.elR.y - 0.02, 'hands hang down by the sides');
  assert.ok(dance.handL.y < rest.handL.y - 0.02 || dance.raise > rest.raise + 0.2, 'dancing raises a hand or the arms');
});
