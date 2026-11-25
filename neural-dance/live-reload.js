// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Live page auto-update. The build stamps a git SHA into the page and into
// /neural-dance/version.json. This page polls that file. A newer SHA, or a
// reload message from the debug room, saves alignment, latched markers, and
// settings, then reloads. Camera, mic, and projector fullscreen are resumed
// when the browser still allows it. Anything that needs another gesture shows
// one Resume button.

export const LIVE_VERSION_MS = 10000;
export const VERSION_PATH = '/neural-dance/version.json';
export const LIVE_RESUME_KEY = 'nd.live.resume.v1';
export const RELOAD_ATTEMPT_KEY = 'nd.live.reloadAttempt';

export function cleanVersion(value) {
  if (typeof value !== 'string') return '';
  const version = value.trim();
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(version)) return '';
  if (version === '__ND_BUILD__') return '';
  return version;
}

export function readPageVersion(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return '';
  const meta = doc.querySelector('meta[name="nd-build"]');
  const content = meta && typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : '';
  return cleanVersion(content || '');
}

export function shortBuild(version) {
  const full = cleanVersion(version);
  if (!full) return '';
  return full.slice(0, 7);
}

export function paintBuildLabel(doc, version) {
  if (!doc || typeof doc.querySelector !== 'function' || typeof doc.querySelectorAll !== 'function') return '';
  const full = cleanVersion(version) || readPageVersion(doc);
  const short = shortBuild(full);
  for (const node of doc.querySelectorAll('[data-nd-build]')) {
    if (!short) {
      node.hidden = true;
      node.textContent = '';
      continue;
    }
    node.hidden = false;
    node.textContent = short;
    node.title = 'Build ' + full;
    node.setAttribute('aria-label', 'Build ' + short);
  }
  return short;
}

export function versionChanged(current, remote) {
  const here = cleanVersion(current);
  const next = cleanVersion(remote);
  if (!here || !next) return false;
  return here !== next;
}

export function shouldReload(current, remote, attempted) {
  if (!versionChanged(current, remote)) return false;
  const next = cleanVersion(remote);
  return !attempted || attempted !== next;
}

export async function fetchLiveVersion(fetchImpl, path = VERSION_PATH) {
  if (typeof fetchImpl !== 'function') return '';
  const response = await fetchImpl(path, {cache: 'no-store', headers: {'cache-control': 'no-cache'}});
  if (!response || response.ok === false) return '';
  let data = null;
  try { data = await response.json(); } catch { return ''; }
  return cleanVersion(data && data.version);
}

export function readResume(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let data = null;
  try {
    const raw = storage.getItem(LIVE_RESUME_KEY);
    if (raw) data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (typeof storage.removeItem === 'function') {
    try { storage.removeItem(LIVE_RESUME_KEY); } catch { /* already gone */ }
  }
  if (!data || data.pending !== true || typeof data !== 'object') return null;
  return {
    camera: data.camera === true,
    mic: data.mic === true,
    micMuted: data.micMuted === true,
    projector: data.projector === true
  };
}

export function writeResume(storage, resume) {
  if (!storage || typeof storage.setItem !== 'function' || !resume) return false;
  try {
    storage.setItem(LIVE_RESUME_KEY, JSON.stringify({
      v: 1,
      pending: true,
      camera: resume.camera === true,
      mic: resume.mic === true,
      micMuted: resume.micMuted === true,
      projector: resume.projector === true
    }));
    return true;
  } catch {
    return false;
  }
}

function memoryOf(doc) {
  try {
    const view = doc && doc.defaultView ? doc.defaultView : globalThis;
    return view.localStorage;
  } catch {
    return null;
  }
}

function sessionOf(doc) {
  try {
    const view = doc && doc.defaultView ? doc.defaultView : globalThis;
    return view.sessionStorage;
  } catch {
    return null;
  }
}

export function reloadLivePage(doc, storage) {
  if (!doc) return false;
  if (doc.body && doc.body.dataset && doc.body.dataset.reloading === '1') return false;
  if (doc.body && doc.body.dataset) doc.body.dataset.reloading = '1';
  const box = storage || memoryOf(doc);
  const cameraRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
  const camera = cameraRoot && cameraRoot.neuralDanceCamera;
  if (camera && typeof camera.captureLatch === 'function') camera.captureLatch(box);
  else if (camera && typeof camera.persist === 'function') camera.persist();
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  if (nd && typeof nd.saveSettings === 'function') nd.saveSettings();
  const micState = nd && typeof nd.micState === 'function' ? nd.micState() : '';
  writeResume(box, {
    camera: !!(camera && typeof camera.isOpen === 'function' && camera.isOpen()),
    mic: micState === 'listening' || micState === 'muted',
    micMuted: micState === 'muted',
    projector: !!(doc.fullscreenElement)
  });
  if (typeof doc.dispatchEvent === 'function') {
    try { doc.dispatchEvent(new CustomEvent('nd-before-reload')); } catch { /* the reload still proceeds */ }
  }
  const view = doc.defaultView || globalThis;
  if (view.location && typeof view.location.reload === 'function') view.location.reload();
  return true;
}

export function failedResumeParts(needs) {
  const names = [];
  if (needs && needs.camera === 'failed') names.push('camera');
  if (needs && needs.mic === 'failed') names.push('microphone');
  if (needs && needs.projector === 'failed') names.push('projector');
  return names;
}

export function resumePromptText(parts) {
  const list = parts || [];
  if (!list.length) return '';
  if (list.length === 1) return 'Tap to resume the ' + list[0] + '.';
  if (list.length === 2) return 'Tap to resume the ' + list[0] + ' and ' + list[1] + '.';
  const last = list[list.length - 1];
  return 'Tap to resume the ' + list.slice(0, -1).join(', ') + ', and ' + last + '.';
}

async function roomApi(doc) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  if (!room) return null;
  const start = Date.now();
  while (!room.neuralDance && Date.now() - start < 4000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return room.neuralDance || null;
}

export async function attemptResume(doc, resume) {
  const needs = {camera: 'skip', mic: 'skip', projector: 'skip'};
  if (!doc || !resume) return needs;
  if (resume.camera) {
    const cameraRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
    const camera = cameraRoot && cameraRoot.neuralDanceCamera;
    try {
      const ok = camera && typeof camera.ensureCamera === 'function' ? await camera.ensureCamera() : false;
      needs.camera = ok ? 'ok' : 'failed';
    } catch {
      needs.camera = 'failed';
    }
  }
  if (resume.mic) {
    try {
      const nd = await roomApi(doc);
      const ok = nd && typeof nd.resumeMic === 'function' ? await nd.resumeMic(resume.micMuted === true) : false;
      needs.mic = ok ? 'ok' : 'failed';
    } catch {
      needs.mic = 'failed';
    }
  }
  if (resume.projector) {
    if (doc.fullscreenElement) needs.projector = 'ok';
    else {
      try {
        const root = doc.documentElement;
        const pending = root && typeof root.requestFullscreen === 'function' ? root.requestFullscreen() : null;
        if (pending && typeof pending.then === 'function') await pending;
        needs.projector = doc.fullscreenElement ? 'ok' : 'failed';
      } catch {
        needs.projector = 'failed';
      }
    }
  }
  return needs;
}

function showResumePrompt(doc, parts, retry) {
  const banner = doc.querySelector && doc.querySelector('[data-live-resume]');
  if (!banner) return false;
  const text = banner.querySelector('[data-live-resume-text]');
  if (text) text.textContent = resumePromptText(parts);
  banner.hidden = false;
  const button = banner.querySelector('[data-live-resume-go]');
  if (button && button.dataset.resumeReady !== '1') {
    button.dataset.resumeReady = '1';
    button.addEventListener('click', () => { retry(); });
  }
  return true;
}

// TJ 9:08 PM "Align works sometimes then crashes": with several deploys an
// hour, the 10 s version poll reloaded the page in the middle of Align, a
// sticker scan or the alignment pattern. Hold the reload while any of those
// is running and for LIVE_BUSY_HOLD_MS after; it goes through on a later tick.
export const LIVE_BUSY_HOLD_MS = 15000;
let lastBusyAt = -Infinity;
export function liveBusy(doc, now = Date.now()) {
  if (!doc) return false;
  const body = doc.body;
  const list = body && body.classList;
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const ds = room && room.dataset ? room.dataset : {};
  const perf = (doc.defaultView && doc.defaultView.performance) || globalThis.performance;
  const perfNow = perf && typeof perf.now === 'function' ? perf.now() : 0;
  const busy = !!(
    (list && typeof list.contains === 'function' && (list.contains('nd-live-aligning') || list.contains('nd-live-placing') || list.contains('nd-live-pattern') || list.contains('nd-latency-test'))) ||
    ds.ndAlignOwn === '1' || ds.stagePattern === '1' || ds.latencyTest === '1' ||
    (+(ds.ndScanUntil || 0) > perfNow) || (+(ds.ndDarkUntil || 0) > perfNow)
  );
  if (busy) lastBusyAt = now;
  return busy || now - lastBusyAt < LIVE_BUSY_HOLD_MS;
}
export function resetLiveBusy() { lastBusyAt = -Infinity; }

export async function checkLiveVersion(doc, fetchImpl, storage) {
  if (liveBusy(doc)) return false;
  const remote = await fetchLiveVersion(fetchImpl);
  if (remote) paintBuildLabel(doc, remote);
  if (liveBusy(doc)) return false;
  const current = readPageVersion(doc);
  let attempted = '';
  try { attempted = storage && storage.getItem(RELOAD_ATTEMPT_KEY) || ''; } catch { attempted = ''; }
  if (!shouldReload(current, remote, attempted)) {
    if (current && remote && current === remote && storage && typeof storage.removeItem === 'function') {
      try { storage.removeItem(RELOAD_ATTEMPT_KEY); } catch { /* ignore */ }
    }
    return false;
  }
  if (storage && typeof storage.setItem === 'function') {
    try { storage.setItem(RELOAD_ATTEMPT_KEY, cleanVersion(remote)); } catch { /* the reload still proceeds once */ }
  }
  return reloadLivePage(doc);
}

// Screen lock / app switch (soak test, Nov 9): room-lab pauses the stage and
// releases the mic, and the camera stops, when the page is hidden. Nothing
// brought them back, so after a lock the projector stayed frozen until Start,
// Listen and Use camera were tapped again. Snapshot what was on before the
// page-level hide handlers run (window capture phase), and resume it when the
// page is visible again. Anything the browser refuses gets the Resume button.
export function captureWake(doc) {
  const room = doc && doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  const cameraRoot = doc && doc.getElementById && doc.getElementById('nd-camera-mode');
  const camera = cameraRoot && cameraRoot.neuralDanceCamera;
  let running = false;
  try { running = !!(nd && typeof nd.debugRoom === 'function' && nd.debugRoom().running); } catch { running = false; }
  const micState = nd && typeof nd.micState === 'function' ? nd.micState() : '';
  return {
    running,
    camera: !!(camera && typeof camera.isOpen === 'function' && camera.isOpen()),
    mic: micState === 'listening' || micState === 'muted',
    micMuted: micState === 'muted',
    projector: false
  };
}

export async function resumeAfterWake(doc, wake) {
  if (!doc || !wake) return {camera: 'skip', mic: 'skip', projector: 'skip'};
  if (wake.running && !wake.mic) {
    try {
      const nd = await roomApi(doc);
      if (nd && typeof nd.applyShowCommand === 'function') nd.applyShowCommand({action: 'start'});
    } catch { /* the Resume button covers it */ }
  }
  return attemptResume(doc, {camera: wake.camera, mic: wake.mic, micMuted: wake.micMuted, projector: false});
}

export function attachWakeResume(doc, onFailed) {
  if (!doc || !doc.body || doc.body.dataset.wakeResume === '1') return null;
  doc.body.dataset.wakeResume = '1';
  const view = doc.defaultView || globalThis;
  let wake = null;
  let busy = null;
  const handler = () => {
    if (doc.hidden) {
      const snap = captureWake(doc);
      if (snap.running || snap.camera || snap.mic) wake = snap;
      return;
    }
    if (!wake || busy) return;
    const w = wake;
    wake = null;
    busy = resumeAfterWake(doc, w).then(result => {
      const parts = failedResumeParts(result);
      if (parts.length && typeof onFailed === 'function') onFailed(result, w, parts);
      return result;
    }).catch(() => null).then(result => { busy = null; return result; });
  };
  if (view && typeof view.addEventListener === 'function') view.addEventListener('visibilitychange', handler, true);
  return {handler, pending: () => wake, busy: () => busy};
}

export function attachLiveReload(doc) {
  if (!doc || !doc.body || doc.body.dataset.liveReload === '1') return;
  if (!doc.querySelector || !doc.querySelector('[data-live-resume]')) return;
  doc.body.dataset.liveReload = '1';
  paintBuildLabel(doc);
  const view = doc.defaultView || globalThis;
  let pending = null;
  async function resumePending() {
    if (!pending) return;
    const result = await attemptResume(doc, pending);
    const parts = failedResumeParts(result);
    if (!parts.length) {
      const banner = doc.querySelector('[data-live-resume]');
      if (banner) banner.hidden = true;
      pending = null;
      return;
    }
    pending = {
      camera: result.camera === 'failed',
      mic: result.mic === 'failed',
      micMuted: pending.micMuted === true,
      projector: result.projector === 'failed'
    };
    showResumePrompt(doc, parts, resumePending);
  }
  attachWakeResume(doc, (result, wake, parts) => {
    pending = {
      camera: result.camera === 'failed',
      mic: result.mic === 'failed',
      micMuted: wake.micMuted === true,
      projector: false
    };
    showResumePrompt(doc, parts, resumePending);
  });
  const saved = readResume(memoryOf(doc));
  if (saved && (saved.camera || saved.mic || saved.projector)) {
    pending = saved;
    resumePending();
  }
  const session = sessionOf(doc);
  const tick = () => {
    const fetchImpl = view.fetch ? view.fetch.bind(view) : null;
    checkLiveVersion(doc, fetchImpl, session).catch(() => {});
  };
  if (typeof setInterval === 'function') {
    const timer = setInterval(tick, LIVE_VERSION_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
}

if (typeof document !== 'undefined') {
  const boot = () => attachLiveReload(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
