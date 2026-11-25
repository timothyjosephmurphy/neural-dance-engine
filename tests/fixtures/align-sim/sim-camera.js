// Simulated iPhone camera watching the projected stage, for Align tests.
// Models what made Align miss on the phone: display/projector latency,
// auto-exposure that takes ~0.4-1 s to re-settle after the wall jumps from
// black to white to the colored pattern, focus hunting (blur) after big
// changes, sensor noise that grows with gain, rolling-shutter tearing while
// the projector switches, and a slightly keystoned screen in a lit room.
// The camera reads the page's real Align state (flash, pattern, refine
// outline, progress pill) — it never peeks at the Align code.

import {paintAlignmentPattern} from '../../../neural-dance/room-lab.js';

export const CAM_W = 480;
export const CAM_H = 360;
const SRC_W = 320;
const SRC_H = 148; // iPhone 13 landscape viewport 844x390

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function solveH(src, dst) {
  // 8x8 linear solve, src -> dst
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const {x, y} = src[i];
    const {x: u, y: v} = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}

function srgbToLin(v) { return Math.pow(v / 255, 2.2); }

function contentFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, SRC_W, SRC_H).data;
  const out = new Float32Array(SRC_W * SRC_H * 3);
  for (let i = 0, j = 0; i < img.length; i += 4, j += 3) {
    out[j] = srgbToLin(img[i]); out[j + 1] = srgbToLin(img[i + 1]); out[j + 2] = srgbToLin(img[i + 2]);
  }
  return out;
}

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = SRC_W; c.height = SRC_H;
  return c;
}

export function trialProfile(seed, harsh = 1) {
  const r = rng(seed * 7919 + 13);
  const wide = r() < 0.55;
  const j = (a) => (r() - 0.5) * 2 * a;
  let quad;
  if (wide) {
    // Like TJ's studio (Nov 10 telemetry): the screen spans the frame width.
    quad = [{x: 0.05 + j(0.03), y: 0.30 + j(0.04)}, {x: 0.95 + j(0.03), y: 0.33 + j(0.04)},
      {x: 0.94 + j(0.03), y: 0.84 + j(0.04)}, {x: 0.06 + j(0.03), y: 0.80 + j(0.04)}];
  } else {
    // Farther camera: a smaller screen, stage aspect 2.16 (iPhone 13 landscape).
    const cx = 0.5 + j(0.08), cy = 0.52 + j(0.06), w = 0.24 + r() * 0.16, h = (2 * w * 480 / (2.16 + j(0.15))) / 360;
    const k = j(0.05);
    quad = [{x: cx - w + k, y: cy - h / 2 + j(0.02)}, {x: cx + w + k, y: cy - h / 2 + j(0.02)},
      {x: cx + w - k, y: cy + h / 2 + j(0.02)}, {x: cx - w - k, y: cy + h / 2 + j(0.02)}];
  }
  return {
    seed,
    quad,
    // Phone -> projector -> wall -> camera -> <video>. Display: HDMI adapter
    // ~80-150 ms, AirPlay 200-400+ ms; projector input lag; iOS camera pipeline ~80-150 ms.
    latencyMs: 160 + r() * 420 * harsh,
    aeDeadMs: 80 + r() * 140 * harsh,
    aeTauMs: 380 + r() * 650 * harsh, // auto-exposure time constant
    afTauMs: 200 + r() * 300 * harsh,
    ambient: 0.02 + r() * 0.16, // room light on the wall (TJ's studio is daylit)
    projector: 0.75 + r() * 0.35,
    noise: 2.5 + r() * 3.5 * harsh,
    baseBlur: r() < 0.5 ? 1 : 0,
    stageLevel: 0.08 + r() * 0.5, // what the stage showed before Align
    readoutMs: 28,
    tearChance: 0.5,
    shakePx: 0.35 * harsh
  };
}

export class SimCamera {
  constructor(profile, doc = document) {
    this.p = profile;
    this.doc = doc;
    this.r = rng(profile.seed * 31 + 7);
    this.t0 = performance.now();
    this.history = [{t: this.t0, key: 'stage'}];
    this.gain = Math.min(8, 0.18 / Math.max(0.02, profile.ambient + profile.projector * profile.stageLevel * 0.6));
    this.blur = profile.baseBlur;
    this.lastMean = null;
    this.lastTick = -1;
    this.frame = null;
    this.meanHist = [];
    this.contents = new Map();
    this.buildGeometry();
    this.poll = setInterval(() => this.sample(), 8);
  }
  stop() { clearInterval(this.poll); }
  stateKey() {
    const d = this.doc;
    const flash = d.querySelector('[data-align-flash]');
    const room = d.getElementById('nd-room-lab');
    const refine = d.querySelector('[data-align-refine]');
    const progress = d.querySelector('[data-align-progress]');
    let key = 'stage';
    if (flash && !flash.hidden && (flash.dataset.mode === 'black' || flash.dataset.mode === 'white')) key = flash.dataset.mode;
    else if (refine && refine.style.display === 'block') key = 'refine#' + (refine.dataset.paint || '0');
    else if ((room && room.dataset.stagePattern === '1') || (d.querySelector('[data-cal-pattern]') && !d.querySelector('[data-cal-pattern]').hidden)) key = 'pattern';
    const pill = progress && !progress.hidden && progress.style.display !== 'none' && getComputedStyle(progress).visibility !== 'hidden';
    return pill ? key + '+pill' : key;
  }
  sample() {
    const key = this.stateKey();
    const last = this.history[this.history.length - 1];
    if (last.key !== key) {
      this.history.push({t: performance.now(), key});
      // Canvas stages are snapshotted when they appear (they are repainted in place).
      if (key.startsWith('refine')) this.content(key);
    }
  }
  keyAt(t) {
    let key = this.history[0].key;
    for (const h of this.history) { if (h.t <= t) key = h.key; else break; }
    return key;
  }
  content(key) {
    if (this.contents.has(key)) return this.contents.get(key);
    const c = makeCanvas();
    const ctx = c.getContext('2d');
    const base = key.replace('+pill', '');
    if (base === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SRC_W, SRC_H); }
    else if (base === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SRC_W, SRC_H); }
    else if (base === 'pattern') paintAlignmentPattern(ctx, SRC_W, SRC_H);
    else if (base.startsWith('refine')) {
      const src = this.doc.querySelector('[data-align-refine]');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SRC_W, SRC_H);
      if (src) ctx.drawImage(src, 0, 0, SRC_W, SRC_H);
    } else {
      // Live stage: a mid-dark floor with a few bright dancer blobs.
      const g = Math.round(255 * Math.pow(this.p.stageLevel, 1 / 2.2));
      ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.fillRect(0, 0, SRC_W, SRC_H);
      ctx.fillStyle = '#ff7ad9';
      for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(40 + i * 60, 100 + (i % 2) * 30, 18, 0, 7); ctx.fill(); }
    }
    if (key.endsWith('+pill')) {
      // Align progress pill (center, dim gray), same footprint as the page's.
      const w = Math.min(SRC_W * 0.34, 260 * SRC_W / 1000), h = SRC_H * 0.07;
      ctx.fillStyle = 'rgba(40,40,40,.55)';
      ctx.fillRect(SRC_W / 2 - w / 2, SRC_H / 2 - h / 2, w, h);
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(SRC_W / 2 - w * 0.4, SRC_H / 2 + h * 0.15, w * 0.5, h * 0.15);
    }
    const lin = contentFromCanvas(c);
    this.contents.set(key, lin);
    return lin;
  }
  buildGeometry() {
    const p = this.p;
    const dst = p.quad.map(q => ({x: q.x * CAM_W, y: q.y * CAM_H}));
    const src = [{x: 0, y: 0}, {x: SRC_W, y: 0}, {x: SRC_W, y: SRC_H}, {x: 0, y: SRC_H}];
    const H = solveH(dst, src); // camera px -> stage px
    this.lut = new Int32Array(CAM_W * CAM_H).fill(-1);
    this.vign = new Float32Array(CAM_W * CAM_H);
    for (let y = 0; y < CAM_H; y++) {
      for (let x = 0; x < CAM_W; x++) {
        const X = x + 0.5, Y = y + 0.5;
        const w = H[6] * X + H[7] * Y + H[8];
        const u = (H[0] * X + H[1] * Y + H[2]) / w;
        const v = (H[3] * X + H[4] * Y + H[5]) / w;
        if (u >= 0 && v >= 0 && u < SRC_W && v < SRC_H) {
          this.lut[y * CAM_W + x] = (Math.floor(v) * SRC_W + Math.floor(u));
          const du = u / SRC_W - 0.5, dv = v / SRC_H - 0.5;
          this.vign[y * CAM_W + x] = 1 - 0.55 * (du * du + dv * dv);
        }
      }
    }
  }
  // Ground truth: stage corners in normalized camera coords.
  truth() { return this.p.quad.map(q => ({x: q.x, y: q.y})); }
  render(tFrame) {
    const p = this.p;
    const N = CAM_W * CAM_H;
    const rad = this.rad || (this.rad = new Float32Array(N * 3));
    // Rolling shutter: row y is read at tFrame - readout*(1 - y/H).
    const keyTop = this.keyAt(tFrame - p.latencyMs - p.readoutMs);
    const keyBot = this.keyAt(tFrame - p.latencyMs);
    let split = CAM_H;
    if (keyTop !== keyBot) {
      split = this.r() < p.tearChance ? Math.floor(CAM_H * (0.2 + this.r() * 0.6)) : 0;
    }
    this.seen = this.seen || [];
    this.seen.push({t: Math.round(tFrame - this.t0), now: this.history[this.history.length - 1].key, top: keyTop, bot: keyBot, split});
    const cTop = this.content(keyTop);
    const cBot = this.content(keyBot);
    const amb = p.ambient;
    let sum = 0;
    for (let y = 0; y < CAM_H; y++) {
      const c = y < split ? cTop : cBot;
      for (let x = 0; x < CAM_W; x++) {
        const i = y * CAM_W + x;
        const s = this.lut[i];
        let r = amb, g = amb * 0.95, b = amb * 0.85;
        if (s >= 0) {
          const k = p.projector * this.vign[i];
          r += c[s * 3] * k; g += c[s * 3 + 1] * k * 0.96; b += c[s * 3 + 2] * k * 0.9;
        }
        rad[i * 3] = r; rad[i * 3 + 1] = g; rad[i * 3 + 2] = b;
        sum += r + g + b;
      }
    }
    const mean = sum / (N * 3);
    return {rad, mean};
  }
  blurInPlace(rad, radius) {
    if (radius < 1) return rad;
    const tmp = this.tmp || (this.tmp = new Float32Array(rad.length));
    const R = radius | 0, norm = 1 / (2 * R + 1);
    for (let y = 0; y < CAM_H; y++) {
      for (let ch = 0; ch < 3; ch++) {
        let acc = 0;
        for (let k = -R; k <= R; k++) acc += rad[(y * CAM_W + Math.min(CAM_W - 1, Math.max(0, k))) * 3 + ch];
        for (let x = 0; x < CAM_W; x++) {
          tmp[(y * CAM_W + x) * 3 + ch] = acc * norm;
          const add = Math.min(CAM_W - 1, x + R + 1), sub = Math.max(0, x - R);
          acc += rad[(y * CAM_W + add) * 3 + ch] - rad[(y * CAM_W + sub) * 3 + ch];
        }
      }
    }
    for (let x = 0; x < CAM_W; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let acc = 0;
        for (let k = -R; k <= R; k++) acc += tmp[(Math.min(CAM_H - 1, Math.max(0, k)) * CAM_W + x) * 3 + ch];
        for (let y = 0; y < CAM_H; y++) {
          rad[(y * CAM_W + x) * 3 + ch] = acc * norm;
          const add = Math.min(CAM_H - 1, y + R + 1), sub = Math.max(0, y - R);
          acc += tmp[(add * CAM_W + x) * 3 + ch] - tmp[(sub * CAM_W + x) * 3 + ch];
        }
      }
    }
    return rad;
  }
  grabFrame() {
    const now = performance.now();
    const tick = Math.floor((now - this.t0) / 33.33);
    if (tick === this.lastTick && this.frame) return this.frame;
    const dtTicks = this.lastTick < 0 ? 1 : tick - this.lastTick;
    this.lastTick = tick;
    const tFrame = this.t0 + tick * 33.33;
    const p = this.p;
    const {rad, mean} = this.render(tFrame);
    // Auto-exposure reacts to the scene it saw aeDeadMs ago.
    this.meanHist.push({t: tFrame, mean});
    while (this.meanHist.length > 2 && this.meanHist[1].t <= tFrame - p.aeDeadMs) this.meanHist.shift();
    const seen = this.meanHist[0].mean;
    const target = Math.min(8, Math.max(0.25, 0.18 / Math.max(0.005, seen)));
    const a = 1 - Math.exp(-33.33 * dtTicks / p.aeTauMs);
    this.gain = Math.exp(Math.log(this.gain) + (Math.log(target) - Math.log(this.gain)) * a);
    // Focus hunts after a big scene change, then settles.
    if (this.lastMean != null && Math.abs(mean - this.lastMean) / Math.max(0.02, Math.max(mean, this.lastMean)) > 0.3) this.blur = 3.2;
    this.blur = p.baseBlur + (this.blur - p.baseBlur) * Math.exp(-33.33 * dtTicks / p.afTauMs);
    this.lastMean = mean;
    this.blurInPlace(rad, Math.round(this.blur));
    const out = new Uint8ClampedArray(CAM_W * CAM_H * 4);
    const g = this.gain;
    const sigma = p.noise * (0.6 + 0.25 * Math.sqrt(g));
    const sx = Math.round((this.r() - 0.5) * 2 * p.shakePx);
    const sy = Math.round((this.r() - 0.5) * 2 * p.shakePx);
    // Gamma via LUT and noise from a pre-baked table at a random offset: the
    // sim must stay cheap so its own cost does not stretch Align's timing.
    const lut = SimCamera.gammaLut || (SimCamera.gammaLut = (() => { const t = new Float32Array(4097); for (let i = 0; i <= 4096; i++) t[i] = 255 * Math.pow(i / 4096, 1 / 2.2); return t; })());
    const noise = this.noiseTable || (this.noiseTable = (() => { const t = new Float32Array(1 << 16); for (let i = 0; i < t.length; i++) t[i] = (this.r() + this.r() + this.r() - 1.5) * 2; return t; })());
    let off = (this.r() * 65536) | 0;
    for (let y = 0; y < CAM_H; y++) {
      const yy = Math.min(CAM_H - 1, Math.max(0, y + sy));
      for (let x = 0; x < CAM_W; x++) {
        const xx = Math.min(CAM_W - 1, Math.max(0, x + sx));
        const i = (yy * CAM_W + xx) * 3;
        const o = (y * CAM_W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const lin = rad[i + ch] * g;
          const v = lin >= 1 ? 255 : lut[(lin * 4096) | 0];
          off = (off + 1) & 65535;
          out[o + ch] = v + noise[off] * sigma;
        }
        out[o + 3] = 255;
      }
    }
    this.renderMs = (this.renderMs || 0) + (performance.now() - now);
    this.renders = (this.renders || 0) + 1;
    this.frame = {data: out, width: CAM_W, height: CAM_H, videoWidth: CAM_W, videoHeight: CAM_H};
    return this.frame;
  }
}
