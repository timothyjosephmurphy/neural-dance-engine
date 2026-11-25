// Nov 9, 3:38 / 3:44 PM rig (build f4df3f5): the debug view's pink quad
// corners sat well outside the four green align circles. Geometry below is
// the live telemetry at those moments (camera 0-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CALIBRATION_MARKERS, CANVAS_H, CANVAS_W, applyHomography, cornersFromMarkerCenters, homographyFromNormalized} from '../neural-dance/camera-markers.js';
import {anchorsFromCorners, cornersFromAnchors, snapAnchor, stickerInPlay} from '../neural-dance/src/align-anchors.js';
import {overlayHandles, pickCornerHandle, projectedStageQuad} from '../neural-dance/debug-viewer.js';

const RIG = {
  '1538': {
    oldQuad: [{x: 0.09431621319374274, y: 0.36535473357796333}, {x: 0.9417574930160661, y: 0.3631031894108768}, {x: 0.9198054514433542, y: 0.7963967173112507}, {x: 0.09787208508309705, y: 0.7807227950741472}],
    marks: [{x: 0.2086350182149362, y: 0.4250480671928759}, {x: 0.8160167378917379, y: 0.425329415954416}, {x: 0.8029758528695068, y: 0.7353923339775369}, {x: 0.20880731560516522, y: 0.7258234843510614}],
    spurious: {x: 78.53878106415812, y: 129.33576214237272}
  },
  '1544': {
    oldQuad: [{x: 0.09571313877344723, y: 0.36544347487754764}, {x: 0.9387588801578692, y: 0.3649153859702345}, {x: 0.9208817872053121, y: 0.7985359497395039}, {x: 0.09896797827982365, y: 0.7796734093948038}],
    marks: [{x: 0.20913640245127585, y: 0.4249740472841739}, {x: 0.8137934320333814, y: 0.42663363291071527}, {x: 0.8032253649635036, y: 0.7367835901595026}, {x: 0.20951388888888886, y: 0.7250767195767196}]
  }
};
const near = (a, b, tol, label) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= tol, `${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const px = (corners) => corners.map(p => ({x: p.x * 1000, y: p.y * 1000}));

test('align marker constants match where the Align pattern draws the circles (18% / 82%)', () => {
  const room = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.deepEqual(CALIBRATION_MARKERS.map(m => [m.x, m.y]), [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82]]);
  for (const [x, y] of [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82]]) assert.ok(room.includes(`{x: ${x}, y: ${y},`), `room-lab pattern mark ${x},${y}`);
  for (const [cal, l, t] of [['red', 18, 18], ['green', 82, 18], ['blue', 82, 82], ['yellow', 18, 82]]) {
    assert.match(page, new RegExp(`\\[data-cal="${cal}"\\]\\{[^}]*left:${l}%;top:${t}%`));
  }
});

for (const [name, rig] of Object.entries(RIG)) {
  test(`rig ${name}: the old quad came from 14%/86% constants (root cause)`, () => {
    const m14 = [{x: 0.14, y: 0.14}, {x: 0.86, y: 0.14}, {x: 0.86, y: 0.86}, {x: 0.14, y: 0.86}];
    const old = cornersFromMarkerCenters(px(rig.marks), 1000, 1000, m14);
    old.forEach((c, i) => near(c, rig.oldQuad[i], 0.003, 'old corner ' + (i + 1)));
  });
  test(`rig ${name}: after Align the pink handles land exactly on the green circles`, () => {
    const quad = cornersFromMarkerCenters(px(rig.marks), 1000, 1000);
    assert.ok(quad, 'markers give a quad');
    const handles = overlayHandles({quad}, null);
    handles.forEach((h, i) => near(h, rig.marks[i], 1e-6, 'handle ' + (i + 1)));
    // And the circles map to their stage positions.
    const H = homographyFromNormalized(quad, 1, 1);
    rig.marks.forEach((m, i) => near(applyHomography(H, m.x, m.y), {x: CALIBRATION_MARKERS[i].x * CANVAS_W, y: CALIBRATION_MARKERS[i].y * CANVAS_H}, 1e-6, 'stage ' + (i + 1)));
    // Round trip through the draft the debug page sends.
    cornersFromAnchors(rig.marks).forEach((c, i) => near(c, quad[i], 1e-9, 'round trip ' + (i + 1)));
  });
}

test('rig 1538: corrected map puts the projected grid rings where the camera sees them', () => {
  // Camera pixels (480x360) of the outer ring's left/right and top/bottom crossings.
  const quad = cornersFromMarkerCenters(px(RIG['1538'].marks), 1000, 1000);
  const H = homographyFromNormalized(quad, 1, 1);
  const seen = [[104, 209, 0.1875, 0.5], [386, 209, 0.8125, 0.5], [242, 156, 0.5, 0.193], [242, 262, 0.5, 0.807]];
  for (const [cx, cy, sx, sy] of seen) {
    const at = applyHomography(H, cx / 480, cy / 360);
    assert.ok(Math.abs(at.x / CANVAS_W - sx) < 0.015 && Math.abs(at.y / CANVAS_H - sy) < 0.015, `ring ${cx},${cy} -> ${at.x.toFixed(0)},${at.y.toFixed(0)}`);
  }
});

test('a dragged handle near a green circle snaps onto its center; far away it stays put', () => {
  const marks = RIG['1544'].marks;
  assert.deepEqual(snapAnchor({x: marks[1].x + 0.03, y: marks[1].y - 0.02}, 1, marks), {x: marks[1].x, y: marks[1].y, snapped: 1});
  assert.equal(snapAnchor({x: marks[0].x + 0.02, y: marks[0].y}, 3, marks).snapped, 0);
  assert.deepEqual(snapAnchor({x: 0.5, y: 0.5}, 0, marks), {x: 0.5, y: 0.5});
});

test('rig 1538: the green glow under the projected Controls chip is not a sticker; real stickers are', () => {
  const rig = RIG['1538'];
  const quad = cornersFromMarkerCenters(px(rig.marks), 1000, 1000);
  const H = homographyFromNormalized(quad, 1, 1);
  // Camera spot of the glow (76,163 of 480x360) and of the two real stickers.
  const glow = applyHomography(H, 76 / 480, 163 / 360);
  // Controls chip in the camera (47..92, 127..147) mapped to stage, as uiExclusions pads it (60).
  const tl = applyHomography(H, 47 / 480, 127 / 360);
  const br = applyHomography(H, 92 / 480, 147 / 360);
  const ui = [{x: tl.x - 60, y: tl.y - 60, w: br.x - tl.x + 120, h: br.y - tl.y + 120}];
  assert.equal(stickerInPlay(glow.x, glow.y, ui), false, 'glow under Controls');
  assert.equal(stickerInPlay(glow.x, glow.y, []), false, 'glow is outside the circle-bounded floor even without the UI rect');
  // The tjm.art pill (camera 228..255, 116) is above the stage.
  const pill = applyHomography(H, 240 / 480, 116 / 360);
  assert.equal(stickerInPlay(pill.x, pill.y, ui), false, 'tjm.art pill');
  for (const s of [{x: 373.75, y: 293.6}, {x: 567.73, y: 293.28}]) assert.equal(stickerInPlay(s.x, s.y, ui), true, 'real sticker ' + s.x);
});

test('a blown-up homography through nearly flat anchors stays on the anchor box', () => {
  const flat = [
    {x: 0.30, y: 0.50},
    {x: 0.70, y: 0.501},
    {x: 0.70, y: 0.52},
    {x: 0.30, y: 0.519}
  ];
  const corners = cornersFromAnchors(flat);
  assert.ok(corners, 'affine fallback still returns a quad');
  const ys = flat.map(p => p.y);
  const y0 = Math.min(...ys), y1 = Math.max(...ys), span = y1 - y0;
  for (const c of corners) {
    assert.ok(c.y > y0 - span * 0.7 && c.y < y1 + span * 0.7, 'corner stayed near the circles: ' + c.y);
  }
});

test('corners mode shows the accepted frame when the stored quad jumps above it', () => {
  const frame = [{x: 0.2, y: 0.35}, {x: 0.8, y: 0.34}, {x: 0.82, y: 0.72}, {x: 0.18, y: 0.74}];
  const wild = [{x: 0.05, y: 0.02}, {x: 0.95, y: 0.01}, {x: 0.9, y: 0.8}, {x: 0.08, y: 0.82}];
  const shown = projectedStageQuad({quad: wild, painting: {frameQuad: frame}});
  shown.forEach((p, i) => near(p, frame[i], 1e-9, 'frame corner ' + (i + 1)));
  const calm = [{x: 0.22, y: 0.36}, {x: 0.78, y: 0.35}, {x: 0.8, y: 0.7}, {x: 0.2, y: 0.72}];
  overlayHandles({quad: calm, painting: {frameQuad: frame}}, null, {corners: true})
    .forEach((p, i) => near(p, calm[i], 1e-9, 'kept corner ' + (i + 1)));
  const spot = {x: 100, y: 100};
  const hit = pickCornerHandle(spot, [
    {kind: 'proj', handles: [{x: 108, y: 78}, {x: 400, y: 80}, {x: 400, y: 300}, {x: 100, y: 300}]},
    {kind: 'frame', handles: [{x: 100, y: 100}, {x: 300, y: 100}, {x: 300, y: 240}, {x: 100, y: 240}]}
  ], {frameFirst: true, frameRadius: 26, radius: 34});
  assert.equal(hit.kind, 'frame');
  assert.equal(hit.index, 0);
});
