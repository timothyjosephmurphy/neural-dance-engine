// Structured-light auto align in the simulated iPhone camera (latency,
// auto-exposure, blur, noise, rolling-shutter tears, room light), WebKit +
// Chromium. No prior quad: the stripes and dots alone must find the floor.
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {startServer} from './align-capture-sim.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const {server, origin} = await startServer(root, null);
const seeds = (process.env.ND_PRECISION_SEEDS || '1,2,3,4,5,6').split(',').map(Number);

async function trials(type, harsh, extra = '') {
  const browser = await type.launch();
  const out = [];
  const errors = [];
  try {
    await Promise.all(seeds.map(async (seed) => {
      const page = await browser.newPage({viewport: {width: 844, height: 390}});
      page.on('pageerror', e => errors.push(String(e && e.message || e)));
      try {
        await page.goto(`${origin}/tests/fixtures/align-sim/harness.html?seed=${seed}&harsh=${harsh}${extra}`);
        await page.waitForFunction(() => window.__ready === true, null, {timeout: 20000});
        out.push(await page.evaluate(() => window.__auto()));
      } catch (e) {
        out.push({seed, ok: false, crashed: String(e && e.message || e).slice(0, 200)});
      } finally {
        await page.close();
      }
    }));
  } finally {
    await browser.close();
  }
  return {results: out.sort((a, b) => a.seed - b.seed), errors};
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
try {
  for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
    const {results, errors} = await trials(type, 1, '&recheck=1&xhair=1');
    const ok = results.filter(r => r.ok && r.errPx != null && r.errPx < 4);
    const summary = {name, trials: results.length, ok: ok.length, medianErrPx: median(ok.map(r => r.errPx)), maxErrPx: Math.max(...ok.map(r => r.errPx)),
      medianMs: median(results.map(r => r.ms || 0)), maxMs: Math.max(...results.map(r => r.ms || 0)), medianFound: median(results.map(r => r.found || 0))};
    console.log('auto align', JSON.stringify(summary));
    for (const r of results) console.log('  seed', r.seed, r.ok ? 'ok' : 'FAIL', r.errPx, 'px', r.found + '/' + r.expected, 'dots', r.ms + ' ms', r.reason || '', r.crashed || '',
      r.recheck ? '| recheck ' + r.recheck.verdict + ' ' + r.recheck.px + 'px' : '', r.xhair ? '| xhair ' + r.xhair.beforePx + 'px -> fix ' + r.xhair.afterErrPx + 'px' : '');
    assert.deepEqual([...new Set(errors)], [], name + ' page errors');
    assert.ok(ok.length >= results.length - 1, name + ' success ' + JSON.stringify(summary));
    assert.ok(summary.medianErrPx < 2, name + ' median corner error ' + summary.medianErrPx);
    assert.ok(summary.maxMs < 45000, name + ' time');
    const rechecks = results.filter(r => r.recheck);
    assert.ok(rechecks.filter(r => /still aligned/.test(r.recheck.verdict || '')).length >= rechecks.length - 1, name + ' recheck');
    const fixes = results.filter(r => r.xhair);
    assert.ok(fixes.every(r => r.xhair.applied && r.xhair.afterErrPx < 2.5), name + ' crosshair fix ' + JSON.stringify(fixes.map(r => r.xhair)));
  }
  console.log('ok align precision sim');
} finally {
  server.close();
}
