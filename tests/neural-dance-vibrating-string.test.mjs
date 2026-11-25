// Rainbow vibrating string through each dancer (TJ, Nov 9 4:18 PM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_CENTER_HZ,
  bandMode,
  bandVisHz,
  drawDancerString,
  hueAt,
  sampleLevel,
  stringAmplitude,
  stringAxis,
  stringPoints,
  STRING_MAX_AMP,
  STRING_REST_AMP,
  confineStringToHead,
  pointInHeadSilhouette,
  clampToHeadSilhouette,
  stringLateralProfile
} from '../neural-dance/src/vibrating-string.js';
import {createSilhouetteShow, placeContour} from '../neural-dance/src/silhouette.js';
import {dancerSilhouette as bodyOf} from '../neural-dance/src/silhouette-dance.js';

function mockCtx() {
  const paths = [];
  let path = null;
  const ctx = {
    paths,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: '',
    lineJoin: '',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() { path = {moves: [], fill: null, stroke: null}; paths.push(path); },
    moveTo(x, y) { path.moves.push([x, y]); },
    lineTo(x, y) { path.moves.push([x, y]); },
    closePath() {},
    fill() { path.fill = {style: ctx.fillStyle, alpha: ctx.globalAlpha}; },
    stroke() { path.stroke = {style: ctx.strokeStyle, alpha: ctx.globalAlpha, width: ctx.lineWidth}; },
    clearRect() {},
    fillRect() {},
    arc() { path.moves.push('arc'); }
  };
  return ctx;
}

test('band mode and visual Hz rise with the dancer band', () => {
  assert.equal(BAND_CENTER_HZ.length, 4);
  assert.ok(bandMode(0) < bandMode(1) && bandMode(1) < bandMode(2) && bandMode(2) < bandMode(3));
  assert.ok(bandVisHz(0) < bandVisHz(3));
  assert.ok(bandVisHz(3) <= 14);
});

test('string axis runs head to toe through the silhouette center', () => {
  const body = placeContour(bodyOf(), 200, 300, 2);
  const axis = stringAxis(body);
  assert.ok(axis);
  assert.ok(axis.height > 40);
  assert.ok(Math.abs(axis.x - 200) < 1);
  const pts = stringPoints(axis, {band: 0, now: 0, amplitude: 0});
  // Root (s=0) is below crown (s=1); string does not reach the feet.
  assert.ok(pts[0].y > pts[pts.length - 1].y);
  assert.ok(pts[0].y < axis.bottom);
  assert.ok(pts[pts.length - 1].y > axis.top);
  assert.ok(pts.every(p => Math.abs(p.x - axis.x) < 1e-6));
});

test('standing wave displaces midpoints; nodes stay put for mode 1', () => {
  const axis = {x: 0, top: 0, bottom: 100, height: 100};
  const still = stringPoints(axis, {band: 0, now: 0, amplitude: 10, mode: 1, freq: 1});
  const mid = still[Math.floor(still.length / 2)];
  assert.ok(Math.abs(mid.x) > 5, 'mid displaces');
  assert.ok(Math.abs(still[0].x) < 1e-6, 'head is a node');
  assert.ok(Math.abs(still[still.length - 1].x) < 1e-6, 'toe is a node');
  const later = stringPoints(axis, {band: 0, now: 250, amplitude: 10, mode: 1, freq: 1});
  assert.ok(Math.abs(later[Math.floor(later.length / 2)].x) < 1, 'quarter cycle rests');
});

test('amplitude follows level; hue sweeps the rainbow', () => {
  assert.ok(stringAmplitude(0, 0) >= STRING_REST_AMP);
  assert.ok(stringAmplitude(1, 0) <= STRING_MAX_AMP);
  assert.ok(stringAmplitude(1, 0) > stringAmplitude(0.1, 0));
  const loud = new Float32Array(64).fill(0.4);
  const quiet = new Float32Array(64).fill(0.01);
  assert.ok(sampleLevel(loud) > sampleLevel(quiet));
  assert.match(hueAt(0), /^hsl\(/);
  assert.match(hueAt(0.5), /^hsl\(/);
  assert.notEqual(hueAt(0), hueAt(0.5));
});

test('paint draws a multicolored string and the show no longer rings the outline', () => {
  const body = placeContour(bodyOf(), 100, 100, 1.5);
  const ctx = mockCtx();
  assert.equal(drawDancerString(ctx, body, {
    band: 2,
    now: 100,
    envelope: 0.8,
    samples: new Float32Array(32).fill(0.3)
  }), true);
  const stroked = ctx.paths.filter(p => p.stroke);
  assert.ok(stroked.length > 10, 'many rainbow segments');
  const hues = new Set(stroked.map(p => p.stroke.style));
  assert.ok(hues.size >= 8, 'hue varies along the string, got ' + hues.size);
  assert.ok([...hues].every(h => /^(hsl\(|rgb\()/.test(h)), 'each segment has a css color');

  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const rich = mockCtx();
  show.paint(rich, [{id: 1, x: 100, y: 100, type: 1, kind: 'sticker', contour: body}], {
    now: 500,
    waveform: () => new Float32Array(64).fill(0.25),
    paintDots() {}
  });
  const hslStrokes = rich.paths.filter(p => p.stroke && String(p.stroke.style).startsWith('hsl('));
  assert.ok(hslStrokes.length > 10, 'show paints the rainbow string');
  assert.ok(hslStrokes.every(p => p.moves.length <= 4), 'string segments, not a closed outline ring');
});

test('kick and hat strings take different modes for the same silhouette', () => {
  const axis = {x: 0, top: 0, bottom: 100, height: 100};
  const kick = stringPoints(axis, {band: 0, now: 0, amplitude: 10});
  const hat = stringPoints(axis, {band: 3, now: 0, amplitude: 10});
  const signChanges = (pts) => {
    let n = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1].x === 0 || pts[i].x === 0) continue;
      if ((pts[i - 1].x > 0) !== (pts[i].x > 0)) n++;
    }
    return n;
  };
  assert.equal(bandMode(0), 1);
  assert.equal(bandMode(3), 5);
  assert.ok(signChanges(hat) > signChanges(kick), `hat flips ${signChanges(hat)} vs kick ${signChanges(kick)}`);
});

test('string points that would exit the head are clamped inside the silhouette', () => {
  const pose = {
    head: {x: 100, y: 40},
    headR: 16,
    headRx: 14,
    height: 200,
  };
  const raw = [
    {x: 100, y: 80, s: 0.5},
    {x: 100, y: 40, s: 0.85},
    {x: 160, y: 40, s: 0.92},
    {x: 130, y: 20, s: 1.0},
  ];
  const out = confineStringToHead(raw.map(p => ({...p})), pose, 0.5);
  assert.ok(pointInHeadSilhouette(out[2], pose, 0.6), 'temple point pulled in');
  assert.ok(pointInHeadSilhouette(out[3], pose, 0.6), 'crown stays above the head, not off to the side');
  assert.ok(Math.abs(out[2].x - 100) < Math.abs(raw[2].x - 100), 'hair line was shortened');
  assert.ok(stringLateralProfile(0.9) < stringLateralProfile(0.4), 'neck/head taper is tighter than the torso');
});
