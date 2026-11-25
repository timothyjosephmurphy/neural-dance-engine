// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Opt-in Neural Dance live debug room.
// One Durable Object per unguessable room code. The phone publishes ~1.3 fps
// JPEG frames and telemetry. A viewer key reads them. A publisher secret writes.
// Storage is the latest snapshot plus a 10-frame telemetry ring, deleted by an
// alarm after 30 minutes without a visit.

import {applyQueueOp, claimNext, finishRequest, normalizeQueueState, publicQueue, recordBuild, submitRequest} from '../neural-dance/src/crowd-requests.js';
import {normalizeMove} from '../neural-dance/src/crowd-moves.js';
import {pollX, replyX, xStatus} from './neural-dance-x.mjs';
import {DEBUG_IDLE_MS, DEBUG_RING, DEBUG_WS_BUFFER_MAX, ROOM_RE, STUDIO_ROOM, newPublisherId, sameSecret, sanitizeDebugPatch, shouldDropDebugSend, validPublisherId, validSecret} from '../neural-dance/debug-protocol.js';

export const NEURAL_DANCE_DEBUG_API = '/api/neural-dance/debug/';
export const NEURAL_DANCE_DEBUG_WORKER_FIRST = ['/api/neural-dance/debug/*'];

const PRIVATE = {'Cache-Control': 'no-store'};

function json(data, status = 200) {
  return Response.json(data, {status, headers: PRIVATE});
}

function forbid() {
  return json({error: 'Forbidden'}, 403);
}

export function debugAction(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path === '/api/neural-dance/debug/claim') return 'claim';
  if (path === '/api/neural-dance/debug/frame') return 'frame';
  if (path === '/api/neural-dance/debug/snapshot') return 'snapshot';
  if (path === '/api/neural-dance/debug/camera.jpg') return 'camera';
  if (path === '/api/neural-dance/debug/stage.jpg') return 'stage';
  if (path === '/api/neural-dance/debug/last-scan/before.jpg') return 'scan-before';
  if (path === '/api/neural-dance/debug/last-scan/after.jpg') return 'scan-after';
  if (path === '/api/neural-dance/debug/last-scan/diff.jpg') return 'scan-diff';
  if (path === '/api/neural-dance/debug/last-scan') return 'last-scan';
  if (path === '/api/neural-dance/debug/patch') return 'patch';
  if (path === '/api/neural-dance/debug/result') return 'result';
  if (path === '/api/neural-dance/debug/ws') return 'ws';
  if (path === '/api/neural-dance/debug/capture') return 'capture';
  if (path === '/api/neural-dance/debug/crowd') return 'crowd';
  if (path === '/api/neural-dance/debug/captures') return 'captures';
  if (path === '/api/neural-dance/debug/capture.jpg') return 'capture-image';
  if (path === '/api/neural-dance/debug/requests') return 'requests';
  return '';
}

function readJson(sql, key) {
  const rows = sql.exec('SELECT v FROM nd_debug WHERE k = ?', key).toArray();
  if (!rows.length || rows[0].v == null) return null;
  try { return JSON.parse(rows[0].v); } catch { return null; }
}

function writeJson(sql, key, value) {
  if (value == null) {
    sql.exec('DELETE FROM nd_debug WHERE k = ?', key);
    return;
  }
  sql.exec('INSERT INTO nd_debug (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, JSON.stringify(value));
}

function normalizeJpeg(value, maxLen = 200000) {
  if (typeof value !== 'string' || !value) return null;
  let b64 = value.trim();
  const wrapped = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=\s]+)$/i.exec(b64);
  if (wrapped) b64 = wrapped[1];
  else if (b64.startsWith('data:')) return null;
  b64 = b64.replace(/\s+/g, '');
  const cap = Number.isFinite(+maxLen) && +maxLen > 8 ? +maxLen : 200000;
  if (b64.length < 8 || b64.length > cap) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return b64;
}

export const SCAN_JPEG_MAX = 900000;
// Show white-capture stills (crowd show). Kept in their own table, which the
// idle alarm never clears, so they stay until deleted on purpose. Private:
// the studio key (or the room's viewer key) is required to list or read.
export const CAPTURE_JPEG_MAX = 1900000;
export const CAPTURE_KEEP = 400;
export function captureName(at, tz = 'America/Los_Angeles') {
  const d = new Date(+at || Date.now());
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', {timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(d); } catch { parts = []; }
  const g = t => (parts.find(p => p.type === t) || {value: '00'}).value;
  return 'nd-white-' + g('year') + '-' + g('month') + '-' + g('day') + '_' + (g('hour') === '24' ? '00' : g('hour')) + g('minute') + g('second') + '-PT.jpg';
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function cleanTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let copy;
  try { copy = JSON.parse(JSON.stringify(value)); } catch { return null; }
  delete copy.cameraJpeg;
  delete copy.stageJpeg;
  // Sharp scan stills travel as their own JPEGs. The socket keeps the scores.
  copy = stripScanThumbs(copy);
  const cap = 180000;
  if (JSON.stringify(copy).length <= cap) return copy;
  return null;
}

function stripScanThumbs(telemetry) {
  const scan = telemetry && telemetry.painting && telemetry.painting.lastScan;
  if (!scan || (scan.before == null && scan.after == null && scan.diff == null)) return telemetry;
  let copy;
  try { copy = JSON.parse(JSON.stringify(telemetry)); } catch { return telemetry; }
  const next = copy.painting && copy.painting.lastScan;
  if (next) { delete next.before; delete next.after; delete next.diff; }
  return copy;
}

function presented(request) {
  const url = new URL(request.url);
  return {
    secret: request.headers.get('x-nd-secret') || url.searchParams.get('secret') || '',
    key: request.headers.get('x-nd-key') || url.searchParams.get('key') || '',
    role: url.searchParams.get('role') || ''
  };
}

export class NeuralDanceDebugRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.secrets = null;
    this.telemetry = null;
    this.ring = [];
    this.pending = null;
    this.commands = [];
    this.patchSeq = 0;
    this.updatedAt = null;
    this.camera = null;
    this.stage = null;
    this.scanBefore = null;
    this.scanAfter = null;
    this.scanDiff = null;
    this.scanStillId = null;
    this.scanOwner = '';
    this.publisher = null;
    this.publisherId = '';
    this.viewers = new Set();
    this.studio = false;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nd_debug (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      const state = readJson(ctx.storage.sql, 'state');
      if (state) {
        this.secrets = state.secrets || null;
        this.telemetry = state.telemetry || null;
        this.ring = Array.isArray(state.ring) ? state.ring.slice(-DEBUG_RING) : [];
        this.pending = state.pending || null;
        this.commands = Array.isArray(state.commands) ? state.commands.slice(-8) : [];
        this.patchSeq = state.patchSeq || 0;
        this.updatedAt = state.updatedAt || null;
        this.camera = state.camera || null;
        this.stage = state.stage || null;
        this.reloadPending = state.reloadPending === true;
        this.studio = state.studio === true;
        this.publisherId = validPublisherId(state.publisherId) ? state.publisherId : '';
      }
      this.scanBefore = readJson(ctx.storage.sql, 'scan:before');
      this.scanAfter = readJson(ctx.storage.sql, 'scan:after');
      this.scanDiff = readJson(ctx.storage.sql, 'scan:diff');
      this.scanStillId = readJson(ctx.storage.sql, 'scan:id');
      this.scanOwner = readJson(ctx.storage.sql, 'scan:owner') || '';
      const queued = readJson(ctx.storage.sql, 'commands');
      if (queued && Array.isArray(queued.commands)) {
        this.commands = queued.commands.slice(-8);
        if (queued.patchSeq) this.patchSeq = queued.patchSeq;
      } else if ((!this.commands || !this.commands.length) && this.pending && this.pending.patch) {
        this.commands = [this.pending];
      }
      this.pending = this.commands.length ? this.commands[this.commands.length - 1] : null;
      if (typeof ctx.getWebSockets === 'function') {
        for (const ws of ctx.getWebSockets()) {
          const tags = typeof ctx.getTags === 'function' ? ctx.getTags(ws) : [];
          this.attachSocket(ws, tags && tags.includes('publisher') ? 'publisher' : 'viewer', true);
        }
      }
    });
  }

  sql() {
    return this.ctx.storage.sql;
  }

  persist() {
    writeJson(this.sql(), 'state', {
      secrets: this.secrets,
      telemetry: this.telemetry,
      ring: this.ring,
      pending: this.pending,
      commands: this.commands || [],
      patchSeq: this.patchSeq || 0,
      updatedAt: this.updatedAt,
      camera: this.camera,
      stage: this.stage,
      reloadPending: this.reloadPending === true,
      studio: this.studio === true,
      publisherId: validPublisherId(this.publisherId) ? this.publisherId : ''
    });
    this.saveCommands();
  }

  // Commands only. A full persist() also writes the camera JPEG, which is
  // what made a button wait behind the last frame.
  saveCommands() {
    writeJson(this.sql(), 'commands', {patchSeq: this.patchSeq || 0, commands: this.commands || []});
  }

  claimPublisher(ws, requested) {
    const id = validPublisherId(requested) ? requested : (ws && validPublisherId(ws.__ndPub) ? ws.__ndPub : newPublisherId());
    const previous = this.publisher;
    if (previous && previous !== ws) {
      // A reconnect from the same phone used to look like a second device:
      // the old socket was told it was displaced, and button commands kept
      // landing on that dead socket.
      const same = !!(id && (previous.__ndPub === id || this.publisherId === id));
      if (!same) this.send(previous, {type: 'displaced', displaced: true, publisherId: id, error: 'Another device took over the debug feed'});
      try { previous.close(4000, same ? 'reclaim' : 'replaced'); } catch { /* already gone */ }
    }
    if (ws) {
      ws.__ndRole = 'publisher';
      ws.__ndPub = id;
    }
    this.publisher = ws || this.publisher;
    this.publisherId = id;
    this.adoptPublisher(id);
    this.persist();
    return id;
  }

  clearScanStills() {
    this.scanBefore = null;
    this.scanAfter = null;
    this.scanDiff = null;
    this.scanStillId = null;
    const sql = this.sql();
    writeJson(sql, 'scan:before', null);
    writeJson(sql, 'scan:after', null);
    writeJson(sql, 'scan:diff', null);
    writeJson(sql, 'scan:id', null);
  }

  // A different phone must not keep the previous session's JPEGs. The same
  // publisher id (a reconnect) keeps the stills the viewer is looking at.
  adoptPublisher(id) {
    if (!validPublisherId(id)) return;
    const owned = validPublisherId(this.scanOwner) ? this.scanOwner : '';
    if (owned && owned !== id) this.clearScanStills();
    if (this.scanOwner !== id) {
      this.scanOwner = id;
      writeJson(this.sql(), 'scan:owner', id);
    }
  }

  publisherSocketLive() {
    const ws = this.publisher;
    if (!ws) return false;
    if (ws.readyState === 2 || ws.readyState === 3) return false;
    return true;
  }

  allowsPublisher(id, ws) {
    // A persisted publisherId with no live socket must not lock out the phone
    // after a reload or deploy: HTTP frames would 409 and the client would
    // give up before its new WebSocket could claim the room.
    if (!this.publisherSocketLive()) {
      if (id) {
        this.publisherId = id;
        if (ws) ws.__ndPub = id;
        this.adoptPublisher(id);
        this.persist();
      } else if (this.publisherId) {
        this.publisherId = '';
        this.persist();
      }
      return true;
    }
    if (ws && this.publisher && ws !== this.publisher) return false;
    if (id && this.publisherId && id !== this.publisherId) return false;
    if (!id && ws && this.publisher === ws) return true;
    if (!id && !ws && this.publisherId) return false;
    if (id && !this.publisherId) {
      this.publisherId = id;
      if (ws) ws.__ndPub = id;
      this.persist();
    }
    return true;
  }

  async touch() {
    if (this.ctx.storage && typeof this.ctx.storage.setAlarm === 'function') {
      await this.ctx.storage.setAlarm(Date.now() + DEBUG_IDLE_MS);
    }
  }

  expectedStudioKey() {
    // Worker secret. Never written to storage and never shipped to the client.
    const value = this.env && this.env.ND_DEBUG_KEY;
    return typeof value === 'string' ? value : '';
  }

  authStudio(request) {
    const expected = this.expectedStudioKey();
    if (!expected) return {ok: false};
    const {secret, key, role} = presented(request);
    const token = key || secret || '';
    if (!token || !sameSecret(token, expected)) return {ok: false};
    if (role === 'publisher') return {ok: true, role: 'publisher'};
    if (role === 'viewer' || role === '') return {ok: true, role: 'viewer'};
    return {ok: false};
  }

  roomName() {
    if (this.studio) return STUDIO_ROOM;
    return this.secrets ? this.secrets.room : '';
  }

  auth(request) {
    if (!this.secrets) return {ok: false};
    const {secret, key, role} = presented(request);
    const publisher = !!(secret && sameSecret(secret, this.secrets.publisherSecret));
    const viewer = !!(key && sameSecret(key, this.secrets.viewerKey));
    if (role === 'publisher') return publisher ? {ok: true, role: 'publisher'} : {ok: false};
    if (role === 'viewer') return viewer ? {ok: true, role: 'viewer'} : {ok: false};
    if (publisher && !viewer) return {ok: true, role: 'publisher'};
    if (viewer && !publisher) return {ok: true, role: 'viewer'};
    return {ok: false};
  }

  attachSocket(ws, role, restoring = false) {
    if (!ws) return;
    ws.__ndRole = role;
    if (role === 'publisher') {
      if (restoring) {
        this.publisher = ws;
        if (this.publisherId) ws.__ndPub = this.publisherId;
        return;
      }
      this.claimPublisher(ws, ws.__ndPub || '');
      return;
    }
    this.viewers.add(ws);
    if (!restoring) this.noteViewers();
  }

  detach(ws) {
    if (this.publisher === ws) {
      this.publisher = null;
      this.publisherId = '';
      this.persist();
    }
    const was = this.viewers.delete(ws);
    if (was) this.noteViewers();
  }

  // Tell the phone whether anyone is watching, so the 10 Hz audio feed only
  // runs while a debug viewer is connected.
  noteViewers() {
    if (this.publisher) this.send(this.publisher, {type: 'viewers', count: this.viewers.size});
  }

  // Compact audio-only batch (TJ 7:13 PM): relayed straight to viewers, never
  // stored, so it costs no DO storage writes.
  relayAudio(body) {
    const samples = Array.isArray(body.samples) ? body.samples.slice(0, 20) : null;
    if (!samples || !samples.length || !this.viewers.size) return false;
    let text;
    try { text = JSON.stringify({type: 'audio', samples}); } catch { return false; }
    if (text.length > 8000) return false;
    for (const ws of this.viewers) {
      if (ws.readyState != null && ws.readyState !== 1) continue;
      try { ws.send(text); } catch { /* closed */ }
    }
    return true;
  }

  buffered(ws) {
    if (!ws) return 0;
    if (typeof ws.getBufferedAmount === 'function') {
      const n = +ws.getBufferedAmount();
      return Number.isFinite(n) ? n : 0;
    }
    const n = +ws.bufferedAmount;
    return Number.isFinite(n) ? n : 0;
  }

  // Drop the write when the peer is still reading. The next frame replaces
  // it. Queueing every JPEG is what stalled the socket and the DO.
  sendRaw(ws, text, force) {
    if (!ws || !text) return false;
    if (ws.readyState != null && ws.readyState !== 1) return false;
    // Frames are large and replaceable. Commands, pings, and acks are not.
    if (!force && shouldDropDebugSend(this.buffered(ws), DEBUG_WS_BUFFER_MAX)) return false;
    try { ws.send(text); return true; } catch { return false; }
  }

  send(ws, message) {
    if (!ws) return false;
    let text;
    try { text = typeof message === 'string' ? message : JSON.stringify(message); } catch { return false; }
    return this.sendRaw(ws, text, true);
  }

  finishUpgrade(client) {
    return new Response(null, {status: 101, webSocket: client});
  }

  openSocket(role, request) {
    if (typeof WebSocketPair !== 'function') return json({error: 'WebSocket unavailable'}, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const requested = request ? (new URL(request.url).searchParams.get('pub') || '') : '';
    if (role === 'publisher' && validPublisherId(requested)) server.__ndPub = requested;
    if (typeof this.ctx.acceptWebSocket === 'function') this.ctx.acceptWebSocket(server, [role]);
    this.attachSocket(server, role);
    const reload = role === 'publisher' && this.reloadPending === true;
    if (reload) {
      this.reloadPending = false;
      this.persist();
    }
    this.send(server, {
      type: 'hello',
      role,
      room: this.roomName(),
      publisherId: role === 'publisher' ? this.publisherId : '',
      viewers: role === 'publisher' ? this.viewers.size : undefined,
      pendingPatch: role === 'publisher' ? this.pending : null,
      commands: role === 'publisher' ? (this.commands || []) : undefined,
      reload
    });
    return this.finishUpgrade(client);
  }

  async claim(request) {
    if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405);
    let body;
    try { body = await request.json(); } catch { return forbid(); }
    const room = new URL(request.url).searchParams.get('room') || '';
    if (!ROOM_RE.test(room) || !body || body.room !== room) return forbid();
    if (!validSecret(body.publisherSecret) || !validSecret(body.viewerKey)) return forbid();
    if (body.publisherSecret === body.viewerKey) return forbid();
    if (this.secrets) {
      const same = sameSecret(body.publisherSecret, this.secrets.publisherSecret) && sameSecret(body.viewerKey, this.secrets.viewerKey);
      if (!same) return forbid();
      await this.touch();
      return json({ok: true, created: false});
    }
    this.secrets = {room, publisherSecret: body.publisherSecret, viewerKey: body.viewerKey, createdAt: Date.now()};
    this.persist();
    await this.touch();
    return json({ok: true, created: true});
  }

  acceptFrame(body) {
    if (!body || typeof body !== 'object') return false;
    const telemetry = body.telemetry == null ? null : cleanTelemetry(body.telemetry);
    if (body.telemetry != null && !telemetry) return false;
    const camera = body.cameraJpeg == null ? null : normalizeJpeg(body.cameraJpeg);
    if (body.cameraJpeg != null && !camera) return false;
    const stage = body.stageJpeg == null ? null : normalizeJpeg(body.stageJpeg);
    if (body.stageJpeg != null && !stage) return false;
    if (camera) this.camera = camera;
    if (stage) this.stage = stage;
    if (telemetry) {
      this.telemetry = telemetry;
      this.ring.push(stripScanThumbs(telemetry));
      if (this.ring.length > DEBUG_RING) this.ring = this.ring.slice(-DEBUG_RING);
    }
    this.updatedAt = Date.now();
    if (body.patchResult === 'applied' || body.patchResult === 'dismissed' || body.type === 'patch_result') {
      const status = body.patchResult || body.status;
      if (status === 'applied' || status === 'dismissed') this.pending = null;
    }
    this.persist();
    this.sendViewersFrame();
    return true;
  }

  sendViewersFrame() {
    const message = {
      type: 'frame',
      telemetry: this.telemetry,
      cameraJpeg: this.camera ? 'data:image/jpeg;base64,' + this.camera : null,
      stageJpeg: this.stage ? 'data:image/jpeg;base64,' + this.stage : null,
      pendingPatch: this.pending,
      updatedAt: this.updatedAt
    };
    let text;
    try { text = JSON.stringify(message); } catch { return; }
    for (const ws of this.viewers) this.sendRaw(ws, text);
  }

  async frame(request, auth) {
    if (request.method !== 'POST' || auth.role !== 'publisher') return forbid();
    let body;
    try { body = await request.json(); } catch { return forbid(); }
    const id = (body && (body.publisherId || body.pub)) || new URL(request.url).searchParams.get('pub') || '';
    if (!this.allowsPublisher(validPublisherId(id) ? id : '', null)) {
      return json({ok: false, displaced: true, error: 'Another device took over the debug feed'}, 409);
    }
    if (!this.acceptFrame(body)) return json({error: 'Bad frame'}, 400);
    const reload = this.reloadPending === true;
    if (reload) {
      this.reloadPending = false;
      this.persist();
    }
    return json({ok: true, pendingPatch: this.pending, commands: this.commands || [], reload, updatedAt: this.updatedAt});
  }

  snapshot(auth) {
    if (auth.role !== 'viewer') return forbid();
    const room = this.roomName();
    return json({
      ok: true,
      room,
      updatedAt: this.updatedAt,
      telemetry: this.telemetry,
      pendingPatch: this.pending,
      ring: this.ring,
      camera: '/api/neural-dance/debug/camera.jpg?room=' + encodeURIComponent(room),
      stage: '/api/neural-dance/debug/stage.jpg?room=' + encodeURIComponent(room),
      lastScan: {
        before: '/api/neural-dance/debug/last-scan/before.jpg?room=' + encodeURIComponent(room),
        after: '/api/neural-dance/debug/last-scan/after.jpg?room=' + encodeURIComponent(room),
        diff: '/api/neural-dance/debug/last-scan/diff.jpg?room=' + encodeURIComponent(room),
        scanId: this.scanStillId || null
      }
    });
  }

  image(auth, which, request) {
    if (auth.role !== 'viewer') return forbid();
    const b64 = which === 'camera' ? this.camera
      : which === 'stage' ? this.stage
      : which === 'before' ? this.scanBefore
      : which === 'after' ? this.scanAfter
      : which === 'diff' ? this.scanDiff
      : null;
    if (which === 'before' || which === 'after' || which === 'diff') {
      let want = '';
      try { want = request ? (new URL(request.url).searchParams.get('scan') || '') : ''; } catch { want = ''; }
      if (want && String(this.scanStillId == null ? '' : this.scanStillId) !== String(want)) {
        return json({error: 'No frame yet'}, 404);
      }
    }
    if (!b64) return json({error: 'No frame yet'}, 404);
    return new Response(base64ToBytes(b64), {status: 200, headers: {'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store'}});
  }

  async lastScan(request, auth) {
    if (request.method !== 'POST' || auth.role !== 'publisher') return forbid();
    let body;
    try { body = await request.json(); } catch { return json({error: 'Bad scan'}, 400); }
    const before = body && body.before != null ? normalizeJpeg(body.before, SCAN_JPEG_MAX) : null;
    const after = body && body.after != null ? normalizeJpeg(body.after, SCAN_JPEG_MAX) : null;
    const diff = body && body.diff != null ? normalizeJpeg(body.diff, SCAN_JPEG_MAX) : null;
    if (body && body.before != null && !before) return json({error: 'Bad scan'}, 400);
    if (body && body.after != null && !after) return json({error: 'Bad scan'}, 400);
    if (body && body.diff != null && !diff) return json({error: 'Bad scan'}, 400);
    if (!before && !after && !diff) return json({error: 'Bad scan'}, 400);
    const owner = validPublisherId(body && (body.publisherId || body.pub)) ? (body.publisherId || body.pub) : (validPublisherId(this.publisherId) ? this.publisherId : '');
    if (owner) this.adoptPublisher(owner);
    if (before) { this.scanBefore = before; writeJson(this.sql(), 'scan:before', before); }
    if (after) { this.scanAfter = after; writeJson(this.sql(), 'scan:after', after); }
    if (diff) { this.scanDiff = diff; writeJson(this.sql(), 'scan:diff', diff); }
    const scanId = body && (body.scanId != null) ? body.scanId : Date.now();
    this.scanStillId = scanId;
    writeJson(this.sql(), 'scan:id', scanId);
    return json({ok: true, scanId});
  }

  propose(patch) {
    const clean = sanitizeDebugPatch(patch);
    if (!clean) return null;
    this.patchSeq = (this.patchSeq || 0) + 1;
    const item = {id: this.patchSeq, patch: clean, at: Date.now()};
    this.commands = [...(this.commands || []), item].slice(-8);
    this.pending = item;
    // Forward before the storage write so a button is not stuck behind the
    // JPEG snapshot. The write is the small command list, not the frames.
    this.send(this.publisher, {type: 'propose_patch', patch: clean, patchId: item.id, pendingPatch: item, commands: this.commands});
    this.saveCommands();
    return item;
  }

  forwardReload(patch) {
    const clean = patch && patch.action === 'reload' ? patch : sanitizeDebugPatch(patch || {action: 'reload'});
    if (!clean || clean.action !== 'reload') return false;
    if (this.publisher) {
      this.send(this.publisher, {type: 'reload'});
      this.reloadPending = false;
    } else {
      this.reloadPending = true;
    }
    this.persist();
    return true;
  }

  async patch(request, auth) {
    if (request.method !== 'POST' || auth.role !== 'viewer') return forbid();
    let body;
    try { body = await request.json(); } catch { return forbid(); }
    const raw = body && body.patch ? body.patch : body;
    if (raw && raw.action === 'reload') {
      if (!this.forwardReload(raw)) return json({error: 'Empty patch'}, 400);
      return json({ok: true, reload: true});
    }
    const pending = this.propose(raw);
    if (!pending) return json({error: 'Empty patch'}, 400);
    return json({ok: true, pendingPatch: pending});
  }

  clearCommand(status, id) {
    if (status !== 'applied' && status !== 'dismissed') return false;
    if (id != null && id !== '' && Number.isFinite(+id)) {
      const drop = +id;
      this.commands = (this.commands || []).filter(item => item && item.id !== drop);
    } else {
      this.commands = [];
    }
    this.pending = this.commands.length ? this.commands[this.commands.length - 1] : null;
    this.saveCommands();
    return true;
  }

  clearPending(status) {
    return this.clearCommand(status);
  }

  relayCommandAck(body) {
    const raw = body && body.ack;
    if (!raw || typeof raw !== 'object') return false;
    const ack = {
      cmd: typeof raw.cmd === 'string' ? raw.cmd.slice(0, 16) : '',
      action: typeof raw.action === 'string' ? raw.action.slice(0, 40) : '',
      text: typeof raw.text === 'string' ? raw.text.slice(0, 160) : ''
    };
    if (!ack.text && !ack.action) return false;
    let text;
    try { text = JSON.stringify({type: 'command_ack', id: body.id != null ? body.id : null, ack}); } catch { return false; }
    for (const ws of this.viewers) this.sendRaw(ws, text, true);
    return true;
  }

  async result(request, auth) {
    if (request.method !== 'POST' || auth.role !== 'publisher') return forbid();
    let body;
    try { body = await request.json(); } catch { return forbid(); }
    if (!this.clearCommand(body && (body.status || body.patchResult), body && body.id)) return json({error: 'Empty patch'}, 400);
    return json({ok: true, pendingPatch: null});
  }

  // ---- live dance-move requests (crowd show). Own tables: the idle alarm
  // never clears them, so the queue settings and the move library persist.
  liveTables() {
    const sql = this.sql();
    sql.exec('CREATE TABLE IF NOT EXISTS nd_live (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS nd_moves (id TEXT PRIMARY KEY, at INTEGER NOT NULL, move TEXT NOT NULL)');
    return sql;
  }
  loadQueue() {
    const rows = this.liveTables().exec("SELECT v FROM nd_live WHERE k = 'queue'").toArray();
    let raw = null;
    try { raw = rows.length ? JSON.parse(rows[0].v) : null; } catch { raw = null; }
    return normalizeQueueState(raw);
  }
  saveQueue(st) { this.liveTables().exec("INSERT OR REPLACE INTO nd_live (k, v) VALUES ('queue', ?)", JSON.stringify(st)); }
  library() {
    return this.liveTables().exec('SELECT move FROM nd_moves ORDER BY at ASC LIMIT 200').toArray().map(r => { try { return JSON.parse(r.move); } catch { return null; } }).filter(Boolean);
  }

  async requests(request, auth) {
    const st = this.loadQueue();
    const now = Date.now();
    const out = extra => json({ok: true, ...extra, queue: publicQueue(st, now), library: this.library(), x: xStatus(this.env)});
    // GET only reports; claiming the next debut is an explicit POST.
    if (request.method === 'GET') return out({});
    if (request.method !== 'POST') return forbid();
    let body;
    try { body = await request.json(); } catch { return json({error: 'Bad request'}, 400); }
    const op = body && typeof body.op === 'string' ? body.op : '';
    let res;
    if (auth.role === 'viewer') {
      if (op === 'submit') res = submitRequest(st, {source: 'remote', handle: body.handle, text: body.text}, now, {trusted: true});
      else if (op === 'test-submit') res = submitRequest(st, {source: 'test', handle: body.handle, text: body.text}, now);
      else if (op === 'library-remove') {
        const id = typeof body.id === 'string' ? body.id.slice(0, 60) : '';
        this.liveTables().exec('DELETE FROM nd_moves WHERE id = ?', id);
        res = {ok: true};
      } else res = applyQueueOp(st, op, body, now);
    } else if (auth.role === 'publisher') {
      if (op === 'build') res = {ok: true, recorded: recordBuild(st, body.build, now)};
      else if (op === 'landed') { st.announce = []; res = {ok: true}; }
      else if (op === 'claim') {
        await pollX(st, this.env, now).catch(() => null);
        const item = claimNext(st, now);
        res = {ok: true, item};
      } else if (op === 'finish') {
        const move = normalizeMove(body.move);
        res = finishRequest(st, body.id, now, move ? move.id : '');
        if (res.ok && move) this.liveTables().exec('INSERT OR REPLACE INTO nd_moves (id, at, move) VALUES (?, ?, ?)', move.id, now, JSON.stringify(move));
        if (res.ok) res.reply = await replyX(st, res.item, move, this.env).catch(() => ({sent: false}));
      } else res = {ok: false, reason: 'unknown op'};
    } else return forbid();
    this.saveQueue(st);
    return out({result: res});
  }

  captureTable() {
    const sql = this.sql();
    sql.exec('CREATE TABLE IF NOT EXISTS nd_captures (name TEXT PRIMARY KEY, at INTEGER NOT NULL, jpeg TEXT NOT NULL, meta TEXT)');
    return sql;
  }

  async saveCapture(request, auth) {
    if (request.method !== 'POST' || auth.role !== 'publisher') return forbid();
    let body;
    try { body = await request.json(); } catch { return json({error: 'Bad capture'}, 400); }
    const jpeg = normalizeJpeg(body && body.jpeg, CAPTURE_JPEG_MAX);
    if (!jpeg) return json({error: 'Bad capture'}, 400);
    const at = Number.isFinite(+body.takenAt) && +body.takenAt > 1.7e12 && +body.takenAt < Date.now() + 864e5 ? Math.floor(+body.takenAt) : Date.now();
    let name = captureName(at);
    const meta = {};
    for (const k of ['width', 'height', 'whiteMs', 'trigger', 'showClock']) if (body && body.meta && (typeof body.meta[k] === 'number' || typeof body.meta[k] === 'string')) meta[k] = typeof body.meta[k] === 'string' ? body.meta[k].slice(0, 40) : body.meta[k];
    const sql = this.captureTable();
    if (sql.exec('SELECT name FROM nd_captures WHERE name = ?', name).toArray().length) name = name.replace(/\.jpg$/, '-' + (at % 1000) + '.jpg');
    sql.exec('INSERT OR REPLACE INTO nd_captures (name, at, jpeg, meta) VALUES (?, ?, ?, ?)', name, at, jpeg, JSON.stringify(meta));
    const count = sql.exec('SELECT COUNT(*) AS n FROM nd_captures').toArray()[0].n;
    if (count > CAPTURE_KEEP) sql.exec('DELETE FROM nd_captures WHERE name IN (SELECT name FROM nd_captures ORDER BY at ASC LIMIT ?)', count - CAPTURE_KEEP);
    return json({ok: true, name, at, count: Math.min(count, CAPTURE_KEEP)});
  }

  // Light status for the crowd remote: just the crowd block, no JPEGs.
  crowdStatus(auth) {
    if (auth.role !== 'viewer') return forbid();
    const t = this.telemetry;
    return json({ok: true, updatedAt: this.updatedAt, publisher: !!this.publisher, crowd: t && t.crowd ? t.crowd : null, pendingCommands: (this.commands || []).length});
  }

  listCaptures(auth) {
    if (auth.role !== 'viewer') return forbid();
    const sql = this.captureTable();
    const rows = sql.exec('SELECT name, at, length(jpeg) AS b64, meta FROM nd_captures ORDER BY at DESC LIMIT 60').toArray();
    const count = sql.exec('SELECT COUNT(*) AS n FROM nd_captures').toArray()[0].n;
    return json({count, captures: rows.map(r => ({name: r.name, at: r.at, bytes: Math.floor(r.b64 * 3 / 4), meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })()}))});
  }

  captureImage(auth, request) {
    if (auth.role !== 'viewer') return forbid();
    const name = new URL(request.url).searchParams.get('name') || '';
    const sql = this.captureTable();
    const rows = name && /^nd-white-[0-9A-Za-z_-]+\.jpg$/.test(name)
      ? sql.exec('SELECT jpeg FROM nd_captures WHERE name = ?', name).toArray()
      : sql.exec('SELECT jpeg FROM nd_captures ORDER BY at DESC LIMIT 1').toArray();
    if (!rows.length) return json({error: 'No capture yet'}, 404);
    return new Response(base64ToBytes(rows[0].jpeg), {status: 200, headers: {'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store'}});
  }

  async fetchStudio(request, action) {
    if (!action || action === 'claim') return forbid();
    const auth = this.authStudio(request);
    if (!auth.ok) return forbid();
    if (!this.studio) {
      this.studio = true;
      this.persist();
    }
    await this.touch();
    if (action === 'ws') return this.openSocket(auth.role, request);
    if (action === 'frame') return this.frame(request, auth);
    if (action === 'snapshot') return this.snapshot(auth);
    if (action === 'camera') return this.image(auth, 'camera');
    if (action === 'stage') return this.image(auth, 'stage');
    if (action === 'scan-before') return this.image(auth, 'before', request);
    if (action === 'scan-after') return this.image(auth, 'after', request);
    if (action === 'scan-diff') return this.image(auth, 'diff', request);
    if (action === 'last-scan') return this.lastScan(request, auth);
    if (action === 'patch') return this.patch(request, auth);
    if (action === 'capture') return this.saveCapture(request, auth);
    if (action === 'crowd') return this.crowdStatus(auth);
    if (action === 'captures') return this.listCaptures(auth);
    if (action === 'capture-image') return this.captureImage(auth, request);
    if (action === 'requests') return this.requests(request, auth);
    if (action === 'result') return this.result(request, auth);
    return forbid();
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
    const action = upgrade ? 'ws' : debugAction(url.pathname);
    if ((url.searchParams.get('room') || '') === STUDIO_ROOM) return this.fetchStudio(request, action);
    if (action === 'claim') return this.claim(request);
    if (!action) return forbid();
    const auth = this.auth(request);
    if (!auth.ok) return forbid();
    await this.touch();
    if (action === 'ws') return this.openSocket(auth.role, request);
    if (action === 'frame') return this.frame(request, auth);
    if (action === 'snapshot') return this.snapshot(auth);
    if (action === 'camera') return this.image(auth, 'camera');
    if (action === 'stage') return this.image(auth, 'stage');
    if (action === 'scan-before') return this.image(auth, 'before', request);
    if (action === 'scan-after') return this.image(auth, 'after', request);
    if (action === 'scan-diff') return this.image(auth, 'diff', request);
    if (action === 'last-scan') return this.lastScan(request, auth);
    if (action === 'patch') return this.patch(request, auth);
    if (action === 'capture') return this.saveCapture(request, auth);
    if (action === 'crowd') return this.crowdStatus(auth);
    if (action === 'captures') return this.listCaptures(auth);
    if (action === 'capture-image') return this.captureImage(auth, request);
    if (action === 'result') return this.result(request, auth);
    return forbid();
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (!this.studio && !this.secrets) return;
    let text = message;
    if (typeof text !== 'string') {
      try { text = new TextDecoder().decode(text); } catch { return; }
    }
    let body;
    try { body = JSON.parse(text); } catch { return; }
    if (!body || typeof body !== 'object') return;
    const role = this.roleOf(ws);
    if (role !== 'publisher' && role !== 'viewer') return;
    // Heartbeats stay off the storage path. A ping every couple of seconds
    // must not rewrite the JPEG snapshot, and a missing pong is how each
    // side notices a half-open socket (Safari sleep, a wedged DO send).
    if (body.type === 'ping') {
      const pong = {type: 'pong', t: Number(body.t) || Date.now()};
      if (role === 'publisher' && this.commands && this.commands.length) pong.commands = this.commands;
      this.send(ws, pong);
      return;
    }
    // Audio batches skip touch(): no alarm write per 500 ms message.
    if (role === 'publisher' && body.type === 'audio') {
      if (this.publisher === ws) this.relayAudio(body);
      return;
    }
    // Buttons and corner drags must not wait behind a JPEG frame's storage write.
    if (role === 'publisher' && body.type === 'patch_result') {
      this.clearCommand(body.status, body.id);
      return;
    }
    if (role === 'viewer' && (body.type === 'reload' || (body.type === 'propose_patch' && body.patch && body.patch.action === 'reload'))) {
      this.forwardReload(body.type === 'reload' ? {action: 'reload'} : body.patch);
      return;
    }
    if (role === 'viewer' && body.type === 'propose_patch') {
      this.propose(body.patch || body);
      return;
    }
    await this.touch();
    if (role === 'publisher' && (body.type === 'frame' || body.telemetry || body.cameraJpeg || body.stageJpeg)) {
      const id = validPublisherId(body.publisherId) ? body.publisherId : (validPublisherId(ws.__ndPub) ? ws.__ndPub : '');
      if (!this.allowsPublisher(id, ws)) {
        this.send(ws, {type: 'displaced', displaced: true, publisherId: this.publisherId, error: 'Another device took over the debug feed'});
        return;
      }
      this.acceptFrame(body);
    }
  }

  roleOf(ws) {
    if (ws && (ws.__ndRole === 'publisher' || ws.__ndRole === 'viewer')) return ws.__ndRole;
    if (ws && this.ctx && typeof this.ctx.getTags === 'function') {
      const tags = this.ctx.getTags(ws) || [];
      if (tags.includes('publisher')) return 'publisher';
      if (tags.includes('viewer')) return 'viewer';
    }
    return '';
  }

  async webSocketClose(ws) {
    await this.ready;
    this.detach(ws);
  }

  async webSocketError(ws) {
    await this.ready;
    this.detach(ws);
  }

  async alarm() {
    await this.ready;
    this.sql().exec('DELETE FROM nd_debug');
    this.secrets = null;
    this.studio = false;
    this.telemetry = null;
    this.ring = [];
    this.pending = null;
    this.updatedAt = null;
    this.camera = null;
    this.stage = null;
    this.scanBefore = null;
    this.scanAfter = null;
    this.scanDiff = null;
    this.scanStillId = null;
    this.scanOwner = '';
    const sockets = typeof this.ctx.getWebSockets === 'function' ? this.ctx.getWebSockets() : [this.publisher, ...this.viewers].filter(Boolean);
    for (const ws of sockets) {
      try { ws.close(4000, 'idle'); } catch { /* already closed */ }
    }
    this.publisher = null;
    this.publisherId = '';
    this.viewers.clear();
  }
}

export async function handleNeuralDanceDebug(request, env) {
  const url = new URL(request.url);
  const room = url.searchParams.get('room') || '';
  if (room !== STUDIO_ROOM && !ROOM_RE.test(room)) return forbid();
  const namespace = env && env.NEURAL_DANCE_DEBUG;
  if (!namespace || typeof namespace.getByName !== 'function') return json({error: 'Live debug is temporarily unavailable.'}, 503);
  const stub = namespace.getByName(room);
  return stub.fetch(request);
}
