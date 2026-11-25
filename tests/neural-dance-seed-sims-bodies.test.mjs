// Seed adds 24 per press up to the dancer cap; sims draw the see-through body
// shell (not stick figures); body shell is translation-invariant (no floor
// wedge 'shadow' on right-hand Kick/Bass insets); no ripple figure cut-outs.
// TJ Nov 11 3:12-3:18 PM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spreadPositions, nextSeedBatch, DANCER_LIMIT, SIM_BATCH} from '../neural-dance/src/sim-layout.js';
import {DANCER_CAP, RIPPLE_MASK_FIGURES} from '../neural-dance/room-lab.js';
import {reduceShowCommand as applyShowCommand, freshShowState as defaultShowState} from '../neural-dance/src/show-commands.js';
import {traceBody, drawVolumeBody, drawVolumeBodyLite, footShape, VOLUME_TINT} from '../neural-dance/src/body-shell.js';
import {paintShadowFigure, skeletonPose, placePose} from '../neural-dance/src/skeleton-dancer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function mockCtx() {
  const ops = [];
  const grad = {addColorStop() {}};
  const state = {fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1};
  return new Proxy(state, {
    get(t, k) {
      if (k === 'ops') return ops;
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return (...args) => { ops.push({op: k, args, fillStyle: t.fillStyle, comp: t.globalCompositeOperation}); };
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
const pts = ops => ops.filter(o => /^(moveTo|lineTo|quadraticCurveTo|bezierCurveTo|arc|ellipse)$/.test(o.op)).map(o => o.args.slice(0, o.op === 'arc' || o.op === 'ellipse' ? 2 : o.args.length));

function pose(x = 300) {
  const unit = skeletonPose({id: 3, band: 1, weight: 0.6, ease: 0.3, side: 1, now: 4321, activation: 0.8, hush: 1});
  const p = placePose(unit, x, 520, 180);
  p.headR = (p.b && p.b.headR ? p.b.headR : 0.066) * p.height;
  return p;
}
function shift(p, dx) {
  const o = {};
  for (const k in p) { const v = p[k]; o[k] = v && typeof v === 'object' && Number.isFinite(+v.x) ? {...v, x: v.x + dx} : v; }
  return o;
}

test('batch 0 keeps the original Seed 24 layout; later batches land in the gaps', () => {
  const a = spreadPositions(), b = spreadPositions(0), c = spreadPositions(1);
  assert.deepEqual(a, b);
  assert.equal(a.length, SIM_BATCH);
  assert.equal(c.length, SIM_BATCH);
  let minD = Infinity;
  for (const p of c) for (const q of a) minD = Math.min(minD, Math.hypot(p[0] - q[0], p[1] - q[1]));
  assert.ok(minD > 20, 'batch 1 does not stack on batch 0 (min ' + minD.toFixed(1) + ' px)');
  for (const k of [1, 2, 3]) for (const [x, y] of spreadPositions(k)) { assert.ok(x > 60 && x < 940, 'x ' + x); assert.ok(y > 40 && y < 600, 'y ' + y); }
});

test('each Seed press adds 24 until the cap, then truncates and flags it', () => {
  assert.equal(nextSeedBatch(0, 0).positions.length, 24);
  assert.equal(nextSeedBatch(24, 24).positions.length, 24);
  assert.equal(nextSeedBatch(24, 24).batch, 1);
  const full = nextSeedBatch(DANCER_LIMIT, DANCER_LIMIT);
  assert.equal(full.positions.length, 0);
  assert.equal(full.truncated, true);
  const part = nextSeedBatch(24, 30, 48); // 6 stickers already latched
  assert.equal(part.positions.length, 18);
  assert.equal(part.truncated, true);
  assert.equal(nextSeedBatch(0, 0).truncated, false);
});

test('show state: sim-seed adds 24 per press, capped; sim-on does not stack', () => {
  let s = defaultShowState();
  s = applyShowCommand(s, {action: 'sim-seed'});
  assert.equal(s.simCount, 24);
  s = applyShowCommand(s, {action: 'sim-seed'});
  assert.equal(s.simCount, Math.min(48, DANCER_LIMIT));
  for (let i = 0; i < 6; i++) s = applyShowCommand(s, {action: 'sim-seed'});
  assert.equal(s.simCount, DANCER_LIMIT);
  s = applyShowCommand(s, {action: 'clear-sim'});
  s = applyShowCommand(s, {action: 'sim-on'});
  s = applyShowCommand(s, {action: 'sim-on'});
  assert.equal(s.simCount, 24);
});

test('room-lab appends a seed batch, toasts at the cap, and JS cap matches the wasm', () => {
  const room = read('neural-dance/room-lab.js');
  const cpp = read('neural-dance/src/neural_dance.cpp');
  const live = read('neural-dance/live-show.js');
  assert.match(room, /function seedSim\(\)\{const next=seedSimBatch\(\)/);
  assert.match(room, /nextSeedBatch\(sim\.length,total,DANCER_CAP\)/);
  assert.match(room, /new CustomEvent\('nd-dancer-cap'/);
  assert.equal(DANCER_CAP, DANCER_LIMIT);
  assert.match(live, /addEventListener\('nd-dancer-cap'[\s\S]{0,200}showStageToast/);
  const max = +(cpp.match(/constexpr int MAX_DANCERS = (\d+);/) || [])[1];
  assert.equal(max, DANCER_LIMIT, 'MAX_DANCERS in neural_dance.cpp must match DANCER_LIMIT');
});

test('no figure cut-outs of the ripple overlay (dark offset "shadow" dancers)', () => {
  const room = read('neural-dance/room-lab.js');
  assert.equal(RIPPLE_MASK_FIGURES, false);
  assert.match(room, /if\(RIPPLE_MASK_FIGURES\)\{try\{if\(silhouetteShow&&silhouetteShow\.mode\(\)==='silhouette'\)silhouetteShow\.maskFigures/);
});

test('body shell is translation-invariant (no floor wedge on right-hand insets)', () => {
  const p = pose(300);
  for (const dx of [400, 900, 1700]) {
    const q = shift(p, dx);
    for (const side of ['L', 'R']) {
      const fa = footShape(p, side), fb = footShape(q, side);
      if (!fa || !fb) continue;
      for (const k of Object.keys(fa)) {
        const a = fa[k], b = fb[k];
        if (a && typeof a === 'object' && Number.isFinite(+a.x)) {
          assert.ok(Math.abs(b.x - a.x - dx) < 1e-6, 'foot ' + side + '.' + k + ' x shifts by dx');
          assert.ok(Math.abs(b.y - a.y) < 1e-6, 'foot ' + side + '.' + k + ' y unchanged');
        }
      }
    }
    for (const draw of [(g, pp) => { g.beginPath(); traceBody(g, pp); }, (g, pp) => drawVolumeBody(g, pp, {glow: 0.6}), (g, pp) => drawVolumeBodyLite(g, pp, {glow: 0.6})]) {
      const ga = mockCtx(), gb = mockCtx();
      draw(ga, p); draw(gb, q);
      const A = pts(ga.ops), B = pts(gb.ops);
      assert.equal(A.length, B.length);
      let worst = 0;
      for (let i = 0; i < A.length; i++) for (let j = 0; j < A[i].length; j += 2) {
        worst = Math.max(worst, Math.abs(B[i][j] - A[i][j] - dx), Math.abs(B[i][j + 1] - A[i][j + 1]));
      }
      assert.ok(worst < 1e-6, 'path shifts rigidly with the dancer (worst ' + worst.toFixed(3) + ' px at dx ' + dx + ')');
    }
  }
});

test('cheap-LOD sims paint the see-through body shell, not stick capsules', () => {
  const unit = skeletonPose({id: 5, band: 0, weight: 0.3, ease: 0.3, side: -1, now: 2000, activation: 0.7, hush: 1});
  const p = placePose(unit, 200, 300, 70);
  const g = mockCtx();
  assert.equal(paintShadowFigure(g, p, (x, y) => ({x, y}), {lod: 'cheap', volume: true, glow: 0.6, skeleton: false}), true);
  const tintFills = g.ops.filter(o => o.op === 'fill' && o.fillStyle === VOLUME_TINT);
  assert.ok(tintFills.length >= 1, 'cheap sim fills the body outline with the shell tint');
  // The outline includes the foot paths and head ellipse of the body shell.
  assert.ok(g.ops.some(o => o.op === 'ellipse' || o.op === 'arc'), 'head drawn');
  assert.ok(g.ops.some(o => o.op === 'quadraticCurveTo' || o.op === 'bezierCurveTo'), 'curved anatomical outline, not straight capsules');
  // Same tint as the full-LOD sticker dancers.
  const full = mockCtx();
  paintShadowFigure(full, p, (x, y) => ({x, y}), {lod: 'full', volume: true, glow: 0.6, skeleton: false});
  assert.ok(full.ops.some(o => o.op === 'fill' && o.fillStyle === VOLUME_TINT));
  // Lite path uses no clip (cost) and no per-call radial gradients.
  assert.equal(g.ops.filter(o => o.op === 'clip').length, 0);
});
