// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// One sim dancer on the debug page. Off until asked. Reuses the show's
// silhouette renderer and the same sim-marker shape as the stage. Draws at
// about 12 fps and only while the toggle is on, so a closed preview costs
// no frames.

import {createSilhouetteShow} from './silhouette.js';
import {simSilhouetteMarkers} from '../room-lab.js';
import {createBandOnsets, listenBandsHz} from './band-onsets.js';

export const DEBUG_SIM_FRAME_MS = 80;
const BEAT_MS = 520;
const MAX_DPR = 1.5;

function viewOf(canvas, host) {
  if (host) return host;
  const doc = canvas && canvas.ownerDocument;
  return (doc && doc.defaultView) || globalThis;
}

export function debugSimMarkers(width, height) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  return simSilhouetteMarkers([{id: 1, x: w * 0.5, y: h * 0.72, type: 1}]);
}

function layoutCanvas(canvas, view) {
  const dpr = Math.min(MAX_DPR, +view.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || Math.round(cssW * 0.62);
  const w = Math.max(160, Math.min(480, Math.round(cssW * dpr)));
  const h = Math.max(120, Math.min(300, Math.round(cssH * dpr)));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return {w, h};
}

export function createDebugSimPreview(canvas, read, host) {
  const view = viewOf(canvas, host);
  let show = null;
  let on = false;
  let rafId = 0;
  let lastDraw = 0;
  let lastBeat = 0;
  let paints = 0;
  let lastMs = 0;

  function ensure() {
    if (show) return show;
    show = createSilhouetteShow();
    show.setMode('silhouette');
    show.setInsets(false);
    return show;
  }

  function stopLoop() {
    if (rafId && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function tick(now) {
    rafId = 0;
    if (!on) return;
    if (typeof view.requestAnimationFrame === 'function') rafId = view.requestAnimationFrame(tick);
    const t = +now || 0;
    if (lastDraw && t - lastDraw < DEBUG_SIM_FRAME_MS) return;
    const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : t;
    lastDraw = t;
    try {
      const sample = typeof read === 'function' ? read() : null;
      const dancer = ensure();
      if (sample && sample.tuning) dancer.setTuning(sample.tuning);
      if (sample && sample.drawMode) dancer.setDrawMode(sample.drawMode);
      if (sample && Number.isFinite(+sample.slowdown)) dancer.setBodyMotionSlowdown(sample.slowdown);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const {w, h} = layoutCanvas(canvas, view);
      const levels = sample && Array.isArray(sample.levels) ? sample.levels : [0.15, 0.22, 0.1, 0.08];
      if (t - lastBeat >= BEAT_MS) {
        lastBeat = t;
        const hot = (+levels[0] || 0) > 0.45 || (+levels[1] || 0) > 0.45;
        dancer.beat(t, hot ? 15 : 3);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, w, h);
      dancer.paint(ctx, debugSimMarkers(w, h), {
        now: t,
        xy: (x, y) => ({x, y}),
        crowd: 1,
        levels,
        songOpen: true,
        insets: false,
        idTags: false,
        paintDots(list) {
          ctx.fillStyle = '#f4f6fb';
          for (const marker of list || []) {
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, Math.max(6, Math.min(w, h) * 0.04), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });
      paints += 1;
      const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : t;
      lastMs = t1 - t0;
    } catch {
      on = false;
      canvas.hidden = true;
      stopLoop();
    }
  }

  return {
    setOn(next) {
      const want = !!next;
      if (want === on) return on;
      on = want;
      canvas.hidden = !on;
      if (!on) stopLoop();
      else if (!rafId && typeof view.requestAnimationFrame === 'function') rafId = view.requestAnimationFrame(tick);
      return on;
    },
    on() { return on; },
    paints() { return paints; },
    lastMs() { return lastMs; }
  };
}

// Mic for the debug preview only. getUserMedia runs inside start(), so the
// page does not ask until Listen is turned on. Uses the same per-band onset
// detector as the show. Nothing here is sent to the projector.
export function createPreviewListen(host) {
  const view = host || globalThis;
  let running = false;
  let asked = false;
  let stream = null;
  let audio = null;
  let analyser = null;
  let spec = null;
  let onsets = null;
  let timer = 0;
  const levels = [0, 0, 0, 0];

  function stop() {
    running = false;
    if (timer) view.clearTimeout(timer);
    timer = 0;
    if (stream && stream.getTracks) stream.getTracks().forEach(track => { try { track.stop(); } catch { /* already stopped */ } });
    stream = null;
    if (audio && audio.close) audio.close().catch(() => {});
    audio = null;
    analyser = null;
    return false;
  }

  async function start() {
    if (running) return true;
    asked = true;
    const devices = view.navigator && view.navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== 'function') throw new Error('no mic');
    const got = await devices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
    const AC = view.AudioContext || view.webkitAudioContext;
    if (!AC) { got.getTracks().forEach(track => track.stop()); throw new Error('no audio'); }
    stream = got;
    audio = new AC();
    if (audio.resume) await audio.resume();
    analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    const source = audio.createMediaStreamSource(stream);
    source.connect(analyser);
    spec = new Uint8Array(analyser.frequencyBinCount);
    onsets = createBandOnsets();
    running = true;
    const tick = () => {
      if (!running) return;
      analyser.getByteFrequencyData(spec);
      const bands = listenBandsHz(audio.sampleRate);
      onsets.process(spec, audio.sampleRate, analyser.fftSize, view.performance ? view.performance.now() : Date.now(), true, [1, 1, 1, 1], bands);
      const snap = onsets.snapshot();
      for (let i = 0; i < 4; i++) levels[i] = snap[i] ? +snap[i].level || 0 : 0;
      timer = view.setTimeout(tick, 100);
    };
    tick();
    return true;
  }

  return {
    start,
    stop,
    on() { return running; },
    asked() { return asked; },
    levels() { return levels.slice(); }
  };
}
