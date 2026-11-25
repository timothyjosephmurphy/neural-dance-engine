// Offline per-band Listen timing report. `node scripts/listen-timing-report.mjs`
import '../neural-dance/silence-gate.js';
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {SCENARIOS, createLegacyDetector, run, score} from '../tests/helpers/listen-sim.mjs';

const NAMES = ['kick', 'bass', 'mid/snare', 'hat'];
export function report({quiet = false} = {}) {
  const rows = [];
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const sc = make();
    for (const [label, det] of [['legacy', createLegacyDetector()], ['per-band', createBandOnsets()]]) {
      const gate = {lib: globalThis.ndSilenceGate, state: globalThis.ndSilenceGate.create()};
      const r = run(det, sc, {gate});
      for (let b = 0; b < 4; b++) {
        const on = score(r.events, r.onsets, b, {skipFirstMs: 1200});
        const bt = score(r.events, r.beats, b, {skipFirstMs: 1200});
        rows.push({scenario: name, detector: label, band: NAMES[b], truth: on.truth, hits: on.hits, fp: on.falsePositives,
          onsetMedAbs: +on.medianAbsMs.toFixed(1), onsetMedSigned: +on.medianSignedMs.toFixed(1), onsetP90: +on.p90AbsMs.toFixed(1),
          beatHits: bt.hits, beatFp: bt.falsePositives, beatMedAbs: +bt.medianAbsMs.toFixed(1), beatMedSigned: +bt.medianSignedMs.toFixed(1)});
      }
    }
  }
  if (!quiet) console.table(rows);
  return rows;
}
if (import.meta.url === 'file://' + process.argv[1]) report();
