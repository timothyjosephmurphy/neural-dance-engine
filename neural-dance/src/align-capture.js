// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Align capture: hold each projected pattern until the phone camera has
// actually seen it (TJ, Nov 10: "display the alignment pattern on the screen
// for longer to make sure it's captured").
//
// Before this, each pattern was on the wall for ~0.3–0.5 s and Align read 1–3
// frames. iPhone auto-exposure and focus take ~0.5–1.5 s to settle after the
// wall jumps from black to white to the colored pattern, so Align often read
// a blown-out, dark, blurred, or half-switched frame and moved on.
//
// Now each pattern stays up until:
//   1. exposure has stopped moving (frame brightness steady frame to frame),
//   2. N consecutive frames agree on the same result (same quad), and
//   3. a minimum dwell has passed,
// or a maximum dwell runs out. The agreeing frames are averaged (pixels for
// the black/white references, corners for the quads) for sub-pixel corners.

export const ALIGN_SAMPLE_MS = 66; // ~15 reads/s on a 30 fps camera
export const ALIGN_EXPOSURE_TOL = 0.05; // relative brightness change that still counts as settled
export const ALIGN_AGREE_TOL = 0.012; // corner agreement between reads (fraction of the frame, ~6 px at 480)
export const ALIGN_HOLD = {
  black: {minMs: 900, maxMs: 2600, agree: 3},
  white: {minMs: 1200, maxMs: 3200, agree: 3},
  // Markers do not wait for exposure to stop moving: the colored squares read
  // best while auto-exposure is still low after the white flash, and a blown,
  // fully adapted frame merges teal into the grid. Agreement is the gate.
  marker: {minMs: 700, maxMs: 3600, agree: 3, tries: 2, exposure: false}
};
// Black between marker retries so auto-exposure re-locks on the pattern.
export const ALIGN_RETRY_BLANK_MS = 450;
// Worst case before refine: black + white + two marker tries + one blank.
export const ALIGN_HOLD_TOTAL_MS = ALIGN_HOLD.black.maxMs + ALIGN_HOLD.white.maxMs +
  ALIGN_HOLD.marker.maxMs * ALIGN_HOLD.marker.tries + ALIGN_RETRY_BLANK_MS;

// Mean luminance on a sparse grid (~2k samples). Cheap enough per frame.
export function frameLuma(frame) {
  if (!frame || !frame.data || !(frame.width > 0) || !(frame.height > 0)) return null;
  const data = frame.data;
  const pixels = frame.width * frame.height;
  const stride = Math.max(1, Math.floor(pixels / 2048));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pixels; i += stride) {
    const p = i * 4;
    sum += data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    n++;
  }
  return n ? sum / n : null;
}

export function exposureSteady(prev, next, tol = ALIGN_EXPOSURE_TOL) {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  return Math.abs(next - prev) <= Math.max(1.5, tol * Math.max(prev, next, 16));
}

// Pixel mean of same-size frames (noise / sub-pixel). Metadata from the last.
export function averageFrames(frames) {
  const list = (frames || []).filter(f => f && f.data);
  if (!list.length) return null;
  const last = list[list.length - 1];
  const same = list.filter(f => f.width === last.width && f.height === last.height && f.data.length === last.data.length);
  if (same.length === 1) return last;
  const len = last.data.length;
  const sum = new Float32Array(len);
  for (const f of same) {
    const d = f.data;
    for (let i = 0; i < len; i++) sum[i] += d[i];
  }
  const out = new Uint8ClampedArray(len);
  const k = 1 / same.length;
  for (let i = 0; i < len; i++) out[i] = Math.round(sum[i] * k);
  return {...last, data: out, averaged: same.length};
}

export function averageQuads(quads) {
  const list = (quads || []).filter(q => Array.isArray(q) && q.length === 4);
  if (!list.length) return null;
  const out = [];
  for (let i = 0; i < 4; i++) {
    let x = 0;
    let y = 0;
    for (const q of list) {
      x += +q[i].x;
      y += +q[i].y;
    }
    out.push({x: x / list.length, y: y / list.length});
  }
  return out;
}

// Largest corner spread (fraction of frame) across agreeing reads. Lower is
// steadier; reported as the capture's confidence.
export function quadSpread(quads) {
  const mean = averageQuads(quads);
  if (!mean) return null;
  let worst = 0;
  for (const q of quads) {
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(q[i].x - mean[i].x, q[i].y - mean[i].y));
  }
  return worst;
}

function cornersAgree(a, b, tol) {
  if (!a || !b) return !a && !b;
  if (a.length !== 4 || b.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > tol) return false;
  }
  return true;
}

// The read with the most agreeing reads; ties go to the earliest (lower
// auto-exposure gain, cleaner colors). Returns that cluster, oldest first.
export function largestCluster(pool, tol = ALIGN_AGREE_TOL) {
  let best = [];
  for (const item of pool) {
    const near = pool.filter(other => cornersAgree(other.result.corners, item.result.corners, tol));
    if (near.length > best.length) best = near;
  }
  return best;
}

// Hold one pattern and read frames until they agree.
//   grab()          -> camera frame or null
//   measure(frame)  -> {ok, corners?} (corners in any fixed unit; compared with agreeTol)
//   wait(ms)        -> promise
//   now()           -> ms clock
//   alive()         -> false stops (cancel)
//   scale           -> 0 in unit tests: no dwell, a handful of frames
// Resolves {ok, frames, results, corners, frame, elapsedMs, reads, settled, spread, reason}.
export async function holdForCapture({grab, measure = () => ({ok: true}), wait, now, alive = () => true,
  spec = ALIGN_HOLD.white, scale = 1, sampleMs = ALIGN_SAMPLE_MS, agreeTol = ALIGN_AGREE_TOL,
  exposureTol = ALIGN_EXPOSURE_TOL, onProgress = null} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const pause = typeof wait === 'function' ? wait : (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const need = Math.max(1, spec.agree | 0 || 3);
  const minMs = Math.max(0, (+spec.minMs || 0) * scale);
  const maxMs = Math.max(minMs, (+spec.maxMs || 0) * scale);
  // Real runs end on time; scaled-to-zero runs (tests) end on a frame count.
  const maxReads = scale > 0 ? Math.ceil(maxMs / Math.max(1, sampleMs)) * 3 + need + 8 : need + 4;
  const start = clock();
  let prevLum = null;
  let streak = [];
  let best = [];
  const pool = [];
  let reads = 0;
  let lastFrame = null;
  let lastResult = null;
  let steadyReads = 0;
  let prevLumSeen = false;
  for (let i = 0; i < maxReads; i++) {
    if (!alive()) return {ok: false, stop: true, reason: 'cancelled'};
    const frame = grab();
    const elapsed = clock() - start;
    if (frame && frame.data) {
      reads++;
      lastFrame = frame;
      const lum = frameLuma(frame);
      const steady = prevLum == null ? false : exposureSteady(prevLum, lum, exposureTol);
      prevLum = lum;
      steadyReads = steady ? steadyReads + 1 : 0;
      const gate = spec.exposure === false ? prevLumSeen : steady;
      prevLumSeen = true;
      let result = null;
      if (gate) {
        try { result = measure(frame); } catch { result = null; }
        lastResult = result;
      }
      if (gate && result && result.ok && result.corners) {
        // Quads: the first N reads (not necessarily back to back) that agree.
        // A torn or merged-blob frame in between does not reset the count,
        // and it never joins the cluster.
        pool.push({frame, result});
        streak = largestCluster(pool, agreeTol).slice(0, need * 2);
      } else if (gate && result && result.ok) {
        // No quad (black reference): consecutive steady frames.
        streak.push({frame, result});
      } else if (!(result && result.corners !== undefined)) {
        streak = [];
      }
      if (streak.length > best.length) best = streak.slice();
      if (streak.length > need && !(streak[0] && streak[0].result && streak[0].result.corners)) streak = streak.slice(-need);
      if (onProgress) {
        try {
          onProgress({elapsedMs: elapsed, minMs, maxMs, agree: Math.min(streak.length, need), need, reads, settled: steadyReads > 0, result});
        } catch { /* progress is cosmetic */ }
      }
      if (streak.length >= need && elapsed >= minMs) return finish(true, streak, elapsed);
    }
    if (elapsed >= maxMs && (scale > 0 || i + 1 >= need + 4)) break;
    await pause(scale > 0 ? sampleMs : 0);
  }
  const elapsed = clock() - start;
  const out = finish(false, best, elapsed);
  out.lastFrame = lastFrame;
  out.lastResult = lastResult;
  out.reason = !reads ? 'no camera frame' : !best.length ? (steadyReads ? 'nothing detected' : 'exposure never settled') : 'frames did not agree';
  return out;

  function finish(ok, list, elapsedMs) {
    const frames = list.map(s => s.frame);
    const results = list.map(s => s.result);
    const quads = results.map(r => r && r.corners).filter(Boolean);
    return {
      ok,
      frames,
      results,
      frame: averageFrames(frames) || lastFrame,
      corners: quads.length === results.length && quads.length ? averageQuads(quads) : null,
      spread: quads.length ? quadSpread(quads) : null,
      elapsedMs,
      reads,
      settled: steadyReads > 0,
      reason: ''
    };
  }
}

function insideConvex(x, y, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
  }
  return true;
}

function median(list) {
  if (!list.length) return null;
  list.sort((a, b) => a - b);
  return list[list.length >> 1];
}

// Room light vs projector light from ONE white frame: wall outside the lit
// screen over the screen itself. Exposure cancels out, so a long black hold
// (auto-exposure brightens a dark room) does not read as "lit room".
export const ALIGN_AMBIENT_HOT_RATIO = 0.42; // sRGB ratio ≈ room light at ~14% of projector white
export function ambientRatio(frame, corners) {
  if (!frame || !frame.data || !Array.isArray(corners) || corners.length !== 4) return null;
  const w = frame.width;
  const h = frame.height;
  const data = frame.data;
  const inside = [];
  const outside = [];
  const step = Math.max(2, Math.round(Math.sqrt((w * h) / 3000)));
  // Keep clear of the screen edge (blur / keystone fit error).
  const shrink = corners.map(p => ({x: p.x, y: p.y}));
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  const grow = corners.map(p => ({x: cx + (p.x - cx) * 1.12, y: cy + (p.y - cy) * 1.12}));
  for (let i = 0; i < 4; i++) shrink[i] = {x: cx + (corners[i].x - cx) * 0.85, y: cy + (corners[i].y - cy) * 0.85};
  for (let y = step >> 1; y < h; y += step) {
    for (let x = step >> 1; x < w; x += step) {
      const nx = x / w;
      const ny = y / h;
      const p = (y * w + x) * 4;
      const lum = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
      if (insideConvex(nx, ny, shrink)) inside.push(lum);
      else if (!insideConvex(nx, ny, grow)) outside.push(lum);
    }
  }
  if (inside.length < 20 || outside.length < 20) return null;
  const a = median(inside);
  const b = median(outside);
  if (!(a > 8)) return null;
  return b / a;
}
