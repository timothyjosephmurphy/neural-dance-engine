// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Phone remote for /neural-dance/show/ and /demo/ (/control/ under each).
// Pairs exactly like /neural-dance/debug/: the studio key comes from a
// one-time #k= link (then removed from the address bar) or the key already
// saved on this phone. The key is never shown on the page. Commands go
// through the debug relay as {action:'crowd', ...}; the worker allowlists
// them (sanitizeCrowdCommand) and the projector phone applies them.

import {CROWD_EFFECTS, CROWD_EVENTS, CROWD_TEXT_MAX, STUDIO_ROOM, cleanCrowdText, readStudioKey, studioKeyFromHash, studioKeyFromPaste, writeStudioKey} from './debug-protocol.js';

const API = '/api/neural-dance/debug/';
const MODE = document.body.dataset.ndRemote || 'show';
const POLL_MS = 1200;
const root = document.getElementById('nd-remote');

const EVENT_LABELS = {'crowd-surf': 'Crowd surf', 'stage-dive': 'Stage dive', 'dome-slide': 'Dome slide', 'pole-spin': 'Pole spin', 'cage-shake': 'Cage shake', 'shoulder-ride': 'Shoulder ride', conga: 'Conga', 'dance-circle': 'Dance circle', 'lighter-wave': 'Lighter wave', 'hug-pileup': 'Hug pileup', 'rope-swing': 'Rope swing'};
const EFFECT_LABELS = {message: 'Message', 'scary-face': 'Scary face', blackout: 'Blackout', strobe: 'Strobe', 'wash-red': 'Red wash', 'wash-uv': 'UV wash', 'wash-rainbow': 'Rainbow', freeze: 'Freeze', 'slow-mo': 'Slow-mo', confetti: 'Confetti', fireworks: 'Fireworks', glitch: 'Glitch', spotlight: 'Spotlight', countdown: 'Countdown 10→1', 'shout-out': 'Shout-out', 'clear-effects': 'Clear effects'};
const TEXT_EFFECTS = new Set(['message', 'shout-out']);

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0d14;color:#eef1f8;font:500 15px/1.35 -apple-system,Inter,system-ui,sans-serif;-webkit-text-size-adjust:100%}
#nd-remote{max-width:560px;margin:0 auto;padding:max(10px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}
h1{font-size:17px;margin:4px 0 8px}
.card{background:#151a26;border:1px solid #232a3b;border-radius:16px;padding:12px;margin:10px 0}
.card h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#9aa4bd;margin:0 0 8px}
.status{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;position:sticky;top:0;z-index:2;background:#0b0d14ee;padding:6px 0;backdrop-filter:blur(6px)}
.stat{background:#151a26;border-radius:12px;padding:8px;text-align:center}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:#9aa4bd}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
button{min-height:48px;border-radius:12px;border:1px solid #2c3550;background:#1d2435;color:#f4f6fb;font:600 15px inherit;font-family:inherit;padding:8px;touch-action:manipulation}
button:active{background:#2f3a57}
button.on{background:#3b2f6b;border-color:#7a62ff}
button.warn{background:#4a2a1a;border-color:#ff9a4a}
input[type=range]{width:100%;height:40px;accent-color:#8fb8ff}
input[type=text],input[type=password]{width:100%;min-height:46px;border-radius:12px;border:1px solid #2c3550;background:#0f131d;color:#fff;padding:10px;font:inherit}
.row{display:flex;gap:8px;align-items:center}
.row>*{flex:1}
.muted{color:#9aa4bd;font-size:13px}
.thumb{width:100%;border-radius:10px;background:#000;aspect-ratio:16/10;object-fit:cover;display:block}
.toast{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));background:#222a3d;border:1px solid #3a4562;border-radius:12px;padding:10px 12px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#555;margin-right:6px}
.dot.ok{background:#3ddc84}.dot.stale{background:#ffb020}
`;

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k);
  return n;
}

function credentials() {
  let storage = null;
  try { storage = localStorage; } catch { storage = null; }
  const fromHash = studioKeyFromHash(location.hash);
  if (fromHash) {
    writeStudioKey(storage, fromHash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* hash stays this load */ }
    return fromHash;
  }
  return readStudioKey(storage);
}

let key = credentials();
let toastTimer = 0;
const toast = h('div', {class: 'toast', role: 'status'});
function say(text) { toast.textContent = text; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600); }

function url(action, extra = '') { return API + action + '?room=' + encodeURIComponent(STUDIO_ROOM) + '&key=' + encodeURIComponent(key) + extra; }

async function send(cmd) {
  if (!key) return;
  try {
    const res = await fetch(url('patch'), {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify({patch: {action: 'crowd', ...cmd}})});
    if (res.status === 403) { say('Remote key rejected. Pair again.'); return; }
    if (!res.ok) say('Not sent (' + res.status + ')');
    else poll(250);
  } catch { say('No connection'); }
}

function pairView() {
  const input = h('input', {type: 'password', autocomplete: 'off', placeholder: 'Paste the studio debug link or key', 'aria-label': 'Studio key'});
  root.replaceChildren(
    h('h1', {}, 'Neural Dance remote'),
    h('div', {class: 'card'},
      h('p', {}, 'Pair this phone the same way as the debug page: open the studio debug link on this phone once, or paste it here. It is saved on this phone only.'),
      input,
      h('p', {}),
      h('button', {type: 'button', on: {click: () => {
        const k = studioKeyFromPaste(input.value);
        if (!k) { say('That is not a studio key.'); return; }
        try { writeStudioKey(localStorage, k); } catch { /* memory only */ }
        key = k; input.value = '';
        mainView();
      }}}, 'Pair')
    ),
    toast
  );
}

let state = null, updatedAt = 0, els = {};
let pendingForce = false;

function mainView() {
  const stat = (label, k) => { const b = h('b', {}, '—'); els[k] = b; return h('div', {class: 'stat'}, b, h('span', {}, label)); };
  els.link = h('span', {class: 'muted'}, h('span', {class: 'dot'}), 'waiting for the projector…');
  const speedOut = h('output', {}, '1×'); els.speedOut = speedOut;
  const speed = h('input', {type: 'range', min: '0', max: '6', step: '1', value: '0', 'aria-label': 'Speed', on: {change: () => send({op: 'speed', value: [1, 2, 5, 10, 30, 60, 120][+speed.value]})}});
  els.speed = speed;
  const scrubOut = h('output', {}, ''); els.scrubOut = scrubOut;
  const scrub = h('input', {type: 'range', min: '0', max: '430', step: '1', value: '0', 'aria-label': 'Show timeline', on: {
    input: () => { scrubOut.textContent = minuteLabel(+scrub.value); },
    change: () => send({op: 'scrub', value: +scrub.value})}});
  els.scrub = scrub;
  const boostOut = h('output', {}, '+0.00'); els.boostOut = boostOut;
  const boost = h('input', {type: 'range', min: '-0.5', max: '0.5', step: '0.05', value: '0', 'aria-label': 'Energy boost', on: {
    input: () => { boostOut.textContent = (+boost.value >= 0 ? '+' : '') + (+boost.value).toFixed(2); },
    change: () => send({op: 'boost', value: +boost.value})}});
  els.boost = boost;
  const text = h('input', {type: 'text', maxlength: String(CROWD_TEXT_MAX), placeholder: 'Text for Message / Shout-out', 'aria-label': 'Effect text', autocomplete: 'off'});
  const btn = (label, fn, attrs = {}) => h('button', {type: 'button', ...attrs, on: {click: fn}}, label);
  const lights = btn('Stage lights', () => send({op: 'light'})); els.lights = lights;
  const capBtn = btn('Capture now', () => {
    const c = state && state.capture;
    if (c && c.cooldownMin > 0 && !pendingForce) {
      pendingForce = true; capBtn.classList.add('warn');
      capBtn.textContent = 'Cooldown ' + c.cooldownMin.toFixed(0) + ' min · tap again to override';
      setTimeout(() => { pendingForce = false; capBtn.classList.remove('warn'); capBtn.textContent = 'Capture now'; }, 5000);
      return;
    }
    send({op: 'capture', force: pendingForce});
    pendingForce = false; capBtn.classList.remove('warn'); capBtn.textContent = 'Capture now';
  });
  els.thumb = h('img', {class: 'thumb', alt: 'Last white capture', hidden: ''});
  els.thumb.addEventListener('load', () => { els.thumb.hidden = false; });
  els.thumb.addEventListener('error', () => { els.thumb.hidden = true; });
  els.capInfo = h('p', {class: 'muted'}, 'No capture yet');
  const interval = h('input', {type: 'range', min: '20', max: '90', step: '5', value: '20', 'aria-label': 'Capture interval minutes', on: {change: () => send({op: 'interval', value: +interval.value})}});
  els.interval = interval; els.intervalOut = h('output', {}, '20 min');

  const sections = [
    h('h1', {}, MODE === 'show' ? 'Neural Dance show remote' : 'Neural Dance demo remote'),
    els.link,
    h('div', {class: 'status'}, stat('show time', 'clock'), stat('energy', 'energy'), stat('dancers', 'dancers'))
  ];
  if (MODE === 'show') sections.push(h('div', {class: 'card'}, h('h2', {}, 'Clock'),
    h('div', {class: 'row'}, h('span', {}, 'Speed '), speedOut), speed,
    h('div', {class: 'grid3'}, btn('−15m', () => send({op: 'jump', value: -15})), btn('+15m', () => send({op: 'jump', value: 15})), btn('+1h', () => send({op: 'jump', value: 60}))),
    h('div', {class: 'row'}, h('span', {}, 'Timeline '), scrubOut), scrub,
    h('div', {class: 'grid3'}, btn('9 PM', () => send({op: 'scrub', value: 0})), btn('Peak', () => send({op: 'scrub', value: 370})), btn('4 AM end', () => send({op: 'scrub', value: 417}))),
    h('p', {}), btn('Back to live clock', () => send({op: 'reset'}))));
  sections.push(h('div', {class: 'card'}, h('h2', {}, 'Energy'),
    h('div', {class: 'row'}, h('span', {}, 'Boost '), boostOut), boost,
    h('div', {class: 'grid'}, lights, MODE === 'demo' ? btn('Add dancer', () => send({op: 'add'})) : btn('Resume (clear fx)', () => send({op: 'resume'})), els.props = btn('Pole · cage · rope', () => send({op: 'props'})))));
  if (MODE === 'show') sections.push(h('div', {class: 'card'}, h('h2', {}, 'White capture'), els.thumb, els.capInfo,
    capBtn, h('div', {class: 'row'}, h('span', {}, 'Every '), els.intervalOut), interval,
    h('p', {class: 'muted'}, 'Waits 20 min minimum, then for a drop; no drop within 10 more min fires anyway.')));
  sections.push(h('div', {class: 'card'}, h('h2', {}, 'Rare events'),
    h('div', {class: 'grid'}, ...CROWD_EVENTS.map(name => btn(EVENT_LABELS[name] || name, () => send({op: 'event', name}))))));
  sections.push(h('div', {class: 'card'}, h('h2', {}, 'Effects'), text, h('p', {}),
    h('div', {class: 'grid'}, ...CROWD_EFFECTS.map(name => btn(EFFECT_LABELS[name] || name, () => {
      const t = cleanCrowdText(text.value);
      if (name === 'message' && !t) { say('Type a message first.'); return; }
      send(TEXT_EFFECTS.has(name) && t ? {op: 'effect', name, text: t} : {op: 'effect', name});
    })))));
  sections.push(...liveSections(btn));
  els.result = h('p', {class: 'muted'}, '');
  sections.push(els.result, btn('Forget this phone\'s key', () => { try { localStorage.removeItem('nd.studioDebug.v1'); } catch {} key = ''; pairView(); }), toast);
  root.replaceChildren(...sections);
  poll(0);
  livePoll(0);
}

function minuteLabel(m) {
  const t = (21 * 60 + Math.round(m)) % 1440, hh = Math.floor(t / 60), mm = t % 60;
  return ((hh + 11) % 12 + 1) + ':' + String(mm).padStart(2, '0') + (hh >= 12 ? ' PM' : ' AM');
}

let pollTimer = 0;
function poll(delay = POLL_MS) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!key) return;
    try {
      const res = await fetch(url('crowd'), {cache: 'no-store'});
      if (res.status === 403) { say('Remote key rejected. Pair again.'); key = ''; pairView(); return; }
      if (res.ok) { const data = await res.json(); state = data.crowd; updatedAt = data.updatedAt || 0; paint(data); }
    } catch { /* offline: keep polling */ }
    if (!document.hidden) poll();
  }, delay);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && key) poll(0); });

function paint(data) {
  const age = updatedAt ? (Date.now() - updatedAt) / 1000 : Infinity;
  const live = state && age < 15;
  els.link.replaceChildren(h('span', {class: 'dot ' + (live ? 'ok' : (state ? 'stale' : ''))}),
    live ? (state.mode === MODE ? 'Projector connected' : 'Projector is on the ' + state.mode + ' page') + (state.build ? ' · build ' + state.build.slice(0, 7) : '')
      : state ? 'Projector last seen ' + Math.round(age) + ' s ago' : 'Waiting for the projector (open /neural-dance/' + MODE + '/ on the paired phone)');
  if (!state) return;
  const s = state.show;
  els.clock.textContent = s ? (s.inShow ? s.clock : (s.static >= 1 ? 'static' : s.clock)) : 'demo';
  els.energy.textContent = s ? s.boosted.toFixed(2) : (state.audio || 0).toFixed(2);
  els.dancers.textContent = String(state.dancers);
  if (s) {
    els.speedOut.textContent = s.speed + '×';
    const idx = [1, 2, 5, 10, 30, 60, 120].findIndex(v => v >= s.speed - 1e-9);
    if (document.activeElement !== els.speed) els.speed.value = String(idx < 0 ? 6 : idx);
    if (document.activeElement !== els.scrub && s.minutes != null) { els.scrub.value = String(s.minutes); els.scrubOut.textContent = s.clock; }
    else if (s.minutes == null) els.scrubOut.textContent = s.static > 0 ? 'ended (static)' : 'before 9 PM';
  }
  if (document.activeElement !== els.boost) { els.boost.value = String(state.boost || 0); els.boostOut.textContent = ((state.boost || 0) >= 0 ? '+' : '') + (+state.boost || 0).toFixed(2); }
  els.lights.classList.toggle('on', !!state.lights);
  if (els.props) els.props.classList.toggle('on', state.props !== false);
  paintLiveTelemetry(state.live || null, state.capture || null);
  const c = state.capture;
  if (c && els.capInfo) {
    if (c.thumb && els.thumb.getAttribute('src') !== c.thumb) els.thumb.src = c.thumb;
    else if (!c.thumb && c.lastName && !els.thumb.getAttribute('src')) els.thumb.src = url('capture.jpg', '&name=' + encodeURIComponent(c.lastName));
    const phase = c.phase === 'build' ? 'building to white…' : c.phase === 'white' ? 'WHITE — capturing' : c.phase === 'fade' ? 'fading back' : (c.cooldownMin > 0 ? 'cooldown ' + c.cooldownMin.toFixed(0) + ' min' : (c.building ? 'drop building, ready' : 'armed, waiting for a drop (forces in ' + Math.max(0, c.forceInMin).toFixed(0) + ' min)'));
    els.capInfo.textContent = c.count + ' captured · ' + c.stored + ' saved privately · ' + phase + (c.note ? ' · ' + c.note : '');
    if (document.activeElement !== els.interval) { els.interval.value = String(c.intervalMin); els.intervalOut.textContent = c.intervalMin + ' min'; }
  }
  const lc = state.lastCmd;
  if (lc && els.result) els.result.textContent = 'Last: ' + lc.op + (lc.name ? ' ' + lc.name : '') + (lc.ok ? ' ✓' : ' ✗ ' + lc.note);
}

// ---- live requests, queue, approval toggle, hot updates and rollback
// (studio room /requests endpoint; same studio key as everything else).
let live = null, liveTimer = 0, rollbackArmed = false;
async function liveCall(body) {
  if (!key) return null;
  try {
    const res = await fetch(url('requests'), body ? {method: 'POST', headers: {'content-type': 'application/json'}, cache: 'no-store', body: JSON.stringify(body)} : {cache: 'no-store'});
    if (res.status === 403) { say('Remote key rejected. Pair again.'); return null; }
    const data = await res.json().catch(() => null);
    if (data && data.queue) { live = data; try { paintLive(); } catch (err) { console.error('remote paint', err); } }
    if (body && data && data.result && data.result.ok === false) say('Not done: ' + (data.result.reason || 'refused') + (data.result.remainingS ? ' (' + data.result.remainingS + ' s)' : ''));
    return data;
  } catch { say('No connection'); return null; }
}
function livePoll(delay = 2500) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => { await liveCall(null); if (!document.hidden) livePoll(); }, delay);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && key) livePoll(0); });

const STATUS_TEXT = {pending: 'waiting for approve', queued: 'in line', playing: 'ON THE FLOOR', done: 'done', skipped: 'skipped', killed: 'killed', blocked: 'blocked by filter'};
function liveSections(btn) {
  els.approve = btn('Approval: ON', () => live && liveCall({op: 'settings', approval: !live.queue.settings.approval}));
  els.cooldown = h('input', {type: 'range', min: '0', max: '600', step: '15', value: '120', 'aria-label': 'Per-handle cooldown seconds', on: {
    input: () => { els.cooldownOut.textContent = els.cooldown.value + ' s'; },
    change: () => liveCall({op: 'settings', cooldownS: +els.cooldown.value})}});
  els.cooldownOut = h('output', {}, '120 s');
  const handle = h('input', {type: 'text', maxlength: '30', placeholder: '@handle (who asked)', 'aria-label': 'Requester handle', autocomplete: 'off', autocapitalize: 'none'});
  const text = h('input', {type: 'text', maxlength: '140', placeholder: 'Describe the move: e.g. hop left, clap twice, spin', 'aria-label': 'Move description', autocomplete: 'off'});
  const sendReq = btn('Send request to the floor', async () => {
    const t = text.value.trim();
    if (t.length < 2) { say('Describe the move first.'); return; }
    const res = await liveCall({op: 'submit', handle: handle.value.trim() || '@tj', text: t});
    if (res && res.result && res.result.ok) { text.value = ''; say('Queued #' + res.result.item.id); }
  });
  els.queueInfo = h('p', {class: 'muted'}, 'Loading queue…');
  els.queue = h('div', {});
  els.xInfo = h('p', {class: 'muted'}, '');
  els.xIntake = btn('X intake: OFF', () => live && liveCall({op: 'settings', xIntake: !live.queue.settings.xIntake}));
  els.xReply = btn('X replies: OFF', () => live && liveCall({op: 'settings', xReply: !live.queue.settings.xReply}));
  els.killDebut = btn('Stop the move on the floor', () => send({op: 'debut-kill'}), {class: 'warn'});
  // Live updates
  els.build = h('p', {class: 'muted'}, 'Build: —');
  els.rollback = btn('ROLLBACK', () => {
    if (!rollbackArmed) { rollbackArmed = true; els.rollback.textContent = 'Tap again to roll back'; els.rollback.classList.add('warn'); setTimeout(() => { rollbackArmed = false; els.rollback.textContent = 'ROLLBACK'; els.rollback.classList.remove('warn'); }, 5000); return; }
    rollbackArmed = false; els.rollback.textContent = 'ROLLBACK'; els.rollback.classList.remove('warn');
    liveCall({op: 'pin'}).then(r => { if (r && r.result && r.result.ok) say('Rolled back to ' + String(r.result.pin.version).slice(0, 7)); });
  }, {class: 'warn'});
  els.unpin = btn('Unpin (take updates again)', () => liveCall({op: 'unpin'}));
  const etaLabel = h('input', {type: 'text', maxlength: '40', placeholder: 'What is coming (e.g. new conga event)', 'aria-label': 'Update label', autocomplete: 'off'});
  const etaMin = h('input', {type: 'range', min: '1', max: '30', step: '1', value: '5', 'aria-label': 'Update ETA minutes', on: {input: () => { etaOut.textContent = etaMin.value + ' min'; }}});
  const etaOut = h('output', {}, '5 min');
  els.library = h('div', {});
  return [
    h('div', {class: 'card'}, h('h2', {}, 'Requests'), els.queueInfo,
      h('div', {class: 'grid'}, els.approve, els.killDebut),
      h('div', {class: 'row'}, h('span', {}, 'Per-handle cooldown '), els.cooldownOut), els.cooldown,
      h('p', {class: 'muted'}, 'Approval ON: new requests wait for Approve. OFF: straight to the floor. The filter blocks slurs and explicit text either way. One request in line per handle.'),
      els.queue),
    h('div', {class: 'card'}, h('h2', {}, 'Paste a request'), handle, h('p', {}), text, h('p', {}), sendReq,
      h('p', {class: 'muted'}, 'Your own path: always accepted (still filtered), no cooldown, joins the same line.')),
    h('div', {class: 'card'}, h('h2', {}, 'X intake'), els.xInfo, h('div', {class: 'grid'}, els.xIntake, els.xReply)),
    h('div', {class: 'card'}, h('h2', {}, 'Live updates'), els.build,
      h('div', {class: 'grid'}, els.rollback, els.unpin),
      h('p', {class: 'muted'}, 'ROLLBACK pins the projector to the previous build\'s moves and events, instantly, without a reload. Unpin to take updates again.'),
      h('div', {class: 'grid'}, btn('Check for update now', () => send({op: 'hot-check'})), btn('Refresh queue on projector', () => send({op: 'requests-now'}))),
      h('p', {}), etaLabel, h('div', {class: 'row'}, h('span', {}, 'Update ETA '), etaOut), etaMin,
      h('div', {class: 'grid'}, btn('Show ETA crystal', () => liveCall({op: 'announce', label: etaLabel.value.trim() || 'Update', etaMin: +etaMin.value})), btn('Clear ETA', () => liveCall({op: 'clear-announce'})))),
    h('div', {class: 'card'}, h('h2', {}, 'Dance library'), els.library)
  ];
}
function etaText(ms) {
  if (!ms) return '';
  const s = Math.round((ms - Date.now() + (live ? Date.now() - live.queue.now : 0)) / 1000);
  return s <= 0 ? 'any moment' : s < 90 ? '~' + s + ' s' : '~' + Math.round(s / 60) + ' min';
}
function paintLive() {
  if (!live || !els.queue) return;
  const q = live.queue, st = q.settings;
  els.approve.textContent = 'Approval: ' + (st.approval ? 'ON' : 'OFF');
  els.approve.classList.toggle('on', !!st.approval);
  if (document.activeElement !== els.cooldown) { els.cooldown.value = String(st.cooldownS); els.cooldownOut.textContent = st.cooldownS + ' s'; }
  const active = q.items.filter(i => i.status === 'pending' || i.status === 'queued' || i.status === 'playing');
  els.queueInfo.textContent = active.length + ' in line · ' + q.volume + ' requests in 10 min · crowd boost +' + (+q.boost || 0).toFixed(2);
  const rows = q.items.slice().reverse().slice(0, 14).map(i => {
    const acts = [];
    if (i.status === 'pending') acts.push(h('button', {type: 'button', class: 'on', on: {click: () => liveCall({op: 'approve', id: i.id})}}, 'Approve'));
    if (i.status === 'pending' || i.status === 'queued') acts.push(h('button', {type: 'button', on: {click: () => liveCall({op: 'skip', id: i.id})}}, 'Skip'));
    if (i.status === 'queued' || i.status === 'playing' || i.status === 'pending') acts.push(h('button', {type: 'button', class: 'warn', on: {click: () => { liveCall({op: 'kill', id: i.id}); if (i.status === 'playing') send({op: 'debut-kill'}); }}}, 'Kill'));
    return h('div', {class: 'card', style: 'margin:6px 0;padding:8px'},
      h('div', {}, h('b', {}, i.handle + ' '), h('span', {class: 'muted'}, '#' + i.id + ' · ' + i.source + ' · ' + (STATUS_TEXT[i.status] || i.status) + (i.status === 'queued' || i.status === 'pending' ? ' · ' + etaText(i.eta) : ''))),
      h('div', {}, i.text),
      acts.length ? h('div', {class: 'grid3', style: 'margin-top:6px'}, ...acts) : '');
  });
  els.queue.replaceChildren(...(rows.length ? rows : [h('p', {class: 'muted'}, 'No requests yet.')]));
  const x = live.x || {};
  els.xIntake.textContent = 'X intake: ' + (st.xIntake ? 'ON' : 'OFF'); els.xIntake.classList.toggle('on', !!st.xIntake);
  els.xReply.textContent = 'X replies: ' + (st.xReply ? 'ON' : 'OFF'); els.xReply.classList.toggle('on', !!st.xReply);
  els.xInfo.textContent = 'Watches @TJ_de_la_playa and #ParadiseDystopia once a minute. Read key: ' + (x.read ? 'set' : 'missing') + ' · reply key: ' + (x.write ? 'set' : 'missing') + (q.xNote ? ' · ' + q.xNote : '') + '. Use the paste box meanwhile.';
  const lib = live.library || [];
  els.library.replaceChildren(...(lib.length ? lib.slice().reverse().slice(0, 30).map(m => h('div', {class: 'row', style: 'margin:4px 0'}, h('span', {}, m.name + (m.by ? ' · ' + m.by : '')), h('button', {type: 'button', style: 'flex:0 0 auto', 'aria-label': 'Remove ' + m.name, on: {click: () => liveCall({op: 'library-remove', id: m.id})}}, 'Remove'))) : [h('p', {class: 'muted'}, 'New moves land here after their debut. The 3 starter moves ship with the build.')]));
  paintBuild();
}
let lastLiveTelemetry = null, lastCapture = null;
function paintLiveTelemetry(t, cap) { lastLiveTelemetry = t; lastCapture = cap; paintBuild(); }
function paintBuild() {
  if (!els.build) return;
  const t = lastLiveTelemetry, q = live && live.queue;
  const builds = q && q.builds ? q.builds : [];
  const cur = state && state.build ? state.build.slice(0, 7) : '—';
  const prev = builds.length > 1 ? builds[builds.length - 2].version.slice(0, 7) : 'none recorded yet';
  const bits = ['Running ' + cur + (t && t.core ? ' (core ' + t.core.slice(0, 6) + ')' : ''), 'previous ' + prev];
  if (q && q.pin) bits.push('PINNED to ' + String(q.pin.version).slice(0, 7));
  if (t && t.pendingUpdate) bits.push('update waiting: ' + t.pendingUpdate.kind);
  if (t && t.lastUpdate) bits.push('last: ' + t.lastUpdate.kind + (t.lastUpdate.note ? ' (' + t.lastUpdate.note + ')' : ''));
  if (t && t.debut) bits.push('on the floor: ' + t.debut.handle + ' · ' + t.debut.name + ' (' + t.debut.phase + ')');
  if (t) bits.push('library ' + t.library + ' moves · hot: ' + (t.hot || []).join(', '));
  if (lastCapture && lastCapture.style) bits.push('last trip: ' + lastCapture.style);
  els.build.textContent = bits.join(' · ');
  els.unpin.disabled = !(q && q.pin);
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);
if (key) mainView(); else pairView();
