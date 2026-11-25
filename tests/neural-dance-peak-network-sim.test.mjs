// Side-sim peak pulse network (neural-dance/src/peak-network.js): same rules
// as the live engine, in the sim's 0..1 activation scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPeakNetwork, emitInterval, PEAK_LEVEL, REST_CAP, PEAK_HOLD_DEFAULT} from '../neural-dance/src/peak-network.js';

const sim = readFileSync(new URL('../static/neural-dance/sim/index.html', import.meta.url), 'utf8');
const trio = (raw, hits = {}) => ['bass', 'mid', 'high'].map((id, i) => ({id, band: id, x: 200 + i * 300, y: 200, raw: raw[id] ?? 0, hits: hits[id] | 0}));

function run(net, seconds, {raw = {}, hitEvery = {}, bpm = 0, dt = 1 / 60, onStep} = {}) {
  const t0 = net._t || 0;
  for (let f = 1; f <= Math.round(seconds / dt); f++) {
    const t = t0 + f * dt, tp = t - dt;
    const hits = {};
    for (const [id, p] of Object.entries(hitEvery)) if (p && Math.floor(t / p + 1e-9) > Math.floor(tp / p + 1e-9)) hits[id] = 1;
    net.step(t, trio(raw, hits), {bpm});
    if (onStep) onStep(t, hits);
    net._t = t;
  }
}

test('constants mirror the engine at half scale with a 5 s default peak', () => {
  assert.equal(PEAK_LEVEL, 0.875);
  assert.equal(REST_CAP, 0.35);
  assert.equal(PEAK_HOLD_DEFAULT, 5);
  assert.equal(createPeakNetwork().peakHold, 5);
});

test('hits below peak raise the dancer but send nothing', () => {
  const net = createPeakNetwork();
  run(net, 3, {raw: {mid: 0.4}, hitEvery: {mid: 1.0}});
  assert.equal(net.emitTotal, 0);
  assert.equal(net.pulses.length, 0);
  assert.ok(net.effective('mid', 0.4) > 0.4, 'charge lifts it a little');
  assert.equal(net.state('mid').hot, false);
});

test('at peak a dancer sends pulses to the others and they receive energy', () => {
  const net = createPeakNetwork();
  run(net, 0.11, {raw: {mid: 0.95}, hitEvery: {mid: 0.1}});
  assert.equal(net.state('mid').hot, true);
  assert.equal(net.emitTotal, 1);
  assert.equal(net.pulses.length, 2);
  assert.ok(net.state('bass').boost > 0);
});

for (const [bpm, expect] of [[90, 4 / 3], [120, 1], [150, 0.8]]) {
  test(`sim emit rate is one per ~2 beats at ${bpm} BPM`, () => {
    assert.ok(Math.abs(emitInterval(bpm) - expect) < 1e-9);
    const net = createPeakNetwork({peakHold: 30});
    const times = [];
    let last = 0;
    run(net, 10, {raw: {high: 0.95}, hitEvery: {high: 30 / bpm}, bpm, onStep: t => { if (net.state('high').emits > last) { times.push(t); last = net.state('high').emits; } }});
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - expect) < 0.05, `${bpm}: mean gap ${mean}`);
  });
}

test('unlocked tempo falls back to 1.0 s; interval clamps 0.6-1.6 s', () => {
  assert.equal(emitInterval(0), 1);
  assert.equal(emitInterval(undefined), 1);
  assert.equal(emitInterval(250), 0.6);
  assert.equal(emitInterval(60), 1.6);
});

test('peak lasts about 5 s, then rest caps it low while it keeps dancing, sending nothing', () => {
  const net = createPeakNetwork();
  let hotAt = -1, restAt = -1;
  run(net, 9, {raw: {mid: 0.95}, hitEvery: {mid: 0.25}, bpm: 120, onStep: t => {
    const s = net.state('mid');
    if (hotAt < 0 && s.hot) hotAt = t;
    if (hotAt >= 0 && restAt < 0 && s.rest > 0) restAt = t;
  }});
  assert.ok(restAt - hotAt > 4.9 && restAt - hotAt < 5.2, `held ${restAt - hotAt}`);
  // Fresh rest: hits keep coming, output is capped, no emission.
  const net2 = createPeakNetwork({peakHold: 0.5});
  run(net2, 1.0, {raw: {mid: 0.95}, hitEvery: {mid: 0.25}});
  assert.ok(net2.state('mid').rest > 0);
  const emits = net2.state('mid').emits;
  run(net2, 0.5, {raw: {mid: 0.95}, hitEvery: {mid: 0.25}});
  assert.ok(net2.state('mid').rest > 0);
  assert.equal(net2.state('mid').emits, emits);
  const out = net2.effective('mid', 0.95);
  assert.ok(out <= REST_CAP + 0.02 && out > 0.2, `rest output ${out}`);
});

test('after the music stops nothing keeps emitting and peaks end', () => {
  const net = createPeakNetwork();
  run(net, 4, {raw: {bass: 0.9, mid: 0.95, high: 0.95}, hitEvery: {bass: 0.5, mid: 0.5, high: 0.25}, bpm: 120});
  run(net, 1.5, {raw: {bass: 0.2, mid: 0.2, high: 0.2}});
  const emits = net.emitTotal;
  run(net, 5, {raw: {bass: 0.1, mid: 0.1, high: 0.1}});
  assert.equal(net.emitTotal, emits);
  for (const id of ['bass', 'mid', 'high']) assert.equal(net.state(id).hot, false);
  assert.equal(net.pulses.length, 0);
});

test('the side sim loads the network, shapes activation, steps it per frame, and paints pulses', () => {
  assert.match(sim, /import \* as peakNet from '\/neural-dance\/src\/peak-network\.js'/);
  assert.match(sim, /tryLoadSrc\('peak-network\.js'/);
  assert.match(sim, /function activationOf\(dancer, tSec\) \{\n    const raw = activationRaw\(dancer, tSec\);/);
  assert.match(sim, /stepPeakNetwork\(dancers, tSec\)/);
  assert.match(sim, /paintPeakNetwork\(ctx, dancers, tSec\)/);
  assert.match(sim, /id="peakPulses" type="checkbox" checked/);
  assert.match(sim, /id="peakHold" type="range" min="1" max="8" step="0\.1" value="5"/);
  assert.match(sim, /peakHold: 5,/);
  assert.match(sim, /net\.step\(tSec, list, \{ bpm \}\)/);
});
