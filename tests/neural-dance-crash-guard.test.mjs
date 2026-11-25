// TJ 9:08 PM: "seems to crash" and "Listen cuts out". The projector must keep
// running through bad frames, NaN motion state must self-heal, and an ended
// mic track must be re-acquired.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {smoothPoseJoints, bodyTravelState, resetBodyDynamics, resetTravel} from '../neural-dance/src/skeleton-motion.js';

const pose = (x = 0, y = 0) => ({head: {x, y: y - 1, z: 0}, handL: {x: x - 0.3, y, z: 0}, handR: {x: x + 0.3, y, z: 0}, footL: {x: x - 0.1, y: y + 1, z: 0}, footR: {x: x + 0.1, y: y + 1, z: 0}, raise: 0});

test('a NaN joint target does not poison the spring state', () => {
  resetBodyDynamics();
  smoothPoseJoints(7, pose(), {tSec: 0});
  smoothPoseJoints(7, pose(), {tSec: 0.016});
  const bad = pose(); bad.handL.y = NaN;
  smoothPoseJoints(7, bad, {tSec: 0.032});
  const out = smoothPoseJoints(7, pose(0.1, 0), {tSec: 0.048});
  for (const k of ['head', 'handL', 'handR']) assert.ok(Number.isFinite(out[k].x) && Number.isFinite(out[k].y), k);
});

test('body travel state self-heals from NaN', () => {
  resetTravel();
  bodyTravelState({id: 3, tSec: 0, activation: 1});
  const r1 = bodyTravelState({id: 3, tSec: 0.02, activation: NaN});
  const r2 = bodyTravelState({id: 3, tSec: 0.04, activation: 1});
  assert.ok(Number.isFinite(r2.facing) && Number.isFinite(r2.hipYaw), JSON.stringify({r1, r2}));
});

test('per-id motion state is capped as ids grow', () => {
  resetBodyDynamics(); resetTravel();
  for (let id = 0; id < 2000; id++) { smoothPoseJoints(id, pose(), {tSec: 1}); bodyTravelState({id, tSec: 1}); }
  const src = readFileSync(new URL('../neural-dance/src/skeleton-motion.js', import.meta.url), 'utf8');
  assert.match(src, /dynMap\.size > 256\) dynMap\.clear\(\)/);
  assert.match(src, /travelMap\.size > 256\) travelMap\.clear\(\)/);
});

test('room-lab keeps the projector running through bad frames and re-acquires an ended mic', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /if\(frameErrors>=30\)\{if\(!isLiveShowPage\(\)\)\{stop\('Paused'\);return;\}frameRecoveries\+\+/);
  assert.match(room, /if\(was\)scheduleMicRecover\(\)/);
  assert.match(room, /debugRoom\(\)\{return \{frameRecoveries,frameError:lastFrameError,micRecoveries,/);
});
