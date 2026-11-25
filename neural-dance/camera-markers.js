// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Camera mode for the Neural Dance wall.
// Continuity Camera (an "iPhone Camera" device) watches the projection.
// Four clicked corners build a homography into the Room music canvas.
// Pink notes become dancers through nd-room-lab.neuralDance.setMarkers,
// the marker hook marker hook can call. sample() returns
// [{id, x, y, type}] in projection pixels, or null while the camera is not driving.

import {createDriftWatch, DRIFT_CHECK_MS} from './src/drift-watch.js';
import {blankFrameVerified, blankHoldForLag, CONTINUOUS_AUTO_LATCHED_MISSES, CONTINUOUS_HITS, CONTINUOUS_LATCHED_MISSES, CONTINUOUS_MISSES, createBlankSettle, createScanClock, frameMatchesFlash, frameMedianLum, mergeScanPoints, nextScanMode, readLatency, readScanSettings, SCAN_SPLIT_MERGE, scanBlankFrame, stickerModeForFlash, writeLatency, writeScanSettings} from './src/blank-scan.js';
import {createStickerScan} from './src/scan-session.js';
import {createLatencyTracker, decodeLatencyFrame, decodeLatencySamples, latencyStageLayout, sampleCellLuma, shiftLatencyLayout} from './src/latency-code.js';
import {projectContour, sanitizeContour, traceContour} from './src/silhouette.js';
import {coverageFromRead, createPersonOcclusion, createStaticBackground, emptyOcclusion, occlusionTelemetry, personInFrame, projectedFromEcho, readPersonPause, syncPersonNote, syncPersonPauseChip, writePersonPause, PERSON_SCAN_RETRIES} from './src/person-occlusion.js';
import {createQuadLock} from './src/quad-lock.js';
import {PLAY_EDGE_INSET, stickerInPlay} from './src/align-anchors.js';
import {keepConfirmedStickers, matchScanIds, readGapScan, scanApplyOk, writeGapScan} from './src/song-gap-scan.js';
import {createOkHandWatcher} from './src/ok-hand-scan.js';
import {createManualStickers, mergeLatchedStickers} from './src/debug-manual-stickers.js';
import {createPaintingSession} from './src/painting-session.js';
import {mergeNewStickers} from './src/painting-diff.js';
import {sceneClose, sceneSignature} from './src/visit-scan.js';
import {frameContainsPoint, nearestHandle, paintingFlashLit, pointInQuad, projectorWarpTarget, quadConvex, warpMatrix3d} from './src/painting-frame.js';
import {applyHomography, orderProjectorCorners, projectedStickerHeight, solveHomography, videoHomographyFromNorm} from './src/geometry.js';

export {applyHomography, solveHomography};

// Manual white balance, when the camera track lists it. Exposure stays automatic.
export function manualWhiteBalanceMode(caps) {
  const modes = caps && Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : [];
  return modes.includes('manual') ? 'manual' : null;
}

// v3 keeps a back-camera choice and a sane quad, and tightens untouched slider defaults.
export const STORAGE_KEY = 'nd.camera.v3';
export const RELOAD_LATCH_KEY = 'nd.live.latch.v1';
export const LEGACY_CAMERA_KEYS = ['nd.camera.v2', 'nd.camera.v1', 'nd-camera-mode'];
export const CANVAS_W = 1000;
export const CANVAS_H = 620;
// Raw single-pixel pink, wide enough for both of TJ's measured notes (293.8° and 8.6°).
export const PINK_HUE = 332;
// White-balanced pink. Both real rooms land near 340° after dividing out the screen.
export const PINK_WB_HUE = 340;
export const APPEAR_MS = 1500;
export const CLEAR_MS = 300;
// Stage pixels. A re-seen note or sticker inside this radius updates the latched dot.
// Min gap between a NEW continuous latch and an existing one (~1.5 dancer
// widths). Scan stickers may place closer. Breaks the project→detect loop
// along the stage edge (TJ 4:35 PM).
export const NEAR_LATCH_GAP = 90;
// Pure helper: a stage point sits on a projected sim dancer (TJ 4:37 PM).
export function nearProjectedSims(x, y, sims, radius = NEAR_LATCH_GAP) {
  if (!Array.isArray(sims) || !sims.length) return false;
  const r = Number.isFinite(+radius) ? +radius : NEAR_LATCH_GAP;
  for (const d of sims) {
    if (d && Number.isFinite(+d.x) && Number.isFinite(+d.y) && Math.hypot(+d.x - x, +d.y - y) <= r) return true;
  }
  return false;
}
export const LATCH_RADIUS = 80;
export const UI_EXCLUSION_SELECTORS = ['#nd-live-dock', '#nd-camera-mode', '.nd-live-chrome', '.nd-live-reveal', '[data-nd-build]', '[data-live="hide"]', '[data-live="reveal"]', 'button[data-live]'];
export const DETECT_WIDTH = 480;
export const VALUE_FLOOR = 0.35;
export const PINK_VALUE_FLOOR = 0.32;
export const CORNER_STEPS = ['top left', 'top right', 'bottom right', 'bottom left'];
export const PROJECTION_CORNERS = [
  {x: 0, y: 0},
  {x: CANVAS_W, y: 0},
  {x: CANVAS_W, y: CANVAS_H},
  {x: 0, y: CANVAS_H}
];
// Colored corner fiducials drawn over the live dancers, in stage units (0–1).
// Order matches PROJECTION_CORNERS: top left, top right, bottom right, bottom left.
export const CALIBRATION_MARKERS = [
  // Must match where the Align pattern draws them (room-lab.js
  // paintAlignmentPattern and the live page's .nd-cal-pattern: 18% / 82%).
  // These said 14% / 86% until Nov 9, so every marker align shrank the
  // camera-to-stage map ~11% and pushed blooms outward off the stickers.
  {hue: 0, name: 'red', x: 0.18, y: 0.18},
  // Teal, not #0f0. A warm projector shifts pure green onto yellow.
  {hue: 164, name: 'green', x: 0.82, y: 0.18},
  {hue: 240, name: 'blue', x: 0.82, y: 0.82},
  {hue: 60, name: 'yellow', x: 0.18, y: 0.82}
];
export const CALIBRATION_GREEN_HUE_MIN = 75;
export const CALIBRATION_GREEN_HUE_MAX = 195;
export const CALIBRATION_GREEN_WHITE_CAP = {v: 0.55, s: 0.38};
export const ALIGN_TIMEOUT_MS = 8000;
export const DETECTION_MODES = ['both', 'pink', 'stickers'];
export const DEFAULTS = {
  hueTolerance: 32,
  saturationSensitivity: 0.45,
  minBlobSize: 22,
  maxBlobSize: 160,
  detectionMode: 'both',
  markerMode: 'both',
  stickerSensitivity: 0.5
};
export const DEFAULT_QUAD = [
  {x: 0, y: 0},
  {x: 1, y: 0},
  {x: 1, y: 1},
  {x: 0, y: 1}
];
export function areaScaleFor(width) {
  const w = Math.max(1, width | 0);
  return Math.max(1, (w / 160) * (w / 160));
}

// Slider pixels are raw area on frames up to 160 wide (the unit tests).
// On the 480-wide detection grid they are real detection pixels: 87 means 87 px,
// not 87 × areaScale(480). A 3×3" note is about 150–220 px there.
export function minBlobEquivalent(minBlobSize, width) {
  const min = +minBlobSize;
  const w = width | 0;
  if (!(w > 160) || !Number.isFinite(min)) return min;
  return min / areaScaleFor(480);
}

// Preview and debug use the quad and the UI panels whenever the wall is aligned,
// including while Markers is still off.
export function markerFrameGate(homography, exclusions) {
  if (!homography) return {homography: null, exclude: null};
  return {homography, exclude: exclusions || []};
}
export function normalizeDetectionMode(mode) {
  return DETECTION_MODES.includes(mode) ? mode : 'both';
}

function clamp(n, lo, hi, fallback) {
  const v = +n;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function point(p) {
  if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) return null;
  return {x: +p.x, y: +p.y};
}

// 0 tightens to ~0.45. Default 0.75 is a washed-out note (~0.14). 1 reaches ~0.06.
export function saturationFloor(sensitivity) {
  const s = clamp(sensitivity, 0, 1, DEFAULTS.saturationSensitivity);
  if (s <= 0.75) return 0.45 - (s / 0.75) * (0.45 - 0.14);
  return 0.14 - ((s - 0.75) / 0.25) * (0.14 - 0.06);
}

// Green absorption of a physical note. 0 requires ~0.31, default 0.45 requires ~0.24, max 1.0 requires 0.16.
export function greenAbsorption(sensitivity) {
  const s = clamp(sensitivity, 0, 1, DEFAULTS.saturationSensitivity);
  return Math.max(0.16, 0.305 - s * 0.145);
}

export function maxBlobCap(width, height, override) {
  if (override != null && Number.isFinite(+override)) return Math.max(1, Math.round(+override));
  const area = Math.max(1, (width | 0) * (height | 0));
  // 160 cells on a 160×100 grid rejects the projector's 180px wash. Smaller frames keep 10%.
  return Math.min(160, Math.max(64, Math.round(area * 0.10)));
}

// solveHomography / applyHomography live in src/geometry.js (shared with
// debug and the side sim) and are re-exported above.

export function homographyFromNormalized(corners, videoWidth, videoHeight, dest = PROJECTION_CORNERS) {
  if (!corners || corners.length !== 4) return null;
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null;
  const ordered = orderProjectorCorners(corners);
  if (!ordered) return null;
  const src = [];
  for (const corner of ordered) {
    src.push({x: corner.x * videoWidth, y: corner.y * videoHeight});
  }
  return solveHomography(src, dest);
}

// Pattern-on minus pattern-off. Unchanged room light becomes black so Align
// locks onto what the projector added, not the lit wall.
export function differenceImage(on, off) {
  if (!on || !off || on.length !== off.length) return on || null;
  const out = new Uint8ClampedArray(on.length);
  for (let i = 0; i < on.length; i += 4) {
    const delta = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
    out[i + 3] = 255;
    if (delta < 36) continue;
    out[i] = on[i];
    out[i + 1] = on[i + 1];
    out[i + 2] = on[i + 2];
  }
  return out;
}

export function noteScanSample(stats, raw) {
  if (!stats) return stats;
  stats.scanCount = (stats.scanCount | 0) + 1;
  stats.rawCount = Math.max(0, raw | 0);
  stats.lastScanAt = Date.now();
  return stats;
}

function calibrationBlobOptions(marker, baseline) {
  const wide = !!(marker && marker.name === 'green');
  const blue = !!(marker && marker.name === 'blue');
  return {
    hueCenter: wide ? 135 : marker.hue,
    hueTolerance: wide ? 60 : blue ? 48 : (Number.isFinite(+marker.hueTolerance) ? +marker.hueTolerance : 28),
    hueMin: wide ? CALIBRATION_GREEN_HUE_MIN : null,
    hueMax: wide ? CALIBRATION_GREEN_HUE_MAX : null,
    // The Align pattern's white grid reads faintly green on camera (TJ 8:47 PM:
    // hue ~131, sat 0.10-0.30, value ~0.8). With the wide teal window it joined
    // the teal box to the grid as one big blob in the wrong quadrant, and teal
    // was claimed off a grid crossing. Bright, washed-out pixels are not teal;
    // the real box is sat ~0.62 and dim fall-off (value < 0.55) still counts.
    whiteCap: wide ? CALIBRATION_GREEN_WHITE_CAP : null,
    // Dim projector fall-off on the right still has to match teal and blue.
    minSaturation: 0.16,
    minBlobSize: 3,
    valueFloor: 0.22,
    maxBlobSize: Infinity,
    disablePinkHeuristics: true,
    baseline
  };
}

function sameCalibrationBlob(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) < 8;
}

function inMarkerQuadrant(blob, marker, width, height) {
  const left = marker.x < 0.5;
  const top = marker.y < 0.5;
  return (blob.x < width / 2) === left && (blob.y < height / 2) === top;
}

// Align circles sit inset (~18%/82%). A hit on the physical screen bezel or
// the lit-wall edge under ambient light is not a circle (TJ 4:42–4:43 PM).
export function calibrationBlobOnBorder(blob, width, height, margin = 0.035) {
  if (!blob || !(width > 0) || !(height > 0)) return true;
  const m = Number.isFinite(+margin) ? Math.max(0, +margin) : 0.035;
  const nx = blob.x / width;
  const ny = blob.y / height;
  return nx < m || ny < m || nx > 1 - m || ny > 1 - m;
}

function claimCalibrationBlob(blobs, marker, width, height, used) {
  let best = null;
  let bestArea = -1;
  let bestDist = Infinity;
  const tx = marker.x * width;
  const ty = marker.y * height;
  for (const blob of blobs) {
    if (used.some(other => sameCalibrationBlob(other, blob))) continue;
    if (calibrationBlobOnBorder(blob, width, height)) continue;
    const dist = Math.hypot(blob.x - tx, blob.y - ty);
    // Prefer the expected inset corner over a bigger border/wall blob.
    const expectedBias = dist * 0.35;
    const score = blob.area - expectedBias;
    const bestScore = bestArea - bestDist * 0.35;
    if (!best || score > bestScore || (score === bestScore && dist < bestDist)) {
      best = blob;
      bestArea = blob.area;
      bestDist = dist;
    }
  }
  return best;
}

// A global exposure jump changes most of the frame. That baseline would hide
// the markers or keep the whole wall, so it is ignored.
export function calibrationBaselineUseful(rgba, baseline) {
  if (!rgba || !baseline || baseline.length !== rgba.length || rgba.length < 16) return false;
  let changed = 0;
  let seen = 0;
  const pixels = rgba.length / 4;
  const stride = Math.max(1, Math.floor(pixels / 4000));
  for (let i = 0; i < pixels; i += stride) {
    const p = i * 4;
    seen++;
    const delta = Math.abs(rgba[p] - baseline[p]) + Math.abs(rgba[p + 1] - baseline[p + 1]) + Math.abs(rgba[p + 2] - baseline[p + 2]);
    if (delta >= 48) changed++;
  }
  if (!seen) return false;
  const frac = changed / seen;
  return frac >= 0.004 && frac <= 0.45;
}

// Hue first, then a channel lead, so a dim projector blue or a partly blown
// yellow still counts. White and the warm wall do not.
export function calibrationChannel(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 22) return null;
  const hsv = rgbToHsv(r, g, b);
  if (hsv.s < 0.07 && max > 235) return null;
  if (hsv.v >= 0.08 && hsv.s >= 0.08) {
    if (hsv.h >= CALIBRATION_GREEN_HUE_MIN && hsv.h <= CALIBRATION_GREEN_HUE_MAX && g + 10 >= r && g + 6 >= b) return 'green';
    if (hueDistance(hsv.h, 60) <= 34 && r > 36 && g > 36 && b + 16 < Math.min(r, g)) return 'yellow';
    if (hueDistance(hsv.h, 0) <= 26 && r > g + 8 && r > b + 8) return 'red';
    if (hueDistance(hsv.h, 240) <= 38 && b > r + 6 && b > g + 4) return 'blue';
  }
  if (b >= 18 && b > r + 8 && b > g + 6 && r < 210) return 'blue';
  if (r >= 40 && g >= 40 && b + 16 < Math.min(r, g) && Math.abs(r - g) < 90) return 'yellow';
  if (r >= 32 && r > g + 8 && r > b + 8) return 'red';
  if (g >= 32 && g > r + 4 && hsv.h >= 70 && hsv.h <= 200) return 'green';
  return null;
}

function chromaBlobs(rgba, width, height, baseline) {
  const w = width | 0;
  const h = height | 0;
  const names = ['red', 'green', 'blue', 'yellow'];
  const count = w * h;
  const mask = new Uint8Array(count);
  const useBase = calibrationBaselineUseful(rgba, baseline);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    let channel = null;
    if (useBase) {
      const dr = rgba[p] - baseline[p];
      const dg = rgba[p + 1] - baseline[p + 1];
      const db = rgba[p + 2] - baseline[p + 2];
      // Temporal difference only while the baseline is useful — absolute chroma
      // on a lit wall snaps to the screen bezel instead of the circles.
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) >= 36) channel = calibrationChannel(128 + dr, 128 + dg, 128 + db);
    } else {
      channel = calibrationChannel(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    const index = names.indexOf(channel);
    if (index >= 0) mask[i] = index + 1;
  }
  const seen = new Uint8Array(count);
  const best = [null, null, null, null];
  const minArea = Math.max(6, Math.round(count * 0.00025));
  const maxArea = Math.round(count * 0.22);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      const kind = mask[start];
      if (!kind || seen[start]) continue;
      let head = 0;
      let tail = 0;
      const qx = [x];
      const qy = [y];
      tail = 1;
      seen[start] = 1;
      let sumX = 0;
      let sumY = 0;
      let area = 0;
      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;
        sumX += cx;
        sumY += cy;
        area++;
        const neighbors = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1];
        for (let k = 0; k < neighbors.length; k += 2) {
          const nx = neighbors[k];
          const ny = neighbors[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] !== kind || seen[ni]) continue;
          seen[ni] = 1;
          qx[tail] = nx;
          qy[tail] = ny;
          tail++;
        }
      }
      if (area < minArea || area > maxArea) continue;
      const blob = {x: sumX / area, y: sumY / area, area};
      if (!best[kind - 1] || blob.area > best[kind - 1].area) best[kind - 1] = blob;
    }
  }
  return best;
}

const CALIBRATION_CORNER_NAMES = ['1 red', '2 teal', '3 blue', '4 yellow'];

export function readCalibration(rgba, width, height, markers = CALIBRATION_MARKERS, baseline = null) {
  const centers = findCalibrationMarkers(rgba, width, height, markers, baseline);
  if (centers) return {centers, found: [true, true, true, true], reason: '', marks: centers};
  const blobs = rgba && width > 0 && height > 0 ? chromaBlobs(rgba, width, height, baseline) : [null, null, null, null];
  const found = blobs.map(blob => !!blob);
  const missing = CALIBRATION_CORNER_NAMES.filter((name, index) => !found[index]);
  return {
    centers: null,
    found,
    reason: missing.length ? 'Not seeing ' + missing.join(', ') : 'The four colors overlap. Drag the corners.',
    marks: blobs
  };
}

// One center per calibration hue. Coordinates are in the buffer that was passed in.
// Corner blocks are large, so the size cap is lifted. Hue 0 does not use the pink-note
// rule. The green block accepts cyan through teal (75°..195°) so a warm wall cannot
// hand it to yellow. When several blobs match, the one in that corner's quadrant wins.
// A useful baseline keeps only pixels that changed after the grid appeared. A full-frame
// exposure jump is not useful and is ignored. If hue matching misses a dim or blown
// corner, the channel pass still accepts it. Stage echo is not consulted: blooms on
// the wall are smaller than the corner blocks and must not erase them.
export function findCalibrationMarkers(rgba, width, height, markers = CALIBRATION_MARKERS, baseline = null) {
  if (!rgba || !(width > 0) || !(height > 0) || !markers || markers.length !== 4) return null;
  let src = rgba;
  let changed = calibrationBaselineUseful(rgba, baseline) ? baseline : null;
  if (changed) {
    src = differenceImage(rgba, baseline);
    changed = null;
  }
  const pools = markers.map(marker => detectPinkBlobs(src, width, height, calibrationBlobOptions(marker, changed)));
  const used = [];
  const centers = new Array(markers.length);
  for (let i = 0; i < markers.length; i++) {
    const quad = pools[i].filter(blob => inMarkerQuadrant(blob, markers[i], width, height));
    const pick = claimCalibrationBlob(quad, markers[i], width, height, used);
    if (!pick) continue;
    used.push(pick);
    centers[i] = {x: pick.x, y: pick.y};
  }
  for (let i = 0; i < markers.length; i++) {
    if (centers[i]) continue;
    const pick = claimCalibrationBlob(pools[i], markers[i], width, height, used);
    if (!pick) {
      const blobs = chromaBlobs(src, width, height, null);
      if (blobs.some(blob => !blob)) return null;
      return blobs.map(blob => ({x: blob.x, y: blob.y}));
    }
    used.push(pick);
    centers[i] = {x: pick.x, y: pick.y};
  }
  return centers;
}

function quadEdges(pts) {
  return [0, 1, 2, 3].map(i => {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    return {x: b.x - a.x, y: b.y - a.y};
  });
}

// [TL, TR, BR, BL]. A wall seen from a phone can land outside the frame after
// the inset markers are extended to the stage corners, so the box is loose.
// Bowties still fail the corner order and the left-turn test.
// Pass {normalized: false} for raw pixel centers, which are checked for order and convexity only.
export const ALIGN_MIN_AREA = 0.02;
export const ALIGN_MIN_EDGE = 0.08;
export const BRIGHT_MIN_LIT = 0.015;
export const ALIGN_DARK_MAX_SKEW = 0.36;
export const ALIGN_SMALL_SCREEN_AREA = 0.2;
export function quadArea(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return 0;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = point(quad[i]);
    const b = point(quad[(i + 1) % 4]);
    if (!a || !b) return 0;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function isValidAlignmentQuad(quad, {
  minArea = ALIGN_MIN_AREA,
  maxArea = 3.5,
  minEdge = 0.06,
  minOppositeRatio = 0.18,
  maxOppositeRatio = 5.5,
  normalized = true,
  // Stage corners are extrapolated from the inset align circles, so a true
  // stage corner can sit a little past the camera frame. Edge fits pass 0.02.
  slack = 0.15
} = {}) {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  const pts = [];
  for (const corner of quad) {
    const p = point(corner);
    if (!p) return false;
    // Keep the quad inside the camera frame. ±0.08 still let a BR corner
    // land at x=1.05 off the right edge of the projector; ±0.02 is enough
    // for sub-pixel border fits without accepting extrapolations.
    if (normalized && (p.x < -slack || p.x > 1 + slack || p.y < -slack || p.y > 1 + slack)) return false;
    pts.push(p);
  }
  const [tl, tr, br, bl] = pts;
  if (!(tl.x < tr.x && bl.x < br.x && tl.y < bl.y && tr.y < br.y)) return false;
  const edges = quadEdges(pts);
  for (let i = 0; i < 4; i++) {
    const a = edges[i];
    const b = edges[(i + 1) % 4];
    if (!(a.x * b.y - a.y * b.x > 0)) return false;
  }
  if (!normalized) return true;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  const area = 0.5 * sum;
  if (!(area >= minArea && area <= maxArea)) return false;
  const lengths = edges.map(edge => Math.hypot(edge.x, edge.y));
  if (lengths.some(length => !(length >= minEdge))) return false;
  const topOverBottom = lengths[0] / lengths[2];
  const rightOverLeft = lengths[1] / lengths[3];
  return topOverBottom >= minOppositeRatio && topOverBottom <= maxOppositeRatio
    && rightOverLeft >= minOppositeRatio && rightOverLeft <= maxOppositeRatio;
}


// Why a candidate wall quad is refused. Used by align + border lock so the
// phone says the real reason instead of silently keeping a skewed trap.
// Why a candidate wall quad is refused. Only genuinely degenerate quads are
// refused (missing corners, non-convex, out of frame, wildly skewed). Browser
// chrome / lit-area hints are warnings only: on Nov 9 3:14 PM the chrome check
// refused TJ's fullscreen Safari align (false positive), and the tight area /
// opposite-edge bars refused his normal quad.
export function explainAlignmentQuad(quad, {
  minArea,
  maxArea,
  minEdge,
  minOppositeRatio,
  maxOppositeRatio,
  maxSkew = 0.24, // TJ's rig quads measure 0.02-0.20; the 2:48 PM address-bar quad was 0.26
  lit = null,
  chrome = null
} = {}) {
  if (!Array.isArray(quad) || quad.length !== 4) return {ok: false, reason: 'Align needs four corners.', warning: ''};
  const pts = quad.map(point).filter(Boolean);
  if (pts.length !== 4) return {ok: false, reason: 'Align refused: a corner is missing.', warning: ''};
  if (!isValidAlignmentQuad(quad)) return {ok: false, reason: 'Align refused: corners are not a convex wall quad.', warning: ''};
  const opts = {};
  if (minArea != null) opts.minArea = minArea;
  if (maxArea != null) opts.maxArea = maxArea;
  if (minEdge != null) opts.minEdge = minEdge;
  if (minOppositeRatio != null) opts.minOppositeRatio = minOppositeRatio;
  if (maxOppositeRatio != null) opts.maxOppositeRatio = maxOppositeRatio;
  if (Object.keys(opts).length && !isValidAlignmentQuad(quad, opts)) {
    return {ok: false, reason: 'Align refused: the quad is too small or too skewed to be the lit stage.', warning: ''};
  }
  const [tl, tr, br, bl] = pts;
  const norm = (v) => {
    const L = Math.hypot(v.x, v.y) || 1;
    return {x: v.x / L, y: v.y / L};
  };
  const tN = norm({x: tr.x - tl.x, y: tr.y - tl.y});
  const bN = norm({x: br.x - bl.x, y: br.y - bl.y});
  const lN = norm({x: bl.x - tl.x, y: bl.y - tl.y});
  const rN = norm({x: br.x - tr.x, y: br.y - tr.y});
  const topBotSkew = Math.hypot(tN.x - bN.x, tN.y - bN.y);
  const leftRightSkew = Math.hypot(lN.x - rN.x, lN.y - rN.y);
  if (topBotSkew > maxSkew || leftRightSkew > maxSkew) {
    return {ok: false, reason: 'Align refused: opposite edges are wildly out of parallel (' + topBotSkew.toFixed(2) + '/' + leftRightSkew.toFixed(2) + '). If a corner is off camera, widen the camera view, or drag the corners by hand.', warning: '', skew: [topBotSkew, leftRightSkew]};
  }
  let warning = '';
  if (chrome && chrome.present) {
    warning = 'Tip: a browser toolbar may be showing on the projection. Hide it if you can.';
  } else if (lit && Number.isFinite(+lit.minX)) {
    const bw = +lit.maxX - +lit.minX;
    const bh = +lit.maxY - +lit.minY;
    if (bw > 0.15 && bh > 0.15) {
      const qx0 = Math.min(tl.x, bl.x);
      const qx1 = Math.max(tr.x, br.x);
      const qy0 = Math.min(tl.y, tr.y);
      const qy1 = Math.max(bl.y, br.y);
      const overlapW = Math.max(0, Math.min(qx1, +lit.maxX) - Math.max(qx0, +lit.minX));
      const overlapH = Math.max(0, Math.min(qy1, +lit.maxY) - Math.max(qy0, +lit.minY));
      if ((overlapW * overlapH) / Math.max(1e-6, bw * bh) < 0.55) warning = 'Tip: the corners cover only part of the lit area.';
    }
  }
  return {ok: true, reason: '', warning, skew: [topBotSkew, leftRightSkew]};
}

// Lit-room guard: aspect near the projector stage, angles sane, and (when
// known) close to the last good quad. Fail with a clear "too bright" reason
// instead of applying a skewed trapezoid (TJ 4:42–4:43 PM).
export function plausibleAlignQuad(quad, {
  previous = null,
  maxSkew = 0.24,
  minAspect = 1.15,
  maxAspect = 2.35,
  maxCornerShift = 0.18,
  ambientHot = false,
  videoAspect = 16 / 9
} = {}) {
  // Far/angled camera (TJ 6:31 PM): the projected screen can be ~10-30% of
  // the frame. Allow small quads; geometry (convexity, aspect, skew) still guards.
  const explained = explainAlignmentQuad(quad, {maxSkew, minArea: ALIGN_MIN_AREA, maxArea: 1.35, minEdge: ALIGN_MIN_EDGE});
  if (!explained.ok) {
    const reason = ambientHot
      ? 'Align failed: too bright — corner markers washed out. Dim the room lights and Align again.'
      : (explained.reason || 'Align refused: bad wall quad.');
    return {ok: false, reason, previous: previous || null};
  }
  const pts = quad.map(point);
  const [tl, tr, br, bl] = pts;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bot = Math.hypot(br.x - bl.x, br.y - bl.y);
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const right = Math.hypot(br.x - tr.x, br.y - tr.y);
  const width = (top + bot) / 2;
  const height = (left + right) / 2;
  // Normalized camera corners → pixel aspect via the phone frame (~16:9).
  const pxAspect = Number.isFinite(+videoAspect) && +videoAspect > 0 ? +videoAspect : (16 / 9);
  const aspect = height > 1e-6 ? (width * pxAspect) / height : 0;
  if (!(aspect >= minAspect && aspect <= maxAspect)) {
    return {
      ok: false,
      reason: ambientHot
        ? 'Align failed: too bright — the quad aspect is implausible under ambient light. Dim the room and Align again.'
        : 'Align refused: quad aspect ' + aspect.toFixed(2) + ' is not a projector stage.',
      previous: previous || null
    };
  }
  // Bezel snap: top edge past the camera top, or a clearly clipped tall trap
  // under ambient light. Inset-circle extrapolation can legitimately land near 0.
  const topY = Math.min(tl.y, tr.y);
  const botY = Math.max(bl.y, br.y);
  if (topY < -0.02 || (ambientHot && topY < 0.01 && botY < 0.88 && aspect >= 1.9)) {
    return {
      ok: false,
      reason: ambientHot
        ? 'Align failed: too bright — top corners locked onto the screen border. Dim the room and Align again.'
        : 'Align refused: top edge sits on the camera border (bezel?).',
      previous: previous || null
    };
  }
  if (previous && previous.length === 4 && isValidAlignmentQuad(previous)) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const a = point(previous[i]);
      const b = pts[i];
      if (!a || !b) continue;
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (worst > maxCornerShift) {
      return {
        ok: false,
        reason: ambientHot
          ? 'Align failed: too bright — new corners jumped too far from the last good Align. Dim the room and try again.'
          : 'Align refused: corners jumped ' + worst.toFixed(2) + ' from the last good Align.',
        previous
      };
    }
  }
  return {ok: true, reason: '', warning: explained.warning || '', previous: previous || null};
}

// Bounding box of the bright projected patch in normalized camera coords.
export function litRegionBounds(rgba, width, height, threshold = 110) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || !(w > 0) || !(h > 0)) return null;
  let minX = w, minY = h, maxX = 0, maxY = 0, n = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      if (lum < threshold) continue;
      n++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (n < (w * h) * 0.02) return null;
  return {minX: minX / w, minY: minY / h, maxX: maxX / w, maxY: maxY / h, count: n};
}

// A bright white toolbar/URL strip inside the lit patch means the phone is
// not fullscreen — align will lock onto the chrome instead of the stage.
export function detectProjectedBrowserChrome(rgba, width, height, lit = null) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || !(w > 8) || !(h > 8)) return {present: false};
  const bounds = lit || litRegionBounds(rgba, w, h, 90);
  if (!bounds) return {present: false};
  const litH = Math.max(1, (bounds.maxY - bounds.minY) * h);
  const y0 = Math.max(0, Math.floor(bounds.minY * h));
  const y1 = Math.min(h - 1, Math.floor(y0 + Math.max(4, litH * 0.08)));
  const mid0 = Math.floor(bounds.minY * h + litH * 0.35);
  const mid1 = Math.floor(bounds.minY * h + litH * 0.65);
  const x0 = Math.max(0, Math.floor(bounds.minX * w));
  const x1 = Math.min(w - 1, Math.floor(bounds.maxX * w));
  if (x1 - x0 < 8 || y1 - y0 < 2 || mid1 <= mid0) return {present: false};
  const avg = (ya, yb) => {
    let sum = 0, n = 0;
    for (let y = ya; y <= yb; y++) {
      for (let x = x0; x <= x1; x += 2) {
        const i = (y * w + x) * 4;
        sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  const top = avg(y0, y1);
  const mid = avg(mid0, mid1);
  // Safari/Chrome toolbars are near-white and much brighter than stage content.
  if (!(top > 190 && top - mid > 45)) return {present: false, top, mid};
  return {
    present: true,
    top,
    mid,
    reason: 'Browser chrome (URL/toolbar) is visible in the projection'
  };
}

export function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (settings.corners == null) return settings;
  if (isValidAlignmentQuad(settings.corners)) return settings;
  return {...settings, corners: DEFAULT_QUAD.map(p => ({x: p.x, y: p.y}))};
}

// Marker centers in video pixels → normalized images of the four stage corners.
export function cornersFromMarkerCenters(centers, videoWidth, videoHeight, markers = CALIBRATION_MARKERS) {
  if (!centers || centers.length !== 4 || !(videoWidth > 0) || !(videoHeight > 0)) return null;
  const src = [];
  const dst = [];
  for (let i = 0; i < 4; i++) {
    const c = point(centers[i]);
    const m = markers[i];
    if (!c || !m) return null;
    src.push(c);
    dst.push({x: m.x * CANVAS_W, y: m.y * CANVAS_H});
  }
  if (!isValidAlignmentQuad(src, {normalized: false})) return null;
  const inverse = solveHomography(dst, src);
  if (!inverse) return null;
  const corners = [];
  for (const dest of PROJECTION_CORNERS) {
    const hit = applyHomography(inverse, dest.x, dest.y);
    if (!hit) return null;
    corners.push({x: hit.x / videoWidth, y: hit.y / videoHeight});
  }
  if (!isValidAlignmentQuad(corners)) return null;
  return corners;
}

export function quadsAgree(a, b, tolerance = 0.035) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const pa = point(a[i]);
    const pb = point(b[i]);
    if (!pa || !pb) return false;
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > tolerance) return false;
  }
  return true;
}

// One camera frame to a homography quad. Centers are on the detect grid;
// scale maps them into video pixels before the corners are normalized.
// Coarse-to-fine (TJ 6:31 PM, far/angled camera): crop the bright-screen ROI
// and upsample it so small, distant align squares are found with quadrants
// relative to the screen, not the camera frame. Returns detect-px centers.
export const ALIGN_ROI_UPSCALE_BELOW = 0.55; // ROI width fraction that triggers 2x
export function cropUpscale(rgba, width, height, roi, factor) {
  const x0 = Math.max(0, Math.floor(roi.x0 * width));
  const y0 = Math.max(0, Math.floor(roi.y0 * height));
  const x1 = Math.min(width, Math.ceil(roi.x1 * width));
  const y1 = Math.min(height, Math.ceil(roi.y1 * height));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 8 || ch < 8) return null;
  const f = Math.max(1, factor | 0);
  const w = cw * f;
  const h = ch * f;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, y0 + ((y + 0.5) / f - 0.5));
    const iy = Math.max(y0, Math.floor(sy));
    const iy1 = Math.min(y1 - 1, iy + 1);
    const fy = Math.max(0, sy - iy);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, x0 + ((x + 0.5) / f - 0.5));
      const ix = Math.max(x0, Math.floor(sx));
      const ix1 = Math.min(x1 - 1, ix + 1);
      const fx = Math.max(0, sx - ix);
      const a = (iy * width + ix) * 4, b = (iy * width + ix1) * 4, c = (iy1 * width + ix) * 4, d = (iy1 * width + ix1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = rgba[a + k] + (rgba[b + k] - rgba[a + k]) * fx;
        const bot = rgba[c + k] + (rgba[d + k] - rgba[c + k]) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return {data: out, width: w, height: h, x0, y0, factor: f};
}

export function roiFromQuad(corners, pad = 0.12) {
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const pts = corners.map(point).filter(Boolean);
  if (pts.length !== 4) return null;
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (!(w > 0.03 && h > 0.03)) return null;
  return {
    x0: Math.max(0, Math.min(...xs) - w * pad),
    y0: Math.max(0, Math.min(...ys) - h * pad),
    x1: Math.min(1, Math.max(...xs) + w * pad),
    y1: Math.min(1, Math.max(...ys) + h * pad)
  };
}

function readCalibrationRoi(frame, baseline, roi) {
  const big = (roi.x1 - roi.x0) >= ALIGN_ROI_UPSCALE_BELOW;
  const f = big ? 1 : 2;
  const crop = cropUpscale(frame.data, frame.width, frame.height, roi, f);
  if (!crop) return null;
  const base = baseline && baseline.length === frame.data.length ? cropUpscale(baseline, frame.width, frame.height, roi, f) : null;
  let read = readCalibration(crop.data, crop.width, crop.height, undefined, base ? base.data : null);
  if (!read.centers && base) read = readCalibration(crop.data, crop.width, crop.height, undefined, null);
  const back = p => (p ? {x: crop.x0 + p.x / f, y: crop.y0 + p.y / f} : p);
  return {
    centers: read.centers ? read.centers.map(back) : null,
    found: read.found,
    reason: read.reason,
    marks: (read.marks || []).map(m => (m ? {...m, ...back(m)} : m))
  };
}

export function alignFromFrame(frame, baseline, options = {}) {
  const names = ['1 red', '2 teal', '3 blue', '4 yellow'];
  const blank = {corners: null, found: [false, false, false, false], reason: 'No camera frame.', marks: []};
  if (!frame || !frame.data || !(frame.width > 0) || !(frame.height > 0)) return blank;
  let read = null;
  // Fine pass inside the lit screen first when the screen is a small part of
  // the frame; the full-frame pass (close range) is unchanged otherwise.
  const roi = options && options.roi;
  const smallRoi = roi && (roi.x1 - roi.x0) * (roi.y1 - roi.y0) < 0.5;
  if (smallRoi) {
    const fine = readCalibrationRoi(frame, baseline, roi);
    if (fine && fine.centers) read = fine;
  }
  if (!read) {
    read = readCalibration(frame.data, frame.width, frame.height, undefined, baseline);
    if (!read.centers && baseline) read = readCalibration(frame.data, frame.width, frame.height, undefined, null);
  }
  const scale = frame.scale || {scaleX: 1, scaleY: 1};
  const videoW = frame.videoWidth > 0 ? frame.videoWidth : frame.width;
  const videoH = frame.videoHeight > 0 ? frame.videoHeight : frame.height;
  const marks = [];
  for (let i = 0; i < 4; i++) {
    const hit = read.marks && read.marks[i];
    if (!hit) {
      marks.push(null);
      continue;
    }
    const video = videoPointFromDetect(hit.x, hit.y, scale);
    marks.push({x: video.x / videoW, y: video.y / videoH, found: true, name: names[i]});
  }
  if (!read.centers) return {corners: null, found: read.found, reason: read.reason, marks};
  const videoCenters = read.centers.map(center => videoPointFromDetect(center.x, center.y, scale));
  const corners = cornersFromMarkerCenters(videoCenters, videoW, videoH);
  if (!corners) {
    return {
      corners: null,
      found: [true, true, true, true],
      reason: 'All four corners are in frame, but the shape is not a usable wall. Drag the corners.',
      marks
    };
  }
  return {corners, found: [true, true, true, true], reason: '', marks};
}

function fitAxis(samples, horizontal) {
  if (!samples || samples.length < 4) return null;
  const solve = (pts) => {
    let s1 = 0;
    let s2 = 0;
    let s11 = 0;
    let s12 = 0;
    for (const p of pts) {
      const u = horizontal ? p.x : p.y;
      const v = horizontal ? p.y : p.x;
      s1 += u;
      s2 += v;
      s11 += u * u;
      s12 += u * v;
    }
    const den = pts.length * s11 - s1 * s1;
    if (Math.abs(den) < 1e-6) return {a: 0, b: s2 / pts.length};
    const a = (pts.length * s12 - s1 * s2) / den;
    return {a, b: (s2 - a * s1) / pts.length};
  };
  let line = solve(samples);
  const residual = samples.map(p => Math.abs((horizontal ? p.y : p.x) - (line.a * (horizontal ? p.x : p.y) + line.b)));
  const ordered = residual.slice().sort((p, q) => p - q);
  const med = ordered[ordered.length >> 1] || 0;
  const kept = samples.filter((p, index) => residual[index] <= Math.max(2.5, med * 2.5));
  if (kept.length >= 4) line = solve(kept);
  if (Math.abs(line.a) > 1.6) return null;
  return line;
}

function intersectEdges(horizontal, vertical) {
  const denom = 1 - vertical.a * horizontal.a;
  if (Math.abs(denom) < 1e-8) return null;
  const x = (vertical.a * horizontal.b + vertical.b) / denom;
  const y = horizontal.a * x + horizontal.b;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {x, y};
}

function maskAt(mask, width, height, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return false;
  return mask[iy * width + ix] === 1;
}

// Black frame against white frame. The pixels that get brighter are the
// projector. Edge lines are fit to that region and extended, so a corner
// that sits on or just past the camera border still comes from the visible
// edges instead of being pulled inside the frame.
export function fitBrightQuad(dark, bright, width, height) {
  const w = width | 0;
  const h = height | 0;
  const fail = (reason) => ({corners: null, found: [false, false, false, false], reason, ok: false, marks: [], error: 1});
  if (!dark || !bright || dark.length < w * h * 4 || bright.length < w * h * 4 || w < 8 || h < 8) return fail('No camera frame.');
  const count = w * h;
  const mask = new Uint8Array(count);
  let lit = 0;
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const delta = (bright[p] - dark[p]) + (bright[p + 1] - dark[p + 1]) + (bright[p + 2] - dark[p + 2]);
    if (delta > 80) {
      mask[i] = 1;
      lit++;
    }
  }
  if (lit < count * BRIGHT_MIN_LIT) return fail('The white flash did not light a screen. Aim the camera at the projector.');
  if (lit > count * 0.97) return fail('The whole camera frame flashed. The screen edge is not visible.');
  const top = [];
  const bottom = [];
  const left = [];
  const right = [];
  let clippedTop = 0;
  let clippedBottom = 0;
  let clippedLeft = 0;
  let clippedRight = 0;
  const stepX = Math.max(1, Math.floor(w / 96));
  const stepY = Math.max(1, Math.floor(h / 72));
  for (let x = 0; x < w; x += stepX) {
    let minY = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      if (!mask[y * w + x]) continue;
      if (minY < 0) minY = y;
      maxY = y;
    }
    if (minY < 0) continue;
    if (minY === 0) clippedTop++;
    else if (minY < h * 0.75) top.push({x, y: minY});
    if (maxY === h - 1) clippedBottom++;
    else if (maxY > h * 0.25) bottom.push({x, y: maxY});
  }
  for (let y = 0; y < h; y += stepY) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (minX < 0) minX = x;
      maxX = x;
    }
    if (minX < 0) continue;
    if (minX === 0) clippedLeft++;
    else if (minX < w * 0.75) left.push({x: minX, y});
    if (maxX === w - 1) clippedRight++;
    else if (maxX > w * 0.25) right.push({x: maxX, y});
  }
  const columns = Math.ceil(w / stepX);
  const rows = Math.ceil(h / stepY);
  const topLine = fitAxis(top, true) || (clippedTop > columns * 0.45 ? {a: 0, b: 0} : null);
  const bottomLine = fitAxis(bottom, true) || (clippedBottom > columns * 0.45 ? {a: 0, b: h - 1} : null);
  const leftLine = fitAxis(left, false) || (clippedLeft > rows * 0.45 ? {a: 0, b: 0} : null);
  const rightLine = fitAxis(right, false) || (clippedRight > rows * 0.45 ? {a: 0, b: w - 1} : null);
  if (!topLine || !bottomLine || !leftLine || !rightLine) return fail('A screen edge is missing. Drag the corners.');
  const px = [
    intersectEdges(topLine, leftLine),
    intersectEdges(topLine, rightLine),
    intersectEdges(bottomLine, rightLine),
    intersectEdges(bottomLine, leftLine)
  ];
  if (px.some(p => !p)) return fail('The screen edges do not meet. Drag the corners.');
  const corners = px.map(p => ({x: p.x / w, y: p.y / h}));
  if (!isValidAlignmentQuad(corners, {minArea: ALIGN_MIN_AREA, maxArea: 1.35, minEdge: ALIGN_MIN_EDGE, slack: 0.02})) {
    return {corners: null, found: px.map(p => p.x >= -0.02 * w && p.y >= -0.02 * h && p.x <= 1.02 * w && p.y <= 1.02 * h), reason: 'The fitted wall is skewed. Drag the corners onto the bright screen.', ok: false, marks: corners.map((corner, index) => ({...corner, found: true, name: String(index + 1)})), error: 1};
  }
  for (const corner of corners) {
    if (corner.x < -0.12 || corner.x > 1.12 || corner.y < -0.12 || corner.y > 1.12) {
      return {corners: null, found: [true, true, true, true], reason: 'A corner landed outside the camera. Drag it back to the screen.', ok: false, marks: corners, error: 1};
    }
  }
  const image = px;
  const judged = judgeBrightQuad(mask, w, h, corners, image);
  const coverage = judged.coverage;
  const fill = judged.fill;
  const insetHits = judged.insetHits;
  const error = judged.error;
  const found = corners.map(corner => corner.x >= -0.02 && corner.x <= 1.02 && corner.y >= -0.02 && corner.y <= 1.02);
  const marks = corners.map((corner, index) => ({x: corner.x, y: corner.y, found: found[index], name: String(index + 1)}));
  const pct = Math.round(coverage * 100);
  const hold = Math.round(fill * 100);
  const numbers = 'coverage ' + pct + '% containment ' + hold + '% insets ' + insetHits + '/4';
  if (!(coverage >= 0.55 && fill >= 0.45 && insetHits >= 3)) {
    return {corners: null, found, reason: 'White phase: the outline does not match the bright screen (' + numbers + ').', ok: false, marks, error, coverage, fill, insetHits};
  }
  const warning = coverage < 0.8 || fill < 0.7 ? 'Mask is uneven (' + numbers + ').' : '';
  return {corners, found, reason: warning, ok: true, marks, error, coverage, fill, insetHits, warning};
}

// The pull-down screen's black border is a dark rectangle around a bright
// interior. The inner edge of that border is the projected stage.
export function fitScreenBorder(rgba, width, height) {
  const w = width | 0;
  const h = height | 0;
  const fail = (reason) => ({corners: null, ok: false, reason, found: [false, false, false, false]});
  if (!rgba || rgba.length < w * h * 4 || w < 16 || h < 16) return fail('Screen border: no camera frame.');
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  const brightAt = (x, y) => luma[y * w + x] > 120;
  const top = [];
  const bottom = [];
  const left = [];
  const right = [];
  const stepX = Math.max(1, Math.floor(w / 80));
  const stepY = Math.max(1, Math.floor(h / 60));
  for (let x = 0; x < w; x += stepX) {
    let run = 0;
    let best = 0;
    let bestY = 0;
    let y0 = 0;
    for (let y = 0; y <= h; y++) {
      const on = y < h && brightAt(x, y);
      if (on) {
        if (!run) y0 = y;
        run++;
      } else if (run) {
        if (run > best) { best = run; bestY = y0; }
        run = 0;
      }
    }
    if (best < h * 0.25) continue;
    const y1 = bestY + best - 1;
    if (bestY > 0) top.push({x, y: bestY});
    if (y1 < h - 1) bottom.push({x, y: y1});
  }
  for (let y = 0; y < h; y += stepY) {
    let run = 0;
    let best = 0;
    let bestX = 0;
    let x0 = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && brightAt(x, y);
      if (on) {
        if (!run) x0 = x;
        run++;
      } else if (run) {
        if (run > best) { best = run; bestX = x0; }
        run = 0;
      }
    }
    if (best < w * 0.25) continue;
    const x1 = bestX + best - 1;
    if (bestX > 0) left.push({x: bestX, y});
    if (x1 < w - 1) right.push({x: x1, y});
  }
  const topLine = fitAxis(top, true);
  const bottomLine = fitAxis(bottom, true);
  const leftLine = fitAxis(left, false);
  const rightLine = fitAxis(right, false);
  if (!topLine || !bottomLine || !leftLine || !rightLine) return fail('Screen border: a dark edge is missing.');
  const px = [
    intersectEdges(topLine, leftLine),
    intersectEdges(topLine, rightLine),
    intersectEdges(bottomLine, rightLine),
    intersectEdges(bottomLine, leftLine)
  ];
  if (px.some(p => !p)) return fail('Screen border: the edges do not meet.');
  const corners = px.map(p => ({x: p.x / w, y: p.y / h}));
  const lit = litRegionBounds(rgba, w, h);
  const chrome = detectProjectedBrowserChrome(rgba, w, h, lit);
  const explained = explainAlignmentQuad(corners, {lit, chrome, minArea: 0.2, maxArea: 1.2, minEdge: 0.25});
  if (!explained.ok) return fail(explained.reason || 'Screen border: the frame is not a usable rectangle.');
  for (const corner of corners) {
    if (corner.x < -0.08 || corner.x > 1.08 || corner.y < -0.08 || corner.y > 1.08) return fail('Screen border: a corner left the camera.');
  }
  return {corners, ok: true, reason: '', found: [true, true, true, true], marks: corners.map((corner, index) => ({...corner, found: true, name: String(index + 1)})), chrome};
}

// Widest stage the aspect guard accepts for a projected viewport of this
// shape. iPhone landscape Safari is ~2.5:1 (TJ 8:26 PM: the correct marker
// quad measured 2.50-2.61 and was refused against the fixed 2.35 cap, so
// Align fell through to a whole-screen border/bright quad ~65-85 px off).
export function alignMaxAspect(stageAspect) {
  const a = +stageAspect;
  if (!(Number.isFinite(a) && a > 0)) return 2.35;
  return Math.max(2.35, Math.min(4, a * 1.25));
}

export function chooseAlignQuad({markers, border, bright, previous = null, ambientHot = false, videoAspect = 16 / 9, stageAspect = null, locked = false} = {}) {
  const maxAspect = alignMaxAspect(stageAspect);
  const coverage = bright && Number.isFinite(+bright.coverage) ? Math.round(bright.coverage * 100) : null;
  const fill = bright && Number.isFinite(+bright.fill) ? Math.round(bright.fill * 100) : null;
  const maskNote = coverage == null ? '' : ' Mask coverage ' + coverage + '%, containment ' + fill + '%.';
  const tryQuad = (corners, source, warning = '') => {
    if (!corners || !isValidAlignmentQuad(corners, source === 'markers' ? {} : {slack: 0.02})) return null;
    // The last-good corner-jump guard is for washed-out lit rooms only. In a
    // dark room it made a bad quad sticky: every fresh, correct Align was
    // refused as a "jump" and the old quad stayed (TJ 6:07 PM).
    // Angled far camera (keystone) in a dark room: allow more skew; lit rooms
    // keep the strict 0.24 guard against bezel/address-bar traps.
    const check = plausibleAlignQuad(corners, {previous: ambientHot ? previous : null, ambientHot, videoAspect, maxAspect, maxSkew: ambientHot ? 0.24 : ALIGN_DARK_MAX_SKEW});
    if (!check.ok) return {reject: check};
    return {corners, source, ok: true, warning: (warning || check.warning || '').trim(), reason: ''};
  };
  const hasCorners = !!(markers && markers.corners && isValidAlignmentQuad(markers.corners));
  const foundList = markers && Array.isArray(markers.found) ? markers.found : null;
  const markersComplete = hasCorners && (!foundList || (foundList.length === 4 && foundList.every(Boolean)));
  let lastReject = null;
  // Far camera (small screen): tiny align squares can lock onto grid lines or
  // labels. When the white-flash edge fit is good and the marker quad
  // disagrees with it, trust the edge fit (TJ 6:31 PM).
  const brightSmall = !!(bright && bright.ok && bright.corners && quadArea(bright.corners) < ALIGN_SMALL_SCREEN_AREA);
  if (markersComplete && brightSmall && !quadsAgree(markers.corners, bright.corners, 0.025)) {
    const hit = tryQuad(bright.corners, 'bright', 'far screen: edge fit preferred over small markers');
    if (hit && hit.ok) return hit;
  }
  if (markersComplete) {
    const hit = tryQuad(markers.corners, 'markers', maskNote.trim());
    if (hit && hit.ok) return hit;
    if (hit && hit.reject) lastReject = hit.reject;
  }
  if (border && border.ok && border.corners) {
    const hit = tryQuad(border.corners, 'border');
    if (hit && hit.ok) return hit;
    if (hit && hit.reject) lastReject = hit.reject;
  }
  if (bright && bright.corners && bright.ok) {
    const hit = tryQuad(bright.corners, 'bright', bright.warning || '');
    if (hit && hit.ok) return hit;
    if (hit && hit.reject) lastReject = hit.reject;
  }
  if (lastReject) {
    if (locked && previous && isValidAlignmentQuad(previous) && /aspect/i.test(lastReject.reason || '')) {
      return {
        corners: previous.map(p => ({x: +p.x, y: +p.y})),
        source: 'locked',
        ok: true,
        warning: 'Kept the locked corners. ' + lastReject.reason,
        reason: '',
        previous
      };
    }
    return {
      corners: null,
      source: 'none',
      ok: false,
      warning: '',
      reason: lastReject.reason,
      previous: lastReject.previous || previous || null
    };
  }
  const incomplete = markers && Array.isArray(markers.found) && markers.found.some(Boolean) && !markers.found.every(Boolean);
  const reason = incomplete
    ? ((markers && markers.reason) || 'Align failed: not all four corner markers were found. Retry Align projector.')
    : ((markers && markers.reason) || (border && border.reason) || (bright && bright.reason) || 'Align failed.');
  return {corners: null, source: 'none', ok: false, warning: '', reason: reason + maskNote, previous: previous || null};
}

function pointInConvex(x, y, pts) {
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross < -0.5) return false;
  }
  return true;
}

function judgeBrightQuad(mask, w, h, corners, image) {
  let maskInside = 0;
  let maskSeen = 0;
  let quadSamples = 0;
  let quadLit = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const inside = pointInConvex(x, y, image);
      const on = mask[y * w + x] === 1;
      if (on) {
        maskSeen++;
        if (inside) maskInside++;
      }
      if (inside) {
        quadSamples++;
        if (on) quadLit++;
      }
    }
  }
  const coverage = maskSeen ? maskInside / maskSeen : 0;
  const fill = quadSamples ? quadLit / quadSamples : 0;
  const stageToImage = solveHomography(PROJECTION_CORNERS, image.map(p => ({x: p.x, y: p.y})));
  const insets = [
    {x: CANVAS_W * 0.1, y: CANVAS_H * 0.1},
    {x: CANVAS_W * 0.9, y: CANVAS_H * 0.1},
    {x: CANVAS_W * 0.9, y: CANVAS_H * 0.9},
    {x: CANVAS_W * 0.1, y: CANVAS_H * 0.9}
  ];
  let insetHits = 0;
  if (stageToImage) {
    for (const spot of insets) {
      const hit = applyHomography(stageToImage, spot.x, spot.y);
      if (hit && maskAt(mask, w, h, hit.x, hit.y)) insetHits++;
    }
  }
  const error = (1 - coverage) + (1 - fill) + (4 - insetHits) / 4;
  return {coverage, fill, insetHits, error, corners};
}

export function projectionRejectsSkew(dark, bright, width, height, corners) {
  const w = width | 0;
  const h = height | 0;
  const mask = new Uint8Array(w * h);
  if (!dark || !bright) return true;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const delta = (bright[p] - dark[p]) + (bright[p + 1] - dark[p + 1]) + (bright[p + 2] - dark[p + 2]);
    if (delta > 80) mask[i] = 1;
  }
  const image = corners.map(corner => ({x: corner.x * w, y: corner.y * h}));
  const judged = judgeBrightQuad(mask, w, h, corners, image);
  return !(judged.coverage >= 0.82 && judged.fill >= 0.72 && judged.insetHits === 4);
}

export function projectVideoPoint(H, x, y) {
  const p = applyHomography(H, x, y);
  if (!p) return null;
  return {
    x: Math.min(CANVAS_W, Math.max(0, p.x)),
    y: Math.min(CANVAS_H, Math.max(0, p.y))
  };
}

// Detect pixels sit on the downsampled grid. A 640×480 camera is read at
// 480×360. The homography is in video pixels, and each axis keeps its own
// scale so a rounded detect height cannot slide the dot off the sticker.
export function videoPointFromDetect(x, y, scale) {
  const sx = scale && Number.isFinite(+scale.scaleX) && +scale.scaleX > 0 ? +scale.scaleX : 1;
  const sy = scale && Number.isFinite(+scale.scaleY) && +scale.scaleY > 0 ? +scale.scaleY : 1;
  return {x: (x + 0.5) * sx, y: (y + 0.5) * sy};
}

export function frameStagePoint(x, y, width, height) {
  const dw = Math.max(1, width | 0);
  const dh = Math.max(1, height | 0);
  return {
    x: (x / Math.max(1, dw - 1)) * CANVAS_W,
    y: (y / Math.max(1, dh - 1)) * CANVAS_H
  };
}

// The blank scan places stickers with a plain frame map before the wall is aligned.
// The silhouette still needs that outline in stage pixels, not only after a homography.
export function stageMarkerFromDetect(blob, scale, homography) {
  if (!blob) return null;
  const dw = Math.max(1, (scale && scale.width) || 1);
  const dh = Math.max(1, (scale && scale.height) || 1);
  const stage = homography
    ? projectDetectPoint(homography, blob.x, blob.y, scale)
    : frameStagePoint(blob.x, blob.y, dw, dh);
  if (!stage) return null;
  const item = {x: stage.x, y: stage.y, kind: blob.kind === 'pink' ? 'pink' : 'sticker'};
  if (Number.isFinite(+blob.aspect)) item.aspect = +blob.aspect;
  if (Number.isFinite(+blob.elongation)) item.elongation = +blob.elongation;
  if (blob.contour) {
    const contour = homography
      ? projectContour(blob.contour.map(p => videoPointFromDetect(p.x, p.y, scale)), homography)
      : sanitizeContour(blob.contour.map(p => frameStagePoint(p.x, p.y, dw, dh)));
    if (contour) item.contour = contour;
  }
  const camH = Number.isFinite(+blob.h) ? +blob.h : (Number.isFinite(+blob.radius) ? +blob.radius * 2 : 0);
  if (homography && camH > 0) {
    const video = videoPointFromDetect(blob.x, blob.y, scale);
    const sy = scale && Number.isFinite(+scale.scaleY) && +scale.scaleY > 0 ? +scale.scaleY : 1;
    const projected = projectedStickerHeight(homography, video.x, video.y, camH * sy);
    if (projected > 0) item.projectedHeight = projected;
  }
  return item;
}

// Continuous-path stage point. The silhouette must be in stage pixels:
// ba093a6 attached the raw detect-pixel outline, so a latched sticker drew its
// silhouette in the wrong place instead of on the sticker.
export function continuousStagePoint(blob, scale, homography, at = null) {
  const mapped = stageMarkerFromDetect(blob, scale, homography);
  if (!mapped) return null;
  const stage = {x: at ? at.x : mapped.x, y: at ? at.y : mapped.y, kind: 'sticker'};
  if (mapped.contour) stage.contour = mapped.contour;
  return stage;
}

// Stage area (plus a 10% margin) used for the person mask and its floor median.
export function personStageInside(H, x, y, scale, margin = 0.1) {
  const video = videoPointFromDetect(x, y, scale);
  const at = applyHomography(H, video.x, video.y);
  const mx = CANVAS_W * margin;
  const my = CANVAS_H * margin;
  return !!(at && at.x >= -mx && at.y >= -my && at.x <= CANVAS_W + mx && at.y <= CANVAS_H + my);
}

export function projectDetectPoint(H, x, y, scale) {
  const video = videoPointFromDetect(x, y, scale);
  return projectVideoPoint(H, video.x, video.y);
}

export function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {h, s: max === 0 ? 0 : d / max, v: max};
}

function wrapHue(value, fallback) {
  const v = +value;
  if (!Number.isFinite(v)) return fallback;
  return ((v % 360) + 360) % 360;
}

export function blobSettings(options = {}) {
  return {
    hueCenter: wrapHue(options.hueCenter, PINK_HUE),
    hueTolerance: clamp(options.hueTolerance, 0, 180, DEFAULTS.hueTolerance),
    saturationSensitivity: clamp(options.saturationSensitivity, 0, 1, DEFAULTS.saturationSensitivity),
    minBlobSize: Math.round(clamp(options.minBlobSize, 1, 100000, DEFAULTS.minBlobSize)),
    valueFloor: Number.isFinite(+options.valueFloor) ? +options.valueFloor : PINK_VALUE_FLOOR,
    minSaturation: Number.isFinite(+options.minSaturation) ? clamp(+options.minSaturation, 0, 1, 0) : null,
    bg: options.bg && Number.isFinite(+options.bg.r) ? options.bg : null,
    baseline: options.baseline || null,
    homography: options.homography || null,
    scale: options.scale || null,
    exclude: Array.isArray(options.exclude) ? options.exclude : null,
    customSample: !!options.customSample,
    maxBlobSize: options.maxBlobSize === Infinity ? Infinity : (Number.isFinite(+options.maxBlobSize) ? +options.maxBlobSize : null),
    disablePinkHeuristics: options.disablePinkHeuristics === true,
    hueMin: Number.isFinite(options.hueMin) ? +options.hueMin : null,
    hueMax: Number.isFinite(options.hueMax) ? +options.hueMax : null,
    whiteCap: options.whiteCap && Number.isFinite(+options.whiteCap.v) && Number.isFinite(+options.whiteCap.s) ? {v: +options.whiteCap.v, s: +options.whiteCap.s} : null
  };
}

function playInside(x, y, settings) {
  if (!stageInside(x, y, settings)) return false;
  const video = videoPointFromDetect(x, y, settings.scale);
  const p = applyHomography(settings.homography, video.x, video.y);
  return !!p && stickerInPlay(p.x, p.y);
}

function stageInside(x, y, settings) {
  if (!settings.homography) return true;
  const video = videoPointFromDetect(x, y, settings.scale);
  const p = applyHomography(settings.homography, video.x, video.y);
  if (!p || p.x < 0 || p.y < 0 || p.x > CANVAS_W || p.y > CANVAS_H) return false;
  for (const rect of settings.exclude || []) {
    if (p.x >= rect.x && p.x < rect.x + rect.w && p.y >= rect.y && p.y < rect.y + rect.h) return false;
  }
  return true;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function pinkFamily(hueCenter) {
  return hueDistance(hueCenter, PINK_HUE) <= 70 || hueDistance(hueCenter, PINK_WB_HUE) <= 70;
}

// Median of a coarse grid. Channels are clamped to >= 32 so a black frame
// cannot divide the white balance. Returns null for an empty buffer.
export function frameBackground(rgba, width, height, step = 8, accept = null) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 1 || h < 1) return null;
  const rs = [];
  const gs = [];
  const bs = [];
  const jump = Math.max(1, step | 0);
  for (let y = 0; y < h; y += jump) {
    for (let x = 0; x < w; x += jump) {
      if (accept && !accept(x, y)) continue;
      const i = (y * w + x) * 4;
      if (i + 2 >= rgba.length) continue;
      rs.push(rgba[i]);
      gs.push(rgba[i + 1]);
      bs.push(rgba[i + 2]);
    }
  }
  if (!rs.length) return null;
  const mid = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
  return {r: Math.max(32, mid(rs)), g: Math.max(32, mid(gs)), b: Math.max(32, mid(bs))};
}

// White point is the screen median. Dividing by (channel / mean) keeps hue and
// saturation of r/rBg and puts brightness back on the camera scale.
function whiteBalance(r, g, b, bg) {
  const mean = (bg.r + bg.g + bg.b) / 3 || 1;
  return {
    r: r * mean / bg.r,
    g: g * mean / bg.g,
    b: b * mean / bg.b,
    rRatio: r / bg.r,
    gRatio: g / bg.g,
    bRatio: b / bg.b
  };
}

export function isPink(r, g, b, settings) {
  const hsv = rgbToHsv(r, g, b);
  const floor = Number.isFinite(settings.minSaturation) ? settings.minSaturation : saturationFloor(settings.saturationSensitivity);
  const center = settings.hueCenter;
  const valueFloor = Number.isFinite(settings.valueFloor) ? settings.valueFloor : VALUE_FLOOR;
  if (settings.disablePinkHeuristics || !pinkFamily(center)) {
    if (Number.isFinite(settings.hueMin) && Number.isFinite(settings.hueMax)) {
      const hue = hsv.h;
      const inside = settings.hueMin <= settings.hueMax
        ? hue >= settings.hueMin && hue <= settings.hueMax
        : hue >= settings.hueMin || hue <= settings.hueMax;
      if (settings.whiteCap && hsv.v >= settings.whiteCap.v && hsv.s < settings.whiteCap.s) return false;
      return inside && hsv.s >= floor && hsv.v >= valueFloor;
    }
    return hueDistance(hsv.h, center) <= settings.hueTolerance
      && hsv.s >= floor
      && hsv.v >= valueFloor;
  }
  const bg = settings.bg;
  if (bg && rgbToHsv(bg.r, bg.g, bg.b).s <= 0.42 && bg.r > 0 && bg.g > 0 && bg.b > 0) {
    const wb = whiteBalance(r, g, b, bg);
    if (settings.customSample) {
      const adapted = rgbToHsv(wb.r, wb.g, wb.b);
      return hueDistance(adapted.h, settings.hueCenter) <= settings.hueTolerance && adapted.s >= Math.min(floor, 0.12);
    }
    const thresh = greenAbsorption(settings.saturationSensitivity);
    if (wb.rRatio >= 1.08
      && (wb.rRatio - wb.gRatio) >= thresh
      && wb.rRatio >= wb.bRatio - 0.05) return true;
  }
  return hueDistance(hsv.h, center) <= settings.hueTolerance
    && hsv.s >= Math.max(floor, 0.28)
    && hsv.v >= PINK_VALUE_FLOOR
    && r >= b - 10
    && (r - g) >= 22;
}

// Connected components on an already-downscaled RGBA buffer.
export function detectPinkBlobs(rgba, width, height, options = {}) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 1 || h < 1 || rgba.length < w * h * 4) return [];
  const settings = blobSettings(options);
  const count = w * h;
  const mask = new Uint8Array(count);
  const baseline = settings.baseline && settings.baseline.length === rgba.length ? settings.baseline : null;
  const areaScale = areaScaleFor(w);
  const maxEq = settings.maxBlobSize != null ? settings.maxBlobSize : DEFAULTS.maxBlobSize;
  for (let i = 0, p = 0, y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++, p += 4) {
      if (settings.homography && !stageInside(x, y, settings)) continue;
      if (baseline) {
        const delta = Math.abs(rgba[p] - baseline[p]) + Math.abs(rgba[p + 1] - baseline[p + 1]) + Math.abs(rgba[p + 2] - baseline[p + 2]);
        if (delta < 36) continue;
      }
      if (isPink(rgba[p], rgba[p + 1], rgba[p + 2], settings)) mask[i] = 1;
    }
  }
  const seen = new Uint8Array(count);
  const qx = new Int32Array(count);
  const qy = new Int32Array(count);
  const blobs = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;
      seen[start] = 1;
      let sumX = 0;
      let sumY = 0;
      let area = 0;
      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;
        sumX += cx;
        sumY += cy;
        area++;
        const neighbors = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1];
        for (let k = 0; k < neighbors.length; k += 2) {
          const nx = neighbors[k];
          const ny = neighbors[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          qx[tail] = nx;
          qy[tail] = ny;
          tail++;
        }
      }
      const eq = area / areaScale;
      const minEq = minBlobEquivalent(settings.minBlobSize, w);
      if (eq >= minEq && eq <= maxEq) blobs.push({x: sumX / area, y: sumY / area, area, kind: 'pink'});
    }
  }
  blobs.sort((p, q) => q.area - p.area || p.x - q.x || p.y - q.y);
  return blobs;
}

// Frame-level pink scan. The screen median is the illuminant unless it is
// already a saturated color (a synthetic pink canvas), which is left raw.
export function detectPinkMarkers(rgba, width, height, options = {}) {
  const opts = {...options};
  if (!opts.disableWhiteBalance && !opts.bg) {
    const accept = opts.homography ? (x, y) => stageInside(x, y, opts) : null;
    const bg = frameBackground(rgba, width, height, 8, accept);
    if (bg && rgbToHsv(bg.r, bg.g, bg.b).s <= 0.42) opts.bg = bg;
  }
  return detectPinkBlobs(rgba, width, height, opts);
}

export const ECHO_W = 160;
export const ECHO_H = 100;
export const ECHO_HOLD_MS = 1200; // must exceed camera lag (~540 ms) + jitter so projected sims stay vetoed
// Soft bloom light survives the 160×100 echo downsample. A wider, dimmer
// neighborhood than the hard stroke veto, so an aura is not read as a sticker.
export const ECHO_BLOOM_LUM = 18;
export const ECHO_BLOOM_RADIUS = 5;
// Nov 9, 3:54 PM: TJ raised sticker sensitivity for a hard sticker and ~20
// projected-bloom spots latched. On lit (continuous) frames the slider tops
// out here; full range is for the white-flash Scan stickers frame, where no
// projection is on the floor. The bloom veto also reaches further as the
// slider rises.
export const CONTINUOUS_SENS_CAP = 0.6;
// Nov 9, 7:11 PM: the slider was dead above 0.6. Keep 0–0.5 as-is (the
// dark-room / latch tuning) and ease 0.5–1 into 0.5–0.6, so every step of
// the slider changes something while lit frames never exceed the safe cap.
export const CONTINUOUS_SENS_KNEE = 0.5;
export function continuousSensitivity(value) {
  const v = Math.min(1, Math.max(0, Number.isFinite(+value) ? +value : DEFAULTS.stickerSensitivity));
  if (v <= CONTINUOUS_SENS_KNEE) return v;
  if (v >= 1) return CONTINUOUS_SENS_CAP;
  return CONTINUOUS_SENS_KNEE + (v - CONTINUOUS_SENS_KNEE) * (CONTINUOUS_SENS_CAP - CONTINUOUS_SENS_KNEE) / (1 - CONTINUOUS_SENS_KNEE);
}
export function continuousVetoReach(value) {
  const v = Number.isFinite(+value) ? +value : DEFAULTS.stickerSensitivity;
  return 5 + Math.round(4 * Math.min(1, Math.max(0, (v - 0.5) / 0.5)));
}
// The floor grid is the only projected art a sticker may sit on: thin,
// blue-gray (rgba(145,150,180,.22) over the dark stage), never above ~70 lum
// even where lines cross. Every other lit cell (dancer blooms, latched dots,
// pulses, warm or saturated light, anything bright) is projected content and
// vetoes, static or not. Nov 9: aae7e41 vetoed the grid (no stickers);
// ebf3e94 let static blooms through (latched its own dots, 3:16 PM rig).
export const ECHO_GRID_MAX_LUM = 72;
export function echoGridLike(r, g, b) {
  return Math.abs(r - g) <= 12 && b >= g - 4 && b - g <= 40 && 0.299 * r + 0.587 * g + 0.114 * b <= ECHO_GRID_MAX_LUM;
}

export const ECHO_RIPPLE_MIN = 6;
export const ECHO_RIPPLE_REACH = 8;

// Energy on the ripple overlay canvas. That layer never carries the floor
// grid, so even a dim, low-chroma caustic is projected content. The camera
// sees these rings much brighter than the framebuffer (TJ 9:01 PM).
export function rippleEnergyByte(r, g, b, a = 255) {
  if ((a | 0) < 8) return 0;
  const lum = luminanceByte(r, g, b);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (lum < ECHO_RIPPLE_MIN && chroma < 8) return 0;
  return Math.max(lum, chroma);
}

export function findRippleLayer(stage) {
  const q = (root) => root && root.querySelector && root.querySelector('[data-ripple-layer]');
  const direct = q(stage && stage.parentElement) || (stage && stage.parentElement && stage.parentElement.id === 'nd-room-projector' ? q(stage.parentElement) : null);
  if (direct && direct.width > 0) return direct;
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('nd-room-projector');
  const fromHost = q(host);
  if (fromHost && fromHost.width > 0) return fromHost;
  const any = q(document);
  return any && any.width > 0 ? any : null;
}

export function createStageEcho() {
  const w = ECHO_W;
  const h = ECHO_H;
  const samples = [];
  const maxR = new Uint8Array(w * h);
  const maxG = new Uint8Array(w * h);
  const maxB = new Uint8Array(w * h);
  const maxLum = new Uint8Array(w * h);
  const maxRipple = new Uint8Array(w * h);
  let scratch = null;
  let ctx = null;
  // Projected content above the threshold that is not floor grid.
  function lit(i, threshold) {
    if (maxRipple[i] >= ECHO_RIPPLE_MIN) return true;
    if (maxLum[i] <= threshold) return false;
    return !echoGridLike(maxR[i], maxG[i], maxB[i]);
  }
  function rebuild(now) {
    const kept = samples.filter(sample => now - sample.t <= ECHO_HOLD_MS);
    samples.length = 0;
    for (const sample of kept) samples.push(sample);
    maxR.fill(0);
    maxG.fill(0);
    maxB.fill(0);
    maxLum.fill(0);
    maxRipple.fill(0);
    for (const sample of samples) {
      for (let i = 0; i < w * h; i++) {
        const o = i * 3;
        const r = sample.rgb[o];
        const g = sample.rgb[o + 1];
        const b = sample.rgb[o + 2];
        if (r > maxR[i]) maxR[i] = r;
        if (g > maxG[i]) maxG[i] = g;
        if (b > maxB[i]) maxB[i] = b;
        const lum = luminanceByte(r, g, b);
        if (lum > maxLum[i]) maxLum[i] = lum;
        const rip = sample.ripple ? sample.ripple[i] : 0;
        if (rip > maxRipple[i]) maxRipple[i] = rip;
      }
    }
  }
  function cell(sx, sy) {
    return {
      cx: Math.max(0, Math.min(w - 1, Math.round(sx / CANVAS_W * (w - 1)))),
      cy: Math.max(0, Math.min(h - 1, Math.round(sy / CANVAS_H * (h - 1))))
    };
  }
  function nearMask(cx, cy, radius, test) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (test(y * w + x)) return true;
      }
    }
    return false;
  }
  function bloomNear(cx, cy) {
    return nearMask(cx, cy, ECHO_BLOOM_RADIUS, i => lit(i, ECHO_BLOOM_LUM));
  }
  function rippleNear(cx, cy, radius = ECHO_RIPPLE_REACH) {
    return nearMask(cx, cy, radius, i => maxRipple[i] >= ECHO_RIPPLE_MIN);
  }
  function readRipple(ripple) {
    if (!ripple || !(ripple.width > 0) || !ctx) return null;
    try {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(ripple, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const energy = new Uint8Array(w * h);
      let litN = 0;
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        const e = rippleEnergyByte(data[p], data[p + 1], data[p + 2], data[p + 3]);
        energy[i] = e;
        if (e >= ECHO_RIPPLE_MIN) litN++;
      }
      return litN ? energy : energy;
    } catch {
      return null;
    }
  }
  return {
    width: w,
    height: h,
    holdMs: ECHO_HOLD_MS,
    clear() { samples.length = 0; maxR.fill(0); maxG.fill(0); maxB.fill(0); maxLum.fill(0); maxRipple.fill(0); },
    ingest(rgb, now, ripple) {
      if (!rgb || rgb.length < w * h * 3) return;
      let plane = null;
      if (ripple && ripple.length >= w * h) {
        plane = ripple.length >= w * h * 3 && ripple.length !== w * h
          ? (() => {
              const e = new Uint8Array(w * h);
              for (let i = 0; i < w * h; i++) e[i] = rippleEnergyByte(ripple[i * 3], ripple[i * 3 + 1], ripple[i * 3 + 2]);
              return e;
            })()
          : ripple;
      }
      samples.push({t: now, rgb, ripple: plane});
      rebuild(now);
    },
    sample(canvas, now) {
      if (!canvas || !(canvas.width > 0) || typeof document === 'undefined') return;
      if (!scratch) {
        scratch = document.createElement('canvas');
        scratch.width = w;
        scratch.height = h;
        ctx = scratch.getContext('2d', {willReadFrequently: true});
      }
      const ripple = findRippleLayer(canvas);
      let plane = null;
      try {
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(canvas, 0, 0, w, h);
        // Ripple overlay is a sibling (or #nd-room-projector) canvas the
        // camera still sees — fold it in so continuous detection cannot latch
        // caustics (TJ 4:29–4:35 PM, 9:01 PM).
        if (ripple && ripple.width > 0) {
          ctx.globalCompositeOperation = 'lighter';
          try { ctx.drawImage(ripple, 0, 0, w, h); } catch { /* ignore */ }
          ctx.globalCompositeOperation = 'source-over';
        }
      } catch { return; }
      const data = ctx.getImageData(0, 0, w, h).data;
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        rgb[i * 3] = data[p];
        rgb[i * 3 + 1] = data[p + 1];
        rgb[i * 3 + 2] = data[p + 2];
      }
      // Read the ripple layer on its own (clears scratch) so dim caustics that
      // vanish into the composited lum still veto sticker candidates.
      if (ripple && ripple.width > 0) plane = readRipple(ripple);
      samples.push({t: now, rgb, ripple: plane});
      rebuild(now);
    },
    // Warm, pink, coral, hard strokes, and the dimmer bloom aura.
    // ±3 cells is about ±20 stage px. The bloom radius is wider so the soft
    // falloff, after the camera's delay, still covers the waveform.
    veto(sx, sy) {
      const {cx, cy} = cell(sx, sy);
      if (rippleNear(cx, cy, ECHO_RIPPLE_REACH) || bloomNear(cx, cy)) return true;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          const r = maxR[i];
          const g = maxG[i];
          const b = maxB[i];
          const warm = r > 35 && (r - g) > 12 && g < 190;
          const coral = r > 40 && r > g && r > b && (r - g) > 8;
          if (warm || coral || lit(i, 30)) return true;
        }
      }
      return false;
    },
    // A new sticker cannot sit on a bright projected ring, bloom, ripple, or dancer.
    // Latched Scan stickers are not asked again, so the floor dot drawn later does not erase them.
    vetoSticker(sx, sy, reach = 5) {
      const {cx, cy} = cell(sx, sy);
      if (rippleNear(cx, cy, ECHO_RIPPLE_REACH) || bloomNear(cx, cy)) return true;
      // ±5 cells ≈ ±30 stage px — covers dark sim-icon centers inside glowing rings.
      const r = Math.max(5, Math.min(12, reach | 0));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (lit(i, 22)) return true;
        }
      }
      return false;
    }
  };
}

export function holdDarkStage(ms = 150) {
  if (typeof document === 'undefined') return;
  const room = document.getElementById('nd-room-lab');
  if (!room) return;
  room.dataset.ndDarkUntil = String((typeof performance !== 'undefined' ? performance.now() : Date.now()) + ms);
  if (room.neuralDance && typeof room.neuralDance.retint === 'function') room.neuralDance.retint();
}

export function medianPatch(rgba, width, height, x, y, radius = 2) {
  const w = width | 0;
  const h = height | 0;
  const pixels = [];
  for (let yy = y - radius; yy <= y + radius; yy++) {
    for (let xx = x - radius; xx <= x + radius; xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 4;
      pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
  }
  if (!pixels.length) return null;
  const channel = (index) => pixels.map(px => px[index]).sort((a, b) => a - b)[pixels.length >> 1];
  const r = channel(0);
  const g = channel(1);
  const b = channel(2);
  const hsv = rgbToHsv(r, g, b);
  return {r, g, b, h: hsv.h, s: hsv.s, v: hsv.v};
}

export function luminanceByte(r, g, b) {
  return Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Compact blob report for the opt-in live debug stream. Grid points are on the
// downsampled detection frame. Stage points are projector pixels (1000×620).
export function detectionTelemetry(blobs, rgba, width, height, scale, homography) {
  const w = width | 0;
  const h = height | 0;
  const bg = frameBackground(rgba, w, h, 8, (x, y) => {
    if (!homography) return true;
    return stageInside(x, y, {homography, scale: scale || {scaleX: 1, scaleY: 1}, exclude: []});
  });
  const wall = bg ? luminanceByte(bg.r, bg.g, bg.b) : 0;
  const pink = [];
  const stickers = [];
  const sx = scale && scale.scaleX ? scale.scaleX : 1;
  const sy = scale && scale.scaleY ? scale.scaleY : 1;
  for (const blob of (blobs || []).slice(0, 24)) {
    const gx = blob.x / sx;
    const gy = blob.y / sy;
    const sample = medianPatch(rgba, w, h, Math.round(gx), Math.round(gy), 2);
    const stagePoint = homography ? projectVideoPoint(homography, blob.x, blob.y) : null;
    const lum = sample ? luminanceByte(sample.r, sample.g, sample.b) : null;
    const item = {
      grid: [round3(gx), round3(gy)],
      stage: stagePoint ? [round3(stagePoint.x), round3(stagePoint.y)] : null,
      area: blob.area,
      rgb: sample ? [sample.r, sample.g, sample.b] : null,
      luminanceRatio: lum == null || !wall ? null : Math.round((lum / wall) * 1000) / 1000
    };
    if (blob.kind === 'sticker') stickers.push(item);
    else pink.push(item);
  }
  return {
    detectWidth: w,
    detectHeight: h,
    quadMedianRgb: bg ? [bg.r, bg.g, bg.b] : null,
    pink,
    stickers
  };
}

export const QUAD_CUT_SLACK = 0.08;

export const REGION_BLOCK = 96;
export const REGION_STEP = 48;
export const REGION_RATIO_MAX = 0.92;
export const REGION_PERCENTILE = 0.3; // low percentile: a bloom covering most of a block still leaves floor below it
// Low-percentile luma of the REGION_BLOCK square around each REGION_STEP grid node;
// returns a nearest-node lookup (x, y) -> luma, or null.
export function regionalFloor(rgba, width, height, accept = null) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < REGION_STEP || h < REGION_STEP) return null;
  const gw = Math.ceil(w / REGION_STEP);
  const gh = Math.ceil(h / REGION_STEP);
  const grid = new Float32Array(gw * gh);
  const half = REGION_BLOCK >> 1;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = gx * REGION_STEP + (REGION_STEP >> 1);
      const cy = gy * REGION_STEP + (REGION_STEP >> 1);
      const vals = [];
      for (let y = Math.max(0, cy - half); y < Math.min(h, cy + half); y += 4) {
        for (let x = Math.max(0, cx - half); x < Math.min(w, cx + half); x += 4) {
          if (accept && !accept(x, y)) continue;
          const p = (y * w + x) * 4;
          vals.push(luminanceByte(rgba[p], rgba[p + 1], rgba[p + 2]));
        }
      }
      if (vals.length < 16) { grid[gy * gw + gx] = 0; continue; }
      vals.sort((a, b) => a - b);
      grid[gy * gw + gx] = vals[Math.floor(vals.length * REGION_PERCENTILE)];
    }
  }
  return (x, y) => grid[Math.min(gh - 1, (y / REGION_STEP) | 0) * gw + Math.min(gw - 1, (x / REGION_STEP) | 0)];
}

export function stickerWindow(width) {
  return Math.max(9, Math.round(21 * ((width | 0) / 160))) | 1;
}

// Default sensitivity 0.5 accepts luma <= localMean * 0.84.
// TJ's vinyl is 0.70–0.85 of the screen around it; 0.84 keeps the darker body.
export function stickerDarkRatio(sensitivity) {
  const s = clamp(sensitivity, 0, 1, DEFAULTS.stickerSensitivity);
  return 0.70 + s * 0.28;
}

export function localWallThreshold(wallLuminance, sensitivity) {
  const wall = +wallLuminance;
  if (!Number.isFinite(wall) || wall < 35) return -1;
  return wall * stickerDarkRatio(sensitivity);
}

function isChromaticPink(r, g, b, bg) {
  if ((r - g) >= 24 && r > b) return true;
  if (!bg || !(bg.r > 0) || !(bg.g > 0) || !(bg.b > 0)) return false;
  const balanced = whiteBalance(r, g, b, bg);
  return balanced.rRatio >= 1.08 && (balanced.rRatio - balanced.gRatio) >= 0.16;
}

export const STICKER_QUAD_REF = 0.45; // typical close-range stage share of the frame
export const STICKER_MIN_AREA_FLOOR = 3;
export function stickerQuadScale(quadFraction) {
  const f = +quadFraction;
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.max(0.2, Math.min(1, f / STICKER_QUAD_REF));
}

export function detectStickerBlobs(rgba, width, height, options = {}) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 1 || h < 1 || rgba.length < w * h * 4) return [];
  const sensitivity = clamp(options.stickerSensitivity, 0, 1, DEFAULTS.stickerSensitivity);
  const radius = stickerWindow(w) >> 1;
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      row += luminanceByte(rgba[p], rgba[p + 1], rgba[p + 2]);
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + row;
    }
  }
  const gate = {homography: options.homography || null, scale: options.scale || null, exclude: options.exclude || null};
  // Background from the stickered floor (inside the align circles), not the
  // whole quad: since the 18/82 align fix the quad reaches the dim stage edges,
  // and their median (63 vs ~85 on the floor, 3:56 PM rig) made the cut below
  // reject a real mid-gray sticker.
  const bg = options.bg || (gate.homography && frameBackground(rgba, w, h, 8, (x, y) => playInside(x, y, gate)))
    || frameBackground(rgba, w, h, 8, gate.homography ? (x, y) => stageInside(x, y, gate) : null);
  const quadBgLum = bg ? luminanceByte(bg.r, bg.g, bg.b) : 0;
  const quadCut = quadBgLum >= 35 ? quadBgLum * stickerDarkRatio(sensitivity) : 255;
  // The stage-median cut above dropped TJ's lower-midline sticker (3:56 PM):
  // since the 18/82 align fix the quad reaches the dim stage edges (median 63
  // vs ~82 on the floor there). A pixel may instead pass against the
  // regional floor: 30th-percentile luma of a 96 px neighbourhood (48 px
  // grid). Thin grid lines and blooms do not raise it, and
  // unlike the stage median it follows the projector's falloff.
  const regionCut = regionalFloor(rgba, w, h, gate.homography ? (x, y) => stageInside(x, y, gate) : null);
  // Capped: a higher slider must not loosen this cut into floor noise.
  const regionRatio = Math.min(REGION_RATIO_MAX, stickerDarkRatio(sensitivity) + QUAD_CUT_SLACK);
  const mask = new Uint8Array(w * h);
  let insidePx = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      if (gate.homography && !stageInside(x, y, gate)) continue;
      insidePx++;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      const p = (y * w + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      if (isChromaticPink(r, g, b, bg)) continue;
      const lum = luminanceByte(r, g, b);
      const mx = Math.max(r, g, b);
      const sat = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
      // Painted yellow and orange marks are dark enough to pass the luma cut.
      // A real vinyl sticker is neutral. A very dark pixel may still be a sticker.
      if (sat > 0.55 && lum > 40) continue;
      const region = regionCut ? regionCut(x, y) : 0;
      if (lum <= localWallThreshold(sum / area, sensitivity) && (lum <= quadCut || (region >= 35 && lum <= region * regionRatio))) mask[y * w + x] = 1;
    }
  }
  const scale = areaScaleFor(w);
  // Far camera (TJ 6:35 PM): blob size limits follow the stage quad's size in
  // the frame. Close range (quad ≥ STICKER_QUAD_REF of the frame) is unchanged.
  const quadScale = stickerQuadScale(gate.homography ? insidePx / Math.max(1, w * h) : 1);
  const minArea = w > 160 ? Math.max(STICKER_MIN_AREA_FLOOR, Math.round(Math.max(8, 14 * scale / areaScaleFor(480)) * quadScale)) : Math.max(4, Math.round(clamp(options.minBlobSize, 1, 100000, 8)));
  const maxArea = w > 160 ? Math.max(minArea + 1, Math.round(220 * scale / areaScaleFor(480) * quadScale)) : Math.max(minArea, Math.round(w * h * 0.2));
  const seen = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  const blobs = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;
      seen[start] = 1;
      let sumX = 0;
      let sumY = 0;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;
        sumX += cx;
        sumY += cy;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1, cx - 1, cy - 1, cx + 1, cy - 1, cx - 1, cy + 1, cx + 1, cy + 1];
        for (let k = 0; k < neighbors.length; k += 2) {
          const nx = neighbors[k];
          const ny = neighbors[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          qx[tail] = nx;
          qy[tail] = ny;
          tail++;
        }
      }
      if (area < minArea || area > maxArea) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / bh;
      const extent = area / (bw * bh);
      const elong = Math.hypot(bw, bh) / Math.sqrt(Math.max(1, area));
      // Reject long thin slash / arm-leg transients (TJ 4:20 PM).
      if (aspect < 0.35 || aspect > 2.6 || elong > 4.2 || extent > 0.82 || extent < 0.04) continue;
      let contour = null;
      for (let yy = minY; yy <= maxY && !contour; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          if (!mask[yy * w + xx]) continue;
          contour = traceContour(mask, w, h, {x: xx, y: yy});
          break;
        }
      }
      const blob = {x: sumX / area, y: sumY / area, area, kind: 'sticker', aspect, extent, elongation: elong};
      if (contour && contour.length >= 3) blob.contour = contour;
      blobs.push(blob);
    }
  }
  blobs.sort((p, q) => q.area - p.area || p.x - q.x || p.y - q.y);
  let kept = blobs;
  if (options.quad && options.quad.length === 4) kept = kept.filter(blob => pointInQuad(options.quad, blob.x, blob.y));
  if (Number.isFinite(+options.expectedCount) && +options.expectedCount >= 0) kept = kept.slice(0, options.expectedCount | 0);
  return kept;
}

export function detectionSize(srcW, srcH, targetW = DETECT_WIDTH) {
  const sw = Math.max(1, Math.round(+srcW || targetW));
  const sh = Math.max(1, Math.round(+srcH || targetW));
  const width = Math.max(1, Math.min(targetW, sw));
  const height = Math.max(1, Math.round(sh * width / sw));
  return {width, height, scaleX: sw / width, scaleY: sh / height};
}

export function downsampleRgba(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
  return dst;
}

function markerKind(kind) {
  return kind === 'sticker' ? 'sticker' : 'pink';
}

// A note must stay up for about 1.5s before it is published. Once that
// debounce passes, the track is latched: later misses do not remove it.
// Unconfirmed flickers still expire after clearMs. clear() is the only reset.
export function createMarkerTracker({appearMs = APPEAR_MS, clearMs = CLEAR_MS, matchRadius = 64, latchRadius = LATCH_RADIUS} = {}) {
  let tracks = [];
  let latched = [];
  let nextId = 1;
  function stageMarker(t) {
    const marker = {id: t.id, x: t.x, y: t.y, kind: markerKind(t.kind)};
    const contour = sanitizeContour(t.contour);
    if (contour) marker.contour = contour;
    return marker;
  }
  function stageCopy() {
    return latched
      .map(stageMarker)
      .sort((p, q) => p.id - q.id);
  }
  return {
    update(blobs, now) {
      const incoming = (blobs || [])
        .map(b => {
          const p = point(b);
          if (!p) return null;
          p.kind = markerKind(b.kind);
          p.contour = sanitizeContour(b.contour);
          return p;
        })
        .filter(Boolean)
        .sort((p, q) => p.x - q.x || p.y - q.y);
      const used = new Set();
      const next = [];
      for (const track of tracks) {
        let best = -1;
        let bestD = matchRadius;
        for (let i = 0; i < incoming.length; i++) {
          if (used.has(i)) continue;
          const d = Math.hypot(incoming[i].x - track.x, incoming[i].y - track.y);
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best >= 0) {
          used.add(best);
          next.push({
            id: track.id,
            x: incoming[best].x,
            y: incoming[best].y,
            kind: incoming[best].kind || track.kind || 'pink',
            contour: incoming[best].contour || track.contour || null,
            seenSince: track.seenSince,
            missingSince: null,
            active: track.active || now - track.seenSince >= appearMs
          });
        } else if (track.active) {
          next.push(track);
        } else if (track.missingSince == null) {
          next.push({...track, missingSince: now});
        } else if (now - track.missingSince < clearMs) {
          next.push(track);
        }
      }
      for (let i = 0; i < incoming.length; i++) {
        if (used.has(i)) continue;
        next.push({
          id: nextId++,
          kind: incoming[i].kind || 'pink',
          x: incoming[i].x,
          y: incoming[i].y,
          contour: incoming[i].contour || null,
          seenSince: now,
          missingSince: null,
          active: appearMs <= 0
        });
      }
      tracks = next;
      return tracks
        .filter(t => t.active)
        .map(t => {
          const marker = {id: t.id, x: t.x, y: t.y, kind: markerKind(t.kind)};
          const contour = sanitizeContour(t.contour);
          if (contour) marker.contour = contour;
          return marker;
        })
        .sort((p, q) => p.id - q.id);
    },
    // Projected stage points. A hit near a latched dot updates that dot.
    // Misses leave the latch where it is. Returns every latched marker.
    commitStage(projected) {
      for (const marker of projected || []) {
        const at = point(marker);
        if (!at) continue;
        let best = -1;
        let bestD = latchRadius;
        for (let i = 0; i < latched.length; i++) {
          const d = Math.hypot(latched[i].x - at.x, latched[i].y - at.y);
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best >= 0) {
          latched[best].x = at.x;
          latched[best].y = at.y;
          if (marker.kind === 'sticker' || marker.kind === 'pink') latched[best].kind = markerKind(marker.kind);
          const contour = sanitizeContour(marker.contour);
          if (contour) latched[best].contour = contour;
        } else {
          const usedIds = new Set(latched.map(item => item.id));
          let id = marker.id | 0;
          if (!(id > 0) || usedIds.has(id)) id = nextId++;
          const created = {id, x: at.x, y: at.y, kind: markerKind(marker.kind)};
          const contour = sanitizeContour(marker.contour);
          if (contour) created.contour = contour;
          latched.push(created);
        }
      }
      const kept = [];
      for (const marker of latched) {
        const near = kept.find(other => Math.hypot(other.x - marker.x, other.y - marker.y) <= latchRadius);
        if (near) {
          near.x = marker.x;
          near.y = marker.y;
          if (marker.contour) near.contour = marker.contour;
        } else kept.push(marker);
      }
      latched = kept;
      return stageCopy();
    },
    stage() { return stageCopy(); },
    replaceStage(list) {
      const kept = [];
      let maxId = nextId - 1;
      for (const marker of list || []) {
        const at = point(marker);
        if (!at) continue;
        let id = marker.id | 0;
        if (!(id > 0)) id = maxId + 1;
        if (id > maxId) maxId = id;
        const created = {id, x: at.x, y: at.y, kind: markerKind(marker.kind)};
        const contour = sanitizeContour(marker.contour);
        if (contour) created.contour = contour;
        kept.push(created);
      }
      latched = kept;
      nextId = maxId + 1;
      return stageCopy();
    },
    restore(list) {
      const kept = [];
      let maxId = nextId - 1;
      for (const marker of list || []) {
        const at = point(marker);
        if (!at) continue;
        let id = marker.id | 0;
        if (!(id > 0)) id = maxId + 1;
        if (id > maxId) maxId = id;
        const created = {id, x: at.x, y: at.y, kind: markerKind(marker.kind)};
        const contour = sanitizeContour(marker.contour);
        if (contour) created.contour = contour;
        kept.push(created);
      }
      latched = kept;
      nextId = maxId + 1;
      return stageCopy();
    },
    clear() {
      tracks = [];
      latched = [];
    }
  };
}

export function toDancerMarkers(markers) {
  return (markers || []).map(m => {
    const id = m.id | 0;
    const type = Number.isFinite(+m.type) ? (((+m.type) % 4) + 4) % 4 : (((id - 1) % 4) + 4) % 4;
    const marker = {id, x: +m.x, y: +m.y, type, kind: m.kind === 'sticker' ? 'sticker' : 'pink'};
    if (m.manual) marker.manual = true;
    if (Number.isFinite(+m.projectedHeight) && +m.projectedHeight > 0) marker.projectedHeight = +m.projectedHeight;
    const contour = sanitizeContour(m.contour);
    if (contour) marker.contour = contour;
    return marker;
  }).filter(m => m.id > 0 && Number.isFinite(m.x) && Number.isFinite(m.y));
}

export function markersFromFrame(frame, settings, homography, scale, tracker, now, extra = {}) {
  const options = settings || {};
  const mode = normalizeDetectionMode(options.detectionMode || options.markerMode);
  const shared = {
    ...options,
    homography: homography || null,
    scale,
    exclude: extra.exclude || null,
    customSample: Number.isFinite(+options.hueCenter) && hueDistance(+options.hueCenter, PINK_HUE) > 20
  };
  const found = [];
  if (mode !== 'stickers') {
    for (const blob of detectPinkMarkers(frame.data, frame.width, frame.height, shared)) found.push({...blob, kind: 'pink'});
  }
  if (mode !== 'pink') {
    for (const blob of detectStickerBlobs(frame.data, frame.width, frame.height, shared)) found.push(blob);
  }
  const pinkBlobs = found.filter(blob => blob.kind !== 'sticker');
  const separated = found.filter(blob => {
    if (blob.kind !== 'sticker') return true;
    return !pinkBlobs.some(pink => Math.hypot(pink.x - blob.x, pink.y - blob.y) <= 18);
  });
  let videoBlobs = separated.map(b => {
    const video = videoPointFromDetect(b.x, b.y, scale);
    const blob = {
      x: video.x,
      y: video.y,
      area: b.area,
      kind: b.kind === 'sticker' ? 'sticker' : 'pink'
    };
    const contour = sanitizeContour(b.contour);
    if (contour) blob.contour = sanitizeContour(contour.map(p => videoPointFromDetect(p.x, p.y, scale)));
    return blob;
  });
  if (extra.echo && homography) {
    videoBlobs = videoBlobs.filter(blob => {
      const at = applyHomography(homography, blob.x, blob.y);
      if (!at) return true;
      if (blob.kind === 'sticker') return !extra.echo.vetoSticker(at.x, at.y);
      return !extra.echo.veto(at.x, at.y);
    });
  }
  if (typeof extra.beforeLatch === 'function') {
    const next = extra.beforeLatch(videoBlobs);
    if (Array.isArray(next)) videoBlobs = next;
  }
  if (extra.latch === false) return {blobs: videoBlobs, markers: []};
  const stable = tracker.update(videoBlobs, now);
  const stageOf = typeof tracker.stage === 'function' ? tracker.stage.bind(tracker) : null;
  const commit = typeof tracker.commitStage === 'function' ? tracker.commitStage.bind(tracker) : null;
  if (!homography) return {blobs: videoBlobs, markers: toDancerMarkers(stageOf ? stageOf() : [])};
  const projected = [];
  for (const marker of stable) {
    const p = projectVideoPoint(homography, marker.x, marker.y);
    if (!p) continue;
    const stagePoint = {id: marker.id, x: p.x, y: p.y, kind: marker.kind === 'sticker' ? 'sticker' : 'pink'};
    const contour = marker.contour ? projectContour(marker.contour, homography) : null;
    if (contour) stagePoint.contour = contour;
    projected.push(stagePoint);
  }
  const latched = commit ? commit(projected) : projected;
  return {blobs: videoBlobs, markers: toDancerMarkers(latched)};
}

export function cameraChoices(devices) {
  return (devices || [])
    .filter(d => d && d.kind === 'videoinput' && d.deviceId)
    .map(d => ({
      deviceId: String(d.deviceId),
      label: d.label && String(d.label).trim() ? String(d.label).trim() : 'Camera'
    }));
}

function rearRank(label) {
  const text = String(label || '');
  const rear = /\b(back|rear|environment)\b/i.test(text) || /facing\s*back/i.test(text);
  if (!rear) return null;
  if (/ultra\s*wide|telephoto/i.test(text)) return 3;
  if (/dual|triple/i.test(text)) return 2;
  if (/^(back|rear)\s+camera$/i.test(text) || /facing\s*back/i.test(text)) return 0;
  return 1;
}

// An explicit saved camera wins. Otherwise the 1× rear camera, then any rear
// camera, then macOS Continuity Camera, then the first device.
export function pickCamera(choices, saved) {
  if (!choices || !choices.length) return null;
  if (saved && saved.deviceId) {
    const byId = choices.find(c => c.deviceId === saved.deviceId);
    if (byId) return byId;
  }
  if (saved && saved.deviceLabel) {
    const byLabel = choices.find(c => c.label === saved.deviceLabel);
    if (byLabel) return byLabel;
  }
  const rear = choices
    .map(choice => ({choice, rank: rearRank(choice.label)}))
    .filter(item => item.rank !== null)
    .sort((a, b) => a.rank - b.rank);
  if (rear.length) return rear[0].choice;
  return choices.find(c => /iPhone(?:\s*\(\d+\))?\s*Camera/i.test(c.label))
    || choices.find(c => /iPhone/i.test(c.label))
    || choices[0];
}

function savedCorners(input) {
  if (input == null) return null;
  if (!isValidAlignmentQuad(input)) return DEFAULT_QUAD.map(p => ({x: p.x, y: p.y}));
  return input.map(corner => ({x: +corner.x, y: +corner.y}));
}

function environmentCamera(data) {
  const text = `${data && data.deviceLabel || ''} ${data && data.deviceId || ''} ${data && data.facingMode || ''}`;
  if (/\b(front|user|selfie|facetime)\b/i.test(text)) return false;
  return /\b(back|rear|environment)\b/i.test(text);
}

function untouchedSlider(value, min, max, fallback, legacy, previous) {
  const v = +value;
  if (!Number.isFinite(v) || v < min) return fallback;
  const capped = Math.min(max, v);
  if (!legacy) return capped;
  for (const old of previous) {
    if (Math.abs(capped - old) < 1e-6) return fallback;
  }
  return capped;
}

function readRaw(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function readCameraSettings(storage) {
  if (!storage) return null;
  let data = readRaw(storage, STORAGE_KEY);
  let legacy = false;
  if (!data) {
    for (const key of LEGACY_CAMERA_KEYS) {
      data = readRaw(storage, key);
      if (data) { legacy = true; break; }
    }
  }
  if (!data) return null;
  const userSelected = legacy ? environmentCamera(data) : data.userSelected === true;
  const settings = sanitizeSettings({
    deviceId: userSelected && typeof data.deviceId === 'string' ? data.deviceId : '',
    deviceLabel: userSelected && typeof data.deviceLabel === 'string' ? data.deviceLabel : '',
    userSelected,
    corners: savedCorners(data.corners),
    cornersSource: typeof data.cornersSource === 'string' ? data.cornersSource.slice(0, 24) : '',
    cornersLocked: data.cornersLocked === true || data.cornersSource === 'manual-lock',
    cornersAt: Number.isFinite(+data.cornersAt) ? +data.cornersAt : 0,
    hueTolerance: untouchedSlider(data.hueTolerance, 18, 80, DEFAULTS.hueTolerance, legacy, [48]),
    saturationSensitivity: untouchedSlider(data.saturationSensitivity, 0.25, 1, DEFAULTS.saturationSensitivity, legacy, [0.75]),
    minBlobSize: legacy
      ? Math.round(untouchedSlider(data.minBlobSize, 4, 200, DEFAULTS.minBlobSize, true, [14, 18]))
      : Math.round(clamp(data.minBlobSize, 4, 200, DEFAULTS.minBlobSize)),
    hueCenter: Number.isFinite(+data.hueCenter) ? wrapHue(data.hueCenter, PINK_HUE) : null,
    detectionMode: normalizeDetectionMode((readRaw(storage, 'nd.markers.v2') || {}).markerMode || (readRaw(storage, 'nd.markers.v2') || {}).detectionMode || data.detectionMode),
    stickerSensitivity: clamp((readRaw(storage, 'nd.markers.v2') || {}).stickerSensitivity ?? data.stickerSensitivity, 0, 1, DEFAULTS.stickerSensitivity)
  });
  const replacedQuad = data.corners != null && !isValidAlignmentQuad(data.corners);
  if ((legacy || replacedQuad) && typeof storage.setItem === 'function') {
    writeCameraSettings(storage, settings);
    if (legacy && typeof storage.removeItem === 'function') {
      for (const key of LEGACY_CAMERA_KEYS) {
        try { storage.removeItem(key); } catch { /* already gone */ }
      }
    }
  }
  return settings;
}

function copyStageMarkers(list) {
  const out = [];
  for (const marker of list || []) {
    if (!marker || !Number.isFinite(+marker.x) || !Number.isFinite(+marker.y)) continue;
    const id = marker.id | 0;
    if (!(id > 0)) continue;
    const item = {
      id,
      x: +marker.x,
      y: +marker.y,
      kind: marker.kind === 'sticker' ? 'sticker' : 'pink'
    };
    if (marker.manual === true) item.manual = true;
    const contour = sanitizeContour(marker.contour);
    if (contour) item.contour = contour;
    out.push(item);
  }
  return out;
}

export function writeReloadLatch(storage, snapshot) {
  if (!storage || typeof storage.setItem !== 'function' || !snapshot) return false;
  try {
    storage.setItem(RELOAD_LATCH_KEY, JSON.stringify({
      v: 1,
      pending: true,
      markersOn: snapshot.markersOn === true,
      markers: copyStageMarkers(snapshot.markers),
      manuals: copyStageMarkers(snapshot.manuals).filter(item => item.manual === true || item.kind === 'sticker')
    }));
    return true;
  } catch {
    return false;
  }
}

export function takeReloadLatch(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let data = null;
  try {
    const raw = storage.getItem(RELOAD_LATCH_KEY);
    if (raw) data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (typeof storage.removeItem === 'function') {
    try { storage.removeItem(RELOAD_LATCH_KEY); } catch { /* already gone */ }
  }
  if (!data || data.pending !== true || typeof data !== 'object') return null;
  return {
    markersOn: data.markersOn === true,
    markers: copyStageMarkers(data.markers),
    manuals: copyStageMarkers(data.manuals)
  };
}

// Debug label for where a committed quad came from.
// A hand-set quad stays until Detect frame, Accept, or Reset. Auto-detect,
// drift, dancer placement, and a relayed patch cannot move it.
export function cornerCommitAllowed(locked, opts) {
  if (!locked) return true;
  if (opts && opts.unlock) return true;
  if (opts && opts.manual && !opts.fromLock && !opts.drift) return true;
  return false;
}

// A hand drag keeps any convex on-camera quad. Auto-detect's parallel-edge
// gate is what was snapping the pink handles back to the detected wall.
export function acceptManualCorners(quad) {
  if (!isValidAlignmentQuad(quad)) return {ok: false, reason: 'Those corners cross or sit outside the camera.'};
  return {ok: true, lock: true};
}

// Keep a hand-set frame inside the camera image. A corner past the edge is
// pulled back to the edge so the pink quad cannot jump off the picture.
export function clampQuadToFrame(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  const pts = [];
  for (const corner of quad) {
    const x = corner && +corner.x;
    const y = corner && +corner.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))});
  }
  return pts;
}

export function quadSourceOf(message, opts) {
  if (opts && opts.fromLock) return 'border-lock';
  if (opts && opts.drift) return 'drift';
  const text = String(message || '');
  if (/from debug/i.test(text)) return 'debug';
  if (opts && opts.manual) return 'manual';
  if (/screen border/i.test(text)) return 'border';
  if (/sticker check/i.test(text)) return 'sticker-check';
  if (/refined/i.test(text)) return 'align-refined';
  return 'align';
}

export function writeCameraSettings(storage, settings) {
  if (!storage || !settings) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      v: 3,
      userSelected: settings.userSelected === true,
      deviceId: settings.userSelected === true ? (settings.deviceId || '') : '',
      deviceLabel: settings.userSelected === true ? (settings.deviceLabel || '') : '',
      corners: settings.corners || null,
      cornersSource: settings.corners && typeof settings.cornersSource === 'string' ? settings.cornersSource.slice(0, 24) : '',
      cornersLocked: !!(settings.corners && (settings.cornersLocked === true || settings.cornersSource === 'manual-lock')),
      cornersAt: settings.corners && Number.isFinite(+settings.cornersAt) ? +settings.cornersAt : 0,
      hueTolerance: settings.hueTolerance,
      saturationSensitivity: settings.saturationSensitivity,
      minBlobSize: settings.minBlobSize,
      hueCenter: Number.isFinite(+settings.hueCenter) ? settings.hueCenter : null
    }));
    storage.setItem('nd.markers.v2', JSON.stringify({
      v: 2,
      markerMode: normalizeDetectionMode(settings.detectionMode || settings.markerMode),
      stickerSensitivity: clamp(settings.stickerSensitivity, 0, 1, DEFAULTS.stickerSensitivity),
      hueTolerance: settings.hueTolerance,
      saturationSensitivity: settings.saturationSensitivity,
      minBlobSize: settings.minBlobSize,
      hueCenter: Number.isFinite(+settings.hueCenter) ? settings.hueCenter : null
    }));
    return true;
  } catch {
    return false;
  }
}

// The Controls pill is the way back when the dock is hidden. A scan flash
// must not leave it hidden. Align still hides it so the camera sees the wall.
export function ensureControlsPill(doc) {
  const body = doc && doc.body;
  const reveal = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-live="reveal"]') : null;
  if (!body || !body.classList || !reveal) return false;
  const aligning = body.classList.contains('nd-live-aligning') || body.classList.contains('nd-align-clean') || body.classList.contains('nd-live-pattern');
  const chromeHidden = body.classList.contains('nd-live-hidden');
  if (!aligning && chromeHidden) reveal.hidden = false;
  const dock = doc.querySelector('.nd-live-chrome');
  if (!aligning && !chromeHidden && dock) dock.hidden = false;
  if (aligning) return false;
  return chromeHidden ? reveal.hidden === false : true;
}

export function clientToNormalized(clientX, clientY, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))};
}

// Preview CSS is object-fit: contain. A click on the picture is not a
// fraction of the element box when the video is letterboxed.
export function containedVideoRect(rect, videoW, videoH) {
  const bw = +rect.width;
  const bh = +rect.height;
  const vw = +videoW;
  const vh = +videoH;
  if (!(bw > 0) || !(bh > 0) || !(vw > 0) || !(vh > 0)) return null;
  const scale = Math.min(bw / vw, bh / vh);
  const width = vw * scale;
  const height = vh * scale;
  return {
    left: +rect.left + (bw - width) / 2,
    top: +rect.top + (bh - height) / 2,
    width,
    height
  };
}

export function clientToVideoNormalized(clientX, clientY, rect, videoW, videoH) {
  const media = containedVideoRect(rect, videoW, videoH);
  return clientToNormalized(clientX, clientY, media || rect);
}

export const STICKER_CAL_KEY = 'nd.stickerCal.v1';
export function readStickerCal(storage) {
  try {
    const raw = storage && storage.getItem(STICKER_CAL_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || !Array.isArray(data.H) || data.H.length !== 9 || data.H.some(v => !Number.isFinite(+v))) return null;
    return {H: data.H.map(Number), residual: Number.isFinite(+data.residual) ? +data.residual : 0, at: +data.at || 0};
  } catch { return null; }
}
export function writeStickerCal(storage, cal) {
  try {
    if (!storage) return false;
    if (!cal) storage.removeItem(STICKER_CAL_KEY);
    else storage.setItem(STICKER_CAL_KEY, JSON.stringify({H: cal.H, residual: +cal.residual || 0, at: +cal.at || Date.now()}));
    return true;
  } catch { return false; }
}

function memoryOf(storage) {
  try {
    return storage || window.localStorage;
  } catch {
    return null;
  }
}

// Continuity Camera (Safari and Chrome on macOS) delivers a live but black
// track when width/height are combined with deviceId. Ask for the device at
// high resolution first, then fall back to the device with no size, which is
// the constraint that stays live. exact keeps a picked "iPhone (3) Camera"
// from falling through to the built-in camera. ideal is the fallback when
// exact is overconstrained. The constraint stays an object.
export const CAMERA_RESOLUTIONS = [{width: 1920, height: 1080}, {width: 1280, height: 720}, null];

export function videoConstraints(deviceId, mode = 'exact', resolution = null) {
  const video = {};
  if (resolution && (resolution.width || resolution.height)) {
    if (resolution.width) video.width = {ideal: resolution.width | 0};
    if (resolution.height) video.height = {ideal: resolution.height | 0};
  }
  if (!deviceId) {
    video.facingMode = {ideal: 'environment'};
    return video;
  }
  video.deviceId = mode === 'ideal' ? {ideal: String(deviceId)} : {exact: String(deviceId)};
  return video;
}

export function cameraVideoAttempts(deviceId) {
  const attempts = [];
  if (deviceId) {
    for (const mode of ['exact', 'ideal']) {
      for (const resolution of CAMERA_RESOLUTIONS) attempts.push(videoConstraints(deviceId, mode, resolution));
    }
  }
  for (const resolution of CAMERA_RESOLUTIONS) attempts.push(videoConstraints('', 'ideal', resolution));
  return attempts;
}

let toastTimer = 0;
export function showStageToast(text, kind = 'ok', holdMs = 4000, doc = globalThis.document) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  let banner = doc.querySelector('[data-align-banner]');
  if (!banner && doc.createElement && doc.body) {
    banner = doc.createElement('div');
    banner.id = 'nd-live-toast';
    banner.setAttribute('data-align-banner', '');
    doc.body.appendChild(banner);
  }
  if (!banner) return null;
  banner.hidden = false;
  banner.dataset.kind = kind || 'ok';
  banner.textContent = text;
  if (holdMs > 0 && typeof setTimeout === 'function') {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { banner.hidden = true; }, holdMs);
  }
  return banner;
}

export function armPreviewElement(video) {
  if (!video) return video;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.controls = false;
  if (typeof video.setAttribute === 'function') {
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('webkit-playsinline', '');
  }
  return video;
}

// readyState HAVE_CURRENT_DATA plus a non-zero frame, and the element is actually playing.
export function videoFrameReady(video) {
  return !!(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused && !video.ended);
}

export function drawVideoFrame(video, ctx, width, height) {
  if (!videoFrameReady(video) || !ctx || !(width > 0) || !(height > 0)) return false;
  try {
    ctx.drawImage(video, 0, 0, width, height);
    return true;
  } catch {
    return false;
  }
}

// Set srcObject, force muted / playsInline / autoplay, and call play() only after loadedmetadata.
export function playPreview(video, stream) {
  armPreviewElement(video);
  video.srcObject = stream;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Object.assign(new Error('preview timeout'), {name: 'TimeoutError'})), 8000);
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const start = () => {
      try {
        const playing = video.play();
        if (playing && typeof playing.then === 'function') playing.then(() => finish(), finish);
        else finish();
      } catch (err) {
        finish(err);
      }
    };
    const onReady = () => start();
    const onError = () => finish(Object.assign(new Error('preview error'), {name: 'AbortError'}));
    if (video.readyState >= 1 && video.videoWidth > 0) start();
    else {
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('error', onError);
    }
  });
}

function permissionDenied(err) {
  return !!(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'PermissionDeniedError'));
}

export async function acquireCameraStream(md, deviceId) {
  if (!md || typeof md.getUserMedia !== 'function') {
    throw Object.assign(new Error('camera unavailable'), {name: 'NotFoundError'});
  }
  const attempts = cameraVideoAttempts(deviceId);
  let last;
  for (const video of attempts) {
    try {
      return await md.getUserMedia({video, audio: false});
    } catch (err) {
      last = err;
      if (permissionDenied(err)) throw err;
    }
  }
  throw last || Object.assign(new Error('no camera'), {name: 'NotFoundError'});
}

export function applyPaintingWarpCam(cam) {
    const layer = document.getElementById('nd-room-projector');
    if (!layer) return;
    const w = cam.painting.active() ? cam.painting.warp() : null;
    if (!w || !w.target || document.body.classList.contains('is-mapping')) {
      if (layer.dataset.ndPaintingWarp === '1') { layer.style.transform = ''; layer.style.transformOrigin = ''; delete layer.dataset.ndPaintingWarp; }
      return;
    }
    // One warp only. Marker positions are pre-warp stage pixels; this CSS
    // matrix is the screen transform. Do not also fold it into the homography.
    const m = warpMatrix3d(w.target, layer.offsetWidth || window.innerWidth, layer.offsetHeight || window.innerHeight, CANVAS_W, CANVAS_H);
    if (!m) return;
    layer.style.transformOrigin = '0 0';
    layer.style.transform = m;
    layer.dataset.ndPaintingWarp = '1';
  }

export function syncPaintingCam(cam) { cam.syncPaintingClass(); cam.applyPaintingWarp(); }

export function paintProjectorCrosshairsCam(cam) {
    const host = document.getElementById('nd-room-projector');
    if (!host) return;
    let layer = host.querySelector('[data-sticker-crosshair]');
    if (!cam.stickerCrosshair) {
      if (layer) layer.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement('canvas');
      layer.setAttribute('data-sticker-crosshair', '');
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:8';
      host.appendChild(layer);
    }
    const w = layer.width = host.clientWidth || 1000;
    const h = layer.height = host.clientHeight || 620;
    const ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#ffe14a';
    ctx.lineWidth = 2;
    for (const marker of cam.stickerScan.markers()) {
      if (!marker || marker.kind === 'pink') continue;
      const x = (marker.x / CANVAS_W) * w;
      const y = (marker.y / CANVAS_H) * h;
      ctx.beginPath();
      ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14);
      ctx.stroke();
    }
  }

export function sayCam(cam, text) {
    if (cam.status && cam.status.textContent !== text) cam.status.textContent = text;
  }

export function settingsCam(cam) {
    return {
      deviceId: cam.select.value || '',
      deviceLabel: cam.select.selectedOptions && cam.select.selectedOptions[0] ? cam.select.selectedOptions[0].textContent : '',
      userSelected: cam.userPicked,
      corners: cam.committed.length === 4 ? cam.committed : null,
      cornersSource: cam.quadSource,
      cornersLocked: cam.manualLocked === true,
      cornersAt: cam.quadAt,
      hueTolerance: +cam.hue.value,
      saturationSensitivity: +cam.sat.value,
      minBlobSize: +cam.size.value,
      hueCenter: cam.hueCenterOverride == null ? undefined : cam.hueCenterOverride,
      detectionMode: cam.detectionMode,
      markerMode: cam.detectionMode,
      stickerSensitivity: cam.sticker ? +cam.sticker.value : DEFAULTS.stickerSensitivity,
      maxBlobSize: cam.maxBlobSize,
      personPause: cam.personEnabled,
      gapScan: cam.gapScanEnabled !== false,
      personSensitivity: cam.personSensitivity,
      scanMode: cam.scanClock.mode,
      scanInterval: cam.scanClock.intervalMs / 1000,
      scanDuration: cam.scanClock.durationMs
    };
  }

export function persistCam(cam, opts = {}) {
    if (opts.userSelected === true) cam.userPicked = true;
    writeCameraSettings(memoryOf(null), cam.settings());
  }

export function showSliderCam(cam, input, out, text) {
    const node = cam.root.querySelector('[data-value="' + out + '"]');
    if (node) node.textContent = text;
  }

export function refreshLabelsCam(cam) {
    cam.showSlider(cam.hue, 'hue', Math.round(+cam.hue.value) + '°');
    cam.showSlider(cam.sat, 'sat', (+cam.sat.value).toFixed(2));
    cam.showSlider(cam.size, 'size', Math.round(+cam.size.value) + ' px');
    if (cam.sticker) cam.showSlider(cam.sticker, 'sticker', (+cam.sticker.value).toFixed(2));
    cam.detectionMode = normalizeDetectionMode(cam.detectionMode);
    for (const button of cam.modeButtons) button.setAttribute('aria-pressed', button.dataset.mode === cam.detectionMode ? 'true' : 'false');
  }

export function applySavedCam(cam, saved) {
    if (!saved) return;
    if (saved.userSelected) cam.userPicked = true;
    if (saved.hueCenter != null) cam.hueCenterOverride = saved.hueCenter;
    cam.hue.value = String(saved.hueTolerance);
    cam.sat.value = String(saved.saturationSensitivity);
    cam.size.value = String(saved.minBlobSize);
    if (saved.detectionMode) cam.detectionMode = normalizeDetectionMode(saved.detectionMode);
    if (cam.sticker && Number.isFinite(+saved.stickerSensitivity)) cam.sticker.value = String(saved.stickerSensitivity);
    // A saved quad keeps owning the mapping after reload (no border-lock takeover).
    if (saved.corners) {
      cam.committed = saved.corners.map(p => ({x: p.x, y: p.y}));
      cam.manualQuad = true;
      cam.quadSource = saved.cornersSource || 'saved';
      cam.quadAt = +saved.cornersAt || 0;
      cam.manualLocked = saved.cornersLocked === true || cam.quadSource === 'manual-lock';
    }
    cam.refreshLabels();
    cam.rebuild();
    cam.syncMarkerButton();
  }

export function rebuildCam(cam) {
    const vw = cam.video.videoWidth;
    const vh = cam.video.videoHeight;
    const fitted = cam.stickerCal && cam.stickerCal.H && vw > 0 && vh > 0 ? videoHomographyFromNorm(cam.stickerCal.H, vw, vh) : null;
    cam.homography = fitted || homographyFromNormalized(cam.committed, vw, vh);
    cam.personBackground.reset();
  }

export function syncMarkerButtonCam(cam) {
    const ready = cam.committed.length === 4;
    cam.markerButton.disabled = !ready;
    cam.markerButton.textContent = cam.markersOn ? 'Markers on' : 'Markers off';
    cam.markerButton.setAttribute('aria-pressed', cam.markersOn ? 'true' : 'false');
    if (cam.draft) {
      cam.calibrateButton.textContent = 'Cancel calibration';
      cam.calibrateButton.setAttribute('aria-pressed', 'true');
    } else if (cam.committed.length === 4) {
      cam.calibrateButton.textContent = cam.root.dataset.fineTune === '1' ? 'Fine-tune corners' : 'Recalibrate';
      cam.calibrateButton.setAttribute('aria-pressed', 'false');
    } else {
      cam.calibrateButton.textContent = cam.root.dataset.fineTune === '1' ? 'Fine-tune corners' : 'Calibrate wall';
      cam.calibrateButton.setAttribute('aria-pressed', 'false');
    }
  }

export function roomApiCam(cam) {
    const room = document.getElementById('nd-room-lab');
    return room && room.neuralDance && typeof room.neuralDance.setMarkers === 'function' ? room.neuralDance : null;
  }

export function pushCam(cam, list) {
    cam.latest = list;
    const nd = cam.roomApi();
    if (!nd) return;
    nd.setMarkers(list);
    if (typeof nd.poke === 'function') nd.poke();
    if (list && list.length && !cam.askedStart) {
      const play = document.getElementById('nd-room-lab').querySelector('[data-action="play"]');
      if (play && play.textContent.trim() === 'Start') {
        cam.askedStart = true;
        play.click();
      }
    }
  }

export function stopDrivingCam(cam) {
    const kept = mergeLatchedStickers([], cam.manuals.list());
    if (kept.length) {
      cam.driving = true;
      cam.latest = kept;
      const nd = cam.roomApi();
      if (nd) {
        nd.setMarkers(kept);
        if (typeof nd.poke === 'function') nd.poke();
      }
      return;
    }
    if (!cam.driving) {
      cam.latest = null;
      return;
    }
    cam.driving = false;
    const nd = cam.roomApi();
    if (nd) {
      nd.setMarkers([]);
      if (typeof nd.poke === 'function') nd.poke();
      nd.setMarkers(null);
    }
    cam.latest = null;
  }

export function publishListCam(cam, list) {
    const merged = mergeLatchedStickers(Array.isArray(list) ? list : [], cam.manuals.list());
    cam.latest = merged;
    const nd = cam.roomApi();
    if (!nd) return;
    nd.setMarkers(merged);
    if (typeof nd.poke === 'function') nd.poke();
  }

// Drop scan-latched dancers and any reload snapshot of them. Hand-placed
// debug stickers stay in cam.manuals and are merged back by publishScan.
export function clearAutoScanMarkersCam(cam) {
  if (!cam || !cam.stickerScan) return 0;
  if (typeof cam.stickerScan.resetBook === 'function') cam.stickerScan.resetBook();
  else if (typeof cam.stickerScan.reset === 'function') cam.stickerScan.reset();
  cam.scanAuthority = false;
  cam.scanAccum = [];
  cam.scanConfirmed = false;
  if (cam.tracker && typeof cam.tracker.replaceStage === 'function') cam.tracker.replaceStage([]);
  try {
    const mem = memoryOf(null);
    if (mem && typeof mem.getItem === 'function' && typeof mem.setItem === 'function') {
      const raw = mem.getItem(RELOAD_LATCH_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          data.markers = [];
          mem.setItem(RELOAD_LATCH_KEY, JSON.stringify(data));
        }
      }
    }
  } catch { /* the live book is already empty */ }
  if (typeof cam.publishScan === 'function') cam.publishScan();
  return cam.stickerScan.markers().length;
}

export function forgetLatchedMarkersCam(cam, {manual = false} = {}) {
    if (manual) cam.manuals.clear();
    cam.occlusion.reset();
    cam.lastOcclusion = emptyOcclusion();
    syncPersonNote(document, false);
    cam.tracker.clear();
    cam.stickerScan.clear();
    cam.scanAuthority = false;
    cam.scanAccum = [];
    cam.scanConfirmed = false;
    cam.blankSettle.clear();
    cam.scanClock.abort();
    cam.setStageScan(null, 0);
    cam.echo.clear();
    cam.driving = false;
    if (cam.markersOn) cam.publishList([]);
    else {
      cam.latest = null;
      const nd = cam.roomApi();
      if (nd) {
        nd.setMarkers([]);
        if (typeof nd.poke === 'function') nd.poke();
        nd.setMarkers(null);
      }
    }
  }

export function armMarkersIfAlignedCam(cam, quiet) {
    if (cam.committed.length !== 4 || cam.markersOn) return;
    if (document.body && document.body.classList.contains('nd-live-aligning')) return;
    cam.setMarkersEnabled(true, quiet);
  }

export function clearNoteLocksCam(cam) {
    const stage = document.getElementById('nd-room-projector');
    if (!stage || !stage.querySelectorAll) return;
    stage.querySelectorAll('.nd-note-lock').forEach(node => node.remove());
  }

export function publishCam(cam, markers) {
    cam.clearNoteLocks();
    const merged = mergeLatchedStickers(Array.isArray(markers) ? markers : [], cam.manuals.list());
    if (!cam.markersOn || !cam.homography) {
      if (merged.length) {
        cam.driving = true;
        cam.push(merged);
        return;
      }
      if (cam.driving) cam.stopDriving();
      else cam.latest = null;
      return;
    }
    if (merged.length) {
      cam.driving = true;
      cam.push(merged);
      return;
    }
    if (cam.driving) cam.push([]);
    else cam.latest = null;
  }

export function fillSelectCam(cam, selectedId) {
    const keep = selectedId || cam.select.value;
    cam.select.replaceChildren();
    cam.select.add(new Option('Choose a camera', ''));
    for (const choice of cam.choices) cam.select.add(new Option(choice.label, choice.deviceId));
    cam.select.value = cam.choices.some(c => c.deviceId === keep) ? keep : '';
  }

export function openedIdCam(cam) {
    const track = cam.stream && cam.stream.getVideoTracks()[0];
    return track && track.getSettings ? (track.getSettings().deviceId || '') : '';
  }

export function failCam(cam, err) {
    const denied = permissionDenied(err);
    const timeout = err && err.name === 'TimeoutError';
    cam.say(denied ? 'Camera blocked' : timeout ? 'Camera picture did not start' : 'No camera');
    if (!cam.stream) cam.cameraButton.textContent = 'Use camera';
  }

export function stopTracksCam(cam, current) {
    if (!current) return;
    current.getTracks().forEach(track => {
      try { track.stop(); } catch { /* already ended */ }
    });
  }

export function stopCameraCam(cam, text) {
    cam.stopLoop();
    cam.stopTracks(cam.stream);
    cam.stream = null;
    cam.video.srcObject = null;
    cam.rawBlobs = [];
    cam.occlusion.reset();
    cam.lastOcclusion = emptyOcclusion();
    syncPersonNote(document, false);
    cam.cameraButton.textContent = 'Use camera';
    if (cam.markersOn) cam.setMarkersEnabled(false);
    cam.say(text || 'Camera off');
    cam.drawOverlay();
  }

export function startLoopCam(cam) {
    if (!cam.raf) cam.raf = requestAnimationFrame(cam.loop);
  }

export function stopLoopCam(cam) {
    cancelAnimationFrame(cam.raf);
    cam.raf = 0;
  }

export async function openCam(cam, deviceId) {
    const md = navigator.mediaDevices;
    const next = await acquireCameraStream(md, deviceId);
    const previous = cam.stream;
    try {
      await playPreview(cam.video, next);
    } catch (err) {
      cam.stopTracks(next);
      if (previous && previous !== next) {
        try { await playPreview(cam.video, previous); } catch { cam.video.srcObject = previous; }
      } else if (!previous) {
        cam.video.srcObject = null;
      }
      throw err;
    }
    if (previous && previous !== next) cam.stopTracks(previous);
    cam.stream = next;
    const track = next.getVideoTracks()[0];
    if (track) track.addEventListener('unmute', () => { cam.rebuild(); cam.drawOverlay(); });
    cam.startLoop();
    cam.cameraButton.textContent = 'Stop camera';
  }

export async function enumerateAndPickCam(cam, saved) {
    const md = navigator.mediaDevices;
    const found = await md.enumerateDevices();
    cam.choices = cameraChoices(found);
    const pick = pickCamera(cam.choices, saved || cam.settings());
    cam.fillSelect(pick ? pick.deviceId : '');
    return pick;
  }

export async function startCameraCam(cam) {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia || !md.enumerateDevices) {
      cam.say('Camera unavailable');
      return;
    }
    cam.say('Asking for the camera');
    const saved = readCameraSettings(memoryOf(null));
    try {
      await cam.open(saved && saved.deviceId || '');
    } catch (err) {
      if (saved && saved.deviceId) {
        try { await cam.open(''); } catch (again) { cam.fail(again); return; }
      } else {
        cam.fail(err);
        return;
      }
    }
    let pick = null;
    try { pick = await cam.enumerateAndPick(saved); } catch { pick = null; }
    if (pick && pick.deviceId && pick.deviceId !== cam.openedId()) {
      try { await cam.open(pick.deviceId); } catch { /* keep the camera that already opened */ }
    }
    cam.persist();
    cam.rebuild();
    cam.armMarkersIfAligned(true);
    cam.say(cam.committed.length === 4 ? 'Calibrated. Pink notes and stickers hold their place on the floor.' : 'Click Calibrate wall, then the four corners of the projection.');
  }

export async function refreshCamerasCam(cam) {
    const md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) {
      cam.say('Camera unavailable');
      return;
    }
    if (!cam.stream) {
      await cam.startCamera();
      return;
    }
    try {
      const pick = await cam.enumerateAndPick(cam.settings());
      if (pick) cam.select.value = pick.deviceId;
      cam.persist();
      cam.say(cam.choices.some(c => /iPhone\s*Camera/i.test(c.label)) ? 'iPhone Camera is in the list.' : 'Camera list updated.');
    } catch {
      cam.say('Camera list unavailable');
    }
  }

export function detectInsideCam(cam, x, y, scale) {
    if (!cam.homography) return true;
    const video = videoPointFromDetect(x, y, scale);
    const at = applyHomography(cam.homography, video.x, video.y);
    return !!(at && at.x >= 0 && at.y >= 0 && at.x <= CANVAS_W && at.y <= CANVAS_H);
  }

export function stagePointFromDetectCam(cam, blob, scale) {
    return stageMarkerFromDetect(blob, scale, cam.homography);
  }

export function setStageScanCam(cam, flash, until) {
    const room = document.getElementById('nd-room-lab');
    if (!room) return;
    const next = flash === 'black' || flash === 'white' || flash === 'gray' ? flash : null;
    if (next) {
      room.dataset.ndScanMode = next;
      room.dataset.ndScanUntil = String(until || 0);
    } else {
      delete room.dataset.ndScanMode;
      delete room.dataset.ndScanUntil;
    }
    if (next === cam.shownFlash) return;
    cam.shownFlash = next;
    if (!next) ensureControlsPill(document);
    const nd = room.neuralDance;
    if (nd && typeof nd.redraw === 'function') nd.redraw();
  }

export function publishScanCam(cam) {
    const markers = cam.stickerScan.markers();
    cam.tracker.replaceStage(markers);
    cam.publish(toDancerMarkers(markers));
  }

export function finishScanCam(cam) {
    if (cam.scanConfirmed) {
      cam.stickerScan.observe(cam.scanAccum, {scanned: true});
      cam.scanAuthority = cam.stickerScan.markers().length > 0;
      cam.publishScan();
    }
    cam.scanAccum = [];
    cam.scanConfirmed = false;
  }

export function steerScanCam(cam, now) {
    const aligning = document.body && document.body.classList.contains('nd-live-aligning');
    // Scans run without a finished align. Missing homography uses the camera frame as the stage.
    const blocked = aligning || cam.personBlocked || cam.latencyOn;
    const tick = cam.scanClock.tick(now, {blocked});
    if (tick.aborted) {
      cam.scanAccum = [];
      cam.scanConfirmed = false;
    }
    if (tick.done) cam.finishScan();
    cam.setStageScan(tick.flash, tick.until);
    return tick;
  }

export function paintScanButtonsCam(cam) {
    const label = cam.scanClock.mode === 'off' ? 'Scan: off' : 'Scan: ' + cam.scanClock.mode;
    const pressed = cam.scanClock.mode !== 'off';
    for (const button of document.querySelectorAll('[data-scan-mode]')) {
      button.textContent = label;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
  }

export function setScanCam(cam, next = {}) {
    const aborted = cam.scanClock.configure(next);
    if (aborted && aborted.aborted) {
      cam.scanAccum = [];
      cam.scanConfirmed = false;
      cam.setStageScan(null, 0);
    }
    writeScanSettings(memoryOf(null), {
      mode: cam.scanClock.mode,
      intervalMs: cam.scanClock.intervalMs,
      durationMs: cam.scanClock.durationMs
    });
    cam.paintScanButtons();
  }

export function readPersonCam(cam, frame, scale) {
    // Align and Scan stickers own the projector; never let person-pause block
    // them or latch on ambient wash during those phases (TJ 4:42 PM).
    const aligningNow = !!(document.body && (
      document.body.classList.contains('nd-live-aligning') ||
      document.body.classList.contains('nd-align-clean')
    ));
    const scanningNow = cam.stickerScanHoldActive();
    const roomNow = typeof document !== 'undefined' ? document.getElementById('nd-room-lab') : null;
    const stageFlash = !!(roomNow && roomNow.dataset && (
      roomNow.dataset.ndScanFlash === '1' ||
      roomNow.dataset.ndAlignFlash === 'white' ||
      (+roomNow.dataset.ndAlignFlashAlpha || 0) > 0.05
    ));
    // Scan stickers' white hold: the gate keeps its state (no reset) and the
    // flash checks its own white frame (personInWhiteFrame). Resetting here
    // used to drop a still-present person back to 'clear' (TJ Nov 11 3:06 PM).
    if (cam.personEnabled && (scanningNow || stageFlash)) {
      cam.personGrid = null;
      return {skip: true, present: false, holding: false};
    }
    if (!cam.personEnabled || aligningNow) {
      cam.personGrid = null;
      if (cam.lastOcclusion.paused || cam.lastOcclusion.settling) {
        cam.occlusion.reset();
        cam.lastOcclusion = emptyOcclusion();
        syncPersonNote(document, false);
      }
      return {present: false, holding: false};
    }
    const projected = cam.homography ? projectedFromEcho(cam.echo, (x, y) => {
      const video = videoPointFromDetect(x, y, scale);
      return applyHomography(cam.homography, video.x, video.y);
    }) : null;
    const reference = cam.referenceFor(frameMedianLum(frame.data, frame.width, frame.height, null) >= 110 ? 'white' : 'black', frame);
    // Gate on the stage (with a margin) as Nov 6 did: the whole-frame median
    // includes the dark wall, so a body never read as darker than the floor.
    const frameQuad = cam.painting.frameQuad() || cam.painting.pending();
    const contentQuad = frameQuad ? frameQuad.map(p => ({x: p.x * frame.width, y: p.y * frame.height})) : null;
    const read = personInFrame(frame.data, frame.width, frame.height, {
      sensitivity: cam.personSensitivity,
      projected,
      reference,
      previous: cam.personGrid,
      background: cam.personBackground,
      contentQuad,
      inVisit: cam.visitClean === true,
      inside: cam.homography ? (x, y) => personStageInside(cam.homography, x, y, scale) : null
    });
    cam.personGrid = read.grid || null;
    return read;
  }

export function personInWhiteFrameCam(cam, frame) {
    if (!cam.personEnabled || !frame || !frame.data) return false;
    // On the painting the white flash lights dark paint, which reads as a
    // dark body against the 'white floor' every time. Use the last show-light
    // verdict instead: that gate knows the painting (static background).
    if (cam.painting.active()) return !!(cam.lastPersonRead && (cam.lastPersonRead.present || cam.lastPersonRead.holding));
    const scale = frame.scale || {scaleX: 1, scaleY: 1, width: frame.width, height: frame.height};
    const read = personInFrame(frame.data, frame.width, frame.height, {
      sensitivity: cam.personSensitivity,
      reference: cam.referenceFor('white', frame),
      inside: cam.homography ? (x, y) => personStageInside(cam.homography, x, y, scale) : null
    });
    return !!(read && (read.present || read.holding));
  }

export function referenceForCam(cam, mode, frame) {
    return cam.stickerScan.referenceLum(mode, frame.width, frame.height);
  }

export function adoptLagCam(cam, stats) {
    if (!stats || !Number.isFinite(+stats.lagMs)) return;
    const first = !(cam.lastLatency.samples > 0);
    cam.lastLatency = {lagMs: +stats.lagMs, jitterMs: +stats.jitterMs || 0, samples: stats.samples | 0};
    writeLatency(memoryOf(null), cam.lastLatency);
    cam.blankSettle.setLatency(cam.lastLatency.lagMs);
    const base = readScanSettings(memoryOf(null)).durationMs;
    cam.scanClock.configure({holdMs: blankHoldForLag({lagMs: cam.lastLatency.lagMs, jitterMs: cam.lastLatency.jitterMs, baseMs: base})});
    cam.scanStats.holdMs = cam.scanClock.durationMs;
    if (cam.latencyOn && first && cam.lastLatency.samples > 0) {
      cam.say('Latency ~' + Math.round(cam.lastLatency.lagMs) + ' ms · hold ' + (cam.scanStats.holdMs | 0) + ' ms');
    }
  }

export function sampleLatencyCam(cam, frame) {
    if (!frame || !frame.data) return null;
    if (cam.homography && cam.committed.length === 4 && cam.video.videoWidth) {
      const videoW = cam.video.videoWidth;
      const videoH = cam.video.videoHeight;
      const dst = cam.committed.map(corner => ({x: corner.x * videoW, y: corner.y * videoH}));
      const inverse = solveHomography(PROJECTION_CORNERS, dst);
      if (inverse) {
        const scale = frame.scale || detectionSize(videoW, videoH);
        const sx = scale.scaleX || 1;
        const sy = scale.scaleY || 1;
        const lumas = [];
        for (const cell of latencyStageLayout()) {
          const at = applyHomography(inverse, cell.x, cell.y);
          if (!at) return decodeLatencyFrame(frame.data, frame.width, frame.height);
          const edge = applyHomography(inverse, cell.x + cell.size / 2, cell.y);
          const x = at.x / sx;
          const y = at.y / sy;
          let radius = 2;
          if (edge) {
            const dx = (edge.x - at.x) / sx;
            const dy = (edge.y - at.y) / sy;
            radius = Math.max(2, Math.round(Math.hypot(dx, dy) * 0.55));
          }
          lumas.push(sampleCellLuma(frame.data, frame.width, frame.height, x, y, radius));
        }
        let hit = decodeLatencySamples(lumas);
        if (hit) return hit;
        // Same chrome-offset search as decodeLatencyFrame, but through the homography.
        const span = 620 * 0.12;
        for (const dy of [span * 0.35, span * 0.7, span, -span * 0.25, span * 1.3]) {
          const lumas2 = [];
          for (const cell of shiftLatencyLayout(dy)) {
            const at = applyHomography(inverse, cell.x, cell.y);
            if (!at) break;
            const edge = applyHomography(inverse, cell.x + cell.size / 2, cell.y);
            const x = at.x / sx;
            const y = at.y / sy;
            let radius = 2;
            if (edge) {
              const dx = (edge.x - at.x) / sx;
              const dy2 = (edge.y - at.y) / sy;
              radius = Math.max(2, Math.round(Math.hypot(dx, dy2) * 0.55));
            }
            lumas2.push(sampleCellLuma(frame.data, frame.width, frame.height, x, y, radius));
          }
          if (lumas2.length === latencyStageLayout().length) {
            hit = decodeLatencySamples(lumas2);
            if (hit) return hit;
          }
        }
      }
    }
    return decodeLatencyFrame(frame.data, frame.width, frame.height);
  }

export function publishLatencyCam(cam, now) {
    const room = document.getElementById('nd-room-lab');
    if (!room) return;
    if (!cam.latencyOn) {
      if (room.dataset.latencyTest) delete room.dataset.latencyTest;
      return;
    }
    const frameIndex = cam.latencyCounter & 0xfff;
    cam.latencyCounter = (cam.latencyCounter + 1) & 0xfff;
    cam.latencyTracker.shown(frameIndex, now);
    room.dataset.latencyTest = '1';
    room.dataset.latencyFrame = String(frameIndex);
    room.dataset.latencyMs = String(Math.round(now));
    const nd = room.neuralDance;
    if (nd && typeof nd.redraw === 'function') nd.redraw();
  }

export function setLatencyTestCam(cam, on) {
    cam.latencyOn = !!on;
    const room = document.getElementById('nd-room-lab');
    if (document.body && document.body.classList) {
      document.body.classList.toggle('nd-latency-test', cam.latencyOn);
    }
    if (room) {
      if (cam.latencyOn) room.dataset.latencyTest = '1';
      else {
        delete room.dataset.latencyTest;
        delete room.dataset.latencyFrame;
        delete room.dataset.latencyMs;
      }
      const nd = room.neuralDance;
      if (nd && typeof nd.redraw === 'function') nd.redraw();
    }
  }

export function stopLatencyTestCam(cam, message) {
    if (cam.latencyTimer) {
      clearTimeout(cam.latencyTimer);
      cam.latencyTimer = 0;
    }
    if (!cam.latencyOn) return;
    cam.setLatencyTest(false);
    if (message) cam.say(message);
  }

export function startLatencyTestCam(cam, durationMs = 10000) {
    // One click starts a timed run. A second click while running restarts it.
    if (cam.latencyTimer) {
      clearTimeout(cam.latencyTimer);
      cam.latencyTimer = 0;
    }
    cam.latencyTracker.reset();
    cam.setLatencyTest(true);
    cam.say('Latency test running…');
    const budget = Math.min(15000, Math.max(3000, +durationMs || 10000));
    cam.latencyTimer = setTimeout(() => {
      cam.latencyTimer = 0;
      const lag = Number.isFinite(+cam.lastLatency.lagMs) ? Math.round(+cam.lastLatency.lagMs) : null;
      const samples = cam.lastLatency.samples | 0;
      cam.stopLatencyTest(samples > 0 && lag != null
        ? ('Latency test done · ' + lag + ' ms lag · ' + samples + ' samples')
        : 'Latency test done · no lag reading yet. Keep the camera on the projector and retry.');
    }, budget);
  }

function paintingDetectContains(cam, x, y, width, height) {
  const src = cam && cam.painting && typeof cam.painting.scanQuad === 'function' ? cam.painting.scanQuad() : null;
  if (!src || !(width > 0) || !(height > 0)) return false;
  return frameContainsPoint(src.map(p => ({x: p.x * width, y: p.y * height})), x, y);
}

export function paintingStatsCam(cam, frame) {
    const q = cam.painting.frameQuad();
    if (!q || !frame || !frame.data) return null;
    const w = frame.width, h = frame.height, quad = q.map(p => ({x: p.x * w, y: p.y * h})), vals = [];
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
      if (!pointInQuad(quad, x, y)) continue;
      const i = (y * w + x) * 4;
      vals.push(0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2]);
    }
    if (vals.length < 20) return null;
    vals.sort((a, b) => a - b);
    return {mean: vals.reduce((a, b) => a + b, 0) / vals.length, median: vals[vals.length >> 1], p10: vals[Math.floor(vals.length * 0.1)]};
  }

export function collectScanCam(cam, frame, scale, flashMode, noEcho = false) {
    const found = [];
    const stickerMode = stickerModeForFlash(flashMode);
    const report = {area: 0, aspect: 0, edge: 0, compact: 0, ui: 0};
    if (cam.detectionMode !== 'pink') {
      const projected = (x, y) => {
        // Scan stickers: the floor is all white, so the echo history (which
        // just saw the white flash) would veto every sticker.
        if (noEcho || !cam.homography) return false;
        const video = videoPointFromDetect(x, y, scale);
        const at = applyHomography(cam.homography, video.x, video.y);
        return !!(at && cam.echo.vetoSticker(at.x, at.y));
      };
      for (const blob of scanBlankFrame(frame.data, frame.width, frame.height, {
        settled: true,
        mode: stickerMode,
        sensitivity: cam.sticker ? +cam.sticker.value : 0.5,
        reference: cam.referenceFor(stickerMode, frame),
        exclude: [],
        inside: (x, y) => cam.detectInside(x, y, scale),
        projected,
        report
      })) found.push(blob);
    }
    cam.scanStats.rejected.area += report.area || 0;
    cam.scanStats.rejected.aspect += report.aspect || 0;
    cam.scanStats.rejected.edge += report.edge || 0;
    cam.scanStats.rejected.compact += report.compact || 0;
    cam.scanStats.rejected.ui += report.ui || 0;
    if (report.echo) cam.scanStats.rejected.echo = (cam.scanStats.rejected.echo || 0) + (report.echo || 0);
    if (cam.detectionMode !== 'stickers') {
      const gate = markerFrameGate(cam.homography, cam.uiExclusions());
      for (const blob of detectPinkMarkers(frame.data, frame.width, frame.height, {
        ...cam.settings(),
        homography: gate.homography,
        scale,
        exclude: gate.exclude
      })) found.push({...blob, kind: 'pink'});
    }
    const stagePoints = [];
    const videos = [];
    for (const blob of found) {
      const video = videoPointFromDetect(blob.x, blob.y, scale);
      videos.push({x: video.x, y: video.y, area: blob.area || 0, kind: blob.kind || 'sticker'});
      const stage = cam.stagePointFromDetect(blob, scale);
      if (stage) stagePoints.push(stage);
    }
    return {stagePoints, videos};
  }

export function nearKnownStickerCam(cam, x, y, radius = 44, opts = {}) {
    const scannedOnly = !!(opts && opts.scannedOnly);
    const marks = scannedOnly
      ? cam.stickerScan.markers().filter(m => m && m.scanned).concat(cam.manuals.list() || [])
      : cam.stickerScan.markers().concat(cam.manuals.list() || []);
    for (const m of marks) {
      if (m && Number.isFinite(+m.x) && Number.isFinite(+m.y) && Math.hypot(+m.x - x, +m.y - y) <= radius) return true;
    }
    return false;
  }

export function nearSimDancerCam(cam, x, y, radius = NEAR_LATCH_GAP) {
    const room = document.getElementById('nd-room-lab');
    const nd = room && room.neuralDance;
    const list = nd && typeof nd.simList === 'function' ? nd.simList() : null;
    if (!Array.isArray(list) || !list.length) return false;
    const r = Number.isFinite(+radius) ? +radius : NEAR_LATCH_GAP;
    for (const d of list) {
      if (d && Number.isFinite(+d.x) && Number.isFinite(+d.y) && Math.hypot(+d.x - x, +d.y - y) <= r) return true;
    }
    return false;
  }

export function stickerScanHoldActiveCam(cam) {
    const room = document.getElementById('nd-room-lab');
    return !!(room && room.dataset && room.dataset.ndStickerScan === '1');
  }

export function collectContinuousStickersCam(cam, frame, scale) {
    const found = [];
    const report = {area: 0, aspect: 0, edge: 0, compact: 0, ui: 0};
    if (cam.detectionMode === 'pink') return {stagePoints: [], videos: [], report};
    const gate = markerFrameGate(cam.homography, cam.uiExclusions());
    const shared = {
      ...cam.settings(),
      stickerSensitivity: continuousSensitivity(cam.sticker ? +cam.sticker.value : DEFAULTS.stickerSensitivity),
      homography: gate.homography,
      scale,
      exclude: gate.exclude
    };
    const reach = continuousVetoReach(cam.sticker ? +cam.sticker.value : DEFAULTS.stickerSensitivity);
    for (const blob of detectStickerBlobs(frame.data, frame.width, frame.height, shared)) {
      found.push(blob);
    }
    let videos = [];
    const stagePoints = [];
    for (const blob of found) {
      const videoPt = videoPointFromDetect(blob.x, blob.y, scale);
      const item = {x: videoPt.x, y: videoPt.y, area: blob.area || 0, kind: 'sticker'};
      if (blob.contour) item.contour = blob.contour;
      if (cam.homography) {
        const at = applyHomography(cam.homography, videoPt.x, videoPt.y);
        // A latched (or manual) sticker gets a floor dot drawn on it; that dot
        // must not veto the sticker under it, or the marker drops and flickers.
        // New candidates must clear projected-light veto (sims, strings,
        // chakras, ripples). Known stickers still update under their own glow.
        const known = at && cam.nearKnownSticker(at.x, at.y);
        // Scan-placed (and manual) stickers may sit under their own glow and
        // under ripples; skip the echo veto so they can keep updating. Auto-
        // latched ghosts must still be vetoed by projected ripples or they
        // never miss and never expire (TJ 9:01 PM).
        const trusted = at && cam.nearKnownSticker(at.x, at.y, 44, {scannedOnly: true});
        if (at && !trusted && cam.echo.vetoSticker(at.x, at.y, Math.max(reach, 10))) { report.echo = (report.echo || 0) + 1; continue; }
        if (at) {
          // Only the floor the align circles bound counts (Nov 9, 3:39 PM: a
          // green glow under the projected Controls chip latched up-left of
          // circle 1). Top band stays wide for Safari's toolbar.
          const underUi = cam.uiExclusions().some(rect => at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h);
          if (underUi) { report.ui++; continue; }
          // Continuous: inset from the play edge so corner glare / build pill
          // cannot seed a latch chain (TJ 4:34–4:35 PM). Known stickers may
          // still update at the looser play rect.
          if (cam.painting.active()) {
            if (!paintingDetectContains(cam, blob.x, blob.y, frame.width, frame.height)) continue;
          } else if (!stickerInPlay(at.x, at.y, cam.uiExclusions(), undefined, {edgeInset: known ? 0 : PLAY_EDGE_INSET})) continue;
          // No NEW continuous latch within ~1.5 dancer widths of an existing one.
          if (!known && cam.nearKnownSticker(at.x, at.y, NEAR_LATCH_GAP)) continue;
          // Exclude every projected sim (echo can miss dim silhouettes).
          if (!known && cam.nearSimDancer(at.x, at.y, NEAR_LATCH_GAP)) continue;
          stagePoints.push(continuousStagePoint(blob, scale, cam.homography, at));
        }
      } else {
        const mapped = stageMarkerFromDetect(blob, scale, null);
        if (mapped) stagePoints.push(mapped);
      }
      videos.push(item);
    }
    // Merge near-duplicate blobs so one physical sticker is one observe.
    return {stagePoints: mergeScanPoints(stagePoints, 48), videos, report};
  }

export function detectCam(cam, now, tick) {
    if (!videoFrameReady(cam.video)) return;
    const vw = cam.video.videoWidth;
    const vh = cam.video.videoHeight;
    if (vw > 0) cam.lastVideoWidth = vw;
    if (vh > 0) cam.lastVideoHeight = vh;
    if (!cam.homography && cam.committed.length === 4) cam.rebuild();
    const scale = detectionSize(vw, vh);
    if (cam.scratch.width !== scale.width) cam.scratch.width = scale.width;
    if (cam.scratch.height !== scale.height) cam.scratch.height = scale.height;
    if (!drawVideoFrame(cam.video, cam.sctx, scale.width, scale.height)) return;
    const frame = cam.sctx.getImageData(0, 0, scale.width, scale.height);
    cam.lastDetectFrame = frame;
    if (cam.latencyOn) {
      const decoded = cam.sampleLatency({data: frame.data, width: frame.width, height: frame.height, scale});
      if (decoded) {
        const stats = cam.latencyTracker.observe(now, decoded.frame);
        if (stats) cam.adoptLag(stats);
      }
    }
    const flashing = tick && (tick.flash === 'black' || tick.flash === 'white' || tick.flash === 'gray');
    const roomNow = document.getElementById('nd-room-lab');
    const aligningNow = !!(document.body && document.body.classList.contains('nd-live-aligning')) || !!(roomNow && roomNow.dataset && roomNow.dataset.ndAlignOwn === '1');
    // A quad set by hand owns the mapping until the next Align: the screen-border
    // lock must not replace it (and wipe the stickers) or nag with refusals.
    // The background screen-border lock only owns a quad it found itself.
    // After Align it used to replace the Align quad with the physical screen
    // edge a few seconds later (TJ 10:35 AM: projection slid off the stickers).
    const borderOwnsQuad = cam.committed.length !== 4 || cam.quadSource === 'border' || cam.quadSource === 'border-lock';
    if (!cam.manualLocked && !cam.manualQuad && borderOwnsQuad && !aligningNow && !cam.latencyOn && now - cam.lastBorderAt > 1000) {
      cam.lastBorderAt = now;
      const fit = fitScreenBorder(frame.data, frame.width, frame.height);
      if (fit && fit.ok && fit.corners) {
        const held = cam.quadLock.observe(fit.corners);
        if (held.replaced && held.quad) {
          cam.commitCorners(held.quad, 'Screen quad held.', {fromLock: true, quiet: true});
        }
      }
    }
    const stage = document.querySelector('#nd-room-lab [data-stage]');
    if (stage && !flashing) cam.echo.sample(stage, now);
    const person = cam.readPerson(frame, scale);
    if (person && !person.skip) cam.lastPersonRead = person;
    cam.lastPerson = person && !person.skip ? person : cam.lastPerson;
    // During the scan's white hold the gate is frozen (no observe, no reset).
    const decision = person && person.skip ? {...cam.lastOcclusion, flashRescan: false, rescan: false} : cam.occlusion.observe({
      person: cam.personEnabled ? person : false,
      stickers: cam.stickerScan.markers(),
      now
    });
    cam.lastOcclusion = decision;
    // Learn the unchanging stage (painting) only while nobody is there; the
    // first few frames after a reset seed it regardless.
    if (person && person.cells) {
      cam.personBackground.update(person.cells, person.cols, person.rows, {clear: !decision.paused && !person.holding, now, global: !!person.globalChange});
    }
    // Paused AND settling both block latching (TJ 4:20 PM: settle window).
    cam.personBlocked = !!(decision.paused || person.present || person.holding);
    if (decision.flashRescan) cam.personFlashDue = true;
    syncPersonNote(document, decision.note || false);
    if (cam.personFlashDue) {
      try { document.dispatchEvent(new CustomEvent('nd-person-clear-rescan')); } catch {}
    }
    // Close-up OK hand → Scan stickers (either hand). Skip during Align/Scan
    // flash so the white frame is not mistaken for skin wash.
    if (!aligningNow && !flashing && !cam.stickerScanHoldActive()) {
      cam.lastOkHand = cam.okHandWatcher.observe(frame.data, frame.width, frame.height, now);
      // A real close-up hand also trips the person gate. Blocking on the OK
      // watcher alone deferred Scan stickers on a clear floor (studio #0119).
      if (cam.lastOkHand && cam.lastOkHand.blocking && (person.present || person.holding)) cam.personBlocked = true;
      if (cam.okHandWatcher.consumeFire()) {
        cam.okHandFireDue = true;
        try { document.dispatchEvent(new CustomEvent('nd-ok-hand-scan')); } catch {}
      }
    } else {
      cam.lastOkHand = cam.okHandWatcher.status(now);
    }
    const inside = (x, y) => cam.detectInside(x, y, scale);
    cam.scanStats.personPause = !!cam.personBlocked;
    // Candidates are cleared unless this frame is a settled blank. A show
    // frame must not keep the yellow rings that were sitting on projected light.
    const capture = !!(tick && tick.capture && (tick.flash === 'black' || tick.flash === 'white' || tick.flash === 'gray') && cam.scanClock.mode !== 'off');
    if (capture) {
      const matched = blankFrameVerified(frame.data, frame.width, frame.height, tick.flash, inside)
        || (cam.scanBaseline != null && frameMatchesFlash(frame.data, frame.width, frame.height, tick.flash, inside, cam.scanBaseline))
        || (tick.flash === 'white' && cam.painting.active() && paintingFlashLit(cam.paintingStats(frame)));
      if (!matched) cam.scanStats.rejected.flash++;
      // White/black Scan must ignore stage-echo (projected sims/strings) or the
      // middle stickers under dancers are rejected as "projected" (TJ 5:05 PM).
      const hits = matched ? cam.collectScan(frame, scale, tick.flash, true) : {stagePoints: [], videos: []};
      cam.scanStats.lastScanAt = now;
      cam.scanStats.scanCount++;
      cam.scanStats.rawCount = hits.videos.length;
      cam.scanStats.candidates = hits.videos.map(blob => ({
        x: blob.x / Math.max(1, cam.video.videoWidth || cam.lastVideoWidth || 1),
        y: blob.y / Math.max(1, cam.video.videoHeight || cam.lastVideoHeight || 1),
        kind: blob.kind || 'sticker'
      }));
      let kept = 0;
      const accepted = [];
      for (let i = 0; i < hits.stagePoints.length; i++) {
        const stage = hits.stagePoints[i];
        const border = 0.04;
        const underUi = cam.uiExclusions().some(rect => stage && stage.x >= rect.x && stage.x <= rect.x + rect.w && stage.y >= rect.y && stage.y <= rect.y + rect.h);
        const onPainting = cam.painting.active();
        if (!stage || stage.x < CANVAS_W * border || stage.y < CANVAS_H * border || stage.x > CANVAS_W * (1 - border) || stage.y > CANVAS_H * (1 - border) || (stage.kind !== 'pink' && !underUi && !onPainting && !stickerInPlay(stage.x, stage.y))) {
          cam.scanStats.rejected.offstage++;
          continue;
        }
        if (underUi) {
          cam.scanStats.rejected.ui++;
          continue;
        }
        accepted.push(stage);
        kept++;
      }
      if (kept) {
        cam.scanAccum = mergeScanPoints(cam.scanAccum.concat(accepted));
        cam.scanConfirmed = true;
      }
      cam.rawBlobs = hits.videos;
    } else {
      cam.rawBlobs = [];
      cam.scanStats.candidates = [];
      if (!flashing) {
        const median = frameMedianLum(frame.data, frame.width, frame.height, inside);
        if (median != null) cam.scanBaseline = median;
        if (cam.painting && cam.painting.observe) cam.painting.observe(frame, {blocked: cam.personBlocked, flashing, now});
        // Painting stickers come from the white-flash diff. Live frames must
        // not hunt, slide, or drift-correct dancers between those scans.
        const paintingLive = !!(cam.painting && cam.painting.active && cam.painting.active());
        if (paintingLive) {
          cam.rawBlobs = [];
          cam.scanStats.rawCount = 0;
          cam.scanStats.candidates = [];
        } else if (cam.markersOn && cam.detectionMode !== 'pink' && !cam.personBlocked && !cam.stickerScanHoldActive() && now >= cam.latchHoldUntil) {
          const hits = cam.painting.darkDetectionAllowed() ? cam.collectContinuousStickers(frame, scale) : {stagePoints: [], videos: [], report: {}};
          // New dancers are born only by Scan stickers (the button, or once
          // after a visit). Continuous frames must not open a track.
          cam.scanStats.rawCount = hits.videos.length;
          cam.scanStats.candidates = hits.videos.map(blob => ({
            x: blob.x / Math.max(1, cam.video.videoWidth || cam.lastVideoWidth || 1),
            y: blob.y / Math.max(1, cam.video.videoHeight || cam.lastVideoHeight || 1),
            kind: 'sticker'
          }));
          cam.rawBlobs = hits.videos;
          // Persist ~1 s before latch; never publish provisional tracks.
          // Stickers must never clear or replace seeded sims (TJ 4:37 PM).
          // A latched sticker under its own projected dancer is hidden by our
          // light, so that frame is not a miss (TJ 10:03 AM pop-in/vanish loop).
          // The latched set only grows on an explicit Scan stickers. Between
          // scans a hit may slide a sticker a short way; it may not add one.
          cam.stickerScan.observe(hits.stagePoints, {
            allowNew: false,
            latchNew: false,
            covered: (x, y) => cam.echo.veto(x, y) || cam.echo.vetoSticker(x, y, 10)
          });
          // Continuous drift correction from the stickers the camera already sees.
          if (cam.committed.length === 4 && !aligningNow && !cam.quadLock.locked() && now - cam.lastDriftAt > DRIFT_CHECK_MS) {
            cam.lastDriftAt = now;
            const drift = cam.driftWatch.check(cam.scanStats.candidates, cam.committed);
            if (drift && drift.applied && drift.quad) cam.commitCorners(drift.quad, 'Drift corrected.', {drift: true, quiet: true});
          }
        } else if (cam.personBlocked) {
          // Keep latched markers, but stop adding and keep telemetry honest.
          cam.scanStats.rawCount = 0;
          cam.scanStats.candidates = [];
          cam.rawBlobs = [];
        }
        cam.publishScan();
      }
    }
    if (cam.root.dataset.debugStream === '1') cam.debugCache = detectionTelemetry(cam.rawBlobs, frame.data, frame.width, frame.height, scale, cam.homography);
    if (now - cam.lastStatus > 800) {
      cam.lastStatus = now;
      if (!cam.draft) {
        const placed = cam.stickerScan.markers().length;
        if (cam.personBlocked) cam.say('Person in frame · detection paused · ' + placed + ' latched');
        else cam.say(cam.scanClock.mode === 'off'
          ? 'Scan off · ' + placed + ' latched'
          : 'Scan ' + cam.scanClock.mode + ' · ' + placed + ' latched') + (cam.stickerCal ? ' · calibration residual ' + cam.stickerCal.residual.toFixed(1) + ' px' : '');
      }
    }
  }

export function loopCam(cam, now) {
    cam.raf = requestAnimationFrame(cam.loop);
    if (cam.root.dataset.debugStream === '1') {
      if (!cam.debugFpsStamp) cam.debugFpsStamp = now;
      cam.debugFpsFrames++;
      if (now - cam.debugFpsStamp >= 1000) {
        cam.debugFps = cam.debugFpsFrames * 1000 / (now - cam.debugFpsStamp);
        cam.debugFpsFrames = 0;
        cam.debugFpsStamp = now;
      }
    }
    const track = cam.stream && cam.stream.getVideoTracks()[0];
    if (!cam.stream || !track || track.readyState !== 'live') return;
    if (track.muted || !videoFrameReady(cam.video)) {
      if (!cam.draft && now - cam.lastStatus > 800) {
        cam.lastStatus = now;
        cam.say('Waiting for a picture from the camera.');
      }
      cam.drawOverlay();
      return;
    }
    if (cam.latencyOn) cam.publishLatency(now);
    const tick = cam.steerScan(now);
    if (tick && tick.started) cam.blankSettle.begin(tick.flash);
    else if (tick && tick.flash) tick.capture = cam.blankSettle.frame(now);
    else cam.blankSettle.clear();
    if ((tick && tick.capture) || now - cam.lastDetect >= 100) {
      cam.lastDetect = now;
      cam.detect(now, tick);
    }
    cam.drawOverlay();
  }

export function activeCornersCam(cam) {
    return cam.draft || cam.committed;
  }

export function drawOverlayCam(cam) {
    const vw = cam.video.videoWidth || cam.overlay.clientWidth || 16;
    const vh = cam.video.videoHeight || cam.overlay.clientHeight || 9;
    if (cam.overlay.width !== vw) cam.overlay.width = vw;
    if (cam.overlay.height !== vh) cam.overlay.height = vh;
    cam.octx.clearRect(0, 0, cam.overlay.width, cam.overlay.height);
    drawVideoFrame(cam.video, cam.octx, cam.overlay.width, cam.overlay.height);
    if (cam.stickerCrosshair) cam.paintProjectorCrosshairs();
    const corners = cam.activeCorners();
    if (corners.length) {
      cam.octx.strokeStyle = '#38bdf8';
      cam.octx.fillStyle = '#38bdf8';
      cam.octx.lineWidth = Math.max(2, vw / 400);
      cam.octx.beginPath();
      corners.forEach((corner, i) => {
        const x = corner.x * vw;
        const y = corner.y * vh;
        if (i) cam.octx.lineTo(x, y);
        else cam.octx.moveTo(x, y);
      });
      if (corners.length === 4) cam.octx.closePath();
      cam.octx.stroke();
      corners.forEach((corner, i) => {
        const x = corner.x * vw;
        const y = corner.y * vh;
        cam.octx.beginPath();
        cam.octx.arc(x, y, Math.max(6, vw / 120), 0, Math.PI * 2);
        cam.octx.fill();
        cam.octx.fillStyle = '#07080c';
        cam.octx.font = Math.max(12, vw / 50) + 'px sans-serif';
        cam.octx.fillText(String(i + 1), x - 4, y + 4);
        cam.octx.fillStyle = '#38bdf8';
      });
    }
    const frameQuad = (cam.frameDraft && cam.frameDraft.length === 4) ? cam.frameDraft : (cam.painting.frameQuad() || cam.painting.pending());
    if (frameQuad && frameQuad.length === 4) {
      cam.octx.strokeStyle = '#9cff8a';
      cam.octx.lineWidth = Math.max(2, vw / 400);
      cam.octx.beginPath();
      frameQuad.forEach((corner, i) => {
        const x = corner.x * vw, y = corner.y * vh;
        if (i) cam.octx.lineTo(x, y); else cam.octx.moveTo(x, y);
      });
      cam.octx.closePath();
      cam.octx.stroke();
      cam.octx.font = '700 ' + Math.max(11, vw / 58) + 'px sans-serif';
      cam.octx.textAlign = 'center';
      cam.octx.textBaseline = 'middle';
      frameQuad.forEach((corner, i) => {
        const x = corner.x * vw, y = corner.y * vh;
        cam.octx.beginPath();
        cam.octx.fillStyle = '#07140c';
        cam.octx.arc(x, y, Math.max(7, vw / 100), 0, Math.PI * 2);
        cam.octx.fill();
        cam.octx.fillStyle = '#9cff8a';
        cam.octx.fillText('F' + (i + 1), x, y);
      });
      cam.octx.textAlign = 'start';
      cam.octx.textBaseline = 'alphabetic';
    }
    for (const blob of cam.rawBlobs) {
      cam.octx.strokeStyle = blob.kind === 'sticker' ? '#7fe8b3' : '#38bdf8';
      cam.octx.beginPath();
      cam.octx.arc(blob.x, blob.y, Math.max(8, vw / 80), 0, Math.PI * 2);
      cam.octx.stroke();
    }
    const marks = cam.alignReport && cam.alignReport.marks;
    if (marks) {
      cam.octx.font = '700 ' + Math.max(16, vw / 36) + 'px sans-serif';
      cam.octx.textAlign = 'center';
      cam.octx.textBaseline = 'middle';
      marks.forEach((mark, index) => {
        if (!mark) return;
        const x = mark.x * vw;
        const y = mark.y * vh;
        cam.octx.beginPath();
        cam.octx.strokeStyle = '#3dff9a';
        cam.octx.lineWidth = Math.max(3, vw / 180);
        cam.octx.arc(x, y, Math.max(14, vw / 48), 0, Math.PI * 2);
        cam.octx.stroke();
        cam.octx.fillStyle = '#07140c';
        cam.octx.beginPath();
        cam.octx.arc(x, y, Math.max(11, vw / 60), 0, Math.PI * 2);
        cam.octx.fill();
        cam.octx.fillStyle = '#f4f6fb';
        cam.octx.fillText(String(index + 1), x, y + 1);
      });
      cam.octx.textAlign = 'start';
      cam.octx.textBaseline = 'alphabetic';
    }
  }

export function uiExclusionsCam(cam) {
    const stage = document.querySelector('#nd-room-lab [data-stage]');
    if (!stage) return [];
    const sr = stage.getBoundingClientRect();
    if (!(sr.width > 0) || !(sr.height > 0)) return [];
    const rects = [];
    for (const sel of UI_EXCLUSION_SELECTORS) {
      // Query all matches — build pill can sit outside hidden chrome.
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (!node || node.hidden) continue;
        let style;
        try { style = getComputedStyle(node); } catch { continue; }
        // Build pill stays visible even under Hide controls (display forced).
        const force = node.hasAttribute('data-nd-build');
        if (!force && (style.display === 'none' || style.visibility === 'hidden')) continue;
        const r = node.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        // Pad: the camera-to-stage map is a few % off at the edges, and a
        // button's own shadow must not latch (3:17 PM rig: Controls chip).
        // 72: build-pill / Controls glow at corner 3 (TJ 4:34 PM).
        const pad = force ? 80 : 72;
        rects.push({
          x: (r.left - sr.left) / sr.width * CANVAS_W - pad,
          y: (r.top - sr.top) / sr.height * CANVAS_H - pad,
          w: r.width / sr.width * CANVAS_W + pad * 2,
          h: r.height / sr.height * CANVAS_H + pad * 2
        });
      }
    }
    // Always mask the projected build-pill corner (lower-right of the stage),
    // even if the DOM node is not measurable this frame.
    rects.push({x: CANVAS_W * 0.78, y: CANVAS_H * 0.82, w: CANVAS_W * 0.24, h: CANVAS_H * 0.22});
    return rects;
  }

export function setMarkersEnabledCam(cam, on, quiet) {
    if (on && cam.committed.length !== 4) {
      if (!quiet) cam.say('Calibrate the four wall corners first.');
      return;
    }
    cam.markersOn = !!on;
    cam.tracker = createMarkerTracker();
    cam.stickerScan.resetBook();
    cam.scanAuthority = false;
    cam.scanAccum = [];
    cam.scanConfirmed = false;
    cam.echo.clear();
    cam.askedStart = false;
    const room = document.getElementById('nd-room-lab');
    if (room) room.dataset.markersLive = cam.markersOn ? '1' : '';
    if (cam.markersOn) {
      cam.driving = false;
      cam.publishList([]);
      holdDarkStage(150);
    } else if (room && room.neuralDance && room.neuralDance.retint) room.neuralDance.retint();
    if (!cam.markersOn) cam.stopDriving();
    cam.syncMarkerButton();
    if (!quiet) cam.say(cam.markersOn ? 'Markers on. A note stays on the floor once it has been up for a moment.' : 'Markers off.');
  }

export async function flipCameraCam(cam) {
    if (!cam.choices.length) {
      await cam.startCamera();
      return;
    }
    const current = cam.choices.find(c => c.deviceId === cam.select.value);
    const fronts = cam.choices.filter(c => /\bfront\b|facing\s*user|selfie/i.test(c.label));
    const backs = cam.choices
      .map(choice => ({choice, rank: rearRank(choice.label)}))
      .filter(item => item.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .map(item => item.choice);
    let next = null;
    if (current && fronts.some(c => c.deviceId === current.deviceId) && backs.length) next = backs[0];
    else if (fronts.length && (!current || backs.some(c => c.deviceId === current.deviceId))) next = fronts[0];
    else {
      const index = Math.max(0, cam.choices.findIndex(c => current && c.deviceId === current.deviceId));
      next = cam.choices[(index + 1) % cam.choices.length];
    }
    if (!next) return;
    cam.select.value = next.deviceId;
    try { await cam.open(next.deviceId); cam.persist({userSelected: true}); cam.say(next.label); } catch (err) { cam.fail(err); }
  }

export function releaseManualCornersCam(cam) {
    if (!cam.manualLocked && cam.quadSource !== 'manual-lock') return;
    cam.manualLocked = false;
    if (cam.quadSource === 'manual-lock') cam.quadSource = 'saved';
    cam.persist();
  }

export function resetMarkerDefaultsCam(cam) {
    cam.releaseManualCorners();
    cam.hueCenterOverride = null;
    cam.maxBlobSize = DEFAULTS.maxBlobSize;
    cam.hue.value = String(DEFAULTS.hueTolerance);
    cam.sat.value = String(DEFAULTS.saturationSensitivity);
    cam.size.value = String(DEFAULTS.minBlobSize);
    cam.refreshLabels();
    cam.persist();
    showStageToast('Marker defaults restored', 'ok', 2500);
    cam.say('Marker defaults restored.');
  }

export function cornerHandlesCam(cam) {
    if (cam.draft && cam.draft.length === 4) return cam.draft;
    if (cam.committed.length === 4) return cam.committed;
    return null;
  }

export function frameHandlesCam(cam) {
    if (cam.frameDraft && cam.frameDraft.length === 4) return cam.frameDraft;
    const quad = cam.painting.frameQuad() || cam.painting.pending();
    return Array.isArray(quad) && quad.length === 4 ? quad : null;
  }

export function overlayVideoPointCam(cam, event) {
    const box = cam.overlay.getBoundingClientRect();
    const vw = cam.video.videoWidth || 0;
    const vh = cam.video.videoHeight || 0;
    if (vw > 0 && vh > 0) return clientToVideoNormalized(event.clientX, event.clientY, box, vw, vh);
    return clientToNormalized(event.clientX, event.clientY, box);
  }

export function cornerHitCam(cam, spot) {
    return nearestHandle(spot, [
      {kind: 'proj', handles: cam.cornerHandles() || []},
      {kind: 'frame', handles: cam.frameHandles() || []}
    ], 0.08);
  }

export function paintPauseButtonsCam(cam) {
    for (const button of cam.pauseButtons()) {
      button.setAttribute('aria-pressed', cam.personEnabled ? 'true' : 'false');
      button.textContent = cam.personEnabled ? 'Pause on' : 'Pause off';
    }
  }

export function setPersonPauseCam(cam, enabled, sensitivity = cam.personSensitivity) {
    if (enabled === true || enabled === false) cam.personEnabled = enabled;
    if (Number.isFinite(+sensitivity)) cam.personSensitivity = Math.min(1, Math.max(0, +sensitivity));
    writePersonPause(memoryOf(null), {enabled: cam.personEnabled, sensitivity: cam.personSensitivity});
    cam.paintPauseButtons();
    syncPersonPauseChip(document, cam.personEnabled);
    if (!cam.personEnabled) {
      cam.occlusion.reset();
      cam.lastOcclusion = emptyOcclusion();
      syncPersonNote(document, false);
    }
  }

export function paintGapScanButtonsCam(cam) {
    for (const button of cam.gapScanButtons()) {
      button.setAttribute('aria-pressed', cam.gapScanEnabled ? 'true' : 'false');
      button.textContent = cam.gapScanEnabled ? 'Gap scan on' : 'Gap scan off';
    }
  }

export function setGapScanEnabledCam(cam, on) {
    if (on === true || on === false) cam.gapScanEnabled = on;
    writeGapScan(memoryOf(null), cam.gapScanEnabled);
    cam.gapScanReport = {...cam.gapScanReport, enabled: cam.gapScanEnabled, state: cam.gapScanEnabled ? (cam.gapScanReport.state || '') : 'off'};
    cam.paintGapScanButtons();
    return cam.gapScanEnabled;
  }

export function publishRestoredCam(cam) {
    const list = cam.markersOn ? toDancerMarkers(cam.tracker.stage()) : [];
    const room = document.getElementById('nd-room-lab');
    if (room && room.neuralDance) {
      cam.publish(list);
      return;
    }
    if (!room || typeof MutationObserver !== 'function') return;
    const obs = new MutationObserver(() => {
      if (!room.neuralDance) return;
      obs.disconnect();
      cam.publish(cam.markersOn ? toDancerMarkers(cam.tracker.stage()) : []);
    });
    obs.observe(room, {attributes: true, attributeFilter: ['data-room-ready']});
  }

export function restoreReloadLatchCam(cam) {
    const resumed = takeReloadLatch(memoryOf(null));
    if (!resumed) return;
    if (resumed.markers.length) {
      cam.tracker.restore(resumed.markers);
      cam.stickerScan.restore(cam.tracker.stage());
      cam.scanAuthority = false;
    }
    if (resumed.manuals.length) cam.manuals.restore(resumed.manuals);
    if (resumed.markersOn && cam.committed.length === 4) {
      cam.markersOn = true;
      const room = document.getElementById('nd-room-lab');
      if (room) room.dataset.markersLive = '1';
      cam.syncMarkerButton();
      cam.publishRestored();
    } else if (resumed.manuals.length) {
      cam.publishRestored();
    }
  }

export function commitCornersCam(cam, list, message, opts) {
    if (!cornerCommitAllowed(cam.manualLocked, opts)) return false;
    const quiet = !!(opts && opts.quiet);
    const hand = !!(opts && opts.manual && !opts.fromLock && !opts.drift);
    if (hand) {
      const decision = acceptManualCorners(list);
      if (!decision.ok) {
        if (!quiet) cam.say(decision.reason);
        cam.alignReport = {
          found: [false, false, false, false],
          reason: decision.reason,
          marks: [],
          quad: list.map(corner => ({x: +corner.x, y: +corner.y})),
          skew: null
        };
        return false;
      }
    } else {
      let lit = null;
      let chrome = null;
      if (cam.lastDetectFrame && cam.lastDetectFrame.data) {
        lit = litRegionBounds(cam.lastDetectFrame.data, cam.lastDetectFrame.width, cam.lastDetectFrame.height);
        chrome = detectProjectedBrowserChrome(cam.lastDetectFrame.data, cam.lastDetectFrame.width, cam.lastDetectFrame.height, lit);
      }
      const explained = explainAlignmentQuad(list, {lit, chrome});
      if (explained.ok && explained.warning && !quiet) cam.say(explained.warning);
      if (!explained.ok) {
        if (opts && opts.fromLock) return false; // background refinement: no report, no nag
        if (!quiet) cam.say(explained.reason || 'Align refused: bad wall quad.');
        cam.alignReport = {
          found: [false, false, false, false],
          reason: explained.reason || 'bad quad',
          marks: [],
          quad: list.map(corner => ({x: +corner.x, y: +corner.y})),
          skew: explained.skew || null
        };
        return false;
      }
    }
    if (!(opts && opts.fromLock)) {
      if (!(opts && opts.drift)) cam.manualQuad = !!(opts && opts.manual);
      // A committed quad supersedes any earlier refusal on screen and in debug.
      if (cam.alignReport && cam.alignReport.reason && /refused|not a usable|not found/i.test(cam.alignReport.reason)) cam.alignReport = null;
    }
    const next = list.map(corner => ({x: +corner.x, y: +corner.y}));
    // A new wall quad moves every stage position: latched stickers from the
    // old quad are stale duplicates (3:16 PM rig: 2 -> 5 -> 11 markers).
    // Re-latch from the camera (~1 s). Lock refinements under 2% keep them.
    const shift = cam.committed.length === 4 ? Math.max(...next.map((c, i) => Math.hypot(c.x - cam.committed[i].x, c.y - cam.committed[i].y))) : 0;
    // The sticker check moves dancers onto their stickers: even a small
    // correction must re-latch, or latched stage positions stay offset.
    const relatch = shift > 0.02 || !!(opts && opts.relatch && shift > 0.0005);
    if (relatch) {
      cam.stickerScan.resetBook();
      cam.scanAuthority = false;
      cam.scanAccum = [];
      cam.scanConfirmed = false;
    }
    // A new map (Align, sticker check, debug, border): re-anchor drift on it.
    if (!(opts && opts.drift)) cam.driftWatch.reset();
    cam.committed = next;
    cam.quadSource = quadSourceOf(message, opts);
    if (opts && opts.unlock) {
      cam.manualLocked = false;
      if (cam.quadSource === 'manual-lock') cam.quadSource = 'saved';
    } else if (opts && opts.manual && !opts.fromLock && !opts.drift) {
      cam.manualLocked = true;
      cam.quadSource = 'manual-lock';
    }
    cam.quadAt = Date.now();
    if (!opts || !opts.fromLock) cam.quadLock.force(cam.committed);
    cam.draft = null;
    cam.rebuild();
    cam.persist();
    // Only a real re-align forgets stickers; a lock refinement (<2%) or a
    // repeat of the same quad must not wipe latched or tapped stickers.
    if (relatch && !(opts && opts.fromLock)) cam.forgetLatchedMarkers();
    if (!(opts && opts.fromLock) && (!cam.markersOn || relatch)) cam.setMarkersEnabled(true, true);
    cam.syncMarkerButton();
    cam.say(message || 'Wall aligned from the camera.');
    cam.drawOverlay();
    try { document.dispatchEvent(new CustomEvent('nd-show-state')); } catch { /* status only */ }
    return !!cam.homography || !cam.video.videoWidth;
  }

export function ackCommandCam(cam, action, text, cmd) {
    cam.commandAck = {
      action: String(action || '').slice(0, 40),
      text: String(text || '').slice(0, 160),
      at: Date.now()
    };
    if (typeof cmd === 'string' && /^[a-z0-9]{4,16}$/.test(cmd)) cam.commandAck.cmd = cmd;
    cam.say(text);
  }

export function attachCameraMode(root) {
  const cam = {root};
  cam.applyPaintingWarp = applyPaintingWarp;
  cam.syncPainting = syncPainting;
  cam.paintProjectorCrosshairs = paintProjectorCrosshairs;
  cam.say = say;
  cam.settings = settings;
  cam.persist = persist;
  cam.showSlider = showSlider;
  cam.refreshLabels = refreshLabels;
  cam.applySaved = applySaved;
  cam.rebuild = rebuild;
  cam.syncMarkerButton = syncMarkerButton;
  cam.roomApi = roomApi;
  cam.push = push;
  cam.stopDriving = stopDriving;
  cam.publishList = publishList;
  cam.forgetLatchedMarkers = forgetLatchedMarkers;
  cam.armMarkersIfAligned = armMarkersIfAligned;
  cam.clearNoteLocks = clearNoteLocks;
  cam.publish = publish;
  cam.fillSelect = fillSelect;
  cam.openedId = openedId;
  cam.fail = fail;
  cam.stopTracks = stopTracks;
  cam.stopCamera = stopCamera;
  cam.startLoop = startLoop;
  cam.stopLoop = stopLoop;
  cam.open = open;
  cam.enumerateAndPick = enumerateAndPick;
  cam.startCamera = startCamera;
  cam.refreshCameras = refreshCameras;
  cam.detectInside = detectInside;
  cam.stagePointFromDetect = stagePointFromDetect;
  cam.setStageScan = setStageScan;
  cam.publishScan = publishScan;
  cam.finishScan = finishScan;
  cam.steerScan = steerScan;
  cam.paintScanButtons = paintScanButtons;
  cam.setScan = setScan;
  cam.readPerson = readPerson;
  cam.personInWhiteFrame = personInWhiteFrame;
  cam.referenceFor = referenceFor;
  cam.adoptLag = adoptLag;
  cam.sampleLatency = sampleLatency;
  cam.publishLatency = publishLatency;
  cam.setLatencyTest = setLatencyTest;
  cam.stopLatencyTest = stopLatencyTest;
  cam.startLatencyTest = startLatencyTest;
  cam.paintingStats = paintingStats;
  cam.collectScan = collectScan;
  cam.nearKnownSticker = nearKnownSticker;
  cam.nearSimDancer = nearSimDancer;
  cam.stickerScanHoldActive = stickerScanHoldActive;
  cam.collectContinuousStickers = collectContinuousStickers;
  cam.detect = detect;
  cam.loop = loop;
  cam.activeCorners = activeCorners;
  cam.drawOverlay = drawOverlay;
  cam.uiExclusions = uiExclusions;
  cam.setMarkersEnabled = setMarkersEnabled;
  cam.flipCamera = flipCamera;
  cam.releaseManualCorners = releaseManualCorners;
  cam.resetMarkerDefaults = resetMarkerDefaults;
  cam.cornerHandles = cornerHandles;
  cam.frameHandles = frameHandles;
  cam.overlayVideoPoint = overlayVideoPoint;
  cam.cornerHit = cornerHit;
  cam.paintPauseButtons = paintPauseButtons;
  cam.setPersonPause = setPersonPause;
  cam.paintGapScanButtons = paintGapScanButtons;
  cam.setGapScanEnabled = setGapScanEnabled;
  cam.publishRestored = publishRestored;
  cam.restoreReloadLatch = restoreReloadLatch;
  cam.commitCorners = commitCorners;
  cam.ackCommand = ackCommand;

  if (!cam.root || cam.root.dataset.cameraReady === '1') return;
  cam.root.dataset.cameraReady = '1';
  cam.video = cam.root.querySelector('[data-preview]');
  cam.overlay = cam.root.querySelector('[data-overlay]');
  cam.status = cam.root.querySelector('[data-status]');
  cam.select = cam.root.querySelector('[data-control="device"]');
  cam.hue = cam.root.querySelector('[data-control="hue"]');
  cam.sat = cam.root.querySelector('[data-control="sat"]');
  cam.size = cam.root.querySelector('[data-control="size"]');
  cam.cameraButton = cam.root.querySelector('[data-action="camera"]');
  cam.refreshButton = cam.root.querySelector('[data-action="refresh"]');
  cam.calibrateButton = cam.root.querySelector('[data-action="calibrate"]');
  cam.markerButton = cam.root.querySelector('[data-action="markers"]');
  if (!cam.video || !cam.overlay || !cam.select || !cam.hue || !cam.sat || !cam.size) return;
  armPreviewElement(cam.video);
  cam.octx = cam.overlay.getContext('2d');
  cam.scratch = document.createElement('canvas');
  cam.sctx = cam.scratch.getContext('2d', {willReadFrequently: true});
  cam.stream = null;
  cam.committed = [];
  cam.draft = null;
  cam.homography = null;
  cam.stickerCal = readStickerCal(memoryOf(null));
  cam.markersOn = false;
  cam.driving = false;
  cam.askedStart = false;
  cam.tracker = createMarkerTracker();
  cam.occlusion = createPersonOcclusion();
  // Static-content reference for the person gate (painting surface, TJ Nov 11
  // 3:41 PM). Re-seeded on every committed alignment.
  cam.personBackground = createStaticBackground();
  cam.lastPersonRead = null;
  cam.manualAck = null; // last manual dancer edit, echoed for the debug page's ack
  // Painting surface: accepted frame quad (= stage quad + mask), bare-painting
  // reference and white-sticker detection (TJ Nov 11 3:41-4:06 PM).
  cam.painting = createPaintingSession({storage: memoryOf(null)});
  cam.syncPaintingClass = () => { try { document.body.classList.toggle('nd-painting', cam.painting.active()); } catch {} };
  // Painting mode: warp the whole projector layer (stage + align patterns +
  // flash) onto the frame; the body around it stays black = the mask.
  function applyPaintingWarp(...args) { return applyPaintingWarpCam(cam, ...args); }
  function syncPainting(...args) { return syncPaintingCam(cam, ...args); }
  cam.syncPaintingClass();
  setTimeout(cam.applyPaintingWarp, 0);
  try { window.addEventListener('resize', cam.applyPaintingWarp); } catch {}
  cam.manuals = createManualStickers();
  cam.lastOcclusion = emptyOcclusion();
  cam.rawBlobs = [];
  cam.latest = null;
  cam.raf = 0;
  cam.lastDetect = 0;
  cam.lastStatus = 0;
  cam.debugCache = null;
  cam.debugFps = 0;
  cam.debugFpsFrames = 0;
  cam.debugFpsStamp = 0;
  cam.lastVideoWidth = 0;
  cam.lastVideoHeight = 0;
  cam.lastDetectFrame = null;
  cam.maxBlobSize = DEFAULTS.maxBlobSize;
  cam.choices = [];
  cam.userPicked = false;
  cam.hueCenterOverride = null;
  cam.detectionMode = 'both';
  cam.personEnabled = true;
  cam.personSensitivity = 0.35;
  cam.personGrid = null; // previous floor luma grid for the motion gate
  cam.lastPerson = null;
  cam.personScanAborts = 0;
  cam.sticker = cam.root.querySelector('[data-control="sticker"]');
  cam.pauseButtons = () => Array.from(document.querySelectorAll('[data-person-pause]'));
  cam.modeButtons = Array.from(cam.root.querySelectorAll('[data-mode]'));
  cam.echo = createStageEcho();
  cam.savedScan = readScanSettings(memoryOf(null));
  cam.savedLag = readLatency(memoryOf(null));
  cam.scanClock = createScanClock(cam.savedScan);
  cam.stickerScan = createStickerScan({hits: CONTINUOUS_HITS, misses: CONTINUOUS_MISSES, latchedMisses: CONTINUOUS_LATCHED_MISSES, autoLatchedMisses: CONTINUOUS_AUTO_LATCHED_MISSES});
  // After Scan stickers finds stickers, continuous detection may only follow
  // them; it never adds dancers on projected ripples/waveforms (TJ 9:01 PM).
  cam.scanAuthority = false;
  cam.blankSettle = createBlankSettle(cam.savedLag.lagMs);
  cam.latencyTracker = createLatencyTracker();
  cam.quadLock = createQuadLock();
  cam.driftWatch = createDriftWatch();
  cam.lastDriftAt = 0;
  cam.camLock = null;
  cam.scanClock.configure({holdMs: blankHoldForLag({lagMs: cam.savedLag.lagMs, jitterMs: cam.savedLag.jitterMs, baseMs: cam.scanClock.durationMs})});
  cam.scanAccum = [];
  cam.scanConfirmed = false;
  cam.scanBaseline = null;
  cam.personBlocked = false;
  cam.personFlashDue = false;
  cam.okHandWatcher = createOkHandWatcher();
  cam.okHandFireDue = false;
  cam.lastOkHand = null;
  cam.latchHoldUntil = 0;

  cam.latencyOn = false;
  cam.lastBorderAt = 0;
  cam.latencyCounter = 0;
  cam.lastLatency = {lagMs: cam.savedLag.lagMs, jitterMs: cam.savedLag.jitterMs, samples: cam.savedLag.samples};
  cam.scanStats = {lastScanAt: 0, scanCount: 0, rawCount: 0, rejected: {area: 0, aspect: 0, edge: 0, compact: 0, ui: 0, flash: 0, offstage: 0, echo: 0}, personPause: false, candidates: [], holdMs: cam.scanClock.durationMs};
  cam.stickerCrosshair = false;
  function paintProjectorCrosshairs(...args) { return paintProjectorCrosshairsCam(cam, ...args); }
  cam.alignReport = null;
  cam.alignProgress = null;
  cam.refineReport = null;
  cam.verifyReport = null;
  cam.stickerFlashReport = null;
  cam.gapScanEnabled = readGapScan(memoryOf(null)) !== false;
  cam.gapScanReport = {enabled: cam.gapScanEnabled, at: null, state: '', reason: '', count: null, applied: null};
  cam.manualQuad = false;
  cam.manualLocked = false;
  cam.commandAck = null;
  // Where the committed quad came from and when (debug only; no effect on mapping).
  cam.quadSource = '';
  cam.quadAt = 0;
  cam.quadVersion = 0;
  cam.quadRejected = null;
  cam.cornerDrag = null;
  cam.frameDraft = null;
  cam.api = {sample() { return cam.latest; }};
  cam.root.neuralDanceMarkers = cam.api;

  function say(...args) { return sayCam(cam, ...args); }
  function settings(...args) { return settingsCam(cam, ...args); }
  function persist(...args) { return persistCam(cam, ...args); }
  function showSlider(...args) { return showSliderCam(cam, ...args); }
  function refreshLabels(...args) { return refreshLabelsCam(cam, ...args); }
  function applySaved(...args) { return applySavedCam(cam, ...args); }
  function rebuild(...args) { return rebuildCam(cam, ...args); }
  function syncMarkerButton(...args) { return syncMarkerButtonCam(cam, ...args); }
  function roomApi(...args) { return roomApiCam(cam, ...args); }
  function push(...args) { return pushCam(cam, ...args); }
  function stopDriving(...args) { return stopDrivingCam(cam, ...args); }
  function publishList(...args) { return publishListCam(cam, ...args); }
  // Clear markers drops the auto latches only; hand-placed (manual) markers
  // stay (TJ Nov 11 3:49 PM). 'clear-manual-markers' removes those explicitly.
  function forgetLatchedMarkers(...args) { return forgetLatchedMarkersCam(cam, ...args); }
  function armMarkersIfAligned(...args) { return armMarkersIfAlignedCam(cam, ...args); }
  function clearNoteLocks(...args) { return clearNoteLocksCam(cam, ...args); }
  function publish(...args) { return publishCam(cam, ...args); }
  function fillSelect(...args) { return fillSelectCam(cam, ...args); }
  function openedId(...args) { return openedIdCam(cam, ...args); }
  function fail(...args) { return failCam(cam, ...args); }
  function stopTracks(...args) { return stopTracksCam(cam, ...args); }
  function stopCamera(...args) { return stopCameraCam(cam, ...args); }
  function startLoop(...args) { return startLoopCam(cam, ...args); }
  function stopLoop(...args) { return stopLoopCam(cam, ...args); }
  async function open(...args) { return openCam(cam, ...args); }
  async function enumerateAndPick(...args) { return enumerateAndPickCam(cam, ...args); }
  async function startCamera(...args) { return startCameraCam(cam, ...args); }
  async function refreshCameras(...args) { return refreshCamerasCam(cam, ...args); }
  function detectInside(...args) { return detectInsideCam(cam, ...args); }
  function stagePointFromDetect(...args) { return stagePointFromDetectCam(cam, ...args); }
  cam.shownFlash = undefined;
  function setStageScan(...args) { return setStageScanCam(cam, ...args); }
  function publishScan(...args) { return publishScanCam(cam, ...args); }
  function finishScan(...args) { return finishScanCam(cam, ...args); }
  function steerScan(...args) { return steerScanCam(cam, ...args); }
  function paintScanButtons(...args) { return paintScanButtonsCam(cam, ...args); }
  function setScan(...args) { return setScanCam(cam, ...args); }
  function readPerson(...args) { return readPersonCam(cam, ...args); }
  // A settled Scan stickers white frame: anyone on the stage blocks the
  // projector and reads as a dark body against the white floor.
  function personInWhiteFrame(...args) { return personInWhiteFrameCam(cam, ...args); }
  function referenceFor(...args) { return referenceForCam(cam, ...args); }
  function adoptLag(...args) { return adoptLagCam(cam, ...args); }
  function sampleLatency(...args) { return sampleLatencyCam(cam, ...args); }
  function publishLatency(...args) { return publishLatencyCam(cam, ...args); }
  cam.latencyTimer = 0;
  function setLatencyTest(...args) { return setLatencyTestCam(cam, ...args); }
  function stopLatencyTest(...args) { return stopLatencyTestCam(cam, ...args); }
  function startLatencyTest(...args) { return startLatencyTestCam(cam, ...args); }
  // Luminance spread over the accepted painting quad only (white-flash check:
  // the wall around the painting stays dark, so the plain check always failed).
  function paintingStats(...args) { return paintingStatsCam(cam, ...args); }
  function collectScan(...args) { return collectScanCam(cam, ...args); }
  function nearKnownSticker(...args) { return nearKnownStickerCam(cam, ...args); }
  // Projected sim dancers must never latch as stickers (TJ 4:37 PM seed-24).
  function nearSimDancer(...args) { return nearSimDancerCam(cam, ...args); }
  function stickerScanHoldActive(...args) { return stickerScanHoldActiveCam(cam, ...args); }
  // Nov 6 continuous path: dark stickers on lit frames with projected-light veto.
  // Blank flashes remain an optional confirm; lag made blank-only miss the sticker.
  function collectContinuousStickers(...args) { return collectContinuousStickersCam(cam, ...args); }
  function detect(...args) { return detectCam(cam, ...args); }
  function loop(...args) { return loopCam(cam, ...args); }
  function activeCorners(...args) { return activeCornersCam(cam, ...args); }
  function drawOverlay(...args) { return drawOverlayCam(cam, ...args); }
  function uiExclusions(...args) { return uiExclusionsCam(cam, ...args); }
  function setMarkersEnabled(...args) { return setMarkersEnabledCam(cam, ...args); }
  cam.hue.addEventListener('input', () => { cam.refreshLabels(); cam.persist(); });
  cam.sat.addEventListener('input', () => { cam.refreshLabels(); cam.persist(); });
  cam.size.addEventListener('input', () => { cam.refreshLabels(); cam.persist(); });
  if (cam.sticker) cam.sticker.addEventListener('input', () => { cam.refreshLabels(); cam.persist(); });
  for (const button of cam.modeButtons) {
    button.addEventListener('click', () => {
      cam.detectionMode = button.dataset.mode;
      cam.refreshLabels();
      cam.persist();
    });
  }
  cam.select.addEventListener('change', async () => {
    if (!cam.select.value) return;
    try { await cam.open(cam.select.value); cam.persist({userSelected: true}); } catch (err) { cam.fail(err); }
  });
  async function flipCamera(...args) { return flipCameraCam(cam, ...args); }
  function releaseManualCorners(...args) { return releaseManualCornersCam(cam, ...args); }
  function resetMarkerDefaults(...args) { return resetMarkerDefaultsCam(cam, ...args); }
  document.querySelectorAll('[data-camera-flip]').forEach(btn => {
    if (btn.dataset.flipReady === '1') return;
    btn.dataset.flipReady = '1';
    btn.addEventListener('click', () => { cam.flipCamera(); });
  });
  document.querySelectorAll('[data-marker-reset]').forEach(btn => {
    if (btn.dataset.resetReady === '1') return;
    btn.dataset.resetReady = '1';
    btn.addEventListener('click', () => { cam.root.neuralDanceCamera.applyShowCommand({action: 'reset-camera'}); });
  });
  document.querySelectorAll('[data-marker-clear]').forEach(btn => {
    if (btn.dataset.clearReady === '1') return;
    btn.dataset.clearReady = '1';
    btn.addEventListener('click', () => {
      cam.root.neuralDanceCamera.applyShowCommand({action: 'clear-markers'});
    });
  });
  document.querySelectorAll('[data-camera-tune]').forEach(btn => {
    if (btn.dataset.tuneReady === '1') return;
    btn.dataset.tuneReady = '1';
    btn.addEventListener('click', () => {
      const open = !cam.root.classList.contains('is-tuned');
      cam.root.classList.toggle('is-tuned', open);
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  cam.cameraButton.addEventListener('click', () => {
    if (cam.stream) cam.stopCamera('Camera off');
    else cam.startCamera();
  });
  cam.refreshButton.addEventListener('click', () => { cam.refreshCameras(); });
  cam.calibrateButton.addEventListener('click', () => {
    if (cam.draft) {
      cam.draft = null;
      cam.syncMarkerButton();
      cam.say(cam.committed.length === 4 ? 'Calibration kept.' : 'Calibration cancelled.');
      cam.drawOverlay();
      return;
    }
    cam.draft = [];
    cam.forgetLatchedMarkers();
    cam.syncMarkerButton();
    cam.say('Corner 1 of 4 · ' + CORNER_STEPS[0] + ' of the projected wall.');
    cam.drawOverlay();
  });
  cam.markerButton.addEventListener('click', () => {
    cam.root.neuralDanceCamera.applyShowCommand({action: cam.markersOn ? 'markers-off' : 'markers-on'});
  });
  function cornerHandles(...args) { return cornerHandlesCam(cam, ...args); }
  function frameHandles(...args) { return frameHandlesCam(cam, ...args); }
  function overlayVideoPoint(...args) { return overlayVideoPointCam(cam, ...args); }
  function cornerHit(...args) { return cornerHitCam(cam, ...args); }
  cam.overlay.addEventListener('pointerdown', event => {
    const spot = cam.overlayVideoPoint(event);
    if (!spot) return;
    const hit = cam.cornerHit(spot);
    if (hit && hit.kind === 'frame') {
      const handles = cam.frameHandles();
      cam.frameDraft = handles.map(corner => ({x: corner.x, y: corner.y}));
      cam.cornerDrag = {index: hit.index, pointerId: event.pointerId, kind: 'frame'};
      event.preventDefault();
      event.stopPropagation();
      try { cam.overlay.setPointerCapture(event.pointerId); } catch { /* the move events still arrive */ }
      cam.drawOverlay();
      return;
    }
    if (hit && hit.kind === 'proj') {
      const handles = cam.cornerHandles();
      cam.draft = handles.map(corner => ({x: corner.x, y: corner.y}));
      cam.cornerDrag = {index: hit.index, pointerId: event.pointerId, kind: 'proj'};
      event.preventDefault();
      event.stopPropagation();
      try { cam.overlay.setPointerCapture(event.pointerId); } catch { /* the move events still arrive */ }
      cam.drawOverlay();
      return;
    }
    if (!cam.draft) {
      if (!videoFrameReady(cam.video)) return;
      const vw = cam.video.videoWidth;
      const vh = cam.video.videoHeight;
      if (cam.scratch.width !== vw) cam.scratch.width = vw;
      if (cam.scratch.height !== vh) cam.scratch.height = vh;
      if (!drawVideoFrame(cam.video, cam.sctx, vw, vh)) return;
      const frame = cam.sctx.getImageData(0, 0, vw, vh);
      const sample = medianPatch(frame.data, vw, vh, Math.round(spot.x * (vw - 1)), Math.round(spot.y * (vh - 1)), 2);
      if (!sample) return;
      cam.hueCenterOverride = sample.h;
      cam.persist();
      showStageToast('Sampled marker color ✓', 'ok', 2500);
      cam.say('Sampled marker color. Reset defaults restores pink.');
      return;
    }
    cam.draft.push(spot);
    if (cam.draft.length >= 4) {
      const next = cam.draft.slice(0, 4);
      if (!isValidAlignmentQuad(next)) {
        cam.draft = null;
        cam.syncMarkerButton();
        cam.say('Those corners cross. Click the four projected corners in order.');
        cam.drawOverlay();
        return;
      }
      cam.draft = null;
      cam.commitCorners(next, cam.homography || cam.video.videoWidth ? 'Wall calibrated. Markers stay on the floor once they appear.' : 'Corners saved. Start the camera to finish the mapping.', {manual: true});
    } else {
      cam.say('Corner ' + (cam.draft.length + 1) + ' of 4 · ' + CORNER_STEPS[cam.draft.length] + ' of the projected wall.');
    }
    cam.drawOverlay();
  });
  cam.overlay.addEventListener('pointermove', event => {
    if (!cam.cornerDrag || event.pointerId !== cam.cornerDrag.pointerId) return;
    const spot = cam.overlayVideoPoint(event);
    if (!spot) return;
    if (cam.cornerDrag.kind === 'frame') {
      if (!cam.frameDraft) return;
      cam.frameDraft[cam.cornerDrag.index] = spot;
      event.preventDefault();
      event.stopPropagation();
      cam.drawOverlay();
      return;
    }
    if (!cam.draft) return;
    cam.draft[cam.cornerDrag.index] = spot;
    event.preventDefault();
    event.stopPropagation();
    cam.drawOverlay();
  });
  cam.overlay.addEventListener('pointerup', event => {
    if (!cam.cornerDrag || event.pointerId !== cam.cornerDrag.pointerId) return;
    if (cam.cornerDrag.kind === 'frame') {
      cam.cornerDrag = null;
      event.preventDefault();
      event.stopPropagation();
      const next = cam.frameDraft;
      cam.frameDraft = null;
      if (next && next.length === 4 && quadConvex(next)) {
        cam.painting.lockFrame(next);
        cam.syncPainting();
        cam.say('Frame: manual (locked)');
        try { document.dispatchEvent(new CustomEvent('nd-show-state')); } catch { /* status only */ }
      } else cam.say('Those frame corners cross.');
      cam.drawOverlay();
      return;
    }
    cam.cornerDrag = null;
    event.preventDefault();
    event.stopPropagation();
    if (!cam.draft || cam.draft.length !== 4) return;
    if (!isValidAlignmentQuad(cam.draft)) {
      cam.say('Those corners cross. Drag each number onto a wall corner.');
      cam.drawOverlay();
      return;
    }
    const next = cam.draft.map(corner => ({x: corner.x, y: corner.y}));
    cam.draft = null;
    cam.commitCorners(next, 'Corners set by hand.', {manual: true});
  });
  cam.overlay.addEventListener('pointercancel', () => { cam.cornerDrag = null; cam.frameDraft = null; });
  function paintPauseButtons(...args) { return paintPauseButtonsCam(cam, ...args); }
  function setPersonPause(...args) { return setPersonPauseCam(cam, ...args); }
  cam.gapScanButtons = () => Array.from(document.querySelectorAll('[data-gap-scan]'));
  function paintGapScanButtons(...args) { return paintGapScanButtonsCam(cam, ...args); }
  function setGapScanEnabled(...args) { return setGapScanEnabledCam(cam, ...args); }
  function publishRestored(...args) { return publishRestoredCam(cam, ...args); }
  function restoreReloadLatch(...args) { return restoreReloadLatchCam(cam, ...args); }
  function commitCorners(...args) { return commitCornersCam(cam, ...args); }
  function ackCommand(...args) { return ackCommandCam(cam, ...args); }
  cam.root.neuralDanceCamera = {
    setNormalizedCorners(list, message, opts) {
      const next = {};
      if (opts && opts.relatch) next.relatch = true;
      if (opts && opts.unlock) next.unlock = true;
      if (opts && opts.manual) next.manual = true;
      return cam.commitCorners(list, message, next);
    },
    releaseManualCornerLock() { cam.releaseManualCorners(); },
    setMarkersEnabled(on, quiet) { cam.setMarkersEnabled(!!on, !!quiet); return cam.markersOn; },
    armAlignedMarkers() { cam.armMarkersIfAligned(true); return cam.markersOn; },
    async ensureCamera() {
      if (!cam.stream) await cam.startCamera();
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      while (cam.stream && !videoFrameReady(cam.video)) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - started > 2500) break;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      return !!cam.stream;
    },
    suspendScan() {
      cam.scanClock.abort();
      cam.scanAccum = [];
      cam.scanConfirmed = false;
      cam.blankSettle.clear();
      cam.setStageScan(null, 0);
    },
    cancelCalibration(silent) {
      cam.draft = null;
      cam.syncMarkerButton();
      if (!silent) cam.say(cam.committed.length === 4 ? 'Calibration kept.' : 'Alignment cancelled.');
      cam.drawOverlay();
    },
    debugState() {
      const current = cam.settings();
      const track = cam.stream && cam.stream.getVideoTracks()[0];
      const trackSettings = track && track.getSettings ? track.getSettings() : {};
      const label = current.deviceLabel || (track && track.label) || '';
      let facing = trackSettings.facingMode || '';
      if (!facing) {
        if (/front|user|selfie/i.test(label)) facing = 'user';
        else if (/back|rear|environment/i.test(label)) facing = 'environment';
      }
      let build = '';
      try {
        const meta = document.querySelector('meta[name="nd-build"]');
        const raw = meta && meta.getAttribute('content');
        if (raw && raw !== '__ND_BUILD__' && /^[A-Za-z0-9._-]{4,64}$/.test(raw.trim())) build = raw.trim();
      } catch { build = ''; }
      return {
        build,
        videoWidth: cam.video.videoWidth || cam.lastVideoWidth || 0,
        videoHeight: cam.video.videoHeight || cam.lastVideoHeight || 0,
        detectWidth: cam.debugCache ? cam.debugCache.detectWidth : 0,
        detectHeight: cam.debugCache ? cam.debugCache.detectHeight : 0,
        cameraLabel: label,
        facingMode: facing,
        quad: cam.committed.length === 4 ? cam.committed.map(p => ({x: p.x, y: p.y})) : null,
        quadLock: {locked: cam.quadLock.locked(), frozen: cam.quadLock.frozen()},
        quadInfo: cam.committed.length === 4 ? {source: cam.quadSource || 'saved', at: cam.quadAt || 0, version: cam.quadVersion || 0, rejected: cam.quadRejected, manual: cam.manualLocked === true} : (cam.quadRejected ? {rejected: cam.quadRejected} : null),
        aligned: cam.committed.length === 4 && !!cam.homography,
        quadMedianRgb: cam.debugCache ? cam.debugCache.quadMedianRgb : null,
        pink: cam.debugCache ? cam.debugCache.pink : [],
        stickers: cam.debugCache ? cam.debugCache.stickers : [],
        markers: Array.isArray(cam.latest) ? cam.latest.map(m => {
          const item = {id: m.id, x: m.x, y: m.y, kind: m.kind || 'pink'};
          if (m.manual) item.manual = true;
          return item;
        }) : [],
        occlusion: {...occlusionTelemetry(cam.lastOcclusion), person: cam.lastPerson ? {
          present: !!cam.lastPerson.present,
          holding: !!cam.lastPerson.holding,
          body: +(+cam.lastPerson.bodyFraction || 0).toFixed(3),
          skin: +(+cam.lastPerson.skinFraction || 0).toFixed(3),
          aspect: +(+cam.lastPerson.aspect || 0).toFixed(2),
          motion: +(+cam.lastPerson.motion || 0).toFixed(3)
        } : null},
        okHand: cam.lastOkHand ? {
          phase: cam.lastOkHand.phase,
          present: !!cam.lastOkHand.present,
          blocking: !!cam.lastOkHand.blocking,
          note: cam.lastOkHand.note || null,
          skinFraction: cam.lastOkHand.score ? +cam.lastOkHand.score.skinFraction || 0 : 0,
          holeFraction: cam.lastOkHand.score ? +cam.lastOkHand.score.holeFraction || 0 : 0,
          reason: cam.lastOkHand.score ? cam.lastOkHand.score.reason : '',
          coolLeft: cam.lastOkHand.coolLeft | 0
        } : null,
        fps: cam.debugFps,
        scan: {
          lastScanAt: cam.scanStats.lastScanAt,
          scanCount: cam.scanStats.scanCount,
          rawCount: cam.scanStats.rawCount,
          rejected: {...cam.scanStats.rejected},
          personPause: !!cam.scanStats.personPause,
          // Live block. personPause is the latch (and was true on a clear floor
          // when only the OK-hand watcher was stuck). This is not the enabled toggle.
          personBlocked: !!((cam.lastPerson && (cam.lastPerson.present || cam.lastPerson.holding)) || (cam.lastOcclusion && (cam.lastOcclusion.held === 'person' || cam.lastOcclusion.held === 'motion' || cam.lastOcclusion.held === 'scan'))),
          candidates: cam.scanStats.candidates.slice(0, 24),
          holdMs: cam.scanStats.holdMs | 0
        },
        latency: {
          lagMs: Number.isFinite(+cam.lastLatency.lagMs) ? +cam.lastLatency.lagMs : null,
          jitterMs: Number.isFinite(+cam.lastLatency.jitterMs) ? +cam.lastLatency.jitterMs : null,
          samples: cam.lastLatency.samples | 0,
          active: !!cam.latencyOn
        },
        align: cam.alignReport ? {
          found: Array.isArray(cam.alignReport.found) ? cam.alignReport.found.map(Boolean) : [false, false, false, false],
          reason: typeof cam.alignReport.reason === 'string' ? cam.alignReport.reason : '',
          marks: Array.isArray(cam.alignReport.marks) ? cam.alignReport.marks.map(mark => mark && Number.isFinite(+mark.x) ? {x: +mark.x, y: +mark.y, found: true} : null) : [],
          progress: cam.alignProgress ? {...cam.alignProgress} : null
        } : (cam.alignProgress ? {found: [false, false, false, false], reason: '', marks: [], progress: {...cam.alignProgress}} : null),
        refine: cam.refineReport,
        verify: cam.verifyReport,
        drift: cam.driftWatch.last(),
        cameraLock: cam.camLock,
        stickerFlash: cam.stickerFlashReport,
        gapScan: {...cam.gapScanReport, enabled: cam.gapScanEnabled},
        painting: Object.assign({}, cam.painting.telemetry(), {visit: cam.visitState || {state: 'idle', label: 'Clear'}}),
        commandAck: cam.commandAck,
        manualAck: cam.manualAck,
        controls: current
      };
    },
    setStickerFlashReport(report) {
      cam.stickerFlashReport = report && typeof report === 'object' ? JSON.parse(JSON.stringify(report)) : null;
    },
    setGapScanReport(report) {
      if (!report || typeof report !== 'object') {
        cam.gapScanReport = {enabled: cam.gapScanEnabled, at: null, state: '', reason: '', count: null, applied: null};
        return cam.gapScanReport;
      }
      cam.gapScanReport = {
        enabled: report.enabled === true || report.enabled === false ? report.enabled : cam.gapScanEnabled,
        at: Number.isFinite(+report.at) ? +report.at : (report.at || null),
        state: typeof report.state === 'string' ? report.state : '',
        reason: typeof report.reason === 'string' ? report.reason : '',
        count: report.count == null || !Number.isFinite(+report.count) ? null : +report.count,
        applied: report.applied === true || report.applied === false ? report.applied : null
      };
      return cam.gapScanReport;
    },
    gapScanOn() { return cam.gapScanEnabled !== false; },
    setGapScanEnabled(on) { return cam.setGapScanEnabled(on); },
    personInView() { return !!cam.personBlocked; },
    personBackgroundReady() { return !!(cam.personBackground && cam.personBackground.ready && cam.personBackground.ready()); },
    // Share of the picture that is no longer the settled painting. A head and
    // two hands move this number; the debug page shows it. A light flip with
    // nobody in it does not. Nothing counts before the background is learned.
    personCoverage() {
      return coverageFromRead(cam.lastPersonRead);
    },
    personInWhiteFrame(frame) { return cam.personInWhiteFrame(frame); },
    // A person rescan's white frame showed someone: pause again so the next
    // rescan waits for a fresh clear. Gives up after PERSON_SCAN_RETRIES.
    rearmPersonPause() {
      if (!cam.personEnabled) return false;
      cam.personScanAborts++;
      if (cam.personScanAborts > PERSON_SCAN_RETRIES) { cam.personScanAborts = 0; return false; }
      cam.lastOcclusion = cam.occlusion.rearm(performance.now());
      cam.personBlocked = true;
      return true;
    },
    personScanDone() { cam.personScanAborts = 0; },
    personEnabled() { return cam.personEnabled !== false; },
    takePersonFlashRequest() {
      if (!cam.personFlashDue) return false;
      cam.personFlashDue = false;
      return true;
    },
    takeOkHandScanRequest() {
      if (!cam.okHandFireDue) return false;
      cam.okHandFireDue = false;
      return true;
    },
    okHandStatus() { return cam.lastOkHand; },
    // Scan stickers: one settled full-white frame. Auto stickers are replaced
    // by what this frame shows; manual taps are kept (they live apart).
    collectWhiteScanPoints(frame, opts = {}) {
      if (!frame || !frame.data) return {ok: false, reason: 'No camera frame.', points: []};
      const scale = frame.scale || {scaleX: 1, scaleY: 1, width: frame.width, height: frame.height};
      // On a painting the white flash never looks like a flat white wall, so
      // the floor scan returns nothing. Use the painting sticker pass instead.
      if (cam.painting.active() || cam.painting.pending()) {
        const frames = Array.isArray(opts.frames) && opts.frames.length ? opts.frames : [frame];
        const found = cam.painting.scanStable ? cam.painting.scanStable(frames) : cam.painting.scan(frame);
        const stickers = found && found.ok ? (found.stickers || []) : [];
        if (!found || !found.ok) return {ok: false, reason: (found && found.reason) || 'Learn the painting first.', points: [], whiteOk: true};
        if (cam.painting.active() && !cam.homography) return {ok: false, reason: 'Snap the projector onto the frame, then scan.', points: [], whiteOk: true};
        const src = cam.painting.scanQuad();
        const zone = src ? src.map(p => ({x: p.x * frame.width, y: p.y * frame.height})) : null;
        if ((found && found.ok) || stickers.length) {
          const points = [];
          for (const blob of stickers) {
            if (zone && !frameContainsPoint(zone, blob.x, blob.y)) continue;
            const video = videoPointFromDetect(blob.x, blob.y, scale);
            const stage = cam.homography ? projectVideoPoint(cam.homography, video.x, video.y) : frameStagePoint(blob.x, blob.y, frame.width, frame.height);
            if (!stage) continue;
            const point = {x: stage.x, y: stage.y, kind: 'sticker'};
            const fromPainting = Number.isFinite(+blob.projectedHeight) && +blob.projectedHeight > 0
              ? +blob.projectedHeight
              : (Number.isFinite(+blob.uvH) && +blob.uvH > 0 ? +blob.uvH * CANVAS_H : 0);
            if (fromPainting > 0) point.projectedHeight = fromPainting;
            else {
              const camH = Number.isFinite(+blob.h) ? +blob.h : 0;
              const sy = scale && Number.isFinite(+scale.scaleY) && +scale.scaleY > 0 ? +scale.scaleY : 1;
              if (cam.homography && camH > 0) {
                const projected = projectedStickerHeight(cam.homography, video.x, video.y, camH * sy);
                if (projected > 0) point.projectedHeight = projected;
              }
            }
            points.push(point);
          }
          const raw = stickers.length + ((found && found.rejected && ((found.rejected.area || 0) + (found.rejected.shape || 0))) || 0);
          return {ok: true, whiteOk: true, points, count: points.length, raw, painting: true};
        }
      }
      if (!blankFrameVerified(frame.data, frame.width, frame.height, 'white', (x, y) => cam.detectInside(x, y, scale))) {
        return {ok: false, reason: 'The camera did not see a white screen. Check the projector and the align.', points: [], whiteOk: false};
      }
      const hits = cam.collectScan(frame, scale, 'white', true);
      const points = (hits.stagePoints || []).filter(p => {
        if (!p || p.kind === 'pink') return false;
        if (!stickerInPlay(p.x, p.y, cam.uiExclusions())) return false;
        const a = +p.aspect;
        const e = +p.elongation;
        if (Number.isFinite(a) && (a < 0.35 || a > 2.6)) return false;
        if (Number.isFinite(e) && e > 4.2) return false;
        return true;
      });
      return {ok: true, whiteOk: true, points, count: points.length, raw: (hits.videos || []).length};
    },
    previewWhiteFrame(frame) {
      return this.collectWhiteScanPoints(frame);
    },
    applyWhiteScan(points, opts = {}) {
      const prev = cam.stickerScan.markers();
      if (opts && opts.addOnly) {
        const incoming = mergeScanPoints(points || [], SCAN_SPLIT_MERGE);
        const fresh = mergeNewStickers(prev, incoming, 6).fresh;
        const matched = keepConfirmedStickers(prev, fresh, SCAN_SPLIT_MERGE);
        cam.stickerScan.resetBook();
        cam.scanAccum = [];
        cam.scanConfirmed = false;
        cam.echo.clear();
        const markers = cam.stickerScan.restore(matched);
        cam.scanAuthority = markers.length > 0;
        cam.latchHoldUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 1500;
        cam.publishScan();
        return {ok: true, applied: true, count: fresh.length, total: markers.length};
      }
      const merged = mergeScanPoints(points || [], SCAN_SPLIT_MERGE);
      let matched = matchScanIds(prev, merged, SCAN_SPLIT_MERGE);
      if (opts.confident) {
        const check = scanApplyOk({prevCount: prev.length, nextCount: matched.length, whiteOk: true, settled: opts.settled !== false});
        if (!check.ok) return {ok: false, applied: false, reason: check.reason, count: prev.length, proposed: matched.length};
        // A between-songs scan only adds or refines. A confirmed sticker it
        // did not see this time (dancer shadow, short 150 ms fade) is kept.
        matched = keepConfirmedStickers(prev, matched, SCAN_SPLIT_MERGE);
      }
      cam.stickerScan.resetBook();
      cam.scanAccum = [];
      cam.scanConfirmed = false;
      cam.echo.clear();
      const markers = cam.stickerScan.restore(matched);
      cam.scanAuthority = markers.length > 0;
      cam.latchHoldUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 1500;
      cam.publishScan();
      return {ok: true, applied: true, count: markers.length};
    },
    setStickerCalibration(cal) {
      if (!cal || !Array.isArray(cal.H) || cal.H.length !== 9) {
        cam.stickerCal = null;
        writeStickerCal(memoryOf(null), null);
      } else {
        cam.stickerCal = {H: cal.H.map(Number), residual: Number.isFinite(+cal.residual) ? +cal.residual : 0, at: Date.now()};
        writeStickerCal(memoryOf(null), cam.stickerCal);
      }
      cam.rebuild();
      cam.say(cam.stickerCal ? 'Calibration residual ' + cam.stickerCal.residual.toFixed(1) + ' px' : 'Sticker calibration cleared. Using the pink quad.');
      return cam.stickerCal;
    },
    stickerCalibration() { return cam.stickerCal ? {H: cam.stickerCal.H.slice(), residual: cam.stickerCal.residual, at: cam.stickerCal.at} : null; },
    projectionHomography() {
      return {
        H: cam.homography ? cam.homography.slice() : null,
        videoWidth: cam.video.videoWidth || 0,
        videoHeight: cam.video.videoHeight || 0,
        calibrated: !!cam.stickerCal,
        residual: cam.stickerCal ? cam.stickerCal.residual : null
      };
    },
    scanWhiteFrame(frame, opts = {}) {
      const frames = Array.isArray(opts.frames) && opts.frames.length ? opts.frames : [frame];
      const preview = this.collectWhiteScanPoints(frame, {frames});
      if (frame && frame.data) noteScanSample(cam.scanStats, preview && (preview.raw != null ? preview.raw : preview.count));
      if (!preview.ok) return {ok: false, reason: preview.reason, applied: false};
      if (cam.painting.active() && cam.painting.commitScan) cam.painting.commitScan(frame, Date.now());
      return this.applyWhiteScan(preview.points, cam.painting.active() ? {...opts, addOnly: true} : opts);
    },
    setRefineReport(report) {
      cam.refineReport = report && typeof report === 'object' ? JSON.parse(JSON.stringify(report)) : null;
    },
    // After Align: hold focus and white balance so sticker colors and
    // positions do not wander (WebKit exposes these on some iPhones; feature
    // detected). Exposure stays automatic: a lock taken on the Align flash
    // would leave the show frames too dark or blown for sticker detection.
    async lockCamera(on = true) {
      const track = cam.stream && cam.stream.getVideoTracks && cam.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? (() => { try { return track.getCapabilities() || {}; } catch { return {}; } })() : {};
      const want = {};
      for (const key of ['focusMode', 'whiteBalanceMode']) {
        const modes = Array.isArray(caps[key]) ? caps[key] : [];
        const mode = on ? (modes.includes('manual') ? 'manual' : modes.includes('single-shot') ? 'single-shot' : null) : (modes.includes('continuous') ? 'continuous' : null);
        if (mode) want[key] = mode;
      }
      let error = '';
      if (track && track.applyConstraints && Object.keys(want).length) {
        try { await track.applyConstraints({advanced: [want]}); } catch (err) { error = String(err && err.message || err).slice(0, 120); }
      }
      let settings = {};
      try { settings = track && track.getSettings ? track.getSettings() : {}; } catch { settings = {}; }
      const pick = {};
      for (const key of ['width', 'height', 'frameRate', 'zoom', 'resizeMode', 'focusMode', 'whiteBalanceMode', 'exposureMode', 'focusDistance', 'exposureCompensation']) if (settings[key] != null) pick[key] = settings[key];
      cam.camLock = {
        locked: !!on && !error && Object.keys(want).length > 0,
        requested: want,
        supported: {
          focusMode: Array.isArray(caps.focusMode) ? caps.focusMode : null,
          whiteBalanceMode: Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : null,
          exposureMode: Array.isArray(caps.exposureMode) ? caps.exposureMode : null,
          zoom: caps.zoom ? {min: caps.zoom.min, max: caps.zoom.max} : null
        },
        settings: pick,
        error,
        at: Date.now()
      };
      return cam.camLock;
    },
    // After a white-hold Relearn, hold white balance so the next white scans
    // see the same color. No-op when the track cannot do manual WB.
    async lockWhiteBalance() {
      const track = cam.stream && cam.stream.getVideoTracks && cam.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? (() => { try { return track.getCapabilities() || {}; } catch { return {}; } })() : {};
      const mode = manualWhiteBalanceMode(caps);
      let error = '';
      if (mode && track && track.applyConstraints) {
        try { await track.applyConstraints({advanced: [{whiteBalanceMode: mode}]}); }
        catch (err) { error = String(err && err.message || err).slice(0, 120); }
      }
      let settings = {};
      try { settings = track && track.getSettings ? track.getSettings() : {}; } catch { settings = {}; }
      const locked = !!mode && !error;
      const wb = {locked, mode: locked ? (settings.whiteBalanceMode || mode) : null};
      cam.wbState = wb;
      const prev = cam.camLock && typeof cam.camLock === 'object' ? cam.camLock : {};
      cam.camLock = {
        ...prev,
        wbLocked: locked,
        wbError: error,
        at: Date.now(),
        settings: {...(prev.settings || {}), ...(wb.mode ? {whiteBalanceMode: wb.mode} : {})}
      };
      if (cam.painting && cam.painting.noteScanMeta) cam.painting.noteScanMeta({wb});
      return wb;
    },
    setVerifyReport(report) {
      cam.verifyReport = report && typeof report === 'object' ? JSON.parse(JSON.stringify(report)) : null;
    },
    setAlignProgress(state) {
      cam.alignProgress = state && typeof state === 'object' ? {
        phase: String(state.phase || ''), step: state.step | 0, steps: state.steps | 0,
        attempt: state.attempt | 0, tries: state.tries | 0, agree: state.agree | 0, need: state.need | 0,
        frames: state.frames | 0, settled: !!state.settled, elapsedMs: state.elapsedMs | 0, totalMs: state.totalMs | 0
      } : null;
    },
    setAlignOverlay(report) {
      cam.alignReport = report || null;
      cam.drawOverlay();
    },
    startCornerDraft(prefill) {
      const fallback = [
        {x: 0.04, y: 0.04},
        {x: 0.96, y: 0.04},
        {x: 0.96, y: 0.96},
        {x: 0.04, y: 0.96}
      ];
      const source = Array.isArray(prefill) && prefill.length === 4 ? prefill : (cam.committed.length === 4 ? cam.committed : fallback);
      cam.draft = source.map(corner => ({x: +corner.x, y: +corner.y}));
      cam.say('Drag each number onto a corner of the screen.');
      cam.drawOverlay();
    },
    fitBorder() {
      if (!videoFrameReady(cam.video)) return null;
      const scale = detectionSize(cam.video.videoWidth, cam.video.videoHeight);
      if (cam.scratch.width !== scale.width) cam.scratch.width = scale.width;
      if (cam.scratch.height !== scale.height) cam.scratch.height = scale.height;
      if (!drawVideoFrame(cam.video, cam.sctx, scale.width, scale.height)) return null;
      const frame = cam.sctx.getImageData(0, 0, scale.width, scale.height);
      const fit = fitScreenBorder(frame.data, scale.width, scale.height);
      if (fit.ok && fit.corners) cam.commitCorners(fit.corners, 'Aligned to the screen border.');
      return fit;
    },
    applyManualSticker(patch) {
      const result = cam.manuals.apply(patch) || {};
      const hit = result.added || result.moved || result.removed || null;
      cam.manualAck = {nonce: patch && typeof patch.nonce === 'string' ? patch.nonce : '', action: patch && patch.action || '', ok: !!result.changed, id: hit ? hit.id | 0 : (patch && patch.id | 0) || 0, at: Date.now(), count: cam.manuals.list().length};
      const detected = cam.markersOn && cam.homography ? toDancerMarkers(cam.tracker.stage()) : [];
      cam.publish(detected);
      return cam.manuals.list();
    },
    applyTuning(patch) {
      if (!patch || typeof patch !== 'object') return;
      if (Array.isArray(patch.corners)) {
        // Versioned debug commit (TJ Nov 11 3:58 PM: the pink quad kept
        // jumping back). Ack the version in telemetry, and say why when the
        // quad is refused instead of dropping it silently.
        const version = Number.isFinite(+patch.cornersVersion) ? +patch.cornersVersion : 0;
        if (isValidAlignmentQuad(patch.corners)) {
          const userDrag = patch.cornersLock === 'set';
          const clearing = patch.cornersLock === 'clear';
          if (cam.manualLocked && !userDrag && !clearing) {
            cam.quadRejected = {version, reason: 'corners are manual (locked)'};
          } else {
            const ok = cam.commitCorners(patch.corners, 'Corners set from debug.', {manual: userDrag || (!cam.manualLocked && !clearing), unlock: clearing});
            if (ok !== false) { cam.quadVersion = version; cam.quadRejected = null; if (patch.cornersKind === 'stage' && cam.painting.active() && !cam.painting.frameLocked()) { cam.painting.setFrameQuad(patch.corners); const w = cam.painting.warp(); if (w && w.projQuad) { const t = projectorWarpTarget(w.projQuad, patch.corners, CANVAS_W, CANVAS_H); if (t) cam.painting.setWarp({...w, target: t.target, short: t.short, warning: t.warning}); } cam.syncPainting(); } }
            else cam.quadRejected = {version, reason: (cam.alignReport && cam.alignReport.reason) || 'refused'};
          }
        } else {
          cam.quadRejected = {version, reason: 'outside the camera frame (more than 15% past an edge) or not a wall shape'};
        }
      }
      if (Array.isArray(patch.frameQuad) && patch.frameLock === 'set' && cam.painting.lockFrame(patch.frameQuad)) {
        const fitted = clampQuadToFrame(cam.painting.frameQuad());
        if (fitted) cam.commitCorners(fitted, 'Projector snapped to the frame.', {manual: true, quiet: true});
        cam.syncPainting();
        cam.say('Frame: manual (locked)');
        try { document.dispatchEvent(new CustomEvent('nd-show-state')); } catch { /* status only */ }
      } else if (patch.frameLock === 'clear') {
        cam.painting.unlockFrame();
        cam.syncPainting();
      }
      if (patch.markerMode === 'both' || patch.markerMode === 'pink' || patch.markerMode === 'stickers') cam.detectionMode = patch.markerMode;
      if (Number.isFinite(+patch.noteSensitivity)) cam.sat.value = String(+patch.noteSensitivity);
      if (Number.isFinite(+patch.hueTolerance)) cam.hue.value = String(+patch.hueTolerance);
      if (Number.isFinite(+patch.minBlobSize)) cam.size.value = String(+patch.minBlobSize);
      if (cam.sticker && Number.isFinite(+patch.stickerSensitivity)) cam.sticker.value = String(+patch.stickerSensitivity);
      if (Number.isFinite(+patch.maxBlobSize)) cam.maxBlobSize = +patch.maxBlobSize;
      if (patch.personPause === true || patch.personPause === false || Number.isFinite(+patch.personSensitivity)) {
        cam.setPersonPause(
          patch.personPause === true || patch.personPause === false ? patch.personPause : cam.personEnabled,
          Number.isFinite(+patch.personSensitivity) ? +patch.personSensitivity : cam.personSensitivity
        );
      }
      if (patch.gapScan === true || patch.gapScan === false) cam.setGapScanEnabled(patch.gapScan);
      if (patch.scanMode === 'black' || patch.scanMode === 'white' || patch.scanMode === 'gray' || patch.scanMode === 'off' || Number.isFinite(+patch.scanInterval) || Number.isFinite(+patch.scanDuration)) {
        cam.setScan({
          mode: patch.scanMode,
          intervalMs: Number.isFinite(+patch.scanInterval) ? +patch.scanInterval * 1000 : undefined,
          durationMs: Number.isFinite(+patch.scanDuration) ? +patch.scanDuration : undefined
        });
      }
      cam.refreshLabels();
      cam.persist();
    },
    isOpen() { return !!cam.stream; },
    captureLatch(storage) {
      cam.persist();
      return writeReloadLatch(storage || memoryOf(null), {
        markersOn: cam.markersOn,
        markers: cam.tracker.stage(),
        manuals: cam.manuals.list()
      });
    },
    setScanReference(kind, frame) {
      if ((kind !== 'white' && kind !== 'black') || !frame || !frame.data) return false;
      const saved = cam.stickerScan.storeReference(frame.data, frame.width, frame.height, kind);
      return !!(saved && saved.ok);
    },
    noteCommand(action, text, cmd) { cam.ackCommand(action, text, cmd); },
    paintingActive() { return cam.painting.active(); },
    paintingReferenceReady() { return cam.painting.referenceReady(); },
    setVisitState(step) {
      const coverage = step && Number.isFinite(+step.coverage) ? Math.max(0, Math.min(1, +step.coverage)) : 0;
      const next = step && typeof step === 'object'
        ? {state: String(step.state || 'idle').slice(0, 24), label: String(step.label || 'Clear').slice(0, 40), coverage}
        : {state: 'idle', label: 'Clear', coverage};
      if (step && typeof step === 'object') {
        if (step.ready === true || step.ready === false) next.ready = step.ready;
        if (step.sceneMatch === true || step.sceneMatch === false) next.sceneMatch = step.sceneMatch;
        if (step.personBlocked === true || step.personBlocked === false) next.personBlocked = step.personBlocked;
      }
      cam.visitState = next;
      return cam.visitState;
    },
    // After a white capture, ignore the fade. The next visit waits until the
    // picture matches the frame grabbed once that cooldown has passed.
    holdVisit(ms) {
      cam.visitQuietUntil = Date.now() + Math.max(0, +ms || 0);
      cam.visitScene = null;
      cam.visitSceneRequired = true;
      return cam.visitQuietUntil;
    },
    visitHeld() { return Date.now() < (cam.visitQuietUntil || 0); },
    considerVisitScene() {
      if (Date.now() < (cam.visitQuietUntil || 0) || !cam.visitSceneRequired || cam.visitScene || !cam.lastDetectFrame) return;
      // Grab the settled picture only with nobody in it. A person who walked
      // back in before the post-scan quiet ended was baked into the picture,
      // so the frame never matched again after they left and no visit scan
      // ran (studio Nov 23 pr144, frames 280-300).
      if (cam.personBlocked) return;
      cam.visitScene = sceneSignature(cam.lastDetectFrame);
    },
    sceneMatchesVisit() {
      if (!cam.visitSceneRequired) return true;
      if (!cam.visitScene || !cam.lastDetectFrame) return false;
      return sceneClose(sceneSignature(cam.lastDetectFrame), cam.visitScene);
    },
    learnPaintingReference(frames, now) { return cam.painting.learnReference(frames, now); },
    clearAutoScanMarkers() { return clearAutoScanMarkersCam(cam); },
    noteScanMeta(partial) { return cam.painting && cam.painting.noteScanMeta ? cam.painting.noteScanMeta(partial) : null; },
    whiteBalanceState() { return cam.wbState || {locked: false, mode: null}; },
    applyShowCommand(command) {
      if (!command || typeof command !== 'object') return;
      if (command.action === 'clear-markers') {
        cam.forgetLatchedMarkers();
        cam.say(cam.manuals.list().length ? 'Auto markers cleared. Hand-placed markers kept.' : 'Markers cleared.');
      } else if (command.action === 'clear-manual-markers') {
        cam.forgetLatchedMarkers({manual: true});
        cam.say('All markers cleared, including hand-placed ones.');
      } else if (command.action === 'cycle-scan') {
        cam.setScan({mode: nextScanMode(cam.scanClock.mode)});
      } else if (command.action === 'toggle-person') {
        cam.setPersonPause(!cam.personEnabled);
      } else if (command.action === 'toggle-gap-scan') {
        cam.setGapScanEnabled(!cam.gapScanEnabled);
      } else if (command.action === 'markers-on') {
        cam.setMarkersEnabled(true);
      } else if (command.action === 'markers-off') {
        cam.setMarkersEnabled(false);
      } else if (command.action === 'reset-camera') {
        cam.releaseManualCorners();
        cam.resetMarkerDefaults();
      } else if (command.action === 'align-border') {
        this.fitBorder();
      } else if (command.action === 'latency-test') {
        cam.startLatencyTest(Number.isFinite(+command.durationMs) ? +command.durationMs : 10000);
      } else if (command.action === 'lock-quad') {
        cam.quadLock.lock();
      } else if (command.action === 'unlock-quad') {
        cam.quadLock.unlock();
      } else if (command.action === 'add-manual-sticker' || command.action === 'remove-manual-sticker' || command.action === 'move-manual-sticker') {
        this.applyManualSticker(command);
      } else if (command.action === 'frame-detect' || command.action === 'frame-retry') {
        cam.releaseManualCorners();
        // Detect offers a new quad. It does not unlock a hand-locked frame
        // first: a miss has to leave those corners where TJ put them.
        const proj = cam.committed.length === 4 ? cam.committed.map(p => ({x: p.x, y: p.y})) : null;
        const r = cam.painting.retry(this.grabFrame() || cam.lastDetectFrame, proj);
        cam.ackCommand(command.action, r.ok ? 'Painting frame found. Accept or Retry on the debug page.' : 'No painting frame found: ' + r.reason, command.cmd);
      } else if (command.action === 'frame-accept') {
        // The frame quad becomes the stage quad (numbered corners) and mask.
        const quad = Array.isArray(command.quad) && command.quad.length === 4 ? command.quad : cam.painting.pending();
        if (!quad) { cam.ackCommand(command.action, 'Nothing to accept: run Detect frame first.', command.cmd); return; }
        // Unwarped projector footprint: the stage quad before the first Accept
        // (a later re-Accept keeps the original footprint).
        const prior = cam.painting.warp();
        const projQuad = prior && prior.projQuad ? prior.projQuad : (cam.committed.length === 4 ? cam.committed.map(p => ({x: p.x, y: p.y})) : null);
        // The pink projector corners stay the camera→stage map. Accepting the
        // green frame must not replace them (that sent dancers off the stickers).
        cam.painting.accept(quad);
        const fitted = clampQuadToFrame(cam.painting.frameQuad());
        if (fitted) cam.commitCorners(fitted, 'Projector snapped to the frame.', {manual: true, quiet: true});
        const target = projQuad ? projectorWarpTarget(projQuad, quad, CANVAS_W, CANVAS_H) : null;
        cam.painting.setWarp(target ? {projQuad, target: target.target, short: target.short, warning: target.warning} : null);
        if (target && target.warning) cam.say(target.warning + ' (the uncovered strip stays dark).');
        if (!projQuad) cam.say('No projector alignment yet: run Align once so the show can be fitted onto the painting.');
        cam.forgetLatchedMarkers();
        cam.syncPainting();
        cam.ackCommand(command.action, 'Painting accepted. Learning the bare painting: keep stickers off and step out for ~2 s.', command.cmd);
      } else if (command.action === 'snap-projector-frame') {
        const quad = clampQuadToFrame(cam.painting.frameQuad());
        if (!quad) { cam.ackCommand(command.action, 'No accepted frame yet. Detect and Accept the frame first.', command.cmd); return; }
        cam.painting.lockFrame(quad);
        const ok = cam.commitCorners(quad, 'Projector snapped to the frame.', {manual: true});
        cam.ackCommand(command.action, ok !== false ? 'Projector quad snapped to the frame.' : 'Could not snap the projector quad.', command.cmd);
        try { document.dispatchEvent(new CustomEvent('nd-show-state')); } catch { /* status only */ }
      } else if (command.action === 'frame-clear') {
        cam.painting.clear();
        cam.syncPainting();
        cam.ackCommand(command.action, 'Painting surface off.', command.cmd);
        try { document.dispatchEvent(new CustomEvent('nd-show-state')); } catch { /* status only */ }
      } else if (command.action === 'sticker-crosshair') {
        cam.stickerCrosshair = !cam.stickerCrosshair;
        cam.paintProjectorCrosshairs();
        cam.ackCommand(command.action, cam.stickerCrosshair ? 'Sticker crosshairs on' : 'Sticker crosshairs off', command.cmd);
      } else if (command.action === 'painting-reference') {
        cam.painting.recaptureReference();
        cam.ackCommand(command.action, 'Re-learning the bare painting (stickers off, nobody in frame).', command.cmd);
      } else if (command.action === 'sticker-color') {
        cam.ackCommand(command.action, 'Sticker colour: ' + cam.painting.setStickerColor(command.value), command.cmd);
      }
    },
    captureEmptyFloor() {
      const frame = this.grabFrame();
      if (!frame) return null;
      const median = frameMedianLum(frame.data, frame.width, frame.height, null);
      const kind = median != null && median >= 110 ? 'white' : 'black';
      if (!this.setScanReference(kind, frame)) return null;
      return kind;
    },
    grabFrame() {
      if (!videoFrameReady(cam.video)) return null;
      const scale = detectionSize(cam.video.videoWidth, cam.video.videoHeight);
      if (cam.scratch.width !== scale.width) cam.scratch.width = scale.width;
      if (cam.scratch.height !== scale.height) cam.scratch.height = scale.height;
      if (!drawVideoFrame(cam.video, cam.sctx, scale.width, scale.height)) return null;
      const frame = cam.sctx.getImageData(0, 0, scale.width, scale.height);
      return {data: frame.data, width: scale.width, height: scale.height, scale, videoWidth: cam.video.videoWidth, videoHeight: cam.video.videoHeight};
    },
    // White-hold Relearn / Scan on a painting reads the camera's own frame.
    // Tracking, occlusion, and the live preview stay on the 480-wide scratch.
    grabNativeFrame() {
      if (!videoFrameReady(cam.video)) return null;
      const w = cam.video.videoWidth | 0;
      const h = cam.video.videoHeight | 0;
      if (!(w > 0) || !(h > 0) || typeof document === 'undefined' || typeof document.createElement !== 'function') return this.grabFrame();
      if (!cam.scanCanvas) {
        cam.scanCanvas = document.createElement('canvas');
        cam.scanCtx = cam.scanCanvas.getContext('2d', {willReadFrequently: true});
      }
      if (!cam.scanCtx) return this.grabFrame();
      if (cam.scanCanvas.width !== w) cam.scanCanvas.width = w;
      if (cam.scanCanvas.height !== h) cam.scanCanvas.height = h;
      if (!drawVideoFrame(cam.video, cam.scanCtx, w, h)) return this.grabFrame();
      const frame = cam.scanCtx.getImageData(0, 0, w, h);
      return {data: frame.data, width: w, height: h, scale: {width: w, height: h, scaleX: 1, scaleY: 1}, videoWidth: w, videoHeight: h, native: true};
    },
    grabScanFrame() {
      const painting = cam.painting && (cam.painting.active() || (cam.painting.pending && cam.painting.pending()));
      if (painting) return this.grabNativeFrame();
      return this.grabFrame();
    }
  };
  for (const button of cam.pauseButtons()) {
    if (button.dataset.pauseReady === '1') continue;
    button.dataset.pauseReady = '1';
    button.addEventListener('click', () => cam.root.neuralDanceCamera.applyShowCommand({action: 'toggle-person'}));
  }
  for (const button of cam.gapScanButtons()) {
    if (button.dataset.gapReady === '1') continue;
    button.dataset.gapReady = '1';
    button.addEventListener('click', () => cam.root.neuralDanceCamera.applyShowCommand({action: 'toggle-gap-scan'}));
  }
  for (const button of document.querySelectorAll('[data-scan-mode]')) {
    if (button.dataset.scanReady === '1') continue;
    button.dataset.scanReady = '1';
    button.addEventListener('click', () => cam.root.neuralDanceCamera.applyShowCommand({action: 'cycle-scan'}));
  }
  for (const button of document.querySelectorAll('[data-capture-floor]')) {
    if (button.dataset.floorReady === '1') continue;
    button.dataset.floorReady = '1';
    button.addEventListener('click', () => {
      const kind = cam.root.neuralDanceCamera && cam.root.neuralDanceCamera.captureEmptyFloor();
      cam.say(kind === 'white' ? 'Empty lit floor captured.' : kind === 'black' ? 'Empty black floor captured.' : 'Need a blank frame with nobody in it.');
    });
  }
  cam.paintScanButtons();
  cam.video.addEventListener('loadedmetadata', () => {
    cam.rebuild();
    if (cam.markersOn) cam.publish(toDancerMarkers(cam.tracker.stage()));
    cam.drawOverlay();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && cam.stream) cam.stopCamera('Camera off');
  });
  window.addEventListener('pagehide', () => cam.stopCamera('Camera off'));
  cam.clearNoteLocks();
  cam.applySaved(readCameraSettings(memoryOf(null)));
  const savedFrame = cam.painting.frameQuad();
  if (savedFrame) {
    const fitted = clampQuadToFrame(savedFrame);
    if (fitted && cam.painting.lockFrame(fitted)) cam.commitCorners(fitted, 'Projector snapped to the frame.', {manual: true, quiet: true});
  }
  if (cam.committed.length === 4) cam.quadLock.force(cam.committed);
  cam.syncMarkerButton();
  cam.refreshLabels();
  cam.savedPause = readPersonPause(memoryOf(null));
  cam.setPersonPause(cam.savedPause.enabled, cam.savedPause.sensitivity);
  cam.setGapScanEnabled(readGapScan(memoryOf(null)));
  cam.restoreReloadLatch();
  if (cam.committed.length === 4) cam.say('Calibration saved in this browser. Use camera to watch the wall.');
}

if (typeof document !== 'undefined') {
  const boot = () => attachCameraMode(document.getElementById('nd-camera-mode'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
