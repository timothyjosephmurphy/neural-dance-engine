// Forward-only limb IK for Neural Dance.
// The knee (or elbow) bends toward a pole / forward vector — the direction
// the foot (toes) or palm faces — never backward past straight.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, +v || 0)); }

/** Unit forward from a heel→toe (or shoulder heading). Y is ignored so a
 *  planted foot still points along the floor. */
export function footForward(heel, toe, heading) {
  if (heel && toe) {
    const x = toe.x - heel.x, z = (toe.z || 0) - (heel.z || 0);
    const d = Math.hypot(x, z);
    if (d > 1e-6) return { x: x / d, y: 0, z: z / d };
  }
  const yaw = heading || 0;
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
}

/**
 * Two-bone IK in 3D. The mid-joint (knee / elbow) is displaced in the plane
 * perpendicular to A→C, along the component of `forward` in that plane.
 * `h` is always ≥ 0 along that pole, so the joint cannot flip past straight.
 * Optional `limits` ({min, max}) cap the hip–ankle span (live uses a 7° soft
 * micro-bend so the knee is never locked straight).
 */
export function ikJointForward(A, C, lenAB, lenBC, forward, limits) {
  const ax = A.x, ay = A.y, az = A.z || 0;
  const cx = C.x, cy = C.y, cz = C.z || 0;
  const dx = cx - ax, dy = cy - ay, dz = cz - az;
  const d = Math.hypot(dx, dy, dz) || 1e-6;
  const maxD = limits && limits.max != null ? +limits.max : lenAB + lenBC - 0.004;
  const minD = limits && limits.min != null ? +limits.min : Math.abs(lenAB - lenBC) + 0.004;
  const span = Math.max(minD, Math.min(maxD, d));
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const a = (lenAB * lenAB - lenBC * lenBC + span * span) / (2 * span);
  const h = Math.sqrt(Math.max(0, lenAB * lenAB - a * a));
  let fx = (forward && forward.x) || 0;
  let fy = (forward && forward.y) || 0;
  let fz = (forward && forward.z);
  if (fz == null) fz = 1;
  const dot = fx * ux + fy * uy + fz * uz;
  let px = fx - dot * ux, py = fy - dot * uy, pz = fz - dot * uz;
  let plen = Math.hypot(px, py, pz);
  if (plen < 1e-6) {
    px = fx; py = 0; pz = fz;
    const d2 = px * ux + pz * uz;
    px -= d2 * ux; pz -= d2 * uz;
    plen = Math.hypot(px, py, pz);
  }
  if (plen < 1e-6) {
    px = -uy; py = ux; pz = 0;
    plen = Math.hypot(px, py, pz) || 1e-6;
  }
  px /= plen; py /= plen; pz /= plen;
  return {
    x: ax + ux * a + px * h,
    y: ay + uy * a + py * h,
    z: az + uz * a + pz * h,
  };
}

/** Signed projection of the mid-joint off the A–C line onto `forward`.
 *  Positive = bent toward the toes / palm; negative = hyperextended backward. */
export function jointForwardOffset(A, mid, C, forward) {
  if (!A || !mid || !C) return 0;
  const dx = C.x - A.x, dy = C.y - A.y, dz = (C.z || 0) - (A.z || 0);
  const d = Math.hypot(dx, dy, dz) || 1e-9;
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const vx = mid.x - A.x, vy = mid.y - A.y, vz = (mid.z || 0) - (A.z || 0);
  const t = vx * ux + vy * uy + vz * uz;
  const ox = vx - t * ux, oy = vy - t * uy, oz = vz - t * uz;
  let fx = (forward && forward.x) || 0;
  let fy = (forward && forward.y) || 0;
  let fz = (forward && forward.z);
  if (fz == null) fz = 1;
  const fdot = fx * ux + fy * uy + fz * uz;
  fx -= fdot * ux; fy -= fdot * uy; fz -= fdot * uz;
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-8) return 0;
  return (ox * fx + oy * fy + oz * fz) / fl;
}

export function jointIsForward(A, mid, C, forward, tol) {
  const off = jointForwardOffset(A, mid, C, forward);
  const min = tol == null ? -1e-4 : +tol;
  return off >= min;
}

const api = { clamp, footForward, ikJointForward, jointForwardOffset, jointIsForward };
export default api;
if (typeof globalThis !== 'undefined') globalThis.NDLegIk = api;
