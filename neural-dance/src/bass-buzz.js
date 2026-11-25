// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Bass buzz, separate from the bass beat.
// A beat is a short spike that falls back to the floor. A buzz is bass that
// stays up and vibrates: the slow envelope holds, and a fast wiggle rides
// on it. The buzz drives a small hip shimmy (not the figure-8) and winds a
// bowstring through the leg arc. A drop lets that tension go as a short
// standing-wave burst.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const BUZZ_FLOOR = 0.28;       // slow envelope must hold above this
export const BUZZ_HOLD = 0.32;        // seconds of held bass before it counts
export const BUZZ_TEXTURE = 0.045;    // fast-wiggle size that reads as a buzz
export const TENSION_RISE = 0.55;     // seconds to wind from 0 to 1 at full buzz
export const TENSION_FALL = 1.1;      // seconds to unwind when the buzz stops
export const BURST_FALL = 0.42;       // standing-wave burst after the drop
export const SHIMMY_HZ = 9.5;

export function createBassBuzz() {
  let tPrev = null;
  let slow = 0;
  let held = 0;
  let buzz = 0;
  let tension = 0;
  let burst = 0;
  let dropPrev = false;
  let shimmyPhase = 0;

  function step({t = 0, bass = 0, drop = false} = {}) {
    const now = +t || 0;
    let dt = tPrev == null ? 0 : now - tPrev;
    if (!(dt >= 0) || dt > 0.5) dt = 0;
    tPrev = now;
    const b = clamp(+bass || 0, 0, 1);
    // Slow envelope: kicks die between hits, a sustained bass does not.
    const tau = b >= slow ? 0.08 : 0.18;
    const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
    slow += (b - slow) * k;
    const texture = Math.abs(b - slow);
    if (slow >= BUZZ_FLOOR && texture >= BUZZ_TEXTURE * 0.35) held += dt;
    else held = Math.max(0, held - dt * 1.5);
    const textureU = clamp((texture - BUZZ_TEXTURE * 0.25) / BUZZ_TEXTURE, 0, 1);
    const sustainU = clamp(held / BUZZ_HOLD, 0, 1);
    const target = (slow >= BUZZ_FLOOR ? textureU : 0) * sustainU;
    const bk = dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1;
    buzz += (target - buzz) * bk;
    if (drop && !dropPrev && tension > 0.05) {
      burst = Math.max(burst, tension);
      tension = 0;
    }
    dropPrev = !!drop;
    if (buzz > 0.2) tension = Math.min(1, tension + dt * buzz / TENSION_RISE);
    else tension = Math.max(0, tension - dt / TENSION_FALL);
    if (dt > 0) burst *= Math.exp(-dt / BURST_FALL);
    if (burst < 0.01) burst = 0;
    shimmyPhase += dt * SHIMMY_HZ;
    return api;
  }

  function state() {
    return {
      buzz,
      tension,
      burst,
      // Shimmy amount is the buzz itself. The figure-8 is a different path.
      shimmy: buzz,
      phase: shimmyPhase,
      slow,
    };
  }

  function reset() {
    tPrev = null;
    slow = 0;
    held = 0;
    buzz = 0;
    tension = 0;
    burst = 0;
    dropPrev = false;
    shimmyPhase = 0;
  }

  const api = {step, state, reset};
  return api;
}

/** A steady vibrating bass bed, for the sim preview and tests. Not a beat. */
export function syntheticBuzz(t, {floor = 0.62, depth = 0.16, hz = 14} = {}) {
  return clamp(floor + depth * Math.sin(2 * Math.PI * hz * (+t || 0)), 0, 1);
}

/** Isolated bass kicks: a spike that is gone before the next hit. */
export function syntheticKicks(t, {period = 0.5, width = 0.04} = {}) {
  const p = Math.max(0.05, period);
  const u = ((+t || 0) % p) / p;
  const w = width / p;
  if (u > w) return 0;
  return Math.sin(Math.PI * u / w);
}

const mod = {BUZZ_FLOOR, BUZZ_HOLD, BUZZ_TEXTURE, SHIMMY_HZ, createBassBuzz, syntheticBuzz, syntheticKicks};
export default mod;
