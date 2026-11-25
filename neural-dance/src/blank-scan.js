// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Optional blank-frame sticker confirms. Continuous lit-frame detection is the
// primary path (see camera-markers collectContinuousStickers). Blank flashes
// (black / gray / white) remain available from the debug viewer only; the live
// show defaults scan mode to off so the projector does not flash. A sticker
// still latches after three consistent observes and drops after several misses.
// When a flash is enabled: dark stickers on white/gray, bright on black.

import {traceContour} from './silhouette.js';
import {personInFrame} from './person-occlusion.js';

export const SCAN_KEY = 'nd.scan.v2';
export const SCAN_INTERVAL_MS = 4000;
export const SCAN_MIN_INTERVAL_MS = 2000;
export const SCAN_MAX_INTERVAL_MS = 12000;
export const SCAN_DURATION_MS = 200;
export const SCAN_MIN_DURATION_MS = 150;
export const SCAN_MAX_DURATION_MS = 250;
export const SCAN_LEAD_MS = 70;
// After the projector is asked to go blank, wait two animation frames and
// then the camera's latency before any pixel is allowed to count.
export const SCAN_SETTLE_RAF = 2;
export const SCAN_CAMERA_LATENCY_MS = 220;
export const SCAN_HOLD_MAX_MS = 900;
export const LATENCY_KEY = 'nd.latency.v1';
export const SCAN_HITS = 3;
// Continuous lit-frame latch: ~1 s stable at 100 ms detects before a marker shows.
export const CONTINUOUS_HITS = 10;
export const CONTINUOUS_MISSES = 12;
// Once latched, a continuous sticker stays until Clear (as the Nov 6 tracker
// did). Its own projected dot/ring covers the sticker in the camera, so misses
// after the latch are expected and must not drop it (rig replay 3:00-3:07 PM).
export const CONTINUOUS_LATCHED_MISSES = Number.MAX_SAFE_INTEGER;
// Nov 9, 9:01 PM (TJ): dark gaps between projected ripple / waveform rings read
// as dark stickers, latched, and never left. Stickers placed by Scan stickers
// (restore) keep the long hold above; a sticker that only continuous detection
// found must keep being seen, or it expires after ~3 s (30 misses at 100 ms).
export const CONTINUOUS_AUTO_LATCHED_MISSES = 30;
export const SCAN_HOLD_PX = 28;
export const SCAN_MOVE_HITS = 3;
export const SCAN_MISSES = 3;

export function normalizeScanMode(mode) {
  if (mode === 'white' || mode === 'off' || mode === 'gray') return mode;
  return 'black';
}

export function nextScanMode(mode) {
  // gray = dim blank for dark stickers without a full white flash.
  const order = ['black', 'gray', 'white', 'off'];
  const index = order.indexOf(normalizeScanMode(mode));
  return order[(index + 1) % order.length];
}

// How the projector paints each scan flash.
export function scanBlankFill(mode) {
  if (mode === 'white') return '#ffffff';
  if (mode === 'gray') return '#a8a8a8';
  return '#000000';
}

// Sticker polarity for a flash: gray uses the dark-on-light detector.
export function stickerModeForFlash(flash) {
  return flash === 'white' || flash === 'gray' ? 'white' : 'black';
}

export function clampScanInterval(value) {
  const n = +value;
  if (!Number.isFinite(n)) return SCAN_INTERVAL_MS;
  return Math.min(SCAN_MAX_INTERVAL_MS, Math.max(SCAN_MIN_INTERVAL_MS, n));
}

export function clampScanDuration(value) {
  const n = +value;
  if (!Number.isFinite(n)) return SCAN_DURATION_MS;
  return Math.min(SCAN_MAX_DURATION_MS, Math.max(SCAN_MIN_DURATION_MS, n));
}

// The slider stays inside 150–250 ms. A measured projector lag may hold the
// blank longer so the camera is actually inside the flash.
export function clampScanHold(value) {
  const n = +value;
  if (!Number.isFinite(n)) return SCAN_DURATION_MS;
  return Math.min(SCAN_HOLD_MAX_MS, Math.max(SCAN_MIN_DURATION_MS, n));
}

export function clampLatencyMs(value) {
  const n = +value;
  if (!Number.isFinite(n)) return SCAN_CAMERA_LATENCY_MS;
  return Math.min(800, Math.max(0, n));
}

export function blankHoldForLag({lagMs = SCAN_CAMERA_LATENCY_MS, jitterMs = 0, baseMs = SCAN_DURATION_MS} = {}) {
  const lag = clampLatencyMs(lagMs);
  const jitter = Math.min(400, Math.max(0, Number.isFinite(+jitterMs) ? +jitterMs : 0));
  const base = clampScanDuration(baseMs);
  // Hold past settle (lag) with ~200 ms of real capture so a late camera
  // frame still lands inside the blank. The old +80 ms window was too tight.
  const needed = Math.ceil(lag + jitter + 200);
  return clampScanHold(Math.max(base, needed));
}

export function readLatency(storage) {
  const fallback = {lagMs: SCAN_CAMERA_LATENCY_MS, jitterMs: 0, samples: 0};
  if (!storage || typeof storage.getItem !== 'function') return fallback;
  try {
    const data = JSON.parse(storage.getItem(LATENCY_KEY) || '');
    if (!data || typeof data !== 'object') return fallback;
    return {
      lagMs: clampLatencyMs(data.lagMs),
      jitterMs: Math.min(400, Math.max(0, +data.jitterMs || 0)),
      samples: Math.max(0, data.samples | 0)
    };
  } catch {
    return fallback;
  }
}

export function writeLatency(storage, state) {
  if (!storage || typeof storage.setItem !== 'function' || !state) return false;
  try {
    storage.setItem(LATENCY_KEY, JSON.stringify({
      v: 1,
      lagMs: clampLatencyMs(state.lagMs),
      jitterMs: Math.min(400, Math.max(0, +state.jitterMs || 0)),
      samples: Math.max(0, state.samples | 0)
    }));
    return true;
  } catch {
    return false;
  }
}

export function readScanSettings(storage) {
  const fallback = {mode: 'off', intervalMs: SCAN_INTERVAL_MS, durationMs: SCAN_DURATION_MS};
  if (!storage || typeof storage.getItem !== 'function') return fallback;
  try {
    const data = JSON.parse(storage.getItem(SCAN_KEY) || '');
    if (!data || typeof data !== 'object') return fallback;
    return {
      mode: normalizeScanMode(data.mode),
      intervalMs: clampScanInterval(data.intervalMs),
      durationMs: clampScanDuration(data.durationMs)
    };
  } catch {
    return fallback;
  }
}

export function writeScanSettings(storage, state) {
  if (!storage || typeof storage.setItem !== 'function' || !state) return false;
  try {
    storage.setItem(SCAN_KEY, JSON.stringify({
      v: 1,
      mode: normalizeScanMode(state.mode),
      intervalMs: clampScanInterval(state.intervalMs),
      durationMs: clampScanDuration(state.durationMs)
    }));
    return true;
  } catch {
    return false;
  }
}

function lumOf(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function frameMedianLum(rgba, width, height, inside) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 4 || h < 4 || rgba.length < w * h * 4) return null;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 48));
  const lums = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (inside && !inside(x, y)) continue;
      const p = (y * w + x) * 4;
      lums.push(lumOf(rgba[p], rgba[p + 1], rgba[p + 2]));
    }
  }
  if (lums.length < 16) return null;
  lums.sort((a, b) => a - b);
  return lums[lums.length >> 1];
}

// A flash counts only after the camera has actually caught it. Black has to
// fall well under the running projection. White has to rise above it.
export function frameLumStats(rgba, width, height, inside) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 4 || h < 4 || rgba.length < w * h * 4) return null;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 48));
  const lums = [];
  let sum = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (inside && !inside(x, y)) continue;
      const p = (y * w + x) * 4;
      const lum = lumOf(rgba[p], rgba[p + 1], rgba[p + 2]);
      lums.push(lum);
      sum += lum;
    }
  }
  if (lums.length < 16) return null;
  lums.sort((a, b) => a - b);
  return {
    mean: sum / lums.length,
    median: lums[lums.length >> 1],
    p10: lums[Math.floor(lums.length * 0.1)],
    p90: lums[Math.floor(lums.length * 0.9)]
  };
}

// A show frame, with dancers and rings, is not a blank even when most of it
// is dark. The mean has to match the blank and the spread (a stand-in for
// variance) has to stay small.
export function blankFrameVerified(rgba, width, height, mode, inside) {
  const stats = frameLumStats(rgba, width, height, inside);
  if (!stats) return false;
  const spread = stats.p90 - stats.p10;
  if (mode === 'white') return stats.mean >= 150 && spread <= 80;
  if (mode === 'gray') {
    // Dim grey blank: mid mean, not a lit show and not a blackout.
    return stats.mean >= 70 && stats.mean <= 200 && spread <= 90;
  }
  // Black blanks under room light + projector black rarely hit mean≤42.
  // 70 still rejects a lit show frame (mean usually 90–160 inside the quad).
  return stats.mean <= 70 && spread <= 70;
}

export function blankLuminanceMatches(rgba, width, height, mode, inside) {
  return blankFrameVerified(rgba, width, height, mode, inside);
}

export function createBlankSettle(latencyMs = SCAN_CAMERA_LATENCY_MS) {
  let mode = null;
  let rafs = 0;
  let readyAt = 0;
  let latency = clampLatencyMs(latencyMs);
  return {
    setLatency(ms) { latency = clampLatencyMs(ms); },
    latency() { return latency; },
    begin(flash) {
      mode = flash === 'white' || flash === 'black' || flash === 'gray' ? flash : null;
      rafs = 0;
      readyAt = 0;
    },
    // One call per animation frame after begin(). Ready only once two frames
    // have passed and the measured camera latency has elapsed.
    frame(now) {
      if (!mode) return false;
      const t = Number.isFinite(+now) ? +now : 0;
      if (rafs < SCAN_SETTLE_RAF) {
        rafs++;
        if (rafs >= SCAN_SETTLE_RAF) readyAt = t;
        return false;
      }
      if (!readyAt) readyAt = t;
      return t >= readyAt + latency;
    },
    clear() {
      mode = null;
      rafs = 0;
      readyAt = 0;
    }
  };
}

export function pointInQuad(x, y, corners) {
  if (!corners || corners.length !== 4) return true;
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const yi = +corners[i].y;
    const yj = +corners[j].y;
    const xi = +corners[i].x;
    const xj = +corners[j].x;
    const cross = (yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

// Show frames never reach the sticker test. settled is the 2-rAF-plus-latency
// gate. The mean has to match the blank. projected() is the light we drew.
export function scanBlankFrame(rgba, width, height, options = {}) {
  if (!options || options.settled !== true) return [];
  const mode = options.mode === 'white' ? 'white' : 'black';
  const inside = typeof options.inside === 'function' ? options.inside : null;
  if (!blankLuminanceMatches(rgba, width, height, mode, inside)) return [];
  return detectBlankStickers(rgba, width, height, options);
}

export function frameMatchesFlash(rgba, width, height, mode, inside, baseline) {
  const stats = frameLumStats(rgba, width, height, inside);
  if (!stats) return false;
  const base = Number.isFinite(+baseline) ? +baseline : null;
  if (mode === 'white') {
    const floor = Math.max(160, (base == null ? 80 : base) + 30);
    // The darker samples have to be bright too. A dim floor with white
    // dancers on it is not a white blank.
    return stats.median >= floor && stats.median > (base == null ? 0 : base) + 18 && stats.p10 >= 120;
  }
  if (mode === 'gray') {
    const target = base == null ? 140 : Math.min(190, Math.max(90, base + 20));
    return stats.median >= 70 && stats.median <= 210 && Math.abs(stats.median - target) <= 70 && stats.p90 - stats.p10 <= 100;
  }
  const ceiling = Math.min(85, (base == null ? 120 : base) * 0.55);
  // The brighter samples have to stay dark. White silhouettes still on
  // the wall are not a black blank.
  return stats.median <= ceiling && stats.p90 <= 110;
}

export function createScanClock({intervalMs = SCAN_INTERVAL_MS, durationMs = SCAN_DURATION_MS, mode = 'off'} = {}) {
  let interval = clampScanInterval(intervalMs);
  let duration = clampScanDuration(durationMs);
  let flashMode = normalizeScanMode(mode);
  let nextAt = null;
  let blankUntil = 0;
  let detectFrom = 0;
  let active = false;

  function idle(extra) {
    return {flash: null, detect: false, done: false, aborted: false, until: 0, started: false, ...extra};
  }

  return {
    get intervalMs() { return interval; },
    get durationMs() { return duration; },
    get mode() { return flashMode; },
    configure(next = {}) {
      if (next.intervalMs != null) interval = clampScanInterval(next.intervalMs);
      if (next.durationMs != null) duration = clampScanDuration(next.durationMs);
      if (next.holdMs != null) duration = clampScanHold(next.holdMs);
      if (next.mode != null) flashMode = normalizeScanMode(next.mode);
      if (flashMode === 'off' && active) {
        active = false;
        return idle({aborted: true});
      }
      return null;
    },
    abort(now) {
      const was = active;
      active = false;
      blankUntil = 0;
      const t = Number.isFinite(+now) ? +now : 0;
      if (was) nextAt = t + interval;
      return was;
    },
    tick(now, {blocked = false} = {}) {
      const t = Number.isFinite(+now) ? +now : 0;
      if (nextAt == null) nextAt = t + interval;
      if (flashMode === 'off') {
        const aborted = active;
        active = false;
        return idle({aborted});
      }
      if (active && blocked) {
        active = false;
        nextAt = t + interval;
        return idle({aborted: true});
      }
      if (active) {
        if (t >= blankUntil) {
          const start = blankUntil - duration;
          active = false;
          nextAt = start + interval;
          return idle({done: true});
        }
        return {flash: flashMode, detect: t >= detectFrom, done: false, aborted: false, until: blankUntil, started: false};
      }
      if (blocked || t < nextAt) return idle();
      active = true;
      const lead = Math.min(SCAN_LEAD_MS, Math.max(0, duration - 50));
      detectFrom = t + lead;
      blankUntil = t + duration;
      return {flash: flashMode, detect: t >= detectFrom, done: false, aborted: false, until: blankUntil, started: true};
    }
  };
}

function fillComponent(mask, w, h, x, y, seen) {
  const qx = [x];
  const qy = [y];
  seen[y * w + x] = 1;
  let area = 0;
  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;
  let head = 0;
  while (head < qx.length) {
    const cx = qx[head];
    const cy = qy[head];
    head++;
    area++;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!mask[ni] || seen[ni]) continue;
        seen[ni] = 1;
        qx.push(nx);
        qy.push(ny);
      }
    }
  }
  return {area, minX, maxX, minY, maxY};
}

export function luminancePlane(rgba, width, height) {
  const w = width | 0;
  const h = height | 0;
  const out = new Uint8Array(Math.max(0, w * h));
  if (!rgba || w < 1 || h < 1 || rgba.length < w * h * 4) return out;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    out[i] = Math.max(0, Math.min(255, Math.round(lumOf(rgba[p], rgba[p + 1], rgba[p + 2]))));
  }
  return out;
}

function fieldBounds(lums, w, h, lit) {
  const rowCut = Math.max(8, Math.round(w * 0.35));
  const colCut = Math.max(8, Math.round(h * 0.28));
  let y0 = -1;
  let y1 = -1;
  let x0 = -1;
  let x1 = -1;
  let run = -1;
  let best = 0;
  for (let y = 0; y <= h; y++) {
    let n = 0;
    if (y < h) for (let x = 0; x < w; x++) if ((lit ? lums[y * w + x] > 110 : lums[y * w + x] < 48)) n++;
    if (y < h && n >= rowCut) {
      if (run < 0) run = y;
    } else if (run >= 0) {
      if (y - run > best) {
        best = y - run;
        y0 = run;
        y1 = y - 1;
      }
      run = -1;
    }
  }
  run = -1;
  best = 0;
  for (let x = 0; x <= w; x++) {
    let n = 0;
    if (x < w) for (let y = 0; y < h; y++) if ((lit ? lums[y * w + x] > 110 : lums[y * w + x] < 48)) n++;
    if (x < w && n >= colCut) {
      if (run < 0) run = x;
    } else if (run >= 0) {
      if (x - run > best) {
        best = x - run;
        x0 = run;
        x1 = x - 1;
      }
      run = -1;
    }
  }
  if (y0 < 0 || x0 < 0 || y1 - y0 < 8 || x1 - x0 < 8) return null;
  const insetX = Math.max(2, Math.round((x1 - x0) * 0.045));
  const insetY = Math.max(2, Math.round((y1 - y0) * 0.05));
  return {x0: x0 + insetX, y0: y0 + insetY, x1: x1 - insetX, y1: y1 - insetY};
}

function ringFloor(lums, w, h, x, y, radius, bright) {
  const samples = [];
  for (let k = 0; k < 12; k++) {
    const angle = k * Math.PI / 6;
    const nx = Math.min(w - 1, Math.max(0, Math.round(x + Math.cos(angle) * radius)));
    const ny = Math.min(h - 1, Math.max(0, Math.round(y + Math.sin(angle) * radius)));
    samples.push(lums[ny * w + nx]);
  }
  samples.sort((a, b) => a - b);
  // The dimmer third ignores a bright dancer sitting beside a dark sticker.
  // The brighter third ignores a dark bezel beside a light sticker.
  return samples[bright ? Math.floor(samples.length / 3) : Math.ceil(samples.length * 0.66)];
}

function ringFill(lums, w, h, x, y, whiteFloor) {
  const samples = [];
  for (let k = 0; k < 16; k++) {
    const angle = k * Math.PI / 8;
    const nx = Math.min(w - 1, Math.max(0, Math.round(x + Math.cos(angle) * 16)));
    const ny = Math.min(h - 1, Math.max(0, Math.round(y + Math.sin(angle) * 16)));
    samples.push(lums[ny * w + nx]);
  }
  samples.sort((a, b) => a - b);
  const index = whiteFloor ? Math.ceil((samples.length - 1) * 0.7) : Math.floor(samples.length * 0.3);
  return samples[index];
}

// The stored floor is the empty blank, with sticker-sized holes filled in.
// A frame that is not actually blank, or that has a person in it, is refused
// so it cannot hide the next detection.
export function buildFloorReference(rgba, width, height, mode) {
  const kind = mode === 'white' ? 'white' : 'black';
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 8 || h < 8 || rgba.length < w * h * 4) return {ok: false, reason: 'empty'};
  if (!blankFrameVerified(rgba, w, h, kind)) return {ok: false, reason: 'not-blank'};
  const person = personInFrame(rgba, w, h, {sensitivity: 0.35});
  if (person.present || person.holding) return {ok: false, reason: 'person'};
  const lum = luminancePlane(rgba, w, h);
  const hole = new Uint8Array(w * h);
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (let y = edge; y < h - edge; y++) {
    for (let x = edge; x < w - edge; x++) {
      const v = lum[y * w + x];
      const far = ringFloor(lum, w, h, x, y, 14, kind === 'white');
      if (kind === 'white') {
        if (far >= 110 && v < far - 18 && v < far * 0.8) hole[y * w + x] = 1;
      } else if (far <= 48 && v > far + 24 && v > far * 1.6) {
        hole[y * w + x] = 1;
      }
    }
  }
  const seen = new Uint8Array(w * h);
  const maxHole = Math.max(80, Math.round(w * h * 0.02));
  const components = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!hole[start] || seen[start]) continue;
      const box = fillComponent(hole, w, h, x, y, seen);
      if (box.area > maxHole) return {ok: false, reason: 'person'};
      components.push(box);
    }
  }
  const filled = new Uint8Array(lum);
  for (const box of components) {
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        if (!hole[y * w + x]) continue;
        filled[y * w + x] = Math.max(0, Math.min(255, Math.round(ringFill(lum, w, h, x, y, kind === 'white'))));
      }
    }
  }
  return {ok: true, lum: filled, width: w, height: h, reason: 'floor'};
}

function insideExclude(exclude, x, y) {
  if (!exclude) return false;
  for (const rect of exclude) {
    if (!rect) continue;
    const rx = +rect.x;
    const ry = +rect.y;
    const rw = +rect.w;
    const rh = +rect.h;
    if (x >= rx && y >= ry && x < rx + rw && y < ry + rh) return true;
  }
  return false;
}

// Far camera (TJ 8:12 PM, phone closer but stickers still ~3x9 detect px):
// on a blob a few pixels across, one pixel of rounding swings the aspect
// past the 0.35 / 2.6 gates, so an upright sticker 3 px wide and 9 px tall
// (0.33) was dropped as a "slash". Tiny blobs get one pixel of slack toward
// square. A 1-px line still fails (2/8 = 0.25), and big blobs are unchanged.
export const TINY_STICKER_SPAN = 12;
export function tinyStickerAspect(bw, bh) {
  const w = Math.max(1, +bw || 0);
  const h = Math.max(1, +bh || 0);
  const raw = w / h;
  if (w > TINY_STICKER_SPAN || h > TINY_STICKER_SPAN) return raw;
  if (raw < 1) return Math.min(1, (w + 1) / h);
  if (raw > 1) return Math.max(1, w / (h + 1));
  return raw;
}

// One physical sticker that splits into two blobs on a white scan (head and
// body a few px apart) must not become two dancers (TJ 8:12 PM: 569,291 and
// 573,313). Real stickers sit much farther apart than this (stage px).
export const SCAN_SPLIT_MERGE = 36;
export const STICKER_COMPACT_MIN = 0.34;
export const STICKER_COMPACT_FIGURE = 0.22;
export const STICKER_FIGURE_CORE = 0.5;

// Darkest quarter of the blob's pixels over the lit floor ring around it.
// Vinyl on a white flash reads ~0.25; a soft seam or shadow edge reads 0.7+.
export function blobCoreRatio(lums, w, h, box, mask, mode = 'white') {
  const vals = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      if (mask[y * w + x]) vals.push(lums[y * w + x]);
    }
  }
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  const core = vals[Math.floor((vals.length - 1) * 0.25)];
  const cx = Math.round((box.minX + box.maxX) / 2);
  const cy = Math.round((box.minY + box.maxY) / 2);
  const reach = Math.max(14, Math.ceil(Math.max(box.maxX - box.minX, box.maxY - box.minY) / 2) + 4);
  const floor = ringFloor(lums, w, h, cx, cy, reach, mode === 'white');
  if (!(floor > 0)) return 1;
  return core / floor;
}

export function detectBlankStickers(rgba, width, height, options = {}) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 8 || h < 8 || rgba.length < w * h * 4) return [];
  const mode = options.mode === 'white' ? 'white' : 'black';
  const sensitivity = Math.min(1, Math.max(0, Number.isFinite(+options.sensitivity) ? +options.sensitivity : 0.5));
  const lums = new Float32Array(w * h);
  const sample = [];
  const step = Math.max(1, Math.floor(Math.max(w, h) / 48));
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    lums[i] = lumOf(rgba[p], rgba[p + 1], rgba[p + 2]);
    if ((i % (step * w)) < w && (Math.floor(i / w) % step) === 0 && (i % step) === 0) sample.push(lums[i]);
  }
  sample.sort((a, b) => a - b);
  const frameMedian = sample.length ? sample[sample.length >> 1] : 0;
  // A lit picture is not a black flash, and a dark picture is not a white flash.
  if (mode === 'black' && frameMedian > 88) return [];
  if (mode === 'white' && frameMedian < 36) return [];
  const reference = options.reference && options.reference.length === w * h ? options.reference : null;
  const bounds = fieldBounds(lums, w, h, mode === 'white');
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const xLo = bounds ? Math.max(edge, bounds.x0) : edge;
  const yLo = bounds ? Math.max(edge, bounds.y0) : edge;
  const xHi = bounds ? Math.min(w - 1 - edge, bounds.x1) : w - 1 - edge;
  const yHi = bounds ? Math.min(h - 1 - edge, bounds.y1) : h - 1 - edge;
  if (xHi - xLo < 6 || yHi - yLo < 6) return [];
  const mask = new Uint8Array(w * h);
  const darkGap = 30 - sensitivity * 10;
  const brightGap = 46 - sensitivity * 12;
  const exclude = Array.isArray(options.exclude) ? options.exclude : null;
  const inside = typeof options.inside === 'function' ? options.inside : null;
  const projected = typeof options.projected === 'function' ? options.projected : null;
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      if (inside && !inside(x, y)) continue;
      if (insideExclude(exclude, x, y)) continue;
      if (projected) {
        let drawn = false;
        try { drawn = projected(x, y) === true; } catch { drawn = false; }
        if (drawn) continue;
      }
      const v = lums[y * w + x];
      const far = ringFloor(lums, w, h, x, y, 14, mode === 'white');
      const ref = reference ? reference[y * w + x] : null;
      let hit = false;
      if (mode === 'white') {
        // Both the far ring and, when we have one, the empty lit floor have
        // to be bright. The edge of a large dark projected shape fails that,
        // so it cannot grow a silhouette. A small sticker sits in the floor.
        const floorLum = ref == null ? far : Math.min(far, ref);
        if (far < 110 || floorLum < 96) continue;
        hit = v < floorLum - darkGap && v < floorLum * 0.75;
        if (hit && ref != null) hit = v < ref - 14;
      } else {
        const floorLum = ref == null ? far : Math.max(far, ref);
        if (far > 48 || floorLum > 72) continue;
        hit = v > floorLum + brightGap && v > floorLum * 1.7;
        if (hit && ref != null) hit = v > ref + 24;
      }
      if (hit) mask[y * w + x] = 1;
    }
  }
  // Fill a one-pixel hole that sits directly between two sticker pixels.
  // A full dilate would also glue specks and grid crossings into false blobs.
  const bridged = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      if ((mask[i - 1] && mask[i + 1]) || (mask[i - w] && mask[i + w])) bridged[i] = 1;
    }
  }
  mask.set(bridged);
  const seen = new Uint8Array(w * h);
  const minArea = Math.max(4, Math.round(w * h * 0.000025));
  const maxArea = Math.max(480, Math.round(w * h * 0.012));
  const blobs = [];
  const rejected = options.report || null;
  if (rejected) {
    rejected.area = 0;
    rejected.aspect = 0;
    rejected.edge = 0;
    rejected.compact = 0;
    rejected.contrast = 0;
    rejected.ui = 0;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      const box = fillComponent(mask, w, h, x, y, seen);
      const bw = box.maxX - box.minX + 1;
      const bh = box.maxY - box.minY + 1;
      const aspect = tinyStickerAspect(bw, bh);
      const compact = box.area / Math.max(1, bw * bh);
      // Elongation: bbox diagonal over sqrt(area). A long thin slash is high.
      const elong = Math.hypot(bw, bh) / Math.sqrt(Math.max(1, box.area));
      if (box.area < minArea || box.area > maxArea) {
        if (rejected) rejected.area++;
        continue;
      }
      // Human stickers are roughly upright (TJ 4:20 PM: reject long diagonal slash).
      if (aspect < 0.35 || aspect > 2.6 || elong > 4.2) {
        if (rejected) rejected.aspect++;
        continue;
      }
      // Dancing-figure stickers (spread arms and legs) fill only ~0.25-0.40 of
      // their box, and a crisp white flash separates the limbs further. The old
      // flat 0.34 cut dropped TJ's left sticker on Nov 10 1:12 PM (scan
      // rejected.compact). A blob between STICKER_COMPACT_FIGURE and 0.34 is
      // kept only when its core is solid vinyl-dark against the lit floor, which
      // a thin seam, cable or grid crossing never is.
      if (compact < STICKER_COMPACT_MIN) {
        const figure = compact >= STICKER_COMPACT_FIGURE && mode === 'white'
          && blobCoreRatio(lums, w, h, box, mask, mode) <= STICKER_FIGURE_CORE;
        if (!figure) {
          if (rejected) rejected.compact++;
          continue;
        }
      }
      if (box.minX <= xLo || box.minY <= yLo || box.maxX >= xHi || box.maxY >= yHi) {
        if (rejected) rejected.edge++;
        continue;
      }
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let yy = box.minY; yy <= box.maxY; yy++) {
        for (let xx = box.minX; xx <= box.maxX; xx++) {
          if (!mask[yy * w + xx]) continue;
          sx += xx;
          sy += yy;
          n++;
        }
      }
      const cx = sx / n;
      const cy = sy / n;
      if (insideExclude(exclude, cx, cy)) {
        if (rejected) rejected.ui++;
        continue;
      }
      const blob = {x: cx, y: cy, area: box.area, kind: 'sticker', aspect, elongation: elong};
      const contour = traceContour(mask, w, h, {x: box.minX, y: box.minY});
      if (contour && contour.length >= 3) blob.contour = contour;
      blobs.push(blob);
    }
  }
  blobs.sort((a, b) => b.area - a.area || a.x - b.x);
  return blobs;
}

export function mergeScanPoints(points, radius = 80) {
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : 80;
  const clusters = [];
  for (const point of points || []) {
    if (!point || !Number.isFinite(+point.x) || !Number.isFinite(+point.y)) continue;
    let best = null;
    let bestD = limit;
    for (const cluster of clusters) {
      const d = Math.hypot(cluster.x - point.x, cluster.y - point.y);
      if (d <= bestD) {
        bestD = d;
        best = cluster;
      }
    }
    if (!best) {
      clusters.push({
        x: +point.x,
        y: +point.y,
        kind: point.kind === 'pink' ? 'pink' : 'sticker',
        contour: point.contour || null,
        projectedHeight: Number.isFinite(+point.projectedHeight) && +point.projectedHeight > 0 ? +point.projectedHeight : 0,
        n: 1
      });
      continue;
    }
    const n = best.n + 1;
    best.x = (best.x * best.n + point.x) / n;
    best.y = (best.y * best.n + point.y) / n;
    best.n = n;
    if (point.contour) best.contour = point.contour;
    if (!(best.projectedHeight > 0) && Number.isFinite(+point.projectedHeight) && +point.projectedHeight > 0) best.projectedHeight = +point.projectedHeight;
  }
  return clusters.map(cluster => {
    const item = {x: cluster.x, y: cluster.y, kind: cluster.kind};
    if (cluster.contour) item.contour = cluster.contour;
    if (cluster.projectedHeight > 0) item.projectedHeight = cluster.projectedHeight;
    return item;
  });
}

function contourSpan(contour) {
  if (!contour || contour.length < 3) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of contour) {
    if (!point) continue;
    minX = Math.min(minX, +point.x);
    minY = Math.min(minY, +point.y);
    maxX = Math.max(maxX, +point.x);
    maxY = Math.max(maxY, +point.y);
  }
  if (!Number.isFinite(minX) || maxX < minX || maxY < minY) return 0;
  return (maxX - minX + 1) * (maxY - minY + 1);
}

// A latched outline may tighten. It may not swell into the shape the
// projector just drew, which is how a dot becomes a growing blob.
export function retainContour(previous, next) {
  if (!next || next.length < 3) return previous && previous.length >= 3 ? previous : null;
  if (!previous || previous.length < 3) return next;
  if (contourSpan(next) > contourSpan(previous) * 1.2) return previous;
  // A fragment (part of the sticker hidden under its own projected glow)
  // does not replace the full outline either.
  if (contourSpan(next) < contourSpan(previous) * 0.7) return previous;
  return next;
}

function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// Small jitter stays on the latched point. A real move has to repeat past
// the hold radius for several scans before the dot is allowed to jump.
function smoothScanPoint(track, spot) {
  const hold = SCAN_HOLD_PX;
  const samples = Array.isArray(track.samples) && track.samples.length ? track.samples.slice() : [{x: track.x, y: track.y}];
  let pending = Array.isArray(track.pending) ? track.pending.slice() : [];
  const dist = Math.hypot(spot.x - track.x, spot.y - track.y);
  if (track.latched && dist <= hold) {
    return {x: track.x, y: track.y, samples, pending: []};
  }
  if (!track.latched) {
    samples.push({x: spot.x, y: spot.y});
    if (samples.length > 5) samples.shift();
    return {
      x: medianOf(samples.map(point => point.x)),
      y: medianOf(samples.map(point => point.y)),
      samples,
      pending: []
    };
  }
  pending.push({x: spot.x, y: spot.y});
  if (pending.length > SCAN_MOVE_HITS) pending.shift();
  const agreed = pending.length >= SCAN_MOVE_HITS && pending.every(point => Math.hypot(point.x - spot.x, point.y - spot.y) <= hold);
  if (!agreed) return {x: track.x, y: track.y, samples, pending};
  return {
    x: medianOf(pending.map(point => point.x)),
    y: medianOf(pending.map(point => point.y)),
    samples: pending.slice(),
    pending: []
  };
}

function safeCovered(fn, track) {
  try { return !!fn(track.x, track.y, track); } catch { return false; }
}

export function createScanBook({hits = SCAN_HITS, misses = SCAN_MISSES, latchedMisses = null, autoLatchedMisses = null, radius = 80} = {}) {
  const hitLimit = Math.max(1, hits | 0);
  const missLimit = Math.max(1, misses | 0);
  const latchedLimit = latchedMisses == null ? missLimit : Math.max(missLimit, Math.floor(+latchedMisses) || missLimit);
  // Tracks that latched from observe() alone (not restored from a Scan).
  const autoLimit = autoLatchedMisses == null ? latchedLimit : Math.max(missLimit, Math.floor(+autoLatchedMisses) || missLimit);
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : 80;
  let tracks = [];
  let nextId = 1;

  function markers() {
    return tracks.filter(track => track.latched).map(track => {
      const marker = {id: track.id, x: track.x, y: track.y, kind: track.kind, scanned: !!track.scanned};
      if (Number.isFinite(+track.projectedHeight) && +track.projectedHeight > 0) marker.projectedHeight = +track.projectedHeight;
      if (track.contour) marker.contour = track.contour;
      return marker;
    });
  }

  return {
    markers,
    reset() { tracks = []; },
    restore(list) {
      for (const marker of list || []) {
        if (!marker || !Number.isFinite(+marker.x) || !Number.isFinite(+marker.y)) continue;
        let id = marker.id | 0;
        if (!(id > 0) || tracks.some(track => track.id === id)) id = nextId++;
        if (id >= nextId) nextId = id + 1;
        tracks.push({
          id,
          x: +marker.x,
          y: +marker.y,
          kind: marker.kind === 'pink' ? 'pink' : 'sticker',
          contour: marker.contour || null,
          hits: hitLimit,
          misses: 0,
          latched: true,
          scanned: true,
          projectedHeight: Number.isFinite(+marker.projectedHeight) ? +marker.projectedHeight : 0
        });
      }
      return markers();
    },
    // opts.allowNew=false: only update existing tracks (Scan stickers is the
    // authority on how many dancers there are; projected light cannot add more).
    observe(points, opts = {}) {
      const allowNew = !(opts && opts.allowNew === false);
      const allowPoint = opts && typeof opts.allowPoint === 'function' ? opts.allowPoint : null;
      const latchNew = !!(opts && opts.latchNew);
      const markScanned = !!(opts && opts.scanned);
      const covered = opts && typeof opts.covered === 'function' ? opts.covered : null;
      const incoming = mergeScanPoints(points, limit);
      const used = new Set();
      const next = [];
      for (const track of tracks) {
        let best = -1;
        let bestD = limit;
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
          const spot = incoming[best];
          const seen = track.hits + 1;
          const placed = smoothScanPoint(track, spot, limit);
          next.push({
            id: track.id,
            x: placed.x,
            y: placed.y,
            kind: spot.kind || track.kind,
            contour: track.latched ? retainContour(track.contour, spot.contour) : (spot.contour || track.contour),
            hits: seen,
            misses: 0,
            latched: track.latched || seen >= hitLimit,
            scanned: !!track.scanned || markScanned,
            samples: placed.samples,
            pending: placed.pending,
            projectedHeight: Number.isFinite(+spot.projectedHeight) ? +spot.projectedHeight : track.projectedHeight
          });
        } else if (track.latched && !track.scanned && covered && safeCovered(covered, track)) {
          // Nov 10 (TJ 10:03 AM): the dancer we project on a sticker hides it
          // from the camera. A latched sticker under its own projected figure
          // is self-occluded, not missing: hold it without counting a miss.
          // Only a miss over a dark stage counts toward the ~3 s expiry.
          next.push({...track, covered: (track.covered | 0) + 1});
        } else if (track.misses + 1 < (track.latched ? (track.scanned ? latchedLimit : autoLimit) : missLimit)) {
          next.push({...track, misses: track.misses + 1});
        }
      }
      for (let i = 0; i < incoming.length; i++) {
        const spot = incoming[i];
        const admitted = allowNew || (allowPoint && allowPoint(spot));
        if (used.has(i) || !admitted) continue;
        next.push({
          id: nextId++,
          x: spot.x,
          y: spot.y,
          kind: spot.kind,
          contour: spot.contour || null,
          hits: latchNew ? hitLimit : 1,
          misses: 0,
          latched: latchNew || hitLimit <= 1,
          scanned: markScanned,
          samples: [{x: spot.x, y: spot.y}],
          pending: []
        });
      }
      tracks = next;
      return markers();
    }
  };
}
