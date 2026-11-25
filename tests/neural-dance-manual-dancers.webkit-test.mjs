// Manual dancers on the debug screen, acceptance (TJ Nov 11 4:31/4:32 PM).
// WebKit iPhone 16 Pro emulation (402x874 CSS, DPR 3, touch): place three
// dancers by tapping the camera feed, move one by dragging, check a plain
// tap never removes, remove one through its X (confirm) and keep one on a
// dismissed long-press confirm, then run a scan and check the manual
// dancers survive it. The phone side runs here in node with the real
// manual-sticker store and latch merge, fed by the debug page's patches.
import {webkit, devices} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createManualStickers, mergeLatchedStickers} from '../neural-dance/src/debug-manual-stickers.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {stageToCamera} from '../neural-dance/src/debug-manual-dancers.js';

const root = new URL('..', import.meta.url).pathname;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'};
const debugHtml = (await readFile(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8')).replace(/^---[\s\S]*?---\n/, '').replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/neural-dance/debug/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(debugHtml); }
    const file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'});
    res.end(body);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const ARTIFACTS = (() => { for (const d of ['/opt/cursor/artifacts', '/tmp/nd-artifacts']) { try { mkdirSync(d, {recursive: true}); return d; } catch {} } return '/tmp'; })();

const QUAD = [{x: 0.12, y: 0.1}, {x: 0.9, y: 0.14}, {x: 0.86, y: 0.9}, {x: 0.1, y: 0.86}];
const AUTO = [{id: 7, x: 820, y: 120, kind: 'sticker'}];   // one auto-latched marker
const manuals = createManualStickers();
let markers = mergeLatchedStickers(AUTO, manuals.list());
let ack = null, seen = 0;
const errors = [];

const browser = await webkit.launch();
const context = await browser.newContext({...devices['iPhone 16 Pro']});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__ndWs = [];
  class Sock { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; window.__ndWs.push(this); } send(d) { this.sent.push(String(d)); } close() { this.readyState = 3; } }
  window.WebSocket = Sock;
});
await page.goto(origin + '/neural-dance/debug/?room=ND-ABCDEF&key=k-test-viewer-key-123456', {waitUntil: 'load'});
await page.waitForFunction(() => document.body.dataset.viewerReady === '1' && window.__ndWs.length > 0);

async function telemetry() {
  await page.evaluate(([markers, quad, ack]) => {
    window.__ndWs.at(-1).onmessage({data: JSON.stringify({type: 'frame', telemetry: {t: Date.now(), detectWidth: 480, detectHeight: 253, aligned: true, quad, markers, manualAck: ack}})});
  }, [markers, QUAD, ack]);
}
// Phone side: apply every new patch the page sent, publish telemetry + ack.
async function pump() {
  const sent = await page.evaluate(() => window.__ndWs.at(-1).sent.slice());
  const fresh = sent.slice(seen); seen = sent.length;
  const out = [];
  for (const body of fresh) {
    const msg = JSON.parse(body);
    const patch = sanitizeDebugPatch(msg.patch);
    if (!patch) continue;
    out.push(patch);
    if (/manual-sticker$/.test(patch.action)) {
      const r = manuals.apply(patch);
      const hit = r.added || r.moved || r.removed;
      ack = {nonce: patch.nonce || '', action: patch.action, ok: !!r.changed, id: hit ? hit.id : 0};
    }
    if (patch.action === 'scan-stickers') {
      // A scan re-latches auto markers; manual ones are merged back on top.
      markers = mergeLatchedStickers([{id: 8, x: 150, y: 500, kind: 'sticker'}], manuals.list());
    } else markers = mergeLatchedStickers(markers.filter(m => !m.manual), manuals.list());
  }
  await telemetry();
  return out;
}
async function feedPoint(stage) {
  const box = await page.locator('[data-debug-camera]').boundingBox();
  const c = stageToCamera(stage.x, stage.y, QUAD);
  return {x: box.x + c.x * box.width, y: box.y + c.y * box.height};
}
const touch = async (p) => { await page.touchscreen.tap(p.x, p.y); };
async function drag(from, to, holdMs = 0) {
  // WebKit touch drag via pointer events (touchscreen has no move API).
  await page.evaluate(async ([from, to, holdMs]) => {
    const el = document.querySelector('[data-debug-camera]');
    const fire = (type, p) => el.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y}));
    fire('pointerdown', from);
    if (holdMs) await new Promise(r => setTimeout(r, holdMs));
    for (let i = 1; i <= 6; i++) fire('pointermove', {x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6});
    fire('pointerup', to);
  }, [from, to, holdMs]);
}
const status = () => page.locator('[data-debug-dancer-status]').innerText();
const near = (a, b, r = 12) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

try {
  await telemetry();
  await page.locator('[data-debug-camera]').scrollIntoViewIfNeeded();
  // Safe area / layout: nothing wider than the 402 px screen.
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(wide <= 402, 'debug page overflows the iPhone 16 Pro width: ' + wide);

  // 1) Place three dancers.
  const spots = [{x: 300, y: 200}, {x: 520, y: 330}, {x: 700, y: 460}];
  for (const s of spots) {
    await touch(await feedPoint(s));
    const patches = await pump();
    assert.equal(patches.length, 1, 'one patch per tap');
    assert.equal(patches[0].action, 'add-manual-sticker');
    assert.ok(Math.abs(patches[0].x - s.x) < 8 && Math.abs(patches[0].y - s.y) < 8, `tap mapped to ${patches[0].x},${patches[0].y} not ${s.x},${s.y}`);
    await page.waitForFunction(() => /placed \u2713/.test(document.querySelector('[data-debug-dancer-status]').textContent));
  }
  assert.equal(manuals.list().length, 3);
  const [d1, d2, d3] = manuals.list();

  // 2) A plain tap on a dancer selects it; it never removes it.
  await touch(await feedPoint(d1));
  assert.deepEqual(await pump(), []);
  assert.equal(manuals.list().length, 3);
  assert.match(await status(), new RegExp('#' + d1.id + ' selected'));
  await touch(await feedPoint({x: 100, y: 560})); await pump(); // tap elsewhere = deselect only
  assert.equal(manuals.list().length, 3, 'deselect tap must not place');

  // 3) Drag dancer 2 to a new spot.
  const to = {x: 560, y: 220};
  await drag(await feedPoint(d2), await feedPoint(to));
  const moved = await pump();
  assert.equal(moved.length, 1); assert.equal(moved[0].action, 'move-manual-sticker'); assert.equal(moved[0].id, d2.id);
  assert.ok(near(manuals.list().find(m => m.id === d2.id), to), 'dancer 2 moved');
  await page.waitForFunction(() => /moved \u2713/.test(document.querySelector('[data-debug-dancer-status]').textContent));

  // 4) Long-press dancer 1, dismiss the confirm: kept.
  page.once('dialog', d => d.dismiss());
  await drag(await feedPoint(d1), await feedPoint(d1), 700);
  assert.deepEqual(await pump(), []);
  assert.equal(manuals.list().length, 3, 'dismissed confirm keeps the dancer');

  // 5) Select dancer 3, tap its X, accept: removed.
  await touch(await feedPoint(d3)); await pump();
  const x = page.locator('[data-debug-dancer-x]');
  await x.waitFor({state: 'visible'});
  const xb = await x.boundingBox();
  assert.ok(xb.width >= 44 && xb.height >= 44, 'X is a 44 px target');
  page.once('dialog', d => d.accept());
  await page.touchscreen.tap(xb.x + xb.width / 2, xb.y + xb.height / 2);
  const removed = await pump();
  assert.equal(removed.length, 1); assert.equal(removed[0].action, 'remove-manual-sticker'); assert.equal(removed[0].id, d3.id);
  assert.deepEqual(manuals.list().map(m => m.id).sort(), [d1.id, d2.id].sort());
  await page.waitForFunction(() => /removed \u2713/.test(document.querySelector('[data-debug-dancer-status]').textContent));

  // 6) Scan: auto markers are re-latched, manual dancers survive.
  await page.locator('[data-debug-action="scan-stickers"]').first().tap();
  const scan = await pump();
  assert.ok(scan.some(p => p.action === 'scan-stickers'));
  assert.deepEqual(markers.filter(m => m.manual).map(m => m.id).sort(), [d1.id, d2.id].sort(), 'manual dancers survive the scan');
  assert.ok(near(markers.find(m => m.id === d2.id), to), 'moved dancer kept its spot through the scan');

  // 7) Landscape: the tap mapping still lands where the finger is.
  await page.setViewportSize({width: 874, height: 402});
  await telemetry();
  await page.locator('[data-debug-camera]').scrollIntoViewIfNeeded();
  const land = {x: 420, y: 520};
  await touch(await feedPoint(land));
  const lp = await pump();
  assert.equal(lp.length, 1); assert.ok(Math.abs(lp[0].x - land.x) < 8 && Math.abs(lp[0].y - land.y) < 8, 'landscape mapping');
  await page.screenshot({path: `${ARTIFACTS}/neural-dance-manual-dancers-iphone16pro.png`});
  assert.deepEqual(errors, []);
  console.log('ok manual dancers on iPhone 16 Pro (WebKit): place x3, move, tap-safe, long-press confirm, X remove, survive scan, landscape');
} finally {
  await browser.close();
  server.close();
}
