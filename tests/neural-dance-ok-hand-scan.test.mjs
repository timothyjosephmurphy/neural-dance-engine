// OK-hand → Scan stickers (TJ 5:08–5:28 PM).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {
  OK_HAND_HOLD_MS,
  OK_HAND_CLEAR_MS,
  OK_HAND_COOLDOWN_MS,
  scoreOkHand,
  createOkHandWatcher,
  paintSyntheticOkHand
} from '../neural-dance/src/ok-hand-scan.js';

const FIXTURES = process.env.ND_OK_HAND_FIXTURES || '';

function loadJpeg(path) {
  const out = execFileSync('python3', ['-c', `
from PIL import Image
import struct, sys
im = Image.open(sys.argv[1]).convert('RGBA')
sys.stdout.buffer.write(struct.pack('<II', im.width, im.height))
sys.stdout.buffer.write(im.tobytes())
`, path], {maxBuffer: 20 * 1024 * 1024});
  const w = out.readUInt32LE(0);
  const h = out.readUInt32LE(4);
  return {width: w, height: h, data: new Uint8ClampedArray(out.buffer, out.byteOffset + 8, w * h * 4)};
}

function listFixtures(prefix) {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES)
    .filter(f => f.startsWith(prefix) && f.endsWith('.jpg'))
    .sort();
}

test('synthetic OK hand scores for either mirror; no-hole and far miss', () => {
  const left = paintSyntheticOkHand(200, 150, {mirror: false, fill: 0.55});
  const right = paintSyntheticOkHand(200, 150, {mirror: true, fill: 0.55});
  assert.equal(scoreOkHand(left, 200, 150).ok, true);
  assert.equal(scoreOkHand(right, 200, 150).ok, true);
  assert.equal(scoreOkHand(paintSyntheticOkHand(200, 150, {hole: false, fill: 0.55}), 200, 150).ok, false);
  const far = scoreOkHand(paintSyntheticOkHand(200, 150, {fill: 0.1}), 200, 150);
  assert.equal(far.ok, false);
  assert.match(far.reason, /too-far|blob-too-small|no-ring/);
});

test('watcher holds ~0.9s, fires only after clear, then cools down', () => {
  const watcher = createOkHandWatcher();
  const ok = paintSyntheticOkHand(200, 150, {fill: 0.55});
  const clear = paintSyntheticOkHand(200, 150, {fill: 0.08, hole: false});
  let t = 0;
  let fired = 0;
  for (; t < OK_HAND_HOLD_MS - 100; t += 50) {
    const st = watcher.observe(ok, 200, 150, t);
    assert.equal(st.phase, 'holding');
    assert.equal(watcher.consumeFire(), false);
  }
  for (; t < OK_HAND_HOLD_MS + 80; t += 40) watcher.observe(ok, 200, 150, t);
  assert.equal(watcher.status(t).phase, 'awaitingClear');
  assert.equal(watcher.status(t).blocking, true);
  // Still holding the hand → no fire.
  watcher.observe(ok, 200, 150, t + 200);
  assert.equal(watcher.consumeFire(), false);
  // Lower the hand for clearMs.
  t = OK_HAND_HOLD_MS + 200;
  for (; t < OK_HAND_HOLD_MS + 200 + OK_HAND_CLEAR_MS + 120; t += 40) {
    watcher.observe(clear, 200, 150, t);
    if (watcher.consumeFire()) fired += 1;
  }
  assert.equal(fired, 1, 'fires once after clear');
  assert.equal(watcher.status(t).phase, 'cooldown');
  // Cooldown blocks another fire.
  for (let i = 0; i < 10; i++) {
    t += 50;
    watcher.observe(ok, 200, 150, t);
    assert.equal(watcher.consumeFire(), false);
  }
  assert.ok(watcher.status(t).coolLeft > 0);
  // After cooldown, can hold again.
  t += OK_HAND_COOLDOWN_MS + 10;
  const again = watcher.observe(ok, 200, 150, t);
  assert.equal(again.phase, 'holding');
});

test('fixture close-ups (okay / other-hand) detect; stage negatives do not', () => {
  const okay = listFixtures('okay-').filter(f => !f.startsWith('okay-burst'));
  const burst = listFixtures('okay-burst-');
  const other = listFixtures('other-hand-');
  const stage = listFixtures('stage-');
  assert.ok(okay.length >= 8, 'okay fixtures present');
  assert.ok(burst.length >= 20, 'burst fixtures present');
  assert.ok(other.length >= 20, 'other-hand fixtures present');
  assert.ok(stage.length >= 8, 'stage negatives present');

  const rate = (files) => {
    let hit = 0;
    for (const f of files) {
      const frame = loadJpeg(join(FIXTURES, f));
      if (scoreOkHand(frame.data, frame.width, frame.height).ok) hit += 1;
    }
    return hit / files.length;
  };

  // Mid-burst frames are the held pose; skip the first few settling frames.
  const burstHeld = burst.slice(4);
  assert.ok(rate(okay) >= 0.7, 'okay close-ups mostly hit');
  assert.ok(rate(burstHeld) >= 0.7, 'burst held frames mostly hit');
  assert.ok(rate(other) >= 0.65, 'either hand hits');
  assert.equal(rate(stage), 0, 'stage / distant dancers never trigger');
});

test('wiring: camera watches OK hand, live-show scans fromDebug, debug panel shows status', () => {
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(cam, /createOkHandWatcher/);
  assert.match(cam, /nd-ok-hand-scan/);
  assert.match(cam, /takeOkHandScanRequest/);
  assert.match(cam, /okHand:/);
  assert.match(live, /nd-ok-hand-scan/);
  assert.match(live, /scanStickersNow\(doc,\s*\{\s*fromDebug:\s*true\s*\}\)/);
  assert.match(debug, /data-debug-ok-hand/);
  assert.match(page, /data-debug-ok-hand/);
  // Status stays off the projector toast path.
  assert.match(live, /fromDebug:\s*true/);
});
