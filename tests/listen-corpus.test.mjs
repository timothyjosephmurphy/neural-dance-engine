// Fast corpus checks. Not part of test:show.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {clips} from '../scripts/listen-corpus-generate.mjs';
import {
  SCHEMA, makeTimeMap, normalizeMeterLabel, meterMatch, scoreTimes, fMeasure
} from './helpers/listen-corpus.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every synthetic clip has a unique seed and a v1 schema', () => {
  const all = clips();
  const ids = new Set(), seeds = new Set();
  for (const c of all) {
    assert.equal(c.schema, SCHEMA);
    assert.ok(c.id, 'id');
    assert.ok(Number.isInteger(c.seed) && c.seed > 0, c.id + ' seed');
    assert.equal(ids.has(c.id), false, 'duplicate id ' + c.id);
    assert.equal(seeds.has(c.seed), false, 'duplicate seed ' + c.seed);
    ids.add(c.id); seeds.add(c.seed);
    assert.ok(c.downbeats.length >= 2, c.id + ' downbeats');
    assert.ok(c.beats.length >= c.downbeats.length, c.id + ' beats');
    assert.equal(c.meter.label, normalizeMeterLabel(c.meter));
    // First downbeat is the first beat and is after t=0 (analyser pad).
    assert.ok(c.downbeats[0] > 0.2 && c.downbeats[0] < 1, c.id + ' first downbeat');
    assert.ok(Math.abs(c.beats[0] - c.downbeats[0]) < 1e-6, c.id + ' beat0=down0');
  }
  assert.ok(all.length >= 18, 'expected a full synthetic set, got ' + all.length);
});

test('required meters, swing, drift, rubato, break, fill, phone-mic are present', () => {
  const byId = Object.fromEntries(clips().map(c => [c.id, c]));
  for (const id of [
    'syn-4-4-steady-120', 'syn-3-4-steady-108', 'syn-6-8-steady-96',
    'syn-5-4-steady-110', 'syn-7-8-322-210', 'syn-332-steady-100',
    'syn-4-4-swing-2-1-120', 'syn-4-4-swing-3-2-120',
    'syn-4-4-drift-plus8-120', 'syn-4-4-drift-minus8-120',
    'syn-4-4-rubato-112', 'syn-4-4-break-120', 'syn-4-4-fill-120',
    'syn-4-4-moving-accents-120', 'syn-4-4-tempo-change-100-128',
    'syn-4-4-phone-mic-120', 'syn-4-4-phone-mic-hatcut-120',
    'syn-7-8-phone-mic-hatcut-210'
  ]) assert.ok(byId[id], id);
  assert.equal(byId['syn-7-8-322-210'].meter.grouping.join('+'), '3+2+2');
  assert.equal(byId['syn-332-steady-100'].meter.label, '3+3+2');
  assert.equal(byId['syn-4-4-swing-2-1-120'].swing.label, '2:1');
  assert.equal(byId['syn-4-4-swing-3-2-120'].swing.label, '3:2');
  assert.equal(byId['syn-4-4-phone-mic-hatcut-120'].hatAudible, false);
  assert.ok(byId['syn-4-4-break-120'].regions.breaks?.length >= 2);
  assert.ok(byId['syn-4-4-fill-120'].regions.fills?.length >= 2);
  // A 2-bar break should drop band hits but keep downbeats in that window.
  const br = byId['syn-4-4-break-120'];
  const [a, b] = br.regions.breaks[0];
  const hitsIn = br.events.filter(e => e.t >= a && e.t < b);
  const downsIn = br.downbeats.filter(t => t >= a && t < b);
  assert.equal(hitsIn.length, 0, 'no hits during break');
  assert.ok(downsIn.length >= 1, 'downbeats continue during break');
});

test('4/4 at 120 has a 0.5 s beat and a 2 s bar', () => {
  const c = clips().find(x => x.id === 'syn-4-4-steady-120');
  const iois = c.beats.slice(1).map((t, i) => t - c.beats[i]);
  for (const d of iois) assert.ok(Math.abs(d - 0.5) < 1e-4, 'beat ioi ' + d);
  const bars = c.downbeats.slice(1).map((t, i) => t - c.downbeats[i]);
  for (const d of bars) assert.ok(Math.abs(d - 2) < 1e-4, 'bar ' + d);
  assert.equal(c.beats.length, c.downbeats.length * 4);
});

test('7/8 grouping produces 3 uneven beats per bar', () => {
  const c = clips().find(x => x.id === 'syn-7-8-322-210');
  assert.equal(c.beats.length, c.downbeats.length * 3);
  const eighth = 60 / 210;
  // 3+2+2 eighths
  const b0 = c.beats[0], b1 = c.beats[1], b2 = c.beats[2], b3 = c.beats[3];
  assert.ok(Math.abs((b1 - b0) - 3 * eighth) < 1e-4);
  assert.ok(Math.abs((b2 - b1) - 2 * eighth) < 1e-4);
  assert.ok(Math.abs((b3 - b0) - 7 * eighth) < 1e-4);
});

test('2:1 swing delays the off-eighth to 2/3 of the beat', () => {
  const c = clips().find(x => x.id === 'syn-4-4-swing-2-1-120');
  const firstHatOn = c.bands.hat[0];
  const firstHatOff = c.bands.hat[1];
  const beat = 0.5;
  assert.ok(Math.abs((firstHatOff - firstHatOn) - beat * (2 / 3)) < 1e-3, firstHatOff - firstHatOn);
});

test('linear +8% drift shortens later beats', () => {
  const c = clips().find(x => x.id === 'syn-4-4-drift-plus8-120');
  const first = c.beats[1] - c.beats[0];
  const last = c.beats.at(-1) - c.beats.at(-2);
  assert.ok(first > 0.49 && first < 0.51, 'start near 120 BPM, got ' + first);
  assert.ok(last < first - 0.01, 'later beats faster, ' + last + ' vs ' + first);
});

test('meter labels normalize and scoreTimes F-measure is 1 on a perfect grid', () => {
  assert.equal(normalizeMeterLabel('3+3+2'), '3+3+2');
  assert.equal(normalizeMeterLabel({label: '8/8'}), '3+3+2');
  assert.equal(meterMatch({label: '7/8'}, '7/8'), true);
  assert.equal(meterMatch({label: '4/4'}, '3/4'), false);
  assert.equal(meterMatch({label: '4/4'}, null), null);
  const truth = [0.5, 1, 1.5, 2];
  const found = [0.52, 0.99, 1.51, 2.02]; // all within 70 ms
  const s = scoreTimes(truth, found, {tolMs: 70, skipFirstMs: 0});
  assert.equal(s.hits, 4);
  assert.equal(s.f, 1);
  const fm = fMeasure(8, 2, 0);
  assert.ok(Math.abs(fm.f - (2 * 0.8 * 1) / 1.8) < 1e-12);
});

test('tempo map linear-drift endpoint matches the closed form', () => {
  const t = makeTimeMap({kind: 'linear-drift', bpmStart: 120, bpmEnd: 129.6, units: 32}, {t0: 0.5, units: 32});
  // t(0)=0.5, t(32) = 0.5 + (60 / k) * ln(129.6/120), k=(9.6)/32
  const k = 9.6 / 32;
  const expect = 0.5 + (60 / k) * Math.log(129.6 / 120);
  assert.ok(Math.abs(t(32) - expect) < 1e-9, t(32) + ' vs ' + expect);
});
