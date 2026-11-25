// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Rare crowd events. Each event is a self-contained module in a registry
// keyed by name, so a later update can register or replace one without a
// page reload (TJ Nov 24, hot-update follow-up). An event steers dancers only
// through the crowd's public hooks: d.goal {x,y,until,speed}, d.liftGoal +
// d.liftUntil, d.huddle, d.slide. Crowd state stays in crowd-sim; an event
// keeps its own small run state in `run`.
//
// Module shape:
//   {name, label, minEnergy, cooldownS, weight,
//    available(crowd, map) -> bool, start(crowd, map, rnd) -> run|null,
//    step(crowd, map, run, dt) -> false when finished, needs: 'surface id'?}

import {clampToFloor, surfaceById} from './crowd-surfaces.js';
import {canClimb} from './crowd-sim.js';

export const EVENT_GLOBAL_GAP_S = 75;   // at most one auto event per this many seconds
export const EVENT_ROLL_S = 6;          // how often the auto scheduler rolls

const registry = new Map();
export function registerEvent(mod) {
  if (!mod || typeof mod.name !== 'string' || typeof mod.start !== 'function') throw new Error('bad event module');
  registry.set(mod.name, Object.freeze({minEnergy: 0.3, cooldownS: 600, weight: 1, available: () => true, step: () => true, ...mod}));
  return registry.get(mod.name);
}
export function eventModule(name) { return registry.get(name) || null; }
export function eventNames() { return [...registry.keys()]; }
export function eventRegistrySnapshot() { return new Map(registry); }
export function restoreEventRegistry(snap) { registry.clear(); for (const [k, v] of snap) registry.set(k, v); }

const floorDancers = (crowd, pred = () => true) => crowd.dancers.filter(d => d.where === 'floor' && !d.leaving && !d.goal && !d.huddle && pred(d));
const pickN = (list, n, rnd) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const steer = (crowd, d, x, y, s, speed = 1.2) => { d.goal = {x, y, until: crowd.t + s, speed}; };
const lift = (crowd, d, amount, s) => { d.liftGoal = amount; d.liftUntil = crowd.t + s; };
const release = (list) => { for (const d of list) { d.goal = null; d.huddle = null; } };

registerEvent({
  name: 'conga', label: 'Conga line', minEnergy: 0.35, cooldownS: 900, weight: 1,
  available: c => floorDancers(c).length >= 6,
  start(c, map, rnd) {
    const line = floorDancers(c).sort((a, b) => a.x - b.x).slice(0, 4 + Math.floor(rnd() * 5));
    return {line, t: 0, dur: 26, dir: rnd() < 0.5 ? 1 : -1};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release(run.line); return false; }
    const lead = run.line[0];
    // The leader snakes across the middle of the floor.
    const x = 500 + run.dir * 330 * Math.sin(run.t * 0.22), y = 470 + 60 * Math.sin(run.t * 0.5);
    const p = clampToFloor(map, x, y);
    steer(c, lead, p.x, p.y, 1, 1.1);
    for (let i = 1; i < run.line.length; i++) { const f = run.line[i - 1]; steer(c, run.line[i], f.x - run.dir * 18, f.y + 4, 1, 1.4); run.line[i].huddle = 'conga'; }
    lead.huddle = 'conga';
    return true;
  }
});

registerEvent({
  name: 'dance-circle', label: 'Dance circle', minEnergy: 0.5, cooldownS: 720, weight: 1.2,
  available: c => floorDancers(c).length >= 7,
  start(c, map, rnd) {
    const center = clampToFloor(map, 380 + rnd() * 240, 440 + rnd() * 60);
    const ring = floorDancers(c).sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y)).slice(0, 7);
    return {center, ring, mid: ring[0], t: 0, dur: 22};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release(run.ring); return false; }
    const n = run.ring.length - 1;
    steer(c, run.mid, run.center.x, run.center.y, 1, 1.3);
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 + run.t * 0.05;
      const p = clampToFloor(map, run.center.x + 62 * Math.cos(a), run.center.y + 22 * Math.sin(a));
      steer(c, run.ring[i], p.x, p.y, 1, 1.3);
      run.ring[i].huddle = 'circle';
    }
    return true;
  }
});

registerEvent({
  name: 'crowd-surf', label: 'Crowd surf', minEnergy: 0.6, cooldownS: 600, weight: 1,
  available: c => floorDancers(c, d => d.y < 470).length >= 4,
  start(c, map, rnd) {
    const d = pickN(floorDancers(c, x => x.y < 470), 1, rnd)[0];
    if (!d) return null;
    const dir = d.x < 500 ? 1 : -1;
    lift(c, d, 0.38, 11);
    return {d, dir, t: 0, dur: 11, x0: d.x};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release([run.d]); return false; }
    const p = clampToFloor(map, run.x0 + run.dir * 34 * run.t, 400 + 10 * Math.sin(run.t));
    steer(c, run.d, p.x, p.y, 1, 1.6);
    return true;
  }
});

registerEvent({
  name: 'stage-dive', label: 'Stage dive', minEnergy: 0.7, cooldownS: 900, weight: 0.8,
  // Someone has to be up on the stage first.
  available: c => c.dancers.some(d => d.where === 'on' && d.surface === 'stage' && !d.plan),
  start(c, map, rnd) {
    const d = c.dancers.find(x => x.where === 'on' && x.surface === 'stage' && !x.plan);
    if (!d) return null;
    // Leap forward: drop to the floor in front of the stage, carried.
    d.where = 'floor'; d.surface = 'floor'; d.plan = null; if (c.freshRid) c.freshRid(d);
    const p = clampToFloor(map, d.x, (surfaceById(map, 'stage') || {baseY: 380}).baseY + 16);
    d.x = p.x; d.y = p.y; d.vx = 0; d.vy = 0;
    lift(c, d, 0.42, 7);
    return {d, t: 0, dur: 7, dir: rnd() < 0.5 ? -1 : 1, x0: d.x};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release([run.d]); return false; }
    const p = clampToFloor(map, run.x0 + run.dir * 28 * run.t, 400 + 6 * run.t);
    steer(c, run.d, p.x, p.y, 1, 1.5);
    return true;
  }
});

registerEvent({
  name: 'dome-slide', label: 'Dome slide', minEnergy: 0.55, cooldownS: 600, weight: 1,
  available: c => c.dancers.some(d => d.where === 'on' && d.surface === 'dome'),
  start(c) {
    const d = c.dancers.find(x => x.where === 'on' && x.surface === 'dome');
    if (!d) return null;
    d.slide = true;
    d.plan = {surface: 'dome', phase: 'down', side: d.arcT >= 0.5 ? 1 : 0};
    d.side = d.plan.side;
    return {d, t: 0};
  },
  step(c, map, run, dt) { run.t += dt; if (run.d.where === 'floor' || run.t > 12) { run.d.slide = false; return false; } return true; }
});

registerEvent({
  name: 'shoulder-ride', label: 'Shoulder ride', minEnergy: 0.5, cooldownS: 700, weight: 1,
  available: c => floorDancers(c).length >= 4,
  start(c, map, rnd) {
    const [a, b] = pickN(floorDancers(c, d => d.y < 520), 2, rnd);
    if (!a || !b) return null;
    lift(c, b, 0.5, 18);
    a.huddle = b.huddle = 'shoulders' + a.id;
    return {a, b, t: 0, dur: 18};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release([run.a, run.b]); return false; }
    steer(c, run.b, run.a.x, run.a.y - 0.5, 1, 1.8);
    return true;
  }
});

registerEvent({
  name: 'hug-pileup', label: 'Hug pileup', minEnergy: 0.45, cooldownS: 800, weight: 0.9,
  available: c => floorDancers(c).length >= 5,
  start(c, map, rnd) {
    const seed = pickN(floorDancers(c), 1, rnd)[0];
    if (!seed) return null;
    const group = floorDancers(c).sort((a, b) => Math.hypot(a.x - seed.x, a.y - seed.y) - Math.hypot(b.x - seed.x, b.y - seed.y)).slice(0, 5);
    for (const d of group) d.huddle = 'hug' + seed.id;
    return {group, at: {x: seed.x, y: seed.y}, t: 0, dur: 9};
  },
  step(c, map, run, dt) {
    run.t += dt;
    if (run.t > run.dur) { release(run.group); return false; }
    run.group.forEach((d, i) => steer(c, d, run.at.x + (i - 2) * 7, run.at.y + (i % 2) * 4, 1, 1.3));
    return true;
  }
});

registerEvent({
  // Lights up over the crowd: drawn by the fx layer from dancer markers.
  name: 'lighter-wave', label: 'Lighter wave', minEnergy: 0.15, cooldownS: 900, weight: 0.8, fx: 'lighters',
  available: c => c.activeCount() >= 6,
  start() { return {t: 0, dur: 16}; },
  step(c, map, run, dt) { run.t += dt; return run.t <= run.dur; }
});

// Pole (left), cage (right) and the rope from the dome top. Only gated
// climbers go up (rested, high stamina, high drive: crowd.sendUp); if nobody
// is up there yet, the event sends one and waits for them to arrive.
const climbers = (c, n, rnd) => pickN(c.dancers.filter(d => d.where === 'floor' && !d.plan && !d.leaving && !d.goal && !d.huddle && canClimb(d, 'climb')), n, rnd);
const onSurface = (c, id) => c.dancers.filter(d => d.where === 'on' && d.surface === id && !(d.plan && d.plan.phase === 'down'));
const headingTo = (c, id) => c.dancers.filter(d => d.plan && d.plan.surface === id && d.plan.phase !== 'down' || (d.where === 'climb' && d.surface === id && !(d.plan && d.plan.phase === 'down')));
function sendClimbers(c, id, want, rnd) {
  let sent = 0;
  for (const d of climbers(c, want, rnd)) if (c.sendUp && c.sendUp(d, id)) sent++;
  return sent;
}

registerEvent({
  name: 'pole-spin', label: 'Pole spin', needs: 'pole', minEnergy: 0.5, cooldownS: 600, weight: 0.9,
  available: c => onSurface(c, 'pole').length + headingTo(c, 'pole').length > 0 || climbers(c, 1, Math.random).length > 0,
  start(c, map, rnd) {
    if (!onSurface(c, 'pole').length && !headingTo(c, 'pole').length && !sendClimbers(c, 'pole', 1, rnd)) return null;
    return {t: 0, spun: 0, dur: 12, wait: 30};
  },
  step(c, map, run, dt) {
    run.t += dt;
    const on = onSurface(c, 'pole');
    for (const d of c.dancers) if (d.spin && !on.includes(d)) d.spin = false;
    if (on.length) { run.spun += dt; for (const d of on) d.spin = true; }
    if (run.spun > run.dur || (!on.length && run.t > run.wait)) { for (const d of on) d.spin = false; return false; }
    return true;
  }
});

registerEvent({
  name: 'cage-shake', label: 'Cage shake', needs: 'cage', minEnergy: 0.5, cooldownS: 600, weight: 0.9,
  available: c => onSurface(c, 'cage').length + headingTo(c, 'cage').length > 0 || climbers(c, 1, Math.random).length > 0,
  start(c, map, rnd) {
    const have = onSurface(c, 'cage').length + headingTo(c, 'cage').length;
    if (have < 2) sendClimbers(c, 'cage', 2 - have, rnd);
    if (!onSurface(c, 'cage').length && !headingTo(c, 'cage').length) return null;
    return {t: 0, shook: 0, dur: 9, wait: 30};
  },
  step(c, map, run, dt) {
    run.t += dt;
    const on = onSurface(c, 'cage');
    for (const d of c.dancers) if (d.shake && !on.includes(d)) d.shake = false;
    if (on.length) { run.shook += dt; for (const d of on) d.shake = true; }
    c.cageShake = on.length ? Math.min(1, 0.4 + 0.3 * on.length) : 0;
    if (run.shook > run.dur || (!on.length && run.t > run.wait)) { for (const d of on) d.shake = false; c.cageShake = 0; return false; }
    return true;
  }
});

registerEvent({
  name: 'rope-swing', label: 'Rope swing', needs: 'rope', minEnergy: 0.55, cooldownS: 600, weight: 0.8,
  available: c => onSurface(c, 'dome').length + headingTo(c, 'dome').length > 0 || climbers(c, 1, Math.random).length > 0,
  start(c, map, rnd) {
    let d = onSurface(c, 'dome')[0] || headingTo(c, 'dome')[0] || null;
    if (!d) { const [x] = climbers(c, 1, rnd); if (x && c.sendUp(x, 'dome')) d = x; }
    if (!d) return null;
    return {d, t: 0, swung: false, wait: 40, swingS: 10};
  },
  step(c, map, run, dt) {
    run.t += dt;
    const d = run.d;
    if (!c.dancers.includes(d)) return false;
    if (run.swung) return d.surface === 'rope';
    if (d.where === 'on' && d.surface === 'dome') {
      // Walk along the dome top to the apex, then take the rope.
      d.arcGoal = 0.5; d.retargetAt = c.t + 5;
      if (Math.abs(d.arcT - 0.5) < 0.02 && c.grabRope(d, run.swingS)) run.swung = true;
    }
    return run.t < run.wait || run.swung;
  }
});

// Runs events: manual triggers from the remote, plus rare automatic ones
// chosen by energy with per-event and global cooldowns.
export function createEventDirector(opts = {}) {
  const rnd = opts.rnd || Math.random;
  const st = {active: [], lastAt: new Map(), lastAuto: -Infinity, nextRoll: 0, log: [], auto: opts.auto !== false};
  const canRun = (mod, crowd, map, t, manual) => {
    if (!mod) return 'unknown event';
    if (mod.needs && !surfaceById(map, mod.needs)) return 'needs the ' + mod.needs + ' surface (not built yet)';
    if (st.active.some(a => a.name === mod.name)) return 'already running';
    if (!manual && t - (st.lastAt.get(mod.name) ?? -Infinity) < mod.cooldownS) return 'cooling down';
    if (!mod.available(crowd, map)) return 'nobody in position';
    return '';
  };
  const begin = (mod, crowd, map, t, why) => {
    const run = mod.start(crowd, map, rnd);
    if (!run) return {ok: false, reason: 'nobody in position'};
    st.active.push({name: mod.name, run, fx: mod.fx || '', at: t});
    st.lastAt.set(mod.name, t);
    st.log.unshift({name: mod.name, at: t, why}); st.log.length = Math.min(st.log.length, 8);
    if (opts.onBegin) try { opts.onBegin(mod, why); } catch { /* caption only */ }
    return {ok: true};
  };
  return {
    trigger(name, crowd, map, why = 'remote') {
      const mod = eventModule(name);
      const no = canRun(mod, crowd, map, crowd.t, true);
      if (no) return {ok: false, reason: no};
      return begin(mod, crowd, map, crowd.t, why);
    },
    // energy: show energy 0..1 (boosted); audio: mic energy.
    step(crowd, map, dt, energy = 0, audio = 0) {
      const t = crowd.t;
      st.active = st.active.filter(a => { const mod = eventModule(a.name); return mod && mod.step(crowd, map, a.run, dt) !== false; });
      if (!st.auto || t < st.nextRoll) return;
      st.nextRoll = t + EVENT_ROLL_S;
      if (t - st.lastAuto < EVENT_GLOBAL_GAP_S || st.active.length) return;
      const e = Math.max(energy, 0.7 * energy + 0.3 * audio);
      const pool = eventNames().map(eventModule).filter(m => e >= m.minEnergy && !canRun(m, crowd, map, t, false));
      if (!pool.length) return;
      // Rare: roughly one event every few minutes at peak, far fewer early.
      if (rnd() > 0.04 + 0.16 * e * e) return;
      let w = pool.reduce((s, m) => s + m.weight, 0) * rnd();
      const mod = pool.find(m => (w -= m.weight) <= 0) || pool[pool.length - 1];
      if (begin(mod, crowd, map, t, 'auto').ok) st.lastAuto = t;
    },
    activeFx() { return st.active.filter(a => a.fx).map(a => ({fx: a.fx, run: a.run})); },
    state() { return {active: st.active.map(a => a.name), recent: st.log.slice(0, 5)}; },
    setAuto(on) { st.auto = !!on; }
  };
}
