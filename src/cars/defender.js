import { ROAD_ENGINES } from '../vehicle/engines.js';

// Land Rover Defender 110 station wagon, lifted, on 33" mud tyres, Rover 4.6 V8 (the game's first car).
// Everything the game knows about this car is in this file: physics (vehicle/carParams.js turns it into
// the params P), looks (vehicle/cars.js) and test bands (tools/simtest.mjs). Format and fields:
// src/cars/README.md.
export default {
  id: 'defender',
  label: 'Defender 110',
  // setups saved before the cars had their own keys (tuningPanel.js)
  saveKey: 'offroad.tuning.v1',

  physics: {
    name: 'Defender 110 V8',
    engine: { preset: 'v8', choices: ROAD_ENGINES },
    bodyMass: 1880,                       // sprung mass incl. roof rack, winch, spare
    // principal inertia about the COM: pitch (x), yaw (y), roll (z). The axles' mass sits in this body, so
    // yaw includes them at +-1.4 m (they swing sideways with the body); pitch and roll only their small
    // horizontal part (their vertical motion is the axle DOF).
    bodyInertia: [3400, 4400, 1040],
    // centre of mass (local): 51 % on the front axle (engine, winch and bumper ahead of it)
    com: [0, 0.90, -0.04],
    aero: { cdA: 2.15 },
    wheelbase: 2.794,
    track: 1.56,

    // Solid beam axles on coil springs (front: radius arms + panhard, rear: trailing links + A-frame).
    // droopY: the axle centre height at full droop, set by hand on this car (the others' is computed from
    // the static ride; the hand value puts the Defender's ground 1.2 cm off y 0, simtest "ride height").
    axles: [
      {
        type: 'beam', steered: true,
        // springs: the static ride uses ~40 % of the travel, so ~60 % is left for bumps (the softer 43000
        // spring sat at 46 % with 8 cm to the bump rubber; droopY moved up with it, same ride height)
        droopY: 0.29, travel: 0.24,
        mass: 185, rollInertia: 75,
        springTrack: 1.0, k: 50000,
        // dampers sit outboard, close to the wheels; digressive above the knee (m/s)
        damperTrack: 1.24, bump: 4100, rebound: 6500,
        // roll stiffness ~53 % front, a little over its weight share: a stable, mildly understeering truck
        // (the bar gave back what the stiffer springs added)
        arb: 7500,
      },
      {
        type: 'beam',
        droopY: 0.27, travel: 0.25,
        mass: 175, rollInertia: 72,
        springTrack: 1.04, k: 47000,
        damperTrack: 1.24, bump: 4000, rebound: 6300,
        arb: 4000,
        // trailing links + A-frame: the axle turns slightly into the bend as the body rolls (rad / rad)
        rollSteer: 0.06,
      },
    ],

    // 33x10.5R16 mud terrain on steel wheels; 20 psi stock (adjustable in game)
    tire: { size: 33, widthIn: 10.5, rimRadius: 0.205, inertia: 3.3, pressure: 20 },   // inertia: wheel + tyre + hub + half shaft

    steer: { maxAngle: 0.62, kingpinTrack: 1.38, ratio: 17 },
    // max torque per wheel (handbrake: at the rear axle)
    brakes: { front: 2700, rear: 1350, handbrake: 3200 },

    manual: { ratios: [3.585, 2.301, 1.507, 1.0, 0.83], reverse: 3.70 },        // R380 style 5 speed
    auto: { ratios: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69], reverse: 3.40 },      // ZF 6HP style 6 speed
    transfer: { high: 1.211, low: 3.32 },                                         // LT230 style
    finalDrive: 3.54,
    // permanent 4WD: an open centre diff (50 : 50) with a driver's lock, lockers on both axles, and a 2WD
    // switch (front prop shaft disconnected, a game addition) (defaults, vehicle/drivetrain.js driveLayout)
    drive: {},

    // chassis collision boxes: [cx, cy, cz, hx, hy, hz, rounding], fitted to the visible model (truckBody.js)
    // on Oct 3: the old front bumper box sat 10 cm lower and 11 cm further forward than the bumper you see
    // (an invisible nose: approach 32° instead of 38°).
    colliders: [
      ['Cabin / rear body', [0, 1.33, 0.745, 0.89, 0.67, 1.585, 0.06]],    // sill 0.66 to roof 2.0, bulkhead to rear face 2.33
      ['Engine bay', [0, 1.00, -1.36, 0.87, 0.38, 0.64, 0.06]],            // 0.62 to the raised bonnet centre 1.38, wing face -2.0
      ['Front bumper', [0, 0.6775, -2.0875, 0.985, 0.1225, 0.1375, 0.03]], // winch bumper plate 0.555-0.80, face at -2.225 (D-ring shackles hang below: soft)
      ['Rear bumper', [0, 0.63, 2.4025, 0.955, 0.095, 0.0925, 0.03]],      // 0.535-0.725, face 2.495
      ['Chassis rails', [0, 0.54, 0.205, 0.48, 0.08, 2.145, 0.03]],        // rails + crossmembers 0.46-0.62, -1.94 to 2.35
      ['Roof rack', [0, 2.20, 0.70, 0.84, 0.13, 1.58, 0.03]],              // top 2.33
      ['Spare wheel', [0, 1.18, 2.62, 0.36, 0.38, 0.15, 0.06]],
      ['Belly', [0, 0.51, -0.625, 0.30, 0.09, 1.125, 0.04]],               // sump, gearbox, transfer case (lowest, 0.42)
      ['Fuel tank', [0.58, 0.56, 1.91, 0.22, 0.08, 0.29, 0.03]],           // right of the rear rails
    ],
    // where the tuning panel's cargo and roof load sit (body frame)
    load: { cargo: [0, 0.98, 1.45], roof: [0, 2.45, 0.75] },   // load bay floor behind the rear seats; on the rack
  },

  look: {
    body: 'defender',   // procedural (vehicle/truckModel.js), no downloaded model
  },

  tests: {
    t100: [8.2, 9.3],   // 0-100 km/h band, stock, automatic (simtest cars)
  },
};
