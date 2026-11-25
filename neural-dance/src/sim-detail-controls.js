// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Body controls shared with the side sim. The sim page paints with the same
// silhouette show (hip figure-8, twists, hue, bones). This list is those
// fields, at the show's own defaults, so the debug preview does not keep a
// second copy of the numbers.

import {DEFAULT_SHOW_TUNING} from './silhouette.js';

const T = DEFAULT_SHOW_TUNING;

export const SIM_DETAIL_CONTROLS = Object.freeze([
  {key: 'hueSpread', label: 'Hue spread', min: 0, max: 1, step: 0.05, value: T.hueSpread},
  {key: 'hipEight', label: 'Hip figure-8', min: 0, max: 1.5, step: 0.05, value: T.hipEight},
  {key: 'shoulderEight', label: 'Shoulder figure-8', min: 0, max: 1.5, step: 0.05, value: T.shoulderEight},
  {key: 'hipTwist', label: 'Hip twist', min: 0, max: 1.5, step: 0.05, value: T.hipTwist},
  {key: 'shoulderTwist', label: 'Shoulder twist', min: 0, max: 1.5, step: 0.05, value: T.shoulderTwist},
  {key: 'maxBodyTurn', label: 'Max body turn', min: 0, max: 90, step: 5, value: T.maxBodyTurn},
  {key: 'turnFreq', label: 'Turn frequency', min: 0, max: 1.5, step: 0.05, value: T.turnFreq},
  {key: 'eightDepth', label: 'Figure-8 depth', min: 0, max: 1.5, step: 0.05, value: T.eightDepth},
  {key: 'eightVert', label: 'Figure-8 vertical', min: 0, max: 1.5, step: 0.05, value: T.eightVert},
  {key: 'armPadSense', label: 'Arms ← strings/synth', min: 0, max: 2, step: 0.05, value: T.armPadSense},
  {key: 'bloomIntensity', label: 'Bloom intensity', min: 0, max: 2, step: 0.05, value: T.bloomIntensity},
  {key: 'innerBones', label: 'Inner bones', min: 0, max: 2, step: 1, value: T.innerBones}
]);

export function simDetailTuning(root) {
  const tune = {};
  if (!root || !root.querySelectorAll) return tune;
  root.querySelectorAll('[data-sim-detail]').forEach(input => {
    const key = input.getAttribute('data-sim-detail');
    const value = +input.value;
    if (key && Number.isFinite(value)) tune[key] = value;
  });
  return tune;
}

// Local preview only. These inputs are not the room's data-debug-control
// sliders, so moving one does not send a patch to the projector.
export function mountSimDetailControls(parent, onChange) {
  if (!parent) return [];
  const doc = parent.ownerDocument || globalThis.document;
  const made = [];
  for (const spec of SIM_DETAIL_CONTROLS) {
    const label = doc.createElement('label');
    label.textContent = spec.label;
    const input = doc.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.value);
    input.setAttribute('data-sim-detail', spec.key);
    label.appendChild(input);
    parent.appendChild(label);
    input.addEventListener('input', () => { if (onChange) onChange(simDetailTuning(parent)); });
    made.push(input);
  }
  return made;
}
