// Beat This! drives the dancers (TJ 9:49 PM): handover, confidence fallback,
// silence, bar alignment and accents.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNnDrive, accentFor, ENTER_MS} from '../neural-dance/src/nn-drive.js';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';

const P = 500; // 120 BPM
// A beat-grid-like state ticking at P, phase `off` ms.
function fakeGrid(off = 0, conf = 0.9) {
  const g = {locked: true, period: P, conf, beat: false, downbeat: false, barBeat: -1, bar: 0, meter: 4, k: 0, next: off + P, beatAt: -1};
  return {g, tick(now) {
    g.beat = g.downbeat = false;
    if (now >= g.next - 8) { g.barBeat = g.k % 4; g.bar = Math.floor(g.k / 4); g.downbeat = g.barBeat === 0; g.beat = true; g.beatAt = g.next; g.next += P; g.k++; }
    return g;
  }};
}
// Heard pattern: kick on every beat at phase `heardOff` (+ detection lag), hats on 8ths.
function heardMask(now, last, heardOff) {
  let m = 0;
  const kb = Math.floor((now - heardOff - 30) / P), kl = Math.floor((last - heardOff - 30) / P);
  if (kb !== kl) m |= 1;
  const hb = Math.floor((now - heardOff - 30) / (P / 2)), hl = Math.floor((last - heardOff - 30) / (P / 2));
  if (hb !== hl) m |= 8;
  return m;
}
const pinfo = {period: new Float32Array([P, P, P, P / 2]), locked: [true, true, true, true]};
const ratio = new Float64Array([1, 0, 0, 2]);
function run({ms = 12000, heardOff = 0, conf = () => 0.9, gridOn = () => true, gate = () => true} = {}) {
  const d = createNnDrive(), fg = fakeGrid(0);
  const log = []; let last = 0;
  for (let now = 16; now < ms; now += 16.7) {
    fg.g.conf = conf(now);
    const g = gridOn(now) ? fg.tick(now) : (fg.tick(now), null);
    const pm = heardMask(now, last, heardOff); last = now;
    const o = d.step(now, {gateOpen: gate(now), grid: g, patternMask: pm, patternInfo: pinfo, ratio, gtPeriod: P});
    log.push({now, mask: o.mask, source: o.source, info: o.info && o.info.pos ? {pos: Array.from(o.info.pos), cyc: Array.from(o.info.cyc)} : null, pm});
  }
  return {d, log};
}
const kickTimes = (log, src) => log.filter(r => (r.mask & 1) && (!src || r.source === src)).map(r => r.now);

test('nn takes over only after confidence holds, and the handover never double-steps', () => {
  const {d, log} = run();
  const first = log.find(r => r.source === 'nn');
  assert.ok(first, 'nn drives a steady song');
  assert.ok(first.now >= ENTER_MS, 'not before ENTER_MS of confidence');
  const ks = kickTimes(log);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] - ks[i - 1] >= 0.45 * P, 'kick steps ' + Math.round(ks[i - 1]) + ' -> ' + Math.round(ks[i]));
  // On the nn grid: kick steps on the beat (grid phase 0), carrying its place in the bar.
  for (const r of log.filter(r => r.source === 'nn' && (r.mask & 1)).slice(2)) {
    const e = ((r.now % P) + P) % P; assert.ok(e < 20 || e > P - 20, 'kick on the beat, err ' + e.toFixed(0));
    assert.ok(r.info.pos[0] >= 0 && r.info.cyc[0] === 4);
  }
  assert.equal(d.snapshot().source, 'nn');
});

test('hats at x2 step on the grid 8ths in nn mode', () => {
  const {log} = run();
  const hats = log.filter(r => r.source === 'nn' && (r.mask & 8)).map(r => r.now).slice(4, 20);
  for (let i = 1; i < hats.length; i++) assert.ok(Math.abs(hats[i] - hats[i - 1] - P / 2) < 20, 'hat gap ' + (hats[i] - hats[i - 1]).toFixed(0));
});

test('confidence fallback: low confidence, nn off, or half-a-beat disagreement keeps the pattern tracker', () => {
  const low = run({conf: () => 0.2}).log;
  assert.ok(low.every(r => r.source === 'pattern'));
  assert.ok(low.every(r => r.mask === r.pm), 'pattern beats pass through unchanged');
  const off = run({gridOn: () => false}).log;
  assert.ok(off.every(r => r.source === 'pattern' && r.mask === r.pm));
  const half = run({heardOff: P / 2}).log;
  assert.ok(half.every(r => r.source === 'pattern'), 'heard beats half a beat off the nn grid: nn never drives');
});

test('confidence drop hands back to the pattern at once, without a double step', () => {
  const {log} = run({ms: 16000, conf: now => now < 8000 ? 0.9 : 0.1});
  const at = log.find(r => r.now >= 8000);
  assert.equal(log.find(r => r.now > 8020).source, 'pattern');
  assert.ok(log.some(r => r.now < 8000 && r.source === 'nn'));
  const ks = kickTimes(log);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] - ks[i - 1] >= 0.45 * P);
  assert.ok(at);
});

test('nn turning off mid-song (grid gone) falls back the same frame', () => {
  const {log} = run({ms: 14000, gridOn: now => now < 9000});
  assert.ok(log.some(r => r.now < 9000 && r.source === 'nn'));
  assert.ok(log.filter(r => r.now >= 9000).every(r => r.source === 'pattern'));
});

test('silence: no beats while the gate is closed, in either mode', () => {
  const {log} = run({ms: 14000, gate: now => now < 8000 || now > 11000});
  assert.ok(log.filter(r => r.now >= 8000 && r.now <= 11000).every(r => r.mask === 0));
  assert.ok(log.some(r => r.now > 11500 && r.mask));
});

test('accents: downbeat strongest, phrase start full, off-beats lighter', () => {
  assert.equal(accentFor(0, 4, 0, 0), 1);
  assert.ok(accentFor(0, 4, 0, 1) < 1 && accentFor(0, 4, 0, 1) > accentFor(2, 4, 0, 1));
  assert.ok(accentFor(2, 4, 0, 1) > accentFor(1, 4, 0, 1));
  assert.ok(accentFor(1, 4, 1, 1) < accentFor(1, 4, 0, 1));
});

test('silhouette: bar-aligned strides land on beats 1 and 3, realign skips ahead without a double strike', () => {
  const show = createSilhouetteShow();
  show.setGlobalTempo(350); // fast: stride 2
  const strikes = [];
  let k = 0;
  const pos = new Int32Array(4).fill(-1), cyc = new Int32Array(4), accent = new Float64Array(4).fill(1), period = new Float64Array([350, 350, 350, 350]);
  // 3 beats unaligned (pattern), then aligned beats starting mid-bar at barBeat 1.
  for (let i = 0; i < 3; i++) { show.beat(i * 350, 1, {period, locked: [true]}); strikes.push(show.bandClock(0).strikeAt); }
  for (let i = 3; i < 20; i++) {
    pos[0] = (i - 2) % 4; cyc[0] = 4; accent[0] = pos[0] === 0 ? 1 : 0.88;
    show.beat(i * 350, 1, {period, locked: [true], pos, cyc, accent});
    strikes.push(show.bandClock(0).strikeAt); k = i;
  }
  const uniq = [...new Set(strikes)].filter(t => t >= 2 * 350); // first two: pre-existing first-beat latch
  for (let i = 1; i < uniq.length; i++) assert.ok(uniq[i] - uniq[i - 1] >= 0.7 * 700, 'strike gap ' + (uniq[i] - uniq[i - 1]));
  const aligned = uniq.filter(t => t >= 3 * 350).slice(1);
  for (const t of aligned) { const p = (t / 350 - 2) % 4; assert.ok(p === 0 || p === 2, 'strike on bar position ' + p); }
  assert.ok(k > 0 && show.bandClock(0).accent > 0);
});

test('room-lab: drive only with nn on, pattern beats otherwise, silence still zero', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /try\{if\(nnListen\)nnDrive=createNnDrive\(\);\}catch\{nnDrive=null;\}/);
  assert.match(src, /let beatMask=listening&&!gate\.open\?0:\(bandInfo\?bandHits:tones\);/);
  assert.match(src, /if\(nnDrive&&listening&&bandInfo\)\{try\{const d=nnDrive\.step\(now,\{gateOpen:gate\.open,grid:nnListen\?nnGrid:null,[^}]*\}\);beatMask=listening&&!gate\.open\?0:d\.mask;beatInfo=d\.info;\}catch\{nnDrive=null;\}\}/);
  assert.match(src, /if\(beatMask\)silhouetteShow\.beat\(now,beatMask,beatInfo\);/);
  assert.match(src, /function nnOff\(\)\{const n=nnListen;nnListen=null;nnGrid=null;/);
});

import {createBeatGrid} from '../neural-dance/src/beat-grid.js';
function feed(grid, {beatMs = 500, jitter = 0, seed = 5, ms = 14000, gt = 500, prob = 0.9} = {}) {
  let r = seed; const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const fps = 50, W = 400; const beats = []; let t = 300; while (t < ms + 1000) { beats.push(t + (jitter ? (rnd() - 0.5) * jitter : 0)); t += typeof beatMs === 'function' ? beatMs(t) : beatMs; }
  const out = [];
  for (let now = 2000; now < ms; now += 1000) {
    const tEnd = now - 300, t0 = tEnd - W * 20, b = new Float32Array(W), d = new Float32Array(W);
    beats.forEach((bt, i) => { const f = Math.round((bt - t0) / 20); if (f >= 0 && f < W) { b[f] = prob; if (i % 4 === 0) d[f] = prob; } });
    grid.update(now, tEnd, t0, fps, b, d, gt);
    for (let f = now; f < now + 1000; f += 16.7) { const g = grid.tick(f, gt); if (g.beat) out.push({t: g.beatAt, conf: g.conf}); }
  }
  return {beats, out};
}
test('beat grid confidence: high for a clear steady beat, low for scattered peaks', () => {
  const clear = feed(createBeatGrid());
  assert.ok(clear.out.at(-1).conf > 0.7, 'clear ' + clear.out.at(-1).conf);
  const messy = feed(createBeatGrid(), {jitter: 260, prob: 0.55});
  assert.ok(messy.out.at(-1).conf < clear.out.at(-1).conf - 0.2, 'messy ' + messy.out.at(-1).conf);
});
test('beat grid follows music 3% faster than the (lagging) global tempo via the frequency trim', () => {
  const grid = createBeatGrid();
  const {beats, out} = feed(grid, {beatMs: 490, ms: 14000});
  const late = out.filter(o => o.t > 9000).map(o => Math.min(...beats.map(b => Math.abs(b - o.t))));
  assert.ok(grid.state.trim < -0.012, 'trim ' + grid.state.trim);
  assert.ok(late.length > 4 && Math.max(...late) < 40, 'max err ' + Math.round(Math.max(...late)));
});
