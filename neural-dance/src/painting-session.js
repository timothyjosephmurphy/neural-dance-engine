// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Painting surface session (TJ Nov 11 2026, 3:41-4:06 PM). Owns:
//  - the detected / accepted painting frame quad (camera, normalised 0..1),
//    which becomes the stage quad and the projection mask;
//  - the bare-painting reference (median luminance of a few person-free,
//    non-flash frames captured right after Accept, no stickers yet);
//  - white / auto sticker detection inside the inset painting quad, scored
//    against that reference and latched only when it holds still.
// Pure: camera-markers.js feeds it frames and wires the results.

import {createFrameSmoother, detectPaintingFrameSweep, frameFallback, frameFitsPrior, innerMatTrapezoid, normalizeQuad, quadEdgeClasses, quadJumped, readPaintingSurface, writePaintingSurface} from './painting-frame.js';
import {createWhiteStickerTracker} from './white-stickers.js';
import {detectChangedStickers, keepStableStickers, suppressShiftedStickers} from './painting-diff.js';
import {STAGE_H} from './debug-manual-stickers.js';

// Dancers drawn from a scan stand at cutout scale. measuredHeight is the full
// merged box of the changed pixels on the stage (uvH x STAGE_H). The white
// still only shows the high-contrast part of a matte cutout, so that box runs
// short (studio Nov 23: 40-85 px for cutouts TJ sizes at 105-125). The drawn
// height is floored at SCANNED_FIGURE_MIN and capped at SCANNED_FIGURE_MAX
// (silhouette MAX_FIGURE_HEIGHT); a taller measurement passes through.
export const SCANNED_FIGURE_MIN = 105;
export const SCANNED_FIGURE_MAX = 220;
export function scannedFigureHeight(uvH) {
  const v = +uvH;
  if (!(v > 0)) return {};
  const measuredHeight = Math.round(v * STAGE_H * 10) / 10;
  const projectedHeight = Math.max(SCANNED_FIGURE_MIN, Math.min(SCANNED_FIGURE_MAX, measuredHeight));
  return {measuredHeight, projectedHeight};
}

export const REFERENCE_KEY = 'nd.paintingReference.v1';

export const REFERENCE_FRAMES = 12;
export const STICKER_COLORS = ['dark', 'white', 'auto'];

export function normalizeStickerColor(value) {
  return STICKER_COLORS.includes(value) ? value : 'dark';
}

function lumaOf(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0;
  return out;
}
function medianStack(stack, n) {
  const out = new Float32Array(n), col = new Uint8Array(stack.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < stack.length; k++) col[k] = stack[k][i];
    col.sort();
    out[i] = col[col.length >> 1];
  }
  return out;
}
function rgbOf(rgba, n) {
  const out = new Uint8Array(n * 3);
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 4, o += 3) {
    out[o] = rgba[p]; out[o + 1] = rgba[p + 1]; out[o + 2] = rgba[p + 2];
  }
  return out;
}
function medianRgb(stack, n) {
  const out = new Uint8Array(n * 3), col = new Uint8Array(stack.length);
  for (let i = 0; i < n * 3; i++) {
    for (let k = 0; k < stack.length; k++) col[k] = stack[k][i];
    col.sort();
    out[i] = col[col.length >> 1];
  }
  return out;
}
function lumaFromRgb(rgb, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToBytes(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function loadReference(storage) {
  try {
    const raw = storage && storage.getItem(REFERENCE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !(data.w > 0) || !(data.h > 0) || typeof data.bare !== 'string') return null;
    const bare = b64ToBytes(data.bare);
    const n = data.w * data.h;
    if (bare.length !== n * 3) return null;
    let baseline = null;
    if (data.baseline) {
      const next = b64ToBytes(data.baseline);
      if (next.length === bare.length) baseline = next;
    }
    return {w: data.w | 0, h: data.h | 0, at: +data.at || 0, bare, baseline, baselineAt: +data.baselineAt || 0};
  } catch { return null; }
}
function clampNormQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  const pts = [];
  for (const p of quad) {
    const x = +p.x, y = +p.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))});
  }
  return pts;
}

export function createPaintingSession({storage = null, referenceFrames = REFERENCE_FRAMES} = {}) {
  const saved = readPaintingSurface(storage);
  let frameQuad = saved ? saved.frameQuad : null;           // accepted, normalised
  let frameLocked = !!(saved && saved.frameLocked);         // hand drag of the green corners
  let lastGood = frameQuad ? frameQuad.map(p => ({...p})) : null;
  let fallback = null;                                      // {quad, source} when detect is rejected
  let warp = saved && saved.warp || null;                   // {projQuad, target, short, warning}
  let stickerColor = normalizeStickerColor(saved && saved.stickerColor || (saved ? 'white' : 'dark'));
  let pending = null;                                        // detected, awaiting Accept
  let pendingInfo = null;
  const frames = createFrameSmoother();
  const storedRef = loadReference(storage);
  let colorRef = storedRef ? storedRef.bare : null;
  let baseRef = storedRef && storedRef.baseline ? storedRef.baseline : null;
  let baseAt = storedRef ? storedRef.baselineAt : 0;
  let reference = colorRef ? lumaFromRgb(colorRef, storedRef.w * storedRef.h) : null;
  let refW = storedRef ? storedRef.w : 0, refH = storedRef ? storedRef.h : 0, refAt = storedRef ? storedRef.at : 0;
  let capture = saved && !reference ? {stack: [], colors: [], w: 0, h: 0} : null;
  let lastFound = [], lastLatched = [], lastReject = null, lastScan = null;
  let scanSerial = 1;
  let moverHistory = [];
  const tracker = createWhiteStickerTracker();
  function detectOpts(quad, reference) {
    return {quad, reference, short: warp && warp.short ? warp.short : null};
  }
  function withStageHeight(list) {
    return (list || []).map(sticker => {
      const uvH = +sticker.uvH;
      if (!(uvH > 0)) return sticker;
      return {...sticker, ...scannedFigureHeight(uvH)};
    });
  }
  function moverSpots(stickers, blobs) {
    const spots = [];
    const push = (u, v, uvH) => {
      if (!(+uvH > 0) || +uvH >= 0.1) return;
      if (!Number.isFinite(+u) || !Number.isFinite(+v)) return;
      spots.push({u: +u, v: +v});
    };
    for (const sticker of stickers || []) push(sticker.u, sticker.v, sticker.uvH);
    for (const blob of blobs || []) {
      if (!blob || blob.reason === 'accept') continue;
      push(blob.u, blob.v, blob.uvH);
    }
    return spots;
  }
  function finishScan(found, kind, now) {
    const raw = found && found.stickers || [];
    const filtered = suppressShiftedStickers(raw, moverHistory);
    moverHistory.push(moverSpots(raw, found && found.view && found.view.blobs));
    if (moverHistory.length > 5) moverHistory.shift();
    if (found && found.view && filtered.dropped.length) {
      for (const blob of found.view.blobs || []) {
        if (!blob || blob.reason !== 'accept') continue;
        if (filtered.dropped.some(sticker => Math.abs(+sticker.u - +blob.u) < 0.002 && Math.abs(+sticker.v - +blob.v) < 0.002)) {
          blob.reason = 'mover';
        }
      }
    }
    if (found && found.view) rememberScan(found.view, kind, now);
    return withStageHeight(filtered.kept);
  }
  function rememberScan(view, kind, now) {
    if (!view) return null;
    lastScan = {
      kind, at: now || Date.now(), scanId: scanSerial++, settleMs: null,
      compare: view.compare !== false,
      wb: lastScan && lastScan.wb ? lastScan.wb : null,
      gains: view.gains || null,
      before: view.before || '', after: view.after || '', diff: view.diff || '',
      blobs: view.blobs || [], rejected: view.rejected || null,
      holdouts: Array.isArray(view.holdouts) ? view.holdouts : null
    };
    return lastScan;
  }
  function rememberBaseline(now) {
    lastScan = {
      kind: 'relearn', at: now || Date.now(), scanId: scanSerial++, settleMs: null,
      compare: false,
      wb: lastScan && lastScan.wb ? lastScan.wb : null,
      gains: null,
      before: '', after: '', diff: '',
      blobs: [], rejected: null, holdouts: null
    };
    return lastScan;
  }

  function persist() {
    if (!storage) return;
    writePaintingSurface(storage, frameQuad ? {frameQuad, stickerColor, warp, frameLocked: frameLocked === true, at: Date.now()} : null);
  }
  function persistReference() {
    if (!storage) return;
    try {
      if (!colorRef || !(refW > 0) || !(refH > 0)) { storage.removeItem(REFERENCE_KEY); return; }
      storage.setItem(REFERENCE_KEY, JSON.stringify({
        w: refW, h: refH, at: refAt || 0,
        bare: bytesToB64(colorRef),
        baseline: baseRef && baseRef.length === colorRef.length ? bytesToB64(baseRef) : '',
        baselineAt: baseAt || 0
      }));
    } catch { /* the in-memory reference still serves this page */ }
  }
  function diffReference(w, h) {
    if (!colorRef || refW !== w || refH !== h || colorRef.length !== w * h * 3) return null;
    if (baseRef && baseRef.length === colorRef.length) return baseRef;
    return colorRef;
  }
  const api = {
    active() { return !!frameQuad; },
    frameQuad() { return frameQuad ? frameQuad.map(p => ({...p})) : null; },
    frameLocked() { return frameLocked === true; },
    // Quad sticker scan and the person gate should use. Never null just
    // because the latest detect was rejected.
    scanQuad() {
      if (frameLocked && frameQuad) return frameQuad.map(p => ({...p}));
      if (frameQuad) return frameQuad.map(p => ({...p}));
      if (pending) return pending.map(p => ({...p}));
      return fallback ? fallback.quad.map(p => ({...p})) : null;
    },
    pending() { return pending ? pending.map(p => ({...p})) : null; },
    stickerColor() { return stickerColor; },
    setStickerColor(value) { stickerColor = normalizeStickerColor(value); persist(); tracker.clear(); return stickerColor; },
    // One sweep over the latest detect frame; the quad is offered, not applied.
    detect(frame, {proj = null, force = false} = {}) {
      if (!frame || !frame.data) return {ok: false, reason: 'no camera frame'};
      const locked = !!(frameLocked && frameQuad);
      const r = detectPaintingFrameSweep(frame.data, frame.width, frame.height);
      const useFallback = (reason, confidence) => {
        const fb = frameFallback({lastGood: lastGood || frameQuad, manual: frameLocked ? frameQuad : null, proj});
        fallback = fb;
        pendingInfo = {ok: false, reason, confidence: confidence || 0, kept: !!(lastGood || frameQuad), fallback: fb ? fb.source : ''};
        return {ok: false, ...pendingInfo, quad: fb ? fb.quad.map(p => ({...p})) : api.pending()};
      };
      if (!r.ok) return useFallback(r.reason, r.confidence);
      let norm = normalizeQuad(r.quad, frame.width, frame.height);
      const prior = pending || frameQuad;
      if (prior && quadJumped(prior, norm)) {
        const px = norm.map(p => ({x: p.x * frame.width, y: p.y * frame.height}));
        const classes = quadEdgeClasses(frame.data, frame.width, frame.height, px);
        const onMat = !classes.some(c => c.kind === 'outside');
        if (!onMat) return useFallback('quad jumped off the mat', r.confidence);
      }
      norm = frames.push(norm) || norm;
      const anchor = frameQuad || (Array.isArray(proj) && proj.length === 4 ? proj : null);
      if (anchor && !frameFitsPrior(norm, anchor)) {
        const pxQuad = norm.map(p => ({x: p.x * frame.width, y: p.y * frame.height}));
        const scored = force && r.edge === 'border' && (r.confidence || 0) >= 0.75 && innerMatTrapezoid(pxQuad, frame.height);
        if (scored) {
          pending = norm.map(p => ({...p}));
          fallback = frameQuad ? {quad: frameQuad.map(p => ({...p})), source: frameLocked ? 'manual frame lock' : 'last good frame'} : null;
          pendingInfo = {ok: true, votes: r.votes, fits: r.fits, area: r.area, confidence: r.confidence || 0, edge: r.edge, keptLock: locked, force: true};
          return {ok: true, quad: api.pending(), ...pendingInfo};
        }
        const hadFrame = !!frameQuad;
        const kept = (frameQuad || anchor).map(p => ({x: +p.x, y: +p.y}));
        if (!hadFrame) {
          frameQuad = kept.map(p => ({...p}));
          lastGood = kept.map(p => ({...p}));
          persist();
        }
        const source = frameLocked ? 'manual frame lock' : (hadFrame ? 'last good frame' : 'projector quad');
        fallback = {quad: kept.map(p => ({...p})), source};
        pending = null;
        pendingInfo = {ok: false, reason: 'frame left the projector prior', confidence: r.confidence || 0, kept: true, fallback: source};
        return {ok: false, ...pendingInfo, quad: fallback.quad.map(p => ({...p}))};
      }
      if (locked) {
        pending = norm.map(p => ({...p}));
        fallback = {quad: frameQuad.map(p => ({...p})), source: 'manual frame lock'};
        pendingInfo = {ok: true, votes: r.votes, fits: r.fits, area: r.area, confidence: r.confidence || 0, edge: r.edge || 'seed', keptLock: true};
        return {ok: true, quad: api.pending(), ...pendingInfo};
      }
      if (anchor) {
        frameQuad = norm.map(p => ({...p}));
        lastGood = frameQuad.map(p => ({...p}));
        persist();
      }
      pending = norm;
      lastGood = norm.map(p => ({...p}));
      fallback = null;
      pendingInfo = {ok: true, votes: r.votes, fits: r.fits, area: r.area, confidence: r.confidence || 0, edge: r.edge || 'seed'};
      return {ok: true, quad: api.pending(), ...pendingInfo};
    },
    // One white-flash (or reference) pass. Stickers must sit inside the
    // painting quad. expectedCount, when the caller knows it, caps the list.
    // Diff the white-lit frame against the last scan, or the bare painting
    // when no scan has been saved yet. Older stickers are in the baseline, so
    // they do not come back as new.
    scan(frame, {expectedCount = null} = {}) {
      const src = api.scanQuad();
      if (!src || !frame || !frame.data) return {ok: false, stickers: [], reason: 'no painting quad'};
      const w = frame.width, h = frame.height;
      const ref = diffReference(w, h);
      if (!ref) return {ok: false, stickers: [], reason: 'Learn the painting first.'};
      const quad = src.map(p => ({x: p.x * w, y: p.y * h}));
      const found = detectChangedStickers(frame.data, w, h, detectOpts(quad, ref));
      if (!found.ok) return {ok: false, stickers: [], reason: found.reason || 'Learn the painting first.'};
      let stickers = finishScan(found, 'scan', Date.now());
      if (expectedCount != null && Number.isFinite(+expectedCount) && +expectedCount >= 0) stickers = stickers.slice(0, expectedCount | 0);
      return {ok: true, stickers, rejected: found.rejected, count: stickers.length};
    },
    scanStable(frames) {
      const list = (frames || []).filter(frame => frame && frame.data);
      if (!list.length) return {ok: false, stickers: [], reason: 'No camera frame.'};
      const found = [];
      for (const frame of list) {
        const one = api.scan(frame);
        if (!one.ok) return one;
        found.push(one.stickers);
      }
      const sampleW = list[0].width | 0;
      const radius = Math.max(12, Math.round(12 * (sampleW || 480) / 480));
      const stickers = keepStableStickers(found, {need: list.length > 1 ? 2 : 1, radius});
      return {ok: true, stickers, count: stickers.length};
    },
    // The white frame just captured becomes the next baseline.
    commitScan(frame, now = 0) {
      if (!colorRef || !frame || !frame.data || frame.width !== refW || frame.height !== refH) return false;
      const next = rgbOf(frame.data, refW * refH);
      const prior = baseRef && baseRef.length === next.length ? baseRef : colorRef;
      const boxes = lastScan && Array.isArray(lastScan.holdouts) ? lastScan.holdouts : null;
      if (prior && boxes) {
        for (const box of boxes) {
          if (!box) continue;
          const x0 = Math.max(0, Math.floor(+box.x0));
          const y0 = Math.max(0, Math.floor(+box.y0));
          const x1 = Math.min(refW - 1, Math.ceil(+box.x1));
          const y1 = Math.min(refH - 1, Math.ceil(+box.y1));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const o = (y * refW + x) * 3;
            next[o] = prior[o];
            next[o + 1] = prior[o + 1];
            next[o + 2] = prior[o + 2];
          }
        }
      }
      baseRef = next;
      baseAt = now;
      persistReference();
      return true;
    },
    baselineReady() { return !!(baseRef && colorRef && baseRef.length === colorRef.length); },
    noteScanMeta(partial) {
      if (!partial || typeof partial !== 'object') return lastScan;
      if (!lastScan) return null;
      if (partial.settleMs != null && Number.isFinite(+partial.settleMs)) lastScan.settleMs = Math.round(+partial.settleMs);
      if (partial.wb && typeof partial.wb === 'object') lastScan.wb = {locked: partial.wb.locked === true, mode: typeof partial.wb.mode === 'string' ? partial.wb.mode : null};
      if (partial.kind === 'scan' || partial.kind === 'relearn') lastScan.kind = partial.kind;
      if (Array.isArray(partial.gains)) lastScan.gains = partial.gains.slice(0, 3).map(n => +n);
      return lastScan;
    },
    // Accept the pending quad (or one nudged by hand on the debug page).
    accept(quad = pending) {
      if (!Array.isArray(quad) || quad.length !== 4) return false;
      const clamped = clampNormQuad(quad);
      if (!clamped) return false;
      frameQuad = clamped;
      frameLocked = true;
      pending = null; pendingInfo = null;
      if (stickerColor === 'dark') stickerColor = 'white';
      api.recaptureReference();
      persist();
      return true;
    },
    // Corners nudged by hand on the debug page: same camera, so the learned
    // reference stays; only the mask / detection zone moves.
    setFrameQuad(quad) {
      const clamped = clampNormQuad(quad);
      if (!frameQuad || !clamped) return false;
      frameQuad = clamped;
      tracker.clear(); persist();
      return true;
    },
    // Where the unwarped stage lands (camera quad before the first Accept) and
    // the canvas-px target that moves it onto the frame.
    warp() { return warp ? JSON.parse(JSON.stringify(warp)) : null; },
    setWarp(next) { warp = next ? JSON.parse(JSON.stringify(next)) : null; persist(); return api.warp(); },
    retry(frame, proj = null) { pending = null; return api.detect(frame, {proj, force: true}); },
    clear() {
      frameQuad = null; frameLocked = false; lastGood = null; fallback = null; warp = null; pending = null;
      reference = null; colorRef = null; baseRef = null; baseAt = 0; refAt = 0; capture = null; lastScan = null; moverHistory = [];
      frames.reset(); tracker.clear(); persist(); persistReference();
    },
    // Only an explicit Detect frame clears a hand lock. Retry does not.
    unlockFrame() { frameLocked = false; persist(); return true; },
    lockFrame(quad) {
      const clamped = clampNormQuad(quad);
      if (!clamped) return false;
      frameQuad = clamped;
      frameLocked = true;
      lastGood = frameQuad.map(p => ({...p}));
      pending = null;
      fallback = {quad: lastGood.map(p => ({...p})), source: 'manual frame lock'};
      tracker.clear();
      persist();
      return true;
    },
    recaptureReference() {
      reference = null; colorRef = null; baseRef = null; baseAt = 0; refAt = 0; refW = 0; refH = 0;
      capture = {stack: [], colors: [], w: 0, h: 0};
      tracker.clear();
      persistReference();
    },
    // Frames grabbed while the projector is holding full white (exposure
    // already settled). One frame is enough; several become a median.
    learnReference(frames, now = 0) {
      if (!frameQuad || !Array.isArray(frames) || !frames.length) return false;
      const first = frames.find(frame => frame && frame.data && frame.width > 0 && frame.height > 0);
      if (!first) return false;
      const w = first.width, h = first.height, n = w * h;
      const stack = [];
      for (const frame of frames) {
        if (!frame || !frame.data || frame.width !== w || frame.height !== h) continue;
        stack.push(lumaOf(frame.data, n));
      }
      if (!stack.length) return false;
      const colors = [];
      for (const frame of frames) {
        if (!frame || !frame.data || frame.width !== w || frame.height !== h) continue;
        colors.push(rgbOf(frame.data, n));
      }
      const prevRef = colorRef && refW === w && refH === h ? colorRef : null;
      reference = medianStack(stack, n);
      colorRef = colors.length ? medianRgb(colors, n) : rgbOf(first.data, n);
      baseRef = null; baseAt = 0;
      refW = w; refH = h; refAt = now; capture = null;
      moverHistory = [];
      tracker.clear();
      persistReference();
      try {
        const quad = frameQuad.map(p => ({x: p.x * w, y: p.y * h}));
        if (!prevRef) {
          // The first picture has nothing to diff against. Comparing it with
          // itself drew identical Before/After and a blank Diff.
          rememberBaseline(now);
        } else {
          const found = detectChangedStickers(first.data, w, h, detectOpts(quad, prevRef));
          if (found && found.view) finishScan(found, 'relearn', now);
        }
      } catch { /* the learned picture still stands if the diagnostic fails */ }
      return true;
    },
    referenceReady() { return !!reference; },
    // Feed every detect frame. Returns latched white stickers in detect px.
    observe(frame, {blocked = false, flashing = false, now = 0} = {}) {
      if (!frameQuad || !frame || !frame.data) return [];
      const w = frame.width, h = frame.height, n = w * h;
      if (capture && !reference) {
        if (blocked || flashing) return [];
        if (capture.w !== w || capture.h !== h) capture = {stack: [], colors: [], w, h};
        capture.stack.push(lumaOf(frame.data, n));
        if (capture.stack.length >= referenceFrames) {
          // Show-light frames must not become the sticker baseline. Only a
          // white-hold Relearn (learnReference) or a white-hold Scan does.
          reference = medianStack(capture.stack, n);
          refW = w; refH = h; refAt = now; capture = null;
        }
        return [];
      }
      // White-flash diffs (Scan / Re-learn) own sticker finds once a frame is
      // active. A live show frame must not run detectWhiteStickers.
      lastFound = [];
      lastReject = null;
      return lastLatched = [];
    },
    // Live dark detection on an accepted painting latches paint and shadows
    // for every sticker color, including auto. White-flash scans find stickers.
    darkDetectionAllowed() { return !frameQuad; },
    telemetry() {
      return {
        active: !!frameQuad,
        frameQuad: api.frameQuad(),
        pending: api.pending(),
        pendingInfo,
        confidence: pendingInfo && Number.isFinite(+pendingInfo.confidence) ? pendingInfo.confidence : (frameQuad ? 1 : 0),
        frameLocked: frameLocked === true,
        fallback: fallback ? fallback.source : (pendingInfo && pendingInfo.fallback) || '',
        stickerColor,
        warp: warp ? {target: warp.target, short: warp.short, warning: warp.warning || ''} : null,
        reference: reference ? {ready: true, at: refAt} : {ready: false, frames: capture ? capture.stack.length : 0, need: referenceFrames},
        baseline: api.baselineReady() ? {ready: true, at: baseAt} : {ready: false},
        found: lastFound.length,
        latched: lastLatched.map(s => ({x: +s.x.toFixed(1), y: +s.y.toFixed(1), seen: s.seen | 0})),
        rejected: lastReject,
        lastScan: lastScan ? {
          kind: lastScan.kind, at: lastScan.at, scanId: lastScan.scanId, settleMs: lastScan.settleMs, wb: lastScan.wb,
          compare: lastScan.compare !== false,
          gains: lastScan.gains, before: lastScan.before, after: lastScan.after, diff: lastScan.diff,
          blobs: lastScan.blobs, rejected: lastScan.rejected
        } : null
      };
    }
  };
  return api;
}
