// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Chrome for the full-screen live page: collapse, hide, preview, fullscreen,
// and automatic projector alignment. The dancer stage and the camera stay in their own modules.

import {applyHomography, calibrationGrid, detectDiffPeaks, homographyResidual, invertHomography, matchPeaks, solveHomography, solveHomographyN} from './src/geometry.js';
import {ALIGN_TIMEOUT_MS, alignFromFrame, chooseAlignQuad, roiFromQuad,
  isValidAlignmentQuad, fitBrightQuad, fitScreenBorder, quadsAgree, showStageToast,
  homographyFromNormalized, detectionSize, PROJECTION_CORNERS, CANVAS_W, CANVAS_H} from './camera-markers.js';
import {VERIFY_DOT_RADIUS, runStickerVerify, verifySummary} from './src/sticker-verify.js';
import {REFINE_DOT_RADIUS, refineTargets, runAlignRefine} from './src/align-refine.js';
import {runStickerFlash} from './src/sticker-flash.js';
import {createVisitScan, sceneClose, sceneSignature, VISIT_COOLDOWN_MS, VISIT_COVERAGE_OFF, visitCoveragePresent} from './src/visit-scan.js';
import {PERSON_LARGE_HOLD, PERSON_MOTION_HOLD} from './src/person-occlusion.js';
import {GAP_FADE_MS, createSongGapScan, gapScanSummary, musicOnset, readGapScan} from './src/song-gap-scan.js';
import {dispatchShowCommand} from './src/show-commands.js';
import {ALIGN_AMBIENT_HOT_RATIO, ALIGN_HOLD, ALIGN_HOLD_TOTAL_MS, ALIGN_RETRY_BLANK_MS, ambientRatio, holdForCapture} from './src/align-capture.js';
import {frameMedianLum} from './src/blank-scan.js';
import {findDots} from './src/align-refine.js';
import {fitCorrection} from './src/sticker-verify.js';
import {CROSSHAIR_TARGETS, DEFAULT_STAGE_ASPECT, RECHECK_TARGET, applyH, crosshairCorrection, crosshairOffsets,
  hFromQuad, matchStickers, paintCrosshairs, paintStructuredPattern, readGridSize, readSavedCalibration,
  readStageWidthCm, recheckResult, residualStats, runStructuredLight, saveCalibration, verdictFor,
  writeGridSize, writeStageWidthCm, precisionSummary} from './src/align-precision.js';

export const ALIGN_SETTLE_MS = 280;
export const ALIGN_STABLE_FRAMES = 3;
export const ALIGN_PHASE_MS = 2500;
// Refine measures the projected outline against the Align quad. If it saw the
// corners but every correction was refused and the error stayed this large
// (camera px), the Align quad is off (TJ 8:21 PM: 85 px, shown as a ✓).
export const ALIGN_REFINE_WARN_PX = 30;

// Align finished, but refine says the quad is far off: say so instead of ✓.
export function alignLooksOff(refined, ambientHot = false) {
  if (!refined || ambientHot || !Array.isArray(refined.passes)) return false;
  if (refined.passes.some(p => p && p.applied)) return false;
  const err = +refined.finalErrorPx;
  return Number.isFinite(err) && refined.finalErrorPx !== null && err > ALIGN_REFINE_WARN_PX;
}
export const LIVE_VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

export function viewportScale(view) {
  const scale = view && +view.scale;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function zoomNeedsReset(scale) {
  return Math.abs(viewportScale({scale}) - 1) > 0.01;
}

export function nudgeViewport(doc) {
  const meta = doc && doc.querySelector && doc.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=yes, viewport-fit=cover');
  meta.setAttribute('content', LIVE_VIEWPORT);
  const view = doc.defaultView;
  if (view && view.scrollTo) view.scrollTo(0, 0);
  return true;
}

export function liveChromeConcealed(classList) {
  if (!classList || !classList.contains) return false;
  if (classList.contains('nd-control-held')) return false;
  return classList.contains('nd-live-aligning') || classList.contains('nd-live-hidden');
}

function nextFrame(limitMs = 400) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // A mirrored projector can stop requestAnimationFrame from ever firing.
    // The settle still ends, on a timer, so a phase cannot wait forever.
    const timer = setTimeout(finish, limitMs);
    if (typeof requestAnimationFrame !== 'function') {
      clearTimeout(timer);
      finish();
      return;
    }
    requestAnimationFrame(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

// Two paints, then a short pause, so the projector frame drops the chrome before the baseline.
export async function waitForAlignSettle(ms = ALIGN_SETTLE_MS) {
  await nextFrame();
  await nextFrame();
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

// One align step. The timer always wins if the work never settles.
export function runAlignPhase(label, work, budgetMs = ALIGN_PHASE_MS, schedule = setTimeout, clear = clearTimeout) {
  let timer = 0;
  const timeout = new Promise(resolve => {
    timer = schedule(() => resolve({timeout: true, message: label + ' timed out.'}), budgetMs);
  });
  const job = Promise.resolve().then(work).then(value => ({timeout: false, value}));
  return Promise.race([job, timeout]).finally(() => clear(timer));
}

export const LIVE_KEY = 'nd-live-show';
export const LIVE_DEFAULTS = {collapsed: true, hidden: false, preview: true};

function memoryOf(storage) {
  try {
    return storage || (typeof localStorage === 'undefined' ? null : localStorage);
  } catch {
    return null;
  }
}

function flag(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

export function readLiveShow(storage) {
  const box = memoryOf(storage);
  if (!box) return {...LIVE_DEFAULTS};
  let data;
  try {
    const raw = box.getItem(LIVE_KEY);
    if (!raw) return {...LIVE_DEFAULTS};
    data = JSON.parse(raw);
  } catch {
    return {...LIVE_DEFAULTS};
  }
  if (!data || typeof data !== 'object') return {...LIVE_DEFAULTS};
  return {
    collapsed: flag(data.collapsed, LIVE_DEFAULTS.collapsed),
    hidden: flag(data.hidden, false),
    preview: flag(data.preview, true)
  };
}

export function writeLiveShow(storage, state) {
  const box = memoryOf(storage);
  if (!box || !state) return false;
  try {
    box.setItem(LIVE_KEY, JSON.stringify({
      v: 1,
      collapsed: !!state.collapsed,
      hidden: !!state.hidden,
      preview: state.preview !== false
    }));
    return true;
  } catch {
    return false;
  }
}

export function applyLiveShow(doc, state) {
  const body = doc && doc.body;
  if (!body || !body.classList) return state;
  body.classList.toggle('nd-live-collapsed', !!state.collapsed);
  body.classList.toggle('nd-live-hidden', !!state.hidden);
  body.classList.toggle('nd-live-preview-off', state.preview === false);
  const collapse = doc.querySelector('[data-live="collapse"]');
  if (collapse) {
    collapse.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    collapse.textContent = state.collapsed ? 'Show controls' : 'Collapse';
  }
  const preview = doc.querySelector('[data-live="preview"]');
  if (preview) {
    preview.setAttribute('aria-pressed', state.preview === false ? 'false' : 'true');
    preview.textContent = state.preview === false ? 'Preview off' : 'Preview';
  }
  const reveal = doc.querySelector('[data-live="reveal"]');
  if (reveal) reveal.hidden = !state.hidden;
  return state;
}

function typingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

// Tap feedback shared by the live Controls bar and the debug page.
// One-shots: pressed → working → done, then back to neutral. Toggles keep
// their own aria-pressed and are not passed through here.
export const CONTROL_DONE_MS = 1000;
const phaseTimers = new WeakMap();

export function setControlPhase(button, phase) {
  if (!button || !button.dataset) return phase || '';
  const next = phase === 'pressed' || phase === 'working' || phase === 'done' ? phase : '';
  const prev = phaseTimers.get(button);
  if (prev) clearTimeout(prev);
  phaseTimers.delete(button);
  if (next) button.dataset.phase = next;
  else delete button.dataset.phase;
  const busy = next === 'pressed' || next === 'working';
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (next === 'pressed' || next === 'working') button.setAttribute('aria-pressed', 'true');
  else if (next === 'done' || next === '') button.setAttribute('aria-pressed', 'false');
  if (next === 'done') {
    const timer = setTimeout(() => {
      if (phaseTimers.get(button) !== timer) return;
      phaseTimers.delete(button);
      setControlPhase(button, '');
    }, CONTROL_DONE_MS);
    phaseTimers.set(button, timer);
  }
  return next;
}

// One-shot tap: working, then done, then neutral. Blur so a touch focus ring
// does not stay painted on the button.
export function flashOneShot(button) {
  if (!button) return;
  setControlPhase(button, 'working');
  if (typeof button.blur === 'function') button.blur();
  const timer = setTimeout(() => {
    if (phaseTimers.get(button) !== timer) return;
    phaseTimers.delete(button);
    setControlPhase(button, 'done');
  }, 160);
  phaseTimers.set(button, timer);
}

export function liveCornerLabel(info) {
  if (info && (info.manual === true || info.source === 'manual-lock')) return 'Corners: manual (locked)';
  return 'Corners: unlocked';
}

export function livePaintingLabel(p) {
  if (!p || !p.active) return 'Painting: off';
  const ref = p.reference || {};
  let text = ref.ready ? 'Painting: on · bare learned' : 'Painting: on · learning ' + (ref.frames | 0) + '/' + (ref.need | 0);
  if (ref.ready && Number.isFinite(+ref.at) && +ref.at > 0) {
    const when = learnedClock(+ref.at);
    if (when) text = 'Painting: on · bare learned at ' + when;
  }
  if (p.frameLocked) text += ' · Frame: manual (locked)';
  else if (p.fallback) text += ' · using ' + p.fallback;
  if (Number.isFinite(+p.confidence)) text += ' · frame ' + Math.round(+p.confidence * 100) + '%';
  if (Array.isArray(p.latched)) text += ' · stickers: ' + p.latched.length + ' (latched)';
  return text;
}

export function livePersonLabel(occlusion) {
  if (!occlusion) return 'Person: clear';
  if (occlusion.paused && occlusion.note) return 'Person: paused · ' + occlusion.note;
  if (occlusion.settling) return 'Person: resuming';
  return 'Person: clear';
}

export function paintLiveFixState(doc) {
  if (!doc || !doc.querySelector) return;
  const camRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  const vision = cam && typeof cam.debugState === 'function' ? cam.debugState() : null;
  const corners = doc.querySelector('[data-live-corners]');
  if (corners) corners.textContent = liveCornerLabel(vision && vision.quadInfo);
  const painting = doc.querySelector('[data-live-painting]');
  if (painting) painting.textContent = livePaintingLabel(vision && vision.painting);
  const person = doc.querySelector('[data-live-person]');
  if (person) person.textContent = livePersonLabel(vision && vision.occlusion);
}

export function runLiveControl(doc, action) {
  if (action === 'painting-reference') return relearnBarePaintingNow(doc, {});
  if (action === 'scan-stickers') return scanStickersNow(doc, {fromDebug: true});
  if (action === 'sticker-calibrate') return calibrateStickersNow(doc);
  if (action === 'auto-align') return autoAlignNow(doc, {fromDebug: true});
  if (action === 'frame-detect' || action === 'frame-retry' || action === 'frame-clear' || action === 'frame-accept') {
    dispatchShowCommand(doc, {action});
    return true;
  }
  return null;
}

function bindLiveFixControls(doc) {
  if (!doc || doc.__ndLiveFix) return;
  doc.__ndLiveFix = true;
  doc.querySelectorAll('[data-action="sim-seed"],[data-action="sim-dancers"],[data-sim-clear],[data-marker-clear],[data-capture-floor]').forEach(button => {
    button.addEventListener('click', () => flashOneShot(button));
  });
  doc.querySelectorAll('[data-live-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.liveAction;
      const label = (button.textContent || '').trim();
      flashOneShot(button);
      const note = doc.querySelector('[data-live-action-note]');
      if (note) note.textContent = label + ': working';
      const finish = () => {
        if (note) note.textContent = label + ': done';
        paintLiveFixState(doc);
      };
      let result = null;
      try { result = runLiveControl(doc, action); } catch { finish(); return; }
      if (result && typeof result.then === 'function') result.then(finish, finish);
      else setTimeout(finish, 160);
    });
  });
  const paint = () => paintLiveFixState(doc);
  doc.addEventListener('nd-show-state', paint);
  setInterval(paint, 400);
}

export function attachLiveShow(doc) {
  if (!doc || !doc.body || doc.body.dataset.liveReady === '1') return;
  if (!doc.querySelector('[data-live="fullscreen"]')) return;
  doc.body.dataset.liveReady = '1';
  let state = readLiveShow(null);
  const persist = next => {
    state = {...state, ...next};
    writeLiveShow(null, state);
    applyLiveShow(doc, state);
  };
  applyLiveShow(doc, state);
  blockPageZoom(doc);
  watchViewportZoom(doc);
  bindControlTaps(doc);
  bindLiveFixControls(doc);
  // After a person leaves and the settle window ends, run Scan stickers once
  // (TJ 4:20 PM). Replaces auto stickers; manuals stay.
  let personScanQueued = false;
  const runPersonRescan = () => {
    if (personScanQueued) return;
    personScanQueued = true;
    Promise.resolve()
      .then(() => scanStickersNow(doc, {personCheck: true}))
      .then((result) => {
        const camRoot = doc.getElementById('nd-camera-mode');
        const cam = camRoot && camRoot.neuralDanceCamera;
        if (!cam) return;
        // Someone still on the floor in the white frame: re-pause; the gate
        // runs this rescan again after a fresh clear (TJ Nov 11 3:06 PM).
        if (result && result.person && cam.rearmPersonPause) cam.rearmPersonPause();
        else if (result && result.state === 'done' && cam.personScanDone) cam.personScanDone();
      })
      .catch(() => {})
      .then(() => { personScanQueued = false; });
  };
  doc.addEventListener('nd-person-clear-rescan', runPersonRescan);
  const runOkHandScan = () => {
    if (stickerFlashBusy) return;
    // Debug-only status; projector shows only the white fade (fromDebug path
    // when debug page initiated — here we always suppress phone toasts).
    scanStickersNow(doc, {fromDebug: true, auto: true}).catch(() => {});
  };
  doc.addEventListener('nd-ok-hand-scan', runOkHandScan);
  // Seed pressed at the dancer cap (TJ Nov 11 3:12 PM): say so on stage.
  doc.addEventListener('nd-dancer-cap', event => {
    const d = event && event.detail || {};
    showStageToast(d.text || 'Dancer limit reached', 'warn', 4000, doc);
  });
  bindSongGapScan(doc);
  visitScan = createVisitScan();
  let coverageLatched = false;
  setInterval(() => {
    const camRoot = doc.getElementById('nd-camera-mode');
    const cam = camRoot && camRoot.neuralDanceCamera;
    if (cam && typeof cam.takePersonFlashRequest === 'function' && cam.takePersonFlashRequest()) {
      runPersonRescan();
    }
    if (!cam || !visitScan) return;
    const now = Date.now();
    const held = stickerFlashBusy || (cam.visitHeld && cam.visitHeld());
    if (!held && cam.considerVisitScene) cam.considerVisitScene();
    const learned = !!(cam.paintingReferenceReady && cam.paintingReferenceReady());
    // Warm painting pixels are not a visit until the background has been learned.
    const bgReady = cam.personBackgroundReady ? cam.personBackgroundReady() : false;
    const coverage = bgReady && cam.personCoverage ? cam.personCoverage() : 0;
    // A head and hands often miss the full-body gate. Coverage of the frame
    // is enough to call it a visit. After the white fade, the picture has to
    // match the settled post-scan scene again. Show animation does not match,
    // so it cannot re-arm another scan.
    if (!bgReady) coverageLatched = false;
    const read = cam.lastPersonRead || null;
    const moving = !!(read && read.motion >= PERSON_MOTION_HOLD);
    // A still, globally stale frame is not a visitor. Cancel only that
    // un-moving arm. A visit that started on a settled frame, or a person
    // who is moving, keeps going when the picture then goes global.
    const staleClear = !!(read && read.globalChange && !read.present && !read.holding && (read.bodyFraction || 0) < PERSON_LARGE_HOLD);
    const quietStale = !!(read && read.globalChange && !moving);
    if (!held && !quietStale && (cam.personInView && cam.personInView())) cam.visitClean = true;
    if (staleClear && !moving && !cam.visitClean && visitScan.cancel) {
      visitScan.cancel();
      coverageLatched = false;
    }
    const person = bgReady && !(staleClear && !moving && !cam.visitClean) && !!(cam.personInView && cam.personInView());
    const present = visitCoveragePresent(staleClear && !cam.visitClean ? 0 : coverage, held, person, coverageLatched, moving);
    coverageLatched = !held && present && (person || coverage >= VISIT_COVERAGE_OFF || (coverageLatched && moving));
    if (!present && !coverageLatched) cam.visitClean = false;
    const sceneMatch = !!(cam.sceneMatchesVisit && cam.sceneMatchesVisit());
    const step = visitScan.observe({
      present,
      now,
      scanning: !!held,
      learned,
      sceneMatch
    });
    const ready = !!(visitScan.ready && visitScan.ready());
    const personBlocked = scanFloorBlocked(cam);
    if (typeof cam.setVisitState === 'function') {
      const published = cam.setVisitState({...step, coverage, ready, sceneMatch, personBlocked});
      // setVisitState keeps a short visit record. These three ride along so a
      // debug frame can tell a disarmed detector from a clear floor, and a
      // live block from the person-pause toggle.
      if (published && typeof published === 'object') {
        published.ready = ready;
        published.sceneMatch = sceneMatch;
        published.personBlocked = personBlocked;
      }
    }
    if (step.scan && !stickerFlashBusy) scanStickersNow(doc, {visit: true, fromDebug: true}).catch(() => {});
  }, 400);
  const cancelZone = doc.querySelector('[data-align-cancel-zone]');
  if (cancelZone && cancelZone.dataset.ready !== '1') {
    cancelZone.dataset.ready = '1';
    let lastTap = 0;
    cancelZone.addEventListener('pointerup', () => {
      const now = Date.now();
      if (now - lastTap < 450) {
        lastTap = 0;
        cancelAlign(doc);
        return;
      }
      lastTap = now;
    });
  }
  const patternExit = doc.querySelector('[data-pattern-exit]');
  if (patternExit) patternExit.addEventListener('click', () => {
    const room = doc.getElementById('nd-room-lab');
    const nd = room && room.neuralDance;
    if (nd && nd.setAlignPattern) nd.setAlignPattern(false);
  });
  doc.addEventListener('pointerup', event => {
    if (doc.body.classList.contains('nd-live-aligning')) return;
    const owned = doc.getElementById('nd-room-lab');
    if (owned && owned.dataset && owned.dataset.ndAlignOwn === '1') return;
    if (!doc.body.classList.contains('nd-live-pattern')) return;
    const target = event.target;
    if (target && target.closest && target.closest('[data-align-pattern], [data-pattern-exit]')) return;
    const room = doc.getElementById('nd-room-lab');
    const nd = room && room.neuralDance;
    if (nd && nd.setAlignPattern) nd.setAlignPattern(false);
  }, true);

  const fullscreen = doc.querySelector('[data-live="fullscreen"]');
  fullscreen.addEventListener('click', () => {
    const root = doc.documentElement;
    if (doc.fullscreenElement) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      return;
    }
    const pending = root.requestFullscreen && root.requestFullscreen();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  });
  doc.querySelector('[data-live="collapse"]').addEventListener('click', () => {
    persist({collapsed: !state.collapsed, hidden: false});
  });
  doc.querySelector('[data-live="hide"]').addEventListener('click', () => {
    persist({hidden: true});
  });
  doc.querySelector('[data-live="preview"]').addEventListener('click', () => {
    persist({preview: state.preview === false});
  });
  const reveal = doc.querySelector('[data-live="reveal"]');
  if (reveal) reveal.addEventListener('click', () => persist({hidden: false}));

  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && doc.body.classList.contains('nd-live-aligning')) {
      cancelAlign(doc);
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    if (typingTarget(event.target)) return;
    const mapping = doc.querySelector('#nd-room-lab [data-action="align"]');
    const aligning = mapping && mapping.getAttribute('aria-pressed') === 'true';
    if (event.key === 'Escape' && state.hidden && !aligning) {
      persist({hidden: false});
      event.preventDefault();
    }
    if ((event.key === 'h' || event.key === 'H') && !event.metaKey && !event.ctrlKey && !event.altKey && !doc.body.classList.contains('nd-live-aligning')) {
      persist({hidden: !state.hidden});
      event.preventDefault();
    }
  }, true);

  const exitAlign = doc.querySelector('[data-live="exit-align"]');
  if (exitAlign) exitAlign.addEventListener('click', () => cancelAlign(doc));
  const cancelAlignButton = doc.querySelector('[data-cancel-align]');
  if (cancelAlignButton) cancelAlignButton.addEventListener('click', () => cancelAlign(doc));

  const room = doc.getElementById('nd-room-lab');
  if (!room) return;
  const align = room.querySelector('[data-action="align"]');
  if (align) {
    align.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (doc.body.classList.contains('nd-live-aligning')) cancelAlign(doc);
      else beginAlign(doc);
    }, true);
  }
  const startStage = () => {
    const play = room.querySelector('[data-action="play"]');
    if (play && play.textContent.trim() === 'Start') play.click();
  };
  const whenReady = () => { startStage(); };
  if (room.dataset.roomReady === '1') whenReady();
  else if (typeof MutationObserver === 'function') {
    const obs = new MutationObserver(() => {
      if (room.dataset.roomReady === '1') {
        obs.disconnect();
        whenReady();
      }
    });
    obs.observe(room, {attributes: true, attributeFilter: ['data-room-ready']});
  }
}

let alignTimer = 0;
let alignStreak = [];
let alignRun = 0;

function blockPageZoom(doc) {
  const stopGesture = event => { event.preventDefault(); };
  doc.addEventListener('gesturestart', stopGesture, {passive: false, capture: true});
  doc.addEventListener('gesturechange', stopGesture, {passive: false, capture: true});
  let lastTouch = 0;
  doc.addEventListener('touchend', event => {
    const now = Date.now();
    const control = event.target && event.target.closest && event.target.closest('button, a, input, select, label, [data-align-cancel-zone]');
    if (!control && now - lastTouch < 350) event.preventDefault();
    lastTouch = now;
  }, {passive: false, capture: true});
  doc.addEventListener('touchmove', event => {
    if (event.touches && event.touches.length > 1) event.preventDefault();
  }, {passive: false, capture: true});
}

function watchViewportZoom(doc) {
  const button = doc.querySelector('[data-reset-zoom]');
  const view = doc.defaultView && doc.defaultView.visualViewport;
  let nudged = false;
  const apply = () => {
    const scale = view ? view.scale : 1;
    const zoomed = zoomNeedsReset(scale);
    if (zoomed && !nudged) {
      nudged = true;
      nudgeViewport(doc);
    }
    if (!zoomed) nudged = false;
    if (button) button.hidden = !zoomNeedsReset(view ? view.scale : 1);
  };
  if (view && view.addEventListener) {
    view.addEventListener('resize', apply);
    view.addEventListener('scroll', apply);
  }
  if (button) button.addEventListener('click', () => { nudgeViewport(doc); apply(); });
  apply();
}

function liveButton(target) {
  if (!target || !target.closest) return null;
  const button = target.closest('button');
  if (!button || button.disabled) return null;
  return button;
}

function setHeld(doc, held, on) {
  held.value += on ? 1 : -1;
  if (held.value < 0) held.value = 0;
  if (doc.body && doc.body.classList) {
    if (held.value > 0) doc.body.classList.add('nd-control-held');
    else doc.body.classList.remove('nd-control-held');
  }
}

// Press feedback only. preventDefault on pointerdown suppresses the click on
// iOS Safari and Android Chrome, and the following pointerup often reports 0,0.
export function bindControlTaps(doc) {
  if (!doc || doc.__ndControlTaps) return;
  doc.__ndControlTaps = true;
  const held = {value: 0};
  doc.addEventListener('pointerdown', event => {
    const button = liveButton(event.target);
    if (!button || (event.button != null && event.button > 0)) return;
    button.classList.add('is-pressed');
    button.dataset.tapPointer = String(event.pointerId);
    setHeld(doc, held, true);
  }, true);
  const release = (event, cancel) => {
    const pressed = doc.querySelectorAll ? doc.querySelectorAll('button.is-pressed') : [];
    for (const button of pressed) {
      if (button.dataset.tapPointer !== String(event.pointerId)) continue;
      button.classList.remove('is-pressed');
      delete button.dataset.tapPointer;
      setHeld(doc, held, false);
      if (cancel || event.pointerType === 'mouse') continue;
      const box = button.getBoundingClientRect ? button.getBoundingClientRect() : null;
      const x = event.clientX;
      const y = event.clientY;
      const inside = box && x >= box.left - 12 && x <= box.right + 12 && y >= box.top - 12 && y <= box.bottom + 12;
      const target = event.target === button || (button.contains && button.contains(event.target));
      if (!inside && !(x === 0 && y === 0 && target)) continue;
      const stamp = String(Date.now()) + ':' + event.pointerId;
      button.dataset.tapStamp = stamp;
      setTimeout(() => {
        if (button.dataset.tapStamp !== stamp || button.dataset.tapSawClick === stamp) return;
        button.dataset.tapEcho = stamp;
        button.click();
      }, 450);
    }
  };
  doc.addEventListener('pointerup', event => release(event, false), true);
  doc.addEventListener('pointercancel', event => release(event, true), true);
  doc.addEventListener('click', event => {
    const button = liveButton(event.target);
    if (!button) return;
    const stamp = button.dataset.tapStamp || '';
    if (button.dataset.tapEcho && button.dataset.tapEcho === stamp) {
      delete button.dataset.tapEcho;
      button.dataset.tapSawClick = stamp;
      return;
    }
    if (stamp && button.dataset.tapSawClick === stamp && event.isTrusted) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (stamp) button.dataset.tapSawClick = stamp;
  }, true);
}

function setAlignFlash(doc, mode) {
  const flash = doc.querySelector && doc.querySelector('[data-align-flash]');
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  if (mode === 'black' || mode === 'white') {
    const pattern = doc.querySelector && doc.querySelector('[data-cal-pattern]');
    if (pattern) pattern.hidden = true;
    if (room && room.dataset) {
      delete room.dataset.stagePattern;
      room.dataset.ndAlignFlash = mode;
    }
  } else if (room && room.dataset) delete room.dataset.ndAlignFlash;
  if (!flash) return;
  if (mode !== 'black' && mode !== 'white') {
    flash.hidden = true;
    flash.style.opacity = '';
    flash.removeAttribute('data-mode');
    return;
  }
  flash.hidden = false;
  flash.dataset.mode = mode;
}

function showAlignPattern(doc, on) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  if (room) {
    // dataset is a getter-only map on a live element. Assigning it throws and
    // used to reject Align immediately after the black-phase message.
    if (!room.dataset) {
      try { room.dataset = {}; } catch { /* already a DOMStringMap */ }
    }
    if (room.dataset) {
      if (on) {
        room.dataset.stagePattern = '1';
        delete room.dataset.ndAlignFlash;
      } else if (room.dataset.ndAlignOwn !== '1') delete room.dataset.stagePattern;
    }
    const nd = room.neuralDance;
    if (nd && typeof nd.redraw === 'function') nd.redraw();
    else if (nd && typeof nd.setAlignPattern === 'function') nd.setAlignPattern(!!on);
  }
  const pattern = doc.querySelector && doc.querySelector('[data-cal-pattern]');
  if (pattern) pattern.hidden = !on;
  if (on) setAlignFlash(doc, null);
}

function paintAlignReadout(doc, report) {
  const node = doc.querySelector('[data-align-readout]');
  const place = doc.querySelector('[data-place-corners]');
  if (place) place.hidden = false;
  if (!node) return;
  node.hidden = false;
  const names = ['1 red', '2 teal', '3 blue', '4 yellow'];
  const bits = names.map((name, index) => name + (report && report.found && report.found[index] ? ' ✓' : ' —'));
  const reason = report && report.reason ? ' · ' + report.reason : '';
  const stable = report && report.stable ? ' · ' + report.stable + '/' + ALIGN_STABLE_FRAMES : '';
  node.textContent = bits.join('  ') + stable + reason;
}

// Align progress on the wall: a small dim pill in the middle of the stage
// (away from the corner squares and the screen edges the white fit reads),
// with the step, the frames that agree, and a countdown (TJ, Nov 10).
export function alignProgressText(state) {
  if (!state) return '';
  const left = Math.max(0, Math.ceil(((state.totalMs || 0) - (state.elapsedMs || 0)) / 1000));
  const tryNote = state.tries > 1 && state.attempt > 1 ? ' · try ' + state.attempt + '/' + state.tries : '';
  const agree = state.need ? ' · ' + (state.agree || 0) + '/' + state.need + ' frames' : '';
  return 'Align ' + state.step + '/' + state.steps + ' ' + String(state.phase || '').toLowerCase() + tryNote + agree + ' · ~' + left + ' s';
}

export function alignProgressFraction(state) {
  if (!state) return 0;
  const byTime = state.totalMs > 0 ? state.elapsedMs / state.totalMs : 0;
  const byStep = ((state.step || 1) - 1 + (state.need ? Math.min(1, (state.agree || 0) / state.need) : 0)) / Math.max(1, state.steps || 3);
  return Math.max(0, Math.min(1, Math.max(byTime * 0.5, byStep)));
}

function paintAlignProgress(doc, state) {
  if (!doc || !doc.body) return;
  let node = doc.querySelector && doc.querySelector('[data-align-progress]');
  if (!node && state && doc.createElement && doc.body.appendChild) {
    node = doc.createElement('div');
    node.setAttribute('data-align-progress', '');
    node.setAttribute('aria-live', 'polite');
    node.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1000012;pointer-events:none;width:min(34vw,260px);padding:5px 8px 6px;border-radius:8px;background:rgba(40,40,40,.55);color:#9a9a9a;font:600 11px/1.2 Inter,system-ui,sans-serif;text-align:center';
    const label = doc.createElement('div');
    label.setAttribute('data-align-progress-label', '');
    const track = doc.createElement('div');
    track.style.cssText = 'margin-top:4px;height:4px;border-radius:2px;background:rgba(120,120,120,.35);overflow:hidden';
    const bar = doc.createElement('div');
    bar.setAttribute('data-align-progress-bar', '');
    bar.style.cssText = 'height:100%;width:0;background:#8a8a8a';
    track.appendChild(bar);
    node.appendChild(label);
    node.appendChild(track);
    doc.body.appendChild(node);
  }
  if (!node) return;
  if (!state) {
    node.hidden = true;
    if (node.style) node.style.display = 'none';
    return;
  }
  node.hidden = false;
  if (node.style) node.style.display = 'block';
  const fraction = alignProgressFraction(state);
  if (node.dataset) {
    node.dataset.phase = String(state.phase || '');
    node.dataset.fraction = fraction.toFixed(3);
  }
  const label = node.querySelector && node.querySelector('[data-align-progress-label]');
  if (label) label.textContent = alignProgressText(state);
  const bar = node.querySelector && node.querySelector('[data-align-progress-bar]');
  if (bar && bar.style) bar.style.width = Math.round(fraction * 100) + '%';
}

export function cancelAlign(doc) {
  cancelPrecision(doc);
  finishAlign(doc, 'Alignment cancelled.');
}

function redrawStage(doc) {
  const room = doc && doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  if (nd && typeof nd.redraw === 'function') nd.redraw();
}

function alignHasSideControls(doc) {
  const stage = doc && doc.querySelector && doc.querySelector('#nd-room-projector');
  if (!stage || !stage.getBoundingClientRect) return false;
  const view = doc.defaultView || globalThis;
  const box = stage.getBoundingClientRect();
  const width = view.innerWidth || 0;
  const height = view.innerHeight || 0;
  if (!(width > 0) || !(height > 0)) return false;
  return box.top > 48 || box.left > 48 || (width - box.right) > 48 || (height - box.bottom) > 48;
}

function setAlignClean(doc, on) {
  if (!doc || !doc.body || !doc.body.classList) return;
  const side = !!(on && alignHasSideControls(doc));
  if (on && !side) doc.body.classList.add('nd-align-clean');
  else doc.body.classList.remove('nd-align-clean');
  const zone = doc.querySelector && doc.querySelector('[data-align-cancel-zone]');
  if (zone) zone.hidden = !on || side;
}

function finishAlign(doc, message, run) {
  if (run != null && run !== alignRun) return;
  alignRun += 1;
  clearTimeout(alignTimer);
  alignTimer = 0;
  if (!doc || !doc.body) return;
  doc.body.classList.remove('nd-live-aligning');
  doc.body.classList.remove('nd-align-clean');
  doc.body.classList.remove('nd-align-from-debug');
  const owned = doc.getElementById && doc.getElementById('nd-room-lab');
  if (owned && owned.dataset) {
    delete owned.dataset.ndAlignOwn;
    delete owned.dataset.ndAlignFlash;
    delete owned.dataset.ndAlignFlashAlpha;
    delete owned.dataset.stagePattern;
    delete owned.dataset.ndStickerScan;
    delete owned.dataset.ndScanFlash;
  }
  setAlignClean(doc, false);
  showAlignPattern(doc, false);
  setAlignFlash(doc, null);
  const flashDone = doc.querySelector && doc.querySelector('[data-align-flash]');
  if (flashDone) { flashDone.hidden = true; flashDone.style.opacity = ''; flashDone.removeAttribute('data-mode'); }
  const refineDone = doc.querySelector && doc.querySelector('[data-align-refine]');
  if (refineDone) refineDone.style.display = 'none';
  redrawStage(doc);
  paintAlignProgress(doc, null);
  const camRootDone = doc.getElementById && doc.getElementById('nd-camera-mode');
  const camDone = camRootDone && camRootDone.neuralDanceCamera;
  if (camDone && camDone.setAlignProgress) camDone.setAlignProgress(null);
  const exit = doc.querySelector('[data-live="exit-align"]');
  if (exit) exit.hidden = true;
  const cancel = doc.querySelector('[data-cancel-align]');
  if (cancel) cancel.hidden = true;
  const readout = doc.querySelector('[data-align-readout]');
  if (readout) readout.hidden = true;
  const place = doc.querySelector('[data-place-corners]');
  if (place) place.hidden = true;
  if (doc.body && doc.body.classList) doc.body.classList.remove('nd-live-placing');
  alignStreak = [];
  const align = doc.querySelector('#nd-room-lab [data-action="align"]');
  if (align) {
    align.textContent = 'Align projector';
    align.setAttribute('aria-pressed', 'false');
  }
  if (message) {
    const status = doc.querySelector('#nd-room-lab [data-status]');
    if (status) status.textContent = message;
  }
  const camRoot = doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (cam && cam.armAlignedMarkers) cam.armAlignedMarkers();
}

function flashLock(doc) {
  const outline = doc.querySelector('[data-align-lock-outline]');
  if (!outline) return;
  outline.hidden = false;
  setTimeout(() => { outline.hidden = true; }, 2500);
}

// Closed-loop refine overlay: the parallelogram through the align circle
// positions with a bright dot at each corner. Lines stop short of the dots so
// the camera centroid is the dot alone.
export function paintRefineOutline(ctx, width, height, targets = refineTargets()) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const r = Math.max(6, REFINE_DOT_RADIUS * width);
  const pts = targets.map(t => ({x: t.x * width, y: t.y * height}));
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(3, width / 300);
  // Each edge breaks at its midpoint dot too, so no line touches a dot.
  // A 4x4 grid (precision strategy 1) is dots only: its edge dots are not
  // midpoints, and lines between them would touch them.
  const segs = [];
  for (let i = 0; i < (pts.length === 9 ? 4 : 0); i++) {
    const m = pts[4 + i];
    if (m) segs.push([pts[i], m], [m, pts[(i + 1) % 4]]);
    else segs.push([pts[i], pts[(i + 1) % 4]]);
  }
  for (const [a, b] of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const gap = Math.min(0.45, (r * 3) / len);
    ctx.beginPath();
    ctx.moveTo(a.x + (b.x - a.x) * gap, a.y + (b.y - a.y) * gap);
    ctx.lineTo(b.x - (b.x - a.x) * gap, b.y - (b.y - a.y) * gap);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function setRefineStage(doc, mode, targets = null) {
  const host = doc.getElementById && doc.getElementById('nd-room-projector');
  let canvas = doc.querySelector && doc.querySelector('[data-align-refine]');
  if (!canvas && host && doc.createElement) {
    canvas = doc.createElement('canvas');
    canvas.setAttribute('data-align-refine', '');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:9;pointer-events:none;display:none;background:#000';
    host.appendChild(canvas);
  }
  if (mode === 'dots') {
    setAlignFlash(doc, 'black');
    if (canvas) {
      const w = Math.max(1, Math.round(canvas.clientWidth || (host && host.clientWidth) || 1000));
      const h = Math.max(1, Math.round(canvas.clientHeight || (host && host.clientHeight) || 620));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.display = 'block';
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) paintStageDots(ctx, w, h, Array.isArray(targets) ? targets : calibrationGrid(3));
    }
    return;
  }
  if (mode === 'outline') {
    setAlignFlash(doc, null);
    if (canvas) {
      const w = Math.max(1, Math.round((canvas.clientWidth || (host && host.clientWidth) || 1000)));
      const h = Math.max(1, Math.round((canvas.clientHeight || (host && host.clientHeight) || 620)));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.display = 'block';
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) paintRefineOutline(ctx, w, h, Array.isArray(targets) && targets.length ? targets : refineTargets());
    }
    return;
  }
  if (canvas) canvas.style.display = 'none';
  setAlignFlash(doc, mode === 'black' ? 'black' : null);
}

// Sticker check canvas: black with a white dot where the map puts each sticker.
export function paintStageDots(ctx, width, height, dots) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  const r = Math.max(5, VERIFY_DOT_RADIUS * width);
  for (const d of dots || []) {
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    ctx.beginPath();
    ctx.arc(d.x * width, d.y * height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function setVerifyStage(doc, mode) {
  if (Array.isArray(mode) || mode === 'black') {
    setRefineStage(doc, 'outline');
    const canvas = doc.querySelector && doc.querySelector('[data-align-refine]');
    const ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (ctx) paintStageDots(ctx, canvas.width, canvas.height, Array.isArray(mode) ? mode : []);
    if (canvas && canvas.dataset) canvas.dataset.paint = String((+canvas.dataset.paint || 0) + 1);
    return;
  }
  setRefineStage(doc, null);
}

// Where the camera sees each sticker (0-1, quad-free). Live detections first;
// latched sticker markers mapped back through the current quad otherwise.
export function stickerCameraPoints(state) {
  if (!state) return [];
  const w = +state.detectWidth;
  const h = +state.detectHeight;
  const seen = Array.isArray(state.stickers) && w > 0 && h > 0
    ? state.stickers.filter(s => s && Array.isArray(s.grid)).map(s => ({x: s.grid[0] / w, y: s.grid[1] / h}))
    : [];
  if (seen.length) return seen;
  const quad = state.quad;
  if (!Array.isArray(quad) || quad.length !== 4 || !Array.isArray(state.markers)) return [];
  const back = solveHomography(PROJECTION_CORNERS, quad);
  if (!back) return [];
  return state.markers.filter(m => m && m.kind === 'sticker' && Number.isFinite(+m.x)).map(m => applyHomography(back, +m.x, +m.y)).filter(p => p && Number.isFinite(p.x));
}

export function stageOfCamera(quad, p) {
  const H = homographyFromNormalized(quad, 1, 1);
  if (!H) return null;
  const s = applyHomography(H, p.x, p.y);
  return s ? {x: s.x / CANVAS_W, y: s.y / CANVAS_H} : null;
}

async function stickerCheck(doc, cam, alive, settleMs) {
  if (!cam || !cam.grabFrame || !cam.debugState || !cam.setNormalizedCorners) return null;
  const state = cam.debugState();
  const points = stickerCameraPoints(state);
  const report = (v) => { if (cam.setVerifyReport) cam.setVerifyReport(v); };
  return runStickerVerify({
    stickers: () => points,
    quad: () => (cam.debugState().quad || null),
    setQuad: (q) => !!cam.setNormalizedCorners(q, 'Corrected by the sticker check.', {relatch: true}),
    stageOf: stageOfCamera,
    show: (mode) => setVerifyStage(doc, mode),
    wait: (ms) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()),
    grab: () => cam.grabFrame(),
    alive,
    report
  }, {settleMs: Math.max(settleMs > 0 ? 700 : 0, settleMs)});
}

let verifyBusy = false;
// Debug "Check stickers": no full Align, just the sticker residual + fix.
export async function verifyStickersNow(doc, options = {}) {
  if (!doc || !doc.body || verifyBusy || doc.body.classList.contains('nd-live-aligning')) return null;
  const camRoot = doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (!cam) return null;
  verifyBusy = true;
  const room = doc.getElementById('nd-room-lab');
  const wasClean = doc.body.classList.contains('nd-align-clean');
  try {
    if (cam.ensureCamera) { try { await cam.ensureCamera(); } catch { /* frames decide */ } }
    setAlignClean(doc, true);
    if (room && room.dataset) room.dataset.ndAlignOwn = '1';
    const settle = Number.isFinite(+options.settleMs) ? +options.settleMs : 700;
    const result = await stickerCheck(doc, cam, () => true, settle);
    if (!options.fromDebug && result) showStageToast(verifySummary(result), result.applied ? 'ok' : 'busy', 5000, doc);
    return result;
  } finally {
    if (room && room.dataset) delete room.dataset.ndAlignOwn;
    if (!wasClean) setAlignClean(doc, false);
    setRefineStage(doc, null);
    redrawStage(doc);
    verifyBusy = false;
  }
}

async function refineAfterAlign(doc, cam, corners, alive, settleMs, ambientHot = false) {
  if (!cam || !cam.grabFrame || !corners) return null;
  showAlignPattern(doc, false);
  const report = (state) => { if (cam.setRefineReport) cam.setRefineReport(state); };
  report({passes: [], finalErrorPx: null, converged: false, stopped: '', done: false});
  // 3x3 or 4x4 dot grid, robust fit, per-dot residuals (TJ Nov 11, strategy 1).
  const grid = readGridSize(null);
  const targets = refineTargets(grid);
  const stageWidthCm = readStageWidthCm(null);
  const stageAspect = stageAspectOf(doc);
  publishPrecision({kind: 'grid', grid, state: 'running', message: 'projecting the ' + grid + '×' + grid + ' dot grid'});
  const result = await runAlignRefine(corners, {
    show: (mode) => setRefineStage(doc, mode, targets),
    wait: () => waitForAlignSettle(settleMs),
    pause: () => waitForAlignSettle(1000),
    grab: () => cam.grabFrame(),
    alive,
    // Person-pause must not block refine during Align (hotfix).
    personPresent: () => false,
    report
  }, {ambientHot: !!ambientHot, targets, fitOptions: {stageWidthCm, stageAspect}});
  setRefineStage(doc, null);
  if (result && Array.isArray(result.points) && result.points.length) {
    const stats = residualStats(result.points);
    publishPrecision({kind: 'grid', grid, state: 'done', ok: true, points: result.points, stats, verdict: verdictFor(stats), stageWidthCm});
  } else {
    publishPrecision({kind: 'grid', grid, state: 'done', ok: false, reason: (result && result.stopped) || 'dots not found'});
  }
  return result;
}

let stickerFlashBusy = false;

// True when a person is actually in the gate. personInView() also stays true
// for an OK-hand latch and for the whole settle, which deferred Scan stickers
// on a clear floor (studio #0119 and #0306: paused false, skin 0, scan still
// reported "Someone is in frame").
export function scanFloorBlocked(cam) {
  if (!cam) return false;
  const read = cam.lastPersonRead;
  const occ = cam.lastOcclusion;
  if (read && !read.skip && (read.present || read.holding)) return true;
  if (occ && (occ.held === 'person' || occ.held === 'motion' || occ.held === 'scan')) return true;
  if (read || occ) return false;
  return !!(cam.personInView && cam.personInView());
}

function quietVisitAfterFlash(cam) {
  if (visitScan) visitScan.quiet(Date.now(), VISIT_COOLDOWN_MS);
  if (cam && cam.holdVisit) cam.holdVisit(VISIT_COOLDOWN_MS);
}

function armVisitAfterRelearn(cam) {
  if (visitScan && visitScan.arm) visitScan.arm();
  if (!cam) return;
  cam.visitSceneRequired = false;
  cam.visitScene = null;
  cam.visitQuietUntil = 0;
}
// Debug "Scan stickers": full white (grid, UI and silhouettes hidden) until
// exposure settles, one frame, latch, back to normal. Person in frame defers.
// Every exit path reports so the debug page never sits on "not run yet" when
// the tap was received (TJ, Nov 9: button seemed non-functional).
export async function scanStickersNow(doc, options = {}) {
  if (!doc || !doc.body) return null;
  // Crowd pages (/neural-dance/demo/, /show/) never scan stickers or flash white.
  if (doc.body.dataset && doc.body.dataset.ndCrowd) return null;
  const camRoot = doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  const fromDebug = options.fromDebug === true;
  let flashed = false;
  const report = (state) => {
    if (state && state.state === 'flashing') flashed = true;
    if (cam && cam.setStickerFlashReport) cam.setStickerFlashReport(state);
    if (fromDebug) return; // status lives on the debug panel only (TJ 4:44 PM)
    if (state.state === 'deferred' || state.state === 'aborted' || state.state === 'failed') showStageToast(state.reason, 'warn', 4000, doc);
    else if (state.state === 'done') showStageToast('✓ ' + state.count + ' sticker' + (state.count === 1 ? '' : 's') + ' found', 'ok', 2500, doc);
  };
  if (stickerFlashBusy) {
    report({state: 'deferred', count: null, reason: 'Scan stickers is already running.'});
    return null;
  }
  if (!cam || !cam.grabFrame || !cam.scanWhiteFrame) {
    report({state: 'failed', count: null, reason: 'Camera is not ready. Open the live page and allow the camera, then try again.'});
    return null;
  }
  if (doc.body.classList.contains('nd-live-aligning')) {
    report({state: 'deferred', count: null, reason: 'Align is running. Scan stickers after it finishes.'});
    return null;
  }
  // Background passes (auto, the person-clear rescan, song-gap) must not
  // replace a manual Scan stickers report. They also must not scan.
  if (options.visit !== true && (options.auto === true || options.personCheck === true || options.confident === true)) {
    return null;
  }
  stickerFlashBusy = true;
  const wasHidden = doc.body.classList.contains('nd-align-clean');
  const fastHold = Number.isFinite(+options.holdMs);
  try {
    // Fade to white first. The capture runs only after that fade, during the
    // full-white hold (runStickerFlash), then fades back out.
    const result = await holdWhiteCapture(doc, wasHidden, (frame, extras) => {
      const scan = cam.scanWhiteFrame(frame, {frames: [frame].concat(extras || [])}) || {ok: false, reason: 'scan failed'};
      return scan;
    }, {
      extraGrabs: 0,
      now: options.now,
      fadeMs: fastHold ? +options.fadeMs : undefined,
      minMs: fastHold ? Math.max(0, +options.holdMs) : undefined,
      grab: () => (cam.grabScanFrame ? cam.grabScanFrame() : cam.grabFrame()),
      prepare: () => cam.ensureCamera && cam.ensureCamera(),
      personInView: () => scanFloorBlocked(cam),
      personInFrame: (frame) => !!(cam.personInWhiteFrame && cam.personInWhiteFrame(frame)),
      alive: options.alive,
      report
    });
    if (result && result.state === 'done' && result.applied !== false) commitHomes(doc);
    if (result && result.state === 'done' && visitScan) visitScan.noteResult(result.count | 0);
    if (cam.setVisitState && result && result.state === 'done') {
      const published = cam.setVisitState({state: 'idle', label: (result.count | 0) + ' new stickers', coverage: 0, ready: !!(visitScan && visitScan.ready && visitScan.ready()), sceneMatch: !!(cam.sceneMatchesVisit && cam.sceneMatchesVisit()), personBlocked: scanFloorBlocked(cam)});
      if (published && typeof published === 'object') published.personBlocked = scanFloorBlocked(cam);
    }
    if (result && result.state === 'done' && cam.noteScanMeta) cam.noteScanMeta({settleMs: result.settleMs, kind: 'scan', wb: cam.whiteBalanceState ? cam.whiteBalanceState() : null});
    return result && result.state ? result : null;
  } finally {
    stickerFlashBusy = false;
    // A deferred or pre-fade abort never lit the projector. Quieting here
    // disarmed the next visit for the rest of the session.
    if (flashed) quietVisitAfterFlash(cam);
    try { coverStageWhite(doc, false, wasHidden); } catch { /* never leave the floor covered */ }
  }
}

export async function calibrateStickersNow(doc) {
  const camRoot = doc && doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  const say = (text) => { if (cam && cam.noteCommand) cam.noteCommand('sticker-calibrate', text); };
  if (!doc || !doc.body) return null;
  if (!cam || !cam.grabFrame || !cam.setStickerCalibration || !cam.projectionHomography) {
    say('Camera is not ready.');
    return null;
  }
  if (doc.body.classList.contains('nd-live-aligning')) {
    say('Align is running.');
    return null;
  }
  const map = cam.projectionHomography();
  const inv = map && map.H ? invertHomography(map.H) : null;
  if (!inv || !(map.videoWidth > 0)) {
    say('Align the pink corners first, then calibrate stickers.');
    return null;
  }
  const grid = calibrationGrid(3);
  const wasHidden = doc.body.classList.contains('nd-align-clean');
  try {
    setAlignClean(doc, true);
    setRefineStage(doc, 'black');
    await new Promise(resolve => setTimeout(resolve, 280));
    const dark = cam.grabFrame();
    setRefineStage(doc, 'dots', grid);
    await new Promise(resolve => setTimeout(resolve, 420));
    const lit = cam.grabFrame();
    if (!dark || !lit || dark.width !== lit.width || dark.height !== lit.height) {
      say('No camera frame. Calibration unchanged.');
      return null;
    }
    const scale = detectionSize(map.videoWidth, map.videoHeight);
    const peaks = detectDiffPeaks(dark.data, lit.data, lit.width, lit.height, {minSep: Math.max(8, lit.width * 0.04)});
    const predicted = grid.map(p => {
      const video = applyHomography(inv, p.x * CANVAS_W, p.y * CANVAS_H);
      if (!video) return null;
      return {x: video.x / scale.scaleX - 0.5, y: video.y / scale.scaleY - 0.5};
    });
    const matched = matchPeaks(peaks, predicted, Math.max(18, lit.width * 0.12));
    const src = [];
    const dst = [];
    matched.forEach((hit, i) => {
      if (!hit) return;
      src.push({x: ((hit.x + 0.5) * scale.scaleX) / map.videoWidth, y: ((hit.y + 0.5) * scale.scaleY) / map.videoHeight});
      dst.push({x: grid[i].x * CANVAS_W, y: grid[i].y * CANVAS_H});
    });
    const H = solveHomographyN(src, dst);
    if (!H || src.length < 4) {
      say('Calibrate stickers found ' + src.length + ' dots. Need at least 4. Pink quad kept.');
      return null;
    }
    const residual = homographyResidual(H, src, dst);
    cam.setStickerCalibration({H, residual});
    say('Calibration residual ' + residual.toFixed(1) + ' px');
    return {ok: true, residual, count: src.length};
  } finally {
    setRefineStage(doc, null);
    if (!wasHidden) setAlignClean(doc, false);
  }
}

export const BARE_HOLD_MIN_MS = 300;
export const BARE_HOLD_MAX_MS = 1200;

// Fixed sheet on the document, not inside #nd-room-projector. Painting mode
// CSS-warps that element onto the frame, so a white div in there is not the
// full-screen layer the projector (and the camera) see.
function bareWhiteVeil(doc, on, alpha) {
  if (!doc || !doc.body) return null;
  let veil = doc.querySelector && doc.querySelector('[data-bare-white]');
  if (!on) {
    if (veil && veil.remove) veil.remove();
    return null;
  }
  if (!veil && doc.createElement) {
    veil = doc.createElement('div');
    veil.setAttribute('data-bare-white', '');
    veil.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(veil);
  }
  if (veil) {
    veil.hidden = false;
    if (alpha != null) veil.style.opacity = String(alpha);
  }
  return veil;
}

// The projector fade (the Nov 9 white-out): the overlay opacity eases over
// the live stage. The canvas itself stays the show until the hold is fully
// white, so the ramp is not a hard cut to a white frame.
export function paintWhiteFade(doc, alpha, wasHidden) {
  const opacity = Math.max(0, Math.min(1, +alpha || 0));
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const flash = doc.querySelector && doc.querySelector('[data-align-flash]');
  setAlignClean(doc, true);
  const zone = doc.querySelector && doc.querySelector('[data-align-cancel-zone]');
  if (zone) zone.hidden = true;
  if (room && room.dataset) {
    room.dataset.ndStickerScan = '1';
    room.dataset.ndScanFlash = '1';
  }
  if (flash) {
    flash.hidden = false;
    flash.dataset.mode = 'white';
    flash.style.opacity = String(opacity);
  }
  bareWhiteVeil(doc, true, opacity);
  if (opacity >= 0.999) {
    setAlignFlash(doc, 'white');
    if (room && room.dataset) delete room.dataset.ndAlignFlashAlpha;
  } else if (room && room.dataset) {
    delete room.dataset.ndAlignFlash;
    room.dataset.ndAlignFlashAlpha = String(opacity);
  }
  redrawStage(doc);
  void wasHidden;
}

function coverStageWhite(doc, on, wasHidden, alpha) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const flash = doc.querySelector && doc.querySelector('[data-align-flash]');
  if (on) {
    paintWhiteFade(doc, typeof alpha === 'number' ? alpha : 1, wasHidden);
    return;
  }
  bareWhiteVeil(doc, false);
  setAlignFlash(doc, null);
  if (flash) {
    flash.hidden = true;
    flash.style.opacity = '';
    flash.removeAttribute('data-mode');
  }
  if (room && room.dataset) {
    delete room.dataset.ndStickerScan;
    delete room.dataset.ndAlignFlashAlpha;
    delete room.dataset.ndScanFlash;
    delete room.dataset.ndAlignFlash;
  }
  if (!wasHidden) setAlignClean(doc, false);
  redrawStage(doc);
}

let visitScan = createVisitScan();

export function currentVisitScan() { return visitScan; }

// Fade the existing white sheet in, hold it fully white until exposure
// settles, then hand the settled frame to `scan`. Fade back out after.
async function holdWhiteCapture(doc, wasHidden, scan, options = {}) {
  const flash = {
    fadeMs: options.fadeMs,
    minMs: BARE_HOLD_MIN_MS,
    maxMs: Math.max(BARE_HOLD_MAX_MS, 1500),
    extraGrabs: options.extraGrabs || 0,
    show: (alpha) => paintWhiteFade(doc, alpha, wasHidden),
    grab: options.grab,
    wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => (options.now ? options.now() : Date.now()),
    prepare: options.prepare,
    personInView: options.personInView,
    personInFrame: options.personInFrame,
    alive: options.alive,
    beforeFadeOut: options.beforeFadeOut,
    scan,
    report: options.report
  };
  if (Number.isFinite(+options.minMs)) flash.minMs = Math.max(0, +options.minMs);
  return runStickerFlash(flash);
}

function learnedClock(at) {
  try { return new Date(at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}); }
  catch { return ''; }
}

// Re-learn bare painting: fade to full white, hold until exposure settles,
// lock white balance while that white is still up, fade out, then learn the
// bare painting and drop any scan-latched dancers.
export async function relearnBarePaintingNow(doc, options = {}) {
  const camRoot = doc && doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  const cmd = options && options.cmd;
  const say = (text) => { if (cam && cam.noteCommand) cam.noteCommand('painting-reference', text, cmd); };
  if (!doc || !doc.body) return null;
  if (stickerFlashBusy) { say('Re-learn is already running.'); return null; }
  if (!cam || !cam.grabFrame || !cam.learnPaintingReference) { say('Camera is not ready.'); return null; }
  if (cam.paintingActive && !cam.paintingActive()) { say('Accept the painting frame first.'); return null; }
  if (doc.body.classList.contains('nd-live-aligning')) { say('Align is running. Re-learn after it finishes.'); return null; }
  stickerFlashBusy = true;
  const wasHidden = doc.body.classList.contains('nd-align-clean');
  try {
    coverStageWhite(doc, true, wasHidden, 0);
    say('Holding white to learn the bare painting.');
    const result = await holdWhiteCapture(doc, wasHidden, async (frame) => {
      const learned = frame && cam.learnPaintingReference([frame], Date.now());
      const when = learnedClock(Date.now());
      say(learned ? 'Bare painting learned at ' + when + '.' : 'No camera frame. Bare painting unchanged.');
      return {ok: !!learned, count: learned ? 1 : 0, reason: learned ? '' : 'unchanged'};
    }, {
      beforeFadeOut: async () => {
        if (!cam.lockWhiteBalance) return;
        try { await cam.lockWhiteBalance(); } catch { /* the picture is learned either way */ }
      },
      grab: () => (cam.grabScanFrame ? cam.grabScanFrame() : cam.grabFrame()),
      prepare: () => cam.ensureCamera && cam.ensureCamera(),
      personInFrame: (frame) => !!(cam.personInWhiteFrame && cam.personInWhiteFrame(frame)),
      fadeMs: Number.isFinite(+options.holdMs) ? +options.fadeMs : undefined,
      minMs: Number.isFinite(+options.holdMs) ? Math.max(0, +options.holdMs) : undefined,
      report: () => {}
    });
    if (result && result.state === 'done') {
      if (cam.clearAutoScanMarkers) cam.clearAutoScanMarkers();
      commitHomes(doc);
      if (cam.noteScanMeta) cam.noteScanMeta({settleMs: result.settleMs, kind: 'relearn'});
    }
    if (result && result.state !== 'done' && result.state !== 'failed') say(result.reason || 'Bare painting unchanged.');
    return !!(result && result.state === 'done');
  } finally {
    stickerFlashBusy = false;
    // The veil is down. A finished re-learn is the new empty room, so the
    // next walk-in may scan. Quieting here left visit.state idle all session.
    try { coverStageWhite(doc, false, wasHidden); } catch { /* never leave the floor covered */ }
    armVisitAfterRelearn(cam);
  }
}

// Crowd show white capture (crowd modes): the same white
// sheet, camera warmup and exposure-settled hold as Re-learn, minus the
// learning. Returns the settled full-resolution frame for a private still.
// Never throws and never leaves the white up; the show keeps running.
export async function crowdWhiteStillNow(doc, options = {}) {
  const camRoot = doc && doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (!doc || !doc.body) return {ok: false, reason: 'no page'};
  if (stickerFlashBusy) return {ok: false, reason: 'white capture already running'};
  if (!cam || !cam.grabFrame) return {ok: false, reason: 'camera unavailable'};
  stickerFlashBusy = true;
  const wasHidden = doc.body.classList.contains('nd-align-clean');
  let still = null;
  try {
    const grab = () => {
      try { return cam.grabNativeFrame ? cam.grabNativeFrame() : (cam.grabScanFrame ? cam.grabScanFrame() : cam.grabFrame()); } catch { return null; }
    };
    const result = await holdWhiteCapture(doc, wasHidden, async (frame) => {
      still = frame && frame.data ? frame : null;
      return {ok: !!still, count: still ? 1 : 0, reason: still ? '' : 'No camera frame.'};
    }, {
      grab,
      prepare: () => { try { return cam.ensureCamera && cam.ensureCamera(); } catch { return null; } },
      fadeMs: Number.isFinite(+options.fadeMs) ? +options.fadeMs : 350,
      report: () => {}
    });
    return {ok: !!still && !!result && result.state === 'done', frame: still, settleMs: result && result.settleMs, reason: (result && result.reason) || ''};
  } catch (err) {
    return {ok: false, reason: (err && err.message) || 'capture failed'};
  } finally {
    stickerFlashBusy = false;
    try { coverStageWhite(doc, false, wasHidden); } catch { /* never leave the floor covered */ }
  }
}

function commitHomes(doc) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  if (nd && typeof nd.commitStickerHomes === 'function') {
    try { nd.commitStickerHomes(); } catch { /* re-anchor rule still catches it */ }
  }
}

function listenSample(doc) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const nd = room && room.neuralDance;
  if (!nd || typeof nd.audioSample !== 'function') return null;
  try { return nd.audioSample(); } catch { return null; }
}

function gapScanEnabled(doc) {
  const camRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (cam && typeof cam.gapScanOn === 'function') return cam.gapScanOn() !== false;
  return readGapScan(null) !== false;
}

function publishGapScan(doc, report) {
  const camRoot = doc.getElementById && doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (cam && typeof cam.setGapScanReport === 'function') {
    try { cam.setGapScanReport({...report, enabled: gapScanEnabled(doc)}); } catch { /* telemetry only */ }
  }
}

function bindSongGapScan(doc) {
  if (!doc || !doc.body || doc.body.dataset.gapScanReady === '1') return;
  doc.body.dataset.gapScanReady = '1';
  const gap = createSongGapScan({enabled: gapScanEnabled(doc)});
  const tick = () => {
    if (!doc.body || !doc.body.isConnected) return;
    const sample = listenSample(doc);
    const now = sample && Number.isFinite(+sample.t) ? +sample.t : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const room = doc.getElementById('nd-room-lab');
    const nd = room && room.neuralDance;
    const micOn = nd && typeof nd.micState === 'function' ? nd.micState() === 'listening' : !!(sample && sample.gate != null);
    gap.setEnabled(gapScanEnabled(doc));
    const ev = gap.observe({
      t: now,
      lv: sample && sample.lv,
      gate: sample && sample.gate,
      listening: micOn
    });
    if (ev.action === 'abort' && gap.scanning()) {
      // alive() on the in-flight flash will see music and unwind without applying.
      gap.markScanAborted({at: Date.now(), state: 'aborted', reason: 'Music started. Stickers unchanged.'});
      publishGapScan(doc, gap.last());
      return;
    }
    if (ev.action !== 'start-scan') return;
    if (stickerFlashBusy || (doc.body && doc.body.classList.contains('nd-live-aligning'))) return;
    const camRoot = doc.getElementById('nd-camera-mode');
    const cam = camRoot && camRoot.neuralDanceCamera;
    if (!cam || !cam.grabFrame) return;
    if (cam.personInView && cam.personInView()) {
      publishGapScan(doc, {at: Date.now(), state: 'deferred', reason: 'Someone is in frame. Waiting for the floor to clear.', applied: false});
      return;
    }
    gap.markScanStarted(now);
    publishGapScan(doc, gap.last());
    const alive = () => {
      const s = listenSample(doc);
      return !musicOnset(s && s.lv, gap.activeMask(), !!(s && s.gate));
    };
    scanStickersNow(doc, {
      fromDebug: true, // no projector toast during the show
      fadeMs: GAP_FADE_MS,
      personCheck: true,
      confident: true,
      alive
    }).then((result) => {
      if (!result || result.state === 'aborted' || result.state === 'deferred') {
        gap.markScanAborted({
          at: Date.now(),
          state: (result && result.state) || 'aborted',
          reason: (result && result.reason) || 'Music started. Stickers unchanged.',
          count: result && result.count,
          applied: false
        });
      } else {
        gap.markScanFinished({
          at: Date.now(),
          state: result.state,
          reason: result.reason || '',
          count: result.count,
          applied: result.applied !== false && result.state === 'done'
        });
      }
      publishGapScan(doc, gap.last());
    }).catch(() => {
      gap.markScanAborted({at: Date.now(), state: 'failed', reason: 'Scan failed. Stickers unchanged.', applied: false});
      publishGapScan(doc, gap.last());
    });
  };
  setInterval(tick, 100);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ------------------------------------------------------------------------
// Alignment precision (TJ Nov 11: strategies 1, 3 and 4). Alignment-time
// only: nothing here runs per show frame. Every run owns the projector the
// way the sticker check does (clean stage, align-owned), and every exit
// path hands it back. Results go to the debug page (precisionTelemetry).

let precisionState = null;
let precisionRun = 0;
let precisionBusy = false;
let crosshairSession = null; // {restore} while crosshairs wait for stickers
let walkNext = false;
let lastCrosshair = null; // {quad, targets, found} from the last crosshair / walk measurement

function publishPrecision(rep) {
  precisionState = rep && typeof rep === 'object' ? {...rep, at: Date.now()} : null;
}

// Small plain object for the debug feed (collectTelemetry).
export function precisionTelemetry() {
  const saved = readSavedCalibration(null).last;
  const base = precisionState ? JSON.parse(JSON.stringify(precisionState)) : null;
  if (base && Array.isArray(base.points)) base.points = base.points.slice(0, 24);
  if (base) delete base.H;
  if (base) delete base.quad;
  return {
    report: base,
    text: base ? precisionSummary(base) : '',
    grid: readGridSize(null),
    stageWidthCm: readStageWidthCm(null),
    saved: saved ? {savedAt: saved.savedAt, source: saved.source, maxCm: saved.maxCm, rmsPx: saved.rmsPx} : null,
    busy: precisionBusy,
    crosshairs: !!crosshairSession
  };
}

function stageAspectOf(doc) {
  const box = doc && doc.querySelector && doc.querySelector('#nd-room-projector');
  const rect = box && box.getBoundingClientRect ? box.getBoundingClientRect() : null;
  return rect && rect.width > 0 && rect.height > 0 ? rect.width / rect.height : DEFAULT_STAGE_ASPECT;
}

function cameraOf(doc) {
  const root = doc && doc.getElementById && doc.getElementById('nd-camera-mode');
  return root && root.neuralDanceCamera ? root.neuralDanceCamera : null;
}

function rememberCalibration(cam, source, rep) {
  const quad = cam && typeof cam.debugState === 'function' ? cam.debugState().quad : null;
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  const stats = rep && rep.stats ? rep.stats : {};
  return saveCalibration(null, {quad, source, rmsPx: stats.rmsPx, maxPx: stats.maxPx, maxCm: stats.maxCm, grid: rep && rep.grid});
}

// Paint something on the projector canvas (black, white, a stripe or dot
// pattern, crosshairs) or hide it (null). Bumps data-paint so a viewer
// knows the picture changed.
function paintPrecisionStage(doc, paint) {
  const host = doc.getElementById && doc.getElementById('nd-room-projector');
  let canvas = doc.querySelector && doc.querySelector('[data-align-refine]');
  if (!canvas && host && doc.createElement) {
    canvas = doc.createElement('canvas');
    canvas.setAttribute('data-align-refine', '');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:9;pointer-events:none;display:none;background:#000';
    host.appendChild(canvas);
  }
  if (!canvas) return;
  if (!paint) { canvas.style.display = 'none'; return; }
  setAlignFlash(doc, null);
  const w = Math.max(1, Math.round(canvas.clientWidth || (host && host.clientWidth) || 1000));
  const h = Math.max(1, Math.round(canvas.clientHeight || (host && host.clientHeight) || 620));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.display = 'block';
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (ctx) paint(ctx, w, h);
  if (canvas.dataset) canvas.dataset.paint = String((+canvas.dataset.paint || 0) + 1);
}

function ownProjector(doc) {
  const room = doc.getElementById && doc.getElementById('nd-room-lab');
  const wasClean = !!(doc.body && doc.body.classList.contains('nd-align-clean'));
  setAlignClean(doc, true);
  if (room && room.dataset) room.dataset.ndAlignOwn = '1';
  let done = false;
  return () => {
    if (done) return;
    done = true;
    paintPrecisionStage(doc, null);
    setAlignFlash(doc, null);
    if (room && room.dataset) delete room.dataset.ndAlignOwn;
    if (!wasClean) setAlignClean(doc, false);
    redrawStage(doc);
  };
}

function precisionBlocked(doc) {
  if (!doc || !doc.body) return 'no page';
  if (precisionBusy) return 'another alignment check is running';
  if (verifyBusy || stickerFlashBusy) return 'a sticker scan is running';
  if (doc.body.classList.contains('nd-live-aligning')) return 'Align is running';
  return '';
}

export function cancelPrecision(doc) {
  precisionRun += 1;
  walkNext = false;
  if (crosshairSession) { try { crosshairSession.restore(); } catch { /* best effort */ } crosshairSession = null; }
  if (precisionState && precisionState.state && precisionState.state !== 'done') publishPrecision({...precisionState, state: 'done', ok: false, reason: 'cancelled'});
  if (doc && doc.body) redrawStage(doc);
}

const sleep = (ms) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

// Strategy 3: structured-light auto align. Black, white (projector delay),
// Gray-code stripes and their inverses, black, dot grid. ~10-20 s.
export async function autoAlignNow(doc, options = {}) {
  const blocked = precisionBlocked(doc);
  const cam = cameraOf(doc);
  if (blocked || !cam || !cam.grabFrame || !cam.setNormalizedCorners) {
    publishPrecision({kind: 'auto', state: 'done', ok: false, reason: blocked || 'camera not ready: open the live page and allow the camera'});
    return null;
  }
  precisionBusy = true;
  const run = ++precisionRun;
  const alive = () => run === precisionRun;
  if (crosshairSession) { crosshairSession.restore(); crosshairSession = null; }
  const restore = ownProjector(doc);
  const scale = Number.isFinite(+options.scale) ? Math.max(0, +options.scale) : 1;
  const stageWidthCm = readStageWidthCm(null);
  try {
    if (cam.releaseManualCornerLock) cam.releaseManualCornerLock();
    if (cam.ensureCamera) { try { await cam.ensureCamera(); } catch { /* frames decide */ } }
    if (cam.lockCamera) { try { await cam.lockCamera(false); } catch { /* optional */ } }
    if (cam.suspendScan) cam.suspendScan();
    let result = await runStructuredLight({
      show: (mode) => paintPrecisionStage(doc, mode == null ? null : (ctx, w, h) => paintStructuredPattern(ctx, w, h, mode === 'black' ? null : mode)),
      grab: () => cam.grabFrame(),
      wait: sleep,
      now: nowMs,
      alive,
      validQuad: (q) => isValidAlignmentQuad(q),
      report: (s) => publishPrecision(s)
    }, {scale, stageWidthCm, stageAspect: stageAspectOf(doc)});
    if (result && result.ok) {
      const ok = cam.setNormalizedCorners(result.quad, 'Auto-aligned (structured light).');
      if (!ok) result = {...result, ok: false, reason: 'the camera refused the fitted quad'};
      else commitHomes(doc);
    }
    const rep = result && result.ok
      ? {kind: 'auto', state: 'done', ok: true, points: result.points, stats: result.stats, verdict: verdictFor(result.stats), found: result.found, expected: result.expected, latencyMs: result.latencyMs, stageWidthCm}
      : {kind: 'auto', state: 'done', ok: false, reason: (result && result.reason) || 'failed'};
    publishPrecision(rep);
    if (rep.ok) rememberCalibration(cam, 'auto', rep);
    if (!options.fromDebug) showStageToast(precisionSummary(rep).split('\n')[0], rep.ok ? 'ok' : 'warn', 5000, doc);
    return result;
  } finally {
    restore();
    if (cam.lockCamera) { try { cam.lockCamera(true); } catch { /* telemetry says */ } }
    if (cam.armAlignedMarkers) cam.armAlignedMarkers();
    precisionBusy = false;
  }
}

// White flash until exposure settles; sticker stage points (stage px).
async function measureStickerPoints(doc, cam, alive, scale = 1) {
  if (!cam.previewWhiteFrame) return {ok: false, reason: 'camera has no sticker scan', points: []};
  paintPrecisionStage(doc, null);
  setAlignFlash(doc, 'white');
  try {
    await waitForAlignSettle(scale > 0 ? ALIGN_SETTLE_MS : 0);
    const held = await holdForCapture({grab: () => cam.grabFrame(), wait: sleep, now: nowMs, alive, spec: ALIGN_HOLD.white, scale});
    if (!alive()) return {ok: false, reason: 'cancelled', points: []};
    const frame = held && (held.frame || held.lastFrame);
    if (!frame) return {ok: false, reason: 'no camera frame', points: []};
    const r = cam.previewWhiteFrame(frame);
    return r && r.ok ? {ok: true, points: r.points || []} : {ok: false, reason: (r && r.reason) || 'scan failed', points: []};
  } finally {
    setAlignFlash(doc, null);
  }
}

function offsetsReport(kind, quad, targets, found, doc, extra = {}) {
  const stageWidthCm = readStageWidthCm(null);
  const points = crosshairOffsets(targets, found, {quad, stageWidthCm, stageAspect: stageAspectOf(doc), videoWidth: 480, videoHeight: 360});
  const stats = residualStats(points);
  return {kind, state: 'done', ok: stats.found > 0, reason: stats.found ? '' : 'no sticker found on any crosshair', points, stats, verdict: verdictFor(stats), stageWidthCm, ...extra};
}

// Strategy 4a: crosshairs at five spots. 'show' projects them and waits for
// stickers; 'measure' flashes white, finds the stickers, reports offsets;
// 'fix' applies the correction from the last measurement.
export async function crosshairCheckNow(doc, options = {}) {
  const step = options.step || 'show';
  const cam = cameraOf(doc);
  if (step === 'fix') return applyCrosshairFix(doc, cam, options);
  if (step === 'show') {
    const blocked = precisionBlocked(doc);
    if (blocked && !crosshairSession) { publishPrecision({kind: 'crosshair', state: 'done', ok: false, reason: blocked}); return null; }
    if (!crosshairSession) crosshairSession = {restore: ownProjector(doc)};
    precisionRun += 1;
    paintPrecisionStage(doc, (ctx, w, h) => paintCrosshairs(ctx, w, h, CROSSHAIR_TARGETS));
    publishPrecision({kind: 'crosshair', state: 'placing', message: 'put a sticker on the center of each numbered crosshair, then Measure'});
    return {state: 'placing'};
  }
  // measure
  if (!cam || !cam.grabFrame) { publishPrecision({kind: 'crosshair', state: 'done', ok: false, reason: 'camera not ready'}); return null; }
  if (precisionBusy) { publishPrecision({kind: 'crosshair', state: 'done', ok: false, reason: 'another alignment check is running'}); return null; }
  precisionBusy = true;
  const run = ++precisionRun;
  const alive = () => run === precisionRun;
  const restore = crosshairSession ? crosshairSession.restore : ownProjector(doc);
  crosshairSession = null;
  try {
    publishPrecision({kind: 'crosshair', state: 'running', message: 'measuring (white flash)'});
    const quad = cam.debugState ? cam.debugState().quad : null;
    const got = await measureStickerPoints(doc, cam, alive, Number.isFinite(+options.scale) ? +options.scale : 1);
    if (!got.ok) { publishPrecision({kind: 'crosshair', state: 'done', ok: false, reason: got.reason}); return null; }
    const found = matchStickers(CROSSHAIR_TARGETS, got.points);
    lastCrosshair = {quad, targets: CROSSHAIR_TARGETS, found, kind: 'crosshair'};
    const rep = offsetsReport('crosshair', quad, CROSSHAIR_TARGETS, found, doc);
    publishPrecision(rep);
    if (!options.fromDebug) showStageToast(precisionSummary(rep).split('\n')[0], 'ok', 5000, doc);
    return rep;
  } finally {
    restore();
    precisionBusy = false;
  }
}

function applyCrosshairFix(doc, cam, options = {}) {
  const kind = lastCrosshair ? lastCrosshair.kind : 'crosshair';
  const quad = cam && cam.debugState ? cam.debugState().quad : null;
  if (!lastCrosshair || !Array.isArray(quad)) { publishPrecision({kind, state: 'done', ok: false, reason: 'measure first'}); return null; }
  const same = lastCrosshair.quad && quad.every((p, i) => Math.hypot(p.x - lastCrosshair.quad[i].x, p.y - lastCrosshair.quad[i].y) < 1e-6);
  if (!same) { publishPrecision({kind, state: 'done', ok: false, reason: 'the map changed since the measurement: measure again'}); return null; }
  const before = offsetsReport(kind, quad, lastCrosshair.targets, lastCrosshair.found, doc);
  const fix = crosshairCorrection(quad, lastCrosshair.targets, lastCrosshair.found, fitCorrection);
  if (!fix || !(fix.shift <= 0.2) || !isValidAlignmentQuad(fix.quad)) { publishPrecision({...before, ok: false, reason: 'correction too large or not a usable stage'}); return null; }
  if (!cam.setNormalizedCorners(fix.quad, 'Corrected by the crosshair check.', {relatch: true})) { publishPrecision({...before, ok: false, reason: 'the camera refused the corrected quad'}); return null; }
  commitHomes(doc);
  const after = offsetsReport(kind, fix.quad, lastCrosshair.targets, fix.after, doc);
  const rep = {...before, applied: true, after: after.stats, afterPoints: after.points, correction: fix.kind};
  publishPrecision(rep);
  rememberCalibration(cam, kind + '-fix', after);
  lastCrosshair = {...lastCrosshair, quad: fix.quad.map(p => ({x: p.x, y: p.y})), found: fix.after};
  if (!options.fromDebug) showStageToast(precisionSummary(rep).split('\n')[0], 'ok', 5000, doc);
  return rep;
}

// Mean luma change inside a disc (detect px) between two frames.
function discChange(a, b, cx, cy, r) {
  if (!a || !b || a.width !== b.width || a.data.length !== b.data.length) return 0;
  const w = a.width;
  let s = 0, n = 0;
  const step = Math.max(1, Math.floor(r / 6));
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(a.height - 1, Math.ceil(cy + r)); y += step) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x += step) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * w + x) * 4;
      const la = a.data[i] * 0.299 + a.data[i + 1] * 0.587 + a.data[i + 2] * 0.114;
      const lb = b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114;
      s += Math.abs(la - lb);
      n++;
    }
  }
  return n ? s / n : 0;
}

export const WALK_CHANGE = 10; // mean luma change in the lit disc that means "something is on the mark"
export const WALK_STEADY_READS = 4; // ~1.2 s with no movement before measuring
export const WALK_MAX_MS = 90000; // per mark

// Strategy 4b: walk check. One crosshair at a time; when a sticker settles
// on it (or the operator presses Walk: next) the floor flashes white, the
// offset is recorded, and the next mark lights. Five marks, then a summary.
export async function walkCheckNow(doc, options = {}) {
  if (options.step === 'next') { walkNext = true; return {state: 'next'}; }
  const blocked = precisionBlocked(doc);
  const cam = cameraOf(doc);
  if (blocked || !cam || !cam.grabFrame) { publishPrecision({kind: 'walk', state: 'done', ok: false, reason: blocked || 'camera not ready'}); return null; }
  if (crosshairSession) { crosshairSession.restore(); crosshairSession = null; }
  precisionBusy = true;
  const run = ++precisionRun;
  const alive = () => run === precisionRun;
  const restore = ownProjector(doc);
  const scale = Number.isFinite(+options.scale) ? Math.max(0, +options.scale) : 1;
  const targets = CROSSHAIR_TARGETS;
  const found = targets.map(() => null);
  const quad = cam.debugState ? cam.debugState().quad : null;
  const H = hFromQuad(quad);
  walkNext = false;
  try {
    for (let k = 0; k < targets.length; k++) {
      if (!alive()) break;
      paintPrecisionStage(doc, (ctx, w, h) => paintCrosshairs(ctx, w, h, targets, {only: k}));
      publishPrecision({kind: 'walk', state: 'running', mark: k + 1, marks: targets.length, message: 'mark ' + (k + 1) + '/' + targets.length + ': put a sticker on the crosshair (or press Walk: next)'});
      await sleep(Math.round(1200 * scale));
      const ref = cam.grabFrame();
      const camPt = H ? applyH(H, targets[k].x, targets[k].y) : null;
      const edge = H ? applyH(H, targets[k].x + 0.05, targets[k].y) : null;
      let steadyReads = 0;
      let prev = null;
      let measured = false;
      const markStart = nowMs();
      for (let guard = 0; guard < 2000 && alive(); guard++) {
        if (nowMs() - markStart > WALK_MAX_MS * Math.max(scale, 0.01)) break; // skip this mark, keep walking
        const f = cam.grabFrame();
        let ready = walkNext;
        if (!ready && f && ref && camPt && edge) {
          const cx = camPt.x * f.width;
          const cy = camPt.y * f.height;
          const r = Math.max(4, Math.hypot((edge.x - camPt.x) * f.width, (edge.y - camPt.y) * f.height) * 0.8);
          const changed = discChange(ref, f, cx, cy, r) > WALK_CHANGE;
          const still = prev ? discChange(prev, f, cx, cy, r) < WALK_CHANGE / 2 : false;
          const person = cam.personInView ? !!cam.personInView() : false;
          steadyReads = changed && still && !person ? steadyReads + 1 : 0;
          ready = steadyReads >= WALK_STEADY_READS;
        }
        prev = f;
        if (ready) {
          const forced = walkNext;
          walkNext = false;
          const got = await measureStickerPoints(doc, cam, alive, scale);
          const match = got.ok ? matchStickers([targets[k]], got.points)[0] : null;
          if (match || forced) { found[k] = match; measured = true; break; }
          steadyReads = 0;
          paintPrecisionStage(doc, (ctx, w, h) => paintCrosshairs(ctx, w, h, targets, {only: k}));
          publishPrecision({kind: 'walk', state: 'running', mark: k + 1, marks: targets.length, message: 'mark ' + (k + 1) + ': no sticker on the crosshair yet'});
        }
        await sleep(Math.round(300 * scale));
      }
      if (!measured && !alive()) break;
    }
    if (!alive()) return null;
    lastCrosshair = {quad, targets, found, kind: 'walk'};
    const rep = offsetsReport('walk', quad, targets, found, doc);
    publishPrecision(rep);
    return rep;
  } finally {
    restore();
    precisionBusy = false;
    walkNext = false;
  }
}

// 1-point recheck before doors: a dot at the stage center against where the
// saved map puts it. ~2 s, no stickers needed.
export async function recheckAlignNow(doc, options = {}) {
  const blocked = precisionBlocked(doc);
  const cam = cameraOf(doc);
  const quad = cam && cam.debugState ? cam.debugState().quad : null;
  if (blocked || !cam || !cam.grabFrame) { publishPrecision({kind: 'recheck', state: 'done', ok: false, reason: blocked || 'camera not ready'}); return null; }
  if (!Array.isArray(quad)) { publishPrecision({kind: 'recheck', state: 'done', ok: false, reason: 'no alignment yet: run Align or Auto align'}); return null; }
  if (crosshairSession) { crosshairSession.restore(); crosshairSession = null; }
  precisionBusy = true;
  const run = ++precisionRun;
  const alive = () => run === precisionRun;
  const restore = ownProjector(doc);
  const scale = Number.isFinite(+options.scale) ? Math.max(0, +options.scale) : 1;
  const spec = {minMs: 500, maxMs: 2200, agree: 2};
  try {
    publishPrecision({kind: 'recheck', state: 'running', message: 'checking the center dot'});
    paintPrecisionStage(doc, (ctx, w, h) => paintStructuredPattern(ctx, w, h, null));
    await sleep(Math.round(ALIGN_SETTLE_MS * scale));
    const dark = await holdForCapture({grab: () => cam.grabFrame(), wait: sleep, now: nowMs, alive, spec, scale});
    if (!alive()) return null;
    paintPrecisionStage(doc, (ctx, w, h) => paintStructuredPattern(ctx, w, h, {kind: 'dots', dots: [RECHECK_TARGET], radius: 0.016}));
    await sleep(Math.round(ALIGN_SETTLE_MS * scale));
    const lit = await holdForCapture({grab: () => cam.grabFrame(), wait: sleep, now: nowMs, alive, spec: {...spec, exposure: false}, scale});
    if (!alive()) return null;
    const a = dark && (dark.frame || dark.lastFrame);
    const b = lit && (lit.frame || lit.lastFrame);
    let measured = null;
    if (a && b && a.data && b.data && a.width === b.width) {
      const H = hFromQuad(quad);
      const p = H && applyH(H, RECHECK_TARGET.x, RECHECK_TARGET.y);
      if (p) {
        const dots = findDots(a.data, b.data, b.width, b.height, [{x: p.x * b.width, y: p.y * b.height}], 0.13 * b.width, {nearest: true});
        if (dots[0]) measured = {x: dots[0].x / b.width, y: dots[0].y / b.height};
      }
    }
    const vw = b && b.videoWidth > 0 ? b.videoWidth : (b ? b.width : 480);
    const vh = b && b.videoHeight > 0 ? b.videoHeight : (b ? b.height : 360);
    const rep = recheckResult(quad, measured, {videoWidth: vw, videoHeight: vh, stageWidthCm: readStageWidthCm(null), stageAspect: stageAspectOf(doc)});
    publishPrecision(rep);
    if (!options.fromDebug) showStageToast(precisionSummary(rep).split('\n')[0], rep.ok && /still/.test(rep.verdict || '') ? 'ok' : 'warn', 5000, doc);
    return rep;
  } finally {
    restore();
    precisionBusy = false;
  }
}

// Debug-page buttons and settings for the precision tools.
export function applyPrecisionAction(doc, action, value) {
  if (action === 'auto-align') { autoAlignNow(doc, {fromDebug: true}).catch(() => {}); return true; }
  if (action === 'xhair-show') { crosshairCheckNow(doc, {step: 'show', fromDebug: true}).catch(() => {}); return true; }
  if (action === 'xhair-measure') { crosshairCheckNow(doc, {step: 'measure', fromDebug: true}).catch(() => {}); return true; }
  if (action === 'xhair-fix') { crosshairCheckNow(doc, {step: 'fix', fromDebug: true}).catch(() => {}); return true; }
  if (action === 'walk-start') { walkCheckNow(doc, {fromDebug: true}).catch(() => {}); return true; }
  if (action === 'walk-next') { walkCheckNow(doc, {step: 'next'}); return true; }
  if (action === 'precision-stop') { cancelPrecision(doc); return true; }
  if (action === 'recheck-align') { recheckAlignNow(doc, {fromDebug: true}).catch(() => {}); return true; }
  if (action === 'align-grid') {
    const next = writeGridSize(null, readGridSize(null) === 4 ? 3 : 4);
    publishPrecision({kind: 'grid', grid: next, state: 'set', message: 'next Align refines with a ' + next + '×' + next + ' dot grid'});
    return true;
  }
  if (action === 'restore-calibration') {
    const cam = cameraOf(doc);
    const saved = readSavedCalibration(null).last;
    const ok = !!(saved && cam && cam.setNormalizedCorners && !precisionBlocked(doc) && cam.setNormalizedCorners(saved.quad, 'Restored the saved alignment.', {relatch: true}));
    if (ok) commitHomes(doc);
    publishPrecision({kind: 'recheck', state: 'done', ok, reason: ok ? '' : (saved ? 'could not restore now' : 'nothing saved yet'), verdict: ok ? 'restored the ' + (saved.source || 'saved') + ' alignment from ' + new Date(saved.savedAt).toLocaleString() : ''});
    return true;
  }
  if (action === 'stage-width') {
    const cm = writeStageWidthCm(null, value);
    if (cm != null && precisionState) publishPrecision({...precisionState, stageWidthCm: cm, note: 'stage width set to ' + cm + ' cm (applies to the next check)'});
    return cm != null;
  }
  return false;
}

export async function beginAlign(doc, options = {}) {
  const room = doc.getElementById('nd-room-lab');
  if (!room || !doc.body) return;
  alignRun += 1;
  const run = alignRun;
  let halted = false;
  const alive = () => !halted && alignRun === run && doc.body.classList.contains('nd-live-aligning');
  const phaseMs = Number.isFinite(+options.alignPhaseMs) ? Math.max(1, +options.alignPhaseMs) : ALIGN_PHASE_MS;
  clearTimeout(alignTimer);
  doc.body.classList.add('nd-live-aligning');
  if (room.dataset) room.dataset.ndAlignOwn = '1';
  setAlignClean(doc, true);
  redrawStage(doc);
  const camAtStart = doc.getElementById('nd-camera-mode');
  const camNow = camAtStart && camAtStart.neuralDanceCamera;
  if (camNow && camNow.suspendScan) camNow.suspendScan();
  if (camNow && camNow.setMarkersEnabled) camNow.setMarkersEnabled(false, true);
  const exit = doc.querySelector('[data-live="exit-align"]');
  if (exit) exit.hidden = false;
  const cancel = doc.querySelector('[data-cancel-align]');
  if (cancel) cancel.hidden = false;
  const fromDebug = options.fromDebug === true;
  // Debug-started Align: projector shows only the pattern / flashes. Status,
  // refusals, refine px, and drag-corner controls stay on the debug panel
  // (TJ 4:44 PM).
  if (fromDebug && doc.body && doc.body.classList) doc.body.classList.add('nd-align-from-debug');
  const place = doc.querySelector('[data-place-corners]');
  if (!fromDebug && place && place.dataset && place.dataset.placeReady !== '1' && typeof place.addEventListener === 'function') {
    place.dataset.placeReady = '1';
    place.addEventListener('click', () => {
      doc.body.classList.add('nd-live-placing');
      const liveCam = doc.getElementById('nd-camera-mode');
      const api = liveCam && liveCam.neuralDanceCamera;
      if (api && api.startCornerDraft) api.startCornerDraft();
    });
  }
  if (place) place.hidden = !!fromDebug;
  const cancelZone = doc.querySelector('[data-align-cancel-zone]');
  if (fromDebug && cancelZone) cancelZone.hidden = true;
  const exitBtn = doc.querySelector('[data-live="exit-align"]');
  if (fromDebug && exitBtn) exitBtn.hidden = true;
  const cancelBtn = doc.querySelector('[data-cancel-align]');
  if (fromDebug && cancelBtn) cancelBtn.hidden = true;
  alignStreak = [];
  const align = room.querySelector('[data-action="align"]');
  if (align) {
    align.textContent = 'Cancel align';
    align.setAttribute('aria-pressed', 'false');
  }
  const camRoot = doc.getElementById('nd-camera-mode');
  const cam = camRoot && camRoot.neuralDanceCamera;
  if (cam && cam.cancelCalibration) cam.cancelCalibration(true);
  const settleMs = Number.isFinite(+options.alignSettleMs) ? +options.alignSettleMs : ALIGN_SETTLE_MS;
  const status = room.querySelector('[data-status]');
  const reportAlign = (text, report) => {
    if (cam && cam.setAlignOverlay) cam.setAlignOverlay(report || {found: [false, false, false, false], reason: text || ''});
    if (!fromDebug) {
      if (status) status.textContent = text;
      showStageToast(text, 'busy', 0, doc);
      paintAlignReadout(doc, report || {found: [false, false, false, false], reason: text});
    }
  };
  const say = (text) => reportAlign(text, {found: [false, false, false, false], reason: text});
  const grab = () => (cam && cam.grabFrame ? cam.grabFrame() : null);
  const fail = (message, prefill) => {
    if (alignRun !== run || halted) return;
    if (!doc.body.classList.contains('nd-live-aligning')) return;
    halted = true;
    giveUp(doc, cam, message, prefill, {fromDebug, keepLastGood: true, run});
  };
  const phase = async (label, work, budget) => {
    if (!alive()) return {stop: true};
    try {
      const result = await runAlignPhase(label, work, budget || phaseMs);
      if (!alive()) return {stop: true};
      if (result.timeout) {
        fail(result.message);
        return {stop: true};
      }
      return {stop: false, value: result.value};
    } catch (err) {
      if (!alive()) return {stop: true};
      fail((err && err.alignFail && err.message) || (label + ': ' + ((err && err.message) || 'failed') + '.'));
      return {stop: true};
    }
  };
  const cameraStep = await phase('Camera', async () => {
    if (cam && cam.ensureCamera) {
      try { await cam.ensureCamera(); } catch { /* the grid still tries */ }
    }
    // Align needs auto focus / white balance; it locks them again at the end.
    if (cam && cam.lockCamera) { try { await cam.lockCamera(false); } catch { /* optional */ } }
  });
  if (!cameraStep || cameraStep.stop || !alive()) return;
  // Each pattern stays up until the camera has seen it: exposure steady,
  // ALIGN_HOLD[phase].agree frames agreeing, and a minimum dwell (TJ, Nov 10).
  const dwellScale = Number.isFinite(+options.alignDwellScale) ? Math.max(0, +options.alignDwellScale) : (settleMs > 0 ? 1 : 0);
  const sampleWait = (ms) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());
  const holdBudget = (spec, tries = 1) => Math.max(phaseMs, Math.round((spec.maxMs * tries + ALIGN_RETRY_BLANK_MS * (tries - 1)) * dwellScale) + phaseMs);
  const alignStart = nowMs();
  const totalMs = Math.max(1, Math.round(ALIGN_HOLD_TOTAL_MS * dwellScale));
  const steps = 3;
  let progressState = {phase: 'Black', step: 1, attempt: 1, tries: 1};
  const progress = (p) => {
    const elapsed = nowMs() - alignStart;
    const state = {
      phase: progressState.phase,
      step: progressState.step,
      steps,
      attempt: progressState.attempt,
      tries: progressState.tries,
      agree: p ? p.agree : 0,
      need: p ? p.need : 0,
      frames: p ? p.reads : 0,
      settled: !!(p && p.settled),
      elapsedMs: Math.round(elapsed),
      totalMs
    };
    paintAlignProgress(doc, state);
    lastProgress = state;
    if (cam && cam.setAlignProgress) cam.setAlignProgress(state);
  };
  let lastProgress = null;
  const hold = (spec, measure, label) => holdForCapture({
    grab,
    measure,
    wait: sampleWait,
    now: nowMs,
    alive,
    spec,
    scale: dwellScale,
    onProgress: progress
  }).then(result => {
    if (result && !result.stop && !result.ok && result.reason === 'no camera frame') {
      const err = new Error(label + ': no camera frame.');
      err.alignFail = true;
      throw err;
    }
    return result;
  });
  say('Black phase: blanking the projector.');
  setAlignFlash(doc, 'black');
  showAlignPattern(doc, false);
  progressState = {phase: 'Black', step: 1, attempt: 1, tries: 1};
  progress(null);
  const black = await phase('Black phase', async () => {
    await waitForAlignSettle(settleMs);
    if (!alive()) return null;
    const held = await hold(ALIGN_HOLD.black, () => ({ok: true}), 'Black phase');
    if (!held || held.stop) return null;
    // Exposure never settled: still use the newest frame (old behavior).
    return held.frame;
  }, holdBudget(ALIGN_HOLD.black));
  if (!black || black.stop || !alive()) return;
  const dark = black.value;
  if (!dark || !dark.data) { fail('Black phase: no camera frame.'); return; }
  if (cam && cam.setScanReference) cam.setScanReference('black', dark);
  say('White phase: lighting the screen.');
  setAlignFlash(doc, 'white');
  progressState = {phase: 'White', step: 2, attempt: 1, tries: 1};
  progress(null);
  const white = await phase('White phase', async () => {
    await waitForAlignSettle(settleMs);
    if (!alive()) return null;
    const held = await hold(ALIGN_HOLD.white, (frame) => {
      const fit = fitBrightQuad(dark.data, frame.data, frame.width, frame.height);
      return fit && fit.ok && fit.corners ? {ok: true, corners: fit.corners, fit} : {ok: false, fit};
    }, 'White phase');
    if (!held || held.stop) return null;
    const bright = held.frame || held.lastFrame || null;
    let brightFit = null;
    if (held.ok && bright && bright.data) {
      // Fit the averaged frame (less noise); fall back to the agreeing reads.
      const fit = fitBrightQuad(dark.data, bright.data, bright.width, bright.height);
      const mean = held.results[held.results.length - 1].fit;
      brightFit = fit && fit.ok && fit.corners && quadsAgree(fit.corners, held.corners, 0.03) ? fit : {...mean, corners: held.corners};
    } else if (held.lastResult && held.lastResult.fit && held.lastResult.fit.corners) {
      brightFit = held.lastResult.fit;
    }
    return {bright, brightFit};
  }, holdBudget(ALIGN_HOLD.white));
  if (!white || white.stop || !alive()) return;
  setAlignFlash(doc, null);
  showAlignPattern(doc, true);
  const brightEarly = white.value && white.value.bright;
  const brightFitEarly = white.value && white.value.brightFit;
  // Circles ON vs settled white OFF — ambient light and the bezel cancel out.
  const markerBaseline = dark && dark.data ? dark.data : (brightEarly && brightEarly.data ? brightEarly.data : null);
  const darkLum = dark && dark.data ? frameMedianLum(dark.data, dark.width, dark.height, null) : null;
  // Exposure-free when the white fit is good (black is now held long enough
  // for auto-exposure to brighten a dark room); the old dark-frame rule otherwise.
  const ratio = brightFitEarly && brightFitEarly.ok && brightEarly ? ambientRatio(brightEarly, brightFitEarly.corners) : null;
  const ambientHot = ratio != null ? ratio > ALIGN_AMBIENT_HOT_RATIO : (darkLum != null && darkLum > 42);
  const alignRoi = brightFitEarly && brightFitEarly.corners ? roiFromQuad(brightFitEarly.corners) : null;
  say('Marker phase: red, teal, blue, and yellow corners are on the screen.');
  const tries = Math.max(1, ALIGN_HOLD.marker.tries | 0);
  const marked = await phase('Marker phase', async () => {
    let lastRead = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (!alive()) return null;
      progressState = {phase: 'Markers', step: 3, attempt, tries};
      if (attempt > 1) {
        // Not captured: blank, then hold the pattern again (retry, not move on).
        if (!fromDebug) say('Marker phase: not captured yet. Showing the corners again (try ' + attempt + ' of ' + tries + ').');
        showAlignPattern(doc, false);
        setAlignFlash(doc, 'black');
        await sampleWait(Math.round(ALIGN_RETRY_BLANK_MS * dwellScale));
        if (!alive()) return null;
        setAlignFlash(doc, null);
        showAlignPattern(doc, true);
      }
      progress(null);
      await waitForAlignSettle(settleMs);
      if (!alive()) return null;
      const held = await hold(ALIGN_HOLD.marker, (frame) => {
        // Coarse-to-fine: search the align squares inside the lit screen.
        const read = alignFromFrame(frame, markerBaseline, {roi: alignRoi});
        lastRead = read;
        if (cam && cam.setAlignOverlay) cam.setAlignOverlay({...read, progress: lastProgress});
        if (!fromDebug) paintAlignReadout(doc, read);
        // Bowtie / degenerate marker quads never count toward agreement.
        const ok = !!(read && read.corners && isValidAlignmentQuad(read.corners));
        return ok ? {ok: true, corners: read.corners, read} : {ok: false, read};
      }, 'Marker phase');
      if (!held || held.stop) return null;
      if (held.ok && held.corners) {
        const last = held.results[held.results.length - 1].read;
        return {...last, corners: held.corners, frames: held.results.length, spread: held.spread, attempt};
      }
    }
    return lastRead;
  }, holdBudget(ALIGN_HOLD.marker, tries));
  if (!marked || marked.stop || !alive()) return;
  paintAlignProgress(doc, null);
  const bright = brightEarly;
  const brightFit = brightFitEarly;
  if (cam && cam.setScanReference && bright) cam.setScanReference('white', bright);
  const border = bright && bright.data ? fitScreenBorder(bright.data, bright.width, bright.height) : null;
  const vision = cam && typeof cam.debugState === 'function' ? cam.debugState() : null;
  const previous = vision && Array.isArray(vision.quad) ? vision.quad : null;
  const locked = !!(vision && ((vision.quadInfo && vision.quadInfo.manual) || (vision.quadLock && vision.quadLock.locked)));
  // Pixel aspect of the camera frame (phones send 4:3 640x480, not 16:9); a
  // fixed 16:9 inflated the stage aspect ~1.33x and refused correct quads.
  const videoAspect = bright && bright.width > 0 && bright.height > 0 ? bright.width / bright.height : (dark && dark.width > 0 && dark.height > 0 ? dark.width / dark.height : 16 / 9);
  // Shape of the projected stage (the phone viewport the projector mirrors).
  const stageBox = doc.querySelector && doc.querySelector('#nd-room-projector');
  const stageRect = stageBox && stageBox.getBoundingClientRect ? stageBox.getBoundingClientRect() : null;
  const stageAspect = stageRect && stageRect.width > 0 && stageRect.height > 0 ? stageRect.width / stageRect.height : null;
  const choice = chooseAlignQuad({markers: marked.value, border, bright: brightFit, previous, locked, ambientHot, videoAspect, stageAspect});
  const detail = choice.warning ? choice.source + ': ' + choice.warning : (choice.reason || '');
  if (choice.ok && choice.corners && cam && cam.setNormalizedCorners && cam.setNormalizedCorners(choice.corners, 'Camera aligned to the screen.')) {
    let refineNote = '';
    let lastRefine = null;
    if (options.refine !== false) {
      say('Refining: projecting the outline and correcting the quad.');
      let refined = null;
      try { refined = await refineAfterAlign(doc, cam, choice.corners, alive, settleMs, ambientHot); } catch { refined = null; }
      if (!alive()) { setRefineStage(doc, null); return; }
      if (refined && refined.passes.some(p => p.applied) && isValidAlignmentQuad(refined.quad)) {
        const check = cam.setNormalizedCorners(refined.quad, 'Camera aligned and refined.');
        if (!check) {
          // Refine produced an implausible jump — keep the pre-refine corners.
          say('Refine refused a jump; keeping the Align quad' + (refined.finalErrorPx != null ? ' · last ' + refined.finalErrorPx.toFixed(1) + 'px' : ''));
        }
      }
      lastRefine = refined;
      if (refined && refined.finalErrorPx != null) refineNote = ' · refine ' + refined.finalErrorPx.toFixed(1) + 'px' + (refined.converged ? '' : ' (' + refined.stopped + ')');
    }
    // Sticker check: dots where the new map puts each sticker; fix the residual.
    let verifyNote = '';
    if (options.verify !== false) {
      let verified = null;
      try { verified = await stickerCheck(doc, cam, alive, settleMs); } catch { verified = null; }
      if (!alive()) { setRefineStage(doc, null); return; }
      if (verified && verified.before) verifyNote = ' · stickers ' + verified.before.meanPx + '→' + (verified.after ? verified.after.meanPx : verified.before.meanPx) + ' px';
    }
    if (cam.setMarkersEnabled) cam.setMarkersEnabled(true);
    if (cam.lockCamera) { try { cam.lockCamera(true); } catch { /* telemetry says */ } }
    const off = alignLooksOff(lastRefine, ambientHot);
    if (!off) rememberCalibration(cam, 'align', precisionState && precisionState.kind === 'grid' ? precisionState : null);
    const done = off
      ? '⚠ Align looks off by ' + Math.round(lastRefine.finalErrorPx) + ' px. Keep the phone still, room dark, nobody in front, and Align again.' + (detail ? ' · ' + detail : '')
      : '✓ Camera aligned to the screen' + refineNote + verifyNote + (detail ? ' · ' + detail : '');
    if (!fromDebug) showStageToast(done, off ? 'warn' : 'ok', off ? 8000 : 4000, doc);
    if (cam && cam.setAlignOverlay) cam.setAlignOverlay({found: [true, true, true, true], reason: done});
    flashLock(doc);
    finishAlign(doc, done, run);
    return;
  }
  const miss = detail || (ambientHot
    ? 'Align failed: too bright — corner markers washed out. Dim the room lights and Align again.'
    : 'Marker phase: corner markers were not found. Retry Align projector.');
  // Keep the last good quad. Never project a garbage draft when Align refuses
  // (TJ 4:43–4:44 PM). Phone/debug-from-debug: no drag-corner UI on the stage.
  fail(miss, null);
}

function giveUp(doc, cam, message, prefill, opts = {}) {
  if (!doc || !doc.body || !doc.body.classList.contains('nd-live-aligning')) return;
  clearTimeout(alignTimer);
  alignTimer = 0;
  const fromDebug = opts.fromDebug === true || (doc.body.classList.contains('nd-align-from-debug'));
  const keepLastGood = opts.keepLastGood !== false;
  setAlignFlash(doc, null);
  if (cam && cam.setAlignOverlay) cam.setAlignOverlay({found: [false, false, false, false], reason: message || 'Align failed.'});
  if (fromDebug || keepLastGood) {
    // Keep projecting the last good stage (or blank pattern briefly), no drag UI.
    showAlignPattern(doc, false);
    setAlignClean(doc, false);
    if (doc.body.classList) doc.body.classList.remove('nd-align-from-debug');
    if (!fromDebug) {
      const status = doc.querySelector('#nd-room-lab [data-status]');
      if (status) status.textContent = message;
      showStageToast(message, 'warn', 5000, doc);
    }
    finishAlign(doc, message, opts.run);
    return;
  }
  setAlignClean(doc, false);
  showAlignPattern(doc, true);
  doc.body.classList.add('nd-live-placing');
  if (cam && cam.startCornerDraft) cam.startCornerDraft(prefill);
  paintAlignReadout(doc, {found: [false, false, false, false], reason: message});
  showStageToast(message, 'warn', 0, doc);
  const status = doc.querySelector('#nd-room-lab [data-status]');
  if (status) status.textContent = message;
}

if (typeof document !== 'undefined') {
  const boot = () => attachLiveShow(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
