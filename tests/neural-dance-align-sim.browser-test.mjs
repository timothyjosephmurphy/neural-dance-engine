// Align in a simulated iPhone camera (exposure lag, mirroring latency, blur,
// noise, rolling-shutter tears), WebKit + Chromium: capture must succeed and
// the sticker check must pull a wrong quad onto the stickers.
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {startServer, runTrials, summarize} from './align-capture-sim.mjs';
import {runVerifyTrials, summarizeVerify} from './align-verify-sim.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const {server, origin} = await startServer(root, null);
try {
  for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
    // Slow mirroring / slow auto-exposure (harsh 2): the case that failed before.
    const cap = summarize((await runTrials({browserType: type, origin, seeds: [1, 2, 3, 4, 5, 6, 7, 8], harsh: 2})).results);
    console.log('align capture', name, JSON.stringify(cap));
    assert.ok(cap.success >= 7, name + ' capture ' + JSON.stringify(cap));
    assert.ok(cap.wrongQuad <= 1, name + ' wrong quad ' + JSON.stringify(cap));
    assert.ok(cap.maxMs < 20000, name + ' align time');
    const ver = summarizeVerify((await runVerifyTrials({browserType: type, origin, seeds: [1, 2, 3, 4]})).results);
    console.log('sticker check', name, JSON.stringify(ver));
    assert.equal(ver.crashed, 0);
    assert.ok(ver.medianTruthAfterPx < 3 && ver.medianTruthAfterPx < ver.medianTruthBeforePx / 3, name + ' verify ' + JSON.stringify(ver));
  }
  console.log('ok align sim');
} finally {
  server.close();
}
