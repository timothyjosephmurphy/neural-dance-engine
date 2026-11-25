// Pose activation (TJ 7:55 / 8:00 PM).
//
// Music input can be normalized over a rolling 20–30 s window so the loud
// parts of THIS song produce strong local intake. Each dancer then keeps
// its OWN activation: primarily energy received from neighbors through the
// pulse network, plus that dancer's local intake (own band). A per-dancer
// rolling-percentile maps that dancer's own peaks near 1.0 — we never copy
// a single global level onto every body.

export const SONG_ENERGY_WINDOW_MS = 25000;
export const SONG_ENERGY_MIN_RANGE = 0.08;
export const SONG_ENERGY_MAX_IDS = 64;
export const SONG_ENERGY_STALE_MS = 60000;
export const ARM_LIFT_FULL = 1.10;
// Blend of received pulse energy vs local (own-band) intake vs string motion.
export const RECEIVED_WEIGHT = 0.62;
export const LOCAL_WEIGHT = 0.28;
export const STRING_WEIGHT = 0.10;

const clamp01 = v => Math.max(0, Math.min(1, +v || 0));

export function bandEnergy(levels) {
  const lv = Array.isArray(levels) ? levels : [0, 0, 0, 0];
  let sum = 0, peak = 0;
  const n = Math.max(1, Math.min(4, lv.length));
  for (let i = 0; i < n; i++) {
    const x = Math.max(0, +lv[i] || 0);
    sum += x * x;
    if (x > peak) peak = x;
  }
  return 0.75 * Math.sqrt(sum / n) + 0.25 * peak;
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function createWindow(windowMs, minRange) {
  const samples = [];
  let last = {raw: 0, energy: 0, min: 0, max: minRange, n: 0};
  function process(now, raw, open = true) {
    const t = +now || 0;
    const x = Math.max(0, +raw || 0);
    // True silence: do not feed zeros into the window, or the next note
    // would look like a peak. Pose motion is already hushed.
    if (open) samples.push({t, e: x});
    const cut = t - windowMs;
    while (samples.length && samples[0].t < cut) samples.shift();
    if (samples.length > 2400) samples.splice(0, samples.length - 2400);
    const vals = samples.map(s => s.e).sort((a, b) => a - b);
    const lo = vals.length ? percentile(vals, 0.10) : 0;
    let hi = vals.length ? percentile(vals, 0.95) : lo + minRange;
    if (hi < lo + minRange) hi = lo + minRange;
    const energy = open && hi > lo ? clamp01((x - lo) / (hi - lo)) : 0;
    last = {raw: x, energy, min: lo, max: hi, n: samples.length};
    return last;
  }
  function value() { return last; }
  function reset() { samples.length = 0; last = {raw: 0, energy: 0, min: 0, max: minRange, n: 0}; }
  return {process, value, reset};
}

// Normalize the music input (band RMS) over ~25 s. Used to scale local
// intake. This is NOT copied onto dancers as their pose activation.
export function createSongEnergy(options = {}) {
  const windowMs = Math.max(4000, +options.windowMs || SONG_ENERGY_WINDOW_MS);
  const minRange = Math.max(0.02, +options.minRange || SONG_ENERGY_MIN_RANGE);
  const w = createWindow(windowMs, minRange);
  return {
    process(now, levels, opts = {}) {
      const open = opts.open !== false;
      return w.process(now, open ? bandEnergy(levels) : 0, open);
    },
    value: w.value,
    reset: w.reset,
    windowMs
  };
}

// Per-dancer rolling AGC on that dancer's raw intake (received + local).
export function createDancerEnergy(options = {}) {
  const windowMs = Math.max(4000, +options.windowMs || SONG_ENERGY_WINDOW_MS);
  const minRange = Math.max(0.02, +options.minRange || SONG_ENERGY_MIN_RANGE);
  const byId = new Map();
  // Soak test (Nov 9): dancer ids keep growing over a show (sticker re-scans,
  // sim reseeds) and each window keeps its samples, so drop windows that have
  // not been fed for SONG_ENERGY_STALE_MS once there are many of them.
  const seen = new Map();
  let lastPrune = -Infinity;
  function prune(now) {
    if (byId.size <= SONG_ENERGY_MAX_IDS || !(now - lastPrune > 1000)) return;
    lastPrune = now;
    for (const [key, at] of seen) {
      if (now - at > SONG_ENERGY_STALE_MS) { seen.delete(key); byId.delete(key); }
    }
  }
  function box(id) {
    const key = id | 0;
    let st = byId.get(key);
    if (!st) { st = createWindow(windowMs, minRange); byId.set(key, st); }
    return st;
  }
  function process(id, now, raw, opts = {}) {
    const open = opts.open !== false;
    const t = +now || 0;
    seen.set(id | 0, t);
    prune(t);
    return box(id).process(now, raw, open);
  }
  function value(id) { return box(id).value(); }
  function reset(id) {
    if (id == null) { byId.clear(); return; }
    const st = byId.get(id | 0);
    if (st) st.reset();
  }
  return {process, value, reset, windowMs, size: () => byId.size};
}

// Raw (pre-AGC) pose drive: received pulse energy is primary, then local
// intake (own-band level, already music-normalized), then string motion.
export function dancerIntake({received = 0, local = 0, stringAct = 0} = {}) {
  const rec = Math.max(0, +received || 0);
  const loc = Math.max(0, +local || 0);
  const str = clamp01((+stringAct || 0) / ARM_LIFT_FULL);
  return Math.max(0, RECEIVED_WEIGHT * rec + LOCAL_WEIGHT * loc + STRING_WEIGHT * str);
}

// Lightweight pulse-network stand-in for capture replay / tests (mirrors the
// WASM drain/arm path: local arm() on a band hit, then energy to neighbors
// with distance falloff, then decay).
export function createPulseNetwork(options = {}) {
  const linkR = Math.max(20, +options.linkR || 160);
  const decay = Number.isFinite(+options.decay) ? +options.decay : 1.5;
  const fire = Number.isFinite(+options.fire) ? +options.fire : 1.4;
  const cap = Number.isFinite(+options.cap) ? +options.cap : 2;
  let nodes = []; // {id,x,y,type,a,recv,ref}
  let t = 0;
  function setDancers(list) {
    const prev = new Map(nodes.map(d => [d.id, d]));
    nodes = (list || []).map(d => {
      const id = d.id | 0;
      const was = prev.get(id);
      return {id, x: +d.x || 0, y: +d.y || 0, type: d.type | 0, a: was ? was.a : 0, recv: was ? was.recv : 0, ref: was ? was.ref : -1};
    });
  }
  function tick(dt, now) {
    const step = Math.max(0, Math.min(0.067, +dt || 0));
    t = Number.isFinite(+now) ? +now / 1000 : t + step;
    for (const d of nodes) {
      d.a -= step * decay;
      if (d.a < 0) d.a = 0;
      d.recv -= step * decay;
      if (d.recv < 0) d.recv = 0;
    }
  }
  function hit(band, now) {
    const k = band | 0;
    const nowS = Number.isFinite(+now) ? +now / 1000 : t;
    const fired = [];
    for (const d of nodes) {
      if (d.type !== k) continue;
      // Own-band arm raises activity only — it is NOT received energy.
      d.a = Math.min(cap, Math.max(d.a + 0.25, 0.95));
      if (d.a >= fire && nowS >= d.ref) { d.ref = nowS + 0.2; fired.push(d); }
    }
    // One hop of drain from each newly armed dancer (wave to neighbors).
    const src = fired.length ? fired : nodes.filter(d => d.type === k);
    for (const a of src) {
      for (const b of nodes) {
        if (b.id === a.id) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist >= linkR) continue;
        const amount = (0.2 + 0.25 * (1 - dist / linkR));
        if (amount > 0) {
          b.a = Math.min(cap, b.a + amount);
          b.recv = Math.min(cap, b.recv + amount);
        }
      }
    }
  }
  function heard(id) {
    const self = nodes.find(n => n.id === (id | 0));
    if (!self) return 0;
    let h = 0;
    for (const n of nodes) {
      if (n.id === self.id) continue;
      const dist = Math.hypot(self.x - n.x, self.y - n.y);
      if (dist >= linkR) continue;
      h += n.a * (0.2 + 0.25 * (1 - dist / linkR));
    }
    return Math.min(cap, h);
  }
  function activity(id) {
    const d = nodes.find(n => n.id === (id | 0));
    return d ? d.a : 0;
  }
  function received(id) {
    const d = nodes.find(n => n.id === (id | 0));
    if (!d) return 0;
    const h = heard(id);
    return d.recv > h ? d.recv : h;
  }
  function snapshot() { return nodes.map(d => ({id: d.id, activity: d.a, received: received(d.id), type: d.type, x: d.x, y: d.y})); }
  function reset() { for (const d of nodes) { d.a = 0; d.recv = 0; d.ref = -1; } t = 0; }
  return {setDancers, tick, hit, activity, received, snapshot, reset};
}

export function resetSongEnergy(tracker) { if (tracker && typeof tracker.reset === 'function') tracker.reset(); }
