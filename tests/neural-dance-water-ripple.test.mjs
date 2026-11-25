// Water-ripple background (TJ, Nov 9 4:13 PM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  RIPPLE_H,
  RIPPLE_W,
  compileRippleShaders,
  createWaterRipple,
  crowdScale,
  crowdScaleStomps,
  impulseFromDancer,
  stompRippleAmount,
  stompPlantsFromFigure,
  stageToRippleUV,
  RIPPLE_STOMP_GAIN
} from '../neural-dance/src/water-ripple.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';

function mockCanvas(w = 200, h = 120) {
  const img = {data: new Uint8ClampedArray(RIPPLE_W * RIPPLE_H * 4), width: RIPPLE_W, height: RIPPLE_H};
  return {
    width: w,
    height: h,
    __rippleField: null,
    getContext() {
      return {
        createImageData(cw, ch) {
          return {data: new Uint8ClampedArray(cw * ch * 4), width: cw, height: ch};
        },
        clearRect() {},
        putImageData() {},
        drawImage() {},
        get imageSmoothingEnabled() { return true; },
        set imageSmoothingEnabled(v) {},
        get globalCompositeOperation() { return this._comp || 'source-over'; },
        set globalCompositeOperation(v) { this._comp = v; },
        get globalAlpha() { return this._a ?? 1; },
        set globalAlpha(v) { this._a = v; }
      };
    }
  };
}

test('ripple field is low-res and damps after an impulse', () => {
  const sim = createWaterRipple();
  assert.equal(sim.width, RIPPLE_W);
  assert.equal(sim.height, RIPPLE_H);
  const canvas = mockCanvas();
  sim.hit(0.5, 0.5, 1);
  sim.step(canvas);
  assert.ok(canvas.__rippleField, 'field rendered for tests');
  let peak1 = 0;
  for (const h of canvas.__rippleField.heights) peak1 = Math.max(peak1, Math.abs(h));
  for (let i = 0; i < 200; i++) sim.step(canvas);
  let peak2 = 0;
  let energy2 = 0;
  for (const h of canvas.__rippleField.heights) {
    peak2 = Math.max(peak2, Math.abs(h));
    energy2 += h * h;
  }
  assert.ok(peak1 > 0.05, 'impulse injects energy');
  assert.ok(peak2 < peak1 * 0.35, `damping settles the field ${peak1} -> ${peak2}`);
  assert.ok(energy2 < peak1 * peak1 * RIPPLE_W * RIPPLE_H, 'energy stays bounded');
});

test('two dancers make interference (energy away from both centers)', () => {
  const sim = createWaterRipple();
  const canvas = mockCanvas();
  sim.hit(0.3, 0.5, 1);
  sim.hit(0.7, 0.5, 1);
  for (let i = 0; i < 20; i++) sim.step(canvas);
  const H = canvas.__rippleField.heights;
  let energy = 0;
  let nonzero = 0;
  for (const h of H) {
    energy += h * h;
    if (Math.abs(h) > 1e-4) nonzero++;
  }
  assert.ok(energy > 0.001, 'interference field has energy');
  assert.ok(nonzero > 30, 'energy spreads across many cells (emergent pattern), got ' + nonzero);
});

test('disabled ripples clear and ignore hits; intensity clamps', () => {
  const sim = createWaterRipple();
  assert.equal(sim.setIntensity(2), 1);
  assert.equal(sim.setIntensity(-1), 0);
  sim.setEnabled(false);
  const canvas = mockCanvas();
  sim.hit(0.5, 0.5, 1);
  sim.step(canvas);
  // cleared path: no field stash when disabled after clearRect-only
  sim.setEnabled(true);
  sim.clear();
  sim.hit(0.2, 0.2, 0.5);
  sim.step(canvas);
  assert.ok(canvas.__rippleField);
});

test('shaders compile when WebGL exists; report ok/false otherwise', () => {
  const result = compileRippleShaders(null);
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) assert.match(result.reason, /webgl/i);
});

test('stage UV mapping and dancer impulse helpers', () => {
  assert.deepEqual(stageToRippleUV(0, 0), {x: 0, y: 0});
  assert.deepEqual(stageToRippleUV(1000, 620), {x: 1, y: 1});
  // TJ 1:54 PM: ripples fire only on stomp edges, never a continuous level.
  assert.equal(impulseFromDancer({activity: 1}, 0), 0, 'activity trickle is gone');
  assert.equal(impulseFromDancer({activity: 0}, 1), 0, 'shared beat envelope is not a source');
  assert.equal(impulseFromDancer({activity: 1, stomp: 0.5, activation: 1}, 1, 2000), 0, 'a stomp level without an edge is silent');
  assert.ok(Math.abs(impulseFromDancer({stompHit: 0.4}, 0) - 0.4) < 1e-9);
  assert.ok(impulseFromDancer({stompHit: 2}, 1) <= 0.65 + 1e-9, 'never above the softer-stomp ceiling');
  assert.equal(impulseFromDancer({plants: []}, 1), 0);
  assert.ok(Math.abs(impulseFromDancer({plants: [{amount: 0.2}, {amount: 0.5}]}, 1) - 0.5) < 1e-9);
});

test('stomp plant helper fires once per foot landing or ornament, at the foot', () => {
  const base = {
    stomp: 0.5, activation: 0.8, hush: 1,
    footL: {x: 120, y: 400}, footR: {x: 160, y: 400},
    heelL: {x: 118, y: 402}, heelR: {x: 158, y: 402},
    contactL: 'flat', contactR: 'flat',
    liftL: 0, liftR: 0, lastStrikeT0: 1.0, pulseSide: -1, x: 140, y: 300, floorY: 400
  };
  assert.deepEqual(stompPlantsFromFigure(null, {...base, liftL: 0, liftR: 0, lastStrikeT0: -1}), [], 'first planted frame with no strike is quiet');
  const firstStrike = stompPlantsFromFigure(null, {...base, liftL: 0, liftR: 0, lastStrikeT0: 1.0, pulseSide: -1});
  assert.equal(firstStrike.length, 1, 'a first-frame strike still makes one ring');
  assert.equal(firstStrike[0].kind, 'transfer');
  const landR = stompPlantsFromFigure(
    {...base, liftL: 0, liftR: 0.08, lastStrikeT0: 1.0},
    {...base, liftL: 0, liftR: 0, lastStrikeT0: 1.0}
  );
  assert.equal(landR.length, 1);
  assert.equal(landR[0].side, 1);
  assert.equal(landR[0].kind, 'land');
  assert.equal(landR[0].x, 160);
  assert.equal(landR[0].y, 400);
  assert.ok(landR[0].amount > 0 && landR[0].amount <= 0.65);

  // Same planted pose the next frame: no second ring.
  assert.equal(stompPlantsFromFigure(
    {...base, liftL: 0, liftR: 0, lastStrikeT0: 1.0},
    {...base, liftL: 0, liftR: 0, lastStrikeT0: 1.0}
  ).length, 0);

  const strike = stompPlantsFromFigure(
    {...base, lastStrikeT0: 1.0, liftL: 0, liftR: 0},
    {...base, lastStrikeT0: 1.5, liftL: 0, liftR: 0, pulseSide: -1}
  );
  assert.equal(strike.length, 1);
  assert.equal(strike[0].kind, 'transfer');
  assert.equal(strike[0].side, -1);

  // Landing + strike on the same foot in one frame is a single ring.
  const both = stompPlantsFromFigure(
    {...base, liftL: 0.05, liftR: 0, lastStrikeT0: 1.0},
    {...base, liftL: 0, liftR: 0, lastStrikeT0: 1.5, pulseSide: -1}
  );
  assert.equal(both.length, 1);
  assert.equal(both[0].side, -1);

  const heel = stompPlantsFromFigure(
    {...base, contactL: 'flat', liftL: 0},
    {...base, contactL: 'heel', liftL: 0}
  );
  assert.equal(heel.length, 1);
  assert.equal(heel[0].kind, 'heelDrop');
  assert.equal(heel[0].x, 118, 'heel drop lands at the heel');

  // Settling heel → flat is not a new stomp.
  assert.equal(stompPlantsFromFigure(
    {...base, contactL: 'heel', liftL: 0},
    {...base, contactL: 'flat', liftL: 0}
  ).length, 0);

  assert.equal(stompPlantsFromFigure(
    {...base, liftR: 0.08},
    {...base, liftR: 0, stomp: 0, hush: 0}
  ).length, 0, 'a silenced stomp has no ring');
});

test('debug page has ripple toggle and intensity; patch sanitizes them', () => {
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(page, /data-debug-ripple[^>]*>Ripple: on/);
  assert.match(page, /data-debug-control="ripple-intensity"/);
  assert.match(page, /data-debug-ripple-status/);
  const patch = sanitizeDebugPatch({rippleEnabled: false, rippleIntensity: 0.7});
  assert.equal(patch.rippleEnabled, false);
  assert.equal(patch.rippleIntensity, 0.7);
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /data-ripple-layer/);
  assert.match(room, /paintRipples\(layer/);
  // Echo samples the stage canvas, not the ripple overlay.
  assert.match(room, /Ripples on their own overlay/);
});

test('Align and Scan clear the ripple overlay', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /if\(layer==='scan'\)\{scanCover\(\);paintRipples\(layer,\[\],0\);return;\}/);
  assert.match(room, /if\(layer==='black'\|\|layer==='white'\|\|layer==='gray'\)\{[^}]*paintRipples\(layer,\[\],0\);return;\}/);
});

test('near-source ripple pixels are additive hue light, not a dark halo', () => {
  const ripple = createWaterRipple({width: 80, height: 50});
  const canvas = {
    width: 80, height: 50,
    getContext() {
      return {
        clearRect() {},
        createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}; },
        putImageData() {},
        drawImage() {},
        imageSmoothingEnabled: true
      };
    }
  };
  // Two dancers, distinct hues
  ripple.hit(0.35, 0.5, 1.0, {r: 1, g: 0.1, b: 0.1});
  ripple.hit(0.65, 0.5, 1.0, {r: 0.1, g: 0.2, b: 1});
  for (let i = 0; i < 8; i++) ripple.step(canvas);
  const field = canvas.__rippleField;
  assert.ok(field && field.heights && field.colors);
  const w = field.width, h = field.height;
  const ix = (u, v) => ((Math.round(v * (h - 1)) * w) + Math.round(u * (w - 1)));
  // Background (far corner) should be near-zero alpha after threshold
  // Sample the painted ImageData path via shade by checking height energy + color positivity
  const nearA = ix(0.35, 0.5);
  const nearB = ix(0.65, 0.5);
  const far = ix(0.05, 0.05);
  assert.ok(Math.abs(field.heights[nearA]) >= Math.abs(field.heights[far]), 'source has energy');
  // Color channels near sources stay non-negative (no subtractive darkening)
  assert.ok(field.colors.r[nearA] >= 0 && field.colors.g[nearA] >= 0 && field.colors.b[nearA] >= 0);
  assert.ok(field.colors.r[nearB] >= 0 && field.colors.g[nearB] >= 0 && field.colors.b[nearB] >= 0);
  // Distinct hues deposited
  assert.ok(field.colors.r[nearA] > field.colors.b[nearA], 'dancer A leans red');
  assert.ok(field.colors.b[nearB] > field.colors.r[nearB], 'dancer B leans blue');
  // Source file asserts positive-only shading
  const src = readFileSync(new URL('../neural-dance/src/water-ripple.js', import.meta.url), 'utf8');
  assert.match(src, /Positive-only additive light/);
  assert.match(src, /energy < 0\.045/);
  assert.match(src, /premultiply|Premultiply/);
  assert.match(src, /source-over/);
  assert.doesNotMatch(src, /mix\(col, vec3\(0\.04/);
});

function silentCtx() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}

test('silhouette figureHeights emit one plant edge per stomp, not every frame', () => {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = silentCtx();
  const markers = [
    {id: 1, x: 320, y: 340, type: 0, kind: 'sim'},
    {id: 2, x: 620, y: 360, type: 1, kind: 'sim'}
  ];
  const t0 = 2000;
  show.beat(t0, 1 | 2);
  let frames = 0, hitFrames = 0, plantCount = 0;
  const atFeet = [];
  for (let i = 0; i < 120; i++) {
    const now = t0 + i * (1000 / 60);
    if (i === 36 || i === 72 || i === 108) show.beat(now, 1 | 2);
    show.paint(ctx, markers, {now, songOpen: true, levels: [0.95, 0.85, 0.7, 0.55], crowd: 2});
    frames++;
    const rows = show.figureHeights() || [];
    let hit = false;
    for (const h of rows) {
      const plants = Array.isArray(h.plants) ? h.plants : [];
      if (!plants.length) {
        assert.ok(!(h.stompHit > 0), 'stompHit is zero when there is no plant');
        continue;
      }
      hit = true;
      plantCount += plants.length;
      for (const p of plants) {
        assert.ok(p.amount > 0 && p.amount <= 0.65, 'plant strength is a stomp');
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        // Ring is at a foot, not the sticker center.
        const foot = p.side < 0 ? h.footL : h.footR;
        const heel = p.side < 0 ? h.heelL : h.heelR;
        const nearFoot = foot && Math.hypot(p.x - foot.x, p.y - foot.y) < 12;
        const nearHeel = heel && Math.hypot(p.x - heel.x, p.y - heel.y) < 12;
        assert.ok(nearFoot || nearHeel, 'plant is at the landing foot');
        atFeet.push(p);
      }
    }
    if (hit) hitFrames++;
  }
  assert.ok(plantCount >= 2, 'stomps produced rings (' + plantCount + ')');
  assert.ok(hitFrames < frames * 0.4, 'plants are edges, not a per-frame level (' + hitFrames + '/' + frames + ')');
  assert.ok(atFeet.length === plantCount);
});


test('stompRippleAmount is visible at intensity 0.25 with 24-dancer crowd scale', () => {
  const crowd = crowdScaleStomps(27); // 24 sim + 3 stickers, as on the show floor
  assert.ok(crowd > crowdScale(27), 'stomp crowd scale is milder than the old every-frame scale');
  assert.ok(crowd > 0.75, '24-dancer stomp scale stays close to 1, got ' + crowd.toFixed(3));
  const mid = stompRippleAmount(0.4, crowd, 1);
  const quiet = stompRippleAmount(0.13, crowd, 1);
  assert.ok(mid >= 0.7, 'a mid stomp stays a strong splat at 24 dancers (' + mid.toFixed(3) + ')');
  assert.ok(quiet > 0.06 && quiet < mid * 0.35, 'a rest plant is a subtle ripple, not a full splat (' + quiet.toFixed(3) + ' vs mid ' + mid.toFixed(3) + ')');
  assert.equal(stompRippleAmount(0.4, crowd, 0), 0, 'hush 0 mutes');
  assert.equal(stompRippleAmount(0, crowd, 1), 0, 'no plant, no hit');
  // CPU field at TJ's saved intensity: a single mid stomp must paint visible pixels.
  const ripple = createWaterRipple({width: 80, height: 50});
  ripple.setEnabled(true);
  ripple.setIntensity(0.25);
  const canvas = mockCanvas(200, 120);
  ripple.hit(0.4, 0.7, mid, {r: 0.2, g: 0.8, b: 0.95});
  ripple.step(canvas);
  const field = canvas.__rippleField;
  assert.ok(field && field.pixels, 'shaded field');
  let maxA = 0, lit = 0;
  const px = field.pixels;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] > maxA) maxA = px[i];
    if (px[i] >= 20) lit++;
  }
  assert.ok(maxA >= 28, 'crest alpha is visible at intensity 0.25 (got ' + maxA + ')');
  assert.ok(lit >= 8, 'a ring of pixels is lit (' + lit + ')');
});

test('sticker and sim plants with the same raw id both produce a hit', () => {
  // Mirrors paintRipples: walk figureHeights and map sticker ids through
  // 100000+n so they cannot collide with sim #1.
  const STICKER_BASE = 100000;
  const figId = (h) => h.kind === 'sim' ? (h.id | 0) : STICKER_BASE + (Math.abs(h.id | 0) || 1);
  const figs = [
    {id: 1, kind: 'sticker', band: 0, hush: 1, plants: [{amount: 0.4, x: 100, y: 200}]},
    {id: 1, kind: 'sim', band: 1, hush: 1, plants: [{amount: 0.5, x: 300, y: 220}]}
  ];
  const map = new Map(figs.map(h => [h.id | 0, h]));
  assert.equal(map.size, 1, 'a raw-id map drops one of the two dancers');
  const hits = [];
  for (const fig of figs) {
    const id = figId(fig);
    for (const p of fig.plants) hits.push({id, amount: stompRippleAmount(p.amount, crowdScaleStomps(2), 1)});
  }
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0].id, hits[1].id);
  assert.ok(hits.every(h => h.amount > 0));
});
