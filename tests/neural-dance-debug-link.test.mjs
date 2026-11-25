import test from 'node:test';
import assert from 'node:assert/strict';
import {NeuralDanceDebugRoom} from '../worker/neural-dance-debug.mjs';
import {DEBUG_STALL_MS, createDebugCredentials, debugLinkText, debugPatchAppliesWithoutPrompt, finishDebugFrame, offerDebugFrame, sanitizeDebugPatch, shouldDropDebugSend, takeDebugFrame} from '../neural-dance/debug-protocol.js';
import {cornerCommitAllowed} from '../neural-dance/camera-markers.js';
import {paintingFeedback, quadSummary} from '../neural-dance/debug-viewer.js';

const JPEG = 'AAECAwQFBgcICQoLDA0ODxAREhM=';

function memorySql() {
  const rows = new Map();
  const cursor = (list) => ({toArray() { return list; }});
  return {
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
    alarmAt: 0,
    storage: {
      sql,
      setAlarm(ts) { ctx.alarmAt = ts; return Promise.resolve(); }
    },
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); },
    acceptWebSocket(ws, tags) { ws.__tags = tags || []; sockets.push(ws); },
    getWebSockets() { return sockets.slice(); },
    getTags(ws) { return ws.__tags || []; }
  };
  return ctx;
}

async function openRoom() {
  const ctx = mockCtx();
  const instance = new NeuralDanceDebugRoom(ctx, {});
  await instance.ready;
  instance.finishUpgrade = () => new Response('upgraded', {status: 200, headers: {'x-upgrade': '1'}});
  return {instance};
}

test('debug link text names a stall, a reconnect, and a fresh frame', () => {
  assert.equal(debugLinkText(10_000, 0, 'connecting'), 'Connecting…');
  assert.equal(debugLinkText(10_000, 0, 'reconnecting'), 'Reconnecting…');
  assert.equal(debugLinkText(10_000, 9_500, 'live'), 'Live · last frame 0.5s ago');
  assert.match(debugLinkText(10_000, 10_000 - DEBUG_STALL_MS - 500, 'live'), /^Stalled · last frame 4\.[0-9]s ago$/);
  assert.match(debugLinkText(20_000, 5_000, 'reconnecting'), /^Reconnecting… · last frame /);
  assert.equal(shouldDropDebugSend(0), false);
  assert.equal(shouldDropDebugSend(undefined), false);
  assert.equal(shouldDropDebugSend(300000), true);
  const q = {latest: null, busy: false};
  assert.equal(offerDebugFrame(q, 'a'), true);
  assert.equal(offerDebugFrame(q, 'b'), false);
  assert.equal(q.latest, 'b');
  assert.equal(takeDebugFrame(q), 'b');
  assert.equal(finishDebugFrame(q), false);
});

test('a ping is answered and a backed-up viewer drops the old frame', async () => {
  const previous = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  };
  try {
    const {instance} = await openRoom();
    const session = createDebugCredentials();
    const claim = new Request('https://tjm.art/api/neural-dance/debug/claim?room=' + session.room, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({room: session.room, publisherSecret: session.secret, viewerKey: session.key})
    });
    await instance.fetch(claim);
    await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&role=publisher&secret=' + session.secret, {headers: {Upgrade: 'websocket'}}));
    const publisher = instance.publisher;
    const viewer = fakeSocket();
    instance.attachSocket(viewer, 'viewer');
    await instance.webSocketMessage(viewer, JSON.stringify({type: 'ping', t: 42}));
    assert.equal(JSON.parse(viewer.sent.at(-1)).type, 'pong');
    assert.equal(JSON.parse(viewer.sent.at(-1)).t, 42);
    const before = publisher.sent.length;
    await instance.webSocketMessage(publisher, JSON.stringify({type: 'ping', t: 7}));
    assert.equal(publisher.sent.length, before + 1);
    assert.equal(JSON.parse(publisher.sent.at(-1)).type, 'pong');
    viewer.getBufferedAmount = () => 400000;
    const sentBefore = viewer.sent.length;
    await instance.webSocketMessage(publisher, JSON.stringify({type: 'frame', telemetry: {t: 3, fps: 1}, cameraJpeg: JPEG}));
    assert.equal(viewer.sent.length, sentBefore, 'backed-up viewer does not receive another JPEG');
    const snap = await (await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room + '&key=' + session.key))).json();
    assert.equal(snap.telemetry.t, 3);
  } finally {
    globalThis.WebSocketPair = previous;
  }
});

test('a hand-set quad stays until Detect, Accept, or Reset', () => {
  assert.equal(cornerCommitAllowed(true, {drift: true}), false);
  assert.equal(cornerCommitAllowed(true, {fromLock: true}), false);
  assert.equal(cornerCommitAllowed(true, {}), false);
  assert.equal(cornerCommitAllowed(true, {manual: true}), true);
  assert.equal(cornerCommitAllowed(true, {unlock: true}), true);
  assert.equal(cornerCommitAllowed(false, {drift: true}), true);
  const locked = sanitizeDebugPatch({corners: [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}], cornersLock: 'set', cornersKind: 'stage'});
  assert.equal(locked.cornersLock, 'set');
  const relay = sanitizeDebugPatch({corners: locked.corners, cornersKind: 'stage'});
  assert.equal(relay.cornersLock, undefined);
  assert.equal(quadSummary(null, {source: 'manual-lock', manual: true}), 'corners: manual (locked)');
  assert.equal(quadSummary(null, {source: 'align'}), 'Quad unlocked · set by Align');
});

test('painting buttons are commands and the panel says they were sent', () => {
  assert.equal(debugPatchAppliesWithoutPrompt({action: 'frame-detect'}), true);
  assert.equal(debugPatchAppliesWithoutPrompt({noteSensitivity: 0.5}), false);
  const sent = sanitizeDebugPatch({action: 'frame-detect', cmd: 'abcd1234'});
  assert.equal(sent.action, 'frame-detect');
  assert.equal(sent.cmd, 'abcd1234');
  assert.equal(sanitizeDebugPatch({action: 'frame-detect', cmd: 'Bad cmd'}).cmd, undefined);
  const waiting = paintingFeedback('Painting surface: off', {text: 'sent Detect frame, waiting for the phone'});
  assert.match(waiting, /sent Detect frame, waiting for the phone/);
  assert.equal(paintingFeedback('Painting surface: off', null), 'Painting surface: off');
});
