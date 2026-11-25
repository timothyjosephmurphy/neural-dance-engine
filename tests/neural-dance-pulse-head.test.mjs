// TJ 8:02 PM: pulses go head → head (sender's head to the receiver's head,
// following the current pose, standing tall included); the silhouette glow
// emanates from the head and falls off along the body (insets share it).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spreadPositions} from '../neural-dance/src/sim-layout.js';
import {linkRadiusFor} from '../neural-dance/src/link-radius.js';
import {paintPulseTrails, pulseAnchor, pulseTargetHead, headAnchor, writePulseHeadAims, simSilhouetteMarkers, PULSE_CORE_R, PULSE_HALO_R, PULSE_TRAIL_W, PULSE_TRAIL_GLOW_W, PULSE_TRAIL_SPAN} from '../neural-dance/room-lab.js';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';
import {paintSilhouetteHalo, HALO_FALLOFF} from '../neural-dance/src/skeleton-dancer.js';

const wasm = readFileSync(new URL('../neural-dance/neural-dance.wasm', import.meta.url));
const seed = spreadPositions().map(([x, y, type], i) => ({id: i + 1, x, y, type}));
const xy = (x, y) => ({x, y});
function mockCtx(log) {
  return new Proxy({}, {get(t, k) {
    if (k === 'canvas') return {width: 1000, height: 620};
    if (k === 'createRadialGradient') return (...a) => { log && log.radial.push(a); return {addColorStop() {}}; };
    if (k === 'createLinearGradient') return () => ({addColorStop() {}});
    if (k === 'moveTo' || k === 'lineTo') return (x, y) => log && log.pts.push({x, y, alpha: t.globalAlpha});
    if (k === 'arc') return (x, y, r) => log && log.arcs.push({x, y, r});
    if (k === 'stroke') return () => { if (log) { log.strokes.push(t.globalAlpha); log.widths && log.widths.push(t.lineWidth); } };
    return k in t ? t[k] : () => {};
  }, set(t, k, v) { t[k] = v; return true; }});
}
function feedHeads(api, figs) {
  const f = new Float32Array(api.memory.buffer);
  return writePulseHeadAims(api, f, figs, g => g.id | 0);
}
function trailSnap(api) {
  const f = new Float32Array(api.memory.buffer);
  const pb = api.nd_pulses() >>> 2, pc = api.nd_pulse_count(), ps = api.nd_pulse_stride();
  const out = [];
  for (let i = 0; i < pc; i++) {
    const o = pb + i * ps, len = f[o + 7] | 0;
    const pts = [];
    for (let j = 0; j < len; j++) pts.push([f[o + 8 + j * 2], f[o + 9 + j * 2]]);
    out.push({a: f[o] | 0, b: f[o + 1] | 0, hx: f[o + 5], hy: f[o + 6], pts});
  }
  return out;
}

test('pulseAnchor rides from the sender head offset to the receiver head offset', () => {
  const anchor = {pos: i => (i === 0 ? {x: 0, y: 0} : {x: 100, y: 0}), off: i => (i === 0 ? {dx: 2, dy: -70} : {dx: -4, dy: -90})};
  const P = pulseAnchor(anchor, 0, 1, xy);
  assert.deepEqual(P(0, 0), {x: 2, y: -70});
  assert.deepEqual(P(100, 0), {x: 96, y: -90});
  const mid = P(50, 10);
  assert.ok(Math.abs(mid.x - 49) < 1e-9 && Math.abs(mid.y - (10 - 80)) < 1e-9);
});

test('live trails start at the sender head and end at the receiver head (current pose)', async () => {
  const {instance} = await WebAssembly.instantiate(wasm);
  const api = instance.exports;
  const buf = new Float32Array(api.memory.buffer, api.nd_sticker_in(), seed.length * 4);
  seed.forEach((d, i) => buf.set([d.id, d.x, d.y, d.type], i * 4));
  api.nd_set_stickers(seed.length); api.nd_set_clock(0); api.nd_set_link_radius(linkRadiusFor(seed));
  [2.25, 1.1, 1, 3].forEach((v, k) => api.nd_set_band_sens(k, v)); // live defaults; pulses leave at peak
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const sims = simSilhouetteMarkers(seed);
  show.paint(mockCtx(), sims, {now: 1000, xy});
  let figs = show.figureHeights();
  feedHeads(api, figs);
  for (let fr = 0; fr < 40; fr++) {
    const now = 1000 + fr * 16.67;
    if (fr % 29 === 0) { api.nd_hit(0); api.nd_hit(2); show.beat(now, 5, {period: [483, 0, 483, 0], locked: [true, false, true, false]}); }
    feedHeads(api, figs);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, now);
    show.paint(mockCtx(), sims, {now, xy});
    figs = show.figureHeights();
  }
  const f = new Float32Array(api.memory.buffer);
  const base = api.nd_dancers() >>> 2, ds = api.nd_dancer_stride(), n = api.nd_count();
  figs = show.figureHeights();
  assert.ok(figs.every(g => g.head && g.head.y < g.y - 0.3 * g.height && g.head.y < g.floorY - 0.8 * g.height), 'head sits at the top of every figure (marker is at the hips)');
  const anchor = headAnchor(f, base, ds, n, figs);
  const pb = api.nd_pulses() >>> 2, pc = api.nd_pulse_count(), ps = api.nd_pulse_stride();
  assert.ok(pc > 0);
  const log = {pts: [], arcs: [], strokes: [], radial: []};
  paintPulseTrails(mockCtx(log), f, pb, pc, ps, xy, ['#f00', '#0f0', '#00f', '#ff0'], false, anchor);
  // Drawn points sit up at head height, not at the floor/hips — the particle
  // itself launched from and homes toward the live heads, with no remapping.
  const floorY = Math.max(...figs.map(g => g.y));
  const meanY = log.pts.reduce((s, p) => s + p.y, 0) / log.pts.length;
  const meanHeadDy = figs.reduce((s, g) => s + (g.y - g.head.y), 0) / figs.length;
  assert.ok(meanY < floorY - 0.5 * meanHeadDy, 'trails drawn at head height');
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /headAnchor\(f,base,ds,n,silhouetteShow\.figureHeights\(\)\)/);
  assert.match(src, /writePulseAims\(\)/);
  assert.match(src, /for\(let j=0;j<trail;j\+\+\) raw\.push\(xy\(/);
});

test('halo glow is brightest at the head and falls off down the body', () => {
  assert.ok(HALO_FALLOFF.head > HALO_FALLOFF.torso && HALO_FALLOFF.torso > HALO_FALLOFF.arms && HALO_FALLOFF.arms > HALO_FALLOFF.legs);
  const show = createSilhouetteShow(); show.setMode('silhouette');
  show.beat(1000, 1, {period: [483, 0, 0, 0], locked: [true, false, false, false]});
  show.paint(mockCtx(), simSilhouetteMarkers([{id: 1, x: 500, y: 400, type: 0}]), {now: 1000, xy});
  const log = {pts: [], arcs: [], strokes: [], radial: []};
  const pose = {height: 120, b: {headR: 0.05}};
  for (const k of ['shL', 'shR', 'neck', 'hipR', 'hipL', 'groin', 'elL', 'wristL', 'handL', 'elR', 'wristR', 'handR', 'kneeL', 'ankleL', 'footL', 'kneeR', 'ankleR', 'footR']) pose[k] = {x: 500, y: 300};
  pose.head = {x: 510, y: 190};
  assert.equal(paintSilhouetteHalo(mockCtx(log), pose, xy, {dim: 1, width: 1, alpha: 1, color: '#fff'}), true);
  assert.ok(log.radial.length >= 1 && log.radial[0][0] === 510 && log.radial[0][1] === 190, 'radial bloom centred on the head');
  // Per ring: torso, armL, armR, legL, legR, head strokes; head alpha is the max.
  const ring = log.strokes.slice(0, 6);
  assert.equal(Math.max(...ring), ring[5]);
  assert.ok(ring[3] < ring[1] && ring[1] < ring[0]);
});


test('pulseAnchor clips a point past the receiver onto that dancer\'s current head', () => {
  const anchor = {pos: i => (i === 0 ? {x: 0, y: 0} : {x: 100, y: 0}), off: i => (i === 0 ? {dx: 2, dy: -70} : {dx: -4, dy: -90})};
  const P = pulseAnchor(anchor, 0, 1, xy);
  assert.deepEqual(P(100, 0), {x: 96, y: -90}, 'exactly at the receiver still maps to the head');
  const past = P(140, 8);
  assert.deepEqual(past, {x: 96, y: -90}, 'overshoot clamps to the current head, nothing beyond it');
  const mid = P(50, 10);
  assert.ok(Math.abs(mid.x - 49) < 1e-9 && Math.abs(mid.y - (10 - 80)) < 1e-9, 'mid-path points are unchanged');
});

test('drawn pulse homes to a moved target head, ends on contact, and the tail collapses', async () => {
  const {instance} = await WebAssembly.instantiate(wasm);
  const api = instance.exports;
  api.nd_clear();
  api.nd_set_clock(0);
  api.nd_set_gravity(2.5);
  api.nd_set_wander(0);
  api.nd_set_link_radius(200);
  api.nd_set_band_sens(0, 2.25); // live kick default: at peak on the hit
  const idA = api.nd_add(0, 0, 0);
  const idB = api.nd_add(120, 0, 1);
  const figs0 = [
    {id: idA, kind: 'sim', x: 0, y: 0, height: 100, head: {x: 0, y: -80}},
    {id: idB, kind: 'sim', x: 120, y: 0, height: 100, head: {x: 120, y: -80}}
  ];
  feedHeads(api, figs0);
  api.nd_hit(0);
  api.nd_update(0, 1, 0, 48000, 2048, 1000);
  assert.ok(api.nd_pulse_count() > 0, 'pulse spawned');
  // Mid-flight: move the receiver (and its head). Historical trail must stay put.
  const figs = [
    {id: idA, kind: 'sim', x: 0, y: 0, height: 100, head: {x: 0, y: -80}},
    {id: idB, kind: 'sim', x: 120, y: 40, height: 100, head: {x: 130, y: -50}}
  ];
  api.nd_move(idB, 120, 40);
  feedHeads(api, figs);
  let arrived = false;
  let lastHead = null;
  for (let fr = 0; fr < 90; fr++) {
    feedHeads(api, figs);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, 1000 + (fr + 1) * 16.67);
    const f = new Float32Array(api.memory.buffer);
    const base = api.nd_dancers() >>> 2, ds = api.nd_dancer_stride(), n = api.nd_count();
    const pb = api.nd_pulses() >>> 2, pc = api.nd_pulse_count(), ps = api.nd_pulse_stride();
    if (!pc) { arrived = true; break; }
    const anchor = headAnchor(f, base, ds, n, figs);
    const target = pulseTargetHead(anchor, 1, xy);
    const log = {pts: [], arcs: [], strokes: [], widths: [], radial: []};
    paintPulseTrails(mockCtx(log), f, pb, pc, ps, xy, ['#f00', '#0f0', '#00f', '#ff0'], false, anchor);
    lastHead = log.arcs[log.arcs.length - 1];
    const o = pb;
    const t = f[o + 4] > 0 ? f[o + 3] / f[o + 4] : 1;
    if (t >= 1 && lastHead) {
      assert.ok(Math.hypot(lastHead.x - target.x, lastHead.y - target.y) < 1.5, 'front sits on the current (moved) head at contact');
      arrived = true;
      let sawShrink = false;
      let prevPts = log.pts.length;
      for (let k = 0; k < 20; k++) {
        feedHeads(api, figs);
        api.nd_update(1 / 60, 1, 0, 48000, 2048, 2000 + k * 16.67);
        if (api.nd_pulse_count() === 0) { sawShrink = true; break; }
        const f2 = new Float32Array(api.memory.buffer);
        const log2 = {pts: [], arcs: [], strokes: [], widths: [], radial: []};
        paintPulseTrails(mockCtx(log2), f2, api.nd_pulses() >>> 2, api.nd_pulse_count(), api.nd_pulse_stride(), xy, ['#f00', '#0f0', '#00f', '#ff0'], false, anchor);
        if (log2.pts.length < prevPts) sawShrink = true;
        prevPts = log2.pts.length;
      }
      assert.ok(sawShrink || api.nd_pulse_count() === 0, 'trail tail catches up and the pulse is removed');
      break;
    }
  }
  assert.ok(arrived, 'pulse reached the moved head');
});

test('moving the source or target after launch does not move existing trail points', async () => {
  const {instance} = await WebAssembly.instantiate(wasm);
  const api = instance.exports;
  api.nd_clear();
  api.nd_set_clock(0);
  api.nd_set_gravity(2.5);
  api.nd_set_wander(0);
  api.nd_set_link_radius(200);
  api.nd_set_band_sens(0, 2.25); // live kick default: at peak on the hit
  const idA = api.nd_add(0, 0, 0);
  const idB = api.nd_add(150, 0, 1);
  const figs = [
    {id: idA, kind: 'sim', x: 0, y: 0, height: 100, head: {x: 0, y: -70}},
    {id: idB, kind: 'sim', x: 150, y: 0, height: 100, head: {x: 150, y: -70}}
  ];
  feedHeads(api, figs);
  api.nd_hit(0);
  api.nd_update(0, 1, 0, 48000, 2048, 1000);
  for (let i = 0; i < 8; i++) {
    feedHeads(api, figs);
    api.nd_update(1 / 60, 1, 0, 48000, 2048, 1010 + i * 16.67);
  }
  assert.ok(api.nd_pulse_count() > 0, 'pulse still in flight');
  const before = trailSnap(api);
  assert.ok(before[0].pts.length >= 2, 'trail has history');
  // Move both dancers a long way without ticking the sim. The world-space
  // trail and particle must stay exactly where they were.
  api.nd_move(idA, 400, 200);
  api.nd_move(idB, 500, 280);
  feedHeads(api, [
    {id: idA, kind: 'sim', x: 400, y: 200, height: 100, head: {x: 400, y: 130}},
    {id: idB, kind: 'sim', x: 500, y: 280, height: 100, head: {x: 500, y: 210}}
  ]);
  const after = trailSnap(api);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].pts.length, before[i].pts.length);
    for (let j = 0; j < before[i].pts.length; j++) {
      assert.deepEqual(after[i].pts[j], before[i].pts[j], 'trail point ' + j + ' stayed in stage space');
    }
    assert.equal(after[i].hx, before[i].hx);
    assert.equal(after[i].hy, before[i].hy);
  }
  const f = new Float32Array(api.memory.buffer);
  const base = api.nd_dancers() >>> 2, ds = api.nd_dancer_stride(), n = api.nd_count();
  const figsMoved = [
    {id: idA, kind: 'sim', x: 400, y: 200, height: 100, head: {x: 400, y: 130}},
    {id: idB, kind: 'sim', x: 500, y: 280, height: 100, head: {x: 500, y: 210}}
  ];
  const logA = {pts: [], arcs: [], strokes: [], widths: [], radial: []};
  const logB = {pts: [], arcs: [], strokes: [], widths: [], radial: []};
  const pb = api.nd_pulses() >>> 2, pc = api.nd_pulse_count(), ps = api.nd_pulse_stride();
  paintPulseTrails(mockCtx(logA), f, pb, pc, ps, xy, ['#f00', '#0f0', '#00f', '#ff0'], false, headAnchor(f, base, ds, n, figs));
  paintPulseTrails(mockCtx(logB), f, pb, pc, ps, xy, ['#f00', '#0f0', '#00f', '#ff0'], false, headAnchor(f, base, ds, n, figsMoved));
  assert.deepEqual(logA.pts, logB.pts, 'painted trail does not remapped when dancers move');
});

test('pulses are pinpoints: tiny core, faint small halo, short thin trail', () => {
  assert.ok(PULSE_CORE_R * 2 >= 2 && PULSE_CORE_R * 2 <= 3.2, 'core is about 2–3 stage px');
  assert.ok(PULSE_HALO_R < 6 && PULSE_HALO_R > PULSE_CORE_R, 'halo stays a faint small ring around the core');
  assert.ok(PULSE_TRAIL_W < 2 && PULSE_TRAIL_GLOW_W < 5, 'trail is thin (was lineWidth 8 / 2+j/4)');
  assert.ok(PULSE_TRAIL_SPAN <= 40, 'trail is short');
  const f = new Float32Array(28);
  f[0] = 0; f[1] = 1; f[2] = 0; f[3] = 0.2; f[4] = 0.6; f[5] = 40; f[6] = 0; f[7] = 3;
  f[8] = 0; f[9] = 0; f[10] = 20; f[11] = 0; f[12] = 40; f[13] = 0;
  const log = {pts: [], arcs: [], strokes: [], widths: [], radial: []};
  paintPulseTrails(mockCtx(log), f, 0, 1, 28, xy, ['#f00', '#0f0', '#00f', '#ff0'], false, null);
  const radii = log.arcs.map(a => a.r).sort((a, b) => a - b);
  assert.ok(radii[0] <= 1.6 && radii[radii.length - 1] <= 7, 'drawn radii stay pinpoint-sized, got ' + radii.join(','));
  assert.ok(log.widths.every(w => w <= 4), 'drawn trail widths stay thin, got ' + log.widths.join(','));
});
