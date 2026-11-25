// Global tempo stability on the nd-listen-corpus-v1 corpus (TJ 7:43 PM).
// before = live debug BPM (60000 / gap between successive Listen beats, any band)
// after  = createGlobalTempo lock.
import {readFileSync} from 'node:fs';
import {readWav} from '../tests/helpers/listen-corpus.mjs';
import {createAnalyser, frameTimes} from '../tests/helpers/listen-sim.mjs';
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {createGlobalTempo, tempoRelation} from '../neural-dance/src/global-tempo.js';
import '../neural-dance/silence-gate.js';

const dir = new URL('../tests/fixtures/listen-corpus/', import.meta.url);
export function truthBpm(label) {
  const b = label.beats || [];
  const g = []; for (let i = 1; i < b.length; i++) g.push(b[i] - b[i - 1]);
  g.sort((a, c) => a - c);
  const med = g.length ? g[g.length >> 1] : 0;
  return med > 0 ? 60 / med : 0;
}
function std(a) { if (a.length < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); }

export async function tempoRun(label, {fftSize = 2048} = {}) {
  const {samples, sampleRate} = await readWav(new URL(label.wav, dir).pathname);
  const dur = samples.length / sampleRate;
  const an = createAnalyser(fftSize);
  const det = createBandOnsets(), gt = createGlobalTempo();
  const lib = globalThis.ndSilenceGate, gate = lib.create();
  let last = 0, lastBeat = -1;
  const before = [], after = [], cost = [];
  for (const now of frameTimes(dur * 1000)) {
    const bytes = an.at(samples, Math.floor(now / 1000 * sampleRate));
    lib.scale(gate, lib.bandPeaks(bytes, sampleRate, fftSize), Math.max(0.001, (now - last) / 1000)); last = now;
    const info = det.process(bytes, sampleRate, fftSize, now, gate.open, [1, 1, 1, 1]);
    if (info.beats) { if (lastBeat > 0) before.push({t: now, bpm: 60000 / Math.min(1400, Math.max(180, now - lastBeat))}); lastBeat = now; }
    const c0 = performance.now();
    const o = gt.process(now, info.flux, gate.open, info);
    cost.push(performance.now() - c0);
    after.push({t: now, bpm: o.locked ? o.bpm : 0});
  }
  return {before, after, snap: gt.snapshot(), dur, costMs: cost.reduce((a, b) => a + b, 0) / cost.length, maxCostMs: Math.max(...cost)};
}

export function summarize(label, r) {
  const truth = truthBpm(label);
  const from = 5000;
  const b = r.before.filter(s => s.t > from).map(s => s.bpm);
  const locked = r.after.filter(s => s.bpm > 0);
  const firstLock = locked.length ? locked[0].t : NaN;
  const a = r.after.filter(s => s.t > from && s.bpm > 0).map(s => s.bpm);
  const final = locked.length ? locked[locked.length - 1].bpm : 0;
  const rel = tempoRelation(final, truth, 0.06);
  return {id: label.id, truth: Math.round(truth * 10) / 10, beforeStd: +std(b).toFixed(1), beforeRange: b.length ? Math.round(Math.min(...b)) + '-' + Math.round(Math.max(...b)) : '-',
    after: Math.round(final * 10) / 10, rel: rel === 1 ? 'exact' : rel ? 'x' + (+rel.toFixed(2)) : 'wrong', lockS: Number.isFinite(firstLock) ? +(firstLock / 1000).toFixed(1) : null,
    afterStd: +std(a).toFixed(2), lockedShare: +(a.length / Math.max(1, r.after.filter(s => s.t > from).length)).toFixed(2), costMs: +r.costMs.toFixed(3)};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const man = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const rows = [];
  for (const c of man.clips) {
    const label = JSON.parse(readFileSync(new URL(c.json || c.wav.replace(/\.wav$/i, '.json'), dir), 'utf8'));
    if (process.argv[2] && !label.id.includes(process.argv[2])) continue;
    rows.push(summarize(label, await tempoRun(label)));
  }
  console.table(rows);
}
