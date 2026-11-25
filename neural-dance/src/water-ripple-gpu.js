// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// GPU water ripples (TJ 6:12 PM: high-fidelity ripples). WebGL2, half-float
// (RGBA16F) ping-pong targets — iPhone 13 / iOS Safari renders to them via
// EXT_color_buffer_half_float; float32 color buffers are never required.
// State: R = height, G = previous height, B = |h| envelope (instant attack,
// smoothed decay). Color: RGB = band-hue carrier, A = source glow. Impulses
// are additive point sprites into a small splat target, so per-pixel cost
// does not grow with the dancer count. The shaded overlay is drawn into the
// 2D ripple canvas with drawImage (GPU upscale, no per-pixel JS).

export const GPU_RIPPLE_W = 512;
export const GPU_RIPPLE_H = 320;
export const GPU_SHADE_W = 640; // overlay shade size (drawImage smooths to the stage)
export const GPU_SHADE_H = 400;
export const GPU_SUBSTEPS = 3; // keeps ring speed ≈ the 160×100 CPU field
export const GPU_C2 = 0.2;
export const GPU_DAMP = Math.pow(0.96, 1 / GPU_SUBSTEPS);
export const GPU_COLOR_DIFF = 0.2; // <= 0.25 (explicit 2D diffusion stability)
export const GPU_COLOR_DAMP = Math.pow(0.99, 1 / GPU_SUBSTEPS); // hue only; normalized at shade
export const GPU_GLOW_DECAY = Math.pow(0.97, 1 / GPU_SUBSTEPS);
export const GPU_ENV_DECAY = Math.pow(0.91, 1 / GPU_SUBSTEPS);
export const GPU_SOFT_LIMIT = 1.15; // tanh soft clamp, never a hard reset
export const GPU_SPLAT_SIGMA = 0.0185; // field-width fraction (≈ CPU 160-grid sigma)

const VS_QUAD = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const VS_SPLAT = `#version 300 es
in vec2 a_center; // uv, y down
in vec4 a_info;   // amp, glow, size(px), unused
in vec3 a_rgb;
out float v_amp; out float v_glow; out vec3 v_rgb;
void main() {
  v_amp = a_info.x; v_glow = a_info.y; v_rgb = a_rgb;
  gl_Position = vec4(a_center.x * 2.0 - 1.0, 1.0 - a_center.y * 2.0, 0.0, 1.0);
  gl_PointSize = a_info.z;
}`;

const FS_SPLAT = `#version 300 es
precision highp float;
in float v_amp; in float v_glow; in vec3 v_rgb;
uniform float u_sigmaPx; uniform float u_sizePx;
layout(location = 0) out vec4 o_imp;
layout(location = 1) out vec4 o_col;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * u_sizePx;
  float w = exp(-dot(d, d) / (2.0 * u_sigmaPx * u_sigmaPx));
  if (w < 0.004) discard;
  o_imp = vec4(v_amp * w, w * v_glow, 0.0, 0.0);
  o_col = vec4(v_rgb * v_amp * w * 1.6, 0.0);
}`;

const FS_SIM = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_state; uniform sampler2D u_color;
uniform sampler2D u_imp; uniform sampler2D u_impCol;
uniform vec2 u_texel; uniform float u_useImp;
uniform float u_c2; uniform float u_damp; uniform float u_cdiff; uniform float u_cdamp;
uniform float u_gdecay; uniform float u_envdecay; uniform float u_limit;
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_color;
void main() {
  vec4 s = texture(u_state, v_uv);
  vec4 c = texture(u_color, v_uv);
  vec4 sL = texture(u_state, v_uv - vec2(u_texel.x, 0.0));
  vec4 sR = texture(u_state, v_uv + vec2(u_texel.x, 0.0));
  vec4 sD = texture(u_state, v_uv - vec2(0.0, u_texel.y));
  vec4 sU = texture(u_state, v_uv + vec2(0.0, u_texel.y));
  // Hue carrier diffuses on a 2-texel stencil so it keeps up with the rings
  // at 512×320 (coefficient stays <= 0.25 for stability).
  vec4 cL = texture(u_color, v_uv - vec2(2.0 * u_texel.x, 0.0));
  vec4 cR = texture(u_color, v_uv + vec2(2.0 * u_texel.x, 0.0));
  vec4 cD = texture(u_color, v_uv - vec2(0.0, 2.0 * u_texel.y));
  vec4 cU = texture(u_color, v_uv + vec2(0.0, 2.0 * u_texel.y));
  float h = s.r;
  float lap = sL.r + sR.r + sD.r + sU.r - 4.0 * h;
  float next = (2.0 * h - s.g + u_c2 * lap) * u_damp;
  vec4 imp = u_useImp > 0.5 ? texture(u_imp, v_uv) : vec4(0.0);
  vec4 impCol = u_useImp > 0.5 ? texture(u_impCol, v_uv) : vec4(0.0);
  next += imp.r;
  next = u_limit * tanh(next / u_limit);
  // Edge cells stay at rest (open water would reflect forever).
  vec2 edge = min(v_uv, 1.0 - v_uv) / u_texel;
  if (min(edge.x, edge.y) < 1.0) next = 0.0;
  vec3 rgb = (c.rgb + u_cdiff * (cL.rgb + cR.rgb + cD.rgb + cU.rgb - 4.0 * c.rgb)) * u_cdamp + impCol.rgb;
  rgb = min(max(rgb, 0.0), vec3(60.0));
  float glow = max(0.0, c.a * u_gdecay + 0.1 * (cL.a + cR.a + cD.a + cU.a - 4.0 * c.a));
  glow = min(1.0, max(glow, imp.g));
  float env = max(max(abs(next), s.b * u_envdecay), glow);
  if (!(abs(next) < 10.0)) next = 0.0; // NaN/Inf guard
  if (!(env < 10.0)) env = 0.0;
  o_state = vec4(next, h, env, 0.0);
  o_color = vec4(rgb, glow);
}`;

const FS_SHADE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_state; uniform sampler2D u_color;
uniform vec2 u_texel; uniform float u_gain;
out vec4 o;
void main() {
  vec2 uv = v_uv;
  vec4 s = texture(u_state, uv);
  float aL = abs(texture(u_state, uv - vec2(u_texel.x, 0.0)).r);
  float aR = abs(texture(u_state, uv + vec2(u_texel.x, 0.0)).r);
  float aD = abs(texture(u_state, uv - vec2(0.0, u_texel.y)).r);
  float aU = abs(texture(u_state, uv + vec2(0.0, u_texel.y)).r);
  float absSmooth = (abs(s.r) + aL + aR + aD + aU) * 0.2;
  vec4 c = texture(u_color, uv);
  // Rings over blobs: wave energy is lifted, the source glow is held back.
  float e = max(max(absSmooth * 2.0, s.b * 1.1), c.a * 0.25);
  // Soft knee instead of a hard cut (a hard cut speckles the interference).
  float k = smoothstep(0.012, 0.072, e);
  float energy = e * k;
  float sum = c.r + c.g + c.b;
  if (energy < 0.004 || sum < 1e-4) { o = vec4(0.0); return; }
  vec3 n = c.rgb / sum;
  float peak = max(max(n.r, n.g), max(n.b, 1e-6));
  vec3 col = 0.2 + 0.8 * (n / peak);
  float a = min(0.6, energy * u_gain * 1.1) * smoothstep(0.0, 0.004, sum);
  float lift = 0.85 + 0.55 * min(1.0, energy);
  o = vec4(min(col * lift, vec3(1.0)) * a, a); // premultiplied
}`;

// Sample the unwarped shade with the inverse floor homography, in this same
// context, so a second WebGL context cannot trip the slow-GPU watchdog.
const FS_WARP = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_stage;
uniform vec3 u_inv0; uniform vec3 u_inv1; uniform vec3 u_inv2;
out vec4 o;
void main() {
  // VS_QUAD: v_uv.y=1 is the top of the framebuffer, which drawImage places
  // at the top of the 2D overlay (stage y=0).
  vec2 stage = vec2(v_uv.x * u_stage.x, (1.0 - v_uv.y) * u_stage.y);
  vec3 h = vec3(
    dot(u_inv0, vec3(stage, 1.0)),
    dot(u_inv1, vec3(stage, 1.0)),
    dot(u_inv2, vec3(stage, 1.0))
  );
  if (abs(h.z) < 1e-8) { o = vec4(0.0); return; }
  vec2 uv = (h.xy / h.z) / u_stage;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { o = vec4(0.0); return; }
  o = texture(u_src, vec2(uv.x, 1.0 - uv.y));
}`;

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

function link(gl, vs, fs, attribs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return {p, u};
}

// Which half-float path this browser has (null = use the CPU field).
export function gpuRippleSupport(gl) {
  if (!gl || typeof gl.texStorage2D !== 'function') return null;
  const half = gl.getExtension('EXT_color_buffer_half_float');
  const full = half ? null : gl.getExtension('EXT_color_buffer_float');
  if (!half && !full) return null;
  return {ext: half ? 'EXT_color_buffer_half_float' : 'EXT_color_buffer_float'};
}

export function softwareRenderer(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { return false; }
}

export function createGpuRipple(options = {}) {
  if (typeof document === 'undefined') return null;
  const width = options.width | 0 || GPU_RIPPLE_W;
  const height = options.height | 0 || GPU_RIPPLE_H;
  const canvas = options.canvas || document.createElement('canvas');
  canvas.width = options.displayWidth | 0 || 1000;
  canvas.height = options.displayHeight | 0 || 620;
  const gl = canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance'});
  if (!gl) return null;
  const support = gpuRippleSupport(gl);
  if (!support) return null;
  // Software GL (SwiftShader, llvmpipe) is slower than the CPU field.
  if (!options.allowSoftware && softwareRenderer(gl)) return null;
  let progSplat, progSim, progShade, progWarp;
  try {
    progSplat = link(gl, VS_SPLAT, FS_SPLAT, ['a_center', 'a_info', 'a_rgb']);
    progSim = link(gl, VS_QUAD, FS_SIM, ['a_pos']);
    progShade = link(gl, VS_QUAD, FS_SHADE, ['a_pos']);
  } catch {
    return null;
  }
  try { progWarp = link(gl, VS_QUAD, FS_WARP, ['a_pos']); } catch { progWarp = null; }
  function tex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fbo(a, b) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('half-float framebuffer incomplete');
    return f;
  }
  let pairs;
  let splatTex;
  let splatFbo;
  try {
    pairs = [0, 1].map(() => { const s = tex(); const c = tex(); return {s, c, f: fbo(s, c)}; });
    splatTex = [tex(), tex()];
    splatFbo = fbo(splatTex[0], splatTex[1]);
  } catch {
    return null;
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const MAX_SPLATS = 96;
  const splatData = new Float32Array(MAX_SPLATS * 9);
  const splatBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, splatBuf);
  gl.bufferData(gl.ARRAY_BUFFER, splatData.byteLength, gl.DYNAMIC_DRAW);
  const vaoQuad = gl.createVertexArray();
  gl.bindVertexArray(vaoQuad);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const vaoSplat = gl.createVertexArray();
  gl.bindVertexArray(vaoSplat);
  gl.bindBuffer(gl.ARRAY_BUFFER, splatBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
  gl.bindVertexArray(null);

  // Shade size: the GL canvas is drawn into the 2D overlay with smoothing.
  const shadeW = options.shadeWidth | 0;
  const shadeH = options.shadeHeight | 0;
  let cur = 0;
  let splats = 0;
  let intensity = 0.85;
  let enabled = true;
  let lost = false;
  let warp = null;
  // Unwarped shade target, sampled by the perspective pass.
  const shadeTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadeTex);
  const shadeTexW = shadeW || 640, shadeTexH = shadeH || 400;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, shadeTexW, shadeTexH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const shadeFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadeFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadeTex, 0);
  const shadeOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const sigmaPx = GPU_SPLAT_SIGMA * width;
  const sizePx = Math.ceil(sigmaPx * 6.6);
  const maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const pointPx = Math.min(sizePx, maxPoint ? maxPoint[1] : sizePx);

  function wipe() {
    if (lost) return;
    for (const pr of pairs) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pr.f);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    splats = 0;
  }
  wipe();
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; if (options.onLost) options.onLost(); });

  function bindTex(unit, t, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit);
  }

  return {
    backend: 'webgl2-' + (support.ext === 'EXT_color_buffer_half_float' ? 'half' : 'float16'),
    width,
    height,
    gpu: true,
    glCanvas: canvas,
    lost() { return lost || (gl.isContextLost && gl.isContextLost()); },
    setEnabled(v) { enabled = v === true; if (!enabled) wipe(); },
    enabled() { return enabled; },
    setIntensity(v) { const n = +v; if (Number.isFinite(n)) intensity = Math.min(1, Math.max(0, n)); return intensity; },
    intensity() { return intensity; },
    setWarp(next) { warp = next && !next.identity ? next : null; return warp; },
    warp() { return warp; },
    clear() { wipe(); },
    hit(nx, ny, amount, rgb) {
      if (!enabled || splats >= MAX_SPLATS) return;
      if (!Number.isFinite(+nx) || !Number.isFinite(+ny)) return;
      const a = Math.max(0, Math.min(1.5, +amount || 0));
      if (!(a > 0)) return;
      const o = splats * 9;
      splatData[o] = Math.max(0, Math.min(1, +nx));
      splatData[o + 1] = Math.max(0, Math.min(1, +ny));
      splatData[o + 2] = a * 0.42; // RIPPLE_IMPULSE
      splatData[o + 3] = Math.min(1, a * 0.9 + 0.4);
      splatData[o + 4] = pointPx;
      splatData[o + 5] = 0;
      splatData[o + 6] = rgb && Number.isFinite(+rgb.r) ? Math.max(0, Math.min(1, +rgb.r)) : 0.35;
      splatData[o + 7] = rgb && Number.isFinite(+rgb.g) ? Math.max(0, Math.min(1, +rgb.g)) : 0.55;
      splatData[o + 8] = rgb && Number.isFinite(+rgb.b) ? Math.max(0, Math.min(1, +rgb.b)) : 0.85;
      splats++;
    },
    // Advance the field and draw it into the 2D overlay canvas.
    step(displayCanvas) {
      const dctx = displayCanvas && displayCanvas.getContext ? displayCanvas.getContext('2d') : null;
      if (!enabled || this.lost()) {
        if (dctx) dctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        splats = 0;
        return;
      }
      gl.disable(gl.DEPTH_TEST);
      gl.viewport(0, 0, width, height);
      // 1) splats → impulse targets (additive)
      gl.bindFramebuffer(gl.FRAMEBUFFER, splatFbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const useImp = splats > 0;
      if (useImp) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(progSplat.p);
        gl.uniform1f(progSplat.u.u_sigmaPx, sigmaPx);
        gl.uniform1f(progSplat.u.u_sizePx, pointPx);
        gl.bindBuffer(gl.ARRAY_BUFFER, splatBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, splatData.subarray(0, splats * 9));
        gl.bindVertexArray(vaoSplat);
        gl.drawArrays(gl.POINTS, 0, splats);
        gl.disable(gl.BLEND);
      }
      splats = 0;
      // 2) wave + color substeps (impulses on the first)
      gl.useProgram(progSim.p);
      gl.bindVertexArray(vaoQuad);
      const u = progSim.u;
      gl.uniform2f(u.u_texel, 1 / width, 1 / height);
      gl.uniform1f(u.u_c2, GPU_C2);
      gl.uniform1f(u.u_damp, GPU_DAMP);
      gl.uniform1f(u.u_cdiff, GPU_COLOR_DIFF);
      gl.uniform1f(u.u_cdamp, GPU_COLOR_DAMP);
      gl.uniform1f(u.u_gdecay, GPU_GLOW_DECAY);
      gl.uniform1f(u.u_envdecay, GPU_ENV_DECAY);
      gl.uniform1f(u.u_limit, GPU_SOFT_LIMIT);
      for (let k = 0; k < GPU_SUBSTEPS; k++) {
        const src = pairs[cur];
        const dst = pairs[1 - cur];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
        bindTex(0, src.s, u.u_state);
        bindTex(1, src.c, u.u_color);
        bindTex(2, splatTex[0], u.u_imp);
        bindTex(3, splatTex[1], u.u_impCol);
        gl.uniform1f(u.u_useImp, useImp && k === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        cur = 1 - cur;
      }
      // 3) shade at display resolution (bilinear field sampling)
      const useWarp = !!(warp && !warp.identity && shadeOk && progWarp);
      const sw = shadeW || displayCanvas.width;
      const sh = shadeH || displayCanvas.height;
      if (useWarp) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadeFbo);
        gl.viewport(0, 0, shadeTexW, shadeTexH);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (canvas.width !== sw) canvas.width = sw;
        if (canvas.height !== sh) canvas.height = sh;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(progShade.p);
      gl.uniform2f(progShade.u.u_texel, 1 / width, 1 / height);
      gl.uniform1f(progShade.u.u_gain, intensity);
      bindTex(0, pairs[cur].s, progShade.u.u_state);
      bindTex(1, pairs[cur].c, progShade.u.u_color);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (useWarp) {
        const dw = displayCanvas.width | 0, dh = displayCanvas.height | 0;
        if (canvas.width !== dw) canvas.width = dw;
        if (canvas.height !== dh) canvas.height = dh;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(progWarp.p);
        const inv = warp.inv;
        const stageW = warp.width || 1000;
        const stageH = warp.height || 620;
        gl.uniform2f(progWarp.u.u_stage, stageW, stageH);
        gl.uniform3f(progWarp.u.u_inv0, inv[0], inv[1], inv[2]);
        gl.uniform3f(progWarp.u.u_inv1, inv[3], inv[4], inv[5]);
        gl.uniform3f(progWarp.u.u_inv2, inv[6], inv[7], inv[8]);
        bindTex(0, shadeTex, progWarp.u.u_src);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.bindVertexArray(null);
      if (dctx) {
        dctx.globalCompositeOperation = 'source-over';
        dctx.imageSmoothingEnabled = true;
        dctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        dctx.drawImage(canvas, 0, 0, displayCanvas.width, displayCanvas.height);
      }
    },
    // Test/probe: read the field back (slow; never per frame).
    readField() {
      const out = new Float32Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[cur].f);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
    destroy() {
      try {
        for (const pr of pairs) { gl.deleteFramebuffer(pr.f); gl.deleteTexture(pr.s); gl.deleteTexture(pr.c); }
        gl.deleteFramebuffer(splatFbo); splatTex.forEach(t => gl.deleteTexture(t));
        gl.deleteBuffer(quad); gl.deleteBuffer(splatBuf);
        [progSplat, progSim, progShade, progWarp].forEach(p => { try { if (p && p.p) gl.deleteProgram(p.p); } catch { /* ignore */ } });
        try { gl.deleteFramebuffer(shadeFbo); gl.deleteTexture(shadeTex); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
  };
}
