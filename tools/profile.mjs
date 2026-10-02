// Side profile of the visible truck body against the physics collision boxes: the lowest point of the
// body per 2 cm slice along z, and the approach / departure / breakover angles of both (same maths as the
// tuning panel, tuning.geometry). Use it after moving bodywork or colliders.
//   node tools/profile.mjs            LIST=1 also prints the underside every 10 cm
// The visible numbers include parts left out of the colliders on purpose: the dangling D-ring shackles
// (front and rear) and the exhaust tail pipe and silencer, which would scrape / bend, not hold the truck up.
import * as THREE from 'three';
// the model draws gauge faces on a canvas: a no-op stand-in is enough for geometry
const noop = new Proxy(function () {}, { get: (t, k) => (k === 'data' ? new Uint8ClampedArray(4) : noop), apply: () => noop, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };
const { buildTruck } = await import('../src/vehicle/truckModel.js');
import { makeDefenderParams } from '../src/vehicle/params.js';
import { geometry } from '../src/vehicle/tuning.js';
const P = makeDefenderParams();
const m = buildTruck(P);
m.root.updateMatrixWorld(true);
const skip = new Set();
for (const a of m.axles) a.traverse(o => skip.add(o));
for (const s of m.suspension) for (const o of [s.coil, s.shockBody, s.shockRod]) skip.add(o);
for (const p of m.props) skip.add(p);
for (const a of m.axles) { for (const l of a.userData.links) skip.add(l.link); skip.add(a.userData.panhard.mesh); }
const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
const bins = new Map(); // z bin (2 cm) -> lowest body point
const put = (z, y, o) => { const k = Math.round(z / 0.02); const e = bins.get(k); if (!e || y < e.y) bins.set(k, { y, o }); };
m.root.traverse(o => {
  if (!o.isMesh) return;
  for (let p = o; p; p = p.parent) if (skip.has(p)) return;
  const pos = o.geometry.attributes.position, idx = o.geometry.index;
  const n = idx ? idx.count : pos.count, at = i => (idx ? idx.getX(i) : i);
  for (let t = 0; t < n; t += 3) for (let e = 0; e < 3; e++) {
    a.fromBufferAttribute(pos, at(t + e)).applyMatrix4(o.matrixWorld);
    b.fromBufferAttribute(pos, at(t + (e + 1) % 3)).applyMatrix4(o.matrixWorld);
    const steps = Math.max(1, Math.ceil(Math.abs(b.z - a.z) / 0.01));
    for (let s = 0; s <= steps; s++) { v.lerpVectors(a, b, s / steps); put(v.z, v.y, o); }
  }
});
const keys = [...bins.keys()].sort((a, b) => a - b);
const profile = keys.map(k => [k * 0.02, bins.get(k).y]);

const g = (pts, label) => {
  const r = geometry(P, 20, 20, pts);
  console.log(`${label.padEnd(14)} approach ${r.approach.toFixed(1)}°, departure ${r.departure.toFixed(1)}°, breakover ${r.breakover.toFixed(1)}°, lowest ${(r.bodyClear * 100).toFixed(0)} cm`);
};
g(profile, 'visible model');
g(null, 'colliders');
if (process.env.LIST) for (const [z, y] of profile) if (Math.round(z * 50) % 5 === 0) console.log(z.toFixed(2), y.toFixed(3));
