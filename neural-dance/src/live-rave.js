// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Side-sim → live parity (TJ Nov 11 7:07 PM): the live show runs the same
// rave / club step repertoire (rave-moves.js, PR #97) and the same subtle
// independent head looks (head-look.js, PR #100) as the side simulation.
// This module only turns live inputs (activation, hush, Melody/Pad features,
// the four band levels and the entrained beat) into the drivers the shared
// modules expect, and scales the result by the "Rave moves" amount.

import {layerWeights, phraseState, kinematics, clamp} from './rave-moves.js';
import {headLook} from './head-look.js';
import {RAVE_LOCOMOTOR, FOOTWORK_LABELS, footworkRaveStep} from './footwork-steps.js';

export const RAVE_LIVE_DEFAULT = 1;
const SAG_LIM = 16 * Math.PI / 180;

function num(v, d = 0) { const n = +v; return Number.isFinite(n) ? n : d; }

/** Live music → rave drivers, mirroring the side sim's musicDrivers(). */
export function liveMusicDrivers({activation = 0, hush = 1, padFeatures = null, bandLevels = null, beatPhase = 0, bpm = 120} = {}) {
  const drv = {activation: clamp(num(activation), 0, 1), hush: clamp(num(hush, 1), 0, 1), kick: 0, hats: 0, bass: 0, pads: 0, melody: 0, drop: 0, bpm: num(bpm, 120)};
  const pad = padFeatures && typeof padFeatures === 'object' ? padFeatures : null;
  if (pad) {
    drv.pads = Math.max(0, num(pad.env));
    drv.melody = Math.max(num(pad.note), num(pad.contour)) * 0.7 * (num(pad.env) > 0.02 ? 1 : 0);
    drv.drop = Math.max(0, num(pad.crescendo));
  }
  const lv = Array.isArray(bandLevels) ? bandLevels : null;
  if (lv && lv.some(v => num(v) > 0.01)) {
    drv.kick = clamp(num(lv[0]), 0, 1);
    drv.bass = clamp(num(lv[1]), 0, 1);
    drv.hats = clamp(num(lv[3]), 0, 1);
  } else {
    const kickWave = Math.cos(2 * Math.PI * num(beatPhase));
    drv.kick = Math.max(0, kickWave) * drv.activation;
    drv.hats = Math.max(0, -kickWave) * drv.activation;
    drv.bass = drv.kick * 0.75;
  }
  return drv;
}

function scaleSpine(phi, k) {
  const out = {};
  for (const key of Object.keys(phi || {})) out[key] = clamp(num(phi[key]) * k, -SAG_LIM, SAG_LIM);
  return out;
}
function scaleFoot(f, k) {
  return {contact: k > 0.25 ? f.contact : 'flat', rock: num(f.rock) * k, lift: num(f.lift) * k};
}

/**
 * Per-frame rave layer for one live dancer. amount 0 turns it off (returns
 * null). The planted-foot world position stays with the live anchor system:
 * this only names contacts, rocks, lifts, sagittal spine angles, a hip sway,
 * a contra twist, and the phrase's turn / forward-back step decision.
 */
export function liveRaveLayer({id = 0, tSec = 0, bpm = 120, beat = null, beatPhase = 0, activation = 0, hush = 1,
  padFeatures = null, bandLevels = null, side = -1, weight = 0, amount = RAVE_LIVE_DEFAULT, facing = 0, homeZ = 0, pulseClimb = 0, footworkStep = null} = {}) {
  const k = clamp(num(amount, RAVE_LIVE_DEFAULT), 0, 1.5);
  if (!(k > 0.001)) return null;
  const drv = liveMusicDrivers({activation, hush, padFeatures, bandLevels, beatPhase, bpm});
  const layers = layerWeights(drv);
  const plan = phraseState({tSec, bpm: drv.bpm, seed: (id | 0) * 0.731 + 1, activation: drv.activation, layers, facing, homeX: 0, homeZ, beatIndex: Number.isFinite(+beat) ? (beat | 0) : null});
  // Footwork steps (footwork-steps.js) own the feet when present: the
  // step's articulation comes from the matching rave locomotor, and the
  // phrase's own forward / back travel is off (the step places the feet).
  // The step library publishes the active step (silhouette calls footworkPlan
  // before the pose). An explicit footworkStep still wins for direct callers.
  const publishedStep = footworkRaveStep(id);
  const fwName = footworkStep || publishedStep;
  const fwStep = fwName && RAVE_LOCOMOTOR[fwName] ? fwName : null;
  if (fwStep && plan.locomotor !== 'idle') {
    plan.locomotor = RAVE_LOCOMOTOR[fwStep];
    plan.stepF = 0; plan.stepS = 0;
    if (!plan.turning) plan.label = FOOTWORK_LABELS[fwStep];
  }
  const kin = kinematics({tSec, bpm: drv.bpm, activation: drv.activation, hush: drv.hush, layers, locomotor: plan.locomotor, weight, planted: side, beatPhase: clamp(num(beatPhase), 0, 0.9999), pulseClimb});
  return {
    amount: k,
    drivers: drv,
    layers,
    locomotor: plan.locomotor,
    footwork: fwStep && plan.locomotor !== 'idle' ? fwStep : null,
    label: plan.label,
    turnRad: plan.turnRad * Math.min(1, k),
    stepF: plan.stepF * k,
    stepS: plan.stepS * k,
    bounce: kin.bounce * k,
    // The sim's running-man hop is a step on the "and"; live eases it in and
    // out over the half-beat so the head never jerks (inset head-jerk gate).
    hop: kin.hop * k * Math.sin(Math.PI * clamp((num(beatPhase) - 0.5) / 0.5, 0, 1)),
    nod: clamp(kin.nod * k, -SAG_LIM, SAG_LIM),
    hipSwayX: kin.hipSwayX * k,
    hipSwayYaw: kin.hipSwayYaw * k,
    shCounter: kin.shCounter * k,
    jackPhi: scaleSpine(kin.jackPhi, k),
    wavePhi: scaleSpine(kin.wavePhi, k),
    footL: scaleFoot(kin.footL, Math.min(1, k)),
    footR: scaleFoot(kin.footR, Math.min(1, k)),
    kickLift: kin.kickLift * k,
    onAnd: kin.onAnd
  };
}

/** Sagittal (forward / back) spine pitch added by jacking, body wave and the nod. */
export function raveSagittal(rave) {
  if (!rave) return {pelvis: 0, lumbar: 0, thoracic: 0, neck: 0, head: 0};
  const jp = rave.jackPhi || {}, wp = rave.wavePhi || {};
  const s = (key, extra = 0) => clamp(num(jp[key]) + num(wp[key]) + extra, -SAG_LIM, SAG_LIM);
  return {pelvis: s('pelvis'), lumbar: s('lumbar'), thoracic: s('thoracic'), neck: s('neck', rave.nod * 0.45), head: s('head', rave.nod)};
}

/** Independent head look (same shared head-look.js as the side sim). */
export function liveHeadLook({id = 0, tSec = 0, activation = 0, hush = 1, bpm = 112} = {}) {
  return headLook({tSec, activation, hush, bpm, seed: (id | 0) * 1.37 + 0.5});
}

export {headLook};
