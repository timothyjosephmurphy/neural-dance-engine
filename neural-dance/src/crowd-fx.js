// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Projector overlay effects for the crowd pages, drawn in stage px
// (1000 x 620) on a canvas inside the projector layer. Every effect is a
// self-contained module in a registry keyed by name so a later update can
// hot-register new ones (TJ Nov 24). All imagery is procedural.
//
// Module shape: {name, label, seconds, timeScale?, start(opts) -> run,
//                draw(ctx, run, age, env) -> false when finished}
// env: {W, H, markers, bands {bass, mid, high}, audio, now}

export const FX_W = 1000;
export const FX_H = 620;
export const STROBE_MAX_HZ = 6;      // photosensitivity: never faster
export const STROBE_MAX_S = 5;

const registry = new Map();
export function registerFx(mod) {
  if (!mod || typeof mod.name !== 'string' || typeof mod.draw !== 'function') throw new Error('bad fx module');
  registry.set(mod.name, Object.freeze({seconds: 8, start: (o) => ({...o}), ...mod}));
  return registry.get(mod.name);
}
export function fxModule(name) { return registry.get(name) || null; }
export function fxNames() { return [...registry.keys()]; }
export function fxRegistrySnapshot() { return new Map(registry); }
export function restoreFxRegistry(snap) { registry.clear(); for (const [k, v] of snap) registry.set(k, v); }

const clamp01 = v => Math.max(0, Math.min(1, +v || 0));
const env01 = (age, total, fade = 0.6) => clamp01(Math.min(age / fade, (total - age) / fade, 1));

registerFx({
  name: 'message', label: 'Message board', seconds: 12,
  draw(ctx, run, age, env) {
    const a = env01(age, this.seconds);
    if (!run.text) return false;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(140, 60, 720, 96);
    ctx.font = '700 46px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const hue = (env.now / 20) % 360;
    ctx.fillStyle = `hsl(${hue} 95% 70%)`;
    ctx.fillText(run.text, 500, 110, 690);
    ctx.restore();
    return age < this.seconds;
  }
});

registerFx({
  name: 'shout-out', label: 'Shout-out', seconds: 9,
  draw(ctx, run, age, env) {
    const a = env01(age, this.seconds, 0.4);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(500, 240);
    const s = 1 + 0.06 * Math.sin(age * 6) + 0.1 * env.bands.bass;
    ctx.scale(s, s);
    ctx.font = '800 54px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    const text = run.text ? 'SHOUT-OUT: ' + run.text : 'SHOUT-OUT!';
    ctx.strokeText(text, 0, 0, 900);
    ctx.fillStyle = '#ffe36b';
    ctx.fillText(text, 0, 0, 900);
    ctx.restore();
    return age < this.seconds;
  }
});

// Procedural scary face: glowing eyes and a jagged grin, no imagery assets.
registerFx({
  name: 'scary-face', label: 'Scary face', seconds: 4,
  draw(ctx, run, age, env) {
    const a = env01(age, this.seconds, 0.25) * (0.85 + 0.15 * Math.sin(age * 40));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,.82)'; ctx.fillRect(0, 0, FX_W, FX_H);
    const cx = 500, cy = 250, s = 1 + 0.04 * Math.sin(age * 9);
    ctx.translate(cx, cy); ctx.scale(s, s);
    ctx.shadowColor = '#ff2a1a'; ctx.shadowBlur = 40; ctx.fillStyle = '#ff3b1f';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 40, -40); ctx.lineTo(side * 150, -80); ctx.lineTo(side * 120, -10); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(-170, 60);
    for (let i = 0; i <= 12; i++) ctx.lineTo(-170 + i * 340 / 12, 60 + (i % 2 ? 40 : 0) + 30 * Math.sin(i / 12 * Math.PI));
    for (let i = 12; i >= 0; i--) ctx.lineTo(-170 + i * 340 / 12, 130 + 40 * Math.sin(i / 12 * Math.PI) - (i % 2 ? 0 : 30));
    ctx.closePath(); ctx.fill();
    ctx.restore();
    return age < this.seconds;
  }
});

registerFx({
  name: 'blackout', label: 'Blackout', seconds: 6,
  draw(ctx, run, age) { ctx.save(); ctx.globalAlpha = env01(age, this.seconds, 0.3); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FX_W, FX_H); ctx.restore(); return age < this.seconds; }
});

registerFx({
  name: 'strobe', label: 'Strobe', seconds: STROBE_MAX_S,
  draw(ctx, run, age) {
    const on = Math.floor(age * STROBE_MAX_HZ * 2) % 2 === 0;
    if (on) { ctx.save(); ctx.globalAlpha = 0.75; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, FX_W, FX_H); ctx.restore(); }
    return age < this.seconds;
  }
});

for (const [name, label, paint] of [
  ['wash-red', 'Red wash', () => 'rgba(255,30,40,1)'],
  ['wash-uv', 'UV wash', () => 'rgba(120,40,255,1)'],
  ['wash-rainbow', 'Rainbow wash', (age) => `hsl(${(age * 60) % 360} 100% 55%)`]
]) {
  registerFx({
    name, label, seconds: 14,
    draw(ctx, run, age) { ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.38 * env01(age, this.seconds, 1); ctx.fillStyle = paint(age); ctx.fillRect(0, 0, FX_W, FX_H); ctx.restore(); return age < this.seconds; }
  });
}

registerFx({ name: 'freeze', label: 'Freeze', seconds: 5, timeScale: 0.0, draw(ctx, run, age) { return age < this.seconds; } });
registerFx({ name: 'slow-mo', label: 'Slow-mo', seconds: 10, timeScale: 0.3, draw(ctx, run, age) { return age < this.seconds; } });

function particles(run, n, make) { if (!run.p) run.p = Array.from({length: n}, (_, i) => make(i)); return run.p; }

registerFx({
  name: 'confetti', label: 'Confetti', seconds: 10,
  draw(ctx, run, age) {
    const ps = particles(run, 160, () => ({x: Math.random() * FX_W, y: -Math.random() * 400, vy: 40 + Math.random() * 60, s: 3 + Math.random() * 5, h: Math.random() * 360, w: Math.random() * 6}));
    ctx.save();
    ctx.globalAlpha = env01(age, this.seconds, 1);
    for (const p of ps) {
      const y = p.y + p.vy * age, x = p.x + 18 * Math.sin(age * 2 + p.w);
      if (y > FX_H) continue;
      ctx.fillStyle = `hsl(${p.h} 90% 60%)`;
      ctx.fillRect(x, y, p.s, p.s * 0.6);
    }
    ctx.restore();
    return age < this.seconds;
  }
});

registerFx({
  name: 'fireworks', label: 'Fireworks', seconds: 9,
  draw(ctx, run, age) {
    const bursts = particles(run, 6, i => ({x: 150 + Math.random() * 700, y: 50 + Math.random() * 180, t: i * 1.2 + Math.random() * 0.5, h: Math.random() * 360}));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of bursts) {
      const t = age - b.t;
      if (t < 0 || t > 2.2) continue;
      const r = 120 * (1 - Math.exp(-t * 2.2));
      ctx.globalAlpha = clamp01(1 - t / 2.2);
      ctx.fillStyle = `hsl(${b.h} 100% 65%)`;
      for (let k = 0; k < 28; k++) { const a = k / 28 * Math.PI * 2; ctx.fillRect(b.x + r * Math.cos(a), b.y + r * Math.sin(a) + 20 * t * t, 3, 3); }
    }
    ctx.restore();
    return age < this.seconds;
  }
});

registerFx({
  name: 'glitch', label: 'Glitch', seconds: 4,
  draw(ctx, run, age) {
    ctx.save();
    for (let i = 0; i < 9; i++) {
      if (Math.random() < 0.5) continue;
      const y = Math.random() * FX_H, h = 4 + Math.random() * 30;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = ['#ff0050', '#00f0ff', '#ffffff', '#000000'][i % 4];
      ctx.fillRect(Math.random() * 120 - 60, y, FX_W, h);
    }
    ctx.restore();
    return age < this.seconds;
  }
});

registerFx({
  name: 'spotlight', label: 'Spotlight', seconds: 12,
  draw(ctx, run, age, env) {
    const m = env.markers;
    if (!run.target && m.length) run.target = m[Math.floor(Math.random() * m.length)].id;
    const t = m.find(x => x.id === run.target) || m[0];
    const x = t ? t.x : 500, y = t ? t.y : 420, r = t ? Math.max(40, (t.projectedHeight || 80) * 0.8) : 80;
    ctx.save();
    ctx.globalAlpha = 0.78 * env01(age, this.seconds, 0.8);
    const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 1.6);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, FX_W, FX_H);
    ctx.restore();
    return age < this.seconds;
  }
});

// 10 -> 1 then calls run.onZero (crowd-page fires a peak).
registerFx({
  name: 'countdown', label: 'Countdown', seconds: 11,
  draw(ctx, run, age, env) {
    const n = 10 - Math.floor(age);
    if (n <= 0) { if (!run.fired && run.onZero) { run.fired = true; run.onZero(); } return false; }
    const f = age % 1;
    ctx.save();
    ctx.globalAlpha = 1 - f * 0.6;
    ctx.translate(500, 230); const s = 1.4 - 0.4 * f; ctx.scale(s, s);
    ctx.font = '900 150px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = `hsl(${n * 33} 100% 65%)`; ctx.fillText(String(n), 0, 0);
    ctx.restore();
    return true;
  }
});

registerFx({
  // Lighter / phone wave over the crowd: small flames above dancer heads.
  name: 'lighters', label: 'Lighter wave', seconds: 16,
  draw(ctx, run, age, env) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = env01(age, this.seconds, 1.5);
    for (const m of env.markers) {
      const h = m.projectedHeight || 80;
      const sway = Math.sin(age * 1.4 + m.x * 0.02) * h * 0.18;
      const x = m.x + sway, y = m.y - h * 0.62;
      const g = ctx.createRadialGradient(x, y, 0, x, y, h * 0.09 + 2);
      g.addColorStop(0, 'rgba(255,240,180,1)'); g.addColorStop(1, 'rgba(255,140,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, h * 0.09 + 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    return age < this.seconds;
  }
});

// Stage light beams that vibrate along their length with the music:
// bass, mid and high bands each drive their own beams (TJ Nov 24).
export function drawStageLights(ctx, env, strength = 1) {
  const bands = env.bands || {bass: 0, mid: 0, high: 0};
  const beams = [
    {x: 260, band: 'bass', hue: 350, aim: 0.22}, {x: 330, band: 'mid', hue: 200, aim: 0.08},
    {x: 455, band: 'high', hue: 60, aim: -0.04}, {x: 455, band: 'bass', hue: 290, aim: 0.06},
    {x: 580, band: 'mid', hue: 160, aim: -0.1}, {x: 650, band: 'high', hue: 20, aim: -0.22}
  ];
  const t = env.now / 1000;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [i, b] of beams.entries()) {
    const v = clamp01(bands[b.band]);
    const sweep = b.aim + 0.18 * Math.sin(t * 0.35 + i * 1.7);
    const len = 470, steps = 26;
    const freq = b.band === 'bass' ? 2.2 : b.band === 'mid' ? 5 : 11;
    const amp = (b.band === 'bass' ? 18 : b.band === 'mid' ? 11 : 6) * v;
    const left = [], right = [];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const wob = amp * u * Math.sin(u * freq * Math.PI * 2 - t * (6 + freq * 2));
      const cx = b.x + Math.sin(sweep) * len * u + wob, cy = 150 + Math.cos(sweep) * len * u;
      const w = 4 + 46 * u;
      left.push([cx - w, cy]); right.push([cx + w, cy]);
    }
    const g = ctx.createLinearGradient(b.x, 150, b.x, 620);
    g.addColorStop(0, `hsla(${b.hue},100%,70%,${0.32 * strength * (0.35 + 0.65 * v)})`);
    g.addColorStop(1, `hsla(${b.hue},100%,60%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    left.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k][0], right[k][1]);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// DMT-style build: fractal kaleidoscope, breathing geometry, hue tunnel.
// k 0..1 is the strength; at 1 the frame is mostly light, ready for white.
export function drawDmt(ctx, k, env) {
  if (k <= 0.001) return;
  const t = env.now / 1000;
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.1);
  // Hue tunnel
  const cx = 455, cy = 290;
  for (let i = 14; i >= 0; i--) {
    const r = ((i + (t * 1.6 * (0.5 + k)) % 1) / 14) * 620;
    ctx.fillStyle = `hsl(${(t * 80 + i * 26) % 360} 100% ${50 + 40 * k}%)`;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  // Kaleidoscope petals, 12-fold
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'lighter';
  const breathe = 1 + 0.18 * Math.sin(t * 1.3) + 0.15 * clamp01(env.bands && env.bands.bass);
  for (let s = 0; s < 12; s++) {
    ctx.save();
    ctx.rotate(s * Math.PI / 6 + t * 0.2);
    for (let d = 1; d <= 5; d++) {
      const r = d * 55 * breathe;
      ctx.fillStyle = `hsla(${(t * 120 + d * 50 + s * 30) % 360},100%,65%,${0.25 + 0.15 * k})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(r * 0.6, r * 0.25 * Math.sin(t + d), r, 0);
      ctx.quadraticCurveTo(r * 0.6, -r * 0.25 * Math.cos(t * 1.1 + d), 0, 0);
      ctx.fill();
    }
    ctx.restore();
  }
  // Breathing polygon lattice
  ctx.strokeStyle = `hsla(${(t * 60) % 360},100%,85%,${0.5 * k})`;
  ctx.lineWidth = 2;
  for (let n = 3; n <= 8; n++) {
    const r = n * 40 * breathe;
    ctx.beginPath();
    for (let j = 0; j <= n; j++) { const a = j / n * Math.PI * 2 - t * (n % 2 ? 0.4 : -0.3); const px = r * Math.cos(a), py = r * Math.sin(a) * 0.62; j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.stroke();
  }
  ctx.restore();
  // Blooming toward white as k nears 1.
  const white = Math.max(0, (k - 0.7) / 0.3);
  if (white > 0) { ctx.save(); ctx.globalAlpha = white * 0.92; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, FX_W, FX_H); ctx.restore(); }
}

// White-capture lead-ins, one per trip style (crowd-capture PSY_STYLES).
// Each ends in the same bloom toward white as k nears 1.
function bloomWhite(ctx, k) {
  const white = Math.max(0, (k - 0.7) / 0.3);
  if (white > 0) { ctx.save(); ctx.globalAlpha = white * 0.92; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, FX_W, FX_H); ctx.restore(); }
}
// Mushrooms: breathing, melting walls; earthy greens, oranges, violet.
function drawMushrooms(ctx, k, env) {
  const t = env.now / 1000, bass = clamp01(env.bands && env.bands.bass);
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.05);
  for (let i = 0; i < 18; i++) {
    const y0 = (i / 18) * FX_H;
    ctx.fillStyle = `hsl(${[95, 30, 280, 140][i % 4] + 20 * Math.sin(t * 0.4 + i)} ${70 + 20 * k}% ${35 + 30 * k}%)`;
    ctx.beginPath(); ctx.moveTo(0, y0);
    for (let x = 0; x <= FX_W; x += 25) ctx.lineTo(x, y0 + 18 * Math.sin(x * 0.012 + t * 0.9 + i) * (1 + bass) + 10 * Math.sin(t * 0.5 + x * 0.03));
    ctx.lineTo(FX_W, y0 + FX_H / 18 + 40); ctx.lineTo(0, y0 + FX_H / 18 + 40); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  for (let d = 0; d < 14; d++) {
    const x = (d * 79 + 30) % FX_W, len = (60 + 220 * k) * (0.6 + 0.4 * Math.sin(t * 0.7 + d));
    const g = ctx.createLinearGradient(x, 0, x, len);
    g.addColorStop(0, `hsla(${(d * 40 + t * 20) % 360},90%,60%,${0.35 * k})`); g.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = g; ctx.fillRect(x - 6, 0, 12, len);
  }
  ctx.restore();
  bloomWhite(ctx, k);
}
// LSD: rainbow spirals and moire rings, high saturation, fast hue cycling.
function drawLsd(ctx, k, env) {
  const t = env.now / 1000, cx = 500, cy = 300;
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.1);
  for (let r = 640; r > 0; r -= 18) {
    ctx.fillStyle = `hsl(${(r * 1.7 - t * 140) % 360} 100% ${55 + 25 * k}%)`;
    ctx.beginPath(); ctx.arc(cx + 14 * Math.sin(t + r * 0.02), cy + 10 * Math.cos(t * 1.2 + r * 0.02), r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(cx, cy);
  for (let arm = 0; arm < 6; arm++) {
    ctx.strokeStyle = `hsla(${(arm * 60 + t * 90) % 360},100%,70%,${0.5 * k})`; ctx.lineWidth = 6;
    ctx.beginPath();
    for (let u = 0; u < 1; u += 0.02) { const a = arm * Math.PI / 3 + u * 9 + t * 1.3, r = u * 520; u ? ctx.lineTo(r * Math.cos(a), r * Math.sin(a) * 0.7) : ctx.moveTo(0, 0); }
    ctx.stroke();
  }
  ctx.restore();
  bloomWhite(ctx, k);
}
// Mescaline: sun-warm geometric lattice and radiating rays, gold to turquoise.
function drawMescaline(ctx, k, env) {
  const t = env.now / 1000, cx = 455, cy = 220;
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.05);
  ctx.fillStyle = `hsl(${32 + 8 * Math.sin(t)} 90% ${40 + 30 * k}%)`; ctx.fillRect(0, 0, FX_W, FX_H);
  const s = 54;
  for (let row = -1; row < FX_H / s + 1; row++) for (let col = -1; col < FX_W / s + 1; col++) {
    const x = col * s + (row % 2) * s / 2, y = row * s * 0.86, pulse = 0.5 + 0.5 * Math.sin(t * 1.4 - Math.hypot(x - cx, y - cy) * 0.02);
    ctx.fillStyle = `hsla(${[175, 45, 15, 190][(row + col + 8) % 4]},85%,${45 + 25 * pulse}%,${0.5 + 0.4 * k})`;
    ctx.beginPath(); ctx.moveTo(x, y - s * 0.42 * pulse); ctx.lineTo(x + s * 0.42 * pulse, y); ctx.lineTo(x, y + s * 0.42 * pulse); ctx.lineTo(x - s * 0.42 * pulse, y); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2 + t * 0.15;
    ctx.fillStyle = `hsla(48,100%,70%,${0.18 * k})`;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 900 * Math.cos(a - 0.04), cy + 900 * Math.sin(a - 0.04)); ctx.lineTo(cx + 900 * Math.cos(a + 0.04), cy + 900 * Math.sin(a + 0.04)); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  bloomWhite(ctx, k);
}
// Ayahuasca: serpents of patterned light winding through deep jungle color.
function drawAyahuasca(ctx, k, env) {
  const t = env.now / 1000, bass = clamp01(env.bands && env.bands.bass);
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.05);
  const g = ctx.createLinearGradient(0, 0, 0, FX_H);
  g.addColorStop(0, `hsl(160 80% ${12 + 20 * k}%)`); g.addColorStop(1, `hsl(265 70% ${10 + 20 * k}%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, FX_W, FX_H);
  ctx.globalCompositeOperation = 'lighter';
  for (let n = 0; n < 7; n++) {
    const y0 = 60 + n * 82, ph = n * 1.3, speed = 0.6 + 0.15 * n;
    for (let i = 0; i < 46; i++) {
      const x = ((i * 26 + t * 60 * speed * (n % 2 ? 1 : -1)) % (FX_W + 120) + FX_W + 120) % (FX_W + 120) - 60;
      const y = y0 + 34 * Math.sin(x * 0.012 + t * speed + ph) * (1 + 0.5 * bass);
      const r = 9 + 4 * Math.sin(i * 0.8 + t * 3);
      ctx.fillStyle = `hsla(${(n * 50 + i * 9 + t * 30) % 360},95%,60%,${0.35 + 0.3 * k})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (i % 3 === 0) { ctx.fillStyle = `hsla(50,100%,85%,${0.4 * k})`; ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.restore();
  bloomWhite(ctx, k);
}
// Ketamine: cool, slow dissociation; a receding grid tunnel, fragments drifting apart.
function drawKetamine(ctx, k, env) {
  const t = env.now / 1000, cx = 455, cy = 300;
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.05);
  ctx.fillStyle = `hsl(215 25% ${8 + 30 * k}%)`; ctx.fillRect(0, 0, FX_W, FX_H);
  ctx.strokeStyle = `hsla(195,60%,85%,${0.35 + 0.4 * k})`; ctx.lineWidth = 1.5;
  for (let i = 0; i < 16; i++) {
    const z = ((i + t * 0.35) % 16) / 16, s = Math.pow(z, 2.2) * 1.4;
    ctx.strokeRect(cx - 520 * s, cy - 330 * s, 1040 * s, 660 * s);
  }
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 800 * Math.cos(a), cy + 800 * Math.sin(a)); ctx.stroke(); }
  for (let f = 0; f < 10; f++) {
    const drift = k * 40 * Math.sin(t * 0.3 + f);
    ctx.fillStyle = `hsla(${200 + f * 4},30%,${70 + 20 * k}%,${0.12 + 0.1 * k})`;
    ctx.fillRect((f * 113) % FX_W + drift, (f * 71) % FX_H - drift, 90, 60);
  }
  ctx.restore();
  bloomWhite(ctx, k);
}
export const PSY_DRAW = Object.freeze({dmt: drawDmt, mushrooms: drawMushrooms, lsd: drawLsd, mescaline: drawMescaline, ayahuasca: drawAyahuasca, ketamine: drawKetamine});
export function drawPsy(ctx, style, k, env) { if (k <= 0.001) return; (PSY_DRAW[style] || drawDmt)(ctx, k, env); }

// Runs registered effects on one canvas.
export function createFxLayer(canvas) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  const active = [];
  return {
    start(name, opts = {}, now = performance.now()) {
      if (name === 'clear-effects') { active.length = 0; return {ok: true}; }
      const mod = fxModule(name);
      if (!mod) return {ok: false, reason: 'unknown effect'};
      for (let i = active.length - 1; i >= 0; i--) if (active[i].name === name) active.splice(i, 1);
      active.push({name, run: mod.start(opts), at: now});
      return {ok: true};
    },
    timeScale() { let s = 1; for (const a of active) { const m = fxModule(a.name); if (m && Number.isFinite(m.timeScale)) s = Math.min(s, m.timeScale); } return s; },
    names() { return active.map(a => a.name); },
    draw(env, extra) {
      if (!ctx) return false;
      ctx.clearRect(0, 0, FX_W, FX_H);
      // Never let one overlay (or a hot-loaded module) stop the frame loop.
      if (extra) try { extra(ctx); } catch { /* skip this overlay frame */ }
      for (let i = active.length - 1; i >= 0; i--) {
        const a = active[i];
        const mod = fxModule(a.name);
        let keep = false;
        try { keep = mod ? mod.draw(ctx, a.run, (env.now - a.at) / 1000, env) !== false : false; } catch { keep = false; }
        if (!keep) active.splice(i, 1);
      }
      return true;
    },
    activeCount: () => active.length
  };
}
