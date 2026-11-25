// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// ND Listen v2: groove learning (TJ Nov 12 "beat pattern learning").
// Sits on top of the live beat clock (beat-entrain.js: one locked BPM per
// song, phase from heard onsets; global-tempo.js before the song lock) and
// learns, online, where the bar and the phrase are and what the groove is:
//
//   1. Music frame: its own continuous beat count, seeded from the clock
//      and kept on the heard kick / bass / snare by a per-beat phase /
//      period loop (follows drift; ignores the clock's jumps), so what was
//      learned stays put when the clock is re-placed.
//   2. Groove histogram: every heard band onset goes on a 16th-note grid of
//      that frame, into a per-band histogram over 48 sixteenths (12 beats =
//      3 bars of 4/4 = 4 bars of 3/4) that fades over ~10 bars.
//   3. Meter: how much of the histogram repeats every 16 vs every 12
//      sixteenths, with a strong 4/4 prior and hysteresis. Half-time feel =
//      the snare on 3, not on 2 and 4.
//      (3/4 is reported but never drives the 4-beat dancers.)
//   4. Downbeat (BeatNet-style joint beat / bar inference, with template
//      matching instead of a network): every eighth-note position is a
//      candidate bar start, so a clock that sits half a beat off (on the
//      hats or an off-beat bass) is caught too. Each candidate is scored on
//      canonical kick / snare / bass placements (four-on-the-floor, rock,
//      half-time, breakbeat, dembow), kick and bass on 1, the bar-to-bar
//      rise (crashes, new parts and fill endings land on 1) and a weak "the
//      song started on a downbeat" prior. Evidence accumulates; the bar
//      start only moves after it loses for two bars.
//   5. Groove template: per band, the 16-step accent pattern of the bar and
//      the swing of the off-beat eighths.
//   6. Phrase: 4 / 8 / 16 bars. A fill (extra hits late in a bar) then a
//      crash / new part on the next 1 marks a phrase start; until three
//      8-bar phrases of that are heard, 8-bar phrases are counted from the
//      bar the song started in (tracks start on a phrase).
//   7. Attunement: confidence = bars heard x downbeat margin x how well the
//      last bars matched the template. A bar that does not match (a fill, a
//      break, a new song blended in) lowers it at once; two in a row halve
//      the histogram so a new groove is learned in a few bars. A song gap or
//      a new tempo starts over.
//
// Conservative by design: consumers use the groove only at confidence >=
// GROOVE_ENTER (and keep it until it falls below GROOVE_EXIT); below that
// the existing beat clock is used unchanged. Work is per onset and per
// eighth note (a few thousand multiply-adds per beat at most), a phase read
// per frame, no allocation after construction.

export const GROOVE_ENTER = 0.6;
export const GROOVE_EXIT = 0.4;
export const STEPS = 16;          // sixteenths per 4/4 bar
const RING = 48;                  // sixteenths in the histogram (LCM of 12 and 16)
const E8 = 24;                    // eighths in the histogram
const NB = 4;                     // bands: kick, bass, mid (snare), hat
const DECAY = 0.985;              // per beat (half-life ~46 beats ~ 11 bars)
const RISE_DECAY = 0.995;         // per beat: rare cues (crashes, fills) are kept longer
const PLACE_TOL = 0.35;           // of a sixteenth: farther = not on this grid
const BAND_W = [1, 0.8, 1, 0.5];
const GAP_MS = 2500;              // no onsets this long = song gap: start over
const TEMPO_JUMP = 0.06;          // clock period change that counts as a new tempo
const PLL_P = 0.35, PLL_F = 0.04;  // frame phase / period gains per beat
const PLL_W = [1, 0.5, 0.8];
const OFFBEAT_PRIOR = 0.25;       // evidence needed to say the clock is half a beat off
const MARGIN_MIN = 0.1, MARGIN_FULL = 0.25; // downbeat evidence lead over the runner-up
const PHRASE_LENS = [4, 8, 16];
const NOV_BARS = 64;
const CLOSE_LAG_MS = 80;          // an eighth closes this long after it passes

const STYLES = [
  {k: [0, 4, 8, 12], s: [4, 12], b: [2, 6, 10, 14]},        // four-on-the-floor, off-beat bass
  {k: [0, 8, 10], s: [4, 12], b: [0, 8, 10]},               // rock / pop
  {k: [0, 10], s: [8], b: [0, 10]},                         // half-time
  {k: [0, 6, 10], s: [4, 12], b: [0, 6, 10]},               // breakbeat / hip-hop
  {k: [0, 4, 8, 12], s: [3, 6, 11, 14], b: [0, 3, 8, 11]}   // dembow / reggaeton
];
function styleVec(steps, n) { const v = new Float32Array(n); for (const s of steps) if (s < n) v[s] = 1; return v; }
const STYLE_V = STYLES.map(s => ({k: styleVec(s.k, 16), s: styleVec(s.s, 16), b: styleVec(s.b, 16)}));
const STYLE3_V = {k: styleVec([0], 12), s: styleVec([4, 8], 12), b: styleVec([0], 12)};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function mod(a, n) { return ((a % n) + n) % n; }

export function createGrooveLearner(opts = {}) {
  const H = new Float32Array(NB * RING);        // groove histogram (frame sixteenth mod 48)
  const barObs = new Float32Array(NB * RING);   // onsets heard since the cell was last read
  const swingH = new Float32Array(24);          // off-beat position inside the beat
  const energy8 = new Float32Array(48);         // onset energy per frame eighth (mod 48)
  const rise4 = new Float32Array(E8);           // rise over the same eighth one 4/4 bar earlier
  const rise3 = new Float32Array(E8);           // ... one 3/4 bar earlier
  const offScore = new Float32Array(8);         // downbeat evidence per eighth offset (EMA)
  const tmpl = new Float32Array(NB * STEPS);    // learned bar template (from the downbeat)
  const cand = new Float32Array(NB * STEPS);
  const nov = new Float32Array(NOV_BARS);
  const novBar = new Int32Array(NOV_BARS).fill(-1);
  const lastBarVec = new Float32Array(NB * STEPS);
  const curBarVec = new Float32Array(NB * STEPS);
  const accent = new Float32Array(NB);
  const st = {
    P: 0, A: 0, Pf: 0, t0: 0, b0: 0, px: 0, pw: 0, have: false, lastE8: 0, beats: 0, bars: 0, meter: 4, meter3: 0, down8: 0, downLose: 0,
    margin: 0, downSince: 0, fit: 0.5, badBars: 0, surprises: 0, halfTime: false, swing: 0.5, conf: 0, active: false,
    songStart: -1, prevEndDev: 0, firstOnsetT: Infinity, startBeat: NaN, lastOnset: -1e12, lastBarE8: -1e9,
    phraseBars: 8, phraseOff: 0, phraseConf: 0, phraseFromNovelty: false, relearns: 0, resets: 0,
    cost: 0, steps: 0
  };
  const out = {active: false, confidence: 0, meter: 4, halfTime: false, beat: -1, beatInBar: -1, barPhase: 0, bar: -1,
    phraseBars: 8, barInPhrase: -1, phrasePhase: 0, phraseConfidence: 0, swing: 0.5, fit: 0, clockShift: 0,
    downbeat: false, phraseStart: false, beatEdge: false, downbeatAt: -1, nextDownbeatAt: -1, nextPhraseAt: -1, template: tmpl, accent};

  function resetLearning() {
    H.fill(0); barObs.fill(0); swingH.fill(0); energy8.fill(0); rise4.fill(0); rise3.fill(0); offScore.fill(0); tmpl.fill(0);
    nov.fill(0); novBar.fill(-1); lastBarVec.fill(0); curBarVec.fill(0);
    st.beats = 0; st.bars = 0; st.downSince = 0; st.meter3 = 0; st.meter = 4; st.down8 = 0; st.downLose = 0; st.margin = 0; st.fit = 0.5; st.badBars = 0;
    st.halfTime = false; st.swing = 0.5; st.conf = 0; st.phraseBars = 8; st.phraseOff = 0; st.phraseConf = 0; st.phraseFromNovelty = false;
    st.lastBarE8 = -1e9;
  }
  function reset() {
    resetLearning();
    st.P = 0; st.A = 0; st.Pf = 0; st.t0 = 0; st.b0 = 0; st.have = false; st.lastE8 = 0; st.songStart = -1; st.firstOnsetT = Infinity; st.startBeat = NaN;
    st.active = false; st.lastOnset = -1e12; st.resets++;
    out.active = false; out.confidence = 0;
  }

  // Music frame: beat(t) = b0 + (t - t0) / Pf, its own phase / period
  // loop on the heard kick / bass / snare (so a clock that is a fraction of
  // a beat off, or a tempo that drifts under a locked BPM, does not smear
  // what is learned). The clock only seeds it and signals a new tempo.
  function beatAt(t) { return st.b0 + (t - st.t0) / st.Pf; }
  function seedFrame(now, P, A) {
    st.Pf = P; st.t0 = now;
    st.b0 = (now - A) / P; // frame beats sit on the clock's beats at the start
    st.startBeat = NaN;    // re-read the song start in the new frame
    st.lastE8 = Math.floor(beatAt(now - CLOSE_LAG_MS) * 2);
  }
  function follow(now, P, A) {
    if (!(P > 0)) { st.have = false; return false; }
    const newTempo = !(st.P > 0) || Math.abs(P / st.P - 1) > TEMPO_JUMP;
    if (newTempo) {
      if (st.beats) { st.relearns++; const m = st.meter; resetLearning(); st.meter = m; }
      st.P = P; st.A = A; seedFrame(now, P, A); st.have = true;
      return true;
    }
    st.P = P; st.A = A; st.have = true;
    return true;
  }
  // Frame loop, once per beat: mean offset of the kick / bass / snare hits
  // from their eighth-note grid places (swung off-beats at the learned
  // swing). Pulls the frame onto the music from a seed within ~0.2 beat and
  // follows tempo drift under a locked BPM.
  function pll(now) {
    if (st.pw > 1.5) {
      const err = st.px / st.pw; // beats the hits sit after the frame's grid
      const b = beatAt(now);
      st.Pf = clamp(st.Pf * (1 + PLL_F * err), st.P * 0.9, st.P * 1.1);
      st.t0 = now; st.b0 = b - PLL_P * err;
    }
    st.px *= 0.5; st.pw *= 0.5;
  }


  function placeOnset(t, w, b, now) {
    const x = beatAt(t) * 4;
    const k = Math.round(x), dev = x - k;
    if (b < 3) {
      // Frame loop input: how far this hit sits from its grid eighth (the
      // off-beat eighth at the learned swing); trimmed so fills / ghost
      // notes do not pull.
      const xb = beatAt(t), f = xb - Math.floor(xb);
      const r = f < 0.25 ? f : f > 0.8 ? f - 1 : f - st.swing;
      if (Math.abs(r) < 0.25) { const pw = PLL_W[b] * clamp(w, 0.5, 1.5); st.px += pw * r; st.pw += pw; }
    }
    if (Math.abs(dev) > PLACE_TOL) return;
    const i = b * RING + mod(k, RING);
    const ww = BAND_W[b] * clamp(w, 0.5, 2);
    H[i] += ww;
    if (ww > barObs[i]) barObs[i] = ww;
    if (b >= 2) { const u = mod(x / 4, 1); if (u > 0.4 && u < 0.85) swingH[Math.min(23, Math.floor(u * 24))] += ww; }
    energy8[mod(Math.floor(x / 2 + 0.3), 48)] += ww;
  }

  function foldR(n) {
    let num = 0, den = 0;
    for (let b = 0; b < NB; b++) {
      const o = b * RING;
      let mean = 0; for (let i = 0; i < RING; i++) mean += H[o + i]; mean /= RING;
      let tot = 0; for (let i = 0; i < RING; i++) { const d = H[o + i] - mean; tot += d * d; }
      if (!(tot > 1e-6)) continue;
      let between = 0;
      const reps = RING / n;
      for (let p = 0; p < n; p++) { let m = 0; for (let r = 0; r < reps; r++) m += H[o + p + r * n]; m /= reps; between += reps * (m - mean) * (m - mean); }
      num += BAND_W[b] * between; den += BAND_W[b] * tot;
    }
    return den > 0 ? num / den : 0;
  }

  // Folded bar template for meter M starting at frame eighth o8, per band
  // normalised to its max.
  function buildTemplate(M, o8, dst) {
    const n = 4 * M, reps = RING / n;
    for (let b = 0; b < NB; b++) {
      let mx = 0;
      for (let p = 0; p < n; p++) {
        let m = 0; for (let r = 0; r < reps; r++) m += H[b * RING + mod(p + 2 * o8 + r * n, RING)];
        dst[b * STEPS + p] = m; if (m > mx) mx = m;
      }
      for (let p = n; p < STEPS; p++) dst[b * STEPS + p] = 0;
      if (mx > 0) for (let p = 0; p < n; p++) dst[b * STEPS + p] /= mx;
    }
    return dst;
  }
  function corr(a, ao, v, n) {
    let ma = 0, mv = 0; for (let i = 0; i < n; i++) { ma += a[ao + i]; mv += v[i]; } ma /= n; mv /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const x = a[ao + i] - ma, y = v[i] - mv; sxy += x * y; sxx += x * x; syy += y * y; }
    return sxx > 1e-6 && syy > 1e-6 ? sxy / Math.sqrt(sxx * syy) : 0;
  }
  // Distance (0 on a clock beat .. 1 half a beat off) of frame eighth o8.
  function offClock(o8) { const x = mod(o8 / 2 - beatAt(st.A), 1); return 2 * Math.min(x, 1 - x); }

  function downbeatScore(M, o8, parts = null) {
    buildTemplate(M, o8, cand);
    let s = 0, style;
    if (M === 4) {
      style = -1;
      for (const v of STYLE_V) {
        const f = corr(cand, 0, v.k, 16) + 1.1 * corr(cand, 2 * STEPS, v.s, 16) + 0.3 * corr(cand, STEPS, v.b, 16);
        if (f > style) style = f;
      }
    } else style = corr(cand, 0, STYLE3_V.k, 12) + 1.1 * corr(cand, 2 * STEPS, STYLE3_V.s, 12) + 0.3 * corr(cand, STEPS, STYLE3_V.b, 12);
    s += style;
    let kOn = 0, bOn = 0; for (let j = 0; j < M; j++) { kOn += cand[4 * j]; bOn += cand[STEPS + 4 * j]; }
    kOn /= M; bOn /= M;
    const kick1 = cand[0] - kOn, bass1 = cand[STEPS] - bOn;
    s += 0.6 * kick1 + 0.3 * bass1;
    // Bar-to-bar rise at the candidate bar start; the eighths before it
    // (a fill) count half.
    const R = M === 4 ? rise4 : rise3;
    let rMean = 0; for (let j = 0; j < E8; j++) rMean += R[j]; rMean /= E8;
    const reps = E8 / (2 * M);
    let rAt = 0, rPre = 0;
    for (let r = 0; r < reps; r++) { const base = o8 + r * 2 * M; rAt += R[mod(base, E8)]; rPre += 0.5 * (R[mod(base - 1, E8)] + R[mod(base - 2, E8)]); }
    rAt /= reps; rPre /= reps;
    const rise = rMean > 1e-3 ? clamp((rAt + 0.5 * rPre - 1.5 * rMean) / (1.5 * rMean), -1, 2) : 0;
    s += 0.35 * rise;
    let start = 0;
    if (Number.isFinite(st.startBeat) && st.bars < 16) {
      const sb = mod(Math.round(st.startBeat * 2), 2 * M);
      if (sb === mod(o8, 2 * M)) start = 0.1 * (1 - st.bars / 16);
    }
    s += start;
    const clockPen = OFFBEAT_PRIOR * offClock(o8);
    s -= clockPen;
    if (parts) Object.assign(parts, {style, kick1, bass1, rise, start, clockPen});
    return s;
  }

  // One beat of the frame has ended (frame eighth e8 is the new beat).
  function onBeat(e8) {
    pll(st.nowT);
    for (let i = 0; i < H.length; i++) H[i] *= DECAY;
    for (let i = 0; i < 24; i++) swingH[i] *= DECAY;
    for (let j = 0; j < E8; j++) { rise4[j] *= RISE_DECAY; rise3[j] *= RISE_DECAY; }
    st.beats++;
    if (st.beats < 4) return;
    const r16 = foldR(16), r12 = foldR(12);
    const vote3 = r12 > 0.3 && r12 > r16 + 0.12 ? 1 : 0;
    st.meter3 += (vote3 - st.meter3) * 0.15;
    const M = st.meter === 3 ? (st.meter3 < 0.35 ? 4 : 3) : (st.meter3 > 0.7 ? 3 : 4);
    if (M !== st.meter) { st.meter = M; offScore.fill(0); st.down8 = 0; st.downSince = st.bars; }
    const n8 = 2 * M;
    for (let o = 0; o < n8; o++) offScore[o] += (downbeatScore(M, o) - offScore[o]) * 0.25;
    let best = 0; for (let o = 1; o < n8; o++) if (offScore[o] > offScore[best]) best = o;
    if (best !== st.down8) {
      if (offScore[best] > offScore[st.down8] + 0.05) { if (++st.downLose >= 2 * M || st.beats < 4 * M) { st.down8 = best; st.downLose = 0; st.downSince = st.bars; } }
    } else st.downLose = 0;
    let alt = -1e9; for (let o = 0; o < n8; o++) if (o !== st.down8 && offScore[o] > alt) alt = offScore[o];
    st.margin = offScore[st.down8] - alt;
    buildTemplate(M, st.down8, tmpl);
    if (M === 4) { const s2 = tmpl[2 * STEPS + 4] + tmpl[2 * STEPS + 12], s3 = tmpl[2 * STEPS + 8]; st.halfTime = s3 > 0.6 && s2 < 0.6 * s3; }
    else st.halfTime = false;
    let sw = 0, swW = 0; for (let i = 10; i < 20; i++) { sw += swingH[i] * (i + 0.5) / 24; swW += swingH[i]; }
    st.swing = swW > 0.5 ? clamp(sw / swW, 0.5, 0.75) : 0.5;
    void e8;
  }

  function onEighth(e8) {
    // Bar-to-bar rise for the eighth that just ended.
    const e = e8 - 1;
    let eMean = 0; for (let j = 0; j < 48; j++) eMean += energy8[j]; eMean /= 48;
    if (eMean > 1e-3 && st.beats >= 8) {
      const v = energy8[mod(e, 48)];
      rise4[mod(e, E8)] += Math.max(0, v - energy8[mod(e - 8, 48)]) / eMean;
      rise3[mod(e, E8)] += Math.max(0, v - energy8[mod(e - 6, 48)]) / eMean;
    }
    energy8[mod(e8 + 2, 48)] = 0; // reused cell (48 eighths ago)
    if (mod(e8, 2) === 0) onBeat(e8);
    const M = st.meter, n8 = 2 * M;
    if (st.beats >= 4 && mod(e8 - st.down8, n8) === 0 && e8 - st.lastBarE8 >= n8 - 1) endBar(e8, M);
  }

  // The bar [e8 - 2M, e8) ended: fit it to the template, novelty, breaks.
  function endBar(e8, M) {
    const n = 4 * M, s0 = 2 * (e8 - 2 * M);
    let have = 0;
    for (let b = 0; b < NB; b++) for (let p = 0; p < n; p++) {
      const i = b * RING + mod(s0 + p, RING);
      curBarVec[b * STEPS + p] = barObs[i]; have += barObs[i]; barObs[i] = 0;
    }
    for (let b = 0; b < NB; b++) for (let p = n; p < STEPS; p++) curBarVec[b * STEPS + p] = 0;
    st.lastBarE8 = e8;
    st.bars++;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < NB * STEPS; i++) { const x = curBarVec[i], y = tmpl[i]; sxy += x * y; sxx += x * x; syy += y * y; }
    const fit = sxx > 1e-6 && syy > 1e-6 ? sxy / Math.sqrt(sxx * syy) : 0;
    if (st.bars > 2) {
      st.fit += (fit - st.fit) * (fit < st.fit ? 0.5 : 0.25);
      if (fit < 0.45 && have > 0) {
        st.badBars++; st.surprises++;
        if (st.badBars >= 2) {
          for (let i = 0; i < H.length; i++) H[i] *= 0.5;
          for (let o = 0; o < 8; o++) offScore[o] *= 0.5;
          st.relearns++; st.badBars = 0; st.bars = Math.min(st.bars, 2); st.downSince = 0;
        }
      } else st.badBars = 0;
    }
    // Phrase marks: a fill (extra hits late in the bar) then a crash / new
    // part (extra hits on beat 1 of the next). Bar i scores endDev(i-1) +
    // startDev(i), so the phrase start is the bar after the fill.
    let endDev = 0, startDev = 0;
    for (let b = 0; b < NB; b++) {
      let mx = 0; for (let p = 0; p < n; p++) if (curBarVec[b * STEPS + p] > mx) mx = curBarVec[b * STEPS + p];
      if (mx <= 1e-6) continue;
      for (let p = 0; p < n; p++) {
        const extra = curBarVec[b * STEPS + p] / mx - tmpl[b * STEPS + p] - 0.25;
        if (extra <= 0) continue;
        if (p >= n - 4) endDev += extra; else if (p < 2) startDev += extra;
      }
    }
    const novelty = Math.min(1, (st.prevEndDev + startDev) / 2);
    st.prevEndDev = endDev;
    const barIdx = Math.floor((e8 - st.down8) / (2 * M)) - 1;
    const slot = mod(barIdx, NOV_BARS);
    nov[slot] = novelty; novBar[slot] = barIdx;
    choosePhrase(barIdx);
  }

  function startBar() {
    return Number.isFinite(st.startBeat) ? Math.floor((Math.round(st.startBeat * 2) - st.down8 + 1) / (2 * st.meter)) : 0;
  }
  function choosePhrase(lastBar) {
    const sb = startBar();
    let bestL = 8, bestO = mod(sb, 8), bestC = 0;
    let n = 0; for (let i = 0; i < NOV_BARS; i++) if (novBar[i] >= 0 && novBar[i] > lastBar - NOV_BARS) n++;
    for (let li = PHRASE_LENS.length - 1; li >= 0; li--) {
      const L = PHRASE_LENS[li];
      if (n < 3 * Math.max(L, 8)) continue; // three 8-bar phrases heard before a 4 can win
      for (let o = 0; o < L; o++) {
        let at = 0, atN = 0, rest = 0, restN = 0;
        for (let i = 0; i < NOV_BARS; i++) {
          if (novBar[i] < 0 || novBar[i] <= lastBar - NOV_BARS) continue;
          if (mod(novBar[i] - o, L) === 0) { at += nov[i]; atN++; } else { rest += nov[i]; restN++; }
        }
        if (atN < 2 || restN < 2) continue;
        const c = at / atN - rest / restN;
        if (c > (L === bestL || bestC <= 0 ? bestC : 1.25 * bestC)) { bestC = c; bestL = L; bestO = o; }
      }
    }
    const fromNov = bestC > 0.18;
    if (fromNov) { st.phraseBars = bestL; st.phraseOff = bestO; st.phraseFromNovelty = true; }
    else if (!st.phraseFromNovelty) { st.phraseBars = 8; st.phraseOff = mod(sb, 8); }
    st.phraseConf = fromNov ? clamp(bestC / 0.35, 0, 1) : Number.isFinite(st.startBeat) ? 0.5 : 0.2;
  }

  // f: {P, anchor: beat clock (audio ms; P = 0 when no clock), gateOpen,
  //     onsets (band mask), onsetTime[4] (audio ms), strength[4] (flux /
  //     threshold, ~1 = just over)}
  function step(now, f) {
    const c0 = opts.clock ? opts.clock() : 0;
    out.downbeat = false; out.phraseStart = false; out.beatEdge = false;
    const open = !!(f && f.gateOpen);
    const mask = f ? f.onsets | 0 : 0;
    if (open && mask) {
      if (now - st.lastOnset > GAP_MS || st.songStart < 0) {
        if (st.songStart >= 0) { resetLearning(); st.resets++; st.have = false; st.P = 0; }
        st.songStart = now; st.startBeat = NaN; st.firstOnsetT = Infinity;
        for (let b = 0; b < NB; b++) if (mask & (1 << b)) st.firstOnsetT = Math.min(st.firstOnsetT, f.onsetTime ? +f.onsetTime[b] : now);
      }
      st.lastOnset = now;
    }
    const running = follow(now, f ? +f.P || 0 : 0, f ? +f.anchor || 0 : 0);
    if (running && !Number.isFinite(st.startBeat) && Number.isFinite(st.firstOnsetT)) st.startBeat = beatAt(st.firstOnsetT);
    if (running && open && mask) {
      for (let b = 0; b < NB; b++) {
        if (!(mask & (1 << b))) continue;
        placeOnset(f.onsetTime ? +f.onsetTime[b] : now, f.strength ? +f.strength[b] || 1 : 1, b, now);
      }
    }
    st.nowT = now;
    if (running) {
      const ei = Math.floor(beatAt(now - CLOSE_LAG_MS) * 2);
      if (ei - st.lastE8 > 64) st.lastE8 = ei - 1; // long dropout: do not replay
      while (st.lastE8 < ei) { st.lastE8++; onEighth(st.lastE8); }
    }
    const M = st.meter;
    const quiet = now - st.lastOnset > GAP_MS;
    const cBars = clamp((st.bars - 1) / 3, 0, 1);
    const cMargin = clamp((st.margin - MARGIN_MIN) / MARGIN_FULL, 0, 1);
    const cStable = clamp((st.bars - st.downSince - 1) / 3, 0, 1); // the same bar start for a few bars
    const cFit = clamp((st.fit - 0.45) / 0.3, 0, 1);
    const conf = quiet || !running ? 0 : cBars * cStable * Math.min(cMargin, cFit);
    st.conf += (conf - st.conf) * (conf < st.conf ? 0.5 : 0.1);
    st.active = st.active ? st.conf >= GROOVE_EXIT : st.conf >= GROOVE_ENTER;
    out.active = st.active; out.confidence = Math.round(st.conf * 1000) / 1000; out.meter = M; out.halfTime = st.halfTime;
    out.swing = Math.round(st.swing * 1000) / 1000; out.fit = Math.round(st.fit * 1000) / 1000;
    out.phraseBars = st.phraseBars; out.phraseConfidence = Math.round(st.phraseConf * 1000) / 1000;
    if (running) {
      const rel = beatAt(now) - st.down8 / 2;       // beats since a downbeat (music frame)
      const bar = Math.floor(rel / M), inBar = rel - bar * M;
      const bi = Math.floor(inBar);
      const prevBeat = out.beatInBar, prevBar = out.bar;
      out.beat = Math.floor(rel); out.beatInBar = bi; out.barPhase = inBar / M; out.bar = bar;
      out.barInPhrase = mod(bar - st.phraseOff, st.phraseBars);
      out.phrasePhase = (out.barInPhrase + out.barPhase) / st.phraseBars;
      // How far the clock's beats sit from the music's beats (beats, -0.5..0.5).
      const cs = mod(beatAt(st.A) - st.down8 / 2 + 0.5, 1) - 0.5;
      out.clockShift = Math.round(cs * 1000) / 1000;
      if (prevBar >= -1e8 && (bi !== prevBeat || bar !== prevBar) && prevBeat >= 0) {
        out.beatEdge = true;
        if (bi === 0) { out.downbeat = true; if (out.barInPhrase === 0) out.phraseStart = true; }
      }
      const toBeat = t => now + (t + st.down8 / 2 - beatAt(now)) * st.Pf; // frame beat -> audio ms
      out.downbeatAt = toBeat(bar * M);
      out.nextDownbeatAt = toBeat((bar + 1) * M);
      out.nextPhraseAt = out.nextDownbeatAt + mod(st.phraseBars - out.barInPhrase - 1, st.phraseBars) * M * st.P;
      const pos = mod(Math.round(inBar * 4), 4 * M);
      for (let b = 0; b < NB; b++) accent[b] = tmpl[b * STEPS + pos];
    } else {
      out.beat = -1; out.beatInBar = -1; out.bar = -1e9; out.barInPhrase = -1; out.barPhase = 0; out.phrasePhase = 0; out.clockShift = 0;
      out.downbeatAt = -1; out.nextDownbeatAt = -1; out.nextPhraseAt = -1; accent.fill(0);
    }
    if (opts.clock) { st.cost += opts.clock() - c0; st.steps++; }
    return out;
  }

  // Bar position (0..M-1) of the clock beat nearest to audio time t, or -1
  // when the clock does not sit on the music's beats.
  function barBeatAt(t) {
    if (!st.have || Math.abs(out.clockShift) > 0.15) return -1;
    t = st.A + Math.round((t - st.A) / st.P) * st.P; // that clock beat
    return mod(Math.round(beatAt(t) - st.down8 / 2), st.meter);
  }
  // Phrase place of the bar holding the clock beat nearest t: bar index within
  // the phrase (0 = phrase start), or -1 (not running / clock off the beats).
  function barInPhraseAt(t) {
    if (!st.have || Math.abs(out.clockShift) > 0.15) return -1;
    t = st.A + Math.round((t - st.A) / st.P) * st.P;
    const bar = Math.floor((Math.round(beatAt(t) - st.down8 / 2) + 0.01) / st.meter);
    return mod(bar - st.phraseOff, st.phraseBars);
  }
  // Expected accent (0..1) of band b at beat j (+ sixteenth s) of the bar.
  function expect(b, j, s = 0) { return tmpl[((b | 0) & 3) * STEPS + mod((j | 0) * 4 + (s | 0), 4 * st.meter)]; }
  // Section labels (breakdown-detect.js, PR #113) when present: a drop or the
  // end of a breakdown starts a phrase on the nearest bar.
  function sectionEvent(now, ev) {
    if (!ev || !ev.type || !st.have) return;
    if (ev.type === 'drop' || ev.type === 'breakdownEnd') {
      const bar = Math.round((beatAt(now) - st.down8 / 2) / st.meter);
      st.phraseOff = mod(bar, st.phraseBars); st.phraseFromNovelty = true;
    }
  }
  function debugScores() {
    const r = [];
    for (let o = 0; o < 2 * st.meter; o++) { const parts = {}; parts.total = downbeatScore(st.meter, o, parts); parts.ema = offScore[o]; r.push(parts); }
    return r;
  }
  function snapshot() {
    return {active: st.active, confidence: out.confidence, meter: st.meter === 3 ? '3/4' : '4/4', halfTime: st.halfTime, swing: out.swing,
      fit: out.fit, margin: Math.round(st.margin * 1000) / 1000, bars: st.bars, beatInBar: out.beatInBar, bar: out.bar, clockShift: out.clockShift,
      phraseBars: st.phraseBars, barInPhrase: out.barInPhrase, phraseConfidence: out.phraseConfidence, phraseFromNovelty: st.phraseFromNovelty,
      downEighth: st.down8, relearns: st.relearns, resets: st.resets, surprises: st.surprises, framePeriod: Math.round(st.Pf * 10) / 10,
      template: Array.from({length: NB}, (_, b) => Array.from(tmpl.subarray(b * STEPS, b * STEPS + 4 * st.meter), v => Math.round(v * 100) / 100)),
      costMsPerFrame: st.steps ? +(st.cost / st.steps).toFixed(4) : null};
  }
  return {step, reset, snapshot, expect, barBeatAt, barInPhraseAt, sectionEvent, debugScores, state: out, internals: st};
}
