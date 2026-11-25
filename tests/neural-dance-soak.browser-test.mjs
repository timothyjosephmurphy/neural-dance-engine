// Soak findings (Nov 9): the show must come back by itself after a screen
// lock / app switch, and the GPU ripple must come back after a WebGL context
// loss instead of staying on the CPU field for the rest of the show.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'};
const pageHtml = (source) => source.replace(/^---[\s\S]*?---\n/, '').replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
const liveHtml = pageHtml(await readFile(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8'));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/neural-dance/live/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(liveHtml); }
    if (url.pathname === '/ripple/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end('<!doctype html><body></body>'); }
    if (url.pathname === '/neural-dance/version.json') { res.writeHead(404); return res.end(); }
    const file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']});
const errors = [];
try {
  const context = await browser.newContext({viewport: {width: 844, height: 390}, permissions: ['camera', 'microphone']});
  await context.addInitScript(() => {
    const desc = (v) => ({configurable: true, get: () => v});
    window.__setHidden = (h) => {
      Object.defineProperty(document, 'hidden', desc(h));
      Object.defineProperty(document, 'visibilityState', desc(h ? 'hidden' : 'visible'));
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    const gum = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = async function (c) { const s = await gum.call(this, c); if (c && c.audio) window.__micStreams = (window.__micStreams || []).concat([s]); return s; };
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/neural-dance/live/', {waitUntil: 'load'});
  await page.waitForFunction(() => document.getElementById('nd-room-lab')?.dataset.roomReady === '1');
  await page.evaluate(() => { const nd = document.getElementById('nd-room-lab').neuralDance; nd.applyShowCommand({action: 'start'}); });
  await page.locator('[data-action="listen"]').first().click();
  await page.locator('#nd-camera-mode [data-action="camera"]').first().click({force: true});
  await page.waitForFunction(() => document.getElementById('nd-room-lab').neuralDance.micState() === 'listening', null, {timeout: 10000});
  await page.waitForFunction(() => document.getElementById('nd-camera-mode').neuralDanceCamera.isOpen(), null, {timeout: 10000});

  // Screen lock: everything pauses and releases hardware ...
  await page.evaluate(() => window.__setHidden(true));
  const hidden = await page.evaluate(() => ({running: document.getElementById('nd-room-lab').neuralDance.debugRoom().running, mic: document.getElementById('nd-room-lab').neuralDance.micState(), cam: document.getElementById('nd-camera-mode').neuralDanceCamera.isOpen()}));
  assert.deepEqual(hidden, {running: false, mic: 'off', cam: false});
  // ... and comes back on unlock without a tap.
  await page.evaluate(() => window.__setHidden(false));
  await page.waitForFunction(() => {
    const nd = document.getElementById('nd-room-lab').neuralDance;
    return nd.debugRoom().running && nd.micState() === 'listening' && document.getElementById('nd-camera-mode').neuralDanceCamera.isOpen();
  }, null, {timeout: 10000});
  const banner = await page.evaluate(() => document.querySelector('[data-live-resume]').hidden);
  assert.equal(banner, true, 'no Resume prompt when the browser allowed the resume');

  // Paused on purpose stays paused after a lock.
  await page.evaluate(() => document.getElementById('nd-room-lab').neuralDance.applyShowCommand({action: 'pause'}));
  await page.locator('[data-action="listen"]').first().click();
  await page.waitForFunction(() => document.getElementById('nd-room-lab').neuralDance.micState() === 'muted', null, {timeout: 5000});
  await page.evaluate(() => window.__setHidden(true));
  await page.evaluate(() => window.__setHidden(false));
  await page.waitForTimeout(1500);
  const muted = await page.evaluate(() => document.getElementById('nd-room-lab').neuralDance.micState());
  assert.equal(muted, 'muted', 'a muted mic comes back muted');

  // iOS ends the mic track (camera restart / interruption): Listen comes back.
  await page.locator('[data-action="listen"]').first().click();
  await page.waitForFunction(() => document.getElementById('nd-room-lab').neuralDance.micState() === 'listening', null, {timeout: 5000});
  await page.evaluate(() => document.getElementById('nd-room-lab').neuralDance.applyShowCommand({action: 'start'}));
  const n0 = await page.evaluate(() => window.__micStreams.length);
  await page.evaluate(() => { const s = window.__micStreams[window.__micStreams.length - 1]; for (const t of s.getAudioTracks()) { t.stop(); t.dispatchEvent(new Event('ended')); } });
  await page.waitForFunction((n0) => window.__micStreams.length > n0 && document.getElementById('nd-room-lab').neuralDance.micState() === 'listening', n0, {timeout: 10000});
  const rec = await page.evaluate(() => document.getElementById('nd-room-lab').neuralDance.debugRoom().micRecoveries);
  assert.ok(rec >= 1, 'mic re-acquired after the track ended');

  // WebGL loss / restore on the GPU ripple field.
  const rp = await context.newPage();
  await rp.goto(origin + '/ripple/');
  const r = await rp.evaluate(async () => {
    const gls = [];
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, o) { const c = gc.call(this, t, o); if (c && /webgl/.test(t) && !gls.includes(c)) gls.push(c); return c; };
    const {createWaterRipple} = await import('/neural-dance/src/water-ripple.js');
    const ripple = createWaterRipple({allowSoftware: true});
    const out = document.createElement('canvas'); out.width = 1000; out.height = 620; document.body.appendChild(out);
    const before = ripple.backend;
    if (!/webgl2/.test(before)) return {skip: before};
    const gl = gls.find(g => g.canvas.width === 1000) || gls[gls.length - 1];
    const ext = gl.getExtension('WEBGL_lose_context');
    ripple.hit(0.5, 0.5, 1, {r: 1, g: 1, b: 1}); ripple.step(out);
    ext.loseContext();
    await new Promise(r => setTimeout(r, 50));
    ripple.step(out);
    const lost = ripple.backend;
    ext.restoreContext();
    await new Promise(r => setTimeout(r, 300));
    ripple.hit(0.5, 0.5, 1, {r: 1, g: 1, b: 1}); ripple.step(out);
    return {before, lost, after: ripple.backend, gpu: ripple.gpu};
  });
  if (r.skip) console.log('# ripple GPU unavailable here:', r.skip);
  else {
    assert.match(r.before, /^webgl2/);
    assert.equal(r.lost, 'cpu (gpu lost)');
    assert.match(r.after, /^webgl2/, 'GPU ripple is back after webglcontextrestored');
    assert.equal(r.gpu, true);
  }
  assert.deepEqual(errors, []);
  console.log('ok soak wake + webgl restore', JSON.stringify(r));
} finally {
  await browser.close();
  server.close();
}
