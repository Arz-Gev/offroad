import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, uniform, uniformArray, attribute, texture, storage, instancedArray, instanceIndex, atomicAdd, atomicStore, atomicLoad,
  vec2, vec3, vec4, float, int, uint, ivec2, uvec2, struct, varyingProperty, positionWorld, cameraPosition, cameraViewMatrix, modelWorldMatrix,
  faceDirection, mix, clamp, smoothstep, step, max, min, abs, sqrt, sin, cos, fract, floor, dot, length, normalize, distance, sign,
  packUnorm4x8, unpackUnorm4x8, floatBitsToUint, uintBitsToFloat, select, Loop,
} from 'three/tsl';
import { MAP_SIZE } from './terrain.js';

// GPU grass. Blades live on a camera-centred grid of world cells, one candidate blade per cell; every world
// cell always gets the same blade (hashed from the cell index), so blades never swim as the grid follows
// the camera. Two grids: dense short-range blades and a sparser, wider layer further out (cross-faded).
// Density comes from the terrain's ground-data map (no grass on trails, rock, mud, sand or under dense
// canopy); heights from the physics heightfield with the same triangle split, so blades stand exactly on
// the ground. Wind (travelling gusts), the truck's wheels push blades aside, tyre tracks flatten them, and
// a few blades are wild flowers.
//
// WebGPU: a compute pass per frame walks every cell of both grids and keeps only the blades that exist, are
// in the view frustum and inside their fade radius. Survivors are appended (atomics) to one of three LOD
// buckets, each drawn with a single indirect draw:
//   close  (< CLOSE m): 4-segment blades that bend smoothly
//   near   (rest of the near grid): 2 segments
//   far    (far grid): 1 triangle
// Empty cells (forest floor, trails, rock) and everything behind the camera cost one compute thread, not a
// blade's worth of vertex work. Before this (and still on the WebGL 2 fallback) every cell of the grid ran
// the vertex shader, culled or not: the grass was vertex bound (~2.5 ms per million blade vertices on an
// M1 Pro) and most of those vertices were thrown away.

const HALF = MAP_SIZE / 2;
const TILES = 8;          // WebGL fallback: tiles per grid side (CPU frustum culled)
const CLOSE = 14;         // m: the 4-segment bucket

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

export function buildGrass(terrainView, renderer) {
  const caps = renderer?.caps || {};
  const gpu = !!caps.compute;
  const TU = terrainView.uniforms;
  const tH = texture(terrainView.heightTex), tData = texture(terrainView.dataTex), tNoise = texture(terrainView.noiseTex), tTrack = texture(terrainView.trackTex);
  const shared = {
    uWind: uniform(new THREE.Vector4(0.8, 0.6, 1, 0)),
    uPush: uniformArray(Array.from({ length: 5 }, () => new THREE.Vector4(0, -1e5, 0, 0)), 'vec4'),
    uTrackP: uniform(new THREE.Vector4(0, 0, MAP_SIZE, 0)),
    uCam: uniform(new THREE.Vector3()),   // the view camera (compute passes have no camera of their own)
  };
  const uMap = TU.uMap;
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

  // ---- per-layer grid: (base cell x, base cell z, spacing, cells per side), radii, blade shape
  const makeLayer = (name, spacing, radius, fadeIn, shape) => ({
    name, spacing, baseSpacing: spacing, baseWidth: shape[1], baseHeight: shape[0], radius, n: 0,
    uGrid: uniform(new THREE.Vector4(0, 0, spacing, 1)),
    uRad: uniform(new THREE.Vector4(radius * 0.72, radius, fadeIn[0], fadeIn[1])),
    uShape: uniform(new THREE.Vector4(...shape)),
  });
  const layers = [
    makeLayer('near', 0.1, 17, [-1, 0], [0.34, 0.065, 1.0, 0.0]),
    makeLayer('far', 0.24, 52, [10, 14.5], [0.32, 0.14, 1.0, 0.035]),
  ];

  // One cell -> its blade, or nothing. Returns vec4(x, ground y, z, height) and vec4(yaw, width, packed
  // colour, packed lean); height 0 = no blade. Used by the compute pass and by the fallback's vertex stage.
  const bladeOf = (L, cellIdx) => {
    const hA = gHash22(cellIdx), hB = gHash22(cellIdx.add(17.17)), hC = gHash22(cellIdx.add(41.3));
    const bxz = cellIdx.add(hA).mul(L.uGrid.z);
    const dCam = distance(bxz, shared.uCam.xz);
    const fade = float(1).sub(smoothstep(L.uRad.x, L.uRad.y, dCam)).mul(smoothstep(L.uRad.z, L.uRad.w, dCam));
    // density (precomputed: grass surfaces, slope, clearings, canopy)
    const dens = tData.sample(bxz.add(uMap.x).add(0.5).div(uMap.w.add(1.0))).level(0).a.mul(L.uShape.z);
    const inMap = max(abs(bxz.x), abs(bxz.y)).lessThan(uMap.x.sub(1.0));
    const ok = hB.x.lessThan(dens).and(fade.greaterThan(0.0)).and(inMap);
    const nz = tNoise.sample(bxz.div(61.0)).level(0);
    const gy = groundAt(bxz);
    const tall = nz.g.mul(nz.g).mul(0.95).add(0.45);
    const flower = step(hC.x, L.uShape.w).mul(step(0.5, nz.b.add(0.2)));
    const ht = L.uShape.x.mul(tall).mul(hB.y.mul(0.7).add(0.6)).mul(fade.mul(0.75).add(0.25)).mul(mix(1.0, 0.8, flower));
    const wd = L.uShape.y.mul(hC.y.mul(0.6).add(0.7)).mul(fade);
    // colour: patch tint, per-blade variation; flowers carry their head colour (alpha = 1)
    const lush = vec3(0.115, 0.175, 0.04), dry = vec3(0.30, 0.27, 0.10), deep = vec3(0.07, 0.125, 0.03);
    const col0 = mix(lush, deep, nz.a.mul(0.8));
    const col = mix(col0, dry, smoothstep(0.55, 0.85, nz.b).mul(0.65).add(hB.x.mul(0.12))).mul(hA.y.mul(0.4).add(0.8));
    const fc = fract(hC.y.mul(7.0));
    const fcol = select(fc.lessThan(0.45), vec3(0.8, 0.8, 0.75), select(fc.lessThan(0.75), vec3(0.85, 0.62, 0.05), vec3(0.42, 0.2, 0.6)));
    // stored as 0..1 bytes: blade colour x2 (the darks fit), flower head in the lean word's high bytes
    const packedCol = uintBitsToFloat(packUnorm4x8(vec4(col.mul(2.0), flower)));
    const packedLean = uintBitsToFloat(packUnorm4x8(vec4(hC.sub(0.5).mul(0.5).add(0.5), fcol.r, fcol.g)));
    return { ok, d0: vec4(bxz.x, gy, bxz.y, ht), d1: vec4(hA.x.mul(6.2831853), wd, packedCol, packedLean), fcolB: fcol.b, dCam };
  };

  // ---- the blade in the vertex stage: base, shape and colour in; wind, pushers and tracks applied here
  const vCol = varyingProperty('vec3', 'vGCol'), vN = varyingProperty('vec3', 'vGN'), vFace = varyingProperty('vec3', 'vGFace'), vAO = varyingProperty('float', 'vGAO');
  const aBlade = attribute('aBlade', 'vec3');
  const placeBlade = (d0, d1, flowerB) => {
    const bxz = d0.xz, gy = d0.y;
    const ang = d1.x, wd = d1.y;
    const pc = unpackUnorm4x8(floatBitsToUint(d1.z)), pl = unpackUnorm4x8(floatBitsToUint(d1.w));
    const col = pc.rgb.mul(0.5), flower = pc.a;
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
    // fragment stage with the face's sign
    vN.assign(normalize(vec3(bend.x, 0.0, bend.y).mul(0.3).add(side.mul(sign(aBlade.x.add(0.001)).mul(0.25))).add(vec3(0.0, 1.0, 0.0))));
    vFace.assign(vec3(facing.x, 0.0, facing.y).mul(0.45));
    const c2 = mix(col.mul(0.72), col.mul(tb.mul(0.2).add(1.08)), tb);
    const head = flower.greaterThan(0.5).and(tb.greaterThan(0.75));
    vCol.assign(select(head, vec3(pl.z, pl.w, flowerB), c2));
    vAO.assign(mix(0.6, 1.0, tb));
    return pos;
  };

  const makeMaterial = (positionNode) => {
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    mat.positionNode = positionNode;
    mat.colorNode = vCol;
    mat.aoNode = vAO;
    mat.normalNode = cameraViewMatrix.mul(vec4(normalize(vN.add(vFace.mul(faceDirection))), 0.0)).xyz;
    return mat;
  };

  // ======================================================================== WebGPU: compute-culled
  const buckets = [];
  let cull = null;
  const planes = uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4');
  const uCaps = uniform(new THREE.Vector4(1, 1, 1, 0));   // capacity of each bucket
  if (gpu) {
    const DrawArgs = struct({ indexCount: 'uint', instanceCount: { type: 'uint', atomic: true }, firstIndex: 'uint', baseVertex: 'uint', firstInstance: 'uint' }, 'GrassDraw');
    const mkBucket = (segments, cap) => {
      const geo = bladeGeometry(segments);
      const args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 5);
      args.array[0] = geo.index.count;
      geo.setIndirect(args);
      const draw = storage(args, DrawArgs, 1);
      const d0 = instancedArray(cap, 'vec4'), d1 = instancedArray(cap, 'vec4'), d2 = instancedArray(cap, 'float');
      const posNode = Fn(() => placeBlade(d0.element(instanceIndex), d1.element(instanceIndex), d2.element(instanceIndex)))();
      const mesh = new THREE.Mesh(geo, makeMaterial(posNode));
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      return { mesh, geo, args, draw, d0, d1, d2, cap, segments };
    };
    // capacities: worst case a third of the grid visible (looking down from above sees a full disc, but
    // the fade and density thin it); a full bucket just drops the extra blades for that frame
    const CAP_CLOSE = 400000, CAP_NEAR = 1200000, CAP_FAR = 1400000;
    buckets.push(mkBucket(4, CAP_CLOSE), mkBucket(2, CAP_NEAR), mkBucket(1, CAP_FAR));
    const [bClose, bNear, bFar] = buckets;
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
    const cullLayer = (L, near) => Fn(() => {
      const n = uint(L.uGrid.w);
      const i = instanceIndex;
      const cellIdx = L.uGrid.xy.add(vec2(float(i.mod(n)), float(i.div(n))));
      const B = bladeOf(L, cellIdx);
      If(B.ok.not(), () => { Return(); });
      If(visible(B.d0).not(), () => { Return(); });
      const put = (b, cap) => {
        const slot = atomicAdd(b.draw.get('instanceCount'), uint(1));
        If(slot.lessThan(uint(cap)), () => {
          b.d0.element(slot).assign(B.d0);
          b.d1.element(slot).assign(B.d1);
          b.d2.element(slot).assign(B.fcolB);
        });
      };
      if (near) {
        If(B.dCam.lessThan(CLOSE), () => put(bClose, bClose.cap)).Else(() => put(bNear, bNear.cap));
      } else put(bFar, bFar.cap);
    })().compute(1, [64]);
    const clampArgs = Fn(() => {
      for (const b of buckets) {
        const c = atomicLoad(b.draw.get('instanceCount'));
        atomicStore(b.draw.get('instanceCount'), min(c, uint(b.cap)));
      }
    })().compute(1);
    cull = { reset, near: cullLayer(layers[0], true), far: cullLayer(layers[1], false), clampArgs };
  }

  // ======================================================================== WebGL 2 fallback: vertex-culled tiles
  const tiles = [];
  if (!gpu) {
    for (const [li, L] of layers.entries()) {
      const geo = bladeGeometry(li === 0 ? 2 : 1);
      const posNode = Fn(() => {
        // the tile index rides in the mesh position
        const tile = modelWorldMatrix.element(3).xz;
        const k = L.uGrid.w;
        const gid = float(instanceIndex);
        const cellIdx = L.uGrid.xy.add(tile.mul(k)).add(vec2(gid.mod(k), floor(gid.div(k))));
        const B = bladeOf(L, cellIdx);
        const d0 = vec4(B.d0.xyz, select(B.ok, B.d0.w, float(0)));
        const p = placeBlade(d0, B.d1, B.fcolB);
        return select(B.ok, p, vec3(0.0, -1e4, 0.0));
      })();
      const mat = makeMaterial(posNode);
      for (let tx = 0; tx < TILES; tx++) for (let tz = 0; tz < TILES; tz++) {
        const g = new THREE.InstancedBufferGeometry();
        for (const a of ['aBlade', 'position', 'normal']) g.setAttribute(a, geo.getAttribute(a));
        g.setIndex(geo.getIndex());
        g.instanceCount = 1;
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        const m = new THREE.Mesh(g, mat);
        m.frustumCulled = false; m.receiveShadow = true; m.castShadow = false;
        m.userData.tile = [tx, tz]; m.userData.layer = L;
        m.position.set(tx, 0, tz); m.updateMatrix(); m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; m.matrixWorld.copy(m.matrix);
        group.add(m);
        tiles.push(m);
      }
    }
  }

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let time = 0, enabled = true;
  const api = {
    group, layers, shared, buckets, gpu, get cull() { return cull; },
    get bladeCounts() { return null; },
    configure(q) {
      enabled = q.vegetation !== false && q.grass > 0;
      group.visible = enabled;
      const scale = q.grass;
      const r = q.grassRadius || 48;
      const near = layers[0], far = layers[1];
      // density is the cell spacing (1 = a blade in every cell, above 1 closer together, below 1 further apart)
      const dens = Math.max(scale, 0.01), fine = 1 / Math.sqrt(dens);
      const fineFar = 1 / Math.sqrt(scale <= 1 ? Math.max(scale * 1.1, 0.01) : scale);
      const rn = q.grassNear > 0 ? Math.min(q.grassNear, r) : Math.min(17 + Math.max(0, r - 46) * 0.12, r * 0.34);
      far.uRad.value.set(r * 0.72, r, rn * 0.66, rn * 0.97);
      near.uRad.value.set(rn * 0.7, rn, -1, 0);
      const coarse = Math.max(1, r / 52) ** (q.grassFarGrow ?? 1);
      const hs = q.grassHeight ?? 1.5, ws = q.grassWidth ?? 1;
      const fw = q.grassFarWidth ?? 1, fsp = q.grassFarSpacing ?? 1;
      for (const [L, R, mul, wmul] of [[near, rn, fine, 1], [far, r, fineFar * coarse * fsp, coarse * fw]]) {
        L.spacing = L.baseSpacing * mul;
        L.radius = R;
        // compute: one grid of n x n cells; fallback: TILES x TILES tiles of k x k cells
        L.n = gpu ? Math.ceil(R * 2 / L.spacing) : Math.ceil(R * 2 / L.spacing / TILES) * TILES;
        L.uGrid.value.z = L.spacing;
        L.uGrid.value.w = gpu ? L.n : L.n / TILES;
        L.uShape.value.x = L.baseHeight * hs;
        L.uShape.value.y = L.baseWidth * ws * wmul;
      }
      for (const m of tiles) { const L = m.userData.layer, k = L.n / TILES; m.geometry.instanceCount = k * k; }
    },
    update(dt, camera) {
      time += dt;
      shared.uWind.value.w = time;   // shared with the trees and the undergrowth: runs with the grass off too
      shared.uCam.value.copy(camera.position);
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv, camera.coordinateSystem, camera.reversedDepth);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      for (const L of layers) {
        const s = L.spacing, n = L.n;
        if (gpu) {
          L.uGrid.value.x = Math.floor(cx / s - n / 2); L.uGrid.value.y = Math.floor(cz / s - n / 2);
        } else {
          // base cell snapped to whole tiles so a tile never straddles the snap
          const k = n / TILES;
          L.uGrid.value.x = Math.floor((cx / s - n / 2) / k) * k; L.uGrid.value.y = Math.floor((cz / s - n / 2) / k) * k;
        }
      }
      if (gpu) {
        frustum.planes.forEach((p, i) => planes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
        renderer.compute(cull.reset);
        // the node's count is also the shader's bounds check (three adds `if (index >= count) return`)
        cull.near.count = layers[0].n * layers[0].n;
        cull.far.count = layers[1].n * layers[1].n;
        renderer.compute(cull.near);
        renderer.compute(cull.far);
        renderer.compute(cull.clampArgs);
        return;
      }
      for (const m of tiles) {
        const L = m.userData.layer, s = L.spacing, k = L.n / TILES, R = L.uRad.value.y;
        const [tx, tz] = m.userData.tile;
        const x0 = (L.uGrid.value.x + tx * k) * s, z0 = (L.uGrid.value.y + tz * k) * s, x1 = x0 + k * s, z1 = z0 + k * s;
        const ddx = Math.max(x0 - cx, 0, cx - x1), ddz = Math.max(z0 - cz, 0, cz - z1);
        if (Math.hypot(ddx, ddz) > R || Math.abs(x0) > HALF + 2 && Math.abs(x1) > HALF + 2 || Math.abs(z0) > HALF + 2 && Math.abs(z1) > HALF + 2) { m.visible = false; continue; }
        box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
        m.visible = frustum.intersectsBox(box);
      }
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
