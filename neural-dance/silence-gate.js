// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural Dance silence gate.
// The noise floor is the low percentile of recent input level, measured only
// while the gate is closed so a song cannot become the floor. Near that floor
// the auto-gain cap stays at 1: silence and background noise are not boosted
// into dancer motion. Listen (the mic) and Room music both use this gate.
// Above the quiet threshold the live spectrum is passed through unchanged.
(function (root) {
  var FLOOR_PERCENTILE = 0.1;
  var WARMUP_FRAMES = 12;
  var HOLD_SECONDS = 0.28;
  var QUIET_DEFAULT = 0.08;
  var SAMPLE_CAP = 90;
  var BANDS = [[40, 120], [120, 300], [300, 2500], [5000, 14000]];
  // Adaptive gate (TJ 8:32 PM). Live phone captures showed the gate open
  // 98-100% of the time: the floor was learned from near-silent startup frames
  // (0-0.5) and froze while open, and room noise (~0.5) sat far above
  // floor + 0.08 while music peaked ~1.5. Now the thresholds follow the recent
  // music level as well as the floor, with hysteresis: open on a rise past
  // OPEN_FRAC of the floor-to-music span, close after the smoothed level stays
  // under CLOSE_FRAC of it for CLOSE_SECONDS. While open the floor can follow
  // the room down at once and creeps up slowly, so a stale floor heals.
  var OPEN_FRAC = 0.5;
  var CLOSE_FRAC = 0.35;
  var CLOSE_SECONDS = 0.5;
  var CLOSE_DROP = 0.8;
  var MIN_SPAN = 0.45;
  // Quiet phone input can sit only a few dB over the room, so level alone
  // cannot tell a soft song from a pause: with no detector onset for IDLE_S
  // and no loud passage (within IDLE_DROP of the music level) it also closes.
  var IDLE_S = 0.45;
  var IDLE_DROP = 0.25;
  var IDLE_LONG_S = 1.5; // no onset at all for this long: close at any level
  var NOISE_HIGH_PERCENTILE = 0.95;
  var NOISE_MARGIN = 0.15; // ≈2 dB over the loud end of the room noise
  var OPEN_FRAMES = 2;     // two frames over, so one noise spike cannot open
  var SMOOTH_S = 0.25;
  var MUSIC_DECAY_OPEN_S = 12;
  var MUSIC_DECAY_CLOSED_S = 90;
  var FLOOR_RISE_OPEN_S = 20;
  var RECENT_CAP = 150;
  // Gate v3 (TJ Nov 10, 10:02 AM phone capture): the closed gate learned the
  // music itself as room noise (noiseHigh = p95 of closed frames ≈ the music's
  // peaks) and set openAt above the music, so Listen locked itself shut for
  // minutes with music playing. The band detector is fed a zero spectrum while
  // closed, so it could never report the onsets that would reopen it.
  // Now the gate runs its own tiny onset tracker on the raw band peaks (it
  // sees the mic even while closed), learns the floor only from frames with no
  // onset for QUIET_ONSET_S, caps the floor at the long-window low percentile,
  // and reopens at once on a run of onsets or a steady beat.
  var ONSET_MIN = 0.1;      // smallest band-peak rise that counts (bytes/56)
  var ONSET_K = 2.2;         // × the band's quiet jitter
  var ONSET_REFRACTORY_S = 0.1;
  var ONSET_MEAN_S = 0.35;
  var ONSET_DEV_S = 2.0;
  var QUIET_ONSET_S = 2.0;   // a frame is "quiet" only this long after the last onset
  var REOPEN_ONSETS = 3;     // onsets within REOPEN_WINDOW_S reopen a closed gate
  var REOPEN_WINDOW_S = 1.6;
  var STEADY_ONSETS = 4;     // onsets within STEADY_WINDOW_S = a steady beat: never close on level
  var STEADY_WINDOW_S = 3.0;
  var LONG_WINDOW_S = 20;    // floor ceiling: low percentile of every frame over this window
  var FLOOR_MAX = 2.2;       // hard ceiling on the floor (bytes/56)
  var FAILSAFE_S = 2.0;      // closed this long while onsets keep arriving: force open

  function clamp(v, lo, hi) {
    if (!(v > lo)) return lo;
    if (v > hi) return hi;
    return v;
  }

  function create() {
    return {
      gain: 1,
      hist: [],
      samples: [],
      noiseFloor: 0,
      noiseHigh: 0,
      idle: -1,
      learned: false,
      quietRun: [],
      quiet: QUIET_DEFAULT,
      open: false,
      hold: 0,
      level: 0,
      smooth: 0,
      music: 0,
      below: 0,
      recent: [],
      openAt: 0,
      closeAt: 0,
      gainCapped: false,
      headroom: 0,
      clock: 0,
      onsets: [],
      lastOnset: -1e9,
      rawIdle: 99,
      bandMean: [0, 0, 0, 0],
      bandDev: [0, 0, 0, 0],
      bandPrev: [0, 0, 0, 0],
      bandPrimed: false,
      longWin: [],
      steady: false,
      reopened: 0,
      floorCap: FLOOR_MAX
    };
  }

  function reset(state) {
    state.gain = 1;
    state.hist.length = 0;
    state.samples.length = 0;
    state.noiseFloor = 0;
    state.noiseHigh = 0;
    state.idle = -1;
    state.learned = false;
    state.quietRun.length = 0;
    state.open = false;
    state.hold = 0;
    state.level = 0;
    state.smooth = 0;
    state.music = 0;
    state.below = 0;
    state.recent.length = 0;
    state.openAt = 0;
    state.closeAt = 0;
    state.gainCapped = false;
    state.headroom = 0;
    state.clock = 0;
    state.onsets.length = 0;
    state.lastOnset = -1e9;
    state.rawIdle = 99;
    state.bandMean = [0, 0, 0, 0];
    state.bandDev = [0, 0, 0, 0];
    state.bandPrev = [0, 0, 0, 0];
    state.bandPrimed = false;
    state.longWin.length = 0;
    state.steady = false;
    state.reopened = 0;
    state.floorCap = FLOOR_MAX;
  }

  // Raw-peak onset tracker (runs whether the gate is open or closed).
  function trackOnsets(state, raw, dt) {
    state.clock += dt;
    var now = state.clock;
    var fired = false;
    var aM = 1 - Math.exp(-dt / ONSET_MEAN_S);
    var aD = 1 - Math.exp(-dt / ONSET_DEV_S);
    for (var b = 0; b < 4; b++) {
      var x = Math.max(0, +raw[b] || 0);
      if (!state.bandPrimed) { state.bandMean[b] = x; state.bandDev[b] = 0.05; state.bandPrev[b] = x; continue; }
      var m = state.bandMean[b];
      var rise = x - m;
      var thr = Math.max(ONSET_MIN, ONSET_K * state.bandDev[b]);
      var hit = rise > thr && x > state.bandPrev[b] && now - state.lastOnset >= ONSET_REFRACTORY_S;
      if (hit) fired = true;
      else state.bandDev[b] += (Math.min(1, Math.abs(rise)) - state.bandDev[b]) * aD;
      state.bandMean[b] = m + rise * aM;
      state.bandPrev[b] = x;
    }
    state.bandPrimed = true;
    if (fired) {
      state.lastOnset = now;
      state.onsets.push(now);
    }
    while (state.onsets.length && now - state.onsets[0] > STEADY_WINDOW_S) state.onsets.shift();
    var recent = 0;
    for (var i = 0; i < state.onsets.length; i++) if (now - state.onsets[i] <= REOPEN_WINDOW_S) recent++;
    state.rawIdle = Math.min(99, now - state.lastOnset);
    state.steady = state.onsets.length >= STEADY_ONSETS;
    return recent;
  }

  function longFloorCap(state, level) {
    var now = state.clock;
    state.longWin.push({t: now, v: level});
    while (state.longWin.length && now - state.longWin[0].t > LONG_WINDOW_S) state.longWin.shift();
    if (state.longWin.length > 900) state.longWin.splice(0, state.longWin.length - 900);
    var vals = [];
    for (var i = 0; i < state.longWin.length; i++) vals.push(state.longWin[i].v);
    return Math.min(FLOOR_MAX, percentile(vals, FLOOR_PERCENTILE));
  }

  function setQuiet(state, value) {
    state.quiet = clamp(+value || 0, 0, 0.5);
  }

  function knee(x) {
    if (!(x > 0)) return 0;
    if (x < 0.72) return x;
    return 0.72 + 0.24 * (1 - Math.exp(-(x - 0.72) / 0.28));
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function pushSample(state, level) {
    state.samples.push(level);
    if (state.samples.length > SAMPLE_CAP) state.samples.shift();
    state.noiseFloor = Math.min(state.floorCap == null ? FLOOR_MAX : state.floorCap, percentile(state.samples, FLOOR_PERCENTILE));
    state.noiseHigh = percentile(state.samples, NOISE_HIGH_PERCENTILE);
  }

  function thresholds(state) {
    var span = Math.max(0, state.music - state.noiseFloor);
    var heard = state.music > 0;
    // Before any music has been heard (or when Listen starts mid-song and the
    // floor was learned from the song) open just over the floor, as before.
    state.openAt = state.noiseFloor + Math.max(state.quiet, OPEN_FRAC * span);
    if (heard && state.learned) {
      var noiseOpen = state.noiseHigh + Math.max(state.quiet, NOISE_MARGIN);
      // Never above the floor-to-music midpoint: noise learned from music
      // must not lift the open level over the music (Nov 10 lock-out).
      var mid = state.noiseFloor + Math.max(state.quiet, OPEN_FRAC * span);
      state.openAt = Math.max(state.openAt, Math.min(noiseOpen, Math.max(mid, state.music - CLOSE_DROP * 0.5)));
    }
    // Levels are dB-scaled bytes / 56 (1.0 ≈ 15 dB), so a stale low floor
    // cannot hold the gate open: it also closes CLOSE_DROP below the music.
    // The floor-relative close needs a real floor-to-music span (MIN_SPAN).
    var dropAt = heard ? state.music - CLOSE_DROP : -1;
    var floorAt = span >= MIN_SPAN ? state.noiseFloor + Math.max(state.quiet, CLOSE_FRAC * span) : -1;
    state.closeAt = Math.max(dropAt, floorAt);
  }

  function updateOpen(state, level, dt, warming, recentOnsets) {
    var head = level - state.noiseFloor;
    state.headroom = head;
    state.smooth += (level - state.smooth) * (1 - Math.exp(-dt / SMOOTH_S));
    if (warming) {
      state.open = false;
      state.hold = 0;
      state.below = 0;
      thresholds(state);
      return;
    }
    thresholds(state);
    // Onset idle: the band detector only sees audio while the gate is open, so
    // a closed gate must not wait on it. The gate's own tracker always hears.
    var idle = state.rawIdle;
    if (state.open && state.idle >= 0) idle = Math.min(idle, state.idle);
    var audible = level > state.noiseFloor + Math.max(0.5 * state.quiet, 0.04);
    if (!state.open) {
      state.over = level > state.openAt ? (state.over | 0) + 1 : 0;
      // Guaranteed reopen: a run of onsets or a steady beat over the floor.
      // Failsafe (TJ 10:24 AM): hits keep arriving while closed → force open.
      state.closedHits = state.rawIdle < 1.0 ? (state.closedHits || 0) + dt : 0;
      var reopen = (audible && (recentOnsets >= REOPEN_ONSETS || (state.steady && state.rawIdle < 0.6))) || state.closedHits >= FAILSAFE_S;
      if (state.over >= OPEN_FRAMES || reopen) {
        if (reopen && state.over < OPEN_FRAMES) state.reopened++;
        state.closedHits = 0;
        state.over = 0;
        state.open = true;
        state.below = 0;
        state.hold = CLOSE_SECONDS;
      }
    } else if ((state.smooth < state.closeAt && !(state.steady && idle < IDLE_S)) || (idle >= IDLE_S && state.smooth < state.music - IDLE_DROP) || idle >= IDLE_LONG_S) {
      state.below += dt;
      if (state.rawIdle >= QUIET_ONSET_S * 0.5) state.quietRun.push(level);
      if (state.quietRun.length > SAMPLE_CAP) state.quietRun.shift();
      state.hold = Math.max(0, CLOSE_SECONDS - state.below);
      if (state.below >= CLOSE_SECONDS) {
        state.open = false; state.below = 0; state.hold = 0;
        // Relearn the floor from the room as it is now, not stale samples.
        state.samples.length = 0;
        for (var q = 0; q < state.quietRun.length; q++) state.samples.push(state.quietRun[q]);
        if (!state.samples.length) state.samples.push(Math.min(state.noiseFloor, level));
        state.noiseFloor = Math.min(state.floorCap, percentile(state.samples, FLOOR_PERCENTILE));
        state.noiseHigh = percentile(state.samples, NOISE_HIGH_PERCENTILE);
        state.quietRun.length = 0;
        state.learned = true;
      }
    } else {
      state.below = 0;
      state.quietRun.length = 0;
      state.hold = CLOSE_SECONDS;
    }
    // Music reference: peak of the smoothed level, decaying (slowly while closed
    // so a pause does not shrink the span until noise could reopen it).
    var tau = state.open ? MUSIC_DECAY_OPEN_S : MUSIC_DECAY_CLOSED_S;
    var base = state.noiseFloor;
    if (state.music < base) state.music = base;
    state.music = base + (state.music - base) * Math.exp(-dt / tau);
    if (state.open && state.smooth > state.music) state.music = state.smooth;
    if (state.open) {
      state.recent.push(level);
      if (state.recent.length > RECENT_CAP) state.recent.shift();
      if (state.smooth < state.noiseFloor) state.noiseFloor = state.smooth;
      else {
        var target = percentile(state.recent, FLOOR_PERCENTILE);
        if (target > state.noiseFloor) state.noiseFloor += (target - state.noiseFloor) * (1 - Math.exp(-dt / FLOOR_RISE_OPEN_S));
      }
    } else {
      state.recent.length = 0;
    }
    if (state.noiseFloor > state.floorCap) state.noiseFloor = state.floorCap;
    thresholds(state);
  }

  function maxLevel(raw) {
    var peak = 0;
    for (var k = 0; k < 4; k++) {
      var v = Math.max(0, +raw[k] || 0);
      if (v > peak) peak = v;
    }
    return peak;
  }

  // Returns the four display levels. Updates state.noiseFloor, state.gain,
  // state.gainCapped, and state.open. Callers feed the mic to the onset
  // detector only while state.open is true.
  // idleS (optional): seconds since the onset detector last fired (any band).
  function scale(state, raw, dt, idleS) {
    var step = Math.max(0.001, Math.min(0.1, dt || 0.033));
    state.idle = idleS >= 0 ? +idleS : -1;
    var level = maxLevel(raw);
    state.level = level;
    var recentOnsets = trackOnsets(state, raw, step);
    state.floorCap = longFloorCap(state, level);
    var warming = state.samples.length < WARMUP_FRAMES;
    if (warming) pushSample(state, level);
    updateOpen(state, level, step, warming, recentOnsets);
    // Floor samples only from truly quiet frames (no onset for QUIET_ONSET_S).
    if (!warming && !state.open && state.rawIdle >= QUIET_ONSET_S) pushSample(state, level);

    var sum = 0;
    var n = 0;
    var peak = 0;
    for (var k = 0; k < 4; k++) {
      var v = Math.max(0, +raw[k] || 0);
      if (v > peak) peak = v;
      if (v >= 0.06) { sum += v * v; n++; }
    }
    var rms = n ? Math.sqrt(sum / n) : 0;
    state.hist.push({dt: step, rms: rms, peak: peak});
    var span = 0;
    for (var i = state.hist.length - 1; i >= 0; i--) {
      span += state.hist[i].dt;
      if (span > 1.25) { state.hist.splice(0, i); break; }
    }
    var rSum = 0;
    var rW = 0;
    var pMax = 0;
    for (var h = 0; h < state.hist.length; h++) {
      var s = state.hist[h];
      if (s.peak > pMax) pMax = s.peak;
      if (s.rms > 0) { rSum += s.rms * s.dt; rW += s.dt; }
    }
    var winRms = rW ? rSum / rW : 0;
    var ref = winRms > 0 ? winRms : (pMax > 0.06 ? pMax * 0.5 : 0);
    var head = level - state.noiseFloor;
    var maxGain = 1;
    if (head > state.quiet) {
      var t = Math.min(1, (head - state.quiet) / Math.max(state.quiet, 0.02));
      maxGain = 1 + t * 5;
    }
    var uncapped = ref < 0.05 ? 1 : Math.max(0.25, Math.min(6, 0.5 / ref));
    var desired = Math.min(uncapped, maxGain);
    state.gainCapped = uncapped - desired > 1e-4;
    var tau = desired < state.gain ? 0.22 : 0.8;
    state.gain += (desired - state.gain) * (1 - Math.exp(-step / tau));
    return [0, 1, 2, 3].map(function (band) {
      return knee((+raw[band] || 0) * state.gain);
    });
  }

  function bandPeaks(bytes, sampleRate, fftSize, bandsHz) {
    var edges = bandsHz && bandsHz.length === 4 ? bandsHz : BANDS;
    var peaks = [0, 0, 0, 0];
    if (!bytes || !(sampleRate > 0) || !(fftSize > 0)) return peaks;
    var hz = sampleRate / fftSize;
    for (var b = 0; b < 4; b++) {
      var i0 = Math.ceil(edges[b][0] / hz - 1e-4);
      var i1 = Math.ceil(edges[b][1] / hz - 1e-4) - 1;
      if (i0 < 1) i0 = 1;
      if (i1 > bytes.length - 1) i1 = bytes.length - 1;
      var loud = 0;
      if (i1 >= i0) {
        for (var i = i0; i <= i1; i++) if (bytes[i] > loud) loud = bytes[i];
      }
      // Same 56-count unit as the wasm meters, without the display clamp,
      // so a hit can still rise above a loud bed.
      peaks[b] = loud / 56;
    }
    return peaks;
  }

  // Closed gate: a zero spectrum, so noise-floor jitter cannot onset.
  // Open gate: the live analyser bytes, unchanged.
  function mask(state, bytes) {
    var length = bytes ? bytes.length : 0;
    if (state.open && bytes) {
      if (bytes instanceof Uint8Array) return bytes;
      return Uint8Array.from(bytes);
    }
    return new Uint8Array(length);
  }

  root.ndSilenceGate = {
    create: create,
    reset: reset,
    setQuiet: setQuiet,
    knee: knee,
    scale: scale,
    bandPeaks: bandPeaks,
    mask: mask,
    FLOOR_PERCENTILE: FLOOR_PERCENTILE,
    CLOSE_SECONDS: CLOSE_SECONDS,
    FLOOR_MAX: FLOOR_MAX,
    REOPEN_ONSETS: REOPEN_ONSETS,
    QUIET_DEFAULT: QUIET_DEFAULT
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const ndSilenceGate = globalThis.ndSilenceGate;
