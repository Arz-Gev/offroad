// Steep ramps with sharp edges: flat ground, a ramp of 25-40 deg (concrete, mu 0.98; SURF=dirt|grass|rock), then a plateau.
// The truck crawls up in low range with everything locked. Reports whether it reaches the top and which
// collision boxes touched the ground on the way (bottom edge: approach / departure, top edge: breakover).
//   node tools/ramptest.mjs [old|new|both] [deg,deg,...]     TUNE='{"tyres":{"size":35}}' for a setup
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { SURFACES } from '../src/vehicle/tire.js';
import { STOCK, sanitize, applySetup, geometry } from '../src/vehicle/tuning.js';
import { touchPoints } from '../src/vehicle/colliderView.js';
await RAPIER.init();

// the chassis boxes before the Oct 3 fit to the visible model (the invisible nose)
const OLD = [
  [0, 1.30, 0.78, 0.89, 0.66, 1.62, 0.06], [0, 0.985, -1.42, 0.87, 0.395, 0.70, 0.06], [0, 0.62, -2.21, 0.96, 0.16, 0.13, 0.03],
  [0, 0.66, 2.44, 0.93, 0.14, 0.09, 0.03], [0, 0.52, 0.05, 0.42, 0.09, 2.15, 0.03], [0, 2.20, 0.70, 0.84, 0.13, 1.58, 0.03], [0, 1.18, 2.62, 0.36, 0.38, 0.15, 0.06],
];
const OLD_NAMES = ['Cabin / rear body', 'Engine bay', 'Front bumper', 'Rear bumper', 'Chassis rails', 'Roof rack', 'Spare wheel'];
const H = 1 / 240;
const which = process.argv[2] || 'both';
const degs = (process.argv[3] || '25,30,35,38,40').split(',').map(Number);
const setup = sanitize(process.env.TUNE ? JSON.parse(process.env.TUNE) : STOCK);

function world(deg) {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  w.timestep = H;
  // rows along z (0.1 m), columns along x; flat for z > 0, ramp up to 3 m towards -z, then a plateau
  const nz = 600, nx = 16, sz = 60, sx = 16, rise = 3, tan = Math.tan(deg * Math.PI / 180);
  const hts = new Float32Array((nz + 1) * (nx + 1));
  for (let c = 0; c <= nx; c++) for (let r = 0; r <= nz; r++) {
    const z = -sz / 2 + (r / nz) * sz + 10;   // world z of this row (field centred at z = 10)
    hts[c * (nz + 1) + r] = z >= 0 ? 0 : Math.min(rise, -z * tan);
  }
  w.createCollider(RAPIER.ColliderDesc.heightfield(nz, nx, hts, { x: sx, y: 1, z: sz }).setTranslation(0, 0, 10).setFriction(0.9));
  w.step();
  return { w, rise };
}

function climb(deg, colliders, names) {
  const { w, rise } = world(deg);
  const P = applySetup(makeCarParams('defender'), setup);
  P.colliders = colliders;
  const v = new Vehicle(RAPIER, w, P, { position: { x: 0, y: 0.15 + (P.tire.radius - 0.42) + P.lift, z: 6 }, surfaceAt: () => SURFACES[process.env.SURF || 'concrete'] });
  const d = v.drivetrain;
  const raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0 };
  for (let i = 0; i < 240; i++) { v.step(H, raw); w.step(); }
  d.range = 'low'; d.centerLock = true; d.frontLock = true; d.rearLock = true;
  const touched = new Map();
  let t = 0, top = false, stuckT = 0, maxY = 0;
  raw.throttle = 0.55;
  while (t < 40) {
    v.step(H, raw); w.step(); t += H;
    v.chassisColliders.forEach((c, i) => {
      let pt = null;
      if (touchPoints(w, c, p => { pt = pt || p.clone(); }) > 0 && !touched.has(names[i])) touched.set(names[i], { first: t, z: v.pos.z, pt });
    });
    maxY = Math.max(maxY, v.pos.y);
    if (v.pos.z < -rise / Math.tan(deg * Math.PI / 180) - 5 && v.pos.y > rise - 0.3) { top = true; break; }
    if (Math.abs(v.speed) < 0.05) stuckT += H; else stuckT = 0;
    if (stuckT > 4) break;
  }
  w.free();
  const where = z => (z > -1 ? 'at the foot' : z > -rise / Math.tan(deg * Math.PI / 180) ? 'on the ramp' : 'at the crest');
  const hits = [...touched.entries()].map(([k, e]) => `${k} (${where(e.z)}${process.env.V ? ` t ${e.first.toFixed(2)} truck z ${e.z.toFixed(2)} at z ${e.pt.z.toFixed(2)} y ${e.pt.y.toFixed(2)}` : ''})`).join(', ') || 'nothing';
  return `${top ? 'TOP  ' : 'STUCK'} in ${t.toFixed(1)} s, climbed ${maxY.toFixed(2)}/${rise} m; body touched: ${hits}`;
}

const P0 = applySetup(makeCarParams('defender'), setup);
for (const [label, cols, names] of [['old', OLD, OLD_NAMES], ['new', P0.colliders, P0.colliderNames]]) {
  if (which !== 'both' && which !== label) continue;
  const Pg = applySetup(makeCarParams('defender'), setup); Pg.colliders = cols;
  const g = geometry(Pg, setup.tyres.pressF, setup.tyres.pressR);
  console.log(`=== ${label} colliders: approach ${g.approach.toFixed(1)}°, departure ${g.departure.toFixed(1)}°, breakover ${g.breakover.toFixed(1)}°`);
  for (const deg of degs) console.log(`${String(deg).padStart(3)}°  ${climb(deg, cols, names)}`);
}
