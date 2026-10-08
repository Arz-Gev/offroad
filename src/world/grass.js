import * as THREE from 'three';
import { MAP_SIZE, CELL, N } from './terrain.js';

// GPU grass: blades placed procedurally in the vertex shader on a camera-centred grid of world cells.
// Every world cell always gets the same blade (hashed from the cell index), so blades never swim as the
// grid follows the camera. One grid, split into world-aligned tiles (16-32 m) that are frustum culled on
// the CPU. It thins out with distance: inside a tile the instances are numbered so that every leading
// part of the list is spread evenly over the tile (bit-reversed Morton order: the first quarter is one
// blade per 2x2 cells, the first sixteenth one per 4x4, ...), so a far tile draws only the first few
// instances, and the blades that stay keep their places as the share changes. A blade that represents a
// coarse block is jittered over its whole block, so the sparse far grass doesn't sit on a lattice. Blade
// height and width go from their near values at the camera to their far values at the grass distance;
// blades at the edge of the drawn share shrink to nothing, so nothing pops. Density comes from the
// terrain's surface and ground-data maps (no grass on trails, rock, mud, sand or under dense canopy);
// heights come from the physics heightfield with the same triangle split, so blades stand exactly on
// the ground. Wind (travelling gusts), the truck's wheels push blades aside, tyre tracks flatten them,
// and a few distant blades are wild flowers.

const HALF = MAP_SIZE / 2, NN = N + 1;
const SEG_NEAR = 22;   // tiles closer than this (m) use 2-segment blades, the rest 1-segment

function bladeGeometry(segments = 3) {
  // aBlade: x = side (-1, 1, or 0 at the tip), y = t along the blade (0 root .. 1 tip)
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
  // a normal attribute (values unused, the shader computes them): without one three compiles the
  // material FLAT_SHADED and ignores the vertex normals
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(v.length), 3));
  g.setIndex(idx);
  return g;
}

const COMMON_GLSL = /* glsl */`
uniform highp sampler2D tHeight;
uniform sampler2D tSplat, tData, tNoise, tTrack;
uniform vec4 uMap;      // half, cell, NN, size
uniform vec4 uGrid;     // base cell x, base cell z, spacing (m), unused
uniform vec4 uLod;      // log2(cells per tile side), far / near density, grass distance (m), flower chance
uniform vec2 uRad;      // fade out start, end (m)
uniform vec4 uShape;    // height near, width near, height far, width far (m)
uniform vec4 uWind;     // dir x, dir z, strength, time
uniform vec4 uPush[5];  // xyz, radius
uniform vec4 uTrackP;   // origin x, z, size
attribute vec3 aBlade;
varying vec3 vGCol;
varying vec3 vGFace;
varying float vGAO;
vec2 gHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float groundAt(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = gHgt(i), h10 = gHgt(i + ivec2(1, 0)), h01 = gHgt(i + ivec2(0, 1)), h11 = gHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
`;

export function buildGrass(terrainView, opts = {}) {
  const U = terrainView.uniforms;
  const shared = {
    tHeight: U.tHeight, tSplat: U.tSplat, tData: U.tData, tNoise: U.tNoise, tTrack: U.uTrack,
    uMap: U.uMap,
    uWind: { value: new THREE.Vector4(0.8, 0.6, 1, 0) },
    uPush: { value: Array.from({ length: 5 }, () => new THREE.Vector4(0, -1e5, 0, 0)) },
    uTrackP: { value: new THREE.Vector4(0, 0, MAP_SIZE, 0) },
  };
  const group = new THREE.Group();
  group.name = 'grass';
  const geoNear = bladeGeometry(2), geoFar = bladeGeometry(1);
  const uniforms = {
    ...shared,
    uGrid: { value: new THREE.Vector4(0, 0, 0.1, 0) },
    uLod: { value: new THREE.Vector4(8, 1, 100, 0.035) },
    uRad: { value: new THREE.Vector2(72, 100) },
    uShape: { value: new THREE.Vector4(0.34, 0.065, 0.34, 0.065) },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  if (terrainView.floatLinear) mat.defines = { FLOAT_LINEAR: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON_GLSL)
      .replace('#include <beginnormal_vertex>', `
// instance -> cell in the tile: bit pair p (from the top) of the instance index is bit p of the cell's
// x and z, so every leading part of the list is spread evenly; leading zero pairs = the size of the
// block this blade stands for (it is jittered over that block)
int gn = int(uLod.x);
uint gi = uint(gl_InstanceID), ux = 0u, uz = 0u;
int lead = 0; bool seen = false;
for (int p = 0; p < 10; p++) {
  if (p >= gn) break;
  uint bx = (gi >> uint(2 * gn - 1 - 2 * p)) & 1u, bz = (gi >> uint(2 * gn - 2 - 2 * p)) & 1u;
  ux |= bx << uint(p); uz |= bz << uint(p);
  if (!seen && (bx | bz) == 0u) lead++; else seen = true;
}
float gk = exp2(uLod.x);
vec2 aTile = modelMatrix[3].xz;   // the tile index rides in the mesh position (see below)
vec2 cellIdx = uGrid.xy + aTile * gk + vec2(float(ux), float(uz));
vec2 hA = gHash22(cellIdx), hB = gHash22(cellIdx + 17.17);
vec2 bxz = (cellIdx + hA * exp2(float(lead))) * uGrid.z;
float dCam = distance(bxz, cameraPosition.xz);
float tD = clamp(dCam / uLod.z, 0.0, 1.0);
// the share of the grid drawn at this distance; the last third of it shrinks towards the cut
float keep = min(1.0, pow(uLod.y, tD));
float rank = (float(gi) + 0.5) / (gk * gk);
float fade = (1.0 - smoothstep(uRad.x, uRad.y, dCam)) * clamp((keep - rank) / (keep * 0.35), 0.0, 1.0);
// density (precomputed: grass surfaces, slope, clearings, canopy) -- most culled blades stop here
float dens = textureLod(tData, (bxz + uMap.x + 0.5) / (uMap.w + 1.0), 0.0).a;
float inMap = step(max(abs(bxz.x), abs(bxz.y)), uMap.x - 1.0);
vec3 gPos = vec3(0.0, -1e4, 0.0);
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vGCol = vec3(0.0); vGAO = 1.0; vGFace = vec3(0.0);
if (hB.x < dens && fade > 0.0 && inMap > 0.0) {
  vec2 hC = gHash22(cellIdx + 41.3);
  vec4 nz = textureLod(tNoise, bxz / 61.0, 0.0);
  #ifdef FLOAT_LINEAR
  float gy = textureLod(tHeight, ((bxz.yx + uMap.x) / uMap.y + 0.5) / uMap.z, 0.0).r;
  #else
  float gy = groundAt(bxz);
  #endif
  // tyre tracks flatten the grass
  float track = textureLod(tTrack, (bxz - uTrackP.xy) / uTrackP.z + 0.5, 0.0).r;
  float tall = 0.45 + 0.95 * nz.g * nz.g;
  float flower = step(hC.x, uLod.w * smoothstep(12.0, 30.0, dCam)) * step(0.5, nz.b + 0.2);
  // near values at the camera, far values at the grass distance, in even steps of ratio between
  float hD = uShape.x * pow(uShape.z / uShape.x, tD), wD = uShape.y * pow(uShape.w / uShape.y, tD);
  float ht = hD * tall * (0.6 + 0.7 * hB.y) * (0.25 + 0.75 * fade) * (1.0 - track * 0.75) * (flower > 0.5 ? 0.8 : 1.0);
  float wd = wD * (0.7 + 0.6 * hC.y) * fade;
  float ang = hA.x * 6.2831853;
  vec2 facing = vec2(cos(ang), sin(ang));
  // bend: natural lean + travelling wind gusts + pushed by the wheels
  vec2 bend = (hC - 0.5) * 0.5;
  float t = uWind.w;
  float ph = dot(bxz, uWind.xy) * 0.09 - t * 1.3;
  float gust = 0.55 + 0.45 * sin(ph) * sin(ph * 0.37 + bxz.x * 0.05 + 1.7);
  float sway = sin(t * (1.6 + hA.y) + bxz.x * 0.35 + bxz.y * 0.2) * 0.12;
  bend += uWind.xy * uWind.z * (gust * 0.7 - 0.1 + sway);
  float squash = 1.0;
  for (int i = 0; i < 5; i++) {
    vec2 dv = bxz - uPush[i].xz;
    float pd = length(dv);
    float f = (1.0 - smoothstep(uPush[i].w * 0.4, uPush[i].w, pd)) * step(abs(gy - uPush[i].y), 1.5);
    bend += dv / max(pd, 1e-3) * f * 1.4;
    squash *= 1.0 - f * 0.6;
  }
  ht *= squash;
  float bl = length(bend);
  if (bl > 1.4) bend *= 1.4 / bl;
  float tb = aBlade.y;
  vec3 side = vec3(-facing.y, 0.0, facing.x);
  gPos = vec3(bxz.x, gy - 0.02, bxz.y) + side * aBlade.x * wd * 0.5 * (1.0 - tb * 0.85)
    + vec3(bend.x, 0.0, bend.y) * ht * tb * tb * 0.7 + vec3(0.0, ht * tb * (1.0 - 0.25 * min(dot(bend, bend), 1.0)), 0.0);
  // lighting normal: mostly up (reads like a lawn) for both faces of the blade; the blade's own facing is
  // added in the fragment shader with the face's sign (flipping the whole normal on back faces, as
  // three does for DoubleSide, pointed it down: half the blades came out black)
  objectNormal = normalize(vec3(bend.x, 0.0, bend.y) * 0.3 + side * 0.25 * sign(aBlade.x + 0.001) + vec3(0.0, 1.0, 0.0));
  vGFace = mat3(viewMatrix) * (vec3(facing.x, 0.0, facing.y) * 0.45);
  // colour: patch tint, per-blade variation, darker roots, lighter dry tips; flowers get a coloured head
  vec3 lush = vec3(0.115, 0.175, 0.04), dry = vec3(0.30, 0.27, 0.10), deep = vec3(0.07, 0.125, 0.03);
  vec3 col = mix(lush, deep, nz.a * 0.8);
  col = mix(col, dry, smoothstep(0.55, 0.85, nz.b) * 0.65 + hB.x * 0.12);
  col *= 0.8 + 0.4 * hA.y;
  col = mix(col * 0.72, col * (1.08 + 0.2 * tb), tb);
  if (flower > 0.5 && tb > 0.75) {
    float fc = fract(hC.y * 7.0);
    col = fc < 0.45 ? vec3(0.8, 0.8, 0.75) : fc < 0.75 ? vec3(0.85, 0.62, 0.05) : vec3(0.42, 0.2, 0.6);
  }
  vGCol = col;
  vGAO = mix(0.6, 1.0, tb);
}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
      .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
      .replace('#include <worldpos_vertex>', '#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0\nvec4 worldPosition = vec4(transformed, 1.0);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGCol;\nvarying vec3 vGFace;\nvarying float vGAO;')
      .replace('#include <normal_fragment_begin>', `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize(normalize(vNormal) + vGFace * faceDirection);
vec3 nonPerturbedNormal = normal;`)
      .replace('#include <map_fragment>', 'diffuseColor.rgb = vGCol;')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= vGAO; reflectedLight.indirectSpecular *= vGAO * 0.35;');
  };
  mat.customProgramCacheKey = () => 'grass-v2';

  // tiles: a pool of meshes, each with a 2-segment and a 1-segment geometry (near / far tiles)
  const tiles = [];
  const makeGeo = base => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('aBlade', base.getAttribute('aBlade'));
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    g.setIndex(base.getIndex());
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  };
  const ensureTiles = (T) => {
    for (let i = tiles.length; i < T * T; i++) {
      const m = new THREE.Mesh(makeGeo(geoNear), mat);
      m.userData.geos = [m.geometry, makeGeo(geoFar)];
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = false;
      m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false;
      group.add(m);
      tiles.push(m);
    }
    // the tile index (a, b) rides in the mesh position: the shader reads it from modelMatrix
    tiles.forEach((m, i) => {
      m.userData.tile = i < T * T ? [i % T, Math.floor(i / T)] : null;
      if (m.userData.tile) { m.position.set(m.userData.tile[0], 0, m.userData.tile[1]); m.updateMatrix(); m.matrixWorld.copy(m.matrix); }
      m.visible = false;
    });
  };

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let time = 0, enabled = true;
  const lay = { s: 0.1, n: 8, k: 256, tile: 25.6, h: 4, T: 9, R: 100, ratio: 1 };
  const api = {
    group, shared, uniforms, lay,
    get tiles() { return tiles; },
    configure(q) {
      enabled = q.vegetation !== false && q.grass > 0;
      group.visible = enabled;
      // near density is the cell spacing (1 = a blade every 0.1 m); the far density is the share of
      // that grid drawn at the grass distance
      const dN = Math.max(q.grass, 0.01), s = 0.1 / Math.sqrt(dN);
      const n = Math.max(4, Math.min(9, Math.floor(Math.log2(32 / s)))), k = 2 ** n;
      const R = q.grassRadius || 100, tile = k * s, h = Math.ceil(R / tile), T = 2 * h + 1;
      const ratio = Math.min(1, Math.max(q.grassFar ?? dN * 0.1, 0.0005) / dN);
      Object.assign(lay, { s, n, k, tile, h, T, R, ratio });
      ensureTiles(T);
      uniforms.uGrid.value.z = s;
      uniforms.uLod.value.set(n, ratio, R, 0.035);
      uniforms.uRad.value.set(R * 0.72, R);
      const hN = q.grassHeight ?? 1.5, wN = q.grassWidth ?? 1;
      uniforms.uShape.value.set(0.34 * hN, 0.065 * wN, 0.34 * (q.grassHeightFar ?? hN), 0.065 * (q.grassWidthFar ?? wN * 4));
    },
    update(dt, camera, focus) {
      time += dt;
      shared.uWind.value.w = time;   // shared with the trees and the undergrowth: runs with the grass off too
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      const { k, tile, h, T, R, ratio } = lay;
      // tile (0, 0) of the T x T block around the camera's tile; tiles are world-aligned
      const ti = Math.floor(cx / tile) - h, tj = Math.floor(cz / tile) - h;
      uniforms.uGrid.value.x = ti * k; uniforms.uGrid.value.y = tj * k;
      for (const m of tiles) {
        const t = m.userData.tile;
        if (!t) continue;
        const x0 = (ti + t[0]) * tile, z0 = (tj + t[1]) * tile, x1 = x0 + tile, z1 = z0 + tile;
        const d = Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(z0 - cz, 0, cz - z1));
        if (d > R || Math.abs(x0) > HALF + 2 && Math.abs(x1) > HALF + 2 || Math.abs(z0) > HALF + 2 && Math.abs(z1) > HALF + 2) { m.visible = false; continue; }
        box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
        m.visible = frustum.intersectsBox(box);
        if (!m.visible) continue;
        // draw the share the tile's nearest point needs; the shader drops what its farther blades don't
        const g = m.userData.geos[d < SEG_NEAR ? 0 : 1];
        m.geometry = g;
        g.instanceCount = Math.min(k * k, Math.ceil(k * k * Math.min(1, ratio ** (d / R)) * 1.02) + 4);
      }
    },
    // wheels push the grass aside (world positions, radius in m)
    setPushers(list) {
      const P = shared.uPush.value;
      for (let i = 0; i < 5; i++) { const p = list[i]; if (p) P[i].set(p.x, p.y, p.z, p.r); else P[i].set(0, -1e5, 0, 0); }
    },
  };
  return api;
}
