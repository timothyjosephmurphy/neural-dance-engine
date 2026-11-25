// Synthetic grooves for Listen v2 pattern learning: odd/additive meters,
// swing, drift, breaks and moving accents. Each pattern is one cycle of
// tatum steps per band ('x' hit, 'X' accented hit, '.' rest).
import {SR, render, createAnalyser, frameTimes} from './listen-sim.mjs';
import {createBandOnsets} from '../../neural-dance/src/band-onsets.js';
import {createListenPattern} from '../../neural-dance/src/listen-pattern.js';
import '../../neural-dance/silence-gate.js';

// stepMs(n) returns the length of tatum n (lets us drift). swingAt(pos) can
// push a step later (fraction of the step).
export function patternEvents({k, b = '', s, h, stepMs, start = 0.5, end, swing = null, accentMove = null}) {
  const L = k.length, ev = [], downbeats = [];
  let t = start * 1000, n = 0;
  while (t < end * 1000) {
    const pos = n % L;
    const cycle = Math.floor(n / L);
    if (pos === 0) downbeats.push(t);
    const push = swing ? swing(pos) * stepMs(n) : 0;
    const lanes = accentMove && cycle >= accentMove.fromCycle ? accentMove.lanes : {k, b, s, h};
    const add = (lane, band, extra) => { const c = lane[pos]; if (c === 'x' || c === 'X') ev.push({band, t: (t + push) / 1000, gain: c === 'X' ? 1.15 : 0.9, ...extra}); };
    add(lanes.k, 0); if (lanes.b) add(lanes.b, 1, {freq: 147}); add(lanes.s, 2); add(lanes.h, 3);
    t += stepMs(n); n++;
  }
  return {events: ev, downbeats};
}

const steady = ms => () => ms;
const q = bpm => 60000 / bpm;

// Each scenario: {meter, duration, events, downbeats, beatMs, silence?}
export const PATTERNS = {
  'four4': () => ({meter: '4/4', beatMs: q(118), ...patternEvents({k: 'x...xx..', b: 'x....x..', s: '..X...X.', h: 'xxxxxxxx', stepMs: steady(q(118) / 2), end: 22}), duration: 22}),
  'three4': () => ({meter: '3/4', beatMs: q(132), ...patternEvents({k: 'X.....', b: 'x.....', s: '..x.x.', h: 'xxxxxx', stepMs: steady(q(132) / 2), end: 22}), duration: 22}),
  'six8': () => ({meter: '6/8', beatMs: 3 * q(200), ...patternEvents({k: 'X.....', b: 'x..x..', s: '...X..', h: 'xxxxxx', stepMs: steady(q(200)), end: 22}), duration: 22}),
  'five4': () => ({meter: '5/4', beatMs: q(150), ...patternEvents({k: 'X.....x...', b: '', s: '..x.x...x.', h: 'xxxxxxxxxx', stepMs: steady(q(150) / 2), end: 24}), duration: 24}),
  'seven8_322': () => ({meter: '7/8 (3+2+2)', beatMs: q(124), ...patternEvents({k: 'X......', b: 'x..x.x.', s: '...x.x.', h: 'xxxxxxx', stepMs: steady(q(124) / 2), end: 24}), duration: 24}),
  'eight8_332': () => ({meter: '8/8 (3+3+2)', beatMs: q(116), ...patternEvents({k: 'X..x..x.', b: '', s: '...X....', h: 'x.xx.xx.', stepMs: steady(q(116) / 2), end: 24}), duration: 24}),
  'swing21': () => ({meter: '4/4 swing', beatMs: q(112), ...patternEvents({k: 'X.....x.....', b: '', s: '...x.....x..', h: 'x.xx.xx.xx.x', stepMs: steady(q(112) / 3), end: 24}), duration: 24}),
  // 3:2 swing: off-beat 8ths land 60% through the beat (step pushed 0.2).
  'swing32': () => ({meter: '4/4', beatMs: q(108), ...patternEvents({k: 'x...xx..', b: '', s: '..X...X.', h: 'xxxxxxxx', stepMs: steady(q(108) / 2), swing: pos => pos % 2 ? 0.2 : 0, end: 24}), duration: 24}),
  // Rubato / drift: 104 -> 124 BPM over 24 s.
  'drift': () => ({meter: '4/4', beatMs: q(114), ...patternEvents({k: 'x...xx..', b: 'x....x..', s: '..X...X.', h: 'xxxxxxxx', stepMs: n => q(104 + 20 * Math.min(1, n / 100)) / 2, end: 26}), duration: 26}),
  // Break: 5 s of silence mid-song, groove comes back.
  'break': () => {
    const a = patternEvents({k: 'x...xx..', b: 'x....x..', s: '..X...X.', h: 'xxxxxxxx', stepMs: steady(q(120) / 2), end: 12});
    const b = patternEvents({k: 'x...xx..', b: 'x....x..', s: '..X...X.', h: 'xxxxxxxx', stepMs: steady(q(120) / 2), start: 17, end: 28});
    return {meter: '4/4', beatMs: q(120), events: a.events.filter(e => e.t < 12).concat(b.events), downbeats: a.downbeats.concat(b.downbeats), duration: 28, silence: [12, 17]};
  },
  // Moving accent: the snare moves from beat 2&4 to the "and" of 2 and 4.
  'movingAccent': () => ({meter: '4/4', beatMs: q(116), ...patternEvents({k: 'x...xx..', b: '', s: '..X...X.', h: 'xxxxxxxx', stepMs: steady(q(116) / 2), end: 30,
    accentMove: {fromCycle: 7, lanes: {k: 'x...xx..', b: '', s: '...X...X', h: 'xxxxxxxx'}}}), duration: 30, accentFrom: 0.5 + 7 * 4 * q(116) / 1000})
};

// Drive band-onsets + pattern layer over a scenario like the live page.
export function runPattern(sc, {withPattern = true, fftSize = 2048, seed = 3} = {}) {
  const audio = render(sc.events, sc.duration, {pad: [[0, sc.duration]], seed: seed + 4});
  const an = createAnalyser(fftSize);
  const times = frameTimes(sc.duration * 1000, {seed});
  const det = createBandOnsets();
  const pat = createListenPattern();
  const lib = globalThis.ndSilenceGate, gate = lib.create();
  const beats = [], predicted = [], meters = [], downbeatGuesses = [];
  let last = times[0], cost = 0;
  const sens = [1, 1, 1, 1];
  for (const now of times) {
    const bytes = an.at(audio, Math.floor(now / 1000 * SR));
    let open = true;
    lib.scale(gate, lib.bandPeaks(bytes, SR, fftSize), Math.max(0.001, (now - last) / 1000)); open = gate.open;
    const info = det.process(bytes, SR, fftSize, now, open, sens);
    let mask = info.beats, pmask = 0;
    if (withPattern) {
      const c0 = performance.now();
      const o = pat.process(info, now, sens);
      cost += performance.now() - c0;
      mask = o.beats; pmask = o.predicted;
      if (o.meter) meters.push({t: now, meter: o.meter, bpm: o.bpm, active: o.active, ratio: Array.from(o.ratio)});
      const nd = pat.nextDownbeat(now);
      if (nd > 0 && o.active) downbeatGuesses.push(nd);
    }
    for (let b = 0; b < 4; b++) {
      if (mask & (1 << b)) beats.push({band: b, t: now});
      if (pmask & (1 << b)) predicted.push({band: b, t: now});
    }
    last = now;
  }
  return {beats, predicted, meters, downbeatGuesses, costMs: cost / times.length, pattern: pat};
}

// Downbeat F-measure: unique predicted downbeat times vs truth (±tol).
export function downbeatScore(guesses, truth, {tol = 70, from = 0} = {}) {
  const uniq = [];
  for (const g of guesses.sort((a, b) => a - b)) if (!uniq.length || g - uniq[uniq.length - 1] > 120) uniq.push(g);
  const G = uniq.filter(g => g >= from), Tr = truth.filter(t => t >= from && t <= (G.length ? G[G.length - 1] + tol : -1));
  const used = new Uint8Array(G.length);
  let hit = 0;
  for (const t of Tr) {
    let bi = -1, bd = tol;
    for (let i = 0; i < G.length; i++) if (!used[i] && Math.abs(G[i] - t) <= bd) { bd = Math.abs(G[i] - t); bi = i; }
    if (bi >= 0) { used[bi] = 1; hit++; }
  }
  const p = G.length ? hit / G.length : 0, r = Tr.length ? hit / Tr.length : 0;
  return {precision: p, recall: r, f: p + r ? 2 * p * r / (p + r) : 0};
}
