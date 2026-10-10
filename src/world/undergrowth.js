import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, Loop, uniform, uniformArray, attribute, texture, storage, instancedArray, instanceIndex, atomicAdd, atomicStore,
  atomicLoad, struct, varyingProperty, vec2, vec3, vec4, float, int, uint, ivec2, positionGeometry, normalGeometry, cameraViewMatrix,
  modelWorldMatrix, uv, mix, clamp, smoothstep, step, max, min, abs, sin, cos, fract, floor, dot, length, distance, normalize, select,
} from 'three/tsl';
import { MAP_SIZE } from './terrain.js';
import { buildPlant } from './foliage.js';
import { FoliageMaterial } from '../render/foliage.js';

// Undergrowth: ferns, shrubs, meadow flowers and grass tufts, placed on the GPU like the grass (grass.js): one plant per
// cell at most, position / size / yaw hashed from the cell. Density from the ground-data map (forest floor, grass density,
// wetness) and surface splat (none on trails, rock, sand, mud). Plants shrink to nothing at their radius edge instead
// of popping. Alpha-tested foliage-atlas cards in the shared wind, lit through the leaves (render/foliage.js).
// WebGPU: a compute pass per kind keeps the plants that exist and are in view, one indirect draw each. WebGL 2
// fallback: vertex-placed tiles.

const HALF = MAP_SIZE / 2;
const TILES = 6;

const uHash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

export function buildUndergrowth(terrainView, atlas, windUniform, renderer, uCam) {
  const gpu = !!renderer?.caps?.compute;
  const TU = terrainView.uniforms, uMap = TU.uMap;
  const tH = texture(terrainView.heightTex), tData = texture(terrainView.dataTex), tSplat = texture(terrainView.splat), tNoise = texture(terrainView.noiseTex);
  const group = new THREE.Group();
  group.name = 'undergrowth';

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

  const planes = uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4');
  const DrawArgs = gpu ? struct({ indexCount: 'uint', instanceCount: { type: 'uint', atomic: true }, firstIndex: 'uint', baseVertex: 'uint', firstInstance: 'uint' }, 'PlantDraw') : null;

  const makeKind = (name, geoBase, spacing, radius, shape, kind, translucency) => {
    const K = {
      name, spacing, baseSpacing: spacing, radius, baseRadius: radius, baseScale: [shape[0], shape[1]], n: 0,
      uGrid: uniform(new THREE.Vector4(0, 0, spacing, 1)),
      uRad: uniform(new THREE.Vector4(radius * 0.7, radius, 0, 0)),
      uShape: uniform(new THREE.Vector4(...shape)),
      uKind: uniform(new THREE.Vector4(...kind)),
      tiles: [],
    };
    // one cell -> a plant: vec4(x, ground y, z, scale) and its yaw; scale 0 = none
    const plantOf = (cellIdx) => {
      const hA = uHash22(cellIdx.add(K.uShape.w)), hB = uHash22(cellIdx.add(K.uShape.w).add(17.17));
      const pxz = cellIdx.add(hA).mul(K.uGrid.z);
      const dCam = distance(pxz, uCam.xz);
      const shrink = float(1).sub(smoothstep(K.uRad.x, K.uRad.y, dCam));
      const gd = tData.sample(pxz.add(uMap.x).add(0.5).div(uMap.w.add(1.0))).level(0);
      const sp = tSplat.sample(pxz.add(uMap.x).div(uMap.y).add(0.5).div(uMap.z)).level(0);
      const nz = tNoise.sample(pxz.div(53.0)).level(0);
      const bare = clamp(float(1).sub(sp.r.add(sp.g).add(sp.b).add(sp.a).mul(2.5)), 0.0, 1.0).mul(float(1).sub(smoothstep(0.3, 0.6, gd.b)));
      const forest = smoothstep(0.25, 0.75, gd.g);
      const meadow = gd.a.mul(float(1).sub(forest));
      const Kw = K.uKind;
      const dens = Kw.x.mul(forest).mul(smoothstep(0.3, 0.55, nz.r.add(0.15)))
        .add(Kw.y.mul(meadow).mul(smoothstep(0.5, 0.7, nz.b)))
        .add(Kw.z.mul(forest.mul(0.6).add(meadow.mul(0.25))).mul(smoothstep(0.35, 0.6, nz.g)))
        .add(Kw.w.mul(meadow).mul(smoothstep(0.45, 0.6, nz.a)))
        .mul(bare).mul(K.uShape.z);
      const inMap = max(abs(pxz.x), abs(pxz.y)).lessThan(uMap.x.sub(2.0));
      const ok = hB.x.lessThan(dens).and(shrink.greaterThan(0.0)).and(inMap);
      const sc = mix(K.uShape.x, K.uShape.y, hB.y).mul(shrink.mul(0.85).add(0.15));
      const yaw = hA.x.mul(6.2831853).add(hB.y.mul(3.1));
      return { ok, d0: vec4(pxz.x, groundAt(pxz), pxz.y, sc), yaw };
    };
    // vertex: the plant at its cell, rotated, swaying; the rotated normal goes to the fragment unflipped
    const vN = varyingProperty('vec3', 'vUN');
    const place = (d0, yaw) => {
      const pxz = d0.xz, sc = d0.w;
      const c = cos(yaw), s = sin(yaw);
      const rot = v => vec3(c.mul(v.x).sub(s.mul(v.z)), v.y, s.mul(v.x).add(c.mul(v.z)));
      const lp = rot(positionGeometry.mul(sc)).toVar();
      vN.assign(rot(normalGeometry));
      const W = windUniform, t = W.w, aWind = attribute('aWind', 'float');
      const gust = sin(dot(pxz, W.xy).mul(0.09).sub(t.mul(1.3))).mul(0.4).add(0.6);
      const sway = sin(t.mul(fract(yaw.mul(0.37)).add(1.7)).add(pxz.x.mul(0.3)).add(pxz.y.mul(0.2)));
      lp.xz.addAssign(W.xy.mul(W.z).mul(aWind).mul(aWind).mul(sc).mul(gust.mul(0.12).add(sway.mul(0.06))));
      lp.addAssign(vec3(sin(t.mul(4.3).add(dot(lp, vec3(3.1, 2.3, 1.7)))), 0.0, cos(t.mul(3.7).add(dot(lp, vec3(1.9, 2.9, 2.3))))).mul(0.025).mul(aWind).mul(W.z));
      return vec3(pxz.x, d0.y.sub(0.03), pxz.y).add(lp);
    };
    const material = (positionNode) => {
      const mat = new FoliageMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, translucency });
      mat.positionNode = positionNode;
      mat.normalNode = cameraViewMatrix.mul(vec4(normalize(vN), 0.0)).xyz;
      return mat;
    };

    if (gpu) {
      const CAP = 160000;
      const geo = geoBase.clone();
      const args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 5);
      args.array[0] = geo.index.count;
      geo.setIndirect(args);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const draw = storage(args, DrawArgs, 1);
      const d0 = instancedArray(CAP, 'vec4'), d1 = instancedArray(CAP, 'float');
      const mesh = new THREE.Mesh(geo, material(Fn(() => place(d0.element(instanceIndex), d1.element(instanceIndex)))()));
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false;
      group.add(mesh);
      K.mesh = mesh; K.args = args;
      K.reset = Fn(() => { atomicStore(draw.get('instanceCount'), uint(0)); })().compute(1);
      K.cull = Fn(() => {
        const nn = uint(K.uGrid.w), i = instanceIndex;
        const cellIdx = K.uGrid.xy.add(vec2(float(i.mod(nn)), float(i.div(nn))));
        const P = plantOf(cellIdx);
        If(P.ok.not(), () => { Return(); });
        // sphere around the plant (2 m per unit of scale) vs the frustum
        const c = vec3(P.d0.x, P.d0.y.add(P.d0.w), P.d0.z), r = P.d0.w.mul(1.6).add(0.3);
        const inside = float(1).toVar();
        Loop(6, ({ i: k }) => { const pl = planes.element(k); inside.mulAssign(step(r.negate(), dot(pl.xyz, c).add(pl.w))); });
        If(inside.lessThan(0.5), () => { Return(); });
        const slot = atomicAdd(draw.get('instanceCount'), uint(1));
        If(slot.lessThan(uint(CAP)), () => { d0.element(slot).assign(P.d0); d1.element(slot).assign(P.yaw); });
      })().compute(1, [64]);
      K.clamp = Fn(() => { atomicStore(draw.get('instanceCount'), min(atomicLoad(draw.get('instanceCount')), uint(CAP))); })().compute(1);
    } else {
      const mat = material(Fn(() => {
        const tile = modelWorldMatrix.element(3).xz;
        const k = K.uGrid.w;
        const gid = float(instanceIndex);
        const cellIdx = K.uGrid.xy.add(tile.mul(k)).add(vec2(gid.sub(floor(gid.div(k)).mul(k)), floor(gid.div(k))));
        const P = plantOf(cellIdx);
        // a world position: undo the mesh's offset (the tile index)
        return select(P.ok, place(P.d0, P.yaw).sub(vec3(tile.x, 0.0, tile.y)), vec3(0.0, -1e4, 0.0));
      })());
      for (let tx = 0; tx < TILES; tx++) for (let tz = 0; tz < TILES; tz++) {
        const g = new THREE.InstancedBufferGeometry();
        for (const a of ['position', 'normal', 'uv', 'aWind']) g.setAttribute(a, geoBase.getAttribute(a));
        g.setIndex(geoBase.getIndex());
        g.instanceCount = 1;
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        const m = new THREE.Mesh(g, mat);
        m.frustumCulled = false; m.receiveShadow = true; m.castShadow = false;
        m.userData.tile = [tx, tz];
        m.position.set(tx, 0, tz); m.updateMatrix(); m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; m.matrixWorld.copy(m.matrix);
        group.add(m);
        K.tiles.push(m);
      }
    }
    return K;
  };

  //                          geometry                     spacing radius  [min, max scale, density, seed]  [forest, meadow, shrub, edge]  light through
  const kinds = [
    makeKind('fern', buildPlant('fern', 11), 1.6, 44, [0.75, 1.35, 0.8, 3.1], [1, 0, 0, 0], 0.6),
    makeKind('shrub', buildPlant('bush', 12), 3.6, 72, [0.45, 1.13, 0.55, 7.7], [0, 0, 1, 0], 0.45),
    makeKind('flowers', buildPlant('flowers', 13), 1.25, 36, [0.7, 1.15, 0.6, 11.3], [0, 1, 0, 0], 0.7),
    makeKind('tuft', buildPlant('tuft', 14), 1.0, 32, [0.7, 1.4, 0.45, 19.9], [0.25, 0, 0, 1], 0.6),
  ];

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let enabled = true;
  return {
    group, kinds,
    configure(q) {
      // density: closer / further apart cells (the per-kind probability stays), distance and height are multipliers
      const dens = q.bushes ?? 1, dist = q.bushDist ?? 1, hs = q.bushHeight ?? 1;
      enabled = q.vegetation !== false && dens > 0 && dist > 0;
      group.visible = enabled;
      if (!enabled) return;
      for (const K of kinds) {
        const r = K.baseRadius * dist;
        K.radius = r;
        K.spacing = K.baseSpacing / Math.sqrt(dens);
        K.n = gpu ? Math.ceil(r * 2 / K.spacing) : Math.ceil(r * 2 / K.spacing / TILES) * TILES;
        K.uGrid.value.z = K.spacing;
        K.uGrid.value.w = gpu ? K.n : K.n / TILES;
        K.uRad.value.set(r * 0.7, r, 0, 0);
        K.uShape.value.x = K.baseScale[0] * hs;
        K.uShape.value.y = K.baseScale[1] * hs;
        for (const m of K.tiles) m.geometry.instanceCount = (K.n / TILES) ** 2;
      }
    },
    update(dt, camera) {
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv, camera.coordinateSystem, camera.reversedDepth);
      frustum.planes.forEach((p, i) => planes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      for (const K of kinds) {
        const s = K.spacing, n = K.n, R = K.radius;
        if (gpu) {
          K.uGrid.value.x = Math.floor(cx / s - n / 2); K.uGrid.value.y = Math.floor(cz / s - n / 2);
          K.cull.count = n * n;
          renderer.compute(K.reset); renderer.compute(K.cull); renderer.compute(K.clamp);
          continue;
        }
        const k = n / TILES;
        const bx = Math.floor((cx / s - n / 2) / k) * k, bz = Math.floor((cz / s - n / 2) / k) * k;
        K.uGrid.value.x = bx; K.uGrid.value.y = bz;
        for (const m of K.tiles) {
          const [tx, tz] = m.userData.tile;
          const x0 = (bx + tx * k) * s, z0 = (bz + tz * k) * s, x1 = x0 + k * s, z1 = z0 + k * s;
          const ddx = Math.max(x0 - cx, 0, cx - x1), ddz = Math.max(z0 - cz, 0, cz - z1);
          if (Math.hypot(ddx, ddz) > R || (Math.abs(x0) > HALF && Math.abs(x1) > HALF) || (Math.abs(z0) > HALF && Math.abs(z1) > HALF)) { m.visible = false; continue; }
          box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
          m.visible = frustum.intersectsBox(box);
        }
      }
    },
    async counts() {
      if (!gpu) return null;
      const out = {};
      for (const K of kinds) out[K.name] = new Uint32Array(await renderer.getArrayBufferAsync(K.args))[1];
      return out;
    },
  };
}
