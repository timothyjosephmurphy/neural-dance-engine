// One-shot buttons flash working, then done, then return to neutral.
// Toggles and the draw-mode selector keep their own pressed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CONTROL_DONE_MS, flashOneShot, setControlPhase} from '../neural-dance/live-show.js';

function button() {
  const el = {
    dataset: {},
    attrs: {},
    blurred: 0,
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    blur() { this.blurred++; }
  };
  return el;
}

test('a one-shot goes working, done, then neutral, and blurs', async () => {
  assert.equal(CONTROL_DONE_MS, 1000);
  const el = button();
  flashOneShot(el);
  assert.equal(el.dataset.phase, 'working');
  assert.equal(el.attrs['aria-pressed'], 'true');
  assert.equal(el.blurred, 1);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(el.dataset.phase, 'done');
  assert.equal(el.attrs['aria-pressed'], 'false');
  await new Promise(resolve => setTimeout(resolve, CONTROL_DONE_MS + 40));
  assert.equal(el.dataset.phase, undefined);
  assert.equal(el.attrs['aria-busy'], 'false');
  assert.equal(el.attrs['aria-pressed'], 'false');
});

test('toggles and the mode selector are not flashed, and focus rings are keyboard-only', () => {
  const show = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../neural-dance/debug-viewer.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  const debug = readFileSync(new URL('../src/pages/neural-dance/debug/index.astro', import.meta.url), 'utf8');
  assert.match(viewer, /flashOneShot\(button\)/);
  assert.match(viewer, /flashOneShot\(view\.frameAccept\)/);
  assert.match(viewer, /flashOneShot\(view\.clearManual\)/);
  assert.match(show, /flashOneShot\(button\)/);
  const toggles = viewer.slice(viewer.indexOf('function flagToggle'), viewer.indexOf('function clearPresetsUsing'));
  assert.equal(toggles.includes('flashOneShot'), false);
  assert.match(toggles, /aria-pressed/);
  const draw = viewer.slice(viewer.indexOf("if (mode !== 'dots'"), viewer.indexOf("querySelectorAll('[data-debug-mode] [data-mode]')"));
  assert.equal(draw.includes('flashOneShot'), false);
  assert.match(draw, /aria-pressed/);
  for (const page of [live, debug]) {
    assert.match(page, /button:focus[^{]*\{outline:none\}/);
    assert.match(page, /button:focus-visible/);
    assert.equal(page.includes('button:focus{outline:2px'), false);
  }
  const toggle = button();
  toggle.setAttribute('aria-pressed', 'true');
  setControlPhase(toggle, 'working');
  setControlPhase(toggle, '');
  assert.equal(toggle.dataset.phase, undefined);
});
