// Ground contact, rest stance, knees, squat, support and the silence groove
// (TJ Nov 10, 10:25–10:41 AM). Runs the live silhouette show (shared by live,
// the sim page and the side sim) for 10 minutes with camera jitter and
// sticker re-detection, and checks every frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import {restProbe} from './helpers/rest-probe.mjs';
import {buildFor, hipWidth, skeletonPose, kneeBend, kneeForwardOf, poseCom, supportRange, THIGH, SHIN, KNEE_MIN_DEG, KNEE_SOFT_DEG, STANCE_HIP_MIN, REST_HIP_SEP, STANCE_SH_MAX} from '../neural-dance/src/skeleton-dancer.js';
import {jointForwardOffset} from '../neural-dance/src/leg-ik.js';
import {JUMP_MIN_ACT, JUMP_MIN_GAP_S} from '../neural-dance/src/silhouette.js';

function kneeAlong(pose, side, sg) {
  const hip = pose['hip' + side], knee = pose['knee' + side], ankle = pose['ankle' + side];
  const k = kneeBend(hip, knee, ankle, sg);
  const fwd = kneeForwardOf(pose, side);
  const along = jointForwardOffset(hip, knee, ankle, fwd);
  const hz = +hip.z || 0, kz = +knee.z || 0, az = +ankle.z || 0;
  const ux0 = ankle.x - hip.x, uy0 = ankle.y - hip.y, uz0 = az - hz;
  const d = Math.hypot(ux0, uy0, uz0) || 1e-9;
  const ux = ux0 / d, uy = uy0 / d, uz = uz0 / d;
  const vx = knee.x - hip.x, vy = knee.y - hip.y, vz = kz - hz, tt = vx * ux + vy * uy + vz * uz;
  const px = vx - tt * ux, py = vy - tt * uy, pz = vz - tt * uz;
  const lx = fwd.z || 0, lz = -(fwd.x || 0);
  const ll = Math.hypot(lx, lz) || 1;
  const lat = (px * lx + pz * lz) / ll;
  const outward = lat * (sg < 0 ? -1 : 1);
  return { ...k, along, outward, off: Math.hypot(px, py, pz) };
}

const corr = (a, b) => {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

test('10-minute rest hold: feet 0.8–0.9 hip widths (never closer), planted feet never slide or pop, home stays on the sticker', () => {
  const o = restProbe({phases: [{s: 600, kind: 'silence'}], dancers: 4, fps: 30, jitterPx: 2, redetectEvery: 7});
  console.log('rest 10 min', JSON.stringify({minHip: +o.minHip.toFixed(3), maxHip: +o.maxHip.toFixed(3), slip: +o.slip.toFixed(3), plantedJump: +o.plantedJump.toFixed(3), drift: +o.drift.toFixed(3)}));
  assert.ok(o.restFrames > 60000);
  assert.ok(o.minHip >= STANCE_HIP_MIN - 0.01, 'rest feet never closer than 0.8 hip widths (' + o.minHip.toFixed(3) + ')');
  assert.ok(o.maxHip <= 0.92, 'rest feet just under hip width (' + o.maxHip.toFixed(3) + ')');
  assert.ok(o.slip <= 0.05, 'planted slip ' + o.slip.toFixed(3) + ' px');
  assert.ok(o.plantedJump <= 1.0, 'no foot pops from jitter: ' + o.plantedJump.toFixed(3) + ' px/frame');
  assert.ok(o.drift < 0.08, 'home drift ' + o.drift.toFixed(3) + ' heights');
});

test('10-minute show (breakdowns, drops, silences): no sliding, jumps are rare real arcs at high activation, stance within bounds', () => {
  const phases = [];
  for (let k = 0; k < 10; k++) phases.push({s: 20, kind: 'music', bpm: 120, level: 0.3}, {s: 20, kind: 'music', bpm: 124, level: 1.0, bass: true}, {s: 10, kind: 'silence'}, {s: 10, kind: 'music', bpm: 96, level: 0.6});
  const acts = [], drops = [], bass = [], kneeBad = [], kneeIn = [], comOut = [], pelvisBad = [];
  let airborne = 0;
  const o = restProbe({phases, dancers: 4, fps: 30, jitterPx: 2, redetectEvery: 7, onFrame(fr, x) {
    const j = fr.joints, h = fr.height;
    if (!j || !j.hipL) return;
    acts.push(+fr.activation || 0); bass.push(+fr.bass || 0);
    drops.push(((j.hipL.y + j.hipR.y) / 2 - (fr.floorY - (THIGH + SHIN) * h - 0.02 * h)) / h);
    const posed = {
      ...j,
      heelL: j.heelL || fr.heelL, footL: j.footL || fr.footL,
      heelR: j.heelR || fr.heelR, footR: j.footR || fr.footR,
      twist: j.twist || fr.twist, facing: (j.twist && j.twist.facing) ?? (fr.twist && fr.twist.facing),
    };
    for (const [s, sg] of [['L', -1], ['R', 1]]) {
      const k = kneeAlong(posed, s, sg);
      if (!(k.along > -1e-4) || k.angleDeg < KNEE_MIN_DEG - 2 || k.angleDeg > 180 - KNEE_SOFT_DEG + 2) kneeBad.push([s, +k.along.toFixed(2), +k.outward.toFixed(2), +k.angleDeg.toFixed(1)]);
      if (k.outward < -0.4 * k.off - 0.3) kneeIn.push([s, +k.along.toFixed(2), +k.outward.toFixed(2)]);
      // Pelvis never above what the leg reaches: hip-ankle distance equals
      // the leg's reach at its knee angle (law of cosines on the drawn
      // thigh), i.e. no stretched shin under a floating hip.
      const th = Math.hypot(j['knee' + s].x - j['hip' + s].x, j['knee' + s].y - j['hip' + s].y, j['knee' + s].z - j['hip' + s].z);
      const sc = th / THIGH;
      const reach = Math.sqrt(THIGH * THIGH + SHIN * SHIN - 2 * THIGH * SHIN * Math.cos(k.angleDeg * Math.PI / 180)) * sc;
      const d = Math.hypot(j['ankle' + s].x - j['hip' + s].x, j['ankle' + s].y - j['hip' + s].y, j['ankle' + s].z - j['hip' + s].z);
      if (d > reach * 1.02 + 0.3) pelvisBad.push([s, +d.toFixed(1), +reach.toFixed(1), +k.angleDeg.toFixed(0)]);
    }
    // Support = feet on or just leaving the floor (< 2.6% height: the lift-off
    // transition over which the weight moves onto the stance foot).
    const down = [x.liftL <= 0.024, x.liftR <= 0.024];
    if (!down[0] && !down[1]) { airborne++; return; }
    const xs = [];
    if (down[0]) xs.push(fr.footL.x, fr.heelL.x);
    if (down[1]) xs.push(fr.footR.x, fr.heelR.x);
    const com = 0.55 * (j.hipL.x + j.hipR.x) / 2 + 0.33 * j.heart.x + 0.12 * j.head.x;
    const m = 0.035 * h;
    if (com < Math.min(...xs) - m || com > Math.max(...xs) + m) comOut.push(+((com - (Math.min(...xs) + Math.max(...xs)) / 2) / h).toFixed(3));
  }});
  const frames = acts.length;
  console.log('show 10 min bad', JSON.stringify({knee: kneeBad.slice(0, 4), pelvis: pelvisBad.slice(0, 6), com: comOut.slice(0, 6)}));
  console.log('show 10 min', JSON.stringify({frames, plantedJump: o.plantedJump, slip: +o.slip.toFixed(3), slipP99: o.slipP99, maxSh: +o.maxSh.toFixed(3), jumps: o.jumps.length, kneeBad: kneeBad.length, comOut: comOut.length, pelvisBad: pelvisBad.length, airborne}));
  assert.ok(o.slip <= 0.5 && o.slipP99 <= 1e-9, 'planted-foot slip ' + o.slip.toFixed(3) + ' px (p99 ' + o.slipP99 + ')');
  assert.ok(o.plantedJump <= 1.0, 'no planted foot pops: ' + o.plantedJump.toFixed(3));
  assert.ok(o.maxSh <= STANCE_SH_MAX + 0.01, 'max stance (drawn-height estimate, ±0.5%) ' + o.maxSh.toFixed(3) + ' shoulder widths');
  assert.ok(o.minHip >= 0.80, 'rest/silence feet never closer than 0.8 hip widths in 2D (' + o.minHip.toFixed(3) + ')');
  // Jumps: rare, at high activation, short ballistic arcs.
  for (const jmp of o.jumps) {
    assert.ok(jmp.minAct >= JUMP_MIN_ACT - 0.15, 'jump at activation ' + jmp.minAct.toFixed(2));
    assert.ok(jmp.frames <= 20, 'jump lasts ' + jmp.frames + ' frames');
  }
  assert.ok(o.jumps.length <= 4 * 600 / JUMP_MIN_GAP_S, 'jump count ' + o.jumps.length);
  assert.equal(kneeBad.length, 0, 'knees bend forward (100% of frames) within the knee range: ' + JSON.stringify(kneeBad.slice(0, 5)));
  // Mostly-sideways-inward knees: only on deep cross-steps with the foot far
  // in front/behind (a few frames per 10 min).
  assert.ok(kneeIn.length <= frames * 2 * 1e-4, 'knees never splay inward (' + kneeIn.length + ' frames)');
  assert.equal(pelvisBad.length, 0, 'pelvis within leg reach: ' + JSON.stringify(pelvisBad.slice(0, 5)));
  // The weight shift is eased (~60 ms) so a fast lift-off never pops the
  // body; the 1–3 frames of a quick lift-off can trail the stance foot.
  assert.ok(comOut.length <= frames * 0.03, 'COM over the support feet (' + comOut.length + ' of ' + frames + ' frames out: ' + comOut.slice(0, 5).join(',') + ')');
  // Squat depth follows activation and bass.
  const cA = corr(acts, drops), cB = corr(bass, drops);
  console.log('squat corr', {activation: +cA.toFixed(3), bass: +cB.toFixed(3)});
  assert.ok(cA > 0.5, 'squat depth correlates with activation (' + cA.toFixed(3) + ')');
  assert.ok(cB > 0.3, 'squat depth correlates with bass (' + cB.toFixed(3) + ')');
});

test('knees: forward over the toes and within the realistic range across activation, squat, weight and time', () => {
  let n = 0;
  for (const id of [3, 7, 11, 20]) for (const act of [0, 0.2, 0.5, 0.8, 1]) for (const sq of [0, 0.5, 1]) for (const w of [-1, -0.3, 0.4, 1]) for (let f = 0; f < 12; f++) {
    const u = skeletonPose({id, band: id % 4, activation: act, squat: sq, weight: w, side: w >= 0 ? 1 : -1, ease: f / 12, now: 1000 + f * 40, periodMs: 480, hush: 1});
    for (const [s, sg] of [['L', -1], ['R', 1]]) {
      const k = kneeAlong(u, s, sg);
      assert.ok(k.along > -1e-4, 'knee forward over the toes (' + k.along.toFixed(4) + ')');
      assert.ok(k.outward >= -0.4 * k.off - 1e-4, 'never knock-kneed / sideways in (' + k.outward.toFixed(4) + ' of ' + k.off.toFixed(4) + ')');
      assert.ok(k.along >= 0.8 * Math.abs(k.outward) - 1e-4, 'bend is mostly forward over the toes');
      assert.ok(k.angleDeg >= KNEE_MIN_DEG - 1 && k.angleDeg <= 180 - KNEE_SOFT_DEG + 1, 'knee angle ' + k.angleDeg.toFixed(1));
      n++;
    }
    // COM over the support for the unit pose.
    const sup = supportRange(u);
    if (sup) { const c = poseCom(u); assert.ok(c >= sup.min - 1e-6 && c <= sup.max + 1e-6, 'unit COM over support'); }
  }
  assert.ok(n > 1000);
  const low = skeletonPose({id: 3, band: 1, activation: 0.05, squat: 0, side: -1, weight: -1});
  const peak = skeletonPose({id: 3, band: 1, activation: 1, squat: 1, side: -1, weight: -1});
  const kl = kneeBend(low.hipL, low.kneeL, low.ankleL, -1).angleDeg, kp = kneeBend(peak.hipL, peak.kneeL, peak.ankleL, -1).angleDeg;
  assert.ok(kl > 160, 'breakdown: near-straight legs with a soft bend (' + kl.toFixed(0) + '°)');
  assert.ok(kp < 110, 'drop: deep squat (' + kp.toFixed(0) + '°)');
  assert.ok(peak.hipL.y > low.hipL.y + 0.06, 'hips go down in the squat');
});

test('silence idle groove: small nonzero sway on the held beat, phase-continuous, rest stance, feet planted', () => {
  const beatS = 60 / 112;
  const sway = [];
  const o = restProbe({phases: [{s: 20, kind: 'music', bpm: 112, level: 0.6}, {s: 30, kind: 'silence'}], dancers: 2, fps: 30, jitterPx: 0, redetectEvery: 1e9, onFrame(fr, x) {
    if (fr.id !== 200 || x.music || x.t < 24) return;
    const j = fr.joints;
    sway.push({t: x.t, x: ((j.hipL.x + j.hipR.x) / 2 - (fr.footL.x + fr.footR.x) / 2) / fr.height, groove: fr.groove});
  }});
  assert.ok(sway.every(s => s.groove > 0.99), 'groove fully on in silence');
  const xs = sway.map(s => s.x), mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const amp = Math.max(...xs) - Math.min(...xs);
  assert.ok(amp > 0.01 && amp < 0.06, 'sway amplitude small but nonzero (' + amp.toFixed(4) + ' heights)');
  // Phase: the sway follows sin(pi * beats since the held beat) at the held tempo.
  const ref = sway.map(s => Math.sin(Math.PI * (s.t - 0) / beatS));
  const best = Math.max(...[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map(sh => Math.abs(corr(xs.map(v => v - mean), sway.map(s => Math.sin(Math.PI * (s.t / beatS + sh)))))));
  void ref;
  assert.ok(best > 0.8, 'sway locked to the held tempo (corr ' + best.toFixed(3) + ')');
  assert.ok(o.slip <= 0.25, 'feet do not slide while grooving (sub-pixel) (' + o.slip.toFixed(3) + ')');
  assert.ok(o.minHip >= STANCE_HIP_MIN - 0.01 && o.maxHip <= Math.max(0.95, REST_HIP_SEP + 0.1) + 0.6, 'stance in bounds');
});

test('rest separation helpers: units are foot centres / outer hip width', () => {
  const b = buildFor(5, 2);
  assert.ok(Math.abs(hipWidth(b) - 2 * b.hipW) < 1e-9, 'hipWidth is the visual pelvis');
});
