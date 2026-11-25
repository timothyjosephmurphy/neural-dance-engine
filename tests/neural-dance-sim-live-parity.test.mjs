// Side sim → live parity (TJ Nov 11 7:07 PM): "Get it merged with the live
// version as well. Make sure nothing is lost from what I've added to live
// since last time the sim and the live were merged. But incorporate
// everything that's in the sim into live."
// Last sync: PR #96 (89acf2d). Sim-only since then and now in live:
// rave/club repertoire (#97), inner bones (#98, #100 ribs/feet), head turns
// + independent looks (#100), string confined to the head (#100).
// Live-only since then and kept: #99 idle body, #101 shrug, #102 peak
// pulses, #103 align, #104 scan wait, #105 seed sims, #106 sticker pose,
// #107 painting surface, #108 beat entrainment / arm limit / feet, knee IK.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {skeletonPose, paintShadowFigure, bodyTravelState, resetTravel, resetBodyDynamics, resetSpineFlex, limitArmsBehindHead,
  stanceWidthFor, buildFor, minStanceHalf, maxStanceHalf, BONE_PELVIS_LUMBAR, BONE_LUMBAR_THORACIC, BONE_THORACIC_NECK, THIGH, SHIN} from '../neural-dance/src/skeleton-dancer.js';
import {liveRaveLayer, raveSagittal, liveMusicDrivers} from '../neural-dance/src/live-rave.js';
import {HEAD_YAW_MAX} from '../neural-dance/src/head-look.js';
import {cleanShowTuning, innerBonesMode, DEFAULT_SHOW_TUNING} from '../neural-dance/src/silhouette.js';
import {drawDancerString, pointInHeadSilhouette} from '../neural-dance/src/vibrating-string.js';
import {girdleForward, armBackLimit} from '../neural-dance/src/arm-forward.js';

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (+a.z || 0) - (+b.z || 0));
const PERIOD = 500;
function run({id = 3, band = 1, act = 0.8, frames = 360, raveMoves, headLook, levels = null, pad = null, t0 = 1000, each} = {}) {
  resetTravel(id); resetBodyDynamics(id); resetSpineFlex(id);
  const out = [];
  for (let i = 0; i < frames; i++) {
    const now = t0 + i * 1000 / 30;
    const beat = Math.floor((now - t0) / PERIOD);
    const ease = ((now - t0) % PERIOD) / PERIOD;
    const side = beat % 2 ? 1 : -1;
    const strikes = [{t0: (t0 + beat * PERIOD) / 1000, energy: 0.8}];
    const u = skeletonPose({id, band, weight: side, ease, side, activation: act, now, periodMs: PERIOD, strikes, pulseAmp: 0.5, pulseHz: 1,
      beat, stepHz: 1000 / PERIOD, padFeatures: pad || {env: act > 0.5 ? 0.7 : 0, note: 0.4, contour: 0.5, crescendo: act > 0.9 ? 1 : 0},
      bandLevels: levels || [act, act * 0.8, 0.3, act], raveMoves, headLook});
    out.push(u);
    if (each) each(u, i);
  }
  return out;
}

test('(a) rave repertoire is active in live skeletonPose and follows energy', () => {
  const low = run({act: 0.06});
  const mid = run({act: 0.42});
  const high = run({act: 0.98});
  const loc = a => new Set(a.map(u => u.rave && u.rave.locomotor));
  assert.ok(low.every(u => u.rave), 'rave layer present');
  assert.deepEqual([...loc(low)], ['idle'], 'rest: bounce + nod only');
  assert.ok([...loc(mid)].some(l => l === 'twoStep' || l === 'fwdBack'), 'mid energy: two-step / forward-back');
  assert.ok(loc(high).has('runningMan') || loc(high).has('tStep'), 'high energy: running man / T-step');
  const maxAbs = (a, f) => Math.max(...a.map(u => Math.abs(f(u) || 0)));
  assert.ok(maxAbs(low, u => u.rave.nod) < maxAbs(high, u => u.rave.nod), 'nod scales with activation');
  assert.ok(maxAbs(high, u => u.rave.jack) > 0.01, 'jacking piston at high energy');
  assert.ok(high.some(u => u.rave.contactL !== 'flat' || u.rave.contactR !== 'flat'), 'heel / toe articulation');
  assert.ok(high.some(u => u.rave.kickLift > 0.002), 'kick accents on the free leg');
});

test('(a) rave moves toggle: 0 turns the layer off; the pose changes when on', () => {
  const on = run({act: 0.85, frames: 90});
  const off = run({act: 0.85, frames: 90, raveMoves: 0});
  assert.ok(off.every(u => u.rave === null));
  const diff = Math.max(...on.map((u, i) => d3(u.head, off[i].head)));
  assert.ok(diff > 0.002, 'rave visibly moves the head / spine: ' + diff);
});

test('(a) jacking / body wave / nod are sagittal and bounded', () => {
  const r = liveRaveLayer({tSec: 3.1, bpm: 124, beat: 6, beatPhase: 0, activation: 0.9, hush: 1, padFeatures: {env: 0.9}, bandLevels: [1, 1, 0.5, 1]});
  const sag = raveSagittal(r);
  for (const v of Object.values(sag)) assert.ok(Math.abs(v) <= 16 * Math.PI / 180 + 1e-9);
  assert.equal(liveRaveLayer({amount: 0}), null);
  const synth = liveMusicDrivers({activation: 0.5, beatPhase: 0});
  assert.ok(synth.kick > 0 && synth.hats === 0, 'no band levels: kick synthesised on the beat');
});

test('(a) 90° rave turns go through live travel, gated by max turn and turn frequency', () => {
  const id = 41;
  const go = (maxTurnDeg, turnFreq) => {
    resetTravel(id);
    let st = null, peak = 0;
    for (let i = 0; i < 120; i++) {
      const t = i / 30;
      const side = i < 2 ? -1 : 1; // one plant change at frame 2
      st = bodyTravelState({id, tSec: t, side, activation: 0.9, hush: 1, stepHz: 2, maxTurnDeg, turnFreq, rave: i === 2 ? {turnRad: Math.PI / 2, stepF: 0.03} : {turnRad: 0, stepF: 0}});
      if (Math.abs(st.facing) > Math.abs(peak)) peak = st.facing;
    }
    return {facing: peak};
  };
  const full = go(90, 0.7);
  assert.ok(full.facing > 0.6, 'turned toward 90°: ' + full.facing);
  assert.ok(full.facing <= Math.PI / 2 + 1e-6);
  assert.ok(Math.abs(go(30, 0.7).facing) <= 30 * Math.PI / 180 + 1e-6, 'Max body turn slider still caps');
  assert.ok(Math.abs(go(90, 0).facing) < 1e-3, 'Turn frequency 0 still disables turns');
});

test('(a) head turns with the shoulders and looks on its own within ±30°', () => {
  const a = run({act: 0.8, frames: 600});
  const rel = a.map(u => u.headYawRel);
  assert.ok(Math.max(...rel.map(Math.abs)) > 5 * Math.PI / 180, 'independent look present');
  assert.ok(Math.max(...rel.map(Math.abs)) <= HEAD_YAW_MAX + 1e-9);
  for (const u of a) {
    const t = u.twist;
    const want = t.facing + t.shYaw + u.headYawRel;
    assert.ok(Math.abs(u.headYaw - want) < 0.12, 'head follows shoulders + look');
  }
  const off = run({act: 0.8, frames: 60, headLook: false});
  assert.ok(off.every(u => u.headYawRel === 0));
  // Smooth: no whip between frames.
  for (let i = 1; i < a.length; i++) assert.ok(Math.abs(a[i].headYawRel - a[i - 1].headYawRel) < 0.03);
});

function mockCtx() {
  const calls = {stroke: 0, fill: 0, clip: 0, ellipse: 0};
  const noop = () => {};
  const grad = {addColorStop: noop};
  return {calls, ctx: new Proxy({}, {
    get(_, k) {
      if (k in calls) return () => { calls[k]++; };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({width: 1});
      if (typeof k === 'string' && /^[a-z]/.test(k)) return noop;
      return undefined;
    },
    set() { return true; }
  })};
}
function placed(u, H = 400) {
  const o = {b: u.b, height: H};
  for (const [k, p] of Object.entries(u)) {
    if (p && typeof p === 'object' && Number.isFinite(+p.x) && Number.isFinite(+p.y)) o[k] = {x: 300 + p.x * H, y: 40 + p.y * H, z: (+p.z || 0) * H};
    else if (k !== 'b') o[k] = p;
  }
  return o;
}

test('(a) inner bones paint in live, behind the quality toggle', () => {
  const u = run({act: 0.7, frames: 40}).pop();
  const pose = placed(u);
  const count = (opts) => { const m = mockCtx(); paintShadowFigure(m.ctx, pose, (x, y) => ({x, y}), {volume: true, ...opts}); return m.calls; };
  const offFull = count({lod: 'full', bones: 'off'});
  const onFull = count({lod: 'full', bones: 'stage'});
  assert.ok(onFull.stroke > offFull.stroke + 20, 'bones stroke on a full-LOD figure: ' + onFull.stroke + ' vs ' + offFull.stroke);
  assert.ok(onFull.clip >= 1, 'clipped to the body shell');
  const cheapStage = count({lod: 'cheap', bones: 'stage'});
  const cheapOff = count({lod: 'cheap', bones: 'off'});
  assert.equal(cheapStage.stroke, cheapOff.stroke, 'stage mode skips cheap-LOD seed sims (iPhone 13 budget)');
  const cheapAll = count({lod: 'cheap', bones: 'all'});
  assert.ok(cheapAll.stroke > cheapOff.stroke + 20, '"all" paints the seed sims too');
  assert.equal(DEFAULT_SHOW_TUNING.innerBones, 1);
  assert.equal(innerBonesMode(DEFAULT_SHOW_TUNING), 'stage');
  assert.equal(innerBonesMode(cleanShowTuning({innerBones: 0})), 'off');
  assert.equal(innerBonesMode(cleanShowTuning({innerBones: 2})), 'all');
  const t = cleanShowTuning({raveMoves: 9, headLook: false});
  assert.equal(t.raveMoves, 1.5);
  assert.equal(t.headLook, false);
  assert.equal(cleanShowTuning(null).raveMoves, 1);
});

test('(a) live string stays inside the head silhouette', () => {
  const head = {head: {x: 100, y: 50}, headR: 12, headRx: 10, height: 200};
  const contour = [{x: 99, y: 30}, {x: 101, y: 30}, {x: 101, y: 230}, {x: 99, y: 230}];
  const collect = [];
  const ctx = mockCtx().ctx;
  // A wide string wave so the head confine has something to clamp.
  drawDancerString(ctx, contour, {now: 0, band: 0, envelope: 1, samples: [1, -1, 1, -1, 1, -1], width: 1, collect, head, limit: false, xy: (x, y) => ({x: x + 40 * Math.sin(y), y})});
  const pts = collect[0].points;
  for (const p of pts) assert.ok(pointInHeadSilhouette(p, head, 0.9), 'outside head at y=' + p.y);
});

test('(b) kept: rigid bones, stance bounds, arm limit, rest and silence', () => {
  const b = buildFor(3, 1);
  const check = (u) => {
    assert.ok(Math.abs(d3(u.hipL, u.kneeL) - THIGH) < 2e-3, 'thigh length');
    assert.ok(Math.abs(d3(u.kneeL, u.ankleL) - SHIN) < 2e-3, 'shin length');
    assert.ok(Math.abs(d3(u.hipR, u.kneeR) - THIGH) < 2e-3);
    if (u.lumbar && u.pelvis) assert.ok(Math.abs(d3(u.pelvis, u.lumbar) - BONE_PELVIS_LUMBAR) < 3e-3, 'spine canon');
    assert.ok(u.stanceW >= minStanceHalf(b) - 1e-9 && u.stanceW <= maxStanceHalf(b) + 1e-9, 'stance bounds');
    const f = girdleForward(u.shL, u.shR);
    const lim = armBackLimit(u.head, b.headR, f);
    for (const k of ['elL', 'elR', 'wristL', 'wristR']) assert.ok(u[k].x * f.x + (+u[k].z || 0) * f.z >= lim - 1e-6, k + ' behind head');
  };
  for (const act of [0.1, 0.5, 0.95]) run({act, frames: 240, each: check});
  // Low activation (TJ 11:24 AM): both feet planted, rave does not add lifts.
  run({act: 0.06, frames: 120, each: u => { assert.ok((u.liftL || 0) < 0.003 && (u.liftR || 0) < 0.003, 'low-activation lift'); }});
  // Silence / still hold: no rave, no head look.
  const still = skeletonPose({id: 3, band: 1, activation: 0.8, now: 2000, hush: 1, still: true});
  assert.equal(still.rave, null);
  assert.equal(still.headYawRel, 0);
  const hushed = skeletonPose({id: 3, band: 1, activation: 0, now: 2000, hush: 0, beat: 1, stepHz: 2});
  assert.ok(!hushed.rave || (hushed.rave.bounce === 0 && hushed.rave.nod === 0));
});

test('(b) kept: live-only features since the last sync are still wired', () => {
  const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const room = read('neural-dance/room-lab.js');
  const dancer = read('neural-dance/src/skeleton-dancer.js');
  const live = read('src/pages/neural-dance/live/index.astro');
  assert.match(dancer, /limitArmsBehindHead\(unit/, '#108 arm limit');
  assert.match(read('neural-dance/src/body-shell.js'), /paintFootRead/, '#108 readable feet');
  assert.match(dancer, /kneeForwardOf/, 'knee IK fix');
  assert.match(live, /sim-seed/, '#105 seed sims');
  for (const c of ['rave-moves', 'inner-bones', 'head-look']) {
    assert.match(live, new RegExp('data-control="' + c + '"'), c + ' control on /live/');
    assert.match(room, new RegExp("bindSlider\\('" + c + "'"), c + ' bound');
  }
});

test('(a) live show integration: stickers + 24 sims run rave moves, head looks and bones', async () => {
  const {createSilhouetteShow, dancerStateId} = await import('../neural-dance/src/silhouette.js');
  const target = {canvas: {width: 1280, height: 800}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  const ctx = new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set(t, k, v) { t[k] = v; return true; }});
  const box = (cx, cy, h) => { const w = h * 0.4; return [{x: cx - w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy + h / 2}, {x: cx - w / 2, y: cy + h / 2}]; };
  const sims = []; for (let i = 0; i < 24; i++) sims.push({id: 1 + i, x: 80 + (i % 8) * 115, y: 140 + Math.floor(i / 8) * 170, type: i % 4, kind: 'sim'});
  const stickers = [{id: 1, x: 470, y: 420, type: 0}, {id: 2, x: 620, y: 310, type: 1}].map(s => ({...s, kind: 'sticker', contour: box(s.x, s.y, 260)}));
  const markers = stickers.concat(sims);
  const runShow = (tune) => {
    const show = createSilhouetteShow(); show.setMode('silhouette');
    if (tune) show.setTuning(tune);
    const seen = {rave: new Set(), look: 0, bonesSticker: 0, bonesSim: 0};
    for (let i = 0; i < 240; i++) {
      const now = 1000 + i * 33.3; if (i % 15 === 0) show.beat(now, 15);
      show.paint(ctx, markers, {now, levels: [0.9, 0.8, 0.6, 0.9], songOpen: true, network: markers.map(m => ({id: dancerStateId(m), received: 0.95}))});
      if (i < 60) continue;
      for (const f of show.figureHeights()) {
        if (f.rave) seen.rave.add(f.rave);
        seen.look = Math.max(seen.look, Math.abs(f.headYawRel || 0));
        if (f.kind === 'sticker') seen.bonesSticker += f.bones || 0; else seen.bonesSim += f.bones || 0;
      }
    }
    return seen;
  };
  const on = runShow(null);
  assert.ok(on.rave.size >= 1 && [...on.rave].some(l => l !== 'idle'), 'live dancers dance the repertoire: ' + [...on.rave]);
  assert.ok(on.look > 2 * Math.PI / 180, 'independent head looks in live');
  assert.ok(on.bonesSticker > 0, 'stage figures paint inner bones');
  assert.equal(on.bonesSim, 0, 'default "Stage" quality: small seed sims skip bones');
  const off = runShow({raveMoves: 0, innerBones: 0, headLook: false});
  assert.equal(off.rave.size, 0);
  assert.equal(off.look, 0);
  assert.equal(off.bonesSticker, 0);
});
