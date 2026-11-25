// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// X intake and auto-reply for live dance-move requests. Both are behind
// their own remote flags (default OFF) AND need Worker secrets:
//   X_BEARER_TOKEN       app-only token with recent-search access (read)
//   X_USER_ACCESS_TOKEN  OAuth 2.0 user-context token for @TJ_de_la_playa
//                        with tweet.write (+ media.write for clips)
// Without a secret the code path reports what is missing and does nothing.
// The studio Durable Object calls pollX() at most once a minute while the
// projector is polling the queue (no cron needed).

import {X_HANDLE, X_TAGS, parseXRecent, submitRequest, xReplyPayload, xSearchQuery} from '../neural-dance/src/crowd-requests.js';

export const X_POLL_MS = 60000;
export const X_API = 'https://api.x.com/2';

export function xStatus(env) {
  return {read: !!(env && env.X_BEARER_TOKEN), write: !!(env && env.X_USER_ACCESS_TOKEN)};
}

export async function pollX(st, env, now = Date.now(), fetchImpl = fetch) {
  if (!st.settings.xIntake) return {ran: false, reason: 'off'};
  if (!env || !env.X_BEARER_TOKEN) { st.xNote = 'X intake is on, but the Worker has no X_BEARER_TOKEN secret'; return {ran: false, reason: 'no credentials'}; }
  if (now - (st.xLastPollAt || 0) < X_POLL_MS) return {ran: false, reason: 'wait'};
  st.xLastPollAt = now;
  const q = new URLSearchParams({query: xSearchQuery(X_HANDLE, X_TAGS), max_results: '25', 'tweet.fields': 'created_at,author_id', expansions: 'author_id', 'user.fields': 'username'});
  if (st.xSinceId) q.set('since_id', st.xSinceId);
  let json;
  try {
    const res = await fetchImpl(X_API + '/tweets/search/recent?' + q, {headers: {authorization: 'Bearer ' + env.X_BEARER_TOKEN}});
    if (!res.ok) { st.xNote = 'X search HTTP ' + res.status; return {ran: true, added: 0, status: res.status}; }
    json = await res.json();
  } catch (err) { st.xNote = 'X search failed'; return {ran: true, added: 0}; }
  const found = parseXRecent(json, X_HANDLE);
  let added = 0;
  for (const r of found) {
    const res = submitRequest(st, r, now);
    if (res.ok) added++;
  }
  if (json && json.meta && json.meta.newest_id) st.xSinceId = String(json.meta.newest_id);
  st.xNote = 'X: ' + found.length + ' seen, ' + added + ' queued at ' + new Date(now).toISOString().slice(11, 16) + ' UTC';
  return {ran: true, added, seen: found.length};
}

// Reply on X once a debut has played. Text reply; a clip needs media upload
// with the same user token (media.write), left for when the token exists.
export async function replyX(st, item, move, env, fetchImpl = fetch) {
  if (!item || item.source !== 'x' || !item.xId) return {sent: false, reason: 'not an X request'};
  if (!st.settings.xReply) return {sent: false, reason: 'off'};
  if (!env || !env.X_USER_ACCESS_TOKEN) { st.xNote = 'X replies are on, but the Worker has no X_USER_ACCESS_TOKEN secret'; return {sent: false, reason: 'no credentials'}; }
  try {
    const res = await fetchImpl(X_API + '/tweets', {method: 'POST', headers: {authorization: 'Bearer ' + env.X_USER_ACCESS_TOKEN, 'content-type': 'application/json'}, body: JSON.stringify(xReplyPayload(item, move))});
    return {sent: res.ok, status: res.status};
  } catch { return {sent: false, reason: 'network'}; }
}
