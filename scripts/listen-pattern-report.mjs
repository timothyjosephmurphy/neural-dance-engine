// Offline report for Listen v2 pattern learning (synthetic grooves).
import {PATTERNS, runPattern, downbeatScore} from '../tests/helpers/pattern-grooves.mjs';
import {score} from '../tests/helpers/listen-sim.mjs';

const only = process.argv[2];
const SEEDS = (process.env.SEEDS || '3,11,29').split(',').map(Number);
const rows = [];
for (const [name, mk] of Object.entries(PATTERNS)) {
  if (only && name !== only) continue;
  const sc = mk();
  const truth = sc.events.map(e => ({band: e.band, t: e.t}));
  for (const seed of SEEDS) {
  const base = runPattern(sc, {withPattern: false, seed});
  const pat = runPattern(sc, {seed});
  const settle = 8000;
  // Meter accuracy: share of labelled time after settle with the right label.
  const late = pat.meters.filter(m => m.t > settle);
  const right = late.filter(m => m.meter === sc.meter).length;
  const meterAcc = late.length ? right / late.length : 0;
  const final = pat.meters.length ? pat.meters[pat.meters.length - 1] : null;
  const db = downbeatScore(pat.downbeatGuesses, sc.downbeats, {from: settle});
  const agg = (r) => {
    let hits = 0, truthN = 0, fp = 0; const med = [];
    for (let b = 0; b < 4; b++) { const s = score(truth, r.beats, b, {from: settle}); hits += s.hits; truthN += s.truth; fp += s.falsePositives; if (Number.isFinite(s.medianSignedMs)) med.push(s.medianSignedMs); }
    med.sort((a, b) => a - b);
    return {recall: truthN ? hits / truthN : 0, fp, signed: med.length ? med[med.length >> 1] : NaN};
  };
  const a0 = agg(base), a1 = agg(pat);
  const predShare = pat.beats.filter(e => e.t > settle).length ? pat.predicted.filter(e => e.t > settle).length / pat.beats.filter(e => e.t > settle).length : 0;
  rows.push({name, want: sc.meter, got: final ? final.meter : '-', meterAcc: +meterAcc.toFixed(2), bpm: final ? final.bpm : 0,
    downbeatF: +db.f.toFixed(2), baseRecall: +a0.recall.toFixed(2), recall: +a1.recall.toFixed(2), baseFp: a0.fp, fp: a1.fp,
    baseMs: Math.round(a0.signed), ms: Math.round(a1.signed), predicted: +predShare.toFixed(2), costMs: +pat.costMs.toFixed(3)});
  }
}
// Average seeds per scenario; keep the most common final label.
const out = [];
for (const name of [...new Set(rows.map(r => r.name))]) {
  const rs = rows.filter(r => r.name === name);
  const avg = k => +(rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(2);
  const labels = {}; for (const r of rs) labels[r.got] = (labels[r.got] || 0) + 1;
  const got = Object.entries(labels).sort((a, b) => b[1] - a[1])[0][0];
  out.push({name, want: rs[0].want, got: got + (Object.keys(labels).length > 1 ? ' *' : ''), meterAcc: avg('meterAcc'), bpm: avg('bpm'), downbeatF: avg('downbeatF'),
    baseRecall: avg('baseRecall'), recall: avg('recall'), baseFp: avg('baseFp'), fp: avg('fp'), baseMs: avg('baseMs'), ms: avg('ms'), predicted: avg('predicted'), costMs: avg('costMs')});
}
console.table(out);
if (process.env.JSON_OUT) (await import('node:fs')).writeFileSync(process.env.JSON_OUT, JSON.stringify(out, null, 1));
