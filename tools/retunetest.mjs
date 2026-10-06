// Live retune stability: the truck parked on flat ground, then tyre size / lift / mass change while it
// stands (and while driving). Prints body height, peak vertical acceleration and the residual motion
// once settled: the truck must rise on its springs, not jump, and then stand still without shaking.
//   node tools/retunetest.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { STOCK, clone, applySetup } from '../src/vehicle/tuning.js';
await RAPIER.init();
const H = 1 / 240;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
const N = 61, heights = new Float32Array(N * N);
world.createCollider(RAPIER.ColliderDesc.heightfield(60, 60, heights, { x: 600, y: 1, z: 600 }));
world.step();
const setup = clone(STOCK);
const P = applySetup(makeCarParams('defender'), setup);
const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.15, z: 200 } });
const raw = o => ({ throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 1, ...o });
function run(secs, input = raw()) {
  let peak = 0, vrms = 0, n = 0, wrms = 0;
  const steps = Math.round(secs / H);
  for (let i = 0; i < steps; i++) {
    v.step(H, input); world.step();
    peak = Math.max(peak, Math.abs(v.accel.dot(v.up)));
    if (i > steps * 0.75) { vrms += v.vel.y ** 2; wrms += v.angVel.lengthSq(); n++; }
  }
  return { y: v.pos.y, peak, vrms: Math.sqrt(vrms / n), wrms: Math.sqrt(wrms / n) };
}
const show = (label, r) => console.log(label.padEnd(44), `y ${r.y.toFixed(3)}  peak |a_up| ${r.peak.toFixed(2)} m/s²  settled: v ${(r.vrms * 1000).toFixed(2)} mm/s  w ${(r.wrms * 1000).toFixed(2)} mrad/s  pitch ${(Math.asin(v.fwd.y) * 57.3).toFixed(2)}°`);
const retune = (f, opts) => { f(setup); applySetup(v.P, setup); v.retune(opts); };
show('stock, settle 4 s', run(4));
retune(s => { s.tyres.size = 35; });
show('35" (eases at 0.15 m/s)', run(4));
retune(s => { s.suspension.lift = 0.15; });
show('+15 cm lift', run(4));
retune(s => { s.tyres.size = 37; s.suspension.lift = 0.15; s.mass.roof = 250; s.mass.cargo = 600; });
show('37" + 15 cm + 850 kg load', run(5));
retune(s => { s.suspension.front.k = 20000; s.suspension.rear.k = 20000; s.suspension.front.rebound = 1600; s.suspension.rear.rebound = 1600; });
show('very soft springs + weak rebound', run(6));
retune(s => { s.suspension = clone(STOCK.suspension); s.suspension.lift = 0.15; });
show('springs back to stock at once', run(4));
retune(s => { s.mass = clone(STOCK.mass); });
show('850 kg load off at once', run(4));
retune(s => Object.assign(s, clone(STOCK)));
show('back to stock (37" + lift down)', run(5));
// while driving: 40 km/h, then 35" + lift mid-run
run(1, raw({ handbrake: 0 }));
for (let i = 0; i < 2400 && v.speed < 40 / 3.6; i++) { v.step(H, raw({ handbrake: 0, throttle: 0.7 })); world.step(); }
retune(s => { s.tyres.size = 35; s.suspension.lift = 0.1; s.engine.preset = 'works'; });
show('driving 40 km/h: 35" + 10 cm + 5.0 V8', run(3, raw({ handbrake: 0, throttle: 0.3 })));
console.log('speed', (v.speed * 3.6).toFixed(1), 'km/h');
// colliders rebuilt while parked
run(4, raw({ brake: 1, handbrake: 1 }));
retune(s => { s.colliders[2].box[1] += 0.05; s.colliders[4].box[4] -= 0.02; }, { colliders: true });
show('collider edit while parked', run(2, raw({ brake: 1, handbrake: 1 })));
