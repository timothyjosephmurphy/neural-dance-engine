// Procedural rave / club step repertoire for the Neural Dance side simulation.
// Not wired into the live renderer in this PR — side sim first, pending preview.
//
// Starter set (10 Nov 2026):
//   1. Bounce + head nod (idle)          2. Hip sway (hips from foot pulses)
//   3. Two-step / side-step              4. Jacking (spine / shoulders from the string)
//   5. Body wave (pads + melody)         6. T-step / heel-toe (hats on the "and")
//   7. Running man                       8. Kick + stomp accents, 90° turns as punctuation
// Layering: 1–3 always the base; 4–5 fade in with pads; 6–7 when kick and hats
// are both up; 8 only at high activation or on drops. #93 pad/melody arms stay
// on top of locomotion and are not owned by this module.
//
// Body rules this module must not violate:
//   rigid bone lengths, planted feet that do not slide mid-support, natural
//   human ranges, a calm soft rest, stomps proportional to activation, and
//   each dancer staying near its sticker / home (HOME_RADIUS).

import {FOOTWORK_LABELS, FOOTWORK_STEPS, RAVE_LOCOMOTOR, footworkPlan, resetFootwork, chooseStep, energyTier, setFootworkOverride, setFootworkAllow, setFootworkFills, setFootworkTier, resetFootworkControls} from './footwork-steps.js';

export const HOME_RADIUS = 0.10; // unit-pose xz, same order as a short step
export const MAX_TURN = 90 * Math.PI / 180;
export const TURN_SIZE = 90 * Math.PI / 180;
export const PREVIEW_DURATION = 18;

export const MOVE_IDS = [
  'bounceNod',
  'hipSway',
  'twoStep',
  'jacking',
  'bodyWave',
  'tStep',
  'runningMan',
  'kickStomp',
];

export const MOVE_LABELS = {
  bounceNod: 'Bounce + head nod',
  hipSway: 'Hip sway',
  twoStep: 'Two-step / side-step',
  jacking: 'Jacking',
  bodyWave: 'Body wave',
  tStep: 'T-step / heel-toe',
  runningMan: 'Running man',
  kickStomp: 'Kick + stomp',
  fwdBack: 'Forward / back',
  turn90: '90° turn',
  ...FOOTWORK_LABELS,
};

// Footwork step library (TJ Nov 11 11:12 PM) lives in footwork-steps.js:
// step-touch, grapevine, box step, rock step, kick-ball-change, T-step,
// running man and chassé, chosen per dancer to fit the beat. The live
// renderer asks it for both feet; the layers below add the articulation.
export {FOOTWORK_STEPS, FOOTWORK_LABELS, footworkPlan, chooseStep, energyTier} from './footwork-steps.js';
import {clamp, hash01, smoothstep} from './geometry.js';

export {clamp, smoothstep, hash01};

function num(v, d = 0) {
  const n = +v;
  return Number.isFinite(n) ? n : d;
}

/** Rest → high layer amounts in 0..1, given current music features. */
export function layerWeights(features = {}) {
  const hush = clamp(num(features.hush, 1), 0, 1);
  const a = clamp(num(features.activation, 0), 0, 1);
  const pads = clamp(Math.max(num(features.pads, 0), num(features.melody, 0)), 0, 1);
  const kick = clamp(num(features.kick, 0), 0, 1);
  const hats = clamp(num(features.hats, 0), 0, 1);
  const drop = clamp(num(features.drop, 0), 0, 1);
  const kickHats = clamp(Math.min(kick, 1) * 0.55 + Math.min(hats, 1) * 0.70, 0, 1)
    * smoothstep((a - 0.22) / 0.40);
  const high = hush * smoothstep((a - 0.55) / 0.32) * clamp(Math.max(drop, a), 0, 1);

  return {
    bounceNod: hush * (0.28 + 0.72 * a),
    hipSway: hush * (0.18 + 0.82 * a),
    twoStep: hush * smoothstep((a - 0.08) / 0.32),
    jacking: hush * pads * (0.18 + 0.82 * a),
    bodyWave: hush * pads * smoothstep((a - 0.18) / 0.40),
    tStep: hush * kickHats * smoothstep((a - 0.28) / 0.34),
    runningMan: hush * kickHats * smoothstep((a - 0.38) / 0.34),
    kickStomp: high,
  };
}

/** Human-readable label for the move that currently reads strongest. */
export function dominantLabel(weights = {}, extras = {}) {
  if (extras.turning) return MOVE_LABELS.turn90;
  if (extras.locomotor === 'fwdBack' && (weights.twoStep || 0) > 0.35 && (weights.runningMan || 0) < 0.45) {
    return MOVE_LABELS.fwdBack;
  }
  let best = 'bounceNod';
  let score = -1;
  for (const id of MOVE_IDS) {
    const w = num(weights[id], 0);
    if (w > score) { score = w; best = id; }
  }
  // At a near-tied mid energy, prefer a named locomotor over the idle bounce.
  if (best === 'bounceNod' && (weights.twoStep || 0) > 0.55) best = 'twoStep';
  return MOVE_LABELS[best] || best;
}

/**
 * Pick the current locomotor and a travel / turn decision for this beat.
 * Turns are 90° punctuation at the start of an 8-count, never at rest, and
 * never more often than once per phrase. Travel stays inside HOME_RADIUS.
 */
export function phraseState({
  tSec = 0,
  bpm = 120,
  seed = 1,
  activation = 0,
  layers = null,
  facing = 0,
  homeX = 0,
  homeZ = 0,
  beatIndex = null,
} = {}) {
  const layersIn = layers || layerWeights({ activation });
  const hz = Math.max(0.4, num(bpm, 120) / 60);
  const t = num(tSec, 0);
  const beats = t * hz;
  const beat = beatIndex != null ? (beatIndex | 0) : Math.floor(beats);
  const count = ((beat % 8) + 8) % 8; // 0..7, 0 is the "1" of the 8-count
  const phrase = Math.floor(beat / 8);
  const half = Math.floor(beats * 2);
  const a = clamp(num(activation, 0), 0, 1);
  const L = layersIn;

  let locomotor = 'idle';
  if (L.runningMan > 0.55 && L.runningMan >= L.tStep && L.runningMan >= L.twoStep) locomotor = 'runningMan';
  else if (L.tStep > 0.48 && L.tStep >= L.twoStep) locomotor = 'tStep';
  else if (L.twoStep > 0.35) {
    // Alternate side-to-side phrases with forward/back phrases.
    const alt = hash01(seed * 3.17 + phrase * 1.91);
    locomotor = alt < 0.38 ? 'fwdBack' : 'twoStep';
  } else if (L.kickStomp > 0.7 && L.twoStep > 0.2) locomotor = 'twoStep';

  // 90° turns: only as punctuation, feet will lead via travelState's pivot.
  let turnRad = 0;
  const canTurn = a >= 0.42 && (L.kickStomp > 0.35 || (L.twoStep > 0.55 && a > 0.5));
  if (canTurn && count === 0) {
    const h = hash01(seed * 9.1 + phrase * 4.7 + 2.3);
    // Skip some phrases so it stays punctuation, not a spin cycle.
    if (h > 0.42) {
      const face = num(facing, 0);
      const dirHash = hash01(seed * 5.5 + phrase * 8.2);
      let dir = dirHash < 0.5 ? -1 : 1;
      // If a same-direction 90° would clamp against MAX_TURN, go the other way.
      if (face + dir * TURN_SIZE > MAX_TURN + 1e-6 || face + dir * TURN_SIZE < -MAX_TURN - 1e-6) {
        dir = -dir;
      }
      const next = clamp(face + dir * TURN_SIZE, -MAX_TURN, MAX_TURN);
      turnRad = next - face;
    }
  }

  let stepF = 0;
  let stepS = 0;
  const travelAmp = 0.028 + 0.030 * smoothstep((a - 0.15) / 0.6);
  if (locomotor === 'fwdBack') {
    const sign = (Math.floor(beat / 2) % 2 === 0) ? 1 : -1;
    stepF = sign * travelAmp;
  } else if (locomotor === 'twoStep') {
    const sign = (Math.floor(beat / 2) % 2 === 0) ? 1 : -1;
    stepS = sign * travelAmp * 0.85;
  } else if (locomotor === 'tStep') {
    // Inch sideways each beat; the heel/toe rock is in kinematics.
    const sign = (phrase % 2 === 0 ? 1 : -1) * (hash01(seed + 0.4) < 0.5 ? -1 : 1);
    stepS = sign * travelAmp * 0.70;
  } else if (locomotor === 'runningMan') {
    // Land staggered on the beat, perch together on the "and".
    const onAnd = (half % 2) === 1;
    if (onAnd) stepF = 0;
    else {
      const fwd = (Math.floor(half / 2) % 2 === 0) ? 1 : -1;
      stepF = fwd * travelAmp * 0.90;
    }
  }

  // Soft leash: if already off home, bias the next plant inward and shrink it.
  const hx = num(homeX, 0);
  const hzOff = num(homeZ, 0);
  const dist = Math.hypot(hx, hzOff);
  if (dist > HOME_RADIUS * 0.55) {
    const pull = clamp((dist - HOME_RADIUS * 0.55) / (HOME_RADIUS * 0.55), 0, 1);
    const ux = hx / (dist || 1e-6);
    const uz = hzOff / (dist || 1e-6);
    stepS += -ux * travelAmp * 0.9 * pull;
    stepF += -uz * travelAmp * 0.9 * pull;
    const cap = travelAmp * (1 - 0.65 * pull);
    const span = Math.hypot(stepS, stepF);
    if (span > cap && span > 1e-9) {
      stepS *= cap / span;
      stepF *= cap / span;
    }
  }

  // At rest / idle: no travel, no turns.
  if (locomotor === 'idle' || a < 0.12) {
    stepF = 0;
    stepS = 0;
    turnRad = 0;
  }

  const turning = Math.abs(turnRad) > 0.2;
  const label = dominantLabel(L, { locomotor, turning });
  return {
    beat,
    count,
    phrase,
    half,
    locomotor,
    turnRad,
    stepF,
    stepS,
    turning,
    label,
    layers: L,
  };
}

/**
 * Per-frame kinematic additives. Bone lengths are not changed here;
 * callers apply these as angles, a small hip drop, or a free-leg lift.
 * Planted-foot world (x, z) is the travel layer's job — this only names
 * contact (heel/toe/flat), rock, and lift for each foot.
 */
export function kinematics({
  tSec = 0,
  bpm = 120,
  activation = 0,
  layers = null,
  locomotor = 'idle',
  weight = 0,
  planted = -1,
  beatPhase = null,
  pulseClimb = 0,
  hush = 1,
} = {}) {
  const L = layers || layerWeights({ activation, hush });
  const hz = Math.max(0.4, num(bpm, 120) / 60);
  const t = num(tSec, 0);
  const phase = beatPhase != null ? beatPhase : ((t * hz) % 1 + 1) % 1;
  // 0 at the kick, 0.5 at the "and".
  const kickWave = Math.cos(2 * Math.PI * phase); // +1 on the kick, -1 on the and
  const down = Math.max(0, kickWave);             // 1 on the kick, 0 on the and
  const a = clamp(num(activation, 0), 0, 1);
  const hushU = clamp(num(hush, 1), 0, 1);

  // 1. Bounce + nod: soft knees and a small yes-nod. Depth scales with activation.
  const bounce = L.bounceNod * (0.004 + 0.010 * a) * down;
  const nod = L.bounceNod * (0.035 + 0.070 * a) * kickWave; // radians, modest

  // 2. Hip sway over the standing / weighted leg, opposite a little in the ribs.
  const sway = L.hipSway * (0.006 + 0.010 * a);
  const hipSwayX = sway * clamp(num(weight, 0), -1, 1);
  const hipSwayYaw = -hipSwayX * 2.4; // contra, still well under hip-yaw limits
  const shCounter = -hipSwayYaw * 0.65;

  // 4. Jacking: pelvis-to-head piston on the kick, never stretching the torso.
  const jack = L.jacking * (0.06 + 0.10 * a) * kickWave;
  const jackPhi = {
    pelvis: jack * 0.18,
    lumbar: jack * 0.32,
    thoracic: jack * 0.38,
    neck: jack * 0.12,
    head: jack * 0.08,
  };

  // 5. Body wave over a bar (4 beats), or upward when a pulse is climbing.
  const barPhase = ((t * hz / 4) % 1 + 1) % 1;
  const upward = num(pulseClimb, 0) > 0.35;
  const crest = upward ? (1 - barPhase) : barPhase;
  const bump = (s) => {
    const d = Math.abs((((s - crest) % 1) + 1.5) % 1 - 0.5);
    return Math.max(0, 1 - d / 0.22);
  };
  const waveAmp = L.bodyWave * (0.07 + 0.09 * a);
  const wavePhi = {
    pelvis: waveAmp * bump(0.10) * (upward ? 1 : -0.6),
    lumbar: waveAmp * bump(0.30),
    thoracic: waveAmp * bump(0.52),
    neck: waveAmp * bump(0.74) * 0.7,
    head: waveAmp * bump(0.90) * 0.45,
  };

  // 6. T-step / heel-toe: support rocks heel then toe; free foot taps on the
  // beat and perches (light lift) on the and.
  const plantedSide = planted < 0 ? -1 : 1;
  const onAnd = phase >= 0.5;
  function footArt(side) {
    const isPlanted = side === plantedSide;
    let contact = 'flat';
    let rock = 0;
    let lift = 0;
    if (L.tStep > 0.2 && (locomotor === 'tStep' || L.tStep > 0.55)) {
      if (isPlanted) {
        contact = onAnd ? 'toe' : 'heel';
        rock = 0.55 * L.tStep;
        lift = 0;
      } else {
        if (onAnd) {
          contact = 'toe';
          rock = 0.35 * L.tStep;
          lift = 0.010 * L.tStep;
        } else {
          contact = 'toe';
          rock = 0.40 * L.tStep;
          lift = 0.002;
        }
      }
    }
    if (locomotor === 'runningMan' && L.runningMan > 0.25) {
      // Land flat on the beat; perch / knee lift on the and. Hops stay tiny.
      if (onAnd) {
        if (isPlanted) {
          contact = 'flat';
          rock = 0;
          lift = 0.006 * L.runningMan; // tiny hop
        } else {
          contact = 'toe';
          rock = 0.20;
          lift = (0.014 + 0.018 * a) * L.runningMan;
        }
      } else {
        contact = 'flat';
        rock = 0;
        lift = isPlanted ? 0 : 0.004 * L.runningMan;
      }
    }
    return { contact, rock, lift };
  }

  // 8. Kick accents on the free leg, scaled by activation. Soft at rest.
  const kickAmt = L.kickStomp * hushU;
  const kickLift = kickAmt * (0.008 + 0.070 * a) * Math.max(0, -kickWave);
  const footL = footArt(-1);
  const footR = footArt(1);
  if (kickLift > 0.002) {
    const free = plantedSide < 0 ? footR : footL;
    free.lift = Math.max(free.lift, kickLift);
    free.contact = 'toe';
    free.rock = Math.max(free.rock, 0.25);
  }

  const stomp = stompScale(a, hushU) * (0.55 + 0.45 * L.kickStomp);
  const hop = (locomotor === 'runningMan' && onAnd) ? (0.004 + 0.006 * a) * L.runningMan : 0;

  return {
    bounce,
    nod,
    hipSwayX,
    hipSwayYaw,
    shCounter,
    jackPhi,
    wavePhi,
    footL,
    footR,
    kickLift,
    stomp,
    hop,
    onAnd,
  };
}

/** Stomp / land-give scale: light tap at rest, full only when this dancer is on. */
export function stompScale(activation, hush = 1) {
  const a = clamp(num(activation, 0), 0, 1);
  const h = clamp(num(hush, 1), 0, 1);
  const rest = 0.20;
  return h * (rest + (1 - rest) * smoothstep(a));
}

/** Pull a planned mid-foot back inside the home radius (no mid-support slide). */
export function homeLeash(x, z, radius = HOME_RADIUS) {
  const r = Math.max(1e-6, num(radius, HOME_RADIUS));
  const d = Math.hypot(num(x, 0), num(z, 0));
  if (d <= r) return { x: num(x, 0), z: num(z, 0), pulled: false, dist: d };
  return { x: num(x, 0) * r / d, z: num(z, 0) * r / d, pulled: true, dist: d };
}

/**
 * 18 s rest → high preview program used for the landscape clip and for
 * stepping the side sim without a microphone.
 */
export function previewDrivers(tSec = 0) {
  const t = Math.max(0, num(tSec, 0));
  const u = t / PREVIEW_DURATION;
  const sections = [
    { t0: 0,  t1: 3.0,  activation: 0.06, kick: 0.45, hats: 0.05, pads: 0.00, melody: 0.00, drop: 0.00, label: 'Bounce + head nod' },
    { t0: 3.0, t1: 6.2,  activation: 0.28, kick: 0.80, hats: 0.15, pads: 0.05, melody: 0.00, drop: 0.00, label: 'Hip sway + two-step' },
    { t0: 6.2, t1: 9.4,  activation: 0.48, kick: 0.75, hats: 0.30, pads: 0.80, melody: 0.55, drop: 0.00, label: 'Jacking + body wave' },
    { t0: 9.4, t1: 13.2, activation: 0.72, kick: 0.90, hats: 0.85, pads: 0.45, melody: 0.35, drop: 0.10, label: 'T-step / running man' },
    { t0: 13.2, t1: 18.0, activation: 0.95, kick: 1.00, hats: 0.80, pads: 0.55, melody: 0.40, drop: 1.00, label: 'Kick + stomp · 90° turns' },
  ];
  let sec = sections[sections.length - 1];
  for (const s of sections) {
    if (t < s.t1 - 1e-9) { sec = s; break; }
  }
  const span = Math.max(1e-3, sec.t1 - sec.t0);
  const local = clamp((t - sec.t0) / span, 0, 1);
  // Ease a little at section edges so energy doesn't jump.
  const prev = sections[Math.max(0, sections.indexOf(sec) - 1)] || sec;
  const mixU = smoothstep(Math.min(1, local / 0.18));
  const mix = (a, b) => a + (b - a) * mixU;
  const activation = mix(prev.activation, sec.activation);
  const kick = mix(prev.kick, sec.kick);
  const hats = mix(prev.hats, sec.hats);
  const pads = mix(prev.pads, sec.pads);
  const melody = mix(prev.melody, sec.melody);
  const drop = mix(prev.drop, sec.drop);
  return {
    tSec: t,
    u,
    activation,
    hush: 1,
    kick,
    hats,
    bass: kick * 0.85,
    pads,
    melody,
    drop,
    bpm: 124,
    label: sec.label,
    section: sec,
  };
}

export function mergeDrivers(base = {}, override = null) {
  if (!override) return { ...base };
  const out = { ...base };
  for (const k of ['activation', 'hush', 'kick', 'hats', 'bass', 'pads', 'melody', 'drop', 'bpm', 'label']) {
    if (override[k] != null) out[k] = override[k];
  }
  return out;
}

const api = {
  HOME_RADIUS, MAX_TURN, TURN_SIZE, PREVIEW_DURATION,
  MOVE_IDS, MOVE_LABELS,
  clamp, smoothstep, hash01,
  layerWeights, dominantLabel, phraseState, kinematics,
  stompScale, homeLeash, previewDrivers, mergeDrivers,
  FOOTWORK_STEPS, FOOTWORK_LABELS, RAVE_LOCOMOTOR, footworkPlan, resetFootwork, chooseStep, energyTier,
  setFootworkOverride, setFootworkAllow, setFootworkFills, setFootworkTier, resetFootworkControls,
};

export default api;

if (typeof globalThis !== 'undefined') {
  globalThis.NDRaveMoves = api;
}
