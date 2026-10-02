// Headless ride / handling test on the real map: drives the main trail loop with a pure-pursuit driver
// and reports bounce, wheel lift, roll and rollovers.
//   node tools/traillap.mjs [kmh=60] [cornerG=0.45] [secs=90] [steer=analog|digital]
// "digital" mimics keyboard steering (full lock with the game's speed-sensitive limit, on/off).
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { Terrain } from '../src/world/terrain.js';
import { buildProps } from '../src/world/props.js';
await RAPIER.init();

const kmh = +(process.argv[2] || 60), cornerG = +(process.argv[3] || 0.45), secs = +(process.argv[4] || 90);
const digital = (process.argv[5] || 'analog') === 'digital';
const H = 1 / 240;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
const terrain = new Terrain();
if (process.env.BLUR) { // test only: smooth the heightfield (box blur, BLUR passes) to separate roughness from features
  const NN = terrain.NN, h = terrain.heights, t = new Float32Array(h.length);
  for (let pass = 0; pass < +process.env.BLUR; pass++) {
    for (let i = 1; i < NN - 1; i++) for (let j = 1; j < NN - 1; j++) {
      let a = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) a += h[(i + di) * NN + j + dj];
      t[i * NN + j] = a / 9;
    }
    for (let i = 1; i < NN - 1; i++) for (let j = 1; j < NN - 1; j++) h[i * NN + j] = t[i * NN + j];
  }
}
terrain.createCollider(RAPIER, world);
const colliderSurface = new Map();
buildProps(RAPIER, world, terrain, colliderSurface, null);
world.step();
const surfaceAt = (col, p) => (col && colliderSurface.get(col.handle)) || terrain.surfaceAt(p.x, p.z);

const curve = terrain.trailCurves[0];
const NP = 2000, pts = curve.getSpacedPoints(NP), seg = curve.getLength() / NP;
const start = pts[40], nxt = pts[48];
const yaw0 = Math.atan2(-(nxt.x - start.x), -(nxt.z - start.z));
const P = makeDefenderParams();
const v = new Vehicle(RAPIER, world, P, { position: { x: start.x, y: terrain.heightAt(start.x, start.z) + 0.15, z: start.z }, yaw: yaw0, surfaceAt });

let best = 40, key = 0, kSteer = 0;
function nearest() {
  let bi = best, bd = 1e9;
  for (let k = -60; k <= 200; k++) {
    const i = (best + k + NP) % NP, p = pts[i];
    const d = (p.x - v.pos.x) ** 2 + (p.z - v.pos.z) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  best = bi; return Math.sqrt(bd);
}
function driver() {
  const off = nearest();
  const tgt = pts[(best + Math.round(Math.max(8, Math.abs(v.speed) * 0.9) / seg)) % NP];
  let turn = 0;
  for (let k = 20; k < 160; k += 20) {
    const a = pts[(best + k) % NP], b = pts[(best + k + 20) % NP], c = pts[(best + k + 40) % NP];
    let dh = Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z);
    while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    turn = Math.max(turn, Math.abs(dh) / (20 * seg));
  }
  const target = Math.min(kmh, Math.sqrt(cornerG * 9.81 / Math.max(turn, 1e-3)) * 3.6);
  const dx = tgt.x - v.pos.x, dz = tgt.z - v.pos.z;
  const ang = Math.atan2(dx * v.right.x + dz * v.right.z, dx * v.fwd.x + dz * v.fwd.z);
  let steer = Math.max(-1, Math.min(1, ang * 2.0));
  if (digital) {
    // keyboard player: press when the heading error is clear, release near the line,
    // with the same key ramp as src/input.js
    if (Math.abs(ang) > 0.07) key = Math.sign(ang); else if (Math.abs(ang) < 0.025 || Math.sign(ang) !== key) key = 0;
    const rate = key === 0 ? 3.2 : (Math.sign(key) !== Math.sign(kSteer) && kSteer !== 0 ? 4.5 : 2.0);
    kSteer += Math.max(-rate * H, Math.min(rate * H, key - kSteer));
    steer = kSteer;
  }
  const sp = v.speed * 3.6;
  return { off, inp: { throttle: sp < target ? 0.8 : 0, brake: sp > target + 6 ? 0.6 : 0, steer, clutch: 0, handbrake: 0, analogSteer: !digital } };
}

const st = { n: 0, air: [0, 0, 0, 0], anyAir: 0, allAir: 0, az2: 0, azMax: 0, rollMax: 0, rolls: 0, spd: 0, offTrail: 0, latG: 0, bumpStop: 0, spikes: 0 };
const steps = Math.round(secs / H);
let lastUp = 0, lastSpike = -1e9, azf = 0, latf = 0;
for (let i = 0; i < steps; i++) {
  const { off, inp } = driver();
  v.step(H, inp);
  world.step();
  if (process.env.TRACE && i % 60 === 0) console.log(`t=${(i * H).toFixed(2)} idx=${best} off=${off.toFixed(1)} ${(v.speed * 3.6).toFixed(0)}km/h steer=${inp.steer.toFixed(2)} wheel=${(v.steerAngle * 57.3).toFixed(1)}deg yawRate=${(v.angVel.dot(v.up) * 57.3).toFixed(0)}deg/s latG=${(v.accel.dot(v.right) / 9.81).toFixed(2)} roll=${(Math.asin(v.right.y) * 57.3).toFixed(1)} Fy=[${v.wheels.map(w => (w.Fy / 1000).toFixed(1)).join(',')}] slipF=${v.wheels.slice(0, 2).map(w => w.slipNorm.toFixed(1)).join(',')}`);
  if (i < 240) continue; // settle
  st.n++;
  let a = 0;
  v.wheels.forEach((w, j) => { if (!(w.FnAvg > 0)) { st.air[j]++; a++; } });
  if (a) st.anyAir++; if (a === 4) st.allAir++;
  const azRaw = v.accel.dot(v.up) + 9.81 * v.up.y;
  if (Math.abs(azRaw) > 80 && i - lastSpike > 120) {
    lastSpike = i;
    const hits = [];
    for (let k = 0; k < v.body.numColliders(); k++) {
      const c = v.body.collider(k);
      world.contactPairsWith(c, other => {
        world.contactPair(c, other, (m) => { if (m.numContacts() > 0) hits.push(k + (v.wheels.some(w => w.sideCollider === c) ? 'w' : 'b') + ':' + (m.contactDist(0) * 100).toFixed(1)); });
      });
    }
    const body = hits.join(' ');
    if (st.spikes++ < 8) console.log(`  spike ${azRaw.toFixed(0)} m/s2 at t=${(i * H).toFixed(2)} ${(v.speed * 3.6).toFixed(0)} km/h, body contacts ${body}, Fn [${v.wheels.map(w => (w.FnAvg / 1000).toFixed(1)).join(',')}] kN`);
  }
  azf += (azRaw - 9.81 * v.up.y - azf) * Math.min(1, H / 0.02);   // ~8 Hz low-pass: what the occupants feel
  st.az2 += azf * azf; st.azMax = Math.max(st.azMax, Math.abs(azf));
  const roll = Math.asin(Math.max(-1, Math.min(1, v.right.y))) * 57.3;
  st.rollMax = Math.max(st.rollMax, Math.abs(roll));
  st.spd += v.speed; if (off > 3.5) st.offTrail++;
  latf += (v.accel.dot(v.right) - latf) * Math.min(1, H / 0.1);
  st.latG = Math.max(st.latG, Math.abs(latf) / 9.81);
  for (const ax of v.axles) for (let s = 0; s < 2; s++) {
    const comp = ax.c + (s ? 1 : -1) * ax.p.springTrack / 2 * Math.sin(ax.phi);
    if (comp > ax.p.travel - 0.05) st.bumpStop++;
  }
  if (v.up.y < 0.35 && i - lastUp > 240) {
    st.rolls++; lastUp = i;
    const p = pts[(best + 10) % NP], q = pts[(best + 18) % NP];
    console.log(`  rollover at t=${(i * H).toFixed(1)} s near trail index ${best}, ${(Math.abs(v.speed) * 3.6).toFixed(0)} km/h`);
    v.reset({ x: p.x, y: terrain.heightAt(p.x, p.z) + 0.3, z: p.z }, Math.atan2(-(q.x - p.x), -(q.z - p.z)));
  }
}
const pc = x => (100 * x / st.n).toFixed(1) + '%';
console.log(`trail ${kmh} km/h cap, corner ${cornerG} g, ${digital ? 'digital' : 'analog'} steering, ${secs} s`);
console.log(`  mean speed ${(st.spd / st.n * 3.6).toFixed(1)} km/h, laps index ${best}/${NP}, off-trail ${pc(st.offTrail)}`);
console.log(`  wheel off ground: any ${pc(st.anyAir)}, all four ${pc(st.allAir)}, per wheel [${st.air.map(pc).join(', ')}]`);
console.log(`  vertical accel minus gravity (8 Hz) rms ${Math.sqrt(st.az2 / st.n).toFixed(2)} m/s2, peak ${st.azMax.toFixed(1)}; max roll ${st.rollMax.toFixed(1)} deg; peak lateral ${st.latG.toFixed(2)} g`);
console.log(`  near bump stop ${(100 * st.bumpStop / st.n / 4).toFixed(1)}% of spring-time; rollovers ${st.rolls}`);
