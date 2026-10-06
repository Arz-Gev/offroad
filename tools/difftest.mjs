// Torque split and the diffs on split grip, every car at its stock setup, full throttle from rest.
//   node tools/difftest.mjs [car ...]       (default: all cars in src/cars/)
// Traction control on, as the game starts; TC=0 switches it off (then the wheels on dirt spin up too).
// The ice follows the car (ahead of its middle, or right of its centreline), so it stays under the same wheels.
// split   full throttle from rest on dirt: the front axle's share of the drive torque (mean over 1-3 s)
// front   the front axle on ice, the rear on dirt: speed after 4 s (open centre: the front spins and the
//         rear gets no more than the front can take)
// side    the right wheels on ice: speed after 4 s (open axle diffs: each axle's right wheel spins)
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { CAR_IDS } from '../src/cars/index.js';
import { SURFACES } from '../src/vehicle/tire.js';
import { useCar, applySetup, STOCK, clone } from '../src/vehicle/tuning.js';
await RAPIER.init();

const H = 1 / 240;
const ICE = { ...SURFACES.concrete, name: 'Ice', mu: 0.1, dust: 0 };
const cars = process.argv.slice(2).length ? process.argv.slice(2) : CAR_IDS;

function world() {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  w.timestep = H;
  const n = 200, N = n + 1;
  w.createCollider(RAPIER.ColliderDesc.heightfield(n, n, new Float32Array(N * N), { x: 400, y: 1, z: 400 }).setFriction(0.8));
  w.step();
  return w;
}
function drive(id, iceAt, secs, each) {
  useCar(id);
  const P = applySetup(makeCarParams(id), clone(STOCK));
  const w = world();
  let v = null;
  const rel = (p, dir) => (p.x - v.pos.x) * dir.x + (p.y - v.pos.y) * dir.y + (p.z - v.pos.z) * dir.z;
  v = new Vehicle(RAPIER, w, P, { position: { x: 0, y: 0.1, z: 0 }, surfaceAt: (col, p) => (v && iceAt(p, v, rel) ? ICE : SURFACES.dirt) });
  v.tc = process.env.TC !== '0';
  const d = v.drivetrain;
  const inp = throttle => ({ throttle, brake: 0, steer: 0, clutch: 0, handbrake: 0 });
  for (let i = 0; i < 240; i++) { v.step(H, inp(0)); w.step(); }   // settle
  if (d.mode === 'manual') d.manualGear = 1;
  for (let i = 0; i < secs / H; i++) { v.step(H, inp(1)); w.step(); each?.(i * H, v); }
  return v;
}

for (const id of cars) {
  let f = 0, t = 0;
  const half = n => (v, a) => a < n / 2;
  drive(id, () => false, 3, (time, v) => {
    if (time < 1) return;
    const d = v.drivetrain, nA = v.axles.length, front = half(nA);
    for (let a = 0; a < nA; a++) { const T = d.axleDrive[a]; t += T; if (front(v, a)) f += T; }
  });
  const nA = makeCarParams(id).axles.length;
  // ice ahead of the middle (the front half of the axles), or under the right wheels
  const front = drive(id, (p, v, rel) => rel(p, v.fwd) > 0, 4).speed * 3.6;
  const side = drive(id, (p, v, rel) => rel(p, v.right) > 0, 4).speed * 3.6;
  console.log(`${id.padEnd(9)} split ${(100 * f / t).toFixed(1)} % front${nA > 2 ? ' half' : ''}   front on ice ${front.toFixed(1)} km/h   right side on ice ${side.toFixed(1)} km/h`);
}
