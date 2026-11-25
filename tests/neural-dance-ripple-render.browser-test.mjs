// Headless live render: 3 band-hued dancers, screenshot + pixel samples.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {extname, join} from 'node:path';
import {dancerHueRgb} from '../neural-dance/src/dancer-hue.js';

const root = new URL('..', import.meta.url).pathname;
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json'
};
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
    let path = decodeURIComponent(url.pathname);
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const SHOT_B = process.env.ND_RIPPLE_SHOT || 'nd-ripple-render.png';
const SHOT_A = '/tmp/neural-dance-ripple-render.png';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  await page.goto(origin + '/neural-dance/live/', {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.waitForFunction(() => document.getElementById('nd-room-lab')?.dataset.roomReady === '1', null, {timeout: 20000});
  const roomInfo = await page.evaluate(() => {
    const nd = document.getElementById('nd-room-lab').neuralDance;
    nd.setLightMode('silhouette');
    nd.setRipple({enabled: true, intensity: 1});
    nd.clearSim();
    nd.addSim(280, 360, 1);
    nd.addSim(520, 300, 2);
    nd.addSim(760, 380, 3);
    nd.applyShowCommand({action: 'start'});
    const splash = typeof nd.splashRipples === 'function' ? nd.splashRipples() : false;
    nd.redraw();
    document.body.classList.add('nd-live', 'nd-live-hidden');
    const banner = document.querySelector('[data-debug-pair-banner]');
    if (banner) banner.hidden = true;
    return {splash, ...(nd.debugRoom ? nd.debugRoom() : {})};
  });
  console.log('room', roomInfo);
  await page.waitForTimeout(400);
  const projector = page.locator('#nd-room-projector');
  await projector.screenshot({path: SHOT_B});
  writeFileSync(SHOT_A, await readFile(SHOT_B));

  const samples = await page.evaluate(() => {
    const stage = document.querySelector('#nd-room-lab [data-stage]');
    const ripple = document.querySelector('[data-ripple-layer]');
    const W = 1000, H = 620;
    const sw = stage.width, sh = stage.height;
    const scale = sw / W;
    const vx = 0, vy = sh / 2 - H * scale / 2;
    const xy = (x, y) => ({x: vx + x * scale, y: vy + y * scale});
    const sctx = stage.getContext('2d');
    const stageData = sctx.getImageData(0, 0, sw, sh).data;
    const rctx = ripple && ripple.getContext ? ripple.getContext('2d') : null;
    const rw = ripple ? ripple.width : 0;
    const rh = ripple ? ripple.height : 0;
    const rippleData = rctx && rw ? rctx.getImageData(0, 0, rw, rh).data : null;
    const sample = (x, y) => {
      const sx = Math.round(x), sy = Math.round(y);
      const si = (sy * sw + sx) * 4;
      const sr = stageData[si], sg = stageData[si + 1], sb = stageData[si + 2], sa = stageData[si + 3];
      let rr = 0, rg = 0, rb = 0, ra = 0;
      if (rippleData && rw && rh) {
        const rx = Math.max(0, Math.min(rw - 1, Math.round(sx / sw * rw)));
        const ry = Math.max(0, Math.min(rh - 1, Math.round(sy / sh * rh)));
        const ri = (ry * rw + rx) * 4;
        rr = rippleData[ri]; rg = rippleData[ri + 1]; rb = rippleData[ri + 2]; ra = rippleData[ri + 3];
      }
      // Screen-blend the premultiplied ripple over the stage (overlay uses mix-blend-mode:screen).
      const a = ra / 255;
      const r = Math.round(255 - ((255 - sr) * (255 - rr) / 255));
      const g = Math.round(255 - ((255 - sg) * (255 - rg) / 255));
      const b = Math.round(255 - ((255 - sb) * (255 - rb) / 255));
      return {sr, sg, sb, rr, rg, rb, ra, r, g, b, a};
    };
    const dancers = [
      {name: 'bass', x: 280, y: 360, band: 1},
      {name: 'mid', x: 520, y: 300, band: 2},
      {name: 'high', x: 760, y: 380, band: 3}
    ];
    const out = {bg: sample(20, 20), near: [], ring: [], rippleSize: {rw, rh, sw, sh}};
    for (const d of dancers) {
      const p = xy(d.x, d.y);
      out.near.push({...d, ...p, ...sample(p.x, p.y)});
      // Search a ring 40–90px out for a lit ripple pixel
      let best = null;
      for (let ang = 0; ang < 16; ang++) {
        for (const rad of [48, 64, 80, 96]) {
          const q = sample(p.x + Math.cos(ang / 16 * Math.PI * 2) * rad, p.y + Math.sin(ang / 16 * Math.PI * 2) * rad);
          if (!best || q.ra > best.ra) best = {...q, rad, ang};
        }
      }
      out.ring.push({...d, ...best});
    }
    return out;
  });

  const luma = (p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
  const sat = (p) => {
    const a = Math.max(p.ra || p.a || 1, 1) / 255;
    const r = (p.rr ?? p.r) / Math.max(a, 1 / 255);
    const g = (p.rg ?? p.g) / Math.max(a, 1 / 255);
    const b = (p.rb ?? p.b) / Math.max(a, 1 / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max < 1 ? 0 : (max - min) / max;
  };

  const bgL = 0.299 * samples.bg.sr + 0.587 * samples.bg.sg + 0.114 * samples.bg.sb;
  for (const n of samples.near) {
    const nearL = luma({r: n.r, g: n.g, b: n.b});
    assert.ok(nearL >= bgL - 8, `${n.name} near-dancer luma ${nearL.toFixed(1)} < bg ${bgL.toFixed(1)}`);
  }
  const litRings = samples.ring.filter(r => r.ra > 12);
  assert.ok(litRings.length >= 1, 'at least one ripple ring is lit: ' + JSON.stringify(samples.ring.map(r => r.ra)));
  for (const r of litRings) {
    assert.ok(sat(r) > 0.18, `${r.name} ring saturation ${sat(r).toFixed(2)} too low (gray)`);
  }
  console.log(JSON.stringify({shot: SHOT_B, samples, bgL}, null, 2));
} finally {
  await browser.close();
  server.close();
}
