import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { SURFACES } from '../vehicle/tire.js';
import { makeBarkTexture } from './textures.js';
import { ColliderStream } from './colliderStream.js';

// Static obstacles with Rapier colliders: the boulders and outcrops (placed and shaped in the window bake,
// windowBake.js) and the ruined huts at the world's hut sites. (Trees and fallen logs: trees.js.)
// Per window: prepareWindow builds the meshes (not in the scene yet), applyWindow swaps them in and refills the
// collider stream (colliders only within two 32 m chunks of the truck; a boulder's convex hull is built when it
// first streams in).

const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

export function buildProps(RAPIER, world, terrain, colliderSurface, rockMaterial, win) {
  const group = new THREE.Group();
  const rockMat = rockMaterial || new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.88, vertexColors: true });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.95, map: makeBarkTexture() });
  const stream = new ColliderStream(RAPIER, world, colliderSurface);
  let cur = { meshes: [] };

  const prepare = (t, w) => {
    const next = { meshes: [], items: [], rockCount: w.rocks.hulls.length };
    return { next, steps: [() => {
      const R = w.rocks;
      if (R.idx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(R.pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(R.nrm, 3));
        g.setAttribute('color', new THREE.BufferAttribute(R.col, 3));
        g.setIndex(new THREE.BufferAttribute(R.idx, 1));
        g.computeBoundingSphere();
        const rocks = new THREE.Mesh(g, rockMat);
        rocks.castShadow = true; rocks.receiveShadow = true;
        rocks.name = 'boulders';
        next.meshes.push(rocks);
      }
      for (const h of R.hulls) next.items.push({ x: h.x, z: h.z, desc: () => { const d = RAPIER.ColliderDesc.convexHull(h.pts); return d && d.setTranslation(h.x, h.y, h.z).setFriction(0.9); }, surface: SURFACES.rock });
      for (const s of t.sites) if (s.type === 'hut') buildHut(next, RAPIER, t, s, rockMat, beamMat, mulberry32(s.seed ?? strHash(s.id)));
    }] };
  };
  const apply = (next) => {
    for (const m of cur.meshes) { group.remove(m); m.geometry.dispose(); }
    cur = next;
    for (const m of cur.meshes) group.add(m);
    stream.clear();
    for (const it of next.items) stream.add(it.x, it.z, it.desc, it.surface);
    group.userData.rockCount = next.rockCount;
  };
  { const first = prepare(terrain, win); for (const s of first.steps) s(); apply(first.next); }
  group.userData.stream = stream;
  return { group, stream, prepareWindow: prepare, applyWindow: apply, get rockMesh() { return cur.meshes.find(m => m.name === 'boulders'); } };
}

// A ruined stone hut: rubble walls with a doorway and a window, a gable end with a chimney, two roof beams (one
// fallen) and stones around. Colliders per wall segment. out: { meshes, items } (the window being prepared)
function buildHut(out, RAPIER, terrain, site, stoneMat, beamMat, rnd) {
  const { x: hx, z: hz, yaw } = site;
  const base = terrain.heightAt(hx, hz);
  const parts = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const toWorld = (lx, lz) => [hx + lx * cos + lz * sin, hz - lx * sin + lz * cos];
  const stone = (lx, lz, w, h, d, y0 = 0, collide = true, tilt = 0) => {
    if (h < 0.08) return;
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute('uv');
    if (tilt) g.rotateZ(tilt);
    const [wx, wz] = toWorld(lx, lz);
    const gy = Math.min(terrain.heightAt(wx, wz), base) - 0.15;
    g.rotateY(yaw);
    g.translate(wx, gy + y0 + h / 2, wz);
    const k = 0.8 + rnd() * 0.15;
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) { c[i] = k; c[i + 1] = k * 0.95; c[i + 2] = k * 0.88; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
    if (collide) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, tilt));
      out.items.push({ x: wx, z: wz, desc: RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(wx, gy + y0 + h / 2, wz).setRotation(q).setFriction(0.9), surface: SURFACES.rock });
    }
  };
  const W = 6.4, D = 4.6, T = 0.5, SEG = 0.55;
  // a wall along local x (front / back) or z (sides), segment by segment with a ruined top
  const wall = (x0, z0, x1, z1, hFn) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / SEG)), along = x1 !== x0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, lx = x0 + (x1 - x0) * t, lz = z0 + (z1 - z0) * t;
      const [h0, h1] = hFn(t, lx, lz);
      const sw = len / n + 0.02;
      if (h1 > h0) stone(lx, lz, along ? sw : T, h1 - h0, along ? T : sw, h0);
    }
  };
  const rough = () => (rnd() - 0.5) * 0.35;
  // front (towards the trail) with a doorway, falling away towards the east corner
  wall(-W / 2, D / 2, W / 2, D / 2, (t, lx) => Math.abs(lx + 0.6) < 0.55 ? [0, 0] : [0, Math.max(0.3, 2.1 - Math.max(0, t - 0.55) * 3.2 + rough())]);
  // back with a window
  wall(-W / 2, -D / 2, W / 2, -D / 2, (t, lx) => Math.abs(lx - 0.8) < 0.5 ? [0, 0.95] : [0, 2.0 + rough() * 0.8]);
  // west gable: rises to the ridge, partly collapsed
  wall(-W / 2, -D / 2 + T / 2, -W / 2, D / 2 - T / 2, (t) => [0, Math.min(2.1 + (1 - Math.abs(t - 0.5) * 2) * 1.4, t > 0.75 ? 2.0 : 9) + rough() * 0.5]);
  // east wall: mostly down to rubble height
  wall(W / 2, -D / 2 + T / 2, W / 2, D / 2 - T / 2, (t) => [0, 0.5 + t * 0.7 + rough()]);
  // chimney stack at the west gable
  stone(-W / 2 - 0.15, -0.9, 0.9, 4.1, 0.9);
  // rubble: fallen stones around the low walls
  for (let k = 0; k < 26; k++) {
    const a = rnd() * Math.PI * 2, r = 2.5 + rnd() * 2.8;
    const lx = Math.cos(a) * r * 1.3 + 1.2, lz = Math.sin(a) * r;
    if (Math.abs(lx) < W / 2 - 0.4 && Math.abs(lz) < D / 2 - 0.4) continue;
    const s = 0.2 + rnd() * 0.25;
    stone(lx, lz, s * 1.4, s, s, -0.05, false, (rnd() - 0.5) * 0.6);
  }
  const geo = mergeGeometries(parts);
  const mesh = new THREE.Mesh(geo, stoneMat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'hut';
  out.meshes.push(mesh);
  // roof beams: one still spanning the gable to the front wall, one fallen inside
  const beam = (lx0, ly0, lz0, lx1, ly1, lz1, r) => {
    const [ax, az] = toWorld(lx0, lz0), [bx, bz] = toWorld(lx1, lz1);
    const a = new THREE.Vector3(ax, base + ly0, az), b = new THREE.Vector3(bx, base + ly1, bz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, a.distanceTo(b), 7), beamMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = m.receiveShadow = true;
    out.meshes.push(m);
  };
  beam(-W / 2 + 0.2, 3.25, 0, W / 2 - 1.8, 2.15, 0.2, 0.11);
  beam(-1.2, 0.15, -1.6, 1.9, 1.05, 1.5, 0.1);
}
