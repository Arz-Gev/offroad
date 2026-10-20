import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { makeSimplex2D, fbm, smoothstep } from '../../noise.js';
import { MAP_SIZE, N, SURF, FAR_N } from '../../terrain.js';
import { makeSplat, makeGroundData, bakeLand, forestFloor, makePyramid, grassPyramid, windowData } from '../../windowBake.js';
import { PAD, SPAWN, POI, HILL, STREAM, LANES } from './terrain.js';

// The classic map's window data (the same shape as a window of the endless world, windowBake.js), made on the main
// thread at load: its own trees, logs and boulders, placed as they always were (one random sequence each, so the
// forest and the rocks stand where they stood), and its rock kinds by place.

const HALF = MAP_SIZE / 2, NN = N + 1, DN = MAP_SIZE + 1;

// mulberry32 (noise.js) with its state readable: the hut (props.js) carries on the rock shapes' sequence
function rng(seed) {
  const r = () => {
    r.a = (r.a + 0x6D2B79F5) >>> 0;
    let t = r.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.a = seed >>> 0;
  return r;
}

// rock kinds by place: limestone on the big hill, granite on the lookout, sandstone in the quarry, slate in the pine
// forest and up the stream's gorge
const ROCK_REGIONS = [
  { x: HILL.x, z: HILL.z, r0: HILL.r * 0.9, r1: HILL.r * 1.5, k: 0 },
  { x: POI.peak.x, z: POI.peak.z, r0: POI.peak.r * 0.8, r1: POI.peak.r * 1.25, k: 1 / 3 },
  { x: POI.quarry.x, z: POI.quarry.z, r0: 70, r1: 110, k: 2 / 3 },
  { x: POI.forest.x, z: POI.forest.z, r0: 90, r1: 160, k: 1 },
  ...STREAM.slice(0, STREAM.length - 4).map(([x, z]) => ({ x, z, r0: 50, r1: 90, k: 1 })),
];

// ---------------------------------------------------------------- trees and fallen logs
function placeTrees(terrain, dims) {
  const rnd = rng(777);
  const nForest = makeSimplex2D(5), nKind = makeSimplex2D(9);
  const trees = [];
  const lake = terrain.lake, q = POI.quarry;
  const G = 3.4;
  const forestDens = (x, z) => {
    let dens = fbm(nForest, x * 0.0065, z * 0.0065, 4) * 1.6 + 0.05;
    // zones: dense conifer forest to the north, groves round the lake, sparse meadows south
    dens += smoothstep(-160, -260, z) * smoothstep(320, 200, Math.abs(x + 40)) * 0.75;
    dens -= smoothstep(220, 320, z) * smoothstep(-250, -120, x) * 0.3;
    dens += smoothstep(420, 470, Math.max(Math.abs(x), Math.abs(z))) * 0.4;
    if (Math.hypot(x, z) < 170) dens = dens * 0.7 - 0.08;
    return dens;
  };
  const nrm = new THREE.Vector3();
  for (let gx = -HALF + 6; gx < HALF - 6; gx += G) for (let gz = -HALF + 6; gz < HALF - 6; gz += G) {
    const x = gx + (rnd() - 0.5) * G * 0.9, z = gz + (rnd() - 0.5) * G * 0.9;
    const dens = forestDens(x, z);
    const p = smoothstep(0.28, 0.8, dens) * 0.72 + 0.008;
    if (rnd() > p) continue;
    if (terrain.isTrail(x, z, 7.5)) continue;
    if (x > PAD.x0 - 10 && x < PAD.x1 + 10 && z > PAD.z0 - 10 && z < PAD.z1 + 10) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 30) continue;
    if (Math.hypot((x - lake.x) / (lake.rx + 6), (z - lake.z) / (lake.rz + 6)) < 1.05) continue;
    if (Math.hypot((x - q.x) / (q.rx + 4), (z - q.z) / (q.rz + 4)) < 1) continue;
    if (Math.hypot(x - POI.hut.x, z - POI.hut.z) < 16) continue;
    if (terrain.waterLevelAt(x, z) > -1e8) continue;
    const sid = terrain.surfaceId(x, z);
    if (sid === SURF.mud || sid === SURF.sand) continue;
    const y = terrain.surfaceHeight(x, z);
    if (terrain.normalAt(x, z, nrm).y < 0.8) continue;
    // species: birches near water and in the south, pines on high / dry ground, a few snags
    const wet = Math.max(0, 1 - Math.hypot((x - lake.x) / (lake.rx + 70), (z - lake.z) / (lake.rz + 70)));
    const k = nKind(x * 0.01, z * 0.01);
    let vi;
    const roll = rnd();
    if (roll < 0.025) vi = 5;
    else if (roll < 0.06 + wet * 0.6 + smoothstep(150, 300, z) * 0.35 + (k > 0.45 ? 0.2 : 0)) vi = 4;
    else if (y > 30 || k < -0.35 || roll < 0.2) vi = rnd() < 0.5 ? 2 : 3;
    else vi = rnd() < 0.55 ? 0 : 1;
    const s = 0.75 + rnd() * 0.5;
    trees.push({ x, y, z, s, yaw: rnd() * Math.PI * 2, v: vi });
  }

  // lone trees out in the open meadows: big oaks on their own, trees in blossom alone or in little groups
  // (away from the forest, trails, water and each other)
  {
    const OCC = 6, ON = Math.ceil(MAP_SIZE / OCC), occ = new Uint8Array(ON * ON);
    const cellOf = (x, z) => Math.min(ON - 1, Math.max(0, Math.floor((x + HALF) / OCC))) * ON + Math.min(ON - 1, Math.max(0, Math.floor((z + HALF) / OCC)));
    for (const t of trees) occ[cellOf(t.x, t.z)] = 1;
    const free = (x, z, r) => {
      for (let dx = -r; dx <= r; dx += OCC) for (let dz = -r; dz <= r; dz += OCC) if (occ[cellOf(x + dx, z + dz)]) return false;
      return true;
    };
    const ok = (x, z, clear) => {
      if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) return false;
      if (forestDens(x, z) > 0.22 || terrain.isTrail(x, z, clear + 2)) return false;
      if (x > PAD.x0 - 14 && x < PAD.x1 + 14 && z > PAD.z0 - 14 && z < PAD.z1 + 14) return false;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 28) return false;
      if (Math.hypot((x - lake.x) / (lake.rx + 10), (z - lake.z) / (lake.rz + 10)) < 1.05) return false;
      if (Math.hypot((x - q.x) / (q.rx + 6), (z - q.z) / (q.rz + 6)) < 1) return false;
      if (Math.hypot(x - POI.hut.x, z - POI.hut.z) < 18) return false;
      if (terrain.waterLevelAt(x, z) > -1e8 || terrain.surfaceId(x, z) !== SURF.grass) return false;
      return terrain.normalAt(x, z, nrm).y > 0.88 && free(x, z, clear);
    };
    let placed = 0;
    for (let tries = 0; tries < 9000 && placed < 150; tries++) {
      const x = (rnd() - 0.5) * (MAP_SIZE - 60), z = (rnd() - 0.5) * (MAP_SIZE - 60);
      const oak = rnd() < 0.35;
      if (!ok(x, z, oak ? 12 : 8)) continue;
      const n = oak ? 1 : rnd() < 0.4 ? 1 : 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, d = k === 0 ? 0 : 5 + rnd() * 4;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (k > 0 && !ok(px, pz, 4)) continue;
        const vi = oak ? 8 : rnd() < 0.5 ? 6 : 7;
        trees.push({ x: px, y: terrain.surfaceHeight(px, pz), z: pz, s: oak ? 0.85 + rnd() * 0.35 : 0.8 + rnd() * 0.4, yaw: rnd() * Math.PI * 2, v: vi });
        occ[cellOf(px, pz)] = 1;
        placed++;
      }
    }
  }

  // ---- fallen logs on the forest floor (three lengths)
  const LOG_LEN = [4.2, 6.5, 9.0];
  const logs = [];
  let nLogs = 0;
  for (let tries = 0; tries < 20000 && nLogs < 260; tries++) {
    const t = trees[Math.floor(rnd() * trees.length)];
    if (!t || t.v === 4 || t.v >= 6) continue;   // not under birches or the meadow trees (they stand in the open)
    const a = rnd() * Math.PI * 2, d = 2.5 + rnd() * 4;
    const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
    const L = LOG_LEN[Math.floor(rnd() * 3)], yaw = rnd() * Math.PI * 2;
    const dx = Math.sin(yaw) * L / 2, dz = Math.cos(yaw) * L / 2;
    let ok = true;
    for (const f of [-1, 0, 1]) { const px = x + dx * f, pz = z + dz * f; if (terrain.isTrail(px, pz, 6) || terrain.waterLevelAt(px, pz) > -1e8 || Math.abs(px) > HALF - 20 || Math.abs(pz) > HALF - 20) ok = false; }
    if (!ok || (x > PAD.x0 - 10 && x < PAD.x1 + 10 && z > PAD.z0 - 10 && z < PAD.z1 + 10) || Math.hypot(x - POI.hut.x, z - POI.hut.z) < 14) continue;
    const r = 0.14 + rnd() * 0.16 * (L / 6);
    const h0 = terrain.surfaceHeight(x - dx, z - dz), h1 = terrain.surfaceHeight(x + dx, z + dz), hm = terrain.surfaceHeight(x, z);
    if (Math.abs(h1 - h0) > L * 0.45) continue;
    logs.push(x, Math.max((h0 + h1) / 2, hm) + r * 0.8, z, yaw, Math.atan2(h1 - h0, L), r, LOG_LEN.indexOf(L));
    nLogs++;
  }

  // every tree is in the far share (trees.js SUB_FADE): the map ends at its edge, its forest is seen whole
  const T = new Float32Array(trees.length * 7);
  trees.forEach((t, i) => { T.set([t.x, t.y, t.z, t.s, t.yaw, t.v, 1], i * 7); });
  return { list: trees, trees: T, logs: Float32Array.from(logs) };
}

// ---------------------------------------------------------------- boulders
// Shape: an icosphere cut by random planes (chunky broken-rock faces), then noise-displaced; the mesh is pushed out
// onto its convex hull (the collider), so tyres don't float over dents (tools/groundmatch.mjs). rnd: positions and
// sizes, rnd2: the shapes (kept apart so the positions drawn from rnd stay put)
function placeRocks(terrain) {
  const rnd = rng(1234), rnd2 = rng(4321);
  const noise = makeSimplex2D(99);
  const _v = new THREE.Vector3();
  const geos = [], hulls = [];
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
      const c = tint * (0.98 + 0.27 * (vy * 0.5 + 0.5));
      colors[i * 3] = c; colors[i * 3 + 1] = c * 0.97; colors[i * 3 + 2] = c * 0.92;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.rotateY(rnd() * Math.PI * 2);
    g.rotateX((rnd() - 0.5) * 0.4);
    const pts3 = [];
    for (let i = 0; i < pos.count; i++) pts3.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    const hull = new ConvexHull().setFromPoints(pts3);
    const nf = hull.faces.length, fp = new Float64Array(nf * 4);
    const onHull = new Set();
    hull.faces.forEach((f, k) => {
      fp[k * 4] = f.normal.x; fp[k * 4 + 1] = f.normal.y; fp[k * 4 + 2] = f.normal.z; fp[k * 4 + 3] = f.constant;
      let e = f.edge; do { onHull.add(e.vertex.point); e = e.next; } while (e !== f.edge);
    });
    for (let i = 0; i < pts3.length; i++) {
      if (onHull.has(pts3[i])) continue;   // a hull vertex already
      const p = pts3[i];
      let t = Infinity;
      for (let k = 0; k < nf * 4; k += 4) { const d = fp[k] * p.x + fp[k + 1] * p.y + fp[k + 2] * p.z; if (d > 1e-9) { const tt = fp[k + 3] / d; if (tt < t) t = tt; } }
      if (t > 1 && t < 2) pos.setXYZ(i, p.x * t, p.y * t, p.z * t);
    }
    const ground = Math.min(terrain.heightAt(x - sx * 0.5, z), terrain.heightAt(x + sx * 0.5, z), terrain.heightAt(x, z - sz * 0.5), terrain.heightAt(x, z + sz * 0.5), terrain.heightAt(x, z));
    const cy = ground + sy * (1 - sink);
    g.computeVertexNormals();
    hulls.push({ x, y: cy, z, pts: new Float32Array(g.attributes.position.array) });
    g.translate(x, cy, z);
    geos.push(g);
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
  // one buffer, as the window bake hands it over
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3); nrm.set(g.attributes.normal.array, vo * 3); col.set(g.attributes.color.array, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += n; io += gi.length;
    g.dispose();
  }
  return { rocks: { pos, nrm, col, idx, hulls }, hutSeed: rnd2.a };
}

// ---------------------------------------------------------------- the whole bake
// terrain: ClassicTerrain; dims: tree variant dims (treeKinds.js). Returns the window (windowData)
export function bakeClassic(terrain, dims) {
  const splat = makeSplat(terrain);
  const hgt = new Float32Array(DN * DN);
  for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) hgt[z * DN + x] = terrain.heights[Math.min(N, x * 2) * NN + Math.min(N, z * 2)];
  const groundData = makeGroundData(terrain, splat, hgt);
  const wet = new Float32Array(DN * DN);
  for (let i = 0; i < DN * DN; i++) wet[i] = groundData[i * 4 + 2] / 255;
  const landData = bakeLand(terrain, hgt, wet, { dry: [30, 90], slate: false, regions: ROCK_REGIONS });
  const { list, trees, logs } = placeTrees(terrain, dims);
  forestFloor(list, dims, groundData, landData);
  const { rocks, hutSeed } = placeRocks(terrain);
  terrain.sites.find(s => s.type === 'hut').seed = hutSeed;
  // the vista: its heights only (the shader draws its land from noise: FAR_LAND off)
  const FN = FAR_N + 1, farLand = new Float32Array(FN * FN * 4);
  for (let i = 0; i < FN * FN; i++) farLand[i * 4] = terrain.far.heights[i];
  return windowData(terrain, {
    splat, groundData, landData, groundN: DN, trees, farTrees: new Float32Array(0), farLand, logs, rocks,
    pyramid: makePyramid(terrain), grassDens: grassPyramid(groundData),
  });
}
