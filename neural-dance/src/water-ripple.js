// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Subtle water-ripple background (TJ, Nov 9 4:13 PM).
// A low-res height field (WebGL ping-pong when available, CPU fallback)
// takes impulses from each dancer. Interference makes emergent patterns.
// Drawn on a separate overlay; the stage-echo sampler composites it so
// continuous detection still vetoes caustics. Off during Align, Scan,
// pattern, and latency. Impulses carry each dancer's hue; overlapping
// waves mix additively in RGB (TJ 4:31 PM). As of TJ 1:54 PM, a dancer
// emits a ripple only on its own stomp / foot-plant edges — never from
// the shared beat envelope, an activity trickle, or an idle drip.

export const RIPPLE_W = 160;
export const RIPPLE_H = 100;
export const RIPPLE_DAMP = 0.96;
export const RIPPLE_C2 = 0.20; // slower, CFL-safer (avoids near-source flip)
export const RIPPLE_IMPULSE = 0.42;
export const RIPPLE_DEFAULT_INTENSITY = 0.20; // TJ 11:31 AM (was 0.85)
export const RIPPLE_COLOR_DIFF = 0.2; // was 0.28 (> 0.25: unstable checkerboard speckle)
export const RIPPLE_SOFT_LIMIT = 1.15; // tanh soft clamp
export const RIPPLE_IDLE_IMPULSE = 0.04; // quiet rooms keep a faint drip
export const GPU_SLOW_MS = 12; // CPU-side ms per GPU step before falling back
export const RIPPLE_CROWD_REF = 3; // impulse scale 1 up to 3 dancers, then sqrt(3/N)

import {createGpuRipple, GPU_RIPPLE_W, GPU_RIPPLE_H, GPU_SHADE_W, GPU_SHADE_H} from './water-ripple-gpu.js';
import {createFloorWarpGL, warpRippleToFloor} from './perspective-floor.js';

export function fieldIsFinite(arr) {
  if (!arr || !arr.length) return true;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

export function softLimit(v, limit = RIPPLE_SOFT_LIMIT) {
  const x = +v;
  if (!Number.isFinite(x)) return 0;
  return limit * Math.tanh(x / limit);
}

// 24 seeded sims hit every frame; unscaled, the summed impulses saturated the
// field (TJ 6:10 PM: ripples vanished on Seed 24). Scale by ~1/sqrt(N).
export function crowdScale(n) {
  const k = Math.max(1, +n || 0);
  return Math.min(1, Math.sqrt(RIPPLE_CROWD_REF / k));
}

// Stomp-only hits are sparse (one ring per foot plant), not a per-frame splash
// from every dancer. The old crowd scale (sqrt(3/N) ≈ 0.33 at 24 dancers) was
// for that every-frame sum and made stomps disappear at TJ's saved intensity
// 0.25 on the projector (TJ Nov 10 3:04 PM).
export const RIPPLE_STOMP_CROWD_REF = 16;
export const RIPPLE_STOMP_GAIN = 2.6;
export const RIPPLE_STOMP_MIN = 0.22; // confirmed plant, after gain, before crowd

export function crowdScaleStomps(n) {
  const k = Math.max(1, +n || 0);
  return Math.min(1, Math.sqrt(RIPPLE_STOMP_CROWD_REF / k));
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SIM = `
precision mediump float;
uniform sampler2D u_prev;
uniform sampler2D u_curr;
uniform vec2 u_texel;
uniform float u_c2;
uniform float u_damp;
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_curr, v_uv);
  float h = c.r;
  float hL = texture2D(u_curr, v_uv - vec2(u_texel.x, 0.0)).r;
  float hR = texture2D(u_curr, v_uv + vec2(u_texel.x, 0.0)).r;
  float hD = texture2D(u_curr, v_uv - vec2(0.0, u_texel.y)).r;
  float hU = texture2D(u_curr, v_uv + vec2(0.0, u_texel.y)).r;
  float prev = texture2D(u_prev, v_uv).r;
  float lap = hL + hR + hD + hU - 4.0 * h;
  float next = (2.0 * h - prev + u_c2 * lap) * u_damp;
  // Pack height in R, previous-ish slope cue in G for shading.
  float slope = (hR - hL) * 0.5;
  gl_FragColor = vec4(next, slope * 0.5 + 0.5, 0.5, 1.0);
}`;

const SHADE = `
precision mediump float;
uniform sampler2D u_field;
uniform float u_intensity;
varying vec2 v_uv;
void main() {
  vec4 f = texture2D(u_field, v_uv);
  float h = f.r;
  float slope = f.g * 2.0 - 1.0;
  // Positive-only additive light — never darken troughs (TJ 5:15–5:16 PM).
  float energy = abs(h) * 0.7 + abs(slope) * 0.2;
  float a = energy < 0.045 ? 0.0 : clamp(energy * u_intensity, 0.0, 0.55);
  // Placeholder shade (CPU path paints the real colored field). Premultiply.
  vec3 col = vec3(0.7, 0.55, 0.95);
  gl_FragColor = vec4(col * a, a);
}`;

function makeGL(canvas) {
  const gl = canvas.getContext('webgl', {alpha: true, premultipliedAlpha: true, antialias: false})
    || canvas.getContext('experimental-webgl', {alpha: true, premultipliedAlpha: true});
  return gl || null;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log || 'shader compile failed');
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  }
  return p;
}

function makeTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) throw new Error('framebuffer incomplete');
  return {tex, fb};
}

function createWebGLRipple(canvas, width, height) {
  const gl = makeGL(canvas);
  if (!gl) return null;
  let simProg;
  let shadeProg;
  try {
    simProg = program(gl, VERT, SIM);
    shadeProg = program(gl, VERT, SHADE);
  } catch {
    return null;
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a0 = {tex: null, fb: null};
  const a1 = {tex: null, fb: null};
  let prev = makeTarget(gl, width, height);
  let curr = makeTarget(gl, width, height);
  let next = makeTarget(gl, width, height);
  const impulse = new Uint8Array(width * height * 4);
  let intensity = RIPPLE_DEFAULT_INTENSITY;
  let enabled = true;

  function bindQuad(prog) {
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  function clearField(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0.5, 0.5, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  clearField(prev);
  clearField(curr);
  clearField(next);

  return {
    backend: 'webgl',
    width,
    height,
    setEnabled(v) { enabled = v === true; if (!enabled) { clearField(prev); clearField(curr); } },
    enabled() { return enabled; },
    setIntensity(v) {
      const n = +v;
      if (Number.isFinite(n)) intensity = Math.min(1, Math.max(0, n));
      return intensity;
    },
    intensity() { return intensity; },
    clear() { clearField(prev); clearField(curr); clearField(next); },
    impulseAt(nx, ny, amount) {
      if (!enabled) return;
      const x = Math.max(1, Math.min(width - 2, Math.round((+nx || 0) * (width - 1))));
      const y = Math.max(1, Math.min(height - 2, Math.round((1 - (+ny || 0)) * (height - 1))));
      const amp = Math.max(0, Math.min(1, +amount || 0));
      if (!(amp > 0)) return;
      impulse.fill(0);
      const rad = 2;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const wgt = Math.exp(-(dx * dx + dy * dy) / 2.2) * amp;
          const i = (py * width + px) * 4;
          const v = Math.min(255, Math.round(128 + wgt * 120));
          impulse[i] = v;
          impulse[i + 1] = 128;
          impulse[i + 2] = 128;
          impulse[i + 3] = 255;
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, curr.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, impulse);
      // texSubImage replaces the whole texture here (full buffer). Re-upload
      // only the splat by reading curr is expensive; instead blend via a tiny
      // CPU read of existing is skipped — we add by sampling in a second pass.
      // Simpler: re-fetch isn't needed if we keep a CPU height for impulses.
    },
    // Prefer CPU height for impulses + upload each step (small 160x100).
    _heights: null,
    ensureHeights() {
      if (!this._heights) {
        this._heights = {
          prev: new Float32Array(width * height),
          curr: new Float32Array(width * height)
        };
      }
      return this._heights;
    },
    hit(nx, ny, amount) {
      if (!enabled) return;
      const H = this.ensureHeights();
      const x = Math.max(1, Math.min(width - 2, Math.round((+nx || 0) * (width - 1))));
      const y = Math.max(1, Math.min(height - 2, Math.round((+ny || 0) * (height - 1))));
      const amp = Math.max(0, Math.min(1.5, +amount || 0)) * RIPPLE_IMPULSE;
      const rad = 2;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const wgt = Math.exp(-(dx * dx + dy * dy) / 2.2);
          H.curr[py * width + px] += amp * wgt;
        }
      }
    },
    step(displayCanvas) {
      if (!enabled) {
        const dctx = displayCanvas.getContext('2d');
        if (dctx) dctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        return;
      }
      const H = this.ensureHeights();
      const nextH = new Float32Array(width * height);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          const lap = H.curr[i - 1] + H.curr[i + 1] + H.curr[i - width] + H.curr[i + width] - 4 * H.curr[i];
          nextH[i] = Math.max(-1.15, Math.min(1.15, (2 * H.curr[i] - H.prev[i] + RIPPLE_C2 * lap) * RIPPLE_DAMP));
        }
      }
      H.prev.set(H.curr);
      H.curr.set(nextH);
      // Shade onto display canvas via 2d (keeps WebGL optional for sim only).
      // Actually for WebGL path we upload and shade — but CPU shade is fine at 160x100 upscaled.
      shadeToCanvas(displayCanvas, H.curr, null, width, height, intensity);
    },
    destroy() {
      try {
        gl.deleteFramebuffer(prev.fb); gl.deleteTexture(prev.tex);
        gl.deleteFramebuffer(curr.fb); gl.deleteTexture(curr.tex);
        gl.deleteFramebuffer(next.fb); gl.deleteTexture(next.tex);
        gl.deleteProgram(simProg); gl.deleteProgram(shadeProg); gl.deleteBuffer(buf);
      } catch { /* ignore */ }
    }
  };
}

function shadeToCanvas(canvas, heights, colors, w, h, intensity, present = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const gain = Math.max(0, Math.min(1, intensity));
  const cr = colors && colors.r;
  const cg = colors && colors.g;
  const cb = colors && colors.b;
  for (let i = 0; i < w * h; i++) {
    const ht = heights[i];
    const x = i % w;
    const y = (i / w) | 0;
    const right = heights[y * w + Math.min(w - 1, x + 1)] || 0;
    const left = heights[y * w + Math.max(0, x - 1)] || 0;
    const slope = (right - left) * 0.5;
    // Render a smoothed |h| envelope — signed cancellations must not go dark.
    const glow = (colors && colors.glow) ? colors.glow[i] : 0;
    const env = (colors && colors.env) ? colors.env[i] : 0;
    const up = heights[Math.max(0, y - 1) * w + x] || 0;
    const dn = heights[Math.min(h - 1, y + 1) * w + x] || 0;
    const absSmooth = (Math.abs(ht) + Math.abs(left) + Math.abs(right) + Math.abs(up) + Math.abs(dn)) * 0.2;
    // Rings over blobs: lift wave energy, hold back the source glow.
    const rawE = Math.max(absSmooth * 2.0 + Math.abs(slope) * 0.3, glow * 0.25, env * 1.1);
    // Smooth knee (the old hard cut at 0.045 drew jagged, speckled edges).
    const kt = Math.max(0, Math.min(1, (rawE - 0.012) / 0.06));
    const energy = rawE * kt * kt * (3 - 2 * kt);
    const o = i * 4;
    if (energy < 0.002) {
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
      continue;
    }
    let a = Math.min(0.7, energy * gain * 1.25);
    // Additive RGB from the color field (red+green→yellow, all→white).
    let r = cr ? Math.max(0, cr[i]) : 0;
    let g = cg ? Math.max(0, cg[i]) : 0;
    let b = cb ? Math.max(0, cb[i]) : 0;
    const sum = r + g + b;
    a *= Math.min(1, sum / 0.004); // fade only where the hue carrier is gone
    if (sum < 1e-4) {
      // No color at this cell — skip rather than paint a gray/cyan wash.
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
      continue;
    }
    r = r / (sum);
    g = g / (sum);
    b = b / (sum);
    // Restore saturation: normalize then scale by chroma so hues stay vivid.
    const peak = Math.max(r, g, b, 1e-6);
    r = 0.20 + 0.80 * (r / peak);
    g = 0.20 + 0.80 * (g / peak);
    b = 0.20 + 0.80 * (b / peak);
    // Premultiply by alpha so upscaling against transparent black cannot
    // introduce a dark halo (straight-alpha lerp with 0,0,0,0 goes muddy).
    const lift = 0.85 + 0.55 * Math.min(1, energy);
    data[o] = Math.round(Math.min(255, r * 255 * lift * a));
    data[o + 1] = Math.round(Math.min(255, g * 255 * lift * a));
    data[o + 2] = Math.round(Math.min(255, b * 255 * lift * a));
    data[o + 3] = Math.round(a * 255);
  }

  // Always stash the field for tests / perf probes (even when we also paint).
  canvas.__rippleField = {width: w, height: h, heights: heights.slice(), colors: colors ? {r: colors.r.slice(), g: colors.g.slice(), b: colors.b.slice(), glow: colors.glow ? colors.glow.slice() : null, env: colors.env ? colors.env.slice() : null} : null, intensity: gain, pixels: new Uint8ClampedArray(data)};
  const dw = canvas.width | 0;
  const dh = canvas.height | 0;
  if (!(dw > 0 && dh > 0) || typeof ctx.putImageData !== 'function') return;
  ctx.clearRect(0, 0, dw, dh);
  // Browser: put the small field on a scratch canvas and let drawImage scale
  // it on the GPU (premultiplied internally, so no dark fringe). The JS
  // per-pixel upscale cost ~10 ms/frame at 1000×620.
  const scratch = scratchCanvas(canvas, w, h);
  if (scratch && typeof ctx.drawImage === 'function') {
    const straight = scratch.img.data;
    straight.set(data);
    unpremultiply(straight);
    scratch.ctx.putImageData(scratch.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch { /* older engines */ }
    ctx.globalCompositeOperation = 'source-over';
    if (present.warp && !present.warp.identity) {
      if (!warpRippleToFloor(scratch.canvas, canvas, present.warp, present.glWarp)) {
        ctx.drawImage(scratch.canvas, 0, 0, dw, dh);
      }
      return;
    }
    ctx.drawImage(scratch.canvas, 0, 0, dw, dh);
    return;
  }
  // Bilinear in premultiplied space (no dark fringe), then un-premultiply
  // because Canvas ImageData is straight-alpha.
  const up = bilinearPremul(data, w, h, dw, dh);
  unpremultiply(up);
  const out = (typeof ctx.createImageData === 'function') ? ctx.createImageData(dw, dh) : {data: up, width: dw, height: dh};
  if (out.data !== up) out.data.set(up);
  // Stage overlay uses mix-blend-mode:screen (additive — same as lighter on a dark floor).
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  ctx.putImageData(out, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  if (present.warp && !present.warp.identity && typeof ctx.getImageData === 'function') {
    // No browser scratch: the dest already holds the unwarped field. Copy
    // through a temporary canvas when we can, otherwise leave unwarped.
    const hold = scratchCanvas(canvas, dw, dh);
    if (hold) {
      hold.ctx.putImageData(out, 0, 0);
      warpRippleToFloor(hold.canvas, canvas, present.warp, present.glWarp);
    }
  }
}

function scratchCanvas(owner, w, h) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let s = owner.__rippleScratch;
  if (!s || s.canvas.width !== w || s.canvas.height !== h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    if (!cx) return null;
    s = {canvas: c, ctx: cx, img: cx.createImageData(w, h)};
    try { owner.__rippleScratch = s; } catch { return null; }
  }
  return s;
}

function unpremultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 0 || a >= 255) continue;
    const inv = 255 / a;
    data[i] = Math.min(255, data[i] * inv);
    data[i + 1] = Math.min(255, data[i + 1] * inv);
    data[i + 2] = Math.min(255, data[i + 2] * inv);
  }
}

function bilinearPremul(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (!(sw > 1 && sh > 1 && dw > 0 && dh > 0)) return out;
  const sx = (sw - 1) / Math.max(1, dw - 1);
  const sy = (sh - 1) / Math.max(1, dh - 1);
  for (let y = 0; y < dh; y++) {
    const fy = y * sy;
    const y0 = fy | 0;
    const y1 = y0 < sh - 1 ? y0 + 1 : y0;
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = x * sx;
      const x0 = fx | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0;
      const tx = fx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v0 = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
        const v1 = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
        out[o + c] = v0 + (v1 - v0) * ty;
      }
    }
  }
  return out;
}

function createCpuRipple(width, height) {
  const prev = new Float32Array(width * height);
  const curr = new Float32Array(width * height);
  const colR = new Float32Array(width * height);
  const colG = new Float32Array(width * height);
  const colB = new Float32Array(width * height);
  const glow = new Float32Array(width * height);
  const env = new Float32Array(width * height);
  // Higher-res CPU fields keep the same ring look: more substeps per frame,
  // wider splats, damping spread across substeps.
  const scale = Math.max(1, width / RIPPLE_W);
  const substeps = Math.max(1, Math.round(scale));
  const damp = Math.pow(RIPPLE_DAMP, 1 / substeps);
  const colorDamp = Math.pow(0.99, 1 / substeps); // hue only; normalized at shade
  const glowDecay = Math.pow(0.97, 1 / substeps);
  const envDecay = Math.pow(0.91, 1 / substeps);
  const hitRad = Math.round(6 * scale);
  const hitSig = 8.5 * scale * scale;
  const next = new Float32Array(width * height);
  const nextR = new Float32Array(width * height);
  const nextG = new Float32Array(width * height);
  const nextB = new Float32Array(width * height);
  let intensity = RIPPLE_DEFAULT_INTENSITY;
  let enabled = true;
  let warp = null;
  let glWarp = null;
  const colors = {r: colR, g: colG, b: colB, glow, env};
  return {
    backend: 'cpu',
    width,
    height,
    setWarp(next) { warp = next && !next.identity ? next : null; return warp; },
    warp() { return warp; },
    setEnabled(v) {
      enabled = v === true;
      if (!enabled) {
        prev.fill(0); curr.fill(0);
        colR.fill(0); colG.fill(0); colB.fill(0); glow.fill(0); env.fill(0);
      }
    },
    enabled() { return enabled; },
    setIntensity(v) {
      const n = +v;
      if (Number.isFinite(n)) intensity = Math.min(1, Math.max(0, n));
      return intensity;
    },
    intensity() { return intensity; },
    clear() {
      prev.fill(0); curr.fill(0);
      colR.fill(0); colG.fill(0); colB.fill(0); glow.fill(0); env.fill(0);
    },
    field() { return {prev, curr, colors}; },
    // amount: impulse strength. rgb: optional {r,g,b} in 0..1 (dancer hue).
    hit(nx, ny, amount, rgb) {
      if (!enabled) return;
      const x = Math.max(1, Math.min(width - 2, Math.round((+nx || 0) * (width - 1))));
      const y = Math.max(1, Math.min(height - 2, Math.round((+ny || 0) * (height - 1))));
      const amp = Math.max(0, Math.min(1.5, +amount || 0)) * RIPPLE_IMPULSE;
      const rr = rgb && Number.isFinite(+rgb.r) ? Math.max(0, Math.min(1, +rgb.r)) : 0.35;
      const gg = rgb && Number.isFinite(+rgb.g) ? Math.max(0, Math.min(1, +rgb.g)) : 0.55;
      const bb = rgb && Number.isFinite(+rgb.b) ? Math.max(0, Math.min(1, +rgb.b)) : 0.85;
      const rad = hitRad;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const wgt = Math.exp(-(dx * dx + dy * dy) / hitSig);
          const i = py * width + px;
          curr[i] = softLimit(curr[i] + amp * wgt);
          const deposit = amp * wgt * 1.6;
          colR[i] += rr * deposit;
          colG[i] += gg * deposit;
          colB[i] += bb * deposit;
          glow[i] = Math.max(glow[i], wgt * Math.min(1.0, (+amount || 0) * 0.9 + 0.4));
          env[i] = Math.max(env[i], Math.abs(curr[i]), glow[i]);
        }
      }
    },
    step(displayCanvas) {
      if (!enabled) {
        const dctx = displayCanvas.getContext('2d');
        if (dctx) dctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        return;
      }
      // Reused scratch buffers (no per-frame allocation).
      // Color rides the crest: diffuse near wave speed so rings stay hued.
      for (let k = 0; k < substeps; k++) {
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          const lap = curr[i - 1] + curr[i + 1] + curr[i - width] + curr[i + width] - 4 * curr[i];
          next[i] = softLimit((2 * curr[i] - prev[i] + RIPPLE_C2 * lap) * damp);
          const cLapR = colR[i - 1] + colR[i + 1] + colR[i - width] + colR[i + width] - 4 * colR[i];
          const cLapG = colG[i - 1] + colG[i + 1] + colG[i - width] + colG[i + width] - 4 * colG[i];
          const cLapB = colB[i - 1] + colB[i + 1] + colB[i - width] + colB[i + width] - 4 * colB[i];
          nextR[i] = (colR[i] + RIPPLE_COLOR_DIFF * cLapR) * colorDamp;
          nextG[i] = (colG[i] + RIPPLE_COLOR_DIFF * cLapG) * colorDamp;
          nextB[i] = (colB[i] + RIPPLE_COLOR_DIFF * cLapB) * colorDamp;
          const gLap = glow[i - 1] + glow[i + 1] + glow[i - width] + glow[i + width] - 4 * glow[i];
          glow[i] = Math.max(0, glow[i] * glowDecay + 0.1 * gLap);
          // Smoothed |h| envelope: persists through signed-wave cancellations.
          env[i] = Math.max(Math.abs(next[i]), env[i] * envDecay, glow[i]);
        }
      }
      prev.set(curr);
      curr.set(next);
      colR.set(nextR);
      colG.set(nextG);
      colB.set(nextB);
      }
      if (!fieldIsFinite(curr) || !fieldIsFinite(colR)) {
        prev.fill(0); curr.fill(0); colR.fill(0); colG.fill(0); colB.fill(0); glow.fill(0); env.fill(0);
      }
      if (warp && !glWarp) glWarp = createFloorWarpGL();
      shadeToCanvas(displayCanvas, curr, colors, width, height, intensity, {warp, glWarp});
    },
    destroy() {}
  };
}

// Public factory. Tries WebGL init (for capability reporting) but simulates on
// CPU at RIPPLE_W×RIPPLE_H — cheap and identical visually when upscaled.
export const RIPPLE_CPU_HIRES_W = 320; // browser CPU fallback (no WebGL2 half-float)
export const RIPPLE_CPU_HIRES_H = 200;
export function createWaterRipple(options = {}) {
  const browser = typeof document !== 'undefined';
  const w = options.width | 0 || (browser ? RIPPLE_CPU_HIRES_W : RIPPLE_W);
  const h = options.height | 0 || (browser ? RIPPLE_CPU_HIRES_H : RIPPLE_H);
  const probe = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let webglOk = false;
  if (probe) {
    probe.width = 4; probe.height = 4;
    const gl = makeGL(probe);
    if (gl) {
      try {
        compile(gl, gl.VERTEX_SHADER, VERT);
        compile(gl, gl.FRAGMENT_SHADER, SIM);
        compile(gl, gl.FRAGMENT_SHADER, SHADE);
        webglOk = true;
      } catch { webglOk = false; }
    }
  }
  if (options.cpu !== true && probe) {
    const gpu = gpuWithFallback(options, webglOk);
    if (gpu) return gpu;
  }
  const sim = createCpuRipple(w, h);
  sim.webglAvailable = webglOk;
  sim.backend = webglOk ? 'cpu+webgl-capable' : 'cpu';
  return sim;
}

// GPU field (WebGL2 half-float, 512×320) with an automatic switch to the CPU
// field if the context is lost. Same interface either way.
function gpuWithFallback(options, webglOk) {
  let impl = null;
  let fellBack = false;
  let settings = {enabled: true, intensity: RIPPLE_DEFAULT_INTENSITY, warp: null};
  let slowAvg = 0;
  let frames = 0;
  let slowStop = false;
  let restores = 0;
  const makeGpu = (canvas) => createGpuRipple({canvas, width: options.gpuWidth || GPU_RIPPLE_W, height: options.gpuHeight || GPU_RIPPLE_H, shadeWidth: options.shadeWidth || GPU_SHADE_W, shadeHeight: options.shadeHeight || GPU_SHADE_H, allowSoftware: options.allowSoftware === true, onLost: () => toCpu('lost')});
  // Soak test (Nov 9): a lost context (iOS memory pressure, backgrounding, or
  // WEBGL_lose_context) used to pin the CPU field for the rest of the show.
  // Now the GPU field comes back on webglcontextrestored; a slow GPU still
  // stays on the CPU, and its GL resources are freed.
  const toCpu = (reason) => {
    if (fellBack) return;
    fellBack = true;
    const old = impl;
    const cpu = createCpuRipple(RIPPLE_CPU_HIRES_W, RIPPLE_CPU_HIRES_H);
    cpu.setIntensity(settings.intensity);
    cpu.setEnabled(settings.enabled);
    if (cpu.setWarp) cpu.setWarp(settings.warp);
    impl = cpu;
    facade.backend = 'cpu (gpu lost)';
    if (reason === 'slow') {
      slowStop = true;
      try { if (old && old.gpu) old.destroy(); } catch { /* ignore */ }
      return;
    }
    const glCanvas = old && old.glCanvas;
    if (!glCanvas || typeof glCanvas.addEventListener !== 'function' || restores >= 8) return;
    glCanvas.addEventListener('webglcontextrestored', () => {
      if (!fellBack || slowStop) return;
      let next = null;
      try { next = makeGpu(glCanvas); } catch { next = null; }
      if (!next) return;
      restores++;
      next.setIntensity(settings.intensity);
      next.setEnabled(settings.enabled);
      if (next.setWarp) next.setWarp(settings.warp);
      impl = next;
      fellBack = false;
      frames = 0;
      slowAvg = 0;
      facade.backend = next.backend;
    }, {once: true});
  };
  try {
    impl = makeGpu(undefined);
  } catch { impl = null; }
  if (!impl) return null;
  const facade = {
    backend: impl.backend,
    webglAvailable: webglOk,
    get width() { return impl.width; },
    get height() { return impl.height; },
    get gpu() { return !!impl.gpu; },
    setEnabled(v) { settings.enabled = v === true; return impl.setEnabled(v); },
    enabled() { return impl.enabled(); },
    setIntensity(v) { const r = impl.setIntensity(v); settings.intensity = impl.intensity(); return r; },
    intensity() { return impl.intensity(); },
    setWarp(next) { settings.warp = next; if (impl && impl.setWarp) impl.setWarp(next); return settings.warp; },
    warp() { return impl && impl.warp ? impl.warp() : settings.warp || null; },
    clear() { return impl.clear(); },
    hit(nx, ny, amount, rgb) { return impl.hit(nx, ny, amount, rgb); },
    step(canvas) {
      if (impl.gpu && impl.lost()) toCpu('lost');
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      try { impl.step(canvas); } catch { toCpu(impl.gpu && impl.lost() ? 'lost' : 'slow'); impl.step(canvas); return; }
      // Watchdog: if the GPU path is slow on this device, use the CPU field.
      if (impl.gpu && t0 && options.allowSoftware !== true) {
        const dt = performance.now() - t0;
        slowAvg = slowAvg * 0.9 + dt * 0.1;
        if (++frames > 30 && slowAvg > GPU_SLOW_MS) { toCpu('slow'); facade.backend = 'cpu (gpu slow)'; }
      }
    },
    field() { return impl.field ? impl.field() : null; },
    readField() { return impl.readField ? impl.readField() : null; },
    destroy() { return impl.destroy(); }
  };
  return facade;
}

export function compileRippleShaders(gl = null) {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = gl || (canvas && makeGL(canvas));
  if (!ctx) return {ok: false, reason: 'no webgl'};
  try {
    compile(ctx, ctx.VERTEX_SHADER, VERT);
    compile(ctx, ctx.FRAGMENT_SHADER, SIM);
    compile(ctx, ctx.FRAGMENT_SHADER, SHADE);
    return {ok: true, reason: ''};
  } catch (err) {
    return {ok: false, reason: String(err && err.message || err)};
  }
}

// Stage px → normalized 0..1 for the height field (y grows downward on stage).
export function stageToRippleUV(x, y, stageW = 1000, stageH = 620) {
  return {
    x: Math.max(0, Math.min(1, (+x || 0) / stageW)),
    y: Math.max(0, Math.min(1, (+y || 0) / stageH))
  };
}

export function parseHexRgb(hex) {
  const s = String(hex || '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) return {r: 0.4, g: 0.6, b: 0.9};
  const n = parseInt(m[1], 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
}

export const RIPPLE_IDLE_DRIP = 0.55; // kept for callers; no longer a ripple source
export const RIPPLE_IDLE_PERIOD_MS = 1400;
const STOMP_PEAK = 0.65; // softer-stomp ceiling (matches skeleton-motion)
const STOMP_REST_FRAC = 0.20;
const STOMP_CALM = STOMP_PEAK * STOMP_REST_FRAC;
const LIFT_PLANT = 0.01; // lift crossing below this is a foot plant

// Kept exported so older tests can import it. It is not a ripple source
// anymore (TJ 1:54 PM: ripples are driven only by stomps).
export function idleDrip(id, now) {
  const t = +now;
  if (!Number.isFinite(t) || t <= 0) return 0;
  const phase = (t / RIPPLE_IDLE_PERIOD_MS + ((id | 0) * 0.618034)) % 1;
  const s = Math.sin(Math.PI * Math.min(1, phase / 0.12)); // ~170 ms bump
  return phase < 0.12 ? RIPPLE_IDLE_DRIP * s * s : 0;
}

function stompStrength(fig, kind) {
  let stomp = fig && fig.stomp != null && Number.isFinite(+fig.stomp) ? +fig.stomp : NaN;
  if (!Number.isFinite(stomp)) {
    const act = fig && fig.activation != null ? Math.max(0, Math.min(1, +fig.activation)) : 0;
    const u = act * act * (3 - 2 * act);
    const hush = fig && fig.hush != null && Number.isFinite(+fig.hush) ? Math.max(0, Math.min(1, +fig.hush)) : 1;
    stomp = (STOMP_CALM + (STOMP_PEAK - STOMP_CALM) * u) * hush;
  }
  const mul = kind === 'ballChange' ? 0.55 : (kind === 'toeTap' || kind === 'toe' ? 0.72 : 1);
  return Math.max(0, Math.min(STOMP_PEAK, stomp * mul));
}

function plantXY(fig, side) {
  if (!fig) return {x: NaN, y: NaN};
  const foot = side < 0 ? fig.footL : fig.footR;
  const heel = side < 0 ? fig.heelL : fig.heelR;
  const contact = side < 0 ? fig.contactL : fig.contactR;
  const use = (contact === 'heel' && heel && Number.isFinite(+heel.x) && Number.isFinite(+heel.y)) ? heel : foot;
  if (use && Number.isFinite(+use.x) && Number.isFinite(+use.y)) return {x: +use.x, y: +use.y};
  if (Number.isFinite(+fig.floorY) && Number.isFinite(+fig.x)) return {x: +fig.x, y: +fig.floorY};
  if (Number.isFinite(+fig.x) && Number.isFinite(+fig.y)) return {x: +fig.x, y: +fig.y};
  return {x: NaN, y: NaN};
}

function plantedSideOf(fig) {
  if (fig && (fig.pulseSide === 1 || fig.pulseSide === -1)) return fig.pulseSide;
  if (fig && (fig.planted === 1 || fig.planted === -1)) return fig.planted;
  return -1;
}

// Compare the previous and current figureHeights row and return the stomp /
// foot-plant edges in this frame only. Each event is one clean ring at that
// foot: a swing-foot landing, a weight-transfer strike, or a heel/toe ornament
// on a planted foot. Standing still yields [].
export function stompPlantsFromFigure(prev, curr) {
  if (!curr) return [];
  const out = [];
  const take = (side, kind) => {
    const amount = stompStrength(curr, kind);
    if (!(amount > 0)) return;
    const xy = plantXY(curr, side);
    if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) return;
    if (out.some(p => p.side === side)) return;
    out.push({side, kind, x: xy.x, y: xy.y, amount});
  };
  const lift = (row, side) => {
    if (!row) return 0;
    const v = side < 0 ? +row.liftL : +row.liftR;
    return Number.isFinite(v) ? v : 0;
  };
  if (prev) {
    if (lift(prev, -1) > LIFT_PLANT && !(lift(curr, -1) > LIFT_PLANT)) take(-1, 'land');
    if (lift(prev, 1) > LIFT_PLANT && !(lift(curr, 1) > LIFT_PLANT)) take(1, 'land');
  }
  const prevStrike = prev && Number.isFinite(+prev.lastStrikeT0) ? +prev.lastStrikeT0 : -1;
  const currStrike = Number.isFinite(+curr.lastStrikeT0) ? +curr.lastStrikeT0 : -1;
  if (currStrike > 0 && currStrike !== prevStrike) {
    take(plantedSideOf(curr), 'transfer');
  }
  if (prev) {
    for (const side of [-1, 1]) {
      const c0 = side < 0 ? prev.contactL : prev.contactR;
      const c1 = side < 0 ? curr.contactL : curr.contactR;
      if (!(lift(curr, side) > LIFT_PLANT) && c1 && c0 && c1 !== c0 && c1 !== 'flat') {
        take(side, c1 === 'heel' ? 'heelDrop' : 'toeTap');
      }
    }
  }
  return out;
}

// Amount for one stomp event, or 0 when this dancer is not stomping this
// frame. The beat envelope, activity trickle, and idle drip are not sources
// (TJ 1:54 PM). `envelope` and `now` stay in the signature for existing calls.
export function impulseFromDancer(dancer, envelope, now = 0) {
  if (!dancer) return 0;
  let raw = dancer.stompHit != null ? +dancer.stompHit : NaN;
  if (!Number.isFinite(raw) && Array.isArray(dancer.plants) && dancer.plants.length) {
    raw = 0;
    for (const p of dancer.plants) {
      const a = p && Number.isFinite(+p.amount) ? +p.amount : 0;
      if (a > raw) raw = a;
    }
  }
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(0, Math.min(STOMP_PEAK, raw));
}

// Projector-visible stomp impulse: boost a confirmed plant so a single ring
// reads at intensity 0.20–0.25, then apply the milder stomp crowd scale.
export function stompRippleAmount(plantAmount, crowd = 1, hush = 1) {
  const raw = Math.max(0, Math.min(STOMP_PEAK, +plantAmount || 0));
  if (!(raw > 0)) return 0;
  const hu = Number.isFinite(+hush) ? Math.max(0, Math.min(1, +hush)) : 1;
  if (!(hu > 0)) return 0;
  // #95 visibility boost applies as activation rises. Rest plants stay a
  // soft fraction of that ring (no floor-to-0.22 lift at rest).
  const t = Math.max(0, Math.min(1, (raw - STOMP_CALM) / Math.max(1e-6, 0.40 - STOMP_CALM)));
  const u = t * t * (3 - 2 * t);
  const gain = 1 + (RIPPLE_STOMP_GAIN - 1) * u;
  let boosted = raw * gain;
  if (u > 0.85) boosted = Math.max(RIPPLE_STOMP_MIN, boosted);
  const sc = Number.isFinite(+crowd) ? Math.max(0, +crowd) : 1;
  return Math.max(0, Math.min(1.5, boosted * sc * hu));
}
