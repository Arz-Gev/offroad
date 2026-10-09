import * as THREE from 'three';
import { MAP_SIZE, PAD, SPAWN, POI, SURF } from './terrain.js';
import { SURFACES } from '../vehicle/tire.js';
import { makeSimplex2D, mulberry32, fbm, smoothstep } from './noise.js';
import { makeFoliageAtlas, buildSpruce, buildPine, buildBirch, buildDead, buildPlant } from './foliage.js';
import { makeBarkTexture } from './textures.js';
import { ColliderStream } from './colliderStream.js';

// Trees and undergrowth. ~12k trees in forests (spruce, pine, birch, dead snags), each with a trunk collider.
// - Near the camera (preset radius, 40-50 m) trees are real geometry: bark trunks and branches plus alpha-tested
//   foliage cards, swaying in the wind (also in the shadow pass).
// - Beyond that every tree is an impostor: a camera-facing card baked from 8 directions at startup (albedo +
//   normals, so it is lit like the real tree), cross-faded with a dither.
// - Undergrowth and fallen logs near the camera. The forest also writes the ground data map (forest floor under crowns).

const HALF = MAP_SIZE / 2;
const VIEWS = 8, CELL_W = 192, CELL_H = 384;
const CHUNK = 32, CN = MAP_SIZE / CHUNK;

const WIND_GLSL = /* glsl */`
uniform vec4 uWind;   // dir x, dir z, strength, time
attribute float aWind;
vec3 windOffset(vec3 objPos, float w) {
  vec3 ip = instanceMatrix[3].xyz;
  float ph = dot(ip.xz, vec2(0.071, 0.113));
  float t = uWind.w;
  float sway = sin(t * 0.85 + ph) * 0.55 + sin(t * 1.9 + ph * 1.7) * 0.2 + 0.45;
  float gust = 0.6 + 0.4 * sin(t * 0.31 + ip.x * 0.013 + ip.z * 0.009);
  vec3 ww = vec3(uWind.x, 0.0, uWind.y) * uWind.z * gust * sway * w * 0.32;
  // tips flutter
  ww += vec3(sin(t * 5.3 + dot(objPos, vec3(2.1, 1.7, 2.9)) + ph), sin(t * 4.1 + dot(objPos, vec3(1.3, 2.3, 1.1))), cos(t * 4.7 + dot(objPos, vec3(2.7, 1.1, 1.9)))) * 0.045 * w * w * uWind.z;
  // world -> object space (yaw + uniform scale)
  float s2 = dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz);
  return (transpose(mat3(instanceMatrix)) * ww) / s2;
}
`;

export const NO_FLIP_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

const FADE_GLSL = /* glsl */`
uniform vec2 uFade;   // near-mesh / impostor cross-fade band (distance from the camera, m)
uniform vec3 uViewPos; // the view camera (also in the shadow pass, where cameraPosition is the light's)
varying float vTreeDist;
float ditherHash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

function patchTreeMaterial(mat, kind, uniforms, opts = {}) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_GLSL + FADE_GLSL)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed += windOffset(position, aWind);
vTreeDist = distance(instanceMatrix[3].xyz, uViewPos);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FADE_GLSL)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (ditherHash(gl_FragCoord.xy) < smoothstep(uFade.x, uFade.y, vTreeDist)) discard;`);
    if (opts.translucent) {
      // foliage cards: both faces keep the outward (crown-volume) normal; DoubleSide's flip shaded back faces as if
      // they faced into the crown
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL);
      // a touch of light through the leaves when backlit
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
outgoingLight += diffuseColor.rgb * 0.12 * reflectedLight.directDiffuse;
#include <opaque_fragment>`);
    }
  };
  mat.customProgramCacheKey = () => 'tree-' + kind;
}

// ---------------------------------------------------------------- impostor baking
const BAKE_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN;
void main() { vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BAKE_FRAG = /* glsl */`
uniform sampler2D tMap; uniform float uMode, uAlphaTest; uniform vec3 uTint;
varying vec2 vUv; varying vec3 vN;
void main() {
  vec4 c = texture2D(tMap, vUv);
  if (c.a < uAlphaTest) discard;
  vec3 n = normalize(vN);
  gl_FragColor = uMode < 0.5 ? vec4(c.rgb * uTint, 1.0) : vec4(n * 0.5 + 0.5, 1.0);
}`;

function bakeImpostors(renderer, variants) {
  const rows = variants.length;
  const W = VIEWS * CELL_W, Hh = rows * CELL_H;
  const mk = (srgb) => {
    const rt = new THREE.WebGLRenderTarget(W, Hh, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    rt.texture.anisotropy = 4;
    return rt;
  };
  const albedo = mk(true), normal = mk(false);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  for (const [rt, mode] of [[albedo, 0], [normal, 1]]) {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    for (let r = 0; r < rows; r++) {
      const v = variants[r];
      const mats = [
        new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide, uniforms: { tMap: { value: v.barkTex }, uMode: { value: mode }, uAlphaTest: { value: 0 }, uTint: { value: new THREE.Color(1, 1, 1) } } }),
        new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide, uniforms: { tMap: { value: v.atlas }, uMode: { value: mode }, uAlphaTest: { value: 0.45 }, uTint: { value: new THREE.Color(1, 1, 1) } } }),
      ];
      const t = new THREE.Mesh(v.geo.trunk, mats[0]), c = new THREE.Mesh(v.geo.crown, mats[1]);
      scene.add(t, c);
      const H = v.geo.height * 1.04, hw = H / 4;
      cam.left = -hw; cam.right = hw; cam.top = H; cam.bottom = 0; cam.updateProjectionMatrix();
      for (let k = 0; k < VIEWS; k++) {
        const a = k / VIEWS * Math.PI * 2;
        cam.position.set(Math.sin(a) * 100, 0, Math.cos(a) * 100);
        cam.lookAt(0, 0, 0);
        rt.viewport.set(k * CELL_W, (rows - 1 - r) * CELL_H, CELL_W, CELL_H);
        rt.scissor.copy(rt.viewport);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
      scene.remove(t, c);
      mats.forEach(m => m.dispose());
    }
  }
  for (const rt of [albedo, normal]) { rt.viewport.set(0, 0, W, Hh); rt.scissor.set(0, 0, W, Hh); rt.scissorTest = false; }
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  return { albedo: albedo.texture, normal: normal.texture, rows };
}

// ---------------------------------------------------------------- the forest
export function buildTrees(RAPIER, world, terrain, colliderSurface, renderer, terrainView, windUniform) {
  const group = new THREE.Group(); group.name = 'trees';
  const atlas = makeFoliageAtlas();
  const barkC = makeBarkTexture('conifer'), barkB = makeBarkTexture('birch');
  barkC.wrapS = barkC.wrapT = barkB.wrapS = barkB.wrapT = THREE.RepeatWrapping;

  const variants = [
    { kind: 'spruce', geo: buildSpruce(11, 17), barkTex: barkC },
    { kind: 'spruce', geo: buildSpruce(23, 12.5), barkTex: barkC },
    { kind: 'pine', geo: buildPine(31, 19), barkTex: barkC },
    { kind: 'pine', geo: buildPine(47, 15), barkTex: barkC },
    { kind: 'birch', geo: buildBirch(53, 13), barkTex: barkB },
    { kind: 'dead', geo: buildDead(61, 11), barkTex: barkC },
  ];
  for (const v of variants) v.atlas = atlas;

  // ---- placement
  const rnd = mulberry32(777);
  const nForest = makeSimplex2D(5), nKind = makeSimplex2D(9);
  const trees = [];
  const lake = terrain.lake, q = POI.quarry;
  const G = 3.4;
  for (let gx = -HALF + 6; gx < HALF - 6; gx += G) for (let gz = -HALF + 6; gz < HALF - 6; gz += G) {
    const x = gx + (rnd() - 0.5) * G * 0.9, z = gz + (rnd() - 0.5) * G * 0.9;
    const r = Math.hypot(x, z);
    let dens = fbm(nForest, x * 0.0065, z * 0.0065, 4) * 1.6 + 0.05;
    // zones: dense conifer forest to the north, groves round the lake, sparse meadows south
    dens += smoothstep(-160, -260, z) * smoothstep(320, 200, Math.abs(x + 40)) * 0.75;
    dens -= smoothstep(220, 320, z) * smoothstep(-250, -120, x) * 0.3;
    dens += smoothstep(420, 470, Math.max(Math.abs(x), Math.abs(z))) * 0.4;
    if (r < 170) dens = dens * 0.7 - 0.08;
    const p = smoothstep(0.28, 0.8, dens) * 0.72 + 0.008;
    if (rnd() > p) continue;
    if (terrain.isTrail(x, z, 7.5)) continue;
    if (x > PAD.x0 - 10 && x < PAD.x1 + 10 && z > PAD.z0 - 10 && z < PAD.z1 + 10) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 30) continue;
    if (Math.hypot((x - lake.x) / (lake.rx + 6), (z - lake.z) / (lake.rz + 6)) < 1.05) continue;
    if (Math.hypot((x - q.x) / (q.rx + 4), (z - q.z) / (q.rz + 4)) < 1) continue;
    if (Math.hypot(x - POI.hut.x, z - POI.hut.z) < 16) continue;
    if (terrain.waterLevelAt(x, z) > -1e8) continue;
    const sid = terrain.surfaceId(x, z);
    if (sid === SURF.mud || sid === SURF.sand) continue;
    const y = terrain.surfaceHeight(x, z);
    const n = terrain.normalAt(x, z);
    if (n.y < 0.8) continue;
    // species: birches near water and in the south, pines on high / dry ground, a few snags
    const wet = Math.max(0, 1 - Math.hypot((x - lake.x) / (lake.rx + 70), (z - lake.z) / (lake.rz + 70)));
    const k = nKind(x * 0.01, z * 0.01);
    let vi;
    const roll = rnd();
    if (roll < 0.025) vi = 5;
    else if (roll < 0.06 + wet * 0.6 + smoothstep(150, 300, z) * 0.35 + (k > 0.45 ? 0.2 : 0)) vi = 4;
    else if (y > 30 || k < -0.35 || roll < 0.2) vi = rnd() < 0.5 ? 2 : 3;
    else vi = rnd() < 0.55 ? 0 : 1;
    const s = 0.75 + rnd() * 0.5;
    trees.push({ x, y, z, s, yaw: rnd() * Math.PI * 2, v: vi });
  }

  // ---- fallen logs on the forest floor (instanced, three lengths), with streamed colliders
  const logStream = new ColliderStream(RAPIER, world, colliderSurface);
  const LOG_LEN = [4.2, 6.5, 9.0];
  const logs = [];
  for (let tries = 0; tries < 20000 && logs.length < 260; tries++) {
    const t = trees[Math.floor(rnd() * trees.length)];
    if (!t || t.v === 4) continue;   // not under birches (they stand in the open)
    const a = rnd() * Math.PI * 2, d = 2.5 + rnd() * 4;
    const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
    const L = LOG_LEN[Math.floor(rnd() * 3)], yaw = rnd() * Math.PI * 2;
    const dx = Math.sin(yaw) * L / 2, dz = Math.cos(yaw) * L / 2;
    let ok = true;
    for (const f of [-1, 0, 1]) { const px = x + dx * f, pz = z + dz * f; if (terrain.isTrail(px, pz, 6) || terrain.waterLevelAt(px, pz) > -1e8 || Math.abs(px) > HALF - 20 || Math.abs(pz) > HALF - 20) ok = false; }
    if (!ok || (x > PAD.x0 - 10 && x < PAD.x1 + 10 && z > PAD.z0 - 10 && z < PAD.z1 + 10) || Math.hypot(x - POI.hut.x, z - POI.hut.z) < 14) continue;
    const r = 0.14 + rnd() * 0.16 * (L / 6);
    const h0 = terrain.surfaceHeight(x - dx, z - dz), h1 = terrain.surfaceHeight(x + dx, z + dz), hm = terrain.surfaceHeight(x, z);
    if (Math.abs(h1 - h0) > L * 0.45) continue;
    logs.push({ x, z, y: Math.max((h0 + h1) / 2, hm) + r * 0.8, yaw, pitch: Math.atan2(h1 - h0, L), r, k: LOG_LEN.indexOf(L) });
  }
  const logMat = new THREE.MeshStandardMaterial({ map: barkC, roughness: 0.95, metalness: 0, color: 0x9a8a7a });
  const logMeshes = LOG_LEN.map((L) => {
    // along +z, unit radius; bark uv: u around, v along (metres / 1.2)
    const g = new THREE.CylinderGeometry(1, 1.06, L, 10, 1, false).rotateX(Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * L / 1.2);
    const m = new THREE.InstancedMesh(g, logMat, logs.length);
    m.count = 0; m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  });
  {
    const e = new THREE.Euler(), qq2 = new THREE.Quaternion(), M = new THREE.Matrix4(), S = new THREE.Vector3(), P = new THREE.Vector3();
    for (const lg of logs) {
      e.set(-lg.pitch, lg.yaw, 0, 'YXZ'); qq2.setFromEuler(e);
      M.compose(P.set(lg.x, lg.y, lg.z), qq2, S.set(lg.r, lg.r, 1));
      const m = logMeshes[lg.k];
      m.setMatrixAt(m.count++, M);
      logStream.add(lg.x, lg.z, RAPIER.ColliderDesc.cylinder(LOG_LEN[lg.k] / 2, lg.r).setTranslation(lg.x, lg.y, lg.z)
        .setRotation(new THREE.Quaternion().setFromEuler(e).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))).setFriction(0.7), SURFACES.wood);
    }
    for (const m of logMeshes) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
  }

  // ---- trunk colliders are streamed in around the truck: Rapier's step cost grows with static colliders too
  // (16k trunks: +1.9 ms per 240 Hz step), so only chunks within ~70 m have them (a few hundred trunks).
  const chunksOf = (ci) => chunks[ci];
  const activeChunks = new Map(); // chunk index -> [colliders]
  const addChunk = (ci) => {
    const list = [];
    for (const i of chunksOf(ci)) {
      const t = trees[i], v = variants[t.v];
      const r = Math.max(0.12, v.geo.trunkR * t.s * 0.95);
      const c = world.createCollider(RAPIER.ColliderDesc.cylinder(1.6, r).setTranslation(t.x, t.y + 1.4, t.z).setFriction(0.6));
      colliderSurface.set(c.handle, SURFACES.wood);
      list.push(c);
    }
    activeChunks.set(ci, list);
  };
  const removeChunk = (ci) => {
    for (const c of activeChunks.get(ci)) { colliderSurface.delete(c.handle); world.removeCollider(c, false); }
    activeChunks.delete(ci);
  };
  let physChunk = -1;

  // ---- ground data: forest floor under the crowns, less grass, a little darker
  const gd = terrainView.groundData, DN = terrainView.groundN;
  for (const t of trees) {
    const v = variants[t.v];
    const R = v.geo.crownR * t.s * (v.kind === 'birch' ? 0.8 : 1.0) + 1.0;
    const cx = Math.round(t.x + HALF), cz = Math.round(t.z + HALF);
    const ri = Math.ceil(R);
    for (let dx = -ri; dx <= ri; dx++) for (let dz = -ri; dz <= ri; dz++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= DN || z >= DN) continue;
      const d = Math.hypot(dx, dz) / R;
      if (d > 1) continue;
      const o = (z * DN + x) * 4;
      const w = 1 - d * d;
      const canopy = v.kind === 'dead' ? 0.3 : v.kind === 'birch' ? 0.65 : 1.0;
      gd[o + 1] = Math.min(255, Math.max(gd[o + 1], 255 * w * canopy));
      gd[o + 3] = Math.max(0, gd[o + 3] - 255 * w * canopy * 0.55);
      gd[o] = Math.max(100, gd[o] - 50 * w * canopy - (d < 0.25 ? 30 : 0));
    }
  }
  terrainView.groundDataChanged();

  // ---- near meshes (per variant: trunk + crown instanced)
  const fade = { value: new THREE.Vector2(43, 50) };
  const viewPos = { value: new THREE.Vector3() };
  const uniformsT = { uWind: windUniform, uFade: fade, uViewPos: viewPos };
  const near = variants.map((v, i) => {
    const trunkMat = new THREE.MeshStandardMaterial({ map: v.barkTex, roughness: 0.92, metalness: 0, color: v.kind === 'birch' ? 0xe8e4dc : 0xb8a898 });
    patchTreeMaterial(trunkMat, 'trunk', uniformsT);
    const crownMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, color: v.kind === 'birch' ? 0xf0ffe0 : 0xffffff });
    patchTreeMaterial(crownMat, 'crown', uniformsT, { translucent: true });
    const depthT = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchTreeMaterial(depthT, 'trunkDepth', uniformsT);
    const depthC = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide });
    patchTreeMaterial(depthC, 'crownDepth', uniformsT);
    const MAXN = 1600;
    const trunk = new THREE.InstancedMesh(v.geo.trunk, trunkMat, MAXN);
    const crown = new THREE.InstancedMesh(v.geo.crown, crownMat, MAXN);
    for (const m of [trunk, crown]) {
      m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
    }
    trunk.customDepthMaterial = depthT;
    crown.customDepthMaterial = depthC;
    return { trunk, crown, crownMat, MAXN };
  });

  // ---- impostors (all trees; the shader hides the ones the near meshes cover)
  const imp = bakeImpostors(renderer, variants);
  const impGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const impMat = new THREE.MeshStandardMaterial({ map: imp.albedo, alphaTest: 0.45, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const heights = variants.map(v => v.geo.height * 1.04);
  const impUniforms = { tImpN: { value: imp.normal }, uImpRows: { value: imp.rows }, uImpH: { value: heights }, uFade: fade, uViewPos: viewPos };
  const IMP_VERT = /* glsl */`
attribute float aVar;
uniform float uImpRows;
uniform float uImpH[${variants.length}];
uniform vec2 uFade;
uniform vec3 uViewPos;
varying vec2 vImpUv;
varying float vImpYaw;
varying float vTreeDist;
`;
  const patchImp = (m, depth) => {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, impUniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + IMP_VERT)
        .replace('#include <uv_vertex>', `
vec3 ip = instanceMatrix[3].xyz;
float isc = length(instanceMatrix[0].xyz);
float yaw = atan(-instanceMatrix[0].z, instanceMatrix[0].x);
vec3 toCam = cameraPosition - ip;
float azW = atan(toCam.x, toCam.z);
float vf = (azW - yaw) / 6.2831853 * ${VIEWS}.0;
float view = mod(floor(vf + 0.5), ${VIEWS}.0);
float H = uImpH[int(aVar)] * isc;
vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
vImpYaw = yaw;
vTreeDist = distance(ip, uViewPos);
vec2 cuv = vec2(position.x + 0.5, position.y);
vImpUv = vec2((view + cuv.x) / ${VIEWS}.0, (uImpRows - 1.0 - aVar + cuv.y) / uImpRows);
#ifdef USE_MAP
vMapUv = vImpUv;
#endif`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vec3(toCam.x, 0.0, toCam.z));')
        .replace('#include <begin_vertex>', `vec3 transformed = right * position.x * H * 0.5 + vec3(0.0, position.y * H, 0.0);`)
        .replace('#include <project_vertex>', `
vec4 mvPosition = viewMatrix * vec4(ip + transformed, 1.0);
gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
vec4 worldPosition = vec4(ip + transformed, 1.0);
#endif`)
        .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalMatrix * objectNormal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tImpN;
uniform vec2 uFade;
varying vec2 vImpUv;
varying float vImpYaw;
varying float vTreeDist;
float ditherHash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (ditherHash(gl_FragCoord.xy) >= smoothstep(uFade.x, uFade.y, vTreeDist)) discard;`);
      if (!depth) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
float faceDirection = 1.0;
vec3 nObj = texture2D(tImpN, vImpUv).xyz * 2.0 - 1.0;
float cy = cos(vImpYaw), sy = sin(vImpYaw);
vec3 nW = normalize(vec3(cy * nObj.x + sy * nObj.z, nObj.y, -sy * nObj.x + cy * nObj.z));
vec3 normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;`);
    };
    m.customProgramCacheKey = () => 'impostor-' + (depth ? 'd' : 'c');
  };
  patchImp(impMat, false);
  const impDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: imp.albedo, alphaTest: 0.45, side: THREE.DoubleSide });
  patchImp(impDepth, true);
  const impMesh = new THREE.InstancedMesh(impGeo, impMat, trees.length);
  const aVar = new Float32Array(trees.length);
  const mtx = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const matrices = new Float32Array(trees.length * 16);
  trees.forEach((t, i) => {
    qq.setFromAxisAngle(up, t.yaw); sc.setScalar(t.s); ps.set(t.x, t.y - 0.15, t.z);
    mtx.compose(ps, qq, sc);
    mtx.toArray(matrices, i * 16);
    impMesh.setMatrixAt(i, mtx);
    aVar[i] = t.v;
  });
  impMesh.geometry.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 1));
  impMesh.frustumCulled = false;
  impMesh.castShadow = true; impMesh.receiveShadow = true;
  impMesh.customDepthMaterial = impDepth;
  group.add(impMesh);

  // ---- chunk index for near selection
  const chunks = Array.from({ length: CN * CN }, () => []);
  trees.forEach((t, i) => {
    const cx = Math.min(CN - 1, Math.max(0, Math.floor((t.x + HALF) / CHUNK))), cz = Math.min(CN - 1, Math.max(0, Math.floor((t.z + HALF) / CHUNK)));
    chunks[cz * CN + cx].push(i);
  });

  // stream trunk colliders around a point (the truck): chunks within 2 chunk rings stay loaded
  const updatePhysics = (x, z) => {
    logStream.update(x, z);
    const cx = Math.floor((x + HALF) / CHUNK), cz = Math.floor((z + HALF) / CHUNK);
    const ci = cz * CN + cx;
    if (ci === physChunk) return;
    physChunk = ci;
    const want = new Set();
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const x2 = cx + a, z2 = cz + b;
      if (x2 >= 0 && z2 >= 0 && x2 < CN && z2 < CN) want.add(z2 * CN + x2);
    }
    for (const k of [...activeChunks.keys()]) if (!want.has(k)) removeChunk(k);
    for (const k of want) if (!activeChunks.has(k)) addChunk(k);
  };

  let lastX = 1e9, lastZ = 1e9, nearR = 50; // full-detail tree radius (m); beyond it trees are impostors
  const counts = new Int32Array(variants.length);
  const api = {
    group, trees, logs, variants, near, impMesh, atlas, fade, updatePhysics,
    get colliderCount() { let n = 0; for (const l of activeChunks.values()) n += l.length; return n; },
    configure(q) {
      const r = q.treeNear || 50; // presets: 40 m low/medium, 50 m otherwise
      fade.value.set(r * 0.86, r);
      nearR = r;
      impMesh.castShadow = !!q.impostorShadows;
      lastX = 1e9;
      for (const n of near) n.crownMat.alphaToCoverage = q.msaa > 0;
    },
    update(dt, camera) {
      viewPos.value.copy(camera.position);
      const cx = camera.position.x, cz = camera.position.z;
      if (Math.hypot(cx - lastX, cz - lastZ) < 0.75) return;
      lastX = cx; lastZ = cz;
      counts.fill(0);
      const R = nearR + 2, R2 = R * R;
      const c0x = Math.max(0, Math.floor((cx - R + HALF) / CHUNK)), c1x = Math.min(CN - 1, Math.floor((cx + R + HALF) / CHUNK));
      const c0z = Math.max(0, Math.floor((cz - R + HALF) / CHUNK)), c1z = Math.min(CN - 1, Math.floor((cz + R + HALF) / CHUNK));
      for (let a = c0x; a <= c1x; a++) for (let b = c0z; b <= c1z; b++) {
        for (const i of chunks[b * CN + a]) {
          const t = trees[i];
          const dx = t.x - cx, dz = t.z - cz;
          if (dx * dx + dz * dz > R2) continue;
          const n = near[t.v];
          const k = counts[t.v];
          if (k >= n.MAXN) continue;
          n.trunk.instanceMatrix.array.set(matrices.subarray(i * 16, i * 16 + 16), k * 16);
          counts[t.v] = k + 1;
        }
      }
      near.forEach((n, vi) => {
        n.crown.instanceMatrix.array.set(n.trunk.instanceMatrix.array.subarray(0, counts[vi] * 16));
        n.trunk.count = n.crown.count = counts[vi];
        for (const m of [n.trunk, n.crown]) {
          m.instanceMatrix.clearUpdateRanges();
          m.instanceMatrix.addUpdateRange(0, counts[vi] * 16);
          m.instanceMatrix.needsUpdate = true;
        }
      });
    },
  };
  return api;
}
