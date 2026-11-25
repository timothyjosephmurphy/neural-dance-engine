// Metrics for a Listen detector against the nd-listen-corpus-v1 corpus.
//
//   node scripts/listen-corpus-metrics.mjs
//       Run the current per-band detector + the legacy baseline on every clip.
//   node scripts/listen-corpus-metrics.mjs --detector per-band,legacy
//   node scripts/listen-corpus-metrics.mjs --detector ./path/to/module.mjs
//   node scripts/listen-corpus-metrics.mjs --write tests/fixtures/listen-corpus/baseline
//   node scripts/listen-corpus-metrics.mjs --only syn-4-4-steady-120,syn-7-8-322-210
//
// A detector module may export either (or both):
//
//   createDetector(opts?) → { process(bytes, sampleRate, fftSize, now, open, sens), snapshot?(), reset?() }
//     process() matches tests/helpers/listen-sim.mjs and neural-dance/src/band-onsets.js.
//     Optional fields on the return / snapshot: meter, meterLabel, downbeats (mask),
//     downbeatTime (ms).
//
//   detectOffline(samples: Float32Array, sampleRate, opts?) → {
//     beats: number[],           // seconds
//     downbeats?: number[],
//     meter?: string | {label, numerator, denominator, grouping},
//     bands?: {kick:number[], bass:number[], mid:number[], hat:number[]},
//     onsets?: {band:number, t:number}[]
//   }
//
// Built-in names: "per-band" (createBandOnsets), "legacy" (createLegacyDetector).
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {createLegacyDetector} from '../tests/helpers/listen-sim.mjs';
import {
  evaluateClip, resultRow, runDetectorOnAudio, readWav, SCHEMA, BAND_NAMES
} from '../tests/helpers/listen-corpus.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CORPUS = join(root, 'tests/fixtures/listen-corpus');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function has(flag) { return process.argv.includes(flag); }

async function loadLabel(jsonPath) {
  return JSON.parse(await readFile(jsonPath, 'utf8'));
}

async function listClips(corpus, only) {
  const manPath = join(corpus, 'manifest.json');
  let ids = [];
  try {
    const man = JSON.parse(await readFile(manPath, 'utf8'));
    ids = (man.clips || []).map(c => ({id: c.id, wav: join(corpus, c.wav), json: join(corpus, c.json || c.wav.replace(/\.wav$/i, '.json'))}));
  } catch {
    // Fall back to walking synthetic/ and real/.
    for (const sub of ['synthetic', 'real']) {
      let names = [];
      try { names = await readdir(join(corpus, sub)); } catch { continue; }
      for (const n of names.filter(n => n.endsWith('.json'))) {
        const json = join(corpus, sub, n);
        const wav = json.replace(/\.json$/i, '.wav');
        ids.push({id: n.replace(/\.json$/i, ''), wav, json});
      }
    }
  }
  if (only) ids = ids.filter(c => only.has(c.id));
  return ids;
}

function builtin(name) {
  if (name === 'per-band') {
    return {
      name: 'per-band',
      create: () => {
        const d = createBandOnsets();
        return {process: d.process, snapshot: d.snapshot, reset: d.reset, state: d.state};
      }
    };
  }
  if (name === 'legacy') {
    return {
      name: 'legacy',
      create: () => {
        const d = createLegacyDetector();
        return {process: d.process};
      }
    };
  }
  return null;
}

async function loadDetectorSpec(spec) {
  const b = builtin(spec);
  if (b) return b;
  const path = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  const mod = await import(pathToFileURL(path).href);
  const name = mod.name || basename(spec).replace(/\.mjs$/i, '');
  if (typeof mod.detectOffline === 'function' || typeof mod.createDetector === 'function') {
    return {
      name,
      create: mod.createDetector ? () => mod.createDetector() : null,
      detectOffline: mod.detectOffline || null
    };
  }
  throw new Error('detector ' + spec + ' must export createDetector() and/or detectOffline()');
}

async function gateFor() {
  // Optional silence gate, same as listen-timing-report. Loaded lazily so
  // metrics still run if the side-effect import is missing in a worktree.
  try {
    await import('../neural-dance/silence-gate.js');
    const lib = globalThis.ndSilenceGate;
    if (!lib) return null;
    return {lib, state: lib.create()};
  } catch {
    return null;
  }
}

async function runOne(det, wavPath, label) {
  const {samples, sampleRate} = await readWav(wavPath);
  if (det.detectOffline && !det.create) {
    const off = await det.detectOffline(samples, sampleRate, {label});
    const onsets = off.onsets || [];
    if (!onsets.length && off.bands) {
      for (let b = 0; b < BAND_NAMES.length; b++) {
        for (const t of off.bands[BAND_NAMES[b]] || []) onsets.push({band: b, t});
      }
    }
    const beats = (off.beats || []).map(t => ({band: -1, t}));
    // If per-band beats are supplied, prefer them for band scoring.
    if (off.bandBeats) {
      for (let b = 0; b < BAND_NAMES.length; b++) {
        for (const t of off.bandBeats[BAND_NAMES[b]] || []) beats.push({band: b, t});
      }
    }
    return {
      onsets,
      beats,
      downbeats: off.downbeats || [],
      downbeatsProvided: Array.isArray(off.downbeats),
      meter: off.meter || off.meterLabel || null,
      duration: label.duration,
      sampleRate
    };
  }
  const gate = await gateFor();
  const inst = det.create();
  if (inst.reset) inst.reset();
  return runDetectorOnAudio(inst, samples, sampleRate, {gate});
}

function summarize(rows) {
  const byDet = new Map();
  for (const r of rows) {
    if (!byDet.has(r.detector)) byDet.set(r.detector, []);
    byDet.get(r.detector).push(r);
  }
  const out = [];
  for (const [detector, rs] of byDet) {
    const num = k => rs.map(r => r[k]).filter(v => v != null && !Number.isNaN(v));
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const meterKnown = rs.filter(r => r.meterOk != null);
    const meterHits = meterKnown.filter(r => r.meterOk === true).length;
    out.push({
      detector,
      clips: rs.length,
      meterAccuracy: meterKnown.length ? +(meterHits / meterKnown.length).toFixed(3) : null,
      meterReported: meterKnown.length,
      downF: +((mean(num('downF')) ?? NaN).toFixed(3)) || (mean(num('downF')) == null ? null : 0),
      beatF: +(mean(num('beatF')) ?? 0).toFixed(3),
      beatAntMs: mean(num('beatAntMs')) == null ? null : +mean(num('beatAntMs')).toFixed(1),
      kickBeatF: +(mean(num('kickBeatF')) ?? 0).toFixed(3),
      kickOnsetF: +(mean(num('kickOnsetF')) ?? 0).toFixed(3),
      bassOnsetF: +(mean(num('bassOnsetF')) ?? 0).toFixed(3),
      midOnsetF: +(mean(num('midOnsetF')) ?? 0).toFixed(3),
      hatOnsetF: +(mean(num('hatOnsetF')) ?? 0).toFixed(3)
    });
  }
  return out;
}

function markdownTable(rows, keys) {
  if (!rows.length) return '_(no rows)_';
  const cols = keys || Object.keys(rows[0]);
  const fmt = v => (v == null || v === '' ? '—' : String(v));
  const lines = [
    '| ' + cols.join(' | ') + ' |',
    '| ' + cols.map(() => '---').join(' | ') + ' |'
  ];
  for (const r of rows) lines.push('| ' + cols.map(c => fmt(r[c])).join(' | ') + ' |');
  return lines.join('\n');
}

export async function runMetrics({
  corpus = DEFAULT_CORPUS,
  detectors = ['per-band', 'legacy'],
  only = null,
  write = null,
  quiet = false
} = {}) {
  const clips = await listClips(corpus, only);
  if (!clips.length) throw new Error('no clips in ' + corpus + ' (run node scripts/listen-corpus-generate.mjs first)');
  const specs = [];
  for (const d of detectors) specs.push(await loadDetectorSpec(d));
  const evaluations = [];
  const rows = [];
  for (const clip of clips) {
    const label = await loadLabel(clip.json);
    if (label.schema && label.schema !== SCHEMA) {
      console.warn('warn: %s has schema %s (expected %s)', clip.id, label.schema, SCHEMA);
    }
    for (const det of specs) {
      const result = await runOne(det, clip.wav, label);
      const ev = evaluateClip(label, result);
      ev.detector = det.name;
      ev.bandTruth = (label.provenance && label.provenance.bands) || 'unknown';
      // Envelope-peak band hits on real clips are proposals, not exact truth.
      if (ev.bandTruth !== 'synthetic-exact') {
        ev.bandsInformal = ev.bands;
        ev.bands = Object.fromEntries(Object.keys(ev.bands || {}).map(k => [k, {onset: {f: null}, beat: {f: null}}]));
      }
      evaluations.push(ev);
      const row = resultRow(ev, det.name);
      row.bandTruth = ev.bandTruth;
      rows.push(row);
    }
  }
  const summary = summarize(rows);
  const report = {
    schema: SCHEMA,
    corpus,
    generatedAt: new Date().toISOString(),
    skipFirstMs: 1200,
    beatTolMs: 70,
    detectors: specs.map(s => s.name),
    clips: clips.map(c => c.id),
    summary,
    rows,
    evaluations
  };
  if (!quiet) {
    console.log('\nPer-clip:');
    console.table(rows);
    console.log('\nSummary (mean F / anticipation):');
    console.table(summary);
  }
  if (write) {
    await mkdir(write, {recursive: true});
    await writeFile(join(write, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    const md = [
      '# Listen corpus baseline',
      '',
      'Generated by `scripts/listen-corpus-metrics.mjs`. Beat and downbeat F-measure use a **70 ms** window. Anticipation is the median signed error (detected − truth) in milliseconds; negative means the detector is early. The first 1200 ms of each clip is skipped (detector warm-up). Meter accuracy and downbeat F are null when the detector does not emit a meter or downbeats (the current per-band and legacy Listen detectors do not). `beatF` scores the union of all four band beat streams against the tactus (hats on off-beats therefore lower this number). `kickBeatF` scores only the kick-band beat stream against the same tactus, which is the fairer baseline for the current detectors. Per-band onset F is reported only for synthetic clips with exact band labels.',
      '',
      '## Summary',
      '',
      markdownTable(summary),
      '',
      '## Per clip',
      '',
      markdownTable(rows),
      ''
    ].join('\n');
    await writeFile(join(write, 'results.md'), md);
    if (!quiet) console.log('wrote', join(write, 'results.json'), 'and results.md');
  }
  return report;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const onlyArg = arg('--only');
  const detArg = arg('--detector', 'per-band,legacy');
  const write = arg('--write', has('--write') ? join(DEFAULT_CORPUS, 'baseline') : null);
  // `--write` without a path: arg('--write') might be the next flag. Handle both.
  const writeDir = has('--write')
    ? (arg('--write') && !arg('--write').startsWith('--') ? arg('--write') : join(DEFAULT_CORPUS, 'baseline'))
    : null;
  await runMetrics({
    corpus: arg('--corpus', DEFAULT_CORPUS),
    detectors: detArg.split(',').map(s => s.trim()).filter(Boolean),
    only: onlyArg ? new Set(onlyArg.split(',')) : null,
    write: writeDir,
    quiet: has('--quiet')
  });
}
