import * as THREE from 'three';
import { makeSimplex2D, fbm, ridged, smoothstep, lerp } from './noise.js';
import { SURFACES } from '../vehicle/tire.js';

// Procedural test map: rolling hills, a big hill to climb, dirt trails with ruts, a mud section,
// mountains around the edge and a proving ground with five test lanes.

export const MAP_SIZE = 400;
export const CELL = 0.5;
export const N = Math.round(MAP_SIZE / CELL); // cells per side
export const SURF = { grass: 0, dirt: 1, rock: 2, mud: 3, sand: 4 };
export const SURF_LIST = [SURFACES.grass, SURFACES.dirt, SURFACES.rock, SURFACES.mud, SURFACES.sand];

export const SPAWN = { x: 0, z: 46, yaw: 0 };
export const PAD = { x0: -80, x1: -12, z0: -38, z1: 52 };
export const LANES = { A: -22, B: -33, C: -44, D: -55, E: -66 };

export const TRAILS = [
  { closed: true, pts: [[0, 50], [0, -20], [15, -70], [60, -108], [112, -100], [136, -42], [132, 28], [110, 78], [60, 105], [15, 92], [0, 72]] },
  { closed: false, pts: [[0, -20], [-40, -62], [-100, -84], [-134, -30], [-132, 60], [-100, 112], [-40, 126], [15, 92]] },
];
export const HILL = { x: 72, z: -30, r: 52, h: 24 };

export class Terrain {
  constructor(seed = 7) {
    this.seed = seed;
    const NN = N + 1;
    this.NN = NN;
    this.heights = new Float32Array(NN * NN);   // index = ix * NN + iz  (Rapier column-major layout)
    this.surface = new Uint8Array(NN * NN);
    this.trailDist = new Float32Array(NN * NN).fill(1e9);
    this.generate();
  }

  idx(ix, iz) { return ix * this.NN + iz; }
  worldX(ix) { return -MAP_SIZE / 2 + ix * CELL; }

  generate() {
    const NN = this.NN;
    const n1 = makeSimplex2D(this.seed), n2 = makeSimplex2D(this.seed + 11), n3 = makeSimplex2D(this.seed + 23);
    const H = this.heights;
    const half = MAP_SIZE / 2;
    const base = (x, z) => {
      let h = fbm(n1, x * 0.0055, z * 0.0055, 4) * 10;
      h += fbm(n2, x * 0.028, z * 0.028, 3) * 1.4;
      h += fbm(n3, x * 0.22, z * 0.22, 2) * 0.13;           // small-scale bumpiness you feel in the seat
      // big hill
      const dh = Math.hypot(x - HILL.x, z - HILL.z);
      const hs = smoothstep(HILL.r, HILL.r * 0.18, dh);
      h += HILL.h * hs * hs * (0.85 + 0.15 * ridged(n2, x * 0.02, z * 0.02, 2));
      // mountains at the rim
      const r = Math.max(Math.abs(x), Math.abs(z));
      const m = smoothstep(150, 196, r);
      h += m * (22 + 26 * ridged(n3, x * 0.012, z * 0.012, 4));
      return h;
    };
    for (let ix = 0; ix < NN; ix++) {
      const x = -half + ix * CELL;
      for (let iz = 0; iz < NN; iz++) {
        const z = -half + iz * CELL;
        H[ix * NN + iz] = base(x, z);
      }
    }

    // ---- proving ground pad + spawn clearing (flattened)
    const padH = base((PAD.x0 + PAD.x1) / 2, (PAD.z0 + PAD.z1) / 2);
    this.padH = padH;
    const spawnH = base(SPAWN.x, SPAWN.z);
    for (let ix = 0; ix < NN; ix++) {
      const x = -half + ix * CELL;
      for (let iz = 0; iz < NN; iz++) {
        const z = -half + iz * CELL;
        const i = ix * NN + iz;
        const dx = Math.max(PAD.x0 - x, 0, x - PAD.x1), dz = Math.max(PAD.z0 - z, 0, z - PAD.z1);
        const dPad = Math.hypot(dx, dz);
        const wPad = smoothstep(14, 0, dPad);
        const small = fbm(n3, x * 0.22, z * 0.22, 2) * 0.05;
        H[i] = lerp(H[i], padH + small, wPad);
        const dS = Math.hypot(x - SPAWN.x, z - SPAWN.z);
        H[i] = lerp(H[i], spawnH, smoothstep(22, 8, dS) * (1 - wPad));
        if (dPad === 0) this.surface[i] = SURF.dirt;
      }
    }

    // ---- trails: per-trail distance field + smoothed centreline height, blended where trails meet
    this.trailCurves = [];
    const perTrail = [];
    const trailSamples = [];
    for (let ti = 0; ti < TRAILS.length; ti++) {
      const t = TRAILS[ti];
      const pts = t.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
      const curve = new THREE.CatmullRomCurve3(pts, t.closed, 'centripetal');
      const len = curve.getLength();
      const ns = Math.ceil(len / 0.5);
      const sp = curve.getSpacedPoints(ns);
      this.trailCurves.push(curve);
      let hs = sp.map(p => this.sampleGrid(p.x, p.z));
      for (let pass = 0; pass < 4; pass++) {
        const o = new Array(hs.length);
        const W = 18;
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
      // a branch trail meets earlier trails at its ends: pull its heights onto theirs
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
      }
      trailSamples.push({ sp, hs });
      const dist = new Float32Array(NN * NN).fill(1e9), th = new Float32Array(NN * NN);
      const R = 6;
      for (let k = 0; k < sp.length - 1; k++) {
        const a = sp[k], b = sp[k + 1];
        const minX = Math.min(a.x, b.x) - R, maxX = Math.max(a.x, b.x) + R;
        const minZ = Math.min(a.z, b.z) - R, maxZ = Math.max(a.z, b.z) + R;
        const ix0 = Math.max(0, Math.floor((minX + half) / CELL)), ix1 = Math.min(N, Math.ceil((maxX + half) / CELL));
        const iz0 = Math.max(0, Math.floor((minZ + half) / CELL)), iz1 = Math.min(N, Math.ceil((maxZ + half) / CELL));
        const abx = b.x - a.x, abz = b.z - a.z, ab2 = abx * abx + abz * abz;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = -half + ix * CELL;
          for (let iz = iz0; iz <= iz1; iz++) {
            const z = -half + iz * CELL;
            let u = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
            u = Math.max(0, Math.min(1, u));
            const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
            const i = ix * NN + iz;
            if (d < dist[i]) { dist[i] = d; th[i] = hs[k] + (hs[k + 1] - hs[k]) * u; }
          }
        }
      }
      perTrail.push({ dist, th });
    }
    for (let ix = 0; ix < NN; ix++) {
      const x = -half + ix * CELL;
      for (let iz = 0; iz < NN; iz++) {
        const i = ix * NN + iz;
        let wsum = 0, hsum = 0, wmax = 0, dmin = 1e9;
        for (const t of perTrail) {
          const d = t.dist[i];
          if (d > 6) continue;
          const w = smoothstep(5.5, 2.4, d);
          const wb = 1e-3 + w;
          wsum += wb; hsum += wb * t.th[i];
          wmax = Math.max(wmax, w);
          dmin = Math.min(dmin, d);
        }
        this.trailDist[i] = dmin;
        if (wsum === 0) continue;
        const z = -half + iz * CELL;
        let h = lerp(H[i], hsum / wsum, wmax);
        // twin ruts worn by traffic, slightly crowned middle, a little noise
        // (wide enough for the 0.5 m grid: narrower ruts alias into a washboard on diagonal trails)
        const rut = Math.exp(-(((dmin - 0.8) / 0.34) ** 2));
        h += wmax * (-0.055 * rut + 0.02 * Math.exp(-((dmin / 0.5) ** 2)) + fbm(n2, x * 0.25, z * 0.25, 2) * 0.03);
        H[i] = h;
        if (dmin < 2.7) this.surface[i] = SURF.dirt;
      }
    }

    // ---- mud hole on the main trail (at the bottom of a dip) + mud lane on the pad
    const mp = this.trailCurves[0].getPointAt(0.085);
    const muds = [{ x: mp.x, z: mp.z, rx: 7, rz: 11, depth: 0.32 }, { x: LANES.E, z: 28, rx: 5, rz: 9, depth: 0.55 }];
    this.muds = muds;
    for (const m of muds) this.stampEllipse(m.x, m.z, m.rx, m.rz, (x, z, i, e) => {
      const w = smoothstep(1.3, 0.6, e);
      H[i] -= m.depth * w * (0.8 + 0.2 * n1(x * 0.3, z * 0.3));
      if (e < 1.0) this.surface[i] = SURF.mud;
    }, 4);

    // ---- proving ground lanes
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

    // ---- rock surfaces on steep slopes + mountain tops
    const NNm = NN;
    for (let ix = 1; ix < N; ix++) {
      for (let iz = 1; iz < N; iz++) {
        const i = ix * NNm + iz;
        const gx = (H[i + NNm] - H[i - NNm]) / (2 * CELL), gz = (H[i + 1] - H[i - 1]) / (2 * CELL);
        const slope = Math.atan(Math.hypot(gx, gz));
        if (this.surface[i] === SURF.grass && slope > 0.62) this.surface[i] = SURF.rock;
      }
    }
  }

  // fn(x, z, index, e) where e is the normalised elliptic radius (1 at rx/rz); margin widens the loop
  stampEllipse(cx, cz, rx, rz, fn, margin = 0) {
    const half = MAP_SIZE / 2, NN = this.NN;
    const ex = rx + margin, ez = rz + margin;
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

  surfaceAt(x, z) {
    const half = MAP_SIZE / 2;
    const ix = Math.max(0, Math.min(N, Math.round((x + half) / CELL)));
    const iz = Math.max(0, Math.min(N, Math.round((z + half) / CELL)));
    return SURF_LIST[this.surface[ix * this.NN + iz]];
  }

  isTrail(x, z, r = 4) {
    const half = MAP_SIZE / 2;
    const ix = Math.max(0, Math.min(N, Math.round((x + half) / CELL)));
    const iz = Math.max(0, Math.min(N, Math.round((z + half) / CELL)));
    return this.trailDist[ix * this.NN + iz] < r;
  }

  createCollider(RAPIER, world) {
    const desc = RAPIER.ColliderDesc.heightfield(N, N, this.heights, { x: MAP_SIZE, y: 1, z: MAP_SIZE })
      .setFriction(0.9).setRestitution(0.0);
    this.collider = world.createCollider(desc);
    return this.collider;
  }
}
