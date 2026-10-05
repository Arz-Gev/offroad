// Headless physics checks for the vehicle model.
//
//   npm run simtest [settle|accel|brake|slope|climb|turn|manual|cars]
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
    let t100 = null;
    run(v, world, 20, (t, veh) => { if (t100 === null && veh.speed >= 100 / 3.6) t100 = t; return raw({ throttle: 1 }); }, 2, status);
    check(`${id}: 0-100 km/h`, t100, ...(T100[id] || [3, 20]), { unit: ' s' });
  }
  useCar('defender');
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} not checked (TUNE)` : ''}`);
if (failed) process.exit(1);
