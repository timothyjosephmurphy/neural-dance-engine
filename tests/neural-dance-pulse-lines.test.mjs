// TJ 7:41 PM: no pulse lines on build 0057227 — nothing transferred between
// dancers. Root cause: the WASM network only links dancers closer than its
// link radius (fixed 82 stage units); the spread Seed 24 layout (23f7dae)
// puts every nearest neighbour 88-115 apart, so no link and no pulse ever
// spawned, even while the kick band fired. The radius now follows the layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spreadPositions} from '../neural-dance/src/sim-layout.js';
import {linkRadiusFor, nearestNeighbourDistances, LINK_R_MIN, LINK_R_MAX} from '../neural-dance/src/link-radius.js';
import {paintPulseTrails, simSilhouetteMarkers} from '../neural-dance/room-lab.js';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';

const wasm = readFileSync(new URL('../neural-dance/neural-dance.wasm', import.meta.url));
const seed = spreadPositions().map(([x, y, type], i) => ({id: i + 1, x, y, type}));

async function room(radius) {
  const {instance} = await WebAssembly.instantiate(wasm);
  const api = instance.exports;
  const buf = new Float32Array(api.memory.buffer, api.nd_sticker_in(), seed.length * 4);
  seed.forEach((d, i) => buf.set([d.id, d.x, d.y, d.type], i * 4));
  api.nd_set_stickers(seed.length);
  api.nd_set_clock(0);
  // The live page's recommended band sensitivities (pulses leave only at peak).
  [2.25, 1.1, 1, 3].forEach((v, k) => api.nd_set_band_sens(k, v));
  if (radius != null) api.nd_set_link_radius(radius);
  return api;
}
// Per-band Listen path: bins=0, hits arrive via nd_hit. `pattern(frame)` → bands hit.
function run(api, frames, pattern, start = 0) {
  const counts = [];
  for (let f = start; f < start + frames; f++) {
    for (const k of pattern(f)) api.nd_hit(k);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, f * 16.67);
    counts.push(api.nd_pulse_count());
  }
  return counts;
}
const music = f => [...(f % 29 === 0 ? [0] : []), ...(f % 58 === 29 ? [2] : []), ...(f % 15 === 7 ? [3] : []), ...(f % 58 === 0 ? [1] : [])];
const kickOnly = f => (f % 29 === 0 ? [0] : []); // TJ's phone: Kick 105, Bass 4, Mid 0, Hat 0

test('spread Seed 24 layout is wider than the old fixed link radius (the regression)', () => {
  const nn = nearestNeighbourDistances(seed);
  assert.ok(Math.min(...nn) > LINK_R_MIN, 'every nearest neighbour beyond 82');
  const r = linkRadiusFor(seed);
  assert.ok(r > Math.max(...nn.slice().sort((a, b) => a - b).slice(0, 18)) && r <= LINK_R_MAX, 'radius ' + r);
  assert.equal(linkRadiusFor([{x: 0, y: 0}]), LINK_R_MIN);
  assert.equal(linkRadiusFor([{x: 0, y: 0}, {x: 10, y: 0}]), LINK_R_MIN, 'tight clumps keep 82');
  assert.equal(linkRadiusFor([{x: 0, y: 0}, {x: 900, y: 0}]), LINK_R_MAX, 'sparse stage capped');
});

test('old radius: music fires but no pulse ever spawns', async () => {
  const api = await room(82);
  assert.equal(Math.max(...run(api, 240, music)), 0);
});

test('synthetic music emits pulses between distinct dancers; kick-only too; zero in silence', async () => {
  const api = await room(linkRadiusFor(seed));
  const counts = run(api, 240, music);
  assert.ok(Math.max(...counts) >= 4, 'pulses with music: ' + Math.max(...counts));
  const kick = await room(linkRadiusFor(seed));
  assert.ok(Math.max(...run(kick, 240, kickOnly)) >= 2, 'kick-only phone mic still sends pulses');
  const silence = run(api, 240, () => [], 240);
  // Max-lifetime safety is ~2.2 s plus a short collapse, so allow ~2.7 s of silence.
  assert.ok(silence.slice(160).every(c => c === 0), 'silence drains to zero pulses');
  const quiet = await room(linkRadiusFor(seed));
  assert.equal(Math.max(...run(quiet, 240, () => [])), 0, 'no pulses without onsets');
});

test('pulse trails are drawn in silhouette mode', async () => {
  const api = await room(linkRadiusFor(seed));
  run(api, 40, music);
  const pc = api.nd_pulse_count();
  assert.ok(pc > 0);
  const f = new Float32Array(api.memory.buffer);
  let strokes = 0, arcs = 0;
  const ctx = new Proxy({}, {get(t, k) { if (k === 'stroke') return () => strokes++; if (k === 'arc') return () => arcs++; if (k === 'canvas') return {width: 1000, height: 620}; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({addColorStop() {}}); return k in t ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; }});
  const xy = (x, y) => ({x, y});
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  assert.equal(show.mode(), 'silhouette');
  const segs = paintPulseTrails(ctx, f, api.nd_pulses() >>> 2, pc, api.nd_pulse_stride(), xy, ['#f00', '#0f0', '#00f', '#ff0'], false);
  assert.ok(segs > 0 && strokes >= segs && arcs >= pc * 2, `segments ${segs}, strokes ${strokes}, heads ${arcs}`);
  show.paint(ctx, simSilhouetteMarkers(seed), {now: 1000, xy});
  // room-lab draw(): trails are painted unconditionally (every light mode),
  // after the silhouette figures so they land on the current heads.
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  const drawSrc = src.slice(src.indexOf('function draw('));
  const call = drawSrc.indexOf('paintPulseTrails(ctx,f,api.nd_pulses()');
  const sil = drawSrc.indexOf("const silMode=silhouetteShow.mode()==='silhouette'");
  const silPaint = drawSrc.indexOf('silhouetteShow.paint(');
  assert.ok(call > 0 && sil > 0 && sil < call, 'trail paint is after silMode and is not gated by it');
  assert.ok(silPaint > 0 && silPaint < call, 'trails paint after the figures, on current heads');
  assert.match(src, /api\.nd_set_link_radius\(linkR\)/);
  assert.match(drawSrc.slice(0, call), />linkR\)continue;/);
});

// TJ 8:00 PM: each dancer has its own activation, fed by pulse energy it
// receives — not a copy of one global/band value.
function network(api) {
  const {list, f, base, ds} = activations(api);
  const recPtr = typeof api.nd_received === 'function' ? api.nd_received() >>> 2 : -1;
  return list.map((d, i) => ({id: d.id, x: f[base + i * ds], y: f[base + i * ds + 1], type: d.k, activity: d.a, received: recPtr >= 0 ? (+f[recPtr + i] || 0) : 0}));
}
function activations(api) {
  const f = new Float32Array(api.memory.buffer);
  const base = api.nd_dancers() >>> 2, ds = api.nd_dancer_stride(), n = api.nd_count();
  return {f, base, ds, n, list: Array.from({length: n}, (_, i) => ({id: f[base + i * ds + 5] | 0, k: f[base + i * ds + 4] | 0, a: f[base + i * ds + 2]}))};
}

test('received pulse energy raises the receiving dancer\'s own activation (kick-only music)', async () => {
  const api = await room(linkRadiusFor(seed));
  let maxOther = new Map();
  for (let f = 0; f < 120; f++) {
    if (f % 29 === 0) api.nd_hit(0);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, f * 16.67);
    for (const d of activations(api).list) if (d.k !== 0) maxOther.set(d.id, Math.max(maxOther.get(d.id) || 0, d.a));
  }
  const fed = [...maxOther.values()].filter(a => a > 0.05);
  assert.ok(fed.length >= 4, 'non-kick dancers energised only by received pulses: ' + fed.length);
  const distinct = new Set([...maxOther.values()].map(a => a.toFixed(3)));
  assert.ok(distinct.size >= 4, 'receivers differ: ' + [...distinct].join(' '));
  const now = activations(api).list.map(d => +d.a.toFixed(3));
  assert.ok(new Set(now).size >= 4, 'activations differ across dancers: ' + now.join(' '));
});

test('silhouette figures take their own received energy: values differ, non-kick receivers fed, silence → 0', async () => {
  const api = await room(linkRadiusFor(seed));
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = new Proxy({}, {get(t, k) { if (k === 'canvas') return {width: 1000, height: 620}; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({addColorStop() {}}); return k in t ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; }});
  const sims = simSilhouetteMarkers(seed);
  let figs = [];
  const got = new Map();
  for (let fr = 0; fr < 240; fr++) {
    const now = 1000 + fr * 16.67;
    const kick = fr % 29 === 0;
    if (kick) api.nd_hit(0);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, now);
    if (kick) show.beat(now, 1, {period: [483, 0, 0, 0], locked: [true, false, false, false]});
    show.paint(ctx, sims, {now, xy: (x, y) => ({x, y}), network: network(api)});
    figs = show.figureHeights();
    for (const g of figs) got.set(g.id, Math.max(got.get(g.id) || 0, g.received));
  }
  assert.equal(figs.length, seed.length);
  assert.ok(figs.every(g => Number.isFinite(g.received)), 'every figure carries its own received energy');
  const distinct = new Set([...got.values()].map(v => v.toFixed(2)));
  assert.ok(distinct.size >= 4, 'per-dancer energy differs: ' + [...distinct].join(' '));
  const kickIds = new Set(seed.filter(d => d.type === 0).map(d => d.id));
  const receivers = [...got.entries()].filter(([id, v]) => !kickIds.has(id) && v > 0.05);
  assert.ok(receivers.length >= 2, 'non-kick dancers energised by received pulses: ' + receivers.length);
  // Activation and received energy decay at 1.5 /s from late arrivals, so allow ~4 s of silence (matches the cascade gate).
  for (let fr = 0; fr < 240; fr++) api.nd_update(1 / 60, 1, 0, 48000, 2048, 5000 + fr * 16.67);
  show.paint(ctx, sims, {now: 9000, xy: (x, y) => ({x, y}), network: network(api)});
  const left = show.figureHeights().filter(g => g.received !== 0).map(g => g.id + ':' + g.received);
  assert.ok(!left.length, 'silence: no dancer keeps received energy ' + left.join(' '));
});

test('no self-sustaining cascade: kick-only music then silence → pulses and activations reach 0 within 3 s', async () => {
  const api = await room(linkRadiusFor(seed));
  run(api, 240, kickOnly);
  const tail = run(api, 240, () => [], 240);
  assert.ok(tail.slice(180).every(c => c === 0), 'pulses in silence after 3 s: ' + tail.slice(180).join(','));
  assert.ok(activations(api).list.every(d => d.a === 0), 'activations drained');
});
