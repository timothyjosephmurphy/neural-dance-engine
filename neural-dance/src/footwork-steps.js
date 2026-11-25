// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Footwork step library (TJ Nov 11 11:12 PM): "incorporate all these steps
// and have dancers do them at different times. There should be a variety of
// dancers but they should choose steps that are appropriate to the beat."
//
// Steps (each is a short cycle of foot events on the step clock):
//   stepTouch      TJ's favourite: step side, the other foot taps in beside
//                  it with no weight, then the other way.
//   grapevine      side, behind, side, touch (4 events), then reverse. The
//                  "behind" foot goes back and in but never crosses the
//                  standing foot (the minimum stance width rule still holds).
//   boxStep        forward, side, back, side (close).
//   rockStep       rock forward onto one foot, recover, rock back, recover.
//   kickBallChange kick, ball tap beside, change (weight), step. Used as an
//                  accent in the last bar before a phrase downbeat.
//   tStep          heel-toe: alternating steps inching sideways (the heel /
//                  toe swivel stays in rave-moves kinematics).
//   runningMan     high knee on the "and", alternate landings front / back.
//   chasse         side-together-side, touch, then the other way (travels).
//
// Rules:
//   * Weight changes land on beats (event boundaries). Taps put the foot on
//     its toe with NO weight: the stance (planted) foot does not change.
//   * Steps switch only on phrase boundaries (4 or 8 bars per dancer, its
//     own offset). A new step starts with the currently free foot, and a
//     foot only moves while it is in the air, so a switch never snaps.
//   * Each dancer has a seeded personality: a preferred subset, phrase
//     length, offset and size.
//   * Choice follows the music (TJ Nov 12 brief):
//       tempo    below ~110 BPM every step can land on every beat; from 110
//                the busy traveling steps go half-time; from 125 BPM all
//                feet go half-time and kick-ball-change is a rare accent.
//       energy   low = step-touch, rock step; mid = grapevine, box step,
//                heel-toe, side-together-side; high / peaks = running man,
//                with kick-ball-change on the phrase-end fills.
//       section  breakdown = calm and small; build = small steps that get
//                tighter as the build rises; drop = the renderer's jump
//                stomp, then the high-energy steps.
//   * Each dancer also lifts a little earlier or later inside the beat
//     (seeded lag) so neighbours rarely match; every landing stays on the beat.
//   * Foot targets stay inside the home leash and inside the stance width
//     bounds (min just under hip width, max 2 shoulder widths).
//
// Positions are in the dancer's home frame (unit-pose x lateral, z toward
// the audience). Only relative foot positions reach the world: the live
// renderer pins the planted contact, so travel is walked, never slid.

export const FOOTWORK_STEPS = ['stepTouch', 'grapevine', 'boxStep', 'rockStep', 'kickBallChange', 'tStep', 'runningMan', 'chasse'];
export const FOOTWORK_LABELS = {
  stepTouch: 'Step-touch',
  grapevine: 'Grapevine',
  boxStep: 'Box step',
  rockStep: 'Rock step',
  kickBallChange: 'Kick-ball-change',
  tStep: 'T-step / heel-toe',
  runningMan: 'Running man',
  chasse: 'Chassé (side-together-side)',
};
// rave-moves kinematics that add per-step articulation on top.
export const RAVE_LOCOMOTOR = {
  stepTouch: 'twoStep', grapevine: 'twoStep', boxStep: 'fwdBack', rockStep: 'fwdBack',
  kickBallChange: 'twoStep', tStep: 'tStep', runningMan: 'runningMan', chasse: 'twoStep',
};

// Geometry scales with the dancer's narrow half-width n (just over 0.88 hip
// widths / 2), so steps read the same on every build.
export const FOOT_HOME_RADIUS = 0.75;    // × n: how far the support centre may wander from home
export const FOOT_DEPTH = 0.55;          // × n: forward / back step depth
export const TRAVEL_MIN = 0.35;          // × n: sideways travel per step at the step gate
export const TRAVEL_MAX = 0.80;          // × n: ... at full activation
export const LIFT_START = 0.12;          // fraction of the event window spent in double support
export const TAP_ROCK = 0.42;            // toe tap: heel up, no weight
export const CALM_ACT = 0.38;            // below: breakdown / calm menu
export const HIGH_ACT = 0.74;            // above: high-energy menu
// Busy traveling steps go half-time (one event per two step beats) at and
// above this step-clock BPM; simple in-place steps only above the second.
// Thresholds are in MUSIC BPM (step-clock BPM × stride).
export const HALF_TIME_BUSY_BPM = 110;
export const HALF_TIME_SIMPLE_BPM = 125;
export const HALF_TIME_ALL_BPM = HALF_TIME_SIMPLE_BPM;
const BUSY = new Set(['grapevine', 'boxStep', 'chasse', 'tStep', 'kickBallChange']);

// Energy menus (TJ Nov 12). 'build' is the low menu, kept small and getting
// tighter; kick-ball-change is never a phrase step, only a fill (FILLS).
export const MENUS = {
  calm: ['stepTouch', 'rockStep'],
  build: ['stepTouch', 'rockStep'],
  groove: ['grapevine', 'boxStep', 'tStep', 'chasse'],
  high: ['runningMan'],
};
export const FILLS = ['kickBallChange'];
export const LAG_MAX = 0.10;            // per-dancer lift lag, fraction of the event window
export const BREAKDOWN_SIZE = 0.6;       // breakdown: calm and small
export const BUILD_SIZE_FROM = 0.85;     // build: step size at the start of the build ...
export const BUILD_SIZE_TO = 0.35;       // ... and at its top (tighter)

import {clamp, hash01, smoothstep} from './geometry.js';

function num(v, d = 0) { const n = +v; return Number.isFinite(n) ? n : d; }

// Pattern events. foot: 'lead' | 'trail'. kind: 'step' (lands with weight),
// 'tap' (toe touch, no weight), 'shift' (weight moves onto a foot already
// down, no flight), 'kick' (foot swings forward in the air, no landing).
// x / z are functions of the geometry g = {dir, n, s, t, d} and the
// current foot positions p (home frame); dir = +1 when the lead foot is R.
const P = {
  stepTouch: [
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.n + g.t / 2), z: () => 0},
    {foot: 'trail', kind: 'tap', x: g => g.dir * (g.t / 2 - g.n), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => -g.dir * (g.n + g.t / 2), z: () => 0},
    {foot: 'lead', kind: 'tap', x: g => -g.dir * (g.t / 2 - g.n), z: () => 0},
  ],
  grapevine: [
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.s * 0.2 + g.n), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => g.dir * (g.s * 0.2 - g.n), z: g => -g.d},
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.s * 0.2 + g.n + g.t), z: () => 0},
    {foot: 'trail', kind: 'tap', x: g => g.dir * (g.s * 0.2 + g.t - g.n), z: () => 0},
  ],
  boxStep: [
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: g => g.d},
    {foot: 'trail', kind: 'step', x: g => -g.dir * (g.s + g.t * 0.5), z: g => g.d},
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: g => -g.d},
    {foot: 'trail', kind: 'step', x: g => -g.dir * g.s, z: g => -g.d * 0.25},
  ],
  rockStep: [
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: g => g.d},
    {foot: 'trail', kind: 'shift'},
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: g => -g.d * 0.8},
    {foot: 'trail', kind: 'shift'},
  ],
  kickBallChange: [
    {foot: 'lead', kind: 'kick', x: g => g.dir * g.s, z: g => g.d * 1.2},
    {foot: 'lead', kind: 'tap', x: (g, p) => p.trailX + g.dir * 2 * g.n, z: g => -g.d * 0.3},
    {foot: 'lead', kind: 'shift'},
    {foot: 'trail', kind: 'step', x: (g, p) => p.trailX, z: () => 0},
  ],
  tStep: [
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.s + g.t * 0.25), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => -g.dir * (g.s - g.t * 0.25), z: () => 0},
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.s + g.t * 0.5), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => -g.dir * (g.s - g.t * 0.5), z: () => 0},
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.s + g.t * 0.25), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => -g.dir * (g.s - g.t * 0.25), z: () => 0},
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: () => 0},
    {foot: 'trail', kind: 'step', x: g => -g.dir * g.s, z: () => 0},
  ],
  runningMan: [
    {foot: 'lead', kind: 'step', x: g => g.dir * g.s, z: g => g.d * 0.22, lift: 1.3},
    {foot: 'trail', kind: 'step', x: g => -g.dir * g.s, z: g => -g.d * 0.22, lift: 1.3},
  ],
  chasse: [
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.n + g.t * 0.5), z: () => 0},
    {foot: 'trail', kind: 'step', x: g => g.dir * (g.t * 0.5 - g.n), z: () => 0},
    {foot: 'lead', kind: 'step', x: g => g.dir * (g.n + g.t), z: () => 0},
    {foot: 'trail', kind: 'tap', x: g => g.dir * (g.t - g.n), z: () => 0},
  ],
};
export const PATTERNS = P;
export function cycleLength(stepId) { return (P[stepId] || P.stepTouch).length; }

/** Music beats per foot event: 2 = half-time at fast tempos. */
export function musicBeatsPerEvent(stepId, musicBpm) {
  const b = num(musicBpm, 0);
  if (b >= HALF_TIME_ALL_BPM) return 2;
  return BUSY.has(stepId) && b >= HALF_TIME_BUSY_BPM ? 2 : 1;
}
/** Event grid divisor in step beats (stride = music beats per step beat). */
export function eventDiv(stepId, musicBpm, stride = 1) {
  const st = Math.max(1, Math.round(num(stride, 1)) || 1);
  return Math.max(1, Math.round(musicBeatsPerEvent(stepId, musicBpm) / st));
}

/** Section-driven step size: breakdown small, build shrinking as it rises. */
export function sectionSize(section, build = 0) {
  if (section === 'breakdown') return BREAKDOWN_SIZE;
  if (section === 'build') return BUILD_SIZE_FROM + (BUILD_SIZE_TO - BUILD_SIZE_FROM) * smoothstep(num(build, 0));
  return 1;
}

/** Energy tier: 'calm' | 'build' | 'groove' | 'high'. section: 'breakdown' | 'build' | 'drop' | 'groove' | null. */
export function energyTier({activation = 0, drop = 0, kick = null, bass = null, section = null} = {}) {
  const a = clamp(num(activation), 0, 1);
  if (section === 'breakdown') return 'calm';
  if (section === 'build') return 'build';
  if (section === 'drop' && a > 0.3) return 'high';
  if (a < CALM_ACT) return 'calm';
  // No kick or bass under a mid level reads as a breakdown too.
  // No kick or bass reads as silence / a breakdown, even if activation has
  // not finished decaying (the start of a hush still has leftover act).
  if (kick != null && bass != null && num(kick) < 0.12 && num(bass) < 0.15) return 'calm';
  if (a >= HIGH_ACT || (num(drop) > 0.6 && a > 0.55)) return 'high';
  return 'groove';
}

/** Seeded per-dancer footwork personality. */
export function footworkPersonality(id) {
  const k = (id | 0) * 7.31 + 3.7;
  const pool = ['stepTouch', 'rockStep', 'grapevine', 'boxStep', 'tStep', 'chasse'];
  // Favourite set: three of the phrase steps, stable order by hash. Every
  // step stays possible (weight 0.35) so each energy menu has a choice.
  const ranked = pool.map((s, i) => ({s, h: hash01(k + i * 1.913)})).sort((a, b) => a.h - b.h);
  const weights = {runningMan: 1};
  ranked.forEach((r, i) => { weights[r.s] = i < 3 ? 1.6 - 0.2 * i : 0.35; });
  weights.stepTouch = Math.max(weights.stepTouch, 0.9); // TJ's own move: everyone knows it
  return {
    prefs: ranked.slice(0, 3).map(r => r.s),
    weights,
    phraseBars: hash01(k + 11.1) < 0.5 ? 4 : 8,
    offsetBars: hash01(k + 12.7) < 0.5 ? 0 : 4,
    size: 0.85 + 0.30 * hash01(k + 14.2),
    accent: hash01(k + 15.9), // < 0.55: likes kick-ball-change fills before downbeats (< 0.2 at 125+ BPM)
    lag: LAG_MAX * hash01(k + 17.3), // lifts a touch later inside the beat; lands on it
    seed: k,
  };
}

/** Pick the step for a phrase. Deterministic in (id, phrase index, tier). */
export function chooseStep({id = 0, phraseIndex = 0, tier = 'groove', prev = null, personality = null} = {}) {
  const pers = personality || footworkPersonality(id);
  // A side-sim allow-list replaces the energy menu so a checked step shows
  // even when the room's tier would not have offered it.
  let cand = allowSet ? [...allowSet] : (MENUS[tier] || MENUS.groove).slice();
  if (cand.length > 1 && prev && cand.includes(prev) && hash01(pers.seed + phraseIndex * 3.3 + 0.7) < 0.65) cand = cand.filter(s => s !== prev);
  const w = cand.map(s => (pers.weights[s] || 0.35) * ((tier === 'calm' || tier === 'build') && s === 'stepTouch' ? 1.4 : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = hash01(pers.seed * 1.7 + phraseIndex * 7.77 + (tier === 'high' ? 0.3 : tier === 'calm' ? 0.6 : 0)) * sum;
  for (let i = 0; i < cand.length; i++) { r -= w[i]; if (r <= 0) return cand[i]; }
  return cand[cand.length - 1];
}

/** Step-clock events per phrase for this dancer (4 or 8 bars, 4 music beats per bar). */
export function phraseEvents(pers, stride = 1, div = 1) {
  const beatsPerBar = 4 / Math.max(1, stride | 0 || 1);
  return Math.max(4, Math.round(pers.phraseBars * beatsPerBar / Math.max(1, div)));
}

// Flight profile: a step lifts after the double support, peaks, and comes
// down to meet the beat. Taps fly lower; kicks stay up and swing forward.
function flight(u, kind, liftScale = 1, lag = 0) {
  const start = LIFT_START + clamp(num(lag), 0, LAG_MAX);
  const f = clamp((u - start) / (1 - start), 0, 1);
  if (f <= 0) return {move: 0, lift: 0};
  // The foot clears the floor before it travels and lands after it arrives,
  // so a foot only moves while it is visibly in the air (no skating).
  const move = smoothstep((f - 0.22) / 0.56);
  const arc = Math.sin(Math.PI * Math.pow(f, 0.72));
  const h = kind === 'tap' ? 0.055 : kind === 'kick' ? 0.080 : 0.070;
  return {move, lift: h * liftScale * arc};
}

const state = new Map();
let override = null;
// Side-sim panel only. Null keeps the live show on Auto (music menus, fills, tier).
let allowSet = null;
let fillMode = null;
let tierLock = null;
const PHRASE_STEPS = ['stepTouch', 'grapevine', 'boxStep', 'rockStep', 'tStep', 'runningMan', 'chasse'];
const TIER_LOCKS = ['calm', 'build', 'groove', 'high'];

/** Debug / preview: force every dancer onto one step (null = music decides). */
export function setFootworkOverride(stepId) { override = stepId && P[stepId] ? stepId : null; return override; }
export function footworkOverride() { return override; }

/** Phrase steps the crowd may pick. Null = energy menus (Auto). */
export function setFootworkAllow(list) {
  if (!list) { allowSet = null; return null; }
  const next = new Set();
  for (const s of list) if (PHRASE_STEPS.includes(s)) next.add(s);
  allowSet = next.size ? next : null;
  return allowSet ? [...allowSet] : null;
}
export function footworkAllow() { return allowSet ? [...allowSet] : null; }

/** Kick-ball-change fills. null = energy decides, true = allowed, false = off. */
export function setFootworkFills(on) { fillMode = on == null ? null : !!on; return fillMode; }
export function footworkFills() { return fillMode; }

/** Energy tier lock. null = follow the music. */
export function setFootworkTier(tier) { tierLock = TIER_LOCKS.includes(tier) ? tier : null; return tierLock; }
export function footworkTierLock() { return tierLock; }

export function resetFootworkControls() {
  override = null; allowSet = null; fillMode = null; tierLock = null;
}
export function footworkDebug(id) { const st = state.get(id | 0); return st ? {pos: st.pos, weight: st.weight, step: st.step, up: st.up} : null; }
/** Unit-test hook: number of dancers with footwork state. */
export function footworkStateSize() { return state.size; }
export function resetFootwork(id) { if (id == null) state.clear(); else state.delete(id | 0); }

function sideKey(s) { return s < 0 ? 'L' : 'R'; }

/**
 * Per-frame footwork plan for one dancer.
 *   beat     step-clock beat index (silhouette motion.beat)
 *   frac     0..1 progress to the next step beat
 *   stepBpm  step-clock tempo (60000 / motion.period)
 *   stride   music beats per step beat (1, or 2 at very fast tempos)
 *   amount   0..1 how much the feet travel (stepGate × hush). At ~0 every
 *            step becomes a weight shift and every tap a toe touch in place
 *            (no lifts below the step gate).
 *   section  'breakdown' | 'build' | 'drop' | 'groove' | null, build 0..1
 *   geom     {n: narrow half-width (just over the min stance), s: neutral
 *            half-width, w: max half-width}
 *   drift    the renderer's support centre vs the sticker home (body frame,
 *            height units). The plan frame is re-centred on it (a pure
 *            translation: the relative layout, and so the floor, is
 *            untouched) and each step lands part of the way home.
 *   feet     the renderer's real foot layout (body frame). Only passed after
 *            footwork was off (silence, collect, re-anchor): the plan
 *            restarts from where the feet really are, never mid-flight.
 * Returns positions (home frame) of both feet, lifts, contacts, the weighted
 * side and a continuous weight in -1..1.
 */
export function footworkPlan({id = 0, beat = 0, frac = 0, stepBpm = 120, stride = 1, activation = 0, drop = 0, kick = null, bass = null,
  section = null, build = 0, amount = 1, initialSide = -1, geom = {}, drift = null, feet = null, restart = false} = {}) {
  const key = id | 0;
  const n = Math.max(0.02, num(geom.n, 0.045));
  const wMax = Math.max(n * 1.2, num(geom.w, 0.22));
  const s = clamp(num(geom.s, n * 1.15), n * 1.02, wMax * 0.9);
  const amt = clamp(num(amount, 1), 0, 1);
  const still = amt < 0.02; // below the step gate: weight shifts and toe touches only
  const strideN = Math.max(1, Math.round(num(stride, 1)) || 1);
  const musicBpm = num(stepBpm, 120) * strideN;
  const tier = tierLock || energyTier({activation, drop, kick, bass, section});
  let sizeK = sectionSize(section, build);
  if (tierLock === 'calm') sizeK = Math.min(sizeK, BREAKDOWN_SIZE);
  else if (tierLock === 'build') sizeK = Math.min(sizeK, BUILD_SIZE_TO + 0.1);
  let st = state.get(key);
  const b = Math.floor(num(beat));
  if (!st || !Number.isFinite(st.b) || b < st.b - 2 || b > st.b + 64) {
    const side0 = initialSide < 0 ? -1 : 1;
    st = {b, weight: side0, pos: {L: {x: -s, z: 0}, R: {x: s, z: 0}}, tapped: {L: false, R: false},
      step: null, prevStep: null, phrase: null, k: 0, lead: -side0, up: null, pers: footworkPersonality(key), accent: false, lastLand: null};
    state.set(key, st);
    if (state.size > 256) { const first = state.keys().next().value; if (first !== key) state.delete(first); }
  }
  const feetOK = !!(feet && feet.L && feet.R && [feet.L.x, feet.L.z, feet.R.x, feet.R.z].every((v) => Number.isFinite(+v)));
  if (restart && feetOK) {
    // Restart from the real layout. A crossed or collapsed read-out (turned
    // body, mid-collect) falls back to a neutral stance around its centre.
    const ax = (+feet.L.x + +feet.R.x) / 2, az = 0; // depth: relative only (see drift)
    const sep = +feet.R.x - +feet.L.x;
    // Depth: only the stagger carries over (the absolute depth read-out
    // carries travel / stage offsets).
    const zr0 = FOOT_DEPTH * n * 1.4 + 0.6 * n, dz0 = clamp(+feet.R.z - +feet.L.z, -zr0, zr0) / 2;
    if (sep >= 2 * n * 0.98 && sep <= 2 * wMax * 0.95) st.pos = {L: {x: ax - sep / 2, z: az - dz0}, R: {x: ax + sep / 2, z: az + dz0}};
    else st.pos = {L: {x: ax - s, z: az}, R: {x: ax + s, z: az}};
    st.up = null; st.weight = initialSide < 0 ? -1 : 1; st.tapped = {L: false, R: false}; st.wFrom = NaN; st.k = 0; st.accent = false;
  }
  const pers = st.pers;
  const geomFor = (dir) => ({dir, n, s, t: n * (TRAVEL_MIN + (TRAVEL_MAX - TRAVEL_MIN) * smoothstep(activation)) * pers.size * amt * sizeK, d: n * FOOT_DEPTH * pers.size * amt * sizeK});
  const pb = Math.max(4, Math.round(pers.phraseBars * 4 / strideN)); // phrase length, step beats
  const offB = Math.round(pers.offsetBars * 4 / strideN) % pb;

  const land = () => {
    const ev = st.up;
    if (!ev) return;
    const fk = ev.fk;
    if (ev.kind === 'step' || ev.kind === 'tap' || ev.kind === 'kick') st.pos[fk] = {x: ev.x, z: ev.z};
    if (ev.kind === 'step' || ev.kind === 'shift') { st.weight = ev.side; st.weightKind = ev.kind; }
    // Taps rest on the toe; a kick hovers until its ball tap; a touch is a
    // tap in place. None of them takes weight.
    st.tapped[fk] = ev.kind === 'tap' || ev.kind === 'kick' || ev.kind === 'touch';
    if (ev.kind === 'step' || ev.kind === 'shift') st.tapped[fk] = false;
    st.lastLand = ev.landBeat;
    // Weight is continuous across the beat: the next window eases from
    // where the body was at the landing to the new stance (no COM snap).
    st.wFrom = Number.isFinite(st.wOut) ? st.wOut : st.weight;
    st.up = null;
  };

  // Do not adopt the rendered layout every frame: toes point out and the
  // world pin holds one contact, so a copy-back of the real spacing ratchets
  // the stance wider (and a shift, with both feet down, would keep growing).
  // Restart (above) is the only place the plan takes the real feet.

  const plan = () => {
    // Re-centre the plan frame on the real support centre (translation only).
    // Sideways only: the renderer's depth carries the stage / travel offset,
    // so depth homes in the plan frame (the plan starts centred on home).
    if (drift && Number.isFinite(+drift.x)) {
      const px = (st.pos.L.x + st.pos.R.x) / 2;
      const dx = clamp(+drift.x, -4 * (s + n), 4 * (s + n)) - px;
      for (const k of ['L', 'R']) st.pos[k] = {x: st.pos[k].x + dx, z: st.pos[k].z};
    }
    const forced = override;
    // Next event lands on the next grid beat of the current step.
    const div0 = eventDiv(st.step || forced || 'stepTouch', musicBpm, strideN);
    let landBeat = (Math.floor(b / div0) + 1) * div0;
    const inPhrase = (((landBeat - offB) % pb) + pb) % pb;
    const phraseIdx = Math.floor((landBeat - offB) / pb);
    const lenNow = st.step ? cycleLength(st.accent ? 'kickBallChange' : st.step) : 1;
    const cycleDone = st.k % lenNow === 0;
    if (st.accent && cycleDone) st.accent = false;
    const menu = allowSet ? [...allowSet] : (MENUS[tier] || MENUS.groove);
    if (forced) {
      // Next event, not the end of the old cycle, so a forced step shows on the next beat.
      if (st.step !== forced) { st.prevStep = st.step; st.step = forced; st.k = 0; st.accent = false; }
    } else if (allowSet && st.step && !allowSet.has(st.step)) {
      const next = chooseStep({id: key, phraseIndex: phraseIdx, tier, prev: st.step, personality: pers});
      st.prevStep = st.step; st.step = next; st.k = 0; st.phrase = phraseIdx; st.accent = false;
    } else if (st.step == null) {
      st.step = chooseStep({id: key, phraseIndex: phraseIdx, tier, prev: null, personality: pers}); st.phrase = phraseIdx; st.k = 0;
    } else if (st.phrase !== phraseIdx && inPhrase < div0) {
      // Phrase downbeat: pick the next step (switches only here). The new
      // step starts with the free foot from where the feet are (blend).
      const next = chooseStep({id: key, phraseIndex: phraseIdx, tier, prev: st.step, personality: pers});
      if (next !== st.step || !cycleDone) st.k = 0;
      st.prevStep = st.step; st.step = next; st.phrase = phraseIdx; st.accent = false;
    } else if (!menu.includes(st.step) && (cycleDone || tier === 'calm' || tier === 'build' || tierLock) && (cycleDone || tierLock || inPhrase % Math.max(div0, 1) < div0)) {
      // The energy moved out from under this step: leave a high step (running
      // man) on the next event once the room is calm, otherwise on the
      // half-phrase line.
      st.prevStep = st.step; st.step = chooseStep({id: key, phraseIndex: phraseIdx * 2 + 1, tier, prev: st.step, personality: pers}); st.k = 0;
    }
    // Kick-ball-change fill into this dancer's phrase downbeat (high energy).
    // At 125+ BPM it is a rare accent: few dancers, every other phrase.
    const fast = musicBpm >= HALF_TIME_ALL_BPM;
    let fills = tier === 'high' && (fast ? pers.accent < 0.2 && (phraseIdx & 1) === 1 : pers.accent < 0.55);
    if (fillMode === false) fills = false;
    else if (fillMode === true) fills = true;
    if (!forced && !still && !st.accent && fills && st.step !== 'kickBallChange' && cycleDone) {
      const div1 = eventDiv('kickBallChange', musicBpm, strideN);
      const left = pb - inPhrase; // step beats until this dancer's downbeat
      if (left === cycleLength('kickBallChange') * div1) { st.accent = true; st.k = 0; }
    }
    const stepId = st.accent ? 'kickBallChange' : st.step;
    const div = eventDiv(stepId, musicBpm, strideN);
    if (div !== div0) landBeat = (Math.floor(b / div) + 1) * div;
    const len = cycleLength(stepId);
    const k = st.k % len;
    if (k === 0) st.lead = -st.weight; // every cycle starts with the free foot
    st.k++;
    const evDef = (P[stepId] || P.stepTouch)[k];
    const leadSide = st.lead;
    const side = evDef.foot === 'lead' ? leadSide : -leadSide;
    const fk = sideKey(side);
    const g = geomFor(leadSide);
    const p = {trailX: st.pos[sideKey(-leadSide)].x, leadX: st.pos[sideKey(leadSide)].x};
    let x = st.pos[fk].x, z = st.pos[fk].z;
    const oth = st.pos[sideKey(-side)];
    // Neutral = a comfortable stance next to the standing foot.
    const neutralX = oth.x + side * 2 * s;
    let kind = evDef.kind;
    if (still) {
      // Below the step gate: no foot leaves the floor. A step is a weight
      // shift onto that foot where it stands; a tap / kick a toe touch.
      kind = kind === 'step' || kind === 'shift' ? 'shift' : 'touch';
    } else if (kind === 'shift' && amt < 0.5 && (Math.abs(x - neutralX) > 0.4 * n || Math.abs(z - oth.z) > 0.15 * n)) {
      // Low energy: a weight shift on a too-wide / staggered stance becomes a
      // small closing step (on the beat), so the dancer settles back to neutral.
      kind = 'step';
    }
    if (kind !== 'shift' && kind !== 'touch') {
      // Blend from neutral by amount (low activation: smaller steps).
      const ex = evDef.kind === 'shift' ? neutralX : evDef.x(g, p), ez = evDef.kind === 'shift' ? oth.z : evDef.z(g, p);
      x = neutralX + (ex - neutralX) * amt;
      z = oth.z + (ez - oth.z) * amt;
      // Walk back home: each step lands part of the way back to the sticker
      // (the plan frame is centred on the real support centre above).
      // Depth targets are already home-relative (the plan frame is not
      // re-centred in depth), so only the sideways centre needs the pull.
      const cx = (st.pos.L.x + st.pos.R.x) / 2;
      x -= clamp(cx * 0.45, -0.6 * n, 0.6 * n) * Math.max(amt, 0.3);
      // Home leash: feet stay near the sticker.
      const R = FOOT_HOME_RADIUS * n + s + n;
      x = clamp(x, -R, R);
      // A moving foot stays on its own side of the standing foot, inside the
      // stance bounds (min just over hip width, max 2 shoulder widths).
      const lo = side > 0 ? oth.x + 2 * n * 1.01 : oth.x - 2 * wMax * 0.95;
      const hi = side > 0 ? oth.x + 2 * wMax * 0.95 : oth.x - 2 * n * 1.01;
      x = clamp(x, lo, hi);
      z = clamp(z, oth.z - FOOT_DEPTH * n * 1.4 - 0.6 * n, oth.z + FOOT_DEPTH * n * 1.4 + 0.6 * n);
      z = clamp(z, -FOOT_DEPTH * n * 1.4 - 0.6 * n, FOOT_DEPTH * n * 1.4 + 0.6 * n);
    }
    st.up = {landBeat, div, k, stepId, kind, side, fk, x, z, lift: evDef.lift || 1, from: {...st.pos[fk]}};
  };

  // Groove phrase realign (#114) adds an even count, then the strike adds one,
  // so the beat index jumps by an odd amount — the same planted side as taking
  // the single next step. Land that in-flight event once. Do not replay the
  // skipped steps, and do not move the foot that is already planted.
  if (st.up && b >= st.up.landBeat) land();
  if (st.up && st.up.landBeat - b > 2 * st.up.div) st.up = null; // beat went backwards: re-plan
  if (!st.up) plan();
  st.b = b;
  const div = st.up.div;
  const e = st.up.landBeat / div - 1;
  const u = clamp(((b - (st.up.landBeat - div)) + clamp(num(frac), 0, 0.9999)) / div, 0, 0.9999);
  if (still && (st.up.kind === 'step' || st.up.kind === 'tap' || st.up.kind === 'kick')) {
    // Energy fell below the step gate mid-flight: the foot sets down where
    // it is (nothing lifts below the gate) and the event finishes as a
    // weight shift (step) or a toe touch (tap / kick) on the same beat.
    const up = st.up, fl = flight(u, up.kind, up.lift, pers.lag);
    const here = {x: up.from.x + (up.x - up.from.x) * fl.move, z: up.from.z + (up.z - up.from.z) * fl.move};
    st.pos[up.fk] = here;
    st.up = {...up, kind: up.kind === 'step' ? 'shift' : 'touch', from: here, x: here.x, z: here.z};
  }

  const ev = st.up;
  const out = {
    step: ev ? ev.stepId : st.step, label: FOOTWORK_LABELS[ev ? ev.stepId : st.step] || '', tier, div, event: e, u,
    weightSide: st.weight, pos: {L: {...st.pos.L}, R: {...st.pos.R}}, lift: {L: 0, R: 0},
    contact: {L: 'flat', R: 'flat'}, rock: {L: 0, R: 0}, tap: {L: !!st.tapped.L, R: !!st.tapped.R},
    incoming: null, kind: ev ? ev.kind : null, movingSide: ev ? ev.side : 0, accent: !!st.accent, amount: amt,
    musicBpm, section: section || null, size: sizeK, personality: pers,
    // How the weight got onto the stance foot: 'shift' = it never left the
    // floor, so there is no heel strike to roll through.
    weightKind: st.weightKind || null,
  };
  // Resting tap: toe down, heel up, no weight.
  for (const fk of ['L', 'R']) {
    if (out.tap[fk] && (fk === 'L' ? -1 : 1) !== st.weight) { out.contact[fk] = 'toe'; out.rock[fk] = TAP_ROCK; }
  }
  let wU = st.weight;
  if (ev) {
    const fk = ev.fk;
    if (ev.kind === 'shift') {
      // Weight rolls over late in the window and lands on the beat.
      // Fully over by the beat, so the stance flip at the landing is seamless
      // (same contract as stepWeight: the side flips with the weight there).
      const r = smoothstep((u - 0.55) / 0.45);
      wU = st.weight + (ev.side - st.weight) * r;
      // A toe-touching foot puts its heel down first (flat = support), so
      // the body can roll over onto it before the beat instead of popping.
      if (out.tap[fk]) {
        const down = smoothstep((u - 0.2) / 0.3);
        out.rock[fk] = TAP_ROCK * (1 - down);
        if (down >= 1) { out.contact[fk] = 'flat'; out.tap[fk] = false; }
      }
    } else if (ev.kind === 'touch') {
      // Toe touch in place: the heel peels up into the beat, no lift.
      const r = smoothstep((u - 0.5) / 0.5);
      if (ev.side !== st.weight) { out.contact[fk] = 'toe'; out.rock[fk] = Math.max(out.rock[fk], TAP_ROCK * r); }
    } else {
      const fl = flight(u, ev.kind, ev.lift, pers.lag);
      out.pos[fk] = {x: ev.from.x + (ev.x - ev.from.x) * fl.move, z: ev.from.z + (ev.z - ev.from.z) * fl.move};
      if (ev.kind === 'kick') out.pos[fk].z += FOOT_DEPTH * n * 0.6 * amt * Math.sin(Math.PI * clamp((u - LIFT_START) / (1 - LIFT_START), 0, 1));
      // Lift scales with amount. A foot that really has to travel still
      // lifts, so it never slides.
      const dist = Math.hypot(ev.x - ev.from.x, ev.z - ev.from.z);
      // Any real travel clears the floor (>= ~3.5% height at the peak), or the
      // renderer would hold the barely lifted foot where it stood.
      const need = dist > 0.05 * n ? Math.max(0.5, smoothstep((dist - 0.25 * n) / (0.5 * n))) : 0;
      // Below the step gate nothing lifts, even mid-flight: the renderer
      // holds the grounded foot and the next event adopts where it stayed.
      out.lift[fk] = still ? 0 : fl.lift * Math.max(0.15 + 0.85 * amt, need);
      if (out.lift[fk] > 0) { out.contact[fk] = 'toe'; out.rock[fk] = ev.kind === 'tap' ? 0.3 : 0.22; out.tap[fk] = false; }
      if (ev.kind === 'tap') {
        // The tap lands on the toe and stays light.
        const touch = smoothstep((u - 0.82) / 0.18);
        out.rock[fk] = 0.3 + (TAP_ROCK - 0.3) * touch;
      }
      if (ev.kind === 'step') {
        out.incoming = ev.side;
        const r = smoothstep((u - 0.72) / 0.28);
        wU = st.weight + (ev.side - st.weight) * r;
      } else {
        // Tap / kick: weight stays over the standing foot (a slight lean only).
        wU = st.weight * (1 - 0.12 * smoothstep((u - 0.6) / 0.4));
      }
    }
  }
  // Ease from the landing weight over the double support (no snap).
  if (Number.isFinite(st.wFrom)) {
    const k = smoothstep(u / 0.30);
    wU = st.wFrom + (wU - st.wFrom) * k;
    if (k >= 1) st.wFrom = NaN;
  }
  out.weight = clamp(wU, -1, 1);
  st.wOut = out.weight;
  st.published = out;
  st.raveStep = out.amount > 0.02 && out.step ? out.step : null;
  return out;
}

/** Pose / rave read the plan without a new skeletonPose argument (#113 adds raveFade there). */
export function publishFootworkPose(id, plan) {
  const key = id | 0;
  const st = state.get(key);
  if (!st) return null;
  st.published = plan && plan.pos ? plan : null;
  st.raveStep = st.published && (st.published.amount || 0) > 0.02 && st.published.step ? st.published.step : null;
  return st.published;
}
export function publishedFootwork(id) {
  const st = state.get(id | 0);
  return st && st.published && st.published.pos ? st.published : null;
}
export function footworkRaveStep(id) {
  const st = state.get(id | 0);
  return st && st.raveStep ? st.raveStep : null;
}

const api = {
  FOOTWORK_STEPS, FOOTWORK_LABELS, RAVE_LOCOMOTOR, MENUS, PATTERNS, FOOT_HOME_RADIUS, FOOT_DEPTH, CALM_ACT, HIGH_ACT,
  HALF_TIME_BUSY_BPM, HALF_TIME_SIMPLE_BPM, HALF_TIME_ALL_BPM, FILLS, LAG_MAX,
  cycleLength, eventDiv, musicBeatsPerEvent, sectionSize, energyTier, footworkPersonality, chooseStep, phraseEvents, footworkPlan,
  publishFootworkPose, publishedFootwork, footworkRaveStep,
  setFootworkOverride, footworkOverride, setFootworkAllow, footworkAllow, setFootworkFills, footworkFills, setFootworkTier, footworkTierLock, resetFootworkControls,
  resetFootwork,
};
export default api;
if (typeof globalThis !== 'undefined') globalThis.NDFootwork = api;
