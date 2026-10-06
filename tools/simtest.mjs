// Headless physics checks for the vehicle model.
//
//   npm run simtest [settle|accel|brake|slope|climb|turn|manual|cars|btr]
//
// Every scenario measures a few numbers and checks them against the baselines in DEVNOTES.md
// ("Baselines"). A number outside its band prints FAIL and the run exits with code 1, so a physics change
// that breaks the truck can't go unnoticed. VERBOSE=1 also prints the step-by-step traces.
// TUNE='{"engine":{"preset":"td5"}}' runs a tuning setup (missing parts stay stock); the bands are for the
// stock truck, so with TUNE the numbers are printed but only the sanity checks (settles, no stall) count.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { makeCarParams, CAR_SPECS } from '../src/vehicle/carSpecs.js';
import '../src/vehicle/cars.js';   // throws if its CARS and CAR_SPECS list different cars
import * as tuning from '../src/vehicle/tuning.js';
import { Turret, trajectory } from '../src/vehicle/turret.js';
const { sanitize, applySetup, useCar } = tuning;
await RAPIER.init();

const H = 1 / 240;
const VERBOSE = !!process.env.VERBOSE;
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
    if (VERBOSE && every && i % Math.round(every / H) === 0) log(i * H, veh);
  }
}
const kmh = v => (v * 3.6).toFixed(1);
const rollDeg = v => Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3;
function status(t, v) {
  const d = v.drivetrain;
  const pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd.y))) * 57.3;
  console.log(`  t=${t.toFixed(2)} v=${kmh(v.speed)}km/h rpm=${d.rpm.toFixed(0)} g=${d.gearLabel()} thr=${d.thr.toFixed(2)} ` +
    `y=${v.pos.y.toFixed(3)} pitch=${pitch.toFixed(2)} roll=${rollDeg(v).toFixed(2)} ` +
    `c=[${v.axles.map(a => a.c.toFixed(3)).join(',')}] phi=[${v.axles.map(a => (a.phi * 57.3).toFixed(1)).join(',')}] ` +
    `pen=[${v.wheels.map(w => (w.pen * 100).toFixed(1)).join(',')}]cm Fn=[${v.wheels.map(w => (w.FnAvg).toFixed(0)).join(',')}]`);
}

// ---------------------------------------------------------------- checks
const TUNED = !!process.env.TUNE;
let failed = 0, passed = 0, skipped = 0;
// value must lie in [lo, hi]; baseline: only meaningful for the stock truck (not checked with TUNE)
function check(label, value, lo, hi, { unit = '', baseline = true } = {}) {
  const shown = typeof value === 'number' ? (Number.isFinite(value) ? +value.toFixed(3) : value) : value;
  const band = `[${lo} … ${hi}]${unit}`;
  if (baseline && TUNED) { skipped++; console.log(`  info  ${label}: ${shown}${unit}`); return; }
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${shown}${unit}  ${band}`);
}

const test = process.argv[2] || 'all';
const want = name => test === name || test === 'all';
const P = TUNED ? applySetup(makeDefenderParams(), sanitize(JSON.parse(process.env.TUNE))) : makeDefenderParams();
if (TUNED) console.log('setup', process.env.TUNE);

if (want('settle')) {
  console.log('--- settle on flat ground');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.15, z: 0 } });
  const t0 = performance.now();
  run(v, world, 4, raw(), 0.5, status);
  console.log('  ms per step', ((performance.now() - t0) / (4 / H)).toFixed(3));
  const sumFn = v.wheels.reduce((a, w) => a + w.FnAvg, 0), weight = v.totalMass * 9.81;
  check('tyre load sum / weight', sumFn / weight, 0.99, 1.01, { baseline: false });
  check('vertical speed (settled on the springs)', Math.abs(v.vel.dot(v.up)), 0, 0.05, { unit: ' m/s', baseline: false });
  check('tyre squash', v.wheels.reduce((a, w) => a + w.pen, 0) / 4 * 100, 2, 4.5, { unit: ' cm' });
}

if (want('accel')) {
  console.log('--- full throttle, automatic');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1.5, raw());
  let t100 = null;
  run(v, world, 30, (t, veh) => { if (t100 === null && veh.speed >= 100 / 3.6) t100 = t; return raw({ throttle: 1 }); }, 1, status);
  check('0-100 km/h', t100, 8.2, 9.3, { unit: ' s' });
  check('speed after 30 s', v.speed * 3.6, 140, 165, { unit: ' km/h' });
}

if (want('brake')) {
  console.log('--- braking from 80 km/h');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1, raw());
  let i = 0;
  while (v.speed < 80 / 3.6 && i++ < 10000) { v.step(H, raw({ throttle: 1 })); world.step(); }
  const p0 = v.pos.clone(), fwd0 = v.fwd.clone(), right0 = v.right.clone(), yaw0 = v.yaw();
  let t = 0;
  while (v.speed > 0.1 && t < 10) {
    v.step(H, raw({ brake: 1 })); world.step(); t += H;
    if (VERBOSE && Math.round(t / H) % 60 === 0) status(t, v);
  }
  const moved = v.pos.clone().sub(p0);
  check('stop distance', moved.dot(fwd0), 31, 37, { unit: ' m' });
  check('sideways drift', Math.abs(moved.dot(right0)), 0, 0.5, { unit: ' m', baseline: false });
  check('yaw change', Math.abs(v.yaw() - yaw0) * 57.3, 0, 3, { unit: '°', baseline: false });
}

if (want('slope')) {
  for (const deg of [20, 30]) {
    console.log(`--- parked on ${deg} deg slope with handbrake (engine off, in P)`);
    const world = makeWorld(deg);
    const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
    pitchTo(v, deg);
    v.drivetrain.running = false; v.drivetrain.setSelector('P');
    run(v, world, 0.05, raw({ brake: 1 }));
    const z0 = v.pos.z;
    run(v, world, 5, raw({ handbrake: 1 }), 1, status);
    check(`creep on ${deg}°`, Math.abs(v.pos.z - z0) * 100, 0, 3, { unit: ' cm' });
    check(`still moving on ${deg}°`, Math.abs(v.speed), 0, 0.02, { unit: ' m/s', baseline: false });
  }
}

// 30° climbs in low range. The manual case shifts into 1st the way a player does (requestShift, with the
// auto-clutch); setting manualGear directly would skip the clutch and stall the engine against the handbrake.
if (want('climb')) {
  for (const [label, lock, mode, minUp] of [
    ['open centre, auto', false, 'auto', 6], ['centre locked, auto', true, 'auto', 8], ['centre locked, manual 1st low', true, 'manual', 8],
  ]) {
    console.log('--- low range climb 30 deg,', label);
    const world = makeWorld(30);
    const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
    pitchTo(v, 30);
    const d = v.drivetrain;
    d.range = 'low';
    d.centerLock = lock;
    if (mode === 'manual') d.toggleMode();
    run(v, world, 1, raw({ handbrake: 1 }));
    if (mode === 'manual') { d.requestShift(1); run(v, world, 0.5, raw({ handbrake: 1 })); }
    const z0 = v.pos.z;
    run(v, world, 8, raw({ throttle: 0.5 }), 1, (t, veh) => { status(t, veh); console.log('   wheel w', Array.from(veh.drivetrain.w).slice(2).map(x => x.toFixed(2)).join(',')); });
    check(`${label}: engine running`, d.running ? 1 : 0, 1, 1, { baseline: false });
    check(`${label}: distance up the slope in 8 s`, z0 - v.pos.z, minUp, 60, { unit: ' m' });
    // release the throttle: an automatic holds on the converter in low range. The manual's auto-clutch opens
    // as the revs fall and the truck rolls back (the player has to brake), so that case is only reported.
    run(v, world, 4, raw({}), 1, status);
    if (mode === 'auto') check(`${label}: speed 4 s after lift-off`, v.speed * 3.6, -3, 10, { unit: ' km/h' });
    else console.log(`  info  ${label}: speed 4 s after lift-off: ${kmh(v.speed)} km/h (auto-clutch open, rolls back)`);
  }
}

if (want('turn')) {
  console.log('--- steady turn at ~40 km/h');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  run(v, world, 1, raw());
  const latAt = {};
  run(v, world, 30, (t, veh) => {
    const yawRate = veh.angVel.dot(veh.up);
    if (Math.abs(t - 19.5) < H / 2) latAt.part = Math.abs(veh.speed * yawRate / 9.81);
    if (Math.abs(t - 29.5) < H / 2) latAt.full = Math.abs(veh.speed * yawRate / 9.81);
    return raw({ throttle: veh.speed < 40 / 3.6 ? 0.6 : 0.15, steer: t > 8 ? (t > 20 ? 1 : 0.35) : 0 });
  }, 2, (t, veh) => {
    status(t, veh);
    const yawRate = veh.angVel.dot(veh.up);
    console.log('   yawRate', yawRate.toFixed(3), 'latAcc g', (veh.speed * yawRate / 9.81).toFixed(2), 'steer', veh.steerAngle.toFixed(3));
  });
  check('lateral g, 35 % steer', latAt.part, 0.25, 0.45, { unit: ' g' });
  check('lateral g, full keyboard steer', latAt.full, 0.45, 0.68, { unit: ' g' });
  check('body roll at full steer', Math.abs(rollDeg(v)), 0, 12, { unit: '°' });
}

if (want('manual')) {
  console.log('--- manual with auto clutch, launch in 1st and shift up');
  const world = makeWorld();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 500 } });
  const d = v.drivetrain;
  d.toggleMode();
  run(v, world, 1, raw());
  d.requestShift(1);
  run(v, world, 0.5, raw());
  let topGear = 0;
  run(v, world, 20, (t, veh) => {
    if (d.rpm > (P.engine.shiftRpm || 4800) - 200 && !d.shift && d.manualGear < 5) d.requestShift(1);
    topGear = Math.max(topGear, d.manualGear);
    return raw({ throttle: 1 });
  }, 0.5, (t, veh) => { status(t, veh); console.log('   clutch', d.clutchPedal.toFixed(2), 'slip', d.clutchSlip.toFixed(1)); });
  check('engine running', d.running ? 1 : 0, 1, 1, { baseline: false });
  check('highest gear reached', topGear, 4, 5);
  check('speed after 20 s', v.speed * 3.6, 120, 145, { unit: ' km/h' });
}

// every car in carSpecs.js settles on its springs with the ground at y 0 and accelerates in its own range
if (want('cars') && !TUNED) {
  const T100 = { defender: [8.2, 9.3], gclass: [4.7, 6], lancia: [4.9, 6.3] };   // real cars: 0-100 in 5.4 s (G 500), 5.7 s (Delta Evo 2)
  for (const id of Object.keys(CAR_SPECS)) {
    console.log(`--- ${id}: settle and 0-100`);
    const world = makeWorld();
    useCar(id);   // as main.js builds the car: its stock setup (engine curve, tyres) applied to its params
    const Pc = applySetup(makeCarParams(id), tuning.STOCK);
    const v = new Vehicle(RAPIER, world, Pc, { position: { x: 0, y: 0.1, z: 500 } });
    run(v, world, 3, raw(), 0.5, status);
    const sumFn = v.wheels.reduce((a, w) => a + w.FnAvg, 0);
    check(`${id}: tyre load sum / weight`, sumFn / (v.totalMass * 9.81), 0.99, 1.01, { baseline: false });
    check(`${id}: ride height error`, Math.abs(v.pos.y - (CAR_SPECS[id]?.raise || 0)) * 100, 0, 3, { unit: ' cm' });
    if (!T100[id]) continue;   // heavy trucks: own scenario (btr80 below)
    let t100 = null;
    run(v, world, 20, (t, veh) => { if (t100 === null && veh.speed >= 100 / 3.6) t100 = t; return raw({ throttle: 1 }); }, 2, status);
    check(`${id}: 0-100 km/h`, t100, ...T100[id], { unit: ' s' });
  }
  useCar('defender');
}

// BTR-80 (8x8, independent torsion-bar corners, 13.6 t). Bands from the real vehicle where published
// (80 km/h on the road, 30° climb, 25° side slope, turning radius 13.2 m, clearance 475 mm) and sanity
// elsewhere; the numbers are in DEVNOTES "Baselines".
if (want('btr') && !TUNED) {
  useCar('btr80');
  const PB = () => applySetup(makeCarParams('btr80'), tuning.STOCK);
  const spawn = (world, z = 0, P0 = PB()) => new Vehicle(RAPIER, world, P0, { position: { x: 0, y: 0.1, z } });
  const minLoad = v => Math.min(...v.wheels.map(w => w.FnAvg)) / (v.totalMass * 9.81 / v.wheels.length);

  console.log('--- btr80: static ride');
  {
    const world = makeWorld();
    const v = spawn(world, 500);
    run(v, world, 4, raw(), 1, status);
    const loads = v.wheels.map(w => w.FnAvg), mean = loads.reduce((a, b) => a + b) / loads.length;
    check('btr80: tyre load sum / weight', loads.reduce((a, b) => a + b) / (v.totalMass * 9.81), 0.99, 1.01, { baseline: false });
    check('btr80: ride height error', Math.abs(v.pos.y) * 100, 0, 2, { unit: ' cm' });
    check('btr80: wheel load spread (max / min)', Math.max(...loads) / Math.min(...loads), 1, 1.35);
    check('btr80: body pitch', Math.asin(v.fwd.y) * 57.3, -0.6, 0.6, { unit: '°' });
    check('btr80: tyre squash at 36 psi', v.wheels.reduce((a, w) => a + w.pen, 0) / v.wheels.length * 100, 3, 6.5, { unit: ' cm' });
    console.log(`  info  btr80: mean wheel load ${(mean / 1000).toFixed(1)} kN, mass ${v.totalMass.toFixed(0)} kg`);
  }

  console.log('--- btr80: 0-60 and top speed (4 km strip, automatic shifting)');
  {
    const world = makeWorld(0, 4000, 400);
    const v = spawn(world, 1950);
    run(v, world, 2, raw());
    let t60 = null, v100 = 0;
    run(v, world, 150, (t, veh) => {
      if (t60 === null && veh.speed >= 60 / 3.6) t60 = t;
      if (Math.abs(t - 100) < H / 2) v100 = veh.speed * 3.6;
      return raw({ throttle: 1 });
    }, 10, status);
    check('btr80: 0-60 km/h', t60, 22, 34, { unit: ' s' });
    check('btr80: speed after 100 s', v100, 74, 82, { unit: ' km/h' });
    check('btr80: speed after 150 s (top, real 80)', v.speed * 3.6, 77, 84, { unit: ' km/h' });
    check('btr80: gear at top speed', v.drivetrain.manualGear, 5, 5);
  }

  console.log('--- btr80: braking from 60 km/h');
  {
    const world = makeWorld();
    const v = spawn(world, 500);
    run(v, world, 1, raw());
    let i = 0;
    while (v.speed < 60 / 3.6 && i++ < 20000) { v.step(H, raw({ throttle: 1 })); world.step(); }
    const p0 = v.pos.clone(), f0 = v.fwd.clone(), r0 = v.right.clone();
    let t = 0;
    while (v.speed > 0.1 && t < 15) { v.step(H, raw({ brake: 1 })); world.step(); t += H; }
    const moved = v.pos.clone().sub(p0);
    check('btr80: 60-0 stop distance', moved.dot(f0), 18, 32, { unit: ' m' });
    check('btr80: sideways drift', Math.abs(moved.dot(r0)), 0, 0.5, { unit: ' m', baseline: false });
  }

  // as a real gradient test: a run-up on the flat, then a 30° ramp, low range, full throttle
  for (const [label, locks] of [['centre open', false], ['centre locked', true]]) {
    console.log(`--- btr80: 30° climb from a run-up, low range, ${label}`);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = H;
    const n = 300, N = n + 1, size = 600, heights = new Float32Array(N * N), tan = Math.tan(30 * Math.PI / 180);
    for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) heights[c * N + r] = Math.max(0, -(-size / 2 + (r / n) * size) - 0) * tan;
    world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }).setFriction(0.8));
    world.step();
    const v = spawn(world, 12);
    const d = v.drivetrain;
    d.range = 'low';
    d.centerLock = locks;
    run(v, world, 1, raw());
    let back = 0;
    run(v, world, 25, (t, veh) => { if (veh.pos.y > 2 && veh.speed < -0.2) back = 1; return raw({ throttle: 1 }); }, 2, status);
    check(`btr80: ${label}: engine running`, d.running ? 1 : 0, 1, 1, { baseline: false });
    check(`btr80: ${label}: height climbed in 25 s`, v.pos.y, locks ? 10 : 7, 100, { unit: ' m' });
    check(`btr80: ${label}: speed on the ramp at the end`, v.speed * 3.6, locks ? 4.5 : 3, 8, { unit: ' km/h' });
    check(`btr80: ${label}: rolled back on the ramp`, back, 0, 0, { baseline: false });
  }

  console.log('--- btr80: parked on 30° with the handbrake (engine off)');
  {
    const world = makeWorld(30);
    const v = spawn(world);
    pitchTo(v, 30);
    v.drivetrain.running = false;
    run(v, world, 0.05, raw({ brake: 1 }));
    const z0 = v.pos.z;
    run(v, world, 6, raw({ handbrake: 1 }), 1, status);
    check('btr80: creep on 30°', Math.abs(v.pos.z - z0) * 100, 0, 3, { unit: ' cm' });
  }

  console.log('--- btr80: across a 25° side slope (real limit 25°), parked');
  {
    const world = makeWorld(25);
    const v = spawn(world);
    // facing +x: the slope (rising towards -z) is now on the left
    const a = 25 * Math.PI / 180, qy = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, qx = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
    const q = { w: qx.w * qy.w - qx.x * qy.x - qx.y * qy.y - qx.z * qy.z, x: qx.w * qy.x + qx.x * qy.w + qx.y * qy.z - qx.z * qy.y,
      y: qx.w * qy.y - qx.x * qy.z + qx.y * qy.w + qx.z * qy.x, z: qx.w * qy.z + qx.x * qy.y - qx.y * qy.x + qx.z * qy.w };
    v.body.setRotation(q, true); v.readBody(); v.updateGeometry();
    v.drivetrain.running = false;
    run(v, world, 6, raw({ handbrake: 1 }), 1, status);
    check('btr80: side slope: body roll', Math.abs(rollDeg(v)), 22, 30, { unit: '°' });
    check('btr80: side slope: least loaded wheel / mean', minLoad(v), 0.3, 1);
    check('btr80: side slope: slide in 6 s', Math.abs(v.vel.length()), 0, 0.02, { unit: ' m/s', baseline: false });
  }

  console.log('--- btr80: articulation (25 cm blocks under diagonal wheels: front left, 2nd right, 3rd left)');
  {
    const world = makeWorld();
    const P0 = PB();
    for (const [x, z] of [[-1, P0.axles[0].z], [1, P0.axles[1].z], [-1, P0.axles[2].z]]) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.45, 0.125, 0.45).setTranslation(x * P0.track / 2, 0.125, z).setFriction(0.9));
    }
    world.step();
    const v = spawn(world, 0, P0);
    v.body.setTranslation({ x: 0, y: 0.35, z: 0 }, true); v.readBody(); v.updateGeometry();
    run(v, world, 5, raw(), 1, status);
    check('btr80: articulation: wheels on the ground', v.wheels.filter(w => w.contact && w.FnAvg > 500).length, 8, 8);
    check('btr80: articulation: least loaded wheel / mean', minLoad(v), 0.15, 1);
    check('btr80: articulation: most loaded wheel / mean', Math.max(...v.wheels.map(w => w.FnAvg)) / (v.totalMass * 9.81 / 8), 1, 2.2);
  }

  console.log('--- btr80: turning circle at walking pace, full lock');
  {
    const world = makeWorld();
    const v = spawn(world, 500);
    v.steerAssist = 'off';
    run(v, world, 1, raw());
    let rad = 0;
    run(v, world, 25, (t, veh) => {
      if (t > 20) rad = veh.speed / Math.max(1e-3, Math.abs(veh.angVel.dot(veh.up)));
      return raw({ throttle: veh.speed < 2.5 ? 0.4 : 0, steer: t > 3 ? 1 : 0 });
    }, 2, status);
    check('btr80: turning radius (real 13.2 m)', rad, 11.5, 15, { unit: ' m' });
  }

  console.log('--- btr80: steady turn at ~40 km/h');
  {
    const world = makeWorld();
    const v = spawn(world, 500);
    run(v, world, 1, raw());
    let lat = 0, lift = 0;
    run(v, world, 40, (t, veh) => {
      if (t > 25) { lat = Math.max(lat, Math.abs(veh.speed * veh.angVel.dot(veh.up) / 9.81)); if (veh.wheels.some(w => !w.contact || w.FnAvg < 200)) lift += H; }
      return raw({ throttle: veh.speed < 40 / 3.6 ? 0.8 : 0.2, steer: t > 15 ? 0.6 : 0 });
    }, 4, status);
    check('btr80: lateral g', lat, 0.25, 0.6, { unit: ' g' });
    check('btr80: body roll', Math.abs(rollDeg(v)), 1, 10, { unit: '°' });
    check('btr80: time with a wheel off the ground', lift, 0, 0.1, { unit: ' s' });
  }

  console.log('--- btr80: turret');
  {
    const S = PB().turret, tu = new Turret(S), h = 1 / 240;
    // traverse 90° right and elevate to +30° from rest
    tu.aim(Math.PI / 2, 30 * Math.PI / 180, 0, 0, h);
    let tYaw = null, tPitch = null, t = 0;
    while (t < 20 && (tYaw === null || tPitch === null)) {
      tu.step(h, false); t += h;
      if (tYaw === null && Math.abs(tu.yaw - Math.PI / 2) < 0.2 * Math.PI / 180) tYaw = t;
      if (tPitch === null && Math.abs(tu.pitch - 30 * Math.PI / 180) < 0.2 * Math.PI / 180) tPitch = t;
    }
    check('turret: 90° traverse', tYaw, 7.2, 9, { unit: ' s' });
    check('turret: 0 → 30° elevation', tPitch, 3.6, 5, { unit: ' s' });
    tu.aim(0, 2, 0, 0, h); for (let i = 0; i < 20 / h; i++) tu.step(h, false);
    check('turret: elevation limit', tu.pitch * 57.3, 59.9, 60.1, { unit: '°' });
    tu.aim(0, -2, 0, 0, h); for (let i = 0; i < 20 / h; i++) tu.step(h, false);
    check('turret: depression limit', tu.pitch * 57.3, -4.1, -3.9, { unit: '°' });
    // KPVT: rate of fire, one belt, the reload
    const tk = new Turret(S);
    let n3 = 0, n10 = 0, n20 = 0;
    for (let i = 1; i <= 20 / h; i++) { tk.step(h, true); const n = tk.guns[0].count; if (i === Math.round(3 / h)) n3 = n; if (i === Math.round(10 / h)) n10 = n; n20 = n; }
    check('KPVT: rounds in 3 s (600 rpm)', n3, 29, 31);
    check('KPVT: rounds in 10 s (one belt of 50, then reloading)', n10, 50, 50);
    check('KPVT: rounds in 20 s (8 s reload)', n20, 95, 101);
    const kp = trajectory(S.weapons[0], [500, 1000, 2000]), pk = trajectory(S.weapons[1], [500]);
    console.log(`  info  KPVT ${kp.map(r => `${r.d} m: ${r.t.toFixed(2)} s, ${r.v.toFixed(0)} m/s, drop ${r.drop.toFixed(1)} m`).join('; ')}`);
    check('KPVT: velocity at 1000 m (B-32 ~770 m/s)', kp[1].v, 740, 800, { unit: ' m/s' });
    check('KPVT: time of flight to 1000 m', kp[1].t, 1.05, 1.25, { unit: ' s' });
    check('PKT: velocity at 500 m (~560 m/s)', pk[0].v, 530, 590, { unit: ' m/s' });
  }
  useCar('defender');
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} not checked (TUNE)` : ''}`);
if (failed) process.exit(1);
