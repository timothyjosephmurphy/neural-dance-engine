// End-to-end Listen check in Chromium with a fake microphone playing a
// synthesized groove (kick/bass/snare/hat at 120 BPM). Not part of test:show
// (timing-dependent); run: node scripts/listen-e2e.mjs [legacy]
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCENARIOS, SR, render} from '../tests/helpers/listen-sim.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const legacy = process.argv[2] === 'legacy';
const pattern = process.argv[2] === 'pattern';
const require = createRequire(root + 'package.json');
const {chromium} = require('playwright');
// 16-bit mono WAV of the steady groove (Chromium loops it).
const sc = SCENARIOS.steady120();
const pcm = render(sc.events, 8, {pad: sc.pad});
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 30000))), 44 + i * 2);
const wavPath = '/tmp/nd-listen-groove.wav';
await writeFile(wavPath, wav);
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json'};
const liveHtml = (await readFile(root + 'src/pages/neural-dance/live/index.astro', 'utf8')).replace(/^---[\s\S]*?---\n/, '').replace(/<BaseLayout\b[^>]*\/?>\s*/g, '');
const server = createServer(async (req, res) => { try { const url = new URL(req.url, 'http://x'); if (url.pathname === '/neural-dance/live/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(liveHtml); } const file = join(root, decodeURIComponent(url.pathname)); const body = await readFile(file); res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); res.end(body); } catch { res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wavPath, '--autoplay-policy=no-user-gesture-required']});
const context = await browser.newContext({viewport: {width: 1280, height: 800}, permissions: ['microphone']});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(origin + '/neural-dance/live/' + (legacy ? '?listen=legacy' : pattern ? '?listen=pattern' : ''), {waitUntil: 'domcontentloaded'});
await page.waitForFunction(() => document.getElementById('nd-room-lab')?.dataset.roomReady === '1', null, {timeout: 20000});
await page.evaluate(() => { const nd = document.getElementById('nd-room-lab').neuralDance; nd.setLightMode('silhouette'); nd.clearSim(); for (let i = 0; i < 24; i++) nd.addSim(80 + (i % 8) * 115, 140 + Math.floor(i / 8) * 170, i % 4); nd.applyShowCommand({action: 'start'}); });
await page.locator('#nd-room-lab [data-action="listen"]').click({force: true});
await page.waitForFunction(() => document.getElementById('nd-room-lab').neuralDance.micState() === 'listening', null, {timeout: 10000});
const sample = async ms => page.evaluate(async ms => {
  const nd = document.getElementById('nd-room-lab').neuralDance;
  const a = nd.listenTiming(); const t0 = performance.now();
  let frames = 0; await new Promise(res => { function f() { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
  const b = nd.listenTiming(); const secs = (performance.now() - t0) / 1000;
  return {detector: b.detector, bpm: b.bpm, tempo: b.tempo, coupled: b.coupled, meter: b.meter, patternBpm: b.patternBpm, ratio: b.ratio, labels: b.labels, pattern: b.pattern, beatsPerSec: b.beats.map((n, k) => +((n - a.beats[k]) / secs).toFixed(2)), bands: b.bands, rafFps: +(frames / secs).toFixed(1), mic: nd.micState(), audio: nd.debugAudio()};
}, ms);
await page.waitForTimeout(3000);
const first = await sample(8000);
// Toggle Listen off and on: must come back clean on the same page.
await page.locator('#nd-room-lab [data-action="listen"]').click({force: true});
await page.waitForTimeout(600);
const muted = await page.evaluate(() => document.getElementById('nd-room-lab').neuralDance.micState());
await page.locator('#nd-room-lab [data-action="listen"]').click({force: true});
await page.waitForTimeout(3000);
const second = await sample(6000);
console.log(JSON.stringify({legacy, first, muted, second, errors}, null, 1));
await browser.close(); server.close();
