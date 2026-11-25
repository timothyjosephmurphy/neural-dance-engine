// On-demand "Scan stickers": fade up to full white, hold until auto-exposure
// settles, grab that frame, then fade the white out before the scan runs.
// The phone used to stay white for the whole diff. Capture only during the
// full-white hold — never on the ramps.
import {frameMedianLum} from './blank-scan.js';

export const FLASH_MIN_MS = 600; // never trust the first frames after the switch
export const FLASH_MAX_MS = 1800; // give up waiting and use the last frame
export const FLASH_POLL_MS = 60;
export const FLASH_STABLE_LUM = 2.5; // median luma change that counts as settled
export const FLASH_STABLE_FRAMES = 3;
export const FLASH_FADE_MS = 120; // ramp up / ramp down, about as fast as exposure settles

function clamp01(v) {
  const n = +v;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Drive io.show with 0..1 opacity over ms. Boolean true/false still maps to 1/0.
export async function fadeFlash(io, from, to, ms = FLASH_FADE_MS) {
  const start = io.now();
  const a0 = clamp01(from);
  const a1 = clamp01(to);
  const dur = Math.max(0, Number.isFinite(+ms) ? +ms : FLASH_FADE_MS);
  if (typeof io.show === 'function') io.show(a0);
  if (!(dur > 0) || a0 === a1) {
    if (typeof io.show === 'function') io.show(a1);
    return a1;
  }
  for (;;) {
    await io.wait(Math.min(FLASH_POLL_MS, 32));
    const elapsed = io.now() - start;
    const t = Math.min(1, elapsed / dur);
    const a = a0 + (a1 - a0) * t;
    if (typeof io.show === 'function') io.show(a);
    if (t >= 1) return a1;
  }
}

// Poll frames until the median luma stops moving (auto-exposure settled).
// Caller must already be holding full white — never call this during a ramp.
export async function settleExposure({grab, wait, now, minMs = FLASH_MIN_MS, maxMs = FLASH_MAX_MS, stableLum = FLASH_STABLE_LUM, stableFrames = FLASH_STABLE_FRAMES}) {
  const start = now();
  let last = null;
  let calm = 0;
  let frame = null;
  for (;;) {
    await wait(FLASH_POLL_MS);
    const next = grab();
    const elapsed = now() - start;
    if (next && next.data) {
      frame = next;
      const lum = frameMedianLum(next.data, next.width, next.height, null);
      if (last != null && lum != null && Math.abs(lum - last) <= stableLum) calm++;
      else calm = 0;
      if (lum != null) last = lum;
      if (elapsed >= minMs && calm >= stableFrames - 1) return {frame, settleMs: Math.round(elapsed), settled: true, lum: last};
    }
    if (elapsed >= maxMs) return {frame, settleMs: Math.round(elapsed), settled: false, lum: last};
  }
}

// io: show(alpha 0..1 | boolean), grab(), wait(ms), now(), personInView(),
// alive() -> false aborts before scan() and keeps the previous book,
// beforeFadeOut(frame, extras) runs while white is still up (white balance),
// scan(frame, extras) runs after the white has faded out,
// report(state). Never leaves the white up.
export async function runStickerFlash(io) {
  const report = (state) => { if (io.report) io.report({at: io.now(), ...state}); return state; };
  if (io.personInView && io.personInView()) {
    return report({state: 'deferred', count: null, reason: 'Someone is in frame. Step out of view and press Scan stickers again.'});
  }
  if (io.alive && !io.alive()) {
    return report({state: 'aborted', count: null, reason: 'Music started. Scan cancelled; stickers unchanged.'});
  }
  const fadeMs = Number.isFinite(+io.fadeMs) ? Math.max(0, +io.fadeMs) : FLASH_FADE_MS;
  let holding = false;
  let fadedOut = false;
  let scanned = false;
  const abortErr = () => { const e = new Error('aborted-onset'); e.code = 'aborted-onset'; throw e; };
  const gated = {
    ...io,
    wait: async (ms) => {
      await io.wait(ms);
      if (io.alive && !io.alive()) abortErr();
    }
  };
  report({state: 'fading-in', count: null, reason: ''});
  // Camera warmup runs during the ramp. White starts in this turn, not after
  // ensureCamera (that wait was the late Scan stickers).
  const prep = typeof io.prepare === 'function' ? io.prepare() : null;
  try {
    await fadeFlash(gated, 0, 1, fadeMs);
    if (prep && typeof prep.then === 'function') await prep;
    holding = true;
    report({state: 'flashing', count: null, reason: ''});
    // Hold is already full white. minMs (default FLASH_MIN_MS, painting
    // captures pass ~1s) is measured from here, not from the start of the fade.
    const settle = await settleExposure({
      grab: () => gated.grab(),
      wait: (ms) => gated.wait(ms),
      now: () => gated.now(),
      minMs: Number.isFinite(+io.minMs) ? +io.minMs : FLASH_MIN_MS,
      maxMs: Number.isFinite(+io.maxMs) ? +io.maxMs : FLASH_MAX_MS
    });
    if (io.alive && !io.alive()) {
      return report({state: 'aborted', count: null, reason: 'Music started. Scan cancelled; stickers unchanged.', settleMs: settle.settleMs});
    }
    if (io.personInView && io.personInView()) {
      return report({state: 'aborted', count: null, reason: 'Someone stepped into frame during the scan. Nothing changed.', settleMs: settle.settleMs, person: true});
    }
    if (!settle.frame) return report({state: 'failed', count: null, reason: 'No camera frame.', settleMs: settle.settleMs});
    // The live person gate does not run during the white hold, so check the
    // captured white frame itself: a body blocks the projector (TJ Nov 11
    // 3:06 PM: scan ran with him still in frame). Nothing is applied.
    if (io.personInFrame && io.personInFrame(settle.frame)) {
      return report({state: 'aborted', count: null, reason: 'Someone is in frame. Waiting for the floor to clear, then scanning again.', settleMs: settle.settleMs, person: true});
    }
    // Grab only at full white (after ramp-in and the hold). The diff itself
    // runs after the fade-out so the projector is not stuck white.
    const extras = [];
    const grabs = io.extraGrabs | 0;
    for (let i = 0; i < grabs; i++) {
      await gated.wait(40);
      const next = io.grab && io.grab();
      if (next && next.data) extras.push(next);
    }
    if (typeof io.beforeFadeOut === 'function') {
      const hook = io.beforeFadeOut(settle.frame, extras);
      if (hook && typeof hook.then === 'function') await hook;
    }
    await fadeFlash(gated, 1, 0, fadeMs);
    fadedOut = true;
    holding = false;
    const result = (await io.scan(settle.frame, extras)) || {ok: false, reason: 'scan failed'};
    scanned = true;
    if (!result.ok) return report({state: 'failed', count: null, reason: result.reason || 'scan failed', settleMs: settle.settleMs, settled: settle.settled, applied: result.applied});
    return report({state: 'done', count: result.count | 0, reason: result.reason || '', settleMs: settle.settleMs, settled: settle.settled, applied: result.applied !== false});
  } catch (err) {
    if (err && err.code === 'aborted-onset' && !scanned) {
      return report({state: 'aborted', count: null, reason: 'Music started. Scan cancelled; stickers unchanged.'});
    }
    throw err;
  } finally {
    try {
      if (!fadedOut && (holding || typeof io.show === 'function')) await fadeFlash(io, 1, 0, fadeMs);
    } catch {
      if (!fadedOut && typeof io.show === 'function') io.show(0);
    }
  }
}

export function stickerScanSummary(r) {
  if (!r || !r.state) return 'Scan stickers: not run yet';
  if (r.state === 'fading-in') return 'Scan stickers: fading to white…';
  if (r.state === 'flashing') return 'Scan stickers: holding white…';
  if (r.state === 'fading-out') return 'Scan stickers: fading out…';
  if (r.state === 'done') return 'Scan stickers: ' + r.count + ' sticker' + (r.count === 1 ? '' : 's') + ' latched (exposure settled in ' + r.settleMs + ' ms' + (r.settled === false ? ', timed out' : '') + ')';
  return 'Scan stickers: ' + r.state + ' — ' + (r.reason || '');
}
