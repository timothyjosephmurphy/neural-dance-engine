import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dancerSilhouette,
  deformSilhouette,
  variationFor,
  plantedSide,
  legBowPoints,
  sampleLegBow,
  footStrikeTravel,
  footLandmarks,
  easeInPower,
  easeInExpo,
  shiftWeight
} from '../neural-dance/src/silhouette-dance.js';
import {chakraPoints} from '../neural-dance/src/vibrating-string.js';
import {paintLegBow, paintLegEnergy, createSilhouetteShow, SILHOUETTE_SHADOW} from '../neural-dance/src/silhouette.js';

test('weight shifts onto one planted foot instead of scissoring both legs open', () => {
  const body = dancerSilhouette();
  const variation = {lead: 1, stepScale: 1, swayScale: 1, phase: 0};
  assert.equal(plantedSide(0, variation), 1);
  assert.equal(plantedSide(1, variation), -1);
  const rightPlanted = deformSilhouette(body, {envelope: 1, variation, beatIndex: 0});
  const leftPlanted = deformSilhouette(body, {envelope: 1, variation, beatIndex: 1});
  const box = (() => {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const p of body) {
      top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
      left = Math.min(left, p.x); right = Math.max(right, p.x);
    }
    return {top, bottom, left, right, width: right - left, height: bottom - top};
  })();
  // Torso / hips should lean toward the planted side.
  const torso = body
    .map((p, i) => ({i, ...p}))
    .filter(p => p.y > box.top + box.height * 0.25 && p.y < box.top + box.height * 0.45);
  const leanRight = torso.reduce((s, p) => s + (rightPlanted[p.i].x - p.x), 0) / torso.length;
  const leanLeft = torso.reduce((s, p) => s + (leftPlanted[p.i].x - p.x), 0) / torso.length;
  assert.ok(leanRight > 0.2, `hips lean right when right planted (${leanRight})`);
  assert.ok(leanLeft < -0.2, `hips lean left when left planted (${leanLeft})`);
  // Free foot lifts more than planted foot.
  const feet = body.map((p, i) => ({i, ...p})).sort((a, b) => b.y - a.y).slice(0, 8);
  const leftIdx = feet.filter(p => p.x < 0).sort((a, b) => a.x - b.x)[0].i;
  const rightIdx = feet.filter(p => p.x > 0).sort((a, b) => b.x - a.x)[0].i;
  const freeLift = body[leftIdx].y - rightPlanted[leftIdx].y;   // left free when right planted
  const plantLift = body[rightIdx].y - rightPlanted[rightIdx].y;
  assert.ok(freeLift > plantLift + 0.3, `free foot lifts more (${freeLift} vs ${plantLift})`);
});

test('leg bow arcs foot to foot and leans toward the planted foot', () => {
  const body = dancerSilhouette();
  const right = legBowPoints(body, {envelope: 1, planted: 1});
  const left = legBowPoints(body, {envelope: 1, planted: -1});
  assert.ok(right && left);
  assert.ok(right.apex.x > right.groin.x, 'apex leans right');
  assert.ok(left.apex.x < left.groin.x, 'apex leans left');
  const samples = sampleLegBow(right, 12);
  assert.ok(samples.length >= 8);
  assert.equal(samples[0].x, right.left.x);
  assert.equal(samples[samples.length - 1].x, right.right.x);
});

test('foot-strike travel climbs the leg then the chakra string', () => {
  const leg = footStrikeTravel(0.1);
  assert.equal(leg.phase, 'leg');
  assert.ok(leg.u > 0 && leg.u < 1);
  const mid = footStrikeTravel(0.5);
  assert.equal(mid.phase, 'string');
  assert.ok(mid.stringS > 0 && mid.stringS < 1);
  const top = footStrikeTravel(1);
  assert.equal(top.phase, 'string');
  assert.equal(top.stringS, 1);
});

test('chakra nodes brighten as the strike pulse passes', () => {
  const pts = [
    {x: 0, y: 40, s: 0},
    {x: 0, y: 0, s: 0.5},
    {x: 0, y: -40, s: 1}
  ];
  const base = chakraPoints(pts, {envelope: 0.2, level: 0});
  const boosted = chakraPoints(pts, {envelope: 0.2, level: 0, travelS: 0, travelGain: 2});
  const rootBase = base.find(l => l.id === 'root');
  const rootBoost = boosted.find(l => l.id === 'root');
  assert.ok(rootBoost.radius > rootBase.radius);
  assert.ok(rootBoost.alpha >= rootBase.alpha);
});

test('paint helpers draw the bow and leg energy without throwing', () => {
  const calls = [];
  const ctx = {
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    stroke() { calls.push('stroke'); },
    fill() { calls.push('fill'); },
    arc() {},
    createRadialGradient() { return {addColorStop() {}}; },
    strokeStyle: '', fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: '', lineJoin: ''
  };
  const bow = legBowPoints(dancerSilhouette(), {envelope: 1, planted: 1});
  assert.equal(paintLegBow(ctx, bow), true);
  assert.ok(calls.includes('stroke'));
  assert.equal(paintLegEnergy(ctx, {x: -8, y: 40}, {x: 0, y: 8}, 0.5), true);
});

// TJ Nov 10 1:51 PM: the body is now a semi-transparent 3D volume, not the
// dark shadow fill (SILHOUETTE_SHADOW stays for floor-shadow masks).
test('live show paints the see-through volume body, not the dark shadow fill', () => {
  assert.match(SILHOUETTE_SHADOW, /rgba\(6,\s*8,\s*14/);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  show.beat(1000, 1);
  // Advance enough audio beats for a body beat under 4× slowdown.
  for (let i = 0; i < 5; i++) show.beat(1000 + i * 400, 1);
  let fills = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, clip() {},
    quadraticCurveTo() {}, arc() {},
    createRadialGradient() { return {addColorStop() {}}; },
    set fillStyle(v) { fills.push(String(v)); },
    get fillStyle() { return fills[fills.length - 1] || ''; },
    strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineJoin: '', lineCap: ''
  };
  show.paint(ctx, [{id: 3, x: 0, y: 0, kind: 'sim', type: 1, color: null, contour: dancerSilhouette()}], {
    now: 3000,
    xy: (x, y) => ({x, y})
  });
  assert.ok(fills.some(f => /rgba\(150,\s*172,\s*220,\s*0\.16/.test(f)), 'see-through volume fill used');
  assert.ok(!fills.some(f => /rgba\(6,\s*8,\s*14/.test(f)), 'no dark shadow body');
});

test('weight eases in slowly then snaps onto the beat, and the bow size is steady', () => {
  assert.equal(easeInPower(0, 4), 0);
  assert.equal(easeInPower(1, 4), 1);
  assert.ok(easeInPower(0.5, 4) < 0.2, 'halfway is still early (slow then fast)');
  assert.ok(easeInExpo(0.5) < easeInPower(0.5, 3));
  const mid = shiftWeight(-1, 1, 0.5, {hold: 0.12, power: 4});
  const late = shiftWeight(-1, 1, 0.95, {hold: 0.12, power: 4});
  const end = shiftWeight(-1, 1, 1, {hold: 0.12, power: 4});
  assert.ok(mid < 0, 'still closer to the start at mid-interval');
  assert.ok(late > mid && late < 1);
  assert.equal(end, 1);
  const hold = shiftWeight(-1, 1, 0.1, {hold: 0.12, power: 4});
  assert.equal(hold, -1);

  const body = dancerSilhouette();
  const a = legBowPoints(body, {envelope: 0, planted: 1});
  const b = legBowPoints(body, {envelope: 1, planted: 1});
  const size = (bow) => Math.hypot(bow.left.x - bow.right.x, bow.left.y - bow.right.y);
  assert.ok(Math.abs(size(a) - size(b)) < 1e-6, 'bow span does not pop with envelope');
  const midW = legBowPoints(body, {planted: 0});
  assert.ok(Math.abs(midW.apex.x - midW.groin.x) < Math.abs(a.apex.x - a.groin.x), 'apex tracks continuous weight');
});
