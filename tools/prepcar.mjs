// Prepare a downloaded car (Sketchfab GLB) for vehicle/cars.js: bake the vehicle frame into it (+x right,
// -z forward, hub centre at y 0, mid-wheelbase at z 0, metres) and split the wheels off the body into
// nodes the game mounts on its own axles: wheel_<FL|FR|RL|RR> (tyre, rim, disc: spins) and hub_<corner>
// (parts off the hub centre, e.g. calipers: steers, doesn't spin). Prints the body outline per 10 cm of
// length (for the collision boxes) and the wheel numbers for the CARS / CAR_SPECS entries.
// Steps: DEVNOTES.md "Imported cars".
//   needs (in a scratch dir, not this repo): npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions gl-matrix
//   node prepcar.mjs in.glb out.glb '{"scale":1,"flip":true,"hubY":0.3955,"R":0.4015,"wheels":[[x0,x1,zc],...]}'
//   source units: scale turns them into metres. flip: the source faces +z. wheels: x range and z centre of
//   each tyre, hubY its centre height, R its radius (source units). Every part whose bounding box fits
//   inside a wheel's box goes with that wheel.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { vec3, mat4 } from 'gl-matrix';
const [, , src, out, cfgJson] = process.argv;
const cfg = JSON.parse(cfgJson);
const s = cfg.scale ?? 1, R = cfg.R;
const zs = cfg.wheels.map(w => w[2]);
const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const root = doc.getRoot();
// source -> vehicle frame (metres)
const BAKE = mat4.create();
mat4.scale(BAKE, BAKE, cfg.flip ? [-s, s, -s] : [s, s, s]);
mat4.translate(BAKE, BAKE, [0, -cfg.hubY, -midZ]);
const tf = p => vec3.transformMat4([0, 0, 0], p, BAKE);
const corner = w => { const c = tf([(w[0] + w[1]) / 2, cfg.hubY, w[2]]); return (c[2] < 0 ? 'F' : 'R') + (c[0] < 0 ? 'L' : 'R'); };
const hubs = cfg.wheels.map(w => tf([(w[0] + w[1]) / 2, cfg.hubY, w[2]]));
const prof = new Map();
const groups = new Map();   // `${kind}_${corner}` -> [{node, prim, idx}]
let wheelTris = 0, bodyTris = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) { mesh.removePrimitive(prim); continue; }   // lines / points
    const pos = prim.getAttribute('POSITION'), idxA = prim.getIndices(), n = pos.getCount();
    const P = new Float32Array(n * 3), v = [0, 0, 0];
    for (let i = 0; i < n; i++) { pos.getElement(i, v); vec3.transformMat4(v, v, M); P.set(v, i * 3); }
    const par = new Int32Array(n).map((_, i) => i);
    const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    const key = new Map(), q = 1e4 / s;
    for (let i = 0; i < n; i++) { const k = `${Math.round(P[i*3]*q)},${Math.round(P[i*3+1]*q)},${Math.round(P[i*3+2]*q)}`; if (key.has(k)) u(i, key.get(k)); else key.set(k, i); }
    const I = idxA.getArray();
    for (let t = 0; t < I.length; t += 3) { u(I[t], I[t+1]); u(I[t], I[t+2]); }
    const bb = new Map();
    for (let i = 0; i < n; i++) {
      const r = f(i); let b = bb.get(r); if (!b) bb.set(r, b = { min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
      for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], P[i*3+a]); b.max[a] = Math.max(b.max[a], P[i*3+a]); }
    }
    const tol = 0.01 / s;
    const where = new Map();
    for (const [r, b] of bb) {
      const wi = cfg.wheels.findIndex(([x0, x1, zc]) => b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= cfg.hubY - R - tol && b.max[1] <= cfg.hubY + R + tol &&
        b.min[2] >= zc - R - tol && b.max[2] <= zc + R + tol);
      if (wi < 0) continue;
      const w = cfg.wheels[wi], cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const centred = Math.hypot(cy - cfg.hubY, cz - w[2]) < 0.15 * R && Math.abs((b.max[1] - b.min[1]) - (b.max[2] - b.min[2])) < 0.1 * R;
      where.set(r, (centred ? 'wheel_' : 'hub_') + corner(w));
    }
    const keep = [], split = new Map();
    for (let t = 0; t < I.length; t += 3) {
      const g = where.get(f(I[t]));
      if (g) { wheelTris++; if (!split.has(g)) split.set(g, []); split.get(g).push(I[t], I[t+1], I[t+2]); continue; }
      bodyTris++; keep.push(I[t], I[t+1], I[t+2]);
      for (const j of [I[t], I[t+1], I[t+2]]) {
        const p = tf([P[j*3], P[j*3+1], P[j*3+2]]), zb = Math.round(p[2] * 10) / 10;
        let e = prof.get(zb); if (!e) prof.set(zb, e = { ymin: 1e9, ymax: -1e9, xmax: 0 });
        e.ymin = Math.min(e.ymin, p[1]); e.ymax = Math.max(e.ymax, p[1]); if (p[1] > -0.3) e.xmax = Math.max(e.xmax, Math.abs(p[0]));
      }
    }
    for (const [g, idx] of split) {
      const np = prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(idxA.getBuffer()));
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ matrix: [...node.getWorldMatrix()], prim: np });   // source world, before the bake node exists
    }
    if (keep.length) idxA.setArray(new Uint32Array(keep)); else mesh.removePrimitive(prim);
  }
}
// one node per wheel group, in the source world frame (same parent chain as the body: the bake applies)
const scene = root.listScenes()[0];
const top = doc.createNode('car').setMatrix([...BAKE]);
for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
scene.addChild(top);
for (const [g, list] of groups) {
  const holder = doc.createNode(g);
  top.addChild(holder);
  for (const { matrix, prim } of list) {
    const m = doc.createMesh(g).addPrimitive(prim);
    holder.addChild(doc.createNode(g + '_part').setMatrix(matrix).setMesh(m));
  }
}
await doc.transform(prune(), dedup());
await io.write(out, doc);
const W = cfg.wheels.map(w => (w[1] - w[0]) * s);
console.log(JSON.stringify({ wheelTris, bodyTris, R: +(R * s).toFixed(4), width: +(Math.max(...W)).toFixed(3),
  wheelbase: +(Math.abs(hubs[0][2] - hubs.find(h => Math.sign(h[2]) !== Math.sign(hubs[0][2]))[2])).toFixed(3),
  track: +(Math.abs(hubs[0][0] - hubs.find(h => Math.sign(h[0]) !== Math.sign(hubs[0][0]))[0])).toFixed(3),
  groups: [...groups.keys()].sort() }));
console.log('z  ymin ymax xmax  (hub frame, metres)');
for (const z of [...prof.keys()].sort((a, b) => a - b)) { const e = prof.get(z); console.log(z.toFixed(1), e.ymin.toFixed(2), e.ymax.toFixed(2), e.xmax.toFixed(2)); }
