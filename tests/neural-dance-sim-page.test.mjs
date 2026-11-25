// Sound-responsive side-sim page at /neural-dance/sim/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(root, 'static/neural-dance/sim/index.html'), 'utf8');
const roomLab = readFileSync(join(root, 'neural-dance/room-lab.js'), 'utf8');

test('sim page is noindex, secret-free, and imports the hosted band-onsets module', () => {
  assert.match(page, /<meta name="robots" content="noindex"/);
  assert.match(page, /id="listenBtn"/);
  assert.match(page, /getUserMedia/);
  assert.match(page, /\/neural-dance\/src\/band-onsets\.js/);
  const hosted = page.indexOf("new URL('/neural-dance/src/band-onsets.js'");
  const relative = page.indexOf("new URL('../src/band-onsets.js'");
  assert.ok(hosted >= 0 && relative >= 0 && hosted < relative, 'hosted band-onsets path should be tried first');
  assert.doesNotMatch(page, /debug[-_]?key/i);
  assert.doesNotMatch(page, /ND_DEBUG/);
  assert.doesNotMatch(page, /api\/neural-dance\/debug/);
  assert.doesNotMatch(page, /roomId|room-id|room_id/);
});

test('sim controls sit beside or below the canvas, never overlaid, and can hide', () => {
  assert.match(page, /id="toggleControls"/);
  assert.match(page, /Hide controls/);
  assert.match(page, /Show controls/);
  assert.match(page, /class="app"/);
  assert.match(page, /controls-hidden/);
  // The panel is in normal document flow, not absolutely positioned over the canvas.
  assert.match(page, /\.panel\s*\{[^}]*position:\s*relative/);
  assert.doesNotMatch(page, /\.panel\s*\{[^}]*position:\s*absolute/);
  assert.match(page, /flex-direction:\s*column/);
  assert.match(page, /flex:\s*0 0 320px/);
  assert.match(page, /orientation:\s*landscape/);
  assert.match(page, /devicePixelRatio/);
  assert.match(page, /orientationchange/);
  assert.match(page, /function fitCanvas/);
});

test('sim Listen uses the live show mic constraints, analyser range, AGC, and mic-top High band', () => {
  assert.match(roomLab, /getUserMedia\(\{audio:\{echoCancellation:false,noiseSuppression:false,autoGainControl:false\}\}\)/);
  assert.match(page, /echoCancellation:\s*false/);
  assert.match(page, /noiseSuppression:\s*false/);
  assert.match(page, /autoGainControl:\s*false/);
  assert.match(page, /OverconstrainedError/);
  assert.match(page, /getUserMedia\(\{ audio: true/);
  assert.match(page, /minDecibels = -96/);
  assert.match(page, /maxDecibels = -24/);
  assert.match(page, /smoothingTimeConstant = 0/);
  assert.match(page, /silence-gate\.js/);
  assert.match(page, /ndSilenceGate/);
  assert.match(page, /meterBandsHz/);
  assert.match(page, /trackMicTopHz/);
  assert.match(page, /hatBandHz/);
  assert.match(page, /function paintDancerMeters/);
  assert.match(page, /ctx\.resume\(\)/);
});

test('sim page shows 3D twist, turns, volume, and figure-8 depth/vertical sliders', () => {
  assert.match(page, /id="hipTwist"/);
  assert.match(page, /id="shoulderTwist"/);
  assert.match(page, /id="maxBodyTurn"/);
  assert.match(page, /id="turnFreq"/);
  assert.match(page, /id="eightDepth"/);
  assert.match(page, /id="eightVert"/);
  assert.match(page, /id="shoulderEight"/);
  assert.match(page, /function torsoStations/);
  assert.match(page, /function shadeTorsoAndHead/);
  assert.match(page, /body-shell\.js/);
  assert.match(page, /pad-arms\.js/);
  assert.match(page, /melody-pad\.js/);
  assert.match(page, /function rotateFacing/);
  assert.match(page, /id="armPadSense"/);
  assert.match(page, /fig8z/);
  assert.match(page, /STANCE_HIP_REST|hip-width|1\.00 \* hip/);
});
