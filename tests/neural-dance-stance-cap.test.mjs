// Stance cap + runaway guard (TJ Nov 10, 9:55 AM and 10:14 AM).
// "No further than twice shoulder width wide, like a horse riding stance, and
// only at the peak activation." On a06aaa9 a dancer that stayed latched for
// minutes grew its stance without bound (width lock fed the world toe-to-toe
// distance back into the pose), so legs streaked across the stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {corpusClips, replayClip, stanceStats} from './helpers/stance-harness.mjs';
import {skeletonPose, buildFor, STANCE_SH_MAX, STANCE_WIDE_ACT, stanceWidthFor, boundPose} from '../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel} from '../neural-dance/src/skeleton-motion.js';

const footMid = (u, s) => (u['foot' + s].x + u['heel' + s].x) / 2;
const spanSh = u => Math.abs(footMid(u, 'R') - footMid(u, 'L')) / (2 * u.b.shW);

test('stance by activation: rest under the hips, near shoulder width dancing, horse stance (≤ 2.0) only at peak', () => {
  const at = a => skeletonPose({id: 5, band: 1, side: -1, activation: a, tall: 0});
  const rest = skeletonPose({id: 5, band: 1, side: -1, activation: 0, still: true, hush: 0});
  assert.ok(spanSh(rest) < 1.0, 'rest ' + spanSh(rest).toFixed(2));
  for (const a of [0.2, 0.4, 0.6, STANCE_WIDE_ACT]) assert.ok(spanSh(at(a)) <= 1.2, 'act ' + a + ' span ' + spanSh(at(a)).toFixed(2));
  const peak = at(1);
  assert.ok(spanSh(peak) > 1.7 && spanSh(peak) <= STANCE_SH_MAX + 1e-6, 'peak ' + spanSh(peak).toFixed(2));
  // Knees bend in the horse stance: hips drop versus mid activation.
  assert.ok(peak.groin.y > at(0.5).groin.y + 0.03, 'hips drop at peak');
  for (let id = 0; id < 40; id++) for (const band of [0, 1, 2, 3]) {
    const b = buildFor(id, band);
    assert.ok(stanceWidthFor(5, b) <= STANCE_SH_MAX * b.shW, 'stanceWidthFor caps at 2.0');
  }
});

test('a runaway or NaN pose is clamped or reset instead of drawn', () => {
  const u = skeletonPose({id: 9, band: 2, side: 1, activation: 0.5});
  u.footL.x = -1; u.heelL.x = -1; u.ankleL.x = -1;
  assert.equal(boundPose(u, u.b, 1), true);
  assert.ok(spanSh(u) <= STANCE_SH_MAX + 1e-6, 'span clamped to ' + spanSh(u).toFixed(2));
  const bad = skeletonPose({id: 9, band: 2, side: 1, activation: 0.5});
  bad.kneeL = {x: NaN, y: 0};
  assert.equal(boundPose(bad, bad.b, 1), false);
  const far = skeletonPose({id: 9, band: 2, side: 1, activation: 0.5});
  far.footL.x = 1e6;
  assert.equal(boundPose(far, far.b, 1), false, 'absurd geometry is rejected');
  resetBodyDynamics(); resetTravel();
  const p = skeletonPose({id: 9, band: 2, side: 1, activation: NaN, now: 1000, stepHz: NaN, periodMs: NaN});
  for (const k of ['footL', 'footR', 'kneeL', 'kneeR', 'groin', 'handL']) assert.ok(Number.isFinite(p[k].x + p[k].y), k + ' finite');
});

test('every demo clip: planted feet never part wider than 2.0 shoulder widths; wide only at higher activation', () => {
  const all = [];
  for (const c of corpusClips()) {
    const s = replayClip(c, {loops: 1, dancers: 4, fps: 30, drive: 2});
    const st = stanceStats(s);
    assert.ok(st.max <= STANCE_SH_MAX + 1e-6, c.split('|')[0] + ' max ' + st.max.toFixed(3));
    all.push(...s);
  }
  const st = stanceStats(all);
  assert.ok(st.max <= STANCE_SH_MAX + 1e-6);
  assert.ok(st.p95 <= 1.3, 'p95 ' + st.p95.toFixed(2));
  if (st.wideFrac > 0) assert.ok(st.wideActMean > st.narrowActMean, 'over-1.2x frames have higher activation (' + st.wideActMean.toFixed(2) + ' vs ' + st.narrowActMean.toFixed(2) + ')');
  assert.ok(st.corr > 0, 'width correlates with activation (r=' + st.corr.toFixed(2) + ')');
});

test('10 minutes latched under music: legs stay bounded, on the sticker, and frame cost stays flat', () => {
  const clip = corpusClips()[0];
  const costs = [];
  let maxSep = 0, maxOff = 0, bad = 0, last = performance.now();
  const s = replayClip(clip, {loops: Math.ceil(600 / 17.1), dancers: 3, fps: 30, drive: 3, onFrame: (x, r) => {
    if (!Number.isFinite(x.sep)) bad++;
    maxSep = Math.max(maxSep, x.sep);
    maxOff = Math.max(maxOff, Math.abs(r.hipX - r.x) / r.height);
    if (x.id === 100) { const t = performance.now(); costs.push(t - last); last = t; }
  }});
  assert.ok(s[s.length - 1].t >= 600, 'ran ' + s[s.length - 1].t.toFixed(0) + ' s');
  assert.equal(bad, 0, 'no non-finite feet');
  assert.ok(maxSep <= STANCE_SH_MAX + 1e-6, 'max separation ' + maxSep.toFixed(3));
  assert.ok(maxOff < 0.6, 'hips stay on the sticker (max ' + maxOff.toFixed(2) + ' heights off)');
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const first = med(costs.slice(30, 1830)), lastMin = med(costs.slice(-1800));
  assert.ok(lastMin < first * 2 + 0.5, 'frame cost flat: first minute ' + first.toFixed(2) + ' ms, last ' + lastMin.toFixed(2) + ' ms');
});
