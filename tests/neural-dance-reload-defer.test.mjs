// TJ 9:08 PM "Align works sometimes then crashes": a deploy must not reload
// the live page in the middle of Align, a sticker scan or the pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLiveVersion, liveBusy, resetLiveBusy, LIVE_BUSY_HOLD_MS} from '../neural-dance/live-reload.js';

function memory() { const m = new Map(); return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; }
function makeDoc(classes, roomDs = {}) {
  const calls = [];
  const set = new Set(classes);
  return {calls, set, roomDs, doc: {
    body: {dataset: {}, classList: {contains: c => set.has(c)}},
    querySelector(sel) { return sel === 'meta[name="nd-build"]' ? {getAttribute() { return 'aaaa1111'; }} : null; },
    getElementById(id) { return id === 'nd-room-lab' ? {dataset: roomDs, neuralDance: {micState() { return 'listening'; }, saveSettings() {}}} : null; },
    dispatchEvent() {},
    defaultView: {localStorage: memory(), location: {reload() { calls.push('reload'); }}, performance: {now: () => 1000}}
  }};
}
const fetchImpl = async () => ({ok: true, json: async () => ({version: 'bbbb2222'})});

test('no reload while aligning; it goes through after the hold', async () => {
  resetLiveBusy();
  const d = makeDoc(['nd-live-aligning'], {ndAlignOwn: '1'});
  assert.equal(await checkLiveVersion(d.doc, fetchImpl, memory()), false);
  assert.deepEqual(d.calls, []);
  d.set.clear(); d.roomDs.ndAlignOwn = '';
  assert.equal(liveBusy(d.doc), true, 'still held right after Align');
  assert.equal(liveBusy(d.doc, Date.now() + LIVE_BUSY_HOLD_MS + 10), false);
  resetLiveBusy();
  assert.equal(await checkLiveVersion(d.doc, fetchImpl, memory()), true);
  assert.deepEqual(d.calls, ['reload']);
});

test('no reload during a sticker scan or the alignment pattern', async () => {
  resetLiveBusy();
  const scan = makeDoc([], {ndScanUntil: '5000'});
  assert.equal(await checkLiveVersion(scan.doc, fetchImpl, memory()), false);
  resetLiveBusy();
  const pat = makeDoc([], {stagePattern: '1'});
  assert.equal(await checkLiveVersion(pat.doc, fetchImpl, memory()), false);
  assert.deepEqual(scan.calls.concat(pat.calls), []);
  resetLiveBusy();
});
