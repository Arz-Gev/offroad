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
    // principal inertia about the COM: pitch (x), yaw (y), roll (z). The axles' mass sits in this body, so
    // yaw includes them at +-1.4 m (they swing sideways with the body); pitch and roll only their small
    // horizontal part (their vertical motion is the axle DOF).
    bodyInertia: [3400, 4400, 1040],
    // centre of mass (local): 51 % on the front axle (engine, winch and bumper ahead of it)
    com: [0, 0.90, -0.04],
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
        // dampers sit outboard, close to the wheels; digressive above the knee (m/s)
        damperTrack: 1.24, bump: 3800, rebound: 6000, damperKnee: 0.22, damperHigh: 0.55,
        // roll stiffness ~53 % front, a little over its weight share: a stable, mildly understeering truck
        arb: 11000,
        steered: true,
      },
      {
        name: 'rear', z: wheelbase / 2, droopY: 0.27, travel: 0.25,
        mass: 175, rollInertia: 72,
        springTrack: 1.04, k: 47000, preload: 0.0,
        damperTrack: 1.24, bump: 4000, rebound: 6300, damperKnee: 0.22, damperHigh: 0.55,
        arb: 4000,
        // trailing links + A-frame: the axle turns slightly into the bend as the body rolls (rad / rad)
        rollSteer: 0.06,
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

    steer: {
      maxAngle: 0.62, kingpinTrack: 1.38, ratio: 17,
      // compliance: side force x (caster trail + pneumatic trail) about the kingpins over the stiffness of
      // the steering box, drag link and track rod (N·m/rad at the road wheels, both wheels together)
      casterTrail: 0.022, pneuTrail: 0.035, stiffness: 50000,
    },

    brakes: { front: 2700, rear: 1350, handbrake: 3200, handbrakeHold: 24000 }, // max torque per wheel (handbrake: at rear axle; hold: whole transfer output at a stop)

    engine: {
      name: '4.6 V8',
      idleRpm: 720, limiterRpm: 5350, redlineRpm: 5000, stallRpm: 280,
      shiftRpm: 4800,           // automatic: upshift at full throttle (lighter throttle shifts earlier)
      inertia: 0.22,
      // gross torque (Nm) at full throttle; friction and pumping losses are subtracted separately
      torque: [[0, 0], [400, 150], [800, 300], [1200, 365], [1600, 405], [2000, 435], [2500, 455], [3000, 462],
               [3500, 458], [4000, 445], [4500, 420], [5000, 385], [5500, 330], [6000, 250], [6500, 120]],
      starterTorque: 260, starterRpm: 300,  // starter at the crank: stall torque (Nm) and no-load speed (rpm); cranks at ~200 rpm
      compressionTorque: 120, startFlare: 550, // compression strokes (Nm peak) when not firing; idle flare on start (rpm)
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

    // chassis collision boxes: [cx, cy, cz, hx, hy, hz, rounding], fitted to the visible model (truckBody.js)
    // on Oct 3: the old front bumper box sat 10 cm lower and 11 cm further forward than the bumper you see
    // (an invisible nose: approach 32° instead of 38°). Names in tuning.js (COLLIDER_NAMES), same order.
    colliders: [
      [0, 1.33, 0.745, 0.89, 0.67, 1.585, 0.06],    // cabin / rear body: sill 0.66 to roof 2.0, bulkhead to rear face 2.33
      [0, 1.00, -1.36, 0.87, 0.38, 0.64, 0.06],     // engine bay / wings: 0.62 to the raised bonnet centre 1.38, wing face -2.0
      [0, 0.6775, -2.0875, 0.985, 0.1225, 0.1375, 0.03], // winch bumper plate 0.555-0.80, face at -2.225 (D-ring shackles hang below: soft)
      [0, 0.63, 2.4025, 0.955, 0.095, 0.0925, 0.03],  // rear bumper 0.535-0.725, face 2.495
      [0, 0.54, 0.205, 0.48, 0.08, 2.145, 0.03],     // chassis rails + crossmembers 0.46-0.62, -1.94 to 2.35
      [0, 2.20, 0.70, 0.84, 0.13, 1.58, 0.03],       // roof rack (top 2.33)
      [0, 1.18, 2.62, 0.36, 0.38, 0.15, 0.06],       // spare wheel
      [0, 0.51, -0.625, 0.30, 0.09, 1.125, 0.04],    // belly: sump, gearbox, transfer case (lowest, 0.42)
      [0.58, 0.56, 1.91, 0.22, 0.08, 0.29, 0.03],    // fuel tank, right of the rear rails
    ],
  };
}
