import * as THREE from 'three';
import { MAP_SIZE } from './terrain.js';
import { SURFACES } from '../vehicle/tire.js';
import { makeFoliageAtlas } from './foliage.js';
import { TREE_KINDS } from './treeKinds.js';
import { PAT_GLSL, PAT } from './origin.js';

// m from the camera: past these only the far share of the trees is drawn (windowBake.js SUB_SHARE)
export const SUB_FADE = [220, 260];
import { makeBarkTexture } from './textures.js';
import { ColliderStream } from './colliderStream.js';
import { SHADOW_LAYER } from '../render/cascadeShadow.js';
import { CLOUD } from './clouds.js';

// Trees and undergrowth. ~12k trees in forests (spruce, pine, birch, dead snags), and out in the meadows lone oaks
// and small groups of trees in blossom; each with a trunk collider.
// - Near the camera (preset radius, 40-50 m) trees are real geometry: bark trunks and branches plus alpha-tested
//   foliage cards, swaying in the wind (also in the shadow pass, where a crown casts from a lighter twin).
// - Beyond that every tree is an impostor: a camera-facing card baked from 8 directions at startup (albedo +
//   normals, so it is lit like the real tree), cross-faded with a dither.
// - Undergrowth and fallen logs near the camera. The forest also writes the ground data map (forest floor under crowns).

const HALF = MAP_SIZE / 2;
const VIEWS = 8, CELL_W = 192, CELL_H = 384;
const CHUNK = 32, CN = MAP_SIZE / CHUNK;

// (the phases by the tree's place: in the pattern frame, origin.js, at frequencies that repeat over its period)
const WIND_GLSL = /* glsl */`
uniform vec4 uWind;   // dir x, dir z, strength, time
${PAT_GLSL}attribute float aWind;
vec3 windOffset(vec3 objPos, float w) {
  vec3 ip = instanceMatrix[3].xyz;
  vec2 pq = ip.xz + uPat;
  float ph = dot(pq, vec2(0.070563, 0.113515));
  float t = uWind.w;
  float sway = sin(t * 0.85 + ph) * 0.55 + sin(t * 1.9 + ph * 1.7) * 0.2 + 0.45;
  float gust = 0.6 + 0.4 * sin(t * 0.31 + pq.x * 0.012272 + pq.y * 0.009204);
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
      // the crown casts from its twin, 1.35x larger, which also covers the crown's own sunlit (moonlit) side: look
      // the shadow up half a crown radius towards the light, so the outer leaves come out of it and only the inside
      // stays shaded (the impostor goes a whole radius; without this the near crown went much darker than its
      // impostor, nearly black by moonlight)
      sh.uniforms.uCrownSun = { value: CLOUD.sun };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uCrownSun;')
        .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
vSunShadowWorldPosition.xyz += uCrownSun.xyz * (${(0.5 * opts.crownR).toFixed(2)} * length(instanceMatrix[0].xyz));
#endif`);
      // foliage cards: both faces keep the outward (crown-volume) normal; DoubleSide's flip shaded back faces as if
      // they faced into the crown
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL);
      // a touch of light through the leaves when backlit; a soft crown (opts.soft: the meadow trees) also wraps
      // the sunlight round to its shade side and glows through its petals, so it is never bright on one side
      // and dull on the other
      const soft = opts.soft ? `
#if NUM_SUN_LIGHTS > 0
{
  float ndl = dot(normal, sunLights[0].direction);
  float wrapExtra = max(0.0, (ndl + 0.7) / 1.7) - max(0.0, ndl);
  outgoingLight += diffuseColor.rgb * sunLights[0].color * (wrapExtra * 0.85 + max(0.0, -ndl) * 0.3) * (1.0 / 3.14159);
}
#endif` : '';
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
outgoingLight += diffuseColor.rgb * 0.12 * reflectedLight.directDiffuse;${soft}
#if NUM_SUN_LIGHTS > 0
{
  // backlit, the leaves glow (the direct diffuse carries the shadow: leaves in shade stay dark)
  float lBack = max(0.0, -dot(normalize(vViewPosition), sunLights[0].direction));
  outgoingLight += reflectedLight.directDiffuse * vec3(1.1, 1.15, 0.6) * (pow(lBack, 1.5) * 1.2);
}
#endif
#include <opaque_fragment>`);
    }
  };
  mat.customProgramCacheKey = () => 'tree-' + kind + (opts.soft ? '-soft' : '') + (opts.crownR ? '-r' + opts.crownR.toFixed(2) : '') + '-v3';
}

// The crown's shadow comes from a lighter twin: every other card, scaled up about its centre (the shadow is soft,
// so half the cards cast nearly the same shadow at half the cost). Drawn only into shadow maps (SHADOW_LAYER).
function shadowCrown(geo, scale = 1.35) {
  const P = geo.attributes.position, N = geo.attributes.normal, UV = geo.attributes.uv, W = geo.attributes.aWind;
  const cards = P.count / 4, keep = Math.ceil(cards / 2);
  const pos = new Float32Array(keep * 12), nor = new Float32Array(keep * 12), uvs = new Float32Array(keep * 8), wind = new Float32Array(keep * 4), idx = [];
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  let k = 0;
  for (let i = 0; i < cards; i += 2, k++) {
    c.set(0, 0, 0);
    for (let j = 0; j < 4; j++) c.add(v.fromBufferAttribute(P, i * 4 + j));
    c.multiplyScalar(0.25);
    for (let j = 0; j < 4; j++) {
      const a = i * 4 + j, b = k * 4 + j;
      v.fromBufferAttribute(P, a).sub(c).multiplyScalar(scale).add(c);
      pos.set([v.x, v.y, v.z], b * 3);
      nor.set([N.getX(a), N.getY(a), N.getZ(a)], b * 3);
      uvs.set([UV.getX(a), UV.getY(a)], b * 2);
      wind[b] = W.getX(a);
    }
    const o = k * 4;
    idx.push(o, o + 2, o + 1, o + 2, o + 3, o + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- impostor baking
const BAKE_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN; varying vec3 vCol;
void main() {
  vUv = uv; vN = normal; vCol = vec3(1.0);
#ifdef USE_COLOR
  vCol = color;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BAKE_FRAG = /* glsl */`
uniform sampler2D tMap; uniform float uMode, uAlphaTest; uniform vec3 uTint;
varying vec2 vUv; varying vec3 vN; varying vec3 vCol;
void main() {
  vec4 c = texture2D(tMap, vUv);
  if (c.a < uAlphaTest) discard;
  vec3 n = normalize(vN);
  gl_FragColor = uMode < 0.5 ? vec4(c.rgb * uTint * vCol, 1.0) : vec4(n * 0.5 + 0.5, 1.0);
}`;

// the impostor's width over its height: half for the slim conifers, wider for a round crown
function impostorWidth(v) {
  const p = v.geo.crown.getAttribute('position');
  let r = 0;
  for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getZ(i)));
  return Math.max(0.5, (2 * r * 1.04) / (v.geo.height * 1.04));
}

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
        new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide, uniforms: { tMap: { value: v.atlas }, uMode: { value: mode }, uAlphaTest: { value: 0.45 }, uTint: { value: new THREE.Color(1, 1, 1) } }, vertexColors: !!v.geo.crown.attributes.color }),
      ];
      const t = new THREE.Mesh(v.geo.trunk, mats[0]), c = new THREE.Mesh(v.geo.crown, mats[1]);
      scene.add(t, c);
      const H = v.geo.height * 1.04, hw = H * v.impW / 2;
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
// win: the first window's data (windowBake.js: tree placements, logs). Each new window: prepareWindow / applyWindow
export function buildTrees(RAPIER, world, colliderSurface, renderer, windUniform, win) {
  const group = new THREE.Group(); group.name = 'trees';
  const atlas = makeFoliageAtlas();
  const barkC = makeBarkTexture('conifer'), barkB = makeBarkTexture('birch');
  barkC.wrapS = barkC.wrapT = barkB.wrapS = barkB.wrapT = THREE.RepeatWrapping;
  const variants = TREE_KINDS.map(k => ({ kind: k.kind, geo: k.build(), barkTex: k.bark === 'birch' ? barkB : barkC }));
  for (const v of variants) { v.atlas = atlas; v.impW = impostorWidth(v); }

  // ---- near meshes (per variant: trunk + crown instanced)
  const fade = { value: new THREE.Vector2(43, 50) };
  const viewPos = { value: new THREE.Vector3() };
  const uniformsT = { uWind: windUniform, uFade: fade, uViewPos: viewPos, uPat: PAT };
  const near = variants.map((v, i) => {
    const trunkMat = new THREE.MeshStandardMaterial({ map: v.barkTex, roughness: 0.92, metalness: 0, color: v.kind === 'birch' ? 0xe8e4dc : v.kind === 'blossom' ? 0x8a7468 : v.kind === 'oak' ? 0x9a8c7c : 0xb8a898 });
    patchTreeMaterial(trunkMat, 'trunk', uniformsT);
    const crownMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, color: v.kind === 'birch' ? 0xf0ffe0 : 0xffffff, vertexColors: !!v.geo.crown.attributes.color });
    // the lamps light the cards from whichever side faces them (lamps.js), as on the grass: the cards' normals point
    // out of the crown, mostly up, so the undersides of the branches stood black in the headlamps
    crownMat.defines = { TK_THIN: '' };
    patchTreeMaterial(crownMat, 'crown', uniformsT, { translucent: true, soft: v.kind === 'blossom' || v.kind === 'oak', crownR: v.geo.crownR });
    const depthT = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchTreeMaterial(depthT, 'trunkDepth', uniformsT);
    const depthC = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide });
    patchTreeMaterial(depthC, 'crownDepth', uniformsT);
    const MAXN = 1600;
    const trunk = new THREE.InstancedMesh(v.geo.trunk, trunkMat, MAXN);
    trunk.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const crown = new THREE.InstancedMesh(v.geo.crown, crownMat, MAXN);
    // the crown casts from its lighter twin, which only the shadow maps draw (its depth material takes the
    // crown material's map, alpha test and side)
    const crownShadow = new THREE.InstancedMesh(shadowCrown(v.geo.crown), crownMat, MAXN);
    crownShadow.layers.set(SHADOW_LAYER);
    for (const m of [trunk, crown, crownShadow]) {
      m.instanceMatrix = trunk.instanceMatrix;   // one buffer, uploaded once
      m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
    crown.castShadow = false;
    crownShadow.receiveShadow = false;
    trunk.customDepthMaterial = depthT;
    crownShadow.customDepthMaterial = depthC;
    return { trunk, crown, crownShadow, crownMat, MAXN };
  });

  // ---- impostors (all trees; the shader hides the ones the near meshes cover)
  const imp = bakeImpostors(renderer, variants);
  const impGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const impMat = new THREE.MeshStandardMaterial({ map: imp.albedo, alphaTest: 0.45, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  impMat.defines = { TK_THIN: '' };   // lit by the lamps like the near crowns
  const heights = variants.map(v => v.geo.height * 1.04), widths = variants.map(v => v.impW);
  const softs = variants.map(v => v.kind === 'blossom' ? 1 : v.kind === 'oak' ? 0.6 : 0);
  // uImpSun: towards the sun (or moon), clouds.js keeps it current
  // uSubFade: past x..y m only the far share of the trees is drawn (windowBake.js SUB_SHARE: the far ring has only
  // those), a little bigger to fill in; so the window moving (its trees replacing the ring's) shows nothing
  const subFade = { value: new THREE.Vector2(SUB_FADE[0], SUB_FADE[1]) };
  const impUniforms = { tImpN: { value: imp.normal }, uImpRows: { value: imp.rows }, uImpH: { value: heights }, uImpW: { value: widths }, uImpSoft: { value: softs }, uImpSun: { value: CLOUD.sun }, uFade: fade, uViewPos: viewPos, uSubFade: subFade };
  const IMP_VERT = /* glsl */`
attribute float aVar;
attribute float aSub;
uniform vec2 uSubFade;
varying float vSubKeep;
uniform float uImpRows;
uniform float uImpH[${variants.length}];
uniform float uImpW[${variants.length}];
uniform float uImpSoft[${variants.length}];
uniform vec4 uImpSun;
uniform vec2 uFade;
uniform vec3 uViewPos;
varying vec2 vImpUv;
varying float vImpYaw;
varying float vTreeDist;
varying vec3 vImpRound;   // a round crown's normal (world), for the soft meadow trees
varying float vImpSoft;
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
vTreeDist = distance(ip, uViewPos);
float subK = smoothstep(uSubFade.x, uSubFade.y, vTreeDist);
vSubKeep = aSub > 0.5 ? 1.0 : 1.0 - subK;
float H = uImpH[int(aVar)] * isc * (aSub > 0.5 ? 1.0 + 0.22 * subK : 1.0);
vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
vImpYaw = yaw;
vImpSoft = uImpSoft[int(aVar)];
{
  // the crown as a ball (centre at 0.62 of the height): left / right, up / down and towards the viewer
  vec2 q = vec2(position.x * 2.0, (position.y - 0.62) / 0.38);
  vec3 fwd = normalize(vec3(toCam.x, 0.0, toCam.z));
  vImpRound = right * q.x + vec3(0.0, 0.8 * q.y, 0.0) + fwd * sqrt(max(0.0, 1.0 - 0.5 * dot(q, q)));
}
vec2 cuv = vec2(position.x + 0.5, position.y);
vImpUv = vec2((view + cuv.x) / ${VIEWS}.0, (uImpRows - 1.0 - aVar + cuv.y) / uImpRows);
#ifdef USE_MAP
vMapUv = vImpUv;
#endif`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vec3(toCam.x, 0.0, toCam.z));')
        .replace('#include <begin_vertex>', `vec3 transformed = right * position.x * H * uImpW[int(aVar)] + vec3(0.0, position.y * H, 0.0);`)
        .replace('#include <project_vertex>', `
vec4 mvPosition = viewMatrix * vec4(ip + transformed, 1.0);
gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
vec4 worldPosition = vec4(ip + transformed, 1.0);
#endif`)
        .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalMatrix * objectNormal;')
        // the card is flat, so its own sun-facing twin (the shadow pass) shades its far half: look the shadow up
        // a crown's radius towards the light, outside the tree; shade from the trees around still lands
        .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
vSunShadowWorldPosition.xyz += uImpSun.xyz * (0.5 * H * uImpW[int(aVar)]);
#endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tImpN;
uniform vec2 uFade;
varying vec2 vImpUv;
varying float vImpYaw;
varying float vTreeDist;
varying vec3 vImpRound;
varying float vImpSoft;
varying float vSubKeep;
float ditherHash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (ditherHash(gl_FragCoord.xy) >= min(smoothstep(uFade.x, uFade.y, vTreeDist), vSubKeep)) discard;`);
      if (!depth) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
float faceDirection = 1.0;
vec3 nObj = texture2D(tImpN, vImpUv).xyz * 2.0 - 1.0;
float cy = cos(vImpYaw), sy = sin(vImpYaw);
vec3 nW = normalize(vec3(cy * nObj.x + sy * nObj.z, nObj.y, -sy * nObj.x + cy * nObj.z));
nW = normalize(mix(nW, normalize(vImpRound), 0.55 * vImpSoft));
vec3 normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;`)
        // light through the leaves, as on the near crowns (patchTreeMaterial): soft crowns wrap the sun round
        .replace('#include <opaque_fragment>', `
outgoingLight += diffuseColor.rgb * 0.12 * reflectedLight.directDiffuse;
#if NUM_SUN_LIGHTS > 0
{
  // backlit, the leaves glow (the direct diffuse carries the shadow: leaves in shade stay dark)
  float lBack = max(0.0, -dot(normalize(vViewPosition), sunLights[0].direction));
  outgoingLight += reflectedLight.directDiffuse * vec3(1.1, 1.15, 0.6) * (pow(lBack, 1.5) * 1.2);
}
#endif
#if NUM_SUN_LIGHTS > 0
if (vImpSoft > 0.5) {
  float ndl = dot(normal, sunLights[0].direction);
  float wrapExtra = max(0.0, (ndl + 0.7) / 1.7) - max(0.0, ndl);
  outgoingLight += diffuseColor.rgb * sunLights[0].color * (wrapExtra * 0.85 + max(0.0, -ndl) * 0.3) * (1.0 / 3.14159);
}
#endif
#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'impostor-' + (depth ? 'd' : 'c') + '-v3';
  };
  patchImp(impMat, false);
  const impDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: imp.albedo, alphaTest: 0.45, side: THREE.DoubleSide });
  patchImp(impDepth, true);
  const mtx = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  // ---- fallen logs (instanced, three lengths), with streamed colliders
  const LOG_LEN = [4.2, 6.5, 9.0];
  const logMat = new THREE.MeshStandardMaterial({ map: barkC, roughness: 0.95, metalness: 0, color: 0x9a8a7a });
  const logGeos = LOG_LEN.map((L) => {
    // along +z, unit radius; bark uv: u around, v along (metres / 1.2)
    const g = new THREE.CylinderGeometry(1, 1.06, L, 10, 1, false).rotateX(Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * L / 1.2);
    return g;
  });
  const logStream = new ColliderStream(RAPIER, world, colliderSurface);
  const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  // ---- the current window: trees (x, y, z, s, yaw, v), their matrices, impostors, chunk index, logs
  const cur = { trees: [], matrices: new Float32Array(0), impMesh: null, chunks: [], logMeshes: [], logItems: [] };
  const activeChunks = new Map(); // chunk index -> [trunk colliders]
  let physChunk = -1, lastX = 1e9, lastZ = 1e9, nearR = 50, impShadow = true, version = 0;

  // build a window's trees and logs (not yet in the scene), in two steps
  const prepare = (w) => {
    const next = {};
    return { next, steps: [() => {
      // the window's trees (x, y, z, s, yaw, v, far share), then the far ring's (x, y, z, s, yaw, v: all far share)
      const T = w.trees, n = T.length / 7, F = w.farTrees || new Float32Array(0), nf = F.length / 6, total = n + nf;
      const trees = new Array(n), matrices = new Float32Array(n * 16), aVar = new Float32Array(Math.max(1, total)), aSub = new Float32Array(Math.max(1, total));
      const geo = impGeo.clone();
      const impMesh = new THREE.InstancedMesh(geo, impMat, Math.max(1, total));
      for (let i = 0; i < n; i++) {
        const t = trees[i] = { x: T[i * 7], y: T[i * 7 + 1], z: T[i * 7 + 2], s: T[i * 7 + 3], yaw: T[i * 7 + 4], v: T[i * 7 + 5] };
        qq.setFromAxisAngle(up, t.yaw); sc.setScalar(t.s); ps.set(t.x, t.y - 0.15, t.z);
        mtx.compose(ps, qq, sc);
        mtx.toArray(matrices, i * 16);
        impMesh.setMatrixAt(i, mtx);
        aVar[i] = t.v; aSub[i] = T[i * 7 + 6];
      }
      for (let i = 0; i < nf; i++) {
        qq.setFromAxisAngle(up, F[i * 6 + 4]); sc.setScalar(F[i * 6 + 3]); ps.set(F[i * 6], F[i * 6 + 1] - 0.15, F[i * 6 + 2]);
        mtx.compose(ps, qq, sc);
        impMesh.setMatrixAt(n + i, mtx);
        aVar[n + i] = F[i * 6 + 5]; aSub[n + i] = 1;
      }
      impMesh.count = total;
      geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 1));
      geo.setAttribute('aSub', new THREE.InstancedBufferAttribute(aSub, 1));
      impMesh.frustumCulled = false;
      impMesh.castShadow = impShadow; impMesh.receiveShadow = true;
      impMesh.customDepthMaterial = impDepth;
      // chunk index for near selection
      const chunks = Array.from({ length: CN * CN }, () => []);
      trees.forEach((t, i) => {
        const cx = Math.min(CN - 1, Math.max(0, Math.floor((t.x + HALF) / CHUNK))), cz = Math.min(CN - 1, Math.max(0, Math.floor((t.z + HALF) / CHUNK)));
        chunks[cz * CN + cx].push(i);
      });
      Object.assign(next, { trees, matrices, impMesh, chunks });
    }, () => {
      const L7 = w.logs, nl = L7.length / 7, counts = [0, 0, 0];
      for (let i = 0; i < nl; i++) counts[L7[i * 7 + 6]]++;
      const logMeshes = logGeos.map((g, k) => {
        const m = new THREE.InstancedMesh(g, logMat, Math.max(1, counts[k]));
        m.count = 0; m.castShadow = true; m.receiveShadow = true;
        return m;
      });
      const e = new THREE.Euler(), S = new THREE.Vector3(), P = new THREE.Vector3(), logItems = [];
      for (let i = 0; i < nl; i++) {
        const [x, y, z, yaw, pitch, r, k] = L7.subarray(i * 7, i * 7 + 7);
        e.set(-pitch, yaw, 0, 'YXZ'); qq.setFromEuler(e);
        mtx.compose(P.set(x, y, z), qq, S.set(r, r, 1));
        const m = logMeshes[k];
        m.setMatrixAt(m.count++, mtx);
        const q = qq.clone().multiply(qX);
        logItems.push({ x, z, make: () => RAPIER.ColliderDesc.cylinder(LOG_LEN[k] / 2, r).setTranslation(x, y, z).setRotation(q).setFriction(0.7) });
      }
      for (const m of logMeshes) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
      Object.assign(next, { logMeshes, logItems });
    }] };
  };
  const apply = (next) => {
    if (cur.impMesh) { group.remove(cur.impMesh); cur.impMesh.geometry.dispose(); cur.impMesh.dispose(); }
    for (const m of cur.logMeshes) { group.remove(m); m.dispose(); }
    Object.assign(cur, next);
    group.add(cur.impMesh);
    for (const m of cur.logMeshes) group.add(m);
    // colliders: all of the old window's go, the new ones stream in round the truck
    for (const k of [...activeChunks.keys()]) removeChunk(k);
    logStream.clear();
    for (const it of next.logItems) logStream.add(it.x, it.z, it.make, SURFACES.wood);
    physChunk = -1; lastX = 1e9;
    version++;
  };

  // ---- trunk colliders are streamed in around the truck: Rapier's step cost grows with static colliders too
  // (16k trunks: +1.9 ms per 240 Hz step), so only chunks within ~70 m have them (a few hundred trunks).
  const addChunk = (ci) => {
    const list = [];
    for (const i of cur.chunks[ci]) {
      const t = cur.trees[i], v = variants[t.v];
      const r = Math.max(0.12, v.geo.trunkR * t.s * 0.95);
      const c = world.createCollider(RAPIER.ColliderDesc.cylinder(1.6, r).setTranslation(t.x, t.y + 1.4, t.z).setFriction(0.6));
      colliderSurface.set(c.handle, SURFACES.wood);
      list.push(c);
    }
    activeChunks.set(ci, list);
  };
  function removeChunk(ci) {
    for (const c of activeChunks.get(ci)) { colliderSurface.delete(c.handle); world.removeCollider(c, false); }
    activeChunks.delete(ci);
  }
  { const first = prepare(win); for (const s of first.steps) s(); apply(first.next); }

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

  const counts = new Int32Array(variants.length);
  const api = {
    group, variants, near, atlas, fade, updatePhysics,
    get trees() { return cur.trees; },
    get impMesh() { return cur.impMesh; },
    get logs() { return cur.logItems; },
    get version() { return version; },
    prepareWindow: prepare, applyWindow: apply,
    get colliderCount() { let n = 0; for (const l of activeChunks.values()) n += l.length; return n; },
    configure(q) {
      const r = q.treeNear || 50; // presets: 40 m low/medium, 50 m otherwise
      fade.value.set(r * 0.86, r);
      nearR = r;
      impShadow = !!q.impostorShadows;
      if (cur.impMesh) cur.impMesh.castShadow = impShadow;
      lastX = 1e9;
      for (const n of near) n.crownMat.alphaToCoverage = q.msaa > 0;
    },
    update(dt, camera) {
      viewPos.value.copy(camera.position);
      const cx = camera.position.x, cz = camera.position.z;
      if (Math.hypot(cx - lastX, cz - lastZ) < 0.75) return;
      lastX = cx; lastZ = cz;
      counts.fill(0);
      const R = nearR + 2, R2 = R * R, { trees, matrices, chunks } = cur;
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
        n.trunk.count = n.crown.count = n.crownShadow.count = counts[vi];
        const im = n.trunk.instanceMatrix;   // shared by the crown and its twin
        im.clearUpdateRanges();
        im.addUpdateRange(0, counts[vi] * 16);
        im.needsUpdate = true;
      });
    },
  };
  return api;
}
