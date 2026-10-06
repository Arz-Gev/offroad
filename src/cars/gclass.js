import { ROAD_ENGINES } from '../vehicle/engines.js';

// Mercedes-Benz G 500 (W463A, 2018+): 4.0 V8 biturbo, 422 PS, 610 Nm; ~2,450 kg. Format: src/cars/README.md.
export default {
  id: 'gclass',
  label: 'G-Class',

  physics: {
    name: 'G-Class G 500',
    engine: { preset: 'g500', choices: ROAD_ENGINES },
    bodyMass: 2050, bodyInertia: [4100, 5300, 1300], com: [0, 0.86, -0.03], aero: { cdA: 1.65 },
    wheelbase: 2.907, track: 1.635,
    // character: heavy, torquey, flat (stiffer bars than the Defender), quicker modern steering. Long travel
    // and 20 psi for the trails: its real road travel and 26 psi bounced off the bump stops above 60.
    // Front spring stiff enough that the static ride uses ~40 % of the travel (47000 sat at 45 %, 8 cm to the
    // bump rubber); the front bar gave back the roll stiffness the spring added.
    // Beam axles here (the real W463A has double wishbones in front and a five-link beam behind). The axle
    // roll inertias and the rear roll steer are the Defender's, kept from when the car was added.
    axles: [
      { type: 'beam', steered: true, mass: 205, rollInertia: 75,
        k: 54000, bump: 4400, rebound: 7000, arb: 9000, travel: 0.24, springTrack: 1.05, damperTrack: 1.30 },
      { type: 'beam', mass: 195, rollInertia: 72, rollSteer: 0.06,
        k: 51000, bump: 4300, rebound: 6800, arb: 4500, travel: 0.25, springTrack: 1.08, damperTrack: 1.30 },
    ],
    tire: { size: 31.5, widthIn: 11, rimRadius: 0.254, inertia: 3.0, pressure: 20 },
    steer: { maxAngle: 0.58, ratio: 15.5, kingpinTrack: 1.45 },
    brakes: { front: 3600, rear: 1800, handbrake: 3400 },
    auto: { ratios: [4.70, 2.85, 1.88, 1.36, 1.00, 0.73], reverse: 4.0 },
    manual: { ratios: [4.20, 2.50, 1.60, 1.15, 0.85], reverse: 3.9 },
    transfer: { high: 1.0, low: 2.93 },
    finalDrive: 3.70,
    // permanent 4MATIC: the centre diff splits 40 : 60 front / rear (the W463 before 2018: 50 : 50); three
    // lockers (centre, rear, front) like the Defender's
    drive: { centreSplit: 0.4 },
    colliders: [   // [cx, cy, cz, hx, hy, hz, rounding], body frame at static ride (ground y 0), measured off the shell
      ['Cabin and rear body', [0, 1.30, 0.825, 0.90, 0.68, 1.325, 0.06]],      // sill 0.62 to roof 1.98, windscreen top to rear face 2.15
      ['Bonnet and wings', [0, 0.96, -1.325, 0.90, 0.34, 0.825, 0.06]],        // 0.62 to bonnet 1.30, bumper back to the windscreen
      ['Front bumper', [0, 0.70, -2.24, 0.80, 0.25, 0.14, 0.03]],             // 0.45-0.95, face at -2.38
      ['Rear bumper', [0, 0.585, 2.175, 0.85, 0.165, 0.125, 0.03]],           // 0.42-0.75, face 2.30
      ['Chassis rails', [0, 0.52, 0.05, 0.45, 0.10, 2.05, 0.03]],             // 0.42-0.62
      ['Spare wheel', [0, 1.19, 2.375, 0.42, 0.39, 0.175, 0.06]],             // on the rear door, to 2.55
      ['Belly', [0, 0.51, -0.625, 0.30, 0.09, 1.125, 0.04]],                  // sump, gearbox, transfer case (lowest 0.42)
    ],
    // load bay floor behind the rear seats (~0.85 m), and on the roof (top 1.98); from the collision boxes
    load: { cargo: [0, 0.95, 1.35], roof: [0, 2.10, 0.75] },
  },

  look: {
    url: 'models/gclass2021.glb',
    author: 'ItsDiyor',
    credit: 'Mercedes-Benz G-Class 2021 by ItsDiyor, CC BY 4.0, https://sketchfab.com/3d-models/1768618c049b49fcb0d09a86d6f67c8d',
    wheel: { R: 0.4015, width: 0.285 },   // its own tyre (the wheel nodes scale from this to the tuned size)
    eye: [-0.40, 1.62, 0.10],             // left-hand drive
    hoodEye: [0, 1.68, -1.05],
    lamps: { head: [0, 0.95, -2.42], bar: [0, 2.02, -0.55], rear: [0, 0.80, 2.62] },
  },

  tests: {
    t100: [4.7, 6],   // real G 500: 0-100 in 5.4 s
  },
};
