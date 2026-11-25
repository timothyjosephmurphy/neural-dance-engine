// Sticker pose (TJ Nov 11 3:07 PM): each live dancer's silhouette lines up
// with the sticker it was scanned from. The traced sticker figure is fitted
// to the skeleton (head, shoulders, hands, hips, feet); the dancer returns to
// that pose on phrase downbeats (every 4-8 bars) and at rest, with no snaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {POSES, stickerContour, figureJoints} from './helpers-sticker-figure.mjs';
import {fitStickerPose, fitError, FIT_TOL, stickerPoseTarget, createStickerPoseBlend, blendStickerPose, phraseBarsFor, PHRASE_BARS_MIN, PHRASE_BARS_MAX} from '../neural-dance/src/sticker-pose.js';
import {createSilhouetteShow, applyHomography, centerOn, placeContour, figureHeight} from '../neural-dance/src/silhouette.js';
import {resetBodyDynamics, resetTravel, resetSpineFlex} from '../neural-dance/src/skeleton-motion.js';
import {resetArmLiftFamilies, skeletonPose, placePoseOnFloor} from '../neural-dance/src/skeleton-dancer.js';

const KEYS = ['head', 'shL', 'shR', 'hipL', 'hipR', 'handL', 'handR', 'footL', 'footR'];

test('pose fit matches the sticker figure joints within tolerance (live 48-point trace)', () => {
  for (const name of Object.keys(POSES)) {
    const {contour, joints} = stickerContour(name);
    const fit = fitStickerPose(contour, 200);
    assert.ok(fit, name);
    const err = fitError(fit, joints, KEYS);
    assert.ok(err < FIT_TOL / 2, `${name} mean error ${err.toFixed(3)} H`);
    for (const k of KEYS) {
      const d = Math.hypot(fit[k].x - joints[k].x, fit[k].y - joints[k].y) / joints.height;
      assert.ok(d < FIT_TOL, `${name} ${k} off by ${d.toFixed(3)} H`);
    }
  }
});

test('fit holds in projector space: contour and joints through the same homography', () => {
  // Mild keystone like a real projector/camera quad.
  const Hm = [1.08, 0.06, -20, 0.02, 0.95, 12, 0.00018, 0.00009, 1];
  const P = p => applyHomography(Hm, p.x, p.y);
  for (const name of ['dancing', 'tPose', 'armsUp']) {
    const {contour, joints} = stickerContour(name);
    const pc = contour.map(P);
    const pj = {}; for (const k of KEYS) pj[k] = P(joints[k]);
    const fit = fitStickerPose(pc, P({x: 200, y: 140}).x);
    pj.height = fit.height;
    for (const k of KEYS) {
      const d = Math.hypot(fit[k].x - pj[k].x, fit[k].y - pj[k].y) / fit.height;
      assert.ok(d < FIT_TOL, `${name} ${k} off by ${d.toFixed(3)} H after the homography`);
    }
  }
});

test('phrase clock: home pose on every phrase downbeat (4 or 8 bars), free mid-phrase, full at rest', () => {
  for (const bars of [PHRASE_BARS_MIN, PHRASE_BARS_MAX]) {
    const span = bars * 4;
    for (let phrase = 0; phrase < 4; phrase++) {
      const down = phrase * span;
      assert.ok(stickerPoseTarget({beat: down + 0.5, bars, activation: 0.9}) >= 0.8, 'at the downbeat');
      assert.ok(stickerPoseTarget({beat: down + span / 2, bars, activation: 0.9}) < 0.01, 'mid-phrase dancing');
    }
  }
  assert.equal(stickerPoseTarget({beat: 7.3, activation: 0.02}), 1, 'rest / low activation');
  assert.equal(stickerPoseTarget({beat: 7.3, activation: 0.9, hush: 0}), 1, 'silence');
  assert.ok([PHRASE_BARS_MIN, PHRASE_BARS_MAX].includes(phraseBarsFor(3)));
  const lens = new Set(); for (let id = 1; id < 40; id++) lens.add(phraseBarsFor(id));
  assert.equal(lens.size, 2, 'dancers mix 4- and 8-bar phrases');
});

test('blend weight is smooth: no snap in or out (bounded velocity and acceleration)', () => {
  const blend = createStickerPoseBlend();
  const bpm = 124, fps = 60, beatS = 60 / bpm;
  const ws = [];
  for (let f = 0; f < fps * 60; f++) {
    const t = f / fps;
    const target = stickerPoseTarget({beat: t / beatS, bars: 4, activation: 0.85});
    ws.push(blend.step(7, target, t * 1000));
  }
  let maxV = 0, maxA = 0;
  for (let i = 2; i < ws.length; i++) {
    maxV = Math.max(maxV, Math.abs(ws[i] - ws[i - 1]));
    maxA = Math.max(maxA, Math.abs(ws[i] - 2 * ws[i - 1] + ws[i - 2]));
  }
  assert.ok(ws[0] < 0.01, 'eases in from 0');
  assert.ok(maxV < 0.045, 'per-frame change ' + maxV.toFixed(3));
  assert.ok(maxA < 0.015, 'per-frame acceleration ' + maxA.toFixed(4));
  // Returns periodically: peaks >= 0.75 once per 4-bar phrase.
  const phraseF = Math.round(16 * beatS * fps);
  for (let p = 1; p < 7; p++) {
    const win = ws.slice(p * phraseF - 20, p * phraseF + 3 * Math.round(beatS * fps));
    assert.ok(Math.max(...win) >= 0.75, 'phrase ' + p + ' returns home (' + Math.max(...win).toFixed(2) + ')');
    const midWin = ws.slice(p * phraseF + Math.round(7 * beatS * fps), p * phraseF + Math.round(12 * beatS * fps));
    assert.ok(Math.min(...midWin) < 0.1, 'phrase ' + p + ' dances away from it');
  }
});

test('blendStickerPose at full weight puts the hands on the sticker, keeps bones and planted feet', () => {
  const {contour, joints} = stickerContour('dancing', {H: 180, cx: 500, top: 150, W: 800, Hh: 400});
  const fit = fitStickerPose(contour, 500);
  const unit = skeletonPose({id: 3, band: 0, now: 0, hush: 0, still: true});
  const posed = placePoseOnFloor(unit, {cx: 500, cy: (fit.top + fit.bottom) / 2, baseH: fit.height, height: fit.height, side: -1});
  const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const before = {upL: len(posed.shL, posed.elL), foreL: len(posed.elL, posed.wristL), footL: {...posed.footL}, footR: {...posed.footR}};
  blendStickerPose(posed, fit, 1, {bothPlanted: true});
  for (const k of ['handL', 'handR']) {
    const d = len(posed[k], fit[k]) / fit.height;
    assert.ok(d < FIT_TOL, k + ' on the sticker hand (' + d.toFixed(3) + ' H)');
    assert.ok(len(posed[k], joints[k]) / fit.height < FIT_TOL * 1.5, k + ' on the true sticker hand');
  }
  assert.ok(Math.abs(len(posed.shL, posed.elL) - before.upL) < 0.5 && Math.abs(len(posed.elL, posed.wristL) - before.foreL) < 0.5, 'arm bone lengths kept');
  assert.deepEqual([posed.footL.x, posed.footL.y, posed.footR.x, posed.footR.y], [before.footL.x, before.footL.y, before.footR.x, before.footR.y], 'planted feet never slide');
  const sh = {x: (posed.shL.x + posed.shR.x) / 2}, hip = {x: (posed.hipL.x + posed.hipR.x) / 2};
  assert.ok(Math.abs(sh.x - hip.x) <= 0.03 * fit.height, 'torso stays upright');
});

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}

test('live render: sticker dancers return to their sticker pose at rest and on phrase downbeats, smoothly', () => {
  resetBodyDynamics(); resetTravel(); resetSpineFlex(); resetArmLiftFamilies();
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder();
  const stickers = [{id: 31, x: 250, y: 330, type: 2, pose: 'dancing'}, {id: 32, x: 650, y: 330, type: 3, pose: 'tPose'}];
  for (const s of stickers) {
    const {contour} = stickerContour(s.pose, {H: 90, cx: s.x, top: s.y - 45, W: 1000, Hh: 620});
    s.contour = contour;
    s.fit = fitStickerPose(centerOn(placeContour(contour, s.x, s.y, 90 / figureHeight(contour)), s.x, s.y), s.x);
  }
  const fps = 30, bpm = 120, period = 0.5;
  const phases = [{s: 40, music: true, level: 0.9}, {s: 12, music: false}];
  const rows = new Map(stickers.map(s => [s.id, []]));
  let t = 0, lastBeat = -1;
  for (const ph of phases) {
    for (let i = 0; i < ph.s * fps; i++) {
      t += 1 / fps; const now = 1000 + t * 1000;
      if (show.setHush) show.setHush(!ph.music && i / fps >= 1, now);
      if (ph.music) { const k = Math.floor(t / period); if (k !== lastBeat) { lastBeat = k; show.beat(now, 1 | 4 | 8); } }
      const e = ph.music ? ph.level * (0.75 + 0.35 * (t % period < 0.08)) : 0;
      const markers = stickers.map(s => ({id: s.id, type: s.type, kind: 'sticker', x: s.x, y: s.y, contour: s.contour}));
      show.paint(ctx, markers, {now, levels: [e, e * 0.5, e, e], network: markers.map(m => ({id: m.id, received: ph.music ? 0.8 : 0})), songOpen: ph.music, xy: (x, y) => ({x, y})});
      for (const fr of show.figureHeights()) {
        const r = rows.get(fr.id); if (!r) continue;
        r.push({t, music: ph.music, w: fr.stickerPose, handL: fr.handL, handR: fr.handR, act: fr.activation});
      }
    }
  }
  for (const s of stickers) {
    const r = rows.get(s.id);
    const H = s.fit.height;
    // Rest: settled into the sticker pose, hands on the sticker's hands.
    const rest = r.filter(x => !x.music && x.t > 40 + 4);
    assert.ok(rest.length > 100);
    for (const x of rest) {
      assert.ok(x.w > 0.95, s.pose + ' rest weight ' + x.w);
      for (const k of ['handL', 'handR']) assert.ok(Math.hypot(x[k].x - s.fit[k].x, x[k].y - s.fit[k].y) / H < FIT_TOL * 1.5, `${s.pose} ${k} at rest is on the sticker`);
    }
    // Music: the weight rises and falls (periodic returns), never snaps.
    const music = r.filter(x => x.music && x.t > 6);
    if (process.env.DBG) console.log(s.pose, music.filter((x, i) => i % 15 === 0).map(x => x.t.toFixed(0) + ':' + x.w.toFixed(2) + '/' + (+x.act).toFixed(2)).join(' '));
    const peaks = []; let up = false;
    for (const x of music) { if (!up && x.w > 0.6) { up = true; peaks.push(x.t); } else if (up && x.w < 0.2) up = false; }
    assert.ok(peaks.length >= 2, s.pose + ' returns home on phrase downbeats: ' + JSON.stringify(peaks.map(p => p.toFixed(1))));
    const gaps = peaks.slice(1).map((p, i) => p - peaks[i]);
    for (const g of gaps) assert.ok(g > 7.5 && g < 16.6, s.pose + ' phrase gap ' + g.toFixed(1) + ' s (4-8 bars at 120 BPM)');
    let maxDw = 0;
    for (let i = 1; i < r.length; i++) maxDw = Math.max(maxDw, Math.abs(r[i].w - r[i - 1].w));
    assert.ok(maxDw < 0.1, s.pose + ' blend step per frame ' + maxDw.toFixed(3));
  }
});

test('wired into the live silhouette renderer for traced stickers only', () => {
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/sticker-pose\.js'/);
  assert.match(src, /marker\.kind !== 'sim' && traced && traced\.length >= 12/);
  assert.match(src, /blendStickerPose\(posed, fit, stickerW/);
  void figureJoints;
});
