import * as THREE from 'three';
import { makeSimplex2D, mulberry32, fbm, ridged, smoothstep, lerp } from './noise.js';
import { SURFACES } from '../vehicle/tire.js';

// Procedural map, 1 km square with a 0.5 m physics grid:
// - the original 400 m core: rolling hills, a big hill, the trail loop + branch with ruts and a mud hole,
//   and the proving ground with five test lanes (unchanged);
// - around it: an outer trail loop through a lake shore with a ford, meadows and a ruined hut, an old
//   quarry, a rocky lookout peak with a spur trail to the top, and a conifer forest;
// - mountains along the edge that continue into a render-only vista (8 km, 8 m grid, see `far`).
// Heights are a coarse low-frequency field (2 m grid, bilinear) plus per-vertex detail, which keeps the
// generation of 4.2 M heights well under a second.

export const MAP_SIZE = 1024;
export const CELL = 0.5;
export const N = Math.round(MAP_SIZE / CELL); // cells per side
export const SURF = { grass: 0, dirt: 1, rock: 2, mud: 3, sand: 4 };
export const SURF_LIST = [SURFACES.grass, SURFACES.dirt, SURFACES.rock, SURFACES.mud, SURFACES.sand];

export const FAR_SIZE = 8192, FAR_CELL = 16, FAR_N = FAR_SIZE / FAR_CELL; // render-only vista heightmap (16 m grid)

export const SPAWN = { x: 0, z: 46, yaw: 0 };
export const PAD = { x0: -80, x1: -12, z0: -38, z1: 52 };
export const LANES = { A: -22, B: -33, C: -44, D: -55, E: -66 };
export const HILL = { x: 72, z: -30, r: 52, h: 24 };

// TEMPORARY (grass preset tuning, remove with src/vegTuner.js): with ?vegtune in the URL the map gets a flat
// grass meadow here (no trails or water within 80 m), with no trees or rocks, and the game starts on it
export const MEADOW = typeof location !== 'undefined' && new URLSearchParams(location.search).has('vegtune')
  ? { x: 300, z: 340, r: 60, blend: 35 } : null;

// points of interest (teleports in main.js)
export const POI = {
  lake: { x: 300, z: 70, rx: 82, rz: 58 },
  ford: { x: 268, z: -238 },
  hut: { x: 168, z: 341, yaw: -2.68 },
  quarry: { x: -286, z: 262, rx: 46, rz: 32, depth: 11 },
  peak: { x: -318, z: -250, r: 150, h: 66 },
  lookout: { x: -318, z: -250 },
  forest: { x: -60, z: -300 },
};

export const TRAILS = [
  // core loop + branch (original)
  { closed: true, pts: [[0, 50], [0, -20], [15, -70], [60, -108], [112, -100], [136, -42], [132, 28], [110, 78], [60, 105], [15, 92], [0, 72]] },
  { closed: false, pts: [[0, -20], [-40, -62], [-100, -84], [-134, -30], [-132, 60], [-100, 112], [-40, 126], [15, 92]] },
  // outer loop: from the core loop's north-east corner, round the map clockwise, back in through the forest
  { closed: false, maxGrade: 16, pts: [[112, -100], [168, -160], [222, -214], [268, -238], [322, -214], [372, -150], [404, -60], [412, 40], [396, 140], [338, 198],
    [262, 238], [196, 300], [120, 338], [30, 352], [-70, 340], [-170, 318], [-236, 300], [-286, 314], [-324, 302], [-354, 258], [-372, 170],
    [-390, 60], [-388, -40], [-356, -128], [-282, -146], [-220, -196], [-160, -268], [-80, -312], [0, -296], [56, -246], [92, -180], [112, -100]] },
  // link from the core branch west to the outer loop
  { closed: false, maxGrade: 16, pts: [[-134, -30], [-190, -24], [-250, -10], [-310, 10], [-389, 30]] },
  // spur up the lookout peak: a spiral (1.4 turns, rings > 45 m apart) from the outer loop to the summit
  { closed: false, maxGrade: 15, pts: spiralPts() },
];
function spiralPts() {
  // leave the loop heading straight for the peak, then wind up anticlockwise (seen from above)
  const pk = { x: -318, z: -250 }, pts = [[-282, -146], [-288, -164]];
  const sx = -294, sz = -180, a0 = Math.atan2(sz - pk.z, sx - pk.x), R0 = Math.hypot(sx - pk.x, sz - pk.z), turns = 1.35;
  for (let k = 0; k <= 22; k++) {
    const f = k / 22, a = a0 - f * turns * Math.PI * 2, r = R0 * (1 - f) + 5 * f;
    pts.push([Math.round(pk.x + Math.cos(a) * r), Math.round(pk.z + Math.sin(a) * r)]);
  }
  return pts;
}

// stream from the north-east mountains to the lake (water ~0.35 m deep over a gravel bed)
export const STREAM = [[150, -500], [176, -420], [214, -340], [252, -276], [268, -238], [292, -190], [324, -120], [334, -40], [322, 18]];

export class Terrain {
  constructor(seed = 7) {
    this.seed = seed;
    const NN = N + 1;
    this.NN = NN;
    this.heights = new Float32Array(NN * NN);   // index = ix * NN + iz  (Rapier column-major layout)
    this.surface = new Uint8Array(NN * NN);
    this.trailDist = new Float32Array(NN * NN).fill(1e9);
    this.water = [];
    const t0 = performance.now();
    this.generate();
    this.genMs = performance.now() - t0;
  }

  idx(ix, iz) { return ix * this.NN + iz; }
  worldX(ix) { return -MAP_SIZE / 2 + ix * CELL; }

  // ---------------------------------------------------------------- height functions
  setupNoise() {
    const s = this.seed;
    this.n1 = makeSimplex2D(s); this.n2 = makeSimplex2D(s + 11); this.n3 = makeSimplex2D(s + 23);
    this.n4 = makeSimplex2D(s + 37); this.n5 = makeSimplex2D(s + 51); this.n6 = makeSimplex2D(s + 67);
  }

  // low-frequency field, defined everywhere (also the vista): the core terrain blended into the outer design
  coarse(x, z) {
    const { n1, n2, n3, n4, n5, n6 } = this;
    const r = Math.hypot(x, z), rb = Math.max(Math.abs(x), Math.abs(z));
    const wCore = smoothstep(200, 140, r);
    const base = r < 1400 ? fbm(n1, x * 0.0055, z * 0.0055, 4) * 10 : 0;
    // core (original map): fbm hills + the big hill
    let core = base;
    if (wCore > 0) {
      const dh = Math.hypot(x - HILL.x, z - HILL.z);
      if (dh < HILL.r) {
        const hs = smoothstep(HILL.r, HILL.r * 0.18, dh);
        core += HILL.h * hs * hs * (0.85 + 0.15 * ridged(n2, x * 0.02, z * 0.02, 2));
      }
      if (wCore >= 1) { this._lakeW = 0; return core; }
    }
    // outer: broader rolling hills, a low ridge ring between core and outer zones (with gaps), edge mountains
    let outer = base + (fbm(n4, x * 0.0028, z * 0.0028, 3) * 18 + fbm(n5, x * 0.009, z * 0.009, 2) * 5) * (1 - smoothstep(900, 1600, r));
    const ring = smoothstep(150, 200, r) * smoothstep(290, 220, r);
    if (ring > 0) {
      const gaps = smoothstep(0.15, 0.55, Math.abs(Math.sin(Math.atan2(z, x) * 2.5 + 0.6)));
      if (gaps > 0) outer += ring * gaps * (9 + 12 * ridged(n5, x * 0.012, z * 0.012, 3));
    }
    // edge mountains (rise from ~430 m), continuing into the vista
    const edge = smoothstep(400, 520, rb) * (1 - smoothstep(1200, 2200, r));
    if (edge > 0) {
      const mtn = 40 + 85 * ridged(n6, x * 0.0045, z * 0.0045, 5) + 30 * fbm(n3, x * 0.002, z * 0.002, 3);
      outer += edge * mtn * (0.7 + 0.3 * smoothstep(-0.2, 0.6, n5(x * 0.003, z * 0.003)));
    }
    // vista: big ranges further out (precomputed on a 16 m grid when available)
    const far = smoothstep(500, 1400, r);
    if (far > 0) outer += far * (this.rangeGrid ? this.rangeAt(x, z) : this.ranges(x, z));
    // lookout peak (west-north-west)
    const pk = POI.peak, dp = Math.hypot(x - pk.x, z - pk.z);
    if (dp < pk.r) {
      const cone = smoothstep(pk.r, 0, dp);
      outer += pk.h * (cone * (0.6 + 0.4 * cone)) * (0.9 + 0.1 * ridged(n2, x * 0.03, z * 0.03, 2));
    }
    // quarry pit (south-west): flat floor, steep terraced walls
    const q = POI.quarry, eq = Math.hypot((x - q.x) / q.rx, (z - q.z) / q.rz);
    if (eq < 1.2) {
      const pit = smoothstep(1.15, 0.85, eq);
      outer -= q.depth * (Math.floor(pit * 3) / 3 * 0.5 + pit * 0.5);
    }
    // lake basin (east): carved later, the mask is kept for the shore blend
    const lk = POI.lake, el = Math.hypot((x - lk.x) / lk.rx, (z - lk.z) / lk.rz);
    this._lakeW = el < 1.4 ? smoothstep(1.35, 0.8, el) : 0;
    return wCore > 0 ? lerp(outer, core, wCore) : outer;
  }

  ranges(x, z) { return 80 + 260 * ridged(this.n6, x * 0.0011 + 3.1, z * 0.0011, 5) * smoothstep(-0.5, 0.5, this.n4(x * 0.0005, z * 0.0005)); }
  rangeAt(x, z) {
    const g = this.rangeGrid, n = g.n, fx = Math.max(0, Math.min(n - 1.001, (x + FAR_SIZE / 2) / 16)), fz = Math.max(0, Math.min(n - 1.001, (z + FAR_SIZE / 2) / 16));
    const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0, o = i0 * n + j0, h = g.h;
    return (h[o] * (1 - tx) + h[o + n] * tx) * (1 - tz) + (h[o + 1] * (1 - tx) + h[o + n + 1] * tx) * tz;
  }

  // mid detail (1 m grid): small hills, felt as gentle undulation
  mid(x, z) { return fbm(this.n2, x * 0.028, z * 0.028, 3) * 1.4; }
  // fine detail (per vertex): bumpiness you feel in the seat
  fine(x, z) { return fbm(this.n3, x * 0.22, z * 0.22, 2) * 0.13; }
  // the same kind of detail as a seamless 128 m tile of periodic gradient noise (4.2 M simplex lookups
  // per vertex were the slowest part of the generation otherwise)
  makeFineTile() {
    const T = 256, t = new Float32Array(T * T);
    const rnd = mulberry32(this.seed * 977 + 13);
    const grads = (P) => { const g = new Float32Array(P * P * 2); for (let k = 0; k < P * P; k++) { const a = rnd() * Math.PI * 2; g[k * 2] = Math.cos(a); g[k * 2 + 1] = Math.sin(a); } return g; };
    const perlin = (g, P, x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const q = (i, j, dx, dy) => { const k = ((((i % P) + P) % P) * P + (((j % P) + P) % P)) * 2; return g[k] * dx + g[k + 1] * dy; };
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      const a = q(xi, yi, fx, fy), b = q(xi + 1, yi, fx - 1, fy), c = q(xi, yi + 1, fx, fy - 1), d = q(xi + 1, yi + 1, fx - 1, fy - 1);
      return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) * 1.6;
    };
    const P1 = 28, P2 = 56, g1 = grads(P1), g2 = grads(P2);
    for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
      const u = i / T, v = j / T;
      t[i * T + j] = (perlin(g1, P1, u * P1, v * P1) + 0.5 * perlin(g2, P2, u * P2, v * P2)) / 1.5 * 0.13;
    }
    this.fineTile = t; this.fineT = T;
  }

  generate() {
    this.setupNoise();
    const NN = this.NN, H = this.heights, half = MAP_SIZE / 2;

    // ---- vista heightmap (8 km, 16 m) first: the physics map border blends into it exactly
    const RN = FAR_SIZE / 16 + 1, rh = new Float32Array(RN * RN);
    for (let i = 0; i < RN; i++) for (let j = 0; j < RN; j++) {
      const x = -FAR_SIZE / 2 + i * 16, z = -FAR_SIZE / 2 + j * 16;
      rh[i * RN + j] = Math.hypot(x, z) > 480 ? this.ranges(x, z) : 0;
    }
    this.rangeGrid = { h: rh, n: RN };
    const FN = FAR_N + 1, fh = new Float32Array(FN * FN);
    for (let i = 0; i < FN; i++) {
      const x = -FAR_SIZE / 2 + i * FAR_CELL;
      for (let j = 0; j < FN; j++) {
        const z = -FAR_SIZE / 2 + j * FAR_CELL;
        fh[i * FN + j] = this.coarse(x, z);
      }
    }
    // soften the creases of the ridged noise a little (one 3x3 pass), it reads less faceted at 16 m
    const sm = new Float32Array(fh.length);
    for (let i = 0; i < FN; i++) for (let j = 0; j < FN; j++) {
      let s = 0, w = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const ii = Math.min(FN - 1, Math.max(0, i + a)), jj = Math.min(FN - 1, Math.max(0, j + b));
        const k = (a === 0 && b === 0) ? 4 : (a === 0 || b === 0) ? 2 : 1;
        s += fh[ii * FN + jj] * k; w += k;
      }
      sm[i * FN + j] = s / w;
    }
    this.far = { heights: sm, n: FN, size: FAR_SIZE, cell: FAR_CELL };

    // ---- coarse (2 m) and mid (1 m) grids, bilinear-upsampled to the 0.5 m grid, plus the fine tile
    const C2 = 4, CN = N / C2 + 1;
    const cg = new Float32Array(CN * CN), lakeW = new Float32Array(CN * CN);
    for (let i = 0; i < CN; i++) for (let j = 0; j < CN; j++) {
      cg[i * CN + j] = this.coarse(-half + i * C2 * CELL, -half + j * C2 * CELL);
      lakeW[i * CN + j] = this._lakeW;
    }
    const M2 = 2, MN = N / M2 + 1;
    const mg = new Float32Array(MN * MN);
    for (let i = 0; i < MN; i++) for (let j = 0; j < MN; j++) mg[i * MN + j] = this.mid(-half + i * M2 * CELL, -half + j * M2 * CELL);
    this.makeFineTile();
    const ft = this.fineTile, FT = this.fineT;
    this.lakeMask = new Float32Array(NN * NN);
    const LM = this.lakeMask;
    const border = 40; // m: blend into the vista heightmap at the map edge
    for (let ix = 0; ix < NN; ix++) {
      const x = -half + ix * CELL;
      const bx = half - Math.abs(x);
      const ci = Math.min(CN - 2, ix >> 2), ctx = ix / 4 - ci;
      const mi = Math.min(MN - 2, ix >> 1), mtx = ix / 2 - mi;
      const fo = ((ix + 2048 * FT) % FT) * FT;
      for (let iz = 0; iz < NN; iz++) {
        const i = ix * NN + iz;
        const cj = Math.min(CN - 2, iz >> 2), ctz = iz / 4 - cj, co = ci * CN + cj;
        const mj = Math.min(MN - 2, iz >> 1), mtz = iz / 2 - mj, mo = mi * MN + mj;
        let h = (cg[co] * (1 - ctx) + cg[co + CN] * ctx) * (1 - ctz) + (cg[co + 1] * (1 - ctx) + cg[co + CN + 1] * ctx) * ctz
          + (mg[mo] * (1 - mtx) + mg[mo + MN] * mtx) * (1 - mtz) + (mg[mo + 1] * (1 - mtx) + mg[mo + MN + 1] * mtx) * mtz
          + ft[fo + (iz % FT)];
        const b = Math.min(bx, half - Math.abs(-half + iz * CELL));
        if (b < border) { const z = -half + iz * CELL; h = lerp(this.farHeight(x, z), h, smoothstep(0, border, b)); }
        H[i] = h;
        const lw = (lakeW[co] * (1 - ctx) + lakeW[co + CN] * ctx) * (1 - ctz) + (lakeW[co + 1] * (1 - ctx) + lakeW[co + CN + 1] * ctx) * ctz;
        if (lw > 0) LM[i] = lw;
      }
    }

    // ---- lake: flatten the basin below the water level (shallow shelf, then deeper middle)
    this.carveLake();

    // ---- level ground for the ruined hut
    {
      const hu = POI.hut, hh = this.heightAt(hu.x, hu.z);
      this.stampEllipse(hu.x, hu.z, 11, 11, (x, z, i, e) => { H[i] = lerp(H[i], hh, smoothstep(1.45, 0.8, e)); });
    }

    // ---- proving ground pad + spawn clearing (flattened)
    const coreH = (x, z) => this.coarse(x, z) + this.mid(x, z) + this.fine(x, z);
    const padH = coreH((PAD.x0 + PAD.x1) / 2, (PAD.z0 + PAD.z1) / 2);
    this.padH = padH;
    const spawnH = coreH(SPAWN.x, SPAWN.z);
    this.stampRect(PAD.x0 - 16, PAD.x1 + 16, PAD.z0 - 16, PAD.z1 + 16, (x, z, i) => {
      const dx = Math.max(PAD.x0 - x, 0, x - PAD.x1), dz = Math.max(PAD.z0 - z, 0, z - PAD.z1);
      const dPad = Math.hypot(dx, dz);
      const wPad = smoothstep(14, 0, dPad);
      const small = fbm(this.n3, x * 0.22, z * 0.22, 2) * 0.05;
      H[i] = lerp(H[i], padH + small, wPad);
      if (dPad === 0) this.surface[i] = SURF.dirt;
    });
    this.stampEllipse(SPAWN.x, SPAWN.z, 22, 22, (x, z, i) => {
      const dx = Math.max(PAD.x0 - x, 0, x - PAD.x1), dz = Math.max(PAD.z0 - z, 0, z - PAD.z1);
      const wPad = smoothstep(14, 0, Math.hypot(dx, dz));
      H[i] = lerp(H[i], spawnH, smoothstep(22, 8, Math.hypot(x - SPAWN.x, z - SPAWN.z)) * (1 - wPad));
    });

    // ---- trails
    this.buildTrails();

    // ---- stream (after the trails: the ford dips the outer trail into the bed)
    this.carveStream();

    // ---- mud hole on the main trail (at the bottom of a dip) + mud lane on the pad
    const mp = this.trailCurves[0].getPointAt(0.085);
    const muds = [{ x: mp.x, z: mp.z, rx: 7, rz: 11, depth: 0.32 }, { x: LANES.E, z: 28, rx: 5, rz: 9, depth: 0.55 }];
    this.muds = muds;
    for (const m of muds) this.stampEllipse(m.x, m.z, m.rx, m.rz, (x, z, i, e) => {
      const w = smoothstep(1.3, 0.6, e);
      H[i] -= m.depth * w * (0.8 + 0.2 * this.n1(x * 0.3, z * 0.3));
      if (e < 1.0) this.surface[i] = SURF.mud;
    }, 4);

    this.smoothTrailBeds();

    // muddy pools in the bottom of the mud holes (visual water, the bed stays mud)
    for (const m of muds) {
      let lo = 1e9, rim = 1e9;
      this.stampEllipse(m.x, m.z, m.rx, m.rz, (x, z, i, e) => { if (e < 0.7) lo = Math.min(lo, H[i]); });
      for (let a = 0; a < 32; a++) { const t = a / 32 * Math.PI * 2; rim = Math.min(rim, this.heightAt(m.x + Math.cos(t) * m.rx * 0.8, m.z + Math.sin(t) * m.rz * 0.8)); }
      const level = Math.min(lo + 0.12, rim - 0.03);
      if (level > lo + 0.03) this.water.push({ type: 'pool', x: m.x, z: m.z, rx: m.rx * 0.95, rz: m.rz * 0.95, level, muddy: true });
    }

    this.buildLanes();

    // ---- surfaces: rock on steep slopes and mountain tops, quarry floor gravel, sand along the lake
    const q = POI.quarry;
    for (let ix = 1; ix < N; ix++) {
      const x = -half + ix * CELL;
      for (let iz = 1; iz < N; iz++) {
        const i = ix * NN + iz;
        if (this.surface[i] !== SURF.grass) continue;
        const z = -half + iz * CELL;
        const gx = (H[i + NN] - H[i - NN]) / (2 * CELL), gz = (H[i + 1] - H[i - 1]) / (2 * CELL);
        const slope = Math.hypot(gx, gz);
        if (slope > 0.72) { this.surface[i] = SURF.rock; continue; }
        const eq = Math.hypot((x - q.x) / q.rx, (z - q.z) / q.rz);
        if (eq < 1.05) { this.surface[i] = slope > 0.45 ? SURF.rock : SURF.sand; continue; }
        if (H[i] > 70 && slope > 0.35) this.surface[i] = SURF.rock;
      }
    }

    // the test meadow (MEADOW): level at its centre height (keeping the fine bumps), blended into the hills
    if (MEADOW) {
      const m = MEADOW, h0 = this.heightAt(m.x, m.z), out = (m.r + m.blend) / m.r;
      this.stampEllipse(m.x, m.z, m.r, m.r, (x, z, i, e) => {
        if (e > out) return;
        const w = smoothstep(out, 1, e);
        H[i] += (h0 + this.fine(x, z) - H[i]) * w;
        if (e < 1.15) this.surface[i] = SURF.grass;
      });
    }
  }

  farHeight(x, z) {
    const f = this.far, n = f.n;
    const fx = Math.max(0, Math.min(n - 1.001, (x + f.size / 2) / f.cell));
    const fz = Math.max(0, Math.min(n - 1.001, (z + f.size / 2) / f.cell));
    const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0, o = i0 * n + j0, g = f.heights;
    return (g[o] * (1 - tx) + g[o + n] * tx) * (1 - tz) + (g[o + 1] * (1 - tx) + g[o + n + 1] * tx) * tz;
  }

  carveLake() {
    const lk = POI.lake, H = this.heights;
    // water level: a little below the lowest point of the shore ring
    let shore = 1e9;
    for (let a = 0; a < 64; a++) {
      const t = a / 64 * Math.PI * 2;
      shore = Math.min(shore, this.heightAt(lk.x + Math.cos(t) * lk.rx * 1.12, lk.z + Math.sin(t) * lk.rz * 1.12));
    }
    const level = shore - 0.35;
    this.lake = { ...lk, level };
    this.stampEllipse(lk.x, lk.z, lk.rx, lk.rz, (x, z, i, e) => {
      if (e > 1.4) return;
      const n = this.n4(x * 0.05, z * 0.05) * 0.08;
      // shore: blend to slightly above the water; shallow shelf; deep middle (1.8 m)
      const bed = level - 0.25 - 1.6 * smoothstep(0.75, 0.2, e + n) - 0.3 * smoothstep(1.0, 0.8, e + n);
      const w = smoothstep(1.32, 0.95, e + n);
      H[i] = lerp(H[i], Math.min(H[i], bed), w);
      if (e + n < 1.12) this.surface[i] = H[i] < level + 0.05 ? (e + n < 0.8 ? SURF.mud : SURF.sand) : SURF.sand;
    }, 0);
    this.water.push({ type: 'lake', x: lk.x, z: lk.z, rx: lk.rx * 1.1, rz: lk.rz * 1.1, level });
  }

  carveStream() {
    const H = this.heights, NN = this.NN, half = MAP_SIZE / 2;
    const pts = STREAM.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const len = curve.getLength(), ns = Math.ceil(len / 1);
    const sp = curve.getSpacedPoints(ns);
    // bed profile: smoothed terrain minimum along the curve, forced downhill towards the lake
    let hs = sp.map(p => {
      let m = 1e9;
      for (const o of [-3, 0, 3]) m = Math.min(m, this.heightAt(p.x + o, p.z), this.heightAt(p.x, p.z + o));
      return m;
    });
    for (let pass = 0; pass < 3; pass++) {
      const o = hs.slice();
      for (let k = 0; k < hs.length; k++) { let s = 0, c = 0; for (let j = -10; j <= 10; j++) { const kk = Math.max(0, Math.min(hs.length - 1, k + j)); s += hs[kk]; c++; } o[k] = s / c; }
      hs = o;
    }
    const lakeLevel = this.lake.level;
    for (let k = hs.length - 2; k >= 0; k--) hs[k] = Math.max(hs[k], hs[k + 1] + 0.02);
    for (let k = 1; k < hs.length; k++) hs[k] = Math.min(hs[k], hs[k - 1]);
    const n = hs.length;
    const surfLevel = new Float32Array(n), width = new Float32Array(n);
    const ford = POI.ford;
    for (let k = 0; k < n; k++) {
      const p = sp[k];
      const dF = Math.hypot(p.x - ford.x, p.z - ford.z);
      const fordW = smoothstep(26, 6, dF);
      width[k] = 3.2 + 1.6 * (0.5 + 0.5 * this.n5(k * 0.02, 3.3)) + fordW * 3.5;
      const end = smoothstep(n - 40, n - 1, k);
      surfLevel[k] = lerp(hs[k] - 0.45, lakeLevel, end);
    }
    this.streamCurve = curve;
    this.streamPts = sp; this.streamLevel = surfLevel; this.streamWidth = width;
    // carve: bed = surface - depth (shallower and wider at the ford), soft banks
    const R = 12;
    for (let k = 0; k < n - 1; k++) {
      const a = sp[k], b = sp[k + 1];
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R + half) / CELL)), ix1 = Math.min(N, Math.ceil((Math.max(a.x, b.x) + R + half) / CELL));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - R + half) / CELL)), iz1 = Math.min(N, Math.ceil((Math.max(a.z, b.z) + R + half) / CELL));
      const abx = b.x - a.x, abz = b.z - a.z, ab2 = abx * abx + abz * abz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * CELL;
        for (let iz = iz0; iz <= iz1; iz++) {
          const z = -half + iz * CELL;
          let u = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
          u = Math.max(0, Math.min(1, u));
          const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
          const w = width[k] + (width[k + 1] - width[k]) * u;
          if (d > w + 7) continue;
          const lvl = surfLevel[k] + (surfLevel[k + 1] - surfLevel[k]) * u;
          const dF = Math.hypot(x - ford.x, z - ford.z);
          const depth = lerp(0.62, 0.32, smoothstep(24, 8, dF));
          const bed = lvl - depth * (1 - Math.pow(Math.min(1, d / w), 2));
          const i = ix * NN + iz;
          // banks: never raise the ground, ease from the bed to the terrain over a few metres
          const bankW = lerp(3.5, 9, smoothstep(26, 8, dF));
          const t = smoothstep(w, w + bankW, d);
          const target = lerp(bed, Math.max(H[i], lvl + 0.15), t);
          if (target < H[i]) {
            H[i] = target;
            if (d < w + 0.6) this.surface[i] = SURF.sand;
          }
        }
      }
    }
    this.water.push({ type: 'stream', pts: sp, level: surfLevel, width });
  }

  buildTrails() {
    const NN = this.NN, H = this.heights, half = MAP_SIZE / 2;
    this.trailCurves = [];
    const trailSamples = [];
    const dist = new Float32Array(NN * NN).fill(1e9), th = new Float32Array(NN * NN);
    const wsum = new Float32Array(NN * NN), hsum = new Float32Array(NN * NN), wmax = new Float32Array(NN * NN);
    const touchedAll = [];
    for (let ti = 0; ti < TRAILS.length; ti++) {
      const t = TRAILS[ti];
      const pts = t.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
      const curve = new THREE.CatmullRomCurve3(pts, t.closed, 'centripetal');
      const len = curve.getLength();
      const ns = Math.ceil(len / 0.5);
      const sp = curve.getSpacedPoints(ns);
      this.trailCurves.push(curve);
      let hs = sp.map(p => this.heightAt(p.x, p.z));
      // outer trails run through rougher ground: smooth longer
      const passes = ti < 2 ? 4 : 6, W = ti < 2 ? 18 : 30;
      for (let pass = 0; pass < passes; pass++) {
        const o = new Array(hs.length);
        for (let k = 0; k < hs.length; k++) {
          let sum = 0, c = 0;
          for (let j = -W; j <= W; j++) {
            let kk = k + j;
            if (t.closed) kk = (kk + hs.length) % hs.length; else kk = Math.max(0, Math.min(hs.length - 1, kk));
            sum += hs[kk]; c++;
          }
          o[k] = sum / c;
        }
        hs = o;
      }
      // new (outer) trails: limit the grade by cutting through crests (cut only, never fill)
      const maxG = t.maxGrade ? Math.tan(t.maxGrade * Math.PI / 180) * (len / ns) : 0;
      if (maxG) {
        for (let k = 1; k < hs.length; k++) hs[k] = Math.min(hs[k], hs[k - 1] + maxG);
        for (let k = hs.length - 2; k >= 0; k--) hs[k] = Math.min(hs[k], hs[k + 1] + maxG);
      }
      // a trail that meets earlier trails at its ends: pull its heights onto theirs
      if (!t.closed && trailSamples.length) {
        const nearestH = (p) => {
          let bd = 1e9, bh = 0;
          for (const ts of trailSamples) for (let k = 0; k < ts.sp.length; k++) {
            const d = (ts.sp[k].x - p.x) ** 2 + (ts.sp[k].z - p.z) ** 2;
            if (d < bd) { bd = d; bh = ts.hs[k]; }
          }
          return bd < 64 ? bh : null;
        };
        const h0 = nearestH(sp[0]), h1 = nearestH(sp[sp.length - 1]);
        const blend = 120; // samples (60 m)
        const d0 = h0 !== null ? h0 - hs[0] : 0, d1 = h1 !== null ? h1 - hs[hs.length - 1] : 0;
        for (let k = 0; k < hs.length; k++) {
          hs[k] += d0 * Math.max(0, 1 - k / blend) + d1 * Math.max(0, 1 - (hs.length - 1 - k) / blend);
        }
        if (maxG) {
          // the end corrections can steepen the first / last metres again: cut once more, ends pinned
          const e0 = hs[0], e1 = hs[hs.length - 1];
          for (let k = 1; k < hs.length; k++) hs[k] = Math.min(hs[k], hs[k - 1] + maxG);
          for (let k = hs.length - 2; k >= 0; k--) hs[k] = Math.min(hs[k], hs[k + 1] + maxG);
          hs[0] = e0; hs[hs.length - 1] = e1;
        }
      }
      // round off the kinks the grade limit leaves where a cut starts or ends (they are crests)
      if (maxG) {
        for (let pass = 0; pass < 3; pass++) {
          const o = hs.slice();
          for (let k = 1; k < hs.length - 1; k++) {
            let sum = 0, c = 0;
            for (let j = -12; j <= 12; j++) { const kk = Math.max(0, Math.min(hs.length - 1, k + j)); sum += hs[kk]; c++; }
            o[k] = sum / c;
          }
          hs = o;
        }
      }
      trailSamples.push({ sp, hs });
      // rasterise this trail's distance field into the band around it
      const R = 6, touched = [];
      for (let k = 0; k < sp.length - 1; k++) {
        const a = sp[k], b = sp[k + 1];
        const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R + half) / CELL)), ix1 = Math.min(N, Math.ceil((Math.max(a.x, b.x) + R + half) / CELL));
        const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - R + half) / CELL)), iz1 = Math.min(N, Math.ceil((Math.max(a.z, b.z) + R + half) / CELL));
        const abx = b.x - a.x, abz = b.z - a.z, ab2 = abx * abx + abz * abz;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = -half + ix * CELL;
          for (let iz = iz0; iz <= iz1; iz++) {
            const z = -half + iz * CELL;
            let u = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
            u = Math.max(0, Math.min(1, u));
            const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
            const i = ix * NN + iz;
            if (d < dist[i]) {
              if (dist[i] === 1e9) touched.push(i);
              dist[i] = d; th[i] = hs[k] + (hs[k + 1] - hs[k]) * u;
            }
          }
        }
      }
      for (const i of touched) {
        const d = dist[i];
        if (d <= 6) {
          const w = smoothstep(5.5, 2.4, d);
          if (wsum[i] === 0) touchedAll.push(i);
          wsum[i] += 1e-3 + w; hsum[i] += (1e-3 + w) * th[i];
          if (w > wmax[i]) wmax[i] = w;
          if (d < this.trailDist[i]) this.trailDist[i] = d;
        }
        dist[i] = 1e9;
      }
    }
    // the band's detail (ruts, crown, noise) is kept apart so smoothTrailBeds() can low-pass the bed under it
    const detail = new Float32Array(touchedAll.length), weight = new Float32Array(touchedAll.length);
    touchedAll.forEach((i, k) => {
      const ix = Math.floor(i / NN), iz = i - ix * NN;
      const x = -half + ix * CELL, z = -half + iz * CELL;
      const dmin = this.trailDist[i], wm = wmax[i];
      H[i] = lerp(H[i], hsum[i] / wsum[i], wm);
      // twin ruts worn by traffic, slightly crowned middle, a little noise
      // (wide enough for the 0.5 m grid: narrower ruts alias into a washboard on diagonal trails)
      const rut = Math.exp(-(((dmin - 0.8) / 0.34) ** 2));
      detail[k] = wm * (-0.055 * rut + 0.02 * Math.exp(-((dmin / 0.5) ** 2)) + fbm(this.n2, x * 0.25, z * 0.25, 2) * 0.03);
      weight[k] = wm;
      H[i] += detail[k];
      if (dmin < 2.7) this.surface[i] = SURF.dirt;
    });
    this.trailBand = { list: Int32Array.from(touchedAll), detail, weight };
  }

  // Ride quality: blending trails into each other (junctions) and stamping features onto them (the mud
  // hole) leaves short crests that throw the truck off the ground at 40-50 km/h. The bed under the trail
  // band (without its rut / crown detail) gets a Gaussian low-pass (sigma 2 m) that only averages the
  // driven bed itself (normalised convolution with a mask of the cells within ~2.7 m of a centreline), so
  // cut walls and banks next to the trail don't leak in; the detail is added back on top.
  smoothTrailBeds(sigma = 2.0) {
    const { list, detail, weight } = this.trailBand;
    const H = this.heights, NN = this.NN, td = this.trailDist;
    const sc = sigma / CELL, R = Math.ceil(sc * 3);
    const ker = new Float32Array(2 * R + 1);
    for (let k = -R; k <= R; k++) ker[k + R] = Math.exp(-0.5 * (k / sc) ** 2);
    for (let k = 0; k < list.length; k++) H[list[k]] -= detail[k];
    const mw = (i) => smoothstep(3.2, 2.2, td[i]);
    // pass 1 (along x) on the band dilated along z, pass 2 (along z) on the band
    const num = new Float32Array(NN * NN), den = new Float32Array(NN * NN);
    const need = new Uint8Array(NN * NN);
    for (let k = 0; k < list.length; k++) {
      const i = list[k], iz = i % NN;
      for (let d = -R; d <= R; d++) if (iz + d >= 0 && iz + d < NN) need[i + d] = 1;
    }
    for (let i = 0; i < need.length; i++) {
      if (!need[i]) continue;
      const ix = (i / NN) | 0;
      let sn = 0, sd = 0;
      for (let d = -R; d <= R; d++) {
        const jx = ix + d;
        if (jx < 0 || jx >= NN) continue;
        const j = i + d * NN, w = td[j] < 3.2 ? ker[d + R] * mw(j) : 0;
        sn += w * H[j]; sd += w;
      }
      num[i] = sn; den[i] = sd;
    }
    const out = new Float32Array(list.length);
    for (let k = 0; k < list.length; k++) {
      const i = list[k], iz = i % NN;
      let sn = 0, sd = 0;
      for (let d = -R; d <= R; d++) {
        const jz = iz + d;
        if (jz < 0 || jz >= NN) continue;
        sn += ker[d + R] * num[i + d]; sd += ker[d + R] * den[i + d];
      }
      out[k] = sd > 1e-3 ? sn / sd : H[i];
    }
    for (let k = 0; k < list.length; k++) { const i = list[k]; H[i] = lerp(H[i], out[k], weight[k]) + detail[k]; }
  }

  buildLanes() {
    const H = this.heights;
    // A: axle twister (alternating mounds under one wheel then the other), then whoops
    for (let k = 0; k < 8; k++) {
      const z = 36 - k * 3.6;
      const side = k % 2 === 0 ? -1 : 1;
      this.stampEllipse(LANES.A + side * 0.8, z, 2.4, 2.4, (x, zz, i) => {
        const r2 = ((x - (LANES.A + side * 0.8)) ** 2 + (zz - z) ** 2);
        H[i] += 0.5 * Math.exp(-r2 / (2 * 0.85 * 0.85));
      });
    }
    this.stampRect(LANES.A - 3.5, LANES.A + 3.5, -22, 4, (x, z, i) => {
      const edge = smoothstep(3.5, 2.5, Math.abs(x - LANES.A)) * smoothstep(-22, -19, z) * smoothstep(4, 1, z);
      H[i] += edge * 0.22 * (1 - Math.cos((z + 22) / 4.2 * Math.PI * 2)) * 0.5;
    });
    // D: ramps (20 deg up, plateau, 30 deg down; then a 35 deg climb)
    this.stampRect(LANES.D - 5, LANES.D + 5, -30, 42, (x, z, i) => {
      const lat = smoothstep(4.2, 3.0, Math.abs(x - LANES.D));
      const t20 = Math.tan(20 * Math.PI / 180), t30 = Math.tan(30 * Math.PI / 180), t35 = Math.tan(35 * Math.PI / 180);
      let r = 0;
      if (z <= 36 && z > 28) r = (36 - z) * t20;
      else if (z <= 28 && z > 21) r = 8 * t20;
      else if (z <= 21 && z > 21 - 8 * t20 / t30) r = 8 * t20 - (21 - z) * t30;
      const climbTop = 3.4;
      const z0 = 6;
      if (z <= z0 && z > z0 - climbTop / t35) r = Math.max(r, (z0 - z) * t35);
      else if (z <= z0 - climbTop / t35 && z > -14) r = Math.max(r, climbTop);
      else if (z <= -14 && z > -14 - climbTop / 0.25) r = Math.max(r, climbTop - (-14 - z) * 0.25);
      H[i] += r * lat;
    });
    // E: off-camber section after the mud
    this.stampRect(LANES.E - 6, LANES.E + 6, -24, 14, (x, z, i) => {
      const along = smoothstep(14, 9, z) * smoothstep(-24, -19, z);
      const lat = smoothstep(5.5, 3.5, Math.abs(x - LANES.E));
      const t = Math.tan(19 * Math.PI / 180);
      H[i] += along * lat * (x - (LANES.E - 4)) * t * 0.9;
    });
  }

  // fn(x, z, index, e) where e is the normalised elliptic radius (1 at rx/rz); margin widens the loop
  stampEllipse(cx, cz, rx, rz, fn, margin = 0) {
    const half = MAP_SIZE / 2, NN = this.NN;
    const ex = rx * 1.45 + margin, ez = rz * 1.45 + margin;
    const ix0 = Math.max(0, Math.floor((cx - ex + half) / CELL)), ix1 = Math.min(N, Math.ceil((cx + ex + half) / CELL));
    const iz0 = Math.max(0, Math.floor((cz - ez + half) / CELL)), iz1 = Math.min(N, Math.ceil((cz + ez + half) / CELL));
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * CELL;
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = -half + iz * CELL;
        fn(x, z, ix * NN + iz, Math.hypot((x - cx) / rx, (z - cz) / rz));
      }
    }
  }

  stampRect(x0, x1, z0, z1, fn) {
    const half = MAP_SIZE / 2, NN = this.NN;
    const ix0 = Math.max(0, Math.floor((x0 + half) / CELL)), ix1 = Math.min(N, Math.ceil((x1 + half) / CELL));
    const iz0 = Math.max(0, Math.floor((z0 + half) / CELL)), iz1 = Math.min(N, Math.ceil((z1 + half) / CELL));
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * CELL;
      for (let iz = iz0; iz <= iz1; iz++) fn(x, -half + iz * CELL, ix * NN + iz);
    }
  }

  sampleGrid(x, z) {
    return this.heightAt(x, z);
  }

  // bilinear height
  heightAt(x, z) {
    const half = MAP_SIZE / 2;
    const fx = Math.max(0, Math.min(N - 1e-4, (x + half) / CELL));
    const fz = Math.max(0, Math.min(N - 1e-4, (z + half) / CELL));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const NN = this.NN, H = this.heights;
    const i = ix * NN + iz;
    const a = H[i], b = H[i + NN], c = H[i + 1], d = H[i + NN + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  // height on the rendered / physics triangles (cell split along (x1,z0)-(x0,z1)); vista outside the map
  surfaceHeight(x, z) {
    const half = MAP_SIZE / 2;
    if (Math.abs(x) > half || Math.abs(z) > half) return this.farHeight(x, z);
    const fx = Math.max(0, Math.min(N - 1e-4, (x + half) / CELL));
    const fz = Math.max(0, Math.min(N - 1e-4, (z + half) / CELL));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const NN = this.NN, H = this.heights, i = ix * NN + iz;
    const h00 = H[i], h10 = H[i + NN], h01 = H[i + 1], h11 = H[i + NN + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1;
    return out.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize();
  }

  surfaceAt(x, z) {
    const half = MAP_SIZE / 2;
    const ix = Math.max(0, Math.min(N, Math.round((x + half) / CELL)));
    const iz = Math.max(0, Math.min(N, Math.round((z + half) / CELL)));
    return SURF_LIST[this.surface[ix * this.NN + iz]];
  }

  surfaceId(x, z) {
    const half = MAP_SIZE / 2;
    const ix = Math.max(0, Math.min(N, Math.round((x + half) / CELL)));
    const iz = Math.max(0, Math.min(N, Math.round((z + half) / CELL)));
    return this.surface[ix * this.NN + iz];
  }

  isTrail(x, z, r = 4) {
    const half = MAP_SIZE / 2;
    const ix = Math.max(0, Math.min(N, Math.round((x + half) / CELL)));
    const iz = Math.max(0, Math.min(N, Math.round((z + half) / CELL)));
    return this.trailDist[ix * this.NN + iz] < r;
  }

  // water surface height at (x, z), or -Infinity where there is no water
  waterLevelAt(x, z) {
    let best = -Infinity;
    for (const w of this.water) {
      if (w.type !== 'stream') {
        if (Math.hypot((x - w.x) / w.rx, (z - w.z) / w.rz) < 1 && this.heightAt(x, z) < w.level) best = Math.max(best, w.level);
      } else {
        // nearest stream sample (coarse search on a 1 m spaced polyline)
        const pts = w.pts;
        let bd = 1e9, bk = -1;
        for (let k = 0; k < pts.length; k += 4) { const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2; if (d < bd) { bd = d; bk = k; } }
        if (bd > 400) continue;
        for (let k = Math.max(0, bk - 4); k < Math.min(pts.length, bk + 5); k++) { const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2; if (d < bd) { bd = d; bk = k; } }
        if (Math.sqrt(bd) < w.width[bk] + 0.5) best = Math.max(best, w.level[bk]);
      }
    }
    return best;
  }

  createCollider(RAPIER, world) {
    const desc = RAPIER.ColliderDesc.heightfield(N, N, this.heights, { x: MAP_SIZE, y: 1, z: MAP_SIZE })
      .setFriction(0.9).setRestitution(0.0);
    this.collider = world.createCollider(desc);
    // invisible walls at the map edge (the vista beyond has no physics)
    const half = MAP_SIZE / 2, hgt = 400;
    for (const [x, z, hx, hz] of [[half + 1, 0, 1, half + 2], [-half - 1, 0, 1, half + 2], [0, half + 1, half + 2, 1], [0, -half - 1, half + 2, 1]]) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hgt, hz).setTranslation(x, hgt / 2 - 50, z).setFriction(0.2));
    }
    return this.collider;
  }
}
