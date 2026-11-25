// Before / after detector comparison on a live capture (dev tool, not shipped).
//   node tools/breakdown-compare.mjs <capture.jsonl> <before-detector.js> [after-detector.js]
// There are no hand labels for the captures (and no recorded audio), so two
// offline, non-causal checks stand in for ground truth:
//   reference  >= 2 bars with the low end under 45% of the surrounding groove
//              while music plays; its drop is where the low end returns to
//              >= 75% and holds 2 bars (strict: the phone AGC hides many breaks)
//   contrast   per detected drop: mean low level over the 2 bars after / the
//              2 bars before. >= 1.3 credible, < 1.15 likely false.
import {load} from './live-capture-load.mjs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const [file, beforePath, afterPath = new URL('../neural-dance/src/breakdown-detect.js', import.meta.url).pathname] = process.argv.slice(2);
const SM = await import(new URL('../neural-dance/src/section-motion.js', import.meta.url));
const {A, H, wallOff} = load(file);
const clock = t => new Date(t + wallOff).toLocaleTimeString('en-US', {hour12: false, timeZone: 'America/Los_Angeles'});

// --- offline reference --------------------------------------------------
function reference() {
  const low = A.map(a => Math.max(+a.lv[0] || 0, 0.8 * (+a.lv[1] || 0)));
  const T = A.map(a => a.t), n = A.length;
  const win = (i, ms, f) => { let j0 = i, j1 = i; while (j0 > 0 && T[i] - T[j0 - 1] <= ms) j0--; while (j1 < n - 1 && T[j1 + 1] - T[i] <= ms) j1++; return f(j0, j1); };
  const mean = (a, b) => { let s = 0; for (let k = a; k <= b; k++) s += low[k]; return s / (b - a + 1); };
  const sm = low.map((_, i) => win(i, 500, mean));
  const groove = sm.map((_, i) => win(i, 30000, (a, b) => { const v = sm.slice(a, b + 1).sort((x, y) => x - y); return v[Math.floor(0.8 * (v.length - 1))]; }));
  const bpmAt = i => (+A[i].bpm > 40 ? +A[i].bpm : 124), barMs = i => 4 * 60000 / bpmAt(i);
  const out = [];
  let i = 0;
  while (i < n) {
    const quiet = k => A[k].gate && (+A[k].glv || 0) > 0.05 && groove[k] > 0.15 && sm[k] < 0.45 * groove[k];
    if (!quiet(i)) { i++; continue; }
    let j = i; while (j < n - 1 && (quiet(j + 1) || (A[j + 1].gate && sm[j + 1] < 0.6 * groove[i]))) j++;
    const lenMs = T[j] - T[i];
    if (lenMs >= 2 * barMs(i)) {
      let k = j + 1;
      const endOk = k < n && A[k].gate;
      let hold = false;
      if (endOk) { let m = k; while (m < n && T[m] - T[k] < 2 * barMs(i)) m++; let s = 0, c = 0; for (let q = k; q < m; q++) { s += sm[q]; c++; } hold = c > 0 && s / c >= 0.75 * groove[i] && A.slice(k, m).every(a => a.gate); }
      out.push({start: T[i], end: T[Math.min(n - 1, k)], drop: hold ? T[Math.min(n - 1, k)] : null, bars: lenMs / barMs(i)});
    }
    i = j + 1;
  }
  return out;
}
// --- run a detector (+ section motion jump scheduling) --------------------
async function run(path) {
  const {createBreakdownDetector} = await import(pathToFileURL(resolve(path)).href + '?v=' + path.length + Math.random());
  const det = createBreakdownDetector(), sm = SM.createSectionMotion();
  const ev = [];
  for (let k = 0; k < 4; k++) for (const t of H[k]) ev.push({t, bit: 1 << k});
  for (const a of A) ev.push({t: a.t, a});
  ev.sort((x, y) => x.t - y.t);
  let last = A[0];
  const drops = [], breaks = [], jumps = [], prog = [];
  let cur = null, lastLand = -1;
  for (const e of ev) {
    if (e.a) last = e.a;
    const r = det.process({t: e.t, lv: last.lv, onsets: e.bit || 0, gate: last.gate, glv: last.glv, bpm: last.bpm});
    sm.update(e.t, r);
    if (sm.state.landAt >= 0 && sm.state.landAt !== lastLand && sm.state.cancelAt < 0) { lastLand = sm.state.landAt; jumps.push({at: e.t, land: sm.state.landAt}); }
    if (r.event && r.event.type === 'breakdown') { cur = {t: e.t, start: r.event.start, seen: {}}; breaks.push(cur); }
    if (cur && r.state === 'breakdown') {
      for (const th of [0.4, 0.57]) if (r.progress >= th && cur.seen[th] == null) cur.seen[th] = e.t;
      if (r.cutoff && cur.cut == null) cur.cut = e.t;
    }
    if (r.event && r.event.type === 'drop') { drops.push({t: e.t, ...r.event, brk: cur}); cur = null; }
    if (r.event && (r.event.type === 'breakdownEnd' || r.event.type === 'gap')) cur = null;
  }
  return {drops, breaks, jumps};
}
const ref = reference();
const refDrops = ref.filter(r => r.drop != null);
function score(name, R) {
  const used = new Set();
  const rows = R.drops.map(d => {
    const m = refDrops.findIndex((r, i) => !used.has(i) && Math.abs(r.drop - d.t) <= 1500);
    if (m >= 0) used.add(m);
    const b = d.brk || {seen: {}};
    const lead = th => b.seen[th] != null ? ((d.t - b.seen[th]) / 1000).toFixed(1) + ' s' : '—';
    const jump = R.jumps.find(j => Math.abs(j.land - d.t) <= 700);
    const lowMean = (a, b) => { let s = 0, c = 0; for (const x of A) if (x.t >= a && x.t < b) { s += Math.max(+x.lv[0] || 0, 0.8 * (+x.lv[1] || 0)); c++; } return c ? s / c : 0; };
    const bar = 4 * 60000 / (d.bpm || 124);
    const contrast = lowMean(d.t, d.t + 2 * bar) / Math.max(0.02, lowMean(d.t - 2 * bar, d.t));
    const verdict = contrast >= 1.3 ? 'credible' : contrast < 1.15 ? 'likely false' : 'unclear';
    return {clock: clock(d.t), contrast: +contrast.toFixed(2), verdict, how: d.how, big: d.big, bars: d.bars, buildSeen: lead(0.4), jumpReady: lead(0.57), cutoff: b.cut != null, jump: jump ? Math.round(jump.land - d.t) + ' ms' : 'none', memory: !!d.memory};
  });
  const caught = rows.filter(r => r.match === 'caught').length;
  const cred = rows.filter(r => r.verdict === 'credible').length, lf = rows.filter(r => r.verdict === 'likely false').length;
  const jumpsAtDrops = rows.filter(r => r.jump !== 'none').length;
  console.log(`\n## ${name}: ${R.drops.length} drops (credible ${cred}, unclear ${R.drops.length - cred - lf}, likely false ${lf}); breakdowns ${R.breaks.length}; jumps ${R.jumps.length} (${jumpsAtDrops} at a drop, ${R.jumps.length - jumpsAtDrops} with no drop)`);
  for (const r of rows) console.log(JSON.stringify(r));
  return {caught, n: R.drops.length, jumps: R.jumps.length, rows};
}
console.log(`# ${file.split('/').pop()}: reference ${ref.length} breakdowns, ${refDrops.length} with a drop`);
for (const r of ref) console.log(`ref breakdown ${clock(r.start)}–${clock(r.end)} ${r.bars.toFixed(1)} bars, drop ${r.drop != null ? clock(r.drop) : 'none (faded / gap)'}`);
const before = score('before (' + beforePath.split('/').pop() + ')', await run(beforePath));
const after = score('after (' + afterPath.split('/').pop() + ')', await run(afterPath));
if (process.env.JSON) console.log(JSON.stringify({file, ref, before, after}));
