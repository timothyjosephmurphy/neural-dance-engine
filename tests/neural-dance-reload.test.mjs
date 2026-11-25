// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {VERSION_PATH, isVersionPath} from '../worker/index.mjs';
import {NeuralDanceDebugRoom} from '../worker/neural-dance-debug.mjs';
import {createDebugCredentials} from '../neural-dance/debug-protocol.js';
import {createMarkerTracker, takeReloadLatch, writeReloadLatch} from '../neural-dance/camera-markers.js';
import {ensureDebugSession, loadDebugSession, readDebugSession, rotateDebugSession, shouldResumeDebug, writeDebugSession} from '../neural-dance/live-debug.js';
import {stampBuild} from '../scripts/build-pages.mjs';
import {
  LIVE_RESUME_KEY,
  LIVE_VERSION_MS,
  RELOAD_ATTEMPT_KEY,
  attemptResume,
  checkLiveVersion,
  failedResumeParts,
  readPageVersion,
  shortBuild,
  paintBuildLabel,
  reloadLivePage,
  resumePromptText,
  shouldReload,
  versionChanged
} from '../neural-dance/live-reload.js';

const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');

function memory() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

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
    send(data) { this.sent.push(String(data)); },
    close() { this.readyState = 3; }
  };
}

test('version.json is served no-store and the live page is stamped with the same build', async () => {
  assert.equal(isVersionPath(VERSION_PATH), true);
  assert.equal(isVersionPath(VERSION_PATH + '/'), true);
  assert.equal(isVersionPath('/neural-dance/live/'), false);
  let fetched = '';
  const env = {
    ASSETS: {
      fetch(request) {
        fetched = new URL(request.url).pathname;
        return new Response(JSON.stringify({version: 'abc1234'}), {
          headers: {'content-type': 'application/json', 'cache-control': 'public, max-age=3600'}
        });
      }
    }
  };
  const response = await worker.fetch(new Request('https://tjm.art/neural-dance/version.json'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  assert.equal(fetched, VERSION_PATH);
  assert.equal((await response.json()).version, 'abc1234');
  const page = await worker.fetch(new Request('https://tjm.art/neural-dance/live/'), env);
  assert.equal(await page.text(), JSON.stringify({version: 'abc1234'}));
  assert.equal(fetched, '/neural-dance/live/');
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.equal(stampBuild('<meta name="nd-build" content="__ND_BUILD__" />', 'deadbeef'), '<meta name="nd-build" content="deadbeef" />');
  assert.match(livePage, /name="nd-build" content="__ND_BUILD__"/);
  assert.match(livePage, /data-live-resume/);
  assert.match(livePage, /data-live-resume-go>Resume/);
  assert.match(livePage, /\/neural-dance\/live-page\.js/);
  assert.match(debugPage, /Reload live page/);
  assert.ok(LIVE_VERSION_MS >= 8000 && LIVE_VERSION_MS <= 12000);
});

test('a version change reloads once, after alignment, markers, and settings are saved', async () => {
  assert.equal(versionChanged('aaaa111', 'bbbb222'), true);
  assert.equal(versionChanged('aaaa111', 'aaaa111'), false);
  assert.equal(versionChanged('', 'bbbb222'), false);
  assert.equal(shouldReload('aaaa111', 'bbbb222', ''), true);
  assert.equal(shouldReload('aaaa111', 'bbbb222', 'bbbb222'), false);

  const local = memory();
  const session = memory();
  const calls = [];
  const doc = {
    body: {dataset: {}},
    fullscreenElement: {tag: 'html'},
    querySelector(sel) { return sel === 'meta[name="nd-build"]' ? {getAttribute() { return 'aaaa1111'; }} : null; },
    getElementById(id) {
      if (id === 'nd-camera-mode') {
        return {neuralDanceCamera: {
          isOpen() { return true; },
          captureLatch(storage) {
            writeReloadLatch(storage, {
              markersOn: true,
              markers: [{id: 4, x: 12, y: 40, kind: 'sticker'}],
              manuals: [{id: 500001, x: 80, y: 90, kind: 'sticker', manual: true}]
            });
            calls.push('latch');
          }
        }};
      }
      if (id === 'nd-room-lab') return {neuralDance: {micState() { return 'listening'; }, saveSettings() { calls.push('settings'); }}};
      return null;
    },
    dispatchEvent(event) { calls.push(event.type); },
    defaultView: {localStorage: local, location: {reload() { calls.push('reload'); }}}
  };
  const fetchImpl = async () => ({ok: true, json: async () => ({version: 'bbbb2222'})});
  assert.equal(await checkLiveVersion(doc, fetchImpl, session), true);
  assert.equal(calls.includes('latch'), true);
  assert.equal(calls.includes('settings'), true);
  assert.equal(calls.includes('nd-before-reload'), true);
  assert.equal(calls.includes('reload'), true);
  assert.equal(session.getItem(RELOAD_ATTEMPT_KEY), 'bbbb2222');
  const saved = JSON.parse(local.getItem(LIVE_RESUME_KEY));
  assert.equal(saved.pending, true);
  assert.equal(saved.camera, true);
  assert.equal(saved.mic, true);
  assert.equal(saved.projector, true);
  const latch = takeReloadLatch(local);
  assert.equal(latch.markersOn, true);
  assert.equal(latch.markers[0].id, 4);
  assert.equal(latch.manuals[0].id, 500001);
  assert.equal(takeReloadLatch(local), null);
  const tracker = createMarkerTracker();
  tracker.restore(latch.markers);
  assert.equal(tracker.stage()[0].x, 12);
  assert.equal(await checkLiveVersion(doc, fetchImpl, session), false);

  const same = memory();
  const quiet = {
    body: {dataset: {}},
    querySelector() { return {getAttribute() { return 'bbbb2222'; }}; },
    getElementById() { return null; },
    dispatchEvent() {},
    defaultView: {localStorage: same, location: {reload() { throw new Error('reloaded'); }}}
  };
  assert.equal(await checkLiveVersion(quiet, fetchImpl, memory()), false);
  assert.equal(readPageVersion(quiet), 'bbbb2222');
});

test('camera, mic, and projector permissions that fail after reload share one resume prompt', async () => {
  const doc = {
    fullscreenElement: null,
    documentElement: {requestFullscreen() { throw Object.assign(new Error('gesture'), {name: 'NotAllowedError'}); }},
    getElementById(id) {
      if (id === 'nd-camera-mode') {
        return {neuralDanceCamera: {async ensureCamera() { throw Object.assign(new Error('blocked'), {name: 'NotAllowedError'}); }}};
      }
      if (id === 'nd-room-lab') return {neuralDance: {async resumeMic() { return false; }}};
      return null;
    }
  };
  const needs = await attemptResume(doc, {camera: true, mic: true, micMuted: false, projector: true});
  assert.deepEqual(failedResumeParts(needs), ['camera', 'microphone', 'projector']);
  assert.equal(resumePromptText(failedResumeParts(needs)), 'Tap to resume the camera, microphone, and projector.');
  assert.equal(resumePromptText(['camera']), 'Tap to resume the camera.');
  const skipped = await attemptResume(doc, {camera: false, mic: false, projector: false});
  assert.deepEqual(failedResumeParts(skipped), []);
});

test('a debug reload message reaches the publisher and the room session reconnects', async () => {
  const ctx = {
    alarmAt: 0,
    storage: {
      sql: memorySql(),
      setAlarm(ts) { ctx.alarmAt = ts; return Promise.resolve(); }
    },
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); }
  };
  const instance = new NeuralDanceDebugRoom(ctx, {});
  await instance.ready;
  const session = createDebugCredentials();
  const storage = memory();
  assert.equal(shouldResumeDebug(null), false);
  assert.equal(writeDebugSession(storage, {...session, sharing: true}), true);
  assert.equal(shouldResumeDebug(readDebugSession(storage)), true);
  assert.equal(readDebugSession(storage).autoApply, true);
  const claimed = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/claim?room=' + session.room, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({room: session.room, publisherSecret: session.secret, viewerKey: session.key})
  }));
  assert.equal(claimed.status, 200);
  const publisher = fakeSocket();
  const viewer = fakeSocket();
  instance.attachSocket(publisher, 'publisher');
  instance.attachSocket(viewer, 'viewer');
  await instance.webSocketMessage(viewer, JSON.stringify({type: 'reload'}));
  assert.equal(JSON.parse(publisher.sent.at(-1)).type, 'reload');
  const http = await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/patch?room=' + session.room + '&key=' + session.key, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({patch: {action: 'reload'}})
  }));
  assert.equal(http.status, 200);
  assert.equal((await http.json()).reload, true);
  assert.equal(JSON.parse(publisher.sent.at(-1)).type, 'reload');
  const snap = await (await instance.fetch(new Request('https://tjm.art/api/neural-dance/debug/snapshot?room=' + session.room + '&key=' + session.key))).json();
  assert.equal(snap.pendingPatch, null);
  const queuedCtx = {
    alarmAt: 0,
    storage: {
      sql: memorySql(),
      setAlarm() { return Promise.resolve(); }
    },
    blockConcurrencyWhile(fn) { return Promise.resolve(fn()); }
  };
  const queued = new NeuralDanceDebugRoom(queuedCtx, {});
  await queued.ready;
  const other = createDebugCredentials();
  await queued.fetch(new Request('https://tjm.art/api/neural-dance/debug/claim?room=' + other.room, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({room: other.room, publisherSecret: other.secret, viewerKey: other.key})
  }));
  const parked = await queued.fetch(new Request('https://tjm.art/api/neural-dance/debug/patch?room=' + other.room + '&key=' + other.key, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({patch: {action: 'reload'}})
  }));
  assert.equal((await parked.json()).reload, true);
  const delivered = await queued.fetch(new Request('https://tjm.art/api/neural-dance/debug/frame?room=' + other.room + '&secret=' + other.secret, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({telemetry: {t: 1}})
  }));
  assert.equal((await delivered.json()).reload, true);
  const once = await queued.fetch(new Request('https://tjm.art/api/neural-dance/debug/frame?room=' + other.room + '&secret=' + other.secret, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({telemetry: {t: 2}})
  }));
  assert.equal((await once.json()).reload, false);
  const doc = {
    body: {dataset: {}},
    fullscreenElement: null,
    getElementById() { return null; },
    dispatchEvent() {},
    defaultView: {location: {reload() { doc.reloaded = true; }}}
  };
  assert.equal(reloadLivePage(doc, memory()), true);
  assert.equal(doc.reloaded, true);
  assert.equal(reloadLivePage(doc, memory()), false);
});

test('the debug room id and key stay in localStorage until New debug link', () => {
  const storage = memory();
  const first = ensureDebugSession(storage);
  assert.equal(ensureDebugSession(storage).room, first.room);
  assert.equal(ensureDebugSession(storage).key, first.key);
  const legacy = memory();
  writeDebugSession(legacy, {...first, sharing: true});
  const primary = memory();
  const moved = loadDebugSession(primary, legacy);
  assert.equal(moved.room, first.room);
  assert.equal(readDebugSession(primary).key, first.key);
  assert.equal(shouldResumeDebug(readDebugSession(primary)), true);
  const spun = rotateDebugSession(primary);
  assert.notEqual(spun.room, first.room);
  assert.notEqual(spun.secret, first.secret);
  assert.equal(ensureDebugSession(primary).room, spun.room);
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(page, /data-debug-rotate/);
  assert.match(page, /New debug link/);
  assert.match(source, /localStorage/);
  assert.doesNotMatch(source, /console\.(log|debug|info|warn)\(/);
  assert.equal(source.includes(first.secret), false);
});

test('shortBuild shows seven characters and paint fills the label', () => {
  assert.equal(shortBuild('551d1ee94f8f954eb314107a5c015853d83bbdb0'), '551d1ee');
  const label = {hidden: true, textContent: '', title: '', setAttribute() {}};
  const doc = {
    querySelector(sel) {
      if (sel === 'meta[name="nd-build"]') return {getAttribute() { return '551d1ee94f8f954eb314107a5c015853d83bbdb0'; }};
      return null;
    },
    querySelectorAll(sel) { return sel === '[data-nd-build]' ? [label] : []; }
  };
  assert.equal(paintBuildLabel(doc), '551d1ee');
  assert.equal(label.textContent, '551d1ee');
  assert.equal(label.hidden, false);
});
