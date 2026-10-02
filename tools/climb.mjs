// Climb from a standstill on a uniform slope (optionally with diagonal humps that unload wheels).
//   node tools/climb.mjs [surface=grass] [range=high|low] [humps=0|1]
// For each slope and diff setting: metres climbed in 12 s at full throttle (auto box).
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { SURFACES } from '../src/vehicle/tire.js';
await RAPIER.init();
const H = 1 / 240;
const surf = SURFACES[process.argv[2] || 'grass'], range = process.argv[3] || 'high', humps = +(process.argv[4] || 0);
function climb(deg, setup) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
  const n = 600, N = n + 1, size = 300, tan = Math.tan(deg * Math.PI / 180), heights = new Float32Array(N * N);
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
    const x = -size / 2 + c / n * size, z = -size / 2 + r / n * size;
    // diagonal humps 25 cm high, 5 m apart: alternately unload diagonal wheels (cross-axle)
    const hump = humps ? 0.25 * Math.max(0, Math.sin((x + z) * 2 * Math.PI / 5)) ** 2 : 0;
    heights[c * N + r] = -z * tan + hump;
  }
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }));
  world.step();
  const P = makeDefenderParams();
  const a = deg * Math.PI / 180;
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.25, z: 0 }, surfaceAt: () => surf });
  v.body.setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, true);
  v.readBody(); v.updateGeometry();
  const d = v.drivetrain; d.range = range; setup(d, v); if (process.env.NOTC) v.tc = false;
  const z0 = v.pos.z;
  for (let i = 0; i < 240 * 14; i++) {
    const t = i * H;
    v.step(H, { throttle: t < 2 ? 0 : 1, brake: 0, steer: 0, clutch: 0, handbrake: t < 2 ? 1 : 0, analogSteer: true });
    world.step();
    if (v.up.y < 0.4) return 'flip';
  }
  return (z0 - v.pos.z) / Math.cos(a);
}
const configs = {
  open: () => {},
  centre: d => { d.centerLock = true; },
  all: d => { d.centerLock = true; d.frontLock = true; d.rearLock = true; },
};
if (process.argv[5]) for (const k of Object.keys(configs)) if (!process.argv[5].split(',').includes(k)) delete configs[k];
console.log(`surface ${surf.name}, ${range} range${humps ? ', diagonal humps' : ''}: metres climbed in 12 s`);
for (const deg of [10, 15, 20, 25, 30, 35]) {
  const row = Object.entries(configs).map(([k, f]) => { const r = climb(deg, f); return `${k} ${typeof r === 'number' ? r.toFixed(1).padStart(5) : r.padStart(5)}`; });
  console.log(`${String(deg).padStart(2)} deg  ${row.join('   ')}`);
}
