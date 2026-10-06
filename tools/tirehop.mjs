// Wheel hop: how the tyre itself damps a hit. A car drives straight on flat dirt over a short sharp bump
// (a half-buried log across the road, 6 cm x tyre size) or a washboard stretch (ridges 4 cm every
// 0.7 m), at a set speed and pressure. Reports for the front left wheel: peak load, time in the air, how
// many times its load swings past ±25 % of static after the hit (wheel hop that the tyre doesn't damp),
// the time to settle within ±10 %, and the body's vertical acceleration (rms over the run, peak).
//   node tools/tirehop.mjs [bump|wash] [kmh] [psi]      CAR=btr80 for another car
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { makeCarParams } from '../src/vehicle/carSpecs.js';
import { useCar, applySetup, STOCK, clone } from '../src/vehicle/tuning.js';
await RAPIER.init();
const H = 1 / 240;
const [kind = 'bump', kmh = '30', psiArg] = process.argv.slice(2);
const carParams = () => { if (!process.env.CAR) return makeDefenderParams(); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
const n = 100, N = n + 1;
world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 600, y: 1, z: 600 }).setFriction(0.8));
const P = carParams();
const size = P.tire.radius / 0.42;
const zObs = -40;
// a log across the whole road (the truck drifts a little without steering): cylinder axis along x, radius r,
// centre so that it sticks out `top`
const log = (z, r, top) => world.createCollider(RAPIER.ColliderDesc.cylinder(3, r)
  .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }).setTranslation(0, top - r, z).setFriction(0.9));
if (kind === 'bump') log(zObs, 0.08 * size, 0.06 * size);
else for (let i = 0; i < 40; i++) log(zObs - i * 0.7, 0.12, 0.04);
world.step();
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.1, z: 0 } });
if (psiArg) v.pressures = [+psiArg, +psiArg];
const raw = o => ({ throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, ...o });
for (let i = 0; i < 2 / H; i++) { v.step(H, raw()); world.step(); }
const target = +kmh / 3.6;
const w = v.wheels[0];
let Fs = 0, nFs = 0, peak = 0, air = 0, swings = 0, lastSide = 0, settle = 0, tHit = -1, t = 0;
let accSq = 0, accN = 0, accPeak = 0, lastVy = v.vel.y;
const zEnd = kind === 'bump' ? zObs - 0.3 : zObs - 39 * 0.7 - 0.3;
for (let i = 0; i < 60 / H; i++) {
  const thr = Math.max(0, Math.min(1, (target - v.speed) * 2 + 0.25));
  v.step(H, raw({ throttle: thr, brake: v.speed > target * 1.15 ? 0.3 : 0 }));
  world.step();
  t += H;
  const acc = (v.vel.y - lastVy) / H; lastVy = v.vel.y;
  const z = w.hub.z;
  if (z > zObs + 3) { if (z < zObs + 8) { Fs += w.FnAvg; nFs++; } continue; }   // static load on the run-in
  const F0 = Fs / Math.max(1, nFs);
  if (tHit < 0 && z < zObs + 0.6) tHit = t;
  if (tHit < 0) continue;
  accSq += acc * acc; accN++; accPeak = Math.max(accPeak, Math.abs(acc));
  peak = Math.max(peak, w.FnAvg);
  if (w.FnAvg <= 0) air += H;
  if (z < zEnd) {
    // after the obstacle: count the swings of the load and when it stays within ±10 %
    const d = (w.FnAvg - F0) / F0, side = d > 0.25 ? 1 : d < -0.25 ? -1 : 0;
    if (side && side !== lastSide) { swings++; lastSide = side; }
    if (Math.abs(d) > 0.1) settle = t - tHit;
    if (z < zEnd - 25) break;
  }
}
console.log(`${process.env.CAR || 'defender'} ${kind} at ${kmh} km/h${psiArg ? `, ${psiArg} psi` : ''}: peak load ${(peak / 1000).toFixed(1)} kN ` +
  `(static ${(Fs / Math.max(1, nFs) / 1000).toFixed(1)}), in the air ${(air * 1000).toFixed(0)} ms, load swings after ${swings}, ` +
  `settled ${settle.toFixed(2)} s, body vertical accel rms ${Math.sqrt(accSq / Math.max(1, accN)).toFixed(2)} peak ${accPeak.toFixed(1)} m/s²`);
