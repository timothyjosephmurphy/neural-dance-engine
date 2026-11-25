// Side sim: arm bones stay at rig length, chakra waves stay in the body,
// and the build/drop meter is on the sim page only.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {extname, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = readFileSync(join(root, 'src/pages/neural-dance/live/index.astro'), 'utf8');
const show = readFileSync(join(root, 'neural-dance/live-show.js'), 'utf8');
assert.equal(live.includes('dropMeter') || show.includes('dropMeter'), false, 'live page stays without the build/drop meter');

const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.wav': 'audio/wav'};
function mapPath(pathname) {
  if (pathname === '/neural-dance/sim/' || pathname === '/neural-dance/sim/index.html') return join(root, 'static/neural-dance/sim/index.html');
  if (pathname.startsWith('/neural-dance/')) {
    const rest = pathname.slice('/neural-dance/'.length);
    return rest.startsWith('src/') || rest === 'silence-gate.js' ? join(root, 'neural-dance', rest) : join(root, 'static/neural-dance', rest);
  }
  return join(root, pathname.replace(/^\//, ''));
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = mapPath(decodeURIComponent(url.pathname));
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(origin + '/neural-dance/sim/', {waitUntil: 'networkidle', timeout: 60000});
await page.waitForFunction(() => window.ndStringSim && typeof window.ndStringSim.sampleLimits === 'function' && window.NDSectionMotion);

const steps = ['stepTouch', 'grapevine', 'boxStep', 'rockStep', 'tStep', 'runningMan', 'chasse', 'kickBallChange'];
const energies = ['calm', 'groove', 'high'];
const times = [0.15, 0.55, 1.2, 2.4];
let worstArm = 1, worstWave = 0, samples = 0;
for (const step of steps) {
  for (const energy of energies) {
    await page.evaluate(({step, energy}) => {
      window.ndStringSim.setParams({fw: {mode: 'force', force: step, energy, steps: ['stepTouch'], fill: energy === 'high'}});
    }, {step, energy});
    for (const t of times) {
      const rows = await page.evaluate(t => window.ndStringSim.sampleLimits(t), t);
      for (const row of rows) {
        samples++;
        for (const arm of row.arms) {
          worstArm = Math.max(worstArm, arm.upper / arm.maxU, arm.fore / arm.maxF);
          assert.ok(arm.upper <= arm.maxU * 1.04, `${row.band} ${step} ${energy} upper ${arm.upper.toFixed(1)} > ${arm.maxU.toFixed(1)}`);
          assert.ok(arm.fore <= arm.maxF * 1.04, `${row.band} ${step} ${energy} forearm ${arm.fore.toFixed(1)} > ${arm.maxF.toFixed(1)}`);
        }
        worstWave = Math.max(worstWave, row.waveOver);
        assert.ok(row.waveOver <= 8, `${row.band} ${step} wave past body by ${row.waveOver.toFixed(1)}px`);
      }
    }
  }
}
await page.evaluate(() => window.ndStringSim.setParams({previewRamp: true, previewT0: 0, fw: {mode: 'auto', energy: 'high', steps: ['stepTouch','grapevine','boxStep','rockStep','tStep','runningMan','chasse'], fill: true}}));
for (const t of [1.5, 4, 8, 12, 16]) {
  const rows = await page.evaluate(t => window.ndStringSim.sampleLimits(t), t);
  for (const row of rows) {
    for (const arm of row.arms) {
      assert.ok(arm.upper <= arm.maxU * 1.04 && arm.fore <= arm.maxF * 1.04, `move ${row.band} t=${t}`);
    }
    assert.ok(row.waveOver <= 8, `move wave ${row.waveOver}`);
  }
}
const meter = await page.evaluate(() => {
  const out = [];
  for (let t = 12; t <= 28; t += 0.05) {
    const m = window.ndStringSim.dropMeter(t);
    out.push({t, level: m.level, kind: m.kind});
  }
  let peak = out[0];
  for (const s of out) if (s.level > peak.level) peak = s;
  const box = document.getElementById('dropMeter');
  return {peak, visible: box && !box.hidden, text: document.getElementById('dropMeterKind').textContent};
});
assert.equal(meter.visible, true);
assert.ok(meter.peak.level >= 0.99, 'demo meter reaches the drop');
assert.equal(errors.length, 0, errors.join('\n'));
console.log('ok arms/waves/meter', {samples, worstArm: +worstArm.toFixed(3), worstWave: +worstWave.toFixed(2), peak: meter.peak});
await browser.close();
server.close();
