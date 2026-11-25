import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  MOVE_IDS, MOVE_LABELS, HOME_RADIUS, MAX_TURN, TURN_SIZE, PREVIEW_DURATION,
  layerWeights, dominantLabel, phraseState, kinematics,
  stompScale, homeLeash, previewDrivers, mergeDrivers,
} from '../neural-dance/src/rave-moves.js';

const hush0 = {activation: 1, hush: 0, kick: 1, hats: 1, pads: 1, melody: 1, drop: 1};

test('starter set has the eight researched moves', () => {
  assert.deepEqual(MOVE_IDS, [
    'bounceNod', 'hipSway', 'twoStep', 'jacking', 'bodyWave',
    'tStep', 'runningMan', 'kickStomp',
  ]);
  for (const id of MOVE_IDS) assert.ok(MOVE_LABELS[id]);
  assert.equal(PREVIEW_DURATION, 18);
});

test('hush silences every layer', () => {
  const w = layerWeights(hush0);
  for (const id of MOVE_IDS) assert.equal(w[id], 0, id);
});

test('layers 1–3 are the rest-to-low base; 4–8 stay off at rest', () => {
  const rest = layerWeights({activation: 0.05, hush: 1, kick: 0.4, hats: 0, pads: 0, drop: 0});
  assert.ok(rest.bounceNod > 0.25 && rest.bounceNod < 0.45, 'idle bounce is present but soft');
  assert.ok(rest.hipSway > 0.15 && rest.hipSway < 0.35, 'idle hip sway is present but soft');
  assert.ok(rest.twoStep < 0.05, 'no two-step at rest');
  assert.ok(rest.jacking < 0.05 && rest.bodyWave < 0.05, 'no pad layers without pads');
  assert.ok(rest.tStep < 0.05 && rest.runningMan < 0.05, 'no shuffle at rest');
  assert.ok(rest.kickStomp < 0.02, 'no kick/stomp at rest');
});

test('pads fade in jacking and body wave; kick+hats bring T-step and running man; drops bring kicks', () => {
  const midPads = layerWeights({activation: 0.5, hush: 1, pads: 0.8, melody: 0.6, kick: 0.4, hats: 0.2, drop: 0});
  assert.ok(midPads.jacking > 0.25, 'jacking fades in with pads');
  assert.ok(midPads.bodyWave > 0.2, 'body wave fades in with pads');
  assert.ok(midPads.twoStep > 0.7, 'two-step is available as the base');
  assert.ok(midPads.runningMan < midPads.twoStep, 'running man is not the mid-pad default');

  const hatsUp = layerWeights({activation: 0.7, hush: 1, kick: 0.9, hats: 0.85, pads: 0.3, drop: 0.1});
  assert.ok(hatsUp.tStep > 0.4, 'T-step comes in when kick and hats are strong');
  assert.ok(hatsUp.runningMan > 0.35, 'running man comes in when kick and hats are strong');

  const drop = layerWeights({activation: 0.95, hush: 1, kick: 1, hats: 0.8, pads: 0.4, drop: 1});
  assert.ok(drop.kickStomp > 0.7, 'kicks and stomps at high activation / drops');
  assert.ok(drop.kickStomp > hatsUp.kickStomp);
});

test('90° turns are punctuation: never at rest, only at the start of an 8-count, at most once per phrase', () => {
  const bpm = 124;
  const hz = bpm / 60;
  let turns = 0;
  let lastPhrase = -1;
  const facings = [];
  let facing = 0;
  for (let beat = 0; beat < 64; beat++) {
    const tSec = beat / hz;
    const plan = phraseState({
      tSec, bpm, seed: 4.2, activation: 0.9,
      layers: layerWeights({activation: 0.9, hush: 1, kick: 1, hats: 0.8, drop: 1}),
      facing, beatIndex: beat,
    });
    if (Math.abs(plan.turnRad) > 0.2) {
      turns++;
      assert.equal(plan.count, 0, 'turns only on the 1 of an 8-count');
      assert.notEqual(plan.phrase, lastPhrase, 'at most one turn per phrase');
      lastPhrase = plan.phrase;
      const mag = Math.abs(plan.turnRad);
      assert.ok(Math.abs(mag - TURN_SIZE) < 1e-6, 'quarter-turn size, got ' + mag);
      facing = Math.max(-MAX_TURN, Math.min(MAX_TURN, facing + plan.turnRad));
      facings.push(facing);
    } else {
      assert.equal(plan.turnRad, 0);
    }
  }
  assert.ok(turns >= 1 && turns <= 8, 'some punctuation, not a spin cycle (' + turns + ' turns in 64 beats)');
  for (const f of facings) assert.ok(Math.abs(f) <= MAX_TURN + 1e-9);

  for (let beat = 0; beat < 16; beat++) {
    const plan = phraseState({
      tSec: beat / hz, bpm, seed: 4.2, activation: 0.08,
      layers: layerWeights({activation: 0.08, hush: 1, kick: 0.4}),
      facing: 0, beatIndex: beat,
    });
    assert.equal(plan.turnRad, 0, 'no turns at rest');
    assert.equal(plan.stepF, 0);
    assert.equal(plan.stepS, 0);
    assert.equal(plan.locomotor, 'idle');
  }
});

test('standard steps: side-to-side and forward/back appear at mid energy, timed to the beat', () => {
  const bpm = 124;
  const hz = bpm / 60;
  const layers = layerWeights({activation: 0.4, hush: 1, kick: 0.8, hats: 0.15, pads: 0.05});
  const locos = new Set();
  let side = 0, fwd = 0;
  for (let beat = 0; beat < 32; beat++) {
    const plan = phraseState({
      tSec: beat / hz, bpm, seed: 1.7, activation: 0.4, layers, facing: 0, beatIndex: beat,
    });
    locos.add(plan.locomotor);
    if (plan.locomotor === 'twoStep' && Math.abs(plan.stepS) > 0.01) side++;
    if (plan.locomotor === 'fwdBack' && Math.abs(plan.stepF) > 0.01) fwd++;
  }
  assert.ok(locos.has('twoStep') || locos.has('fwdBack'), 'mid energy travels, locos=' + [...locos]);
  assert.ok(side + fwd > 4, 'several traveling steps in 32 beats');
});

test('stomp and kick height scale with activation; rest is a light tap', () => {
  assert.ok(Math.abs(stompScale(0) - 0.20) < 1e-9);
  assert.ok(stompScale(1) > 0.95);
  assert.ok(stompScale(0.2) < stompScale(0.8));
  assert.equal(stompScale(1, 0), 0);

  const rest = kinematics({tSec: 0, bpm: 124, activation: 0.05, beatPhase: 0, layers: layerWeights({activation: 0.05, hush: 1}), locomotor: 'idle', planted: -1});
  const peak = kinematics({tSec: 0, bpm: 124, activation: 0.95, beatPhase: 0, layers: layerWeights({activation: 0.95, hush: 1, drop: 1, kick: 1, hats: 0.8}), locomotor: 'runningMan', planted: -1});
  assert.ok(rest.bounce > 0 && rest.bounce < peak.bounce, 'idle bounce is smaller than a high-energy bounce');
  assert.ok(Math.abs(rest.nod) <= Math.abs(peak.nod) + 1e-12);
  assert.ok(rest.kickLift < 0.005, 'no real kick at rest');
  assert.ok(peak.stomp > rest.stomp);
});

test('planted-foot kinematics never lift the supporting foot; home leash keeps mid-feet close', () => {
  const layers = layerWeights({activation: 0.8, hush: 1, kick: 1, hats: 0.9, drop: 0.5});
  const kin = kinematics({
    tSec: 0.0, bpm: 124, activation: 0.8, layers, locomotor: 'runningMan',
    planted: -1, weight: -1, beatPhase: 0,
  });
  assert.equal(kin.footL.lift, 0, 'left is planted — no lift (no slide)');
  const far = homeLeash(0.3, 0.2);
  assert.equal(far.pulled, true);
  assert.ok(Math.hypot(far.x, far.z) <= HOME_RADIUS + 1e-9);
  const near = homeLeash(0.02, -0.01);
  assert.equal(near.pulled, false);

  // A long run of traveling steps must keep each individual plant inside the radius
  // after the leash is applied; phraseState itself also biases inward when off home.
  let x = 0, z = 0;
  const bpm = 124, hz = bpm / 60;
  for (let beat = 0; beat < 48; beat++) {
    const plan = phraseState({
      tSec: beat / hz, bpm, seed: 8.9, activation: 0.75,
      layers: layerWeights({activation: 0.75, hush: 1, kick: 0.9, hats: 0.85}),
      facing: 0, homeX: x, homeZ: z, beatIndex: beat,
    });
    x += plan.stepS;
    z += plan.stepF;
    const leashed = homeLeash(x, z);
    x = leashed.x; z = leashed.z;
  }
  assert.ok(Math.hypot(x, z) <= HOME_RADIUS + 1e-9, 'stays near home after 48 beats');
});

test('preview ramp goes rest → high over 18s and names the move', () => {
  const a0 = previewDrivers(0.5);
  const a1 = previewDrivers(4.5);
  const a2 = previewDrivers(7.5);
  const a3 = previewDrivers(11);
  const a4 = previewDrivers(16);
  assert.ok(a0.activation < 0.15 && a0.pads < 0.1);
  assert.match(a0.label, /Bounce/i);
  assert.ok(a1.activation > a0.activation && a1.activation < 0.45);
  assert.ok(a2.pads > 0.5, 'pads are in by the jacking section');
  assert.ok(a3.hats > 0.6 && a3.kick > 0.7);
  assert.ok(a4.activation > 0.85 && a4.drop > 0.7);
  assert.match(a4.label, /Kick|stomp|turn/i);
  const merged = mergeDrivers(a0, {activation: 1});
  assert.equal(merged.activation, 1);
  assert.equal(merged.kick, a0.kick);
});

test('side-sim page loads the repertoire and keeps pad-arms on top', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(join(root, 'static/neural-dance/sim/index.html'), 'utf8');
  assert.match(html, /rave-moves\.js/);
  assert.match(html, /id="raveMoves"/);
  assert.match(html, /function ravePlan/);
  assert.match(html, /setPreviewRamp/);
  assert.match(html, /homeLeash/);
  // #93 pad / melody arms still applied on top of the new locomotion.
  assert.match(html, /sharedPadArms\.padArmState/);
  assert.match(html, /applyPadArmAngles/);
  // Bundle D (one pose): the sim drives the shared live skeletonPose by default; ?pose=local keeps the old solver.
  assert.match(html, /api\.skeletonPose\(/, 'bundle D: sim uses the shared live skeletonPose');
  assert.match(html, /skeleton-dancer\.js/);
  assert.match(html, /get\('pose'\) === 'local'/);
  assert.match(html, /id="footworkPanel"/);
  assert.match(html, /nd-sim-footwork/);
  assert.match(html, /function fwFromSearch/);
  assert.match(html, /setFootworkAllow/);
  assert.match(html, /data-fw-step="kickBallChange"|id="fwFill"/);
  const live = readFileSync(join(root, 'neural-dance/room-lab.js'), 'utf8');
  const show = readFileSync(join(root, 'neural-dance/src/silhouette.js'), 'utf8');
  assert.doesNotMatch(live + show, /setFootworkAllow|setFootworkTier|setFootworkOverride|setFootworkFills/);
});
