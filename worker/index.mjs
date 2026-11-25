// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

import { handleNeuralDanceDebug, NEURAL_DANCE_DEBUG_API } from './neural-dance-debug.mjs';
import { handleSimParams, isSimParamsPath, isSimPreviewPage, stampSimPreviewPage } from './neural-dance-sim-params.mjs';

export { NeuralDanceDebugRoom } from './neural-dance-debug.mjs';
export { NeuralDanceSimParams } from './neural-dance-sim-params.mjs';

const PRIVATE = { 'Cache-Control': 'no-store' };
export const VERSION_PATH = '/neural-dance/version.json';

export function isVersionPath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  return path === VERSION_PATH;
}

// HTML and JS for the show must not sit in the phone cache, or a reload keeps
// yesterday's page. Images and fonts keep the asset cache headers.
export function cacheControlFor(pathname, contentType) {
  const path = String(pathname || '');
  const type = String(contentType || '');
  const bare = path.replace(/\/+$/, '') || '/';
  const page = bare === '/neural-dance' || bare === '/neural-dance/live' || bare === '/neural-dance/debug' || bare === '/neural-dance/sim';
  const code = /\.(?:js|mjs|html)$/.test(bare) || type.includes('javascript') || type.includes('text/html');
  if (page || code) return 'no-store, no-cache, must-revalidate';
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(NEURAL_DANCE_DEBUG_API)) {
      if (!env.NEURAL_DANCE_DEBUG) {
        return Response.json({ error: 'Live debug is temporarily unavailable.' }, { status: 503, headers: PRIVATE });
      }
      return handleNeuralDanceDebug(request, env);
    }
    // Sim preview only. The live Worker has no SIM_PARAMS binding, so this
    // 404s if a request reaches it. the live Worker config does not list the path.
    if (isSimParamsPath(url.pathname)) {
      if (!env || !env.SIM_PARAMS) return new Response('Not found', { status: 404, headers: PRIVATE });
      return handleSimParams(request, env);
    }
    if (isSimPreviewPage(url.pathname) && env && env.SIM_PARAMS) return stampSimPreviewPage(request, env);
    if (!env.ASSETS) return new Response('Neural Dance assets are not configured.', { status: 500, headers: PRIVATE });
    if (isVersionPath(url.pathname)) {
      const asset = await env.ASSETS.fetch(new Request(new URL(VERSION_PATH, url.origin), request));
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Pragma', 'no-cache');
      return new Response(asset.body, {status: asset.status, headers});
    }
    const asset = await env.ASSETS.fetch(request);
    const cache = cacheControlFor(url.pathname, asset.headers.get('content-type'));
    if (!cache) return asset;
    const headers = new Headers(asset.headers);
    headers.set('Cache-Control', cache);
    headers.set('Pragma', 'no-cache');
    return new Response(asset.body, {status: asset.status, headers});
  }
};
