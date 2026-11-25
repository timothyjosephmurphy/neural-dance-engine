// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural Dance sticker silhouettes.
// Take a sticker contour, map it through the projector homography, and draw that
// shape as the light on that dancer. The debug light mode is "dot" or "silhouette".
// The fill throbs on the beat: a little larger and brighter, then back to rest.
// A rainbow vibrating string runs head to toe through the figure (TJ, Nov 9
// 4:18 PM), replacing the old waveform ring. Bloom styling still belongs to
// the optional style hook for other callers; the live show uses the string:
//
//   style(pulse, defaults) -> {alpha, stroke, fill, lineWidth, composite}
//
// pulse is {t, age, duration, expansion, band, onset, color, points}.
// expansion stays 0. t is 0 on the beat and approaches 1 as the throb fades.
// band is the dancer's own band (0 kick, 1 bass, 2 snare, 3 hi-hat).
// onset is whatever beat() was given. The room passes the nd_update tone mask
// there. Return a partial object. Omitted fields keep the quiet default.
// Null keeps every default.

import {beatEnvelope, dancerSilhouette, deformSilhouette, uniqueDancerSilhouette, variationFor, plantedSide, legBowPoints, sampleLegBow, footStrikeTravel, footLandmarks, shiftWeight} from './silhouette-dance.js';
import {STRING_ROOT_S, STRING_CROWN_S, STRING_GLOW_WIDTH, STRING_LINE_WIDTH, chakraPoints, drawDancerString, stringAxis, stringPoints, pulseStringPoints, pulseTravelTimes, pulseFront, pulseDriveHz, PULSE_AMP_FRAC, stringAmplitude, sampleLevel, stringActivation, bandMode, bandVisHz} from './vibrating-string.js';
import {dancerHueCss, dancerHueRgb, stringTintMix} from './dancer-hue.js';
import {compensatePulseColor, pulseVisibility} from './pulse-visibility.js';
import {yawExtent, armPulse, bodyPulseLights, armSwing, armLiftAmount, armLiftFamilyFor, armLiftPhraseIndex, buildFor, insetRects, paintArmPulses, paintShadowFigure, paintSilhouetteHalo, placePose, placePoseOnFloor, stanceKey, nextFloorAnchor, stepGate, chakraAnchors, uprightTorso, torsoLeanLimit, updateFloorAnchor, lockPlantedContacts, squareHipsToPlantedFeet, ensureMinKneeAngle, easeHeadY, holdGroundedFoot, rebalancePosed, isJumpBeat, jumpLift, skeletonPose, smoothArmActivation, stepFrac, stepWeight, tallStandAt, haloAuraScale, HEART_S, INSET_MAX, PULSE_SOFT, STOMP_SOFT, stompIntensity, STOMP_PEAK, HIP_EIGHT, SHOULDER_EIGHT, HIP_TWIST, SHOULDER_TWIST, MAX_BODY_TURN_DEG, TURN_FREQ, EIGHT_DEPTH, EIGHT_VERT, VOLUME_LOD_PX, STANCE_SH_CALM, STANCE_HIP_REST, maxStanceHalf, minStanceHalf, restStanceHalf, projectedStanceWidth, GROOVE_DEFAULT_BPM, hipWidth, STANCE_HIP_MIN, STANCE_SH_MAX} from './skeleton-dancer.js';
import {chakraHueAt} from './body-shell.js';
import {footworkPlan, publishFootworkPose, resetFootwork} from './footwork-steps.js';
import {travelFacingOf, rotateFacing} from './skeleton-motion.js';
import {applyHomography, clamp, smoothstep} from './geometry.js';
export {applyHomography};
import {createSongEnergy, createDancerEnergy, dancerIntake, ARM_LIFT_FULL} from './song-energy.js';
import {createStickerPoseCache, createStickerPoseBlend, stickerPoseTarget, blendStickerPose, phraseBarsFor} from './sticker-pose.js';
import {stompPlantsFromFigure} from './water-ripple.js';
import {createSectionMotion} from './section-motion.js';
import {createEnergyTracker, createGrooveAccent, createSnarePattern, hipEnergyScale, armSwell, melodicSustain, armEnergyDrive, clapEligible, clapEnvelope, easeWindowS, swayRate, CLAP_RIPPLE} from './energy-motion.js';

export const LIGHT_MODES = ['dot', 'silhouette'];
export const PULSE_REACH = 36;
// Waveform ripple on the outline, stage px. 8 until Nov 9 (TJ: more subtle).
export const PULSE_WAVE_GAIN = 5;
// Silhouette aura (TJ, Nov 9 3:49 PM: tone it down, keep it calm as dancers
// and stickers add up). Base softness, then 3/n past three figures, floored.
export const SILHOUETTE_GLOW = 0.55;
export const GLOW_CROWD_FREE = 3;
export const GLOW_CROWD_FLOOR = 0.25;
export function silhouetteGlow(count) {
  const n = Math.max(1, +count || 1);
  return SILHOUETTE_GLOW * Math.max(GLOW_CROWD_FLOOR, Math.min(1, GLOW_CROWD_FREE / n));
}
export const SILHOUETTE_THROB = 0.14;
export const SILHOUETTE_REST_ALPHA = 0.72;
export const SILHOUETTE_BEAT_ALPHA = 0.88;
// Dark translucent shadow body — lit from within by the chakra string (TJ 5:22 PM).
export const SILHOUETTE_SHADOW = 'rgba(6, 8, 14, 0.78)';
export const SILHOUETTE_RIM = 'rgba(180, 210, 255, 0.22)';
export const SILHOUETTE_LIGHT = SILHOUETTE_SHADOW; // legacy name → shadow
export const INNER_GLOW_DIM = 0.65; // ~35% dimmer inner/chakra glow (TJ 5:38 PM)
// TJ 6:14 PM: the string and its inner glow overwhelmed the shadow body.
// ~45% dimmer; colors and shape unchanged.
export const STRING_DIM = 0.55;
// Beat tiers (TJ 6:03 PM): a band's own beats while fresh, else the global
// beat while fresh, else (only after >3 s of silence) a steady 100 BPM.
export const BEAT_FRESH_MS = 3000;
export const IDLE_INTERVAL_MS = 600;

export function dancerMotionClock(now, band = {}, global = {}) {
  const t = +now || 0;
  const bAt = Number.isFinite(+band.at) ? +band.at : -1;
  const bStrike = Number.isFinite(+band.strikeAt) ? +band.strikeAt : -1;
  const gAt = Number.isFinite(+global.at) ? +global.at : -1;
  if (bStrike >= 0 && bAt >= 0 && t - bAt <= BEAT_FRESH_MS) {
    const iv = Math.max(180, +band.interval || 520);
    const period = Math.max(1, iv * strikeStride(iv));
    return {tier: 'band', period, origin: bStrike, shiftT: clamp01((t - bStrike) / period),
      beat: band.strikeCount | 0, strikeAt: bStrike, strikeDur: Math.max(280, +band.strikeDur || period * 0.92)};
  }
  if (gAt >= 0 && t - gAt <= BEAT_FRESH_MS) {
    const iv = Math.max(180, +global.interval || 520);
    const stride = strikeStride(iv);
    const idx = global.index | 0;
    const period = Math.max(1, iv * stride);
    // Strike on every stride-th global beat; hold the land until the next.
    const strikeAt = Number.isFinite(+global.strikeAt) && global.strikeAt >= 0 ? +global.strikeAt : gAt;
    return {tier: 'global', period, origin: strikeAt, shiftT: clamp01((t - strikeAt) / period),
      beat: Math.floor(idx / stride), strikeAt, strikeDur: Math.max(280, period * 0.92)};
  }
  const lastAny = Math.max(bAt, gAt);
  const silentFor = lastAny >= 0 ? t - lastAny : t;
  if (silentFor > BEAT_FRESH_MS) {
    const period = IDLE_INTERVAL_MS;
    const n = Math.floor(t / period);
    const origin = n * period;
    return {tier: 'idle', period, origin, shiftT: clamp01((t - origin) / period), beat: n, strikeAt: origin, strikeDur: period * 0.92};
  }
  return {tier: 'rest', period: IDLE_INTERVAL_MS, origin: t, shiftT: 0, beat: 0, strikeAt: -1, strikeDur: 600};
}

function clamp01(v) { return clamp(+v || 0, 0, 1); }

// ND Listen v2 (groove-wire.js): info.phrase.start marks a confident phrase
// downbeat. Moves a band clock's step count so the dancer's phrase (moves,
// sticker phrase, arm phrase: all count strikes in 4s / 8s / 16s) restarts
// on it. Only even jumps (the planted foot keeps its side); an odd one holds
// this one step instead (true = skip the strike), so the next phrase start
// jumps even. No phrase info (low confidence, ?groove=0): no change.
export function phraseHold(c, info, stride) {
  const ph = info && info.phrase;
  if (!ph || !ph.start || !(c.strikeCount > 0)) return false;
  const L = Math.min(32, Math.max(4, Math.round((ph.phraseBars || 8) * 4 / Math.max(1, stride))));
  const r = (c.strikeCount + 1) % L, j = r ? L - r : 0;
  if (j % 2 === 0) { c.strikeCount += j; return false; }
  return true;
}

// Strike progress at which the foot-strike pulse reaches the heart chakra.
let heartStrikeU = -1;
export function heartStrikeProgress() {
  if (heartStrikeU >= 0) return heartStrikeU;
  for (let i = 0; i <= 400; i++) {
    const u = i / 400;
    const tr = footStrikeTravel(u);
    if (tr.phase === 'string' && tr.stringS >= HEART_S) { heartStrikeU = u; return u; }
  }
  heartStrikeU = 0.6;
  return heartStrikeU;
}

// Backing card (lit-floor tone) so the dark inset body reads over ripples.
// Corner inset labels (TJ 7:04 PM): band name + dancer number, and a tiny
// matching number tag by the stage dancer it mirrors.
export const BAND_LABELS = ['Kick', 'Bass', 'Mid', 'High'];
// Inset tempo line (TJ 7:13 PM): "Kick · 124 BPM" from that band's own
// tracker when locked; "shared" when the band rides the shared clock; "—"
// otherwise. meter is a reserved slot for pattern learning (not guessed).
export function tempoReadout({band = 0, tier = 'idle', locked = false, period = 0, meter = '', ratio = ''} = {}) {
  const name = BAND_LABELS[((band | 0) % 4 + 4) % 4];
  let tempo = '\u2014';
  if (tier === 'band') tempo = locked && period > 0 ? Math.round(60000 / period) + ' BPM' + (ratio && ratio !== '1' ? ' (\u00d7' + ratio + ')' : '') : '\u2014 BPM';
  else if (tier === 'global') tempo = 'shared';
  // Listen v2 (flagged) meters: '7/8 (3+2+2)', '4/4 swing'.
  const m = typeof meter === 'string' && /^\d{1,2}\/\d{1,2}(?: \([2-4](?:\+[2-4]){1,7}\)| swing)?$/.test(meter) ? ' \u00b7 ' + meter : '';
  return name + ' \u00b7 ' + tempo + m;
}
export function insetLabel(id, band) {
  return (BAND_LABELS[((band | 0) % 4 + 4) % 4]) + ' \u00b7 #' + (id | 0);
}
function paintSmallText(ctx, text, x, y, {px = 11, color = '#cfd6e6', alpha = 0.7, align = 'left'} = {}) {
  if (!ctx || typeof ctx.fillText !== 'function') return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.font = '600 ' + Math.round(px) + 'px system-ui, sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(8, 10, 16, 0.8)';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function paintInsetPanel(ctx, rect) {
  if (!ctx || typeof ctx.beginPath !== 'function') return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(58, 66, 88, 0.9)'; // lit-floor tone so the dark body reads
  ctx.beginPath();
  ctx.moveTo(rect.x, rect.y);
  ctx.lineTo(rect.x + rect.w, rect.y);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
  ctx.lineTo(rect.x, rect.y + rect.h);
  ctx.closePath();
  ctx.fill();
  if (typeof ctx.strokeRect === 'function') {
    ctx.strokeStyle = 'rgba(170, 195, 245, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
  ctx.restore();
}

// Live tuning that reaches the dancers (debug panel / room sliders):
// per-band sensitivity (0 mutes) and the quiet threshold gate each band's
// string; bloom intensity/aura set the inner glow and string bloom.
export const BLOOM_INTENSITY_DEFAULT = 0.18; // ~0.15–0.2 of the old default 1 (TJ 7:39 PM)
export const BLOOM_INTENSITY_MIN = 0; // 0 = no halo at all (TJ 11:22 AM)
export const BLOOM_INTENSITY_MAX = 2;
export const DEFAULT_SHOW_TUNING = Object.freeze({sens: [1, 1, 1, 1], quiet: 0, bloomEnabled: true, bloomIntensity: BLOOM_INTENSITY_DEFAULT, bloomAura: 22, hueSpread: 0.10, hipEight: HIP_EIGHT, shoulderEight: SHOULDER_EIGHT, hipTwist: HIP_TWIST, shoulderTwist: SHOULDER_TWIST, maxBodyTurn: MAX_BODY_TURN_DEG, turnFreq: TURN_FREQ, eightDepth: EIGHT_DEPTH, eightVert: EIGHT_VERT, armPadSense: 1, raveMoves: 1, innerBones: 1, headLook: true});
// Inner bones quality (side-sim parity): 0 off, 1 stage (camera-sticker /
// real dancers, default), 2 all figures including the seed sims.
export const INNER_BONES_MODES = Object.freeze(['off', 'stage', 'all']);
export function innerBonesMode(tune) { const v = tune && Number.isFinite(+tune.innerBones) ? Math.round(+tune.innerBones) : 1; return INNER_BONES_MODES[Math.max(0, Math.min(2, v))]; }
export function cleanShowTuning(next, prev = DEFAULT_SHOW_TUNING) {
  const n = next || {};
  const num = (v, lo, hi, d) => (v == null || v === '' || !Number.isFinite(+v)) ? d : Math.max(lo, Math.min(hi, +v));
  const sens = [0, 1, 2, 3].map(i => num(Array.isArray(n.sens) ? n.sens[i] : undefined, 0, 3, prev.sens[i]));
  return {
    sens,
    quiet: num(n.quiet, 0, 0.4, prev.quiet),
    bloomEnabled: n.bloomEnabled === true || n.bloomEnabled === false ? n.bloomEnabled : prev.bloomEnabled,
    bloomIntensity: num(n.bloomIntensity, BLOOM_INTENSITY_MIN, BLOOM_INTENSITY_MAX, prev.bloomIntensity),
    bloomAura: num(n.bloomAura, 8, 64, prev.bloomAura),
    hueSpread: num(n.hueSpread, 0, 1, prev.hueSpread),
    hipEight: num(n.hipEight, 0, 1.5, prev.hipEight ?? HIP_EIGHT),
    shoulderEight: num(n.shoulderEight, 0, 1.5, prev.shoulderEight ?? SHOULDER_EIGHT),
    hipTwist: num(n.hipTwist, 0, 1.5, prev.hipTwist ?? HIP_TWIST),
    shoulderTwist: num(n.shoulderTwist, 0, 1.5, prev.shoulderTwist ?? SHOULDER_TWIST),
    maxBodyTurn: num(n.maxBodyTurn, 0, 90, prev.maxBodyTurn ?? MAX_BODY_TURN_DEG),
    turnFreq: num(n.turnFreq, 0, 1.5, prev.turnFreq ?? TURN_FREQ),
    eightDepth: num(n.eightDepth, 0, 1.5, prev.eightDepth ?? EIGHT_DEPTH),
    eightVert: num(n.eightVert, 0, 1.5, prev.eightVert ?? EIGHT_VERT),
    armPadSense: num(n.armPadSense, 0, 2, prev.armPadSense ?? 1),
    raveMoves: num(n.raveMoves, 0, 1.5, prev.raveMoves ?? 1),
    innerBones: Math.round(num(n.innerBones, 0, 2, prev.innerBones ?? 1)),
    headLook: n.headLook === true || n.headLook === false ? n.headLook : (prev.headLook ?? true)
  };
}
// Band string drive: sens scales the band envelope/level (0 → still string),
// quiet subtracts a floor so soft passages leave that band's string at rest.
export function bandStringDrive(tune, band, envelope, level) {
  const t = tune || DEFAULT_SHOW_TUNING;
  const sens = t.sens[((band | 0) % 4 + 4) % 4];
  const q = t.quiet;
  const gate = v => {
    const x = Math.max(0, Math.min(1, (+v || 0) * sens));
    return q > 0 ? Math.max(0, (x - q) / (1 - q)) : x;
  };
  // Pulse size: linear to 1×, then gently up to 1.5× at 3× (the lateral cap still holds).
  const ampScale = sens <= 1 ? sens : 1 + (sens - 1) * 0.25;
  return {envelope: gate(envelope), level: gate(level), ampScale, sens};
}
// Bloom → silhouette glow: intensity scales glow alpha, aura (px, 22 default) its radius/width.
// Fine line for small projections (TJ 11:22 AM): the string core is ~1% of
// the figure's on-screen height, clamped to a crisp 0.8–1.8 px, and every
// glow (string bloom pass, chakra-node aura, arm-bead aura, leg-pulse
// gradient) scales from that core by the bloom slider — 0 means none.
export const FINE_LINE_FRAC = 0.010;
export const FINE_LINE_MIN = 0.8;
export const FINE_LINE_MAX = 1.8;
export function fineLineWidth(heightPx) {
  const h = Number.isFinite(+heightPx) ? +heightPx : 120;
  return Math.max(FINE_LINE_MIN, Math.min(FINE_LINE_MAX, h * FINE_LINE_FRAC));
}
// Glow geometry for the string and nodes from bloom tuning + core width.
export function fineGlow(tune, coreW) {
  const t = tune || DEFAULT_SHOW_TUNING;
  const on = t.bloomEnabled !== false;
  const intensity = on ? Math.max(0, +t.bloomIntensity || 0) : 0;
  const auraK = (Number.isFinite(+t.bloomAura) ? +t.bloomAura : 22) / 22;
  // 0 at bloom 0, 1 at the default, capped 1.5 near max.
  const aura = Math.min(1.5, intensity / BLOOM_INTENSITY_DEFAULT);
  const glowWidth = intensity > 0 ? coreW * (1.6 + 1.4 * Math.min(1, intensity)) * auraK : 0;
  return {intensity, aura, glowWidth, glowAlpha: Math.min(1, intensity), crisp: !(intensity > 0)};
}
export function silhouetteBloom(tune) {
  const t = tune || DEFAULT_SHOW_TUNING;
  if (t.bloomEnabled === false) return {glow: 0, radius: 1, width: 0.6, alpha: 0.5};
  const r = t.bloomAura / 22;
  return {glow: t.bloomIntensity, radius: r, width: r, alpha: t.bloomIntensity};
}

function paintFigureGlow(ctx, lights, dim, radiusScale = 1) {
  if (!ctx || !lights || !lights.length || typeof ctx.createRadialGradient !== 'function') return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const light of lights) {
    if (!light || !Number.isFinite(+light.x) || !Number.isFinite(+light.y)) continue;
    const r = Math.max(10, (+light.radius || 4) * 5.5) * radiusScale;
    const g = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
    g.addColorStop(0, light.color || '#fff');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    if (!(dim > 0)) continue;
    ctx.globalAlpha = Math.max(0.01, Math.min(0.45, (+light.alpha || 0.6) * 0.42 * dim));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(light.x, light.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
export const HUSH_EASE_MS = 500;
const HUSHED_MOTION = Object.freeze({tier: 'rest', period: 600, origin: 0, shiftT: 0, beat: 0, strikeAt: -1, strikeDur: 600});
export const FAST_STRIKE_MS = 400; // faster than this → one strike every 2 beats
export function strikeStride(interval) {
  return (+interval || 0) < FAST_STRIKE_MS ? 2 : 1;
}

export function contourArea(points) {
  if (!points || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    if (!p || !q) continue;
    area += (+p.x || 0) * (+q.y || 0) - (+q.x || 0) * (+p.y || 0);
  }
  return Math.abs(area) * 0.5;
}

// Body sway / bob / limb deform / beat throb run this many times slower than
// the beat clock. The vibrating string keeps the fast envelope (TJ 5:01 PM).
export const BODY_MOTION_SLOWDOWN = 4;
export const BODY_MOTION_SMOOTH = 0.22; // low-pass mix toward the slowed envelope

export function throbAmount(envelope) {
  const e = +envelope;
  if (!Number.isFinite(e) || e < 0) return 0;
  if (e > 1) return 1;
  return e;
}

export function throbScale(envelope) {
  return 1 + SILHOUETTE_THROB * throbAmount(envelope);
}

export function throbAlpha(envelope) {
  const e = throbAmount(envelope);
  return SILHOUETTE_REST_ALPHA + (SILHOUETTE_BEAT_ALPHA - SILHOUETTE_REST_ALPHA) * e;
}

export function normalizeLightMode(mode) {
  return mode === 'silhouette' ? 'silhouette' : 'dot';
}

export function simplifyContour(points, maxPoints = 48) {
  const clean = [];
  for (const point of points || []) {
    if (!point || !Number.isFinite(+point.x) || !Number.isFinite(+point.y)) continue;
    const next = {x: +point.x, y: +point.y};
    const prev = clean[clean.length - 1];
    if (prev && prev.x === next.x && prev.y === next.y) continue;
    clean.push(next);
  }
  if (clean.length < 3) return [];
  const cap = Math.max(3, maxPoints | 0);
  if (clean.length <= cap) return clean;
  const out = [];
  for (let i = 0; i < cap; i++) {
    const index = Math.round(i * (clean.length - 1) / (cap - 1));
    out.push(clean[index]);
  }
  return out;
}

export function sanitizeContour(contour, maxPoints = 64) {
  const simple = simplifyContour(contour, maxPoints);
  return simple.length >= 3 ? simple : null;
}

export function projectContour(contour, homography) {
  const clean = sanitizeContour(contour, 96);
  if (!clean) return null;
  const project = typeof homography === 'function'
    ? homography
    : (x, y) => applyHomography(homography, x, y);
  const out = [];
  for (const point of clean) {
    let mapped = null;
    try {
      mapped = project(point.x, point.y);
    } catch {
      mapped = null;
    }
    if (!mapped || !Number.isFinite(+mapped.x) || !Number.isFinite(+mapped.y)) continue;
    out.push({x: +mapped.x, y: +mapped.y});
  }
  return out.length >= 3 ? out : null;
}

const TRACE_DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1]
];

// Moore neighborhood around one filled component. Seed may sit inside the blob.
export function traceContour(mask, width, height, seed, maxPoints = 48) {
  const w = width | 0;
  const h = height | 0;
  if (!mask || w < 1 || h < 1 || !seed) return [];
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 0;
  let sx = seed.x | 0;
  let sy = seed.y | 0;
  if (!inside(sx, sy)) return [];
  while (sx > 0 && inside(sx - 1, sy)) sx--;
  const startX = sx;
  const startY = sy;
  const contour = [{x: startX, y: startY}];
  let cx = startX;
  let cy = startY;
  let back = 4;
  const limit = w * h;
  for (let step = 0; step < limit; step++) {
    let found = -1;
    for (let k = 0; k < 8; k++) {
      const dir = (back + 1 + k) % 8;
      const nx = cx + TRACE_DIRS[dir][0];
      const ny = cy + TRACE_DIRS[dir][1];
      if (inside(nx, ny)) {
        found = dir;
        break;
      }
    }
    if (found < 0) break;
    cx += TRACE_DIRS[found][0];
    cy += TRACE_DIRS[found][1];
    back = (found + 4) % 8;
    if (cx === startX && cy === startY) break;
    contour.push({x: cx, y: cy});
  }
  return simplifyContour(contour, maxPoints);
}

export function centroid(points) {
  let x = 0;
  let y = 0;
  const n = points.length || 1;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return {x: x / n, y: y / n};
}

function outwardNormals(points) {
  const center = centroid(points);
  const normals = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    let nx = -ty;
    let ny = tx;
    const vx = points[i].x - center.x;
    const vy = points[i].y - center.y;
    if (nx * vx + ny * vy < 0) {
      nx = -nx;
      ny = -ny;
    }
    normals.push({x: nx, y: ny});
  }
  return normals;
}

// distance is one radius, or one radius per vertex, along the outward normal.
export function offsetContour(points, distance) {
  if (!points || points.length < 3) return null;
  const normals = outwardNormals(points);
  const perVertex = Array.isArray(distance);
  return points.map((point, index) => {
    const radius = perVertex ? +distance[index] || 0 : +distance || 0;
    return {
      x: point.x + normals[index].x * radius,
      y: point.y + normals[index].y * radius
    };
  });
}

function waveSample(samples, index, count) {
  if (!samples || !samples.length || !(count > 0)) return 0;
  const at = Math.floor((index / count) * samples.length) % samples.length;
  let sample = +samples[at] || 0;
  if (sample > 1) sample = 1;
  if (sample < -1) sample = -1;
  return sample;
}

// expansion 0 and a silent waveform sit on the outline. Samples ripple that offset.
export function waveformContour(points, expansion, samples, gain = PULSE_WAVE_GAIN) {
  const clean = sanitizeContour(points, 128);
  if (!clean) return null;
  const base = +expansion || 0;
  const amp = Number.isFinite(+gain) ? +gain : 0;
  const distances = clean.map((_, index) => base + waveSample(samples, index, clean.length) * amp);
  return offsetContour(clean, distances);
}

export function placeContour(points, x, y, scale = 1) {
  const clean = sanitizeContour(points, 128);
  if (!clean) return null;
  const center = centroid(clean);
  const s = Number.isFinite(+scale) && +scale !== 0 ? +scale : 1;
  return clean.map(point => ({
    x: x + (point.x - center.x) * s,
    y: y + (point.y - center.y) * s
  }));
}

function tracePath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

// Dark translucent shadow body with a faint cool rim (TJ 5:22 PM).
// Inner chakra glow is painted separately (clipped to the silhouette).
export function paintSilhouette(ctx, points, options = {}) {
  if (!ctx || !points || points.length < 3) return false;
  const color = options.color || SILHOUETTE_SHADOW;
  const alpha = Number.isFinite(+options.alpha) ? +options.alpha : SILHOUETTE_REST_ALPHA;
  const rim = options.rimColor || SILHOUETTE_RIM;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Shadow fill — never bright white.
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = color;
  tracePath(ctx, points);
  ctx.fill();
  // Faint rim so the figure reads on a dark floor.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rim;
  ctx.globalAlpha = Math.max(0.08, Math.min(0.35, alpha * 0.28));
  ctx.lineWidth = 3.2;
  tracePath(ctx, points);
  ctx.stroke();
  ctx.restore();
  return true;
}

// Soft inner glow from chakra nodes, clipped to the silhouette path.
export function paintInnerChakraGlow(ctx, points, lights, options = {}) {
  if (!ctx || !points || points.length < 3 || !lights || !lights.length) return false;
  if (typeof ctx.createRadialGradient !== 'function') return false;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  tracePath(ctx, points);
  ctx.clip();
  for (const light of lights) {
    if (!light || !Number.isFinite(+light.x) || !Number.isFinite(+light.y)) continue;
    const r = Math.min(90, Math.max(18, (+light.radius || 4) * 9)); // capped glow radius
    const a = Math.max(0.08, Math.min(0.36, (+light.alpha || 0.6) * 0.7 * INNER_GLOW_DIM));
    const g = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
    const col = compensatePulseColor(light.color || '#fff');
    g.addColorStop(0, col);
    g.addColorStop(0.35, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(light.x, light.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Soft string-axis wash (faint) down the torso center.
  if (lights.length >= 2) {
    const top = lights.reduce((p, q) => (q.y < p.y ? q : p), lights[0]);
    const bot = lights.reduce((p, q) => (q.y > p.y ? q : p), lights[0]);
    const midX = (top.x + bot.x) * 0.5;
    const midY = (top.y + bot.y) * 0.5;
    const hr = Math.hypot(bot.x - top.x, bot.y - top.y) * 0.55 || 40;
    const g2 = ctx.createRadialGradient(midX, midY, 0, midX, midY, hr);
    const wash = options.familyRgb || null;
    const washCol = wash
      ? 'rgba(' + Math.round(wash.r * 255) + ',' + Math.round(wash.g * 255) + ',' + Math.round(wash.b * 255) + ',0.22)'
      : 'rgba(180,220,255,0.12)';
    g2.addColorStop(0, washCol);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.22 * INNER_GLOW_DIM;
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(midX, midY, hr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return true;
}

// Leg arc waypoints: foot → knee → groin → knee → foot. The groin point leans
// a touch toward the planted side (side-sim G = groin + weight·16 px).
export function legArcPoints(pose, planted = 0) {
  if (!pose || !pose.footL || !pose.kneeL || !pose.groin || !pose.kneeR || !pose.footR) return [];
  const h = pose.height > 0 ? pose.height : Math.abs(pose.footL.y - pose.groin.y) * 2;
  const w = Math.max(-1, Math.min(1, +planted || 0));
  const G = {x: pose.groin.x + w * h * 0.03, y: pose.groin.y};
  return [pose.footL, pose.kneeL, G, pose.kneeR, pose.footR].map(p => ({x: p.x, y: p.y}));
}
// Catmull-Rom through the waypoints, so the arc passes exactly through each.
export function sampleLegArc(points, perSeg = 6) {
  if (!points || points.length < 2) return [];
  const out = [{x: points[0].x, y: points[0].y}];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 1; j <= perSeg; j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      });
    }
  }
  return out;
}
// Subtle, steady root-red arc (two low-alpha passes, like the side-sim bow).
export function paintLegArc(ctx, points, options = {}) {
  if (!ctx || !points || points.length < 2) return false;
  const pts = sampleLegArc(points, 6);
  const alpha = Math.max(0.05, Math.min(0.22, +options.alpha || 0.12));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = options.color || 'rgb(180, 70, 58)';
  for (const [width, a] of [[3.2, alpha * 0.4], [1.05, alpha]]) {
    ctx.globalAlpha = a;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
  return true;
}

// Glowing curved bow from foot to foot; apex leans toward the planted foot.
export function paintLegBow(ctx, bow, options = {}) {
  if (!ctx || !bow || !bow.left || !bow.right || !bow.apex) return false;
  if (typeof ctx.quadraticCurveTo !== 'function' && typeof ctx.bezierCurveTo !== 'function') {
    // Fall back to sampled polyline for stub canvases.
  }
  // Subtle, steady bow — blended into the shadow, never a popping red band.
  const alpha = Math.max(0.05, Math.min(0.22, +options.alpha || 0.12));
  const color = options.color || 'rgb(180, 70, 58)';
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha * 0.4;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(bow.left.x, bow.left.y);
  if (typeof ctx.quadraticCurveTo === 'function') {
    ctx.quadraticCurveTo(bow.apex.x, bow.apex.y, bow.right.x, bow.right.y);
  } else {
    for (const pt of sampleLegBow(bow, 12)) ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  // Thin core.
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  ctx.moveTo(bow.left.x, bow.left.y);
  if (typeof ctx.quadraticCurveTo === 'function') {
    ctx.quadraticCurveTo(bow.apex.x, bow.apex.y, bow.right.x, bow.right.y);
  } else {
    for (const pt of sampleLegBow(bow, 12)) ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.restore();
  return true;
}

// Energy streak from planted foot up the leg toward the root (groin).
export function paintLegEnergy(ctx, foot, root, u, options = {}) {
  if (!ctx || !foot || !root) return false;
  // u=0 is the heel-contact frame: still draw a flash at the foot so the
  // pulse launches on the same frame the striking foot plants.
  if (!Number.isFinite(+u) || +u < 0) return false;
  const t = Math.max(0, Math.min(1, +u || 0));
  const x = foot.x + (root.x - foot.x) * t;
  const y = foot.y + (root.y - foot.y) * t;
  const vis = pulseVisibility(options.color || 'rgb(255, 84, 56)');
  const color = vis.css;
  const soft = Number.isFinite(+options.soft) ? +options.soft : PULSE_SOFT;
  const minR = Number.isFinite(+options.minRadius) ? +options.minRadius : 6;
  const r = Math.max(minR, (+options.radius || 10) * vis.coreScale * (0.7 + 0.6 * (1 - Math.abs(t - 0.55))));
  // Bloom 0: crisp trail + a small solid head, no gradient glow.
  const crisp = options.crisp === true;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // Trail along the leg (nothing to trail at t=0).
  if (t > 0) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = Math.min(1, (crisp ? 0.5 : 0.22) * soft * vis.alphaScale);
    ctx.lineWidth = (Number.isFinite(+options.lineWidth) ? +options.lineWidth : 3.2) * vis.trailScale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(foot.x, foot.y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  // Head of the pulse — including a heel flash at t=0.
  if (!crisp && typeof ctx.createRadialGradient === 'function') {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = Math.min(1, 0.45 * soft * vis.alphaScale);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (typeof ctx.arc === 'function') {
    ctx.globalAlpha = Math.min(1, (crisp ? 0.9 : 0.7) * soft * vis.alphaScale);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return true;
}

// Quiet semi-transparent bloom. Another pass replaces this through the style hook.
export function defaultBloomStyle(pulse) {
  const t = Math.max(0, Math.min(1, +pulse.t || 0));
  const fade = 1 - t;
  const color = pulse.color || SILHOUETTE_LIGHT;
  return {
    alpha: 0.34 * fade,
    stroke: color,
    fill: color,
    lineWidth: 2 + 5 * fade,
    composite: 'lighter'
  };
}

function contourPath(points) {
  const path = new Path2D();
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  path.closePath();
  return path;
}

export function paintBloom(ctx, points, pulse, style) {
  if (!ctx || !points || points.length < 3) return false;
  const defaults = defaultBloomStyle(pulse || {});
  let look = defaults;
  if (typeof style === 'function') {
    let extra = null;
    try {
      extra = style(pulse, defaults);
    } catch {
      extra = null;
    }
    if (extra && typeof extra === 'object') look = {...defaults, ...extra};
  }
  // The room's bloom style hook asks for NeuralDanceRings.bloomStroke.
  // A style that only overrides alpha or color keeps the quiet fill below.
  if (look.bloomStroke === true) {
    const api = typeof globalThis !== 'undefined' ? globalThis.NeuralDanceRings : null;
    const color = look.stroke || defaults.stroke;
    if (api && typeof api.paintEnergyBloom === 'function') {
      api.paintEnergyBloom(ctx, points, color, !!look.low, Number.isFinite(+look.glow) ? +look.glow : (pulse && Number.isFinite(+pulse.glow) ? +pulse.glow : 1));
      return true;
    }
    if (api && typeof api.bloomStroke === 'function' && typeof Path2D === 'function') {
      api.bloomStroke(ctx, contourPath(points), color, !!look.low);
      return true;
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = look.composite || 'lighter';
  ctx.globalAlpha = Math.max(0, Math.min(1, +look.alpha || 0));
  ctx.fillStyle = look.fill || defaults.fill;
  ctx.strokeStyle = look.stroke || defaults.stroke;
  ctx.lineWidth = Number.isFinite(+look.lineWidth) ? +look.lineWidth : defaults.lineWidth;
  ctx.lineJoin = 'round';
  tracePath(ctx, points);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  return true;
}

// Area centroid (the same "center" the detector reports for a sticker: the
// mean of its dark pixels). The vertex mean drifts toward whichever side of a
// traced outline has more points.
export function areaCentroid(points) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = points ? points.length : 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) return n ? centroid(points) : {x: 0, y: 0};
  return {x: cx / (3 * a), y: cy / (3 * a)};
}

// TJ 4:03 PM: the silhouette has to sit on the sticker. The latched marker
// point is held steady, but its outline is re-traced every frame and can be a
// fragment (part of the sticker under its own projected glow), which pulled
// the drawn figure off to one side. The outline keeps its shape; its center is
// always the marker's.
export function centerOn(points, x, y) {
  if (!points || points.length < 3 || !Number.isFinite(+x) || !Number.isFinite(+y)) return points;
  const c = areaCentroid(points);
  const dx = +x - c.x;
  const dy = +y - c.y;
  return points.map(p => ({x: p.x + dx, y: p.y + dy}));
}

function spanY(points) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return hi > lo ? hi - lo : 0;
}

function spanX(points) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  return hi > lo ? hi - lo : 0;
}

export function figureHeight(points) {
  return points && points.length ? spanY(points) : 0;
}

export function figureWidth(points) {
  return points && points.length ? spanX(points) : 0;
}

// Full human shadow: ~7–7.5 heads tall, legs ~half the height (TJ 4:23 PM).
export const HUMAN_HEADS = 7.25;
export const HUMAN_LEG_SHARE = 0.5;
export const FULL_FIGURE_MIN_RATIO = 0.82;
export const FULL_FIGURE_MIN_ASPECT = 1.55; // height / width

// Untraced stickers and sim dancers use the template. Its scale follows the
// traced sticker figures on stage (median height) so sims are not bigger than
// the real dancers; 1.7 when nothing has been traced.
export const TEMPLATE_SCALE = 1.7;
export function templateScale(markers) {
  const tall = [];
  for (const m of markers || []) {
    if (!m || m.kind === 'pink' || m.kind === 'sim') continue;
    const traced = sanitizeContour(m.contour);
    if (traced) tall.push(spanY(traced));
  }
  const base = spanY(dancerSilhouette());
  if (!tall.length || !(base > 0)) return TEMPLATE_SCALE;
  tall.sort((a, b) => a - b);
  return tall[tall.length >> 1] / base;
}

// Truncated (cut off at the knees) or blob-like captures need the template.
export function isTruncatedOrBlob(points, targetHeight) {
  const clean = sanitizeContour(points);
  if (!clean) return true;
  const h = figureHeight(clean);
  const w = figureWidth(clean);
  if (!(h > 0)) return true;
  if (Number.isFinite(+targetHeight) && +targetHeight > 0 && h < +targetHeight * FULL_FIGURE_MIN_RATIO) return true;
  if (h / Math.max(1, w) < FULL_FIGURE_MIN_ASPECT) return true;
  return false;
}

// Shared full-figure height for sims and stickers: median traced sticker
// height (via templateScale). Sims must match sticker dancers — never float
// above them on the TEMPLATE_SCALE floor when real stickers are smaller
// (TJ 4:59 PM on dace406).
export function crowdFullHeight(markers) {
  return medianStickerHeight(markers);
}

// Median traced sticker height in stage px. Sims match this. Stickers keep
// their own traced height (never inflate to TEMPLATE_SCALE) — TJ 5:05 PM.
// TJ 6:28 PM (da32850): sims rendered far larger than the stickers. Heights
// are stage px, but traced contours are projected through the camera quad, so
// a stretched/off quad can inflate them. Sizes are now bounded to the 66d1597
// no-sticker size (template × 1.7 = 149.6 stage px) and never grow with the quad.
// TJ 6:48 PM (eca5b0d, far camera): dancers still read too big and clumped.
// Default/max is now 90 stage px (~60% of the old 149.6 = template × 1.7).
export const LEGACY_FIGURE_HEIGHT = 88 * TEMPLATE_SCALE; // 66d1597 size, stage px
export const DEFAULT_FIGURE_HEIGHT = 90;
export const MIN_FIGURE_HEIGHT = 24;
// Real cutout stickers are ~17–20% of the 620 px stage (~105–125 px). The old
// 90 px cap shrunk them. Wild traces above this ceiling are still ignored.
export const MAX_FIGURE_HEIGHT = 220;
export const UNSCANNED_FIGURE_HEIGHT = 125;
export function clampFigureHeight(h) {
  const v = +h;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_FIGURE_HEIGHT;
  return Math.max(MIN_FIGURE_HEIGHT, Math.min(MAX_FIGURE_HEIGHT, v));
}
export function medianStickerHeight(markers, fallback) {
  const tall = [];
  for (const m of markers || []) {
    if (!m || m.kind === 'pink' || m.kind === 'sim') continue;
    const projected = +m.projectedHeight;
    if (projected > 0 && projected <= MAX_FIGURE_HEIGHT) { tall.push(projected); continue; }
    const traced = sanitizeContour(m.contour);
    if (!traced) continue;
    const h = figureHeight(traced);
    if (h > 0 && h <= MAX_FIGURE_HEIGHT) tall.push(h);
  }
  if (!tall.length) {
    return Number.isFinite(+fallback) && +fallback > 0 ? clampFigureHeight(+fallback) : DEFAULT_FIGURE_HEIGHT;
  }
  tall.sort((a, b) => a - b);
  return clampFigureHeight(tall[tall.length >> 1]);
}
// Manual taps and other dancers with no scan yet match the stickers already
// found, or a cutout-sized default before the first scan.
export function fallbackDancerHeight(markers) {
  const tall = [];
  for (const m of markers || []) {
    if (!m || m.manual || m.kind === 'sim' || m.kind === 'pink') continue;
    const h = +m.projectedHeight;
    if (h > 0 && h <= MAX_FIGURE_HEIGHT) tall.push(h);
  }
  if (!tall.length) return UNSCANNED_FIGURE_HEIGHT;
  tall.sort((a, b) => a - b);
  return clampFigureHeight(tall[tall.length >> 1]);
}

// Complete missing legs/head via the human template when short or blob-like;
// otherwise keep the captured shape and normalize to targetHeight.
export function fullFigureContour(points, x, y, targetHeight, seedId = 0) {
  const target = Number.isFinite(+targetHeight) && +targetHeight > 0 ? +targetHeight : figureHeight(dancerSilhouette()) * TEMPLATE_SCALE;
  // Seeded template so sim dancers (and blob fills) are unique.
  const tmpl = uniqueDancerSilhouette(seedId | 0);
  const th = figureHeight(tmpl);
  if (!(th > 0)) return null;
  const cx = Number.isFinite(+x) ? +x : 0;
  const cy = Number.isFinite(+y) ? +y : 0;
  if (isTruncatedOrBlob(points, target)) {
    return centerOn(placeContour(tmpl, cx, cy, target / th), cx, cy);
  }
  const clean = sanitizeContour(points);
  const h = figureHeight(clean);
  if (!(h > 0)) return centerOn(placeContour(tmpl, cx, cy, target / th), cx, cy);
  return centerOn(placeContour(clean, cx, cy, target / h), cx, cy);
}

function scaleAboutCenter(points, scale) {
  const clean = sanitizeContour(points, 128);
  if (!clean) return null;
  const center = areaCentroid(clean);
  const s = Number.isFinite(+scale) && +scale !== 0 ? +scale : 1;
  return clean.map(p => ({x: center.x + (p.x - center.x) * s, y: center.y + (p.y - center.y) * s}));
}

// The fill throbs. The rainbow string is redrawn every frame through the figure.
// Sticker home (TJ 10:31 AM): camera jitter and re-detection of a still
// sticker are ignored (deadband ~5% of the figure height); a real move
// glides the home over at most ~1 height/s.
// Inset camera (TJ 11:18 AM): the inset framed the groin and scaled with the
// body throb, so every sway or pulse slid the planted feet across the panel.
// It is now locked to the floor line and the feet's midpoint, with a wide
// deadband, and only glides (slowly) after the dancer has stepped away.
// Shell glow strength from the Bloom slider: 0 means no glow (TJ), the
// default and TJ's saved 0.45 match the side sim, higher adds a little.
export function shellGlowAmount(bloomT) {
  const b = bloomT && Number.isFinite(+bloomT.glow) ? +bloomT.glow : 0;
  if (!(b > 0)) return 0;
  return 0.67 * Math.max(1, Math.min(1.3, b / 0.45));
}
export const INSET_CAM_BAND = 0.3;
// Inset size lock (TJ Nov 10 1:16 PM: "the inset dancers change size a lot").
// The traced sticker height swings with lighting and glow and the body throbs
// on the beat; the panel scale is height-normalised so every inset dancer
// keeps one size. Floor line and centre stay on the locked camera.
export function poseSpan(posed) {
  if (!posed || !posed.crown) return 0;
  let low = -Infinity;
  for (const k of ['footL', 'heelL', 'footR', 'heelR', 'ankleL', 'ankleR']) if (posed[k] && Number.isFinite(+posed[k].y)) low = Math.max(low, +posed[k].y);
  return Number.isFinite(low) ? low - posed.crown.y : 0;
}
export function insetFrame(cam, height) {
  const h = Math.max(1, +height || +cam.height || 1);
  const floor = cam.top + 0.99 * cam.height;
  return {cx: cam.cx, top: floor - 0.99 * h, height: h};
}
export function insetCamera(cams, id, posed, baseH, now, homeX = null) {
  const bh = Math.max(1, +baseH || 1);
  const feet = ['footL', 'heelL', 'footR', 'heelR'].map(k => posed[k]).filter(p => p && Number.isFinite(+p.x));
  // Framed on the dancer's home (sticker), which only moves after a settled
  // displacement, so the frame holds still while the dancer steps in place.
  const mid = Number.isFinite(+homeX) ? +homeX : feet.length ? feet.reduce((a, p) => a + p.x, 0) / feet.length : posed.groin.x;
  const floor = Number.isFinite(+posed.floorY) ? +posed.floorY : posed.groin.y + 0.5 * bh;
  let c = cams.get(id);
  if (!c || !Number.isFinite(c.cx) || Math.abs(c.cx - mid) > 2 * bh || Math.abs(c.floor - floor) > bh) {
    c = {cx: mid, floor, h: bh, t: now, glide: false};
    cams.set(id, c);
    if (cams.size > 64) cams.delete(cams.keys().next().value);
  } else {
    const dt = Math.max(0, Math.min(0.1, ((+now || 0) - (+c.t || 0)) / 1000));
    c.t = now;
    const d = mid - c.cx;
    // No pans (a pan slides every planted foot across the panel): the frame
    // holds still and, only when the dancer's home has settled well away
    // (INSET_CAM_BAND), re-frames in a single cut. Scale and floor follow
    // only large, settled changes, also as cuts.
    void dt; void d;
    if (Math.abs(mid - c.cx) > INSET_CAM_BAND * bh) c.cx = mid;
    if (Math.abs(floor - c.floor) > 0.08 * bh) c.floor = floor;
    if (Math.abs(bh - c.h) > 0.25 * c.h) c.h = bh;
  }
  return {cx: c.cx, top: c.floor - 0.99 * c.h, height: c.h};
}
export const HOME_DEADBAND = 0.05;
// Keep inset (or any locked-frame) drawing at a constant body height without
// changing the planted foot: scale the already-posed joints from the floor
// line and stance contact. The stage may still throb; insets must not
// (TJ Nov 10 3:05 PM: inset dancers changing size).
export function scalePoseFromFloor(posed, targetH) {
  if (!posed) return posed;
  const h0 = +posed.height || 0;
  const h1 = +targetH || h0;
  if (!(h0 > 0) || !Number.isFinite(h1) || h1 <= 0) return posed;
  if (Math.abs(h1 - h0) / h0 < 0.002) return posed;
  const s = h1 / h0;
  const key = posed.stance === 'footR' || posed.stance === 'heelR' ? 'footR' : 'footL';
  const planted = posed[key] && Number.isFinite(+posed[key].x) ? posed[key] : (posed.footL || posed.footR);
  const floor = Number.isFinite(+posed.floorY) ? +posed.floorY : (planted && Number.isFinite(+planted.y) ? +planted.y : 0);
  const ax = planted && Number.isFinite(+planted.x) ? +planted.x : (posed.groin && Number.isFinite(+posed.groin.x) ? +posed.groin.x : 0);
  const az = planted && Number.isFinite(+planted.z) ? +planted.z : 0;
  const out = Object.assign({}, posed, {height: h1});
  for (const k of Object.keys(posed)) {
    const pt = posed[k];
    if (!pt || typeof pt !== 'object' || !Number.isFinite(+pt.x) || !Number.isFinite(+pt.y)) continue;
    out[k] = {
      x: ax + (pt.x - ax) * s,
      y: floor + (pt.y - floor) * s,
      z: az + ((+pt.z || 0) - az) * s
    };
  }
  if (Number.isFinite(+posed.floorY)) out.floorY = floor;
  return out;
}

export const FLOOR_DEADBAND = 0.08;  // traced-height wobble never moves the floor line
export const FLOOR_STEP_CAP = 0.003; // floor-line catch-up per landing (height units)
export const JUMP_MIN_ACT = 0.7;
export const JUMP_MIN_GAP_S = 6;
// Home debounce (TJ 11:18 AM live feed): a sticker re-detection can jump
// the marker ~40 px for a few seconds and back; the home only follows a
// displacement that persists for HOME_SETTLE_S, so feet never chase it.
// Maps the straight string axis (x = root.x) onto the posed root->crown line.
export function chakraStringXY(anchors, X = (x, y) => ({x, y})) {
  const r = anchors.root, c = anchors.crown, span = Math.max(1e-6, r.y - c.y);
  return (x, y) => X(x + ((r.y - y) / span) * (c.x - r.x), y);
}
// Sims keep their ids; every other dancer (camera / manual sticker) gets the
// engine's sticker id space (room-lab markerStickerId: 100000 + n), so their
// per-dancer state never collides and network lookups find the right dancer.
export const STICKER_STATE_BASE = 100000;
export function dancerStateId(marker) {
  const n = Math.abs((marker && marker.id) | 0);
  if (!marker || marker.kind === 'sim' || n >= STICKER_STATE_BASE) return n;
  return STICKER_STATE_BASE + (n > 0 ? n : 1);
}
export const HOME_SETTLE_S = 4;
export const HEIGHT_LOCK_BAND = 0.2;    // median drift (not per-trace wobble) that re-sizes a figure
export const HEIGHT_LOCK_WINDOW = 32;  // samples of the re-traced height, one per 0.25 s (8 s)
export const HEIGHT_LOCK_OMEGA = 4;     // rad/s, ~1 s critically damped ease
export function lockFigureHeight(locks, id, target, now) {
  const t = +target;
  if (!(t > 0)) return target;
  let st = locks.get(id);
  if (!st || !(st.h > 0)) {
    st = {h: t, v: 0, goal: t, ring: [t], at: now, follow: now, t: now}; // follows the median while the window first fills
    locks.set(id, st);
    if (locks.size > 256) locks.delete(locks.keys().next().value);
    return t;
  }
  const dt = Math.max(0, Math.min(0.1, ((+now || 0) - (+st.t || 0)) / 1000));
  st.t = now;
  // Per-trace wobble (lighting, glow) averages out in the trend; only a real,
  // lasting change of the sticker's traced height re-sizes the figure.
  if (!((+now || 0) - st.at < 250)) {
    st.at = now;
    st.ring.push(t);
    if (st.ring.length > HEIGHT_LOCK_WINDOW) st.ring.shift();
    const m = st.ring.slice().sort((a, b) => a - b)[st.ring.length >> 1];
    // A real change: follow the window median until the window has refilled
    // (8 s), so the figure lands on the new size, not part-way.
    if (Math.abs(m - st.goal) > HEIGHT_LOCK_BAND * st.goal) { st.goal = m; st.follow = now; }
    else if ((+now || 0) - (+st.follow || -Infinity) < HEIGHT_LOCK_WINDOW * 250) st.goal = m;
  }
  const w = HEIGHT_LOCK_OMEGA, x = st.h - st.goal;
  const e = Math.exp(-w * dt);
  const nx = (x + (st.v + w * x) * dt) * e;
  st.v = (st.v - (st.v + w * x) * w * dt) * e;
  st.h = st.goal + nx;
  return st.h;
}
// Re-anchor (TJ Nov 10 1:24 PM): after Align/Rescan the left sticker's dancer
// stood ~90 px off its halo. Its planted feet were kept from before the
// re-map and, at low activation (weight shift only), it never stepped over.
// A home snap, or feet a body-fraction away from home, replants on the sticker.
export const REANCHOR_H = 0.75;
export const REANCHOR_PIN_H = 1.2; // beyond any step/glide lag (glides are < 1 height)
export function needsReanchor(pin, home, cx, baseH, now) {
  if (!pin) return false;
  if (home && home.snapAt != null && home.snapAt === now) return true;
  const px = +pin.x;
  if (!Number.isFinite(px)) return true;
  return Math.abs(px - cx) > REANCHOR_PIN_H * Math.max(1, +baseH || 1);
}
// Crowd pages: a live-request or library move (crowd-moves.js moveFrame)
// rides on top of the dancer's own groove. Only roaming markers carry one.
export function applyRoamMove(marker, args) {
  const mv = marker && marker.roam && marker.move;
  if (!mv) return args;
  const k = v => Math.max(0, Math.min(1, +v || 0));
  return {...args,
    squat: Math.max(args.squat || 0, k(mv.squat)),
    armLift: Math.max(args.armLift || 0, k(mv.armRaise)),
    armForward: Math.max(args.armForward || 0, k(mv.armForward)),
    clap: Math.max(args.clap || 0, k(mv.clap)),
    clapOverhead: mv.clap > 0.05 ? Math.max(args.clapOverhead || 0, k(mv.clapOh)) : args.clapOverhead,
    tall: Math.max(args.tall || 0, k(mv.tall))};
}
// Roaming crowd dancers: home is the steered marker position (no deadband,
// no settle). Their controller already moves them at walking pace.
export const ROAM_REPIN_H = 0.6;
export function roamHome(homes, id, x, y, now) {
  let hm = homes.get(id);
  if (!hm) {
    hm = {x, y, t: now, away: null, roam: true};
    homes.set(id, hm);
    if (homes.size > 256) homes.delete(homes.keys().next().value);
  }
  hm.x = x; hm.y = y; hm.t = now; hm.away = null;
  return hm;
}
export function stickerHome(homes, id, x, y, h, now, commit = false) {
  const H = Math.max(1, +h || 1);
  let hm = homes.get(id);
  if (!hm || !Number.isFinite(hm.x) || !Number.isFinite(hm.y)) {
    hm = {x, y, t: now, away: null};
    homes.set(id, hm);
    if (homes.size > 256) homes.delete(homes.keys().next().value);
    return hm;
  }
  const dt = Math.max(0, Math.min(0.1, ((+now || 0) - (+hm.t || 0)) / 1000));
  hm.t = now;
  const dx = x - hm.x, dy = y - hm.y, d = Math.hypot(dx, dy), band = HOME_DEADBAND * H;
  if (d <= band) { hm.away = null; return hm; }
  // A high-confidence Scan stickers refresh: snap the home the body should
  // walk to. Planted feet stay on their pin and holdGroundedFoot absorbs the
  // move as discrete steps (never a home glide, which would slide them).
  if (commit) { hm.x = x; hm.y = y; hm.away = null; hm.snapAt = now; return hm; }
  if (hm.away == null) hm.away = now;
  if ((+now || 0) - hm.away < HOME_SETTLE_S * 1000) return hm;
  // A sticker that stays a body height or more from its home was re-mapped
  // (Align / Rescan), not jittered: snap and re-anchor (TJ 1:24 PM).
  if (d > REANCHOR_H * H) { hm.x = x; hm.y = y; hm.away = null; hm.snapAt = now; return hm; }
  const step = Math.min(d - band, H * dt);
  hm.x += dx / d * step; hm.y += dy / d * step;
  return hm;
}
// Squat depth (TJ 10:32 AM): activation and bass hits/drops, eased (fast
// attack ~0.15 s, slow release ~0.5 s) so the knees never jerk.
export function easedSquat(map, id, act, bass, hush, now) {
  const target = Math.max(0, Math.min(1, 0.7 * smooth01(((+act || 0) - 0.3) / 0.6) + 0.45 * (+bass || 0))) * Math.max(0, Math.min(1, +hush || 0));
  let st = map.get(id);
  if (!st) { st = {u: target, t: now}; map.set(id, st); if (map.size > 256) map.delete(map.keys().next().value); return st.u; }
  const dt = Math.max(0, Math.min(0.1, ((+now || 0) - st.t) / 1000));
  st.t = now;
  const tau = target > st.u ? 0.15 : 0.5;
  st.u += (target - st.u) * (1 - Math.exp(-dt / tau));
  return st.u;
}
function smooth01(x) { return smoothstep(x); }

export function paintSilhouetteFrame(show, ctx, markers, options = {}) {
      show.drawStats.mode = show.drawMode;
      show.drawStats.bodies = 0;
      show.drawStats.halos = 0;
      show.drawStats.strings = 0;
      show.drawStats.bones = 0;
      show.drawStats.beat = 0;
      show.drawStats.dots = 0;
      const opts = options || {};
      const xy = typeof opts.xy === 'function' ? opts.xy : (x, y) => ({x, y});
      const now = +opts.now || 0;
      if (opts.levels) show.lastSong = show.songEnergy.process(now, opts.levels, {open: opts.songOpen !== false && !show.hushed});
      show.energyMotion.process(now, opts.levels || null, !!opts.levels && opts.songOpen !== false && !show.hushed);
      const network = Array.isArray(opts.network) ? opts.network : [];
      const networkOf = (id) => {
        const key = id | 0;
        for (let i = 0; i < network.length; i++) if ((network[i].id | 0) === key) return network[i];
        return null;
      };
      if (show.mode !== 'silhouette' || show.drawMode === 'dots') {
        show.drawStats.mode = 'dots';
        show.drawStats.dots = (markers || []).length;
        if (typeof opts.paintDots === 'function') opts.paintDots(markers || []);
        return 'dot';
      }
      const plain = [];
      const insetPicks = [];
      show.lastInsets = [];
      show.lastFigures = [];
      show.lastXy = xy;
      const insetBands = [false, false, false, false];
      const insetsOn = opts.insets !== false && show.insetsEnabled;
      const hush = show.hushLevel(now);
      {
        // Bass drive for the squat: fresh bass-band beats, held ~1.5 s (a drop).
        const bc = show.bandClock[1];
        const hit = bc && bc.at >= 0 && now - bc.at <= BEAT_FRESH_MS ? beatEnvelope(now - bc.at, bc.interval) : 0;
        const dtB = show.bassT < 0 ? 0 : Math.max(0, Math.min(0.1, (now - show.bassT) / 1000));
        show.bassT = now;
        show.bassDrive = hit > show.bassDrive ? show.bassDrive + (hit - show.bassDrive) * Math.min(1, dtB / 0.12) : show.bassDrive * Math.exp(-dtB / 1.5);
      }
      const bodyEnv = show.bodyEnvelope(now) * hush; // slowed — body sway/throb only
      const bodyBeat = show.bodyBeatIndex();
      // Latch the first body beat without firing a strike (keeps rest pose
      // centered on the sticker until a real beat arrives).
      if (bodyBeat !== show.lastBodyBeat) {
        const armed = show.lastBodyBeat >= 0;
        show.lastBodyBeat = bodyBeat;
        if (armed) {
          show.strikeAt = now;
          show.strikeDuration = Math.max(480, show.interval * Math.max(1, show.bodySlowdown) * 0.85);
        }
      }
      const crowd = Math.max((markers || []).length, Number.isFinite(+opts.crowd) ? +opts.crowd : 0);
      const glow = silhouetteGlow(crowd);
      const medianH = medianStickerHeight(markers, show.lastStickerH);
      if (medianH > 0 && (markers || []).some(m => m && m.kind !== 'sim' && m.kind !== 'pink' && m.contour)) show.lastStickerH = medianH;
      show.lastHeights = [];
      const drawT0 = typeof performance !== 'undefined' ? performance.now() : 0;
      for (const marker of markers || []) {
        const traced = marker && marker.kind !== 'pink' && marker.kind !== 'sim' ? sanitizeContour(marker.contour) : null;
        // Stickers: draw at their own traced height. Sims: median sticker height.
        // Template only fills limbs inside that height — never inflate (TJ 5:05).
        let targetH = medianH;
        if (marker && Number.isFinite(+marker.projectedHeight) && +marker.projectedHeight > 0) {
          targetH = clampFigureHeight(+marker.projectedHeight);
        } else if (traced) {
          const own = figureHeight(traced);
          if (own > 0) targetH = clampFigureHeight(own);
        } else if (marker && marker.manual) {
          targetH = fallbackDancerHeight(markers);
        }
        // One size per dancer (TJ 1:16 PM): re-traced contours jitter with
        // lighting and glow; the drawn height holds unless the sticker really
        // changed size, then eases over (critically damped, no snap).
        // Roaming dancers scale smoothly with depth; their height is not re-traced.
        if (marker && targetH > 0 && !marker.roam) targetH = lockFigureHeight(show.heightLocks, dancerStateId(marker), targetH, now);
        const contour = marker && (marker.kind === 'sticker' || marker.kind === 'sim' || traced)
          ? fullFigureContour(traced, +marker.x || 0, +marker.y || 0, targetH, marker.id | 0)
          : null;
        if (!contour) {
          if (marker) plain.push(marker);
          continue;
        }
        // Per-dancer state key: camera stickers and sims number from 1 each, so
        // sticker #1 and sim #1 used to share pins, homes and pulses (TJ 1:59 PM:
        // ripple spots with no figure; the sim stood on the sticker instead).
        const id = dancerStateId(marker);
        const band = ((marker.type | 0) % 4 + 4) % 4;
        // Fully hushed: no idle / shared clock drives anyone (planted rest pose).
        const motion = hush > 0 ? dancerMotionClock(now, show.bandClock[band], {at: show.at, interval: show.interval, index: show.index, strikeAt: show.globalStrikeAt}) : HUSHED_MOTION;
        const strikeU = motion.strikeAt >= 0
          ? Math.max(0, Math.min(1, (now - motion.strikeAt) / Math.max(1, motion.strikeDur)))
          : 0;
        const variation = variationFor(id);
        let here = plantedSide(motion.beat, variation);
        const envRaw = show.bandEnvelope(band, now); // this dancer's own band pulse (Listen per-band)
        const drive = bandStringDrive(show.tuning, band, envRaw, 0);
        const envB = drive.envelope * hush;
        const bloomT = silhouetteBloom(show.tuning);
        // Side-sim pulses (TJ 6:55 PM): each strike is logged with the energy
        // at that moment; it climbs the leg, then travels root→crown.
        let hist = show.pulseHist.get(id);
        if (!hist) {
          // Soak test (Nov 9): ids keep growing over a show (re-scans, sim reseeds); cap like floorAnchors.
          if (show.pulseHist.size > 256) show.pulseHist.clear();
          hist = {last: -1, strikes: []};
          show.pulseHist.set(id, hist);
        }
        // Footwork steps (TJ Nov 11 11:12 PM): each dancer picks steps that
        // fit the beat; the plan decides which foot carries the weight, so a
        // toe tap does not change the stance and weight changes land on beats.
        let fwPlan = null;
        let strikeSide = here;
        if (motion.tier !== 'rest' && hush > 0.001 && (+show.tuning.raveMoves || 0) > 0.001 && show.tuning.footwork !== false && !(hist.fwStale !== false && hist.fwSwing)) {
          const fb = buildFor(id, band);
          const fAct = Math.max(0, Math.min(1, +hist.act || 0));
          const stepBpm = 60000 / Math.max(250, motion.period);
          const strideN = show.interval > 0 ? Math.max(1, Math.round(motion.period / show.interval)) : 1;
          const lv = Array.isArray(opts.levels) ? opts.levels : null;
          const minH = minStanceHalf(fb), maxH = maxStanceHalf(fb);
          // Section (breakdown / build / drop): opts.section is a label or
          // {kind, build} (section-motion.js mods once PR #113 lands).
          const sec = opts.section && typeof opts.section === 'object' ? opts.section : null;
          const secKind = sec ? (typeof sec.kind === 'string' ? sec.kind : null) : (typeof opts.section === 'string' ? opts.section : null);
          fwPlan = footworkPlan({id, beat: motion.beat | 0, frac: stepFrac(now, motion), stepBpm, stride: strideN, activation: fAct,
            drop: show.lastPadFeatures && Number.isFinite(+show.lastPadFeatures.crescendo) ? +show.lastPadFeatures.crescendo : 0,
            kick: lv ? +lv[0] || 0 : null, bass: lv ? +lv[1] || 0 : null, section: secKind, build: sec && Number.isFinite(+sec.build) ? +sec.build : 0,
            amount: stepGate(fAct) * hush * Math.min(1, +show.tuning.raveMoves || 0), initialSide: here, drift: hist.fwDrift || null,
            // Real feet (body frame): the free foot's spacing and stagger are
            // adopted each event; a full restart only after footwork was off.
            feet: hist.fwFeet || null, restart: hist.fwStale !== false,
            geom: {n: minH * 1.12, s: Math.max(minH * 1.12, Math.min(maxH * 0.6, STANCE_SH_CALM * (fb.shW || 0.125))), w: maxH}});
          hist.fwStale = false;
          strikeSide = here; // string wave keeps this beat-alternating sign
          // Keep the floor pin on one foot through a double-support weight
          // shift (rock-step recover, still-mode taps). Flipping the stance
          // while both feet are down re-anchors the body and pops the head.
          const bothDown = (fwPlan.lift.L || 0) < 0.001 && (fwPlan.lift.R || 0) < 0.001;
          if (bothDown && (hist.fwSide === 1 || hist.fwSide === -1)) here = hist.fwSide;
          else { here = fwPlan.weightSide; hist.fwSide = here; }
          // String wave keeps the beat-alternating sign (same-side strikes
          // would stack into a kink). The leg pulse uses the planted foot.
        } else if (hist.fwHold && hist.fwHold.pos) {
          // Footwork is off (hush ended, rest, or a collect in progress):
          // keep the last layout so the pose does not snap off the planted feet.
          fwPlan = hist.fwHold;
          if (hist.fwSide === 1 || hist.fwSide === -1) here = hist.fwSide;
        }
        publishFootworkPose(id, fwPlan);
        if (!show.hushed && motion.strikeAt >= 0 && motion.strikeAt !== hist.last && now >= motion.strikeAt) {
          hist.last = motion.strikeAt;
          // Jumps (TJ 10:32 AM): rare, only at high activation, at most one
          // per JUMP_MIN_GAP_S per dancer; a crouch, a ballistic arc, land on the beat.
          const jump = motion.tier !== 'idle' && isJumpBeat(id, motion.beat) && envB >= 0.4
            && (+hist.act || 0) >= JUMP_MIN_ACT && !(now - (+hist.lastJump || -1e9) < JUMP_MIN_GAP_S * 1000);
          if (jump) hist.lastJump = now;
          hist.strikes.push({t0: motion.strikeAt / 1000, side: strikeSide >= 0 ? 1 : -1, plant: (fwPlan && (fwPlan.weightSide === 1 || fwPlan.weightSide === -1)) ? fwPlan.weightSide : (strikeSide >= 0 ? 1 : -1), energy: Math.max(0, Math.min(1, envB)), beat: motion.beat, jump});
          if (hist.strikes.length > 8) hist.strikes.shift();
        }
        const nowS = now / 1000;
        const ptimes = pulseTravelTimes();
        while (hist.strikes.length && nowS - hist.strikes[0].t0 > 2.2 * ptimes.full + 1) hist.strikes.shift();
        const front = pulseFront(hist.strikes, nowS, ptimes);
        const travel = front && front.phase === 'leg' ? {phase: 'leg', u: front.u} : {phase: front && front.phase === 'string' ? 'string' : 'done', u: 1};
        const travelS = front && front.phase === 'string' ? front.s : -1;
        const pulseAge = front ? front.age : Infinity;
        const latest = hist.strikes.length ? hist.strikes[hist.strikes.length - 1] : null;
        const jumping = !!(latest && latest.jump && latest.beat === motion.beat && motion.strikeAt >= 0);
        // Drop: one synchronized jump stomp for every dancer (section-motion.js).
        // Once labels have arrived, keep easing even when they stop (Listen off,
        // silence): a stale feed relaxes to groove instead of snapping off.
        const secOn = show.sectionAt > -1e11;
        if (secOn && now - show.sectionAt > 1500 && show.sectionMotion.state.t !== now) show.sectionMotion.update(now, null);
        const secMods = secOn ? show.sectionMotion.mods(now) : null;
        const dropJ = secOn ? show.sectionMotion.jump(now) : null;
        const jumpUp = Math.max(jumping ? jumpLift(motion.shiftT) * hush : 0, dropJ ? dropJ.lift * hush : 0);
        const moving = motion.tier !== 'rest';
        // At rest keep the last stance side: flipping it on the hush would
        // re-anchor the body on the other foot and pop it (TJ 10:31 AM).
        const lastPin = show.floorAnchors.get(id);
        // At rest the stance only swaps after a finished corrective step that
        // still leaves the body off its home, so the other foot can step too.
        const restSide = lastPin && (lastPin.side === 1 || lastPin.side === -1) ? (lastPin.wantSwap ? -lastPin.side : lastPin.side) : -1;
        if (lastPin) lastPin.wantSwap = false;
        const stanceSide = moving ? (here >= 0 ? 1 : -1) : restSide;
        // Side-sim step clock: 0 at the heel plant / pulse launch, ease-in to
        // the next beat with a sharp stop. Hold just shy of 1 if the next
        // strike is late so the swing foot doesn't plant early.
        // hush (0..1) scales every degree of motion so silence is still.
        const rawEase = moving ? stepFrac(now, motion) : 0;
        const ease = rawEase * hush;
        const planted = (moving ? (fwPlan ? fwPlan.weight : stepWeight(stanceSide, rawEase)) : 0) * hush;
        const familyCss = dancerHueCss(id, band, show.tuning.hueSpread);
        const familyRgb = dancerHueRgb(id, band, show.tuning.hueSpread);
        const tintMix = stringTintMix(show.tuning.hueSpread);
        const stringPhase = 2 * Math.PI * strikeU;
        // Sticker-height figure at the contour's place (sims: median sticker height).
        let top = Infinity;
        let bottom = -Infinity;
        let left = Infinity;
        let right = -Infinity;
        for (const p of contour) {
          if (p.y < top) top = p.y;
          if (p.y > bottom) bottom = p.y;
          if (p.x < left) left = p.x;
          if (p.x > right) right = p.x;
        }
        const height = (bottom - top) * throbScale(bodyEnv);
        const pulseAmp = PULSE_AMP_FRAC * (bottom - top) * drive.ampScale * hush;
        const pulseHz = pulseDriveHz(1000 / Math.max(250, motion.period));
        const instant = stringActivation(nowS, hist.strikes, {amp: pulseAmp, hz: pulseHz, times: ptimes});
        // Per-dancer activation (TJ 8:00 PM): received pulse energy is primary,
        // plus this dancer's local intake. Music AGC scales intake only —
        // it is not copied onto every body.
        const net = networkOf(id) || (id !== (marker.id | 0) ? networkOf(marker.id | 0) : null);
        const received = Math.max(0, net && Number.isFinite(+net.received) ? +net.received : 0);
        const localLevel = opts.levels && Number.isFinite(+opts.levels[band]) ? Math.max(0, +opts.levels[band]) : 0;
        const local = localLevel * (0.35 + 0.65 * (show.lastSong.energy || 0));
        const raw = dancerIntake({received, local, stringAct: instant});
        const open = opts.songOpen !== false && hush > 0.05;
        const self = show.dancerEnergy.process(id, now, raw, {open});
        // Crowd pages: a tired roaming dancer resting at the back moves calmer.
        const act = smoothArmActivation(id, self.energy, now) * hush * (marker.roam && marker.calm > 0 ? 1 - 0.55 * Math.min(1, +marker.calm) : 1);
        hist.act = act;
        const armLift = armLiftAmount(act * ARM_LIFT_FULL);
        const tall = Math.max(tallStandAt(id, {activation: act, beat: motion.beat, now, airborne: jumpUp > 0, periodMs: motion.period}), secMods ? secMods.tall : 0) * hush;
        const phrase = armLiftPhraseIndex(motion);
        const armFamily = armLiftFamilyFor(id, phrase);
        show.lastHeights.push({id: marker.id | 0, kind: marker.kind, height: bottom - top, x: Number.isFinite(+marker.x) ? +marker.x : (left + right) / 2, y: Number.isFinite(+marker.y) ? +marker.y : (top + bottom) / 2, band, travelS, planted, strikeU, stringPhase, strikes: hist.strikes.length, lastStrikeT0: hist.strikes.length ? hist.strikes[hist.strikes.length - 1].t0 : -1, lastStrikeEnergy: hist.strikes.length ? hist.strikes[hist.strikes.length - 1].energy : 0, pulseAmp, envB, glowDim: INNER_GLOW_DIM * STRING_DIM * bloomT.glow, glowRadius: bloomT.radius, stringGlowWidth: STRING_GLOW_WIDTH * bloomT.width, ease, armLift, activation: act, instant, songEnergy: show.lastSong.energy || 0, received, local, rawIntake: raw, tall, hush, phrase, armFamily});
        const rawCx = Number.isFinite(+marker.x) ? +marker.x : (left + right) / 2;
        // Centered on the sticker itself (TJ 4:02 PM), not the traced bounds.
        const rawCy = Number.isFinite(+marker.y) ? +marker.y : (top + bottom) / 2;
        // Home anchor (TJ 10:31 AM): sticker jitter and re-detection must not
        // drag the feet. Inside a deadband the home holds; a real move glides.
        // Roaming dancers (crowd demo/show pages) are steered smoothly by
        // their own controller, so the home follows the marker directly.
        const home = marker.roam ? roamHome(show.homes, id, rawCx, rawCy, now) : stickerHome(show.homes, id, rawCx, rawCy, bottom - top, now, show.homeCommit);
        const cx = home.x, cy = home.y;
        const build = buildFor(id, band);
        const hz = 1000 / Math.max(250, motion.period);
        const swing0 = armSwing(id, planted, now, build.zeta, Math.min(2, hz));
        const swing = hush < 1 ? {shoulder: swing0.shoulder * hush, hand: swing0.hand * hush} : swing0;
        // Heart → arm branch on the same pulse clock (side-sim heartArriveDelay).
        const arm = Number.isFinite(pulseAge) && pulseAge < 3 ? armPulse(travelS, pulseAge / ptimes.full, (ptimes.leg + ptimes.str * HEART_S) / ptimes.full) : {u: -1, lift: 0};
        const stomp = stompIntensity(act, hush);
        // Traction (TJ 9:20 PM): the planted contact keeps zero ground
        // velocity in x and depth. Width only changes on a swing, including
        // a collection step into the narrower rest stance.
        const baseH = bottom - top;
        let pin = show.floorAnchors.get(id);
        const restHalf = restStanceHalf(build);
        // Width lock (TJ 10:14 AM runaway fix): hold the last unit half-width
        // the pose actually used while both feet are down. It used to be
        // re-derived from the world toe-to-toe distance (toes point outward,
        // depth included, throb-scaled height) and fed back every frame, so
        // the stance grew without bound once a dancer stayed latched.
        const maxHalf = maxStanceHalf(build);
        const lockedHalf = pin && !pin.swinging && Number.isFinite(+pin.lockHalf) && pin.lockHalf > 0 ? Math.min(maxHalf, +pin.lockHalf) : null;
        // Collect during the hush ease, then plant and freeze before the
        // stillness hold (hush == 0) so two planted feet never slide.
        const minHalf = minStanceHalf(build);
        const collectSlop = (stepGate(act) > 0.5 ? 0.006 : 0.03);
        const plantedHalf = (pin && Number.isFinite(+pin.worldHalf)) ? +pin.worldHalf : lockedHalf;
        const inEase = hush > 0.04 && hush < 0.92;
        const needWiden = plantedHalf != null && plantedHalf < minHalf - 0.002;
        const needNarrow = lockedHalf != null && lockedHalf > restHalf + collectSlop;
        // Too-narrow plants must still be able to step out after the 500 ms
        // hush ease, or a slightly tight landing stays locked through silence.
        const wantCollect = needWiden || (inEase && needNarrow);
        const squat = Math.max(easedSquat(show.squatState, id, act, show.bassDrive, hush, now), dropJ ? 0.8 * dropJ.crouch * hush : 0);
        const beatMs = show.at >= 0 ? Math.max(250, show.interval) : 60000 / GROOVE_DEFAULT_BPM;
        const groove = {amt: 1 - hush, phase: ((now - (show.at >= 0 ? show.at : 0)) / beatMs)};
        // Energy-driven hips / arms / claps (energy-motion.js).
        const em = show.energyMotion.state;
        const eBand = em.env[band] || 0, eBass = Math.max(em.env[1] || 0, 0.85 * (em.env[0] || 0));
        const hipE = show.energyOn ? (band <= 1 ? Math.max(eBand, eBass) : 0.5 * eBand + 0.5 * eBass) : 0;
        const bpmNow = show.interval > 0 ? 60000 / show.interval : (motion.period > 0 ? 60000 / motion.period : 0);
        const hipS0 = show.energyOn ? hipEnergyScale(hipE, bpmNow) : {amp: 1, dbl: 0};
        // Breakdown: calm, smaller hips; build: a little more; after the drop: hot.
        const hipS = secMods ? {amp: hipS0.amp * secMods.hipMul, dbl: hipS0.dbl * (1 - secMods.calm)} : hipS0;
        const groove8 = show.grooveOf(id);
        groove8.setTempo(bpmNow);
        const hipAccent = show.energyOn ? groove8.step(now) * hush : 0;
        const swell = show.energyOn ? armSwell(melodicSustain(band, em.sustained), show.lastPadFeatures && show.lastPadFeatures.env) * hush : 0;
        const armE0 = armEnergyDrive(swell);
        const armE = secMods ? {...armE0, padSense: armE0.padSense * secMods.padMul, shoulder: armE0.shoulder * secMods.shoulderMul} : armE0;
        let clapAmt = 0, clapOh = 0;
        const barIdx = Math.max(0, motion.beat | 0) >> 2;
        const leadS = easeWindowS(bpmNow);
        if (show.energyOn && show.barBeat >= 0 && show.at >= 0 && show.interval > 0 && !(secMods && !secMods.clapOK) && !(dropJ && dropJ.phase !== 'none')) {
          const hot = !!(net && net.hot), rest = !!(net && net.rest);
          const snare = show.snarePattern.backbeat();
          const nextBar = (show.barBeat + 1) % 4;
          const nextBarIdx = show.barBeat === 3 ? barIdx + 1 : barIdx;
          const cur = clapEligible({act, hot, rest, barBeat: show.barBeat, snare, bpm: bpmNow, bar: barIdx}) ? clapEnvelope((now - show.at) / 1000, leadS) : 0;
          const nxt = clapEligible({act, hot, rest, barBeat: nextBar, snare, bpm: bpmNow, bar: nextBarIdx}) ? clapEnvelope((now - (show.at + show.interval)) / 1000, leadS) : 0;
          clapAmt = Math.max(cur, nxt) * hush;
          clapOh = hot ? 1 : Math.max(0, Math.min(1, (act - 0.9) / 0.1));
          if (cur > 0 && hist.lastClapAt !== show.at && now >= show.at) { hist.lastClapAt = show.at; hist.clapRipple = true; }
        }
        const beatF = (motion.beat | 0) + (motion.shiftT || 0);
        const unit = skeletonPose(applyRoamMove(marker, {groove, squat, id, band, weight: planted, ease, side: stanceSide, swing, lift: arm.lift * hush, armLift: secMods ? Math.max(armLift, secMods.armRaise * hush) : armLift, armForward: secMods ? secMods.armForward * hush : 0, armSwellLift: armE.lift, jump: jumpUp, tall, armFamily, phrase, activation: act, now, eightDbl: hipS.dbl, hipAccent, clap: clapAmt, clapOverhead: clapOh, periodMs: motion.period, strikes: hist.strikes, pulseAmp, pulseHz, times: ptimes, hush, still: !moving, beat: beatF, stepHz: hz, hipEight: show.tuning.hipEight * hipS.amp, shoulderEight: show.tuning.shoulderEight * armE.shoulder, hipTwist: show.tuning.hipTwist, shoulderTwist: show.tuning.shoulderTwist, maxBodyTurn: show.tuning.maxBodyTurn, turnFreq: show.tuning.turnFreq, eightDepth: show.tuning.eightDepth, eightVert: show.tuning.eightVert, stanceLock: (!wantCollect && lockedHalf != null) ? lockedHalf : null, collect: wantCollect, padFeatures: show.lastPadFeatures, armPadSense: show.tuning.armPadSense * armE.padSense, eightRate: swayRate(bpmNow), bpm: bpmNow, raveMoves: show.tuning.raveMoves, bandLevels: Array.isArray(opts.levels) ? opts.levels : null, headLook: show.tuning.headLook !== false, songOpen: open, raveFade: dropJ && dropJ.raveFade < 0.999 ? dropJ.raveFade : null}));
        if (pin && !(Number.isFinite(+pin.x) && Number.isFinite(+pin.z) && Math.abs(pin.x - cx) < 4 * Math.max(1, baseH))) pin = null; // runaway / NaN anchor: replant
        if (pin && marker.kind === 'sticker' && needsReanchor(pin, home, cx, baseH, now)) { show.floorAnchors.delete(id); pin = null; } // re-mapped sticker: stand on it now
        if (pin && marker.roam && Math.abs(pin.x - cx) > ROAM_REPIN_H * Math.max(1, baseH)) { show.floorAnchors.delete(id); pin = null; } // walked past its steps: replant
        const prevSide = pin ? pin.side : null;
        if (!pin && hist.fwPinned) { resetFootwork(id); hist.fwStale = true; hist.fwPinned = false; publishFootworkPose(id, null); }
        pin = nextFloorAnchor(pin, {side: stanceSide, unit, cx, baseH});
        // Floor line: locked in world space while a foot is planted; it only
        // follows the sticker's floor (a cap per landing) when the stance
        // changes to a foot that just stepped (TJ 11:18 AM).
        {
          const floorTarget = cy - baseH / 2 + 0.99 * baseH;
          if (marker.roam) {
            // Roaming dancer: the floor line follows the steered marker, and
            // the stored contact points ride along so no joint keeps an old y.
            const dyF = Number.isFinite(+pin.floorY) ? floorTarget - pin.floorY : 0;
            if (dyF && pin.pts) for (const k of Object.keys(pin.pts)) { const q = pin.pts[k]; if (q && Number.isFinite(+q.y)) q.y += dyF; }
            pin.floorY = floorTarget;
          } else if (!Number.isFinite(+pin.floorY) || Math.abs(pin.floorY - floorTarget) > 0.5 * baseH) pin.floorY = floorTarget;
          else if (prevSide != null && prevSide !== pin.side && Math.abs(floorTarget - pin.floorY) > FLOOR_DEADBAND * baseH) {
            const cap = FLOOR_STEP_CAP * baseH;
            pin.floorY += Math.max(-cap, Math.min(cap, floorTarget - pin.floorY));
          }
        }
        pin.swinging = (unit.liftL || 0) > 0.001 || (unit.liftR || 0) > 0.001;
        if (pin.swinging || !(pin.lockHalf > 0)) pin.lockHalf = Math.min(maxHalf, +unit.stanceW || 0);
        show.floorAnchors.set(id, pin);
        hist.fwPinned = true;
        if (show.floorAnchors.size > 256) {
          const first = show.floorAnchors.keys().next().value;
          if (first !== id) show.floorAnchors.delete(first);
        }
        const posed = placePoseOnFloor(unit, {cx, cy, baseH, height, side: stanceSide, jump: jumpUp, anchorX: pin.x, anchorZ: pin.z, anchorFloorY: pin.floorY});
        // The floor pin stays on stanceSide (sticky through a double-support
        // shift). Report the plan's weight-bearing foot so a rock-step recover
        // or a still-mode shift still reads as a weight change on the beat.
        if (fwPlan && (fwPlan.weightSide === 1 || fwPlan.weightSide === -1)) posed.stance = stanceKey(fwPlan.weightSide, unit);
        holdGroundedFoot(posed, pin, stanceSide, {lift: stanceSide < 0 ? unit.liftR : unit.liftL, homeX: cx, maxSteer: 0.03 * baseH, now, minSep: 2 * minStanceHalf(build) * baseH, maxSep: 2 * maxStanceHalf(build) * baseH, lowAct: stepGate(act) < 0.5, allowFix: !fwPlan || needWiden});
        rebalancePosed(posed, stanceSide, pin.bal || (pin.bal = {}), now);
        try { uprightTorso(posed, {x: torsoLeanLimit(act, squat, hush, 'x'), z: torsoLeanLimit(act, squat, hush, 'z')}); } catch { /* never abort the frame over a rest-pose shear */ }
        lockPlantedContacts(posed, pin);
        squareHipsToPlantedFeet(posed, 2 * minStanceHalf(build) * baseH);
        // Sticker pose: a scanned sticker's own traced figure is this dancer's
        // home pose. It eases back into it on phrase downbeats and at rest
        // (stage px = projector space, so it lands on the sticker itself).
        let stickerW = 0;
        if (marker.kind !== 'sim' && traced && traced.length >= 12) {
          // The sticker's own traced shape at the drawn size (spread-arm
          // stickers included: the body may use the template, the pose
          // still follows the real sticker).
          const th = figureHeight(traced);
          const shape = th > 0 ? centerOn(placeContour(traced, rawCx, rawCy, targetH / th), rawCx, rawCy) : null;
          const fit = shape ? show.stickerFits.fit(id, shape, rawCx) : null;
          if (fit) {
            const frac = motion.strikeAt >= 0 && motion.period > 0 ? Math.max(0, Math.min(0.999, (now - motion.strikeAt) / motion.period)) : 0;
            const target = stickerPoseTarget({beat: (motion.beat | 0) + frac, bars: phraseBarsFor(id), activation: act, hush});
            stickerW = show.stickerBlend.step(id, target, now);
            try { blendStickerPose(posed, fit, stickerW); } catch { /* keep the frame */ }
          }
        }
        ensureMinKneeAngle(posed);
        // A roaming dancer carries its eased head with it: easeHeadY caps the
        // per-frame head step, which would stretch the neck as it walks in
        // depth (height changes) or climbs.
        if (marker.roam) {
          const ref = +posed.floorY - (+posed.height || 0);
          if (Number.isFinite(hist.roamRef) && Number.isFinite(+hist.headY) && Number.isFinite(ref)) hist.headY += ref - hist.roamRef;
          hist.roamRef = ref;
        }
        easeHeadY(posed, hist);
        updateFloorAnchor(pin, posed, stanceSide);
        // Footwork home feedback: support centre vs the sticker home, in the
        // body frame (height units), so the next steps walk back (no slide).
        // A frame without footwork (silence, collect, jump-off) marks the plan
        // stale: it restarts from these real feet when the steps come back.
        if (!fwPlan || !unit.footwork) hist.fwStale = true;
        // Snapshot the last layout (zero lifts) so a later hush/rest frame
        // can keep the planted feet without a pose snap.
        if (fwPlan && fwPlan.pos && (fwPlan.lift.L || 0) < 0.001 && (fwPlan.lift.R || 0) < 0.001) {
          hist.fwHold = {
            pos: {L: {x: fwPlan.pos.L.x, z: fwPlan.pos.L.z}, R: {x: fwPlan.pos.R.x, z: fwPlan.pos.R.z}},
            lift: {L: 0, R: 0}, rock: {L: 0, R: 0}, tap: {L: false, R: false},
            contact: {L: 'flat', R: 'flat'}, amount: 0, weight: fwPlan.weight, weightSide: fwPlan.weightSide,
            weightKind: 'shift', step: fwPlan.step, label: fwPlan.label, tier: fwPlan.tier, kind: 'shift', held: true
          };
        }
        // A swing in progress (collect step) finishes before the steps resume.
        hist.fwSwing = !!wantCollect && ((+unit.liftL > 0.001) || (+unit.liftR > 0.001));
        // Mid-foot (toe + heel) / 2 in pose units (posed px / pose height):
        // the plan places mid-feet, and toes swing with the hip yaw.
        const poseH = +posed.height > 0 ? +posed.height : baseH;
        if (posed.footL && posed.footR && posed.heelL && posed.heelR && poseH > 0) {
          const fy = -travelFacingOf(id);
          const mL = {x: (posed.footL.x + posed.heelL.x) / 2, z: ((+posed.footL.z || 0) + (+posed.heelL.z || 0)) / 2};
          const mR = {x: (posed.footR.x + posed.heelR.x) / 2, z: ((+posed.footR.z || 0) + (+posed.heelR.z || 0)) / 2};
          const bf = rotateFacing(((mL.x + mR.x) / 2 - cx) / poseH, ((mL.z + mR.z) / 2) / poseH, fy);
          hist.fwDrift = Number.isFinite(bf.x + bf.z) ? bf : null;
          const fL = rotateFacing((mL.x - cx) / poseH, mL.z / poseH, fy), fR = rotateFacing((mR.x - cx) / poseH, mR.z / poseH, fy);
          hist.fwFeet = Number.isFinite(fL.x + fL.z + fR.x + fR.z) ? {L: fL, R: fR} : null;
        }
        if (pin && posed.footL && posed.footR && baseH > 0) {
          const mid = (t, h) => h ? {x: (t.x + h.x) / 2, z: ((+t.z || 0) + (+h.z || 0)) / 2} : {x: t.x, z: +t.z || 0};
          const worldHalf = projectedStanceWidth(mid(posed.footL, posed.heelL), mid(posed.footR, posed.heelR), posed.hipL, posed.hipR) / (2 * baseH);
          if (Number.isFinite(worldHalf) && worldHalf > 0) pin.worldHalf = worldHalf;
        }
        const pulseSide = front && front.strike ? (front.strike.plant != null ? front.strike.plant : front.strike.side) : stanceSide;
        const pulsePhase = front ? front.phase : 'none';
        const pulseU = front && front.phase === 'leg' ? front.u : (front && front.phase === 'string' ? 1 : -1);
        const jp = k => posed[k] && Number.isFinite(+posed[k].x) ? {x: posed[k].x, y: posed[k].y, z: +posed[k].z || 0} : null;
        Object.assign(show.lastHeights[show.lastHeights.length - 1], {joints: {hipL: jp('hipL'), hipR: jp('hipR'), kneeL: jp('kneeL'), kneeR: jp('kneeR'), ankleL: jp('ankleL'), ankleR: jp('ankleR'), heart: jp('heart'), head: jp('head'), groin: jp('groin'), pelvis: jp('pelvis'), crown: jp('crown'), neck: jp('neck'), shL: jp('shL'), shR: jp('shR')}, twist: unit.twist, floorY: posed.floorY, squat, groove: groove.amt, bass: show.bassDrive, settling: !!pin.fix, stepGate: stepGate(act), chakra: chakraAnchors(posed), rave: unit.rave ? unit.rave.locomotor : null, raveLabel: unit.rave ? unit.rave.label : null, footwork: unit.footwork ? unit.footwork.step : null, footworkTier: unit.footwork ? unit.footwork.tier : null, headYaw: unit.headYaw, headYawRel: unit.headYawRel, bones: 0});
        Object.assign(show.lastHeights[show.lastHeights.length - 1], {stomp, stance: posed.stance, stanceW: unit.stanceW, stanceSh: unit.stanceSh, jump: jumpUp, footL: {x: posed.footL.x, y: posed.footL.y, z: +posed.footL.z || 0}, footR: {x: posed.footR.x, y: posed.footR.y, z: +posed.footR.z || 0}, heelL: posed.heelL && Number.isFinite(+posed.heelL.y) ? {x: posed.heelL.x, y: posed.heelL.y, z: +posed.heelL.z || 0} : null, heelR: posed.heelR && Number.isFinite(+posed.heelR.y) ? {x: posed.heelR.x, y: posed.heelR.y, z: +posed.heelR.z || 0} : null, contactL: unit.contactL, contactR: unit.contactR, floorY: posed.floorY, liftL: posed.floorY - Math.max(posed.footL.y, posed.heelL && Number.isFinite(+posed.heelL.y) ? posed.heelL.y : posed.footL.y), liftR: posed.floorY - Math.max(posed.footR.y, posed.heelR && Number.isFinite(+posed.heelR.y) ? posed.heelR.y : posed.footR.y), hipX: posed.groin.x, stickerPose: stickerW, pulseSide, pulsePhase, pulseU, pulseAge: Number.isFinite(pulseAge) ? pulseAge : -1, strikeAt: motion.strikeAt, period: motion.period, hush, handL: {x: posed.handL.x, y: posed.handL.y}, handR: {x: posed.handR.x, y: posed.handR.y}, groin: {x: posed.groin.x, y: posed.groin.y}, crown: {x: posed.crown.x, y: posed.crown.y}, head: posed.head ? {x: posed.head.x, y: posed.head.y} : {x: posed.crown.x, y: posed.crown.y}});

        // Stomp / foot-plant edges for the floor ripples (TJ 1:54 PM): one
        // clean ring per landing or ornament, never a continuous level.
        {
          const row = show.lastHeights[show.lastHeights.length - 1];
          row.plants = stompPlantsFromFigure(hist.foot, row);
          // Drop landing: both feet stomp together, one big ring each.
          const landAt = show.sectionMotion.state.landAt;
          if (landAt >= 0 && show.sectionMotion.state.cancelAt < 0 && now >= landAt && now - landAt < 250 && hist.dropLandAt !== landAt && hush > 0) {
            hist.dropLandAt = landAt;
            row.plants.push({side: -1, kind: 'drop', x: row.footL.x, y: row.footL.y, amount: 0.65}, {side: 1, kind: 'drop', x: row.footR.x, y: row.footR.y, amount: 0.65});
          }
          // Clap ripple (TJ 3:11 PM): a smaller, paler ring between the feet.
          // Visual only: it carries no energy (pulses stay peak-only and rate-limited).
          if (hist.clapRipple) {
            hist.clapRipple = false;
            row.plants.push({side: 0, kind: 'clap', x: (row.footL.x + row.footR.x) / 2, y: (row.footL.y + row.footR.y) / 2, amount: CLAP_RIPPLE * (0.22 + 0.12 * Math.min(1, act))});
            row.clap = true;
          }
          row.stompHit = row.plants.reduce((s, p) => s + (p && p.kind !== 'clap' && +p.amount > 0 ? +p.amount : 0), 0);
          hist.foot = {liftL: row.liftL, liftR: row.liftR, contactL: row.contactL, contactR: row.contactR, lastStrikeT0: row.lastStrikeT0, footL: row.footL, footR: row.footR, heelL: row.heelL, heelR: row.heelR, stomp: row.stomp, activation: row.activation, hush: row.hush, pulseSide: row.pulseSide, x: row.x, y: row.y, floorY: row.floorY};
        }
        const o0 = xy(0, 0);
        const o1 = xy(1, 0);
        const scale = Math.hypot(o1.x - o0.x, o1.y - o0.y) || 1;
        show.lastFigures.push({posed, scale});
        // One renderer per dancer, used for the stage figure AND its corner
        // inset, so the inset shows the same state (TJ 6:48 PM): X maps stage
        // px to canvas px, k is canvas px per stage px.
        // Pulses light the volumetric body from inside (TJ 1:51 PM): leg pulse
        // climbing to the root, arm beads, and the string pulse spreading
        // through the torso in the chakra colour.
        const bodyLights = hush > 0.05 ? bodyPulseLights(posed, {
          legSide: here, legU: travel.phase === 'leg' ? travel.u : -1, armU: arm.u, travelS,
          hueAt: chakraHueAt, energy: latest ? latest.energy : envB
        }) : {pulses: null, torso: null};
        const stagePose = posed;
        const figStats = {bones: 0};
        // "Stage" quality: camera stickers / real dancers only; the 24 seed
        // sims need "All" (iPhone 13 budget, bench24).
        const bonesQ = innerBonesMode(show.tuning);
        const figBones = bonesQ === 'all' ? 'all' : (bonesQ === 'stage' && marker.kind !== 'sim' ? 'stage' : 'off');
        const figRow = show.lastHeights.length && show.lastHeights[show.lastHeights.length - 1].id === (marker.id | 0) ? show.lastHeights[show.lastHeights.length - 1] : null;
        const render = (X, k, lockH) => {
          // Insets pass lockH = the locked camera height so throb and contour
          // wobble cannot change the panel size. The stage omits lockH and
          // keeps its beat throb. Local `posed` is the (optionally height-locked)
          // figure the halo, string, and pulses paint.
          const posed = (lockH > 0) ? scalePoseFromFloor(stagePose, lockH) : stagePose;
          const drawH = (lockH > 0) ? lockH : height;
          // Fine crisp line + bloom-scaled glows, sized to on-screen figure height.
          const coreW = fineLineWidth(drawH * (k || 1));
          const fg = fineGlow(show.tuning, coreW);
          // Dark articulated shadow figure (side-sim posed).
          const simCheap = marker.kind === 'sim' && (show.drawBudgetCheap || (posed.height || 0) * (k || 1) < VOLUME_LOD_PX);
          const simple = show.drawMode !== 'full';
          const beatPulse = show.drawMode === 'beat' ? Math.max(0.35, Math.min(1, 0.35 + envB)) : 1;
          if (simple) {
            paintShadowFigure(ctx, posed, X, {scale: k, alpha: show.drawMode === 'beat' ? 0.5 + 0.5 * beatPulse : 0.92, lod: 'cheap', glow: beatPulse, flash: show.drawMode === 'beat' ? beatPulse : 0, volume: false, pulses: null, torso: null, skeleton: false, bones: 'off', stats: figStats});
            paintSilhouetteHalo(ctx, posed, X, {scale: k, color: familyCss, dim: show.drawMode === 'beat' ? beatPulse * 1.6 : 1.35, width: show.drawMode === 'beat' ? 0.8 + beatPulse : 1.5, alpha: show.drawMode === 'beat' ? beatPulse : 0.9});
            show.drawStats.bodies += 1;
            show.drawStats.halos += 1;
            if (show.drawMode === 'beat') show.drawStats.beat += beatPulse;
            return;
          }
          paintShadowFigure(ctx, posed, X, {scale: k, alpha: throbAlpha(bodyEnv) > 0 ? Math.min(1, 0.85 + throbAlpha(bodyEnv) * 0.2) : 0.9, lod: (marker.kind === 'sim' && (show.drawBudgetCheap || (posed.height || 0) * (k || 1) < VOLUME_LOD_PX) ? 'cheap' : 'full'), glow: shellGlowAmount(bloomT), flash: act, volume: true, pulses: bodyLights.pulses, torso: bodyLights.torso, skeleton: false, bones: figBones, stats: figStats});
          show.drawStats.bodies += 1;
          show.drawStats.bones += figStats.bones || 0;
          // Soft silhouette-shaped halo (TJ 7:31 / 7:38 PM) — follows the
          // pose, no round dots. Aura slider is the max width; each dancer's
          // smoothed activation (× hush) scales it. Silence → no halo.
          // Seed sims skip the halo while the frame budget is blown.
          if (!simCheap) paintSilhouetteHalo(ctx, posed, X, {
            scale: k,
            color: familyCss,
            dim: INNER_GLOW_DIM * STRING_DIM * bloomT.glow,
            width: bloomT.width * haloAuraScale(act),
            alpha: bloomT.alpha
          });
          show.drawStats.strings += 1;
          // String axis from groin to crown on the skeleton (same string shape).
          const groin = posed.groin;
          // String on the final posed posed: the straight axis is sheared so
          // s=0 sits on the groin and s=1 just above the head top (TJ 11:44 AM).
          const anchors = chakraAnchors(posed);
          const crown = anchors.crown;
          const spanH = Math.max(4, (anchors.root.y - crown.y) / (STRING_ROOT_S - STRING_CROWN_S));
          const sTop = crown.y - spanH * STRING_CROWN_S;
          const ax = anchors.root.x;
          const Xs = chakraStringXY(anchors, X);
          const axisContour = [{x: ax - 1, y: sTop}, {x: ax + 1, y: sTop}, {x: ax + 1, y: sTop + spanH}, {x: ax - 1, y: sTop + spanH}];
          const waveform = typeof opts.waveform === 'function' ? opts.waveform(marker.type | 0) : null;
          const samples = waveform && waveform.length ? waveform : null;
          // Steady bow foot to foot through the groin, leaning to the planted side.
          {
            // Foot → knee → groin (root) → knee → foot (TJ 6:55 PM).
            paintLegArc(ctx, legArcPoints(posed, planted).map(p => X(p.x, p.y)), {alpha: 0.12});
            if (travel.phase === 'leg' && hush > 0.05) {
              const foot = here >= 0 ? posed.footR : posed.footL;
              const knee = here >= 0 ? posed.kneeR : posed.kneeL;
              const legU = travel.phase === 'leg' ? travel.u : 1;
              // Up the shin to the knee, then the thigh to the root.
              const via = legU < 0.5 ? null : knee;
              paintLegEnergy(ctx, X(via ? via.x : foot.x, via ? via.y : foot.y), X(groin.x, groin.y), via ? (legU - 0.5) * 2 : legU * 2, {color: 'rgb(255, 84, 56)', soft: stomp, radius: coreW * 4 * (0.45 + 0.55 * (stomp / STOMP_PEAK)), minRadius: coreW * 1.4, lineWidth: coreW * 1.3, crisp: fg.crisp});
            }
          }
          // Heart → shoulders → arms pulse beads.
          if (arm.u >= 0 && hush > 0.05) paintArmPulses(ctx, posed, X, arm.u, {color: 'hsl(120 90% 62%)', dim: STRING_DIM, radius: Math.max(0.8, coreW * 1.1), minRadius: 0.8, aura: fg.aura});
          // Chakra string (seven nodes), dimmed ~45%.
          drawDancerString(ctx, axisContour, {
            xy: Xs,
            now,
            band,
            envelope: envB,
            samples: drive.sens > 0 && hush > 0.05 ? samples : null,
            hue: marker.color || familyCss,
            tintMix,
            phase: stringPhase,
            strikes: hist.strikes,
            stringEase: hist.easeString ? hist : null,
            width: coreW,
            coreAlpha: 0.92,
            underlay: 0.55,
            glowWidth: fg.glowWidth,
            glowAlpha: fg.glowAlpha,
            pointScale: (coreW / STRING_LINE_WIDTH) * 1.3,
            pointMin: 0.7,
            aura: fg.aura,
            pulseAmp,
            pulseHz,
            alpha: (0.78 + 0.08 * glow) * STRING_DIM,
            dim: STRING_DIM,
            collect: strCollect,
            travel: true, // light nodes: smooth traveling sine (TJ 6:34 PM)
            travelS,
            travelGain: 1.8,
            // Side sim #100: the string cannot poke out the sides of the head.
            head: posed.head ? (() => {
              const hc = X(posed.head.x, posed.head.y);
              const hr = (posed.b && +posed.b.headR > 0 ? +posed.b.headR : 0.066) * drawH * (k || 1);
              const yawH = Number.isFinite(+posed.headYaw) ? +posed.headYaw : 0;
              return {head: hc, headR: hr, headRx: Math.max(hr * 0.42, yawExtent(hr * 0.86, hr * 0.95, yawH)), height: drawH * (k || 1)};
            })() : null
          });
        };
        const strCollect = [];
        hist.easeString = true;
        render(xy, scale);
        hist.easeString = false;
        if (figRow) figRow.bones = figStats.bones;
        if (strCollect.length && show.lastHeights.length && show.lastHeights[show.lastHeights.length - 1].id === (marker.id | 0)) show.lastHeights[show.lastHeights.length - 1].string = strCollect[0].points;
        strCollect.length = 0;
        if (insetPicks.length < INSET_MAX && !insetBands[band]) {
          insetBands[band] = true;
          const cam = insetCamera(show.insetCams, id, posed, baseH, now, cx);
          const lockedPose = scalePoseFromFloor(posed, cam.height);
          const low = ['footL','footR','heelL','heelR'].map(k => lockedPose[k]).filter(pt => pt && Number.isFinite(+pt.y));
          const floorY = low.length ? Math.max(...low.map(pt => +pt.y)) : (Number.isFinite(+lockedPose.floorY) ? +lockedPose.floorY : 0);
          const crownY = lockedPose.crown && Number.isFinite(+lockedPose.crown.y) ? +lockedPose.crown.y : floorY - cam.height;
          insetPicks.push({id: marker.id | 0, band, render, hue: familyCss, tag: xy(posed.crown.x + height * 0.12, posed.crown.y - height * 0.02), tagPx: Math.max(9, Math.min(12, height * scale * 0.11)), ...cam, bodyH: baseH, poseSpan: floorY - crownY, travelS, planted, strikeU, stringPhase, armFamily, phrase});
        }
      }
      // Corner insets: larger dim stick figures of up to four dancers.
      if (insetsOn && insetPicks.length && ctx.canvas && ctx.canvas.width > 0) {
        const rects = insetRects(ctx.canvas.width, ctx.canvas.height, insetPicks.length);
        rects.forEach((rect, i) => {
          const pick = insetPicks[i];
          const k = (rect.h * 0.84) / Math.max(1, pick.height);
          pick.cam = {cx: pick.cx, top: pick.top, k, rect: {x: rect.x, y: rect.y, w: rect.w, h: rect.h}};
          const X = (x, y) => ({x: rect.x + rect.w / 2 + (x - pick.cx) * k, y: rect.y + rect.h * 0.08 + (y - pick.top) * k});
          paintInsetPanel(ctx, rect);
          pick.render(X, k, pick.height);
          const label = insetLabel(pick.id, pick.band);
          // Bottom-left: clear of the Controls button in the top-left corner.
          const lpx = Math.max(10, Math.min(15, rect.h * 0.06));
          const tpx = Math.max(9, Math.round(lpx * 0.85));
          const tempo = tempoReadout(show.bandTempo(pick.band, now));
          paintSmallText(ctx, label, rect.x + 6, rect.y + rect.h - lpx - tpx - 9, {px: lpx, color: pick.hue, alpha: 0.9});
          paintSmallText(ctx, tempo, rect.x + 6, rect.y + rect.h - tpx - 6, {px: tpx, color: '#cfd6e6', alpha: 0.72});
          pick.tempo = tempo;
          // The '#233' crown tag lands on the projected floor; on the painting
          // (TJ Nov 11 4:04 PM) it is debug clutter, so painting mode hides it.
          if (opts.idTags !== false) paintSmallText(ctx, '#' + (pick.id | 0), pick.tag.x, pick.tag.y, {px: pick.tagPx, color: pick.hue, alpha: 0.5});
          pick.label = label;
        });
        show.lastInsets = insetPicks.map(p => ({id: p.id, band: p.band, cam: p.cam, drawnPx: p.cam ? p.bodyH * p.cam.k : null, visPx: p.cam && p.poseSpan > 0 ? p.poseSpan * p.cam.k : null, label: p.label, tempo: p.tempo, tag: '#' + (p.id | 0), tagAt: p.tag, travelS: p.travelS, planted: p.planted, strikeU: p.strikeU, stringPhase: p.stringPhase, armFamily: p.armFamily, phrase: p.phrase}));
      }
      if (plain.length && typeof opts.paintDots === 'function') opts.paintDots(plain);
      show.homeCommit = false;
      if (typeof performance !== 'undefined') show.drawBudgetCheap = performance.now() - drawT0 > 32;
      return show.mode;
    }

export function createSilhouetteShow() {
  const show = {};
  show.grooveOf = grooveOf;
  show.hushLevel = hushLevel;
  show.bandTier = bandTier;
  show.bandTempo = bandTempo;
  show.envelope = envelope;
  show.bandEnvelope = bandEnvelope;
  show.bodyEnvelope = bodyEnvelope;
  show.bodyBeatIndex = bodyBeatIndex;
  show.pose = pose;

  show.mode = 'dot';
  // How the figure is drawn. 'full' is the live projector's current look
  // (shell, bones, chakra string). Silhouette and beat are the simpler
  // glowing body. Nothing changes until setDrawMode is called.
  show.drawMode = 'full';
  show.drawStats = {mode: 'full', bodies: 0, halos: 0, strings: 0, bones: 0, beat: 0, dots: 0};
  show.at = -1;
  show.interval = 520;
  show.globalTempoMs = 0; // locked song tempo from global-tempo.js (0 = none)
  show.index = 0;
  show.onset = 0;
  show.bodySlowdown = BODY_MOTION_SLOWDOWN;
  show.bodyEnvSmooth = 0;
  show.lastBodyBeat = -1;
  show.strikeAt = -1;       // fallback shared strike (unused when a band has fired)
  show.strikeDuration = 900;
  show.globalStrikeAt = -1; // last stride-locked global strike (beat tiers)
  show.insetsEnabled = true;
  show.insetCams = new Map();
  show.tuning = cleanShowTuning(null);
  show.lastPadFeatures = null;
  show.hushed = false;
  show.hushAt = -1;
  show.songEnergy = createSongEnergy();
  // Sticker pose (TJ Nov 11 3:07 PM): fitted home pose per sticker dancer.
  show.stickerFits = createStickerPoseCache();
  show.stickerBlend = createStickerPoseBlend();
  show.dancerEnergy = createDancerEnergy();
  // Energy-driven motion (TJ Nov 11): band envelopes, per-dancer bass-groove
  // hip accents, snare-on-backbeat pattern for claps.
  show.energyMotion = createEnergyTracker();
  show.grooveAccents = new Map();
  show.snarePattern = createSnarePattern();
  show.barBeat = -1, show.prevBarBeat = -1, show.prevBeatAt = -1, show.lastSnareAt = -1e12, show.lastBassOnsetAt = -1e12;
  show.energyOn = true;
  // Breakdown / build / drop motion (section-motion.js), fed by room-lab.
  show.sectionMotion = createSectionMotion();
  show.sectionAt = -1e12;
  // Previous frame ran long: draw the 24 seed sims with the lite body so the
  // iPhone can hold 30 fps. A fast frame puts the full shell back.
  show.drawBudgetCheap = false;
  function grooveOf(id) { let g = show.grooveAccents.get(id); if (!g) { g = createGrooveAccent(); show.grooveAccents.set(id, g); if (show.grooveAccents.size > 128) show.grooveAccents.delete(show.grooveAccents.keys().next().value); } return g; }
  show.lastSong = show.songEnergy.value();
  // 1 = full motion … 0 = still. Cosine ease so nothing snaps.
  function hushLevel(now) {
    if (!show.hushed) return 1;
    const u = ((+now || 0) - show.hushAt) / HUSH_EASE_MS;
    if (u >= 1) return 0;
    if (u <= 0) return 1;
    return 0.5 * (1 + Math.cos(Math.PI * u));
  }
  show.bandLock = [false, false, false, false];
  show.bandPeriod = [0, 0, 0, 0];
  show.bandMeter = ['', '', '', ''];
  show.bandRatio = ['', '', '', ''];
  function bandTier(band, now) {
    return dancerMotionClock(+now || 0, show.bandClock[((band | 0) % 4 + 4) % 4], {at: show.at, interval: show.interval, index: show.index, strikeAt: show.globalStrikeAt}).tier;
  }
  function bandTempo(band, now) {
    const b = ((band | 0) % 4 + 4) % 4;
    const tier = show.bandTier(b, now);
    return {band: b, tier, locked: show.bandLock[b], period: show.bandPeriod[b] || show.bandClock[b].interval, meter: show.bandMeter[b], ratio: show.bandRatio[b],
      bpm: tier === 'band' && show.bandLock[b] && show.bandPeriod[b] > 0 ? Math.round(60000 / show.bandPeriod[b]) : null};
  }
  show.lastFigures = [];
  show.lastInsets = [];
  show.lastStickerH = 0; // sims keep the last sticker height when stickers drop out
  show.lastHeights = [];
  // Per-dancer recent foot strikes {t0 s, side, energy} for the pulse string.
  show.pulseHist = new Map();
  show.homeCommit = false;
  // World-x of the planted toe, kept while that foot stays the stance foot
  // so standing-tall (narrower stance) never slides the planted foot.
  show.floorAnchors = new Map();
  // Per-dancer eased squat depth and sticker home (TJ 10:31-10:32 AM).
  show.squatState = new Map();
  show.homes = new Map();
  show.heightLocks = new Map();
  show.bassDrive = 0, show.bassT = -1;
  show.lastXy = null;
  // Per-band foot-strike clock (each dancer locks to its own audio band).
  show.bandClock = [0, 1, 2, 3].map(() => ({
    at: -1, interval: 520, index: 0, strikeCount: 0, strikeAt: -1, strikeDur: 900, accent: 1
  }));

  function envelope(now) {
    if (show.at < 0) return 0;
    return beatEnvelope((+now || 0) - show.at, show.interval);
  }

  // A band's own string envelope: fresh band beats pulse only that band's
  // strings (TJ 6:45 PM, per-part timing). A band with no recent beat of
  // its own uses the shared envelope, as before.
  function bandEnvelope(band, now) {
    const c = show.bandClock[((band | 0) % 4 + 4) % 4];
    const t = +now || 0;
    if (c.at >= 0 && t - c.at <= BEAT_FRESH_MS) return beatEnvelope(t - c.at, c.interval) * (c.accent > 0 ? c.accent : 1);
    return show.envelope(t);
  }

  // Slowed + low-passed envelope for body deform/throb only (string stays fast).
  function bodyEnvelope(now) {
    const slow = Math.max(1, +show.bodySlowdown || BODY_MOTION_SLOWDOWN);
    const target = show.at < 0 ? 0 : beatEnvelope((+now || 0) - show.at, show.interval * slow);
    // Rise snaps toward the beat; fall is slow so the body eases (no twitch).
    if (target >= show.bodyEnvSmooth) {
      show.bodyEnvSmooth += (target - show.bodyEnvSmooth) * Math.min(1, 0.9 / Math.sqrt(slow));
    } else {
      show.bodyEnvSmooth += (target - show.bodyEnvSmooth) * Math.max(0.03, BODY_MOTION_SMOOTH / slow);
    }
    return show.bodyEnvSmooth;
  }

  function bodyBeatIndex() {
    const slow = Math.max(1, +show.bodySlowdown || BODY_MOTION_SLOWDOWN);
    return Math.floor(show.index / slow);
  }

  function pose(contour, id, now, bodyEnv, beatIndex, weight) {
    return deformSilhouette(contour, {
      envelope: Number.isFinite(+bodyEnv) ? +bodyEnv : show.bodyEnvelope(now),
      variation: variationFor(id),
      beatIndex: Number.isFinite(+beatIndex) ? (beatIndex | 0) : show.bodyBeatIndex(),
      weight: Number.isFinite(+weight) ? +weight : undefined
    });
  }

  return {
    mode() { return show.mode; },
    setMode(next) {
      if (next === 'dot' || next === 'silhouette') show.mode = next;
      return show.mode;
    },
    drawMode() { return show.drawMode; },
    setDrawMode(next) {
      if (next === 'dots') {
        show.drawMode = 'dots';
        show.mode = 'dot';
        return show.drawMode;
      }
      if (next === 'full' || next === 'silhouette' || next === 'beat') {
        show.drawMode = next;
        if (show.mode === 'dot') show.mode = 'silhouette';
        return show.drawMode;
      }
      return show.drawMode;
    },
    drawReport() { return {...show.drawStats}; },
    toggle() {
      show.mode = show.mode === 'silhouette' ? 'dot' : 'silhouette';
      return show.mode;
    },
    // info.period (optional): per-band tracked beat periods from Listen's
    // band-onsets tracker. A tracked period replaces the raw gap since the
    // band's last hit, so a ghost note cannot halve that band's stride.
    // True silence with Listen on (TJ 7:25 PM): ease every motion to zero
    // over HUSH_EASE_MS and hold still; the first real onset resumes at once.
    setHush(on, now) {
      if (on && !show.hushed) { show.hushed = true; show.hushAt = +now || 0; }
      else if (!on) show.hushed = false;
      return show.hushed;
    },
    hush(now) { return show.hushLevel(now); },
    // After a high-confidence between-songs scan: next paint snaps each
    // dancer's sticker home; planted feet step to it (no slide).
    commitHomes() { show.homeCommit = true; return true; },
    beat(now, tones, info) {
      const t = +now || 0;
      show.hushed = false;
      // Locked song tempo when Listen has one; else the gap between beats.
      if (show.globalTempoMs > 0) show.interval = show.globalTempoMs;
      else if (show.at >= 0) show.interval = Math.min(1400, Math.max(180, t - show.at));
      // Snare / clap on the backbeat? Judge the beat that just ended.
      if (show.prevBeatAt >= 0 && show.barBeat >= 0) show.snarePattern.note(show.barBeat, Math.abs(show.lastSnareAt - show.at) < 90);
      show.prevBeatAt = show.at; show.prevBarBeat = show.barBeat;
      show.barBeat = info && Number.isFinite(+info.barBeat) && +info.barBeat >= 0 ? +info.barBeat | 0 : -1;
      show.at = t;
      show.index += 1;
      if (show.globalStrikeAt < 0 || show.index % strikeStride(show.interval) === 0) show.globalStrikeAt = t;
      show.onset = tones | 0;
      // tones is a band bitmask from the room (bit 0 kick … bit 3 hat).
      const mask = tones | 0;
      for (let k = 0; k < 4; k++) {
        if (!(mask & (1 << k))) continue;
        const c = show.bandClock[k];
        const tracked = info && info.period ? +info.period[k] : 0;
        if (info && info.locked) show.bandLock[k] = !!info.locked[k];
        if (tracked > 0) show.bandPeriod[k] = tracked;
        if (tracked > 0) c.interval = Math.min(1400, Math.max(180, tracked));
        else if (c.at >= 0) c.interval = Math.min(1400, Math.max(180, t - c.at));
        c.at = t;
        // Beat This! timing (nn-drive.js): info.pos/cyc = this beat's place in
        // the bar, so strides land on the bar (strike on 1 and 3, not 2 and 4).
        // Realigning only ever skips ahead, and never strikes sooner than
        // ~0.7 stride after the last strike (no double-step at handover).
        const pos = info && info.pos ? info.pos[k] | 0 : -1, cyc = info && info.cyc ? info.cyc[k] | 0 : 0;
        if (pos >= 0 && cyc > 0) { const nx = c.index + 1; c.index = nx + (((pos - nx) % cyc) + cyc) % cyc; }
        else c.index += 1;
        c.accent = info && info.accent ? Math.max(0.5, Math.min(1, +info.accent[k] || 1)) : 1;
        const stride = strikeStride(c.interval);
        const early = pos >= 0 && c.strikeCount > 0 && t - c.strikeAt < 0.7 * c.interval * stride;
        if ((c.strikeCount === 0 || c.index % stride === 0) && !early && !phraseHold(c, info, stride)) {
          c.strikeCount += 1;
          c.strikeAt = t;
          c.strikeDur = Math.max(280, c.interval * stride * 0.92);
        }
      }
      return show.index;
    },
    // Real heard onsets (band mask) for the bass-groove hip accents and the
    // snare-on-backbeat clap pattern; beat() may be entrained (predicted).
    onsets(now, mask) {
      const t = +now || 0, m = mask | 0;
      if (m & 4) { show.lastSnareAt = t; if (show.barBeat >= 0 && Math.abs(t - show.at) < 90) show.snarePattern.note(show.barBeat, true); }
      if (m & 3) {
        show.lastBassOnsetAt = t;
        const e = show.energyMotion.state.env;
        const gain = m & 2 ? Math.max(e[1], 0.6 * e[0]) : 0.5 * e[0];
        const bpmNow = show.interval > 0 ? 60000 / show.interval : 0;
        for (const g of show.grooveAccents.values()) { g.setTempo(bpmNow); g.hit(t, gain); }
      }
      return m;
    },
    // det: breakdown-detect.js output for this audio frame.
    section(now, det) { show.sectionAt = +now || 0; return show.sectionMotion.update(show.sectionAt, det); },
    sectionState() { return show.sectionMotion.state; },
    setEnergyMotion(on) { show.energyOn = on !== false; return show.energyOn; },
    bandClock(band) { return show.bandClock[((band | 0) % 4 + 4) % 4]; },
    bandEnvelope(band, now) { return show.bandEnvelope(band, now); },
    insets() { return show.insetsEnabled; },
    figureHeights() { return show.lastHeights.slice(); },
    insetStates() { return show.lastInsets.slice(); },
    setSongEnergy(levels, now, opts) { show.lastSong = show.songEnergy.process(now, levels, opts || {}); return show.lastSong; },
    songEnergy() { return {...show.lastSong}; },
    resetSongEnergy() { show.songEnergy.reset(); show.dancerEnergy.reset(); show.lastSong = show.songEnergy.value(); return show.lastSong; },
    // Per-dancer activation (mean/max) and pose-state counts for the debug panel.
    poseStats() {
      const rows = show.lastHeights;
      const n = rows.length;
      const num = (k, d = 0) => rows.map(r => +r[k]).filter(Number.isFinite);
      const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
      const acts = num('activation'), lifts = num('armLift'), stances = num('stanceW');
      const families = {};
      let tall = 0, full = 0, close = 0, wide = 0;
      for (const r of rows) {
        if ((+r.tall || 0) > 0.5) tall++;
        if ((+r.armLift || 0) >= 0.95) full++;
        if ((+r.stanceSh || 0) <= STANCE_SH_CALM + 0.02) close++; // near the 0.85–0.90 shoulder-width floor
        if ((+r.stanceW || 0) >= 0.12) wide++;   // ~1.4+ hipW
        const f = r.armFamily || '—';
        families[f] = (families[f] || 0) + 1;
      }
      const rnd = (v, p = 2) => Math.round((+v || 0) * 10 ** p) / 10 ** p;
      const std = a => {
        if (a.length < 2) return 0;
        const m = mean(a);
        return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
      };
      return {
        dancers: n,
        activation: {mean: rnd(mean(acts)), max: rnd(acts.length ? Math.max(0, ...acts) : 0), min: rnd(acts.length ? Math.min(...acts) : 0), std: rnd(std(acts), 3), spread: rnd((acts.length ? Math.max(0, ...acts) - Math.min(...acts) : 0), 3)},
        armLift: {mean: rnd(mean(lifts)), max: rnd(lifts.length ? Math.max(0, ...lifts) : 0), full},
        stance: {mean: rnd(mean(stances), 3), min: rnd(stances.length ? Math.min(...stances) : 0, 3), max: rnd(stances.length ? Math.max(0, ...stances) : 0, 3), close, wide},
        tall, families,
        song: {energy: rnd(show.lastSong.energy), raw: rnd(show.lastSong.raw, 3), min: rnd(show.lastSong.min, 3), max: rnd(show.lastSong.max, 3), n: show.lastSong.n || 0}
      };
    },
    // Cut the dancers out of the ripple overlay so the shadow bodies read
    // (the overlay is screen-blended above the stage canvas).
    maskFigures(ctx, strength = 0.8) {
      if (!ctx || !show.lastFigures.length || !show.lastXy) return 0;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const unitXy = (x, y) => ({x, y}); // ripple overlay is in stage units (1000x620)
      for (const f of show.lastFigures) paintShadowFigure(ctx, f.posed, unitXy, {scale: 1, shade: false, shadow: 'rgba(0,0,0,' + strength + ')', rim: 'rgba(0,0,0,' + (strength * 0.5) + ')'});
      ctx.restore();
      return show.lastFigures.length;
    },
    bandTier(band, now) { return show.bandTier(band, now); },
    bandTempo(band, now) { return show.bandTempo(band, now); },
    setBandRatio(band, ratio) { const b = ((band | 0) % 4 + 4) % 4; show.bandRatio[b] = typeof ratio === 'string' ? ratio : ''; return show.bandRatio[b]; },
    setBandMeter(band, meter) { const b = ((band | 0) % 4 + 4) % 4; show.bandMeter[b] = typeof meter === 'string' ? meter : ''; return show.bandMeter[b]; },
    setGlobalTempo(periodMs) { const p = +periodMs; show.globalTempoMs = p >= 250 && p <= 1100 ? p : 0; if (show.globalTempoMs) show.interval = show.globalTempoMs; return show.globalTempoMs; },
    overallBpm(now) { const t = +now || 0; if (show.globalTempoMs > 0) return Math.round(60000 / show.globalTempoMs); return show.at >= 0 && t - show.at <= BEAT_FRESH_MS && show.interval > 0 ? Math.round(60000 / show.interval) : null; },
    setTuning(next) { show.tuning = cleanShowTuning(next, show.tuning); return {...show.tuning, sens: show.tuning.sens.slice()}; },
    setPadFeatures(f) { show.lastPadFeatures = f && typeof f === 'object' ? f : null; return show.lastPadFeatures; },
    padFeatures() { return show.lastPadFeatures; },

    tuning() { return {...show.tuning, sens: show.tuning.sens.slice()}; },
    setInsets(on) { if (on === true || on === false) show.insetsEnabled = on; return show.insetsEnabled; },
    beatIndex() { return show.index; },
    envelope(now) { return show.envelope(now); },
    bodyEnvelope(now) { return show.bodyEnvelope(now); },
    bodyMotionSlowdown() { return show.bodySlowdown; },
    setBodyMotionSlowdown(value) {
      const v = +value;
      if (Number.isFinite(v) && v >= 1 && v <= 16) show.bodySlowdown = v;
      return show.bodySlowdown;
    },
    pose(contour, id, now, bodyEnv, beatIndex) { return show.pose(contour, id, now, bodyEnv, beatIndex); },
    clearPulses() { show.onset = 0; },
    // paintDots(list) draws whatever this pass does not turn into a silhouette.
    // style is the bloom hook described at the top of this file.
    paint(ctx, markers, options = {}) { return paintSilhouetteFrame(show, ctx, markers, options); }
  };
}
