// Hard landings on the real map: drops the truck at random spots level from 1 m over the highest ground
// under its corners (R's fallback when every spot near it is blocked, and how R worked before Oct 8),
// random yaw, or on its side (ROLL=90, from 0.5 m), and lets
// it settle with the handbrake on for 5 s. A drop can only lose energy, so the report is the most energy the
// body won back over its lowest so far (springs and tyres hand back a little, a kick hands back a lot), the
// highest upward speed and spin, the peak tyre load and how it ended up. Worst spots first.
//   node tools/resettest.mjs [count=60] [seed=1]      ROLL=90 on its side, CAR=btr80 another car
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { useCar, applySetup, STOCK, clone, rideRaise } from '../src/vehicle/tuning.js';
import { Terrain } from '../src/world/terrain.js';
import { buildProps } from '../src/world/props.js';
await RAPIER.init();
const H = 1 / 240, G = 9.81;
const count = +(process.argv[2] || 60);
let seed = +(process.argv[3] || 1);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const roll = +(process.env.ROLL || 0) * Math.PI / 180;
const carParams = () => { if (!process.env.CAR) return makeCarParams('defender'); useCar(process.env.CAR); return applySetup(makeCarParams(), clone(STOCK)); };

const world = new RAPIER.World({ x: 0, y: -G, z: 0 }); world.timestep = H;
const terrain = new Terrain();
terrain.createCollider(RAPIER, world);
const colliderSurface = new Map();
buildProps(RAPIER, world, terrain, colliderSurface, null);
world.step();
const surfaceAt = (col, p) => (col && colliderSurface.get(col.handle)) || terrain.surfaceAt(p.x, p.z);
const P = carParams();
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: terrain.heightAt(0, 46) + 1, z: 46 }, surfaceAt });
const m = v.totalMass, I = P.bodyInertia;
const energy = () => {
  const w = v.angVel.clone().applyQuaternion(v.quat.clone().invert());
  return 0.5 * m * v.vel.lengthSq() + 0.5 * (I[0] * w.x * w.x + I[1] * w.y * w.y + I[2] * w.z * w.z) + m * G * v.com.y;
};
const raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 1 };
const out = [];
for (let n = 0; n < count; n++) {
  const x = (rnd() - 0.5) * 700, z = (rnd() - 0.5) * 700, yaw = rnd() * 2 * Math.PI;
  let y = terrain.heightAt(x, z), slope = 0;
  const r0 = roll ? 2.5 : 0;
  for (const dx of [-1.5 - r0, 1.5 + r0]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
  { const e = 2, gx = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e), gz = (terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)) / (2 * e); slope = Math.atan(Math.hypot(gx, gz)) * 57.3; }
  v.reset({ x, y: y + (roll ? 0.5 : 1.0) + rideRaise(P) + (roll ? 0.9 : 0), z }, yaw);
  if (roll) {
    const q = v.quat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    v.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    v.readBody(); v.updateGeometry();
  }
  v.step(H, raw); world.step(); v.readBody();
  const E0 = energy();
  let gain = 0, tGain = 0, eMin = E0, maxUp = 0, maxW = 0, worstFn = 0, worstAt = '';
  for (let k = 0; k < 5 / H; k++) {
    v.step(H, raw); world.step(); v.readBody();
    const E = energy(); eMin = Math.min(eMin, E);
    const g = E - eMin;
    if (g > gain) { gain = g; tGain = (k + 1) * H; }
    maxUp = Math.max(maxUp, v.vel.y); maxW = Math.max(maxW, v.angVel.length());
    for (const w of v.wheels) if (w.FnAvg > worstFn) {
      worstFn = w.FnAvg;
      // the wheel's tilt to the ground under it: angle between the wheel plane's up and the contact normal
      // the wheel's tilt: angle between the wheel plane and the contact normal (0 = upright on the ground)
      worstAt = `wheel ${w.i} tilted ${(Math.asin(Math.min(1, Math.abs(w.n.dot(w.spinAxis)))) * 57.3).toFixed(0)}°, pen ${(w.pen * 100).toFixed(0)} cm`;
    }
  }
  const end = v.up.y > 0.5 ? 'wheels' : v.up.y < -0.5 ? 'roof' : 'side';
  out.push({ gain, line: `#${n} (${x.toFixed(0)}, ${z.toFixed(0)}) slope ${slope.toFixed(0)}°: won back ${(gain / 1000).toFixed(1)} kJ (${(gain / (m * G)).toFixed(2)} m) at ${tGain.toFixed(2)} s, up ${maxUp.toFixed(1)} m/s, spin ${maxW.toFixed(1)} rad/s, peak tyre ${(worstFn / 1000).toFixed(0)} kN (${worstAt}), ends on ${end}` });
}
out.sort((a, b) => b.gain - a.gain);
const bad = out.filter(o => o.gain > 0.1 * m * G);
console.log(`${process.env.CAR || 'defender'}${roll ? ' on its side' : ''}: ${bad.length}/${count} won back > 10 cm of lift`);
for (const o of out.slice(0, +(process.env.SHOW || 10))) console.log(o.line);
