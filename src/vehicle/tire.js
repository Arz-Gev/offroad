// Tyre model: radial spring + transient "bristle" deflection feeding a Pacejka-style combined-slip curve.
//
// The contact patch carries two deflection states (ux, uy, metres). They follow the standard
// relaxation-length equation  du/dt = v_slip - |vx| / L * u, so at speed u/L becomes the classic slip ratio
// / slip angle, and at standstill the patch behaves like a stiff spring that can hold the truck on a slope.
// The deflection is clamped by the steady-state slip, which stops wind-up when a wheel spins in place.

export const SURFACES = {
  dirt:     { name: 'Dirt',     mu: 0.72, crr: 0.026, kPeak: 0.15, aPeak: 0.16, C: 1.35, soft: 0.5, dust: 1.0, color: [0.54, 0.40, 0.26] },
  grass:    { name: 'Grass',    mu: 0.58, crr: 0.034, kPeak: 0.14, aPeak: 0.15, C: 1.40, soft: 0.4, dust: 0.25, color: [0.36, 0.40, 0.24] },
  rock:     { name: 'Rock',     mu: 0.98, crr: 0.013, kPeak: 0.11, aPeak: 0.13, C: 1.55, soft: 0.0, dust: 0.15, color: [0.5, 0.5, 0.5] },
  mud:      { name: 'Mud',      mu: 0.42, crr: 0.10,  kPeak: 0.30, aPeak: 0.22, C: 1.05, soft: 1.0, dust: 0.0, mud: 1, color: [0.25, 0.18, 0.11] },
  sand:     { name: 'Sand',     mu: 0.62, crr: 0.085, kPeak: 0.24, aPeak: 0.20, C: 1.15, soft: 1.0, dust: 1.2, color: [0.75, 0.66, 0.48] },
  wood:     { name: 'Wood',     mu: 0.68, crr: 0.012, kPeak: 0.10, aPeak: 0.13, C: 1.50, soft: 0.0, dust: 0.0, color: [0.4, 0.3, 0.2] },
  concrete: { name: 'Concrete', mu: 0.98, crr: 0.011, kPeak: 0.10, aPeak: 0.12, C: 1.60, soft: 0.0, dust: 0.2, color: [0.6, 0.6, 0.58] },
};
for (const s of Object.values(SURFACES)) s.B = Math.tan(Math.PI / (2 * s.C)); // peak of sin(C atan(B s)) at s = 1

const FN_REF = 5200;

// The ray fan of a wheel (Vehicle.castContact) and the tyre shader (tireMaterial.js) share these: 13 rays
// from 80° behind to 80° ahead of straight down, in 3 rows across the tread at -0.34, 0, +0.34 x width.
export const TIRE_FAN = [];
for (let i = -6; i <= 6; i++) TIRE_FAN.push((i / 6) * (80 * Math.PI / 180));
export const TIRE_ROWS = [-1, 0, 1];
export const TIRE_ROW_OFFSET = 0.34;
export const TIRE_SUB = 6;   // samples of the ground between two neighbouring rays (tyre v2 patch integral)
export const TIRE_BELT = 1.0; // the tread band's stiffness as a spread of the load (Vehicle.integrateTyre)

// Lateral load sensitivity: a real tyre's cornering stiffness grows slower than its load (~Fz^0.6-0.7), so
// the slip angle at the force peak grows with load. That makes lateral load transfer cost grip: the axle
// taking more of it slides first. A constant peak slip angle gave a nearly neutral truck whatever its split.
const LAT_LOAD_EXP = 0.35;
// ref: the tyre's nominal load (P.tire.fnRef; the 33" tyre's 5.2 kN by default): load sensitivity is relative to it
export const latPeak = (surf, Fn, ref = FN_REF) => surf.aPeak * Math.pow(Math.max(0.25, Math.min(2.5, Fn / ref)), LAT_LOAD_EXP);

// Nominal tyre size (inches) -> metres, calibrated on the 33x10.5 mud tyre (R 0.42, width 0.27); every car's
// tyre goes through these. The radial stiffness below (N/m vs psi) is set on it too; P.tire.kScale scales it.
export const tyreRadius = inches => 0.42 * inches / 33;
export const tyreWidth = inches => 0.27 * inches / 10.5;

export function tireRadialStiffness(psi, kScale = 1) {
  return (46000 + 6300 * psi) * kScale;
}

// Radial damping (N·s/m): rubber and cords losing energy as the carcass flexes (the air is a lossless spring).
// Real tyres damp more at lower pressure and several times more standing or creeping than rolling (falls over
// the first few km/h, flat above ~15 km/h). P.tire.damping is the rolling tyre at 20 psi; kScale scales it
// (damping grows with stiffness). treadSpeed: the tread's speed round the hub (m/s).
export function tireRadialDamping(tire, psi, treadSpeed) {
  const pressure = Math.pow(20 / Math.max(psi, 4), 0.6);           // 10 psi x1.52, 32 psi x0.75
  const rolling = 1 + 2 * Math.exp(-Math.abs(treadSpeed) / 1.5);   // standing x3, 5 km/h x2.6, 15 km/h x1.1
  return (tire.damping ?? 650) * (tire.kScale ?? 1) * pressure * rolling;
}

export function tireCoefs(tire, psi, surf, out) {
  const low = Math.max(0, Math.min(1, (30 - psi) / 24)); // 0 at 30 psi, 1 at 6 psi
  // aired-down tyres grip better on loose / soft ground and on rock (they wrap around it)
  const gripGain = 1 + low * (0.10 + 0.14 * surf.soft) + (surf === SURFACES.rock ? low * 0.08 : 0);
  out.mu = surf.mu * gripGain * (tire.grip ?? 1);
  // rolling resistance: soft ground prefers low pressure (float), hard ground prefers high pressure
  const hard = 1 - surf.soft;
  out.crr = surf.crr * (hard * Math.sqrt(28 / Math.max(psi, 4)) + surf.soft * Math.pow(Math.max(psi, 4) / 28, 0.6));
  out.Lx = tire.relaxX * (1 + 0.6 * low);
  out.Ly = tire.relaxY * (1 + 0.7 * low);
  out.kt = tireRadialStiffness(psi, tire.kScale ?? 1);
  out.fnRef = tire.fnRef ?? FN_REF;
  return out;
}

// w: wheel state with ux, uy. Writes w.Fx, w.Fy, w.slipNorm.
export function tireForces(w, Fn, vsx, vsy, speed, surf, co) {
  if (Fn <= 0) { w.Fx = 0; w.Fy = 0; w.slipNorm = 0; return; }
  const loadFactor = Math.max(0.75, Math.min(1.12, 1 - 0.14 * (Fn / co.fnRef - 1)));
  const mu = co.mu * loadFactor;
  const sx = w.ux / (co.Lx * surf.kPeak);
  w.aPk = latPeak(surf, Fn, co.fnRef);
  const sy = w.uy / (co.Ly * w.aPk);
  const s = Math.hypot(sx, sy);
  let Fx = 0, Fy = 0;
  if (s > 1e-9) {
    const F = mu * Fn * Math.sin(surf.C * Math.atan(surf.B * s));
    Fx = F * sx / s;
    Fy = 0.95 * F * sy / s;
  }
  // low-speed damping of the contact patch (kills stick-slip oscillation when parked or crawling)
  const fade = Math.max(0, 1 - speed / 2.5);
  if (fade > 0 && s < 1) {
    const c = 2.6 * Fn * fade;
    Fx += c * vsx;
    Fy += c * vsy;
  }
  const lim = mu * Fn;
  const m = Math.hypot(Fx, Fy);
  if (m > lim) { Fx *= lim / m; Fy *= lim / m; }
  w.Fx = Fx; w.Fy = Fy;
  w.slipNorm = s;
}

export function tireRelax(w, h, vsx, vsy, avx, surf, co) {
  w.ux = (w.ux + h * vsx) / (1 + h * avx / co.Lx);
  w.uy = (w.uy + h * vsy) / (1 + h * avx / co.Ly);
  const sx = w.ux / (co.Lx * surf.kPeak);
  const aPk = w.aPk || surf.aPeak;  // set by tireForces this substep (load dependent)
  const sy = w.uy / (co.Ly * aPk);
  const s = Math.hypot(sx, sy);
  const vref = Math.max(avx, 0.6);
  const ss = Math.hypot((vsx / vref) / surf.kPeak, (vsy / vref) / aPk);
  const smax = Math.max(1, ss);
  if (s > smax) { const k = smax / s; w.ux *= k; w.uy *= k; }
  w.slipSteady = ss;
}
