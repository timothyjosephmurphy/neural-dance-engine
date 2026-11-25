// Section-driven motion: breakdown / build / drop (TJ Nov 11 2026, 4:12 PM).
//
//   BREAKDOWN  stripped back (beat thinned or gone, pads/melody left):
//              calm, flowing, pad-driven — smaller hips, bigger pad arms,
//              no claps.
//   BUILD      rising tension into the drop (risers, rolls, sweeps):
//              anticipation — dancers progressively stand tall, reach the
//              arms forward, then raise the hands overhead.
//   DROP       the big release: one synchronized jump stomp for everyone,
//              landing on the drop, then a hot groove for two bars.
//
// Labels come from breakdown-detect.js (feat/breakdown-detect). Pure apart
// from createSectionMotion, which smooths and schedules the shared jump.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = x => { const u = clamp(+x || 0, 0, 1); return u * u * (3 - 2 * u); };

export const BUILD_FROM = 0.25;     // detector progress where the build starts to show
export const BUILD_SPAN = 0.6;
export const CALM_EASE_MS = 1500;
export const DROP_CROUCH_MS = 170;  // dip before take-off
export const DROP_AIR_MS = 420;     // take-off → landing
export const DROP_LAND_MS = 260;    // landing compression
export const DROP_RISE = 0.11;      // of figure height at the top (normal jump 0.07)
export const DROP_HOT_MS = 2 * 4 * 500; // groove boost after the drop (~2 bars at 120)
export const PRE_JUMP_BUILD = 0.55; // build level needed to time the jump to the predicted drop
export const PREDICT_CONF_MIN = 0.6; // detector trust needed to jump BEFORE the drop is heard
export const DROP_MATCH_MS = 260;   // a detected drop this close to a scheduled landing keeps it
export const BUILD_RISE_MS = 160;   // build pose follows the detector (two cascaded eases: no snap)
export const BUILD_FALL_MS = 320;   // arms come down after the landing
export const BUILD_SAG_MS = 8000;   // very slow sag while still in the breakdown (builds only rise)
export const HOT_RAMP_MS = 250;     // hot groove eases in after the drop
export const JUMP_FADE_MS = 120;
// Stand tall up to 0.7: above ~0.85 the straight-leg knee IK pops during
// two-step footwork (pre-existing in skeletonPose, seen at tall 1.0).
export const BUILD_TALL_MAX = 0.7;
export const RAVE_RETURN_MS = 700;  // steps come back after the landing
export const CROUCH_RELEASE_MS = 140; // dip unwinds over this after take-off
export const LATE_MIN_MS = 150;     // shortest hop that still reads as a jump onto the hit
export const LATE_FALLBACK_MIN_MS = 300; // unplanned drop: land on the next beat at least this far out

// det: {state, progress} from the detector; calm: smoothed breakdown calm 0..1.
// build (optional): an already-smoothed build level (createSectionMotion /
// demoSectionAt) so the pose holds through the drop jump and eases down after.
export function buildLevel(state, progress) { return state === 'breakdown' ? smooth((+progress - BUILD_FROM) / BUILD_SPAN) : 0; }
export function sectionMods({state = 'groove', progress = 0, calm = 0, sinceDropMs = Infinity, build: buildIn = null} = {}) {
  const inBreak = state === 'breakdown';
  const build = buildIn != null && Number.isFinite(+buildIn) ? clamp(+buildIn, 0, 1) : buildLevel(state, progress);
  const c = clamp(+calm || 0, 0, 1) * (1 - build);
  // Arms: forward reach peaks mid-build, then hands go overhead.
  const forward = build * (1 - smooth((build - 0.45) / 0.35)) * smooth(build / 0.25);
  const raise = smooth((build - 0.35) / 0.55);
  const hot = Number.isFinite(sinceDropMs) && sinceDropMs >= 0 && sinceDropMs < DROP_HOT_MS ? smooth(sinceDropMs / HOT_RAMP_MS) * (1 - sinceDropMs / DROP_HOT_MS) : 0;
  return {
    kind: inBreak ? (build > 0.05 ? 'build' : 'breakdown') : (hot > 0 || (Number.isFinite(sinceDropMs) && sinceDropMs >= 0 && sinceDropMs < DROP_HOT_MS) ? 'drop' : 'groove'),
    build, calm: c,
    hipMul: (1 - 0.5 * c) * (1 + 0.25 * build) * (1 + 0.3 * hot),
    padMul: 1 + 0.9 * c,
    shoulderMul: 1 + 0.5 * c,
    tall: BUILD_TALL_MAX * build,
    armRaise: raise,
    armForward: forward,
    clapOK: !inBreak,
    stepMul: 1 - 0.35 * c,
    hot
  };
}

// Jump stomp shape around the landing time. dt = now - landAt (ms).
// airMs / crouchMs: a late cue (pre-drop cutoff heard < crouch+air before the
// hit) compresses the jump so the landing still falls on the hit; lift scales
// with the air time. crouchMs 0 = take off straight from standing.
export function dropJumpShape(dt, airMs = DROP_AIR_MS, crouchMs = DROP_CROUCH_MS) {
  const t = +dt;
  const AIR = Math.max(1, +airMs || DROP_AIR_MS), CR = Math.max(0, Number.isFinite(+crouchMs) ? +crouchMs : DROP_CROUCH_MS);
  const out = {lift: 0, crouch: 0, air: false, phase: 'none', raveFade: 1};
  if (!Number.isFinite(t)) return out;
  // Step repertoire fades out through the dip and back in after the landing.
  const fadeIn = Math.max(CR, Math.min(DROP_CROUCH_MS, AIR * 0.5));
  out.raveFade = 1 - smooth((t + AIR + CR) / fadeIn) * (1 - smooth((t - DROP_LAND_MS * 0.5) / RAVE_RETURN_MS));
  const takeoff = -AIR, dip = takeoff - CR;
  if (t < dip || t > DROP_LAND_MS) return out; // raveFade already eased (1 outside the window)
  if (t < takeoff) { out.crouch = Math.sin(Math.PI * 0.5 * (t - dip) / CR); out.phase = 'crouch'; return out; }
  if (t < 0) {
    const u = (t - takeoff) / AIR;
    out.lift = DROP_RISE * Math.sqrt(Math.min(1, AIR / DROP_AIR_MS)) * Math.sin(Math.PI * u);
    out.crouch = CR > 0 ? 1 - smooth((t - takeoff) / CROUCH_RELEASE_MS) : 0; // C1 release out of the dip (no snap at 60 fps)
    out.air = u > 0.06 && u < 0.97;
    out.phase = 'air';
    return out;
  }
  out.crouch = Math.sin(Math.PI * t / DROP_LAND_MS) * 0.9; out.phase = 'land';
  return out;
}

// Streaming: feed the detector output each frame. Holds one shared landAt so
// every dancer jumps together.
export function createSectionMotion() {
  const s = {state: 'groove', progress: 0, calm: 0, build: 0, build1: 0, env: 0, landAt: -1, lastDrop: -1, t: -1, landed: false, scheduled: false, cancelAt: -1, drops: 0, airMs: DROP_AIR_MS, crouchMs: DROP_CROUCH_MS, cut: false};
  function reset() { Object.assign(s, {state: 'groove', progress: 0, calm: 0, build: 0, build1: 0, env: 0, landAt: -1, lastDrop: -1, t: -1, landed: false, scheduled: false, cancelAt: -1, airMs: DROP_AIR_MS, crouchMs: DROP_CROUCH_MS, cut: false}); }
  const jumping = t => s.landAt >= 0 && dropJumpShape(t - s.landAt, s.airMs, s.crouchMs).phase !== 'none';
  // Fit the jump into the lead time so it starts now at the latest: full
  // crouch + air when there is room, else a shorter crouch / hop (starts from
  // zero, so it needs no fade-in and never pops).
  function setLanding(t, at) {
    if (jumping(t) && s.cancelAt < 0) return; // never re-time a jump already in progress
    const lead = at - t;
    if (lead >= DROP_AIR_MS + DROP_CROUCH_MS) { s.airMs = DROP_AIR_MS; s.crouchMs = DROP_CROUCH_MS; }
    else { s.crouchMs = lead >= 450 ? Math.min(DROP_CROUCH_MS, lead - 300) : 0; s.airMs = Math.max(1, lead - s.crouchMs); s.env = 1; } // a dip shorter than ~150 ms would snap: hop straight up instead
    s.landAt = at; s.cancelAt = -1;
  }
  function update(now, det) {
    const t = +now || 0, dt = s.t < 0 ? 0 : clamp(t - s.t, 0, 250);
    s.t = t;
    const d = det || {};
    s.state = d.state || 'groove';
    s.progress = +d.progress || 0;
    const build = buildLevel(s.state, s.progress);
    const want = s.state === 'breakdown' ? 1 - build : 0;
    s.calm += (want - s.calm) * (dt > 0 ? 1 - Math.exp(-dt / (CALM_EASE_MS / 3)) : 0);
    // Anticipate: a strong build with a predicted drop close enough → jump
    // so the landing is the drop.
    // A pre-drop cutoff (detector) is the strongest cue: wind up even if the
    // build cues were weak.
    const cutCue = !!d.cutoff && +d.predictConf >= 0.85;
    if (s.state === 'breakdown' && (build >= PRE_JUMP_BUILD || cutCue) && +d.predictedDropAt > t && !(+d.predictConf < PREDICT_CONF_MIN)) {
      const lead = +d.predictedDropAt - t;
      if (lead <= DROP_AIR_MS + DROP_CROUCH_MS && lead >= LATE_MIN_MS && !s.scheduled) { setLanding(t, +d.predictedDropAt); s.scheduled = true; }
    }
    const ev = d.event;
    if (ev && ev.type === 'drop') {
      s.lastDrop = t; s.drops++;
      const matched = s.scheduled && Math.abs(t - s.landAt) <= DROP_MATCH_MS;
      // Unplanned (or mis-predicted) drop: land on the next beat after the hit
      // rather than off the grid.
      if (!matched && (ev.big || build >= PRE_JUMP_BUILD)) {
        const beat = +d.barMs > 0 ? +d.barMs / 4 : 500;
        setLanding(t, t + Math.ceil(LATE_FALLBACK_MIN_MS / beat) * beat);
      }
      s.scheduled = false;
    }
    if (ev && (ev.type === 'breakdownEnd' || ev.type === 'gap')) {
      // No drop came: cancel a scheduled jump that has not left the floor (fades out).
      if (s.landAt > t + DROP_AIR_MS && s.cancelAt < 0) s.cancelAt = t;
      s.scheduled = false;
    }
    // A scheduled landing that came and went without a drop: cancel the rest.
    if (s.scheduled && s.landAt >= 0 && t > s.landAt + DROP_MATCH_MS) s.scheduled = false;
    // Jump envelope: linear fade so a late start or a cancel never pops.
    const active = s.landAt >= 0 && s.cancelAt < 0 && t <= s.landAt + DROP_LAND_MS;
    const step = dt / JUMP_FADE_MS;
    s.env = active ? Math.min(1, s.env + step) : Math.max(0, s.env - step);
    if (s.cancelAt >= 0 && s.env <= 0) { s.landAt = -1; s.cancelAt = -1; }
    // Build pose: hold through the drop jump, then ease down after the landing.
    const holding = s.landAt >= 0 && s.cancelAt < 0 && t < s.landAt + DROP_LAND_MS && t >= s.landAt - DROP_AIR_MS - DROP_CROUCH_MS;
    s.cut = s.state === 'breakdown' && (!!d.cutoff || s.scheduled);
    const target = Math.max(build, holding ? s.build : 0, s.cut ? 1 : 0); // final beats: arms all the way up
    // Inside a breakdown the detector's progress wobbles; a build only rises in
    // the music, so the pose sags slowly there and drops after the breakdown.
    const tau = target >= s.build1 ? BUILD_RISE_MS : (s.state === 'breakdown' ? BUILD_SAG_MS : BUILD_FALL_MS);
    const k = dt > 0 ? 1 - Math.exp(-dt / (tau / 2)) : 0;
    s.build1 += (target - s.build1) * k;
    s.build += (s.build1 - s.build) * k;
    const was = s.landed;
    s.landed = s.landAt >= 0 && s.cancelAt < 0 && t >= s.landAt && t - s.landAt < 120;
    s.landEdge = s.landed && !was;
    return s;
  }
  function mods(now) { return sectionMods({state: s.state, progress: s.progress, calm: s.calm, build: s.build, sinceDropMs: s.lastDrop >= 0 ? (+now || 0) - s.lastDrop : Infinity}); }
  function jump(now) {
    const j = s.landAt >= 0 ? dropJumpShape((+now || 0) - s.landAt, s.airMs, s.crouchMs) : dropJumpShape(NaN);
    if (s.env < 1) { j.lift *= s.env; j.crouch *= s.env; j.raveFade = 1 - s.env * (1 - j.raveFade); if (s.env <= 0) { j.air = false; j.phase = 'none'; } }
    return j;
  }
  return {update, mods, jump, reset, state: s};
}

/**
 * Compact readout for the side-sim meter. The bar follows the build, reaches
 * 1 only in the landing window (the shared landAt, already within ~60 ms of
 * the bass hit), then falls. A later breakdown starts low again.
 */
export function sectionMeter({now = 0, state = 'groove', progress = 0, calm = 0, build = null, landAt = -1, predictedDropAt = -1, lastDrop = -1} = {}) {
  const t = +now || 0;
  const buildU = build != null && Number.isFinite(+build) ? clamp(+build, 0, 1) : buildLevel(state, progress);
  const since = lastDrop >= 0 ? t - lastDrop : Infinity;
  const mods = sectionMods({state, progress, calm, build: buildU, sinceDropMs: since});
  let etaMs = null;
  if (+predictedDropAt > t + 40) etaMs = +predictedDropAt - t;
  else if (+landAt > t + 40 && (state === 'breakdown' || mods.kind === 'build')) etaMs = +landAt - t;
  let level = Math.min(0.96, buildU);
  if (+landAt >= 0) {
    const dt = t - landAt;
    if (dt >= -50 && dt <= 50) level = 1;
    else if (dt > 50 && dt < 900) level = Math.max(0, 1 - (dt - 50) / 850);
  }
  let kind = mods.kind;
  if (level >= 0.999) kind = 'drop';
  return {kind, level: clamp(level, 0, 1), etaMs: etaMs == null ? null : Math.round(etaMs), build: buildU};
}

// Demo timeline for the side sim and the preview (seconds): groove,
// breakdown, build, drop on the bar, groove again. Returns detector-like
// output plus the landing time, all pure in tSec.
export const DEMO_SECTIONS = {groove: 6, breakdown: 6, build: 8};
export function demoSectionAt(tSec, bpm = 120, t0 = 0) {
  const bar = 4 * 60 / Math.max(40, +bpm || 120);
  const g = Math.round(DEMO_SECTIONS.groove / bar) * bar;
  const bd = Math.round(DEMO_SECTIONS.breakdown / bar) * bar;
  const bu = Math.round(DEMO_SECTIONS.build / bar) * bar;
  const cyc = 2 * g + bd + bu;
  const t = (((+tSec || 0) - t0) % cyc + cyc) % cyc;
  const dropAt = g + bd + bu;
  const base = (+tSec || 0) - t;
  const after = sd => smooth(1 - (sd * 1000 - DROP_LAND_MS) / (2.2 * BUILD_FALL_MS)); // arms held through the jump, then down
  if (t < g) return {state: 'groove', progress: 0, calm: 0, build: after(t + cyc - dropAt), landAt: base - cyc + dropAt, sinceDrop: t + cyc - dropAt};
  if (t < g + bd) { const u = (t - g) / bd; return {state: 'breakdown', progress: 0.1 * u, calm: smooth(u * 3), build: buildLevel('breakdown', 0.1 * u), landAt: base + dropAt, sinceDrop: Infinity}; }
  if (t < dropAt) { const u = (t - g - bd) / bu; return {state: 'breakdown', progress: 0.1 + 0.9 * u, calm: 1 - smooth(u * 2), build: buildLevel('breakdown', 0.1 + 0.9 * u), landAt: base + dropAt, sinceDrop: Infinity}; }
  return {state: 'groove', progress: 0, calm: 0, build: after(t - dropAt), landAt: base + dropAt, sinceDrop: t - dropAt};
}
