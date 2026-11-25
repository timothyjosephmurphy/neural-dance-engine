// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import {pointInQuad} from './painting-frame.js';

// Person-in-frame pause for Neural Dance sticker detection.
// A person is one connected region: a meaningful share of the frame and a tall
// box, or a skin-toned region larger than a face-sized smudge. Neon dancer
// colors stay out of the body mask. Projected pulses and silhouettes are
// subtracted with the stage echo before either mask is built.
// Ambient light changes (lamps / wall wash) re-baseline via a global luminance
// shift check so a brighter empty stage is not read as a body (TJ 4:42 PM).
//
// The default sensitivity is low. Higher sensitivity lowers the area and
// aspect bars. A hit has to hold for PERSON_ENTER_FRAMES, and a miss has to
// hold for PERSON_EXIT_FRAMES, before the pause changes. The hold bars are
// looser than the enter bars so a flickering edge does not flap the gate.
//
// Hook: live detect() calls personInFrame, then observe(). While the result
// is paused or settling, sticker blobs must not latch. After PERSON_CLEAR_MS
// of clear frames, observe() returns flashRescan so the live page runs Scan
// stickers (white flash) once, replacing auto stickers and keeping manuals.
// [data-person-note] on /neural-dance/live/ and /neural-dance/debug/ shows
// PERSON_PAUSE_NOTE while a person is actually in frame.
// The live dock toggle and the debug patch both persist through PERSON_PAUSE_KEY.
// Default is on.

export const PERSON_PAUSE_NOTE = 'person in frame, detection paused';
// Steady line while the floor is already clear and the settle wait is running.
// Replacing the pause note with null made the banner flash off every motion
// hold and again for the whole settle (studio Nov 23).
export const PERSON_RESUME_NOTE = 'floor clear, scan resumes shortly';
export const PERSON_PAUSE_KEY = 'nd.personPause.v2';
// Floor must read person-free AND still for this long before Scan stickers
// runs (TJ Nov 11 3:06 PM: the scan started while he was still in frame).
export const PERSON_CLEAR_MS = 1800;
export const PERSON_STAY_RADIUS = 80;
export const PERSON_SENSITIVITY_DEFAULT = 0.35;
export const PERSON_ENTER_FRAMES = 4;
// Consecutive person-free frames before the clear wait even starts. Was 3
// detect frames (~300 ms at the 10 Hz detect rate): one crouch or a body half
// outside the stage read as gone. 8 frames ≈ 0.8 s, then PERSON_CLEAR_MS.
export const PERSON_EXIT_FRAMES = 8;
// Motion on the floor (unprojected cells whose luma moved) also holds the
// settle wait after a person was seen. A share of moving cells this high is
// someone still there; the echo veto removes the projected dancers first.
export const PERSON_MOTION_HOLD = 0.02;
export const PERSON_MOTION_DELTA = 22;
// Motion alone can extend the wait this long after the last person frame,
// so a busy projection (ripples) can never block the rescan forever.
export const PERSON_MOTION_MAX_MS = 6000;
// A scan that finds someone in its white frame re-arms the pause this many
// times in a row, then gives up (reports instead of looping on a false hit).
export const PERSON_SCAN_RETRIES = 3;
export const PERSON_PAUSE_OFF_NOTE = 'Person pause off \u2014 sticker scans won\u2019t trigger';
// Storage version. v1 saves (before Nov 11) that say off migrate to on once
// (TJ 3:06 PM: on is the show default); a later off choice is kept.
export const PERSON_PAUSE_STORE_V = 2;
export const PERSON_MIN_FRACTION = 0.2;
export const PERSON_TALL_ASPECT = 1.45;
export const PERSON_SKIN_FRACTION = 0.04;
export const PERSON_MAX_FRACTION = 0.93;
export const PERSON_LUMA_DELTA = 32;
export const PERSON_BODY_SATURATION = 0.42;
// A dark connected occluder this large (share of the stage area) is a person
// whatever its box shape: the stage edge clips the body, so a standing person
// often reads wider than tall (Nov 9 3:17 PM rig: 0.15-0.17 with TJ in frame,
// 0.02 empty). Stickers are under 1%.
export const PERSON_LARGE_FRACTION = 0.08;
// A box smaller than this (detect pixels) is a sticker, a mark, or noise.
export const PERSON_MIN_BOX = 140;
export const PERSON_LARGE_HOLD = 0.06;
// Relative darkening vs the floor (fraction of floor luma). Absolute PERSON_LUMA_DELTA
// alone false-triggers when ambient lamps raise the whole stage (TJ 4:42 PM).
export const PERSON_LUMA_REL = 0.22;
// If the frame median drifted this far from the reference median, treat it as a
// lighting change and rebuild the floor reference from the current frame.
export const PERSON_REBASE_LUMA = 28;

// Static-content reference (TJ Nov 11 3:41 PM: the framed painting's dark
// lower half + black frame read as a "large dark occluder" person). The
// background learner keeps a per-cell colour picture of the stage, normalised
// by the frame median so ambient / projector level changes cancel. A cell only
// counts toward a body when it differs from that picture, so unchanging
// content (a painting, a dark prop) is ignored while a person stepping in
// still darkens cells against it. The learner only absorbs frames while the
// gate is clear, so a person who stands still is not learned into the floor.
export const PERSON_BG_DIFF = 0.2;      // normalised channel change that counts as "changed"
export const PERSON_BG_LEARN = 0.04;    // EMA per clear frame (~2.5 s at 10 Hz)
export const PERSON_BG_SEED_FRAMES = 6; // fast seeding after reset / calibration

export const PERSON_BG_STABLE_MS = 10000; // a cell unchanged this long while paused is scenery
export const PERSON_BG_STABLE_DIFF = 0.06;
export const PERSON_BG_GLOBAL = 0.3;
// A close-up head or shoulder changes most cells once colours are divided by
// the frame median, so globalChange alone cannot tell a person from a flash.
// Two checks split them (studio Nov 23 pr144/pr146 close-ups):
// - A flash or white scan frame lifts the whole picture: the frame median
//   rises PERSON_BG_BRIGHT over the learned level.
// - A body is a connected patch much darker than the learned picture in the
//   same cells (hair on paint reads ~0.25-0.45 of the cell), measured against
//   the brightest-ratio cells so a camera exposure step cancels out. A lamp
//   change scales every cell alike, so it leaves no such patch.
export const PERSON_BG_BRIGHT = 1.2;
export const PERSON_DARK_RATIO = 0.6;
// A dark patch this large that runs off the edge of the picture is a person
// entering or leaning in, even when it is wider than tall.
export const PERSON_EDGE_OCCLUDER = 0.04;
// A dark patch whose log brightness still tracks the learned picture this
// closely is the painting dimmed by light (exposure recovery after a flash,
// a dark cue, the align grid), not a body covering it. Studio Nov 23: light
// 0.78-0.99, people 0.08-0.69.
export const PERSON_SHADE_CORR = 0.75;

export function createStaticBackground({learn = PERSON_BG_LEARN, seedFrames = PERSON_BG_SEED_FRAMES, stableMs = PERSON_BG_STABLE_MS} = {}) {
  let cols = 0, rows = 0, ref = null, frames = 0, fast = null, since = null, level = 0;
  const api = {
    reset() { ref = null; fast = null; since = null; frames = 0; cols = 0; rows = 0; level = 0; },
    ready() { return !!ref && frames >= seedFrames; },
    frames() { return frames; },
    // cells: Float32Array(cols*rows*3) of median-normalised r,g,b; NaN = skip.
    // An optional trailing value is the frame median (personInFrame adds it).
    // clear=true (nobody in frame): blend everything. clear=false (gate
    // paused): only absorb cells that have held still for stableMs, so a
    // scene change made while someone was in frame (sims off, a new prop)
    // cannot pin the gate on forever, but a moving person never is learned.
    update(cells, c, r, {clear = true, now = 0, global = false} = {}) {
      if (!cells || !(c > 0) || !(r > 0)) return false;
      const n = c * r;
      // personInFrame appends the frame median after the cells, so the
      // learned picture also knows how bright the empty stage was.
      const lvl = cells.length > n * 3 && Number.isFinite(cells[n * 3]) ? cells[n * 3] : 0;
      if (!ref || c !== cols || r !== rows) {
        cols = c; rows = r; ref = Float32Array.from(cells.subarray(0, n * 3)); fast = Float32Array.from(cells.subarray(0, n * 3));
        since = new Float64Array(n).fill(now); frames = 1; level = lvl; return true;
      }
      const k = frames < seedFrames ? 1 / (frames + 1) : learn;
      if (lvl > 0 && ((clear && !global) || frames < seedFrames)) level = level > 0 ? level + (lvl - level) * k : lvl;
      for (let cell = 0; cell < n; cell++) {
        let moved = false;
        for (let ch = 0; ch < 3; ch++) {
          const j = cell * 3 + ch, v = cells[j];
          if (!Number.isFinite(v)) continue;
          if (!Number.isFinite(fast[j])) fast[j] = v;
          if (Math.abs(v - fast[j]) > PERSON_BG_STABLE_DIFF) moved = true;
          fast[j] += (v - fast[j]) * 0.5;
        }
        if (moved) since[cell] = now;
        // A whole-frame change is not blended on the frame it appears. A
        // flash or blank shorter than stableMs leaves ref alone. A shifted
        // empty room that then holds still is absorbed after stableMs, so
        // globalChange can fall again. A moving person (clear=false, cells
        // keep moving) is never learned.
        const absorb = (clear && !global) || frames < seedFrames || (now - since[cell] >= stableMs);
        if (!absorb) continue;
        const kk = (clear && !global) || frames < seedFrames ? k : Math.max(k, 0.25);
        for (let ch = 0; ch < 3; ch++) {
          const j = cell * 3 + ch, v = cells[j];
          if (!Number.isFinite(v)) continue;
          ref[j] = Number.isFinite(ref[j]) ? ref[j] + (v - ref[j]) * kk : v;
        }
      }
      frames++;
      return true;
    },
    // True when cell i (grid index) differs from the learned picture.
    changed(cells, i) {
      if (!api.ready() || !cells) return true;
      const j = i * 3;
      let d = 0, rel = 0;
      for (let c = 0; c < 3; c++) {
        const a = cells[j + c], b = ref[j + c];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
        const x = Math.abs(a - b);
        d = Math.max(d, x);
        rel = Math.max(rel, x / Math.max(0.15, b));
      }
      // Absolute change, or a relative one on dark content (clothing over
      // the painting's dark ground is a small absolute step).
      return d >= PERSON_BG_DIFF || (d >= PERSON_BG_DIFF * 0.4 && rel >= 0.35);
    },
    matches(c, r) { return !!ref && c === cols && r === rows; },
    // Learned frame median (0 when the caller never supplied one).
    level() { return level; },
    // Median-normalised luminance of the learned picture at cell i.
    lum(i) {
      if (!ref) return NaN;
      const j = i * 3;
      return luminance(ref[j], ref[j + 1], ref[j + 2]);
    }
  };
  return api;
}

export function clampPersonSensitivity(value, fallback = PERSON_SENSITIVITY_DEFAULT) {
  const n = +value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// Sensitivity 0 is the strict bar. Sensitivity 1 is the old loose bar.
// Hold bars stay below the enter bars (hysteresis).
export function personCuts(sensitivity = PERSON_SENSITIVITY_DEFAULT) {
  const s = clampPersonSensitivity(sensitivity);
  const fraction = 0.2 - s * 0.12;
  const aspect = 1.45 - s * 0.25;
  const skin = 0.04 - s * 0.02;
  return {
    fraction,
    aspect,
    skin,
    holdFraction: fraction * 0.72,
    holdAspect: Math.max(1.05, aspect * 0.82),
    holdSkin: skin * 0.65,
    maxFraction: PERSON_MAX_FRACTION
  };
}

export function readPersonPause(storage) {
  const fallback = {enabled: true, sensitivity: PERSON_SENSITIVITY_DEFAULT};
  if (!storage || typeof storage.getItem !== 'function') return fallback;
  try {
    const raw = storage.getItem(PERSON_PAUSE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return fallback;
    const legacy = !(+data.v >= PERSON_PAUSE_STORE_V);
    return {
      enabled: legacy ? true : data.enabled !== false,
      sensitivity: clampPersonSensitivity(data.sensitivity),
      migrated: legacy && data.enabled === false
    };
  } catch {
    return fallback;
  }
}

export function writePersonPause(storage, state) {
  if (!storage || typeof storage.setItem !== 'function' || !state) return false;
  try {
    storage.setItem(PERSON_PAUSE_KEY, JSON.stringify({
      v: PERSON_PAUSE_STORE_V,
      enabled: state.enabled !== false,
      sensitivity: clampPersonSensitivity(state.sensitivity)
    }));
    return true;
  } catch {
    return false;
  }
}

export function emptyOcclusion() {
  return {paused: false, settling: false, phase: 'clear', note: null, latch: null, rescan: false, flashRescan: false};
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 1) return 0;
  return (max - Math.min(r, g, b)) / max;
}

// Yellow-red skin, not a pink note (hue ~330) and not a maxed neon dancer.
export function isSkinTone(r, g, b) {
  if (r < 95 || g < 40 || b < 20 || r <= g || r <= b) return false;
  // Projector beige (the silhouette fill) is bright in every channel.
  // A face has a darker channel than that wash.
  if (Math.min(r, g, b) > 150 || luminance(r, g, b) > 210) return false;
  const rg = r - g;
  if (rg <= 24 || rg > 90) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 12 || max < 70) return false;
  const s = d / max;
  if (s < 0.22 || s > 0.65) return false;
  let h = ((g - b) / d) % 6;
  h *= 60;
  if (h < 0) h += 360;
  return h <= 45;
}

function largestComponent(mask, cols, rows, valid = null) {
  const seen = new Uint8Array(mask.length);
  const qx = new Int32Array(mask.length);
  const qy = new Int32Array(mask.length);
  let best = {area: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, edge: false};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const start = y * cols + x;
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;
      seen[start] = 1;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let edge = false;
      while (head < tail) {
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
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) { edge = true; continue; }
            const ni = ny * cols + nx;
            if (valid && !valid[ni]) edge = true;
            if (!mask[ni] || seen[ni]) continue;
            seen[ni] = 1;
            qx[tail] = nx;
            qy[tail] = ny;
            tail++;
          }
        }
      }
      if (area > best.area) best = {area, minX, minY, maxX, maxY, edge, start};
    }
  }
  return best;
}

// Cells of one component (8-connected) starting at start.
function componentCells(mask, cols, rows, start) {
  const seen = new Uint8Array(mask.length);
  const out = [start];
  seen[start] = 1;
  for (let head = 0; head < out.length; head++) {
    const cx = out[head] % cols, cy = (out[head] / cols) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (!mask[ni] || seen[ni]) continue;
      seen[ni] = 1;
      out.push(ni);
    }
  }
  return out;
}

// Correlation of log luminance with the learned picture inside a dark patch.
// Light dimming the painting keeps its texture (high correlation). A body in
// front of it replaces the texture (low correlation).
function shadingCorrelation(mask, cols, rows, start, cells, background) {
  if (!background || typeof background.lum !== 'function') return 0;
  const list = componentCells(mask, cols, rows, start);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const i of list) {
    const b = background.lum(i);
    const v = luminance(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]);
    if (!(b > 0) || !(v > 0)) continue;
    const x = Math.log(b), y = Math.log(v);
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 8) return 0;
  const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
  if (!(vx > 1e-6) || !(vy > 1e-6)) return 0;
  return (sxy / n - (sx / n) * (sy / n)) / Math.sqrt(vx * vy);
}

// Stage-echo veto, mapped from a detection pixel back to projector pixels.
// The same veto that rejects stickers on a bright ring rejects pulses and
// silhouettes here, so the projector cannot pause itself.
export function projectedFromEcho(echo, mapPoint) {
  if (!echo || typeof echo.veto !== 'function' || typeof mapPoint !== 'function') return null;
  return (x, y) => {
    let at = null;
    try { at = mapPoint(x, y); } catch { return false; }
    if (!at || !Number.isFinite(+at.x) || !Number.isFinite(+at.y)) return false;
    try { return echo.veto(+at.x, +at.y) === true; } catch { return false; }
  };
}

export function personInFrame(rgba, width, height, options = {}) {
  const none = {present: false, holding: false, fraction: 0, bodyFraction: 0, skinFraction: 0, aspect: 0, motion: 0, grid: null};
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 8 || h < 8 || rgba.length < w * h * 4) return none;
  const cuts = personCuts(options.sensitivity);
  const requested = Number.isFinite(+options.step) ? Math.max(1, options.step | 0) : 0;
  const step = requested || Math.max(1, Math.floor(Math.max(w, h) / 80));
  const inside = typeof options.inside === 'function' ? options.inside : null;
  const projectedAt = typeof options.projected === 'function' ? options.projected : null;
  const reference = options.reference && options.reference.length === w * h ? options.reference : null;
  const background = options.background && typeof options.background.changed === 'function' ? options.background : null;
  const contentQuad = Array.isArray(options.contentQuad) && options.contentQuad.length === 4 ? options.contentQuad : null;
  const cols = Math.ceil(w / step);
  const rows = Math.ceil(h / step);
  const valid = new Uint8Array(cols * rows);
  const covered = new Uint8Array(cols * rows);
  const cr = new Uint8Array(cols * rows);
  const cg = new Uint8Array(cols * rows);
  const cb = new Uint8Array(cols * rows);
  const lums = [];
  let counted = 0;
  for (let gy = 0; gy < rows; gy++) {
    const y = Math.min(h - 1, gy * step);
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.min(w - 1, gx * step);
      if (inside && !inside(x, y)) continue;
      const i = gy * cols + gx;
      counted++;
      valid[i] = 1;
      let skip = false;
      if (projectedAt) {
        try { skip = projectedAt(x, y) === true; } catch { skip = false; }
      }
      if (skip) {
        covered[i] = 1;
        continue;
      }
      const p = (y * w + x) * 4;
      cr[i] = rgba[p];
      cg[i] = rgba[p + 1];
      cb[i] = rgba[p + 2];
      lums.push(luminance(rgba[p], rgba[p + 1], rgba[p + 2]));
    }
  }
  if (counted < 16 || lums.length < 16) return none;
  lums.sort((a, b) => a - b);
  const median = lums[lums.length >> 1];
  // Global luminance shift → lighting change, not a person. Drop the stale
  // blank reference and use the live median as the floor (TJ 4:42 PM).
  let floorRef = reference;
  if (reference) {
    const refLums = [];
    for (let i = 0; i < valid.length; i++) {
      if (!valid[i] || covered[i]) continue;
      const gx = i % cols;
      const gy = (i / cols) | 0;
      const sx = Math.min(w - 1, gx * step);
      const sy = Math.min(h - 1, gy * step);
      const v = reference[sy * w + sx];
      if (Number.isFinite(+v)) refLums.push(+v);
    }
    if (refLums.length >= 16) {
      refLums.sort((a, b) => a - b);
      const refMed = refLums[refLums.length >> 1];
      if (Math.abs(median - refMed) >= PERSON_REBASE_LUMA) floorRef = null;
    }
  }
  // Floor motion vs the previous call's grid (same sampling): share of
  // unprojected stage cells whose luma moved by PERSON_MOTION_DELTA.
  const grid = new Float32Array(cols * rows).fill(-1);
  for (let i = 0; i < valid.length; i++) {
    if (valid[i] && !covered[i]) grid[i] = luminance(cr[i], cg[i], cb[i]);
  }
  const previous = options.previous && options.previous.length === grid.length ? options.previous : null;
  let motion = 0;
  if (previous) {
    let both = 0;
    let moved = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < 0 || previous[i] < 0) continue;
      both++;
      if (Math.abs(grid[i] - previous[i]) >= PERSON_MOTION_DELTA) moved++;
    }
    motion = both >= 16 ? moved / both : 0;
  }
  const bodyMask = new Uint8Array(cols * rows);
  const skinMask = new Uint8Array(cols * rows);
  const skinLoose = new Uint8Array(cols * rows);
  // Median-normalised colour per cell for the static-content reference.
  const cells = new Float32Array(cols * rows * 3 + 1).fill(NaN);
  const norm = Math.max(8, median);
  cells[cols * rows * 3] = median;
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i] || covered[i]) continue;
    cells[i * 3] = cr[i] / norm; cells[i * 3 + 1] = cg[i] / norm; cells[i * 3 + 2] = cb[i] / norm;
  }
  const useBg = !!(background && background.ready() && (!background.matches || background.matches(cols, rows)));
  // Per-cell darkening against the learned picture. Normalised ratios carry
  // one shared factor (frame median / learned median), so comparing each cell
  // with the bright end of the ratios cancels exposure and lamp steps.
  const ratio = new Float32Array(cols * rows).fill(NaN);
  let ratioRef = 0;
  if (useBg && typeof background.lum === 'function') {
    const all = [];
    for (let i = 0; i < valid.length; i++) {
      if (!valid[i] || covered[i]) continue;
      const b = background.lum(i);
      if (!Number.isFinite(b)) continue;
      const v = luminance(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]) / Math.max(0.05, b);
      ratio[i] = v;
      all.push(v);
    }
    if (all.length >= 16) {
      all.sort((a, b) => a - b);
      ratioRef = all[Math.min(all.length - 1, Math.floor(all.length * 0.9))];
    }
  }
  const darkMask = new Uint8Array(cols * rows);
  const bgLevel = useBg && typeof background.level === 'function' ? +background.level() || 0 : 0;
  const lifted = bgLevel > 0 && median >= bgLevel * PERSON_BG_BRIGHT;
  let staticCells = 0;
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i] || covered[i]) continue;
    if (useBg && !background.changed(cells, i)) { staticCells++; continue; }
    const r = cr[i];
    const g = cg[i];
    const b = cb[i];
    // A person blocks the floor, so the pixel is darker than the empty-floor
    // reference (or the frame median when no blank was captured / after a
    // lighting rebase). Brighter pixels are projected light and are not a body.
    // With a learned picture, a cell much darker than that picture is body too.
    const lum = luminance(r, g, b);
    const gx = i % cols;
    const gy = (i / cols) | 0;
    const sx = Math.min(w - 1, gx * step);
    const sy = Math.min(h - 1, gy * step);
    // The painting reads as a person until the background is learned.
    // After that, warm paint inside the frame still matches isSkinTone.
    // Count it only when the pixel is darker than the floor (a hand or face).
    const inPaint = !!(contentQuad && pointInQuad(contentQuad, sx, sy));
    if (inPaint && !useBg) continue;
    const floorLum = floorRef ? floorRef[sy * w + sx] : median;
    const absCut = PERSON_LUMA_DELTA;
    const relCut = Math.max(18, floorLum * PERSON_LUMA_REL);
    const darkEnough = lum <= floorLum - Math.max(absCut, relCut);
    const darker = ratioRef > 0 && Number.isFinite(ratio[i]) && ratio[i] <= ratioRef * PERSON_DARK_RATIO;
    if (darker) darkMask[i] = 1;
    if (darkEnough && saturation(r, g, b) <= PERSON_BODY_SATURATION) bodyMask[i] = 1;
    const skinTone = isSkinTone(r, g, b) && (!floorRef || lum <= floorRef[sy * w + sx] + 12);
    const skinOk = skinTone && (!inPaint || darkEnough);
    // A globally stale frame lights warm wall pixels as skin. Those only
    // count when they are actually darker than the floor (a person). A
    // settled frame keeps the looser skin test.
    if (skinOk && darkEnough) skinMask[i] = 1;
    else if (skinOk) skinLoose[i] = 1;
  }
  const globalChange = useBg && counted > 0 && staticCells / counted < PERSON_BG_GLOBAL;
  // A quiet stale room must not read warm walls as skin. A person who is
  // moving, or a visit that already started on a settled frame, still does.
  const keepLoose = !globalChange || motion >= PERSON_MOTION_HOLD || options.inVisit === true;
  if (keepLoose) {
    for (let i = 0; i < skinLoose.length; i++) if (skinLoose[i]) skinMask[i] = 1;
  }
  const dark = largestComponent(darkMask, cols, rows, valid);
  const darkShade = dark.area >= 8 ? shadingCorrelation(darkMask, cols, rows, dark.start, cells, background) : 0;
  // A dark patch that keeps the painting's texture is light dimming it (a
  // flash recovering, a dark cue, the align grid), not a body in front of it.
  const shaded = darkShade >= PERSON_SHADE_CORR;
  if (!shaded) for (let i = 0; i < darkMask.length; i++) if (darkMask[i]) bodyMask[i] = 1;
  const body = largestComponent(bodyMask, cols, rows);
  // The same test on the darker-than-floor body: a dimmed stretch of the
  // painting keeps its texture, a person replaces it.
  if (useBg && body.area >= 8 && shadingCorrelation(bodyMask, cols, rows, body.start, cells, background) >= PERSON_SHADE_CORR) body.area = 0;
  const skin = largestComponent(skinMask, cols, rows);
  const boxPx = (box) => (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) * step * step;
  if (body.area && boxPx(body) < PERSON_MIN_BOX) body.area = 0;
  if (skin.area && boxPx(skin) < PERSON_MIN_BOX) skin.area = 0;
  const bodyFraction = body.area / counted;
  const skinFraction = skin.area / counted;
  const aspect = body.area ? (body.maxY - body.minY + 1) / Math.max(1, body.maxX - body.minX + 1) : 0;
  const underCap = (fraction) => fraction < cuts.maxFraction;
  const bodyPresent = body.area > 0 && underCap(bodyFraction) && bodyFraction >= cuts.fraction && aspect >= cuts.aspect;
  const bodyHold = body.area > 0 && underCap(bodyFraction) && bodyFraction >= cuts.holdFraction && aspect >= cuts.holdAspect;
  const skinPresent = skin.area > 0 && underCap(skinFraction) && skinFraction >= cuts.skin;
  const skinHold = skin.area > 0 && underCap(skinFraction) && skinFraction >= cuts.holdSkin;
  // A full-width band (stage edge, shadow line) is not a body.
  const bodyW = body.area ? (body.maxX - body.minX + 1) / Math.max(1, cols) : 1;
  const bodyH = body.area ? (body.maxY - body.minY + 1) / Math.max(1, rows) : 0;
  const bodyShaped = bodyW <= 0.9 && bodyH >= 0.2;
  // Large connected occluder (person clipped by the stage edge often reads
  // wider than tall — Nov 9 3:17 PM rig). Ambient wall wash is handled by the
  // luminance rebase above, not by dropping this path (TJ 4:42 PM).
  const large = body.area > 0 && underCap(bodyFraction) && bodyShaped && bodyFraction >= PERSON_LARGE_FRACTION;
  const largeHold = body.area > 0 && underCap(bodyFraction) && bodyShaped && bodyFraction >= PERSON_LARGE_HOLD;
  const fraction = Math.max(bodyFraction, skinFraction);
  // A dark patch against the learned picture that runs off the picture edge
  // is someone leaning in (a head and shoulders close to the camera).
  const darkFraction = dark.area / counted;
  const darkW = dark.area ? (dark.maxX - dark.minX + 1) / Math.max(1, cols) : 1;
  const darkH = dark.area ? (dark.maxY - dark.minY + 1) / Math.max(1, rows) : 0;
  const darkShaped = useBg && dark.area > 0 && !shaded && underCap(darkFraction) && darkW <= 0.9 && darkH >= 0.2;
  const edgeOccluder = darkShaped && dark.edge && darkFraction >= PERSON_EDGE_OCCLUDER;
  const darkLarge = darkShaped && darkFraction >= PERSON_LARGE_FRACTION;
  const darkHold = darkShaped && darkFraction >= (dark.edge ? PERSON_EDGE_OCCLUDER * 0.72 : PERSON_LARGE_HOLD);
  // A flash or white scan frame lifts the whole picture: never a person. In
  // any other global change nearly every cell reads changed, so only a dark
  // body patch or darkened skin is a person; with neither it is a light event.
  // A lifted median is a flash unless an unshaded dark body is in it (a hand
  // in front of a bright projected alert still reads as a hand).
  const brightening = lifted && !(edgeOccluder || darkLarge);
  // Skin here has no size cap: a face filling the view in a light change is
  // still a face (the darkened-skin rule above already drops warm walls).
  const personInChange = edgeOccluder || darkLarge || darkHold || (skin.area > 0 && skinFraction >= cuts.skin);
  const lightEvent = globalChange && (brightening || !personInChange);
  // Frames 1–5, before the background is learned, must not latch the gate.
  // Callers that pass no background keep the previous behaviour.
  const waitingBg = !!background && !useBg;
  const present = !waitingBg && !lightEvent && !brightening && (globalChange ? personInChange : (bodyPresent || skinPresent || large || edgeOccluder));
  return {
    present,
    holding: present || (!waitingBg && !lightEvent && !brightening && (globalChange ? (darkHold || skinHold) : (bodyHold || skinHold || largeHold || darkHold))),
    fraction,
    bodyFraction,
    skinFraction,
    aspect,
    motion,
    grid,
    staticFraction: counted ? staticCells / counted : 0,
    // Most of the frame changed at once: a light event (flash / blank), not a body.
    globalChange,
    lightEvent,
    brightening,
    darkFraction,
    edgeOccluder,
    darkShade,
    levelRatio: bgLevel > 0 ? median / bgLevel : 0,
    background: useBg,
    cells,
    cols,
    rows,
    // The same bars detect() used, so coverage can follow sensitivity.
    cuts
  };
}

function pointOf(marker) {
  if (!marker || !Number.isFinite(+marker.x) || !Number.isFinite(+marker.y)) return null;
  return {x: +marker.x, y: +marker.y, kind: 'sticker'};
}

// Share of the frame that is a person. Zero until the background is learned.
// Changed cells count only with a person-like signal (skin, body, or coverage).
// A stale painting or a few cells left after a visit do not. Motion alone does not.
export function coverageFromRead(read) {
  if (!read || !read.background) return 0;
  const skin = +read.skinFraction || 0;
  const body = +read.bodyFraction || 0;
  const fraction = +read.fraction || 0;
  const changed = Number.isFinite(+read.staticFraction) ? Math.max(0, 1 - +read.staticFraction) : 0;
  // personInFrame pauses at the sensitivity-scaled skin bar (0.033 at the
  // default 0.35). Coverage used the raw 0.04, so a paused visitor with
  // skin 0.034 reported coverage 0 and the visit never opened.
  const cuts = read.cuts || personCuts(read.sensitivity);
  const skinCut = Number.isFinite(+cuts.skin) ? +cuts.skin : PERSON_SKIN_FRACTION;
  const bodyCut = Number.isFinite(+cuts.holdFraction) ? Math.min(PERSON_LARGE_HOLD, +cuts.holdFraction) : PERSON_LARGE_HOLD;
  const personLike = skin >= skinCut || body >= bodyCut || fraction >= skinCut || body >= PERSON_LARGE_HOLD;
  // A flash, white frame, or lamp step changes most of the picture. Coverage
  // stays 0 so a visit cannot open on the scan itself.
  if (read.lightEvent || read.brightening) return 0;
  if (!personLike) return 0;
  // In a global change nearly every cell reads changed; count the body only.
  if (read.globalChange) return Math.max(skin, body, fraction, +read.darkFraction || 0);
  return Math.max(fraction, changed, skin, body);
}

export function stickersThatStayed(before, after, radius = PERSON_STAY_RADIUS) {
  const prior = [];
  for (const marker of before || []) {
    const spot = pointOf(marker);
    if (spot) prior.push(spot);
  }
  const next = [];
  for (const marker of after || []) {
    const spot = pointOf(marker);
    if (spot) next.push(spot);
  }
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : PERSON_STAY_RADIUS;
  const used = new Set();
  const stayed = [];
  for (const spot of prior) {
    let best = -1;
    let bestD = limit;
    for (let i = 0; i < next.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(next[i].x - spot.x, next[i].y - spot.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      used.add(best);
      stayed.push({x: next[best].x, y: next[best].y, kind: 'sticker'});
    }
  }
  return stayed;
}

export function stickerStagePoints(blobs, project) {
  const out = [];
  if (typeof project !== 'function') return out;
  for (const blob of blobs || []) {
    if (!blob || blob.kind !== 'sticker') continue;
    const at = project(blob);
    const spot = pointOf(at);
    if (spot) out.push(spot);
  }
  return out;
}

export function gateStickerBlobs(blobs, decision, project, radius = PERSON_STAY_RADIUS) {
  const list = blobs || [];
  if (!decision || (!decision.paused && !decision.rescan)) return list.slice();
  if (decision.paused) return list.filter(blob => !blob || blob.kind !== 'sticker');
  const stayed = decision.latch || [];
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : PERSON_STAY_RADIUS;
  return list.filter(blob => {
    if (!blob || blob.kind !== 'sticker') return true;
    if (typeof project !== 'function') return false;
    const at = pointOf(project(blob));
    if (!at) return false;
    return stayed.some(spot => Math.hypot(spot.x - at.x, spot.y - at.y) <= limit);
  });
}

export function occlusionTelemetry(decision) {
  const raw = decision && typeof decision.note === 'string' ? decision.note : '';
  const note = raw === PERSON_PAUSE_NOTE || raw === PERSON_RESUME_NOTE ? raw : (raw ? PERSON_PAUSE_NOTE : null);
  return {
    paused: !!(decision && decision.paused),
    settling: !!(decision && decision.settling),
    note,
    phase: decision && typeof decision.phase === 'string' ? decision.phase : 'clear',
    clearRun: decision && Number.isFinite(+decision.clearRun) ? decision.clearRun | 0 : 0,
    clearMs: decision && Number.isFinite(+decision.clearMs) ? Math.round(+decision.clearMs) : 0,
    held: decision && typeof decision.held === 'string' ? decision.held : ''
  };
}

// Dim /live/ corner chip while person pause is off (TJ 3:06 PM).
export function syncPersonPauseChip(doc, enabled) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  const chip = doc.querySelector('[data-person-pause-off]');
  if (!chip) return false;
  chip.hidden = enabled !== false;
  if (enabled === false) chip.textContent = PERSON_PAUSE_OFF_NOTE;
  return true;
}

export function syncPersonNote(doc, show) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  const note = doc.querySelector('[data-person-note]');
  if (!note) return false;
  const text = typeof show === 'string' ? show : (show ? PERSON_PAUSE_NOTE : '');
  note.hidden = !text;
  if (text) note.textContent = text;
  return true;
}

function clonePoints(list) {
  return (list || []).map(spot => ({x: spot.x, y: spot.y, kind: 'sticker'}));
}

// paused: sticker detection must not latch. settling: the person has left and
// the clear wait is still running (still paused — no latching). flashRescan:
// this call is the moment to run Scan stickers once the floor is clear.
export function createPersonOcclusion({
  clearMs = PERSON_CLEAR_MS,
  matchRadius = PERSON_STAY_RADIUS,
  enterFrames = PERSON_ENTER_FRAMES,
  exitFrames = PERSON_EXIT_FRAMES
} = {}) {
  const wait = Number.isFinite(+clearMs) && +clearMs >= 0 ? +clearMs : PERSON_CLEAR_MS;
  const radius = Number.isFinite(+matchRadius) && +matchRadius > 0 ? +matchRadius : PERSON_STAY_RADIUS;
  const enter = Number.isFinite(+enterFrames) && +enterFrames >= 1 ? (+enterFrames | 0) : PERSON_ENTER_FRAMES;
  const exit = Number.isFinite(+exitFrames) && +exitFrames >= 1 ? (+exitFrames | 0) : PERSON_EXIT_FRAMES;
  let phase = 'clear';
  let clearSince = null;
  let frozen = [];
  let lastStickers = [];
  let presentRun = 0;
  let absentRun = 0;

  function signal(person) {
    if (person === true) return {present: true, holding: true};
    if (!person || person === false) return {present: false, holding: false};
    const present = person.present === true;
    return {present, holding: person.holding === true || present};
  }

  let lastPersonAt = -Infinity;
  let prevHold = false;
  let dipUsed = false;
  let bridgeUsed = false;
  const motionHold = PERSON_MOTION_HOLD;
  return {
    // person: personInFrame result (present/holding/motion) or a boolean.
    // A clear (rescan) needs `exit` consecutive frames with no person AND no
    // floor motion, then `wait` ms more of the same. Any person frame (or
    // motion within PERSON_MOTION_MAX_MS of one) restarts the whole count.
    observe({person = false, stickers = [], now = 0} = {}) {
      const sig = signal(person);
      const t = Number.isFinite(+now) ? +now : 0;
      const motion = person && typeof person === 'object' && Number.isFinite(+person.motion) ? +person.motion : 0;
      const personHit = phase === 'clear' ? sig.present : sig.holding;
      if (personHit) lastPersonAt = t;
      if (sig.present) bridgeUsed = false;
      // Placement can miss the skin bar for one frame before the pause
      // latches (phase still clear). That frame keeps the enter streak.
      // Motion with no person yet does not start a pause.
      const bridge = phase === 'clear' && !sig.present && presentRun > 0 && !bridgeUsed && motion >= motionHold;
      if (bridge) {
        bridgeUsed = true;
        return {paused: false, settling: false, phase, note: null, latch: null, rescan: false, flashRescan: false, held: 'motion'};
      }
      const moving = phase !== 'clear' && motion >= motionHold && t - lastPersonAt <= PERSON_MOTION_MAX_MS;
      // A hand over the painting can miss skin for one frame while it is
      // still moving. That dip does not open the exit count. A second quiet
      // frame does, and motion cannot hold past PERSON_MOTION_MAX_MS.
      const dip = phase !== 'clear' && !personHit && !moving && prevHold && !dipUsed && motion > 0 && t - lastPersonAt <= PERSON_MOTION_MAX_MS;
      const blocked = personHit || moving || dip;
      if (personHit || moving) dipUsed = false;
      else if (dip) dipUsed = true;
      prevHold = blocked;
      const held = personHit ? 'person' : (moving || dip) ? 'motion' : '';
      const points = [];
      for (const marker of stickers || []) {
        const spot = pointOf(marker);
        if (spot) points.push(spot);
      }
      if (blocked) {
        absentRun = 0;
        clearSince = null;
        presentRun++;
        if (phase === 'clear' && presentRun < enter) {
          return {paused: false, settling: false, phase, note: null, latch: null, rescan: false, flashRescan: false, held};
        }
        if (phase === 'clear') frozen = clonePoints(lastStickers);
        phase = 'paused';
        // Motion holds used to clear the note while paused stayed true, so the
        // banner flickered off every second a person was still in frame.
        return {paused: true, settling: false, phase, note: PERSON_PAUSE_NOTE, latch: null, rescan: false, flashRescan: false, held};
      }
      presentRun = 0;
      if (phase === 'paused' || phase === 'settling') {
        absentRun++;
        if (absentRun < exit) {
          phase = 'paused';
          return {paused: true, settling: false, phase, note: PERSON_PAUSE_NOTE, latch: null, rescan: false, flashRescan: false, clearRun: absentRun};
        }
        if (clearSince == null || t < clearSince) clearSince = t;
        if (t - clearSince < wait) {
          phase = 'settling';
          return {paused: true, settling: true, phase, note: PERSON_RESUME_NOTE, latch: null, rescan: false, flashRescan: false, clearRun: absentRun, clearMs: t - clearSince};
        }
        // TJ 4:20 PM: after a person leaves, run Scan stickers once the floor
        // has been clear for PERSON_CLEAR_MS. Do not keep the pre-person latch
        // set — a moved sticker must be re-found at its new spot.
        phase = 'clear';
        const clearMs = t - clearSince;
        clearSince = null;
        frozen = [];
        absentRun = 0;
        lastStickers = clonePoints(points);
        return {paused: false, settling: false, phase, note: null, latch: [], rescan: true, flashRescan: true, clearRun: exit, clearMs};
      }
      lastStickers = clonePoints(points);
      return emptyOcclusion();
    },
    // The scan's own white frame showed someone: back to paused, so a fresh
    // clear (frames + settle) is needed before the next rescan.
    rearm(now = 0) {
      phase = 'paused';
      clearSince = null;
      absentRun = 0;
      presentRun = enter;
      lastPersonAt = Number.isFinite(+now) ? +now : 0;
      prevHold = true;
      dipUsed = false;
      return {paused: true, settling: false, phase, note: PERSON_PAUSE_NOTE, latch: null, rescan: false, flashRescan: false, held: 'scan'};
    },
    reset() {
      phase = 'clear';
      clearSince = null;
      frozen = [];
      lastStickers = [];
      presentRun = 0;
      absentRun = 0;
      lastPersonAt = -Infinity;
      prevHold = false;
      dipUsed = false;
      bridgeUsed = false;
    }
  };
}
