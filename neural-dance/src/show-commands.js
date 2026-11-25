// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// One command list for the live phone page and the debug page.
// Both sides send these payloads. reduceShowCommand is the only state
// transition, so a debug press and the matching phone press land on the
// same show state. Listen on the debug page asks the phone to use its mic.
// The phone must tap Listen once (a user gesture) before a remote Listen
// can open the microphone. That grant is remembered on the phone.

import {DANCER_LIMIT, SIM_BATCH} from './sim-layout.js';

export const MIC_READY_KEY = 'nd.mic.ready.v1';

export const MIC_NEEDS_GESTURE = 'Tap Listen once on the phone to allow the microphone. Remote Listen works after that.';
export const MIC_BLOCKED = 'Microphone blocked. Tap Listen on the phone and allow the microphone.';

export function micReadySaved(storage) {
  if (!storage || typeof storage.getItem !== 'function') return false;
  try { return storage.getItem(MIC_READY_KEY) === '1'; } catch { return false; }
}

export function writeMicReady(storage, on) {
  if (!storage) return false;
  try {
    if (on) storage.setItem(MIC_READY_KEY, '1');
    else storage.removeItem(MIC_READY_KEY);
    return true;
  } catch {
    return false;
  }
}

function cloneState(state) {
  return {
    listening: !!state.listening,
    mic: state.mic || 'off',
    micDetail: state.micDetail || 'Mic off',
    micGranted: !!state.micGranted,
    running: !!state.running,
    markersOn: !!state.markersOn,
    scanMode: state.scanMode || 'black',
    personPause: state.personPause !== false,
    gapScan: state.gapScan !== false,
    lightMode: state.lightMode === 'silhouette' ? 'silhouette' : 'dot',
    bloom: state.bloom !== false,
    simCount: state.simCount | 0,
    hidden: !!state.hidden,
    aligning: !!state.aligning,
    pattern: !!state.pattern,
    borderFit: !!state.borderFit,
    latencyTest: !!state.latencyTest,
    referenceCleared: !!state.referenceCleared,
    markersCleared: state.markersCleared | 0,
    reloadCount: state.reloadCount | 0,
    gravity: Number.isFinite(+state.gravity) ? +state.gravity : 2.5,
    wander: Number.isFinite(+state.wander) ? +state.wander : 0.25,
    threshold: Number.isFinite(+state.threshold) ? +state.threshold : 1.4,
    peak: Number.isFinite(+state.peak) ? +state.peak : 5,
    quiet: Number.isFinite(+state.quiet) ? +state.quiet : 0.08,
    type: state.type | 0,
    markerMode: state.markerMode || 'both',
    noteSensitivity: Number.isFinite(+state.noteSensitivity) ? +state.noteSensitivity : 0.45,
    stickerSensitivity: Number.isFinite(+state.stickerSensitivity) ? +state.stickerSensitivity : 0.5,
    personSensitivity: Number.isFinite(+state.personSensitivity) ? +state.personSensitivity : 0.35,
    hue: Number.isFinite(+state.hue) ? +state.hue : 32,
    minBlob: Number.isFinite(+state.minBlob) ? +state.minBlob : 22,
    scanInterval: Number.isFinite(+state.scanInterval) ? +state.scanInterval : 4,
    scanDuration: Number.isFinite(+state.scanDuration) ? +state.scanDuration : 200,
    bloomIntensity: Number.isFinite(+state.bloomIntensity) ? +state.bloomIntensity : 0.18,
    bloomAura: Number.isFinite(+state.bloomAura) ? +state.bloomAura : 22,
    hueSpread: Number.isFinite(+state.hueSpread) ? +state.hueSpread : 0.10,
    hipEight: Number.isFinite(+state.hipEight) ? +state.hipEight : 0.80,
    shoulderEight: Number.isFinite(+state.shoulderEight) ? +state.shoulderEight : 0.70,
    hipTwist: Number.isFinite(+state.hipTwist) ? +state.hipTwist : 0.80,
    shoulderTwist: Number.isFinite(+state.shoulderTwist) ? +state.shoulderTwist : 0.75,
    maxBodyTurn: Number.isFinite(+state.maxBodyTurn) ? +state.maxBodyTurn : 90,
    turnFreq: Number.isFinite(+state.turnFreq) ? +state.turnFreq : 0.70,
    eightDepth: Number.isFinite(+state.eightDepth) ? +state.eightDepth : 0.85,
    eightVert: Number.isFinite(+state.eightVert) ? +state.eightVert : 0.80,
    sens: Array.isArray(state.sens) ? state.sens.slice(0, 4) : [1, 1, 1, 1]
  };
}

export function freshShowState(extra = {}) {
  return cloneState({
    listening: false,
    mic: 'off',
    micDetail: 'Mic off',
    micGranted: false,
    running: false,
    markersOn: false,
    scanMode: 'black',
    personPause: true,
    gapScan: true,
    lightMode: 'dot',
    bloom: true,
    simCount: 0,
    hidden: false,
    aligning: false,
    pattern: false,
    borderFit: false,
    latencyTest: false,
    referenceCleared: false,
    markersCleared: 0,
    reloadCount: 0,
    gravity: 2.5,
    wander: 0.25,
    threshold: 1.4,
    peak: 5,
    quiet: 0.08,
    type: 1,
    markerMode: 'both',
    noteSensitivity: 0.45,
    stickerSensitivity: 0.5,
    personSensitivity: 0.35,
    hue: 32,
    minBlob: 22,
    scanInterval: 4,
    scanDuration: 200,
    bloomIntensity: 0.18,
    bloomAura: 22,
    hueSpread: 0.10,
    hipEight: 0.80,
    shoulderEight: 0.70,
    hipTwist: 0.80,
    shoulderTwist: 0.75,
    maxBodyTurn: 90,
    turnFreq: 0.70,
    eightDepth: 0.85,
    eightVert: 0.80,
    sens: [1, 1, 1, 1],
    ...extra
  });
}

function cycleScan(mode) {
  if (mode === 'black') return 'white';
  if (mode === 'white') return 'off';
  return 'black';
}

function applyNumbers(next, command) {
  const num = (key, field, lo, hi) => {
    if (!Number.isFinite(+command[key])) return;
    next[field] = Math.min(hi, Math.max(lo, +command[key]));
  };
  num('gravity', 'gravity', 0, 6);
  num('wander', 'wander', 0, 0.8);
  num('threshold', 'threshold', 1, 1.9);
  num('peak', 'peak', 1, 6);
  num('quietThreshold', 'quiet', 0, 0.4);
  num('noteSensitivity', 'noteSensitivity', 0.25, 1);
  num('stickerSensitivity', 'stickerSensitivity', 0, 1);
  num('personSensitivity', 'personSensitivity', 0, 1);
  num('hueTolerance', 'hue', 18, 80);
  num('minBlobSize', 'minBlob', 4, 200);
  num('scanInterval', 'scanInterval', 2, 12);
  num('scanDuration', 'scanDuration', 150, 250);
  num('bloomIntensity', 'bloomIntensity', 0, 2);
  num('hueSpread', 'hueSpread', 0, 1);
  num('hipEight', 'hipEight', 0, 1.5);
  num('shoulderEight', 'shoulderEight', 0, 1.5);
  num('hipTwist', 'hipTwist', 0, 1.5);
  num('shoulderTwist', 'shoulderTwist', 0, 1.5);
  num('maxBodyTurn', 'maxBodyTurn', 0, 90);
  num('turnFreq', 'turnFreq', 0, 1.5);
  num('eightDepth', 'eightDepth', 0, 1.5);
  num('eightVert', 'eightVert', 0, 1.5);
  num('bloomAura', 'bloomAura', 8, 64);
  if (command.markerMode === 'both' || command.markerMode === 'pink' || command.markerMode === 'stickers') next.markerMode = command.markerMode;
  if (Number.isFinite(+command.type)) next.type = Math.min(3, Math.max(0, Math.round(+command.type)));
  if (Array.isArray(command.sens)) {
    next.sens = [0, 1, 2, 3].map(index => {
      const value = +command.sens[index];
      return Number.isFinite(value) ? Math.min(3, Math.max(0, value)) : next.sens[index];
    });
  }
  if (command.personPause === true || command.personPause === false) next.personPause = command.personPause;
  if (command.gapScan === true || command.gapScan === false) next.gapScan = command.gapScan;
  if (command.scanMode === 'black' || command.scanMode === 'white' || command.scanMode === 'off') next.scanMode = command.scanMode;
  if (command.bloomEnabled === true || command.bloomEnabled === false) next.bloom = command.bloomEnabled;
}

export function reduceShowCommand(state, command) {
  const next = cloneState(state || {});
  const action = command && command.action;
  if (!command || typeof command !== 'object') return next;
  if (command.gesture === true) next.micGranted = true;
  applyNumbers(next, command);
  if (action === 'listen') {
    if (!next.micGranted) {
      next.listening = false;
      next.mic = 'needs-gesture';
      next.micDetail = MIC_NEEDS_GESTURE;
    } else {
      next.listening = true;
      next.mic = 'listening';
      next.micDetail = 'Mic on';
      next.running = true;
    }
  } else if (action === 'stop-listen') {
    next.listening = false;
    next.mic = next.micGranted ? 'muted' : 'off';
    next.micDetail = next.micGranted ? 'Muted' : 'Mic off';
  } else if (action === 'mic-blocked') {
    next.listening = false;
    next.micGranted = false;
    next.mic = 'blocked';
    next.micDetail = MIC_BLOCKED;
  } else if (action === 'start') {
    next.running = true;
  } else if (action === 'pause') {
    next.running = false;
  } else if (action === 'clear-markers') {
    next.markersCleared += 1;
    next.referenceCleared = true;
  } else if (action === 'markers-on') {
    next.markersOn = true;
  } else if (action === 'markers-off') {
    next.markersOn = false;
  } else if (action === 'clear-sim' || action === 'sim-off') {
    next.simCount = 0;
  } else if (action === 'sim-on') {
    next.simCount = Math.max(next.simCount | 0, SIM_BATCH);
  } else if (action === 'sim-seed') {
    // Each Seed adds a batch (TJ Nov 11 3:12 PM), capped like room-lab.
    next.simCount = Math.min(DANCER_LIMIT, (next.simCount | 0) + SIM_BATCH);
  } else if (action === 'cycle-scan') {
    next.scanMode = cycleScan(next.scanMode);
  } else if (action === 'toggle-person') {
    next.personPause = !next.personPause;
  } else if (action === 'toggle-gap-scan') {
    next.gapScan = !next.gapScan;
  } else if (action === 'toggle-bloom') {
    next.bloom = !next.bloom;
  } else if (action === 'toggle-light') {
    next.lightMode = next.lightMode === 'silhouette' ? 'dot' : 'silhouette';
  } else if (action === 'set-light-mode' && (command.mode === 'dot' || command.mode === 'silhouette')) {
    next.lightMode = command.mode;
  } else if (action === 'toggle-pattern') {
    next.pattern = !next.pattern;
  } else if (action === 'align') {
    next.aligning = true;
  } else if (action === 'cancel-align') {
    next.aligning = false;
  } else if (action === 'align-border') {
    next.borderFit = true;
  } else if (action === 'hide-controls') {
    next.hidden = true;
  } else if (action === 'show-controls') {
    next.hidden = false;
  } else if (action === 'reset-camera') {
    next.hue = 32;
    next.noteSensitivity = 0.45;
    next.minBlob = 22;
  } else if (action === 'reload') {
    next.reloadCount += 1;
  } else if (action === 'latency-test') {
    // One click starts a timed run. Clearing is done by the camera timer.
    next.latencyTest = true;
  }
  return next;
}

const same = (command) => ({phone: () => command, debug: () => command});

export const SHOW_CONTROLS = [
  {
    id: 'listen',
    phone: (state) => (state && state.listening ? {action: 'stop-listen'} : {action: 'listen', gesture: true}),
    debug: (state) => ({action: state && state.listening ? 'stop-listen' : 'listen'})
  },
  {id: 'stop-listen', ...same({action: 'stop-listen'})},
  {id: 'start', ...same({action: 'start'})},
  {id: 'pause', ...same({action: 'pause'})},
  {id: 'clear-markers', ...same({action: 'clear-markers'})},
  {id: 'markers-on', ...same({action: 'markers-on'})},
  {id: 'markers-off', ...same({action: 'markers-off'})},
  {id: 'clear-sim', ...same({action: 'clear-sim'})},
  {id: 'sim-seed', ...same({action: 'sim-seed'})},
  {id: 'cycle-scan', ...same({action: 'cycle-scan'})},
  {id: 'toggle-person', ...same({action: 'toggle-person'})},
  {id: 'toggle-gap-scan', ...same({action: 'toggle-gap-scan'})},
  {id: 'toggle-bloom', ...same({action: 'toggle-bloom'})},
  {id: 'toggle-light', ...same({action: 'toggle-light'})},
  {id: 'toggle-pattern', ...same({action: 'toggle-pattern'})},
  {id: 'align', ...same({action: 'align'})},
  {id: 'cancel-align', ...same({action: 'cancel-align'})},
  {id: 'align-border', ...same({action: 'align-border'})},
  {id: 'hide-controls', ...same({action: 'hide-controls'})},
  {id: 'show-controls', ...same({action: 'show-controls'})},
  {id: 'reset-camera', ...same({action: 'reset-camera'})},
  {id: 'reload', ...same({action: 'reload'})},
  {id: 'latency-test', ...same({action: 'latency-test'})},
  {id: 'scan-stickers', ...same({action: 'scan-stickers'})},
  {id: 'gravity', ...same({gravity: 4})},
  {id: 'wander', ...same({wander: 0.4})},
  {id: 'threshold', ...same({threshold: 1.2})},
  {id: 'peak', ...same({peak: 3.2})},
  {id: 'quiet', ...same({quietThreshold: 0.12})},
  {id: 'marker-mode', ...same({markerMode: 'stickers'})},
  {id: 'note', ...same({noteSensitivity: 0.7})},
  {id: 'sticker', ...same({stickerSensitivity: 0.8})},
  {id: 'person-sensitivity', ...same({personSensitivity: 0.2})},
  {id: 'hue', ...same({hueTolerance: 40})},
  {id: 'size', ...same({minBlobSize: 30})},
  {id: 'scan-interval', ...same({scanInterval: 6})},
  {id: 'scan-duration', ...same({scanDuration: 220})},
  {id: 'bloom-intensity', ...same({bloomIntensity: 1.4})},
  {id: 'bloom-aura', ...same({bloomAura: 30})},
  {id: 'type', ...same({type: 2})},
  {id: 'sens', ...same({sens: [1.5, 0.5, 1, 2]})}
];

export function pressShowControl(id, origin, state) {
  const control = SHOW_CONTROLS.find(item => item.id === id);
  if (!control) return null;
  const source = origin === 'debug' ? control.debug : control.phone;
  return source(state || freshShowState());
}

export function dispatchShowCommand(doc, command) {
  if (!doc || !command) return false;
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  if (nd && typeof nd.applyShowCommand === 'function') nd.applyShowCommand(command);
  const camRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
  const camera = camRoot && camRoot.neuralDanceCamera;
  if (camera && typeof camera.applyShowCommand === 'function') camera.applyShowCommand(command);
  return true;
}
