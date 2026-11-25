// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Shared Neural Dance live-debug protocol.
// Pure helpers so the phone, the viewer page, and the Durable Object agree
// on room codes, secrets, and the tuning fields a viewer is allowed to suggest.

export const DEBUG_SESSION_KEY = 'nd.liveDebug.v1';
export const STUDIO_ROOM = 'studio';
export const STUDIO_KEY_STORAGE = 'nd.studioDebug.v1';
export const STUDIO_COOKIE = 'nd_studio';
export const STUDIO_COOKIE_PATH = '/neural-dance/';
export const STUDIO_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
export const DEBUG_INTERVAL_MS = 750;
// Command pings are separate from JPEG frames. A button should land on the
// phone inside this window even when a frame is being encoded.
export const DEBUG_COMMAND_MS = 150;
export const DEBUG_IDLE_MS = 30 * 60 * 1000;
export const DEBUG_RING = 10;
// A quiet socket is treated as stalled after this long with no frame.
// Heartbeats are smaller than a frame so a live socket can still answer
// while the phone is between JPEGs.
export const DEBUG_STALL_MS = 4000;
export const DEBUG_HEARTBEAT_MS = 2000;
// Drop a WebSocket write once this many bytes are already queued. A viewer
// that is still decoding the previous JPEG must not pin the Durable Object
// or the phone behind an ever-growing buffer.
export const DEBUG_WS_BUFFER_MAX = 256 * 1024;

export function shouldDropDebugSend(buffered, limit = DEBUG_WS_BUFFER_MAX) {
  const n = +buffered;
  return Number.isFinite(n) && n > limit;
}

function frameAgo(ageMs) {
  const ms = Math.max(0, ageMs);
  return ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

/** Status line for the debug viewer. phase: connecting | live | stalled | reconnecting. */
export function debugLinkText(now, lastFrame, phase) {
  const age = lastFrame ? Math.max(0, (+now || 0) - lastFrame) : null;
  const ago = age == null ? '' : frameAgo(age);
  if (phase === 'connecting') return ago ? 'Connecting… · last frame ' + ago + 's ago' : 'Connecting…';
  if (phase === 'reconnecting') return ago ? 'Reconnecting… · last frame ' + ago + 's ago' : 'Reconnecting…';
  if (age == null) return 'Connecting…';
  if (phase === 'stalled' || age > DEBUG_STALL_MS) return 'Stalled · last frame ' + ago + 's ago';
  return 'Live · last frame ' + ago + 's ago';
}

/**
 * Keep only the newest unparsed frame. Returns true when the caller should
 * start decoding (nobody else is). A frame that arrives mid-decode replaces
 * the queued one; the in-flight decode finishes, then the newest is taken.
 */
export function offerDebugFrame(state, raw) {
  if (!state) return false;
  state.latest = raw;
  if (state.busy) return false;
  state.busy = true;
  return true;
}
export function takeDebugFrame(state) {
  if (!state) return null;
  const raw = state.latest;
  state.latest = null;
  return raw == null ? null : raw;
}
export function finishDebugFrame(state) {
  if (!state) return false;
  state.busy = false;
  return state.latest != null;
}
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_RE = /^ND-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function validSecret(value) {
  return typeof value === 'string' && SECRET_RE.test(value);
}

const PUBLISHER_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function validPublisherId(value) {
  return typeof value === 'string' && PUBLISHER_RE.test(value);
}

export function newPublisherId(random = crypto.getRandomValues.bind(crypto)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(16);
  random(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function shortDeviceName(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

export function publisherDisplaced(message) {
  return !!(message && (message.type === 'displaced' || message.displaced === true));
}

export function studioKeyFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return '';
  let value = '';
  try { value = new URLSearchParams(raw).get('k') || ''; } catch { return ''; }
  return validSecret(value) ? value : '';
}


export function studioKeyFromSearch(search) {
  const raw = String(search || '').replace(/^\?/, '');
  if (!raw) return '';
  let value = '';
  try { value = new URLSearchParams(raw).get('k') || ''; } catch { return ''; }
  return validSecret(value) ? value : '';
}


// Accept a raw key, or a live/debug URL that carries ?k= / #k=.
export function studioKeyFromPaste(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (validSecret(text)) return text;
  try {
    const url = new URL(text, 'https://tjm.art');
    const fromSearch = studioKeyFromSearch(url.search);
    if (fromSearch) return fromSearch;
    const fromHash = studioKeyFromHash(url.hash);
    if (fromHash) return fromHash;
  } catch { /* not a URL */ }
  // Last chance: find k=… in free text (private links file paste).
  const match = /(?:^|[?&#])k=([A-Za-z0-9_-]{16,128})/.exec(text);
  return match && validSecret(match[1]) ? match[1] : '';
}

export function readStudioCookie(cookieHeader) {
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== STUDIO_COOKIE) continue;
    let value = trimmed.slice(eq + 1);
    try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
    return validSecret(value) ? value : '';
  }
  return '';
}

export function studioCookieHeader(key) {
  if (!validSecret(key)) return '';
  return STUDIO_COOKIE + '=' + encodeURIComponent(key)
    + '; Path=' + STUDIO_COOKIE_PATH
    + '; Max-Age=' + STUDIO_COOKIE_MAX_AGE
    + '; Secure; SameSite=Strict';
}

export function writeStudioCookie(target, key) {
  const header = studioCookieHeader(key);
  if (!header || !target) return false;
  try {
    target.cookie = header;
    return true;
  } catch {
    return false;
  }
}

// A key in this load's URL is an explicit pair. After that, this context's
// localStorage wins, then the shared cookie (Safari and a Home Screen app).
export function resolveStudioKey({storage, cookie = '', hash = '', search = ''} = {}) {
  const explicit = studioKeyFromHash(hash) || studioKeyFromSearch(search);
  if (explicit) return {key: explicit, source: hash && studioKeyFromHash(hash) ? 'hash' : 'search'};
  const stored = readStudioKey(storage);
  if (stored) return {key: stored, source: 'storage'};
  const saved = readStudioCookie(cookie);
  if (saved) return {key: saved, source: 'cookie'};
  return {key: '', source: ''};
}

export function readStudioKey(storage) {
  if (!storage) return '';
  try {
    const raw = storage.getItem(STUDIO_KEY_STORAGE);
    if (validSecret(raw)) return raw;
    if (!raw) return '';
    const data = JSON.parse(raw);
    return data && validSecret(data.key) ? data.key : '';
  } catch {
    return '';
  }
}

export function writeStudioKey(storage, key) {
  if (!storage || !validSecret(key)) return false;
  try {
    storage.setItem(STUDIO_KEY_STORAGE, key);
    return true;
  } catch {
    return false;
  }
}

export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomRoomCode(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = new Uint8Array(6);
  random(bytes);
  let code = 'ND-';
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return code;
}

export function randomSecret(random = crypto.getRandomValues.bind(crypto)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(32);
  random(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function createDebugCredentials(random) {
  const room = randomRoomCode(random);
  const secret = randomSecret(random);
  let key = randomSecret(random);
  if (key === secret) key = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a');
  return {room, secret, key, autoApply: true};
}

function alignmentCorners(input) {
  if (!Array.isArray(input) || input.length !== 4) return null;
  const pts = [];
  for (const corner of input) {
    const x = corner && +corner.x;
    const y = corner && +corner.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < -1.5 || x > 2.5 || y < -1.5 || y > 2.5) return null;
    pts.push({x, y});
  }
  const [tl, tr, br, bl] = pts;
  if (!(tl.x < tr.x && bl.x < br.x && tl.y < bl.y && tr.y < br.y)) return null;
  const edges = [0, 1, 2, 3].map(i => ({x: pts[(i + 1) % 4].x - pts[i].x, y: pts[(i + 1) % 4].y - pts[i].y}));
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = edges[i];
    const b = edges[(i + 1) % 4];
    if (!(a.x * b.y - a.y * b.x > 0)) return null;
    area += pts[i].x * pts[(i + 1) % 4].y - pts[(i + 1) % 4].x * pts[i].y;
  }
  if (!(Math.abs(area) * 0.5 >= 0.04)) return null;
  return pts;
}

const DEBUG_ACTIONS = new Set([
  'align', 'cancel-align', 'verify-align',
  'clear-sim', 'sim-off', 'sim-seed', 'sim-on',
  'add-sim',
  'clear-markers', 'clear-manual-markers',
  'frame-detect', 'frame-retry', 'frame-clear', 'painting-reference', 'snap-projector-frame',
  'start', 'pause',
  'markers-on', 'markers-off',
  'hide-controls', 'show-controls',
  'reset-camera',
  'reload',
  'listen',
  'stop-listen',
  'toggle-pattern',
  'align-border',
  'cycle-scan',
  'toggle-person',
  'toggle-bloom',
  'toggle-light',
  'latency-test',
  'lock-quad',
  'unlock-quad',
  'scan-stickers', 'sticker-crosshair', 'sticker-calibrate',
  // Alignment precision (TJ Nov 11): auto align, crosshair / walk checks,
  // 1-point recheck, saved calibration, grid size.
  'auto-align', 'xhair-show', 'xhair-measure', 'xhair-fix', 'walk-start', 'walk-next',
  'precision-stop', 'recheck-align', 'align-grid', 'restore-calibration'
]);

export function viewerPath(session) {
  return '/neural-dance/debug/?room=' + encodeURIComponent(session.room) + '&key=' + encodeURIComponent(session.key);
}

// Remote tuning. Numbers are clamped to the sliders on /neural-dance/live/.
export function sanitizeDebugPatch(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  if (input.markerMode === 'both' || input.markerMode === 'pink' || input.markerMode === 'stickers') out.markerMode = input.markerMode;
  const num = (key, lo, hi) => {
    const value = +input[key];
    if (!Number.isFinite(value)) return;
    out[key] = Math.min(hi, Math.max(lo, value));
  };
  num('noteSensitivity', 0.25, 1);
  num('stickerSensitivity', 0, 1);
  num('personSensitivity', 0, 1);
  if (input.personPause === true || input.personPause === false) out.personPause = input.personPause;
  if (input.gapScan === true || input.gapScan === false) out.gapScan = input.gapScan;
  if (input.scanMode === 'black' || input.scanMode === 'white' || input.scanMode === 'gray' || input.scanMode === 'off') out.scanMode = input.scanMode;
  num('scanInterval', 2, 12);
  num('scanDuration', 150, 250);
  if (input.bloomEnabled === true || input.bloomEnabled === false) out.bloomEnabled = input.bloomEnabled;
  if (input.rippleEnabled === true || input.rippleEnabled === false) out.rippleEnabled = input.rippleEnabled;
  if (input.insetsEnabled === true || input.insetsEnabled === false) out.insetsEnabled = input.insetsEnabled;
  num('rippleIntensity', 0, 1);
  num('perspectiveStrength', 0, 1);
  num('bodyMotionSlowdown', 1, 8);
  num('stageWidthCm', 50, 2000);
  const corners = alignmentCorners(input.corners);
  if (corners) out.corners = corners;
  // One versioned commit per drag release; the room echoes it in quadInfo.version.
  if (out.corners && Number.isFinite(+input.cornersVersion) && +input.cornersVersion > 0) out.cornersVersion = Math.floor(+input.cornersVersion);
  if (out.corners && input.cornersKind === 'stage') out.cornersKind = 'stage';
  if (out.corners && (input.cornersLock === 'set' || input.cornersLock === 'clear')) out.cornersLock = input.cornersLock;
  const frameQuad = alignmentCorners(input.frameQuad);
  if (frameQuad && (input.frameLock === 'set' || input.frameLock === 'clear')) {
    out.frameQuad = frameQuad;
    out.frameLock = input.frameLock;
  }
  num('bloomIntensity', 0, 2);
  num('hueSpread', 0, 1);
  num('hipEight', 0, 1.5);
  num('shoulderEight', 0, 1.5);
  num('hipTwist', 0, 1.5);
  num('shoulderTwist', 0, 1.5);
  num('maxBodyTurn', 0, 90);
  num('turnFreq', 0, 1.5);
  num('eightDepth', 0, 1.5);
  num('eightVert', 0, 1.5);
  num('armPadSense', 0, 2);
  num('raveMoves', 0, 1.5);
  num('innerBones', 0, 2);
  num('headLook', 0, 1);
  num('bloomAura', 8, 64);
  num('hueTolerance', 18, 80);
  num('minBlobSize', 4, 200);
  num('maxBlobSize', 16, 400);
  num('quietThreshold', 0, 0.4);
  num('gravity', 0, 6);
  num('wander', 0, 0.8);
  num('threshold', 1, 1.9);
  num('peak', 1, 8);
  if (input.type != null && Number.isFinite(+input.type)) out.type = Math.min(3, Math.max(0, Math.round(+input.type)));
  const sens = [null, null, null, null];
  let anySens = false;
  if (Array.isArray(input.sens)) {
    for (let i = 0; i < 4; i++) {
      const rawSens = input.sens[i];
      if (rawSens == null || rawSens === '') continue; // null = unchanged, never "mute"
      const value = +rawSens;
      if (!Number.isFinite(value)) continue;
      sens[i] = Math.min(3, Math.max(0, value));
      anySens = true;
    }
  }
  ['kickSensitivity', 'bassSensitivity', 'snareSensitivity', 'hatSensitivity'].forEach((key, i) => {
    const value = +input[key];
    if (!Number.isFinite(value)) return;
    sens[i] = Math.min(3, Math.max(0, value));
    anySens = true;
  });
  if (anySens) out.sens = sens;
  if (input.action === 'add-sim') {
    const x = +input.x;
    const y = +input.y;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.action = 'add-sim';
      out.x = Math.min(1000, Math.max(0, x));
      out.y = Math.min(620, Math.max(0, y));
      if (Number.isFinite(+input.type)) out.type = Math.min(3, Math.max(0, Math.round(+input.type)));
    }
  } else if (input.action === 'add-manual-sticker') {
    const x = +input.x;
    const y = +input.y;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.action = 'add-manual-sticker';
      out.x = Math.min(1000, Math.max(0, x));
      out.y = Math.min(620, Math.max(0, y));
      const id = input.id | 0;
      if (id > 0 && id < 2147483647) out.id = id;
    }
  } else if (input.action === 'remove-manual-sticker') {
    const id = input.id | 0;
    if (id > 0 && id < 2147483647) {
      out.action = 'remove-manual-sticker';
      out.id = id;
      const x = +input.x;
      const y = +input.y;
      if (Number.isFinite(x)) out.x = Math.min(1000, Math.max(0, x));
      if (Number.isFinite(y)) out.y = Math.min(620, Math.max(0, y));
    }
  } else if (input.action === 'frame-accept') {
    // Painting frame Accept, optionally with the quad nudged on the debug page
    // (camera-normalised corners, same bounds as Align corners).
    out.action = 'frame-accept';
    if (Array.isArray(input.quad) && input.quad.length === 4 && input.quad.every(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y))) {
      out.quad = input.quad.map(p => ({x: Math.min(1.15, Math.max(-0.15, +p.x)), y: Math.min(1.15, Math.max(-0.15, +p.y))}));
    }
  } else if (input.action === 'sticker-color' && (input.value === 'dark' || input.value === 'white' || input.value === 'auto')) {
    out.action = 'sticker-color';
    out.value = input.value;
  } else if (input.action === 'move-manual-sticker') {
    const id = input.id | 0;
    const x = +input.x;
    const y = +input.y;
    if (id > 0 && id < 2147483647 && Number.isFinite(x) && Number.isFinite(y)) {
      out.action = 'move-manual-sticker';
      out.id = id;
      out.x = Math.min(1000, Math.max(0, x));
      out.y = Math.min(620, Math.max(0, y));
    }
  } else if (input.action === 'set-light-mode' && (input.mode === 'dot' || input.mode === 'silhouette')) {
    out.action = 'set-light-mode';
    out.mode = input.mode;
  } else if (input.action === 'set-draw-mode' && (input.mode === 'dots' || input.mode === 'silhouette' || input.mode === 'beat' || input.mode === 'full')) {
    out.action = 'set-draw-mode';
    out.mode = input.mode;
  } else if (input.action === 'crowd') {
    const cmd = sanitizeCrowdCommand(input);
    if (cmd) Object.assign(out, cmd);
  } else if (DEBUG_ACTIONS.has(input.action)) out.action = input.action;
  // Lets the debug page match the phone's reply to this click.
  if (out.action && typeof input.cmd === 'string' && /^[a-z0-9]{4,16}$/.test(input.cmd)) out.cmd = input.cmd;
  // Manual dancer edits carry a short nonce the phone echoes back (ack).
  if (/^(add|move|remove)-manual-sticker$/.test(out.action || '') && typeof input.nonce === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(input.nonce)) out.nonce = input.nonce;
  return Object.keys(out).length ? out : null;
}

// A named action is a command (Detect frame, Scan stickers, …). It runs on
// the phone even when "Auto-apply live tuning" is off. Slider patches stay
// suggestions until that box is checked.
// Crowd show/demo remote (/neural-dance/show/control/). Same studio-key
// relay as the debug page; only these ops and names pass.
export const CROWD_OPS = Object.freeze(['speed', 'jump', 'scrub', 'boost', 'reset', 'light', 'add', 'clear', 'event', 'effect', 'capture', 'interval', 'resume', 'props', 'debut-kill', 'requests-now', 'hot-check']);
export const CROWD_EVENTS = Object.freeze(['crowd-surf', 'stage-dive', 'dome-slide', 'pole-spin', 'cage-shake', 'shoulder-ride', 'conga', 'dance-circle', 'lighter-wave', 'hug-pileup', 'rope-swing']);
export const CROWD_EFFECTS = Object.freeze(['message', 'scary-face', 'blackout', 'strobe', 'wash-red', 'wash-uv', 'wash-rainbow', 'freeze', 'slow-mo', 'confetti', 'fireworks', 'glitch', 'spotlight', 'countdown', 'shout-out', 'clear-effects']);
export const CROWD_TEXT_MAX = 80;
export function cleanCrowdText(value, max = CROWD_TEXT_MAX) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f<>`\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function sanitizeCrowdCommand(input) {
  if (!input || input.action !== 'crowd' || !CROWD_OPS.includes(input.op)) return null;
  const out = {action: 'crowd', op: input.op};
  const num = (lo, hi) => { const v = +input.value; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
  if (input.op === 'speed') { const v = num(0.25, 600); if (v == null) return null; out.value = v; }
  else if (input.op === 'jump') { const v = num(-1440, 1440); if (v == null) return null; out.value = v; }
  else if (input.op === 'scrub') { const v = num(0, 440); if (v == null) return null; out.value = v; }
  else if (input.op === 'boost') { const v = num(-0.5, 0.5); if (v == null) return null; out.value = v; }
  else if (input.op === 'interval') { const v = num(20, 180); if (v == null) return null; out.value = v; }
  else if (input.op === 'event') { if (!CROWD_EVENTS.includes(input.name)) return null; out.name = input.name; }
  else if (input.op === 'effect') {
    if (!CROWD_EFFECTS.includes(input.name)) return null;
    out.name = input.name;
    const text = cleanCrowdText(input.text);
    if (text) out.text = text;
  } else if (input.op === 'capture') { if (input.force === true) out.force = true; }
  return out;
}

export function debugPatchAppliesWithoutPrompt(patch) {
  if (!patch || typeof patch !== 'object') return false;
  if (typeof patch.action === 'string' && patch.action) return true;
  // A hand drag of the pink corners must land even when auto-apply is off.
  if (patch.cornersLock === 'set' || patch.cornersLock === 'clear') return true;
  if (patch.frameLock === 'set' || patch.frameLock === 'clear') return true;
  return false;
}

// Every unacked command on a debug message, oldest first. A single pending
// patch still works for older rooms. The queue is how Painting off survives
// a second tap that would otherwise replace the only stored patch.
export function debugCommandsFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  if (Array.isArray(message.commands) && message.commands.length) {
    const out = [];
    for (const item of message.commands) {
      if (!item || !item.patch || typeof item.patch !== 'object') continue;
      out.push({id: item.id != null ? item.id : null, at: item.at, patch: item.patch});
    }
    if (out.length) return out;
  }
  const incoming = message.pendingPatch && message.pendingPatch.patch ? message.pendingPatch : null;
  const patch = (incoming && incoming.patch) || (message.patch && typeof message.patch === 'object' ? message.patch : null);
  if (!patch) return [];
  const id = incoming && incoming.id != null ? incoming.id : (message.patchId != null ? message.patchId : null);
  return [{id, at: incoming ? incoming.at : undefined, patch}];
}
