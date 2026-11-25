// Hotfix relearn white capture, debug commands, manual
// corners, and a same-device debug reconnect that is not a takeover.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NeuralDanceDebugRoom} from '../worker/neural-dance-debug.mjs';
import {debugCommandsFromMessage, debugPatchAppliesWithoutPrompt} from '../neural-dance/debug-protocol.js';
import {acceptManualCorners, explainAlignmentQuad, readCameraSettings, writeCameraSettings} from '../neural-dance/camera-markers.js';
import {createPaintingSession} from '../neural-dance/src/painting-session.js';
import {BARE_HOLD_MAX_MS, BARE_HOLD_MIN_MS, liveCornerLabel, livePaintingLabel, setControlPhase} from '../neural-dance/live-show.js';
import {ensurePublisherId} from '../neural-dance/live-debug.js';
import {createDebugCredentials} from '../neural-dance/debug-protocol.js';

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
  return {
    storage: {sql, setAlarm() { return Promise.resolve(); }},
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); },
    acceptWebSocket() {},
    getWebSockets() { return []; },
    getTags() { return []; }
  };
}
function memory() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}
function claimRequest(session) {
  return new Request('https://tjm.art/api/neural-dance/debug/claim?room=' + session.room, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({room: session.room, publisherSecret: session.secret, viewerKey: session.key})
  });
}

test('same device reclaims the debug feed; a different device is a takeover', async () => {
  const ctx = mockCtx();
  const instance = new NeuralDanceDebugRoom(ctx, {});
  await instance.ready;
  const session = createDebugCredentials();
  await instance.fetch(claimRequest(session));
  const viewer = fakeSocket();
  instance.attachSocket(viewer, 'viewer');
  const phone = fakeSocket();
  phone.__ndPub = 'phone-same-device';
  instance.attachSocket(phone, 'publisher');
  const again = fakeSocket();
  again.__ndPub = 'phone-same-device';
  instance.attachSocket(again, 'publisher');
  assert.equal(phone.sent.some(raw => raw.includes('displaced')), false);
  assert.deepEqual(phone.closed, [4000, 'reclaim']);
  assert.equal(instance.publisher, again);
  await instance.webSocketMessage(viewer, JSON.stringify({type: 'propose_patch', patch: {action: 'frame-clear', cmd: 'clear1234'}}));
  const sent = again.sent.map(raw => JSON.parse(raw));
  const command = sent.find(message => message.type === 'propose_patch');
  assert.equal(command.patch.action, 'frame-clear');
  assert.equal(phone.sent.some(raw => raw.includes('propose_patch')), false, 'commands must not sit on the reclaimed socket');
  const other = fakeSocket();
  other.__ndPub = 'other-device-id';
  instance.attachSocket(other, 'publisher');
  assert.equal(again.sent.some(raw => raw.includes('displaced')), true);
  assert.deepEqual(again.closed, [4000, 'replaced']);
});

test('queued debug commands all arrive, and a corner drag applies without auto-apply', () => {
  const both = debugCommandsFromMessage({
    commands: [
      {id: 1, patch: {action: 'frame-clear'}},
      {id: 2, patch: {action: 'scan-stickers'}}
    ]
  });
  assert.deepEqual(both.map(item => item.patch.action), ['frame-clear', 'scan-stickers']);
  assert.equal(debugPatchAppliesWithoutPrompt({cornersLock: 'set', corners: []}), true);
  assert.equal(debugPatchAppliesWithoutPrompt({noteSensitivity: 0.5}), false);
});

test('a hand-dragged parallelogram locks and is stored; auto-detect skew does not', () => {
  const quad = [
    {x: 0.08, y: 0.12},
    {x: 0.92, y: 0.18},
    {x: 0.62, y: 0.9},
    {x: 0.05, y: 0.55}
  ];
  const manual = acceptManualCorners(quad);
  assert.equal(manual.ok, true);
  assert.equal(manual.lock, true);
  const auto = explainAlignmentQuad(quad);
  assert.equal(auto.ok, false);
  const storage = memory();
  writeCameraSettings(storage, {
    corners: quad,
    cornersSource: 'manual-lock',
    cornersLocked: true,
    hueTolerance: 32,
    saturationSensitivity: 0.45,
    minBlobSize: 22
  });
  const saved = readCameraSettings(storage);
  assert.equal(saved.cornersLocked, true);
  assert.equal(saved.cornersSource, 'manual-lock');
  assert.equal(saved.corners.length, 4);
});

test('relearn stores the white frames and the hold is about 0.3 to 1.2 seconds', () => {
  assert.equal(BARE_HOLD_MIN_MS, 300);
  assert.equal(BARE_HOLD_MAX_MS, 1200);
  const session = createPaintingSession();
  assert.equal(session.learnReference([{data: new Uint8Array(4), width: 1, height: 1}], 1), false);
  session.accept([{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.8, y: 0.8}, {x: 0.2, y: 0.8}]);
  const frame = {data: new Uint8ClampedArray(4 * 4 * 4).fill(220), width: 4, height: 4};
  session.observe(frame, {flashing: true});
  assert.equal(session.telemetry().reference.frames, 0);
  assert.equal(session.learnReference([frame, frame, frame], 9), true);
  assert.equal(session.referenceReady(), true);
  assert.equal(session.telemetry().reference.ready, true);
});

test('the publisher id is per device, and the live path flashes white and keeps the corner lock', () => {
  const local = memory();
  const session = memory();
  session.setItem('nd.debugPublisher.v1', 'session-id1');
  const doc = {defaultView: {localStorage: local, sessionStorage: session}};
  assert.equal(ensurePublisherId(doc), 'session-id1');
  assert.equal(local.getItem('nd.debugPublisher.v1'), 'session-id1');
  assert.equal(ensurePublisherId(doc), 'session-id1');
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const relearn = show.slice(show.indexOf('function relearnBarePaintingNow'), show.indexOf('function commitHomes'));
  assert.ok(relearn.indexOf('coverStageWhite(doc, true') < relearn.indexOf('await'));
  assert.match(show, /releaseManualCornerLock/);
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /!cam\.manualLocked && !cam\.manualQuad && borderOwnsQuad/);
  assert.match(cam, /releaseManualCorners\(\)/);
  const live = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(live, /localStorage/);
  assert.match(live, /reason === 'reclaim'/);
  assert.match(live, /action === 'painting-reference'\) \{\s*relearnBarePaintingNow/);
  assert.match(live, /action === 'frame-clear'\)/);
  assert.match(live, /action === 'scan-stickers'\) \{ scanStickersNow\(doc, \{fromDebug: true\}\)/);
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  for (const action of ['frame-detect', 'frame-accept', 'painting-reference', 'frame-clear', 'scan-stickers', 'auto-align']) {
    assert.match(page, new RegExp('data-live-action="' + action + '"'));
  }
  assert.match(page, /data-live-corners/);
  assert.match(page, /data-live-painting/);
  assert.match(page, /data-phase="working"/);
  assert.match(debug, /data-phase="working"/);
  assert.match(debug, /data-debug-action="painting-reference"/);
  assert.match(debug, /data-debug-quad/);
  const button = {dataset: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name]; }};
  setControlPhase(button, 'working');
  assert.equal(button.dataset.phase, 'working');
  assert.equal(button.attrs['aria-busy'], 'true');
  setControlPhase(button, 'done');
  assert.equal(button.dataset.phase, 'done');
  assert.equal(button.attrs['aria-busy'], 'false');
  assert.equal(liveCornerLabel({manual: true, source: 'manual-lock'}), 'Corners: manual (locked)');
  assert.equal(liveCornerLabel({source: 'align'}), 'Corners: unlocked');
  assert.equal(livePaintingLabel({active: true, reference: {ready: true}}), 'Painting: on · bare learned');
  assert.equal(livePaintingLabel(null), 'Painting: off');
});
