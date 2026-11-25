// New defaults (TJ 11:31 AM): ripple intensity 0.20, hue spread 0.10 on
// live, debug and sim. Saved localStorage values still win.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RIPPLE_DEFAULT_INTENSITY} from '../neural-dance/src/water-ripple.js';
import {HUE_SPREAD_DEFAULT} from '../neural-dance/src/dancer-hue.js';
import {DEFAULT_SHOW_TUNING} from '../neural-dance/src/silhouette.js';
import {freshShowState} from '../neural-dance/src/show-commands.js';
import {savedRippleIntensity, savedHueSpread, saveHueSpread, migrateRippleDefaultOn, RIPPLE_PREF_KEY, HUE_SPREAD_PREF_KEY} from '../neural-dance/room-lab.js';

const page = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m};
};

test('defaults are ripple 0.20 and hue spread 0.10 everywhere', () => {
  assert.equal(RIPPLE_DEFAULT_INTENSITY, 0.20);
  assert.equal(HUE_SPREAD_DEFAULT, 0.10);
  assert.equal(DEFAULT_SHOW_TUNING.hueSpread, 0.10);
  assert.equal(freshShowState().hueSpread, 0.10);
  assert.match(page('src/pages/neural-dance/debug/index.astro'), /data-debug-control="ripple-intensity"[^>]*value="0\.20"/);
  assert.match(page('src/pages/neural-dance/debug/index.astro'), /data-debug-control="hue-spread"[^>]*value="0\.10"/);
  assert.match(page('src/pages/neural-dance/live/index.astro'), /data-control="hue-spread"[^>]*value="0\.10"/);
  const sim = page('static/neural-dance/sim/index.html');
  assert.match(sim, /id="rippleIntensity"[^>]*value="0\.20"/);
  assert.match(sim, /id="hueSpread"[^>]*value="0\.10"/);
  assert.match(sim, /rippleIntensity: 0\.20,\s*hueSpread: 0\.10,/);
});

test('saved ripple intensity wins; legacy auto 0.85 does not', () => {
  assert.equal(savedRippleIntensity(store()), null);
  assert.equal(savedRippleIntensity(store({[RIPPLE_PREF_KEY]: JSON.stringify({enabled: true, intensity: 0.85})})), null);
  assert.deepEqual(savedRippleIntensity(store({[RIPPLE_PREF_KEY]: JSON.stringify({enabled: true, intensity: 0.25})})), {intensity: 0.25, user: true});
  assert.deepEqual(savedRippleIntensity(store({[RIPPLE_PREF_KEY]: JSON.stringify({enabled: true, intensity: 0.85, user: true})})), {intensity: 0.85, user: true});
  assert.equal(savedRippleIntensity(store({[RIPPLE_PREF_KEY]: JSON.stringify({enabled: true, intensity: 0.2, user: false})})), null);
  // First run writes the new default, not 0.85; existing records are not wiped.
  const fresh = store();
  migrateRippleDefaultOn(fresh);
  assert.equal(JSON.parse(fresh.getItem(RIPPLE_PREF_KEY)).intensity, 0.20);
  const kept = store({[RIPPLE_PREF_KEY]: JSON.stringify({enabled: false, intensity: 0.4})});
  assert.equal(migrateRippleDefaultOn(kept), false);
  assert.equal(JSON.parse(kept.getItem(RIPPLE_PREF_KEY)).intensity, 0.4);
});

test('hue spread saves only when set and restores', () => {
  const s = store();
  assert.equal(savedHueSpread(s), null);
  saveHueSpread(s, 0.35);
  assert.equal(s.getItem(HUE_SPREAD_PREF_KEY), '0.35');
  assert.equal(savedHueSpread(s), 0.35);
  const src = page('neural-dance/room-lab.js');
  assert.match(src, /savedHueSpread\(null\)/);
  assert.match(src, /addEventListener\('input',e=>saveHueSpread\(null,\+e\.target\.value\)\)/);
  assert.match(src, /user:rippleUserSet/);
});
