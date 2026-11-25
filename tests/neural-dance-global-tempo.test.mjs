// Global song tempo (TJ 7:43 PM): fast, stable lock; per-band ratios; confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGlobalTempo, createBandAgreement, tempoRelation} from '../neural-dance/src/global-tempo.js';
import {createCoupler} from '../neural-dance/src/listen-pattern.js';
import {tempoRun, summarize} from '../scripts/listen-tempo-report.mjs';
import {listenSummary, tempoNote} from '../neural-dance/debug-viewer.js';

const dir = new URL('./fixtures/listen-corpus/', import.meta.url);
const man = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const labels = man.clips.map(c => JSON.parse(readFileSync(new URL(c.json || c.wav.replace(/\.wav$/i, '.json'), dir), 'utf8')));

// Drive with synthetic flux impulses (no audio): hits at given times per band.
function drive(hits, durMs, {frame = 16.7, jitter = 4, seed = 1} = {}) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const gt = createGlobalTempo();
  const flux = new Float32Array(4);
  const info = {onsets: 0, onsetTime: new Float64Array(4)};
  const shown = [];
  const idx = hits.map(() => 0);
  for (let now = 0; now < durMs; now += frame + (rnd() - 0.5) * jitter) {
    flux.fill(0.3); info.onsets = 0;
    for (let b = 0; b < hits.length; b++) {
      while (idx[b] < hits[b].length && hits[b][idx[b]] <= now) { flux[b] = 8; info.onsets |= 1 << b; info.onsetTime[b] = hits[b][idx[b]]; idx[b]++; }
    }
    const o = gt.process(now, flux, true, info);
    shown.push({t: now, bpm: o.locked ? o.bpm : 0});
  }
  return {gt, shown};
}

test('corpus: locks the song tempo in ~3-5 s and holds it steady', async () => {
  const rows = [];
  for (const label of labels) rows.push(summarize(label, await tempoRun(label)));
  const right = rows.filter(r => r.rel !== 'wrong');
  assert.ok(right.length >= rows.length - 1, 'tempo right up to half/double/2:3 on ' + right.length + '/' + rows.length);
  const exact = rows.filter(r => r.rel === 'exact').length;
  assert.ok(exact >= 17, 'exact tempo on ' + exact + '/' + rows.length);
  const lock = rows.map(r => r.lockS).filter(v => v != null).sort((a, b) => a - b);
  assert.equal(lock.length, rows.length, 'every clip locks');
  assert.ok(lock[lock.length >> 1] <= 4, 'median time to lock ' + lock[lock.length >> 1] + ' s');
  for (const r of rows) {
    assert.ok(r.lockS <= 7, r.id + ' locks by 7 s (' + r.lockS + ')');
    if (!/drift|tempo-change/.test(r.id)) assert.ok(r.afterStd < 1.5, r.id + ' std ' + r.afterStd);
    assert.ok(r.afterStd < r.beforeStd / 5, r.id + ' much steadier than before (' + r.beforeStd + ' -> ' + r.afterStd + ')');
    assert.ok(r.costMs < 0.3, r.id + ' cost ' + r.costMs);
  }
  const step = rows.find(r => r.id.includes('tempo-change'));
  assert.ok(Math.abs(step.after - 128) < 3, 'follows a real tempo change to 128 (' + step.after + ')');
});

test('irregular kick hits (TJ 7:43 PM screenshot) do not swing the BPM', () => {
  // ~138 BPM song where the kick misses beats and adds off-beat hits.
  const P = 60000 / 138, kick = [], mid = [], hat = [];
  let r = 7; const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 500; t < 40000; t += P) {
    if (rnd() < 0.7) kick.push(t + (rnd() - 0.5) * 30);
    if (rnd() < 0.25) kick.push(t + P / 2 + (rnd() - 0.5) * 30);   // syncopated extra
    if (rnd() < 0.5) mid.push(t + P * (rnd() < 0.5 ? 1 : 0) + (rnd() - 0.5) * 30);
    hat.push(t + (rnd() - 0.5) * 20); if (rnd() < 0.6) hat.push(t + P / 2 + (rnd() - 0.5) * 20);
  }
  const {gt, shown} = drive([kick.sort((a, b) => a - b), [], mid.sort((a, b) => a - b), hat.sort((a, b) => a - b)], 40000);
  const s = gt.snapshot();
  assert.ok(s.locked, 'locked');
  assert.ok(tempoRelation(s.bpm, 138, 0.04) === 1, 'tempo ' + s.bpm);
  assert.ok(s.timeToLockMs > 0 && s.timeToLockMs <= 5000, 'lock time ' + s.timeToLockMs);
  const late = shown.filter(x => x.t > 8000).map(x => x.bpm);
  assert.ok(late.every(v => Math.abs(v - 138) < 4), 'steady after lock: ' + Math.min(...late).toFixed(1) + '-' + Math.max(...late).toFixed(1));
  assert.ok(s.std10 < 1, 'std over 10 s ' + s.std10);
});

test('hysteresis: a brief fill does not move the lock; a sustained change does', () => {
  const beats = (from, to, bpm) => { const o = []; for (let t = from; t < to; t += 60000 / bpm) o.push(t); return o; };
  // 120 BPM, a 2 s burst at 150, back to 120.
  const k1 = beats(300, 12000, 120).concat(beats(12000, 14000, 150), beats(14000, 24000, 120));
  const a = drive([k1, [], k1.filter((_, i) => i % 2), []], 24000);
  const during = a.shown.filter(x => x.t > 12000 && x.t < 16000).map(x => x.bpm);
  assert.ok(during.every(v => Math.abs(v - 120) < 3), 'fill ignored ' + Math.min(...during) + '-' + Math.max(...during));
  // Real change 120 -> 100 for 12 s: relocks within ~4-7 s.
  const k2 = beats(300, 12000, 120).concat(beats(12000, 30000, 100));
  const b = drive([k2, [], [], []], 30000);
  const at = b.shown.find(x => x.t > 12000 && Math.abs(x.bpm - 100) < 3);
  assert.ok(at && at.t - 12000 <= 9000, 'relocked to 100 after ' + (at ? Math.round(at.t - 12000) : 'never') + ' ms');
  // Double-time hats alone do not flip the lock to 240.
  const k3 = beats(300, 20000, 120), h3 = beats(300, 20000, 240);
  const c = drive([k3.filter((_, i) => i < 20), [], [], h3], 20000);
  assert.ok(tempoRelation(c.gt.snapshot().bpm, 120, 0.05), 'still the song tempo family: ' + c.gt.snapshot().bpm);
});

test('band confidence rises when band hits agree with the shared beat', () => {
  const agree = createBandAgreement(), coupler = createCoupler();
  const gt = {locked: true, period: 500, next: 10000};
  const out = {ratio: new Float64Array(4), free: [false, false, false, false], period: new Float32Array(4)};
  coupler.update(new Float32Array([500, 1000, 250, 410]), 0, 500, out);
  const info = {onsets: 0, onsetTime: new Float64Array(4)};
  for (let i = 0; i < 20; i++) {
    info.onsets = 0b1101; info.onsetTime[0] = 10000 + i * 500; info.onsetTime[2] = 10250 + i * 500; info.onsetTime[3] = 10000 + i * 250 + 120;
    agree.update(info, gt, out.ratio);
  }
  assert.ok(agree.conf[0] > 0.9, 'kick on the beat ' + agree.conf[0]);
  assert.ok(agree.conf[2] > 0.9, 'mid on the half beat (x2 grid) ' + agree.conf[2]);
  assert.ok(agree.conf[3] < 0.2, 'hat off the grid ' + agree.conf[3]);
  agree.reset(); assert.equal(agree.conf[0], 0);
});

test('reset clears the lock; silence holds it, even long silence (soak Nov 9)', () => {
  const beats = []; for (let t = 300; t < 10000; t += 500) beats.push(t);
  const {gt} = drive([beats, [], [], []], 10000);
  assert.ok(gt.snapshot().locked);
  const flux = new Float32Array(4);
  for (let now = 10000; now < 14000; now += 16.7) gt.process(now, flux, false, null);
  assert.ok(gt.snapshot().locked && gt.snapshot().held, 'held through a 4 s break');
  for (let now = 14000; now < 26000; now += 16.7) gt.process(now, flux, false, null);
  assert.ok(gt.snapshot().locked && gt.snapshot().held, 'still held after 16 s of silence');
  assert.ok(Math.abs(gt.snapshot().bpm - 120) < 1.5);
  gt.reset(); assert.deepEqual(gt.snapshot(), {bpm: 0, locked: false, held: false, estimate: 0, conf: 0, timeToLockMs: 0, std10: 0, candidate: 0});
});

// Music, 15 s of true silence (open=false, zero flux), then music again.
function silenceRun(resumeBeatMs, {resumeMs = 30000, seed = 3} = {}) {
  let r = seed; const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const gt = createGlobalTempo(), flux = new Float32Array(4), info = {onsets: 0, onsetTime: new Float64Array(4)};
  const shown = []; let next = 300;
  for (let now = 0; now < 25000 + resumeMs; now += 16.7 + (rnd() - 0.5) * 4) {
    const silent = now >= 10000 && now < 25000;
    info.onsets = 0;
    if (silent) { flux.fill(0); if (next < 25000) next = 25000 + 37; }
    else {
      flux.fill(0.3);
      if (now >= next) { flux[0] = 8; info.onsets = 1; info.onsetTime[0] = next; next += now < 10000 ? 500 : resumeBeatMs; }
    }
    const o = gt.process(now, flux, !silent, info);
    shown.push({t: now, bpm: o.locked ? o.bpm : 0});
  }
  return shown;
}

test('silence then the same song: tempo held with no jumps on resume', () => {
  const shown = silenceRun(500).filter(s => s.t > 6000);
  for (const s of shown) assert.ok(s.bpm > 0 && Math.abs(s.bpm - 120) < 4, 'bpm ' + s.bpm + ' at ' + Math.round(s.t));
});

test('silence then a new song: holds the old tempo, then re-confirms the new one, never garbage', () => {
  const shown = silenceRun(400).filter(s => s.t > 6000);
  for (const s of shown) assert.ok(Math.abs(s.bpm - 120) < 4 || Math.abs(s.bpm - 150) < 4, 'bpm ' + s.bpm + ' at ' + Math.round(s.t));
  const first150 = shown.find(s => Math.abs(s.bpm - 150) < 4);
  assert.ok(first150, 'moves to the new song tempo');
  assert.ok(first150.t >= 25000 + 4000, 'only after re-confirmation (' + Math.round(first150.t - 25000) + ' ms)');
  assert.ok(Math.abs(shown[shown.length - 1].bpm - 150) < 3);
});

test('debug panel shows tempo lock, coupled ratio and band conf', () => {
  assert.equal(tempoNote({locked: true, timeToLockMs: 3400, std10: 0.31}), 'locked in 3.4 s \u00b7 \u03c310s 0.3');
  assert.equal(tempoNote({locked: false, estimate: 121.4}), 'tempo searching (~121)');
  const s = listenSummary({detector: 'pattern', bpm: 122, tempo: {locked: true, timeToLockMs: 3000, std10: 0.2},
    bands: [{conf: 0}, {}, {}, {}], coupled: [{ratio: '1', conf: 0.82, locked: true}, {}, {}, {ratio: '2', conf: 0.4, locked: false}],
    tiers: [{tier: 'band', bpm: 122}, {}, {}, {}], beats: [105, 0, 0, 0]});
  assert.match(s.head, /122 BPM · locked in 3\.0 s/);
  assert.match(s.bands[0], /Kick · band · 122 BPM · locked · ×1 · conf 0\.82 · beats 105/);
  assert.match(s.bands[3], /×2 · conf 0\.4/);
});

test('room-lab: global tempo on the default path, safe fallback, envelope feed only for viewers', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /import \{createGlobalTempo, createBandAgreement\} from '\.\/src\/global-tempo\.js'/);
  assert.match(src, /try\{if\(bandOnsets\)globalTempo=createGlobalTempo\(\);\}catch\{globalTempo=null;\}/);
  assert.match(src, /catch\{globalTempo=null;gtState=null;\}/);
  assert.match(src, /patternState=null;tempoReset\(\);/);
  assert.match(src, /if\(envFeedUntil>now\)\{envRing\.push/);
  assert.match(src, /function envTake\(\)\{envFeedUntil=performance\.now\(\)\+1500;/);
  assert.match(src, /bpm:gtState&&gtState\.locked\?Math\.round\(gtState\.bpm\):globalTempo\?/);
  const show = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(show, /if \(show\.globalTempoMs > 0\) show\.interval = show\.globalTempoMs;/);
});
