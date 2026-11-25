// Listen nn mode (TJ 8:29 PM): Beat This! beat grid, flag, front end, wiring.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, statSync} from 'node:fs';
import {createBeatGrid} from '../neural-dance/src/beat-grid.js';
import {nnListenOn} from '../neural-dance/nn/nn-listen.js';
import {melFilterbank, createMelStream, createResampler, FPS, N_MELS} from '../neural-dance/nn/beat-mel.js';

const store = v => ({getItem: k => (k === 'nd.listen.nn' ? v : null)});

test('nn flag: on by default, ?listen=pattern / perband / legacy and nd.listen.nn=0 turn it off', () => {
  assert.equal(nnListenOn({search: ''}, store(null)), true);
  assert.equal(nnListenOn({search: '?listen=nn'}, store('0')), true);
  for (const q of ['?listen=pattern', '?listen=perband', '?listen=legacy', '?x=1&listen=pattern']) assert.equal(nnListenOn({search: q}, store(null)), false, q);
  assert.equal(nnListenOn({search: ''}, store('0')), false);
});

// Probabilities with a peak at each time in `ts` (ms), window [t0, tEnd].
function probs(t0, tEnd, ts, fps = 50) {
  const n = Math.round((tEnd - t0) / 1000 * fps) + 1, p = new Float32Array(n);
  for (const t of ts) { const i = Math.round((t - t0) / 1000 * fps); if (i >= 0 && i < n) { p[i] = 0.95; if (i > 0) p[i - 1] = Math.max(p[i - 1], 0.4); if (i + 1 < n) p[i + 1] = Math.max(p[i + 1], 0.4); } }
  return p;
}
function drive(grid, {beatMs = 500, nnBeatMs = beatMs, bar = 4, phase = 130, gt = 0, until = 20000}) {
  const beats = [], downs = [];
  let nextUp = 3000;
  for (let now = 0; now <= until; now += 16) {
    if (now >= nextUp) {
      const tEnd = now - 400, t0 = Math.max(0, tEnd - 8000);
      const bt = [], dt = [];
      for (let t = phase; t <= tEnd; t += nnBeatMs) bt.push(t);
      for (let t = phase; t <= tEnd; t += beatMs * bar) dt.push(t);
      grid.update(now, tEnd, t0, 50, probs(t0, tEnd, bt), probs(t0, tEnd, dt), gt);
      nextUp += 1000;
    }
    const s = grid.tick(now, gt);
    if (s.beat) beats.push(now); if (s.downbeat) downs.push(now);
  }
  return {beats, downs};
}
const err = (t, P, ph) => { const e = ((t - ph) % P + P) % P; return Math.min(e, P - e); };

test('beat grid locks to the network beats and fires downbeats on the bar', () => {
  const g = createBeatGrid();
  const {beats, downs} = drive(g, {});
  const late = beats.filter(t => t > 6000);
  assert.ok(late.length > 20, 'beats ' + late.length);
  for (const t of late) assert.ok(err(t, 500, 130) <= 24, 'beat off grid at ' + t);
  const lateDown = downs.filter(t => t > 8000);
  assert.ok(lateDown.length >= 4);
  for (const t of lateDown) assert.ok(err(t, 2000, 130) <= 24, 'downbeat off bar at ' + t);
  assert.equal(g.state.meter, 4);
  assert.ok(Math.abs(g.state.bpm - 120) < 1);
});

test('global tempo stays the tempo authority once locked (nn may only trim it by <= 3%)', () => {
  const g = createBeatGrid();
  drive(g, {gt: 500});
  assert.equal(g.state.own, false);
  assert.ok(Math.abs(g.state.period / 500 - 1) <= 0.03 + 1e-9);
  assert.ok(Math.abs(g.state.period - 500) < 3, 'same-tempo music: period ' + g.state.period);
});

test('network at double time (8ths) still lands on the quarter-note beats picked by its downbeats', () => {
  const g = createBeatGrid();
  const {beats} = drive(g, {nnBeatMs: 250, gt: 500});
  const late = beats.filter(t => t > 8000);
  assert.ok(late.length > 15);
  const off = late.filter(t => err(t, 500, 130) > 40).length;
  assert.ok(off <= 1, 'off-beat grid: ' + off + ' of ' + late.length);
});

test('no network beats for 4 s unlocks the grid (silence)', () => {
  const g = createBeatGrid();
  drive(g, {until: 10000});
  assert.equal(g.state.locked, true);
  for (let now = 10000; now < 16000; now += 16) g.tick(now, 0);
  assert.equal(g.state.locked, false);
});

test('mel front end: Slaney filterbank and a 1 kHz tone in the right band at 50 fps', () => {
  const fb = melFilterbank();
  assert.equal(fb.length, 513 * N_MELS);
  assert.equal(FPS, 50);
  const rs = createResampler(48000), frames = [];
  const ms = createMelStream(f => frames.push(Float32Array.from(f)));
  const x = new Float32Array(48000 * 2); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000);
  for (let i = 0; i < x.length; i += 2048) ms.push(rs.push(x.subarray(i, i + 2048)));
  assert.ok(Math.abs(frames.length - 100) <= 2, 'frames ' + frames.length);
  const f = frames[50]; let best = 0; for (let m = 1; m < N_MELS; m++) if (f[m] > f[best]) best = m;
  // Slaney: 30 Hz = 0.45 mel, 1 kHz = 15 mel, 11 kHz = 49.9 mel -> 1 kHz is band ~37.
  assert.ok(best >= 35 && best <= 39, 'peak band ' + best);
});

test('room-lab wires nn additively and only borrows its tempo before the global lock', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /import \{createNnListen, nnListenOn\} from '\.\/nn\/nn-listen\.js'/);
  assert.match(src, /if\(!gp&&g&&g\.locked&&g\.own&&typeof silhouetteShow\.setGlobalTempo==='function'\)silhouetteShow\.setGlobalTempo\(g\.period\)/);
  assert.match(src, /nn:nnListen\?nnListen\.snapshot\(\):null/);
  assert.match(src, /if\(listenPattern&&typeof location!=='undefined'&&nnListenOn\(/);
});

test('model, runtime and notices ship; build copies .onnx and .mjs', () => {
  const nn = new URL('../neural-dance/nn/', import.meta.url);
  assert.ok(statSync(new URL('beat_this_small0.onnx', nn)).size > 5e6);
  assert.ok(statSync(new URL('ort/ort-wasm-simd-threaded.wasm', nn)).size > 5e6);
  assert.ok(statSync(new URL('ort/ort.wasm.min.mjs', nn)).size > 1e4);
  assert.match(readFileSync(new URL('THIRD_PARTY.md', nn), 'utf8'), /MIT License[\s\S]*JKU Linz[\s\S]*Microsoft/);
  const build = readFileSync(new URL('../scripts/build-pages.mjs', import.meta.url), 'utf8');
  assert.match(build, /mjs\|json/); assert.match(build, /wasm\|onnx/);
});

// Fakes for the isolation tests: the mic source keeps its analyser edge no matter what nn does.
function fakeAudio({state = 'running', addModule = () => Promise.resolve()} = {}) {
  const edges = new Set(['analyser']);
  const src = {connect(n) { edges.add(n); }, disconnect(n) { if (n === undefined) throw new Error('nn must never disconnect the whole source'); edges.delete(n); }};
  const ac = {state, sampleRate: 48000, currentTime: 0, audioWorklet: {addModule}, suspend() { throw new Error('nn must not suspend'); }, resume() { throw new Error('nn must not resume'); }};
  return {ac, src, edges};
}
class FakeWorker { constructor() { FakeWorker.last = this; this.terminated = false; } postMessage(m) { this.sent = (this.sent || 0) + 1; } terminate() { this.terminated = true; } }
class FakeNode { constructor() { this.port = {postMessage() {}, onmessage: null}; } disconnect() {} }
async function withFakes(fn) {
  const g = globalThis, prev = {Worker: g.Worker, AudioWorkletNode: g.AudioWorkletNode};
  g.Worker = FakeWorker; g.AudioWorkletNode = FakeNode;
  try { await fn(); } finally { g.Worker = prev.Worker; g.AudioWorkletNode = prev.AudioWorkletNode; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const {createNnListen} = await import('../neural-dance/nn/nn-listen.js');

test('nn isolation: worker error turns nn off and only removes its own edge', () => withFakes(async () => {
  const {ac, src, edges} = fakeAudio();
  const nn = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10});
  nn.start(ac, src);
  assert.equal(nn.snapshot().state, 'waiting');
  await sleep(40);
  assert.equal(edges.size, 2, 'worklet edge added');
  FakeWorker.last.onerror({message: 'boom'});
  assert.equal(nn.snapshot().state, 'failed');
  assert.deepEqual([...edges], ['analyser']);
  assert.equal(FakeWorker.last.terminated, true);
  nn.start(ac, src); await sleep(20);
  assert.equal(nn.snapshot().state, 'failed', 'failed is sticky for the session');
  assert.deepEqual([...edges], ['analyser']);
}));

test('nn isolation: suspended context, no audio and addModule rejection all disable silently', () => withFakes(async () => {
  const a = fakeAudio({state: 'suspended'});
  const nn1 = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10});
  nn1.start(a.ac, a.src); await sleep(30);
  assert.notEqual(nn1.snapshot().state, 'running'); assert.deepEqual([...a.edges], ['analyser']);
  const b = fakeAudio();
  const nn2 = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10, noAudioMs: 30});
  nn2.start(b.ac, b.src); await sleep(120);
  assert.equal(nn2.snapshot().state, 'failed'); assert.match(nn2.snapshot().detail, /no audio/); assert.deepEqual([...b.edges], ['analyser']);
  const c = fakeAudio({addModule: () => Promise.reject(new Error('blocked'))});
  const nn3 = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10});
  nn3.start(c.ac, c.src); await sleep(40);
  assert.equal(nn3.snapshot().state, 'failed'); assert.deepEqual([...c.edges], ['analyser']);
  // Context leaves 'running' while nn runs -> nn stops itself.
  const d = fakeAudio();
  const nn4 = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10});
  nn4.start(d.ac, d.src); await sleep(30);
  d.ac.state = 'interrupted'; await sleep(30);
  assert.equal(nn4.snapshot().state, 'idle'); assert.deepEqual([...d.edges], ['analyser']);
  nn4.stop();
}));

test('nn isolation: a worker that stops answering is shut off (stall watchdog)', () => withFakes(async () => {
  const {ac, src, edges} = fakeAudio();
  const nn = createNnListen({base: 'http://x/', startDelayMs: 5, watchMs: 10, stallMs: 60});
  nn.start(ac, src); await sleep(30);
  FakeWorker.last.onmessage({data: {type: 'ready', loadMs: 1}});
  const node = [...edges].find(e => e !== 'analyser');
  const tickAudio = setInterval(() => node.port.onmessage && node.port.onmessage({data: {type: 'audio', t: 0, data: new Float32Array(4)}}), 5);
  await sleep(150); clearInterval(tickAudio);
  assert.equal(nn.snapshot().state, 'failed'); assert.match(nn.snapshot().detail, /stalled/);
  assert.deepEqual([...edges], ['analyser']);
}));

test('soak Nov 9: no beats while Listen hears silence, and the BPM readout never falls back to raw hit gaps', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /let beatMask=listening&&!gate\.open\?0:\(bandInfo\?bandHits:tones\);/);
  assert.match(src, /if\(!gate\.open\)bandHits=0;/);
  assert.match(src, /nnListen\.tick\(now,gp\)[^\n]*catch\{nnOff\(\);\}\}/, 'frame drops nn through nnOff (no .stop() in the frame)');
  assert.match(src, /bpm:gtState&&gtState\.locked\?Math\.round\(gtState\.bpm\):globalTempo\?\(nnListen&&nnListen\.snapshot\(\)\.bpm\?Math\.round\(nnListen\.snapshot\(\)\.bpm\):0\):silhouetteShow\.overallBpm\(now\),/);
});

test('nn load timeout retries twice before giving up (Nov 10 iPhone fresh load)', () => {
  const src = readFileSync(new URL('../neural-dance/nn/nn-listen.js', import.meta.url), 'utf8');
  assert.match(src, /LOAD_TIMEOUT_MS = 45000, LOAD_RETRIES = 2/);
  assert.match(src, /detail === 'load timeout' && retries < LOAD_RETRIES/);
});
