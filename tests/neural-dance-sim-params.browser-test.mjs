// Open sim tab: a pushed override shows up immediately, reset restores the file,
// a new version.json reloads the preview, and the live page never calls the room.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSimPreviewHub} from './helpers/sim-preview-hub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm'};
const liveHtml = (await readFile(join(root, 'src/pages/neural-dance/live/index.astro'), 'utf8'))
  .replace(/^---[\s\S]*?---\n/, '')
  .replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
const params = JSON.parse(await readFile(join(root, 'static/neural-dance/sim/params.json'), 'utf8'));
const hub = createSimPreviewHub();
let channel = false;
const hits = {api: 0, ws: 0, version: 0};

function mapPath(pathname) {
  if (pathname === '/neural-dance/sim/' || pathname === '/neural-dance/sim/index.html') return join(root, 'static/neural-dance/sim/index.html');
  if (pathname.startsWith('/neural-dance/')) {
    const rest = pathname.slice('/neural-dance/'.length);
    const neural = join(root, 'neural-dance', rest);
    const stat = join(root, 'static/neural-dance', rest);
    if (rest.startsWith('src/') || rest.startsWith('vendor/')) return neural;
    if (existsSync(neural) && !existsSync(stat)) return neural;
    return stat;
  }
  return join(root, pathname.replace(/^\//, ''));
}

function sendJson(res, body) {
  res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/neural-dance/live/' || url.pathname === '/neural-dance/live/index.html') {
      res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
      return res.end(liveHtml);
    }
    if (url.pathname.replace(/\/+$/, '') === '/api/neural-dance/sim/params') {
      hits.api += 1;
      if (!channel) { res.writeHead(404); return res.end('missing'); }
      return sendJson(res, hub.snapshot());
    }
    if (url.pathname === '/neural-dance/version.json') {
      hits.version += 1;
      if (!channel) { res.writeHead(404); return res.end('missing'); }
      return sendJson(res, {version: hub.version()});
    }
    if (url.pathname === '/neural-dance/sim/params.json') {
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      return res.end(JSON.stringify(params));
    }
    const file = mapPath(decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    let body = await readFile(file);
    const type = mime[extname(file)] || 'application/octet-stream';
    if (channel && (url.pathname === '/neural-dance/sim/' || url.pathname === '/neural-dance/sim/index.html')) {
      body = Buffer.from(String(body).replace('</head>', '<meta name="nd-sim-live" content="1">\n</head>'));
    }
    res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});
server.on('upgrade', (req, socket) => {
  hits.ws += 1;
  if (!channel) { socket.destroy(); return; }
  hub.handleUpgrade(req, socket);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
try {
  const context = await browser.newContext();
  const errors = [];
  const fallback = await context.newPage();
  fallback.on('pageerror', (err) => errors.push(String(err)));
  const consoleErrors = [];
  fallback.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await fallback.goto(origin + '/neural-dance/sim/', {waitUntil: 'domcontentloaded'});
  await fallback.waitForFunction((bpm) => document.documentElement.dataset.simParams === '1' && document.documentElement.dataset.simParamsBpm === bpm, String(params.bpm), {timeout: 15000});
  await fallback.waitForTimeout(1200);
  assert.equal(fallback.url().includes('/neural-dance/sim/'), true);
  assert.equal(await fallback.evaluate(() => document.documentElement.dataset.simParamsLive || ''), '');
  assert.equal(hits.api, 0, 'fallback sim probed the preview room');
  assert.equal(hits.ws, 0, 'fallback sim opened a socket');
  assert.equal(hits.version, 0, 'fallback sim polled version.json');
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(errors, []);
  await fallback.close();

  channel = true;
  hits.api = 0;
  hits.ws = 0;
  hits.version = 0;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.documentElement.dataset.simParamsLive === '1' && document.documentElement.dataset.simParamsSocket === '1' && document.documentElement.dataset.simParamsVersion === 'aaaa1111', null, {timeout: 15000});
  await page.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm, String(params.bpm), {timeout: 8000});
  hub.push({bpm: 128, silhouettes: false});
  await page.waitForFunction(() => document.documentElement.dataset.simParamsBpm === '128', null, {timeout: 5000});
  const pushed = await page.evaluate(() => ({
    bpm: window.ndStringSim.getParams().bpm,
    slider: document.getElementById('bpm').value,
    silhouettes: window.ndStringSim.getParams().silhouettes,
    checked: document.getElementById('silhouettes').checked
  }));
  assert.equal(pushed.bpm, 128);
  assert.equal(pushed.slider, '128');
  assert.equal(pushed.silhouettes, false);
  assert.equal(pushed.checked, false);
  hub.reset();
  await page.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm && document.getElementById('silhouettes').checked, String(params.bpm), {timeout: 5000});
  const restored = await page.evaluate(() => window.ndStringSim.getParams());
  assert.equal(restored.bpm, params.bpm);
  assert.equal(restored.silhouettes, params.silhouettes);
  hub.push({bpm: 96});
  await page.waitForFunction(() => document.documentElement.dataset.simParamsBpm === '96', null, {timeout: 5000});
  const reloaded = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 8000});
  hub.setVersion('bbbb2222');
  await reloaded;
  await page.waitForFunction(() => document.documentElement.dataset.simParamsLive === '1' && document.documentElement.dataset.simParamsBpm === '96', null, {timeout: 15000});
  assert.equal(await page.evaluate(() => window.ndStringSim.getParams().bpm), 96);
  assert.deepEqual(pageErrors, []);
  await page.close();

  const liveHits = [];
  const live = await context.newPage();
  live.on('request', (req) => liveHits.push(new URL(req.url()).pathname));
  await live.goto(origin + '/neural-dance/live/', {waitUntil: 'domcontentloaded', timeout: 30000});
  await live.waitForTimeout(2000);
  const simCalls = liveHits.filter((path) => path.startsWith('/api/neural-dance/sim') || path.includes('nd-sim-live'));
  assert.deepEqual(simCalls, []);
  await live.close();
} finally {
  await browser.close();
  server.close();
}
console.log('sim params browser ok');
