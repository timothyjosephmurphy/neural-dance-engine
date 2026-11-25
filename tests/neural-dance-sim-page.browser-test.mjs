// Layout + Listen meters for the sound-responsive side-sim page.
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

async function overlapState(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('stage');
    const panel = document.getElementById('controls');
    const c = canvas.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const hidden = document.body.classList.contains('controls-hidden') || getComputedStyle(panel).display === 'none';
    const overlap = !hidden && !(c.right <= p.left + 1 || c.left >= p.right - 1 || c.bottom <= p.top + 1 || c.top >= p.bottom - 1);
    return {
      overlap,
      hidden,
      canvas: {x: c.x, y: c.y, w: c.width, h: c.height},
      panel: {x: p.x, y: p.y, w: p.width, h: p.height, display: getComputedStyle(panel).display},
    };
  });
}

async function openSim(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'load'});
  await page.waitForFunction(() => window.ndStringSim && document.getElementById('stage'));
  await page.evaluate(() => window.ndStringSim.fitCanvas && window.ndStringSim.fitCanvas());
  await page.waitForTimeout(50);
}

const errors = [];
try {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone']);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));

  await openSim(page, {width: 390, height: 844});
  let state = await overlapState(page);
  assert.equal(state.overlap, false, 'portrait overlay: ' + JSON.stringify(state));
  assert.ok(state.canvas.w > 200 && state.canvas.h > 100, 'portrait canvas too small ' + JSON.stringify(state.canvas));
  assert.ok(state.canvas.y + state.canvas.h <= state.panel.y + 2, 'portrait canvas should sit above controls');
  assert.ok(!state.hidden, 'controls should start visible');

  await page.click('#toggleControls');
  await page.waitForTimeout(40);
  state = await overlapState(page);
  assert.equal(state.hidden, true, 'Hide controls should hide the panel');
  const hiddenH = state.canvas.h;
  await page.click('#toggleControls');
  await page.waitForTimeout(40);
  state = await overlapState(page);
  assert.equal(state.hidden, false);
  assert.ok(hiddenH >= state.canvas.h - 1, 'canvas should grow when controls hide');

  await openSim(page, {width: 1280, height: 800});
  state = await overlapState(page);
  assert.equal(state.overlap, false, 'wide overlay: ' + JSON.stringify(state));
  assert.ok(state.panel.x + 1 >= state.canvas.x + state.canvas.w, 'wide: controls should be a column beside the canvas');
  assert.ok(Math.abs(state.panel.w - 320) < 24, 'wide controls column should be ~320px, got ' + state.panel.w);

  await openSim(page, {width: 844, height: 390});
  state = await overlapState(page);
  assert.equal(state.overlap, false, 'landscape overlay: ' + JSON.stringify(state));

  // Fake audio stream through getUserMedia. Also inject a fallback oscillator
  // stream if the browser's fake capture is silent in this environment.
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      try {
        if (orig) {
          const stream = await orig(constraints);
          if (stream && stream.getAudioTracks().length) return stream;
        }
      } catch {}
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      if (ctx.state === 'suspended') await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      for (const f of [70, 220, 800, 2000]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = f;
        osc.type = 'sawtooth';
        g.gain.value = 0.2;
        osc.connect(g);
        g.connect(dest);
        osc.start();
      }
      window.__ndFakeListenCtx = ctx;
      return dest.stream;
    };
  });
  await openSim(page, {width: 1280, height: 800});
  await page.click('#listenBtn');
  const levels = await page.waitForFunction(() => {
    const l = window.ndStringSim && window.ndStringSim.listenLevels && window.ndStringSim.listenLevels();
    if (!l || !l.active) return false;
    const e = l.energy || [];
    const max = Math.max(0, ...e);
    return max > 0.2 ? l : false;
  }, {timeout: 8000});
  const got = await levels.jsonValue();
  const maxE = Math.max(...(got.energy || [0]));
  assert.ok(maxE > 0.2, 'AGC meters should move substantially, got ' + JSON.stringify(got));
  assert.ok((got.energy || []).length === 3, 'three display bands');
  assert.deepEqual(errors, []);
  console.log('sim-page browser ok', {
    maxEnergy: Math.round(maxE * 1000) / 1000,
    energy: (got.energy || []).map(v => Math.round(v * 1000) / 1000),
    detector: got.detector,
    sampleRate: got.sampleRate,
    micTopHz: got.micTopHz,
  });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
