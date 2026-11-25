// Breakdown / build / drop detector (TJ Nov 11 2026 live-feed session).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBreakdownDetector, BIG_DROP_BARS} from '../neural-dance/src/breakdown-detect.js';

const BPM = 120, BEAT = 500, BAR = 2000, FRAME = 1000 / 60;
// sections: [{bars, kind}] kind 'groove' | 'break' | 'silence' | 'fill' (break with one weak kick)
function run(sections, {onFrame} = {}) {
  const det = createBreakdownDetector();
  const events = [];
  let t = 1000;
  for (const sec of sections) {
    const t0 = t, t1 = t + sec.bars * BAR;
    let nextBeat = t0;
    for (; t < t1; t += FRAME) {
      const u = (t - t0) / (t1 - t0);
      let lv = [0, 0, 0, 0], glv = 0, gate = true, onsets = 0;
      if (sec.kind === 'groove') { lv = [0.6, 0.35, 0.15, 0]; glv = 0.85; }
      if (sec.kind === 'break' || sec.kind === 'fill') { lv = [0.12, 0.02, 0.15 + 0.2 * u, 0]; glv = 0.25 + 0.4 * u; }
      if (sec.kind === 'silence') { gate = false; glv = 0.02; }
      if (t >= nextBeat) {
        nextBeat += BEAT;
        if (sec.kind === 'groove') { onsets |= 1; lv[0] = 0.9; }
        if (sec.kind === 'break' && u > 0.5) onsets |= 4;           // snare roll in the build
        if (sec.kind === 'fill' && Math.abs(u - 0.5) < 0.02) { onsets |= 1; lv[0] = 0.35; } // lone weak fill kick
      }
      const r = det.process({t, lv, onsets, gate, glv, bpm: BPM});
      if (r.event) events.push({...r.event, at: t});
      if (onFrame) onFrame(t, r, sec);
    }
  }
  return events;
}

test('breakdown is found within ~2 bars, build progress rises, drop fires on the first kick back', () => {
  const prog = [];
  const ev = run([{bars: 16, kind: 'groove'}, {bars: 16, kind: 'break'}, {bars: 8, kind: 'groove'}], {onFrame: (t, r) => { if (r.state === 'breakdown') prog.push(r.progress); }});
  const bd = ev.filter(e => e.type === 'breakdown'), dr = ev.filter(e => e.type === 'drop');
  assert.equal(bd.length, 1, JSON.stringify(ev));
  assert.equal(dr.length, 1, JSON.stringify(ev));
  const breakStart = 1000 + 16 * BAR, dropAt = breakStart + 16 * BAR;
  assert.ok(bd[0].t - breakStart <= 3 * BAR, 'breakdown confirmed by bar 3');
  assert.ok(dr[0].t - dropAt < 60, 'drop on the returning kick (' + (dr[0].t - dropAt).toFixed(0) + ' ms)');
  assert.equal(dr[0].big, true);
  assert.equal(dr[0].onPhrase, true, 'lands on the 16-bar boundary');
  assert.equal(dr[0].phraseBars, 16);
  assert.ok(prog.at(-1) > 0.55 && prog.at(-1) > prog[0] + 0.3, 'progress builds ' + prog[0] + ' -> ' + prog.at(-1));
});

test('one missing bar is not a breakdown', () => {
  const ev = run([{bars: 16, kind: 'groove'}, {bars: 1, kind: 'break'}, {bars: 8, kind: 'groove'}]);
  assert.equal(ev.filter(e => e.type === 'breakdown' || e.type === 'drop').length, 0, JSON.stringify(ev));
});

test('a lone weak fill kick does not end the breakdown', () => {
  const ev = run([{bars: 16, kind: 'groove'}, {bars: 16, kind: 'fill'}, {bars: 8, kind: 'groove'}]);
  const dr = ev.filter(e => e.type === 'drop');
  assert.equal(dr.length, 1, JSON.stringify(ev));
  assert.ok(dr[0].bars > 15, 'drop only at the real return (' + dr[0].bars + ' bars)');
});

test('silence between songs is a gap: no breakdown, no drop, beat-in on the new song', () => {
  const ev = run([{bars: 16, kind: 'groove'}, {bars: 2, kind: 'silence'}, {bars: 4, kind: 'break'}, {bars: 8, kind: 'groove'}]);
  const types = ev.map(e => e.type);
  assert.ok(types.includes('gap'), types.join());
  assert.ok(!types.includes('breakdown') && !types.includes('drop'), types.join());
  assert.ok(types.includes('beatIn'), types.join());
});

test('a short 2-3 bar break returns without the big jump', () => {
  const ev = run([{bars: 16, kind: 'groove'}, {bars: 3, kind: 'break'}, {bars: 8, kind: 'groove'}]);
  const dr = ev.filter(e => e.type === 'drop');
  assert.equal(dr.length, 1, JSON.stringify(ev));
  assert.ok(dr[0].bars < BIG_DROP_BARS && dr[0].big === false);
});

test('a breakdown whose low end fades back without a kick onset ends with breakdownEnd (tempo re-check hook)', () => {
  const det = createBreakdownDetector();
  const ev = [];
  let t = 1000, nb = t;
  const step = (lv, glv, kick) => { const r = det.process({t, lv, onsets: kick ? 1 : 0, gate: true, glv, bpm: BPM}); if (r.event) ev.push(r.event); t += FRAME; };
  for (; t < 1000 + 16 * BAR;) { const k = t >= nb; if (k) nb += BEAT; step([k ? 0.9 : 0.6, 0.35, 0.15, 0], 0.85, k); }
  const b0 = t; for (; t < b0 + 8 * BAR;) step([0.12, 0.02, 0.2, 0], 0.3, false);
  const r0 = t; for (; t < r0 + 4 * BAR;) step([0.62, 0.3, 0.15, 0], 0.8, false); // blend: low end back, no onset
  const types = ev.map(e => e.type);
  assert.ok(types.includes('breakdown'), types.join());
  const end = ev.find(e => e.type === 'breakdownEnd');
  assert.ok(end && end.reason === 'lowReturnedNoDrop', JSON.stringify(ev));
  assert.ok(!types.includes('drop'));
});

// --- Build / drop cues (TJ Nov 11 11:08 PM): riser, snare roll, flux,
// pre-drop cutoff, per-song drop memory. Light: O(1) per frame.
function stream() {
  const det = createBreakdownDetector();
  const out = {ev: [], frames: []};
  let t = 1000, nb = 1000;
  const api = {
    get t() { return t; },
    groove(bars) { const e = t + bars * BAR; while (t < e) { const k = t >= nb; if (k) nb += BEAT; api.f([k ? 0.9 : 0.6, 0.35, 0.15, 0.05], 0.85, k ? 1 : 0); } },
    // breakdown body: shape(u) -> {lv, glv, onsets}
    section(bars, shape) { const t0 = t, e = t + bars * BAR; while (t < e) { const u = (t - t0) / (e - t0); const s = shape(u, t - t0); api.f(s.lv, s.glv, s.onsets | 0, s.gate); } },
    f(lv, glv, onsets, gate = true) { const r = det.process({t, lv, onsets, gate, glv, bpm: BPM}); if (r.event) out.ev.push({...r.event, at: t}); out.frames.push({t, ...r}); t += FRAME; },
    out
  };
  return api;
}
const flat = () => ({lv: [0.12, 0.02, 0.2, 0.02], glv: 0.35});
const lastProg = (fr, t0, t1) => { const f = fr.filter(x => x.t >= t0 && x.t < t1 && x.state === 'breakdown'); return f.length ? f[f.length - 1].progress : 0; };

test('riser: rising centroid + high band over the last bars raises build progress', () => {
  const a = stream(); a.groove(16); const s0 = a.t; a.section(8, flat);
  const b = stream(); b.groove(16); const s1 = b.t; b.section(8, u => ({lv: [0.12, 0.02, 0.2 + 0.35 * u, 0.02 + 0.4 * u], glv: 0.35}));
  const pa = lastProg(a.out.frames, s0, s0 + 8 * BAR), pb = lastProg(b.out.frames, s1, s1 + 8 * BAR);
  const cue = b.out.frames.filter(x => x.cues).at(-1).cues;
  assert.ok(cue.riser > 0.5, 'riser cue ' + JSON.stringify(cue));
  assert.ok(pb > pa + 0.15, `riser progress ${pb} vs flat ${pa}`);
});

test('snare roll: 4 → 8 → 16 hits per bar is a strong build cue', () => {
  const a = stream(); a.groove(16); const s0 = a.t; a.section(8, flat);
  const b = stream(); b.groove(16); const s1 = b.t;
  let next = 0;
  b.section(8, (u, ms) => { const per = u < 0.5 ? BEAT : u < 0.75 ? BEAT / 2 : BEAT / 4; let on = 0; if (ms >= next) { on = 4; next += per; } return {...flat(), onsets: on}; });
  const pa = lastProg(a.out.frames, s0, s0 + 8 * BAR), pb = lastProg(b.out.frames, s1, s1 + 8 * BAR);
  const cue = b.out.frames.filter(x => x.cues).at(-1).cues;
  assert.ok(cue.rollRate >= 3 && cue.roll > 0.7, 'roll cue ' + JSON.stringify(cue));
  assert.ok(pb > pa + 0.15, `roll progress ${pb} vs flat ${pa}`);
});

test('pre-drop cutoff: a one-beat cut moves the predicted drop to the hit and is trusted', () => {
  const a = stream(); a.groove(16); const s0 = a.t;
  a.section(7.75, u => ({lv: [0.12, 0.02, 0.2 + 0.4 * u, 0.05 + 0.3 * u], glv: 0.4 + 0.5 * u}));
  a.section(0.25, () => ({lv: [0.01, 0, 0.01, 0], glv: 0.04})); // one beat cut, gate still open
  const dropAt = a.t; a.groove(4);
  const cut = a.out.frames.find(x => x.cutoff);
  assert.ok(cut, 'cutoff seen');
  assert.ok(cut.t - (dropAt - BEAT) < 0.5 * BEAT, 'cutoff recognised within half a beat');
  assert.ok(Math.abs(cut.predictedDropAt - dropAt) < 40, `predicted ${Math.round(cut.predictedDropAt - dropAt)} ms from the hit`);
  assert.ok(cut.predictConf >= 0.85);
  const dr = a.out.ev.find(e => e.type === 'drop');
  assert.ok(dr && Math.abs(dr.t - dropAt) < 60, 'drop on the hit');
});

test('a 1.4 s silence after a build is a song gap, not a cutoff or a drop', () => {
  const a = stream(); a.groove(16);
  a.section(8, u => ({lv: [0.12, 0.02, 0.2 + 0.4 * u, 0.05 + 0.3 * u], glv: 0.4 + 0.5 * u}));
  a.section(1400 / BAR, () => ({lv: [0, 0, 0, 0], glv: 0.01, gate: false}));
  a.groove(4);
  const types = a.out.ev.map(e => e.type);
  assert.ok(!types.includes('drop'), types.join());
  assert.ok(types.includes('breakdownEnd') && a.out.ev.find(e => e.type === 'breakdownEnd').reason === 'gap', types.join());
  assert.ok(a.out.frames.filter(x => x.state === 'gap' || x.state === 'intro').every(x => !x.cutoff && x.predictConf === 0));
});

test('per-song drop memory: the second breakdown predicts the drop from the first; a song gap resets it', () => {
  const a = stream(); a.groove(16); a.section(8, flat); a.groove(16);
  const s2 = a.t; a.section(3, flat);
  const fr = a.out.frames.filter(x => x.t > s2 && x.state === 'breakdown');
  const bd2 = a.out.ev.filter(e => e.type === 'breakdown')[1];
  assert.ok(bd2, 'second breakdown');
  assert.ok(Math.abs(fr.at(-1).predictedDropAt - (bd2.start + 8 * BAR)) < 5, `memory predicts 8 bars (${((fr.at(-1).predictedDropAt - bd2.start) / BAR).toFixed(2)})`);
  assert.ok(fr.at(-1).cues.memory);
  // new song after a gap: generic 4-bar first guess again
  a.section(5, flat); a.groove(8); a.section(1600 / BAR, () => ({lv: [0, 0, 0, 0], glv: 0.01, gate: false}));
  a.groove(20); const s3 = a.t; a.section(3, flat);
  const fr3 = a.out.frames.filter(x => x.t > s3 && x.state === 'breakdown');
  const bd3 = a.out.ev.filter(e => e.type === 'breakdown').at(-1);
  assert.ok(fr3.length && !fr3.at(-1).cues.memory, 'memory reset on the gap');
  assert.ok(Math.abs(fr3.at(-1).predictedDropAt - (bd3.start + 4 * BAR)) < 5);
});

test('flux: a low-band flux spike makes a partial return a drop once the build is high', () => {
  const a = stream(); a.groove(16); a.section(14, u => ({lv: [0.12, 0.02, 0.2 + 0.4 * u, 0.05 + 0.3 * u], glv: 0.4 + 0.4 * u}));
  // partial return off the phrase line: kick back at ~60% with a big flux jump
  const at = a.t; a.f([0.55, 0.3, 0.3, 0.1], 0.6, 1, true);
  const dr = a.out.ev.find(e => e.type === 'drop');
  assert.ok(dr && Math.abs(dr.t - at) < 1 && dr.how === 'flux', JSON.stringify(a.out.ev.slice(-3)));
});

test('detector stays light: 20 minutes of frames in well under a second', () => {
  const det = createBreakdownDetector();
  const t0 = performance.now();
  for (let i = 0, t = 0; i < 72000; i++, t += FRAME) det.process({t, lv: [0.5 * Math.random(), 0.3, 0.2 * Math.random(), 0.05], onsets: (i % 30 === 0 ? 1 : 0) | (i % 7 === 0 ? 4 : 0), gate: true, glv: 0.7, bpm: 124, flux: [0.01, 0.01, 0.02, 0]});
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms for 72k frames (${(1000 * ms / 72000).toFixed(1)} µs/frame)`);
});
