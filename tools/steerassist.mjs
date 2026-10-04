// Keyboard steering assist: hold the steering key at speed on flat ground, per surface and assist mode.
//   node tools/steerassist.mjs [surfaces] [modes] [speeds]    e.g. dirt,grass strong,light 60,90
// Prints the grip estimate, the wheel angle the held key reaches, the lateral g it settles at, body slip,
// front / rear slip angles, and spins / rollovers (4 s held, then 3 s released). FULL=1 floors the gas meanwhile.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { makeCarParams } from '../src/vehicle/carSpecs.js';
import { useCar, applySetup, STOCK, clone } from '../src/vehicle/tuning.js';
// CAR=gclass|lancia: that car at its stock setup (default: params.js, the baselines)
const carParams = () => { if (!process.env.CAR) return makeDefenderParams(); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240;
const surfs = (process.argv[2] || 'dirt,grass,mud,concrete').split(',');
const modes = (process.argv[3] || 'strong,light,off').split(',');
const speeds = (process.argv[4] || '40,60,90,110').split(',').map(Number);
function keyRamp(st, key) { // same ramp as src/input.js
  const rate = key === 0 ? 3.2 : (Math.sign(key) !== Math.sign(st.s) && st.s !== 0 ? 4.5 : 2.0);
  st.s += Math.max(-rate * H, Math.min(rate * H, key - st.s));
  return st.s;
}
for (const surf of surfs) for (const mode of modes) for (const kmh of speeds) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
  const n = 200, N = n + 1;
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 3000, y: 1, z: 3000 }));
  world.step();
  const v = new Vehicle(RAPIER, world, carParams(), { position: { x: 0, y: 0.12, z: 1300 }, surfaceAt: () => SURFACES[surf] });
  v.steerAssist = mode;
  const st = { s: 0 };
  let ay = 0, cnt = 0, maxBeta = 0, rolled = false, lift = 0, betaEnd = 0, ang = 0;
  for (let i = 0; i < 240 * 21; i++) {
    const t = i * H, ph = t - 14;
    const key = ph > 0 && ph < 4 ? 1 : 0;
    const sp = v.speed * 3.6;
    // FULL=1: W held to the floor while the steering key is held (the speed is reached first)
    const thr = ph > 0 && ph < 4 && process.env.FULL ? 1 : Math.max(0, Math.min(1, (kmh - sp) * 0.3 + 0.2));
    v.step(H, { throttle: thr, brake: 0, steer: keyRamp(st, key), clutch: 0, handbrake: 0, analogSteer: false });
    world.step();
    if (v.up.y < 0.4) { rolled = true; break; }
    if (ph > 0) {
      const vx = v.vel.dot(v.fwd), vy = v.vel.dot(v.right);
      const beta = Math.abs(Math.atan2(vy, Math.abs(vx))) * 57.3;
      maxBeta = Math.max(maxBeta, beta);
      if (Math.min(...v.wheels.map(w => w.FnAvg)) <= 0) lift += H;
      if (ph > 2 && ph < 4) { ay += Math.abs(v.accel.dot(v.right)) / 9.81; cnt++; ang = v.steerAngle * 57.3; }
      betaEnd = beta;
      if (process.env.TRACE && i % 48 === 0) {
        const sa = w => Math.atan2(w.vcy, Math.abs(w.vcx)) * 57.3;
        console.log(`   ${ph.toFixed(1)} key ${key} thr ${thr.toFixed(2)} km/h ${sp.toFixed(0)} wheel ${(v.steerAngle * 57.3).toFixed(1)} ay ${(v.accel.dot(v.right) / 9.81).toFixed(2)} yaw ${(v.angVel.dot(v.up) * 57.3).toFixed(1)} beta ${(Math.atan2(vy, Math.abs(vx)) * 57.3).toFixed(1)} aF ${((sa(v.wheels[0]) + sa(v.wheels[1])) / 2).toFixed(1)} aR ${((sa(v.wheels[2]) + sa(v.wheels[3])) / 2).toFixed(1)} gear ${v.drivetrain.gearLabel()} Fn ${v.wheels.map(w => (w.FnAvg / 1000).toFixed(1)).join(',')}`);
      }
    }
  }
  const sa = w => Math.abs(Math.atan2(w.vcy, Math.abs(w.vcx))) * 57.3;
  console.log(`${surf.padEnd(9)}${mode.padEnd(7)}${String(kmh).padStart(4)} km/h  grip ${v.gripG.toFixed(2)} g  wheel ${ang.toFixed(1).padStart(5)}°  held ${(ay / Math.max(cnt, 1)).toFixed(2)} g  max slip ${maxBeta.toFixed(1).padStart(5)}°  after release ${betaEnd.toFixed(1).padStart(5)}°  lift ${lift.toFixed(2)} s${rolled ? '  ROLLED' : ''}${betaEnd > 30 ? '  SPUN' : ''}`);
}
