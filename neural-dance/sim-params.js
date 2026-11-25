// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Keys the sim preview may override. Same set as static/neural-dance/sim/params.json.
// The live show does not read this module.

export const SIM_PARAM_NUMBERS = [
  'bpm', 'speed', 'amplitude', 'stiffness', 'rippleIntensity', 'hueSpread',
  'spineFlex', 'spineLag', 'armFlex', 'legComplex', 'jiggle', 'sameFootThresh',
  'hipEight', 'hipTwist', 'shoulderTwist', 'maxBodyTurn', 'turnFreq', 'shoulderEight',
  'eightDepth', 'eightVert', 'armLiftSense', 'armPadSense', 'peakHold', 'showArc',
  'showHours', 'peakThreshold', 'peakDuration', 'partnerCount'
];

export const SIM_PARAM_FLAGS = [
  'silhouettes', 'skeleton', 'innerBones', 'ripples', 'armLift', 'peakPulses',
  'standTall', 'pitchArms', 'alignWrists', 'crownPulse', 'bassBuzz', 'buzzPreview',
  'showArcOn', 'raveMoves', 'mittens', 'stayInFrame', 'easeTurns', 'jointCap'
];

export const SIM_PARAM_MASSES = ['root', 'sacral', 'solar', 'heart', 'throat', 'thirdEye', 'crown'];

const NUMBERS = new Set(SIM_PARAM_NUMBERS);
const FLAGS = new Set(SIM_PARAM_FLAGS);
const MASSES = new Set(SIM_PARAM_MASSES);

export function validateSimParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {ok: false, error: 'Expected a params object'};
  }
  const value = {};
  for (const key of Object.keys(input)) {
    if (NUMBERS.has(key)) {
      const number = input[key];
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        return {ok: false, error: 'Bad number ' + key};
      }
      value[key] = number;
      continue;
    }
    if (FLAGS.has(key)) {
      if (typeof input[key] !== 'boolean') return {ok: false, error: 'Bad flag ' + key};
      value[key] = input[key];
      continue;
    }
    if (key === 'masses') {
      const masses = input.masses;
      if (!masses || typeof masses !== 'object' || Array.isArray(masses)) {
        return {ok: false, error: 'Bad masses'};
      }
      const next = {};
      for (const name of Object.keys(masses)) {
        if (!MASSES.has(name)) return {ok: false, error: 'Unknown mass ' + name};
        const number = masses[name];
        if (typeof number !== 'number' || !Number.isFinite(number)) {
          return {ok: false, error: 'Bad mass ' + name};
        }
        next[name] = number;
      }
      value.masses = next;
      continue;
    }
    return {ok: false, error: 'Unknown key ' + key};
  }
  return {ok: true, value};
}
