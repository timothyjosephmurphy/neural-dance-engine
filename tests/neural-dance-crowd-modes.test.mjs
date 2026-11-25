// Crowd fallback pages (/neural-dance/demo/, /neural-dance/show/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrowd, canClimb, climbChance, depthOf, stageAttraction, CLIMB_DOWN_AT} from '../neural-dance/src/crowd-sim.js';
import {CROWD_SURFACES, isSupported, onFloor, heightAt} from '../neural-dance/src/crowd-surfaces.js';
import {showEnergy, showDensity, showPosition, staticAmount, createShowClock, zoneMinutes, crowdCount, SHOW_PEAK_MIN, SHOW_LEN_MIN, clampSpeed, clampBoost} from '../neural-dance/src/crowd-schedule.js';
import {createDemoTrigger} from '../neural-dance/src/crowd-trigger.js';

const map = CROWD_SURFACES;
const run = (crowd, seconds, env, each) => { for (let i = 0; i < seconds * 10; i++) { crowd.step(0.1, typeof env === 'function' ? env(i / 10) : env); if (each) each(); } };

test('energy rises exponentially to a peak at 3:15-3:30 AM, then decays', () => {
  let peakAt = 0, peak = -1;
  for (let m = 0; m <= SHOW_LEN_MIN; m++) { const e = showEnergy(m); if (e > peak) { peak = e; peakAt = m; } }
  const clock = 21 * 60 + peakAt - 1440;
  assert.ok(clock >= 3 * 60 + 15 && clock <= 3 * 60 + 30, 'peak at ' + clock);
  assert.ok(showEnergy(0) < 0.2);
  // Convex build: second half gains more than the first.
  assert.ok(showEnergy(SHOW_PEAK_MIN) - showEnergy(SHOW_PEAK_MIN / 2) > 2 * (showEnergy(SHOW_PEAK_MIN / 2) - showEnergy(0)));
  for (let m = 1; m <= SHOW_PEAK_MIN; m++) assert.ok(showEnergy(m) >= showEnergy(m - 1));
  for (let m = SHOW_PEAK_MIN + 1; m <= SHOW_LEN_MIN; m++) assert.ok(showEnergy(m) <= showEnergy(m - 1));
  assert.ok(showEnergy(SHOW_LEN_MIN) < 0.6, 'calmer at the end');
  assert.ok(showDensity(SHOW_PEAK_MIN) > 0.95 && showDensity(0) < 0.1);
});

test('wall clock in Los Angeles maps to the show window and the 4 AM static fade', () => {
  // 2026-11-25 05:00 UTC = Nov 24 9:00 PM PST.
  const nine = Date.UTC(2026, 10, 25, 5, 0, 0);
  assert.equal(Math.round(zoneMinutes(nine)), 21 * 60);
  const at = mins => createShowClock({now: nine + mins * 60000}).state(nine + mins * 60000);
  assert.equal(at(0).pos.inShow, true);
  assert.ok(Math.abs(at(0).energy - showEnergy(0)) < 1e-9);
  const peak = at(SHOW_PEAK_MIN);
  assert.ok(peak.energy > 0.99, 'peak energy ' + peak.energy);
  assert.ok(at(60).energy < at(240).energy);
  assert.equal(at(SHOW_LEN_MIN - 1).staticAmount, 0);
  const end = at(SHOW_LEN_MIN + 0.75);
  assert.equal(end.pos.inShow, false);
  assert.ok(end.staticAmount > 0.3 && end.staticAmount < 0.7, 'mid fade');
  assert.equal(at(SHOW_LEN_MIN + 5).staticAmount, 1);
  assert.equal(at(-60).staticAmount, 1, '8 PM still static');
  assert.equal(showPosition(21 * 60 - 1).inShow, false);
});

test('controls: speed, jump to the ending, and energy boost act live', () => {
  const t0 = Date.UTC(2026, 10, 25, 5, 0, 0);
  const c = createShowClock({now: t0});
  c.setSpeed(60, t0);
  assert.equal(Math.round((c.virtual(t0 + 60000) - t0) / 60000), 60, '1 real minute = 1 show hour');
  c.setSpeed(1, t0 + 60000);
  assert.equal(Math.round((c.virtual(t0 + 120000) - t0) / 60000), 61);
  c.jumpToShowMinute(SHOW_LEN_MIN + 1, t0 + 120000);
  const s = c.state(t0 + 120000);
  assert.equal(s.pos.inShow, false);
  assert.ok(s.staticAmount > 0.6);
  c.jumpToShowMinute(SHOW_PEAK_MIN, t0 + 120000);
  assert.ok(c.state(t0 + 120000).energy > 0.99, 'jumped forward to the next peak');
  c.setBoost(0.3);
  assert.ok(Math.abs(c.state(t0 + 120000).boostedEnergy - 1) < 1e-9);
  c.jumpToShowMinute(60, t0 + 120000);
  const b = c.state(t0 + 120000);
  assert.ok(Math.abs(b.boostedEnergy - (b.energy + 0.3)) < 1e-9);
  assert.equal(clampSpeed(0), 1); assert.equal(clampSpeed(1e6), 600);
  assert.equal(clampBoost(2), 0.5); assert.equal(clampBoost(-2), -0.5);
  assert.equal(crowdCount(0, 40), 3); assert.equal(crowdCount(1, 40), 40);
});

test('dancers never stand off a walkable surface, including climbers', () => {
  const crowd = createCrowd({seed: 7, cap: 40});
  for (let i = 0; i < 40; i++) crowd.add({stamina: i % 3 === 0 ? 1.35 : undefined, drive: i % 3 === 0 ? 0.9 : undefined, fatigue: i % 3 === 0 ? 0 : undefined});
  let checks = 0, climbedOn = new Set();
  run(crowd, 900, t => ({audio: 0.5 + 0.45 * Math.sin(t / 7), energy: 0.9}), () => {
    for (const d of crowd.dancers) {
      assert.ok(isSupported(map, d, 2), `dancer ${d.id} unsupported at ${d.x.toFixed(1)},${d.y.toFixed(1)} (${d.where} ${d.surface})`);
      if (d.where === 'floor') assert.ok(d.y > map.horizonY, 'floor feet below the horizon');
      if (d.where === 'on') climbedOn.add(d.surface);
      checks++;
    }
  });
  assert.ok(checks > 1000);
  assert.ok(climbedOn.has('stage'), 'someone got on stage');
  assert.ok(climbedOn.has('dome') || climbedOn.has('speakerL') || climbedOn.has('speakerR'), 'someone climbed: ' + [...climbedOn]);
  for (const m of crowd.markers()) {
    assert.equal(m.roam, true);
    assert.ok(m.projectedHeight >= map.minHeight && m.projectedHeight <= map.nearHeight);
  }
  assert.ok(heightAt(map, 600) > heightAt(map, 400), 'nearer is bigger');
});

test('dancer cap recycles the oldest', () => {
  const crowd = createCrowd({seed: 3, cap: 5});
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(crowd.add().id);
  const r = crowd.add();
  assert.equal(crowd.dancers.length, 5);
  assert.equal(r.removed, ids[0]);
  assert.ok(!crowd.dancers.some(d => d.id === ids[0]));
  for (let i = 0; i < 2000; i++) crowd.add();
  assert.equal(crowd.dancers.length, 5);
  assert.ok(crowd.nextId < 90001);
});

test('crowd packs toward the stage at high mic energy and relaxes after', () => {
  const meanDepth = c => c.dancers.filter(d => d.where === 'floor').reduce((a, d) => a + depthOf(map, d.y), 0) / Math.max(1, c.dancers.filter(d => d.where === 'floor').length);
  const crowd = createCrowd({seed: 11, cap: 36});
  for (let i = 0; i < 36; i++) crowd.add({stamina: 1.4, fatigue: 0, drive: 0.2});
  run(crowd, 120, {audio: 0.05, energy: 0.3});
  const calm = meanDepth(crowd);
  run(crowd, 60, {audio: 0.95, energy: 0.3});
  const loud = meanDepth(crowd);
  run(crowd, 120, {audio: 0.05, energy: 0.3});
  const after = meanDepth(crowd);
  assert.ok(loud < calm - 0.05, `loud ${loud.toFixed(3)} vs calm ${calm.toFixed(3)}`);
  assert.ok(after > loud + 0.03, `relaxed ${after.toFixed(3)} vs loud ${loud.toFixed(3)}`);
  assert.ok(stageAttraction(1, 0.5) > stageAttraction(0, 0.5));
  // Density falls off toward the back.
  const front = crowd.dancers.filter(d => d.where === 'floor' && depthOf(map, d.y) < 0.5).length;
  const back = crowd.dancers.filter(d => d.where === 'floor' && depthOf(map, d.y) >= 0.5).length;
  assert.ok(front > back, `front ${front} back ${back}`);
});

test('packed floor keeps personal space', () => {
  const crowd = createCrowd({seed: 5, cap: 40});
  for (let i = 0; i < 40; i++) crowd.add({stamina: 1.4, fatigue: 0, drive: 0.1});
  run(crowd, 180, {audio: 1, energy: 1});
  const floor = crowd.dancers.filter(d => d.where === 'floor');
  let overlaps = 0;
  for (let i = 0; i < floor.length; i++) for (let j = i + 1; j < floor.length; j++) {
    const a = floor[i], b = floor[j], h = Math.min(crowd.heightOf(a), crowd.heightOf(b));
    if (Math.hypot(a.x - b.x, (a.y - b.y) * 2) < 0.12 * h) overlaps++;
  }
  assert.ok(overlaps <= 2, 'overlaps ' + overlaps);
});

test('a fatigued dancer moves rearward, recovers, then returns forward', () => {
  const crowd = createCrowd({seed: 21, cap: 4});
  const {id} = crowd.add({x: 456, y: 395, stamina: 1, fatigue: 0.99, drive: 0.3});
  const d = crowd.dancers.find(q => q.id === id);
  run(crowd, 5, {audio: 0.9, energy: 0.9});
  assert.equal(d.resting, true);
  const startDepth = depthOf(map, d.y);
  let maxDepth = 0;
  for (let s = 0; s < 120 && d.resting; s++) { run(crowd, 1, {audio: 0.6, energy: 0.6}); maxDepth = Math.max(maxDepth, depthOf(map, d.y)); }
  assert.ok(maxDepth > startDepth + 0.35, `went back: ${startDepth.toFixed(2)} -> ${maxDepth.toFixed(2)}`);
  assert.equal(d.resting, false, 'recovered');
  const restedDepth = depthOf(map, d.y);
  let minDepth = 1;
  run(crowd, 60, {audio: 0.6, energy: 0.6}, () => { minDepth = Math.min(minDepth, depthOf(map, d.y)); });
  assert.ok(minDepth < restedDepth - 0.2, `came forward: ${restedDepth.toFixed(2)} -> ${minDepth.toFixed(2)}`);
  // Stamina is staggered across dancers.
  const many = createCrowd({seed: 2, cap: 30});
  for (let i = 0; i < 30; i++) many.add();
  const st = many.dancers.map(q => q.stamina);
  assert.ok(Math.max(...st) - Math.min(...st) > 0.4);
});

test('climbing is gated on stamina, drive and rest, grows with energy, and fatigue sends climbers down', () => {
  assert.equal(canClimb({stamina: 1.3, drive: 0.9, fatigue: 0.1, resting: false}), true);
  assert.equal(canClimb({stamina: 0.8, drive: 0.9, fatigue: 0.1, resting: false}), false);
  assert.equal(canClimb({stamina: 1.3, drive: 0.3, fatigue: 0.1, resting: false}), false);
  assert.equal(canClimb({stamina: 1.3, drive: 0.9, fatigue: 0.5, resting: false}), false);
  assert.equal(canClimb({stamina: 1.3, drive: 0.9, fatigue: 0.1, resting: true}), false);
  assert.ok(climbChance(1) > 5 * climbChance(0.2));
  const crowd = createCrowd({seed: 9, cap: 30});
  for (let i = 0; i < 30; i++) crowd.add({stamina: i < 10 ? 1.35 : 0.8, drive: i < 10 ? 0.9 : 0.9, fatigue: 0});
  const climbers = new Set();
  let downAfterTired = 0;
  const wasOn = new Map();
  run(crowd, 600, {audio: 0.7, energy: 0.95}, () => {
    for (const d of crowd.dancers) {
      if (d.where !== 'floor' && d.surface !== 'stage') {
        climbers.add(d.id);
        assert.ok(d.stamina >= 1.05, 'only high-stamina dancers climb');
        wasOn.set(d.id, d.fatigue);
      } else if (wasOn.has(d.id) && d.where === 'floor') { if (wasOn.get(d.id) >= CLIMB_DOWN_AT - 0.05) downAfterTired++; wasOn.delete(d.id); }
    }
  });
  assert.ok(climbers.size > 0, 'climbing happened');
  assert.ok(downAfterTired > 0, 'climbers came down once tired');
  // Low energy: rarer climbing.
  const lowC = createCrowd({seed: 9, cap: 30});
  for (let i = 0; i < 30; i++) lowC.add({stamina: 1.35, drive: 0.9, fatigue: 0});
  const lowSet = new Set();
  run(lowC, 600, {audio: 0.1, energy: 0.1}, () => { for (const d of lowC.dancers) if (d.where !== 'floor' && d.surface !== 'stage') lowSet.add(d.id); });
  const highC = createCrowd({seed: 9, cap: 30});
  for (let i = 0; i < 30; i++) highC.add({stamina: 1.35, drive: 0.9, fatigue: 0});
  const highSet = new Set();
  run(highC, 600, {audio: 0.9, energy: 0.95}, () => { for (const d of highC.dancers) if (d.where !== 'floor' && d.surface !== 'stage') highSet.add(d.id); });
  assert.ok(highSet.size > lowSet.size, `high ${highSet.size} low ${lowSet.size}`);
});

test('demo adds one dancer per person-scan pause (visit), not while the person stays', () => {
  const trig = createDemoTrigger({clearMs: 1500, cooldownMs: 3000});
  let fired = 0, t = 0;
  const tick = (present, ms) => { for (let i = 0; i < ms / 400; i++) { t += 400; if (trig.observe({present, now: t}).add) fired++; } };
  tick(false, 4000);
  assert.equal(fired, 0);
  tick(true, 5000);
  assert.equal(fired, 0, 'nothing while the person is in frame');
  tick(false, 2400);
  assert.equal(fired, 1, 'one dancer after the floor clears');
  tick(false, 8000);
  assert.equal(fired, 1);
  tick(true, 1200); tick(false, 2400);
  assert.equal(fired, 2);
});

test('the show and demo pages are built and do not touch the live page', async () => {
  const {readFile} = await import('node:fs/promises');
  const live = await readFile(new URL('../dist/assets/neural-dance/live/index.html', import.meta.url), 'utf8');
  assert.ok(!live.includes('crowd-page.js'));
  for (const mode of ['demo', 'show']) {
    const html = await readFile(new URL(`../dist/assets/neural-dance/${mode}/index.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('data-nd-crowd="' + mode + '"'));
    assert.ok(html.includes('/neural-dance/crowd-page.js'));
  }
});

test('roaming and climbing dancers keep human proportions in the live renderer (no stretched legs or necks)', async () => {
  const {createSilhouetteShow} = await import('../neural-dance/src/silhouette.js');
  const ctx = new Proxy({canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }},
    {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const crowd = createCrowd({seed: 9, cap: 10});
  for (let i = 0; i < 10; i++) crowd.add({stamina: i < 7 ? 1.35 : 0.9, drive: 0.9, fatigue: 0});
  const fps = 6; let t = 0, bad = 0, frames = 0; const where = new Set();
  for (let i = 0; i < fps * 70; i++) {
    t += 1 / fps; const now = 1000 + t * 1000;
    crowd.step(1 / fps, {audio: 0.8, energy: 0.95});
    if (i % 3 === 0) show.beat(now, 3);
    const markers = crowd.markers();
    show.paint(ctx, markers, {now, levels: [0.8, 0.8, 0.6, 0.5], network: markers.map(m => ({id: m.id, received: 0.7})), songOpen: true, xy: (x, y) => ({x, y})});
    for (const fr of show.figureHeights()) {
      const j = fr.joints; if (!j || !j.groin) continue;
      const d = crowd.dancers.find(q => q.rid === fr.id); if (d) where.add(d.where);
      const leg = (Math.max(fr.footL.y, fr.footR.y) - j.groin.y) / fr.height, neck = (j.groin.y - fr.crown.y) / fr.height;
      frames++;
      if (Math.abs(leg - 0.5) > 0.35 || Math.abs(neck - 0.5) > 0.35) bad++;
    }
  }
  assert.ok(frames > 3000);
  assert.ok(where.has('climb') || where.has('on'), 'covered climbing');
  assert.equal(bad, 0, 'stretched frames ' + bad);
});

// ---- white capture, remote, events and effects (TJ Nov 24, 12:31-12:51 AM PT)
import {createCaptureScheduler, createDropDetector, CAPTURE_MIN_GAP_MIN, CAPTURE_GRACE_MIN} from '../neural-dance/src/crowd-capture.js';
import {createEventDirector, eventNames, eventModule, registerEvent} from '../neural-dance/src/crowd-events.js';
import {fxNames, createFxLayer} from '../neural-dance/src/crowd-fx.js';
import {sanitizeDebugPatch, CROWD_EVENTS, CROWD_EFFECTS, CROWD_TEXT_MAX} from '../neural-dance/debug-protocol.js';
import {captureName, debugAction} from '../worker/neural-dance-debug.mjs';

const MINUTE = 60000;

test('white capture: hard 20 min cooldown, waits for a drop, forces by 30 min, manual override warns', () => {
  const t0 = Date.UTC(2026, 10, 25, 6, 0, 0);
  const cap = createCaptureScheduler({lastAt: t0});
  // A drop build inside the cooldown never starts a capture.
  for (let m = 0; m < CAPTURE_MIN_GAP_MIN; m += 0.5) assert.equal(cap.step(t0 + m * MINUTE, {building: true, drop: m % 2 === 0}), null, 'no auto capture at ' + m + ' min');
  // Manual trigger inside the cooldown: warning first, override allowed.
  const warn = cap.request(t0 + 5 * MINUTE);
  assert.equal(warn.ok, false); assert.equal(warn.warning, 'cooldown'); assert.equal(warn.remainingMin, 15);
  const forced = cap.request(t0 + 5 * MINUTE, {force: true});
  assert.ok(forced.ok && forced.overrode);
  let t = t0 + 5 * MINUTE;
  let act = null;
  for (let i = 0; i < 100 && act !== 'go-white'; i++) { t += 100; act = cap.step(t, {}); }
  assert.equal(act, 'go-white');
  cap.finished(t, true);
  assert.equal(cap.state().count, 1);
  // Cooldown restarts from that capture.
  assert.ok(cap.cooldownLeftMs(t + MINUTE) > 18 * MINUTE);
  // After 20 min with a building breakdown: visuals start, white lands on the drop.
  const due = t + CAPTURE_MIN_GAP_MIN * MINUTE;
  assert.equal(cap.state().phase, 'fade');
  for (let s = 1; s <= 10; s++) cap.step(t + s * 1000, {}); // visuals ease back
  assert.equal(cap.state().phase, 'idle');
  assert.equal(cap.step(due - 1000, {building: true}), null, 'still inside the 20 min minimum');
  assert.equal(cap.step(due + 1000, {building: true}), 'start-build');
  assert.equal(cap.step(due + 3000, {building: true}), null, 'holds while the build continues');
  assert.equal(cap.step(due + 5000, {drop: true}), 'go-white', 'white on the drop');
  cap.finished(due + 6000, true);
  // No drop at all: forced at interval + grace (30 min), not before.
  const last = due + 6000;
  for (let s = 7; s < 20; s++) cap.step(last + s * 1000, {});
  assert.equal(cap.step(last + (CAPTURE_MIN_GAP_MIN + CAPTURE_GRACE_MIN) * MINUTE - 1000, {}), null);
  assert.equal(cap.step(last + (CAPTURE_MIN_GAP_MIN + CAPTURE_GRACE_MIN) * MINUTE + 1000, {}), 'start-build');
  // Interval can be raised from the remote but never below 20 min.
  assert.equal(cap.setInterval(5), CAPTURE_MIN_GAP_MIN);
  assert.equal(cap.setInterval(45), 45);
});

test('drop detector: a bass breakdown builds, the bass coming back is the drop', () => {
  const det = createDropDetector();
  let t = 0, built = false, dropAt = -1;
  const feed = (sec, bass) => { for (let i = 0; i < sec * 10; i++) { t += 100; const r = det.step(t, bass); if (r.building) built = true; if (r.drop && dropAt < 0) dropAt = t; } };
  feed(30, 0.8);     // loud section
  assert.equal(built, false);
  feed(8, 0.08);     // breakdown / build
  assert.equal(built, true);
  assert.equal(dropAt, -1);
  const dropStart = t;
  feed(2, 0.9);      // drop
  assert.ok(dropAt > dropStart && dropAt - dropStart < 1500, 'drop detected within 1.5 s');
});

test('remote commands are allowlisted and typed text is sanitized and length-limited', () => {
  assert.deepEqual(sanitizeDebugPatch({action: 'crowd', op: 'event', name: 'conga'}), {action: 'crowd', op: 'event', name: 'conga'});
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'event', name: 'drop-table'}), null);
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'rm -rf'}), null);
  const long = sanitizeDebugPatch({action: 'crowd', op: 'effect', name: 'message', text: '<script>alert(1)</script>' + 'x'.repeat(300)});
  assert.ok(long.text.length <= CROWD_TEXT_MAX && !/[<>]/.test(long.text));
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'speed', value: 1e9}).value, 600);
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'boost', value: -9}).value, -0.5);
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'capture', force: 'yes'}).force, undefined);
  assert.equal(sanitizeDebugPatch({action: 'crowd', op: 'capture', force: true}).force, true);
  // Every remote button has a module on the projector.
  for (const name of CROWD_EVENTS) assert.ok(eventModule(name), 'event ' + name);
  for (const name of CROWD_EFFECTS.filter(n => n !== 'clear-effects')) assert.ok(fxNames().includes(name), 'effect ' + name);
  assert.equal(debugAction('/api/neural-dance/debug/crowd'), 'crowd');
  assert.equal(captureName(Date.UTC(2026, 10, 25, 11, 20, 5)), 'nd-white-2026-11-25_032005-PT.jpg');
});

test('rare events: rare, cooldown-limited, energy-gated, and dancers stay on walkable surfaces', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const crowd = createCrowd({map, cap: 40, seed: 3});
  for (let i = 0; i < 40; i++) crowd.add();
  const director = createEventDirector({rnd});
  const started = [];
  // Low energy for 20 minutes: nothing with a high threshold fires.
  for (let i = 0; i < 20 * 600; i++) {
    crowd.step(0.1, {audio: 0.1, energy: 0.1});
    const before = director.state().recent.length;
    director.step(crowd, map, 0.1, 0.1, 0.1);
    if (director.state().recent.length > before) started.push({name: director.state().recent[0].name, t: crowd.t});
  }
  for (const s of started) assert.ok(eventModule(s.name).minEnergy <= 0.1 + 1e-9, s.name + ' fired at low energy');
  // Peak energy for an hour: events happen, spaced by the global gap and per-event cooldown.
  const peak = [];
  for (let i = 0; i < 60 * 600; i++) {
    crowd.step(0.1, {audio: 0.9, energy: 0.95});
    const before = director.state().recent[0];
    director.step(crowd, map, 0.1, 0.95, 0.9);
    const now = director.state().recent[0];
    if (now && now !== before) peak.push({name: now.name, t: crowd.t});
    for (const d of crowd.dancers) assert.ok(crowd.onSolid(d) || d.where !== 'floor', 'off floor during events');
  }
  assert.ok(peak.length >= 3 && peak.length <= 50, 'rare but present: ' + peak.length);
  for (let i = 1; i < peak.length; i++) assert.ok(peak[i].t - peak[i - 1].t >= 75 - 1e-6, 'global gap');
  const byName = {};
  for (const p of peak) { if (byName[p.name] != null) assert.ok(p.t - byName[p.name] >= eventModule(p.name).cooldownS - 1e-6, p.name + ' cooldown'); byName[p.name] = p.t; }
  // Manual triggers report why when they cannot run (a map without the pole).
  assert.match(director.trigger('pole-spin', crowd, {...map, surfaces: map.surfaces.filter(s => s.id !== 'pole')}).reason, /pole/);
  // Registry accepts new modules by name (hot-update follow-up).
  registerEvent({name: 'test-wave', start: () => ({}), step: () => false});
  assert.ok(eventNames().includes('test-wave'));
});

test('freeze and slow-mo scale crowd time; clear-effects resets', () => {
  const fx = createFxLayer(null);
  assert.equal(fx.timeScale(), 1);
  fx.start('slow-mo', {}, 0); assert.equal(fx.timeScale(), 0.3);
  fx.start('freeze', {}, 0); assert.equal(fx.timeScale(), 0);
  fx.start('clear-effects'); assert.equal(fx.timeScale(), 1);
  assert.equal(fx.start('not-real').ok, false);
});

test('remote pages are built, private and never carry a key', async () => {
  const {readFile} = await import('node:fs/promises');
  for (const mode of ['show', 'demo']) {
    const html = await readFile(new URL('../dist/assets/neural-dance/' + mode + '/control/index.html', import.meta.url), 'utf8');
    assert.match(html, /crowd-remote\.js/);
    assert.match(html, /noindex/);
    assert.match(html, /no-referrer/);
    assert.doesNotMatch(html, /#k=|ND_DEBUG_KEY|key=[A-Za-z0-9]/);
  }
});

test('white-capture stills are stored privately in the studio room and survive the idle alarm', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const {NeuralDanceDebugRoom, handleNeuralDanceDebug} = await import('../worker/neural-dance-debug.mjs');
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...p) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...p) : (st.run(...p), []); return {toArray: () => rows}; }};
  const ctx = {storage: {sql, setAlarm: () => Promise.resolve()}, blockConcurrencyWhile: fn => Promise.resolve(fn()), acceptWebSocket() {}, getWebSockets: () => [], getTags: () => []};
  const KEY = 'studio-key-correct-value';
  const env = {ND_DEBUG_KEY: KEY};
  const room = new NeuralDanceDebugRoom(ctx, env);
  env.NEURAL_DANCE_DEBUG = {getByName: () => ({fetch: r => room.fetch(r)})};
  const call = (path, init, key = KEY, role = '') => handleNeuralDanceDebug(new Request('https://tjm.art/api/neural-dance/debug/' + path + (path.includes('?') ? '&' : '?') + 'room=studio&key=' + key + (role ? '&role=' + role : ''), init), env);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from('\xff\xd8\xff fake jpeg bytes \xff\xd9', 'latin1').toString('base64');
  const takenAt = Date.now() - 60000;
  assert.equal((await call('capture', {method: 'POST', body: JSON.stringify({jpeg, takenAt})}, 'wrong-key-value-here', 'publisher')).status, 403);
  const saved = await (await call('capture', {method: 'POST', body: JSON.stringify({jpeg, takenAt, meta: {trigger: 'drop'}})}, KEY, 'publisher')).json();
  assert.equal(saved.name, captureName(takenAt));
  await room.alarm();
  const list = await (await call('captures', {}, KEY)).json();
  assert.equal(list.count, 1);
  assert.equal(list.captures[0].meta.trigger, 'drop');
  const img = await call('capture.jpg?name=' + saved.name, {}, KEY);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /private/);
  assert.equal((await call('captures', {}, 'wrong-key-value-here')).status, 403);
  // Crowd status for the remote: small, no JPEGs.
  await call('frame', {method: 'POST', body: JSON.stringify({type: 'frame', publisherId: 'pub-crowd-test-1', telemetry: {t: Date.now(), crowd: {mode: 'show', dancers: 12}}})}, KEY, 'publisher');
  const status = await (await call('crowd', {}, KEY)).json();
  assert.equal(status.crowd.dancers, 12);
  assert.equal(status.cameraJpeg, undefined);
});
