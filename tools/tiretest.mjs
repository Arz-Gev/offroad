// Tyre over an obstacle (tyre v2: the tyre wraps around rocks and edges). One front wheel of a car rolls
// over a rock (a half-buried round boulder, cylinder across the path) or a square step, on flat dirt,
// at a crawl and at speed. Reports, while that wheel is on the obstacle: the peak load, how many rays carry
// it (how much of the tyre wraps round the obstacle), the contact normal's tilt (how early the wheel
// starts to climb), time with the rim on the obstacle, and the body's peak vertical acceleration.
//   node tools/tiretest.mjs [rock|step] [kmh] [psi]      CAR=btr80 for another car
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { makeCarParams } from '../src/vehicle/carSpecs.js';
import { useCar, applySetup, STOCK, clone } from '../src/vehicle/tuning.js';
await RAPIER.init();
const H = 1 / 240;
const [kind = 'rock', kmh = '5', psiArg] = process.argv.slice(2);
const carParams = () => { if (!process.env.CAR) return makeDefenderParams(); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
const n = 100, N = n + 1;
world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 400, y: 1, z: 400 }).setFriction(0.8));
const P = carParams();
const xL = -P.track / 2, size = P.tire.radius / 0.42;   // under the left wheels; obstacles scale with the tyre
const zObs = -20;
if (kind === 'rock') {
  // a boulder 0.4 m across (x tyre size), sticking out 0.16 m: cylinder axis along x, centre below ground
  const r = 0.2 * size, top = 0.16 * size;
  world.createCollider(RAPIER.ColliderDesc.cylinder(0.3 * size, r).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
    .setTranslation(xL, top - r, zObs).setFriction(0.9));
} else {
  // a square step 0.15 m high (x tyre size), 1.2 m long, under the left wheels only
  const hgt = 0.15 * size;
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.4 * size, hgt / 2, 0.6).setTranslation(xL, hgt / 2, zObs - 0.6).setFriction(0.9));
}
world.step();
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
if (psiArg) v.pressures = [+psiArg, +psiArg];
const raw = o => ({ throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, ...o });
for (let i = 0; i < 2 / H; i++) { v.step(H, raw()); world.step(); }
v.drivetrain.range = 'low';
const target = +kmh / 3.6;
const w = v.wheels[0];
const rimLim = (v.R - P.tire.rimRadius * v.R / P.tire.radius) * 0.62;
let peakFn = 0, peakRays = 0, peakTilt = 0, rimTime = 0, peakAcc = 0, onTime = 0, maxPen = 0, lastVy = v.vel.y;
for (let i = 0; i < 40 / H; i++) {
  const thr = Math.max(0, Math.min(1, (target - v.speed) * 2 + 0.25));
  v.step(H, raw({ throttle: thr, brake: v.speed > target * 1.3 ? 0.3 : 0 }));
  world.step();
  const acc = Math.abs(v.vel.y - lastVy) / H; lastVy = v.vel.y;
  const near = Math.abs(w.hub.z - zObs) < 0.9 * size + (kind === 'step' ? 0.6 : 0);
  if (near) {
    onTime += H;
    peakFn = Math.max(peakFn, w.FnAvg);
    const rays = w.rayPen ? Array.from(w.rayPen).filter(x => x > 0.002).length : 0;
    peakRays = Math.max(peakRays, rays);
    // tilt of the contact normal from the body's up, fore-aft (positive = pushing the wheel back and up)
    peakTilt = Math.max(peakTilt, Math.acos(Math.min(1, w.n.dot(v.up))) * 57.3);
    if (w.pen > rimLim) rimTime += H;
    maxPen = Math.max(maxPen, w.pen);
    peakAcc = Math.max(peakAcc, acc);
  }
  if (v.wheels[2].hub.z < zObs - 2) break;
}
console.log(`${process.env.CAR || 'defender'} ${kind} at ${kmh} km/h${psiArg ? `, ${psiArg} psi` : ''}: peak load ${(peakFn / 1000).toFixed(1)} kN, rays loaded ${peakRays}/39, ` +
  `normal tilt ${peakTilt.toFixed(1)}°, deepest ${(maxPen * 100).toFixed(1)} cm, rim on it ${(rimTime * 1000).toFixed(0)} ms, body vertical accel peak ${peakAcc.toFixed(1)} m/s², over in ${onTime.toFixed(2)} s`);
