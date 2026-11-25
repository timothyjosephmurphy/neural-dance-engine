// TJ 6:55 / 6:57 PM: leg arc through the groin, side-sim pulse string
// (strikes travel up node by node, amplitude follows energy), and a planted
// stance foot during weight transfer with only rare jumps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSilhouetteShow, legArcPoints, sampleLegArc} from '../neural-dance/src/silhouette.js';
import {pulseWaveAt, pulseStringPoints, pulseTravelTimes, pulseFront, pulseEnvelopeAt} from '../neural-dance/src/vibrating-string.js';
import {skeletonPose, placePoseOnFloor, isJumpBeat, jumpLift, JUMP_RISE} from '../neural-dance/src/skeleton-dancer.js';
import {simSilhouetteMarkers} from '../neural-dance/room-lab.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}

test('leg arc runs foot → knee → groin → knee → foot, through the groin point', () => {
  for (const w of [-1, -0.4, 0, 0.6, 1]) {
    const pose = placePoseOnFloor(skeletonPose({id: 7, band: 1, weight: w, ease: 0.5, side: w >= 0 ? 1 : -1}), {cx: 400, cy: 300, baseH: 90, height: 90, side: w >= 0 ? 1 : -1});
    const pts = legArcPoints(pose, w);
    assert.equal(pts.length, 5);
    assert.deepEqual(pts[0], {x: pose.footL.x, y: pose.footL.y});
    assert.deepEqual(pts[1], {x: pose.kneeL.x, y: pose.kneeL.y});
    assert.deepEqual(pts[3], {x: pose.kneeR.x, y: pose.kneeR.y});
    assert.deepEqual(pts[4], {x: pose.footR.x, y: pose.footR.y});
    // The middle waypoint is the groin (root), leaning ≤ 3% of height.
    assert.equal(pts[2].y, pose.groin.y);
    assert.ok(Math.abs(pts[2].x - pose.groin.x) <= 90 * 0.03 + 1e-9);
    const arc = sampleLegArc(pts, 6);
    assert.ok(arc.some(p => Math.hypot(p.x - pts[2].x, p.y - pts[2].y) < 1e-9), 'sampled arc passes through the groin waypoint');
    // Highest point of the arc is at the groin: it goes UP through it, not across the gap below.
    const top = Math.min(...arc.map(p => p.y));
    assert.ok(top >= pose.groin.y - 0.6, 'no overshoot above the groin');
    // Between the knees the arc rises through the groin; it never sags into a
    // knee-to-knee crossing below them. (Knees bend forward now, TJ 10:32 AM,
    // so a knee can sit right under the groin; the old "nothing within 2 px of
    // the groin x below it" check assumed bow-legged knees.)
    const mid = arc.slice(6, 19);
    assert.ok(mid.every(p => p.y <= Math.max(pose.kneeL.y, pose.kneeR.y) + 2), 'no crossing segment hanging below the knees');
  }
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(src, /paintLegArc\(ctx, legArcPoints\(posed, planted\)/);
});

test('injected pulse travels up the string node by node, after the leg delay', () => {
  const times = pulseTravelTimes();
  const strikes = [{t0: 0, side: 1, energy: 1}];
  const amp = 12;
  // Arrival = the travelling excitation reaching half strength at that node.
  const arrive = s => {
    for (let t = 0; t < 2; t += 0.002) if (pulseEnvelopeAt(s, t, strikes[0], times) > 0.5 * Math.exp(-Math.max(0, t - times.leg) * 1.15)) return t;
    return Infinity;
  };
  // Nothing on the string while the pulse is still climbing the leg.
  for (let t = 0; t < times.leg - 0.06; t += 0.01) for (const s of [0, 0.135, 0.281, 0.417, 0.781, 0.917, 1]) assert.equal(pulseWaveAt(s, t, strikes, {amp, times}), 0);
  const nodes = [0.135, 0.281, 0.417, 0.62, 0.917];
  const at = nodes.map(arrive);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1] + 0.02, `node ${nodes[i]} lights after ${nodes[i - 1]} (${at[i - 1].toFixed(3)} → ${at[i].toFixed(3)})`);
  }
  // Delay ≈ string travel time × node spacing.
  const slope = (at[at.length - 1] - at[0]) / (nodes[nodes.length - 1] - nodes[0]);
  assert.ok(slope > times.str * 0.6 && slope < times.str * 1.5, 'travel speed ' + slope.toFixed(3));
  // Displacement is gated by that envelope: the top node is still before the front arrives, moving after.
  const top = 0.917;
  for (let t = times.leg; t < at[at.length - 1] - 0.15; t += 0.01) assert.ok(Math.abs(pulseWaveAt(top, t, strikes, {amp, hz: 0.9, times})) < amp * 0.08, 'crown side quiet before the front at ' + t.toFixed(2));
  let moved = 0;
  for (let t = at[at.length - 1]; t < at[at.length - 1] + 0.5; t += 0.01) moved = Math.max(moved, Math.abs(pulseWaveAt(top, t, strikes, {amp, hz: 0.9, times})));
  assert.ok(moved > amp * 0.25, 'crown side moves once the front arrives (' + moved.toFixed(2) + ')');
  // pulseFront reports the same climb.
  assert.equal(pulseFront(strikes, times.leg * 0.5, times).phase, 'leg');
  const f = pulseFront(strikes, times.leg + times.str * 0.5, times);
  assert.equal(f.phase, 'string');
  assert.ok(Math.abs(f.s - 0.5) < 1e-9);
  // Decays back toward rest.
  assert.ok(Math.abs(pulseWaveAt(0.5, 4, strikes, {amp, times})) < amp * 0.05);
});

test('string displacement scales with pulse energy; points move with the pulse', () => {
  const times = pulseTravelTimes();
  const peak = energy => {
    let m = 0;
    for (let t = 0; t < 2; t += 0.004) for (const s of [0.2, 0.5, 0.8]) m = Math.max(m, Math.abs(pulseWaveAt(s, t, [{t0: 0, side: -1, energy}], {amp: 10, hz: 0.9, times})));
    return m;
  };
  const lo = peak(0.1), hi = peak(1);
  assert.ok(hi > lo * 1.8, `energy 1 (${hi.toFixed(2)}) ≫ energy 0.1 (${lo.toFixed(2)})`);
  const axis = {x: 100, top: 0, height: 200};
  const quiet = pulseStringPoints(axis, {now: 600, amp: 10, rest: 0, strikes: []});
  assert.ok(quiet.every(p => p.x === 100), 'no pulse → straight string at rest 0');
  const hit = pulseStringPoints(axis, {now: 600, amp: 10, rest: 0, strikes: [{t0: 0, side: 1, energy: 1}]});
  assert.ok(Math.max(...hit.map(p => Math.abs(p.x - 100))) > 3, 'pulse visibly displaces the string');
});

test('stance foot stays planted through each weight transfer; only the free foot lifts', () => {
  // Pure pose: across a whole beat with throb height changes, the stance toe is constant.
  for (const side of [-1, 1]) {
    const key = side < 0 ? 'footL' : 'footR';
    const free = side < 0 ? 'footR' : 'footL';
    let ref = null;
    let maxLift = 0;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const unit = skeletonPose({id: 3, band: 2, weight: side * (1 - f) - side * f, ease: f, side});
      const pose = placePoseOnFloor(unit, {cx: 500, cy: 300, baseH: 90, height: 90 * (1 + 0.04 * Math.sin(f * 9)), side});
      if (!ref) ref = pose[key];
      assert.ok(Math.abs(pose[key].x - ref.x) < 1e-9 && Math.abs(pose[key].y - ref.y) < 1e-9, 'stance foot moved at ease ' + f.toFixed(2));
      assert.ok(Math.abs(pose[key].y - pose.floorY) < 1e-9, 'stance foot on the floor');
      maxLift = Math.max(maxLift, pose.floorY - pose[free].y);
    }
    assert.ok(maxLift > 2, 'free foot lifts (' + maxLift.toFixed(2) + ' px)');
  }
  // Live show: per dancer, while the stance side is unchanged the stance foot doesn't move.
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = recorder();
  const sims = simSilhouetteMarkers([{id: 201, x: 300, y: 300, type: 1}, {id: 202, x: 600, y: 300, type: 2}]);
  const runs = new Map();
  let transitions = 0;
  for (let t = 1000; t < 5000; t += 16) {
    if (t % 480 < 16) { show.beat(t, 2); show.beat(t, 4); }
    show.paint(ctx, sims, {now: t, xy: (x, y) => ({x, y})});
    for (const f of show.figureHeights()) {
      if (f.jump > 0) { runs.delete(f.id); continue; }
      const foot = f[f.stance];
      const prev = runs.get(f.id);
      if (prev && prev.stance === f.stance) {
        assert.ok(Math.abs(foot.x - prev.x) < 1e-6 && Math.abs(foot.y - prev.y) < 1e-6, `dancer ${f.id} stance foot slid at ${t} ms`);
      } else if (prev) transitions++;
      runs.set(f.id, {stance: f.stance, x: foot.x, y: foot.y});
      assert.ok(Math.abs(foot.y - f.floorY) < 1e-6, 'stance foot on the floor');
    }
  }
  assert.ok(transitions >= 6, 'weight transfers alternate feet (' + transitions + ')');
});

test('jumps are rare (≈1 in 16–32 beats per dancer) and lift both feet briefly', () => {
  for (const id of [1, 17, 104, 333]) {
    let n = 0;
    for (let b = 0; b < 4000; b++) if (isJumpBeat(id, b)) n++;
    const rate = n / 4000;
    assert.ok(rate > 1 / 45 && rate < 1 / 12, `dancer ${id} jump rate ${rate.toFixed(4)}`);
  }
  assert.equal(jumpLift(0), 0);
  assert.equal(jumpLift(0.6), 0);
  assert.ok(jumpLift(0.21) > JUMP_RISE * 0.95);
  const unit = skeletonPose({id: 5, band: 0, weight: -1, ease: 0.2, side: -1});
  const ground = placePoseOnFloor(unit, {cx: 0, cy: 0, baseH: 90, height: 90, side: -1});
  const air = placePoseOnFloor(unit, {cx: 0, cy: 0, baseH: 90, height: 90, side: -1, jump: jumpLift(0.21)});
  assert.ok(air.footL.y < ground.floorY - 5 && air.footR.y < ground.floorY - 5, 'both feet leave the floor');
});

test('string lateral swing is a subtle in-torso shimmer (TJ Nov 10 4:10 PM)', async () => {
  const {STRING_MAX_LATERAL_FRAC, PULSE_AMP_FRAC} = await import('../neural-dance/src/vibrating-string.js');
  for (const H of [40, 90, 150]) {
    const axis = {x: 0, top: 0, height: H};
    // Worst case: four overlapping full-energy strikes, same side.
    const strikes = [0, 0.12, 0.24, 0.36].map(t0 => ({t0, side: 1, energy: 1}));
    let peak = 0;
    for (let t = 0; t < 3; t += 0.01) {
      const pts = pulseStringPoints(axis, {now: t * 1000, amp: PULSE_AMP_FRAC * H, hz: 1.25, phase: t * 7, strikes});
      for (const p of pts) peak = Math.max(peak, Math.abs(p.x));
    }
    assert.ok(peak <= STRING_MAX_LATERAL_FRAC * H + 1e-9, `H ${H}: peak ${peak.toFixed(2)} > cap`);
    assert.ok(peak <= 0.045 * H + 1e-9, `H ${H}: peak ${peak.toFixed(2)} should stay a subtle shimmer`);
    assert.ok(peak > 0.008 * H, `H ${H}: pulse still visible (${peak.toFixed(2)})`);
  }
  // Insets use the same render closure (same amp, axis in stage px) → same bound once scaled.
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(src, /pick\.render\(X, k(?:, pick\.height)?\)/);
});

test('each corner inset is labelled with its source dancer (band + number) and tagged on stage (TJ 7:04 PM)', async () => {
  const {BAND_LABELS, insetLabel} = await import('../neural-dance/src/silhouette.js');
  const texts = [];
  const target = {canvas: {width: 1000, height: 620}, fillText(t, x, y) { texts.push({t, x, y}); }, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }};
  const ctx = new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const sims = simSilhouetteMarkers(Array.from({length: 12}, (_, i) => ({id: i + 1, x: 200 + (i % 4) * 160, y: 180 + Math.floor(i / 4) * 130, type: i % 4})));
  show.paint(ctx, sims, {now: 2000, xy: (x, y) => ({x, y})});
  const insets = show.insetStates();
  assert.equal(insets.length, 4);
  const stage = new Map(show.figureHeights().map(f => [f.id, f]));
  for (const ins of insets) {
    const src = stage.get(ins.id);
    assert.ok(src, 'inset source dancer exists');
    assert.equal(ins.label, BAND_LABELS[src.band] + ' · #' + src.id);
    assert.equal(ins.label, insetLabel(src.id, src.band));
    assert.ok(texts.some(t => t.t === ins.label), 'label drawn: ' + ins.label);
    // Stage tag sits by that dancer (within one figure height of it).
    const tag = texts.find(t => t.t === '#' + src.id);
    assert.ok(tag, 'stage tag drawn for #' + src.id);
    assert.ok(Math.hypot(tag.x - src.x, tag.y - src.y) < src.height * 1.2, 'tag near its dancer');
  }
  assert.deepEqual(BAND_LABELS.slice(1), ['Bass', 'Mid', 'High']);
});

test('pulse string strikes come from each dancer\'s own Listen band clock', () => {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = recorder();
  const sims = simSilhouetteMarkers([{id: 301, x: 300, y: 300, type: 1}, {id: 302, x: 600, y: 300, type: 2}]);
  // Band 1 (Bass) at 600 ms, band 2 (Mid) at 400 ms, with tracked periods.
  for (let t = 1000; t <= 4000; t += 16) {
    if ((t - 1000) % 592 < 16) show.beat(t, 2, {period: [0, 600, 0, 0]});
    if ((t - 1000) % 400 < 16) show.beat(t, 4, {period: [0, 0, 400, 0]});
    show.paint(ctx, sims, {now: t, xy: (x, y) => ({x, y})});
  }
  const figs = new Map(show.figureHeights().map(f => [f.id, f]));
  for (const [id, band] of [[301, 1], [302, 2]]) {
    const c = show.bandClock(band);
    assert.ok(c.strikeAt >= 0, 'band ' + band + ' struck');
    assert.equal(figs.get(id).lastStrikeT0, c.strikeAt / 1000, 'dancer ' + id + ' pulses on band ' + band + ' strikes');
  }
});
