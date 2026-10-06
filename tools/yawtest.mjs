// High-speed yaw balance on flat ground: steady speed, a small fixed road-wheel angle, then lift off.
//   node tools/yawtest.mjs [surface] [kmh] [deg] ['{"tune json"}']
// Prints, every 0.5 s: lateral g, yaw rate vs the kinematic (no-slip) yaw rate, body slip angle,
// front / rear axle slip angles. Rear slip > front slip = oversteer; slip angle growing after the lift = spin.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { useCar, applySetup, STOCK, clone } from '../src/vehicle/tuning.js';
// CAR=gclass|lancia: that car at its stock setup (default: params.js, the baselines)
const carParams = () => { if (!process.env.CAR) return makeCarParams('defender'); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240;
const surf = process.argv[2] || 'dirt', kmh = +(process.argv[3] || 90), deg = +(process.argv[4] || 3);
const tweak = process.argv[5] ? JSON.parse(process.argv[5]) : null;
const P = carParams();
if (tweak) {
  if (tweak.arbF != null) P.axles[0].arb = tweak.arbF;
  if (tweak.arbR != null) P.axles[1].arb = tweak.arbR;
  if (tweak.comZ != null) P.com[2] = tweak.comZ;
  if (tweak.Iy != null) P.bodyInertia[1] = tweak.Iy;
  if (tweak.K != null) P.steer.stiffness = tweak.K;
  if (tweak.rs != null) P.axles[1].rollSteer = tweak.rs;
}
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
const n = 200, N = n + 1;
world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 3000, y: 1, z: 3000 }));
world.step();
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.12, z: 1300 }, surfaceAt: () => SURFACES[surf] });
const L = P.wheelbase;
const d = deg / 57.3;
let lastPrint = -1;
console.log(`${surf} ${kmh} km/h, road wheel ${deg} deg${tweak ? ' ' + JSON.stringify(tweak) : ''}`);
console.log('  t   phase   km/h  lat g  yaw  yawKin  beta  aF    aR    (deg, deg/s)');
for (let i = 0; i < 240 * 22; i++) {
  const t = i * H, ph = t - 12;
  const sp = v.speed * 3.6;
  const lift = ph > 4;
  const thr = lift ? 0 : Math.max(0, Math.min(1, (kmh - sp) * 0.3 + 0.2));
  const vv = Math.abs(v.speed), lim = 1 / (1 + Math.max(0, vv - 8) / 30);
  const steer = ph > 0 ? Math.min(1, ph / 0.4) * d / (P.steer.maxAngle * lim) : 0;
  v.step(H, { throttle: thr, brake: 0, steer, clutch: 0, handbrake: 0, analogSteer: true });
  world.step();
  if (v.up.y < 0.4) { console.log('ROLLED'); break; }
  if (ph > -0.5 && Math.floor(ph * 2) !== lastPrint) {
    lastPrint = Math.floor(ph * 2);
    const vx = v.vel.dot(v.fwd), vy = v.vel.dot(v.right), r = v.angVel.dot(v.up); // r > 0 = left turn
    const beta = Math.atan2(vy, Math.abs(vx));
    // slip angles from the contact points (positive = tyre pushed towards the inside of a right turn)
    const sa = w => Math.atan2(w.vcy, Math.abs(w.vcx)) * 57.3;
    const af = (sa(v.wheels[0]) + sa(v.wheels[1])) / 2, ar = (sa(v.wheels[2]) + sa(v.wheels[3])) / 2;
    const kin = -vx * Math.tan(v.steerAngle) / L * 57.3;
    console.log(`${ph.toFixed(1).padStart(5)} ${(ph < 0 ? 'straight' : lift ? 'LIFT' : 'steer').padEnd(8)}${sp.toFixed(0).padStart(4)} ${(v.accel.dot(v.right) / 9.81).toFixed(2).padStart(6)} ${(r * 57.3).toFixed(1).padStart(6)} ${kin.toFixed(1).padStart(6)} ${(beta * 57.3).toFixed(1).padStart(6)} ${af.toFixed(1).padStart(5)} ${ar.toFixed(1).padStart(5)}`);
    if (Math.abs(beta) > 1.2) { console.log('SPUN'); break; }
  }
}
