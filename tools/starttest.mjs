// Engine start from cold stop: crank, catch, flare, settle. Prints rpm, throttle, combustion torque.
//   node tools/starttest.mjs [auto|manual] [N|P|D]
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240, mode = process.argv[2] || 'auto', sel = process.argv[3] || 'P';
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
const n = 20, N = n + 1;
world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 200, y: 1, z: 200 }));
world.step();
const v = new Vehicle(RAPIER, world, makeCarParams('defender'), { position: { x: 0, y: 0.12, z: 0 }, surfaceAt: () => SURFACES.dirt });
const d = v.drivetrain, raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0 };
if (mode === 'manual') d.toggleMode(); else d.setSelector(sel);
for (let i = 0; i < 240 * 2; i++) { v.step(H, raw); world.step(); }
d.stopEngine();
for (let i = 0; i < 240 * 3; i++) { v.step(H, raw); world.step(); }
console.log('stopped, rpm', d.rpm.toFixed(0));
d.startEngine();
for (let i = 0; i < 240 * 4; i++) {
  v.step(H, raw); world.step();
  if (i % 6 === 0) console.log(`${(i * H).toFixed(3)} rpm ${d.rpm.toFixed(0).padStart(5)} crank ${d.cranking ? 1 : 0} run ${d.running ? 1 : 0} thr ${d.thr.toFixed(2)} Tc ${d.Tcomb.toFixed(0)} idleInt ${d.idleInt.toFixed(0)}`);
}
