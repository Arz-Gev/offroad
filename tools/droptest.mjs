// Drop test: does a tyre landing tilted throw the truck? The truck is let go from rest above a heightfield
// slope (across the truck: it lands on its uphill wheels with the wheel planes tilted by the slope, as
// after R on a hillside), optionally rolled about its long axis (90 = on its side). Energy can only go
// down after the drop, so the report is the energy gained over the start (kinetic + potential of the
// body), the highest upward speed after the first touch, and how high the body bounces.
//   node tools/droptest.mjs [slopeDeg=30] [rollDeg=0] [drop=0.5] [secs=4]     CAR=btr80 for another car
//   node tools/droptest.mjs sweep      (slopes 0-50, rolls 0-90: one line each)
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { makeCarParams } from '../src/vehicle/carSpecs.js';
import { useCar, applySetup, STOCK, clone, rideRaise } from '../src/vehicle/tuning.js';
import * as THREE from 'three';
await RAPIER.init();
const H = 1 / 240, G = 9.81;
const carParams = () => { if (!process.env.CAR) return makeDefenderParams(); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };

function run(slopeDeg, rollDeg, drop = 0.5, secs = 4) {
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 }); world.timestep = H;
  // heightfield 200 m square, rising along +x (rows of the matrix run along x)
  const n = 200, N = n + 1, size = 200, s = Math.tan(slopeDeg * Math.PI / 180);
  const hts = new Float32Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) hts[i + j * N] = 0;
  const hf = world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, hts, { x: size, y: 1, z: size }).setFriction(0.8));
  // which index runs along x: set one ramp and look with a ray
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) hts[i + j * N] = (i / n - 0.5) * size * s;
  world.removeCollider(hf, false);
  let col = world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, hts, { x: size, y: 1, z: size }).setFriction(0.8));
  const hAt = (x, z) => { const r = new RAPIER.Ray({ x: x + 0.013, y: 500, z: z + 0.017 }, { x: 0, y: -1, z: 0 }); const h = world.castRay(r, 1000, true); return 500 - h.timeOfImpact; };
  world.step();
  if (slopeDeg && Math.abs(hAt(10, 0) - hAt(0, 0)) < Math.abs(hAt(0, 10) - hAt(0, 0))) {
    // the ramp ran along z: transpose
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) hts[i * N + j] = (i / n - 0.5) * size * s;
    world.removeCollider(col, false);
    col = world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, hts, { x: size, y: 1, z: size }).setFriction(0.8));
    world.step();
  }
  const P = carParams();
  // as placeVehicle: the highest ground under the corners + lift, upright (yaw 0, nose to -z)
  let y = -1e9;
  for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, hAt(dx, dz));
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0, z: 0 } });
  const lift = rollDeg ? 1.4 * Math.sin(rollDeg * Math.PI / 180) : 0;   // rolled: room for the half-track
  v.reset({ x: 0, y: y + drop + lift + rideRaise(P), z: 0 }, 0);
  if (rollDeg) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollDeg * Math.PI / 180);
    v.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    v.readBody(); v.updateGeometry();
  }
  const m = v.totalMass, I = P.bodyInertia;
  const energy = () => {
    // body only: translation + rotation (inertia in the body frame) + height of the COM
    const w = v.angVel.clone().applyQuaternion(v.quat.clone().invert());
    return 0.5 * m * v.vel.lengthSq() + 0.5 * (I[0] * w.x * w.x + I[1] * w.y * w.y + I[2] * w.z * w.z) + m * G * v.com.y;
  };
  const raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 1 };
  // one step first: the body's centre of mass is only updated by a world step after the teleport
  v.step(H, raw); world.step(); v.readBody();
  const E0 = energy();
  const trace = process.env.TRACE ? [] : null;
  let touched = false, tTouch = 0, maxGain = 0, tGain = 0, maxUp = 0, comLow = 1e9, bounce = 0, maxW = 0;
  for (let k = 0; k < secs / H; k++) {
    v.step(H, raw); world.step();
    v.readBody();
    const t = (k + 1) * H;
    if (!touched && v.wheels.some(w => w.Fn > 0)) { touched = true; tTouch = t; }
    const gain = energy() - E0;
    if (trace && k % 6 === 0) trace.push(`${t.toFixed(3)} y ${v.com.y.toFixed(2)} vy ${v.vel.y.toFixed(2)} roll ${(Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3).toFixed(0)} w ${v.angVel.length().toFixed(1)} E+ ${(gain / 1000).toFixed(1)}kJ ` +
      v.wheels.map(w => `${(w.FnAvg / 1000).toFixed(0)}/${(w.pen * 100).toFixed(0)}`).join(' '));
    if (gain > maxGain) { maxGain = gain; tGain = t; }
    if (touched) {
      maxUp = Math.max(maxUp, v.vel.y);
      maxW = Math.max(maxW, v.angVel.length());
      comLow = Math.min(comLow, v.com.y);
      bounce = Math.max(bounce, v.com.y - comLow);
    }
  }
  if (trace) console.log(trace.join('\n'));
  const up = v.up.y;
  return `${process.env.CAR || 'defender'} slope ${slopeDeg}°, roll ${rollDeg}°, drop ${drop} m: energy gained ${(maxGain / 1000).toFixed(1)} kJ` +
    ` (${(maxGain / (m * G)).toFixed(2)} m of lift) at ${tGain.toFixed(2)} s, max upward speed ${maxUp.toFixed(2)} m/s, ` +
    `bounce ${bounce.toFixed(2)} m, max spin ${maxW.toFixed(1)} rad/s, ends ${up > 0.5 ? 'on wheels' : up < -0.5 ? 'on roof' : 'on side'}`;
}

const a = process.argv.slice(2);
if (a[0] === 'sweep') {
  for (const sl of [0, 20, 30, 40, 50]) console.log(run(sl, 0));
  for (const r of [30, 45, 60, 75, 90]) console.log(run(0, r));
} else console.log(run(+(a[0] ?? 30), +(a[1] ?? 0), +(a[2] ?? 0.5), +(a[3] ?? 4)));
