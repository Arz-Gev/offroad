import { makeDefenderParams } from './params.js';
import { tireRadialStiffness } from './tire.js';
import { axleShares } from './suspension.js';

// Physics of each drivable car: the Defender's params with the car's own numbers (real specs where they
// exist). The 4x4s keep solid axles on coil springs; a car with axleZ lists its own axles (any number, each
// with its own suspension type, steering and drive). Same tyre and drivetrain code for every car.
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
    // character: heavy, torquey, flat (stiffer bars than the Defender), quicker modern steering. Long travel
    // and 20 psi for the trails: its real road travel and 26 psi bounced off the bump stops above 60
    tire: { size: 31.5, widthIn: 11, rimRadius: 0.254, inertia: 3.0, pressure: 20 },
    axles: [
      { k: 47000, bump: 4100, rebound: 6500, arb: 13000, travel: 0.24, springTrack: 1.05, damperTrack: 1.30 },
      { k: 51000, bump: 4300, rebound: 6800, arb: 4500, travel: 0.25, springTrack: 1.08, damperTrack: 1.30 },
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
    // character: a gravel rally car: light, very quick steering, grippy rally tyres, a rear bar that helps it
    // turn in. Soft, long travel and 6 cm higher than the road car (road springs and 17 cm of travel scraped
    // and crashed over the trail bumps above 60)
    raise: 0.06,
    tire: { size: 23.5, widthIn: 9.5, rimRadius: 0.203, inertia: 1.0, pressure: 22, grip: 1.12 },
    axles: [
      { k: 30000, bump: 2300, rebound: 3700, arb: 6000, travel: 0.22, springTrack: 0.92, damperTrack: 1.10 },
      { k: 22000, bump: 1700, rebound: 2700, arb: 5000, travel: 0.22, springTrack: 0.92, damperTrack: 1.10 },
    ],
    steer: { maxAngle: 0.56, ratio: 12, kingpinTrack: 1.27 },
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
  btr80: {
    // BTR-80 (GAZ-5903), 8x8 armoured personnel carrier: 13.6 t combat weight, KamAZ-7403 260 PS / 785 Nm,
    // 5-speed manual + 2-speed transfer with a lockable centre diff (axles 1 + 3 on one output, 2 + 4 on the
    // other), cam-type high-friction axle diffs, wheel reductions (main gear 1.846 x 3.34 = 6.166), double
    // wishbones on torsion bars, two shock absorbers on each wheel of axles 1 and 4, one on axles 2 and 3,
    // front two axles steer, 13.00-18 tyres with central inflation (0.5-3.0 kgf/cm²), 80 km/h.
    // Axle positions, track and tyre are the model's (scale 0.82, assets-src/btr80/README.md): track 2.31
    // (real 2.41), axles at 1.34 / 1.76 / 1.34 (real 1.35 / 1.70 / 1.35), tyre R 0.572 (real 0.56).
    name: 'BTR-80', engine: 'kamaz', engines: ['kamaz', 'yamz'], manualOnly: true,
    wheelbase: 4.44, track: 2.313, axleZ: [-2.22, -0.88, 0.88, 2.22],
    // sprung 11.8 t + 4 x 460 kg unsprung (two wheels with hubs, wheel reductions, drums, knuckles, half arms)
    bodyMass: 11800, axleMass: [460, 460, 460, 460], inertia: [60000, 66000, 13500], com: [0, 1.12, 0.10], cdA: 6.0,
    // tyre: 45" (13.00-18 is 1120 mm; the model's is 1143) x 15.5" (the model's tread width). kScale: the
    // 33" tyre's stiffness curve x 1.7 (wider, bigger: ~3 cm static deflection at 2.5 kgf/cm², ~11 at 0.5)
    tire: { size: 45, widthIn: 15.5, rimRadius: 0.2286, inertia: 25, pressure: 36, minPressure: 7, maxPressure: 43, kScale: 1.7, hubDrag: 9, hubDragV: 4.5, fnRef: 16000 },
    // torsion bars as wheel rates: 1.15 Hz heave with the tyre in series, zeta ~0.25 (twice the damping on
    // the axles with two shocks); 0.32 m of wheel travel from full droop, bump rubbers 5 cm before the stop
    axles: [
      { type: 'independent', k: 90000, bump: 6000, rebound: 11000, steered: true, group: 0 },
      { type: 'independent', k: 90000, bump: 3000, rebound: 5500, steered: true, group: 1 },
      { type: 'independent', k: 90000, bump: 3000, rebound: 5500, group: 0 },
      { type: 'independent', k: 90000, bump: 6000, rebound: 11000, group: 1 },
    ],
    axleCommon: { arb: 0, travel: 0.32, rcHeight: 0.15, camberGain: -0.2, diff: 'lsd', diffLock: 0.35, stopScale: 3, damperKnee: 0.25, damperHigh: 0.5 },
    // Ackermann about a point between axles 3 and 4: axle 2 turns ~0.64 x axle 1. Turning radius 13 m.
    steer: { maxAngle: 0.33, ratio: 22, kingpinTrack: 2.0, centreZ: 1.55, rate: 0.42, casterTrail: 0.03, pneuTrail: 0.05, stiffness: 250000 },
    // drums on every wheel; the parking brake is a drum on the transfer case output (all wheels)
    brakes: { front: 6500, rear: 5500, handbrake: 30000, handbrakeHold: 80000 },
    drive: { rwd: [], handbrake: [0, 1, 2, 3] },
    gearbox: { manual: [7.82, 4.03, 2.50, 1.53, 1.00], manualRev: 7.38, auto: [7.82, 4.03, 2.50, 1.53, 1.00, 1.00], autoRev: 7.38,
      final: 6.166, high: 1.0, low: 1.982 },
    clutch: { capacity: 1250, inputInertia: 0.15 },
    // 24 V starter on a 17:1 diesel: slow, heavy cranking; a diesel flares little
    start: { starterTorque: 1500, starterRpm: 190, compressionTorque: 900, startFlare: 350, catchMin: 0.6, catchSpread: 0.3, fireRamp: 0.35, stallRpm: 250 },
    // BPU-1 turret: hand-driven traverse (360°) and elevation -4° to +60°. No published drive speeds: a gunner
    // cranking the hand wheels at ~2-3 turns/s gives ~12°/s traverse and ~8°/s elevation (estimates).
    // KPVT 14.5 mm: B-32 / BZT, 64 g at 1000 m/s, ~770 m/s left at 1000 m (k = ln(1000/770)/1000), 600 rpm,
    // 500 rounds in 10 belts of 50; PKT 7.62 mm coaxial: LPS 9.6 g at 825 m/s, ~560 m/s at 500 m, 750 rpm,
    // 2000 rounds in belts of 250. Recoil impulse: bullet + powder gases. Every round is drawn as a tracer (a game choice: real belts load one in four or five).
    turret: {
      yawRate: 12 * Math.PI / 180, pitchRate: 8 * Math.PI / 180, yawAccel: 1.0, pitchAccel: 0.8,
      pitchMin: -4 * Math.PI / 180, pitchMax: 60 * Math.PI / 180,
      weapons: [
        { id: 'kpvt', name: 'KPVT 14.5 mm', short: 'KPVT', v0: 1000, mass: 0.064, k: 2.6e-4, rpm: 600, belt: 50, ammo: 500, reload: 8,
          tracerEvery: 1, recoil: 110, recoilTravel: 0.035, spread: 0.0010, muzzle: 'muzzle', flash: 0.9, calibre: 14.5 },
        { id: 'pkt', name: 'PKT 7.62 mm', short: 'PKT', v0: 825, mass: 0.0096, k: 7.7e-4, rpm: 750, belt: 250, ammo: 2000, reload: 6,
          tracerEvery: 1, recoil: 12, spread: 0.0015, muzzle: 'pktMuzzle', flash: 0.45, calibre: 7.62 },
      ],
    },
    // collision boxes in the hub frame (y = 0 at the hub at static ride), measured off the hull (prepcar outline)
    colliderFrame: 'hub',
    colliders: [
      ['Upper hull', [0, 0.97, 0.25, 1.36, 0.35, 3.2, 0.06]],         // over the wheels: hub +0.62 to the roof +1.32, nose plate to the tail
      ['Lower hull', [0, 0.215, 0.2, 0.88, 0.285, 3.1, 0.05]],        // between the wheels: belly 7 cm below the hubs
      ['Nose', [0, 0.675, -3.375, 1.0, 0.225, 0.475, 0.05]],          // upper glacis tip to 3.85 ahead of the middle
      ['Lower glacis', [0, 0.30, -3.075, 0.85, 0.2, 0.225, 0.04]],
      ['Turret', [-0.02, 1.60, -1.02, 0.62, 0.32, 0.66, 0.1]],
      ['Tail', [0, 0.76, 3.5, 1.1, 0.26, 0.1, 0.03]],
    ],
  },
};

const R_PER_INCH = 0.42 / 33;            // tuning.js: 33" = 0.42 m (the Defender's calibration)
const W_PER_INCH = 0.27 / 10.5;

export function makeCarParams(id = current) {
  const P = makeDefenderParams();
  const c = CAR_SPECS[id];
  if (!c) return P;
  if (c.axleZ) return makeAxlesParams(P, id, c);
  P.name = c.name; P.car = id;
  P.engine.preset = c.engine;
  P.wheelbase = c.wheelbase; P.track = c.track;
  P.bodyMass = c.bodyMass; P.bodyInertia = [...c.inertia]; P.com = [...c.com];
  P.aero.cdA = c.cdA;
  Object.assign(P.tire, { radius: c.tire.size * R_PER_INCH, width: c.tire.widthIn * W_PER_INCH, size: c.tire.size, widthIn: c.tire.widthIn,
    rimRadius: c.tire.rimRadius, inertia: c.tire.inertia, pressure: c.tire.pressure, grip: c.tire.grip ?? 1 });
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
    a.droopY = P.tire.radius - squash - compression - (c.raise || 0);   // raise: the body sits higher on longer springs
  });
  return P;
}

// a car that lists its own axles (any number; BTR-80: four independent axles)
function makeAxlesParams(P, id, c) {
  P.name = c.name; P.car = id;
  P.engine.preset = c.engine; P.engineChoices = c.engines;
  P.manualOnly = !!c.manualOnly;
  P.wheelbase = c.wheelbase; P.track = c.track;
  P.bodyMass = c.bodyMass; P.bodyInertia = [...c.inertia]; P.com = [...c.com];
  P.aero.cdA = c.cdA;
  Object.assign(P.tire, { radius: c.tire.size * R_PER_INCH, width: c.tire.widthIn * W_PER_INCH, size: c.tire.size, widthIn: c.tire.widthIn,
    rimRadius: c.tire.rimRadius, inertia: c.tire.inertia, pressure: c.tire.pressure, grip: c.tire.grip ?? 1 });
  for (const k of ['minPressure', 'maxPressure', 'kScale', 'hubDrag', 'hubDragV', 'fnRef']) if (c.tire[k] !== undefined) P.tire[k] = c.tire[k];
  Object.assign(P.steer, c.steer);
  Object.assign(P.brakes, c.brakes);
  if (c.drive) P.drive = { ...c.drive };
  if (c.clutch) Object.assign(P.clutch, c.clutch);
  if (c.start) Object.assign(P.engine, c.start);
  if (c.turret) P.turret = c.turret;
  const g = c.gearbox;
  P.auto.ratios = [...g.auto]; P.auto.reverse = g.autoRev;
  P.manual.ratios = [...g.manual]; P.manual.reverse = g.manualRev;
  P.finalDrive = g.final; P.transfer.high = g.high; P.transfer.low = g.low;
  const base = P.axles[1];   // damper knee, preload etc. from the Defender's rear axle unless the car says
  P.axles = c.axleZ.map((z, i) => ({
    ...base, rollSteer: 0, steered: false, springTrack: c.track, damperTrack: c.track,
    ...c.axleCommon, ...c.axles[i], name: String(i + 1), z, mass: c.axleMass[i],
  }));
  // static ride: ground at y 0 with the body level. Each axle's droop height comes from its share of the
  // weight (rigid body on equal springs, suspension.js); an independent axle's kinematic curves are
  // referenced to that static compression.
  const shares = axleShares(P), mt = P.axles.reduce((s, a) => s + a.mass, c.bodyMass);
  P.axles.forEach((a, i) => {
    const compression = c.bodyMass * G * shares[i] / 2 / a.k - (a.preload || 0);
    const squash = mt * G * shares[i] / 2 / tireRadialStiffness(c.tire.pressure, P.tire.kScale ?? 1);
    a.droopY = P.tire.radius - squash - compression - (c.raise || 0);
    if (a.type === 'independent') a.kinC0 = compression;
  });
  const hubY = P.tire.radius - P.axles.reduce((s, a, i) => s + mt * G * shares[i] / 2 / tireRadialStiffness(c.tire.pressure, P.tire.kScale ?? 1), 0) / P.axles.length;
  P.staticHubY = hubY;
  P.colliders = c.colliders.map(x => { const b = [...x[1]]; if (c.colliderFrame === 'hub') b[1] += hubY; return b; });
  P.colliderNames = c.colliders.map(x => x[0]);
  return P;
}
