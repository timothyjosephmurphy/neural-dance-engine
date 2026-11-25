// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural beat tracker worker (Listen nn mode). Runs Beat This! small0
// (CPJKU, ISMIR 2024; code + weights MIT, see THIRD_PARTY.md) with ONNX
// Runtime Web (MIT, single-threaded WASM) on the last 8 s of mic audio
// once per second for the first 8 runs (fast lock), then every 2 s (half
// the CPU), and posts beat / downbeat probabilities back.
import {createResampler, createMelStream, FPS, N_MELS} from './beat-mel.js';

const WIN = 400;            // frames (8 s at 50 fps)
const MIN_FRAMES = 100;     // start after 2 s
const EVERY = 50, EVERY_SLOW = 100, FAST_RUNS = 8; // frames between runs (1 s, then 2 s)
let ort = null, session = null, rs = null, mel = null, busy = false, stopped = false;
let ring = new Float32Array(WIN * N_MELS), frames = 0, firstT = NaN, sinceRun = 0, runs = 0;

function onFrame(f) {
  ring.copyWithin(0, N_MELS); ring.set(f, (WIN - 1) * N_MELS);
  frames++; sinceRun++;
}
async function run() {
  if (busy || !session || stopped) return;
  if (frames < MIN_FRAMES || sinceRun < (runs < FAST_RUNS ? EVERY : EVERY_SLOW)) return;
  busy = true; sinceRun = 0; runs++;
  const n = Math.min(frames, WIN);
  const x = ring.slice((WIN - n) * N_MELS);
  const tEnd = firstT + (frames - 1) / FPS, t0 = tEnd - (n - 1) / FPS;
  const c0 = performance.now();
  try {
    const out = await session.run({spect: new ort.Tensor('float32', x, [1, n, N_MELS])});
    const b = out.beat.data, d = out.downbeat.data;
    const pb = new Float32Array(n), pd = new Float32Array(n);
    for (let i = 0; i < n; i++) { pb[i] = 1 / (1 + Math.exp(-b[i])); pd[i] = 1 / (1 + Math.exp(-d[i])); }
    postMessage({type: 'result', tEnd, t0, fps: FPS, b: pb, d: pd, inferMs: performance.now() - c0}, [pb.buffer, pd.buffer]);
  } catch (err) {
    postMessage({type: 'error', msg: String(err && err.message || err)});
  }
  busy = false;
}
onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'init') {
      const c0 = performance.now();
      ort = await import(m.base + 'ort/ort.wasm.min.mjs');
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = m.base + 'ort/';
      session = await ort.InferenceSession.create(m.base + 'beat_this_small0.onnx', {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
      rs = createResampler(m.sampleRate); mel = createMelStream(onFrame);
      postMessage({type: 'ready', loadMs: performance.now() - c0});
    } else if (m.type === 'audio' && mel) {
      // Each mel frame is centred on its hop; frame 0 sits at the first sample.
      if (!Number.isFinite(firstT)) firstT = m.t;
      mel.push(rs.push(m.data));
      run();
    } else if (m.type === 'stop') { stopped = true; session = null; close(); }
  } catch (err) { postMessage({type: 'error', msg: String(err && err.message || err)}); }
};
