// Sim-preview params room. The live Worker config and the live page stay put.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {NeuralDanceSimParams} from '../worker/index.mjs';
import {authorizeSimParamsWrite, handleSimParams, simParamsTokenMatches, stampSimPreviewPage} from '../worker/neural-dance-sim-params.mjs';
import {validateSimParams} from '../neural-dance/sim-params.js';

const TOKEN = 'sim-preview-token-value';

const LIVE_SOURCES = [
  'src/pages/neural-dance/live/index.astro',
  'neural-dance/live-page.js',
  'neural-dance/live-reload.js',
  'neural-dance/live-show.js',
  'neural-dance/live-debug.js',
  'neural-dance/room-lab.js',
  'neural-dance/camera-markers.js',
  'neural-dance/src/silhouette.js',
  'neural-dance/src/skeleton-dancer.js'
];

function memorySql() {
  const rows = new Map();
  const cursor = (list) => ({toArray() { return list; }});
  return {
    exec(sql, ...params) {
      const query = sql.replace(/\s+/g, ' ').trim();
      if (query.startsWith('CREATE')) return cursor([]);
      if (query.startsWith('SELECT v FROM nd_sim_params WHERE k')) {
        const value = rows.get(params[0]);
        return cursor(value == null ? [] : [{v: value}]);
      }
      if (query.startsWith('INSERT')) {
        rows.set(params[0], params[1]);
        return cursor([]);
      }
      throw new Error('unexpected sql: ' + query);
    }
  };
}

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(data) { this.sent.push(String(data)); },
    close() { this.readyState = 3; }
  };
}

function mockCtx() {
  const sql = memorySql();
  const sockets = [];
  return {
    storage: {sql},
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); },
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets.slice(); }
  };
}

function namespaceFor(env) {
  const rooms = new Map();
  return {
    rooms,
    getByName(name) {
      if (!rooms.has(name)) rooms.set(name, new NeuralDanceSimParams(mockCtx(), env));
      const instance = rooms.get(name);
      return {fetch: (request) => instance.fetch(request)};
    }
  };
}

function jsonRequest(path, method, body, token) {
  const headers = {'content-type': 'application/json'};
  if (token) headers.authorization = 'Bearer ' + token;
  return new Request('https://preview.workers.dev' + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
}

test('the params schema accepts known keys and rejects the rest', () => {
  const ok = validateSimParams({bpm: 128, silhouettes: false, masses: {crown: 1.5}});
  assert.equal(ok.ok, true);
  assert.equal(ok.value.bpm, 128);
  assert.equal(ok.value.silhouettes, false);
  assert.equal(ok.value.masses.crown, 1.5);
  assert.equal(validateSimParams({bpm: '128'}).ok, false);
  assert.equal(validateSimParams({nope: 1}).ok, false);
  assert.equal(validateSimParams({masses: {nope: 1}}).ok, false);
  assert.equal(validateSimParams({jointCap: 1}).ok, false);
  assert.equal(validateSimParams([]).ok, false);
  assert.equal(validateSimParams({bpm: Infinity}).ok, false);
});

test('token comparison hashes both sides and fails closed on an empty secret', async () => {
  assert.equal(await simParamsTokenMatches('same-token-value', 'same-token-value'), true);
  assert.equal(await simParamsTokenMatches('same-token-value', 'same-token-other'), false);
  assert.equal(await simParamsTokenMatches('short', 'much-longer-token-value'), false);
  assert.equal(await simParamsTokenMatches('', TOKEN), false);
  assert.equal(await simParamsTokenMatches(TOKEN, ''), false);
  const source = readFileSync(new URL('../worker/neural-dance-sim-params.mjs', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /SHA-256/);
  assert.doesNotMatch(source, /provided === expected/);
  assert.doesNotMatch(source, /SIM_PARAMS_TOKEN\s*=\s*['"][^'"]+['"]/);
  const missing = await authorizeSimParamsWrite(jsonRequest('/api/neural-dance/sim/params', 'POST', {bpm: 120}), {});
  assert.equal(missing.status, 401);
  const wrong = await authorizeSimParamsWrite(jsonRequest('/api/neural-dance/sim/params', 'POST', {bpm: 120}, 'nope'), {SIM_PARAMS_TOKEN: TOKEN});
  assert.equal(wrong.status, 403);
});

test('writes fail closed without a token, and a good token updates every socket', async () => {
  const previous = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  };
  try {
    const ctx = mockCtx();
    const closed = new NeuralDanceSimParams(ctx, {});
    const denied = await closed.fetch(jsonRequest('/api/neural-dance/sim/params', 'POST', {bpm: 140}));
    assert.equal(denied.status, 401);
    assert.equal((await (await closed.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params'))).json()).overrides.bpm, undefined);

    const room = new NeuralDanceSimParams(ctx, {SIM_PARAMS_TOKEN: TOKEN});
    await room.ready;
    const missing = await room.fetch(jsonRequest('/api/neural-dance/sim/params', 'PATCH', {bpm: 128}));
    assert.equal(missing.status, 401);
    const header = new Request('https://preview.workers.dev/api/neural-dance/sim/params', {
      method: 'PATCH',
      headers: {'content-type': 'application/json', 'x-sim-params-token': 'wrong-token'},
      body: JSON.stringify({bpm: 128})
    });
    assert.equal((await room.fetch(header)).status, 403);
    assert.equal((await room.fetch(jsonRequest('/api/neural-dance/sim/params', 'PATCH', {notAKey: 1}, TOKEN))).status, 400);
    assert.equal((await room.fetch(jsonRequest('/api/neural-dance/sim/params', 'PATCH', {bpm: '128'}, TOKEN))).status, 400);
    assert.equal((await room.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params', {method: 'PUT'}))).status, 405);

    room.finishUpgrade = () => new Response('upgraded', {status: 200, headers: {'x-upgrade': '1'}});
    const opened = await room.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params/ws', {headers: {Upgrade: 'websocket'}}));
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('x-upgrade'), '1');
    const again = await room.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params/ws', {headers: {Upgrade: 'websocket'}}));
    assert.equal(again.status, 200);
    const sockets = ctx.getWebSockets();
    assert.equal(sockets.length, 2);
    assert.equal(JSON.parse(sockets[0].sent[0]).type, 'params');

    const patched = await (await room.fetch(jsonRequest('/api/neural-dance/sim/params', 'PATCH', {bpm: 128, masses: {crown: 1.2}}, TOKEN))).json();
    assert.equal(patched.revision, 1);
    assert.equal(patched.overrides.bpm, 128);
    assert.equal(patched.overrides.masses.crown, 1.2);
    const replaced = await (await room.fetch(jsonRequest('/api/neural-dance/sim/params', 'POST', {speed: 1.4}, TOKEN))).json();
    assert.equal(replaced.overrides.bpm, undefined);
    assert.equal(replaced.overrides.speed, 1.4);
    assert.equal(replaced.reset, false);
    const reloaded = new NeuralDanceSimParams(ctx, {SIM_PARAMS_TOKEN: TOKEN});
    const kept = await (await reloaded.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params'))).json();
    assert.equal(kept.overrides.speed, 1.4);
    assert.equal(kept.revision, replaced.revision);
    for (const ws of sockets) {
      const last = JSON.parse(ws.sent.at(-1));
      assert.equal(last.overrides.speed, 1.4);
      assert.equal(last.type, 'params');
    }
    const cleared = await (await room.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params', {
      method: 'DELETE',
      headers: {authorization: 'Bearer ' + TOKEN}
    }))).json();
    assert.equal(cleared.reset, true);
    assert.deepEqual(cleared.overrides, {});
    assert.equal(JSON.parse(sockets[0].sent.at(-1)).reset, true);

    const restarted = new NeuralDanceSimParams(ctx, {SIM_PARAMS_TOKEN: TOKEN});
    const restored = await (await restarted.fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params'))).json();
    assert.deepEqual(restored.overrides, {});
    assert.equal(restored.live, true);
    assert.ok(restored.revision >= 3);

    const huge = jsonRequest('/api/neural-dance/sim/params', 'POST', {bpm: 100, pad: 'x'.repeat(9000)}, TOKEN);
    assert.equal((await room.fetch(huge)).status, 413);
  } finally {
    if (previous) globalThis.WebSocketPair = previous;
    else delete globalThis.WebSocketPair;
  }
});

test('the live Worker does not serve the sim params room, and the preview page is stamped only with the binding', async () => {
  let assets = 0;
  const env = {ASSETS: {fetch() { assets += 1; return new Response('asset', {headers: {'content-type': 'text/plain'}}); }}};
  const missing = await worker.fetch(new Request('https://example.test/api/neural-dance/sim/params'), env);
  assert.equal(missing.status, 404);
  assert.equal(assets, 0);
  assert.equal(await missing.text(), 'Not found');
  const page = await worker.fetch(new Request('https://example.test/neural-dance/sim/'), env);
  assert.equal(await page.text(), 'asset');
  assert.equal(assets, 1);

  const html = '<!DOCTYPE html><html><head><title>sim</title></head><body></body></html>';
  const preview = {
    ASSETS: {fetch() { return new Response(html, {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}}); }},
    SIM_PARAMS: {getByName() { return {fetch() { return new Response('nope'); }}; }}
  };
  const stamped = await stampSimPreviewPage(new Request('https://preview.workers.dev/neural-dance/sim/'), preview);
  const text = await stamped.text();
  assert.match(text, /<meta name="nd-sim-live" content="1">/);
  assert.match(stamped.headers.get('cache-control'), /no-store/);
  const viaWorker = await worker.fetch(new Request('https://preview.workers.dev/neural-dance/sim/'), preview);
  assert.match(await viaWorker.text(), /name="nd-sim-live"/);

  const namespace = namespaceFor({SIM_PARAMS_TOKEN: TOKEN});
  const routed = await worker.fetch(jsonRequest('/api/neural-dance/sim/params', 'PATCH', {bpm: 130}, TOKEN), {SIM_PARAMS: namespace, SIM_PARAMS_TOKEN: TOKEN});
  assert.equal(routed.status, 200);
  assert.equal((await routed.json()).overrides.bpm, 130);
  assert.equal(namespace.rooms.has('preview'), true);
  const unauth = await handleSimParams(jsonRequest('/api/neural-dance/sim/params', 'DELETE', null, ''), {SIM_PARAMS: namespace});
  assert.equal(unauth.status, 401);
  assert.equal((await (await namespace.rooms.get('preview').fetch(new Request('https://preview.workers.dev/api/neural-dance/sim/params'))).json()).overrides.bpm, 130);
});

test('example wrangler configs have no account ids or routes, and the live page does not call the sim room', () => {
  const live = readFileSync(new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  const sim = readFileSync(new URL('../wrangler.sim.example.toml', import.meta.url), 'utf8');
  assert.match(live, /^name = "neural-dance-engine"$/m);
  assert.doesNotMatch(live, /^\s*account_id\s*=/m);
  assert.doesNotMatch(sim, /^\s*account_id\s*=/m);
  assert.match(sim, /^name = "neural-dance-engine-sim"$/m);
  assert.match(sim, /^workers_dev = true$/m);
  assert.doesNotMatch(sim, /tjm\.art/);
  assert.doesNotMatch(sim, /\[\[routes\]\]|^routes\s*=/m);
  assert.match(sim, /name = "SIM_PARAMS"/);
  assert.match(sim, /class_name = "NeuralDanceSimParams"/);
  assert.match(sim, /new_sqlite_classes = \[ "NeuralDanceSimParams" \]/);
  assert.match(sim, /\/api\/neural-dance\/sim\/\*/);
  const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(livePage, /\/api\/neural-dance\/sim/);
  assert.doesNotMatch(livePage, /nd-sim-live/);
  assert.doesNotMatch(livePage, /SIM_PARAMS/);
  for (const file of LIVE_SOURCES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/api\/neural-dance\/sim/, file);
    assert.doesNotMatch(source, /nd-sim-live/, file);
    assert.doesNotMatch(source, /SIM_PARAMS_TOKEN/, file);
  }
  const simPage = readFileSync(new URL('../static/neural-dance/sim/index.html', import.meta.url), 'utf8');
  assert.match(simPage, /\/neural-dance\/sim\/params\.json/);
  assert.match(simPage, /meta\[name="nd-sim-live"\]/);
  assert.doesNotMatch(simPage, /<meta name="nd-sim-live"/);
  assert.doesNotMatch(simPage, /SIM_PARAMS_TOKEN/);
});
