// Corpus adapter: band-onsets + Listen v2 pattern layer, in the
// nd-listen-corpus-v1 detector interface (scripts/listen-corpus-metrics.mjs).
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {createListenPattern} from '../neural-dance/src/listen-pattern.js';

// '7/8 (3+2+2)' -> '7/8', '8/8 (3+3+2)' -> '3+3+2', '4/4 swing' -> '4/4'.
export function corpusMeter(label) {
  if (!label) return null;
  const m = /^(\d+\/\d+)(?:\s*\(([\d+]+)\))?/.exec(label);
  if (!m) return null;
  if (m[1] === '8/8' && m[2] === '3+3+2') return '3+3+2';
  return m[1];
}

export function createDetector() {
  const det = createBandOnsets();
  const pat = createListenPattern();
  let nextDown = -1, lastDown = -1e9;
  const out = {beats: 0, onsets: 0, onsetTime: null, downbeats: 0, downbeatTime: NaN, meter: null};
  return {
    reset() { det.reset(); pat.reset(); nextDown = -1; lastDown = -1e9; },
    process(bytes, sampleRate, fftSize, now, open, sens) {
      const info = det.process(bytes, sampleRate, fftSize, now, open, sens);
      const p = pat.process(info, now, sens);
      out.beats = p.beats; out.onsets = info.onsets; out.onsetTime = info.onsetTime;
      out.meter = corpusMeter(p.meter);
      out.downbeats = 0; out.downbeatTime = NaN;
      // Downbeats: fire the predicted bar start when it arrives.
      if (p.active) {
        const d = pat.nextDownbeat(now);
        // Fire each predicted bar start once, when it arrives.
        if (nextDown > 0 && now >= nextDown - 8 && nextDown - lastDown > 300) { out.downbeats = 1; out.downbeatTime = nextDown; lastDown = nextDown; }
        nextDown = d;
      } else nextDown = -1;
      return out;
    },
    snapshot() { return {...pat.snapshot(), meter: corpusMeter(pat.state.meter)}; }
  };
}
