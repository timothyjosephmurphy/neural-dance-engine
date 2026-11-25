// Pulse network (TJ Nov 11 2:27 PM): dancers only send pulses at peak
// activation, the peak period lasts 5 s, and the cooldown keeps dancing low
// without sending anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const wasm = readFileSync(new URL('../neural-dance/neural-dance.wasm', import.meta.url));
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const SR = 44100, FFT = 2048;

async function load() {
  const api = (await WebAssembly.instantiate(wasm)).instance.exports;
  api.nd_clear();
  api.nd_set_clock(0);
  api.nd_set_gravity(0);
  api.nd_set_wander(0);
  return api;
}
function dancer(api, i) {
  const f = new Float32Array(api.memory.buffer);
  const o = (api.nd_dancers() >>> 2) + i * api.nd_dancer_stride();
  return {a: f[o + 2], rest: f[o + 3], hot: api.nd_dancer_hot(i)};
}
let clock = 0;
function step(api, dt = 1 / 60) { clock += dt; return api.nd_update(dt, 1, 0, SR, FFT, clock * 1000); }

test('engine exports the peak constants and a 5 s default peak hold', async () => {
  const api = await load();
  assert.ok(Math.abs(api.nd_peak_level() - 1.75) < 1e-6);
  assert.ok(Math.abs(api.nd_peak_hold() - 5) < 1e-6);
  const cap = api.nd_rest_cap();
  assert.ok(cap >= 0.6 && cap <= 0.8, `rest cap ${cap}`);
  const src = read('neural-dance/src/neural_dance.cpp');
  assert.match(src, /constexpr float PEAK_LEVEL = 1\.75f;/);
  assert.match(src, /PEAK_HOLD_DEFAULT = 5\.f/);
});

test('a band hit below peak raises the dancer but sends no pulse and no energy', async () => {
  const api = await load();
  api.nd_add(0, 0, 2);   // snare, sens 1: one hit lands near 1.1
  api.nd_add(40, 0, 1);  // bass neighbour
  api.nd_hit(2);
  const mask = step(api);
  assert.ok(mask & 4, 'the band tone still reports the hit');
  assert.ok(dancer(api, 0).a > 0.9 && dancer(api, 0).a < 1.75, `a ${dancer(api, 0).a}`);
  assert.equal(dancer(api, 0).hot, 0);
  assert.equal(api.nd_emit_total(), 0);
  assert.equal(api.nd_spawn_total(), 0);
  assert.equal(api.nd_pulse_count(), 0);
  assert.ok(dancer(api, 1).a < 0.05, 'neighbour got no energy');
});

test('a dancer at peak sends a pulse and energy, then waits out its emit interval', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 2); // floor 1.9: at peak on the first hit
  api.nd_add(0, 0, 0);
  api.nd_add(40, 0, 1);
  assert.ok(Math.abs(api.nd_emit_interval() - 1) < 1e-6, 'unlocked tempo: 1.0 s');
  api.nd_hit(0);
  step(api);
  assert.equal(dancer(api, 0).hot, 1);
  assert.equal(api.nd_emit_total(), 1);
  assert.ok(api.nd_spawn_total() >= 1);
  assert.ok(dancer(api, 1).a > 0.3, `neighbour energy ${dancer(api, 1).a}`);
  // Hits inside the 1 s interval do not emit again...
  for (const wait of [6, 20, 20]) { for (let i = 0; i < wait; i++) step(api); api.nd_hit(0); step(api); }
  assert.equal(api.nd_emit_total(), 1);
  // ...the first hit once it expires does.
  for (let i = 0; i < 12; i++) step(api);
  api.nd_hit(0);
  step(api);
  assert.equal(api.nd_emit_total(), 2);
  // Without band hits a hot dancer emits nothing on its own.
  for (let i = 0; i < 70; i++) step(api);
  assert.equal(api.nd_emit_total(), 2);
});

async function emitTimes(bpm, {lock = true, seconds = 10} = {}) {
  const api = await load();
  api.nd_set_band_sens(3, 3);
  api.nd_set_peak_hold(12); // stay at peak for the whole run
  api.nd_add(0, 0, 3);
  api.nd_set_emit_bpm(lock ? bpm : 0);
  const eighth = 30 / bpm;
  const times = [], hits = [];
  let last = 0;
  for (let f = 0; f < seconds * 120; f++) {
    const t = f / 120, t1 = (f + 1) / 120;
    if (Math.floor(t1 / eighth) > Math.floor(t / eighth)) { api.nd_hit(3); hits.push(t1); }
    clock += 1 / 120;
    api.nd_update(1 / 120, 1, 0, SR, FFT, clock * 1000);
    if (api.nd_emit_total() > last) { times.push(t1); last = api.nd_emit_total(); }
  }
  return {times, hits, interval: api.nd_emit_interval()};
}

for (const [bpm, expect] of [[90, 4 / 3], [120, 1.0], [150, 0.8]]) {
  test(`at peak a dancer emits about every 2 beats at ${bpm} BPM, on the band hits`, async () => {
    const {times, hits, interval} = await emitTimes(bpm);
    assert.ok(Math.abs(interval - expect) < 1e-4, `interval ${interval}`);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - expect) < 0.05, `${bpm} BPM mean gap ${mean.toFixed(3)} vs ${expect.toFixed(3)}`);
    for (const g of gaps) assert.ok(g > expect - 0.13 && g < expect + 30 / bpm + 0.02, `gap ${g.toFixed(3)}`);
    const perSec = (times.length - 1) / (times[times.length - 1] - times[0]);
    assert.ok(Math.abs(perSec - 1 / expect) < 0.06, `${bpm} BPM rate ${perSec.toFixed(2)}/s`);
    for (const t of times) assert.ok(hits.some(h => Math.abs(h - t) < 1 / 100), `emission at ${t} is on a hit`);
  });
}

test('emit interval falls back to 1.0 s unlocked and clamps to 0.6-1.6 s', async () => {
  const {times, interval} = await emitTimes(150, {lock: false});
  assert.equal(interval, 1);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(Math.abs(mean - 1.0) < 0.12, `unlocked mean gap ${mean}`);
  const api = await load();
  api.nd_set_emit_bpm(250);
  api.nd_add(0, 0, 0);
  api.nd_update(0.01, 1, 0, SR, FFT, 10);
  assert.ok(Math.abs(api.nd_emit_interval() - 0.6) < 1e-6);
  api.nd_set_emit_bpm(60);
  api.nd_update(0.01, 1, 0, SR, FFT, 20);
  assert.ok(Math.abs(api.nd_emit_interval() - 1.6) < 1e-6);
  const lab = read('neural-dance/room-lab.js');
  // Emit interval reads the per-song locked BPM, never the live estimate.
  assert.match(lab, /songTempo\.update\(now,gtState&&gtState\.locked\?gtState\.bpm:0,!!gate\.open,/);
  assert.match(lab, /api\.nd_set_emit_bpm\(songTempo\.state\.locked\?songTempo\.state\.bpm:0\)/);
  assert.doesNotMatch(lab, /nd_set_emit_bpm\(gtState/);
});

test('repeated sub-peak hits build up to peak and emit on the crossing hit', async () => {
  const api = await load();
  api.nd_add(0, 0, 3);  // hi-hat, sens 1
  api.nd_add(40, 0, 1);
  let crossedAt = -1;
  for (let n = 0; n < 40 && crossedAt < 0; n++) {
    api.nd_hit(3);
    step(api);
    if (api.nd_emit_total() > 0) crossedAt = n;
    else assert.ok(dancer(api, 0).a < 1.75 || dancer(api, 0).hot, 'no emission while below peak');
    for (let i = 0; i < 14; i++) step(api); // 16ths at ~240 ms
  }
  assert.ok(crossedAt > 0, `crossed at hit ${crossedAt}`);
  assert.equal(api.nd_emit_total(), 1, 'exactly one emission on the crossing');
  assert.equal(dancer(api, 0).hot, 1);
});

test('the peak period lasts about 5 s before the forced rest', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 2);
  api.nd_add(0, 0, 0);
  let t = 0, hotAt = -1, restAt = -1;
  while (t < 9 && restAt < 0) {
    if (Math.round(t * 60) % 30 === 0) api.nd_hit(0); // kick every 0.5 s
    step(api);
    t += 1 / 60;
    const d = dancer(api, 0);
    if (hotAt < 0 && d.hot) hotAt = t;
    if (hotAt >= 0 && d.rest > 0) restAt = t;
    if (hotAt >= 0 && restAt < 0) assert.ok(d.a >= 1.75 - 1e-4, `held at peak, a ${d.a} at ${t.toFixed(2)}`);
  }
  const held = restAt - hotAt;
  assert.ok(held > 4.8 && held < 5.3, `peak held ${held.toFixed(2)} s`);
  const r = dancer(api, 0);
  assert.equal(r.hot, 0);
  assert.ok(r.rest > 1.4 && r.rest <= 1.6 + 1e-6, `rest ${r.rest}`);
});

test('during rest band hits keep it dancing at the low cap but send nothing', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 3);
  api.nd_set_peak_hold(0.3);
  api.nd_add(0, 0, 0);
  api.nd_add(40, 0, 1);
  let t = 0;
  while (dancer(api, 0).rest <= 0 && t < 3) {
    if (Math.round(t * 60) % 10 === 0) api.nd_hit(0);
    step(api);
    t += 1 / 60;
  }
  assert.ok(dancer(api, 0).rest > 0, 'entered rest');
  const cap = api.nd_rest_cap();
  const emits = api.nd_emit_total();
  const spawns = api.nd_spawn_total();
  for (let i = 0; i < 40; i++) step(api); // let leftover pulses land
  const neighbourBefore = dancer(api, 1).a;
  let maxA = 0, minA = 9;
  for (let n = 0; n < 4; n++) {
    api.nd_hit(0);
    step(api);
    const d = dancer(api, 0);
    assert.ok(d.rest > 0, 'still resting');
    maxA = Math.max(maxA, d.a);
    for (let i = 0; i < 6; i++) { step(api); minA = Math.min(minA, dancer(api, 0).a); }
  }
  assert.ok(maxA > cap - 0.05 && maxA <= cap + 1e-5, `rest hits reach the cap: ${maxA} vs ${cap}`);
  assert.ok(minA > 0, 'still moving, not frozen at zero');
  assert.equal(api.nd_emit_total(), emits, 'no emission during rest');
  assert.equal(api.nd_spawn_total(), spawns, 'no pulse during rest');
  assert.ok(dancer(api, 1).a <= neighbourBefore + 1e-6, 'no energy passed during rest');
});

test('a pulse landing on a resting dancer only nudges it up to the low cap', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 3);
  api.nd_set_band_sens(1, 3);
  api.nd_set_peak_hold(0.2);
  api.nd_set_link_radius(200);
  api.nd_add(0, 0, 0);
  api.nd_add(150, 0, 1);
  // Put the bass dancer into rest.
  for (let i = 0; i < 30 && dancer(api, 1).rest <= 0; i++) { api.nd_hit(1); step(api, 0.05); }
  assert.ok(dancer(api, 1).rest > 0);
  const before = api.nd_emit_total();
  api.nd_hit(0);
  step(api);
  let maxB = 0;
  for (let i = 0; i < 70; i++) { step(api); if (dancer(api, 1).rest > 0) maxB = Math.max(maxB, dancer(api, 1).a); }
  assert.ok(maxB <= api.nd_rest_cap() + 1e-5, `resting receiver ${maxB}`);
  assert.equal(api.nd_emit_total(), before + 1, 'only the kick emitted; the resting dancer did not relay');
});

test('after the music stops the network settles: no emissions and nobody stays at peak', async () => {
  const api = await load();
  for (let b = 0; b < 4; b++) api.nd_set_band_sens(b, [2.25, 1.1, 1, 3][b]);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) api.nd_add(80 + c * 100, 80 + r * 95, (r * 6 + c) % 4);
  api.nd_set_link_radius(130);
  const beat = 60 / 124;
  for (let f = 0; f < 60 * 12; f++) {
    const t = f / 60, t1 = t + 1 / 60;
    const on = (p, off) => Math.floor((t1 - off) / p) > Math.floor((t - off) / p);
    if (on(beat, 0)) api.nd_hit(0);
    if (on(beat, beat / 2)) api.nd_hit(1);
    if (on(beat * 2, beat)) api.nd_hit(2);
    if (on(beat / 2, 0)) api.nd_hit(3);
    step(api);
  }
  for (let i = 0; i < 90; i++) step(api); // 1.5 s of silence
  const emits = api.nd_emit_total();
  for (let i = 0; i < 300; i++) step(api);
  assert.equal(api.nd_emit_total(), emits, 'no self-sustaining cascade');
  for (let i = 0; i < 24; i++) assert.equal(api.nd_dancer_hot(i), 0);
  assert.equal(api.nd_pulse_count(), 0);
});

test('an energetic song lights the network; a sparse quiet one stays mostly below peak', async () => {
  async function run(pattern, sens) {
    const api = await load();
    for (let b = 0; b < 4; b++) api.nd_set_band_sens(b, sens[b]);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) api.nd_add(80 + c * 100, 80 + r * 95, (r * 6 + c) % 4);
    api.nd_set_link_radius(130);
    const beat = 60 / 124;
    const hot = new Set();
    for (let f = 0; f < 60 * 30; f++) {
      const t = f / 60, t1 = t + 1 / 60;
      const on = (p, off) => Math.floor((t1 - off) / p) > Math.floor((t - off) / p);
      for (const [band, p, off] of pattern(beat)) if (on(p, off)) api.nd_hit(band);
      step(api);
      for (let i = 0; i < 24; i++) if (api.nd_dancer_hot(i)) hot.add(i);
    }
    return {perMin: api.nd_spawn_total() * 2, hot: hot.size};
  }
  const energetic = await run(b => [[0, b, 0], [1, b, b / 2], [2, b * 2, b], [3, b / 2, 0]], [2.25, 1.1, 1, 3]);
  assert.ok(energetic.hot >= 20, `dancers that reached peak ${energetic.hot}/24`);
  assert.ok(energetic.perMin > 300, `pulses/min ${energetic.perMin}`);
  const sparse = await run(b => [[2, b * 2, b]], [1, 1, 1, 1]); // snare on 2 & 4 only
  assert.ok(sparse.perMin < energetic.perMin / 4, `sparse ${sparse.perMin} vs energetic ${energetic.perMin}`);
});

test('peak hold UI defaults to 5 s everywhere and 5 is in range', () => {
  const live = read('src/pages/neural-dance/live/index.astro');
  assert.match(live, /data-control="peak" type="range" min="1" max="8" step="0\.1" value="5"/);
  const room = read('src/pages/neural-dance/index.astro');
  assert.match(room, /data-control="peak" type="range" min="1" max="8" step="0\.1" value="5"/);
  const dbg = read('src/pages/neural-dance/debug/index.astro');
  assert.match(dbg, /data-debug-control="peak" type="range" min="1" max="8" step="0\.1" value="5"/);
  assert.match(read('neural-dance/debug-protocol.js'), /num\('peak', 1, 8\)/);
  const cmds = read('neural-dance/src/show-commands.js');
  assert.match(cmds, /: 5,\n/);
  assert.doesNotMatch(cmds, /peak[^\n]*2\.8/);
  const lab = read('neural-dance/room-lab.js');
  assert.match(lab, /roomNumber\(data\.peak, 1, 8\)/);
  assert.match(lab, /migratePeakHoldDefault\(null\)/);
});

test('a phone with the old 2.8 s default saved migrates to 5 s once; a custom value stays', async () => {
  const {migratePeakHoldDefault, readRoomSettings, ROOM_KEY} = await import('../neural-dance/room-lab.js');
  const make = data => {
    const store = new Map([[ROOM_KEY, JSON.stringify(data)]]);
    return {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
  };
  const old = make({peak: 2.8, gravity: 2.5});
  assert.equal(migratePeakHoldDefault(old), true);
  assert.equal(readRoomSettings(old).peak, 5);
  assert.equal(readRoomSettings(old).gravity, 2.5);
  old.setItem(ROOM_KEY, JSON.stringify({peak: 2.8}));
  assert.equal(migratePeakHoldDefault(old), false, 'runs once');
  const custom = make({peak: 3.6});
  migratePeakHoldDefault(custom);
  assert.equal(readRoomSettings(custom).peak, 3.6);
  const long = make({peak: 7.5});
  assert.equal(readRoomSettings(long).peak, 7.5, '8 s range is accepted');
});

// TJ Nov 11 2:46 PM: pulses sometimes vanished mid-flight on 82640fd (max
// lifetime ~2x travel, settle aging, cap eviction). Every pulse now ends in
// contact, even with wander, moving targets, resting targets, and stickers
// that disappear.
test('every spawned pulse ends in contact: randomized layouts, moving and vanishing targets', async () => {
  for (const seedNo of [3, 11, 29, 47]) {
    let seed = seedNo * 7919;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const api = await load();
    api.nd_set_gravity(1 + rnd() * 3);
    api.nd_set_wander(0.25 + rnd() * 0.5);
    for (let b = 0; b < 4; b++) api.nd_set_band_sens(b, [2.25, 1.1, 1, 3][b]);
    api.nd_set_peak_hold(1.5); // plenty of resting targets too
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(api.nd_add(rnd() * 700, rnd() * 450, i % 4));
    api.nd_set_link_radius(140);
    const pos = new Map(ids.map(id => [id, [rnd() * 700, rnd() * 450, (rnd() - 0.5) * 120, (rnd() - 0.5) * 120]]));
    const beat = 60 / (100 + rnd() * 50);
    for (let f = 0; f < 60 * 14; f++) {
      const t = f / 60, t1 = t + 1 / 60;
      const on = (p, o) => Math.floor((t1 - o) / p) > Math.floor((t - o) / p);
      if (t < 10) {
        if (on(beat, 0)) api.nd_hit(0);
        if (on(beat, beat / 2)) api.nd_hit(1);
        if (on(beat * 2, beat)) api.nd_hit(2);
        if (on(beat / 2, 0)) api.nd_hit(3);
      }
      // Targets wander around the stage.
      for (const [id, p] of pos) {
        p[0] += p[2] / 60; p[1] += p[3] / 60;
        if (p[0] < 0 || p[0] > 700) p[2] *= -1;
        if (p[1] < 0 || p[1] > 450) p[3] *= -1;
        api.nd_move(id, p[0], p[1]);
      }
      // Stickers come and go mid-song.
      if (f === 200 || f === 420) { const id = [...pos.keys()][Math.floor(rnd() * pos.size)]; api.nd_remove(id); pos.delete(id); }
      if (f === 300) { const id = api.nd_add(rnd() * 700, rnd() * 450, 3); pos.set(id, [350, 200, 40, -30]); }
      step(api);
    }
    for (let i = 0; i < 60 * 25 && api.nd_pulse_count(); i++) step(api);
    const spawned = api.nd_spawn_total();
    assert.ok(spawned > 50, `seed ${seedNo}: spawned ${spawned}`);
    assert.equal(api.nd_pulse_count(), 0, `seed ${seedNo}: pulses left in flight`);
    assert.equal(api.nd_pulse_faded_total(), 0, `seed ${seedNo}: leak guard fired`);
    assert.equal(api.nd_pulse_landed_total(), spawned, `seed ${seedNo}: landed ${api.nd_pulse_landed_total()} of ${spawned}`);
  }
});

test('a pulse whose target disappears retargets and lands; low power does not evict', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 2.25);
  api.nd_set_link_radius(200);
  api.nd_add(0, 0, 0);
  const b = api.nd_add(160, 0, 1);
  api.nd_add(120, 90, 2);
  api.nd_hit(0);
  step(api);
  const spawned = api.nd_spawn_total();
  assert.ok(spawned >= 2);
  for (let i = 0; i < 10; i++) step(api);
  api.nd_remove(b);
  api.nd_set_low(1);
  assert.equal(api.nd_pulse_count(), spawned, 'nothing dropped on removal or low power');
  for (let i = 0; i < 400 && api.nd_pulse_count(); i++) step(api);
  assert.equal(api.nd_pulse_landed_total(), spawned);
  assert.equal(api.nd_pulse_faded_total(), 0);
});

test('silence settle lands in-flight pulses instead of aging them out, and adds no energy', async () => {
  const api = await load();
  api.nd_set_band_sens(0, 2.25);
  api.nd_set_link_radius(200);
  api.nd_add(0, 0, 0);
  api.nd_add(150, 0, 1);
  api.nd_hit(0);
  step(api);
  const spawned = api.nd_spawn_total();
  for (let i = 0; i < 300 && api.nd_pulse_count(); i++) api.nd_settle(1 / 60);
  assert.equal(api.nd_pulse_count(), 0);
  assert.equal(api.nd_pulse_landed_total(), spawned);
  assert.ok(dancer(api, 1).a < 0.05, 'landing during silence adds no energy');
});

test('the 20 s leak guard fades a pulse out rather than popping it', () => {
  const src = read('neural-dance/src/neural_dance.cpp');
  assert.match(src, /constexpr float PULSE_HARD_LIFE = 20\.f;/);
  assert.match(src, /Leak guard: shrink in place, never pop/);
  assert.doesNotMatch(src, /Max-lifetime safety: drop a pulse/);
  assert.doesNotMatch(src, /while \(pulse_count > cap\) pulse_count--;/);
});
