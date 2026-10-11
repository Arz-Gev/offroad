import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { MAP_SIZE, CELL, N, SURF, FAR_SIZE, FAR_CELL, HILL, POI, STREAM } from './terrain.js';
import { bakeGroundLayers, LAYER, LAYER_COUNT, LAYER_TILE } from './textures.js';
import { makeSimplex2D, fbm } from './noise.js';

// Terrain renderer: CDLOD over the 1 km physics map and the 8 km render-only vista, drawn as one instanced grid
// patch (32x32 quads; level k has vertex spacing 0.5 * 2^k m). The CPU walks a quadtree each frame (frustum culled,
// ~150-300 patches) and writes one instance per patch.
// - The vertex shader reads heights from the physics heightfield (R32F texture); level 0 uses Rapier's cell split, so
//   wheels sit exactly on what you see. Odd vertices morph to the next level near each range limit (no cracks / pops).
// - Per-pixel normals come from a GPU-baked normal texture, so far patches keep full-resolution shading.
// - Material: seven ground layers (texture arrays, textures.js) blended by surface map, slope, canopy, trail distance
//   and height, with offset anti-tiling and distance LOD, coloured by the land data (bakeLand: lush or dry ground,
//   scree, litter, rock kind); rock of four kinds in beds, triplanar over the baked block and slab structures.
// - Two draws: patches with rock in reach use the full material, the rest a build without the rock code.

const P = 32;                         // quads per patch side
const LEVELS = 10;                    // 16 m ... 8192 m patches
const HALF = MAP_SIZE / 2, NN = N + 1;
const FAR_HALF = FAR_SIZE / 2, FN = FAR_SIZE / FAR_CELL + 1;

const NORMAL_FRAG = /* glsl */`
precision highp float;
uniform highp sampler2D tH, tTrail;
uniform float uN, uCell, uHasTrail;
varying vec2 vUv;
float h(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uN) - 1)); return texelFetch(tH, ivec2(g.y, g.x), 0).r; }
void main() {
  ivec2 g = ivec2(floor(vUv * uN));
  float dx = h(g + ivec2(1, 0)) - h(g - ivec2(1, 0));
  float dz = h(g + ivec2(0, 1)) - h(g - ivec2(0, 1));
  vec3 n = normalize(vec3(-dx, 2.0 * uCell, -dz));
  // sky visibility: how much of the sky the terrain around hides (the horizon in 8 directions, out to ~35 m), so
  // gullies, the feet of slopes and cliffs and the floors of pits sit in their own soft shade
  float h0 = h(g), vis = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.785398 + 0.39;
    vec2 dir = vec2(cos(a), sin(a));
    float mx = 0.0, r = 1.0;
    for (int s = 0; s < 10; s++) {
      mx = max(mx, (h(g + ivec2(round(dir * r))) - h0) / (r * uCell));
      r *= 1.6;
    }
    vis += 1.0 - mx * inversesqrt(1.0 + mx * mx);
  }
  // a: distance to the nearest trail centreline / 6 m
  float trail = uHasTrail > 0.5 ? texelFetch(tTrail, ivec2(g.y, g.x), 0).r : 1.0;
  gl_FragColor = vec4(n.x * 0.5 + 0.5, n.z * 0.5 + 0.5, vis / 8.0, trail);
}`;

function bakeNormalTexture(renderer, heightTex, n, cell, trailTex = null) {
  const rt = new THREE.WebGLRenderTarget(n, n, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NORMAL_FRAG, depthTest: false, depthWrite: false,
    uniforms: { tH: { value: heightTex }, tTrail: { value: trailTex }, uHasTrail: { value: trailTex ? 1 : 0 }, uN: { value: n }, uCell: { value: cell } },
  });
  const q = new FullScreenQuad(mat), prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); q.render(renderer); renderer.setRenderTarget(prev);
  mat.dispose(); q.dispose();
  return rt.texture;
}

function floatTex(data, n) {
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// separable box blur with running sums (O(1) per texel whatever the radius), in place over n x n x c
function boxBlur(src, n, ch, r) {
  const tmp = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    const a = pass === 0 ? src : tmp, b = pass === 0 ? tmp : src;
    for (let line = 0; line < n; line++) for (let c = 0; c < ch; c++) {
      let s = 0;
      const at = k => { k = Math.max(0, Math.min(n - 1, k)); return pass === 0 ? a[(line * n + k) * ch + c] : a[(k * n + line) * ch + c]; };
      for (let k = -r; k <= r; k++) s += at(k);
      for (let k = 0; k < n; k++) {
        const o = pass === 0 ? (line * n + k) * ch + c : (k * n + line) * ch + c;
        b[o] = s / (2 * r + 1);
        s += at(k + r + 1) - at(k - r);
      }
    }
  }
  return src;
}

// the same box blur on 8-bit data, in place, all channels per texel (cache-friendly), integer running sums
function blurU8(data, n, ch, r) {
  const tmp = new Uint8Array(data.length);
  const w = 2 * r + 1, line = new Int32Array((n + 2 * r + 1) * ch);
  for (let pass = 0; pass < 2; pass++) {
    const a = pass === 0 ? data : tmp, b = pass === 0 ? tmp : data;
    const step = pass === 0 ? ch : n * ch, lineStep = pass === 0 ? n * ch : ch;
    for (let L = 0; L < n; L++) {
      const base = L * lineStep;
      for (let k = -r; k < n + r + 1; k++) {
        const kk = k < 0 ? 0 : k >= n ? n - 1 : k, src = base + kk * step, dst = (k + r) * ch;
        for (let c = 0; c < ch; c++) line[dst + c] = a[src + c];
      }
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let k = 0; k < w; k++) sum += line[k * ch + c];
        for (let k = 0; k < n; k++) {
          b[base + k * step + c] = (sum + (w >> 1)) / w;
          sum += line[(k + w) * ch + c] - line[k * ch + c];
        }
      }
    }
  }
  return data;
}

// Land data at 1 m, from the shape of the ground (texel x, z at z * DN + x):
//   r lushness: 0 dry, golden (ridges, sunny slopes, high ground) .. 1 deep green (drainage lines, hollows, by water)
//   g scree: debris rolled down from the rock faces, fanning out below them and coming to rest where the slope eases
//   b litter under the trees (written by trees.js): 0 needles, 0.5 leaves, 1 petals
//   a rock kind: 0 limestone, 1/3 granite, 2/3 sandstone, 1 slate
function bakeLand(terrain, hgt, DN, wet) {
  const NN = N + 1, M = (DN - 1) / 2 + 1, sst = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // ---- flow on a 2 m grid: multiple flow directions (each cell sheds to all its lower neighbours by slope), cells
  // taken highest first; the debris rides the same flow
  const h2 = new Float32Array(M * M), sl2 = new Float32Array(M * M), rock2 = new Float32Array(M * M);
  for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) h2[z * M + x] = hgt[2 * z * DN + 2 * x];
  for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) {
    const H = (a, b) => h2[Math.max(0, Math.min(M - 1, b)) * M + Math.max(0, Math.min(M - 1, a))];
    const s = Math.hypot(H(x + 1, z) - H(x - 1, z), H(x, z + 1) - H(x, z - 1)) / 4;
    sl2[z * M + x] = s;
    const surf = terrain.surface[Math.min(N, 4 * x) * NN + Math.min(N, 4 * z)];
    rock2[z * M + x] = Math.max(surf === SURF.rock ? 1 : 0, sst(0.8, 1.15, s));
  }
  const order = new Uint32Array(M * M);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => h2[b] - h2[a]);
  const acc = new Float32Array(M * M).fill(1), scree = new Float32Array(M * M);
  const NX = [1, -1, 0, 0, 1, 1, -1, -1], NZ = [0, 0, 1, -1, 1, -1, 1, -1], ND = [2, 2, 2, 2, 2.83, 2.83, 2.83, 2.83];
  const wk = new Float32Array(8);
  for (let k = 0; k < order.length; k++) {
    const i = order[k], x = i % M, z = (i - x) / M, h = h2[i];
    let sum = 0;
    for (let n = 0; n < 8; n++) {
      const xx = x + NX[n], zz = z + NZ[n];
      wk[n] = 0;
      if (xx < 0 || zz < 0 || xx >= M || zz >= M) continue;
      const dh = h - h2[zz * M + xx];
      if (dh > 0) { wk[n] = Math.pow(dh / ND[n], 1.1); sum += wk[n]; }
    }
    const sc = scree[i] = Math.max(scree[i], rock2[i]);
    if (sum === 0) continue;
    const a = acc[i] / sum;
    for (let n = 0; n < 8; n++) if (wk[n] > 0) {
      const j = (z + NZ[n]) * M + x + NX[n];
      acc[j] += a * wk[n];
      scree[j] = Math.max(scree[j], sc * (0.7 + 0.26 * sst(0.12, 0.6, sl2[j])));
    }
  }
  const at2 = (arr, fx, fz) => {
    const x0 = Math.min(M - 2, Math.floor(fx)), z0 = Math.min(M - 2, Math.floor(fz)), tx = fx - x0, tz = fz - z0, o = z0 * M + x0;
    return (arr[o] * (1 - tx) + arr[o + 1] * tx) * (1 - tz) + (arr[o + M] * (1 - tx) + arr[o + M + 1] * tx) * tz;
  };
  for (let i = 0; i < acc.length; i++) { acc[i] = Math.log2(acc[i]); scree[i] *= 1 - rock2[i] * 0.7; }
  boxBlur(acc, M, 1, 1);
  boxBlur(scree, M, 1, 1);
  // ---- hollows and ridges (height against its surroundings at two scales), water nearby
  const b1 = boxBlur(Float32Array.from(hgt), DN, 1, 5), b2 = boxBlur(Float32Array.from(hgt), DN, 1, 22);
  const near = boxBlur(Float32Array.from(wet), DN, 1, 9);
  // ---- rock kinds by region: limestone or granite by large patches, limestone on the big hill, granite on the
  // lookout, sandstone in the quarry, slate in the pine forest and up the stream's gorge
  const kn = makeSimplex2D(9137);
  const regions = [
    { x: HILL.x, z: HILL.z, r0: HILL.r * 0.9, r1: HILL.r * 1.5, k: 0 },
    { x: POI.peak.x, z: POI.peak.z, r0: POI.peak.r * 0.8, r1: POI.peak.r * 1.25, k: 1 / 3 },
    { x: POI.quarry.x, z: POI.quarry.z, r0: 70, r1: 110, k: 2 / 3 },
    { x: POI.forest.x, z: POI.forest.z, r0: 90, r1: 160, k: 1 },
  ];
  for (let k = 0; k < STREAM.length - 4; k++) regions.push({ x: STREAM[k][0], z: STREAM[k][1], r0: 50, r1: 90, k: 1 });
  const out = new Uint8Array(DN * DN * 4);
  for (let z = 0; z < DN; z++) for (let x = 0; x < DN; x++) {
    const i = z * DN + x, wx = -HALF + x, wz = -HALF + z, h = hgt[i];
    const H = (a, b) => hgt[Math.max(0, Math.min(DN - 1, b)) * DN + Math.max(0, Math.min(DN - 1, a))];
    const gx = (H(x + 1, z) - H(x - 1, z)) / 2, gz = (H(x, z + 1) - H(x, z - 1)) / 2, slope = Math.hypot(gx, gz);
    // the side facing the midday sun (south: azimuth 155.7 deg from +z towards +x) dries out
    const sunny = Math.max(-1, Math.min(1, (-gx * 0.41 + gz * 0.91) * 2.2));
    const drain = sst(5.5, 11, at2(acc, x / 2, z / 2));
    const hollow = Math.max(-1, Math.min(1, (b1[i] - h) * 0.7 + (b2[i] - h) * 0.12));
    const n = fbm(kn, wx * 0.006, wz * 0.006, 3);
    const lush = 0.5 + 0.34 * drain + 0.3 * hollow - 0.2 * sunny + 0.45 * near[i] - 0.2 * sst(0.35, 0.9, slope)
      - 0.2 * sst(30, 90, h) + 0.22 * n;
    out[i * 4] = Math.round(255 * Math.max(0, Math.min(1, lush)));
    out[i * 4 + 1] = Math.round(255 * Math.max(0, Math.min(1, at2(scree, x / 2, z / 2) * 1.15)));
    let kw = 1, ks = fbm(kn, wx * 0.0021 + 31, wz * 0.0021, 2) > 0.05 ? 1 / 3 : 0;
    for (const r of regions) {
      const d = Math.hypot(wx - r.x, wz - r.z);
      if (d < r.r1) { const w = sst(r.r1, r.r0, d) * 4; kw += w; ks += w * r.k; }
    }
    out[i * 4 + 3] = Math.round(255 * ks / kw);
  }
  return out;
}

export function buildTerrainView(terrain, renderer, opts = {}) {
  const layers = bakeGroundLayers(renderer, opts.layerSize || 1024, opts.anisotropy || 8, opts.photos);

  // ---- height textures (data layout ix * n + iz: the shader swaps the fetch coordinates)
  const hTex = floatTex(terrain.heights, NN);
  // linear filtering lets the grass read a smooth height with one fetch (texelFetch ignores it)
  const floatLinear = !!renderer.extensions.has('OES_texture_float_linear');
  if (floatLinear) { hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; }
  const fTex = floatTex(terrain.far.heights, FN);
  // trail distance (0..6 m in 8 bits, same layout as the heights) for the ruts, verges and the grass between the ruts
  const trailData = new Uint8Array(NN * NN);
  for (let i = 0; i < NN * NN; i++) trailData[i] = Math.round(255 * Math.min(1, terrain.trailDist[i] / 6));
  const trailTex = new THREE.DataTexture(trailData, NN, NN, THREE.RedFormat, THREE.UnsignedByteType);
  trailTex.unpackAlignment = 1;
  trailTex.needsUpdate = true;
  const nTex = bakeNormalTexture(renderer, hTex, NN, CELL, trailTex);
  trailTex.dispose();

  // ---- splat (dirt, mud, rock, sand), blurred; texel (ix, iz) natural orientation
  const splatData = new Uint8Array(NN * NN * 4);
  for (let ix = 0; ix < NN; ix++) for (let iz = 0; iz < NN; iz++) {
    const s = terrain.surface[ix * NN + iz];
    const o = (iz * NN + ix) * 4;
    if (s === SURF.dirt) splatData[o] = 255; else if (s === SURF.mud) splatData[o + 1] = 255; else if (s === SURF.rock) splatData[o + 2] = 255; else if (s === SURF.sand) splatData[o + 3] = 255;
  }
  blurU8(splatData, NN, 4, 2);
  blurU8(splatData, NN, 4, 1);
  const splat = new THREE.DataTexture(splatData, NN, NN, THREE.RGBAFormat);
  splat.magFilter = THREE.LinearFilter; splat.minFilter = THREE.LinearMipmapLinearFilter; splat.generateMipmaps = true;
  splat.needsUpdate = true;

  // ---- ground data at 1 m: r = ambient occlusion under the canopy (trees.js; the terrain's own is the normal map's
  // sky visibility), g = forest floor, b = wetness, a = grass density
  const DN = MAP_SIZE + 1;
  const groundData = new Uint8Array(DN * DN * 4);
  let landData;
  {
    const hgt = new Float32Array(DN * DN);
    for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) hgt[z * DN + x] = terrain.heights[Math.min(N, x * 2) * NN + Math.min(N, z * 2)];
    for (let i = 0; i < DN * DN; i++) groundData[i * 4] = 255;
    // grass density: grass surfaces only (from the blurred splat), thinning on slopes, natural clearings
    const clr = makeSimplex2D(4711);
    for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) {
      const ix = Math.min(N, x * 2), iz = Math.min(N, z * 2);
      const o = (iz * NN + ix) * 4;
      const other = (splatData[o] + splatData[o + 1] + splatData[o + 2] + splatData[o + 3]) / 255;
      const h = (a, b) => hgt[Math.max(0, Math.min(DN - 1, b)) * DN + Math.max(0, Math.min(DN - 1, a))];
      const slope = Math.hypot(h(x + 1, z) - h(x - 1, z), h(x, z + 1) - h(x, z - 1)) / 2;
      const wx = -HALF + x, wz = -HALF + z;
      const c = fbm(clr, wx * 0.035, wz * 0.035, 3) + 0.5 * fbm(clr, wx * 0.11 + 7, wz * 0.11, 2);
      // ragged edges where the grass meets bare ground (tufts out into it, bites into the grass), not a clean line
      const rag = fbm(clr, wx * 0.45 + 11, wz * 0.45, 2);
      let d = Math.max(0, Math.min(1, 1 - (other + rag * 0.45) * 2.5));
      // a strip of grass between the wheel ruts, broken where the trail is busier
      const td = terrain.trailDist[ix * NN + iz];
      if (td < 0.5) d = Math.max(d, (1 - td / 0.5) * 0.75 * Math.max(0, Math.min(1, (fbm(clr, wx * 0.07 + 3, wz * 0.07, 2) + 0.2) / 0.3)));
      d *= 1 - Math.max(0, Math.min(1, (slope - 0.35) / 0.25));
      d *= Math.max(0, Math.min(1, (c + 0.45) / 0.35));
      groundData[(z * DN + x) * 4 + 3] = Math.round(255 * d);
    }
    // wetness next to water (only around the water bodies; waterLevelAt is too slow for 1 M texels)
    const wetAt = (x, z, wl) => {
      if (x < 0 || z < 0 || x >= DN || z >= DN) return;
      const o = (z * DN + x) * 4 + 2, h = hgt[z * DN + x];
      groundData[o] = Math.max(groundData[o], Math.round(255 * Math.min(1, Math.max(0, 1 - (h - wl) / 0.8))));
    };
    for (const w of terrain.water) {
      if (w.type !== 'stream') {
        for (let x = Math.floor(w.x - w.rx * 1.3 + HALF); x <= w.x + w.rx * 1.3 + HALF; x++)
          for (let z = Math.floor(w.z - w.rz * 1.3 + HALF); z <= w.z + w.rz * 1.3 + HALF; z++) wetAt(x, z, w.level);
      } else {
        for (let k = 0; k < w.pts.length; k += 2) {
          const p = w.pts[k], r = Math.ceil(w.width[k] + 3);
          for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) wetAt(Math.round(p.x + HALF) + dx, Math.round(p.z + HALF) + dz, w.level[k]);
        }
      }
    }
    const wet = new Float32Array(DN * DN);
    for (let i = 0; i < DN * DN; i++) wet[i] = groundData[i * 4 + 2] / 255;
    landData = bakeLand(terrain, hgt, DN, wet);
  }
  const dataTex = new THREE.DataTexture(groundData, DN, DN, THREE.RGBAFormat);
  dataTex.magFilter = THREE.LinearFilter; dataTex.minFilter = THREE.LinearMipmapLinearFilter; dataTex.generateMipmaps = true;
  dataTex.needsUpdate = true;
  const landTex = new THREE.DataTexture(landData, DN, DN, THREE.RGBAFormat);
  landTex.magFilter = THREE.LinearFilter; landTex.minFilter = THREE.LinearMipmapLinearFilter; landTex.generateMipmaps = true;
  landTex.needsUpdate = true;

  // ---- patch geometry: (P+1)^2 grid of integer coordinates, Rapier's diagonal (x1,z0)-(x0,z1)
  const V = P + 1;
  const pos = new Float32Array(V * V * 3);
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) { const o = (i * V + j) * 3; pos[o] = i; pos[o + 1] = 0; pos[o + 2] = j; }
  const idx = [];
  for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) {
    const v00 = a * V + b, v10 = (a + 1) * V + b, v01 = a * V + b + 1, v11 = (a + 1) * V + b + 1;
    idx.push(v00, v01, v10, v10, v01, v11);
  }
  // two lists of patches: those with rock in reach draw with the full material, the rest with a lighter build of it
  // without the rock (its code alone, even where no pixel runs it, slowed every terrain pixel by ~40 %)
  const MAX_INST = 2048;
  const posAttr = new THREE.BufferAttribute(pos, 3), lists = [];
  for (let l = 0; l < 2; l++) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', posAttr);
    geo.setIndex(idx);
    const data = new Float32Array(MAX_INST * 4), sent = new Float32Array(MAX_INST * 4);   // sent: last uploaded
    const attr = new THREE.InstancedBufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPatch', attr);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    lists.push({ geo, data, sent, attr, count: 0 });
  }

  // ---- material
  const morph = Array.from({ length: LEVELS }, () => new THREE.Vector2());
  const uniforms = {
    tHeight: { value: hTex }, tFarHeight: { value: fTex }, tNrm: { value: nTex }, tLand: { value: landTex },
    tSplat: { value: splat }, tData: { value: dataTex }, tAlb: { value: layers.albedo }, tLNrm: { value: layers.normal },
    tNoise: { value: opts.noise || null },
    uMorph: { value: morph }, uCamXZ: { value: new THREE.Vector2() },
    uMap: { value: new THREE.Vector4(HALF, CELL, NN, MAP_SIZE) }, uFar: { value: new THREE.Vector4(FAR_HALF, FAR_CELL, FN, 0) },
    uTile: { value: LAYER_TILE.map(t => 1 / t) }, uAvg: { value: layers.avg }, uDetail: { value: 2 },
    uWet: { value: 0 }, uDew: { value: 0 }, uTrack: { value: null }, uTrackOrigin: { value: new THREE.Vector2() }, uTrackSize: { value: 64 },
    uSnow: { value: 330 },
  };
  const onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPatch;
uniform highp sampler2D tHeight, tFarHeight;
uniform vec2 uMorph[${LEVELS}];
uniform vec2 uCamXZ;
uniform vec4 uMap, uFar;
varying vec3 vWPos;
varying vec3 vFarN;
float tHgtNear(vec2 xz) {
  ivec2 g = ivec2(round((xz + uMap.x) / uMap.y));
  g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1));
  return texelFetch(tHeight, ivec2(g.y, g.x), 0).r;
}
float tHgtFar(vec2 xz) {
  vec2 f = clamp((xz + uFar.x) / uFar.y, vec2(0.0), vec2(uFar.z - 1.001));
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float a = texelFetch(tFarHeight, ivec2(i.y, i.x), 0).r, b = texelFetch(tFarHeight, ivec2(i.y, i.x + 1), 0).r;
  float c = texelFetch(tFarHeight, ivec2(i.y + 1, i.x), 0).r, d = texelFetch(tFarHeight, ivec2(i.y + 1, i.x + 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
float tHgt(vec2 xz) { return max(abs(xz.x), abs(xz.y)) <= uMap.x + 0.01 ? tHgtNear(xz) : tHgtFar(xz); }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
vec2 gIdx = position.xz;
float stp = aPatch.z;
vec2 wxz = aPatch.xy + gIdx * stp;
vec2 mm = uMorph[int(aPatch.w)];
float morphK = clamp((distance(wxz, uCamXZ) - mm.x) * mm.y, 0.0, 1.0);
vec2 frac2 = fract(gIdx * 0.5) * 2.0;
vec2 txz = aPatch.xy + (gIdx - frac2) * stp;
float h0 = tHgt(wxz);
float h1 = (frac2.x + frac2.y) > 0.0 ? tHgt(txz) : h0;
vec3 transformed = vec3(mix(wxz, txz, morphK), mix(h0, h1, morphK)).xzy;
vWPos = transformed;
// the vista's normal, per vertex (its heights are a 16 m grid; per pixel it cost four float fetches)
vFarN = vec3(0.0, 1.0, 0.0);
if (max(abs(transformed.x), abs(transformed.z)) > uMap.x - 48.0) {
  float e = uFar.y;
  vec2 q = transformed.xz;
  vFarN = vec3(tHgtFar(q - vec2(e, 0.0)) - tHgtFar(q + vec2(e, 0.0)), 2.0 * e, tHgtFar(q - vec2(0.0, e)) - tHgtFar(q + vec2(0.0, e)));
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2D tNrm, tSplat, tData, tLand, tNoise, uTrack;
uniform sampler2DArray tAlb, tLNrm;
uniform vec4 uMap, uFar;
uniform float uTile[${LAYER_COUNT}];
uniform vec3 uAvg[${LAYER_COUNT}];   // each layer's average colour
uniform float uDetail, uWet, uTrackSize, uSnow;
uniform vec2 uTrackOrigin;
varying vec3 vWPos;
varying vec3 vFarN;
float gRough; float gAO; float gCav; vec3 gN; float gWet; float gPomSh = 1.0;
vec2 gDx, gDy;   // screen derivatives of the world xz (taken in uniform control flow)
vec3 gDpx, gDpy;
float gVar;      // anti-tiling: a low-frequency noise that picks each region's tile offset
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
const vec2 SUN_SIDE = vec2(0.41, -0.91);   // the midday sun's side (south), xz
// one layer, planar (xz). Each region of the ground reads the tile at its own offset; where the noise steps to the
// next offset the two are blended, favouring the higher texel (after Inigo Quilez, "texture repetition")
void layerAt(float l, vec2 xz, bool two, out vec4 alb, out vec4 nrm) {
  float t = uTile[int(l)];
  vec2 uv = xz * t, dx = gDx * t, dy = gDy * t;
  float k = gVar * 7.0, i = floor(k), f = fract(k);
  float b = uDetail > 0.5 ? smoothstep(0.3, 0.7, f) : 0.0;
  vec2 oa = uDetail > 0.5 ? sin(vec2(3.0, 7.0) * i) : vec2(0.0), ob = sin(vec2(3.0, 7.0) * (i + 1.0));
  if (!two) { if (b > 0.5) oa = ob; b = 0.0; }
  if (b < 0.999) { alb = textureGrad(tAlb, vec3(uv + oa, l), dx, dy); nrm = textureGrad(tLNrm, vec3(uv + oa, l), dx, dy); }
  if (b > 0.001) {
    vec4 a2 = textureGrad(tAlb, vec3(uv + ob, l), dx, dy), n2 = textureGrad(tLNrm, vec3(uv + ob, l), dx, dy);
    if (b >= 0.999) { alb = a2; nrm = n2; }
    else {
      b = clamp(b + (a2.a - alb.a) * b * (1.0 - b) * 3.0, 0.0, 1.0);
      alb = mix(alb, a2, b); nrm = mix(nrm, n2, b);
    }
  }
}
// parallax occlusion near the camera: the dominant layer's height (its alpha, top 1) as relief below the surface,
// depth m deep, marched along the view ray V. Returns the xz where the ray meets it; hitD its depth (0 top .. 1)
vec2 pomAt(float l, vec2 xz, vec3 V, float depth, out float hitD) {
  float t = uTile[int(l)];
  vec2 oa = uDetail > 0.5 ? sin(vec2(3.0, 7.0) * floor(gVar * 7.0)) : vec2(0.0);   // the region's tile offset (layerAt)
  vec2 dxz = V.xz / max(-V.y, 0.25) * depth / 6.0;
  vec2 cur = xz; float d = 0.0;
  float h = 1.0 - textureGrad(tAlb, vec3(cur * t + oa, l), gDx * t, gDy * t).a;
  hitD = 0.0;
  if (h <= 0.0) return xz;
  float ph = h, pd = 0.0;
  for (int s = 0; s < 6; s++) {
    ph = h; pd = d;
    cur += dxz; d += 1.0 / 6.0;
    h = 1.0 - textureGrad(tAlb, vec3(cur * t + oa, l), gDx * t, gDy * t).a;
    if (d >= h) break;
  }
  // between the last two samples, where the ray crossed the relief
  float f = (ph - pd) / max((ph - pd) - (h - d), 1e-4);
  hitD = mix(pd, d, f);
  return cur - dxz * (1.0 - f);
}
// the relief's own shadow at the hit: does it rise above the ray towards the sun (Lw, world)?
float pomShadow(float l, vec2 xz, float hitD, vec3 Lw, float depth) {
  if (Lw.y < 0.05 || hitD <= 0.0) return 1.0;
  float t = uTile[int(l)];
  vec2 oa = uDetail > 0.5 ? sin(vec2(3.0, 7.0) * floor(gVar * 7.0)) : vec2(0.0);
  vec2 dir = Lw.xz / max(Lw.y, 0.12) * depth;
  float sh = 0.0;
  for (int s = 1; s <= 3; s++) {
    float f = float(s) / 3.0 * hitD;
    float dS = 1.0 - textureGrad(tAlb, vec3((xz + dir * f) * t + oa, l), gDx * t, gDy * t).a;
    sh = max(sh, (hitD - f - dS) * 6.0);
  }
  return 1.0 - clamp(sh, 0.0, 1.0) * 0.85;
}
// tangent-space detail normal (xy in [-1, 1]) on a base normal, planar xz projection (whiteout blend)
vec3 onPlanar(vec2 tn, vec3 n0) {
  float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
  return normalize(vec3(tn.x + n0.x, tz * n0.y, tn.y + n0.z));
}
// triplanar layer: albedo (rgba), material (rough, cavity in b, a) and the world normal on n0. Projections are
// mirrored on the negative side so the lighting reads the same way round on every face (Ben Golus' whiteout blend)
void triAt(float l, float t, vec3 p, vec3 n0, vec3 w, float nk, out vec4 alb, out vec4 mat, out vec3 nW) {
  vec3 sg = vec3(n0.x < 0.0 ? -1.0 : 1.0, n0.y < 0.0 ? -1.0 : 1.0, n0.z < 0.0 ? -1.0 : 1.0);
  alb = vec4(0.0); mat = vec4(0.0); vec3 acc = vec3(0.0); float ws = 0.0;
  if (w.x > 0.03) {
    vec2 uv = vec2(p.z * sg.x, p.y) * t, dx = vec2(gDpx.z * sg.x, gDpx.y) * t, dy = vec2(gDpy.z * sg.x, gDpy.y) * t;
    vec4 a = textureGrad(tAlb, vec3(uv, l), dx, dy), m = textureGrad(tLNrm, vec3(uv, l), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= sg.x;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tz * n0.x, tn.y + n0.y, tn.x + n0.z) * w.x; alb += a * w.x; mat += m * w.x; ws += w.x;
  }
  if (w.y > 0.03) {
    vec2 uv = vec2(p.x * sg.y, p.z) * t, dx = vec2(gDpx.x * sg.y, gDpx.z) * t, dy = vec2(gDpy.x * sg.y, gDpy.z) * t;
    vec4 a = textureGrad(tAlb, vec3(uv, l), dx, dy), m = textureGrad(tLNrm, vec3(uv, l), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= sg.y;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tn.x + n0.x, tz * n0.y, tn.y + n0.z) * w.y; alb += a * w.y; mat += m * w.y; ws += w.y;
  }
  if (w.z > 0.03) {
    vec2 uv = vec2(-p.x * sg.z, p.y) * t, dx = vec2(-gDpx.x * sg.z, gDpx.y) * t, dy = vec2(-gDpy.x * sg.z, gDpy.y) * t;
    vec4 a = textureGrad(tAlb, vec3(uv, l), dx, dy), m = textureGrad(tLNrm, vec3(uv, l), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= -sg.z;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tn.x + n0.x, tn.y + n0.y, tz * n0.z) * w.z; alb += a * w.z; mat += m * w.z; ws += w.z;
  }
  alb /= ws; mat /= ws; nW = normalize(acc);
}
// the colour of a ground layer by the land (a multiplier on its texture), worked out only for the layers drawn:
// - the meadow: golden on dry ridges and sunny slopes, deep green down the drainage lines, in hollows and by water,
//   with patches of clover (blue-green) and of thin, sun-bleached grass
// - soils: warmer or greyer by region, darker where damp; scree takes the colour of the rock above it
// - forest floor: mossy where damp; under broadleaves a warmer litter, under blossom a pink one
vec3 rockTone(float k, float t);
vec3 tintOf(float l, float lush, vec4 nzP, float mac2, float kind, float kScree, float litter) {
  if (l < 0.5) {
    vec3 g = lush < 0.5 ? mix(vec3(0.27, 0.22, 0.075), vec3(0.13, 0.2, 0.05), lush * 2.0) : mix(vec3(0.13, 0.2, 0.05), vec3(0.055, 0.13, 0.035), lush * 2.0 - 1.0);
    g = mix(g, vec3(0.065, 0.15, 0.075), smoothstep(0.62, 0.72, nzP.r) * 0.55);
    g = mix(g, vec3(0.3, 0.26, 0.12), smoothstep(0.64, 0.76, nzP.g) * smoothstep(0.55, 0.25, lush) * 0.7);
    return g / vec3(0.13, 0.2, 0.05);
  }
  if (l < 3.5 || l > 5.5) return mix(vec3(1.08, 0.98, 0.88), vec3(0.9, 0.95, 1.02), mac2) * (1.08 - 0.22 * lush) * (l > 2.5 && l < 3.5 ? 0.95 : 1.0);
  if (l < 4.5) return mix(vec3(1.0), rockTone(kind, 0.55) / max(uAvg[4], vec3(0.02)), kScree * 0.75);
  return mix(vec3(1.0), vec3(0.75, 0.95, 0.6), smoothstep(0.55, 0.85, lush + (nzP.b - 0.5) * 0.5) * 0.6)
    * mix(vec3(1.0), mix(vec3(1.15, 0.98, 0.78), vec3(1.2, 0.98, 1.0), step(0.75, litter)), step(0.25, litter));
}
// ---- rock. Kinds (k: 0 limestone, 1/3 granite, 2/3 sandstone, 1 slate) differ in colour, bedding and weathering.
// light and dark tones of each kind (linear)
// (weights of the four kinds: hat functions, so the blends are branch-free matrix products)
vec4 kindW(float k) { return max(1.0 - abs(vec4(clamp(k, 0.0, 1.0) * 3.0) - vec4(0.0, 1.0, 2.0, 3.0)), 0.0); }
const mat4x3 ROCK_L = mat4x3(0.36, 0.34, 0.29, 0.34, 0.31, 0.28, 0.42, 0.26, 0.14, 0.28, 0.27, 0.23);
const mat4x3 ROCK_D = mat4x3(0.17, 0.16, 0.14, 0.16, 0.145, 0.13, 0.22, 0.11, 0.055, 0.13, 0.125, 0.105);
vec3 rockTone(float k, float t) { vec4 w = kindW(k); return mix(ROCK_D * w, ROCK_L * w, t); }
// bedding by kind: band height (m), relief of the ledges, tone contrast between beds, joint spacing (m)
const mat4 BEDS = mat4(2.2, 0.55, 0.45, 2.6, 4.5, 0.25, 0.25, 3.5, 0.9, 0.9, 0.75, 1.8, 0.55, 0.5, 0.35, 0.9);
vec4 bedOf(float k) { return BEDS * kindW(k); }
// the rock's structure (textures.js layers 8, 9), triplanar: on the faces the rows of blocks follow the beds (v: the
// bedding coordinate sY, 8 beds to the tile; u along the face, 6 joint spacings jw to the tile), from above the slabs
// (12 m tile). alb: tone, joint, streak, height; mat: normal xy, roughness, cavity; nW: the normal on n0
void structAt(vec3 p, vec3 n0, vec3 w, float sY, vec2 sYd, float jw, float nk, out vec4 alb, out vec4 mat, out vec3 nW) {
  vec3 sg = vec3(n0.x < 0.0 ? -1.0 : 1.0, n0.y < 0.0 ? -1.0 : 1.0, n0.z < 0.0 ? -1.0 : 1.0);
  alb = vec4(0.0); mat = vec4(0.0); vec3 acc = vec3(0.0); float ws = 0.0;
  float su = 1.0 / (jw * 6.0);
  if (w.x > 0.03) {
    vec2 uv = vec2(p.z * sg.x * su, sY * 0.125), dx = vec2(gDpx.z * sg.x * su, sYd.x * 0.125), dy = vec2(gDpy.z * sg.x * su, sYd.y * 0.125);
    vec4 a = textureGrad(tAlb, vec3(uv, ${LAYER.blocks}.0), dx, dy), m = textureGrad(tLNrm, vec3(uv, ${LAYER.blocks}.0), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= sg.x;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tz * n0.x, tn.y + n0.y, tn.x + n0.z) * w.x; alb += a * w.x; mat += m * w.x; ws += w.x;
  }
  if (w.y > 0.03) {
    vec2 uv = vec2(p.x * sg.y, p.z) / 12.0, dx = vec2(gDpx.x * sg.y, gDpx.z) / 12.0, dy = vec2(gDpy.x * sg.y, gDpy.z) / 12.0;
    vec4 a = textureGrad(tAlb, vec3(uv, ${LAYER.slabs}.0), dx, dy), m = textureGrad(tLNrm, vec3(uv, ${LAYER.slabs}.0), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= sg.y;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tn.x + n0.x, tz * n0.y, tn.y + n0.z) * w.y; alb += a * w.y; mat += m * w.y; ws += w.y;
  }
  if (w.z > 0.03) {
    vec2 uv = vec2(-p.x * sg.z * su, sY * 0.125), dx = vec2(-gDpx.x * sg.z * su, sYd.x * 0.125), dy = vec2(-gDpy.x * sg.z * su, sYd.y * 0.125);
    vec4 a = textureGrad(tAlb, vec3(uv, ${LAYER.blocks}.0), dx, dy), m = textureGrad(tLNrm, vec3(uv, ${LAYER.blocks}.0), dx, dy);
    vec2 tn = (m.xy * 2.0 - 1.0) * nk; tn.x *= -sg.z;
    float tz = sqrt(max(1.0 - dot(tn, tn), 0.0));
    acc += vec3(tn.x + n0.x, tn.y + n0.y, tz * n0.z) * w.z; alb += a * w.z; mat += m * w.z; ws += w.z;
  }
  alb /= ws; mat /= ws; nW = normalize(acc);
}
// rock at p on the heightfield normal n0: colour, normal, height (for blending), cavity, roughness, moss.
// sY: the bedding coordinate (height / bed height, warped), sYd its screen derivatives, sF its filter width (all taken
// in uniform flow)
void rockAt(vec3 p, vec3 n0, float dist, float nk, float kind, float lush, float sY, vec2 sYd, float sF, float sY2,
            out vec3 col, out vec3 nW, out float h, out float cav, out float rough, out float moss) {
  vec4 bed = bedOf(kind);
  vec3 w = pow(abs(n0), vec3(8.0)); w /= w.x + w.y + w.z;
  // weathering: large blotches of lighter and darker rock
  vec4 ma = textureGrad(tNoise, (p.xz + p.y * 0.7) / 19.0, gDx / 19.0, gDy / 19.0);
  float photo = 0.65 + 0.7 * ma.g;
  // the structure: blocks and joints on the faces, slabs from above
  vec4 sa, sm;
  structAt(p, n0, w, sY, sYd, bed.w, nk, sa, sm, nW);
  float steep = smoothstep(0.92, 0.6, n0.y);
  vec3 hn = normalize(vec3(n0.x, 0.0, n0.z) + vec3(1e-4, 0.0, 0.0));
  // beds: each one with its own tone and hardness; the harder ones stand out, so where the next bed juts out further
  // the face turns down under it (in shade), where it steps back the bed's top is a ledge (lit, mossy)
  float far = smoothstep(0.3, 0.7, sF);
  float bi = floor(sY), bf = fract(sY);
  float hb = hash11(bi), hN = hash11(bi + 1.0);
  float tone = mix(0.5, hb, bed.z * (1.0 - far)) * 0.6 + hash11(floor(sY2) * 3.1 + 7.0) * 0.4;
  float tb = smoothstep(0.8, 1.0, bf), bell = 4.0 * tb * (1.0 - tb);
  float dr = (hN - hb) * bed.y;
  float ledge = max(-dr, 0.0) * bell * 2.5 * steep, under = max(dr, 0.0) * bell * 2.5 * steep;
  nW = normalize(nW + vec3(0.0, 1.0, 0.0) * ((hb - 0.5) * 0.5 * bed.y + ledge * 1.6 - under * 1.6) * steep * (1.0 - far) * nk);
  float sand = smoothstep(0.45, 0.67, kind) * smoothstep(0.9, 0.7, kind);
  col = rockTone(kind, clamp(tone + (sa.r - 0.5) * 0.35, 0.0, 1.0)) * mix(1.0, photo, 0.5 - 0.25 * sand);
  // sandstone beds run from cream to ochre to rust
  col = mix(col, vec3(0.4, 0.33, 0.22) * (0.85 + 0.3 * hash11(bi * 2.3)), sand * step(0.68, hash11(bi + 17.0)) * (1.0 - far) * 0.8);
  col *= (1.0 - 0.6 * sa.g) * (1.0 - 0.35 * under);
  // streaks: dark (limestone, granite, slate) or rusty (sandstone), from the lip of each ledge down the bed below
  vec3 stain = mix(vec3(0.42, 0.42, 0.44), vec3(0.8, 0.5, 0.3), sand);
  col = mix(col, col * stain, sa.b * steep * 0.85);
  // lichen: colonies of spots, pale grey-green on limestone and granite, with orange and yellow on the sunny side
  vec4 lh = textureGrad(tNoise, p.xz / 2.3 + p.y * 0.31, gDx / 2.3, gDy / 2.3);
  float lich = smoothstep(0.5, 0.62, lh.r * 0.55 + lh.a * 0.45) * mix(1.0, 0.5, far);
  float sunSide = clamp(dot(hn.xz, SUN_SIDE), 0.0, 1.0);
  vec3 lc = mix(vec3(0.4, 0.42, 0.36), vec3(0.3, 0.31, 0.16), smoothstep(0.45, 0.6, lh.g));
  lc = mix(lc, vec3(0.45, 0.22, 0.06), smoothstep(0.62, 0.7, lh.b) * (0.3 + 0.7 * sunSide) * step(0.2, kind));
  float lichK = kind < 0.333 ? mix(0.55, 0.85, kind * 3.0) : mix(0.85, 0.15, clamp((kind - 0.333) * 3.0, 0.0, 1.0));
  col = mix(col, lc, lich * lichK * (1.0 - sa.g) * (1.0 - smoothstep(0.75, 0.95, nW.y) * 0.5));
  h = clamp(sa.a * 0.7 + ma.a * 0.3 + ledge * 0.3, 0.0, 1.0);
  cav = sm.a * (1.0 - 0.5 * under);
  rough = mix(sm.b, 0.92, 0.5);
  // close up, the rock-face photo's grain and cracks (~0.2-0.5 ms where there is rock near; the 30 m cliff photo under
  // it cost three times that for colour blotches the land already gives)
  float det = uDetail > 0.5 ? 1.0 - smoothstep(20.0, 50.0, dist) : 0.0;
  if (det > 0.0) {
    vec4 da, dm; vec3 dn;
    triAt(${LAYER.rock}.0, uTile[${LAYER.rock}], p, nW, w, nk, da, dm, dn);
    col *= mix(1.0, clamp(lum(da.rgb) / lum(uAvg[${LAYER.rock}]), 0.4, 1.8), det * 0.7);
    nW = normalize(mix(nW, dn, det * 0.6));
    h = mix(h, h * 0.5 + da.a * 0.5, det); cav = mix(cav, cav * dm.a, det);
  }
  // moss: where it stays damp: ledges and flat tops, the shady side, crevices, damp ground (lushness), rain
  float north = clamp(-dot(hn.xz, SUN_SIDE), 0.0, 1.0) * steep;
  vec4 mn = textureGrad(tNoise, p.xz / 5.3 + p.y * 0.07, gDx / 5.3, gDy / 5.3);
  // (sunny tops get lichen, not moss)
  float drive = lush * 0.55 + north * 0.35 + ledge * 1.2 + smoothstep(0.55, 0.85, nW.y) * 0.35 + (1.0 - cav) * 0.25 + sa.g * 0.3 + uWet * 0.2
    + smoothstep(0.75, 1.0, kind) * 0.25 - clamp(dot(n0.xz, SUN_SIDE) * 2.0, 0.0, 1.0) * 0.25 - 0.62;
  moss = smoothstep(0.0, 0.18, drive + (mn.r - 0.5) * 0.5 + (ma.a - 0.5) * 0.3);
  // cushions: darker in the gaps between them, olive to deep green, a little brighter when wet
  float cush = textureGrad(tNoise, p.xz / 0.9 + p.y * 0.37, gDx / 0.9, gDy / 0.9).a;
  vec3 mossCol = mix(vec3(0.03, 0.06, 0.014), vec3(0.085, 0.11, 0.028), mn.g) * (0.55 + 0.75 * cush) * (1.0 + 0.3 * uWet);
  col = mix(col, mossCol, moss);
  rough = mix(rough, 0.97, moss);
  nW = normalize(mix(nW, n0, moss * 0.25));
}`)
      .replace('#include <map_fragment>', `
{
  vec3 p = vWPos;
  gDpx = dFdx(p); gDpy = dFdy(p);
  gDx = gDpx.xz; gDy = gDpy.xz;
  float dist = length(p - cameraPosition);
  bool inMap = max(abs(p.x), abs(p.z)) < uMap.x;
  // heightfield normal + sky visibility + trail distance, surface splat, ground and land data (sampled
  // unconditionally: mip selection needs uniform flow)
  vec2 uvN = ((p.xz + uMap.x) / uMap.y + 0.5) / uMap.z;
  vec4 nt = texture2D(tNrm, uvN);
  vec4 sp = texture2D(tSplat, uvN);
  vec2 uvD = (p.xz + uMap.x + 0.5) / (uMap.w + 1.0);
  vec4 gd = texture2D(tData, uvD);
  vec4 ld = texture2D(tLand, uvD);
  vec4 nz0 = texture2D(tNoise, p.xz / 23.0);
  vec4 nzP = texture2D(tNoise, p.xz / 53.0 + 0.61);
  // macro variation (large scale) to break everything up; wq warps the rock beds
  vec4 m4 = texture2D(tNoise, p.xz / 300.0);
  float mac = m4.r;
  vec2 wq = m4.gb;
  float mac2 = texture2D(tNoise, p.xz / 97.0 + 0.3).g;
  vec3 nG;
  if (inMap) {
    nG = vec3(nt.r * 2.0 - 1.0, 0.0, nt.g * 2.0 - 1.0);
    nG.y = sqrt(max(0.0, 1.0 - nG.x * nG.x - nG.z * nG.z));
  } else {
    // vista: normals from its heights plus procedural detail (its heightmap is only 16 m); lushness and rock kind
    // from noise: higher is drier and stonier
    nG = normalize(vFarN);
    vec4 dz1 = textureGrad(tNoise, p.xz / 41.0, gDx / 41.0, gDy / 41.0), dz2 = textureGrad(tNoise, p.xz / 13.0 + 0.5, gDx / 13.0, gDy / 13.0);
    nG = normalize(nG + vec3(dz1.r - 0.5, 0.0, dz1.g - 0.5) * 0.7 + vec3(dz2.b - 0.5, 0.0, dz2.a - 0.5) * 0.35);
    sp = vec4(0.0); gd = vec4(1.0, 0.0, 0.0, 1.0); nt.b = 1.0;
    ld = vec4(clamp(0.45 + (mac2 - 0.5) * 0.8 - smoothstep(120.0, 320.0, p.y) * 0.35 - dot(nG.xz, SUN_SIDE) * 0.4, 0.0, 1.0), 0.0, 0.0,
              smoothstep(0.4, 0.6, mac) * 0.333 + smoothstep(0.62, 0.72, wq.g) * 0.4);
  }
  float td = inMap ? nt.a * 6.0 : 6.0;
  float vis = nt.b;
  float kind = ld.a, lush = ld.r;
  gVar = nz0.a;
  // bedding of the rock (in uniform flow: its filter width comes from the screen derivatives): warped, dipping
  vec4 bed = bedOf(kind);
  vec2 dip = vec2(0.035, -0.02);
  float sY = (p.y + (wq.x - 0.5) * 14.0 + dot(p.xz, dip)) / bed.x;
  vec2 sYd = vec2(dFdx(sY), dFdy(sY));
  float sF = abs(sYd.x) + abs(sYd.y);
  float sY2 = sY / 7.0;
  // layer weights
  float slope = 1.0 - nG.y;
  float wRock = max(sp.b, smoothstep(0.24, 0.36, slope + (mac2 - 0.5) * 0.08));
  float wMud = sp.g, wTrail = sp.r;
  float wScree = ld.g * (1.0 - wTrail) * (1.0 - wMud);
  float wSand = max(sp.a, wScree), kScree = wScree / max(wSand, 1e-3);
  // trails: compacted dirt in the wheel ruts, loose soil on the verges, grass between the ruts (where it grows:
  // the grass density)
  float rut = exp(-pow((td - 0.8) / 0.3, 2.0)) * wTrail;
  float verge = smoothstep(1.2, 2.3, td + (nz0.r - 0.5) * 0.8) * (1.0 - smoothstep(2.6, 3.2, td));
  float crown = smoothstep(0.5, 0.2, td) * smoothstep(0.05, 0.4, gd.a);
  float wDirt = wTrail * (1.0 - 0.8 * verge) * (1.0 - 0.85 * crown);
  float wSoil = wTrail * 0.8 * verge + smoothstep(0.17, 0.28, slope + (mac - 0.5) * 0.1) * 0.5 * (1.0 - wRock) * (1.0 - wTrail) * (1.0 - wScree);
  float wForest = gd.g * (1.0 - wTrail) * (1.0 - wMud);
  if (!inMap) wForest = smoothstep(0.35, 0.65, mac2) * smoothstep(0.32, 0.18, slope) * smoothstep(260.0, 120.0, p.y);
  float wGrass = max(0.0, 1.0 - wDirt - wMud - wSand - wForest - wSoil);
  // colour of each layer by the land. The meadow: golden on dry ridges and sunny slopes, deep green down the drainage
  // lines, in hollows and by water, with patches of clover (blue-green) and of thin, sun-bleached grass
  #define TINT(L) tintOf(L, lush, nzP, mac2, kind, kScree, ld.b)
  // the two strongest layers, height-blended (more would cost registers and samples for little gain)
  float w1 = wGrass, l1 = 0.0, w2 = 0.0, l2 = 0.0;
  #define TOP2(W, L) if (W > w1) { w2 = w1; l2 = l1; w1 = W; l1 = L; } else if (W > w2) { w2 = W; l2 = L; }
  TOP2(wDirt, 1.0) TOP2(wMud, 3.0) TOP2(wSand, 4.0) TOP2(wForest, 5.0) TOP2(wSoil, 6.0)
  // detail normals fade out far away (mips average them anyway; this keeps them from sparkling)
  float nk = 1.0 - smoothstep(90.0, 320.0, dist);
  vec3 c; vec4 nn; float hgt = 0.5;
  vec3 nW = nG;
  if (dist < 600.0) {
    bool two = dist < 160.0;
    vec4 a1, n1, a2, n2;
    // near the camera the ground has depth: parallax occlusion on the dominant layer, with its own sun shadow
    vec2 pxz = p.xz;
    // (not on the meadow: the grass covers it)
    float pomK = (uDetail > 1.5 && l1 > 0.5 ? 1.0 - smoothstep(4.0, 8.0, dist) : 0.0) * (1.0 - smoothstep(0.3, 0.6, wRock));
    if (pomK > 0.0) {
      float pomD;
      pxz = mix(p.xz, pomAt(l1, p.xz, normalize(p - cameraPosition), 0.05, pomD), pomK);
      #if NUM_SUN_LIGHTS > 0
      gPomSh = mix(1.0, pomShadow(l1, pxz, pomD, normalize((vec4(sunLights[0].direction, 0.0) * viewMatrix).xyz), 0.05), pomK);
      #endif
    }
    layerAt(l1, pxz, two, a1, n1);
    a1.rgb *= TINT(l1);
    if (w2 > 0.02) {
      layerAt(l2, pxz, two, a2, n2);
      a2.rgb *= TINT(l2);
      float h1 = a1.a + w1 * 1.2, h2 = a2.a + w2 * 1.2, hm = max(h1, h2) - 0.35;
      float b1 = max(h1 - hm, 0.0) * w1, b2 = max(h2 - hm, 0.0) * w2;
      float k = b2 / max(b1 + b2, 1e-4);
      c = mix(a1.rgb, a2.rgb, k); nn = mix(n1, n2, k); hgt = mix(a1.a, a2.a, k);
    } else { c = a1.rgb; nn = n1; hgt = a1.a; }
    // the ruts are packed hard by the wheels: darker, smoother, with a dull sheen
    nn.xy = mix(nn.xy, vec2(0.5), rut * 0.45);
    c *= 1.0 - 0.1 * rut;
    nn.b = mix(nn.b, 0.6, rut * 0.6);
    // dried mud cracks into curled plates (the slab structure, small): round the mud holes and in the low spots of the
    // trails, when it hasn't rained
    float dryMud = (wMud * (1.0 - smoothstep(0.3, 0.6, gd.b)) + wTrail * smoothstep(0.6, 0.72, nzP.a) * 0.6) * (1.0 - uWet) * (1.0 - smoothstep(25.0, 45.0, dist));
    if (dryMud > 0.02) {
      vec2 cuv = p.xz / 1.4;
      vec4 ca = textureGrad(tAlb, vec3(cuv, ${LAYER.slabs}.0), gDx / 1.4, gDy / 1.4), cn = textureGrad(tLNrm, vec3(cuv, ${LAYER.slabs}.0), gDx / 1.4, gDy / 1.4);
      c = mix(c, c * mix(1.25, 0.45, ca.g) * vec3(1.12, 1.0, 0.86), dryMud);
      nn = mix(nn, vec4(cn.xy, 0.9, cn.a), dryMud * 0.8);
      hgt = mix(hgt, ca.a, dryMud);
    }
    nW = onPlanar((nn.xy * 2.0 - 1.0) * nk, nG);
    // close up, the tyres' tread runs along the ruts (the trail's direction: across the gradient of the trail
    // distance), fresh in places and worn away in others
    if (rut > 0.05 && dist < 30.0) {
      vec2 e = vec2(1.0 / uMap.z, 0.0);
      vec2 tg = vec2(textureLod(tNrm, uvN + e, 0.0).a - textureLod(tNrm, uvN - e, 0.0).a, textureLod(tNrm, uvN + e.yx, 0.0).a - textureLod(tNrm, uvN - e.yx, 0.0).a);
      if (dot(tg, tg) > 1e-6) {
        vec2 dir = normalize(vec2(-tg.y, tg.x));
        float q = dot(p.xz, dir) / 0.11 + abs(td - 0.8) * 3.0;
        float fq = (abs(dot(gDx, dir)) + abs(dot(gDy, dir))) / 0.11;
        float tread = rut * (1.0 - smoothstep(0.1, 0.16, abs(td - 0.8))) * smoothstep(0.35, 0.65, nzP.b) * (1.0 - smoothstep(0.25, 0.6, fq));
        #define TREAD(x) (smoothstep(0.55, 0.62, x) * (1.0 - smoothstep(0.88, 0.95, x)))
        float gq = fract(q), groove = TREAD(gq), dg = TREAD(gq + 0.02) - TREAD(gq - 0.02);
        c *= 1.0 - 0.18 * groove * tread;
        nW = normalize(nW + vec3(dir.x, 0.0, dir.y) * dg * 1.2 * tread);
      }
    }
  } else {
    // far away: the layers' average colours (their last mip)
    vec3 tSoil = TINT(1.0);
    c = uAvg[0] * TINT(0.0) * wGrass + (uAvg[1] * wDirt + uAvg[3] * wMud * 0.95 + uAvg[6] * wSoil) * tSoil
      + uAvg[4] * TINT(4.0) * wSand + uAvg[5] * TINT(5.0) * wForest;
    c /= max(1e-3, wGrass + wDirt + wMud + wSand + wForest + wSoil);
    nn = vec4(0.5, 0.5, 0.9, 1.0);
  }
  // rock: blended in by height (it stands proud of the soil around it)
  float kRock = 0.0, rMoss = 0.0;
  if (wRock > 0.01) {
    vec3 rc, rn; float rh, rcav, rrough;
    #ifndef NO_ROCK
    if (dist < 600.0) rockAt(p, nG, dist, nk, kind, lush, sY, sYd, sF, sY2, rc, rn, rh, rcav, rrough, rMoss);
    else
    #endif
    {
      // far: the kind's colour by the coarse beds, a little moss on the gentler, damper parts
      rc = rockTone(kind, hash11(floor(sY2) * 3.1 + 7.0) * 0.6 + 0.2);
      rMoss = smoothstep(0.55, 0.9, lush + nG.y * 0.4 - 0.25) * 0.6;
      rc = mix(rc, vec3(0.07, 0.11, 0.03), rMoss);
      rn = nG; rh = 0.5; rcav = 1.0; rrough = 0.85;
    }
    float hR = rh + wRock * 1.3, hB = hgt + (1.0 - wRock) * 1.3, hm = max(hR, hB) - 0.3;
    float bR = max(hR - hm, 0.0) * wRock, bB = max(hB - hm, 0.0) * (1.0 - wRock);
    kRock = bR / max(bR + bB, 1e-4);
    c = mix(c, rc, kRock); nW = normalize(mix(nW, rn, kRock));
    nn = mix(nn, vec4(0.5, 0.5, rrough, rcav), kRock); hgt = mix(hgt, rh, kRock);
  }
  // vista snow on high flats
  if (!inMap) {
    float snow = smoothstep(uSnow, uSnow + 60.0, p.y + (mac - 0.5) * 80.0) * smoothstep(0.55, 0.3, slope);
    c = mix(c, vec3(0.42, 0.44, 0.48), snow * 0.8);
  }
  // macro brightness variation
  c *= 0.9 + 0.2 * mac2;
  // tyre tracks darken (and wet) the ground
  vec2 tuv = (p.xz - uTrackOrigin) / uTrackSize + 0.5;
  float track = inMap ? texture2D(uTrack, tuv).r : 0.0;
  c *= 1.0 - track * 0.3;
  // wetness: shore, mud, rain. Soil drinks it in and goes dark and saturated, rock much less
  // after rain the ground dries unevenly: rock, slopes and ridges first (they shed the water), hollows, ruts, mud and
  // the shade under the trees last, in patches
  float hold = clamp(0.55 + 0.4 * (lush - 0.5) + 0.3 * rut + 0.3 * wMud + 0.25 * gd.g - 0.45 * kRock - 0.8 * slope + (nz0.g - 0.5) * 0.6, 0.0, 1.0);
  float rainWet = smoothstep(0.0, 0.3, uWet - (1.0 - hold) * 0.6);
  gWet = clamp(max(gd.b * 0.9, rainWet) + wMud * 0.4 + track * wMud * 0.4, 0.0, 1.0);
  float soak = gWet * (1.0 - 0.55 * kRock * (1.0 - rMoss));
  c *= 1.0 - 0.42 * soak;
  c = max(mix(vec3(lum(c)), c, 1.0 + 0.3 * soak), 0.0);
  gRough = mix(nn.b, mix(0.42 - 0.12 * hgt, 0.3, kRock * (1.0 - rMoss)), gWet * 0.9);
  // rain (uWet): water stands in the ruts, between the stones and in the low flat patches: dark, mirror smooth
  float pud = 0.0;
  if (uWet > 0.0) {
    // (the puddles shrink as the ground dries: the threshold rises)
    float basin = smoothstep(0.62, 0.7, texture2D(tNoise, p.xz / 4.5 + 0.71).b + (0.5 - mac2) * 0.2 - (1.0 - uWet) * 0.12);
    float inRut = rut * smoothstep(0.3, 0.55, nz0.b + (0.5 - hgt) * 0.4);
    float pock = smoothstep(0.3, 0.15, hgt - 0.25 * uWet);
    pud = uWet * max(max(basin, inRut), pock) * smoothstep(0.45, 0.85, wTrail + wMud + wSoil + wSand * 0.5)
        * smoothstep(0.1, 0.03, slope) * (1.0 - kRock) * (1.0 - smoothstep(80.0, 220.0, dist));
  }
  c *= 1.0 - 0.3 * pud;
  gRough = mix(gRough, 0.03, pud);
  // ambient occlusion: the sky the terrain hides, canopy, texture cavities (gCav also shadows the direct light:
  // microshadows)
  gCav = mix(nn.a, 1.0, pud);
  gAO = gd.r * mix(1.0, gCav, 0.8) * mix(1.0, vis * vis, 0.85);
  gN = normalize(mix(nW, nG, pud * 0.9));
  diffuseColor.rgb *= c;
}`)

      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_begin>', `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;`)
      .replace('#include <normal_fragment_maps>', '')
      .replace('#include <aomap_fragment>', `
#if NUM_SUN_LIGHTS > 0
// light bounced off the sunlit ground onto slopes and rock faces (the sky probe has no ground below it): warm, by how
// far the surface turns from the sky; without it a face in shade was lit by the blue sky alone
reflectedLight.indirectDiffuse += diffuseColor.rgb * sunLights[0].color * vec3(1.0, 0.85, 0.65)
  * (max((vec4(sunLights[0].direction, 0.0) * viewMatrix).y, 0.0) * 0.25 * (1.0 - gN.y) * 0.5 * RECIPROCAL_PI);
#endif
reflectedLight.indirectDiffuse *= gAO;
reflectedLight.indirectSpecular *= gAO;
#if NUM_SUN_LIGHTS > 0
{
  // microshadows: the texture's crevices stay dark when the sun skims across them (Uncharted 4's approximation),
  // and the parallax relief's own shadow
  float nl = dot(normal, sunLights[0].direction);
  float ms = clamp(abs(nl) + 2.0 * gCav * gCav - 1.0, 0.0, 1.0) * gPomSh;
  reflectedLight.directDiffuse *= ms; reflectedLight.directSpecular *= ms;
}
#endif`);
  };
  const makeMaterial = (lite) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    m.userData.uniforms = uniforms;
    m.onBeforeCompile = onBeforeCompile;
    m.defines = { CLOUD_TIGHT: '', ...(lite ? { NO_ROCK: '' } : {}) };   // CLOUD_TIGHT: at the 16-texture limit with the lamps' cookies (clouds.js)
    m.customProgramCacheKey = () => 'terrain-cdlod-v4' + (lite ? '-lite' : '');
    return m;
  };
  const material = makeMaterial(false), materialLite = makeMaterial(true);
  const mesh = new THREE.Group();
  for (const [l, mat] of [[0, material], [1, materialLite]]) {
    const m = new THREE.Mesh(lists[l].geo, mat);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    mesh.add(m);
  }
  mesh.name = 'terrain';

  // ---- min/max height pyramid at 16 m cells for culling
  const L0 = FAR_SIZE / 16; // 512 cells
  const mins = [], maxs = [], rocks = [];
  {
    const mn = new Float32Array(L0 * L0), mx = new Float32Array(L0 * L0);
    for (let cx = 0; cx < L0; cx++) for (let cz = 0; cz < L0; cz++) {
      const x0 = -FAR_HALF + cx * 16, z0 = -FAR_HALF + cz * 16;
      let lo = 1e9, hi = -1e9;
      if (x0 >= -HALF && x0 + 16 <= HALF && z0 >= -HALF && z0 + 16 <= HALF) {
        const ix0 = Math.round((x0 + HALF) / CELL), iz0 = Math.round((z0 + HALF) / CELL);
        for (let a = 0; a <= 32; a += 2) for (let b = 0; b <= 32; b += 2) { const h = terrain.heights[(ix0 + a) * NN + iz0 + b]; if (h < lo) lo = h; if (h > hi) hi = h; }
        lo -= 0.5; hi += 0.5;
      } else {
        for (const [a, b] of [[0, 0], [16, 0], [0, 16], [16, 16], [8, 8]]) { const h = terrain.surfaceHeight(x0 + a, z0 + b); lo = Math.min(lo, h); hi = Math.max(hi, h); }
        lo -= 6; hi += 6;
      }
      mn[cz * L0 + cx] = lo; mx[cz * L0 + cx] = hi;
    }
    mins.push(mn); maxs.push(mx);
    // rock within the cell (or 2 m around it): steep ground or a rock surface; the vista may have rock anywhere
    const rk = new Uint8Array(L0 * L0).fill(1), H = terrain.heights;
    for (let cx = 0; cx < L0; cx++) for (let cz = 0; cz < L0; cz++) {
      const x0 = -FAR_HALF + cx * 16, z0 = -FAR_HALF + cz * 16;
      if (!(x0 >= -HALF && x0 + 16 <= HALF && z0 >= -HALF && z0 + 16 <= HALF)) continue;
      const ix0 = Math.round((x0 + HALF) / CELL), iz0 = Math.round((z0 + HALF) / CELL);
      let r = 0;
      for (let a = -4; a <= 36 && !r; a += 2) for (let b = -4; b <= 36; b += 2) {
        const ix = Math.max(1, Math.min(N - 1, ix0 + a)), iz = Math.max(1, Math.min(N - 1, iz0 + b)), i = ix * NN + iz;
        const gx = H[i + NN] - H[i - NN], gz = H[i + 1] - H[i - 1];
        if (terrain.surface[i] === SURF.rock || gx * gx + gz * gz > 0.4 * 4 * CELL * CELL) { r = 1; break; }
      }
      rk[cz * L0 + cx] = r;
    }
    rocks.push(rk);
    for (let k = 1, n = L0 / 2; k < LEVELS; k++, n /= 2) {
      const pr = rocks[k - 1], pn = n * 2, r2 = new Uint8Array(n * n);
      for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) { const a = (z * 2) * pn + x * 2; r2[z * n + x] = pr[a] | pr[a + 1] | pr[a + pn] | pr[a + pn + 1]; }
      rocks.push(r2);
    }
    for (let k = 1, n = L0 / 2; k < LEVELS; k++, n /= 2) {
      const pm = mins[k - 1], pM = maxs[k - 1], pn = n * 2;
      const m2 = new Float32Array(n * n), M2 = new Float32Array(n * n);
      for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
        const a = (z * 2) * pn + x * 2, b = a + 1, c2 = a + pn, d = c2 + 1;
        m2[z * n + x] = Math.min(pm[a], pm[b], pm[c2], pm[d]); M2[z * n + x] = Math.max(pM[a], pM[b], pM[c2], pM[d]);
      }
      mins.push(m2); maxs.push(M2);
    }
  }

  // ---- per-frame selection
  const ranges = new Float32Array(LEVELS);
  let lodScale = 1;
  const setRanges = () => {
    for (let k = 0; k < LEVELS; k++) ranges[k] = 44 * lodScale * Math.pow(2, k);
    for (let k = 0; k < LEVELS; k++) {
      const end = ranges[k], prev = k > 0 ? ranges[k - 1] : 0;
      const start = prev + (end - prev) * 0.62;
      morph[k].set(start, 1 / Math.max(1e-3, end - start));
    }
  };
  setRanges();
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), box = new THREE.Box3();
  let camX = 0, camZ = 0;
  const select = (k, cx, cz) => {
    // node at level k, cell index (cx, cz) in that level's grid
    const size = 16 * (1 << k);
    const x0 = -FAR_HALF + cx * size, z0 = -FAR_HALF + cz * size;
    const n = L0 >> k;
    box.min.set(x0, mins[k][cz * n + cx], z0); box.max.set(x0 + size, maxs[k][cz * n + cx], z0 + size);
    if (!frustum.intersectsBox(box)) return;
    const dx = Math.max(x0 - camX, 0, camX - x0 - size), dz = Math.max(z0 - camZ, 0, camZ - z0 - size);
    const d = Math.hypot(dx, dz);
    if (k === 0 || d > ranges[k - 1]) {
      const L = lists[rocks[k][cz * n + cx] && d < 620 ? 0 : 1];
      if (L.count >= MAX_INST) return;
      const o = L.count * 4;
      L.data[o] = x0; L.data[o + 1] = z0; L.data[o + 2] = size / P; L.data[o + 3] = k;
      L.count++;
      return;
    }
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) select(k - 1, cx * 2 + a, cz * 2 + b);
  };

  const view = {
    mesh, material, uniforms, layers, splat, dataTex, groundData, landTex, landData, groundN: DN, heightTex: hTex, normalTex: nTex, floatLinear,
    get patchCount() { return lists[0].count + lists[1].count; },
    configure(q) {
      lodScale = q.lodScale || 1; setRanges();
      uniforms.uDetail.value = q.terrainDetail ?? 2;
    },
    update(dt, camera) {
      camera.updateMatrixWorld();
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      camX = camera.position.x; camZ = camera.position.z;
      uniforms.uCamXZ.value.set(camX, camZ);
      const prev = lists.map(L => L.count);
      for (const L of lists) L.count = 0;
      select(LEVELS - 1, 0, 0);
      lists.forEach((L, l) => {
        L.geo.instanceCount = L.count;
        // upload only when the patches changed (most frames with the camera still)
        let same = L.count === prev[l];
        for (let i = 0, n = L.count * 4; same && i < n; i++) same = L.data[i] === L.sent[i];
        if (same) return;
        L.sent.set(L.data.subarray(0, L.count * 4));
        L.attr.clearUpdateRanges();
        L.attr.addUpdateRange(0, L.count * 4);
        L.attr.needsUpdate = true;
      });
    },
    groundDataChanged() { dataTex.needsUpdate = true; landTex.needsUpdate = true; },
  };
  return view;
}
