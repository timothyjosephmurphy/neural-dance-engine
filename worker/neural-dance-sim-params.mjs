// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Sim-preview tuning room. Bound only from the sim preview config (SIM_PARAMS).
// One Durable Object holds the override layer for every open /neural-dance/sim/
// tab on the preview Worker and broadcasts it. The live Worker does not bind
// this class and does not serve these routes.

import {validateSimParams} from '../neural-dance/sim-params.js';

export const SIM_PARAMS_API = '/api/neural-dance/sim/params';
export const SIM_PARAMS_WS = '/api/neural-dance/sim/params/ws';
export const SIM_PARAMS_NAME = 'preview';
const BODY_MAX = 8192;
const PRIVATE = {'Cache-Control': 'no-store'};

export function simParamsAction(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  if (path === SIM_PARAMS_API) return 'http';
  if (path === SIM_PARAMS_WS) return 'ws';
  return '';
}

export function isSimParamsPath(pathname) {
  return simParamsAction(pathname) !== '';
}

export function isSimPreviewPage(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  return path === '/neural-dance/sim' || path === '/neural-dance/sim/index.html';
}

function json(data, status = 200) {
  return Response.json(data, {status, headers: PRIVATE});
}

export function readSimParamsToken(request) {
  const header = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (bearer) return bearer[1];
  const alt = request.headers.get('x-sim-params-token');
  return typeof alt === 'string' ? alt.trim() : '';
}

// Hash both sides to a fixed length, then compare. Workers expose
// crypto.subtle.timingSafeEqual; Node's Web Crypto in this repo does not, so
// the fixed-length digest falls back to a full XOR scan. An empty expected
// secret never matches.
export async function simParamsTokenMatches(provided, expected) {
  const want = typeof expected === 'string' ? expected : '';
  if (!want) return false;
  const given = typeof provided === 'string' ? provided : '';
  const enc = new TextEncoder();
  const [leftBuf, rightBuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(want))
  ]);
  const left = new Uint8Array(leftBuf);
  const right = new Uint8Array(rightBuf);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export async function authorizeSimParamsWrite(request, env) {
  const expected = env && typeof env.SIM_PARAMS_TOKEN === 'string' ? env.SIM_PARAMS_TOKEN : '';
  if (!expected) return json({error: 'Sim params token is not configured'}, 401);
  const provided = readSimParamsToken(request);
  if (!provided) return json({error: 'Unauthorized'}, 401);
  if (!(await simParamsTokenMatches(provided, expected))) return json({error: 'Forbidden'}, 403);
  return null;
}

function readJson(sql, key) {
  const rows = sql.exec('SELECT v FROM nd_sim_params WHERE k = ?', key).toArray();
  if (!rows.length || rows[0].v == null) return null;
  try { return JSON.parse(rows[0].v); } catch { return null; }
}

function writeJson(sql, key, value) {
  sql.exec(
    'INSERT INTO nd_sim_params (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    key,
    JSON.stringify(value)
  );
}

function copyOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === 'masses' && value.masses && typeof value.masses === 'object') out.masses = {...value.masses};
    else out[key] = value[key];
  }
  return out;
}

function mergeOverrides(current, patch) {
  const next = copyOverrides(current);
  for (const key of Object.keys(patch)) {
    if (key === 'masses') next.masses = {...(next.masses || {}), ...patch.masses};
    else next[key] = patch[key];
  }
  return next;
}

export class NeuralDanceSimParams {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.overrides = {};
    this.revision = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nd_sim_params (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      const state = readJson(ctx.storage.sql, 'state');
      if (state && state.overrides && typeof state.overrides === 'object') this.overrides = copyOverrides(state.overrides);
      if (state && Number.isFinite(state.revision)) this.revision = state.revision;
    });
  }

  persist() {
    writeJson(this.ctx.storage.sql, 'state', {overrides: this.overrides, revision: this.revision});
  }

  snapshot(reset) {
    return {
      ok: true,
      live: true,
      type: 'params',
      revision: this.revision,
      overrides: copyOverrides(this.overrides),
      reset: reset === true
    };
  }

  broadcast(message) {
    const sockets = typeof this.ctx.getWebSockets === 'function' ? this.ctx.getWebSockets() : [];
    const text = JSON.stringify(message);
    for (const ws of sockets) {
      try { ws.send(text); } catch { /* a closed tab drops out on the next broadcast */ }
    }
  }

  commit(next, reset) {
    this.overrides = copyOverrides(next);
    this.revision += 1;
    this.persist();
    const message = this.snapshot(reset);
    this.broadcast(message);
    return json(message);
  }

  finishUpgrade(client) {
    return new Response(null, {status: 101, webSocket: client});
  }

  openSocket() {
    if (typeof WebSocketPair !== 'function') return json({error: 'WebSocket unavailable'}, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (typeof this.ctx.acceptWebSocket === 'function') this.ctx.acceptWebSocket(server);
    try { server.send(JSON.stringify(this.snapshot(false))); } catch { /* the subscribe still completes */ }
    return this.finishUpgrade(client);
  }

  async readBody(request) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > BODY_MAX) return {error: json({error: 'Body too large'}, 413)};
    let text = '';
    try { text = await request.text(); } catch { return {error: json({error: 'Expected a params object'}, 400)}; }
    if (text.length > BODY_MAX) return {error: json({error: 'Body too large'}, 413)};
    let body;
    try { body = JSON.parse(text); } catch { return {error: json({error: 'Expected a params object'}, 400)}; }
    const parsed = validateSimParams(body);
    if (!parsed.ok) return {error: json({error: parsed.error}, 400)};
    return {value: parsed.value};
  }

  async fetch(request) {
    await this.ready;
    const action = simParamsAction(new URL(request.url).pathname);
    if (!action) return json({error: 'Not found'}, 404);
    if (action === 'ws') {
      const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
      if (upgrade !== 'websocket') return json({error: 'Expected WebSocket'}, 426);
      return this.openSocket();
    }
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return json({error: 'WebSocket is ' + SIM_PARAMS_WS}, 426);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const body = this.snapshot(false);
      if (request.method === 'HEAD') return new Response(null, {status: 200, headers: PRIVATE});
      return json(body);
    }
    if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
      return json({error: 'Method not allowed'}, 405);
    }
    const denied = await authorizeSimParamsWrite(request, this.env);
    if (denied) return denied;
    if (request.method === 'DELETE') return this.commit({}, true);
    const parsed = await this.readBody(request);
    if (parsed.error) return parsed.error;
    if (request.method === 'PATCH') return this.commit(mergeOverrides(this.overrides, parsed.value), false);
    return this.commit(parsed.value, Object.keys(parsed.value).length === 0);
  }

  async webSocketMessage() {}

  async webSocketClose() {}

  async webSocketError() {}
}

export async function handleSimParams(request, env) {
  if (!env || !env.SIM_PARAMS || typeof env.SIM_PARAMS.getByName !== 'function') {
    return new Response('Not found', {status: 404, headers: PRIVATE});
  }
  const stub = env.SIM_PARAMS.getByName(SIM_PARAMS_NAME);
  return stub.fetch(request);
}

export async function stampSimPreviewPage(request, env) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('Neural Dance assets are not configured.', {status: 500, headers: PRIVATE});
  }
  const url = new URL(request.url);
  const asset = await env.ASSETS.fetch(new Request(new URL('/neural-dance/sim/index.html', url.origin), request));
  if (!asset.ok) return asset;
  const type = asset.headers.get('content-type') || '';
  if (!type.includes('html')) return asset;
  const html = await asset.text();
  if (html.includes('name="nd-sim-live"')) {
    const headers = new Headers(asset.headers);
    headers.delete('content-length');
    headers.set('Cache-Control', 'no-store');
    return new Response(html, {status: asset.status, headers});
  }
  const stamped = html.replace('</head>', '<meta name="nd-sim-live" content="1">\n</head>');
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.set('Cache-Control', 'no-store');
  return new Response(stamped, {status: asset.status, headers});
}
