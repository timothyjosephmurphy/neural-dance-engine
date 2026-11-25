// Sticker check in the simulated camera: wrong quad in, residual before/after.
// Usage: node tests/align-verify-sim.mjs [--trials N] [--browsers webkit,chromium] [--out f.json]
import {chromium, webkit} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startServer} from './align-capture-sim.mjs';

export async function runVerifyTrials({browserType, origin, seeds, harsh = 1, concurrency = 6}) {
  const browser = await browserType.launch();
  const results = [];
  const errors = [];
  try {
    const queue = seeds.slice();
    await Promise.all(Array.from({length: concurrency}, async () => {
      while (queue.length) {
        const seed = queue.shift();
        const page = await browser.newPage({viewport: {width: 844, height: 390}});
        page.on('pageerror', e => errors.push(String(e && e.message || e)));
        try {
          await page.goto(`${origin}/tests/fixtures/align-sim/harness.html?seed=${seed}&harsh=${harsh}`);
          await page.waitForFunction(() => window.__ready === true, null, {timeout: 20000});
          results.push(await page.evaluate(() => window.__verify()));
        } catch (e) {
          results.push({seed, crashed: String(e && e.message || e).slice(0, 200)});
        } finally { await page.close(); }
      }
    }));
  } finally { await browser.close(); }
  return {results: results.sort((a, b) => a.seed - b.seed), errors};
}

export function summarizeVerify(results) {
  const ok = results.filter(r => !r.crashed);
  const med = (k) => { const v = ok.map(r => r[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  return {trials: results.length, crashed: results.length - ok.length, applied: ok.filter(r => r.applied).length,
    under3px: ok.filter(r => r.truthAfterPx <= 3).length,
    medianTruthBeforePx: med('truthBeforePx'), medianTruthAfterPx: med('truthAfterPx'),
    medianMeasuredBeforePx: med('measuredBefore'), medianMeasuredAfterPx: med('measuredAfter'), medianMs: med('ms')};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n, f) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : f; };
  const trials = +opt('trials', 12);
  const out = opt('out', null);
  const root = resolve(new URL('..', import.meta.url).pathname);
  const {server, origin} = await startServer(root, null);
  const report = {};
  try {
    for (const name of opt('browsers', 'webkit,chromium').split(',')) {
      const {results, errors} = await runVerifyTrials({browserType: name === 'webkit' ? webkit : chromium, origin, seeds: Array.from({length: trials}, (_, i) => i + 1), harsh: +opt('harsh', 1)});
      report[name] = {summary: summarizeVerify(results), errors: [...new Set(errors)].slice(0, 5), results};
      console.log(name, JSON.stringify(report[name].summary));
    }
  } finally { server.close(); }
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}
