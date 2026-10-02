import * as THREE from 'three';
import { MAP_SIZE, CELL, N } from './terrain.js';

// GPU grass: blades placed procedurally in the vertex shader on a camera-centred grid of world cells.
// Every world cell always gets the same blade (hashed from the cell index), so blades never swim as the
// grid follows the camera. Two layers: dense short-range blades and a sparser, wider layer further out,
// each split into tiles that are frustum culled on the CPU. Density comes from the terrain's surface and
// ground-data maps (no grass on trails, rock, mud, sand or under dense canopy); heights come from the
// physics heightfield with the same triangle split, so blades stand exactly on the ground.
// Wind (travelling gusts), the truck's wheels push blades aside, tyre tracks flatten them, and a few
// blades are wild flowers.

const HALF = MAP_SIZE / 2, NN = N + 1;
const TILES = 8;

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
  g.setIndex(idx);
  return g;
}

const COMMON_GLSL = /* glsl */`
uniform highp sampler2D tHeight;
uniform sampler2D tSplat, tData, tNoise, tTrack;
uniform vec4 uMap;      // half, cell, NN, size
uniform vec4 uGrid;     // base cell x, base cell z, spacing, cells per tile
uniform vec4 uRad;      // fade out start, end; fade in start, end (far layer hand-over)
uniform vec4 uShape;    // height, width, density, flower chance
uniform vec4 uWind;     // dir x, dir z, strength, time
uniform vec4 uPush[5];  // xyz, radius
uniform vec4 uTrackP;   // origin x, z, size
attribute vec3 aBlade;
attribute vec2 aTile;
varying vec3 vGCol;
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
  const geo0 = bladeGeometry(2), geo1 = bladeGeometry(1);

  const makeLayer = (name, geoBase, spacing, radius, fadeIn, shape) => {
    const k = Math.ceil(radius * 2 / spacing / TILES);   // cells per tile side
    const uniforms = {
      ...shared,
      uGrid: { value: new THREE.Vector4(0, 0, spacing, k) },
      uRad: { value: new THREE.Vector4(radius * 0.72, radius, fadeIn[0], fadeIn[1]) },
      uShape: { value: new THREE.Vector4(...shape) },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
    if (terrainView.floatLinear) mat.defines = { FLOAT_LINEAR: '' };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + COMMON_GLSL)
        .replace('#include <beginnormal_vertex>', `
float gk = uGrid.w;
float gid = float(gl_InstanceID);
vec2 cellIdx = uGrid.xy + aTile * gk + vec2(mod(gid, gk), floor(gid / gk));
vec2 hA = gHash22(cellIdx), hB = gHash22(cellIdx + 17.17);
vec2 bxz = (cellIdx + hA) * uGrid.z;
float dCam = distance(bxz, cameraPosition.xz);
float fade = (1.0 - smoothstep(uRad.x, uRad.y, dCam)) * smoothstep(uRad.z, uRad.w, dCam);
// density (precomputed: grass surfaces, slope, clearings, canopy) -- most culled blades stop here
float dens = textureLod(tData, (bxz + uMap.x + 0.5) / (uMap.w + 1.0), 0.0).a * uShape.z;
float inMap = step(max(abs(bxz.x), abs(bxz.y)), uMap.x - 1.0);
vec3 gPos = vec3(0.0, -1e4, 0.0);
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vGCol = vec3(0.0); vGAO = 1.0;
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
  float flower = step(hC.x, uShape.w) * step(0.5, nz.b + 0.2);
  float ht = uShape.x * tall * (0.6 + 0.7 * hB.y) * (0.25 + 0.75 * fade) * (1.0 - track * 0.75) * (flower > 0.5 ? 0.8 : 1.0);
  float wd = uShape.y * (0.7 + 0.6 * hC.y) * fade;
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
  // lighting normal: mostly up (reads like a lawn), a little of the blade's facing
  objectNormal = normalize(vec3(facing.x, 0.0, facing.y) * 0.35 * sign(aBlade.x + 0.001) + vec3(bend.x, 0.0, bend.y) * 0.3 + vec3(0.0, 1.0, 0.0));
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
        .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGCol;\nvarying float vGAO;')
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGCol;')
        .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= vGAO; reflectedLight.indirectSpecular *= vGAO;');
    };
    mat.customProgramCacheKey = () => 'grass-v1-' + name;
    const tiles = [];
    for (let tx = 0; tx < TILES; tx++) for (let tz = 0; tz < TILES; tz++) {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('aBlade', geoBase.getAttribute('aBlade'));
      g.setAttribute('position', geoBase.getAttribute('position'));
      g.setIndex(geoBase.getIndex());
      g.setAttribute('aTile', new THREE.InstancedBufferAttribute(new Float32Array([tx, tz]), 2, false, 1 << 30));
      g.instanceCount = k * k;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = false;
      m.matrixAutoUpdate = false;
      m.userData.tile = [tx, tz];
      group.add(m);
      tiles.push(m);
    }
    return { name, mat, uniforms, tiles, spacing, radius, k, density: shape[2] };
  };

  // dense near blades, then wider ones further out (cross-faded)
  const layers = [
    makeLayer('near', geo0, 0.085, 22, [-1, 0], [0.34, 0.055, 1.0, 0.0]),
    makeLayer('far', geo1, 0.21, 52, [15, 21], [0.32, 0.12, 1.0, 0.035]),
  ];

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let time = 0, enabled = true, scale = 1;
  const api = {
    group, layers, shared,
    configure(q) {
      enabled = q.grass > 0;
      group.visible = enabled;
      scale = q.grass;
      // fewer, wider blades on lower presets; shorter radius
      const r = q.grassRadius || 48;
      const near = layers[0], far = layers[1];
      near.uniforms.uShape.value.z = Math.min(1, scale);
      far.uniforms.uShape.value.z = Math.min(1, scale * 1.1);
      far.uniforms.uRad.value.set(r * 0.72, r, Math.min(15, r * 0.3), Math.min(21, r * 0.42));
      near.uniforms.uRad.value.set(Math.min(22, r * 0.45) * 0.72, Math.min(22, r * 0.45), -1, 0);
    },
    update(dt, camera, focus) {
      if (!enabled) return;
      time += dt;
      shared.uWind.value.w = time;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      for (const L of layers) {
        const s = L.spacing, k = L.k, R = L.uniforms.uRad.value.y;
        const n = k * TILES;
        // base cell: grid centred on the camera, snapped to whole tiles so a tile never straddles the snap
        const bx = Math.floor((cx / s - n / 2) / k) * k, bz = Math.floor((cz / s - n / 2) / k) * k;
        L.uniforms.uGrid.value.x = bx; L.uniforms.uGrid.value.y = bz;
        for (const m of L.tiles) {
          const [tx, tz] = m.userData.tile;
          const x0 = (bx + tx * k) * s, z0 = (bz + tz * k) * s, x1 = x0 + k * s, z1 = z0 + k * s;
          const ddx = Math.max(x0 - cx, 0, cx - x1), ddz = Math.max(z0 - cz, 0, cz - z1);
          if (Math.hypot(ddx, ddz) > R || Math.abs(x0) > HALF + 2 && Math.abs(x1) > HALF + 2 || Math.abs(z0) > HALF + 2 && Math.abs(z1) > HALF + 2) { m.visible = false; continue; }
          box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
          m.visible = frustum.intersectsBox(box);
        }
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
