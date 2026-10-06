// Cut parts out of a prepared car model (public/models/<id>.glb, the frame prepcar baked: +x right, -z
// forward, metres, y 0 at the hub) into nodes of their own, so the game can move them: the steering wheel,
// the gear lever (the car's look.cockpit names them). A part is every connected piece of mesh (vertices
// welded by position) whose bounding box lies inside the part's box.
//   needs (in a scratch dir, not this repo): npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer
//   node cutparts.mjs in.glb out.glb '{"parts":[{"name":"steering_wheel","box":[[x0,x1],[y0,y1],[z0,z1]]}]}'
//   LIST='[cx,cy,cz,r]' node cutparts.mjs in.glb   lists the pieces whose box centre is within r of c (to find the box)
// The output keeps the input's compression (meshopt) and textures.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, compactPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const [, , src, out, cfgJson] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
const root = doc.getRoot();
const list = process.env.LIST ? JSON.parse(process.env.LIST) : null;
const parts = list ? [] : JSON.parse(cfgJson).parts;
const inside = (b, box) => [0, 1, 2].every(a => b.min[a] >= box[a][0] && b.max[a] <= box[a][1]);
const found = [];
const groups = new Map();   // part name -> [{ matrix, prim }]

for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute('POSITION'), idxA = prim.getIndices(), n = pos.getCount();
    const P = new Float32Array(n * 3), v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, v);
      for (let r = 0; r < 3; r++) P[i * 3 + r] = M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + M[12 + r];
    }
    const par = new Int32Array(n).map((_, i) => i);
    const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    const key = new Map();
    for (let i = 0; i < n; i++) { const k = `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`; if (key.has(k)) u(i, key.get(k)); else key.set(k, i); }
    const I = idxA.getArray();
    for (let t = 0; t < I.length; t += 3) { u(I[t], I[t + 1]); u(I[t], I[t + 2]); }
    const bb = new Map();
    for (let i = 0; i < n; i++) {
      const r = f(i); let b = bb.get(r); if (!b) bb.set(r, b = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], n: 0 });
      for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], P[i * 3 + a]); b.max[a] = Math.max(b.max[a], P[i * 3 + a]); }
      b.n++;
    }
    const where = new Map();
    for (const [r, b] of bb) {
      if (list) {
        const c = [0, 1, 2].map(a => (b.min[a] + b.max[a]) / 2);
        if (Math.hypot(c[0] - list[0], c[1] - list[1], c[2] - list[2]) < list[3]) found.push({ node: node.getName(), material: prim.getMaterial()?.getName(), min: b.min.map(x => +x.toFixed(3)), max: b.max.map(x => +x.toFixed(3)), verts: b.n });
        continue;
      }
      const part = parts.find(p => inside(b, p.box));
      if (part) where.set(r, part.name);
    }
    if (list || !where.size) continue;
    const keep = [], split = new Map();
    for (let t = 0; t < I.length; t += 3) {
      const g = where.get(f(I[t]));
      if (!g) { keep.push(I[t], I[t + 1], I[t + 2]); continue; }
      if (!split.has(g)) split.set(g, []);
      split.get(g).push(I[t], I[t + 1], I[t + 2]);
    }
    for (const [g, idx] of split) {
      const np = prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(idxA.getBuffer()));
      compactPrimitive(np);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ matrix: [...M], prim: np });
    }
    if (keep.length) { idxA.setArray(new Uint32Array(keep)); compactPrimitive(prim); } else mesh.removePrimitive(prim);
  }
}
if (list) {
  found.sort((a, b) => b.verts - a.verts);
  for (const p of found) console.log(JSON.stringify(p));
  process.exit(0);
}
const scene = root.listScenes()[0];
for (const [g, items] of groups) {
  const holder = doc.createNode(g);
  scene.addChild(holder);
  for (const { matrix, prim } of items) holder.addChild(doc.createNode(g + '_part').setMatrix(matrix).setMesh(doc.createMesh(g).addPrimitive(prim)));
  console.log(g, items.length, 'pieces');
}
for (const p of parts) if (!groups.has(p.name)) console.log(p.name, 'nothing inside the box');
await doc.transform(prune(), dedup());
await io.write(out, doc);
