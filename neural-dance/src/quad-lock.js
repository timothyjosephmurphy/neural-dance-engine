// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// The screen quad stays put once it is known. A new outline has to agree
// with itself for several looks before it can replace the locked quad.
// A one-off corner that lands far away is ignored. Small jitter is smoothed.

export function quadDistance(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const pa = a[i];
    const pb = b[i];
    if (!pa || !pb || !Number.isFinite(+pa.x) || !Number.isFinite(+pb.x)) return Infinity;
    sum += Math.hypot(+pa.x - +pb.x, +pa.y - +pb.y);
  }
  return sum / 4;
}

function copyQuad(quad) {
  return quad.map(point => ({x: +point.x, y: +point.y}));
}

function smoothQuad(current, next, alpha) {
  const gain = Math.min(1, Math.max(0, +alpha || 0));
  return current.map((point, index) => ({
    x: point.x + (next[index].x - point.x) * gain,
    y: point.y + (next[index].y - point.y) * gain
  }));
}

export function createQuadLock({agree = 4, near = 0.03, far = 0.08, smooth = 0.2} = {}) {
  const need = Math.max(2, agree | 0);
  const close = near > 0 ? near : 0.03;
  const outlier = far > close ? far : close * 2;
  let quad = null;
  let frozen = false;
  let streak = [];

  function agreed(candidate) {
    return streak.length >= need && streak.every(item => quadDistance(item, candidate) <= close);
  }

  return {
    locked() { return frozen && !!quad; },
    frozen() { return frozen; },
    quad() { return quad ? copyQuad(quad) : null; },
    force(next) {
      if (!next || next.length !== 4) return this.quad();
      quad = copyQuad(next);
      streak = [];
      return this.quad();
    },
    lock() {
      if (quad) frozen = true;
      streak = [];
      return this.quad();
    },
    unlock() {
      frozen = false;
      streak = [];
      return this.quad();
    },
    observe(candidate) {
      const current = this.quad();
      if (frozen) return {quad: current, locked: true, replaced: false, outlier: false};
      if (!candidate || candidate.length !== 4) return {quad: current, locked: false, replaced: false, outlier: false};
      const next = copyQuad(candidate);
      if (next.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        return {quad: current, locked: false, replaced: false, outlier: false};
      }
      if (!quad) {
        streak.push(next);
        if (streak.length > need) streak.shift();
        if (!agreed(next)) return {quad: null, locked: false, replaced: false, outlier: false};
        quad = copyQuad(next);
        streak = [];
        return {quad: this.quad(), locked: false, replaced: true, outlier: false};
      }
      const distance = quadDistance(quad, next);
      if (distance > outlier) {
        streak.push(next);
        if (streak.length > need) streak.shift();
        if (!agreed(next)) return {quad: current, locked: false, replaced: false, outlier: true};
        quad = copyQuad(next);
        streak = [];
        return {quad: this.quad(), locked: false, replaced: true, outlier: false};
      }
      if (distance <= close) {
        quad = smoothQuad(quad, next, smooth);
        streak = [];
        return {quad: this.quad(), locked: false, replaced: false, outlier: false, smoothed: true};
      }
      streak.push(next);
      if (streak.length > need) streak.shift();
      if (!agreed(next)) return {quad: current, locked: false, replaced: false, outlier: false};
      quad = copyQuad(next);
      streak = [];
      return {quad: this.quad(), locked: false, replaced: true, outlier: false};
    }
  };
}
