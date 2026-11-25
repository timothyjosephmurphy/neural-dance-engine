// Breakdown / build / drop motion (TJ Nov 11 4:12 PM), fed by breakdown-detect.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBreakdownDetector} from '../neural-dance/src/breakdown-detect.js';
import * as S from '../neural-dance/src/section-motion.js';
import {createSongTempoLock} from '../neural-dance/src/song-tempo-lock.js';
import {skeletonPose} from '../neural-dance/src/skeleton-dancer.js';

const BPM = 120, BEAT = 500, BAR = 2000, FRAME = 1000 / 60;
// Synthetic audio: groove (kick every beat), breakdown (pads only), build
// (rising mids + snare roll), drop (kick back on the bar).
function synth(sections) {
  const frames = [];
  let t = 1000;
  for (const sec of sections) {
    const t0 = t, t1 = t + sec.bars * BAR;
    let nextBeat = t0, n = 0;
    for (; t < t1; t += FRAME) {
      const u = (t - t0) / (t1 - t0);
      let lv = [0, 0, 0, 0], glv = 0, onsets = 0, gate = true;
      if (sec.kind === 'groove') { lv = [0.6, 0.35, 0.15, 0]; glv = 0.85; }
      if (sec.kind === 'break') { lv = [0.1, 0.02, 0.3, 0]; glv = 0.3; }
      if (sec.kind === 'build') { lv = [0.1, 0.02, 0.2 + 0.4 * u, 0.1 * u]; glv = 0.3 + 0.45 * u; }
      if (t >= nextBeat) {
        nextBeat += sec.kind === 'build' && u > 0.6 ? BEAT / 4 : BEAT; n++;
        if (sec.kind === 'groove') { onsets |= 1; lv[0] = 0.9; }
        if (sec.kind === 'build') onsets |= 4;
      }
      frames.push({t, lv, glv, onsets, gate, kind: sec.kind});
    }
  }
  return frames;
}
function run(frames) {
  const det = createBreakdownDetector(), sm = S.createSectionMotion();
  const out = [];
  for (const f of frames) {
    const r = det.process({t: f.t, lv: f.lv, onsets: f.onsets, gate: f.gate, glv: f.glv, bpm: BPM});
    const st = sm.update(f.t, r);
    out.push({t: f.t, kind: f.kind, det: r, mods: sm.mods(f.t), jump: sm.jump(f.t), landAt: st.landAt, ev: r.event});
  }
  return out;
}
const SONG = [{bars: 12, kind: 'groove'}, {bars: 6, kind: 'break'}, {bars: 8, kind: 'build'}, {bars: 6, kind: 'groove'}];

test('breakdown: calm and pad-driven, no claps', () => {
  const o = run(synth(SONG));
  const brk = o.filter(x => x.kind === 'break' && x.det.state === 'breakdown');
  assert.ok(brk.length > 60, 'breakdown detected');
  const late = brk.slice(-30);
  assert.ok(late.every(x => x.mods.calm > 0.5 && x.mods.hipMul < 0.8 && x.mods.padMul > 1.4), 'calm: smaller hips, bigger pad arms');
  assert.ok(brk.every(x => !x.mods.clapOK), 'no claps');
  assert.ok(late.every(x => x.mods.tall < 0.2 && x.mods.armRaise < 0.2), 'not building yet');
});

test('build: dancers stand taller and raise hands overhead as it rises', () => {
  const o = run(synth(SONG)).filter(x => x.kind === 'build' && x.det.state === 'breakdown');
  assert.ok(o.length > 100);
  const q = k => [0.1, 0.5, 0.95].map(p => o[Math.floor(p * (o.length - 1))].mods[k]);
  const tall = q('tall'), raise = q('armRaise');
  assert.ok(tall[0] < tall[1] && tall[1] < tall[2] && tall[2] > 0.6, `tall ${tall.map(v => v.toFixed(2))}`);
  assert.ok(raise[2] > 0.8 && raise[0] < 0.3, `raise ${raise.map(v => v.toFixed(2))}`);
  assert.ok(Math.max(...o.map(x => x.mods.armForward)) > 0.4, 'forward reach on the way up');
  const p0 = skeletonPose({id: 2, band: 2, activation: 0.6, tall: tall[0], armLift: raise[0]});
  const p1 = skeletonPose({id: 2, band: 2, activation: 0.6, tall: tall[2], armLift: raise[2]});
  assert.ok(Math.min(p1.handL.y, p1.handR.y) < p1.crown.y, 'hands overhead at the top of the build');
  assert.ok(Math.min(p0.handL.y, p0.handR.y) > Math.min(p1.handL.y, p1.handR.y));
});

test('drop: one synchronized jump stomp that lands on the drop', () => {
  const o = run(synth(SONG));
  const drop = o.find(x => x.ev && x.ev.type === 'drop');
  assert.ok(drop, 'drop detected');
  const lands = [...new Set(o.filter(x => x.landAt >= 0).map(x => x.landAt))];
  assert.equal(lands.length, 1, 'one shared landing for every dancer');
  const err = lands[0] - drop.t;
  // planned: on the hit; unplanned: on the next beat after the hit (>= LATE_FALLBACK_MIN_MS)
  assert.ok(err >= -S.DROP_MATCH_MS && err <= Math.ceil(S.LATE_FALLBACK_MIN_MS / BEAT) * BEAT + 1, `landing ${err.toFixed(0)} ms from the drop`);
  const air = o.filter(x => x.jump.lift > 0);
  assert.ok(air.length > 10 && Math.max(...air.map(x => x.jump.lift)) > 0.09, 'a big jump');
  const after = o.filter(x => x.t > lands[0] + 400 && x.t < lands[0] + 2000);
  assert.ok(after.every(x => x.mods.hot > 0 && x.mods.clapOK), 'hot groove after the drop');
});

test('drop jump shape: crouch, air, land, then nothing', () => {
  assert.equal(S.dropJumpShape(-2000).phase, 'none');
  assert.equal(S.dropJumpShape(-S.DROP_AIR_MS - 50).phase, 'crouch');
  const mid = S.dropJumpShape(-S.DROP_AIR_MS / 2);
  assert.ok(mid.air && Math.abs(mid.lift - S.DROP_RISE) < 1e-9);
  assert.equal(S.dropJumpShape(0).lift, 0);
  assert.equal(S.dropJumpShape(100).phase, 'land');
  assert.equal(S.dropJumpShape(1000).phase, 'none');
});

test('a breakdown that ends without a drop cancels a scheduled jump', () => {
  const sm = S.createSectionMotion();
  sm.update(0, {state: 'breakdown', progress: 0.95, predictedDropAt: 400});
  assert.equal(sm.state.landAt, 400);
  sm.update(16, {state: 'breakdown', progress: 0.95, predictedDropAt: 400});
  // no drop arrives; the landing passes
  for (let t = 32; t < 1500; t += 16) sm.update(t, {state: t < 900 ? 'breakdown' : 'groove', progress: 0.9});
  assert.equal(sm.state.scheduled, false);
});

test('BPM re-check runs when the breakdown ends (drop or not)', () => {
  for (const type of ['drop', 'breakdownEnd']) {
    const lock = createSongTempoLock();
    let t = 0;
    for (; t < 20000; t += 100) lock.update(t, 120, true, {onset: t % 500 === 0});
    assert.ok(lock.state.locked);
    lock.sectionEvent(t, {type: 'breakdown'});
    assert.equal(lock.state.breakdown, true);
    lock.sectionEvent(t + 16000, {type});
    assert.equal(lock.state.breakdown, false);
    const before = lock.state.rechecks;
    // Same tempo returns: the re-check happens once enough is heard.
    for (let k = t + 16000; k < t + 16000 + 30000; k += 100) lock.update(k, 120, true, {onset: k % 500 === 0});
    assert.ok(lock.state.rechecks > before, `${type}: re-checked`);
    assert.equal(Math.round(lock.state.bpm), 120);
  }
});

test('sim demo timeline: groove → breakdown → build → drop, landing on the bar', () => {
  const seen = new Set();
  let landAt = null;
  for (let t = 0; t < 30; t += 0.05) {
    const d = S.demoSectionAt(t, 120);
    const m = S.sectionMods({state: d.state, progress: d.progress, calm: d.calm, sinceDropMs: d.sinceDrop * 1000});
    seen.add(m.kind);
    if (d.sinceDrop >= 0 && d.sinceDrop < 0.06 && landAt == null) landAt = d.landAt;
  }
  for (const k of ['groove', 'breakdown', 'build', 'drop']) assert.ok(seen.has(k), k);
  assert.ok(landAt != null && Math.abs(landAt / 2 - Math.round(landAt / 2)) < 1e-6, 'drop on a bar line (2 s bars at 120)');
});

// TJ's rules on top of the section motion: smooth transitions (no snapping),
// the overhead build arms and the jump keep the rear arm limit.
import {armBackLimit, girdleForward} from '../neural-dance/src/arm-forward.js';
const JOINTS = ['head', 'crown', 'shL', 'shR', 'elL', 'elR', 'wristL', 'wristR', 'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR'];

test('section mods and the jump never snap frame to frame (streaming, synthetic song)', () => {
  const o = run(synth(SONG));
  const keys = ['tall', 'armRaise', 'armForward', 'hipMul', 'padMul', 'shoulderMul', 'calm', 'hot'];
  let worst = {};
  for (let i = 1; i < o.length; i++) {
    for (const k of keys) { const d = Math.abs(o[i].mods[k] - o[i - 1].mods[k]); if (!(d <= (worst[k] || 0))) worst[k] = d; }
    for (const k of ['lift', 'crouch']) { const d = Math.abs(o[i].jump[k] - o[i - 1].jump[k]); if (!(d <= (worst[k] || 0))) worst[k] = d; }
  }
  // per 16.7 ms frame: mods move at most ~12% of their range, the jump ~2.5% of figure height
  for (const k of keys) assert.ok(worst[k] < 0.12 * (k === 'padMul' ? 1.9 : k === 'hipMul' ? 1.6 : 1), `${k} step ${worst[k].toFixed(3)}`);
  assert.ok(worst.lift < 0.025 && worst.crouch < 0.2, `jump step lift ${worst.lift.toFixed(4)} crouch ${worst.crouch.toFixed(3)}`);
  // arms stay up through the jump and come down after the landing
  const land = o.find(x => x.landAt >= 0).landAt;
  const atLand = o.find(x => x.t >= land);
  assert.ok(atLand.mods.armRaise > 0.6, `arms still up at the landing (${atLand.mods.armRaise.toFixed(2)})`);
  assert.ok(o.filter(x => x.t > land + 2500).every(x => x.mods.armRaise < 0.05), 'arms down after the drop');
});

test('a late jump fades in and a cancelled jump fades out (no pop)', () => {
  const sm = S.createSectionMotion();
  let prev = null, worst = 0;
  for (let t = 0; t < 1200; t += 16) {
    sm.update(t, t === 160 ? {state: 'groove', event: {type: 'drop', big: true}} : {state: 'groove'});
    const j = sm.jump(t);
    if (prev) worst = Math.max(worst, Math.abs(j.crouch - prev.crouch), Math.abs(j.lift - prev.lift));
    prev = j;
  }
  assert.ok(worst < 0.2, `late jump step ${worst.toFixed(3)}`);
  const sc = S.createSectionMotion();
  sc.update(0, {state: 'breakdown', progress: 0.95, predictedDropAt: 590});
  for (let t = 16; t < 112; t += 16) sc.update(t, {state: 'breakdown', progress: 0.95});
  const before = sc.jump(96).crouch;
  assert.ok(before > 0.3, 'mid crouch when the breakdown ends');
  sc.update(112, {state: 'groove', event: {type: 'breakdownEnd'}});
  let w2 = Math.abs(sc.jump(112).crouch - before), p2 = sc.jump(112).crouch;
  for (let t = 128; t < 700; t += 16) { sc.update(t, {state: 'groove'}); const c = sc.jump(t).crouch; w2 = Math.max(w2, Math.abs(c - p2)); p2 = c; }
  assert.ok(w2 < 0.2 && sc.state.landAt === -1 && sc.jump(700).phase === 'none', `cancel fades (${w2.toFixed(3)})`);
});

test('build arms overhead and the drop jump keep the rear arm limit; pose eases with no snap', () => {
  const o = run(synth(SONG));
  const land = o.find(x => x.landAt >= 0).landAt;
  const win = o.filter(x => x.t > land - 9000 && x.t < land + 2500);
  // A snap is a jerk in position (second difference), not fast smooth motion:
  // compare against the same dancer with neutral section mods (live today).
  const jerkOf = (useSec, id) => {
    let p1 = null, p2 = null, worst = 0, at = 0;
    for (const x of win) {
      const m = useSec ? x.mods : S.sectionMods({}), j = useSec ? x.jump : {lift: 0, crouch: 0, raveFade: 1};
      const p = skeletonPose({id, band: id % 4, activation: 0.7, now: x.t, periodMs: BEAT, bpm: BPM, beat: (x.t / BEAT), tall: m.tall, armLift: Math.max(0.3, m.armRaise), armForward: m.armForward, jump: j.lift, squat: 0.8 * j.crouch, hipEight: 0.8 * m.hipMul, raveFade: j.raveFade != null && j.raveFade < 0.999 ? j.raveFade : null});
      if (useSec) {
        const f = girdleForward(p.shL, p.shR);
        const lim = armBackLimit(p.head, p.headR || 0.066, f);
        for (const k of ['elL', 'elR', 'wristL', 'wristR']) {
          const v = p[k].x * f.x + (+p[k].z || 0) * f.z - lim;
          assert.ok(v >= -0.01, `${k} ${v.toFixed(4)} behind the head (id ${id}, t ${x.t.toFixed(0)}, raise ${m.armRaise.toFixed(2)})`);
        }
      }
      if (p1 && p2) for (const k of JOINTS) if (p[k] && p1[k] && p2[k]) {
        const jx = p[k].x - 2 * p1[k].x + p2[k].x, jy = p[k].y - 2 * p1[k].y + p2[k].y;
        const v = Math.hypot(jx, jy); if (v > worst) { worst = v; at = x.t; }
      }
      p2 = p1; p1 = p;
    }
    return {worst, at};
  };
  // skeletonPose keeps per-id smoothing state, so each pass gets its own ids.
  for (const id of [11, 14, 17]) {
    const sec = jerkOf(true, id), base = jerkOf(false, id + 40);
    assert.ok(sec.worst < Math.max(0.025, 1.5 * base.worst), `id ${id}: worst jerk ${sec.worst.toFixed(4)} at ${(sec.at - land).toFixed(0)} ms from landing vs live ${base.worst.toFixed(4)}`);
  }
});

// TJ Nov 12: the stomp must land ON the drop. Real Nov 11 2:45 PM PT iPhone 13
// capture (audio features only): bass hit at 19.224 s. Before the re-phased
// pre-drop grid the landing came ~240 ms late (stale frozen tempo + one-onset anchor).
test('real capture: the drop jump lands on the bass hit (< 60 ms)', async () => {
  const {readFileSync} = await import('node:fs');
  const {replayDrop} = await import('../tools/drop-landing-replay.mjs');
  const fix = JSON.parse(readFileSync(new URL('./fixtures/live-feed/2026-11-11-1445-drop.json', import.meta.url), 'utf8'));
  const r = await replayDrop(fix, new URL('..', import.meta.url).pathname);
  assert.ok(r.drop, 'drop detected');
  assert.ok(Math.abs(r.dropT - fix.dropHitMs) < 20, `drop event at the hit (${r.dropT})`);
  assert.equal(r.lands.length, 1, 'one shared landing');
  const err = r.lands[0] - fix.dropHitMs;
  assert.ok(Math.abs(err) < 60, `landing ${err.toFixed(0)} ms from the bass hit`);
  assert.ok(r.maxLift > 0.04, `a visible jump (${r.maxLift.toFixed(3)})`);
  assert.ok(r.meterMax >= 0.99, 'meter reaches the top');
  assert.ok(Math.abs(r.meterPeakT - fix.dropHitMs) < 60, `meter peak ${r.meterPeakT} vs bass hit ${fix.dropHitMs}`);
  assert.ok(r.meterEarly < 0.99, `meter has not topped out 3s before the hit (${r.meterEarly})`);
});
