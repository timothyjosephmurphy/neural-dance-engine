// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Continuous drift correction (TJ, Nov 10 10:35 AM: "the projection slides
// away from the stickers after Align").
//
// Stickers do not move on the wall. Right after a good map (Align, sticker
// check), the camera positions of the stickers it can see become anchors.
// If later the SAME stickers all show up shifted in the camera by the same
// small transform, the camera moved (phone bump, stabilization, zoom), not the
// stickers: the quad is moved by that transform, damped, so the dancers stay
// on the stickers without a jump. One sticker moving on its own (a dancer
// picks it up) is an outlier and is ignored.

import {fitCorrection, applyCorrection} from './sticker-verify.js';

export const DRIFT_CHECK_MS = 1000;
export const DRIFT_MATCH = 0.06; // camera 0-1: a detection belongs to an anchor within this
export const DRIFT_MIN_PX = 1.5; // detect px (480 wide): below this, nothing to fix
export const DRIFT_OUTLIER = 0.012; // camera 0-1 residual after the coherent fit
export const DRIFT_GAIN = 0.35; // fraction of the measured drift applied per check
export const DRIFT_CONFIRM = 3; // checks in a row that must agree before correcting
export const DRIFT_MAX_STEP = 0.01; // camera 0-1: largest corner move per correction

function median(list) {
  const v = list.slice().sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

export function createDriftWatch({gain = DRIFT_GAIN, confirm = DRIFT_CONFIRM, frameWidth = 480} = {}) {
  let anchors = [];
  let streak = 0;
  let last = null;
  let corrections = 0;
  let totalShift = 0;
  return {
    reset() { anchors = []; streak = 0; last = null; },
    anchors() { return anchors.map(a => ({...a})); },
    // A fresh, trusted map: remember where the stickers are right now.
    anchor(points) {
      anchors = (points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map(p => ({x: p.x, y: p.y}));
      streak = 0;
      return anchors.length;
    },
    // points: current sticker detections, camera 0-1. quad: current quad.
    // Returns {residualPx, matched, coherent, quad?: corrected quad, ...}.
    check(points, quad) {
      const det = (points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!anchors.length && det.length) {
        this.anchor(det);
        last = {residualPx: 0, matched: det.length, anchors: anchors.length, coherent: false, applied: false, note: 'anchored'};
        return last;
      }
      const pairs = [];
      const used = new Set();
      anchors.forEach((a, i) => {
        let best = -1;
        let bestD = DRIFT_MATCH;
        det.forEach((p, j) => {
          if (used.has(j)) return;
          const d = Math.hypot(p.x - a.x, p.y - a.y);
          if (d < bestD) { bestD = d; best = j; }
        });
        if (best >= 0) { used.add(best); pairs.push({i, from: a, to: det[best], d: bestD}); }
      });
      const residualPx = pairs.length ? +(median(pairs.map(p => p.d)) * frameWidth).toFixed(2) : null;
      const out = {residualPx, matched: pairs.length, anchors: anchors.length, coherent: false, applied: false, note: '', corrections, totalShiftPx: +(totalShift * frameWidth).toFixed(2)};
      if (pairs.length < 2) {
        streak = 0;
        out.note = pairs.length ? 'one sticker: cannot tell camera drift from a moved sticker' : 'no stickers matched';
        last = out;
        return out;
      }
      if (residualPx < DRIFT_MIN_PX) {
        streak = 0;
        out.note = 'steady';
        last = out;
        return out;
      }
      // Coherent fit, drop outliers (a sticker that moved), refit.
      let keep = pairs;
      let T = fitCorrection(keep.map(p => p.from), keep.map(p => p.to));
      if (T && keep.length >= 3) {
        const err = keep.map(p => { const q = applyCorrection(T, p.from); return Math.hypot(q.x - p.to.x, q.y - p.to.y); });
        const inl = keep.filter((p, k) => err[k] <= DRIFT_OUTLIER);
        if (inl.length >= 2 && inl.length < keep.length) { keep = inl; T = fitCorrection(keep.map(p => p.from), keep.map(p => p.to)); }
      }
      const resid = T ? Math.max(...keep.map(p => { const q = applyCorrection(T, p.from); return Math.hypot(q.x - p.to.x, q.y - p.to.y); })) : Infinity;
      out.coherent = !!T && resid <= DRIFT_OUTLIER && keep.length >= 2;
      out.inliers = keep.length;
      if (!out.coherent) {
        streak = 0;
        out.note = 'stickers moved differently: not a camera drift';
        last = out;
        return out;
      }
      streak += 1;
      if (streak < confirm || !Array.isArray(quad) || quad.length !== 4) {
        out.note = 'confirming ' + streak + '/' + confirm;
        last = out;
        return out;
      }
      // Damped step toward the measured transform.
      const damp = (p) => { const q = applyCorrection(T, p); return {x: p.x + (q.x - p.x) * gain, y: p.y + (q.y - p.y) * gain}; };
      let next = quad.map(damp);
      let step = Math.max(...next.map((p, k) => Math.hypot(p.x - quad[k].x, p.y - quad[k].y)));
      if (step > DRIFT_MAX_STEP) {
        const k = DRIFT_MAX_STEP / step;
        next = quad.map((p, idx) => ({x: p.x + (next[idx].x - p.x) * k, y: p.y + (next[idx].y - p.y) * k}));
        step = DRIFT_MAX_STEP;
      }
      // Anchors move with the camera by the same damped step.
      const f = step > 0 ? 1 : 0;
      anchors = anchors.map(a => { const q = damp(a); return f ? q : a; });
      corrections += 1;
      totalShift += step;
      out.applied = true;
      out.quad = next;
      out.stepPx = +(step * frameWidth).toFixed(2);
      out.kind = T.kind;
      out.corrections = corrections;
      out.totalShiftPx = +(totalShift * frameWidth).toFixed(2);
      out.note = 'corrected';
      last = out;
      return out;
    },
    last() { return last ? {...last, quad: undefined} : null; }
  };
}
