// Vehicle parameters for a lifted Defender 110 style 4x4.
// Vehicle-local frame: +x right, +y up, -z forward. y = 0 is the ground at static ride height,
// z = 0 is the middle of the wheelbase.

export const PSI = 6894.76;

export function makeDefenderParams() {
  const wheelbase = 2.794;
  const track = 1.56;
  return {
    name: 'Defender 110 V8',
    bodyMass: 1880,                       // sprung mass incl. roof rack, winch, spare
    bodyInertia: [3300, 3700, 950],       // principal inertia about COM: pitch (x), yaw (y), roll (z)
    com: [0, 0.96, 0.08],                 // centre of mass (local)
    aero: { cdA: 2.15, rho: 1.2 },
    wheelbase,
    track,

    // Solid beam axles on coil springs (front: radius arms + panhard, rear: trailing links + A-frame).
    // y values are the axle centre height (local) at full droop; c is compression measured at the springs.
    axles: [
      {
        name: 'front', z: -wheelbase / 2, droopY: 0.275, travel: 0.24,
        mass: 185, rollInertia: 75,
        springTrack: 1.0, k: 43000, preload: 0.0,
        bump: 2700, rebound: 4300, arb: 11000,
        steered: true,
      },
      {
        name: 'rear', z: wheelbase / 2, droopY: 0.27, travel: 0.25,
        mass: 175, rollInertia: 72,
        springTrack: 1.04, k: 47000, preload: 0.0,
        bump: 2800, rebound: 4500, arb: 4000,
        steered: false,
      },
    ],

    tire: {
      radius: 0.42,            // 33x10.5R16 mud terrain
      width: 0.27,
      rimRadius: 0.205,
      inertia: 3.3,            // wheel + tyre + hub + half shaft
      pressure: 20,            // psi (default, adjustable in game)
      minPressure: 6, maxPressure: 38,
      damping: 650,            // radial damping N*s/m
      relaxX: 0.22,            // longitudinal relaxation length (m) at reference pressure
      relaxY: 0.55,            // lateral relaxation length (m)
    },

    steer: { maxAngle: 0.62, kingpinTrack: 1.38, ratio: 17 },

    brakes: { front: 2700, rear: 1350, handbrake: 3200 }, // max torque per wheel (handbrake: at rear axle)

    engine: {
      name: '4.6 V8',
      idleRpm: 720, limiterRpm: 5350, redlineRpm: 5000, stallRpm: 280,
      inertia: 0.22,
      // gross torque (Nm) at full throttle; friction and pumping losses are subtracted separately
      torque: [[0, 0], [400, 150], [800, 300], [1200, 365], [1600, 405], [2000, 435], [2500, 455], [3000, 462],
               [3500, 458], [4000, 445], [4500, 420], [5000, 385], [5500, 330], [6000, 250], [6500, 120]],
      starterTorque: 95,
    },

    clutch: { capacity: 680, inputInertia: 0.035 },

    manual: {   // R380 style 5 speed
      ratios: [3.585, 2.301, 1.507, 1.0, 0.83],
      reverse: 3.70,
    },
    auto: {     // ZF 6HP style 6 speed + torque converter
      ratios: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69],
      reverse: 3.40,
      stallK: 112,               // converter capacity factor at stall (rpm / sqrt(Nm))
      turbineInertia: 0.06,
      lockupCapacity: 750,
      shiftTime: 0.38,
      shiftCapacity: 900,
    },
    transfer: { high: 1.211, low: 3.32 },
    finalDrive: 3.54,

    // chassis collision boxes: [cx, cy, cz, hx, hy, hz, rounding]
    colliders: [
      [0, 1.30, 0.78, 0.89, 0.66, 1.62, 0.06],    // cabin / rear body
      [0, 0.985, -1.42, 0.87, 0.395, 0.70, 0.06], // engine bay / bonnet (bottom unchanged, top 1.38 = raised bonnet centre)
      [0, 0.62, -2.21, 0.96, 0.16, 0.13, 0.03],   // front bumper
      [0, 0.66, 2.44, 0.93, 0.14, 0.09, 0.03],    // rear bumper
      [0, 0.52, 0.05, 0.42, 0.09, 2.15, 0.03],    // chassis rails
      [0, 2.20, 0.70, 0.84, 0.13, 1.58, 0.03],    // roof rack (top 2.33)
      [0, 1.18, 2.62, 0.36, 0.38, 0.15, 0.06],    // spare wheel
    ],
  };
}
