// Between-songs sticker scan (TJ, Nov 10 12:00 PM): a real song gap starts
// a Scan stickers refresh; a breakdown does not; music onset mid-scan aborts
// and keeps the previous sticker state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  BAND_ACTIVE, BAND_SILENCE, GAP_PLAY_MIN_MS, GAP_QUIET_MS, GAP_RATE_MS,
  allActiveBandsQuiet, createSongGapScan, gapScanSummary, matchScanIds,
  readGapScan, scanApplyOk, writeGapScan
} from '../neural-dance/src/song-gap-scan.js';
import {stickerHome} from '../neural-dance/src/silhouette.js';
import {FLASH_FADE_MS, runStickerFlash} from '../neural-dance/src/sticker-flash.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {freshShowState, reduceShowCommand} from '../neural-dance/src/show-commands.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'song-gap-1118-52064c5.json');
const EXTERNAL = process.env.ND_LISTEN_DROPOUT || '';

function feed(gap, {level = 0.7, bands = [1, 1, 1, 1], gate = true} = {}) {
  const t = {t: 0};
  return (dt, over = {}) => {
    t.t += dt;
    const lv = [0, 1, 2, 3].map(i => (bands[i] ? (over.level ?? level) : 0));
    if (over.lv) lv.splice(0, 4, ...over.lv);
    return gap.observe({t: t.t, lv, gate: over.gate ?? gate, listening: over.listening !== false});
  };
}

function playThen(gap, playMs, then) {
  const step = feed(gap);
  let left = playMs;
  let last = null;
  while (left > 0) {
    const dt = Math.min(100, left);
    last = step(dt);
    left -= dt;
  }
  return {step, last, t: playMs};
}

test('song gap: 20 s of music then 2.75 s of all-band silence starts a scan', () => {
  const gap = createSongGapScan();
  const {step, last} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  assert.equal(last.action, 'playing');
  assert.ok(last.playMs >= GAP_PLAY_MIN_MS);
  let ev = null;
  for (let i = 0; i < 30; i++) ev = step(100, {level: 0.02, gate: false});
  assert.equal(ev.action, 'start-scan', JSON.stringify(ev));
  assert.ok(ev.quietMs >= GAP_QUIET_MS);
});

test('breakdown: some bands stay up after a drop — not a song gap', () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  // Kick + hat keep going; bass + snare drop (a typical breakdown).
  let ev = null;
  for (let i = 0; i < 40; i++) ev = step(100, {lv: [0.65, 0.04, 0.03, 0.55], gate: true});
  assert.notEqual(ev.action, 'start-scan', 'breakdown must not start a scan: ' + ev.action);
  assert.ok(ev.action === 'playing' || ev.action === 'quiet');
  assert.equal(allActiveBandsQuiet([0.65, 0.04, 0.03, 0.55], 0b1111), false);
});

test('too-short drop after a long song is not a gap', () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  let ev = null;
  for (let i = 0; i < 20; i++) ev = step(100, {level: 0.02, gate: false});
  assert.ok(ev.quietMs < GAP_QUIET_MS);
  assert.equal(ev.action, 'quiet');
});

test('music for less than 20 s then silence does not start a scan', () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, 15000);
  let ev = null;
  for (let i = 0; i < 40; i++) ev = step(100, {level: 0.02, gate: false});
  assert.notEqual(ev.action, 'start-scan');
});

test('gate shut alone is not a gap if any recently-active band is still loud', () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  let ev = null;
  for (let i = 0; i < 40; i++) ev = step(100, {lv: [0.8, 0.6, 0.1, 0], gate: false});
  assert.notEqual(ev.action, 'start-scan', ev.action);
});

test('hat-silent mixes still detect a gap when the bands that played go quiet', () => {
  const gap = createSongGapScan();
  const step = feed(gap, {bands: [1, 1, 1, 0], level: 0.7});
  for (let i = 0; i < 210; i++) step(100);
  let ev = null;
  for (let i = 0; i < 30; i++) ev = step(100, {lv: [0.04, 0.03, 0.02, 0], gate: false});
  assert.equal(ev.action, 'start-scan', JSON.stringify(ev));
});

test('toggle off: a real gap does not start a scan', () => {
  const gap = createSongGapScan({enabled: false});
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  let ev = null;
  for (let i = 0; i < 30; i++) ev = step(100, {level: 0.02, gate: false});
  assert.equal(ev.action, 'disabled');
  gap.setEnabled(true);
  ev = step(100, {level: 0.02, gate: false});
  assert.equal(ev.action, 'start-scan');
});

test('rate limit: at most one start per 60 s', () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  for (let i = 0; i < 30; i++) step(100, {level: 0.02, gate: false});
  const first = step(100, {level: 0.02, gate: false});
  assert.equal(first.action, 'start-scan');
  gap.markScanStarted(GAP_PLAY_MIN_MS + 4000);
  gap.markScanFinished({state: 'done', count: 3, applied: true});
  // Next song + gap well under 60 s from the start.
  for (let i = 0; i < 220; i++) step(100, {level: 0.7, gate: true});
  let ev = null;
  for (let i = 0; i < 30; i++) ev = step(100, {level: 0.02, gate: false});
  assert.equal(ev.action, 'rate-limited', ev.action);
  assert.ok(GAP_RATE_MS >= 60000);
});

test('abort on music onset mid-scan; previous stickers are not applied', async () => {
  const gap = createSongGapScan();
  const {step} = playThen(gap, GAP_PLAY_MIN_MS + 500);
  for (let i = 0; i < 30; i++) step(100, {level: 0.02, gate: false});
  assert.equal(step(50, {level: 0.02, gate: false}).action, 'start-scan');
  gap.markScanStarted(GAP_PLAY_MIN_MS + 4000);
  const onset = step(100, {level: 0.7, gate: true});
  assert.equal(onset.action, 'abort');
  assert.equal(onset.reason, 'music-onset');
  const book = {markers: [{id: 1, x: 100, y: 200}]};
  const report = gap.markScanAborted({state: 'aborted', reason: 'Music started. Stickers unchanged.', count: book.markers.length});
  assert.equal(report.applied, false);
  assert.equal(book.markers[0].x, 100);

  // The flash helper itself must not call scan() once alive() flips.
  let scanned = false;
  const clock = {t: 0};
  const result = await runStickerFlash({
    show() {},
    wait: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    grab: () => ({data: new Uint8ClampedArray(16), width: 2, height: 2}),
    personInView: () => false,
    alive: () => clock.t < FLASH_FADE_MS + 200,
    scan: () => { scanned = true; return {ok: true, count: 9}; },
    report: () => {}
  });
  assert.equal(scanned, false);
  assert.equal(result.state, 'aborted');
  assert.match(result.reason, /music|unchanged/i);
});

test('captured 11:18 feed has gate dropouts and no song gap', () => {
  assert.ok(existsSync(FIXTURE), 'compact fixture missing');
  const samples = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.ok(samples.length > 500);
  const gap = createSongGapScan();
  const starts = [];
  const t0 = samples[0].t;
  for (const s of samples) {
    const ev = gap.observe({t: s.t, lv: s.lv, gate: s.gate, listening: true});
    if (ev.action === 'start-scan') starts.push((s.t - t0) / 1000);
  }
  assert.deepEqual(starts, [], 'feed must not look like a between-songs gap: ' + starts.join(','));
  // Also parse the original jsonl when it is on this machine.
  if (existsSync(EXTERNAL)) {
    const gap2 = createSongGapScan();
    const starts2 = [];
    const raw = readFileSync(EXTERNAL, 'utf8').split('\n');
    for (const line of raw) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      const m = o.m;
      if (!m || m.type !== 'audio') continue;
      for (const s of m.samples || []) {
        const ev = gap2.observe({t: s.t, lv: s.lv, gate: s.gate, listening: true});
        if (ev.action === 'start-scan') starts2.push(s.t);
      }
    }
    assert.deepEqual(starts2, []);
  }
});

test('high-confidence apply: keep previous if empty or a blob explosion', () => {
  assert.equal(scanApplyOk({prevCount: 4, nextCount: 4, whiteOk: true}).ok, true);
  assert.equal(scanApplyOk({prevCount: 0, nextCount: 3, whiteOk: true}).ok, true);
  assert.equal(scanApplyOk({prevCount: 4, nextCount: 0, whiteOk: true}).ok, false);
  assert.equal(scanApplyOk({prevCount: 4, nextCount: 20, whiteOk: true}).ok, false);
  assert.equal(scanApplyOk({prevCount: 4, nextCount: 4, whiteOk: false}).ok, false);
});

test('matchScanIds keeps previous sticker ids for nearby hits', () => {
  const prev = [{id: 7, x: 100, y: 200}, {id: 8, x: 400, y: 200}];
  const next = [{x: 108, y: 196}, {x: 700, y: 180}, {x: 395, y: 210}];
  const matched = matchScanIds(prev, next, 80);
  const byId = new Map(matched.filter(p => p.id).map(p => [p.id, p]));
  assert.equal(byId.get(7).x, 108);
  assert.equal(byId.get(8).x, 395);
  assert.equal(matched.filter(p => !p.id).length, 1);
});

test('committed sticker home snaps; planted feet then step, they do not glide', () => {
  const homes = new Map();
  stickerHome(homes, 1, 100, 200, 80, 0);
  // A mid-show re-detect 40 px away would wait and then glide. A committed
  // between-songs scan snaps the home the feet should walk to.
  const held = stickerHome(homes, 1, 140, 200, 80, 1000);
  assert.equal(held.x, 100, 'uncommitted mid-move must not snap');
  const snapped = stickerHome(homes, 1, 140, 200, 80, 2000, true);
  assert.equal(snapped.x, 140);
  assert.equal(snapped.y, 200);
});

test('toggle defaults on and persists; debug patch and show command accept it', () => {
  const mem = new Map();
  const storage = {getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v))};
  assert.equal(readGapScan(storage), true);
  writeGapScan(storage, false);
  assert.equal(readGapScan(storage), false);
  writeGapScan(storage, true);
  assert.equal(readGapScan(storage), true);

  const patch = sanitizeDebugPatch({gapScan: false});
  assert.equal(patch.gapScan, false);
  assert.equal(sanitizeDebugPatch({gapScan: true}).gapScan, true);
  assert.equal(sanitizeDebugPatch({gapScan: 'maybe'}), null);

  const state = reduceShowCommand(freshShowState(), {gapScan: false});
  assert.equal(state.gapScan, false);
  const toggled = reduceShowCommand(state, {action: 'toggle-gap-scan'});
  assert.equal(toggled.gapScan, true);
  assert.equal(freshShowState().gapScan, true);
});

test('debug and live pages expose the toggle and the last-scan field', () => {
  const live = readFileSync(join(HERE, '..', 'src/pages/neural-dance/live/index.astro'), 'utf8');
  const debug = readFileSync(join(HERE, '..', 'src/pages/neural-dance/debug/index.astro'), 'utf8');
  assert.match(live, /data-gap-scan/);
  assert.match(debug, /data-debug-gap-scan/);
  assert.match(debug, /data-debug-gap-scan-status/);
  assert.match(debug, /Between-songs scan: not run yet/);
  assert.equal(gapScanSummary(null), 'Between-songs scan: not run yet');
  assert.match(gapScanSummary({state: 'done', count: 3, applied: true, at: 0}), /3 stickers latched/);
  assert.match(gapScanSummary({state: 'aborted', reason: 'Music started. Stickers unchanged.'}), /aborted/);
});

void BAND_SILENCE;
void BAND_ACTIVE;
