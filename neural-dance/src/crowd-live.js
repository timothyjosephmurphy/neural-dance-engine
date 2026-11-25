// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Live-request staging for the crowd pages (TJ Nov 24):
//  - debut: the crowd parts to open a space front-centre (nearest the
//    screen), one spotlit dancer performs the new move twice with the
//    requester's handle captioned, then melts back into the crowd and the
//    move joins the shared library;
//  - library dancing: crowd dancers now and then pick up library moves;
//  - props: pole (left), cage (right), rope from the dome top;
//  - ETA crystals (no numbers): brighten and charge toward each ETA, then
//    burst into a psychedelic wipe when the request or update lands;
//  - "NEW" highlight caption for a new event or move.
// Pure state + canvas drawing in stage px (1000 x 620).

import {clampToFloor, ropeEnd} from './crowd-surfaces.js';
import {moveFrame} from './crowd-moves.js';
import {FX_H, FX_W, registerFx} from './crowd-fx.js';

export const DEBUT_RUNS = 2;
export const DEBUT_APPROACH_MAX_S = 9;
export const DEBUT_FADE_S = 3.5;
export const CLEAR_RADIUS = 78;
export const DEBUT_SPOT = Object.freeze({x: 456, y: 556});
const clamp01 = v => Math.max(0, Math.min(1, +v || 0));

// Writes one move frame onto a dancer (crowd-sim markers read these).
export function applyFrame(d, f, k = 1, heightPx = 100) {
  if (!d) return;
  if (!f || k <= 0) { d.offX = 0; d.hop = 0; d.move = null; return; }
  d.offX = f.dx * heightPx * k;
  d.hop = f.lift * k;
  d.move = {squat: f.squat * k, armRaise: f.armRaise * k, armForward: f.armForward * k, clap: f.clap * k, clapOh: f.clapOh * k, tall: f.tall * k};
}

export function createDebutDirector(opts = {}) {
  let run = null;
  const spot = opts.spot || DEBUT_SPOT;
  const api = {
    active: () => !!run,
    state: () => run ? {id: run.item.id, handle: run.item.handle, name: run.prog.name, phase: run.phase, t: +run.t.toFixed(1)} : null,
    run: () => run,
    // item: {id, handle, text}; prog: move program. Returns false if nobody can dance.
    start(item, prog, crowd, map) {
      if (run) return false;
      const at = clampToFloor(map, spot.x, spot.y);
      const pool = crowd.dancers.filter(d => d.where === 'floor' && !d.leaving && !d.plan && !d.huddle);
      if (!pool.length) {
        // Empty floor: someone walks in from the back to perform.
        const res = crowd.add({x: at.x, y: 615});
        const nd = crowd.dancers.find(d => d.id === res.id);
        if (!nd) return false;
        pool.push(nd);
      }
      pool.sort((a, b) => (a.resting - b.resting) || (Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y)));
      const d = pool[0];
      d.resting = false; d.fatigue = Math.min(d.fatigue, 0.3); d.featured = true;
      run = {item, prog, d, at, phase: 'approach', t: 0, beats: 0, fade: 0, cleared: new Set()};
      return true;
    },
    kill(crowd) { if (!run) return null; const r = run; finish(crowd); return r; },
    // bpm: song tempo (falls back to 120). Returns 'done' when the move is learned.
    step(crowd, map, dt, bpm = 120) {
      if (!run) return null;
      const r = run;
      if (!crowd.dancers.includes(r.d)) { finish(crowd); return 'lost'; }
      r.t += dt;
      const d = r.d;
      const h = crowd.heightOf(d);
      // Part the crowd: everyone else near the spot steps out of the circle.
      const clearing = r.phase !== 'fade' || r.fade < DEBUT_FADE_S * 0.5;
      for (const o of crowd.dancers) {
        if (o === d || o.where !== 'floor' || o.leaving) continue;
        const dx = o.x - r.at.x, dy = (o.y - r.at.y) * 1.6, dist = Math.hypot(dx, dy);
        if (clearing && dist < CLEAR_RADIUS) {
          const k = (CLEAR_RADIUS + 22) / Math.max(1, dist);
          const p = clampToFloor(map, r.at.x + dx * k, r.at.y + dy / 1.6 * k);
          o.goal = {x: p.x, y: p.y, until: crowd.t + 1.2, speed: 1.4};
          r.cleared.add(o);
        }
      }
      if (r.phase === 'approach') {
        d.goal = {x: r.at.x, y: r.at.y, until: crowd.t + 1, speed: 1.5};
        if (Math.hypot(d.x - r.at.x, d.y - r.at.y) < Math.max(5, 0.12 * h) || r.t > DEBUT_APPROACH_MAX_S) { r.phase = 'perform'; r.t = 0; r.beats = 0; }
        return 'approach';
      }
      d.goal = {x: r.at.x, y: r.at.y, until: crowd.t + 1, speed: 0.6};
      const bps = Math.max(80, Math.min(150, +bpm || 120)) / 60;
      if (r.phase === 'perform') {
        r.beats += dt * bps;
        const k = Math.min(1, r.t / 0.6);
        applyFrame(d, moveFrame(r.prog, r.beats), k, h);
        if (r.beats >= r.prog.beats * DEBUT_RUNS) { r.phase = 'fade'; r.fade = 0; }
        return 'perform';
      }
      r.fade += dt; r.beats += dt * bps;
      applyFrame(d, moveFrame(r.prog, r.beats), 1 - r.fade / DEBUT_FADE_S, h);
      if (r.fade >= DEBUT_FADE_S) { finish(crowd); return 'done'; }
      return 'fade';
    }
  };
  function finish(crowd) {
    if (!run) return;
    applyFrame(run.d, null);
    run.d.goal = null; run.d.featured = false;
    if (crowd && crowd.pickTarget) try { crowd.pickTarget(run.d); } catch { /* next retarget */ }
    for (const o of run.cleared) o.goal = null;
    run = null;
  }
  return api;
}

// Crowd dancers occasionally pick up a move from the library for one run.
export function createLibraryDancing(opts = {}) {
  const rnd = opts.rnd || Math.random;
  const active = new Map();   // dancer -> {prog, beats}
  let nextAt = 0;
  return {
    count: () => active.size,
    step(crowd, moves, dt, energy = 0.5, bpm = 120, busy = null) {
      const bps = Math.max(80, Math.min(150, +bpm || 120)) / 60;
      for (const [d, a] of active) {
        if (!crowd.dancers.includes(d) || d.featured) { active.delete(d); continue; }
        a.beats += dt * bps;
        const total = a.prog.beats;
        const k = Math.min(1, a.beats / 1, (total - a.beats) / 1);
        if (a.beats >= total) { applyFrame(d, null); active.delete(d); continue; }
        applyFrame(d, moveFrame(a.prog, a.beats), Math.max(0, k) * 0.85, crowd.heightOf(d));
      }
      if (!moves.length || crowd.t < nextAt) return;
      nextAt = crowd.t + 3 + rnd() * 5 * (1.3 - clamp01(energy));
      if (active.size >= Math.min(6, 1 + Math.floor(crowd.activeCount() / 6))) return;
      const pool = crowd.dancers.filter(d => d.where !== 'climb' && d.surface !== 'rope' && !d.featured && !d.resting && !d.leaving && !active.has(d) && !(busy && busy(d)));
      if (!pool.length) return;
      const d = pool[Math.floor(rnd() * pool.length)];
      active.set(d, {prog: moves[Math.floor(rnd() * moves.length)], beats: 0});
    },
    clear() { for (const d of active.keys()) applyFrame(d, null); active.clear(); }
  };
}

// ---- props: pole, cage, rope (drawn over the floor, under the effects)
export function drawProps(ctx, map, env, crowd) {
  const t = env.now / 1000, bands = env.bands || {bass: 0, mid: 0, high: 0};
  ctx.save();
  for (const s of map.surfaces || []) {
    if (s.prop === 'pole') {
      const x = (s.poly[0][0] + s.poly[1][0]) / 2, top = s.poly[0][1] - 10, base = s.baseY;
      const g = ctx.createLinearGradient(x - 4, 0, x + 4, 0);
      g.addColorStop(0, 'rgba(120,130,150,.9)'); g.addColorStop(0.5, 'rgba(250,250,255,.95)'); g.addColorStop(1, 'rgba(90,100,120,.9)');
      ctx.fillStyle = g; ctx.fillRect(x - 3, top, 6, base - top);
      ctx.fillStyle = `hsla(${(t * 40) % 360},100%,70%,${0.25 + 0.4 * clamp01(bands.high)})`;
      ctx.fillRect(x - 1, top, 2, base - top);
      ctx.fillStyle = 'rgba(40,44,60,.9)'; ctx.beginPath(); ctx.ellipse(x, base, 16, 4, 0, 0, Math.PI * 2); ctx.fill();
    } else if (s.prop === 'cage') {
      const x0 = s.poly[0][0], x1 = s.poly[1][0], y0 = s.poly[0][1], y1 = s.baseY;
      const shake = (crowd && crowd.cageShake) || 0;
      const jx = shake * 2.5 * Math.sin(t * 41), jy = shake * 1.5 * Math.cos(t * 37);
      ctx.translate(jx, jy);
      ctx.strokeStyle = `hsla(${300 + 40 * Math.sin(t * 0.7)},100%,65%,${0.55 + 0.35 * clamp01(bands.bass)})`;
      ctx.lineWidth = 2;   // no shadowBlur: cheap on the iPhone
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      for (let i = 1; i < 7; i++) { const x = x0 + (x1 - x0) * i / 7; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
      for (const f of [0.33, 0.66]) { const y = y0 + (y1 - y0) * f; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
      ctx.translate(-jx, -jy);
    }
  }
  if (map.rope) {
    const r = map.rope;
    const theta = crowd && crowd.ropeAngle ? crowd.ropeAngle : 0.06 * Math.sin(t * 0.9);
    const end = ropeEnd(r, theta);
    ctx.strokeStyle = 'rgba(210,180,130,.9)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(r.anchor[0], r.anchor[1]); ctx.quadraticCurveTo((r.anchor[0] + end.x) / 2 - 6 * theta, (r.anchor[1] + end.y) / 2, end.x, end.y); ctx.stroke();
    ctx.fillStyle = 'rgba(210,180,130,.95)'; ctx.beginPath(); ctx.arc(end.x, end.y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---- ETA crystals. items: [{id, at (accepted ms), eta (ms), label}]; now ms.
export function crystalCharge(item, now) {
  const eta = Number.isFinite(+item.eta) ? +item.eta : now, at = Number.isFinite(+item.at) ? +item.at : now;
  const span = Math.max(1000, eta - at);
  return clamp01(1 - (eta - now) / span);
}
export function drawCrystals(ctx, items, now, env) {
  if (!items || !items.length) return;
  const t = env.now / 1000;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  items.slice(0, 5).forEach((it, i) => {
    const c = crystalCharge(it, now);
    // Hovering above the dome, first in line on the left.
    const x = 380 + i * 42, y = 120 + 6 * Math.sin(t * 1.3 + i);
    const s = (i === 0 ? 1 : 0.7) * (16 + 10 * c);
    const hue = (it.hue != null ? it.hue : 190 + 40 * i) + 30 * c;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, s * (2.2 + 2.5 * c));
    glow.addColorStop(0, `hsla(${hue},100%,${60 + 30 * c}%,${0.25 + 0.6 * c})`); glow.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, s * (2.2 + 2.5 * c), 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y); ctx.rotate(0.25 * Math.sin(t * 0.8 + i) + c * t * 0.6);
    const flick = c > 0.85 ? 0.75 + 0.25 * Math.sin(t * 30) : 1;
    ctx.fillStyle = `hsla(${hue},90%,${45 + 45 * c}%,${(0.45 + 0.5 * c) * flick})`;
    ctx.beginPath(); ctx.moveTo(0, -s * 1.5); ctx.lineTo(s * 0.62, -s * 0.2); ctx.lineTo(0, s * 1.1); ctx.lineTo(-s * 0.62, -s * 0.2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `hsla(${hue},100%,92%,${0.4 + 0.6 * c})`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, -s * 1.5); ctx.lineTo(0, s * 1.1); ctx.moveTo(-s * 0.62, -s * 0.2); ctx.lineTo(s * 0.62, -s * 0.2); ctx.stroke();
    // Charging motes spiralling in.
    for (let m = 0; m < 6; m++) {
      const a = m / 6 * Math.PI * 2 + t * (1 + 3 * c), rr = s * (3.2 - 2.2 * c) * (0.8 + 0.2 * Math.sin(t * 4 + m));
      ctx.fillStyle = `hsla(${hue + 40},100%,85%,${0.3 + 0.6 * c})`;
      ctx.fillRect(rr * Math.cos(a) - 1, rr * Math.sin(a) - 1, 2, 2);
    }
    ctx.restore();
  });
  ctx.restore();
}

// Burst + psychedelic wipe when a request or update lands (~1.8 s).
registerFx({
  name: 'update-wipe', label: 'Update wipe', seconds: 1.8,
  draw(ctx, run, age, env) {
    const u = age / this.seconds;
    if (u >= 1) return false;
    const cx = run.x || 455, cy = run.y || 300;
    const r = 40 + 1100 * Math.pow(u, 0.7);
    ctx.save();
    ctx.globalAlpha = Math.sin(Math.PI * u);
    for (let i = 10; i >= 0; i--) {
      ctx.fillStyle = `hsl(${(i * 36 + age * 400 + (run.hue || 0)) % 360} 100% ${55 + 3 * i}%)`;
      ctx.beginPath(); ctx.arc(cx, cy, r * (0.35 + i * 0.065), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy);
    for (let s = 0; s < 16; s++) {
      ctx.rotate(Math.PI / 8);
      ctx.fillStyle = `hsla(${(s * 22 + age * 300) % 360},100%,70%,.5)`;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r, -r * 0.08); ctx.lineTo(r, r * 0.08); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    return true;
  }
});

// Debut spotlight + caption (handle and move name) and NEW highlights.
export function drawDebut(ctx, debut, markers, env) {
  const r = debut && debut.run && debut.run();
  if (!r) return;
  const m = markers.find(x => x.id === r.d.rid);
  if (!m) return;
  const h = m.projectedHeight || 90;
  const k = r.phase === 'fade' ? clamp01(1 - r.fade / DEBUT_FADE_S) : clamp01(r.phase === 'approach' ? r.t / 1.5 : 1);
  ctx.save();
  ctx.globalAlpha = 0.55 * k;
  const g = ctx.createRadialGradient(m.x, m.y, h * 0.4, m.x, m.y, h * 1.5);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.85)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, FX_W, FX_H);
  ctx.globalAlpha = k;
  ctx.globalCompositeOperation = 'lighter';
  const cone = ctx.createLinearGradient(m.x, 0, m.x, m.y + h * 0.5);
  cone.addColorStop(0, 'rgba(255,250,220,.0)'); cone.addColorStop(1, 'rgba(255,250,220,.22)');
  ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(m.x - 10, 0); ctx.lineTo(m.x + 10, 0); ctx.lineTo(m.x + h * 0.6, m.y + h * 0.5); ctx.lineTo(m.x - h * 0.6, m.y + h * 0.5); ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = '800 24px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const y = Math.max(40, m.y - h * 0.62);
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.75)';
  const line1 = r.item.handle || '';
  const line2 = r.prog.name || '';
  ctx.strokeText(line1, m.x, y - 26, 420); ctx.fillStyle = `hsl(${(env.now / 15) % 360} 100% 72%)`; ctx.fillText(line1, m.x, y - 26, 420);
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  ctx.strokeText('NEW MOVE: ' + line2, m.x, y - 4, 420); ctx.fillStyle = '#fff'; ctx.fillText('NEW MOVE: ' + line2, m.x, y - 4, 420);
  ctx.restore();
}

registerFx({
  // "NEW" banner for a new event or move from a live update.
  name: 'new-highlight', label: 'New highlight', seconds: 6,
  draw(ctx, run, age, env) {
    const a = clamp01(Math.min(age / 0.4, (this.seconds - age) / 0.8));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '900 34px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const text = 'NEW: ' + (run.text || 'update');
    const s = 1 + 0.05 * Math.sin(age * 8);
    ctx.translate(500, 70); ctx.scale(s, s);
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(text, 0, 0, 900);
    ctx.fillStyle = `hsl(${(env.now / 10) % 360} 100% 70%)`; ctx.fillText(text, 0, 0, 900);
    ctx.restore();
    return age < this.seconds;
  }
});
