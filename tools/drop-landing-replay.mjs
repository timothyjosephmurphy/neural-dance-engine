// Shared by tests/neural-dance-section-motion.test.mjs (capture drop-landing check).
// Replay a capture fixture through the detector + section motion (60 Hz frames, sample-and-hold).
export async function replayDrop(fix, root, OFF = 1e6) {
  // fixture t is relative to the window start (negative before it); the detector wants a positive clock
  const {createBreakdownDetector} = await import(root + '/neural-dance/src/breakdown-detect.js');
  const S = await import(root + '/neural-dance/src/section-motion.js');
  const det = createBreakdownDetector(), sm = S.createSectionMotion();
  const ev = [];
  fix.onsets.forEach((arr, k) => arr.forEach(t => ev.push({t: t + OFF, bit: 1 << k})));
  for (const a of fix.samples) ev.push({t: a[0] + OFF, a});
  const t0 = fix.samples[0][0] + OFF, t1 = fix.samples.at(-1)[0] + OFF;
  for (let t = t0; t < t1; t += 1000 / 60) ev.push({t, frame: true});
  ev.sort((x, y) => x.t - y.t);
  let last = fix.samples[0], drop = null, maxLift = 0, meterMax = -1, meterPeak = null, meterEarly = null;
  const lands = new Set();
  const earlyAt = (fix.dropHitMs != null ? fix.dropHitMs : 0) + OFF - 3000;
  for (const e of ev) {
    if (e.a) last = e.a;
    const r = det.process({t: e.t, lv: last[1], onsets: e.bit || 0, gate: !!last[2], glv: last[3] == null ? undefined : last[3], bpm: last[4]});
    sm.update(e.t, r);
    if (r.event && r.event.type === 'drop' && !drop) drop = r.event;
    if (sm.state.landAt >= 0) lands.add(sm.state.landAt);
    if (e.frame) {
      maxLift = Math.max(maxLift, sm.jump(e.t).lift);
      const m = S.sectionMeter({
        now: e.t, state: sm.state.state, progress: sm.state.progress, calm: sm.state.calm,
        build: sm.state.build, landAt: sm.state.landAt, predictedDropAt: r.predictedDropAt, lastDrop: sm.state.lastDrop,
      });
      if (m.level > meterMax) { meterMax = m.level; meterPeak = e.t; }
      if (meterEarly == null && e.t >= earlyAt) meterEarly = m.level;
    }
  }
  return {
    dropT: drop ? drop.t - OFF : null, drop, lands: [...lands].map(x => x - OFF), maxLift,
    meterMax, meterPeakT: meterPeak == null ? null : meterPeak - OFF, meterEarly,
  };
}
