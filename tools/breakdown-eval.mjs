import {load} from './live-capture-load.mjs';
const [file, root = new URL('..', import.meta.url).pathname] = process.argv.slice(2);
const {createBreakdownDetector} = await import(root + '/neural-dance/src/breakdown-detect.js');
const {A, H, wallOff} = load(file);
const clock = t => new Date(t + wallOff).toLocaleTimeString('en-US', {hour12: false, timeZone: 'America/Los_Angeles'});
const opts = process.env.OPTS ? JSON.parse(process.env.OPTS) : {};
const det = createBreakdownDetector(opts);
const ev = [];
for (let k = 0; k < 4; k++) for (const t of H[k]) ev.push({t, bit: 1 << k});
for (const a of A) ev.push({t: a.t, a});
ev.sort((x, y) => x.t - y.t);
let last = A[0], out = [], prog = [];
for (const e of ev) {
  if (e.a) last = e.a;
  const r = det.process({t: e.t, lv: last.lv, onsets: e.bit || 0, gate: last.gate, glv: last.glv, bpm: last.bpm});
  if (r.event) out.push({clock: clock(e.t), ...r.event, start: r.event.start ? clock(r.event.start) : undefined});
  if (r.state === 'breakdown' && e.a) prog.push([e.t, r.progress, r.predictedDropAt]);
}
for (const o of out) console.log(JSON.stringify(o));
if (process.env.PROG) { let lastP = -1; for (const [t, p, pd] of prog) { if (Math.floor(p * 10) !== lastP) { lastP = Math.floor(p * 10); console.log('  prog', clock(t), p.toFixed(2), 'predictedDrop', clock(pd)); } } }
