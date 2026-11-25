import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {NeuralDanceDebugRoom, SCAN_JPEG_MAX, cleanTelemetry} from '../worker/neural-dance-debug.mjs';

const siteWorker = await import('../worker/site.mjs').then(mod => mod.default).catch(() => null);
const CSP_REPORT_ONLY = await import('../worker/security-headers.mjs').then(mod => mod.CSP_REPORT_ONLY).catch(() => '');
import {DEBUG_INTERVAL_MS, createDebugCredentials, sanitizeDebugPatch, viewerPath} from '../neural-dance/debug-protocol.js';
import {SCAN_STILL_MAX, SCAN_STILL_PREFIX, applyDebugPatch, collectTelemetry, ensureDebugSession, loadDebugSession, readDebugSession, rotateDebugSession, scanJpegField, scanStillPayload, withPostedScanStills, writeDebugSession} from '../neural-dance/live-debug.js';
import {detectionTelemetry} from '../neural-dance/camera-markers.js';
import {paintProjectedStage, scanStillSrc, stageMarkPlan} from '../neural-dance/debug-viewer.js';

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
  return {instance, ctx};
}

function claimRequest(session) {
  return new Request('https://tjm.art/api/neural-dance/debug/claim?room=' + session.room, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({room: session.room, publisherSecret: session.secret, viewerKey: session.key})
  });
}

function memory() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

test('debug credentials, the viewer link, and tuning clamps stay unguessable and bounded', () => {
  const session = createDebugCredentials();
  assert.match(session.room, /^ND-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(session.secret.length >= 16, true);
  assert.notEqual(session.secret, session.key);
  const path = viewerPath(session);
  assert.match(path, /^\/neural-dance\/debug\/\?room=ND-/);
  assert.equal(path.includes(session.secret), false);
  assert.equal(path.includes('key='), true);
  const storage = memory();
  assert.equal(readDebugSession(storage), null);
  assert.equal(writeDebugSession(storage, session), true);
  assert.equal(readDebugSession(storage).room, session.room);
  const kept = ensureDebugSession(storage);
  assert.equal(kept.room, session.room);
  assert.equal(kept.key, session.key);
  const legacy = memory();
  writeDebugSession(legacy, session);
  const moved = loadDebugSession(memory(), legacy);
  assert.equal(moved.room, session.room);
  const spun = rotateDebugSession(storage);
  assert.notEqual(spun.room, session.room);
  assert.notEqual(spun.key, session.key);
  assert.notEqual(spun.secret, session.secret);
  assert.equal(ensureDebugSession(storage).room, spun.room);
  assert.equal(viewerPath(spun).includes(spun.secret), false);
  assert.equal(sanitizeDebugPatch({noteSensitivity: 9, markerMode: 'pink', quietThreshold: -1}).noteSensitivity, 1);
  assert.equal(sanitizeDebugPatch({noteSensitivity: 9, quietThreshold: -1}).quietThreshold, 0);
  assert.equal(sanitizeDebugPatch({markerMode: 'pink'}).markerMode, 'pink');
  assert.equal(sanitizeDebugPatch({markerMode: 'nope'}), null);
  assert.equal(sanitizeDebugPatch(null), null);
  assert.equal(session.autoApply, true);
  const tuned = sanitizeDebugPatch({
    gravity: 9, wander: -1, threshold: 1.2, peak: 2.2, type: 2.2,
    kickSensitivity: 1.5, action: 'clear-sim'
  });
  assert.equal(tuned.gravity, 6);
  assert.equal(tuned.wander, 0);
  assert.equal(tuned.threshold, 1.2);
  assert.equal(tuned.type, 2);
  assert.equal(tuned.sens[0], 1.5);
  assert.equal(tuned.action, 'clear-sim');
  const tap = sanitizeDebugPatch({action: 'add-sim', x: 1200, y: -4, type: 3});
  assert.equal(tap.action, 'add-sim');
  assert.equal(tap.x, 1000);
  assert.equal(tap.y, 0);
  assert.equal(tap.type, 3);
  const debugPage = fs.readFileSync('src/pages/neural-dance/debug/index.astro', 'utf8');
  assert.match(debugPage, /data-debug-action="align"/);
  assert.match(debugPage, /data-debug-action="clear-sim"/);
  assert.match(debugPage, /Seed 24 sim dancers/);
  assert.match(debugPage, /data-debug-action="reset-camera"/);
  assert.match(debugPage, /data-debug-control="gravity"/);
  assert.match(debugPage, /data-debug-control="sens-0"/);
  assert.match(debugPage, /data-debug-dancers/);
  assert.ok(DEBUG_INTERVAL_MS >= 500 && DEBUG_INTERVAL_MS <= 1000);
  const page = fs.readFileSync('src/pages/neural-dance/live/index.astro', 'utf8');
  assert.match(page, /data-debug-share aria-pressed="false"/);
  assert.match(page, /Share live debug/);
  assert.match(page, /data-debug-rotate/);
  assert.match(page, /New debug link/);
  const debugJs = fs.readFileSync('neural-dance/live-debug.js', 'utf8');
  assert.match(debugJs, /localStorage/);
  assert.doesNotMatch(debugJs, /console\.(log|debug|info|warn)\(/);
  assert.match(page, /data-debug-auto/);
  assert.match(page, /Suggested tuning received/);
  assert.match(page, /data-debug-apply/);
  assert.match(page, /data-debug-dismiss/);
  // The live page loads one entry module (live-page.js), which imports live debug.
  assert.match(page, /<script type="module" src="\/neural-dance\/live-page\.js"/);
  assert.match(fs.readFileSync('neural-dance/live-page.js', 'utf8'), /import '\.\/live-debug\.js';/);
});

test('scan stills stay unpublished until the room accepts the JPEG', () => {
  assert.equal(SCAN_STILL_PREFIX.length, 23);
  assert.equal(SCAN_STILL_MAX, SCAN_JPEG_MAX);
  assert.equal(SCAN_STILL_MAX, 900000);
  const fit = SCAN_STILL_PREFIX + 'A'.repeat(SCAN_STILL_MAX);
  const over = SCAN_STILL_PREFIX + 'A'.repeat(SCAN_STILL_MAX + 1);
  assert.equal(scanJpegField(fit), fit);
  assert.equal(scanJpegField(over), null);
  const painting = {lastScan: {scanId: 4, before: fit, after: fit, diff: fit}};
  assert.equal(scanStillPayload(painting).scanId, 4);
  assert.equal(scanStillPayload({lastScan: {scanId: 4, before: over, after: over, diff: over}}), null);
  const telemetry = {painting: {lastScan: {scanId: 4, kind: 'scan', images: {before: true, after: true, diff: true}}}};
  assert.equal(withPostedScanStills(telemetry, null).painting.lastScan.images.before, false);
  assert.equal(withPostedScanStills(telemetry, 3).painting.lastScan.images.diff, false);
  assert.equal(withPostedScanStills(telemetry, 4).painting.lastScan.images.before, true);
  assert.match(fs.readFileSync('neural-dance/live-debug.js', 'utf8'), /postedScanId = id/);
  assert.match(fs.readFileSync('neural-dance/live-debug.js', 'utf8'), /return publishFrame\(\)/);
});

test('detection telemetry reports quad RGB, grid points, and luminance ratio', () => {
  const width = 8;
  const height = 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 240;
    rgba[i * 4 + 1] = 180;
    rgba[i * 4 + 2] = 210;
    rgba[i * 4 + 3] = 255;
  }
  const described = detectionTelemetry(
    [{x: 6, y: 8, area: 12, kind: 'pink'}, {x: 2, y: 2, area: 4, kind: 'sticker'}],
    rgba, width, height, {scaleX: 2, scaleY: 2}, null
  );
  assert.deepEqual(described.quadMedianRgb, [240, 180, 210]);
  assert.deepEqual(described.pink[0].grid, [3, 4]);
  assert.deepEqual(described.pink[0].rgb, [240, 180, 210]);
  assert.equal(described.pink[0].stage, null);
  assert.equal(described.pink[0].luminanceRatio, 1);
  assert.equal(described.stickers.length, 1);
  assert.equal(described.detectWidth, 8);
  const plan = stageMarkPlan({
    pink: [{stage: [10, 20]}],
    stickers: [{stage: [30, 40]}],
    markers: [{x: 30, y: 40, kind: 'sticker'}, {x: 80, y: 90, kind: 'pink'}]
  });
  assert.equal(plan.raw.length, 2);
  assert.equal(plan.latched.length, 2);
  assert.equal(plan.latched[0].kind, 'sticker');
  const ops = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath() { ops.push('begin'); },
    arc() {},
    fill() { ops.push('fill:' + this.fillStyle); },
    stroke() { ops.push('stroke:' + this.strokeStyle); }
  };
  paintProjectedStage(ctx, {
    pink: [{stage: [10, 20]}],
    stickers: [],
    markers: [{x: 80, y: 90, kind: 'sticker'}]
  }, 1000, 620);
  assert.equal(ops.filter(op => op.startsWith('fill:')).length, 1);
  assert.equal(ops.filter(op => op.startsWith('stroke:')).length, 2);
  assert.ok(ops.includes('fill:#7fe8b3'));
});

test('applyDebugPatch writes camera tuning and the quiet threshold', () => {
  const applied = [];
  const quiet = {value: '0.08', dispatchEvent() { this.fired = true; }};
  const doc = {
    getElementById(id) {
      if (id === 'nd-camera-mode') return {neuralDanceCamera: {applyTuning(patch) { applied.push(patch); }}};
      if (id === 'nd-room-lab') return {querySelector(sel) { return sel.includes('quiet') ? quiet : null; }};
      return null;
    }
  };
  assert.equal(applyDebugPatch(doc, {noteSensitivity: 0.91, quietThreshold: 0.22, markerMode: 'stickers'}), true);
  assert.equal(applied[0].noteSensitivity, 0.91);
  assert.equal(applied[0].markerMode, 'stickers');
  assert.equal(quiet.value, '0.22');
  assert.equal(quiet.fired, true);
  const telemetry = collectTelemetry({
    getElementById(id) {
      if (id === 'nd-camera-mode') return {neuralDanceCamera: {debugState() { return {fps: 11, videoWidth: 1920, videoHeight: 1080, detectWidth: 480, detectHeight: 270, cameraLabel: 'iPhone Camera', facingMode: 'environment', aligned: true, quadMedianRgb: [11, 22, 33], controls: {markerMode: 'both', saturationSensitivity: 0.75, stickerSensitivity: 0.5, hueTolerance: 48, minBlobSize: 18, maxBlobSize: 160}}; }}};
      if (id === 'nd-room-lab') return {neuralDance: {debugAudio() { return {source: 'mic', kick: 0.2, bass: 0.4, snare: 0.1, hat: 0.05, envelopes: {kick: 0.2, bass: 0.4, snare: 0.1, hat: 0.05}, silenceGate: false, noiseFloor: 0.03, micGain: 1.2}; }}, querySelector() { return {value: '0.08'}; }};
      return null;
    }
  }, 123);
  assert.equal(telemetry.t, 123);
  assert.equal(telemetry.cameraLabel, 'iPhone Camera');
  assert.equal(telemetry.audio.source, 'mic');
  assert.equal(telemetry.audio.silenceGate, false);
  assert.deepEqual(telemetry.quadMedianRgb, [11, 22, 33]);
  assert.equal(telemetry.controls.quietThreshold, 0.08);
  assert.equal(telemetry.controls.noteSensitivity, 0.75);
});

test('room auth rejects a missing or wrong key and serves a snapshot to the viewer', async () => {
  const {instance, ctx} = await openRoom();
  const session = createDebugCredentials();
  const snapshotUrl = 'https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room;
  assert.equal((await instance.fetch(new Request(snapshotUrl))).status, 403);
  assert.equal((await instance.fetch(new Request(snapshotUrl + '&key=wrong-key-value-here'))).status, 403);
  const claimed = await instance.fetch(claimRequest(session));
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).created, true);
  assert.equal((await instance.fetch(claimRequest({...session, secret: 'different-secret-value'}))).status, 403);
  assert.equal((await instance.fetch(new Request(snapshotUrl + '&key=' + session.key))).status, 200);
  assert.equal((await instance.fetch(new Request(snapshotUrl + '&secret=' + session.secret))).status, 403);
  const frame = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/frame?room=' + session.room + '&secret=' + session.secret, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      type: 'frame',
      telemetry: {t: 5, fps: 1.3, cameraLabel: 'iPhone Camera', quadMedianRgb: [8, 9, 10]},
      cameraJpeg: 'data:image/jpeg;base64,' + JPEG,
      stageJpeg: JPEG
    })
  }));
  assert.equal(frame.status, 200);
  assert.equal((await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/frame?room=' + session.room + '&key=' + session.key, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}))).status, 403);
  const snap = await (await instance.fetch(new Request(snapshotUrl + '&key=' + session.key))).json();
  assert.equal(snap.telemetry.cameraLabel, 'iPhone Camera');
  assert.equal(snap.ring.length, 1);
  assert.match(snap.camera, /camera\.jpg\?room=/);
  const jpeg = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/camera.jpg?room=' + session.room + '&key=' + session.key));
  assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
  assert.equal(jpeg.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await jpeg.arrayBuffer()), Buffer.from(JPEG, 'base64'));
  const stage = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/stage.jpg?room=' + session.room + '&key=' + session.key));
  assert.equal(stage.status, 200);
  const stillUrl = 'https://tjm.art/api/neural-dance/debug/last-scan/before.jpg?room=' + session.room + '&key=' + session.key;
  assert.equal((await instance.fetch(new Request(stillUrl))).status, 404);
  assert.equal((await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan?room=' + session.room + '&key=' + session.key, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({scanId: 7, before: 'data:image/jpeg;base64,' + JPEG, after: JPEG, diff: JPEG})
  }))).status, 403);
  const posted = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan?room=' + session.room + '&secret=' + session.secret, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({scanId: 7, before: 'data:image/jpeg;base64,' + JPEG, after: JPEG, diff: JPEG})
  }));
  assert.equal(posted.status, 200);
  assert.equal((await posted.json()).scanId, 7);
  const beforeStill = await instance.fetch(new Request(stillUrl + '&scan=7'));
  assert.equal(beforeStill.headers.get('content-type'), 'image/jpeg');
  assert.equal(beforeStill.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await beforeStill.arrayBuffer()), Buffer.from(JPEG, 'base64'));
  const afterStill = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan/after.jpg?room=' + session.room + '&key=' + session.key));
  assert.equal(afterStill.status, 200);
  const diffStill = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan/diff.jpg?room=' + session.room + '&key=' + session.key));
  assert.equal(diffStill.status, 200);
  assert.equal((await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan/diff.jpg?room=' + session.room + '&key=wrong-key-value-here'))).status, 403);
  const withPics = cleanTelemetry({
    t: 9,
    painting: {lastScan: {kind: 'scan', at: 9, scanId: 7, before: 'x'.repeat(4000), after: 'y'.repeat(4000), diff: 'z'.repeat(4000), blobs: [{reason: 'accept', area: 12}]}}
  });
  assert.equal(withPics.painting.lastScan.before, undefined);
  assert.equal(withPics.painting.lastScan.blobs[0].area, 12);
  assert.equal(scanStillSrc(session.room, session.key, 'before', 7), '/api/neural-dance/debug/last-scan/before.jpg?room=' + encodeURIComponent(session.room) + '&key=' + encodeURIComponent(session.key) + '&scan=7');
  assert.equal((await instance.fetch(new Request(stillUrl + '&scan=6'))).status, 404);
  assert.ok(ctx.alarmAt > Date.now() + 29 * 60 * 1000);
  for (let i = 0; i < 12; i++) {
    const posted = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/frame?room=' + session.room + '&secret=' + session.secret, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({telemetry: {t: 100 + i}})
    }));
    assert.equal(posted.status, 200);
  }
  const ring = await (await instance.fetch(new Request(snapshotUrl + '&key=' + session.key))).json();
  assert.equal(ring.ring.length, 10);
  assert.equal(ring.ring[9].t, 111);
  await instance.alarm();
  assert.equal((await instance.fetch(new Request(snapshotUrl + '&key=' + session.key))).status, 403);
  assert.equal((await (await instance.fetch(claimRequest(session))).json()).created, true);
});

test('a viewer patch reaches the publisher over WebSocket and over HTTP', async () => {
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
    assert.equal((await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&role=publisher&secret=' + session.secret, {headers: {Upgrade: 'websocket'}}))).status, 403);
    await instance.fetch(claimRequest(session));
    const upgraded = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&role=publisher&secret=' + session.secret, {headers: {Upgrade: 'websocket'}}));
    assert.equal(upgraded.headers.get('x-upgrade'), '1');
    const first = instance.publisher;
    assert.equal(JSON.parse(first.sent[0]).type, 'hello');
    const again = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&role=publisher&secret=' + session.secret, {headers: {Upgrade: 'websocket'}}));
    assert.equal(again.status, 200);
    assert.deepEqual(first.closed, [4000, 'replaced']);
    const publisher = instance.publisher;
    const viewer = fakeSocket();
    instance.attachSocket(viewer, 'viewer');
    await instance.webSocketMessage(viewer, JSON.stringify({type: 'propose_patch', patch: {noteSensitivity: 0.9, quietThreshold: 0.2}}));
    const pushed = JSON.parse(publisher.sent.at(-1));
    assert.equal(pushed.type, 'propose_patch');
    assert.equal(pushed.patch.noteSensitivity, 0.9);
    assert.equal(pushed.patch.quietThreshold, 0.2);
    const http = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/patch?room=' + session.room + '&key=' + session.key, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({patch: {minBlobSize: 30, markerMode: 'pink'}})
    }));
    assert.equal(http.status, 200);
    const pending = await http.json();
    assert.equal(pending.pendingPatch.patch.minBlobSize, 30);
    assert.equal(JSON.parse(publisher.sent.at(-1)).patch.markerMode, 'pink');
    assert.equal((await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/patch?room=' + session.room + '&secret=' + session.secret, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({patch: {minBlobSize: 40}})}))).status, 403);
    await instance.webSocketMessage(publisher, JSON.stringify({type: 'frame', telemetry: {t: 9, fps: 2}, cameraJpeg: JPEG}));
    const viewed = JSON.parse(viewer.sent.at(-1));
    assert.equal(viewed.type, 'frame');
    assert.equal(viewed.telemetry.fps, 2);
    assert.equal(viewed.pendingPatch.patch.minBlobSize, 30);
    const cleared = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/result?room=' + session.room + '&secret=' + session.secret, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({type: 'patch_result', status: 'applied'})
    }));
    assert.equal(cleared.status, 200);
    const after = await (await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room + '&key=' + session.key))).json();
    assert.equal(after.pendingPatch, null);
  } finally {
    if (previous) globalThis.WebSocketPair = previous;
    else delete globalThis.WebSocketPair;
  }
});

test('the website Worker forwards debug HTTP and WebSocket upgrades and fails closed', {skip: !siteWorker}, async () => {
  const worker = siteWorker;
  const rooms = new Map();
  const namespace = {
    getByName(name) {
      if (!rooms.has(name)) rooms.set(name, new NeuralDanceDebugRoom(mockCtx(), {}));
      const instance = rooms.get(name);
      return {fetch: (request) => instance.fetch(request)};
    }
  };
  const env = {PRIMARY_HOST: 'tjm.art', LEGACY_REDIRECT: 'false', NEURAL_DANCE_DEBUG: namespace, ASSETS: {fetch: () => new Response('asset')}};
  const session = createDebugCredentials();
  assert.equal((await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=NOPE'), env)).status, 403);
  assert.equal(await (await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room + '&key=' + session.key), {...env, NEURAL_DANCE_DEBUG: undefined})).json().then(body => body.error), 'Live debug is temporarily unavailable.');
  assert.equal((await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room), env)).status, 403);
  await worker.fetch(claimRequest(session), env);
  const snap = await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room + '&key=wrong-key-not-the-viewer'), env);
  assert.equal(snap.status, 403);
  assert.notEqual(await snap.text(), 'asset');
  let upgrade = null;
  const forwarded = await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&key=' + session.key, {headers: {Upgrade: 'websocket'}}), {
    ...env,
    NEURAL_DANCE_DEBUG: {getByName() { return {fetch(request) { upgrade = request.headers.get('Upgrade'); return Response.json({ok: true}); }}; }}
  });
  assert.equal(upgrade, 'websocket');
  assert.equal(forwarded.status, 200);
  let checkout = null;
  const viaCheckout = await worker.fetch(new Request('https://tjm.art/api/neural-dance/debug/ws?room=' + session.room + '&role=publisher&secret=' + session.secret, {headers: {Upgrade: 'websocket'}}), {
    PRIMARY_HOST: 'tjm.art',
    LEGACY_REDIRECT: 'false',
    ASSETS: {fetch: () => new Response('asset')},
    CHECKOUT: {fetch(request) { checkout = [request.headers.get('Upgrade'), new URL(request.url).pathname]; return Response.json({ok: true}); }}
  });
  assert.equal(viaCheckout.status, 200);
  assert.deepEqual(checkout, ['websocket', '/api/neural-dance/debug/ws']);
  const checkoutSource = fs.readFileSync('cloudflare/commission-worker.js', 'utf8');
  assert.match(checkoutSource, /path\.startsWith\('\/api\/neural-dance\/debug\/'\)\) return handleNeuralDanceDebug\(request, env\)/);
});

test('report-only CSP allows the debug socket and the viewer page is noindex', {skip: !siteWorker || !CSP_REPORT_ONLY || !fs.existsSync('cloudflare/commission-worker.js')}, () => {
  const worker = siteWorker;
  assert.match(CSP_REPORT_ONLY, /connect-src 'self' wss:\/\/tjm\.art ws:\/\/localhost:\* ws:\/\/127\.0\.0\.1:\*/);
  const headers = fs.readFileSync('static/_headers', 'utf8');
  assert.ok(headers.includes('wss://tjm.art'));
  assert.ok(headers.includes('ws://localhost:*'));
  assert.ok(headers.includes('ws://127.0.0.1:*'));
  const page = fs.readFileSync('src/pages/neural-dance/debug/index.astro', 'utf8');
  assert.match(page, /name="robots" content="noindex, nofollow"/);
  assert.match(page, /data-debug-camera/);
  assert.match(page, /data-debug-stage/);
  assert.match(page, /Send tuning to room/);
  assert.doesNotMatch(page, /SiteHeader|class="site-header"/);
  assert.match(fs.readFileSync('robots.txt', 'utf8'), /^Disallow: \/neural-dance\/debug\/$/m);
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.migrations, undefined);
  assert.ok(config.assets.run_worker_first.includes('/api/neural-dance/debug/*'));
  for (const file of ['cloudflare/wrangler.jsonc', 'cloudflare/wrangler.sandbox.jsonc']) {
    const checkout = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(checkout.durable_objects.bindings.some(binding => binding.name === 'NEURAL_DANCE_DEBUG' && binding.class_name === 'NeuralDanceDebugRoom'), file);
    assert.ok(checkout.migrations.some(migration => migration.tag === 'neural-dance-debug-v1' && migration.new_sqlite_classes.includes('NeuralDanceDebugRoom')), file);
  }
  assert.match(fs.readFileSync('cloudflare/commission-worker.js', 'utf8'), /export \{ NeuralDanceDebugRoom \}/);
  assert.equal(typeof worker.fetch, 'function');
});

test('a new publisher clears stored scan stills; the same publisher keeps them', async () => {
  const {instance} = await openRoom();
  const session = createDebugCredentials();
  assert.equal((await instance.fetch(claimRequest(session))).status, 200);
  const posted = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/last-scan?room=' + session.room + '&secret=' + session.secret, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({scanId: 3, publisherId: 'publisherA1', before: 'data:image/jpeg;base64,' + JPEG, after: JPEG, diff: JPEG})
  }));
  assert.equal(posted.status, 200);
  const url = 'https://tjm.art/api/neural-dance/debug/last-scan/before.jpg?room=' + session.room + '&key=' + session.key + '&scan=3';
  assert.equal((await instance.fetch(new Request(url))).status, 200);
  instance.adoptPublisher('publisherA1');
  assert.equal((await instance.fetch(new Request(url))).status, 200);
  instance.adoptPublisher('publisherB2');
  assert.equal((await instance.fetch(new Request(url))).status, 404);
  assert.equal((await instance.fetch(new Request(url.replace('scan=3', 'scan=9')))).status, 404);
});
