// Geometry shared by the physics (Vehicle.js), the tuning readouts (tuning.js), the car params (carParams.js)
// and the view: how the sprung weight splits over N axles, Ackermann steering about one turning centre,
// and the kinematic curves of an independent (double wishbone) corner.

// Share of the sprung weight on each axle. Two axles: the lever rule. More axles are statically
// indeterminate; this is the split of a rigid body on equal springs (carParams sets each axle's droop
// height from it, so the body sits level at this split whatever the spring rates).
export function axleShares(P) {
  const A = P.axles, n = A.length;
  if (n === 2) { const L = P.wheelbase, f = (L / 2 - P.com[2]) / L; return [f, 1 - f]; }
  const zm = A.reduce((s, a) => s + a.z, 0) / n;
  const Szz = A.reduce((s, a) => s + (a.z - zm) ** 2, 0);
  return A.map(a => 1 / n + (P.com[2] - zm) * (a.z - zm) / Szz);
}

// Wheel / corner names: FL FR RL RR on two axles, 1L 1R 2L 2R ... from the front on more. Wheel i is
// axle i >> 1, left (even) or right (odd); the model files name their wheel nodes the same way.
export const wheelName = (i, nA) => nA === 2 ? ['FL', 'FR', 'RL', 'RR'][i] : `${(i >> 1) + 1}${i % 2 ? 'R' : 'L'}`;
export const cornerName = (a, side, nA) => wheelName(2 * a + (side > 0 ? 1 : 0), nA);

// Ackermann steering. Every steered wheel turns about one point on the line z = steer.centreZ (body
// frame); without centreZ that is the rear axle of a 4x4 and the reference length is the wheelbase.
// The driver's angle d is the angle of a virtual wheel on the centreline of the first steered axle.
export function steerRefLength(P) {
  const S = P.steer;
  if (S.centreZ === undefined) return P.wheelbase;
  const first = P.axles.find(a => a.steered);
  return S.centreZ - first.z;
}
// [left, right] road wheel angles of axle a for the driver's angle d (+ = right)
export function ackermann(P, a, d, L0 = steerRefLength(P)) {
  const ap = P.axles[a];
  if (!ap.steered) return [0, 0];
  const La = P.steer.centreZ === undefined ? P.wheelbase : P.steer.centreZ - ap.z;
  if (Math.abs(d) < 1e-4) { const k = d * (La / L0); return [k, k]; }
  const T = P.steer.kingpinTrack;
  const Rt = L0 / Math.tan(Math.abs(d));
  const inner = Math.atan(La / (Rt - T / 2)), outer = Math.atan(La / (Rt + T / 2));
  const s = Math.sign(d);
  // d > 0 = right turn: right wheel is the inner one
  return s > 0 ? [outer * s, inner * s] : [inner * s, outer * s];
}

// Independent corner (one DOF: compression c at the wheel, measured from full droop like a beam axle).
// Kinematic curves about the reference compression kinC0 (static ride at stock):
//   camber  gamma(c) = camberGain * (c - kinC0)          (+ = top of the wheel outward)
//   contact patch moves outward by q * (c - kinC0), q = rcHeight / (track / 2): the roll centre height
//   hub moves outward by (q + R * camberGain) * (c - kinC0)  (the contact patch is R below the hub)
// q also sets the jacking: a side force at the patch pushes on the spring by Fy * q.
export function cornerKin(P, ap, R) {
  const q = (ap.rcHeight || 0) / (P.track / 2), g = ap.camberGain || 0, c0 = ap.kinC0 || 0;
  return { q, g, c0, hubOut: q + R * g };
}
