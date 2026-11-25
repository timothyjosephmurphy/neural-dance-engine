// Soak test (Nov 9): per-dancer state must stay bounded over a full show even
// though dancer ids keep growing (sticker re-scans, sim reseeds).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDancerEnergy, SONG_ENERGY_MAX_IDS, SONG_ENERGY_STALE_MS} from '../neural-dance/src/song-energy.js';

test('dancer energy windows for ids that stopped dancing are dropped', () => {
  const e = createDancerEnergy();
  for (let id = 1; id <= 300; id++) for (let t = 0; t < 2000; t += 100) e.process(id, t, 0.5);
  assert.equal(e.size(), 300);
  // A show keeps going with only a few live dancers.
  for (let t = 2000; t < SONG_ENERGY_STALE_MS + 5000; t += 100) for (let id = 1000; id < 1024; id++) e.process(id, t, 0.6);
  assert.ok(e.size() <= 24 + 1, 'kept ' + e.size());
  assert.ok(e.value(1000) != null);
});

test('few dancers are never pruned, even if idle', () => {
  const e = createDancerEnergy();
  for (let id = 1; id <= SONG_ENERGY_MAX_IDS; id++) e.process(id, 0, 0.4);
  e.process(1, SONG_ENERGY_STALE_MS * 3, 0.4);
  assert.equal(e.size(), SONG_ENERGY_MAX_IDS);
});

test('per-id caches in the pose code are capped', () => {
  const sil = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(sil, /show\.pulseHist\.size > 256\) show\.pulseHist\.clear\(\)/);
  const sk = readFileSync(new URL('../neural-dance/src/skeleton-dancer.js', import.meta.url), 'utf8');
  assert.match(sk, /builds\.size > 1024\) builds\.clear\(\)/);
});

test('live page resumes after a screen lock and bounds the audio resume', () => {
  const reload = readFileSync(new URL('../neural-dance/live-reload.js', import.meta.url), 'utf8');
  assert.match(reload, /addEventListener\('visibilitychange', handler, true\)/);
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /await boundedResume\(graph\)/);
});
