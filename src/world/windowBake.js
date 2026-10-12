import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { MAP_SIZE, CELL, N, SURF, FAR_SIZE } from './terrain.js';
import { makeSimplex2D, mulberry32, fbm, smoothstep } from './noise.js';
import { rngAt } from './worldgen.js';

// Everything about a window of the world that is worked out on the CPU from its terrain, off the main thread
// (windowWorker.js; tools run it directly): the surface splat, the ground and land data maps, the culling pyramid
// for the terrain's patches, the trees (and what they do to the ground under them), fallen logs and the boulders.
// Every random choice is seeded from absolute coordinates (a grid cell of the world), never from a running
// sequence, so two windows place the same tree at the same spot.

const HALF = MAP_SIZE / 2, NN = N + 1, DN = MAP_SIZE + 1;
const sst = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

// ---------------------------------------------------------------- splat, ground data
// splat (dirt, mud, rock, sand), blurred; texel (ix, iz) natural orientation
export function makeSplat(terrain) {
  const splat = new Uint8Array(NN * NN * 4);
  for (let ix = 0; ix < NN; ix++) for (let iz = 0; iz < NN; iz++) {
    const s = terrain.surface[ix * NN + iz];
    const o = (iz * NN + ix) * 4;
    if (s === SURF.dirt) splat[o] = 255; else if (s === SURF.mud) splat[o + 1] = 255; else if (s === SURF.rock) splat[o + 2] = 255; else if (s === SURF.sand) splat[o + 3] = 255;
  }
  blurU8(splat, NN, 4, 2);
  blurU8(splat, NN, 4, 1);
  return splat;
}

// ground data at 1 m: r = ambient occlusion under the canopy (the trees; the terrain's own is the normal map's sky
// visibility), g = forest floor, b = wetness, a = grass density. hgt: the heights at 1 m (texel x, z at z * DN + x)
function makeGroundData(terrain, splat, hgt) {
  const groundData = new Uint8Array(DN * DN * 4);
  const ox = terrain.ox, oz = terrain.oz;
  for (let i = 0; i < DN * DN; i++) groundData[i * 4] = 255;
  // grass density: grass surfaces only (from the blurred splat), thinning on slopes, natural clearings
  const clr = makeSimplex2D(4711);
  for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) {
    const ix = Math.min(N, x * 2), iz = Math.min(N, z * 2);
    const o = (iz * NN + ix) * 4;
    const other = (splat[o] + splat[o + 1] + splat[o + 2] + splat[o + 3]) / 255;
    const h = (a, b) => hgt[Math.max(0, Math.min(DN - 1, b)) * DN + Math.max(0, Math.min(DN - 1, a))];
    const slope = Math.hypot(h(x + 1, z) - h(x - 1, z), h(x, z + 1) - h(x, z - 1)) / 2;
    const wx = -HALF + x + ox, wz = -HALF + z + oz;
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
  return groundData;
}

// Land data at 1 m, from the shape of the ground (texel x, z at z * DN + x):
//   r lushness: 0 dry, golden (ridges, sunny slopes, high ground) .. 1 deep green (drainage lines, hollows, by water)
//   g scree: debris rolled down from the rock faces, fanning out below them and coming to rest where the slope eases
//   b litter under the trees (written by the trees below): 0 needles, 0.5 leaves, 1 petals
//   a rock kind: 0 limestone, 1/3 granite, 2/3 sandstone, 1 slate
// The flow is worked out inside the window only, so the upstream area of a long valley is cut off at the window's
// edge; it only feeds a smooth "drainage line" term that saturates (sst 5.5..11 of log2 cells) well inside a window.
function bakeLand(terrain, hgt, wet) {
  const M = (DN - 1) / 2 + 1;
  const ox = terrain.ox, oz = terrain.oz;
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
  // ---- rock kinds: limestone or granite by large patches, slate in places, sandstone in the quarries, granite on
  // the lookouts
  const kn = makeSimplex2D(9137);
  const regions = [];
  for (const s of terrain.sites) {
    if (s.type === 'quarry') regions.push({ x: s.x, z: s.z, r0: 70, r1: 110, k: 2 / 3 });
    else if (s.type === 'lookout') regions.push({ x: s.x, z: s.z, r0: 120, r1: 190, k: 1 / 3 });
  }
  const out = new Uint8Array(DN * DN * 4);
  for (let z = 0; z < DN; z++) for (let x = 0; x < DN; x++) {
    const i = z * DN + x, lx = -HALF + x, lz = -HALF + z, wx = lx + ox, wz = lz + oz, h = hgt[i];
    const H = (a, b) => hgt[Math.max(0, Math.min(DN - 1, b)) * DN + Math.max(0, Math.min(DN - 1, a))];
    const gx = (H(x + 1, z) - H(x - 1, z)) / 2, gz = (H(x, z + 1) - H(x, z - 1)) / 2, slope = Math.hypot(gx, gz);
    // the side facing the midday sun (south: azimuth 155.7 deg from +z towards +x) dries out
    const sunny = Math.max(-1, Math.min(1, (-gx * 0.41 + gz * 0.91) * 2.2));
    const drain = sst(5.5, 11, at2(acc, x / 2, z / 2));
    const hollow = Math.max(-1, Math.min(1, (b1[i] - h) * 0.7 + (b2[i] - h) * 0.12));
    const n = fbm(kn, wx * 0.006, wz * 0.006, 3);
    const lush = 0.5 + 0.34 * drain + 0.3 * hollow - 0.2 * sunny + 0.45 * near[i] - 0.2 * sst(0.35, 0.9, slope)
      - 0.2 * sst(60, 160, h) + 0.22 * n;
    out[i * 4] = Math.round(255 * Math.max(0, Math.min(1, lush)));
    out[i * 4 + 1] = Math.round(255 * Math.max(0, Math.min(1, at2(scree, x / 2, z / 2) * 1.15)));
    let kw = 1, ks = fbm(kn, wx * 0.0021 + 31, wz * 0.0021, 2) > 0.05 ? 1 / 3 : 0;
    const sl = fbm(kn, wx * 0.0017 - 17, wz * 0.0017, 2);
    if (sl > 0.25) { const w = sst(0.25, 0.4, sl) * 4; kw += w; ks += w; }
    for (const r of regions) {
      const d = Math.hypot(lx - r.x, lz - r.z);
      if (d < r.r1) { const w = sst(r.r1, r.r0, d) * 4; kw += w; ks += w * r.k; }
    }
    out[i * 4 + 3] = Math.round(255 * ks / kw);
  }
  return out;
}

// ---------------------------------------------------------------- the terrain's culling pyramid
// min / max height per 16 m cell over the vista (8 km) and whether a cell has rock within reach; then the coarser
// levels (2x2 merged), as terrainView's quadtree walks them
export const PYR_LEVELS = 10;
function makePyramid(terrain) {
  const FAR_HALF = FAR_SIZE / 2, L0 = FAR_SIZE / 16, H = terrain.heights;
  const mins = [], maxs = [], rocks = [];
  const mn = new Float32Array(L0 * L0), mx = new Float32Array(L0 * L0);
  for (let cx = 0; cx < L0; cx++) for (let cz = 0; cz < L0; cz++) {
    const x0 = -FAR_HALF + cx * 16, z0 = -FAR_HALF + cz * 16;
    let lo = 1e9, hi = -1e9;
    if (x0 >= -HALF && x0 + 16 <= HALF && z0 >= -HALF && z0 + 16 <= HALF) {
      const ix0 = Math.round((x0 + HALF) / CELL), iz0 = Math.round((z0 + HALF) / CELL);
      for (let a = 0; a <= 32; a += 2) for (let b = 0; b <= 32; b += 2) { const h = H[(ix0 + a) * NN + iz0 + b]; if (h < lo) lo = h; if (h > hi) hi = h; }
      lo -= 0.5; hi += 0.5;
    } else {
      for (const [a, b] of [[0, 0], [16, 0], [0, 16], [16, 16], [8, 8]]) { const h = terrain.surfaceHeight(x0 + a, z0 + b); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      lo -= 6; hi += 6;
    }
    mn[cz * L0 + cx] = lo; mx[cz * L0 + cx] = hi;
  }
  mins.push(mn); maxs.push(mx);
  // rock within the cell (or 2 m around it): steep ground or a rock surface; the vista may have rock anywhere
  const rk = new Uint8Array(L0 * L0).fill(1);
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
  for (let k = 1, n = L0 / 2; k < PYR_LEVELS; k++, n /= 2) {
    const pr = rocks[k - 1], pn = n * 2, r2 = new Uint8Array(n * n);
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) { const a = (z * 2) * pn + x * 2; r2[z * n + x] = pr[a] | pr[a + 1] | pr[a + pn] | pr[a + pn + 1]; }
    rocks.push(r2);
  }
  for (let k = 1, n = L0 / 2; k < PYR_LEVELS; k++, n /= 2) {
    const pm = mins[k - 1], pM = maxs[k - 1], pn = n * 2;
    const m2 = new Float32Array(n * n), M2 = new Float32Array(n * n);
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
      const a = (z * 2) * pn + x * 2, b = a + 1, c2 = a + pn, d = c2 + 1;
      m2[z * n + x] = Math.min(pm[a], pm[b], pm[c2], pm[d]); M2[z * n + x] = Math.max(pM[a], pM[b], pM[c2], pM[d]);
    }
    mins.push(m2); maxs.push(M2);
  }
  return { mins, maxs, rocks };
}

// ---------------------------------------------------------------- trees
// zones by noise: dense forests, open country, a tree line on the heights
const nForest = makeSimplex2D(5), nKind = makeSimplex2D(9), nZone = makeSimplex2D(19), nZone2 = makeSimplex2D(29);
export function forestDens(X, Z, h) {
  let dens = fbm(nForest, X * 0.0065, Z * 0.0065, 4) * 1.6 + 0.05;
  dens += sst(-0.15, 0.4, fbm(nZone, X * 0.0011 + 9.1, Z * 0.0011, 2)) * 0.75 - 0.2;
  dens -= sst(0.1, 0.45, fbm(nZone2, X * 0.0009 - 3.3, Z * 0.0009, 2)) * 0.35;
  dens -= sst(140, 230, h) * 0.9;
  return dens;
}
// sites keep a clearing round them
function siteClear(sites, x, z, m) {
  for (const s of sites) {
    if (s.type === 'hut' && Math.hypot(x - s.x, z - s.z) < 16 + m) return false;
    if (s.type === 'lookout' && Math.hypot(x - s.x, z - s.z) < 14 + m) return false;
    if (s.type === 'quarry' && Math.hypot((x - s.x) / (s.rx + 4 + m), (z - s.z) / (s.rz + 4 + m)) < 1.05) return false;
  }
  return true;
}
const inLakes = (terrain, x, z, k, m) => terrain.lakes.some(l => Math.hypot((x - l.x) / (l.rx * k + m), (z - l.z) / (l.rz * k + m)) < 1.05);

// dims: per variant { kind, crownR, trunkR }. Returns trees (x, y, z, s, yaw, v per tree, local) and logs
// (x, y, z, yaw, pitch, r, k), and writes the forest floor into the ground and land data
function placeTrees(terrain, dims, gd, ld) {
  const ox = terrain.ox, oz = terrain.oz;
  const trees = [];
  const G = 3.4;
  const nrm = { x: 0, y: 1, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
  const gi0 = Math.ceil((ox - HALF + 6) / G), gi1 = Math.floor((ox + HALF - 6) / G);
  const gj0 = Math.ceil((oz - HALF + 6) / G), gj1 = Math.floor((oz + HALF - 6) / G);
  for (let gi = gi0; gi <= gi1; gi++) for (let gj = gj0; gj <= gj1; gj++) {
    const rnd = rngAt(gi, gj, 3301);
    const X = gi * G + (rnd() - 0.5) * G * 0.9, Z = gj * G + (rnd() - 0.5) * G * 0.9;
    const x = X - ox, z = Z - oz;
    if (Math.abs(x) > HALF - 6 || Math.abs(z) > HALF - 6) continue;
    const y = terrain.surfaceHeight(x, z);
    const dens = forestDens(X, Z, y);
    const p = sst(0.28, 0.8, dens) * 0.72 + 0.008;
    if (rnd() > p) continue;
    if (terrain.isTrail(x, z, 7.5)) continue;
    if (!siteClear(terrain.sites, x, z, 0)) continue;
    if (inLakes(terrain, x, z, 1, 6)) continue;
    if (terrain.waterLevelAt(x, z) > -1e8) continue;
    const sid = terrain.surfaceId(x, z);
    if (sid === SURF.mud || sid === SURF.sand) continue;
    terrain.normalAt(x, z, nrm);
    if (nrm.y < 0.8) continue;
    // species: birches near water and in birch country, pines on high or dry ground, a few snags
    let wet = 0;
    for (const l of terrain.lakes) wet = Math.max(wet, 1 - Math.hypot((x - l.x) / (l.rx + 70), (z - l.z) / (l.rz + 70)));
    const k = nKind(X * 0.01, Z * 0.01), kb = fbm(nKind, X * 0.0013 + 40, Z * 0.0013, 2);
    let vi;
    const roll = rnd();
    if (roll < 0.025) vi = 5;
    else if (roll < 0.06 + wet * 0.6 + sst(0.05, 0.35, kb) * 0.35 + (k > 0.45 ? 0.2 : 0)) vi = 4;
    else if (y > 90 || k < -0.35 || roll < 0.2) vi = rnd() < 0.5 ? 2 : 3;
    else vi = rnd() < 0.55 ? 0 : 1;
    const s = 0.75 + rnd() * 0.5;
    trees.push({ x, y, z, s, yaw: rnd() * Math.PI * 2, v: vi, h: rnd() });
  }
  const nForestTrees = trees.length;

  // lone trees out in the open meadows: big oaks on their own, trees in blossom alone or in little groups (one
  // chance per 36 m cell; away from the forest, trails, water and sites)
  {
    const OCC = 8, ON = Math.ceil(MAP_SIZE / OCC), occ = new Uint8Array(ON * ON);
    const cellOf = (x, z) => Math.min(ON - 1, Math.max(0, Math.floor((x + HALF) / OCC))) * ON + Math.min(ON - 1, Math.max(0, Math.floor((z + HALF) / OCC)));
    for (const t of trees) occ[cellOf(t.x, t.z)] = 1;
    const free = (x, z, r) => {
      for (let dx = -r; dx <= r; dx += OCC) for (let dz = -r; dz <= r; dz += OCC) if (occ[cellOf(x + dx, z + dz)]) return false;
      return true;
    };
    const ok = (x, z, clear) => {
      if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) return false;
      const y = terrain.surfaceHeight(x, z);
      if (forestDens(x + ox, z + oz, y) > 0.22 || terrain.isTrail(x, z, clear + 2)) return false;
      if (!siteClear(terrain.sites, x, z, 2) || inLakes(terrain, x, z, 1, 10)) return false;
      if (terrain.waterLevelAt(x, z) > -1e8 || terrain.surfaceId(x, z) !== SURF.grass) return false;
      return terrain.normalAt(x, z, nrm).y > 0.88 && free(x, z, clear);
    };
    const C = 36;
    for (let ci = Math.ceil((ox - HALF) / C); ci <= Math.floor((ox + HALF) / C); ci++) for (let cj = Math.ceil((oz - HALF) / C); cj <= Math.floor((oz + HALF) / C); cj++) {
      const rnd = rngAt(ci, cj, 3407);
      if (rnd() > 0.3) continue;
      const x = (ci + 0.2 + 0.6 * rnd()) * C - ox, z = (cj + 0.2 + 0.6 * rnd()) * C - oz;
      const oak = rnd() < 0.35;
      if (!ok(x, z, oak ? 12 : 8)) continue;
      const n = oak ? 1 : rnd() < 0.4 ? 1 : 2 + Math.floor(rnd() * 3);
      const placed = [];
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, d = k === 0 ? 0 : 5 + rnd() * 4;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        const vi = oak ? 8 : rnd() < 0.5 ? 6 : 7;
        const s = oak ? 0.85 + rnd() * 0.35 : 0.8 + rnd() * 0.4, yaw = rnd() * Math.PI * 2;
        if (k > 0 && !ok(px, pz, 4)) continue;
        placed.push({ x: px, y: terrain.surfaceHeight(px, pz), z: pz, s, yaw, v: vi, h: 0.5 });
      }
      for (const t of placed) { trees.push(t); occ[cellOf(t.x, t.z)] = 1; }
    }
  }

  // ---- fallen logs on the forest floor, near some of the forest trees (not birches, not the meadow trees)
  const LOG_LEN = [4.2, 6.5, 9.0];
  const logs = [];
  for (let i = 0; i < nForestTrees; i++) {
    const t = trees[i];
    if (t.v === 4 || t.v >= 6 || t.h > 0.022) continue;
    const rnd = mulberry32(Math.floor(t.h * 1e9) ^ 0x2c1b3c6d);
    const a = rnd() * Math.PI * 2, d = 2.5 + rnd() * 4;
    const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
    const L = LOG_LEN[Math.floor(rnd() * 3)], yaw = rnd() * Math.PI * 2;
    const dx = Math.sin(yaw) * L / 2, dz = Math.cos(yaw) * L / 2;
    let ok = true;
    for (const f of [-1, 0, 1]) { const px = x + dx * f, pz = z + dz * f; if (terrain.isTrail(px, pz, 6) || terrain.waterLevelAt(px, pz) > -1e8 || Math.abs(px) > HALF - 20 || Math.abs(pz) > HALF - 20) ok = false; }
    if (!ok || !siteClear(terrain.sites, x, z, 0)) continue;
    const r = 0.14 + rnd() * 0.16 * (L / 6);
    const h0 = terrain.surfaceHeight(x - dx, z - dz), h1 = terrain.surfaceHeight(x + dx, z + dz), hm = terrain.surfaceHeight(x, z);
    if (Math.abs(h1 - h0) > L * 0.45) continue;
    logs.push(x, Math.max((h0 + h1) / 2, hm) + r * 0.8, z, yaw, Math.atan2(h1 - h0, L), r, LOG_LEN.indexOf(L));
  }

  // ---- ground data: forest floor under the crowns, less grass, a little darker; the litter
  for (const t of trees) {
    const v = dims[t.v];
    const litter = v.kind === 'blossom' ? 255 : v.kind === 'spruce' || v.kind === 'pine' ? 0 : 128;
    const R = v.crownR * t.s * (v.kind === 'birch' ? 0.8 : 1.0) + 1.0;
    const cx = Math.round(t.x + HALF), cz = Math.round(t.z + HALF);
    const ri = Math.ceil(R);
    for (let dx = -ri; dx <= ri; dx++) for (let dz = -ri; dz <= ri; dz++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= DN || z >= DN) continue;
      const d = Math.hypot(dx, dz) / R;
      if (d > 1) continue;
      const o = (z * DN + x) * 4;
      const w = 1 - d * d;
      const canopy = v.kind === 'dead' ? 0.3 : v.kind === 'birch' ? 0.65 : v.kind === 'blossom' || v.kind === 'oak' ? 0.5 : 1.0;
      if (255 * w * canopy >= gd[o + 1]) ld[o + 2] = litter;
      gd[o + 1] = Math.min(255, Math.max(gd[o + 1], 255 * w * canopy));
      gd[o + 3] = Math.max(0, gd[o + 3] - 255 * w * canopy * 0.55);
      gd[o] = Math.max(100, gd[o] - 50 * w * canopy - (d < 0.25 ? 30 : 0));
    }
  }
  const T = new Float32Array(trees.length * 6);
  trees.forEach((t, i) => { T.set([t.x, t.y, t.z, t.s, t.yaw, t.v], i * 6); });
  return { trees: T, logs: Float32Array.from(logs) };
}

// ---------------------------------------------------------------- boulders
// A rock's shape: an icosphere cut by random planes (chunky broken-rock faces), then noise-displaced; the mesh pushed
// out onto its convex hull (the collider), so tyres don't float over dents (tools/groundmatch.mjs). Built round its
// own centre, cached by the rock's id across windows.
const rockNoise = makeSimplex2D(99);
const _v = new THREE.Vector3();
function rockShape(rnd, r, flat) {
  let g = new THREE.IcosahedronGeometry(1, r > 0.9 ? 3 : 2);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const seed = rnd() * 100;
  const sx = r * (0.8 + rnd() * 0.5), sy = r * flat * (0.75 + rnd() * 0.4), sz = r * (0.8 + rnd() * 0.5);
  const colors = new Float32Array(pos.count * 3);
  const tint = 0.85 + rnd() * 0.25;
  const planes = [];
  for (let k = 0, n = 5 + Math.floor(rnd() * 4); k < n; k++) {
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.35) * 1.4;
    planes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.74 + rnd() * 0.22]);
  }
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).normalize();
    let rad = 1;
    for (const [px, py, pz, d] of planes) { const c = _v.x * px + _v.y * py + _v.z * pz; if (c > 1e-3) rad = Math.min(rad, d / c); }
    const vx = _v.x * rad, vy = _v.y * rad, vz = _v.z * rad;
    const n = 1 + 0.16 * fbm(rockNoise, vx * 1.3 + seed, vz * 1.3 + vy * 0.7 + seed, 3) + 0.05 * rockNoise(vx * 5 + seed, vy * 5 - vz * 5);
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
    if (onHull.has(pts3[i])) continue;
    const p = pts3[i];
    let t = Infinity;
    for (let k = 0; k < nf * 4; k += 4) { const d = fp[k] * p.x + fp[k + 1] * p.y + fp[k + 2] * p.z; if (d > 1e-9) { const tt = fp[k + 3] / d; if (tt < t) t = tt; } }
    if (t > 1 && t < 2) pos.setXYZ(i, p.x * t, p.y * t, p.z * t);
  }
  g.computeVertexNormals();
  return { pos: new Float32Array(pos.array), nrm: new Float32Array(g.attributes.normal.array), col: colors, idx: new Uint32Array(g.index.array), sx, sy, sz };
}
const shapeCache = new Map();   // rock id -> shape (kept across windows: the worker builds each rock once)

// boulders (one chance per 16 m cell, more on rocky ground; small ones round some) and outcrops (big slabs half
// buried in steeper hillsides, one chance per 48 m cell). Returns one merged mesh (local coordinates) and per rock
// its hull points (round its centre) and centre, for the colliders
function placeRocks(terrain) {
  const ox = terrain.ox, oz = terrain.oz;
  const rocks = [];   // { id, x, z, r, flat, sink, rnd }
  const clear = (x, z, m) => Math.abs(x) < HALF - 4 && Math.abs(z) < HALF - 4 && !terrain.isTrail(x, z, m) && siteClear(terrain.sites, x, z, m - 4) && terrain.waterLevelAt(x, z) < -1e8 && !inLakes(terrain, x, z, 1, 4);
  const slopeAt = (x, z) => Math.hypot(terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;
  const C = 16;
  for (let ci = Math.ceil((ox - HALF) / C); ci < Math.floor((ox + HALF) / C); ci++) for (let cj = Math.ceil((oz - HALF) / C); cj < Math.floor((oz + HALF) / C); cj++) {
    const rnd = rngAt(ci, cj, 5501);
    if (rnd() > 0.16) continue;
    const x = (ci + rnd()) * C - ox, z = (cj + rnd()) * C - oz;
    if (!clear(x, z, 6)) continue;
    const sl = slopeAt(x, z), rocky = terrain.surfaceId(x, z) === SURF.rock ? 1 : Math.min(1, Math.max(0, (sl - 0.2) / 0.35));
    if (rnd() > 0.15 + 0.85 * rocky) continue;
    const big = rnd() < 0.15 + rocky * 0.15;
    const r = big ? 1.2 + rnd() * 1.4 : 0.35 + rnd() * 0.7;
    rocks.push({ id: `b${ci}_${cj}`, seed: (rnd() * 4294967296) >>> 0, x, z, r, flat: 0.65 + rnd() * 0.3, sink: 0.3 });
    if (rnd() < 0.5) for (let c = 0; c < 3; c++) {
      const px = x + (rnd() - 0.5) * r * 4, pz = z + (rnd() - 0.5) * r * 4, seed = (rnd() * 4294967296) >>> 0, rr = r * (0.3 + rnd() * 0.4);
      if (Math.abs(px) < HALF - 4 && Math.abs(pz) < HALF - 4) rocks.push({ id: `b${ci}_${cj}_${c}`, seed, x: px, z: pz, r: rr, flat: 0.7, sink: 0.35 });
    }
  }
  const C2 = 48;
  for (let ci = Math.ceil((ox - HALF) / C2); ci < Math.floor((ox + HALF) / C2); ci++) for (let cj = Math.ceil((oz - HALF) / C2); cj < Math.floor((oz + HALF) / C2); cj++) {
    const rnd = rngAt(ci, cj, 5603);
    if (rnd() > 0.4) continue;
    const x = (ci + rnd()) * C2 - ox, z = (cj + rnd()) * C2 - oz;
    if (!clear(x, z, 10)) continue;
    const sl = slopeAt(x, z);
    if (sl < 0.3 || sl > 0.9) continue;
    rocks.push({ id: `o${ci}_${cj}`, seed: (rnd() * 4294967296) >>> 0, x, z, r: 2.4 + rnd() * 2.2, flat: 0.55 + rnd() * 0.2, sink: 0.5 });
  }
  // geometry
  let nv = 0, ni = 0;
  const shapes = rocks.map(rk => {
    let s = shapeCache.get(rk.id);
    if (!s) {
      s = rockShape(mulberry32(rk.seed), rk.r, rk.flat);
      shapeCache.set(rk.id, s);
    }
    nv += s.pos.length / 3; ni += s.idx.length;
    return s;
  });
  if (shapeCache.size > 6000) shapeCache.clear();
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  const hulls = [];
  let vo = 0, io = 0;
  rocks.forEach((rk, k) => {
    const s = shapes[k];
    const ground = Math.min(terrain.heightAt(rk.x - s.sx * 0.5, rk.z), terrain.heightAt(rk.x + s.sx * 0.5, rk.z), terrain.heightAt(rk.x, rk.z - s.sz * 0.5), terrain.heightAt(rk.x, rk.z + s.sz * 0.5), terrain.heightAt(rk.x, rk.z));
    const y = ground + s.sy * (1 - rk.sink) - s.sy, cy = y + s.sy;
    const n = s.pos.length / 3;
    for (let i = 0; i < n; i++) {
      pos[(vo + i) * 3] = s.pos[i * 3] + rk.x; pos[(vo + i) * 3 + 1] = s.pos[i * 3 + 1] + cy; pos[(vo + i) * 3 + 2] = s.pos[i * 3 + 2] + rk.z;
    }
    nrm.set(s.nrm, vo * 3); col.set(s.col, vo * 3);
    for (let i = 0; i < s.idx.length; i++) idx[io + i] = s.idx[i] + vo;
    hulls.push({ x: rk.x, y: cy, z: rk.z, pts: s.pos });
    vo += n; io += s.idx.length;
  });
  return { pos, nrm, col, idx, hulls };
}

// ---------------------------------------------------------------- the whole bake
// dims: tree variant dims (treeKinds.js). Returns plain arrays (transferable)
export function bakeWindow(terrain, dims) {
  const t0 = performance.now(), times = {};
  let tt = t0;
  const lap = (k) => { const t = performance.now(); times[k] = Math.round(t - tt); tt = t; };
  const splat = makeSplat(terrain);
  lap('splat');
  const hgt = new Float32Array(DN * DN);
  for (let x = 0; x < DN; x++) for (let z = 0; z < DN; z++) hgt[z * DN + x] = terrain.heights[Math.min(N, x * 2) * NN + Math.min(N, z * 2)];
  const groundData = makeGroundData(terrain, splat, hgt);
  lap('ground');
  const wet = new Float32Array(DN * DN);
  for (let i = 0; i < DN * DN; i++) wet[i] = groundData[i * 4 + 2] / 255;
  const landData = bakeLand(terrain, hgt, wet);
  lap('land');
  const { trees, logs } = placeTrees(terrain, dims, groundData, landData);
  lap('trees');
  const rocks = placeRocks(terrain);
  lap('rocks');
  const pyramid = makePyramid(terrain);
  lap('pyramid');
  // the grass density's max over 2^l x 2^l m blocks (grass.js skips tiles with none)
  const grassDens = [];
  {
    let w = DN, cur = new Uint8Array(DN * DN);
    for (let i = 0; i < DN * DN; i++) cur[i] = groundData[i * 4 + 3];
    grassDens.push({ w, a: cur });
    while (w > 1) {
      const w2 = Math.ceil(w / 2), nxt = new Uint8Array(w2 * w2);
      for (let z = 0; z < w2; z++) for (let x = 0; x < w2; x++) {
        const x0 = 2 * x, z0 = 2 * z, x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(w - 1, z0 + 1);
        nxt[z * w2 + x] = Math.max(cur[z0 * w + x0], cur[z0 * w + x1], cur[z1 * w + x0], cur[z1 * w + x1]);
      }
      w = w2; cur = nxt;
      grassDens.push({ w, a: cur });
    }
  }
  return { splat, groundData, landData, groundN: DN, trees, logs, rocks, pyramid, grassDens, bakeTimes: times };
}
