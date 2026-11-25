// Re-learn bare painting must turn the projector full white immediately and
// hold it for at least a second (debug command and the live Controls bar).
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {inflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'};

function readPng(buf) {
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const prev = new Uint8Array(w * bpp);
  const cur = new Uint8Array(w * bpp);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * bpp + 1)];
    const row = raw.subarray(y * (w * bpp + 1) + 1, (y + 1) * (w * bpp + 1));
    for (let i = 0; i < w * bpp; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    const o = y * w * 4;
    for (let x = 0; x < w; x++) {
      out[o + x * 4] = cur[x * bpp];
      out[o + x * 4 + 1] = cur[x * bpp + 1];
      out[o + x * 4 + 2] = cur[x * bpp + 2];
      out[o + x * 4 + 3] = 255;
    }
    prev.set(cur);
  }
  return {rgba: out, w, h};
}

function centerPixel(buf) {
  const {rgba, w, h} = readPng(buf);
  const x = w >> 1, y = h >> 1;
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2]];
}

async function launch() {
  let chromium;
  try { ({chromium} = await import('playwright')); }
  catch { ({chromium} = await import('playwright-core')); }
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try { return await chromium.launch({args}); }
  catch { return chromium.launch({args, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome'}); }
}

test('re-learn holds a white top layer for at least a second from the live bar and a debug command', async () => {
  const liveHtml = (await readFile(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8'))
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
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
    } catch { res.writeHead(404); res.end('missing'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 800}});
    await page.goto(origin + '/neural-dance/live/', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('nd-room-lab')?.dataset.roomReady === '1');
    await page.evaluate(() => {
      const cam = document.getElementById('nd-camera-mode').neuralDanceCamera;
      const px = new Uint8ClampedArray(32 * 32 * 4);
      px.fill(180);
      cam.paintingActive = () => true;
      cam.grabFrame = () => ({data: px, width: 32, height: 32});
      cam.learnPaintingReference = () => true;
      cam.ensureCamera = async () => true;
      cam.personInView = () => true;
      cam.personInWhiteFrame = () => false;
      cam.noteCommand = () => {};
      document.body.classList.add('nd-painting');
      const layer = document.getElementById('nd-room-projector');
      layer.style.transformOrigin = '0 0';
      layer.style.transform = 'matrix3d(0.42, 0.04, 0, 0, -0.02, 0.36, 0, 0, 0, 0, 1, 0, 200, 140, 0, 1)';
    });

    async function assertWhiteHold(start) {
      await page.waitForFunction(() => {
        const veil = document.querySelector('[data-bare-white]');
        if (!veil || veil.hidden) return false;
        const cs = getComputedStyle(veil);
        const box = veil.getBoundingClientRect();
        const flash = document.querySelector('[data-align-flash]');
        return cs.display !== 'none'
          && cs.backgroundColor === 'rgb(255, 255, 255)'
          && Number(cs.zIndex) >= 1000060
          && box.width >= innerWidth - 2
          && box.height >= innerHeight - 2
          && flash && flash.hidden === false
          && flash.dataset.mode === 'white';
      });
      const early = Date.now() - start;
      assert.ok(early < 400, 'white was not immediate: ' + early + 'ms');
      await page.waitForTimeout(1000);
      const shot = await page.screenshot();
      const [r, g, b] = centerPixel(shot);
      assert.ok(r > 245 && g > 245 && b > 245, 'center pixel is not white: ' + [r, g, b].join(','));
      const still = await page.evaluate(() => {
        const veil = document.querySelector('[data-bare-white]');
        const top = document.elementsFromPoint(innerWidth / 2, innerHeight / 2)[0];
        const zone = document.querySelector('[data-align-cancel-zone]');
        return {
          up: !!(veil && !veil.hidden),
          topZ: top ? Number(getComputedStyle(top).zIndex) || 0 : 0,
          veilZ: veil ? Number(getComputedStyle(veil).zIndex) : 0,
          zoneHidden: !zone || zone.hidden === true
        };
      });
      assert.equal(still.up, true, 'white dropped before 1s');
      assert.ok(still.veilZ >= still.topZ, 'white sheet is under ' + still.topZ);
      assert.equal(still.zoneHidden, true);
      await page.waitForFunction(() => !document.querySelector('[data-bare-white]'), {timeout: 4000});
      const held = Date.now() - start;
      assert.ok(held >= 1000, 'hold was ' + held + 'ms');
    }

    let t0 = Date.now();
    await page.click('[data-live-action="painting-reference"]');
    await assertWhiteHold(t0);

    t0 = Date.now();
    await page.evaluate(async () => {
      const {applyDebugPatch} = await import('/neural-dance/live-debug.js');
      applyDebugPatch(document, {action: 'painting-reference', cmd: 'abcd1234'});
    });
    await assertWhiteHold(t0);
  } finally {
    await browser.close();
    server.close();
  }
});
