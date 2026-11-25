// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Projector → camera latency code.
// A row of high-contrast blocks carries a frame number the camera can read.
// Large digits beside it are for a person looking at the debug camera.
// The phone keeps the time it showed each frame and subtracts that from the
// time the camera decoded it.

export const LATENCY_SYNC = [0, 1, 0, 1];
export const LATENCY_DATA_BITS = 12;
export const LATENCY_PARITY_BITS = 4;

export function packLatency(frame) {
  const data = (frame | 0) & 0xfff;
  let parity = 0;
  for (let i = 0; i < LATENCY_DATA_BITS; i++) parity ^= ((data >> i) & 1) << (i % LATENCY_PARITY_BITS);
  parity = (parity ^ 0x5) & 0xf;
  return data | (parity << LATENCY_DATA_BITS);
}

export function unpackLatency(word) {
  const data = word & 0xfff;
  const parity = (word >> LATENCY_DATA_BITS) & 0xf;
  let expect = 0;
  for (let i = 0; i < LATENCY_DATA_BITS; i++) expect ^= ((data >> i) & 1) << (i % LATENCY_PARITY_BITS);
  expect = (expect ^ 0x5) & 0xf;
  if (parity !== expect) return null;
  return data;
}

export function latencyBits(frame) {
  const word = packLatency(frame);
  const bits = LATENCY_SYNC.slice();
  for (let i = 0; i < LATENCY_DATA_BITS + LATENCY_PARITY_BITS; i++) bits.push((word >> i) & 1);
  return bits;
}

// Stage pixels, 1000×620, matching the room canvas homography.
export function latencyStageLayout() {
  return latencyLayout(1000, 620);
}

export function latencyLayout(width, height) {
  const bits = LATENCY_SYNC.length + LATENCY_DATA_BITS + LATENCY_PARITY_BITS;
  // Two rows of 10 fat cells. A single 20-wide strip shrinks to ~12px on the
  // phone camera and AE washes the sync gap to single digits.
  const cols = 10;
  const rows = Math.ceil(bits / cols);
  const pitch = width * 0.90 / cols;
  const size = pitch * 0.82;
  const x0 = width * 0.05 + pitch / 2;
  // Sit in the lower canvas so Safari chrome above the stage does not own the strip.
  const y0 = height * 0.40;
  const rowPitch = Math.max(size * 1.15, height * 0.14);
  const centers = [];
  for (let i = 0; i < bits; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    centers.push({x: x0 + col * pitch, y: y0 + row * rowPitch, size});
  }
  return centers;
}

function fillCell(rgba, width, height, cell, on) {
  const half = cell.size / 2;
  const x0 = Math.max(0, Math.round(cell.x - half));
  const y0 = Math.max(0, Math.round(cell.y - half));
  const x1 = Math.min(width, Math.round(cell.x + half));
  const y1 = Math.min(height, Math.round(cell.y + half));
  const value = on ? 255 : 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = value;
      rgba[p + 3] = 255;
    }
  }
}

export function renderLatencyFrame(width, height, frame) {
  const w = width | 0;
  const h = height | 0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const bits = latencyBits(frame);
  const centers = latencyLayout(w, h);
  for (let i = 0; i < centers.length; i++) fillCell(rgba, w, h, centers[i], bits[i] === 1);
  return {rgba, width: w, height: h};
}

function cellLuma(rgba, width, height, cell) {
  // Average the middle of the cell. A single center pixel dies under blur,
  // compression, and a half-cell homography miss.
  const half = Math.max(1, Math.round((+cell.size || 8) * 0.28));
  const cx = Math.round(+cell.x);
  const cy = Math.round(+cell.y);
  let sum = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= width) continue;
      const p = (y * width + x) * 4;
      sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      n++;
    }
  }
  if (!n) return 0;
  return sum / n;
}

export function sampleCellLuma(rgba, width, height, x, y, radius = 2) {
  const half = Math.max(1, Math.round(+radius || 2));
  const cx = Math.round(+x);
  const cy = Math.round(+y);
  let sum = 0;
  let n = 0;
  for (let yy = cy - half; yy <= cy + half; yy++) {
    if (yy < 0 || yy >= height) continue;
    for (let xx = cx - half; xx <= cx + half; xx++) {
      if (xx < 0 || xx >= width) continue;
      const p = (yy * width + xx) * 4;
      sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function decodeCellLumas(lumas) {
  const need = LATENCY_SYNC.length + LATENCY_DATA_BITS + LATENCY_PARITY_BITS;
  if (!lumas || lumas.length < need) return null;
  const sync = lumas.slice(0, LATENCY_SYNC.length);
  const dark = (sync[0] + sync[2]) / 2;
  const bright = (sync[1] + sync[3]) / 2;
  // Soft thresholds: projector AE, JPEG, and a slightly wrong quad crush
  // the old 40-luma sync gap down to single digits on a phone camera.
  if (!(bright >= dark + 14)) return null;
  if (sync[0] > dark + 22 || sync[2] > dark + 22) return null;
  if (sync[1] < bright - 22 || sync[3] < bright - 22) return null;
  if (bright - dark < 18 && Math.abs((sync[0] + sync[2]) - (sync[1] + sync[3])) < 20) return null;
  const mid = (dark + bright) / 2;
  let word = 0;
  for (let i = 0; i < LATENCY_DATA_BITS + LATENCY_PARITY_BITS; i++) {
    if (lumas[LATENCY_SYNC.length + i] >= mid) word |= 1 << i;
  }
  const frame = unpackLatency(word);
  if (frame == null) return null;
  return {frame, dark, bright};
}

export function decodeLatencyFrame(rgba, width, height) {
  const base = latencyLayout(width, height);
  const hit = decodeCellLumas(base.map(cell => cellLuma(rgba, width, height, cell)));
  if (hit) return hit;
  // Phone quads often include Safari chrome above the canvas. Nudge the strip
  // down (and a little up) until the 0-1-0-1 sync pops.
  const span = Math.max(8, height * 0.12);
  for (const dy of [span * 0.35, span * 0.7, span, -span * 0.25, span * 1.3, -span * 0.5]) {
    const shifted = base.map(cell => ({...cell, y: cell.y + dy}));
    const again = decodeCellLumas(shifted.map(cell => cellLuma(rgba, width, height, cell)));
    if (again) return again;
  }
  return decodeLatencyInFrame(rgba, width, height);
}

export function shiftLatencyLayout(dy) {
  return latencyStageLayout().map(cell => ({...cell, y: cell.y + dy}));
}

export function decodeLatencySamples(lumas) {
  return decodeCellLumas(lumas);
}

// When the align quad includes phone Safari chrome, stage Y no longer matches
// the canvas. Search the camera frame for a 0-1-0-1 strip and decode there.
export function decodeLatencyInFrame(rgba, width, height) {
  const w = width | 0;
  const h = height | 0;
  if (!rgba || w < 40 || h < 40) return null;
  let best = null;
  // Slide a scaled copy of the 2×10 stage layout across the lower/mid frame.
  for (const top of [0.18, 0.24, 0.30, 0.36, 0.42, 0.48]) {
    for (const left of [0.06, 0.10, 0.14, 0.18]) {
      for (const scaleW of [0.88, 0.78, 0.68]) {
        const boxW = w * scaleW;
        const boxH = h * 0.36;
        const x0 = w * left;
        const y0 = h * top;
        if (x0 + boxW > w - 2 || y0 + boxH > h - 2) continue;
        const cells = latencyLayout(boxW, boxH).map(cell => ({
          x: x0 + cell.x,
          y: y0 + cell.y,
          size: cell.size
        }));
        const lumas = cells.map(cell => cellLuma(rgba, w, h, cell));
        const sync = lumas.slice(0, 4);
        const dark = (sync[0] + sync[2]) / 2;
        const bright = (sync[1] + sync[3]) / 2;
        const gap = bright - dark;
        if (!(gap >= 18)) continue;
        if (!(sync[0] < sync[1] && sync[2] < sync[3])) continue;
        const decoded = decodeCellLumas(lumas);
        if (!decoded) continue;
        if (!best || gap > best.gap) best = {...decoded, gap};
      }
    }
  }
  return best ? {frame: best.frame, dark: best.dark, bright: best.bright} : null;
}


const DIGITS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ' ': ['000', '000', '000', '000', '000']
};

function stampDigits(ctx, text, x, y, scale) {
  for (let i = 0; i < text.length; i++) {
    const rows = DIGITS[text[i]] || DIGITS[' '];
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '1') continue;
        ctx.fillRect(x + (i * 4 + col) * scale, y + row * scale, scale, scale);
      }
    }
  }
}

export function paintLatencyOverlay(ctx, width, height, sample = {}) {
  if (!ctx || !(width > 0) || !(height > 0)) return;
  const frame = sample.frame | 0;
  const ms = Math.max(0, Math.round(+sample.ms || 0));
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const bits = latencyBits(frame & 0xfff);
  const stage = latencyStageLayout();
  const sx = width / 1000;
  const sy = height / 620;
  for (let i = 0; i < stage.length; i++) {
    const cell = stage[i];
    const size = cell.size * sx;
    const x = cell.x * sx - size / 2;
    const y = cell.y * sy - size / 2;
    ctx.fillStyle = bits[i] ? '#ffffff' : '#000000';
    ctx.fillRect(x, y, size, size);
    // Thin outline only on lit cells so dark bits stay truly dark after blur.
    if (bits[i]) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.strokeRect(x, y, size, size);
    }
  }
  ctx.fillStyle = '#ffffff';
  const scale = Math.max(3, Math.round(Math.min(width, height) / 48));
  const label = String(frame & 0xfff).padStart(4, '0') + '  ' + String(ms % 1000000).padStart(6, '0');
  stampDigits(ctx, label, width * 0.08, height * 0.72, scale);
  ctx.restore();
}

export function createLatencyTracker() {
  const shown = new Map();
  const lags = [];
  let order = [];
  return {
    shown(frame, at) {
      const id = frame & 0xfff;
      const t = +at;
      if (!Number.isFinite(t)) return;
      shown.set(id, t);
      order.push(id);
      if (order.length > 900) {
        const drop = order.splice(0, order.length - 700);
        for (const key of drop) {
          if (order.includes(key)) continue;
          shown.delete(key);
        }
      }
    },
    observe(cameraAt, frame) {
      const at = shown.get(frame & 0xfff);
      const now = +cameraAt;
      if (at == null || !Number.isFinite(now)) return null;
      const lag = now - at;
      if (!(lag >= 0) || lag > 2000) return null;
      lags.push(lag);
      if (lags.length > 24) lags.shift();
      return this.stats();
    },
    stats() {
      if (!lags.length) return {lagMs: null, jitterMs: null, samples: 0};
      const mean = lags.reduce((sum, value) => sum + value, 0) / lags.length;
      const variance = lags.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lags.length;
      return {lagMs: mean, jitterMs: Math.sqrt(variance), samples: lags.length};
    },
    reset() {
      shown.clear();
      lags.length = 0;
      order = [];
    }
  };
}
