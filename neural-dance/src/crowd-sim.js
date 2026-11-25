// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Crowd of roaming dancers for /neural-dance/demo/ and /neural-dance/show/.
// Pure state + step(); the page turns dancers() into roam markers for the
// existing silhouette renderer. Feet always sit on a walkable surface from
// crowd-surfaces.js.
//
// Behaviour:
// - Stage attraction: targets are drawn toward the stage front, so density
//   falls off toward the back. Attraction grows with mic energy (song
//   peaks pack the front) and the show's energy, and relaxes as they drop.
// - Spacing: personal space scaled by depth, a little tighter when packed.
// - Fatigue: dancing near the front at high energy tires a dancer; tired
//   dancers drift to the back, dance calmer, recover, and come forward
//   again. Stamina is per dancer so they do not all cycle at once.
// - Climbing: the stage is open to rested dancers; speakers and the dome
//   only to high-stamina, high-drive, rested dancers, more often as energy
//   rises. Climbers come back down when fatigue builds.

import {CROWD_SURFACES, CROWD_STAGE_H, arcPoint, clampToFloor, clampToPoly, climbSegment, heightAt, onFloor, pointInPoly, ropeEnd, surfaceById} from './crowd-surfaces.js';

export const CROWD_CAP_DEFAULT = 40;
export const FATIGUE_S = 150;      // s of full-front, full-energy dancing to tire out (stamina 1)
export const RECOVER_S = 55;       // s of rest at the back to recover (stamina 1)
export const TIRED_AT = 1;
export const RESTED_AT = 0.25;
export const CLIMB_DOWN_AT = 0.6;  // climbers come down once fatigue reaches this
export const CLIMB_MAX_FATIGUE = 0.35;
export const CLIMB_MIN_STAMINA = 1.05;
export const CLIMB_MIN_DRIVE = 0.6;
export const CLIMB_S = 2.6;
export const CAPACITY = {stage: 8, speakerL: 2, speakerR: 2, dome: 4, pole: 1, cage: 3, rope: 1};
// Raised places a gated climber may pick on its own (the rope is event-only).
export const CLIMB_SURFACES = ['speakerL', 'speakerR', 'dome', 'pole', 'cage'];

export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = v => Math.max(0, Math.min(1, +v || 0));

// Stage attraction 0..~1.2 from mic energy, show energy and the boost.
export function stageAttraction(audio, energy, boost = 0) {
  return Math.max(0, Math.min(1.2, 0.2 + 0.6 * clamp01(audio) + 0.35 * clamp01(energy) + 0.5 * (+boost || 0)));
}

// Chance a rested climber-eligible dancer heads up on a retarget.
export function climbChance(energy) {
  const e = clamp01(energy);
  return 0.03 + 0.55 * e * e;
}

export function canClimb(d, gate = 'climb') {
  if (!d || d.resting) return false;
  if (gate === 'any') return d.fatigue < 0.6;
  return d.stamina >= CLIMB_MIN_STAMINA && d.drive >= CLIMB_MIN_DRIVE && d.fatigue < CLIMB_MAX_FATIGUE;
}

// Depth 0 = stage front, 1 = back of the floor (bottom edge).
export function depthOf(map, y) {
  const y0 = map.stageFront.y, y1 = CROWD_STAGE_H - 8;
  return clamp01((y - y0) / (y1 - y0));
}
export function yAtDepth(map, u) {
  const y0 = map.stageFront.y, y1 = CROWD_STAGE_H - 8;
  return y0 + clamp01(u) * (y1 - y0);
}

export function createCrowd({map = CROWD_SURFACES, cap = CROWD_CAP_DEFAULT, seed = 1} = {}) {
  const rnd = mulberry32(seed);
  const crowd = {map, cap: Math.max(1, cap | 0), dancers: [], nextId: 1, t: 0, rnd, attraction: 0.3, energy: 0, audio: 0};

  function feetBase(d) {
    if (d.where === 'floor') return d.y;
    const s = surfaceById(map, d.surface);
    if (d.where === 'climb') {
      const seg = climbSegment(map, s, d.side);
      return seg[0][1] + (s.baseY - seg[0][1]) * clamp01(d.climbT);
    }
    return s ? s.baseY : d.y;
  }
  crowd.heightOf = d => heightAt(map, feetBase(d));

  crowd.add = function (opts = {}) {
    let removed = null;
    const active = crowd.dancers.filter(d => !d.leaving);
    if (active.length >= crowd.cap) {
      // Recycle the oldest.
      const oldest = active.reduce((a, b) => (a.born <= b.born ? a : b));
      crowd.dancers = crowd.dancers.filter(d => d !== oldest);
      removed = oldest.id;
    }
    const id = crowd.nextId;
    crowd.nextId = crowd.nextId >= 90000 ? 1 : crowd.nextId + 1;
    const x = Number.isFinite(+opts.x) ? +opts.x : 140 + rnd() * 720;
    const y = Number.isFinite(+opts.y) ? +opts.y : CROWD_STAGE_H - 10;
    const p = clampToFloor(map, x, y);
    const d = {
      id, type: Number.isFinite(+opts.type) ? ((opts.type | 0) % 4 + 4) % 4 : (id % 4),
      x: p.x, y: p.y, vx: 0, vy: 0, tx: p.x, ty: p.y, where: 'floor', surface: 'floor', side: 0, climbT: 0, arcT: 0.5,
      born: crowd.t, pauseUntil: 0, retargetAt: 0,
      stamina: Number.isFinite(+opts.stamina) ? +opts.stamina : 0.65 + rnd() * 0.75,
      drive: Number.isFinite(+opts.drive) ? +opts.drive : rnd(),
      fatigue: Number.isFinite(+opts.fatigue) ? +opts.fatigue : rnd() * 0.5,
      resting: false, plan: null, leaving: false, onTopSince: 0, rid: id
    };
    crowd.dancers.push(d);
    pickTarget(d);
    return {id, removed};
  };

  // The renderer keeps per-dancer foot pins and body springs keyed by id.
  // A change of surface (floor <-> climb <-> on top) starts a fresh render id
  // so no floor-level state drags the body when the floor line jumps.
  function freshRid(d) {
    d.rid = crowd.nextId;
    crowd.nextId = crowd.nextId >= 90000 ? 1 : crowd.nextId + 1;
  }
  crowd.freshRid = freshRid;

  crowd.activeCount = () => crowd.dancers.filter(d => !d.leaving).length;

  // Walk the oldest off the back instead of popping them out.
  crowd.retire = function (n = 1) {
    let left = n | 0;
    const order = crowd.dancers.filter(d => !d.leaving).sort((a, b) => (b.resting - a.resting) || (a.born - b.born));
    for (const d of order) {
      if (left <= 0) break;
      d.leaving = true; d.leftAt = crowd.t;
      if (d.where !== 'floor') d.plan = {surface: d.surface, phase: 'down', side: d.side};
      left--;
    }
  };

  function surfaceCount(id) { return crowd.dancers.filter(d => d.plan && d.plan.surface === id || (d.where !== 'floor' && d.surface === id)).length; }

  crowd.surfaceCount = surfaceCount;
  // Events (pole spin, cage shake, rope swing) send one gated climber up.
  // Same gate as a climber choosing on its own: rested, stamina, drive.
  crowd.sendUp = function (d, id) {
    const s = surfaceById(map, id);
    if (!s || !d || d.where !== 'floor' || d.plan || d.leaving || !canClimb(d, s.gate) || surfaceCount(id) >= (CAPACITY[id] || 2)) return false;
    const side = s.arc ? (d.x < map.stageFront.x ? 0 : 1) : 0;
    d.plan = {surface: id, phase: 'approach', side};
    const acc = climbSegment(map, s, side)[0];
    d.tx = acc[0]; d.ty = acc[1]; d.goal = null;
    return true;
  };
  // Rope: a dome climber at the apex takes the rope for `seconds`.
  crowd.grabRope = function (d, seconds = 10) {
    const rope = map.rope;
    if (!rope || !d || d.where !== 'on' || d.surface !== 'dome' || surfaceCount('rope') >= CAPACITY.rope) return false;
    d.surface = 'rope'; d.ropeUntil = crowd.t + seconds; d.ropeT0 = crowd.t; d.plan = null;
    freshRid(d);
    stepRope(d);
    return true;
  };
  function stepRope(d) {
    const rope = map.rope;
    const w = 2 * Math.PI / rope.periodS, age = crowd.t - d.ropeT0;
    // Swing builds up, then settles before letting go.
    const env = Math.min(1, age / 2.5, Math.max(0, d.ropeUntil - crowd.t) / 2);
    const theta = rope.amp * env * Math.sin(w * age);
    crowd.ropeAngle = theta;
    const end = ropeEnd(rope, theta);
    d.x = end.x; d.y = end.y + 0.85 * heightAt(map, rope.baseY);
    if (crowd.t >= d.ropeUntil) {
      // Back onto the dome top at the apex.
      d.surface = 'dome'; d.arcT = 0.5; d.arcGoal = 0.5; d.ropeUntil = 0; crowd.ropeAngle = 0;
      freshRid(d);
      const p = arcPoint(map.dome.arc, 0.5); d.x = p.x; d.y = p.y;
      d.retargetAt = crowd.t + 3;
    }
  }

  function pickFloorTarget(d) {
    const A = crowd.attraction;
    let u;
    if (d.leaving) u = 1;
    else if (d.resting) u = 0.62 + 0.38 * rnd();
    else {
      const a = A * (1 - 0.7 * clamp01(d.fatigue));
      u = Math.pow(rnd(), 1 + 3.2 * a);
    }
    const spread = 170 + 330 * u;
    const x = map.stageFront.x + (rnd() * 2 - 1) * spread;
    const p = clampToFloor(map, x, d.leaving ? CROWD_STAGE_H - 2 : yAtDepth(map, u) + (rnd() - 0.5) * 10);
    d.tx = p.x; d.ty = p.y;
  }

  function maybeClimbPlan(d) {
    if (d.leaving || d.resting) return null;
    const e = Math.max(crowd.energy, crowd.audio);
    const opts = [];
    const stage = surfaceById(map, 'stage');
    if (stage && canClimb(d, 'any') && surfaceCount('stage') < (CAPACITY.stage || 6) && rnd() < 0.06 + 0.18 * e) opts.push('stage');
    if (canClimb(d, 'climb') && rnd() < climbChance(e)) {
      for (const id of CLIMB_SURFACES) if (surfaceById(map, id) && surfaceCount(id) < (CAPACITY[id] || 2)) opts.push(id);
    }
    if (!opts.length) return null;
    const id = opts[Math.floor(rnd() * opts.length)];
    return {surface: id, phase: 'approach', side: id === 'dome' ? (d.x < map.stageFront.x ? 0 : 1) : 0};
  }

  function pickTarget(d) {
    d.retargetAt = crowd.t + 7 + rnd() * 9;
    if (d.where === 'floor' && !d.plan) {
      const plan = maybeClimbPlan(d);
      if (plan) {
        d.plan = plan;
        const s = surfaceById(map, plan.surface);
        const acc = climbSegment(map, s, plan.side)[0];
        d.tx = acc[0]; d.ty = acc[1];
        return;
      }
      pickFloorTarget(d);
      return;
    }
    if (d.where === 'on') {
      const s = surfaceById(map, d.surface);
      if (s.arc) { d.arcGoal = 0.22 + rnd() * 0.56; return; }
      const xs = s.poly.map(p => p[0]), ys = s.poly.map(p => p[1]);
      d.tx = Math.min(...xs) + 4 + rnd() * (Math.max(...xs) - Math.min(...xs) - 8);
      d.ty = Math.min(...ys) + 2 + rnd() * (Math.max(...ys) - Math.min(...ys) - 4);
    }
  }
  crowd.pickTarget = pickTarget;

  function updateFatigue(d, dt) {
    const e = Math.max(crowd.energy, crowd.audio);
    const front = d.where === 'floor' ? 1 - depthOf(map, d.y) : 1;
    const climbMul = d.where === 'floor' ? 1 : 1.6;
    if (!d.resting) {
      const gain = front * front * (0.3 + 0.7 * e) * climbMul / (FATIGUE_S * d.stamina);
      const back = d.where === 'floor' ? depthOf(map, d.y) : 0;
      d.fatigue = clamp01(d.fatigue + dt * (gain - (back > 0.7 ? 0.25 * d.stamina / RECOVER_S : 0)));
      if (d.fatigue >= TIRED_AT) {
        d.resting = true;
        if (d.where !== 'floor') d.plan = {surface: d.surface, phase: 'down', side: d.side};
        else { d.plan = null; pickFloorTarget(d); d.pauseUntil = 0; }
      }
    } else {
      const back = d.where === 'floor' ? depthOf(map, d.y) : 0;
      d.fatigue = clamp01(d.fatigue - dt * d.stamina * (back >= 0.55 ? 1 : 0.3) / RECOVER_S);
      if (d.fatigue <= RESTED_AT) { d.resting = false; d.pauseUntil = 0; pickFloorTarget(d); }
    }
    if (d.where !== 'floor' && d.plan == null && d.surface !== 'stage' && d.surface !== 'rope' && d.fatigue >= CLIMB_DOWN_AT) d.plan = {surface: d.surface, phase: 'down', side: d.side};
    if (d.where === 'on' && d.surface === 'stage' && d.plan == null && (d.fatigue >= 0.75 || crowd.t - d.onTopSince > 40)) d.plan = {surface: 'stage', phase: 'down', side: 0};
  }

  function walkSpeed(d, h) {
    const e = Math.max(crowd.energy, crowd.audio);
    return (d.resting ? 0.16 : 0.22 + 0.22 * e) * h;
  }

  function stepFloor(d, dt, h) {
    const surge = d.resting || d.leaving ? 0 : Math.max(0, crowd.audio - 0.55) * 1.6;
    // A rare event (crowd-events.js) may steer this dancer for a while.
    const g = d.goal;
    let dx = (g ? g.x : d.tx) - d.x, dy = (g ? g.y : d.ty) - d.y;
    let dist = Math.hypot(dx, dy);
    const v = walkSpeed(d, h) * (g && g.speed ? g.speed : 1);
    let wantX = 0, wantY = 0;
    const paused = !g && crowd.t < d.pauseUntil;
    if (!paused && dist > 0.12 * h) {
      const k = v * Math.min(1, dist / (0.5 * h)) / (dist || 1);
      wantX = dx * k; wantY = dy * k;
    } else if (!paused && !d.plan && !g) {
      d.pauseUntil = crowd.t + (d.leaving ? 0 : (2 + crowd.rnd() * 7) * (1.2 - 0.5 * crowd.energy));
    }
    // Song peaks: everyone not resting leans toward the stage front.
    if (surge > 0 && !d.plan && !g) {
      const sx = map.stageFront.x - d.x, sy = map.stageFront.y + 14 - d.y, sd = Math.hypot(sx, sy) || 1;
      wantX += sx / sd * surge * 0.35 * h; wantY += sy / sd * surge * 0.35 * h;
    }
    // Personal space (depth-scaled). Packs a little tighter with attraction.
    const R = h * (0.46 - 0.14 * Math.min(1, crowd.attraction));
    for (const o of crowd.dancers) {
      if (o === d || o.where !== 'floor') continue;
      if (d.huddle && d.huddle === o.huddle) continue;
      const ox = d.x - o.x, oy = (d.y - o.y) * 2.0, od = Math.hypot(ox, oy);
      if (od >= R || od < 1e-6) continue;
      const push = (R - od) / R * v * 2.2;
      wantX += ox / od * push; wantY += oy / od * push / 2.0;
    }
    const a = 1 - Math.exp(-dt * 3);
    d.vx += (wantX - d.vx) * a; d.vy += (wantY - d.vy) * a;
    const p = clampToFloor(map, d.x + d.vx * dt, d.y + d.vy * dt);
    d.x = p.x; d.y = p.y;
    if (d.plan && d.plan.phase === 'approach' && Math.hypot(d.tx - d.x, d.ty - d.y) < Math.max(4, 0.15 * h)) {
      const s = surfaceById(map, d.plan.surface);
      if (!s || !canClimb(d, s.gate)) { d.plan = null; pickFloorTarget(d); return; }
      d.where = 'climb'; d.surface = d.plan.surface; d.side = d.plan.side; d.climbT = 0; d.plan.phase = 'up';
      freshRid(d);
      placeOnClimb(d);
    }
  }

  function placeOnClimb(d) {
    const s = surfaceById(map, d.surface);
    const [a, b] = climbSegment(map, s, d.side);
    const t = clamp01(d.climbT);
    d.x = a[0] + (b[0] - a[0]) * t; d.y = a[1] + (b[1] - a[1]) * t;
  }

  function stepClimb(d, dt) {
    const s = surfaceById(map, d.surface);
    const dur = (s.arc ? CLIMB_S * 1.3 : (s.id === 'stage' ? CLIMB_S * 0.5 : CLIMB_S)) * (d.slide ? 0.3 : 1);
    const dir = d.plan && d.plan.phase === 'down' ? -1 : 1;
    d.climbT += dir * dt / dur;
    if (d.climbT >= 1) {
      d.climbT = 1; placeOnClimb(d);
      d.where = 'on'; d.onTopSince = crowd.t;
      freshRid(d);
      d.arcT = d.side ? 1 : 0;
      d.plan = null; pickTarget(d);
      if (s.arc) d.arcGoal = 0.25 + crowd.rnd() * 0.5;
      return;
    }
    if (d.climbT <= 0) {
      d.climbT = 0; placeOnClimb(d);
      d.where = 'floor'; d.surface = 'floor'; d.plan = null; d.slide = false;
      freshRid(d);
      const p = clampToFloor(map, d.x, d.y); d.x = p.x; d.y = p.y;
      d.pauseUntil = 0; pickFloorTarget(d);
      return;
    }
    placeOnClimb(d);
  }

  function stepOn(d, dt, h) {
    const s = surfaceById(map, d.surface);
    const leavingTop = d.plan && d.plan.phase === 'down';
    if (s.arc) {
      const goal = leavingTop ? (d.side ? 1 : 0) : (Number.isFinite(d.arcGoal) ? d.arcGoal : 0.5);
      const step = (0.05 + 0.04 * crowd.energy) * dt * (d.slide ? 7 : 1);
      const diff = goal - d.arcT;
      d.arcT += Math.sign(diff) * Math.min(Math.abs(diff), step);
      if (!leavingTop && Math.abs(diff) < 1e-3 && crowd.t > d.retargetAt) pickTarget(d);
      const p = arcPoint(s.arc, d.arcT); d.x = p.x; d.y = p.y;
      if (leavingTop && Math.abs(d.arcT - goal) < 1e-3) { d.where = 'climb'; d.climbT = 1; freshRid(d); }
      return;
    }
    const gx = leavingTop ? s.entry[0] : d.tx, gy = leavingTop ? s.entry[1] : d.ty;
    const dx = gx - d.x, dy = gy - d.y, dist = Math.hypot(dx, dy), v = 0.18 * h;
    if (dist > 1) { const k = Math.min(dist, v * dt) / dist; d.x += dx * k; d.y += dy * k; }
    else if (leavingTop) { d.where = 'climb'; d.climbT = 1; freshRid(d); return; }
    else if (crowd.t > d.retargetAt) pickTarget(d);
    const p = clampToPoly(s.poly, d.x, d.y); d.x = p.x; d.y = p.y;
  }

  // env: {audio 0..1 (mic, smoothed), energy 0..1 (schedule or demo base), boost}
  crowd.step = function (dt, env = {}) {
    const h = Math.max(0, Math.min(0.25, +dt || 0));
    crowd.t += h;
    crowd.audio = clamp01(env.audio);
    crowd.energy = clamp01((+env.energy || 0) + (+env.boost || 0));
    crowd.attraction = stageAttraction(crowd.audio, env.energy, env.boost);
    for (const d of crowd.dancers) {
      updateFatigue(d, h);
      const ht = crowd.heightOf(d);
      if (d.goal && !(crowd.t < d.goal.until)) d.goal = null;
      { const want = crowd.t < d.liftUntil ? (+d.liftGoal || 0) : 0; d.lift = (+d.lift || 0) + (want - (+d.lift || 0)) * (1 - Math.exp(-h * 3)); if (Math.abs(d.lift) < 1e-3 && !want) d.lift = 0; }
      if (d.where === 'floor') {
        if (!d.goal && !d.plan && !d.leaving && crowd.t > d.retargetAt && crowd.t >= d.pauseUntil) pickTarget(d);
        stepFloor(d, h, ht);
      } else if (d.where === 'climb') stepClimb(d, h);
      else if (d.surface === 'rope') stepRope(d);
      else stepOn(d, h, ht);
    }
    // Walked off the back.
    crowd.dancers = crowd.dancers.filter(d => !(d.leaving && d.where === 'floor' && (d.y >= CROWD_STAGE_H - 12 || crowd.t - d.leftAt > 30)));
  };

  crowd.setCount = function (target, maxChanges = 1) {
    const want = Math.max(0, Math.min(crowd.cap, Math.round(+target || 0)));
    let n = crowd.activeCount(), changes = 0;
    while (n < want && changes < maxChanges) { crowd.add(); n++; changes++; }
    if (n > want && changes < maxChanges) crowd.retire(Math.min(maxChanges - changes, n - want));
    return crowd.activeCount();
  };

  // Markers for room-lab setMarkers (center y = feet - 0.49 h), back to front.
  crowd.markers = function () {
    const out = crowd.dancers.map(d => {
      const h = crowd.heightOf(d);
      // lift: carried above the crowd (crowd surf, shoulders); feet stay on the floor point.
      // Event wobble: spin around the pole, rattling the cage bars, debut steps.
      const ox = (+d.offX || 0) + (d.spin ? 9 * Math.sin(crowd.t * 5.2) : 0) + (d.shake ? 2.4 * Math.sin(crowd.t * 37 + d.id) : 0);
      return {id: d.rid, x: Math.round((d.x + ox) * 10) / 10, y: Math.round((d.y - (0.49 + (+d.lift || 0) + (+d.hop || 0)) * h) * 10) / 10, type: d.type, kind: 'sticker', roam: true, calm: d.resting ? Math.min(1, 0.4 + 0.6 * d.fatigue) : 0, ...(d.move ? {move: d.move} : {}), projectedHeight: Math.round(h * 10) / 10, _base: d.where === 'floor' ? d.y : surfaceById(map, d.surface).baseY};
    });
    out.sort((a, b) => a._base - b._base);
    for (const m of out) delete m._base;
    return out;
  };

  crowd.onSolid = d => (d.where === 'floor' ? onFloor(map, d.x, d.y) : true);
  return crowd;
}

export {pointInPoly};
