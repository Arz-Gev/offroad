// Values a car file doesn't have to state: the behaviour of ordinary parts of a mid-size petrol 4x4 (tyre
// carcass, steering compliance, starter, clutch, torque converter, dampers). A car states its own when it
// differs (src/cars/btr80.js). Merged under the car's physics by carParams.js.
export const PARAM_DEFAULTS = {
  aero: { rho: 1.2 },
  tire: {
    damping: 650,            // radial damping N*s/m, rolling at 20 psi (tire.js tireRadialDamping: more when
                             // aired down, ~3x when standing or creeping)
    relaxX: 0.22,            // longitudinal relaxation length (m) at reference pressure
    relaxY: 0.55,            // lateral relaxation length (m)
    minPressure: 6, maxPressure: 38,   // psi, the in-game range
    grip: 1,                 // rally / sport tyres more
  },
  steer: {
    // compliance: side force x (caster trail + pneumatic trail) about the kingpins over the stiffness of
    // the steering box, drag link and track rod (N·m/rad at the road wheels, both wheels together)
    casterTrail: 0.022, pneuTrail: 0.035, stiffness: 50000,
  },
  brakes: { handbrakeHold: 24000 },   // standstill hold of the whole transfer output (Nm, Vehicle.handbrakeLogic)
  engine: {
    stallRpm: 280,
    starterTorque: 260, starterRpm: 265,  // starter at the crank: stall torque (Nm) and no-load speed (rpm); cranks at ~200 rpm
    compressionTorque: 120, startFlare: 1000, // compression strokes (Nm peak) when not firing; idle flare on start (rpm)
    catchMin: 0.35, catchSpread: 0.15, fireRamp: 0.2, // cranking before it fires (s, + random), all cylinders firing after (s)
  },
  clutch: { capacity: 680, inputInertia: 0.035 },   // the tuning panel raises the capacity with the engine's torque
  auto: {
    stallK: 112,             // converter capacity factor at stall (rpm / sqrt(Nm))
    turbineInertia: 0.06,
    lockupCapacity: 750,
    shiftTime: 0.38,
    shiftCapacity: 900,
  },
};

// every axle, unless its car says otherwise
export const AXLE_DEFAULTS = {
  type: 'beam',              // 'beam' (solid axle, 2 DOF) | 'independent' (1 DOF per wheel)
  preload: 0,                // spring preload (m of compression at full droop)
  damperKnee: 0.22, damperHigh: 0.55,   // digressive dampers: slope x damperHigh above the knee (m/s)
  rollSteer: 0,              // rad of steer per rad of axle roll (beam)
  steered: false,
};
