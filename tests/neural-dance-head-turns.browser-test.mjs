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

const result = await page.evaluate(() => {
  const api = window.ndStringSim;
  api.setPreviewRamp(true, 0);
  const rampTimes = [1.2, 4.5, 7.8, 11.2, 15.5];
  const yaws = [];
  for (let d = 0; d < 360; d += 15) yaws.push(d * Math.PI / 180);
  const kneeBad = [];
  const headFollowBad = [];
  const stringBad = [];
  const plans = new Set();
  const locos = new Set();
  let elbowMin = 180, elbowMax = 0;
  let restLookPeak = 0, midLookPeak = 0;
  for (const t of rampTimes) {
    for (const yaw of yaws) {
      api.setParams({forceFacing: yaw, previewRamp: true, previewT0: 0, raveMoves: true});
      const info = api.getPoseInfo(t);
      const strings = typeof api.getStringPoints === 'function' ? api.getStringPoints(t) : [];
      const rave = typeof api.getRavePlan === 'function' ? api.getRavePlan(t) : [];
      for (const r of rave) {
        if (r.plan && r.plan.label) plans.add(r.plan.label);
        if (r.plan && r.plan.locomotor) locos.add(r.plan.locomotor);
        const layers = r.plan && r.plan.layers;
        if (layers) for (const [k, v] of Object.entries(layers)) if (v > 0.15) plans.add(k);
      }
      for (const d of info) {
        if (d.kneeForwardL < -1e-4 || d.kneeForwardR < -1e-4) {
          kneeBad.push({t, yawDeg: yaw * 180 / Math.PI, band: d.band, L: d.kneeForwardL, R: d.kneeForwardR, art: d.artKind});
        }
        for (const ang of [d.elbowDegL, d.elbowDegR]) {
          if (Number.isFinite(ang)) {
            elbowMin = Math.min(elbowMin, ang);
            elbowMax = Math.max(elbowMax, ang);
          }
        }
        const face = d.twist && d.twist.facingDeg;
        const head = d.headYawDeg;
        const rel = d.headYawRelDeg;
        if (face != null && head != null && Math.abs(((head - face + 540) % 360) - 180) > 35) {
          headFollowBad.push({t, yawDeg: yaw * 180 / Math.PI, band: d.band, face, head, rel});
        }
        if (Math.abs(rel || 0) > 32) {
          headFollowBad.push({t, yawDeg: yaw * 180 / Math.PI, band: d.band, face, head, rel, why: 'rel'});
        }
      }
      for (const s of strings) {
        if (s.outsideHead > 0) stringBad.push({t, yawDeg: yaw * 180 / Math.PI, band: s.band, n: s.outsideHead});
      }
    }
  }
  api.setParams({forceFacing: 0, previewRamp: true, previewT0: 0});
  for (const t of [0.2, 0.5, 0.8, 1.1]) {
    for (const d of api.getPoseInfo(t)) restLookPeak = Math.max(restLookPeak, Math.abs(d.headYawRelDeg || 0));
  }
  for (const t of [8, 10, 12, 14]) {
    for (const d of api.getPoseInfo(t)) midLookPeak = Math.max(midLookPeak, Math.abs(d.headYawRelDeg || 0));
  }
  api.setParams({forceFacing: Math.PI / 2, previewRamp: true, previewT0: 0});
  const side = api.getPoseInfo(14.5);
  const sideHeads = side.map(d => ({band: d.band, face: d.twist && d.twist.facingDeg, head: d.headYawDeg, rel: d.headYawRelDeg}));
  api.setParams({forceFacing: null});
  return {
    kneeBad: kneeBad.slice(0, 8), kneeCount: kneeBad.length,
    headFollowBad: headFollowBad.slice(0, 8), headFollowCount: headFollowBad.length,
    stringBad: stringBad.slice(0, 8), stringCount: stringBad.length,
    plans: [...plans], locos: [...locos],
    elbowMin, elbowMax, restLookPeak, midLookPeak, sideHeads,
    hasGetStringPoints: typeof api.getStringPoints === 'function',
  };
});
await browser.close();
server.close();
console.log(JSON.stringify({
  kneeCount: result.kneeCount, headFollowCount: result.headFollowCount, stringCount: result.stringCount,
  plans: result.plans, locos: result.locos, elbowMin: result.elbowMin, elbowMax: result.elbowMax,
  restLookPeak: result.restLookPeak, midLookPeak: result.midLookPeak, sideHeads: result.sideHeads,
}, null, 2));
assert.ok(result.hasGetStringPoints, 'getStringPoints is on the surviving API');
assert.equal(result.kneeCount, 0, 'backward knees: ' + JSON.stringify(result.kneeBad));
assert.ok(Number.isFinite(result.elbowMin) && result.elbowMin >= 0 && result.elbowMax <= 180,
  'elbows out of range ' + result.elbowMin + '..' + result.elbowMax);
assert.equal(result.headFollowCount, 0, 'head did not follow shoulders: ' + JSON.stringify(result.headFollowBad));
assert.equal(result.stringCount, 0, 'string left the head: ' + JSON.stringify(result.stringBad));
assert.ok(result.restLookPeak <= 10, 'rest looks stay small, peak=' + result.restLookPeak);
const needed = ['bounceNod', 'hipSway', 'twoStep', 'jacking', 'bodyWave', 'tStep', 'runningMan', 'kickStomp'];
const missing = needed.filter(id => !result.plans.includes(id) && !result.plans.some(p => String(p).toLowerCase().includes(id.toLowerCase().slice(0, 4))));
assert.ok(missing.length === 0, 'yaw sweep missed rave moves ' + missing + ' got ' + JSON.stringify(result.plans));
const turned = result.sideHeads.filter(d => Math.abs(d.head) > 50);
assert.ok(turned.length >= 1, 'at 90° the head turns with the body: ' + JSON.stringify(result.sideHeads));
console.log('ok: head-turns + knee yaw-sweep + string-in-head');
