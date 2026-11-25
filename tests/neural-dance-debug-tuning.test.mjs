// Nov 9 7:11–7:13 PM: debug Live tuning controls reach the dancers, the
// panel syncs from the phone, Listen telemetry + 10 Hz audio feed, hat band
// from the real sample rate, softer per-band sensitivity, inset tempo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../neural-dance/silence-gate.js';
import '../neural-dance/wave-ring.js';
import {createSilhouetteShow, bandStringDrive, silhouetteBloom, cleanShowTuning, tempoReadout} from '../neural-dance/src/silhouette.js';
import {createPreviewListen} from '../neural-dance/src/debug-sim-preview.js';
import {SIM_DETAIL_CONTROLS} from '../neural-dance/src/sim-detail-controls.js';
import {simSilhouetteMarkers} from '../neural-dance/room-lab.js';
import {controlPatch, presetPatch, syncTuning, syncScanToggle, listenSummary, pushAudioSamples, CONTROL_FIELDS} from '../neural-dance/debug-viewer.js';
import {createDebugSimPreview, debugSimMarkers} from '../neural-dance/src/debug-sim-preview.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {collectTelemetry, createAudioFeed, AUDIO_SAMPLE_MS, AUDIO_BATCH} from '../neural-dance/live-debug.js';
import {continuousSensitivity, CONTINUOUS_SENS_CAP} from '../neural-dance/camera-markers.js';
import {createBandOnsets, detectorSensGain, hatBandHz, listenBandsHz, meterBandsHz, trackMicTopHz, LISTEN_BAND_HZ} from '../neural-dance/src/band-onsets.js';
import {NeuralDanceDebugRoom} from '../worker/neural-dance-debug.mjs';

const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
const roomSrc = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');

function fakeDoc(values) {
  const inputs = new Map();
  for (const [name, value] of Object.entries(values)) {
    const label = {classList: {set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }}};
    inputs.set(name, {value: String(value), disabled: false, dataset: {debugControl: name}, closest: () => label, label});
  }
  return {
    activeElement: null,
    body: {dataset: {}},
    inputs,
    querySelector(sel) {
      const m = /^\[data-debug-control="([^"]+)"\]$/.exec(sel);
      if (m) return inputs.get(m[1]) || null;
      if (sel === '[data-continuous-note]') return this.note || (this.note = {textContent: ''});
      return null;
    },
    querySelectorAll() { return []; }
  };
}
function recorder() {
  const target = {canvas: {width: 1000, height: 620}, fillText() {}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}
function paintWith(tune, setup) {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  if (tune) show.setTuning(tune);
  const sims = simSilhouetteMarkers([0, 1, 2, 3].map(b => ({id: 10 + b, x: 200 + b * 180, y: 300, type: b})));
  for (let t = 1000; t < 2600; t += 16) {
    if ((t - 1000) % 496 < 16) show.beat(t, 15);
    if (setup) setup(show, t);
    show.paint(recorder(), sims, {now: t, xy: (x, y) => ({x, y})});
  }
  return new Map(show.figureHeights().map(f => [f.band, f]));
}

test('1) ripple default matches live boot (0.20, TJ 11:31 AM); panel syncs ripple/slowdown; one slider sends only its own field', () => {
  assert.match(debugPage, /data-debug-control="ripple-intensity"[^>]*value="0\.20"/);
  const doc = fakeDoc({'ripple-intensity': 0.20, 'body-slowdown': 4, gravity: 2.5, 'sens-1': 1});
  syncTuning(doc, {controls: {rippleIntensity: 0.6, bodyMotionSlowdown: 6.5, gravity: 3}});
  assert.equal(doc.inputs.get('ripple-intensity').value, '0.6');
  assert.equal(doc.inputs.get('body-slowdown').value, '6.5');
  assert.equal(doc.body.dataset.tuningSynced, '1');
  // Moving gravity must not resend ripple intensity / slowdown.
  doc.inputs.get('gravity').value = '4';
  const patch = controlPatch(doc, 'gravity');
  assert.deepEqual(patch, {gravity: 4});
  const clean = sanitizeDebugPatch(patch);
  assert.equal(clean.rippleIntensity, undefined, 'ripple not reset by an unrelated slider');
  assert.equal(clean.bodyMotionSlowdown, undefined);
  // A single band slider leaves the other bands alone (null ≠ mute).
  const one = sanitizeDebugPatch(sanitizeDebugPatch(controlPatch(doc, 'sens-1')));
  assert.deepEqual(one.sens, [null, 1, null, null]);
  for (const name of Object.keys(CONTROL_FIELDS)) assert.match(debugPage, new RegExp('data-debug-control="' + name + '"'));
  // Telemetry carries the fields the panel syncs from.
  const room = {neuralDance: {debugRoom: () => ({ripple: {enabled: true, intensity: 0.7}}), bodyMotionSlowdown: () => 5, insets: () => true,
    listenTiming: () => ({detector: 'per-band', sampleRate: 44100, fftSize: 2048, bpm: 122, tiers: [{tier: 'band', bpm: 122}, {tier: 'shared'}, {tier: 'idle'}, {tier: 'band'}], hits: [[1, 2], [], [], [3]], now: 4})},
    querySelector: () => null};
  const tdoc = {getElementById: id => (id === 'nd-room-lab' ? room : null), querySelector: () => null, body: {classList: {contains: () => false}}};
  const tel = collectTelemetry(tdoc, 1);
  assert.equal(tel.controls.rippleIntensity, 0.7);
  assert.equal(tel.controls.bodyMotionSlowdown, 5);
  assert.equal(tel.controls.insetsEnabled, true);
  // a) Listen telemetry: sample rate, FFT, tiers, BPM, hits.
  assert.equal(tel.listen.sampleRate, 44100);
  assert.equal(tel.listen.fftSize, 2048);
  assert.equal(tel.listen.bpm, 122);
  assert.equal(tel.listen.tiers[1].tier, 'shared');
  const sum = listenSummary(tel.listen);
  assert.match(sum.head, /44\.1 kHz · FFT 2048/);
  assert.match(sum.head, /122 BPM/);
  assert.match(sum.bands[0], /^Kick · band · 122 BPM/);
  assert.match(debugPage, /data-debug-listen-info/);
  assert.match(roomSrc, /listenTiming\(\)\{[^\n]*sampleRate:sr,fftSize:[^\n]*hits:bandHitLog/);
});

test('2) band sensitivity + quiet threshold scale/gate the chakra string; 0 mutes', () => {
  const t0 = cleanShowTuning({sens: [0, 1, 3, 1]});
  assert.equal(bandStringDrive(t0, 0, 0.8, 0.5).envelope, 0);
  assert.equal(bandStringDrive(t0, 0, 0.8, 0.5).ampScale, 0);
  assert.ok(bandStringDrive(t0, 2, 0.3, 0).envelope > bandStringDrive(t0, 1, 0.3, 0).envelope);
  const quiet = cleanShowTuning({quiet: 0.3});
  assert.equal(bandStringDrive(quiet, 1, 0.25, 0).envelope, 0, 'below quiet → rest');
  assert.ok(bandStringDrive(quiet, 1, 0.8, 0).envelope > 0);
  const lo = paintWith({sens: [0, 0, 0, 0]});
  const hi = paintWith({sens: [3, 3, 3, 3]});
  for (let b = 0; b < 4; b++) {
    assert.equal(lo.get(b).pulseAmp, 0, 'band ' + b + ' muted string');
    assert.ok(hi.get(b).pulseAmp > 5, 'band ' + b + ' max sensitivity drives the string');
  }
  const q0 = paintWith({quiet: 0}), q4 = paintWith({quiet: 0.4});
  assert.ok([0, 1, 2, 3].some(b => q0.get(b).envB > q4.get(b).envB + 0.05), 'quiet threshold gates the string envelope');
  // Ring sensAt: 0 now mutes (was undefined → unity).
  assert.match(roomSrc, /rings\.sensAt=band=>\{const s=\+bandSens\[band\];return Number\.isFinite\(s\)\?Math\.max\(0,s\):undefined;\};/);
  assert.equal(globalThis.NeuralDanceRings.ringGain(0.5, {sens: 0}), 0);
  assert.match(roomSrc, /silhouetteShow\.setTuning\(\{sens:bandSens\.slice\(\)\}\)/);
  assert.match(roomSrc, /silhouetteShow\.setTuning\(\{quiet:\+v\}\)/);
});

test('3) bloom intensity + aura width drive the silhouette glow and string bloom', () => {
  const a = silhouetteBloom(cleanShowTuning({bloomIntensity: 0.25, bloomAura: 8}));
  const b = silhouetteBloom(cleanShowTuning({bloomIntensity: 2, bloomAura: 64}));
  assert.ok(b.glow >= a.glow * 7 && b.radius >= a.radius * 7);
  const lo = paintWith({bloomIntensity: 0.25, bloomAura: 8});
  const hi = paintWith({bloomIntensity: 2, bloomAura: 64});
  assert.ok(hi.get(1).glowDim > lo.get(1).glowDim * 4, 'glow alpha follows bloom intensity');
  assert.ok(hi.get(1).glowRadius > lo.get(1).glowRadius * 4, 'glow radius follows aura');
  assert.ok(hi.get(1).stringGlowWidth > lo.get(1).stringGlowWidth * 4, 'string bloom width follows aura');
  assert.match(roomSrc, /silhouetteShow\.setTuning\(\{bloomEnabled:b\.enabled,bloomIntensity:b\.intensity,bloomAura:b\.aura\}\)/);
});

test('4/7) pulse-trail labels with hints; band for next added dancer', () => {
  for (const label of ['Pulse gravity', 'Pulse wander', 'Re-fire threshold', 'Peak hold', 'Band for next added dancer']) assert.ok(debugPage.includes(label), label);
  for (const c of ['gravity', 'wander', 'threshold', 'peak', 'type']) assert.match(debugPage, new RegExp('data-debug-control="' + c + '"'));
  assert.ok((debugPage.match(/class="hint"/g) || []).length >= 4);
});

test('5) sticker sensitivity: whole 0.1–1 range changes the lit-frame value, never above the cap', () => {
  let prev = -1;
  for (let v = 0.1; v <= 1.0001; v += 0.05) {
    const c = continuousSensitivity(v);
    assert.ok(c > prev, 'monotonic at ' + v.toFixed(2));
    assert.ok(c <= CONTINUOUS_SENS_CAP + 1e-12);
    prev = c;
  }
  assert.equal(continuousSensitivity(0.35), 0.35, 'dark-room range unchanged');
  assert.ok(continuousSensitivity(0.8) > continuousSensitivity(0.6));
  assert.match(debugPage, /latched stickers stay until Rescan/);
});

test('6) scan timing greys out while continuous scan is off', () => {
  const doc = fakeDoc({'scan-interval': 4, 'scan-duration': 200});
  assert.equal(syncScanToggle(doc, 'off'), false);
  assert.equal(doc.inputs.get('scan-interval').disabled, true);
  assert.ok(doc.inputs.get('scan-duration').label.classList.set.has('is-off'));
  assert.match(doc.note.textContent, /off/);
  syncScanToggle(doc, 'black');
  assert.equal(doc.inputs.get('scan-interval').disabled, false);
  assert.match(debugPage, /data-continuous-note/);
});

test('b) per-band detector uses √slider; legacy mapping unchanged', () => {
  assert.equal(detectorSensGain(1), 1);
  assert.equal(detectorSensGain(0), 0);
  assert.ok(Math.abs(detectorSensGain(3) - Math.sqrt(3)) < 1e-12);
  assert.ok(Math.abs(detectorSensGain(2.25) - 1.5) < 1e-12);
  // Threshold actually divided by √3, not 3.
  const det = createBandOnsets();
  const bytes = new Uint8Array(1024);
  let t = 0;
  for (let i = 0; i < 40; i++) { for (let k = 0; k < bytes.length; k++) bytes[k] = 40 + ((i * 7 + k) % 5); det.process(bytes, 48000, 2048, t += 16, true, [3, 1, 1, 1]); }
  const thr3 = det.state.threshold[0];
  const det1 = createBandOnsets();
  t = 0;
  for (let i = 0; i < 40; i++) { for (let k = 0; k < bytes.length; k++) bytes[k] = 40 + ((i * 7 + k) % 5); det1.process(bytes, 48000, 2048, t += 16, true, [1, 1, 1, 1]); }
  const thr1 = det1.state.threshold[0];
  assert.ok(Math.abs(thr1 / thr3 - Math.sqrt(3)) < 1e-3, 'ratio ' + (thr1 / thr3));
  // Legacy wasm path still gets the raw slider.
  assert.match(roomSrc, /api\.nd_set_band_sens\(band,v\)/);
});

test('c) hat band follows the real sample rate / mic bandwidth (iPhone hat = 0)', () => {
  // A mic whose content stops at 4.5 kHz on a 48 kHz context: fixed 5–14 kHz reads 0.
  const sr = 48000, fft = 2048, hz = sr / fft;
  const bytes = new Uint8Array(fft / 2);
  for (let i = 1; i < bytes.length; i++) bytes[i] = i * hz < 4500 ? 120 : 0;
  const fixed = globalThis.ndSilenceGate.bandPeaks(bytes, sr, fft);
  assert.equal(fixed[3], 0, 'old fixed edges: hat reads exactly 0');
  const top = trackMicTopHz(0, bytes, sr, fft);
  assert.ok(top > 4000 && top < 4700, 'top ' + top);
  const adapted = globalThis.ndSilenceGate.bandPeaks(bytes, sr, fft, meterBandsHz(sr, top));
  assert.ok(adapted[3] > 0, 'hat now reads the top of the mic band');
  const hat = listenBandsHz(sr, top)[3];
  assert.ok(hat[1] <= top + 1 && hat[0] >= 2500 && hat[0] < hat[1]);
  // Low sample rates stay inside Nyquist; full-band mics keep 5–14 kHz.
  for (const rate of [8000, 16000, 22050, 44100]) {
    const [lo, hi] = hatBandHz(rate);
    assert.ok(hi <= rate / 2 && lo < hi, rate + ': ' + lo + '–' + hi);
  }
  assert.deepEqual(hatBandHz(48000, 20000), [5000, 14000]);
  assert.deepEqual(listenBandsHz(48000)[0], LISTEN_BAND_HZ[0]);
  // The detector sees hat flux from the adapted range.
  const det = createBandOnsets();
  const quiet = new Uint8Array(bytes.length);
  let t = 0;
  for (let i = 0; i < 30; i++) det.process(i % 2 ? bytes : quiet, sr, fft, t += 16, true, [1, 1, 1, 1], listenBandsHz(sr, top));
  assert.ok(det.state.flux[3] > 0 || det.state.threshold[3] > 0);
  assert.match(roomSrc, /bandOnsets\.process\(spec,sr,analyser\.fftSize,now,gate\.open,bandSens,bandsHz\)/);
});

test('audio feed: 10 Hz samples batched 5 per message, only while a viewer is connected', () => {
  assert.equal(AUDIO_SAMPLE_MS, 100);
  assert.equal(AUDIO_BATCH, 5);
  const sent = [];
  let seq = 0;
  const feed = createAudioFeed({sample: () => ({t: seq * 100, seq: seq++, lv: [0.1, 0.2, 0.3, 0.4], gate: true}), send: m => sent.push(m)});
  for (let i = 0; i < 20; i++) feed.tick();
  assert.equal(sent.length, 0, 'no viewer → nothing sent');
  feed.setViewers(1);
  for (let i = 0; i < 20; i++) feed.tick();
  assert.equal(sent.length, 4, '2 s at 10 Hz → 4 messages');
  assert.ok(sent.every(m => m.type === 'audio' && m.samples.length === 5));
  // Worker relays to viewers without storing.
  const got = [];
  const room = {viewers: new Set([{readyState: 1, send: x => got.push(JSON.parse(x))}])};
  assert.equal(NeuralDanceDebugRoom.prototype.relayAudio.call(room, sent[0]), true);
  assert.equal(got[0].type, 'audio');
  assert.equal(got[0].samples.length, 5);
  assert.equal(NeuralDanceDebugRoom.prototype.relayAudio.call({viewers: new Set()}, sent[0]), false);
  const ring = pushAudioSamples([], sent.flatMap(m => m.samples));
  assert.equal(ring.length, 20);
  assert.match(debugPage, /data-debug-audio-graph/);
});

test('inset tempo readout: band tracker BPM, shared tier, or —; meter slot reserved', () => {
  assert.equal(tempoReadout({band: 0, tier: 'band', locked: true, period: 484}), 'Kick · 124 BPM');
  assert.equal(tempoReadout({band: 1, tier: 'global'}), 'Bass · shared');
  assert.equal(tempoReadout({band: 2, tier: 'band', locked: false, period: 500}), 'Mid · — BPM');
  assert.equal(tempoReadout({band: 3, tier: 'idle'}), 'High · —');
  assert.equal(tempoReadout({band: 0, tier: 'band', locked: true, period: 500, meter: '4/4'}), 'Kick · 120 BPM · 4/4');
  assert.equal(tempoReadout({band: 0, tier: 'band', locked: true, period: 500, meter: 'guess'}), 'Kick · 120 BPM');
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const sims = simSilhouetteMarkers([0, 1, 2, 3].map(b => ({id: 20 + b, x: 200 + b * 180, y: 300, type: b})));
  for (let t = 1000; t < 3000; t += 16) {
    if ((t - 1000) % 496 < 16) show.beat(t, 1, {period: [484, 0, 0, 0], locked: [true, false, false, false]});
    show.paint(recorder(), sims, {now: t, xy: (x, y) => ({x, y})});
  }
  const kick = show.insetStates().find(s => s.band === 0);
  assert.equal(kick.tempo, 'Kick · 124 BPM');
  const other = show.insetStates().find(s => s.band === 2);
  assert.equal(other.tempo, 'Mid · shared');
});

test('debug page: one scan button, merged marker toggles, sim preview off until asked', () => {
  assert.equal((debugPage.match(/data-debug-action="scan-stickers"/g) || []).length, 1);
  assert.match(debugPage, /data-debug-sim-toggle[^>]*aria-pressed="false"/);
  assert.match(debugPage, /data-debug-sim-canvas[^>]*hidden/);
  assert.equal(debugPage.includes('data-debug-action="markers-on"'), false);
  assert.equal(debugPage.includes('data-debug-action="markers-off"'), false);
  assert.match(debugPage, /data-debug-run/);
  assert.match(debugPage, /data-debug-markers/);
  const one = debugSimMarkers(320, 200);
  assert.equal(one.length, 1);
  assert.equal(one[0].kind, 'sim');
  const inputs = new Map();
  const doc = {
    querySelector(sel) {
      const m = /data-debug-control="([^"]+)"/.exec(sel);
      if (!m) return null;
      if (!inputs.has(m[1])) inputs.set(m[1], {value: ''});
      return inputs.get(m[1]);
    }
  };
  const patch = presetPatch(doc, {gravity: 2.5, 'hue-spread': 0.1, bloom: 0.18});
  assert.equal(patch.gravity, 2.5);
  assert.equal(patch.hueSpread, 0.1);
  assert.equal(patch.bloomIntensity, 0.18);
  assert.equal(inputs.get('hue-spread').value, '0.1');
  let next = null;
  const canvas = {
    width: 320,
    height: 200,
    clientWidth: 320,
    clientHeight: 200,
    hidden: true,
    getContext() { return recorder(); }
  };
  const host = {
    devicePixelRatio: 1,
    requestAnimationFrame(fn) { next = fn; return 1; },
    cancelAnimationFrame() { next = null; }
  };
  const preview = createDebugSimPreview(canvas, () => ({levels: [0.2, 0.3, 0.1, 0.05], tuning: {hueSpread: 0.1, bloomIntensity: 0.18, sens: [1, 1, 1, 1]}}), host);
  assert.equal(preview.on(), false);
  assert.equal(next, null);
  preview.setOn(true);
  assert.equal(canvas.hidden, false);
  next(1000);
  assert.equal(preview.paints(), 1);
  next(1040);
  assert.equal(preview.paints(), 1, 'frames closer than 80 ms are skipped');
  next(1200);
  assert.equal(preview.paints(), 2);
  preview.setOn(false);
  assert.equal(preview.on(), false);
  assert.equal(canvas.hidden, true);
});

test('projection modes: dots, sticker silhouette, beat, and dancer', () => {
  assert.doesNotMatch(debugPage, /Pink notes/);
  assert.doesNotMatch(debugPage, /data-debug-light/);
  assert.doesNotMatch(debugPage, /data-mode="pink"/);
  assert.match(debugPage, /data-debug-draw="full"[^>]*aria-pressed="true"/);
  assert.match(debugPage, /data-debug-draw="dots"/);
  assert.match(debugPage, /Sticker silhouettes/);
  assert.match(debugPage, />Dancer</);
  assert.match(debugPage, /data-debug-draw="beat"/);
  const simAt = debugPage.indexOf('data-debug-sim-preview');
  const advancedAt = debugPage.indexOf('Advanced tuning');
  assert.ok(simAt > advancedAt, 'sim dancer sits at the bottom');
  assert.match(debugPage, /data-debug-sim-listen[^>]*aria-pressed="false"/);
  assert.match(debugPage, /Dancer details/);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  assert.equal(show.drawMode(), 'full');
  const ctx = recorder();
  const marker = [{id: 7, x: 180, y: 140, type: 1, kind: 'sim'}];
  const paintAt = (mode, now) => {
    show.setDrawMode(mode);
    show.beat(now, 15);
    show.paint(ctx, marker, {now, xy: (x, y) => ({x, y}), crowd: 1, levels: [0.8, 0.8, 0.4, 0.2], songOpen: true, insets: false});
    return show.drawReport();
  };
  const full = paintAt('full', 2000);
  const silhouette = paintAt('silhouette', 4000);
  const beat = paintAt('beat', 6000);
  let dotted = 0;
  show.setDrawMode('dots');
  show.paint(ctx, marker, {now: 8000, xy: (x, y) => ({x, y}), crowd: 1, levels: [0.8, 0.8, 0.4, 0.2], songOpen: true, insets: false, paintDots: list => { dotted = (list || []).length; }});
  const dots = show.drawReport();
  assert.equal(full.mode, 'full');
  assert.ok(full.strings > 0, 'Dancer draws the chakra string');
  assert.equal(silhouette.strings, 0);
  assert.equal(silhouette.beat, 0);
  assert.ok(silhouette.halos > 0, 'sticker silhouette shines');
  assert.equal(beat.strings, 0);
  assert.ok(beat.beat > 0, 'beat mode pulses');
  assert.ok(beat.halos > 0);
  assert.equal(dots.mode, 'dots');
  assert.equal(dots.strings, 0);
  assert.equal(dotted, 1, 'dots mode draws a dot, not a figure');
  assert.equal(show.mode(), 'dot');
  show.setDrawMode('full');
  assert.equal(show.mode(), 'silhouette', 'leaving dots returns to the figure');
  assert.equal(sanitizeDebugPatch({action: 'set-draw-mode', mode: 'beat'}).mode, 'beat');
  assert.equal(sanitizeDebugPatch({action: 'set-draw-mode', mode: 'dots'}).mode, 'dots');
  assert.equal(sanitizeDebugPatch({action: 'set-draw-mode', mode: 'nope'}), null);
  const hip = SIM_DETAIL_CONTROLS.find(item => item.key === 'hipEight');
  assert.equal(hip.value, 0.8);
  let asked = false;
  const listen = createPreviewListen({
    navigator: {mediaDevices: {getUserMedia() { asked = true; return Promise.reject(new Error('stop')); }}},
    setTimeout() { return 0; },
    clearTimeout() {},
    performance: {now: () => 0}
  });
  assert.equal(listen.asked(), false);
  assert.equal(listen.on(), false);
  return listen.start().then(() => { throw new Error('should reject'); }, () => {
    assert.equal(asked, true);
  });
});
