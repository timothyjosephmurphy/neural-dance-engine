// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Crowd fallback pages, loaded on top of the live page stack:
//   /neural-dance/demo/  one new roaming dancer per person-scan visit
//   /neural-dance/show/  9 PM - 4 AM clock-driven crowd, then soft static
// Sticker detection is off here: camera sticker lists are ignored and
// live-show.js skips every scan when body[data-nd-crowd] is set. Dancers
// still move to the phone mic exactly like the live show; this file only
// decides how many there are, where they stand, and the crowd energy.

import {createCrowd} from './src/crowd-sim.js';
import {CROWD_SURFACES, mergeSurfaces} from './src/crowd-surfaces.js';
import {createShowClock, crowdCount, formatClock, SHOW_LEN_MIN, SHOW_PEAK_MIN, SPEEDS} from './src/crowd-schedule.js';
import {createDemoTrigger} from './src/crowd-trigger.js';
import {visitCoveragePresent, VISIT_COVERAGE_OFF} from './src/visit-scan.js';
import {createEventDirector, eventModule, eventNames, eventRegistrySnapshot, restoreEventRegistry} from './src/crowd-events.js';
import {createFxLayer, drawPsy, drawStageLights, FX_H, FX_W, fxNames, fxRegistrySnapshot, restoreFxRegistry} from './src/crowd-fx.js';
import {moveById, moveIds, moveRegistrySnapshot, normalizeMove, parseMoveText, playSting, registerMove, restoreMoveRegistry} from './src/crowd-moves.js';
import {createDebutDirector, createLibraryDancing, drawCrystals, drawDebut, drawProps} from './src/crowd-live.js';
import {HOT_POLL_MS, RESTORE_KEY, allowedHot, createHotRegistry, hotPlan, hotUrl, restoreCrowd, serializeCrowd} from './src/crowd-hot.js';
import {createCaptureScheduler, createDropDetector} from './src/crowd-capture.js';
import {cleanCrowdText} from './debug-protocol.js';
import {crowdWhiteStillNow} from './live-show.js';

const MODE = document.body && document.body.dataset.ndCrowd;
const SHOW_KEY = 'nd.crowd.show.v1';
const UI_KEY = 'nd.crowd.panel.v1';
const SURFACE_KEY = 'nd.crowd.surfaces.v1';
const CAPTURE_KEY = 'nd.crowd.capture.v1';
const CAPTURE_JPEG_Q = 0.92;
const CAPTURE_B64_MAX = 1850000;
const ENGINE_CAP = 48;

function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

function room() { return document.getElementById('nd-room-lab'); }

function waitForRoom() {
  return new Promise(resolve => {
    const tick = () => {
      const r = room();
      if (r && r.dataset.roomReady === '1' && r.neuralDance && typeof r.neuralDance.setMarkers === 'function') resolve(r);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

const CSS = `
.nd-crowd-panel{position:fixed;left:max(8px,env(safe-area-inset-left));bottom:max(8px,env(safe-area-inset-bottom));z-index:1000006;display:grid;gap:6px;width:min(340px,92vw);padding:10px;border-radius:14px;background:rgba(12,14,20,.9);border:1px solid rgba(255,255,255,.16);color:#e8ecf6;font:500 13px/1.3 Inter,system-ui,sans-serif;touch-action:manipulation}
.nd-crowd-panel[data-hidden="1"]>*:not(.nd-crowd-top){display:none}
.nd-crowd-panel[data-hidden="1"]{width:auto;padding:4px;background:rgba(0,0,0,.35);opacity:.55}
.nd-crowd-top{display:flex;gap:6px;align-items:center;justify-content:space-between}
.nd-crowd-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.nd-crowd-panel button{min-height:44px;min-width:44px;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:#1b1f2c;color:#f4f6fb;font:600 14px Inter,system-ui,sans-serif}
.nd-crowd-panel button:active{filter:brightness(1.4)}
.nd-crowd-panel input[type=range]{width:100%;min-height:36px;accent-color:#81b7fc}
.nd-crowd-panel output{font-variant-numeric:tabular-nums;color:#fff}
.nd-crowd-read{font-variant-numeric:tabular-nums;color:#c5cada}
.nd-crowd-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6}
.nd-crowd-static{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;opacity:0;image-rendering:auto;filter:blur(.6px)}
body.nd-align-clean .nd-crowd-panel,body.nd-live-pattern .nd-crowd-panel,body.nd-live-aligning .nd-crowd-panel{display:none}
`;

function el(tag, attrs = {}, text = '') {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text) n.textContent = text;
  return n;
}

// Soft, low-contrast TV static on the projector layer (mapped onto the painting).
function createStatic(host) {
  const c = el('canvas', {class: 'nd-crowd-static', width: '200', height: '124', 'aria-hidden': 'true'});
  host.appendChild(c);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  let amount = 0, last = 0;
  return {
    set(v) { amount = Math.max(0, Math.min(1, +v || 0)); c.style.opacity = String(amount * 0.82); },
    frame(now) {
      if (amount <= 0.001 || now - last < 66) return;
      last = now;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 92 + Math.random() * 64; // low contrast, mid grey
        d[i] = g; d[i + 1] = g; d[i + 2] = g + 4; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
    amount: () => amount,
    canvas: c
  };
}

// Mic energy 0..1 from the room's audio envelopes (fast attack, slow release).
function createAudioEnergy() {
  let e = 0, peak = 0.35, t = 0;
  return {
    update(nd, now) {
      const dt = t ? Math.max(0, Math.min(0.25, (now - t) / 1000)) : 0;
      t = now;
      let raw = 0;
      try {
        const a = nd.debugAudio ? nd.debugAudio() : null;
        if (a && a.source === 'mic' && !a.silenceGate) {
          const lv = [a.kick, a.bass, a.snare, a.hat].map(v => Math.max(0, Math.min(1, +v || 0)));
          raw = 0.6 * Math.max(lv[0], lv[1]) + 0.4 * (lv[0] + lv[1] + lv[2] + lv[3]) / 4;
        }
      } catch {}
      peak = Math.max(raw, peak * Math.exp(-dt / 20), 0.25);
      const norm = Math.min(1, raw / peak);
      const tau = norm > e ? 0.35 : 2.5;
      e += (norm - e) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);
      return e;
    },
    value: () => e
  };
}

async function boot() {
  if (!MODE) return;
  const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
  const r = await waitForRoom();
  const nd = r.neuralDance;
  // Own the marker channel: camera sticker lists are ignored on crowd pages.
  const rawSetMarkers = nd.setMarkers.bind(nd);
  nd.setMarkers = function () { return null; };
  rawSetMarkers(null);

  const map = mergeSurfaces(CROWD_SURFACES, readJson(SURFACE_KEY));
  const simCount = () => { try { return (nd.simList() || []).length; } catch { return 0; } };
  const capFor = () => Math.max(4, Math.min(MODE === 'show' ? 44 : 36, ENGINE_CAP - simCount()));
  const crowd = createCrowd({map, cap: capFor(), seed: (Date.now() & 0xffff) + 1});
  // Seamless reload after a core update: put the crowd back where it was.
  let restoredFromUpdate = false;
  try {
    const snap = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null');
    sessionStorage.removeItem(RESTORE_KEY);
    restoredFromUpdate = restoreCrowd(crowd, snap);
  } catch { /* fresh crowd */ }
  const audio = createAudioEnergy();
  const projector = document.getElementById('nd-room-projector') || document.body;
  const veil = createStatic(projector);
  const trigger = createDemoTrigger();
  // Overlay effects, rare events and the white capture. Each piece keeps its
  // own state; the modules live in registries keyed by name (hot-update ready).
  const fxCanvas = el('canvas', {class: 'nd-crowd-fx', width: String(FX_W), height: String(FX_H), 'aria-hidden': 'true'});
  projector.appendChild(fxCanvas);
  const fx = createFxLayer(fxCanvas);
  const events = createEventDirector({onBegin: (mod, why) => { if (why === 'update') fx.start('new-highlight', {text: mod.label || mod.name}); }});
  // Live requests + hot updates (TJ Nov 24). Registries are snapshotted
  // before any hot module loads so a ROLLBACK can drop what they added.
  const hotReg = createHotRegistry([
    {snapshot: eventRegistrySnapshot, restore: restoreEventRegistry, names: eventNames},
    {snapshot: fxRegistrySnapshot, restore: restoreFxRegistry, names: fxNames},
    {snapshot: moveRegistrySnapshot, restore: restoreMoveRegistry, names: moveIds}
  ]);
  const debut = createDebutDirector();
  const libDance = createLibraryDancing();
  const localDebuts = [];
  let reqQueue = null, reqSkew = 0, reqBoost = 0, propsOn = (readJson(UI_KEY) || {}).props !== false, bpm = 120, stingCtx = null, debutPhase = '';
  let serverLibrary = [], pinned = null, pinKey = '', pendingUpdate = null, lastUpdate = null, reloading = false;
  const ensureSting = () => { try { if (!stingCtx) { const AC = window.AudioContext || window.webkitAudioContext; stingCtx = AC ? new AC() : null; } if (stingCtx && stingCtx.state === 'suspended') stingCtx.resume(); } catch { stingCtx = null; } return stingCtx; };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, ensureSting, {passive: true});
  const savedCap = readJson(CAPTURE_KEY) || {};
  const capture = createCaptureScheduler({lastAt: Number.isFinite(+savedCap.lastAt) ? +savedCap.lastAt : Date.now(), intervalMin: +savedCap.intervalMin || undefined, count: savedCap.count | 0, lastStyle: savedCap.style || ''});
  const drops = createDropDetector();
  const capStatus = {state: 'idle', lastName: savedCap.lastName || '', lastAt: +savedCap.lastAt || 0, thumb: '', note: '', stored: savedCap.stored | 0};
  let lightsOn = !!(readJson(UI_KEY) || {}).lights;
  let peakUntil = 0, capBusy = false, cue = {building: false, drop: false}, bands = {bass: 0, mid: 0, high: 0};
  const saveCap = () => writeJson(CAPTURE_KEY, {lastAt: capture.state().lastAt, intervalMin: capture.state().intervalMin, count: capture.state().count, lastName: capStatus.lastName, stored: capStatus.stored, style: capture.state().style});
  const savedShow = readJson(SHOW_KEY) || {};
  const clock = createShowClock({offsetMs: +savedShow.offsetMs || 0, speed: +savedShow.speed || 1, boost: +savedShow.boost || 0});
  let demoBoost = MODE === 'demo' ? (+(readJson(UI_KEY) || {}).boost || 0) : 0;
  let forcedPresentUntil = 0, coverageLatched = false, lastShowState = null, lastTune = -1, lastAdd = 0;
  const saveShow = () => writeJson(SHOW_KEY, {offsetMs: clock.offsetMs(), speed: clock.speed, boost: clock.boost});

  // ---- panel
  const ui = readJson(UI_KEY) || {};
  const panel = el('section', {class: 'nd-crowd-panel', 'aria-label': MODE === 'show' ? 'Show controls' : 'Demo controls', 'data-hidden': ui.hidden !== false ? '1' : '0'});
  const top = el('div', {class: 'nd-crowd-top'});
  const title = el('strong', {}, MODE === 'show' ? 'Show' : 'Demo');
  const read = el('span', {class: 'nd-crowd-read', 'data-crowd-read': ''});
  const hide = el('button', {type: 'button', 'data-crowd': 'hide', 'aria-label': 'Hide or show crowd controls'}, ui.hidden !== false ? 'Crowd' : 'Hide');
  top.append(title, read, hide);
  panel.appendChild(top);
  const setHidden = h => { panel.dataset.hidden = h ? '1' : '0'; hide.textContent = h ? 'Crowd' : 'Hide'; writeJson(UI_KEY, Object.assign(readJson(UI_KEY) || {}, {hidden: !!h})); };
  hide.addEventListener('click', () => setHidden(panel.dataset.hidden !== '1'));
  const row = () => { const d = el('div', {class: 'nd-crowd-row'}); panel.appendChild(d); return d; };
  const btn = (parent, label, key, fn, aria) => { const b = el('button', {type: 'button', 'data-crowd': key, 'aria-label': aria || label}, label); b.addEventListener('click', fn); parent.appendChild(b); return b; };
  const slider = (label, key, min, max, step, value, fn) => {
    const l = el('label', {class: 'nd-crowd-row', style: 'display:grid;gap:2px'});
    const o = el('output', {}, '');
    const i = el('input', {type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'data-crowd': key, 'aria-label': label});
    l.append(el('span', {}, label + ' '), o, i);
    i.addEventListener('input', () => fn(+i.value, o));
    panel.appendChild(l);
    return {input: i, out: o};
  };

  let scrub = null, boostCtl = null, speedOut = null;
  if (MODE === 'show') {
    const r1 = row();
    btn(r1, '−', 'slower', () => stepSpeed(-1), 'Slower');
    speedOut = el('output', {'data-crowd-speed': ''}, '1×'); r1.appendChild(speedOut);
    btn(r1, '+', 'faster', () => stepSpeed(1), 'Faster');
    btn(r1, '+15m', 'jump15', () => { clock.jump(15); saveShow(); }, 'Jump forward 15 minutes');
    btn(r1, '+1h', 'jump60', () => { clock.jump(60); saveShow(); }, 'Jump forward 1 hour');
    const r2 = row();
    btn(r2, 'Start', 'to-start', () => { clock.jumpToShowMinute(0); saveShow(); }, 'Jump to 9 PM start');
    btn(r2, 'Peak', 'to-peak', () => { clock.jumpToShowMinute(SHOW_PEAK_MIN - 10); saveShow(); }, 'Jump to just before the peak');
    btn(r2, 'End', 'to-end', () => { clock.jumpToShowMinute(SHOW_LEN_MIN - 3); saveShow(); }, 'Jump to 3 minutes before the 4 AM end');
    btn(r2, 'Live', 'reset', () => { clock.reset(); if (boostCtl) boostCtl.input.value = '0'; saveShow(); }, 'Back to the real clock, 1x, no boost');
    scrub = slider('Timeline', 'scrub', 0, SHOW_LEN_MIN + 10, 1, 0, v => { clock.jumpToShowMinute(v); saveShow(); });
    boostCtl = slider('Energy', 'boost', -0.5, 0.5, 0.05, clock.boost, (v, o) => { clock.setBoost(v); o.textContent = (v >= 0 ? '+' : '') + v.toFixed(2); saveShow(); });
    boostCtl.out.textContent = (clock.boost >= 0 ? '+' : '') + clock.boost.toFixed(2);
  } else {
    const r1 = row();
    btn(r1, 'Add dancer', 'add', () => addDancer('button'));
    btn(r1, 'Clear', 'clear', () => { crowd.dancers.length = 0; rawSetMarkers(null); });
    boostCtl = slider('Energy', 'boost', -0.5, 0.5, 0.05, demoBoost, (v, o) => { demoBoost = v; o.textContent = (v >= 0 ? '+' : '') + v.toFixed(2); writeJson(UI_KEY, Object.assign(readJson(UI_KEY) || {}, {boost: v})); });
    boostCtl.out.textContent = (demoBoost >= 0 ? '+' : '') + demoBoost.toFixed(2);
  }
  const hint = el('span', {class: 'nd-crowd-read'}, MODE === 'show'
    ? 'Keys: ←/→ ∓15 min · [ ] speed · ↑/↓ energy · 0 live · H hide'
    : 'A new dancer joins each time someone steps in and the floor clears. Keys: A add · ↑/↓ energy · H hide');
  panel.appendChild(hint);
  document.body.appendChild(panel);

  function stepSpeed(dir) {
    const i = SPEEDS.findIndex(s => s >= clock.speed - 1e-9);
    const cur = i < 0 ? SPEEDS.length - 1 : i;
    clock.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, cur + dir))]);
    saveShow();
  }
  function bumpBoost(d) {
    if (MODE === 'show') { clock.setBoost(clock.boost + d); if (boostCtl) { boostCtl.input.value = String(clock.boost); boostCtl.out.textContent = (clock.boost >= 0 ? '+' : '') + clock.boost.toFixed(2); } saveShow(); }
    else { demoBoost = Math.max(-0.5, Math.min(0.5, demoBoost + d)); if (boostCtl) { boostCtl.input.value = String(demoBoost); boostCtl.out.textContent = (demoBoost >= 0 ? '+' : '') + demoBoost.toFixed(2); } }
  }
  document.addEventListener('keydown', e => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === 'h' || k === 'H') setHidden(panel.dataset.hidden !== '1');
    else if (k === 'ArrowUp') bumpBoost(0.05);
    else if (k === 'ArrowDown') bumpBoost(-0.05);
    else if (MODE === 'show' && k === 'ArrowRight') { clock.jump(15); saveShow(); }
    else if (MODE === 'show' && k === 'ArrowLeft') { clock.jump(-15); saveShow(); }
    else if (MODE === 'show' && k === ']') stepSpeed(1);
    else if (MODE === 'show' && k === '[') stepSpeed(-1);
    else if (MODE === 'show' && k === '0') { clock.reset(); saveShow(); }
    else if (MODE === 'demo' && (k === 'a' || k === 'A')) addDancer('key');
    else return;
    e.preventDefault();
  });

  function addDancer(why) {
    crowd.cap = capFor();
    const res = crowd.add();
    lastAdd = performance.now();
    r.dataset.crowdLastAdd = why + ':' + res.id;
    return res;
  }

  // Person in frame, same signals the live visit loop reads.
  function personPresent(now) {
    if (now < forcedPresentUntil) return true;
    const camRoot = document.getElementById('nd-camera-mode');
    const cam = camRoot && camRoot.neuralDanceCamera;
    if (!cam) return false;
    const bgReady = cam.personBackgroundReady ? !!cam.personBackgroundReady() : false;
    if (!bgReady) { coverageLatched = false; return false; }
    const coverage = cam.personCoverage ? +cam.personCoverage() || 0 : 0;
    const person = !!(cam.personInView && cam.personInView());
    const readP = cam.lastPersonRead || null;
    const moving = !!(readP && readP.motion >= 0.02);
    const present = visitCoveragePresent(coverage, false, person, coverageLatched, moving);
    coverageLatched = present && (person || coverage >= VISIT_COVERAGE_OFF || (coverageLatched && moving));
    return present;
  }
  setInterval(() => {
    if (MODE !== 'demo') return;
    const now = Date.now();
    const step = trigger.observe({present: personPresent(now), now});
    r.dataset.crowdVisit = step.state;
    if (step.add) addDancer('visit');
  }, 400);

  // ---- main loop
  let lastT = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastT) / 1000) * fx.timeScale();
    lastT = now;
    const a = audio.update(nd, now);
    bands = readBands(nd);
    let energy = 0.5, boost = demoBoost;
    if (MODE === 'show') {
      const s = clock.state();
      lastShowState = s;
      energy = s.energy; boost = clock.boost;
      crowd.cap = capFor();
      const target = s.pos.inShow ? crowdCount(s.density, crowd.cap, 3) : 0;
      crowd.setCount(target, clock.speed > 5 ? 3 : 1);
      veil.set(s.staticAmount);
      if (s.staticAmount >= 1 && crowd.dancers.length) crowd.dancers.length = 0;
      // Intensity on top of the mic: busier footwork and arms as the night builds.
      const e = Math.max(0, Math.min(1, s.boostedEnergy));
      if (Math.abs(e - lastTune) > 0.04 && nd.setShowTuning) {
        lastTune = e;
        try { nd.setShowTuning({raveMoves: 0.5 + 0.95 * e, armPadSense: 0.7 + 0.8 * e}); } catch {}
      }
    }
    const peak = (now < peakUntil ? 0.35 * (peakUntil - now) / 20000 : 0) + reqBoost;
    crowd.step(dt, {audio: Math.min(1, a + peak), energy, boost: boost + peak});
    events.step(crowd, map, dt, Math.min(1, energy + boost + peak), a);
    stepLive(dt, energy + boost + peak);
    const markers = crowd.dancers.length ? crowd.markers() : null;
    rawSetMarkers(markers);
    if (MODE === 'show') stepCapture(lastShowState);
    paintFx(markers || [], now);
    veil.frame(now);
    paintReadout(a);
    requestAnimationFrame(frame);
  }
  let readAt = 0;
  function paintReadout(a) {
    const now = performance.now();
    if (now - readAt < 250) return;
    readAt = now;
    const n = crowd.activeCount();
    if (MODE === 'show' && lastShowState) {
      const s = lastShowState;
      read.textContent = formatClock(s.local) + ' · E ' + s.boostedEnergy.toFixed(2) + ' · ' + n + ' dancers' + (s.staticAmount > 0 ? ' · static' : '');
      if (speedOut) speedOut.textContent = (clock.speed >= 1 ? clock.speed : clock.speed.toFixed(2)) + '×';
      if (scrub && document.activeElement !== scrub.input) {
        const into = s.pos.inShow ? s.pos.minutes : SHOW_LEN_MIN + Math.min(10, s.pos.sinceEnd);
        scrub.input.value = String(Math.round(into));
        scrub.out.textContent = s.pos.inShow ? formatClock(s.local) : (s.pos.sinceEnd < 600 ? 'ended' : 'before 9 PM');
      }
    } else {
      read.textContent = n + ' dancers · mic ' + a.toFixed(2);
    }
    r.dataset.crowdCount = String(n);
  }
  requestAnimationFrame(frame);

  function readBands(ndApi) {
    try {
      const x = ndApi.debugAudio ? ndApi.debugAudio() : null;
      if (!x || x.silenceGate) return {bass: 0, mid: 0, high: 0};
      const v = k => Math.max(0, Math.min(1, +x[k] || 0));
      return {bass: Math.max(v('kick'), v('bass')), mid: v('snare'), high: v('hat')};
    } catch { return {bass: 0, mid: 0, high: 0}; }
  }

  let fxDirty = false;
  function paintFx(markers, now) {
    const dmt = MODE === 'show' ? capture.visual(Date.now()) : 0;
    const lighters = events.activeFx().some(f => f.fx === 'lighters');
    if (lighters && !fx.names().includes('lighters')) fx.start('lighters', {}, now);
    const crystals = crystalItems();
    if (!dmt && !lightsOn && !fx.activeCount() && !propsOn && !crystals.length && !debut.active()) {
      if (fxDirty) { fxCanvas.getContext('2d').clearRect(0, 0, FX_W, FX_H); fxDirty = false; }
      return;
    }
    fxDirty = true;
    const env = {W: FX_W, H: FX_H, markers, bands, audio: audio.value(), now};
    fx.draw(env, ctx => {
      if (propsOn) drawProps(ctx, map, env, crowd);
      if (lightsOn) drawStageLights(ctx, env, 1 - dmt);
      if (debut.active()) drawDebut(ctx, debut, markers, env);
      if (crystals.length) drawCrystals(ctx, crystals, Date.now(), env);
      if (dmt) drawPsy(ctx, capture.state().style, dmt, env);
    });
  }

  // ---- white capture (show mode)
  function stepCapture(s) {
    const now = Date.now();
    cue = drops.step(now, bands.bass);
    // Only while the show runs and the floor is not in its static rest.
    if (!s || !s.pos.inShow || s.staticAmount > 0) { if (capture.state().phase === 'idle') return; }
    const act = capture.step(now, cue);
    if (act === 'start-build') capStatus.state = 'build';
    if (act === 'go-white') takeStill(capture.state().reason);
  }
  async function takeStill(reason) {
    if (capBusy) return;
    capBusy = true;
    capStatus.state = 'white';
    let ok = false;
    try {
      const shot = await crowdWhiteStillNow(document, {fadeMs: 300});
      if (shot && shot.ok && shot.frame) {
        const takenAt = Date.now();
        const jpeg = encodeFrame(shot.frame);
        capStatus.thumb = thumbOf(shot.frame);
        if (jpeg) {
          ok = true;
          const res = await storeCapture({jpeg, takenAt, meta: {width: shot.frame.width, height: shot.frame.height, whiteMs: shot.settleMs | 0, trigger: reason, showClock: lastShowState ? formatClock(lastShowState.local) : ''}});
          capStatus.lastAt = takenAt;
          capStatus.lastName = res && res.name || capStatus.lastName;
          if (res && res.ok) capStatus.stored++;
          capStatus.note = res && res.ok ? 'saved ' + res.name : 'kept on this phone (' + ((res && res.reason) || 'upload failed') + ')';
        }
      } else capStatus.note = 'no still: ' + ((shot && shot.reason) || 'camera unavailable');
    } catch (err) {
      capStatus.note = 'no still: ' + ((err && err.message) || 'error');
    } finally {
      capture.finished(Date.now(), ok);
      capStatus.state = 'fade';
      saveCap();
      capBusy = false;
    }
  }
  function frameCanvas(frame, w, h) {
    const c = document.createElement('canvas');
    c.width = frame.width; c.height = frame.height;
    const cx = c.getContext('2d');
    cx.putImageData(new ImageData(new Uint8ClampedArray(frame.data.buffer || frame.data), frame.width, frame.height), 0, 0);
    if (!w) return c;
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    t.getContext('2d').drawImage(c, 0, 0, w, h);
    return t;
  }
  function encodeFrame(frame) {
    try {
      const c = frameCanvas(frame);
      for (const q of [CAPTURE_JPEG_Q, 0.85, 0.75, 0.6]) { const url = c.toDataURL('image/jpeg', q); if (url.length <= CAPTURE_B64_MAX) return url; }
      const w = Math.round(frame.width * 0.7), h = Math.round(frame.height * 0.7);
      const url = frameCanvas(frame, w, h).toDataURL('image/jpeg', 0.8);
      return url.length <= CAPTURE_B64_MAX ? url : null;
    } catch { return null; }
  }
  function thumbOf(frame) {
    try { const w = 160, h = Math.max(1, Math.round(160 * frame.height / frame.width)); return frameCanvas(frame, w, h).toDataURL('image/jpeg', 0.6); } catch { return ''; }
  }
  // Private storage: the studio debug room (same key as /debug/). When the
  // phone is not paired, the still waits in this phone's IndexedDB and is
  // uploaded on a later capture or the next minute's retry.
  function upload(item) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve({ok: false, reason: 'no debug link'}), 20000);
      document.dispatchEvent(new CustomEvent('nd-crowd-capture', {detail: {...item, done: res => { clearTimeout(t); resolve(res || {ok: false}); }}}));
    });
  }
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nd-crowd-captures', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pending', {keyPath: 'takenAt'});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode); const out = fn(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(out && out.result); tx.onerror = () => reject(tx.error);
    });
  }
  async function storeCapture(item) {
    const res = await upload(item);
    if (res && res.ok) { flushPending(); return res; }
    try { await idbDo('readwrite', st => st.put(item)); } catch { /* memory only */ }
    return res;
  }
  async function flushPending() {
    let list = [];
    try { list = await idbDo('readonly', st => st.getAll()) || []; } catch { return; }
    for (const item of list) {
      const res = await upload(item);
      if (!res || !res.ok) return;
      capStatus.stored++;
      try { await idbDo('readwrite', st => st.delete(item.takenAt)); } catch { return; }
    }
  }
  if (MODE === 'show') setInterval(() => { if (!capBusy) flushPending(); }, 60000);

  function requestCapture(force) {
    if (MODE !== 'show') return {ok: false, warning: 'show only'};
    const res = capture.request(Date.now(), {force: !!force});
    capStatus.note = res.ok ? (res.overrode ? 'override: capture inside the cooldown' : 'capture starting') : (res.warning === 'cooldown' ? 'cooldown: ' + res.remainingMin + ' min left. Send again with override to force.' : 'busy');
    if (res.ok) capStatus.state = 'build';
    return res;
  }

  // ---- remote commands (debug relay, studio key; see live-debug.js)
  let lastCmd = null;
  function runCommand(c) {
    if (!c || c.action !== 'crowd') return {ok: false};
    let res = {ok: true};
    if (c.op === 'speed') { clock.setSpeed(c.value); saveShow(); }
    else if (c.op === 'jump') { clock.jump(c.value); saveShow(); }
    else if (c.op === 'scrub') { clock.jumpToShowMinute(c.value); saveShow(); }
    else if (c.op === 'boost') { if (MODE === 'show') { clock.setBoost(c.value); saveShow(); } else demoBoost = Math.max(-0.5, Math.min(0.5, +c.value || 0)); syncBoost(); }
    else if (c.op === 'reset') { clock.reset(); saveShow(); syncBoost(); }
    else if (c.op === 'resume') { fx.start('clear-effects'); }
    else if (c.op === 'light') { setLights(!lightsOn); }
    else if (c.op === 'add') addDancer('remote');
    else if (c.op === 'clear') { crowd.dancers.length = 0; rawSetMarkers(null); }
    else if (c.op === 'event') res = events.trigger(c.name, crowd, map);
    else if (c.op === 'effect') {
      const text = cleanCrowdText(c.text || '');
      if ((c.name === 'message' || c.name === 'shout-out') && c.name === 'message' && !text) res = {ok: false, reason: 'type a message first'};
      else res = fx.start(c.name, {text, onZero: () => { peakUntil = performance.now() + 20000; fx.start('fireworks'); }});
    } else if (c.op === 'capture') res = requestCapture(c.force);
    else if (c.op === 'interval') { capture.setInterval(c.value); saveCap(); }
    else if (c.op === 'props') { propsOn = !propsOn; writeJson(UI_KEY, Object.assign(readJson(UI_KEY) || {}, {props: propsOn})); }
    else if (c.op === 'debut-kill') { const k = debut.kill(crowd); res = k ? {ok: true} : {ok: false, reason: 'no debut playing'}; if (k && k.item && k.item.id) api({op: 'finish', id: k.item.id}); }
    else if (c.op === 'requests-now') { pollRequests(); }
    else if (c.op === 'hot-check') { checkVersion(); }
    lastCmd = {op: c.op, name: c.name || '', ok: !!res.ok, note: res.reason || res.warning || '', at: Date.now()};
    return res;
  }
  document.addEventListener('nd-crowd-command', e => runCommand(e.detail));
  function setLights(on) { lightsOn = !!on; writeJson(UI_KEY, Object.assign(readJson(UI_KEY) || {}, {lights: lightsOn})); }
  function syncBoost() {
    const v = MODE === 'show' ? clock.boost : demoBoost;
    if (boostCtl) { boostCtl.input.value = String(v); boostCtl.out.textContent = (v >= 0 ? '+' : '') + v.toFixed(2); }
  }
  document.addEventListener('keydown', e => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'l' || e.key === 'L') setLights(!lightsOn);
    else if (MODE === 'show' && (e.key === 'c' || e.key === 'C')) requestCapture(e.shiftKey);
  });

  // ---- build, hot updates, rollback pin
  let build = {sha: '', builtAt: ''};
  let running = null;          // version.json this page runs: {version, core, hot}
  const loadedHot = {};
  async function fetchVersion() {
    try { const res = await fetch('/neural-dance/version.json', {cache: 'no-store'}); return res.ok ? await res.json() : null; } catch { return null; }
  }
  // Imports hot modules; announce = a live update (new things trigger once).
  async function loadHot(hotMap, announce) {
    const before = hotReg.names();
    for (const [name, hash] of Object.entries(hotMap || {})) {
      try { await import(hotUrl(name, hash)); loadedHot[name] = hash; } catch (err) { lastUpdate = {kind: 'error', at: Date.now(), note: name + ': ' + ((err && err.message) || 'import failed')}; }
    }
    const [newEvents, newFx, newMoves] = hotReg.diff(before);
    if (!announce) return {newEvents, newFx, newMoves};
    for (const name of newEvents) events.trigger(name, crowd, map, 'update');
    for (const name of newFx) if (!/wipe|highlight/.test(name)) fx.start(name, {text: ''});
    for (const id of newMoves) { const m = moveById(id); if (m) localDebuts.push({item: {id: 0, handle: m.by || 'live update', text: m.name}, prog: m}); }
    if (newEvents.length || newFx.length) fx.start('new-highlight', {text: [...newEvents.map(n => (eventModule(n) || {}).label || n), ...newFx].join(' + ')});
    return {newEvents, newFx, newMoves};
  }
  function syncLibrary(list) {
    for (const raw of list || []) { const m = normalizeMove(raw); if (m && !moveById(m.id)) try { registerMove(m); } catch { /* bad move */ } }
  }
  async function applyPin(pin) {
    const key = pin ? pin.version + ':' + JSON.stringify(pin.hot || {}) : '';
    if (key === pinKey) return;
    pinKey = key; pinned = pin || null;
    hotReg.resetToBase();
    for (const k of Object.keys(loadedHot)) delete loadedHot[k];
    syncLibrary(serverLibrary);
    await loadHot(allowedHot(running ? running.hot : {}, pinned), false);
    lastUpdate = {kind: pinned ? 'rollback' : 'unpin', at: Date.now(), note: pinned ? 'pinned to ' + String(pinned.version).slice(0, 7) : 'unpinned'};
    fx.start('update-wipe', {hue: pinned ? 200 : 40});
    if (!pinned) checkVersion();
  }
  async function checkVersion() {
    const next = await fetchVersion();
    if (!next || !running || reloading) return;
    const plan = hotPlan(running, next);
    if (plan.kind === 'none') return;
    if (pinned) { pendingUpdate = {version: next.version, kind: plan.kind}; return; }
    if (plan.kind === 'quiet') { running = next; return; }
    if (plan.kind === 'hot') {
      fx.start('update-wipe', {hue: 120});
      const got = await loadHot(Object.fromEntries(plan.load.map(n => [n, next.hot[n]])), true);
      running = next; pendingUpdate = null;
      lastUpdate = {kind: 'hot', at: Date.now(), note: plan.load.join(', ') + ' · new: ' + [...got.newEvents, ...got.newFx, ...got.newMoves].join(', ')};
      setBuild(next);
      api({op: 'build', build: next}); api({op: 'landed'});
      return;
    }
    // Core changed: reload once the floor is free (no debut, no white capture).
    pendingUpdate = {version: next.version, kind: 'reload'};
    if (debut.active() || localDebuts.length || capture.state().phase !== 'idle') return;
    reloading = true;
    try { sessionStorage.setItem(RESTORE_KEY, JSON.stringify(serializeCrowd(crowd))); } catch { /* fresh crowd after reload */ }
    fx.start('update-wipe', {hue: 300});
    api({op: 'landed'});
    setTimeout(() => location.reload(), 900);
  }
  function setBuild(v) {
    build = {sha: String(v.sha || v.commit || v.version || '').slice(0, 40), builtAt: String(v.builtAt || v.built || ''), core: String(v.core || ''), hot: Object.keys(v.hot || {}).length};
    r.dataset.crowdBuild = build.sha;
  }
  fetchVersion().then(async v => {
    if (!v) return;
    running = v; setBuild(v);
    await loadHot(v.hot, false);
    if (restoredFromUpdate) { fx.start('update-wipe', {hue: 300}); lastUpdate = {kind: 'reload', at: Date.now(), note: 'restored ' + crowd.dancers.length + ' dancers'}; }
    api({op: 'build', build: v});
  });
  setInterval(checkVersion, HOT_POLL_MS);

  // ---- live requests: queue (studio room), debuts, library
  function api(body) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve({ok: false, reason: 'timeout'}), 8000);
      document.dispatchEvent(new CustomEvent('nd-crowd-api', {detail: {body, done: res => { clearTimeout(t); resolve(res || {ok: false}); }}}));
    });
  }
  let reqBusy = false, reqNote = '';
  async function pollRequests() {
    if (reqBusy) return;
    reqBusy = true;
    try {
      const idle = !debut.active() && !localDebuts.length && capture.state().phase === 'idle' && !reloading;
      const res = await api(idle ? {op: 'claim'} : null);
      if (!res || !res.queue) { reqNote = (res && res.reason) || 'no queue'; return; }
      reqNote = '';
      reqQueue = res.queue; reqSkew = Date.now() - (+res.queue.now || Date.now());
      reqBoost = Math.max(0, Math.min(0.25, +res.queue.boost || 0));
      serverLibrary = res.library || []; syncLibrary(serverLibrary);
      if (running) await applyPin(res.queue.pin || null);
      const cur = debut.state();
      if (cur && cur.id) { const it = res.queue.items.find(i => i.id === cur.id); if (it && it.status === 'killed') debut.kill(crowd); }
      const item = res.result && res.result.item;
      if (item) startDebut(item, parseMoveText(item.text, {handle: item.handle}));
    } finally { reqBusy = false; }
  }
  setInterval(pollRequests, 2500);
  function startDebut(item, prog) {
    fx.start('update-wipe', {x: 380, y: 120, hue: 180});
    if (!debut.start(item, prog, crowd, map)) { if (item.id) api({op: 'finish', id: item.id}); return false; }
    debutPhase = 'approach';
    return true;
  }
  function stepLive(dt, energyNow) {
    try { const lt = nd.listenTiming && Math.random() < dt / 2 ? nd.listenTiming() : null; if (lt && +lt.bpm > 0) bpm = +lt.bpm; } catch { /* default tempo */ }
    if (!debut.active() && localDebuts.length && capture.state().phase === 'idle') { const n = localDebuts.shift(); startDebut(n.item, n.prog); }
    const run = debut.run();
    const st = debut.step(crowd, map, dt, bpm);
    if (st === 'perform' && debutPhase !== 'perform') playSting(ensureSting(), run.prog);
    if (st) debutPhase = st;
    if (st === 'done' || st === 'lost') {
      debutPhase = '';
      if (st === 'done') try { registerMove(run.prog); } catch { /* bad move */ }
      if (run.item.id) api({op: 'finish', id: run.item.id, move: st === 'done' ? run.prog : null}).then(() => pollRequests());
    }
    const lib = moveIds().map(moveById).filter(Boolean);
    libDance.step(crowd, lib, dt, Math.min(1, energyNow), bpm, d => d.featured || !!d.goal || !!d.huddle);
  }
  function crystalItems() {
    const out = [];
    if (!reqQueue) return out;
    const now = Date.now();
    for (const a of reqQueue.announce || []) out.push({id: 'u' + a.id, at: a.at + reqSkew, eta: a.etaAt + reqSkew, hue: 40});
    for (const i of reqQueue.items) if (i.status === 'queued' && i.eta) out.push({id: i.id, at: i.at + reqSkew, eta: i.eta + reqSkew});
    return out.filter(c => c.eta > now - 120000);
  }

  // Compact status the phone publishes to the remote (cleanTelemetry passes it).
  function telemetry() {
    const now = Date.now();
    const s = MODE === 'show' ? lastShowState : null;
    const cs = capture.state();
    return {
      mode: MODE, build: build.sha, dancers: crowd.activeCount(), cap: crowd.cap, audio: +audio.value().toFixed(3),
      show: s ? {clock: formatClock(s.local), inShow: !!s.pos.inShow, minutes: s.pos.inShow ? Math.round(s.pos.minutes) : null, energy: +s.energy.toFixed(3), boosted: +s.boostedEnergy.toFixed(3), static: +s.staticAmount.toFixed(2), speed: clock.speed, boost: clock.boost} : null,
      boost: MODE === 'show' ? clock.boost : demoBoost,
      lights: lightsOn, effects: fx.names(), events: events.state(), props: propsOn,
      live: {core: build.core || '', hot: Object.keys(loadedHot), pinned: pinned ? pinned.version : '', pendingUpdate, lastUpdate, debut: debut.state(), library: moveIds().length, libraryDancing: libDance.count(), reqBoost: +reqBoost.toFixed(3), bpm: Math.round(bpm), note: reqNote},
      capture: MODE === 'show' ? {style: cs.style, styles: cs.styles, count: cs.count, stored: capStatus.stored, phase: cs.phase, intervalMin: cs.intervalMin, cooldownMin: +(capture.cooldownLeftMs(now) / 60000).toFixed(1), forceInMin: +((capture.forceAt() - now) / 60000).toFixed(1), building: !!cue.building, lastName: capStatus.lastName, lastAt: capStatus.lastAt, note: capStatus.note, thumb: capStatus.thumb} : null,
      lastCmd
    };
  }

  // Test and debug hooks.
  window.ndCrowd = {
    mode: MODE, crowd, clock, map,
    addDancer: () => addDancer('api'),
    simulatePerson(ms = 2000) { forcedPresentUntil = Date.now() + ms; return forcedPresentUntil; },
    state: () => ({mode: MODE, count: crowd.activeCount(), show: MODE === 'show' ? clock.state() : null, audio: audio.value(), staticAmount: veil.amount(), adds: trigger.adds(), visit: r.dataset.crowdVisit || ''}),
    // Show state at a given real wall-clock time, ignoring the controls.
    stateAtWall: epochMs => createShowClock({now: +epochMs}).state(+epochMs),
    command: runCommand, telemetry, events, fx, capture, debut, libDance, startDebut, parseMoveText, checkVersion, applyPin, loadHot, pollRequests,
    get running() { return running; }, get pinned() { return pinned; },
    get build() { return build; },
    eventModule
  };
  r.dataset.crowdReady = '1';
}

boot();
