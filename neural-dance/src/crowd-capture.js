// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// White capture for the crowd show: a psychedelic build (style per run) that blooms into pure
// white, the phone takes a still at the white peak, then the dance returns.
//
// Timing (TJ Nov 24):
//   - hard minimum CAPTURE_MIN_GAP_MIN (20) minutes between captures;
//   - after that, wait for a musical drop: a bass breakdown/build is the cue
//     to start the visuals, the bass coming back is the drop and hits white;
//   - no drop within CAPTURE_GRACE_MIN (10) more minutes: trigger anyway;
//   - a remote "capture now" inside the cooldown gets a warning unless it
//     is sent again with force.
// Pure logic, no DOM: crowd-page.js feeds it audio and the clock.

// Each capture's lead-in visual is a different trip (TJ Nov 24): picked at
// random per run, never the same style twice in a row. Drawers: crowd-fx.js.
export const PSY_STYLES = Object.freeze(['dmt', 'mushrooms', 'lsd', 'mescaline', 'ayahuasca', 'ketamine']);
export function pickPsyStyle(last, rnd = Math.random) {
  const pool = PSY_STYLES.filter(s => s !== last);
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

export const CAPTURE_MIN_GAP_MIN = 20;
export const CAPTURE_GRACE_MIN = 10;
export const CAPTURE_LEAD_S = 4;         // timed/manual builds: seconds of visuals before white
export const CAPTURE_BUILD_MAX_S = 24;   // a drop build that never drops goes white anyway
export const CAPTURE_FADE_S = 6;         // visuals easing back into the dance
const MIN = 60000;

// Breakdown -> drop detector on the bass envelope (0..1), fed ~10x a second.
export function createDropDetector(opts = {}) {
  const buildMinS = opts.buildMinS ?? 3.5;
  const st = {level: 0, fast: 0, low: 0, lowSince: null, floor: 1, last: null, building: false, dropAt: null};
  return {
    step(tMs, bass) {
      const b = Math.max(0, Math.min(1, +bass || 0));
      const dt = st.last == null ? 0.1 : Math.max(0, Math.min(1, (tMs - st.last) / 1000));
      st.last = tMs;
      st.fast += (b - st.fast) * Math.min(1, dt / 0.35);
      // The long average only learns while the floor is busy, so a long
      // breakdown does not drag the reference down with it.
      if (!st.building) st.level += (b - st.level) * Math.min(1, dt / 16);
      let drop = false;
      const quiet = st.level > 0.12 && st.fast < 0.45 * st.level;
      if (quiet) {
        if (st.lowSince == null) { st.lowSince = tMs; st.floor = st.fast; }
        st.floor = Math.min(st.floor, st.fast);
        if ((tMs - st.lowSince) / 1000 >= buildMinS) st.building = true;
      } else if (st.building && st.fast > Math.max(0.7 * st.level, st.floor + 0.25)) {
        drop = true;
        st.dropAt = tMs;
        st.building = false;
        st.lowSince = null;
      } else if (!st.building) {
        st.lowSince = null;
      }
      return {building: st.building, drop, level: st.level, fast: st.fast};
    },
    state() { return {...st}; }
  };
}

export function createCaptureScheduler(opts = {}) {
  const st = {
    intervalMin: Math.max(CAPTURE_MIN_GAP_MIN, +opts.intervalMin || CAPTURE_MIN_GAP_MIN),
    graceMin: Number.isFinite(+opts.graceMin) ? Math.max(0, +opts.graceMin) : CAPTURE_GRACE_MIN,
    lastAt: Number.isFinite(+opts.lastAt) ? +opts.lastAt : (Number.isFinite(+opts.now) ? +opts.now : Date.now()),
    phase: 'idle', phaseAt: 0, reason: '', count: opts.count | 0,
    style: PSY_STYLES.includes(opts.lastStyle) ? opts.lastStyle : '', styles: []
  };
  const rnd = opts.rnd || Math.random;
  const api = {
    cooldownLeftMs(now) { return Math.max(0, st.lastAt + st.intervalMin * MIN - now); },
    dueAt() { return st.lastAt + st.intervalMin * MIN; },
    forceAt() { return st.lastAt + (st.intervalMin + st.graceMin) * MIN; },
    setInterval(min) { st.intervalMin = Math.max(CAPTURE_MIN_GAP_MIN, Math.min(180, +min || CAPTURE_MIN_GAP_MIN)); return st.intervalMin; },
    // cue: {building, drop} from the drop detector. Returns null,
    // 'start-build' (visuals begin) or 'go-white' (take the still now).
    step(now, cue = {}) {
      if (st.phase === 'idle') {
        if (now < api.dueAt()) return null;
        if (cue.building) return begin(now, 'drop');
        if (now >= api.forceAt()) return begin(now, 'timeout');
        return null;
      }
      if (st.phase === 'build') {
        const age = (now - st.phaseAt) / 1000;
        if (st.reason === 'drop' ? (cue.drop || age >= CAPTURE_BUILD_MAX_S) : age >= CAPTURE_LEAD_S) {
          st.phase = 'white'; st.phaseAt = now;
          return 'go-white';
        }
        return null;
      }
      if (st.phase === 'fade' && (now - st.phaseAt) / 1000 >= CAPTURE_FADE_S) { st.phase = 'idle'; st.phaseAt = now; }
      return null;
    },
    // Manual trigger from the remote or the local panel.
    request(now, {force = false} = {}) {
      if (st.phase !== 'idle') return {ok: false, warning: 'busy', phase: st.phase};
      const left = api.cooldownLeftMs(now);
      if (left > 0 && !force) return {ok: false, warning: 'cooldown', remainingMin: Math.ceil(left / MIN)};
      begin(now, 'manual');
      return {ok: true, overrode: left > 0};
    },
    // The white hold finished (captured or not); the cooldown restarts so a
    // broken camera does not retrigger white every few seconds.
    finished(now, ok) {
      st.lastAt = now;
      if (ok) st.count++;
      st.phase = 'fade'; st.phaseAt = now;
    },
    // 0..1 strength of the DMT visuals at `now` (white itself is the camera sheet).
    visual(now) {
      const age = (now - st.phaseAt) / 1000;
      if (st.phase === 'build') {
        const span = st.reason === 'drop' ? 8 : CAPTURE_LEAD_S;
        return Math.min(1, 0.15 + 0.85 * Math.pow(Math.min(1, age / span), 1.6));
      }
      if (st.phase === 'white') return 1;
      if (st.phase === 'fade') return Math.max(0, 1 - age / CAPTURE_FADE_S);
      return 0;
    },
    state() { return {...st}; }
  };
  function begin(now, reason) {
    st.phase = 'build'; st.phaseAt = now; st.reason = reason;
    st.style = pickPsyStyle(st.style, rnd);
    st.styles = [...st.styles, st.style].slice(-12);
    return 'start-build';
  }
  return api;
}
