// Nov 9, 3:49-3:50 PM (TJ): tone down the aura and waveform, keep it calm as
// stickers and sim dancers add up, and get back the sharp sticker shape
// ("it's just a blob now"). Root cause of the blob: 0ff7636 stamped a 53 px
// radial aura sprite on every outline point of a sticker-sized silhouette.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PULSE_WAVE_GAIN, createSilhouetteShow, silhouetteGlow} from '../neural-dance/src/silhouette.js';
import {dancerSilhouette} from '../neural-dance/src/silhouette-dance.js';
import {detectStickerBlobs} from '../neural-dance/camera-markers.js';

// A canvas stub so the aura sprite exists in node, as on the phone.
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    return {createRadialGradient: () => ({addColorStop() {}}), fillRect() {}, drawImage() {}, set fillStyle(v) {}, set globalCompositeOperation(v) {}};
  }
}
globalThis.OffscreenCanvas = globalThis.OffscreenCanvas || FakeCanvas;
new Function(readFileSync(new URL('../neural-dance/wave-ring.js', import.meta.url), 'utf8'))();
const rings = globalThis.NeuralDanceRings;

function mockCtx() {
  const strokes = [];
  const images = [];
  const ctx = {strokes, images, strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', lineJoin: '', lineCap: '',
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, arc() {},
    stroke() { strokes.push({width: ctx.lineWidth, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation}); },
    drawImage(image, x, y, w, h) { images.push({w, h}); }};
  return ctx;
}
const ring = (n = 24, r = 20) => Array.from({length: n}, (_, i) => ({x: 200 + Math.cos(i / n * 6.283) * r, y: 150 + Math.sin(i / n * 6.283) * r * 1.6}));

test('the full-strength ring bloom is unchanged (sprites, 22 px aura, 2.5 px crest)', () => {
  rings.configureBloom({enabled: true, intensity: 1, aura: 22});
  const ctx = mockCtx();
  rings.paintEnergyBloom(ctx, ring(), '#fff', false);
  assert.ok(ctx.images.length > 0);
  assert.equal(Math.max(...ctx.strokes.map(s => s.width)), 22);
  assert.equal(Math.min(...ctx.strokes.map(s => s.width)), 2.5);
});

test('a silhouette bloom has no sprite stamps and a thin, dim crest (sharp edge)', () => {
  rings.configureBloom({enabled: true, intensity: 1, aura: 22});
  const ctx = mockCtx();
  rings.paintEnergyBloom(ctx, ring(), '#fff', false, silhouetteGlow(1));
  assert.equal(ctx.images.length, 0, 'no radial stamps smearing the outline');
  const widths = ctx.strokes.map(s => s.width);
  assert.ok(Math.max(...widths) <= 12.5, 'aura width ' + Math.max(...widths));
  assert.ok(Math.min(...widths) <= 2, 'crest ' + Math.min(...widths));
  assert.ok(Math.max(...ctx.strokes.map(s => s.alpha)) <= 0.45, 'crest alpha');
});

test('glow per figure falls as figures add up, so the total stays bounded', () => {
  assert.equal(silhouetteGlow(1), 0.55);
  assert.equal(silhouetteGlow(3), 0.55);
  assert.ok(silhouetteGlow(6) < silhouetteGlow(3));
  const totals = [1, 2, 3, 6, 12, 24, 48].map(n => n * silhouetteGlow(n));
  assert.ok(Math.max(...totals.slice(0, 5)) <= 3 * 0.55 + 1e-9, 'bounded up to 12 figures: ' + totals);
  assert.ok(silhouetteGlow(48) >= 0.55 * 0.25 - 1e-9, 'never vanishes');
  assert.equal(PULSE_WAVE_GAIN, 5);
});

test('the silhouette pass paints every sticker as a shadow figure; the crowd count still reaches paint', () => {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const seen = [];
  const style = (pulse) => { seen.push(pulse.glow); return {alpha: 0.2}; };
  const markers = Array.from({length: 6}, (_, i) => ({id: i + 1, x: 100 + i * 120, y: 300, kind: 'sticker'}));
  const ctx = mockCtx();
  show.paint(ctx, markers, {now: 1000, style, crowd: 6 + 6});
  // 7-chakra port: articulated shadow figures replace the contour bloom
  // (its outline halo would show the old silhouette); all six are painted.
  assert.equal(show.figureHeights().length, 6);
  assert.equal(seen.length, 0);
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /crowd:\(root\._markers\?root\._markers\.length:0\)\+\(typeof sim!=="undefined"&&sim\?sim\.length:0\)/);
});

test('a dancer-shaped sticker traces as its shape, not a blob', () => {
  const W = 480;
  const H = 360;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const shape = dancerSilhouette();
  const xs = shape.map(p => p.x);
  const ys = shape.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const s = 22 / (Math.max(...ys) - Math.min(...ys));
  const poly = shape.map(p => ({x: 240 + (p.x - cx) * s, y: 180 + (p.y - cy) * s}));
  const inside = (pts, x, y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i].y > y) !== (pts[j].y > y) && x < (pts[j].x - pts[i].x) * (y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) c = !c;
    }
    return c;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const v = inside(poly, x + 0.5, y + 0.5) ? 35 : 185;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  const blobs = detectStickerBlobs(rgba, W, H, {});
  assert.equal(blobs.length, 1);
  const contour = blobs[0].contour;
  assert.ok(contour && contour.length >= 12, 'outline has detail: ' + (contour && contour.length));
  let both = 0;
  let either = 0;
  for (let y = 150; y < 210; y++) for (let x = 210; x < 270; x++) {
    const a = inside(poly, x + 0.5, y + 0.5);
    const b = inside(contour, x + 0.5, y + 0.5) || contour.some(p => Math.abs(p.x - x) < 0.6 && Math.abs(p.y - y) < 0.6);
    if (a && b) both++;
    if (a || b) either++;
  }
  const iou = both / either;
  assert.ok(iou >= 0.7, 'shape IoU ' + iou.toFixed(2));
  // A blob (convex hull) would fill the gaps between limbs.
  const hullish = blobs[0].extent;
  assert.ok(hullish < 0.75, 'extent ' + hullish);
});
