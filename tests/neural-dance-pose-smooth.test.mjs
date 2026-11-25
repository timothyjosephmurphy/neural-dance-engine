// Pose transitions ease across frames (TJ Nov 11 7:12 PM): no single-frame jumps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {skeletonPose, resetArmLiftFamilies, armLiftFamilySpecBlended} from '../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, maxJointDelta} from '../neural-dance/src/skeleton-motion.js';

const DT = 1 / 30;

function walk({dynamics, bpm = 139, seconds = 8, clap = true, id = 2} = {}) {
  resetBodyDynamics();
  resetArmLiftFamilies();
  const periodMs = 60000 / bpm;
  const poses = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    const t = i * DT, beat = t * bpm / 60;
    const barBeat = ((Math.round(beat) % 4) + 4) % 4;
    const dtc = t - Math.round(beat) * 60 / bpm;
    const c = clap && (barBeat === 1 || barBeat === 3)
      ? Math.max(0, 1 - Math.abs(dtc) / 0.22) : 0;
    poses.push(skeletonPose({
      id, band: 1, activation: 0.95, armLift: 0.85, now: t * 1000,
      beat, stepHz: bpm / 60, periodMs, bpm, clap: c,
      clapOverhead: c > 0.8 ? 0.5 : 0, hush: 1, still: false,
      dynamics, eightRate: bpm >= 110 ? 0.5 : 1
    }));
  }
  let max = 0, joint = null, at = 0;
  for (let i = 1; i < poses.length; i++) {
    const d = maxJointDelta(poses[i - 1], poses[i]);
    if (d.max > max) { max = d.max; joint = d.joint; at = i * DT; }
  }
  return {max, joint, at};
}

test('largest per-frame joint step stays under the threshold once poses are eased', () => {
  const before = walk({dynamics: false, bpm: 139, clap: true});
  const after = walk({dynamics: true, bpm: 139, clap: true});
  const beforeSlow = walk({dynamics: false, bpm: 90, clap: true});
  const afterSlow = walk({dynamics: true, bpm: 90, clap: true});
  // Printed so the report can show before/after numbers.
  console.log('pose-smooth 139 BPM before', before.max.toFixed(4), before.joint,
    'after', after.max.toFixed(4), after.joint);
  console.log('pose-smooth 90 BPM  before', beforeSlow.max.toFixed(4), beforeSlow.joint,
    'after', afterSlow.max.toFixed(4), afterSlow.joint);
  assert.ok(before.max > 0.18, `unsmoothed jumps are large (got ${before.max.toFixed(3)})`);
  // Body-height units per 1/30 s. A single-frame snap is ~0.25–0.37; eased
  // transitions stay under 0.14 even across family changes and claps.
  const LIMIT = 0.14;
  assert.ok(after.max < LIMIT, `139 BPM eased max ${after.max.toFixed(3)} (at ${after.at.toFixed(2)}s, ${after.joint}) >= ${LIMIT}`);
  assert.ok(afterSlow.max < LIMIT, `90 BPM eased max ${afterSlow.max.toFixed(3)} >= ${LIMIT}`);
  assert.ok(after.max < 0.55 * before.max, `139: after ${after.max.toFixed(3)} not well below before ${before.max.toFixed(3)}`);
  assert.ok(afterSlow.max < 0.55 * beforeSlow.max, `90: after ${afterSlow.max.toFixed(3)} not well below before ${beforeSlow.max.toFixed(3)}`);
});

test('arm-family blend is continuous across a phrase boundary', () => {
  const bpm = 139;
  const end = 8; // last beat of phrase 1
  const a = armLiftFamilySpecBlended(4, end - 0.01, bpm);
  const b = armLiftFamilySpecBlended(4, end, bpm);
  const c = armLiftFamilySpecBlended(4, end + 0.01, bpm);
  // At the downbeat the next family is fully on; just before, almost on.
  for (const k of new Set([...Object.keys(b), ...Object.keys(c)])) {
    assert.ok(Math.abs((+b[k] || 0) - (+c[k] || 0)) < 0.08, `${k} jumps at the downbeat`);
  }
  let maxStep = 0;
  let prev = armLiftFamilySpecBlended(4, end - 1, bpm);
  for (let u = end - 1; u <= end + 0.05; u += 1 / 30 * bpm / 60) {
    const s = armLiftFamilySpecBlended(4, u, bpm);
    for (const k of Object.keys(s)) maxStep = Math.max(maxStep, Math.abs((+s[k] || 0) - (+prev[k] || 0)));
    prev = s;
  }
  assert.ok(maxStep < 0.35, `per-frame family-spec step ${maxStep.toFixed(3)} is a snap`);
});
