import { smoothstep, lerp, fbm } from './noise.js';
import { SURFACES } from '../vehicle/tire.js';
import { lakeShape, lakeE } from './worldgen.js';

// A detailed 1 km window of the endless world (worldgen.js), 0.5 m physics grid, in LOCAL coordinates: the window's
// centre is (0, 0) and sits at the absolute point (ox, oz) of the world. As the truck drives the game builds the next
// window round it (streamer.js) and shifts everything by the difference, so local coordinates stay small (32-bit
// floats in the physics and on the GPU). Beyond the window: a render-only vista (8 km, 16 m grid, see `far`).
// Heights = large-scale relief on a 2 m grid (bilinear) + mid detail on 1 m + a fine tile per vertex, then the
// world's features stamped in: lakes, the quarry pits and the huts' level ground, the roads (graded beds, ruts),
// streams and fords, mud holes.

export const MAP_SIZE = 1024;
export const CELL = 0.5;
export const N = Math.round(MAP_SIZE / CELL); // cells per side
export const SURF = { grass: 0, dirt: 1, rock: 2, mud: 3, sand: 4 };
export const SURF_LIST = [SURFACES.grass, SURFACES.dirt, SURFACES.rock, SURFACES.mud, SURFACES.sand];

export const FAR_SIZE = 8192, FAR_CELL = 16, FAR_N = FAR_SIZE / FAR_CELL;
// the window moves in steps of this many metres (a multiple of the fine tile, 128 m, and of every texture period
// the shaders tie to the ground)
export const WINDOW_STEP = 256;

// A road or stream as a polyline in local coordinates, with the bits of THREE.Curve's API the game uses
export class Path {
  constructor(xs, zs) {
    this.xs = xs; this.zs = zs;
    const n = xs.length, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    this.cum = cum;
  }
  getLength() { return this.cum[this.cum.length - 1]; }
  getPointAt(u, out = { x: 0, y: 0, z: 0 }) {
    const { xs, zs, cum } = this, n = xs.length, s = Math.max(0, Math.min(1, u)) * cum[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const f = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    out.x = xs[lo] + (xs[hi] - xs[lo]) * f; out.y = 0; out.z = zs[lo] + (zs[hi] - zs[lo]) * f;
    return out;
  }
  getSpacedPoints(n) { const out = []; for (let k = 0; k <= n; k++) out.push(this.getPointAt(k / n)); return out; }
}

// a road's bed where it crosses a stream: eased down to just under the water (a ford ~0.3 m deep) over ~40 m each
// side; a copy (the world's own profile stays as it is). Pure: the same in every window
function fordProfile(e, streams) {
  let hs = e.hs;
  for (const st of streams) {
    if (st.bb[2] < e.bb[0] - 40 || st.bb[0] > e.bb[2] + 40 || st.bb[3] < e.bb[1] - 40 || st.bb[1] > e.bb[3] + 40) continue;
    const n = e.xs.length, m = st.xs.length;
    for (let k = 0; k < n; k += 4) {
      // nearest stream sample (coarse then fine)
      let bd = 1e9, bj = -1;
      for (let j = 0; j < m; j += 8) { const d = (st.xs[j] - e.xs[k]) ** 2 + (st.zs[j] - e.zs[k]) ** 2; if (d < bd) { bd = d; bj = j; } }
      if (bd > 60 * 60) continue;
      for (let j = Math.max(0, bj - 8); j < Math.min(m, bj + 9); j++) { const d = (st.xs[j] - e.xs[k]) ** 2 + (st.zs[j] - e.zs[k]) ** 2; if (d < bd) { bd = d; bj = j; } }
      const d = Math.sqrt(bd);
      if (d > 45) continue;
      const target = st.level[bj] - 0.3, w = smoothstep(45, st.width[bj] + 2, d);
      if (hs === e.hs) hs = Float64Array.from(e.hs);
      for (let q = k; q < Math.min(n, k + 4); q++) if (hs[q] > target) hs[q] = lerp(hs[q], target, w);
    }
  }
  return hs;
}

export class Terrain {
  // world: worldgen World; (ox, oz): the absolute position of the window's centre (multiples of WINDOW_STEP)
  constructor(world, ox = 0, oz = 0) {
    this.world = world;
    this.seed = world.seed;
    this.ox = ox; this.oz = oz;
    const NN = N + 1;
    this.NN = NN;
    this.heights = new Float32Array(NN * NN);   // index = ix * NN + iz  (Rapier column-major layout)
    this.surface = new Uint8Array(NN * NN);
    this.trailDist = new Float32Array(NN * NN).fill(1e9);
    this.water = [];
    this.sites = [];
    this.muds = [];
    const t0 = performance.now();
    this.generate();
    this.genMs = performance.now() - t0;
  }

  // a window built elsewhere (windowWorker.js), from its data
  static fromData(win) {
    const t = Object.create(Terrain.prototype);
    Object.assign(t, {
      world: null, ox: win.ox, oz: win.oz, NN: N + 1, heights: win.heights, surface: win.surface, trailDist: win.trailDist,
      far: win.far, water: win.water, sites: win.sites, muds: win.muds, lakes: win.lakes, lake: win.lakes[0] || null,
    });
    t.roads = win.roads.map(r => ({ key: r.key, path: new Path(r.xs, r.zs), hs: r.hs, spur: r.spur }));
    t.trailCurves = t.roads.map(r => r.path);
    return t;
  }

  idx(ix, iz) { return ix * this.NN + iz; }
  worldX(ix) { return -MAP_SIZE / 2 + ix * CELL; }

  generate() {
    const W = this.world, NN = this.NN, H = this.heights, half = MAP_SIZE / 2, ox = this.ox, oz = this.oz;
    const times = this.times = {};
    let tt = performance.now();
    const lap = (k) => { const t = performance.now(); times[k] = Math.round(t - tt); tt = t; };

    // ---- vista heightmap (8 km, 16 m) first: the window's border blends into it exactly
    const FN = FAR_N + 1, fh = new Float32Array(FN * FN);
    for (let i = 0; i < FN; i++) {
      const X = ox - FAR_SIZE / 2 + i * FAR_CELL;
      for (let j = 0; j < FN; j++) fh[i * FN + j] = W.macro(X, oz - FAR_SIZE / 2 + j * FAR_CELL);
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
    lap('far');

    // ---- coarse (2 m) and mid (1 m) grids, bilinear-upsampled to the 0.5 m grid, plus the fine tile
    const C2 = 4, CN = N / C2 + 1;
    const cg = new Float32Array(CN * CN);
    for (let i = 0; i < CN; i++) for (let j = 0; j < CN; j++) cg[i * CN + j] = W.macro(ox - half + i * C2 * CELL, oz - half + j * C2 * CELL);
    const M2 = 2, MN = N / M2 + 1;
    const mg = new Float32Array(MN * MN);
    for (let i = 0; i < MN; i++) for (let j = 0; j < MN; j++) mg[i * MN + j] = W.mid(ox - half + i * M2 * CELL, oz - half + j * M2 * CELL);
    lap('grids');
    const ix0A = Math.round((ox - half) / CELL), iz0A = Math.round((oz - half) / CELL);
    const border = 40; // m: blend into the vista heightmap at the window's edge
    for (let ix = 0; ix < NN; ix++) {
      const x = -half + ix * CELL;
      const bx = half - Math.abs(x);
      const ci = Math.min(CN - 2, ix >> 2), ctx = ix / 4 - ci;
      const mi = Math.min(MN - 2, ix >> 1), mtx = ix / 2 - mi;
      for (let iz = 0; iz < NN; iz++) {
        const i = ix * NN + iz;
        const cj = Math.min(CN - 2, iz >> 2), ctz = iz / 4 - cj, co = ci * CN + cj;
        const mj = Math.min(MN - 2, iz >> 1), mtz = iz / 2 - mj, mo = mi * MN + mj;
        let h = (cg[co] * (1 - ctx) + cg[co + CN] * ctx) * (1 - ctz) + (cg[co + 1] * (1 - ctx) + cg[co + CN + 1] * ctx) * ctz
          + (mg[mo] * (1 - mtx) + mg[mo + MN] * mtx) * (1 - mtz) + (mg[mo + 1] * (1 - mtx) + mg[mo + MN + 1] * mtx) * mtz
          + W.fineAt(ix0A + ix, iz0A + iz);
        const b = Math.min(bx, half - Math.abs(-half + iz * CELL));
        if (b < border) { const z = -half + iz * CELL; h = lerp(this.farHeight(x, z), h, smoothstep(0, border, b)); }
        H[i] = h;
      }
    }
    lap('heights');

    // ---- the world's features round the window (absolute -> local)
    const M = 60;
    const regions = W.regionsIn(ox - half - M, oz - half - M, ox + half + M, oz + half + M);
    const inBox = (x, z, r) => Math.abs(x - ox) < half + r && Math.abs(z - oz) < half + r;
    const lakes = [], sites = [], streams = [];
    for (const r of regions) {
      for (const l of r.lakes) if (inBox(l.x, l.z, Math.max(l.rx, l.rz) * 1.5 + 10)) lakes.push(l);
      for (const s of r.sites) if (inBox(s.x, s.z, 80)) sites.push(s);
      for (const s of r.streams) if (s.bb[2] > ox - half - 20 && s.bb[0] < ox + half + 20 && s.bb[3] > oz - half - 20 && s.bb[1] < oz + half + 20) streams.push(s);
    }
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    lakes.sort(byId); sites.sort(byId);
    const roads = W.roadsIn(ox - half, oz - half, ox + half, oz + half, 10).sort((a, b) => (a.key < b.key ? -1 : 1));
    lap('features');

    // ---- lakes: flatten the basin below the water level (shallow shelf, then deeper middle)
    for (const l of lakes) this.carveLake(l);

    // ---- sites: quarry pits (flat floor, terraced walls), level ground for the huts, a flat top on the lookouts
    for (const s of sites) {
      const x = s.x - ox, z = s.z - oz;
      const local = { ...s, x, z, ax: s.x, az: s.z };
      delete local.spur; delete local.lake;
      if (s.type === 'quarry') {
        this.stampEllipse(x, z, s.rx, s.rz, (px, pz, i, e) => {
          if (e > 1.2 || H[i] <= s.floor) return;
          const t = smoothstep(0.85, 1.15, e);
          const q = Math.floor(t * 3) / 3 * 0.5 + t * 0.5;
          H[i] = s.floor + (H[i] - s.floor) * q;
          if (e < 1.05) this.surface[i] = SURF.sand;
        }, 2);
      } else if (s.type === 'hut') {
        this.stampEllipse(x, z, 11, 11, (px, pz, i, e) => { H[i] = lerp(H[i], s.h, smoothstep(1.45, 0.8, e)); });
      } else if (s.type === 'lookout') {
        this.stampEllipse(x, z, 9, 9, (px, pz, i, e) => { H[i] = lerp(H[i], s.h, smoothstep(1.4, 0.7, e)); });
      }
      if (s.type === 'lake') { local.lake = { x: s.lake.x - ox, z: s.lake.z - oz, rx: s.lake.rx, rz: s.lake.rz, level: s.lake.level }; }
      this.sites.push(local);
    }
    this.lakes = lakes.map(l => ({ x: l.x - ox, z: l.z - oz, rx: l.rx, rz: l.rz, level: l.level }));
    this.lake = this.lakes[0] || null;
    lap('carve');

    // ---- roads (down into the fords first: a road meets a stream at its water, not over a trench)
    for (const s of streams) W.streamFords(s);
    this.buildTrails(roads.map(e => ({ ...e, hs: fordProfile(e, streams) })));
    lap('trails');

    // ---- streams (after the roads: the fords dip the road into the bed)
    for (const s of streams) this.carveStream(W.streamFords(s));

    // ---- mud holes on the roads (at the bottom of a dip)
    const muds = [];
    for (const e of roads) for (const m of e.muds) if (inBox(m.x, m.z, 20)) muds.push({ ...m, x: m.x - ox, z: m.z - oz });
    this.muds = muds;
    for (const m of muds) this.stampEllipse(m.x, m.z, m.rx, m.rz, (x, z, i, e) => {
      const w = smoothstep(1.3, 0.6, e);
      H[i] -= m.depth * w * (0.8 + 0.2 * W.n1((x + ox) * 0.3, (z + oz) * 0.3));
      if (e < 1.0) this.surface[i] = SURF.mud;
    }, 4);

    this.smoothTrailBeds();
    lap('streams+smooth');

    // muddy pools in the bottom of the mud holes (visual water, the bed stays mud)
    for (const m of muds) {
      let lo = 1e9, rim = 1e9;
      this.stampEllipse(m.x, m.z, m.rx, m.rz, (x, z, i, e) => { if (e < 0.7) lo = Math.min(lo, H[i]); });
      for (let a = 0; a < 32; a++) { const t = a / 32 * Math.PI * 2; rim = Math.min(rim, this.heightAt(m.x + Math.cos(t) * m.rx * 0.8, m.z + Math.sin(t) * m.rz * 0.8)); }
      const level = Math.min(lo + 0.12, rim - 0.03);
      if (level > lo + 0.03 && Math.abs(m.x) < half - 15 && Math.abs(m.z) < half - 15) this.water.push({ type: 'pool', x: m.x, z: m.z, rx: m.rx * 0.95, rz: m.rz * 0.95, level, muddy: true });
    }

    // ---- surfaces: rock on steep slopes and high crags
    for (let ix = 1; ix < N; ix++) {
      for (let iz = 1; iz < N; iz++) {
        const i = ix * NN + iz;
        if (this.surface[i] !== SURF.grass) continue;
        const gx = (H[i + NN] - H[i - NN]) / (2 * CELL), gz = (H[i + 1] - H[i - 1]) / (2 * CELL);
        const slope = Math.hypot(gx, gz);
        if (slope > 0.72 || (H[i] > 150 && slope > 0.4)) this.surface[i] = SURF.rock;
      }
    }
    lap('surfaces');
  }

  farHeight(x, z) {
    const f = this.far, n = f.n;
    const fx = Math.max(0, Math.min(n - 1.001, (x + f.size / 2) / f.cell));
    const fz = Math.max(0, Math.min(n - 1.001, (z + f.size / 2) / f.cell));
    const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0, o = i0 * n + j0, g = f.heights;
    return (g[o] * (1 - tx) + g[o + n] * tx) * (1 - tz) + (g[o + 1] * (1 - tx) + g[o + n + 1] * tx) * tz;
  }

  // the lake's basin is already in the relief (worldgen lakeShape); shaped again here after the mid and fine detail
  // went on, so no bump pokes through the water and no dip lets it spill. la: the lake in absolute coordinates
  carveLake(la) {
    const H = this.heights, W = this.world, ox = this.ox, oz = this.oz, level = la.level;
    const lx = la.x - ox, lz = la.z - oz;
    this.stampEllipse(lx, lz, la.rx * 1.7, la.rz * 1.7, (x, z, i) => {
      const e = lakeE(x + ox, z + oz, la, W.n4);
      if (e >= 2.4) return;
      H[i] = lakeShape(H[i], e, la);
      if (e < 1.08) this.surface[i] = H[i] < level + 0.05 ? (e < 0.75 ? SURF.mud : SURF.sand) : SURF.sand;
    }, 0);
    this.water.push({ type: 'lake', x: lx, z: lz, rx: la.rx * 1.1, rz: la.rz * 1.1, level });
  }

  // s: a worldgen stream (absolute); carved where it crosses the window
  carveStream(s) {
    const H = this.heights, NN = this.NN, half = MAP_SIZE / 2, ox = this.ox, oz = this.oz;
    const n = s.xs.length;
    const pts = [], level = [], width = [];
    for (let k = 0; k < n; k++) { pts.push({ x: s.xs[k] - ox, y: 0, z: s.zs[k] - oz }); level.push(s.level[k]); width.push(s.width[k]); }
    // carve: bed = surface - depth (shallower and wider at the fords), soft banks; near the water's edge the bank
    // is raised to just above the water where the ground is lower (else the water would float over a dip)
    const R = 12;
    for (let k = 0; k < n - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      if (Math.max(a.x, b.x) < -half - R || Math.min(a.x, b.x) > half + R || Math.max(a.z, b.z) < -half - R || Math.min(a.z, b.z) > half + R) continue;
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R + half) / CELL)), ix1 = Math.min(N, Math.ceil((Math.max(a.x, b.x) + R + half) / CELL));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - R + half) / CELL)), iz1 = Math.min(N, Math.ceil((Math.max(a.z, b.z) + R + half) / CELL));
      const abx = b.x - a.x, abz = b.z - a.z, ab2 = abx * abx + abz * abz || 1;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * CELL;
        for (let iz = iz0; iz <= iz1; iz++) {
          const z = -half + iz * CELL;
          let u = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
          u = Math.max(0, Math.min(1, u));
          const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
          const w = width[k] + (width[k + 1] - width[k]) * u;
          if (d > w + 7) continue;
          const lvl = level[k] + (level[k + 1] - level[k]) * u;
          const fd = s.ford[k] + (s.ford[k + 1] - s.ford[k]) * u;
          const depth = lerp(0.62, 0.32, fd);
          const bed = lvl - depth * (1 - Math.pow(Math.min(1, d / w), 2));
          const i = ix * NN + iz;
          const bankW = lerp(3.5, 9, fd);
          const t = smoothstep(w, w + bankW, d);
          const target = lerp(bed, Math.max(H[i], lvl + 0.15), t);
          if (target < H[i] || d < w + 2.5) {
            H[i] = target;
            if (d < w + 0.6) this.surface[i] = SURF.sand;
          }
        }
      }
    }
    // the part inside the window (plus a margin) for the water mesh
    let k0 = -1, k1 = -1;
    for (let k = 0; k < n; k++) if (Math.abs(pts[k].x) < half + 30 && Math.abs(pts[k].z) < half + 30) { if (k0 < 0) k0 = k; k1 = k; }
    if (k0 >= 0 && k1 > k0) {
      const lk = s.lake;
      let along0 = 0;   // the distance from the spring (the water's flow frame counts from there: water.js)
      for (let k = 1; k <= k0; k++) along0 += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      this.water.push({ type: 'stream', pts: pts.slice(k0, k1 + 1), level: level.slice(k0, k1 + 1), width: width.slice(k0, k1 + 1), along0,
        lake: { x: lk.x - ox, z: lk.z - oz, rx: lk.rx, rz: lk.rz } });
    }
  }

  buildTrails(roads) {
    const NN = this.NN, H = this.heights, half = MAP_SIZE / 2, ox = this.ox, oz = this.oz, W = this.world;
    this.trailCurves = [];
    this.roads = [];
    const dist = new Float32Array(NN * NN).fill(1e9), th = new Float32Array(NN * NN);
    const wsum = new Float32Array(NN * NN), hsum = new Float32Array(NN * NN), wmax = new Float32Array(NN * NN);
    const touchedAll = [];
    const R = 11;   // m: the band (6 m) and, below a road on a slope, its embankment
    for (const e of roads) {
      const n = e.xs.length;
      const xs = new Float64Array(n), zs = new Float64Array(n);
      for (let k = 0; k < n; k++) { xs[k] = e.xs[k] - ox; zs[k] = e.zs[k] - oz; }
      const hs = e.hs, path = new Path(xs, zs);
      this.trailCurves.push(path);
      this.roads.push({ key: e.key, path, hs, spur: e.spur });
      const touched = [];
      for (let k = 0; k < n - 1; k++) {
        const ax = xs[k], az = zs[k], bx = xs[k + 1], bz = zs[k + 1];
        if (Math.max(ax, bx) < -half - R || Math.min(ax, bx) > half + R || Math.max(az, bz) < -half - R || Math.min(az, bz) > half + R) continue;
        const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + half) / CELL)), ix1 = Math.min(N, Math.ceil((Math.max(ax, bx) + R + half) / CELL));
        const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - R + half) / CELL)), iz1 = Math.min(N, Math.ceil((Math.max(az, bz) + R + half) / CELL));
        const abx = bx - ax, abz = bz - az, ab2 = abx * abx + abz * abz || 1;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = -half + ix * CELL;
          for (let iz = iz0; iz <= iz1; iz++) {
            const z = -half + iz * CELL;
            let u = ((x - ax) * abx + (z - az) * abz) / ab2;
            u = Math.max(0, Math.min(1, u));
            const d = Math.hypot(x - (ax + abx * u), z - (az + abz * u));
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
        // the bed blends out by 5.5 m; where the ground falls away below it (a road across a slope) a wider
        // embankment carries it, so the edge isn't a drop
        const fill = th[i] > H[i] + 0.3;
        if (d <= 6 || (fill && d <= R)) {
          const w = fill ? smoothstep(R, 2.4, d) : smoothstep(5.5, 2.4, d);
          if (wsum[i] === 0) touchedAll.push(i);
          wsum[i] += 1e-3 + w; hsum[i] += (1e-3 + w) * th[i];
          if (w > wmax[i]) wmax[i] = w;
          if (d < this.trailDist[i]) this.trailDist[i] = d;
        }
        dist[i] = 1e9;
      }
    }
    // the band's detail (ruts, crown, noise) is kept apart so smoothTrailBeds() can low-pass the bed under it
    touchedAll.sort((a, b) => a - b);
    const detail = new Float32Array(touchedAll.length), weight = new Float32Array(touchedAll.length);
    touchedAll.forEach((i, k) => {
      const ix = Math.floor(i / NN), iz = i - ix * NN;
      const x = -half + ix * CELL + ox, z = -half + iz * CELL + oz;
      const dmin = this.trailDist[i], wm = wmax[i];
      H[i] = lerp(H[i], hsum[i] / wsum[i], wm);
      // twin ruts, slightly crowned middle, a little noise; ruts must stay wide for the 0.5 m grid (narrower alias
      // into a washboard on diagonal trails)
      const rut = Math.exp(-(((dmin - 0.8) / 0.34) ** 2));
      detail[k] = wm * (-0.055 * rut + 0.02 * Math.exp(-((dmin / 0.5) ** 2)) + fbm(W.n2, x * 0.25, z * 0.25, 2) * 0.03);
      weight[k] = wm;
      H[i] += detail[k];
      if (dmin < 2.7) this.surface[i] = SURF.dirt;
    });
    this.trailBand = { list: Int32Array.from(touchedAll), detail, weight };
  }

  // Blending trails at junctions and stamping features (mud hole) leaves short crests that launch the truck at
  // 40-50 km/h. Gaussian low-pass (sigma 2 m) of the bed under the trail band (rut/crown detail removed, added back
  // after), normalised over cells within ~2.7 m of a centreline so cut walls and banks don't leak in.
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

  // height on the rendered / physics triangles (cell split along (x1,z0)-(x0,z1)); vista outside the window
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

  normalAt(x, z, out = { x: 0, y: 1, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } }) {
    const e = 1;
    const nx = this.heightAt(x - e, z) - this.heightAt(x + e, z), ny = 2 * e, nz = this.heightAt(x, z - e) - this.heightAt(x, z + e);
    const l = Math.hypot(nx, ny, nz);
    return out.set(nx / l, ny / l, nz / l);
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

  // physics: the window's heightfield (no walls: the next window is there before the truck reaches the edge)
  // groups: the collision groups (Vehicle.js GROUP_GROUND: the wheels' side cylinders never touch the ground);
  // (x, z): where its centre goes (a window prepared ahead sits where it will be once the frame has shifted)
  createCollider(RAPIER, world, groups, x = 0, z = 0) {
    const desc = RAPIER.ColliderDesc.heightfield(N, N, this.heights, { x: MAP_SIZE, y: 1, z: MAP_SIZE })
      .setFriction(0.9).setRestitution(0.0).setTranslation(x, 0, z);
    if (groups !== undefined) desc.setCollisionGroups(groups);
    this.collider = world.createCollider(desc);
    return this.collider;
  }
}
