// Short gate for the sim preview Worker. Does not deploy.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SIM_PARAM_FLAGS, SIM_PARAM_MASSES, SIM_PARAM_NUMBERS} from '../neural-dance/sim-params.js';
import {createSimPreviewHub} from '../tests/helpers/sim-preview-hub.mjs';
import worker from '../worker/index.mjs';
import {authorizeSimParamsWrite} from '../worker/neural-dance-sim-params.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const fail = (msg) => {
  console.error('smoke:sim ' + msg);
  process.exit(1);
};

const live = await readFile(join(root, 'wrangler.example.toml'), 'utf8');
const sim = await readFile(join(root, 'wrangler.sim.example.toml'), 'utf8');
if (!/^name = "neural-dance-engine"$/m.test(live)) fail('live wrangler.example.toml name changed');
if (/account_id/.test(live) || /account_id/.test(sim)) fail('example wrangler configs must not include account_id');
if (/SIM_PARAMS|NeuralDanceSimParams|\/api\/neural-dance\/sim/.test(live)) fail('wrangler.example.toml gained the sim params room');
if (!/\/api\/neural-dance\/debug\/\*/.test(live)) fail('live run_worker_first dropped the debug API');
if (!/\/neural-dance\/live/.test(live)) fail('live pages are not run_worker_first');
if (!/^name = "neural-dance-engine-sim"$/m.test(sim)) fail('preview worker name');
if (/tjm\.art/.test(sim)) fail('wrangler.sim.example.toml mentions tjm.art');
if (/\[\[routes\]\]|^routes\s*=/m.test(sim)) fail('wrangler.sim.example.toml has routes');
if (!/^workers_dev = true$/m.test(sim)) fail('preview workers.dev is off');
if (!/directory = "\.\/dist\/assets"/.test(sim)) fail('preview assets directory');
if (!/name = "SIM_PARAMS"/.test(sim) || !/NeuralDanceSimParams/.test(sim)) fail('preview params binding missing');
if (!/\/api\/neural-dance\/sim\/\*/.test(sim)) fail('preview API is not run_worker_first');
const livePage = await readFile(join(root, 'src/pages/neural-dance/live/index.astro'), 'utf8');
if (/\/api\/neural-dance\/sim|nd-sim-live|SIM_PARAMS/.test(livePage)) fail('live page references the sim params room');
for (const file of ['neural-dance/live-page.js', 'neural-dance/live-reload.js', 'neural-dance/src/skeleton-dancer.js']) {
  const source = await readFile(join(root, file), 'utf8');
  if (/\/api\/neural-dance\/sim|nd-sim-live/.test(source)) fail(file + ' references the sim params room');
}
const closed = await worker.fetch(new Request('https://example.test/api/neural-dance/sim/params', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"bpm":140}'}), {ASSETS: {fetch() { throw new Error('live assets'); }}});
if (closed.status !== 404) fail('sim params route is open without the preview binding');
const noToken = await authorizeSimParamsWrite(new Request('https://preview.workers.dev/api/neural-dance/sim/params', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"bpm":140}'}), {});
if (noToken.status !== 401) fail('write without SIM_PARAMS_TOKEN did not fail closed');

const html = await readFile(join(root, 'static/neural-dance/sim/index.html'), 'utf8');
if (!html.includes('/neural-dance/sim/params.json')) fail('sim page does not poll params.json');
if (html.includes('<meta name="nd-sim-live"')) fail('sim source is stamped for the preview');
if (!html.includes('meta[name="nd-sim-live"]')) fail('sim page has no preview gate');

const params = JSON.parse(await readFile(join(root, 'static/neural-dance/sim/params.json'), 'utf8'));
const numbers = SIM_PARAM_NUMBERS;
const flags = SIM_PARAM_FLAGS;
const allowed = new Set([...numbers, ...flags, 'masses']);
for (const key of Object.keys(params)) if (!allowed.has(key)) fail('unknown tuning key ' + key);
for (const key of numbers) if (!Number.isFinite(+params[key])) fail('bad number ' + key);
for (const key of flags) if (typeof params[key] !== 'boolean') fail('bad flag ' + key);
for (const id of SIM_PARAM_MASSES) {
  if (!Number.isFinite(+params.masses[id])) fail('bad mass ' + id);
}
const bpmAttr = html.match(/id="bpm"[^>]*value="([^"]+)"/);
if (!bpmAttr || +bpmAttr[1] !== 112) fail('built-in bpm slider default moved');
const tuned = params.bpm === 128 ? 96 : 128;

const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm'};
let override = null;
let channel = false;
const hits = {api: 0, ws: 0, version: 0};
const hub = createSimPreviewHub();
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
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.replace(/\/+$/, '') === '/api/neural-dance/sim/params') {
      hits.api += 1;
      if (!channel) { res.writeHead(404); return res.end('missing'); }
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      return res.end(JSON.stringify(hub.snapshot()));
    }
    if (url.pathname === '/neural-dance/version.json') {
      hits.version += 1;
      if (!channel) { res.writeHead(404); return res.end('missing'); }
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      return res.end(JSON.stringify({version: hub.version()}));
    }
    if (url.pathname === '/neural-dance/sim/params.json' && override) {
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      return res.end(override);
    }
    const file = mapPath(decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    let body = await readFile(file);
    if (channel && (url.pathname === '/neural-dance/sim/' || url.pathname === '/neural-dance/sim/index.html')) {
      body = Buffer.from(String(body).replace('</head>', '<meta name="nd-sim-live" content="1">\n</head>'));
    }
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
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
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction((bpm) => document.documentElement.dataset.simParams === '1' && document.documentElement.dataset.simParamsBpm === bpm, String(params.bpm), {timeout: 15000});
  const before = await page.evaluate(() => window.ndStringSim.getParams().bpm);
  if (before !== params.bpm) fail('sim bpm before reload ' + before);
  override = JSON.stringify({...params, bpm: tuned});
  await page.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm, String(tuned), {timeout: 8000});
  const after = await page.evaluate(() => ({
    bpm: window.ndStringSim.getParams().bpm,
    slider: document.getElementById('bpm').value,
    live: document.documentElement.dataset.simParamsLive || '',
  }));
  if (after.bpm !== tuned || after.slider !== String(tuned)) fail('hot reload did not adopt bpm ' + tuned + ' ' + JSON.stringify(after));
  if (after.live) fail('local sim joined the preview room');
  await page.waitForTimeout(800);
  if (hits.api || hits.ws || hits.version) fail('local sim made preview requests ' + JSON.stringify(hits));
  if (consoleErrors.length) fail('console error ' + consoleErrors[0]);
  if (errors.length) fail('page error ' + errors[0]);
  await page.close();

  channel = true;
  override = null;
  const liveTab = await browser.newPage();
  const liveErrors = [];
  liveTab.on('pageerror', (err) => liveErrors.push(String(err)));
  await liveTab.goto(origin + '/neural-dance/sim/', {waitUntil: 'domcontentloaded'});
  await liveTab.waitForFunction(() => document.documentElement.dataset.simParamsLive === '1' && document.documentElement.dataset.simParamsSocket === '1', null, {timeout: 15000});
  await liveTab.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm, String(params.bpm), {timeout: 8000});
  hub.push({bpm: tuned === 128 ? 96 : 128});
  const pushedBpm = tuned === 128 ? 96 : 128;
  await liveTab.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm, String(pushedBpm), {timeout: 5000});
  const pushed = await liveTab.evaluate(() => ({
    bpm: window.ndStringSim.getParams().bpm,
    slider: document.getElementById('bpm').value,
  }));
  if (pushed.bpm !== pushedBpm || pushed.slider !== String(pushedBpm)) fail('live push did not adopt bpm ' + JSON.stringify(pushed));
  hub.reset();
  await liveTab.waitForFunction((bpm) => document.documentElement.dataset.simParamsBpm === bpm, String(params.bpm), {timeout: 5000});
  const restored = await liveTab.evaluate(() => window.ndStringSim.getParams().bpm);
  if (restored !== params.bpm) fail('reset did not restore bpm ' + restored);
  if (liveErrors.length) fail('preview page error ' + liveErrors[0]);
} finally {
  await browser.close();
  server.close();
}
const sec = ((Date.now() - started) / 1000).toFixed(1);
if (Date.now() - started > 60000) fail('over 60s (' + sec + 's)');
console.log('smoke:sim ok ' + sec + 's');
