// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Clock-driven show for /neural-dance/show/: 9 PM to 4 AM, America/Los_Angeles.
// Energy rises exponentially to a peak at ~3:20 AM, then decays so the last
// stretch is calmer. Crowd density builds continuously to a packed floor.
// At 4 AM the projection fades (90 s) to soft TV static, which holds until
// the next 9 PM start.

export const SHOW_TZ = 'America/Los_Angeles';
export const SHOW_START_MIN = 21 * 60;        // 9:00 PM
export const SHOW_LEN_MIN = 7 * 60;           // to 4:00 AM
export const SHOW_PEAK_MIN = 6 * 60 + 20;     // 3:20 AM, minutes after start
export const ENERGY_START = 0.12;
export const ENERGY_END = 0.3;
export const RISE_K = 3;                      // exponential steepness of the build
export const DECAY_TAU_MIN = 26;              // peak decay time constant (min)
export const STATIC_FADE_S = 90;
export const SPEEDS = Object.freeze([1, 2, 5, 10, 30, 60, 120]);

const clamp01 = v => Math.max(0, Math.min(1, +v || 0));

// Minutes since local midnight in the show zone for an epoch ms.
export function zoneMinutes(epochMs, tz = SHOW_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(new Date(epochMs));
  const get = t => +(parts.find(p => p.type === t) || {value: 0}).value;
  return (get('hour') % 24) * 60 + get('minute') + get('second') / 60;
}

// Minutes into the show (0..420 inside the window). Outside: negative never;
// returns {inShow, minutes, sinceEnd} where sinceEnd is minutes after 4 AM.
export function showPosition(localMinutes) {
  const m = ((+localMinutes || 0) % 1440 + 1440) % 1440;
  const into = (m - SHOW_START_MIN + 1440) % 1440;
  if (into < SHOW_LEN_MIN) return {inShow: true, minutes: into, sinceEnd: -1};
  return {inShow: false, minutes: SHOW_LEN_MIN, sinceEnd: into - SHOW_LEN_MIN};
}

// Energy 0..1 at minutes into the show.
export function showEnergy(minutes) {
  const t = Math.max(0, Math.min(SHOW_LEN_MIN, +minutes || 0));
  if (t <= SHOW_PEAK_MIN) {
    const u = t / SHOW_PEAK_MIN;
    return ENERGY_START + (1 - ENERGY_START) * (Math.exp(RISE_K * u) - 1) / (Math.exp(RISE_K) - 1);
  }
  return ENERGY_END + (1 - ENERGY_END) * Math.exp(-(t - SHOW_PEAK_MIN) / DECAY_TAU_MIN);
}

// Crowd density 0..1: builds continuously (a softer curve than energy, so
// the floor fills before the peak), packed at the peak, thins a little after.
export function showDensity(minutes) {
  const t = Math.max(0, Math.min(SHOW_LEN_MIN, +minutes || 0));
  if (t <= SHOW_PEAK_MIN) {
    const u = t / SHOW_PEAK_MIN;
    return 0.06 + 0.94 * (Math.exp(1.6 * u) - 1) / (Math.exp(1.6) - 1);
  }
  return 0.62 + 0.38 * Math.exp(-(t - SHOW_PEAK_MIN) / (2 * DECAY_TAU_MIN));
}

// Static veil 0..1: 0 during the show, fades in over STATIC_FADE_S after 4 AM.
export function staticAmount(pos) {
  if (!pos || pos.inShow) return 0;
  return clamp01((pos.sinceEnd * 60) / STATIC_FADE_S);
}

export function crowdCount(density, cap, minCount = 3) {
  const c = Math.max(minCount, cap | 0);
  return Math.round(minCount + clamp01(density) * (c - minCount));
}

// Virtual show clock with speed, jump and energy boost, adjustable live.
// virtual(now) = anchorVirtual + (now - anchorReal) * speed
export function createShowClock({now = Date.now(), speed = 1, offsetMs = 0, boost = 0} = {}) {
  const c = {anchorReal: now, anchorVirtual: now + (+offsetMs || 0), speed: clampSpeed(speed), boost: clampBoost(boost)};
  c.virtual = (t = Date.now()) => c.anchorVirtual + (t - c.anchorReal) * c.speed;
  c.setSpeed = (s, t = Date.now()) => { c.anchorVirtual = c.virtual(t); c.anchorReal = t; c.speed = clampSpeed(s); return c.speed; };
  c.jump = (minutes, t = Date.now()) => { c.anchorVirtual = c.virtual(t) + (+minutes || 0) * 60000; c.anchorReal = t; return c.virtual(t); };
  // Jump so the virtual clock reads `showMinutes` into tonight's show (0..420+).
  c.jumpToShowMinute = (showMinutes, t = Date.now(), tz = SHOW_TZ) => {
    const cur = showPosition(zoneMinutes(c.virtual(t), tz));
    const curInto = cur.inShow ? cur.minutes : SHOW_LEN_MIN + cur.sinceEnd;
    let delta = (+showMinutes || 0) - curInto;
    if (!cur.inShow && delta < 0) delta += 1440; // outside: go forward to the next show
    return c.jump(delta, t);
  };
  c.setBoost = b => (c.boost = clampBoost(b));
  c.reset = (t = Date.now()) => { c.anchorReal = t; c.anchorVirtual = t; c.speed = 1; c.boost = 0; };
  c.offsetMs = (t = Date.now()) => c.virtual(t) - t;
  c.state = (t = Date.now(), tz = SHOW_TZ) => {
    const local = zoneMinutes(c.virtual(t), tz);
    const pos = showPosition(local);
    const energy = pos.inShow ? showEnergy(pos.minutes) : ENERGY_START * 0.5;
    const density = pos.inShow ? showDensity(pos.minutes) : 0;
    return {local, pos, energy, boostedEnergy: clamp01(energy + c.boost), density, staticAmount: staticAmount(pos), speed: c.speed, boost: c.boost};
  };
  return c;
}

export function clampSpeed(s) {
  const v = +s;
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.max(0.25, Math.min(600, v));
}
export function clampBoost(b) {
  const v = +b;
  if (!Number.isFinite(v)) return 0;
  return Math.max(-0.5, Math.min(0.5, v));
}

export function formatClock(localMinutes) {
  const m = ((Math.floor(+localMinutes || 0) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(mm).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
}
