// TJ 11:44 AM PT: "The bodies are wandering away from the chakra points. The
// root chakra should stay rooted at the perineum and the crown at the top of
// the head, just above it." Chakra anchors come from the final posed body
// every frame (after squat, grounding, rebalance and placement); the string is
// drawn on them on stage and in the insets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {restProbe} from './helpers/rest-probe.mjs';
import {chakraStringXY, fineLineWidth, STRING_DIM} from '../neural-dance/src/silhouette.js';
import {STRING_ROOT_S, STRING_CROWN_S, drawDancerString, chakraPoints} from '../neural-dance/src/vibrating-string.js';
import {buildFor, CROWN_ABOVE_HEAD, THIGH, chakraAnchors, CHAKRAS_7, skeletonPose, placePoseOnFloor, resetArmLiftFamilies} from '../neural-dance/src/skeleton-dancer.js';
import {resetTravel, resetBodyDynamics, resetSpineFlex} from '../neural-dance/src/skeleton-motion.js';
import {torsoStations} from '../neural-dance/src/body-shell.js';

test('chakra root stays on the groin and crown just above the head top through squats, weight shifts, steps and jumps', () => {
  const phases = [];
  for (let k = 0; k < 3; k++) phases.push({s: 20, kind: 'music', bpm: 120, level: 0.3}, {s: 20, kind: 'music', bpm: 124, level: 1.0, bass: true}, {s: 8, kind: 'silence'}, {s: 10, kind: 'music', bpm: 96, level: 0.6});
  let n = 0, rootErr = 0, crownErr = 0, pelvisDev = 0, stringErr = 0, squat = 0, jumps = 0, steps = 0;
  const base = new Map();
  restProbe({phases, dancers: 4, fps: 30, jitterPx: 2, onFrame(fr, x) {
    const c = fr.chakra, j = fr.joints;
    if (!c || !j || !j.head) return;
    n++;
    // Drawn height (the beat throb scales the whole body, head included).
    const h = Math.hypot(j.kneeL.x - j.hipL.x, j.kneeL.y - j.hipL.y, j.kneeL.z - j.hipL.z) / THIGH, b = buildFor(fr.id, fr.band);
    rootErr = Math.max(rootErr, Math.hypot(c.root.x - j.groin.x, c.root.y - j.groin.y) / h);
    const top = {x: j.head.x, y: j.head.y - b.headR * h};
    const above = (top.y - c.crown.y) / h;
    crownErr = Math.max(crownErr, Math.hypot(c.crown.x - top.x, above - CROWN_ABOVE_HEAD));
    assert.ok(above >= -0.003, 'crown never inside the head (' + above.toFixed(4) + ')');
    // The jointed spine rides with the groin (no body/string split).
    if (j.pelvis) { const d = (j.pelvis.y - j.groin.y) / h; const b0 = base.get(fr.id) ?? d; base.set(fr.id, b0); pelvisDev = Math.max(pelvisDev, Math.abs(d - b0)); }
    // The drawn string: axis s=0 / s=1 land exactly on the anchors.
    const span = (c.root.y - c.crown.y) / (STRING_ROOT_S - STRING_CROWN_S);
    const top0 = c.crown.y - span * STRING_CROWN_S, map = chakraStringXY(c);
    const r = map(c.root.x, top0 + span * STRING_ROOT_S), cr = map(c.root.x, top0 + span * STRING_CROWN_S);
    stringErr = Math.max(stringErr, Math.hypot(r.x - c.root.x, r.y - c.root.y) / h, Math.hypot(cr.x - c.crown.x, cr.y - c.crown.y) / h);
    if ((+fr.squat || 0) > 0.5) squat++;
    if (+fr.jump > 0) jumps++;
    if (x.liftL > 0.01 || x.liftR > 0.01) steps++;
  }});
  console.log('# chakra', JSON.stringify({n, rootErr, crownErr, pelvisDev, stringErr, squat, jumps, steps}));
  assert.ok(squat > 100 && jumps > 0 && steps > 100, 'covered squats, jumps and steps');
  assert.ok(rootErr < 0.01, 'root on the groin (' + rootErr.toFixed(4) + ' heights)');
  assert.ok(crownErr < 0.01, 'crown just above the head top (' + crownErr.toFixed(4) + ' heights)');
  assert.ok(stringErr < 1e-6, 'string drawn on the anchors');
  assert.ok(pelvisDev < 0.01, 'spine rides with the groin (' + pelvisDev.toFixed(4) + ')');
});

function halfAtY(S, y) {
  const seq = ['yoke', 'neck', 'sh', 'chest', 'waist', 'hip', 'seat'].map(k => S[k]).filter(Boolean)
    .sort((a, b) => a.y - b.y);
  if (!seq.length) return null;
  if (y <= seq[0].y) return {mid: seq[0].midX, half: seq[0].ext, y0: seq[0].y, y1: seq[0].y};
  if (y >= seq[seq.length - 1].y) return {mid: seq[seq.length - 1].midX, half: seq[seq.length - 1].ext};
  for (let i = 0; i < seq.length - 1; i++) {
    if (y >= seq[i].y && y <= seq[i + 1].y) {
      const t = (y - seq[i].y) / Math.max(1e-6, seq[i + 1].y - seq[i].y);
      return {
        mid: seq[i].midX + (seq[i + 1].midX - seq[i].midX) * t,
        half: seq[i].ext + (seq[i + 1].ext - seq[i].ext) * t
      };
    }
  }
  return {mid: seq[0].midX, half: seq[0].ext};
}

function mockCtx() {
  const paths = [];
  let path = null;
  const ctx = {
    paths,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    lineCap: '', lineJoin: '', globalCompositeOperation: 'source-over',
    save() {}, restore() {},
    beginPath() { path = {moves: [], fill: null, stroke: null, arcs: 0}; paths.push(path); },
    moveTo(x, y) { path.moves.push([x, y]); },
    lineTo(x, y) { path.moves.push([x, y]); },
    closePath() {},
    fill() { path.fill = {style: ctx.fillStyle, alpha: ctx.globalAlpha}; },
    stroke() { path.stroke = {style: ctx.strokeStyle, alpha: ctx.globalAlpha, width: ctx.lineWidth}; },
    clearRect() {}, fillRect() {},
    arc(x, y) { path.arcs = (path.arcs || 0) + 1; path.moves.push([x, y]); },
    createRadialGradient() { return {addColorStop() {}}; }
  };
  return ctx;
}

test('chakra string renders with 7 anchors inside the torso', () => {
  resetTravel(); resetBodyDynamics(); resetSpineFlex(); resetArmLiftFamilies();
  const ids = [0, 2, 3, 7];
  for (const id of ids) {
    const band = id % 4;
    for (const dancing of [false, true]) {
      const unit = skeletonPose({
        id, band, activation: dancing ? 1.1 : 0, hush: 1, still: !dancing,
        now: dancing ? 3200 : 4000, periodMs: 480, side: -1, ease: dancing ? 0.35 : 0,
        weight: dancing ? -1 : 0, maxBodyTurn: dancing ? 90 : 0, turnFreq: dancing ? 1.3 : 0
      });
      const posed = placePoseOnFloor(unit, {cx: 400, cy: 260, baseH: 200, height: 200, anchorFloorY: 500});
      const anchors = chakraAnchors(posed);
      assert.ok(anchors && Array.isArray(anchors.points), 'id ' + id + ' has anchors');
      assert.equal(anchors.points.length, 7, 'id ' + id + ' has 7 chakra points');
      assert.deepEqual(anchors.points.map(p => p.id), CHAKRAS_7.map(c => c.id));

      const h = posed.height || 200;
      const slop = 0.03 * h;
      const S = torsoStations(posed);
      const seatY = S.seat.y;
      const headR = (posed.b && posed.b.headR ? posed.b.headR : 0.06) * h;
      for (const p of anchors.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), p.id + ' is finite');
        assert.ok(p.y <= seatY + slop, p.id + ' is not below the pelvis (y ' + p.y.toFixed(1) + ' vs seat ' + seatY.toFixed(1) + ')');
        assert.ok(p.y >= anchors.crown.y - slop, p.id + ' is not above the crown');
        if (p.id === 'crown' || p.id === 'thirdEye') {
          const dx = Math.abs(p.x - posed.head.x);
          assert.ok(dx <= headR * 1.35, p.id + ' stays in the head (dx ' + dx.toFixed(1) + ' r ' + headR.toFixed(1) + ')');
          continue;
        }
        const env = halfAtY(S, p.y);
        assert.ok(env, p.id + ' has a torso envelope');
        const dx = Math.abs(p.x - env.mid);
        // Tight but yaw/jiggle-safe: the spine must sit well inside the half-width.
        assert.ok(dx <= env.half * 0.85 + 1, p.id + ' is inside the torso (dx ' + dx.toFixed(1) + ' half ' + env.half.toFixed(1) + ')');
      }

      const spanH = Math.max(4, (anchors.root.y - anchors.crown.y) / (STRING_ROOT_S - STRING_CROWN_S));
      const sTop = anchors.crown.y - spanH * STRING_CROWN_S;
      const ax = anchors.root.x;
      const axisContour = [
        {x: ax - 1, y: sTop}, {x: ax + 1, y: sTop},
        {x: ax + 1, y: sTop + spanH}, {x: ax - 1, y: sTop + spanH}
      ];
      const collect = [];
      const ctx = mockCtx();
      const ok = drawDancerString(ctx, axisContour, {
        xy: chakraStringXY(anchors),
        now: 3200,
        band,
        envelope: 1,
        strikes: dancing ? [{t0: 3.0, side: 1, energy: 1.1}] : [],
        pulseAmp: 16,
        pulseHz: 1.1,
        width: fineLineWidth(h),
        alpha: 0.8 * STRING_DIM,
        dim: STRING_DIM,
        collect,
        travel: true,
        travelS: dancing ? 0.55 : -1
      });
      assert.equal(ok, true, 'id ' + id + ' string paints');
      assert.ok(collect[0] && collect[0].points && collect[0].points.length > 8, 'id ' + id + ' string has samples');
      const lights = chakraPoints(collect[0].points, {envelope: 1, travelS: dancing ? 0.55 : -1});
      assert.equal(lights.length, 7, 'id ' + id + ' paints 7 chakra nodes');
      const arcs = ctx.paths.reduce((n, p) => n + (p.arcs || 0), 0);
      assert.ok(arcs >= 7, 'id ' + id + ' drew chakra node arcs (' + arcs + ')');
      const stroked = ctx.paths.filter(p => p.stroke);
      assert.ok(stroked.length > 4, 'id ' + id + ' stroked the string');
      for (const light of lights) {
        assert.ok(light.y <= seatY + slop, 'drawn node ' + light.id + ' is not below the pelvis');
        const env = halfAtY(S, light.y);
        if (!env) continue;
        const dx = Math.abs(light.x - env.mid);
        // The calmer string may shimmer, but it stays inside the body.
        assert.ok(dx <= env.half + 2, 'drawn node ' + light.id + ' stays in the torso (dx ' + dx.toFixed(1) + ' half ' + env.half.toFixed(1) + ')');
      }
    }
  }
});
