// Per-band Listen timing (TJ 6:45 PM): each part's dancers lock to their own
// part. Offline harness: synthesized kick / bass / snare / hat at known times
// through an emulated AnalyserNode at the live frame cadence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../neural-dance/silence-gate.js';
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {createSilhouetteShow, dancerMotionClock, BEAT_FRESH_MS} from '../neural-dance/src/silhouette.js';
import {SCENARIOS, SR, createAnalyser, createLegacyDetector, render, run, score} from './helpers/listen-sim.mjs';

const BANDS = ['kick', 'bass', 'mid', 'hat'];
const gate = () => ({lib: globalThis.ndSilenceGate, state: globalThis.ndSilenceGate.create()});
const results = {};
function resultFor(name) {
  if (!results[name]) results[name] = run(createBandOnsets(), SCENARIOS[name](), {gate: gate()});
  return results[name];
}

for (const name of ['steady120', 'tempoChange', 'silenceGap', 'quiet', 'syncopated']) {
  test(`per-band onsets land on their own part: ${name}`, () => {
    const r = resultFor(name);
    for (let b = 0; b < 4; b++) {
      const s = score(r.events, r.onsets, b, {skipFirstMs: 1200});
      const label = `${name} ${BANDS[b]} ${JSON.stringify(s)}`;
      // Recall: kicks 312 ms apart in the syncopated groove phase-cancel
      // (documented), bass under a quiet mix sits near the hiss floor.
      const recall = name === 'syncopated' && b === 0 ? 0.6 : b === 1 ? 0.8 : 0.9;
      assert.ok(s.hits >= Math.floor(s.truth * recall), 'recall ' + label);
      assert.ok(s.medianAbsMs < 30, 'median timing ' + label);
      const fpCap = b === 0 ? (name === 'syncopated' ? 0.8 : 0.1) : b === 1 ? 0.5 : b === 2 ? 0.25 : 0.05;
      assert.ok(s.falsePositives <= Math.ceil(s.truth * fpCap), 'false positives ' + label);
    }
  });
}

test('per-band beats beat the legacy detector on false hits and timing', () => {
  const sc = SCENARIOS.steady120();
  const legacy = run(createLegacyDetector(), sc, {gate: gate()});
  const next = resultFor('steady120');
  let fpOld = 0, fpNew = 0;
  for (let b = 0; b < 4; b++) {
    const o = score(legacy.events, legacy.beats, b, {skipFirstMs: 1200});
    const n = score(next.events, next.beats, b, {skipFirstMs: 1200});
    fpOld += o.falsePositives; fpNew += n.falsePositives;
    assert.ok(n.hits >= o.hits, BANDS[b] + ' keeps every hit legacy found');
  }
  assert.ok(fpNew * 4 <= fpOld, `false beats ${fpNew} vs legacy ${fpOld}`);
  // Locked kick and hat grids emit on time, not a frame late.
  for (const b of [0, 3]) {
    const n = score(next.events, next.beats, b, {skipFirstMs: 4000});
    assert.ok(Math.abs(n.medianSignedMs) < 15, BANDS[b] + ' beat lag ' + n.medianSignedMs);
  }
});

test('silence: no beats in the gap, at most one bridged beat, tiers fall back after 3 s', () => {
  const sc = SCENARIOS.silenceGap();
  const show = createSilhouetteShow();
  const det = createBandOnsets();
  const wrap = {process(bytes, sr, fft, now, open, sens) {
    const out = det.process(bytes, sr, fft, now, open, sens);
    if (out.beats) show.beat(now, out.beats, {period: out.period});
    if (Math.abs(now - 10400) < 20) {
      // >3 s after the music stopped (6.0 s), before it returns (11 s).
      for (let b = 0; b < 4; b++) {
        const c = show.bandClock(b);
        const lastAny = Math.max(...[0, 1, 2, 3].map(k => show.bandClock(k).at));
        const clock = dancerMotionClock(now, c, {at: lastAny, interval: 520, index: 0, strikeAt: lastAny});
        assert.equal(clock.tier, 'idle', 'band ' + b + ' idles at 100 BPM after 3 s of silence');
      }
    }
    return out;
  }};
  const r = run(wrap, sc, {gate: gate()});
  const gapBeats = r.beats.filter(e => e.t > 6300 && e.t < 11000);
  // Music ends at 6.0 s (last hits ~5.9 s, ringing to ~6.3 s); one bridged
  // grid beat per band is allowed right after, nothing later in the gap.
  assert.ok(gapBeats.every(e => e.t < 6000 + 1.6 * 540), 'late gap beats ' + JSON.stringify(gapBeats));
  assert.ok(gapBeats.length <= 4, 'at most one bridged beat per band');
  // Music returns at 11 s: every band dances again within 1.5 s.
  for (let b = 0; b < 4; b++) {
    const first = r.beats.find(e => e.band === b && e.t >= 11000);
    assert.ok(first && first.t < 12500, BANDS[b] + ' resumes after the gap');
  }
  assert.ok(BEAT_FRESH_MS === 3000);
});

test('reset clears every band: Listen toggle starts clean', () => {
  const det = createBandOnsets();
  resultFor('steady120');
  const sc = SCENARIOS.steady120();
  run(det, sc, {gate: gate()});
  assert.ok(det.snapshot().some(b => b.period > 0));
  det.reset();
  assert.ok(det.snapshot().every(b => b.period === 0 && !b.locked));
  // First frames after a reset never fire (priming + warm-up).
  const an = createAnalyser(2048);
  const audio = render(sc.events, 2, {pad: sc.pad});
  let fired = 0;
  for (let i = 0; i < 6; i++) fired |= det.process(an.at(audio, Math.floor((0.52 + i / 30) * SR)), SR, 2048, 520 + i * 33, true, [1, 1, 1, 1]).beats;
  assert.equal(fired, 0);
});

test('a zeroed band slider mutes that band only', () => {
  const r = run(createBandOnsets(), SCENARIOS.steady120(), {gate: gate(), sens: [1, 0, 1, 1]});
  assert.equal(r.beats.filter(e => e.band === 1).length, 0);
  assert.ok(r.beats.filter(e => e.band === 0).length > 20);
});

test('per-frame cost stays tiny (no frame-budget regressions)', () => {
  const det = createBandOnsets();
  const bytes = new Uint8Array(1024);
  let seed = 1;
  const t0 = performance.now();
  const N = 6000;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < bytes.length; k += 7) { seed = (seed * 1103515245 + 12345) >>> 0; bytes[k] = seed >>> 25; }
    det.process(bytes, 48000, 2048, i * 33.3, true, [1, 1, 1, 1]);
  }
  const per = (performance.now() - t0) / N;
  assert.ok(per < 0.25, 'ms per frame ' + per.toFixed(4));
});

test('room-lab wires per-band Listen safely', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /import \{createBandOnsets[^}]*\} from '\.\/src\/band-onsets\.js'/);
  // Toggle fully resets: every mic state change resets the detector.
  assert.match(src, /function applyMicState\([^)]*\)\{[^\n]*agcReset\(\);if\(bandOnsets\)bandOnsets\.reset\(\);/);
  // Legacy escape hatch and automatic fallback on any error.
  assert.match(src, /listen=legacy/);
  assert.match(src, /catch\{bandOnsets=null;bandHits=0;bandInfo=null;\}/);
  // The detector only reads the existing analyser: still one mic analyser,
  // and the frame path never touches the stream or its tracks.
  assert.equal((src.match(/ac\.createAnalyser\(\)/g) || []).length, 1);
  const frame = src.slice(src.indexOf('function frame('), src.indexOf('function projectorLayout('));
  assert.doesNotMatch(frame, /getUserMedia|releaseMicHardware|\.stop\(\)|createMediaStreamSource/);
  assert.match(frame, /api\.nd_hit\(k\)/);
});

test('silhouette band clocks use tracked periods and their own envelopes', () => {
  const show = createSilhouetteShow();
  show.beat(1000, 0b0001, {period: new Float32Array([500, 0, 0, 0])});
  show.beat(1100, 0b0001, {period: new Float32Array([500, 0, 0, 0])}); // ghost 100 ms later
  assert.equal(show.bandClock(0).interval, 500);
  show.beat(1200, 0b1000);
  // Kick strings have decayed toward their own beat; hat strings just pulsed.
  assert.ok(show.bandEnvelope(3, 1210) > 0.9);
  assert.ok(show.bandEnvelope(0, 1210) < show.bandEnvelope(3, 1210));
  // No band beat yet: a band falls back to the shared envelope.
  assert.equal(show.bandEnvelope(2, 1210), show.envelope(1210));
});
