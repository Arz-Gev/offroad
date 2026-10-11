import * as THREE from 'three';
import { MAP_SIZE, CELL, N } from './terrain.js';
import { mulberry32 } from './noise.js';
import { NEAR_SHADOW_LAYER } from '../render/cascadeShadow.js';

// Small things lying on the ground near the camera, in 3D: stones and pebbles (on the track verges and the edges of
// the strip between the ruts, scree under the rock faces, gravel, stream beds) and what falls from the trees (leaves
// under broadleaves, cones and twigs under conifers, petals under blossom). They give the ground depth in motion:
// they stand up, shade themselves, cast small shadows and slide past with parallax, which no texture does.
// Placed from the terrain's data (trail distance, surface splat, ground and land data, terrainView.js) per 16 m
// chunk the first time the camera comes near, a few chunks a frame, and kept in a cache. Drawn as four instanced
// meshes (stones, pebbles, flat things, sticks) whose buffers are refilled when the camera moves to the next chunk;
// each piece shrinks away towards the edge of its radius, so nothing pops.

const HALF = MAP_SIZE / 2, NN = N + 1;
const CHUNK = 16;
const PER_FRAME = 3;   // chunks generated per frame at most
// per mesh: the radius drawn (m) and the most instances
// blob: stones (an icosphere of 80 faces, casting shadows), pebble: pebbles, small stones and cones (20 faces),
// flat: leaves and petals, stick: twigs
const KINDS = { blob: { r: 40, max: 8000 }, pebble: { r: 26, max: 30000 }, flat: { r: 30, max: 40000 }, stick: { r: 34, max: 6000 } };
const SMALL_SIZE = 0.12;   // stones smaller than this are pebbles
const STRIDE = 12;     // floats per instance: x y z yaw | sx sy sz colour | nx nz seed sink

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const pack = (r, g, b) => Math.round(Math.min(1, r) * 255) + Math.round(Math.min(1, g) * 255) * 256 + Math.round(Math.min(1, b) * 255) * 65536;

// rock colours by kind (as terrainView.js rockTone: limestone, granite, sandstone, slate), linear: light and dark
const ROCK = [[[0.36, 0.34, 0.29], [0.17, 0.16, 0.14]], [[0.34, 0.31, 0.28], [0.16, 0.145, 0.13]], [[0.42, 0.26, 0.14], [0.22, 0.11, 0.055]], [[0.25, 0.24, 0.2], [0.1, 0.1, 0.085]]];
function rockColour(kind, t) {
  const k = Math.max(0, Math.min(0.999, kind)) * 3, i = Math.floor(k), f = k - i, j = Math.min(3, i + 1);
  const c = [0, 1, 2].map(e => {
    const l = ROCK[i][0][e] + (ROCK[j][0][e] - ROCK[i][0][e]) * f, d = ROCK[i][1][e] + (ROCK[j][1][e] - ROCK[i][1][e]) * f;
    return d + (l - d) * t;
  });
  return c;
}
const SOIL = [0.24, 0.16, 0.1];
const DRIFT = [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]];
const LEAVES = [[0.2, 0.1, 0.035], [0.32, 0.2, 0.08], [0.42, 0.3, 0.07], [0.3, 0.12, 0.03], [0.11, 0.16, 0.035], [0.24, 0.16, 0.07]];

// ---------------------------------------------------------------- geometry
function stoneGeometry(detail) {
  // a broken stone: an icosphere pushed out of round and cut by a few planes (flat faces that catch the light),
  // flatter on the bottom
  const g = mergeByPosition(new THREE.IcosahedronGeometry(1, detail));
  const p = g.getAttribute('position'), rnd = mulberry32(77), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).multiplyScalar(0.85 + rnd() * 0.25); p.setXYZ(i, v.x, v.y, v.z); }
  for (let c = 0; c < 4; c++) {
    const n = new THREE.Vector3(rnd() * 2 - 1, rnd() * 1.4 - 0.2, rnd() * 2 - 1).normalize(), d = 0.6 + rnd() * 0.25;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const e = v.dot(n) - d; if (e > 0) { v.addScaledVector(n, -e); p.setXYZ(i, v.x, v.y, v.z); } }
  }
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < -0.3) p.setY(i, -0.3 + (y + 0.3) * 0.25); }
  // shared vertices (flat shading comes from the screen derivatives, materials' flatShading)
  g.computeVertexNormals();
  return g;
}
function mergeByPosition(g) {
  const p = g.getAttribute('position'), map = new Map(), pos = [], idx = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!map.has(key)) { map.set(key, pos.length / 3); pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(map.get(key));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}
function leafGeometry() {
  // a leaf lying on the ground, curled up a little at the edges, along z (-1 stalk .. 1 tip)
  const pos = [0, 0.02, -1, 0, 0, -0.35, 0, 0.02, 0.35, 0, 0.05, 1, -0.45, 0.16, -0.4, 0.45, 0.16, -0.4, -0.38, 0.15, 0.35, 0.38, 0.15, 0.35];
  const idx = [0, 1, 4, 0, 5, 1, 1, 2, 4, 2, 6, 4, 1, 5, 2, 2, 5, 7, 2, 3, 6, 2, 7, 3];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function stickGeometry() {
  // a twig along x (-0.5 .. 0.5), a triangular section of radius 1, lying on the ground, with a side shoot
  const pos = [], idx = [];
  const prism = (x0, x1, z0, z1, r0, r1) => {
    const b = pos.length / 3;
    for (const [x, z, r] of [[x0, z0, r0], [x1, z1, r1]]) for (let k = 0; k < 3; k++) {
      const a = k / 3 * Math.PI * 2;
      pos.push(x, 0.9 + Math.cos(a) * r * 0.9 + 0.1, z + Math.sin(a) * r);
    }
    for (let k = 0; k < 3; k++) { const k1 = (k + 1) % 3; idx.push(b + k, b + 3 + k, b + k1, b + k1, b + 3 + k, b + 3 + k1); }
  };
  prism(-0.5, 0.5, 0, 0.02, 1, 0.7);
  prism(0.05, 0.32, 0.02, 0.2, 0.6, 0.35);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- material
const VERT_PARS = /* glsl */`
attribute vec4 aA, aB, aC;
uniform vec3 uCam;
uniform float uRad;
varying vec3 vDCol;
varying vec3 vDPos;
varying float vDAO;
vec3 dUnpack(float c) { float r = mod(c, 256.0), g = mod(floor(c / 256.0), 256.0), b = floor(c / 65536.0); return vec3(r, g, b) / 255.0; }
`;
// instance -> basis: the piece lies on the ground (its up is the ground normal), turned by its yaw, shrinking away
// towards the edge of the radius
const VERT_BASIS = /* glsl */`
vec3 dUp = normalize(vec3(aC.x, 1.0, aC.y));
vec3 dT = normalize(vec3(cos(aA.w), 0.0, sin(aA.w)));
dT = normalize(dT - dUp * dot(dT, dUp));
vec3 dB = cross(dT, dUp);
// (the smaller the piece the sooner it goes: a 3 cm pebble at ~40 % of the radius)
float dR = uRad * clamp(aB.x / 0.08, 0.35, 1.0);
float dFade = 1.0 - smoothstep(dR * 0.72, dR, distance(aA.xyz, uCam));
vec3 dS = aB.xyz * dFade;
`;

function makeMaterial(kind, uniforms, depth = false) {
  const mat = depth ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: kind === 'flat' ? THREE.DoubleSide : THREE.FrontSide, flatShading: kind === 'blob' || kind === 'pebble' });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS);
    // (the depth material has no normal: the basis goes with the position there)
    if (!depth) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', `${VERT_BASIS}
vec3 objectNormal = normalize(dT * (normal.x / max(aB.x, 1e-4)) + dUp * (normal.y / max(aB.y, 1e-4)) + dB * (normal.z / max(aB.z, 1e-4)));`);
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `${depth ? VERT_BASIS : ''}
vec3 transformed = aA.xyz + dT * (position.x * dS.x) + dUp * (position.y * dS.y - aC.w * aB.y) + dB * (position.z * dS.z);
vDPos = transformed;
vDCol = dUnpack(aB.w);
// (stones sit down among the ground's own relief: less of the sky reaches them, like the ground around)
vDAO = ${kind === 'flat' || kind === 'stick' ? '0.8' : 'mix(0.3, 0.7, smoothstep(-0.3, 0.6, position.y))'};`);
    if (depth) return;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tNoise;
uniform float uWet;
varying vec3 vDCol;
varying vec3 vDPos;
varying float vDAO;`)
      .replace('#include <map_fragment>', `
{
  vec4 nz = texture2D(tNoise, vDPos.xz * 1.7 + vDPos.y * 0.9);
  diffuseColor.rgb *= vDCol * (0.78 + 0.44 * nz.a) * (1.0 - 0.35 * uWet);
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.9, 0.3, uWet);')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= vDAO; reflectedLight.indirectSpecular *= vDAO;');
    if (kind === 'flat') {
      // thin things on the ground: lit like the ground they lie on (both faces up), a touch of light through them
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize(vNormal);
if (normal.z < 0.0) normal = -normal;
vec3 nonPerturbedNormal = normal;`);
    }
  };
  mat.customProgramCacheKey = () => `debris-${kind}${depth ? '-depth' : ''}-v1`;
  return mat;
}

export function buildDebris(terrain, terrainView) {
  const U = terrainView.uniforms;
  const shared = { uCam: { value: new THREE.Vector3() }, tNoise: U.tNoise, uWet: U.uWet };
  const group = new THREE.Group();
  group.name = 'debris';
  const geos = { blob: stoneGeometry(1), pebble: stoneGeometry(0), flat: leafGeometry(), stick: stickGeometry() };
  const meshes = {};
  for (const k of Object.keys(KINDS)) {
    const base = geos[k];
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    g.setIndex(base.getIndex());
    const data = new Float32Array(KINDS[k].max * STRIDE);
    const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('aB', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.setAttribute('aC', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const uniforms = { ...shared, uRad: { value: KINDS[k].r } };
    const m = new THREE.Mesh(g, makeMaterial(k, uniforms));
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    group.add(m);
    if (k === 'blob') {
      // the stones cast shadows into the nearest cascade only, from a twin that only the shadow pass draws
      const sh = new THREE.Mesh(g, m.material);
      sh.layers.set(NEAR_SHADOW_LAYER);
      sh.frustumCulled = false; sh.castShadow = true; sh.receiveShadow = false; sh.matrixAutoUpdate = false;
      sh.customDepthMaterial = makeMaterial(k, uniforms, true);
      group.add(sh);
    }
    meshes[k] = { mesh: m, data, buf, count: 0, rad: uniforms.uRad };
  }

  // ---- placement
  const gd = terrainView.groundData, ld = terrainView.landData, DN = terrainView.groundN;
  const splat = terrainView.splat.image.data;
  const cache = new Map();   // chunk key -> { blob: Float32Array, flat, stick }
  const nrm = new THREE.Vector3();
  function generate(cx, cz) {
    const out = { blob: [], pebble: [], flat: [], stick: [] };
    const rnd = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x5bd1e995);
    const x0 = -HALF + cx * CHUNK, z0 = -HALF + cz * CHUNK;
    const put = (list, x, z, sx, sy, sz, col, sink, yaw = rnd() * Math.PI * 2) => {
      const y = terrain.surfaceHeight(x, z);
      terrain.normalAt(x, z, nrm);
      list.push(x, y, z, yaw, sx, sy, sz, col, nrm.x / nrm.y, nrm.z / nrm.y, rnd(), sink);
    };
    for (let a = 0; a < CHUNK; a++) for (let b = 0; b < CHUNK; b++) {
      const x = x0 + a + 0.5, z = z0 + b + 0.5;
      if (Math.abs(x) > HALF - 2 || Math.abs(z) > HALF - 2) continue;
      const dx = Math.round(x + HALF - 0.5), dz = Math.round(z + HALF - 0.5), o = (dz * DN + dx) * 4;
      const ix = Math.round((x + HALF) / CELL), iz = Math.round((z + HALF) / CELL);
      const so = (iz * NN + ix) * 4;
      const trail = splat[so] / 255, rock = splat[so + 2] / 255, sand = splat[so + 3] / 255, mud = splat[so + 1] / 255;
      const td = terrain.trailDist[ix * NN + iz];
      let forest = gd[o + 1] / 255, litter = ld[o + 2] / 255;
      const wet = gd[o + 2] / 255, grass = gd[o + 3] / 255, scree = ld[o + 1] / 255, kind = ld[o + 3] / 255;
      // stones: verges and the edges of the middle strip, scree, around the rock, on gravel and in stream beds; few in
      // the ruts, none in mud
      // (the verges by the trail distance itself: the dirt surface ends before them)
      const verge = smooth(1.05, 1.5, td) * (1 - smooth(2.4, 3.2, td));
      const crownEdge = smooth(0.15, 0.32, td) * (1 - smooth(0.42, 0.6, td));
      let dStone = verge * 2.6 + trail * (crownEdge * 1.6 + 0.25) + scree * 0.9 + rock * (1 - rock) * 1.5 + sand * 0.8 + wet * sand * 1.2;
      dStone *= (1 - mud) * (1 - 0.6 * grass * (1 - trail) * (1 - verge));
      let n = Math.floor(dStone + rnd());
      for (let k = 0; k < n; k++) {
        const big = rnd() < 0.015 + scree * 0.2 + rock * 0.08, s = big ? 0.1 + rnd() * 0.16 * (1 + scree) : 0.025 + rnd() * 0.07 + rnd() * rnd() * 0.05;
        // the rock's colour, dusted with the soil around it (warmer on the tracks), each stone a little different
        const t = 0.1 + rnd() * 0.6, dust = (trail > 0.3 || verge > 0.3 ? 0.45 : 0.2) + rnd() * 0.3;
        const c = rockColour(kind, t).map((e, k) => (e * (1 - dust) + SOIL[k] * dust) * (0.7 + rnd() * 0.35));
        put(s < SMALL_SIZE ? out.pebble : out.blob, x + rnd() - 0.5, z + rnd() - 0.5, s * (0.8 + rnd() * 0.5), s * (0.45 + rnd() * 0.35), s * (0.8 + rnd() * 0.5), pack(...c), 0.15 + rnd() * 0.2);
      }
      // leaves and petals drift a few metres beyond the crowns (onto the tracks too)
      if (forest < 0.05 && wet < 0.5) for (const [ox, oz] of DRIFT) {
        const xx = Math.min(DN - 1, Math.max(0, dx + ox)), zz = Math.min(DN - 1, Math.max(0, dz + oz)), oo = (zz * DN + xx) * 4;
        const f2 = gd[oo + 1] / 255 * 0.3;
        if (f2 > forest && ld[oo + 2] > 64) { forest = f2; litter = ld[oo + 2] / 255; }
      }
      if (forest > 0.05 && wet < 0.5) {
        if (litter < 0.25) {
          // conifers: cones and twigs
          n = Math.floor(forest * 0.9 + rnd());
          for (let k = 0; k < n; k++) {
            const s = 0.028 + rnd() * 0.018, t = 0.7 + rnd() * 0.5;
            put(out.pebble, x + rnd() - 0.5, z + rnd() - 0.5, s * 1.7, s, s, pack(0.2 * t, 0.11 * t, 0.05 * t), 0.1);
          }
          n = Math.floor(forest * 0.45 + rnd());
          for (let k = 0; k < n; k++) {
            const L = 0.2 + rnd() * 0.5, r = 0.006 + rnd() * 0.01, t = 0.6 + rnd() * 0.6;
            put(out.stick, x + rnd() - 0.5, z + rnd() - 0.5, L, r, r, pack(0.16 * t, 0.11 * t, 0.07 * t), 0.2);
          }
        } else if (litter < 0.75) {
          // broadleaves: leaves (on the track too), a few twigs
          n = Math.floor(forest * 7 + rnd());
          for (let k = 0; k < n; k++) {
            const s = 0.035 + rnd() * 0.035, c = LEAVES[Math.floor(rnd() * LEAVES.length)], t = 0.75 + rnd() * 0.5;
            put(out.flat, x + rnd() - 0.5, z + rnd() - 0.5, s * 0.75, s, s, pack(c[0] * t, c[1] * t, c[2] * t), 0);
          }
          n = Math.floor(forest * 0.3 + rnd());
          for (let k = 0; k < n; k++) {
            const L = 0.25 + rnd() * 0.6, r = 0.008 + rnd() * 0.012, t = 0.6 + rnd() * 0.5;
            put(out.stick, x + rnd() - 0.5, z + rnd() - 0.5, L, r, r, pack(0.2 * t, 0.15 * t, 0.1 * t), 0.2);
          }
        } else {
          // blossom: petals
          n = Math.floor(forest * 14 + rnd());
          for (let k = 0; k < n; k++) {
            const s = 0.012 + rnd() * 0.008, t = rnd();
            put(out.flat, x + rnd() - 0.5, z + rnd() - 0.5, s * 0.8, s, s, pack(0.85 - t * 0.1, 0.5 + t * 0.3, 0.6 + t * 0.25), 0);
          }
        }
      }
    }
    return { blob: Float32Array.from(out.blob), pebble: Float32Array.from(out.pebble), flat: Float32Array.from(out.flat), stick: Float32Array.from(out.stick) };
  }

  // ---- per frame: generate the chunks coming into reach, refill the buffers when the camera changes chunk
  const NC = MAP_SIZE / CHUNK, REACH = Math.max(...Object.values(KINDS).map(k => k.r));
  let lastKey = '', dirty = true, enabled = true, radiusScale = 1;
  const want = [];
  function refill(cxC, czC) {
    for (const k of Object.keys(KINDS)) {
      const M = meshes[k], R = KINDS[k].r * radiusScale, rc = Math.ceil(R / CHUNK) + 1;
      let n = 0;
      for (let a = -rc; a <= rc; a++) for (let b = -rc; b <= rc; b++) {
        const c = cache.get((cxC + a) * NC + czC + b), src = c?.[k];
        if (!src?.length || n + src.length > M.data.length) continue;
        M.data.set(src, n); n += src.length;
      }
      M.count = n / STRIDE;
      M.mesh.geometry.instanceCount = M.count;
      M.buf.clearUpdateRanges(); M.buf.addUpdateRange(0, n); M.buf.needsUpdate = true;
      M.rad.value = R;
    }
  }

  return {
    group,
    get count() { return Object.values(meshes).reduce((n, M) => n + M.count, 0); },
    configure(q) {
      enabled = q.vegetation !== false && (q.bushes ?? 1) > 0 && q.veg !== 'off';
      group.visible = enabled;
      radiusScale = Math.min(1.25, Math.max(0.6, q.bushDist ?? 1));
      dirty = true;
    },
    update(dt, camera) {
      if (!enabled) return;
      const p = camera.position;
      shared.uCam.value.copy(p);
      const cxC = Math.floor((p.x + HALF) / CHUNK), czC = Math.floor((p.z + HALF) / CHUNK);
      // generate what is missing, nearest first
      const rc = Math.ceil(REACH * radiusScale / CHUNK) + 2;
      want.length = 0;
      for (let a = -rc; a <= rc; a++) for (let b = -rc; b <= rc; b++) {
        const cx = cxC + a, cz = czC + b;
        if (cx < 0 || cz < 0 || cx >= NC || cz >= NC || cache.has(cx * NC + cz)) continue;
        want.push([a * a + b * b, cx, cz]);
      }
      if (want.length) {
        want.sort((u, v) => u[0] - v[0]);
        for (let i = 0; i < Math.min(PER_FRAME, want.length); i++) { cache.set(want[i][1] * NC + want[i][2], generate(want[i][1], want[i][2])); dirty = true; }
      }
      const key = cxC + ',' + czC;
      if (key !== lastKey || dirty) {
        lastKey = key; dirty = false;
        refill(cxC, czC);
        // drop chunks far behind
        if (cache.size > 900) for (const ck of cache.keys()) {
          const cx = Math.floor(ck / NC), cz = ck % NC;
          if (Math.abs(cx - cxC) > rc + 6 || Math.abs(cz - czC) > rc + 6) cache.delete(ck);
        }
      }
    },
  };
}
