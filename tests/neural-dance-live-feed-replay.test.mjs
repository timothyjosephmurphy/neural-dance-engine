// TJ 11:18 / 11:24 AM PT (live 52064c5): "Feet are still sliding around a bit."
// Replays the sticker tracks recorded from TJ's live debug feed (re-detection
// jumps of ~40 px that last seconds), camera jitter, traced-height wobble
// (which rescales every sim via the median sticker height) and sims, and
// measures planted-foot slip end to end in screen px, on the stage and in the
// corner insets. Before this fix: vertical slip p99 1.29 px/frame with ~half of
// planted frames over 0.5 px, insets framed on the swaying groin.
import test from 'node:test';
import assert from 'node:assert/strict';
import {liveReplay} from './helpers/live-replay.mjs';
import {STEP_MIN_ACT} from '../neural-dance/src/skeleton-dancer.js';

test('live feed replay: planted feet never slide on stage or in the insets', () => {
  const r = liveReplay({phases: [
    {s: 60, level: 0.25, kind: 'music', bpm: 118, lowBelow: STEP_MIN_ACT},
    {s: 60, level: 0.8, kind: 'music', bpm: 124, lowBelow: 0},
    {s: 20, kind: 'silence', lowBelow: 0},
    {s: 40, level: 0.55, kind: 'music', bpm: 100, lowBelow: STEP_MIN_ACT}
  ]});
  console.log('# live replay', JSON.stringify({slipXMax: r.slipXMax, slipYMax: r.slipYMax, insetSlipMax: r.insetSlipMax, insetCuts: r.insetCuts, planted: r.slipX}));
  assert.ok(r.slipX > 10000, 'measured planted frames');
  assert.ok(r.slipXMax <= 0.2, 'stage horizontal slip ' + r.slipXMax.toFixed(3) + ' px');
  // The floor line only moves for a settled real sticker move, and then by
  // < 0.3% height per weight transfer.
  assert.ok(r.slipYMax <= 0.35, 'stage vertical slip ' + r.slipYMax.toFixed(3) + ' px');
  assert.equal(r.slipYOver05, 0);
  // Same bound as the stage floor catch-up (0.35 px) at the inset zoom (~2x).
  assert.ok(r.insetSlipMax < 0.75, 'inset slip ' + r.insetSlipMax.toFixed(3) + ' px');
  assert.ok(r.insetCuts <= 12, 'inset re-frame cuts are rare (' + r.insetCuts + ')');
});

test('low activation: both feet stay planted, weight shifts foot to foot on the beat', () => {
  const bpm = 118, period = 60 / bpm, last = new Map(), phase = [], drops = [];
  let low = 0, lifts = 0, settle = 0;
  liveReplay({phases: [{s: 60, level: 0.25, kind: 'music', bpm, lowBelow: STEP_MIN_ACT}], onFrame(fr, x) {
    if (x.t < 5 || !(fr.activation < STEP_MIN_ACT)) return;
    low++;
    if (Math.max(x.cL, x.cR) > 0.003) { if (fr.settling) settle++; else lifts++; }
    const side = /L$/.test(fr.stance) ? 'L' : 'R', p = last.get(fr.id);
    if (p && p !== side) phase.push((x.t % period) / period);
    last.set(fr.id, side);
    const j = fr.joints; if (j) drops.push(side === 'L' ? j.hipL.y - j.hipR.y : j.hipR.y - j.hipL.y);
  }});
  phase.sort((a, b) => a - b);
  console.log('# low act', JSON.stringify({low, lifts, settle, shifts: phase.length, p90: phase[Math.floor(phase.length * 0.9)]}));
  assert.ok(low > 5000, 'low-activation frames ' + low);
  assert.equal(lifts, 0, 'no foot lifts below the step threshold');
  // Settling steps only when the sticker home really moved (the replay has one).
  assert.ok(settle / low < 0.03, 'settling steps are rare (' + settle + ' frames)');
  assert.ok(phase.length > 300, 'weight shifts ' + phase.length);
  assert.ok(phase[Math.floor(phase.length * 0.9)] < 0.15, 'weight shifts land on the beat');
  assert.ok(drops.filter(v => v > 0).length / drops.length > 0.6, 'the loaded hip drops over the stance leg');
});
