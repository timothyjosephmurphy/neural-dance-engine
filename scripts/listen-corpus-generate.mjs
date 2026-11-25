// Deterministic synthetic groove corpus for Listen v2 pattern learning.
// Renders 16-bit mono 48 kHz WAV + nd-listen-corpus-v1 JSON labels.
//
//   node scripts/listen-corpus-generate.mjs
//   node scripts/listen-corpus-generate.mjs --out tests/fixtures/listen-corpus
//
// Consumed by the feat/listen-pattern worker via the path/format in
// tests/fixtures/listen-corpus/SCHEMA.md.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {render} from '../tests/helpers/listen-sim.mjs';
import {
  SCHEMA, BAND_NAMES, DEFAULT_SR, makeTimeMap, phoneMic, peakNormalize,
  writeWav16Mono, sha256File
} from '../tests/helpers/listen-corpus.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outRoot = outIdx >= 0 ? args[outIdx + 1] : join(root, 'tests/fixtures/listen-corpus');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();

const T0 = 0.5;          // first downbeat, seconds (leaves analyser room)
const BARS = 8;          // default length in bars
const PAD = true;

function meterSpec(label, numerator, denominator, grouping) {
  return {label, numerator, denominator, grouping};
}

function bandMap(events) {
  const bands = {kick: [], bass: [], mid: [], hat: []};
  for (const e of events) bands[BAND_NAMES[e.band]].push(+e.t.toFixed(6));
  for (const k of BAND_NAMES) bands[k].sort((a, b) => a - b);
  return bands;
}

// Build a clip from a score-domain pattern.
// unitsPerBar: score units in one bar (the unit that tempo.bpm counts? NO —
// score units are always the tempo.unit note value).
function compile({
  id, seed, meter, tempo, swing = null, unitsPerBar, bars = BARS,
  pattern, fillBars = [], breakBars = [], degradations = [], notes = '',
  hatAudible = true, kind = 'synthetic'
}) {
  const totalUnits = unitsPerBar * bars;
  const timeOf = makeTimeMap(tempo, {t0: T0, units: totalUnits});
  const swingRatio = swing ? swing.ratio[0] / (swing.ratio[0] + swing.ratio[1]) : 0.5;
  // Time of a position given as (bar, unitWithinBar) plus an optional
  // intra-unit fraction 0..1 (for 16ths, swung offbeats, etc.).
  function tAt(bar, unit, frac = 0) {
    let u = bar * unitsPerBar + unit + frac;
    if (swing && frac === 0 && Math.abs(unit - Math.round(unit)) < 1e-9) {
      // unit is already the score unit; swing is applied to off-eighths at the
      // call site via tSwung.
    }
    return timeOf(u);
  }
  function tSwung(bar, unit, eighthIndex) {
    // eighthIndex 0 = on-beat, 1 = off-beat of this unit (unit = quarter).
    const frac = eighthIndex ? swingRatio : 0;
    return timeOf(bar * unitsPerBar + unit + frac);
  }

  const events = [];
  const pulses = [], beats = [], downbeats = [];
  const grouping = meter.grouping || [meter.numerator];
  const groupUnits = grouping.reduce((a, b) => a + b, 0);

  // Tactus ("beats"): simple meters (denominator 4) get one beat per quarter;
  // 6/8 and additive meters use the grouping onsets (unequal in 7/8, 3+3+2).
  const equalQuarter = meter.denominator === 4;
  for (let bar = 0; bar < bars; bar++) {
    downbeats.push(+tAt(bar, 0).toFixed(6));
    if (equalQuarter) {
      for (let i = 0; i < meter.numerator; i++) beats.push(+tAt(bar, i).toFixed(6));
    } else {
      let acc = 0;
      for (const g of grouping) {
        beats.push(+tAt(bar, acc * (unitsPerBar / groupUnits)).toFixed(6));
        acc += g;
      }
    }
  }

  // Isochronous (or swung) pulses at the denominator.
  const pulsesPerBar = meter.denominator === 8 || meter.label === '3+3+2' || meter.label === '6/8' || meter.label === '7/8'
    ? (meter.label === '6/8' ? 6 : groupUnits)
    : meter.numerator;
  // Map pulse index → score units.
  const scoreUnitsPerPulse = unitsPerBar / pulsesPerBar;
  for (let bar = 0; bar < bars; bar++) {
    for (let p = 0; p < pulsesPerBar; p++) {
      const on = p % 2 === 0 || !swing || scoreUnitsPerPulse !== 0.5;
      // For 4/4 with quarter units and eighth pulses, scoreUnitsPerPulse = 0.5,
      // odd pulses are the off-beats: delayed by (swingRatio - 0.5) in quarter units
      // = swingRatio * 0.5? Wait: pulse 1 is at unit 0.5 straight, or at swingRatio.
      if (swing && Math.abs(scoreUnitsPerPulse - 0.5) < 1e-9 && p % 2 === 1) {
        pulses.push(+timeOf(bar * unitsPerBar + (p - 1) * scoreUnitsPerPulse + swingRatio).toFixed(6));
      } else if (swing && unitsPerBar === pulsesPerBar && p % 2 === 1) {
        // unit = eighth already (shouldn't usually swing those)
        pulses.push(+tAt(bar, p).toFixed(6));
      } else {
        pulses.push(+timeOf(bar * unitsPerBar + p * scoreUnitsPerPulse).toFixed(6));
      }
    }
  }

  const ctx = {bars, unitsPerBar, timeOf, tAt, tSwung, swing, swingRatio, events, fillBars, breakBars, seed};
  pattern(ctx);

  const lastT = timeOf(totalUnits);
  const duration = +(lastT + 0.6).toFixed(3);
  const regions = {};
  if (breakBars.length) {
    regions.breaks = breakBars.map(b => [+tAt(b, 0).toFixed(6), +tAt(b + 1, 0).toFixed(6)]);
  }
  if (fillBars.length) {
    regions.fills = fillBars.map(b => [+tAt(b, 0).toFixed(6), +tAt(b + 1, 0).toFixed(6)]);
  }

  return {
    schema: SCHEMA,
    id,
    wav: `synthetic/${id}.wav`,
    kind,
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    source: {name: 'Neural Dance synthetic groove generator', url: 'scripts/listen-corpus-generate.mjs', notes: 'Deterministic seed; not a real recording.'},
    seed,
    sampleRate: DEFAULT_SR,
    channels: 1,
    duration,
    meter,
    tempo,
    swing,
    pulses,
    beats,
    downbeats,
    bands: bandMap(events),
    events: events.map(e => ({band: e.band, t: +e.t.toFixed(6), ...(e.gain != null ? {gain: e.gain} : {}), ...(e.freq ? {freq: e.freq} : {})})),
    bandNames: BAND_NAMES,
    provenance: {beats: 'synthetic-exact', downbeats: 'synthetic-exact', meter: 'announced', bands: 'synthetic-exact'},
    degradations,
    hatAudible,
    regions,
    notes,
    _timeOf: timeOf,
    _duration: duration,
    _events: events
  };
}

function inRegion(bar, bars) { return bars.includes(bar); }

// --- Patterns -----------------------------------------------------------

// 4/4 four-on-the-floor, snare 2 & 4, hats 8ths, bass on the ands.
function pat44({bars, tAt, tSwung, swing, events, breakBars, fillBars}) {
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    if (inRegion(bar, fillBars)) {
      // 16th snare/tom roll (mid) with kick on 1 and 3.
      events.push({band: 0, t: tAt(bar, 0)});
      events.push({band: 0, t: tAt(bar, 2)});
      for (let s = 0; s < 16; s++) events.push({band: 2, t: tAt(bar, 0, s / 4), gain: 0.7 + 0.3 * ((s % 4) === 0)});
      continue;
    }
    for (const u of [0, 1, 2, 3]) events.push({band: 0, t: tAt(bar, u)});
    for (const u of [1, 3]) events.push({band: 2, t: tAt(bar, u)});
    for (const u of [0, 1, 2, 3]) {
      events.push({band: 1, t: swing ? tSwung(bar, u, 1) : tAt(bar, u, 0.5), freq: 147});
    }
    for (const u of [0, 1, 2, 3]) {
      events.push({band: 3, t: swing ? tSwung(bar, u, 0) : tAt(bar, u, 0)});
      events.push({band: 3, t: swing ? tSwung(bar, u, 1) : tAt(bar, u, 0.5)});
    }
  }
}

// 3/4 waltz: kick on 1, mid on 2 and 3 (or bass on 2-3), hats on quarters + 8ths.
function pat34({bars, tAt, events, breakBars}) {
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    events.push({band: 0, t: tAt(bar, 0)});
    events.push({band: 2, t: tAt(bar, 1)});
    events.push({band: 2, t: tAt(bar, 2), gain: 0.75});
    events.push({band: 1, t: tAt(bar, 0), freq: 110});
    events.push({band: 1, t: tAt(bar, 2), freq: 147});
    for (let u = 0; u < 3; u++) {
      events.push({band: 3, t: tAt(bar, u)});
      events.push({band: 3, t: tAt(bar, u, 0.5), gain: 0.7});
    }
  }
}

// 6/8: units are dotted-quarters (2 per bar). Hats on 6 eighths, kick on 1, mid on 4.
function pat68({bars, tAt, events, breakBars}) {
  // unitsPerBar = 2 (dotted quarters). Eighth = 1/3 of a unit.
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    events.push({band: 0, t: tAt(bar, 0)});
    events.push({band: 2, t: tAt(bar, 1)});
    events.push({band: 1, t: tAt(bar, 0), freq: 98});
    events.push({band: 1, t: tAt(bar, 1, 1 / 3), freq: 130}); // the "and" of beat 2, 5th eighth
    for (let p = 0; p < 6; p++) events.push({band: 3, t: tAt(bar, 0, p / 3), gain: p % 3 === 0 ? 1 : 0.65});
  }
}

// 5/4 (3+2): kick on 1 and 4, snare on 3 and 5, hats on quarters, bass on 1 and 3.
function pat54({bars, tAt, events, breakBars}) {
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    events.push({band: 0, t: tAt(bar, 0)});
    events.push({band: 0, t: tAt(bar, 3)});
    events.push({band: 2, t: tAt(bar, 2)});
    events.push({band: 2, t: tAt(bar, 4)});
    events.push({band: 1, t: tAt(bar, 0), freq: 98});
    events.push({band: 1, t: tAt(bar, 2), freq: 147});
    events.push({band: 1, t: tAt(bar, 3), freq: 110});
    for (let u = 0; u < 5; u++) {
      events.push({band: 3, t: tAt(bar, u)});
      events.push({band: 3, t: tAt(bar, u, 0.5), gain: 0.7});
    }
  }
}

// 7/8 (3+2+2): units are eighths (7 per bar). Kick on 1, mid on 4 and 6, hats on 8ths.
function pat78({bars, tAt, events, breakBars}) {
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    events.push({band: 0, t: tAt(bar, 0)});
    events.push({band: 0, t: tAt(bar, 3), gain: 0.75});
    events.push({band: 2, t: tAt(bar, 3)});
    events.push({band: 2, t: tAt(bar, 5)});
    events.push({band: 1, t: tAt(bar, 0), freq: 98});
    events.push({band: 1, t: tAt(bar, 5), freq: 147});
    for (let u = 0; u < 7; u++) events.push({band: 3, t: tAt(bar, u), gain: (u === 0 || u === 3 || u === 5) ? 1 : 0.65});
  }
}

// 3+3+2 (8/8): units are eighths (8 per bar). Kick on 1, mid on 4 and 7.
function pat332({bars, tAt, events, breakBars}) {
  for (let bar = 0; bar < bars; bar++) {
    if (inRegion(bar, breakBars)) continue;
    events.push({band: 0, t: tAt(bar, 0)});
    events.push({band: 0, t: tAt(bar, 6), gain: 0.8});
    events.push({band: 2, t: tAt(bar, 3)});
    events.push({band: 2, t: tAt(bar, 6)});
    events.push({band: 1, t: tAt(bar, 0), freq: 110});
    events.push({band: 1, t: tAt(bar, 3), freq: 147});
    for (let u = 0; u < 8; u++) events.push({band: 3, t: tAt(bar, u), gain: (u === 0 || u === 3 || u === 6) ? 1 : 0.65});
  }
}

// Moving accents in 4/4: kick accent rotates around the bar; snare still 2 & 4.
function pat44Moving({bars, tAt, tSwung, events}) {
  for (let bar = 0; bar < bars; bar++) {
    const accent = bar % 4;
    for (const u of [0, 1, 2, 3]) {
      events.push({band: 0, t: tAt(bar, u), gain: u === accent ? 1.15 : 0.45});
    }
    for (const u of [1, 3]) events.push({band: 2, t: tAt(bar, u), gain: u === accent ? 1.1 : 0.85});
    for (const u of [0, 1, 2, 3]) events.push({band: 1, t: tAt(bar, u, 0.5), freq: 98 + (u === accent ? 20 : 0)});
    for (const u of [0, 1, 2, 3]) {
      events.push({band: 3, t: tAt(bar, u), gain: u === accent ? 1 : 0.55});
      events.push({band: 3, t: tAt(bar, u, 0.5), gain: 0.5});
    }
  }
}

function clips() {
  const out = [];
  const m44 = meterSpec('4/4', 4, 4, [2, 2]);
  const m34 = meterSpec('3/4', 3, 4, [3]);
  const m68 = meterSpec('6/8', 6, 8, [3, 3]);
  const m54 = meterSpec('5/4', 5, 4, [3, 2]);
  const m78 = meterSpec('7/8', 7, 8, [3, 2, 2]);
  const m332 = meterSpec('3+3+2', 8, 8, [3, 3, 2]);

  out.push(compile({
    id: 'syn-4-4-steady-120', seed: 40120, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44,
    notes: 'Four-on-the-floor 4/4 at a steady 120 BPM.'
  }));
  out.push(compile({
    id: 'syn-3-4-steady-108', seed: 30108, meter: m34,
    tempo: {kind: 'constant', bpm: 108, unit: 'quarter'},
    unitsPerBar: 3, pattern: pat34,
    notes: 'Waltz 3/4, kick on 1, mid on 2 and 3.'
  }));
  out.push(compile({
    id: 'syn-6-8-steady-96', seed: 60896, meter: m68,
    tempo: {kind: 'constant', bpm: 96, unit: 'dotted-quarter'},
    unitsPerBar: 2, pattern: pat68,
    notes: 'Compound 6/8. Tempo is dotted-quarter = 96 (eighth = 288). Tactus is 2 pulses per bar.'
  }));
  out.push(compile({
    id: 'syn-5-4-steady-110', seed: 50110, meter: m54,
    tempo: {kind: 'constant', bpm: 110, unit: 'quarter'},
    unitsPerBar: 5, pattern: pat54,
    notes: '5/4 grouped 3+2. Kick on 1 and 4, snare on 3 and 5.'
  }));
  out.push(compile({
    id: 'syn-7-8-322-210', seed: 78210, meter: m78,
    tempo: {kind: 'constant', bpm: 210, unit: 'eighth'},
    unitsPerBar: 7, pattern: pat78,
    notes: '7/8 grouped 3+2+2. Tempo is eighth = 210. Metric beats are the three uneven groups.'
  }));
  out.push(compile({
    id: 'syn-332-steady-100', seed: 33210, meter: m332,
    tempo: {kind: 'constant', bpm: 200, unit: 'eighth'},
    unitsPerBar: 8, pattern: pat332,
    notes: 'Additive 3+3+2 (8/8). Tempo is eighth = 200 (quarter = 100).'
  }));
  out.push(compile({
    id: 'syn-4-4-swing-2-1-120', seed: 42120, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    swing: {ratio: [2, 1], label: '2:1'},
    unitsPerBar: 4, pattern: pat44,
    notes: '4/4 with triplet (2:1) swing on the off-eighths (hats and bass ands).'
  }));
  out.push(compile({
    id: 'syn-4-4-swing-3-2-120', seed: 43120, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    swing: {ratio: [3, 2], label: '3:2'},
    unitsPerBar: 4, pattern: pat44,
    notes: '4/4 with 3:2 shuffle swing on the off-eighths.'
  }));
  out.push(compile({
    id: 'syn-4-4-drift-plus8-120', seed: 48120, meter: m44,
    tempo: {kind: 'linear-drift', bpmStart: 120, bpmEnd: 129.6, unit: 'quarter', units: 32},
    unitsPerBar: 4, pattern: pat44,
    notes: '4/4 with a gradual +8% tempo drift (120 → 129.6 BPM) across 8 bars of score time.'
  }));
  out.push(compile({
    id: 'syn-4-4-drift-minus8-120', seed: 48121, meter: m44,
    tempo: {kind: 'linear-drift', bpmStart: 120, bpmEnd: 110.4, unit: 'quarter', units: 32},
    unitsPerBar: 4, pattern: pat44,
    notes: '4/4 with a gradual −8% tempo drift (120 → 110.4 BPM) across 8 bars of score time.'
  }));
  out.push(compile({
    id: 'syn-4-4-rubato-112', seed: 40112, meter: m44,
    tempo: {kind: 'rubato', bpm: 112, unit: 'quarter', depth: 0.09, periodUnits: 8, phi: 0.4, integrateStep: 1 / 32},
    unitsPerBar: 4, pattern: pat44,
    notes: '4/4 with sinusoidal rubato (±9% instantaneous BPM, period = 2 bars).'
  }));
  out.push(compile({
    id: 'syn-4-4-break-120', seed: 40220, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44, breakBars: [4, 5],
    notes: 'Steady 4/4 with a 2-bar break (silence) at bars 5–6. Beats and downbeats continue through the gap; band hits do not.'
  }));
  out.push(compile({
    id: 'syn-4-4-fill-120', seed: 40320, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44, fillBars: [4, 5],
    notes: 'Steady 4/4 with a 2-bar mid-band 16th-note fill at bars 5–6.'
  }));
  out.push(compile({
    id: 'syn-4-4-moving-accents-120', seed: 40420, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44Moving,
    notes: '4/4 with the kick (and hat) accent rotating to a new beat each bar.'
  }));
  out.push(compile({
    id: 'syn-4-4-tempo-change-100-128', seed: 40128, meter: m44,
    tempo: {kind: 'step', unit: 'quarter', bpm: 100, steps: [{u: 0, bpm: 100}, {u: 16, bpm: 128}]},
    unitsPerBar: 4, pattern: pat44, bars: 8,
    notes: '4 bars at 100 BPM, then an immediate step to 128 BPM for 4 bars.'
  }));

  // Phone-mic variants are compiled from the same score as the clean clips,
  // then the audio is degraded after render (labels stay exact, including inaudible hats).
  const phoneBase = compile({
    id: 'syn-4-4-phone-mic-120', seed: 40920, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44,
    degradations: ['room-reverb', 'phone-mic-100-8k', 'noise'],
    notes: 'Same groove as syn-4-4-steady-120, through a phone-mic simulation: room reverb, 100 Hz–8 kHz band-limit, sensor noise.'
  });
  out.push(phoneBase);

  const hatCut = compile({
    id: 'syn-4-4-phone-mic-hatcut-120', seed: 40921, meter: m44,
    tempo: {kind: 'constant', bpm: 120, unit: 'quarter'},
    unitsPerBar: 4, pattern: pat44,
    degradations: ['room-reverb', 'phone-mic-100-5k', 'noise', 'lowpass-5k'],
    hatAudible: false,
    notes: 'Phone-mic sim with a 5 kHz low-pass (no content above 5 kHz), mirroring the iPhone hat-zero finding. Hat hit times are still labeled; they should be inaudible.'
  });
  out.push(hatCut);

  out.push(compile({
    id: 'syn-7-8-phone-mic-hatcut-210', seed: 78921, meter: m78,
    tempo: {kind: 'constant', bpm: 210, unit: 'eighth'},
    unitsPerBar: 7, pattern: pat78,
    degradations: ['room-reverb', 'phone-mic-100-5k', 'noise', 'lowpass-5k'],
    hatAudible: false,
    notes: '7/8 (3+2+2) through the same 5 kHz phone-mic cut as the 4/4 hat-cut clip.'
  }));

  return out;
}

async function renderClip(clip) {
  const events = clip._events;
  let audio = render(events, clip._duration, {
    pad: PAD ? [[0, clip._duration]] : [],
    seed: clip.seed,
    noise: 0.0015
  });
  const deg = clip.degradations || [];
  if (deg.includes('phone-mic-100-8k') || deg.includes('phone-mic-100-5k') || deg.includes('lowpass-5k')) {
    audio = phoneMic(audio, DEFAULT_SR, {
      hatCut: deg.includes('lowpass-5k') || deg.includes('phone-mic-100-5k'),
      seed: clip.seed ^ 0x9e3779b9,
      noise: 0.006,
      mix: 0.24
    });
  } else {
    peakNormalize(audio, 0.95);
  }
  return audio;
}

function publicLabel(clip, sha) {
  const { _timeOf, _duration, _events, ...rest } = clip;
  return {...rest, sha256: sha};
}

async function main() {
  const synDir = join(outRoot, 'synthetic');
  await mkdir(synDir, {recursive: true});
  const all = clips().filter(c => !only || only.has(c.id));
  const manifest = [];
  for (const clip of all) {
    const audio = await renderClip(clip);
    const wavPath = join(outRoot, clip.wav);
    await writeWav16Mono(wavPath, audio, DEFAULT_SR);
    const sha = await sha256File(wavPath);
    const label = publicLabel(clip, sha);
    const jsonPath = wavPath.replace(/\.wav$/i, '.json');
    await writeFile(jsonPath, JSON.stringify(label, null, 2) + '\n');
    manifest.push({
      id: label.id, wav: label.wav, json: label.wav.replace(/\.wav$/i, '.json'),
      kind: label.kind, meter: label.meter.label, tempo: label.tempo,
      swing: label.swing, degradations: label.degradations, hatAudible: label.hatAudible,
      duration: label.duration, sampleRate: label.sampleRate, sha256: sha, seed: label.seed,
      notes: label.notes
    });
    console.log('wrote', clip.id, 'dur=' + label.duration + 's', 'beats=' + label.beats.length, 'sha=' + sha.slice(0, 12));
  }

  // Merge with any existing real-track entries in the manifest.
  const manPath = join(outRoot, 'manifest.json');
  let real = [];
  try {
    const prev = JSON.parse(await readFile(manPath, 'utf8'));
    real = (prev.clips || prev || []).filter(c => c.kind === 'real' || (c.wav || '').startsWith('real/'));
  } catch {}
  const doc = {
    schema: SCHEMA,
    generatedBy: 'scripts/listen-corpus-generate.mjs',
    sampleRate: DEFAULT_SR,
    clips: manifest.concat(real)
  };
  await writeFile(manPath, JSON.stringify(doc, null, 2) + '\n');
  console.log('manifest:', manPath, 'synthetic', manifest.length, 'real', real.length);
}

if (import.meta.url === 'file://' + process.argv[1]) main();
export {clips, renderClip, publicLabel};
