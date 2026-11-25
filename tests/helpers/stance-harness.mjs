// Stance harness (TJ Nov 10): replays the listen-corpus demo clips through the
// live silhouette show (same code as live, /sim and the side sim) and measures
// the lateral separation of the actual placed feet, in shoulder widths.
import {readFileSync} from 'node:fs';
import {createSilhouetteShow} from '../../neural-dance/src/silhouette.js';
import {buildFor, projectedStanceWidth, resetArmLiftFamilies} from '../../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel} from '../../neural-dance/src/skeleton-motion.js';

const corpus = new URL('../fixtures/listen-corpus/', import.meta.url);
export function corpusClips() {
  return JSON.parse(readFileSync(new URL('manifest.json', corpus), 'utf8')).clips.map(c => c.id + '|' + c.json);
}

function readWavMono(path) {
  const buf = readFileSync(path);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = {ch: buf.readUInt16LE(off + 10), sr: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22), fmt: buf.readUInt16LE(off + 8)};
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len + (len & 1);
  }
  const bps = fmt.bits / 8, n = Math.floor(data.length / (bps * fmt.ch));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bps;
      s += fmt.fmt === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : data.readInt32LE(o) / 2147483648;
    }
    out[i] = s / fmt.ch;
  }
  return {sr: fmt.sr, x: out};
}

// RMS envelope in 1/60 s frames, normalized to the clip's 95th percentile.
function envelope(wav, fps) {
  const hop = Math.round(wav.sr / fps), n = Math.floor(wav.x.length / hop), env = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) s += wav.x[i] * wav.x[i]; env[f] = Math.sqrt(s / hop); }
  const sorted = Array.from(env).sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let f = 0; f < n; f++) env[f] = Math.min(1.4, env[f] / p95);
  return env;
}

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}

const BAND_KEYS = ['kick', 'bass', 'snare', 'hat'];
// Replays one clip. `loops` repeats it so long runs can accumulate width;
// `drive` (0..1.5) scales how hard the pulse network feeds the dancers.
export function replayClip(clipEntry, {loops = 2, dancers = 8, fps = 60, drive = 1, onFrame = null} = {}) {
  const [id, jsonRel] = clipEntry.split('|');
  const meta = JSON.parse(readFileSync(new URL(jsonRel, corpus), 'utf8'));
  const wav = readWavMono(new URL(meta.wav, corpus));
  const env = envelope(wav, fps);
  resetBodyDynamics(); resetTravel(); resetArmLiftFamilies();
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = recorder();
  const markers = [];
  for (let i = 0; i < dancers; i++) markers.push({id: 100 + i, x: 110 + i * 110, y: 330 + (i % 2) * 60, type: i % 4, kind: 'sim'});
  const events = [];
  const dur = meta.duration;
  for (let L = 0; L < loops; L++) {
    for (let k = 0; k < 4; k++) for (const t of (meta.bands && meta.bands[BAND_KEYS[k]]) || []) events.push({t: t + L * dur, mask: 1 << k});
    if (!meta.bands) for (const t of meta.beats || []) events.push({t: t + L * dur, mask: 1});
  }
  events.sort((a, b) => a.t - b.t);
  const samples = [];
  let ei = 0;
  const frames = Math.floor(env.length * loops);
  const t0 = 1000;
  for (let f = 0; f < frames; f++) {
    const tS = f / fps, now = t0 + tS * 1000;
    let mask = 0;
    while (ei < events.length && events[ei].t <= tS) { mask |= events[ei].mask; ei++; }
    if (mask) show.beat(now, mask);
    const e = env[f % env.length];
    const levels = [e, e * 0.8, e * 0.9, e * 0.6];
    // Activation sweep: the pulse network drives some dancers harder than
    // others and a slow swell takes the whole room through low → peak.
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * tS / 9);
    const network = markers.map((m, i) => ({id: m.id, received: drive * e * (0.25 + 1.1 * swell) * (0.4 + 0.15 * i)}));
    show.paint(ctx, markers, {now, levels, network, songOpen: true, xy: (x, y) => ({x, y})});
    for (const r of show.figureHeights()) {
      const b = buildFor(r.id, r.band);
      const shPx = 2 * b.shW * r.height;
      const mid = side => {
        const toe = side < 0 ? r.footL : r.footR, heel = side < 0 ? r.heelL : r.heelR;
        return heel
          ? {x: (toe.x + heel.x) / 2, z: ((+toe.z || 0) + (+heel.z || 0)) / 2}
          : {x: toe.x, z: +toe.z || 0};
      };
      const mR = mid(1), mL = mid(-1);
      const j = r.joints;
      const sep = projectedStanceWidth(mL, mR, j && j.hipL, j && j.hipR) / shPx;
      const planted = (r.liftL || 0) < 0.5 && (r.liftR || 0) < 0.5;
      const s = {clip: id, t: tS, id: r.id, sep, planted, act: +r.activation || 0, hush: r.hush, tall: r.tall};
      samples.push(s);
      if (onFrame) onFrame(s, r);
    }
  }
  return samples;
}

export function stanceStats(samples) {
  const seps = samples.map(s => s.sep).sort((a, b) => a - b);
  const q = p => seps.length ? seps[Math.min(seps.length - 1, Math.floor(p * seps.length))] : 0;
  const wide = samples.filter(s => s.sep > 1.2), narrow = samples.filter(s => s.sep <= 1.2);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  // Pearson correlation between activation and separation.
  const ma = mean(samples.map(s => s.act)), ms = mean(samples.map(s => s.sep));
  let num = 0, da = 0, ds = 0;
  for (const s of samples) { num += (s.act - ma) * (s.sep - ms); da += (s.act - ma) ** 2; ds += (s.sep - ms) ** 2; }
  const acts = samples.map(s => s.act).sort((a, b) => a - b);
  const actP90 = acts[Math.floor(acts.length * 0.9)] || 0;
  return {
    n: samples.length, max: seps[seps.length - 1] || 0, p95: q(0.95), p50: q(0.5),
    wideFrac: wide.length / Math.max(1, samples.length),
    wideActMean: mean(wide.map(s => s.act)), narrowActMean: mean(narrow.map(s => s.act)),
    wideAtPeakFrac: wide.length ? wide.filter(s => s.act >= actP90 * 0.85).length / wide.length : 1,
    actP90, corr: da && ds ? num / Math.sqrt(da * ds) : 0
  };
}
