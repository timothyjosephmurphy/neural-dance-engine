// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT
//
// TJ Nov 10 1:24 PM: after Align + Rescan the halos sat on all three stickers
// but the left sticker's dancer stood ~90 px to the left: its planted feet
// were kept from before the re-align, and at low activation (weight shift
// only, no steps) it never walked over. A calibration change must re-anchor
// every dancer on its sticker's mapped position.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSilhouetteShow} from '../neural-dance/src/silhouette.js';
import {resetArmLiftFamilies} from '../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel} from '../neural-dance/src/skeleton-motion.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}
const feetX = fr => {
  const xs = ['footL', 'heelL', 'footR', 'heelR'].map(k => fr[k] && fr[k].x).filter(Number.isFinite);
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
};

function run({commit = false, moveTo = 292, level = 0.18, kind = 'sticker'} = {}) {
  resetBodyDynamics(); resetTravel(); resetArmLiftFamilies();
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder();
  const stickers = [{id: 20, x: 382, y: 289, type: 0}, {id: 21, x: 508, y: 190, type: 1}, {id: 22, x: 576, y: 299, type: 2}];
  let t = 0, last = null;
  const frameAt = (secs, list) => {
    for (let i = 0; i < secs * 30; i++) {
      t += 1 / 30; const now = 1000 + t * 1000;
      if (i % 15 === 0) show.beat(now, 1 | 8);
      const markers = list.map(s => ({...s, kind}));
      show.paint(ctx, markers, {now, levels: [level, level * 0.5, level * 0.8, level * 0.5], network: markers.map(m => ({id: m.id, received: level}))});
      last = show.figureHeights();
    }
  };
  // Before the re-align the left sticker mapped ~90 px further left.
  frameAt(10, stickers.map(s => s.id === 20 ? {...s, x: moveTo} : s));
  if (commit && show.commitHomes) show.commitHomes();
  frameAt(6, stickers);
  return {figs: last, stickers};
}

for (const commit of [false, true]) {
  test('after a re-align moves a sticker ~90 px, its dancer stands on the sticker (' + (commit ? 'scan commit' : 'no commit') + ')', () => {
    const {figs, stickers} = run({commit});
    assert.equal(figs.length, 3, 'one dancer per sticker, no stale copy');
    for (const s of stickers) {
      const fr = figs.find(f => f.id === s.id);
      assert.ok(fr, 'dancer for sticker ' + s.id);
      const off = Math.abs(feetX(fr) - s.x);
      assert.ok(off <= 0.5 * fr.height + 2, 'sticker ' + s.id + ' dancer feet ' + off.toFixed(1) + ' px from its sticker (height ' + fr.height.toFixed(1) + ')');
    }
  });
}
