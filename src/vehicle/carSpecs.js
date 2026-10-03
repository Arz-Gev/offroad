import { makeDefenderParams } from './params.js';
import { tireRadialStiffness } from './tire.js';

// Physics of each drivable car: the Defender's params with the car's own numbers (real specs where they
// exist). Every car keeps the same model: solid axles on coil springs, the same tyre and drivetrain code.
// tuning.js builds its stock setup and ranges from the current car (useCar), so the Tab panel tunes
// each car from its own stock. Visual side (shell, wheels, cameras, lamps): cars.js.

const G = 9.81;
let current = 'defender';
export const setCar = id => { current = CAR_SPECS[id] ? id : 'defender'; };
export const getCar = () => current;

export const CAR_SPECS = {
  defender: null,   // params.js as it is
  gclass: {
    // G 500 (W463A, 2018+): 4.0 V8 biturbo, 422 PS, 610 Nm; ~2,450 kg
    name: 'G-Class G 500', engine: 'g500',
    wheelbase: 2.907, track: 1.635,
    bodyMass: 2050, axleMass: [205, 195], inertia: [4100, 5300, 1300], com: [0, 0.86, -0.03], cdA: 1.65,
    tire: { size: 31.5, widthIn: 11, rimRadius: 0.254, inertia: 3.0, pressure: 26 },
    axles: [
      { k: 46000, bump: 3900, rebound: 6200, arb: 13000, travel: 0.22, springTrack: 1.05, damperTrack: 1.30 },
      { k: 50000, bump: 4100, rebound: 6500, arb: 5000, travel: 0.24, springTrack: 1.08, damperTrack: 1.30 },
    ],
    steer: { maxAngle: 0.58, ratio: 15.5, kingpinTrack: 1.45 },
    brakes: { front: 3600, rear: 1800, handbrake: 3400 },
    gearbox: { auto: [4.70, 2.85, 1.88, 1.36, 1.00, 0.73], autoRev: 4.0, manual: [4.20, 2.50, 1.60, 1.15, 0.85], manualRev: 3.9,
      final: 3.70, high: 1.0, low: 2.93 },
    colliders: [   // [cx, cy, cz, hx, hy, hz, rounding], body frame at static ride (ground y 0), measured off the shell
      ['Cabin and rear body', [0, 1.30, 0.825, 0.90, 0.68, 1.325, 0.06]],      // sill 0.62 to roof 1.98, windscreen top to rear face 2.15
      ['Bonnet and wings', [0, 0.96, -1.325, 0.90, 0.34, 0.825, 0.06]],        // 0.62 to bonnet 1.30, bumper back to the windscreen
      ['Front bumper', [0, 0.70, -2.24, 0.80, 0.25, 0.14, 0.03]],             // 0.45-0.95, face at -2.38
      ['Rear bumper', [0, 0.585, 2.175, 0.85, 0.165, 0.125, 0.03]],           // 0.42-0.75, face 2.30
      ['Chassis rails', [0, 0.52, 0.05, 0.45, 0.10, 2.05, 0.03]],             // 0.42-0.62
      ['Spare wheel', [0, 1.19, 2.375, 0.42, 0.39, 0.175, 0.06]],             // on the rear door, to 2.55
      ['Belly', [0, 0.51, -0.625, 0.30, 0.09, 1.125, 0.04]],                  // sump, gearbox, transfer case (lowest 0.42)
    ],
  },
  lancia: {
    // Delta HF Integrale Evo 2 (1993): 2.0 16v turbo, 215 PS, 314 Nm; 1,340 kg, ~60 % on the front.
    // The real car has independent suspension and no low range; here it gets solid axles and a short "low".
    name: 'Delta HF Integrale', engine: 'lancia',
    wheelbase: 2.477, track: 1.401,
    bodyMass: 1170, axleMass: [88, 82], inertia: [1450, 1900, 450], com: [0, 0.50, -0.22], cdA: 0.68,
    tire: { size: 23.5, widthIn: 9.5, rimRadius: 0.203, inertia: 1.0, pressure: 30 },
    axles: [
      { k: 45000, bump: 2700, rebound: 4300, arb: 9000, travel: 0.17, springTrack: 0.92, damperTrack: 1.10 },
      { k: 32000, bump: 1900, rebound: 3000, arb: 5000, travel: 0.16, springTrack: 0.92, damperTrack: 1.10 },
    ],
    steer: { maxAngle: 0.56, ratio: 14, kingpinTrack: 1.27 },
    brakes: { front: 2000, rear: 1000, handbrake: 1600 },
    gearbox: { auto: [3.50, 2.20, 1.52, 1.13, 0.93, 0.78], autoRev: 3.5, manual: [3.50, 2.18, 1.52, 1.13, 0.93], manualRev: 3.55,
      final: 3.11, high: 1.0, low: 1.8, stallK: 165 },   // looser converter: the small engine would stall in D at idle
    colliders: [
      ['Cabin', [0, 0.805, 0.50, 0.79, 0.505, 0.85, 0.06]],                    // sill 0.30 to roof 1.31, windscreen top to the hatch
      ['Bonnet and wings', [0, 0.59, -1.175, 0.80, 0.29, 0.825, 0.06]],        // 0.30 to bonnet 0.88, nose to windscreen
      ['Boot', [0, 0.62, 1.625, 0.80, 0.32, 0.275, 0.05]],                     // to the tail at 1.9
      ['Front bumper', [0, 0.45, -1.92, 0.70, 0.17, 0.10, 0.03]],             // 0.28-0.62, face at -2.02
      ['Rear bumper', [0, 0.44, 1.85, 0.72, 0.16, 0.10, 0.03]],               // 0.28-0.60
      ['Floor', [0, 0.24, 0, 0.55, 0.06, 1.6, 0.03]],                          // underside 0.18
    ],
  },
};

const R_PER_INCH = 0.42 / 33;            // tuning.js: 33" = 0.42 m (the Defender's calibration)
const W_PER_INCH = 0.27 / 10.5;

export function makeCarParams(id = current) {
  const P = makeDefenderParams();
  const c = CAR_SPECS[id];
  if (!c) return P;
  P.name = c.name; P.car = id;
  P.engine.preset = c.engine;
  P.wheelbase = c.wheelbase; P.track = c.track;
  P.bodyMass = c.bodyMass; P.bodyInertia = [...c.inertia]; P.com = [...c.com];
  P.aero.cdA = c.cdA;
  Object.assign(P.tire, { radius: c.tire.size * R_PER_INCH, width: c.tire.widthIn * W_PER_INCH, size: c.tire.size, widthIn: c.tire.widthIn,
    rimRadius: c.tire.rimRadius, inertia: c.tire.inertia, pressure: c.tire.pressure });
  Object.assign(P.steer, c.steer);
  Object.assign(P.brakes, c.brakes);
  const g = c.gearbox;
  P.auto.ratios = [...g.auto]; P.auto.reverse = g.autoRev;
  P.manual.ratios = [...g.manual]; P.manual.reverse = g.manualRev;
  P.finalDrive = g.final; P.transfer.high = g.high; P.transfer.low = g.low;
  if (g.stallK) P.auto.stallK = g.stallK;
  P.colliders = c.colliders.map(x => [...x[1]]);
  P.colliderNames = c.colliders.map(x => x[0]);
  // axles at the car's wheelbase; droop height so the static ride puts the ground at y 0
  const L = c.wheelbase, mt = c.bodyMass + c.axleMass[0] + c.axleMass[1];
  P.axles.forEach((a, i) => {
    Object.assign(a, c.axles[i]);
    a.z = (i === 0 ? -1 : 1) * L / 2;
    a.mass = c.axleMass[i];
    const frac = i === 0 ? (L / 2 - c.com[2]) / L : (L / 2 + c.com[2]) / L;
    const compression = c.bodyMass * G * frac / 2 / a.k;
    const squash = mt * G * frac / 2 / tireRadialStiffness(c.tire.pressure);
    a.droopY = P.tire.radius - squash - compression;
  });
  return P;
}
