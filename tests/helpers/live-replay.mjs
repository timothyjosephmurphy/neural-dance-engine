// Live-feed replay (TJ 11:18 AM, "feet are still sliding"): sticker tracks from
// TJ's recorded debug feed (re-detection jumps of ~40 px that last seconds),
// 30 Hz camera jitter, traced-contour height wobble (which also rescales every
// sim through the median sticker height), plus sim dancers. Measures
// planted-foot slip in screen px end to end: on the stage AND in the corner
// insets (as projected by the inset camera).
import fs from 'node:fs';
import {createSilhouetteShow} from '../../neural-dance/src/silhouette.js';
import {resetArmLiftFamilies} from '../../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel, resetSpineFlex} from '../../neural-dance/src/skeleton-motion.js';
import {resetFootwork} from '../../neural-dance/src/footwork-steps.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const FIX = new URL('../fixtures/live-feed/2026-11-10-1120-markers.json', import.meta.url);
export function liveTrack() {
  const j = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const ids = [...new Set(j.frames.flatMap(f => f.markers.map(m => m.id)))];
  const span = j.frames[j.frames.length - 1].t;
  return {ids, span, at(t) { const tt = t % span; let f = j.frames[0]; for (const g of j.frames) { if (g.t <= tt) f = g; else break; } return f.markers; }};
}
function contour(x, y, H) {
  // A simple traced figure: head + body + legs outline, height H, bottom near y + H/2.
  const w = H * 0.28, pts = [];
  for (let i = 0; i < 16; i++) { const a = i / 16 * 2 * Math.PI; pts.push({x: x + Math.sin(a) * w * (0.6 + 0.4 * Math.abs(Math.cos(a))), y: y - Math.cos(a) * H / 2}); }
  return pts;
}
// phases: [{s, level, bpm, kind}] kind 'music' | 'silence'
export function liveReplay({phases = [{s: 120, level: 0.6, kind: 'music'}], sims = 6, fps = 30, jitterPx = 1.5, heightWobble = 0.06, seed = 11, onFrame = null} = {}) {
  resetBodyDynamics(); resetTravel(); resetSpineFlex(); resetArmLiftFamilies(); resetFootwork();
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder(), r = rng(seed), track = liveTrack();
  const simList = []; for (let i = 0; i < sims; i++) simList.push({id: 1 + i, x: 120 + i * 140, y: 470, type: i % 4, kind: 'sim'});
  const prev = new Map(), prevInset = new Map();
  const out = {insetCuts: 0, frames: 0, slipX: [], slipY: [], insetSlip: [], lifts: 0, lowFrames: 0, lowLiftFrames: 0, maxLift: 0, shifts: []};
  let t = 0, f = 0;
  const wob = new Map();
  for (const ph of phases) {
    const period = 60 / (ph.bpm || 120); let lastBeat = -1;
    for (let i = 0; i < Math.round(ph.s * fps); i++, f++) {
      t += 1 / fps; const now = 1000 + t * 1000;
      const music = ph.kind !== 'silence';
      if (show.setHush) show.setHush(!music && i / fps >= 2, now);
      if (music) { const k = Math.floor(t / period); if (k !== lastBeat) { lastBeat = k; show.beat(now, k % 2 ? 1 | 4 : 1 | 8); } }
      const lvl = ph.level; const e = music ? lvl * (0.8 + 0.3 * (t % period < 0.08)) : 0;
      const stickers = track.at(t).map(m => {
        const w = (wob.get(m.id) || 0) * 0.9 + (r() - 0.5) * heightWobble; wob.set(m.id, w);
        const x = m.x + jitterPx * (r() - 0.5) * 2, y = m.y + jitterPx * (r() - 0.5) * 2;
        return {id: m.id, type: m.id % 4, kind: 'sticker', x, y, contour: contour(x, y, 80 * (1 + w))};
      });
      const markers = stickers.concat(simList);
      show.paint(ctx, markers, {now, levels: [e, e * 0.6, e * 0.9, e * 0.6], network: markers.map(m => ({id: m.id, received: music ? lvl : 0})), songOpen: music, xy: (x, y) => ({x, y})});
      const insets = new Map((show.insetStates ? show.insetStates() : []).map(s => [s.id, s.cam]));
      for (const fr of show.figureHeights()) {
        out.frames++;
        const lo = fr.height;
        const clr = s => { const t2 = fr['foot' + s], h2 = fr['heel' + s]; return (fr.floorY - Math.max(t2.y, h2 ? h2.y : t2.y)) / lo; };
        const cL = clr('L'), cR = clr('R');
        const low = music && (+fr.activation || 0) < ph.lowBelow;
        if (f > fps * 4) {
          out.maxLift = Math.max(out.maxLift, cL, cR);
          if (low) { out.lowFrames++; if (Math.max(cL, cR) > 0.003) out.lowLiftFrames++; }
        }
        const p = prev.get(fr.id);
        if (p && f > fps * 4) {
          for (const s of ['L', 'R']) {
            const down = (s === 'L' ? cL : cR) <= 0.002 && p['c' + s] <= 0.002;
            if (!down || fr.jump > 0 || p.jump > 0) continue;
            // pivot allowed: the smaller travel of toe and heel.
            const dx = Math.min(...['foot', 'heel'].filter(k => fr[k + s] && p[k + s]).map(k => Math.abs(fr[k + s].x - p[k + s].x)));
            // Vertical: the foot's floor contact (its lowest point) must not bob;
            // a heel-toe roll keeps that point on the floor line.
            const low = q => Math.max(q['foot' + s].y, q['heel' + s] ? q['heel' + s].y : -Infinity);
            const dy = Math.abs(low(fr) - low(p));
            out.slipX.push(dx); out.slipY.push(dy);
            const cam = insets.get(fr.id), pc = prevInset.get(fr.id);
            const cut = cam && pc && (cam.cx !== pc.cx || cam.top !== pc.top || cam.k !== pc.k);
            if (cut) out.insetCuts = (out.insetCuts || 0) + 1; // a re-frame cut, not a slide
            if (cam && pc && !cut) {
              const X = (c, q) => ({x: c.rect.x + c.rect.w / 2 + (q.x - c.cx) * c.k, y: c.rect.y + c.rect.h * 0.08 + (q.y - c.top) * c.k});
              // Same rule as on stage, in inset px: horizontal = the smaller toe/heel
              // travel (a pivot is allowed), vertical = the floor contact.
              const ix = Math.min(...['foot', 'heel'].filter(k => fr[k + s] && p[k + s]).map(k => Math.abs(X(cam, fr[k + s]).x - X(pc, p[k + s]).x)));
              const lowP = (c, q) => Math.max(...['foot', 'heel'].filter(k => q[k + s]).map(k => X(c, q[k + s]).y));
              const d = Math.hypot(ix, lowP(cam, fr) - lowP(pc, p));
              out.insetSlip.push(d);
            }
          }
        }
        if (onFrame) onFrame(fr, {t, music, cL, cR, ph});
        prev.set(fr.id, {cL, cR, jump: +fr.jump || 0, footL: {...fr.footL}, heelL: fr.heelL && {...fr.heelL}, footR: {...fr.footR}, heelR: fr.heelR && {...fr.heelR}});
        const cam = insets.get(fr.id); if (cam) prevInset.set(fr.id, cam); else prevInset.delete(fr.id);
      }
    }
  }
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
  for (const k of ['slipX', 'slipY', 'insetSlip']) { out[k + 'Max'] = q(out[k], 1); out[k + 'P99'] = q(out[k], 0.99); out[k + 'Over05'] = out[k].filter(v => v > 0.5).length; out[k] = out[k].length; }
  return out;
}
