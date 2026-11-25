// TJ Nov 11 3:06 PM: with person pause on, the sticker scan started while he
// was still in frame. A rescan now needs PERSON_EXIT_FRAMES consecutive
// person-free detect frames plus PERSON_CLEAR_MS of no person and no floor
// motion; any person frame restarts the count; the scan's own white frame is
// checked and re-arms the pause. Person pause defaults on (old 'off' saves
// migrate once) and /live/ shows a dim chip while it is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  createPersonOcclusion, personInFrame, readPersonPause, writePersonPause, syncPersonPauseChip,
  PERSON_CLEAR_MS, PERSON_EXIT_FRAMES, PERSON_ENTER_FRAMES, PERSON_MOTION_HOLD, PERSON_MOTION_MAX_MS,
  PERSON_PAUSE_KEY, PERSON_PAUSE_OFF_NOTE, PERSON_PAUSE_STORE_V
} from '../neural-dance/src/person-occlusion.js';
import {runStickerFlash} from '../neural-dance/src/sticker-flash.js';

const DT = 100; // live detect() runs every ~100 ms
const HIT = {present: true, holding: true, motion: 0};
const MISS = {present: false, holding: false, motion: 0};
const MOVE = {present: false, holding: false, motion: PERSON_MOTION_HOLD * 2};

function drive(occ, seq, t0 = 0) {
  let t = t0;
  const out = [];
  for (const p of seq) { out.push({t, ...occ.observe({person: p, now: t})}); t += DT; }
  return {out, t};
}
const rep = (p, n) => Array.from({length: n}, () => p);

test('clear needs N consecutive person-free frames plus ~1.5-2 s settle', () => {
  assert.ok(PERSON_EXIT_FRAMES >= 6, 'exit frames ' + PERSON_EXIT_FRAMES);
  assert.ok(PERSON_CLEAR_MS >= 1500 && PERSON_CLEAR_MS <= 2000);
  const occ = createPersonOcclusion();
  const {out} = drive(occ, [...rep(HIT, 6), ...rep(MISS, 60)]);
  const fire = out.filter(d => d.flashRescan);
  assert.equal(fire.length, 1, 'rescan exactly once');
  const lastHit = 5 * DT;
  const wait = fire[0].t - lastHit;
  assert.ok(wait >= PERSON_CLEAR_MS + (PERSON_EXIT_FRAMES - 1) * DT, 'rescan after ' + wait + ' ms');
  for (const d of out) if (d.t > lastHit && d.t < fire[0].t) assert.ok(d.paused, 'still paused at ' + d.t);
});

test('a flickering detector (person seen every few frames) never releases', () => {
  const occ = createPersonOcclusion();
  const seq = [...rep(HIT, 5)];
  for (let i = 0; i < 20; i++) seq.push(...rep(MISS, PERSON_EXIT_FRAMES - 1), HIT);
  const {out} = drive(occ, seq);
  assert.equal(out.filter(d => d.flashRescan).length, 0);
  assert.ok(out.at(-1).paused);
});

test('a person reappearing during the settle wait restarts the whole count', () => {
  const occ = createPersonOcclusion();
  const a = drive(occ, [...rep(HIT, 5), ...rep(MISS, PERSON_EXIT_FRAMES + 10)]);
  assert.ok(a.out.at(-1).settling, 'settling before the reappearance');
  const b = drive(occ, [HIT, ...rep(MISS, PERSON_EXIT_FRAMES + Math.floor(PERSON_CLEAR_MS / DT) - 2)], a.t);
  assert.equal(b.out.filter(d => d.flashRescan).length, 0, 'no rescan inside the restarted wait');
  const c = drive(occ, rep(MISS, 10), b.t);
  assert.equal(c.out.filter(d => d.flashRescan).length, 1);
});

test('motion before the pause latches keeps the enter streak for one frame', () => {
  const occ = createPersonOcclusion();
  const dip = {present: false, holding: false, motion: PERSON_MOTION_HOLD * 3};
  const {out} = drive(occ, [...rep(HIT, PERSON_ENTER_FRAMES - 1), dip, HIT]);
  assert.equal(out.at(-2).paused, false);
  assert.equal(out.at(-2).held, 'motion');
  assert.equal(out.at(-1).paused, true);
  const quiet = createPersonOcclusion();
  assert.ok(drive(quiet, rep(MOVE, 8)).out.every(d => !d.paused));
});

test('a one-frame motion dip during placement does not open the exit count', () => {
  const occ = createPersonOcclusion();
  const dip = {present: false, holding: false, motion: PERSON_MOTION_HOLD * 0.4};
  const seq = [...rep(HIT, 5)];
  for (let i = 0; i < 24; i++) seq.push(MOVE, dip);
  const {out} = drive(occ, seq);
  assert.equal(out.filter(d => d.flashRescan).length, 0);
  assert.ok(out.at(-1).paused);
  assert.equal(out.at(-1).held, 'motion');
});

test('floor motion right after a person holds the wait; motion alone is capped', () => {
  const occ = createPersonOcclusion();
  const a = drive(occ, [...rep(HIT, 5), ...rep(MOVE, 30)]);
  assert.equal(a.out.filter(d => d.flashRescan).length, 0, 'moving floor = still there');
  assert.ok(a.out.at(-1).paused);
  // Keep moving past PERSON_MOTION_MAX_MS: the rescan must still come.
  const b = drive(occ, rep(MOVE, Math.ceil((PERSON_MOTION_MAX_MS + PERSON_CLEAR_MS) / DT) + PERSON_EXIT_FRAMES + 5), a.t);
  assert.equal(b.out.filter(d => d.flashRescan).length, 1, 'motion cannot block forever');
  // Motion with nobody seen does not pause in the clear phase.
  const occ2 = createPersonOcclusion();
  const c = drive(occ2, rep(MOVE, 30));
  assert.ok(c.out.every(d => !d.paused));
});

test('rearm (white frame showed someone) needs a fresh clear before the next rescan', () => {
  const occ = createPersonOcclusion();
  const a = drive(occ, [...rep(HIT, 5), ...rep(MISS, 40)]);
  assert.equal(a.out.filter(d => d.flashRescan).length, 1);
  const r = occ.rearm(a.t);
  assert.ok(r.paused);
  const b = drive(occ, rep(MISS, PERSON_EXIT_FRAMES + Math.floor(PERSON_CLEAR_MS / DT) - 2), a.t + DT);
  assert.equal(b.out.filter(d => d.flashRescan).length, 0);
  const c = drive(occ, rep(MISS, 10), b.t);
  assert.equal(c.out.filter(d => d.flashRescan).length, 1);
});

test('enter still needs PERSON_ENTER_FRAMES (a passing shadow does not pause)', () => {
  const occ = createPersonOcclusion();
  const {out} = drive(occ, [...rep(HIT, PERSON_ENTER_FRAMES - 1), ...rep(MISS, 10)]);
  assert.ok(out.every(d => !d.paused));
});

function floor(w, h, v = 120) { return new Uint8ClampedArray(w * h * 4).fill(v); }
function block(data, w, x0, y0, bw, bh, v) {
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
    const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = v;
  }
}
test('personInFrame reports floor motion against the previous grid', () => {
  const W = 160, H = 120;
  const a = floor(W, H);
  const first = personInFrame(a, W, H, {step: 4});
  assert.equal(first.motion, 0);
  const still = personInFrame(floor(W, H), W, H, {step: 4, previous: first.grid});
  assert.equal(still.motion, 0);
  const b = floor(W, H);
  block(b, W, 40, 30, 24, 40, 40); // a dark arm/leg moving in
  const moved = personInFrame(b, W, H, {step: 4, previous: first.grid});
  assert.ok(moved.motion >= PERSON_MOTION_HOLD, 'motion ' + moved.motion);
  const mismatch = personInFrame(b, W, H, {step: 8, previous: first.grid});
  assert.equal(mismatch.motion, 0, 'different grid = no motion claim');
});

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m};
}
test('person pause defaults on; a saved v1 off migrates to on once; a new off is kept', () => {
  assert.equal(readPersonPause(store()).enabled, true, 'first load');
  assert.equal(readPersonPause(null).enabled, true);
  const legacy = store({[PERSON_PAUSE_KEY]: JSON.stringify({v: 1, enabled: false, sensitivity: 0.5})});
  const r = readPersonPause(legacy);
  assert.equal(r.enabled, true);
  assert.equal(r.migrated, true);
  assert.equal(r.sensitivity, 0.5, 'sensitivity kept');
  const noV = store({[PERSON_PAUSE_KEY]: JSON.stringify({enabled: false})});
  assert.equal(readPersonPause(noV).enabled, true);
  const s = store();
  writePersonPause(s, {enabled: false, sensitivity: 0.35});
  assert.equal(JSON.parse(s.getItem(PERSON_PAUSE_KEY)).v, PERSON_PAUSE_STORE_V);
  assert.equal(readPersonPause(s).enabled, false, 'an off chosen after the migration sticks');
  // The boot path writes the migrated value back (setPersonPause persists).
  const src = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(src, /cam\.savedPause = readPersonPause\(memoryOf\(null\)\);\s*cam\.setPersonPause\(cam\.savedPause\.enabled/);
});

test('/live/ has a dim person-pause-off chip, synced from the camera', () => {
  const astro = readFileSync(new URL('../src/pages/neural-dance/live/index.astro', import.meta.url), 'utf8');
  assert.match(astro, /<p data-person-pause-off hidden role="status">Person pause off — sticker scans won’t trigger<\/p>/);
  const css = astro.match(/\[data-person-pause-off\]\{[^}]*\}/)[0];
  assert.match(css, /opacity:\.3/);
  assert.match(css, /pointer-events:none/);
  assert.match(astro, /body\.nd-align-clean \[data-person-pause-off\]/, 'hidden during scans and align');
  const chip = {hidden: true, textContent: ''};
  const doc = {querySelector: (q) => (q === '[data-person-pause-off]' ? chip : null)};
  syncPersonPauseChip(doc, false);
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, PERSON_PAUSE_OFF_NOTE);
  syncPersonPauseChip(doc, true);
  assert.equal(chip.hidden, true);
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  assert.match(cam, /syncPersonPauseChip\(document, cam\.personEnabled\)/);
});

test('scan white hold freezes the person gate instead of resetting it to clear', () => {
  const cam = readFileSync(new URL('../neural-dance/camera-markers.js', import.meta.url), 'utf8');
  const fn = cam.slice(cam.indexOf('function readPersonCam('), cam.indexOf('export function personInWhiteFrameCam('));
  // The stage flash (Align / Scan white on the room canvas) skips the read too.
  assert.match(fn, /if \(cam\.personEnabled && \(scanningNow \|\| stageFlash\)\) \{[\s\S]*?return \{skip: true/);
  assert.ok(fn.indexOf('skip: true') < fn.indexOf('cam.occlusion.reset()'), 'skip before any reset');
  const live = readFileSync(new URL('../neural-dance/live-show.js', import.meta.url), 'utf8');
  assert.match(live, /scanStickersNow\(doc, \{personCheck: true\}\)/);
  assert.match(live, /result\.person && cam\.rearmPersonPause/);
});

test('a person in the settled white frame aborts the scan without applying', async () => {
  const clock = {t: 0};
  let scanned = 0;
  const reports = [];
  const io = {
    show: () => {}, wait: async ms => { clock.t += ms; }, now: () => clock.t,
    grab: () => ({data: new Uint8ClampedArray(32 * 24 * 4).fill(230), width: 32, height: 24}),
    personInView: () => false,
    personInFrame: () => true,
    scan: () => { scanned++; return {ok: true, count: 4}; },
    report: r => reports.push(r)
  };
  const r = await runStickerFlash(io);
  assert.equal(r.state, 'aborted');
  assert.equal(r.person, true);
  assert.equal(scanned, 0);
  io.personInFrame = () => false;
  const ok = await runStickerFlash(io);
  assert.equal(ok.state, 'done');
  assert.equal(scanned, 1);
  delete io.personInFrame; // manual / OK-hand scans: no white-frame check
  assert.equal((await runStickerFlash(io)).state, 'done');
});

test('white-frame check: a body blocking the projector reads as present; stickers do not', () => {
  const W = 160, H = 120;
  const empty = floor(W, H, 230);
  for (const [x, y] of [[30, 30], [90, 60], [120, 90], [60, 100]]) block(empty, W, x, y, 4, 4, 30); // stickers
  const e = personInFrame(empty, W, H, {step: 2});
  assert.equal(e.present || e.holding, false, 'four stickers on white');
  const body = floor(W, H, 230);
  block(body, W, 70, 20, 22, 70, 45); // standing person shadow, ~8% of the stage
  const b = personInFrame(body, W, H, {step: 2});
  assert.ok(b.present || b.holding, JSON.stringify({f: b.bodyFraction, a: b.aspect}));
});
