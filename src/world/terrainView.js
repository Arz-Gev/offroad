import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { MAP_SIZE, CELL, N, SURF, FAR_SIZE, FAR_CELL } from './terrain.js';
import { bakeGroundLayers, LAYER_TILE } from './textures.js';
import { makeSimplex2D, fbm } from './noise.js';

// Terrain renderer: CDLOD over the 1 km physics map and the 8 km render-only vista, drawn as one instanced grid
// patch (32x32 quads; level k has vertex spacing 0.5 * 2^k m). The CPU walks a quadtree each frame (frustum culled,
// ~150-300 patches) and writes one instance per patch.
// - The vertex shader reads heights from the physics heightfield (R32F texture); level 0 uses Rapier's cell split, so
//   wheels sit exactly on what you see. Odd vertices morph to the next level near each range limit (no cracks / pops).
// - Per-pixel normals come from a GPU-baked normal texture, so far patches keep full-resolution shading.
// - Material: six GPU-baked ground layers (texture arrays) blended by surface map, slope, canopy and height, with
//   two-scale anti-tiling, triplanar rock on steep faces and distance LOD.

const P = 32;                         // quads per patch side
const LEVELS = 10;                    // 16 m ... 8192 m patches
const HALF = MAP_SIZE / 2, NN = N + 1;
const FAR_HALF = FAR_SIZE / 2, FN = FAR_SIZE / FAR_CELL + 1;

const NORMAL_FRAG = /* glsl */`
precision highp float;
uniform highp sampler2D tH;
uniform float uN, uCell, uSwap;
varying vec2 vUv;
float h(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uN) - 1)); return texelFetch(tH, ivec2(g.y, g.x), 0).r; }
void main() {
  ivec2 g = ivec2(floor(vUv * uN));
  float dx = h(g + ivec2(1, 0)) - h(g - ivec2(1, 0));
  float dz = h(g + ivec2(0, 1)) - h(g - ivec2(0, 1));
  vec3 n = normalize(vec3(-dx, 2.0 * uCell, -dz));
  // curvature (positive in hollows): used for ambient occlusion of gullies
  float c = h(g + ivec2(2, 0)) + h(g - ivec2(2, 0)) + h(g + ivec2(0, 2)) + h(g - ivec2(0, 2)) - 4.0 * h(g);
  gl_FragColor = vec4(n.x * 0.5 + 0.5, n.z * 0.5 + 0.5, clamp(c / (uCell * 4.0) + 0.5, 0.0, 1.0), 1.0);
}`;

function bakeNormalTexture(renderer, heightTex, n, cell) {
  const rt = new THREE.WebGLRenderTarget(n, n, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NORMAL_FRAG, uniforms: { tH: { value: heightTex }, uN: { value: n }, uCell: { value: cell }, uSwap: { value: 1 } }, depthTest: false, depthWrite: false,
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

export function buildTerrainView(terrain, renderer, opts = {}) {
  const layers = bakeGroundLayers(renderer, opts.layerSize || 1024, opts.anisotropy || 8);

  // ---- height textures (data layout ix * n + iz: the shader swaps the fetch coordinates)
  const hTex = floatTex(terrain.heights, NN);
  // linear filtering lets the grass read a smooth height with one fetch (texelFetch ignores it)
  const floatLinear = !!renderer.extensions.has('OES_texture_float_linear');
  if (floatLinear) { hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; }
  const fTex = floatTex(terrain.far.heights, FN);
  const nTex = bakeNormalTexture(renderer, hTex, NN, CELL);
  const fnTex = bakeNormalTexture(renderer, fTex, FN, FAR_CELL);

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

  // ---- ground data at 1 m: r = ambient occlusion (hollows, under canopy), g = forest floor, b = wetness, a = grass density
  const DN = MAP_SIZE + 1;
  const groundData = new Uint8Array(DN * DN * 4);
  {
    const hgt = new Float32Array(DN * DN);
    for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) hgt[z * DN + x] = terrain.heights[Math.min(N, x * 2) * NN + Math.min(N, z * 2)];
    const b1 = boxBlur(Float32Array.from(hgt), DN, 1, 6), b2 = boxBlur(Float32Array.from(hgt), DN, 1, 24);
    for (let i = 0; i < DN * DN; i++) {
      const cav = Math.max(0, b1[i] - hgt[i]) * 0.25 + Math.max(0, b2[i] - hgt[i]) * 0.05;
      groundData[i * 4] = Math.round(255 * Math.max(0.45, 1 - cav));
      groundData[i * 4 + 1] = 0; groundData[i * 4 + 2] = 0;
    }
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
      let d = Math.max(0, Math.min(1, 1 - other * 2.5));
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
  }
  const dataTex = new THREE.DataTexture(groundData, DN, DN, THREE.RGBAFormat);
  dataTex.magFilter = THREE.LinearFilter; dataTex.minFilter = THREE.LinearMipmapLinearFilter; dataTex.generateMipmaps = true;
  dataTex.needsUpdate = true;

  // ---- patch geometry: (P+1)^2 grid of integer coordinates, Rapier's diagonal (x1,z0)-(x0,z1)
  const V = P + 1;
  const pos = new Float32Array(V * V * 3);
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) { const o = (i * V + j) * 3; pos[o] = i; pos[o + 1] = 0; pos[o + 2] = j; }
  const idx = [];
  for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) {
    const v00 = a * V + b, v10 = (a + 1) * V + b, v01 = a * V + b + 1, v11 = (a + 1) * V + b + 1;
    idx.push(v00, v01, v10, v10, v01, v11);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const MAX_INST = 2048;
  const instData = new Float32Array(MAX_INST * 4), sentData = new Float32Array(MAX_INST * 4);   // sent: last uploaded
  const instAttr = new THREE.InstancedBufferAttribute(instData, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPatch', instAttr);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  // ---- material
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  const morph = Array.from({ length: LEVELS }, () => new THREE.Vector2());
  const uniforms = {
    tHeight: { value: hTex }, tFarHeight: { value: fTex }, tNrm: { value: nTex }, tFarNrm: { value: fnTex },
    tSplat: { value: splat }, tData: { value: dataTex }, tAlb: { value: layers.albedo }, tLNrm: { value: layers.normal },
    tNoise: { value: opts.noise || null },
    uMorph: { value: morph }, uCamXZ: { value: new THREE.Vector2() },
    uMap: { value: new THREE.Vector4(HALF, CELL, NN, MAP_SIZE) }, uFar: { value: new THREE.Vector4(FAR_HALF, FAR_CELL, FN, 0) },
    uTile: { value: LAYER_TILE.map(t => 1 / t) }, uDetail: { value: 2 },
    uWet: { value: 0 }, uTrack: { value: null }, uTrackOrigin: { value: new THREE.Vector2() }, uTrackSize: { value: 64 },
    uSnow: { value: 330 },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPatch;
uniform highp sampler2D tHeight, tFarHeight;
uniform vec2 uMorph[${LEVELS}];
uniform vec2 uCamXZ;
uniform vec4 uMap, uFar;
varying vec3 vWPos;
varying float vMorph;
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
vMorph = morphK;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2D tNrm, tFarNrm, tSplat, tData, tNoise, uTrack;
uniform sampler2DArray tAlb, tLNrm;
uniform vec4 uMap, uFar;
uniform float uTile[6];
uniform float uDetail, uWet, uTrackSize, uSnow;
uniform vec2 uTrackOrigin;
varying vec3 vWPos;
varying float vMorph;
float gRough; float gAO; vec3 gN; float gWet;
vec2 gDx, gDy;   // screen derivatives of the world xz (taken in uniform control flow)
vec3 gDpx, gDpy;
vec4 layerTex(sampler2DArray t, vec2 uv, float l, mat2 m) { return textureGrad(t, vec3(uv, l), m * gDx, m * gDy); }
// two scales of one layer: the large, rotated one hides tiling at a distance
void layerAt(float l, vec2 xz, float far, out vec4 alb, out vec4 nrm) {
  float tile = uTile[int(l)];
  mat2 mA = mat2(tile, 0.0, 0.0, tile);
  mat2 mB = mat2(0.8, 0.6, -0.6, 0.8) * (tile * 0.23);
  vec2 uvB = mB * xz + 0.37;
  vec4 aB = layerTex(tAlb, uvB, l, mB);
  vec4 nB = layerTex(tLNrm, uvB, l, mB);
  if (far < 0.99 && uDetail > 0.5) {
    vec2 uvA = mA * xz;
    vec4 aA = layerTex(tAlb, uvA, l, mA);
    vec4 nA = layerTex(tLNrm, uvA, l, mA);
    float k = 0.25 + 0.75 * far;
    alb = mix(aA, aB, k); nrm = mix(nA, nB, k);
  } else { alb = aB; nrm = nB; }
}
vec3 triRock(vec3 p, vec3 n, out vec4 nrmOut) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  float t = uTile[2];
  vec3 dpx = gDpx, dpy = gDpy;
  vec4 ax = textureGrad(tAlb, vec3(p.zy * t, 2.0), dpx.zy * t, dpy.zy * t);
  vec4 ay = textureGrad(tAlb, vec3(p.xz * t, 2.0), dpx.xz * t, dpy.xz * t);
  vec4 az = textureGrad(tAlb, vec3(p.xy * t, 2.0), dpx.xy * t, dpy.xy * t);
  vec4 nx = textureGrad(tLNrm, vec3(p.zy * t, 2.0), dpx.zy * t, dpy.zy * t);
  vec4 ny = textureGrad(tLNrm, vec3(p.xz * t, 2.0), dpx.xz * t, dpy.xz * t);
  vec4 nz = textureGrad(tLNrm, vec3(p.xy * t, 2.0), dpx.xy * t, dpy.xy * t);
  nrmOut = nx * w.x + ny * w.y + nz * w.z;
  return (ax * w.x + ay * w.y + az * w.z).rgb;
}`)
      .replace('#include <map_fragment>', `
{
  vec3 p = vWPos;
  gDpx = dFdx(p); gDpy = dFdy(p);
  gDx = gDpx.xz; gDy = gDpy.xz;
  float dist = length(p - cameraPosition);
  bool inMap = max(abs(p.x), abs(p.z)) < uMap.x;
  // heightfield normal + curvature, surface splat, ground data (sampled unconditionally: mip selection needs uniform flow)
  vec2 uvN = ((p.xz + uMap.x) / uMap.y + 0.5) / uMap.z;
  vec4 ntN = texture2D(tNrm, uvN);
  vec4 sp = texture2D(tSplat, uvN);
  vec4 gd = texture2D(tData, (p.xz + uMap.x + 0.5) / (uMap.w + 1.0));
  vec4 nt = ntN;
  if (!inMap) {
    // vista: its own normal map (explicit gradients: this is non-uniform control flow) plus procedural
    // detail normals (its heightmap is only 16 m)
    vec2 uvF = ((p.xz + uFar.x) / uFar.y + 0.5) / uFar.z;
    nt = textureGrad(tFarNrm, uvF, gDx / (uFar.y * uFar.z), gDy / (uFar.y * uFar.z));
    sp = vec4(0.0); gd = vec4(1.0, 0.0, 0.0, 1.0);
  }
  vec3 nG = vec3(nt.r * 2.0 - 1.0, 0.0, nt.g * 2.0 - 1.0);
  nG.y = sqrt(max(0.0, 1.0 - nG.x * nG.x - nG.z * nG.z));
  float curv = nt.b;
  if (!inMap) {
    vec4 dz1 = textureGrad(tNoise, p.xz / 41.0, gDx / 41.0, gDy / 41.0), dz2 = textureGrad(tNoise, p.xz / 13.0 + 0.5, gDx / 13.0, gDy / 13.0);
    nG = normalize(nG + vec3(dz1.r - 0.5, 0.0, dz1.g - 0.5) * 0.7 + vec3(dz2.b - 0.5, 0.0, dz2.a - 0.5) * 0.35);
  }
  // macro variation (large scale) to break everything up
  float mac = texture2D(tNoise, p.xz / 420.0).r;
  float mac2 = texture2D(tNoise, p.xz / 97.0 + 0.3).g;
  float far = smoothstep(18.0, 90.0, dist);
  // layer weights
  float slope = 1.0 - nG.y;
  float wRock = max(sp.b, smoothstep(0.24, 0.36, slope + (mac2 - 0.5) * 0.08));
  float wMud = sp.g, wSand = sp.a, wDirt = sp.r;
  wDirt = max(wDirt, smoothstep(0.14, 0.24, slope) * 0.55 * (1.0 - wRock));
  float wForest = gd.g * (1.0 - wDirt) * (1.0 - wMud);
  if (!inMap) wForest = smoothstep(0.35, 0.65, mac2) * smoothstep(0.32, 0.18, slope) * smoothstep(260.0, 120.0, p.y);
  float wGrass = max(0.0, 1.0 - wDirt - wMud - wSand - wForest);
  // the two strongest layers, height-blended (more would cost registers and samples for little gain)
  float w1 = wGrass, l1 = 0.0, w2 = 0.0, l2 = 0.0;
  #define TOP2(W, L) if (W > w1) { w2 = w1; l2 = l1; w1 = W; l1 = L; } else if (W > w2) { w2 = W; l2 = L; }
  TOP2(wDirt, 1.0) TOP2(wMud, 3.0) TOP2(wSand, 4.0) TOP2(wForest, 5.0)
  vec3 c; vec4 nn;
  if (dist < 600.0) {
    vec4 a1, n1, a2 = vec4(0.0), n2 = vec4(0.5, 0.5, 0.9, 1.0);
    layerAt(l1, p.xz, far, a1, n1);
    if (w2 > 0.02) {
      layerAt(l2, p.xz, far, a2, n2);
      float h1 = a1.a + w1 * 1.2, h2 = a2.a + w2 * 1.2, hm = max(h1, h2) - 0.35;
      float b1 = max(h1 - hm, 0.0) * w1, b2 = max(h2 - hm, 0.0) * w2;
      float k = b2 / max(b1 + b2, 1e-4);
      c = mix(a1.rgb, a2.rgb, k); nn = mix(n1, n2, k);
    } else { c = a1.rgb; nn = n1; }
  } else {
    // far away: average layer colours
    c = vec3(0.075, 0.105, 0.035) * wGrass + vec3(0.17, 0.12, 0.075) * wDirt + vec3(0.06, 0.045, 0.03) * wMud + vec3(0.3, 0.27, 0.2) * wSand + vec3(0.045, 0.06, 0.025) * wForest;
    c /= max(1e-3, wGrass + wDirt + wMud + wSand + wForest);
    nn = vec4(0.5, 0.5, 0.9, 1.0);
  }
  // rock (triplanar on steep faces)
  if (wRock > 0.01) {
    vec4 rn; vec3 rc;
    if (dist > 600.0) { rc = vec3(0.2, 0.19, 0.17); rn = vec4(0.5, 0.5, 0.85, 1.0); }
    else if (nG.y < 0.9) rc = triRock(p, nG, rn);
    else { vec4 ra; layerAt(2.0, p.xz, far, ra, rn); rc = ra.rgb; }
    c = mix(c, rc, wRock); nn = mix(nn, rn, wRock);
  }
  // vista snow on high flats
  if (!inMap) {
    float snow = smoothstep(uSnow, uSnow + 60.0, p.y + (mac - 0.5) * 80.0) * smoothstep(0.55, 0.3, slope);
    c = mix(c, vec3(0.62, 0.64, 0.68), snow);
  }
  // macro tint: dry / lush patches, brightness
  c *= mix(vec3(1.08, 1.02, 0.86), vec3(0.9, 1.0, 1.04), mac) * (0.86 + 0.28 * mac2);
  // tyre tracks darken (and wet) the ground
  vec2 tuv = (p.xz - uTrackOrigin) / uTrackSize + 0.5;
  float track = inMap ? texture2D(uTrack, tuv).r : 0.0;
  c *= 1.0 - track * 0.3;
  // wetness: shore, mud, rain
  gWet = clamp(max(gd.b * 0.9, uWet) + wMud * 0.4 + track * wMud * 0.4, 0.0, 1.0);
  c *= 1.0 - gWet * 0.35;
  gRough = mix(nn.b, 0.55, gWet);
  // ambient occlusion: hollows, canopy, texture cavities
  gAO = gd.r * mix(1.0, nn.a, 0.8) * clamp(1.15 - curv * 0.3, 0.6, 1.0);
  // normal: detail (tangent space x/z) on top of the heightfield normal
  vec2 dn = (nn.xy * 2.0 - 1.0) * (1.0 - smoothstep(30.0, 140.0, dist));
  gN = normalize(nG + vec3(dn.x, 0.0, dn.y) * 0.9);
  diffuseColor.rgb *= c;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_begin>', `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;`)
      .replace('#include <normal_fragment_maps>', '')
      .replace('#include <aomap_fragment>', `
reflectedLight.indirectDiffuse *= gAO;
reflectedLight.indirectSpecular *= gAO;`);
  };
  material.customProgramCacheKey = () => 'terrain-cdlod-v1';

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.material = material;

  // ---- min/max height pyramid at 16 m cells for culling
  const L0 = FAR_SIZE / 16; // 512 cells
  const mins = [], maxs = [];
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
  let count = 0, camX = 0, camZ = 0;
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
      if (count >= MAX_INST) return;
      const o = count * 4;
      instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size / P; instData[o + 3] = k;
      count++;
      return;
    }
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) select(k - 1, cx * 2 + a, cz * 2 + b);
  };

  const view = {
    mesh, material, uniforms, layers, splat, dataTex, groundData, groundN: DN, heightTex: hTex, normalTex: nTex, floatLinear,
    get patchCount() { return count; },
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
      const prev = count;
      count = 0;
      select(LEVELS - 1, 0, 0);
      geo.instanceCount = count;
      // upload only when the patches changed (most frames with the camera still)
      let same = count === prev;
      for (let i = 0, n = count * 4; same && i < n; i++) same = instData[i] === sentData[i];
      if (same) return;
      sentData.set(instData.subarray(0, count * 4));
      instAttr.clearUpdateRanges();
      instAttr.addUpdateRange(0, count * 4);
      instAttr.needsUpdate = true;
    },
    groundDataChanged() { dataTex.needsUpdate = true; },
  };
  return view;
}
