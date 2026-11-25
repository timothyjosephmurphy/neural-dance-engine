// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Desktop viewer for a Neural Dance debug room.
// The studio room is https://tjm.art/neural-dance/debug/#k=<key>. The key stays
// in the hash so it is not logged, then this page saves it and the plain
// /neural-dance/debug/ URL works on this device. A Share live debug link still
// uses ?room= and ?key=. Nothing is requested until one of those is present.

import {cleanVersion, readPageVersion, shortBuild} from './live-reload.js';
import {DEBUG_HEARTBEAT_MS, DEBUG_STALL_MS, DEBUG_WS_BUFFER_MAX, STUDIO_ROOM, debugLinkText, finishDebugFrame, offerDebugFrame, readStudioKey, sanitizeDebugPatch, shouldDropDebugSend, studioKeyFromHash, takeDebugFrame, writeStudioKey} from './debug-protocol.js';
import {resolveStageTap} from './src/debug-manual-stickers.js';
import {clientToCamera, createAckTracker, createDancerGesture, dancerNonce, DANCER_TARGET_PX, hitManualDancer, manualMarkers, stageToCamera} from './src/debug-manual-dancers.js';
import {cameraTapToStage, createTrainingLog} from './src/training-taps.js';
import {anchorsFromCorners, cornersFromAnchors, snapAnchor} from './src/align-anchors.js';
import {refineSummary} from './src/align-refine.js';
import {verifySummary} from './src/sticker-verify.js';
import {precisionSummary} from './src/align-precision.js';

// Alignment precision panel: last check's verdict and every point's offset,
// the refine grid size, the stage width used for cm, the saved alignment.
export function precisionPanelText(p) {
  if (!p || typeof p !== 'object') return 'Precision: not run yet';
  const text = p.text || (p.report ? precisionSummary(p.report) : '') || 'Precision: not run yet';
  const bits = [];
  bits.push('Refine grid ' + (p.grid === 4 ? '4×4' : '3×3'));
  bits.push(p.stageWidthCm ? 'stage ' + p.stageWidthCm + ' cm wide' : 'stage width not set (cm hidden)');
  if (p.saved && p.saved.savedAt) bits.push('saved ' + (p.saved.source || '') + ' ' + new Date(p.saved.savedAt).toLocaleTimeString() + (p.saved.maxCm != null ? ' (worst ' + p.saved.maxCm + ' cm)' : ''));
  if (p.crosshairs) bits.push('crosshairs up');
  return text + '\n' + bits.join(' · ');
}

function paintPrecisionPanel(doc, p) {
  const line = doc.querySelector('[data-debug-precision]');
  if (line) line.textContent = precisionPanelText(p);
  const grid = doc.querySelector('[data-debug-grid]');
  if (grid && p) grid.textContent = 'Refine grid: ' + (p.grid === 4 ? '4×4' : '3×3');
  const cm = doc.querySelector('[data-debug-stage-cm]');
  if (cm && p && p.stageWidthCm && !cm.value && doc.activeElement !== cm) cm.value = String(p.stageWidthCm);
}
import {stickerScanSummary} from './src/sticker-flash.js';
import {gapScanSummary} from './src/song-gap-scan.js';
import {pressShowControl} from './src/show-commands.js';
import {syncPersonNote} from './src/person-occlusion.js';
import {formatDancerCount} from './room-lab.js';
import {BAND_SENS_RECOMMENDED} from './src/band-onsets.js';
import {createDebugSimPreview, createPreviewListen} from './src/debug-sim-preview.js';
import {mountSimDetailControls, simDetailTuning} from './src/sim-detail-controls.js';
import {bindControlTaps, flashOneShot, setControlPhase} from './live-show.js';
import {nearestHandle} from './src/painting-frame.js';
import {unpackThumb} from './src/painting-diff.js';

const STAGE_W = 1000;
const STAGE_H = 620;

function pageView(doc) {
  return (doc && doc.defaultView) || globalThis;
}

function debugCredentials(doc) {
  const view = pageView(doc);
  const loc = view.location;
  const params = new URLSearchParams(loc && loc.search || '');
  const room = params.get('room') || '';
  const queryKey = params.get('key') || '';
  if (room && queryKey) return {room, key: queryKey};
  let storage = null;
  try { storage = view.localStorage || null; } catch { storage = null; }
  const fromHash = studioKeyFromHash(loc && loc.hash);
  if (fromHash) {
    writeStudioKey(storage, fromHash);
    if (loc && loc.hash && view.history) {
      try { view.history.replaceState(null, '', loc.pathname + loc.search); } catch { /* the hash stays for this load */ }
    }
    return {room: STUDIO_ROOM, key: fromHash};
  }
  const saved = readStudioKey(storage);
  if (saved) return {room: STUDIO_ROOM, key: saved};
  return null;
}

function rejectSummary(rejected) {
  const counts = rejected && typeof rejected === 'object' ? rejected : {};
  const names = ['area', 'aspect', 'edge', 'compact', 'ui', 'flash', 'offstage'];
  return 'reject ' + names.map(name => name + ' ' + (+counts[name] || 0)).join(' ');
}

function paintMeters(root, audio) {
  const bands = [
    ['kick', audio && audio.kick],
    ['bass', audio && audio.bass],
    ['snare', audio && audio.snare],
    ['hat', audio && audio.hat]
  ];
  for (const [name, value] of bands) {
    const bar = root.querySelector('[data-debug-meter="' + name + '"]');
    if (bar) bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, +value || 0)).toFixed(3) + ')';
  }
  const gate = root.querySelector('[data-debug-gate]');
  if (gate) {
    const closed = !audio || audio.silenceGate !== false;
    gate.textContent = closed ? 'Silence gate closed' : 'Silence gate open';
  }
  const floor = root.querySelector('[data-debug-floor]');
  if (floor) floor.textContent = 'noise floor ' + ((audio && +audio.noiseFloor) || 0).toFixed(2);
  const source = root.querySelector('[data-debug-source]');
  if (source) source.textContent = audio && audio.source ? audio.source : 'silent';
}

function fillTable(table, telemetry) {
  const body = table.querySelector('tbody');
  if (!body) return;
  body.replaceChildren();
  const rows = [];
  for (const blob of (telemetry && telemetry.pink) || []) rows.push(['pink', blob]);
  for (const blob of (telemetry && telemetry.stickers) || []) rows.push(['sticker', blob]);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'No blobs in the latest frame.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const [kind, blob] of rows) {
    const tr = document.createElement('tr');
    const cells = [
      kind,
      blob.grid ? blob.grid.map(n => Math.round(n)).join(', ') : '—',
      blob.stage ? blob.stage.map(n => Math.round(n)).join(', ') : '—',
      blob.area != null ? String(Math.round(blob.area)) : '—',
      blob.rgb ? blob.rgb.join(' ') : '—',
      blob.luminanceRatio != null ? String(blob.luminanceRatio) : '—'
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

const QUAD_SOURCE_LABEL = {
  align: 'Align', 'align-refined': 'Align + refine', 'sticker-check': 'Align + sticker check', border: 'screen border', 'border-lock': 'background border lock',
  manual: 'hand drag', 'manual-lock': 'hand drag', debug: 'debug drag', saved: 'saved (before this build)'
};

// "Quad locked · set by Align 8:01 PM" — so a stale or auto-replaced quad shows.
export function quadSummary(lock, info, now = Date.now()) {
  if (info && (info.manual === true || info.source === 'manual-lock')) return 'corners: manual (locked)';
  const head = lock && lock.locked ? 'Quad locked' : 'Quad unlocked';
  if (!info || !info.source) return head;
  const label = QUAD_SOURCE_LABEL[info.source] || info.source;
  let when = '';
  const at = +info.at || 0;
  if (at > 0) {
    const mins = Math.max(0, Math.round((now - at) / 60000));
    let clock = '';
    try { clock = new Date(at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}); } catch { clock = ''; }
    when = ' ' + (clock ? clock + ' ' : '') + '(' + (mins < 1 ? 'just now' : mins + ' min ago') + ')';
  }
  return head + ' · set by ' + label + when;
}

export function driftSummary(telemetry) {
  const d = telemetry && telemetry.drift;
  const lock = telemetry && telemetry.cameraLock;
  const lockNote = lock ? ' · camera ' + (lock.locked ? 'focus/WB locked' : 'not locked') + (lock.error ? ' (' + lock.error + ')' : '') + (lock.settings && lock.settings.zoom != null ? ' · zoom ' + lock.settings.zoom : '') : '';
  if (!d) return 'Drift: no sticker anchors yet' + lockNote;
  return 'Drift: residual ' + (d.residualPx == null ? '—' : d.residualPx + ' px') + ' · ' + d.matched + '/' + d.anchors + ' stickers · ' + (d.note || '') +
    ' · corrections ' + (d.corrections | 0) + ' (' + (d.totalShiftPx || 0) + ' px total)' + lockNote;
}

// Align capture progress from the phone (hold-until-captured Align, Nov 10).
export function alignProgressLine(telemetry) {
  const p = telemetry && telemetry.align && telemetry.align.progress;
  if (!p || !p.phase) return '';
  const left = Math.max(0, Math.ceil(((p.totalMs | 0) - (p.elapsedMs | 0)) / 1000));
  return 'align ' + p.step + '/' + p.steps + ' ' + String(p.phase).toLowerCase() +
    (p.tries > 1 ? ' try ' + p.attempt + '/' + p.tries : '') +
    ' agree ' + p.agree + '/' + p.need + ' frames ' + p.frames + (p.settled ? ' exposure steady' : ' exposure settling') + ' ~' + left + ' s';
}

// Corners mode draws the stage corners. A homography fit on the inset
// circles can throw the top edge far above the painting; the accepted
// frame is where the warped stage actually lands.
export function projectedStageQuad(telemetry) {
  const quad = telemetry && telemetry.quad;
  if (!quad || quad.length !== 4) return null;
  const copy = (q) => q.map(p => ({x: +p.x, y: +p.y}));
  const frame = telemetry.painting && telemetry.painting.frameQuad;
  if (!frame || frame.length !== 4) return copy(quad);
  const frameTop = Math.min(...frame.map(p => +p.y));
  const projTop = Math.min(+quad[0].y, +quad[1].y);
  if (Number.isFinite(frameTop) && Number.isFinite(projTop) && frameTop - projTop > 0.1) return copy(frame);
  return copy(quad);
}

// Pink handles sit on the align circles (anchors), not the stage corners,
// unless Corners mode is showing the stage corners themselves.
export function overlayHandles(telemetry, draft, options = {}) {
  if (draft && draft.length === 4) return draft;
  const quad = telemetry && telemetry.quad;
  if (!quad || quad.length !== 4) return quad || null;
  if (options && options.corners) return projectedStageQuad(telemetry) || quad.map(p => ({x: +p.x, y: +p.y}));
  return anchorsFromCorners(quad) || quad;
}

// F1–F4 win when the pointer is on a green handle, including when the pink
// projector corners sit on top of them.
export function pickCornerHandle(spot, groups, {frameFirst = false, frameRadius = 26, radius = 28} = {}) {
  if (frameFirst) {
    const frame = (groups || []).find(group => group && group.kind === 'frame');
    const hit = nearestHandle(spot, frame ? [frame] : [], frameRadius);
    if (hit) return hit;
  }
  return nearestHandle(spot, groups, radius);
}

// Hold a released draft until the room acks that exact version (or refuses
// it), or 6 s pass. Older echoes never clear it.
export function draftReleased(telemetry, version, at, now) {
  const info = telemetry && telemetry.quadInfo;
  if (info && version > 0 && (info.version === version || (info.rejected && info.rejected.version === version))) return true;
  return now - at > 6000;
}

// The line under the painting buttons. A click leaves a note here until the
// phone answers with the same cmd.
export function paintingFeedback(statusText, wait) {
  const base = statusText || 'Painting surface: off';
  if (wait && wait.text) return base + ' · ' + wait.text;
  return base;
}

export function paintingStatusText(p) {
  if (!p) return 'Painting surface: off';
  const ref = p.reference || {};
  const parts = [];
  if (p.pending) parts.push('frame found' + (p.pendingInfo && p.pendingInfo.votes ? ' (' + p.pendingInfo.votes + ' thresholds agree)' : '') + ': Accept or Retry');
  else if (p.pendingInfo && p.pendingInfo.ok === false && !p.frameLocked) parts.push('no frame found: ' + p.pendingInfo.reason);
  if (Number.isFinite(+p.confidence)) parts.push('frame ' + Math.round(+p.confidence * 100) + '%');
  if (p.frameLocked) parts.push('Frame: manual (locked)');
  else if (p.fallback) parts.push('using ' + p.fallback);
  if (p.active) {
    parts.push('on, stickers ' + p.stickerColor);
    const when = ref.ready && Number.isFinite(+ref.at) && +ref.at > 0 ? learnedWhen(ref.at) : '';
    parts.push(ref.ready ? ('bare painting learned' + (when ? ' at ' + when : '')) : 'learning bare painting ' + (ref.frames | 0) + '/' + (ref.need | 0) + ' (stickers off, step out)');
    const n = p.latched ? p.latched.length : 0;
    parts.push('stickers: ' + n + ' (latched)');
    if (ref.ready && p.stickerColor !== 'dark') parts.push((p.latched ? p.latched.length : 0) + ' white sticker(s) held');
  } else if (!p.pending && !(p.pendingInfo && p.pendingInfo.ok === false)) parts.push('off');
  return 'Painting surface: ' + parts.join(' · ');
}
export function formatScanMeta(scan) {
  if (!scan) return 'Last scan: none yet';
  if (scan.kind === 'relearn' && scan.compare === false) return 'Re-learn: bare painting learned · no earlier picture to compare';
  const blobs = Array.isArray(scan.blobs) ? scan.blobs : [];
  const ok = blobs.filter(b => b && b.reason === 'accept').length;
  const rej = scan.rejected || {};
  const rejN = ['outside', 'size', 'shape', 'hollow', 'highlight', 'soft-lighting'].reduce((sum, key) => sum + (+rej[key] || 0), 0);
  const settle = Number.isFinite(+scan.settleMs) ? scan.settleMs + ' ms' : 'n/a';
  const wb = scan.wb && scan.wb.locked ? ('locked ' + (scan.wb.mode || 'manual')) : 'unlocked';
  const gains = Array.isArray(scan.gains) ? scan.gains.map(n => (+n).toFixed(2)).join(', ') : 'n/a';
  const kind = scan.kind === 'relearn' ? 'Re-learn' : 'Sticker scan';
  return kind + ': ' + ok + ' accepted, ' + rejN + ' rejected · settle ' + settle + ' · WB ' + wb + ' · gains ' + gains;
}
function scanNum(v) {
  return Number.isFinite(+v) ? (+v).toFixed(2) : '–';
}
export function formatScanBlob(blob) {
  if (!blob) return '';
  return (blob.reason || '?')
    + ' uv ' + (+blob.u).toFixed(2) + ',' + (+blob.v).toFixed(2)
    + ' xy ' + Math.round(+blob.x) + ',' + Math.round(+blob.y)
    + ' area ' + (blob.area | 0)
    + ' dL ' + Math.round(+blob.peakL)
    + ' dC ' + Math.round(+blob.peakC)
    + ' crisp ' + Math.round(+blob.crisp)
    + ' iou ' + scanNum(blob.templateIoU)
    + ' solid ' + scanNum(blob.solidity)
    + ' circ ' + scanNum(blob.circularity)
    + ' hole ' + scanNum(blob.holeFrac)
    + ' aspect ' + scanNum(blob.aspect);
}
export function scanStillSrc(room, key, which, scanId) {
  if (!room || !key || (which !== 'before' && which !== 'after' && which !== 'diff')) return '';
  let url = '/api/neural-dance/debug/last-scan/' + which + '.jpg?room=' + encodeURIComponent(room) + '&key=' + encodeURIComponent(key);
  if (scanId != null && scanId !== '') url += '&scan=' + encodeURIComponent(scanId);
  return url;
}
function drawThumb(canvas, packed, onError, onLoad) {
  if (!canvas || typeof packed !== 'string' || !packed) return false;
  if (packed.startsWith('data:image/') || packed.startsWith('http') || packed.startsWith('/api/')) {
    const ViewImage = typeof Image !== 'undefined' ? Image : null;
    if (!ViewImage || typeof canvas.getContext !== 'function') return false;
    const pic = new ViewImage();
    pic.onload = () => {
      const w0 = pic.naturalWidth || pic.width;
      const h0 = pic.naturalHeight || pic.height;
      if (!(w0 > 0) || !(h0 > 0)) {
        if (typeof onError === 'function') onError();
        return;
      }
      canvas.width = w0;
      canvas.height = h0;
      const ctx = canvas.getContext('2d');
      if (ctx && typeof ctx.drawImage === 'function') ctx.drawImage(pic, 0, 0, w0, h0);
      if (typeof onLoad === 'function') onLoad();
    };
    if (typeof onError === 'function') pic.onerror = () => onError();
    pic.src = packed;
    return true;
  }
  const img = unpackThumb(packed);
  if (!img || !canvas || typeof canvas.getContext !== 'function') return;
  canvas.width = img.w;
  canvas.height = img.h;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') return;
  const image = ctx.createImageData(img.w, img.h);
  for (let i = 0, p = 0; i < img.rgb.length; i += 3, p += 4) {
    image.data[p] = img.rgb[i];
    image.data[p + 1] = img.rgb[i + 1];
    image.data[p + 2] = img.rgb[i + 2];
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  if (typeof onLoad === 'function') onLoad();
  return true;
}
// Keeps the previous stills when a later frame has no lastScan (live stickers
// clearing must not wipe the diagnostic). A new scan loads the warp-resolution
// JPEGs over HTTP. Inline data URLs still draw when that is all the frame has.
export function paintLastScan(doc, telemetry, view) {
  const scan = telemetry && telemetry.painting && telemetry.painting.lastScan;
  if (!scan || !doc || typeof doc.querySelector !== 'function') return false;
  const meta = doc.querySelector('[data-debug-still-meta]');
  const missingKey = !(view && view.room && view.key);
  if (meta) meta.textContent = formatScanMeta(scan) + (missingKey ? ' · stills unavailable: view key missing' : '');
  const list = doc.querySelector('[data-debug-still-blobs]');
  if (list) list.textContent = (scan.blobs || []).map(formatScanBlob).filter(Boolean).join('\n');
  const flags = scan.images && typeof scan.images === 'object' ? scan.images : null;
  const creds = view && view.room && view.key ? view : null;
  const id = scan.scanId != null ? scan.scanId : scan.at;
  if (view && String(view.scanStillFor) !== String(id)) {
    view.scanStillFor = id;
    view.scanStillTry = 0;
    view.lastScanPainted = '';
    view.scanStillLoaded = '';
    view.scanStillRequested = '';
  }
  const attempt = view && view.scanStillTry ? view.scanStillTry : 0;
  const flagKey = flags ? ['before', 'after', 'diff'].map(which => flags[which] ? '1' : '0').join('') : '';
  const http = (which) => {
    if (!creds || !flags || !flags[which]) return '';
    const url = scanStillSrc(creds.room, creds.key, which, id);
    return attempt ? url + '&try=' + attempt : url;
  };
  const uploading = !!(creds && flags && !flagKey.includes('1') && scan.compare !== false);
  const stamp = creds && flagKey.includes('1') ? String(id || '') + ':' + attempt + ':' + flagKey : '';
  const loaded = !!(view && stamp && view.scanStillLoaded === stamp);
  if (meta) {
    let text = formatScanMeta(scan) + (missingKey ? ' · stills unavailable: view key missing' : '');
    if (!missingKey && (uploading || (stamp && !loaded))) text += ' · stills loading';
    meta.textContent = text;
  }
  // A packet that arrives before the JPEGs are posted must not count as
  // painted: the next packet, once images flip true, has to load them.
  if (stamp && !loaded && !(view && view.scanStillRequested === stamp)) {
    const retry = () => {
      if (!view) return;
      view.scanStillTry = attempt + 1;
      view.lastScanPainted = '';
      view.scanStillLoaded = '';
      view.scanStillRequested = '';
    };
    let pending = 0;
    let started = 0;
    const finish = () => {
      pending--;
      if (pending <= 0 && view && view.scanStillRequested === stamp) {
        view.scanStillLoaded = stamp;
        view.lastScanPainted = stamp;
        if (meta) meta.textContent = formatScanMeta(scan) + (missingKey ? ' · stills unavailable: view key missing' : '');
      }
    };
    const slots = [
      ['before', doc.querySelector('[data-debug-still-before]')],
      ['after', doc.querySelector('[data-debug-still-after]')],
      ['diff', doc.querySelector('[data-debug-still-diff]')]
    ];
    for (const [which, canvas] of slots) {
      const src = http(which) || scan[which] || '';
      if (!src) continue;
      const remote = !!http(which);
      if (remote) pending++;
      const began = drawThumb(canvas, src, remote ? retry : null, remote ? finish : null);
      if (began) started++;
      else if (remote) pending--;
    }
    if (view) view.scanStillRequested = started ? stamp : '';
    if (view && pending <= 0 && started) {
      view.scanStillLoaded = stamp;
      view.lastScanPainted = stamp;
      if (meta && !uploading) meta.textContent = formatScanMeta(scan) + (missingKey ? ' · stills unavailable: view key missing' : '');
    }
  }
  return true;
}
function learnedWhen(at) {
  try { return new Date(+at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}); }
  catch { return ''; }
}
function paintPaintingStatus(doc, telemetry, wait, view) {
  const p = telemetry && telemetry.painting;
  const note = doc.querySelector('[data-debug-painting-status]');
  if (note) note.textContent = paintingFeedback(paintingStatusText(p), wait);
  const visit = doc.querySelector('[data-debug-visit]');
  if (visit) {
    const label = (p && p.visit && p.visit.label) || 'Clear';
    const cov = p && p.visit && Number.isFinite(+p.visit.coverage) ? Math.round(+p.visit.coverage * 100) : null;
    visit.textContent = 'Stickers: ' + label + (cov == null ? '' : ' · person ' + cov + '%');
  }
  const person = doc.querySelector('[data-debug-person]');
  if (person) {
    const occ = telemetry && telemetry.occlusion;
    person.textContent = occ && occ.paused && occ.note ? 'Person: paused · ' + occ.note : (occ && occ.settling ? 'Person: resuming' : 'Person: clear');
  }
  doc.querySelectorAll('[data-debug-sticker-color]').forEach(b => b.setAttribute('aria-pressed', p && p.active && p.stickerColor === b.dataset.debugStickerColor ? 'true' : 'false'));
  paintLastScan(doc, telemetry, view);
}
function drawOverlay(ctx, telemetry, width, height, draft, options = {}) {
  const painting = telemetry && telemetry.painting;
  for (const [quadP, color, dash] of [[painting && painting.pending, '#4fe3ff', [8, 6]], [painting && painting.frameQuad, '#9cff8a', []]]) {
    if (!Array.isArray(quadP) || quadP.length !== 4) continue;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath();
    quadP.forEach((c, i) => { const x = c.x * width, y = c.y * height; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '700 13px sans-serif';
    const label = color === '#9cff8a' ? 'Frame' : 'Frame?';
    const c0 = quadP[0];
    ctx.fillText(label, c0.x * width + 6, c0.y * height + 14);
    ctx.restore();
  }
  const handleQuad = options.frameDraft && options.frameDraft.length === 4
    ? options.frameDraft
    : (painting && (painting.frameQuad || painting.pending));
  if (handleQuad && handleQuad.length === 4) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 13px sans-serif';
    handleQuad.forEach((corner, index) => {
      const x = corner.x * width, y = corner.y * height;
      ctx.beginPath();
      ctx.fillStyle = '#07140c';
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#9cff8a';
      ctx.stroke();
      ctx.fillStyle = '#9cff8a';
      ctx.fillText('F' + (index + 1), x, y);
    });
    ctx.restore();
  }
  const quad = overlayHandles(telemetry, draft, options);
  if (quad && quad.length) {
    ctx.strokeStyle = '#ff7ad9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    quad.forEach((corner, index) => {
      const x = corner.x * width;
      const y = corner.y * height;
      if (index) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    if (quad.length === 4) ctx.closePath();
    ctx.stroke();
    if (quad.length === 4) {
      ctx.fillStyle = '#ff7ad9';
      ctx.font = '700 13px sans-serif';
      ctx.fillText('Projector', quad[0].x * width + 6, quad[0].y * height - 8);
    }
    ctx.lineWidth = 4;
    ctx.font = '700 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    quad.forEach((corner, index) => {
      const x = corner.x * width;
      const y = corner.y * height;
      ctx.fillStyle = '#07140c';
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff7ad9';
      ctx.fillText(String(index + 1), x, y);
    });
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  const marks = telemetry && telemetry.align && telemetry.align.marks;
  if (marks) {
    marks.forEach((mark, index) => {
      if (!mark || !Number.isFinite(+mark.x)) return;
      ctx.strokeStyle = '#3dff9a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mark.x * width, mark.y * height, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f4f6fb';
      ctx.font = '700 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(index + 1), mark.x * width, mark.y * height + 4);
    });
    ctx.textAlign = 'start';
  }
  // Dancers on the camera feed: manual = filled 44 px target (CSS), auto =
  // thin ring; drag preview and not-yet-acked placements as dashed rings.
  const dz = options.dancers;
  if (dz && telemetry && Array.isArray(telemetry.quad) && telemetry.quad.length === 4) {
    const r = Math.max(8, (DANCER_TARGET_PX / 2) * (dz.scale || 1));
    for (const m of (telemetry.markers || [])) {
      if (!m || !Number.isFinite(+m.x)) continue;
      if (dz.drag && m.manual && (m.id | 0) === dz.drag.id) continue;
      const c = stageToCamera(m.x, m.y, telemetry.quad);
      if (!c) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x * width, c.y * height, m.manual ? r : r * 0.55, 0, Math.PI * 2);
      if (m.manual) { ctx.fillStyle = 'rgba(255, 122, 217, 0.28)'; ctx.fill(); }
      ctx.lineWidth = (m.manual && (m.id | 0) === dz.selectedId) ? 4 : 2;
      ctx.strokeStyle = m.manual ? ((m.id | 0) === dz.selectedId ? '#ffffff' : '#ff7ad9') : '#ffe14a';
      ctx.stroke();
      if (m.manual) { ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(r * 0.6) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(m.id | 0).slice(-3), c.x * width, c.y * height); }
      ctx.restore();
    }
    const ghost = (c, color) => {
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x * width, c.y * height, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    };
    if (dz.drag && dz.drag.camera) ghost(dz.drag.camera, '#ffffff');
    for (const p of dz.pending || []) {
      if (p.action === 'remove-manual-sticker' || !Number.isFinite(+p.x)) continue;
      const c = stageToCamera(p.x, p.y, telemetry.quad);
      if (c) ghost(c, '#ff7ad9');
    }
  }
  const mark = (blob, color) => {
    if (!blob.grid) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(blob.grid[0], blob.grid[1], 10, 0, Math.PI * 2);
    ctx.stroke();
  };
  for (const blob of (telemetry && telemetry.pink) || []) mark(blob, '#ffd1ec');
  for (const blob of (telemetry && telemetry.stickers) || []) mark(blob, '#7fe8b3');
  const candidates = telemetry && telemetry.scan && telemetry.scan.candidates;
  if (candidates) {
    candidates.forEach((blob, index) => {
      if (!blob || !Number.isFinite(+blob.x)) return;
      ctx.strokeStyle = '#ffe14a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(blob.x * width, blob.y * height, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffe14a';
      ctx.font = '700 12px sans-serif';
      ctx.fillText(String(index + 1), blob.x * width + 8, blob.y * height - 8);
    });
  }
}

export function stageMarkPlan(telemetry) {
  const raw = [];
  const latched = [];
  for (const blob of (telemetry && telemetry.pink) || []) if (blob.stage) raw.push({at: blob.stage, kind: 'pink'});
  for (const blob of (telemetry && telemetry.stickers) || []) if (blob.stage) raw.push({at: blob.stage, kind: 'sticker'});
  for (const marker of (telemetry && telemetry.markers) || []) {
    latched.push({at: [marker.x, marker.y], kind: marker.kind === 'sticker' ? 'sticker' : 'pink'});
  }
  return {raw, latched};
}

export function paintProjectedStage(ctx, telemetry, width, height) {
  const plan = stageMarkPlan(telemetry);
  const scaleX = width / STAGE_W;
  const scaleY = height / STAGE_H;
  for (const mark of plan.raw) {
    ctx.beginPath();
    ctx.strokeStyle = mark.kind === 'sticker' ? '#7fe8b3' : '#ffd1ec';
    ctx.lineWidth = 2;
    ctx.arc(mark.at[0] * scaleX, mark.at[1] * scaleY, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const mark of plan.latched) {
    const color = mark.kind === 'sticker' ? '#7fe8b3' : '#ffe7b0';
    const x = mark.at[0] * scaleX;
    const y = mark.at[1] * scaleY;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawStage(ctx, image, telemetry) {
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = '#080910';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (image) ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height);
  paintProjectedStage(ctx, telemetry, ctx.canvas.width, ctx.canvas.height);
}

function tuningPatch(doc) {
  const mode = doc.querySelector('[data-debug-mode] [aria-pressed="true"]');
  const value = (name) => {
    const input = doc.querySelector('[data-debug-control="' + name + '"]');
    return input ? +input.value : undefined;
  };
  return {
    markerMode: mode && mode.dataset.mode,
    noteSensitivity: value('note'),
    stickerSensitivity: value('sticker'),
    hueTolerance: value('hue'),
    minBlobSize: value('size'),
    quietThreshold: value('quiet'),
    gravity: value('gravity'),
    wander: value('wander'),
    threshold: value('threshold'),
    peak: value('peak'),
    type: value('type'),
    kickSensitivity: value('sens-0'),
    bassSensitivity: value('sens-1'),
    snareSensitivity: value('sens-2'),
    hatSensitivity: value('sens-3'),
    personSensitivity: value('person'),
    personPause: (() => {
      const button = doc.querySelector('[data-debug-person-pause]');
      if (!button) return undefined;
      return button.getAttribute('aria-pressed') === 'true';
    })(),
    gapScan: (() => {
      const button = doc.querySelector('[data-debug-gap-scan]');
      if (!button) return undefined;
      return button.getAttribute('aria-pressed') === 'true';
    })(),
    scanInterval: value('scan-interval'),
    scanDuration: value('scan-duration'),
    bloomIntensity: value('bloom'),
    bloomAura: value('bloom-aura'),
    hueSpread: value('hue-spread'),
    hipEight: value('hip-eight'),
    shoulderEight: value('shoulder-eight'),
    hipTwist: value('hip-twist'),
    shoulderTwist: value('shoulder-twist'),
    maxBodyTurn: value('max-body-turn'),
    turnFreq: value('turn-freq'),
    eightDepth: value('eight-depth'),
    eightVert: value('eight-vert'),
    armPadSense: value('arm-pad-sense'),
    bloomEnabled: (() => {
      const button = doc.querySelector('[data-debug-bloom]');
      if (!button) return undefined;
      return button.getAttribute('aria-pressed') !== 'false';
    })(),
    rippleIntensity: value('ripple-intensity'),
    perspectiveStrength: value('floor-perspective'),
    bodyMotionSlowdown: value('body-slowdown'),
    insetsEnabled: (() => {
      const button = doc.querySelector('[data-debug-insets]');
      if (!button) return undefined;
      return button.getAttribute('aria-pressed') !== 'false';
    })(),
    rippleEnabled: (() => {
      const button = doc.querySelector('[data-debug-ripple]');
      if (!button) return undefined;
      return button.getAttribute('aria-pressed') !== 'false';
    })(),
    scanMode: (() => {
      const button = doc.querySelector('[data-debug-scan]');
      if (!button) return undefined;
      const mode = button.dataset && button.dataset.scanMode;
      if (mode === 'white' || mode === 'gray' || mode === 'off' || mode === 'black') return mode;
      return button.getAttribute('aria-pressed') === 'false' ? 'off' : 'black';
    })()
  };
}

// Reset band sens (TJ 8:12 PM): set the four sliders to the recommended
// values and send them as one patch so the live phone follows.
export function bandSensResetPatch(doc) {
  const patch = {};
  BAND_SENS_RECOMMENDED.forEach((value, band) => {
    const input = doc && doc.querySelector ? doc.querySelector('[data-debug-control="sens-' + band + '"]') : null;
    if (input) input.value = String(value);
    patch[CONTROL_FIELDS['sens-' + band]] = value;
  });
  return patch;
}
// One slider → only its own field, so an unrelated change never resends a
// stale value (e.g. ripple intensity 0.45 over the phone's 0.85).
export const CONTROL_FIELDS = Object.freeze({
  note: 'noteSensitivity', sticker: 'stickerSensitivity', hue: 'hueTolerance', size: 'minBlobSize',
  quiet: 'quietThreshold', gravity: 'gravity', wander: 'wander', threshold: 'threshold', peak: 'peak', type: 'type',
  'sens-0': 'kickSensitivity', 'sens-1': 'bassSensitivity', 'sens-2': 'snareSensitivity', 'sens-3': 'hatSensitivity',
  person: 'personSensitivity', 'scan-interval': 'scanInterval', 'scan-duration': 'scanDuration',
  bloom: 'bloomIntensity', 'bloom-aura': 'bloomAura', 'hue-spread': 'hueSpread', 'hip-eight': 'hipEight', 'shoulder-eight': 'shoulderEight', 'hip-twist': 'hipTwist', 'shoulder-twist': 'shoulderTwist', 'max-body-turn': 'maxBodyTurn', 'turn-freq': 'turnFreq', 'eight-depth': 'eightDepth', 'eight-vert': 'eightVert', 'arm-pad-sense': 'armPadSense', 'ripple-intensity': 'rippleIntensity', 'floor-perspective': 'perspectiveStrength', 'body-slowdown': 'bodyMotionSlowdown'
});
// Presets replace the row of body, pulse, and look sliders. Each value is
// still a real control, so Advanced can nudge one field afterward.
export const DEBUG_PRESETS = Object.freeze({
  look: {
    soft: {'hue-spread': 0.05, bloom: 0.10, 'bloom-aura': 14, 'ripple-intensity': 0.10},
    show: {'hue-spread': 0.10, bloom: 0.18, 'bloom-aura': 22, 'ripple-intensity': 0.20},
    vivid: {'hue-spread': 0.70, bloom: 1.00, 'bloom-aura': 40, 'ripple-intensity': 0.65}
  },
  motion: {
    calm: {'hip-eight': 0.30, 'shoulder-eight': 0.25, 'hip-twist': 0.30, 'shoulder-twist': 0.25, 'max-body-turn': 35, 'turn-freq': 0.25, 'eight-depth': 0.35, 'eight-vert': 0.30, 'body-slowdown': 6, 'arm-pad-sense': 0.50},
    show: {'hip-eight': 0.80, 'shoulder-eight': 0.70, 'hip-twist': 0.80, 'shoulder-twist': 0.75, 'max-body-turn': 90, 'turn-freq': 0.70, 'eight-depth': 0.85, 'eight-vert': 0.80, 'body-slowdown': 4, 'arm-pad-sense': 1.00},
    loose: {'hip-eight': 1.20, 'shoulder-eight': 1.10, 'hip-twist': 1.20, 'shoulder-twist': 1.10, 'max-body-turn': 90, 'turn-freq': 1.15, 'eight-depth': 1.20, 'eight-vert': 1.15, 'body-slowdown': 2.5, 'arm-pad-sense': 1.50}
  },
  pulse: {
    tight: {gravity: 4.5, wander: 0.05, threshold: 1.70, peak: 2.5},
    show: {gravity: 2.5, wander: 0.25, threshold: 1.40, peak: 5},
    wild: {gravity: 1.0, wander: 0.60, threshold: 1.10, peak: 7.5}
  }
});

export function presetPatch(doc, map) {
  const patch = {};
  for (const [name, value] of Object.entries(map || {})) {
    const input = doc && doc.querySelector ? doc.querySelector('[data-debug-control="' + name + '"]') : null;
    if (input) input.value = String(value);
    const key = CONTROL_FIELDS[name];
    if (key) patch[key] = value;
  }
  return patch;
}

function syncFlag(doc, el, on, onText, offText) {
  if (!el || doc.activeElement === el) return;
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.textContent = on ? onText : offText;
}

export function controlPatch(doc, name) {
  const key = CONTROL_FIELDS[name];
  if (!key) return null;
  const input = doc.querySelector('[data-debug-control="' + name + '"]');
  if (!input) return null;
  const value = +input.value;
  if (!Number.isFinite(value)) return null;
  return {[key]: value};
}
// Continuous scan is off by default on the live show (blank flashes only on
// Scan stickers), so Scan every / Scan flash are greyed out while it is off.
export function syncScanToggle(doc, mode) {
  const on = mode === 'black' || mode === 'white' || mode === 'gray';
  const note = doc.querySelector('[data-continuous-note]');
  if (note) note.textContent = on ? 'Continuous scan: on (' + mode + ' flash)' : 'Continuous scan: off \u2014 Scan every / Scan flash apply only when it is on; use Scan stickers';
  for (const name of ['scan-interval', 'scan-duration']) {
    const input = doc.querySelector('[data-debug-control="' + name + '"]');
    if (!input) continue;
    input.disabled = !on;
    const label = input.closest ? input.closest('label') : null;
    if (label && label.classList) label.classList.toggle('is-off', !on);
  }
  return on;
}

function assignControl(doc, name, value) {
  const input = doc.querySelector('[data-debug-control="' + name + '"]');
  if (!input || doc.activeElement === input || value == null || !Number.isFinite(+value)) return;
  input.value = String(value);
}


function syncBuildStamp(doc, telemetry) {
  const localEl = doc.querySelector('[data-debug-build-local]');
  const phoneEl = doc.querySelector('[data-debug-build-phone]');
  const warn = doc.querySelector('[data-debug-build-warn]');
  const local = readPageVersion(doc);
  const phone = cleanVersion(telemetry && telemetry.build);
  if (localEl) localEl.textContent = shortBuild(local) || '—';
  if (phoneEl) phoneEl.textContent = shortBuild(phone) || (telemetry ? 'missing' : '—');
  if (warn) {
    const mismatch = !!(local && phone && local !== phone);
    warn.hidden = !mismatch;
  }
}

// Listen detector readout (sample rate, FFT, tiers, BPM, recent hits).
const LISTEN_NAMES = ['Kick', 'Bass', 'Mid', 'Hat'];
// Global tempo lock state (TJ 7:44 PM): locked/held, time to lock, 10 s spread.
export function tempoNote(t) {
  if (!t || typeof t !== 'object') return '';
  if (!t.locked) return 'tempo searching' + (t.estimate ? ' (~' + Math.round(t.estimate) + ')' : '');
  return (t.held ? 'held' : 'locked') + (t.timeToLockMs ? ' in ' + (t.timeToLockMs / 1000).toFixed(1) + ' s' : '') +
    ' · \u03c310s ' + (+t.std10 || 0).toFixed(1) + (t.candidate ? ' · cand ' + t.candidate : '');
}
export function listenSummary(listen) {
  if (!listen || typeof listen !== 'object') return {head: 'Listen: no data', bands: []};
  const head = [
    'Listen ' + (listen.detector || '—'),
    listen.sampleRate ? (listen.sampleRate / 1000).toFixed(1) + ' kHz' : 'rate —',
    'FFT ' + (listen.fftSize || '—'),
    listen.micTopHz ? 'mic top ' + (listen.micTopHz / 1000).toFixed(1) + ' kHz' : '',
    listen.bandsHz && listen.bandsHz[3] ? 'hat ' + Math.round(listen.bandsHz[3][0]) + '–' + Math.round(listen.bandsHz[3][1]) + ' Hz' : '',
    listen.bpm ? listen.bpm + ' BPM' : 'BPM —',
    tempoNote(listen.tempo)
  ].filter(Boolean).join(' · ');
  const bands = [0, 1, 2, 3].map(b => {
    const tier = listen.tiers && listen.tiers[b] ? listen.tiers[b] : {};
    const snap = Array.isArray(listen.bands) && listen.bands[b] ? listen.bands[b] : {};
    const hits = Array.isArray(listen.hits) && Array.isArray(listen.hits[b]) ? listen.hits[b] : [];
    const cp = Array.isArray(listen.coupled) && listen.coupled[b] ? listen.coupled[b] : {};
    const now = +listen.now || (hits.length ? hits[hits.length - 1] : 0);
    const ago = hits.slice(-16).map(t => ((now - t) / 1000).toFixed(1)).reverse();
    return LISTEN_NAMES[b] + ' · ' + (tier.tier || '—') + ' · ' + (tier.bpm ? tier.bpm + ' BPM' : (snap.period ? Math.round(60000 / snap.period) + ' BPM?' : '— BPM')) +
      ((cp.locked != null ? cp.locked : snap.locked) ? ' · locked' : '') + (cp.ratio ? ' · \u00d7' + cp.ratio : '') +
      (cp.conf != null ? ' · conf ' + cp.conf : snap.conf != null ? ' · conf ' + snap.conf : '') +
      ' · beats ' + ((listen.beats && listen.beats[b]) || 0) + (ago.length ? ' · hits −' + ago.join('/') + ' s' : '');
  });
  return {head, bands};
}

// 10 Hz audio graph: last 30 s of band levels + gate + hit ticks.
export const AUDIO_GRAPH_SAMPLES = 300;
export function pushAudioSamples(ring, samples) {
  for (const s of samples || []) {
    if (!s || !Array.isArray(s.lv)) continue;
    ring.push({t: +s.t || 0, lv: s.lv.slice(0, 4).map(v => +v || 0), gate: !!s.gate, floor: +s.floor || 0, hits: s.hits || null});
  }
  if (ring.length > AUDIO_GRAPH_SAMPLES) ring.splice(0, ring.length - AUDIO_GRAPH_SAMPLES);
  return ring;
}
const GRAPH_COLORS = ['#ff6b5e', '#ffd166', '#7fe8b3', '#81b7fc'];
export function paintAudioGraph(canvas, ring) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return false;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, w, h);
  if (!ring.length) return true;
  const dx = w / AUDIO_GRAPH_SAMPLES;
  const x0 = w - ring.length * dx;
  ctx.fillStyle = 'rgba(127,232,179,0.08)';
  ring.forEach((s, i) => { if (s.gate) ctx.fillRect(x0 + i * dx, 0, dx + 0.5, h); });
  const tEnd = ring[ring.length - 1].t;
  const tStart = tEnd - ring.length * 100;
  for (let b = 0; b < 4; b++) {
    ctx.strokeStyle = GRAPH_COLORS[b];
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ring.forEach((s, i) => {
      const y = h - 4 - Math.min(1.4, s.lv[b]) / 1.4 * (h - 8);
      if (i) ctx.lineTo(x0 + i * dx, y); else ctx.moveTo(x0, y);
    });
    ctx.stroke();
    // Hit ticks along the top, one row per band.
    const last = ring[ring.length - 1];
    const hits = last && last.hits && Array.isArray(last.hits[b]) ? last.hits[b] : [];
    ctx.fillStyle = GRAPH_COLORS[b];
    for (const t of hits) {
      if (t < tStart) continue;
      const x = w - (tEnd - t) / 100 * dx;
      ctx.fillRect(x - 1, 2 + b * 4, 2, 3);
    }
  }
  return true;
}

export function syncTuning(doc, telemetry) {
  if (!doc || !telemetry || !telemetry.controls) return;
  const controls = telemetry.controls;
  assignControl(doc, 'note', controls.noteSensitivity);
  assignControl(doc, 'sticker', controls.stickerSensitivity);
  assignControl(doc, 'hue', controls.hueTolerance);
  assignControl(doc, 'size', controls.minBlobSize);
  assignControl(doc, 'quiet', controls.quietThreshold);
  assignControl(doc, 'gravity', controls.gravity);
  assignControl(doc, 'wander', controls.wander);
  assignControl(doc, 'threshold', controls.threshold);
  assignControl(doc, 'peak', controls.peak);
  assignControl(doc, 'type', controls.type);
  const sens = Array.isArray(controls.sens) ? controls.sens : [];
  for (let i = 0; i < 4; i++) assignControl(doc, 'sens-' + i, sens[i]);
  assignControl(doc, 'person', controls.personSensitivity);
  assignControl(doc, 'scan-interval', controls.scanInterval);
  assignControl(doc, 'scan-duration', controls.scanDuration);
  assignControl(doc, 'bloom', controls.bloomIntensity);
  assignControl(doc, 'bloom-aura', controls.bloomAura);
  assignControl(doc, 'hue-spread', controls.hueSpread);
  assignControl(doc, 'hip-eight', controls.hipEight);
  assignControl(doc, 'shoulder-eight', controls.shoulderEight);
  assignControl(doc, 'hip-twist', controls.hipTwist);
  assignControl(doc, 'shoulder-twist', controls.shoulderTwist);
  assignControl(doc, 'max-body-turn', controls.maxBodyTurn);
  assignControl(doc, 'turn-freq', controls.turnFreq);
  assignControl(doc, 'eight-depth', controls.eightDepth);
  assignControl(doc, 'eight-vert', controls.eightVert);
  assignControl(doc, 'arm-pad-sense', controls.armPadSense);
  assignControl(doc, 'body-slowdown', controls.bodyMotionSlowdown);
  assignControl(doc, 'ripple-intensity', controls.rippleIntensity);
  assignControl(doc, 'floor-perspective', controls.perspectiveStrength);
  const rippleButton = doc.querySelector('[data-debug-ripple]');
  if (rippleButton && (controls.rippleEnabled === true || controls.rippleEnabled === false) && doc.activeElement !== rippleButton) {
    rippleButton.setAttribute('aria-pressed', controls.rippleEnabled ? 'true' : 'false');
    rippleButton.textContent = controls.rippleEnabled ? 'Ripple: on' : 'Ripple: off';
  }
  const insetsButton = doc.querySelector('[data-debug-insets]');
  if (insetsButton && (controls.insetsEnabled === true || controls.insetsEnabled === false) && doc.activeElement !== insetsButton) {
    insetsButton.setAttribute('aria-pressed', controls.insetsEnabled ? 'true' : 'false');
    insetsButton.textContent = controls.insetsEnabled ? 'Insets: on' : 'Insets: off';
  }
  if (typeof controls.scanMode === 'string') syncScanToggle(doc, controls.scanMode);
  if (doc.body && doc.body.dataset) doc.body.dataset.tuningSynced = '1';
  const bloomButton = doc.querySelector('[data-debug-bloom]');
  if (bloomButton && (controls.bloomEnabled === true || controls.bloomEnabled === false) && doc.activeElement !== bloomButton) {
    bloomButton.setAttribute('aria-pressed', controls.bloomEnabled ? 'true' : 'false');
    bloomButton.textContent = controls.bloomEnabled ? 'Bloom: on' : 'Bloom: off';
  }
  const pause = doc.querySelector('[data-debug-person-pause]');
  if (pause && (controls.personPause === true || controls.personPause === false) && doc.activeElement !== pause) {
    pause.setAttribute('aria-pressed', controls.personPause ? 'true' : 'false');
    pause.textContent = controls.personPause ? 'Person pause: on' : 'Person pause: off';
  }
  const gapBtn = doc.querySelector('[data-debug-gap-scan]');
  if (gapBtn && (controls.gapScan === true || controls.gapScan === false) && doc.activeElement !== gapBtn) {
    gapBtn.setAttribute('aria-pressed', controls.gapScan ? 'true' : 'false');
    gapBtn.textContent = controls.gapScan ? 'Between-songs scan: on' : 'Between-songs scan: off';
  }
  const mode = controls.markerMode;
  const group = doc.querySelector('[data-debug-mode]');
  if (group && doc.activeElement !== group && !(group.contains && group.contains(doc.activeElement))) {
    group.querySelectorAll('[data-mode]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
    });
  }
}

export function renderDebugFrame(view) {
    const detectW = view.telemetry && view.telemetry.detectWidth || (view.cameraImage && view.cameraImage.naturalWidth) || 480;
    const detectH = view.telemetry && view.telemetry.detectHeight || (view.cameraImage && view.cameraImage.naturalHeight) || 253;
    view.camera.width = detectW;
    view.camera.height = detectH;
    view.cctx.fillStyle = '#05060a';
    view.cctx.fillRect(0, 0, detectW, detectH);
    if (view.cameraImage) view.cctx.drawImage(view.cameraImage, 0, 0, detectW, detectH);
    if (view.cornerDraft && view.cornerDrag < 0 && view.draftBase != null && draftReleased(view.telemetry, view.draftVersion, view.draftAt, Date.now())) {
      const info = view.telemetry && view.telemetry.quadInfo;
      if (info && info.rejected && info.rejected.version === view.draftVersion) {
        const note = view.doc.querySelector('[data-debug-sent]');
        if (note) note.textContent = 'Corners refused by the phone: ' + info.rejected.reason;
      }
      view.cornerDraft = null;
      view.draftBase = null;
    }
    const crect = view.camera.getBoundingClientRect();
    drawOverlay(view.cctx, view.telemetry, detectW, detectH, view.cornerDraft, {corners: view.cornersMode, frameDraft: view.frameDraft, dancers: {
      scale: crect.width > 0 ? detectW / crect.width : 1,
      drag: view.dragDancer,
      selectedId: view.selected ? view.selected.id : 0,
      pending: view.acks.list()
    }});
    drawStage(view.sctx, view.stageImage, view.telemetry);
    const audio = view.telemetry && view.telemetry.audio;
    paintMeters(view.doc, audio);
    if (audio) view.previewLevels = [+audio.kick || 0, +audio.bass || 0, +audio.snare || 0, +audio.hat || 0];
    fillTable(view.table, view.telemetry);
    const dancersLine = view.doc.querySelector('[data-debug-dancers]');
    if (dancersLine) {
      const stage = view.telemetry && view.telemetry.stage || {};
      const dancers = +stage.dancers || 0;
      const stickers = stage.stickers != null ? +stage.stickers : ((view.telemetry && view.telemetry.markers) || []).length;
      const pulses = +stage.pulses || 0;
      dancersLine.textContent = [
        formatDancerCount(dancers, stickers),
        pulses + ' pulses',
        stage.simDancers ? 'sim dancers on' : 'sim dancers cleared',
        stickers + ' latched',
        view.telemetry && view.telemetry.aligned ? 'aligned' : 'not aligned',
        stage.aligning ? 'aligning' : 'not aligning',
        stage.running ? 'running' : 'paused',
        stage.hidden ? 'controls hidden' : 'controls visible'
      ].join(' · ');
    }
    const poseLine = view.doc.querySelector('[data-debug-pose]');
    if (poseLine) {
      const pose = view.telemetry && view.telemetry.stage && view.telemetry.stage.pose;
      if (!pose || !pose.dancers) poseLine.textContent = 'Pose: no dancers yet';
      else {
        const act = pose.activation || {};
        const lift = pose.armLift || {};
        const st = pose.stance || {};
        const song = pose.song || {};
        const fam = pose.families || {};
        const famText = Object.keys(fam).sort().map(k => k + ' ' + fam[k]).join(', ') || '—';
        poseLine.textContent = [
          'Activation mean ' + (act.mean ?? '—') + ' max ' + (act.max ?? '—') + (act.spread != null ? ' spread ' + act.spread : ''),
          'song ' + (song.energy ?? '—'),
          'full raise ' + (lift.full || 0) + '/' + pose.dancers,
          'tall ' + (pose.tall || 0),
          'stance ' + (st.min ?? '—') + '–' + (st.max ?? '—') + ' (close ' + (st.close || 0) + ', wide ' + (st.wide || 0) + ')',
          'families: ' + famText
        ].join(' · ');
      }
    }
    syncPersonNote(view.doc, (view.telemetry && view.telemetry.occlusion && view.telemetry.occlusion.note) || false);
    const micLine = view.doc.querySelector('[data-debug-mic]');
    if (micLine) {
      const audio = view.telemetry && view.telemetry.audio;
      micLine.textContent = audio && audio.micDetail ? audio.micDetail : (audio && audio.mic === 'listening' ? 'Mic on' : 'Mic off');
    }
    const lagLine = view.doc.querySelector('[data-debug-lag]');
    if (lagLine) {
      const latency = view.telemetry && view.telemetry.latency;
      lagLine.textContent = latency && Number.isFinite(+latency.lagMs)
        ? 'Projector lag ' + Math.round(latency.lagMs) + ' ms · jitter ' + Math.round(+latency.jitterMs || 0) + ' ms'
        : 'Projector lag —';
    }
    const quadLine = view.doc.querySelector('[data-debug-quad]');
    if (quadLine) {
      const lock = view.telemetry && view.telemetry.quadLock;
      quadLine.textContent = quadSummary(lock, view.telemetry && view.telemetry.quadInfo);
    }
    const refineLine = view.doc.querySelector('[data-debug-refine]');
    if (refineLine) refineLine.textContent = refineSummary(view.telemetry && view.telemetry.refine) || 'Align refine: not run yet';
    const verifyLine = view.doc.querySelector('[data-debug-verify]');
    if (verifyLine) verifyLine.textContent = verifySummary(view.telemetry && view.telemetry.verify) || 'Sticker check: not run yet';
    paintPrecisionPanel(view.doc, view.telemetry && view.telemetry.precision);
    const driftLine = view.doc.querySelector('[data-debug-drift]');
    if (driftLine) driftLine.textContent = driftSummary(view.telemetry);
    const okHandLine = view.doc.querySelector('[data-debug-ok-hand]');
    if (okHandLine) {
      const oh = view.telemetry && view.telemetry.okHand;
      if (!oh) okHandLine.textContent = 'OK hand: idle';
      else {
        const skin = Math.round((+oh.skinFraction || 0) * 100);
        const hole = Math.round((+oh.holeFraction || 0) * 100);
        okHandLine.textContent = 'OK hand: ' + (oh.note || oh.phase || 'idle')
          + ' · skin ' + skin + '% · hole ' + hole + '%'
          + (oh.reason ? ' · ' + oh.reason : '');
      }
    }
    const flashLine = view.doc.querySelector('[data-debug-sticker-flash]');
    if (flashLine) flashLine.textContent = stickerScanSummary(view.telemetry && view.telemetry.stickerFlash);
    const gapLine = view.doc.querySelector('[data-debug-gap-scan-status]');
    if (gapLine) {
      const g = view.telemetry && view.telemetry.gapScan;
      const enabled = !(view.telemetry && view.telemetry.controls && view.telemetry.controls.gapScan === false) && !(g && g.enabled === false);
      gapLine.textContent = enabled ? gapScanSummary(g) : gapScanSummary({state: 'off'});
    }
    const rippleLine = view.doc.querySelector('[data-debug-ripple-status]');
    if (rippleLine) {
      const rip = view.telemetry && view.telemetry.stage && view.telemetry.stage.ripple;
      const on = rip ? rip.enabled !== false : true;
      const backend = rip && rip.backend ? rip.backend : '—';
      const inten = rip && Number.isFinite(+rip.intensity) ? (+rip.intensity).toFixed(2) : '—';
      rippleLine.textContent = (on ? 'Ripple: on' : 'Ripple: off') + ' · ' + inten + ' · ' + backend;
    }
    const drawNow = view.telemetry && (view.telemetry.drawMode === 'dots' || view.telemetry.drawMode === 'silhouette' || view.telemetry.drawMode === 'beat' || view.telemetry.drawMode === 'full') ? view.telemetry.drawMode : '';
    if (drawNow) {
      const editing = view.doc.querySelector('[data-debug-draw]') && view.doc.activeElement && view.doc.activeElement.dataset && view.doc.activeElement.dataset.debugDraw;
      if (!editing) view.previewDraw = drawNow;
      view.doc.querySelectorAll('[data-debug-draw]').forEach(button => {
        if (view.doc.activeElement === button) return;
        button.setAttribute('aria-pressed', button.dataset.debugDraw === drawNow ? 'true' : 'false');
      });
    }
    if (view.telemetry && view.telemetry.stage) {
      syncFlag(view.doc, view.doc.querySelector('[data-debug-run]'), !!view.telemetry.stage.running, 'Show: running', 'Show: paused');
      syncFlag(view.doc, view.doc.querySelector('[data-debug-markers]'), !!view.telemetry.stage.markersLive, 'Markers: on', 'Markers: off');
      syncFlag(view.doc, view.doc.querySelector('[data-debug-chrome]'), !!view.telemetry.stage.hidden, 'Phone controls: hidden', 'Phone controls: shown');
    }
    syncTuning(view.doc, view.telemetry);
    syncBuildStamp(view.doc, view.telemetry);
    {
      const info = listenSummary(view.telemetry && view.telemetry.listen);
      const head = view.doc.querySelector('[data-debug-listen-info]');
      if (head) head.textContent = info.head;
      const list = view.doc.querySelector('[data-debug-listen-bands]');
      if (list) list.textContent = info.bands.join('\n');
    }
    if (view.summary) {
      const rgb = view.telemetry && view.telemetry.quadMedianRgb;
      const controls = view.telemetry && view.telemetry.controls || {};
      view.summary.textContent = [
        view.telemetry && view.telemetry.publisherName ? view.telemetry.publisherName : '',
        view.telemetry && view.telemetry.cameraLabel ? view.telemetry.cameraLabel : 'No camera',
        view.telemetry && view.telemetry.facingMode ? view.telemetry.facingMode : 'facing —',
        (view.telemetry && view.telemetry.videoWidth ? view.telemetry.videoWidth : 0) + '×' + (view.telemetry && view.telemetry.videoHeight ? view.telemetry.videoHeight : 0),
        'detect ' + detectW + '×' + detectH,
        'fps ' + ((view.telemetry && +view.telemetry.fps) || 0).toFixed(1),
        view.telemetry && view.telemetry.aligned ? 'aligned' : 'not aligned',
        'quad RGB ' + (rgb ? rgb.join(' ') : '—'),
        'mode ' + (controls.markerMode || '—'),
        'note ' + (controls.noteSensitivity ?? '—'),
        'sticker ' + (controls.stickerSensitivity ?? '—'),
        'hue ' + (controls.hueTolerance ?? '—'),
        'min ' + (controls.minBlobSize ?? '—'),
        'quiet ' + (controls.quietThreshold ?? '—'),
        view.telemetry && view.telemetry.align && view.telemetry.align.reason ? view.telemetry.align.reason : '',
        alignProgressLine(view.telemetry),
        view.telemetry && view.telemetry.scan ? ('scan ' + view.telemetry.scan.scanCount + ' raw ' + view.telemetry.scan.rawCount + ' ' + rejectSummary(view.telemetry.scan.rejected) + (view.telemetry.scan.personPause ? ' person-pause' : '')) : ''
      ].filter(Boolean).join(' · ');
    }
  }

export async function applyDebugMessage(view, message) {
    if (!message || message.type === 'hello') return;
    if (message.type === 'audio') {
      for (const s of message.samples || []) { if (s && s.hits) view.audioHits = s.hits; else if (s && view.audioHits) s.hits = view.audioHits; }
      pushAudioSamples(view.audioRing, message.samples);
      const graph = view.doc.querySelector('[data-debug-audio-graph]');
      if (graph) paintAudioGraph(graph, view.audioRing);
      const rate = view.doc.querySelector('[data-debug-audio-rate]');
      if (rate) rate.textContent = 'Audio feed 10 Hz · ' + view.audioRing.length + ' samples';
      return;
    }
    if (message.telemetry) view.telemetry = message.telemetry;
    view.noteFrame();
    view.refreshPainting();
    try { view.syncDancers(); } catch { /* status only */ }
    if (message.cameraJpeg) view.cameraImage = await view.loadImage(message.cameraJpeg);
    if (message.stageJpeg) view.stageImage = await view.loadImage(message.stageJpeg);
    if (view.frameQ.latest != null) return;
    view.render();
  }

export function connectDebugSocket(view) {
    const loc = pageView(view.doc).location || location;
    const url = new URL('/api/neural-dance/debug/ws', loc.href);
    url.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', view.room);
    url.searchParams.set('role', 'viewer');
    url.searchParams.set('key', view.key);
    let next;
    try { next = new WebSocket(url.href); } catch { view.schedule(); return; }
    view.socket = next;
    view.phase = 'connecting';
    view.paintLink();
    next.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      view.noteRx();
      if (!data || data.length >= 12000) {
        if (offerDebugFrame(view.frameQ, data || event.data)) view.drainFrames();
        return;
      }
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'pong' || message.type === 'hello') {
        if (view.phase !== 'live') view.phase = 'live';
        view.paintLink();
        return;
      }
      if (message.type === 'audio') {
        view.applyMessage(message);
        return;
      }
      if (message.cameraJpeg || message.stageJpeg) {
        if (offerDebugFrame(view.frameQ, data)) view.drainFrames();
        return;
      }
      view.applyMessage(message);
    };
    next.onopen = () => {
      view.attempts = 0;
      view.noteRx();
      view.phase = 'live';
      view.paintLink();
      try { next.send(JSON.stringify({type: 'ping', t: Date.now()})); } catch { /* the heartbeat timer retries */ }
    };
    next.onerror = () => { try { next.close(); } catch { /* onclose retries */ } };
    next.onclose = () => {
      if (view.socket !== next) return;
      view.socket = null;
      view.phase = 'reconnecting';
      view.paintLink();
      view.schedule();
    };
  }

function pullServerBuild(doc) {
  const view = doc && (doc.defaultView || doc.ownerDocument && doc.ownerDocument.defaultView);
  const fetchImpl = (view && view.fetch) || (typeof fetch === 'function' ? fetch : null);
  if (!doc || typeof fetchImpl !== 'function') return;
  fetchImpl('/neural-dance/version.json', {cache: 'no-store'}).then(response => response && response.ok ? response.json() : null).then(data => {
    const version = cleanVersion(data && data.version);
    const el = doc.querySelector && doc.querySelector('[data-debug-build-server]');
    if (el && version) el.textContent = shortBuild(version);
  }).catch(() => {});
}

export function attachDebugViewer(doc) {
  const view = {doc};
  pullServerBuild(doc);
  view.refreshPainting = refreshPainting;
  view.commandId = commandId;
  view.sendCommand = sendCommand;
  view.render = render;
  view.loadImage = loadImage;
  view.paintLink = paintLink;
  view.noteRx = noteRx;
  view.noteFrame = noteFrame;
  view.frameStale = frameStale;
  view.socketUsable = socketUsable;
  view.applyMessage = applyMessage;
  view.drainFrames = drainFrames;
  view.connect = connect;
  view.schedule = schedule;
  view.reconnectNow = reconnectNow;
  view.watchLink = watchLink;
  view.holdWake = holdWake;
  view.frameCorners = frameCorners;
  view.cameraPoint = cameraPoint;
  view.activeQuad = activeQuad;
  view.placeX = placeX;
  view.sendDancer = sendDancer;
  view.askRemove = askRemove;
  view.placeAt = placeAt;
  view.frameQuadNow = frameQuadNow;
  view.syncDancers = syncDancers;
  view.alignMarks = alignMarks;
  view.sendAnchors = sendAnchors;
  view.sendFrame = sendFrame;
  view.sendPatch = sendPatch;
  view.flagToggle = flagToggle;
  view.clearPresetsUsing = clearPresetsUsing;

  if (!view.doc || !view.doc.body || view.doc.body.dataset.viewerReady === '1') return;
  view.doc.body.dataset.viewerReady = '1';
  view.simPreview = null;
  view.simWanted = false;
  view.previewLevels = null;
  view.previewDraw = 'full';
  view.previewListen = null;
  view.creds = debugCredentials(view.doc);
  view.room = view.creds ? view.creds.room : '';
  view.key = view.creds ? view.creds.key : '';
  view.gate = view.doc.querySelector('[data-debug-missing]');
  view.app = view.doc.querySelector('[data-debug-app]');
  if (!view.room || !view.key) {
    if (view.gate) view.gate.hidden = false;
    if (view.app) view.app.hidden = true;
    return;
  }
  if (view.gate) view.gate.hidden = true;
  if (view.app) view.app.hidden = false;
  bindControlTaps(view.doc);
  view.roomLabel = view.doc.querySelector('[data-debug-room]');
  if (view.roomLabel) view.roomLabel.textContent = view.room;
  view.camera = view.doc.querySelector('[data-debug-camera]');
  view.stage = view.doc.querySelector('[data-debug-stage]');
  view.hover = view.doc.querySelector('[data-debug-hover]');
  view.summary = view.doc.querySelector('[data-debug-summary]');
  view.table = view.doc.querySelector('[data-debug-table]');
  view.cctx = view.camera.getContext('2d');
  view.sctx = view.stage.getContext('2d');
  view.telemetry = null;
  view.cornerDraft = null;
  view.cornerDrag = -1;
  view.frameDraft = null;
  view.frameDrag = -1;
  view.draftBase = null;
  view.draftAt = 0;
  view.draftVersion = 0;
  view.cornersMode = true;
  view.paintWait = null;
  function refreshPainting() {
    const ack = view.telemetry && view.telemetry.commandAck;
    if (view.paintWait && view.paintWait.cmd && ack && ack.cmd === view.paintWait.cmd) {
      view.paintWait = {text: 'Phone: ' + (ack.text || 'done')};
      const acted = ack.action && view.doc.querySelector('[data-debug-action="' + ack.action + '"]');
      if (acted) setControlPhase(acted, 'done');
    }
    paintPaintingStatus(view.doc, view.telemetry, view.paintWait, view);
  }
  function commandId() {
    return ('c' + Math.random().toString(36).slice(2) + '0000').replace(/[^a-z0-9]/g, '').slice(0, 12);
  }
  function sendCommand(action, extra, label) {
    const cmd = view.commandId();
    view.paintWait = {cmd, text: 'sent ' + label + ', waiting for the phone'};
    view.refreshPainting();
    return view.sendPatch(Object.assign({action, cmd}, extra || {}), label);
  }
  view.acks = createAckTracker();   // manual dancer edits awaiting the phone's ack
  view.selected = null;               // selected manual dancer {id, x, y}
  view.dragDancer = null;             // dancer being dragged {id, camera}
  view.cameraImage = null;
  view.stageImage = null;
  view.socket = null;
  view.attempts = 0;
  view.lastRx = 0;
  view.lastFrameAt = 0;
  view.phase = 'connecting';
  view.frameQ = {latest: null, busy: false};

  function render(...args) { return renderDebugFrame(view, ...args); }

  function loadImage(url) {
    return new Promise(resolve => {
      if (!url) return resolve(null);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  }

  view.audioRing = [];
  view.audioHits = null;
  function paintLink() {
    const el = view.doc.querySelector('[data-debug-link-status]');
    if (!el) return;
    const now = Date.now();
    const stale = view.lastFrameAt > 0 && now - view.lastFrameAt > DEBUG_STALL_MS;
    const shown = view.phase === 'live' && stale ? 'stalled' : view.phase;
    el.dataset.state = shown;
    el.textContent = debugLinkText(now, view.lastFrameAt, shown);
  }
  function noteRx() { view.lastRx = Date.now(); }
  function noteFrame() {
    view.noteRx();
    view.lastFrameAt = view.lastRx;
    if (view.phase === 'connecting' || view.phase === 'reconnecting') view.phase = 'live';
    view.paintLink();
  }
  function frameStale() {
    return view.lastFrameAt > 0 && Date.now() - view.lastFrameAt > DEBUG_STALL_MS;
  }
  function socketUsable() {
    if (!view.socket || view.socket.readyState !== 1) return false;
    if (view.lastRx && Date.now() - view.lastRx > DEBUG_STALL_MS) return false;
    if (shouldDropDebugSend(view.socket.bufferedAmount, DEBUG_WS_BUFFER_MAX)) return false;
    return true;
  }
  async function applyMessage(...args) { return applyDebugMessage(view, ...args); }

  async function drainFrames() {
    try {
      for (;;) {
        const raw = takeDebugFrame(view.frameQ);
        if (raw == null) break;
        let message = null;
        try { message = JSON.parse(raw); } catch { message = null; }
        if (view.frameQ.latest != null) continue;
        if (message) {
          try { await view.applyMessage(message); } catch { /* the next frame redraws */ }
        }
      }
    } finally {
      if (finishDebugFrame(view.frameQ)) view.drainFrames();
    }
  }

  function connect(...args) { return connectDebugSocket(view, ...args); }
  function schedule() {
    const delay = Math.min(2000, 400 * 2 ** Math.min(view.attempts, 4));
    view.attempts++;
    setTimeout(view.connect, delay);
  }
  function reconnectNow() {
    view.phase = 'reconnecting';
    view.paintLink();
    const old = view.socket;
    view.socket = null;
    view.lastRx = 0;
    try { if (old) old.close(); } catch { /* already closed */ }
    view.attempts = 0;
    view.connect();
  }
  function watchLink() {
    view.paintLink();
    if (!view.socket || view.socket.readyState !== 1) return;
    try { view.socket.send(JSON.stringify({type: 'ping', t: Date.now()})); } catch { view.reconnectNow(); return; }
    if (view.lastRx && Date.now() - view.lastRx > DEBUG_STALL_MS) view.reconnectNow();
  }
  view.linkTimer = setInterval(view.watchLink, DEBUG_HEARTBEAT_MS);
  if (typeof view.linkTimer.unref === 'function') view.linkTimer.unref();
  view.wakeSentinel = null;
  async function holdWake() {
    try {
      const nav = pageView(view.doc).navigator;
      if (view.wakeSentinel || !nav || !nav.wakeLock || view.doc.visibilityState === 'hidden') return;
      view.wakeSentinel = await nav.wakeLock.request('screen');
      view.wakeSentinel.addEventListener('release', () => { view.wakeSentinel = null; });
    } catch { view.wakeSentinel = null; }
  }
  view.holdWake();
  view.doc.addEventListener('visibilitychange', () => {
    if (view.simPreview) view.simPreview.setOn(!view.doc.hidden && view.simWanted);
    if (view.doc.hidden) return;
    view.holdWake();
    view.attempts = 0;
    if (!view.socket || view.socket.readyState !== 1 || (view.lastRx && Date.now() - view.lastRx > DEBUG_STALL_MS)) view.reconnectNow();
    else view.paintLink();
  });

  view.camera.addEventListener('mousemove', event => {
    const rect = view.camera.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(view.camera.width - 1, Math.floor((event.clientX - rect.left) * view.camera.width / rect.width)));
    const y = Math.max(0, Math.min(view.camera.height - 1, Math.floor((event.clientY - rect.top) * view.camera.height / rect.height)));
    let pixel = [0, 0, 0];
    try {
      const data = view.cctx.getImageData(x, y, 1, 1).data;
      pixel = [data[0], data[1], data[2]];
    } catch { /* canvas not readable yet */ }
    const med = view.telemetry && view.telemetry.quadMedianRgb || [32, 32, 32];
    const wb = pixel.map((channel, index) => (channel / Math.max(1, med[index])).toFixed(2));
    if (view.hover) view.hover.textContent = 'x ' + x + ' y ' + y + ' · RGB ' + pixel.join(' ') + ' · WB ' + wb.join(' ');
  });

  view.cornerSent = 0;
  view.camera.style.touchAction = 'none';
  function frameCorners() {
    return [{x: 0.06, y: 0.08}, {x: 0.94, y: 0.08}, {x: 0.94, y: 0.92}, {x: 0.06, y: 0.92}];
  }
  function cameraPoint(event) {
    const rect = view.camera.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))};
  }
  function activeQuad() {
    if (view.cornerDraft && view.cornerDraft.length === 4) return view.cornerDraft;
    const handles = overlayHandles(view.telemetry, null, {corners: view.cornersMode});
    if (handles && handles.length === 4) return handles;
    return view.frameCorners();
  }
  // Two-step confirm for removing hand-placed markers.
  view.clearManual = view.doc.querySelector('[data-debug-clear-manual]');
  view.clearArmedUntil = 0;
  if (view.clearManual) view.clearManual.addEventListener('click', () => {
    const now = Date.now();
    if (now > view.clearArmedUntil) {
      view.clearArmedUntil = now + 4000;
      view.clearManual.textContent = 'Tap again to remove hand-placed markers';
      setTimeout(() => { if (Date.now() >= view.clearArmedUntil) view.clearManual.textContent = 'Remove hand-placed markers…'; }, 4100);
      return;
    }
    view.clearArmedUntil = 0;
    view.clearManual.textContent = 'Remove hand-placed markers…';
    flashOneShot(view.clearManual);
    view.sendPatch({action: 'clear-manual-markers'}, 'Hand-placed markers removed');
  });
  view.removeMode = false;
  view.removeToggle = view.doc.querySelector('[data-debug-remove-mode]');
  if (view.removeToggle) view.removeToggle.addEventListener('click', () => {
    view.removeMode = !view.removeMode;
    view.removeToggle.setAttribute('aria-pressed', view.removeMode ? 'true' : 'false');
    view.removeToggle.textContent = view.removeMode ? 'Remove mode: on (tap a manual marker)' : 'Remove mode: off';
  });
  // Manual dancers, phone first (TJ Nov 11 4:31 PM). Tap = place, drag a
  // dancer = move, X on the selected dancer or long-press = remove (confirm).
  // Corner handles only drag after real movement; a still tap near a corner
  // places a dancer instead of silently re-committing the quad.
  view.gesture = createDancerGesture();
  view.host = view.camera.parentElement;
  if (view.host && getComputedStyle(view.host).position === 'static') view.host.style.position = 'relative';
  view.removeX = view.doc.createElement('button');
  view.removeX.type = 'button';
  view.removeX.className = 'btn nd-dancer-x';
  view.removeX.setAttribute('data-debug-local', '');
  view.removeX.setAttribute('data-debug-dancer-x', '');
  view.removeX.setAttribute('aria-label', 'Remove selected dancer');
  view.removeX.textContent = '\u00d7';
  view.removeX.hidden = true;
  view.removeX.style.cssText = 'position:absolute;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;border-radius:22px;font-size:26px;line-height:1;background:#5a1620;border-color:#ff6b7a;z-index:6;transform:translate(-50%,-130%)';
  if (view.host) view.host.appendChild(view.removeX);
  view.dancerNote = view.doc.querySelector('[data-debug-dancer-status]');
  if (!view.dancerNote && view.host && view.host.parentElement) {
    view.dancerNote = view.doc.createElement('p');
    view.dancerNote.className = 'lead';
    view.dancerNote.setAttribute('data-debug-dancer-status', '');
    view.dancerNote.setAttribute('aria-live', 'polite');
    view.dancerNote.textContent = 'Tap the feed to place a dancer. Drag a dancer to move it. Tap a dancer, then \u00d7, to remove it.';
    view.host.insertAdjacentElement('afterend', view.dancerNote);
  }
  view.dancerSay = text => { if (view.dancerNote) view.dancerNote.textContent = text; };
  function placeX() {
    if (!view.selected || !view.host) { view.removeX.hidden = true; return; }
    const live = manualMarkers(view.telemetry && view.telemetry.markers).find(m => (m.id | 0) === view.selected.id);
    if (!live) { view.selected = null; view.removeX.hidden = true; return; }
    const c = stageToCamera(live.x, live.y, view.telemetry && view.telemetry.quad);
    if (!c) { view.removeX.hidden = true; return; }
    const rect = view.camera.getBoundingClientRect(), base = view.host.getBoundingClientRect();
    view.removeX.style.left = (rect.left - base.left + c.x * rect.width) + 'px';
    view.removeX.style.top = (rect.top - base.top + c.y * rect.height) + 'px';
    view.removeX.hidden = false;
  }
  function sendDancer(patch, label) {
    const nonce = dancerNonce();
    view.acks.add({nonce, action: patch.action, at: Date.now(), x: patch.x, y: patch.y});
    view.sendPatch({...patch, nonce}, label);
    view.dancerSay(label + ' \u2026 waiting for the phone');
  }
  function askRemove(dancer) {
    if (!dancer) return;
    const ok = typeof pageView(view.doc).confirm === 'function' ? pageView(view.doc).confirm('Remove dancer #' + dancer.id + '?') : true;
    if (!ok) { view.dancerSay('Kept dancer #' + dancer.id + '.'); return; }
    view.selected = null; view.removeX.hidden = true;
    view.sendDancer({action: 'remove-manual-sticker', id: dancer.id, x: dancer.x, y: dancer.y}, 'Removing dancer #' + dancer.id);
  }
  view.removeX.addEventListener('click', event => {
    event.stopPropagation();
    if (view.selected) view.askRemove(view.selected);
  });
  for (const type of ['pointerdown', 'pointerup']) view.removeX.addEventListener(type, event => event.stopPropagation());
  function placeAt(tap) {
    const stage = cameraTapToStage(tap.x, tap.y, view.telemetry && view.telemetry.quad);
    if (!stage) { view.dancerSay('No stage corners yet: run Align or Detect frame first.'); return; }
    let frame = '';
    try { frame = view.camera.toDataURL('image/jpeg', 0.7); } catch { frame = ''; }
    view.training.add({
      at: Date.now(),
      camera: {x: tap.x, y: tap.y},
      stage,
      detector: {stickers: view.telemetry && view.telemetry.stickers, pink: view.telemetry && view.telemetry.pink, markers: view.telemetry && view.telemetry.markers, scan: view.telemetry && view.telemetry.scan},
      frame
    });
    view.sendDancer({action: 'add-manual-sticker', x: stage.x, y: stage.y}, 'Placing dancer');
  }
  function frameQuadNow() {
    if (view.frameDraft && view.frameDraft.length === 4) return view.frameDraft;
    const p = view.telemetry && view.telemetry.painting;
    const quad = p && (p.frameQuad || p.pending);
    return Array.isArray(quad) && quad.length === 4 ? quad : null;
  }
  view.camera.addEventListener('pointerdown', event => {
    const rect = view.camera.getBoundingClientRect();
    const spot = clientToCamera(event.clientX, event.clientY, rect);
    if (!spot) return;
    const dancer = hitManualDancer(view.telemetry && view.telemetry.markers, spot, view.telemetry && view.telemetry.quad, rect);
    let target = {kind: 'empty'};
    if (dancer) target = {kind: 'dancer', dancer};
    else {
      const pink = view.activeQuad();
      const green = view.frameQuadNow();
      const toPx = quad => (Array.isArray(quad) ? quad : []).map(corner => ({x: corner.x * rect.width, y: corner.y * rect.height}));
      const hit = pickCornerHandle({x: spot.x * rect.width, y: spot.y * rect.height}, [
        {kind: 'proj', handles: toPx(pink)},
        {kind: 'frame', handles: toPx(green)}
      ], {frameFirst: true, frameRadius: 26, radius: (view.cornersMode ? 60 : DANCER_TARGET_PX) / 2 + 4});
      if (hit && hit.kind === 'frame') target = {kind: 'corner', index: hit.index, frame: true, quad: green};
      else if (hit) target = {kind: 'corner', index: hit.index, quad: pink};
    }
    view.gesture.down({x: event.clientX, y: event.clientY}, target, Date.now());
    event.preventDefault();
    try { view.camera.setPointerCapture(event.pointerId); } catch { /* drag still follows the pointer */ }
  });
  view.camera.addEventListener('pointermove', event => {
    const intent = view.gesture.move({x: event.clientX, y: event.clientY});
    if (!intent) return;
    const spot = view.cameraPoint(event);
    if (!spot) return;
    event.preventDefault();
    if (intent.type === 'drag-dancer') {
      view.dragDancer = {id: intent.dancer.id, camera: spot};
      view.removeX.hidden = true;
    } else if (intent.type === 'drag-corner' && intent.frame) {
      if (view.frameDrag < 0) {
        const base = view.frameQuadNow();
        view.frameDraft = base ? base.map(corner => ({x: corner.x, y: corner.y})) : null;
        view.frameDrag = intent.index;
      }
      if (view.frameDraft) view.frameDraft[view.frameDrag] = {x: spot.x, y: spot.y};
    } else if (intent.type === 'drag-corner') {
      if (view.cornerDrag < 0) {
        view.cornerDraft = view.activeQuad().map(corner => ({x: corner.x, y: corner.y}));
        view.draftBase = null;
        view.cornerDrag = intent.index;
      }
      view.cornerDraft[view.cornerDrag] = view.cornersMode ? {x: spot.x, y: spot.y} : snapAnchor(spot, view.cornerDrag, view.alignMarks());
    }
    try { view.render(); } catch { /* the next telemetry frame redraws */ }
    // No sends mid-drag (TJ Nov 11 3:58 PM): the page owns the quad / dancer
    // until release, then commits once.
  });
  view.camera.addEventListener('pointercancel', () => { view.gesture.cancel(); view.dragDancer = null; view.cornerDrag = -1; view.frameDrag = -1; view.frameDraft = null; });
  view.camera.addEventListener('pointerup', event => {
    const intent = view.gesture.up({x: event.clientX, y: event.clientY}, Date.now());
    const spot = view.cameraPoint(event);
    const wasDragging = view.dragDancer;
    view.dragDancer = null;
    if (!intent) { try { view.render(); } catch {} return; }
    event.preventDefault();
    if (intent.type === 'place') {
      view.cornerDrag = -1;
      if (view.selected) { view.selected = null; view.removeX.hidden = true; view.dancerSay('Deselected. Tap again to place a dancer.'); return; }
      if (spot) view.placeAt(spot);
      return;
    }
    if (intent.type === 'select') {
      if (view.removeMode) { view.askRemove(intent.dancer); return; }
      view.selected = {id: intent.dancer.id, x: intent.dancer.x, y: intent.dancer.y};
      view.placeX();
      view.dancerSay('Dancer #' + view.selected.id + ' selected: drag to move, \u00d7 to remove.');
      return;
    }
    if (intent.type === 'ask-remove') { view.askRemove(intent.dancer); return; }
    if (intent.type === 'move-dancer') {
      const at = spot || (wasDragging && wasDragging.camera);
      const stage = at ? cameraTapToStage(at.x, at.y, view.telemetry && view.telemetry.quad) : null;
      if (!stage) return;
      view.selected = null; view.removeX.hidden = true;
      view.sendDancer({action: 'move-manual-sticker', id: intent.dancer.id, x: stage.x, y: stage.y}, 'Moving dancer #' + intent.dancer.id);
      return;
    }
    if (intent.type === 'commit-corner' && intent.frame) {
      if (spot && view.frameDraft && view.frameDrag >= 0) view.frameDraft[view.frameDrag] = {x: spot.x, y: spot.y};
      view.frameDrag = -1;
      view.sendFrame();
      try { view.render(); } catch { /* the next telemetry frame redraws */ }
      return;
    }
    if (intent.type === 'commit-corner') {
      if (spot && view.cornerDraft && view.cornerDrag >= 0) view.cornerDraft[view.cornerDrag] = view.cornersMode ? {x: spot.x, y: spot.y} : snapAnchor(spot, view.cornerDrag, view.alignMarks());
      view.cornerDrag = -1;
      view.sendAnchors();
      // Hold the dropped handles until the room reports the new quad (or 6 s).
      view.draftBase = JSON.stringify((view.telemetry && view.telemetry.quad) || null);
      view.draftAt = Date.now();
      try { view.render(); } catch { /* the next telemetry frame redraws */ }
    }
  });
  view.camera.addEventListener('touchmove', event => { if (view.gesture.active()) event.preventDefault(); }, {passive: false});
  // Phone acks for dancer edits, plus the selected dancer's X position.
  function syncDancers() {
    const {acked, late} = view.acks.update(view.telemetry, Date.now());
    for (const a of acked) {
      const verb = a.action === 'remove-manual-sticker' ? 'removed' : a.action === 'move-manual-sticker' ? 'moved' : 'placed';
      view.dancerSay(a.ok ? 'Phone: dancer #' + a.id + ' ' + verb + ' \u2713' : 'Phone did not apply that (' + verb + '): limit reached or dancer gone.');
      view.camera.dataset.dancerAck = a.ok ? 'ok' : 'refused';
    }
    if (late.length && !acked.length) { view.dancerSay('No answer from the phone yet. Is /live/ open and sharing?'); view.camera.dataset.dancerAck = 'late'; }
    if (view.selected) view.placeX();
  }
  function alignMarks() {
    const marks = view.telemetry && view.telemetry.align && view.telemetry.align.marks;
    return Array.isArray(marks) ? marks : [];
  }
  // The draft is the four circle positions; the room stores stage corners.
  function sendAnchors() {
    view.draftVersion = Date.now();
    const quadLine = view.doc.querySelector('[data-debug-quad]');
    if (quadLine) quadLine.textContent = 'Corners: manual (locked) · sending';
    if (view.cornersMode) {
      // Corners mode: the handles ARE the numbered stage corners.
      return view.sendPatch({corners: view.cornerDraft.map(p => ({x: p.x, y: p.y})), cornersVersion: view.draftVersion, cornersKind: 'stage', cornersLock: 'set'}, 'Corners sent');
    }
    const corners = cornersFromAnchors(view.cornerDraft);
    if (!corners) {
      const note = view.doc.querySelector('[data-debug-sent]');
      if (note) note.textContent = 'Corners not sent: that shape is not a wall';
      return false;
    }
    return view.sendPatch({corners, cornersVersion: view.draftVersion, cornersLock: 'set'}, 'Corners sent');
  }
  function sendFrame() {
    if (!view.frameDraft || view.frameDraft.length !== 4) return false;
    return view.sendPatch({frameQuad: view.frameDraft.map(p => ({x: p.x, y: p.y})), frameLock: 'set'}, 'Frame: manual (locked)');
  }
  function sendPatch(raw, label) {
    const patch = sanitizeDebugPatch(raw);
    if (!patch) return false;
    const body = JSON.stringify({type: 'propose_patch', patch});
    let sent = false;
    if (view.socketUsable()) {
      try { view.socket.send(body); sent = true; } catch { sent = false; }
    }
    if (!sent) {
      const url = '/api/neural-dance/debug/patch?room=' + encodeURIComponent(view.room) + '&key=' + encodeURIComponent(view.key);
      fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify({patch})}).catch(() => {});
    }
    const note = view.doc.querySelector('[data-debug-sent]');
    if (note) note.textContent = (label || 'Tuning sent') + (view.frameStale() ? ' · feed stalled, queued for the phone' : '');
    return true;
  }
  view.send = view.doc.querySelector('[data-debug-send]');
  view.dirty = new Set();
  // Full state only once the panel has synced from the phone.
  if (view.send) view.send.addEventListener('click', () => {
    if (!(view.doc.body && view.doc.body.dataset && view.doc.body.dataset.tuningSynced === '1')) {
      // Not synced yet: only the sliders touched here, never stale defaults.
      const patch = {};
      for (const name of view.dirty) {
        if (name === 'mode') { const m = view.doc.querySelector('[data-debug-mode] [aria-pressed="true"]'); if (m) patch.markerMode = m.dataset.mode; }
        else Object.assign(patch, controlPatch(view.doc, name) || {});
      }
      view.sendPatch(patch, Object.keys(patch).length ? 'Sent changed controls (waiting for phone sync)' : 'Nothing changed yet (waiting for phone sync)');
      return;
    }
    view.sendPatch(tuningPatch(view.doc), 'Tuning sent');
  });
  view.doc.querySelectorAll('[data-debug-control]').forEach(input => {
    input.addEventListener('change', () => {
      const name = input.dataset.debugControl;
      view.dirty.add(name);
      view.clearPresetsUsing(name);
      const patch = controlPatch(view.doc, name);
      if (patch) view.sendPatch(patch, 'Sent ' + name);
    });
  });
  view.sensReset = view.doc.querySelector('[data-debug-sens-reset]');
  if (view.sensReset) view.sensReset.addEventListener('click', () => {
    for (let b = 0; b < 4; b++) view.dirty.add('sens-' + b);
    view.sendPatch(bandSensResetPatch(view.doc), 'Band sens reset to recommended');
  });
  // Painting surface (TJ Nov 11 4:00 PM): Accept sends the pending frame quad,
  // or the nudged one while Corners mode has a draft.
  view.frameAccept = view.doc.querySelector('[data-debug-frame-accept]');
  if (view.frameAccept) view.frameAccept.addEventListener('click', () => {
    const p = view.telemetry && view.telemetry.painting;
    const quad = view.cornersMode && view.cornerDraft && view.cornerDraft.length === 4 ? view.cornerDraft.map(c => ({x: c.x, y: c.y})) : (p && p.pending) || null;
    flashOneShot(view.frameAccept);
    view.sendCommand('frame-accept', quad ? {quad} : null, 'Accept frame');
  });
  view.cornersToggle = view.doc.querySelector('[data-debug-corners-mode]');
  if (view.cornersToggle) view.cornersToggle.addEventListener('click', () => {
    view.cornersMode = !view.cornersMode;
    view.cornerDraft = null; view.draftBase = null;
    view.cornersToggle.setAttribute('aria-pressed', view.cornersMode ? 'true' : 'false');
    view.cornersToggle.textContent = view.cornersMode ? 'Corners mode: on (drag numbered corners)' : 'Corners mode: off';
    view.paintWait = {text: view.cornersMode ? 'Corners mode on — drag the numbered corners' : 'Corners mode off'};
    view.refreshPainting();
  });
  view.PAINT_ACTIONS = new Set(['frame-detect', 'frame-retry', 'frame-clear', 'painting-reference', 'scan-stickers', 'snap-projector-frame']);
  view.doc.querySelectorAll('[data-debug-sticker-color]').forEach(button => {
    button.addEventListener('click', () => view.sendCommand('sticker-color', {value: button.dataset.debugStickerColor}, button.textContent.trim()));
  });
  view.doc.querySelectorAll('[data-debug-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.debugAction;
      const label = button.textContent.trim();
      flashOneShot(button);
      if (view.PAINT_ACTIONS.has(action)) view.sendCommand(action, null, label);
      else view.sendPatch({action}, label);
    });
  });
  view.stageCm = view.doc.querySelector('[data-debug-stage-cm]');
  if (view.stageCm) view.stageCm.addEventListener('change', () => {
    const cm = +view.stageCm.value;
    if (Number.isFinite(cm) && cm >= 50 && cm <= 2000) view.sendPatch({stageWidthCm: cm}, 'Stage width ' + Math.round(cm) + ' cm');
  });
  if (view.stage) view.stage.addEventListener('click', event => {
    const rect = view.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * STAGE_W;
    const y = (event.clientY - rect.top) / rect.height * STAGE_H;
    const patch = resolveStageTap(view.telemetry && view.telemetry.markers, x, y, undefined, {remove: view.removeMode});
    if (!patch) return;
    const label = patch && patch.action === 'remove-manual-sticker' ? 'Manual sticker removed' : 'Manual sticker sent';
    view.sendPatch(patch, label);
  });
  view.listenButton = view.doc.querySelector('[data-debug-listen]');
  view.training = createTrainingLog();
  if (view.listenButton) view.listenButton.addEventListener('click', () => {
    const listening = view.telemetry && view.telemetry.audio && view.telemetry.audio.mic === 'listening';
    const command = pressShowControl('listen', 'debug', {listening});
    view.sendPatch(command, listening ? 'Stop listening' : 'Listen');
  });
  view.bloomToggle = view.doc.querySelector('[data-debug-bloom]');
  if (view.bloomToggle) view.bloomToggle.addEventListener('click', () => {
    const next = view.bloomToggle.getAttribute('aria-pressed') === 'false';
    view.bloomToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
    view.bloomToggle.textContent = next ? 'Bloom: on' : 'Bloom: off';
    view.sendPatch({bloomEnabled: next}, next ? 'Bloom on' : 'Bloom off');
  });
  view.rippleToggle = view.doc.querySelector('[data-debug-ripple]');
  if (view.rippleToggle) view.rippleToggle.addEventListener('click', () => {
    const next = view.rippleToggle.getAttribute('aria-pressed') === 'false';
    view.rippleToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
    view.rippleToggle.textContent = next ? 'Ripple: on' : 'Ripple: off';
    view.sendPatch({rippleEnabled: next}, next ? 'Ripple on' : 'Ripple off');
  });
  view.insetsToggle = view.doc.querySelector('[data-debug-insets]');
  if (view.insetsToggle) view.insetsToggle.addEventListener('click', () => {
    const next = view.insetsToggle.getAttribute('aria-pressed') === 'false';
    view.insetsToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
    view.insetsToggle.textContent = next ? 'Insets: on' : 'Insets: off';
    view.sendPatch({insetsEnabled: next}, next ? 'Corner insets on' : 'Corner insets off');
  });
  view.personPause = view.doc.querySelector('[data-debug-person-pause]');
  if (view.personPause) view.personPause.addEventListener('click', () => {
    const next = view.personPause.getAttribute('aria-pressed') !== 'true';
    view.personPause.setAttribute('aria-pressed', next ? 'true' : 'false');
    view.personPause.textContent = next ? 'Person pause: on' : 'Person pause: off';
    view.sendPatch({personPause: next}, next ? 'Person pause on' : 'Person pause off');
  });
  view.gapScan = view.doc.querySelector('[data-debug-gap-scan]');
  if (view.gapScan) view.gapScan.addEventListener('click', () => {
    const next = view.gapScan.getAttribute('aria-pressed') !== 'true';
    view.gapScan.setAttribute('aria-pressed', next ? 'true' : 'false');
    view.gapScan.textContent = next ? 'Between-songs scan: on' : 'Between-songs scan: off';
    view.sendPatch({gapScan: next}, next ? 'Between-songs scan on' : 'Between-songs scan off');
  });
  view.reload = view.doc.querySelector('[data-debug-reload]');
  if (view.reload) view.reload.addEventListener('click', () => {
    const body = JSON.stringify({type: 'reload'});
    let sent = false;
    if (view.socketUsable()) {
      try { view.socket.send(body); sent = true; } catch { sent = false; }
    }
    if (!sent) view.sendPatch({action: 'reload'}, 'Reload sent');
    else {
      const note = view.doc.querySelector('[data-debug-sent]');
      if (note) note.textContent = 'Reload sent';
    }
  });
  view.doc.querySelectorAll('[data-debug-draw]').forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.dataset.debugDraw;
      if (mode !== 'dots' && mode !== 'silhouette' && mode !== 'beat' && mode !== 'full') return;
      view.doc.querySelectorAll('[data-debug-draw]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
      view.previewDraw = mode;
      const label = mode === 'dots' ? 'Dots' : mode === 'silhouette' ? 'Sticker silhouettes' : mode === 'beat' ? 'Beat' : 'Dancer';
      view.sendPatch({action: 'set-draw-mode', mode}, label);
    });
  });
  view.doc.querySelectorAll('[data-debug-mode] [data-mode]').forEach(button => {
    button.addEventListener('click', () => {
      view.doc.querySelectorAll('[data-debug-mode] [data-mode]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
      view.dirty.add('mode');
      view.sendPatch({markerMode: button.dataset.mode}, 'Tracking ' + button.dataset.mode);
    });
  });
  function flagToggle(el, onAction, offAction, onLabel, offLabel) {
    if (!el) return;
    el.addEventListener('click', () => {
      const next = el.getAttribute('aria-pressed') !== 'true';
      el.setAttribute('aria-pressed', next ? 'true' : 'false');
      el.textContent = next ? onLabel : offLabel;
      view.sendPatch({action: next ? onAction : offAction}, next ? onLabel : offLabel);
    });
  }
  view.flagToggle(view.doc.querySelector('[data-debug-run]'), 'start', 'pause', 'Show: running', 'Show: paused');
  view.flagToggle(view.doc.querySelector('[data-debug-markers]'), 'markers-on', 'markers-off', 'Markers: on', 'Markers: off');
  view.flagToggle(view.doc.querySelector('[data-debug-chrome]'), 'hide-controls', 'show-controls', 'Phone controls: hidden', 'Phone controls: shown');
  function clearPresetsUsing(name) {
    for (const [group, options] of Object.entries(DEBUG_PRESETS)) {
      const uses = Object.values(options).some(map => Object.prototype.hasOwnProperty.call(map, name));
      if (!uses) continue;
      view.doc.querySelectorAll('[data-debug-preset="' + group + '"]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    }
  }
  view.doc.querySelectorAll('[data-debug-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const group = button.dataset.debugPreset;
      const map = DEBUG_PRESETS[group] && DEBUG_PRESETS[group][button.dataset.preset];
      if (!map) return;
      view.doc.querySelectorAll('[data-debug-preset="' + group + '"]').forEach(other => {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
      for (const name of Object.keys(map)) view.dirty.add(name);
      view.sendPatch(presetPatch(view.doc, map), button.textContent.trim());
    });
  });
  view.simButton = view.doc.querySelector('[data-debug-sim-toggle]');
  view.simCanvas = view.doc.querySelector('[data-debug-sim-canvas]');
  view.simNote = view.doc.querySelector('[data-debug-sim-note]');
  if (view.simButton && view.simCanvas) {
    const previewSample = () => {
      const t = tuningPatch(view.doc);
      const local = simDetailTuning(view.doc.querySelector('[data-sim-details]'));
      const pick = (key, fallback) => (local[key] != null ? local[key] : fallback);
      const mic = view.previewListen && view.previewListen.on() ? view.previewListen.levels() : null;
      return {
        tuning: {
          sens: [t.kickSensitivity, t.bassSensitivity, t.snareSensitivity, t.hatSensitivity],
          quiet: t.quietThreshold,
          bloomEnabled: t.bloomEnabled !== false,
          bloomIntensity: pick('bloomIntensity', t.bloomIntensity),
          bloomAura: t.bloomAura,
          hueSpread: pick('hueSpread', t.hueSpread),
          hipEight: pick('hipEight', t.hipEight),
          shoulderEight: pick('shoulderEight', t.shoulderEight),
          hipTwist: pick('hipTwist', t.hipTwist),
          shoulderTwist: pick('shoulderTwist', t.shoulderTwist),
          maxBodyTurn: pick('maxBodyTurn', t.maxBodyTurn),
          turnFreq: pick('turnFreq', t.turnFreq),
          eightDepth: pick('eightDepth', t.eightDepth),
          eightVert: pick('eightVert', t.eightVert),
          armPadSense: pick('armPadSense', t.armPadSense),
          innerBones: pick('innerBones', undefined)
        },
        drawMode: view.previewDraw,
        slowdown: t.bodyMotionSlowdown,
        levels: mic || view.previewLevels
      };
    };
    view.simPreview = createDebugSimPreview(view.simCanvas, previewSample);
    view.previewListen = createPreviewListen(pageView(view.doc));
    const listenButton = view.doc.querySelector('[data-debug-sim-listen]');
    const listenNote = view.doc.querySelector('[data-debug-sim-listen-note]');
    mountSimDetailControls(view.doc.querySelector('[data-sim-details]'));
    view.simButton.addEventListener('click', () => {
      view.simWanted = !view.simWanted;
      if (!view.simWanted && view.previewListen && view.previewListen.on()) {
        view.previewListen.stop();
        if (listenButton) {
          listenButton.setAttribute('aria-pressed', 'false');
          listenButton.textContent = 'Listen';
        }
        if (listenNote) listenNote.textContent = 'Listen is off. Turning it on asks this device for the microphone and drives the preview from that audio.';
      }
      view.simPreview.setOn(view.simWanted && !view.doc.hidden);
      view.simButton.setAttribute('aria-pressed', view.simWanted ? 'true' : 'false');
      view.simButton.textContent = view.simWanted ? 'Hide sim dancer' : 'Show one sim dancer';
      if (view.simNote) view.simNote.hidden = !view.simWanted;
    });
    if (listenButton) listenButton.addEventListener('click', () => {
      if (!view.previewListen) return;
      if (view.previewListen.on()) {
        view.previewListen.stop();
        listenButton.setAttribute('aria-pressed', 'false');
        listenButton.textContent = 'Listen';
        if (listenNote) listenNote.textContent = 'Listen is off. Turning it on asks this device for the microphone and drives the preview from that audio.';
        return;
      }
      listenButton.textContent = 'Asking…';
      view.previewListen.start().then(() => {
        listenButton.setAttribute('aria-pressed', 'true');
        listenButton.textContent = 'Listening';
        if (listenNote) listenNote.textContent = 'This device’s microphone is driving the preview. The projector is unchanged.';
        if (!view.simWanted) {
          view.simWanted = true;
          view.simPreview.setOn(!view.doc.hidden);
          view.simButton.setAttribute('aria-pressed', 'true');
          view.simButton.textContent = 'Hide sim dancer';
          if (view.simNote) view.simNote.hidden = false;
        }
      }).catch(() => {
        view.previewListen.stop();
        listenButton.setAttribute('aria-pressed', 'false');
        listenButton.textContent = 'Listen';
        if (listenNote) listenNote.textContent = 'Microphone unavailable. Listen stays off.';
      });
    });
  }

  view.render();
  view.connect();
}

if (typeof document !== 'undefined') {
  const boot = () => attachDebugViewer(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
