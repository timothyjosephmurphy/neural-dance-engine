// Live projection: no circle markers or number labels around stickers in
// silhouette mode (TJ, Nov 9 4:14 PM). Detection/latching unchanged; debug
// overlays keep their own markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');

test('silhouette mode skips projected rings and beat numbers on the live stage', () => {
  assert.match(room, /TJ 4:14 PM: on the live projection, no circle markers/);
  assert.match(room, /const silMode=silhouetteShow\.mode\(\)==='silhouette'/);
  assert.match(room, /if\(!silMode\)\{/);
  // Numbers and rings only inside the !silMode block.
  const chromeStart = room.indexOf('if(!silMode){');
  const chromeEnd = room.indexOf('ctx.globalAlpha=1;', chromeStart);
  const chrome = room.slice(chromeStart, chromeEnd);
  assert.match(chrome, /beatClock\.label/);
  assert.match(chrome, /ctx\.arc\(p\.x,p\.y,radius/);
  assert.match(chrome, /rings\.stroke/);
  // After the chrome gate, silhouette paint must not draw sticker dots.
  assert.match(room, /paintDots:list=>paintStageMarkers\(ctx,\(list\|\|\[\]\)\.filter\(m=>m&&m\.kind==='pink'\)/);
});

test('debug viewer still paints marker overlays for diagnosis', () => {
  assert.match(viewer, /function drawOverlay/);
  assert.match(viewer, /paintProjectedStage/);
  assert.match(viewer, /stageMarkPlan/);
});
