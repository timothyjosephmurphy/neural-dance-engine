// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Close-up OK-hand → Scan stickers (TJ 5:08–5:18 PM).
// Lightweight on-device: large skin-region occlusion + a ring hole.
// Works for either hand (mirrored) and palm facing in or out — the hole is
// orientation-agnostic. Distant dancers never fill the frame, so they miss
// the area gate. The hand must not latch as stickers; Scan waits until the
// hand clears. Status is for the debug panel only.

export const OK_HAND_HOLD_MS = 900;
export const OK_HAND_CLEAR_MS = 350;
export const OK_HAND_COOLDOWN_MS = 8000;
export const OK_HAND_MIN_SKIN = 0.38;      // share of frame — close-up only
export const OK_HAND_MAX_SKIN = 0.92;
export const OK_HAND_MIN_HOLE = 0.012;     // hole share of frame (OK ring)
export const OK_HAND_MAX_HOLE = 0.22;
export const OK_HAND_HOLE_IN_SKIN = 0.72;  // perimeter pixels that touch skin

function clamp01(n) {
  if (!(n > 0)) return 0;
  if (n > 1) return 1;
  return n;
}

// RGB skin heuristic tolerant of warm stage light and either palm tone.
export function isSkinPixel(r, g, b) {
  if (r < 55 || g < 25 || b < 12) return false;
  if (!(r > g + 6 && r > b + 4)) return false;
  // Reject saturated neon dancer colors.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min > 140 && b > r * 0.85) return false;
  if (g > 200 && r < 120) return false;
  return true;
}

export function buildSkinMask(data, width, height, {step = 2} = {}) {
  const w = width | 0;
  const h = height | 0;
  const s = Math.max(1, step | 0);
  const mw = Math.ceil(w / s);
  const mh = Math.ceil(h / s);
  const mask = new Uint8Array(mw * mh);
  let skin = 0;
  for (let y = 0, my = 0; y < h; y += s, my++) {
    for (let x = 0, mx = 0; x < w; x += s, mx++) {
      const i = (y * w + x) * 4;
      if (isSkinPixel(data[i], data[i + 1], data[i + 2])) {
        mask[my * mw + mx] = 1;
        skin++;
      }
    }
  }
  return {mask, width: mw, height: mh, skin, fraction: skin / Math.max(1, mw * mh), step: s};
}

// Largest 4-connected component bounding box on a binary mask.
export function largestBlob(mask, width, height) {
  const w = width | 0;
  const h = height | 0;
  const seen = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        const cx = i % w;
        const cy = (i / w) | 0;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const nbors = [i - 1, i + 1, i - w, i + w];
        for (const n of nbors) {
          if (n < 0 || n >= w * h) continue;
          const nx = n % w;
          const ny = (n / w) | 0;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (!mask[n] || seen[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (!best || area > best.area) best = {minX, maxX, minY, maxY, area};
    }
  }
  return best;
}

// Find a non-skin hole inside the skin blob — the OK ring. Mirror/rotation
// invariant: we only care that a compact hole sits inside skin.
export function findOkHole(mask, width, height, blob) {
  if (!blob || !(blob.area > 0)) return null;
  const w = width | 0;
  const h = height | 0;
  const pad = 1;
  const x0 = Math.max(0, blob.minX + pad);
  const x1 = Math.min(w - 1, blob.maxX - pad);
  const y0 = Math.max(0, blob.minY + pad);
  const y1 = Math.min(h - 1, blob.maxY - pad);
  if (x1 <= x0 || y1 <= y0) return null;
  const seen = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const start = y * w + x;
      if (mask[start] || seen[start]) continue;
      // Flood non-skin; reject if it touches the blob exterior (open background).
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      let touchesOutside = false;
      let periSkin = 0;
      let periTotal = 0;
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        const cx = i % w;
        const cy = (i / w) | 0;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx <= blob.minX || cx >= blob.maxX || cy <= blob.minY || cy >= blob.maxY) {
          touchesOutside = true;
        }
        const nbors = [i - 1, i + 1, i - w, i + w];
        for (const n of nbors) {
          if (n < 0 || n >= w * h) {
            touchesOutside = true;
            periTotal++;
            continue;
          }
          const nx = n % w;
          const ny = (n / w) | 0;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (mask[n]) {
            // Perimeter against skin.
            periSkin++;
            periTotal++;
            continue;
          }
          if (seen[n]) continue;
          // Stay inside a modest expansion of the blob.
          if (nx < blob.minX - 1 || nx > blob.maxX + 1 || ny < blob.minY - 1 || ny > blob.maxY + 1) {
            touchesOutside = true;
            periTotal++;
            continue;
          }
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (touchesOutside) continue;
      // Only perimeter edges count — interior hole-hole edges must not dilute.
      const skinTouch = periTotal > 0 ? periSkin / periTotal : 0;
      if (skinTouch < OK_HAND_HOLE_IN_SKIN) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / Math.max(1, bh);
      if (aspect < 0.45 || aspect > 2.4) continue; // roughly roundish OK ring
      // Prefer a compact hole: reject long thin cracks.
      const fill = area / Math.max(1, bw * bh);
      if (fill < 0.35) continue;
      if (!best || area > best.area) {
        best = {minX, maxX, minY, maxY, area, skinTouch, aspect, fill};
      }
    }
  }
  return best;
}

export function scoreOkHand(data, width, height) {
  const skin = buildSkinMask(data, width, height, {step: 2});
  const report = {
    ok: false,
    skinFraction: skin.fraction,
    holeFraction: 0,
    reason: 'no-skin'
  };
  if (skin.fraction < OK_HAND_MIN_SKIN) {
    report.reason = 'too-far-or-empty';
    return report;
  }
  if (skin.fraction > OK_HAND_MAX_SKIN) {
    report.reason = 'full-frame-wash';
    return report;
  }
  const blob = largestBlob(skin.mask, skin.width, skin.height);
  if (!blob) {
    report.reason = 'no-blob';
    return report;
  }
  const blobFrac = blob.area / Math.max(1, skin.width * skin.height);
  if (blobFrac < OK_HAND_MIN_SKIN * 0.75) {
    report.reason = 'blob-too-small';
    report.skinFraction = blobFrac;
    return report;
  }
  const hole = findOkHole(skin.mask, skin.width, skin.height, blob);
  if (!hole) {
    report.reason = 'no-ring-hole';
    return report;
  }
  const holeFrac = hole.area / Math.max(1, skin.width * skin.height);
  report.holeFraction = holeFrac;
  if (holeFrac < OK_HAND_MIN_HOLE || holeFrac > OK_HAND_MAX_HOLE) {
    report.reason = 'hole-size';
    return report;
  }
  report.ok = true;
  report.reason = 'ok-hand';
  report.mirrored = true; // detector is mirror-invariant
  return report;
}

// State machine: hold OK → wait clear → fire once → cooldown.
export function createOkHandWatcher({
  holdMs = OK_HAND_HOLD_MS,
  clearMs = OK_HAND_CLEAR_MS,
  cooldownMs = OK_HAND_COOLDOWN_MS,
  now = () => Date.now()
} = {}) {
  let phase = 'idle'; // idle | holding | awaitingClear | cooldown
  let holdStart = 0;
  let clearStart = 0;
  let coolUntil = 0;
  let last = {ok: false, reason: 'idle', skinFraction: 0, holeFraction: 0};
  let fire = false;

  return {
    observe(data, width, height, t = now()) {
      fire = false;
      const score = scoreOkHand(data, width, height);
      last = score;
      if (t < coolUntil) {
        phase = 'cooldown';
        return this.status(t);
      }
      if (phase === 'awaitingClear') {
        // Hand cleared once the OK pose is gone and skin no longer fills the frame.
        const cleared = !score.ok && score.skinFraction < OK_HAND_MIN_SKIN * 0.7;
        if (cleared) {
          if (!clearStart) clearStart = t;
          if (t - clearStart >= clearMs) {
            fire = true;
            phase = 'cooldown';
            coolUntil = t + cooldownMs;
            clearStart = 0;
            holdStart = 0;
          }
        } else {
          clearStart = 0;
        }
        return this.status(t);
      }
      if (score.ok) {
        if (phase !== 'holding') {
          phase = 'holding';
          holdStart = t;
        }
        if (t - holdStart >= holdMs) {
          phase = 'awaitingClear';
          clearStart = 0;
        }
      } else {
        phase = 'idle';
        holdStart = 0;
      }
      return this.status(t);
    },
    status(t = now()) {
      return {
        phase,
        present: !!(last && last.ok) || phase === 'holding' || phase === 'awaitingClear',
        blocking: phase === 'holding' || phase === 'awaitingClear',
        fire,
        score: last,
        holdMs: holdStart ? Math.min(holdMs, Math.max(0, (t || now()) - holdStart)) : 0,
        coolLeft: Math.max(0, coolUntil - (t || now())),
        note: phase === 'holding' ? 'OK hand — hold…'
          : phase === 'awaitingClear' ? 'OK hand — lower hand to Scan'
          : phase === 'cooldown' ? 'OK hand cooldown'
          : null
      };
    },
    consumeFire() {
      const was = fire;
      fire = false;
      return was;
    }
  };
}

// Synthetic fixtures for tests (either hand / palm in or out = hole still works).
export function paintSyntheticOkHand(width, height, {
  mirror = false,
  hole = true,
  fill = 0.55,
  cx = 0.45,
  cy = 0.55
} = {}) {
  const w = width | 0;
  const h = height | 0;
  const data = new Uint8ClampedArray(w * h * 4);
  // Dark stage background
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 20; data[i + 1] = 24; data[i + 2] = 40; data[i + 3] = 255;
  }
  const handCx = mirror ? (1 - cx) : cx;
  // Target ~fill of the frame as skin; ellipse area ≈ π*rx*ry.
  const target = Math.max(0.2, Math.min(0.85, fill)) * w * h;
  const rx = Math.sqrt(target / Math.PI) * 1.05;
  const ry = Math.sqrt(target / Math.PI) * 1.15;
  const holeR = hole ? Math.min(rx, ry) * 0.32 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w - handCx;
      const ny = (y + 0.5) / h - cy;
      const inHand = (nx * nx) / (rx * rx / (w * w)) + (ny * ny) / (ry * ry / (h * h)) <= 1
        || (nx * nx + (ny + 0.12) * (ny + 0.12)) < (0.18 * 0.18); // fingers blob
      // Ellipses in pixel space:
      const ex = (x - handCx * w) / rx;
      const ey = (y - cy * h) / ry;
      const inside = ex * ex + ey * ey <= 1;
      // Three finger stubs on top
      const finger = (y < cy * h - ry * 0.15) && Math.abs(x - handCx * w) < rx * 0.85
        && ((Math.abs((x - handCx * w) / rx) - 0.15) % 0.35) < 0.18
        && y > cy * h - ry * 1.15;
      let on = inside || finger;
      if (holeR > 0) {
        const hx = x - handCx * w;
        const hy = y - cy * h;
        if (hx * hx + hy * hy < holeR * holeR) on = false;
      }
      if (!on) continue;
      const i = (y * w + x) * 4;
      data[i] = 190; data[i + 1] = 130; data[i + 2] = 95; data[i + 3] = 255;
    }
  }
  return data;
}
