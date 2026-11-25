// Subtle independent head looks for the Neural Dance side simulation.
// Yaw is relative to the shoulders; calmer at rest, eased, phrase- and beat-tied.

import {clamp, hash01} from './geometry.js';

export const HEAD_YAW_MAX = 30 * Math.PI / 180;
export const HEAD_YAW_REST = 7 * Math.PI / 180;
export const HEAD_TILT_MAX = 8 * Math.PI / 180;
export const HEAD_PITCH_MAX = 8 * Math.PI / 180;

export function headLook({tSec = 0, activation = 0, hush = 1, bpm = 112, seed = 0} = {}) {
  const h = clamp(+hush || 0, 0, 1);
  if (h <= 1e-6) return { yaw: 0, tilt: 0, pitch: 0, yawAmp: 0 };
  const a = clamp(+activation || 0, 0, 1);
  const t = +tSec || 0;
  const period = 60 / Math.max(40, +bpm || 112);
  const restAmp = HEAD_YAW_REST * (0.35 + 0.65 * a);
  const danceAmp = (HEAD_YAW_MAX - HEAD_YAW_REST) * clamp((a - 0.12) / 0.55, 0, 1);
  const yawAmp = (restAmp + danceAmp) * h;
  const tiltAmp = HEAD_TILT_MAX * (0.20 + 0.80 * a) * h;
  const pitchAmp = HEAD_PITCH_MAX * (0.18 + 0.82 * a) * h;
  const ph = (hash01((+seed || 0) + 1.17) - 0.5) * Math.PI * 2;
  // Slow phrase drift + a calmer beat-tied glance. Frequencies stay low so
  // a 50 ms step cannot whip the head.
  const yaw = yawAmp * (
    0.58 * Math.sin(t * 2 * Math.PI * 0.11 + ph) +
    0.27 * Math.sin(t * 2 * Math.PI * 0.19 + ph * 1.7) +
    0.15 * Math.sin(t * 2 * Math.PI / (period * 4) + ph * 0.4)
  );
  const tilt = tiltAmp * (
    0.65 * Math.sin(t * 2 * Math.PI * 0.09 + ph * 2.1) +
    0.35 * Math.sin(t * 2 * Math.PI * 0.17 + ph * 0.6)
  );
  const pitch = pitchAmp * (
    0.70 * Math.sin(t * 2 * Math.PI * 0.08 + ph * 1.3) +
    0.30 * Math.sin(t * 2 * Math.PI / (period * 8) + ph)
  );
  return {
    yaw: clamp(yaw, -HEAD_YAW_MAX, HEAD_YAW_MAX),
    tilt: clamp(tilt, -HEAD_TILT_MAX, HEAD_TILT_MAX),
    pitch: clamp(pitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX),
    yawAmp,
  };
}

const api = { HEAD_YAW_MAX, HEAD_YAW_REST, HEAD_TILT_MAX, HEAD_PITCH_MAX, headLook };
export default api;
if (typeof globalThis !== 'undefined') globalThis.NDHeadLook = api;
