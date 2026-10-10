import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, uniform, uniformArray, attribute, texture, storage, instancedArray, instanceIndex, atomicAdd, atomicStore, atomicLoad,
  vec2, vec3, vec4, float, int, uint, bool, ivec2, struct, varyingProperty, positionWorld, cameraPosition, cameraViewMatrix, modelWorldMatrix,
  mix, clamp, smoothstep, step, max, min, abs, sqrt, sin, cos, fract, floor, dot, length, normalize, distance, sign,
  packUnorm4x8, unpackUnorm4x8, floatBitsToUint, uintBitsToFloat, select, Loop,
} from 'three/tsl';
import { MAP_SIZE } from './terrain.js';

// GPU grass. Blades live on a grid of world cells, one candidate blade per cell; each cell's blade is hashed
// from the cell index, so blades never swim as the grid follows the camera. The grid is cut into world-aligned
// tiles (16-32 m), frustum culled on the CPU. Thinning with distance: a tile's instances are in bit-reversed
// Morton order, so any leading part of the list is spread evenly (first quarter = one blade per 2x2 cells, ...);
// a far tile draws only the first few, the blades that stay keep their places, a coarse blade is jittered over
// its block (no lattice), and blades at the edge of the drawn share shrink to nothing (no popping). Density from
// the terrain's ground-data map (no grass on trails, rock, mud, sand or under dense canopy); heights from the
// physics heightfield with the same triangle split. Wind gusts, wheels push blades aside, tyre tracks flatten
// them, a few far blades are wild flowers.
//
// WebGPU: a compute pass per frame runs one thread per instance the tiles draw (a table of the visible tiles
// says which tile and instance each thread is), keeps the blades that exist and are in the view frustum, and
// appends them (atomics) to one of three buckets, each drawn with a single indirect draw:
//   close (< CLOSE m): 4-segment blades that bend smoothly
//   near  (< NEAR m): 2 segments
//   far   (the rest): 1 triangle
// WebGL 2 fallback: every tile is an instanced mesh, every instance runs the vertex stage (culled or not).

const HALF = MAP_SIZE / 2;
const CLOSE = 14, NEAR = 30;   // m: the WebGPU buckets
const SEG_NEAR = 22;           // m: WebGL tiles closer than this use 2-segment blades, the rest 1-segment
// the grass curves (density, height, width over the distance) are sampled at CURVE_N + 1 distances,
// d = CURVE_MAX * (i / CURVE_N)^2: closer together near the camera, where the detail is
const CURVE_N = 64, CURVE_MAX = 300;
const curveD = i => CURVE_MAX * (i / CURVE_N) ** 2;
const MAX_TILES = 2048;        // WebGPU tile table (the largest curve end at the smallest tile: 39 x 39)

// a curve is a list of [distance m, value] points: straight lines between them, or a smooth curve that
// never overshoots the points (monotone cubic) when `smooth`; flat before the first and after the last
// point. It is interpolated in the space the presets were drawn in (√distance across, log value up;
// both plain when `lin`).
function evalCurve(pts, d, smooth, logY = false, lin = false) {
  const n = pts.length;
  if (d <= pts[0][0]) return pts[0][1];
  if (d >= pts[n - 1][0]) return pts[n - 1][1];
  if (lin) logY = false;
  const X = x => (lin ? x / CURVE_MAX : Math.sqrt(x / CURVE_MAX)), Y = y => (logY ? Math.log(Math.max(y, 0.01)) : y);
  let i = 0;
  while (d > pts[i + 1][0]) i++;
  const x = k => X(pts[k][0]), y = k => Y(pts[k][1]);
  const h = x(i + 1) - x(i), t = (X(d) - x(i)) / h;
  let v;
  if (!smooth || n < 3) v = y(i) + (y(i + 1) - y(i)) * t;
  else {
    const sl = k => (y(k + 1) - y(k)) / (x(k + 1) - x(k));
    const m = k => {   // Fritsch-Carlson tangent at point k
      if (k === 0) return sl(0);
      if (k === n - 1) return sl(n - 2);
      const a = sl(k - 1), b = sl(k);
      return a * b <= 0 ? 0 : 3 * (x(k + 1) - x(k - 1)) / ((2 * x(k + 1) - x(k) - x(k - 1)) / a + (x(k + 1) + x(k) - 2 * x(k - 1)) / b);
    };
    const t2 = t * t, t3 = t2 * t;
    v = (2 * t3 - 3 * t2 + 1) * y(i) + (t3 - 2 * t2 + t) * h * m(i) + (-2 * t3 + 3 * t2) * y(i + 1) + (t3 - t2) * h * m(i + 1);
  }
  return logY ? Math.exp(v) : v;
}

// a blade strip: aBlade.x = side (-1, 1, or 0 at the tip), aBlade.y = t along the blade (0 root .. 1 tip)
function bladeGeometry(segments) {
  const v = [], idx = [];
  for (let s = 0; s < segments; s++) { const t = s / segments; v.push(-1, t, 0, 1, t, 0); }
  v.push(0, 1, 0);
  for (let s = 0; s < segments - 1; s++) {
    const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const top = segments * 2, a = (segments - 1) * 2;
  idx.push(a, a + 1, top);
  const g = new THREE.BufferGeometry();
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(v.length), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(v.length), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const gHash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

// opts.sun: the DirectionalLight (thin blades are lit like their sunlit face, see the material)
export function buildGrass(terrainView, renderer, opts = {}) {
  const caps = renderer?.caps || {};
  const gpu = !!caps.compute;
  const TU = terrainView.uniforms;
  const tH = texture(terrainView.heightTex), tData = texture(terrainView.dataTex), tNoise = texture(terrainView.noiseTex), tTrack = texture(terrainView.trackTex);
  const shared = {
    uWind: uniform(new THREE.Vector4(0.8, 0.6, 1, 0)),
    uPush: uniformArray(Array.from({ length: 5 }, () => new THREE.Vector4(0, -1e5, 0, 0)), 'vec4'),
    uTrackP: uniform(new THREE.Vector4(0, 0, MAP_SIZE, 0)),
    uCam: uniform(new THREE.Vector3()),   // the view camera (compute passes have no camera of their own)
    uSun: uniform(new THREE.Vector3(0, 1, 0)),   // towards the sun (or the moon): opts.sun
  };
  const uMap = TU.uMap;
  const U = {
    uGrid: uniform(new THREE.Vector4(0, 0, 0.1, 0)),    // base cell x, base cell z, spacing (m), unused
    uLod: uniform(new THREE.Vector4(8, 256, 100, 0.035)), // log2(cells per tile side), cells per tile side, grass distance (m), flower chance
    uRad: uniform(new THREE.Vector2(72, 100)),          // fade out start, end (m)
    // per sampled distance (CURVE_N + 1): share of the grid drawn, height (m), width (m)
    uCurve: uniformArray(Array.from({ length: CURVE_N + 1 }, () => new THREE.Vector4(1, 0.5, 0.07, 0)), 'vec4'),
  };
  const group = new THREE.Group();
  group.name = 'grass';

  // smooth ground height at xz (Rapier's triangle split)
  const groundAt = Fn(([xz]) => {
    const f = xz.add(uMap.x).div(uMap.y);
    const fi = floor(f), t = f.sub(fi);
    const i = ivec2(fi);
    const n1 = int(uMap.z).sub(1);
    const hg = (a, b) => { const g = ivec2(i.x.add(a), i.y.add(b)).clamp(ivec2(0), ivec2(n1)); return tH.load(ivec2(g.y, g.x)).r; };
    const h00 = hg(0, 0), h10 = hg(1, 0), h01 = hg(0, 1), h11 = hg(1, 1);
    return select(t.x.add(t.y).lessThanEqual(1.0),
      h00.add(h10.sub(h00).mul(t.x)).add(h01.sub(h00).mul(t.y)),
      h11.add(h01.sub(h11).mul(float(1).sub(t.x))).add(h10.sub(h11).mul(float(1).sub(t.y))));
  });

  // Instance gi of tile `tile` (tile coordinates from the base cell) -> its blade, or nothing. Returns
  // vec4(x, ground y, z, height) and vec4(yaw, width, packed colour, packed lean); `ok` false = no blade.
  // A flower stores its head colour's blue in the colour word's alpha (0 = no flower), red and green in the lean word.
  // Used by the compute pass and by the fallback's vertex stage.
  const bladeOf = (tile, gi) => {
    // instance -> cell in the tile: bit pair p (from the top) of the instance index is bit p of the cell's
    // x and z, so every leading part of the list is spread evenly; leading zero pairs = the size of the
    // block this blade stands for (it is jittered over that block)
    const gn = int(U.uLod.x);
    const ux = uint(0).toVar(), uz = uint(0).toVar(), lead = int(0).toVar(), seen = bool(false).toVar();
    Loop(10, ({ i }) => {
      If(i.lessThan(gn), () => {
        const bx = gi.shiftRight(uint(gn.mul(2).sub(1).sub(i.mul(2)))).bitAnd(uint(1));
        const bz = gi.shiftRight(uint(gn.mul(2).sub(2).sub(i.mul(2)))).bitAnd(uint(1));
        ux.assign(ux.bitOr(bx.shiftLeft(uint(i))));
        uz.assign(uz.bitOr(bz.shiftLeft(uint(i))));
        If(seen.not().and(bx.bitOr(bz).equal(uint(0))), () => { lead.addAssign(1); }).Else(() => { seen.assign(true); });
      });
    });
    const gk = U.uLod.y;   // not exp2(): it isn't exact on every GPU, and the cell hashes need whole numbers
    const cellIdx = U.uGrid.xy.add(tile.mul(gk)).add(vec2(float(ux), float(uz))).toVar();
    const hA = gHash22(cellIdx), hB = gHash22(cellIdx.add(17.17)), hC = gHash22(cellIdx.add(41.3));
    const bxz = cellIdx.add(hA.mul(float(uint(1).shiftLeft(uint(lead))))).mul(U.uGrid.z).toVar();
    const dCam = distance(bxz, shared.uCam.xz);
    const cu = sqrt(clamp(dCam.div(CURVE_MAX), 0.0, 1.0)).mul(CURVE_N);
    const ci = int(min(cu, CURVE_N - 1));
    const cv = mix(U.uCurve.element(ci), U.uCurve.element(ci.add(1)), cu.sub(float(ci)));
    // the share of the grid drawn at full size at this distance; the next 35 % of that grow in from nothing
    // as the share rises (so a blade never pops), the rest isn't drawn
    const keep = cv.x;
    const rank = float(gi).add(0.5).div(gk.mul(gk));
    const fade = float(1).sub(smoothstep(U.uRad.x, U.uRad.y, dCam)).mul(clamp(keep.mul(1.35).sub(rank).div(max(keep.mul(0.35), 1e-6)), 0.0, 1.0));
    // density (precomputed: grass surfaces, slope, clearings, canopy)
    const dens = tData.sample(bxz.add(uMap.x).add(0.5).div(uMap.w.add(1.0))).level(0).a;
    const inMap = max(abs(bxz.x), abs(bxz.y)).lessThan(uMap.x.sub(1.0));
    const ok = hB.x.lessThan(dens).and(fade.greaterThan(0.0)).and(inMap);
    const nz = tNoise.sample(bxz.div(61.0)).level(0);
    const gy = groundAt(bxz);
    const tall = nz.g.mul(nz.g).mul(0.95).add(0.45);
    const flower = step(hC.x, U.uLod.w.mul(smoothstep(12.0, 30.0, dCam))).mul(step(0.5, nz.b.add(0.2)));
    // cv.y, cv.z: the height and width curves at this distance
    const ht = cv.y.mul(tall).mul(hB.y.mul(0.7).add(0.6)).mul(fade.mul(0.75).add(0.25)).mul(mix(1.0, 0.8, flower));
    const wd = cv.z.mul(hC.y.mul(0.6).add(0.7)).mul(fade);
    // colour: patch tint, per-blade variation; flowers carry their head colour (alpha = 1)
    const lush = vec3(0.115, 0.175, 0.04), dry = vec3(0.30, 0.27, 0.10), deep = vec3(0.07, 0.125, 0.03);
    const col0 = mix(lush, deep, nz.a.mul(0.8));
    const col = mix(col0, dry, smoothstep(0.55, 0.85, nz.b).mul(0.65).add(hB.x.mul(0.12))).mul(hA.y.mul(0.4).add(0.8));
    const fc = fract(hC.y.mul(7.0));
    const fcol = select(fc.lessThan(0.45), vec3(0.8, 0.8, 0.75), select(fc.lessThan(0.75), vec3(0.85, 0.62, 0.05), vec3(0.42, 0.2, 0.6)));
    // stored as 0..1 bytes: blade colour x2 (the darks fit); every head colour has some blue
    const packedCol = uintBitsToFloat(packUnorm4x8(vec4(col.mul(2.0), flower.mul(fcol.b))));
    const packedLean = uintBitsToFloat(packUnorm4x8(vec4(hC.sub(0.5).mul(0.5).add(0.5), fcol.r, fcol.g)));
    return { ok, d0: vec4(bxz.x, gy, bxz.y, ht), d1: vec4(hA.x.mul(6.2831853), wd, packedCol, packedLean), dCam };
  };

  // ---- the blade in the vertex stage: base, shape and colour in; wind, pushers and tracks applied here
  const vCol = varyingProperty('vec3', 'vGCol'), vN = varyingProperty('vec3', 'vGN'), vFace = varyingProperty('vec3', 'vGFace'), vAO = varyingProperty('float', 'vGAO');
  const aBlade = attribute('aBlade', 'vec3');
  const placeBlade = (d0, d1) => {
    const bxz = d0.xz, gy = d0.y;
    const ang = d1.x, wd = d1.y;
    const pc = unpackUnorm4x8(floatBitsToUint(d1.z)), pl = unpackUnorm4x8(floatBitsToUint(d1.w));
    const col = pc.rgb.mul(0.5);
    const facing = vec2(cos(ang), sin(ang));
    // tyre tracks flatten the grass
    const track = tTrack.sample(bxz.sub(shared.uTrackP.xy).div(shared.uTrackP.z).add(0.5)).level(0).r;
    const ht = d0.w.mul(float(1).sub(track.mul(0.75))).toVar();
    // bend: natural lean + travelling wind gusts + pushed by the wheels
    const W = shared.uWind;
    const bend = pl.xy.sub(0.5).toVar();
    const t = W.w;
    const ph = dot(bxz, W.xy).mul(0.09).sub(t.mul(1.3));
    const gust = sin(ph).mul(sin(ph.mul(0.37).add(bxz.x.mul(0.05)).add(1.7))).mul(0.45).add(0.55);
    const sway = sin(t.mul(float(1.6).add(fract(ang.mul(0.159)))).add(bxz.x.mul(0.35)).add(bxz.y.mul(0.2))).mul(0.12);
    bend.addAssign(W.xy.mul(W.z).mul(gust.mul(0.7).sub(0.1).add(sway)));
    const squash = float(1).toVar();
    Loop(5, ({ i }) => {
      const P = shared.uPush.element(i);
      const dv = bxz.sub(P.xz);
      const pd = length(dv);
      const f = float(1).sub(smoothstep(P.w.mul(0.4), P.w, pd)).mul(step(abs(gy.sub(P.y)), 1.5));
      bend.addAssign(dv.div(max(pd, 1e-3)).mul(f).mul(1.4));
      squash.mulAssign(float(1).sub(f.mul(0.6)));
    });
    ht.mulAssign(squash);
    const bl = length(bend);
    bend.mulAssign(select(bl.greaterThan(1.4), float(1.4).div(bl), float(1)));
    const tb = aBlade.y;
    const side = vec3(facing.y.negate(), 0.0, facing.x);
    const pos = vec3(bxz.x, gy.sub(0.02), bxz.y)
      .add(side.mul(aBlade.x.mul(wd).mul(0.5).mul(float(1).sub(tb.mul(0.85)))))
      .add(vec3(bend.x, 0.0, bend.y).mul(ht).mul(tb).mul(tb).mul(0.7))
      .add(vec3(0.0, ht.mul(tb).mul(float(1).sub(min(dot(bend, bend), 1.0).mul(0.25))), 0.0));
    // lighting normal: mostly up (reads like a lawn) for both faces; the blade's own facing is added in the
    // fragment stage, turned towards the sun
    vN.assign(normalize(vec3(bend.x, 0.0, bend.y).mul(0.3).add(side.mul(sign(aBlade.x.add(0.001)).mul(0.25))).add(vec3(0.0, 1.0, 0.0))));
    vFace.assign(vec3(facing.x, 0.0, facing.y).mul(0.45));
    const c2 = mix(col.mul(0.72), col.mul(tb.mul(0.2).add(1.08)), tb);
    const head = pc.a.greaterThan(0.0).and(tb.greaterThan(0.75));
    vCol.assign(select(head, vec3(pl.z, pl.w, pc.a), c2));
    vAO.assign(mix(0.6, 1.0, tb));
    return pos;
  };

  const makeMaterial = (positionNode) => {
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    mat.positionNode = positionNode;
    // the hot spot: with the sun at the viewer's back every blade shows its sunlit side and hides its shadow,
    // so a meadow is at its brightest; against the sun the specular sheen lights it instead
    const opp = dot(normalize(cameraPosition.sub(positionWorld)), shared.uSun);
    mat.colorNode = vCol.mul(smoothstep(-0.1, 0.75, opp).mul(0.35).add(1.0));
    mat.aoNode = vAO;
    // thin, translucent blades: whichever face we see is lit like the face towards the sun (lit by its own
    // face's sign, grass with the sun behind it went dark olive)
    const gSide = select(dot(vFace, shared.uSun).lessThan(0.0), float(-1), float(1));
    mat.normalNode = cameraViewMatrix.mul(vec4(normalize(vN.add(vFace.mul(gSide))), 0.0)).xyz;
    return mat;
  };

  // ---- tile layout (configure) and the CPU tile walk (update), shared by both paths
  const lay = { s: 0.1, n: 8, k: 256, tile: 25.6, h: 4, T: 9, R: 100, share: new Float32Array(CURVE_N + 1).fill(1) };
  // the largest share of the grid any distance in [d0, d1] draws (a tile draws that many instances)
  const maxShare = (d0, d1) => {
    const sh = lay.share, u = d => Math.sqrt(Math.min(d, CURVE_MAX) / CURVE_MAX) * CURVE_N;
    const at = d => { const x = u(d), i = Math.min(Math.floor(x), CURVE_N - 1); return sh[i] + (sh[i + 1] - sh[i]) * (x - i); };
    let m = Math.max(at(d0), at(d1));
    for (let i = Math.ceil(u(d0)); i <= Math.min(CURVE_N, Math.floor(u(d1))); i++) m = Math.max(m, sh[i]);
    return m;
  };

  // ======================================================================== WebGPU: compute-culled
  const buckets = [];
  let cull = null, tab = null;
  const planes = uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4');
  const uTiles = uniform(0, 'uint');   // rows in the tile table
  if (gpu) {
    const DrawArgs = struct({ indexCount: 'uint', instanceCount: { type: 'uint', atomic: true }, firstIndex: 'uint', baseVertex: 'uint', firstInstance: 'uint' }, 'GrassDraw');
    const mkBucket = (segments, cap) => {
      const geo = bladeGeometry(segments);
      const args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 5);
      args.array[0] = geo.index.count;
      geo.setIndirect(args);
      const draw = storage(args, DrawArgs, 1);
      // two vec4 per blade in one buffer (a compute stage may have as few as 8 storage buffers)
      const data = instancedArray(cap * 2, 'vec4');
      const posNode = Fn(() => placeBlade(data.element(instanceIndex.mul(2)), data.element(instanceIndex.mul(2).add(1))))();
      const mesh = new THREE.Mesh(geo, makeMaterial(posNode));
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      return { mesh, geo, args, draw, data, cap, segments };
    };
    // capacities (Ultra on the meadow draws ~2k / 4k / 200k): a full bucket just drops the extra blades for that frame
    const CAP_CLOSE = 100000, CAP_NEAR = 200000, CAP_FAR = 1500000;
    buckets.push(mkBucket(4, CAP_CLOSE), mkBucket(2, CAP_NEAR), mkBucket(1, CAP_FAR));
    const [bClose, bNear, bFar] = buckets;
    // visible tiles: tile x, tile z (from the base cell, in tiles), first thread, instances
    tab = instancedArray(MAX_TILES, 'uvec4');
    const reset = Fn(() => {
      for (const b of buckets) atomicStore(b.draw.get('instanceCount'), uint(0));
    })().compute(1);
    const visible = (d0) => {
      // sphere around the blade vs the six frustum planes
      const c = vec3(d0.x, d0.y.add(d0.w.mul(0.5)), d0.z), r = d0.w.mul(0.6).add(0.3);
      const inside = float(1).toVar();
      Loop(6, ({ i }) => {
        const P = planes.element(i);
        inside.mulAssign(step(r.negate(), dot(P.xyz, c).add(P.w)));
      });
      return inside.greaterThan(0.5);
    };
    const cullNode = Fn(() => {
      // which tile: the last row whose first thread is at or before this one (binary search)
      const i = instanceIndex;
      const lo = uint(0).toVar(), hi = uTiles.sub(1).toVar();
      Loop(Math.ceil(Math.log2(MAX_TILES)), () => {
        const mid = lo.add(hi).add(1).shiftRight(uint(1));
        If(tab.element(mid).z.lessThanEqual(i), () => { lo.assign(mid); }).Else(() => { hi.assign(mid.sub(1)); });
      });
      const row = tab.element(lo);
      const B = bladeOf(vec2(float(row.x), float(row.y)), i.sub(row.z));
      If(B.ok.not(), () => { Return(); });
      If(visible(B.d0).not(), () => { Return(); });
      // pinned here: an expression first used inside one bucket's branch is declared in that branch only
      const d0 = B.d0.toVar(), d1 = B.d1.toVar();
      const put = (b) => {
        const slot = atomicAdd(b.draw.get('instanceCount'), uint(1));
        If(slot.lessThan(uint(b.cap)), () => {
          b.data.element(slot.mul(2)).assign(d0);
          b.data.element(slot.mul(2).add(1)).assign(d1);
        });
      };
      If(B.dCam.lessThan(CLOSE), () => put(bClose))
        .ElseIf(B.dCam.lessThan(NEAR), () => put(bNear))
        .Else(() => put(bFar));
    })().compute(1, [64]);
    const clampArgs = Fn(() => {
      for (const b of buckets) {
        const c = atomicLoad(b.draw.get('instanceCount'));
        atomicStore(b.draw.get('instanceCount'), min(c, uint(b.cap)));
      }
    })().compute(1);
    cull = { reset, cull: cullNode, clampArgs };
  }

  // ======================================================================== WebGL 2 fallback: instanced tiles
  // a pool of meshes, each with a 2-segment and a 1-segment geometry (near / far tiles); the tile index rides
  // in the mesh position
  const tiles = [];
  let ensureTiles = () => {};
  if (!gpu) {
    const posNode = Fn(() => {
      const tile = modelWorldMatrix.element(3).xz;
      const B = bladeOf(tile, uint(instanceIndex));
      const d0 = vec4(B.d0.xyz, select(B.ok, B.d0.w, float(0)));
      const p = placeBlade(d0, B.d1);
      // a world position: undo the mesh's offset (the tile index)
      return select(B.ok, p.sub(vec3(tile.x, 0.0, tile.y)), vec3(0.0, -1e4, 0.0));
    })();
    const mat = makeMaterial(posNode);
    const geoNear = bladeGeometry(2), geoFar = bladeGeometry(1);
    const makeGeo = base => {
      const g = new THREE.InstancedBufferGeometry();
      for (const a of ['aBlade', 'position', 'normal']) g.setAttribute(a, base.getAttribute(a));
      g.setIndex(base.getIndex());
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      return g;
    };
    ensureTiles = (T) => {
      for (let i = tiles.length; i < T * T; i++) {
        const m = new THREE.Mesh(makeGeo(geoNear), mat);
        m.userData.geos = [m.geometry, makeGeo(geoFar)];
        m.frustumCulled = false; m.receiveShadow = true; m.castShadow = false;
        m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false;
        group.add(m);
        tiles.push(m);
      }
      tiles.forEach((m, i) => {
        m.userData.tile = i < T * T ? [i % T, Math.floor(i / T)] : null;
        if (m.userData.tile) { m.position.set(m.userData.tile[0], 0, m.userData.tile[1]); m.updateMatrix(); m.matrixWorld.copy(m.matrix); }
        m.visible = false;
      });
    };
  }

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let time = 0, enabled = true;
  const api = {
    group, shared, buckets, gpu, lay,
    get cull() { return cull; },
    sent: 0,   // instances (compute threads or vertex-stage instances) last frame
    configure(q) {
      // q.grassCurve: the curves of the Grass and bushes level
      const c = q.grassCurve;
      if (!c) { enabled = group.visible = false; return; }
      const R = Math.min(CURVE_MAX, Math.max(10, c.end));
      const dens = d => Math.max(0, evalCurve(c.density, Math.min(d, R), c.smooth, true, c.lin));
      // the grid is as fine as the densest point of the curve; elsewhere a share of it is drawn
      let dMax = 0;
      for (let i = 0; i <= CURVE_N; i++) if (curveD(i) <= R) dMax = Math.max(dMax, dens(curveD(i)));
      enabled = q.vegetation !== false && dMax > 0.01;
      group.visible = enabled;
      if (!enabled) return;
      const s = 1 / Math.sqrt(dMax);   // m between blades at the densest point
      const n = Math.max(4, Math.min(9, Math.floor(Math.log2(32 / s)))), k = 2 ** n;
      const tile = k * s, h = Math.ceil(R / tile), T = 2 * h + 1;
      const share = new Float32Array(CURVE_N + 1);
      U.uCurve.array.forEach((v, i) => {
        const d = Math.min(curveD(i), R);
        share[i] = Math.min(1, dens(d) / dMax);
        v.set(share[i], Math.max(0, evalCurve(c.height, d, c.smooth, true, c.lin)) / 100, Math.max(0, evalCurve(c.width, d, c.smooth, true, c.lin)) / 100, 0);
      });
      Object.assign(lay, { s, n, k, tile, h, T, R, share });
      ensureTiles(T);
      U.uGrid.value.z = s;
      U.uLod.value.set(n, k, R, 0.035);
      U.uRad.value.set(R * 0.85, R);
    },
    update(dt, camera) {
      time += dt;
      shared.uWind.value.w = time;   // shared with the trees and the undergrowth: runs with the grass off too
      shared.uCam.value.copy(camera.position);
      const sun = opts.sun;
      if (sun) shared.uSun.value.copy(sun.position).sub(sun.target.position).normalize();
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv, camera.coordinateSystem, camera.reversedDepth);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      const { k, tile, h, T, R } = lay;
      // tile (0, 0) of the T x T block around the camera's tile; tiles are world-aligned
      const ti = Math.floor(cx / tile) - h, tj = Math.floor(cz / tile) - h;
      U.uGrid.value.x = ti * k; U.uGrid.value.y = tj * k;
      const rows = tab?.value.array;
      let sent = 0, nt = 0;
      for (let b = 0; b < T; b++) for (let a = 0; a < T; a++) {
        const m = gpu ? null : tiles[b * T + a];
        if (m) m.visible = false;
        const x0 = (ti + a) * tile, z0 = (tj + b) * tile, x1 = x0 + tile, z1 = z0 + tile;
        const d = Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(z0 - cz, 0, cz - z1));
        if (d > R || Math.abs(x0) > HALF + 2 && Math.abs(x1) > HALF + 2 || Math.abs(z0) > HALF + 2 && Math.abs(z1) > HALF + 2) continue;
        box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
        if (!frustum.intersectsBox(box)) continue;
        // draw the largest share any point of the tile needs; the shader drops what each blade's own distance doesn't
        const dFar = Math.hypot(Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx)), Math.max(Math.abs(z0 - cz), Math.abs(z1 - cz)));
        const count = Math.min(k * k, Math.ceil(k * k * Math.min(1, maxShare(d, Math.min(dFar, R)) * 1.35)) + 4);
        if (gpu) {
          if (nt === MAX_TILES) continue;
          rows.set([a, b, sent, count], nt * 4);
          nt++;
        } else {
          const g = m.userData.geos[d < SEG_NEAR ? 0 : 1];
          m.geometry = g;
          g.instanceCount = count;
          m.visible = true;
        }
        sent += count;
      }
      api.sent = sent;
      if (!gpu) return;
      frustum.planes.forEach((p, i) => planes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
      renderer.compute(cull.reset);
      if (sent > 0) {
        tab.value.needsUpdate = true;
        uTiles.value = nt;
        // the node's count is also the shader's bounds check (three adds `if (index >= count) return`)
        cull.cull.count = sent;
        renderer.compute(cull.cull);
      }
      renderer.compute(cull.clampArgs);
    },
    // wheels push the grass aside (world positions, radius in m)
    setPushers(list) {
      const P = shared.uPush.array;
      for (let i = 0; i < 5; i++) { const p = list[i]; if (p) P[i].set(p.x, p.y, p.z, p.r); else P[i].set(0, -1e5, 0, 0); }
    },
    // read back how many blades each bucket drew (tests; async)
    async counts() {
      if (!gpu) return null;
      const out = [];
      for (const b of buckets) { const a = await renderer.getArrayBufferAsync(b.args); out.push(new Uint32Array(a)[1]); }
      return out;
    },
  };
  return api;
}
