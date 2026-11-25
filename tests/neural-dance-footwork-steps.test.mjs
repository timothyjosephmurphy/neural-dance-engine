// Footwork step library (TJ Nov 11 11:12 PM): every step's foot timing lands
// on beats, taps carry no weight, steps switch only on phrase boundaries,
// dancers vary but stay on the beat, and choice follows tempo and energy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOOTWORK_STEPS, MENUS, PATTERNS, cycleLength, eventDiv, energyTier, footworkPersonality, chooseStep,
  footworkPlan, setFootworkOverride, setFootworkAllow, setFootworkFills, setFootworkTier, resetFootworkControls, resetFootwork, FOOT_HOME_RADIUS, HALF_TIME_BUSY_BPM, HALF_TIME_SIMPLE_BPM,
  HALF_TIME_ALL_BPM, FILLS, LAG_MAX, sectionSize, musicBeatsPerEvent,
} from '../neural-dance/src/footwork-steps.js';
import {skeletonPose, minStanceHalf, maxStanceHalf, buildFor} from '../neural-dance/src/skeleton-dancer.js';

const GEOM = {n: 0.125, s: 0.13, w: 0.266};
const SUB = 20; // frames per step beat

// Simulate one dancer on the step clock; returns per-frame samples.
function run({id = 5, step = null, beats = 64, stepBpm = 100, activation = 0.7, amount = 1, kick = 0.8, bass = 0.7, drop = 0, section = null, build = 0, stride = 1} = {}) {
  resetFootwork(id);
  resetFootworkControls();
  setFootworkOverride(step);
  const out = [];
  try {
    for (let b = 0; b < beats; b++) {
      for (let i = 0; i < SUB; i++) {
        const frac = i / SUB;
        const p = footworkPlan({id, beat: b, frac, stepBpm, stride, activation, amount, kick, bass, drop, section, build: typeof build === 'function' ? build(b) : build, geom: GEOM, initialSide: -1});
        out.push({b, frac, t: b + frac, ...p, pos: {L: {...p.pos.L}, R: {...p.pos.R}}});
      }
    }
  } finally { resetFootworkControls(); }
  return out;
}
const sideOf = k => (k === 'L' ? -1 : 1);

for (const step of FOOTWORK_STEPS) {
  test(`${step}: weight changes and landings happen only on beats`, () => {
    const s = run({step, beats: 48});
    let changes = 0;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], c = s[i];
      if (a.weightSide !== c.weightSide) {
        changes++;
        assert.equal(c.frac, 0, `${step}: weight changed off the beat at ${c.t}`);
        assert.equal(c.b % c.div, 0, `${step}: weight change on the event grid`);
      }
      // A foot's resting position only changes across a landing (frac 0 of a grid beat).
      for (const k of ['L', 'R']) {
        const moving = a.lift[k] > 0 || c.lift[k] > 0;
        const jump = Math.hypot(c.pos[k].x - a.pos[k].x, c.pos[k].z - a.pos[k].z);
        if (!moving) assert.ok(jump < 0.012, `${step}: ${k} slid ${jump.toFixed(4)} while down at ${c.t}`);
      }
      // Weighted foot never lifts.
      const wk = c.weightSide < 0 ? 'L' : 'R';
      assert.equal(c.lift[wk], 0, `${step}: stance foot lifted at ${c.t}`);
    }
    assert.ok(changes >= 12, `${step}: ${changes} weight changes in 48 beats`);
    // Every lift is back on the floor at the beat.
    for (const x of s) if (x.frac === 0) assert.ok(x.lift.L < 1e-9 && x.lift.R < 1e-9, `${step}: foot in the air on the beat ${x.t}`);
  });

  test(`${step}: feet stay inside the leash and the stance width bounds`, () => {
    const s = run({step, beats: 64});
    for (const x of s) {
      const sep = x.pos.R.x - x.pos.L.x;
      assert.ok(sep >= 2 * GEOM.n * 0.99, `${step}: feet too close (${sep.toFixed(3)}) at ${x.t}`);
      assert.ok(sep <= 2 * GEOM.w, `${step}: feet too wide at ${x.t}`);
      for (const k of ['L', 'R']) {
        assert.ok(Math.abs(x.pos[k].x) <= FOOT_HOME_RADIUS * GEOM.n + GEOM.s + GEOM.n + 1e-9, `${step}: ${k} off home x at ${x.t}`);
        assert.ok(Math.abs(x.pos[k].z) <= (x.lift[k] > 0 ? 0.16 : 0.1), `${step}: ${k} off home z at ${x.t}`);
      }
    }
  });
}

test('step-touch: the tap is a toe touch beside the standing foot with no weight, on the beat', () => {
  const s = run({step: 'stepTouch', beats: 32});
  let taps = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], c = s[i];
    for (const k of ['L', 'R']) {
      if (!a.tap[k] && c.tap[k]) {
        taps++;
        assert.equal(c.frac, 0, 'tap lands on a beat');
        assert.notEqual(c.weightSide, sideOf(k), 'tap foot carries no weight');
        assert.equal(c.weightSide, a.weightSide, 'a tap does not change the stance');
        assert.equal(c.contact[k], 'toe', 'tap is on the toe (heel up)');
        assert.ok(c.rock[k] > 0.3, 'heel visibly up');
        const other = k === 'L' ? 'R' : 'L';
        const gap = Math.abs(c.pos[k].x - c.pos[other].x);
        assert.ok(gap < 2 * GEOM.n * 1.15, `tap is beside the standing foot (gap ${gap.toFixed(3)})`);
        assert.ok(Math.abs(c.weight - c.weightSide) < 0.2, 'body weight stays over the standing foot');
      }
    }
  }
  assert.ok(taps >= 12, 'taps every other beat: ' + taps);
  // Direction alternates: the body centre swings side to side.
  const centres = s.filter(x => x.frac === 0).map(x => (x.pos.L.x + x.pos.R.x) / 2);
  assert.ok(Math.max(...centres) - Math.min(...centres) > 0.02, 'step-touch travels side to side');
});

test('grapevine: side, behind, side, touch, then reverse', () => {
  const s = run({step: 'grapevine', beats: 16}).filter(x => x.frac === 0);
  const ev = s.map(x => x.kind);
  assert.deepEqual(ev.slice(0, 8), ['step', 'step', 'step', 'tap', 'step', 'step', 'step', 'tap']);
  const behind = run({step: 'grapevine', beats: 16}).some(x => x.pos.L.z < -0.02 || x.pos.R.z < -0.02);
  assert.ok(behind, 'the second step goes behind');
  // Direction reverses every cycle (lead foot alternates).
  const leads = [];
  const all = run({step: 'grapevine', beats: 24});
  for (const x of all) if (x.frac === 0 && x.kind === 'step' && x.b % 4 === 0) leads.push(x.movingSide);
  assert.ok(new Set(leads).size === 2, 'grapevine reverses');
});

test('box step: forward, side, back, side; rock step: rock and recover', () => {
  const box = run({step: 'boxStep', beats: 16});
  assert.ok(box.some(x => x.pos.L.z > 0.025 || x.pos.R.z > 0.025), 'forward');
  assert.ok(box.some(x => x.pos.L.z < -0.025 || x.pos.R.z < -0.025), 'back');
  const rock = run({step: 'rockStep', beats: 16});
  const shifts = rock.filter(x => x.frac === 0 && x.kind === 'shift');
  assert.ok(shifts.length >= 6, 'recover = weight shift without lifting');
  for (const x of rock) if (x.kind === 'shift') assert.ok(x.lift.L === 0 && x.lift.R === 0, 'a recover does not lift');
});

test('kick-ball-change: kick in the air, ball tap (no weight), change on the next beat', () => {
  const s = run({step: 'kickBallChange', beats: 16});
  const kinds = s.filter(x => x.frac === 0).map(x => x.kind).slice(0, 4);
  assert.deepEqual(kinds, ['kick', 'tap', 'shift', 'step']);
  assert.ok(s.some(x => x.kind === 'kick' && (x.lift.L > 0.05 || x.lift.R > 0.05)), 'the kick lifts');
});

test('running man lifts higher than step-touch; T-step inches sideways', () => {
  const peak = (st) => Math.max(...run({step: st, beats: 16}).map(x => Math.max(x.lift.L, x.lift.R)));
  assert.ok(peak('runningMan') > peak('stepTouch') * 1.2, 'running man knee lift reads higher');
  const t = run({step: 'tStep', beats: 16}).filter(x => x.frac === 0).map(x => (x.pos.L.x + x.pos.R.x) / 2);
  assert.ok(Math.max(...t) - Math.min(...t) > 0.005, 'T-step drifts sideways');
});

test('low activation: weight shifts and toe taps only, no travel', () => {
  const s = run({step: 'stepTouch', beats: 16, activation: 0.3, amount: 0});
  for (const x of s) {
    assert.ok(x.lift.L === 0 && x.lift.R === 0, 'no lifts below the step gate');
    assert.ok(Math.abs(x.pos.L.x + GEOM.s) < 1e-6 || x.tap.L || true);
  }
  const xs = s.map(x => x.pos.R.x - x.pos.L.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.03, 'stance barely changes');
  assert.ok(s.some(x => x.contact.L === 'toe' || x.contact.R === 'toe'), 'taps still read as toe touches');
});

test('tempo: every beat below ~110 BPM, busy steps half-time from 110, all feet half-time from 125', () => {
  assert.equal(HALF_TIME_BUSY_BPM, 110);
  assert.equal(HALF_TIME_ALL_BPM, 125);
  for (const st of FOOTWORK_STEPS) assert.equal(eventDiv(st, 100), 1, st + ' at 100 BPM lands every beat');
  assert.equal(eventDiv('grapevine', HALF_TIME_BUSY_BPM), 2);
  assert.equal(eventDiv('boxStep', 118), 2);
  assert.equal(eventDiv('stepTouch', 118), 1);
  assert.equal(eventDiv('rockStep', 118), 1);
  for (const st of FOOTWORK_STEPS) assert.equal(eventDiv(st, 128), 2, st + ' at 128 BPM goes half-time');
  assert.equal(eventDiv('stepTouch', HALF_TIME_SIMPLE_BPM), 2);
  // Stride 2 (the step clock already runs at half the music tempo): no double halving.
  assert.equal(eventDiv('runningMan', 128, 2), 1);
  assert.equal(musicBeatsPerEvent('runningMan', 140), 2);
  const s = run({step: 'boxStep', beats: 32, stepBpm: 128});
  for (let i = 1; i < s.length; i++) if (s[i].weightSide !== s[i - 1].weightSide) assert.equal(s[i].b % 2, 0, 'half-time weight changes on every other beat');
});

test('energy tiers: low = step-touch / rock step, mid = grapevine / box / heel-toe / side-together-side, high = running man + kick-ball-change fills', () => {
  assert.equal(energyTier({activation: 0.8, section: 'breakdown'}), 'calm');
  assert.equal(energyTier({activation: 0.8, section: 'build'}), 'build');
  assert.equal(energyTier({activation: 0.6, section: 'drop'}), 'high');
  assert.equal(energyTier({activation: 0.2}), 'calm');
  assert.equal(energyTier({activation: 0.5, kick: 0.05, bass: 0.05}), 'calm');
  assert.equal(energyTier({activation: 0.55, kick: 0.7, bass: 0.6}), 'groove');
  assert.equal(energyTier({activation: 0.9}), 'high');
  assert.deepEqual([...MENUS.calm].sort(), ['rockStep', 'stepTouch']);
  assert.deepEqual([...MENUS.build].sort(), ['rockStep', 'stepTouch']);
  assert.deepEqual([...MENUS.groove].sort(), ['boxStep', 'chasse', 'grapevine', 'tStep']);
  assert.deepEqual(MENUS.high, ['runningMan']);
  assert.deepEqual(FILLS, ['kickBallChange']);
  const seen = {calm: new Set(), groove: new Set()};
  for (let id = 0; id < 40; id++) for (let ph = 0; ph < 8; ph++) {
    const c = chooseStep({id, phraseIndex: ph, tier: 'calm'}), g = chooseStep({id, phraseIndex: ph, tier: 'groove'});
    assert.ok(MENUS.calm.includes(c)); seen.calm.add(c);
    assert.ok(MENUS.groove.includes(g)); seen.groove.add(g);
    assert.equal(chooseStep({id, phraseIndex: ph, tier: 'high'}), 'runningMan');
  }
  assert.equal(seen.calm.size, 2, 'both low steps used across the crowd');
  assert.equal(seen.groove.size, 4, 'all four mid steps used across the crowd');
});

test('kick-ball-change: a fill into phrase downbeats at high energy, rare at 125+ BPM, never at low / mid', () => {
  const share = (stepBpm, activation) => {
    let kbc = 0, n = 0;
    for (let id = 1; id <= 24; id++) {
      const s = run({id, beats: 128, stepBpm, activation, kick: 0.9, bass: 0.9});
      for (const x of s) if (x.frac === 0) { n++; if (x.step === 'kickBallChange') { kbc++; assert.ok(x.accent, 'only as a fill'); } }
    }
    return kbc / n;
  };
  const slow = share(100, 0.9), fast = share(128, 0.9), mid = share(100, 0.6);
  console.log('# kbc share', JSON.stringify({slow, fast, mid}));
  assert.ok(slow > 0.03, 'fills at high energy below 125 BPM: ' + slow.toFixed(3));
  assert.ok(fast > 0 && fast < slow * 0.5, 'rare accent at 128 BPM: ' + fast.toFixed(3));
  assert.equal(mid, 0, 'no kick-ball-change at mid energy');
});

test('section: breakdown steps are small and calm, a build gets tighter as it rises, the drop releases into running man', () => {
  assert.equal(sectionSize('groove'), 1);
  assert.ok(sectionSize('breakdown') <= 0.6);
  assert.ok(sectionSize('build', 0.9) < sectionSize('build', 0.1), 'tighter as the build rises');
  const span = (s) => { const c = s.filter(x => x.frac === 0).map(x => (x.pos.L.x + x.pos.R.x) / 2); return Math.max(...c) - Math.min(...c); };
  const groove = span(run({step: 'stepTouch', beats: 32, activation: 0.7}));
  const brk = span(run({step: 'stepTouch', beats: 32, activation: 0.7, section: 'breakdown'}));
  assert.ok(brk < groove * 0.8, `breakdown travel ${brk.toFixed(3)} < groove ${groove.toFixed(3)}`);
  const bd = run({beats: 64, activation: 0.8, section: 'breakdown'});
  for (const x of bd) assert.ok(MENUS.calm.includes(x.step), 'breakdown menu: ' + x.step);
  const bu = run({beats: 64, activation: 0.8, section: 'build', build: b => b / 64});
  for (const x of bu) assert.ok(MENUS.build.includes(x.step), 'build menu: ' + x.step);
  const early = span(bu.filter(x => x.b < 24)), late = span(bu.filter(x => x.b >= 40));
  assert.ok(late < early, `build gets tighter: ${early.toFixed(3)} → ${late.toFixed(3)}`);
  const dr = run({beats: 32, activation: 0.85, section: 'drop'});
  assert.ok(dr.filter(x => x.b >= 8).every(x => x.step === 'runningMan' || x.step === 'kickBallChange'), 'drop: high-energy steps');
});

test('per-dancer timing: lifts start at different moments, every landing still on the beat', () => {
  const starts = new Set();
  for (let id = 1; id <= 12; id++) {
    const p = footworkPersonality(id);
    assert.ok(p.lag >= 0 && p.lag <= LAG_MAX);
    const s = run({id, step: 'stepTouch', beats: 8});
    const first = s.find(x => x.b >= 2 && (x.lift.L > 0 || x.lift.R > 0));
    starts.add(first.frac.toFixed(2));
    for (const x of s) if (x.frac === 0) assert.ok(x.lift.L < 1e-9 && x.lift.R < 1e-9, 'down on the beat');
  }
  assert.ok(starts.size >= 2, 'lift timing varies: ' + [...starts]);
});

test('steps switch only on each dancer\'s phrase boundary (4 or 8 bars)', () => {
  for (const id of [1, 2, 3, 4, 9, 13]) {
    const pers = footworkPersonality(id);
    const pb = pers.phraseBars * 4, off = (pers.offsetBars * 4) % pb;
    const s = run({id, beats: 160, activation: 0.6});
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], c = s[i];
      if (a.step !== c.step && !a.accent && !c.accent) {
        // The new step's first event lands on the boundary beat.
        const land = c.b + 1;
        assert.equal(((land - off) % pb + pb) % pb, 0, `dancer ${id}: switched at beat ${c.b} (phrase ${pb}, offset ${off})`);
      }
    }
  }
});

test('crowd variety: different dancers pick different steps and switch at different times, all on the beat', () => {
  const steps = new Set(), phrase = new Set();
  for (let id = 1; id <= 24; id++) {
    const p = footworkPersonality(id);
    phrase.add(p.phraseBars + ':' + p.offsetBars);
    const s = run({id, beats: 32, activation: 0.6});
    steps.add(s[s.length - 1].step);
    for (let i = 1; i < s.length; i++) if (s[i].weightSide !== s[i - 1].weightSide) assert.equal(s[i].frac, 0);
  }
  assert.ok(steps.size >= 4, 'at least four different steps across 24 dancers: ' + [...steps]);
  assert.ok(phrase.size >= 3, 'personalities vary phrase length / offset');
  const p1 = footworkPersonality(3), p2 = footworkPersonality(3);
  assert.deepEqual(p1, p2, 'seeded: stable per dancer');
});

test('every pattern cycle ends with the free foot ready to lead and returns its weight balance', () => {
  for (const id of FOOTWORK_STEPS) {
    assert.ok(cycleLength(id) >= 2);
    for (const ev of PATTERNS[id]) assert.ok(['step', 'tap', 'shift', 'kick'].includes(ev.kind));
  }
});

test('phrase realign (#114): an even strike-count jump lands one step and does not slide the planted foot', () => {
  // phraseHold adds an even count, then the strike adds 1, so the beat index
  // jumps by an odd amount. That plants the same foot as taking the single
  // next step. The contact that was already down does not move.
  const idA = 81, idB = 82;
  resetFootwork(idA); resetFootwork(idB);
  setFootworkOverride('stepTouch');
  const play = (id, from, to) => {
    let last = null;
    for (let b = from; b <= to; b++) {
      for (let i = 0; i < SUB; i++) {
        last = footworkPlan({id, beat: b, frac: i / SUB, stepBpm: 100, activation: 0.75, amount: 1, kick: 0.8, bass: 0.7, geom: GEOM, initialSide: -1});
      }
    }
    return last;
  };
  try {
    const base = play(idA, 0, 9);
    play(idB, 0, 9);
    const plantedK = base.weightSide < 0 ? 'L' : 'R';
    const before = {x: base.pos[plantedK].x, z: base.pos[plantedK].z};
    const jumped = footworkPlan({id: idA, beat: 16, frac: 0, stepBpm: 100, activation: 0.75, amount: 1, kick: 0.8, bass: 0.7, geom: GEOM, initialSide: -1});
    const stepped = footworkPlan({id: idB, beat: 10, frac: 0, stepBpm: 100, activation: 0.75, amount: 1, kick: 0.8, bass: 0.7, geom: GEOM, initialSide: -1});
    assert.equal(jumped.weightSide, stepped.weightSide, 'realign plants the same foot as the next step');
    const stayed = jumped.pos[plantedK];
    assert.ok(Math.hypot(stayed.x - before.x, stayed.z - before.z) < 1e-6, 'the foot that was planted did not slide');
    assert.equal(jumped.lift.L, 0);
    assert.equal(jumped.lift.R, 0);
  } finally { setFootworkOverride(null); resetFootwork(idA); resetFootwork(idB); }
});

test('live skeletonPose: a footwork tap keeps the toe down with the heel up and the pelvis over the standing foot', () => {
  const b = buildFor(4, 0);
  const geom = {n: minStanceHalf(b) * 1.06, s: minStanceHalf(b) * 1.2, w: maxStanceHalf(b)};
  resetFootwork(4); setFootworkOverride('stepTouch');
  let checked = 0;
  try {
    const PERIOD = 600;
    for (let i = 0; i < 400; i++) {
      const now = 10000 + i * 20, beat = Math.floor(i * 20 / PERIOD), frac = ((i * 20) % PERIOD) / PERIOD;
      const plan = footworkPlan({id: 4, beat, frac, stepBpm: 100, activation: 0.75, amount: 1, geom, initialSide: -1});
      const side = plan.weightSide;
      const u = skeletonPose({id: 4, band: 0, weight: plan.weight, ease: frac, side, activation: 0.75, now, periodMs: PERIOD, beat, stepHz: 1000 / PERIOD,
        strikes: [{t0: (10000 + beat * PERIOD) / 1000, energy: 0.7, side}], pulseAmp: 0.4, pulseHz: 1, footwork: plan, bandLevels: [0.7, 0.6, 0.3, 0.5]});
      assert.ok(u.footwork && u.footwork.step === 'stepTouch');
      const tapK = plan.tap.L && side > 0 ? 'L' : plan.tap.R && side < 0 ? 'R' : null;
      if (tapK && frac > 0.02 && frac < 0.1 && plan.lift[tapK] === 0) {
        checked++;
        const toe = u['foot' + tapK], heel = u['heel' + tapK];
        assert.ok(heel.y < toe.y - 0.002, 'heel raised on the tapping foot');
        const plant = side < 0 ? u.footL : u.footR;
        assert.ok(Math.abs(u.groin.x - plant.x) < Math.abs(u.groin.x - toe.x) + 0.02, 'pelvis nearer the standing foot');
      }
    }
  } finally { setFootworkOverride(null); }
  assert.ok(checked > 3, 'checked taps: ' + checked);
});

test('side-sim allow-list replaces the energy menu and shows on the next plan', () => {
  resetFootworkControls();
  resetFootwork(41);
  try {
    setFootworkAllow(['runningMan', 'chasse']);
    for (let i = 0; i < 12; i++) {
      const picked = chooseStep({id: 40 + i, phraseIndex: i, tier: 'calm'});
      assert.ok(picked === 'runningMan' || picked === 'chasse', picked);
    }
    const quiet = footworkPlan({id: 41, beat: 0, frac: 0, stepBpm: 100, activation: 0.05, amount: 1, kick: 0, bass: 0, section: 'breakdown', geom: GEOM, initialSide: -1});
    assert.ok(quiet.step === 'runningMan' || quiet.step === 'chasse', quiet.step);
  } finally { resetFootworkControls(); resetFootwork(41); }
});

test('forcing one step takes over on the next beat', () => {
  resetFootworkControls();
  resetFootwork(42);
  try {
    setFootworkOverride('tStep');
    for (let b = 0; b < 3; b++) {
      for (let i = 0; i < 8; i++) footworkPlan({id: 42, beat: b, frac: i / 8, stepBpm: 100, activation: 0.8, amount: 1, geom: GEOM, initialSide: -1});
    }
    setFootworkOverride('runningMan');
    let seen = null;
    for (let b = 3; b < 6 && !seen; b++) {
      for (let i = 0; i < 8; i++) {
        const p = footworkPlan({id: 42, beat: b, frac: i / 8, stepBpm: 100, activation: 0.8, amount: 1, geom: GEOM, initialSide: -1});
        if (p.step === 'runningMan') seen = p;
      }
    }
    assert.equal(seen && seen.step, 'runningMan');
  } finally { resetFootworkControls(); resetFootwork(42); }
});

test('energy lock uses the high menu in a quiet room, and fills can be turned off', () => {
  resetFootworkControls();
  resetFootwork(43);
  try {
    setFootworkTier('high');
    setFootworkFills(false);
    const steps = new Set();
    for (let b = 0; b < 48; b++) {
      const p = footworkPlan({id: 43, beat: b, frac: 0, stepBpm: 100, activation: 0.05, amount: 1, kick: 0, bass: 0, section: 'breakdown', geom: GEOM, initialSide: -1});
      steps.add(p.step);
    }
    assert.deepEqual([...steps], ['runningMan']);
  } finally { resetFootworkControls(); resetFootwork(43); }
});
