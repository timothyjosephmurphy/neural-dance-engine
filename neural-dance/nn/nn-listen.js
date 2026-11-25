// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Listen nn mode (TJ 8:29 PM "make the listening smarter ... external
// libraries"): Beat This! small0 in a Web Worker on a tap of the mic, feeding
// src/beat-grid.js. Purely additive: the analyser path, band onsets, global
// tempo and pattern layer are unchanged. Any failure (no AudioWorklet, model
// load error, slow inference) turns nn off for the session and the page
// behaves exactly like ?listen=pattern.
import {createBeatGrid} from '../src/beat-grid.js';

const SLOW_MS = 900;     // median inference above this -> off (iPhone thermal guard)
const MAX_ERRORS = 3;

export function nnListenOn(loc, storage) {
  try {
    const q = loc && loc.search || '';
    if (/[?&]listen=(pattern|perband|per-band|legacy)\b/.test(q)) return false;
    if (/[?&]listen=nn\b/.test(q)) return true;
    return !storage || storage.getItem('nd.listen.nn') !== '0';
  } catch { return false; }
}

// Isolation (TJ reports Listen dropouts): nn never awaits on, suspends,
// resumes or rewires the mic -> analyser path. It only adds one
// source -> worklet edge (no outputs) and removes exactly that edge. It starts
// a few seconds after the mic is live, stops when the AudioContext leaves
// 'running', and any error, stall or slowness turns it off silently.
// Nov 10 (phone): a fresh iPhone load hit 'load timeout' and stayed off for
// the session. Load gets 45 s, and a load timeout retries twice.
const START_DELAY_MS = 1000, LOAD_TIMEOUT_MS = 45000, LOAD_RETRIES = 2, RETRY_DELAY_MS = 8000, NO_AUDIO_MS = 6000, STALL_MS = 12000, WATCH_MS = 2000;

export function createNnListen({base = new URL('./', import.meta.url).href, startDelayMs = START_DELAY_MS, watchMs = WATCH_MS, stallMs = STALL_MS, noAudioMs = NO_AUDIO_MS} = {}) {
  const grid = createBeatGrid();
  const st = {state: 'idle', detail: '', loadMs: 0, runs: 0, inferMs: 0, errors: 0};
  const infer = [];
  let ac = null, node = null, worker = null, src = null, gtPeriodMs = 0, token = 0;
  let startTimer = 0, watch = 0, startedAt = 0, lastAudio = 0, lastResult = 0, connectedAt = 0;
  const sticky = () => st.state === 'failed' || st.state === 'slow';
  function off(state, detail) {
    token++;
    try { clearTimeout(startTimer); clearInterval(watch); } catch {}
    startTimer = 0; watch = 0;
    if (!sticky() || state === 'failed' || state === 'slow') { st.state = state; st.detail = detail || ''; }
    const n = node, w = worker, s = src;
    node = null; worker = null; src = null;
    try { if (n) n.port.onmessage = null; } catch {}
    try { if (s && n) s.disconnect(n); } catch {}       // only our edge, never s.disconnect()
    try { if (n) { n.port.postMessage({type: 'stop'}); n.disconnect(); } } catch {}
    try { if (w) { w.onmessage = null; w.onerror = null; w.terminate(); } } catch {}
    try { grid.reset(); } catch {}
  }
  let retries = 0;
  const fail = (detail) => {
    if (detail === 'load timeout' && retries < LOAD_RETRIES && ac && src) {
      retries++;
      const c = ac, so = src;
      off('idle', detail + ' (retry ' + retries + ')');
      st.state = 'waiting';
      const my = token;
      startTimer = setTimeout(() => { if (my === token) { ac = c; src = so; launch(my).catch(err => { if (my === token) fail(String(err && err.message || err)); }); } }, RETRY_DELAY_MS);
      return;
    }
    off('failed', detail);
  };
  // Called right after the mic source is connected. Returns immediately.
  function start(context, source) {
    try {
      if (sticky()) return;
      off('idle');
      ac = context; src = source;
      if (!ac || !ac.audioWorklet || typeof Worker === 'undefined' || typeof AudioWorkletNode === 'undefined') { fail('no AudioWorklet'); return; }
      const my = token;
      st.state = 'waiting';
      startTimer = setTimeout(() => { if (my === token) launch(my).catch(err => { if (my === token) fail(String(err && err.message || err)); }); }, startDelayMs);
    } catch (err) { fail(String(err && err.message || err)); }
  }
  async function launch(my) {
    if (!ac || ac.state !== 'running' || !src) { off('idle', 'context not running'); return; }
    st.state = 'loading'; startedAt = performance.now(); lastAudio = 0; lastResult = 0; connectedAt = 0;
    watch = setInterval(watchdog, watchMs);
    const w = new Worker(base + 'beat-worker.js', {type: 'module'});
    worker = w;
    w.onerror = e => { if (my === token) fail('worker: ' + (e && e.message || 'error')); };
    w.onmessageerror = () => { if (my === token) fail('worker message'); };
    w.onmessage = e => { if (my !== token) return; try { onWorker(e.data || {}); } catch (err) { fail('result: ' + (err && err.message || err)); } };
    w.postMessage({type: 'init', sampleRate: ac.sampleRate, base});
    await ac.audioWorklet.addModule(base + 'capture-worklet.js');
    if (my !== token || !src) return;
    const n = new AudioWorkletNode(ac, 'nd-beat-capture', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit'});
    n.onprocessorerror = () => { if (my === token) fail('worklet'); };
    n.port.onmessage = e => { if (my !== token) return; const m = e.data; if (worker && m && m.type === 'audio') { lastAudio = performance.now(); try { worker.postMessage(m, [m.data.buffer]); } catch { fail('post'); } } };
    node = n;
    src.connect(n); connectedAt = performance.now();
  }
  function watchdog() {
    try {
      const now = performance.now();
      if (!ac || ac.state !== 'running') { off('idle', 'context ' + (ac ? ac.state : 'gone')); return; }
      if (st.state === 'loading' && now - startedAt > LOAD_TIMEOUT_MS) { fail('load timeout'); return; }
      if (connectedAt && !lastAudio && now - connectedAt > noAudioMs) { fail('no audio'); return; }
      if (st.state === 'running' && lastAudio && now - Math.max(lastResult, connectedAt) > stallMs) { fail('stalled'); return; }
    } catch (err) { fail('watchdog'); }
  }
  function onWorker(m) {
    if (m.type === 'ready') { st.state = 'running'; st.loadMs = Math.round(m.loadMs); return; }
    if (m.type === 'error') { if (++st.errors >= MAX_ERRORS) fail(m.msg); return; }
    if (m.type !== 'result' || !ac) return;
    lastResult = performance.now();
    st.runs++; infer.push(m.inferMs); if (infer.length > 15) infer.shift();
    const sorted = infer.slice().sort((a, b) => a - b); st.inferMs = Math.round(sorted[sorted.length >> 1]);
    if (infer.length >= 5 && st.inferMs > SLOW_MS) { off('slow', 'median ' + st.inferMs + ' ms'); return; }
    // AudioContext seconds -> performance.now() ms.
    const now = performance.now(), offset = now - ac.currentTime * 1000;
    grid.update(now, m.tEnd * 1000 + offset, m.t0 * 1000 + offset, m.fps, m.b, m.d, gtPeriodMs);
  }
  // Per frame: gtPeriod = locked global tempo period (ms) or 0.
  function tick(now, gtPeriod) {
    gtPeriodMs = gtPeriod > 0 ? gtPeriod : 0;
    if (st.state !== 'running') return null;
    try { return grid.tick(now, gtPeriodMs); } catch { fail('tick'); return null; }
  }
  function stop() { try { off('idle'); } catch {} }
  function snapshot() {
    const g = grid.state;
    return {state: st.state, detail: st.detail, loadMs: st.loadMs, runs: st.runs, inferMs: st.inferMs, locked: st.state === 'running' && g.locked, own: g.own, bpm: st.state === 'running' && g.locked ? g.bpm : 0, meter: g.meter || 0};
  }
  return {start, stop, tick, snapshot, grid, retries: () => retries};
}
