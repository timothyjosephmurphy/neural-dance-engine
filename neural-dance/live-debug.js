// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Publisher for /neural-dance/live/.
// The fixed studio room streams on load once this device has a saved key
// (open /neural-dance/live/#k=<key> once). Share live debug stays under
// Advanced and still opens a separate unguessable room. Suggested tuning
// arrives as a banner unless auto-apply is on.

import {detectionSize} from './camera-markers.js';
import {slimScanTelemetry} from './src/painting-diff.js';
import {DEBUG_HEARTBEAT_MS, DEBUG_INTERVAL_MS, DEBUG_SESSION_KEY, DEBUG_STALL_MS, ROOM_RE, STUDIO_ROOM, createDebugCredentials, debugCommandsFromMessage, debugPatchAppliesWithoutPrompt, newPublisherId, publisherDisplaced, readStudioKey, resolveStudioKey, sanitizeDebugPatch, shortDeviceName, shouldDropDebugSend, studioKeyFromHash, studioKeyFromPaste, studioKeyFromSearch, validPublisherId, validSecret, viewerPath, writeStudioCookie, writeStudioKey} from './debug-protocol.js';
import {applyPrecisionAction, beginAlign, calibrateStickersNow, cancelAlign, precisionTelemetry, relearnBarePaintingNow, scanStickersNow, verifyStickersNow} from './live-show.js';
import {dispatchShowCommand} from './src/show-commands.js';
import {PERSON_SENSITIVITY_DEFAULT} from './src/person-occlusion.js';
import {readPageVersion, reloadLivePage} from './live-reload.js';

export {DEBUG_INTERVAL_MS, viewerPath};

const PUBLISHER_ID_KEY = 'nd.debugPublisher.v1';

function publisherStore(doc, kind) {
  const view = doc && doc.defaultView;
  if (view && view[kind]) return view[kind];
  try { return globalThis[kind] || null; } catch { return null; }
}
function readPublisherId(store) {
  if (!store) return '';
  try {
    const saved = store.getItem(PUBLISHER_ID_KEY);
    return validPublisherId(saved) ? saved : '';
  } catch { return ''; }
}
function writePublisherId(store, id) {
  if (!store) return;
  try { store.setItem(PUBLISHER_ID_KEY, id); } catch { /* private mode */ }
}

// Stable per device, not per tab. A reconnect from this phone reclaims the
// debug slot; sessionStorage alone minted a new id and looked like a takeover.
export function ensurePublisherId(doc) {
  const local = publisherStore(doc, 'localStorage');
  const session = publisherStore(doc, 'sessionStorage');
  const saved = readPublisherId(local) || readPublisherId(session);
  const id = saved || newPublisherId();
  writePublisherId(local, id);
  writePublisherId(session, id);
  return id;
}
export const CAMERA_JPEG_QUALITY = 0.62;
export const STAGE_JPEG_QUALITY = 0.6;
export const STAGE_JPEG_W = 480;
export const STAGE_JPEG_H = 270;

export function readDebugSession(storage) {
  if (!storage) return null;
  try {
    const data = JSON.parse(storage.getItem(DEBUG_SESSION_KEY) || '');
    if (!data || !ROOM_RE.test(data.room) || !validSecret(data.secret) || !validSecret(data.key) || data.secret === data.key) return null;
    return {room: data.room, secret: data.secret, key: data.key, autoApply: data.autoApply === true, sharing: data.sharing === true};
  } catch {
    return null;
  }
}

export function writeDebugSession(storage, session) {
  if (!storage || !session) return false;
  try {
    storage.setItem(DEBUG_SESSION_KEY, JSON.stringify({
      room: session.room,
      secret: session.secret,
      key: session.key,
      autoApply: session.autoApply === true,
      sharing: session.sharing === true
    }));
    return true;
  } catch {
    return false;
  }
}

export function ensureDebugSession(storage) {
  const existing = readDebugSession(storage);
  if (existing) return existing;
  const created = createDebugCredentials();
  writeDebugSession(storage, created);
  return created;
}

export function loadDebugSession(primary, legacy) {
  const saved = readDebugSession(primary);
  if (saved) return saved;
  const older = readDebugSession(legacy);
  if (older && primary && primary !== legacy) writeDebugSession(primary, older);
  return older;
}

export function rotateDebugSession(storage) {
  const previous = readDebugSession(storage);
  const created = createDebugCredentials();
  if (previous) {
    created.autoApply = previous.autoApply === true;
    created.sharing = previous.sharing === true;
  }
  writeDebugSession(storage, created);
  return readDebugSession(storage) || created;
}

function browserStore(doc, name) {
  try {
    const view = doc && doc.defaultView ? doc.defaultView : globalThis;
    return view[name] || null;
  } catch {
    return null;
  }
}

function controlNumber(root, name) {
  const input = root && root.querySelector('[data-control="' + name + '"]');
  if (!input) return null;
  const value = +input.value;
  return Number.isFinite(value) ? value : null;
}

// Plain-JSON copy of a small telemetry object (verify / drift / camera
// lock reports); null when missing, unserialisable, or over maxLen chars.
export function smallJson(value, maxLen = 2000) {
  if (!value || typeof value !== 'object') return null;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > maxLen) return null;
    return JSON.parse(text);
  } catch { return null; }
}

// Painting status stays small. lastScan on the socket is metadata only.
// Sharp before / after / diff JPEGs are posted to the room over HTTP.
export function packPaintingTelemetry(painting) {
  if (!painting || typeof painting !== 'object') return null;
  const scan = painting.lastScan;
  const rest = {...painting};
  delete rest.lastScan;
  const slim = smallJson(rest, 4000);
  const packedScan = scan && typeof scan === 'object' ? slimScanTelemetry(scan) : null;
  if (!slim && !packedScan) return null;
  const out = slim || {};
  if (packedScan) out.lastScan = packedScan;
  return out;
}

// Matches worker SCAN_JPEG_MAX. The cap is the base64 payload, not the data URL.
export const SCAN_STILL_PREFIX = 'data:image/jpeg;base64,';
export const SCAN_STILL_MAX = 900000;

export function scanJpegField(value) {
  if (typeof value !== 'string' || !value.startsWith(SCAN_STILL_PREFIX)) return null;
  const b64 = value.slice(SCAN_STILL_PREFIX.length);
  if (b64.length < 8 || b64.length > SCAN_STILL_MAX) return null;
  return value;
}

export function scanStillPayload(painting) {
  const scan = painting && painting.lastScan;
  if (!scan || typeof scan !== 'object') return null;
  const before = scanJpegField(scan.before);
  const after = scanJpegField(scan.after);
  const diff = scanJpegField(scan.diff);
  if (!before && !after && !diff) return null;
  return {scanId: scan.scanId != null ? scan.scanId : (scan.at || 0), before, after, diff};
}

// HTTP stills are requested only after the room has accepted the POST.
export function withPostedScanStills(telemetry, postedScanId) {
  const scan = telemetry && telemetry.painting && telemetry.painting.lastScan;
  if (!scan || !scan.images) return telemetry;
  if (postedScanId != null && scan.scanId === postedScanId) return telemetry;
  return {
    ...telemetry,
    painting: {
      ...telemetry.painting,
      lastScan: {...scan, images: {before: false, after: false, diff: false}}
    }
  };
}

export function collectTelemetry(doc, now = Date.now()) {
  const cameraRoot = doc.getElementById('nd-camera-mode');
  const room = doc.getElementById('nd-room-lab');
  const vision = cameraRoot && cameraRoot.neuralDanceCamera && typeof cameraRoot.neuralDanceCamera.debugState === 'function'
    ? cameraRoot.neuralDanceCamera.debugState()
    : {};
  const audio = room && room.neuralDance && typeof room.neuralDance.debugAudio === 'function'
    ? room.neuralDance.debugAudio()
    : {source: 'silent', kick: 0, bass: 0, snare: 0, hat: 0, envelopes: {kick: 0, bass: 0, snare: 0, hat: 0}, silenceGate: true, noiseFloor: 0, open: false, micGain: 0};
  const controls = vision.controls || {};
  const envelopes = audio.envelopes || {kick: audio.kick || 0, bass: audio.bass || 0, snare: audio.snare || 0, hat: audio.hat || 0};
  const roomState = room && room.neuralDance && typeof room.neuralDance.debugRoom === 'function' ? room.neuralDance.debugRoom() : {};
  const bloomState = room && room.neuralDance && typeof room.neuralDance.bloom === 'function' ? room.neuralDance.bloom() : null;
  const bodyHas = (name) => !!(doc.body && doc.body.classList && doc.body.classList.contains(name));
  const nd = room && room.neuralDance;
  let listen = null;
  try { listen = nd && typeof nd.listenTiming === 'function' ? nd.listenTiming() : null; } catch { listen = null; }
  const ripple = roomState.ripple && typeof roomState.ripple === 'object' ? roomState.ripple : null;
  let slowdown = null;
  try { slowdown = nd && typeof nd.bodyMotionSlowdown === 'function' ? +nd.bodyMotionSlowdown() : null; } catch { slowdown = null; }
  let insetsOn = null;
  try { insetsOn = nd && typeof nd.insets === 'function' ? nd.insets() !== false : null; } catch { insetsOn = null; }
  const sens = [0, 1, 2, 3].map(band => {
    const input = room && room.querySelector && room.querySelector('[data-control="sens"][data-band="' + band + '"]');
    if (!input) return null;
    const value = +input.value;
    return Number.isFinite(value) ? value : null;
  });
  const view = doc.defaultView || globalThis;
  let crowd = null;
  try { crowd = view.ndCrowd && typeof view.ndCrowd.telemetry === 'function' ? view.ndCrowd.telemetry() : null; } catch { crowd = null; }
  return {
    crowd,
    t: now,
    fps: +vision.fps || 0,
    videoWidth: vision.videoWidth || 0,
    videoHeight: vision.videoHeight || 0,
    detectWidth: vision.detectWidth || 0,
    detectHeight: vision.detectHeight || 0,
    cameraLabel: vision.cameraLabel || '',
    publisherName: shortDeviceName(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
    build: (vision && vision.build) || readPageVersion(doc) || '',
    facingMode: vision.facingMode || '',
    quad: vision.quad || null,
    quadLock: vision.quadLock && typeof vision.quadLock === 'object' ? {locked: vision.quadLock.locked === true, frozen: vision.quadLock.frozen === true} : null,
    quadInfo: vision.quadInfo && typeof vision.quadInfo === 'object' ? {
      source: typeof vision.quadInfo.source === 'string' ? vision.quadInfo.source.slice(0, 24) : '',
      at: Number.isFinite(+vision.quadInfo.at) ? +vision.quadInfo.at : 0,
      // Ack for the debug page's versioned corner commit (TJ 3:58 PM drag fix).
      version: Number.isFinite(+vision.quadInfo.version) ? +vision.quadInfo.version : 0,
      rejected: smallJson(vision.quadInfo.rejected, 400)
    } : null,
    aligned: !!vision.aligned,
    scan: vision.scan && typeof vision.scan === 'object' ? {
      lastScanAt: +vision.scan.lastScanAt || 0,
      scanCount: +vision.scan.scanCount || 0,
      rawCount: +vision.scan.rawCount || 0,
      rejected: vision.scan.rejected || {},
      personPause: vision.scan.personPause === true,
      personBlocked: vision.scan.personBlocked === true,
      candidates: Array.isArray(vision.scan.candidates) ? vision.scan.candidates.slice(0, 24) : [],
      holdMs: +vision.scan.holdMs || 0
    } : null,
    align: vision.align && typeof vision.align === 'object' ? {
      found: Array.isArray(vision.align.found) ? vision.align.found.map(Boolean) : [false, false, false, false],
      reason: typeof vision.align.reason === 'string' ? vision.align.reason : '',
      marks: Array.isArray(vision.align.marks) ? vision.align.marks : [],
      progress: smallJson(vision.align.progress, 600)
    } : null,
    verify: smallJson(vision.verify, 4000),
    precision: (() => { try { return smallJson(precisionTelemetry(), 6000); } catch { return null; } })(),
    drift: smallJson(vision.drift, 2000),
    cameraLock: smallJson(vision.cameraLock, 3000),
    refine: vision.refine && typeof vision.refine === 'object' && Array.isArray(vision.refine.passes) ? {
      passes: vision.refine.passes.slice(0, 12),
      finalErrorPx: Number.isFinite(+vision.refine.finalErrorPx) && vision.refine.finalErrorPx !== null ? +vision.refine.finalErrorPx : null,
      converged: vision.refine.converged === true,
      stopped: typeof vision.refine.stopped === 'string' ? vision.refine.stopped : '',
      done: vision.refine.done === true
    } : null,
    stickerFlash: vision.stickerFlash && typeof vision.stickerFlash === 'object' ? {
      state: typeof vision.stickerFlash.state === 'string' ? vision.stickerFlash.state : '',
      count: Number.isFinite(+vision.stickerFlash.count) && vision.stickerFlash.count !== null ? +vision.stickerFlash.count : null,
      reason: typeof vision.stickerFlash.reason === 'string' ? vision.stickerFlash.reason : '',
      settleMs: Number.isFinite(+vision.stickerFlash.settleMs) ? +vision.stickerFlash.settleMs : null,
      settled: vision.stickerFlash.settled !== false
    } : null,
    painting: packPaintingTelemetry(vision.painting),
    commandAck: vision.commandAck && typeof vision.commandAck === 'object' ? {
      cmd: typeof vision.commandAck.cmd === 'string' ? vision.commandAck.cmd.slice(0, 16) : '',
      action: typeof vision.commandAck.action === 'string' ? vision.commandAck.action.slice(0, 40) : '',
      text: typeof vision.commandAck.text === 'string' ? vision.commandAck.text.slice(0, 160) : '',
      at: Number.isFinite(+vision.commandAck.at) ? +vision.commandAck.at : 0
    } : null,
    manualAck: smallJson(vision.manualAck, 400),
    gapScan: vision.gapScan && typeof vision.gapScan === 'object' ? {
      enabled: vision.gapScan.enabled !== false,
      at: Number.isFinite(+vision.gapScan.at) ? +vision.gapScan.at : null,
      state: typeof vision.gapScan.state === 'string' ? vision.gapScan.state : '',
      reason: typeof vision.gapScan.reason === 'string' ? vision.gapScan.reason : '',
      count: Number.isFinite(+vision.gapScan.count) && vision.gapScan.count !== null ? +vision.gapScan.count : null,
      applied: vision.gapScan.applied === true || vision.gapScan.applied === false ? vision.gapScan.applied : null
    } : null,
    quadMedianRgb: vision.quadMedianRgb || null,
    pink: vision.pink || [],
    stickers: vision.stickers || [],
    markers: vision.markers || [],
    occlusion: vision.occlusion && typeof vision.occlusion === 'object'
      ? {
          paused: vision.occlusion.paused === true,
          settling: vision.occlusion.settling === true,
          note: typeof vision.occlusion.note === 'string' ? vision.occlusion.note : null,
          // Gate internals so a missed or early rescan can be read off the
          // debug stream (TJ Nov 11 3:06 PM).
          phase: typeof vision.occlusion.phase === 'string' ? vision.occlusion.phase : 'clear',
          clearRun: Number.isFinite(+vision.occlusion.clearRun) ? vision.occlusion.clearRun | 0 : 0,
          clearMs: Number.isFinite(+vision.occlusion.clearMs) ? Math.round(+vision.occlusion.clearMs) : 0,
          held: typeof vision.occlusion.held === 'string' ? vision.occlusion.held : '',
          person: vision.occlusion.person && typeof vision.occlusion.person === 'object' ? {
            present: vision.occlusion.person.present === true,
            holding: vision.occlusion.person.holding === true,
            body: +vision.occlusion.person.body || 0,
            skin: +vision.occlusion.person.skin || 0,
            aspect: +vision.occlusion.person.aspect || 0,
            motion: +vision.occlusion.person.motion || 0
          } : null
        }
      : {paused: false, settling: false, note: null},
    lightMode: roomState.lightMode === 'silhouette' ? 'silhouette' : 'dot',
    drawMode: roomState.drawMode === 'dots' || roomState.drawMode === 'silhouette' || roomState.drawMode === 'beat' || roomState.drawMode === 'full' ? roomState.drawMode : 'full',
    audio: {
      source: audio.source === 'mic' || audio.source === 'track' ? audio.source : 'silent',
      kick: +audio.kick || 0,
      bass: +audio.bass || 0,
      snare: +audio.snare || 0,
      hat: +audio.hat || 0,
      envelopes,
      silenceGate: audio.silenceGate !== false,
      noiseFloor: +audio.noiseFloor || 0,
      open: !!audio.open,
      micGain: +audio.micGain || 0,
      mic: typeof audio.mic === 'string' ? audio.mic : 'off',
      micDetail: typeof audio.micDetail === 'string' ? audio.micDetail : ''
    },
    latency: vision.latency && typeof vision.latency === 'object' ? {
      lagMs: Number.isFinite(+vision.latency.lagMs) ? +vision.latency.lagMs : null,
      jitterMs: Number.isFinite(+vision.latency.jitterMs) ? +vision.latency.jitterMs : null,
      samples: vision.latency.samples | 0,
      active: vision.latency.active === true
    } : {lagMs: null, jitterMs: null, samples: 0, active: false},
    controls: {
      markerMode: controls.markerMode || controls.detectionMode || 'both',
      noteSensitivity: controls.saturationSensitivity ?? controlNumber(cameraRoot, 'sat'),
      stickerSensitivity: controls.stickerSensitivity ?? controlNumber(cameraRoot, 'sticker'),
      hueTolerance: controls.hueTolerance ?? controlNumber(cameraRoot, 'hue'),
      minBlobSize: controls.minBlobSize ?? controlNumber(cameraRoot, 'size'),
      maxBlobSize: controls.maxBlobSize ?? 160,
      quietThreshold: controlNumber(room, 'quiet'),
      micGain: +audio.micGain || 0,
      gravity: controlNumber(room, 'gravity'),
      wander: controlNumber(room, 'wander'),
      threshold: controlNumber(room, 'threshold'),
      peak: controlNumber(room, 'peak'),
      type: controlNumber(room, 'type'),
      sens,
      simDancers: roomState.simDancers === true,
      simCount: +roomState.simCount || 0,
      personPause: controls.personPause !== false,
      gapScan: controls.gapScan !== false,
      personSensitivity: Number.isFinite(+controls.personSensitivity) ? +controls.personSensitivity : PERSON_SENSITIVITY_DEFAULT,
      scanMode: ['black', 'white', 'gray', 'off'].includes(controls.scanMode) ? controls.scanMode : null,
      scanInterval: Number.isFinite(+controls.scanInterval) ? +controls.scanInterval : 4,
      scanDuration: Number.isFinite(+controls.scanDuration) ? +controls.scanDuration : 200,
      bloomEnabled: bloomState ? bloomState.enabled !== false : controls.bloomEnabled !== false,
      bloomIntensity: bloomState && Number.isFinite(+bloomState.intensity) ? +bloomState.intensity : (Number.isFinite(+controls.bloomIntensity) ? +controls.bloomIntensity : 0.18),
      bloomAura: bloomState && Number.isFinite(+bloomState.aura) ? +bloomState.aura : (Number.isFinite(+controls.bloomAura) ? +controls.bloomAura : 22),
      hueSpread: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.hueSpread)) return +tune.hueSpread;
        if (Number.isFinite(+controls.hueSpread)) return +controls.hueSpread;
        return 0.40;
      })(),
      hipEight: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.hipEight)) return +tune.hipEight;
        if (Number.isFinite(+controls.hipEight)) return +controls.hipEight;
        return 0.80;
      })(),
      shoulderEight: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.shoulderEight)) return +tune.shoulderEight;
        if (Number.isFinite(+controls.shoulderEight)) return +controls.shoulderEight;
        return 0.70;
      })(),
      hipTwist: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.hipTwist)) return +tune.hipTwist;
        if (Number.isFinite(+controls.hipTwist)) return +controls.hipTwist;
        return 0.80;
      })(),
      shoulderTwist: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.shoulderTwist)) return +tune.shoulderTwist;
        if (Number.isFinite(+controls.shoulderTwist)) return +controls.shoulderTwist;
        return 0.75;
      })(),
      maxBodyTurn: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.maxBodyTurn)) return +tune.maxBodyTurn;
        if (Number.isFinite(+controls.maxBodyTurn)) return +controls.maxBodyTurn;
        return 90;
      })(),
      turnFreq: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.turnFreq)) return +tune.turnFreq;
        if (Number.isFinite(+controls.turnFreq)) return +controls.turnFreq;
        return 0.70;
      })(),
      eightDepth: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.eightDepth)) return +tune.eightDepth;
        if (Number.isFinite(+controls.eightDepth)) return +controls.eightDepth;
        return 0.85;
      })(),
      eightVert: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.eightVert)) return +tune.eightVert;
        if (Number.isFinite(+controls.eightVert)) return +controls.eightVert;
        return 0.80;
      })(),
      armPadSense: (function () {
        const tune = nd && typeof nd.showTuning === 'function' ? nd.showTuning() : null;
        if (tune && Number.isFinite(+tune.armPadSense)) return +tune.armPadSense;
        if (Number.isFinite(+controls.armPadSense)) return +controls.armPadSense;
        return 1;
      })(),
      // Synced to the debug panel so a slider change never resends stale values.
      rippleEnabled: ripple ? ripple.enabled !== false : null,
      rippleIntensity: ripple && Number.isFinite(+ripple.intensity) ? +ripple.intensity : null,
      bodyMotionSlowdown: Number.isFinite(slowdown) ? slowdown : null,
      insetsEnabled: insetsOn
    },
    listen,
    stage: {
      dancers: +roomState.dancers || 0,
      pulses: +roomState.pulses || 0,
      stickers: roomState.stickers != null ? +roomState.stickers : ((vision.markers || []).length),
      simCount: +roomState.simCount || 0,
      simDancers: roomState.simDancers === true,
      running: !!roomState.running,
      markersLive: !!roomState.markersLive,
      aligning: bodyHas('nd-live-aligning'),
      hidden: bodyHas('nd-live-hidden'),
      ripple: roomState.ripple && typeof roomState.ripple === 'object' ? roomState.ripple : null,
      pose: roomState.pose && typeof roomState.pose === 'object' ? roomState.pose : null
    }
  };
}

function setControl(root, selector, value, eventName) {
  if (!root || typeof root.querySelector !== 'function' || value == null || !Number.isFinite(+value)) return;
  const input = root.querySelector(selector);
  if (!input) return;
  input.value = String(value);
  if (typeof input.dispatchEvent === 'function') input.dispatchEvent(new Event(eventName || 'input', {bubbles: true}));
}

function clickControl(doc, selector, label) {
  if (!doc || typeof doc.querySelector !== 'function') return;
  const node = doc.querySelector(selector);
  if (!node || typeof node.click !== 'function') return;
  if (label && String(node.textContent || '').trim() !== label) return;
  node.click();
}

function applyDebugAction(doc, clean) {
  if (!clean || !clean.action) return;
  const action = clean.action;
  if (action === 'add-manual-sticker' || action === 'remove-manual-sticker' || action === 'move-manual-sticker') {
    const camera = doc.getElementById('nd-camera-mode');
    if (camera && camera.neuralDanceCamera && typeof camera.neuralDanceCamera.applyManualSticker === 'function') {
      camera.neuralDanceCamera.applyManualSticker(clean);
    }
    return;
  }
  if (action === 'crowd') {
    // Show/demo remote: crowd-page.js owns these.
    try { doc.dispatchEvent(new CustomEvent('nd-crowd-command', {detail: clean})); } catch { /* no crowd page */ }
    return;
  }
  if (action === 'painting-reference') {
    relearnBarePaintingNow(doc, {cmd: clean.cmd});
    return;
  }
  if (action === 'frame-clear') {
    dispatchShowCommand(doc, clean);
    return;
  }
  if (action === 'sticker-crosshair') { dispatchShowCommand(doc, clean); return; }
  if (action === 'sticker-calibrate') { calibrateStickersNow(doc); return; }
  if (action === 'scan-stickers') { scanStickersNow(doc, {fromDebug: true});
    const camera = doc.getElementById('nd-camera-mode');
    const api = camera && camera.neuralDanceCamera;
    if (api && typeof api.noteCommand === 'function') api.noteCommand(action, 'Scanning stickers', clean.cmd);
    return;
  }
  if (action === 'verify-align') { verifyStickersNow(doc, {fromDebug: true}); return; }
  if (applyPrecisionAction(doc, action)) return;
  if (action === 'align' && doc.body && !doc.body.classList.contains('nd-live-aligning')) beginAlign(doc, {fromDebug: true});
  else if (action === 'cancel-align' && doc.body && doc.body.classList.contains('nd-live-aligning')) cancelAlign(doc);
  else if (action === 'hide-controls') clickControl(doc, '[data-live="hide"]');
  else if (action === 'show-controls') clickControl(doc, '[data-live="reveal"]');
  else dispatchShowCommand(doc, clean);
}

export function shouldResumeDebug(session) {
  return !!(session && session.sharing === true);
}

// HTTP fallback is only for when there is no socket, or it already failed.
// While the WebSocket is connecting, posting a frame can 409 against a stale
// publisher id and make the live page give up ("waiting to connect…").
export function socketIsConnecting(socket) {
  return !!(socket && socket.readyState === 0);
}

export function shouldHttpFallback(socket) {
  if (!socket) return true;
  if (socket.readyState === 1) return false;
  if (socket.readyState === 0) return false;
  return true;
}

export function isReloadMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'reload') return true;
  const incoming = message.pendingPatch && message.pendingPatch.patch ? message.pendingPatch.patch : null;
  const patch = message.patch || incoming;
  return !!(patch && patch.action === 'reload');
}

export function applyDebugPatch(doc, patch) {
  const clean = sanitizeDebugPatch(patch);
  if (!clean || !doc) return false;
  const camera = doc.getElementById('nd-camera-mode');
  if (camera && camera.neuralDanceCamera && typeof camera.neuralDanceCamera.applyTuning === 'function') {
    camera.neuralDanceCamera.applyTuning(clean);
  }
  const room = doc.getElementById('nd-room-lab');
  setControl(room, '[data-control="quiet"]', clean.quietThreshold, 'input');
  setControl(room, '[data-control="gravity"]', clean.gravity, 'input');
  setControl(room, '[data-control="wander"]', clean.wander, 'input');
  setControl(room, '[data-control="threshold"]', clean.threshold, 'input');
  setControl(room, '[data-control="peak"]', clean.peak, 'input');
  setControl(room, '[data-control="type"]', clean.type, 'change');
  if (Array.isArray(clean.sens)) {
    clean.sens.forEach((value, band) => setControl(room, '[data-control="sens"][data-band="' + band + '"]', value, 'input'));
  }
  const nd = room && room.neuralDance;
  if (nd && typeof nd.setBloom === 'function' && (clean.bloomEnabled === true || clean.bloomEnabled === false || Number.isFinite(+clean.bloomIntensity) || Number.isFinite(+clean.bloomAura))) {
    nd.setBloom({
      enabled: clean.bloomEnabled,
      intensity: clean.bloomIntensity,
      aura: clean.bloomAura
    });
  }
  setControl(room, '[data-control="hue-spread"]', clean.hueSpread, 'input');
  setControl(room, '[data-control="hip-eight"]', clean.hipEight, 'input');
  setControl(room, '[data-control="shoulder-eight"]', clean.shoulderEight, 'input');
  setControl(room, '[data-control="hip-twist"]', clean.hipTwist, 'input');
  setControl(room, '[data-control="shoulder-twist"]', clean.shoulderTwist, 'input');
  setControl(room, '[data-control="max-body-turn"]', clean.maxBodyTurn, 'input');
  setControl(room, '[data-control="turn-freq"]', clean.turnFreq, 'input');
  setControl(room, '[data-control="eight-depth"]', clean.eightDepth, 'input');
  setControl(room, '[data-control="eight-vert"]', clean.eightVert, 'input');
  setControl(room, '[data-control="arm-pad-sense"]', clean.armPadSense, 'input');
  setControl(room, '[data-control="rave-moves"]', clean.raveMoves, 'input');
  setControl(room, '[data-control="inner-bones"]', clean.innerBones, 'input');
  setControl(room, '[data-control="head-look"]', clean.headLook, 'input');
  if (nd && typeof nd.setShowTuning === 'function' && (Number.isFinite(+clean.hueSpread) || Number.isFinite(+clean.hipEight) || Number.isFinite(+clean.shoulderEight) || Number.isFinite(+clean.hipTwist) || Number.isFinite(+clean.shoulderTwist) || Number.isFinite(+clean.maxBodyTurn) || Number.isFinite(+clean.turnFreq) || Number.isFinite(+clean.eightDepth) || Number.isFinite(+clean.eightVert) || Number.isFinite(+clean.armPadSense))) {
    const tune = {};
    if (Number.isFinite(+clean.hueSpread)) tune.hueSpread = clean.hueSpread;
    if (Number.isFinite(+clean.hipEight)) tune.hipEight = clean.hipEight;
    if (Number.isFinite(+clean.shoulderEight)) tune.shoulderEight = clean.shoulderEight;
    if (Number.isFinite(+clean.hipTwist)) tune.hipTwist = clean.hipTwist;
    if (Number.isFinite(+clean.shoulderTwist)) tune.shoulderTwist = clean.shoulderTwist;
    if (Number.isFinite(+clean.maxBodyTurn)) tune.maxBodyTurn = clean.maxBodyTurn;
    if (Number.isFinite(+clean.turnFreq)) tune.turnFreq = clean.turnFreq;
    if (Number.isFinite(+clean.eightDepth)) tune.eightDepth = clean.eightDepth;
    if (Number.isFinite(+clean.eightVert)) tune.eightVert = clean.eightVert;
    nd.setShowTuning(tune);
  }
  if (nd && typeof nd.setRipple === 'function' && (clean.rippleEnabled === true || clean.rippleEnabled === false || Number.isFinite(+clean.rippleIntensity))) {
    nd.setRipple({enabled: clean.rippleEnabled, intensity: clean.rippleIntensity});
  }
  if (nd && typeof nd.setPerspective === 'function' && Number.isFinite(+clean.perspectiveStrength)) {
    nd.setPerspective(+clean.perspectiveStrength);
  }
  if (nd && typeof nd.setInsets === 'function' && (clean.insetsEnabled === true || clean.insetsEnabled === false)) {
    nd.setInsets(clean.insetsEnabled);
  }
  if (nd && typeof nd.setBodyMotionSlowdown === 'function' && Number.isFinite(+clean.bodyMotionSlowdown)) {
    nd.setBodyMotionSlowdown(+clean.bodyMotionSlowdown);
  }
  if (Number.isFinite(+clean.stageWidthCm)) applyPrecisionAction(doc, 'stage-width', +clean.stageWidthCm);
  applyDebugAction(doc, clean);
  return true;
}

function jpegOf(canvas, source, width, height, quality) {
  if (!source || !canvas || !(width > 0) || !(height > 0)) return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', {alpha: false});
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

// 10 Hz audio feed (TJ 7:13 PM): sample every 100 ms, send 5 samples per
// WebSocket message (2 msg/s), only while a debug viewer is connected.
export const AUDIO_SAMPLE_MS = 100;
export const AUDIO_BATCH = 5;
export function createAudioFeed({sample, send, batch = AUDIO_BATCH} = {}) {
  let viewers = 0;
  let pending = [];
  let seq = -1;
  return {
    setViewers(n) { viewers = Math.max(0, n | 0); if (!viewers) pending = []; return viewers; },
    viewers() { return viewers; },
    tick() {
      if (!(viewers > 0) || typeof sample !== 'function') return false;
      let s;
      try { s = sample(seq); } catch { return false; }
      if (!s) return false;
      seq = s.seq;
      pending.push(s);
      if (pending.length >= batch) {
        const samples = pending;
        pending = [];
        try { send({type: 'audio', samples}); } catch { /* keep the show running */ }
        return true;
      }
      return false;
    }
  };
}

export function attachLiveDebug(doc) {
  if (!doc || !doc.body || doc.body.dataset.debugReady === '1') return;
  const share = doc.querySelector('[data-debug-share]');
  if (!share) return;
  doc.body.dataset.debugReady = '1';
  const panel = doc.querySelector('[data-debug-panel]');
  const codeEl = doc.querySelector('[data-debug-code]');
  const link = doc.querySelector('[data-debug-link]');
  const copy = doc.querySelector('[data-debug-copy]');
  const status = doc.querySelector('[data-debug-status]');
  const auto = doc.querySelector('[data-debug-auto]');
  const banner = doc.querySelector('[data-debug-banner]');
  const bannerText = doc.querySelector('[data-debug-banner-text]');
  const apply = doc.querySelector('[data-debug-apply]');
  const dismiss = doc.querySelector('[data-debug-dismiss]');
  const cameraRoot = doc.getElementById('nd-camera-mode');
  const storage = browserStore(doc, 'localStorage') || browserStore(doc, 'sessionStorage');
  const advanced = doc.querySelector('[data-debug-advanced]');
  let sharing = false;
  let studioOn = false;
  let displaced = false;
  const publisherId = ensurePublisherId(doc);
  let session = loadDebugSession(storage, browserStore(doc, 'sessionStorage'));
  let postedScanId = null;
  let postingScanId = null;
  let socket = null;
  let timer = 0;
  let attempts = 0;
  let lastInbound = 0;
  const appliedCommandIds = new Set();
  let pending = null;
  const roomEl = doc.getElementById('nd-room-lab');
  const audioFeed = createAudioFeed({
    sample: (since) => roomEl && roomEl.neuralDance && typeof roomEl.neuralDance.audioSample === 'function' ? roomEl.neuralDance.audioSample(since) : null,
    send: (body) => { if (socket && socket.readyState === 1) socket.send(JSON.stringify(body)); }
  });
  let audioTimer = 0;
  function syncAudioTimer() {
    const want = !!(socket && socket.readyState === 1 && audioFeed.viewers() > 0);
    if (want && !audioTimer) audioTimer = setInterval(() => audioFeed.tick(), AUDIO_SAMPLE_MS);
    else if (!want && audioTimer) { clearInterval(audioTimer); audioTimer = 0; }
  }
  const cameraCanvas = doc.createElement('canvas');
  const stageCanvas = doc.createElement('canvas');
  if (auto && session) auto.checked = session.autoApply === true;

  function say(text) {
    if (status) status.textContent = text;
  }
  function showSession() {
    if (!session) return;
    if (codeEl) codeEl.textContent = session.room;
    if (link) link.href = viewerPath(session);
    if (panel) panel.hidden = false;
    if (advanced) advanced.open = true;
  }
  function notePatch(message) {
    if (isReloadMessage(message)) {
      reloadLivePage(doc);
      return;
    }
    const list = debugCommandsFromMessage(message);
    if (!list.length) return;
    for (const item of list) {
      const patch = item.patch;
      const id = item.id != null && Number.isFinite(+item.id) ? +item.id : null;
      if (id != null && appliedCommandIds.has(id)) {
        if (debugPatchAppliesWithoutPrompt(patch)) reportPatch('applied', id);
        continue;
      }
      if (id != null) {
        appliedCommandIds.add(id);
        if (appliedCommandIds.size > 32) appliedCommandIds.delete(appliedCommandIds.values().next().value);
      }
      if ((auto && auto.checked) || debugPatchAppliesWithoutPrompt(patch)) {
        applyDebugPatch(doc, patch);
        reportPatch('applied', id);
        say(patch.action ? 'Applied ' + patch.action : 'Applied live tuning');
      } else {
        pending = patch;
        if (bannerText) bannerText.textContent = 'Suggested tuning received';
        if (banner) banner.hidden = false;
      }
    }
  }
  function reportPatch(statusText, id) {
    const body = {type: 'patch_result', status: statusText};
    if (id != null && Number.isFinite(+id)) body.id = +id;
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify(body)); return; } catch { /* fall through to HTTP */ }
    }
    if (!session) return;
    const auth = studioOn && !sharing
      ? 'role=publisher&key=' + encodeURIComponent(session.key)
      : 'secret=' + encodeURIComponent(session.secret);
    const url = '/api/neural-dance/debug/result?room=' + encodeURIComponent(session.room) + '&' + auth;
    fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify(body)}).catch(() => {});
  }
  async function claim() {
    if (!session) return;
    const url = '/api/neural-dance/debug/claim?room=' + encodeURIComponent(session.room);
    try {
      await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        cache: 'no-store',
        body: JSON.stringify({room: session.room, publisherSecret: session.secret, viewerKey: session.key})
      });
    } catch { /* the next frame retries */ }
  }
  function connect() {
    if ((!sharing && !studioOn) || !session) return;
    const origin = doc.defaultView && doc.defaultView.location ? doc.defaultView.location : location;
    const url = new URL('/api/neural-dance/debug/ws', origin.href);
    url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', session.room);
    url.searchParams.set('role', 'publisher');
    url.searchParams.set('pub', publisherId);
    if (studioOn && !sharing) url.searchParams.set('key', session.key);
    else url.searchParams.set('secret', session.secret);
    const previous = socket;
    let next;
    try { next = new WebSocket(url.href); } catch { scheduleReconnect(); return; }
    if (previous && previous !== next) {
      previous.onclose = null;
      previous.onmessage = null;
      try { previous.close(); } catch { /* the new socket owns the feed */ }
    }
    lastInbound = 0;
    socket = next;
    next.onmessage = (event) => {
      lastInbound = Date.now();
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (publisherDisplaced(message)) {
        yieldFeed();
        return;
      }
      if (message && (message.type === 'reload' || message.reload === true || isReloadMessage(message))) {
        reloadLivePage(doc);
        return;
      }
      const viewerN = message && message.type === 'viewers' ? +message.count : (message && message.type === 'hello' ? +message.viewers : NaN);
      if (Number.isFinite(viewerN)) {
        audioFeed.setViewers(viewerN);
        syncAudioTimer();
      }
      if (message && (message.type === 'propose_patch' || message.type === 'pong' || message.type === 'hello' || message.pendingPatch || (message.commands && message.commands.length))) notePatch(message);
    };
    next.onopen = () => {
      attempts = 0;
      lastInbound = Date.now();
      paintPairStatus();
      if (sharing) say('Sharing ' + session.room);
      try { next.send(JSON.stringify({type: 'ping', t: Date.now()})); } catch { /* the next beat retries */ }
    };
    next.onclose = (event) => {
      // A newer socket from this same tab already owns the feed. Closing the
      // old one (including a same-device reclaim) must not show a takeover.
      if (socket !== next) return;
      socket = null;
      audioFeed.setViewers(0);
      syncAudioTimer();
      paintPairStatus();
      if (event && event.reason === 'reclaim') return;
      if (displaced || (event && event.reason === 'replaced')) {
        yieldFeed();
        return;
      }
      if (sharing || studioOn) scheduleReconnect();
    };
  }
  function yieldFeed() {
    if (displaced) return;
    displaced = true;
    clearTimeout(timer);
    timer = 0;
    dropSocket();
    const note = doc.querySelector('[data-debug-takeover]');
    if (note) note.hidden = false;
    say('Another device took over the debug feed');
    paintPairStatus();
  }
  function takeOver() {
    displaced = false;
    const note = doc.querySelector('[data-debug-takeover]');
    if (note) note.hidden = true;
    attempts = 0;
    if (!sharing && !studioOn) return;
    connect();
    beat();
    paintPairStatus();
    say('Publishing the debug feed');
  }
  function scheduleReconnect() {
    if (!sharing && !studioOn) return;
    const delay = Math.min(8000, 1000 * 2 ** attempts);
    attempts++;
    setTimeout(() => {
      if (sharing) { claim(); connect(); }
      else if (studioOn) connect();
    }, delay);
  }
  // Crowd show white captures: saved privately in the studio debug room
  // (its own table, kept past the idle alarm). Needs the studio pairing.
  if (!doc.__ndCrowdCaptureBound) {
    doc.__ndCrowdCaptureBound = true;
    doc.addEventListener('nd-crowd-capture', event => {
      const d = event && event.detail || {};
      const done = (result) => { try { if (typeof d.done === 'function') d.done(result); } catch { /* ignore */ } };
      if ((!sharing && !studioOn) || !session) { done({ok: false, reason: 'not paired'}); return; }
      const auth = studioOn && !sharing
        ? 'role=publisher&key=' + encodeURIComponent(session.key)
        : 'secret=' + encodeURIComponent(session.secret);
      const url = '/api/neural-dance/debug/capture?room=' + encodeURIComponent(session.room) + '&' + auth;
      fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify({jpeg: d.jpeg, takenAt: d.takenAt, meta: d.meta || {}})})
        .then(res => res && res.ok ? res.json() : {ok: false, reason: 'HTTP ' + (res && res.status)})
        .then(done)
        .catch(() => done({ok: false, reason: 'network'}));
    });
  }
  // Crowd show live requests (queue, move library, build record): the
  // projector talks to the studio room as the publisher. Same pairing.
  if (!doc.__ndCrowdApiBound) {
    doc.__ndCrowdApiBound = true;
    doc.addEventListener('nd-crowd-api', event => {
      const d = event && event.detail || {};
      const done = (result) => { try { if (typeof d.done === 'function') d.done(result); } catch { /* ignore */ } };
      if ((!sharing && !studioOn) || !session) { done({ok: false, reason: 'not paired'}); return; }
      const auth = studioOn && !sharing
        ? 'role=publisher&key=' + encodeURIComponent(session.key)
        : 'secret=' + encodeURIComponent(session.secret);
      const url = '/api/neural-dance/debug/requests?room=' + encodeURIComponent(session.room) + '&' + auth;
      const init = d.body ? {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify(d.body)} : {cache: 'no-store'};
      fetch(url, init)
        .then(res => res && res.ok ? res.json() : {ok: false, reason: 'HTTP ' + (res && res.status)})
        .then(done)
        .catch(() => done({ok: false, reason: 'network'}));
    });
  }
  function uploadScanStills() {
    if ((!sharing && !studioOn) || !session) return;
    const vision = cameraRoot && cameraRoot.neuralDanceCamera && typeof cameraRoot.neuralDanceCamera.debugState === 'function'
      ? cameraRoot.neuralDanceCamera.debugState()
      : null;
    const stills = scanStillPayload(vision && vision.painting);
    if (!stills || stills.scanId === postedScanId || stills.scanId === postingScanId) return;
    const id = stills.scanId;
    postingScanId = id;
    const auth = studioOn && !sharing
      ? 'role=publisher&key=' + encodeURIComponent(session.key)
      : 'secret=' + encodeURIComponent(session.secret);
    const url = '/api/neural-dance/debug/last-scan?room=' + encodeURIComponent(session.room) + '&' + auth;
    // Detection keeps running. The viewer is told the stills exist only
    // after this POST returns 200, then a fresh metadata frame is sent.
    fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify({...stills, publisherId})})
      .then(res => {
        if (postingScanId === id) postingScanId = null;
        if (!res || !res.ok) return null;
        postedScanId = id;
        return publishFrame();
      })
      .catch(() => { if (postingScanId === id) postingScanId = null; });
  }
  async function publishFrame() {
    if ((!sharing && !studioOn) || !session) return;
    // The previous JPEG is still queued on the socket. Encoding another one
    // blocks the show, and sending it is what backed the Durable Object up.
    if (socket && socket.readyState === 1 && shouldDropDebugSend(socket.bufferedAmount)) return;
    uploadScanStills();
    const telemetry = withPostedScanStills(collectTelemetry(doc), postedScanId);
    const video = cameraRoot && cameraRoot.querySelector('[data-preview]');
    let cameraJpeg = null;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      const size = detectionSize(video.videoWidth, video.videoHeight);
      try { cameraJpeg = jpegOf(cameraCanvas, video, size.width, size.height, CAMERA_JPEG_QUALITY); } catch { cameraJpeg = null; }
    }
    const stage = doc.querySelector('#nd-room-lab [data-stage]');
    let stageJpeg = null;
    try { stageJpeg = jpegOf(stageCanvas, stage, STAGE_JPEG_W, STAGE_JPEG_H, STAGE_JPEG_QUALITY); } catch { stageJpeg = null; }
    const body = {type: 'frame', publisherId, telemetry, cameraJpeg, stageJpeg};
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify(body)); return; } catch { /* HTTP fallback */ }
    }
    // Do not HTTP-post while the WebSocket is still opening: a 409 against a
    // leftover publisher id would yield the feed and close the socket.
    if (!shouldHttpFallback(socket) || displaced) return;
    const auth = studioOn && !sharing
      ? 'role=publisher&key=' + encodeURIComponent(session.key)
      : 'secret=' + encodeURIComponent(session.secret);
    const url = '/api/neural-dance/debug/frame?room=' + encodeURIComponent(session.room) + '&' + auth;
    try {
      const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify(body)});
      if (response.status === 409) {
        if (socketIsConnecting(socket) || (socket && socket.readyState === 1)) return;
        yieldFeed();
        return;
      }
      if (response.ok) {
        const data = await response.json();
        if (publisherDisplaced(data)) {
          if (socketIsConnecting(socket) || (socket && socket.readyState === 1)) return;
          yieldFeed();
          return;
        }
        if (data && data.reload === true) {
          reloadLivePage(doc);
          return;
        }
        if (data && data.pendingPatch) notePatch(data);
      }
    } catch { /* keep the show running */ }
  }
  function reviveIfStalled() {
    if (displaced || (!sharing && !studioOn)) return;
    const closed = !socket || socket.readyState === 2 || socket.readyState === 3;
    const quiet = socket && socket.readyState === 1 && lastInbound && Date.now() - lastInbound > DEBUG_STALL_MS + DEBUG_HEARTBEAT_MS;
    if (!closed && !quiet) return;
    attempts = 0;
    dropSocket();
    connect();
  }
  async function beat() {
    if (!sharing && !studioOn) return;
    reviveIfStalled();
    if (socket && socket.readyState === 1 && !shouldDropDebugSend(socket.bufferedAmount)) {
      try { socket.send(JSON.stringify({type: 'ping', t: Date.now()})); } catch { /* revive on the next beat */ }
    }
    try { await publishFrame(); } catch { /* one bad frame does not stop the relay */ }
    if (!sharing && !studioOn) return;
    timer = setTimeout(beat, DEBUG_INTERVAL_MS);
  }
  let wakeSentinel = null;
  let wakePending = null;
  let wakeState = 'pending';
  function paintWake() {
    const el = doc.querySelector('[data-wake-note]');
    if (!el) return;
    const missing = wakeState === 'missing';
    el.hidden = !missing;
    if (missing) el.textContent = 'screen may sleep';
  }
  async function holdWake() {
    if (wakeSentinel) return;
    if (wakePending) return wakePending;
    const nav = doc.defaultView && doc.defaultView.navigator;
    if (!nav || !nav.wakeLock || doc.visibilityState === 'hidden') {
      if (doc.visibilityState !== 'hidden' && (!nav || !nav.wakeLock)) wakeState = 'missing';
      paintWake();
      return;
    }
    wakePending = (async () => {
      try {
        const sentinel = await nav.wakeLock.request('screen');
        wakeSentinel = sentinel;
        wakeState = 'held';
        sentinel.addEventListener('release', () => {
          if (wakeSentinel === sentinel) wakeSentinel = null;
          wakeState = 'missing';
          paintWake();
        });
      } catch {
        wakeSentinel = null;
        wakeState = 'missing';
      }
      wakePending = null;
      paintWake();
    })();
    return wakePending;
  }
  if (doc.defaultView && typeof doc.defaultView.addEventListener === 'function') {
    doc.defaultView.addEventListener('visibilitychange', () => {
      if (!doc.hidden) holdWake();
      if (doc.hidden || displaced || (!sharing && !studioOn)) return;
      reviveIfStalled();
      if (!timer) beat();
    });
  }
  doc.addEventListener('pointerup', () => { holdWake(); }, true);
  function startStudio(forcedKey) {
    if (sharing) return false;
    const key = validSecret(forcedKey) ? forcedKey : readStudioKey(storage);
    if (!validSecret(key)) return false;
    studioOn = true;
    const autoApply = auto ? auto.checked === true : true;
    session = {room: STUDIO_ROOM, secret: key, key, autoApply, sharing: false};
    if (cameraRoot) cameraRoot.dataset.debugStream = '1';
    attempts = 0;
    connect();
    beat();
    holdWake();
    return true;
  }
  function start() {
    if (studioOn) {
      studioOn = false;
      clearTimeout(timer);
      timer = 0;
      dropSocket();
    }
    sharing = true;
    session = ensureDebugSession(storage);
    if (auto) session.autoApply = auto.checked === true;
    session.sharing = true;
    writeDebugSession(storage, session);
    share.setAttribute('aria-pressed', 'true');
    share.textContent = 'Sharing live debug';
    showSession();
    if (cameraRoot) cameraRoot.dataset.debugStream = '1';
    say('Sharing ' + session.room);
    claim();
    connect();
    beat();
    holdWake();
  }
  function dropSocket() {
    const current = socket;
    socket = null;
    if (!current) return;
    current.onclose = null;
    try { current.close(); } catch { /* already closed */ }
  }
  function rotate() {
    const autoApply = auto ? auto.checked === true : !!(session && session.autoApply);
    session = rotateDebugSession(storage);
    if (session) {
      session.autoApply = autoApply;
      session.sharing = sharing;
      writeDebugSession(storage, session);
    }
    showSession();
    if (!sharing) {
      say('New debug link');
      return;
    }
    dropSocket();
    attempts = 0;
    claim();
    connect();
    say('New debug link');
  }
  function stop() {
    sharing = false;
    if (session && ROOM_RE.test(session.room)) {
      session.sharing = false;
      writeDebugSession(storage, session);
    }
    clearTimeout(timer);
    timer = 0;
    share.setAttribute('aria-pressed', 'false');
    share.textContent = 'Share live debug';
    if (panel) panel.hidden = true;
    if (cameraRoot) delete cameraRoot.dataset.debugStream;
    dropSocket();
    say('Debug sharing off');
    startStudio();
  }
  share.addEventListener('click', () => { if (sharing) stop(); else start(); });
  const rotateButton = doc.querySelector('[data-debug-rotate]');
  if (rotateButton) rotateButton.addEventListener('click', () => rotate());
  if (auto) auto.addEventListener('change', () => {
    if (!session || studioOn) {
      if (session && studioOn) session.autoApply = auto.checked === true;
      return;
    }
    session.autoApply = auto.checked === true;
    writeDebugSession(storage, session);
  });
  if (copy) copy.addEventListener('click', async () => {
    if (!session || !link) return;
    const absolute = new URL(link.getAttribute('href'), doc.defaultView ? doc.defaultView.location.href : 'https://tjm.art/').href;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(absolute);
      say('Viewer link copied');
    } catch {
      say(absolute);
    }
  });
  if (apply) apply.addEventListener('click', () => {
    if (pending) applyDebugPatch(doc, pending);
    pending = null;
    if (banner) banner.hidden = true;
    reportPatch('applied');
  });
  if (dismiss) dismiss.addEventListener('click', () => {
    pending = null;
    if (banner) banner.hidden = true;
    reportPatch('dismissed');
  });
  const takeOverButton = doc.querySelector('[data-debug-takeover-go]');
  if (takeOverButton) takeOverButton.addEventListener('click', () => takeOver());
  doc.addEventListener('nd-before-reload', () => {
    if (studioOn) return;
    if (!session) session = readDebugSession(storage);
    if (!session || !ROOM_RE.test(session.room)) return;
    session.sharing = sharing;
    writeDebugSession(storage, session);
  });
  const view = doc.defaultView || globalThis;
  const loc = view.location || {};
  const explicitKey = studioKeyFromHash(loc.hash || '') || studioKeyFromSearch(loc.search || '');
  const resolved = resolveStudioKey({
    storage,
    cookie: doc.cookie || '',
    hash: loc.hash || '',
    search: loc.search || ''
  });
  if (resolved.key) {
    writeStudioKey(storage, resolved.key);
    writeStudioCookie(doc, resolved.key);
    if (explicitKey && session && session.sharing) {
      session.sharing = false;
      writeDebugSession(storage, session);
    }
    if (explicitKey && view.history && loc.pathname) {
      try { view.history.replaceState(null, '', loc.pathname); } catch { /* keep the URL for this load */ }
    }
  }
  const pairInput = doc.querySelector('[data-debug-pair-key]');
  const pairGo = doc.querySelector('[data-debug-pair-go]');
  function paintPairStatus() {
    const el = doc.querySelector('[data-debug-pair-status]');
    const banner = doc.querySelector('[data-debug-pair-banner]');
    const paired = !!readStudioKey(storage);
    const connected = !!(studioOn && socket && socket.readyState === 1);
    if (el) el.textContent = connected ? 'Connected' : displaced ? 'Take over' : paired ? 'Paired' : 'Not paired';
    if (banner) {
      if (connected) {
        banner.hidden = true;
        banner.textContent = '';
      } else {
        banner.hidden = false;
        if (displaced) banner.textContent = 'Another device took over the debug feed — tap to take over';
        else banner.textContent = paired ? 'Debug paired · waiting to connect…' : 'Debug not paired — tap to pair';
      }
    }
  }
  function pairFromPaste() {
    const raw = pairInput && pairInput.value ? String(pairInput.value).trim() : '';
    const key = studioKeyFromPaste(raw);
    if (!key) {
      paintPairStatus();
      say('Paste the pairing link or key, then tap Pair debug');
      return;
    }
    writeStudioKey(storage, key);
    writeStudioCookie(doc, key);
    if (pairInput) pairInput.value = '';
    displaced = false;
    dropSocket();
    clearTimeout(timer);
    timer = 0;
    sharing = false;
    startStudio(key);
    paintPairStatus();
    say(studioOn ? 'Paired · debug publishing' : 'Debug key was not saved');
  }
  if (pairGo) pairGo.addEventListener('click', () => pairFromPaste());
  const pairBanner = doc.querySelector('[data-debug-pair-banner]');
  if (pairBanner) pairBanner.addEventListener('click', () => {
    if (displaced) {
      takeOver();
      return;
    }
    try { doc.body.classList.remove('nd-live-hidden'); } catch {}
    const box = doc.querySelector('[data-debug-pair]');
    if (box && box.scrollIntoView) box.scrollIntoView({behavior: 'smooth', block: 'center'});
    if (pairInput) pairInput.focus();
  });
  if (pairInput) pairInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); pairFromPaste(); }
  });
  // Home Screen apps use separate storage from Safari — make the pair box obvious.
  const pairBox = doc.querySelector('[data-debug-pair]');
  if (pairBox) {
    const standalone = !!(view.navigator && view.navigator.standalone)
      || (view.matchMedia && (
        view.matchMedia('(display-mode: standalone)').matches
        || view.matchMedia('(display-mode: fullscreen)').matches
      ));
    if (standalone) pairBox.dataset.standalone = '1';
  }
  paintPairStatus();
  holdWake();
  if (explicitKey) startStudio(explicitKey);
  else if (shouldResumeDebug(session)) start();
  else startStudio(resolved.key);
  paintPairStatus();
}

if (typeof document !== 'undefined') {
  const boot = () => attachLiveDebug(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
