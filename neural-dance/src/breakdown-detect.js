// Breakdown / build / drop detector (TJ Nov 11 2026, 2:34 PM live-feed session).
//
// Pure, streaming, no DOM and no engine coupling: feed it the Listen state
// once per audio frame and it reports the song section and the events the
// dancers will prepare for (not wired into dancer motion yet).
//
// Plan (as described to TJ):
//   1. Breakdown: kick and bass drop out against the song's running low-end
//      level for at least BREAKDOWN_MIN_BARS while the music keeps going.
//   2. Build: progress 0..1 from rising loudness, rising upper-band energy,
//      onset density (snare-roll / hat density) and time into the phrase.
//   3. Drop: a big kick/bass onset with the low end back near the groove
//      level; it is "on phrase" when it lands near a 4/8/16-bar boundary
//      counted from the breakdown start at the tempo frozen on entry.
//   4. False alarms: a silence gap (gate closed) is a song change, never a
//      breakdown and never a drop; one missing kick (shorter than 2 bars) or
//      a lone fill kick inside a breakdown is ignored.
//
// Tuned on live-capture breakdown recordings
// (20 min of TJ's live mix through the iPhone 13 mic, build 82640fd).
//
// Input per call (all optional except t):
//   t       ms, monotonic (performance.now on the phone)
//   lv      [kick, bass, mid, hat] band levels 0..~1 (Listen per-band)
//   onsets  bitmask of band onsets this frame (bit 0 kick … bit 3 hat)
//   gate    silence gate open (music present)
//   glv     overall smoothed gate level
//   bpm     locked tempo (0 when not locked)
//   flux    optional [4] per-band spectral flux (Listen bandInfo.flux); without
//           it a band-level flux (positive level change) is used
//
// Build / drop cues (TJ Nov 11 11:08 PM upgrade), all O(1) per frame:
//   riser    band-energy centroid + high-band energy rising over the last
//            1-2 bars (noise risers, filter sweeps)
//   roll     mid/hat onset rate per beat and its acceleration (4 → 8 → 16
//            hits per bar = a snare roll into the drop)
//   flux     spectral flux trend in the build; a low-band flux spike makes a
//            partial low return a drop at once
//   cutoff   the half-beat-to-one-beat cut (or riser cut) right before the
//            drop: the predicted drop moves to the next beat so the jump can
//            wind up early. Never a song gap: only inside a building
//            breakdown, and the 1.2 s gate-closed gap rule still wins.
//   memory   after a song's first drop its break length / phrase sharpen the
//            next drop prediction in the same song (reset on a gap or a big
//            tempo change)
// Sub (30-60 Hz) vs kick punch (60-120 Hz) split: skipped. The iPhone 13
// captures only carry the 35-90 Hz band level and a 2048 FFT at 48 kHz has
// ~23 Hz bins (1-2 bins for the sub), so there is no evidence of usable sub.
// Output: {state, progress, barMs, bars, predictedDropAt, event}
//   state    'groove' | 'breakdown' | 'gap' | 'intro' (after a gap, until the new beat is in)
//   progress build progress 0..1 (0 outside a breakdown)
//   predictConf 0..1 trust in predictedDropAt (>= 0.6: wind the jump up early)
//   event    null | {type: 'breakdown'|'drop'|'breakdownEnd'|'gap'|'beatIn', t, ...}
//            breakdownEnd = the breakdown ended WITHOUT a drop; reason
//            'lowReturnedNoDrop' | 'tooLong' | 'gap'. Hook for the tempo re-check.
//            drop.big = the break lasted >= BIG_DROP_BARS (do the jump stomp)

export const BREAKDOWN_MIN_BARS = 2;     // low end gone at least this long
export const LOW_DROP_RATIO = 0.62;      // slow low level vs groove reference
export const LOW_RETURN_RATIO = 0.85;    // fast low level vs reference for a drop
export const GLV_RETURN_RATIO = 0.75;    // or overall loudness back near groove
export const GAP_CLOSED_MS = 1200;       // gate closed this long = song gap
export const GAP_REARM_MS = 4000;        // groove needed after a gap before a new breakdown
export const REF_TAU_MS = 20000;         // groove reference time constant
export const MIN_GROOVE_LOW_RATE = 0.25; // low onsets / beat in the groove ref before we trust it
export const MAX_BREAKDOWN_BARS = 64;    // longer = ambient / new song, give up quietly
export const PHRASE_TOL_BEATS = 1.0;     // drop within ±1 beat of a 4-bar boundary = on phrase
export const DEFAULT_BPM = 124;
export const INTRO_GROOVE_ONSETS = 4;    // kick/bass onsets within 2 bars = the new song's groove is in
export const BIG_DROP_BARS = 4;          // shorter breaks return without the jump (big: false)
export const DROP_CONFIRM_BEATS = 4;
export const RETURN_NO_DROP_BARS = 2;    // low end steadily back this long with no drop onset = breakdownEnd
export const RISER_CENT_RISE = 0.10;     // centroid rise (0..1 scale) over 2 bars for a full riser
export const RISER_HI_RISE = 0.35;       // high-band rise vs the groove's high level
export const ROLL_FULL_PER_BEAT = 4;     // 16 hits per bar = full roll
export const CUTOFF_DIP = 0.45;          // fast level below this share of the build peak = cutoff
export const CUTOFF_PEAK_REF = 0.75;     // the build peak must be near the groove level
export const CUTOFF_HOLD_MS = 120;       // the cut must hold this long (and a quarter beat)
export const CUTOFF_MAX_BEATS = 1.6;     // longer than this is not a pre-drop cut
export const CUTOFF_MIN_PROGRESS = 0.4;
export const MEMORY_BPM_TOL = 0.08;      // same song if the tempo is within 8%
export const GRID_ONSETS = 8;            // last kick/bass onsets used to re-phase the pre-drop beat grid
export const GRID_MIN_ONSETS = 4;
export const GRID_MIN_R = 0.3;           // phase agreement (0..1) needed to trust the re-phased grid
export const CUT_CONF_WEAK = 0.5;        // cutoff on an untrusted grid: no early jump (land on the detected hit)
// Band centres (Hz, log scale) for the band-energy centroid.
const BAND_LOG = [Math.log2(60), Math.log2(300), Math.log2(1500), Math.log2(4000)];
const LOG_LO = Math.log2(60), LOG_SPAN = Math.log2(4000) - Math.log2(60);
export function bandCentroid(lv) {
  let w = 0, a = 0;
  for (let b = 0; b < 4; b++) { const v = Math.max(0, +(lv && lv[b]) || 0); w += v; a += v * BAND_LOG[b]; }
  return w > 1e-4 ? (a / w - LOG_LO) / LOG_SPAN : 0;
}

const clamp01 = v => Math.max(0, Math.min(1, +v || 0));
const ema = (prev, x, dt, tau) => prev + (x - prev) * (1 - Math.exp(-Math.max(0, dt) / Math.max(1, tau)));

export function createBreakdownDetector(opts = {}) {
  const o = {
    minBars: BREAKDOWN_MIN_BARS, lowDrop: LOW_DROP_RATIO, lowReturn: LOW_RETURN_RATIO, glvReturn: GLV_RETURN_RATIO,
    gapMs: GAP_CLOSED_MS, rearmMs: GAP_REARM_MS, refTau: REF_TAU_MS, maxBars: MAX_BREAKDOWN_BARS, ...opts
  };
  let s;
  function reset() {
    s = {
      t: -1, lowFast: 0, lowSlow: 0, upSlow: 0, glvS: 0, lowRef: 0, glvRef: 0, lowRateRef: 0, refN: 0,
      lastLow: -1e9, lowTimes: [], upTimes: [], closedSince: -1, openSince: -1, state: 'groove',
      bpm: DEFAULT_BPM, frozenBpm: 0, start: -1, confirmedAt: -1, glvMin: 1, progress: 0, upHist: [], glvHist: [],
      lastEvent: null,
      centS: 0, hiF: 0, fluxS: 0, fluxRef: 0, lowFluxRef: 0, hiRef: 0, glvF: 0, prevLv: null,
      rollTimes: [], lowHist: [], cutConf: 0, cutHist: [], cutAt: -1, cutDropAt: -1, cutPeak: 0, mem: null, cues: null
    };
  }
  reset();
  const beatMs = () => 60000 / (s.frozenBpm || s.bpm || DEFAULT_BPM);
  // Pre-drop beat grid re-phased from the real kick/bass onsets (groove and
  // build) at the CURRENT locked tempo, instead of a grid frozen at the
  // breakdown start (its tempo is often still settling and its one-onset
  // anchor drifts ~half a beat over a long build). Circular mean of onset
  // phases; R = agreement 0..1.
  function rephase() {
    const bm = 60000 / (s.bpm || s.frozenBpm || DEFAULT_BPM), L = s.lowHist;
    if (L.length < GRID_MIN_ONSETS) return {bm, ph: 0, R: 0, n: L.length};
    let c = 0, si = 0;
    for (const v of L) { const a = 2 * Math.PI * (v % bm) / bm; c += Math.cos(a); si += Math.sin(a); }
    const ph = ((Math.atan2(si, c) / (2 * Math.PI)) * bm + bm) % bm;
    return {bm, ph, R: Math.hypot(c, si) / L.length, n: L.length};
  }
  function process(x = {}) {
    const t = +x.t || 0;
    const dt = s.t < 0 ? 0 : Math.min(500, t - s.t);
    s.t = t;
    const lv = Array.isArray(x.lv) ? x.lv : [0, 0, 0, 0];
    const gate = x.gate !== false;
    const glv = Number.isFinite(+x.glv) ? +x.glv : Math.max(...lv.map(v => +v || 0));
    const on = x.onsets | 0;
    if (+x.bpm > 40 && +x.bpm < 220) s.bpm = +x.bpm;
    const low = Math.max(+lv[0] || 0, 0.8 * (+lv[1] || 0));
    const up = Math.max(+lv[2] || 0, +lv[3] || 0);
    s.lowFast = ema(s.lowFast, low, dt, 150);
    s.lowSlow = ema(s.lowSlow, low, dt, 1200);
    s.upSlow = ema(s.upSlow, up, dt, 800);
    s.glvS = ema(s.glvS, glv, dt, 400);
    s.glvF = ema(s.glvF, glv, dt, 60);
    // Band-energy centroid + high band (riser), spectral flux (or band-level flux).
    s.centS = ema(s.centS, bandCentroid(lv), dt, 300);
    s.hiF = ema(s.hiF, up, dt, 300);
    let fluxAll = 0, fluxLow = 0;
    if (Array.isArray(x.flux)) { for (let b = 0; b < 4; b++) fluxAll += Math.max(0, +x.flux[b] || 0); fluxLow = Math.max(0, +x.flux[0] || 0) + Math.max(0, +x.flux[1] || 0); }
    else if (s.prevLv) { for (let b = 0; b < 4; b++) { const d = Math.max(0, (+lv[b] || 0) - (+s.prevLv[b] || 0)); fluxAll += d; if (b < 2) fluxLow += d; } }
    if (!Array.isArray(x.flux)) { if (!s.prevLv) s.prevLv = [0, 0, 0, 0]; for (let b = 0; b < 4; b++) s.prevLv[b] = +lv[b] || 0; }
    s.fluxS = ema(s.fluxS, fluxAll, dt, 400);
    if (on & 12) s.rollTimes.push(t);
    if (on & 3) { s.lastLow = t; s.lowTimes.push(t); s.lowHist.push(t); if (s.lowHist.length > GRID_ONSETS) s.lowHist.shift(); }
    if (on & 12 || on & 2) s.upTimes.push(t);
    const bm = beatMs(), barMs = 4 * bm;
    while (s.lowTimes.length && s.lowTimes[0] < t - 4 * barMs) s.lowTimes.shift();
    while (s.upTimes.length && s.upTimes[0] < t - barMs) s.upTimes.shift();
    while (s.rollTimes.length && s.rollTimes[0] < t - barMs) s.rollTimes.shift();
    let event = null;
    // --- silence gap: song change, cancels any breakdown --------------------
    if (!gate) { if (s.closedSince < 0) s.closedSince = t; s.openSince = -1; }
    else { s.closedSince = -1; if (s.openSince < 0) s.openSince = t; }
    if (s.closedSince >= 0 && t - s.closedSince >= o.gapMs) {
      if (s.state !== 'gap') { event = s.state === 'breakdown' ? {type: 'breakdownEnd', t, reason: 'gap', bars: +((t - s.start) / (4 * beatMs())).toFixed(1), start: s.start, bpm: s.frozenBpm, gap: true} : {type: 'gap', t}; }
      s.state = 'gap'; s.start = -1; s.progress = 0; s.frozenBpm = 0; s.mem = null; s.lowHist = []; s.cutAt = -1; s.cutDropAt = -1;
    }
    if (s.state === 'gap' && gate && s.openSince >= 0) {
      // A gap is a song change: forget the old song's groove. The new song's
      // intro is not a breakdown; the first full beat-in is reported as
      // 'beatIn' (no jump required) once the low end is steady again.
      s.state = 'intro'; s.introAt = t; s.refN = 0; s.lowRef = 0; s.glvRef = 0; s.lowRateRef = 0; s.introLow = [];
    }
    if (s.state === 'intro') {
      if (on & 3) s.introLow.push(t);
      while (s.introLow.length && s.introLow[0] < t - 2 * barMs) s.introLow.shift();
      if (s.introLow.length >= INTRO_GROOVE_ONSETS && t - s.introAt >= o.rearmMs) {
        event = event || {type: 'beatIn', t, introBars: +((t - s.introAt) / barMs).toFixed(1)};
        s.state = 'groove';
      }
    }
    // --- groove reference (only while the low end is clearly playing) -------
    if (s.state === 'groove' && gate && t - s.lastLow < 2 * bm) {
      const k = s.refN < 40 ? 1 / (++s.refN) : 1 - Math.exp(-dt / o.refTau);
      s.lowRef += (s.lowSlow - s.lowRef) * k;
      s.glvRef += (s.glvS - s.glvRef) * k;
      const rate = s.lowTimes.filter(v => v > t - 2 * barMs).length / 8; // low onsets per beat over 2 bars
      s.lowRateRef += (rate - s.lowRateRef) * k;
      s.fluxRef += (s.fluxS - s.fluxRef) * k;
      s.hiRef += (s.hiF - s.hiRef) * k;
      if (on & 3) s.lowFluxRef += (fluxLow - s.lowFluxRef) * Math.min(1, 4 * k);
    }
    const trusted = s.refN >= 12 && s.lowRateRef >= MIN_GROOVE_LOW_RATE * 0.5 && s.lowRef > 0.05;
    // --- breakdown entry -----------------------------------------------------
    if (s.state === 'groove' && trusted && gate) {
      const silentLow = t - s.lastLow;
      const lowGone = s.lowSlow < o.lowDrop * s.lowRef;
      const musicOn = s.glvS > 0.05 || s.upSlow > 0.03;
      if (silentLow >= o.minBars * barMs && lowGone && musicOn) {
        s.state = 'breakdown';
        s.frozenBpm = s.bpm;
        // anchor the phrase one beat after the last low onset (the "1" that went missing)
        s.start = s.lastLow > 0 ? s.lastLow + beatMs() : t - o.minBars * barMs;
        s.confirmedAt = t; s.glvMin = s.glvS; s.progress = 0; s.upHist = []; s.glvHist = []; s.pendingLow = -1; s.backSince = -1; s.cutHist = []; s.cutAt = -1; s.cutDropAt = -1; s.cutPeak = 0; s.cutCand = 0; s.cutBlockUntil = 0; s.rollAccelAt = 0;
        if (s.mem && Math.abs(s.frozenBpm - s.mem.bpm) > MEMORY_BPM_TOL * s.mem.bpm) s.mem = null; // new tempo = new song
        event = {type: 'breakdown', t, start: s.start, bpm: s.frozenBpm, lowRatio: +(s.lowSlow / s.lowRef).toFixed(2)};
      }
    }
    // --- build progress + drop ----------------------------------------------
    let predictedDropAt = -1, bars = 0, predictConf = 0;
    if (s.state === 'breakdown') {
      const bm2 = beatMs(), bar2 = 4 * bm2;
      bars = (t - s.start) / bar2;
      s.glvMin = Math.min(s.glvMin, s.glvS);
      s.upHist.push([t, s.upSlow, s.centS, s.hiF, s.fluxS]); s.glvHist.push([t, s.glvS]);
      while (s.upHist.length && s.upHist[0][0] < t - 2 * bar2) s.upHist.shift();
      while (s.glvHist.length && s.glvHist[0][0] < t - 2 * bar2) s.glvHist.shift();
      const slope = h => h.length > 2 ? (h[h.length - 1][1] - h[0][1]) : 0;
      const loud = clamp01((s.glvS - s.glvMin) / Math.max(0.05, s.glvRef - s.glvMin));
      const upRise = clamp01(slope(s.upHist) / 0.15) * 0.5 + clamp01(slope(s.glvHist) / Math.max(0.05, 0.5 * s.glvRef)) * 0.5;
      const density = clamp01(s.upTimes.length / 8);
      // Riser: centroid + high band rising over 2 bars, and still rising over the last bar.
      const h = s.upHist, h0 = h[0], hm = h[h.length >> 1], hn = h[h.length - 1];
      let riser = 0;
      if (h.length > 8 && hn[0] - h0[0] >= bar2) {
        const centR = clamp01((hn[2] - h0[2]) / RISER_CENT_RISE), hiR = clamp01((hn[3] - h0[3]) / (RISER_HI_RISE * Math.max(0.05, s.hiRef)));
        const still = (hn[2] - hm[2]) > 0.002 || (hn[3] - hm[3]) > 0.002 ? 1 : 0.5;
        riser = (0.5 * centR + 0.5 * hiR) * still;
      }
      // Snare roll: mid/hat onsets per beat over the last 2 beats vs the 2 before.
      let rN = 0, rP = 0;
      for (let i = s.rollTimes.length - 1; i >= 0; i--) { const a = t - s.rollTimes[i]; if (a <= 2 * bm2) rN++; else if (a <= 4 * bm2) rP++; else break; }
      const rate = rN / 2, ratePrev = rP / 2;
      // accelerating (e.g. 8 → 16 per bar); held while the roll keeps going
      if (rate >= 2 && rate >= 1.5 * Math.max(0.5, ratePrev)) s.rollAccelAt = t;
      const accel = rate >= 2 && s.rollAccelAt > 0 && t - s.rollAccelAt < 2 * bar2;
      const roll = clamp01(Math.log2(Math.max(1, rate)) / Math.log2(ROLL_FULL_PER_BEAT)) * (accel ? 1 : 0.6);
      // Flux trend over 2 bars vs the groove flux.
      const fluxRise = h.length > 8 ? clamp01((hn[4] - h0[4]) / Math.max(1e-3, 0.5 * s.fluxRef)) : 0;
      // Phrase prior: drops come on 8/16-bar boundaries; reach 0.6 by bar 16,
      // or by the remembered break length of this song's last drop.
      const mem = s.mem && s.mem.phraseBars > 0 ? s.mem : null;
      const prior = mem ? 0.75 * clamp01(bars / mem.phraseBars) : 0.6 * clamp01(bars / 16);
      const base = 0.4 * loud + 0.35 * upRise + 0.25 * density;
      const raw = clamp01(Math.max(prior, base) + 0.25 * riser + 0.25 * roll + 0.1 * fluxRise + (s.cutAt >= 0 ? 0.3 : 0));
      s.cues = {riser: +riser.toFixed(2), roll: +roll.toFixed(2), rollRate: rate, accel, fluxRise: +fluxRise.toFixed(2), cutoff: s.cutAt >= 0, memory: !!mem};
      s.progress = raw > s.progress ? ema(s.progress, raw, dt, 300) : ema(s.progress, raw, dt, 4000);
      const memNext = mem && mem.phraseBars * bar2 + s.start > t + 0.5 * bm2 ? mem.phraseBars : 0;
      const next = memNext || [4, 8, 16, 24, 32].find(n => n * bar2 + s.start > t + 0.5 * bm2) || Math.ceil(bars / 8 + 1) * 8;
      predictedDropAt = s.start + next * bar2;
      // Pre-drop cutoff: the fast level falls well below the build peak.
      s.cutHist.push([t, s.glvF]);
      while (s.cutHist.length && s.cutHist[0][0] < t - bar2) s.cutHist.shift();
      let peak = 0; for (const c of s.cutHist) if (c[1] > peak) peak = c[1];
      if (s.cutAt < 0) {
        // Candidate: a deep, fast fall from a full build level; confirmed when
        // it holds a quarter beat (one-off rhythmic dips in a build recover first).
        const armed = (s.progress >= CUTOFF_MIN_PROGRESS || riser >= 0.5 || roll >= 0.5) && bars >= o.minBars && t >= (s.cutBlockUntil || 0) && peak > CUTOFF_PEAK_REF * s.glvRef;
        const dipped = s.glvF < CUTOFF_DIP * peak;
        if (armed && dipped) {
          if (!(s.cutCand > 0)) { s.cutCand = t; s.cutCandPeak = peak; }
          else if (t - s.cutCand >= Math.max(CUTOFF_HOLD_MS, 0.25 * bm2)) {
            s.cutAt = s.cutCand; s.cutPeak = s.cutCandPeak; s.cutCand = 0;
            // land on the next beat of the frozen grid at least half a beat
            // after the cut began, or a 4-bar phrase line within 1.6 beats
            const g = rephase(), good = g.n >= GRID_MIN_ONSETS && g.R >= GRID_MIN_R;
            const bmG = good ? g.bm : bm2;
            // phrase origin = breakdown start snapped onto the (re-phased) grid
            const org = good ? s.start + (((g.ph - s.start) % bmG + 1.5 * bmG) % bmG - 0.5 * bmG) : s.start;
            const beatsIn = (s.cutAt - org) / bmG;
            const phraseB = Math.ceil((beatsIn + 0.4) / 16) * 16;
            s.cutDropAt = (phraseB - beatsIn) <= CUTOFF_MAX_BEATS ? org + phraseB * bmG : org + Math.ceil(beatsIn + 0.5) * bmG;
            if (s.cutDropAt <= t) s.cutDropAt = org + Math.ceil((t - org) / bmG + 0.25) * bmG;
            s.cutConf = good ? 0.9 : CUT_CONF_WEAK;
          }
        } else s.cutCand = 0;
      } else if (t - s.cutAt > CUTOFF_MAX_BEATS * bm2 + 0.5 * bm2 || (s.glvF > 0.7 * s.cutPeak && t > s.cutDropAt + 0.5 * bm2)) {
        // no drop came off this cut: not a pre-drop cutoff; wait 2 bars before another
        s.cutAt = -1; s.cutDropAt = -1; s.cutBlockUntil = t + 2 * bar2;
      }
      if (s.cutAt >= 0 && s.cutDropAt > t) predictedDropAt = s.cutDropAt;
      // How much to trust predictedDropAt for an early jump wind-up: a phrase
      // line alone is weak (live captures: most pass with no drop); a cutoff
      // right before it is strong; this song's remembered phrase or a clear
      // riser / roll in between.
      predictConf = s.cutAt >= 0 && s.cutDropAt > t ? s.cutConf : clamp01(Math.max(memNext ? 0.5 : 0.25, 0.45 * riser + 0.45 * roll + (memNext ? 0.25 : 0)));
      // drop: a kick/bass onset with the low end back. A strong return (or one
      // on a 4-bar boundary) fires at once so the jump lands on the drop; a
      // weaker one (a fill kick) needs a second low onset within a bar.
      const nb = bars, near = Math.round(nb / 4) * 4, offBeats = (nb - near) * 4;
      const onPhrase = near > 0 && Math.abs(offBeats) <= PHRASE_TOL_BEATS;
      const strong = s.lowFast >= o.lowReturn * s.lowRef && s.glvS >= o.glvReturn * s.glvRef;
      const partial = s.lowFast >= 0.7 * o.lowReturn * s.lowRef || s.glvS >= 0.8 * o.glvReturn * s.glvRef;
      const fluxHit = s.lowFluxRef > 1e-4 && fluxLow >= 1.5 * s.lowFluxRef;
      const afterCut = s.cutAt >= 0 && Math.abs(t - s.cutDropAt) <= bm2;
      let fire = false, how = '';
      if ((on & 3) && strong) { fire = true; how = 'strong'; }
      else if ((on & 3) && partial && onPhrase) { fire = true; how = 'phrase'; }
      else if ((on & 3) && partial && (afterCut || (fluxHit && s.progress >= 0.5))) { fire = true; how = afterCut ? 'cutoff' : 'flux'; }
      else if ((on & 3) && partial) {
        if (s.pendingLow > 0 && t - s.pendingLow <= DROP_CONFIRM_BEATS * bm2) { fire = true; how = 'confirmed'; }
        else s.pendingLow = t;
      }
      if (fire) {
        event = {type: 'drop', t, how, big: nb >= BIG_DROP_BARS, bars: +nb.toFixed(2), phraseBars: near, offBeats: +offBeats.toFixed(2), onPhrase, start: s.start, bpm: s.frozenBpm, progress: +s.progress.toFixed(2), cues: s.cues, memory: !!mem};
        if (nb >= o.minBars) s.mem = {bars: nb, phraseBars: near > 0 && Math.abs(offBeats) <= 2 ? near : Math.round(nb), bpm: s.frozenBpm, n: (s.mem ? s.mem.n : 0) + 1};
        s.state = 'groove'; s.start = -1; s.progress = 0; s.frozenBpm = 0; s.pendingLow = -1; s.cutAt = -1; s.cutDropAt = -1;
      } else {
        // Ended without a drop (TJ Nov 11 3:02 PM: the tempo re-check hooks
        // this). Show tracks blend with no silence, so a breakdown that
        // fades back in, or a blend into the next track, ends here.
        if (s.lowSlow >= o.lowReturn * s.lowRef) { if (s.backSince < 0) s.backSince = t; } else s.backSince = -1;
        let reason = '';
        if (s.backSince >= 0 && t - s.backSince >= RETURN_NO_DROP_BARS * bar2) reason = 'lowReturnedNoDrop';
        else if (bars > o.maxBars) reason = 'tooLong';
        if (reason) {
          event = {type: 'breakdownEnd', t, reason, bars: +bars.toFixed(1), start: s.start, bpm: s.frozenBpm};
          s.state = 'groove'; s.start = -1; s.progress = 0; s.frozenBpm = 0; s.backSince = -1; s.cutAt = -1; s.cutDropAt = -1;
        }
      }
    }
    if (event) s.lastEvent = event;
    return {state: s.state, progress: s.state === 'breakdown' ? +s.progress.toFixed(3) : 0, barMs: 4 * beatMs(), bars: +bars.toFixed(2), predictedDropAt, predictConf: +predictConf.toFixed(2), cutoff: s.state === 'breakdown' && s.cutAt >= 0, cues: s.state === 'breakdown' ? s.cues : null, event};
  }
  function snapshot() {
    return {state: s.state, lowRef: s.lowRef, glvRef: s.glvRef, lowRateRef: s.lowRateRef, lowSlow: s.lowSlow, lowFast: s.lowFast, glvS: s.glvS, start: s.start, bpm: s.frozenBpm || s.bpm, progress: s.progress, lastEvent: s.lastEvent, cues: s.cues, memory: s.mem ? {...s.mem} : null};
  }
  return {process, snapshot, reset};
}
