// TJ 8:12 PM: level-adaptive per-band floors (quiet phone mics), recommended
// band sens defaults + one-time migration, debug "Reset band sens to
// recommended", 4-decimal flux/threshold telemetry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BAND_SENS_RECOMMENDED, createBandOnsets, listenBandsHz, trackMicTopHz} from '../neural-dance/src/band-onsets.js';
import {migrateBandSensDefaults, BAND_SENS_DEFAULTS_KEY, ROOM_KEY, readRoomSettings} from '../neural-dance/room-lab.js';
import {bandSensResetPatch, CONTROL_FIELDS} from '../neural-dance/debug-viewer.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import * as C from './helpers/listen-corpus.mjs';

const root = new URL('..', import.meta.url).pathname;
function store(init = {}) {
  const m = new Map(Object.entries(init));
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m};
}

test('recommended defaults: Kick 2.25, Bass 1.1, Snare 1.0, Hi-hat 3 on every page', () => {
  assert.deepEqual([...BAND_SENS_RECOMMENDED], [2.25, 1.1, 1.0, 3]);
  for (const page of ['src/pages/neural-dance/index.astro', 'src/pages/neural-dance/live/index.astro']) {
    const html = readFileSync(join(root, page), 'utf8');
    ['2.25', '1.1', '1', '3'].forEach((v, b) => assert.match(html, new RegExp('data-control="sens" data-band="' + b + '"[^>]*value="' + v.replace('.', '\\.') + '"'), page + ' band ' + b));
  }
  const debug = readFileSync(join(root, 'src/pages/neural-dance/debug/index.astro'), 'utf8');
  ['2.25', '1.1', '1', '3'].forEach((v, b) => assert.match(debug, new RegExp('data-debug-control="sens-' + b + '"[^>]*value="' + v.replace('.', '\\.') + '"')));
  assert.match(debug, /data-debug-sens-reset[^>]*>Reset band sens to recommended</);
});

test('one-time migration resets saved band sens to the recommended defaults, then leaves later changes alone', () => {
  const s = store({[ROOM_KEY]: JSON.stringify({sens: [2.25, 1.55, 3, 2.95], gravity: 6})});
  assert.equal(migrateBandSensDefaults(s), true);
  assert.equal(s.getItem(BAND_SENS_DEFAULTS_KEY), '1');
  const after = readRoomSettings(s);
  assert.deepEqual(after.sens, [2.25, 1.1, 1, 3]);
  assert.equal(after.gravity, 6, 'other settings kept');
  // TJ tweaks a slider afterwards: a reload keeps it.
  const data = JSON.parse(s.getItem(ROOM_KEY)); data.sens[3] = 2.5; s.setItem(ROOM_KEY, JSON.stringify(data));
  assert.equal(migrateBandSensDefaults(s), false);
  assert.equal(readRoomSettings(s).sens[3], 2.5);
  // Fresh device: nothing saved, key set, defaults come from the page.
  const fresh = store();
  assert.equal(migrateBandSensDefaults(fresh), true);
  assert.equal(fresh.getItem(ROOM_KEY), null);
  const src = readFileSync(join(root, 'neural-dance/room-lab.js'), 'utf8');
  assert.match(src, /migrateBandSensDefaults\(null\);\}catch\{\}\n\s*try\{saved=readRoomSettings/);
  assert.match(src, /bandSens=BAND_SENS_RECOMMENDED\.slice\(\);/);
});

test('debug reset button: sets the four sliders and sends one sanitized patch to the phone', () => {
  const inputs = [0, 1, 2, 3].map(() => ({value: '0.5'}));
  const doc = {querySelector: sel => { const m = /sens-(\d)/.exec(sel); return m ? inputs[+m[1]] : null; }};
  const patch = bandSensResetPatch(doc);
  assert.deepEqual(inputs.map(i => +i.value), [2.25, 1.1, 1, 3]);
  assert.deepEqual(Object.keys(patch), ['sens-0', 'sens-1', 'sens-2', 'sens-3'].map(k => CONTROL_FIELDS[k]));
  const clean = sanitizeDebugPatch(patch);
  assert.deepEqual(clean.sens, [2.25, 1.1, 1, 3]);
});

function phone(samples, sr, gain) {
  let out = C.roomReverb(samples, sr, {mix: 0.24});
  C.biquad(out, 'hp', 150, 0.7, sr); C.biquad(out, 'hp', 150, 0.7, sr);
  for (let i = 0; i < 3; i++) C.biquad(out, 'lp', 3400, 0.7, sr);
  C.addNoise(out, 0.006, 11);
  out = C.peakNormalize(out, 0.95);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}
function liveDetector(levelFloor) {
  const d = createBandOnsets({levelFloor});
  let top = 0, last = null;
  return {d, process(bytes, sr, fft, now, open, sens) {
    top = trackMicTopHz(top, bytes, sr, fft, last == null ? 1 / 60 : (now - last) / 1000); last = now;
    return d.process(bytes, sr, fft, now, open, sens, listenBandsHz(sr, top));
  }};
}

test('quiet phone mic (-40 dB, top ~3.9 kHz): adaptive floors bring back snare/mid and bass', async () => {
  const corpus = join(root, 'tests/fixtures/listen-corpus');
  const label = JSON.parse(readFileSync(join(corpus, 'synthetic/syn-4-4-phone-mic-120.json'), 'utf8'));
  const w = await C.readWav(join(corpus, 'synthetic/syn-4-4-phone-mic-120.wav'));
  const samples = phone(w.samples || w.data || w.channels[0], w.sampleRate || 48000, 0.01);
  const score = levelFloor => {
    const det = liveDetector(levelFloor);
    const res = C.runDetectorOnAudio(det, samples, w.sampleRate || 48000, {sens: [...BAND_SENS_RECOMMENDED]});
    return {ev: C.evaluateClip(label, res), snap: det.d.snapshot()};
  };
  const before = score(false).ev, {ev: after, snap} = score(true);
  assert.ok(before.bands.mid.onset.recall < 0.35, 'old fixed floor: mid ' + before.bands.mid.onset.recall);
  assert.ok(after.bands.mid.onset.f > 0.7, 'adaptive: mid F ' + after.bands.mid.onset.f);
  assert.ok(after.bands.bass.onset.recall >= before.bands.bass.onset.recall, 'bass not worse');
  // Telemetry keeps 4 decimals (0.1 rounding read every live value as 0).
  assert.ok(snap.some(b => b.threshold > 0 && b.threshold < 0.05), 'small thresholds survive rounding: ' + JSON.stringify(snap));
  assert.ok(snap.every(b => Number.isFinite(b.level)));
});

test('quiet room noise does not fire kick or bass more with adaptive floors', () => {
  const sr = 48000;
  for (const db of [-50, -70]) {
    const s = new Float32Array(sr * 12); C.addNoise(s, Math.pow(10, db / 20), 3); C.biquad(s, 'lp', 4000, 0.7, sr);
    const count = lf => { const r = C.runDetectorOnAudio(createBandOnsets({levelFloor: lf}), s, sr, {sens: [...BAND_SENS_RECOMMENDED]}); return [0, 1, 2, 3].map(b => r.onsets.filter(e => e.band === b).length); };
    const off = count(false), on = count(true);
    assert.ok(on[0] <= off[0] + 1 && on[1] <= off[1] + 2 && on[2] <= 1 && on[3] <= 1, db + ' dB noise onsets ' + on + ' vs ' + off);
  }
});
