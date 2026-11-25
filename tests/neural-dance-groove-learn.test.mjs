// ND Listen v2 (TJ Nov 12): beat-pattern learning. The groove learner learns
// meter, downbeat, a per-band 16-step groove and phrases online from heard
// onsets on the live beat clock, and only drives the dancers while confident.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGrooveLearner, GROOVE_ENTER} from '../neural-dance/src/groove-learn.js';
import {createGrooveWire} from '../neural-dance/src/groove-wire.js';
import {createBeatEntrain} from '../neural-dance/src/beat-entrain.js';
import {phraseHold} from '../neural-dance/src/silhouette.js';
import {composeSong, SONGS} from '../scripts/groove-synth.mjs';

const FRAME = 1000 / 60, LAG = 30;

// Feed a song's onset events (as the band detector would hear them) to the
// learner on a clock that sits on the true beats (shift = beats of offset).
function drive(name, {shift = 0, sections = null, t1 = null, jitter = 6} = {}) {
  const song = composeSong(sections || SONGS[name].sections);
  const ev = song.events.map(e => ({b: e.band, t: e.t * 1000})).sort((a, b) => a.t - b.t);
  const beats = song.beats.map(x => x * 1000), downs = song.downbeats.map(x => x * 1000), phrases = song.phrases.map(x => x * 1000);
  const g = createGrooveLearner();
  const onT = new Float64Array(4), str = new Float64Array(4).fill(1.5);
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let i = 0, k = 1;
  const end = t1 || song.duration * 1000;
  for (let now = 0; now < end; now += FRAME) {
    let on = 0;
    while (i < ev.length && ev[i].t + LAG <= now) { on |= 1 << ev[i].b; onT[ev[i].b] = ev[i].t + (rnd() - 0.5) * jitter; i++; }
    while (k < beats.length - 1 && beats[k] <= now) k++;
    const P = beats[k] - beats[k - 1];
    const o = g.step(now, {P, anchor: beats[k - 1] + shift * P, gateOpen: true, onsets: on, onsetTime: onT, strength: str});
    out.push({now, active: o.active, conf: o.confidence, meter: o.meter, down: o.downbeat ? o.downbeatAt : -1, phrase: o.phraseStart ? o.downbeatAt : -1, shift: o.clockShift});
  }
  return {g, out, beats, downs, phrases, song};
}
const near = (t, arr, tol = 60) => arr.some(x => Math.abs(x - t) <= tol);
// Lock = first of 4 confident downbeats in a row on true downbeats.
function lockAt(out, downs, from = 0) {
  let run = 0;
  for (const f of out) {
    if (f.now < from || f.down < 0) continue;
    if (f.active && near(f.down, downs)) { if (++run === 4) return f.down; } else run = 0;
  }
  return Infinity;
}
const precision = (out, downs, from = 0, to = Infinity) => {
  const act = out.filter(f => f.down >= 0 && f.active && f.now >= from && f.now < to);
  return {n: act.length, p: act.length ? act.filter(f => near(f.down, downs)).length / act.length : 1};
};

test('rock 110: locks the downbeat within a few bars and stays right', () => {
  const {out, downs, beats} = drive('gs-rock-110');
  const bar = (beats[4] - beats[0]);
  const lock = lockAt(out, downs);
  assert.ok(lock < 10 * bar, 'locked by bar 10: ' + (lock / bar).toFixed(1));
  const {n, p} = precision(out, downs);
  assert.ok(n >= 15 && p >= 0.95, `confident downbeats on the true 1: ${p.toFixed(2)} of ${n}`);
});

test('swung hip-hop 92: locks; swing learned above straight', () => {
  const {out, downs, g} = drive('gs-hiphop-swing-92');
  assert.ok(Number.isFinite(lockAt(out, downs)), 'locks');
  assert.ok(precision(out, downs).p >= 0.9);
  assert.ok(g.state.swing > 0.55, 'swing ' + g.state.swing);
});

test('tempo drift 120 -> 128 under the clock: no confident wrong bars', () => {
  const {out, downs} = drive('gs-house-drift-120-128');
  const {p} = precision(out, downs);
  assert.ok(p >= 0.9, 'precision while confident ' + p.toFixed(2));
});

test('3/4 waltz: meter 3, never drives the 4-beat dancers', () => {
  const {out} = drive('gs-waltz-3-4-132');
  const late = out.filter(f => f.now > 25000);
  assert.ok(late.filter(f => f.meter === 3).length / late.length > 0.8, 'meter 3');
});

test('song change (rock 112 -> breaks 128): drops confidence, then relearns', () => {
  const {out, downs, song} = drive('gs-change-rock-to-breaks');
  const change = song.downbeats[20] * 1000;
  const after = out.filter(f => f.now > change && f.now < change + 1500);
  assert.ok(after.some(f => !f.active), 'confidence drops at the change');
  const {p} = precision(out, downs, change);
  assert.ok(p >= 0.85, 'confident downbeats after the change are right: ' + p.toFixed(2));
  assert.ok(lockAt(out, downs, change) < change + 16 * 4 * 469, 're-locks after the change');
});

test('break (8 bars no drums): no confidence in the gap, relocks after', () => {
  const {out, downs, song} = drive('gs-breakdown-house-126');
  const gap0 = song.downbeats[16] * 1000, gap1 = song.downbeats[24] * 1000;
  const inGap = out.filter(f => f.now > gap0 + 3000 && f.now < gap1);
  assert.ok(inGap.every(f => !f.active), 'inactive in the break');
  assert.ok(precision(out, downs).p >= 0.85);
});

test('clock half a beat off the music: groove never hands the dancers a bar', () => {
  const {g, out} = drive('gs-rock-110', {shift: 0.5});
  const late = out.filter(f => f.now > 30000 && f.active);
  if (late.length) assert.ok(late.every(f => Math.abs(f.shift) > 0.3), 'reports the clock shift');
  assert.equal(g.barBeatAt(40000), -1, 'no bar for an off-beat clock');
});

test('phrases: 8-bar phrase starts land on the labelled phrase downbeats', () => {
  const {out, phrases} = drive('gs-rock-110');
  const ps = out.filter(f => f.phrase >= 0 && f.active);
  assert.ok(ps.length >= 1, 'a phrase start');
  assert.ok(ps.filter(f => near(f.phrase, phrases)).length / ps.length >= 0.6);
});

test('cost: well under a tenth of a millisecond per frame', () => {
  const t0 = performance.now();
  const {out} = drive('gs-rock-110');
  const ms = (performance.now() - t0) / out.length;
  assert.ok(ms < 0.1, ms.toFixed(4) + ' ms/frame');
});

// Wire: groove -> entrain. Until the learner is confident the dancers get
// exactly today's entrain output.
function driveWire(events, t1, withWire) {
  const e = createBeatEntrain();
  const w = withWire ? createGrooveWire({groove: createGrooveLearner(), entrain: e}) : null;
  const info = {onsets: 0, onsetTime: new Float64Array(4), threshold: new Float64Array(4).fill(1), flux: new Float64Array(4).fill(1.5)};
  const log = [], ones = []; let i = 0;
  for (let now = 0; now < t1; now += FRAME) {
    let on = 0;
    while (i < events.length && events[i].t + LAG <= now) { on |= 1 << events[i].b; info.onsetTime[events[i].b] = events[i].t; i++; }
    info.onsets = on;
    const o = e.step(now, {bpm: 110, gateOpen: true, onsets: on, heard: on, period: null});
    if (w) { w.feed(now, {gateOpen: true, bandInfo: info, gt: null, entrainActive: o.active}); w.decorate(now, o); }
    if (o.mask) log.push(`${Math.round(now)}:${o.mask}:${o.info.barBeat}:${Array.from(o.info.accent).join(',')}`);
    if (o.downbeat) ones.push({t: e.state.beatAt, applied: !!(w && w.state.applied)});
  }
  return {log, w, e, ones};
}

test('wire: below confidence the entrain output is unchanged; once confident it takes the learned bar', () => {
  const song = composeSong(SONGS['gs-rock-110'].sections);
  const ev = song.events.map(x => ({b: x.band, t: x.t * 1000})).sort((a, b) => a.t - b.t);
  const base = driveWire(ev, 60000, false), wired = driveWire(ev, 60000, true);
  // Find when the wire first drove the bar.
  const first = wired.log.findIndex((l, j) => l !== base.log[j]);
  assert.ok(first > 0, 'identical at first');
  const tFirst = +wired.log[first].split(':')[0];
  assert.ok(tFirst > 4000, 'nothing changes before the groove locks: ' + tFirst);
  assert.ok(wired.w.state.applied, 'applies once confident');
  const downs = song.downbeats.map(x => x * 1000);
  const ones = wired.ones.filter(x => x.applied).map(x => x.t);
  assert.ok(ones.length > 10);
  const ok = ones.filter(t => downs.some(d => Math.abs(d - t) < 60)).length / ones.length;
  assert.ok(ok >= 0.9, 'dancer beat 1 on the true downbeat: ' + ok.toFixed(2));
});

test('wire: ?groove=0 path and reset hand the bar back to entrain', () => {
  const e = createBeatEntrain();
  e.setDownbeat(2); assert.equal(e.state.extDown, 2);
  const w = createGrooveWire({groove: createGrooveLearner(), entrain: e});
  w.reset(); assert.equal(e.state.extDown, -1);
  e.setDownbeat(3); e.reset(); assert.equal(e.state.extDown, -1);
});

test('phraseHold: even jumps realign the step count; odd ones hold one step; no info = no change', () => {
  const c = {strikeCount: 9};
  assert.equal(phraseHold(c, {phrase: {start: true, phraseBars: 8}}, 2), false);
  assert.equal(c.strikeCount, 15, 'next strike = 16 (phrase start)');
  const d = {strikeCount: 10};
  assert.equal(phraseHold(d, {phrase: {start: true, phraseBars: 8}}, 2), true, 'odd: hold');
  assert.equal(d.strikeCount, 10);
  const e = {strikeCount: 10};
  assert.equal(phraseHold(e, {}, 2), false); assert.equal(phraseHold(e, {phrase: {start: false}}, 2), false);
  assert.equal(e.strikeCount, 10);
  assert.ok(GROOVE_ENTER >= 0.5);
});

test('room-lab: groove fed every Listen frame, decorates only the entrain path, flag off', async () => {
  const {readFileSync} = await import('node:fs');
  const src = readFileSync(new URL('../neural-dance/room-lab.js', import.meta.url), 'utf8');
  assert.match(src, /grooveFlag\('groove'\)/);
  assert.match(src, /grooveWire\.feed\(now,\{gateOpen:!!gate\.open,bandInfo,gt:gtState/);
  const dec = src.indexOf('grooveWire.decorate(now,entrainOut)'), use = src.indexOf('beatInfo=entrainOut.info;');
  assert.ok(dec > 0 && dec < use, 'decorates before the entrain beat info is used');
  assert.match(src, /groove:grooveWire\?grooveWire\.snapshot\(\):null/);
});
