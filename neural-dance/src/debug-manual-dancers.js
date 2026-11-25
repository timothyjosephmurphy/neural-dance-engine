// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Manual dancers on the debug camera feed, phone first (TJ Nov 11 4:31 PM;
// debug screen = iPhone 16 Pro, 402x874 CSS px). A tap places a dancer, a
// drag moves one, and removal is only through the selected dancer's X or a
// long-press, each with a confirm. Nothing here talks to the network: the
// viewer turns the intents into patches.

import {applyHomography, solveHomography} from '../camera-markers.js';
import {cameraTapToStage} from './training-taps.js';

export const DANCER_TARGET_PX = 44;   // Apple HIG minimum touch target
export const DRAG_SLOP_PX = 8;
export const LONG_PRESS_MS = 600;

const STAGE = [{x: 0, y: 0}, {x: 1000, y: 0}, {x: 1000, y: 620}, {x: 0, y: 620}];

// Stage px -> camera-normalised (inverse of cameraTapToStage).
export function stageToCamera(x, y, quad) {
  if (!Number.isFinite(+x) || !Number.isFinite(+y) || !Array.isArray(quad) || quad.length !== 4) return null;
  const H = solveHomography(STAGE, quad.map(p => ({x: +p.x, y: +p.y})));
  if (!H) return null;
  const at = applyHomography(H, +x, +y);
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? {x: at.x, y: at.y} : null;
}

// Client (CSS px) -> camera-normalised, using the canvas's on-screen box, so
// it stays right under phone scaling, zoom and either orientation.
export function clientToCamera(clientX, clientY, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return {x, y};
}

export function manualMarkers(markers) {
  return (Array.isArray(markers) ? markers : []).filter(m => m && m.manual === true && Number.isFinite(+m.x) && Number.isFinite(+m.y));
}

// Nearest manual dancer within half a touch target (CSS px) of the touch.
export function hitManualDancer(markers, spot, quad, rect, targetPx = DANCER_TARGET_PX) {
  if (!spot || !rect) return null;
  let best = null, bestD = targetPx / 2 + 4;
  for (const m of manualMarkers(markers)) {
    const c = stageToCamera(m.x, m.y, quad);
    if (!c) continue;
    const d = Math.hypot((c.x - spot.x) * rect.width, (c.y - spot.y) * rect.height);
    if (d <= bestD) { best = {id: m.id | 0, x: +m.x, y: +m.y, camera: c}; bestD = d; }
  }
  return best;
}

// Corner handle hit, also in CSS px (was 12% of the feed: most taps near a
// corner turned into an invisible quad commit instead of a dancer).
export function hitCorner(handles, spot, rect, targetPx = DANCER_TARGET_PX) {
  if (!spot || !rect || !Array.isArray(handles)) return -1;
  let hit = -1, bestD = targetPx / 2 + 4;
  handles.forEach((c, i) => {
    const d = Math.hypot((c.x - spot.x) * rect.width, (c.y - spot.y) * rect.height);
    if (d <= bestD) { hit = i; bestD = d; }
  });
  return hit;
}

// One pointer gesture -> one intent. target: {kind:'dancer', dancer} |
// {kind:'corner', index} | {kind:'empty'}.
export function createDancerGesture({slopPx = DRAG_SLOP_PX, longPressMs = LONG_PRESS_MS} = {}) {
  let g = null;
  return {
    down(client, target, now) { g = {start: client, last: client, target, at: now, moved: false}; return g; },
    move(client) {
      if (!g) return null;
      g.last = client;
      if (!g.moved && Math.hypot(client.x - g.start.x, client.y - g.start.y) > slopPx) g.moved = true;
      if (!g.moved) return null;
      if (g.target.kind === 'dancer') return {type: 'drag-dancer', dancer: g.target.dancer};
      if (g.target.kind === 'corner') return {type: 'drag-corner', index: g.target.index, frame: g.target.frame === true};
      return null; // a slide over empty feed is a scroll, not a dancer
    },
    up(client, now) {
      if (!g) return null;
      const s = g; g = null;
      if (client && !s.moved && Math.hypot(client.x - s.start.x, client.y - s.start.y) > slopPx) s.moved = true;
      const long = !s.moved && now - s.at >= longPressMs;
      if (s.target.kind === 'dancer') {
        if (s.moved) return {type: 'move-dancer', dancer: s.target.dancer};
        return long ? {type: 'ask-remove', dancer: s.target.dancer} : {type: 'select', dancer: s.target.dancer};
      }
      if (s.target.kind === 'corner') return s.moved ? {type: 'commit-corner', index: s.target.index, frame: s.target.frame === true} : {type: 'place'};
      return s.moved ? null : {type: 'place'};
    },
    cancel() { g = null; },
    active() { return !!g; }
  };
}

let nonceSeq = 0;
export function dancerNonce(now = Date.now()) {
  nonceSeq = (nonceSeq + 1) % 1e6;
  return 'm' + (now % 1e9).toString(36) + '-' + nonceSeq.toString(36);
}

// Pending edits waiting for the phone's ack (telemetry.manualAck.nonce).
export function createAckTracker({timeoutMs = 5000} = {}) {
  let pending = [];
  return {
    add(entry) { pending.push({...entry}); return entry; },
    list() { return pending.slice(); },
    // Returns {acked:[...], late:[...]} and drops acked / expired entries.
    update(telemetry, now) {
      const ack = telemetry && telemetry.manualAck;
      const acked = [], late = [];
      pending = pending.filter(p => {
        if (ack && ack.nonce && ack.nonce === p.nonce) { acked.push({...p, ok: ack.ok !== false, id: ack.id | 0}); return false; }
        if (now - p.at > timeoutMs) { late.push(p); return false; }
        return true;
      });
      return {acked, late};
    }
  };
}

export {cameraTapToStage};
