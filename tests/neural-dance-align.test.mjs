import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fitBrightQuad} from '../neural-dance/camera-markers.js';
import {ALIGN_SETTLE_MS, beginAlign, runAlignPhase} from '../neural-dance/live-show.js';

function screenFlash() {
  const width = 160;
  const height = 90;
  const dark = new Uint8ClampedArray(width * height * 4);
  const bright = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < dark.length; i += 4) {
    dark[i] = dark[i + 1] = dark[i + 2] = 16;
    dark[i + 3] = 255;
    bright[i] = bright[i + 1] = bright[i + 2] = 16;
    bright[i + 3] = 255;
  }
  for (let y = 6; y < 84; y++) {
    for (let x = 10; x < 150; x++) {
      const i = (y * width + x) * 4;
      bright[i] = bright[i + 1] = bright[i + 2] = 236;
    }
  }
  const frame = (data) => ({data, width, height, videoWidth: width, videoHeight: height});
  return {dark: frame(dark), bright: frame(bright)};
}

test('Align projector starts the camera, enables markers, and keeps the banner outside the dock', async () => {
  const flash = screenFlash();
  let grabs = 0;
  const cam = {
    started: false,
    markers: false,
    async ensureCamera() { this.started = true; },
    grabFrame() {
      grabs += 1;
      // Align now holds each pattern until frames agree, so the black phase
      // reads several frames before the white flash.
      return grabs <= 5 ? flash.dark : flash.bright;
    },
    setNormalizedCorners() { return true; },
    setMarkersEnabled(on) { this.markers = on; return on; },
    cancelCalibration() {}
  };
  const classes = new Set();
  const banner = {hidden: true, textContent: '', dataset: {}};
  const outline = {hidden: true};
  const pattern = {hidden: true};
  const align = {textContent: 'Align projector', setAttribute() {}, getAttribute() { return null; }};
  const status = {textContent: ''};
  const doc = {
    body: {classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }},
    getElementById(id) {
      if (id === 'nd-room-lab') return {querySelector(sel) { return sel.includes('align') ? align : status; }};
      if (id === 'nd-camera-mode') return {neuralDanceCamera: cam};
      return null;
    },
    querySelector(sel) {
      if (sel.includes('data-align-banner')) return banner;
      if (sel.includes('cal-pattern')) return pattern;
      if (sel.includes('lock-outline')) return outline;
      if (sel.includes('exit-align')) return {hidden: true};
      return null;
    }
  };
  const queued = [];
  const original = global.setTimeout;
  global.setTimeout = (fn) => { queued.push(fn); return queued.length; };
  try {
    await beginAlign(doc, {alignSettleMs: 0});
  } finally {
    global.setTimeout = original;
  }
  assert.equal(cam.started, true);
  assert.equal(cam.markers, true);
  assert.match(banner.textContent, /aligned to the screen|Screen border|Marker phase|White phase/);
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const bannerAt = page.indexOf('data-align-banner');
  const dockAt = page.indexOf('id="nd-live-dock"');
  assert.ok(bannerAt > 0 && bannerAt < dockAt, 'the banner is not inside the dock');
  assert.match(page, /\[data-align-banner\]\{position:fixed/);
  assert.doesNotMatch(page, /nd-live-hidden \[data-align-banner\]/);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /ensureCamera/);
  assert.match(show, /alignSettleMs/);
  assert.match(show, /waitForAlignSettle/);
  assert.match(page, /data-cancel-align/);
  assert.match(page, /body\.nd-live-aligning:not\(\.nd-control-held\) \.nd-live-chrome/);
  assert.match(page, /translateX\(-120vw\)/);
  assert.match(page, /bottom:max\(12px, env\(safe-area-inset-bottom, 12px\)\)/);
  assert.equal(ALIGN_SETTLE_MS, 280);
  assert.match(page, /#00e5a8/);
  assert.match(show, /nd-live-aligning/);
  assert.match(show, /Marker phase/);
  assert.match(page, /1 RED/);
  assert.match(page, /data-align-pattern/);
});

test('a frame that does not change is not reported as aligned', async () => {
  const flash = screenFlash();
  const cam = {
    async ensureCamera() {},
    grabFrame() { return flash.dark; },
    setNormalizedCorners() { return true; },
    setMarkersEnabled(on) { this.markers = on; return on; },
    cancelCalibration() {}
  };
  const classes = new Set();
  const doc = {
    body: {classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }},
    getElementById(id) {
      if (id === 'nd-room-lab') return {querySelector(sel) { return sel.includes('align') ? {textContent: '', setAttribute() {}} : {textContent: ''}; }};
      if (id === 'nd-camera-mode') return {neuralDanceCamera: cam};
      return null;
    },
    querySelector(sel) {
      if (sel.includes('data-align-banner')) return {hidden: true, textContent: '', dataset: {}};
      if (sel.includes('cal-pattern')) return {hidden: true};
      if (sel.includes('lock-outline')) return {hidden: true};
      if (sel.includes('exit-align') || sel.includes('cancel-align')) return {hidden: true};
      return null;
    }
  };
  const queued = [];
  const original = global.setTimeout;
  global.setTimeout = (fn) => { queued.push(fn); return queued.length; };
  try {
    await beginAlign(doc, {alignSettleMs: 0});
  } finally {
    global.setTimeout = original;
  }
  // Align refusal keeps the last good quad and does not open drag-corner UI
  // on the projector (TJ 4:43–4:44 PM).
  assert.equal(classes.has('nd-live-placing'), false);
  assert.notEqual(cam.markers, true);
  const fitted = fitBrightQuad(flash.dark.data, flash.bright.data, 160, 90);
  assert.equal(fitted.ok, true, fitted.reason);
  const skewed = fitBrightQuad(flash.dark.data, flash.dark.data, 160, 90);
  assert.equal(skewed.ok, false);
  assert.equal(skewed.corners, null);
});

test('an align phase that never settles times out with the phase name', async () => {
  let fired = null;
  const pending = runAlignPhase('Black phase', () => new Promise(() => {}), 2500, (fn) => {
    fired = fn;
    return 1;
  }, () => {});
  assert.equal(typeof fired, 'function');
  fired();
  const result = await pending;
  assert.equal(result.timeout, true);
  assert.equal(result.message, 'Black phase timed out.');
  const done = await runAlignPhase('White phase', async () => 'frame', 2500, () => 1, () => {});
  assert.equal(done.timeout, false);
  assert.equal(done.value, 'frame');
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /ALIGN_PHASE_MS = 2500/);
  assert.match(show, /timed out\./);
  assert.match(show, /nd-align-clean/);
  assert.match(show, /data-align-cancel-zone/);
});