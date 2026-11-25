// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Articulated shadow dancers ported from the side simulation (TJ t2563u,
// 6:21 PM; t2620u arm lift / 3D shade / softer stomp; t2621u heel-pulse
// sync and natural weight transfer): hip–knee–ankle and shoulder–elbow–wrist
// with two-bone IK, human arm proportions (upper 0.19, forearm 0.16, hand
// 0.11 of height), elbows bent and held slightly out, varied per dancer
// and band. Weight shifts foot to foot on the beat-locked ease-in, with a
// short double-support after each plant. Arms rise with string activation.
// A pulse that passes the heart chakra branches into both shoulders and
// runs down the arms, giving the elbows and hands a small decaying lift.
// Arm-lift direction varies per dancer and phrase (TJ 7:51 PM): left, right,
// both-to-one-side, both-up, or split/opposition — not always to the right.
// Remaining side-sim motion (TJ 8:02 / 8:12 PM): spine flex, arm flex, leg
// waves, jiggle, heel-toe, hip figure-eight, and per-dancer stomp intensity.

import {
  SPINE_FLEX, SPINE_LAG, ARM_FLEX, LEG_COMPLEX, JIGGLE, HIP_EIGHT, SHOULDER_EIGHT, SAME_FOOT_THRESH,
  STOMP_CALM, STOMP_PEAK, STOMP_REST_FRAC, stompIntensity, neckStringFollow, spineFlexState, armWaveFlex, legWaveState,
  jiggleState, hipFigureEight, shoulderFigureEight, footworkState, posedFoot, footLayout, classifyBeats,
  sameFootThreshSec, ornamentsFor, stringPeriodSec, FOOT_HEEL, FOOT_ANK_H,
  HIP_TWIST, SHOULDER_TWIST, MAX_BODY_TURN_DEG, TURN_FREQ, STANCE_SH_MIN, STANCE_SH_CALM,
  STANCE_HIP_REST, EIGHT_DEPTH, EIGHT_VERT, VOLUME_LOD_PX, yawExtent, rotateFacing,
  bodyTravelState, smoothPoseJoints, commitDynJoints, stepSpring, restBlend, resetBodyDynamics, resetTravel, resetSpineFlex,
  travelFacingOf, travelWorldZOf, HIP_YAW_LIM
} from './skeleton-motion.js';
import {liveRaveLayer, raveSagittal, liveHeadLook, RAVE_LIVE_DEFAULT} from './live-rave.js';
import {publishedFootwork} from './footwork-steps.js';
import {paintInnerBones} from './inner-bones.js';
import {traceBody} from './body-shell.js';
import {confineStringToHead} from './vibrating-string.js';
export {liveRaveLayer, raveSagittal, liveHeadLook, RAVE_LIVE_DEFAULT, paintInnerBones, confineStringToHead};
import {pulseVisibility} from './pulse-visibility.js';
import {clamp, deg, smoothstep, lerp as mix} from './geometry.js';
export {
  SPINE_FLEX, SPINE_LAG, ARM_FLEX, LEG_COMPLEX, JIGGLE, HIP_EIGHT, SHOULDER_EIGHT, SAME_FOOT_THRESH,
  STOMP_CALM, STOMP_PEAK, STOMP_REST_FRAC, stompIntensity, neckStringFollow, spineFlexState, armWaveFlex, legWaveState,
  jiggleState, hipFigureEight, shoulderFigureEight, footworkState, posedFoot, footLayout, classifyBeats,
  sameFootThreshSec, ornamentsFor, HIP_TWIST, SHOULDER_TWIST, MAX_BODY_TURN_DEG, TURN_FREQ,
  STANCE_SH_MIN, STANCE_SH_CALM, STANCE_HIP_REST, EIGHT_DEPTH, EIGHT_VERT, VOLUME_LOD_PX,
  yawExtent, rotateFacing, bodyTravelState, smoothPoseJoints, stepSpring, restBlend,
  resetSpineFlex, resetBodyDynamics, resetTravel
};

import {drawShadowFigure, drawVolumeBodyLite, TORSO_CHEST_Z, TORSO_HIP_Z, TORSO_SEAT_Z, TORSO_CHEST_DEPTH, TORSO_CHEST_W, TORSO_WAIST_W} from './body-shell.js';
import {ikJointForward, footForward} from './leg-ik.js';
import {applyArmForward, ARM_FORWARD_DEG, limitArmsBehindHead} from './arm-forward.js';
import {applyClap, swayRate, easeWindowS} from './energy-motion.js';
export {applyArmForward, ARM_FORWARD_DEG, limitArmsBehindHead};
// Debug-only off switch shared with the side sim's arm-back-limit check
// (window.__ndNoArmBackLimit). Never set in normal use, so the limit always runs.
function armBackLimitOff() {
  return typeof globalThis !== 'undefined' && globalThis.__ndNoArmBackLimit === true;
}
import {padArmState, applyPadArmAngles, applyTravelingWave, capHandsLead, capHandsLeadScreen, capRestHang, capRestUpright, padDriveActivation} from './pad-arms.js';

// Standard adult proportions (TJ Nov 10 3:02 PM): ~7.5 heads tall, scaled
// inside a fixed figure height (crown at 0, floor at 0.99) so stage/sticker
// mapping and inset size stay the same. Head height H = 0.99 / 7.5.
export const CANON_HEADS = 7.5;
export const CANON_SPAN = 0.99;
export const HEAD_H = CANON_SPAN / CANON_HEADS;
export const Y_CHIN = 1.00 * HEAD_H;
export const Y_NECK = 1.20 * HEAD_H;
export const Y_NECK_BASE = 1.36 * HEAD_H; // nape / visual shoulder line (chin→here ~0.36 heads)
export const Y_SHOULDER = 1.50 * HEAD_H;
export const Y_HEART = 2.00 * HEAD_H;  // nipples
export const Y_SOLAR = 3.00 * HEAD_H;  // navel
export const Y_HIP = 3.85 * HEAD_H;    // femoral heads / pelvic crossbar
export const Y_GROIN = 4.00 * HEAD_H;  // crotch (~half the 7.5–8 head figure)
export const Y_KNEE = 5.80 * HEAD_H;
export const Y_ANKLE = 7.25 * HEAD_H;
export const Y_FLOOR = CANON_SPAN;
export const SOLAR_S = (Y_GROIN - Y_SOLAR) / Y_GROIN;
export const UPPER_ARM = 1.50 * HEAD_H;          // elbow hangs near the navel
export const FOREARM = 1.15 * HEAD_H;
export const HAND_LEN = 0.85 * HEAD_H;           // forearm + hand = 2 heads; fingertips mid-thigh
// Thigh a little longer than shin (anatomical); a hair of slack so feet
// slightly outside the hip joints still plant with a soft knee bend.
export const LEG_SLACK = 0.03 * HEAD_H;
export const THIGH = (Y_KNEE - Y_HIP) + LEG_SLACK * 0.55;
export const SHIN = (Y_ANKLE - Y_KNEE) + LEG_SLACK * 0.45;
// Rigid rest bone lengths (TJ Nov 10 6:27 PM). Activation, squat, flex,
// bounce and twist may move the pelvis; they must not stretch a bone.
export const BONE_PELVIS_LUMBAR = Y_HIP - Y_SOLAR;
export const BONE_LUMBAR_THORACIC = Y_SOLAR - Y_HEART;
export const BONE_THORACIC_NECK = Y_HEART - Y_NECK;
export const BONE_NECK_CROWN = Y_NECK;
export const BONE_NECK_HEAD = Y_NECK - 0.5 * HEAD_H;
export const BONE_NECK_SHOULDER = Y_SHOULDER - Y_NECK;
export const BONE_LEN = {
  pelvisLumbar: BONE_PELVIS_LUMBAR,
  lumbarThoracic: BONE_LUMBAR_THORACIC,
  thoracicNeck: BONE_THORACIC_NECK,
  neckCrown: BONE_NECK_CROWN,
  neckHead: BONE_NECK_HEAD,
  neckShoulder: BONE_NECK_SHOULDER,
  upperArm: UPPER_ARM,
  forearm: FOREARM,
  hand: HAND_LEN,
  thigh: THIGH,
  shin: SHIN
};
export function dist3(a, b) {
  if (!a || !b) return 0;
  return Math.hypot((+a.x || 0) - (+b.x || 0), (+a.y || 0) - (+b.y || 0), (+a.z || 0) - (+b.z || 0));
}
export function lockLen(from, to, len) {
  if (!from || !to || !(len > 0)) return to;
  const dx = (+to.x || 0) - (+from.x || 0);
  const dy = (+to.y || 0) - (+from.y || 0);
  const dz = (+to.z || 0) - (+from.z || 0);
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-9) { to.y = (+from.y || 0) + len; return to; }
  const k = len / d;
  to.x = (+from.x || 0) + dx * k;
  to.y = (+from.y || 0) + dy * k;
  to.z = (+from.z || 0) + dz * k;
  return to;
}
// Keep the shoulder-girdle midpoint at a rigid distance from the neck
// without flattening a shrug or lateral shift back onto the rest vertical.
// If the mid has moved closer to the neck (shrug), the leftover length goes
// into +z (slightly forward) so the shoulders can actually rise.
export function placeGirdleOnNeck(neck, shL, shR, len) {
  if (!neck || !shL || !shR || !(len > 0)) return;
  const mid = {
    x: (shL.x + shR.x) * 0.5,
    y: (shL.y + shR.y) * 0.5,
    z: ((+shL.z || 0) + (+shR.z || 0)) * 0.5
  };
  let dx = mid.x - neck.x, dy = mid.y - neck.y, dz = mid.z - (+neck.z || 0);
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-9) { dy = len; d = len; }
  if (d < len - 1e-9) {
    dz += Math.sqrt(Math.max(0, len * len - d * d));
    d = Math.hypot(dx, dy, dz);
  }
  const k = len / (d || 1e-9);
  const nx = neck.x + dx * k, ny = neck.y + dy * k, nz = (+neck.z || 0) + dz * k;
  const ox = nx - mid.x, oy = ny - mid.y, oz = nz - mid.z;
  shL.x += ox; shL.y += oy; shL.z = (+shL.z || 0) + oz;
  shR.x += ox; shR.y += oy; shR.z = (+shR.z || 0) + oz;
}
export function enforceLegReach(unit, scale = 1) {
  if (!unit || !unit.hipL || !unit.ankleL) return unit;
  const sc = Number.isFinite(+scale) && +scale > 0 ? +scale : 1;
  const lim = legSpanLimits(THIGH, SHIN);
  const maxSpan = lim.max * sc;
  const minSpan = lim.min * sc + 1e-4;
  const keys = upperKeys(unit);
  const move = (dx, dy, dz = 0) => {
    for (const k of keys) {
      const p = unit[k];
      if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
      p.x += dx; p.y += dy;
      if (dz) p.z = (p.z || 0) + dz;
    }
  };
  const planted = s => !((+unit['lift' + s] || 0) > 0.001) && unit['hip' + s] && unit['ankle' + s];
  const horizOf = s => {
    const hp = unit['hip' + s], an = unit['ankle' + s];
    return Math.hypot(an.x - hp.x, (+an.z || 0) - (+hp.z || 0));
  };
  // Pull a lifted foot onto the legal hip–ankle span. Planted contacts stay put.
  const pullLifted = () => {
    for (const s of ['L', 'R']) {
      if (planted(s)) continue;
      const hp = unit['hip' + s], an = unit['ankle' + s];
      if (!hp || !an) continue;
      const ex = an.x - hp.x, ey = an.y - hp.y, ez = (+an.z || 0) - (+hp.z || 0);
      const d = Math.hypot(ex, ey, ez);
      if (!(d > 1e-8) || (d <= maxSpan && d >= minSpan)) continue;
      const want = d > maxSpan ? maxSpan : minSpan;
      const k = want / d;
      const ddx = hp.x + ex * k - an.x, ddy = hp.y + ey * k - an.y, ddz = (+hp.z || 0) + ez * k - (+an.z || 0);
      for (const kk of ['ankle' + s, 'foot' + s, 'heel' + s]) {
        const p = unit[kk];
        if (p) { p.x += ddx; p.y += ddy; p.z = (p.z || 0) + ddz; }
      }
    }
  };
  // Legal hip-y interval for the currently planted legs (y increases downward).
  const yWindow = () => {
    let lo = -Infinity, hi = Infinity, tight = null, tightLo = -Infinity;
    for (const s of ['L', 'R']) {
      if (!planted(s)) continue;
      const hp = unit['hip' + s], an = unit['ankle' + s];
      const hx = Math.hypot(an.x - hp.x, (+an.z || 0) - (+hp.z || 0));
      const needMax = Math.sqrt(Math.max(0, maxSpan * maxSpan - hx * hx));
      const needMin = Math.sqrt(Math.max(0, minSpan * minSpan - hx * hx));
      // When horiz already exceeds maxSpan, no hip height can unstretch the
      // leg; leave the window empty so the xz pull runs first.
      if (hx > maxSpan * 0.999) {
        if (Infinity > lo) { lo = Infinity; tight = s; }
        hi = -Infinity;
        continue;
      }
      const legLo = an.y - needMax; // cannot stand higher than this
      const legHi = an.y - needMin; // cannot drop lower than this
      if (legLo > lo) { lo = legLo; tight = s; tightLo = legLo; }
      if (legHi < hi) hi = legHi;
    }
    return {lo, hi, ok: lo <= hi + 1e-9, tight};
  };
  pullLifted();
  for (let iter = 0; iter < 16; iter++) {
    // Any planted leg past horizontal reach: slide the pelvis toward that foot.
    for (const s of ['L', 'R']) {
      if (!planted(s)) continue;
      const hp = unit['hip' + s], an = unit['ankle' + s];
      const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0);
      const hx = Math.hypot(ex, ez);
      if (hx > maxSpan) {
        const k = (hx - maxSpan * 0.995) / hx;
        move(ex * k, 0, ez * k);
      }
    }
    let win = yWindow();
    if (!win.ok && win.tight) {
      // Both feet planted but no common hip height: move the pelvis toward
      // the over-stretched leg so its horizontal reach shrinks until the
      // y-windows overlap. Never slide a planted contact.
      const s = win.tight;
      const hp = unit['hip' + s], an = unit['ankle' + s];
      const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0);
      const hx = Math.hypot(ex, ez) || 1e-9;
      const gap = Math.max(1e-4, win.lo - win.hi);
      const step = Math.min(hx * 0.35, gap + 0.004);
      move(ex / hx * step, 0, ez / hx * step);
      win = yWindow();
    }
    if (win.ok && Number.isFinite(win.lo)) {
      const hipY = (unit.hipL.y + unit.hipR.y) * 0.5;
      if (hipY < win.lo) move(0, win.lo - hipY);
      else if (Number.isFinite(win.hi) && hipY > win.hi) move(0, win.hi - hipY);
    }
    // A loaded hip can sit higher than the other, so a common torso dy still
    // leaves one planted leg stretched. Drop only that hip onto its floor.
    for (const s of ['L', 'R']) {
      if (!planted(s)) continue;
      const hp = unit['hip' + s], an = unit['ankle' + s];
      const hx = Math.hypot(an.x - hp.x, (+an.z || 0) - (+hp.z || 0));
      if (hx > maxSpan * 0.999) continue;
      const needMax = Math.sqrt(Math.max(0, maxSpan * maxSpan - hx * hx));
      const needMin = Math.sqrt(Math.max(0, minSpan * minSpan - hx * hx));
      const lo = an.y - needMax, hi = an.y - needMin;
      if (hp.y < lo) hp.y = lo;
      else if (hp.y > hi) hp.y = hi;
    }
    if (unit.pelvis && unit.hipL && unit.hipR) {
      const ny = (unit.hipL.y + unit.hipR.y) * 0.5;
      const dPy = ny - unit.pelvis.y;
      unit.pelvis.y = ny;
      if (dPy) {
        for (const k of keys) {
          if (k === "hipL" || k === "hipR" || k === "pelvis") continue;
          const pnt = unit[k];
          if (pnt && Number.isFinite(+pnt.y)) pnt.y += dPy;
        }
      }
    }
    let ok = true;
    for (const s of ['L', 'R']) {
      if (!planted(s)) continue;
      const d = Math.hypot(unit['ankle' + s].x - unit['hip' + s].x, unit['ankle' + s].y - unit['hip' + s].y, (+unit['ankle' + s].z || 0) - (+unit['hip' + s].z || 0));
      if (d > maxSpan + 1e-7 || d < minSpan - 1e-7) ok = false;
    }
    if (ok) break;
  }
  pullLifted();
  // Horizontal reach pulls can slide the COM off the planted feet; put it
  // back, then only use vertical reach so we do not undo that clamp.
  const sup = typeof supportRange === "function" ? supportRange(unit) : null;
  if (sup) {
    const com = poseCom(unit);
    if (com < sup.min) move(sup.min - com, 0);
    else if (com > sup.max) move(sup.max - com, 0);
    for (const s of ["L", "R"]) {
      if (!planted(s)) continue;
      const hp = unit["hip" + s], an = unit["ankle" + s];
      const hx = Math.hypot(an.x - hp.x, (+an.z || 0) - (+hp.z || 0));
      if (hx > maxSpan * 0.999) continue;
      const needMax = Math.sqrt(Math.max(0, maxSpan * maxSpan - hx * hx));
      const needMin = Math.sqrt(Math.max(0, minSpan * minSpan - hx * hx));
      const lo = an.y - needMax, hi = an.y - needMin;
      if (hp.y < lo) hp.y = lo;
      else if (hp.y > hi) hp.y = hi;
    }
  }
  return unit;
}

export function lockPoseBones(pose, scale = 1) {
  if (!pose) return pose;
  const L = k => BONE_LEN[k] * (Number.isFinite(+scale) && +scale > 0 ? +scale : 1);
  const pelvis = pose.pelvis || (pose.hipL && pose.hipR ? {
    x: (pose.hipL.x + pose.hipR.x) * 0.5,
    y: (pose.hipL.y + pose.hipR.y) * 0.5,
    z: ((+pose.hipL.z || 0) + (+pose.hipR.z || 0)) * 0.5
  } : pose.groin);
  if (pelvis && pose.lumbar) lockLen(pelvis, pose.lumbar, L('pelvisLumbar'));
  if (pose.lumbar && pose.thoracic) lockLen(pose.lumbar, pose.thoracic, L('lumbarThoracic'));
  if (pose.thoracic && pose.neck) lockLen(pose.thoracic, pose.neck, L('thoracicNeck'));
  if (pose.neck && pose.crown) lockLen(pose.neck, pose.crown, L('neckCrown'));
  if (pose.neck && pose.head) lockLen(pose.neck, pose.head, L('neckHead'));
  if (pose.neck && pose.shL && pose.shR) {
    placeGirdleOnNeck(pose.neck, pose.shL, pose.shR, L('neckShoulder'));
  }
  if (pose.shL && pose.elL) lockLen(pose.shL, pose.elL, L('upperArm'));
  if (pose.shR && pose.elR) lockLen(pose.shR, pose.elR, L('upperArm'));
  if (pose.elL && pose.wristL) lockLen(pose.elL, pose.wristL, L('forearm'));
  if (pose.elR && pose.wristR) lockLen(pose.elR, pose.wristR, L('forearm'));
  if (pose.wristL && pose.handL) lockLen(pose.wristL, pose.handL, L('hand'));
  if (pose.wristR && pose.handR) lockLen(pose.wristR, pose.handR, L('hand'));
  // Legs: never project the ankle (planted feet stay locked). Re-solve the
  // knee between the current hip and ankle at the canon bone lengths. The
  // caller must have already clamped hip–ankle into the legal span.
  const thigh = L('thigh'), shin = L('shin');
  if (pose.hipL && pose.ankleL) pose.kneeL = kneeIK(pose.hipL, pose.ankleL, thigh, shin, -1, kneeForwardOf(pose, 'L'));
  if (pose.hipR && pose.ankleR) pose.kneeR = kneeIK(pose.hipR, pose.ankleR, thigh, shin, 1, kneeForwardOf(pose, 'R'));
  return pose;
}
export const HEART_S = (Y_GROIN - Y_HEART) / Y_GROIN; // heart chakra on the root→crown string
// Hip joints on the SIDES of the pelvis (femoral head / greater trochanter),
// ~0.75 heads from the midline, total spacing ~1.5 heads (TJ Nov 10 5:16 PM).
// Visual pelvis is a little wider (~1.7–2.0 heads) than the bony span.
export const HIP_JOINT_HEADS = 0.75;
// Kept as a zeroed alias so older tests/imports do not throw.
export const THIGH_INNER_GAP = 0;
export const ARM_PULSE_SPAN = 0.34; // strike-progress units heart → fingertips
export const ARM_LIFT = 0.022; // height units at the hand, decays
export const STOMP_SOFT = 0.65; // ~35% softer foot-strike jolt (TJ 6:53 PM)
export const PULSE_SOFT = 0.65; // ~35% softer heel-strike pulse flash
export const STEP_EASE_K = 5.2; // side-sim ease-in; sharp stop on the beat
export const DOUBLE_SUPPORT = 0.10; // both feet down after plant, then swing lifts
export const SWING_LIFT = 0.115; // peak free-foot lift in height units
// Occasional high-activation "standing tall" (TJ 7:25 / 8:40 PM): legs
// straight, spine extended, arms high, stance at the 0.85-shoulder-width
// minimum (never feet together except brief heel-to-toe taps). Held 1–2 beats.
export const TALL_STANCE_W = 0.034; // unused; kept so old imports do not throw
export const TALL_HIP_Y = Y_HIP - 0.004; // slight rise; legs, not a longer bone, support it
export const REST_HIP_Y = Y_HIP;
export const TALL_CROWN_Y = 0.000;
export const TALL_NECK_Y = 1.08 * HEAD_H;
export const TALL_ACT_ENTER = 0.90; // string activation must be high to enter
export const TALL_ACT_HOLD = 0.70; // drop out if energy falls out of the high band
// Stance width (TJ 8:40 / 9:10 PM): while dancing, the narrowest stance is
// 0.85–1.0 × shoulder width. At rest (silence / calm) the feet stand under
// the hips (~1.0 hip width), which is narrower than that dance floor, never
// feet together. Wide stays 1.65 hip half-widths.
export const STANCE_HIP_CALM = 0.15; // deprecated; dance-calm is STANCE_SH_CALM × shW
export const STANCE_HIP_WIDE = 1.65;
export const STANCE_W_CALM = 0.15 * 0.09;
export const STANCE_W_WIDE = 1.65 * 0.09;
export const TALL_CHANCE = 0.40;
export const TALL_BLEND_S = 0.16; // seconds to glide in or out
export const SKELETON_SHADOW = 'rgba(6, 8, 14, 0.90)';
export const SKELETON_RIM = 'rgba(170, 195, 245, 0.13)';
export const KEY_LIGHT = {x: -0.62 / Math.hypot(-0.62, -0.48), y: -0.48 / Math.hypot(-0.62, -0.48)};
export const SHADE_HI = 'rgba(200, 218, 245, 0.13)';
export const SHADE_CORE = 'rgba(0, 0, 0, 0.28)';
// Soft silhouette-shaped halo (TJ 7:31 PM): dilated outline, no round dots.
// Width is a fraction of figure height at the default bloom aura (22).
export const HALO_WIDTH_FRAC = 0.042;
export const HALO_ALPHA = 0.11;
// Activation that reaches the Aura-width slider max. 0 → no halo.
export const HALO_ACT_FULL = 1;
export function haloAuraScale(activation) {
  const a = Math.max(0, +activation || 0);
  if (!(a > 0)) return 0;
  return a >= HALO_ACT_FULL ? 1 : a / HALO_ACT_FULL;
}


// Upright torso (TJ 12:02 PM: "hunched over in a resting state. It should be
// standing straight and tall"). Applied to the final posed body: the torso
// (hip centre -> shoulder centre) leans at most maxLeanDeg from vertical, in
// the picture plane and in depth, and the head stacks over the neck. Everything
// above the hips is sheared back (arms ride with the shoulders); legs, feet and
// the pelvis are untouched, so the foot lock and chakra root are unaffected.
export const REST_LEAN_DEG = 1.5;
export function torsoLeanLimit(activation = 0, squat = 0, hush = 1, axis = 'any') {
  // Silence straightens up quickly (hush^3): no lingering dance lean at rest.
  const hu = Math.max(0, Math.min(1, +hush || 0)) ** 3;
  const a = Math.max(0, Math.min(1, ((+activation || 0) - 0.3) / 0.5));
  const ua = a * a * (3 - 2 * a);
  // Squat / bow adds forward flex only once the dancer is actually dancing.
  const d = Math.max(0, Math.min(1, ((+activation || 0) - 0.25) / 0.3));
  const ud = d * d * (3 - 2 * d);
  const sq = Math.max(0, Math.min(1, +squat || 0));
  const lat = REST_LEAN_DEG + 28 * ua * hu;                 // ~30° side bend
  const flex = REST_LEAN_DEG + (38 * ua + 15 * sq * ud) * hu; // ~40°, more in squats
  if (axis === 'x' || axis === 'lateral') return lat;
  if (axis === 'z' || axis === 'flex') return flex;
  return Math.max(lat, flex);
}
const HIP_LEVEL = /^(hip[LR]|groin|pelvis|sacral)$/;
const ARM_KEY = /^(sh|el|wrist|hand)[LR]$/;
const HEAD_KEY = /^(head|crown|thirdEye)$/;
export function uprightTorso(posed, maxLeanDeg = REST_LEAN_DEG) {
  if (!posed || !posed.hipL || !posed.hipR || !posed.shL || !posed.shR) return posed;
  const hip = {x: (posed.hipL.x + posed.hipR.x) / 2, y: (posed.hipL.y + posed.hipR.y) / 2, z: ((+posed.hipL.z || 0) + (+posed.hipR.z || 0)) / 2};
  const sh = {x: (posed.shL.x + posed.shR.x) / 2, y: (posed.shL.y + posed.shR.y) / 2, z: ((+posed.shL.z || 0) + (+posed.shR.z || 0)) / 2};
  const rise = hip.y - sh.y;
  if (!(rise > 0)) return posed;
  const limOf = (axis) => {
    if (maxLeanDeg && typeof maxLeanDeg === 'object') {
      const v = axis === 'z' ? (maxLeanDeg.z ?? maxLeanDeg.flex) : (maxLeanDeg.x ?? maxLeanDeg.lateral);
      return Math.tan(Math.max(0, +v || 0) * Math.PI / 180) * rise;
    }
    return Math.tan(Math.max(0, +maxLeanDeg || 0) * Math.PI / 180) * rise;
  };
  const limX = limOf('x'), limZ = limOf('z');
  const over = (v, lim) => v > lim ? v - lim : v < -lim ? v + lim : 0;
  const ex = over(sh.x - hip.x, limX), ez = over(sh.z - hip.z, limZ);
  const TORSO_KEYS = ['head','neck','shL','shR','elL','elR','wristL','wristR','handL','handR','heart','crown','throat','thirdEye','lumbar','solar','thoracic'];
  const keys = TORSO_KEYS.filter(k => posed[k] && Number.isFinite(+posed[k].x) && Number.isFinite(+posed[k].y));

  if (ex || ez) {
    for (const k of keys) {
      const p = posed[k];
      const f = ARM_KEY.test(k) || HEAD_KEY.test(k) || k === 'neck' || k === 'throat' ? 1 : Math.max(0, Math.min(1, (hip.y - p.y) / rise));
      p.x -= ex * f;
      if (Number.isFinite(+p.z)) p.z = +p.z - ez * f;
    }
  }
  // Neck and head up: the head stacks over the neck within the same limit.
  if (posed.neck && posed.head) {
    const up = posed.neck.y - posed.head.y;
    if (up > 0) {
      const leanNum = (maxLeanDeg && typeof maxLeanDeg === 'object')
        ? Math.max(+maxLeanDeg.x || 0, +maxLeanDeg.z || 0)
        : (+maxLeanDeg || 0);
      const hl = Math.tan((Math.max(0, leanNum) + 2) * Math.PI / 180) * up;
      const hx = posed.head.x - posed.neck.x, hz = (+posed.head.z || 0) - (+posed.neck.z || 0);
      const dx = hx > hl ? hx - hl : hx < -hl ? hx + hl : 0, dz = hz > hl ? hz - hl : hz < -hl ? hz + hl : 0;
      if (dx || dz) for (const k of ['head', 'crown', 'thirdEye']) { const p = posed[k]; if (p) { p.x -= dx; if (Number.isFinite(+p.z)) p.z = +p.z - dz; } }
    }
  }
  return posed;
}

// The torso may flex and the shoulders may leave the hips (TJ Nov 10 5:46 PM).
// This no longer forces a vertical stack. It only keeps the head roughly
// balanced over the neck so a later shear cannot kink the cervical joint.
// y increases downward (crown above groin).
export const STACK_LEAN_DEG = 18; // head-vs-neck cap; not a whole-spine lean cap
export function stackTorsoSpine(pose, maxLeanDeg = STACK_LEAN_DEG) {
  if (!pose || !pose.neck || !pose.head) return pose;
  const neck = pose.neck, head = pose.head;
  const up = (+neck.y || 0) - (+head.y || 0);
  if (!(up > 1e-8)) return pose;
  const lim = Math.tan(Math.max(0, +maxLeanDeg || 0) * Math.PI / 180) * up;
  const over = (v) => v > lim ? v - lim : v < -lim ? v + lim : 0;
  const dx = over((+head.x || 0) - (+neck.x || 0));
  const dz = over((+head.z || 0) - (+neck.z || 0));
  if (!dx && !dz) return pose;
  for (const k of ['head', 'crown', 'thirdEye']) {
    const p = pose[k];
    if (!p || !Number.isFinite(+p.x)) continue;
    p.x -= dx;
    if (Number.isFinite(+p.z) || dz) p.z = (+p.z || 0) - dz;
  }
  return pose;
}

// Chakra anchors (TJ 11:44 AM, "bodies wandering away from the chakra
// points"): computed every frame from the FINAL posed body (after squat,
// grounding, rebalance and stage placement). Root at the groin/perineum,
// crown just above the top of the head, the five between on the root->crown
// line. Stage, insets, pulse trails and the string all use this.
export const CROWN_ABOVE_HEAD = 0.006; // height units above the head top
export function chakraAnchors(posed) {
  if (!posed || !posed.groin || !(posed.head || posed.crown)) return null;
  const h = +posed.height || 1, hr = posed.b && Number.isFinite(+posed.b.headR) ? posed.b.headR * h : 0;
  const root = {x: posed.groin.x, y: posed.groin.y};
  const crown = posed.head && hr > 0 ? {x: posed.head.x, y: posed.head.y - hr - CROWN_ABOVE_HEAD * h} : {x: posed.crown.x, y: posed.crown.y - CROWN_ABOVE_HEAD * h};
  return {root, crown, points: CHAKRAS_7.map(c => ({id: c.id, s: c.s, x: root.x + (crown.x - root.x) * c.s, y: root.y + (crown.y - root.y) * c.s}))};
}
// Side-sim chakra positions (s from root 0 to crown 1).
export const CHAKRAS_7 = [
  {id: 'root', s: 0.000},
  {id: 'sacral', s: 0.135},
  {id: 'solar', s: 0.281},
  {id: 'heart', s: HEART_S},
  {id: 'throat', s: 0.781},
  {id: 'thirdEye', s: 0.917},
  {id: 'crown', s: 1.000}
];

function rand(seed, n) {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// band: 0 kick / 1 bass (warm, heavier), 2 snare (mid), 3 hat (high, lighter).
function bandKind(band) {
  const b = ((band | 0) % 4 + 4) % 4;
  return b <= 1 ? 'bass' : b === 2 ? 'mid' : 'high';
}

const builds = new Map();
export function buildFor(id, band) {
  const key = (id | 0) * 4 + (((band | 0) % 4 + 4) % 4);
  const hit = builds.get(key);
  if (hit) return hit;
  const s = (id | 0) * 1.37 + 3.1;
  const kind = bandKind(band);
  const slender = kind === 'high' ? 0.86 : kind === 'bass' ? 1.1 : 1.0;
  const abdBase = kind === 'bass' ? 26 : kind === 'high' ? 18 : 22;
  const elbBase = kind === 'bass' ? 60 : kind === 'high' ? 40 : 50;
  const b = {
    kind,
    headR: HEAD_H * 0.5, // exactly one canon head so landmarks stay 7.5-head
    shW: HEAD_H * (kind === 'bass' ? 1.08 : kind === 'high' ? 0.95 : 1.0) * (0.97 + rand(s, 3) * 0.06),
    hipW: (0.92 * HEAD_H) * (kind === 'bass' ? 1.06 : kind === 'high' ? 0.94 : 1.0) * (0.98 + rand(s, 2) * 0.04),
    stanceW: (0.125 + rand(s, 7) * 0.02) * (kind === 'bass' ? 1.12 : 0.95),
    lean0: (rand(s, 1) - 0.5) * 0.04,
    // Rest hang (TJ Nov 10 6:19 PM): abduction ~5–10°, soft elbow ~10–15°.
    abductL: deg(clamp(7.5 + (rand(s, 10) - 0.5) * 3, 5, 10)),
    abductR: deg(clamp(7.5 + (rand(s, 11) - 0.5) * 3, 5, 10)),
    elbowL: deg(clamp(12.5 + (rand(s, 12) - 0.5) * 4, 10, 15)),
    elbowR: deg(clamp(12.5 + (rand(s, 13) - 0.5) * 4, 10, 15)),
    swingAmp: (kind === 'high' ? 0.12 : kind === 'bass' ? 0.07 : 0.10) * (0.88 + rand(s, 14) * 0.28),
    limb: (kind === 'bass' ? 0.062 : kind === 'high' ? 0.046 : 0.054) * (0.95 + rand(s, 15) * 0.1),
    zeta: clamp((kind === 'bass' ? 0.84 : kind === 'high' ? 0.72 : 0.78) + (rand(s, 17) - 0.5) * 0.06, 0.68, 0.9)
  };
  b.handAmp = b.swingAmp * (1.10 + rand(s, 21) * 0.25);
  const tw = (kind === 'bass' ? 1.08 : kind === 'high' ? 0.90 : 1.0) * (0.96 + rand(s, 22) * 0.08);
  b.armW = {sh: 0.026 * tw, el: 0.018 * tw, wr: 0.013 * tw, hand: 0.011 * tw};
  b.legW = {hip: 0.038 * tw, knee: 0.022 * tw, ank: 0.016 * tw, foot: 0.015 * tw};
  b.chestW = TORSO_CHEST_W * slender * (0.97 + rand(s, 23) * 0.06);
  b.waistW = TORSO_WAIST_W * slender * (0.95 + rand(s, 24) * 0.08);
  // Half-width: ~0.47 of head width (0.45–0.5), so the neck reads as a column.
  b.neckW = HEAD_H * 0.202 * Math.max(0.96, Math.min(1.08, slender));
  b.deltoid = 0.018 * tw;
  b.headRx = b.headR * 0.80;
  if (builds.size > 1024) builds.clear(); // pure memo; ids grow over a show (soak test, Nov 9)
  builds.set(key, b);
  return b;
}

// Two-bone IK: joint between A and C, bowed toward outSign (−1 left, +1 right).
export function ikJoint(A, C, lenAB, lenBC, outSign) {
  const dx = C.x - A.x;
  const dy = C.y - A.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const span = Math.max(Math.abs(lenAB - lenBC) + 0.004, Math.min(lenAB + lenBC - 0.004, d));
  const ux = dx / d;
  const uy = dy / d;
  const a = (lenAB * lenAB - lenBC * lenBC + span * span) / (2 * span);
  const h = Math.sqrt(Math.max(0, lenAB * lenAB - a * a));
  let px = -uy;
  let py = ux;
  if (px * outSign < 0) { px = -px; py = -py; }
  return {x: A.x + ux * a + px * h, y: A.y + uy * a + py * h};
}

export const GROOVE_SWAY = 0.014; // hip sway (height units), one side per beat
export const GROOVE_BOB = 0.006;  // knee-bounce dip on each beat
export const GROOVE_DEFAULT_BPM = 95;
export function idleGroove(g) {
  const amt = g && Number.isFinite(+g.amt) ? clamp(+g.amt, 0, 1) : 0;
  if (!(amt > 0)) return {x: 0, y: 0, amt: 0};
  const ph = Number.isFinite(+g.phase) ? +g.phase : 0; // beats since the held downbeat
  const bob = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);   // 0 on the beat (so 1 - bob dips ON the beat)
  return {x: amt * GROOVE_SWAY * Math.sin(Math.PI * ph), y: amt * GROOVE_BOB * (1 - bob), amt};
}

// Knees (TJ 10:32 AM): a real squat bends the knee FORWARD over the toes,
// never sideways (bow / knock) and never backward. The bend plane is the
// forward axis tilted out by the toe-out angle, so from the front a knee sits
// just outside the hip-ankle line and the leg foreshortens. The interior knee
// angle stays in [KNEE_MIN_DEG, 180 - KNEE_SOFT_DEG]: a soft micro-bend even
// standing tall, and no deeper than a full squat.
export const KNEE_TOE_OUT = 0.30;    // rad, the knee tracks over a slightly turned-out foot
export const KNEE_MIN_DEG = 62;      // deepest squat (interior angle); horse-stance shift may reach the low 60s
export const KNEE_SOFT_DEG = 7;      // micro-bend: never locked straight
function legSpanLimits(lenAB, lenBC) {
  const law = deg => Math.sqrt(lenAB * lenAB + lenBC * lenBC - 2 * lenAB * lenBC * Math.cos(deg * Math.PI / 180));
  return {min: law(KNEE_MIN_DEG), max: law(180 - KNEE_SOFT_DEG)};
}
// Foot-heading pole for a posed leg. Prefers heel→toe, then a yaw hint.
export function kneeForwardOf(pose, side, heading) {
  const s = (side === -1 || side === 'L' || side === 'l') ? 'L' : (side === 1 || side === 'R' || side === 'r') ? 'R' : String(side);
  const ankle = pose && (pose['ankle' + s] || pose.ankle);
  const heel = pose && (pose['heel' + s] || pose.heel || ankle);
  const toe = pose && (pose['foot' + s] || pose['toe' + s] || pose.foot || pose.toe);
  const yaw = heading ?? (pose && pose.twist && (pose.twist.facing ?? pose.twist.hipYaw)) ?? (pose && pose.facing);
  return footForward(heel, toe, yaw);
}

export function kneeIK(A, C, lenAB, lenBC, outSign, forward) {
  // Preferred bend: along the foot heading (toes), never world +z. A leftover
  // `if (nz < 0) flip` against world Z bent knees backward on 90° turns.
  let fwd;
  if (forward && typeof forward === 'object' && Number.isFinite(+forward.x + +(forward.z || 0))) {
    fwd = footForward({x: 0, y: 0, z: 0}, {x: +forward.x, y: 0, z: +(forward.z || 0)});
  } else if (typeof forward === 'number' && Number.isFinite(forward)) {
    fwd = {x: Math.sin(forward), y: 0, z: Math.cos(forward)};
  } else {
    fwd = {x: 0, y: 0, z: 1};
  }
  const out = (outSign < 0 ? -1 : 1) * (typeof KNEE_TOE_OUT === 'number' ? KNEE_TOE_OUT : 0);
  if (out) {
    const c = Math.cos(out), s = Math.sin(out);
    fwd = {x: fwd.x * c + fwd.z * s, y: 0, z: -fwd.x * s + fwd.z * c};
  }
  return ikJointForward(A, C, lenAB, lenBC, fwd, legSpanLimits(lenAB, lenBC));
}

export function kneeBend(hip, knee, ankle, outSign) {
  const hz = +hip.z || 0, kz = +knee.z || 0, az = +ankle.z || 0;
  const ux0 = ankle.x - hip.x, uy0 = ankle.y - hip.y, uz0 = az - hz, d = Math.hypot(ux0, uy0, uz0) || 1e-9;
  const ux = ux0 / d, uy = uy0 / d, uz = uz0 / d;
  const vx = knee.x - hip.x, vy = knee.y - hip.y, vz = kz - hz, t = vx * ux + vy * uy + vz * uz;
  const px = vx - t * ux, py = vy - t * uy, pz = vz - t * uz;          // knee offset off the hip-ankle line
  const a = Math.hypot(vx, vy, vz), c = Math.hypot(ankle.x - knee.x, ankle.y - knee.y, az - kz);
  const cosK = (a * a + c * c - d * d) / (2 * a * c || 1);
  return {forward: pz, outward: px * (outSign < 0 ? -1 : 1), off: Math.hypot(px, py, pz), angleDeg: Math.acos(Math.max(-1, Math.min(1, cosK))) * 180 / Math.PI};
}

// Damped arm counter-swing, one small state per dancer (stepped per frame).
const springs = new Map();
export function armSwing(id, weight, now, zeta = 0.8, hz = 1.2) {
  let st = springs.get(id | 0);
  if (!st) { st = {x1: 0, v1: 0, x2: 0, v2: 0, t: +now || 0}; springs.set(id | 0, st); }
  let dt = Math.max(0, Math.min(0.1, ((+now || 0) - st.t) / 1000));
  st.t = +now || 0;
  const w1 = 2 * Math.PI * hz * 1.08;
  const w2 = 2 * Math.PI * hz;
  const z2 = Math.min(0.95, zeta + 0.05);
  const w = Number.isFinite(+weight) ? +weight : 0;
  while (dt > 0) {
    const h = Math.min(dt, 1 / 90);
    st.v1 += (-2 * zeta * w1 * st.v1 - w1 * w1 * (st.x1 + 0.5 * w)) * h;
    st.x1 += st.v1 * h;
    st.v2 += (-2 * z2 * w2 * st.v2 - w2 * w2 * (st.x2 - 0.8 * st.x1)) * h;
    st.x2 += st.v2 * h;
    dt -= h;
  }
  if (!Number.isFinite(st.x1) || !Number.isFinite(st.x2)) { st.x1 = st.v1 = st.x2 = st.v2 = 0; }
  if (springs.size > 256) springs.clear();
  return {shoulder: st.x1, hand: st.x2};
}

// Pulse on the arms after it passes the heart: u 0 at the heart … 1 at the
// fingertips, lift is a small decaying bump (never a jerk).
export function armPulse(stringS, strikeU, heartU) {
  if (!(heartU >= 0) || !(strikeU >= heartU)) return {u: -1, lift: 0};
  const p = (strikeU - heartU) / ARM_PULSE_SPAN;
  if (p > 2.5) return {u: -1, lift: 0};
  const u = Math.min(1, p);
  const lift = ARM_LIFT * Math.sin(Math.PI * Math.min(1, p * 0.8)) * Math.exp(-1.4 * p);
  return {u: p <= 1 ? u : -1, lift: Math.max(0, lift)};
}



// Side-sim ease-in: slow on the planted foot, then a fast transfer that
// arrives exactly at frac === 1 with a sharp stop (TJ 6:21 / 6:57 PM).
export function stepEase(frac) {
  const f = clamp(+frac || 0, 0, 1);
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  return (Math.exp(STEP_EASE_K * f) - 1) / (Math.exp(STEP_EASE_K) - 1);
}

// Weight −1 left … +1 right. At frac=0 the landing foot (`side`) carries
// all the weight; at frac=1 it has arrived on the next foot.
export function stepWeight(side, frac) {
  const u = stepEase(frac);
  const s = side < 0 ? -1 : 1;
  return s * (1 - u) + (-s) * u;
}

// Free-foot lift in height units. Both feet stay down for DOUBLE_SUPPORT
// after the plant (hips settle over the stance foot), then the swing foot
// lifts, travels, and comes down to meet the next beat. At frac>=1 (waiting
// on a late beat) a sliver of lift remains so the visible plant happens on
// the strike, not early.
export const CONTACT_HOVER = 0.012; // height units; swing foot stays this far off the floor until the strike
export function swingLift(frac, activation = null) {
  const f = +frac || 0;
  if (!(f > 0)) return 0;
  if (f <= DOUBLE_SUPPORT) return 0;
  const t = Math.min(1, (Math.min(f, 0.9999) - DOUBLE_SUPPORT) / (1 - DOUBLE_SUPPORT));
  const u = stepEase(t);
  // Omitted activation keeps the full legacy lift. When provided, height and
  // the downward snap scale with stomp intensity (soft at rest, full when hot).
  const uAct = activation != null && Number.isFinite(+activation) ? smoothstep(clamp(+activation, 0, 1)) : 1;
  const fracH = STOMP_CALM / Math.max(1e-6, STOMP_PEAK);
  const height = SWING_LIFT * (fracH + (1 - fracH) * uAct);
  const fallExp = 2 + 3 * uAct; // 2 at rest (soft), 5 at peak (snappier)
  const rise = height * u * (1 - Math.pow(u, fallExp));
  const hover = CONTACT_HOVER * (0.4 + 0.6 * uAct) * u;
  if (f >= 1) return CONTACT_HOVER * (0.4 + 0.6 * uAct);
  return Math.max(hover, rise);
}

export function landGive(frac, airborne = false, activation = null) {
  if (airborne) return 0;
  // Default (no activation) keeps the softer-stomp ceiling so existing
  // tests and callers stay put. When activation is provided, the jolt
  // scales from a light tap to that same ceiling (TJ 8:12 PM).
  const peak = activation != null && Number.isFinite(+activation)
    ? stompIntensity(activation)
    : STOMP_SOFT;
  const f = clamp(+frac || 0, 0, 1);
  const uAct = activation != null && Number.isFinite(+activation) ? smoothstep(clamp(+activation, 0, 1)) : 1;
  // Sharp exp(-7) at high activation; softer exp(-3) ease at rest (no snap).
  return Math.exp(-(3 + 4 * uAct) * f) * peak;
}

// Map string-oscillation activation → 0..1 arm lift (side-sim curve).
// ≤0.12 low (arms down); 0.72 mid (hands at the face); 1.10 high (overhead).
export function armLiftAmount(activation, sense = 1) {
  const a = Math.max(0, +activation || 0) * (Number.isFinite(+sense) ? +sense : 1);
  if (a <= 0.12) return 0;
  if (a < 0.72) {
    const u = clamp((a - 0.12) / 0.60, 0, 1);
    return 0.5 * smoothstep(u);
  }
  const u = clamp((a - 0.72) / 0.38, 0, 1);
  return 0.5 + 0.5 * smoothstep(u);
}

// Stance cap (TJ Nov 10, 9:55 AM): "no further than twice shoulder width,
// like a horse-riding stance, and only at the peak activation." Normal dancing
// stays near shoulder width (≤ STANCE_SH_NORMAL); above STANCE_WIDE_ACT the
// stance ramps to the STANCE_SH_MAX horse stance with the knees bent.
// Ratios are half-width / half-shoulder (= full foot span / full shoulder span).
export const STANCE_SH_NORMAL = 0.95;
export const STANCE_SH_MAX = 2.0;
export const STANCE_WIDE_ACT = 0.80;
export const HORSE_HIP_DROP = 0.07;
export const SQUAT_HIP_DROP = 0.085; // extra hip drop (height units) at a full bass-drop squat
export const SQUAT_HIP_BACK = 0.05;  // hips travel back (depth) as they drop // hip drop (height units) at the full horse stance
export function horseStanceAmount(activation) {
  const a = clamp(+activation || 0, 0, 1);
  return smoothstep(clamp((a - STANCE_WIDE_ACT) / (1 - STANCE_WIDE_ACT), 0, 1));
}
// Rest stance (TJ Nov 10 5:16 PM): feet roughly under or slightly outside
// the hip joints (the sides of the pelvis). "Hip width" is the visual
// pelvis (~1.7–2.0 heads, 2·hipW), a little wider than the 1.5-head
// joint span. Foot-centre separation sits at REST_HIP_SEP of that visual
// width and never below STANCE_HIP_MIN.
export const REST_HIP_SEP = 0.90;
export const STANCE_HIP_MIN = 0.88;
export function hipWidth(build) {
  const hip = build && Number.isFinite(+build.hipW) && +build.hipW > 0 ? +build.hipW : 0.92 * HEAD_H;
  return 2 * hip;
}
// Lateral stance width in the floor plane, measured along the hip axis.
// |dx| shrinks when planted feet yaw; hypot(dx, dz) grows when one foot is
// ahead. The hip-axis projection keeps a turned or staggered stance at its
// true width (TJ: measure 2D stance with z or the rotated hip axis).
export function projectedStanceWidth(left, right, hipL, hipR) {
  const dx = (right && Number.isFinite(+right.x) ? +right.x : 0) - (left && Number.isFinite(+left.x) ? +left.x : 0);
  const dz = ((right && Number.isFinite(+right.z) ? +right.z : 0) - (left && Number.isFinite(+left.z) ? +left.z : 0));
  const footSpan = Math.hypot(dx, dz);
  if (hipL && hipR && Number.isFinite(+hipL.x) && Number.isFinite(+hipR.x)) {
    const hx = hipR.x - hipL.x, hz = (+hipR.z || 0) - (+hipL.z || 0);
    const hlen = Math.hypot(hx, hz);
    // A collapsed (edge-on) hip axis would inflate the width; fall back to
    // the floor-plane span when the hips are not a usable sideways axis.
    if (hlen > 1e-9 && hlen >= 0.2 * Math.max(footSpan, 1e-9)) return Math.abs(dx * hx + dz * hz) / hlen;
  }
  return (left && left.z != null) || (right && right.z != null) ? footSpan : Math.abs(dx);
}
export function hipAxisUnit(hipL, hipR) {
  if (!hipL || !hipR || !Number.isFinite(+hipL.x) || !Number.isFinite(+hipR.x)) return {x: 1, z: 0};
  const hx = hipR.x - hipL.x, hz = (+hipR.z || 0) - (+hipL.z || 0);
  const hlen = Math.hypot(hx, hz);
  return hlen > 1e-9 ? {x: hx / hlen, z: hz / hlen} : {x: 1, z: 0};
}
export function hipJointHalf(build, tallU = 0) {
  const hip = build && Number.isFinite(+build.hipW) && +build.hipW > 0 ? +build.hipW : 0.92 * HEAD_H;
  const scale = Math.max(0.96, Math.min(1.04, hip / (0.92 * HEAD_H)));
  const tall = Number.isFinite(+tallU) ? +tallU : 0;
  return HIP_JOINT_HEADS * HEAD_H * scale * (1 - 0.04 * tall);
}
// Unit half-widths for the rest and minimum foot-centre separations.
export function restStanceHalf(build) { return REST_HIP_SEP * hipWidth(build) / 2; }
export function minStanceHalf(build) { return STANCE_HIP_MIN * hipWidth(build) / 2; }
export function maxStanceHalf(build) {
  const sh = build && Number.isFinite(+build.shW) && +build.shW > 0 ? +build.shW : 0.125;
  // Foot centres sit FOOT_MID_OUT outside the stance line (toes turn out).
  return STANCE_SH_MAX * sh - FOOT_MID_OUT;
}
export const FOOT_MID_OUT = 0.018;
export function stanceWidthFor(activation, build, tallU = 0, restU = 0) {
  const sh = build && Number.isFinite(+build.shW) && +build.shW > 0 ? +build.shW : 0.125;
  const hip = build && Number.isFinite(+build.hipW) && +build.hipW > 0 ? +build.hipW : 0.09;
  const minW = STANCE_SH_MIN * sh;
  const calm = STANCE_SH_CALM * sh;
  const rest = restStanceHalf(build);
  void hip;
  const act = clamp(+activation || 0, 0, 1);
  const normal = mix(calm, STANCE_SH_NORMAL * sh, smoothstep(clamp(act / STANCE_WIDE_ACT, 0, 1)));
  const w = Math.min(STANCE_SH_MAX * sh - FOOT_MID_OUT, mix(normal, STANCE_SH_MAX * sh - FOOT_MID_OUT, horseStanceAmount(act)));
  // Standing tall uses the dance minimum, never feet together.
  const danceW = Math.max(minW, mix(w, minW, clamp(+tallU || 0, 0, 1)));
  const r = clamp(+restU || 0, 0, 1);
  return Math.max(minStanceHalf(build), mix(danceW, rest, r));
}

export function stanceInHipWidths(stanceW, build) {
  const hip = build && Number.isFinite(+build.hipW) && +build.hipW > 0 ? +build.hipW : 0.09;
  return (+stanceW || 0) / hip;
}

export function stanceInShoulderWidths(stanceW, build) {
  const sh = build && Number.isFinite(+build.shW) && +build.shW > 0 ? +build.shW : 0.125;
  return (+stanceW || 0) / sh;
}

// Smoothed RMS activation per dancer: fast-ish attack, slower decay so arms glide.
const acts = new Map();
export function smoothArmActivation(id, instant, now, attack = 0.50, decay = 0.90) {
  let st = acts.get(id | 0);
  if (!st) { st = {y: 0, t: +now || 0}; acts.set(id | 0, st); }
  const dt = Math.max(0, Math.min(0.1, ((+now || 0) - st.t) / 1000));
  st.t = +now || 0;
  const x = Math.max(0, +instant || 0);
  const tau = x > st.y ? attack : decay;
  const a = dt > 0 ? 1 - Math.exp(-dt / Math.max(1e-4, tau)) : 0;
  st.y += a * (x - st.y);
  if (!Number.isFinite(st.y)) st.y = 0;
  if (acts.size > 256) acts.clear();
  return st.y;
}

// Arm-lift pose families (TJ 7:51 PM). Height still follows activation;
// the family only chooses which way the arms travel. `both-up` is the
// original symmetric mid/high lift. Each phrase (4 beats) picks a new
// family from a per-dancer seed, never repeating the previous one.
// `both-forward` (TJ Nov 11): shoulder flexion, both arms reach forward in
// front of the body toward the audience (z), hands near chest height.
export const ARM_LIFT_FAMILIES = Object.freeze([
  'right-up', 'left-up', 'both-left', 'both-right', 'both-up', 'split', 'both-forward'
]);
export const ARM_PHRASE_BEATS = 4;
export const DEFAULT_ARM_FAMILY = 'both-up';

export function armLiftPhraseIndex(beatOrMotion) {
  const beat = beatOrMotion && typeof beatOrMotion === 'object'
    ? +beatOrMotion.beat || 0
    : +beatOrMotion || 0;
  return Math.max(0, Math.floor(Math.max(0, beat) / ARM_PHRASE_BEATS));
}

function hash2(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) + (b | 0);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function armLiftFamilyAt(id, phrase, prev = null) {
  const list = prev ? ARM_LIFT_FAMILIES.filter(f => f !== prev) : ARM_LIFT_FAMILIES;
  return list[hash2(id | 0, phrase | 0) % list.length];
}

const famMemo = new Map();
export function resetArmLiftFamilies() { famMemo.clear(); }

export function armLiftFamilyFor(id, phrase) {
  const p = Math.max(0, phrase | 0);
  const key = id | 0;
  const st = famMemo.get(key);
  if (st && st.phrase === p) return st.family;
  let start = 0, prev = null;
  if (st && st.phrase < p) { start = st.phrase + 1; prev = st.family; }
  let fam = prev;
  for (let i = start; i <= p; i++) fam = armLiftFamilyAt(key, i, fam);
  famMemo.set(key, {phrase: p, family: fam});
  if (famMemo.size > 256) famMemo.clear();
  return fam;
}

export function armLiftFamilySide(family) {
  if (family === 'left-up' || family === 'both-left') return 'left';
  if (family === 'right-up' || family === 'both-right') return 'right';
  if (family === 'split') return 'split';
  return 'symmetric';
}

// Split opposition: which arm is high flips with a second hash so the
// family can appear on either side without being a distinct slot.
function splitLeftHigh(id, phrase) {
  return (hash2((id | 0) ^ 0x5bd1e995, phrase | 0) & 1) === 0;
}

export function armLiftFamilySpec(family, id = 0, phrase = 0) {
  switch (family) {
    case 'right-up': return {raiseL: 0.08, raiseR: 1, leanL: 0.10, leanR: 0.22};
    case 'left-up': return {raiseL: 1, raiseR: 0.08, leanL: -0.22, leanR: -0.10};
    case 'both-left': return {raiseL: 1, raiseR: 0.92, leanL: -0.85, leanR: -0.95};
    case 'both-right': return {raiseL: 0.92, raiseR: 1, leanL: 0.95, leanR: 0.85};
    case 'split':
      return splitLeftHigh(id, phrase)
        ? {raiseL: 1, raiseR: 0.55, leanL: -0.75, leanR: 0.90}
        : {raiseL: 0.55, raiseR: 1, leanL: -0.90, leanR: 0.75};
    case 'both-forward': return {raiseL: 0.5, raiseR: 0.5, leanL: 0, leanR: 0, forward: 1};
    default: return {raiseL: 1, raiseR: 1, leanL: 0, leanR: 0};
  }
}

function mixFamSpec(a, c, t) {
  const o = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(c || {})]);
  for (const k of keys) o[k] = (+(a && a[k]) || 0) + ((+(c && c[k]) || 0) - (+(a && a[k]) || 0)) * t;
  return o;
}
// Cross-fade the next phrase's family over the last ease window of this
// phrase so the new pose arrives on the downbeat (no single-frame jump).
export function armLiftFamilySpecBlended(id, beat, bpm = 0, family = null) {
  const b = Math.max(0, +beat || 0);
  const p = Math.floor(b / ARM_PHRASE_BEATS);
  const left = ARM_PHRASE_BEATS - (b - p * ARM_PHRASE_BEATS);
  const curFam = family && ARM_LIFT_FAMILIES.includes(family) ? family : armLiftFamilyFor(id, p);
  const cur = armLiftFamilySpec(curFam, id, p);
  const beatS = 60 / Math.max(40, +bpm || 112);
  // Pose switches use the long end of the 150–400 ms window so the
  // in-between frames of a family change stay visible even at high BPM.
  const lead = Math.max(easeWindowS(bpm), 0.32) / beatS;
  if (lead > 0 && left <= lead) {
    const n = p + 1;
    const nxt = armLiftFamilySpec(armLiftFamilyFor(id, n), id, n);
    const w = 1 - left / lead;
    return mixFamSpec(cur, nxt, w * w * (3 - 2 * w));
  }
  return cur;
}


function armRaiseAngles(side, raiseAmt, b) {
  const flexT = smoothstep(clamp(raiseAmt / 0.5, 0, 1));
  const elevT = smoothstep(clamp((raiseAmt - 0.48) / 0.52, 0, 1));
  const uLow = side < 0 ? -b.abductL : b.abductR;
  const fLow = side < 0 ? uLow + b.elbowL : uLow - b.elbowR;
  const uMid = side < 0 ? -deg(7) : deg(7);
  const fMid = side < 0 ? Math.PI - deg(20) : Math.PI + deg(20);
  const uHigh = side < 0 ? Math.PI + deg(16) : Math.PI - deg(16);
  const fHigh = side < 0 ? Math.PI + deg(6) : Math.PI - deg(6);
  return {
    flexT, elevT,
    u: mix(mix(uLow, uMid, flexT), uHigh, elevT),
    f: mix(mix(fLow, fMid, flexT), fHigh, elevT)
  };
}

// Phase within a step: 0 at the strike / heel plant. If the estimated
// period elapses before the next strike, hold just shy of 1 so the swing
// foot doesn't fully plant early (the next strike is the visible contact).
export function stepFrac(now, motion) {
  if (!motion || !Number.isFinite(+motion.strikeAt) || +motion.strikeAt < 0) return 0;
  const period = Math.max(1, +motion.period || 1);
  const f = ((+now || 0) - +motion.strikeAt) / period;
  if (f <= 0) return 0;
  if (f >= 1) return 0.999;
  return f;
}

// Unit pose: y 0 at the crown, 1 at the floor; x in height units around 0.
// weight −1 left … +1 right (planted side), ease 0..1 within the step.

function yawPoint(p, ox, yaw, oz = 0) {
  if (!p) return p;
  const r = rotateFacing((+p.x || 0) - ox, (+p.z || 0) - oz, yaw);
  p.x = r.x + ox;
  p.z = r.z + oz;
  return p;
}

// Yaw the body around the planted ball. A planted toe has zero ground
// velocity; the heel/ankle may orbit that ball (a pivot, not a slide).
// Only a lifted foot is allowed to change its world xz (swing + stepZ).
export function applyBodyYaw(pts, {originX, originZ = 0, facing, hipYaw, shYaw, stepZ, stepX = 0, liftL, liftR}) {
  const yHip = (facing || 0) + (hipYaw || 0);
  const ySh = (facing || 0) + (shYaw || 0);
  const oz = originZ || 0;
  // Spine and head stay stacked with the pelvis; only the shoulder girdle
  // and arms take the relative shoulder yaw (TJ: torso stacked, motion from hips/legs/arms).
  for (const k of ['groin', 'hipL', 'hipR', 'heart', 'pelvis', 'lumbar', 'sacral', 'solar',
                   'neck', 'crown', 'head', 'throat', 'thirdEye', 'thoracic']) yawPoint(pts[k], originX, yHip, oz);
  for (const k of ['shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) {
    yawPoint(pts[k], originX, ySh, oz);
  }
  const pivotPlanted = (lift, ballKey, keys) => {
    if (lift > 0.001) {
      for (const k of keys) {
        yawPoint(pts[k], originX, yHip, oz);
        if (pts[k]) { pts[k].z = (pts[k].z || 0) + (stepZ || 0); if (stepX) pts[k].x += stepX; }
      }
      return;
    }
    const ball = pts[ballKey];
    const bx = ball ? ball.x : originX;
    const bz = ball ? (ball.z || 0) : oz;
    for (const k of keys) {
      if (k === ballKey) continue;
      yawPoint(pts[k], bx, yHip, bz);
    }
  };
  pivotPlanted(liftL || 0, 'footL', ['footL', 'heelL', 'ankleL']);
  pivotPlanted(liftR || 0, 'footR', ['footR', 'heelR', 'ankleR']);
}

// Pose phases shared by skeletonPose. Each phase reads the record from
// the previous one and writes the joints it owns back onto that record.
// The numbers in the bodies are the live pose; do not retune them here.

export function poseClockAndFeet(a) {
  const activation = a.activation, band = a.band, bandLevels = a.bandLevels, beat = a.beat, bpm = a.bpm, collect = a.collect;
  const ease = a.ease, eightDbl = a.eightDbl, eightDepth = a.eightDepth, eightRate = a.eightRate, eightVert = a.eightVert, groove = a.groove;
  const hipAccent = a.hipAccent, hipEight = a.hipEight, hush = a.hush, id = a.id, jump = a.jump, now = a.now;
  const padFeatures = a.padFeatures, periodMs = a.periodMs, pulseAmp = a.pulseAmp, pulseHz = a.pulseHz, raveFade = a.raveFade, raveMoves = a.raveMoves;
  const shoulderEight = a.shoulderEight, side = a.side, squat = a.squat, stanceLock = a.stanceLock, stepHz = a.stepHz, still = a.still;
  const strikes = a.strikes, tall = a.tall, times = a.times, weight = a.weight;

  const b = buildFor(id, band);
  const w = clamp(+weight || 0, -1, 1);
  const frac = +ease || 0; // may be 0.999 while waiting on a late beat (not clamped to 1)
  const tallT = clamp(+tall || 0, 0, 1);
  const tallU = smoothstep(tallT);
  const hushU = clamp(hush == null ? 1 : +hush, 0, 1);
  const clocked = now != null && Number.isFinite(+now);
  // Keep the live pose path whenever we have a clock and are not in an
  // explicit still hold. Hush scales motion to zero; a hushU>0 cutoff here
  // snapped the footwork path the frame silence completed.
  const live = clocked && !still;
  const tSec = clocked ? (+now / 1000) : 0;
  const periodSec = Math.max(0.05, (+periodMs || 0) > 0 ? +periodMs / 1000 : (stepHz > 0 ? 1 / +stepHz : 0.5));
  const hz = stepHz > 0 ? +stepHz : 1 / periodSec;
  const hipEightAmt = hipEight != null && Number.isFinite(+hipEight) ? +hipEight : HIP_EIGHT;
  const shEightAmt = shoulderEight != null && Number.isFinite(+shoulderEight) ? +shoulderEight : SHOULDER_EIGHT;
  const eightDepthAmt = eightDepth != null && Number.isFinite(+eightDepth) ? +eightDepth : EIGHT_DEPTH;
  const eightVertAmt = eightVert != null && Number.isFinite(+eightVert) ? +eightVert : EIGHT_VERT;
  const restU = restBlend({activation, hush: hushU, still});
  const fig8phase = (id | 0) * 0.37;
  const bpmEst = +bpm > 0 ? +bpm : (periodMs > 0 ? 60000 / periodMs : 0);
  const rateU = eightRate != null && Number.isFinite(+eightRate) ? Math.max(0.25, Math.min(1, +eightRate)) : swayRate(bpmEst);
  const fig8 = live ? hipFigureEight({tSec, stepHz: hz, phase: fig8phase, hush: hushU, still: false, amount: hipEightAmt, depth: eightDepthAmt, vert: eightVertAmt, activation: +activation || 0, strikes, pulseAmp, pulseHz, times, side, dbl: eightDbl, accent: hipAccent, rate: rateU}) : {x: 0, y: 0, z: 0, twist: 0};
  const stomp = activation != null && Number.isFinite(+activation) ? stompIntensity(activation, hushU) : STOMP_SOFT;
  // Rave / club step repertoire (side-sim PR #97, ported Nov 11): bounce +
  // nod, hip sway, two-step, jacking, body wave, T-step heel-toe, running
  // man, kick + stomp, forward/back and 90° turns. Feet lead via the live
  // footwork + floor anchors; this adds the per-move kinematics on top.
  // raveFade (drop jump, section-motion.js): the repertoire fades out into
  // the wind-up and back in after the landing instead of switching off.
  const raveK = raveFade != null && Number.isFinite(+raveFade) ? Math.max(0, Math.min(1, +raveFade)) : null;
  const rave = (live && (raveK != null ? raveK > 0.001 : !(+jump > 0)) && clocked) ? liveRaveLayer({id, tSec, bpm: hz * 60, beat, beatPhase: frac, activation: +activation || 0, hush: hushU,
    padFeatures, bandLevels, side, weight: w, amount: raveK != null ? raveK * (raveMoves == null ? RAVE_LIVE_DEFAULT : raveMoves) : raveMoves, facing: travelFacingOf(id), homeZ: travelWorldZOf(id)}) : null;
  // Standing tall: less side-to-side lean, feet close, hips rise, no stomp dip.
  const wLean = w * (1 - 0.7 * tallU);
  // Silence idle groove (TJ 10:25 AM): never stand still. A small sway,
  // weight shift and bob on the LAST locked beat (held tempo and phase);
  // feet stay planted at the rest stance, arms down, no steps.
  const gv = idleGroove(groove);
  let hipCx = b.lean0 + wLean * 0.10 + fig8.x;
  let leanTilt = 0;
  const shCx0 = b.lean0 + wLean * 0.062;
  const headX0 = b.lean0 + wLean * 0.04;
  const give = landGive(frac, jump > 0, activation) * (1 - tallU) * (1 - restU);
  // Horse stance: knees bend (hips drop) as the feet go wide at peak.
  const horseU = activation != null && Number.isFinite(+activation) ? horseStanceAmount(activation) * (1 - tallU) * (1 - restU) : 0;
  // Squat (TJ 10:32 AM): depth follows activation and bass hits/drops (eased
  // per dancer in silhouette.js). Hips go down and back; feet stay planted.
  const squatU = clamp(+squat || 0, 0, 1) * (1 - tallU) * (1 - restU);
  // Low activation / breakdowns stand tall on near-straight legs (soft micro-bend).
  const actHip = activation != null && Number.isFinite(+activation) ? mix(REST_HIP_Y + 0.002, REST_HIP_Y + 0.016, smoothstep(clamp(+activation / 0.6, 0, 1))) : REST_HIP_Y + 0.016;
  const hipY0 = mix(mix(actHip + 0.018 * give + HORSE_HIP_DROP * horseU + SQUAT_HIP_DROP * squatU, TALL_HIP_Y, tallU), REST_HIP_Y, restU) + fig8.y + gv.y
    + (rave ? (rave.bounce + rave.hop) * (1 - tallU) : 0);
  const groinY0 = hipY0 + 0.02 * (1 - 0.35 * tallU);
  const floorY = 0.99;
  let stanceW = activation != null && Number.isFinite(+activation)
    ? stanceWidthFor(activation, b, tallU, restU)
    : mix(Math.max(STANCE_SH_MIN * b.shW, mix(b.stanceW, STANCE_SH_MIN * b.shW, tallU)), restStanceHalf(b), restU);
  // Double-support locks the last planted width (both feet down cannot
  // slide). A collection step is the only way to narrow into rest.
  // Footwork is published by silhouette (or by footworkPlan) so this signature
  // stays the one build-and-drop (#113) extends with raveFade.
  const footwork = (groove && groove.footwork && groove.footwork.pos) ? groove.footwork : publishedFootwork(id);
  const fwTravel = !!(footwork && (footwork.amount || 0) > 0.02 && (
    footwork.kind === 'step' || footwork.kind === 'tap' || footwork.kind === 'kick'
    || (footwork.lift && ((footwork.lift.L || 0) > 0.001 || (footwork.lift.R || 0) > 0.001))));
  // A traveling step owns the feet; collecting on top would retarget a nearly planted foot.
  const collecting = !!collect && !fwTravel;
  if (collecting) stanceW = stanceWidthFor(0, b, tallU, 1);
  else if (Number.isFinite(+stanceLock) && +stanceLock > 0) stanceW = +stanceLock;
  // Hard cap: the feet never part wider than STANCE_SH_MAX shoulder widths.
  // Hard bounds: min just under hip width (TJ 10:30), max 2.0 shoulder widths.
  stanceW = Math.max(minStanceHalf(b), Math.min(maxStanceHalf(b), Number.isFinite(stanceW) ? stanceW : STANCE_SH_CALM * b.shW));
  // Planted stance foot stays down. The free foot lifts only after a short
  // double-support, then plants on the next beat. Rare jumps lift both.
  // While standing tall the stride shrinks (legs stay nearly straight).
  // Low activation (TJ 11:24 AM): both feet stay planted; the weight shifts
  // foot to foot on the beat. Lifts start above STEP_MIN_ACT.
  const stepU = activation != null && Number.isFinite(+activation) ? stepGate(+activation) : 1;
  const free = swingLift(frac, activation) * (1 - 0.85 * tallU) * hushU * (collecting ? 1 : (1 - restU) * stepU);
  const leftLanding = side < 0;
  let liftL = 0, liftR = 0;
  if (leftLanding) liftR = free;
  else liftL = free;
  // Footwork step library (footwork-steps.js, TJ Nov 11 11:12 PM): the
  // plan gives both feet in the dancer's home frame. Only their relative
  // placement reaches the world (the planted contact is pinned), so a step
  // is walked, never slid. A collect step starts from these positions (the
  // planted foot stays, the free foot walks to the rest stance) so the pose
  // never snaps when hush or rest collection begins.
  // Keep the last plan at rest / hush-end so the unit pose matches the
  // planted feet (live is false when still, but snapping off the plan
  // would pop the pelvis off the legs).
  const steps = clocked && footwork && footwork.pos ? footwork : null;
  let midL = -stanceW + b.lean0 * 0.2;
  let midR = stanceW + b.lean0 * 0.2;
  let zL = 0, zR = 0;
  if (steps) {
    const cx0 = (steps.pos.L.x + steps.pos.R.x) / 2, cz0 = (steps.pos.L.z + steps.pos.R.z) / 2;
    midL = steps.pos.L.x - cx0 + b.lean0 * 0.2;
    midR = steps.pos.R.x - cx0 + b.lean0 * 0.2;
    zL = steps.pos.L.z - cz0; zR = steps.pos.R.z - cz0;
    if (collecting) {
      const restW = stanceWidthFor(0, b, tallU, 1);
      if (side < 0) { midR = midL + 2 * restW; zR = 0; }
      else { midL = midR - 2 * restW; zL = 0; }
    }
    stanceW = (midR - midL) / 2;
  }
  let toeL, toeR, ankleL, ankleR, heelL, heelR, contactL = 'flat', contactR = 'flat';
  const fw = live ? footworkState({tSec, periodSec, side, ease: frac, freeLift: steps ? 0 : free, jump, strikes, id, beat, hush: hushU, still: false, activation: +activation || 0}) : null;
  if (fw && stepU < 1 && !jump && !steps) { fw.liftL *= stepU; fw.liftR *= stepU; }
  if (fw && steps && !jump) {
    // Step lifts, toe taps (heel up, no weight) and the kick. The planted
    // foot never lifts; its heel-strike roll from footworkState stays.
    // The floor pin (side) can stay on the previous contact through a
    // double-support shift. Which foot is down follows the plan's weight,
    // so a landing is on the floor the frame it takes the weight.
    const tallK = (1 - 0.5 * tallU) * hushU;
    const plantSide = (steps.weightSide === 1 || steps.weightSide === -1) ? (steps.weightSide < 0 ? -1 : 1) : (side < 0 ? -1 : 1);
    for (const sd of [-1, 1]) {
      const k = sd < 0 ? 'L' : 'R';
      if (sd === plantSide) {
        if (sd < 0) fw.liftL = 0; else fw.liftR = 0;
        // Weight shifted onto a foot that never left the floor: no strike roll.
        if (steps.weightKind === 'shift') { if (sd < 0) { fw.contactL = 'flat'; fw.rockL = 0; } else { fw.contactR = 'flat'; fw.rockR = 0; } }
        continue;
      }
      const lift = (steps.lift[k] || 0) * tallK;
      if (sd < 0) fw.liftL = lift; else fw.liftR = lift;
      if (steps.contact[k] !== 'flat' || lift > 0.001) {
        if (sd < 0) { fw.contactL = steps.contact[k] === 'flat' ? 'toe' : steps.contact[k]; fw.rockL = Math.max(steps.rock[k] * hushU, 0); }
        else { fw.contactR = steps.contact[k] === 'flat' ? 'toe' : steps.contact[k]; fw.rockR = Math.max(steps.rock[k] * hushU, 0); }
      } else if (sd < 0) { fw.contactL = 'flat'; fw.rockL = 0; } else { fw.contactR = 'flat'; fw.rockR = 0; }
    }
  }
  if (fw && rave && !jump) {
    // Rave foot articulation: T-step heel/toe rocks, running-man perches and
    // kick accents. The live footwork's own ornaments win where they fire;
    // a planted foot only rocks (never lifts), the free foot taps / lifts.
    const plantSide = (steps && (steps.weightSide === 1 || steps.weightSide === -1)) ? (steps.weightSide < 0 ? -1 : 1) : (side < 0 ? -1 : 1);
    const mergeFoot = (sd, art) => {
      const L = sd < 0;
      const planted = sd === plantSide;
      const ownRock = L ? fw.rockL : fw.rockR;
      const ownContact = L ? fw.contactL : fw.contactR;
      if (!art || (art.contact === 'flat' && !(art.lift > 0.001))) return;
      if (planted) {
        if (ownContact === 'flat' && !(ownRock > 0.05) && art.rock > 0.02) {
          if (L) { fw.contactL = art.contact; fw.rockL = art.rock; } else { fw.contactR = art.contact; fw.rockR = art.rock; }
        }
        return;
      }
      const lift = art.lift * (collect ? 0 : stepU) * (1 - 0.85 * tallU);
      if (L) {
        if (lift > fw.liftL) fw.liftL = lift;
        if (ownContact === 'flat' && art.rock > 0.02) { fw.contactL = art.contact; fw.rockL = Math.max(fw.rockL || 0, art.rock); }
      } else {
        if (lift > fw.liftR) fw.liftR = lift;
        if (ownContact === 'flat' && art.rock > 0.02) { fw.contactR = art.contact; fw.rockR = Math.max(fw.rockR || 0, art.rock); }
      }
    };
    mergeFoot(-1, rave.footL);
    mergeFoot(1, rave.footR);
  }
  if (collecting) {
    if (leftLanding) { if (fw) fw.liftR = Math.max(fw.liftR || 0, 0.028); liftR = Math.max(liftR, 0.028); }
    else { if (fw) fw.liftL = Math.max(fw.liftL || 0, 0.028); liftL = Math.max(liftL, 0.028); }
  }
  if (fw) {
    liftL = fw.liftL; liftR = fw.liftR;
    contactL = fw.contactL; contactR = fw.contactR;
    const posedL = shiftFootZ(posedFoot(footLayout(-1, midL), fw.contactL, fw.rockL, fw.liftL), zL);
    const posedR = shiftFootZ(posedFoot(footLayout(1, midR), fw.contactR, fw.rockR, fw.liftR), zR);
    toeL = posedL.toe; toeR = posedR.toe;
    heelL = posedL.heel; heelR = posedR.heel;
    ankleL = posedL.ankle; ankleR = posedR.ankle;
  } else {
    // Rare jumps: placePoseOnFloor lifts the whole figure. While airborne the
    // stance pin still holds relative foot placement; both feet leave the floor
    // together because the anchor itself rises.
    const restL = posedFoot(footLayout(-1, midL), 'flat', 0, liftL);
    const restR = posedFoot(footLayout(1, midR), 'flat', 0, liftR);
    toeL = restL.toe; toeR = restR.toe;
    heelL = restL.heel; heelR = restR.heel;
    ankleL = restL.ankle; ankleR = restR.ankle;
  }
  Object.assign(a, {ankleL, ankleR, b, bpmEst, clocked, contactL, contactR, eightDepthAmt, eightVertAmt, fig8, fig8phase, frac, fw, give, groinY0, gv, headX0, heelL, heelR, hipCx, hipY0, hushU, hz, leanTilt, liftL, liftR, live, midL, midR, periodSec, rateU, rave, restU, shCx0, shEightAmt, squatU, stanceW, steps, stomp, tSec, tallU, toeL, toeR, w, wLean});
  return a;
}
export function poseSupportAndSpine(a) {
  const activation = a.activation, ankleL = a.ankleL, ankleR = a.ankleR, armFamily = a.armFamily, armLift = a.armLift, armSwellLift = a.armSwellLift;
  const b = a.b, beat = a.beat, bpmEst = a.bpmEst, eightDepthAmt = a.eightDepthAmt, eightVertAmt = a.eightVertAmt, fig8 = a.fig8;
  const fig8phase = a.fig8phase, frac = a.frac, give = a.give, groinY0 = a.groinY0, gv = a.gv, headX0 = a.headX0;
  const heelL = a.heelL, heelR = a.heelR, hipY0 = a.hipY0, hushU = a.hushU, hz = a.hz, id = a.id;
  const liftL = a.liftL, liftR = a.liftR, live = a.live, midL = a.midL, midR = a.midR, phrase = a.phrase;
  const pulseAmp = a.pulseAmp, pulseHz = a.pulseHz, rateU = a.rateU, rave = a.rave, restU = a.restU, shCx0 = a.shCx0;
  const shEightAmt = a.shEightAmt, side = a.side, squatU = a.squatU, steps = a.steps, still = a.still, strikes = a.strikes;
  const tallU = a.tallU, times = a.times, toeL = a.toeL, toeR = a.toeR, tSec = a.tSec, w = a.w;
  const wLean = a.wLean;
  let hipCx = a.hipCx, leanTilt = a.leanTilt;

  // Body weight stays over the support (TJ 8:28 PM): planted foot in single
  // support, between the feet in double support; shift toward the incoming
  // foot before the stance lifts; hips/torso counter-lean to balance.
  const plantX = side < 0 ? midL : midR;
  const freeX = side < 0 ? midR : midL;
  const liftFree = side < 0 ? liftR : liftL;
  const doubleSup = still || !(liftFree > 0.012);
  let comX;
  if (steps) {
    // Weight follows the plan: over the stance foot through a tap (no
    // weight on the tapping toe), rolling to the landing foot on the beat.
    // Low activation: only a gentle weight shift (hips stay near centre).
    const wAmt = 0.12 + 0.88 * clamp(Number.isFinite(+steps.amount) ? +steps.amount : 1, 0, 1);
    const wu = clamp((w * wAmt + 1) / 2, 0, 1);
    comX = midL + (midR - midL) * wu;
  } else if (doubleSup) {
    comX = (midL + midR) * 0.5;
    if (!still && frac >= 0.78) comX = mix(comX, freeX, smoothstep((frac - 0.78) / 0.22) * 0.7);
  } else {
    comX = plantX;
    if (frac >= 0.78) comX = mix(plantX, freeX, smoothstep((frac - 0.78) / 0.22));
  }
  hipCx = comX + b.lean0 * 0.2 + wLean * 0.03 * (1 - 0.85 * restU) + fig8.x + gv.x + (rave ? rave.hipSwayX : 0);
  leanTilt = clamp((plantX - comX) * 1.8 + wLean * 0.04, -0.02, 0.02);
  // Jointed spine (chakra-wave driven, lag 4×, amount 0.85). Off unless live.
  const sp = live ? spineFlexState({id, tSec, strikes, activation: +activation || 0, amp: pulseAmp, hz: pulseHz, times, periodSec: stringPeriodSec(hz), hush: hushU, amount: SPINE_FLEX, lagMul: SPINE_LAG, squat: squatU, tall: tallU}) : null;
  const along = (from, phi, len, pitch = 0) => {
    const cp = Math.cos(pitch || 0), spn = Math.sin(pitch || 0);
    return {
      x: from.x + Math.sin(phi) * cp * len,
      y: from.y - Math.cos(phi) * cp * len,
      z: (from.z || 0) + spn * len
    };
  };
  let pelvis = {x: hipCx, y: hipY0, z: (fig8.z || 0) - SQUAT_HIP_BACK * squatU};
  let hipY = hipY0, groinY = groinY0, neck, crown, head, shL, shR, shCx = shCx0, headX = headX0;
  const raiseBody = clamp(Math.max(+armLift || 0, tallU), 0, 1) * (1 - restU);
  // Energy arm swell (energy-motion.js) lifts the arms only: it does not wake
  // the body (upright / rest caps keep following activation).
  const raise = Math.max(raiseBody, clamp(+armSwellLift || 0, 0, 1) * (1 - restU));
  const family = ARM_LIFT_FAMILIES.includes(armFamily) ? armFamily : DEFAULT_ARM_FAMILY;
  const beatF = Number.isFinite(+beat) ? +beat : (phrase | 0) * ARM_PHRASE_BEATS;
  const famSpec = armLiftFamilySpecBlended(id, beatF, bpmEst, family);
  const flexT = smoothstep(clamp(raise / 0.5, 0, 1));
  const elevT = smoothstep(clamp((raise - 0.48) / 0.52, 0, 1));
  const shrug = 0.052 * elevT;
  // Spine and neck lengths are the rest canon, never a function of squat,
  // bounce, tall, shrug or activation (TJ Nov 10 6:27 PM).
  let lumbar, thoracic;
  if (sp && hushU > 0) {
    const phiP = sp.phi.pelvis, phiL = sp.phi.lumbar, phiT = sp.phi.thoracic;
    const phiN = sp.phi.neck, phiH = sp.phi.head;
    // Jacking, body wave and the yes-nod are sagittal (side sim #97), so they
    // cannot stack into a hard side lean; lengths stay the rest canon.
    const sag = raveSagittal(rave);
    const pitP = (sp.phi.pitchP || 0) + sag.pelvis, pitL = (sp.phi.pitchL || 0) + sag.lumbar, pitT = (sp.phi.pitchT || 0) + sag.thoracic;
    const pitN = (sp.phi.pitchN || 0) + sag.neck, pitH = (sp.phi.pitchH || 0) + sag.head;
    lumbar = along(pelvis, phiP, BONE_PELVIS_LUMBAR, pitP);
    thoracic = along(lumbar, phiL, BONE_LUMBAR_THORACIC, pitL);
    neck = along(thoracic, phiT, BONE_THORACIC_NECK, pitT);
    crown = along(neck, phiN, BONE_NECK_CROWN, pitN);
    head = along(neck, phiH, BONE_NECK_HEAD, pitH);
    const shMid = along(neck, phiT, -BONE_NECK_SHOULDER, pitT);
    shL = {x: shMid.x - b.shW * Math.cos(phiT), y: shMid.y - b.shW * Math.sin(phiT), z: shMid.z || 0};
    shR = {x: shMid.x + b.shW * Math.cos(phiT), y: shMid.y + b.shW * Math.sin(phiT), z: shMid.z || 0};
    shCx = shMid.x;
    headX = head.x;
  } else {
    neck = {x: shCx0, y: pelvis.y - (BONE_PELVIS_LUMBAR + BONE_LUMBAR_THORACIC + BONE_THORACIC_NECK), z: pelvis.z || 0};
    lumbar = {x: shCx0, y: pelvis.y - BONE_PELVIS_LUMBAR, z: pelvis.z || 0};
    thoracic = {x: shCx0, y: lumbar.y - BONE_LUMBAR_THORACIC, z: pelvis.z || 0};
    crown = {x: headX0, y: neck.y - BONE_NECK_CROWN, z: 0};
    head = {x: headX0, y: neck.y - BONE_NECK_HEAD, z: 0};
    shL = {x: shCx0 - b.shW, y: neck.y + BONE_NECK_SHOULDER, z: 0};
    shR = {x: shCx0 + b.shW, y: neck.y + BONE_NECK_SHOULDER, z: 0};
  }
  const sh8 = live ? shoulderFigureEight({tSec, stepHz: hz, phase: fig8phase, hush: hushU, still: false, amount: shEightAmt, depth: eightDepthAmt, vert: eightVertAmt, activation: +activation || 0, strikes, pulseAmp, pulseHz, times, rate: rateU}) : {x: 0, y: 0, z: 0, tilt: 0, twist: 0};
  if (sh8.x || sh8.y || sh8.z || sh8.tilt || sh8.twist) {
    const midX = (shL.x + shR.x) * 0.5 + sh8.x;
    const midY = (shL.y + shR.y) * 0.5 + sh8.y;
    const midZ = ((shL.z || 0) + (shR.z || 0)) * 0.5 + (sh8.z || 0);
    const hx = (shR.x - shL.x) * 0.5, hy = (shR.y - shL.y) * 0.5;
    const c = Math.cos(sh8.tilt), s = Math.sin(sh8.tilt);
    const rx = hx * c - hy * s, ry = hx * s + hy * c;
    shL = {x: midX - rx - sh8.twist, y: midY - ry, z: midZ};
    shR = {x: midX + rx + sh8.twist, y: midY + ry, z: midZ};
    // Shoulders may roll; the spine stays stacked (no neck/head follow).
  }
  // Rest: shoulders sit down and slightly back, not hunched or rolled forward.
  if (restU > 0.002) {
    const back = 0.014 * restU;
    const drop = 0.004 * restU;
    if (shL) { shL.z = (shL.z || 0) - back; shL.y += drop; }
    if (shR) { shR.z = (shR.z || 0) - back; shR.y += drop; }
  }
  if (neck && shL && shR) placeGirdleOnNeck(neck, shL, shR, BONE_NECK_SHOULDER);
  if (leanTilt) {
    // Same shift on the whole upper body so a weight-shift does not kink the spine.
    const tlt = leanTilt;
    if (lumbar) lumbar = {x: lumbar.x - tlt * 0.7, y: lumbar.y, z: lumbar.z || 0};
    if (thoracic) thoracic = {x: thoracic.x - tlt * 0.7, y: thoracic.y, z: thoracic.z || 0};
    if (neck) neck = {x: neck.x - tlt * 0.7, y: neck.y, z: neck.z || 0};
    if (head) head = {x: head.x - tlt * 0.7, y: head.y, z: head.z || 0};
    if (crown) crown = {x: crown.x - tlt * 0.7, y: crown.y, z: crown.z || 0};
    if (shL) shL = {x: shL.x - tlt * 0.7, y: shL.y, z: shL.z || 0};
    if (shR) shR = {x: shR.x - tlt * 0.7, y: shR.y, z: shR.z || 0};
    shCx -= tlt * 0.7;
    headX -= tlt * 0.7;
  }
  const lw = live ? legWaveState({tSec, strikes, times, hush: hushU, amount: LEG_COMPLEX}) : {knee: {L: 0, R: 0}, hip: {L: 0, R: 0}};
  const phiP0 = sp ? sp.phi.pelvis : 0;
  const hipPerpX = Math.cos(phiP0), hipPerpY = Math.sin(phiP0);
  const jointH = hipJointHalf(b, tallU);
  let hipL = {
    x: pelvis.x - jointH * hipPerpX - lw.hip.L,
    y: pelvis.y - jointH * hipPerpY + (w < 0 ? 0.008 * give : 0),
    z: pelvis.z || 0
  };
  let hipR = {
    x: pelvis.x + jointH * hipPerpX + lw.hip.R,
    y: pelvis.y + jointH * hipPerpY + (w > 0 ? 0.008 * give : 0),
    z: pelvis.z || 0
  };
  let kneeL = kneeIK(hipL, ankleL, THIGH, SHIN, -1, footForward(heelL, toeL));
  let kneeR = kneeIK(hipR, ankleR, THIGH, SHIN, 1, footForward(heelR, toeR));
  const nudgeKnee = (knee, fwd, amt) => {
    if (!amt || !knee || !fwd) return knee;
    return {x: knee.x + fwd.x * amt, y: knee.y, z: (knee.z || 0) + fwd.z * amt};
  };
  // Leg waves only deepen the forward bend along the toes (no backward pops).
  kneeL = nudgeKnee(kneeL, footForward(heelL, toeL), Math.max(0, lw.knee.L) * 0.3);
  kneeR = nudgeKnee(kneeR, footForward(heelR, toeR), Math.max(0, lw.knee.R) * 0.3);
  Object.assign(a, {crown, elevT, famSpec, family, flexT, groinY, head, hipCx, hipL, hipR, kneeL, kneeR, lumbar, neck, pelvis, raise, raiseBody, sh8, shL, shR, sp, thoracic});
  return a;
}
export function poseArms(a) {
  const activation = a.activation, armPadSense = a.armPadSense, b = a.b, band = a.band, clocked = a.clocked, crown = a.crown;
  const elevT = a.elevT, famSpec = a.famSpec, fig8 = a.fig8, flexT = a.flexT, frac = a.frac, groinY = a.groinY;
  const hipCx = a.hipCx, hipTwist = a.hipTwist, hushU = a.hushU, id = a.id, lift = a.lift, live = a.live;
  const maxBodyTurn = a.maxBodyTurn, padFeatures = a.padFeatures, periodSec = a.periodSec, raise = a.raise, restU = a.restU, shoulderTwist = a.shoulderTwist;
  const side = a.side, strikes = a.strikes, swing = a.swing, tall = a.tall, thoracic = a.thoracic, times = a.times;
  const tSec = a.tSec, turnFreq = a.turnFreq, w = a.w;
  let shL = a.shL, shR = a.shR;

  const sw0 = swing || {shoulder: -0.5 * w, hand: -0.4 * w};
  const sw = restU > 0 ? {shoulder: sw0.shoulder * (1 - restU), hand: sw0.hand * (1 - restU)} : sw0;
  const hp = sw.hand - sw.shoulder;
  const up = clamp(+lift || 0, 0, 0.05);
  const handAmp = b.handAmp || b.swingAmp * 1.15;
  const flexWave = live ? armWaveFlex({tSec, strikes, times, hush: hushU, amount: ARM_FLEX}) : {elL: 0, elR: 0, wrL: 0, wrR: 0};
  let aUpperL, aUpperR, aForeL, aForeR;
  let flexL = 0, flexR = 0;
  if (raise <= 0) {
    // Rest / low: original athletic arms-down, plus the heart-branch pulse.
    aUpperL = -b.abductL + b.swingAmp * sw.shoulder - up * 2.2;
    aUpperR = b.abductR + b.swingAmp * sw.shoulder + up * 2.2;
    aForeL = aUpperL + b.elbowL + b.swingAmp * 1.15 * hp + up * 3.0;
    aForeR = aUpperR - b.elbowR + b.swingAmp * 1.15 * hp - up * 3.0;
  } else {
    // Per-family lift (TJ 7:51 PM). each arm uses the original mid/high
    // curves, then a lean (positive = stage right) and a per-arm raise so
    // one arm can stay down or both can travel to the same side.
    const swingKeep = 1 - 0.88 * Math.max(flexT, elevT);
    const left = armRaiseAngles(-1, raise * famSpec.raiseL, b);
    const right = armRaiseAngles(1, raise * famSpec.raiseR, b);
    flexL = left.flexT; flexR = right.flexT;
    const leanL = famSpec.leanL * deg(58) * Math.max(left.flexT, left.elevT);
    const leanR = famSpec.leanR * deg(58) * Math.max(right.flexT, right.elevT);
    aUpperL = left.u - leanL + b.swingAmp * sw.shoulder * swingKeep;
    aUpperR = right.u - leanR + b.swingAmp * sw.shoulder * swingKeep;
    aForeL = left.f - leanL + handAmp * hp * swingKeep;
    aForeR = right.f - leanR + handAmp * hp * swingKeep;
  }
  // Arm-wave flex (amount 0.8): damped elbow/wrist response on the same pulse clock.
  aForeL += flexWave.elL * deg(16);
  aForeR -= flexWave.elR * deg(16);
  let wrBendL = flexWave.wrL * deg(18);
  let wrBendR = flexWave.wrR * deg(18);
  // Melody/Pad overlay (shared pad-arms.js): hands lead, traveling wave, overhead at peak.
  let padArm = null;
  const padFeat = padFeatures && typeof padFeatures === 'object' ? padFeatures : null;
  // Apply whenever the clock is running, including a still / low-activation
  // dancer: pad and melody energy themselves drive the arms. Silence (empty
  // features) still leaves blend at 0 so the hang cap keeps arms down.
  if (padFeat && clocked) {
    padArm = padArmState({id, band, tSec, features: padFeat, sense: armPadSense, act: raise});
    const layered = applyPadArmAngles({aUpperL, aUpperR, aForeL, aForeR}, padArm);
    aUpperL = layered.aUpperL;
    aUpperR = layered.aUpperR;
    aForeL = layered.aForeL;
    aForeR = layered.aForeR;
    wrBendL += layered.wrAddL || 0;
    wrBendR += layered.wrAddR || 0;
  }
  let elL = {x: shL.x + Math.sin(aUpperL) * UPPER_ARM, y: shL.y + Math.cos(aUpperL) * UPPER_ARM};
  let elR = {x: shR.x + Math.sin(aUpperR) * UPPER_ARM, y: shR.y + Math.cos(aUpperR) * UPPER_ARM};
  let wristL = {x: elL.x + Math.sin(aForeL) * FOREARM, y: elL.y + Math.cos(aForeL) * FOREARM};
  let wristR = {x: elR.x + Math.sin(aForeR) * FOREARM, y: elR.y + Math.cos(aForeR) * FOREARM};
  let handL = {x: wristL.x + Math.sin(aForeL + wrBendL) * HAND_LEN, y: wristL.y + Math.cos(aForeL + wrBendL) * HAND_LEN};
  let handR = {x: wristR.x + Math.sin(aForeR - wrBendR) * HAND_LEN, y: wristR.y + Math.cos(aForeR - wrBendR) * HAND_LEN};
  // Traveling seesaw / sine along the arms (pad v3). Then cap so hands stay above elbows.
  const armJoints = {shL, shR, elL, elR, wristL, wristR, handL, handR};
  if (padArm) applyTravelingWave(armJoints, padArm);
  const capFlex = Math.max(flexT, flexL, flexR);
  capHandsLead(armJoints, {flexT: capFlex, lead: padArm ? (padArm.lead || 0) : 0, minClear: 0.018});
  capRestHang(armJoints, {activation: Math.max(+activation || 0, +raise || 0, +tall || 0, padDriveActivation(padArm)), shW: b.shW, upperLen: UPPER_ARM, foreLen: FOREARM, handLen: HAND_LEN});
  // Heart-branch pulse after the rest-hang cap so a quiet pulse can still
  // lift the hands a little without re-cocking the elbows at rest.
  if (up > 0) {
    const n = up / 0.05;
    const upEl = 0.016 * n, outEl = 0.012 * n;
    armJoints.elL = {x: armJoints.elL.x - outEl, y: armJoints.elL.y - upEl, z: armJoints.elL.z};
    armJoints.elR = {x: armJoints.elR.x + outEl, y: armJoints.elR.y - upEl, z: armJoints.elR.z};
    const upH = 0.018 * n, sway = 0.016 * n;
    if (armJoints.wristL) armJoints.wristL = {x: armJoints.wristL.x - sway, y: armJoints.wristL.y - upH, z: armJoints.wristL.z};
    if (armJoints.wristR) armJoints.wristR = {x: armJoints.wristR.x + sway, y: armJoints.wristR.y - upH, z: armJoints.wristR.z};
    armJoints.handL = {x: armJoints.handL.x - sway * 1.15, y: armJoints.handL.y - upH * 1.1, z: armJoints.handL.z};
    armJoints.handR = {x: armJoints.handR.x + sway * 1.15, y: armJoints.handR.y - upH * 1.1, z: armJoints.handR.z};
  }
  shL = armJoints.shL; shR = armJoints.shR;
  elL = armJoints.elL; elR = armJoints.elR;
  wristL = armJoints.wristL; wristR = armJoints.wristR;
  handL = armJoints.handL; handR = armJoints.handR;
  let groin = {x: hipCx, y: groinY, z: fig8.z || 0};
  const crownY0 = crown && Number.isFinite(+crown.y) ? +crown.y : 0;
  const crownX0 = crown && Number.isFinite(+crown.x) ? +crown.x : hipCx;
  let heart = thoracic
    ? {x: thoracic.x, y: thoracic.y, z: thoracic.z || 0}
    : {
        x: groin.x + (crownX0 - groin.x) * HEART_S,
        y: groin.y + (crownY0 - groin.y) * HEART_S,
        z: (groin.z || 0) + ((((crown && Number.isFinite(+crown.z)) ? +crown.z : (fig8.z || 0)) - (groin.z || 0)) * HEART_S)
      };
  const jig = live ? jiggleState({tSec, strikes, side, frac, periodSec, hush: hushU, amount: JIGGLE, still: false}) : {gluteL: 0, gluteR: 0, thighL: 0, thighR: 0};
  const hipTwistAmt = hipTwist != null && Number.isFinite(+hipTwist) ? +hipTwist : HIP_TWIST;
  const shTwistAmt = shoulderTwist != null && Number.isFinite(+shoulderTwist) ? +shoulderTwist : SHOULDER_TWIST;
  const turnDeg = maxBodyTurn != null && Number.isFinite(+maxBodyTurn) ? +maxBodyTurn : MAX_BODY_TURN_DEG;
  const turnF = turnFreq != null && Number.isFinite(+turnFreq) ? +turnFreq : TURN_FREQ;
  let travel = {facing: 0, hipYaw: 0, shYaw: 0, shRel: 0, stepZ: 0};
  let look = {yaw: 0, tilt: 0, pitch: 0};
  let headYawAbs = 0;
  Object.assign(a, {elL, elR, flexL, flexR, groin, handL, handR, headYawAbs, heart, hipTwistAmt, jig, look, padArm, shL, shR, shTwistAmt, travel, turnDeg, turnF, wristL, wristR});
  return a;
}
export function poseFacing(a) {
  const activation = a.activation, armForward = a.armForward, clap = a.clap, clapOverhead = a.clapOverhead, clocked = a.clocked, famSpec = a.famSpec;
  const fig8 = a.fig8, fig8phase = a.fig8phase, flexL = a.flexL, flexR = a.flexR, flexT = a.flexT, fw = a.fw;
  const headLook = a.headLook, hipTwistAmt = a.hipTwistAmt, hushU = a.hushU, hz = a.hz, id = a.id, liftL = a.liftL;
  const liftR = a.liftR, live = a.live, padArm = a.padArm, pulseAmp = a.pulseAmp, pulseHz = a.pulseHz, rave = a.rave;
  const restU = a.restU, sh8 = a.sh8, shTwistAmt = a.shTwistAmt, side = a.side, songOpen = a.songOpen, steps = a.steps;
  const still = a.still, stomp = a.stomp, strikes = a.strikes, times = a.times, tSec = a.tSec, turnDeg = a.turnDeg;
  const turnF = a.turnF;
  let ankleL = a.ankleL, ankleR = a.ankleR, crown = a.crown, elL = a.elL, elR = a.elR, groin = a.groin;
  let handL = a.handL, handR = a.handR, head = a.head, headYawAbs = a.headYawAbs, heart = a.heart, heelL = a.heelL;
  let heelR = a.heelR, hipL = a.hipL, hipR = a.hipR, kneeL = a.kneeL, kneeR = a.kneeR, look = a.look;
  let lumbar = a.lumbar, neck = a.neck, pelvis = a.pelvis, shL = a.shL, shR = a.shR, thoracic = a.thoracic;
  let toeL = a.toeL, toeR = a.toeR, travel = a.travel, wristL = a.wristL, wristR = a.wristR;

  // Forward reach: the both-forward family (height from the lift) or an
  // explicit armForward (pre-drop build). Before yaw, so a turned dancer's
  // forward arms read as a side reach.
  // Frontal-plane arm joints carry no z; give them the shoulder's depth so
  // the body yaw below does not swing them off the body by the torso's z
  // offset (the side sim's "arms far behind the back" in profile, TJ Nov 11).
  {
    const zOf = (p, ref) => (p && !Number.isFinite(+p.z) ? {...p, z: (ref && +ref.z) || 0} : p);
    elL = zOf(elL, shL); wristL = zOf(wristL, elL); handL = zOf(handL, wristL);
    elR = zOf(elR, shR); wristR = zOf(wristR, elR); handR = zOf(handR, wristR);
  }
  // Clap (energy-motion.js): hands meet in front of the chest / overhead.
  const clapAmt = clamp(+clap || 0, 0, 1) * hushU;
  if (clapAmt > 0.001) {
    const cj = {shL, shR, elL, elR, wristL, wristR, handL, handR};
    applyClap(cj, clapAmt, clapOverhead);
    elL = cj.elL; elR = cj.elR; wristL = cj.wristL; wristR = cj.wristR; handL = cj.handL; handR = cj.handR;
  }
  const fwdAmt = clamp(Math.max(+armForward || 0, famSpec.forward ? flexT * famSpec.forward : 0), 0, 1) * (1 - restU) * hushU;
  if (fwdAmt > 0.001) {
    const aj = {shL, shR, elL, elR, wristL, wristR, handL, handR};
    applyArmForward(aj, fwdAmt, fwdAmt);
    elL = aj.elL; elR = aj.elR; wristL = aj.wristL; wristR = aj.wristR; handL = aj.handL; handR = aj.handR;
  }
  const pts = {head, neck, shL, shR, elL, elR, wristL, wristR, handL, handR, groin, crown, heart,
    pelvis, lumbar, thoracic, hipL, hipR, kneeL, kneeR, ankleL, ankleR, footL: toeL, footR: toeR, heelL, heelR};
  if (clocked) {
    travel = bodyTravelState({
      id, tSec, side, still, activation: +activation || 0, hush: hushU, stepHz: hz,
      hipTwist: hipTwistAmt, shoulderTwist: shTwistAmt, maxTurnDeg: turnDeg, turnFreq: turnF,
      phase: fig8phase, strikes, pulseAmp, pulseHz, times, footwork: fw, stomp,
      rave: rave ? {turnRad: songOpen === false ? 0 : rave.turnRad, stepF: rave.stepF, open: songOpen !== false} : null
    });
    if (rave) {
      // Hip sway over the weighted leg with a small contra twist in the ribs.
      const swayYaw = clamp(rave.hipSwayYaw, -HIP_YAW_LIM, HIP_YAW_LIM);
      travel = {...travel, hipYaw: clamp(travel.hipYaw + swayYaw, -HIP_YAW_LIM, HIP_YAW_LIM), shYaw: travel.shYaw + rave.shCounter};
      travel.shRel = travel.shYaw - travel.hipYaw;
    }
    const ball = side < 0 ? toeL : toeR;
    applyBodyYaw(pts, {
      originX: ball.x,
      originZ: ball.z || 0,
      facing: travel.facing,
      hipYaw: travel.hipYaw + (fig8.twist || 0),
      shYaw: travel.shYaw + (sh8.twist || 0) * 0.5,
      // Footwork plans place the feet themselves (depth included).
      stepZ: steps ? 0 : travel.stepZ, stepX: steps ? 0 : (travel.stepX || 0), liftL, liftR
    });
    // Keep the pelvis over the supporting foot in single support so a
    // figure-8 or twist cannot float the COM off the plant.
    const liftFreeNow = side < 0 ? liftR : liftL;
    if (liftFreeNow > 0.012 && pts.groin && (side < 0 ? pts.footL : pts.footR)) {
      const plant = side < 0 ? pts.footL : pts.footR;
      const gx = pts.groin.x - plant.x, gz = (pts.groin.z || 0) - (plant.z || 0);
      const r = Math.hypot(gx, gz);
      if (r > 0.032) {
        const s = (r - 0.032) / r;
        const dx = gx * s, dz = gz * s;
        for (const k of ['groin', 'hipL', 'hipR', 'heart', 'pelvis', 'lumbar', 'sacral', 'solar',
                         'neck', 'crown', 'head', 'throat', 'thirdEye', 'thoracic',
                         'shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) {
          if (pts[k]) { pts[k].x -= dx; pts[k].z = (pts[k].z || 0) - dz; }
        }
      }
    }
    // Head turns (side sim #100): skull, neck and crown follow the shoulders
    // and the body turns, plus a subtle independent look within ±30° of the
    // shoulders (shared head-look.js), calmer at rest.
    {
      const yHip = (travel.facing || 0) + (travel.hipYaw || 0) + (fig8.twist || 0);
      const ySh = (travel.facing || 0) + (travel.shYaw || 0) + (sh8.twist || 0) * 0.5;
      look = (live && headLook !== false) ? liveHeadLook({id, tSec, activation: +activation || 0, hush: hushU, bpm: hz * 60}) : {yaw: 0, tilt: 0, pitch: 0};
      const extra = (ySh - yHip) + (look.yaw || 0);
      const piv = pts.thoracic || pts.neck;
      if (piv && Math.abs(extra) > 1e-5) {
        for (const [k, f] of [['neck', 0.55], ['head', 1], ['crown', 1]]) {
          const p = pts[k];
          if (p && p !== piv) yawPoint(p, piv.x, extra * f, piv.z || 0);
        }
      }
      const lp = look.pitch || 0;
      if (lp && pts.neck) {
        const nk = pts.neck, c = Math.cos(lp), s = Math.sin(lp);
        for (const k of ['head', 'crown']) {
          const p = pts[k];
          if (!p) continue;
          const dy = p.y - nk.y, dz = (p.z || 0) - (nk.z || 0);
          p.y = nk.y + dy * c - dz * s;
          p.z = (nk.z || 0) + dy * s + dz * c;
        }
      }
      headYawAbs = yHip + extra;
    }
    head = pts.head; neck = pts.neck; shL = pts.shL; shR = pts.shR;
    elL = pts.elL; elR = pts.elR; wristL = pts.wristL; wristR = pts.wristR;
    handL = pts.handL; handR = pts.handR; groin = pts.groin; crown = pts.crown; heart = pts.heart;
    if (pts.pelvis) pelvis = pts.pelvis;
    if (pts.lumbar) lumbar = pts.lumbar;
    if (pts.thoracic) thoracic = pts.thoracic;
    hipL = pts.hipL; hipR = pts.hipR; kneeL = pts.kneeL; kneeR = pts.kneeR;
    ankleL = pts.ankleL; ankleR = pts.ankleR; toeL = pts.footL; toeR = pts.footR;
    heelL = pts.heelL; heelR = pts.heelR;
    kneeL = kneeIK(hipL, ankleL, THIGH, SHIN, -1, footForward(heelL, toeL));
    kneeR = kneeIK(hipR, ankleR, THIGH, SHIN, 1, footForward(heelR, toeR));
    const post = {elL, elR, wristL, wristR, handL, handR};
    capHandsLeadScreen(post, {flexT: Math.max(flexT, flexL, flexR), lead: padArm ? (padArm.lead || 0) : 0, minClear: 0.016});
    elL = post.elL; elR = post.elR; wristL = post.wristL; wristR = post.wristR; handL = post.handL; handR = post.handR;
  }
  Object.assign(a, {ankleL, ankleR, clapAmt, crown, elL, elR, fwdAmt, groin, handL, handR, head, headYawAbs, heart, heelL, heelR, hipL, hipR, kneeL, kneeR, look, lumbar, neck, pelvis, shL, shR, thoracic, toeL, toeR, travel, wristL, wristR});
  return a;
}
export function poseSettle(a) {
  const activation = a.activation, ankleL = a.ankleL, ankleR = a.ankleR, armFamily = a.armFamily, armForward = a.armForward, armLift = a.armLift;
  const armPadSense = a.armPadSense, armSwellLift = a.armSwellLift, b = a.b, band = a.band, beat = a.beat, bpmEst = a.bpmEst;
  const clap = a.clap, clapAmt = a.clapAmt, clapOverhead = a.clapOverhead, clocked = a.clocked, collect = a.collect, contactL = a.contactL;
  const contactR = a.contactR, crown = a.crown, dynamics = a.dynamics, ease = a.ease, eightDbl = a.eightDbl, eightRate = a.eightRate;
  const elevT = a.elevT, elL = a.elL, elR = a.elR, family = a.family, fig8 = a.fig8, flexT = a.flexT;
  const fwdAmt = a.fwdAmt, give = a.give, groin = a.groin, groove = a.groove, gv = a.gv, handL = a.handL;
  const handR = a.handR, head = a.head, headYawAbs = a.headYawAbs, heelL = a.heelL, heelR = a.heelR, hipAccent = a.hipAccent;
  const hipL = a.hipL, hipR = a.hipR, hush = a.hush, hushU = a.hushU, id = a.id, jig = a.jig;
  const jump = a.jump, kneeL = a.kneeL, kneeR = a.kneeR, lift = a.lift, liftL = a.liftL, liftR = a.liftR;
  const live = a.live, look = a.look, lumbar = a.lumbar, neck = a.neck, padArm = a.padArm, padFeatures = a.padFeatures;
  const pelvis = a.pelvis, phrase = a.phrase, pulseAmp = a.pulseAmp, pulseHz = a.pulseHz, raise = a.raise, raiseBody = a.raiseBody;
  const rave = a.rave, raveFade = a.raveFade, restU = a.restU, sh8 = a.sh8, shL = a.shL, shR = a.shR;
  const side = a.side, sp = a.sp, squat = a.squat, stanceW = a.stanceW, stepHz = a.stepHz, steps = a.steps;
  const still = a.still, stomp = a.stomp, strikes = a.strikes, swing = a.swing, tall = a.tall, tallU = a.tallU;
  const thoracic = a.thoracic, times = a.times, toeL = a.toeL, toeR = a.toeR, travel = a.travel, tSec = a.tSec;
  const w = a.w, weight = a.weight, wristL = a.wristL, wristR = a.wristR;
  let heart = a.heart;

  const solarS = SOLAR_S;
  const solarCrown = crown || {x: heart.x, y: (heart.y || Y_HEART) - Y_HEART, z: heart.z || 0};
  const solar = lumbar
    ? {x: lumbar.x, y: lumbar.y, z: lumbar.z || 0}
    : {
        x: groin.x + (solarCrown.x - groin.x) * solarS,
        y: groin.y + (solarCrown.y - groin.y) * solarS,
        z: (groin.z || 0) + (((solarCrown.z || 0) - (groin.z || 0)) * solarS)
      };
  if (thoracic) heart = {x: thoracic.x, y: thoracic.y, z: thoracic.z || 0};
  // Stack before yaw so a shear from leanTilt / crown interpolation cannot kink the chest.
  stackTorsoSpine({groin, heart, solar, neck, head, crown});
  if (live && neck && head) {
    const nf = neckStringFollow({id, tSec, strikes, pulseAmp, pulseHz, times, activation: +activation || 0, hush: hushU, still});
    if (nf && (nf.tilt || nf.turn)) {
      const up = Math.max(1e-6, (neck.y - head.y));
      const dx = Math.sin(nf.turn || 0) * up;
      const dz = Math.sin(nf.tilt || 0) * up;
      for (const p of [head, crown]) {
        if (!p) continue;
        p.x += dx;
        p.z = (p.z || 0) + dz;
      }
    }
  }
  const unit = {b, head, neck, shL, shR, elL, elR, wristL, wristR, handL, handR, groin, crown, heart, solar,
    pelvis, lumbar, thoracic,
    hipL, hipR, kneeL, kneeR, ankleL, ankleR, footL: toeL, footR: toeR, heelL, heelR,
    liftL, liftR, give, raise, raiseBody, flexT, elevT, tall: tallU, restU, stanceW, stanceSh: stanceW / (b.shW || 0.125),
    stanceHip: stanceW / (b.hipW || 0.09),
    armFamily: family, armForward: fwdAmt, clap: clapAmt, contactL, contactR, jiggle: jig, stomp, spine: sp, pad: padArm,
    twist: {facing: travel.facing, hipYaw: travel.hipYaw, shYaw: travel.shYaw, shRel: travel.shRel, hipEightZ: fig8.z || 0, shEightZ: sh8.z || 0, headYaw: headYawAbs},
    headYaw: headYawAbs, headYawRel: look.yaw || 0, headTilt: look.tilt || 0,
    footwork: steps ? {step: steps.step, label: steps.label, tier: steps.tier, kind: steps.kind, tapL: !!steps.tap.L, tapR: !!steps.tap.R, weightSide: steps.weightSide} : null,
    rave: rave ? {locomotor: rave.locomotor, label: rave.label, amount: rave.amount, bounce: rave.bounce, nod: rave.nod, hipSwayX: rave.hipSwayX, jack: rave.jackPhi.thoracic || 0, wave: rave.wavePhi.thoracic || 0, contactL: rave.footL.contact, contactR: rave.footR.contact, kickLift: rave.kickLift, turnRad: rave.turnRad, stepF: rave.stepF} : null};
  if (clocked && dynamics !== false) {
    // Clamp the TARGET first so the springs ease to a legal pose; a clamp
    // applied after smoothing would jump the arms in a single frame.
    if (!armBackLimitOff()) limitArmsBehindHead(unit, b.headR || 0.066);
    delete unit.armBackMoved;
    smoothPoseJoints(id, unit, {groove: gv.amt, tSec, still, hush: hushU, side, liftL, liftR, contactL, contactR, enabled: true, bpm: bpmEst, followBalls: !!steps});
    unit.kneeL = kneeIK(unit.hipL, unit.ankleL, THIGH, SHIN, -1, kneeForwardOf(unit, 'L'));
    unit.kneeR = kneeIK(unit.hipR, unit.ankleR, THIGH, SHIN, 1, kneeForwardOf(unit, 'R'));
  }
  // The loaded hip follows the plan's weight, not the floor-pin side (the
  // pin stays put through a double-support shift so the head does not pop).
  groundPose(unit, b, (steps && Math.abs(w) > 0.05) ? (w < 0 ? -1 : 1) : side, {load: Math.abs(+weight || 0) * (1 - restU) * 0.8, sway: 0});

  // Re-solve the knees after the pelvis is settled so a stance wider than the
  // new hip joints cannot stretch a stale thigh past its bone length.
  unit.kneeL = kneeIK(unit.hipL, unit.ankleL, THIGH, SHIN, -1, kneeForwardOf(unit, 'L'));
  unit.kneeR = kneeIK(unit.hipR, unit.ankleR, THIGH, SHIN, 1, kneeForwardOf(unit, 'R'));
  stackTorsoSpine(unit);
  capRestUpright(unit, {activation: Math.max(+activation || 0, unit.raiseBody != null ? +unit.raiseBody : +unit.raise || 0, +tall || 0)});
  if (!boundPose(unit, b, side)) {
    // TJ 10:14 AM "absurd leg extensions / freezing": a non-finite or
    // runaway pose resets this dancer's physics and falls back to the static
    // pose instead of drawing lines across the stage.
    resetBodyDynamics(id);
    resetTravel(id);
    resetSpineFlex(id);
    if (clocked) return skeletonPose({groove, squat, id, band, weight, ease, side, swing, lift, armLift, jump, tall, armFamily, phrase, activation, hush, still, beat, stepHz, collect, dynamics: false, padFeatures, armPadSense, armForward, armSwellLift, eightDbl, hipAccent, clap, clapOverhead, eightRate, bpm: bpmEst, raveFade});
  }
  enforceLegReach(unit);

  if (unit.hipL && unit.ankleL) unit.kneeL = kneeIK(unit.hipL, unit.ankleL, THIGH, SHIN, -1, kneeForwardOf(unit, 'L'));
  if (unit.hipR && unit.ankleR) unit.kneeR = kneeIK(unit.hipR, unit.ankleR, THIGH, SHIN, 1, kneeForwardOf(unit, 'R'));
  lockPoseBones(unit);
  if (unit.thoracic) unit.heart = {x: unit.thoracic.x, y: unit.thoracic.y, z: unit.thoracic.z || 0};
  if (unit.lumbar) unit.solar = {x: unit.lumbar.x, y: unit.lumbar.y, z: unit.lumbar.z || 0};
  // lockPoseBones can nudge the head/heart a hair and push poseCom just
  // outside the support window (the unit COM test is tight to 1e-6).
  const sup = supportRange(unit);
  if (sup) {
    const com = poseCom(unit);
    const dx = com < sup.min ? sup.min - com : com > sup.max ? sup.max - com : 0;
    if (dx) {
      for (const k of upperKeys(unit)) {
        const p = unit[k];
        if (p && Number.isFinite(+p.x)) p.x += dx;
      }
    }
  }
  // Rear arm limit (TJ Nov 11 5:46 PM): elbows / wrists / hands never pass
  // just behind the back of the head, whatever arm move produced them.
  if (!armBackLimitOff()) limitArmsBehindHead(unit, b.headR || 0.066);
  delete unit.armBackMoved;
  if (clocked && dynamics !== false) commitDynJoints(id, unit);
  return unit;

}

export function skeletonPose({groove = null, squat = 0, id = 0, band = 0, weight = 0, ease = 0, side = -1, swing = null, lift = 0, armLift = 0, jump = 0, tall = 0, armFamily = DEFAULT_ARM_FAMILY, phrase = 0, activation = null, now = null, periodMs = 0, armForward = 0, armSwellLift = 0, eightDbl = 0, hipAccent = 0, clap = 0, clapOverhead = 0, strikes = null, pulseAmp = 0, pulseHz = 0.9, times = null, hush = 1, still = false, beat = 0, stepHz = 0, hipEight = null, shoulderEight = null, hipTwist = null, shoulderTwist = null, maxBodyTurn = null, turnFreq = null, eightDepth = null, eightVert = null, stanceLock = null, collect = false, dynamics = true, padFeatures = null, armPadSense = 1, eightRate = null, bpm = 0, raveMoves = RAVE_LIVE_DEFAULT, bandLevels = null, headLook = true, songOpen = true, raveFade = null} = {}) {
  const a = {groove, squat, id, band, weight, ease, side, swing, lift, armLift, jump, tall, armFamily, phrase, activation, now, periodMs, armForward, armSwellLift, eightDbl, hipAccent, clap, clapOverhead, strikes, pulseAmp, pulseHz, times, hush, still, beat, stepHz, hipEight, shoulderEight, hipTwist, shoulderTwist, maxBodyTurn, turnFreq, eightDepth, eightVert, stanceLock, collect, dynamics, padFeatures, armPadSense, eightRate, bpm, raveMoves, bandLevels, headLook, songOpen, raveFade};
  poseClockAndFeet(a);
  poseSupportAndSpine(a);
  poseArms(a);
  poseFacing(a);
  return poseSettle(a);
}

const POSE_KEYS = ['head', 'neck', 'shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR', 'groin', 'crown', 'heart', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'footL', 'footR', 'heelL', 'heelR'];
const FOOT_GROUP = {L: ['footL', 'heelL', 'ankleL'], R: ['footR', 'heelR', 'ankleR']};
// Bottom-up support (TJ 10:41 AM "marionettes held up from the waist"):
// planted feet first, then the legs carry the pelvis. The upper body (pelvis,
// spine, arms, head) rides as one block: it is lowered until every planted
// leg reaches its foot with at least the soft micro-bend, never hanging
// straight or stretched, and slid so the centre of mass stays over the
// support foot/feet. The loaded leg's hip drops a little (that knee bends more).
export const COM_MARGIN = 0.012;  // height units beyond the support feet
export const LOAD_HIP_DROP = 0.012;
// Every joint that rides on the pelvis (all but the legs), including the
// jointed-spine nodes (pelvis, lumbar, sacral, solar, thoracic, throat,
// thirdEye) so the body and its chakra string never come apart (TJ 11:44 AM).
const LEG_KEY = /^(knee|ankle|foot|heel|toe)[LR]$/;
export function upperKeys(pose) {
  const out = [];
  for (const k of Object.keys(pose || {})) { const p = pose[k]; if (!LEG_KEY.test(k) && p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push(k); }
  return out;
}
const UPPER_KEYS = ['head', 'neck', 'shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR', 'groin', 'crown', 'heart', 'hipL', 'hipR'];
void UPPER_KEYS;
export function poseCom(unit) {
  const hm = (unit.hipL.x + unit.hipR.x) / 2;
  const chest = unit.heart ? unit.heart.x : hm, head = unit.head ? unit.head.x : chest;
  return 0.55 * hm + 0.33 * chest + 0.12 * head;
}
export function supportRange(unit) {
  const xs = [];
  for (const s of ['L', 'R']) {
    if ((+unit['lift' + s] || 0) > 0.001) continue;
    for (const k of ['foot' + s, 'heel' + s]) if (unit[k] && Number.isFinite(unit[k].x)) xs.push(unit[k].x);
  }
  if (!xs.length) return null;
  return {min: Math.min(...xs) - COM_MARGIN, max: Math.max(...xs) + COM_MARGIN};
}
export function groundPose(unit, b, side = 0, {load = 0, sway = 0} = {}) {
  if (!unit || !unit.hipL || !unit.hipR || !unit.ankleL || !unit.ankleR) return unit;
  const keys = upperKeys(unit);
  const move = (dx, dy, dz = 0) => { for (const k of keys) { const p = unit[k]; p.x += dx; p.y += dy; if (dz) p.z = (p.z || 0) + dz; } };
  // Weight shift loads the stance leg: its hip drops over it.
  const ld = Math.max(0, Math.min(1, +load || 0));
  if (ld > 0 && side) { const h = unit[side < 0 ? 'hipL' : 'hipR']; if (h) h.y += LOAD_HIP_DROP * ld; }
  // Idle-groove sway: the body rides side to side over planted feet.
  if (sway) move(+sway || 0, 0);
  // COM over the support.
  const sup = supportRange(unit);
  if (sup) {
    const com = poseCom(unit);
    if (com < sup.min) move(sup.min - com, 0); else if (com > sup.max) move(sup.max - com, 0);
  }
  // Legs carry the pelvis: lower it until each planted leg has its soft bend.
  const maxSpan = legSpanLimits(THIGH, SHIN).max;
  let dy = 0;
  for (const s of ['L', 'R']) {
    if ((+unit['lift' + s] || 0) > 0.001 && sup) continue;
    const hp = unit['hip' + s], an = unit['ankle' + s];
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0), ey = an.y - (hp.y + dy);
    const r2 = maxSpan * maxSpan - ex * ex - ez * ez;
    const need = r2 > 0 ? Math.sqrt(r2) : 0;
    if (ey > need) dy += ey - need;
  }
  // ...and raise it if a leg is folded past the deepest squat (knee angle floor).
  const minSpan = legSpanLimits(THIGH, SHIN).min + 1e-4;
  let up = 0;
  for (const s of ['L', 'R']) {
    const hp = unit['hip' + s], an = unit['ankle' + s];
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0), ey = an.y - (hp.y + dy - up);
    const r2 = minSpan * minSpan - ex * ex - ez * ez;
    if (r2 > 0 && ey < Math.sqrt(r2)) up += Math.sqrt(r2) - ey;
  }
  dy -= up;
  if (dy) move(0, dy);
  // If a planted foot is already farther in xz than the bones allow, dropping
  // the pelvis cannot close the gap. Pull the hips over the foot and leave
  // the planted contact where it is (mirrors rebalancePosed).
  for (const s of ['L', 'R']) {
    if ((+unit['lift' + s] || 0) > 0.001 && sup) continue;
    const hp = unit['hip' + s], an = unit['ankle' + s];
    if (!hp || !an) continue;
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0);
    const horiz = Math.hypot(ex, ez);
    if (horiz > maxSpan) {
      const k = (horiz - maxSpan) / horiz;
      move(ex * k, 0, ez * k);
    }
  }
  unit.groundDy = dy;
  return unit;
}
export const STANCE_DEPTH_MAX = 0.22; // foot depth from the pelvis (height units)
// Keeps a unit pose physical: every joint finite and near the body, feet
// within STANCE_SH_MAX shoulder widths of each other (and of the pelvis), a
// bounded depth step, and each ankle within leg reach of its hip so the
// fixed thigh/shin lengths hold. Returns false when the pose is unusable.
export function boundPose(unit, b, side = 0) {
  const planted = side < 0 ? 'L' : side > 0 ? 'R' : null;
  if (!unit) return false;
  for (const k of POSE_KEYS) {
    const p = unit[k];
    if (!p) continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.z != null && !Number.isFinite(p.z))) return false;
    if (Math.abs(p.x) > 3 || p.y < -2 || p.y > 3 || Math.abs(p.z || 0) > 3) return false;
  }
  const g = unit.groin;
  if (!g || !unit.footL || !unit.footR) return true;
  const sh = (b && b.shW) || 0.125;
  const maxHalf = STANCE_SH_MAX * sh;
  const shift = (side, dx, dz) => { for (const k of FOOT_GROUP[side]) if (unit[k]) { unit[k].x += dx; if (dz) unit[k].z = (unit[k].z || 0) + dz; } };
  const mid = side => { const t = unit['foot' + side], h = unit['heel' + side]; return h ? (t.x + h.x) / 2 : t.x; };
  // Lateral span between the feet (foot centres).
  const span = mid('R') - mid('L');
  if (Math.abs(span) > 2 * maxHalf) {
    const excess = (Math.abs(span) - 2 * maxHalf) * Math.sign(span);
    // Move the lifted (or the farther) foot in; the planted contact is the
    // world anchor, so moving the other foot never slides the plant.
    const moveL = planted ? planted === 'R' : (unit.liftL || 0) > (unit.liftR || 0);
    if (moveL) shift('L', excess, 0); else shift('R', -excess, 0);
  }
  // Foot-centre span bounds (TJ 10:30): >= STANCE_HIP_MIN hip widths always,
  // REST_HIP_SEP at rest. Toes turn out, so the foot centre sits inside the
  // ankle line; measure the centres. Only the free foot moves here; in the
  // world it is held on the floor (holdGroundedFoot) and steps over.
  {
    const hw = hipWidth(b);
    const span2 = mid('R') - mid('L');
    const ru = Math.max(0, Math.min(1, +unit.restU || 0));
    let want = Math.max(STANCE_HIP_MIN * hw, span2);
    if (ru > 0) want = Math.max(STANCE_HIP_MIN * hw, want + (REST_HIP_SEP * hw - want) * ru);
    want = Math.min(2 * maxHalf, want);
    const need = want - span2;
    if (Math.abs(need) > 1e-6) {
      if (planted === 'L') shift('R', need, 0);
      else if (planted === 'R') shift('L', -need, 0);
      else { shift('R', need / 2, 0); shift('L', -need / 2, 0); }
    }
  }
  for (const side of ['L', 'R']) {
    // The planted contact is the world anchor: never move it (no slide).
    if (side === planted) continue;
    const dx = mid(side) - g.x;
    if (Math.abs(dx) > maxHalf * 1.25) shift(side, (Math.sign(dx) * maxHalf * 1.25) - dx, 0);
    const f = unit['foot' + side];
    const dz = (f.z || 0) - (g.z || 0);
    if (Math.abs(dz) > STANCE_DEPTH_MAX) shift(side, 0, Math.sign(dz) * STANCE_DEPTH_MAX - dz);
    const hip = unit['hip' + side], ank = unit['ankle' + side];
    if (hip && ank) {
      const reach = (THIGH + SHIN) * 0.985;
      const ax = ank.x - hip.x, ay = ank.y - hip.y, az = (ank.z || 0) - (hip.z || 0);
      const d = Math.hypot(ax, ay, az);
      if (d > reach) {
        // Pull the foot in xz. A foot that is on the floor must stay on the
        // floor (low-act weight shifts keep both down); the pelvis is lowered
        // by groundPose / rebalancePosed if the bones are still short.
        const k = reach / d;
        shift(side, hip.x + ax * k - ank.x, (hip.z || 0) + az * k - (ank.z || 0));
        if ((+unit['lift' + side] || 0) > 0.001) {
          const dy = hip.y + ay * k - ank.y;
          for (const kk of FOOT_GROUP[side]) if (unit[kk]) unit[kk].y += dy;
        }
      }
    }
  }
  unit.kneeL = kneeIK(unit.hipL, unit.ankleL, THIGH, SHIN, -1, kneeForwardOf(unit, 'L'));
  unit.kneeR = kneeIK(unit.hipR, unit.ankleR, THIGH, SHIN, 1, kneeForwardOf(unit, 'R'));
  const fl = unit.footL, fr = unit.footR;
  unit.stanceSpanSh = Math.abs(mid('R') - mid('L')) / (2 * sh);
  return Number.isFinite(fl.x + fr.x + unit.kneeL.x + unit.kneeR.x);
}


// Unit pose → stage px: center x, top y (crown), height.
export function placePose(unit, cx, top, height) {
  const out = {b: unit.b, height};
  for (const k of Object.keys(unit)) {
    if (k === 'b') continue;
    const p = unit[k];
    if (!p || typeof p !== 'object' || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) {
      out[k] = p;
      continue;
    }
    const q = {x: cx + p.x * height, y: top + p.y * height};
    if (Number.isFinite(+p.z)) q.z = p.z * height;
    out[k] = q;
  }
  return out;
}

// Arm path (heart → shoulder → elbow → wrist → fingertips), stage px.
// Inner pulse lights for the volumetric body (TJ 1:51 PM), in pose space:
// the leg pulse climbing foot -> knee -> groin, the arm beads, and the string
// pulse as a torso-wide glow in the chakra colour where it is.
export function bodyPulseLights(pose, {legSide = 0, legU = -1, armU = -1, travelS = -1, chakraS = null, hueAt = null, energy = 1} = {}) {
  const out = {pulses: [], torso: null};
  if (!pose || !pose.groin) return out;
  const e = Math.max(0.35, Math.min(1, +energy || 0));
  if (legU >= 0 && legU <= 1) {
    const foot = legSide >= 0 ? pose.footR : pose.footL, knee = legSide >= 0 ? pose.kneeR : pose.kneeL;
    if (foot && knee) {
      const a = legU < 0.5 ? foot : knee, b = legU < 0.5 ? knee : pose.groin, t = legU < 0.5 ? legU * 2 : (legU - 0.5) * 2;
      out.pulses.push({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, hue: 8, a: 0.85 * e});
    }
  }
  if (armU >= 0 && armU <= 1) {
    for (const side of [-1, 1]) {
      const at = pointAlong(armPath(pose, side), armU);
      if (at) out.pulses.push({x: at.x, y: at.y, hue: 120, a: 1.0 * e * (1 - 0.35 * armU), r: 0.1});
    }
  }
  if (travelS >= 0 && pose.crown) {
    const s = chakraS == null ? travelS : chakraS;
    const u = Math.max(0, Math.min(1, s));
    const x = pose.groin.x + (pose.crown.x - pose.groin.x) * u, y = pose.groin.y + (pose.crown.y - pose.groin.y) * u;
    const hue = typeof hueAt === 'function' ? hueAt(u) : 0;
    out.torso = {x, y, hue, a: 0.7 * e};
    out.pulses.push({x, y, hue, a: 0.9 * e, r: 0.07});
  }
  return out;
}
export function armPath(pose, side) {
  return side < 0
    ? [pose.heart, pose.shL, pose.elL, pose.wristL, pose.handL]
    : [pose.heart, pose.shR, pose.elR, pose.wristR, pose.handR];
}

export function pointAlong(pts, u) {
  if (!pts || pts.length < 2) return null;
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seg.push(l); total += l; }
  let d = clamp(+u || 0, 0, 1) * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? clamp(d / seg[i], 0, 1) : 0;
      return {x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t};
    }
    d -= seg[i];
  }
  return pts[pts.length - 1];
}


function mapPosePoint(pose, map, k) {
  const jig = pose.jiggle || {};
  const jH = pose.height > 0 ? pose.height : 1;
  let dx = 0, dy = 0;
  if (k === 'hipL') { dx = -(jig.gluteL || 0) * jH - (jig.thighL || 0) * jH * 0.55; dy = (jig.gluteL || 0) * jH * 0.22; }
  else if (k === 'hipR') { dx = (jig.gluteR || 0) * jH + (jig.thighR || 0) * jH * 0.55; dy = (jig.gluteR || 0) * jH * 0.22; }
  else if (k === 'groin') dy = ((jig.gluteL || 0) + (jig.gluteR || 0)) * 0.35 * jH;
  return map(pose[k].x + dx, pose[k].y + dy);
}

// Dark articulated figure. xy maps stage px → screen px; scale = screen/stage.
// Stub canvases in tests may lack arc(); fall back to a 12-gon.
function circle(ctx, x, y, r) {
  if (typeof ctx.arc === 'function') { ctx.arc(x, y, r, 0, Math.PI * 2); return; }
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    if (i === 0) ctx.moveTo(x + r, y); else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
}

export const VOLUME_FILL_CHEAP = 'rgba(150, 172, 220, 0.16)';
export const VOLUME_CORE_CHEAP = 'rgba(176, 196, 236, 0.16)';
export const VOLUME_RIM_CHEAP = 'rgba(196, 214, 248, 0.5)';
export function paintShadowFigure(ctx, pose, xy, options = {}) {
  if (!ctx || !pose || typeof ctx.beginPath !== 'function') return false;
  const map = typeof xy === 'function' ? xy : (x, y) => ({x, y});
  const scale = Number.isFinite(+options.scale) && +options.scale > 0 ? +options.scale : 1;
  const P = k => {
    const p = mapPosePoint(pose, map, k);
    if (p && pose[k] && Number.isFinite(+pose[k].z)) p.z = +pose[k].z * scale;
    else if (p) p.z = 0;
    return p;
  };
  const lw = Math.max(1.6, pose.b.limb * pose.height * scale);
  const alpha = Number.isFinite(+options.alpha) ? clamp(+options.alpha, 0, 1) : 1;
  const twist = pose.twist || {};
  const facing = +twist.facing || 0;
  const yawSh = facing + (+twist.shYaw || 0);
  const yawHip = facing + (+twist.hipYaw || 0);
  const hPx = (pose.height || 80) * scale;
  const shHalf = (pose.b.shW || 0.125) * hPx;
  const hipHalf = (pose.b.hipW || 0.09) * hPx;
  const shExt = yawExtent(shHalf, TORSO_CHEST_DEPTH * shHalf, yawSh);
  const hipExt = yawExtent(hipHalf, 0.70 * hipHalf, yawHip);
  const lod = options.lod === 'full' ? 'full' : 'cheap';
  // Full LOD uses the shared sim shell (body-shell.js) so live and the official
  // sim cannot drift. Cheap LOD (small seed sims) uses drawVolumeBodyLite, the
  // same see-through outline without the per-limb passes (24-sim iPhone 13
  // budget). Floor-shadow / rim masks keep the stroke capsules.
  const placeAll = () => {
    const placed = {b: pose.b, height: (pose.height || 80) * scale, twist: pose.twist, jiggle: pose.jiggle};
    for (const k of Object.keys(pose)) {
      if (k === 'b' || k === 'height' || k === 'twist' || k === 'jiggle' || k === 'pad' || k === 'spine') continue;
      const p = pose[k];
      if (!p || typeof p !== 'object' || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
      const q = map(p.x, p.y);
      placed[k] = {x: q.x, y: q.y};
      if (Number.isFinite(+p.z)) placed[k].z = +p.z * scale;
    }
    // Head turns with the shoulders + its own look (side sim #100): the
    // projected head width follows the head's yaw, identical at yaw 0.
    const hYaw = Number.isFinite(+pose.headYaw) ? +pose.headYaw : (+twist.facing || 0);
    const hr = (pose.b && +pose.b.headR > 0 ? +pose.b.headR : 0.066) * placed.height;
    placed.headR = hr;
    placed.headRx = Math.max(hr * 0.42, yawExtent(hr * 0.86, hr * 0.95, hYaw));
    placed.headYaw = hYaw;
    placed.headTilt = +pose.headTilt || 0;
    return placed;
  };
  // Visible inner bones (side sim #98 / #100), clipped to the body shell.
  // Quality toggle: 'stage' paints full-LOD figures only (default), 'all'
  // also the small cheap-LOD seed sims, false / 'off' never (iPhone 13).
  const bonesMode = options.bones === true ? 'stage' : (options.bones === 'all' || options.bones === 'stage' ? options.bones : 'off');
  const paintBones = (placed, pulses) => {
    if (bonesMode === 'off' || (bonesMode === 'stage' && lod !== 'full')) return;
    try {
      ctx.save();
      ctx.globalAlpha = alpha;
      if (typeof ctx.clip === 'function') { ctx.beginPath(); traceBody(ctx, placed); ctx.clip(); }
      const bonePose = {...placed, spine: {pelvis: placed.pelvis, lumbar: placed.lumbar, thoracic: placed.thoracic}};
      const bonePulses = Array.isArray(pulses) ? pulses.filter(Boolean).map(q => ({x: q.x, y: q.y, hue: q.hue, strength: q.a != null ? q.a : (q.strength || 0)})) : [];
      const n = paintInnerBones(ctx, bonePose, {pulses: bonePulses});
      if (options.stats && typeof options.stats === 'object') options.stats.bones = (options.stats.bones || 0) + (n || 0);
    } catch { /* bones are decorative; never drop the body */ }
    ctx.restore();
  };
  const mapLightAll = L => { if (!L || !Number.isFinite(+L.x) || !Number.isFinite(+L.y)) return null; const q = map(+L.x, +L.y); return {...L, x: q.x, y: q.y}; };
  // Cheap LOD (small seed sims) keeps the see-through anatomical body via the
  // lite shell instead of stroke capsules, which read as stick figures (TJ
  // Nov 11 3:13 PM). Mask passes (shadow / rim set) keep the capsules.
  if (lod === 'cheap' && options.volume && options.shade !== false && options.shadow == null && options.rim == null) {
    let ok = false;
    ctx.save();
    ctx.globalAlpha = alpha;
    const placedLite = placeAll();
    const litePulses = Array.isArray(options.pulses) ? options.pulses.map(mapLightAll) : null;
    try {
      ok = drawVolumeBodyLite(ctx, placedLite, {glow: options.glow,
        pulses: litePulses, torso: options.torso ? mapLightAll(options.torso) : null});
    } catch { ok = false; }
    ctx.restore();
    if (ok) { paintBones(placedLite, litePulses); return true; }
  }
  if (lod === 'full' && options.shade !== false && options.shadow == null && options.rim == null) {
    const placed = placeAll();
    let painted = false;
    let fullPulses = null;
    ctx.save();
    ctx.globalAlpha = alpha;
    try {
      const mapLight = L => { if (!L || !Number.isFinite(+L.x) || !Number.isFinite(+L.y)) return null; const q = map(+L.x, +L.y); return {...L, x: q.x, y: q.y}; };
      fullPulses = Array.isArray(options.pulses) ? options.pulses.map(mapLight) : null;
      drawShadowFigure(ctx, placed, {weight: options.weight, skipBloom: true, lod: 'full', glow: options.glow, flash: options.flash, shellGlow: options.shellGlow,
        volume: !!options.volume, pulses: fullPulses, torso: options.torso ? mapLight(options.torso) : null});
      painted = true;
    } catch (err) {
      painted = false;
    }
    ctx.restore();
    if (painted) {
      paintBones(placed, fullPulses);
      // Stick skeleton is opt-in. Defaulting it on made idle / low-activation
      // live dancers read as the old stick figures (boxy torso, thin limbs)
      // because the volume tint is quiet at rest and the lines took over.
      if (options.skeleton) {
        paintSkeletonLines(ctx, placed, (x, y) => ({x, y}), {height: placed.height, ...(typeof options.skeleton === 'object' ? options.skeleton : {})});
      }
      return true;
    }
  }
  // Volume silhouette: projected ellipsoid half-width so a 90° profile keeps
  // chest/pelvis depth instead of collapsing to a line (TJ 8:40 PM).
  const torso = () => {
    const shL = P('shL'), shR = P('shR'), neck = P('neck'), hipR = P('hipR'), hipL = P('hipL'), groin = P('groin');
    const midShX = (shL.x + shR.x) * 0.5;
    const midHipX = (hipL.x + hipR.x) * 0.5;
    const sL = {x: midShX - shExt, y: shL.y}, sR = {x: midShX + shExt, y: shR.y};
    const hL = {x: midHipX - hipExt, y: hipL.y}, hR = {x: midHipX + hipExt, y: hipR.y};
    const quad = (a, c, b, t) => ({x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y});
    const yoke = {x: neck.x, y: neck.y + lw * 1.2};
    const seat = {x: groin.x, y: groin.y + lw};
    ctx.beginPath();
    if (lod === 'full') {
      // Volumetric chest / pelvis ellipsoids (side-sim torsoStations): width is
      // the projected ellipse at the current yaw so a 90° profile keeps depth.
      const chestHalfD = TORSO_CHEST_DEPTH * shHalf;
      const pelvisHalfD = 0.70 * hipHalf;
      const chestY = sL.y * 0.55 + neck.y * 0.45;
      const waistY = sL.y * 0.35 + hL.y * 0.65;
      const chestExt = yawExtent((pose.b.chestW || TORSO_CHEST_W) * hPx, chestHalfD, yawSh);
      const waistExt = yawExtent((pose.b.waistW || 0.068) * hPx, 0.55 * shHalf, yawHip);
      const fwdSh = rotateFacing(0, TORSO_CHEST_Z * shHalf, yawSh);
      const backHip = rotateFacing(0, TORSO_HIP_Z * hipHalf, yawHip);
      const backSeat = rotateFacing(0, TORSO_SEAT_Z * hipHalf, yawHip);
      const cL = {x: midShX + fwdSh.x - chestExt, y: chestY}, cR = {x: midShX + fwdSh.x + chestExt, y: chestY};
      const wL = {x: midHipX - waistExt, y: waistY}, wR = {x: midHipX + waistExt, y: waistY};
      const hLv = {x: midHipX + backHip.x - hipExt, y: hL.y}, hRv = {x: midHipX + backHip.x + hipExt, y: hR.y};
      const seatV = {x: seat.x + backSeat.x, y: seat.y};
      ctx.moveTo(sL.x, sL.y);
      for (let i = 1; i <= 4; i++) { const p = quad(sL, yoke, sR, i / 4); ctx.lineTo(p.x, p.y); }
      ctx.lineTo(cR.x, cR.y);
      ctx.lineTo(wR.x, wR.y);
      ctx.lineTo(hRv.x, hRv.y);
      for (let i = 1; i <= 4; i++) { const p = quad(hRv, seatV, hLv, i / 4); ctx.lineTo(p.x, p.y); }
      ctx.lineTo(wL.x, wL.y);
      ctx.lineTo(cL.x, cL.y);
    } else {
      ctx.moveTo(sL.x, sL.y);
      for (let i = 1; i <= 5; i++) { const p = quad(sL, yoke, sR, i / 5); ctx.lineTo(p.x, p.y); }
      ctx.lineTo(hR.x, hR.y);
      for (let i = 1; i <= 5; i++) { const p = quad(hR, seat, hL, i / 5); ctx.lineTo(p.x, p.y); }
    }
    ctx.closePath();
  };

  const limbs = (widthMul) => {
    const thick = (base) => Math.max(1.1, yawExtent(base, base * 0.55, facing));
    const seg = (keys, w) => {
      ctx.lineWidth = thick(w);
      ctx.beginPath();
      const a = P(keys[0]);
      ctx.moveTo(a.x, a.y);
      for (let i = 1; i < keys.length; i++) { const p = P(keys[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
    };
    const leftFirst = facing <= 0; // positive yaw: left side toward camera
    const armL = () => seg(['shL', 'elL', 'wristL', 'handL'], lw * 0.66 * widthMul);
    const armR = () => seg(['shR', 'elR', 'wristR', 'handR'], lw * 0.66 * widthMul);
    const legL = () => seg(['hipL', 'kneeL', 'ankleL', 'footL'], lw * widthMul);
    const legR = () => seg(['hipR', 'kneeR', 'ankleR', 'footR'], lw * widthMul);
    if (leftFirst) { armR(); legR(); armL(); legL(); }
    else { armL(); legL(); armR(); legR(); }
    seg(['neck', 'head'], lw * 0.7 * widthMul);
  };
  const head = P('head');
  const headR = Math.max(2, pose.b.headR * pose.height * scale);
  const headRx = Math.max(2, yawExtent(headR * 0.86, headR * 0.95, Number.isFinite(+pose.headYaw) ? +pose.headYaw : facing));
  const fillHead = (rx, ry) => {
    ctx.beginPath();
    if (typeof ctx.ellipse === 'function') ctx.ellipse(head.x, head.y, rx, ry, 0, 0, Math.PI * 2);
    else circle(ctx, head.x, head.y, Math.max(rx, ry));
  };
  ctx.save();
  try {
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (options.volume && options.shadow == null && options.rim == null) {
    // Small dancers (cheap LOD) get the same see-through volume (TJ 1:51 PM):
    // translucent tint, a lighter core per limb for roundness, a fine rim,
    // and the pulses as small additive lights. No gradients, no clip.
    ctx.strokeStyle = VOLUME_RIM_CHEAP;
    ctx.lineWidth = 1.2;
    torso(); ctx.stroke();
    fillHead(headRx + 0.8, headR + 0.8); ctx.fillStyle = VOLUME_RIM_CHEAP; ctx.fill();
    ctx.strokeStyle = VOLUME_RIM_CHEAP;
    limbs(1 + 1.6 / Math.max(2, lw));
    ctx.fillStyle = VOLUME_FILL_CHEAP;
    ctx.strokeStyle = VOLUME_FILL_CHEAP;
    torso(); ctx.fill();
    limbs(1);
    fillHead(headRx, headR); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = VOLUME_CORE_CHEAP;
    limbs(0.45);
    ctx.lineWidth = Math.max(1, Math.abs(P('shR').x - P('shL').x) * 0.45);
    ctx.beginPath(); ctx.moveTo(P('groin').x, P('groin').y); ctx.lineTo(P('neck').x, P('neck').y); ctx.stroke();
    const lights = (Array.isArray(options.pulses) ? options.pulses : []).concat(options.torso ? [{...options.torso, r: 0.16}] : []);
    for (const L of lights) {
      if (!L || !Number.isFinite(+L.x) || !Number.isFinite(+L.y)) continue;
      const q = map(+L.x, +L.y), r = Math.max(1.5, (L.r || 0.09) * hPx * 0.6), hue = Number.isFinite(+L.hue) ? +L.hue : 200;
      const a = Math.min(1, (Number.isFinite(+L.a) ? +L.a : 0.8) * (Number.isFinite(+options.glow) ? Math.min(1.3, +options.glow / 0.67) : 1));
      ctx.fillStyle = 'hsla(' + hue + ', 100%, 66%, ' + (0.28 * a).toFixed(3) + ')';
      ctx.beginPath(); circle(ctx, q.x, q.y, r); ctx.fill();
      ctx.fillStyle = 'hsla(' + hue + ', 100%, 74%, ' + (0.5 * a).toFixed(3) + ')';
      ctx.beginPath(); circle(ctx, q.x, q.y, r * 0.45); ctx.fill();
    }
    return true;
  }
  // Faint rim first (reads on a dark floor), then the dark body over it.
  ctx.strokeStyle = options.rim || SKELETON_RIM;
  ctx.fillStyle = options.rim || SKELETON_RIM;
  ctx.lineWidth = 2;
  torso(); ctx.stroke();
  fillHead(headRx + 1.5, headR + 1.5); ctx.fill();
  ctx.strokeStyle = options.rim || SKELETON_RIM;
  limbs(1 + 2.4 / Math.max(2, lw));
  ctx.strokeStyle = options.shadow || SKELETON_SHADOW;
  ctx.fillStyle = options.shadow || SKELETON_SHADOW;
  torso(); ctx.fill();
  limbs(1);
  fillHead(headRx, headR); ctx.fill();
  // Subtle 3D contour (side-sim key light). Skip for ripple masks and stub
  // canvases without gradients, and never use a second buffer.
  if (options.shade !== false && typeof ctx.createLinearGradient === 'function' && typeof ctx.clip === 'function') {
    const midX = (P('shL').x + P('shR').x) * 0.5;
    const midY = (P('neck').y + P('groin').y) * 0.5;
    const ext = Math.max(headR * 4, Math.abs(P('shR').x - P('shL').x) * 0.7, lw * 8);
    const grad = ctx.createLinearGradient(
      midX + KEY_LIGHT.x * ext, midY + KEY_LIGHT.y * ext,
      midX - KEY_LIGHT.x * ext, midY - KEY_LIGHT.y * ext
    );
    grad.addColorStop(0.00, SHADE_HI);
    grad.addColorStop(0.22, 'rgba(150, 172, 205, 0.05)');
    grad.addColorStop(0.48, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.64, SHADE_CORE);
    grad.addColorStop(1.00, 'rgba(0, 0, 0, 0.10)');
    ctx.save();
    torso();
    ctx.beginPath();
    // Rebuild a clip that covers torso + head + thick limbs.
    const tclip = () => {
      torso();
      const hx = head.x, hy = head.y;
      if (typeof ctx.ellipse === 'function') ctx.ellipse(hx, hy, headRx, headR, 0, 0, Math.PI * 2);
      else circle(ctx, hx, hy, headR);
    };
    ctx.beginPath();
    tclip();
    // Limb capsules as additional clip subpaths (wide stroke → fill via clip after lining).
    const clipLimb = (keys) => {
      ctx.moveTo(P(keys[0]).x, P(keys[0]).y);
      for (let i = 1; i < keys.length; i++) ctx.lineTo(P(keys[i]).x, P(keys[i]).y);
    };
    clipLimb(['shL', 'elL', 'wristL', 'handL']);
    clipLimb(['shR', 'elR', 'wristR', 'handR']);
    clipLimb(['hipL', 'kneeL', 'ankleL', 'footL']);
    clipLimb(['hipR', 'kneeR', 'ankleR', 'footR']);
    ctx.lineWidth = lw * 1.35;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    try {
    ctx.clip();
    ctx.fillStyle = grad;
    const boxPad = ext * 1.4;
    ctx.fillRect(midX - boxPad, midY - boxPad, boxPad * 2, boxPad * 2);
    } finally {
    ctx.restore();
    }
    // Faint lit-edge rim along each limb (additive, very cheap).
    ctx.save();
    try {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(205, 222, 245, 0.13)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.0, lw * 0.28);
    const rim = (keys) => {
      const a = P(keys[0]), b = P(keys[keys.length - 1]);
      const tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1e-6;
      let nx = -ty / len, ny = tx / len;
      if (nx * KEY_LIGHT.x + ny * KEY_LIGHT.y < 0) { nx = -nx; ny = -ny; }
      const off = Math.max(0.7, lw * 0.45);
      ctx.beginPath();
      ctx.moveTo(a.x + nx * off, a.y + ny * off);
      for (let i = 1; i < keys.length; i++) {
        const q = P(keys[i]);
        ctx.lineTo(q.x + nx * off, q.y + ny * off);
      }
      ctx.stroke();
    };
    rim(['shL', 'elL', 'wristL', 'handL']);
    rim(['shR', 'elR', 'wristR', 'handR']);
    rim(['hipL', 'kneeL', 'ankleL', 'footL']);
    rim(['hipR', 'kneeR', 'ankleR', 'footR']);
    } finally {
    ctx.restore();
    }
    if (lod === 'full' && typeof ctx.createLinearGradient === 'function') {
      // Facing shade: nearer / front of the volume is lighter, far side darker,
      // so a turned chest/pelvis reads as a solid transparent body.
      const midX2 = (P('shL').x + P('shR').x) * 0.5;
      const midY2 = (P('neck').y + P('groin').y) * 0.5;
      const ext2 = Math.max(headR * 4, Math.abs(P('shR').x - P('shL').x) * 0.7, lw * 8);
      const fwd = rotateFacing(0, 1, facing);
      const fgrad = ctx.createLinearGradient(midX2 + fwd.x * ext2, midY2, midX2 - fwd.x * ext2, midY2);
      fgrad.addColorStop(0.00, 'rgba(200, 218, 245, 0.10)');
      fgrad.addColorStop(0.28, 'rgba(0, 0, 0, 0)');
      fgrad.addColorStop(0.62, 'rgba(0, 0, 0, 0.16)');
      fgrad.addColorStop(1.00, 'rgba(0, 0, 0, 0.28)');
      ctx.save();
      try {
      torso();
      if (typeof ctx.ellipse === 'function') ctx.ellipse(head.x, head.y, headRx, headR, 0, 0, Math.PI * 2);
      else circle(ctx, head.x, head.y, headR);
      ctx.clip();
      ctx.fillStyle = fgrad;
      ctx.fillRect(midX2 - ext2 * 1.4, midY2 - ext2 * 1.4, ext2 * 2.8, ext2 * 2.8);
      // Soft glute / chest hints (side-sim paintTorsoHints).
      const hPx2 = hPx;
      ctx.globalAlpha = 0.65 * alpha;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.13)';
      const hipL = P('hipL'), hipR = P('hipR');
      ctx.beginPath();
      if (typeof ctx.ellipse === 'function') {
        ctx.ellipse(hipL.x, hipL.y + hPx2 * 0.016, hPx2 * 0.028, hPx2 * 0.020, 0.15, 0, Math.PI * 2);
        ctx.ellipse(hipR.x, hipR.y + hPx2 * 0.016, hPx2 * 0.028, hPx2 * 0.020, -0.15, 0, Math.PI * 2);
      }
      ctx.fill();
      } finally {
      ctx.restore();
      }
    }
  }
  } catch {
    // Degenerate clip() can throw (WebKit); the body is already drawn and
    // every save() is popped in the finally below.
  } finally {
  ctx.restore();
  }
  if (options.shadow == null && options.rim == null && options.skeleton) {
    paintSkeletonLines(ctx, pose, map, {height: (pose.height || 80) * scale, scale, ...(typeof options.skeleton === 'object' ? options.skeleton : {})});
  }
  return true;
}

// Subtle silhouette halo: 3 outline strokes, wider = dimmer, additive.
// Cheap (no blur, no offscreen) so 24 sims stay on the iPhone 13 budget.
export function paintSilhouetteHalo(ctx, pose, xy, options = {}) {
  if (!ctx || !pose || typeof ctx.beginPath !== 'function') return false;
  const dim = Number.isFinite(+options.dim) ? +options.dim : 1;
  if (!(dim > 0)) return false;
  const map = typeof xy === 'function' ? xy : (x, y) => ({x, y});
  const P = k => mapPosePoint(pose, map, k);
  const scale = Number.isFinite(+options.scale) && +options.scale > 0 ? +options.scale : 1;
  const h = Math.max(8, (pose.height || 80) * scale);
  const widthScale = Number.isFinite(+options.width) ? Math.max(0, +options.width) : 1;
  const baseW = h * HALO_WIDTH_FRAC * widthScale;
  const peak = Math.max(0, Math.min(0.22, HALO_ALPHA * dim * (Number.isFinite(+options.alpha) ? +options.alpha : 1)));
  // Silence / zero activation: no halo. Tiny widths are skipped so we don't
  // pay for three stroke rings that wouldn't read.
  if (!(baseW > 0.4) || peak < 0.006) return false;
  const color = options.color || 'rgb(220, 228, 240)';
  const torso = () => {
    const shL = P('shL'), shR = P('shR'), neck = P('neck'), hipR = P('hipR'), hipL = P('hipL'), groin = P('groin');
    const quad = (a, c, b, t) => ({x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y});
    const yoke = {x: neck.x, y: neck.y + h * 0.02};
    const seat = {x: groin.x, y: groin.y + h * 0.015};
    ctx.beginPath();
    ctx.moveTo(shL.x, shL.y);
    for (let i = 1; i <= 5; i++) { const p = quad(shL, yoke, shR, i / 5); ctx.lineTo(p.x, p.y); }
    ctx.lineTo(hipR.x, hipR.y);
    for (let i = 1; i <= 5; i++) { const p = quad(hipR, seat, hipL, i / 5); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
  };
  const limb = (keys) => {
    ctx.beginPath();
    const a = P(keys[0]);
    ctx.moveTo(a.x, a.y);
    for (let i = 1; i < keys.length; i++) { const q = P(keys[i]); ctx.lineTo(q.x, q.y); }
  };
  const head = P('head');
  const headR = Math.max(2, pose.b.headR * pose.height * scale);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  const rings = [
    {w: baseW * 2.0, a: peak * 0.22},
    {w: baseW * 1.15, a: peak * 0.42},
    {w: baseW * 0.55, a: peak * 0.62}
  ];
  const strokeAll = () => {
    // TJ 8:02 PM: the glow emanates from the head — brightest there,
    // falling off down the body (torso, arms, then legs).
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * HALO_FALLOFF.torso; torso(); ctx.stroke();
    ctx.globalAlpha = base * HALO_FALLOFF.arms;
    limb(['shL', 'elL', 'wristL', 'handL']); ctx.stroke();
    limb(['shR', 'elR', 'wristR', 'handR']); ctx.stroke();
    ctx.globalAlpha = base * HALO_FALLOFF.legs;
    limb(['hipL', 'kneeL', 'ankleL', 'footL']); ctx.stroke();
    limb(['hipR', 'kneeR', 'ankleR', 'footR']); ctx.stroke();
    ctx.globalAlpha = Math.min(1, base * HALO_FALLOFF.head);
    ctx.beginPath(); circle(ctx, head.x, head.y, headR); ctx.stroke();
  };
  for (const ring of rings) {
    ctx.globalAlpha = ring.a;
    ctx.lineWidth = ring.w;
    strokeAll();
  }
  // Soft radial bloom centred on the head: the source the halo falls off from.
  if (typeof ctx.createRadialGradient === 'function') {
    const r = headR + baseW * 2.2;
    const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, r);
    if (g && typeof g.addColorStop === 'function') {
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = Math.min(0.3, peak * HALO_HEAD_BLOOM);
      ctx.fillStyle = g;
      ctx.beginPath(); circle(ctx, head.x, head.y, r); ctx.fill();
    }
  }
  ctx.restore();
  return true;
}
// Halo brightness by body part relative to the ring alpha (head = source).
export const HALO_FALLOFF = Object.freeze({head: 1.6, torso: 0.75, arms: 0.6, legs: 0.35});
export const HALO_HEAD_BLOOM = 1.2;

// Small glowing beads running down both arms (additive, cheap).
export function paintArmPulses(ctx, pose, xy, u, options = {}) {
  if (!ctx || !pose || !(u >= 0) || typeof ctx.arc !== 'function') return false;
  const map = typeof xy === 'function' ? xy : (x, y) => ({x, y});
  const vis = pulseVisibility(options.color || 'hsl(120 90% 62%)');
  const r = Math.max(Number.isFinite(+options.minRadius) ? +options.minRadius : 1.5, (+options.radius || 2.4) * vis.coreScale);
  const aura = Number.isFinite(+options.aura) ? Math.max(0, +options.aura) : 1;
  const fade = 1 - 0.55 * u;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = vis.css;
  for (const side of [-1, 1]) {
    const at = pointAlong(armPath(pose, side), u);
    if (!at) continue;
    const q = map(at.x, at.y);
    if (aura > 0) {
      ctx.globalAlpha = Math.min(1, 0.18 * fade * (options.dim || 1) * Math.min(1, aura) * vis.alphaScale);
      ctx.beginPath(); circle(ctx, q.x, q.y, r * (Number.isFinite(+options.aura) ? 1.4 + 0.6 * Math.min(1.5, aura) : 2.4)); ctx.fill();
    }
    ctx.globalAlpha = Math.min(1, 0.55 * fade * (options.dim || 1) * vis.alphaScale);
    ctx.beginPath(); circle(ctx, q.x, q.y, r); ctx.fill();
  }
  ctx.restore();
  return true;
}

// Corner insets: larger stick figures of up to 4 dancers, dim (TJ t2563u).
export const INSET_MAX = 4;
export const INSET_ALPHA = 0.42;
export const INSET_W = 0.15;
export const INSET_H = 0.30;
export function insetRects(width, height, count = INSET_MAX) {
  const n = Math.max(0, Math.min(INSET_MAX, count | 0));
  // Larger, readable insets (TJ 6:48 PM); stage dancers keep out of corners.
  const w = Math.round(width * INSET_W);
  const h = Math.round(height * INSET_H);
  const m = Math.round(Math.min(width, height) * 0.02);
  const all = [
    {x: m, y: m, w, h},
    {x: width - m - w, y: m, w, h},
    {x: m, y: height - m - h, w, h},
    {x: width - m - w, y: height - m - h, w, h}
  ];
  return all.slice(0, n);
}

// Pelvis as a horizontal (in the body) crossbar from hip joint to hip joint.
// Rotates with hip yaw / tilt / figure-8 because it is just hipL–hipR.
export function pelvisCrossbar(pose) {
  if (!pose || !pose.hipL || !pose.hipR) return null;
  const L = pose.hipL, R = pose.hipR;
  return {
    left: L,
    right: R,
    mid: {
      x: (L.x + R.x) * 0.5,
      y: (L.y + R.y) * 0.5,
      z: ((+L.z || 0) + (+R.z || 0)) * 0.5
    }
  };
}

// Stick armature used on the live stage (over the see-through shell), in
// insets, and in previews. The pelvis is the hip–hip crossbar; the spine
// meets that bar at its centre; each femur starts at an outer end.
export function paintSkeletonLines(ctx, pose, xy, options = {}) {
  if (!ctx || !pose || typeof ctx.beginPath !== 'function') return false;
  const bar = pelvisCrossbar(pose);
  if (!bar) return false;
  const map = typeof xy === 'function' ? xy : (x, y) => ({x, y});
  const Q = p => {
    if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) return null;
    const q = map(p.x, p.y);
    return {x: q.x, y: q.y};
  };
  const hipL = Q(bar.left), hipR = Q(bar.right), mid = Q(bar.mid);
  if (!hipL || !hipR || !mid) return false;
  const P = k => pose[k] ? Q(pose[k]) : null;
  const h = Number.isFinite(+options.height) && +options.height > 0
    ? +options.height
    : (pose.height || 100);
  const lw = Number.isFinite(+options.width) ? +options.width : Math.max(1.15, h * 0.008);
  const alpha = Number.isFinite(+options.alpha) ? +options.alpha : 0.52;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = options.color || 'rgba(214, 230, 255, 0.95)';
  ctx.lineWidth = lw;
  const line = pts => {
    const ok = pts.filter(Boolean);
    if (ok.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(ok[0].x, ok[0].y);
    for (let i = 1; i < ok.length; i++) ctx.lineTo(ok[i].x, ok[i].y);
    ctx.stroke();
  };
  line([P('shL'), P('elL'), P('wristL'), P('handL')]);
  line([P('shR'), P('elR'), P('wristR'), P('handR')]);
  line([P('shL'), P('shR')]);
  line([P('head'), P('neck'), mid]);
  // Trapezius slope: neck column into the shoulder girdle (visible neck).
  const neckLw = ctx.lineWidth;
  ctx.lineWidth = lw * 1.15;
  line([P('neck'), P('shL')]);
  line([P('neck'), P('shR')]);
  ctx.lineWidth = neckLw;
  line([hipL, hipR]); // pelvic crossbar
  line([hipL, P('kneeL'), P('ankleL'), P('footL')]);
  line([hipR, P('kneeR'), P('ankleR'), P('footR')]);
  const head = P('head');
  if (head && pose.b && Number.isFinite(+pose.b.headR)) {
    ctx.beginPath();
    circle(ctx, head.x, head.y, Math.max(2, pose.b.headR * h));
    ctx.stroke();
  }
  ctx.restore();
  return {crossbar: {left: hipL, mid, right: hipR}};
}

export function paintStickInset(ctx, unit, rect, options = {}) {
  if (!ctx || !unit || !rect || typeof ctx.beginPath !== 'function') return false;
  const height = rect.h * 0.86;
  const pose = placePose(unit, rect.x + rect.w / 2, rect.y + rect.h * 0.07, height);
  const alpha = Number.isFinite(+options.alpha) ? +options.alpha : INSET_ALPHA;
  const P = k => pose[k];
  const lw = Math.max(1.5, height * 0.018);
  paintSkeletonLines(ctx, pose, (x, y) => ({x, y}), {
    height, alpha, width: lw, color: options.color || 'rgba(190, 205, 240, 0.9)'
  });
  ctx.save();
  ctx.globalAlpha = alpha;
  // Seven chakra nodes, groin → crown.
  const g = P('groin');
  const c = P('crown');
  const hueOf = options.hueAt || (s => 'hsl(' + (s * 275).toFixed(0) + ' 95% 62%)');
  for (const ch of CHAKRAS_7) {
    const x = g.x + (c.x - g.x) * ch.s;
    const y = g.y + (c.y - g.y) * ch.s;
    const boost = Number.isFinite(+options.travelS) && options.travelS >= 0 ? Math.max(0, 1 - Math.abs(ch.s - options.travelS) / 0.2) : 0;
    ctx.fillStyle = hueOf(ch.s);
    ctx.beginPath(); circle(ctx, x, y, lw * (1.3 + boost * 1.2)); ctx.fill();
  }
  ctx.restore();
  return true;
}

// ---- Weight transfer with a planted stance foot (TJ 6:57 PM) ----
// The weight-bearing foot stays exactly where it is on the floor for the
// whole transfer: the figure is placed so its stance toe sits on a fixed floor
// anchor (base height, before any throb), so throb / pelvis give never slide
// or lift it. Only the free foot rises and steps. Rare jumps lift both.
export const JUMP_RISE = 0.07; // of figure height at the top of a jump
export const JUMP_SPAN = 0.42; // fraction of the beat spent in the air
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// About one beat in 16–32 per dancer (its own rate), randomized by beat.
export function jumpEvery(id) {
  return 16 + Math.floor(hash01((id | 0) * 7919 + 13) * 17);
}
export function isJumpBeat(id, beat) {
  return hash01((id | 0) * 104729 + (beat | 0) * 7907 + 1) < 1 / jumpEvery(id);
}

// How often this dancer may try a standing-tall pose (every 4–8 beats).
export function tallEvery(id) {
  return 4 + Math.floor(hash01((id | 0) * 9157 + 3) * 5);
}
export function tallHoldBeats(id, beat) {
  return 1 + (hash01((id | 0) * 3343 + (beat | 0) * 11) >= 0.5 ? 1 : 0);
}
// True on a candidate beat at high activation. Never at low activation.
export function shouldEnterTall({id = 0, beat = 0, activation = 0, airborne = false} = {}) {
  if (airborne) return false;
  if (!(+activation >= TALL_ACT_ENTER)) return false;
  const period = tallEvery(id);
  const phase = Math.floor(hash01((id | 0) * 19 + 1) * period);
  const k = (beat | 0) - phase;
  if (k < 0 || k % period !== 0) return false;
  return hash01((id | 0) * 104729 + (beat | 0) * 7907 + 21) < TALL_CHANCE;
}

// Per-dancer standing-tall envelope 0..1, smoothed. Occasional 1–2 beat holds
// at high energy; always 0 at low activation.
const talls = new Map();
export function resetTallStand(id) {
  if (id == null) talls.clear();
  else talls.delete(id | 0);
}
export function tallStandAt(id, {activation = 0, beat = 0, now = 0, airborne = false, periodMs = 500} = {}) {
  let st = talls.get(id | 0);
  if (!st) { st = {on: false, until: -1, lastBeat: -1, y: 0, t: +now || 0}; talls.set(id | 0, st); }
  const t = +now || 0;
  const act = Math.max(0, +activation || 0);
  const beatN = beat | 0;
  if (act < TALL_ACT_HOLD) {
    st.on = false;
  } else if (!st.on && !airborne && beatN !== st.lastBeat && shouldEnterTall({id, beat: beatN, activation: act, airborne})) {
    st.on = true;
    st.until = t + tallHoldBeats(id, beatN) * Math.max(180, +periodMs || 500);
  }
  if (st.on && (airborne || act < TALL_ACT_HOLD || (st.until >= 0 && t >= st.until))) st.on = false;
  st.lastBeat = beatN;
  const dt = Math.max(0, Math.min(0.1, (t - st.t) / 1000));
  st.t = t;
  const target = st.on ? 1 : 0;
  const a = dt > 0 ? 1 - Math.exp(-dt / TALL_BLEND_S) : 0;
  st.y += a * (target - st.y);
  if (!Number.isFinite(st.y)) st.y = 0;
  if (talls.size > 256) talls.clear();
  return clamp(st.y, 0, 1);
}
export function jumpLift(frac) {
  const f = clamp(+frac || 0, 0, 1);
  return f >= JUMP_SPAN ? 0 : JUMP_RISE * Math.sin(Math.PI * f / JUMP_SPAN);
}
export function stanceKey(side, unit) {
  if (unit) {
    const c = side < 0 ? unit.contactL : unit.contactR;
    if (c === 'heel') return side < 0 ? 'heelL' : 'heelR';
  }
  return side < 0 ? 'footL' : 'footR';
}
// Unit pose → stage px with the stance toe pinned at its floor anchor.
// baseH: steady figure height (no throb) that sets the floor and foot spot.
export function placePoseOnFloor(unit, {cx, cy, baseH, height, side = -1, jump = 0, anchorX, anchorZ, anchorFloorY} = {}) {
  const h = height > 0 ? height : baseH;
  const bh = baseH > 0 ? baseH : h;
  const key = stanceKey(side, unit);
  const toe = unit[key] || unit[side < 0 ? 'footL' : 'footR'];
  // Floor line locked in world space (TJ 11:18 AM): a planted foot keeps its
  // y even when the sticker's traced height or position wobbles.
  const floorY = Number.isFinite(+anchorFloorY) ? +anchorFloorY : cy - bh / 2 + 0.99 * bh;
  // Sticky (anchorX, anchorZ) keeps the planted contact still in the floor
  // plane. The rest of the body is placed relative to that contact, so a
  // stance-width change or a turn cannot slide the plant.
  const ax = Number.isFinite(+anchorX) ? +anchorX : cx + toe.x * bh;
  const az = Number.isFinite(+anchorZ) ? +anchorZ : ((+toe.z || 0) * bh);
  const anchor = {x: ax, y: floorY - Math.max(0, +jump || 0) * bh, z: az};
  const out = {b: unit.b, height: h, baseH: bh, stance: key, floorY};
  const toeZ = +toe.z || 0;
  for (const k of Object.keys(unit)) {
    if (k === 'b') continue;
    const p = unit[k];
    if (!p || typeof p !== 'object' || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) {
      out[k] = p;
      continue;
    }
    const q = {x: anchor.x + (p.x - toe.x) * h, y: anchor.y + (p.y - toe.y) * h};
    q.z = anchor.z + ((+p.z || 0) - toeZ) * h;
    out[k] = q;
  }
  return out;
}

// World-space plant pin. Same support: the planted contact stays at (x, z).
// On a weight transfer the new plant is the previous swing foot's world xz
// (locomotion only by stepping, never by sliding the plant).
function contactPoint(unit, side) {
  if (!unit) return null;
  const toe = side < 0 ? unit.footL : unit.footR;
  const heel = side < 0 ? unit.heelL : unit.heelR;
  if (!toe) return heel || null;
  if (!heel) return toe;
  // Same rule as holdGroundedFoot: a flat foot's sticky plant is the ball
  // (the yaw pivot). Using the contact label ('heel') while both ends are
  // on the floor published the heel as otherX; a later weight shift then
  // planted the new stance ball at the old heel and the stance crept out.
  const tol = 0.0005 * (+unit.height || 1);
  return heel.y > toe.y + tol ? heel : toe;
}

export function nextFloorAnchor(prev, {side, unit, cx, baseH} = {}) {
  const bh = baseH > 0 ? baseH : 1;
  const toe = contactPoint(unit, side) || {x: 0, z: 0};
  const other = contactPoint(unit, side < 0 ? 1 : -1) || {x: 0, z: 0};
  if (!prev || !Number.isFinite(+prev.x)) {
    const x = cx + (+toe.x || 0) * bh;
    const z = (+toe.z || 0) * bh;
    const otherX = cx + (+other.x || 0) * bh;
    const otherZ = (+other.z || 0) * bh;
    return {side, key: stanceKey(side, unit), x, z, otherX, otherZ, width: Math.hypot(otherX - x, otherZ - z)};
  }
  // No popping (TJ 10:31 AM): the contact point can roll toe <-> heel or move
  // to the other foot; the new contact starts exactly where that point stood
  // on the floor last frame, so neither foot jumps.
  const key = stanceKey(side, unit);
  const held = prev.pts && prev.pts[key];
  if (prev.side === side) {
    if (prev.key && prev.key !== key && held) { prev.x = held.x; prev.z = held.z; }
    prev.key = key;
    return prev;
  }
  const carry = {pts: prev.pts, lockHalf: prev.lockHalf, swinging: prev.swinging, footOff: prev.footOff, seenHome: prev.seenHome, worldHalf: prev.worldHalf, bal: prev.bal, floorY: prev.floorY};
  if (held) return {side, key, x: held.x, z: held.z, otherX: +prev.x, otherZ: Number.isFinite(+prev.z) ? +prev.z : 0, width: Math.hypot(held.x - prev.x, held.z - (prev.z || 0)), ...carry};
  const x = Number.isFinite(+prev.otherX) ? +prev.otherX : (cx + (+toe.x || 0) * bh);
  const z = Number.isFinite(+prev.otherZ) ? +prev.otherZ : ((+toe.z || 0) * bh);
  return {
    side, x, z,
    otherX: +prev.x,
    otherZ: Number.isFinite(+prev.z) ? +prev.z : 0,
    width: Number.isFinite(+prev.width) ? +prev.width : Math.hypot(x - prev.x, z - (prev.z || 0)),
    ...carry
  };
}

// Double support (TJ 10:31 AM, no sliding): the non-stance foot is placed
// from the pose relative to the stance contact, so any change in the pose
// (a heel-toe roll, a sway, a width tweak) would drag it across the floor.
// While that foot is down it is held where it stood last frame; the small
// correction is carried and only released while the foot is in the air
// (where it may also steer the landing back toward the dancer's home).
export const STEP_MIN_ACT = 0.42;     // below: no foot lifts, weight shifts only
export const STEP_FULL_ACT = 0.58;
export function stepGate(act) { const u = Math.max(0, Math.min(1, ((+act || 0) - STEP_MIN_ACT) / (STEP_FULL_ACT - STEP_MIN_ACT))); return u * u * (3 - 2 * u); }
export const FIX_STEP_TRIGGER_LOW = 0.07;
export const HOME_STEP_FAR = 0.12; // body this far off its home: settle back by steps at any activation // low activation: hold the feet unless the offset is large
export const FIX_STEP_TRIGGER = 0.022; // held foot this far (height units) from where the pose wants it -> step there
export const FIX_STEP_S = 0.32;
export const FIX_STEP_LIFT = 0.028;    // a small, low step
// Footwork: move a posed foot (heel, toe, ankle) forward / back by dz.
function shiftFootZ(f, dz) {
  if (!dz) return f;
  for (const k of ['heel', 'toe', 'ankle']) if (f[k]) f[k] = {...f[k], z: (+f[k].z || 0) + dz};
  return f;
}
export function holdGroundedFoot(posed, pin, side, {lift = 0, homeX = null, maxSteer = 0, now = null, minSep = 0, maxSep = Infinity, lowAct = false, allowFix = true} = {}) {
  if (!posed || !pin) return posed;
  const o = side < 0 ? 'R' : 'L', sign = o === 'L' ? -1 : 1;
  const keys = ['ankle' + o, 'foot' + o, 'heel' + o];
  const toe = posed['foot' + o], heel = posed['heel' + o];
  if (!toe) return posed;
  // Hold the point that is on the floor (the contact: heel, toe, or the
  // foot centre when flat).
  // The contact is whichever end is lower (on the floor); both flat: centre.
  const tol = 0.0005 * (+posed.height || 100);
  // Flat (both on the floor): hold the ball, not the mid-foot. Body yaw
  // pivots the heel around the toe; a mid-foot hold would drift and then
  // be "corrected" as a slide or a settling step (TJ: planted feet locked,
  // soft rest, no extra steps at low activation).
  const cKey = !heel ? 'foot' : heel.y > toe.y + tol ? 'heel' : 'foot';
  const pick = (t, h) => cKey === 'heel' ? {x: h.x, z: +h.z || 0} : {x: t.x, z: +t.z || 0};
  const midNow = pick(toe, heel);
  const prev = pin.pts && pin.pts['foot' + o] ? pin.pts : null;
  const sameStance = pin.heldSide === side;
  // Continuous hold: a foot on the floor stays exactly where it stood last
  // frame; as it clears the floor (lift ~0 -> 3% height) it is handed back
  // to the pose, so it never skates sideways while barely lifted.
  // Clearance is what is drawn: the foot's lowest point above the floor.
  const hgt = +posed.height || 100;
  const lowY = Math.max(toe.y, heel ? heel.y : toe.y);
  const gap = Number.isFinite(+posed.floorY) ? (+posed.floorY - lowY) / hgt : +lift;
  // Solid contact: a free foot within 0.6% height of the floor (or sunk
  // into it) is set exactly on the floor, so it is either down or clearly up.
  const snap = gap < 0.006 && gap > -0.03 ? gap * hgt : 0;
  const clear = Math.max(0, Math.min(1, (gap - 0.006) / 0.02));
  // A zero-lift free foot stays fully held. Beat throb scales the unheld
  // pose in `height` while the pin is in baseH, so a tiny measured gap was
  // blending toward the throb-scaled (wider) pose and the planted stance
  // crept out past 2.0 shoulder widths (TJ: planted feet locked).
  const c = ((+lift || 0) < 0.001) ? 0 : clear * clear * (3 - 2 * clear);
  const prevOff = pin.footOff && sameStance ? pin.footOff : {x: 0, z: 0};
  let steer = 0;
  if (Number.isFinite(+homeX) && maxSteer > 0) {
    const centre = (pin.x + midNow.x + prevOff.x) / 2;
    steer = Math.max(-maxSteer, Math.min(maxSteer, (+homeX) - centre));
  }
  const free = {x: prevOff.x + (steer - prevOff.x) * 0.2 * c, z: prevOff.z * (1 - 0.2 * c)};
  let off = free;
  if (prev && prev['foot' + o] && c < 1) {
    const held = pick(prev['foot' + o], prev['heel' + o]);
    const hold = {x: held.x - midNow.x, z: held.z - midNow.z};
    off = {x: hold.x + (free.x - hold.x) * c, z: hold.z + (free.z - hold.z) * c};
  }
  // A foot in the air lands inside the stance bounds (2.0 shoulder widths max,
  // 0.8 hip widths min): steer its flight, never a foot on the floor.
  if (c > 0) {
    const st0 = posed['foot' + (side < 0 ? 'L' : 'R')], sh0 = posed['heel' + (side < 0 ? 'L' : 'R')];
    if (st0) {
      const sm = sh0 ? {x: (st0.x + sh0.x) / 2, z: ((+st0.z || 0) + (+sh0.z || 0)) / 2} : {x: st0.x, z: +st0.z || 0};
      const fm = {x: (heel ? (toe.x + heel.x) / 2 : toe.x) + off.x, z: ((heel ? ((+toe.z || 0) + (+heel.z || 0)) / 2 : (+toe.z || 0)) + off.z)};
      const ax = hipAxisUnit(posed.hipL, posed.hipR);
      const signed = (fm.x - sm.x) * ax.x + ((fm.z || 0) - (sm.z || 0)) * ax.z;
      const dir = signed >= 0 ? 1 : -1, sep = Math.abs(signed);
      const want = Math.max(minSep, Math.min(maxSep, sep));
      if (want !== sep) off = {x: off.x + ax.x * dir * (want - sep), z: off.z + ax.z * dir * (want - sep)};
    }
  }
  // Corrective step (no skating): when the planted free foot is held far
  // from where the pose wants it (rest collection, a stance change without a
  // visible lift), it takes a real small step there: lift, travel, land.
  let raise = 0;
  const tNow = Number.isFinite(+now) ? +now : null;
  const bh = Number.isFinite(+posed.baseH) && +posed.baseH > 0 ? +posed.baseH : hgt;
  const unthrobScale = hgt > 1e-9 ? bh / hgt : 1;
  // Pose joints are placed in throbbed `height`; the plant lives in baseH.
  // Drift/landing must use the unthrobbed target or a corrective step aims
  // at the beat-scaled pose and the planted stance ratchets outward.
  const unthrob = (p) => p ? {x: pin.x + (p.x - pin.x) * unthrobScale, z: (+pin.z || 0) + ((+p.z || 0) - (+pin.z || 0)) * unthrobScale} : p;
  if (tNow != null) {
    if (pin.fix && (pin.fix.side !== side || !sameStance)) pin.fix = null;
    // Held foot outside the stance bounds (min hip / max shoulder widths): step now.
    const st = posed['foot' + (side < 0 ? 'L' : 'R')], sh = posed['heel' + (side < 0 ? 'L' : 'R')];
    const midXZ = (t0, h0, ox = 0, oz = 0) => h0
      ? {x: (t0.x + h0.x) / 2 + ox, z: ((+t0.z || 0) + (+h0.z || 0)) / 2 + oz}
      : {x: t0.x + ox, z: (+t0.z || 0) + oz};
    const stanceM = st ? midXZ(st, sh) : null;
    const freeM = midXZ(toe, heel, off.x, off.z);
    const ax = hipAxisUnit(posed.hipL, posed.hipR);
    // Out-of-bounds is about the planted contacts (the points we actually
    // hold), not the mid-feet: toe-out / yaw moves mid-feet a hair inward
    // and was firing a visible rest step over a fraction of a pixel.
    const plantA = {x: pin.x, z: +pin.z || 0};
    const plantB = {x: midNow.x + off.x, z: (midNow.z || 0) + off.z};
    const sepNow = projectedStanceWidth(plantA, plantB, posed.hipL, posed.hipR);
    const outOfBounds = sepNow < minSep || sepNow > maxSep;
    // Where a settling step lands: the pose target, steered toward home
    // (so a dancer that drifted walks back by real steps, never by sliding).
    // Support centre is the mid-feet average, not the balls (toe-out / yaw
    // would otherwise look chronically off-home and trigger extra steps).
    let land = 0;
    // Midpoint of the planted contacts (balls / heels), not the mid-feet:
    // yaw lets heels orbit the balls, which would look like a slow home
    // drift and kick off a long shuffle of tiny settling steps at rest.
    const midTarget = unthrob(midNow);
    const supportX = (pin.x + midTarget.x + off.x) / 2;
    if (Number.isFinite(+homeX) && maxSteer > 0) land = Math.max(-maxSteer, Math.min(maxSteer, (+homeX) - supportX));
    // The landing stays inside the stance bounds (0.8 hip .. 2.0 shoulder widths).
    if (stanceM != null) {
      // ...and near the pose's own width: home is reached by alternating
      // steps, never by stretching into a split.
      const fm0 = midXZ(toe, heel);
      const poseSep = projectedStanceWidth(fm0, stanceM, posed.hipL, posed.hipR);
      // land stays a world-x offset (the step path is x-steered toward home).
      const fm = {x: fm0.x + land, z: fm0.z};
      const signed = (fm.x - stanceM.x) * ax.x + ((fm.z || 0) - (stanceM.z || 0)) * ax.z;
      const dir = signed >= 0 ? 1 : -1;
      const sep = Math.abs(signed);
      const want = Math.max(Math.max(minSep, poseSep - 0.04 * hgt), Math.min(maxSep * 0.97, poseSep + 0.04 * hgt, sep));
      land += dir * (want - sep);
    }
    const offHome = Number.isFinite(+homeX) && Math.abs(+homeX - supportX) > HOME_STEP_FAR * hgt;
    const trigger = (lowAct ? FIX_STEP_TRIGGER_LOW : FIX_STEP_TRIGGER) * hgt;
    // At low activation, "home moved" means the sticker / home x itself
    // jumped (a re-detection), not that planted contacts slowly drifted
    // relative to a still home. Jitter under HOME_STEP_FAR is absorbed.
    if (!Number.isFinite(+pin.seenHome) && Number.isFinite(+homeX)) pin.seenHome = +homeX;
    const homeMoved = Number.isFinite(+homeX) && Number.isFinite(+pin.seenHome) && Math.abs(+homeX - pin.seenHome) > HOME_STEP_FAR * hgt;
    if (!pin.fix && Number.isFinite(+homeX) && !homeMoved) pin.seenHome = +homeX;
    // Compare the held world foot to the unthrobbed pose target (off was
    // computed from the throbbed midNow; rescale the leftover).
    const offTarget = {x: midTarget.x + off.x - midNow.x, z: (midTarget.z || 0) + off.z - (midNow.z || 0)};
    const drifted = Math.hypot(offTarget.x - land, offTarget.z) > trigger;
    // Hairline first-frame width (plant ~1% under minSep) must not start a
    // rest shuffle. Only walk at low activation when the home really jumped.
    const shouldStep = lowAct
      ? homeMoved
      : (outOfBounds ? Math.hypot(off.x, off.z) > 0.002 * hgt : (drifted || (offHome && Math.abs(off.x - land) > 0.01 * hgt)));
    // Footwork owns the feet: a leftover or new settling step would drag a
    // nearly planted foot (the 10-min show counts that as slip).
    if (!allowFix && pin.fix) pin.fix = null;
    if (pin.fix && c > 0) pin.fix = null;
    if (!pin.fix && allowFix && c <= 0 && shouldStep) pin.fix = {t0: tNow, wx: toe.x + off.x, wz: (+toe.z || 0) + off.z, side, lift: lowAct ? 0.5 : 1};

    if (pin.fix) {
      const u = Math.max(0, Math.min(1, (tNow - pin.fix.t0) / (FIX_STEP_S * 1000)));
      // Lift first, travel only while clear of the floor, then set down.
      const eu = Math.max(0, Math.min(1, (u - 0.15) / 0.7));
      const e = eu * eu * (3 - 2 * eu);
      // World-space path (start and landing fixed when the step begins), so
      // pose changes during the step never drag the foot near the floor.
      const f = pin.fix;
      // Take-off point fixed in world space (toe reference, so a heel/toe
      // contact change can't shift it); the landing follows the pose target
      // (+ home steer) while the foot is up, then is frozen in world space
      // for the set-down so nothing drags it near the floor.
      const tz = +toe.z || 0;
      if (e >= 1) {
        if (!f.landW) f.landW = {x: toe.x + land, z: tz};
        off = {x: f.landW.x - toe.x, z: f.landW.z - tz};
      } else off = {x: (f.wx - toe.x) * (1 - e) + land * e, z: (f.wz - tz) * (1 - e)};
      raise = FIX_STEP_LIFT * (pin.fix.lift || 1) * hgt * Math.sin(Math.PI * u);
      if (u >= 1) {
        pin.fix = null;
        // Still off home after this step: let the other foot step next.
        if (Number.isFinite(+homeX)) {
          const centre = (pin.x + midNow.x + off.x) / 2;
          if (Math.abs(+homeX - centre) > (lowAct ? HOME_STEP_FAR : 0.04) * hgt) pin.wantSwap = true;
          else pin.seenHome = +homeX;
        }
      }
    }
  }
  if (off.x || off.z || raise || snap) {
    for (const k of keys) { const p = posed[k]; if (p && Number.isFinite(+p.x)) { p.x += off.x; p.z = (+p.z || 0) + off.z; p.y += snap - raise; } }
    const h = +posed.height || 1;
    if (posed['hip' + o] && posed['ankle' + o]) posed['knee' + o] = kneeIK(posed['hip' + o], posed['ankle' + o], THIGH * h, SHIN * h, sign, kneeForwardOf(posed, o));
  }
  // Double-support lock: while a foot is planted (and not mid-step), pin its
  // world xz to last frame's points. Off-math, a heel/ball mismatch, or a
  // weight-shift transfer must not creep the stance wider (TJ: planted feet locked).
  if (c <= 0 && !pin.fix && pin.pts) {
    const restore = (s) => {
      const ft = pin.pts['foot' + s], hl = pin.pts['heel' + s];
      const pft = posed['foot' + s], phl = posed['heel' + s], pan = posed['ankle' + s];
      if (!ft || !pft || !Number.isFinite(+ft.x)) return;
      const dx = ft.x - pft.x, dz = (+ft.z || 0) - (+pft.z || 0);
      pft.x = ft.x; pft.z = +ft.z || 0;
      if (phl) { if (hl && Number.isFinite(+hl.x)) { phl.x = hl.x; phl.z = +hl.z || 0; } else { phl.x += dx; phl.z = (+phl.z || 0) + dz; } }
      if (pan) {
        const an = pin.pts['ankle' + s];
        if (an && Number.isFinite(+an.x)) { pan.x = an.x; pan.z = +an.z || 0; if (Number.isFinite(+an.y)) pan.y = an.y; }
        else { pan.x += dx; pan.z = (+pan.z || 0) + dz; }
      }
    };
    restore('L'); restore('R');
  }
  // Final min-stance: a lifted foot is pushed out along the hip axis if the
  // projected width is under the min (a running-man / settle can otherwise
  // read narrower than 0.8 hip widths in 2D).
  if (minSep > 0 && c > 0.3) {
    const st = posed['foot' + (side < 0 ? 'L' : 'R')], sh = posed['heel' + (side < 0 ? 'L' : 'R')];
    const ft = posed['foot' + o], hl = posed['heel' + o];
    if (st && ft) {
      const midA = sh ? {x: (st.x + sh.x) / 2, z: ((+st.z || 0) + (+sh.z || 0)) / 2} : {x: st.x, z: +st.z || 0};
      const midB = hl ? {x: (ft.x + hl.x) / 2, z: ((+ft.z || 0) + (+hl.z || 0)) / 2} : {x: ft.x, z: +ft.z || 0};
      const sepNow = projectedStanceWidth(midA, midB, posed.hipL, posed.hipR);
      if (sepNow < minSep && Number.isFinite(sepNow)) {
        const ax = hipAxisUnit(posed.hipL, posed.hipR);
        const signed = (midB.x - midA.x) * ax.x + ((midB.z || 0) - (midA.z || 0)) * ax.z;
        const dir = signed >= 0 ? 1 : -1, push = (minSep - sepNow);
        const dx = ax.x * dir * push, dz = ax.z * dir * push;
        for (const k of keys) { const p = posed[k]; if (p && Number.isFinite(+p.x)) { p.x += dx; p.z = (+p.z || 0) + dz; } }
        const hh = +posed.height || 1;
        if (posed['hip' + o] && posed['ankle' + o]) posed['knee' + o] = kneeIK(posed['hip' + o], posed['ankle' + o], THIGH * hh, SHIN * hh, sign, kneeForwardOf(posed, o));
      }
    }
  }
  pin.footOff = off;
  pin.otherDown = clear <= 0;
  pin.heldSide = side;
  return posed;
}

// Drawn-pose balance (TJ 10:41 AM): as the free foot leaves the floor the
// body moves over the stance foot (COM within the support), and the pelvis
// height comes from the legs: lowered until every planted leg reaches its
// foot with a soft bend. Upper body rides on the pelvis.
export const POSED_UPPER = ['head', 'neck', 'shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR', 'groin', 'crown', 'heart', 'hipL', 'hipR', 'pelvis', 'lumbar', 'sacral', 'solar'];
export function rebalancePosed(posed, side, state = null, now = null) {
  if (!posed || !posed.hipL || !posed.hipR || !posed.heart) return posed;
  const h = +posed.height || 100, floorY = +posed.floorY;
  const footMid = s => { const t = posed['foot' + s], hh = posed['heel' + s]; return hh ? {x: (t.x + hh.x) / 2, lo: Math.max(t.y, hh.y), xs: [t.x, hh.x]} : {x: t.x, lo: t.y, xs: [t.x]}; };
  const L = footMid('L'), R = footMid('R');
  const gapL = Number.isFinite(floorY) ? (floorY - L.lo) / h : 0, gapR = Number.isFinite(floorY) ? (floorY - R.lo) / h : 0;
  const downL = gapL <= 0.026, downR = gapR <= 0.026;
  if (!downL && !downR) {
    // Airborne (a jump): no support rebalance, but swinging / tucked
    // knees still have to stay in the human range.
    const sc0 = h, maxSpan0 = legSpanLimits(THIGH, SHIN).max * sc0;
    const minSpan0 = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos((KNEE_MIN_DEG + 4) * Math.PI / 180)) * sc0 + 1e-4;
    for (const s of ['L', 'R']) {
      const hp = posed['hip' + s], an = posed['ankle' + s];
      if (!hp || !an) continue;
      const vx = an.x - hp.x, vy = an.y - hp.y, vz = (+an.z || 0) - (+hp.z || 0), d = Math.hypot(vx, vy, vz);
      if (d > 1e-8 && (d > maxSpan0 || d < minSpan0)) {
        const want = d > maxSpan0 ? maxSpan0 : minSpan0;
        const k = want / d, ddx = hp.x + vx * k - an.x, ddy = hp.y + vy * k - an.y, ddz = (+hp.z || 0) + vz * k - (+an.z || 0);
        for (const kk of ['ankle' + s, 'foot' + s, 'heel' + s]) { const p = posed[kk]; if (p) { p.x += ddx; p.y += ddy; p.z = (+p.z || 0) + ddz; } }
      }
    }
    for (const [s, sg] of [['L', -1], ['R', 1]]) if (posed['hip' + s] && posed['ankle' + s]) posed['knee' + s] = kneeIK(posed['hip' + s], posed['ankle' + s], THIGH * h, SHIN * h, sg, kneeForwardOf(posed, s));
    enforceLegReach(posed, h);
    lockPoseBones(posed, h);
    if (posed.thoracic) posed.heart = {x: posed.thoracic.x, y: posed.thoracic.y, z: posed.thoracic.z || 0};
    if (posed.lumbar) posed.solar = {x: posed.lumbar.x, y: posed.lumbar.y, z: posed.lumbar.z || 0};
    return posed;
  }
  const keys = upperKeys(posed);
  const move = (dx, dy, dz = 0) => { for (const k of keys) { const p = posed[k]; p.x += dx; p.y += dy; if (dz) p.z = (+p.z || 0) + dz; } };
  const com = 0.55 * (posed.hipL.x + posed.hipR.x) / 2 + 0.33 * posed.heart.x + 0.12 * (posed.head ? posed.head.x : posed.heart.x);
  const m = COM_MARGIN * h;
  const clampTo = xs => { const lo = Math.min(...xs) - m, hi = Math.max(...xs) + m; return com < lo ? lo : com > hi ? hi : com; };
  // Weight moves over the stance foot continuously as the free foot clears
  // the floor (0.6% -> 2.6% height), so a step never pops the body.
  const both = clampTo([...L.xs, ...R.xs]);
  const wL = Math.max(0, Math.min(1, (gapL - 0.006) / 0.02)), wR = Math.max(0, Math.min(1, (gapR - 0.006) / 0.02));
  let target = both;
  if (wR > 0 && wR >= wL) target = both + (clampTo(L.xs) - both) * wR;
  else if (wL > 0) target = both + (clampTo(R.xs) - both) * wL;
  let dx = target - com;
  if (state && Number.isFinite(+now)) {
    const dt = Number.isFinite(state.t) ? Math.max(0, Math.min(0.1, (now - state.t) / 1000)) : 1;
    state.t = now;
    const prev = Number.isFinite(state.dx) ? state.dx : dx;
    const eased = prev + (dx - prev) * (1 - Math.exp(-dt / 0.06));
    const slack = 0.02 * h;
    dx = Math.max(dx - slack, Math.min(dx + slack, eased));
    state.dx = dx;
  }
  if (dx) move(dx, 0);
  // Legs carry the pelvis.
  const sc = h, maxSpan = legSpanLimits(THIGH, SHIN).max * sc;
  let dy = 0;
  // Same "on the floor" window as support (2.6% height), so a foot that is
  // only just leaving cannot stretch a planted leg past its bone length.
  for (const [s, down] of [['L', downL], ['R', downR]]) {
    if (!down) continue;
    const hp = posed['hip' + s], an = posed['ankle' + s];
    if (!hp || !an) continue;
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0), ey = an.y - (hp.y + dy);
    const r2 = maxSpan * maxSpan - ex * ex - ez * ez, need = r2 > 0 ? Math.sqrt(r2) : 0;
    if (ey > need) dy += ey - need;
  }
  if (dy) move(0, dy);
  // If a planted foot is already farther in xz than the bones allow, dropping
  // the pelvis cannot close the gap (d >= horiz). Pull the hips over the foot
  // and leave the planted contact where it is.
  for (const [s, down] of [['L', downL], ['R', downR]]) {
    if (!down) continue;
    const hp = posed['hip' + s], an = posed['ankle' + s];
    if (!hp || !an) continue;
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0);
    const horiz = Math.hypot(ex, ez);
    if (horiz > maxSpan) {
      const k = (horiz - maxSpan) / horiz;
      move(ex * k, 0, ez * k);
    }
  }
  // Raise the pelvis if a planted or just-leaving leg has folded past the
  // deepest squat (interior angle KNEE_MIN_DEG). A COM shift over the stance
  // foot can otherwise shorten hip–ankle just enough to break the floor.
  // A small span margin keeps kneeBend's actual triangle above the floor.
  const minSpan = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos((KNEE_MIN_DEG + 4) * Math.PI / 180)) * sc + 1e-4;
  let up = 0;
  for (const [s, gap] of [['L', gapL], ['R', gapR]]) {
    if (gap > 0.04) continue;
    const hp = posed['hip' + s], an = posed['ankle' + s];
    if (!hp || !an) continue;
    const ex = an.x - hp.x, ez = (+an.z || 0) - (+hp.z || 0), ey = an.y - (hp.y - up);
    const r2 = minSpan * minSpan - ex * ex - ez * ez;
    if (r2 > 0 && ey < Math.sqrt(r2)) up += Math.sqrt(r2) - ey;
  }
  if (up) move(0, -up);
  // A leg in the air is never stretched: its foot is drawn in to reach.
  // It also never folds tighter than the squat floor (swinging knees still
  // have to stay in the human range).
  for (const [s, down] of [['L', gapL <= 0.006], ['R', gapR <= 0.006]]) {
    if (down) continue;
    const hp = posed['hip' + s], an = posed['ankle' + s];
    if (!hp || !an) continue;
    const vx = an.x - hp.x, vy = an.y - hp.y, vz = (+an.z || 0) - (+hp.z || 0), d = Math.hypot(vx, vy, vz);
    if (d > maxSpan || (d > 1e-8 && d < minSpan)) {
      const want = d > maxSpan ? maxSpan : minSpan;
      const k = want / d, ddx = hp.x + vx * k - an.x, ddy = hp.y + vy * k - an.y, ddz = (+hp.z || 0) + vz * k - (+an.z || 0);
      for (const kk of ['ankle' + s, 'foot' + s, 'heel' + s]) { const p = posed[kk]; if (p) { p.x += ddx; p.y += ddy; p.z = (+p.z || 0) + ddz; } }
    }
  }
  for (const [s, sg] of [['L', -1], ['R', 1]]) if (posed['hip' + s] && posed['ankle' + s]) posed['knee' + s] = kneeIK(posed['hip' + s], posed['ankle' + s], THIGH * h, SHIN * h, sg, kneeForwardOf(posed, s));
  enforceLegReach(posed, h);
  lockPoseBones(posed, h);
  // After bones are locked, keep every planted hip–ankle inside the drawn
  // knee's chord (the 10-min show test: d <= reach·1.02 + 0.3 px). Drop the
  // pelvis when a vertical gap remains; pull the hips over the foot when
  // the horizontal span is already past reach. Never slide a planted foot.
  const chordOf = (s, sg) => {
    const hp = posed['hip' + s], kn = posed['knee' + s], an = posed['ankle' + s];
    if (!hp || !kn || !an) return null;
    const ang = kneeBend(hp, kn, an, sg).angleDeg;
    const th = Math.hypot(kn.x - hp.x, kn.y - hp.y, (kn.z || 0) - (hp.z || 0));
    if (!(th > 1e-8)) return null;
    const reach = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos(ang * Math.PI / 180)) * (th / THIGH);
    const ex = an.x - hp.x, ey = an.y - hp.y, ez = (+an.z || 0) - (+hp.z || 0);
    const d = Math.hypot(ex, ey, ez), horiz = Math.hypot(ex, ez);
    return {hp, an, ex, ey, ez, d, horiz, reach};
  };
  const moveGirdle = (dx, dy, dz = 0) => {
    for (const k of ['hipL', 'hipR', 'pelvis', 'groin', 'lumbar', 'sacral', 'solar']) {
      const pnt = posed[k];
      if (!pnt || !Number.isFinite(+pnt.x)) continue;
      pnt.x += dx; pnt.y += dy;
      if (dz) pnt.z = (+pnt.z || 0) + dz;
    }
  };
  const reIK = () => {
    for (const [s, sg] of [['L', -1], ['R', 1]]) if (posed['hip' + s] && posed['ankle' + s]) posed['knee' + s] = kneeIK(posed['hip' + s], posed['ankle' + s], THIGH * h, SHIN * h, sg, kneeForwardOf(posed, s));
  };
  for (let iter = 0; iter < 8; iter++) {
    let pullX = 0, pullZ = 0, dropY = 0, nPull = 0, dirty = false;
    const lim = 1.015;
    for (const [s, down, sg] of [['L', downL, -1], ['R', downR, 1]]) {
      if (!down) continue;
      const c = chordOf(s, sg);
      if (!c || !(c.d > c.reach * lim)) continue;
      dirty = true;
      if (c.horiz > c.reach * lim) {
        const k = (c.horiz - c.reach * lim) / (c.horiz || 1e-9);
        pullX += c.ex * k; pullZ += c.ez * k; nPull++;
      } else {
        dropY = Math.max(dropY, c.d - c.reach * lim);
      }
    }
    if (!dirty) break;
    if (nPull) moveGirdle(pullX / nPull, dropY, pullZ / nPull);
    else if (dropY) moveGirdle(0, dropY);
    else break;
    reIK();
  }
  // Keep planted knees at or above KNEE_MIN_DEG (the 10-min show allows −2°).
  let raise = 0;
  for (const [s, down, sg] of [['L', downL, -1], ['R', downR, 1]]) {
    if (!down) continue;
    const hp = posed['hip' + s], kn = posed['knee' + s], an = posed['ankle' + s];
    if (!hp || !kn || !an) continue;
    const ang = kneeBend(hp, kn, an, sg).angleDeg;
    if (ang < KNEE_MIN_DEG) {
      const want = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos(KNEE_MIN_DEG * Math.PI / 180)) * h;
      const d = Math.hypot(an.x - hp.x, an.y - hp.y, (an.z || 0) - (hp.z || 0));
      if (want > d) raise = Math.max(raise, want - d);
    }
  }
  if (raise) { moveGirdle(0, -raise); reIK(); }
  if (posed.thoracic) posed.heart = {x: posed.thoracic.x, y: posed.thoracic.y, z: posed.thoracic.z || 0};
  if (posed.lumbar) posed.solar = {x: posed.lumbar.x, y: posed.lumbar.y, z: posed.lumbar.z || 0};
  return posed;
}

// When both feet are planted, rotate the upper body about the vertical so
// the hip axis lines up with the feet. A later yaw (running-man recover,
// hush decay) would otherwise shrink the hip-axis projection under 0.8
// hip widths without moving the planted contacts.
export function squareHipsToPlantedFeet(posed, minSep = 0) {
  if (!posed || !posed.hipL || !posed.hipR || !posed.footL || !posed.footR) return posed;
  // Also while a foot is in the air: the step's foot line is the hip axis the
  // 2D read uses, so a behind-step does not collapse under 0.8 hip widths.
  const mid = (t, h) => h && Number.isFinite(+h.x)
    ? {x: (t.x + h.x) / 2, z: ((+t.z || 0) + (+h.z || 0)) / 2}
    : {x: t.x, z: +t.z || 0};
  const fL = mid(posed.footL, posed.heelL), fR = mid(posed.footR, posed.heelR);
  const dx = fR.x - fL.x, dz = (fR.z || 0) - (fL.z || 0);
  const footSpan = Math.hypot(dx, dz);
  if (!(footSpan > 1e-6)) return posed;
  const proj = projectedStanceWidth(fL, fR, posed.hipL, posed.hipR);
  const hx = posed.hipR.x - posed.hipL.x, hz = (+posed.hipR.z || 0) - (+posed.hipL.z || 0);
  const hipLen = Math.hypot(hx, hz);
  let want = 0;
  if (hipLen > 1e-9 && !(minSep > 0 && proj >= minSep - 1e-6)) {
    want = Math.atan2(dz, dx) - Math.atan2(hz, hx);
    while (want > Math.PI) want -= 2 * Math.PI;
    while (want < -Math.PI) want += 2 * Math.PI;
  }
  if (!(Math.abs(want) > 1e-4)) return posed;
  // Rotate only the pelvic girdle: the projection is along the hip axis,
  // and spinning the head with a sudden yaw pops the inset jerk test.
  const cx = (posed.hipL.x + posed.hipR.x) / 2;
  const cz = ((+posed.hipL.z || 0) + (+posed.hipR.z || 0)) / 2;
  const c = Math.cos(want), s = Math.sin(want);
  for (const k of ['hipL', 'hipR', 'pelvis', 'groin', 'lumbar', 'sacral', 'solar']) {
    const pnt = posed[k];
    if (!pnt || !Number.isFinite(+pnt.x)) continue;
    const x = pnt.x - cx, z = (+pnt.z || 0) - cz;
    pnt.x = cx + x * c - z * s;
    pnt.z = cz + x * s + z * c;
  }
  const h = +posed.height || 1;
  for (const [side, sg] of [['L', -1], ['R', 1]]) {
    if (posed['hip' + side] && posed['ankle' + side]) posed['knee' + side] = kneeIK(posed['hip' + side], posed['ankle' + side], THIGH * h, SHIN * h, sg, kneeForwardOf(posed, side));
  }
  return posed;
}

// Raise the pelvic girdle until every planted knee is at or above KNEE_MIN_DEG.
export function ensureMinKneeAngle(posed) {
  if (!posed || !posed.hipL || !posed.hipR) return posed;
  const h = +posed.height || 1, floorY = +posed.floorY;
  const downOf = (s) => {
    const t = posed['foot' + s], hh = posed['heel' + s];
    if (!t) return false;
    const lo = Math.max(t.y, hh && Number.isFinite(+hh.y) ? hh.y : t.y);
    if (!Number.isFinite(floorY)) return true;
    return (floorY - lo) / h <= 0.026;
  };
  const reIK = () => {
    for (const [s, sg] of [['L', -1], ['R', 1]]) if (posed['hip' + s] && posed['ankle' + s]) posed['knee' + s] = kneeIK(posed['hip' + s], posed['ankle' + s], THIGH * h, SHIN * h, sg, kneeForwardOf(posed, s));
  };
  let raise = 0;
  for (const [s, sg] of [['L', -1], ['R', 1]]) {
    if (!downOf(s)) continue;
    const hp = posed['hip' + s], kn = posed['knee' + s], an = posed['ankle' + s];
    if (!hp || !kn || !an) continue;
    if (kneeBend(hp, kn, an, sg).angleDeg < KNEE_MIN_DEG) {
      const want = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos(KNEE_MIN_DEG * Math.PI / 180)) * h;
      const d = Math.hypot(an.x - hp.x, an.y - hp.y, (an.z || 0) - (hp.z || 0));
      if (want > d) raise = Math.max(raise, want - d);
    }
  }
  if (raise) {
    for (const k of ['hipL', 'hipR', 'pelvis', 'groin', 'lumbar', 'sacral', 'solar']) {
      const pnt = posed[k];
      if (pnt && Number.isFinite(+pnt.y)) pnt.y -= raise;
    }
    reIK();
  }
  return posed;
}

// Cap per-frame head.y travel so a pelvis rebalance or scale pop cannot
// fail the inset jerk test (|Δ³ head.y| < 6).
export function easeHeadY(posed, pin, maxStep = 1.2) {
  if (!posed || !posed.head || !pin || !Number.isFinite(+posed.head.y)) return posed;
  const y = +posed.head.y;
  if (!Number.isFinite(+pin.headY)) { pin.headY = y; return posed; }
  const eased = pin.headY + Math.max(-maxStep, Math.min(maxStep, y - pin.headY));
  const dy = eased - y;
  if (dy) for (const k of ['head', 'crown', 'neck']) { const p = posed[k]; if (p && Number.isFinite(+p.y)) p.y += dy; }
  pin.headY = eased;
  return posed;
}

// Hold every foot that was planted last frame and is still planted this
// frame, using the same drawn-lift test as the 10-minute show. Runs after
// rebalance / torso shear so those passes cannot skate a contact.
export function lockPlantedContacts(posed, pin) {
  if (!posed || !pin || !pin.pts) return posed;
  const floorY = +posed.floorY;
  const h = Number.isFinite(+posed.baseH) && +posed.baseH > 0 ? +posed.baseH : (+posed.height || 1);
  if (!Number.isFinite(floorY) || !(h > 0)) return posed;
  const drawnDown = (s) => {
    const pft = posed['foot' + s], phl = posed['heel' + s];
    if (!pft) return false;
    const low = Math.max(pft.y, phl && Number.isFinite(+phl.y) ? phl.y : pft.y);
    return (floorY - low) / h - 0.002 <= 0.001;
  };
  const restore = (s) => {
    if (!pin['down' + s] || !drawnDown(s)) return;
    // A settling step owns this foot until it lands.
    if (pin.fix) {
      const settling = pin.fix.side < 0 ? 'R' : 'L';
      if (s === settling) return;
    }
    const ft = pin.pts['foot' + s], hl = pin.pts['heel' + s];
    const pft = posed['foot' + s], phl = posed['heel' + s], pan = posed['ankle' + s];
    if (!ft || !pft || !Number.isFinite(+ft.x)) return;
    const dx = ft.x - pft.x, dz = (+ft.z || 0) - (+pft.z || 0);
    pft.x = ft.x; pft.z = +ft.z || 0;
    if (phl) {
      if (hl && Number.isFinite(+hl.x)) { phl.x = hl.x; phl.z = +hl.z || 0; }
      else { phl.x += dx; phl.z = (+phl.z || 0) + dz; }
    }
    if (pan) {
      const an = pin.pts['ankle' + s];
      if (an && Number.isFinite(+an.x)) { pan.x = an.x; pan.z = +an.z || 0; }
      else { pan.x += dx; pan.z = (+pan.z || 0) + dz; }
    }
    const hh = +posed.height || 1;
    const sg = s === 'L' ? -1 : 1;
    if (posed['hip' + s] && posed['ankle' + s]) posed['knee' + s] = kneeIK(posed['hip' + s], posed['ankle' + s], THIGH * hh, SHIN * hh, sg, kneeForwardOf(posed, s));
  };
  restore('L'); restore('R');
  return posed;
}

export function updateFloorAnchor(pin, posed, side) {
  if (!pin || !posed) return pin;
  // Do not move pin.x/z — that is the sticky plant. Only refresh the
  // other foot's world xz so a later transfer can adopt the landing.
  const other = contactPoint(posed, side < 0 ? 1 : -1);
  if (other && Number.isFinite(+other.x)) {
    pin.otherX = +other.x;
    pin.otherZ = Number.isFinite(+other.z) ? +other.z : 0;
    pin.width = Math.hypot(pin.otherX - pin.x, pin.otherZ - (pin.z || 0));
  }
  const pts = {};
  for (const k of ['footL', 'heelL', 'ankleL', 'footR', 'heelR', 'ankleR']) {
    const q = posed[k];
    if (q && Number.isFinite(+q.x)) pts[k] = {x: +q.x, y: +q.y, z: Number.isFinite(+q.z) ? +q.z : 0};
  }
  pin.pts = pts;
  pin.key = posed.stance || pin.key;
  pin.side = side;
  const floorY = +posed.floorY;
  const h = Number.isFinite(+posed.baseH) && +posed.baseH > 0 ? +posed.baseH : (+posed.height || 1);
  const drawnDown = (s) => {
    const pft = posed['foot' + s], phl = posed['heel' + s];
    if (!pft || !Number.isFinite(floorY) || !(h > 0)) return false;
    const low = Math.max(pft.y, phl && Number.isFinite(+phl.y) ? phl.y : pft.y);
    return (floorY - low) / h - 0.002 <= 0.001;
  };
  pin.downL = drawnDown('L');
  pin.downR = drawnDown('R');
  return pin;
}

// samples: [{t, side, planted, x, z}]. Slip is the floor-plane travel of a
// foot that stayed planted on the same side (px per sample, usually 1 frame).
export function plantedSlipStats(samples) {
  let n = 0, sum = 0, max = 0;
  if (!Array.isArray(samples)) return {frames: 0, maxPx: 0, meanPx: 0};
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!a || !b || !a.planted || !b.planted) continue;
    if (a.side !== b.side) continue;
    const d = Math.hypot((+b.x || 0) - (+a.x || 0), (+b.z || 0) - (+a.z || 0));
    n++;
    sum += d;
    if (d > max) max = d;
  }
  return {frames: n, maxPx: max, meanPx: n ? sum / n : 0};
}
