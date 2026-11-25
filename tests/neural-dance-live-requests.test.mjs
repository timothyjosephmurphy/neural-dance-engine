// Live requests + hot updates for the crowd show (Paradise Dystopia, Nov 27).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrowd, canClimb} from '../neural-dance/src/crowd-sim.js';
import {CROWD_SURFACES, isSupported, surfaceById} from '../neural-dance/src/crowd-surfaces.js';
import {createEventDirector} from '../neural-dance/src/crowd-events.js';
import {applyQueueOp, claimNext, contentBlocked, finishRequest, newQueueState, parseXRecent, publicQueue, queueEtas, recordBuild, requestEnergyBoost, submitRequest, xSearchQuery, PLAYING_STALE_S} from '../neural-dance/src/crowd-requests.js';
import {moveFrame, normalizeMove, parseMoveText, stingNotes, PRIMITIVES} from '../neural-dance/src/crowd-moves.js';
import {CLEAR_RADIUS, createDebutDirector, crystalCharge} from '../neural-dance/src/crowd-live.js';
import {allowedHot, hotPlan, hotUrl, restoreCrowd, serializeCrowd} from '../neural-dance/src/crowd-hot.js';
import {createCaptureScheduler, PSY_STYLES, pickPsyStyle} from '../neural-dance/src/crowd-capture.js';
import {PSY_DRAW} from '../neural-dance/src/crowd-fx.js';
import {applyRoamMove} from '../neural-dance/src/silhouette.js';
import {pollX, replyX} from '../worker/neural-dance-x.mjs';
import {sanitizeCrowdCommand} from '../neural-dance/debug-protocol.js';

const map = CROWD_SURFACES;
const climber = {stamina: 1.4, drive: 0.95, fatigue: 0};
const solid = (crowd) => { for (const d of crowd.dancers) assert.ok(isSupported(map, d, 2), 'unsupported ' + d.where + ' ' + d.surface + ' ' + d.x.toFixed(1) + ',' + d.y.toFixed(1)); };

test('pole (left), cage (right) and rope are climbable above the horizon', () => {
  const pole = surfaceById(map, 'pole'), cage = surfaceById(map, 'cage'), rope = surfaceById(map, 'rope');
  assert.ok(pole && cage && rope);
  assert.ok(pole.poly[0][0] < 205 && cage.poly[0][0] > 708, 'pole left of the left speaker, cage right of the right one');
  assert.ok(Math.min(...pole.poly.map(p => p[1])) < map.horizonY && Math.min(...cage.poly.map(p => p[1])) < map.horizonY);
  assert.ok(rope.anchor[1] < map.horizonY);
});

test('pole spin, cage shake and rope swing use gated climbers and keep them on solid surfaces', () => {
  for (const [name, surface] of [['pole-spin', 'pole'], ['cage-shake', 'cage'], ['rope-swing', 'rope']]) {
    const crowd = createCrowd({map, cap: 20, seed: 11});
    // Only tired / low-stamina dancers: nobody may go up.
    for (let i = 0; i < 8; i++) crowd.add({stamina: 0.7, drive: 0.2, fatigue: 0.5});
    const dir = createEventDirector({auto: false});
    assert.equal(dir.trigger(name, crowd, map).ok, false, name + ' with nobody eligible');
    const star = crowd.add({...climber, x: surface === 'cage' ? 800 : surface === 'pole' ? 160 : 450, y: 470});
    const d = crowd.dancers.find(x => x.id === star.id);
    assert.ok(canClimb(d));
    assert.equal(dir.trigger(name, crowd, map).ok, true, name);
    let reached = false, swung = false;
    for (let i = 0; i < 900; i++) {
      crowd.step(0.1, {audio: 0.8, energy: 0.8});
      dir.step(crowd, map, 0.1, 0.8, 0.8);
      solid(crowd);
      if (d.where === 'on' && (d.surface === surface || (surface === 'rope' && d.surface === 'dome'))) reached = true;
      if (d.surface === 'rope') swung = true;
      for (const o of crowd.dancers) if (o !== d) assert.ok(o.where === 'floor' || o.surface === 'stage', 'only the gated climber went up past the stage');
    }
    assert.ok(reached, name + ' climber arrived');
    if (surface === 'rope') assert.ok(swung, 'rope swung');
  }
});

test('queue: FIFO, approval toggle, filter in both modes, one per handle plus cooldown', () => {
  const st = newQueueState();
  let now = 1_800_000_000_000;
  const a = submitRequest(st, {source: 'x', handle: 'alice', text: 'hop left then clap'}, now);
  assert.equal(a.item.status, 'pending');
  assert.equal(submitRequest(st, {source: 'x', handle: '@Alice', text: 'spin'}, now + 1000).reason, 'already in line');
  const bad = submitRequest(st, {source: 'x', handle: 'troll', text: 'f u c k this, sh1t'}, now);
  assert.equal(bad.ok, false); assert.equal(bad.item.status, 'blocked');
  assert.equal(contentBlocked('order a cocktail and do the analog robot'), '');
  // Approve -> queued; approval OFF -> straight through, filter still on.
  assert.equal(applyQueueOp(st, 'approve', {id: a.item.id}, now).ok, true);
  applyQueueOp(st, 'settings', {approval: false, cooldownS: 60}, now);
  const b = submitRequest(st, {source: 'x', handle: 'bob', text: 'raise the roof'}, now + 10);
  assert.equal(b.item.status, 'queued');
  assert.equal(submitRequest(st, {source: 'x', handle: 'carl', text: 'n1gg3r'}, now).item.status, 'blocked');
  // Cooldown applies after the handle's request is done.
  const first = claimNext(st, now + 20);
  assert.equal(first.id, a.item.id, 'FIFO');
  assert.equal(claimNext(st, now + 21), null, 'one on the floor at a time');
  finishRequest(st, first.id, now + 30000, 'm1');
  const again = submitRequest(st, {source: 'x', handle: 'alice', text: 'jump'}, now + 31000);
  assert.equal(again.reason, 'cooldown');
  assert.ok(again.remainingS > 0 && again.remainingS <= 60);
  assert.equal(submitRequest(st, {source: 'x', handle: 'alice', text: 'jump'}, now + 61000).ok, true);
  // TJ's paste box: trusted, no limits, still filtered.
  assert.equal(submitRequest(st, {source: 'remote', handle: 'tj', text: 'spin'}, now + 61001, {trusted: true}).ok, true);
  assert.equal(submitRequest(st, {source: 'remote', handle: 'tj', text: 'spin again'}, now + 61002, {trusted: true}).ok, true);
  assert.equal(submitRequest(st, {source: 'remote', handle: 'tj', text: 'porn'}, now + 61003, {trusted: true}).ok, false);
  // ETAs rise along the line; skip and kill.
  const etas = queueEtas(st, now + 62000);
  const line = st.items.filter(i => i.status === 'queued');
  for (let i = 1; i < line.length; i++) assert.ok(etas[line[i].id] > etas[line[i - 1].id]);
  assert.equal(applyQueueOp(st, 'skip', {id: line[0].id}, now).ok, true);
  assert.equal(applyQueueOp(st, 'kill', {id: line[1].id}, now).ok, true);
  // A playing request the projector never finished times out.
  const p = claimNext(st, now + 70000);
  assert.ok(p);
  assert.ok(claimNext(st, now + 70000 + (PLAYING_STALE_S + 1) * 1000));
  // Turning approval back on parks new ones; turning it off releases them.
  applyQueueOp(st, 'settings', {approval: true, cooldownS: 0}, now);
  const w = submitRequest(st, {source: 'x', handle: 'dee', text: 'wave'}, now + 80000);
  assert.equal(w.item.status, 'pending');
  applyQueueOp(st, 'settings', {approval: false}, now);
  assert.equal(st.items.find(i => i.id === w.item.id).status, 'queued');
  const view = publicQueue(st, now + 80000);
  assert.ok(view.items.length && view.settings && Number.isFinite(view.boost));
});

test('request volume lifts crowd energy, capped', () => {
  assert.equal(requestEnergyBoost(0), 0);
  let prev = 0;
  for (let v = 1; v < 40; v++) { const b = requestEnergyBoost(v); assert.ok(b >= prev && b <= 0.25); prev = b; }
  assert.ok(requestEnergyBoost(10) > 0.15);
});

test('move text -> program from existing primitives, deterministic, always something', () => {
  const a = parseMoveText('hop left, then clap twice and raise the roof', {handle: '@a'});
  const b = parseMoveText('hop left, then clap twice and raise the roof', {handle: '@a'});
  assert.deepEqual(a, b);
  assert.ok(a.matched);
  const prims = a.steps.map(s => s.p);
  assert.ok(prims.includes('hop') && prims.includes('clap') && prims.includes('arms-up'), prims.join(','));
  const odd = parseMoveText('zxqv blorp', {handle: '@b'});
  assert.equal(odd.matched, false);
  assert.ok(odd.steps.length >= 2 && odd.steps.every(s => PRIMITIVES.includes(s.p)));
  for (const prog of [a, odd]) for (let x = 0; x < prog.beats * 2; x += 0.05) {
    const f = moveFrame(prog, x);
    assert.ok(Math.abs(f.dx) <= 0.3 && f.lift >= 0 && f.lift <= 0.2, 'bounded');
    for (const k of ['squat', 'armRaise', 'armForward', 'clap', 'clapOh', 'tall']) assert.ok(f[k] >= 0 && f[k] <= 1, k);
  }
  assert.notDeepEqual(stingNotes(a).notes, stingNotes(odd).notes, 'unique sting per move');
  assert.equal(normalizeMove({steps: 'x'}), null);
  assert.equal(normalizeMove({name: '<b>x</b>', steps: [{p: 'evil', beats: 99}]}).steps[0].p, 'sway');
  const posed = applyRoamMove({roam: true, move: {squat: 0.9, armRaise: 1, armForward: 0, clap: 0, clapOh: 0, tall: 0}}, {squat: 0.1, armLift: 0.2});
  assert.equal(posed.squat, 0.9); assert.equal(posed.armLift, 1);
  assert.deepEqual(applyRoamMove({roam: false}, {squat: 0.1}), {squat: 0.1});
});

test('debut: crowd parts front-centre, one dancer performs twice, then melts back', () => {
  const crowd = createCrowd({map, cap: 40, seed: 5});
  for (let i = 0; i < 30; i++) crowd.add({y: 480 + (i % 6) * 22, x: 300 + (i * 37) % 320});
  for (let i = 0; i < 200; i++) crowd.step(0.1, {audio: 0.7, energy: 0.8});
  const debut = createDebutDirector();
  const prog = parseMoveText('spin and clap', {handle: '@zoe'});
  assert.ok(debut.start({id: 1, handle: '@zoe'}, prog, crowd, map));
  const d = debut.run().d, at = debut.run().at;
  let phase = '', performed = 0, clearOk = 0, clearSamples = 0, res;
  for (let i = 0; i < 1200 && res !== 'done'; i++) {
    crowd.step(0.05, {audio: 0.7, energy: 0.8});
    res = debut.step(crowd, map, 0.05, 120);
    if (res === 'perform') {
      performed += 0.05;
      assert.ok(d.move, 'featured dancer carries the move');
      if (performed > 3) { clearSamples++; if (crowd.dancers.every(o => o === d || o.where !== 'floor' || Math.hypot(o.x - at.x, (o.y - at.y) * 1.6) > CLEAR_RADIUS * 0.75)) clearOk++; }
    }
    phase = res || phase;
    solid(crowd);
  }
  assert.equal(res, 'done');
  // 2 runs at 120 BPM.
  assert.ok(Math.abs(performed - prog.beats * 2 / 2) < 0.6, 'performed ' + performed.toFixed(2) + ' s');
  assert.ok(clearOk / clearSamples > 0.8, 'space stayed clear ' + clearOk + '/' + clearSamples);
  assert.equal(d.move, null); assert.equal(d.featured, false);
  assert.ok(at.y > 520 && Math.abs(at.x - 456) < 5, 'front-centre nearest the screen');
});

test('ETA crystal charges toward its ETA without numbers', () => {
  assert.equal(crystalCharge({at: 0, eta: 10000}, 0), 0);
  assert.ok(Math.abs(crystalCharge({at: 0, eta: 10000}, 5000) - 0.5) < 1e-9);
  assert.equal(crystalCharge({at: 0, eta: 10000}, 20000), 1);
});

test('hot updates: hot-load vs seamless reload; rollback pin; crowd restore', () => {
  const cur = {version: 'a', core: 'c1', hot: {moves: 'h1'}};
  assert.equal(hotPlan(cur, {...cur}).kind, 'none');
  assert.deepEqual(hotPlan(cur, {version: 'a', core: 'c1', hot: {moves: 'h2', conga2: 'h9'}}), {kind: 'hot', load: ['moves', 'conga2']});
  assert.equal(hotPlan(cur, {version: 'b', core: 'c2', hot: {moves: 'h1'}}).kind, 'reload');
  assert.equal(hotPlan(cur, {version: 'b', core: 'c1', hot: {moves: 'h1'}}).kind, 'quiet');
  assert.deepEqual(allowedHot({moves: 'h2', conga2: 'h9', keep: 'k'}, {hot: {moves: 'h1', keep: 'k'}}), {keep: 'k'});
  assert.deepEqual(allowedHot({moves: 'h2'}, null), {moves: 'h2'});
  assert.throws(() => hotUrl('../x', 'h'));
  assert.equal(hotUrl('starter-moves', 'abc'), '/neural-dance/hot/starter-moves.js?v=abc');
  const crowd = createCrowd({map, cap: 30, seed: 2});
  for (let i = 0; i < 12; i++) crowd.add();
  for (let i = 0; i < 300; i++) crowd.step(0.1, {audio: 0.6, energy: 0.6});
  const snap = JSON.parse(JSON.stringify(serializeCrowd(crowd)));
  const next = createCrowd({map, cap: 30, seed: 9});
  assert.ok(restoreCrowd(next, snap));
  assert.equal(next.dancers.length, crowd.dancers.filter(d => !d.leaving).length);
  for (let i = 0; i < 100; i++) { next.step(0.1, {audio: 0.5, energy: 0.5}); solid(next); }
  assert.equal(restoreCrowd(next, {...snap, at: Date.now() - 600000}), false, 'stale snapshot ignored');
  // Builds and pin in the queue state.
  const st = newQueueState();
  recordBuild(st, {version: 'v1', core: 'c', hot: {moves: 'h1'}});
  assert.equal(applyQueueOp(st, 'pin', {}).pin.version, 'base', 'no earlier build: pin to base');
  recordBuild(st, {version: 'v1', core: 'c', hot: {moves: 'h2'}});
  const pin = applyQueueOp(st, 'pin', {});
  assert.deepEqual(pin.pin.hot, {moves: 'h1'});
  applyQueueOp(st, 'unpin', {});
  assert.equal(st.pin, null);
});

test('white capture: trip style varies per run, all six, never twice in a row', () => {
  assert.deepEqual([...PSY_STYLES].sort(), ['ayahuasca', 'dmt', 'ketamine', 'lsd', 'mescaline', 'mushrooms']);
  for (const s of PSY_STYLES) assert.equal(typeof PSY_DRAW[s], 'function');
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cap = createCaptureScheduler({now: 0, lastAt: 0, rnd, lastStyle: 'dmt'});
  const seen = [];
  for (let i = 0; i < 120; i++) {
    const t = i * 3600000;
    assert.equal(cap.request(t, {force: true}).ok, true);
    seen.push(cap.state().style);
    cap.finished(t + 1000, true);
    cap.step(t + 60000, {});
  }
  assert.notEqual(seen[0], 'dmt', 'differs from the last saved style');
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  assert.equal(new Set(seen).size, 6);
  for (let i = 0; i < 50; i++) assert.notEqual(pickPsyStyle('lsd'), 'lsd');
});

test('remote crowd ops allowlist includes the new controls', () => {
  for (const op of ['props', 'debut-kill', 'requests-now', 'hot-check']) assert.deepEqual(sanitizeCrowdCommand({action: 'crowd', op}), {action: 'crowd', op});
  assert.equal(sanitizeCrowdCommand({action: 'crowd', op: 'eval'}), null);
});

const SEARCH_FIXTURE = {
  data: [
    {id: '1900000000000000002', text: '@TJ_de_la_playa do a robot then jump twice #ParadiseDystopia', author_id: 'u1', created_at: '2026-11-28T05:10:00.000Z'},
    {id: '1900000000000000001', text: 'RT @someone: hop', author_id: 'u2', created_at: '2026-11-28T05:09:00.000Z'},
    {id: '1900000000000000003', text: 'my own post #ParadiseDystopia', author_id: 'u3', created_at: '2026-11-28T05:11:00.000Z'},
    {id: '1900000000000000004', text: '#ParadiseDystopia shimmy left and clap', author_id: 'u4', created_at: '2026-11-28T05:12:00.000Z'}
  ],
  includes: {users: [{id: 'u1', username: 'ravefan'}, {id: 'u2', username: 'rter'}, {id: 'u3', username: 'TJ_de_la_playa'}, {id: 'u4', username: 'dancer2'}]},
  meta: {newest_id: '1900000000000000004'}
};

test('X intake (flagged, fixtures): mentions and the tag become queued requests; no creds = no calls', async () => {
  assert.match(xSearchQuery(), /@TJ_de_la_playa OR #ParadiseDystopia/);
  const parsed = parseXRecent(SEARCH_FIXTURE);
  assert.deepEqual(parsed.map(p => p.handle), ['ravefan', 'dancer2']);
  assert.ok(!/@TJ_de_la_playa/i.test(parsed[0].text));
  const st = newQueueState();
  let calls = 0;
  const fakeFetch = async (url, init) => { calls++; assert.match(String(url), /tweets\/search\/recent/); assert.match(init.headers.authorization, /^Bearer /); return {ok: true, status: 200, json: async () => SEARCH_FIXTURE}; };
  assert.equal((await pollX(st, {X_BEARER_TOKEN: 't'}, Date.now(), fakeFetch)).reason, 'off', 'flag defaults off');
  applyQueueOp(st, 'settings', {xIntake: true});
  assert.equal((await pollX(st, {}, Date.now(), fakeFetch)).reason, 'no credentials');
  assert.equal(calls, 0);
  const got = await pollX(st, {X_BEARER_TOKEN: 't'}, Date.now(), fakeFetch);
  assert.equal(got.added, 2);
  assert.equal(st.xSinceId, '1900000000000000004');
  assert.ok(st.items.every(i => i.source === 'x' && i.status === 'pending' && i.xId));
  // Same tweets again are not queued twice.
  st.xLastPollAt = 0;
  assert.equal((await pollX(st, {X_BEARER_TOKEN: 't'}, Date.now(), fakeFetch)).added, 0);
  // Replies: own flag + write token.
  const item = st.items[0];
  assert.equal((await replyX(st, item, {name: 'Robot Jump'}, {X_USER_ACCESS_TOKEN: 'w'}, fakeFetch)).reason, 'off');
  applyQueueOp(st, 'settings', {xReply: true});
  assert.equal((await replyX(st, item, {name: 'Robot Jump'}, {}, fakeFetch)).reason, 'no credentials');
  let posted = null;
  const postFetch = async (url, init) => { posted = JSON.parse(init.body); return {ok: true, status: 201}; };
  assert.equal((await replyX(st, item, {name: 'Robot Jump'}, {X_USER_ACCESS_TOKEN: 'w'}, postFetch)).sent, true);
  assert.equal(posted.reply.in_reply_to_tweet_id, item.xId);
  assert.match(posted.text, /^@ravefan /);
});

test('studio room /requests: remote queues, projector claims and finishes, library persists past the idle alarm', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const {NeuralDanceDebugRoom, handleNeuralDanceDebug, debugAction} = await import('../worker/neural-dance-debug.mjs');
  assert.equal(debugAction('/api/neural-dance/debug/requests'), 'requests');
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...p) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...p) : (st.run(...p), []); return {toArray: () => rows}; }};
  const ctx = {storage: {sql, setAlarm: () => Promise.resolve()}, blockConcurrencyWhile: fn => Promise.resolve(fn()), acceptWebSocket() {}, getWebSockets: () => [], getTags: () => []};
  const KEY = 'studio-key-correct-value';
  const env = {ND_DEBUG_KEY: KEY};
  const room = new NeuralDanceDebugRoom(ctx, env);
  env.NEURAL_DANCE_DEBUG = {getByName: () => ({fetch: r => room.fetch(r)})};
  const call = (body, role = '', key = KEY) => handleNeuralDanceDebug(new Request('https://tjm.art/api/neural-dance/debug/requests?room=studio&key=' + key + (role ? '&role=' + role : ''), body ? {method: 'POST', body: JSON.stringify(body)} : {}), env);
  assert.equal((await call(null, '', 'wrong-key-value-here')).status, 403);
  const sub = await (await call({op: 'submit', handle: '@tj', text: 'spin and clap'})).json();
  assert.equal(sub.result.ok, true);
  assert.equal(sub.result.item.status, 'queued', 'paste box skips approval');
  assert.equal(sub.x.read, false); assert.equal(sub.x.write, false);
  // The projector cannot change settings; the remote cannot claim.
  assert.equal((await (await call({op: 'settings', approval: false}, 'publisher')).json()).result.ok, false);
  assert.equal((await (await call({op: 'claim'})).json()).result.ok, false);
  await call({op: 'build', build: {version: 'v1', core: 'c1', hot: {'starter-moves': 'h1'}}}, 'publisher');
  const claim = await (await call({op: 'claim'}, 'publisher')).json();
  assert.equal(claim.result.item.text, 'spin and clap');
  const move = parseMoveText('spin and clap', {handle: '@tj'});
  const fin = await (await call({op: 'finish', id: claim.result.item.id, move}, 'publisher')).json();
  assert.equal(fin.result.ok, true);
  await room.alarm();
  const after = await (await call(null)).json();
  assert.equal(after.library.length, 1);
  assert.equal(after.library[0].id, move.id);
  assert.equal(after.queue.items[0].status, 'done');
  assert.equal(after.queue.builds.length, 1);
  const pin = await (await call({op: 'pin'})).json();
  assert.equal(pin.queue.pin.version, 'base');
  await call({op: 'library-remove', id: move.id});
  assert.equal((await (await call(null)).json()).library.length, 0);
});

test('build manifest lists hot modules and a core hash', async () => {
  const {hotManifest} = await import('../scripts/build-pages.mjs');
  const m = await hotManifest();
  assert.match(m.core, /^[0-9a-f]{12}$/);
  assert.match(m.hot['starter-moves'], /^[0-9a-f]{12}$/);
});
