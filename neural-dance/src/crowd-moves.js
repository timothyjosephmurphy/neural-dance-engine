// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Dance-move library for the crowd pages (live requests, TJ Nov 24).
// A move is a short program of existing pose primitives, so anything a
// request describes is built from motion the renderer already does well:
//   {id, name, by, beats, steps: [{p, beats, side?}], seed}
// parseMoveText() turns request text into a program with a fixed keyword
// grammar (deterministic, no network). moveFrame() samples a program at a
// beat position and returns pose modifiers that silhouette.js applies on
// top of the dancer's own groove (applyRoamMove there). The registry is
// keyed by id so hot modules (neural-dance/hot/*.js) can add moves live.

export const MOVE_MAX_STEPS = 8;
export const MOVE_BEATS_MIN = 4;
export const MOVE_BEATS_MAX = 16;
export const PRIMITIVES = Object.freeze(['step', 'hop', 'jump', 'squat', 'arms-up', 'pump', 'point', 'clap', 'clap-high', 'wave', 'shimmy', 'spin', 'pose', 'stomp', 'tall', 'robot', 'sway']);

// Keyword grammar: first match wins per word position. Phrases first.
const LEXICON = [
  [/\b(raise the roof|hands? up|arms? up|reach up|hands in the air)\b/g, 'arms-up'],
  [/\b(fist pump|pump(?:ing)?|fist)\b/g, 'pump'],
  [/\b(clap(?:s|ping)? (?:overhead|above|high)|high clap)\b/g, 'clap-high'],
  [/\b(clap(?:s|ping)?|handclap)\b/g, 'clap'],
  [/\b(two[- ]step|side[- ]step|step(?:s|ping)?|slide|shuffle|grapevine|walk|strut|moonwalk)\b/g, 'step'],
  [/\b(hop(?:s|ping)?|bounce|bouncing|skip|pogo)\b/g, 'hop'],
  [/\b(jump(?:s|ing)?|leap(?:s|ing)?|jumping jack)\b/g, 'jump'],
  [/\b(squat(?:s|ting)?|drop it|drop|get low|low|crouch|duck|dip|get down)\b/g, 'squat'],
  [/\b(point(?:s|ing)?|punch(?:es|ing)?|push|reach|forward|disco)\b/g, 'point'],
  [/\b(wave|waving|noodle|flail|wavy|arms? wave)\b/g, 'wave'],
  [/\b(shimmy|shake|shaking|wiggle|twerk|hips?|jiggle)\b/g, 'shimmy'],
  [/\b(spin(?:s|ning)?|turn(?:s|ing)?|twirl|pirouette|helicopter)\b/g, 'spin'],
  [/\b(freeze|pose|vogue|strike a pose|statue)\b/g, 'pose'],
  [/\b(stomp(?:s|ing)?|kick(?:s|ing)?|march(?:ing)?|stamp)\b/g, 'stomp'],
  [/\b(tiptoe|tip toe|stretch|tall|grow)\b/g, 'tall'],
  [/\b(robot|mechanical|pop and lock|popping|locking)\b/g, 'robot'],
  [/\b(sway(?:ing)?|rock(?:ing)?|lean|groove|vibe)\b/g, 'sway']
];
const SIDE_LEFT = /\bleft\b/, SIDE_RIGHT = /\bright\b/;

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'move';
}

function moveName(text, prims) {
  const words = String(text || '').replace(/[@#][\w]+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}' -]+/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1).slice(0, 4);
  const pretty = words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return (pretty || prims.slice(0, 2).map(p => p.replace('-', ' ')).join(' + ') || 'New move').slice(0, 32);
}

// text -> move program. Always returns a program (an unmatched text gets a
// seeded combination of primitives, so every request still debuts something).
export function parseMoveText(text, opts = {}) {
  const raw = String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\w]+/g, ' ');
  const seed = hashString((opts.handle || '') + '|' + raw);
  const rnd = seeded(seed);
  const hits = [];
  for (const [re, p] of LEXICON) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) hits.push({at: m.index, p, word: m[0]});
  }
  hits.sort((a, b) => a.at - b.at);
  // Drop overlaps (a phrase beats its single words).
  const used = [];
  for (const h of hits) if (!used.some(u => h.at < u.at + u.word.length && u.at < h.at + h.word.length)) used.push(h);
  let repeat = 1;
  const times = raw.match(/\b(twice|two times|x ?2|2x)\b/) ? 2 : raw.match(/\b(three times|thrice|x ?3|3x)\b/) ? 3 : 1;
  repeat = times;
  const speed = /\b(fast|quick|double time|rapid)\b/.test(raw) ? 0.5 : /\b(slow|slowly|half time|chill)\b/.test(raw) ? 2 : 1;
  let steps = used.map(h => {
    const after = raw.slice(h.at, h.at + h.word.length + 12);
    const side = SIDE_LEFT.test(after) ? -1 : SIDE_RIGHT.test(after) ? 1 : 0;
    return {p: h.p, beats: 2 * speed, side};
  });
  const matched = steps.length > 0;
  if (!matched) {
    const n = 3 + Math.floor(rnd() * 2);
    steps = Array.from({length: n}, () => ({p: PRIMITIVES[Math.floor(rnd() * PRIMITIVES.length)], beats: 2, side: 0}));
  }
  // A step without a side alternates so the dancer comes back to centre.
  let flip = rnd() < 0.5 ? -1 : 1;
  for (const s of steps) if ((s.p === 'step' || s.p === 'robot') && !s.side) { s.side = flip; flip = -flip; }
  if (steps.length === 1) steps.push({...steps[0], side: -(steps[0].side || 0)});
  if (repeat > 1) steps = Array.from({length: repeat}, () => steps.map(s => ({...s}))).flat();
  steps = steps.slice(0, MOVE_MAX_STEPS);
  let beats = steps.reduce((a, s) => a + s.beats, 0);
  if (beats < MOVE_BEATS_MIN) { const k = MOVE_BEATS_MIN / beats; for (const s of steps) s.beats *= k; beats = MOVE_BEATS_MIN; }
  if (beats > MOVE_BEATS_MAX) { const k = MOVE_BEATS_MAX / beats; for (const s of steps) s.beats *= k; beats = MOVE_BEATS_MAX; }
  const prims = steps.map(s => s.p);
  const name = cleanName(opts.name) || moveName(text, prims);
  return {id: slugify(name) + '-' + (seed % 46656).toString(36), name, by: cleanHandleLite(opts.handle), beats, steps, seed, matched};
}

function cleanName(s) { return typeof s === 'string' ? s.replace(/[<>`\\{}]/g, '').trim().slice(0, 32) : ''; }
function cleanHandleLite(s) { return typeof s === 'string' ? s.replace(/[^\w.@-]/g, '').slice(0, 32) : ''; }

// Validates a stored/remote program; returns a clean copy or null.
export function normalizeMove(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.steps) || !m.steps.length) return null;
  const steps = m.steps.slice(0, MOVE_MAX_STEPS).map(s => ({p: PRIMITIVES.includes(s && s.p) ? s.p : 'sway', beats: Math.max(0.5, Math.min(8, +s.beats || 2)), side: Math.sign(+s.side || 0)}));
  const beats = steps.reduce((a, s) => a + s.beats, 0);
  const name = cleanName(m.name) || 'Move';
  return {id: typeof m.id === 'string' && /^[a-z0-9-]{1,60}$/.test(m.id) ? m.id : slugify(name), name, by: cleanHandleLite(m.by), beats, steps, seed: (+m.seed >>> 0) || hashString(name)};
}

const ease = u => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
const ZERO = Object.freeze({dx: 0, lift: 0, squat: 0, armRaise: 0, armForward: 0, clap: 0, clapOh: 0, tall: 0});

// Pose modifiers at beat position `b` (beats since the move started).
// dx and lift are in body heights; the rest are 0..1 like the renderer's
// own squat / armLift / armForward / clap / tall inputs.
export function moveFrame(prog, b) {
  if (!prog || !prog.steps || !prog.steps.length) return ZERO;
  const total = prog.beats || prog.steps.reduce((a, s) => a + s.beats, 0);
  let x = ((b % total) + total) % total;
  let s = prog.steps[0];
  for (const st of prog.steps) { if (x < st.beats) { s = st; break; } x -= st.beats; }
  const u = Math.max(0, Math.min(1, x / s.beats));
  const bf = ((b % 1) + 1) % 1;            // beat fraction
  const out = {dx: 0, lift: 0, squat: 0, armRaise: 0, armForward: 0, clap: 0, clapOh: 0, tall: 0};
  const side = s.side || 1;
  switch (s.p) {
    case 'step': out.dx = side * 0.24 * Math.sin(Math.PI * u); out.lift = 0.02 * Math.abs(Math.sin(Math.PI * 2 * u)); break;
    case 'hop': out.lift = 0.07 * Math.abs(Math.sin(Math.PI * bf)); out.squat = 0.2 * (1 - Math.abs(Math.sin(Math.PI * bf))); break;
    case 'jump': out.lift = 0.17 * Math.sin(Math.PI * u); out.armRaise = 0.8 * Math.sin(Math.PI * u); out.squat = u < 0.15 ? 0.6 : 0; break;
    case 'squat': out.squat = 0.9 * Math.sin(Math.PI * u); break;
    case 'arms-up': out.armRaise = ease(Math.min(1, u * 3)); out.tall = 0.4; break;
    case 'pump': out.armRaise = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * bf)); out.lift = 0.02 * Math.abs(Math.sin(Math.PI * bf)); break;
    case 'point': out.armForward = 1; out.armRaise = 0.35 + 0.35 * (bf < 0.5 ? 1 : 0); out.dx = 0.03 * Math.sin(Math.PI * 2 * u); break;
    case 'clap': out.clap = Math.max(0, 1 - bf * 3.5); break;
    case 'clap-high': out.clap = Math.max(0, 1 - bf * 3.5); out.clapOh = 1; out.armRaise = 0.7; break;
    case 'wave': out.armRaise = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (u * s.beats)); out.dx = 0.03 * Math.sin(Math.PI * 2 * u); break;
    case 'shimmy': out.dx = 0.035 * Math.sin(Math.PI * 8 * u * s.beats / 2); out.squat = 0.25; break;
    case 'spin': out.dx = 0.09 * Math.sin(Math.PI * 4 * u); out.armRaise = 0.7; out.tall = 0.5; break;
    case 'pose': out.tall = 1; out.armForward = 0.8; out.armRaise = 0.6; break;
    case 'stomp': out.lift = 0.035 * Math.max(0, Math.sin(Math.PI * 2 * bf)); out.squat = 0.35; break;
    case 'tall': out.tall = ease(Math.min(1, u * 2)); out.armRaise = 0.3; break;
    case 'robot': out.dx = side * 0.12 * Math.round(Math.sin(Math.PI * u) * 4) / 4; out.armForward = 0.7; out.armRaise = 0.3 * (Math.round(u * 4) % 2); break;
    default: out.dx = 0.05 * Math.sin(Math.PI * 2 * u); break;   // sway
  }
  return out;
}

// ---- registry (shared library; hot modules and the request queue add here)
const registry = new Map();
export function registerMove(m) {
  const clean = normalizeMove(m);
  if (!clean) throw new Error('bad move');
  registry.set(clean.id, Object.freeze(clean));
  return registry.get(clean.id);
}
export function unregisterMove(id) { return registry.delete(id); }
export function moveById(id) { return registry.get(id) || null; }
export function moveIds() { return [...registry.keys()]; }
export function moveRegistrySnapshot() { return new Map(registry); }
export function restoreMoveRegistry(snap) { registry.clear(); for (const [k, v] of snap) registry.set(k, v); }

// ---- debut sting: a short WebAudio phrase seeded by the move, unique per move.
const SCALES = [[0, 3, 5, 7, 10], [0, 2, 4, 7, 9], [0, 2, 3, 7, 8], [0, 4, 7, 11, 14]];
export function stingNotes(prog) {
  const rnd = seeded((prog && prog.seed) || hashString(prog && prog.name));
  const scale = SCALES[Math.floor(rnd() * SCALES.length)];
  const root = 48 + Math.floor(rnd() * 12);
  const n = 3 + Math.floor(rnd() * 3);
  const wave = ['sawtooth', 'square', 'triangle'][Math.floor(rnd() * 3)];
  const notes = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const deg = Math.floor(rnd() * scale.length), oct = rnd() < 0.35 ? 12 : 0;
    const dur = [0.09, 0.12, 0.18][Math.floor(rnd() * 3)];
    notes.push({midi: root + scale[deg] + oct + (i === n - 1 ? 12 : 0), t, dur: i === n - 1 ? 0.42 : dur});
    t += dur * 0.9;
  }
  return {wave, notes, cutoff: 900 + Math.floor(rnd() * 2400), total: t + 0.45};
}
export function playSting(audioCtx, prog, gain = 0.18) {
  try {
    if (!audioCtx) return false;
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    const s = stingNotes(prog);
    const t0 = audioCtx.currentTime + 0.03;
    const out = audioCtx.createGain(); out.gain.value = gain;
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(s.cutoff, t0); lp.frequency.exponentialRampToValueAtTime(s.cutoff * 3, t0 + s.total);
    lp.connect(out); out.connect(audioCtx.destination);
    for (const n of s.notes) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = s.wave; o.frequency.value = 440 * Math.pow(2, (n.midi - 69) / 12);
      g.gain.setValueAtTime(0.0001, t0 + n.t); g.gain.exponentialRampToValueAtTime(1, t0 + n.t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.dur);
      o.connect(g); g.connect(lp); o.start(t0 + n.t); o.stop(t0 + n.t + n.dur + 0.05);
    }
    return true;
  } catch { return false; }
}
