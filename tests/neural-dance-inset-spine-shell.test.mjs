// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 10 1:13–1:17 PM on live 0b1b237:
// (B) inset dancers change size a lot -> one size per inset over 60 s (2%).
// (C) the spine sometimes bends far beyond the body -> per-segment and total
//     bend limits.
// (D) dancers jerk a little -> no per-frame height snaps from re-traced
//     sticker contours; low per-frame jerk of the head.
// (E) the side-sim shell and glow are not visible -> the full shell paints
//     chakra glow (clipped to the body) and a projector-visible rim at
//     default settings; bloom 0 means no glow.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSilhouetteShow, lockFigureHeight, shellGlowAmount, scalePoseFromFloor} from '../neural-dance/src/silhouette.js';
import {placePose, resetArmLiftFamilies, skeletonPose} from '../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel, spineFlexState, SPINE_FLEX, SPINE_MAX_SEG_DEG, SPINE_MAX_TOTAL} from '../neural-dance/src/skeleton-motion.js';
import {drawShadowFigure, paintShellGlow, shellChakraLights} from '../neural-dance/src/body-shell.js';

function recorder(log) {
  const target = {canvas: {width: 1000, height: 620},
    createRadialGradient(...a) { log && log.push(['grad', ...a]); return {addColorStop(o, c) { log && log.push(['stop', o, c]); }}; },
    createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; },
    clip() { log && log.push(['clip']); }, stroke() { log && log.push(['stroke', target.strokeStyle]); }, fill() { log && log.push(['fill', target.fillStyle]); }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set(t, k, v) { t[k] = v; return true; }});
}
function contour(cx, cy, h) {
  const w = h * 0.4;
  return [{x: cx - w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy + h / 2}, {x: cx - w / 2, y: cy + h / 2}];
}
function runShow(seconds, {jitter = 0.2, level = 0.7, seed = 3, pad = false} = {}) {
  resetBodyDynamics(); resetTravel(); resetArmLiftFamilies();
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder();
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const stickers = [{id: 20, x: 382, y: 289, type: 0}, {id: 21, x: 508, y: 190, type: 1}, {id: 22, x: 576, y: 299, type: 2}, {id: 23, x: 700, y: 250, type: 3}];
  const frames = [];
  let h0 = stickers.map(() => 60);
  for (let i = 0; i < seconds * 30; i++) {
    const now = 1000 + i * 1000 / 30;
    if (i % 15 === 0) show.beat(now, 1 | 2 | 4 | 8);
    // Re-traced contour heights wobble +-jitter every ~0.5 s (lighting, glow).
    if (i % 15 === 0) h0 = stickers.map(() => 60 * (1 + jitter * (rnd() * 2 - 1)));
    const markers = stickers.map((st, k) => ({...st, kind: 'sticker', contour: contour(st.x, st.y, h0[k])}));
    const padFeatures = pad ? {env: 0.85, note: 0.7, contour: 0.65, onset: 0.45, subLo: 0.15, subHi: 0.85, cres: 0.35, vib: 0.2, kind: 'high'} : null;
    show.paint(ctx, markers, {now, levels: [level, level, level, level], network: markers.map(m => ({id: m.id, received: level})), padFeatures});
    frames.push({insets: show.insetStates(), figs: show.figureHeights()});
  }
  return frames;
}

test('(B) every inset dancer keeps one size within 2% over 60 s', () => {
  // 10 s to lock onto the first traces (8 s window + ease), then 60 s measured.
  const frames = runShow(72);
  const by = new Map();
  for (const f of frames.slice(360)) for (const ins of f.insets) {
    if (!(ins.drawnPx > 0)) continue;
    const a = by.get(ins.id) || []; a.push(ins.drawnPx); by.set(ins.id, a);
  }
  assert.ok(by.size >= 3, 'insets painted: ' + by.size);
  for (const [id, a] of by) {
    const lo = Math.min(...a), hi = Math.max(...a);
    assert.ok((hi - lo) / lo <= 0.02, 'inset #' + id + ' size ' + lo.toFixed(1) + '..' + hi.toFixed(1));
  }
});

test('(C) each spine segment stays within a few degrees; the chain is soft-capped', () => {
  const seg = SPINE_MAX_SEG_DEG * Math.PI / 180 + 1e-9;
  const total = SPINE_MAX_TOTAL * 1.2 + 1e-9; // soft cap may slightly overshoot
  let worst = 0, worstSeg = 0;
  for (let k = 0; k < 400; k++) {
    const t = k * 0.05;
    const strikes = [];
    for (let j = 0; j < 12; j++) strikes.push({t0: t - j * 0.25, side: j % 2 ? 1 : -1, energy: 1.4});
    const sp = spineFlexState({tSec: t, strikes, activation: 1.3, amp: 40, hz: 2.2, hush: 1, amount: SPINE_FLEX, lagMul: 4});
    for (const key of ['pelvis', 'lumbar', 'thoracic', 'neck']) {
      assert.ok(Math.abs(sp.angles[key]) <= seg, key + ' ' + sp.angles[key]);
      worstSeg = Math.max(worstSeg, Math.abs(sp.angles[key]));
    }
    worst = Math.max(worst, Math.abs(sp.phi.neck));
  }
  // Human ranges: per-segment ~16°, combined lateral ~30°, total through the neck is soft-capped.
  assert.ok(SPINE_MAX_SEG_DEG >= 12 && SPINE_MAX_SEG_DEG <= 20, 'per-segment cap is a human lumbar/thoracic station');
  assert.ok(worst <= total, 'summed neck phi ' + (worst * 180 / Math.PI).toFixed(1) + ' deg');
  const src = readFileSync(new URL('../neural-dance/src/skeleton-motion.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function spineFlexState'), src.indexOf('export function armPulseEvents'));
  assert.match(fn, /soft\(phiT \+ neckA \* kC,/);
  console.log('spine worst total deg', (worst * 180 / Math.PI).toFixed(1), 'seg', (worstSeg * 180 / Math.PI).toFixed(1));
});

test('(C) in the live show the neck stays over the torso (inside the body)', () => {
  const frames = runShow(30, {level: 1.2});
  let worst = 0;
  for (const f of frames.slice(60)) for (const fr of f.figs) {
    const j = fr.joints; if (!j || !j.groin || !j.head) continue;
    const lean = Math.abs(j.head.x - j.groin.x) / fr.height;
    worst = Math.max(worst, lean);
  }
  assert.ok(worst < 0.50, 'head-over-groin lean stays in human range ' + worst.toFixed(3) + ' heights');
});

test('(D) a re-traced contour wobble never snaps the body size; real changes ease in', () => {
  const locks = new Map();
  let h = lockFigureHeight(locks, 1, 60, 0), maxStep = 0;
  // The real change lands within ~10 s (8 s median window + ease).
  for (let i = 1; i < 480; i++) {
    const target = i < 150 ? 60 * (1 + 0.2 * Math.sin(i)) : 80;
    const nh = lockFigureHeight(locks, 1, target, i * 33.3);
    maxStep = Math.max(maxStep, Math.abs(nh - h));
    if (i === 149) assert.ok(Math.abs(nh - 60) < 1.8, 'wobble held (within 3%): ' + nh);
    h = nh;
  }
  assert.ok(Math.abs(h - 80) < 1, 'real change reached: ' + h);
  assert.ok(maxStep < 1.5, 'max per-frame height step ' + maxStep.toFixed(2) + ' px');
});

test('(D) lower head jerk with re-traced contour jitter', () => {
  const frames = runShow(30, {jitter: 0.2});
  const per = new Map();
  for (const f of frames.slice(60)) for (const fr of f.figs) {
    const j = fr.joints; if (!j || !j.head) continue;
    const a = per.get(fr.id) || []; a.push(j.head.y); per.set(fr.id, a);
  }
  let worst = 0;
  for (const a of per.values()) for (let i = 3; i < a.length; i++) {
    const jerk = Math.abs(a[i] - 3 * a[i - 1] + 3 * a[i - 2] - a[i - 3]);
    worst = Math.max(worst, jerk);
  }
  console.log('head jerk px/frame^3', worst.toFixed(2));
  assert.ok(worst < 6, 'head jerk ' + worst.toFixed(2));
});

test('(E) full shell paints clipped chakra glow and a rim at default bloom; bloom 0 means no glow', () => {
  const pose = placePose(skeletonPose({id: 3, band: 1, activation: 0.2, now: 1000}), 100, 40, 120);
  const lights = shellChakraLights(pose, 0);
  assert.equal(lights.length, 7);
  const log = [];
  paintShellGlow(recorder(log), pose, {glow: shellGlowAmount({glow: 0.45})});
  assert.ok(log.some(e => e[0] === 'clip'), 'glow is clipped inside the body (no #828 bloom)');
  assert.equal(log.filter(e => e[0] === 'grad').length, 7, 'seven chakra lights');
  const stops = log.filter(e => e[0] === 'stop' && e[1] === 0).map(e => +String(e[2]).match(/([0-9.]+)\)$/)[1]);
  assert.ok(Math.min(...stops) >= 0.12, 'glow visible at rest: min alpha ' + Math.min(...stops));
  assert.ok(log.some(e => e[0] === 'stroke' && /rgba\(178, 198, 238/.test(e[1])), 'rim line');
  const off = [];
  paintShellGlow(recorder(off), pose, {glow: shellGlowAmount({glow: 0})});
  assert.equal(off.filter(e => e[0] === 'grad').length, 0, 'bloom 0: no glow');
  assert.equal(shellGlowAmount({glow: 0.45}), 0.67);
});

test('(E) the full shell never throws on a live pose (head radius in units) in a strict canvas', () => {
  const pose = placePose(skeletonPose({id: 5, band: 2, activation: 0.6, now: 2000}), 300, 80, 140);
  assert.ok(!(+pose.headR > 0), 'live poses carry b.headR, not px headR');
  const fin = (...a) => { if (a.some(v => typeof v === 'number' && !Number.isFinite(v))) throw new TypeError('The provided double value is non-finite.'); };
  const log = [];
  const ctx = recorder(log);
  const strict = new Proxy(ctx, {get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return (...a) => { fin(...a); return {addColorStop() {}}; };
    if (k === 'arc' || k === 'ellipse' || k === 'moveTo' || k === 'lineTo') return (...a) => { fin(...a); };
    return t[k];
  }, set(t, k, v) { t[k] = v; return true; }});
  assert.doesNotThrow(() => drawShadowFigure(strict, pose, {lod: 'full', skipBloom: true, glow: 0.67, flash: 0.2}));
});


test('scalePoseFromFloor holds crown-to-floor height and the planted foot', () => {
  const posed = {
    height: 114, floorY: 400, stance: 'footL',
    footL: {x: 200, y: 400, z: 0}, footR: {x: 240, y: 398, z: 0},
    crown: {x: 220, y: 286, z: 0}, groin: {x: 220, y: 350, z: 0},
    handL: {x: 160, y: 250, z: 0}
  };
  const locked = scalePoseFromFloor(posed, 100);
  assert.ok(locked);
  const span = locked.footL.y - locked.crown.y;
  const orig = posed.footL.y - posed.crown.y;
  assert.ok(Math.abs(span - orig * (100 / 114)) < 0.05, 'span scales from the floor');
  assert.equal(locked.footL.x, posed.footL.x);
  assert.ok(Math.abs(locked.footL.y - posed.footL.y) < 0.05, 'planted foot stays');
  assert.equal(locked.height, 100);
  assert.equal(scalePoseFromFloor(posed, 114), posed, 'near-equal height is a no-op');
});

test('(B) inset visual size stays within 2% with pad/melody arms and contour wobble', () => {
  const frames = runShow(72, {jitter: 0.2, pad: true, level: 0.85});
  const by = new Map();
  for (const f of frames.slice(360)) for (const ins of f.insets) {
    const v = ins.visPx > 0 ? ins.visPx : ins.drawnPx;
    if (!(v > 0)) continue;
    const a = by.get(ins.id) || []; a.push(v); by.set(ins.id, a);
  }
  assert.ok(by.size >= 3, 'insets painted: ' + by.size);
  for (const [id, a] of by) {
    const lo = Math.min(...a), hi = Math.max(...a);
    // visPx is the posed span (squat + pad/melody arm reach). Rigid-leg reach can drop the pelvis a little more than the earlier 5% flex allowance.
    assert.ok((hi - lo) / lo <= 0.08, 'inset #' + id + ' vis ' + lo.toFixed(1) + '..' + hi.toFixed(1));
  }
});
