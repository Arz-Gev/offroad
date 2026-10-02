import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeSimplex2D, mulberry32, fbm } from './noise.js';
import { LANES, PAD, SPAWN, SURF, MAP_SIZE, POI } from './terrain.js';
import { SURFACES } from '../vehicle/tire.js';
import { makeBarkTexture } from './textures.js';
import { ColliderStream } from './colliderStream.js';

// Static obstacles with Rapier colliders: boulders and outcrops, the rock garden, concrete steps, logs,
// the ruined hut. (Trees and fallen logs: trees.js.)
// Returns a THREE.Group and fills colliderSurface (collider handle -> tyre surface).

export function buildProps(RAPIER, world, terrain, colliderSurface, rockMaterial = null) {
  const group = new THREE.Group();
  const rnd = mulberry32(1234);
  const rnd2 = mulberry32(4321);   // rock shapes (keeps the positions drawn from rnd unchanged)
  const noise = makeSimplex2D(99);
  // boulder and hut colliders are streamed in around the truck (colliderStream.js)
  const stream = new ColliderStream(RAPIER, world, colliderSurface);
  group.userData.stream = stream;

  // ---------------- boulders
  // Shape: an icosphere cut by a few random planes (chunky faces like broken rock), then noise-displaced.
  // Indexed with smooth normals; the triplanar rock material (materials.js) adds the surface detail.
  const rockMat = rockMaterial || new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.88, vertexColors: true });
  const rockGeos = [];
  const _v = new THREE.Vector3();
  const addRock = (x, z, r, flat = 0.75, sink = 0.3) => {
    let g = new THREE.IcosahedronGeometry(1, r > 0.9 ? 3 : 2);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    g = mergeVertices(g);
    const pos = g.attributes.position;
    const seed = rnd() * 100;
    const sx = r * (0.8 + rnd() * 0.5), sy = r * flat * (0.75 + rnd() * 0.4), sz = r * (0.8 + rnd() * 0.5);
    const colors = new Float32Array(pos.count * 3);
    const tint = 0.85 + rnd() * 0.25;
    const planes = [];
    for (let k = 0, n = 5 + Math.floor(rnd2() * 4); k < n; k++) {
      const a = rnd2() * Math.PI * 2, e = (rnd2() - 0.35) * 1.4;
      planes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.74 + rnd2() * 0.22]);
    }
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).normalize();
      let rad = 1;
      for (const [px, py, pz, d] of planes) { const c = _v.x * px + _v.y * py + _v.z * pz; if (c > 1e-3) rad = Math.min(rad, d / c); }
      const vx = _v.x * rad, vy = _v.y * rad, vz = _v.z * rad;
      const n = 1 + 0.16 * fbm(noise, vx * 1.3 + seed, vz * 1.3 + vy * 0.7 + seed, 3) + 0.05 * noise(vx * 5 + seed, vy * 5 - vz * 5);
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
    stream.add(x, z, desc, SURFACES.rock);
    g.translate(x, y + sy, z);
    rockGeos.push(g);
  };
  const clear = (x, z, m) => !terrain.isTrail(x, z, m) && !(x > PAD.x0 - m && x < PAD.x1 + m && z > PAD.z0 - m && z < PAD.z1 + m)
    && Math.hypot(x - SPAWN.x, z - SPAWN.z) > 25 && Math.hypot(x - POI.hut.x, z - POI.hut.z) > 14 && terrain.waterLevelAt(x, z) < -1e8;
  const slopeAt = (x, z) => Math.hypot(terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;

  // rock garden in lane C
  for (let k = 0; k < 46; k++) {
    const z = 40 - rnd() * 62, x = LANES.C + (rnd() - 0.5) * 6.4;
    addRock(x, z, 0.28 + rnd() * rnd() * 0.62, 0.66, 0.38);
  }
  // scattered boulders across the map (off the trails and the pad), more on rocky slopes
  let placed = 0;
  for (let tries = 0; tries < 9000 && placed < 260; tries++) {
    const x = (rnd() - 0.5) * (MAP_SIZE - 40), z = (rnd() - 0.5) * (MAP_SIZE - 40);
    if (!clear(x, z, 6)) continue;
    const sl = slopeAt(x, z), rocky = terrain.surfaceId(x, z) === SURF.rock ? 1 : Math.min(1, Math.max(0, (sl - 0.2) / 0.35));
    if (rnd() > 0.3 + 0.7 * rocky) continue;
    const big = rnd() < 0.15 + rocky * 0.15;
    const r = big ? 1.2 + rnd() * 1.4 : 0.35 + rnd() * 0.7;
    // clusters
    addRock(x, z, r, 0.65 + rnd() * 0.3, 0.3);
    if (rnd() < 0.5) for (let c = 0; c < 3; c++) addRock(x + (rnd() - 0.5) * r * 4, z + (rnd() - 0.5) * r * 4, r * (0.3 + rnd() * 0.4), 0.7, 0.35);
    placed++;
  }
  // outcrops: big slabs half buried in the steeper hillsides
  placed = 0;
  for (let tries = 0; tries < 6000 && placed < 55; tries++) {
    const x = (rnd() - 0.5) * (MAP_SIZE - 60), z = (rnd() - 0.5) * (MAP_SIZE - 60);
    if (!clear(x, z, 10)) continue;
    const sl = slopeAt(x, z);
    if (sl < 0.3 || sl > 0.9) continue;
    addRock(x, z, 2.4 + rnd() * 2.2, 0.55 + rnd() * 0.2, 0.5);
    placed++;
  }
  if (rockGeos.length) {
    const merged = mergeGeometries(rockGeos);
    const rocks = new THREE.Mesh(merged, rockMat);
    rocks.castShadow = true; rocks.receiveShadow = true;
    rocks.name = 'boulders';
    group.add(rocks);
  }
  group.userData.rockCount = rockGeos.length;

  buildHut(stream, RAPIER, terrain, group, rockMat, rnd2);

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

  stream.update(SPAWN.x, SPAWN.z);
  return group;
}

// A ruined stone hut off the southern straight of the outer loop: rubble walls with a doorway and a window,
// a gable end with a chimney, two roof beams (one fallen) and stones around. Colliders per wall segment.
function buildHut(stream, RAPIER, terrain, group, stoneMat, rnd) {
  const { x: hx, z: hz, yaw } = POI.hut;
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
      stream.add(wx, wz, RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(wx, gy + y0 + h / 2, wz).setRotation(q).setFriction(0.9), SURFACES.rock);
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
  group.add(mesh);
  // roof beams: one still spanning the gable to the front wall, one fallen inside
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.95, map: makeBarkTexture() });
  const beam = (lx0, ly0, lz0, lx1, ly1, lz1, r) => {
    const [ax, az] = toWorld(lx0, lz0), [bx, bz] = toWorld(lx1, lz1);
    const a = new THREE.Vector3(ax, base + ly0, az), b = new THREE.Vector3(bx, base + ly1, bz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, a.distanceTo(b), 7), beamMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  };
  beam(-W / 2 + 0.2, 3.25, 0, W / 2 - 1.8, 2.15, 0.2, 0.11);
  beam(-1.2, 0.15, -1.6, 1.9, 1.05, 1.5, 0.1);
}
