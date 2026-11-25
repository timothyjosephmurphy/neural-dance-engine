// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Peak pulse network for the Neural Dance side simulation. It mirrors the
// live WASM engine (neural_dance.cpp, TJ Nov 11 2:27 PM) in the side sim's
// 0..1 activation scale (half the engine's 0..2):
//  - a dancer only sends pulses (visible pulse + energy to the others) while
//    it is at peak: once on the moment it crosses into peak, then on its own
//    band hits while it stays there (0.2 s refractory);
//  - band hits below peak only raise its own level (plus a slow charge);
//  - the peak period lasts peakHold (default 5 s) while the band keeps
//    hitting, then a forced rest (1.6 s);
//  - during rest it keeps dancing to its band, capped at restCap, and sends
//    nothing; a pulse already in flight only nudges it up to that cap;
//  - relays stop after two hops and HOT_IDLE without hits ends the peak, so
//    nothing keeps going after the music stops.

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export const PEAK_LEVEL = 0.875;       // engine 1.75
export const REST_CAP = 0.35;          // engine 0.7
export const PEAK_HOLD_DEFAULT = 5;    // seconds (was 2.8)
export const REST_TIME = 1.6;
export const HOT_IDLE = 1.2;
// Emit rate at peak (TJ Nov 11 2:43 PM): one pulse per dancer every 2 beats
// of the locked tempo, clamped 0.6-1.6 s, 1.0 s unlocked; a hit up to
// EMIT_EARLY before the interval expires counts so pulses land on the beat.
export const EMIT_BEATS = 2;
export const EMIT_MIN = 0.6;
export const EMIT_MAX = 1.6;
export const EMIT_UNLOCKED = 1.0;
export const EMIT_EARLY = 0.12;
export function emitInterval(bpm) {
  const b = +bpm;
  if (!(b >= 30 && b <= 300)) return EMIT_UNLOCKED;
  return clamp(EMIT_BEATS * 60 / b, EMIT_MIN, EMIT_MAX);
}
export const MAX_GEN = 2;
export const CHARGE_HIT = 0.08;        // engine 0.16
export const CHARGE_DECAY = 0.45;
export const CHARGE_MAX = 0.5;
export const TRANSFER = 0.15;          // energy passed on emission
export const ARRIVAL = 0.2;            // on pulse contact
export const BOOST_MAX = 0.5;
export const BOOST_DECAY = 0.6;        // per second
// The side sim's string goes still in phrase gaps; the peak floor fades out
// after FLOOR_HOLD without a hit so those gaps still read as stillness.
export const FLOOR_HOLD = 0.6;

export function createPeakNetwork(opts = {}) {
  const cfg = {
    peakHold: PEAK_HOLD_DEFAULT,
    peakLevel: PEAK_LEVEL,
    restCap: REST_CAP,
    maxTargets: 2,
    ...opts,
  };
  const nodes = new Map();
  let pulses = [];
  let lastT = null;
  let emitTotal = 0, spawnTotal = 0;
  let tempo = 0;

  function node(id) {
    let n = nodes.get(id);
    if (!n) {
      n = {id, x: 0, y: 0, band: id, raw: 0, charge: 0, boost: 0, hot: false, peak: 0, rest: 0,
        ref: -1, lastHit: -99, emits: 0, floorE: 0, capE: 1, addE: 0};
      nodes.set(id, n);
    }
    return n;
  }
  function level(n) { return n.raw + n.charge + n.boost; }
  function canEmit(n, t) { return n.rest <= 0 && level(n) >= cfg.peakLevel - 1e-9 && t >= n.ref - EMIT_EARLY; }
  function enterPeak(n, t) {
    if (n.hot || n.rest > 0 || level(n) < cfg.peakLevel - 1e-9) return false;
    n.hot = true; // lastHit untouched: a band-silent dancer drops out of peak at once
    return true;
  }
  function give(n, amount, t, gen) {
    if (n.rest > 0) {
      // Cooldown receiver: capped at restCap through the boost, never relays.
      n.boost = Math.max(n.boost, Math.min(n.boost + amount * 0.5, Math.max(0, cfg.restCap - n.raw)));
      return;
    }
    n.boost = clamp(n.boost + amount, 0, BOOST_MAX);
    if (enterPeak(n, t) && gen + 1 < MAX_GEN && canEmit(n, t)) emit(n, t, gen + 1);
  }
  function emit(n, t, gen) {
    n.ref = t + emitInterval(tempo);
    n.emits++;
    emitTotal++;
    const others = [...nodes.values()].filter(o => o !== n && o.rest <= 0)
      .sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y));
    others.forEach((o, i) => {
      if (i < cfg.maxTargets) {
        const dist = Math.hypot(o.x - n.x, o.y - n.y);
        const travel = clamp(0.3 + dist / 900, 0.35, 1.1);
        pulses.push({from: n.id, to: o.id, band: n.band, t0: t, dur: travel, gen, arrived: false});
        spawnTotal++;
      }
    });
    for (const o of others) give(o, TRANSFER, t, gen);
  }

  // list: [{id, x, y, raw (0..1), hits (own-band hits since last step), band}]
  // opts.bpm: locked tempo for the emit interval (0/absent = unlocked).
  function step(tSec, list, opts = {}) {
    tempo = +(opts && opts.bpm) || 0;
    const t = +tSec || 0;
    if (lastT == null || t < lastT - 1e-6 || t - lastT > 2) reset(t);
    const dt = clamp(t - lastT, 0, 0.1);
    lastT = t;
    const seen = new Set();
    for (const it of list || []) {
      const n = node(it.id);
      seen.add(it.id);
      n.x = +it.x || 0; n.y = +it.y || 0; n.band = it.band || it.id;
      n.raw = clamp(+it.raw || 0, 0, 1);
      n.charge -= n.charge * CHARGE_DECAY * dt;
      n.boost = Math.max(0, n.boost - BOOST_DECAY * dt);
      n.rest = Math.max(0, n.rest - dt);
      n._hits = it.hits | 0;
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    for (const n of nodes.values()) {
      for (let h = 0; h < n._hits; h++) {
        n.lastHit = t;
        if (n.rest > 0) continue; // dances (raw, capped) but sends nothing
        n.charge = Math.min(CHARGE_MAX, n.charge + CHARGE_HIT);
        enterPeak(n, t);
        if (n.hot && canEmit(n, t)) emit(n, t, 0);
      }
    }
    for (const p of pulses) {
      if (p.arrived || t < p.t0 + p.dur) continue;
      p.arrived = true;
      const to = nodes.get(p.to);
      if (to) give(to, ARRIVAL, t, p.gen);
    }
    // Pulses never vanish mid-flight: a vanished target hands the pulse to the
    // nearest remaining dancer (a vanished sender is fine). Only a landed
    // pulse's fade-out ends it, or nobody being left to land on.
    for (const p of pulses) {
      if (p.arrived || nodes.has(p.to)) continue;
      const alt = [...nodes.values()].filter(o => o.id !== p.from);
      if (alt.length) { p.to = alt[0].id; p.dur = Math.max(p.dur, t - p.t0 + 0.4); }
    }
    pulses = pulses.filter(p => nodes.size > 0 && (nodes.has(p.to) || p.arrived) && t < p.t0 + p.dur + 0.35);
    for (const n of nodes.values()) {
      if (n.rest > 0) {
        n.hot = false;
      } else if (!n.hot) {
        n.peak = Math.max(0, n.peak - 0.6 * dt);
      } else {
        if (t - n.lastHit > HOT_IDLE) n.hot = false;
        else {
          n.peak += dt;
          if (n.peak > cfg.peakHold) {
            n.hot = false; n.peak = 0; n.rest = REST_TIME; n.charge = 0; n.boost = 0;
          }
        }
      }
      // Eased output envelope so the figure never snaps between levels.
      const since = t - n.lastHit;
      const floorT = n.hot ? cfg.peakLevel * clamp(1 - (since - FLOOR_HOLD) / FLOOR_HOLD, 0, 1) : 0;
      const capT = n.rest > 0 ? cfg.restCap : 1;
      const addT = n.rest > 0 ? 0 : n.charge + n.boost;
      const k = 1 - Math.exp(-dt / 0.12);
      n.floorE += (floorT - n.floorE) * k;
      n.capE += (capT - n.capE) * k;
      n.addE += (addT - n.addE) * k;
    }
    return api;
  }

  // Shape a raw 0..1 activation with this dancer's network state.
  function effective(id, raw) {
    const n = nodes.get(id);
    const r = clamp(+raw || 0, 0, 1);
    if (!n) return r;
    return clamp(Math.min(Math.max(r + n.addE, n.floorE), n.capE), 0, 1);
  }

  function reset(t = null) {
    nodes.clear();
    pulses = [];
    lastT = t;
    emitTotal = 0;
    spawnTotal = 0;
  }

  function state(id) {
    const n = nodes.get(id);
    if (!n) return null;
    return {hot: n.hot, peak: n.peak, rest: n.rest, level: level(n), charge: n.charge, boost: n.boost, emits: n.emits};
  }

  const api = {
    step, effective, reset, state,
    get pulses() { return pulses; },
    get emitTotal() { return emitTotal; },
    get spawnTotal() { return spawnTotal; },
    setPeakHold(v) { if (Number.isFinite(+v) && +v > 0) cfg.peakHold = +v; },
    get peakHold() { return cfg.peakHold; },
    get emitInterval() { return emitInterval(tempo); },
    config: cfg,
  };
  return api;
}

const mod = {PEAK_LEVEL, REST_CAP, PEAK_HOLD_DEFAULT, REST_TIME, HOT_IDLE, EMIT_BEATS, EMIT_MIN, EMIT_MAX, EMIT_UNLOCKED, MAX_GEN, emitInterval, createPeakNetwork};
export default mod;
if (typeof globalThis !== 'undefined') globalThis.NDPeakNetwork = mod;
