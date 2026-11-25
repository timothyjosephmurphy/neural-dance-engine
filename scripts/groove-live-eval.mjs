// Offline: the full live chain WITH the groove wire (what the dancers get) vs
// today's entrain-only bar. Per clip: share of the dancers' beat-1 steps that
// land on a true downbeat (+-70 ms), overall and while the groove drives;
// phrase starts vs labelled phrases (synthetic songs). Not shipped.
//   node scripts/groove-live-eval.mjs [--crop=sec] [--json=out.json] clip.json...
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {readWav} from '../tests/helpers/listen-corpus.mjs';
import {runChain} from './groove-chain-dump.mjs';

const TOL = 70;
const near = (t, arr) => arr.some(x => Math.abs(x - t) <= TOL);
export async function liveEval(jp, crop = 0) {
  const label = JSON.parse(readFileSync(jp, 'utf8'));
  let wavPath = resolve(dirname(jp), label.wav.replace(/^songs\//, '').replace(/^(synthetic|real)\//, ''));
  try { readFileSync(wavPath); } catch { wavPath = resolve(dirname(jp), '..', label.wav); }
  const {samples, sampleRate} = await readWav(wavPath);
  const cut = samples.subarray(Math.round(crop * sampleRate));
  const sh = a => (a || []).map(x => (x - crop) * 1000).filter(x => x >= 0);
  const downs = sh(label.downbeats), phrases = sh(label.phrases);
  let alt = null;
  const m = /^song-(.*)$/.exec(label.id);
  if (m) try { alt = sh(JSON.parse(readFileSync((process.env.ND_BT_RESULTS || 'bt-results') + `/song-${m[1]}.json`, 'utf8')).downbeats); } catch {}
  const frames = runChain(cut, sampleRate, {wire: true});
  const baseFrames = runChain(cut, sampleRate);
  const r = {id: label.id + (crop ? `@${crop}` : ''), base: [0, 0], wired: [0, 0], wiredApplied: [0, 0], baseSame: [0, 0], phrase: [0, 0], altW: [0, 0], altB: [0, 0], appliedShare: 0, entrainFrames: 0};
  for (const f of baseFrames) {
    const bt = f.P > 0 ? f.A + Math.round((f.t - f.A) / f.P) * f.P : f.t;
    if (f.dn) { r.base[1]++; if (near(bt, downs)) r.base[0]++; if (alt) { r.altB[1]++; if (near(bt, alt)) r.altB[0]++; } }
  }
  for (const f of frames) {
    if (f.P > 0) { r.entrainFrames++; if (f.wa) r.appliedShare++; }
    const bt = f.P > 0 ? f.A + Math.round((f.t - f.A) / f.P) * f.P : f.t;
    if (f.wd) {
      r.wired[1]++; const ok = near(bt, downs); if (ok) r.wired[0]++;
      if (alt) { r.altW[1]++; if (near(bt, alt)) r.altW[0]++; }
      if (f.wa) { r.wiredApplied[1]++; if (ok) r.wiredApplied[0]++; }
    }
    if (f.ps && phrases.length) { r.phrase[1]++; if (near(bt, phrases)) r.phrase[0]++; }
  }
  r.appliedShare = r.entrainFrames ? +(r.appliedShare / r.entrainFrames).toFixed(3) : 0;
  return r;
}
const pct = ([a, b]) => b ? +(a / b).toFixed(3) : null;
if (import.meta.url === 'file://' + process.argv[1]) {
  const args = process.argv.slice(2);
  const crop = +(args.find(a => a.startsWith('--crop=')) || '--crop=0').slice(7);
  const jsonOut = (args.find(a => a.startsWith('--json=')) || '').slice(7);
  const rows = [];
  for (const jp of args.filter(a => !a.startsWith('--'))) {
    const r = await liveEval(jp, crop); rows.push(r);
    console.log(r.id.padEnd(36), 'base', pct(r.base), 'wired', pct(r.wired), 'whileApplied', pct(r.wiredApplied), `(${r.wiredApplied[1]})`, 'applied', r.appliedShare, 'phrase', pct(r.phrase), r.altB[1] ? `alt base ${pct(r.altB)} wired ${pct(r.altW)}` : '');
  }
  const sum = k => { const a = [0, 0]; for (const r of rows) { a[0] += r[k][0]; a[1] += r[k][1]; } return pct(a); };
  console.log(`\n[pooled] base=${sum('base')} wired=${sum('wired')} whileApplied=${sum('wiredApplied')} phraseStarts=${sum('phrase')} altBase=${sum('altB')} altWired=${sum('altW')}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}
