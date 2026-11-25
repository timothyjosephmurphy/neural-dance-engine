// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Band-family dancer hues (TJ 5:39 PM).
// bass (kick+bass): warm red/orange; mid (snare): green/yellow; high (hat): blue/violet.
// Small per-id variation stays inside the family. The chakra string keeps its
// own red→violet order; this is for tint, ripples, and inner glow only.

export const BAND_HUE_FAMILY = [
  {id: 'bass', center: 16, span: 26},  // kick — red → red-orange
  {id: 'bass', center: 32, span: 24},  // bass — orange
  {id: 'mid',  center: 92, span: 36},  // snare — yellow → green
  {id: 'high', center: 252, span: 40}  // hat — blue → violet
];

function hash01(id, salt = 0) {
  let x = ((Math.abs(id | 0) + 1) ^ (salt * 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0;
  return x / 4294967296;
}

export function bandFamily(band) {
  return BAND_HUE_FAMILY[((band | 0) % 4 + 4) % 4];
}

// Hue spread also widens / narrows the per-dancer hue jitter inside each
// band family (TJ 11:10 AM: the slider "doesn't seem to be changing the
// colors"). Default 0.40 keeps the original span; 0 collapses every dancer
// to the family center; 1 is 2.5x the span (still inside the family).
export function hueJitterScale(spread) {
  const s = Number.isFinite(+spread) ? Math.max(0, Math.min(1, +spread)) : HUE_SPREAD_DEFAULT;
  return s / HUE_SPREAD_REF;
}

export function dancerHueSpec(id, band, spread = HUE_SPREAD_REF) {
  const fam = bandFamily(band);
  const a = hash01(id, 1);
  const b = hash01(id, 2);
  const c = hash01(id, 3);
  const span = fam.span * hueJitterScale(spread);
  const hue = ((fam.center + (a - 0.5) * span) % 360 + 360) % 360;
  const sat = 0.78 + b * 0.16;
  const light = 0.50 + c * 0.10;
  return {hue, sat, light, family: fam.id, css: 'hsl(' + hue.toFixed(1) + ' ' + Math.round(sat * 100) + '% ' + Math.round(light * 100) + '%)'};
}

export function hslToRgb(h, s, l) {
  const sat = Math.max(0, Math.min(1, s));
  const lit = Math.max(0, Math.min(1, l));
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  const m = lit - c / 2;
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return {r: r + m, g: g + m, b: b + m};
}

export function dancerHueRgb(id, band, spread = HUE_SPREAD_REF) {
  const spec = dancerHueSpec(id, band, spread);
  return hslToRgb(spec.hue, spec.sat, spec.light);
}

// TJ 7:31 PM: shift dancer (label / string / glow) hues toward white,
// keeping each band family recognizable. Ripple hits still use dancerHueRgb.
// Hue spread (TJ 7:39 PM): 0 = all near-white same tint, 1 = full individual
// colors. Default 0.40 → 60% mix toward white.
// HUE_SPREAD_REF is the fixed visual anchor (original jitter span and
// full-color ripples); the DEFAULT slider value is 0.10 (TJ 11:31 AM).
export const HUE_SPREAD_REF = 0.40;
export const HUE_SPREAD_DEFAULT = 0.10;
export const HUE_WHITE_MIX = 0.60; // 1 - HUE_SPREAD_REF (legacy label/glow mix)
export function whiteMixFromSpread(spread = HUE_SPREAD_DEFAULT) {
  const s = Math.max(0, Math.min(1, Number.isFinite(+spread) ? +spread : HUE_SPREAD_DEFAULT));
  return 1 - s;
}
export function mixTowardWhite(rgb, mix = HUE_WHITE_MIX) {
  const t = Math.max(0, Math.min(1, Number.isFinite(+mix) ? +mix : HUE_WHITE_MIX));
  const r = +rgb.r || 0, g = +rgb.g || 0, b = +rgb.b || 0;
  return {r: r + (1 - r) * t, g: g + (1 - g) * t, b: b + (1 - b) * t};
}
export function rgbCss(rgb, alpha) {
  const R = Math.round(Math.max(0, Math.min(1, +rgb.r || 0)) * 255);
  const G = Math.round(Math.max(0, Math.min(1, +rgb.g || 0)) * 255);
  const B = Math.round(Math.max(0, Math.min(1, +rgb.b || 0)) * 255);
  if (alpha == null || !(+alpha < 1)) return 'rgb(' + R + ', ' + G + ', ' + B + ')';
  return 'rgba(' + R + ', ' + G + ', ' + B + ', ' + Math.max(0, Math.min(1, +alpha)) + ')';
}
export function dancerHueDisplayRgb(id, band, mix = HUE_WHITE_MIX, spread = HUE_SPREAD_REF) {
  return mixTowardWhite(dancerHueRgb(id, band, spread), mix);
}
export function dancerHueCss(id, band, spread = HUE_SPREAD_DEFAULT) {
  return rgbCss(dancerHueDisplayRgb(id, band, whiteMixFromSpread(spread), spread));
}
// Ripple / water color for a dancer. Default spread (0.40) is the original
// full-color ripple; lower spread washes toward white (0 = near-white, same
// family tint), higher spread widens the hue jitter. Read every frame, so the
// slider changes ripples live.
export const RIPPLE_WHITE_MAX = 0.80;
export function rippleWhiteMix(spread = HUE_SPREAD_DEFAULT) {
  const s = Number.isFinite(+spread) ? Math.max(0, Math.min(1, +spread)) : HUE_SPREAD_DEFAULT;
  return Math.max(0, (HUE_SPREAD_REF - s) / HUE_SPREAD_REF) * RIPPLE_WHITE_MAX;
}
export function dancerRippleRgb(id, band, spread = HUE_SPREAD_DEFAULT) {
  return mixTowardWhite(dancerHueRgb(id, band, spread), rippleWhiteMix(spread));
}
// Chakra-string tint strength: 0 at spread 0 (pure chakra order), 0.2 at the
// default, 0.5 at max. hueAt clamps the shift so root→crown never reorders.
export function stringTintMix(spread = HUE_SPREAD_DEFAULT) {
  const s = Number.isFinite(+spread) ? Math.max(0, Math.min(1, +spread)) : HUE_SPREAD_DEFAULT;
  return 0.5 * s;
}
