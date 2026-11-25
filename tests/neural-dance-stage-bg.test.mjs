// TJ 12:17 PM PT: projected stage turned solid salmon/pink (~#FF9A85) and
// froze, with dancers and insets still visible. The floor must stay the dark
// simulation color outside an active Align or sticker-scan cover, and any
// Align/scan overlay must clear on abort or exception (finally-style).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  STAGE_BACKGROUND, isSafeStageBackground, isForbiddenStageFill, stageFillStyle, projectorFrame, isUniformForbiddenWash
} from '../neural-dance/src/projector-hold.js';
import {cancelAlign, scanStickersNow} from '../neural-dance/live-show.js';

test('the locked floor is dark, and calibration / salmon / flash fills are rejected', () => {
  assert.equal(isSafeStageBackground(STAGE_BACKGROUND), true);
  assert.equal(isSafeStageBackground('#080910'), true);
  assert.equal(isSafeStageBackground('rgb(8, 9, 16)'), true);
  assert.equal(isSafeStageBackground('#ffffff'), false);
  assert.equal(isSafeStageBackground('#000000'), false);
  assert.equal(isSafeStageBackground('#a8a8a8'), false);
  assert.equal(isSafeStageBackground('#ff2a2a'), false);
  assert.equal(isSafeStageBackground('#00e5a8'), false);
  assert.equal(isSafeStageBackground('#2f6bff'), false);
  assert.equal(isSafeStageBackground('#ffe14a'), false);
  assert.equal(isSafeStageBackground('#ff927d'), false);
  assert.equal(isSafeStageBackground('#ff6b6b'), false);
  assert.equal(isSafeStageBackground('#FF9A85'), false);
  assert.equal(isForbiddenStageFill('#FF9A85'), true);
  assert.equal(isForbiddenStageFill('#ff927d'), true);
  assert.equal(isForbiddenStageFill('#ffffff'), true);
  assert.equal(isForbiddenStageFill('#000'), true);
  assert.equal(isForbiddenStageFill('#080910'), false);
  assert.equal(stageFillStyle('#ff927d'), STAGE_BACKGROUND);
  assert.equal(stageFillStyle('rgb(255, 154, 133)'), STAGE_BACKGROUND);
  assert.equal(stageFillStyle('rgb(8, 9, 16)'), 'rgb(8, 9, 16)');
  assert.equal(projectorFrame({aligning: false, flash: '', scan: '', pattern: false}), 'simulation');
});

function classList(set) {
  return {
    contains: c => set.has(c),
    add: c => set.add(c),
    remove: c => set.delete(c)
  };
}

function mockDoc(flags = {}) {
  const bodySet = new Set(flags.body || []);
  const roomDs = Object.assign({
    ndAlignOwn: flags.aligning ? '1' : undefined,
    ndAlignFlash: flags.flash || undefined,
    ndAlignFlashAlpha: flags.alpha || undefined,
    stagePattern: flags.pattern ? '1' : undefined,
    ndStickerScan: flags.scan ? '1' : undefined,
    ndScanFlash: flags.scan ? '1' : undefined
  }, flags.roomDs || {});
  const flash = {
    hidden: flags.flashHidden !== false,
    dataset: {mode: flags.flash || ''},
    style: {opacity: flags.opacity || ''},
    removeAttribute(k) { if (k === 'data-mode') this.dataset.mode = ''; }
  };
  const pattern = {hidden: flags.patternHidden !== false};
  const refine = {style: {display: flags.refineDisplay || 'none'}};
  const room = {dataset: roomDs, neuralDance: {redraw() { room.redraws = (room.redraws || 0) + 1; }, micState() { return 'off'; }}};
  const nodes = {
    '[data-align-flash]': flash,
    '[data-cal-pattern]': pattern,
    '[data-align-refine]': refine,
    '[data-align-cancel-zone]': {hidden: true},
    '[data-live="exit-align"]': {hidden: true},
    '[data-cancel-align]': {hidden: true},
    '[data-align-readout]': {hidden: true},
    '[data-place-corners]': {hidden: true},
    '[data-align-progress]': {hidden: true},
    '#nd-room-lab [data-status]': {textContent: ''},
    '#nd-room-lab [data-action="align"]': {textContent: 'Align projector', setAttribute() {}, getAttribute() { return 'false'; }},
    '#nd-camera-mode': {neuralDanceCamera: null}
  };
  const doc = {
    body: {classList: classList(bodySet), dataset: {}},
    querySelector: sel => nodes[sel] || null,
    getElementById: id => id === 'nd-room-lab' ? room : id === 'nd-camera-mode' ? nodes['#nd-camera-mode'] : null,
    flash, pattern, refine, room, bodySet
  };
  return doc;
}

test('cancelAlign hides the flash and pattern and clears leftover dataset flags', () => {
  const doc = mockDoc({
    body: ['nd-live-aligning', 'nd-align-clean'],
    aligning: true,
    flash: 'white',
    flashHidden: false,
    opacity: '1',
    pattern: true,
    patternHidden: false,
    alpha: '0.6',
    scan: true,
    refineDisplay: 'block'
  });
  cancelAlign(doc);
  assert.equal(doc.bodySet.has('nd-live-aligning'), false);
  assert.equal(doc.flash.hidden, true);
  assert.equal(doc.flash.style.opacity, '');
  assert.equal(doc.flash.dataset.mode, '');
  assert.equal(doc.pattern.hidden, true);
  assert.equal(doc.refine.style.display, 'none');
  assert.equal(doc.room.dataset.ndAlignFlash, undefined);
  assert.equal(doc.room.dataset.ndAlignFlashAlpha, undefined);
  assert.equal(doc.room.dataset.stagePattern, undefined);
  assert.equal(doc.room.dataset.ndStickerScan, undefined);
  assert.equal(doc.room.dataset.ndScanFlash, undefined);
});

function attachCam(doc, cam) {
  doc.getElementById = id => {
    if (id === 'nd-room-lab') return doc.room;
    if (id === 'nd-camera-mode') return {neuralDanceCamera: cam};
    return null;
  };
}

function assertOverlayClear(doc) {
  assert.equal(doc.flash.hidden, true);
  assert.equal(doc.flash.style.opacity, '');
  assert.equal(doc.room.dataset.ndStickerScan, undefined);
  assert.equal(doc.room.dataset.ndAlignFlash, undefined);
  assert.equal(doc.room.dataset.ndAlignFlashAlpha, undefined);
  assert.equal(doc.room.dataset.ndScanFlash, undefined);
}

test('scanStickersNow clears the white overlay in finally when the scan throws', async () => {
  const doc = mockDoc({body: []});
  const cam = {
    grabFrame: () => ({data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2}),
    scanWhiteFrame: () => { throw new Error('scan boom'); },
    ensureCamera: async () => {},
    setStickerFlashReport() {},
    personInView: () => false
  };
  attachCam(doc, cam);
  await assert.rejects(() => scanStickersNow(doc));
  assertOverlayClear(doc);
});

test('scanStickersNow still clears the overlay if a redraw throws mid-fade', async () => {
  const doc = mockDoc({body: []});
  let calls = 0;
  doc.room.neuralDance.redraw = () => {
    calls++;
    if (calls <= 2) throw new Error('redraw boom');
  };
  const cam = {
    grabFrame: () => ({data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2}),
    scanWhiteFrame: () => ({ok: true, count: 1}),
    ensureCamera: async () => {},
    setStickerFlashReport() {},
    personInView: () => false
  };
  attachCam(doc, cam);
  await scanStickersNow(doc).catch(() => {});
  assertOverlayClear(doc);
});

test('room-lab fills the stage with the locked dark color and hides stray covers in simulation', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /stageFillStyle\(background\)/);
  assert.match(room, /STAGE_BACKGROUND/);
  assert.match(room, /layer==='simulation'/);
  assert.match(room, /flash.hidden=true/);
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /delete owned.dataset.ndAlignFlashAlpha/);
  assert.match(show, /never leave the floor covered/);
});

function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3];
  }
  return {data, width: w, height: h};
}

test('a uniform salmon ripple field is a stuck wash; a sparse ring is not', () => {
  assert.equal(isUniformForbiddenWash(image(20, 12, [255, 154, 133, 255])), true);
  assert.equal(isUniformForbiddenWash(image(20, 12, [255, 146, 125, 230])), true);
  assert.equal(isUniformForbiddenWash(image(20, 12, [8, 9, 16, 255])), false);
  const ring = image(20, 12, [0, 0, 0, 0]);
  // A few kick-colored ring pixels, most transparent.
  for (let x = 4; x < 8; x++) {
    const i = (6 * 20 + x) * 4;
    ring.data[i] = 255; ring.data[i + 1] = 107; ring.data[i + 2] = 107; ring.data[i + 3] = 200;
  }
  assert.equal(isUniformForbiddenWash(ring), false);
});

test('room-lab locks --background and drops a washed ripple overlay', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(room, /setProperty\('--background',STAGE_BACKGROUND\)/);
  assert.match(room, /isUniformForbiddenWash/);
  assert.match(room, /waterRipple\.clear\(\)/);
});
