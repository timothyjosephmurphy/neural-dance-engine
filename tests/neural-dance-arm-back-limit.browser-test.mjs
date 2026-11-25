// Side sim rear arm limit (TJ Nov 11 5:46 PM): over 60 s of the preview ramp
// (every rave phrase, arm family, pad / melody arms, forward reach and 90° turn)
// no elbow or wrist passes just behind the back of the head, and the limit
// adds no snap. Also: the arms keep the body depth before the yaw, so turned
// dancers no longer swing them off behind the back; feet paint a lit sole.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
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
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
page.setDefaultTimeout(20000);
await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'domcontentloaded'});
await page.waitForFunction(() => window.ndStringSim && typeof window.ndStringSim.getPoseInfo === 'function');
await page.waitForFunction(() => window.NDArmForward && typeof window.NDArmForward.limitArmsBehindHead === 'function');

const r = await page.evaluate(() => {
  const s = window.ndStringSim;
  s.setPreviewRamp(true, 0);
  const KEYS = ['elL', 'elR', 'wristL', 'wristR'];
  const run = (off) => {
    window.__ndNoArmBackLimit = off;
    const frames = [];
    for (let t = 0; t < 60; t += 0.1) frames.push(s.getPoseInfo(t).map(i => i.arm3d));
    return frames;
  };
  const check = (frames) => {
    let over = 0, worst = 1, n = 0, profile = 0;
    for (const fr of frames) for (const a of fr) {
      if (!a) continue;
      const rx = a.shR.x - a.shL.x, rz = (a.shR.z || 0) - (a.shL.z || 0), l = Math.hypot(rx, rz);
      const fx = -rz / l, fz = rx / l;
      if (Math.abs(fx) > 0.8) profile++;
      const lim = a.head.x * fx + (a.head.z || 0) * fz - a.headR * (0.95 + 0.18);
      for (const k of KEYS) { const d = a[k].x * fx + (a[k].z || 0) * fz - lim; n++; if (d < -1e-9) over++; worst = Math.min(worst, d); }
    }
    return {over, worst, n, profile};
  };
  const raw = run(true), lim = run(false);
  window.__ndNoArmBackLimit = false;
  let extra = 0;
  for (let f = 1; f < lim.length; f++) lim[f].forEach((a, di) => {
    for (const k of KEYS) {
      const st = (S) => { const p = S[f][di][k], q = S[f - 1][di][k]; return Math.hypot(p.x - q.x, p.y - q.y, (p.z || 0) - (q.z || 0)); };
      if (st(raw) < 0.06) extra = Math.max(extra, st(lim) - st(raw));
    }
  });
  return {raw: check(raw), lim: check(lim), extra};
});
console.log('arm back limit', JSON.stringify(r));
assert.ok(r.lim.n > 5000, 'sweep covered the preview');
assert.ok(r.lim.profile > 300, 'sweep includes profile (turned) frames: ' + r.lim.profile);
assert.ok(r.raw.over > 0, 'unlimited arms do reach behind the head somewhere (the sweep exercises the limit)');
assert.equal(r.lim.over, 0, 'no elbow / wrist behind the head-back limit (worst ' + r.lim.worst.toFixed(4) + ')');
assert.ok(r.extra < 0.05, 'limit adds no snap (10 fps sampling): worst extra per-frame step ' + r.extra.toFixed(4));

// Feet: the shared shell paints a lit sole per foot (no more "balls at the ends of the legs").
const feet = await page.evaluate(async () => {
  const m = await import('/neural-dance/src/body-shell.js');
  return typeof m.paintFootRead === 'function' && typeof m.footReadShape === 'function';
});
assert.ok(feet, 'body-shell exports the readable-foot pass');
await browser.close();
server.close();
console.log('ok: arm back limit + readable feet (side sim)');
