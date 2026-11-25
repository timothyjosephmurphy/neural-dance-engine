// TJ 7:25 PM: with Listen on, true room silence → no dancer movement at all
// (ease to still over ~0.5 s); the first real onset resumes within a beat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSilhouetteShow, HUSH_EASE_MS} from '../neural-dance/src/silhouette.js';
import {simSilhouetteMarkers} from '../neural-dance/room-lab.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, fillText() {}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}
const JOINTS = ['footL', 'footR', 'handL', 'handR', 'groin', 'crown'];
function run(segments) {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const sims = simSilhouetteMarkers(Array.from({length: 8}, (_, i) => ({id: 50 + i, x: 150 + i * 100, y: 300, type: i % 4})));
  const ctx = recorder();
  let prev = null;
  const frames = [];
  for (let t = 1000; t < 9000; t += 16) {
    const seg = segments(t);
    if (seg.beat && (t - 1000) % 496 < 16) show.beat(t, 15, {period: [496, 496, 496, 496], locked: [true, true, true, true]});
    show.setHush(!!seg.hush, t);
    show.paint(ctx, sims, {now: t, xy: (x, y) => ({x, y})});
    const figs = show.figureHeights();
    let move = 0, drive = 0;
    if (prev) {
      for (const f of figs) {
        const p = prev.get(f.id);
        if (!p) continue;
        for (const j of JOINTS) move += Math.hypot(f[j].x - p[j].x, f[j].y - p[j].y);
      }
    }
    for (const f of figs) drive += f.pulseAmp + f.envB + Math.abs(f.planted) + (f.jump || 0);
    frames.push({t, move, drive, hush: show.hush(t)});
    prev = new Map(figs.map(f => [f.id, f]));
  }
  return frames;
}

test('silence segment: motion eases to a subtle idle groove within ~0.5 s (never frozen); resumes within one beat', () => {
  assert.equal(HUSH_EASE_MS, 500);
  // 1–4 s music, 4–7 s silence (hush asserted by room-lab after the gate is closed ~0.7 s), 7–9 s music.
  const frames = run(t => (t < 4000 ? {beat: true} : t < 7000 ? {hush: true} : {beat: true}));
  const music = frames.filter(f => f.t > 2000 && f.t < 4000);
  const musicMove = music.reduce((a, f) => a + f.move, 0) / music.length;
  assert.ok(musicMove > 0.5, 'dancers move with music (' + musicMove.toFixed(3) + ' px/frame)');
  // During the ease motion decreases, then everything is still.
  // TJ 10:25 AM: silence is a subtle idle groove on the held beat, not a freeze:
  // small but nonzero motion, no string/pulse drive.
  const still = frames.filter(f => f.t >= 4000 + HUSH_EASE_MS + 32 && f.t < 7000);
  const idleMove = still.reduce((a, f) => a + f.move, 0) / still.length;
  assert.ok(idleMove > 0.01, 'idle groove keeps moving in silence (' + idleMove.toFixed(3) + ' px/frame)');
  assert.ok(idleMove < 0.35 * musicMove, 'idle groove is small (' + idleMove.toFixed(3) + ' vs music ' + musicMove.toFixed(3) + ')');
  const maxMusicMove = Math.max(...music.map(f => f.move));
  for (const f of still) {
    // A settling weight shift / small rest step may move a body a couple of
    // px in a frame, never more than the music did.
    assert.ok(f.move <= maxMusicMove, `idle groove never snaps at ${f.t} ms: ${f.move} (music max ${maxMusicMove})`);
    assert.ok(f.drive < 1e-9, `string/pulse drive at ${f.t} ms: ${f.drive}`);
    assert.equal(f.hush, 0);
  }
  // The ease itself is gradual (no snap): no single frame jumps more than the music did per frame ×3.
  const ease = frames.filter(f => f.t >= 4000 && f.t < 4000 + HUSH_EASE_MS);
  const maxMusic = Math.max(...music.map(f => f.move));
  assert.ok(Math.max(...ease.map(f => f.move)) <= maxMusic * 3 + 1, 'ease does not snap');
  // Resume: motion within one beat (496 ms) of the first onset.
  const resumed = frames.filter(f => f.t >= 7000 && f.t < 7000 + 496);
  assert.ok(resumed.some(f => f.move > 0.3), 'moves again within one beat');
  assert.equal(frames.find(f => f.t >= 7000).hush, 1, 'first onset un-hushes immediately');
});

test('no hush without Listen: idle / manual clocks still animate', () => {
  const frames = run(() => ({}));
  const late = frames.filter(f => f.t > 6000);
  assert.ok(late.reduce((a, f) => a + f.move, 0) > 5, 'idle fallback still moves when Listen is off');
});

test('room-lab hushes only when Listen is on and the gate is closed ~0.3 s (after the ~0.6 s adaptive close); ripples ease too', () => {
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /HUSH_AFTER_MS=300;/);
  assert.match(src, /const quiet=listening&&!gate\.open;if\(quiet\)\{if\(silentSince<0\)silentSince=now;\}else silentSince=-1;silhouetteShow\.setHush\(quiet&&now-silentSince>=HUSH_AFTER_MS,now\);/);
  assert.match(src, /silhouetteShow\.hush\(nowMs\)/);
  assert.match(src, /if\(!\(figHush>0\)\)continue;/);
  assert.match(src, /stompRippleAmount\(p\.amount,crowd,figHush\)/);
});
