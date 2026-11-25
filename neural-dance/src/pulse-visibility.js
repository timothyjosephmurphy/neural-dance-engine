// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Projector luminance compensation for dim red and green pulses (TJ Nov 10).
// Red and green read dim when projected small. Lift red toward a brighter
// red-orange and green toward a brighter, more saturated green so they
// match yellow/gold visibility. Apply only at paint time — stored pulse
// colors and hueAt() strings stay unchanged so chakra mapping is stable.
// Glow still scales with bloom; bloom 0 still means no glow pass.

import {hslToRgb, rgbCss} from './dancer-hue.js';

// Live gold / bass pulse — the visibility target red and green should match.
export const GOLD_PULSE = '#ffd166';

export function relativeLuminance(rgb) {
  const r = +rgb.r || 0, g = +rgb.g || 0, b = +rgb.b || 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function parseCssRgb(color) {
  if (typeof color !== 'string' || !color) return null;
  const s = color.trim();
  const hsl = s.match(/^hsla?\(\s*([+-]?\d*\.?\d+)(?:deg)?[\s,]+(\d*\.?\d+)%[\s,]+(\d*\.?\d+)%/i);
  if (hsl) return hslToRgb(+hsl[1], +hsl[2] / 100, +hsl[3] / 100);
  const rgb = s.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i);
  if (rgb) return {r: Math.min(255, +rgb[1]) / 255, g: Math.min(255, +rgb[2]) / 255, b: Math.min(255, +rgb[3]) / 255};
  const hex6 = s.match(/^#([0-9a-f]{6})$/i);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
  }
  const hex3 = s.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const h = hex3[1];
    return {r: parseInt(h[0] + h[0], 16) / 255, g: parseInt(h[1] + h[1], 16) / 255, b: parseInt(h[2] + h[2], 16) / 255};
  }
  return null;
}

export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return {h: 0, s: 0, l};
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return {h: h * 360, s, l};
}

// Red / reddish-orange (kick, root, leg energy) and green (mid, heart, arm).
// Tight windows so sacral orange, gold, and throat blue stay untouched.
export function isRedPulseHue(h) {
  const hue = ((h % 360) + 360) % 360;
  return hue <= 22 || hue >= 345;
}
export function isGreenPulseHue(h) {
  const hue = ((h % 360) + 360) % 360;
  return hue >= 90 && hue <= 155;
}
export function isDimProjectorHue(h) {
  return isRedPulseHue(h) || isGreenPulseHue(h);
}

function shortestHueDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

export function compensatePulseRgb(rgb) {
  if (!rgb) return rgb;
  const hsl = rgbToHsl(+rgb.r || 0, +rgb.g || 0, +rgb.b || 0);
  if (isRedPulseHue(hsl.h)) {
    // Brighter red-orange: shift toward hue 18, lift lightness, keep sat high.
    hsl.h = (hsl.h + shortestHueDelta(hsl.h, 18) * 0.7 + 360) % 360;
    hsl.s = Math.max(hsl.s, 0.96);
    hsl.l = Math.max(hsl.l, 0.70);
    let out = hslToRgb(hsl.h, hsl.s, hsl.l);
    if (relativeLuminance(out) < 0.70 && hsl.l < 0.76) {
      hsl.l = 0.76;
      out = hslToRgb(hsl.h, hsl.s, hsl.l);
    }
    return out;
  }
  if (isGreenPulseHue(hsl.h)) {
    // Brighter, more saturated green (a slight yellow-green lean for luminance).
    hsl.h = (hsl.h + shortestHueDelta(hsl.h, 128) * 0.45 + 360) % 360;
    hsl.s = Math.max(hsl.s, 0.98);
    hsl.l = Math.max(hsl.l, 0.66);
    let out = hslToRgb(hsl.h, hsl.s, hsl.l);
    if (relativeLuminance(out) < 0.78 && hsl.l < 0.72) {
      hsl.l = 0.72;
      out = hslToRgb(hsl.h, hsl.s, hsl.l);
    }
    return out;
  }
  return {r: +rgb.r || 0, g: +rgb.g || 0, b: +rgb.b || 0};
}

export function compensatePulseColor(color) {
  const rgb = parseCssRgb(color);
  if (!rgb) return color;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (!isDimProjectorHue(hsl.h)) return color;
  return rgbCss(compensatePulseRgb(rgb));
}

// Per-hue paint scales. Core stays thin (about 2–3 stage px); glow is not
// opened here — callers still skip the glow pass when bloom / glowW is 0.
export function pulseVisibility(color) {
  const src = parseCssRgb(color);
  const hsl = src ? rgbToHsl(src.r, src.g, src.b) : null;
  const dim = !!(hsl && isDimProjectorHue(hsl.h));
  const css = dim ? rgbCss(compensatePulseRgb(src)) : (color || '#fff');
  return {
    css,
    boosted: dim,
    coreScale: dim ? 1.14 : 1,
    trailScale: dim ? 1.22 : 1,
    spanScale: dim ? 1.25 : 1,
    alphaScale: dim ? 1.35 : 1
  };
}
