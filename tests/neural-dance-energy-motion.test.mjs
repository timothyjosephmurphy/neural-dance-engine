// Energy-driven hips, arms and claps (TJ Nov 11 3:10 / 4:17 PM).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../neural-dance/src/energy-motion.js';
import {skeletonPose} from '../neural-dance/src/skeleton-dancer.js';
import {hipFigureEight} from '../neural-dance/src/skeleton-motion.js';

const fx = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const corr = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (+a.z || 0) - (+b.z || 0));

test('hip amplitude and speed rise monotonically with band energy and are clamped', () => {
  let prev = E.hipEnergyScale(0);
  assert.ok(Math.abs(prev.amp - E.HIP_AMP_MIN) < 1e-9 && prev.dbl === 0);
  for (let e = 0.01; e <= 1.0001; e += 0.01) {
    const s = E.hipEnergyScale(e);
    assert.ok(s.amp >= prev.amp - 1e-12, `amp monotonic at ${e}`);
    assert.ok(s.dbl >= prev.dbl - 1e-12, `dbl monotonic at ${e}`);
    prev = s;
  }
  assert.ok(Math.abs(prev.amp - E.HIP_AMP_MAX) < 1e-9);
  for (const e of [-3, 1.5, 9, NaN, Infinity]) {
    const s = E.hipEnergyScale(e);
    assert.ok(s.amp >= E.HIP_AMP_MIN && s.amp <= E.HIP_AMP_MAX && s.dbl >= 0 && s.dbl <= E.HIP_DOUBLE_MAX, `clamped for ${e}`);
  }
});

test('relative energy follows the song\'s running level and is clamped', () => {
  assert.ok(E.relativeEnergy(0.2, 0.2) < E.relativeEnergy(0.3, 0.2));
  assert.ok(E.relativeEnergy(0.4, 0.1) > E.relativeEnergy(0.4, 0.6), 'louder than the song\'s norm reads higher');
  for (const lv of [-1, 0, 0.5, 2, 99]) { const r = E.relativeEnergy(lv, 0.3); assert.ok(r >= 0 && r <= 1); }
});

test('double-time path stays phase locked: same zero crossings at the beat', () => {
  for (const d of [0, 0.3, 0.55]) {
    const p0 = E.eightPath(0, d), pPi = E.eightPath(Math.PI, d);
    assert.ok(Math.abs(p0.x) < 1e-9 && Math.abs(pPi.x) < 1e-9, `x crosses at loop start / half (dbl ${d})`);
  }
});

test('figure-8 amplitude in the pose grows with the energy-scaled amount', () => {
  const span = amount => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 64; i++) { const h = hipFigureEight({tSec: i / 64 * 2, stepHz: 1, amount, activation: 1}); lo = Math.min(lo, h.x); hi = Math.max(hi, h.x); }
    return hi - lo;
  };
  const a = span(0.05 * E.hipEnergyScale(0.1).amp), b = span(0.05 * E.hipEnergyScale(0.5).amp), c = span(0.05 * E.hipEnergyScale(0.95).amp);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
});

test('hips reference (bass groove): hip size tracks the bass envelope', () => {
  const ref = fx('energy-hips-bass-groove.json');
  const tr = E.createEnergyTracker();
  const bass = [], amp = [];
  let sm = 0;
  for (const [ms, lv, gate] of ref.samples) {
    const st = tr.process(ms, gate ? lv : null, !!gate);
    sm += ((gate ? lv[1] : 0) - sm) * 0.15;
    bass.push(sm);
    amp.push(E.hipEnergyScale(Math.max(st.env[1], 0.85 * st.env[0])).amp);
  }
  const r = corr(bass, amp);
  assert.ok(r > 0.55, `hip amp vs smoothed bass level r=${r.toFixed(2)}`);
  assert.ok(q(amp, 0.9) - q(amp, 0.1) > 0.4, 'visible size swing across the section');
  assert.ok(Math.max(...amp) <= E.HIP_AMP_MAX + 1e-9 && Math.min(...amp) >= E.HIP_AMP_MIN - 1e-9);
});

test('hips reference: bass onsets drive alternating, settling groove accents', () => {
  const ref = fx('energy-hips-bass-groove.json');
  const onsets = ref.onsetsMs[1];
  const g = E.createGrooveAccent();
  let i = 0, peak = 0, signs = [], last = 0;
  const end = onsets[onsets.length - 1] + 1500;
  for (let t = onsets[0] - 500; t < end; t += 16) {
    while (i < onsets.length && onsets[i] <= t) { g.hit(onsets[i], 0.7); i++; }
    const x = g.step(t);
    peak = Math.max(peak, Math.abs(x));
    if (Math.abs(x) > 0.1 && Math.sign(x) !== last) { signs.push(Math.sign(x)); last = Math.sign(x); }
  }
  assert.ok(peak > 0.15 && peak <= 1.2, `accent peak ${peak}`);
  assert.ok(signs.length > 10, 'alternating weight throws');
  assert.ok(Math.abs(g.value()) < 0.02, 'settles after the groove stops');
});

test('arms reference (high synth): sustained melody drives clearly visible arm swells', () => {
  const ref = fx('energy-arms-high-synth.json');
  const tr = E.createEnergyTracker();
  const sw = [];
  for (const [s, lv] of ref.series1s) {
    for (let k = 0; k < 10; k++) tr.process(s * 1000 + k * 100, lv, true);
    sw.push(E.armSwell(E.melodicSustain(2, tr.state.sustained)));
  }
  const big = sw.filter(v => v > 0.5).length / sw.length;
  assert.ok(big > 0.2, `mid dancers raise arms on ${(big * 100).toFixed(0)}% of the clip`);
  assert.ok(q(sw, 0.9) > 0.8, 'full swells happen');
  // Flowing: second-to-second change stays small (no snapping).
  let maxStep = 0;
  for (let i = 1; i < sw.length; i++) maxStep = Math.max(maxStep, Math.abs(sw[i] - sw[i - 1]));
  assert.ok(maxStep < 0.75, `max per-second swell change ${maxStep.toFixed(2)}`);
  const d = E.armEnergyDrive(1);
  const pose0 = skeletonPose({id: 3, band: 2, armLift: 0}), pose1 = skeletonPose({id: 3, band: 2, armLift: d.lift});
  assert.ok(pose1.handL.y < pose0.handL.y - 0.02 || pose1.handR.y < pose0.handR.y - 0.02, 'swell raises the hands');
});

test('claps: backbeats only, near peak, never in cooldown, snare preferred', () => {
  for (let b = 0; b < 4; b++) {
    const ok = E.clapEligible({act: 0.95, barBeat: b, snare: 1});
    assert.equal(ok, b === 1 || b === 3, `bar beat ${b}`);
  }
  assert.equal(E.clapEligible({act: 1, hot: true, rest: true, barBeat: 1, snare: 1}), false, 'cooldown');
  assert.equal(E.clapEligible({act: 0.5, barBeat: 1, snare: 1}), false, 'not near peak');
  assert.equal(E.clapEligible({act: 0.85, barBeat: 3, snare: 1}), true);
  assert.equal(E.clapEligible({act: 0.85, barBeat: 3, snare: 0}), false, 'without a snare, only right at peak');
  assert.equal(E.clapEligible({act: 0.5, hot: true, barBeat: 1}), true, 'at peak');
  assert.equal(E.clapEligible({act: 1, barBeat: -1}), false, 'no locked grid');
  const p = E.createSnarePattern();
  for (let i = 0; i < 8; i++) { p.note(1, true); p.note(3, true); p.note(0, false); p.note(2, false); }
  assert.ok(p.backbeat() > 0.8);
});

test('clap envelope peaks on the beat and is 0 outside the window', () => {
  assert.equal(E.clapEnvelope(-0.5), 0);
  assert.equal(E.clapEnvelope(0), 1);
  assert.equal(E.clapEnvelope(1), 0);
  assert.ok(E.clapEnvelope(-0.07) > 0 && E.clapEnvelope(-0.07) < 1);
  assert.ok(E.clapEnvelope(0.12) > 0 && E.clapEnvelope(0.12) < 1);
});

test('clap pose: hands meet in front of the chest or overhead, bone lengths kept', () => {
  const base = skeletonPose({id: 1, band: 2, armLift: 0.6});
  const bl = p => [dist(p.shL, p.elL), dist(p.elL, p.wristL), dist(p.shR, p.elR), dist(p.elR, p.wristR)];
  for (const oh of [0, 1]) {
    const p = skeletonPose({id: 1, band: 2, armLift: 0.6, clap: 1, clapOverhead: oh});
    assert.ok(dist(p.handL, p.handR) < 0.03, `hands meet (overhead ${oh}): ${dist(p.handL, p.handR)}`);
    const a = bl(base), b = bl(p);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-3, `bone ${i} length kept`);
    if (oh) assert.ok(p.handL.y < p.crown.y, 'overhead: above the head');
    else { assert.ok(p.handL.y > p.shL.y && p.handL.y < p.groin.y, 'chest height'); assert.ok((+p.handL.z || 0) > 0.15, 'in front'); }
  }
  const half = skeletonPose({id: 1, band: 2, armLift: 0.6, clap: 0.5});
  assert.ok(dist(half.handL, half.handR) < dist(base.handL, base.handR), 'blend moves hands together');
});

test('clap ripple is smaller than a stomp ring', () => {
  assert.ok(E.CLAP_RIPPLE > 0 && E.CLAP_RIPPLE < 1);
});

test('TJ arm rule: clap and swell arms never go behind the back of the head (side view)', () => {
  for (const id of [1, 2, 5, 9]) for (const oh of [0, 0.5, 1]) for (const c of [0, 0.3, 0.7, 1]) for (const lift of [0, 0.25, 0.5]) {
    const p = skeletonPose({id, band: 2, armLift: 0.6, armSwellLift: lift, clap: c, clapOverhead: oh, now: 1000 + id * 137});
    const back = (+p.head.z || 0) - (+p.headR || 0.066);
    for (const k of ['elL', 'elR', 'wristL', 'wristR', 'handL', 'handR'])
      assert.ok((+p[k].z || 0) >= back - 1e-3, `${k} z ${(+p[k].z || 0).toFixed(3)} behind head back ${back.toFixed(3)} (id ${id} clap ${c} oh ${oh})`);
  }
});

test('arm swell raises arms without waking the body', () => {
  const a = skeletonPose({id: 4, band: 2, activation: 0.1, armSwellLift: 0});
  const b = skeletonPose({id: 4, band: 2, activation: 0.1, armSwellLift: 0.5});
  assert.ok(Math.min(b.handL.y, b.handR.y) < Math.min(a.handL.y, a.handR.y) - 0.02, 'hands rise');
  assert.ok(Math.abs(b.crown.y - a.crown.y) < 0.01, 'crown height unchanged');
});

test('applyClap re-aims any bone that would pass behind the head', () => {
  // Arms swung far back (z negative) at clap start.
  const j = {shL: {x: -0.13, y: 0.22, z: 0}, shR: {x: 0.13, y: 0.22, z: 0},
    elL: {x: -0.15, y: 0.30, z: -0.14}, elR: {x: 0.15, y: 0.30, z: -0.14},
    wristL: {x: -0.16, y: 0.42, z: -0.22}, wristR: {x: 0.16, y: 0.42, z: -0.22},
    handL: {x: -0.16, y: 0.50, z: -0.26}, handR: {x: 0.16, y: 0.50, z: -0.26}};
  const lu = dist(j.shL, j.elL), lf = dist(j.elL, j.wristL);
  for (const w of [0.05, 0.2, 0.5]) {
    const k = E.applyClap(structuredClone(j), w, 0);
    for (const n of ['elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) assert.ok(k[n].z >= -E.HEAD_BACK_Z - 1e-6, `${n} at w ${w}: ${k[n].z}`);
    assert.ok(Math.abs(dist(k.shL, k.elL) - lu) < 1e-6 && Math.abs(dist(k.elL, k.wristL) - lf) < 1e-6, 'bone lengths kept');
  }
});

test('half-time feel: one sway per two beats above ~110 BPM, full-time when slow', () => {
  assert.equal(E.halfTimeFeel(139), true);
  assert.equal(E.halfTimeFeel(110), true);
  assert.equal(E.halfTimeFeel(109), false);
  assert.equal(E.halfTimeFeel(80), false);
  assert.equal(E.swayRate(139), 0.5);
  assert.equal(E.swayRate(90), 1);
  const fast = E.hipEnergyScale(1, 139), slow = E.hipEnergyScale(1, 90);
  assert.equal(fast.dbl, 0, 'no double-time harmonic at high BPM');
  assert.ok(slow.dbl > 0.4, 'double-time still available when slow and loud');
  assert.equal(fast.amp, slow.amp);
});

test('ease window is 150–400 ms and shrinks as the tempo rises', () => {
  const a = E.easeWindowS(80), b = E.easeWindowS(112), c = E.easeWindowS(160);
  assert.ok(a >= b - 1e-12 && b >= c - 1e-12);
  for (const bpm of [60, 90, 112, 139, 180]) {
    const w = E.easeWindowS(bpm);
    assert.ok(w >= E.EASE_MIN_S - 1e-12 && w <= E.EASE_MAX_S + 1e-12, `${bpm} -> ${w}`);
  }
});

test('at half-time, groove accents skip close or weak onsets', () => {
  const g = E.createGrooveAccent();
  g.setTempo(139);
  const beat = 60000 / 139;
  let hits = 0;
  // A hit every 16th (~108 ms) — closer than the half-time gap (~1.75 beats).
  for (let i = 0; i < 16; i++) if (g.hit(1000 + i * (beat / 4), 0.8) !== false) hits++;
  // hit() returns false on skip, true on accept; first always accepts.
  assert.ok(hits <= 5, `only sparse hits, got ${hits}`);
  const weak = E.createGrooveAccent();
  weak.setTempo(139);
  assert.equal(weak.hit(0, 0.1), false, 'weak onset ignored at half-time');
  assert.equal(weak.hit(0, 0.8), true);
});

test('claps stay sparse at high BPM: even bars only, still backbeats', () => {
  assert.equal(E.clapEligible({act: 0.95, barBeat: 1, snare: 1, bpm: 139, bar: 0}), true);
  assert.equal(E.clapEligible({act: 0.95, barBeat: 1, snare: 1, bpm: 139, bar: 1}), false, 'odd bar skipped');
  assert.equal(E.clapEligible({act: 0.95, barBeat: 1, snare: 1, bpm: 90, bar: 1}), true, 'full-time keeps every bar');
  // Lead scales so the envelope is already rising before the beat.
  const lead = E.easeWindowS(90);
  assert.ok(E.clapEnvelope(-lead / 2, lead) > 0 && E.clapEnvelope(-lead / 2, lead) < 1);
  assert.equal(E.clapEnvelope(0, lead), 1);
});
