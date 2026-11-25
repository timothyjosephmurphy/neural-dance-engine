// Offline: run the live Listen chain (band-onsets + silence gate + global
// tempo + coupler + listen-pattern + song-tempo-lock + beat-entrain), frame
// by frame at the live page cadence, on corpus / song WAVs and cache what the
// groove learner sees (entrain grid, heard onsets) plus the labels.
// Not shipped. Usage:
//   node scripts/groove-chain-dump.mjs <out-dir> [clip.json ...] [--crop=<sec>] [--suffix=x]
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {readWav} from '../tests/helpers/listen-corpus.mjs';
import {createAnalyser, frameTimes} from '../tests/helpers/listen-sim.mjs';
import {createBandOnsets} from '../neural-dance/src/band-onsets.js';
import {createGlobalTempo, createBandAgreement} from '../neural-dance/src/global-tempo.js';
import {createListenPattern, createCoupler} from '../neural-dance/src/listen-pattern.js';
import {createSongTempoLock} from '../neural-dance/src/song-tempo-lock.js';
import {createBeatEntrain} from '../neural-dance/src/beat-entrain.js';
import {createGrooveLearner} from '../neural-dance/src/groove-learn.js';
import {createGrooveWire} from '../neural-dance/src/groove-wire.js';
import '../neural-dance/silence-gate.js';

export function runChain(samples, sampleRate, {fft = 2048, seed = 3, wire: useWire = false} = {}) {
  const dur = samples.length / sampleRate;
  const an = createAnalyser(fft), det = createBandOnsets(), gt = createGlobalTempo(), pat = createListenPattern();
  const song = createSongTempoLock(), ent = createBeatEntrain(), coupler = createCoupler(), agree = createBandAgreement();
  const coupled = {ratio: new Float64Array(4), free: [false, false, false, false], period: new Float32Array(4)};
  const lib = globalThis.ndSilenceGate, gate = lib.create();
  const frames = [];
  const wire = useWire ? createGrooveWire({groove: createGrooveLearner(), entrain: ent}) : null;
  let last = 0;
  for (const now of frameTimes(dur * 1000, {seed})) {
    const bytes = an.at(samples, Math.floor(now / 1000 * sampleRate));
    lib.scale(gate, lib.bandPeaks(bytes, sampleRate, fft), Math.max(0.001, (now - last) / 1000)); last = now;
    const sens = [1, 1, 1, 1];
    const info = det.process(bytes, sampleRate, fft, now, gate.open, sens);
    const g = gt.process(now, info.flux, gate.open, info);
    coupler.update(info.period, now, g.locked ? g.period : 0, coupled); agree.update(info, g, coupled.ratio);
    song.update(now, g.locked ? g.bpm : 0, !!gate.open, {kick: !!((info.onsets | 0) & 1), drop: false, onset: !!((info.onsets | 0) & 3)});
    const p = pat.process(info, now, sens);
    let hits = p.beats | 0; if (!gate.open) hits = 0;
    if (wire) wire.feed(now, {gateOpen: !!gate.open, bandInfo: info, gt: g, entrainActive: ent.state.P > 0 && ent.state.anchor >= 0});
    const last0 = frames.length ? frames[frames.length - 1].t : 0;
    const e = ent.step(now, {bpm: song.state.locked ? song.state.bpm : 0, gateOpen: !!gate.open, onsets: gate.open ? info.onsets | 0 : 0, heard: hits, period: g.locked ? coupled.period : p.period});
    const on = gate.open ? info.onsets | 0 : 0;
    const f = {t: +now.toFixed(2), g: gate.open ? 1 : 0, P: e.active ? +ent.state.P.toFixed(3) : 0, A: e.active ? +ent.state.anchor.toFixed(2) : 0,
      bb: e.active ? e.info.barBeat : -1, dn: e.downbeat ? 1 : 0, m: e.mask, on, gP: g.locked ? +g.period.toFixed(3) : 0, gN: g.locked ? +g.next.toFixed(2) : 0};
    if (wire) { wire.decorate(now, e); if (useWire === 'trace') { const o = wire.groove.state; f.gv = [+o.confidence.toFixed(3), o.active ? 1 : 0, o.beatInBar, o.barInPhrase, o.phraseBars, +o.swing.toFixed(2), o.meter, +o.clockShift.toFixed(2), +o.barPhase.toFixed(3)]; if (Math.floor(now / 500) !== Math.floor(last0 / 500)) f.tm = Array.from(o.template, x => +x.toFixed(2)); } if (useWire === 'trace' && Math.floor(now / 3000) !== Math.floor(last0 / 3000)) { const g = wire.snapshot(), I = wire.groove.internals; f.snap = {conf: g.confidence, bars: I.bars, phraseBars: I.phraseBars, phraseOff: I.phraseOff, nov: I.phraseFromNovelty, startBeat: I.startBeat, down8: I.down8, relearns: I.relearns, resets: I.resets}; } f.wd = e.active && e.downbeat ? 1 : 0; f.wa = wire.state.applied ? 1 : 0; f.ps = wire.phrase.start ? 1 : 0; if (e.mask && wire.state.applied) f.acc = Array.from(e.info.accent, x => +x.toFixed(2)); }
    if (on) {
      f.ot = []; f.w = [];
      for (let b = 0; b < 4; b++) if (on & (1 << b)) {
        f.ot.push(+info.onsetTime[b].toFixed(2));
        const thr = info.threshold ? +info.threshold[b] : 0;
        f.w.push(+(thr > 0 ? Math.min(4, info.flux[b] / thr) : 1).toFixed(2));
      }
    }
    frames.push(f);
  }
  if (wire) frames.wire = wire;
  return frames;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const args = process.argv.slice(2);
  const outDir = args[0]; mkdirSync(outDir, {recursive: true});
  const crop = +(args.find(a => a.startsWith('--crop=')) || '--crop=0').slice(7);
  const suffix = (args.find(a => a.startsWith('--suffix=')) || '--suffix=').slice(9);
  for (const jp of args.slice(1).filter(a => !a.startsWith('--'))) {
    const label = JSON.parse(readFileSync(jp, 'utf8'));
    let wavPath = resolve(dirname(jp), label.wav.replace(/^songs\//, '').replace(/^(synthetic|real)\//, ''));
    try { readFileSync(wavPath, {flag: 'r'}).length; } catch { wavPath = resolve(dirname(jp), '..', label.wav); }
    const {samples, sampleRate} = await readWav(wavPath);
    const s0 = Math.round(crop * sampleRate);
    const cut = samples.subarray(s0);
    const shift = a => (a || []).map(x => +(x - crop).toFixed(4)).filter(x => x >= 0);
    const t0 = performance.now();
    const frames = runChain(cut, sampleRate);
    const id = label.id + suffix;
    writeFileSync(`${outDir}/${id}.json`, JSON.stringify({id, meter: label.meter && label.meter.label, tempo: label.tempo, crop,
      beats: shift(label.beats), downbeats: shift(label.downbeats), duration: cut.length / sampleRate, provenance: label.provenance, frames}));
    console.log(id, frames.length, 'frames', ((performance.now() - t0) / 1000).toFixed(1) + 's');
  }
}
