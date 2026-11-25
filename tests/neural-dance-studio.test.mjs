// The fixed studio room is authorized by the Worker secret ND_DEBUG_KEY.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.mjs';
import {NeuralDanceDebugRoom} from '../worker/neural-dance-debug.mjs';
import {readStudioCookie, readStudioKey, resolveStudioKey, studioCookieHeader, studioKeyFromHash, studioKeyFromSearch, writeStudioCookie, writeStudioKey, STUDIO_COOKIE, studioKeyFromPaste} from '../neural-dance/debug-protocol.js';
import {createDebugCredentials} from '../neural-dance/debug-protocol.js';
import {shouldHttpFallback, socketIsConnecting} from '../neural-dance/live-debug.js';

const KEY = 'studio-key-correct-value';
const WRONG = 'wrong-key-value-here';

function memorySql() {
  const rows = new Map();
  const cursor = (list) => ({toArray() { return list; }});
  return {
    rows,
    exec(sql, ...params) {
      const query = sql.replace(/\s+/g, ' ').trim();
      if (query.startsWith('CREATE')) return cursor([]);
      if (query.startsWith('SELECT v FROM nd_debug WHERE k')) {
        const value = rows.get(params[0]);
        return cursor(value == null ? [] : [{v: value}]);
      }
      if (query.startsWith('INSERT')) {
        rows.set(params[0], params[1]);
        return cursor([]);
      }
      if (query.startsWith('DELETE FROM nd_debug WHERE k')) {
        rows.delete(params[0]);
        return cursor([]);
      }
      if (query === 'DELETE FROM nd_debug') {
        rows.clear();
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
    closed: null,
    send(data) { this.sent.push(String(data)); },
    close(code, reason) { this.readyState = 3; this.closed = [code, reason]; }
  };
}

function mockCtx() {
  const sql = memorySql();
  const sockets = [];
  const ctx = {
    rows: sql.rows,
    storage: {
      sql,
      setAlarm() { return Promise.resolve(); }
    },
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); },
    acceptWebSocket(ws, tags) { ws.__tags = tags || []; sockets.push(ws); },
    getWebSockets() { return sockets.slice(); },
    getTags(ws) { return ws.__tags || []; }
  };
  return ctx;
}

function namespaceFor(env) {
  const rooms = new Map();
  return {
    rooms,
    getByName(name) {
      if (!rooms.has(name)) {
        const instance = new NeuralDanceDebugRoom(mockCtx(), env);
        instance.finishUpgrade = () => new Response('upgraded', {status: 200, headers: {'x-upgrade': '1'}});
        rooms.set(name, instance);
      }
      const instance = rooms.get(name);
      return {fetch: (request) => instance.fetch(request)};
    }
  };
}

function memory() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

test('a studio key from the hash is saved and a short or missing key is not', () => {
  assert.equal(studioKeyFromHash(''), '');
  assert.equal(studioKeyFromHash('#k=short'), '');
  assert.equal(studioKeyFromHash('#k=' + KEY), KEY);
  assert.equal(studioKeyFromHash('k=' + KEY), KEY);
  const storage = memory();
  assert.equal(readStudioKey(storage), '');
  assert.equal(writeStudioKey(storage, 'short'), false);
  assert.equal(writeStudioKey(storage, KEY), true);
  assert.equal(readStudioKey(storage), KEY);
  const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  const publisher = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  const room = readFileSync(new URL('../worker/neural-dance-debug.mjs', import.meta.url), 'utf8');
  assert.match(live, /data-debug-advanced/);
  assert.match(live, /data-debug-share aria-pressed="false"/);
  assert.match(live, /Share live debug/);
  assert.match(publisher, /studioKeyFromHash/);
  assert.match(publisher, /localStorage/);
  assert.doesNotMatch(publisher, /ND_DEBUG_KEY/);
  assert.match(viewer, /studioKeyFromHash/);
  assert.match(viewer, /localStorage/);
  assert.match(debug, /#k=/);
  assert.match(room, /env\.ND_DEBUG_KEY/);
  assert.doesNotMatch(room, /ND_DEBUG_KEY\s*[:=]\s*['"]/);
  assert.equal(room.includes(KEY), false);
  assert.equal(publisher.includes(KEY), false);
});

test('the studio room connects with the right key and rejects a missing or wrong key', async () => {
  const previous = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  };
  try {
    const namespace = namespaceFor({ND_DEBUG_KEY: KEY});
    const env = {NEURAL_DANCE_DEBUG: namespace, ND_DEBUG_KEY: KEY};
    const base = 'https://tjm.art/api/neural-dance/debug/';
    const missing = await worker.fetch(new Request(base + 'snapshot?room=studio'), env);
    assert.equal(missing.status, 403);
    const wrong = await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + WRONG), env);
    assert.equal(wrong.status, 403);
    const headerWrong = await worker.fetch(new Request(base + 'snapshot?room=studio', {headers: {'x-nd-key': WRONG}}), env);
    assert.equal(headerWrong.status, 403);
    assert.equal(namespace.rooms.has('studio'), true);
    assert.equal(namespace.rooms.get('studio').ctx.rows.size, 0);

    const closed = namespaceFor({});
    const noSecret = await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + KEY), {NEURAL_DANCE_DEBUG: closed});
    assert.equal(noSecret.status, 403);

    const claim = await worker.fetch(new Request(base + 'claim?room=studio&key=' + KEY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({room: 'studio', publisherSecret: KEY + '-publisher-secret', viewerKey: KEY})
    }), env);
    assert.equal(claim.status, 403);

    const viewer = await worker.fetch(new Request(base + 'ws?room=studio&role=viewer&key=' + KEY, {headers: {Upgrade: 'websocket'}}), env);
    assert.equal(viewer.status, 200);
    assert.equal(viewer.headers.get('x-upgrade'), '1');
    const denied = await worker.fetch(new Request(base + 'ws?room=studio&role=publisher&key=' + WRONG, {headers: {Upgrade: 'websocket'}}), env);
    assert.equal(denied.status, 403);
    const publisher = await worker.fetch(new Request(base + 'ws?room=studio&role=publisher&key=' + KEY, {headers: {Upgrade: 'websocket'}}), env);
    assert.equal(publisher.headers.get('x-upgrade'), '1');

    const instance = namespace.rooms.get('studio');
    assert.equal(JSON.parse([...instance.viewers][0].sent[0]).room, 'studio');
    assert.equal(JSON.parse(instance.publisher.sent[0]).role, 'publisher');
    await instance.webSocketMessage(instance.publisher, JSON.stringify({type: 'frame', telemetry: {t: 4, cameraLabel: 'Studio Cam'}}));
    const viewed = JSON.parse([...instance.viewers][0].sent.at(-1));
    assert.equal(viewed.type, 'frame');
    assert.equal(viewed.telemetry.cameraLabel, 'Studio Cam');
    const snap = await (await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + KEY), env)).json();
    assert.equal(snap.room, 'studio');
    assert.equal(snap.telemetry.cameraLabel, 'Studio Cam');
    const viewerFrame = await worker.fetch(new Request(base + 'frame?room=studio&role=viewer&key=' + KEY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({telemetry: {t: 9}})
    }), env);
    assert.equal(viewerFrame.status, 403);
    assert.equal(JSON.stringify([...instance.ctx.rows.values()]).includes(KEY), false);

    const session = createDebugCredentials();
    const foreign = await worker.fetch(new Request(base + 'snapshot?room=' + session.room + '&key=' + KEY), env);
    assert.equal(foreign.status, 403);
    assert.equal(namespace.rooms.has(session.room), true);

    await instance.alarm();
    const afterIdle = await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + KEY), env);
    assert.equal(afterIdle.status, 200);
    assert.equal((await afterIdle.json()).telemetry, null);
    assert.equal((await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + WRONG), env)).status, 403);
  } finally {
    if (previous) globalThis.WebSocketPair = previous;
    else delete globalThis.WebSocketPair;
  }
});

test('only the newest studio publisher reaches viewers', async () => {
  const previous = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  };
  try {
    const namespace = namespaceFor({ND_DEBUG_KEY: KEY});
    const env = {NEURAL_DANCE_DEBUG: namespace, ND_DEBUG_KEY: KEY};
    const base = 'https://tjm.art/api/neural-dance/debug/';
    const pubA = 'publisher-phone-aaaa';
    const pubB = 'publisher-mac-bbbbbb';
    assert.equal((await worker.fetch(new Request(base + 'ws?room=studio&role=viewer&key=' + KEY, {headers: {Upgrade: 'websocket'}}), env)).status, 200);
    assert.equal((await worker.fetch(new Request(base + 'ws?room=studio&role=publisher&key=' + KEY + '&pub=' + pubA, {headers: {Upgrade: 'websocket'}}), env)).status, 200);
    assert.equal((await worker.fetch(new Request(base + 'ws?room=studio&role=publisher&key=' + KEY + '&pub=' + pubB, {headers: {Upgrade: 'websocket'}}), env)).status, 200);
    const instance = namespace.rooms.get('studio');
    const publishers = instance.ctx.getWebSockets().filter(ws => ws.__ndRole === 'publisher');
    assert.equal(publishers.length, 2);
    const stale = publishers.find(ws => ws !== instance.publisher);
    assert.ok(stale.sent.some(raw => JSON.parse(raw).type === 'displaced'));
    await instance.webSocketMessage(stale, JSON.stringify({type: 'frame', publisherId: pubA, telemetry: {t: 1, cameraLabel: 'Back Camera', publisherName: 'iPhone'}}));
    assert.equal(instance.telemetry, null);
    await instance.webSocketMessage(instance.publisher, JSON.stringify({type: 'frame', publisherId: pubB, telemetry: {t: 2, cameraLabel: 'Choose a camera', publisherName: 'Mac'}}));
    const snap = await (await worker.fetch(new Request(base + 'snapshot?room=studio&key=' + KEY), env)).json();
    assert.equal(snap.telemetry.cameraLabel, 'Choose a camera');
    assert.equal(snap.telemetry.publisherName, 'Mac');
    const rejected = await worker.fetch(new Request(base + 'frame?room=studio&role=publisher&key=' + KEY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({publisherId: pubA, telemetry: {t: 3, cameraLabel: 'Back Camera'}})
    }), env);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).displaced, true);
    assert.equal(instance.telemetry.cameraLabel, 'Choose a camera');
    const kept = await worker.fetch(new Request(base + 'frame?room=studio&role=publisher&key=' + KEY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({publisherId: pubB, telemetry: {t: 4, cameraLabel: 'Choose a camera', publisherName: 'Mac'}})
    }), env);
    assert.equal(kept.status, 200);
  } finally {
    if (previous) globalThis.WebSocketPair = previous;
    else delete globalThis.WebSocketPair;
  }
});

test('a pasted key and a cookie pair the studio room without exposing the key', () => {
  const storage = memory();
  assert.equal(resolveStudioKey({storage, cookie: '', hash: '', search: ''}).key, '');
  assert.equal(studioKeyFromSearch('?k=' + KEY), KEY);
  assert.equal(studioKeyFromHash('#k=' + KEY), KEY);
  assert.equal(resolveStudioKey({storage, hash: '#k=' + KEY}).source, 'hash');
  assert.equal(writeStudioKey(storage, KEY), true);
  assert.equal(resolveStudioKey({storage, cookie: STUDIO_COOKIE + '=' + 'other-key-value-here'}).source, 'storage');
  const empty = memory();
  const header = studioCookieHeader(KEY);
  assert.match(header, /Path=\/neural-dance\//);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=/);
  assert.equal(header.includes('ND_DEBUG_KEY'), false);
  assert.equal(readStudioCookie(STUDIO_COOKIE + '=' + encodeURIComponent(KEY) + '; other=1'), KEY);
  assert.equal(resolveStudioKey({storage: empty, cookie: STUDIO_COOKIE + '=' + KEY}).source, 'cookie');
  assert.equal(resolveStudioKey({storage: empty, cookie: STUDIO_COOKIE + '=' + KEY}).key, KEY);
  const jar = {cookie: ''};
  assert.equal(writeStudioKey(empty, KEY), true);
  assert.equal(writeStudioCookie(jar, KEY), true);
  assert.match(jar.cookie, new RegExp('^' + STUDIO_COOKIE + '='));
  assert.match(jar.cookie, /Secure/);
  assert.equal(readStudioCookie(jar.cookie), KEY);
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const publisher = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(page, /data-debug-pair-go/);
  assert.match(page, /Pair debug/);
  assert.match(page, /data-debug-pair-status/);
  assert.match(publisher, /resolveStudioKey/);
  assert.match(publisher, /writeStudioCookie/);
  assert.doesNotMatch(publisher, /console\.(log|debug|info|warn)\(/);
  assert.equal(publisher.includes(KEY), false);
});

test('a stale publisher id is released once the publisher socket closes', async () => {
  const previous = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  };
  try {
    const namespace = namespaceFor({ND_DEBUG_KEY: KEY});
    const env = {NEURAL_DANCE_DEBUG: namespace, ND_DEBUG_KEY: KEY};
    const base = 'https://tjm.art/api/neural-dance/debug/';
    const pubA = 'publisher-phone-aaaa';
    const pubB = 'publisher-phone-bbbb';
    assert.equal((await worker.fetch(new Request(base + 'ws?room=studio&role=publisher&key=' + KEY + '&pub=' + pubA, {headers: {Upgrade: 'websocket'}}), env)).status, 200);
    const instance = namespace.rooms.get('studio');
    assert.equal(instance.publisherId, pubA);
    await instance.webSocketClose(instance.publisher);
    assert.equal(instance.publisher, null);
    assert.equal(instance.publisherId, '');
    // Phone reloads with a new id and posts a frame before the WebSocket opens.
    const accepted = await worker.fetch(new Request(base + 'frame?room=studio&role=publisher&key=' + KEY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({publisherId: pubB, telemetry: {t: 5, cameraLabel: 'Back Camera', publisherName: 'iPhone'}})
    }), env);
    assert.equal(accepted.status, 200);
    assert.equal(instance.publisherId, pubB);
    assert.equal(instance.telemetry.cameraLabel, 'Back Camera');
  } finally {
    if (previous) globalThis.WebSocketPair = previous;
    else delete globalThis.WebSocketPair;
  }
});

test('studioKeyFromPaste accepts a live URL or raw key', () => {
  const key = 'abcdefghijklmnopqrstuvwx';
  assert.equal(studioKeyFromPaste(key), key);
  assert.equal(studioKeyFromPaste('https://tjm.art/neural-dance/live/?k=' + key), key);
  assert.equal(studioKeyFromPaste('https://tjm.art/neural-dance/live/#k=' + key), key);
  assert.equal(studioKeyFromPaste('not a key'), '');
});

test('HTTP frame fallback waits while the debug WebSocket is connecting', () => {
  assert.equal(socketIsConnecting({readyState: 0}), true);
  assert.equal(socketIsConnecting({readyState: 1}), false);
  assert.equal(shouldHttpFallback(null), true);
  assert.equal(shouldHttpFallback({readyState: 0}), false);
  assert.equal(shouldHttpFallback({readyState: 1}), false);
  assert.equal(shouldHttpFallback({readyState: 3}), true);
});
