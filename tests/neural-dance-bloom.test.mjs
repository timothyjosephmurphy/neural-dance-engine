// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {applyDebugPatch} from '../neural-dance/live-debug.js';

const ring = readFileSync(new URL('../neural-dance/wave-ring.js', import.meta.url), 'utf8');
const livePage = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');

function mockCtx() {
  const strokes = [];
  const images = [];
  const ctx = {
    strokes,
    images,
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineJoin: '',
    lineCap: '',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() { strokes.push({width: ctx.lineWidth, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation, style: ctx.strokeStyle}); },
    drawImage(image, x, y, w, h) { images.push({x, y, w, h, image}); }
  };
  return ctx;
}

test('a waveform bloom is three additive layers and can fall back to the outline', () => {
  assert.doesNotMatch(ring, /ctx\.shadowBlur|shadowBlur\s*=/);
  new Function(ring)();
  const api = globalThis.NeuralDanceRings;
  assert.equal(typeof api.paintEnergyBloom, 'function');
  assert.equal(typeof api.configureBloom, 'function');
  const tuned = api.configureBloom({enabled: true, intensity: 1, aura: 22});
  assert.equal(tuned.enabled, true);
  assert.equal(tuned.aura, 22);
  const ctx = mockCtx();
  const points = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    points.push({x: 100 + Math.cos(a) * 30, y: 80 + Math.sin(a) * (30 + (i % 2 ? 6 : -6))});
  }
  api.paintEnergyBloom(ctx, points, '#5ce1e6', false);
  assert.ok(ctx.strokes.length >= 3, 'aura, ribbon, and crest');
  const widths = ctx.strokes.map(stroke => stroke.width).sort((a, b) => b - a);
  assert.ok(widths[0] >= 22, 'outer aura is wide');
  assert.ok(widths[1] > 2.5 && widths[1] < widths[0], 'ribbon sits inside the aura');
  assert.equal(widths[widths.length - 1], 2.5);
  assert.ok(ctx.strokes.every(stroke => stroke.op === 'lighter'));
  assert.ok(ctx.strokes.some(stroke => stroke.alpha < 0.2));
  assert.ok(ctx.strokes.some(stroke => stroke.alpha > 0.7));
  if (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined') {
    assert.ok(ctx.images.length > 0, 'the aura is a cached gradient sprite');
    assert.ok(ctx.images.length <= 28, 'stamps stay capped for a full floor of dancers');
  }
  api.configureBloom({enabled: false});
  const plain = mockCtx();
  api.paintEnergyBloom(plain, points, '#fff', false);
  assert.equal(plain.images.length, 0);
  assert.equal(plain.strokes.length, 2);
  assert.equal(plain.strokes[1].width, 2.5);
  api.configureBloom({enabled: true, intensity: 1, aura: 22});
  const clamped = api.configureBloom({intensity: 9, aura: 2});
  assert.equal(clamped.intensity, 2);
  assert.equal(clamped.aura, 8);
  const patch = sanitizeDebugPatch({bloomEnabled: false, bloomIntensity: 1.4, bloomAura: 40});
  assert.equal(patch.bloomEnabled, false);
  assert.equal(patch.bloomIntensity, 1.4);
  assert.equal(patch.bloomAura, 40);
  assert.equal(sanitizeDebugPatch({bloomAura: 100}).bloomAura, 64);
  const applied = [];
  assert.equal(applyDebugPatch({
    getElementById(id) {
      if (id !== 'nd-room-lab') return null;
      return {neuralDance: {setBloom(opts) { applied.push(opts); }}, querySelector() { return null; }};
    }
  }, {bloomEnabled: true, bloomIntensity: 1.2, bloomAura: 30}), true);
  assert.equal(applied[0].intensity, 1.2);
  assert.equal(applied[0].aura, 30);
  assert.match(livePage, /data-bloom[^>]*>Bloom</);
  assert.match(debugPage, /data-debug-bloom[^>]*>Bloom: on/);
  assert.match(debugPage, /data-debug-control="bloom"/);
  assert.match(debugPage, /data-debug-control="bloom-aura"/);
});
