// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 10 1:51–1:59 PM on live d634f3a:
// - Ripple spots with no dancer: camera stickers and sims both number from 1,
//   so sticker #1 and sim #1 shared per-dancer state and sim #1 stood on the
//   sticker's floor pin. Every dancer draws its own figure on its own spot.
// - The spine still goes "a little bit wild": the chakra string / spine stays
//   inside the torso and hip frame, with a natural total bend and smooth bend
//   velocity, across a 24-sim high-activation replay.
// - The body is a semi-transparent 3D volume lit from inside by the pulses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSilhouetteShow, dancerStateId} from '../neural-dance/src/silhouette.js';
import {readFileSync} from 'node:fs';
import {bodyPulseLights, placePose, placePoseOnFloor, skeletonPose, chakraAnchors, paintShadowFigure} from '../neural-dance/src/skeleton-dancer.js';
import {chakraHueAt, drawVolumeBody, VOLUME_TINT, VOLUME_RIM, addTorsoPath} from '../neural-dance/src/body-shell.js';
import {liveReplay} from './helpers/live-replay.mjs';
import {pulseStringPoints} from '../neural-dance/src/vibrating-string.js';

function recorder(log) {
  const target = {canvas: {width: 1280, height: 800},
    createRadialGradient(...a) { log && log.push(['grad', ...a]); return {addColorStop(o, c) { log && log.push(['stop', o, c]); }}; },
    createLinearGradient() { log && log.push(['lin']); return {addColorStop() {}}; }, measureText() { return {width: 10}; },
    clip() { log && log.push(['clip']); }, stroke() { log && log.push(['stroke', target.strokeStyle, target.globalAlpha, target.lineWidth]); }, fill() { log && log.push(['fill', target.fillStyle]); }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set(t, k, v) { t[k] = v; return true; }});
}
const box = (cx, cy, h) => { const w = h * 0.4; return [{x: cx - w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy - h / 2}, {x: cx + w / 2, y: cy + h / 2}, {x: cx - w / 2, y: cy + h / 2}]; };

test('every dancer draws its own figure on its own spot (24 sims + 3 stickers with overlapping ids)', () => {
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder();
  const sims = []; for (let i = 0; i < 24; i++) sims.push({id: 1 + i, x: 80 + (i % 8) * 115, y: 140 + Math.floor(i / 8) * 170, type: i % 4, kind: 'sim'});
  const stickers = [{id: 1, x: 470, y: 420, type: 0}, {id: 2, x: 620, y: 310, type: 1}, {id: 3, x: 700, y: 450, type: 2}].map(s => ({...s, kind: 'sticker', contour: box(s.x, s.y, 70)}));
  const markers = stickers.concat(sims);
  for (let i = 0; i < 150; i++) {
    const now = 1000 + i * 33.3; if (i % 15 === 0) show.beat(now, 15);
    show.paint(ctx, markers, {now, levels: [0.7, 0.7, 0.7, 0.7], songOpen: true, network: markers.map(m => ({id: dancerStateId(m), received: 0.7}))});
    const figs = show.figureHeights();
    assert.equal(figs.length, markers.length, 'drawn figures = dancers');
    if (i < 30) continue;
    for (const m of markers) {
      const f = figs.find(q => q.id === m.id && q.kind === m.kind);
      assert.ok(f, m.kind + ' #' + m.id + ' drawn');
      const d = Math.hypot(f.joints.groin.x - m.x, f.joints.groin.y - m.y) / f.height;
      assert.ok(d < 0.6, m.kind + ' #' + m.id + ' stands on its spot (' + d.toFixed(2) + ' heights off)');
    }
  }
  assert.notEqual(dancerStateId({id: 1, kind: 'sticker'}), dancerStateId({id: 1, kind: 'sim'}));
});

test('24-sim high-activation replay: d634f3a spine motion, neck stays in the head', () => {
  const deg = r => r * 180 / Math.PI;
  const res = {frames: 0, maxBend: 0, outside: 0, outsideHead: 0, vel: 0};
  const prev = new Map();
  liveReplay({sims: 24, phases: [{s: 25, level: 1.2, kind: 'music', bpm: 128}], onFrame(fr) {
    const j = fr.joints, pts = fr.string; if (!j || !pts || !j.head) return;
    res.frames++;
    const H = fr.height;
    const hipHalf = Math.abs(j.hipR.x - j.hipL.x) / 2, shHalf = Math.abs(j.shR.x - j.shL.x) / 2;
    let tot = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], s = p.s;
      const mid = s <= 0.6 ? j.groin.x + (j.neck.x - j.groin.x) * (s / 0.6) : j.neck.x + (j.head.x - j.neck.x) * Math.min(1, (s - 0.6) / 0.35);
      const half = s <= 0.6 ? Math.max(0.035 * H, Math.min(hipHalf, shHalf) * (0.75 + 0.25 * s / 0.6)) : 0.045 * H;
      const out = (Math.abs(p.x - mid) - half) / H;
      res.outside = Math.max(res.outside, out);
      if (s > 0.6) res.outsideHead = Math.max(res.outsideHead, out);
      if (i) tot = Math.max(tot, Math.abs(deg(Math.atan2(p.x - pts[i - 1].x, pts[i - 1].y - p.y))));
    }
    const pv = prev.get(fr.id); if (pv != null) res.vel = Math.max(res.vel, Math.abs(tot - pv)); prev.set(fr.id, tot);
    res.maxBend = Math.max(res.maxBend, tot);
  }});
  console.log('# spine replay', JSON.stringify(res));
  assert.ok(res.frames > 10000);
  // TJ Nov 10 4:10 PM: the chakra string is a subtle in-torso shimmer, not a
  // second wild spine. It still travels, but stays well inside the body.
  assert.ok(res.maxBend > 2, 'string still has a little wave (' + res.maxBend.toFixed(1) + ' deg)');
  assert.ok(res.maxBend <= 55, 'string follows the flexed spine, without kinks (' + res.maxBend.toFixed(1) + ' deg)');
  assert.ok(res.outside <= 0.03, 'string stays inside the torso (' + res.outside.toFixed(3) + ' heights)');
  assert.ok(res.outsideHead <= 0.02, 'neck/head stay near the body (' + res.outsideHead.toFixed(3) + ' heights)');
  assert.ok(res.vel <= 10, 'bend velocity ' + res.vel.toFixed(1) + ' deg/frame');
});

test('volumetric body: see-through tint, rounded shading, pulses light it from inside', () => {
  const pose = placePose(skeletonPose({id: 3, band: 1, activation: 0.6, now: 1000}), 300, 60, 160);
  const L = bodyPulseLights(pose, {legSide: 1, legU: 0.4, armU: 0.5, travelS: 0.45, hueAt: chakraHueAt, energy: 0.8});
  assert.equal(L.pulses.length, 4, 'leg + two arms + string pulse');
  assert.ok(L.torso && L.torso.a > 0.3, 'arrival lights the torso');
  const log = [];
  drawVolumeBody(recorder(log), {...pose, headR: pose.b.headR * pose.height}, {glow: 0.67, pulses: L.pulses, torso: L.torso});
  const tint = +VOLUME_TINT.match(/([0-9.]+)\)$/)[1];
  assert.ok(tint > 0 && tint <= 0.25, 'semi-transparent body');
  assert.ok(log.some(e => e[0] === 'clip'), 'inner light clipped to the body (no #828 bloom)');
  const shades = log.filter(e => e[0] === 'fill' && /176, 196, 236/.test(String(e[1])));
  assert.ok(shades.length >= 12, 'rounded shading passes ' + shades.length);
  const grads = log.filter(e => e[0] === 'grad');
  assert.equal(grads.length, 5, 'torso + 4 pulse lights');
  const stops = log.filter(e => e[0] === 'stop' && e[1] === 0).map(e => String(e[2]));
  assert.ok(stops.some(c => /^hsla\(8,/.test(c)), 'leg pulse in its red');
  assert.ok(stops.some(c => /^hsla\(120,/.test(c)), 'arm pulse in its green');
  // Off-pulse the body still reads (tint + shading + rim) with no gradients.
  const quiet = [];
  drawVolumeBody(recorder(quiet), {...pose, headR: pose.b.headR * pose.height}, {glow: 0});
  assert.equal(quiet.filter(e => e[0] === 'grad').length, 0, 'bloom 0: no inner glow');
  assert.ok(quiet.some(e => e[0] === 'stroke' && /196, 214, 248/.test(String(e[1]))), 'projector rim');
});

test('small (cheap LOD) dancers are see-through volumes too, lit by their pulses', async () => {
  const {paintShadowFigure, VOLUME_FILL_CHEAP} = await import('../neural-dance/src/skeleton-dancer.js');
  const pose = placePose(skeletonPose({id: 5, band: 2, activation: 0.6, now: 1000}), 300, 60, 70);
  const L = bodyPulseLights(pose, {legSide: -1, legU: 0.7, armU: -1, travelS: -1, energy: 1});
  const log = [];
  assert.ok(paintShadowFigure(recorder(log), pose, (x, y) => ({x, y}), {lod: 'cheap', volume: true, pulses: L.pulses, glow: 0.67}));
  const fills = log.filter(e => e[0] === 'fill').map(e => String(e[1]));
  assert.ok(fills.includes(VOLUME_FILL_CHEAP), 'translucent body fill');
  assert.ok(!fills.some(c => /rgba\(\s*(\d+),\s*\d+,\s*\d+,\s*0\.9/.test(c) && +RegExp.$1 < 40), 'no dark opaque body');
  assert.ok(fills.some(c => /^hsla\(8,/.test(c)), 'leg pulse light');
});

function sampleQuad(ax, ay, cx, cy, bx, by, n = 20) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({x: u * u * ax + 2 * u * t * cx + t * t * bx, y: u * u * ay + 2 * u * t * cy + t * t * by});
  }
  return out;
}

test('no torso or spine geometry extends below the pelvis line between the legs', () => {
  // TJ Nov 10 3:19 PM on live f9255e5: two thin strands dropped from the
  // groin to the feet (torso/pelvis volume or a rim/string stroke). Nothing
  // but the legs themselves may go below the crotch.
  const unit = skeletonPose({id: 7, band: 2, activation: 1, now: 2400, weight: -0.4, ease: 0.35, side: -1});
  const pose = placePoseOnFloor(unit, {cx: 400, cy: 280, baseH: 160, height: 160 * 1.1, side: -1});
  const pelvisY = Math.max(pose.groin.y, pose.hipL.y, pose.hipR.y);
  const slop = pose.height * 0.035; // shallow crotch / seat only
  const ops = [];
  const g = {
    moveTo(x, y) { ops.push(['m', +x, +y]); },
    lineTo(x, y) { ops.push(['l', +x, +y]); },
    quadraticCurveTo(cx, cy, x, y) { ops.push(['q', +cx, +cy, +x, +y]); },
    bezierCurveTo() {}, closePath() {}, beginPath() {}, arc() {}, ellipse() {}
  };
  addTorsoPath(g, pose);
  const pts = [];
  let x = 0, y = 0;
  for (const op of ops) {
    if (op[0] === 'm') { x = op[1]; y = op[2]; pts.push({x, y}); }
    else if (op[0] === 'l') { x = op[1]; y = op[2]; pts.push({x, y}); }
    else if (op[0] === 'q') {
      pts.push(...sampleQuad(x, y, op[1], op[2], op[3], op[4]));
      x = op[3]; y = op[4];
    }
  }
  const torsoBelow = pts.filter(p => p.y > pelvisY + slop);
  assert.equal(torsoBelow.length, 0, 'torso path below pelvis by ' + (torsoBelow[0] ? (torsoBelow[0].y - pelvisY).toFixed(1) : 0) + ' px');

  const anchors = chakraAnchors(pose);
  const axis = {x: anchors.root.x, top: anchors.crown.y, height: anchors.root.y - anchors.crown.y, bottom: anchors.root.y};
  // pulseStringPoints uses STRING_ROOT_S of a full-figure axis; feed a
  // contour-equivalent axis so root maps to the groin.
  const {STRING_ROOT_S, STRING_CROWN_S} = {STRING_ROOT_S: 0.54, STRING_CROWN_S: 0.05};
  const span = (anchors.root.y - anchors.crown.y) / (STRING_ROOT_S - STRING_CROWN_S);
  const top = anchors.crown.y - span * STRING_CROWN_S;
  const stringPts = pulseStringPoints({x: anchors.root.x, top, height: span}, {
    now: 2400, amp: 20, rest: 4, strikes: [{t0: 1.0, side: 1, energy: 1}, {t0: 1.5, side: -1, energy: 1}]
  }) || [];
  const spineBelow = stringPts.filter(p => p.y > pelvisY + slop);
  assert.equal(spineBelow.length, 0, 'spine/string below pelvis by ' + (spineBelow[0] ? (spineBelow[0].y - pelvisY).toFixed(1) : 0) + ' px');
  assert.ok(stringPts.length > 8, 'string sampled');

  const log = [];
  const ctx = recorder(log);
  drawVolumeBody(ctx, {...pose, headR: pose.b.headR * pose.height}, {glow: 0.67});
  // The rim stroke must be torso/head, not the compound leg capsules.
  const strokes = log.filter(e => e[0] === 'stroke');
  assert.ok(strokes.length >= 1, 'volume still has a rim');
});

test('idle / rest live dancers keep the see-through volume body, not stick figures', () => {
  // TJ Nov 10 11:22 PM: live dancers looked right while moving, but at rest
  // (low activation, no sticker motion) they fell back to the old stick
  // figures — a boxy torso and thin limb strokes. The volume painter was
  // already being called; a default-on stick skeleton overlay took over
  // once the pulse light went quiet.
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('paintShadowFigure(ctx, posed'));
  assert.match(call, /volume:\s*true/);
  assert.match(call, /skeleton:\s*false/);

  const rest = placePose(skeletonPose({
    id: 2, band: 0, activation: 0, hush: 0, still: true, now: 4000,
  }), 300, 60, 160);
  const restPose = {...rest, headR: rest.b.headR * rest.height};
  const liveOpts = {lod: 'full', volume: true, glow: 0.67, flash: 0, pulses: null, torso: null};

  const log = [];
  assert.ok(paintShadowFigure(recorder(log), restPose, (x, y) => ({x, y}), liveOpts));
  const fills = log.filter(e => e[0] === 'fill').map(e => String(e[1]));
  const strokes = log.filter(e => e[0] === 'stroke').map(e => String(e[1]));
  assert.ok(fills.includes(VOLUME_TINT), 'rest body still fills the volume tint, got ' + fills.slice(0, 8));
  assert.ok(strokes.some(s => s.includes('196, 214, 248') || s === VOLUME_RIM), 'rest body still has the volume rim');
  assert.ok(!strokes.some(s => /214,\s*230,\s*255/.test(s)), 'no stick-skeleton overlay at rest, strokes=' + strokes.slice(0, 8));
  assert.ok(!fills.some(c => /rgba\(\s*(\d+),\s*\d+,\s*\d+,\s*0\.9/.test(c) && +RegExp.$1 < 40), 'no dark opaque stick body');

  // Default (no skeleton flag) must stay off so a missed option cannot
  // resurrect the idle stick figures.
  const def = [];
  assert.ok(paintShadowFigure(recorder(def), restPose, (x, y) => ({x, y}), {lod: 'full', volume: true, glow: 0.67, flash: 0}));
  assert.ok(!def.filter(e => e[0] === 'stroke').some(e => /214,\s*230,\s*255/.test(String(e[1]))), 'skeleton overlay is opt-in');

  // Opt-in still works for debug / tests that want the lines.
  const on = [];
  assert.ok(paintShadowFigure(recorder(on), restPose, (x, y) => ({x, y}), {lod: 'full', volume: true, glow: 0.67, flash: 0, skeleton: true}));
  assert.ok(on.filter(e => e[0] === 'stroke').some(e => /214,\s*230,\s*255/.test(String(e[1]))), 'skeleton: true still draws the lines');
});
