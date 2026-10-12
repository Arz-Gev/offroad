import { makeSimplex2D, mulberry32, fbm, ridged, smoothstep, lerp } from './noise.js';

// The endless world, as rules: any place's ground, roads, lakes, streams and sites follow from its absolute
// coordinates and the seed alone, never from what else was generated or in what order. Terrain (terrain.js) builds
// a detailed 1 km window of it around the truck; the window moves as it drives, and where two windows overlap
// they agree exactly (away from their borders).
// - Height: large-scale relief (hills, mountain country, big ranges), mid undulation, fine bumps.
// - Roads: one node per ROAD_CELL square, jittered; links to the neighbours east and north (and some diagonals) by
//   a hash. Each link's route is an A* search on an 8 m grid between its two nodes (steep ground and water cost),
//   smoothed into a curve; its bed is the terrain low-passed along it, grade-limited by cutting crests, pinned to
//   the node heights at the ends so junctions meet. Computed once per link and cached.
// - Regions (REGION squares): lakes in basins, a stream into each lake from higher ground (fords where it crosses a
//   road), sites: a ruined hut by a road, a quarry in a hillside, a lookout on a summit (spur roads to them).

export const ROAD_CELL = 400;
export const REGION = 1200;
const GRID = 8;                         // m: road / stream routing grid
const TAN = d => Math.tan(d * Math.PI / 180);

// integer hash -> [0, 1)
export function hash3(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x632be5ab, 0x165667b1) ^ Math.imul((c | 0) + 0x5bd1e995, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const rngAt = (a, b, c = 0) => mulberry32(Math.floor(hash3(a, b, c) * 4294967296));

// a min-heap of (key, value) for A*
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// centripetal Catmull-Rom through points (2D), sampled every `step` metres by arc length
function smoothCurve(px, pz, step) {
  const n = px.length;
  const dense = [];
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2);
    const P = [[px[i0], pz[i0]], [px[i], pz[i]], [px[i + 1], pz[i + 1]], [px[i3], pz[i3]]];
    if (i === 0) P[0] = [2 * P[1][0] - P[2][0], 2 * P[1][1] - P[2][1]];
    if (i + 2 > n - 1) P[3] = [2 * P[2][0] - P[1][0], 2 * P[2][1] - P[1][1]];
    const t = [0];
    for (let k = 1; k < 4; k++) t.push(t[k - 1] + Math.max(1e-4, Math.sqrt(Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]))));
    const segLen = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
    const m = Math.max(2, Math.ceil(segLen / 1));
    for (let s = (i === 0 ? 0 : 1); s <= m; s++) {
      const u = t[1] + (t[2] - t[1]) * s / m;
      const L = (a, b, k, j) => { const w = (t[j] - u) / (t[j] - t[k]); return [a[0] * w + b[0] * (1 - w), a[1] * w + b[1] * (1 - w)]; };
      const A1 = L(P[0], P[1], 0, 1), A2 = L(P[1], P[2], 1, 2), A3 = L(P[2], P[3], 2, 3);
      const B1 = [(A1[0] * (t[2] - u) + A2[0] * (u - t[0])) / (t[2] - t[0]), (A1[1] * (t[2] - u) + A2[1] * (u - t[0])) / (t[2] - t[0])];
      const B2 = [(A2[0] * (t[3] - u) + A3[0] * (u - t[1])) / (t[3] - t[1]), (A2[1] * (t[3] - u) + A3[1] * (u - t[1])) / (t[3] - t[1])];
      dense.push((B1[0] * (t[2] - u) + B2[0] * (u - t[1])) / (t[2] - t[1]), (B1[1] * (t[2] - u) + B2[1] * (u - t[1])) / (t[2] - t[1]));
    }
  }
  return resample(dense, step);
}
// a polyline (flat x, z pairs) resampled every `step` metres
function resample(d, step) {
  const n = d.length / 2, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(d[2 * i] - d[2 * i - 2], d[2 * i + 1] - d[2 * i - 1]);
  const len = cum[n - 1], m = Math.max(1, Math.round(len / step));
  const xs = new Float64Array(m + 1), zs = new Float64Array(m + 1);
  let j = 0;
  for (let k = 0; k <= m; k++) {
    const s = len * k / m;
    while (j < n - 2 && cum[j + 1] < s) j++;
    const f = cum[j + 1] > cum[j] ? (s - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    xs[k] = d[2 * j] + (d[2 * j + 2] - d[2 * j]) * f; zs[k] = d[2 * j + 1] + (d[2 * j + 3] - d[2 * j + 1]) * f;
  }
  return { xs, zs, len };
}
// Douglas-Peucker on flat x, z pairs
function simplify(d, tol) {
  const n = d.length / 2, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = d[2 * a], az = d[2 * a + 1], bx = d[2 * b], bz = d[2 * b + 1], L = Math.hypot(bx - ax, bz - az) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const dd = Math.abs((bx - ax) * (az - d[2 * i + 1]) - (ax - d[2 * i]) * (bz - az)) / L;
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const px = [], pz = [];
  for (let i = 0; i < n; i++) if (keep[i]) { px.push(d[2 * i]); pz.push(d[2 * i + 1]); }
  return { px, pz };
}
// ridged noise with each octave turned (plain ridged lines its creases up along the simplex grid's axes)
function ridgedR(noise, x, y, oct) {
  let a = 1, s = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(noise(x, y));
    s += a * n * n; norm += a; a *= 0.5;
    const nx = (x * 0.8 - y * 0.6) * 2.1 + 17.3, ny = (x * 0.6 + y * 0.8) * 2.1 - 9.1;
    x = nx; y = ny;
  }
  return s / norm;
}
// a lake's ground by its elliptic radius e (1 at the ellipse): inside, the bed shelving to ~2 m below the water in
// the middle (the water's edge at e ~0.92); the shore from just above the water, clamped between a gentle and a
// steep rise; beyond 1.35 back to the land by 2.4
export function lakeShape(h, e, l) {
  if (e < 1) return Math.min(h, l.level + 0.25 - 0.6 * smoothstep(1.0, 0.85, e) - 1.6 * smoothstep(0.8, 0.25, e));
  const lo = l.level + 0.25 + (e - 1) * 2.5, hi = l.level + 0.25 + (e - 1) * 16;
  const c = Math.max(lo, Math.min(hi, h));
  return e < 1.35 ? c : lerp(h, c, smoothstep(2.4, 1.35, e));
}
// a lake's elliptic radius at (X, Z), its shore wobbling a little
export function lakeE(X, Z, l, noise) {
  return Math.hypot((X - l.x) / l.rx, (Z - l.z) / l.rz) + noise(X * 0.045, Z * 0.045) * 0.07;
}
const boxSmooth = (hs, W, passes, closed = false) => {
  const n = hs.length;
  for (let p = 0; p < passes; p++) {
    const o = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0, c = 0;
      for (let j = -W; j <= W; j++) { const kk = Math.max(0, Math.min(n - 1, k + j)); s += hs[kk]; c++; }
      o[k] = s / c;
    }
    hs.set(o);
  }
  return hs;
};

export class World {
  constructor(seed = 7) {
    this.seed = seed;
    const s = seed;
    this.n1 = makeSimplex2D(s); this.n2 = makeSimplex2D(s + 11); this.n3 = makeSimplex2D(s + 23);
    this.n4 = makeSimplex2D(s + 37); this.n5 = makeSimplex2D(s + 51); this.n6 = makeSimplex2D(s + 67);
    this.n7 = makeSimplex2D(s + 83); this.n8 = makeSimplex2D(s + 97); this.n9 = makeSimplex2D(s + 113);
    this.nodes = new Map(); this.edges = new Map(); this.regions = new Map();
    this.makeFineTile();
  }

  // ------------------------------------------------------------------ height
  // large-scale relief before the lakes: rolling country, hills, patches of mountain country and now and then a
  // big range (snow above uSnow)
  macro0(X, Z) {
    const { n1, n2, n4, n5, n6, n7, n8, n9 } = this;
    const region = fbm(n1, X * 0.00021, Z * 0.00021, 3);                                     // regional level
    const roll = fbm(n2, X * 0.0055 + 13.1, Z * 0.0055, 3) * 8;
    const hills = fbm(n4, X * 0.0024, Z * 0.0024, 3) * 22 + fbm(n5, X * 0.009, Z * 0.009, 2) * 4;
    const mm = smoothstep(0.2, 0.5, fbm(n9, X * 0.00034 + 7.3, Z * 0.00034, 3) + region * 0.3);
    let h = region * 50 + roll + hills * (0.8 + 0.6 * mm);
    if (mm > 0) h += mm * (15 + 75 * ridgedR(n6, X * 0.0011, Z * 0.0011, 4) * (0.6 + 0.4 * smoothstep(-0.3, 0.5, n5(X * 0.0007, Z * 0.0007))));
    const rr = smoothstep(0.3, 0.68, fbm(n7, X * 0.0001 + 3.7, Z * 0.0001, 2));
    if (rr > 0) h += rr * rr * 300 * ridgedR(n8, X * 0.0006, Z * 0.0006, 5);
    return h;
  }
  // the relief with the lakes' basins in it: the bed under the water, a shore that rises gently from it (cut down
  // where the ground was higher, built up where it was lower, so the water never spills over the rim)
  macro(X, Z) {
    let h = this.macro0(X, Z);
    const ri = Math.floor(X / REGION), rj = Math.floor(Z / REGION);
    const fx = X / REGION - ri, fz = Z / REGION - rj;
    for (let a = fx < 0.5 ? -1 : 0, a1 = a + 1; a <= a1; a++) for (let b = fz < 0.5 ? -1 : 0, b1 = b + 1; b <= b1; b++) {
      for (const l of this.region(ri + a, rj + b).lakes) {
        if (Math.abs(X - l.x) > l.rx * 2.5 || Math.abs(Z - l.z) > l.rz * 2.5) continue;
        const e = lakeE(X, Z, l, this.n4);
        if (e < 2.4) h = lakeShape(h, e, l);
      }
    }
    return h;
  }
  // mid detail (1 m grid): small hills, felt as gentle undulation
  mid(X, Z) { return fbm(this.n2, X * 0.028, Z * 0.028, 3) * 1.4; }
  base(X, Z) { return this.macro(X, Z) + this.mid(X, Z); }
  // fine detail: a seamless 128 m tile of periodic gradient noise (indexed by absolute 0.5 m grid cells)
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
  fineAt(ixA, izA) { const T = this.fineT; return this.fineTile[(((ixA % T) + T) % T) * T + (((izA % T) + T) % T)]; }
  slope(X, Z, e = 6) { return Math.hypot(this.base(X + e, Z) - this.base(X - e, Z), this.base(X, Z + e) - this.base(X, Z - e)) / (2 * e); }

  // ------------------------------------------------------------------ regions: lakes, streams, sites
  region(ri, rj) {
    const key = ri + ',' + rj;
    let r = this.regions.get(key);
    if (r) return r;
    r = { ri, rj, lakes: [], streams: null, sites: null, spurs: null };
    this.regions.set(key, r);
    const rnd = rngAt(ri, rj, 7001 + this.seed);
    const x0 = ri * REGION, z0 = rj * REGION;
    // a lake in the region's most basin-like spot (low against the ground round it, not steep). Only the relief
    // without lakes (macro0) is used here: the lakes shape macro(). Kept 230 m inside the region so the basins of
    // two regions' lakes never meet.
    if (rnd() < 0.6) {
      let best = null;
      for (let gx = 230; gx <= REGION - 230; gx += 40) for (let gz = 230; gz <= REGION - 230; gz += 40) {
        const X = x0 + gx + (rnd() - 0.5) * 20, Z = z0 + gz + (rnd() - 0.5) * 20;
        const h = this.macro0(X, Z);
        let ring = 0, steep = 0;
        for (let a = 0; a < 8; a++) {
          const hr = this.macro0(X + Math.cos(a * 0.785) * 110, Z + Math.sin(a * 0.785) * 110);
          ring += hr; steep = Math.max(steep, Math.abs(hr - h));
        }
        const conc = h - ring / 8 + steep * 0.15;
        if (h < 150 && (!best || conc < best.conc)) best = { X, Z, conc };
      }
      if (best && best.conc < 0.5) {
        let rx = 42 + rnd() * 48, rz = rx * (0.6 + rnd() * 0.32);
        if (rnd() < 0.5) [rx, rz] = [rz, rx];
        const lk = { x: best.X, z: best.Z, rx, rz };
        let lo = 1e9, hi = -1e9, sum = 0;
        for (let a = 0; a < 32; a++) {
          const t = a / 32 * Math.PI * 2;
          const h = this.macro0(lk.x + Math.cos(t) * rx * 1.15, lk.z + Math.sin(t) * rz * 1.15);
          lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
        }
        lk.level = (lo + sum / 32) / 2 - 0.5;
        if (hi - lo < 24) { lk.id = `L${ri}_${rj}`; r.lakes.push(lk); }
      }
    }
    return r;
  }
  lakesNear(X, Z, R) {
    const out = [];
    const i0 = Math.floor((X - R - 200) / REGION), i1 = Math.floor((X + R + 200) / REGION);
    const j0 = Math.floor((Z - R - 200) / REGION), j1 = Math.floor((Z + R + 200) / REGION);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const l of this.region(i, j).lakes) {
      if (Math.abs(l.x - X) < R + l.rx * 1.5 && Math.abs(l.z - Z) < R + l.rz * 1.5) out.push(l);
    }
    return out;
  }
  // 0 outside .. >1 deep inside a lake's ellipse (scaled by k)
  inLake(X, Z, lakes, k = 1) {
    let m = 1e9;
    for (const l of lakes) m = Math.min(m, Math.hypot((X - l.x) / (l.rx * k), (Z - l.z) / (l.rz * k)));
    return m;
  }

  // streams and sites need the roads, which need the lakes: filled on first use
  regionFull(ri, rj) {
    const r = this.region(ri, rj);
    if (r.sites) return r;
    r.sites = []; r.spurs = []; r.streams = [];
    const rnd = rngAt(ri, rj, 9103 + this.seed);
    const x0 = ri * REGION, z0 = rj * REGION;
    // ---- streams: from higher ground down into each lake
    for (const lk of r.lakes) {
      if (rnd() > 0.8) continue;
      let src = null;
      for (let k = 0; k < 16; k++) {
        const a = rnd() * Math.PI * 2, d = 420 + rnd() * 480;
        const X = lk.x + Math.cos(a) * d, Z = lk.z + Math.sin(a) * d;
        const h = this.base(X, Z);
        if (h > lk.level + 14 && this.inLake(X, Z, this.lakesNear(X, Z, 60), 1.3) > 1 && this.slope(X, Z) < 0.5 && (!src || h > src.h)) src = { X, Z, h };
      }
      if (!src) continue;
      const st = this.routeStream(src, lk, rnd);
      if (st) r.streams.push(st);
    }
    // ---- sites
    const nodesIn = [];
    for (let i = Math.floor(x0 / ROAD_CELL); i < Math.floor((x0 + REGION) / ROAD_CELL); i++)
      for (let j = Math.floor(z0 / ROAD_CELL); j < Math.floor((z0 + REGION) / ROAD_CELL); j++) nodesIn.push(this.node(i, j));
    const nearRoad = (X, Z, R) => {
      for (const nd of this.nodesAround(X, Z, R + ROAD_CELL)) for (const e of this.edgesOf(nd)) {
        if (X < e.bb[0] - R || X > e.bb[2] + R || Z < e.bb[1] - R || Z > e.bb[3] + R) continue;
        for (let k = 0; k < e.xs.length; k += 8) if ((e.xs[k] - X) ** 2 + (e.zs[k] - Z) ** 2 < R * R) return true;
      }
      return false;
    };
    const clearOf = (X, Z, R) => this.inLake(X, Z, this.lakesNear(X, Z, R + 100), 1) > 1 + R / 60 && !r.sites.some(s => Math.hypot(s.x - X, s.z - Z) < R + 60);
    // a ruined hut beside a road, near a junction
    if (rnd() < 0.7 && nodesIn.length) {
      const nd = nodesIn[Math.floor(rnd() * nodesIn.length)];
      const a0 = rnd() * Math.PI * 2;
      for (let k = 0; k < 12; k++) {
        const a = a0 + k * 0.52, d = 30 + rnd() * 16, X = nd.x + Math.cos(a) * d, Z = nd.z + Math.sin(a) * d;
        if (this.slope(X, Z, 8) > 0.13 || nearRoad(X, Z, 16) || !clearOf(X, Z, 20)) continue;
        r.sites.push({ type: 'hut', x: X, z: Z, yaw: Math.atan2(nd.x - X, nd.z - Z) + Math.PI, h: this.base(X, Z), id: `H${ri}_${rj}` });
        break;
      }
    }
    // a quarry in a hillside, a spur road into it
    if (rnd() < 0.4) {
      for (let k = 0; k < 30; k++) {
        const X = x0 + 180 + rnd() * (REGION - 360), Z = z0 + 180 + rnd() * (REGION - 360);
        const s = this.slope(X, Z, 20);
        if (s < 0.08 || s > 0.32 || nearRoad(X, Z, 70) || !clearOf(X, Z, 90)) continue;
        const rx = 40 + rnd() * 12, rz = 28 + rnd() * 10, depth = 9 + rnd() * 4;
        const q = { type: 'quarry', x: X, z: Z, rx, rz, depth, floor: this.base(X, Z) - depth, id: `Q${ri}_${rj}` };
        const nd = this.nearestNode(X, Z);
        const spur = this.route({ x: nd.x, z: nd.z, h: nd.h }, { x: X, z: Z, h: q.floor }, `q${ri}_${rj}`, { spur: true, grade: 15 });
        if (!spur) continue;
        q.spur = spur; r.sites.push(q); r.spurs.push(spur);
        break;
      }
    }
    // a lookout on a summit that stands clear of the land round it and that a track can wind up (not a crag): the
    // highest of the region's tops that pass, a spur road up to it
    if (rnd() < 0.7) {
      const cand = [];
      for (let gx = 100; gx <= REGION - 100; gx += 48) for (let gz = 100; gz <= REGION - 100; gz += 48) {
        const X = x0 + gx, Z = z0 + gz;
        cand.push({ X, Z, h: this.macro(X, Z) });
      }
      cand.sort((a, b) => b.h - a.h);
      const tops = [];
      for (const c of cand) {
        if (tops.length >= 10) break;
        let best = c;
        // climb to the local top
        for (let it = 0; it < 40; it++) {
          let moved = false;
          for (let a = 0; a < 8; a++) {
            const X = best.X + Math.cos(a * 0.785) * 8, Z = best.Z + Math.sin(a * 0.785) * 8, h = this.macro(X, Z);
            if (h > best.h + 0.05) { best = { X, Z, h }; moved = true; }
          }
          if (!moved) break;
        }
        if (Math.floor(best.X / REGION) !== ri || Math.floor(best.Z / REGION) !== rj || tops.some(t => Math.hypot(t.X - best.X, t.Z - best.Z) < 150)) continue;
        tops.push(best);
      }
      for (const best of tops) {
        let ring = 0;
        for (let a = 0; a < 12; a++) ring += this.macro(best.X + Math.cos(a * 0.52) * 260, best.Z + Math.sin(a * 0.52) * 260);
        const prom = best.h - ring / 12;
        let steep = 0;
        for (let a = 0; a < 8; a++) steep += this.slope(best.X + Math.cos(a * 0.785) * 50, best.Z + Math.sin(a * 0.785) * 50, 8);
        if (!(prom > 18 && prom < 140 && steep / 8 < 0.45 && clearOf(best.X, best.Z, 30) && !nearRoad(best.X, best.Z, 40))) continue;
        const top = this.base(best.X, best.Z);
        const nd = this.nearestNode(best.X, best.Z);
        const spur = this.route({ x: nd.x, z: nd.z, h: nd.h }, { x: best.X, z: best.Z, h: top }, `p${ri}_${rj}`, { spur: true, grade: 14, corridor: 260 });
        if (!spur) continue;
        r.sites.push({ type: 'lookout', x: best.X, z: best.Z, h: top, prom, id: `P${ri}_${rj}`, spur });
        r.spurs.push(spur);
        break;
      }
    }
    // a lake shore as a place
    for (const lk of r.lakes) r.sites.push({ type: 'lake', x: lk.x, z: lk.z, lake: lk, id: lk.id });
    return r;
  }
  regionsIn(x0, z0, x1, z1) {
    const out = [];
    for (let i = Math.floor(x0 / REGION); i <= Math.floor(x1 / REGION); i++)
      for (let j = Math.floor(z0 / REGION); j <= Math.floor(z1 / REGION); j++) out.push(this.regionFull(i, j));
    return out;
  }

  // ------------------------------------------------------------------ roads
  node(ci, cj) {
    const key = ci + ',' + cj;
    let n = this.nodes.get(key);
    if (n) return n;
    const rnd = rngAt(ci, cj, 101 + this.seed);
    let x = (ci + 0.18 + 0.64 * rnd()) * ROAD_CELL, z = (cj + 0.18 + 0.64 * rnd()) * ROAD_CELL;
    // not in a lake: pushed out past its shore
    for (const l of this.lakesNear(x, z, 0)) {
      const e = Math.hypot((x - l.x) / l.rx, (z - l.z) / l.rz);
      if (e < 1.45) { const f = 1.5 / Math.max(e, 1e-3); x = l.x + (x - l.x) * f; z = l.z + (z - l.z) * f; }
    }
    // off steep ground: the flattest of a few spots nearby
    if (this.slope(x, z, 10) > 0.2) {
      let bx = x, bz = z, bs = this.slope(x, z, 10);
      for (let k = 0; k < 12; k++) {
        const a = k * 0.52, d = 25 + (k % 3) * 20, X = x + Math.cos(a) * d, Z = z + Math.sin(a) * d, s = this.slope(X, Z, 10);
        if (s < bs && this.inLake(X, Z, this.lakesNear(X, Z, 0), 1.45) > 1) { bs = s; bx = X; bz = Z; }
      }
      x = bx; z = bz;
    }
    let h = 0, c = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { h += this.base(x + a * 6, z + b * 6); c++; }
    n = { ci, cj, x, z, h: h / c, key };
    this.nodes.set(key, n);
    return n;
  }
  nodesAround(X, Z, R) {
    const out = [];
    for (let i = Math.floor((X - R) / ROAD_CELL); i <= Math.floor((X + R) / ROAD_CELL); i++)
      for (let j = Math.floor((Z - R) / ROAD_CELL); j <= Math.floor((Z + R) / ROAD_CELL); j++) out.push(this.node(i, j));
    return out;
  }
  nearestNode(X, Z) {
    let best = null, bd = Infinity;
    for (const n of this.nodesAround(X, Z, ROAD_CELL)) { const d = Math.hypot(n.x - X, n.z - Z); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  // the links of the node at (ci, cj), as neighbour cell offsets: east and north by chance, a diagonal per 2x2 block
  // (never both diagonals of one block, so roads don't cross without a junction)
  links(ci, cj) {
    const out = [];
    const has = (i, j, d) => hash3(i, j, 211 + d + this.seed) < (d === 0 ? 0.74 : 0.7);
    const diag = (i, j) => { const h = hash3(i, j, 307 + this.seed); return h < 0.11 ? 1 : h < 0.22 ? 2 : 0; };   // 1: (i,j)-(i+1,j+1), 2: (i,j+1)-(i+1,j)
    if (has(ci, cj, 0)) out.push([ci + 1, cj]);
    if (has(ci - 1, cj, 0)) out.push([ci - 1, cj]);
    if (has(ci, cj, 1)) out.push([ci, cj + 1]);
    if (has(ci, cj - 1, 1)) out.push([ci, cj - 1]);
    if (diag(ci, cj) === 1) out.push([ci + 1, cj + 1]);
    if (diag(ci - 1, cj - 1) === 1) out.push([ci - 1, cj - 1]);
    if (diag(ci, cj - 1) === 2) out.push([ci + 1, cj - 1]);
    if (diag(ci - 1, cj) === 2) out.push([ci - 1, cj + 1]);
    return out;
  }
  edgesOf(nd) {
    if (nd.edges) return nd.edges;
    const out = [];
    for (const [i, j] of this.links(nd.ci, nd.cj)) {
      const o = this.node(i, j);
      const [a, b] = nd.key < o.key ? [nd, o] : [o, nd];
      const key = a.key + '|' + b.key;
      let e = this.edges.get(key);
      if (e === undefined) {
        e = this.route(a, b, key) || null;
        this.edges.set(key, e);
      }
      if (e) out.push(e);
    }
    nd.edges = out;
    return out;
  }
  // the links (node to node) whose path may come within `m` of the box
  linksIn(x0, z0, x1, z1, m = 8) {
    const seen = new Set(), out = [];
    const R = ROAD_CELL + 320;
    for (let i = Math.floor((x0 - R) / ROAD_CELL); i <= Math.floor((x1 + R) / ROAD_CELL); i++)
      for (let j = Math.floor((z0 - R) / ROAD_CELL); j <= Math.floor((z1 + R) / ROAD_CELL); j++)
        for (const e of this.edgesOf(this.node(i, j))) {
          if (seen.has(e.key) || e.bb[2] < x0 - m || e.bb[0] > x1 + m || e.bb[3] < z0 - m || e.bb[1] > z1 + m) continue;
          seen.add(e.key); out.push(e);
        }
    return out;
  }
  // every road (links and the spurs to sites) whose path may come within `m` of the box
  roadsIn(x0, z0, x1, z1, m = 8) {
    const out = this.linksIn(x0, z0, x1, z1, m);
    for (const r of this.regionsIn(x0 - 700, z0 - 700, x1 + 700, z1 + 700)) for (const e of r.spurs) {
      if (e.bb[2] < x0 - m || e.bb[0] > x1 + m || e.bb[3] < z0 - m || e.bb[1] > z1 + m) continue;
      out.push(e);
    }
    return out;
  }

  // A* on an 8 m grid between a and b ({x, z, h}), then a smooth curve and a graded bed. opts: spur (ends in a
  // site), grade (deg), corridor (m round the two ends)
  route(a, b, key, opts = {}) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const M = opts.corridor ?? Math.max(90, Math.min(200, dist * 0.3));
    const gx0 = Math.floor((Math.min(a.x, b.x) - M) / GRID), gz0 = Math.floor((Math.min(a.z, b.z) - M) / GRID);
    const W = Math.ceil((Math.max(a.x, b.x) + M) / GRID) - gx0 + 1, Hh = Math.ceil((Math.max(a.z, b.z) + M) / GRID) - gz0 + 1;
    const n = W * Hh;
    const hg = new Float32Array(n), wet = new Uint8Array(n), wig = new Float32Array(n);
    const lakes = this.lakesNear((a.x + b.x) / 2, (a.z + b.z) / 2, dist / 2 + M);
    for (let i = 0; i < W; i++) for (let j = 0; j < Hh; j++) {
      const X = (gx0 + i) * GRID, Z = (gz0 + j) * GRID, k = i * Hh + j;
      hg[k] = this.base(X, Z);
      wet[k] = lakes.length && this.inLake(X, Z, lakes, 1.25) < 1 ? 1 : 0;
      wig[k] = 0.5 + 0.5 * this.n3(X * 0.012 + 5.5, Z * 0.012);
    }
    const cell = (X, Z) => [Math.max(0, Math.min(W - 1, Math.round(X / GRID) - gx0)), Math.max(0, Math.min(Hh - 1, Math.round(Z / GRID) - gz0))];
    const [si, sj] = cell(a.x, a.z), [ti, tj] = cell(b.x, b.z);
    const start = si * Hh + sj, goal = ti * Hh + tj;
    const g = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const gmax = TAN(opts.grade ?? 13);
    const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
    const heur = (k) => { const i = (k / Hh) | 0, j = k - i * Hh; return Math.hypot(i - ti, j - tj) * GRID; };
    const heap = new Heap();
    g[start] = 0; heap.push(heur(start), start);
    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === goal) break;
      const ui = (u / Hh) | 0, uj = u - ui * Hh;
      for (const [di, dj] of MOVES) {
        const vi = ui + di, vj = uj + dj;
        if (vi < 0 || vj < 0 || vi >= W || vj >= Hh) continue;
        const v = vi * Hh + vj;
        if (done[v]) continue;
        const d = Math.hypot(di, dj) * GRID, gr = Math.abs(hg[v] - hg[u]) / d;
        // steep ground costs more and more past the target grade; water is (nearly) a wall; a little low-frequency
        // noise makes the routes wander like real tracks
        let c = d * (1 + 18 * gr * gr + (gr > gmax ? 260 * (gr - gmax) * (gr - gmax) + 6 * (gr - gmax) : 0) + 0.35 * wig[v]);
        if (wet[v]) c += d * 80;
        const ng = g[u] + c;
        if (ng < g[v]) { g[v] = ng; from[v] = u; heap.push(ng + heur(v), v); }
      }
    }
    if (from[goal] < 0 && goal !== start) return null;
    const path = [];
    for (let k = goal; k >= 0; k = from[k]) { const i = (k / Hh) | 0, j = k - i * Hh; path.push((gx0 + i) * GRID, (gz0 + j) * GRID); if (k === start) break; }
    path.reverse();   // pairs reversed too: fix below
    const pts = [];
    for (let k = 0; k < path.length; k += 2) pts.push(path[k + 1], path[k]);
    // exact end points
    pts[0] = a.x; pts[1] = a.z; pts[pts.length - 2] = b.x; pts[pts.length - 1] = b.z;
    if (pts.length < 4) return null;
    const sp = simplify(pts, 5);
    // round the corners: the simplified line resampled every 2 m and relaxed (each point pulled towards its
    // neighbours' midpoint, the ends held), so no bend is tighter than a truck can take (a switchback's hairpin
    // becomes a loop of ~10 m radius)
    const coarse = resample(sp.px.flatMap((x, i) => [x, sp.pz[i]]), 2);
    const cx = Array.from(coarse.xs), cz = Array.from(coarse.zs), nc = cx.length;
    for (let it = 0; it < 40; it++) for (let k = 1; k < nc - 1; k++) {
      cx[k] += 0.5 * ((cx[k - 1] + cx[k + 1]) / 2 - cx[k]); cz[k] += 0.5 * ((cz[k - 1] + cz[k + 1]) / 2 - cz[k]);
    }
    const { xs, zs, len } = smoothCurve(cx, cz, 0.5);
    const ns = xs.length;
    if (ns < 8) return null;
    // a spur too short for the climb to its site can't keep to the grade: no road (the site picks another place)
    if (opts.spur && Math.abs(b.h - a.h) > len * TAN(opts.grade ?? 15) * 0.8) return null;
    // ---- the bed: the ground along the line, low-passed, crests cut down to the grade limit, ends on the nodes
    const hs = new Float64Array(ns);
    for (let k = 0; k < ns; k++) hs[k] = this.base(xs[k], zs[k]);
    boxSmooth(hs, 30, 6);
    const maxG = TAN(opts.grade ?? 15) * (len / (ns - 1));
    const cut = () => {
      for (let k = 1; k < ns; k++) hs[k] = Math.min(hs[k], hs[k - 1] + maxG);
      for (let k = ns - 2; k >= 0; k--) hs[k] = Math.min(hs[k], hs[k + 1] + maxG);
    };
    cut();
    const blend = Math.min(120, Math.floor(ns / 2.5));
    const d0 = a.h - hs[0], d1 = b.h - hs[ns - 1];
    for (let k = 0; k < ns; k++) hs[k] += d0 * Math.max(0, 1 - k / blend) + d1 * Math.max(0, 1 - (ns - 1 - k) / blend);
    const e0 = hs[0], e1 = hs[ns - 1];
    cut(); hs[0] = e0; hs[ns - 1] = e1;
    // a node on a crest sits above the cut bed: fill up to it at the grade limit, so the road climbs to the
    // junction instead of stepping up at it
    for (let k = 1; k < ns; k++) hs[k] = Math.max(hs[k], hs[k - 1] - maxG);
    for (let k = ns - 2; k >= 0; k--) hs[k] = Math.max(hs[k], hs[k + 1] - maxG);
    for (let p = 0; p < 3; p++) {
      const o = hs.slice();
      for (let k = 1; k < ns - 1; k++) { let s = 0, c = 0; for (let j = -12; j <= 12; j++) { s += hs[Math.max(0, Math.min(ns - 1, k + j))]; c++; } o[k] = s / c; }
      o[0] = e0; o[ns - 1] = e1;
      hs.set(o);
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < ns; k++) { x0 = Math.min(x0, xs[k]); x1 = Math.max(x1, xs[k]); z0 = Math.min(z0, zs[k]); z1 = Math.max(z1, zs[k]); }
    // a mud hole in a dip now and then (not near the ends: junctions stay dry)
    const muds = [];
    const rnd = mulberry32(Math.floor(hash3(Math.round(a.x), Math.round(b.z), 5 + this.seed) * 4294967296));
    if (!opts.spur && rnd() < 0.5) {
      let bk = -1, bh = Infinity;
      for (let k = 120; k < ns - 120; k += 4) {
        if (hs[k] < hs[k - 40] - 0.15 && hs[k] < hs[k + 40] - 0.15 && hs[k] < bh) { bh = hs[k]; bk = k; }
      }
      if (bk > 0) muds.push({ x: xs[bk], z: zs[bk], rx: 6 + rnd() * 2, rz: 8 + rnd() * 3, depth: 0.28 + rnd() * 0.1 });
    }
    return { key, a, b, xs, zs, hs, len, bb: [x0, z0, x1, z1], muds, spur: !!opts.spur };
  }

  // a stream from src down to the lake: A* that hates climbing, then a bed forced downhill
  routeStream(src, lk, rnd) {
    const ang = Math.atan2(src.Z - lk.z, src.X - lk.x);
    const end = { x: lk.x + Math.cos(ang) * lk.rx * 0.85, z: lk.z + Math.sin(ang) * lk.rz * 0.85 };
    const a = { x: src.X, z: src.Z }, dist = Math.hypot(end.x - a.x, end.z - a.z), M = 160;
    const gx0 = Math.floor((Math.min(a.x, end.x) - M) / GRID), gz0 = Math.floor((Math.min(a.z, end.z) - M) / GRID);
    const W = Math.ceil((Math.max(a.x, end.x) + M) / GRID) - gx0 + 1, Hh = Math.ceil((Math.max(a.z, end.z) + M) / GRID) - gz0 + 1;
    const n = W * Hh, hg = new Float32Array(n);
    for (let i = 0; i < W; i++) for (let j = 0; j < Hh; j++) hg[i * Hh + j] = this.base((gx0 + i) * GRID, (gz0 + j) * GRID);
    const cell = (X, Z) => Math.max(0, Math.min(W - 1, Math.round(X / GRID) - gx0)) * Hh + Math.max(0, Math.min(Hh - 1, Math.round(Z / GRID) - gz0));
    const start = cell(a.x, a.z), goal = cell(end.x, end.z), gi = (goal / Hh) | 0, gj = goal - gi * Hh;
    const g = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const heap = new Heap();
    g[start] = 0; heap.push(0, start);
    const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === goal) break;
      const ui = (u / Hh) | 0, uj = u - ui * Hh;
      for (const [di, dj] of MOVES) {
        const vi = ui + di, vj = uj + dj;
        if (vi < 0 || vj < 0 || vi >= W || vj >= Hh) continue;
        const v = vi * Hh + vj;
        if (done[v]) continue;
        const d = Math.hypot(di, dj) * GRID, rise = hg[v] - hg[u];
        const c = d * (1 + (rise > 0 ? 60 * rise / d + 4 : 0) + 0.3 * Math.max(0, -rise / d));
        if (g[u] + c < g[v]) { g[v] = g[u] + c; from[v] = u; heap.push(g[v] + Math.hypot(vi - gi, vj - gj) * GRID, v); }
      }
    }
    if (from[goal] < 0) return null;
    const pts = [];
    for (let k = goal; k >= 0; k = from[k]) { const i = (k / Hh) | 0, j = k - i * Hh; pts.push((gx0 + i) * GRID, (gz0 + j) * GRID); if (k === start) break; }
    // pairs are (x, z) but in reverse order: flip to run from the spring to the lake
    const fw = [];
    for (let k = pts.length - 2; k >= 0; k -= 2) fw.push(pts[k], pts[k + 1]);
    if (fw.length < 6) return null;
    const sp = simplify(fw, 4);
    const { xs, zs } = smoothCurve(sp.px, sp.pz, 1);
    const ns = xs.length;
    // bed profile: lowest ground nearby, smoothed, forced downhill towards the lake
    let hs = new Float64Array(ns);
    for (let k = 0; k < ns; k++) {
      let m = Infinity;
      for (const o of [-3, 0, 3]) m = Math.min(m, this.base(xs[k] + o, zs[k]), this.base(xs[k], zs[k] + o));
      hs[k] = m;
    }
    boxSmooth(hs, 10, 3);
    for (let k = ns - 2; k >= 0; k--) hs[k] = Math.max(hs[k], hs[k + 1] + 0.02);
    for (let k = 1; k < ns; k++) hs[k] = Math.min(hs[k], hs[k - 1]);
    const level = new Float64Array(ns), width = new Float64Array(ns), ford = new Float64Array(ns);
    for (let k = 0; k < ns; k++) {
      width[k] = 2.6 + 1.4 * (0.5 + 0.5 * this.n5(k * 0.02, 3.3 + src.X * 1e-3)) * Math.min(1, 0.4 + k / ns);
      level[k] = lerp(hs[k] - 0.45, lk.level, smoothstep(ns - 40, ns - 1, k));
    }
    // fords: where a road crosses, wider and shallower (the links only: spurs need the sites, which need the
    // streams' regions; a spur never crosses a stream far from a link... and if it does, it fords a narrow one)
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < ns; k++) { bx0 = Math.min(bx0, xs[k]); bx1 = Math.max(bx1, xs[k]); bz0 = Math.min(bz0, zs[k]); bz1 = Math.max(bz1, zs[k]); }
    for (const e of this.linksIn(bx0, bz0, bx1, bz1, 30)) for (let j = 0; j < e.xs.length; j += 4) {
      const ex = e.xs[j], ez = e.zs[j];
      if (ex < bx0 - 30 || ex > bx1 + 30 || ez < bz0 - 30 || ez > bz1 + 30) continue;
      for (let k = 0; k < ns; k += 2) {
        const d = Math.hypot(xs[k] - ex, zs[k] - ez);
        if (d < 30) ford[k] = Math.max(ford[k], smoothstep(30, 8, d));
      }
    }
    for (let k = 1; k < ns; k++) ford[k] = Math.max(ford[k], ford[k - 1] * 0.9);
    for (let k = ns - 2; k >= 0; k--) ford[k] = Math.max(ford[k], ford[k + 1] * 0.9);
    for (let k = 0; k < ns; k++) width[k] += ford[k] * 3.5;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < ns; k++) { x0 = Math.min(x0, xs[k]); x1 = Math.max(x1, xs[k]); z0 = Math.min(z0, zs[k]); z1 = Math.max(z1, zs[k]); }
    return { xs, zs, level, width, ford, lake: lk, bb: [x0, z0, x1, z1] };
  }

  // where a new game starts: on a road near the origin, facing along it
  spawn() {
    for (let r = 0; r < 6; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const nd = this.node(i, j);
      for (const e of this.edgesOf(nd)) {
        if (e.spur) continue;
        const fromA = e.a === nd, n = e.xs.length, k = fromA ? 80 : n - 81, k2 = fromA ? k + 6 : k - 6;
        if (n < 200) continue;
        const x = e.xs[k], z = e.zs[k];
        if (this.inLake(x, z, this.lakesNear(x, z, 50), 1.3) < 1 || this.slope(x, z, 25) > 0.1) continue;
        return { x, z, yaw: Math.atan2(-(e.xs[k2] - x), -(e.zs[k2] - z)) };
      }
    }
    return { x: 0, z: 0, yaw: 0 };
  }
}
