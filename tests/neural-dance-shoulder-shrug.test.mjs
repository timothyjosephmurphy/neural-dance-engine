// TJ Nov 11 2:10 PM (live 2ed1636): live sticker dancers looked headless, the
// shoulder skin rising above where the head should be. The trapezius control
// point was (nape.y + shoulder.y) * 0.45 = 0.9 x the absolute screen y, so the
// shrug grew with the dancer's height on the canvas (bottom insets, dancers low
// on the projector). The outline must be translation invariant and the head
// must stay above the shoulders wherever the dancer stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {addTorsoPath} from '../neural-dance/src/body-shell.js';
import {paintShadowFigure, skeletonPose, placePose} from '../neural-dance/src/skeleton-dancer.js';

function pathRecorder() {
  const pts = [];
  const push = (...a) => { for (let i = 0; i + 1 < a.length; i += 2) pts.push({x: a[i], y: a[i + 1]}); };
  return {pts, moveTo: push, lineTo: push, quadraticCurveTo: push, bezierCurveTo: push, closePath() {}};
}
function livePose(top, band = 2) {
  const unit = skeletonPose({id: 28, band, weight: 0, ease: 0.3, side: -1, now: 1200, activation: 0.5, hush: 1});
  return placePose(unit, 400, top, 180);
}
const headR = p => (+p.headR > 1 ? +p.headR : p.b.headR * p.height);

test('torso outline (shoulder skin) is translation invariant on the canvas', () => {
  const a = pathRecorder(), b = pathRecorder();
  const hi = livePose(20), lo = livePose(1400);
  addTorsoPath(a, hi); addTorsoPath(b, lo);
  assert.equal(a.pts.length, b.pts.length);
  const dy = lo.head.y - hi.head.y;
  for (let i = 0; i < a.pts.length; i++) {
    assert.ok(Math.abs(b.pts[i].x - a.pts[i].x) < 1e-6, 'x ' + i);
    assert.ok(Math.abs(b.pts[i].y - a.pts[i].y - dy) < 1e-6, 'y ' + i + ' off by ' + (b.pts[i].y - a.pts[i].y - dy).toFixed(2));
  }
});

test('live dancer head is drawn above the shoulders anywhere on the canvas', () => {
  for (const band of [0, 1, 2, 3]) for (const top of [0, 300, 900, 2000]) {
    const pose = livePose(top, band);
    const rec = pathRecorder();
    addTorsoPath(rec, pose);
    const shY = (pose.shL.y + pose.shR.y) / 2;
    const r = headR(pose);
    // Head sits on the neck, above the shoulder line.
    assert.ok(pose.head.y + r * 0.9 < shY, `band ${band} top ${top}: chin above the shoulder line`);
    // No outline vertex or control point rises above the chin: the skin can
    // never cover the skull (old bug: ~0.1 x screen y above the shoulders).
    const minY = Math.min(...rec.pts.map(p => p.y));
    assert.ok(minY >= pose.head.y + r * 0.5, `band ${band} top ${top}: shoulder skin at ${minY.toFixed(1)} rises over the head (${pose.head.y.toFixed(1)})`);
  }
});

test('full-LOD live painter draws the head ellipse above the torso outline', () => {
  const pose = livePose(1400);
  const heads = [], torso = [];
  let inPath = [];
  const ctx = new Proxy({canvas: {width: 2000, height: 2000},
    createLinearGradient() { return {addColorStop() {}}; }, createRadialGradient() { return {addColorStop() {}}; },
    ellipse(x, y, rx, ry) { heads.push({x, y, rx, ry}); },
    moveTo(x, y) { inPath.push({x, y}); }, lineTo(x, y) { inPath.push({x, y}); },
    quadraticCurveTo(cx, cy, x, y) { inPath.push({x: cx, y: cy}, {x, y}); },
    beginPath() { if (inPath.length) torso.push(inPath); inPath = []; }},
    {get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; }});
  assert.ok(paintShadowFigure(ctx, pose, (x, y) => ({x, y}), {scale: 1, lod: 'full', volume: true, skeleton: false}) !== false);
  const head = heads.find(h => Math.abs(h.x - pose.head.x) < 1 && Math.abs(h.y - pose.head.y) < 1);
  assert.ok(head, 'head ellipse painted at the posed head');
  const shY = (pose.shL.y + pose.shR.y) / 2;
  assert.ok(head.y + head.ry < shY, 'head bottom above the shoulder line');
  const sh = torso.flat().filter(p => Math.abs(p.x - pose.head.x) > head.rx * 1.2); // outline away from the neck column
  if (sh.length) assert.ok(Math.min(...sh.map(p => p.y)) > head.y, 'shoulder skin stays below the head centre');
});
