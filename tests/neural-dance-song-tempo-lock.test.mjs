// One stable BPM per song (TJ, Nov 11): learn 4-8 bars, lock, only re-learn
// after a song gap or >8 bars of a different, consistent tempo. Off-grid
// attacks (syncopation, half/double, triplets) never move the lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSongTempoLock, songRatio, onsetFit, GAP_MS, LEARN_MIN_BARS, LEARN_MAX_BARS, RECHECK_MS} from '../neural-dance/src/song-tempo-lock.js';
import {createGlobalTempo} from '../neural-dance/src/global-tempo.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const bars = (n, bpm) => n * 4 * 60000 / bpm;
function rng(seed) { let r = seed; return () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }

// Feed per-frame estimates: est(t) -> bpm (0 = none), sound(t) -> bool.
function run(lock, t0, t1, est, sound = () => true, frame = 16.7, extra = null) {
  const log = [];
  for (let t = t0; t < t1; t += frame) {
    const s = lock.update(t, est(t), sound(t), extra ? extra(t) : undefined);
    log.push({t, locked: s.locked, bpm: s.bpm});
  }
  return log;
}

test('song ratios: half/double/triplet/2:3 are the same song', () => {
  for (const r of [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3]) assert.ok(songRatio(120 * r, 120), 'ratio ' + r);
  assert.equal(songRatio(140, 120), 0);
  assert.equal(songRatio(100, 120), 0);
});

test('learns the BPM in 4-8 bars, then locks it exactly (no drift following)', () => {
  const lock = createSongTempoLock();
  const rnd = rng(3);
  // Learning: noisy estimates around 124 with an occasional octave error.
  const log = run(lock, 0, bars(10, 124), () => (rnd() < 0.1 ? 62 : 124 * (1 + (rnd() - 0.5) * 0.03)));
  const first = log.find(l => l.locked);
  assert.ok(first, 'locks');
  assert.ok(first.t >= bars(LEARN_MIN_BARS, 124) - 50, 'not before 4 bars (' + Math.round(first.t) + ' ms)');
  assert.ok(first.t <= bars(LEARN_MAX_BARS, 124) + 50, 'by 8 bars (' + Math.round(first.t) + ' ms)');
  const locked = lock.state.bpm;
  assert.ok(Math.abs(locked - 124) < 1.5, 'locked ' + locked);
  for (const l of log.filter(l => l.t > first.t)) assert.equal(l.bpm, locked, 'no re-estimation once locked');
  // Upstream sits 1.5% off for 3 minutes (detector bias, not a new track):
  // the background re-checks run but the lock value never moves.
  run(lock, bars(10, 124), bars(10, 124) + 180000, () => 124 * 1.015);
  assert.equal(lock.state.bpm, locked);
  assert.ok(lock.state.rechecks >= 2, 'rechecks ran: ' + lock.state.rechecks);
});

test('tempo lock survives syncopated fills and breakdowns', () => {
  const lock = createSongTempoLock();
  const rnd = rng(11);
  const bpm = 128;
  run(lock, 0, bars(8, bpm), () => bpm * (1 + (rnd() - 0.5) * 0.02));
  assert.ok(lock.state.locked);
  const locked = lock.state.bpm;
  let t = bars(8, bpm);
  const sections = [
    // Syncopated fill: the detector hears the off-beats and triplets.
    [4, () => [bpm * 1.5, bpm * 2, bpm * 2 / 3, bpm * 3, bpm / 2][Math.floor(rnd() * 5)]],
    // Snare roll / garbage that never agrees with itself.
    [3, () => 70 + rnd() * 110],
    // Breakdown: kick drops out, pads only (no estimate at all) for 16 bars.
    [16, () => 0],
    // Breakdown with a wandering, inconsistent estimate for 8 bars.
    [8, () => (rnd() < 0.5 ? 0 : 90 + rnd() * 80)],
    // A short real hush inside the song (1.5 s, below the gap rule).
    [0, null],
    // Drop: back on the grid.
    [8, () => bpm],
  ];
  for (const [n, est] of sections) {
    if (!est) { run(lock, t, t + 1500, () => 0, () => false); t += 1500; continue; }
    const log = run(lock, t, t + bars(n, bpm), est);
    for (const l of log) { assert.ok(l.locked, 'stays locked'); assert.equal(l.bpm, locked, 'BPM unchanged at ' + Math.round(l.t)); }
    t += bars(n, bpm);
  }
  assert.equal(lock.state.relearns, 0);
});

test('re-locks after a song gap (new song, new BPM)', () => {
  const lock = createSongTempoLock();
  run(lock, 0, bars(12, 120), () => 120);
  assert.ok(lock.state.locked && Math.abs(lock.state.bpm - 120) < 0.5);
  let t = bars(12, 120);
  run(lock, t, t + GAP_MS + 300, () => 0, () => false); // song gap
  t += GAP_MS + 300;
  assert.ok(lock.state.locked, 'quiet alone keeps the old lock until music returns');
  const log = run(lock, t, t + bars(10, 96), () => 96);
  assert.equal(log[0].locked, false, 'new song starts learning');
  const relock = log.find(l => l.locked);
  assert.ok(relock, 're-locks');
  assert.ok(relock.t - t <= bars(LEARN_MAX_BARS, 96) + 50, 're-lock within 8 bars');
  assert.ok(Math.abs(lock.state.bpm - 96) < 0.5, 'new lock ' + lock.state.bpm);
  assert.equal(lock.state.relearns, 1);
  assert.equal(lock.state.reason, 'learned');
});

test('only a sustained (>8 bar) consistent mismatch moves the lock', () => {
  const lock = createSongTempoLock();
  run(lock, 0, bars(8, 120), () => 120);
  const t = bars(8, 120);
  run(lock, t, t + bars(6, 120), () => 140);
  assert.ok(Math.abs(lock.state.bpm - 120) < 0.5, '6 bars of 140 do not move it');
  run(lock, t + bars(6, 120), t + bars(7, 120), () => 120); // back on grid: candidate cleared
  run(lock, t + bars(7, 120), t + bars(14, 120), () => 140);
  assert.ok(Math.abs(lock.state.bpm - 120) < 0.5, 'restarted count');
  run(lock, t + bars(14, 120), t + bars(17, 120), () => 140);
  assert.ok(Math.abs(lock.state.bpm - 140) < 0.5, '>8 bars of 140 re-locks (' + lock.state.bpm + ')');
  assert.equal(lock.state.reason, 'mismatch');
});

test('end to end: global-tempo through the song lock holds through fills and a breakdown', () => {
  const gt = createGlobalTempo();
  const lock = createSongTempoLock();
  const rnd = rng(5);
  const bpm = 126, P = 60000 / bpm;
  const flux = new Float32Array(4);
  const info = {onsets: 0, onsetTime: new Float64Array(4)};
  const hits = [[], [], [], []];
  // 0-30 s groove, 30-38 s fills (off-beats, triplets), 38-60 s breakdown
  // (no kick, sparse mid stabs), 60-80 s drop.
  for (let t = 300; t < 80000; t += P) {
    const fill = t >= 30000 && t < 38000, brk = t >= 38000 && t < 60000;
    if (!brk) hits[0].push(t);
    if (!brk && rnd() < 0.8) hits[2].push(t + P / 2);
    if (fill) { hits[1].push(t + P / 3); hits[1].push(t + 2 * P / 3); if (rnd() < 0.5) hits[0].push(t + 3 * P / 4); }
    if (brk && rnd() < 0.35) hits[2].push(t + rnd() * P);
    hits[3].push(t + P / 4, t + 3 * P / 4);
  }
  const idx = [0, 0, 0, 0];
  let lockedAt = -1, value = 0, changed = 0;
  for (let now = 0; now < 80000; now += 16.7 + (rnd() - 0.5) * 4) {
    flux.fill(0.3); info.onsets = 0;
    for (let b = 0; b < 4; b++) while (idx[b] < hits[b].length && hits[b][idx[b]] <= now) { flux[b] = 8; info.onsets |= 1 << b; info.onsetTime[b] = hits[b][idx[b]]; idx[b]++; }
    const g = gt.process(now, flux, true, info);
    const s = lock.update(now, g.locked ? g.bpm : 0, true);
    if (s.locked && lockedAt < 0) { lockedAt = now; value = s.bpm; }
    if (s.locked && s.bpm !== value) changed++;
  }
  assert.ok(lockedAt > 0 && lockedAt < 20000, 'locks early (' + Math.round(lockedAt) + ' ms)');
  assert.ok(songRatio(value, bpm, 0.03), 'locked ' + value + ' ~ ' + bpm);
  assert.equal(changed, 0, 'one BPM for the whole song');
});

test('DJ crossfade 124 -> 128 with no silence re-locks within ~2 min', () => {
  const lock = createSongTempoLock();
  const rnd = rng(21);
  const noise = () => 1 + (rnd() - 0.5) * 0.012;
  run(lock, 0, 40000, () => 124 * noise());
  assert.ok(lock.state.locked && Math.abs(lock.state.bpm - 124) < 0.7);
  // 16-bar blend (~31 s), then the new track alone; never quiet.
  const x0 = 40000, x1 = x0 + bars(16, 126);
  const est = t => (t < x1 ? 124 + 4 * (t - x0) / (x1 - x0) : 128) * noise();
  const log = run(lock, x0, x1 + 150000, est);
  for (const l of log) assert.ok(l.locked, 'never drops the lock during the blend');
  const moved = log.find(l => Math.abs(l.bpm - 128) < 0.7);
  assert.ok(moved, 're-locks to 128 (now ' + lock.state.bpm + ')');
  assert.ok(moved.t - x1 <= 120000, 're-locked ' + Math.round((moved.t - x1) / 1000) + ' s after the blend');
  assert.equal(lock.state.reason, 'recheck');
  // The blend itself is never adopted as an in-between tempo.
  for (const l of log) assert.ok(Math.abs(l.bpm - 124) < 0.5 || Math.abs(l.bpm - 128) < 0.5, 'no in-between lock ' + l.bpm);
});

test('fills, half-time and no-drop breakdowns at the same tempo keep the lock for 5 minutes', () => {
  const lock = createSongTempoLock();
  const rnd = rng(9);
  const bpm = 124, bar = bars(1, bpm);
  run(lock, 0, bars(8, bpm), () => bpm, () => true, 16.7, () => ({kick: true}));
  const locked = lock.state.bpm;
  const t0 = bars(8, bpm);
  // Every 32 bars: 24 bars groove (some fills), 8 bars breakdown (no kick,
  // estimates missing or half-time), ending without a drop.
  const phase = t => ((t - t0) / bar) % 32;
  const est = t => {
    const p = phase(t);
    if (p >= 24) return rnd() < 0.6 ? 0 : bpm / 2 * (1 + (rnd() - 0.5) * 0.01);
    if (p >= 20 && rnd() < 0.3) return [bpm * 2, bpm / 2, bpm * 1.5][Math.floor(rnd() * 3)]; // fills
    return bpm * (1 + (rnd() - 0.5) * 0.012);
  };
  let kickNext = t0;
  const extra = t => {
    if (phase(t) >= 24) return {kick: false};
    if (t >= kickNext) { kickNext += 60000 / bpm; return {kick: true, drop: false}; }
    return {kick: false};
  };
  const log = run(lock, t0, t0 + 300000, est, () => true, 16.7, extra);
  for (const l of log) { assert.ok(l.locked); assert.equal(l.bpm, locked, 'unchanged at ' + Math.round(l.t / 1000) + ' s'); }
  assert.ok(lock.state.rechecks >= 6, 'timed + post-breakdown rechecks ran: ' + lock.state.rechecks);
  assert.equal(lock.state.relearns, 0);
});

test('a breakdown that ends without a drop re-checks at once; with a drop it waits for the timer', () => {
  for (const drop of [false, true]) {
    const lock = createSongTempoLock();
    const kicks = bpm => { let next = -1; return t => { if (next < 0) next = t; if (t >= next) { next += 60000 / bpm; return {kick: true, drop}; } return {kick: false}; }; };
    run(lock, 0, bars(8, 124), () => 124, () => true, 16.7, kicks(124));
    const lockedAt = lock.state.lockedAt;
    let t = bars(8, 124);
    run(lock, t, t + bars(8, 124), () => 0, () => true, 16.7, () => ({kick: false})); // breakdown, pads only
    t += bars(8, 124);
    assert.ok(lock.state.breakdown);
    const log = run(lock, t, t + bars(14, 128), () => 128, () => true, 16.7, kicks(128));
    const moved = log.find(l => Math.abs(l.bpm - 128) < 0.5);
    if (!drop) {
      assert.ok(moved, 'no-drop breakdown end triggers a re-check');
      assert.ok(moved.t - t <= bars(10, 128), 're-locked ' + Math.round((moved.t - t) / 1000) + ' s after the breakdown');
      assert.ok(moved.t - lockedAt < RECHECK_MS, 'before the timed re-check');
    } else {
      assert.ok(!moved || moved.t - lockedAt >= RECHECK_MS - 20, 'a drop does not force an early re-check');
    }
  }
});

test('re-check cadence is configurable within 1-2 minutes', () => {
  assert.equal(createSongTempoLock().snapshot().recheckMs, RECHECK_MS);
  assert.ok(RECHECK_MS >= 60000 && RECHECK_MS <= 90000);
  assert.equal(createSongTempoLock({recheckMs: 10000}).snapshot().recheckMs, 60000);
  assert.equal(createSongTempoLock({recheckMs: 600000}).snapshot().recheckMs, 120000);
  assert.equal(createSongTempoLock({recheckMs: 90000}).snapshot().recheckMs, 90000);
});

test('live and side sim both feed the pulse emit interval from the song lock', () => {
  const lab = read('neural-dance/room-lab.js');
  assert.match(lab, /import \{createSongTempoLock\} from '\.\/src\/song-tempo-lock\.js'/);
  assert.match(lab, /function tempoReset\(\)\{songTempo\.reset\(\);/);
  assert.match(lab, /api\.nd_set_emit_bpm\(songTempo\.state\.locked\?songTempo\.state\.bpm:0\)/);
  assert.match(lab, /songTempo\.update\(now,gtState&&gtState\.locked\?gtState\.bpm:0,!!gate\.open,\{kick:!!\(\(bandInfo\.onsets\|0\)&1\),drop:false,onset:!!\(\(bandInfo\.onsets\|0\)&3\)\}\)/);
  const sim = read('static/neural-dance/sim/index.html');
  assert.match(sim, /import \* as songLock from '\/neural-dance\/src\/song-tempo-lock\.js'/);
  assert.match(sim, /lock\.update\(tSec \* 1000, per > 0\.25 && per < 1\.6 \? 60 \/ per : 0, !silent, \{ kick: hits\.some\(h => h\.band === 'bass'\), drop: false, onset: hits\.some\(h => h\.band === 'bass'\) \}\)/);
  assert.match(sim, /lv\.lockedBpm != null \? \+lv\.lockedBpm \|\| 0/);
});

// TJ's live feed, Nov 11 4:15-4:22 PM PT (iPhone mic): the upstream lock
// wandered 101 -> 141 -> 126 -> 137 -> 115 -> 95 on one groove, and the song lock
// followed it through the mismatch path. Real kick/bass onsets never backed
// any of those moves, so with onset evidence the lock holds; only the two real
// silences re-learn.
function replayRec1600(withOnsets) {
  const fx = JSON.parse(read('tests/fixtures/song-tempo-rec1600.json'));
  const ons = [...fx.kick, ...fx.bass].sort((a, b) => a - b);
  const lock = createSongTempoLock();
  let ki = 0, oi = 0; const reasons = [];
  for (const [t, gate, bpm] of fx.samples) {
    let kick = false, on = false;
    while (ki < fx.kick.length && fx.kick[ki] <= t) { kick = true; ki++; }
    while (oi < ons.length && ons[oi] <= t) { on = true; oi++; }
    const before = lock.state.reason + lock.state.bpm;
    lock.update(t, bpm, !!gate, withOnsets ? {kick, drop: false, onset: on} : {kick, drop: false});
    if (lock.state.reason + lock.state.bpm !== before && lock.state.reason) reasons.push(lock.state.reason);
  }
  return {lock, reasons, fx};
}

test('live feed replay (rec-1600): onset evidence stops the lock hopping on one groove', () => {
  const old = replayRec1600(false);
  assert.ok(old.reasons.filter(r => r === 'mismatch' || r === 'recheck').length >= 4, 'reproduces the live hops: ' + old.reasons.join(','));
  const now = replayRec1600(true);
  const moves = now.reasons.filter(r => r === 'mismatch' || r === 'recheck');
  assert.equal(moves.length, 0, 'no tempo switches without onset backing: ' + now.reasons.join(','));
  assert.ok(now.lock.state.relearns <= 2, 'only the two real silences re-learn: ' + now.lock.state.relearns);
  assert.ok(now.lock.state.rejected >= 1, 'unsupported switches were rejected');
});

// A 16th-note groove, kick not on every beat, bass syncopated.
function grooveOnsets(bpm, t0, t1, seed = 3) {
  const P = 60000 / bpm, out = []; let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bar16 = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
  for (let t = t0, i = 0; t < t1; t += P / 4, i++) if (bar16[i % 16] && rnd() > 0.1) out.push(t + (rnd() - 0.5) * 16);
  return out;
}

test('onsetFit prefers the true tempo of a syncopated groove over unrelated ones', () => {
  const on = grooveOnsets(140, 0, 24000);
  assert.ok(onsetFit(on, 140) > 0.3, 'fits its own tempo: ' + onsetFit(on, 140).toFixed(3));
  for (const other of [101, 115, 126]) assert.ok(onsetFit(on, 140) > 1.2 * onsetFit(on, other), other + ' fits worse');
  assert.equal(songRatio(105, 140), 3 / 4, '3:4 alias is the same song');
  assert.equal(songRatio(140 * 4 / 3, 140), 4 / 3);
});

test('DJ crossfade 124 -> 128 with real onsets still re-locks within ~2 min', () => {
  const lock = createSongTempoLock();
  const ons = [...grooveOnsets(124, 0, 90000), ...grooveOnsets(128, 90000, 330000, 7)];
  let oi = 0;
  const extra = t => { let on = false; while (oi < ons.length && ons[oi] <= t) { on = true; oi++; } return {kick: on, drop: false, onset: on}; };
  run(lock, 0, 90000, () => 124, () => true, 16.7, extra);
  assert.equal(Math.round(lock.state.bpm), 124);
  const log = run(lock, 90000, 330000, t => t < 98000 ? 124 + 4 * (t - 90000) / 8000 : 128, () => true, 16.7, extra);
  const moved = log.find(l => Math.abs(l.bpm - 128) < 1);
  assert.ok(moved, 're-locked to 128');
  assert.ok(moved.t - 90000 <= 125000, 'within ~2 min: ' + Math.round((moved.t - 90000) / 1000) + ' s');
});
