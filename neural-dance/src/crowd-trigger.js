// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Demo page trigger: the live page's visit logic (someone steps in, the
// person pause holds, they leave, the floor stays clear) fires one "add a
// dancer" instead of a sticker scan. No painting reference or sticker scene
// is needed, so learned and sceneMatch are always true here.
import {createVisitScan, VISIT_CLEAR_MS, VISIT_COOLDOWN_MS} from './visit-scan.js';

export function createDemoTrigger({clearMs = VISIT_CLEAR_MS, cooldownMs = VISIT_COOLDOWN_MS} = {}) {
  const visit = createVisitScan({clearMs, cooldownMs});
  let adds = 0;
  return {
    observe({present = false, now = 0} = {}) {
      const step = visit.observe({present: !!present, now, scanning: false, learned: true, sceneMatch: true});
      if (!step.scan) return {add: false, state: step.state, label: step.label};
      adds++;
      visit.noteResult(1);
      visit.quiet(now, cooldownMs);
      return {add: true, state: 'added', label: 'Dancer added'};
    },
    adds: () => adds
  };
}
