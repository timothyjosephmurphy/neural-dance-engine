import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMelodyPadAnalyzer, MELODY_PAD, DEMO_SECTIONS, DEMO_DURATION, demoMusicFeatures, demoSectionAt } from '../neural-dance/src/melody-pad.js';

function bytesFor(peaks, fftSize = 2048, sr = 44100) {
  const n = (fftSize >> 1) + 1;
  const bytes = new Uint8Array(n);
  const hz = sr / fftSize;
  for (const { f, v } of peaks) {
    const i = Math.max(1, Math.min(n - 1, Math.round(f / hz)));
    bytes[i] = v;
    if (i > 1) bytes[i - 1] = Math.max(bytes[i - 1], Math.round(v * 0.4));
    if (i + 1 < n) bytes[i + 1] = Math.max(bytes[i + 1], Math.round(v * 0.4));
  }
  return bytes;
}

function run(det, kind, seconds, dt = 1 / 60, sr = 44100, fft = 2048) {
  const steps = Math.round(seconds / dt);
  let last = null;
  for (let i = 0; i < steps; i++) {
    let peaks;
    if (kind === 'silence') peaks = [];
    else if (kind === 'drums') {
      const t = i * dt;
      const phase = t % 0.5;
      peaks = phase < 0.05
        ? [{ f: 2200, v: 200 }, { f: 7000, v: 180 }, { f: 60, v: 200 }]
        : [];
    } else if (kind === 'pad') {
      peaks = [
        { f: 220, v: 90 },
        { f: 440, v: 140 },
        { f: 880, v: 200 },
        { f: 1320, v: 170 },
        { f: 1760, v: 130 },
        { f: 2200, v: 90 },
      ];
    } else if (kind === 'high') {
      peaks = [
        { f: 880, v: 120 },
        { f: 1320, v: 200 },
        { f: 1760, v: 180 },
        { f: 2200, v: 140 },
        { f: 2640, v: 90 },
      ];
    }
    last = det.processBytes(bytesFor(peaks, fft, sr), sr, fft, dt);
  }
  return last;
}

describe('melody/pad analyzer', () => {
  it('exposes the agreed band edges and smoothing', () => {
    assert.equal(MELODY_PAD.loHz, 500);
    assert.equal(MELODY_PAD.hiHz, 4000);
    assert.equal(MELODY_PAD.attackSec, 0.22);
    assert.equal(MELODY_PAD.releaseSec, 1.15);
    assert.ok(MELODY_PAD.contourAttackSec > 0);
  });

  it('stays down through drums-only bursts', () => {
    const det = createMelodyPadAnalyzer();
    const r = run(det, 'drums', 4);
    assert.ok(r.env < 0.08, `drums env ${r.env}`);
    assert.ok(r.note < 0.12, `drums note ${r.note}`);
  });

  it('rises on a sustained mid-high pad and holds', () => {
    const det = createMelodyPadAnalyzer();
    run(det, 'drums', 1.5);
    const mid = run(det, 'pad', 2.5);
    assert.ok(mid.env > 0.75, `pad env ${mid.env}`);
    assert.ok(mid.contour > 0, `contour ${mid.contour}`);
  });

  it('raises contour on a brighter/higher pad', () => {
    const lowR = run(createMelodyPadAnalyzer(), 'pad', 2.5);
    const highR = run(createMelodyPadAnalyzer(), 'high', 2.5);
    assert.ok(highR.contour > lowR.contour + 0.05, `high ${highR.contour} vs low ${lowR.contour}`);
  });

  it('releases after the pad ends, slower than it attacked', () => {
    const det = createMelodyPadAnalyzer();
    run(det, 'pad', 2.0);
    const after = run(det, 'silence', 0.5);
    assert.ok(after.env < 0.9, `short release env ${after.env}`);
    const later = run(det, 'silence', 3.5);
    assert.ok(later.env < 0.05, `settled env ${later.env}`);
  });
});

describe('demo music sections', () => {
  it('covers 54 seconds without gaps', () => {
    assert.equal(DEMO_DURATION, 54);
    assert.equal(DEMO_SECTIONS[0].t0, 0);
    assert.equal(DEMO_SECTIONS[DEMO_SECTIONS.length - 1].t1, 54);
    for (let i = 1; i < DEMO_SECTIONS.length; i++) {
      assert.equal(DEMO_SECTIONS[i].t0, DEMO_SECTIONS[i - 1].t1);
    }
  });

  it('keeps demo features quiet on drums and high at the peak', () => {
    const drums = demoMusicFeatures(3);
    const peak = demoMusicFeatures(33);
    const brk = demoMusicFeatures(44);
    assert.equal(drums.env, 0);
    assert.ok(peak.env > 0.9, `peak env ${peak.env}`);
    assert.ok(peak.contour > 0.7, `peak contour ${peak.contour}`);
    assert.equal(demoSectionAt(33).id, 'peak');
    assert.ok(brk.env < 0.05, `breakdown env ${brk.env}`);
  });
});
