// Share live debug stays off until asked, then the viewer page and a tuning banner work.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {mkdirSync} from 'node:fs';

const leaks = [];
process.on('unhandledRejection', (reason) => {
  leaks.push(reason instanceof Error ? reason.message : String(reason));
});

const root = new URL('..', import.meta.url).pathname;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'};

function pageHtml(source) {
  return source.replace(/^---[\s\S]*?---\n/, '').replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
}

const liveHtml = pageHtml(await readFile(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8'));
const debugHtml = pageHtml(await readFile(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8'));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/neural-dance/live/' || url.pathname === '/neural-dance/live/index.html') {
      res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
      return res.end(liveHtml);
    }
    if (url.pathname === '/neural-dance/debug/' || url.pathname === '/neural-dance/debug/index.html') {
      res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
      return res.end(debugHtml);
    }
    const path = decodeURIComponent(url.pathname);
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const ARTIFACTS = (() => {
  for (const d of ['/opt/cursor/artifacts', '/tmp/nd-artifacts']) {
    try { mkdirSync(d, {recursive: true}); return d; } catch {}
  }
  throw new Error('no writable artifacts dir');
})();
const browser = await chromium.launch();
const pageErrors = [];
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__ndWs = [];
    window.__ndFetch = [];
    window.__wake = [];
    window.__wakeSentinels = [];
    const wake = {request: async (type) => {
      window.__wake.push(type);
      const sentinel = {addEventListener(name, fn) { if (name === 'release') sentinel.onrelease = fn; }, release() {}};
      window.__wakeSentinels.push(sentinel);
      return sentinel;
    }};
    try { Object.defineProperty(navigator, 'wakeLock', {configurable: true, get: () => wake}); } catch { /* the page still loads */ }
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (String(url).includes('/api/neural-dance/debug/')) window.__ndFetch.push(String(url));
      return original.apply(this, arguments);
    };
    class Sock {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        window.__ndWs.push(this);
      }
      send(data) { this.sent.push(String(data)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    }
    window.WebSocket = Sock;
  });
  await page.goto(origin + '/neural-dance/live/', {waitUntil: 'load'});
  await page.waitForFunction(() => document.body.dataset.debugReady === '1' && document.getElementById('nd-room-lab')?.dataset.roomReady === '1');
  await page.waitForFunction(() => window.__wake.includes('screen') && document.querySelector('[data-wake-note]') && document.querySelector('[data-wake-note]').hidden === true);
  await page.evaluate(() => { const s = window.__wakeSentinels[0]; if (s && s.onrelease) s.onrelease(); });
  await page.waitForFunction(() => document.querySelector('[data-wake-note]').hidden === false && document.querySelector('[data-wake-note]').textContent === 'screen may sleep');
  const wakesBeforeTap = await page.evaluate(() => window.__wake.length);
  await page.locator('body').click();
  await page.waitForFunction((n) => window.__wake.length > n && document.querySelector('[data-wake-note]').hidden === true, wakesBeforeTap);
  const before = await page.evaluate(() => ({
    pressed: document.querySelector('[data-debug-share]').getAttribute('aria-pressed'),
    label: document.querySelector('[data-debug-share]').textContent,
    panel: document.querySelector('[data-debug-panel]').hidden,
    auto: document.querySelector('[data-debug-auto]').checked,
    sockets: window.__ndWs.length,
    fetches: window.__ndFetch.length,
    personHidden: document.querySelector('[data-person-note]').hidden,
    personText: document.querySelector('[data-person-note]').textContent
  }));
  assert.equal(before.pressed, 'false');
  assert.equal(before.personHidden, true);
  assert.equal(before.personText, 'person in frame, detection paused');
  assert.equal(before.label, 'Share live debug');
  assert.equal(before.panel, true);
  assert.equal(before.auto, true);
  assert.equal(before.sockets, 0);
  assert.equal(before.fetches, 0);

  // Build stamp must stay visible when controls are hidden (projector show mode).
  await page.evaluate(() => {
    const meta = document.querySelector('meta[name="nd-build"]');
    if (meta) meta.setAttribute('content', '1e34421aa856347c51c274c23065b293643b23b5');
    const stamp = document.querySelector('[data-nd-build]');
    if (stamp) {
      stamp.hidden = false;
      stamp.textContent = '1e34421';
      stamp.title = 'Build 1e34421aa856347c51c274c23065b293643b23b5';
    }
    document.body.classList.add('nd-live-hidden');
    const chrome = document.querySelector('.nd-live-chrome');
    if (chrome) chrome.hidden = true;
  });
  const stampVis = await page.evaluate(() => {
    const el = document.querySelector('[data-nd-build]');
    if (!el) return {ok: false, reason: 'missing'};
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      ok: true,
      text: el.textContent,
      display: style.display,
      visibility: style.visibility,
      width: r.width,
      height: r.height,
      bottom: r.bottom,
      right: r.right,
      inChrome: !!el.closest('.nd-live-chrome')
    };
  });
  assert.equal(stampVis.ok, true, 'build stamp element missing');
  assert.equal(stampVis.inChrome, false);
  assert.notEqual(stampVis.display, 'none');
  assert.notEqual(stampVis.visibility, 'hidden');
  assert.ok(stampVis.width > 4 && stampVis.height > 4, JSON.stringify(stampVis));
  assert.match(stampVis.text, /1e34421/);
  mkdirSync(ARTIFACTS, {recursive: true});
  await page.screenshot({path: `${ARTIFACTS}/neural-dance-build-stamp-hidden-controls.png`});
  await page.evaluate(() => {
    document.body.classList.remove('nd-live-hidden');
    const chrome = document.querySelector('.nd-live-chrome');
    if (chrome) chrome.hidden = false;
  });

  await page.locator('[data-debug-advanced] summary').click();
  await page.locator('[data-debug-share]').click();
  await page.waitForFunction(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('"type":"frame"'))));
  const shared = await page.evaluate(() => {
    const link = document.querySelector('[data-debug-link]');
    return {
      pressed: document.querySelector('[data-debug-share]').getAttribute('aria-pressed'),
      code: document.querySelector('[data-debug-code]').textContent,
      href: link.getAttribute('href'),
      hidden: document.querySelector('[data-debug-panel]').hidden,
      socket: window.__ndWs[0].url
    };
  });
  assert.equal(shared.pressed, 'true');
  assert.equal(shared.hidden, false);
  assert.match(shared.code, /^ND-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.match(shared.href, new RegExp('/neural-dance/debug/\\?room=' + shared.code + '&key='));
  assert.equal(shared.href.includes('secret'), false);
  assert.match(shared.socket, /role=publisher/);
  assert.match(shared.socket, /secret=/);
  await page.screenshot({path: `${ARTIFACTS}/neural-dance-debug-share.png`});

  await page.evaluate(() => {
    const socket = window.__ndWs[0];
    socket.onmessage({data: JSON.stringify({
      type: 'propose_patch',
      patchId: 1,
      pendingPatch: {id: 1, at: 10, patch: {noteSensitivity: 0.91, quietThreshold: 0.22}}
    })});
  });
  await page.waitForFunction(() => document.querySelector('[data-control="sat"]').value === '0.91' && document.querySelector('[data-debug-banner]').hidden === true);
  const applied = await page.evaluate(() => ({
    note: document.querySelector('[data-control="sat"]').value,
    quiet: document.querySelector('[data-control="quiet"]').value,
    size: document.querySelector('[data-control="size"]').value
  }));
  assert.equal(applied.note, '0.91');
  assert.equal(applied.quiet, '0.22');
  assert.equal(applied.size, '22');
  await page.locator('[data-debug-auto]').uncheck();

  await page.evaluate(() => {
    window.__ndWs[0].onmessage({data: JSON.stringify({
      type: 'propose_patch',
      patchId: 2,
      pendingPatch: {id: 2, at: 11, patch: {minBlobSize: 40}}
    })});
  });
  await page.waitForFunction(() => document.querySelector('[data-debug-banner]').hidden === false);
  assert.match(await page.locator('[data-debug-banner-text]').innerText(), /Suggested tuning received/);
  await page.locator('[data-debug-dismiss]').click();
  assert.equal(await page.locator('[data-control="size"]').inputValue(), '22');
  assert.equal(await page.locator('[data-debug-banner]').isHidden(), true);
  await page.evaluate(() => {
    window.__cmds = [];
    const api = document.getElementById('nd-camera-mode') && document.getElementById('nd-camera-mode').neuralDanceCamera;
    if (!api || typeof api.applyShowCommand !== 'function') throw new Error('camera commands missing');
    const orig = api.applyShowCommand.bind(api);
    api.applyShowCommand = (command) => {
      window.__cmds.push(command && command.action);
      try { return orig(command); } catch (err) { window.__cmdErr = String(err); }
    };
    window.__ndWs[0].onmessage({data: JSON.stringify({
      type: 'propose_patch',
      patchId: 3,
      pendingPatch: {id: 3, at: 12, patch: {action: 'frame-detect', cmd: 'abcd1234'}}
    })});
  });
  await page.waitForFunction(() => (window.__cmds || []).includes('frame-detect'));

  await page.goto(origin + shared.href, {waitUntil: 'load'});
  await page.waitForFunction(() => document.body.dataset.viewerReady === '1' && document.querySelector('[data-debug-app]').hidden === false);
  const viewer = await page.evaluate(() => ({
    robots: document.querySelector('meta[name="robots"]').content,
    title: document.querySelector('h1').textContent,
    camera: document.querySelector('[data-debug-camera]').width,
    stage: document.querySelector('[data-debug-stage]').getAttribute('width'),
    missing: document.querySelector('[data-debug-missing]').hidden,
    header: document.querySelector('.site-header, footer')
  }));
  assert.match(viewer.robots, /noindex/);
  assert.match(viewer.title, /Neural Dance debug/);
  assert.equal(viewer.camera, 480);
  assert.equal(viewer.stage, '480');
  assert.equal(viewer.missing, true);
  assert.equal(viewer.header, null);
  await page.evaluate(() => {
    const socket = window.__ndWs.at(-1);
    socket.onmessage({data: JSON.stringify({
      type: 'frame',
      telemetry: {
        t: 1, fps: 8, videoWidth: 1920, videoHeight: 1080, detectWidth: 480, detectHeight: 253,
        cameraLabel: 'iPhone Camera', facingMode: 'environment', aligned: true,
        quad: [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}],
        quadMedianRgb: [40, 50, 60],
        pink: [{grid: [120, 80], stage: [200, 140], area: 42, rgb: [240, 180, 210], luminanceRatio: 1.4}],
        stickers: [{grid: [300, 100], stage: [640, 220], area: 18, rgb: [12, 14, 16], luminanceRatio: 0.2}],
        markers: [{id: 1, x: 200, y: 140, kind: 'pink'}],
        audio: {source: 'mic', kick: 0.4, bass: 0.7, snare: 0.2, hat: 0.1, silenceGate: false, noiseFloor: 0.04, micGain: 1},
        controls: {markerMode: 'both', noteSensitivity: 0.91, stickerSensitivity: 0.5, hueTolerance: 48, minBlobSize: 18, maxBlobSize: 160, quietThreshold: 0.22}
      }
    })});
  });
  await page.waitForFunction(() => document.querySelector('[data-debug-summary]').textContent.includes('iPhone Camera'));
  assert.match(await page.locator('[data-debug-summary]').innerText(), /quad RGB 40 50 60/);
  assert.match(await page.locator('[data-debug-table]').innerText(), /pink/);
  assert.match(await page.locator('[data-debug-gate]').innerText(), /open/);
  await page.locator('[data-debug-send]').click();
  const proposed = await page.evaluate(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('propose_patch') && body.includes('noteSensitivity'))));
  assert.equal(proposed, true);
  assert.equal(await page.locator('[data-debug-action="align"]').count(), 1);
  assert.equal(await page.locator('[data-debug-action="clear-sim"]').count(), 1);
  assert.equal(await page.locator('[data-debug-action="sim-seed"]').count(), 1);
  assert.equal(await page.locator('[data-debug-control="gravity"]').count(), 1);
  await page.locator('[data-debug-action="clear-sim"]').click();
  const cleared = await page.evaluate(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('clear-sim'))));
  assert.equal(cleared, true);
  await page.locator('[data-debug-stage]').click({position: {x: 80, y: 60}});
  const added = await page.evaluate(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('add-manual-sticker'))));
  assert.equal(added, true);
  assert.equal(await page.locator('[data-person-note]').isHidden(), true);
  await page.screenshot({path: `${ARTIFACTS}/neural-dance-debug-viewer.png`});
  const stageBox = await page.locator('[data-debug-stage]').boundingBox();
  const tap = {x: Math.round(stageBox.width * 0.25), y: Math.round(stageBox.height * 0.4)};
  await page.evaluate(() => {
    const socket = window.__ndWs.at(-1);
    socket.onmessage({data: JSON.stringify({
      type: 'frame',
      telemetry: {
        markers: [{id: 500001, x: 250, y: 248, kind: 'sticker', manual: true}],
        occlusion: {paused: true, note: 'person in frame, detection paused'}
      }
    })});
  });
  await page.waitForFunction(() => document.querySelector('[data-person-note]').hidden === false);
  assert.equal((await page.locator('[data-person-note]').innerText()).trim(), 'person in frame, detection paused');
  await page.locator('[data-debug-stage]').click({position: tap});
  const toggled = await page.evaluate(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('remove-manual-sticker'))));
  assert.equal(toggled, false, 'a plain tap must not remove a manual marker');
  await page.locator('[data-debug-remove-mode]').click();
  await page.locator('[data-debug-stage]').click({position: tap});
  const removed = await page.evaluate(() => window.__ndWs.some(socket => socket.sent.some(body => body.includes('remove-manual-sticker') && body.includes('500001'))));
  assert.equal(removed, true);

  await page.goto(origin + '/neural-dance/live/', {waitUntil: 'load'});
  await page.waitForFunction((code) => document.querySelector('[data-debug-code]')?.textContent === code, shared.code);
  // Hide controls must hide the controls (3:14 PM PT rig report).
  await page.evaluate(() => document.querySelector('[data-live="hide"]').click());
  const hiddenState = await page.evaluate(() => ({
    cls: document.body.classList.contains('nd-live-hidden'),
    chrome: getComputedStyle(document.querySelector('.nd-live-chrome')).display
  }));
  assert.equal(hiddenState.cls, true);
  assert.equal(hiddenState.chrome, 'none');
  await page.evaluate(() => document.querySelector('[data-live="reveal"]').click());
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.nd-live-chrome')).display), 'none');
  const stable = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('nd.liveDebug.v1'));
    return {
      href: document.querySelector('[data-debug-link]').getAttribute('href'),
      secret: saved.secret,
      html: document.documentElement.innerHTML
    };
  });
  assert.match(stable.href, new RegExp('room=' + shared.code));
  assert.equal(stable.html.includes(stable.secret), false);
  await page.locator('[data-debug-rotate]').click();
  const rotated = await page.locator('[data-debug-link]').getAttribute('href');
  assert.notEqual(rotated, stable.href);
  assert.equal((await page.content()).includes(stable.secret), false);

  const touch = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true});
  const tpage = await touch.newPage();
  tpage.on('pageerror', (error) => pageErrors.push(error.message));
  await tpage.addInitScript(() => {
    window.__ndWs = [];
    class Sock {
      constructor() { this.readyState = 1; this.sent = []; window.__ndWs.push(this); }
      send(data) { this.sent.push(String(data)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    }
    window.WebSocket = Sock;
    navigator.mediaDevices = {getUserMedia: () => Promise.reject(new Error('no mic'))};
  });
  await tpage.goto(origin + shared.href, {waitUntil: 'load'});
  await tpage.waitForFunction(() => document.body.dataset.viewerReady === '1' && window.__ndWs.length > 0);
  const paint = '[data-debug-painting-panel] ';
  for (const [sel, action, label] of [
    ['[data-debug-action="frame-detect"]', 'frame-detect', 'Detect frame'],
    ['[data-debug-frame-accept]', 'frame-accept', 'Accept frame'],
    ['[data-debug-action="frame-retry"]', 'frame-retry', 'Retry'],
    ['[data-debug-action="painting-reference"]', 'painting-reference', 'Re-learn bare painting'],
    ['[data-debug-action="frame-clear"]', 'frame-clear', 'Painting off'],
    ['[data-debug-sticker-color="dark"]', 'sticker-color', 'Stickers: dark'],
    ['[data-debug-sticker-color="white"]', 'sticker-color', 'Stickers: white'],
    ['[data-debug-sticker-color="auto"]', 'sticker-color', 'Stickers: auto'],
    ['[data-debug-action="scan-stickers"]', 'scan-stickers', 'Scan stickers']
  ]) {
    const before = await tpage.evaluate(() => window.__ndWs.reduce((n, s) => n + s.sent.length, 0));
    await tpage.locator(paint + sel).first().click();
    await tpage.waitForFunction((text) => (document.querySelector('[data-debug-painting-status]').textContent || '').includes(text), 'sent ' + label + ', waiting for the phone');
    await tpage.waitForFunction(({start, name}) => window.__ndWs.flatMap(s => s.sent).slice(start).some(body => body.includes('"action":"' + name + '"')), {start: before, name: action});
  }
  await tpage.waitForFunction(() => {
    const button = document.querySelector('[data-debug-corners-mode]');
    return !!(button && button.getAttribute('aria-pressed') === 'true' && /Corners mode: on/.test(button.textContent || ''));
  });
  await tpage.locator(paint + '[data-debug-corners-mode]').click();
  await tpage.waitForFunction(() => /Corners mode off/.test(document.querySelector('[data-debug-painting-status]').textContent || ''));
  const buttons = tpage.locator('[data-debug-app] button:visible');
  const count = await buttons.count();
  assert.ok(count >= 8, 'debug controls missing');
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    await button.scrollIntoViewIfNeeded();
    const label = (await button.innerText()).trim();
    const hit = await button.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!(top && (top === el || el.contains(top)));
    });
    assert.equal(hit, true, label + ' is covered');
    const before = await tpage.evaluate(() => window.__ndWs.reduce((n, s) => n + s.sent.length, 0));
    // Local view toggles (Remove mode, Corners mode, the first tap of the
    // two-step Clear) change the page only. Everything else sends a patch.
    // Heartbeats may land in the same window, so the check is "a patch was
    // added", not "the socket grew by exactly one message".
    const local = await button.evaluate(el => el.hasAttribute('data-debug-local'));
    await button.tap();
    if (local) continue;
    await tpage.waitForFunction((start) => {
      const added = window.__ndWs.flatMap(s => s.sent).slice(start);
      return added.some(body => body.includes('propose_patch') || body.includes('"type":"reload"'));
    }, before, {timeout: 3000}).catch(() => { throw new Error(label + ': tap sent no patch'); });
  }
  await touch.close();

  const studioKey = 'studio-key-correct-value';
  const studio = await browser.newContext();
  const spage = await studio.newPage();
  spage.on('pageerror', (error) => pageErrors.push(error.message));
  await spage.addInitScript(() => {
    window.__ndWs = [];
    window.__ndFetch = [];
    const original = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (String(url).includes('/api/neural-dance/debug/')) window.__ndFetch.push(String(url));
      return original.apply(this, arguments);
    };
    class Sock {
      constructor(url) {
        this.url = String(url);
        this.readyState = 1;
        this.sent = [];
        window.__ndWs.push(this);
      }
      send(data) { this.sent.push(String(data)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    }
    window.WebSocket = Sock;
  });
  await spage.goto(origin + '/neural-dance/live/#k=' + studioKey, {waitUntil: 'load'});
  await spage.waitForFunction((key) => {
    const socket = window.__ndWs.find(item => item.url.includes('room=studio') && item.url.includes('role=publisher') && item.url.includes('key=' + key));
    return !!socket && location.hash === '' && localStorage.getItem('nd.studioDebug.v1') === key;
  }, studioKey);
  const paired = await spage.evaluate(() => ({
    pressed: document.querySelector('[data-debug-share]').getAttribute('aria-pressed'),
    label: document.querySelector('[data-debug-share]').textContent,
    panel: document.querySelector('[data-debug-panel]').hidden,
    claims: window.__ndFetch.filter(url => url.includes('/claim')).length,
    html: document.documentElement.innerHTML
  }));
  assert.equal(paired.pressed, 'false');
  assert.equal(paired.label, 'Share live debug');
  assert.equal(paired.panel, true);
  assert.equal(paired.claims, 0);
  assert.equal(paired.html.includes(studioKey), false);
  await spage.goto(origin + '/neural-dance/debug/', {waitUntil: 'load'});
  await spage.evaluate(() => {
    localStorage.setItem('nd.liveDebug.v1', JSON.stringify({
      room: 'ND-ABCDEF',
      secret: 'abcdefghijklmnop-SECRET',
      key: 'abcdefghijklmnop-VIEWER',
      autoApply: true,
      sharing: true
    }));
  });
  await spage.goto(origin + '/neural-dance/live/#k=' + studioKey, {waitUntil: 'load'});
  await spage.waitForFunction((key) => {
    const open = window.__ndWs.filter(item => item.readyState === 1);
    const saved = JSON.parse(localStorage.getItem('nd.liveDebug.v1') || '{}');
    return open.length === 1 && open[0].url.includes('room=studio') && open[0].url.includes('key=' + key) && saved.sharing === false && location.hash === '';
  }, studioKey);
  await spage.goto(origin + '/neural-dance/live/', {waitUntil: 'load'});
  await spage.waitForFunction((key) => window.__ndWs.some(item => item.url.includes('room=studio') && item.url.includes('key=' + key)), studioKey);
  await spage.locator('[data-debug-advanced] summary').click();
  await spage.locator('[data-debug-share]').click();
  await spage.waitForFunction(() => window.__ndWs.some(item => /room=ND-/.test(item.url) && item.url.includes('secret=')));
  assert.equal(await spage.locator('[data-debug-share]').getAttribute('aria-pressed'), 'true');
  await spage.locator('[data-debug-share]').click();
  await spage.waitForFunction((key) => {
    const sockets = window.__ndWs.filter(item => item.readyState === 1);
    return sockets.length === 1 && sockets[0].url.includes('room=studio') && sockets[0].url.includes('key=' + key);
  }, studioKey);
  assert.equal(await spage.locator('[data-debug-share]').getAttribute('aria-pressed'), 'false');
  await spage.goto(origin + '/neural-dance/debug/', {waitUntil: 'load'});
  await spage.waitForFunction(() => document.querySelector('[data-debug-app]').hidden === false && document.querySelector('[data-debug-room]').textContent === 'studio');
  const studioView = await spage.evaluate((key) => ({
    hash: location.hash,
    search: location.search,
    socket: window.__ndWs.at(-1).url,
    saved: localStorage.getItem('nd.studioDebug.v1')
  }), studioKey);
  assert.equal(studioView.hash, '');
  assert.equal(studioView.search, '');
  assert.match(studioView.socket, new RegExp('room=studio'));
  assert.match(studioView.socket, new RegExp('role=viewer'));
  assert.match(studioView.socket, new RegExp('key=' + studioKey));
  assert.equal(studioView.saved, studioKey);
  await studio.close();

  const debugOnly = await browser.newContext();
  const dpage = await debugOnly.newPage();
  dpage.on('pageerror', (error) => pageErrors.push(error.message));
  await dpage.addInitScript(() => {
    window.__ndWs = [];
    class Sock {
      constructor(url) {
        this.url = String(url);
        this.readyState = 1;
        this.sent = [];
        window.__ndWs.push(this);
      }
      send(data) { this.sent.push(String(data)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    }
    window.WebSocket = Sock;
  });
  await dpage.goto(origin + '/neural-dance/debug/#k=' + studioKey, {waitUntil: 'load'});
  await dpage.waitForFunction((key) => {
    return location.hash === '' && location.search === '' && localStorage.getItem('nd.studioDebug.v1') === key
      && window.__ndWs.some(item => item.url.includes('room=studio') && item.url.includes('role=viewer') && item.url.includes('key=' + key))
      && !document.documentElement.innerHTML.includes(key);
  }, studioKey);
  await dpage.goto(origin + '/neural-dance/debug/', {waitUntil: 'load'});
  await dpage.waitForFunction(() => document.querySelector('[data-debug-room]').textContent === 'studio' && location.hash === '' && location.search === '');
  const plain = await dpage.evaluate((key) => window.__ndWs.some(item => item.url.includes('room=studio') && item.url.includes('key=' + key)), studioKey);
  assert.equal(plain, true);
  await debugOnly.close();

  await page.goto(origin + '/neural-dance/debug/', {waitUntil: 'load'});
  const bare = await page.evaluate(() => ({
    missing: document.querySelector('[data-debug-missing]').hidden === false,
    app: document.querySelector('[data-debug-app]').hidden,
    sockets: window.__ndWs.length,
    fetches: window.__ndFetch.length
  }));
  assert.equal(bare.missing, true);
  assert.equal(bare.app, true);
  assert.equal(bare.sockets, 0);
  assert.equal(bare.fetches, 0);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(leaks, []);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
