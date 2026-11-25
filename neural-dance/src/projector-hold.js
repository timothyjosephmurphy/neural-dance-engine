// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// While Align is running, the projector shows only the align flash or the
// alignment pattern. Blank scans, the latency test, and the dancer sim do
// not get a frame until align finishes or is cancelled.
// Scan stickers also sets a white flash without entering Align; that flash
// has to win too, or the canvas keeps drawing dancers under the overlay and
// the camera never sees a blank white floor (TJ, Nov 9: button seemed dead).

export function projectorFrame({aligning = false, flash = '', pattern = false, scan = '', latency = false} = {}) {
  // Explicit black/white flash wins whether Align owns the projector or
  // Scan stickers asked for a one-shot white floor.
  if (flash === 'black' || flash === 'white') return flash;
  if (aligning) return 'pattern';
  if (latency) return 'latency';
  if (scan === 'black' || scan === 'white') return 'scan';
  if (pattern) return 'pattern';
  return 'simulation';
}

// Locked stage floor. The CSS --background token is #080910; never use a
// resolved CSS color that could be a leftover viz / calibration fill.
export const STAGE_BACKGROUND = '#080910';

function parseCssColor(c) {
  if (c == null) return null;
  const s = String(c).trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'none' || s === 'currentcolor') return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const n = m[1];
    return [parseInt(n[0] + n[0], 16), parseInt(n[1] + n[1], 16), parseInt(n[2] + n[2], 16)];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

// True only for the dark simulation floor (not Align black, not a flash).
export function isSafeStageBackground(color) {
  const rgb = parseCssColor(color);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r <= 24 && g <= 24 && b <= 32 && (r + g + b) <= 60 && (r + g + b) >= 16;
}

// Calibration flashes, corner blocks, and kick/salmon viz colors (~#FF9A85).
export function isForbiddenStageFill(color) {
  const rgb = parseCssColor(color);
  if (!rgb) return false;
  if (isSafeStageBackground(color)) return false;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max <= 10 && min <= 10) return true; // solid black cover
  if ((r + g + b) / 3 >= 150) return true; // white / gray flash
  if (max >= 140 && (max - min) >= 30) return true; // vivid (cal / viz / salmon)
  return false;
}

export function stageFillStyle(candidate) {
  return isSafeStageBackground(candidate) ? candidate : STAGE_BACKGROUND;
}

// A near-solid calibration / salmon / white field (low variance, most samples
// vivid) — the iPhone projector wash that a stage-canvas-only soak can miss
// when it lives on the ripple overlay (mix-blend-mode: screen).
export function isUniformForbiddenWash(image, coverage = 0.7) {
  if (!image || !image.data || !(image.width > 0) || !(image.height > 0)) return false;
  const data = image.data;
  const w = image.width | 0;
  const h = image.height | 0;
  const jumpX = Math.max(1, Math.floor(w / 20));
  const jumpY = Math.max(1, Math.floor(h / 12));
  let n = 0, vivid = 0, rS = 0, gS = 0, bS = 0;
  for (let y = 0; y < h; y += jumpY) {
    for (let x = 0; x < w; x += jumpX) {
      const i = (y * w + x) * 4;
      n++;
      const a = data[i + 3];
      if (a < 80) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = (r + g + b) / 3;
      const forbidden = (max <= 10 && min <= 10 && a >= 200)
        || lum >= 150
        || (max >= 140 && (max - min) >= 30);
      if (!forbidden) continue;
      vivid++;
      rS += r; gS += g; bS += b;
    }
  }
  if (!(n > 8) || vivid < n * coverage) return false;
  const r = rS / vivid, g = gS / vivid, b = bS / vivid;
  return isForbiddenStageFill('rgb(' + r + ', ' + g + ', ' + b + ')');
}
