// Side sim: peak pulse network runs in the page (pulses only at peak, ~2-beat emit interval, 5 s peak, low cooldown).
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wavPath = join(root, 'tests/fixtures/sim-listen-tone.wav');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

function mapPath(pathname) {
  if (pathname === '/neural-dance/sim/' || pathname === '/neural-dance/sim/index.html') {
    return join(root, 'static/neural-dance/sim/index.html');
  }
  if (pathname.startsWith('/neural-dance/')) {
    const rest = pathname.slice('/neural-dance/'.length);
    const inStatic = join(root, 'static/neural-dance', rest);
    const inSrc = join(root, 'neural-dance', rest);
    return rest.startsWith('src/') || rest === 'silence-gate.js' ? inSrc : inStatic;
  }
  return join(root, pathname.replace(/^\//, ''));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = mapPath(decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + wavPath,
  ],
  ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
});


const errors = [];
try {
  const page = await (await browser.newContext({viewport: {width: 1280, height: 800}})).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'load'});
  await page.waitForFunction(() => window.ndStringSim && window.NDPeakNetwork && window.NDSongTempoLock && typeof window.NDSongTempoLock.createSongTempoLock === 'function', null, {timeout: 20000});
  const r = await page.evaluate(() => {
    const S = window.ndStringSim;
    S.setParams({bandBass: true, bandMid: true, bandHigh: true, synthetic: true, bpm: 120, speed: 1});
    S.resetPeakNetwork();
    let maxPulses = 0, hotSeen = 0, restSeen = 0, restOver = 0, belowPeakEmits = 0;
    const emitsAt = {};
    let prev = {};
    for (let f = 0; f <= 16 * 10; f++) {
      const t = f / 10;
      S.render(t);
      const st = S.getPeakNetwork();
      maxPulses = Math.max(maxPulses, st.pulses.length);
      for (const d of st.dancers) {
        if (d.hot) hotSeen++;
        if (d.rest > 0) { restSeen++; if (d.rest < 1.2 && d.activation > 0.4) restOver++; }
        const was = prev[d.band] || {emits: 0, hot: false};
        if (d.emits > was.emits) { (emitsAt[d.band] = emitsAt[d.band] || []).push(t); if (!d.hot && !(d.level >= 0.874)) belowPeakEmits++; }
        prev[d.band] = d;
      }
    }
    const st = S.getPeakNetwork();
    return {maxPulses, hotSeen, restSeen, restOver, belowPeakEmits, emitsAt, emitTotal: st.emitTotal, spawnTotal: st.spawnTotal, peakHold: st.peakHold};
  });
  assert.equal(r.peakHold, 5);
  assert.ok(r.emitTotal > 3, 'network emits during the synthetic song ' + JSON.stringify(r));
  assert.ok(r.spawnTotal > 3 && r.maxPulses > 0, 'pulses are drawn');
  assert.ok(r.hotSeen > 0, 'dancers reach peak');
  assert.equal(r.belowPeakEmits, 0, 'no emission below peak');
  assert.equal(r.restOver, 0, 'rest stays capped low');
  for (const [band, times] of Object.entries(r.emitsAt)) {
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    for (const g of gaps) assert.ok(g >= 1.0 - 0.12 - 0.1 - 1e-6, `${band} emitted ${g.toFixed(2)} s after its last pulse (120 BPM -> 1.0 s)`);
  }
  await page.evaluate(() => window.ndStringSim.setParams({peakPulses: false}));
  const off = await page.evaluate(() => { const S = window.ndStringSim; const before = S.getPeakNetwork().emitTotal; for (let f = 0; f < 20; f++) S.render(20 + f / 10); return S.getPeakNetwork().emitTotal - before; });
  assert.equal(off, 0, 'toggle off stops the network');
  assert.deepEqual(errors, []);
  console.log('sim peak network ok', JSON.stringify({emitTotal: r.emitTotal, spawnTotal: r.spawnTotal, maxPulses: r.maxPulses}));
} finally {
  await browser.close();
  server.close();
}
