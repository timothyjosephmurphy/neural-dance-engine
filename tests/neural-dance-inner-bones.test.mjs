import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  BONE_WHITE, DEFAULT_ON, bonePolylines, pulseGlowAt, paintInnerBones, boneFollowsJoints,
} from '../neural-dance/src/inner-bones.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'static/neural-dance/sim/index.html'), 'utf8');

function samplePose() {
  const h = 200;
  const mid = (y) => ({ x: 0, y, z: 0 });
  const pose = {
    height: h,
    b: { chestW: 0.108, headR: 0.064, headRx: 0.055 },
    head: mid(20), neck: mid(36), crown: mid(10),
    throat: mid(32), heart: mid(55), solar: mid(78), sacral: mid(110),
    groin: mid(120),
    hipL: { x: -18, y: 118, z: 0 }, hipR: { x: 18, y: 118, z: 0 },
    kneeL: { x: -16, y: 155, z: 0 }, kneeR: { x: 16, y: 155, z: 0 },
    ankleL: { x: -15, y: 188, z: 0 }, ankleR: { x: 15, y: 188, z: 0 },
    heelL: { x: -17, y: 194, z: 0 }, heelR: { x: 17, y: 194, z: 0 },
    toeL: { x: -8, y: 194, z: 0 }, toeR: { x: 8, y: 194, z: 0 },
    footL: { x: -14, y: 194, z: 0 }, footR: { x: 14, y: 194, z: 0 },
    shL: { x: -28, y: 48, z: 0 }, shR: { x: 28, y: 48, z: 0 },
    elL: { x: -34, y: 78, z: 0 }, elR: { x: 34, y: 78, z: 0 },
    wristL: { x: -36, y: 104, z: 0 }, wristR: { x: 36, y: 104, z: 0 },
    handL: { x: -38, y: 116, z: 0 }, handR: { x: 38, y: 116, z: 0 },
    headR: 12.8, headRx: 11,
    spine: {
      pelvis: mid(118), lumbar: mid(95), thoracic: mid(62),
    },
  };
  return pose;
}

test('inner bones default on, and the side sim has a toggle', () => {
  assert.equal(DEFAULT_ON, true);
  assert.match(html, /id="innerBones"[^>]*checked/);
  assert.match(html, /> Inner bones</);
  assert.match(html, /innerBones:\s*true/);
  assert.match(html, /bindCheck\('innerBones',\s*'innerBones'\)/);
  assert.match(html, /inner-bones\.js/);
  assert.match(html, /paintInnerBones/);
});

test('faint stick skeleton is skipped while inner bones are on', () => {
  assert.match(html, /if \(params\.innerBones\)/);
  assert.match(html, /else if \(params\.skeleton\)/);
  const paintIdx = html.indexOf('if (params.innerBones)');
  const faint = html.indexOf('paintFaintSkeleton(ctx, pose)', paintIdx);
  assert.ok(faint > paintIdx, 'faint paint comes after the inner-bones branch');
  const elseIf = html.lastIndexOf('else if (params.skeleton)', faint);
  assert.ok(elseIf > paintIdx && elseIf < faint, 'faint skeleton only in the else-if');
});

test('bones follow the posed joints: limbs, pelvis, clavicle, spine', () => {
  const pose = samplePose();
  const bones = bonePolylines(pose);
  const kinds = new Set(bones.map(b => b.kind));
  for (const k of [
    'vertebra', 'rib', 'pelvisCrossbar', 'pelvisBowl', 'sacrum', 'clavicle',
    'sternum', 'humerus', 'radius', 'ulna', 'femur', 'tibia', 'fibula',
    'kneecap', 'hand', 'finger', 'foot', 'jaw', 'shoulderGirdle',
  ]) {
    assert.ok(kinds.has(k), 'missing kind ' + k);
  }
  assert.equal(kinds.has('spine'), false, 'no continuous spine rod');
  const verts = bones.filter(b => b.kind === 'vertebra');
  assert.equal(verts.length, 14);
  assert.equal(verts.filter(v => v.region === 'cervical').length, 5);
  assert.equal(verts.filter(v => v.region === 'thoracic').length, 5);
  assert.equal(verts.filter(v => v.region === 'lumbar').length, 4);
  assert.equal(bones.filter(b => b.kind === 'rib').length, 12); // 6 pairs
  assert.ok(boneFollowsJoints(bones, 'humerus', pose.shL, pose.elL, 0.5));
  assert.ok(boneFollowsJoints(bones, 'humerus', pose.shR, pose.elR, 0.5));
  assert.ok(boneFollowsJoints(bones, 'femur', pose.hipL, pose.kneeL, 0.5));
  assert.ok(boneFollowsJoints(bones, 'femur', pose.hipR, pose.kneeR, 0.5));
  assert.ok(boneFollowsJoints(bones, 'pelvisCrossbar', pose.hipL, pose.hipR, 0.5));
  assert.ok(boneFollowsJoints(bones, 'shoulderGirdle', pose.shL, pose.shR, 0.5));
  // Vertebrae lie on the pelvis→crown curve as separate stacked bodies
  for (const v of verts) {
    for (const p of v.pts) {
      assert.ok(p.y >= pose.crown.y - 1 && p.y <= pose.spine.pelvis.y + 2, 'vertebra off spine curve');
      assert.ok(Math.abs(p.x) < 4, 'vertebra not along the midline spine');
    }
  }
  const neckW = Math.max(...verts.filter(v => v.region === 'cervical').map(v => v.bodyW));
  const lumW = Math.min(...verts.filter(v => v.region === 'lumbar').map(v => v.bodyW));
  assert.ok(lumW > neckW * 1.4, 'lumbar vertebrae are larger than neck vertebrae');
  // Gaps: neighboring bodies along the curve do not overlap
  const sorted = verts.slice().sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const d = Math.hypot(b.pts[0].x - a.pts[0].x, b.pts[0].y - a.pts[0].y);
    const minGap = (a.bodyL + b.bodyL) * 0.55;
    assert.ok(d > minGap, 'vertebrae must have a visible gap, got ' + d + ' vs ' + minGap);
  }
});

test('ribcage sits on the chest, with an abdominal gap above the pelvis', () => {
  const pose = samplePose();
  const bones = bonePolylines(pose);
  const ribs = bones.filter(b => b.kind === 'rib' || b.kind === 'sternum');
  const chestBottom = pose.heart.y + (pose.solar.y - pose.heart.y) * 0.45;
  let maxY = -Infinity, minY = Infinity;
  for (const r of ribs) {
    for (const p of r.pts) {
      if (p.y > maxY) maxY = p.y;
      if (p.y < minY) minY = p.y;
      assert.ok(p.y < pose.solar.y - 2, 'rib dipped into the belly at y=' + p.y);
      assert.ok(p.y < pose.groin.y - 20, 'rib reached the pelvis');
    }
  }
  assert.ok(maxY < chestBottom + 6, 'lowest rib should stay near the bottom of the chest, got ' + maxY + ' vs ' + chestBottom);
  assert.ok(minY < pose.shL.y + 8, 'top ribs should start up at the clavicles / sternum');
  // Bottom ribs are shorter than the top pair
  const pairW = (i) => {
    const ribsI = bones.filter(b => b.kind === 'rib').slice(i * 2, i * 2 + 2);
    const xs = ribsI.flatMap(b => b.pts.map(p => p.x));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(pairW(5) < pairW(0) * 0.85, 'bottom ribs get shorter (still tapered, now filling the chest)');
  const gap = pose.spine.pelvis.y - maxY;
  assert.ok(gap > 40, 'clear abdominal gap above the pelvis, gap=' + gap);
});

test('limb bones have anatomical shafts, knobs, twins, kneecaps and hip bowls', () => {
  const pose = samplePose();
  const bones = bonePolylines(pose);
  for (const kind of ['humerus', 'femur']) {
    const b = bones.find(x => x.kind === kind);
    assert.equal(b.shape, 'shaft');
    assert.ok(b.headR > b.midW * 0.9, kind + ' has a knobbed head');
    assert.ok(b.tailR > 0, kind + ' has a knobbed distal end');
    assert.ok(b.midW < b.endW, kind + ' shaft tapers (ends wider than mid)');
  }
  assert.equal(bones.filter(b => b.kind === 'radius').length, 2);
  assert.equal(bones.filter(b => b.kind === 'ulna').length, 2);
  assert.equal(bones.filter(b => b.kind === 'tibia').length, 2);
  assert.equal(bones.filter(b => b.kind === 'fibula').length, 2);
  // Twins are clearly separated, not a single stick
  const gap = (a, b) => {
    const mid = (p, q) => ({ x: (p.x + q.x) * 0.5, y: (p.y + q.y) * 0.5 });
    const A = mid(a.pts[0], a.pts[a.pts.length - 1]);
    const B = mid(b.pts[0], b.pts[b.pts.length - 1]);
    return Math.hypot(A.x - B.x, A.y - B.y);
  };
  const radii = bones.filter(b => b.kind === 'radius');
  const ulnae = bones.filter(b => b.kind === 'ulna');
  assert.ok(gap(radii[0], ulnae[0]) > 3, 'radius and ulna are a visible twin');
  const tibs = bones.filter(b => b.kind === 'tibia');
  const fibs = bones.filter(b => b.kind === 'fibula');
  assert.ok(gap(tibs[0], fibs[0]) > 3, 'tibia and fibula are a visible twin');
  const caps = bones.filter(b => b.kind === 'kneecap');
  assert.equal(caps.length, 2);
  for (const c of caps) {
    const kn = Math.min(
      Math.hypot(c.pts[0].x - pose.kneeL.x, c.pts[0].y - pose.kneeL.y),
      Math.hypot(c.pts[0].x - pose.kneeR.x, c.pts[0].y - pose.kneeR.y),
    );
    assert.ok(kn < 6, 'kneecap sits on the knee joint');
  }
  const bowls = bones.filter(b => b.kind === 'pelvisBowl');
  assert.equal(bowls.length, 2);
  assert.ok(bowls.every(b => b.shape === 'bowl' && b.pts.length >= 5), 'pelvis reads as hip bowls');
  const femurs = bones.filter(b => b.kind === 'femur');
  assert.ok(femurs.every(b => b.condyles), 'femur has condyles at the knee');
});

test('paintInnerBones does not throw and uses a soft bone-white base', () => {
  assert.deepEqual(BONE_WHITE, { r: 232, g: 226, b: 210 });
  const calls = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, bezierCurveTo() { calls.push(['bez']); },
    ellipse() { calls.push(['ell']); }, arc() {}, fill() { calls.push(['fill']); }, stroke() {},
    closePath() {}, translate() {}, rotate() {},
    set lineWidth(v) { calls.push(['w', v]); },
    set strokeStyle(v) { calls.push(['s', v]); },
    set fillStyle(v) { calls.push(['f', v]); },
    set lineCap(v) {},
    set lineJoin(v) {},
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    set globalAlpha(v) {},
  };
  const n = paintInnerBones(ctx, samplePose(), { pulses: [], lights: [] });
  assert.ok(n > 20, 'paints a full skeleton, got ' + n);
  const strokes = calls.filter(c => c[0] === 's').map(c => c[1]);
  assert.ok(strokes.some(s => /rgba\(232,\s*226,\s*210/.test(s)), 'bone-white base stroke');
  assert.ok(calls.some(c => c[0] === 'bez'), 'skull is a shaped path, not just a circle');
  const fills = calls.filter(c => c[0] === 'f').map(c => c[1]);
  assert.ok(fills.some(s => /rgba\(16,\s*14,\s*18/.test(s)), 'eye sockets are dark openings');
});

test('pulses light nearby bones with the pulse hue', () => {
  const pose = samplePose();
  const cold = pulseGlowAt(pose.heart.x, pose.heart.y, [], [], pose.height);
  const hot = pulseGlowAt(pose.heart.x, pose.heart.y, [
    { x: pose.heart.x, y: pose.heart.y, strength: 1, hue: 200 },
  ], [], pose.height);
  assert.ok(hot.glow > cold.glow + 0.3, 'a passing pulse raises glow');
  assert.equal(hot.hue, 200);
  const far = pulseGlowAt(pose.toeL.x, pose.toeL.y, [
    { x: pose.heart.x, y: pose.heart.y, strength: 1, hue: 200 },
  ], [], pose.height);
  assert.ok(far.glow < hot.glow * 0.35, 'glow falls off away from the pulse');
});

test('jacking / body wave / nod are sagittal, not added to lateral phi', () => {
  // The #97 preview's hard lean came from jackPhi + wavePhi + nod being
  // added into the lateral spine phi. They now go into along(..., sag).
  assert.match(html, /cannot stack into a hard side lean/);
  assert.match(html, /const sagP = sagOf\('pelvis'\)/);
  assert.match(html, /along\(pelvis, phiP, hipY - yLumbar, sagP\)/);
  assert.match(html, /along\(lumbar, phiL, yLumbar - yThoracic, sagL\)/);
  // The old stacking pattern must be gone.
  assert.doesNotMatch(html, /addPhi\(sp\.phi\.pelvis/);
  assert.doesNotMatch(html, /addPhi\(sp\.phi\.lumbar/);
  assert.match(html, /const lean = clamp\(com\.leanTilt \|\| 0, -deg\(6\), deg\(6\)\)/);
  assert.match(html, /spineSagDeg/);
});

test('raised arms are clamped and the camera leaves more headroom', () => {
  assert.match(html, /const yHeadBase = H \* 0\.23;/);
  assert.match(html, /const yHead = yHeadBase - \(c\.tall - 1\) \* 36;/);
  assert.match(html, /const yMin = -0\.030;/);
  const caps = html.split('const yMin = -0.030;').length - 1;
  assert.ok(caps >= 2, 'arm cap applied before and after later arm adjustments, got ' + caps);
});

test('live dancers paint the shared inner bones (sim → live parity, TJ Nov 11 7:07 PM)', () => {
  // PR #98 kept bones side-sim only; the parity PR wires the same module into
  // live behind the Inner bones quality toggle (Off / Stage / All).
  const dancer = readFileSync(join(root, 'neural-dance/src/skeleton-dancer.js'), 'utf8');
  const sil = readFileSync(join(root, 'neural-dance/src/silhouette.js'), 'utf8');
  assert.match(dancer, /from '\.\/inner-bones\.js'/);
  assert.match(dancer, /paintInnerBones\(ctx, bonePose/);
  assert.match(sil, /innerBonesMode\(show\.tuning\)/);
});

test('ribcage fills the chest: upper ribs reach under the clavicles', () => {
  const pose = samplePose();
  pose.b.shW = 0.125;
  const bones = bonePolylines(pose);
  const ribs = bones.filter(b => b.kind === 'rib');
  const top = ribs.slice(0, 2).flatMap(b => b.pts.map(p => p.x));
  const topSpan = Math.max(...top) - Math.min(...top);
  const shSpan = pose.shR.x - pose.shL.x;
  assert.ok(topSpan > shSpan * 0.78, 'upper ribs should fill the chest, span=' + topSpan.toFixed(1) + ' vs shoulders ' + shSpan.toFixed(1));
  assert.ok(topSpan < shSpan * 1.05, 'ribs stay inside the shoulder girdle');
});

test('no rib or bone point sticks out past the chest outline', () => {
  const pose = samplePose();
  pose.b.shW = 0.125;
  pose.b.waistW = 0.068;
  const h = pose.height;
  const midX = (pose.shL.x + pose.shR.x) * 0.5;
  const shY = (pose.shL.y + pose.shR.y) * 0.5;
  const shHalf = Math.abs(pose.shR.x - pose.shL.x) / 2;
  const chestHalf = (pose.b.chestW || 0.108) * h;
  const waistHalf = (pose.b.waistW || 0.068) * h;
  const chestBotY = pose.heart.y + (pose.solar.y - pose.heart.y) * 0.45;
  const pad = h * 0.012; // stroke width + a little curve slack
  function chestOutlineHalfW(y) {
    if (y <= shY) return shHalf;
    if (y <= chestBotY) {
      const t = (y - shY) / Math.max(1, chestBotY - shY);
      return shHalf + (chestHalf - shHalf) * t;
    }
    const t = (y - chestBotY) / Math.max(1, pose.solar.y - chestBotY);
    return chestHalf + (waistHalf - chestHalf) * Math.min(1, Math.max(0, t));
  }
  const bones = bonePolylines(pose);
  const chestBones = bones.filter(b => b.kind === 'rib' || b.kind === 'sternum' || b.kind === 'clavicle' || b.kind === 'costalArch');
  assert.ok(chestBones.length > 0, 'expected chest bones');
  const frontPts = [];
  for (const b of chestBones) {
    const pts = b.kind === 'rib' ? b.pts.slice(1) : b.pts; // skip vertebral ends
    for (const pt of pts) {
      const half = chestOutlineHalfW(pt.y) + pad;
      const dx = Math.abs(pt.x - midX);
      assert.ok(dx <= half, 'chest bone point sticks out past the chest outline at (' +
        pt.x.toFixed(1) + ', ' + pt.y.toFixed(1) + '), outline halfW=' + half.toFixed(1));
      assert.ok(pt.y <= chestBotY + pad, 'chest bone point sticks out below the chest at y=' + pt.y.toFixed(1));
      frontPts.push(pt);
    }
  }
  const midFront = frontPts.filter(p => Math.abs(p.x - midX) <= h * 0.025);
  const sideFront = frontPts.filter(p => Math.abs(p.x - midX) >= h * 0.05);
  assert.ok(midFront.length && sideFront.length, 'need midline and side chest points');
  const midLow = Math.max(...midFront.map(p => p.y));
  const sideLow = Math.max(...sideFront.map(p => p.y));
  assert.ok(midLow <= sideLow + h * 0.01,
    'costal margin must not end in a midline spike, mid=' + midLow.toFixed(1) + ' side=' + sideLow.toFixed(1));
});

test('foot bones are an arch, not splayed claw rays', () => {
  const pose = samplePose();
  const bones = bonePolylines(pose);
  const feet = bones.filter(b => b.kind === 'foot' || b.kind === 'calcaneus' || b.kind === 'metatarsal');
  assert.ok(feet.some(b => b.kind === 'calcaneus'), 'heel bone present');
  assert.ok(bones.filter(b => b.kind === 'metatarsal').length >= 4, 'short toe rays inside the box');
  for (const b of feet) {
    const heel = b.pts[0].x < 0 ? pose.heelL : pose.heelR;
    const toe = b.pts[0].x < 0 ? pose.toeL : pose.toeR;
    const midX = (heel.x + toe.x) / 2;
    for (const pt of b.pts) {
      assert.ok(Math.abs(pt.x - midX) < 18, 'foot bone x wandered off the sole at ' + pt.x);
      assert.ok(pt.y <= Math.max(heel.y, toe.y) + 1, 'foot bone below the floor');
    }
  }
});
