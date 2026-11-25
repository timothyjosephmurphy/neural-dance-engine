// Rest / contact probe (TJ Nov 10, 10:30–10:31): long-lived dancers on still
// stickers with camera jitter and re-detection. Measures foot separation in hip
// widths, airborne frames, planted-foot slip, per-frame foot jumps and drift.
import {createSilhouetteShow} from '../../neural-dance/src/silhouette.js';
import {buildFor, hipWidth, projectedStanceWidth, resetArmLiftFamilies, THIGH} from '../../neural-dance/src/skeleton-dancer.js';
import {resetBodyDynamics, resetTravel, resetSpineFlex} from '../../neural-dance/src/skeleton-motion.js';

function recorder() {
  const target = {canvas: {width: 1000, height: 620}, createRadialGradient() { return {addColorStop() {}}; }, createLinearGradient() { return {addColorStop() {}}; }, measureText() { return {width: 10}; }};
  return new Proxy(target, {get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined); }, set() { return true; }});
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const pt = (r, k) => r[k] ? {x: r[k].x, y: r[k].y} : null;
const mid = (r, side) => { const t = side < 0 ? r.footL : r.footR, h = side < 0 ? r.heelL : r.heelR; return h ? {x: (t.x + h.x) / 2, y: (t.y + h.y) / 2, z: ((+t.z || 0) + (+h.z || 0)) / 2} : {x: t.x, y: t.y, z: +t.z || 0}; };

// phases: [{s, kind: 'silence'|'music', bpm}]
export function restProbe({phases = [{s: 600, kind: 'silence'}], dancers = 4, fps = 30, jitterPx = 2, redetectEvery = 7, seed = 7, sticker = 'sim', onFrame = null} = {}) {
  resetBodyDynamics(); resetTravel(); resetSpineFlex(); resetArmLiftFamilies();
  const show = createSilhouetteShow(); show.setMode('silhouette');
  const ctx = recorder(), r = rng(seed);
  const home = []; for (let i = 0; i < dancers; i++) home.push({id: 200 + i, x: 150 + i * 220, y: 360 + (i % 2) * 50, type: i % 4});
  const st = new Map();
  const out = {frames: 0, minHip: Infinity, maxHip: 0, maxSh: 0, airborne: 0, slip: 0, jump: 0, drift: 0, restFrames: 0, plantedJump: 0, jumps: [], slips: []};
  let t = 0, f = 0;
  for (const ph of phases) {
    const period = 60 / (ph.bpm || 120);
    let lastBeat = -1;
    for (let i = 0; i < Math.round(ph.s * fps); i++, f++) {
      t += 1 / fps; const now = 1000 + t * 1000;
      const music = ph.kind === 'music';
      if (show.setHush) show.setHush(!music && i / fps >= 2, now);
      if (music) { const k = Math.floor(t / period); if (k !== lastBeat) { lastBeat = k; show.beat(now, (ph.bass ? 2 : 0) | (k % 2 ? 1 | 4 : 1 | 8)); } }
      const lvl = ph.level != null ? ph.level : 0.7; const e = music ? lvl * (0.75 + 0.35 * (t % period < 0.08)) : 0;
      // camera jitter + periodic re-detection snap
      const markers = home.map(h => ({id: h.id, type: h.type, kind: sticker, x: h.x + jitterPx * (r() - 0.5) * 2 + ((Math.floor(t / redetectEvery) % 2) ? 3 : 0), y: h.y + jitterPx * (r() - 0.5) * 2}));
      show.paint(ctx, markers, {now, levels: [e, ph.bass ? Math.min(1.4, e * 1.3) : e * 0.5, e * 0.9, e * 0.6], network: markers.map((m, i) => ({id: m.id, received: music ? (ph.level != null ? ph.level : 0.6) * (0.85 + 0.1 * i) : 0})), songOpen: music, xy: (x, y) => ({x, y})});
      for (const fr of show.figureHeights()) {
        const b = buildFor(fr.id, fr.band), L = mid(fr, -1), R = mid(fr, 1);
        // Widths are relative to the DRAWN figure (beat throb scales the whole body).
        const j = fr.joints;
        const contourH = fr.height;
        const thighH = j && j.hipL && j.kneeL ? Math.hypot(j.kneeL.x - j.hipL.x, j.kneeL.y - j.hipL.y, (j.kneeL.z || 0) - (j.hipL.z || 0)) / THIGH : contourH;
        // Hip-width ratios use the unthrobbed contour (planted feet do not
        // beat-throb). Shoulder-width cap uses the larger of contour and the
        // drawn thigh so a jitter-shrink of the sticker box cannot make a
        // legal 2.0 plant read as over-wide.
        const sep = projectedStanceWidth(L, R, j && j.hipL, j && j.hipR), hipPx = hipWidth(b) * contourH, shPx = 2 * b.shW * Math.max(contourH, thighH);
        const liftL = (fr.liftL || 0) / fr.height - 0.002, liftR = (fr.liftR || 0) / fr.height - 0.002; // drawn clearance (height units) minus the contact tolerance
        const s = st.get(fr.id) || {};
        out.frames++;
        if (f > fps * 3) {
          if (!music) { out.restFrames++; out.minHip = Math.min(out.minHip, sep / hipPx); out.maxHip = Math.max(out.maxHip, sep / hipPx); }
          if (liftL <= 0 && liftR <= 0) out.maxSh = Math.max(out.maxSh, sep / shPx); // measured on planted feet (FIX 1)
          out.maxShAny = Math.max(out.maxShAny || 0, sep / shPx);
          if (liftL > 0.001 && liftR > 0.001) out.airborne++;
          if (s.L) {
            const jl = Math.hypot(L.x - s.L.x, L.y - s.L.y), jr = Math.hypot(R.x - s.R.x, R.y - s.R.y);
            out.jump = Math.max(out.jump, jl, jr);
            // A planted foot may pivot on its heel or toe, never slide: slip is
            // the smaller travel of its two floor points.
            const moved = (a, b) => (a && b) ? Math.abs(a.x - b.x) : Infinity; // floor plane (x; depth is not in the 2D read-out)
            const slipOf = (tk, hk) => Math.min(moved(pt(fr, tk), s[tk]), moved(pt(fr, hk), s[hk]));
            if (liftL <= 0.001 && s.liftL <= 0.001) { const v = slipOf('footL', 'heelL'); out.slip = Math.max(out.slip, v); out.slips.push(v); }
            if (liftR <= 0.001 && s.liftR <= 0.001) { const v = slipOf('footR', 'heelR'); out.slip = Math.max(out.slip, v); out.slips.push(v); }
            // Mid-foot travel counts a heel-pivot as a hop. A pop is when
            // both the toe and the heel of a planted foot move in x (the
            // same definition as slip: a foot may pivot, never slide).
            if (liftL <= 0.001 && liftR <= 0.001 && !(+fr.jump > 0) && !(+s.jump > 0)) {
              const popL = slipOf("footL", "heelL");
              const popR = slipOf("footR", "heelR");
              out.plantedJump = Math.max(out.plantedJump || 0, Math.min(popL, popR));
            }
          }
          const air = liftL > 0.001 && liftR > 0.001;
          if (air) { s.air = (s.air || 0) + 1; s.airAct = Math.min(s.airAct ?? 9, +fr.activation || 0); }
          else if (s.air) { out.jumps.push({frames: s.air, minAct: s.airAct, t}); s.air = 0; s.airAct = undefined; }
          const h = home.find(q => q.id === fr.id);
          out.drift = Math.max(out.drift, Math.abs((L.x + R.x) / 2 - h.x) / fr.height);
        }
        st.set(fr.id, {jump: +fr.jump || 0, L, R, liftL, liftR, air: s.air, airAct: s.airAct, footL: pt(fr, 'footL'), heelL: pt(fr, 'heelL'), footR: pt(fr, 'footR'), heelR: pt(fr, 'heelR')});
        if (onFrame) onFrame(fr, {sep, hipPx, shPx, music, phase: ph, t, liftL, liftR, L, R});
      }
    }
  }
  const sl = out.slips.sort((a, b) => a - b); out.slipP99 = sl[Math.floor(sl.length * 0.99)] || 0; out.slipOver05 = sl.filter(v => v > 0.5).length; out.slips = sl.length;
  return out;
}
