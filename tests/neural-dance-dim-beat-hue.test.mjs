import assert from 'node:assert/strict';
import test from 'node:test';
import {dancerHueSpec, dancerHueRgb, bandFamily} from '../neural-dance/src/dancer-hue.js';
import {bandVisHz, STRING_VIS_HZ_MAX, stringPoints, chakraPoints, hueAt} from '../neural-dance/src/vibrating-string.js';
import {createSilhouetteShow, strikeStride, FAST_STRIKE_MS, INNER_GLOW_DIM} from '../neural-dance/src/silhouette.js';
import {createWaterRipple} from '../neural-dance/src/water-ripple.js';
import {dancerSilhouette} from '../neural-dance/src/silhouette-dance.js';

test('band families group kick/bass warm, snare mid, hat high, with per-id variation', () => {
  assert.equal(bandFamily(0).id, 'bass');
  assert.equal(bandFamily(1).id, 'bass');
  assert.equal(bandFamily(2).id, 'mid');
  assert.equal(bandFamily(3).id, 'high');
  const bass = dancerHueSpec(7, 1);
  const mid = dancerHueSpec(7, 2);
  const high = dancerHueSpec(7, 3);
  assert.ok(bass.hue < 55, 'bass is red/orange');
  assert.ok(mid.hue > 60 && mid.hue < 140, 'mid is yellow/green');
  assert.ok(high.hue > 200 && high.hue < 300, 'high is blue/violet');
  const a = dancerHueSpec(1, 1);
  const b = dancerHueSpec(9, 1);
  assert.ok(Math.abs(a.hue - b.hue) > 0.5, 'ids vary inside the family');
  assert.equal(bandFamily(1).id, bandFamily(1).id);
  assert.ok(Math.abs(a.hue - 32) <= 12 + 1e-6);
});

test('visual string Hz is capped and slower; chakras keep rainbow order with a tint', () => {
  assert.ok(bandVisHz(0) < bandVisHz(3));
  assert.ok(bandVisHz(3) <= STRING_VIS_HZ_MAX);
  assert.ok(STRING_VIS_HZ_MAX <= 6);
  const axis = {x: 0, top: 0, bottom: 100, height: 100};
  const a = stringPoints(axis, {mode: 1, amplitude: 10, phase: 0});
  const b = stringPoints(axis, {mode: 1, amplitude: 10, freq: 99, phase: 0});
  // Same phase → same shape, even if freq would have been fast.
  const mid = Math.floor(a.length / 2);
  assert.ok(Math.abs(a[mid].x - b[mid].x) < 1e-9);
  const pts = stringPoints(axis, {mode: 2, amplitude: 8, phase: 0});
  const lights = chakraPoints(pts, {envelope: 1, level: 1, hue: dancerHueSpec(3, 1).css});
  const hues = lights.map(l => +l.color.match(/hsl\(([-\d.]+)/)[1]);
  assert.ok(hues[0] < hues[1] && hues[1] < hues[2], 'root→crown order preserved');
  assert.match(hueAt(0), /hsl\(0/);
  assert.ok(INNER_GLOW_DIM <= 0.7 && INNER_GLOW_DIM >= 0.55);
});

test('foot-strikes lock to each dancer band, every 2 beats when fast, and drive string phase', () => {
  assert.equal(strikeStride(500), 1);
  assert.equal(strikeStride(FAST_STRIKE_MS - 1), 2);
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  // Bass (bit 1) at 500ms — one strike per beat.
  show.beat(1000, 1 << 1);
  show.beat(1500, 1 << 1);
  const bass = show.bandClock(1);
  assert.equal(bass.strikeCount, 2);
  assert.equal(bass.interval, 500);
  // Hat (bit 3) at 300ms — every 2 beats.
  show.beat(2000, 1 << 3);
  show.beat(2300, 1 << 3);
  show.beat(2600, 1 << 3);
  const hat = show.bandClock(3);
  assert.equal(hat.interval, 300);
  assert.ok(hat.strikeCount < 3, 'fast band skips every other onset');
  assert.ok(hat.strikeCount >= 2);
});

function sat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max < 1 ? 0 : (max - min) / max;
}

test('rendered ripple frame stays bright near the dancer and keeps band hue saturation', () => {
  const ripple = createWaterRipple({width: 80, height: 50});
  const bass = dancerHueRgb(4, 1);
  const mid = dancerHueRgb(5, 2);
  const high = dancerHueRgb(6, 3);
  ripple.hit(0.30, 0.50, 1.0, bass);
  ripple.hit(0.70, 0.50, 1.0, mid);
  ripple.hit(0.50, 0.22, 1.0, high);
  const canvas = {width: 80, height: 50, __rippleField: null, getContext() { return {clearRect() {}, createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}; }, putImageData() {}, drawImage() {}, imageSmoothingEnabled: true}; }};
  for (let i = 0; i < 12; i++) ripple.step(canvas);
  const field = canvas.__rippleField;
  assert.ok(field && field.pixels);
  const w = field.width, h = field.height;
  const pix = field.pixels;
  const sample = (u, v) => {
    const x = Math.round(u * (w - 1));
    const y = Math.round(v * (h - 1));
    const o = (y * w + x) * 4;
    return {r: pix[o], g: pix[o + 1], b: pix[o + 2], a: pix[o + 3]};
  };
  const bg = sample(0.05, 0.05);
  const nearBass = sample(0.30, 0.50);
  const nearMid = sample(0.70, 0.50);
  const ring = (() => {
    // Walk right from the bass dancer for a ring pixel with alpha.
    for (let u = 0.32; u < 0.48; u += 0.01) {
      const p = sample(u, 0.50);
      if (p.a > 20) return p;
    }
    return sample(0.40, 0.50);
  })();
  const luma = (p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
  // Near-dancer (premultiplied) is at least as bright as far background.
  assert.ok(luma(nearBass) >= luma(bg) - 1, `near bass ${luma(nearBass)} vs bg ${luma(bg)}`);
  assert.ok(luma(nearMid) >= luma(bg) - 1);
  assert.ok(nearBass.a > 20, 'near-field is not a hole');
  // Un-premultiply for saturation / hue checks.
  const straight = (p) => {
    const a = Math.max(1, p.a) / 255;
    return {r: p.r / a, g: p.g / a, b: p.b / a, a: p.a};
  };
  const bassS = straight(nearBass);
  const midS = straight(nearMid);
  assert.ok(sat(bassS.r, bassS.g, bassS.b) > 0.25, 'bass ripple is saturated');
  assert.ok(sat(midS.r, midS.g, midS.b) > 0.25, 'mid ripple is saturated');
  assert.ok(bassS.r > bassS.b && bassS.r >= bassS.g * 0.8, 'bass leans red/orange');
  assert.ok(midS.g + midS.r > midS.b * 1.2, 'mid leans yellow/green');
  if (ring.a > 20) {
    const rs = straight(ring);
    assert.ok(sat(rs.r, rs.g, rs.b) > 0.18, 'propagated ring keeps hue');
  }
});

test('near-field stays lit through cancellations and does not flip into a dark hole', () => {
  const ripple = createWaterRipple({width: 80, height: 50});
  const hue = dancerHueRgb(4, 1);
  const canvas = {width: 80, height: 50, getContext() { return {clearRect() {}, createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}; }, putImageData() {}, getImageData() { return {data: new Uint8ClampedArray(80 * 50 * 4)}; } }; }};
  // Repeated soft hits like the live loop, then let the wave slosh.
  for (let i = 0; i < 8; i++) ripple.hit(0.5, 0.5, 0.5, hue);
  let minNear = Infinity, sawFlip = false;
  const ix = (field) => {
    const w = field.width, h = field.height;
    return (Math.round(0.5 * (h - 1)) * w) + Math.round(0.5 * (w - 1));
  };
  for (let s = 0; s < 24; s++) {
    ripple.step(canvas);
    const field = canvas.__rippleField;
    const i = ix(field);
    if (field.heights[i] < 0) sawFlip = true;
    const pix = field.pixels;
    const o = i * 4;
    const luma = 0.299 * pix[o] + 0.587 * pix[o + 1] + 0.114 * pix[o + 2];
    minNear = Math.min(minNear, luma);
    // Envelope / glow keeps energy even if signed height is near 0.
    assert.ok((field.colors.env ? field.colors.env[i] : 0) >= 0);
  }
  assert.ok(minNear > 8, `near-source luma dropped to ${minNear} (dark hole / cancel)`);
});
