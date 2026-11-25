// Offline groove-learning eval on cached chain dumps (scripts/groove-chain-dump.mjs).
// Scores downbeats (F at 70 ms), bar-position accuracy, lock-in time, meter,
// confidence-gated accuracy, against the entrain baseline (barBeat 0).
//   node scripts/groove-eval.mjs <cache-dir> [--json=out.json] [--trace=id,id] [--filter=re]
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createGrooveLearner} from '../neural-dance/src/groove-learn.js';

const TOL = 70;
export function replay(clip, opts = {}) {
  const g = createGrooveLearner({clock: () => performance.now()});
  const onT = new Float64Array(4), str = new Float64Array(4);
  const downs = [], baseDowns = [], trace = [], bars = []; const shiftStats = {};
  let activeFrames = 0, frames = 0;
  for (const f of clip.frames) {
    let k = 0;
    for (let b = 0; b < 4; b++) if (f.on & (1 << b)) { onT[b] = f.ot[k]; str[b] = f.w[k]; k++; }
    const ref = f.P > 0 ? [f.P, f.A] : opts.entrainOnly ? [0, 0] : [f.gP || 0, f.gN || 0];
    const o = g.step(f.t, {P: ref[0], anchor: ref[1], gateOpen: !!f.g, onsets: f.on, onsetTime: onT, strength: str});
    const st = g.internals;
    if (o.downbeat) downs.push({t: o.downbeatAt, active: o.active, conf: o.confidence, shift: o.clockShift});
    if (f.dn) baseDowns.push({t: f.A + Math.round((f.t - f.A) / f.P) * f.P});
    frames++; if (o.active) activeFrames++;
    if (o.active && f.P > 0 && clip.beats.length > 2) {
      // Does the groove's "clock is half a beat off" call match the truth beats?
      const g0 = f.A + Math.round((f.t - f.A) / f.P) * f.P;
      const bt = clip.beatsMs || (clip.beatsMs = clip.beats.map(x => x * 1000));
      let i = 1; while (i < bt.length && bt[i] < g0) i++;
      if (i < bt.length) {
        const x = ((g0 - bt[i - 1]) / (bt[i] - bt[i - 1])) % 1, d = Math.min(x, 1 - x);
        const truth = d < 0.15 ? 'on' : Math.abs(x - 0.5) < 0.15 ? 'half' : 'other';
        const claim = Math.abs(o.clockShift) > 0.3 ? 'half' : Math.abs(o.clockShift) < 0.2 ? 'on' : 'other';
        shiftStats[truth + '_' + claim] = (shiftStats[truth + '_' + claim] || 0) + 1;
      }
    }
    if (opts.trace) trace.push([f.t, o.active ? 1 : 0, o.confidence, o.beatInBar, o.bar, o.barInPhrase, o.phraseBars, o.meter, f.bb, o.fit, f.on, +(o.barPhase).toFixed(3)]);
  }
  return {downs, baseDowns, activeFrames, frames, snap: g.snapshot(), trace, shiftStats};
}

function match(truth, found) {
  const used = new Uint8Array(found.length); let hits = 0;
  const ok = new Uint8Array(found.length);
  for (const t of truth) {
    let best = -1, bd = TOL;
    for (let i = 0; i < found.length; i++) { if (used[i]) continue; const d = Math.abs(found[i] - t); if (d <= bd) { bd = d; best = i; } }
    if (best >= 0) { used[best] = 1; ok[best] = 1; hits++; }
  }
  return {hits, fp: found.length - hits, miss: truth.length - hits, ok};
}
const F = m => { const p = m.hits + m.fp ? m.hits / (m.hits + m.fp) : 0, r = m.hits + m.miss ? m.hits / (m.hits + m.miss) : 0; return p + r ? 2 * p * r / (p + r) : 0; };

export function evaluate(clip, res, altDown = null) {
  const skip = 1200;
  const truth = clip.downbeats.map(x => x * 1000).filter(t => t >= skip);
  const end = clip.frames[clip.frames.length - 1].t;
  const tr = truth.filter(t => t <= end - 200);
  const all = res.downs.map(d => d.t).filter(t => t >= skip);
  const act = res.downs.filter(d => d.active && d.t >= skip);
  const base = res.baseDowns.map(d => d.t).filter(t => t >= skip);
  const mAll = match(tr, all), mBase = match(tr, base);
  const mAct = match(tr, act.map(d => d.t));
  // Precision while active (the show only uses it then) and coverage.
  const precAct = act.length ? mAct.hits / act.length : null;
  const coverage = tr.length ? mAct.hits / tr.length : 0;
  // Lock-in: first active downbeat that starts a run of >= 4 correct active downbeats.
  const music0 = clip.beats.length ? clip.beats.find(b => b * 1000 >= 0) * 1000 : 0;
  let lock = null;
  for (let i = 0; i + 3 < act.length; i++) {
    let okRun = true;
    for (let j = i; j < i + 4; j++) if (!tr.some(t => Math.abs(t - act[j].t) <= TOL)) { okRun = false; break; }
    if (okRun) { lock = (act[i].t - music0) / 1000; break; }
  }
  // Baseline lock: first of 4 consecutive correct entrain downbeats.
  let baseLock = null;
  for (let i = 0; i + 3 < base.length; i++) {
    let okRun = true;
    for (let j = i; j < i + 4; j++) if (!tr.some(t => Math.abs(t - base[j]) <= TOL)) { okRun = false; break; }
    if (okRun) { baseLock = (base[i] - music0) / 1000; break; }
  }
  // Second half only (drift / steady state).
  const half = end / 2;
  const tr2 = tr.filter(t => t >= half);
  const m2 = match(tr2, act.filter(d => d.t >= half).map(d => d.t));
  const b2 = match(tr2, base.filter(t => t >= half));
  let altPrec = null, either = null;
  if (altDown) {
    const alt = altDown.map(x => x * 1000).filter(t => t >= skip && t <= end - 200);
    const ma = match(alt, act.map(d => d.t));
    altPrec = act.length ? +(ma.hits / act.length).toFixed(3) : null;
    either = act.length ? +(act.filter(d => tr.some(t => Math.abs(t - d.t) <= TOL) || alt.some(t => Math.abs(t - d.t) <= TOL)).length / act.length).toFixed(3) : null;
  }
  return {id: clip.id, meter: clip.meter, altPrec, either, shift: res.shiftStats, meterDet: res.snap.meter, downF: +F(mAll).toFixed(3), baseDownF: +F(mBase).toFixed(3),
    precActive: precAct == null ? null : +precAct.toFixed(3), coverage: +coverage.toFixed(3), lockS: lock == null ? null : +lock.toFixed(2), baseLockS: baseLock == null ? null : +baseLock.toFixed(2),
    secondHalfCov: tr2.length ? +(m2.hits / tr2.length).toFixed(3) : null, secondHalfBase: tr2.length ? +(b2.hits / tr2.length).toFixed(3) : null,
    activeShare: +(res.activeFrames / res.frames).toFixed(3), conf: res.snap.confidence, relearns: res.snap.relearns, halfTime: res.snap.halfTime, swing: res.snap.swing, phrase: res.snap.phraseBars,
    costMs: res.snap.costMsPerFrame};
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const dir = process.argv[2];
  const flt = (process.argv.find(a => a.startsWith('--filter=')) || '').slice(9);
  const jsonOut = (process.argv.find(a => a.startsWith('--json=')) || '').slice(7);
  const rows = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    if (flt && !new RegExp(flt).test(f)) continue;
    const clip = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
    let alt = null;
    const m = /^song-(.*?)(-phone)?(-crop\d)?$/.exec(clip.id);
    if (m) { try { const j = JSON.parse(readFileSync((process.env.ND_BT_RESULTS || 'bt-results') + `/song-${m[1]}.json`, 'utf8')); alt = (j.downbeats || []).map(x => x - (clip.crop || 0)).filter(x => x >= 0); } catch {} }
    rows.push(evaluate(clip, replay(clip), alt));
  }
  const cols = ['id', 'meter', 'meterDet', 'downF', 'baseDownF', 'precActive', 'coverage', 'lockS', 'baseLockS', 'secondHalfCov', 'secondHalfBase', 'activeShare', 'relearns', 'halfTime', 'swing', 'costMs'];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map(c => r[c]).join('\t'));
  const mean = (k, rs = rows) => { const v = rs.map(r => r[k]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null; };
  const med = (k, rs = rows) => { const v = rs.map(r => r[k]).filter(x => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const groups = {all: rows, '4/4': rows.filter(r => r.meter === '4/4'), songs: rows.filter(r => /^song-/.test(r.id)), gs: rows.filter(r => /^gs-/.test(r.id)), gsClean: rows.filter(r => /^gs-/.test(r.id) && !/phone/.test(r.id)), gsPhone: rows.filter(r => /^gs-.*phone/.test(r.id))};
  for (const [name, rs] of Object.entries(groups)) {
    console.log(`\n[${name}] n=${rs.length} downF=${mean('downF', rs)} base=${mean('baseDownF', rs)} precActive=${mean('precActive', rs)} coverage=${mean('coverage', rs)} lockMed=${med('lockS', rs)} (never ${rs.filter(r => r.lockS == null).length}) baseLockMed=${med('baseLockS', rs)} (never ${rs.filter(r => r.baseLockS == null).length}) 2ndHalf=${mean('secondHalfCov', rs)} vs base ${mean('secondHalfBase', rs)}`);
  }
  const songs = rows.filter(r => /^song-/.test(r.id));
  const cons = songs.filter(r => /Rhinoceros|Sneaky_Snitch/.test(r.id));
  console.log(`\n[songs vs Beat This! offline] precActive=${mean('altPrec', songs)} either-labeler=${mean('either', songs)}`);
  console.log(`[songs, labelers agree (Rhinoceros, Sneaky Snitch)] n=${cons.length} precActive=${mean('precActive', cons)} coverage=${mean('coverage', cons)} lockMed=${med('lockS', cons)} base downF=${mean('baseDownF', cons)} downF=${mean('downF', cons)}`);
  const sh = {}; for (const r of rows) for (const [k, v] of Object.entries(r.shift || {})) sh[k] = (sh[k] || 0) + v;
  console.log('[clock-shift calls while active: truth_claim frames]', JSON.stringify(sh));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}
