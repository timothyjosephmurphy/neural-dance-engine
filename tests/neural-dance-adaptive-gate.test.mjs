// TJ 8:32 PM: dancers did not come to stillness in silence. Live captures had
// the gate open 98-100%: floor learned near 0 at startup and frozen while
// open, room noise ~0.5 vs floor + 0.08, music ~1.5. The gate now adapts to
// the music level and the noise floor with hysteresis and closes in ~0.6-1 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('../neural-dance/silence-gate.js', import.meta.url), 'utf8');
function lib() { const sb = {}; new Function('globalThis', src.replace(/^export .*/gm, ''))(sb); return sb.ndSilenceGate; }
const G = lib();
function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const DT = 1 / 60;
// Level of the loudest band (dB-scaled bytes / 56) for a frame.
function music(t, r) { const beat = (t % 0.5) < 0.08; return beat ? 1.5 + 0.2 * r() : 0.9 + 0.3 * r(); }
function noise(r, lo = 0.3, hi = 0.6) { return lo + (hi - lo) * r(); }

function play(g, seconds, fn, t0, idleFn) {
  const out = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = t0 + i * DT;
    const lv = fn(t);
    G.scale(g, [lv, lv * 0.5, lv * 0.4, 0], DT, idleFn ? idleFn(t) : undefined);
    out.push({t, open: g.open});
  }
  return out;
}

test('stale startup floor: room noise after the music closes the gate within ~1 s and keeps it closed', () => {
  const g = G.create(), r = rand(7);
  play(g, 1, () => 0, 0);                       // mic warming: digital silence
  const m = play(g, 10, t => music(t, r), 1);
  assert.ok(m.filter(f => f.open).length / m.length > 0.97, 'open through the music');
  const p = play(g, 6, () => noise(r), 11);
  const closeAt = p.find(f => !f.open);
  assert.ok(closeAt && closeAt.t - 11 <= 1.0, 'closed after ' + (closeAt && (closeAt.t - 11).toFixed(2)) + ' s');
  const after = p.filter(f => f.t > 12.2);
  assert.ok(after.every(f => !f.open), 'noise never reopens it');
  const back = play(g, 1, t => music(t, r), 17);
  assert.ok(back.find(f => f.open).t - 17 < 0.12, 'music reopens at once');
});

test('the old gate stayed open on the same input (regression guard for the fix)', () => {
  // Same scenario with the previous fixed margin (floor + 0.08, frozen floor):
  // the noise sits ~0.3-0.6 over a ~0 floor, so it never closed.
  const g = G.create(), r = rand(7);
  play(g, 1, () => 0, 0);
  play(g, 10, t => music(t, r), 1);
  assert.ok(g.music > 1.0 && g.noiseFloor < 0.6, 'music ' + g.music + ' floor ' + g.noiseFloor);
  // Gate v3 (Nov 10): the floor no longer learns the music, so the close level
  // sits a real margin over the quiet floor instead of near the music.
  assert.ok(g.closeAt > 0.4, 'close threshold follows the music: ' + g.closeAt);
});

test('quiet phone: music only ~5 dB over the room still closes once onsets stop (hysteresis, no flapping)', () => {
  const g = G.create(), r = rand(3);
  play(g, 1, () => 0.7 + 0.2 * r(), 0);
  let lastOnset = 1;
  const onsetIdle = t => { if ((t % 0.5) < DT) lastOnset = t; return t - lastOnset; };
  const m = play(g, 10, t => ((t % 0.5) < 0.08 ? 1.4 : 0.95) + 0.1 * r(), 1, onsetIdle);
  assert.ok(m.filter(f => f.open).length / m.length > 0.95);
  const p = play(g, 6, () => noise(r, 0.7, 0.9), 11, t => t - lastOnset);
  const closeAt = p.find(f => !f.open);
  assert.ok(closeAt && closeAt.t - 11 <= 1.2, 'closed after ' + (closeAt && (closeAt.t - 11).toFixed(2)) + ' s');
  let flips = 0; for (let i = 1; i < p.length; i++) if (p[i].open !== p[i - 1].open) flips++;
  assert.ok(flips <= 2, 'flips ' + flips);
});

test('steady loud music never closes', () => {
  const g = G.create(), r = rand(11);
  const m = play(g, 180, t => music(t, r), 0);
  assert.ok(m.filter(f => f.open && f.t > 1).length >= m.filter(f => f.t > 1).length - 2);
});

test('hushed wasm network settles: activation ~0 and no pulses within 1 s', async () => {
  const {instance} = await WebAssembly.instantiate(readFileSync(new URL('../neural-dance/neural-dance.wasm', import.meta.url)));
  const api = instance.exports;
  assert.equal(typeof api.nd_settle, 'function');
  api.nd_clear(); api.nd_set_clock(0);
  for (let b = 0; b < 4; b++) api.nd_set_band_sens(b, 3);
  for (let i = 0; i < 12; i++) api.nd_add(100 + (i % 4) * 40, 100 + Math.floor(i / 4) * 40, i % 4);
  for (let f = 0; f < 30; f++) { if (f % 4 === 0) for (let k = 0; k < 4; k++) api.nd_hit(k); api.nd_update(DT, 1, 0, 48000, 2048, f * 16.7); }
  const maxA = () => { const fl = new Float32Array(api.memory.buffer), base = api.nd_dancers() >>> 2, ds = api.nd_dancer_stride(); let m = 0; for (let i = 0; i < api.nd_count(); i++) m = Math.max(m, fl[base + i * ds + 2]); return m; };
  assert.ok(maxA() > 1 && api.nd_pulse_count() > 0, 'network active: a ' + maxA() + ' pulses ' + api.nd_pulse_count());
  for (let f = 0; f < 60; f++) { api.nd_update(DT, 1, 0, 48000, 2048, 600 + f * 16.7); api.nd_settle(DT); }
  assert.ok(maxA() < 0.05, 'activation ' + maxA());
  assert.equal(api.nd_pulse_count(), 0);
});

test('room-lab: no beats while the gate is closed, onset idle feeds the gate, hush settles the network', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /if\(!gate\.open\)bandHits=0;/);
  assert.match(room, /agcScale\(peaks,gap\/1000,bandOnsets\?\(now-lastOnsetAt\)\/1000:undefined\)/);
  assert.match(room, /if\(bandInfo\.onsets\)lastOnsetAt=now;/);
  assert.match(room, /api\.nd_settle\(/);
  assert.match(room, /glv:.*gmus:.*gclose:.*hush:.*act:wasmActivation\(\)/);
});
