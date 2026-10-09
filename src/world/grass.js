import * as THREE from 'three';
import { MAP_SIZE, CELL, N } from './terrain.js';

// GPU grass: blades placed procedurally in the vertex shader on a camera-centred grid of world cells; each cell's
// blade is hashed from the cell index, so blades never swim as the grid follows the camera. Tiles (16-32 m) are
// frustum culled on the CPU. Thinning with distance: a tile's instances are in bit-reversed Morton order, so any
// leading part of the list is spread evenly (first quarter = one blade per 2x2 cells, ...); a far tile draws only
// the first few, the blades that stay keep their places, a coarse blade is jittered over its block (no lattice),
// and blades at the edge of the drawn share shrink to nothing (no popping). Density from the terrain's surface and
// ground-data maps; heights from the physics heightfield with the same triangle split. Wind gusts, wheels push
// blades aside, tyre tracks flatten them, a few far blades are wild flowers.

const HALF = MAP_SIZE / 2, NN = N + 1;
const SEG_NEAR = 22;   // tiles closer than this (m) use 2-segment blades, the rest 1-segment
// the grass curves (density, height, width over the distance) are sampled at CURVE_N + 1 distances,
// d = CURVE_MAX * (i / CURVE_N)^2: closer together near the camera, where the detail is
const CURVE_N = 64, CURVE_MAX = 300;
const curveD = i => CURVE_MAX * (i / CURVE_N) ** 2;

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
uniform vec4 uLod;      // log2(cells per tile side), unused, grass distance (m), flower chance
uniform vec2 uRad;      // fade out start, end (m)
uniform vec4 uCurve[65];  // per sampled distance (CURVE_N + 1): share of the grid drawn, height (m), width (m)
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
    uCurve: { value: Array.from({ length: CURVE_N + 1 }, () => new THREE.Vector4(1, 0.5, 0.07, 0)) },
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
float cu = sqrt(clamp(dCam / ${CURVE_MAX.toFixed(1)}, 0.0, 1.0)) * ${CURVE_N.toFixed(1)};
int ci = int(min(cu, ${(CURVE_N - 1).toFixed(1)}));
vec4 cv = mix(uCurve[ci], uCurve[ci + 1], cu - float(ci));
// the share of the grid drawn at full size at this distance; the next 35 % of that grow in from nothing
// as the share rises (so a blade never pops), the rest isn't drawn
float keep = cv.x;
float rank = (float(gi) + 0.5) / (gk * gk);
float fade = (1.0 - smoothstep(uRad.x, uRad.y, dCam)) * clamp((keep * 1.35 - rank) / (keep * 0.35), 0.0, 1.0);
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
  float hD = cv.y, wD = cv.z;   // the height and width curves at this distance
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
  // added in the fragment shader, turned towards the sun (flipping the whole normal on back faces, as
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
// thin, translucent blades: whichever face we see is lit like the face towards the sun (lit by its own
// face's sign, grass with the sun behind it goes dark olive)
#if NUM_SUN_LIGHTS > 0
float gSide = dot(vGFace, sunLights[0].direction) < 0.0 ? -1.0 : 1.0;
#else
float gSide = faceDirection;
#endif
vec3 normal = normalize(normalize(vNormal) + vGFace * gSide);
vec3 nonPerturbedNormal = normal;`)
      .replace('#include <map_fragment>', `
diffuseColor.rgb = vGCol;
#if NUM_SUN_LIGHTS > 0
// the hot spot: with the sun at the viewer's back every blade shows its sunlit side and hides its shadow,
// so a meadow is at its brightest; against the sun the specular sheen lights it instead
float gOpp = dot(normalize(vViewPosition), sunLights[0].direction);
diffuseColor.rgb *= 1.0 + 0.35 * smoothstep(-0.1, 0.75, gOpp);
#endif`)
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
      m.renderOrder = 1;   // after the other opaque objects (between the timer's markers)
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

  // GPU time of the grass (the tuner's readout): a timer query from an empty marker mesh drawn just
  // before the tiles to one just after them (renderOrder 0.9 / 1 / 1.1)
  let timer = null;
  function makeTimer(renderer) {
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const pending = [], t = { ms: 0 };
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const marker = (order, fn) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
      g.setDrawRange(0, 0);
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.renderOrder = order; m.onBeforeRender = fn;
      return m;
    };
    let open = null;
    t.markers = [
      marker(0.9, () => { if (open || pending.length > 8) return; open = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, open); }),
      marker(1.1, () => { if (!open) return; gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); open = null; }),
    ];
    t.poll = () => {
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) t.ms += (gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 - t.ms) * 0.15;
        gl.deleteQuery(q);
      }
    };
    return t;
  }

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let time = 0, enabled = true;
  const lay = { s: 0.1, n: 8, k: 256, tile: 25.6, h: 4, T: 9, R: 100, share: new Float32Array(CURVE_N + 1).fill(1) };
  const api = {
    group, shared, uniforms, lay,
    get tiles() { return tiles; },
    sent: 0,   // instances drawn last frame
    // the GPU timer for the tuner (null if the browser has no timer queries); ms: smoothed grass time
    setTiming(renderer, on) {
      if (on && !timer) { timer = makeTimer(renderer); if (timer) group.add(...timer.markers); }
      else if (!on && timer) { group.remove(...timer.markers); timer = null; }
      return timer;
    },
    configure(q) {
      // q.grassCurve: the level's curves or the player's own (grass editor)
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
      uniforms.uCurve.value.forEach((v, i) => {
        const d = Math.min(curveD(i), R);
        share[i] = Math.min(1, dens(d) / dMax);
        v.set(share[i], Math.max(0, evalCurve(c.height, d, c.smooth, true, c.lin)) / 100, Math.max(0, evalCurve(c.width, d, c.smooth, true, c.lin)) / 100, 0);
      });
      Object.assign(lay, { s, n, k, tile, h, T, R, share });
      ensureTiles(T);
      uniforms.uGrid.value.z = s;
      uniforms.uLod.value.set(n, 0, R, 0.035);
      uniforms.uRad.value.set(R * 0.85, R);
    },
    // the largest share of the grid any distance in [d0, d1] draws (a tile draws that many instances)
    maxShare(d0, d1) {
      const sh = lay.share, u = d => Math.sqrt(Math.min(d, CURVE_MAX) / CURVE_MAX) * CURVE_N;
      const at = d => { const x = u(d), i = Math.min(Math.floor(x), CURVE_N - 1); return sh[i] + (sh[i + 1] - sh[i]) * (x - i); };
      let m = Math.max(at(d0), at(d1));
      for (let i = Math.ceil(u(d0)); i <= Math.min(CURVE_N, Math.floor(u(d1))); i++) m = Math.max(m, sh[i]);
      return m;
    },
    update(dt, camera, focus) {
      time += dt;
      shared.uWind.value.w = time;   // shared with the trees and the undergrowth: runs with the grass off too
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      const { k, tile, h, T, R } = lay;
      let sent = 0;
      // tile (0, 0) of the T x T block around the camera's tile; tiles are world-aligned
      const ti = Math.floor(cx / tile) - h, tj = Math.floor(cz / tile) - h;
      uniforms.uGrid.value.x = ti * k; uniforms.uGrid.value.y = tj * k;
      for (const m of tiles) {
        const t = m.userData.tile;
        if (!t) continue;
        const x0 = (ti + t[0]) * tile, z0 = (tj + t[1]) * tile, x1 = x0 + tile, z1 = z0 + tile;
        const d = Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(z0 - cz, 0, cz - z1));
        const dFar = Math.hypot(Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx)), Math.max(Math.abs(z0 - cz), Math.abs(z1 - cz)));
        if (d > R || Math.abs(x0) > HALF + 2 && Math.abs(x1) > HALF + 2 || Math.abs(z0) > HALF + 2 && Math.abs(z1) > HALF + 2) { m.visible = false; continue; }
        box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
        m.visible = frustum.intersectsBox(box);
        if (!m.visible) continue;
        // draw the largest share any point of the tile needs; the shader drops what each blade's own distance doesn't
        const g = m.userData.geos[d < SEG_NEAR ? 0 : 1];
        m.geometry = g;
        g.instanceCount = Math.min(k * k, Math.ceil(k * k * Math.min(1, api.maxShare(d, Math.min(dFar, R)) * 1.35)) + 4);
        sent += g.instanceCount;
      }
      api.sent = sent;
      timer?.poll();
    },
    // wheels push the grass aside (world positions, radius in m)
    setPushers(list) {
      const P = shared.uPush.value;
      for (let i = 0; i < 5; i++) { const p = list[i]; if (p) P[i].set(p.x, p.y, p.z, p.r); else P[i].set(0, -1e5, 0, 0); }
    },
  };
  return api;
}
