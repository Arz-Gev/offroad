import * as THREE from 'three';
import { MAP_SIZE } from './terrain.js';
import { buildPlant } from './foliage.js';
import { NO_FLIP_NORMAL } from './trees.js';

// Undergrowth: ferns under the trees, shrubs, meadow flowers and tall grass tufts, placed on the GPU like
// the grass (grass.js): a camera-centred grid of world cells, one plant per cell at most, the cell's hash
// gives its position, size and yaw, so plants never move as the grid follows the camera. Density comes from
// the terrain's ground-data map (forest floor, grass density, wetness) and surface splat (none on trails,
// rock, sand, mud). Plants shrink to nothing at the edge of their radius instead of popping. Alpha-tested
// cards from the foliage atlas, swaying in the shared wind. No shadow casting (cheap); they receive shadows.

const HALF = MAP_SIZE / 2;
const TILES = 6;

const PARS = /* glsl */`
uniform highp sampler2D tHeight;
uniform sampler2D tSplat, tData, tNoise;
uniform vec4 uMap;      // half, cell, NN, size
uniform vec4 uGrid;     // base cell x, base cell z, spacing, cells per tile
uniform vec4 uRad;      // shrink start, end
uniform vec4 uShape;    // min scale, max scale, density multiplier, seed
uniform vec4 uKind;     // weights: forest, meadow, shrub, edge
uniform vec4 uWind;     // dir x, dir z, strength, time
attribute float aWind;
vec2 uHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float uHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float uGround(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = uHgt(i), h10 = uHgt(i + ivec2(1, 0)), h01 = uHgt(i + ivec2(0, 1)), h11 = uHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
`;

export function buildUndergrowth(terrainView, atlas, windUniform) {
  const U = terrainView.uniforms;
  const group = new THREE.Group();
  group.name = 'undergrowth';
  const shared = { tHeight: U.tHeight, tSplat: U.tSplat, tData: U.tData, tNoise: U.tNoise, uMap: U.uMap, uWind: windUniform };

  const makeKind = (name, geoBase, spacing, radius, shape, kind) => {
    const k = Math.ceil(radius * 2 / spacing / TILES);
    const uniforms = {
      ...shared,
      uGrid: { value: new THREE.Vector4(0, 0, spacing, k) },
      uRad: { value: new THREE.Vector4(radius * 0.7, radius, 0, 0) },
      uShape: { value: new THREE.Vector4(...shape) },
      uKind: { value: new THREE.Vector4(...kind) },
    };
    const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + PARS)
        .replace('#include <beginnormal_vertex>', `
float gk = uGrid.w;
float gid = float(gl_InstanceID);
vec2 aTile = modelMatrix[3].xz;   // the tile index rides in the mesh position (see below)
vec2 cellIdx = uGrid.xy + aTile * gk + vec2(mod(gid, gk), floor(gid / gk));
vec2 hA = uHash22(cellIdx + uShape.w), hB = uHash22(cellIdx + uShape.w + 17.17);
vec2 pxz = (cellIdx + hA) * uGrid.z;
float dCam = distance(pxz, cameraPosition.xz);
float shrink = 1.0 - smoothstep(uRad.x, uRad.y, dCam);
vec4 gd = textureLod(tData, (pxz + uMap.x + 0.5) / (uMap.w + 1.0), 0.0);
vec4 sp = textureLod(tSplat, ((pxz + uMap.x) / uMap.y + 0.5) / uMap.z, 0.0);
vec4 nz = textureLod(tNoise, pxz / 53.0, 0.0);
float bare = clamp(1.0 - (sp.r + sp.g + sp.b + sp.a) * 2.5, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.6, gd.b));
float forest = smoothstep(0.25, 0.75, gd.g);
float meadow = gd.a * (1.0 - forest);
float dens = uKind.x * forest * smoothstep(0.3, 0.55, nz.r + 0.15)
           + uKind.y * meadow * smoothstep(0.5, 0.7, nz.b)
           + uKind.z * (forest * 0.6 + meadow * 0.25) * smoothstep(0.35, 0.6, nz.g)
           + uKind.w * meadow * smoothstep(0.45, 0.6, nz.a);
dens *= bare * uShape.z;
float inMap = step(max(abs(pxz.x), abs(pxz.y)), uMap.x - 2.0);
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 uPos = vec3(0.0, -1e4, 0.0);
if (hB.x < dens && shrink > 0.0 && inMap > 0.0) {
  float sc = mix(uShape.x, uShape.y, hB.y) * (0.15 + 0.85 * shrink);
  float yaw = hA.x * 6.2831853 + hB.y * 3.1;
  float c = cos(yaw), s = sin(yaw);
  mat2 R = mat2(c, -s, s, c);
  vec3 lp = position * sc;
  lp.xz = R * lp.xz;
  objectNormal = normal;
  objectNormal.xz = R * objectNormal.xz;
  // wind: whole plant leans, tips flutter
  float t = uWind.w;
  float gust = 0.6 + 0.4 * sin(dot(pxz, uWind.xy) * 0.09 - t * 1.3);
  float sway = sin(t * (1.7 + hA.y) + pxz.x * 0.3 + pxz.y * 0.2);
  lp.xz += uWind.xy * uWind.z * aWind * aWind * sc * (0.12 * gust + 0.06 * sway);
  lp += vec3(sin(t * 4.3 + dot(lp, vec3(3.1, 2.3, 1.7))), 0.0, cos(t * 3.7 + dot(lp, vec3(1.9, 2.9, 2.3)))) * 0.025 * aWind * uWind.z;
  float gy = uGround(pxz);
  uPos = vec3(pxz.x, gy - 0.03, pxz.y) + lp;
}`)
        .replace('#include <begin_vertex>', 'vec3 transformed = uPos;')
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
        .replace('#include <worldpos_vertex>', '#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0\nvec4 worldPosition = vec4(transformed, 1.0);\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL).replace('#include <opaque_fragment>', `
outgoingLight += diffuseColor.rgb * 0.15 * reflectedLight.directDiffuse;
#include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'undergrowth-v1';
    const tiles = [];
    for (let tx = 0; tx < TILES; tx++) for (let tz = 0; tz < TILES; tz++) {
      const g = new THREE.InstancedBufferGeometry();
      for (const a of ['position', 'normal', 'uv', 'aWind']) g.setAttribute(a, geoBase.getAttribute(a));
      g.setIndex(geoBase.getIndex());
      g.instanceCount = k * k;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false;
      m.userData.tile = [tx, tz];
      m.position.set(tx, 0, tz); m.updateMatrix(); m.matrixWorldAutoUpdate = false; m.matrixWorld.copy(m.matrix);
      group.add(m);
      tiles.push(m);
    }
    return { name, mat, uniforms, tiles, spacing, baseSpacing: spacing, radius, baseRadius: radius, baseScale: [shape[0], shape[1]], k };
  };

  //                          geometry                     spacing radius  [min, max scale, density, seed]  [forest, meadow, shrub, edge]
  const kinds = [
    makeKind('fern', buildPlant('fern', 11), 1.6, 44, [0.75, 1.35, 0.8, 3.1], [1, 0, 0, 0]),
    makeKind('shrub', buildPlant('bush', 12), 3.6, 72, [0.45, 1.13, 0.55, 7.7], [0, 0, 1, 0]),   // smaller since Oct 9 (stood out): a third off, then 13% back
    makeKind('flowers', buildPlant('flowers', 13), 1.25, 36, [0.7, 1.15, 0.6, 11.3], [0, 1, 0, 0]),
    makeKind('tuft', buildPlant('tuft', 14), 1.0, 32, [0.7, 1.4, 0.45, 19.9], [0.25, 0, 0, 1]),
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
        K.k = Math.ceil(r * 2 / K.spacing / TILES);
        K.uniforms.uGrid.value.z = K.spacing;
        K.uniforms.uGrid.value.w = K.k;
        K.uniforms.uRad.value.set(r * 0.7, r, 0, 0);
        K.uniforms.uShape.value.x = K.baseScale[0] * hs;
        K.uniforms.uShape.value.y = K.baseScale[1] * hs;
        for (const m of K.tiles) m.geometry.instanceCount = K.k * K.k;
      }
    },
    update(dt, camera) {
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      for (const K of kinds) {
        const s = K.spacing, k = K.k, n = k * TILES, R = K.radius;
        const bx = Math.floor((cx / s - n / 2) / k) * k, bz = Math.floor((cz / s - n / 2) / k) * k;
        K.uniforms.uGrid.value.x = bx; K.uniforms.uGrid.value.y = bz;
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
  };
}
