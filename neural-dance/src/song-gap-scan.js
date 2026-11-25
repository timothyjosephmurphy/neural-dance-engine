// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Between-songs sticker scan (TJ, Nov 10 12:00 PM): when a real song gap
// opens, run the existing Scan stickers refresh. Never flash during music,
// never treat a breakdown as a gap, abort at once if the next song starts
// mid-scan, and keep the previous sticker book unless the new reading is
// high-confidence.

export const GAP_PLAY_MIN_MS = 20000;
export const GAP_QUIET_MS = 2750; // 2.5–3 s of sustained quiet
export const GAP_RATE_MS = 60000;
export const BAND_SILENCE = 0.12;
export const BAND_ACTIVE = 0.20;
export const ACTIVE_MEMORY_MS = 20000;
export const GAP_SCAN_KEY = 'nd.gap-scan.v1';
export const GAP_FADE_MS = 150; // shorter than the manual 300 ms fade
export const SCAN_MATCH_RADIUS = 80;

export function readGapScan(storage) {
  const mem = storage || (typeof localStorage === 'undefined' ? null : localStorage);
  if (!mem || typeof mem.getItem !== 'function') return true;
  try {
    const v = mem.getItem(GAP_SCAN_KEY);
    if (v == null || v === '') return true;
    return v !== '0' && v !== 'false' && v !== 'off';
  } catch {
    return true;
  }
}

export function writeGapScan(storage, on) {
  const mem = storage || (typeof localStorage === 'undefined' ? null : localStorage);
  if (!mem || typeof mem.setItem !== 'function') return false;
  try {
    mem.setItem(GAP_SCAN_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

export function levelsOf(sample) {
  if (!sample) return [0, 0, 0, 0];
  if (Array.isArray(sample.levels)) return [0, 1, 2, 3].map(i => Math.max(0, +sample.levels[i] || 0));
  if (Array.isArray(sample.lv)) return [0, 1, 2, 3].map(i => Math.max(0, +sample.lv[i] || 0));
  return [0, 0, 0, 0];
}

export function bandIsQuiet(v) {
  return (+v || 0) <= BAND_SILENCE;
}

// A breakdown drops some bands but leaves others playing. A song gap drops
// every band that was recently active. Bands that never played (often hat
// on a kick-heavy phone mix) are ignored.
export function allActiveBandsQuiet(levels, activeMask) {
  const lv = [0, 1, 2, 3].map(i => Math.max(0, +(levels && levels[i]) || 0));
  if (!activeMask) return Math.max(0, ...lv) <= BAND_SILENCE;
  for (let i = 0; i < 4; i++) {
    if ((activeMask & (1 << i)) && !bandIsQuiet(lv[i])) return false;
  }
  return true;
}

export function musicOnset(levels, activeMask, gateOpen = false) {
  const lv = [0, 1, 2, 3].map(i => Math.max(0, +(levels && levels[i]) || 0));
  if (!allActiveBandsQuiet(lv, activeMask)) return true;
  if (gateOpen && lv.some(v => v >= BAND_ACTIVE)) return true;
  return false;
}

export function scanApplyOk({prevCount = 0, nextCount = 0, whiteOk = true, settled = true} = {}) {
  const prev = Math.max(0, prevCount | 0);
  const next = Math.max(0, nextCount | 0);
  if (!whiteOk) return {ok: false, reason: 'The camera did not see a white screen. Stickers unchanged.'};
  if (next === 0 && prev > 0) return {ok: false, reason: 'No stickers found. Stickers unchanged.'};
  if (prev > 0 && next > Math.max(prev * 2, prev + 3)) {
    return {ok: false, reason: 'Too many blobs (' + next + ' vs ' + prev + '). Stickers unchanged.'};
  }
  void settled;
  return {ok: true, reason: ''};
}

// Keep dancer identity across a Scan stickers refresh so a small move is
// absorbed as a step, not a new dancer (resetBook + restore would mint IDs).
export function matchScanIds(previous, points, radius = SCAN_MATCH_RADIUS) {
  const prev = (previous || []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  const incoming = (points || []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : SCAN_MATCH_RADIUS;
  const used = new Set();
  const out = [];
  for (const track of prev) {
    let best = -1;
    let bestD = limit;
    for (let i = 0; i < incoming.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(incoming[i].x - track.x, incoming[i].y - track.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      used.add(best);
      const id = track.id | 0;
      out.push(id > 0 ? {...incoming[best], id} : {...incoming[best]});
    }
  }
  for (let i = 0; i < incoming.length; i++) {
    if (!used.has(i)) out.push({...incoming[i]});
  }
  return out;
}

// Gap scans never remove a confirmed sticker (TJ Nov 10 1:12 PM: 3 -> 2).
// Previous stickers with no new point within radius stay where they were.
export function keepConfirmedStickers(previous, next, radius = SCAN_MATCH_RADIUS) {
  const out = (next || []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y)).map(p => ({...p}));
  const limit = Number.isFinite(+radius) && +radius > 0 ? +radius : SCAN_MATCH_RADIUS;
  const ids = new Set(out.map(p => p.id | 0).filter(id => id > 0));
  for (const track of previous || []) {
    if (!track || !Number.isFinite(+track.x) || !Number.isFinite(+track.y)) continue;
    const id = track.id | 0;
    if (id > 0 && ids.has(id)) continue;
    if (out.some(p => Math.hypot(p.x - track.x, p.y - track.y) <= limit)) continue;
    const kept = {x: +track.x, y: +track.y, kind: track.kind || 'sticker'};
    if (id > 0) kept.id = id;
    if (track.contour) kept.contour = track.contour;
    if (Number.isFinite(+track.projectedHeight) && +track.projectedHeight > 0) kept.projectedHeight = +track.projectedHeight;
    out.push(kept);
  }
  return out;
}

export function gapScanSummary(r) {
  if (!r || !r.state) return 'Between-songs scan: not run yet';
  const when = r.at ? ' · last ' + formatScanTime(r.at) : '';
  if (r.state === 'scanning' || r.state === 'fading-in' || r.state === 'flashing' || r.state === 'fading-out') {
    return 'Between-songs scan: running…' + when;
  }
  if (r.state === 'done') {
    const n = r.count | 0;
    return 'Between-songs scan: ' + n + ' sticker' + (n === 1 ? '' : 's') + ' latched' + (r.applied === false ? ' (not applied)' : '') + when;
  }
  if (r.state === 'aborted') return 'Between-songs scan: aborted — ' + (r.reason || 'music started; stickers unchanged') + when;
  if (r.state === 'deferred') return 'Between-songs scan: deferred — ' + (r.reason || '') + when;
  if (r.state === 'failed' || r.state === 'rejected') return 'Between-songs scan: ' + r.state + ' — ' + (r.reason || 'stickers unchanged') + when;
  if (r.state === 'off') return 'Between-songs scan: off';
  return 'Between-songs scan: ' + r.state + (r.reason ? ' — ' + r.reason : '') + when;
}

function formatScanTime(at) {
  const n = +at;
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles'}) + ' PT';
  } catch {
    return String(Math.round(n));
  }
}

export function createSongGapScan({
  playMinMs = GAP_PLAY_MIN_MS,
  quietMs = GAP_QUIET_MS,
  rateMs = GAP_RATE_MS,
  enabled = true
} = {}) {
  let on = enabled !== false;
  let playMs = 0;
  let lastT = null;
  let quietSince = null;
  let activeMask = 0;
  let activeAt = [0, 0, 0, 0];
  let lastStartAt = -Infinity;
  let scanning = false;
  let last = {at: null, state: 'idle', reason: '', count: null, applied: null};

  function stepOf(t) {
    const time = +t || 0;
    const d = lastT == null ? 0 : Math.max(0, Math.min(500, time - lastT));
    lastT = time;
    return d;
  }

  function updateActive(lv, time) {
    for (let i = 0; i < 4; i++) {
      if (lv[i] >= BAND_ACTIVE) {
        activeMask |= (1 << i);
        activeAt[i] = time;
      } else if (time - (activeAt[i] || 0) > ACTIVE_MEMORY_MS) {
        activeMask &= ~(1 << i);
      }
    }
    return activeMask;
  }

  return {
    get enabled() { return on; },
    setEnabled(value) {
      if (value === true || value === false) on = value;
      return on;
    },
    playingMs() { return playMs; },
    activeMask() { return activeMask; },
    scanning() { return scanning; },
    last() { return {...last}; },
    lastStartAt() { return lastStartAt; },
    // sample: {t, levels|lv, gate|gateOpen, listening}
    observe(sample = {}) {
      const time = Number.isFinite(+sample.t) ? +sample.t : (lastT == null ? 0 : lastT);
      const dt = stepOf(time);
      const lv = levelsOf(sample);
      const listening = sample.listening !== false;
      const gateOpen = sample.gateOpen === true || sample.gate === true;
      const mask = updateActive(lv, time);
      const quiet = allActiveBandsQuiet(lv, mask);
      const playing = !quiet && (gateOpen || lv.some(v => v >= BAND_ACTIVE));

      if (scanning) {
        if (musicOnset(lv, mask, gateOpen)) {
          return {action: 'abort', reason: 'music-onset', playMs, quietMs: 0, activeMask: mask};
        }
        return {action: 'scanning', playMs, quietMs: quietSince == null ? 0 : time - quietSince, activeMask: mask};
      }

      if (!listening) {
        quietSince = null;
        return {action: 'idle', playMs, quietMs: 0, activeMask: mask};
      }

      if (playing) {
        playMs += dt;
        quietSince = null;
        return {action: 'playing', playMs, quietMs: 0, activeMask: mask};
      }

      if (quietSince == null) quietSince = time;
      const held = time - quietSince;
      const ready = playMs >= playMinMs && held >= quietMs && quiet;
      if (!ready) return {action: 'quiet', playMs, quietMs: held, activeMask: mask};
      if (!on) return {action: 'disabled', playMs, quietMs: held, activeMask: mask};
      if ((time - lastStartAt) < rateMs) return {action: 'rate-limited', playMs, quietMs: held, activeMask: mask};
      return {action: 'start-scan', playMs, quietMs: held, activeMask: mask};
    },
    markScanStarted(t) {
      scanning = true;
      lastStartAt = Number.isFinite(+t) ? +t : (lastT || 0);
      last = {at: lastStartAt, state: 'scanning', reason: '', count: null, applied: null};
    },
    markScanFinished(report = {}) {
      scanning = false;
      playMs = 0;
      quietSince = lastT;
      last = {
        at: Number.isFinite(+report.at) ? +report.at : (lastT || Date.now()),
        state: report.state || 'done',
        reason: report.reason || '',
        count: report.count == null ? null : report.count | 0,
        applied: report.applied !== false
      };
      return last;
    },
    markScanAborted(report = {}) {
      scanning = false;
      last = {
        at: Number.isFinite(+report.at) ? +report.at : (lastT || Date.now()),
        state: report.state || 'aborted',
        reason: report.reason || 'Music started. Stickers unchanged.',
        count: report.count == null ? null : report.count | 0,
        applied: false
      };
      return last;
    }
  };
}
