// Listen gate v3 (TJ Nov 10, 10:02–10:24 AM): with music playing his phone's
// gate was open 1.8–6.8% of the time, so the dancers froze (activation 0).
// The closed gate learned the music as room noise and set its open level above
// the music. These replay his real feed and a long synthetic soak.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('../neural-dance/silence-gate.js', import.meta.url), 'utf8');
function lib() { const sb = {}; new Function('globalThis', src.replace(/^export .*/gm, ''))(sb); return sb.ndSilenceGate; }
const G = lib();
const fx = JSON.parse(readFileSync(new URL('./fixtures/listen-phone/nov10-music.json', import.meta.url), 'utf8'));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function replay(rows) {
  const g = G.create();
  let prev = rows[0][0] - 100, open = 0;
  for (const r of rows) {
    const dt = Math.min(0.1, Math.max(0.01, (r[0] - prev) / 1000)); prev = r[0];
    // The feed is ~10 Hz; the phone frames at ~30 fps, so hold each sample.
    for (let k = 0; k < 3; k++) G.scale(g, [r[1], r[3], r[4], r[5]], dt / 3);
    if (g.open) open++;
  }
  return {g, open: open / rows.length, phone: rows.reduce((s, r) => s + r[6], 0) / rows.length};
}

function silence(g, seconds, level, seed = 1) {
  const r = rng(seed); let t = 0, closeAt = null, reopened = 0;
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    t += 1 / 30; const l = level + 0.06 * (r() - 0.5);
    G.scale(g, [l, l * 0.6, l * 0.5, 0], 1 / 30);
    if (!g.open && closeAt == null) closeAt = t;
    if (closeAt != null && g.open) reopened++;
  }
  return {closeAt, reopened};
}

for (const [name, rows] of Object.entries(fx.sessions)) {
  test('phone replay ' + name + ': open > 90% during his music, then real silence closes in < 1 s', () => {
    const {g, open, phone} = replay(rows);
    assert.ok(open > 0.9, name + ' open ' + (100 * open).toFixed(1) + '% (phone build was ' + (100 * phone).toFixed(1) + '%)');
    const lows = rows.map(r => r[1]).sort((a, b) => a - b);
    const s = silence(g, 10, lows[Math.floor(lows.length * 0.05)] * 0.5);
    assert.ok(s.closeAt != null && s.closeAt < 1.0, 'silence closed after ' + s.closeAt);
    assert.equal(s.reopened, 0, 'room noise never reopens it');
    assert.ok(g.noiseFloor <= G.FLOOR_MAX);
  });
}

test('failsafe: onsets arriving while closed force the gate open within ~2 s', () => {
  const g = G.create();
  // Learn a floor that is (wrongly) right at the music level.
  for (let i = 0; i < 300; i++) G.scale(g, [1.0, 0.5, 0.4, 0], 1 / 30);
  g.open = false; g.samples = Array(90).fill(1.0); g.noiseFloor = 1.0; g.noiseHigh = 1.3; g.learned = true; g.music = 1.1;
  let openAt = null;
  for (let i = 0; i < 150 && openAt == null; i++) {
    const t = i / 30, hit = (t % 0.55) < 0.04;
    G.scale(g, [hit ? 1.3 : 1.0, 0.5, 0.4, 0], 1 / 30);
    if (g.open) openAt = t;
  }
  assert.ok(openAt != null && openAt <= 2.3, 'forced open after ' + openAt);
});

test('soak: 6 minutes of music with quiet passages and real pauses never drops out mid-song', () => {
  const g = G.create(), r = rng(42);
  const DT = 1 / 30;
  // Song plan (seconds): loud, quiet verse (-8 dB-ish), loud, break with soft hat only, loud, 3 s pause, ...
  const plan = [];
  for (let k = 0; k < 6; k++) plan.push(['loud', 30], ['quiet', 15], ['loud', 10], ['sparse', 6], [k % 2 ? 'pause' : 'loud', k % 2 ? 3 : 4]);
  let t = 0, musicFrames = 0, musicOpen = 0, longestGap = 0, gap = 0, pauseClose = [];
  for (const [kind, dur] of plan) {
    let closedAt = null;
    for (let i = 0; i < Math.round(dur / DT); i++, t += DT) {
      const ph = t % 0.5, kick = ph < 0.06, hat = (t % 0.25) < 0.03;
      let lv;
      if (kind === 'loud') lv = (kick ? 1.6 : 1.0) + 0.15 * r();
      else if (kind === 'quiet') lv = (kick ? 0.95 : 0.6) + 0.1 * r();
      else if (kind === 'sparse') lv = (hat ? 0.75 : 0.45) + 0.08 * r();
      else lv = 0.25 + 0.06 * r();
      G.scale(g, [lv, lv * 0.6, lv * 0.5, kind === 'sparse' && hat ? lv : 0.1], DT);
      if (kind === 'pause') { if (!g.open && closedAt == null) closedAt = i * DT; continue; }
      musicFrames++;
      if (g.open) { musicOpen++; gap = 0; } else { gap += DT; longestGap = Math.max(longestGap, gap); }
    }
    if (kind === 'pause') pauseClose.push(closedAt);
    gap = 0;
  }
  assert.ok(musicOpen / musicFrames > 0.97, 'open ' + (100 * musicOpen / musicFrames).toFixed(1) + '% of music');
  assert.ok(longestGap <= 1.0, 'longest mid-music dropout ' + longestGap.toFixed(2) + ' s');
  assert.ok(pauseClose.every(c => c != null && c < 1.0), 'pauses close in < 1 s: ' + pauseClose.map(c => c && c.toFixed(2)).join(', '));
  assert.ok(g.noiseFloor < 0.6, 'floor stays at the room, not the music: ' + g.noiseFloor.toFixed(2));
});
