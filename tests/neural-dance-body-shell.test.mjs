import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {drawShadowFigure, torsoStations, shadeTorsoAndHead, KEY_LIGHT} from '../neural-dance/src/body-shell.js';
import {paintShadowFigure, skeletonPose, placePose, buildFor} from '../neural-dance/src/skeleton-dancer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('body-shell exports the sim painter and key light', () => {
  assert.equal(typeof drawShadowFigure, 'function');
  assert.equal(typeof torsoStations, 'function');
  assert.equal(typeof shadeTorsoAndHead, 'function');
  assert.ok(Number.isFinite(KEY_LIGHT.x) && Number.isFinite(KEY_LIGHT.y));
});

test('official sim and live both import body-shell.js', () => {
  const sim = readFileSync(join(root, 'static/neural-dance/sim/index.html'), 'utf8');
  const dancer = readFileSync(join(root, 'neural-dance/src/skeleton-dancer.js'), 'utf8');
  assert.match(sim, /body-shell\.js/);
  assert.match(sim, /pad-arms\.js/);
  assert.match(sim, /melody-pad\.js/);
  assert.match(dancer, /from '\.\/body-shell\.js'/);
  assert.match(dancer, /from '\.\/pad-arms\.js'/);
});

test('full LOD paintShadowFigure calls the shared shell; cheap lod does not require it to throw', () => {
  const unit = skeletonPose({id: 2, band: 2, weight: 0, ease: 0.3, side: -1, now: 1200, activation: 0.6, hush: 1});
  const pose = placePose(unit, 100, 20, 200);
  const calls = {begin: 0, ellipse: 0, fill: 0, save: 0, restore: 0};
  const ctx = {
    beginPath() { calls.begin++; },
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    fill() { calls.fill++; }, stroke() {},
    save() { calls.save++; }, restore() { calls.restore++; },
    clip() {}, arc() {},
    ellipse() { calls.ellipse++; },
    createLinearGradient() { return {addColorStop() {}}; },
    fillRect() {},
    arc() {},
    globalAlpha: 1, lineCap: '', lineJoin: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, globalCompositeOperation: 'source-over'
  };
  assert.equal(paintShadowFigure(ctx, pose, (x, y) => ({x, y}), {lod: 'full'}), true);
  assert.ok(calls.fill > 0, 'shell should fill the body');
  const cheap = { ...ctx, beginPath() { calls.begin++; }, fill() { calls.fill++; } };
  assert.equal(paintShadowFigure(ctx, pose, (x, y) => ({x, y}), {lod: 'cheap'}), true);
});

test('torsoStations keeps chest depth at 90° yaw', () => {
  const b = buildFor(1, 2);
  const pose = {
    b, height: 200,
    neck: {x: 0, y: 20}, heart: {x: 0, y: 50}, groin: {x: 0, y: 120},
    shL: {x: -30, y: 30}, shR: {x: 30, y: 30},
    hipL: {x: -16, y: 110}, hipR: {x: 16, y: 110},
    twist: {facing: Math.PI / 2}
  };
  const st = torsoStations(pose);
  assert.ok(st && st.chest, 'stations exist');
  assert.ok(st.chest.ext > 12, '90° profile keeps chest depth, ext=' + st.chest.ext);
});

function trackingCtx() {
  const calls = {save: 0, restore: 0, clip: 0, fill: 0};
  const ctx = {
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    fill() { calls.fill++; }, stroke() {},
    save() { calls.save++; }, restore() { calls.restore++; },
    clip() { calls.clip++; },
    arc() {},
    ellipse() {},
    createLinearGradient() { return {addColorStop() {}}; },
    fillRect() {},
    globalAlpha: 1, lineCap: '', lineJoin: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, globalCompositeOperation: 'source-over'
  };
  return {ctx, calls};
}

test('full-LOD shell balances canvas save and restore, even if clip throws', () => {
  const unit = skeletonPose({id: 2, band: 2, weight: 0, ease: 0.3, side: -1, now: 1200, activation: 0.6, hush: 1});
  const pose = placePose(unit, 100, 20, 200);
  const {ctx, calls} = trackingCtx();
  for (let i = 0; i < 8; i++) {
    assert.equal(paintShadowFigure(ctx, pose, (x, y) => ({x, y}), {lod: 'full'}), true);
  }
  assert.equal(calls.save, calls.restore, 'save=' + calls.save + ' restore=' + calls.restore);
  assert.ok(calls.fill > 0, 'shell filled');
  // WebKit can throw on a degenerate clip; the painter must still restore.
  const boom = trackingCtx();
  boom.ctx.clip = () => { boom.calls.clip++; throw new Error('clip failed'); };
  assert.doesNotThrow(() => paintShadowFigure(boom.ctx, pose, (x, y) => ({x, y}), {lod: 'full'}));
  assert.equal(boom.calls.save, boom.calls.restore, 'leaked save after clip throw: save=' + boom.calls.save + ' restore=' + boom.calls.restore);
});

import {thighChain, armChain, footShape} from '../neural-dance/src/body-shell.js';
import {placePoseOnFloor, CANON_HEADS} from '../neural-dance/src/skeleton-dancer.js';

test('see-through limbs have anatomical volume; rest thigh gap stays ~30 px', () => {
  const unit = skeletonPose({id: 2, band: 2, activation: 0, hush: 1, still: true, now: 4000, periodMs: 480});
  const posed = placePoseOnFloor(unit, {cx: 422, cy: 210, baseH: 250, height: 250, anchorFloorY: 335});
  const headH = posed.height / CANON_HEADS;
  const thL = thighChain(posed, -1);
  const thR = thighChain(posed, 1);
  const topHeads = (2 * thL.r[0]) / headH;
  assert.ok(topHeads >= 0.52 && topHeads <= 0.66, 'thigh widest at top ~0.55–0.6 heads, got ' + topHeads.toFixed(3));
  assert.ok(thL.r[0] >= Math.max(...thL.r.slice(0, 3)) * 0.98, 'thigh is widest at the top');
  assert.ok(thL.kneeR < thL.topR * 0.72, 'knee narrower than thigh top');
  assert.ok(thL.calfR > thL.kneeR * 1.1, 'calf bulge is wider than the knee');
  assert.ok(thL.ankR < thL.calfR * 0.72, 'ankle slimmer than the calf');
  const gap = (thR.top.x - thR.r[0]) - (thL.top.x + thL.r[0]);
  assert.ok(gap > 24 && gap < 38, 'rest inner thigh gap stays ~30 px, got ' + gap.toFixed(1));

  const arm = armChain(posed, 1);
  assert.ok(arm.delR > arm.elR * 1.15, 'deltoid cap is wider than the elbow');
  assert.ok(arm.biR > arm.elR * 1.05, 'bicep / tricep swell');
  assert.ok(arm.faR > arm.wrR * 1.15, 'forearm is wider near the elbow than at the wrist');
  assert.ok(arm.palmR > arm.wrR * 1.2, 'mitten palm is wider than the wrist');
});

test('planted foot has a flat sole from heel to toe; pivoted foot follows the heel and toe', () => {
  const unit = skeletonPose({id: 2, band: 2, activation: 0, hush: 1, still: true, now: 4000, periodMs: 480});
  const posed = placePoseOnFloor(unit, {cx: 422, cy: 210, baseH: 250, height: 250, anchorFloorY: 335});
  const ft = footShape(posed, 1);
  assert.equal(ft.kind, 'foot');
  assert.equal(ft.planted, true);
  assert.ok(ft.outline && ft.outline.length >= 8, 'closed foot outline');
  assert.ok(ft.sole && ft.sole.length >= 3, 'sole has heel, arch/ball and toe');
  const ys = ft.sole.map(p => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 0.6, 'planted sole is flat, spread=' + (Math.max(...ys) - Math.min(...ys)));
  assert.ok(Math.abs(ft.sole[0].y - posed.floorY) <= 1.2, 'sole sits on the floor line');
  assert.ok(Math.hypot(ft.sole[0].x - ft.heel.x, ft.sole[0].y - ft.heel.y) < 2.5, 'sole starts at the heel');
  const last = ft.sole[ft.sole.length - 1];
  assert.ok(Math.hypot(last.x - ft.toe.x, last.y - ft.toe.y) < 2.5, 'sole ends at the toe');

  const pivoted = {
    ...posed,
    contactR: 'toe',
    heelR: {...posed.heelR, y: posed.floorY - 18},
    footR: {...posed.footR, y: posed.floorY},
    toeR: posed.toeR ? {...posed.toeR, y: posed.floorY} : {...posed.footR, y: posed.floorY}
  };
  const pv = footShape(pivoted, 1);
  assert.equal(pv.planted, false);
  assert.ok(Math.abs(pv.sole[0].y - pv.heel.y) <= 0.6, 'pivoted sole follows the heel');
  assert.ok(Math.abs(pv.sole[pv.sole.length - 1].y - pv.toe.y) <= 0.6, 'pivoted sole follows the toe');
  assert.ok(pv.sole[0].y < pv.sole[pv.sole.length - 1].y - 8, 'heel-up sole slopes down to the planted toe');
});
