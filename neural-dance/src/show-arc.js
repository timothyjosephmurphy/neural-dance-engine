// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Show-long paint ramp. Pose and dance are untouched.
// t = 0: the shell is fully transparent. The chest sticker and the chakra
// lines stay lit, so a body can still dance in the dark.
// t = 1: the shell has filled in, catches the inner light, and reads as a
// shining rainbow body.
// Live does not call this unless a page opts in. The side sim previews it
// with a scrubber; the hours setting is the clock length of a real show.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };

export const SHOW_HOURS_DEFAULT = 3;
export const SHOW_HOURS_MIN = 0.5;
export const SHOW_HOURS_MAX = 8;
// Shell fill at the end of the arc. Never fully opaque: the chakra column
// still has to read through the body.
export const SHELL_ALPHA_END = 0.78;

export function showHours(hours) {
  const h = +hours;
  if (!(h > 0)) return SHOW_HOURS_DEFAULT;
  return clamp(h, SHOW_HOURS_MIN, SHOW_HOURS_MAX);
}

/** Progress 0..1 from a scrubber or a fraction of the show. */
export function showArcAt(t) {
  const u = smooth(t);
  const rainbow = smooth((u - 0.45) / 0.55);
  return {
    t: u,
    shellAlpha: u * SHELL_ALPHA_END,
    reflect: u,
    rainbow,
    chest: 1,
    chakra: 1,
    // Bodies keep dancing at every t. This object is paint only.
    dances: true,
  };
}

/**
 * @param {number} elapsedSec seconds since the show opened
 * @param {number} durationSec show length (hours × 3600, or any positive seconds)
 */
export function showArc(elapsedSec, durationSec) {
  const dur = Math.max(1, +durationSec || SHOW_HOURS_DEFAULT * 3600);
  const elapsed = Math.max(0, +elapsedSec || 0);
  return showArcAt(elapsed / dur);
}

const mod = {SHOW_HOURS_DEFAULT, SHOW_HOURS_MIN, SHOW_HOURS_MAX, SHELL_ALPHA_END, showHours, showArcAt, showArc};
export default mod;
