// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Vibrating string through each dancer (TJ, Nov 9).
// Runs root (groin) → crown (head) only — not to the feet. Fixed chakra hue
// order along the line (red→violet); per-dancer hue is a subtle tint on top
// and must not reorder the spectrum. Harmonic mode follows the dancer's band;
// amplitude follows the band level. Self-contained (no silhouette.js import).

import {pulseVisibility} from './pulse-visibility.js';

// Center frequency of each band (kick, bass, snare, hi-hat). Used for the
// visible standing-wave rate and the harmonic count.
export const BAND_CENTER_HZ = [80, 210, 1400, 9500];
export const STRING_SEGMENTS = 48;
export const STRING_LINE_WIDTH = 3.1;
export const STRING_GLOW_WIDTH = 9;
export const STRING_MAX_AMP = 6; // stage px at full level (calmer spine, TJ Nov 10 4:10 PM)
export const STRING_REST_AMP = 0.7;
// Visual rate: map audio Hz into a readable oscillation (not 9 kHz).
export const STRING_VIS_RATE = 0.006; // ~2× slower (TJ 5:38 PM)
export const STRING_VIS_HZ_MAX = 5;
// Full-figure fractions (head=0 … toe=1). String spans root→crown only.
export const STRING_CROWN_S = 0.05;
export const STRING_ROOT_S = 0.54;
export const STRING_HEART_S = 0.32;
// Tint strength for per-dancer hue on top of the fixed chakra order (0..1).
export const STRING_TINT_MIX = 0.10;

export function bandMode(band) {
  const b = ((band | 0) % 4 + 4) % 4;
  // Kick 1, bass 2, snare 3, hat 5 — higher bands shimmer with more nodes.
  return [1, 2, 3, 5][b];
}

export function bandVisHz(band) {
  const hz = BAND_CENTER_HZ[((band | 0) % 4 + 4) % 4] || 80;
  // Cap so hats/snares never shimmer faster than a readable wave.
  return Math.max(0.5, Math.min(STRING_VIS_HZ_MAX, hz * STRING_VIS_RATE));
}

// RMS of time-domain samples in 0..1.
export function sampleLevel(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const v = +samples[i] || 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (!Number.isFinite(rms)) return 0;
  return Math.max(0, Math.min(1, rms * 4));
}

export function stringAmplitude(level, envelope) {
  const e = Math.max(0, Math.min(1, +envelope || 0));
  const a = Math.max(0, Math.min(1, +level || 0));
  // Quiet floor still shows a faint shimmer; onsets swell it.
  return STRING_REST_AMP + (STRING_MAX_AMP - STRING_REST_AMP) * Math.max(a, e * 0.55);
}

function cleanPoints(points, max = 128) {
  if (!points || points.length < 3) return null;
  const out = [];
  for (const p of points) {
    if (!p) continue;
    const x = +p.x;
    const y = +p.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({x, y});
    if (out.length >= max) break;
  }
  return out.length >= 3 ? out : null;
}

function centroid(points) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return {x: sx / n, y: sy / n};
  }
  return {x: cx / (3 * a), y: cy / (3 * a)};
}

// Head (min y) to toe (max y) through the silhouette's area center.
export function stringAxis(points) {
  const clean = cleanPoints(points, 128);
  if (!clean) return null;
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of clean) {
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  if (!(bottom > top)) return null;
  const c = centroid(clean);
  return {x: c.x, top, bottom, height: bottom - top};
}

// Standing wave on the root→crown span only.
// s = 0 at root (groin), s = 1 at crown (head). Wave travels up the figure.
// TJ 6:34 PM: "off-resonance, light nodes" (side-sim node weight at the
// light end, 0.28): the string is a smooth traveling sine moving root→crown,
// with almost no pinning at the chakra beads, at any tempo.
export const STRING_NODE_WEIGHT = 0.28;
export const STRING_STIFFNESS = 0.72;
export const STRING_TRAVEL_K = 2.15;
const PIN_SIG = 0.022;
export function nodePin(s, weight = STRING_NODE_WEIGHT) {
  const massPin = 1 - 1 / (1 + 0.85 * Math.max(0.05, +weight || 0));
  let pin = 1;
  for (const c of CHAKRA_S) {
    const d = s - c.s;
    pin *= 1 - STRING_STIFFNESS * massPin * Math.exp(-(d * d) / (2 * PIN_SIG * PIN_SIG));
  }
  return pin;
}

// ---- Side-sim pulse string (TJ 6:55 PM) ----
// Foot strikes travel up the leg (32% of 0.88 s), then up the string root→
// crown (68%). Behind the upward front the string carries a traveling sine
// (k = 2.15, drive hz = half the step rate, capped 1.25 Hz) that decays at
// 1.15/s, scaled by the light-node pin. Same math as stringPolyline/travelAt.
export const PULSE_K = 2.15;
export const PULSE_FULL_S = 0.88;
export const PULSE_LEG_SHARE = 0.32;
export const PULSE_DECAY = 1.15;
export const PULSE_FRONT_SHARP = 14;
export const PULSE_AMP_FRAC = 0.075; // drive stays expressive; lateral/tangent caps keep the visible bow subtle
// Peak lateral swing is a subtle in-torso shimmer, not a second spine. The
// neck/crown taper still keeps the wave inside the head.
export const STRING_MAX_LATERAL_FRAC = 0.040;
export const STRING_NECK_TAPER = 0.35;
export const STRING_MAX_TANGENT_DEG = 8; // successive-segment cap so the string is a subtle bow, not a zigzag
export function stringLateralProfile(s) {
  // Full d634f3a amplitude through the torso. Drop quickly from the mid-chest
  // so the neck/head (where the body half-width shrinks to ~0.045 H) stays
  // inside the volume — the #94 spine-outside-body fix, without a 12° cap.
  const u = Math.max(0, Math.min(1, +s || 0));
  if (u <= 0.5) return 1;
  if (u <= 0.6) return 1 - 0.6 * ((u - 0.5) / 0.1);
  return 0.4 - (0.4 - STRING_NECK_TAPER) * ((u - 0.6) / 0.4);
}

// Head silhouette: the posed head ellipse, plus a short cap above for the crown
// (which sits just over the vault). Used to stop string / pulse / skull strokes
// from poking out the sides of the head like hair.
export function headSilhouetteRadius(pose, y) {
  if (!pose || !pose.head) return 0;
  const hx = pose.head.x, hy = pose.head.y;
  const rx = Math.max(1, pose.headRx || (pose.headR || 0) * 0.86 || 8);
  const ry = Math.max(1, pose.headR || rx);
  const dy = (y == null ? hy : y) - hy;
  if (dy < -ry) {
    const above = -dy - ry;
    const cap = ry * 0.28;
    if (above > cap) return 0;
    return rx * 0.28 * (1 - above / cap);
  }
  if (dy > ry * 1.08) return -1;
  const t = 1 - (dy * dy) / (ry * ry);
  return t > 0 ? rx * Math.sqrt(t) : 0;
}

export function pointInHeadSilhouette(p, pose, pad = 0.5) {
  if (!p || !pose || !pose.head) return true;
  const allow = headSilhouetteRadius(pose, p.y);
  if (allow < 0) return true;
  return Math.abs(p.x - pose.head.x) <= allow + pad;
}

export function clampToHeadSilhouette(p, pose, pad = 0.5) {
  if (!p || !pose || !pose.head) return p;
  const allow = headSilhouetteRadius(pose, p.y);
  if (allow < 0) return p;
  const lim = Math.max(0, allow - pad);
  const dx = p.x - pose.head.x;
  if (Math.abs(dx) <= lim) return p;
  return { ...p, x: pose.head.x + Math.sign(dx || 1) * lim };
}

export function confineStringToHead(pts, pose, pad = 0.5) {
  if (!pts || !pose) return pts;
  for (let i = 0; i < pts.length; i++) pts[i] = clampToHeadSilhouette(pts[i], pose, pad);
  return pts;
}

// Live variant: the same head silhouette, but each correction is carried
// down the string with a decay so the string bends into the head gradually
// instead of kinking at the first clamped point (spine-replay bend gate).
export function confineStringToHeadSoft(pts, pose, pad = 0.5, decay = 0.85) {
  if (!pts || !pts.length || !pose || !pose.head) return pts;
  const n = pts.length;
  const need = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = clampToHeadSilhouette(pts[i], pose, pad);
    need[i] = c.x - pts[i].x;
  }
  // Points run root → crown; spread corrections both ways along the string.
  const corr = need.slice();
  for (let i = n - 2; i >= 0; i--) if (Math.abs(corr[i + 1] * decay) > Math.abs(corr[i])) corr[i] = corr[i + 1] * decay;
  for (let i = 1; i < n; i++) if (Math.abs(corr[i - 1] * decay) > Math.abs(corr[i])) corr[i] = corr[i - 1] * decay;
  for (let i = 0; i < n; i++) {
    const own = need[i];
    const c = own && Math.sign(own) !== Math.sign(corr[i]) ? own : corr[i];
    if (c) pts[i] = {...pts[i], x: pts[i].x + c};
    pts[i] = clampToHeadSilhouette(pts[i], pose, pad);
  }
  return pts;
}
export const PULSE_REST_FRAC = 0.22; // faint resting traveling sine between strikes
export function pulseTravelTimes(speed = 1) {
  const full = PULSE_FULL_S / Math.max(0.25, +speed || 1);
  return {full, leg: full * PULSE_LEG_SHARE, str: full * (1 - PULSE_LEG_SHARE)};
}
export function pulseDriveHz(stepHz) {
  return Math.min(Math.min(2, Math.max(0.05, +stepHz || 1)) * 0.5, 1.25);
}
// Energy 0..1 at the strike sets that pulse's amplitude.
export function pulseEnergyGain(energy) {
  return 0.45 + 0.85 * Math.max(0, Math.min(1, +energy || 0));
}
// Travelling excitation of one strike at node s: front gate × decay (0..1).
export function pulseEnvelopeAt(s, tSec, strike, times = pulseTravelTimes()) {
  const age = tSec - strike.t0 - times.leg;
  if (age < -0.05) return 0;
  const front = age / Math.max(0.08, times.str);
  return (1 / (1 + Math.exp(-(front - s) * PULSE_FRONT_SHARP))) * Math.exp(-Math.max(0, age) * PULSE_DECAY);
}
export function pulseWaveAt(s, tSec, strikes, options = {}) {
  if (!strikes || !strikes.length) return 0;
  const amp = +options.amp || 0;
  const hz = Number.isFinite(+options.hz) ? +options.hz : 0.9;
  const {leg, str} = options.times || pulseTravelTimes();
  const pin = nodePin(s, options.nodeWeight);
  let x = 0;
  for (const st of strikes) {
    const age = tSec - st.t0 - leg; // time since the pulse reached the root
    if (age < -0.05) continue;
    const front = age / Math.max(0.08, str);
    const excited = 1 / (1 + Math.exp(-(front - s) * PULSE_FRONT_SHARP));
    const decay = Math.exp(-Math.max(0, age) * PULSE_DECAY);
    const wave = Math.sin(2 * Math.PI * (PULSE_K * s - hz * Math.max(0, age)));
    x += (st.side < 0 ? -1 : 1) * amp * pulseEnergyGain(st.energy) * 0.85 * wave * excited * decay;
  }
  // Overlapping strikes saturate softly instead of stacking into a zigzag.
  const cap = amp * 1.2;
  return cap > 0 ? cap * Math.tanh(x / cap) * pin : 0;
}

// RMS / peak of the string wave at the seven chakras, in units of `amp`
// (side-sim activationOf). Arms read this through armLiftAmount.
export function stringActivation(tSec, strikes, options = {}) {
  const amp = Math.max(1e-6, +options.amp || 0);
  if (!strikes || !strikes.length || !(amp > 0)) return 0;
  let sum2 = 0, peak = 0, n = 0;
  for (const c of CHAKRA_S) {
    const a = Math.abs(pulseWaveAt(c.s, tSec, strikes, options) / amp);
    if (!Number.isFinite(a)) continue;
    sum2 += a * a;
    peak = Math.max(peak, a);
    n++;
  }
  if (!n) return 0;
  return 0.65 * Math.sqrt(sum2 / n) + 0.35 * peak;
}

// Position of the newest pulse: {phase:'leg', u} on the leg, {phase:'string', s}
// on the string, or null once it has passed the crown.
export function pulseFront(strikes, tSec, times = pulseTravelTimes()) {
  if (!strikes || !strikes.length) return null;
  let newest = null;
  for (const st of strikes) if (st.t0 <= tSec && (!newest || st.t0 > newest.t0)) newest = st;
  if (!newest) return null;
  const age = tSec - newest.t0;
  if (age < times.leg) return {phase: 'leg', u: age / times.leg, age, strike: newest};
  const sFront = (age - times.leg) / times.str;
  if (sFront <= 1) return {phase: 'string', s: sFront, age, strike: newest};
  return {phase: 'done', s: 1, age, strike: newest};
}
export function limitStringTangent(pts, maxDeg = STRING_MAX_TANGENT_DEG) {
  if (!pts || pts.length < 2) return pts;
  const maxA = (Number.isFinite(+maxDeg) ? +maxDeg : STRING_MAX_TANGENT_DEG) * Math.PI / 180;
  const out = pts.map(p => ({...p}));
  for (let i = 1; i < out.length; i++) {
    const dy = out[i].y - out[i - 1].y;
    const dx = out[i].x - out[i - 1].x;
    const ang = Math.atan2(dx, -dy || 1e-9); // string runs up (y decreases)
    if (Math.abs(ang) > maxA) {
      const signed = Math.sign(ang) * maxA;
      out[i].x = out[i - 1].x + Math.tan(signed) * Math.abs(dy);
    }
  }
  return out;
}
export function pulseStringPoints(axis, options = {}) {

  if (!axis || !(axis.height > 0)) return null;
  const n = Math.max(8, options.segments | 0 || STRING_SEGMENTS);
  const crownY = axis.top + axis.height * STRING_CROWN_S;
  const rootY = axis.top + axis.height * STRING_ROOT_S;
  if (!(rootY > crownY)) return null;
  const tSec = (+options.now || 0) / 1000;
  const amp = +options.amp || 0;
  const rest = Number.isFinite(+options.rest) ? +options.rest : amp * PULSE_REST_FRAC;
  const phase = +options.phase || 0;
  const times = options.times || pulseTravelTimes();
  // axis.height spans ~the figure (groin→crown is 0.49 of it).
  const limit = Number.isFinite(+options.maxLateral) ? +options.maxLateral : STRING_MAX_LATERAL_FRAC * axis.height;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const y = rootY + (crownY - rootY) * s;
    const restWave = rest * Math.sin(2 * Math.PI * PULSE_K * s - phase) * nodePin(s, options.nodeWeight);
    const d = restWave + pulseWaveAt(s, tSec, options.strikes, {amp, hz: options.hz, times, nodeWeight: options.nodeWeight});
    const lim = limit * stringLateralProfile(s);
    out.push({x: axis.x + (lim > 0 ? lim * Math.tanh(d / lim) : d), y, s});
  }
  return limitStringTangent(out);
}

export function stringPoints(axis, options = {}) {
  if (!axis || !(axis.height > 0)) return null;
  const band = options.band | 0;
  const now = +options.now || 0;
  const amp = Number.isFinite(+options.amplitude) ? +options.amplitude : STRING_REST_AMP;
  const mode = options.mode != null ? Math.max(1, options.mode | 0) : bandMode(band);
  const freq = options.freq != null ? +options.freq : bandVisHz(band);
  const n = Math.max(8, options.segments | 0 || STRING_SEGMENTS);
  // Prefer an explicit beat-locked phase (one cycle per foot-strike).
  const phase = Number.isFinite(+options.phase)
    ? +options.phase
    : 2 * Math.PI * freq * (now / 1000);
  const cos = Math.cos(phase);
  const crownY = axis.top + axis.height * STRING_CROWN_S;
  const rootY = axis.top + axis.height * STRING_ROOT_S;
  if (!(rootY > crownY)) return null;
  const out = [];
  if (options.travel) {
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const y = rootY + (crownY - rootY) * s;
      const wave = Math.sin(2 * Math.PI * STRING_TRAVEL_K * s - phase) * nodePin(s, options.nodeWeight);
      out.push({x: axis.x + amp * 0.85 * wave, y, s});
    }
    return out;
  }
  for (let i = 0; i <= n; i++) {
    const s = i / n; // 0 root → 1 crown
    const y = rootY + (crownY - rootY) * s;
    const stand = Math.sin(mode * Math.PI * s) * cos;
    out.push({x: axis.x + amp * stand, y, s});
  }
  return out;
}

// Parse a css color into hue degrees, or null.
export function parseHueDegrees(color) {
  if (typeof color !== 'string' || !color) return null;
  const hsl = color.match(/hsl\(\s*([+-]?\d*\.?\d+)/i);
  if (hsl) return ((+hsl[1] % 360) + 360) % 360;
  // rgb()/rgba() too: dancerHueCss returns rgb(), which used to parse to
  // null and silently drop the per-dancer tint (TJ 11:10 AM).
  const rgbM = color.match(/rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i);
  const hex = rgbM ? null : color.match(/^#([0-9a-f]{6})$/i);
  if (!rgbM && !hex) return null;
  const n = hex ? parseInt(hex[1], 16) : 0;
  const r = rgbM ? Math.min(255, +rgbM[1]) / 255 : ((n >> 16) & 255) / 255;
  const g = rgbM ? Math.min(255, +rgbM[2]) / 255 : ((n >> 8) & 255) / 255;
  const b = rgbM ? Math.min(255, +rgbM[3]) / 255 : (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h * 360;
}

// Fixed chakra order along the string: s=0 root red → s=1 crown violet.
// Optional per-dancer tint mixes lightly without reordering (TJ 5:02 PM).
export function hueAt(s, tint = null, tintMix = STRING_TINT_MIX) {
  const u = Math.max(0, Math.min(1, +s || 0));
  // red(0) → orange → yellow → green(heart≈0.45) → blue → indigo → violet(275)
  let h = u * 275;
  const th = parseHueDegrees(tint);
  if (th != null) {
    // Uniform shift from mid-string hue — same delta everywhere. Clamp to the
    // chakra span (no hue wrap) so root→crown order can never flip.
    const mid = 137.5;
    let d = ((th - mid + 540) % 360) - 180;
    d = Math.max(-40, Math.min(40, d));
    const k = Number.isFinite(+tintMix) ? Math.max(0, Math.min(1, +tintMix)) : STRING_TINT_MIX;
    h = Math.max(0, Math.min(275, h + d * k));
  }
  return 'hsl(' + h.toFixed(1) + ' 95% 62%)';
}

export function paintVibratingString(ctx, points, options = {}) {
  if (!ctx || !points || points.length < 2) return false;
  const width = Number.isFinite(+options.width) ? +options.width : STRING_LINE_WIDTH;
  const glow = Number.isFinite(+options.glowWidth) ? +options.glowWidth : STRING_GLOW_WIDTH;
  const alpha = Number.isFinite(+options.alpha) ? +options.alpha : 0.98;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  // Soft glow pass, then a brighter rainbow core.
  const glowAlpha = Number.isFinite(+options.glowAlpha) ? +options.glowAlpha : 1;
  const coreAlpha = Number.isFinite(+options.coreAlpha) ? Math.max(0, Math.min(1, +options.coreAlpha)) : Math.min(1, alpha * 0.85);
  // Optional dark underlay so a fine line still reads over bright ripples.
  if (Number.isFinite(+options.underlay) && +options.underlay > 0) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, +options.underlay);
    ctx.strokeStyle = 'rgb(6, 8, 14)';
    ctx.lineWidth = width + 1.4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'lighter';
  // Bloom 0 → no glow pass at all, just the crisp core (TJ 11:22 AM).
  for (let pass = (glow > 0 && glowAlpha > 0) ? 0 : 1; pass < 2; pass++) {
    const fat = pass === 0;
    ctx.globalAlpha = fat ? Math.min(1, alpha * 0.28 * glowAlpha) : coreAlpha;
    ctx.lineWidth = fat ? glow : width;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const vis = pulseVisibility(hueAt((a.s + b.s) * 0.5, options.hue || null, options.tintMix));
      ctx.beginPath();
      ctx.strokeStyle = vis.css;
      ctx.globalAlpha = fat ? Math.min(1, alpha * 0.28 * glowAlpha) : Math.min(1, coreAlpha * vis.alphaScale);
      ctx.lineWidth = fat ? glow : width * vis.trailScale;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.restore();
  return true;
}


// Nodes on the root→crown string (s=0 root … s=1 crown).
// Heart sits ~mid-chest on the shortened span (TJ 5:02 PM).
// Seven chakras root→crown (TJ t2563u; side-sim positions). Colors come
// from hueAt(s): red, orange, yellow, green, blue, indigo, violet.
export const CHAKRA_S = [
  {id: 'root', s: 0, color: null},
  {id: 'sacral', s: 0.135, color: null},
  {id: 'solar', s: 0.281, color: null},
  {id: 'heart', s: 0.417, color: null},
  {id: 'throat', s: 0.781, color: null},
  {id: 'thirdEye', s: 0.917, color: null},
  {id: 'crown', s: 1, color: null}
];
export const CHAKRA_BASE_R = 3.2;
export const CHAKRA_PULSE_R = 2.4;
export const CHAKRA_GLOW_DIM = 0.65; // ~35% dimmer nodes (TJ 5:38 PM)

function sampleStringAt(points, s) {
  if (!points || points.length < 2) return null;
  const t = Math.max(0, Math.min(1, +s || 0));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.s || i === points.length - 1) {
      const span = (b.s - a.s) || 1e-6;
      const u = Math.max(0, Math.min(1, (t - a.s) / span));
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        s: t
      };
    }
  }
  const last = points[points.length - 1];
  return {x: last.x, y: last.y, s: t};
}

// Points ride the string displacement; brightness/size follow the beat envelope.
export function chakraPoints(points, options = {}) {
  if (!points || points.length < 2) return [];
  const env = Math.max(0, Math.min(1, +options.envelope || 0));
  const level = Math.max(0, Math.min(1, +options.level || 0));
  const pulse = Math.max(env, level * 0.65);
  // Fixed chakra hues; per-dancer hue is only a subtle tint (never reorders).
  const tint = typeof options.hue === 'string' && options.hue ? options.hue : null;
  // Optional foot-strike travel along the string (0 at root … 1 at crown).
  const travelS = Number.isFinite(+options.travelS) ? +options.travelS : -1;
  const travelGain = Math.max(0, Math.min(2.5, +options.travelGain || 1.6));
  const travelWidth = Math.max(0.08, Math.min(0.5, +options.travelWidth || 0.22));
  const out = [];
  for (const spec of CHAKRA_S) {
    const at = sampleStringAt(points, spec.s);
    if (!at) continue;
    let boost = 0;
    if (travelS >= 0) {
      const d = Math.abs(spec.s - travelS);
      boost = Math.max(0, 1 - d / travelWidth);
      boost = boost * boost; // soft peak
    }
    const p = Math.min(1.4, pulse + boost * travelGain * 0.55);
    out.push({
      id: spec.id,
      x: at.x,
      y: at.y,
      s: spec.s,
      color: hueAt(spec.s, tint, options.tintMix),
      radius: CHAKRA_BASE_R + CHAKRA_PULSE_R * p,
      alpha: Math.min(1, 0.45 + 0.5 * p + boost * 0.35)
    });
  }
  return out;
}

export function paintChakraLights(ctx, lights, options = {}) {
  if (!ctx || !lights || !lights.length) return false;
  // Tests / stub canvases may omit arc — skip paint rather than throw.
  if (typeof ctx.arc !== 'function' || typeof ctx.beginPath !== 'function') return false;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const light of lights) {
    if (!light || !Number.isFinite(+light.x) || !Number.isFinite(+light.y)) continue;
    // pointScale shrinks the nodes for small projections (TJ 11:22 AM);
    // aura (0 = none … ~1.5) is the bloom-driven halo around each node.
    const ps = Number.isFinite(+options.pointScale) ? Math.max(0.1, +options.pointScale) : 1;
    const minR = Number.isFinite(+options.pointMin) ? +options.pointMin : 1.2;
    const r = Math.max(minR, (+light.radius || CHAKRA_BASE_R) * 0.8 * ps); // 7 nodes: a touch smaller
    const a = Math.max(0.2, Math.min(1, +light.alpha || 0.7));
    const dim = Number.isFinite(+options.dim) ? Math.max(0, Math.min(1, +options.dim)) : 1;
    const aura = Number.isFinite(+options.aura) ? Math.max(0, Math.min(1.5, +options.aura)) : 1;
    const vis = pulseVisibility(light.color || '#fff');
    ctx.fillStyle = vis.css;
    if (aura > 0) {
      // Tight halo: radius grows a little with bloom, alpha follows it.
      const auraR = Number.isFinite(+options.aura) ? r * (1.35 + 0.45 * aura) : r * 2.1;
      ctx.globalAlpha = Math.min(1, a * 0.35 * CHAKRA_GLOW_DIM * dim * Math.min(1, aura) * vis.alphaScale);
      ctx.beginPath();
      ctx.arc(light.x, light.y, auraR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = Math.min(1, a * CHAKRA_GLOW_DIM * dim * vis.alphaScale);
    ctx.beginPath();
    ctx.arc(light.x, light.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return true;
}

// Build and paint in one step from a silhouette contour.
export function drawDancerString(ctx, contour, options = {}) {
  const axis = stringAxis(contour);
  if (!axis) return false;
  const level = sampleLevel(options.samples);
  const amp = stringAmplitude(level, options.envelope);
  const points = Array.isArray(options.strikes) ? pulseStringPoints(axis, {
    now: options.now,
    amp: options.pulseAmp,
    hz: options.pulseHz,
    phase: options.phase,
    strikes: options.strikes,
    segments: options.segments,
    nodeWeight: options.nodeWeight
  }) : stringPoints(axis, {
    band: options.band,
    now: options.now,
    amplitude: amp,
    mode: options.mode,
    freq: options.freq,
    phase: options.phase,
    segments: options.segments,
    travel: options.travel === true,
    nodeWeight: options.nodeWeight
  });
  if (!points) return false;
  const pointsCapped = options.limit === false ? points : limitStringTangent(points, options.maxTangentDeg);
  const mapped = typeof options.xy === 'function'
    ? pointsCapped.map(p => {
      const q = options.xy(p.x, p.y);
      return {x: q.x, y: q.y, s: p.s};
    })
    : pointsCapped;
  // Head confine (side sim #100): no hair-like strokes out the sides of the head.
  if (options.head && options.head.head) confineStringToHeadSoft(mapped, options.head, Math.max(0.8, (+options.head.height || 200) * 0.003));
  // Stage space only. Ease the bow's offset from its end-to-end line so a
  // one-frame wave step cannot kink it, while the line still follows the body.
  const ease = options.stringEase;
  if (ease && mapped.length > 2) {
    const n = mapped.length;
    const x0 = mapped[0].x, x1 = mapped[n - 1].x;
    const denom = n - 1;
    let prev = ease.stringDev;
    if (!prev || prev.length !== n) prev = ease.stringDev = new Float64Array(n);
    const cap = 0.1;
    const primed = ease.stringDevReady === true;
    for (let i = 0; i < n; i++) {
      let dev = mapped[i].x - (x0 + (x1 - x0) * (i / denom));
      if (primed) {
        const d = dev - prev[i];
        if (d > cap) dev = prev[i] + cap;
        else if (d < -cap) dev = prev[i] - cap;
        mapped[i].x = x0 + (x1 - x0) * (i / denom) + dev;
      }
      prev[i] = dev;
    }
    ease.stringDevReady = true;
  }
  if (Array.isArray(options.collect)) options.collect.push({axis, points: mapped});
  const ok = paintVibratingString(ctx, mapped, options);
  // Crown / heart / root ride the string and pulse with the beat.
  const lights = chakraPoints(mapped, {
    envelope: options.envelope,
    level,
    hue: options.hue || null,
    tintMix: options.tintMix,
    travelS: options.travelS,
    travelGain: options.travelGain,
    travelWidth: options.travelWidth
  });
  if (lights.length) paintChakraLights(ctx, lights, options);
  return ok;
}
