import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, uniformArray, attribute, texture, vec2, vec3, vec4, float, int, ivec2, positionGeometry, positionWorld,
  cameraPosition, cameraViewMatrix, mix, clamp, smoothstep, step, max, min, abs, sqrt, pow, fract, round, floor, distance, length,
  normalize, dot, dFdx, dFdy, select as sel, mat2,
} from 'three/tsl';
import { MAP_SIZE, CELL, N, SURF, FAR_SIZE, FAR_CELL } from './terrain.js';
import { bakeGroundLayers, LAYER_TILE } from './textures.js';
import { makeSimplex2D, fbm } from './noise.js';

// Terrain renderer: CDLOD (continuous distance-dependent level of detail) over the 1 km physics map and
// the 8 km render-only vista, drawn as one instanced grid patch.
// - Patches are 32x32 quads; level k has a vertex spacing of 0.5 * 2^k m. The CPU walks a quadtree each
//   frame (frustum culled, ~150-300 patches) and writes one instance per patch.
// - The vertex stage reads heights straight from the physics heightfield (R32F texture). At level 0 the
//   triangles use the same cell split as Rapier, so wheels sit exactly on what you see. Odd vertices
//   morph towards the next level near each range limit, so there are no cracks or pops.
// - Lighting uses a per-pixel normal texture (computed from the heights), so far patches keep the
//   full-resolution shading.
// - Material: six baked ground layers (texture arrays) blended by the surface map, slope, forest
//   canopy and height, with two-scale anti-tiling, triplanar rock on steep faces and distance LOD.
//   Wetness (shore, mud, rain from weather.js) darkens the ground, makes it glossy and fills puddles
//   in the hollows.
// The whole surface is worked out once in the colour node; roughness, AO and the normal read its results.

const P = 32;                         // quads per patch side
const LEVELS = 10;                    // 16 m ... 8192 m patches
const HALF = MAP_SIZE / 2, NN = N + 1;
const FAR_HALF = FAR_SIZE / 2, FN = FAR_SIZE / FAR_CELL + 1;

// normals (xz) + curvature from a height grid (data layout ix * n + iz), stored RGBA8 with texel (ix, iz)
// at row iz, column ix... the shader samples it with uv = (x, z)
function normalTexture(heights, n, cell) {
  const data = new Uint8Array(n * n * 4);
  const h = (ix, iz) => heights[Math.max(0, Math.min(n - 1, ix)) * n + Math.max(0, Math.min(n - 1, iz))];
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const dx = h(ix + 1, iz) - h(ix - 1, iz), dz = h(ix, iz + 1) - h(ix, iz - 1);
    const nx = -dx, ny = 2 * cell, nz = -dz, l = Math.hypot(nx, ny, nz);
    const c = h(ix + 2, iz) + h(ix - 2, iz) + h(ix, iz + 2) + h(ix, iz - 2) - 4 * h(ix, iz);
    const o = (iz * n + ix) * 4;
    data[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((nz / l * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, c / (cell * 4) + 0.5)) * 255);
    data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
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
  const caps = renderer.caps || {};

  // ---- height textures (data layout ix * n + iz: the shaders swap the fetch coordinates)
  const hTex = floatTex(terrain.heights, NN);
  // linear filtering lets the grass read a smooth height with one fetch (textureLoad ignores it)
  const floatLinear = !!caps.floatFilter;
  if (floatLinear) { hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; }
  const fTex = floatTex(terrain.far.heights, FN);
  const nTex = normalTexture(terrain.heights, NN, CELL);
  const fnTex = normalTexture(terrain.far.heights, FN, FAR_CELL);

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

  // ---- tyre tracks (effects.js Tracks paints it): r = depth of the rut
  const TRACK_RES = 2048;
  const trackTex = new THREE.DataTexture(new Uint8Array(TRACK_RES * TRACK_RES), TRACK_RES, TRACK_RES, THREE.RedFormat, THREE.UnsignedByteType);
  // nearest: three binds no sampler for it (the terrain blends it by hand, the grass reads the nearest texel)
  trackTex.magFilter = trackTex.minFilter = THREE.NearestFilter;
  trackTex.needsUpdate = true;

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
  // up normals: only the shadow normal offset reads them (the shading uses the per-pixel normal map)
  const nrm = new Float32Array(V * V * 3); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  const MAX_INST = 2048;
  const instData = new Float32Array(MAX_INST * 4);
  const instAttr = new THREE.InstancedBufferAttribute(instData, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPatch', instAttr);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  // ---- uniforms
  const morph = Array.from({ length: LEVELS }, () => new THREE.Vector2());
  const uniforms = {
    uMorph: uniformArray(morph, 'vec2'), uCamXZ: uniform(new THREE.Vector2()),
    uMap: uniform(new THREE.Vector4(HALF, CELL, NN, MAP_SIZE)), uFar: uniform(new THREE.Vector4(FAR_HALF, FAR_CELL, FN, 0)),
    uDetail: uniform(2), uWet: uniform(0), uPuddles: uniform(0),
    uTrack: { value: trackTex }, uTrackOrigin: uniform(new THREE.Vector2()), uTrackSize: uniform(MAP_SIZE),
    uSnow: uniform(330),
  };
  const U = uniforms;
  const tH = texture(hTex), tFH = texture(fTex), tN = texture(nTex), tFN = texture(fnTex);
  const tSplat = texture(splat), tData = texture(dataTex), tNoise = texture(opts.noise), tTrack = texture(trackTex);
  const tAlb = texture(layers.albedo), tLNrm = texture(layers.normal);
  const tiles = LAYER_TILE.map(t => 1 / t);

  // ---- vertex: CDLOD morph over the height textures
  const aPatch = attribute('aPatch', 'vec4');
  const hNear = Fn(([xz]) => {
    const g = clamp(ivec2(round(xz.add(U.uMap.x).div(U.uMap.y))), ivec2(0), ivec2(int(U.uMap.z).sub(1)));
    return tH.load(ivec2(g.y, g.x)).r;
  });
  const hFar = Fn(([xz]) => {
    const f = clamp(xz.add(U.uFar.x).div(U.uFar.y), vec2(0.0), vec2(U.uFar.z.sub(1.001)));
    const i = ivec2(floor(f)), t = f.sub(floor(f));
    const a = tFH.load(ivec2(i.y, i.x)).r, b = tFH.load(ivec2(i.y, i.x.add(1))).r;
    const c = tFH.load(ivec2(i.y.add(1), i.x)).r, d = tFH.load(ivec2(i.y.add(1), i.x.add(1))).r;
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  });
  const hAt = Fn(([xz]) => sel(max(abs(xz.x), abs(xz.y)).lessThanEqual(U.uMap.x.add(0.01)), hNear(xz), hFar(xz)));

  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  material.positionNode = Fn(() => {
    const gIdx = positionGeometry.xz;
    const stp = aPatch.z;
    const wxz = aPatch.xy.add(gIdx.mul(stp));
    const mm = U.uMorph.element(int(aPatch.w));
    const morphK = clamp(distance(wxz, U.uCamXZ).sub(mm.x).mul(mm.y), 0.0, 1.0);
    const frac2 = fract(gIdx.mul(0.5)).mul(2.0);
    const txz = aPatch.xy.add(gIdx.sub(frac2).mul(stp));
    const h0 = hAt(wxz);
    const h1 = sel(frac2.x.add(frac2.y).greaterThan(0.0), hAt(txz), h0);
    const p = mix(wxz, txz, morphK);
    return vec3(p.x, mix(h0, h1, morphK), p.y);
  })();

  // ---- fragment: the surface (colour, roughness, AO, normal) in one go
  const gRough = float(0.9).toVar('gRough'), gAO = float(1).toVar('gAO'), gN = vec3(0, 1, 0).toVar('gN');
  const surface = Fn(() => {
    const p = positionWorld;
    const gDx = dFdx(p), gDy = dFdy(p);
    const dxz = gDx.xz, dyz = gDy.xz;
    const layerTex = (tex, uvv, l, scale) => tex.sample(uvv).depth(l).grad(dxz.mul(scale), dyz.mul(scale));
    const layerTexR = (tex, uvv, l, m) => tex.sample(uvv).depth(l).grad(m.mul(dxz), m.mul(dyz));
    const dist = length(p.sub(cameraPosition));
    const inMap = max(abs(p.x), abs(p.z)).lessThan(U.uMap.x);
    // heightfield normal + curvature, surface splat, ground data
    const uvN = p.xz.add(U.uMap.x).div(U.uMap.y).add(0.5).div(U.uMap.z);
    const ntN = tN.sample(uvN), spN = tSplat.sample(uvN);
    const gdN = tData.sample(p.xz.add(U.uMap.x).add(0.5).div(U.uMap.w.add(1.0)));
    const uvF = p.xz.add(U.uFar.x).div(U.uFar.y).add(0.5).div(U.uFar.z);
    const sF = U.uFar.y.mul(U.uFar.z);
    const ntF = tFN.sample(uvF).grad(dxz.div(sF), dyz.div(sF));
    const nt = sel(inMap, ntN, ntF);
    const sp = sel(inMap, spN, vec4(0.0));
    const gd = sel(inMap, gdN, vec4(1.0, 0.0, 0.0, 1.0));
    const nG = vec3(nt.r.mul(2).sub(1), 0.0, nt.g.mul(2).sub(1)).toVar();
    nG.y.assign(sqrt(max(0.0, float(1).sub(nG.x.mul(nG.x)).sub(nG.z.mul(nG.z)))));
    const curv = nt.b;
    If(inMap.not(), () => {
      // vista: procedural detail normals (its heightmap is only 16 m)
      const dz1 = tNoise.sample(p.xz.div(41.0)).grad(dxz.div(41.0), dyz.div(41.0));
      const dz2 = tNoise.sample(p.xz.div(13.0).add(0.5)).grad(dxz.div(13.0), dyz.div(13.0));
      nG.assign(normalize(nG.add(vec3(dz1.r.sub(0.5), 0.0, dz1.g.sub(0.5)).mul(0.7)).add(vec3(dz2.b.sub(0.5), 0.0, dz2.a.sub(0.5)).mul(0.35))));
    });
    // macro variation (large scale) to break everything up
    const mac = tNoise.sample(p.xz.div(420.0)).r;
    const mac2 = tNoise.sample(p.xz.div(97.0).add(0.3)).g;
    const far = smoothstep(18.0, 90.0, dist);
    // layer weights
    const slope = float(1).sub(nG.y);
    const wRock = max(sp.b, smoothstep(0.24, 0.36, slope.add(mac2.sub(0.5).mul(0.08))));
    const wMud = sp.g, wSand = sp.a;
    const wDirt = max(sp.r, smoothstep(0.14, 0.24, slope).mul(0.55).mul(float(1).sub(wRock)));
    const wForest = sel(inMap, gd.g.mul(float(1).sub(wDirt)).mul(float(1).sub(wMud)),
      smoothstep(0.35, 0.65, mac2).mul(smoothstep(0.32, 0.18, slope)).mul(smoothstep(260.0, 120.0, p.y)));
    const wGrass = max(0.0, float(1).sub(wDirt).sub(wMud).sub(wSand).sub(wForest));
    // the two strongest layers, height-blended
    const w1 = wGrass.toVar(), l1 = float(0).toVar(), w2 = float(0).toVar(), l2 = float(0).toVar();
    const top2 = (W, L) => {
      If(W.greaterThan(w1), () => { w2.assign(w1); l2.assign(l1); w1.assign(W); l1.assign(L); })
        .ElseIf(W.greaterThan(w2), () => { w2.assign(W); l2.assign(L); });
    };
    top2(wDirt, 1.0); top2(wMud, 3.0); top2(wSand, 4.0); top2(wForest, 5.0);
    const tileOf = l => sel(l.lessThan(0.5), tiles[0], sel(l.lessThan(1.5), tiles[1], sel(l.lessThan(2.5), tiles[2], sel(l.lessThan(3.5), tiles[3], sel(l.lessThan(4.5), tiles[4], tiles[5])))));
    // two scales of one layer: the large, rotated one hides tiling at a distance
    const layerAt = (l, alb, nrm) => {
      const tile = tileOf(l);
      const li = int(l);
      const mB = mat2(0.8, 0.6, -0.6, 0.8).mul(tile.mul(0.23));
      const uvB = mB.mul(p.xz).add(0.37);
      const aB = layerTexR(tAlb, uvB, li, mB), nB = layerTexR(tLNrm, uvB, li, mB);
      alb.assign(aB); nrm.assign(nB);
      If(far.lessThan(0.99).and(U.uDetail.greaterThan(0.5)), () => {
        const uvA = p.xz.mul(tile);
        const aA = layerTex(tAlb, uvA, li, tile), nA = layerTex(tLNrm, uvA, li, tile);
        const k = far.mul(0.75).add(0.25);
        alb.assign(mix(aA, aB, k)); nrm.assign(mix(nA, nB, k));
      });
    };
    const c = vec3(0).toVar(), nn = vec4(0.5, 0.5, 0.9, 1.0).toVar();
    If(dist.lessThan(600.0), () => {
      const a1 = vec4(0).toVar(), n1 = vec4(0).toVar(), a2 = vec4(0).toVar(), n2 = vec4(0.5, 0.5, 0.9, 1.0).toVar();
      layerAt(l1, a1, n1);
      c.assign(a1.rgb); nn.assign(n1);
      If(w2.greaterThan(0.02), () => {
        layerAt(l2, a2, n2);
        const h1 = a1.a.add(w1.mul(1.2)), h2 = a2.a.add(w2.mul(1.2)), hm = max(h1, h2).sub(0.35);
        const b1 = max(h1.sub(hm), 0.0).mul(w1), b2 = max(h2.sub(hm), 0.0).mul(w2);
        const k = b2.div(max(b1.add(b2), 1e-4));
        c.assign(mix(a1.rgb, a2.rgb, k)); nn.assign(mix(n1, n2, k));
      });
    }).Else(() => {
      // far away: average layer colours
      const sum = vec3(0.075, 0.105, 0.035).mul(wGrass).add(vec3(0.17, 0.12, 0.075).mul(wDirt)).add(vec3(0.06, 0.045, 0.03).mul(wMud))
        .add(vec3(0.3, 0.27, 0.2).mul(wSand)).add(vec3(0.045, 0.06, 0.025).mul(wForest));
      c.assign(sum.div(max(1e-3, wGrass.add(wDirt).add(wMud).add(wSand).add(wForest))));
    });
    // rock (triplanar on steep faces)
    If(wRock.greaterThan(0.01), () => {
      const rc = vec3(0.2, 0.19, 0.17).toVar(), rn = vec4(0.5, 0.5, 0.85, 1.0).toVar();
      If(dist.lessThan(600.0), () => {
        If(nG.y.lessThan(0.9), () => {
          const wv = pow(abs(nG), vec3(4.0)); const w = wv.div(wv.x.add(wv.y).add(wv.z));
          const t = tiles[2];
          const tri = (tex, a, b, ga, gb) => tex.sample(a.mul(t)).depth(int(2)).grad(ga.mul(t), gb.mul(t));
          const ax = tri(tAlb, p.zy, null, gDx.zy, gDy.zy), ay = tri(tAlb, p.xz, null, gDx.xz, gDy.xz), az = tri(tAlb, p.xy, null, gDx.xy, gDy.xy);
          const nx = tri(tLNrm, p.zy, null, gDx.zy, gDy.zy), ny = tri(tLNrm, p.xz, null, gDx.xz, gDy.xz), nz = tri(tLNrm, p.xy, null, gDx.xy, gDy.xy);
          rn.assign(nx.mul(w.x).add(ny.mul(w.y)).add(nz.mul(w.z)));
          rc.assign(ax.rgb.mul(w.x).add(ay.rgb.mul(w.y)).add(az.rgb.mul(w.z)));
        }).Else(() => {
          const ra = vec4(0).toVar(), rnn = vec4(0).toVar();
          layerAt(float(2), ra, rnn);
          rc.assign(ra.rgb); rn.assign(rnn);
        });
      });
      c.assign(mix(c, rc, wRock)); nn.assign(mix(nn, rn, wRock));
    });
    // vista snow on high flats
    If(inMap.not(), () => {
      const snow = smoothstep(U.uSnow, U.uSnow.add(60.0), p.y.add(mac.sub(0.5).mul(80.0))).mul(smoothstep(0.55, 0.3, slope));
      c.assign(mix(c, vec3(0.62, 0.64, 0.68), snow));
    });
    // macro tint: dry / lush patches, brightness
    c.mulAssign(mix(vec3(1.08, 1.02, 0.86), vec3(0.9, 1.0, 1.04), mac).mul(mac2.mul(0.28).add(0.86)));
    // tyre tracks darken (and wet) the ground
    const tuv = p.xz.sub(U.uTrackOrigin).div(U.uTrackSize).add(0.5);
    // the rut map is read with loads + manual bilinear: no sampler (the terrain shader is at WebGPU's limit
    // of 16 samplers on Ultra at night: 4 shadow cascades, the lamp shadow and cookies, the probe)
    const tp = tuv.mul(2048.0).sub(0.5), tf = floor(tp), tw = tp.sub(tf);
    const ti = ivec2(tf).clamp(ivec2(0), ivec2(2046));
    const tl = (a, b) => tTrack.load(ti.add(ivec2(a, b))).r;
    const trackRaw = mix(mix(tl(0, 0), tl(1, 0), tw.x), mix(tl(0, 1), tl(1, 1), tw.x), tw.y);
    const track = sel(inMap, trackRaw, float(0));
    c.mulAssign(float(1).sub(track.mul(0.3)));
    // wetness: shore, mud, rain. Rain fills the hollows (curvature + texture height) with puddles that
    // mirror the sky (low roughness, flat normal)
    const hollow = smoothstep(0.52, 0.62, curv).add(smoothstep(0.45, 0.2, nn.a.add(far.mul(0.3)))).mul(0.5);
    const puddle = smoothstep(0.35, 0.75, hollow.add(mac2.sub(0.5).mul(0.6))).mul(U.uPuddles).mul(smoothstep(0.12, 0.04, slope)).mul(float(1).sub(wRock));
    const wet = clamp(max(gd.b.mul(0.9), U.uWet.mul(float(1).sub(wRock.mul(0.4)))).add(wMud.mul(0.4)).add(track.mul(wMud).mul(0.4)), 0.0, 1.0);
    c.mulAssign(float(1).sub(wet.mul(0.35)));
    c.mulAssign(float(1).sub(puddle.mul(0.45)));
    gRough.assign(mix(mix(nn.b, 0.55, wet), 0.04, puddle));
    // ambient occlusion: hollows, canopy, texture cavities
    gAO.assign(gd.r.mul(mix(1.0, nn.a, 0.8)).mul(clamp(float(1.15).sub(curv.mul(0.3)), 0.6, 1.0)));
    // normal: detail (tangent space x/z) on top of the heightfield normal
    const dn = nn.xy.mul(2.0).sub(1.0).mul(float(1).sub(smoothstep(30.0, 140.0, dist))).mul(float(1).sub(puddle));
    gN.assign(normalize(nG.add(vec3(dn.x, 0.0, dn.y).mul(0.9))));
    return c;
  });
  material.colorNode = surface();
  material.roughnessNode = gRough;
  material.aoNode = gAO;
  material.normalNode = cameraViewMatrix.mul(vec4(gN, 0.0)).xyz.normalize();

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.material = material;
  material.userData.uniforms = uniforms;

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
  const pick = (k, cx, cz) => {
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
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) pick(k - 1, cx * 2 + a, cz * 2 + b);
  };

  const view = {
    mesh, material, uniforms, layers, splat, dataTex, groundData, groundN: DN, heightTex: hTex, normalTex: nTex, floatLinear, trackTex, noiseTex: opts.noise,
    get patchCount() { return count; },
    configure(q) {
      lodScale = q.lodScale || 1; setRanges();
      uniforms.uDetail.value = q.terrainDetail ?? 2;
    },
    update(dt, camera) {
      camera.updateMatrixWorld();
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
      camX = camera.position.x; camZ = camera.position.z;
      uniforms.uCamXZ.value.set(camX, camZ);
      count = 0;
      pick(LEVELS - 1, 0, 0);
      geo.instanceCount = count;
      instAttr.clearUpdateRanges();
      instAttr.addUpdateRange(0, count * 4);
      instAttr.needsUpdate = true;
    },
    groundDataChanged() { dataTex.needsUpdate = true; },
  };
  return view;
}
