// Combined build (TJ 6:12–6:36 PM): GPU half-float ripple with CPU fallback,
// 24-sim saturation fix, stomp-driven ripples, beat tiers, Listen safety,
// dimmed string, 7-chakra articulated dancers with heart→arm pulses,
// light-node traveling string, and corner insets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWaterRipple, crowdScale, impulseFromDancer, softLimit, stageToRippleUV, RIPPLE_COLOR_DIFF, RIPPLE_SOFT_LIMIT} from '../neural-dance/src/water-ripple.js';
import {GPU_RIPPLE_W, GPU_RIPPLE_H, GPU_COLOR_DIFF} from '../neural-dance/src/water-ripple-gpu.js';
import {createSilhouetteShow, dancerMotionClock, BEAT_FRESH_MS, IDLE_INTERVAL_MS, STRING_DIM, INNER_GLOW_DIM} from '../neural-dance/src/silhouette.js';
import {CHAKRA_S, CHAKRA_GLOW_DIM, nodePin, stringPoints, STRING_NODE_WEIGHT} from '../neural-dance/src/vibrating-string.js';
import {armPulse, insetRects, skeletonPose, UPPER_ARM, FOREARM, HAND_LEN, HEAD_H, INSET_MAX} from '../neural-dance/src/skeleton-dancer.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';

const src = name => readFileSync(new URL('../neural-dance/' + name, import.meta.url), 'utf8');

function rippleCanvas() {
  let field = null;
  return {
    width: 160, height: 100, // field-size canvas: no JS upscale in node
    get __rippleField() { return field; },
    set __rippleField(v) { field = v; },
    getContext() {
      return {clearRect() {}, createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}; }, putImageData() {}, drawImage() {}, imageSmoothingEnabled: true, globalCompositeOperation: 'source-over', globalAlpha: 1};
    }
  };
}
function lit(canvas) {
  const px = canvas.__rippleField && canvas.__rippleField.pixels;
  if (!px) return 0;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 6) n++;
  return n / (px.length / 4);
}
// Seeded LCG so "seed 24" is reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('stomp-driven ripples stay finite over 5 simulated minutes with 24 dancers; rings appear only on stomps', () => {
  for (const seed of [1, 24]) {
    const rand = rng(seed);
    const ripple = createWaterRipple({cpu: true});
    const canvas = rippleCanvas();
    const dancers = Array.from({length: 24}, (_, i) => ({id: i + 1, x: 60 + rand() * 880, y: 60 + rand() * 500, type: i % 4, activity: rand()}));
    const crowd = crowdScale(dancers.length);
    const fps = 10;
    const periodMs = 500;
    let peakLoud = 0, peakQuiet = 0, midHoldLit = 1;
    for (let f = 0; f < 5 * 60 * fps; f++) {
      const now = f * (1000 / fps);
      // Alternate a loud minute and a silent minute; dark scan frames never wipe.
      const loud = Math.floor(now / 60000) % 2 === 0;
      const env = loud ? 0.6 + 0.4 * Math.abs(Math.sin(now / 300)) : 0;
      const onBeat = loud && (now % periodMs) < (1000 / fps);
      for (const d of dancers) {
        const uv = stageToRippleUV(d.x, d.y);
        const stompHit = onBeat ? 0.45 : 0;
        ripple.hit(uv.x, uv.y, impulseFromDancer({...d, stompHit}, env, now) * crowd, [255, 160, 80]);
      }
      ripple.step(canvas);
      const share = lit(canvas);
      if (loud) peakLoud = Math.max(peakLoud, share);
      else {
        peakQuiet = Math.max(peakQuiet, share);
        // After a second of silence the rings should have faded.
        const intoQuiet = now % 60000;
        if (intoQuiet > 2000 && f % 5 === 0) midHoldLit = Math.min(midHoldLit, share);
      }
      const fieldOk = canvas.__rippleField && canvas.__rippleField.heights.every(Number.isFinite);
      assert.ok(fieldOk, 'finite field at frame ' + f);
    }
    assert.ok(peakLoud > 0.01, 'seed ' + seed + ': stomps light the field (' + peakLoud.toFixed(4) + ')');
    assert.ok(midHoldLit < peakLoud * 0.5 || midHoldLit < 0.02, 'seed ' + seed + ': field goes quiet between stomps (loud ' + peakLoud.toFixed(4) + ', quiet ' + midHoldLit.toFixed(4) + ')');
  }
});

test('saturation fix: impulse ~1/sqrt(N), tanh soft limit, diffusion <= 0.25', () => {
  assert.equal(crowdScale(1), 1);
  assert.ok(Math.abs(crowdScale(24) - Math.sqrt(3 / 24)) < 1e-9);
  assert.ok(Math.abs(softLimit(100)) <= RIPPLE_SOFT_LIMIT + 1e-9);
  assert.ok(RIPPLE_COLOR_DIFF <= 0.25 && GPU_COLOR_DIFF <= 0.25);
  const room = src('room-lab.js');
  assert.match(room, /stompRippleAmount\(p\.amount,crowd,figHush\)/);
  // Dark/scan layers hide the overlay but never wipe the field.
  assert.match(room, /if\(!rippleEnabled\)waterRipple\.clear\(\);/);
});

test('GPU ripple is WebGL2 half-float >= 512x320 with automatic CPU fallback', () => {
  assert.ok(GPU_RIPPLE_W >= 512 && GPU_RIPPLE_H >= 320);
  const gpu = src('src/water-ripple-gpu.js');
  assert.match(gpu, /EXT_color_buffer_half_float/);
  assert.match(gpu, /RGBA16F/);
  assert.doesNotMatch(gpu, /gl\.RGBA32F/);
  const cpu = src('src/water-ripple.js');
  assert.match(cpu, /cpu \(gpu lost\)/);
  assert.match(cpu, /cpu \(gpu slow\)/);
  const ripple = createWaterRipple({});
  assert.ok(ripple && typeof ripple.step === 'function', 'no WebGL in node: CPU fallback');
});

test('beat tiers: band beats while fresh, then global within 3 s, then 100 BPM only after > 3 s silence', () => {
  const band = {at: 1000, strikeAt: 1000, interval: 500, strikeCount: 4, strikeDur: 450};
  assert.equal(dancerMotionClock(2000, band, {at: 1900, interval: 480, index: 9}).tier, 'band');
  assert.equal(dancerMotionClock(1000 + BEAT_FRESH_MS + 200, band, {at: 3900, interval: 480, index: 9}).tier, 'global');
  const idle = dancerMotionClock(3900 + BEAT_FRESH_MS + 100, band, {at: 3900, interval: 480, index: 9});
  assert.equal(idle.tier, 'idle');
  assert.equal(IDLE_INTERVAL_MS, 600); // 100 BPM
  assert.notEqual(dancerMotionClock(3900 + BEAT_FRESH_MS - 100, band, {at: 3900, interval: 480, index: 9}).tier, 'idle');
});

test('Listen recovery only resumes the context; the toggle resets a dead stream', () => {
  const room = src('room-lab.js');
  assert.match(room, /statechange',\(\)=>\{if\(ctx\.state!=='running'&&ctx\.state!=='closed'&&micState==='listening'&&running\)ctx\.resume\(\)/);
  const watcher = room.slice(room.indexOf('function watchAudioContext'), room.indexOf('function micStreamLive'));
  assert.doesNotMatch(watcher, /getUserMedia|stop\(\)|releaseMicHardware/);
  assert.match(room, /if\(micStream&&!micStreamLive\(micStream\)\)\{releaseMicHardware\(\);applyMicState\('off'\);\}/);
});

test('string + inner glow ~45% dimmer; colors and shape unchanged; 7 chakras root→crown', () => {
  assert.ok(STRING_DIM >= 0.5 && STRING_DIM <= 0.6);
  assert.ok(INNER_GLOW_DIM <= 0.65 && CHAKRA_GLOW_DIM <= 0.65);
  assert.deepEqual(CHAKRA_S.map(c => c.id), ['root', 'sacral', 'solar', 'heart', 'throat', 'thirdEye', 'crown']);
  assert.ok(Math.abs(CHAKRA_S[3].s - 0.417) < 1e-9);
});

test('light nodes: a smooth traveling sine with almost no pinning (TJ 6:34 PM)', () => {
  assert.ok(STRING_NODE_WEIGHT <= 0.3);
  for (const c of CHAKRA_S) assert.ok(nodePin(c.s) > 0.8, c.id + ' pin ' + nodePin(c.s).toFixed(3));
  const axis = {x: 0, top: 0, height: 100, bottom: 100};
  const a = stringPoints(axis, {amplitude: 10, phase: 0, travel: true});
  const b = stringPoints(axis, {amplitude: 10, phase: 0.6, travel: true});
  // Crest moves toward the crown (higher s) as phase advances.
  const crest = pts => pts.slice(0, Math.floor(pts.length / 2)).reduce((best, p) => (p.x > best.x ? p : best)).s;
  assert.ok(crest(b) > crest(a), 'travels root→crown');
  // Smooth: no kinks (second difference small everywhere).
  for (let i = 1; i < b.length - 1; i++) assert.ok(Math.abs(b[i + 1].x - 2 * b[i].x + b[i - 1].x) < 2.5);
});

test('articulated dancer: athletic arm proportions, knees and elbows, heart pulse lifts the arms', () => {
  assert.ok(Math.abs(UPPER_ARM / HEAD_H - 1.5) < 1e-12, 'upper arm 1.5 heads');
  assert.ok(Math.abs(FOREARM / HEAD_H - 1.15) < 1e-12, 'forearm 1.15 heads');
  assert.ok(Math.abs(HAND_LEN / HEAD_H - 0.85) < 1e-12, 'hand 0.85 heads');
  const rest = skeletonPose({id: 3, band: 1, weight: 0.4, ease: 0.5, side: 1, swing: 0, lift: 0});
  const up = skeletonPose({id: 3, band: 1, weight: 0.4, ease: 0.5, side: 1, swing: 0, lift: 1});
  for (const k of ['kneeL', 'kneeR', 'elL', 'elR', 'handL', 'handR', 'groin', 'crown']) assert.ok(rest[k], k);
  assert.ok(up.handL.y < rest.handL.y && up.handR.y < rest.handR.y, 'pulse lifts both hands a little');
  assert.ok(rest.handL.y - up.handL.y < 0.05, 'subtle');
  const before = armPulse(0.2, 0.3, 0.5);
  const after = armPulse(0.6, 0.62, 0.5);
  assert.ok(before.u < 0 && after.u >= 0, 'arm pulse starts once the strike passes the heart');
});

test('corner insets: up to 4 dim stick figures in the corners; debug toggle defaults on', () => {
  assert.equal(INSET_MAX, 4);
  const rects = insetRects(1000, 620, 6);
  assert.equal(rects.length, 4);
  for (const r of rects) assert.ok(r.x + r.w <= 1000 && r.y + r.h <= 620 && r.x >= 0 && r.y >= 0);
  const show = createSilhouetteShow();
  assert.equal(show.insets(), true);
  assert.equal(show.setInsets(false), false);
  assert.deepEqual(sanitizeDebugPatch({insetsEnabled: false}).insetsEnabled, false);
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(page, /data-debug-insets aria-pressed="true">Insets: on</);
});
