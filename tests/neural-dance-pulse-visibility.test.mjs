// Red and green pulses are luminance-compensated for the projector (TJ Nov 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compensatePulseColor,
  compensatePulseRgb,
  parseCssRgb,
  pulseVisibility,
  relativeLuminance,
  rgbToHsl,
  GOLD_PULSE
} from '../neural-dance/src/pulse-visibility.js';
import {hueAt, paintVibratingString, paintChakraLights, chakraPoints} from '../neural-dance/src/vibrating-string.js';
import {paintLegEnergy} from '../neural-dance/src/silhouette.js';
import {paintPulseTrails, pulseFineStyle, PULSE_CORE_R, PULSE_TRAIL_W, PULSE_TRAIL_SPAN} from '../neural-dance/room-lab.js';

function mockCtx(log) {
  return new Proxy({}, {get(t, k) {
    if (k === 'canvas') return {width: 1000, height: 620};
    if (k === 'createRadialGradient') return () => ({addColorStop() {}});
    if (k === 'moveTo' || k === 'lineTo') return () => {};
    if (k === 'arc') return (x, y, r) => log && log.arcs.push({x, y, r, style: t.fillStyle, alpha: t.globalAlpha});
    if (k === 'stroke') return () => { if (log) log.strokes.push({style: t.strokeStyle, width: t.lineWidth, alpha: t.globalAlpha}); };
    if (k === 'fill') return () => { if (log) log.fills.push({style: t.fillStyle, alpha: t.globalAlpha}); };
    return k in t ? t[k] : () => {};
  }, set(t, k, v) { t[k] = v; return true; }});
}

const LEG_RED = 'rgb(255, 84, 56)';
const KICK_RED = '#ff6b6b';
const MID_GREEN = '#4ade80';
const ARM_GREEN = 'hsl(120 90% 62%)';
const HAT_BLUE = '#60a5fa';

test('red and green pulses gain luminance toward gold; yellow and blue stay put', () => {
  const goldY = relativeLuminance(parseCssRgb(GOLD_PULSE));
  for (const color of [LEG_RED, KICK_RED, 'hsl(0 95% 62%)']) {
    const before = relativeLuminance(parseCssRgb(color));
    const after = relativeLuminance(compensatePulseRgb(parseCssRgb(color)));
    assert.ok(after > before + 0.08, color + ' luminance ' + before.toFixed(3) + ' → ' + after.toFixed(3));
    assert.ok(Math.abs(after - goldY) < Math.abs(before - goldY), color + ' moved closer to gold');
  }
  for (const color of [MID_GREEN, ARM_GREEN, hueAt(0.417)]) {
    const before = relativeLuminance(parseCssRgb(color));
    const after = relativeLuminance(compensatePulseRgb(parseCssRgb(color)));
    assert.ok(after >= before, color + ' green luminance must not drop');
    assert.ok(after > 0.78, color + ' green is at least as bright as a strong mid green, got ' + after.toFixed(3));
  }
  assert.equal(compensatePulseColor(GOLD_PULSE), GOLD_PULSE);
  assert.equal(compensatePulseColor(HAT_BLUE), HAT_BLUE);
  assert.equal(pulseVisibility(GOLD_PULSE).boosted, false);
  assert.equal(pulseVisibility(HAT_BLUE).boosted, false);
  assert.equal(pulseVisibility(KICK_RED).boosted, true);
  assert.equal(pulseVisibility(MID_GREEN).boosted, true);
});

test('compensated red stays red-orange, not yellow; green stays green', () => {
  for (const color of [LEG_RED, KICK_RED, hueAt(0)]) {
    const hsl = rgbToHsl(...Object.values(compensatePulseRgb(parseCssRgb(color))));
    assert.ok(hsl.h >= 8 && hsl.h <= 22, color + ' stays red-orange, got hue ' + hsl.h.toFixed(1));
    assert.ok(hsl.l >= 0.68, 'red lightness is lifted');
  }
  for (const color of [MID_GREEN, ARM_GREEN, hueAt(0.417)]) {
    const hsl = rgbToHsl(...Object.values(compensatePulseRgb(parseCssRgb(color))));
    assert.ok(hsl.h >= 110 && hsl.h <= 145, color + ' stays green, got hue ' + hsl.h.toFixed(1));
    assert.ok(hsl.s >= 0.95, 'green saturation stays high');
  }
});

test('visibility scales stay within the fine-line budget; gold is unscaled', () => {
  const red = pulseVisibility(KICK_RED);
  const gold = pulseVisibility(GOLD_PULSE);
  assert.equal(gold.coreScale, 1);
  assert.equal(gold.trailScale, 1);
  assert.equal(gold.spanScale, 1);
  assert.equal(gold.alphaScale, 1);
  assert.ok(red.coreScale > 1 && red.trailScale > 1 && red.spanScale > 1 && red.alphaScale > 1);
  assert.ok(PULSE_CORE_R * red.coreScale <= 1.6, 'boosted core still a pinpoint');
  assert.ok(PULSE_TRAIL_W * red.trailScale < 2, 'boosted trail still thin');
  assert.ok(PULSE_TRAIL_SPAN * red.spanScale <= 42, 'boosted trail still short');
});

test('hueAt identity is unchanged — compensation is paint-time only', () => {
  assert.match(hueAt(0), /hsl\(0/);
  assert.match(hueAt(0.417), /^hsl\(/);
  assert.notEqual(compensatePulseColor(hueAt(0)), hueAt(0));
});

test('paintLegEnergy and paintPulseTrails use the compensated color, with a slightly thicker red trail than gold', () => {
  const redCss = compensatePulseColor(LEG_RED);
  const leg = {strokes: [], fills: [], arcs: []};
  assert.equal(paintLegEnergy(mockCtx(leg), {x: 0, y: 40}, {x: 0, y: 8}, 0.5, {color: LEG_RED, crisp: true}), true);
  assert.ok(leg.strokes.length, 'leg trail was stroked');
  assert.equal(leg.strokes[0].style, redCss);
  assert.ok(leg.fills.some(f => f.style === redCss), 'leg head uses compensated red');

  const f = new Float32Array(28);
  // One in-flight pulse: band in f[2].
  const paintBand = (k, color) => {
    const buf = f.slice();
    buf[0] = 0; buf[1] = 1; buf[2] = k; buf[3] = 0.2; buf[4] = 0.6;
    buf[5] = 40; buf[6] = 0; buf[7] = 3;
    buf[8] = 0; buf[9] = 0; buf[10] = 20; buf[11] = 0; buf[12] = 40; buf[13] = 0;
    const log = {strokes: [], fills: [], arcs: []};
    paintPulseTrails(mockCtx(log), buf, 0, 1, 28, (x, y) => ({x, y}), [KICK_RED, GOLD_PULSE, MID_GREEN, HAT_BLUE], false, null, pulseFineStyle({bloomIntensity: 0}));
    return log;
  };
  const red = paintBand(0);
  const gold = paintBand(1);
  const green = paintBand(2);
  assert.equal(red.strokes[0].style, compensatePulseColor(KICK_RED));
  assert.equal(green.strokes[0].style, compensatePulseColor(MID_GREEN));
  assert.equal(gold.strokes[0].style, compensatePulseColor(GOLD_PULSE));
  assert.ok(red.strokes[0].width > gold.strokes[0].width, 'red trail is slightly thicker than gold');
  assert.ok(green.strokes[0].width > gold.strokes[0].width, 'green trail is slightly thicker than gold');
  assert.ok(red.strokes[0].alpha >= gold.strokes[0].alpha, 'red trail alpha is at least gold');
  // Bloom 0: only the thin core trail, no glow pass, no halo disc.
  assert.ok(red.strokes.every(s => s.width < 2), 'bloom 0 keeps the red core thin, got ' + red.strokes.map(s => s.width).join(','));
  assert.equal(red.strokes.length, gold.strokes.length, 'bloom 0 adds no extra glow stroke for red');
  assert.ok(red.arcs.every(a => a.r <= 1.6), 'bloom 0 red core stays a pinpoint, got ' + red.arcs.map(a => a.r).join(','));
});

test('string and chakra paint use compensated root red and heart green', () => {
  const rootSeg = [{x: 0, y: 80, s: 0}, {x: 0, y: 70, s: 0}];
  const log = {strokes: [], fills: [], arcs: []};
  assert.equal(paintVibratingString(mockCtx(log), rootSeg, {width: 1.15, glowWidth: 0, glowAlpha: 0}), true);
  const styles = new Set(log.strokes.map(s => s.style));
  assert.ok([...styles].includes(compensatePulseColor(hueAt(0))), 'root segment is compensated red');
  const pts = Array.from({length: 25}, (_, i) => ({x: 0, y: 80 - i * 3, s: i / 24}));
  const lights = chakraPoints(pts, {envelope: 0.8, travelS: 0, travelGain: 1.6});
  assert.equal(lights[0].color, hueAt(0), 'chakraPoints keeps the uncompensated hue identity');
  const glow = {strokes: [], fills: [], arcs: []};
  assert.equal(paintChakraLights(mockCtx(glow), lights, {aura: 0, dim: 1}), true);
  assert.ok(glow.fills.some(f => f.style === compensatePulseColor(hueAt(0))), 'root node paints compensated red');
  assert.ok(glow.fills.some(f => f.style === compensatePulseColor(hueAt(0.417))), 'heart node paints compensated green');
});
