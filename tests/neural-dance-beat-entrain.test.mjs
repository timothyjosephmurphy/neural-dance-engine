// Beat entrainment (TJ Nov 11 2:29 PM): dancers stomp on every PREDICTED beat
// of the locked song tempo; real attacks only nudge phase and give on-beat
// boosts. Off-grid attacks are syncopation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBeatEntrain, snapBandRatio, ENTRAIN_LAG_MS} from '../neural-dance/src/beat-entrain.js';

const FRAME = 1000 / 60;
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Drive the entrainer: events = [{t (audio time), band}], heard at t + lag.
function drive(e, {bpm, t1, events, period = null, lag = ENTRAIN_LAG_MS, gate = () => true}) {
  const ev = events.slice().sort((a, b) => a.t - b.t);
  let i = 0; const steps = [], onBeat = [];
  for (let now = 0; now < t1; now += FRAME) {
    let on = 0;
    while (i < ev.length && ev[i].t + lag <= now) { on |= 1 << ev[i].band; i++; }
    const o = e.step(now, {bpm: typeof bpm === 'function' ? bpm(now) : bpm, gateOpen: gate(now), onsets: on, heard: on, period});
    for (let b = 0; b < 4; b++) {
      if (o.mask & (1 << b)) steps.push({t: now, band: b, pos: o.info.pos[b], accent: o.info.accent[b]});
      if (o.onBeat & (1 << b)) onBeat.push({t: now, band: b});
    }
  }
  return {steps, onBeat};
}
const beats = (bpm, t0, t1, band = 0, off = 0) => { const P = 60000 / bpm, a = []; for (let t = t0 + off; t < t1; t += P) a.push({t, band}); return a; };
const errTo = (t, bpm, off = 0) => { const P = 60000 / bpm; const x = (t - off) / P; return (x - Math.round(x)) * P; };

test('stomps land on every predicted beat, even where kicks are missing', () => {
  const e = createBeatEntrain();
  let s = 5; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const ev = beats(120, 200, 40000).filter((_, i) => i < 4 || rnd() > 0.35).map(b => ({...b, t: b.t + (rnd() - 0.5) * 30}));
  const {steps} = drive(e, {bpm: 120, t1: 40000, events: ev});
  const late = steps.filter(x => x.band === 0 && x.t > 10000);
  assert.ok(late.length >= 58, 'a step on every beat 10-40 s: ' + late.length); // 60 beats
  for (const x of late) assert.ok(Math.abs(errTo(x.t, 120, 200)) <= FRAME + 12, 'on the audio beat: ' + errTo(x.t, 120, 200).toFixed(1) + ' ms');
});

test('syncopated off-grid attacks do not drag the phase', () => {
  const e = createBeatEntrain();
  const P = 500;
  const ev = [...beats(120, 0, 30000), ...beats(120, 0, 30000, 0, 0.75 * P), ...beats(120, 0, 30000, 1, 0.25 * P + 10)];
  const {steps} = drive(e, {bpm: 120, t1: 30000, events: ev});
  const late = steps.filter(x => x.band === 0 && x.t > 8000);
  const worst = Math.max(...late.map(x => Math.abs(errTo(x.t, 120))));
  assert.ok(worst <= FRAME + 6, 'phase stays on the beat: ' + worst.toFixed(1) + ' ms');
});

test('a grid placed on a syncopated first hit pulls onto the beat within 8 bars', () => {
  const e = createBeatEntrain();
  const ev = [{t: 130, band: 0}, ...beats(120, 500, 30000)];
  const {steps} = drive(e, {bpm: 120, t1: 30000, events: ev});
  const after = steps.filter(x => x.band === 0 && x.t > 16000);
  assert.ok(after.every(x => Math.abs(errTo(x.t, 120)) <= FRAME + 10), 'converged: ' + after.slice(0, 3).map(x => errTo(x.t, 120).toFixed(0)).join(','));
});

test('real attacks on a predicted beat are flagged for the activation boost; off-beat ones are not', () => {
  const e = createBeatEntrain();
  const ev = [...beats(120, 0, 20000), ...beats(120, 0, 20000, 2, 250)];
  const {onBeat} = drive(e, {bpm: 120, t1: 20000, events: ev, period: [500, 0, 500, 0]});
  const kick = onBeat.filter(x => x.band === 0 && x.t > 5000).length, mid = onBeat.filter(x => x.band === 2 && x.t > 5000).length;
  assert.ok(kick >= 28, 'on-beat kicks flagged: ' + kick);
  assert.equal(mid, 0, 'half-beat-off mids are not on the beat');
});

test('each band steps at its own ratio of the beat, only while it plays', () => {
  const e = createBeatEntrain();
  const P = 500;
  const ev = [...beats(120, 0, 20000), ...beats(60, 0, 20000, 1), ...beats(240, 0, 10000, 3)];
  const {steps} = drive(e, {bpm: 120, t1: 20000, events: ev, period: [P, 2 * P, 0, P / 2]});
  const n = (b, a, z) => steps.filter(x => x.band === b && x.t >= a && x.t < z).length;
  assert.ok(Math.abs(n(0, 5000, 9000) - 8) <= 1, 'kick x1: ' + n(0, 5000, 9000));
  assert.ok(Math.abs(n(1, 5000, 9000) - 4) <= 1, 'bass x1/2: ' + n(1, 5000, 9000));
  assert.ok(Math.abs(n(3, 5000, 9000) - 16) <= 1, 'hats x2: ' + n(3, 5000, 9000));
  assert.equal(n(3, 15000, 20000), 0, 'hats stop stepping once they stop playing');
});

test('downbeat is learned from where kicks land; strides accent beat 1', () => {
  const e = createBeatEntrain();
  // Kick on 1 and 3 only, bar starts at 500 ms (beat index 1).
  const ev = beats(30, 500, 40000).flatMap(b => [b, {t: b.t + 1000, band: 0}]);
  const {steps} = drive(e, {bpm: 120, t1: 40000, events: ev});
  const late = steps.filter(x => x.band === 0 && x.t > 20000);
  for (const x of late) {
    const k = Math.round((x.t - 500) / 500) % 4;
    if (k === 0) assert.equal(x.accent, 1, 'beat 1 accented at ' + Math.round(x.t));
  }
});

test('no tempo lock: inactive, no predicted steps', () => {
  const e = createBeatEntrain();
  const {steps} = drive(e, {bpm: 0, t1: 5000, events: beats(120, 0, 5000)});
  assert.equal(steps.length, 0);
});

test('a re-lock to a new BPM keeps the phase: no double steps', () => {
  const e = createBeatEntrain();
  const ev = [...beats(124, 0, 20000), ...beats(128, 20000 + 60000 / 124 * 0, 40000)];
  const {steps} = drive(e, {bpm: t => t < 20000 ? 124 : 128, t1: 40000, events: ev});
  const k = steps.filter(x => x.band === 0);
  for (let i = 1; i < k.length; i++) assert.ok(k[i].t - k[i - 1].t >= 0.45 * 60000 / 128, 'gap ' + (k[i].t - k[i - 1].t).toFixed(0) + ' ms at ' + Math.round(k[i].t));
});

test('snapBandRatio maps tracked periods to grid ratios', () => {
  assert.equal(snapBandRatio(500, 500), 1);
  assert.equal(snapBandRatio(500, 1000), 0.5);
  assert.equal(snapBandRatio(500, 250), 2);
  assert.equal(snapBandRatio(500, 700), 0);
});

test('room wires entrainment after the nn driver and sends on-beat boosts', () => {
  const lab = read('neural-dance/room-lab.js');
  assert.match(lab, /import \{createBeatEntrain\} from '\.\/src\/beat-entrain\.js'/);
  assert.match(lab, /entrain\.step\(now,/);
  assert.match(lab, /nd_hit_on_beat/);
  assert.match(lab, /setGlobalTempo\(songTempo\.state\.locked\?60000\/songTempo\.state\.bpm/);
});

test('engine: an attack on a predicted beat boosts more than an off-grid one, still no pulse below peak', async () => {
  const wasm = readFileSync(new URL('../neural-dance/neural-dance.wasm', import.meta.url));
  const load = async () => { const api = (await WebAssembly.instantiate(wasm)).instance.exports; api.nd_clear(); api.nd_set_clock(0); api.nd_set_gravity(0); api.nd_set_wander(0); return api; };
  const act = api => { const f = new Float32Array(api.memory.buffer); return f[(api.nd_dancers() >>> 2) + 2]; };
  const run = async onBeat => {
    const api = await load();
    api.nd_set_band_sens(2, 0.5);
    api.nd_add(0, 0, 2);
    let t = 0; const a = [];
    for (let i = 0; i < 3; i++) {
      if (onBeat) api.nd_hit_on_beat(2); else api.nd_hit(2);
      t += 1 / 60; api.nd_update(1 / 60, 1, 0, 44100, 2048, t * 1000);
      a.push(act(api));
      for (let f = 0; f < 29; f++) { t += 1 / 60; api.nd_update(1 / 60, 1, 0, 44100, 2048, t * 1000); }
    }
    return {a, emits: api.nd_emit_total(), gain: api.nd_on_beat_gain()};
  };
  const off = await run(false), on = await run(true);
  assert.ok(on.gain > 1.2 && on.gain <= 2, 'gain ' + on.gain);
  assert.ok(on.a[0] > off.a[0] + 0.02, 'on-beat ' + on.a[0].toFixed(3) + ' > off-grid ' + off.a[0].toFixed(3));
  assert.equal(off.emits, 0);
});
