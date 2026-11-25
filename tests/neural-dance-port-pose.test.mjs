// Side-sim port (TJ t2620u / 7:25 PM): arm-lift tiers, 35% softer stomp,
// heel-strike pulse sync, natural weight transfer, occasional standing tall.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {createSilhouetteShow, paintLegEnergy, silhouetteBloom, DEFAULT_SHOW_TUNING, BLOOM_INTENSITY_DEFAULT, cleanShowTuning} from '../neural-dance/src/silhouette.js';
import {createSongEnergy, createDancerEnergy, createPulseNetwork, dancerIntake, ARM_LIFT_FULL} from '../neural-dance/src/song-energy.js';
import {
  skeletonPose, placePoseOnFloor, armLiftAmount, landGive, swingLift, stepWeight, stepEase,
  shouldEnterTall, tallStandAt, resetTallStand,
  armLiftFamilyFor, armLiftFamilyAt, armLiftFamilySide, armLiftPhraseIndex, resetArmLiftFamilies,
  ARM_LIFT_FAMILIES, ARM_PHRASE_BEATS, DEFAULT_ARM_FAMILY,
  stanceWidthFor, stanceInHipWidths, stanceInShoulderWidths, STANCE_HIP_WIDE, STANCE_SH_MIN, STANCE_SH_CALM,
  STOMP_SOFT, PULSE_SOFT, DOUBLE_SUPPORT, CONTACT_HOVER, TALL_ACT_ENTER, TALL_HIP_Y,
  paintSilhouetteHalo, HALO_WIDTH_FRAC, HALO_ALPHA, haloAuraScale,
  hipWidth,
} from '../neural-dance/src/skeleton-dancer.js';
import {dancerHueRgb, dancerHueDisplayRgb, dancerHueCss, dancerHueSpec, mixTowardWhite, HUE_WHITE_MIX, HUE_SPREAD_DEFAULT, whiteMixFromSpread} from '../neural-dance/src/dancer-hue.js';
import {simSilhouetteMarkers} from '../neural-dance/room-lab.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, clip() {}, fillRect() {}};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}

const poseAt = (extra = {}) => skeletonPose({id: 3, band: 1, weight: 0, ease: 0, side: -1, swing: 0, lift: 0, armLift: 0, ...extra});

test('armLiftAmount: low / mid / high activation map onto 0, 0.5, 1', () => {
  assert.equal(armLiftAmount(0), 0);
  assert.equal(armLiftAmount(0.12), 0);
  assert.ok(armLiftAmount(0.11) === 0);
  assert.ok(Math.abs(armLiftAmount(0.72) - 0.5) < 1e-9, '0.72 → mid');
  assert.ok(Math.abs(armLiftAmount(1.10) - 1) < 1e-9, '1.10 → high');
  assert.ok(armLiftAmount(0.4) > 0 && armLiftAmount(0.4) < 0.5);
  assert.ok(armLiftAmount(0.9) > 0.5 && armLiftAmount(0.9) < 1);
});

test('arm pose tiers: low arms down; mid elbows tucked, hands by the face; high elbows and hands overhead', () => {
  const low = poseAt({armLift: 0});
  const mid = poseAt({armLift: 0.5});
  const high = poseAt({armLift: 1});
  // LOW: athletic arms-down. Hands below the elbows, elbows below the head.
  assert.ok(low.handL.y > low.elL.y && low.handR.y > low.elR.y, 'low: hands below elbows');
  assert.ok(low.elL.y > low.head.y && low.elR.y > low.head.y, 'low: elbows below the head');
  assert.ok(low.handL.y - low.head.y > 0.2 && low.handR.y - low.head.y > 0.2, 'low: hands not by the face');
  // MID: elbows tucked at the sides (near the ribs), hands by the face and above the elbows.
  assert.ok(mid.handL.y < mid.elL.y && mid.handR.y < mid.elR.y, 'mid: hands above elbows');
  assert.ok(mid.elL.y > mid.head.y && mid.elR.y > mid.head.y, 'mid: elbows not above the head');
  assert.ok(Math.abs(mid.handL.y - mid.head.y) < 0.18 && Math.abs(mid.handR.y - mid.head.y) < 0.18, 'mid: hands near the face');
  assert.ok(Math.abs(mid.elL.x - mid.shL.x) < 0.12 && Math.abs(mid.elR.x - mid.shR.x) < 0.12, 'mid: elbows tucked at the sides');
  // HIGH: elbows above the head, hands above the head and the elbows.
  assert.ok(high.elL.y < high.head.y && high.elR.y < high.head.y, 'high: elbows above the head');
  assert.ok(high.handL.y < high.head.y && high.handR.y < high.head.y, 'high: hands above the head');
  assert.ok(high.handL.y < high.elL.y && high.handR.y < high.elR.y, 'high: hands above the elbows');
});

test('heart-branch pulse still nudges elbows and hands a little at rest', () => {
  const rest = poseAt({lift: 0, armLift: 0});
  const up = poseAt({lift: 1, armLift: 0});
  assert.ok(up.handL.y < rest.handL.y && up.handR.y < rest.handR.y, 'pulse lifts both hands a little');
  assert.ok(rest.handL.y - up.handL.y < 0.05, 'subtle');
});

test('stomp jolt and pulse are ~35% softer; sharp stop on the beat is kept', () => {
  assert.equal(STOMP_SOFT, 0.65);
  assert.equal(PULSE_SOFT, 0.65);
  assert.ok(Math.abs(landGive(0) - 0.65) < 1e-9, 'peak jolt is 35% softer');
  assert.ok(landGive(0, true) === 0, 'no jolt while airborne');
  const atBeat = poseAt({ease: 0, weight: -1, side: -1});
  const later = poseAt({ease: 0.5, weight: 0, side: -1});
  assert.ok(atBeat.give > later.give, 'give peaks on the beat, then recovers');
  // Ease-in still arrives exactly at 1 (sharp stop).
  assert.equal(stepEase(0), 0);
  assert.equal(stepEase(1), 1);
  assert.ok(stepEase(0.5) < 0.2, 'slow on the planted foot, then a fast transfer');
  // Paint of the heel flash at u=0 is allowed (same frame as contact).
  let filled = 0;
  const ctx = recorder();
  ctx.arc = () => {};
  ctx.createRadialGradient = () => ({addColorStop() {}});
  const prevFill = ctx.fill;
  // recorder swallows fill; just assert the function returns true at u=0.
  assert.equal(paintLegEnergy(ctx, {x: 0, y: 10}, {x: 0, y: 0}, 0), true);
  assert.equal(paintLegEnergy(ctx, {x: 0, y: 10}, {x: 0, y: 0}, -0.1), false);
});

test('weight transfer: hips settle over the planted foot, then the swing foot lifts, travels, and plants on the beat; short double-support; no both-feet-float except jumps', () => {
  for (const side of [-1, 1]) {
    const plantedKey = side < 0 ? 'footL' : 'footR';
    const freeKey = side < 0 ? 'footR' : 'footL';
    let ref = null;
    let sawLift = false;
    let hipsBeforeLift = false;
    let dsFrames = 0;
    for (let f = 0; f <= 0.999; f += 0.02) {
      const w = stepWeight(side, f);
      const unit = skeletonPose({id: 3, band: 2, weight: w, ease: f, side, swing: 0});
      const pose = placePoseOnFloor(unit, {cx: 500, cy: 300, baseH: 90, height: 90, side});
      if (!ref) ref = {x: pose[plantedKey].x, y: pose[plantedKey].y};
      assert.ok(Math.abs(pose[plantedKey].x - ref.x) < 1e-9 && Math.abs(pose[plantedKey].y - ref.y) < 1e-9, 'stance foot slid at ease ' + f.toFixed(2));
      assert.ok(Math.abs(pose[plantedKey].y - pose.floorY) < 1e-9, 'stance foot on the floor');
      const freeLift = pose.floorY - pose[freeKey].y;
      const bothUp = (pose.floorY - pose.footL.y > 1) && (pose.floorY - pose.footR.y > 1);
      assert.ok(!bothUp, 'both feet left the floor at ease ' + f.toFixed(2));
      if (f <= DOUBLE_SUPPORT + 1e-9) {
        assert.ok(freeLift < 0.5, 'double-support: swing foot still down at ease ' + f.toFixed(2));
        assert.ok(Math.abs(w - side) < 0.05, 'hips still over the planted foot during double-support');
        dsFrames++;
      }
      if (freeLift < 0.5 && Math.abs(w - side) < 0.08) hipsBeforeLift = true;
      if (freeLift > 2) sawLift = true;
    }
    assert.ok(dsFrames >= 3, 'a short double-support is visible');
    assert.ok(hipsBeforeLift, 'hips are over the planted foot before the other lifts');
    assert.ok(sawLift, 'swing foot lifts mid-step');
    // At the next beat (ease 0 of the following step) the previous swing foot is planted.
    const land = skeletonPose({id: 3, band: 2, weight: -side, ease: 0, side: -side, swing: 0});
    assert.ok(land.liftL === 0 && land.liftR === 0, 'both feet down on the beat');
  }
  assert.ok(swingLift(0) === 0);
  assert.ok(swingLift(1) >= CONTACT_HOVER, 'swing foot hovers until the next strike, does not plant early');
});

test('heel-strike pulse launches on the contact frame of the striking foot (≤ 17 ms) and travels that leg', () => {
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  const ctx = recorder();
  const sims = simSilhouetteMarkers([{id: 11, x: 400, y: 300, type: 1}]);
  const dt = 1000 / 60;
  const period = 500; // stride 1 (slower than FAST_STRIKE_MS)
  const events = [];
  let prev = null;
  for (let t = 0; t <= 6000; t += dt) {
    if (t >= 1000 && Math.abs((t - 1000) % period) < dt * 0.5) show.beat(t, 1 << 1);
    show.paint(ctx, sims, {now: t, xy: (x, y) => ({x, y})});
    const f = show.figureHeights().find(h => h.id === 11);
    if (!f || f.jump > 0) { prev = f || prev; continue; }
    const strikeT = f.lastStrikeT0 >= 0 ? f.lastStrikeT0 * 1000 : -1;
    const pulseNow = f.pulsePhase === 'leg' && f.pulseAge >= 0 && f.pulseAge * 1000 <= dt + 0.5;
    const leftDown = f.liftL < 0.6;
    const rightDown = f.liftR < 0.6;
    if (pulseNow && prev && strikeT >= 0) {
      const strikingRight = f.pulseSide >= 0;
      const contactLift = strikingRight ? f.liftR : f.liftL;
      const wasUp = strikingRight ? (prev.liftR > 0.6) : (prev.liftL > 0.6);
      // Contact is this frame (foot now down) or the same frame as the strike clock.
      const contactT = t;
      const lag = Math.abs(contactT - strikeT);
      events.push({t: +t.toFixed(2), strikeT: +strikeT.toFixed(2), lag: +lag.toFixed(2), pulseSide: f.pulseSide, stance: f.stance, contactLift: +contactLift.toFixed(3), wasUp, pulseU: f.pulseU, pulseAgeMs: +(f.pulseAge * 1000).toFixed(2), bothDown: leftDown && rightDown});
      assert.ok(lag <= 17 + 1e-6, `heel contact vs pulse launch lag ${lag.toFixed(2)} ms > 17 ms at t=${t}`);
      assert.ok(contactLift < 0.6, 'striking foot is on the floor at launch');
      const stanceSide = (f.stance === 'footR' || f.stance === 'heelR') ? 1 : -1;
      assert.equal(Math.sign(f.pulseSide) || 1, stanceSide, 'pulse travels the striking / planted leg');
    }
    prev = {liftL: f.liftL, liftR: f.liftR, stance: f.stance};
  }
  assert.ok(events.length >= 6, 'logged enough heel-strike events (' + events.length + ')');
  const logPath = new URL('../heel-pulse-sync.log', import.meta.url);
  const lines = ['t_ms\tstrike_ms\tlag_ms\tpulseSide\tstance\tcontactLift\tpulseU\tpulseAge_ms\tbothDown'];
  for (const e of events) lines.push([e.t, e.strikeT, e.lag, e.pulseSide, e.stance, e.contactLift, e.pulseU, e.pulseAgeMs, e.bothDown].join('\t'));
  writeFileSync(logPath, lines.join('\n') + '\n');
  const maxLag = Math.max(...events.map(e => e.lag));
  console.log('heel-pulse sync: ' + events.length + ' events, max lag ' + maxLag.toFixed(2) + ' ms, log ' + logPath.pathname);
});

test('standing tall: feet close, legs straight, spine extended, arms high; only at high activation; planted foot does not slide', () => {
  const wide = poseAt({armLift: 0, tall: 0, weight: -1, side: -1});
  const tall = poseAt({armLift: 0, tall: 1, weight: -1, side: -1});
  const wideSpan = wide.footR.x - wide.footL.x;
  const tallSpan = tall.footR.x - tall.footL.x;
  const tallSh = stanceInShoulderWidths(tall.stanceW, tall.b);
  assert.ok(Math.abs(tallSh - STANCE_SH_MIN) < 0.02, 'tall uses the 0.85 shoulder-width floor (got ' + tallSh.toFixed(3) + ')');
  assert.ok(tallSpan < wideSpan - 0.004, `tall stance ${tallSpan.toFixed(3)} should be narrower than default ${wideSpan.toFixed(3)}`);
  assert.ok(tallSpan > 0.7 * 2 * tall.b.shW, 'tall is never feet-together');
  assert.ok(tall.hipL.y < wide.hipL.y, 'hips rise (legs lengthen / straighten)');
  // Bottom-up support (TJ 10:41 AM): legs keep a soft micro-bend, so standing
  // tall can no longer lift the crown by locking the knees; it must not sink.
  assert.ok(tall.crown.y <= wide.crown.y + 0.003, 'spine / crown stay up (' + tall.crown.y.toFixed(3) + ' vs ' + wide.crown.y.toFixed(3) + ')');
  // Legs straighter: knee sits closer to the hip–ankle line.
  const bent = (p, side) => {
    const hip = side < 0 ? p.hipL : p.hipR;
    const knee = side < 0 ? p.kneeL : p.kneeR;
    const ank = side < 0 ? p.ankleL : p.ankleR;
    const vx = ank.x - hip.x, vy = ank.y - hip.y;
    const len = Math.hypot(vx, vy) || 1;
    const t = ((knee.x - hip.x) * vx + (knee.y - hip.y) * vy) / (len * len);
    const px = hip.x + vx * t, py = hip.y + vy * t;
    return Math.hypot(knee.x - px, knee.y - py);
  };
  assert.ok(bent(tall, -1) < bent(wide, -1) * 0.7, 'left leg straighter when tall');
  assert.ok(tall.elL.y < tall.head.y && tall.handL.y < tall.elL.y, 'arms take the high pose');
  // Planted foot does not slide as tall blends 0→1.
  let ref = null;
  let anchorX = null;
  for (let u = 0; u <= 1.0001; u += 0.05) {
    const unit = skeletonPose({id: 3, band: 1, weight: -1, ease: 0, side: -1, tall: u, armLift: u});
    if (anchorX == null) anchorX = 400 + unit.footL.x * 90;
    const pose = placePoseOnFloor(unit, {cx: 400, cy: 300, baseH: 90, height: 90, side: -1, anchorX});
    if (!ref) ref = {x: pose.footL.x, y: pose.footL.y};
    assert.ok(Math.abs(pose.footL.x - ref.x) < 1e-9 && Math.abs(pose.footL.y - ref.y) < 1e-9, 'stance foot slid during tall blend at ' + u);
    assert.ok(Math.abs(pose.footL.y - pose.floorY) < 1e-9);
  }
  // Never enters at low activation; does enter at high activation (occasionally, not constantly).
  let lowHits = 0, highHits = 0, highBeats = 0;
  for (let id = 1; id <= 40; id++) {
    for (let beat = 0; beat < 200; beat++) {
      if (shouldEnterTall({id, beat, activation: 0})) lowHits++;
      if (shouldEnterTall({id, beat, activation: 0.2})) lowHits++;
      highBeats++;
      if (shouldEnterTall({id, beat, activation: 1.1})) highHits++;
    }
  }
  assert.equal(lowHits, 0, 'standing tall must never start at low activation');
  assert.ok(highHits > 20, 'standing tall occurs at high activation (' + highHits + ')');
  assert.ok(highHits / highBeats < 0.25, 'not constant: ' + (highHits / highBeats).toFixed(3) + ' of high-energy beats');
  // Stateful envelope: stays off at low energy, rises at high energy, then returns.
  resetTallStand();
  let peak = 0;
  for (let t = 0; t < 8000; t += 16) {
    const beat = Math.floor(t / 500);
    const y = tallStandAt(7, {activation: 0.1, beat, now: t, periodMs: 500});
    peak = Math.max(peak, y);
  }
  assert.ok(peak < 0.05, 'envelope stays down at low activation (' + peak + ')');
  resetTallStand();
  peak = 0;
  let sawReturn = false;
  for (let t = 0; t < 16000; t += 16) {
    const beat = Math.floor(t / 500);
    const y = tallStandAt(7, {activation: 1.15, beat, now: t, periodMs: 500});
    if (y > 0.8) peak = Math.max(peak, y);
    if (peak > 0.8 && y < 0.35) sawReturn = true;
  }
  assert.ok(peak > 0.8, 'envelope reaches standing tall at high activation (' + peak + ')');
  // Held only 1–2 beats, then eases back (may enter again later — not stuck on).
  assert.ok(sawReturn, 'returns toward a wide stance after the hold');
  resetTallStand();
});

test('dancer hues mix ~60% toward white and stay recognizable by band', () => {
  assert.ok(HUE_WHITE_MIX >= 0.55 && HUE_WHITE_MIX <= 0.65);
  const luma = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const bass = dancerHueRgb(4, 1), bassW = dancerHueDisplayRgb(4, 1);
  const mid = dancerHueRgb(5, 2), midW = dancerHueDisplayRgb(5, 2);
  const high = dancerHueRgb(6, 3), highW = dancerHueDisplayRgb(6, 3);
  for (const [raw, pale] of [[bass, bassW], [mid, midW], [high, highW]]) {
    assert.ok(luma(pale) > luma(raw), 'whitened color is lighter');
    const mixed = mixTowardWhite(raw, HUE_WHITE_MIX);
    assert.ok(Math.abs(mixed.r - pale.r) < 1e-9);
  }
  // Family still reads: bass warm, mid yellow/green, high blue/violet.
  assert.ok(bassW.r > bassW.b && bassW.r >= bassW.g, 'bass still leans red/orange');
  assert.ok(midW.g + midW.r > midW.b * 1.05, 'mid still leans yellow/green');
  assert.ok(highW.b > highW.r && highW.b >= highW.g * 0.9, 'high still leans blue/violet');
  // Distinct from each other.
  assert.ok(Math.abs(bassW.r - midW.r) + Math.abs(bassW.g - midW.g) + Math.abs(bassW.b - midW.b) > 0.08);
  assert.ok(dancerHueCss(4, 1).startsWith('rgb'));
  assert.equal(dancerHueSpec(4, 1).family, 'bass');
});

test('glow is a subtle silhouette halo (not round dots), scaled by bloom/aura, off when bloom is disabled', () => {
  assert.ok(HALO_WIDTH_FRAC <= 0.06 && HALO_ALPHA <= 0.16, 'halo is subtler than the old dot glow');
  const unit = poseAt({armLift: 0.5, weight: -1, side: -1});
  const posed = placePoseOnFloor(unit, {cx: 200, cy: 200, baseH: 120, height: 120, side: -1});
  const strokes = [];
  const ctx = {
    lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', strokeStyle: '',
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() { strokes.push({width: this.lineWidth, alpha: this.globalAlpha, style: this.strokeStyle, op: this.globalCompositeOperation}); },
    fill() {}, arc() {}, ellipse() {}
  };
  assert.equal(paintSilhouetteHalo(ctx, posed, (x, y) => ({x, y}), {scale: 1, dim: 0.4, width: 1, alpha: 1, color: 'rgb(240, 220, 210)'}), true);
  assert.ok(strokes.length >= 6, 'halo strokes the silhouette (torso, limbs, head), got ' + strokes.length);
  assert.ok(strokes.every(s => (s.op || 'lighter') === 'lighter' || s.op === undefined));
  // No radial-gradient fill of a large disc — we only stroked the figure.
  const bloomOff = silhouetteBloom({...DEFAULT_SHOW_TUNING, bloomEnabled: false});
  assert.equal(bloomOff.glow, 0);
  assert.equal(paintSilhouetteHalo(ctx, posed, (x, y) => ({x, y}), {dim: bloomOff.glow}), false);
  const wide = silhouetteBloom({...DEFAULT_SHOW_TUNING, bloomAura: 44, bloomIntensity: 2});
  const narrow = silhouetteBloom({...DEFAULT_SHOW_TUNING, bloomAura: 11, bloomIntensity: 0.5});
  assert.ok(wide.width > narrow.width && wide.glow > narrow.glow, 'bloom/aura still scale the halo');
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  const paintFn = src.slice(src.indexOf('const render = (X, k'));
  assert.match(paintFn, /paintSilhouetteHalo\(ctx, posed/);
  assert.match(paintFn, /haloAuraScale\(act\)/);
  assert.doesNotMatch(paintFn, /paintFigureGlow\(ctx, lights/);
});

test('halo width follows smoothed activation; aura slider is the max; silence is none', () => {
  assert.equal(haloAuraScale(0), 0);
  assert.equal(haloAuraScale(-1), 0);
  assert.ok(haloAuraScale(0.2) > 0 && haloAuraScale(0.2) < 0.35, 'low activation stays thin');
  assert.ok(haloAuraScale(1) === 1 && haloAuraScale(1.2) === 1, 'high activation reaches the slider max');
  assert.ok(haloAuraScale(0.15) < haloAuraScale(1), 'low width is less than high');
  const unit = poseAt({armLift: 0.5, weight: -1, side: -1});
  const posed = placePoseOnFloor(unit, {cx: 200, cy: 200, baseH: 120, height: 120, side: -1});
  const strokeW = (width) => {
    const strokes = [];
    const ctx = {
      lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'lighter', strokeStyle: '',
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      stroke() { strokes.push(this.lineWidth); },
      fill() {}, arc() {}, ellipse() {}
    };
    const drawn = paintSilhouetteHalo(ctx, posed, (x, y) => ({x, y}), {scale: 1, dim: 0.4, width, alpha: 1, color: 'rgb(240, 220, 210)'});
    return {drawn, max: strokes.length ? Math.max(...strokes) : 0, count: strokes.length};
  };
  const silent = strokeW(0);
  assert.equal(silent.drawn, false, 'zero activation / silence draws no halo');
  assert.equal(silent.count, 0);
  const bloom = silhouetteBloom(DEFAULT_SHOW_TUNING);
  const low = strokeW(bloom.width * haloAuraScale(0.15));
  const high = strokeW(bloom.width * haloAuraScale(1.1));
  assert.equal(low.drawn, true);
  assert.equal(high.drawn, true);
  assert.ok(high.max > low.max * 1.5, 'high-activation halo is clearly wider than low (' + high.max + ' vs ' + low.max + ')');
  const maxed = silhouetteBloom({...DEFAULT_SHOW_TUNING, bloomAura: 44});
  const atMax = strokeW(maxed.width * haloAuraScale(1));
  const atDefault = strokeW(bloom.width * haloAuraScale(1));
  assert.ok(atMax.max > atDefault.max, 'Aura width slider still sets the maximum');
});

test('hue spread: 0 is near-white same tint, max is full individual color', () => {
  // Default moved to 0.10 (TJ 11:31 AM); 0.40 stays the visual reference.
  assert.equal(HUE_SPREAD_DEFAULT, 0.10);
  assert.ok(Math.abs(whiteMixFromSpread(0.40) - HUE_WHITE_MIX) < 1e-9);
  assert.equal(whiteMixFromSpread(0), 1);
  assert.equal(whiteMixFromSpread(1), 0);
  const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const at = (spread, id, band) => dancerHueDisplayRgb(id, band, whiteMixFromSpread(spread));
  const ids = [[4, 1], [5, 2], [6, 3]];
  const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  let minSpan = 0, maxSpan = 0;
  for (const [id, band] of ids) {
    const lo = at(0, id, band), hi = at(1, id, band);
    assert.ok(lo.r > 0.92 && lo.g > 0.92 && lo.b > 0.92, 'min spread is near white');
    assert.ok(chroma(lo) < 0.08, 'min spread tints stay close to each other');
    assert.ok(chroma(hi) > chroma(lo) * 3, 'max spread keeps full individual color');
  }
  const loA = at(0, 4, 1), loB = at(0, 5, 2), loC = at(0, 6, 3);
  const hiA = at(1, 4, 1), hiB = at(1, 5, 2), hiC = at(1, 6, 3);
  minSpan = dist(loA, loB) + dist(loB, loC);
  maxSpan = dist(hiA, hiB) + dist(hiB, hiC);
  assert.ok(minSpan < 0.25, 'at 0, dancers share nearly the same near-white tint (' + minSpan + ')');
  assert.ok(maxSpan > minSpan * 3, 'at max, individual colors are clearly separated (' + maxSpan + ' vs ' + minSpan + ')');
  // The 0.40 reference matches the whitened look.
  const def = at(0.40, 4, 1);
  const expected = mixTowardWhite(dancerHueRgb(4, 1), HUE_WHITE_MIX);
  assert.ok(Math.abs(def.r - expected.r) < 1e-9);
  const src = readFileSync(new URL('../neural-dance/src/silhouette.js', import.meta.url), 'utf8');
  assert.match(src, /dancerHueCss\(id, band, show\.tuning\.hueSpread\)/);
});

test('default bloom intensity is low so the string reads; slider can still raise it', () => {
  assert.ok(BLOOM_INTENSITY_DEFAULT >= 0.15 && BLOOM_INTENSITY_DEFAULT <= 0.2);
  assert.equal(DEFAULT_SHOW_TUNING.bloomIntensity, BLOOM_INTENSITY_DEFAULT);
  assert.equal(cleanShowTuning({}).bloomIntensity, BLOOM_INTENSITY_DEFAULT);
  assert.equal(cleanShowTuning({bloomIntensity: 1.4}).bloomIntensity, 1.4);
  assert.equal(cleanShowTuning({bloomIntensity: 0.05}).bloomIntensity, 0.05);
  const debugPage = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(debugPage, /data-debug-control="bloom"[^>]*value="0\.18"/);
  // Bloom slider goes all the way to 0 = no glow (TJ 11:22 AM).
  assert.match(debugPage, /data-debug-control="bloom"[^>]*min="0"/);
  const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.match(live, /data-control="hue-spread"/);
  assert.match(debugPage, /data-debug-control="hue-spread"/);
  // Camera note-matching slider is still present and clearly labeled.
  assert.match(debugPage, /Note hue range/);
  assert.match(live, /Hue range \(higher = wider color match\)/);
});

test('arm-lift families vary per phrase: left and right, no repeat, no family over 40%', () => {
  resetArmLiftFamilies();
  assert.equal(ARM_PHRASE_BEATS, 4);
  assert.equal(armLiftPhraseIndex(0), 0);
  assert.equal(armLiftPhraseIndex(3), 0);
  assert.equal(armLiftPhraseIndex(4), 1);
  assert.equal(armLiftPhraseIndex({beat: 11}), 2);
  assert.equal(DEFAULT_ARM_FAMILY, 'both-up');

  const N = 30;
  const ids = [2, 5, 9, 14, 21];
  for (const id of ids) {
    const seq = [];
    for (let p = 0; p < N; p++) seq.push(armLiftFamilyFor(id, p));
    for (let i = 1; i < seq.length; i++) {
      assert.notEqual(seq[i], seq[i - 1], 'dancer ' + id + ' repeated ' + seq[i] + ' at phrase ' + i);
    }
    const counts = Object.fromEntries(ARM_LIFT_FAMILIES.map(f => [f, 0]));
    let left = 0, right = 0;
    for (const f of seq) {
      counts[f]++;
      const side = armLiftFamilySide(f);
      if (side === 'left') left++;
      else if (side === 'right') right++;
      else if (side === 'split') {
        // Opposition still contributes a left- or right-high lift.
        const pose = skeletonPose({id, band: 1, armLift: 1, armFamily: f, phrase: seq.indexOf(f)});
        if (pose.handL.y < pose.handR.y) left++; else right++;
      }
    }
    for (const [f, n] of Object.entries(counts)) {
      assert.ok(n / N <= 0.40, 'dancer ' + id + ' family ' + f + ' is ' + (n / N * 100).toFixed(1) + '%');
    }
    assert.ok(left > 0 && right > 0, 'dancer ' + id + ' never used both sides (L=' + left + ' R=' + right + ') seq=' + seq.join(','));
  }
  // Same phrase, different seeds: dancers are not synchronized.
  let disagree = 0;
  for (let p = 0; p < N; p++) {
    const fams = ids.map(id => armLiftFamilyFor(id, p));
    if (new Set(fams).size > 1) disagree++;
  }
  assert.ok(disagree >= N * 0.6, 'dancers stayed in sync on too many phrases (' + disagree + '/' + N + ')');
});

test('arm-lift family geometry: left/right/both-sides/split, height still follows activation', () => {
  const at = (family, lift = 1, extra = {}) => skeletonPose({id: 3, band: 1, weight: 0, ease: 0, side: -1, swing: 0, lift: 0, armLift: lift, armFamily: family, phrase: 0, ...extra});
  const mid = at('both-up', 0.5);
  const high = at('both-up', 1);
  assert.ok(high.handL.y < mid.handL.y && high.handR.y < mid.handR.y, 'higher activation raises both hands');
  const leftUp = at('left-up', 1);
  const rightUp = at('right-up', 1);
  assert.ok(leftUp.handL.y < leftUp.handR.y - 0.08, 'left-up: left hand clearly higher');
  assert.ok(rightUp.handR.y < rightUp.handL.y - 0.08, 'right-up: right hand clearly higher');
  const bothL = at('both-left', 1);
  const bothR = at('both-right', 1);
  const midX = (p) => (p.handL.x + p.handR.x) / 2;
  assert.ok(midX(bothL) < midX(bothR) - 0.08, 'both-left hands sit left of both-right hands');
  assert.ok(bothL.handL.x < bothL.head.x && bothL.handR.x < bothL.head.x, 'both-left: both hands on the left');
  assert.ok(bothR.handL.x > bothR.head.x && bothR.handR.x > bothR.head.x, 'both-right: both hands on the right');
  const split = at('split', 1);
  // Opposition: hands on opposite sides of the spine, and one clearly higher.
  assert.ok(Math.sign(split.handL.x - split.groin.x) !== Math.sign(split.handR.x - split.groin.x) || Math.abs(split.handL.x - split.handR.x) > 0.12, 'split hands travel opposite ways');
  assert.ok(Math.abs(split.handL.y - split.handR.y) > 0.04, 'split: one arm higher (opposition)');
  // Default / omitted family is the original symmetric both-up (existing tests).
  const def = skeletonPose({id: 3, band: 1, armLift: 1});
  const explicit = at('both-up', 1);
  assert.equal(def.armFamily, 'both-up');
  assert.ok(Math.abs(def.handL.x - explicit.handL.x) < 1e-9 && Math.abs(def.handL.y - explicit.handL.y) < 1e-9);
});

test('corner insets use the same arm-lift family as the source dancer', () => {
  resetArmLiftFamilies();
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  show.setInsets(true);
  const ctx = recorder();
  const sims = simSilhouetteMarkers([
    {id: 4, x: 280, y: 300, type: 0},
    {id: 8, x: 520, y: 310, type: 1},
    {id: 12, x: 740, y: 290, type: 2}
  ]);
  // A few bars of kick+bass so phrase advances and families are chosen.
  for (let t = 0; t <= 2500; t += 1000 / 60) {
    if (t >= 200 && Math.abs((t - 200) % 500) < 9) show.beat(t, 0b0111);
    show.paint(ctx, sims, {now: t, xy: (x, y) => ({x, y})});
  }
  const figs = show.figureHeights();
  const insets = show.insetStates();
  assert.ok(insets.length >= 2, 'insets rendered (' + insets.length + ')');
  for (const inset of insets) {
    const fig = figs.find(f => f.id === inset.id);
    assert.ok(fig, 'inset #' + inset.id + ' has a stage figure');
    assert.equal(inset.armFamily, fig.armFamily, 'inset family matches source dancer #' + inset.id);
    assert.equal(inset.phrase, fig.phrase);
    // Same hands: inset reuses the posed figure (render closure).
    assert.ok(fig.handL && fig.handR);
  }
  // Two dancers on the same beat should not all share one family.
  const fams = figs.map(f => f.armFamily).filter(Boolean);
  assert.ok(new Set(fams).size >= 2 || figs.length < 2, 'stage dancers stayed in the same family: ' + fams.join(','));
});

test('stance width follows activation: hip-width at rest, 0.85–1.0 shoulder widths while dancing, naturally wide when activated', () => {
  const rest = poseAt({activation: 0, tall: 0, still: true, hush: 0});
  const mid = poseAt({activation: 0.5, tall: 0});
  const hot = poseAt({activation: 1, tall: 0});
  const tall = poseAt({activation: 1, tall: 1});
  const span = p => p.footR.x - p.footL.x;
  const hips = p => stanceInHipWidths(p.stanceW, p.b);
  const sh = p => stanceInShoulderWidths(p.stanceW, p.b);
  // TJ 10:30 AM: rest = foot centres just under the (outer) hip width, 0.8–0.9.
  const fc = p => ((p.footR.x + p.heelR.x) - (p.footL.x + p.heelL.x)) / 2 / hipWidth(p.b);
  void hips;
  assert.ok(fc(rest) >= 0.8 - 1e-6 && fc(rest) <= 0.9 + 1e-6, 'rest feet 0.8–0.9 hip widths, got ' + fc(rest).toFixed(2));
  assert.ok(sh(rest) < STANCE_SH_MIN - 0.02, 'rest is narrower than the dance floor');
  assert.ok(sh(mid) >= STANCE_SH_MIN - 1e-6, 'dancing mid never drops below the 0.85 floor');
  // TJ Nov 10: wide only at peak, a horse stance capped at 2.0 shoulder widths.
  assert.ok(sh(hot) > 1.6 && sh(hot) <= 2.0 + 1e-9, 'peak is the horse stance (1.6–2.0 shoulder widths, got ' + sh(hot).toFixed(2) + ')');
  assert.ok(sh(mid) <= 1.0, 'mid activation stays near shoulder width, got ' + sh(mid).toFixed(2));
  assert.ok(hips(hot) - hips(rest) >= 0.25, 'range must be clearly large');
  assert.ok(span(rest) < span(mid) - 0.01, 'rest stance is closer than mid');
  assert.ok(span(mid) < span(hot) - 0.01, 'energetic stance is wider than mid');
  assert.ok(Math.abs(sh(tall) - STANCE_SH_MIN) < 0.02, 'standing tall uses the 0.85 shoulder-width floor');
  // Omitted activation keeps the dancer base stance, still at or above the floor.
  const unset = poseAt({tall: 0});
  assert.ok(Math.abs(unset.stanceW - unset.b.stanceW) < 1e-9, 'omitted activation uses the dancer base stance');
  assert.ok(unset.stanceW > rest.stanceW - 1e-9, 'default stance is at least the rest width');
  assert.ok(sh(unset) >= STANCE_SH_MIN - 1e-6);
});

test('music AGC maps this-song peaks near 1; per-dancer AGC does not copy one global level', () => {
  const music = createSongEnergy({windowMs: 25000});
  const per = createDancerEnergy({windowMs: 25000});
  for (let i = 0; i < 400; i++) {
    const t = i * 80;
    const phrase = Math.sin(i / 40);
    const peak = i % 37 === 0 ? 1.4 : 0;
    const raw = Math.max(0, 0.55 + 0.25 * phrase + peak + ((i * 13) % 7) * 0.02);
    const lv = [raw * 0.9, raw * 0.4, raw * 0.35, raw * 0.02];
    music.process(t, lv, {open: true});
    // Two dancers get different received energy at the same moment.
    per.process(2, t, dancerIntake({received: raw * 0.2, local: lv[0]}), {open: true});
    per.process(9, t, dancerIntake({received: raw * 1.1, local: lv[1]}), {open: true});
  }
  const m = music.value();
  assert.ok(m.energy >= 0 && m.energy <= 1);
  const a = per.value(2).energy, b = per.value(9).energy;
  assert.notEqual(a, b, 'per-dancer AGC must not collapse both dancers to one value (' + a + ')');
  assert.equal(armLiftAmount(1 * ARM_LIFT_FULL), 1);
  assert.ok(armLiftAmount(dancerIntake({received: 0, local: 0, stringAct: 0}) * ARM_LIFT_FULL) === 0);
  assert.ok(dancerIntake({received: 1, local: 0}) > dancerIntake({received: 0, local: 1}), 'received energy outweighs local intake');
});

test('replay of tonight’s live capture: per-dancer pulse intake fully raises at peaks, stance varies, dancers differ', () => {
  const capPath = process.env.ND_LIVE_CAPTURE || '';
  if (!existsSync(capPath)) {
    assert.ok(true, 'capture file not present; skip live replay');
    return;
  }
  const lines = readFileSync(capPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const samples = [];
  const hitSet = [new Set(), new Set(), new Set(), new Set()];
  let lastT = null;
  for (const row of lines) {
    const m = row.m;
    if (!m) continue;
    if (m.type === 'audio') {
      for (const s of m.samples || []) {
        if (lastT != null && s.t - lastT < -5000) {
          if (samples.length > 800) break;
          samples.length = 0;
        }
        samples.push(s);
        lastT = s.t;
        if (s.hits) s.hits.forEach((h, b) => (h || []).forEach(t => hitSet[b].add(t)));
        if (samples.length > 4000) break;
      }
    }
    if (m.type === 'frame' && m.telemetry && m.telemetry.listen && m.telemetry.listen.hits) {
      m.telemetry.listen.hits.forEach((h, b) => (h || []).forEach(t => hitSet[b].add(t)));
    }
    if (samples.length > 4000) break;
  }
  assert.ok(samples.length > 200, 'expected audio samples in the capture (' + samples.length + ')');
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const hits = hitSet.map(s => [...s].filter(t => t >= t0 - 200 && t <= t1 + 200).sort((a, b) => a - b));

  const layout = [
    {id: 1, x: 220, y: 260, type: 0},
    {id: 2, x: 380, y: 280, type: 1},
    {id: 3, x: 540, y: 250, type: 2},
    {id: 4, x: 700, y: 300, type: 0},
    {id: 5, x: 840, y: 270, type: 3}
  ];
  const net = createPulseNetwork({linkR: 200});
  net.setDancers(layout);
  const music = createSongEnergy();
  const per = createDancerEnergy();
  const series = layout.map(d => ({id: d.id, act: []}));
  let prevT = t0;
  const hitIdx = [0, 0, 0, 0];
  const beforeBuild = {hipW: 0.09, shW: 0.125, stanceW: 0.125};
  const beforeStance = stanceWidthFor(0, beforeBuild, 0);

  for (const s of samples) {
    const dt = Math.max(0.001, (s.t - prevT) / 1000);
    net.tick(dt, s.t);
    for (let b = 0; b < 4; b++) {
      while (hitIdx[b] < hits[b].length && hits[b][hitIdx[b]] <= s.t) {
        net.hit(b, s.t);
        hitIdx[b]++;
      }
    }
    music.process(s.t, s.lv, {open: s.gate !== false});
    const song = music.value().energy;
    for (let i = 0; i < layout.length; i++) {
      const d = layout[i];
      const received = net.received(d.id);
      const local = (s.lv[d.type] || 0) * (0.35 + 0.65 * song);
      const raw = dancerIntake({received, local, stringAct: 0});
      const st = per.process(d.id, s.t, raw, {open: s.gate !== false});
      if (s.t - t0 >= 8000 && s.gate !== false) series[i].act.push(st.energy);
    }
    prevT = s.t;
  }

  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const std = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const dancerStats = series.map(s => {
    const a = s.act;
    const build = {hipW: 0.09, shW: 0.125, stanceW: 0.125};
    const lifts = a.map(v => armLiftAmount(v * ARM_LIFT_FULL));
    const stances = a.map(v => stanceWidthFor(v, build, 0));
    const hips = stances.map(w => stanceInHipWidths(w, build));
    const sortedH = hips.slice().sort((x, y) => x - y);
    const pct = q => sortedH[Math.max(0, Math.min(sortedH.length - 1, Math.round(q * (sortedH.length - 1))))];
    return {
      id: s.id,
      n: a.length,
      mean: +mean(a).toFixed(3),
      max: +Math.max(...a).toFixed(3),
      min: +Math.min(...a).toFixed(3),
      std: +std(a).toFixed(3),
      liftMax: +Math.max(...lifts).toFixed(3),
      fullFrac: +(lifts.filter(v => v >= 0.95).length / a.length).toFixed(3),
      tallFrac: +(a.filter(v => v >= 0.90).length / a.length).toFixed(3),
      stanceMin: +Math.min(...stances).toFixed(3),
      stanceMax: +Math.max(...stances).toFixed(3),
      hipMin: +Math.min(...hips).toFixed(3),
      hipP10: +pct(0.10).toFixed(3),
      hipP50: +pct(0.50).toFixed(3),
      hipP90: +pct(0.90).toFixed(3),
      hipMax: +Math.max(...hips).toFixed(3),
      shMin: +Math.min(...stances.map(w => stanceInShoulderWidths(w, build))).toFixed(3),
      togetherFrac: +(hips.filter(v => v <= 0.25).length / a.length).toFixed(3),
      narrowFrac: +(stances.filter(w => stanceInShoulderWidths(w, build) <= STANCE_SH_CALM + 0.02).length / a.length).toFixed(3),
      wideFrac: +(hips.filter(v => v >= 1.5).length / a.length).toFixed(3)
    };
  });
  // Spread across dancers at each frame (not identical curves).
  const frames = series[0].act.length;
  let meanSpread = 0, disagree = 0;
  for (let i = 0; i < frames; i++) {
    const vals = series.map(s => s.act[i]);
    const sp = Math.max(...vals) - Math.min(...vals);
    meanSpread += sp;
    if (sp > 0.05) disagree++;
  }
  meanSpread /= frames;
  const corr = (() => {
    const a = series[0].act, b = series[2].act;
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return da && db ? num / Math.sqrt(da * db) : 1;
  })();
  const stats = {
    before: {liftMax: 0, stanceMin: beforeStance, stanceMax: beforeStance},
    dancers: dancerStats,
    meanSpread: +meanSpread.toFixed(3),
    disagreeFrac: +(disagree / frames).toFixed(3),
    corr13: +corr.toFixed(3)
  };
  if (process.env.ND_LIVE_CAPTURE_OUT) writeFileSync(process.env.ND_LIVE_CAPTURE_OUT, JSON.stringify(stats, null, 2));
  console.log('activation before/after', JSON.stringify(stats));
  assert.equal(stats.before.liftMax, 0, 'string-only (0 pulses) never raises arms');
  for (const d of dancerStats) {
    assert.ok(d.max >= 0.95, 'dancer #' + d.id + ' peaks near 1 (' + d.max + ')');
    assert.ok(d.liftMax >= 0.95, 'dancer #' + d.id + ' fully raises (' + d.liftMax + ')');
    assert.ok(d.shMin >= STANCE_SH_MIN - 0.02, 'dancer #' + d.id + ' never drops below the 0.85 shoulder-width floor (shMin ' + d.shMin + ')');
    assert.ok(d.togetherFrac === 0, 'dancer #' + d.id + ' never goes feet-together (togetherFrac ' + d.togetherFrac + ')');
    assert.ok(d.hipMax >= 1.5, 'dancer #' + d.id + ' visits naturally wide (hipMax ' + d.hipMax + ')');
    assert.ok(d.wideFrac > 0.02, 'dancer #' + d.id + ' spends time wide (' + d.wideFrac + ')');
  }
  assert.ok(stats.meanSpread > 0.05, 'dancers should differ (mean spread ' + stats.meanSpread + ')');
  assert.ok(stats.disagreeFrac > 0.4, 'activation curves stay apart on most frames (' + stats.disagreeFrac + ')');
  assert.ok(stats.corr13 < 0.97, 'dancers 1 and 3 must not share an identical curve (corr ' + stats.corr13 + ')');
  const d1 = dancerStats.find(d => d.id === 1), d4 = dancerStats.find(d => d.id === 4);
  assert.ok(d1 && d4, 'expected kick dancers 1 and 4');
  const same14 = d1.hipP50 === d4.hipP50 && d1.narrowFrac === d4.narrowFrac && d1.wideFrac === d4.wideFrac && d1.fullFrac === d4.fullFrac;
  assert.ok(!same14, 'same-band dancers 1 and 4 must not share identical stance/raise stats');
  const corr14 = (() => {
    const a = series[0].act, b = series[3].act;
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return da && db ? num / Math.sqrt(da * db) : 1;
  })();
  stats.corr14 = +corr14.toFixed(3);
  const mad14 = series[0].act.reduce((s, v, i) => s + Math.abs(v - series[3].act[i]), 0) / series[0].act.length;
  stats.mad14 = +mad14.toFixed(3);
  assert.ok(mad14 > 0.01, 'same-band dancers 1 and 4 must differ in amplitude (mad ' + mad14.toFixed(3) + ')');
  assert.ok(corr14 < 0.995, 'same-band dancers 1 and 4 must not be a copied curve (corr ' + corr14.toFixed(3) + ')');


  // Drive the live show with the simulated network snapshot each frame.
  resetArmLiftFamilies();
  resetTallStand();
  const show = createSilhouetteShow();
  show.setMode('silhouette');
  show.resetSongEnergy();
  const ctx = recorder();
  const sims = simSilhouetteMarkers(layout.map(d => ({id: d.id, x: d.x, y: d.y, type: d.type})));
  net.reset();
  net.setDancers(layout);
  const hitAt = [0, 0, 0, 0];
  prevT = t0;
  let peakAct = 0, peakLift = 0, minSt = 99, maxSt = 0, sawFull = 0, maxSpread = 0;
  const curves = new Map(layout.map(d => [d.id, []]));
  for (const s of samples) {
    const now = 20000 + (s.t - t0);
    net.tick((s.t - prevT) / 1000, s.t);
    for (let b = 0; b < 4; b++) {
      while (hitAt[b] < hits[b].length && hits[b][hitAt[b]] <= s.t) { net.hit(b, s.t); hitAt[b]++; }
    }
    show.paint(ctx, sims, {now, xy: (x, y) => ({x, y}), levels: s.lv, songOpen: s.gate !== false, network: net.snapshot()});
    const st = show.poseStats();
    if (st.activation.max > peakAct) peakAct = st.activation.max;
    if (st.armLift.max > peakLift) peakLift = st.armLift.max;
    if (st.armLift.full) sawFull++;
    if (st.stance.min && st.stance.min < minSt) minSt = st.stance.min;
    if (st.stance.max > maxSt) maxSt = st.stance.max;
    if (st.activation.spread > maxSpread) maxSpread = st.activation.spread;
    for (const f of show.figureHeights()) if (curves.has(f.id)) curves.get(f.id).push(f.activation);
    prevT = s.t;
  }
  const showCorr = (() => {
    const a = curves.get(1) || [], b = curves.get(3) || [];
    const n = Math.min(a.length, b.length);
    if (n < 10) return 1;
    const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
    let num = 0, da = 0, db = 0;
    for (let i = a.length - n; i < a.length; i++) {
      const xa = a[i] - ma, xb = b[i - (a.length - n)] - mb;
      // use aligned indices
    }
    for (let i = 0; i < n; i++) {
      const xa = a[a.length - n + i] - ma, xb = b[b.length - n + i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return da && db ? num / Math.sqrt(da * db) : 1;
  })();
  console.log('show replay pose', {peakAct, peakLift, minSt, maxSt, sawFull, maxSpread, showCorr: +showCorr.toFixed(3)});
  assert.ok(peakLift >= 0.95, 'live show full raise at peaks (' + peakLift + ')');
  assert.ok(maxSt - minSt > 0.04, 'live show stance varies clearly (' + minSt + '–' + maxSt + ')');
  // stanceW is the ankle-line half width; slender dancers rest near 0.06. The
  // foot-centre bound (>= 0.8 hip widths) is asserted in the stance-cap tests.
  assert.ok(minSt >= 0.055, 'live show never goes feet-together; rest may be hip-width (' + minSt + ')');
  assert.ok(minSt <= 0.90 * 0.13 + 0.01, 'live show still reaches the calm narrow stance (' + minSt + ')');
  assert.ok(maxSt >= 0.12, 'live show reaches naturally wide (' + maxSt + ')');
  assert.ok(maxSpread > 0.05, 'live show dancers do not share one activation (' + maxSpread + ')');
  assert.ok(showCorr < 0.97, 'live show curves differ (corr ' + showCorr.toFixed(3) + ')');
});

test('hue spread drives ripples, string tint and per-dancer hue jitter (TJ 11:10 AM)', async () => {
  const hue = await import('../neural-dance/src/dancer-hue.js');
  const vs = await import('../neural-dance/src/vibrating-string.js');
  // Default keeps the original family hues and full-color ripples.
  assert.deepEqual(hue.dancerHueSpec(7, 2, 0.40), hue.dancerHueSpec(7, 2));
  assert.equal(hue.rippleWhiteMix(0.40), 0);
  assert.equal(hue.rippleWhiteMix(1), 0);
  assert.ok(hue.rippleWhiteMix(0) > 0.7);
  // 0 collapses ids to the family center; 1 widens the jitter.
  const spreadOf = s => {
    const hs = [1, 2, 3, 4, 5, 6, 7, 8].map(id => hue.dancerHueSpec(id * 4 + 2, 2, s).hue);
    return Math.max(...hs) - Math.min(...hs);
  };
  assert.ok(spreadOf(0) < 1e-6);
  assert.ok(spreadOf(1) > spreadOf(0.4) * 2);
  for (const id of [1, 9, 33]) for (const band of [0, 1, 2, 3]) {
    assert.equal(hue.dancerHueSpec(id, band, 1).family, hue.bandFamily(band).id);
  }
  // Ripple near-white at 0, saturated at default.
  const sat = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  assert.ok(sat(hue.dancerRippleRgb(5, 3, 0)) < sat(hue.dancerRippleRgb(5, 3, 0.4)) * 0.3);
  // dancerHueCss returns rgb(); the string tint must parse it.
  assert.notEqual(vs.parseHueDegrees(hue.dancerHueCss(5, 3, 0.4)), null);
  assert.equal(vs.hueAt(0.5, hue.dancerHueCss(5, 3, 1), 0), vs.hueAt(0.5));
  assert.notEqual(vs.hueAt(0.5, hue.dancerHueCss(5, 3, 1), hue.stringTintMix(1)), vs.hueAt(0.5));
  // Chakra order never flips, even at max tint.
  const h = s => +vs.hueAt(s, 'rgb(255, 0, 0)', 0.5).match(/hsl\(([\d.]+)/)[1];
  for (let s = 0.1; s <= 1; s += 0.1) assert.ok(h(s) >= h(s - 0.1));
  assert.match(readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8'), /dancerRippleRgb\(id,band,hueSpread\)/);
});

test('fine line: crisp thin string, bloom 0 paints no glow (TJ 11:22 AM)', async () => {
  const sil = await import('../neural-dance/src/silhouette.js');
  const vs = await import('../neural-dance/src/vibrating-string.js');
  const {pulseFineStyle} = await import('../neural-dance/room-lab.js');
  assert.equal(sil.BLOOM_INTENSITY_MIN, 0);
  assert.equal(sil.cleanShowTuning({bloomIntensity: 0}).bloomIntensity, 0);
  assert.ok(sil.fineLineWidth(60) <= 0.8 + 1e-9);
  assert.ok(sil.fineLineWidth(400) <= 1.8);
  assert.ok(sil.fineLineWidth(120) < vs.STRING_LINE_WIDTH / 2);
  const zero = sil.fineGlow({...sil.DEFAULT_SHOW_TUNING, bloomIntensity: 0}, 1.2);
  assert.equal(zero.glowWidth, 0); assert.equal(zero.aura, 0); assert.equal(zero.crisp, true);
  const def = sil.fineGlow(sil.DEFAULT_SHOW_TUNING, 1.2);
  const max = sil.fineGlow({...sil.DEFAULT_SHOW_TUNING, bloomIntensity: 2}, 1.2);
  assert.ok(def.glowWidth > 0 && max.glowWidth > def.glowWidth && max.glowWidth < vs.STRING_GLOW_WIDTH);
  assert.ok(Math.abs(def.aura - 1) < 1e-9);
  // Canvas spy: at bloom 0 the string draws only core strokes, chakra nodes no aura disc.
  const log = [];
  const ctx = {save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { log.push(['stroke', this.lineWidth, this.globalCompositeOperation]); }, fill() { log.push(['fill', this.r]); }, arc(x, y, r) { this.r = r; }};
  const pts = [{x: 0, y: 0, s: 0}, {x: 0, y: 10, s: 0.5}, {x: 0, y: 20, s: 1}];
  vs.paintVibratingString(ctx, pts, {width: 1.2, glowWidth: 0, glowAlpha: 0});
  assert.ok(log.every(e => e[1] === 1.2));
  log.length = 0;
  vs.paintChakraLights(ctx, [{x: 0, y: 0, radius: 4, alpha: 1, color: '#f00'}], {aura: 0, pointScale: 0.5, pointMin: 0.7});
  assert.equal(log.length, 1); assert.ok(log[0][1] < 2);
  const ps = pulseFineStyle({bloomIntensity: 0});
  assert.equal(ps.glowW, 0); assert.equal(ps.haloR, 0);
  assert.ok(pulseFineStyle({bloomIntensity: 2}).glowW > pulseFineStyle({bloomIntensity: 0.18}).glowW);
});
