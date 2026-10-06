// Prepare a downloaded car (Sketchfab GLB) for vehicle/cars.js: bake the vehicle frame into it (+x right,
// -z forward, hub centre at y 0, mid-wheelbase at z 0, metres) and split the wheels off the body into
// nodes the game mounts on its own axles: wheel_<corner> (tyre, rim, disc: spins) and hub_<corner>
// (parts off the hub centre, e.g. calipers: steers, doesn't spin). Prints the body outline per 10 cm of
// length (for the collision boxes) and the wheel numbers for the car's file (src/cars/<id>.js: physics and look).
// Steps: DEVNOTES.md "Imported cars".
//   needs (in a scratch dir, not this repo): npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions gl-matrix
//   node prepcar.mjs in.glb out.glb '{"scale":1,"flip":true,"hubY":0.3955,"R":0.4015,"wheels":[[x0,x1,zc],...]}'
//   source units: scale turns them into metres. flip: the source faces +z. wheels: x range and z centre of
//   each tyre (any number of wheels, two per axle), hubY its centre height, R its radius (source units).
//   Every part whose bounding box fits inside a wheel's box goes with that wheel.
// Corners: 4 wheels are FL FR RL RR; more wheels are named by axle from the front and side: 1L 1R 2L ...
// Each wheel group node sits at its own measured hub centre (holder translation) with the parts offset
// under it, so a model whose wheels are slightly off (the BTR-80's are 5.6 cm to one side) is re-centred
// by mounting the node on the physics hub. The world matrices of the parts are unchanged by this.
// Optional:
//   "wheelHubs": [[x, y, z], ...]  measured hub centre of each wheel (source units; default: box centre, hubY)
//   "tireMaterial": "name"        parts with this material go to tire_<corner> (deforms) instead of wheel_<corner>
//   "parts": [{ "name": "lowerArm", "x": [a, b], "y": [a, b], "dz": [a, b] }, ...]
//       suspension parts merged into the body mesh: a connected component whose box fits |x| in x, y in y and
//       z - wheel zc in dz (source units, both sides) goes to <name>_<corner> of the nearest wheel. Checked
//       before the wheel boxes (a knuckle can sit inside a wheel's box).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, compactPrimitive } from '@gltf-transform/functions';
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
// axle index of each wheel from the front (vehicle -z) and its corner name
const hubSrc = cfg.wheels.map((w, i) => cfg.wheelHubs?.[i] || [(w[0] + w[1]) / 2, cfg.hubY, w[2]]);
const hubs = hubSrc.map(tf);
const axleZ = [...new Set(hubs.map(h => Math.round(h[2] * 100)))].sort((a, b) => a - b);
const four = cfg.wheels.length === 4;
const cornerOf = i => {
  const h = hubs[i], side = h[0] < 0 ? 'L' : 'R';
  if (four) return (h[2] < 0 ? 'F' : 'R') + side;
  return (axleZ.indexOf(Math.round(h[2] * 100)) + 1) + side;
};
const corners = cfg.wheels.map((_, i) => cornerOf(i));
const parts = cfg.parts || [];
const prof = new Map();
const groups = new Map();   // `${kind}_${corner}` -> [{matrix, prim}]
const holderAt = new Map(); // group -> holder translation (source units)
let wheelTris = 0, bodyTris = 0, partTris = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) { mesh.removePrimitive(prim); continue; }   // lines / points
    const pos = prim.getAttribute('POSITION'), idxA = prim.getIndices(), n = pos.getCount();
    const isTire = cfg.tireMaterial && prim.getMaterial()?.getName() === cfg.tireMaterial;
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
      // suspension parts first (they can sit inside a wheel's box)
      let found = null;
      const cx = (b.min[0] + b.max[0]) / 2, ax0 = Math.min(Math.abs(b.min[0]), Math.abs(b.max[0])), ax1 = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
      if (Math.sign(b.min[0]) === Math.sign(b.max[0])) for (const pr of parts) {
        if (ax0 < pr.x[0] - tol || ax1 > pr.x[1] + tol || b.min[1] < pr.y[0] - tol || b.max[1] > pr.y[1] + tol) continue;
        // nearest wheel on this side whose dz window holds the part
        let best = -1, bd = Infinity;
        cfg.wheels.forEach((w, wi) => {
          if (Math.sign((w[0] + w[1]) / 2) !== Math.sign(cx)) return;
          if (b.min[2] - w[2] < pr.dz[0] - tol || b.max[2] - w[2] > pr.dz[1] + tol) return;
          const d = Math.abs((b.min[2] + b.max[2]) / 2 - w[2]);
          if (d < bd) { bd = d; best = wi; }
        });
        if (best >= 0) { found = pr.name + '_' + corners[best]; break; }
      }
      if (found) { where.set(r, found); continue; }
      const wi = cfg.wheels.findIndex(([x0, x1, zc], k) => b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= hubSrc[k][1] - R - tol && b.max[1] <= hubSrc[k][1] + R + tol &&
        b.min[2] >= zc - R - tol && b.max[2] <= zc + R + tol);
      if (wi < 0) continue;
      const hy = hubSrc[wi][1], hz = hubSrc[wi][2], cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const centred = Math.hypot(cy - hy, cz - hz) < 0.15 * R && Math.abs((b.max[1] - b.min[1]) - (b.max[2] - b.min[2])) < 0.1 * R;
      where.set(r, (centred ? (isTire ? 'tire_' : 'wheel_') : 'hub_') + corners[wi]);
    }
    const keep = [], split = new Map();
    for (let t = 0; t < I.length; t += 3) {
      const g = where.get(f(I[t]));
      if (g) {
        if (/^(wheel|tire|hub)_/.test(g)) wheelTris++; else partTris++;
        if (!split.has(g)) split.set(g, []); split.get(g).push(I[t], I[t+1], I[t+2]); continue;
      }
      bodyTris++; keep.push(I[t], I[t+1], I[t+2]);
      for (const j of [I[t], I[t+1], I[t+2]]) {
        const p = tf([P[j*3], P[j*3+1], P[j*3+2]]), zb = Math.round(p[2] * 10) / 10;
        let e = prof.get(zb); if (!e) prof.set(zb, e = { ymin: 1e9, ymax: -1e9, xmax: 0 });
        e.ymin = Math.min(e.ymin, p[1]); e.ymax = Math.max(e.ymax, p[1]); if (p[1] > -0.3) e.xmax = Math.max(e.xmax, Math.abs(p[0]));
      }
    }
    for (const [g, idx] of split) {
      const np = prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(idxA.getBuffer()));
      compactPrimitive(np);   // only its own vertices: a small part of a merged mesh keeps a small bounding box
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ matrix: [...node.getWorldMatrix()], prim: np });   // source world, before the bake node exists
      const ci = corners.indexOf(g.slice(g.indexOf('_') + 1));
      if (/^(wheel|tire|hub)_/.test(g) && ci >= 0) holderAt.set(g, hubSrc[ci]);
    }
    if (keep.length) { idxA.setArray(new Uint32Array(keep)); if (split.size) compactPrimitive(prim); } else mesh.removePrimitive(prim);
  }
}
// one node per group, under the bake node (source frame): wheel groups sit at their hub, the parts are offset
const scene = root.listScenes()[0];
const top = doc.createNode('car').setMatrix([...BAKE]);
for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
scene.addChild(top);
for (const [g, list] of groups) {
  const at = holderAt.get(g) || [0, 0, 0];
  const holder = doc.createNode(g).setTranslation(at);
  top.addChild(holder);
  const inv = mat4.fromTranslation(mat4.create(), at.map(x => -x));
  for (const { matrix, prim } of list) {
    const m = doc.createMesh(g).addPrimitive(prim);
    holder.addChild(doc.createNode(g + '_part').setMatrix([...mat4.multiply(mat4.create(), inv, matrix)]).setMesh(m));
  }
}
await doc.transform(prune(), dedup());
await io.write(out, doc);
const W = cfg.wheels.map(w => (w[1] - w[0]) * s);
const L = hubs.filter(h => h[0] < 0), Rt = hubs.filter(h => h[0] > 0);
const axles = axleZ.map(z => z / 100);
console.log(JSON.stringify({ wheelTris, partTris, bodyTris, R: +(R * s).toFixed(4), width: +(Math.max(...W)).toFixed(3),
  wheelbase: +(axles[axles.length - 1] - axles[0]).toFixed(3), axles,
  track: +(Rt.reduce((a, h) => a + h[0], 0) / Rt.length - L.reduce((a, h) => a + h[0], 0) / L.length).toFixed(3),
  hubs: hubs.map((h, i) => corners[i] + ' ' + h.map(x => x.toFixed(3)).join(',')),
  groups: [...groups.keys()].sort() }));
console.log('z  ymin ymax xmax  (hub frame, metres)');
for (const z of [...prof.keys()].sort((a, b) => a - b)) { const e = prof.get(z); console.log(z.toFixed(1), e.ymin.toFixed(2), e.ymax.toFixed(2), e.xmax.toFixed(2)); }
