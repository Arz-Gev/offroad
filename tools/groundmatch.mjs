// Does the ground the tyres feel match the ground drawn? (tyre v2: the per-ray deformation is drawn from the
// physics' ray hits, so a gap between collider and mesh shows as a tyre floating or sunk.)
//   node tools/groundmatch.mjs
// 1. terrain: Rapier ray casts on the heightfield collider vs terrain.surfaceHeight (the formula the level-0
//    render triangles use, same diagonal) at random points over the whole map;
// 2. boulders: the convex hull collider vs the drawn (displaced) mesh, top-down rays at random points over
//    each rock: how far the hull sits above the mesh (a hull covers concave dips the mesh shows).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Terrain, MAP_SIZE } from '../src/world/terrain.js';
import { buildProps } from '../src/world/props.js';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const terrain = new Terrain(7);
const tc = terrain.createCollider(RAPIER, world);
const props = buildProps(RAPIER, world, terrain, new Map());
const stream = props.userData.stream;
world.step();

let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
const ray = (x, y, z) => new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });

// ---- 1. terrain
let max = 0, sum = 0, n = 0, worst = null;
const half = MAP_SIZE / 2 - 1;
for (let i = 0; i < 20000; i++) {
  const x = (rand() * 2 - 1) * half, z = (rand() * 2 - 1) * half;
  const h = terrain.surfaceHeight(x, z);
  const hit = world.castRay(ray(x, h + 20, z), 60, true, undefined, undefined, undefined, undefined, c => c.handle === tc.handle);
  if (!hit) { console.log('terrain: no hit at', x.toFixed(2), z.toFixed(2)); continue; }
  const d = Math.abs(h + 20 - hit.timeOfImpact - h);
  sum += d; n++;
  if (d > max) { max = d; worst = [x, z]; }
}
console.log(`terrain  ${n} rays: mean |ray - drawn| ${(sum / n * 1000).toFixed(3)} mm, max ${(max * 1000).toFixed(3)} mm at (${worst[0].toFixed(2)}, ${worst[1].toFixed(2)})`);

// ---- 2. boulders: every streamed hull in the world, the merged rock mesh for the drawn surface
const hulls = [];
for (const list of stream.items) for (const it of list) {
  if (!it.desc.shape.vertices) continue;   // huts (boxes)
  const c = world.createCollider(it.desc); c.verts = it.desc.shape.vertices; hulls.push(c);
}
world.step();
const rockMesh = props.children.find(o => o.isMesh && o.geometry.attributes.color);
rockMesh.updateMatrixWorld(true);
const rc = new THREE.Raycaster(); rc.firstHitOnly = true;
const gaps = [];
let miss = 0, below = 0;
const pick = hulls.filter((_, i) => i % Math.max(1, Math.floor(hulls.length / 300)) === 0);
for (const c of pick) {
  const t = c.translation();
  const aabb = new THREE.Box3();
  const v = c.verts;
  for (let k = 0; k < v.length; k += 3) aabb.expandByPoint(new THREE.Vector3(v[k] + t.x, v[k + 1] + t.y, v[k + 2] + t.z));
  for (let s = 0; s < 8; s++) {
    // inner 60% of the footprint: the top, where a tyre rides on a rock
    const x = THREE.MathUtils.lerp(aabb.min.x, aabb.max.x, 0.2 + 0.6 * rand());
    const z = THREE.MathUtils.lerp(aabb.min.z, aabb.max.z, 0.2 + 0.6 * rand());
    const top = aabb.max.y + 1;
    const hit = world.castRay(ray(x, top, z), 30, true, undefined, undefined, undefined, undefined, cc => cc.handle === c.handle);
    rc.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
    const mh = rc.intersectObject(rockMesh, false)[0];
    if (!hit || !mh) { miss++; continue; }
    const g = (top - hit.timeOfImpact) - mh.point.y;   // + = hull above the drawn rock
    if (g < -1e-3) below++;
    gaps.push(g);
  }
}
gaps.sort((a, b) => a - b);
const q = p => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] * 1000;
console.log(`boulders ${pick.length} of ${hulls.length} rocks, ${gaps.length} rays (${miss} missed one of the two): hull above mesh median ${q(0.5).toFixed(1)} mm, 90% ${q(0.9).toFixed(1)} mm, 99% ${q(0.99).toFixed(1)} mm, max ${q(1).toFixed(1)} mm; ${below} rays with the hull below the mesh`);
