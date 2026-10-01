import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeSimplex2D, mulberry32, fbm } from './noise.js';
import { LANES, PAD, SPAWN, SURF, MAP_SIZE } from './terrain.js';
import { SURFACES } from '../vehicle/tire.js';
import { makeBarkTexture } from './textures.js';

// Static obstacles with Rapier colliders: boulders, rock garden, concrete steps, logs, trees.
// Returns a THREE.Group and fills colliderSurface (collider handle -> tyre surface).

export function buildProps(RAPIER, world, terrain, colliderSurface, texRock) {
  const group = new THREE.Group();
  const rnd = mulberry32(1234);
  const noise = makeSimplex2D(99);

  // ---------------- boulders
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xa8a49c, map: texRock, roughness: 0.88, vertexColors: true });
  const rockGeos = [];
  const addRock = (x, z, r, flat = 0.75, sink = 0.3) => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const pos = g.attributes.position;
    const seed = rnd() * 100;
    const sx = r * (0.8 + rnd() * 0.5), sy = r * flat * (0.75 + rnd() * 0.4), sz = r * (0.8 + rnd() * 0.5);
    const colors = new Float32Array(pos.count * 3);
    const tint = 0.85 + rnd() * 0.25;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const n = 1 + 0.22 * fbm(noise, vx * 1.3 + seed, vz * 1.3 + vy * 0.7 + seed, 3) + 0.06 * noise(vx * 5 + seed, vy * 5 - vz * 5);
      pos.setXYZ(i, vx * sx * n, vy * sy * n, vz * sz * n);
      const c = tint * (0.82 + 0.18 * (vy * 0.5 + 0.5));
      colors[i * 3] = c; colors[i * 3 + 1] = c * 0.97; colors[i * 3 + 2] = c * 0.92;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const ry = rnd() * Math.PI * 2;
    g.rotateY(ry);
    g.rotateX((rnd() - 0.5) * 0.4);
    const ground = Math.min(terrain.heightAt(x - sx * 0.5, z), terrain.heightAt(x + sx * 0.5, z), terrain.heightAt(x, z - sz * 0.5), terrain.heightAt(x, z + sz * 0.5), terrain.heightAt(x, z));
    const y = ground + sy * (1 - sink) - sy;
    g.computeVertexNormals();
    // collider = convex hull of the displaced vertices
    const pts = new Float32Array(g.attributes.position.array);
    const desc = RAPIER.ColliderDesc.convexHull(pts);
    if (!desc) return;
    desc.setTranslation(x, y + sy, z).setFriction(0.9);
    const col = world.createCollider(desc);
    colliderSurface.set(col.handle, SURFACES.rock);
    g.translate(x, y + sy, z);
    // simple planar uvs for the rock texture
    const uv = new Float32Array(g.attributes.position.count * 2);
    for (let i = 0; i < g.attributes.position.count; i++) {
      uv[i * 2] = (g.attributes.position.getX(i) + g.attributes.position.getY(i) * 0.6) / 2.5;
      uv[i * 2 + 1] = (g.attributes.position.getZ(i) - g.attributes.position.getY(i) * 0.6) / 2.5;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    rockGeos.push(g);
  };

  // rock garden in lane C
  for (let k = 0; k < 46; k++) {
    const z = 40 - rnd() * 62, x = LANES.C + (rnd() - 0.5) * 6.4;
    addRock(x, z, 0.28 + rnd() * rnd() * 0.62, 0.66, 0.38);
  }
  // scattered boulders across the map (off the trails and the pad)
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < 170; tries++) {
    const x = (rnd() - 0.5) * (MAP_SIZE - 40), z = (rnd() - 0.5) * (MAP_SIZE - 40);
    if (terrain.isTrail(x, z, 6)) continue;
    if (x > PAD.x0 - 6 && x < PAD.x1 + 6 && z > PAD.z0 - 6 && z < PAD.z1 + 6) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 25) continue;
    const big = rnd() < 0.15;
    const r = big ? 1.2 + rnd() * 1.4 : 0.35 + rnd() * 0.7;
    // clusters
    addRock(x, z, r, 0.65 + rnd() * 0.3, 0.3);
    if (rnd() < 0.5) for (let c = 0; c < 3; c++) addRock(x + (rnd() - 0.5) * r * 4, z + (rnd() - 0.5) * r * 4, r * (0.3 + rnd() * 0.4), 0.7, 0.35);
    placed++;
  }
  if (rockGeos.length) {
    const merged = mergeGeometries(rockGeos);
    const rocks = new THREE.Mesh(merged, rockMat);
    rocks.castShadow = true; rocks.receiveShadow = true;
    group.add(rocks);
  }

  // ---------------- lane B: concrete steps then logs
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9c9890, roughness: 0.9 });
  const stepHeights = [0.15, 0.25, 0.35, 0.45];
  stepHeights.forEach((h, k) => {
    const z = 34 - k * 8;
    const y = terrain.heightAt(LANES.B, z);
    const hx = 2.2, hz = 0.7;
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h + 0.4, hz * 2), concrete);
    m.position.set(LANES.B, y + (h - 0.4) / 2 + 0.0, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const col = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, (h + 0.4) / 2, hz).setTranslation(m.position.x, m.position.y, m.position.z).setFriction(0.95));
    colliderSurface.set(col.handle, SURFACES.concrete);
  });
  const bark = makeBarkTexture();
  const logMat = new THREE.MeshStandardMaterial({ color: 0x8a7258, map: bark, roughness: 0.9 });
  [0.12, 0.2, 0.28].forEach((r, k) => {
    const z = 2 - k * 7.5;
    const y = terrain.heightAt(LANES.B, z) + r * 0.85;
    const len = 6;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, len, 16), logMat);
    m.rotation.z = Math.PI / 2;
    m.rotation.y = (k - 1) * 0.12;
    m.position.set(LANES.B, y, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const q = m.quaternion;
    const col = world.createCollider(RAPIER.ColliderDesc.cylinder(len / 2, r).setTranslation(LANES.B, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.7));
    colliderSurface.set(col.handle, SURFACES.wood);
  });
  // lane markers (posts) at lane starts
  const postMat = new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.7 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc8301e, roughness: 0.6 });
  for (const lx of Object.values(LANES)) for (const s of [-1, 1]) {
    const x = lx + s * 4.2, z = 44;
    const y = terrain.heightAt(x, z);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), postMat);
    p.position.set(x, y + 0.6, z);
    p.castShadow = true;
    group.add(p);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.2, 8), stripeMat);
    st.position.set(x, y + 1.0, z);
    group.add(st);
  }

  // ---------------- trees (instanced)
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 2.4, 7).translate(0, 1.2, 0);
  const crown = [];
  for (let k = 0; k < 4; k++) {
    const r = 1.6 - k * 0.32, h = 2.2 - k * 0.25;
    const c = new THREE.ConeGeometry(r, h, 9, 1).translate(0, 1.9 + k * 1.15 + h / 2, 0);
    const p = c.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getZ(i), p.getX(i));
      const j = 1 + 0.12 * Math.sin(a * 5 + k * 1.7);
      p.setX(i, p.getX(i) * j); p.setZ(i, p.getZ(i) * j);
    }
    crown.push(c.toNonIndexed());
  }
  const crownGeo = mergeGeometries(crown);
  crownGeo.computeVertexNormals();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a5240, map: bark, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2e4a2a, roughness: 0.9, flatShading: true });
  const trees = [];
  const nTreeNoise = makeSimplex2D(5);
  for (let tries = 0; tries < 30000 && trees.length < 1100; tries++) {
    const x = (rnd() - 0.5) * (MAP_SIZE - 12), z = (rnd() - 0.5) * (MAP_SIZE - 12);
    const forest = fbm(nTreeNoise, x * 0.012, z * 0.012, 3);
    if (forest < 0.05 && rnd() > 0.08) continue;
    if (terrain.isTrail(x, z, 7)) continue;
    if (x > PAD.x0 - 10 && x < PAD.x1 + 10 && z > PAD.z0 - 10 && z < PAD.z1 + 10) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 30) continue;
    const s = terrain.surfaceAt(x, z);
    if (s === SURFACES.mud) continue;
    const h = terrain.heightAt(x, z);
    const gx = terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), gz = terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1);
    if (Math.hypot(gx, gz) / 2 > 0.7) continue;
    trees.push({ x, z, y: h, s: 0.7 + rnd() * 0.75, r: rnd() * Math.PI * 2 });
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const col = new THREE.Color();
  trees.forEach((t, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r);
    sc.set(t.s, t.s * (0.9 + rnd() * 0.3), t.s);
    ps.set(t.x, t.y - 0.1, t.z);
    mtx.compose(ps, q, sc);
    trunks.setMatrixAt(i, mtx);
    crowns.setMatrixAt(i, mtx);
    col.setHSL(0.27 + rnd() * 0.06, 0.35 + rnd() * 0.15, 0.17 + rnd() * 0.08);
    crowns.setColorAt(i, col);
    const c = world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.2 * t.s).setTranslation(t.x, t.y + 1.4, t.z).setFriction(0.6));
    colliderSurface.set(c.handle, SURFACES.wood);
  });
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  group.add(trunks, crowns);
  group.userData.treeCount = trees.length;
  return group;
}
