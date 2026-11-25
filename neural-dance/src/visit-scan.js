// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// A visit: someone steps into the frame, then leaves. Once the frame has been
// clear again for a short settle, run Scan stickers once. Nothing scans while
// a person is still in frame, and a visit only fires one scan.

export const VISIT_CLEAR_MS = 1500;
export const VISIT_COOLDOWN_MS = 3000;
// Enter a visit at 0.055 of the frame. Hold until coverage falls below 0.04
// so a reading of 0.074, just under the old 0.08 gate, still counts.
export const VISIT_COVERAGE_ON = 0.055;
export const VISIT_COVERAGE_OFF = 0.04;

export function visitCoveragePresent(coverage, held, personInView, latched, bridging) {
  if (held) return false;
  const cov = Number.isFinite(+coverage) ? +coverage : 0;
  if (personInView) return true;
  // An open visit stays open through one low frame while the hand is moving.
  // Motion does not open a visit that has not started.
  if (latched && bridging) return true;
  return latched ? cov >= VISIT_COVERAGE_OFF : cov >= VISIT_COVERAGE_ON;
}

// Downsampled brightness of a camera frame, so a later frame can be compared
// with the picture left after a scan without keeping the whole buffer.
export function sceneSignature(frame, step = 24) {
  if (!frame || !frame.data || !(frame.width > 0) || !(frame.height > 0)) return null;
  const w = frame.width | 0, h = frame.height | 0, data = frame.data, out = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const p = (y * w + x) * 4;
    out.push(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }
  return out;
}

export function sceneClose(a, b, maxMean = 18) {
  if (!a || !b || a.length !== b.length || !a.length) return false;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length <= maxMean;
}

export function createVisitScan({clearMs = VISIT_CLEAR_MS, cooldownMs = VISIT_COOLDOWN_MS} = {}) {
  const wait = Number.isFinite(+clearMs) && +clearMs >= 0 ? +clearMs : VISIT_CLEAR_MS;
  const cool = Number.isFinite(+cooldownMs) && +cooldownMs >= 0 ? +cooldownMs : VISIT_COOLDOWN_MS;
  let armed = false;
  let ready = true;
  let clearSince = 0;
  let count = null;
  let quietUntil = 0;
  let flight = false;
  function disarm() {
    armed = false;
    ready = false;
    clearSince = 0;
    flight = false;
  }
  return {
    observe({present = false, now = 0, scanning = false, learned = true, sceneMatch = true} = {}) {
      const quiet = now < quietUntil;
      if (scanning || flight || quiet) {
        armed = false;
        clearSince = 0;
        if (scanning || flight) return {state: 'scanning', scan: false, label: 'Scanning'};
        return {state: 'idle', scan: false, label: 'Clear'};
      }
      if (!learned) {
        disarm();
        count = null;
        ready = true;
        return {state: 'idle', scan: false, label: 'Clear'};
      }
      // After a capture the detector stays off until the floor has settled.
      // Quiet has already elapsed by the time we get here. A person stepping
      // in breaks the settled picture, so the visit starts on present alone.
      // sceneMatch is only how we know the painting is clear again before the
      // post-visit scan. Waiting for a match while they are still in frame
      // left ready stuck false (studio Nov 23: no scan after they left).
      if (!ready) {
        if (present) {
          armed = true;
          ready = true;
          clearSince = 0;
          count = null;
          return {state: 'person', scan: false, label: 'Person in frame'};
        }
        if (sceneMatch) {
          if (!clearSince) clearSince = now;
          if (now - clearSince >= wait) ready = true;
        } else clearSince = 0;
        return {state: 'idle', scan: false, label: count != null ? count + ' new stickers' : 'Clear'};
      }
      if (present) {
        armed = true;
        clearSince = 0;
        count = null;
        return {state: 'person', scan: false, label: 'Person in frame'};
      }
      if (armed) {
        if (!clearSince) clearSince = now;
        if (sceneMatch && now - clearSince >= wait) {
          armed = false;
          ready = false;
          clearSince = 0;
          flight = true;
          return {state: 'scanning', scan: true, label: 'Scanning'};
        }
        return {state: 'idle', scan: false, label: 'Clear'};
      }
      if (count != null) return {state: 'idle', scan: false, label: count + ' new stickers'};
      return {state: 'idle', scan: false, label: 'Clear'};
    },
    // Drop an arm that came from a stale background, without scanning.
    cancel() {
      armed = false;
      clearSince = 0;
      return {state: 'idle', scan: false, label: 'Clear'};
    },
    noteResult(n) {
      count = Math.max(0, n | 0);
      armed = false;
      clearSince = 0;
      flight = false;
      return count + ' new stickers';
    },
    // One capture just finished. Ignore the fade and the exposure recovery.
    quiet(now, ms = cool) {
      quietUntil = Math.max(quietUntil, (+now || 0) + (Number.isFinite(+ms) ? +ms : cool));
      disarm();
      return quietUntil;
    },
    // Re-learn finished and the white veil is down. The next walk-in may scan.
    // This does not require a scene match and does not extend the quiet window.
    arm() {
      armed = false;
      ready = true;
      clearSince = 0;
      flight = false;
      quietUntil = 0;
      return true;
    },
    ready() { return ready; }
  };
}
