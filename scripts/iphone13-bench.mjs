// WebKit iPhone 13 profile: 24 seed sims, inner bones = Stage. Median redraw cost.
// Requires the `playwright` package and its WebKit browser. Not part of test:show.
import pw from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {webkit, devices} = pw;
const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');

function pageHtml(source) {
  return source.replace(/^---[\s\S]*?---\n/, '').replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
}

const liveHtml = pageHtml(await readFile(join(root, 'src/pages/neural-dance/live/index.astro'), 'utf8'));
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json'};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/neural-dance/live/' || url.pathname === '/neural-dance/live/index.html') {
      res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
      return res.end(liveHtml);
    }
    const file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await webkit.launch();
const context = await browser.newContext({...devices['iPhone 13']});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(origin + '/neural-dance/live/', {waitUntil: 'networkidle', timeout: 60000});
await page.waitForFunction(() => document.getElementById('nd-room-lab') && document.getElementById('nd-room-lab').neuralDance, {timeout: 30000});
const result = await page.evaluate(async () => {
  const nd = document.getElementById('nd-room-lab').neuralDance;
  nd.setLightMode('silhouette');
  nd.clearSim();
  nd.seedSim();
  const bones = document.querySelector('[data-control="inner-bones"]');
  if (bones) {
    bones.value = '1';
    bones.dispatchEvent(new Event('input', {bubbles: true}));
  }
  const boneLabel = document.querySelector('[data-value="inner-bones"]')?.textContent || '';
  const now0 = performance.now();
  for (let i = 0; i < 24; i++) nd.beat(now0 + i * 480, i % 2 ? 1 : 2);
  for (let i = 0; i < 6; i++) nd.redraw();
  const all = [];
  const rounds = [];
  for (let r = 0; r < 3; r++) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      nd.beat(performance.now(), (r * 20 + i) % 2 ? (1 | 4) : (1 | 8));
      const t0 = performance.now();
      nd.redraw();
      const dt = performance.now() - t0;
      samples.push(dt);
      all.push(dt);
    }
    samples.sort((a, b) => a - b);
    rounds.push(samples[Math.floor(samples.length / 2)]);
  }
  all.sort((a, b) => a - b);
  const at = p => all[Math.min(all.length - 1, Math.max(0, Math.ceil(p * all.length) - 1))];
  rounds.sort((a, b) => a - b);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  return {
    sims: nd.simList().length,
    light: nd.lightMode(),
    boneLabel,
    bonesValue: bones ? bones.value : null,
    rounds,
    med: rounds[1],
    mean: +mean.toFixed(2),
    p95: +at(0.95).toFixed(2),
    p99: +at(0.99).toFixed(2),
    fps: +(1000 / mean).toFixed(1),
  };
});
console.log(JSON.stringify({root, result, errors: errors.slice(0, 4)}, null, 2));
await browser.close();
server.close();
