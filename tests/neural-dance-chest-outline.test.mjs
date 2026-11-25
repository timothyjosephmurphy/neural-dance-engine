// TJ Nov 11 5:35 PM (live 0d5d355): "spiky chest again when it turns
// sideways. It's not the bones sticking out, it's the outline of the chest."
// In profile the forward chest station is the widest knot on the front flank
// and the old per-segment quads met there with a ~53-85 deg tangent break.
// Sweep the yaw through a full turn and require a smooth flank: no corner at
// the chest at any yaw, no corner anywhere on the flank once the body is
// turned, and no outline vertex or control point outside the torso stations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {addTorsoPath, torsoStations, flankSmoothness} from '../neural-dance/src/body-shell.js';
import {skeletonPose, placePose} from '../neural-dance/src/skeleton-dancer.js';

const DEG = Math.PI / 180;

// Records the path ops, sampling curves densely; also keeps control points.
function recorder() {
  const ops = [];
  let cur = null;
  return {
    ops,
    moveTo(x, y) { cur = {x, y}; ops.push({k: 'M', a: cur, b: cur}); },
    lineTo(x, y) { const b = {x, y}; ops.push({k: 'L', a: cur, b}); cur = b; },
    quadraticCurveTo(cx, cy, x, y) { const b = {x, y}; ops.push({k: 'Q', a: cur, c: {x: cx, y: cy}, b}); cur = b; },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { const b = {x, y}; ops.push({k: 'C', a: cur, c: {x: c1x, y: c1y}, d: {x: c2x, y: c2y}, b}); cur = b; },
    closePath() {}, arc() {}, ellipse() {}
  };
}
function sample(op, n = 24) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    if (op.k === 'Q') out.push({x: u * u * op.a.x + 2 * u * t * op.c.x + t * t * op.b.x, y: u * u * op.a.y + 2 * u * t * op.c.y + t * t * op.b.y});
    else if (op.k === 'C') out.push({
      x: u * u * u * op.a.x + 3 * u * u * t * op.c.x + 3 * u * t * t * op.d.x + t * t * t * op.b.x,
      y: u * u * u * op.a.y + 3 * u * u * t * op.c.y + 3 * u * t * t * op.d.y + t * t * t * op.b.y});
    else out.push({x: op.a.x + (op.b.x - op.a.x) * t, y: op.a.y + (op.b.y - op.a.y) * t});
  }
  return out;
}
const same = (p, q, h) => Math.hypot(p.x - q.x, p.y - q.y) < h * 1e-6;
const tanIn = op => op.k === 'Q' ? {x: op.b.x - op.c.x, y: op.b.y - op.c.y} : op.k === 'C' ? {x: op.b.x - op.d.x, y: op.b.y - op.d.y} : {x: op.b.x - op.a.x, y: op.b.y - op.a.y};
const tanOut = op => op.k === 'Q' || op.k === 'C' ? {x: op.c.x - op.a.x, y: op.c.y - op.a.y} : {x: op.b.x - op.a.x, y: op.b.y - op.a.y};
const angle = (u, v) => {
  const l = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  return l < 1e-12 ? 0 : Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / l))) / DEG;
};

// Flank ops (nape -> hip) for each side, oriented top to bottom.
function flanks(pose) {
  const S = torsoStations(pose);
  const h = pose.height;
  const N = S.nape || S.yoke;
  const knots = side => [N, S.sh, S.chest, S.waist, S.hip].map(st => ({x: side < 0 ? st.xL : st.xR, y: st.y}));
  const rec = recorder();
  addTorsoPath(rec, pose);
  const ops = rec.ops;
  const out = {};
  for (const side of [-1, 1]) {
    const K = knots(side);
    // Op index whose end (left) / start (right) is the knot.
    const top = side < 0 ? ops.findIndex(o => same(o.b, K[0], h)) : ops.findIndex(o => same(o.a, K[0], h) && o.k !== 'M');
    const bot = side < 0 ? ops.findIndex(o => same(o.b, K[4], h)) : ops.findIndex(o => same(o.a, K[4], h) && o.k !== 'M');
    assert.ok(top >= 0 && bot >= 0, 'flank knots found on the path');
    let seg = side < 0 ? ops.slice(top + 1, bot + 1) : ops.slice(bot, top);
    if (side > 0) seg = seg.slice().reverse().map(o => o.k === 'Q' ? {k: 'Q', a: o.b, c: o.c, b: o.a} : o.k === 'C' ? {k: 'C', a: o.b, c: o.d, d: o.c, b: o.a} : {k: o.k, a: o.b, b: o.a});
    out[side] = {K, seg};
  }
  return {S, out, h};
}
// Tangent break where two flank ops meet at point P (deg).
function breakAt(seg, P, h) {
  for (let i = 0; i + 1 < seg.length; i++) if (same(seg[i].b, P, h)) return angle(tanIn(seg[i]), tanOut(seg[i + 1]));
  return null;
}
// Max turning within any 1.5 % h of arc length along the sampled flank.
function maxWindowTurn(seg, h, from) {
  const start = from ? seg.findIndex(o => same(o.a, from, h)) : 0;
  const ops = seg.slice(Math.max(0, start));
  const pts = [ops[0].a];
  for (const op of ops) pts.push(...sample(op));
  const turn = [], len = [];
  for (let i = 1; i + 1 < pts.length; i++) {
    const u = {x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y};
    const v = {x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y};
    turn.push(angle(u, v));
    len.push(Math.hypot(v.x, v.y));
  }
  let worst = 0;
  for (let i = 0; i < turn.length; i++) {
    let acc = 0, L = 0;
    for (let j = i; j < turn.length && L <= h * 0.015; j++) { acc += turn[j]; L += len[j]; }
    worst = Math.max(worst, acc);
  }
  return worst;
}
const POSES = [];
for (const band of [0, 1, 2, 3]) for (const now of [600, 1200, 2400, 5300]) {
  const unit = skeletonPose({id: 7 + band * 5, band, weight: band % 2 ? 0.4 : -0.3, ease: 0.3, side: band % 2 ? 1 : -1, now, activation: 0.2 + 0.25 * band, hush: 1});
  POSES.push(placePose(unit, 300 + band * 200, 120 + band * 300, 180 + band * 40));
}
const atYaw = (pose, yaw) => ({...pose, twist: {...(pose.twist || {}), facing: yaw}});

test('flank smoothness: front view keeps the old outline, turned bodies get the smooth flank', () => {
  assert.equal(flankSmoothness(0), 0);
  assert.equal(flankSmoothness(Math.PI), 0);
  assert.ok(flankSmoothness(30 * DEG) > 0.9);
  assert.equal(flankSmoothness(90 * DEG), 1);
  assert.equal(flankSmoothness(-90 * DEG), 1);
});

test('chest outline has no corner at any yaw (0..360)', () => {
  let worst = 0, at = '';
  for (const [pi, pose] of POSES.entries()) for (let d = 0; d <= 360; d += 5) {
    const {out, h} = flanks(atYaw(pose, d * DEG));
    for (const side of [-1, 1]) {
      const b = breakAt(out[side].seg, out[side].K[2], h);
      assert.ok(b != null, 'chest knot on the flank');
      if (b > worst) { worst = b; at = `pose ${pi} yaw ${d} side ${side}`; }
    }
  }
  // Front view had a 9 deg soft bend; profile was 53-85 deg (the spike).
  assert.ok(worst <= 12, `chest tangent break ${worst.toFixed(1)} deg at ${at}`);
});

test('turned torso flank is smooth from the nape to the hip: no spikes', () => {
  let worstKnot = 0, worstWin = 0, at = '';
  for (const [pi, pose] of POSES.entries()) for (let d = 0; d <= 360; d += 5) {
    if (Math.abs(Math.sin(d * DEG)) < 0.56) continue; // turned ~34 deg or more (fully smooth flank)
    const {out, h} = flanks(atYaw(pose, d * DEG));
    for (const side of [-1, 1]) {
      const {K, seg} = out[side];
      for (const k of K.slice(1, 4)) {
        const b = breakAt(seg, k, h);
        if (b > worstKnot) { worstKnot = b; at = `pose ${pi} yaw ${d} side ${side}`; }
      }
      for (let i = 0; i + 1 < seg.length; i++) worstKnot = Math.max(worstKnot, angle(tanIn(seg[i]), tanOut(seg[i + 1])) * (seg[i].k === 'L' ? 0 : 1));
      worstWin = Math.max(worstWin, maxWindowTurn(seg, h, K[1]));
    }
  }
  assert.ok(worstKnot <= 3, `flank tangent break ${worstKnot.toFixed(1)} deg (${at})`);
  // A spike turns a lot in a tiny length; a round chest spreads it out.
  // (Measured from the shoulder down: the trapezius-to-deltoid turn sits under
  // the arm and is covered by the C1 check above.)
  assert.ok(worstWin <= 40, `flank turns ${worstWin.toFixed(1)} deg within 1.5 % of body height`);
});

test('no flank vertex or control point overshoots its knots or leaves the torso hull at any yaw', () => {
  let worstOver = 0, worstHull = 0, atO = '', atH = '';
  for (const [pi, pose] of POSES.entries()) for (let d = 0; d <= 360; d += 5) {
    const {S, out, h} = flanks(atYaw(pose, d * DEG));
    const all = [...out[-1].K, ...out[1].K, {x: S.seat.midX, y: S.seat.y}, {x: S.neck.xL, y: S.neck.y}, {x: S.neck.xR, y: S.neck.y}];
    const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
    const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y));
    for (const side of [-1, 1]) {
      const {K, seg} = out[side];
      // Each op lies between two consecutive knots; nothing may bulge out past
      // the wider of them (an outward overshoot is what reads as a spike).
      let ki = 0;
      for (const op of seg) {
        while (ki < K.length - 2 && !(op.b.y <= K[ki + 1].y + 1e-9 && op.a.y >= K[ki].y - 1e-9)) ki++;
        const a = K[ki], b = K[ki + 1];
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        for (const p of [op.c, op.d, op.b, ...(op.k === 'L' ? [] : sample(op, 8))]) {
          if (!p) continue;
          // Outward only (left flank: smaller x); the old trapezius dips in.
          const o = Math.max(0, side < 0 ? lo - p.x : p.x - hi) / h;
          if (o > worstOver) { worstOver = o; atO = `pose ${pi} yaw ${d} side ${side} knot ${ki}`; }
          const q = Math.max(0, minX - p.x, p.x - maxX, minY - p.y, p.y - maxY) / h;
          if (q > worstHull) { worstHull = q; atH = `pose ${pi} yaw ${d} side ${side}`; }
        }
      }
    }
  }
  assert.ok(worstHull <= 1e-6, `outline point ${(worstHull * 100).toFixed(3)} % h outside the torso stations (${atH})`);
  assert.ok(worstOver <= 0.0025, `outline overshoots its knots by ${(worstOver * 100).toFixed(2)} % h (${atO})`);
});
