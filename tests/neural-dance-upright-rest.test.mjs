// TJ 12:02 PM PT: "Torso looks like it's kinda hunched over in a resting
// state. It should be standing straight and tall." At low activation and in
// silence the spine is vertical (<= 3 deg), the shoulders stack over the
// hips and the head over the neck; lean grows only modestly with activation
// and squat. Foot lock and chakra anchors stay intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {restProbe} from './helpers/rest-probe.mjs';
import {torsoLeanLimit, uprightTorso, buildFor} from '../neural-dance/src/skeleton-dancer.js';

const deg = r => r * 180 / Math.PI;
const mid = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((+a.z || 0) + (+b.z || 0)) / 2});

test('rest and low activation: spine within 3 deg of vertical, shoulders over hips, head up', () => {
  const st = {rest: [], low: [], high: [], head: [], over: [], crown: []};
  const o = restProbe({phases: [{s: 20, kind: 'music', bpm: 110, level: 0.15}, {s: 30, kind: 'silence'}, {s: 20, kind: 'music', bpm: 124, level: 1.0, bass: true}, {s: 20, kind: 'silence'}], dancers: 4, onFrame(fr, x) {
    const j = fr.joints; if (!j || !j.neck || x.t < 4) return;
    const hip = mid(j.hipL, j.hipR), sh = mid(j.shL, j.shR), rise = hip.y - sh.y;
    const lean = Math.max(Math.abs(deg(Math.atan2(sh.x - hip.x, rise))), Math.abs(deg(Math.atan2(sh.z - hip.z, rise))));
    const act = (+fr.activation || 0) * (+fr.hush || 0);
    if (!x.music) st.rest.push(lean); else if (act < 0.3) st.low.push(lean); else st.high.push(lean);
    if (!x.music || act < 0.3) {
      st.head.push(Math.abs(deg(Math.atan2(j.head.x - j.neck.x, j.neck.y - j.head.y))));
      st.over.push(Math.abs(sh.x - hip.x) / fr.height);
      const b = buildFor(fr.id, fr.band);
      if (fr.chakra) st.crown.push(fr.chakra.crown.y < j.head.y - b.headR * fr.height * 0.98 ? 0 : 1);
    }
  }});
  const max = a => a.reduce((m, v) => Math.max(m, v), 0);
  console.log('# upright', JSON.stringify({rest: max(st.rest), low: max(st.low), highMax: max(st.high), head: max(st.head), over: max(st.over), n: st.rest.length + st.low.length}));
  assert.ok(st.rest.length > 1000 && st.low.length > 500);
  assert.ok(max(st.rest) <= 3, 'rest lean ' + max(st.rest).toFixed(2) + ' deg');
  assert.ok(max(st.low) <= 3, 'low-activation lean ' + max(st.low).toFixed(2) + ' deg');
  assert.ok(max(st.head) <= 6, 'head up over the neck (' + max(st.head).toFixed(2) + ' deg)');
  assert.ok(max(st.over) < 0.02, 'shoulders stacked over the hips');
  assert.ok(max(st.high) <= torsoLeanLimit(1, 1, 1) + 0.5, 'lean at peak stays modest (' + max(st.high).toFixed(1) + ' deg)');
  assert.equal(st.crown.reduce((a, v) => a + v, 0), 0, 'crown stays above the head');
  assert.ok(o.slip < 0.05, 'foot lock intact (slip ' + o.slip + ')');
});

test('uprightTorso shears a hunched torso back to vertical without touching legs', () => {
  const p = {hipL: {x: -10, y: 100}, hipR: {x: 10, y: 100}, groin: {x: 0, y: 102}, kneeL: {x: -10, y: 130}, footL: {x: -10, y: 160},
    shL: {x: 2, y: 60}, shR: {x: 22, y: 60}, neck: {x: 12, y: 56}, head: {x: 20, y: 48}, crown: {x: 20, y: 40}, heart: {x: 6, y: 78}, handL: {x: 0, y: 95}};
  uprightTorso(p, 1.5);
  const sh = mid(p.shL, p.shR);
  assert.ok(Math.abs(deg(Math.atan2(sh.x, 40))) <= 1.51);
  assert.ok(Math.abs(deg(Math.atan2(p.head.x - p.neck.x, p.neck.y - p.head.y))) <= 3.51);
  assert.deepEqual([p.kneeL.x, p.footL.x, p.groin.x, p.hipL.x], [-10, -10, 0, -10]);
});
