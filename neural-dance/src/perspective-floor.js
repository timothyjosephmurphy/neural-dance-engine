// Perspective stage floor (TJ 2:12 PM): the ground recedes, nearer at the
// bottom and farther at the top. Sacred ellipse rings and cross lines live
// in floor coordinates and are drawn through a homography; the water-ripple
// field stays in floor space and is projectively warped onto the same plane.
// Stickers and dancer placement stay in unwarped stage pixels.

import {applyHomography, solveHomography} from '../camera-markers.js';

export const STAGE_W = 1000;
export const STAGE_H = 620;
// Moderate default: far edge is clearly narrower, vanishing point well above
// the frame, without a dramatic hallway squeeze.
export const PERSPECTIVE_DEFAULT = 0.5;
export const PERSPECTIVE_PREF_KEY = 'nd.floor.perspective.v1';
export const FLOOR_GRID_STROKE = 'rgba(145,150,180,.22)';
export const FLOOR_GRID_WIDTH = 1.4;
export const SACRED_FLOOR = Object.freeze({
  CX: 500, CY: 310, SX: 1.18, SY: 0.72,
  radii: Object.freeze([105, 185, 265]),
  lineRX: 360, lineRY: 230
});
// At strength 1 the far edge is inset by this fraction of the stage width
// on each side (far width = 1 - 2 * FAR_INSET_AT_ONE).
const FAR_INSET_AT_ONE = 0.32;
const NEAR_INSET_AT_ONE = 0.02;

export function clampPerspective(value) {
  if (!Number.isFinite(+value)) return PERSPECTIVE_DEFAULT;
  return Math.max(0, Math.min(1, +value));
}

export function floorTrapezoid(strength, w = STAGE_W, h = STAGE_H) {
  const s = clampPerspective(strength);
  const far = w * FAR_INSET_AT_ONE * s;
  const near = w * NEAR_INSET_AT_ONE * s;
  // y=0 is the far edge, y=h is the near edge (bottom of the stage).
  return [
    {x: far, y: 0},
    {x: w - far, y: 0},
    {x: w - near, y: h},
    {x: near, y: h}
  ];
}

export function floorSourceCorners(w = STAGE_W, h = STAGE_H) {
  return [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}];
}

export function vanishingPoint(strength, w = STAGE_W, h = STAGE_H) {
  const trap = floorTrapezoid(strength, w, h);
  const s = clampPerspective(strength);
  if (s <= 1e-9) return {x: w / 2, y: -Infinity, finite: false};
  const l0 = trap[3], l1 = trap[0];
  const r0 = trap[2], r1 = trap[1];
  const dlx = l1.x - l0.x, dly = l1.y - l0.y;
  const drx = r1.x - r0.x, dry = r1.y - r0.y;
  const den = dlx * dry - dly * drx;
  if (Math.abs(den) < 1e-8) return {x: w / 2, y: -Infinity, finite: false};
  const t = ((r0.x - l0.x) * dry - (r0.y - l0.y) * drx) / den;
  return {x: l0.x + t * dlx, y: l0.y + t * dly, finite: true};
}

export function floorHomography(strength, w = STAGE_W, h = STAGE_H) {
  const s = clampPerspective(strength);
  const src = floorSourceCorners(w, h);
  const dst = floorTrapezoid(s, w, h);
  if (s <= 1e-9) {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return {H: I, inv: I, strength: 0, width: w, height: h, trapezoid: dst, identity: true};
  }
  const H = solveHomography(src, dst);
  const inv = solveHomography(dst, src);
  if (!H || !inv) {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return {H: I, inv: I, strength: 0, width: w, height: h, trapezoid: src, identity: true};
  }
  return {H, inv, strength: s, width: w, height: h, trapezoid: dst, identity: false};
}

export function projectFloor(warp, x, y) {
  if (!warp || warp.identity) return {x, y};
  return applyHomography(warp.H, x, y) || {x, y};
}

export function unprojectFloor(warp, x, y) {
  if (!warp || warp.identity) return {x, y};
  return applyHomography(warp.inv, x, y) || {x, y};
}

// Screen / stage pixels (dancer feet) → normalized floor UV for the ripple field.
export function screenToFloorUV(x, y, warp, stageW = STAGE_W, stageH = STAGE_H) {
  const p = unprojectFloor(warp, +x || 0, +y || 0);
  return {
    x: Math.max(0, Math.min(1, p.x / stageW)),
    y: Math.max(0, Math.min(1, p.y / stageH))
  };
}

export function drawSacredFloor(ctx, mapXy, warp) {
  if (!ctx) return;
  const {CX, CY, SX, SY, radii, lineRX, lineRY} = SACRED_FLOOR;
  const through = (x, y) => {
    const p = projectFloor(warp, x, y);
    return typeof mapXy === 'function' ? mapXy(p.x, p.y) : p;
  };
  ctx.save();
  ctx.strokeStyle = FLOOR_GRID_STROKE;
  ctx.lineWidth = FLOOR_GRID_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const r of radii) {
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const a = i / 100 * Math.PI * 2;
      const p = through(CX + Math.cos(a) * r * SX, CY + Math.sin(a) * r * SY);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  }
  for (let a = 0; a < Math.PI; a += Math.PI / 4) {
    const p = through(CX - Math.cos(a) * lineRX, CY - Math.sin(a) * lineRY);
    const q = through(CX + Math.cos(a) * lineRX, CY + Math.sin(a) * lineRY);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.restore();
}

// Inverse-homography bilinear sample. src is packed RGBA (straight or
// premultiplied — we copy as-is). Dest pixels outside the floor are cleared.
export function warpImageData(src, sw, sh, dw, dh, inv, stageW = STAGE_W, stageH = STAGE_H) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (!(sw > 1 && sh > 1 && dw > 0 && dh > 0) || !inv) return out;
  const sx = stageW / dw;
  const sy = stageH / dh;
  const maxX = sw - 1;
  const maxY = sh - 1;
  for (let y = 0; y < dh; y++) {
    const stageY = (y + 0.5) * sy;
    for (let x = 0; x < dw; x++) {
      const stageX = (x + 0.5) * sx;
      const p = applyHomography(inv, stageX, stageY);
      if (!p) continue;
      const fu = p.x / stageW * maxX;
      const fv = p.y / stageH * maxY;
      if (fu < 0 || fv < 0 || fu > maxX || fv > maxY) continue;
      const x0 = fu | 0;
      const y0 = fv | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const tx = fu - x0;
      const ty = fv - y0;
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

const WARP_VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Clip y=+1 is the top of a WebGL canvas when drawn into 2D, so map it
  // to stage y=0 (the far edge). Do not flip on upload: texture2D uv.y=0
  // is the first row of the 2D source, which is also the far edge.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, -a_pos.y * 0.5 + 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const WARP_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_destSize;
uniform vec2 u_stage;
// Inverse homography, row-major (screen stage px → floor stage px).
uniform vec3 u_inv0;
uniform vec3 u_inv1;
uniform vec3 u_inv2;
void main() {
  vec2 stage = v_uv * u_stage;
  vec3 h = vec3(
    dot(u_inv0, vec3(stage, 1.0)),
    dot(u_inv1, vec3(stage, 1.0)),
    dot(u_inv2, vec3(stage, 1.0))
  );
  if (abs(h.z) < 1e-8) discard;
  vec2 floorPx = h.xy / h.z;
  vec2 uv = floorPx / u_stage;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  gl_FragColor = texture2D(u_src, uv);
}`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log || 'shader');
  }
  return sh;
}

function makeWarpGL(canvas) {
  const opts = {alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false};
  return canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
}

export function createFloorWarpGL() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const gl = makeWarpGL(canvas);
  if (!gl) return null;
  // SwiftShader / llvmpipe is far slower than a half-res CPU sample.
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
    if (/swiftshader|llvmpipe|softpipe|microsoft basic render/i.test(renderer)) return null;
  } catch { /* keep going */ }
  let lost = false;
  try {
    const vs = compileShader(gl, gl.VERTEX_SHADER, WARP_VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, WARP_FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const u = {
      u_src: gl.getUniformLocation(prog, 'u_src'),
      u_destSize: gl.getUniformLocation(prog, 'u_destSize'),
      u_stage: gl.getUniformLocation(prog, 'u_stage'),
      u_inv0: gl.getUniformLocation(prog, 'u_inv0'),
      u_inv1: gl.getUniformLocation(prog, 'u_inv1'),
      u_inv2: gl.getUniformLocation(prog, 'u_inv2')
    };
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
    return {
      gl,
      canvas,
      lost() { return lost || (gl.isContextLost && gl.isContextLost()); },
      draw(src, dest, warp) {
        if (this.lost() || !src || !dest || !warp || !warp.inv) return false;
        const dw = dest.width | 0, dh = dest.height | 0;
        if (!(dw > 0 && dh > 0)) return false;
        if (canvas.width !== dw) canvas.width = dw;
        if (canvas.height !== dh) canvas.height = dh;
        const dctx = dest.getContext && dest.getContext('2d');
        if (!dctx) return false;
        gl.viewport(0, 0, dw, dh);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); } catch { /* ignore */ }
        try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1); } catch { /* ignore */ }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        const inv = warp.inv;
        const stageW = warp.width || STAGE_W;
        const stageH = warp.height || STAGE_H;
        gl.uniform1i(u.u_src, 0);
        gl.uniform2f(u.u_destSize, dw, dh);
        gl.uniform2f(u.u_stage, stageW, stageH);
        gl.uniform3f(u.u_inv0, inv[0], inv[1], inv[2]);
        gl.uniform3f(u.u_inv1, inv[3], inv[4], inv[5]);
        gl.uniform3f(u.u_inv2, inv[6], inv[7], inv[8]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        dctx.globalCompositeOperation = 'source-over';
        dctx.imageSmoothingEnabled = true;
        dctx.clearRect(0, 0, dw, dh);
        dctx.drawImage(canvas, 0, 0, dw, dh);
        return true;
      },
      destroy() {
        try {
          gl.deleteBuffer(buf);
          gl.deleteTexture(tex);
          gl.deleteProgram(prog);
        } catch { /* ignore */ }
      }
    };
  } catch {
    return null;
  }
}

// Affine horizontal slices: a cheap CPU stand-in for a projective blit.
// A centered trapezoid changes width slowly, so ~28 slices read as smooth.
export function warpCanvasStrips(src, dest, warp, slices = 28) {
  if (!src || !dest || !warp) return false;
  const dctx = dest.getContext && dest.getContext('2d');
  if (!dctx || typeof dctx.drawImage !== 'function') return false;
  const dw = dest.width | 0, dh = dest.height | 0;
  const sw = src.width | 0, sh = src.height | 0;
  if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) return false;
  const stageW = warp.width || STAGE_W;
  const stageH = warp.height || STAGE_H;
  const n = Math.max(8, slices | 0);
  dctx.save();
  dctx.globalCompositeOperation = 'source-over';
  dctx.imageSmoothingEnabled = true;
  try { dctx.imageSmoothingQuality = 'high'; } catch { /* older engines */ }
  dctx.clearRect(0, 0, dw, dh);
  const trap = warp.trapezoid;
  if (trap && trap.length === 4) {
    dctx.beginPath();
    dctx.moveTo(trap[0].x / stageW * dw, trap[0].y / stageH * dh);
    for (let i = 1; i < 4; i++) dctx.lineTo(trap[i].x / stageW * dw, trap[i].y / stageH * dh);
    dctx.closePath();
    dctx.clip();
  }
  for (let i = 0; i < n; i++) {
    const y0 = i / n * stageH;
    const y1 = (i + 1) / n * stageH;
    const l0 = projectFloor(warp, 0, y0);
    const r0 = projectFloor(warp, stageW, y0);
    const l1 = projectFloor(warp, 0, y1);
    const r1 = projectFloor(warp, stageW, y1);
    const xL = Math.min(l0.x, l1.x) / stageW * dw;
    const xR = Math.max(r0.x, r1.x) / stageW * dw;
    const yT = l0.y / stageH * dh;
    const yB = l1.y / stageH * dh;
    const dww = xR - xL, dhh = yB - yT;
    if (!(dww > 0.5 && dhh > 0.5)) continue;
    dctx.drawImage(src, 0, i / n * sh, sw, sh / n + 0.6, xL, yT, dww, dhh + 0.6);
  }
  dctx.restore();
  return true;
}

export function warpRippleToFloor(src, dest, warp, glWarp) {
  if (!dest) return false;
  const dctx = dest.getContext && dest.getContext('2d');
  if (!dctx) return false;
  const dw = dest.width | 0, dh = dest.height | 0;
  if (!(dw > 0 && dh > 0)) return false;
  if (!src || !warp || warp.identity) {
    if (src && src !== dest && typeof dctx.drawImage === 'function') {
      dctx.globalCompositeOperation = 'source-over';
      dctx.clearRect(0, 0, dw, dh);
      dctx.drawImage(src, 0, 0, dw, dh);
      return true;
    }
    return false;
  }
  if (glWarp && !glWarp.lost() && glWarp.draw(src, dest, warp)) return true;
  if (warpCanvasStrips(src, dest, warp)) return true;
  const sctx = src.getContext && src.getContext('2d');
  if (!sctx || typeof sctx.getImageData !== 'function') return false;
  const sw = src.width | 0, sh = src.height | 0;
  if (!(sw > 0 && sh > 0)) return false;
  let img;
  try { img = sctx.getImageData(0, 0, sw, sh); } catch { return false; }
  // Half-res sample then GPU/2D upscale — a full 1000×620 JS loop was ~10 ms.
  const maxPix = 500 * 310;
  let tw = dw, th = dh;
  if (tw * th > maxPix) {
    const s = Math.sqrt(maxPix / (tw * th));
    tw = Math.max(2, Math.round(dw * s));
    th = Math.max(2, Math.round(dh * s));
  }
  const pixels = warpImageData(img.data, sw, sh, tw, th, warp.inv, warp.width || STAGE_W, warp.height || STAGE_H);
  dctx.globalCompositeOperation = 'source-over';
  dctx.imageSmoothingEnabled = true;
  dctx.clearRect(0, 0, dw, dh);
  if (tw === dw && th === dh && typeof dctx.putImageData === 'function') {
    const out = (typeof dctx.createImageData === 'function') ? dctx.createImageData(dw, dh) : {data: pixels, width: dw, height: dh};
    if (out.data !== pixels) out.data.set(pixels);
    dctx.putImageData(out, 0, 0);
    return true;
  }
  let hold = dest.__ndWarpHold;
  if (!hold || hold.width !== tw || hold.height !== th) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      if (typeof dctx.putImageData === 'function') {
        const out = (typeof dctx.createImageData === 'function') ? dctx.createImageData(tw, th) : {data: pixels, width: tw, height: th};
        if (out.data !== pixels) out.data.set(pixels);
        try { dctx.putImageData(out, 0, 0); } catch { return false; }
      }
      return true;
    }
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const cx = c.getContext('2d');
    if (!cx) return false;
    hold = {canvas: c, ctx: cx, img: cx.createImageData(tw, th)};
    try { dest.__ndWarpHold = hold; } catch { /* ignore */ }
  }
  hold.img.data.set(pixels);
  hold.ctx.putImageData(hold.img, 0, 0);
  dctx.drawImage(hold.canvas, 0, 0, dw, dh);
  return true;
}

export function savedPerspective(box) {
  if (!box || typeof box.getItem !== 'function') return PERSPECTIVE_DEFAULT;
  try {
    const raw = box.getItem(PERSPECTIVE_PREF_KEY);
    if (raw == null || raw === '') return PERSPECTIVE_DEFAULT;
    const v = +JSON.parse(raw);
    return Number.isFinite(v) ? clampPerspective(v) : PERSPECTIVE_DEFAULT;
  } catch {
    const n = +box.getItem(PERSPECTIVE_PREF_KEY);
    return Number.isFinite(n) ? clampPerspective(n) : PERSPECTIVE_DEFAULT;
  }
}

export function savePerspective(box, value) {
  if (!box || typeof box.setItem !== 'function') return clampPerspective(value);
  const v = clampPerspective(value);
  try { box.setItem(PERSPECTIVE_PREF_KEY, JSON.stringify(v)); } catch { /* ignore */ }
  return v;
}
