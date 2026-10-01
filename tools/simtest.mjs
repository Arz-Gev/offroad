// Headless physics checks for the vehicle model.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { RPM } from '../src/vehicle/drivetrain.js';
await RAPIER.init();

const H = 1 / 240;
function makeWorld(slopeDeg = 0, size = 1200, n = 300) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  const N = n + 1, heights = new Float32Array(N * N);
  const tan = Math.tan(slopeDeg * Math.PI / 180);
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
    const z = -size / 2 + (r / n) * size;
    heights[c * N + r] = -z * tan; // rises toward -z (forward)
  }
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }).setFriction(0.8));
  world.step();
  return world;
}
function pitchTo(v, deg) {
  const a = deg * Math.PI / 180;
  v.body.setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, true);
  v.readBody(); v.updateGeometry();
}
const raw = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, ...o });
function run(veh, world, secs, input, every, log) {
  const steps = Math.round(secs / H);
  for (let i = 0; i < steps; i++) {
    const inp = typeof input === 'function' ? input(i * H, veh) : input;
    veh.step(H, inp);
    world.step();
    if (every && i % Math.round(every / H) === 0) log(i * H, veh);
  }
}
const fmt = (x, d = 2) => (x >= 0 ? ' ' : '') + x.toFixed(d);
const kmh = v => (v * 3.6).toFixed(1);
function status(t, v) {
  const d = v.drivetrain;
  const e = new (v.quat.constructor)();
  const pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd.y))) * 57.3;
  const roll = Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3;
  console.log(`t=${t.toFixed(2)} v=${kmh(v.speed)}km/h rpm=${d.rpm.toFixed(0)} g=${d.gearLabel()} thr=${d.thr.toFixed(2)} ` +
    `y=${v.pos.y.toFixed(3)} pitch=${pitch.toFixed(2)} roll=${roll.toFixed(2)} ` +
    `c=[${v.axles.map(a => a.c.toFixed(3)).join(',')}] phi=[${v.axles.map(a => (a.phi*57.3).toFixed(1)).join(',')}] ` +
    `pen=[${v.wheels.map(w => (w.pen * 100).toFixed(1)).join(',')}]cm Fn=[${v.wheels.map(w => (w.FnAvg).toFixed(0)).join(',')}]`);
}

const test = process.argv[2] || 'all';
const P = makeDefenderParams();

if (test === 'settle' || test === 'all') {
  console.log('--- settle on flat ground');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.15, z: 0 } });
  const t0 = performance.now();
  run(v, world, 4, raw(), 0.5, status);
  console.log('ms per step', ((performance.now() - t0) / (4 / H)).toFixed(3));
  console.log('sum Fn', v.wheels.reduce((a, w) => a + w.FnAvg, 0).toFixed(0), 'weight', (v.totalMass * 9.81).toFixed(0));
}

if (test === 'accel' || test === 'all') {
  console.log('--- full throttle, automatic');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1.5, raw());
  let t100 = null;
  run(v, world, 30, (t, veh) => { if (t100 === null && veh.speed >= 100 / 3.6) t100 = t; return raw({ throttle: 1 }); }, 1, status);
  console.log('0-100 km/h', t100 && t100.toFixed(2), 's');
}

if (test === 'brake' || test === 'all') {
  console.log('--- braking from 80 km/h');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1, raw());
  run(v, world, 40, (t, veh) => raw({ throttle: veh.speed < 80 / 3.6 ? 1 : 0 }), 0);
  // continue until speed reached
  let i = 0;
  while (v.speed < 80 / 3.6 && i++ < 10000) { v.step(H, raw({ throttle: 1 })); world.step(); }
  const z0 = v.pos.z; let t = 0;
  while (v.speed > 0.1 && t < 10) { v.step(H, raw({ brake: 1 })); world.step(); t += H; if (Math.round(t / H) % 60 === 0) { status(t, v); const d=v.drivetrain; console.log('   prop', d.propTorque.map(x=>x.toFixed(0)).join(','), 'engA', d.engineAlpha.toFixed(1), 'w', Array.from(d.w).map(x=>x.toFixed(1)).join(','), 'Fx', v.wheels.map(w=>w.Fx.toFixed(0)).join(','), 'Fy', v.wheels.map(w=>w.Fy.toFixed(0)).join(','), 'steer', v.steerAngle.toFixed(3)); } }
  console.log('stop distance', (z0 - v.pos.z).toFixed(1), 'm in', t.toFixed(2), 's');
}

if (test === 'slope' || test === 'all') {
  for (const deg of [20, 30]) {
    console.log(`--- parked on ${deg} deg slope with handbrake (engine off, in P)`);
    const world = makeWorld(deg);
    const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
    pitchTo(v, deg);
    v.drivetrain.running = false; v.drivetrain.setSelector('P');
    run(v, world, 0.05, raw({ brake: 1 }));
    const z0 = v.pos.z;
    run(v, world, 5, raw({ handbrake: 1 }), 1, status);
    console.log('creep', ((v.pos.z - z0) * 100).toFixed(2), 'cm');
  }
}

for (const [label, lock, mode] of [['open centre, auto', false, 'auto'], ['centre locked, auto', true, 'auto'], ['centre locked, manual 1st low', true, 'manual']]) if (test === 'climb' || test === 'all') {
  console.log('--- low range climb 30 deg,', label);
  const world = makeWorld(30);
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
  pitchTo(v, 30);
  v.drivetrain.range = 'low';
  v.drivetrain.centerLock = lock;
  if (mode === 'manual') { v.drivetrain.toggleMode(); v.drivetrain.manualGear = 1; }
  run(v, world, 1, raw({ handbrake: 1 }));
  run(v, world, 8, raw({ throttle: 0.5 }), 1, (t, veh) => { status(t, veh); console.log('   wheel w', Array.from(veh.drivetrain.w).slice(2).map(x => x.toFixed(2)).join(',')); });
  console.log('   now release throttle on the slope (engine braking / creep in low range)');
  run(v, world, 4, raw({}), 1, status);
}

if (test === 'turn' || test === 'all') {
  console.log('--- steady turn at ~40 km/h');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1, raw());
  run(v, world, 30, (t, veh) => raw({ throttle: veh.speed < 40 / 3.6 ? 0.6 : 0.15, steer: t > 8 ? (t > 20 ? 1 : 0.35) : 0 }), 2, (t, veh) => {
    status(t, veh);
    const yawRate = veh.angVel.dot(veh.up);
    console.log('   yawRate', yawRate.toFixed(3), 'latAcc g', (veh.speed * yawRate / 9.81).toFixed(2), 'steer', veh.steerAngle.toFixed(3));
  });
}

if (test === 'manual' || test === 'all') {
  console.log('--- manual with auto clutch, launch in 1st and shift up');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  const d = v.drivetrain;
  d.toggleMode();
  run(v, world, 1, raw());
  d.requestShift(1);
  run(v, world, 0.5, raw());
  run(v, world, 20, (t, veh) => {
    if (d.rpm > 4600 && !d.shift && d.manualGear < 5) d.requestShift(1);
    return raw({ throttle: 1 });
  }, 0.5, (t, veh) => { status(t, veh); console.log('   clutch', d.clutchPedal.toFixed(2), 'slip', d.clutchSlip.toFixed(1)); });
}
