// Cut the wheels out of a downloaded car (Sketchfab GLB) and bake the vehicle frame into it:
// +x right, -z forward, hub centre at y 0, mid-wheelbase at z 0. Prints the body outline per 10 cm of
// length (hub frame) for fitting the collision boxes. Steps and the measured numbers: DEVNOTES.md "Imported cars".
//   needs (in a scratch dir, not this repo): npm i @gltf-transform/core @gltf-transform/functions gl-matrix
//   node cutcar.mjs in.glb out.glb '{"flip":true,"midZ":0.063,"hubY":0.3955,"R":0.4015,"wheels":[[x0,x1,zc],...]}'
//   flip: the source faces +z. wheels: x range and z centre of each tyre in source coordinates; every part
//   whose bounding box fits inside a wheel's box (tyre, rim, brake, nuts) is removed.
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import { vec3 } from 'gl-matrix';
const [, , src, out, cfgJson] = process.argv;
const cfg = JSON.parse(cfgJson);   // { flip, midZ, hubY, wheels: [[xmin,xmax,zc]], R }
const io = new NodeIO();
const doc = await io.read(src);
const root = doc.getRoot();
const tf = p => cfg.flip ? [-p[0], p[1] - cfg.hubY, -(p[2] - cfg.midZ)] : [p[0], p[1] - cfg.hubY, p[2] - cfg.midZ];
let removed = 0, kept = 0;
const prof = new Map();   // z bin -> {ymin, ymax, xmax}
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), idxA = prim.getIndices(), n = pos.getCount();
    const P = new Float32Array(n * 3), v = [0, 0, 0];
    for (let i = 0; i < n; i++) { pos.getElement(i, v); vec3.transformMat4(v, v, M); P.set(v, i * 3); }
    const par = new Int32Array(n).map((_, i) => i);
    const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    const key = new Map();
    for (let i = 0; i < n; i++) { const k = `${P[i*3].toFixed(4)},${P[i*3+1].toFixed(4)},${P[i*3+2].toFixed(4)}`; if (key.has(k)) u(i, key.get(k)); else key.set(k, i); }
    const I = idxA.getArray();
    for (let t = 0; t < I.length; t += 3) { u(I[t], I[t+1]); u(I[t], I[t+2]); }
    const bb = new Map();
    for (let i = 0; i < n; i++) {
      const r = f(i); let b = bb.get(r); if (!b) bb.set(r, b = { min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
      for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], P[i*3+a]); b.max[a] = Math.max(b.max[a], P[i*3+a]); }
    }
    // a component goes if its box sits inside a wheel's cylinder box (source coords)
    const inWheel = b => cfg.wheels.some(([x0, x1, zc]) => b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= -0.03 && b.max[1] <= 2 * cfg.R + 0.01 &&
      b.min[2] >= zc - cfg.R - 0.01 && b.max[2] <= zc + cfg.R + 0.01);
    const drop = new Map([...bb].map(([r, b]) => [r, inWheel(b)]));
    const keep = [];
    for (let t = 0; t < I.length; t += 3) {
      if (drop.get(f(I[t]))) { removed++; continue; }
      kept++; keep.push(I[t], I[t+1], I[t+2]);
      for (const j of [I[t], I[t+1], I[t+2]]) {
        const p = tf([P[j*3], P[j*3+1], P[j*3+2]]), zb = Math.round(p[2] * 10) / 10;
        let s = prof.get(zb); if (!s) prof.set(zb, s = { ymin: 1e9, ymax: -1e9, xmax: 0 });
        s.ymin = Math.min(s.ymin, p[1]); s.ymax = Math.max(s.ymax, p[1]); if (p[1] > -0.3) s.xmax = Math.max(s.xmax, Math.abs(p[0]));
      }
    }
    idxA.setArray(new Uint32Array(keep));
  }
}
// bake the frame: one new root node carrying the transform
const scene = root.listScenes()[0];
const top = doc.createNode('car').setMatrix(cfg.flip ? [-1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,-cfg.hubY,cfg.midZ,1] : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-cfg.hubY,-cfg.midZ,1]);
for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
scene.addChild(top);
await doc.transform(prune(), dedup());
await io.write(out, doc);
console.log('removed tris', removed, 'kept', kept);
console.log('z  ymin(hub=0) ymax xmax');
for (const z of [...prof.keys()].sort((a, b) => a - b)) { const s = prof.get(z); console.log(z.toFixed(1), s.ymin.toFixed(2), s.ymax.toFixed(2), s.xmax.toFixed(2)); }
