// Seed 24 layout (TJ 6:48 PM): rings inside the floor ellipse with staggered
// angles, so 24 sims spread out instead of piling into one clump, and the
// screen corners stay free for the insets. Stage px (1000x620).
export const SIM_RINGS = [[4, 0.34, 0.5], [8, 0.64, 0], [12, 0.96, 0.5]];
// Each Seed press adds one batch of 24 (TJ Nov 11 3:12 PM). Batch 0 is the
// original layout; later batches sit between the rings (radius shift) and are
// rotated by a golden-angle fraction so they fall in the gaps, not on top.
export const SIM_BATCH = 24;
const BATCH_R = [0, 0.15, -0.15, 0.075, -0.075, 0.225];
export function spreadPositions(batch = 0) {
  const CX = 500, CY = 318, RX = 350, RY = 218, out = [];
  const k = Math.max(0, batch | 0);
  const dr = BATCH_R[k % BATCH_R.length];
  const rot = (k * 0.381966) % 1;
  let i = 0;
  for (const [n, r0, off] of SIM_RINGS) {
    const r = Math.max(0.12, Math.min(1.08, r0 + dr));
    for (let j = 0; j < n; j++) {
      const a = -Math.PI / 2 + ((j + off + rot) / n) * Math.PI * 2;
      out.push([Math.round(CX + Math.cos(a) * RX * r), Math.round(CY + Math.sin(a) * RY * r), i % 4]);
      i++;
    }
  }
  return out;
}

// Total dancer cap (sims + stickers). Must match MAX_DANCERS in
// src/neural_dance.cpp; picked from the WebKit bench (see PR).
export const DANCER_LIMIT = 48;

// Positions for one Seed press: the next batch, trimmed to the room left
// under the cap. Returns {positions, batch, truncated, room}.
export function nextSeedBatch(simCount, totalCount, cap = DANCER_LIMIT) {
  const batch = Math.ceil(Math.max(0, simCount | 0) / SIM_BATCH);
  const room = Math.max(0, (cap | 0) - Math.max(0, totalCount | 0));
  const all = spreadPositions(batch);
  const positions = all.slice(0, room);
  return {positions, batch, room, truncated: positions.length < all.length};
}
