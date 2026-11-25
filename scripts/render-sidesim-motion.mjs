#!/usr/bin/env node
// Short live-renderer clip of the remaining side-sim motion (spine, arm flex,
// leg waves, jiggle, heel-toe, hip + shoulder figure-eights, per-dancer stomp).
import pw from 'playwright';
const {chromium} = pw;
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {extname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const framesDir = '/tmp/nd-sidesim-motion-frames';
const outMp4 = (process.env.ND_RENDER_MP4 || 'render-out.mp4');
const outPng = (process.env.ND_RENDER_PNG || 'render-out.png');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'};

const html = `<!doctype html>
<meta charset="utf-8">
<title>ND side-sim motion</title>
<canvas id="c" width="1600" height="720"></canvas>
<script type="module">
import {skeletonPose, placePoseOnFloor, paintShadowFigure, paintSilhouetteHalo, armLiftAmount, ARM_LIFT_FAMILIES, armLiftFamilyFor, stompIntensity} from '/neural-dance/src/skeleton-dancer.js';
import {createSongEnergy, createDancerEnergy, createPulseNetwork, dancerIntake, ARM_LIFT_FULL} from '/neural-dance/src/song-energy.js';
import {dancerHueCss} from '/neural-dance/src/dancer-hue.js';
import {pulseTravelTimes, pulseDriveHz} from '/neural-dance/src/vibrating-string.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const X = (x, y) => ({x, y});

function backdrop() {
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, '#0a1020');
  g.addColorStop(1, '#020308');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function label(text, x, y, size = 16, color = '#d7deea') {
  ctx.save();
  ctx.font = '600 ' + size + 'px system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
  ctx.restore();
}

const layout = [
  {id: 2, type: 0, label: 'kick A'},
  {id: 5, type: 1, label: 'bass'},
  {id: 9, type: 2, label: 'snare'},
  {id: 14, type: 0, label: 'kick B'},
  {id: 21, type: 3, label: 'hat'}
];

window.renderMotionFrame = (payload) => {
  const {tSec, acts, periodMs, song} = payload;
  backdrop();
  label('Live motion port  ·  hip figure-8 0.80  ·  shoulder figure-8 0.70 (contra-body)  ·  stomp follows each dancer', 36, 16, 20, '#f2f5fb');
  label((tSec.toFixed(2) + 's   song ' + (song || 0).toFixed(2)), 36, 44, 14, '#8ea0bb');
  const times = pulseTravelTimes();
  const period = periodMs || 500;
  layout.forEach((d, i) => {
    const act = Math.max(0, Math.min(1, +(acts && acts[i]) || 0));
    const side = Math.floor(tSec / (period / 1000)) % 2 === 0 ? -1 : 1;
    const ease = (tSec / (period / 1000)) % 1;
    const t0 = tSec - ease * (period / 1000);
    const strikes = [
      {t0, side, energy: act, beat: Math.floor(tSec / (period / 1000)), transfer: true, contact: 'heel'}
    ];
    const fam = armLiftFamilyFor(d.id, Math.floor(tSec / (period / 1000 * 4)));
    const unit = skeletonPose({
      id: d.id, band: d.type, weight: side, ease, side,
      armLift: armLiftAmount(act * ARM_LIFT_FULL), armFamily: fam,
      phrase: Math.floor(tSec / (period / 1000 * 4)),
      activation: act, now: tSec * 1000, periodMs: period, strikes,
      pulseAmp: 18 * (0.3 + 0.7 * act), pulseHz: pulseDriveHz(1000 / period),
      times, hush: 1, still: false, beat: Math.floor(tSec / (period / 1000)),
      stepHz: 1000 / period, hipEight: 0.80, shoulderEight: 0.70
    });
    const cx = 160 + i * 290;
    const cy = 400;
    const h = 280;
    const posed = placePoseOnFloor(unit, {cx, cy, baseH: h, height: h, side, anchorX: cx + (side < 0 ? unit.footL.x : unit.footR.x) * h});
    const color = dancerHueCss(d.id, d.type, 0.4);
    paintShadowFigure(ctx, posed, X, {scale: 1, alpha: 0.95});
    paintSilhouetteHalo(ctx, posed, X, {scale: 1, color, dim: 0.35 + 0.55 * act, width: 1, alpha: 1});
    label(d.label + '  act ' + act.toFixed(2) + '  stomp ' + stompIntensity(act).toFixed(2), cx - 70, 620, 14, '#9eb0cc');
  });
};
</script>
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'content-type': 'text/html'}); res.end(html); return; }
  const rel = url.pathname.replace(/^\//, '');
  const file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const ext = extname(file);
  res.writeHead(200, {'content-type': mime[ext] || 'application/octet-stream'});
  res.end(await readFile(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1600, height: 720}});
await page.goto(origin + '/', {waitUntil: 'networkidle'});
await page.waitForFunction(() => typeof window.renderMotionFrame === 'function');

const cap = process.env.ND_LIVE_CAPTURE || '';
const frames = 84;
const periodMs = 500;
const actsSeries = [];
if (existsSync(cap)) {
  const {createSongEnergy, createDancerEnergy, createPulseNetwork, dancerIntake} = await import(root + '/neural-dance/src/song-energy.js');
  const lines = readFileSync(cap, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const samples = [];
  let lastT = null;
  for (const row of lines) {
    const m = row.m; if (!m || m.type !== 'audio') continue;
    for (const s of m.samples || []) {
      if (lastT != null && s.t - lastT < -5000) { if (samples.length > 400) break; samples.length = 0; }
      samples.push(s); lastT = s.t;
    }
    if (samples.length > 2000) break;
  }
  const music = createSongEnergy();
  const per = createDancerEnergy();
  const net = createPulseNetwork({linkR: 200});
  const nodes = [
    {id: 2, x: 220, y: 260, type: 0},
    {id: 5, x: 380, y: 280, type: 1},
    {id: 9, x: 540, y: 250, type: 2},
    {id: 14, x: 700, y: 300, type: 0},
    {id: 21, x: 840, y: 270, type: 3}
  ];
  net.setDancers(nodes);
  const t0 = samples[0].t;
  let prevT = t0;
  for (const s of samples) {
    net.tick((s.t - prevT) / 1000, s.t);
    const song = music.process(s.t, s.lv, {open: s.gate !== false}).energy;
    if ((s.lv[0] || 0) > 0.75) net.hit(0, s.t);
    if ((s.lv[1] || 0) > 0.7) net.hit(1, s.t);
    if ((s.lv[2] || 0) > 0.65) net.hit(2, s.t);
    if ((s.lv[3] || 0) > 0.6) net.hit(3, s.t);
    const acts = nodes.map(d => {
      const raw = dancerIntake({received: net.received(d.id), local: (s.lv[d.type] || 0) * (0.35 + 0.65 * song)});
      return per.process(d.id, s.t, raw, {open: s.gate !== false}).energy;
    });
    if (s.t - t0 >= 8000) actsSeries.push({tSec: (s.t - t0) / 1000, acts, song});
    prevT = s.t;
  }
}
mkdirSync(framesDir, {recursive: true});
if (!actsSeries.length) {
  for (let i = 0; i < frames; i++) {
    const tSec = 8 + i * (6 / frames);
    const acts = [0, 1, 2, 3, 4].map(k => 0.15 + 0.85 * Math.abs(Math.sin(tSec * (0.7 + k * 0.17) + k)));
    actsSeries.push({tSec, acts, song: acts[0]});
  }
}
const step = Math.max(1, Math.floor(actsSeries.length / frames));
let n = 0;
for (let i = 0; i < actsSeries.length && n < frames; i += step, n++) {
  const s = actsSeries[i];
  await page.evaluate((payload) => window.renderMotionFrame(payload), {tSec: s.tSec, acts: s.acts, periodMs, song: s.song});
  await page.locator('#c').screenshot({path: join(framesDir, 'f' + String(n).padStart(3, '0') + '.png')});
  if (n === Math.floor(frames * 0.55)) await page.locator('#c').screenshot({path: outPng});
}
const ff = spawnSync('ffmpeg', ['-y', '-framerate', 14, '-i', join(framesDir, 'f%03d.png'), '-pix_fmt', 'yuv420p', '-crf', '20', outMp4], {encoding: 'utf8'});
if (ff.status === 0) console.log('wrote', outMp4, 'frames', n, 'and', outPng);
else console.log('ffmpeg failed', (ff.stderr || '').slice(-400));
rmSync(framesDir, {recursive: true, force: true});
await browser.close();
server.close();
