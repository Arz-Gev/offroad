// Handbrake hold test: flat ground (or a slope), engine running, handbrake held, varying throttle.
//   node tools/hbtest.mjs [deg=0]
// Prints metres moved in 6 s per gearbox / centre diff / throttle setting.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240, deg = +(process.argv[2] || 0);
function run(thr, setup) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
  const n = 200, N = n + 1, size = 200, tan = Math.tan(deg * Math.PI / 180), heights = new Float32Array(N * N);
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) heights[c * N + r] = -(-size / 2 + r / n * size) * tan;
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }));
  world.step();
  const a = deg * Math.PI / 180;
  const v = new Vehicle(RAPIER, world, makeCarParams('defender'), { position: { x: 0, y: 0.25, z: 0 }, surfaceAt: () => SURFACES.dirt });
  v.body.setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, true);
  v.readBody(); v.updateGeometry();
  setup(v.drivetrain);
  for (let i = 0; i < 240; i++) { v.step(H, { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 1, analogSteer: true }); world.step(); }
  const z0 = v.pos.z;
  for (let i = 0; i < 240 * 6; i++) { v.step(H, { throttle: thr, brake: 0, steer: 0, clutch: 0, handbrake: 1, analogSteer: true }); world.step(); }
  return (z0 - v.pos.z).toFixed(2);
}
const cfg = {
  'auto D open': d => { d.selector = 'D'; },
  'auto D ctrlock': d => { d.selector = 'D'; d.centerLock = true; },
  'manual 1st open': d => { d.mode = 'manual'; d.manualGear = 1; d.updateInertia(); },
};
console.log(`handbrake held, ${deg} deg slope: metres moved forward in 6 s`);
for (const [k, f] of Object.entries(cfg)) console.log(k.padEnd(16), [0, 0.3, 1].map(t => `thr ${t}: ${run(t, f).padStart(6)}`).join('   '));
