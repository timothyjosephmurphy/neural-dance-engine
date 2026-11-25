// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural beat grid: beat phase, downbeat and meter from a Beat This!-style
// network's beat / downbeat probabilities over a sliding window, on top of the
// global tempo lock (createGlobalTempo). The network runs off the main thread;
// update() takes its output, tick() runs every frame and is O(1).
//
// Tempo authority stays with the global tempo once it locks (no regression in
// BPM stability). Before it locks the grid's own tempo is used, so the first
// beat grid appears ~1-2 s sooner.

const MIN_P = 333, MAX_P = 1000;             // 180..60 BPM
const PRIOR_BPM = 120;

function peaks(p, thr) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const v = p[i]; if (v < thr) continue;
    let ok = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(p.length - 1, i + 3); j++) if (p[j] > v || (p[j] === v && j < i)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function median(a) { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }
function fold(P) { // fold into 70..180 BPM, nearest the 120 prior
  if (!(P > 0)) return 0;
  while (P < MIN_P) P *= 2; while (P > MAX_P) P /= 2;
  const c = [P, P * 2, P / 2].filter(q => q >= MIN_P && q <= MAX_P);
  c.sort((a, b) => Math.abs(Math.log2(60000 / a / PRIOR_BPM)) - Math.abs(Math.log2(60000 / b / PRIOR_BPM)));
  return c[0];
}
// Least-squares beat period of beat times that sit ~Pn apart (missed beats ok).
function fitPeriod(ts, Pn) {
  if (ts.length < 4 || !(Pn > 0)) return NaN;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const t of ts) { const x = Math.round((t - ts[0]) / Pn); n++; sx += x; sy += t; sxx += x * x; sxy += x * t; }
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : NaN;
}
const wrap = (x, P) => ((x % P) + 1.5 * P) % P - 0.5 * P; // to [-P/2, P/2)

export function createBeatGrid(opts = {}) {
  const thr = opts.threshold ?? 0.5, gain = opts.phaseGain ?? 0.7, edgeMs = opts.edgeMs ?? 40;
  const st = {locked: false, period: 0, ref: 0, next: 0, k: 0, meter: 0, downIdx: 0, downConf: 0, cand: -1, candN: 0, own: false, lastUpdate: -1e12, beat: false, downbeat: false, bpm: 0, conf: 0, rawConf: 0, barBeat: -1, bar: 0, beatAt: -1, trim: 0};
  function reset() { Object.assign(st, {locked: false, period: 0, ref: 0, next: 0, k: 0, meter: 0, downIdx: 0, downConf: 0, cand: -1, candN: 0, own: false, lastUpdate: -1e12, beat: false, downbeat: false, bpm: 0, conf: 0, rawConf: 0, barBeat: -1, bar: 0, beatAt: -1, trim: 0}); }
  // now: ms when this result is applied; tEnd: ms of the last audio frame in the window;
  // t0: ms of frame 0; fps: frames/s; bp/dp: probabilities; gtPeriod: global tempo period (0 = unlocked).
  function update(now, tEnd, t0, fps, bp, dp, gtPeriod) {
    const dt = 1000 / fps, lim = tEnd - edgeMs;
    const bts = peaks(bp, thr).map(i => t0 + i * dt).filter(t => t < lim);
    const dts = peaks(dp, thr).map(i => t0 + i * dt).filter(t => t < lim);
    if (bts.length < 4) return;
    st.lastUpdate = now;
    const iois = []; for (let i = 1; i < bts.length; i++) iois.push(bts[i] - bts[i - 1]);
    const raw = median(iois.slice(-8));
    let P = gtPeriod > 0 ? gtPeriod : fold(raw);
    st.own = !(gtPeriod > 0);
    if (!(P > 0)) return;
    if (st.own) { // own tempo needs consistent spacing
      const dev = iois.slice(-6).map(x => Math.abs(x / raw - 1)); if (median(dev) > 0.08) return;
    }
    // Phase: circular mean of beat times on the network's own grid (Pn), then,
    // when the network runs at a multiple of the shown tempo (8ths vs quarters,
    // or 6/8 eighths), pick the sub-grid offset its downbeats / strongest beats sit on.
    const Pn = raw > 0 ? raw : P;
    const r = Math.round(P / Pn), sub = r >= 2 && r <= 4 && Math.abs(P / (Pn * r) - 1) < 0.08 ? r : 1;
    // Frequency trim (drifting music; the global tempo lags it): the network's
    // own beat period by least squares over the window, kept within +/-3% of P.
    {
      const tr = fitPeriod(bts.filter(t => lim - t < 6000), Pn) * sub / P - 1;
      if (Number.isFinite(tr) && Math.abs(tr) < 0.035) st.trim += (Math.max(-0.03, Math.min(0.03, tr)) - st.trim) * 0.6;
      else st.trim *= 0.5;
    }
    const Pg = P * (1 + st.trim) / sub;
    const ref = bts[bts.length - 1];
    let sx = 0, sy = 0;
    for (const t of bts) { const w = Math.exp((t - lim) / 3000); const a = 2 * Math.PI * (t - ref) / Pg; sx += w * Math.cos(a); sy += w * Math.sin(a); }
    let phase = ref + Math.atan2(sy, sx) / (2 * Math.PI) * Pg;
    if (sub > 1) {
      const score = new Float64Array(sub);
      const bpk = peaks(bp, thr);
      for (const i of bpk) { const t = t0 + i * dt; const j = ((Math.round((t - phase) / Pg) % sub) + sub) % sub; score[j] += bp[i] * 0.25; }
      for (const t of dts) { const j = ((Math.round((t - phase) / Pg) % sub) + sub) % sub; score[j] += 2 * Math.exp((t - lim) / 4000); }
      if (st.locked) { const j = ((Math.round((st.next - phase) / Pg) % sub) + sub) % sub; score[j] += 0.5; } // inertia
      let best = 0; for (let j = 1; j < sub; j++) if (score[j] > score[best]) best = j;
      phase += best * Pg;
    }
    if (!st.locked || Math.abs(P / st.period - 1) > 0.12) {
      st.period = P * (1 + st.trim); st.ref = phase; st.locked = true;
      st.next = phase + P * Math.ceil((now - phase) / P - 0.02); st.k = Math.round((st.next - st.ref) / P);
    } else {
      st.period = P * (1 + st.trim);
      const exp = st.next - st.period * Math.round((st.next - phase) / st.period);
      const e = wrap(phase - exp, st.period);
      st.next += gain * e;
    }
    // Confidence (0..1): how many of the network's recent beats sit on the
    // grid (within 10% of a beat) times how sure it was about them. Smoothed
    // over updates so one odd window cannot flip who drives the dancers.
    {
      const bpk = peaks(bp, thr); let on = 0, n = 0, pSum = 0;
      for (const i of bpk) {
        const t = t0 + i * dt; if (t >= lim || lim - t > 6000) continue;
        n++; const e = Math.abs(wrap(t - st.next, Pg));
        if (e < 0.1 * Pg) { on++; pSum += bp[i]; }
      }
      const expect = Math.min(6000, lim - t0) / Pg;
      const cover = expect > 0 ? Math.min(1, on / (expect * 0.8)) : 0;
      const c = n ? (on / n) * Math.min(1, (on ? pSum / on : 0) / 0.7) * cover : 0;
      st.rawConf = c;
      st.conf = st.conf > 0 ? st.conf * 0.4 + c * 0.6 : c * 0.6;
    }
    // Downbeats -> meter + bar phase (beat index of the bar start).
    if (dts.length >= 2) {
      const m = Math.round(median(dts.slice(1).map((t, i) => t - dts[i])) / P);
      if (m >= 2 && m <= 7) st.meter = m;
    } else if (!st.meter && dts.length) st.meter = 4;
    if (st.meter && dts.length) {
      const votes = new Float64Array(st.meter);
      const kNext = st.k; // index of st.next
      for (const t of dts) { const kk = kNext - Math.round((st.next - t) / P); votes[((kk % st.meter) + st.meter) % st.meter] += Math.exp((t - lim) / 4000); }
      let best = 0; for (let i = 1; i < st.meter; i++) if (votes[i] > votes[best]) best = i;
      if (best === st.downIdx % st.meter) { st.candN = 0; }
      else if (best === st.cand) { if (++st.candN >= 1) { st.downIdx = best; st.candN = 0; } }
      else { st.cand = best; st.candN = 0; if (!st.downConf) st.downIdx = best; }
      st.downConf = 1;
    }
  }
  function tick(now, gtPeriod) {
    st.beat = false; st.downbeat = false;
    if (!st.locked) { st.bpm = 0; st.conf = 0; return st; }
    if (gtPeriod > 0) st.period = gtPeriod * (1 + st.trim);
    if (now - st.lastUpdate > 4000) { st.locked = false; st.bpm = 0; st.conf = 0; return st; }
    while (st.next < now - st.period) { st.next += st.period; st.k++; }
    if (now >= st.next - 8) {
      st.beat = true;
      const m = st.meter || 4;
      st.barBeat = ((st.k - st.downIdx) % m + m) % m;
      st.bar = Math.floor((st.k - st.downIdx) / m);
      if (st.meter && st.barBeat === 0 && st.downConf) st.downbeat = true;
      st.beatAt = st.next;
      st.next += st.period; st.k++;
    }
    st.bpm = Math.round(60000 / st.period * 10) / 10;
    return st;
  }
  return {update, tick, reset, state: st};
}
