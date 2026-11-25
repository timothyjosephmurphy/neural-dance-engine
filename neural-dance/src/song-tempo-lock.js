// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// One stable BPM per song (TJ, Nov 11): learn the tempo over the first
// ~4-8 bars, then LOCK it for the rest of the song. No continuous
// re-estimation: once locked, an estimate at the locked tempo or a simple
// ratio of it (half/double, 2:3 or 3:2, triplet 1/3 or 3x) is the same song
// (syncopation and subdivisions, not a tempo change). Breakdowns that lose
// the beat (no estimate, or garbage estimates that never agree) keep the
// lock. Re-learn only on:
//   - a song gap: >= GAP_MS of sustained quiet (same quiet rule as
//     song-gap-scan.js), then music again, or
//   - a sustained, large mismatch: a different, self-consistent tempo for
//     more than 8 bars at the locked tempo.
//
// DJ sets blend tracks with no silence (TJ, Nov 11 3:02 PM), so gaps are
// not enough: a background re-check runs every ~60-90 s (RECHECK_MS,
// configurable within 1-2 min) and right after a breakdown that ends without
// a drop. Each re-check looks at the last 8-16 bars of estimates on their
// own (not the lock), folds octaves (double/half time is the same song) and
// switches only when the result clearly differs (> RECHECK_CHANGE) and holds
// steady across the window. Otherwise the current lock (and phase) stays.
//
// Input is any upstream tempo estimate (global-tempo, band periods); the
// lock smooths nothing and only decides when the song's BPM may change.

export const BEATS_PER_BAR = 4;
export const LEARN_MIN_BARS = 4;
export const LEARN_MAX_BARS = 8;
export const GAP_MS = 2750;          // song-gap-scan GAP_QUIET_MS
export const MISMATCH_BARS = 8;
export const LEARN_AGREE = 0.04;      // learning: share of estimates within 4%
export const SAME_TOL = 0.06;         // locked: within 6% of the lock (or a ratio of it)
export const CAND_TOL = 0.05;         // a mismatch must agree with itself to count
export const RECHECK_MS = 75000;      // default background re-check cadence
export const RECHECK_MIN_MS = 60000, RECHECK_MAX_MS = 120000;
export const RECHECK_MIN_BARS = 8, RECHECK_MAX_BARS = 16;
export const RECHECK_CHANGE = 0.025;  // clear change: 124 -> 128 is 3.2%
export const RECHECK_STEADY = 0.015;  // window must agree with itself this tightly
export const RECHECK_HALVES = 0.005;  // ...and not still be moving (blend in progress)
export const BREAKDOWN_BARS = 4;      // music with no kick this long = breakdown
// 4:3 / 3:4 are the dotted-beat aliases a weak onset tracker falls into (the
// Nov 11 4:15 PM live feed: 140 BPM read as 105). Same song, not a change.
const RATIOS = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3, 4 / 3, 3 / 4];
// Onset evidence (TJ Nov 11: the lock hopped 101 -> 141 -> 126 -> 137 -> 115 -> 95
// on one groove because the upstream lock wandered). A switch (mismatch or
// re-check) must also fit the heard kick/bass onsets clearly better than the
// current lock. Phase-free: share of onset pairs (< 8 beats apart) that sit
// on a half-beat multiple. Chance is ~0.16 at EVIDENCE_TOL.
export const EVIDENCE_TOL = 0.08;
export const EVIDENCE_GAIN = 1.12;   // new tempo must fit this much better
export const EVIDENCE_MIN = 0.24;    // ...and clearly above chance
export const EVIDENCE_MIN_ONSETS = 16;
export const EVIDENCE_WIN_MS = 24000;
export const EVIDENCE_DEDUPE_MS = 90;
export function onsetFit(onsets, bpm, tol = EVIDENCE_TOL) {
  if (!(bpm > 0) || !onsets || onsets.length < 2) return 0;
  const P = 60000 / bpm, half = P / 2;
  let hit = 0, n = 0;
  for (let i = 0; i < onsets.length; i++) {
    for (let j = i + 1; j < onsets.length; j++) {
      const d = onsets[j] - onsets[i];
      if (d >= 8 * P) break;
      const r = d / half;
      n++;
      if (Math.abs(r - Math.round(r)) < tol) hit++;
    }
  }
  return n ? hit / n : 0;
}

// r if a == b * r for one of the simple song ratios (within tol), else 0.
export function songRatio(a, b, tol = SAME_TOL) {
  if (!(a > 0) || !(b > 0)) return 0;
  for (const r of RATIOS) if (Math.abs(Math.log(a / (b * r))) < tol) return r;
  return 0;
}

// Fold bpm into [ref/sqrt2, ref*sqrt2) by octaves so half/double agree.
function fold(bpm, ref) {
  let b = bpm;
  while (b < ref / Math.SQRT2) b *= 2;
  while (b >= ref * Math.SQRT2) b /= 2;
  return b;
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

export function createSongTempoLock(opts = {}) {
  const gapMs = opts.gapMs || GAP_MS;
  const learnMin = opts.learnMinBars || LEARN_MIN_BARS;
  const learnMax = opts.learnMaxBars || LEARN_MAX_BARS;
  const mismatchBars = opts.mismatchBars || MISMATCH_BARS;
  const recheckMs = Math.max(RECHECK_MIN_MS, Math.min(RECHECK_MAX_MS, +opts.recheckMs || RECHECK_MS));
  const st = {bpm: 0, locked: false, learning: false, lockedAt: -1, relearns: 0, reason: '', candidate: 0,
    rechecks: 0, lastCheck: null, breakdown: false, rejected: 0, evidence: null};
  let recent = [];           // {t, bpm} estimates for the background re-check
  let nextCheck = Infinity, pendingFrom = -1;
  let lastKick = -1, inBreakdown = false;
  let samples = [];          // {t, bpm} while learning
  let learnStart = -1;
  let quietSince = -1, gapOpen = false, lastSample = -1e12;
  const SAMPLE_MS = 100; // per-frame callers: ~10 estimates/s is plenty
  let cand = 0, candSince = -1, candLast = -1, candSamples = [];
  let onsets = [];           // kick/bass onset times (deduped), last EVIDENCE_WIN_MS
  let onsetInfo = false;     // caller passes onsets at all

  function clearCandidate() { cand = 0; candSince = -1; candLast = -1; candSamples = []; st.candidate = 0; }

  function reset() {
    Object.assign(st, {bpm: 0, locked: false, learning: false, lockedAt: -1, relearns: 0, reason: '', candidate: 0,
      rechecks: 0, lastCheck: null, breakdown: false, rejected: 0, evidence: null});
    recent = []; nextCheck = Infinity; pendingFrom = -1; lastKick = -1; inBreakdown = false;
    samples = []; learnStart = -1; quietSince = -1; gapOpen = false; lastSample = -1e12; clearCandidate();
    onsets = []; onsetInfo = false;
  }

  // null: no usable onset evidence (too few, or not onset-like), so the
  // caller decides on tempo estimates alone. Else {ok, fitNew, fitOld}.
  function evidence(now, next, cur) {
    if (!onsetInfo) return null;
    const win = onsets.filter(t => t >= now - EVIDENCE_WIN_MS);
    const span = win.length > 1 ? win[win.length - 1] - win[0] : 0;
    const rate = span > 0 ? (win.length - 1) / (span / 1000) : 0;
    if (win.length < EVIDENCE_MIN_ONSETS || !(rate >= 0.5 && rate <= 9)) return null;
    const fitNew = onsetFit(win, next), fitOld = onsetFit(win, cur);
    const ok = fitNew >= EVIDENCE_MIN && fitNew >= EVIDENCE_GAIN * fitOld;
    st.evidence = {fitNew: Math.round(fitNew * 1000) / 1000, fitOld: Math.round(fitOld * 1000) / 1000, ok, n: win.length};
    return st.evidence;
  }

  function startLearning(now, reason) {
    if (st.locked) st.relearns++;
    st.locked = false; st.bpm = 0; st.learning = true; st.lockedAt = -1; st.reason = reason;
    samples = []; learnStart = -1; clearCandidate();
    recent = []; nextCheck = Infinity; pendingFrom = -1;
  }

  function lockTo(now, bpm, reason) {
    st.locked = true; st.learning = false; st.bpm = bpm; st.lockedAt = now; st.reason = reason;
    samples = []; learnStart = -1; clearCandidate();
    nextCheck = now + recheckMs; pendingFrom = -1;
  }

  function learn(now, bpm) {
    if (learnStart < 0) learnStart = now;
    samples.push({t: now, bpm});
    const ref = median(samples.map(s => s.bpm));
    const folded = samples.map(s => fold(s.bpm, ref));
    const m = median(folded);
    const beatMs = 60000 / m;
    const span = now - learnStart;
    if (span < learnMin * BEATS_PER_BAR * beatMs) return;
    // Agreement over the second half of the learning window.
    const recent = samples.filter(s => s.t >= learnStart + span / 2).map(s => fold(s.bpm, m));
    const agree = recent.filter(b => Math.abs(b / m - 1) <= LEARN_AGREE).length;
    if (recent.length >= 3 && agree >= 0.75 * recent.length) {
      lockTo(now, median(recent.filter(b => Math.abs(b / m - 1) <= LEARN_AGREE)), 'learned');
    } else if (span >= learnMax * BEATS_PER_BAR * beatMs) {
      lockTo(now, m, 'learned-max');
    }
  }

  function watchMismatch(now, bpm) {
    if (songRatio(bpm, st.bpm)) { clearCandidate(); return; } // same song: grid, subdivisions, syncopation
    const bar = BEATS_PER_BAR * (60000 / st.bpm);
    // Consistent means continuous: a candidate unheard for 2 bars starts over.
    if (cand > 0 && Math.abs(Math.log(bpm / cand)) < CAND_TOL && now - candLast <= 2 * bar) {
      candLast = now;
      candSamples.push(bpm);
      if (candSamples.length > 64) candSamples.shift();
      cand = median(candSamples);
      st.candidate = Math.round(cand * 10) / 10;
      if (now - candSince > mismatchBars * bar) {
        const ev = evidence(now, cand, st.bpm);
        if (ev && !ev.ok) { candSince = now; st.rejected++; return; } // heard onsets do not back it: keep the lock
        st.relearns++;
        lockTo(now, cand, 'mismatch');
      }
    } else { cand = bpm; candSince = now; candLast = now; candSamples = [bpm]; st.candidate = Math.round(bpm * 10) / 10; }
  }

  // Independent tempo over the last 8-16 bars (from `since` if given).
  // Returns {bpm, steady, changed, n} or null when the window is too short.
  function recheck(now, since = -Infinity) {
    if (!st.locked) return null;
    const bar = BEATS_PER_BAR * 60000 / st.bpm;
    const from = Math.max(since, now - RECHECK_MAX_BARS * bar);
    const win = recent.filter(r => r.t >= from);
    if (win.length < 12 || now - win[0].t < RECHECK_MIN_BARS * bar - 1) return null;
    const folded = win.map(r => fold(r.bpm, st.bpm)); // half/double time = same song
    const m = median(folded);
    const mid = win[0].t + (now - win[0].t) / 2;
    const a = median(folded.filter((_, i) => win[i].t < mid)), b = median(folded.filter((_, i) => win[i].t >= mid));
    const within = folded.filter(v => Math.abs(v / m - 1) <= RECHECK_STEADY).length;
    const steady = within >= 0.75 * folded.length && Math.abs(a / b - 1) <= RECHECK_HALVES;
    // Octave-folded already; a 3:2 or 4:3 alias of the lock is the same song.
    let changed = steady && Math.abs(m / st.bpm - 1) > RECHECK_CHANGE && songRatio(m, st.bpm, 0.02) === 0;
    if (changed) { const ev = evidence(now, b, st.bpm); if (ev && !ev.ok) { changed = false; st.rejected++; } }
    st.rechecks++;
    st.lastCheck = {t: Math.round(now), bpm: Math.round(m * 10) / 10, steady, changed, n: win.length};
    if (changed) { st.relearns++; lockTo(now, b, 'recheck'); } // the newer half: where the music is now
    return st.lastCheck;
  }

  // Section labels from breakdown-detect.js (TJ Nov 11 4:12 PM): when they
  // are fed, they replace the kick-gap guess. The BPM re-check runs when a
  // breakdown ends (the beat returns), drop or not, once enough is heard.
  let sectionLabels = false;
  function sectionEvent(now, ev) {
    if (!ev || !ev.type) return st;
    sectionLabels = true;
    if (ev.type === 'breakdown') { inBreakdown = true; st.breakdown = true; pendingFrom = -1; }
    else if (ev.type === 'drop' || ev.type === 'breakdownEnd') {
      const was = inBreakdown;
      inBreakdown = false; st.breakdown = false;
      if (st.locked && was) pendingFrom = now;
    }
    return st;
  }
  function watchBreakdown(now, kick, drop) {
    if (kick == null || sectionLabels) return;
    if (kick) {
      if (inBreakdown) {
        inBreakdown = false; st.breakdown = false;
        // Breakdown over. A drop returns the same song; no drop: maybe a new
        // track was blended in underneath, so re-check once 8 bars are heard.
        if (!drop && st.locked) pendingFrom = now;
      }
      lastKick = now;
      return;
    }
    if (lastKick < 0) lastKick = now;
    const bar = BEATS_PER_BAR * 60000 / (st.bpm || 120);
    if (!inBreakdown && now - lastKick >= BREAKDOWN_BARS * bar) { inBreakdown = true; st.breakdown = true; pendingFrom = -1; }
  }

  // now: ms. bpm: upstream estimate (0 when it has none). sound: music is
  // present (silence gate open / not quiet).
  // extra (optional): {kick: kick hit this frame, drop: the kick came back
  // as a drop, onset: a kick or bass onset this frame (evidence for switches)}. Without kick info breakdowns are not tracked (the timed
  // re-check still runs).
  function update(now, bpm, sound, extra) {
    if (!sound) {
      if (quietSince < 0) quietSince = now;
      if (!gapOpen && now - quietSince >= gapMs) gapOpen = true;
      return st;
    }
    quietSince = -1;
    if (gapOpen) { gapOpen = false; startLearning(now, 'song-gap'); }
    if (!st.locked && !st.learning) st.learning = true;
    if (extra) watchBreakdown(now, extra.kick, extra.drop);
    if (extra && extra.onset != null) {
      onsetInfo = true;
      if (extra.onset && (!onsets.length || now - onsets[onsets.length - 1] >= EVIDENCE_DEDUPE_MS)) onsets.push(now);
      while (onsets.length && onsets[0] < now - EVIDENCE_WIN_MS) onsets.shift();
    }
    const b = +bpm;
    if (b >= 40 && b <= 260 && now - lastSample >= SAMPLE_MS) {
      lastSample = now;
      if (st.locked) {
        recent.push({t: now, bpm: b});
        const keep = now - RECHECK_MAX_BARS * BEATS_PER_BAR * 60000 / Math.min(st.bpm, 90);
        while (recent.length && recent[0].t < keep) recent.shift();
        watchMismatch(now, b);
      } else learn(now, b);
    }
    if (st.locked && !inBreakdown) {
      if (pendingFrom >= 0) {
        const r = recheck(now, pendingFrom);
        if (r) pendingFrom = -1;
        else if (now - pendingFrom > 2 * RECHECK_MAX_BARS * BEATS_PER_BAR * 60000 / st.bpm) pendingFrom = -1;
      }
      if (st.locked && now >= nextCheck) {
        const r = recheck(now);
        // Too little to judge (e.g. estimates missing): try again in a bar.
        if (st.locked && !r) nextCheck = now + BEATS_PER_BAR * 60000 / st.bpm;
        else if (st.locked && r && !r.changed) nextCheck = now + recheckMs;
      }
    }
    return st;
  }

  function snapshot() {
    return {bpm: st.locked ? Math.round(st.bpm * 10) / 10 : 0, locked: st.locked, learning: st.learning,
      relearns: st.relearns, reason: st.reason, candidate: st.candidate, rechecks: st.rechecks,
      lastCheck: st.lastCheck, breakdown: st.breakdown, recheckMs, rejected: st.rejected, evidence: st.evidence};
  }

  return {update, reset, snapshot, recheck, sectionEvent, state: st};
}
