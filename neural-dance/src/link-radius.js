// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Pulse link radius for the WASM network (TJ 7:41 PM: no pulse lines).
// The runtime only links dancers closer than its radius, which was a fixed
// 82 stage units. The spread Seed 24 layout (23f7dae) puts every nearest
// neighbour 88-115 apart, so nothing linked and no pulse ever travelled.
// The radius now follows the layout: 1.3 x the 75th-percentile nearest-
// neighbour distance, never below the original 82 and capped so a sparse
// stage does not wire everyone to everyone.
export const LINK_R_MIN = 82;
export const LINK_R_MAX = 170;
export const LINK_R_SCALE = 1.3;

export function nearestNeighbourDistances(points) {
  const out = [];
  const n = Array.isArray(points) ? points.length : 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    const a = points[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = points[j];
      const d = Math.hypot((+a.x || 0) - (+b.x || 0), (+a.y || 0) - (+b.y || 0));
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) out.push(best);
  }
  return out;
}

export function linkRadiusFor(points) {
  const nn = nearestNeighbourDistances(points).sort((a, b) => a - b);
  if (!nn.length) return LINK_R_MIN;
  const p75 = nn[Math.min(nn.length - 1, Math.floor(nn.length * 0.75))];
  const r = p75 * LINK_R_SCALE;
  if (!(r > LINK_R_MIN)) return LINK_R_MIN;
  return Math.min(LINK_R_MAX, Math.round(r * 10) / 10);
}
