// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Crown pulse.
// Outgoing energy climbs the chakra string from root (s = 0) to crown
// (s = 1). A send to other dancers happens only when that climb arrives at
// the crown, and the beam leaves from the crown. An incoming pulse enters
// at the crown and travels down to the root. Each point it passes lights.
// Sustained peak (activation held above a threshold) shortens the climb and
// fans the send out to several partners. Below the threshold the dancer
// goes back to one partner at the normal climb.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const PEAK_THRESHOLD = 0.88;
export const PEAK_DURATION = 2;
export const PARTNER_COUNT = 3;
export const CLIMB_SEC = 1.05;
export const PEAK_CLIMB_SEC = 0.48;
export const DOWN_SEC = 0.7;
export const EXIT_SEC = 0.38;
export const CHAKRA_S = [0, 0.135, 0.281, 0.417, 0.781, 0.917, 1];
const MAX_BEAMS = 48;

export function createCrownPulse(opts = {}) {
  const cfg = {
    peakThreshold: PEAK_THRESHOLD,
    peakDuration: PEAK_DURATION,
    partnerCount: PARTNER_COUNT,
    climbSec: CLIMB_SEC,
    peakClimbSec: PEAK_CLIMB_SEC,
    downSec: DOWN_SEC,
  };
  applyConfig(cfg, opts);
  const nodes = new Map();
  let beams = [];
  let tPrev = null;
  let sends = 0;

  function node(id) {
    let n = nodes.get(id);
    if (!n) {
      n = {id, x: 0, y: 0, climb: 0, above: 0, sustained: false, exit: 0, down: [], boost: 0, activation: 0};
      nodes.set(id, n);
    }
    return n;
  }

  function partners(from, count) {
    const rest = [...nodes.values()].filter(o => o.id !== from.id);
    rest.sort((a, b) => {
      const da = (a.x - from.x) ** 2 + (a.y - from.y) ** 2;
      const db = (b.x - from.x) ** 2 + (b.y - from.y) ** 2;
      return da - db;
    });
    return rest.slice(0, Math.max(1, count | 0));
  }

  function fire(n) {
    const count = n.sustained ? Math.max(1, cfg.partnerCount | 0) : 1;
    const targets = partners(n, count);
    n.exit = EXIT_SEC;
    n.climb = 0;
    if (!targets.length) return;
    sends++;
    for (const to of targets) {
      const dist = Math.hypot(to.x - n.x, to.y - n.y);
      beams.push({
        from: n.id,
        to: to.id,
        t0: tPrev,
        dur: clamp(0.28 + dist / 900, 0.28, 1.05),
        u: 0,
        arrived: false,
        gen: n.sustained ? 'peak' : 'normal',
      });
    }
    if (beams.length > MAX_BEAMS) beams = beams.slice(-MAX_BEAMS);
  }

  function step(t, list) {
    const now = +t || 0;
    let dt = tPrev == null ? 0 : now - tPrev;
    if (!(dt >= 0) || dt > 0.5) dt = 0;
    tPrev = now;
    const seen = new Set();
    for (const it of list || []) {
      const n = node(it.id);
      seen.add(it.id);
      n.x = +it.x || 0;
      n.y = +it.y || 0;
      n.activation = clamp(+it.activation || 0, 0, 1);
      const hot = n.activation >= cfg.peakThreshold - 1e-9;
      if (hot) n.above += dt;
      else { n.above = 0; n.sustained = false; }
      if (!n.sustained && hot && n.above >= cfg.peakDuration) n.sustained = true;
      const dur = Math.max(0.2, n.sustained ? cfg.peakClimbSec : cfg.climbSec);
      // Received energy feeds the next climb. Silence does not climb.
      const drive = clamp(n.activation + n.boost * 0.5, 0, 1.4);
      if (drive > 0.08) n.climb = Math.min(1, n.climb + dt * drive / dur);
      else n.climb = Math.max(0, n.climb - dt * 0.35);
      n.exit = Math.max(0, n.exit - dt);
      n.boost = Math.max(0, n.boost - dt * 0.35);
      const nextDown = [];
      for (const d of n.down) {
        const s = d.s - dt / Math.max(0.2, cfg.downSec);
        if (s > -0.02) nextDown.push({s: Math.max(0, s), strength: d.strength * (dt > 0 ? Math.exp(-dt * 0.4) : 1)});
      }
      n.down = nextDown;
      // The send is the crown arrival. Nothing leaves before s reaches 1.
      if (n.climb >= 1 - 1e-9) fire(n);
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    for (const beam of beams) {
      if (beam.arrived) continue;
      beam.u = clamp((now - beam.t0) / Math.max(0.05, beam.dur), 0, 1);
      if (beam.u < 1) continue;
      beam.arrived = true;
      const to = nodes.get(beam.to);
      if (!to) continue;
      to.boost = clamp(to.boost + 0.22, 0, 1);
      to.down.push({s: 1, strength: 1});
      if (to.down.length > 4) to.down = to.down.slice(-4);
    }
    beams = beams.filter(b => !b.arrived || now < b.t0 + b.dur + 0.25);
    return api;
  }

  function lights(id) {
    const n = nodes.get(id);
    if (!n) return CHAKRA_S.map(s => ({s, up: 0, down: 0}));
    return CHAKRA_S.map(s => {
      const up = n.climb > 0.02 ? Math.exp(-((s - n.climb) ** 2) / (2 * 0.045 * 0.045)) : 0;
      let down = 0;
      for (const d of n.down) down = Math.max(down, d.strength * Math.exp(-((s - d.s) ** 2) / (2 * 0.045 * 0.045)));
      return {s, up, down};
    });
  }

  function snapshot() {
    return {
      sends,
      beams: beams.filter(b => !b.arrived).map(b => ({from: b.from, to: b.to, u: b.u, gen: b.gen})),
      dancers: [...nodes.values()].map(n => ({
        id: n.id,
        climb: n.climb,
        sustained: n.sustained,
        above: n.above,
        exit: n.exit,
        boost: n.boost,
        down: n.down.map(d => d.s),
      })),
    };
  }

  function setConfig(next) { applyConfig(cfg, next || {}); }
  function reset() {
    nodes.clear();
    beams = [];
    tPrev = null;
    sends = 0;
  }

  const api = {step, lights, snapshot, setConfig, reset, get config() { return {...cfg}; }};
  return api;
}

function applyConfig(cfg, opts) {
  if (Number.isFinite(+opts.peakThreshold)) cfg.peakThreshold = clamp(+opts.peakThreshold, 0.5, 0.99);
  if (Number.isFinite(+opts.peakDuration)) cfg.peakDuration = clamp(+opts.peakDuration, 0.2, 12);
  if (Number.isFinite(+opts.partnerCount)) cfg.partnerCount = clamp(Math.round(+opts.partnerCount), 1, 8);
  if (Number.isFinite(+opts.climbSec)) cfg.climbSec = clamp(+opts.climbSec, 0.3, 4);
  if (Number.isFinite(+opts.peakClimbSec)) cfg.peakClimbSec = clamp(+opts.peakClimbSec, 0.15, cfg.climbSec);
}

const mod = {
  PEAK_THRESHOLD, PEAK_DURATION, PARTNER_COUNT, CLIMB_SEC, PEAK_CLIMB_SEC, DOWN_SEC, EXIT_SEC, CHAKRA_S,
  createCrownPulse,
};
export default mod;
