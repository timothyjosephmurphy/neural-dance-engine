#!/usr/bin/env node
// Grid of arm-lift families over phrases, plus a short live-capture activation clip.
import pw from 'playwright';
const {chromium} = pw;
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {extname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outPng = (process.env.ND_RENDER_PNG || 'render-out.png');
const framesDir = '/tmp/nd-arm-variety-frames';
const outMp4 = (process.env.ND_RENDER_MP4 || 'render-out.mp4');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'};

const html = `<!doctype html>
<meta charset="utf-8">
<title>ND arm variety</title>
<canvas id="c" width="1600" height="980"></canvas>
<script type="module">
import {skeletonPose, placePoseOnFloor, paintShadowFigure, paintSilhouetteHalo, armLiftAmount, armLiftFamilyFor, resetArmLiftFamilies, ARM_LIFT_FAMILIES, stanceWidthFor, buildFor} from '/neural-dance/src/skeleton-dancer.js';
import {createSongEnergy, createDancerEnergy, createPulseNetwork, dancerIntake, ARM_LIFT_FULL} from '/neural-dance/src/song-energy.js';
import {dancerHueCss} from '/neural-dance/src/dancer-hue.js';

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

function drawPose(unit, cx, cy, h, color) {
  const posed = placePoseOnFloor(unit, {cx, cy, baseH: h, height: h, side: -1, anchorX: cx + unit.footL.x * h});
  paintShadowFigure(ctx, posed, X, {scale: 1, alpha: 0.95});
  paintSilhouetteHalo(ctx, posed, X, {scale: 1, color, dim: 0.45, width: 1, alpha: 1});
}

function grid() {
  backdrop();
  label('Arm-lift families  ·  mid and high  ·  same height still follows activation', 40, 18, 22, '#f2f5fb');
  const fams = ARM_LIFT_FAMILIES;
  const colW = 250, rowH = 210, x0 = 40, y0 = 70;
  fams.forEach((fam, i) => {
    const x = x0 + i * colW;
    label(fam, x, y0, 16, '#9eb0cc');
    ['mid', 'high'].forEach((tier, r) => {
      const lift = tier === 'mid' ? 0.5 : 1;
      const unit = skeletonPose({id: 3, band: 1, armLift: lift, armFamily: fam, phrase: 0, activation: lift, weight: 0, ease: 0, side: -1});
      drawPose(unit, x + 90, y0 + 30 + r * 200 + 160, 150, dancerHueCss(3, 1, 0.4));
      label(tier, x, y0 + 30 + r * 200 + 168, 13, '#7f8da3');
    });
  });

  // Over-time grid: 4 dancers × 8 phrases at high activation (on the beat, not synced).
  resetArmLiftFamilies();
  const yTime = 560;
  label('Four dancers over 8 phrases (seeded, no repeat, not synchronized)', 40, yTime, 20, '#f2f5fb');
  const ids = [2, 5, 9, 14];
  ids.forEach((id, r) => {
    for (let p = 0; p < 8; p++) {
      const fam = armLiftFamilyFor(id, p);
      const unit = skeletonPose({id, band: r % 4, armLift: 1, armFamily: fam, phrase: p, activation: 1, weight: 0, ease: 0, side: -1});
      const x = 80 + p * 185;
      const y = yTime + 50 + r * 95;
      drawPose(unit, x + 70, y + 82, 78, dancerHueCss(id, r % 4, 0.4));
      if (r === 0) label('phrase ' + (p + 1), x + 20, yTime + 28, 12, '#7f8da3');
      label(fam, x + 8, y + 84, 11, '#9eb0cc');
    }
    label('#' + id, 16, yTime + 50 + r * 95 + 30, 14, '#9eb0cc');
  });
}

window.renderGrid = () => { grid(); return 'ok'; };

window.renderActivationFrame = (levels, energy, act, tLabel) => {
  backdrop();
  label('Song-energy pose drive  ·  ' + tLabel, 40, 20, 22, '#f2f5fb');
  label('energy ' + energy.toFixed(2) + '   activation ' + act.toFixed(2) + '   lift ' + armLiftAmount(act * 1.10).toFixed(2), 40, 52, 16, '#9eb0cc');
  const ids = [2, 5, 9, 14, 21, 8];
  resetArmLiftFamilies();
  const phrase = Math.max(0, Math.floor((+tLabel || 0) / 2));
  ids.forEach((id, i) => {
    const fam = armLiftFamilyFor(id, phrase);
    const unit = skeletonPose({id, band: i % 4, armLift: armLiftAmount(act * 1.10), armFamily: fam, phrase, activation: act, weight: 0, ease: 0, side: i % 2 ? 1 : -1});
    const x = 140 + (i % 6) * 240;
    const y = 280;
    drawPose(unit, x, y + 280, 200, dancerHueCss(id, i % 4, 0.4));
    label('#' + id + '  ' + fam, x - 60, y + 300, 14, '#9eb0cc');
  });
  // Energy bar
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(40, 90, 1520, 18);
  ctx.fillStyle = 'rgba(200, 230, 255, 0.85)';
  ctx.fillRect(40, 90, 1520 * Math.max(0, Math.min(1, energy)), 18);
  return 'ok';
};
</script>
`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(html); }
    const file = join(root, decodeURIComponent(url.pathname));
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1600, height: 980}});
await page.goto(origin + '/', {waitUntil: 'networkidle'});
await page.waitForFunction(() => typeof window.renderGrid === 'function');
await page.evaluate(() => window.renderGrid());
await page.locator('#c').screenshot({path: outPng});
console.log('wrote', outPng);

// Short mp4 from the live capture energy curve (if present).
const cap = process.env.ND_LIVE_CAPTURE || '';
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
    if (samples.length > 1600) break;
  }
  const music = createSongEnergy();
  const per = createDancerEnergy();
  const net = createPulseNetwork({linkR: 200});
  const layout = [
    {id: 2, x: 220, y: 260, type: 0},
    {id: 5, x: 380, y: 280, type: 1},
    {id: 9, x: 540, y: 250, type: 2},
    {id: 14, x: 700, y: 300, type: 0},
    {id: 21, x: 840, y: 270, type: 3},
    {id: 8, x: 980, y: 300, type: 1}
  ];
  net.setDancers(layout);
  const series = [];
  const t0 = samples[0].t;
  let prevT = t0;
  for (const s of samples) {
    net.tick((s.t - prevT) / 1000, s.t);
    const song = music.process(s.t, s.lv, {open: s.gate !== false}).energy;
    // Kick-ish onsets from level jumps stand in if we don't parse hits here.
    if ((s.lv[0] || 0) > 0.75) net.hit(0, s.t);
    if ((s.lv[1] || 0) > 0.7) net.hit(1, s.t);
    const acts = layout.map(d => {
      const raw = dancerIntake({received: net.activity(d.id), local: (s.lv[d.type] || 0) * (0.35 + 0.65 * song)});
      return per.process(d.id, s.t, raw, {open: s.gate !== false}).energy;
    });
    if (s.t - t0 >= 8000) series.push({t: s.t - t0, energy: song, act: acts[0], acts});
    prevT = s.t;
  }
  // ~6 seconds of clip at 12 fps, skipping through the series.
  mkdirSync(framesDir, {recursive: true});
  const frames = 72;
  const step = Math.max(1, Math.floor(series.length / frames));
  let n = 0;
  for (let i = 0; i < series.length && n < frames; i += step, n++) {
    const s = series[i];
    await page.evaluate(([e, a, t]) => window.renderActivationFrame(null, e, a, t), [s.energy, s.act, (s.t / 1000).toFixed(1) + 's']);
    await page.locator('#c').screenshot({path: join(framesDir, 'f' + String(n).padStart(3, '0') + '.png')});
  }
  const ff = spawnSync('ffmpeg', ['-y', '-framerate', '12', '-i', join(framesDir, 'f%03d.png'), '-pix_fmt', 'yuv420p', '-crf', '20', outMp4], {encoding: 'utf8'});
  if (ff.status === 0) console.log('wrote', outMp4, 'frames', n);
  else console.log('ffmpeg failed', ff.stderr.slice(-400));
  rmSync(framesDir, {recursive: true, force: true});
}

await browser.close();
server.close();
