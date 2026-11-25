// Debug "Scan stickers" (TJ, Nov 9 3:51 PM / 4:38 PM): fade up ~300 ms, hold
// until exposure settles, one frame, latch, fade down ~300 ms. Never latch on
// the ramps; a person in frame defers or aborts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FLASH_FADE_MS, FLASH_MAX_MS, FLASH_MIN_MS, fadeFlash, runStickerFlash, settleExposure, stickerScanSummary} from '../neural-dance/src/sticker-flash.js';
import {projectorFrame} from '../neural-dance/src/projector-hold.js';
import {sanitizeDebugPatch} from '../neural-dance/debug-protocol.js';
import {SHOW_CONTROLS} from '../neural-dance/src/show-commands.js';

function lumFrame(v) {
  const W = 32;
  const H = 24;
  const data = new Uint8ClampedArray(W * H * 4).fill(v);
  return {data, width: W, height: H};
}
// Auto-exposure ramp: dark to white over rampMs, then steady.
function camera(rampMs, clock) {
  return () => lumFrame(Math.round(60 + 170 * Math.min(1, clock.t / rampMs)));
}
function io(over = {}) {
  const clock = {t: 0};
  const shown = [];
  const reports = [];
  const base = {
    clock, shown, reports,
    show: (on) => shown.push(on === true ? 1 : on === false ? 0 : +on),
    wait: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    grab: camera(900, clock),
    personInView: () => false,
    scan: () => ({ok: true, count: 3}),
    report: (r) => reports.push(r)
  };
  return Object.assign(base, over);
}

test('fade ramp reaches full white in ~120 ms and never jumps', async () => {
  assert.equal(FLASH_FADE_MS, 120);
  const t = io();
  await fadeFlash(t, 0, 1, FLASH_FADE_MS);
  assert.ok(t.shown[0] === 0);
  assert.equal(t.shown[t.shown.length - 1], 1);
  assert.ok(t.shown.length >= 3, 'ramp has intermediate steps');
  for (let i = 1; i < t.shown.length; i++) assert.ok(t.shown[i] + 1e-9 >= t.shown[i - 1]);
});

test('exposure settle waits for the ramp, not a fixed delay', async () => {
  const fast = io({grab: undefined});
  fast.grab = camera(200, fast.clock);
  const a = await settleExposure(fast);
  assert.equal(a.settled, true);
  assert.ok(a.settleMs >= FLASH_MIN_MS && a.settleMs < 1000, 'fast camera ' + a.settleMs);
  const slow = io();
  slow.grab = camera(1300, slow.clock);
  const b = await settleExposure(slow);
  assert.equal(b.settled, true);
  assert.ok(b.settleMs >= 1300 && b.settleMs <= FLASH_MAX_MS, 'slow camera ' + b.settleMs);
  const never = io();
  let flip = 0;
  never.grab = () => lumFrame((flip++ % 2) ? 120 : 220);
  const c = await settleExposure(never);
  assert.equal(c.settled, false);
  assert.ok(c.settleMs >= FLASH_MAX_MS);
});

test('a scan fades in, holds white, latches once, fades out — never scans on the ramps', async () => {
  const t = io();
  let scanned = null;
  let scanAt = null;
  t.scan = (frame) => {
    scanned = frame;
    scanAt = t.clock.t;
    // The settled frame was grabbed at full white. The diff runs after fade-out.
    assert.equal(t.shown[t.shown.length - 1], 0);
    assert.ok(t.shown.includes(1));
    return {ok: true, count: 3};
  };
  const out = await runStickerFlash(t);
  assert.equal(out.state, 'done');
  assert.equal(out.count, 3);
  assert.equal(t.shown[0], 0);
  assert.equal(t.shown[t.shown.length - 1], 0);
  assert.ok(t.shown.includes(1), 'reached full white');
  assert.ok(scanned && scanned.data[0] >= 225, 'scanned the settled white frame');
  assert.ok(scanAt != null && scanAt >= FLASH_FADE_MS, 'capture after fade-in');
  const states = t.reports.map(r => r.state);
  assert.ok(states.includes('fading-in'));
  assert.ok(states.includes('flashing'));
  assert.ok(states.includes('done'));
  assert.match(stickerScanSummary(out), /^Scan stickers: 3 stickers latched \(exposure settled in \d+ ms\)$/);
});

test('someone in frame defers the scan before any flash', async () => {
  const t = io({personInView: () => true});
  let scans = 0;
  t.scan = () => { scans++; return {ok: true, count: 1}; };
  const out = await runStickerFlash(t);
  assert.equal(out.state, 'deferred');
  assert.match(out.reason, /in frame/);
  assert.deepEqual(t.shown, []);
  assert.equal(scans, 0);
});

test('someone stepping in during the hold aborts without latching and fades out', async () => {
  const t = io();
  let calls = 0;
  t.personInView = () => calls++ > 0;
  let scans = 0;
  t.scan = () => { scans++; return {ok: true, count: 1}; };
  const out = await runStickerFlash(t);
  assert.equal(out.state, 'aborted');
  assert.equal(scans, 0);
  assert.equal(t.shown[0], 0);
  assert.equal(t.shown[t.shown.length - 1], 0);
});

test('a failed scan or a thrown error still fades the white off', async () => {
  const t = io({scan: () => ({ok: false, reason: 'The camera did not see a white screen.'})});
  const out = await runStickerFlash(t);
  assert.equal(out.state, 'failed');
  assert.equal(t.shown[t.shown.length - 1], 0);
  const boom = io({scan: () => { throw new Error('boom'); }});
  await assert.rejects(runStickerFlash(boom));
  assert.equal(boom.shown[boom.shown.length - 1], 0);
});

test('the debug page has a Scan stickers button wired to the phone', () => {
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(page, /data-debug-action="scan-stickers">Scan stickers</);
  assert.match(page, /data-debug-sticker-flash/);
  assert.ok(SHOW_CONTROLS.some(c => c.id === 'scan-stickers'));
  const live = readFileSync(new URL('../neural-dance/live-debug.js', import.meta.url), 'utf8');
  assert.match(live, /action === 'scan-stickers'\) \{ scanStickersNow\(doc, \{fromDebug: true\}\)/);
  assert.equal(sanitizeDebugPatch({action: 'scan-stickers'}).action, 'scan-stickers');
});


test('Scan stickers white flash paints on the canvas even when Align is not running', () => {
  assert.equal(projectorFrame({aligning: false, flash: 'white'}), 'white');
  assert.equal(projectorFrame({aligning: false, flash: 'black'}), 'black');
  assert.equal(projectorFrame({aligning: true, flash: 'white'}), 'white');
  assert.equal(projectorFrame({aligning: true, flash: ''}), 'pattern');
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(show, /Camera is not ready/);
  assert.match(show, /Scan stickers is already running/);
  assert.match(show, /redrawStage\(doc\)/);
  assert.match(show, /ndStickerScan/);
  assert.match(show, /FLASH_FADE_MS|ndAlignFlashAlpha|style\.opacity/);
});

test('debug page dropped Lock/Unlock/Latency/Scan-mode/Download-training; Scan stickers stays', () => {
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /data-debug-action="lock-quad"/);
  assert.doesNotMatch(page, /data-debug-action="unlock-quad"/);
  assert.doesNotMatch(page, /data-debug-action="latency-test"/);
  assert.doesNotMatch(page, /data-debug-scan/);
  assert.doesNotMatch(page, /data-debug-training/);
  assert.match(page, /data-debug-action="scan-stickers">Scan stickers</);
  assert.match(page, /data-debug-sticker-flash/);
});
