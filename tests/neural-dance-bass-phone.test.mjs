// TJ 8:19 PM: bass barely fired live on the phone. Live 4-decimal data:
// bass flux max 0.0103 vs threshold p10 0.0095 (floor-limited, never masked),
// and phone mics put bass notes at 100-190 Hz, below the 190 Hz bass band.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BAND_SENS_RECOMMENDED, LISTEN_BAND_HZ, PHONE_BASS_HZ, createBandOnsets, isPhoneMic, listenBandsHz, trackMicTopHz} from '../neural-dance/src/band-onsets.js';
import * as C from './helpers/listen-corpus.mjs';

const root = new URL('..', import.meta.url).pathname;

test('phone mics (top below 6 kHz) widen the bass band down to 100 Hz; full-range mics keep 190-450', () => {
  assert.deepEqual(listenBandsHz(48000, 2951)[1], PHONE_BASS_HZ);
  assert.deepEqual(PHONE_BASS_HZ, [100, 450]);
  assert.deepEqual(listenBandsHz(48000, 0)[1], LISTEN_BAND_HZ[1]);
  assert.deepEqual(listenBandsHz(48000, 16000)[1], LISTEN_BAND_HZ[1]);
  assert.deepEqual(LISTEN_BAND_HZ[1], [190, 450]);
  assert.equal(isPhoneMic(800), false, 'near-silent mic is not classified');
  for (const top of [0, 3000, 16000]) assert.deepEqual(listenBandsHz(48000, top)[0], LISTEN_BAND_HZ[0], 'kick band never moves');
});

function phone(samples, sr, gain) {
  let out = C.roomReverb(samples, sr, {mix: 0.24});
  C.biquad(out, 'hp', 60, 0.7, sr); C.biquad(out, 'hp', 60, 0.7, sr);
  for (let i = 0; i < 3; i++) C.biquad(out, 'lp', 3400, 0.7, sr);
  C.addNoise(out, 0.006, 11);
  out = C.peakNormalize(out, 0.95);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

test('quiet phone (-40 dB) on real music: bass fires more and more accurately; raw onsets are in telemetry', async () => {
  const dir = join(root, 'tests/fixtures/listen-corpus/real');
  const name = 'real-marvman-5-4-b';
  const label = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'));
  const w = await C.readWav(join(dir, name + '.wav'));
  const sr = w.sampleRate || 48000;
  const samples = phone(w.samples || w.data || w.channels[0], sr, 0.01);
  const run = oldBand => {
    const d = createBandOnsets({levelFloor: true});
    let top = 0, last = null;
    const det = {process(bytes, s, fft, now, open, sens) {
      top = trackMicTopHz(top, bytes, s, fft, last == null ? 1 / 60 : (now - last) / 1000); last = now;
      const hz = listenBandsHz(s, top); if (oldBand) hz[1] = LISTEN_BAND_HZ[1];
      return d.process(bytes, s, fft, now, open, sens, hz);
    }};
    const res = C.runDetectorOnAudio(det, samples, sr, {sens: [...BAND_SENS_RECOMMENDED]});
    return {ev: C.evaluateClip(label, res), res, snap: d.snapshot()};
  };
  const before = run(true), after = run(false);
  assert.ok(after.ev.bands.bass.onset.f > before.ev.bands.bass.onset.f + 0.05, 'bass F ' + before.ev.bands.bass.onset.f + ' -> ' + after.ev.bands.bass.onset.f);
  assert.ok(after.ev.bands.bass.onset.recall > before.ev.bands.bass.onset.recall);
  assert.ok(after.ev.bands.kick.onset.f >= before.ev.bands.kick.onset.f - 0.02, 'kick unchanged');
  for (let b = 0; b < 4; b++) assert.equal(after.snap[b].onsets, after.res.onsets.filter(e => e.band === b).length, 'raw onset count band ' + b);
});

test('room-lab telemetry passes the detector snapshot (raw onsets per band) through listenTiming', () => {
  const src = readFileSync(join(root, 'neural-dance/room-lab.js'), 'utf8');
  assert.match(src, /listenTiming\(\)\{[^\n]*bandOnsets\.snapshot\(\)/);
});
