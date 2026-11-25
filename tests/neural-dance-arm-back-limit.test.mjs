// Rear arm limit (TJ Nov 11 5:46 PM): "they sometimes reach a little bit far
// behind the body when they go backwards. Make it stop just behind their
// head. Elbows can't go past the head backwards." Every arm move (raise,
// swing, pad / melody, rotation, rave phrases, forward reach), every phase and
// yaw: elbow and wrist never pass the back of the skull + a small margin.
// Bone lengths exact; soft knee (no snap). Plus readable feet (same review).
import test from 'node:test';
import assert from 'node:assert/strict';
import {skeletonPose, ARM_LIFT_FAMILIES} from '../neural-dance/src/skeleton-dancer.js';
import {limitArmsBehindHead, armBackLimit, girdleForward, ARM_BACK_MARGIN_HEAD, HEAD_DEPTH_K} from '../neural-dance/src/arm-forward.js';
import {footReadShape, paintFootRead, FOOT_READ_SOLE} from '../neural-dance/src/body-shell.js';

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (+a.z || 0) - (+b.z || 0));
const ARM = ['sh', 'el', 'wrist', 'hand'];
const behind = (j, headR) => {
  const f = girdleForward(j.shL, j.shR);
  const lim = armBackLimit(j.head, headR, f);
  const out = {};
  for (const k of ['elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) out[k] = j[k].x * f.x + (+j[k].z || 0) * f.z - lim;
  return out;
};
const yawAll = (j, yaw, ox = 0, oz = 0) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const o = {};
  for (const [k, p] of Object.entries(j)) {
    const x = p.x - ox, z = (+p.z || 0) - oz;
    o[k] = {x: ox + x * c + z * s, y: p.y, z: oz - x * s + z * c};
  }
  return o;
};
// A body-local arm rig (y down, +z forward, L at -x) aimed by angles.
function rig({upPitch, upYaw, forePitch, foreYaw, headZ = 0}) {
  const headR = 0.066, UP = 0.19, FORE = 0.16, HAND = 0.07;
  const j = {head: {x: 0, y: -0.12, z: headZ}, shL: {x: -0.11, y: 0, z: 0}, shR: {x: 0.11, y: 0, z: 0}};
  const dir = (pitch, yaw) => ({x: Math.sin(pitch) * Math.sin(yaw), y: Math.cos(pitch), z: Math.sin(pitch) * Math.cos(yaw)});
  for (const [s, m] of [['L', -1], ['R', 1]]) {
    const du = dir(upPitch, upYaw * m), df = dir(forePitch, foreYaw * m);
    const sh = j['sh' + s];
    const el = {x: sh.x + du.x * UP, y: sh.y + du.y * UP, z: sh.z + du.z * UP};
    const wr = {x: el.x + df.x * FORE, y: el.y + df.y * FORE, z: el.z + df.z * FORE};
    const hd = {x: wr.x + df.x * HAND, y: wr.y + df.y * HAND, z: wr.z + df.z * HAND};
    j['el' + s] = el; j['wrist' + s] = wr; j['hand' + s] = hd;
  }
  return {j, headR};
}

test('limit sits just behind the skull: head depth - (front-back radius + margin)', () => {
  const lim = armBackLimit({x: 0, y: 0, z: 0.2}, 0.066, {x: 0, z: 1});
  assert.ok(Math.abs(lim - (0.2 - 0.066 * (HEAD_DEPTH_K + ARM_BACK_MARGIN_HEAD))) < 1e-12);
  assert.ok(ARM_BACK_MARGIN_HEAD > 0 && ARM_BACK_MARGIN_HEAD <= 0.3, 'small margin');
});

test('sweep: every arm angle and yaw keeps elbow / wrist / hand in front of the limit, bones exact', () => {
  let clamped = 0, n = 0;
  for (let up = 0; up <= Math.PI; up += Math.PI / 10)
    for (let uy = -Math.PI; uy <= Math.PI; uy += Math.PI / 8)
      for (const fp of [0.2, 1.2, 2.4])
        for (const fy of [-2.6, 0, 2.6])
          for (let yaw = 0; yaw < 2 * Math.PI; yaw += Math.PI / 6) {
            const {j: j0, headR} = rig({upPitch: up, upYaw: uy, forePitch: fp, foreYaw: fy});
            const j = yawAll(j0, yaw, 0.3, -0.2);
            const L0 = {};
            for (const s of ['L', 'R']) for (let i = 1; i < 4; i++) L0[s + i] = d3(j[ARM[i - 1] + s], j[ARM[i] + s]);
            limitArmsBehindHead(j, headR);
            clamped += j.armBackMoved > 0 ? 1 : 0; n++;
            const b = behind(j, headR);
            for (const [k, v] of Object.entries(b)) assert.ok(v >= -1e-9, `${k} ${v.toFixed(4)} behind the limit (up ${up.toFixed(2)} uy ${uy.toFixed(2)} yaw ${yaw.toFixed(2)})`);
            for (const s of ['L', 'R']) for (let i = 1; i < 4; i++) {
              const got = d3(j[ARM[i - 1] + s], j[ARM[i] + s]);
              assert.ok(Math.abs(got - L0[s + i]) < 1e-9, `bone ${ARM[i - 1]}${s}-${ARM[i]}${s} length kept`);
            }
          }
  assert.ok(clamped > n * 0.2, 'the sweep actually reaches behind the head (' + clamped + '/' + n + ')');
});

test('arms in front of the limit are untouched; a backward swing eases in (no snap)', () => {
  const {j, headR} = rig({upPitch: 0.4, upYaw: 0, forePitch: 0.6, foreYaw: 0});
  const copy = JSON.parse(JSON.stringify(j));
  limitArmsBehindHead(j, headR);
  for (const k of ['elL', 'elR', 'wristL', 'wristR', 'handL', 'handR']) assert.ok(d3(j[k], copy[k]) < 1e-12, k + ' unchanged');
  // A low backward swing (down -> back, as in a walk or a rave pump) and an
  // overhead reach that falls back behind the head (the sim case TJ saw).
  let worstStep = 0;
  for (const [from, to, yaw] of [[0.9, -1.45, 0], [Math.PI * 0.95, Math.PI * 0.55, Math.PI]]) {
    let prev = null;
    const step = from > to ? -0.01 : 0.01;
    for (let a = from; step < 0 ? a >= to : a <= to; a += step) {
      const pitch = Math.abs(a), yw = a >= 0 ? yaw : Math.PI - yaw;
      const {j: q, headR: hr} = rig({upPitch: pitch, upYaw: yw, forePitch: pitch, foreYaw: yw});
      limitArmsBehindHead(q, hr);
      if (prev) worstStep = Math.max(worstStep, d3(q.elR, prev.elR), d3(q.wristR, prev.wristR));
      prev = q;
    }
  }
  // Input elbow moves ~0.19 * 0.01 per step; the wrist ~0.35 * 0.01 * 2.
  assert.ok(worstStep < 0.012, 'continuous motion, no jump: worst step ' + worstStep.toFixed(4));
});

test('live dancers: all arm families, phases, forward reach, pad arms and body turns stay in front of the head-back limit', () => {
  const pad = {env: 0.85, melody: 0.8, pad: 0.85, lead: 0.7, high: 0.5, mid: 0.6, flux: 0.6};
  let n = 0;
  for (const fam of ARM_LIFT_FAMILIES) for (const id of [0, 3, 7, 11]) for (const band of [0, 1, 2]) for (let t = 0; t < 16; t += 0.41) {
    for (const dynamics of [false, true]) {
      const p = skeletonPose({id, band, armFamily: fam, armLift: 0.5 + 0.5 * Math.sin(t * 1.3), lift: 0.04, activation: 0.9,
        now: t * 1000, periodMs: 500, stepHz: 2, phrase: Math.floor(t / 2), beat: t * 2, maxBodyTurn: 90, turnFreq: 0.35,
        shoulderTwist: 0.6, armForward: (t % 5) / 5, padFeatures: pad, strikes: [t - 0.2, t - 0.7], weight: Math.sin(t * 2),
        side: t % 1 < 0.5 ? -1 : 1, dynamics});
      const b = behind(p, p.b.headR);
      for (const k of ['elL', 'elR', 'wristL', 'wristR']) {
        assert.ok(b[k] >= -1e-9, `${fam} id ${id} band ${band} t ${t.toFixed(2)} ${k} ${b[k].toFixed(4)} behind the head`);
        n++;
      }
      for (const s of ['L', 'R']) for (const k of ['sh', 'el', 'wrist', 'hand']) assert.ok(Number.isFinite(p[k + s].x) && Number.isFinite(p[k + s].y));
    }
  }
  assert.ok(n > 5000);
});

test('live bone lengths unchanged by the limit', () => {
  const a = skeletonPose({id: 4, band: 1, armLift: 0.8, armFamily: 'both-up'});
  const b = skeletonPose({id: 4, band: 1, armLift: 0.8, armFamily: 'both-up', armForward: 1});
  for (const p of [a, b]) for (const s of ['L', 'R']) {
    assert.ok(Math.abs(d3(p['sh' + s], p['el' + s]) - d3(a['sh' + s], a['el' + s])) < 1e-6);
    assert.ok(Math.abs(d3(p['el' + s], p['wrist' + s]) - d3(a['el' + s], a['wrist' + s])) < 1e-6);
  }
});

// ---- feet ----
function footPose(yaw, {planted = true} = {}) {
  const h = 400, floor = 380;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (lx, lz, y) => ({x: 200 + lx * c + lz * s, y, z: -lx * s + lz * c});
  const fl = 0.08 * h;
  const pose = {height: h, floorY: floor, b: {legW: {ank: 0.016, foot: 0.015}}, contactL: planted ? 'flat' : 'air', contactR: 'flat'};
  for (const [k, lx] of [['L', -0.05 * h], ['R', 0.05 * h]]) {
    const lift = k === 'L' && !planted ? 30 : 0;
    pose['heel' + k] = at(lx, -fl * 0.45, floor - lift);
    pose['toe' + k] = at(lx, fl * 0.55, floor - lift - (planted ? 0 : 8));
    pose['ankle' + k] = at(lx, 0, floor - 0.018 * h - lift);
  }
  return pose;
}
const extentX = (pts) => Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
const extentY = (pts) => Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));

test('feet read as feet: elongated in profile, a shorter wedge facing front, sole flat on the floor', () => {
  const prof = footReadShape(footPose(Math.PI / 2), 1), front = footReadShape(footPose(0), 1);
  const h = 400;
  assert.ok(extentX(prof.outline) > 0.09 * h, 'profile foot is long: ' + extentX(prof.outline).toFixed(1));
  assert.ok(extentX(front.outline) < extentX(prof.outline) * 0.75, 'front view is a shorter wedge');
  assert.ok(extentX(front.outline) > 0.03 * h, 'front wedge still has width');
  for (const sh of [prof, front]) {
    assert.ok(extentY(sh.outline) > 0.015 * h, 'foot has visible height (not a sliver / ball)');
    const [a, b] = sh.soleLine;
    assert.equal(a.y, 380); assert.equal(b.y, 380);
    assert.ok(Math.max(...sh.outline.map(p => p.y)) <= 380 + 1e-9, 'nothing below the floor');
  }
  // Heel behind, toe ahead along the walking direction (profile faces +x).
  assert.ok(prof.toeTip.x > prof.heelBack.x + 0.09 * h);
  const back = footReadShape(footPose(-Math.PI / 2), 1);
  assert.ok(back.toeTip.x < back.heelBack.x - 0.09 * h, 'turned the other way, toe points the other way');
});

test('a lifted foot follows heel-toe rock; painter draws both feet with a lit sole', () => {
  const air = footReadShape(footPose(Math.PI / 2, {planted: false}), -1);
  assert.ok(air.soleLine[0].y < 380 - 10 && air.soleLine[1].y < 380 - 10, 'lifted foot off the floor');
  const ops = [];
  const g = new Proxy({}, {get: (o, k) => (k in o ? o[k] : (...a) => ops.push({op: k, a, strokeStyle: o.strokeStyle})), set: (o, k, v) => { o[k] = v; return true; }});
  assert.equal(paintFootRead(g, footPose(Math.PI / 2)), 2);
  assert.equal(ops.filter(o => o.op === 'stroke' && o.strokeStyle === FOOT_READ_SOLE).length, 1, 'one sole stroke');
  assert.equal(ops.filter(o => o.op === 'moveTo').length, 4, 'two foot outlines + two soles');
});
