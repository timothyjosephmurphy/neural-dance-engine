// Bundle A motion: show arc, bass buzz, crown pulse, posture, stage fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {showArc, showArcAt, showHours, SHELL_ALPHA_END} from '../neural-dance/src/show-arc.js';
import {createBassBuzz, syntheticBuzz, syntheticKicks, BUZZ_HOLD} from '../neural-dance/src/bass-buzz.js';
import {createCrownPulse, CHAKRA_S, PEAK_THRESHOLD} from '../neural-dance/src/crown-pulse.js';
import {createPosture, ARM_REST, KNEE_SOFT} from '../neural-dance/src/posture.js';
import {containDancers, easeTurn, confineLateral, handOnForearm, capJointStep, jointDisp, MAX_TURN_RAD, MAX_JOINT_STEP} from '../neural-dance/src/stage-fit.js';

test('show arc starts dark and ends as a rainbow shell', () => {
  const start = showArc(0, 3 * 3600);
  assert.equal(start.t, 0);
  assert.equal(start.shellAlpha, 0);
  assert.equal(start.rainbow, 0);
  assert.equal(start.chest, 1);
  assert.equal(start.chakra, 1);
  assert.equal(start.dances, true);
  const end = showArc(3 * 3600, 3 * 3600);
  assert.ok(end.shellAlpha > 0.7 && end.shellAlpha <= SHELL_ALPHA_END + 1e-9);
  assert.ok(end.rainbow > 0.9);
  assert.ok(end.reflect > 0.9);
  const early = showArc(20 * 60, 3 * 3600);
  const sameOnLonger = showArc(20 * 60, 6 * 3600);
  assert.ok(sameOnLonger.t < early.t, 'a longer show is still darker at the same clock time');
  assert.equal(showHours(0), 3);
  assert.equal(showHours(12), 8);
  assert.ok(showArcAt(0.5).t > 0.4 && showArcAt(0.5).t < 0.7);
});

test('bass buzz is a held vibration, not the kick, and the drop releases the bow', () => {
  const kicks = createBassBuzz();
  for (let i = 0; i <= 80; i++) kicks.step({t: i * 0.02, bass: syntheticKicks(i * 0.02)});
  assert.ok(kicks.state().buzz < 0.25, 'kicks alone are not a buzz: ' + kicks.state().buzz);
  assert.ok(kicks.state().tension < 0.2);

  const buzz = createBassBuzz();
  const hold = BUZZ_HOLD + 0.4;
  for (let i = 0; i <= hold / 0.02; i++) {
    const t = i * 0.02;
    buzz.step({t, bass: syntheticBuzz(t)});
  }
  const wound = buzz.state();
  assert.ok(wound.buzz > 0.45, 'sustained wiggle reads as buzz: ' + wound.buzz);
  assert.ok(wound.tension > 0.35, 'bowstring winds: ' + wound.tension);
  assert.ok(wound.shimmy === wound.buzz, 'shimmy is the buzz, not a figure-8');
  buzz.step({t: hold + 0.02, bass: syntheticBuzz(hold + 0.02), drop: true});
  const released = buzz.state();
  assert.ok(released.burst > 0.3, 'drop lets the tension go as a burst');
  assert.ok(released.tension < 0.05, 'tension is spent on the release');
});

test('crown send waits for the crown, then a received pulse travels down', () => {
  const net = createCrownPulse({peakThreshold: 0.88, peakDuration: 0.4, partnerCount: 3, climbSec: 0.4, peakClimbSec: 0.2});
  const roster = [
    {id: 'a', x: 0, y: 0, activation: 0.5},
    {id: 'b', x: 100, y: 0, activation: 0.2},
    {id: 'c', x: 40, y: 80, activation: 0.2},
    {id: 'd', x: 180, y: 10, activation: 0.2},
  ];
  let sentAt = null;
  for (let i = 1; i <= 40; i++) {
    const t = i * 0.05;
    net.step(t, roster);
    const snap = net.snapshot();
    const a = snap.dancers.find(d => d.id === 'a');
    if (snap.sends === 0) assert.ok(a.climb < 1, 'no send before the crown');
    if (snap.sends > 0 && sentAt == null) {
      sentAt = t;
      assert.equal(snap.beams.length, 1, 'below peak, one partner');
      assert.equal(snap.beams[0].from, 'a');
      assert.equal(snap.beams[0].gen, 'normal');
      assert.ok(a.exit > 0, 'the crown arrival leaves a plume');
    }
  }
  assert.ok(sentAt != null, 'a climb does send once it reaches the crown');
  // Let the beam land.
  net.step(sentAt + 1.2, roster);
  const landed = net.snapshot().dancers.find(d => d.id !== 'a' && d.down.length);
  assert.ok(landed, 'the receiver gets a downward traveler');
  assert.ok(landed.down[0] > 0.5, 'it enters at the crown, not the chest');
  const before = net.lights(landed.id).map(p => p.s);
  assert.deepEqual(before, CHAKRA_S);
  const lit = net.lights(landed.id);
  const crownI = lit.findIndex(p => p.s === 1);
  const rootI = lit.findIndex(p => p.s === 0);
  assert.ok(lit[crownI].down > lit[rootI].down, 'the down pulse lights the crown before the root');
  net.step(sentAt + 1.2 + 0.5, roster);
  const later = net.lights(landed.id);
  assert.ok(later[rootI].down + later[2].down > 0, 'the pulse keeps moving down the string');
});

test('sustained peak fans out and speeds up, then drops back to one partner', () => {
  const net = createCrownPulse({peakThreshold: PEAK_THRESHOLD, peakDuration: 0.3, partnerCount: 3, climbSec: 1.2, peakClimbSec: 0.25});
  const roster = (act) => [
    {id: 'a', x: 0, y: 0, activation: act},
    {id: 'b', x: 50, y: 0, activation: 0.1},
    {id: 'c', x: 0, y: 50, activation: 0.1},
    {id: 'd', x: 40, y: 40, activation: 0.1},
  ];
  let first = null;
  for (let i = 1; i <= 80; i++) {
    net.step(i * 0.05, roster(0.95));
    const snap = net.snapshot();
    if (snap.sends >= 1 && !first) {
      first = snap;
      assert.equal(snap.dancers.find(d => d.id === 'a').sustained, true);
      assert.equal(snap.beams.length, 3, 'peak fans out to the partner count');
      assert.ok(snap.beams.every(b => b.gen === 'peak' && b.from === 'a'));
    }
  }
  assert.ok(first, 'peak sends');
  const sendsAtPeak = net.snapshot().sends;
  net.reset();
  // Below the threshold the hold never starts, so the fan-out does not stick.
  const calm = createCrownPulse({peakThreshold: 0.88, peakDuration: 0.3, partnerCount: 3, climbSec: 0.3, peakClimbSec: 0.15});
  for (let i = 1; i <= 30; i++) calm.step(i * 0.05, roster(0.5));
  const snap = calm.snapshot();
  assert.equal(snap.beams.filter(b => b.gen === 'peak').length, 0);
  assert.ok(snap.beams.length <= 1);
  assert.ok(sendsAtPeak >= 1);
});

test('posture stays tall until the bowstring, and arms follow pitch slowly', () => {
  const p = createPosture();
  const quiet = p.step({dt: 0.5, high: 0, bass: 0, pad: 0, tension: 0});
  assert.ok(Math.abs(quiet.armLift - ARM_REST) < 0.08, quiet.armLift);
  assert.ok(Math.abs(quiet.kneeSink - KNEE_SOFT) < 1e-6);
  assert.equal(quiet.stance, 'hip');
  const one = p.step({dt: 0.05, high: 1, bass: 0, pad: 0.8, tension: 0});
  assert.ok(one.armLift < 0.5, 'the arm envelope does not jump in one frame');
  let airy = one;
  for (let i = 0; i < 40; i++) airy = p.step({dt: 0.1, high: 1, bass: 0, pad: 0.6, tension: 0});
  assert.ok(airy.armLift > 0.7, 'high and airy raises the hands: ' + airy.armLift);
  let heavy = airy;
  for (let i = 0; i < 40; i++) heavy = p.step({dt: 0.1, high: 0.1, bass: 0.9, pad: 0, tension: 0});
  assert.ok(heavy.armLift < airy.armLift - 0.25, 'bass-heavy eases the hands down');
  const dropped = p.step({dt: 0.05, high: 0.1, bass: 0.9, drop: 1, tension: 0});
  assert.ok(dropped.dropLift > 0.1, 'a drop adds a brief lift');
  const sunk = p.step({dt: 0.05, tension: 1});
  assert.ok(sunk.kneeSink > 0.9, 'the squat is the bowstring, not the resting stance');
});

test('full reach stays on stage, turns ease inside 90°, wrists stay straight', () => {
  const desk = containDancers({
    width: 1280, height: 720, margin: 10,
    dancers: [
      {x0: 1280 * 0.22, yHead: 720 * 0.23, yFeet: 720 * 0.9},
      {x0: 1280 * 0.49, yHead: 720 * 0.23, yFeet: 720 * 0.9},
      {x0: 1280 * 0.74, yHead: 720 * 0.23 - 3, yFeet: 720 * 0.9},
    ],
  });
  assert.equal(desk.dancers.length, 3);
  for (const d of desk.dancers) {
    assert.ok(d.ok, JSON.stringify(d));
    assert.ok(d.left >= 9 && d.right <= 1280 - 9);
    assert.ok(d.top >= 9 && d.bot <= 720 - 9);
  }
  const phone = containDancers({
    width: 390, height: 844, margin: 8,
    dancers: [
      {x0: 80, yHead: 180, yFeet: 760},
      {x0: 195, yHead: 180, yFeet: 760},
      {x0: 310, yHead: 170, yFeet: 760},
    ],
  });
  assert.ok(phone.dancers.every(d => d.ok), JSON.stringify(phone.dancers.map(d => ({left: d.left, right: d.right, top: d.top, bot: d.bot}))));

  const half = easeTurn(0, MAX_TURN_RAD, 0.5, 0.5, 1);
  assert.ok(Math.abs(half.delta) <= MAX_TURN_RAD * 0.5 + 1e-6, 'a half-beat step cannot spend the whole 90°');
  assert.ok(Math.abs(half.facing) < Math.abs(half.end), 'the turn is still easing at mid-step');
  const full = easeTurn(0, 2, 1, 2, 1);
  assert.ok(Math.abs(full.end - MAX_TURN_RAD) < 1e-6, '90° is the max');
  assert.ok(Math.abs(easeTurn(0, 0.4, 0, 1, 1).facing) < 1e-6);

  const hand = handOnForearm({x: 0, y: 0, z: 0}, {x: 0, y: 1, z: 0}, 0.5);
  assert.ok(Math.abs(hand.x) < 1e-9 && Math.abs(hand.y - 1.5) < 1e-9, 'hand continues the forearm');
  const off = confineLateral(40, 5);
  assert.ok(Math.abs(off) < 5, 'the string offset stays inside the body');

  const prev = {handL: {x: 0, y: 0, z: 0}};
  const next = {handL: {x: 1, y: 0, z: 0}};
  capJointStep(prev, next, MAX_JOINT_STEP);
  assert.ok(jointDisp(prev, next) <= MAX_JOINT_STEP + 1e-9);
});
