// Run simulated-camera Align trials in Playwright (WebKit + Chromium).
// Usage: node tests/align-capture-sim.mjs [--trials N] [--base DIR] [--browsers webkit,chromium] [--out file.json]
// --base DIR serves an old checkout's neural-dance/ at /__base/ to compare.
import {chromium, webkit} from 'playwright';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';

export const SUCCESS_ERR = 0.015; // max corner error (fraction of the camera frame)

const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json'};

export async function startServer(root, base) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      let dir = root;
      if (base && path.startsWith('/__base/')) { dir = base; path = path.slice('/__base'.length); }
      const file = join(dir, path);
      if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
      res.end(body);
    } catch { res.writeHead(404); res.end('missing'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {server, origin: `http://127.0.0.1:${server.address().port}`};
}

export async function runTrials({browserType, origin, rootPrefix = '/', seeds, harsh = 1, concurrency = 6, refine = false}) {
  const browser = await browserType.launch();
  const results = [];
  const errors = [];
  try {
    const queue = seeds.slice();
    const worker = async () => {
      while (queue.length) {
        const seed = queue.shift();
        const page = await browser.newPage({viewport: {width: 844, height: 390}});
        page.on('pageerror', e => errors.push(String(e && e.message || e)));
        try {
          await page.goto(`${origin}/tests/fixtures/align-sim/harness.html?root=${encodeURIComponent(rootPrefix)}&seed=${seed}&harsh=${harsh}&refine=${refine ? 1 : 0}${process.env.ND_SIM_EXTRA || ""}`);
          await page.waitForFunction(() => window.__ready === true, null, {timeout: 20000});
          const r = await page.evaluate(() => window.__run());
          r.ok = r.committed && r.err != null && r.err <= SUCCESS_ERR;
          results.push(r);
        } catch (e) {
          results.push({seed, ok: false, crashed: String(e && e.message || e).slice(0, 200)});
        } finally {
          await page.close();
        }
      }
    };
    await Promise.all(Array.from({length: concurrency}, worker));
  } finally {
    await browser.close();
  }
  return {results: results.sort((a, b) => a.seed - b.seed), errors};
}

export function summarize(results) {
  const n = results.length;
  const ok = results.filter(r => r.ok).length;
  const wrong = results.filter(r => r.committed && !r.ok).length;
  const refused = results.filter(r => !r.committed).length;
  const ms = results.filter(r => r.ms).map(r => r.ms).sort((a, b) => a - b);
  const errs = results.filter(r => r.ok).map(r => r.err).sort((a, b) => a - b);
  const pct = (a) => (n ? Math.round(1000 * a / n) / 10 : 0);
  return {
    trials: n, success: ok, successPct: pct(ok), wrongQuad: wrong, refused,
    medianMs: ms.length ? Math.round(ms[Math.floor(ms.length / 2)]) : null,
    maxMs: ms.length ? Math.round(ms[ms.length - 1]) : null,
    medianErrPx: errs.length ? +(errs[Math.floor(errs.length / 2)] * 480).toFixed(2) : null
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
  const trials = +opt('trials', 24);
  const base = opt('base', null);
  const harsh = +opt('harsh', 1);
  const which = opt('browsers', 'webkit,chromium').split(',');
  const out = opt('out', null);
  const startSeed = +opt('seed', 1);
  const root = resolve(new URL('..', import.meta.url).pathname);
  const {server, origin} = await startServer(root, base ? resolve(base) : null);
  const seeds = Array.from({length: trials}, (_, i) => startSeed + i);
  const report = {trials, harsh, successErr: SUCCESS_ERR, runs: {}};
  try {
    for (const name of which) {
      const browserType = name === 'webkit' ? webkit : chromium;
      for (const [label, prefix] of base ? [['before', '/__base/'], ['after', '/']] : [['after', '/']]) {
        const {results, errors} = await runTrials({browserType, origin, rootPrefix: prefix, seeds, harsh});
        const summary = summarize(results);
        report.runs[name + ':' + label] = {summary, errors: [...new Set(errors)].slice(0, 5), results};
        console.log(name, label, JSON.stringify(summary));
      }
    }
  } finally {
    server.close();
  }
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}
