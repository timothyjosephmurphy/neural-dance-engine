// The /live/ Controls button sits over the projection's upper-left corner:
// keep it dim and outline-only until hover, tap, focus, or while open.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');

test('Controls reveal button is dim, transparent, and outlined by default', () => {
  const rule = live.match(/\.nd-live-reveal\{[^}]*\}/)[0];
  const opacity = +rule.match(/opacity:([\d.]+)/)[1];
  assert.ok(opacity >= 0.15 && opacity <= 0.35, `opacity ${opacity}`);
  assert.match(rule, /background:transparent/);
  assert.match(rule, /border:1px solid rgba\(/);
  assert.match(rule, /position:fixed/);
  assert.match(rule, /touch-action:manipulation/);
});

test('it brightens on hover, tap, focus, and while open, and stays a 56px tap target on phones', () => {
  const lit = live.match(/\.nd-live-reveal:hover,[^{]*\{[^}]*\}/)[0];
  for (const sel of [':hover', ':focus-visible', ':active', '[aria-expanded="true"]']) assert.ok(lit.includes(sel), sel);
  assert.ok(+lit.match(/opacity:([\d.]+)/)[1] >= 0.9);
  assert.match(live, /\.nd-live-reveal,\[data-cancel-align\],\[data-reset-zoom\]\{min-height:56px;min-width:56px\}/);
});
