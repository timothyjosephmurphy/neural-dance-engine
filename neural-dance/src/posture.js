// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Stand-tall posture.
// Default stance is tall: a soft, nearly straight knee, feet at hip width.
// The only squat is bowstring tension (#876). Arms rest low to mid. They
// rise when the music is high and airy, ease down when it is bass-heavy,
// and take a brief extra lift on a drop.
// The live page does not apply this unless standTall=1 is in the URL.
// The side sim applies it by default and can switch it off.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const ARM_REST = 0.28;     // low-to-mid hang when the music is quiet
export const ARM_AIR = 0.86;      // high, airy: hands up and floating
export const ARM_TAU = 0.9;       // slow envelope, seconds
export const DROP_LIFT = 0.16;    // brief extra on the drop
export const DROP_TAU = 0.38;
export const KNEE_SOFT = 0.06;    // nearly straight, never locked
export const KNEE_SQUAT = 1;      // full sink at full bowstring tension

export function createPosture() {
  let air = ARM_REST;
  let dropLift = 0;

  function step({dt = 0, high = 0, bass = 0, pad = 0, drop = 0, tension = 0} = {}) {
    const h = clamp(+dt || 0, 0, 0.1);
    const airy = clamp(0.65 * clamp(+high || 0, 0, 1) + 0.35 * clamp(+pad || 0, 0, 1), 0, 1);
    const heavy = clamp(+bass || 0, 0, 1);
    const target = clamp(ARM_REST + (ARM_AIR - ARM_REST) * airy * (1 - 0.82 * heavy), 0.12, 1);
    const k = h > 0 ? 1 - Math.exp(-h / ARM_TAU) : 0;
    air += (target - air) * k;
    if ((+drop || 0) > 0.55) dropLift = Math.max(dropLift, DROP_LIFT);
    if (h > 0) dropLift *= Math.exp(-h / DROP_TAU);
    if (dropLift < 0.01) dropLift = 0;
    const ten = clamp(+tension || 0, 0, 1);
    return {
      armLift: clamp(air + dropLift, 0, 1),
      kneeSink: KNEE_SOFT + (KNEE_SQUAT - KNEE_SOFT) * ten,
      stance: 'hip',
      dropLift,
    };
  }

  function reset() { air = ARM_REST; dropLift = 0; }
  return {step, reset};
}

const mod = {ARM_REST, ARM_AIR, ARM_TAU, DROP_LIFT, KNEE_SOFT, KNEE_SQUAT, createPosture};
export default mod;
