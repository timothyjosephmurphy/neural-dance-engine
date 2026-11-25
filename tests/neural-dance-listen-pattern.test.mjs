// Listen v2 pattern learning (flagged ?listen=pattern): meters, anticipation,
// breaks, cross-band tempo coupling, wiring and cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PATTERNS, runPattern, downbeatScore} from './helpers/pattern-grooves.mjs';
import {score} from './helpers/listen-sim.mjs';
import {createListenPattern, createCoupler, snapRatio, bandLabel, RATIOS} from '../neural-dance/src/listen-pattern.js';

const SETTLE = 8000;
const cache = {};
function get(name, withPattern = true) {
  const key = name + withPattern;
  if (!cache[key]) cache[key] = {sc: PATTERNS[name](), r: null};
  if (!cache[key].r) cache[key].r = runPattern(cache[key].sc, {withPattern});
  return cache[key];
}
function lateMeter(r) {
  const late = r.meters.filter(m => m.t > SETTLE);
  const counts = {};
  for (const m of late) counts[m.meter] = (counts[m.meter] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
function timing(sc, r) {
  const truth = sc.events.map(e => ({band: e.band, t: e.t}));
  let hits = 0, n = 0, fp = 0; const med = [];
  for (let b = 0; b < 4; b++) {
    const s = score(truth, r.beats, b, {from: SETTLE});
    hits += s.hits; n += s.truth; fp += s.falsePositives;
    if (Number.isFinite(s.medianSignedMs)) med.push(s.medianSignedMs);
  }
  med.sort((a, b) => a - b);
  return {recall: hits / n, fp, signed: med[med.length >> 1]};
}

test('learns odd, additive, compound and swung meters', () => {
  const want = {four4: '4/4', three4: '3/4', five4: '5/4', six8: '6/8', seven8_322: '7/8 (3+2+2)', eight8_332: '8/8 (3+3+2)', swing21: '4/4 swing', movingAccent: '4/4'};
  for (const [name, label] of Object.entries(want)) {
    const {r} = get(name);
    assert.equal(lateMeter(r), label, name);
  }
});

test('predicted hits land on time and do not add false hits', () => {
  for (const name of ['four4', 'three4', 'seven8_322', 'eight8_332', 'swing21', 'movingAccent']) {
    const {sc, r} = get(name);
    const base = timing(sc, get(name, false).r), pat = timing(sc, r);
    const late = r.beats.filter(e => e.t > SETTLE).length;
    const pred = r.predicted.filter(e => e.t > SETTLE).length;
    assert.ok(pred / late > 0.5, name + ' anticipates most hits: ' + (pred / late).toFixed(2));
    assert.ok(Math.abs(pat.signed) <= 12, name + ' median signed error ' + pat.signed);
    assert.ok(Math.abs(pat.signed) <= Math.abs(base.signed) + 3, name + ' no later than per-band');
    assert.ok(pat.recall >= base.recall - 0.03, name + ' recall');
    assert.ok(pat.fp <= base.fp + 6, name + ' false hits ' + pat.fp + ' vs ' + base.fp);
  }
});

test('downbeats are found for regular and additive meters', () => {
  for (const name of ['four4', 'three4', 'seven8_322', 'eight8_332']) {
    const {sc, r} = get(name);
    const db = downbeatScore(r.downbeatGuesses, sc.downbeats, {from: SETTLE});
    assert.ok(db.f >= 0.6, name + ' downbeat F ' + db.f.toFixed(2));
  }
});

test('breaks fall back to per-band beats, then the groove is picked up again', () => {
  const {sc, r} = get('break');
  const [a, b] = sc.silence.map(s => s * 1000);
  assert.ok(r.beats.filter(e => e.t > a + 400 && e.t < b).length <= 2, 'quiet during the break');
  assert.ok(r.predicted.filter(e => e.t > b + 6000).length > 10, 'anticipating again after the break');
  // Drift: the grid follows a 104 -> 124 BPM ramp without losing the meter.
  assert.equal(lateMeter(get('drift').r), '4/4');
});

test('reset clears every learned state', () => {
  const {r} = get('four4');
  const p = r.pattern;
  assert.ok(p.snapshot().cycle > 0);
  p.reset();
  const s = p.snapshot();
  assert.equal(s.cycle, 0); assert.equal(s.meter, ''); assert.equal(s.active, false); assert.equal(s.tatumMs, 0);
  assert.deepEqual(Array.from(p.state.ratio), [0, 0, 0, 0]);
});

test('band tempos snap to simple ratios of the shared beat', () => {
  assert.deepEqual(RATIOS, [1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3, 4]);
  assert.equal(snapRatio(500, 500), 1);
  assert.equal(snapRatio(500, 1000), 1 / 2);   // bass 60 vs beat 120
  assert.equal(snapRatio(500, 250), 2);        // hat 240
  assert.equal(snapRatio(500, 333), 3 / 2);    // triplet feel
  assert.equal(snapRatio(500, 168), 3);
  assert.equal(snapRatio(500, 410), 0);        // 1.22: no simple ratio
  const c = createCoupler();
  const out = {ratio: new Float64Array(4), free: [false, false, false, false], period: new Float32Array(4)};
  const per = new Float32Array([505, 990, 252, 410]);
  let t = 0;
  for (; t < 1000; t += 16) c.update(per, t, 500, out);
  assert.deepEqual(Array.from(out.ratio), [1, 0.5, 2, 0]);
  assert.deepEqual(Array.from(out.period), [500, 1000, 250, 410], 'snapped periods are exact fractions');
  assert.equal(out.free[3], true);
  // Brief disagreement stays snapped; strong sustained disagreement frees it.
  per[0] = 640;
  for (const end = t + 300; t < end; t += 16) c.update(per, t, 500, out);
  assert.equal(out.ratio[0], 1, 'brief wobble stays snapped');
  for (const end = t + 3000; t < end; t += 16) c.update(per, t, 500, out);
  assert.equal(out.ratio[0], 0, 'drifts free'); assert.equal(out.free[0], true);
  per[0] = 498;
  c.update(per, t, 500, out);
  assert.equal(out.ratio[0], 1, 'snaps back as soon as it agrees');
  // Live run: hats double the beat, kick on it or at half.
  const late = get('four4').r.meters.filter(m => m.t > SETTLE && m.active);
  const share = (b, ok) => late.filter(m => ok.includes(m.ratio[b])).length / late.length;
  assert.ok(share(3, [2]) > 0.8, 'hat x2 ' + share(3, [2]).toFixed(2));
  assert.ok(share(0, [0.5, 1]) > 0.8, 'kick on the beat or half ' + share(0, [0.5, 1]).toFixed(2));
  const snapped = late.filter(m => m.ratio.filter(r => r > 0).length >= 3).length / late.length;
  assert.ok(snapped > 0.7, 'most of the time bands share the pulse ' + snapped.toFixed(2));
});

test('inset label text shows meter, BPM and ratio', async () => {
  const {tempoReadout, createSilhouetteShow} = await import('../neural-dance/src/silhouette.js');
  assert.equal(tempoReadout({band: 3, tier: 'band', locked: true, period: 250, ratio: '2'}), 'High \u00b7 240 BPM (\u00d72)');
  assert.equal(tempoReadout({band: 0, tier: 'band', locked: true, period: 484, ratio: '1', meter: '7/8 (3+2+2)'}), 'Kick \u00b7 124 BPM \u00b7 7/8 (3+2+2)');
  assert.equal(tempoReadout({band: 1, tier: 'band', locked: true, period: 1000, ratio: '\u00bd', meter: '4/4 swing'}), 'Bass \u00b7 60 BPM (\u00d7\u00bd) \u00b7 4/4 swing');
  assert.equal(tempoReadout({band: 2, tier: 'band', locked: true, period: 500, meter: '<b>'}), 'Mid \u00b7 120 BPM');
  const show = createSilhouetteShow();
  assert.equal(show.setBandRatio(3, '2'), '2');
  assert.equal(show.bandTempo(3, 0).ratio, '2');
  const state = {meter: '7/8 (3+2+2)', bandBpm: [124, 62, 124, 248], ratio: [1, 0.5, 1, 2], free: [false, false, false, false]};
  assert.equal(bandLabel(state, 0), '7/8 (3+2+2) \u00b7 124 BPM');
  assert.equal(bandLabel(state, 1), '62 BPM (\u00d7\u00bd)');
  assert.equal(bandLabel(state, 3), '248 BPM (\u00d72)');
  assert.equal(bandLabel({meter: '', bandBpm: [0, 0, 0, 0], ratio: [0, 0, 0, 0]}, 2), '');
});

test('pattern layer is cheap per frame', () => {
  for (const name of ['four4', 'seven8_322', 'swing21']) assert.ok(get(name).r.costMs < 0.15, name + ' ' + get(name).r.costMs);
});

test('room-lab: pattern layer is on by default, with per-band/legacy opt-outs and safe fallback', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /import \{createListenPattern, createCoupler, bandLabel, ratioText\} from '\.\/src\/listen-pattern\.js'/);
  assert.match(src, /listen=pattern/);
  assert.match(src, /listen=\(perband\|per-band\|legacy\)/);
  assert.match(src, /localStorage\.getItem\('nd\.listen\.pattern'\)!=='0'/);
  assert.match(src, /if\(bandOnsets&&listenPatternOn\(\)\)listenPattern=createListenPattern\(\)/);
  assert.match(src, /function applyMicState\([^)]*\)\{[^\n]*if\(bandOnsets\)bandOnsets\.reset\(\);if\(listenPattern\)\{listenPattern\.reset\(\);patternLabels\(null\);\}patternState=null;/);
  assert.match(src, /catch\{patternOff\(\);\}/);
  assert.match(src, /listenTiming\(\)\{[^\n]*\.\.\.listenPatternTiming\(\)/);
  assert.match(src, /function listenPatternTiming\(\)\{[^\n]*meter:pat\?pat\.meter:''[^\n]*ratio:pat\?pat\.ratio:null/);
  assert.match(src, /silhouetteShow\.setBandRatio\(b,/);
});

test('fresh pattern layer passes per-band beats straight through', () => {
  const p = createListenPattern();
  const info = {onsets: 0b0101, beats: 0b0101, onsetTime: new Float64Array([1000, 0, 1000, 0]), flux: new Float32Array(4).fill(5), threshold: new Float32Array(4).fill(2), period: new Float32Array(4)};
  assert.equal(p.process(info, 1010, [1, 1, 1, 1]).beats, 0b0101);
  assert.equal(p.process(info, 1030, [1, 0, 0, 1]).beats, 0b0001, 'muted band stays muted');
});

test('corpus (nd-listen-corpus-v1): meter, downbeats, kick beats vs per-band baseline', async () => {
  const {readWav, runDetectorOnAudio, evaluateClip, resultRow} = await import('./helpers/listen-corpus.mjs');
  const {createDetector} = await import('../scripts/listen-pattern-detector.mjs');
  await import('../neural-dance/silence-gate.js');
  const dir = new URL('./fixtures/listen-corpus/', import.meta.url);
  const man = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const rows = [];
  for (const c of man.clips) {
    const label = JSON.parse(readFileSync(new URL(c.json || c.wav.replace(/\.wav$/i, '.json'), dir), 'utf8'));
    const {samples, sampleRate} = await readWav(new URL(c.wav, dir).pathname);
    const det = createDetector();
    const res = runDetectorOnAudio(det, samples, sampleRate, {gate: {lib: globalThis.ndSilenceGate, state: globalThis.ndSilenceGate.create()}});
    rows.push(resultRow(evaluateClip(label, res), 'pattern'));
  }
  const reported = rows.filter(r => r.meterOk != null);
  const meterAcc = reported.filter(r => r.meterOk).length / reported.length;
  const mean = k => { const v = rows.map(r => r[k]).filter(x => x != null); return v.reduce((a, b) => a + b, 0) / v.length; };
  assert.ok(reported.length >= 18, 'meter reported on ' + reported.length + ' clips');
  assert.ok(meterAcc >= 0.75, 'meter accuracy ' + meterAcc.toFixed(3));
  assert.ok(mean('downF') >= 0.28, 'downbeat F ' + mean('downF').toFixed(3));
  assert.ok(mean('kickBeatF') >= 0.81, 'kick beat F ' + mean('kickBeatF').toFixed(3) + ' (per-band baseline 0.826)');
  assert.ok(mean('beatF') >= 0.495, 'all-band beat F ' + mean('beatF').toFixed(3) + ' (per-band baseline 0.485)');
});
