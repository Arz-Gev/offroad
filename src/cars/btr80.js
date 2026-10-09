// BTR-80 (GAZ-5903), 8x8 armoured personnel carrier: 13.6 t combat weight, KamAZ-7403 260 PS / 785 Nm,
// 5-speed manual + 2-speed transfer with a lockable centre diff (axles 1 + 3 on one output, 2 + 4 on the
// other), cam-type axle diffs, wheel reductions (main gear 1.846 x 3.34 = 6.166), double wishbones on
// torsion bars, two shocks on each wheel of axles 1 and 4, one on axles 2 and 3, front two axles steer,
// 13.00-18 tyres with central inflation (0.5-3.0 kgf/cm²), 80 km/h.
// Axle positions, track and tyre are the model's (scale 0.82, assets-src/btr80/README.md): track 2.31
// (real 2.41), axles at 1.34 / 1.76 / 1.34 (real 1.35 / 1.70 / 1.35), tyre R 0.572 (real 0.56).
// Format: src/cars/README.md.

// every corner: double wishbones on a torsion bar (rates at the wheel), roll centre 0.15 m, camber gain
// -0.2 rad/m; 0.32 m of wheel travel from full droop, bump rubbers 5 cm before the stop (x3 for the mass);
// cam-type axle diffs. The static ride uses about half the travel (10-12 cm to the rubbers); stiffer bars
// (110000) cost articulation (least loaded wheel on the diagonal blocks 24 -> 16 % of the mean, simtest btr).
// Torsion bars: 1.15 Hz heave with the tyre in series, zeta ~0.25 (twice the damping on axles with two shocks).
const CORNER = { type: 'independent', mass: 460, k: 90000, arb: 0, travel: 0.32, rcHeight: 0.15, camberGain: -0.2,
  diff: 'lsd', diffLock: 0.35, stopScale: 3, damperKnee: 0.25, damperHigh: 0.5 };
const ONE_SHOCK = { bump: 3000, rebound: 5500 }, TWO_SHOCKS = { bump: 6000, rebound: 11000 };

export default {
  id: 'btr80',
  label: 'BTR-80',

  physics: {
    name: 'BTR-80',
    // 24 V starter on a 17:1 diesel: slow, heavy cranking; a diesel flares little
    engine: { preset: 'kamaz', choices: ['kamaz', 'yamz'],
      starterTorque: 1500, starterRpm: 190, compressionTorque: 900, startFlare: 350, catchMin: 0.6, catchSpread: 0.3, fireRamp: 0.35, stallRpm: 250 },
    manualOnly: true,
    // sprung 11.8 t + 4 x 460 kg unsprung (two wheels with hubs, wheel reductions, drums, knuckles, half arms)
    bodyMass: 11800, bodyInertia: [60000, 66000, 13500], com: [0, 1.12, 0.10], aero: { cdA: 6.0 },
    wheelbase: 4.44, track: 2.313,
    archTop: 1.22,   // the lowest hull over the tyres, axle 1 (1.24-1.28 behind it; tools/rigview.html measureArches)
    axles: [
      { ...CORNER, ...TWO_SHOCKS, z: -2.22, steered: true, group: 0 },
      { ...CORNER, ...ONE_SHOCK, z: -0.88, steered: true, group: 1 },
      { ...CORNER, ...ONE_SHOCK, z: 0.88, group: 0 },
      { ...CORNER, ...TWO_SHOCKS, z: 2.22, group: 1 },
    ],
    // tyre: 45" (13.00-18 is 1120 mm; the model's is 1143) x 15.5" (the model's tread width). kScale: the
    // 33" tyre's stiffness curve x 1.7 (wider, bigger: ~3 cm static deflection at 2.5 kgf/cm², ~11 at 0.5)
    tire: { size: 45, widthIn: 15.5, rimRadius: 0.2286, inertia: 25, pressure: 36, minPressure: 7, maxPressure: 43, kScale: 1.7, hubDrag: 9, hubDragV: 4.5, fnRef: 16000 },
    // Ackermann about a point between axles 3 and 4: axle 2 turns ~0.64 x axle 1. Turning radius 13 m.
    steer: { maxAngle: 0.33, ratio: 22, kingpinTrack: 2.0, centreZ: 1.55, rate: 0.42, casterTrail: 0.03, pneuTrail: 0.05, stiffness: 250000 },
    // drums on every wheel; the parking brake is a drum on the transfer case output (all wheels)
    brakes: { front: 6500, rear: 5500, handbrake: 30000, handbrakeHold: 80000 },
    drive: { rwd: [], handbrake: [0, 1, 2, 3] },
    manual: { ratios: [7.82, 4.03, 2.50, 1.53, 1.00], reverse: 7.38 },
    auto: { ratios: [7.82, 4.03, 2.50, 1.53, 1.00, 1.00], reverse: 7.38 },   // unused: manual only (auto-shift)
    transfer: { high: 1.0, low: 1.982 },
    finalDrive: 6.166,
    clutch: { capacity: 1250, inputInertia: 0.15 },
    // BPU-1 turret: hand-driven traverse (360°) and elevation -4° to +60°. No published drive speeds: a gunner
    // cranking the hand wheels at ~2-3 turns/s gives ~12°/s traverse and ~8°/s elevation (estimates).
    // KPVT 14.5 mm: B-32 / BZT, 64 g at 1000 m/s, ~770 m/s left at 1000 m (k = ln(1000/770)/1000), 600 rpm,
    // 500 rounds in 10 belts of 50; PKT 7.62 mm coaxial: LPS 9.6 g at 825 m/s, ~560 m/s at 500 m, 750 rpm,
    // 2000 rounds in belts of 250. Recoil impulse: bullet + powder gases. Every round is a tracer (a game choice).
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
    // in the troop compartment (floor ~hub height) and on the hull roof (hub +1.32), body frame (estimates)
    load: { cargo: [0, 0.95, 0.6], roof: [0, 1.95, 1.2] },
  },

  look: {
    url: 'models/btr80.glb',
    author: 'Goga.Danelia',
    credit: 'BTR 80 by Goga.Danelia, CC BY 4.0, https://sketchfab.com/3d-models/2980ab7cbc4d41b7893e3233e9dcc1ce',
    // its own tyres (BTR_80_Tire, split off by prepcar: tire_<k> deforms, the rim doesn't); hub_<k> is the inflation valve (it spins)
    wheel: { R: 0.5715, width: 0.40, rim: 0.24, hubSpins: true },
    // the model's own double wishbones (prepcar parts per corner); the arms' inner pivots are on the hull (hub frame, mirrored)
    suspension: { parts: 'wishbones', pivotLow: [0.600, -0.006], pivotUp: [0.600, 0.190] },
    // BPU-1 turret: BTR_80_B (yaw about the ring), BTR_80_C (gun cradle: KPVT box, coaxial PKT, searchlight;
    // pitch about the trunnions) with BTR_80_E (case chute), LULA (the barrel, recoils in the cradle).
    // Ring centre, trunnion axis, barrel tip and PKT muzzle in the hub frame; sight: the gunner's PP-61AM
    // periscope head (turret roof, left of the cradle) from the ring.
    turret: {
      yaw: 'BTR_80_B_Baked002', pitch: ['BTR_80_E_Baked002', 'BTR_80_C_Baked002'], recoil: 'LULA_Baked002',
      ring: [-0.018, 1.257, -1.044], trunnion: [-0.023, 1.761, -0.95],
      muzzles: { muzzle: [-0.023, 1.760, -3.04], pktMuzzle: [0.429, 1.866, -1.32] },
      sight: [-0.32, 0.77, -0.15],
    },
    chase: { dist: 11.5, target: 1.6 },
    eye: [-0.62, 2.22, -2.63],             // driver's hatch, head out (march position)
    hoodEye: [0, 2.05, -2.45],
    // the head beam at the height of the four round headlamps on the glacis cheeks (hub y ~1.0, z -2.7), ahead
    // of the nose (one beam between the lamps; behind them it lit the glacis plate white); tail glow at the
    // back. Lenses by mesh name: the headlamps are the IR_Iluminator lenses (three) and the Headlights lens
    // (right upper); the small nose lamps are the side lamps and indicators (Blinkers_Yellow is also the
    // mirrors' and the Headlights lens' material: the node name picks the indicators alone)
    lamps: { head: [0, 1.57, -3.90], rear: [0, 1.25, 3.65],
      lenses: { head: 'IR_Iluminator|Headlights', side: 'Blinkers_Red_0', amber: 'Blinkers_Yellow_0' } },
    // the extra lamps (J): the two OU-3GA searchlights, one in front of the commander's hatch, one on the gun
    // cradle (turns with the guns); the model has their IR covers shut, so they are drawn open with a clear
    // lens (faces measured off the housings, hub frame)
    searchlights: [
      { at: [0.352, 1.459, -2.466], r: 0.083, rim: 0.107 },
      { at: [-0.025, 1.991, -1.011], r: 0.083, rim: 0.107, turret: true },
    ],
  },

  tests: {},   // no 0-100 band: its own scenario (npm run simtest btr)
};
