// Ride check on a synthetic road: flat, then a cosine bump across the road (or under one side only).
//   node tools/bumptest.mjs [kmh=40] [height=0.10] [length=1.0] [side=both|left]
// Prints body heave / pitch / roll and wheel loads every 50 ms after the front axle hits the bump.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
await RAPIER.init();
const kmh = +(process.argv[2] || 40), bh = +(process.argv[3] || 0.10), bl = +(process.argv[4] || 1.0), side = process.argv[5] || 'both';
const H = 1 / 240, size = 400, n = 1600, N = n + 1;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
const heights = new Float32Array(N * N);
const bz = -60; // bump centre (truck drives toward -z)
for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
  const x = -size / 2 + (c / n) * size, z = -size / 2 + (r / n) * size;
  const u = (z - bz) / bl;
  let h = Math.abs(u) < 0.5 ? bh * 0.5 * (1 + Math.cos(2 * Math.PI * u)) : 0;
  if (side === 'left' && x > 0) h = 0;
  heights[c * N + r] = h;
}
world.createCollider(RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }));
world.step();
const P = makeDefenderParams();
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.12, z: 40 } });
const ctl = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, ...o });
// settle then accelerate to speed, then hold speed with a simple P controller
let hit = null, y0 = 0;
const log = [];
let maxAir = 0, air = 0, minFn = 1e9, maxFn = 0, peakAz = 0;
for (let i = 0; i < 240 * 30; i++) {
  const sp = v.speed * 3.6;
  const thr = Math.max(0, Math.min(1, (kmh - sp) * 0.25 + 0.15));
  v.step(H, ctl({ throttle: i < 240 ? 0 : thr, brake: sp > kmh + 3 ? 0.3 : 0, analogSteer: true, steer: Math.max(-1, Math.min(1, -v.pos.x * 0.3 + (v.yaw()) * 2)) }));
  world.step();
  const frontZ = v.pos.z - 1.397;
  if (!hit && frontZ < bz + bl) { hit = i; y0 = v.pos.y; }
  if (hit) {
    const t = (i - hit) * H;
    const pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd.y))) * 57.3, roll = Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3;
    const a = v.wheels.filter(w => !(w.FnAvg > 0)).length;
    if (a) air += H; maxAir = Math.max(maxAir, a);
    for (const w of v.wheels) { minFn = Math.min(minFn, w.FnAvg); maxFn = Math.max(maxFn, w.FnAvg); }
    peakAz = Math.max(peakAz, Math.abs(v.accel.dot(v.up)));
    if ((i - hit) % 12 === 0) log.push(`t=${t.toFixed(2)} dy=${((v.pos.y - y0) * 100).toFixed(1)}cm pitch=${pitch.toFixed(1)} roll=${roll.toFixed(1)} c=[${v.axles.map(a => (a.c * 100).toFixed(1)).join(',')}]cm Fn=[${v.wheels.map(w => (w.FnAvg / 1000).toFixed(1)).join(',')}] ${sp.toFixed(0)}km/h`);
    if (t > 3) break;
  }
}
console.log(`bump ${bh * 100} cm x ${bl} m (${side}) at ${kmh} km/h`);
console.log(log.join('\n'));
console.log(`time with a wheel in the air ${air.toFixed(2)} s, max wheels in air ${maxAir}, Fn range ${(minFn / 1000).toFixed(1)}..${(maxFn / 1000).toFixed(1)} kN, peak raw vertical accel ${peakAz.toFixed(0)} m/s2`);
