// Flat-ground handling with keyboard-style steering.
//   node tools/handling.mjs            steady full lock at 30/40/50/60 km/h, then a slalom at 50 and 60 km/h
// Reports steady lateral g, yaw rate, roll, the lightest wheel load, and rollovers.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240;
const surfName = process.argv[2] || 'dirt';
function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
  const n = 200, N = n + 1;
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 2000, y: 1, z: 2000 }));
  world.step();
  const v = new Vehicle(RAPIER, world, makeDefenderParams(), { position: { x: 0, y: 0.12, z: 0 }, surfaceAt: () => SURFACES[surfName] });
  return { world, v };
}
function keyRamp(st, key) { // same ramp as src/input.js
  const rate = key === 0 ? 3.2 : (Math.sign(key) !== Math.sign(st.s) && st.s !== 0 ? 4.5 : 2.0);
  st.s += Math.max(-rate * H, Math.min(rate * H, key - st.s));
  return st.s;
}
function run(kmh, mode) {
  const { world, v } = setup();
  const st = { s: 0 };
  let t = 0, rolled = false, maxRoll = 0, minFn = 1e9, latSum = 0, yawSum = 0, rollSum = 0, n = 0, liftT = 0;
  for (let i = 0; i < 240 * 26; i++) {
    t = i * H;
    const sp = v.speed * 3.6;
    let key = 0;
    const phase = t - 12; // reach speed in a straight line first
    if (phase > 0) key = mode === 'circle' ? 1 : (Math.floor(phase / 1.25) % 2 ? -1 : 1);
    const steer = keyRamp(st, key);
    const thr = Math.max(0, Math.min(1, (kmh - sp) * 0.3 + 0.2));
    v.step(H, { throttle: thr, brake: 0, steer, clutch: 0, handbrake: 0, analogSteer: false });
    world.step();
    if (phase > 1) {
      const roll = Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3;
      maxRoll = Math.max(maxRoll, Math.abs(roll));
      const fmin = Math.min(...v.wheels.map(w => w.FnAvg)); minFn = Math.min(minFn, fmin);
      if (fmin <= 0) liftT += H;
      if (v.up.y < 0.4) rolled = true;
      if (mode === 'circle' && phase > 6) { latSum += v.accel.dot(v.right) / 9.81; yawSum += v.angVel.dot(v.up) * 57.3; rollSum += roll; n++; }
    }
    if (rolled) break;
  }
  const extra = mode === 'circle' && n ? `steady ${(latSum / n).toFixed(2)} g, yaw ${(yawSum / n).toFixed(1)} deg/s, roll ${(rollSum / n).toFixed(1)} deg, wheel ${(v.steerAngle * 57.3).toFixed(1)} deg, speed ${(v.speed * 3.6).toFixed(0)}` : '';
  console.log(`${mode.padEnd(7)} ${String(kmh).padStart(2)} km/h  ${extra}  max roll ${maxRoll.toFixed(1)} deg, min wheel load ${(minFn / 1000).toFixed(2)} kN, wheel lifted ${liftT.toFixed(2)} s${rolled ? '  ROLLED OVER' : ''}`);
}
console.log('surface', surfName);
for (const k of [30, 40, 50, 60]) run(k, 'circle');
for (const k of [40, 50, 60, 70]) run(k, 'slalom');
