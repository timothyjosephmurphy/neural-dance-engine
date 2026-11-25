// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Hot-update fast path for the crowd pages (TJ Nov 24: changes go live
// during the show in as little time as possible, behind the psychedelic wipe).
//
// version.json = {version, core, hot: {name: hash}} (scripts/build-pages.mjs).
//  - core: hash of everything that is not a hot module. Changed core ->
//    seamless reload: crowd state saved to sessionStorage, wipe, reload,
//    restored on boot behind the fading wipe.
//  - hot: neural-dance/hot/<name>.js modules. Only hot changed -> import the
//    new/changed modules (?v=hash) without a reload; they register moves,
//    events or effects by name. Anything new triggers once with a NEW banner.
//  - Rollback (remote ROLLBACK) pins the projector to the previous build's
//    hot set: registries go back to their pre-hot snapshot, only modules
//    whose hash matches the pinned build load again, and no update applies
//    until UNPIN. Core changes are not rolled back by the pin (see
//    run wrangler rollback to the previous Worker version).

export const HOT_POLL_MS = 15000;
export const RESTORE_MAX_AGE_MS = 90000;
export const RESTORE_KEY = 'nd.crowd.hot-restore.v1';

export function hotPlan(current, next) {
  if (!next || !next.version) return {kind: 'none'};
  if (!current || !current.version) return {kind: 'none'};
  // A fast-path deploy may ship uncommitted hot modules under the same
  // version, so the hashes decide, not the version string.
  if ((next.core || '') !== (current.core || '')) return {kind: 'reload'};
  const a = current.hot || {}, b = next.hot || {};
  const load = Object.keys(b).filter(k => a[k] !== b[k]);
  if (!load.length) return {kind: next.version === current.version ? 'none' : 'quiet'};   // nothing the projector runs changed
  return {kind: 'hot', load};
}

// Which hot modules may load (pin = {hot: {name: hash}} or null).
export function allowedHot(hot, pin) {
  const out = {};
  for (const [k, v] of Object.entries(hot || {})) if (!pin || (pin.hot && pin.hot[k] === v)) out[k] = v;
  return out;
}
export function hotUrl(name, hash) {
  if (!/^[\w-]{1,40}$/.test(name)) throw new Error('bad hot module name');
  return '/neural-dance/hot/' + name + '.js?v=' + encodeURIComponent(String(hash).slice(0, 16));
}

// Crowd state for a seamless reload. Plain fields only.
const KEEP = ['id', 'type', 'x', 'y', 'tx', 'ty', 'where', 'surface', 'side', 'climbT', 'arcT', 'arcGoal', 'born', 'stamina', 'drive', 'fatigue', 'resting', 'rid'];
export function serializeCrowd(crowd, extra = {}) {
  return {at: Date.now(), t: crowd.t, nextId: crowd.nextId, dancers: crowd.dancers.filter(d => !d.leaving && d.surface !== 'rope').map(d => { const o = {}; for (const k of KEEP) o[k] = d[k]; if (o.where === 'climb') { o.where = 'floor'; o.surface = 'floor'; } return o; }), ...extra};
}
export function restoreCrowd(crowd, snap, now = Date.now()) {
  if (!snap || !Array.isArray(snap.dancers) || now - (+snap.at || 0) > RESTORE_MAX_AGE_MS) return false;
  crowd.dancers.length = 0;
  for (const s of snap.dancers.slice(0, crowd.cap)) {
    const d = {vx: 0, vy: 0, pauseUntil: 0, retargetAt: 0, plan: null, leaving: false, onTopSince: 0, ...s};
    d.born = 0; d.retargetAt = 0;
    if (d.where === 'floor') { d.tx = d.x; d.ty = d.y; }
    crowd.dancers.push(d);
  }
  crowd.nextId = Math.max(crowd.nextId, +snap.nextId || 1);
  return true;
}

// Registry snapshots so a rollback can drop whatever hot modules added.
export function createHotRegistry(parts) {
  // parts: [{snapshot(), restore(snap), names()}]
  const base = parts.map(p => p.snapshot());
  return {
    base,
    names: () => parts.map(p => p.names()),
    resetToBase() { parts.forEach((p, i) => p.restore(base[i])); },
    diff(before) { return parts.map((p, i) => p.names().filter(n => !before[i].includes(n))); }
  };
}
