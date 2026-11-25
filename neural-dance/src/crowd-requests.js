// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Live request queue for the crowd show (Paradise Dystopia, TJ Nov 24).
// Pure logic shared by the Worker (studio Durable Object keeps the state)
// and the pages. A request is {source, handle, text, createdAt}.
//
//  - FIFO queue. Approval toggle: ON = new requests wait for Approve on the
//    remote; OFF = straight to the queue. The content filter runs in both.
//  - Per handle: one request in line at a time, plus a cooldown (remote
//    slider). The remote paste box is TJ's own path: no cooldown, still
//    filtered.
//  - Statuses: pending (waiting for approve) -> queued -> playing -> done;
//    or skipped / killed / blocked (filter).

export const REQUEST_TEXT_MAX = 140;
export const REQUEST_KEEP = 60;
export const DEBUT_S = 34;              // one debut: walk in, 2 runs, fade back (ETA unit)
export const PLAYING_STALE_S = 180;     // a playing request the projector never finished
export const COOLDOWN_DEFAULT_S = 120;
export const COOLDOWN_MAX_S = 1800;
export const VOLUME_WINDOW_MS = 10 * 60000;
export const ANNOUNCE_MAX_MIN = 120;
export const X_HANDLE = 'TJ_de_la_playa';
export const X_TAGS = Object.freeze(['ParadiseDystopia']);
export const SOURCES = Object.freeze(['remote', 'x', 'test']);
const ACTIVE = new Set(['pending', 'queued', 'playing']);

export function cleanRequestText(value, max = REQUEST_TEXT_MAX) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f<>`\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function cleanHandle(value) {
  if (typeof value !== 'string') return '';
  const h = value.normalize('NFKC').trim().replace(/^@+/, '').replace(/[^\w.-]/g, '').slice(0, 30);
  return h ? '@' + h : '';
}

// ---- content filter (slurs and explicit text). Token stems after a
// leetspeak fold; also a separator-stripped pass for spaced-out words.
const FOLD = {'0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', '+': 't'};
const STEMS = ['nigg', 'nigga', 'fagg', 'fag', 'dyke', 'tranny', 'retard', 'spic', 'chink', 'kike', 'gook', 'wetback', 'raghead', 'coon', 'beaner',
  'fuck', 'fuk', 'shit', 'cunt', 'cock', 'dick', 'pussy', 'penis', 'vagina', 'boob', 'tits', 'titt', 'porn', 'nude', 'naked', 'sex', 'cum', 'jizz', 'blowjob', 'handjob', 'anal', 'horny', 'whore', 'slut', 'rape', 'molest', 'nazi', 'hitler', 'kkk', 'killyourself', 'kys', 'suicide'];
const EXACT = new Set(['ass', 'arse', 'tit', 'hoe', 'cum', 'fag', 'kys', 'nsfw', 'xxx', 'milf', 'dildo', 'butthole', 'asshole']);
const ALLOW = new Set(['cocktail', 'cockatoo', 'dickens', 'sextet', 'sexton', 'analog', 'analysis', 'analyze', 'spice', 'spicy', 'spick', 'coonhound', 'raccoon', 'cumbia', 'cumulative', 'scunthorpe', 'shitake', 'shiitake', 'class', 'pass', 'grass', 'bass', 'mass', 'assemble', 'hello']);
function fold(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[0134@57$!8+]/g, c => FOLD[c] || c); }
export function contentBlocked(text) {
  const f = fold(text || '');
  const tokens = f.split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) {
    if (ALLOW.has(t)) continue;
    if (EXACT.has(t)) return 'filtered';
    const squeezed = t.replace(/(.)\1{2,}/g, '$1$1');
    if (STEMS.some(s => squeezed.startsWith(s) || (s.length >= 5 && squeezed.includes(s)))) return 'filtered';
  }
  const joined = f.replace(/[^a-z]/g, '');
  if (['nigger', 'nigga', 'faggot', 'fuck', 'cunt', 'killyourself'].some(s => joined.includes(s))) return 'filtered';
  return '';
}

export function newQueueState() {
  return {items: [], seq: 0, handles: {}, settings: {approval: true, cooldownS: COOLDOWN_DEFAULT_S, xIntake: false, xReply: false}, announce: [], builds: [], pin: null, xSinceId: '', xLastPollAt: 0, xNote: ''};
}
export function normalizeQueueState(raw) {
  const st = newQueueState();
  if (!raw || typeof raw !== 'object') return st;
  if (Array.isArray(raw.items)) st.items = raw.items.slice(-REQUEST_KEEP);
  st.seq = +raw.seq || st.items.reduce((m, i) => Math.max(m, +i.id || 0), 0);
  if (raw.handles && typeof raw.handles === 'object') st.handles = raw.handles;
  Object.assign(st.settings, sanitizeSettings(raw.settings || {}, st.settings));
  if (Array.isArray(raw.announce)) st.announce = raw.announce.slice(-6);
  if (Array.isArray(raw.builds)) st.builds = raw.builds.slice(-8);
  st.pin = raw.pin && typeof raw.pin === 'object' ? raw.pin : null;
  st.xSinceId = typeof raw.xSinceId === 'string' ? raw.xSinceId : '';
  st.xLastPollAt = +raw.xLastPollAt || 0;
  st.xNote = typeof raw.xNote === 'string' ? raw.xNote.slice(0, 120) : '';
  return st;
}
export function sanitizeSettings(patch, base = newQueueState().settings) {
  const out = {...base};
  if (typeof patch.approval === 'boolean') out.approval = patch.approval;
  if (Number.isFinite(+patch.cooldownS) && patch.cooldownS !== null && patch.cooldownS !== '') out.cooldownS = Math.max(0, Math.min(COOLDOWN_MAX_S, Math.round(+patch.cooldownS)));
  if (typeof patch.xIntake === 'boolean') out.xIntake = patch.xIntake;
  if (typeof patch.xReply === 'boolean') out.xReply = patch.xReply;
  return out;
}

const findItem = (st, id) => st.items.find(i => i.id === (+id | 0)) || null;

// opts.trusted: TJ's remote paste box (no per-handle limits).
export function submitRequest(st, input, now = Date.now(), opts = {}) {
  const source = SOURCES.includes(input && input.source) ? input.source : 'remote';
  const handle = cleanHandle(input && input.handle) || (source === 'remote' ? '@tj' : '');
  const text = cleanRequestText(input && input.text);
  if (!handle) return {ok: false, reason: 'need a handle'};
  if (text.length < 2) return {ok: false, reason: 'need a move description'};
  const key = handle.toLowerCase();
  if (input && input.xId && st.items.some(i => i.xId && i.xId === String(input.xId))) return {ok: false, reason: 'duplicate'};
  if (!opts.trusted) {
    if (st.items.some(i => ACTIVE.has(i.status) && i.handle.toLowerCase() === key)) return {ok: false, reason: 'already in line'};
    const last = +st.handles[key] || 0;
    const left = last + st.settings.cooldownS * 1000 - now;
    if (left > 0) return {ok: false, reason: 'cooldown', remainingS: Math.ceil(left / 1000)};
  }
  const blocked = contentBlocked(text + ' ' + handle);
  const item = {id: ++st.seq, source, handle, text, createdAt: Number.isFinite(+input.createdAt) && +input.createdAt > 0 ? Math.min(+input.createdAt, now) : now, at: now,
    status: blocked ? 'blocked' : (st.settings.approval && !opts.trusted ? 'pending' : 'queued'), reason: blocked || ''};
  if (input && input.xId) item.xId = String(input.xId).replace(/\D/g, '').slice(0, 24);
  st.items.push(item);
  if (!blocked) st.handles[key] = now;
  trim(st, now);
  return blocked ? {ok: false, reason: 'filtered', item} : {ok: true, item};
}

function trim(st, now) {
  if (st.items.length > REQUEST_KEEP) {
    const keep = st.items.filter(i => ACTIVE.has(i.status));
    const old = st.items.filter(i => !ACTIVE.has(i.status)).slice(-(REQUEST_KEEP - keep.length));
    st.items = [...old, ...keep].sort((a, b) => a.id - b.id);
  }
  for (const k of Object.keys(st.handles)) if (now - st.handles[k] > COOLDOWN_MAX_S * 1000 + 60000) delete st.handles[k];
}

export function applyQueueOp(st, op, body = {}, now = Date.now()) {
  const it = body.id != null ? findItem(st, body.id) : null;
  if (op === 'approve') { if (!it || it.status !== 'pending') return {ok: false, reason: 'not waiting'}; it.status = 'queued'; return {ok: true, item: it}; }
  if (op === 'skip') { if (!it || !ACTIVE.has(it.status) || it.status === 'playing') return {ok: false, reason: 'not in line'}; it.status = 'skipped'; it.doneAt = now; return {ok: true, item: it}; }
  if (op === 'kill') {
    // Stops a debut that is already on the floor (or drops one in line).
    if (!it || !ACTIVE.has(it.status)) return {ok: false, reason: 'not active'};
    it.status = 'killed'; it.doneAt = now; return {ok: true, item: it};
  }
  if (op === 'settings') {
    const was = st.settings.approval;
    st.settings = sanitizeSettings(body, st.settings);
    // Turning approval off lets everything already waiting through.
    if (was && !st.settings.approval) for (const i of st.items) if (i.status === 'pending') i.status = 'queued';
    return {ok: true, settings: st.settings};
  }
  if (op === 'announce') {
    // "An update is coming" crystal: label + ETA in minutes (Grok or TJ).
    const min = Math.max(0.5, Math.min(ANNOUNCE_MAX_MIN, +body.etaMin || 0));
    if (!(+body.etaMin > 0)) { st.announce = []; return {ok: true, announce: []}; }
    st.announce = [{id: ++st.seq, label: cleanRequestText(body.label || 'Update', 40), at: now, etaAt: now + min * 60000}];
    return {ok: true, announce: st.announce};
  }
  if (op === 'clear-announce') { st.announce = []; return {ok: true}; }
  if (op === 'pin') {
    // Rollback: pin the projector to the previous build's hot modules.
    // No earlier build recorded yet: pin to 'base' (built-in moves and
    // events only, every hot module off), the safest state there is.
    const target = body.version ? st.builds.find(b => b.version === body.version) : (st.builds[st.builds.length - 2] || {version: 'base', hot: {}});
    if (!target) return {ok: false, reason: 'unknown build'};
    st.pin = {version: target.version, hot: target.hot || {}, at: now};
    return {ok: true, pin: st.pin};
  }
  if (op === 'unpin') { st.pin = null; return {ok: true}; }
  return {ok: false, reason: 'unknown op'};
}

// Projector side: report the running build; it is recorded once.
export function recordBuild(st, build, now = Date.now()) {
  if (!build || typeof build.version !== 'string' || !build.version) return false;
  const version = build.version.slice(0, 40);
  const hot = {};
  if (build.hot && typeof build.hot === 'object') for (const [k, v] of Object.entries(build.hot).slice(0, 40)) if (/^[\w-]{1,40}$/.test(k) && typeof v === 'string') hot[k] = v.slice(0, 16);
  const core = typeof build.core === 'string' ? build.core.slice(0, 16) : '';
  // A fast-path deploy can keep the commit and change only hot modules.
  const same = b => b.version === version && b.core === core && JSON.stringify(b.hot) === JSON.stringify(hot);
  const last = st.builds[st.builds.length - 1];
  if (last && same(last)) return false;
  st.builds = st.builds.filter(b => !same(b));
  st.builds.push({version, core, hot, firstSeen: now});
  st.builds = st.builds.slice(-8);
  return true;
}

export function claimNext(st, now = Date.now()) {
  for (const i of st.items) if (i.status === 'playing' && now - (i.startedAt || now) > PLAYING_STALE_S * 1000) { i.status = 'done'; i.doneAt = now; i.reason = 'timed out'; }
  if (st.items.some(i => i.status === 'playing')) return null;
  const next = st.items.find(i => i.status === 'queued');
  if (!next) return null;
  next.status = 'playing'; next.startedAt = now;
  return next;
}
export function finishRequest(st, id, now = Date.now(), moveId = '') {
  const it = findItem(st, id);
  if (!it || it.status !== 'playing') return {ok: false};
  it.status = 'done'; it.doneAt = now; if (moveId) it.moveId = String(moveId).slice(0, 60);
  return {ok: true, item: it};
}

export function recentVolume(st, now = Date.now(), windowMs = VOLUME_WINDOW_MS) {
  return st.items.filter(i => i.status !== 'blocked' && now - (i.at || 0) <= windowMs).length;
}
// Crowd energy bump from request volume: a busier queue, a livelier room.
export function requestEnergyBoost(volume) {
  const v = Math.max(0, +volume || 0);
  return Math.min(0.25, 0.25 * (1 - Math.exp(-v / 6)));
}

// ETA (ms epoch) for every playing/queued/pending item, FIFO.
export function queueEtas(st, now = Date.now(), debutS = DEBUT_S) {
  const out = {};
  let t = now;
  const playing = st.items.find(i => i.status === 'playing');
  if (playing) { t = Math.max(now + 3000, (playing.startedAt || now) + debutS * 1000); out[playing.id] = playing.startedAt || now; }
  for (const i of st.items) if (i.status === 'queued') { out[i.id] = t; t += debutS * 1000; }
  for (const i of st.items) if (i.status === 'pending') { out[i.id] = t; t += debutS * 1000; }
  return out;
}

export function publicQueue(st, now = Date.now()) {
  const etas = queueEtas(st, now);
  const items = st.items.slice(-25).map(i => ({id: i.id, source: i.source, handle: i.handle, text: i.text, status: i.status, reason: i.reason || '', at: i.at, createdAt: i.createdAt, eta: etas[i.id] || null, moveId: i.moveId || ''}));
  return {now, settings: st.settings, items, volume: recentVolume(st, now), boost: +requestEnergyBoost(recentVolume(st, now)).toFixed(3), announce: st.announce.filter(a => a.etaAt > now - 10 * 60000), builds: st.builds.slice(-4), pin: st.pin, xNote: st.xNote};
}

// ---- X (feature-flagged; needs credentials, see worker/neural-dance-x.mjs)
export function xSearchQuery(handle = X_HANDLE, tags = X_TAGS) {
  return '(' + ['@' + handle, ...tags.map(t => '#' + t)].join(' OR ') + ') -is:retweet -from:' + handle;
}
// X API v2 recent-search JSON -> request inputs (oldest first).
export function parseXRecent(json, handle = X_HANDLE) {
  if (!json || !Array.isArray(json.data)) return [];
  const users = new Map(((json.includes && json.includes.users) || []).map(u => [u.id, u.username]));
  const own = String(handle).toLowerCase();
  return json.data
    .filter(t => t && typeof t.text === 'string' && !/^RT @/.test(t.text) && String(users.get(t.author_id) || '').toLowerCase() !== own)
    .map(t => ({source: 'x', handle: users.get(t.author_id) || ('id' + t.author_id), text: t.text.replace(/https?:\/\/\S+/g, '').replace(new RegExp('@' + handle, 'ig'), '').trim(), createdAt: Date.parse(t.created_at) || Date.now(), xId: t.id}))
    .sort((a, b) => (BigInt(a.xId) < BigInt(b.xId) ? -1 : 1));
}
export function xReplyPayload(item, move) {
  const name = move && move.name ? move.name : 'your move';
  return {text: (item.handle + ' "' + name + '" just debuted on the Paradise Dystopia dance floor. Now it is in the crowd\'s library. #ParadiseDystopia').slice(0, 270), reply: {in_reply_to_tweet_id: item.xId}};
}
