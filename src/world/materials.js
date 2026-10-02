import * as THREE from 'three';
import { LAYER, LAYER_TILE } from './textures.js';

// Shared world materials built on the GPU-baked ground layers (textures.js):
// rock: triplanar rock albedo + normal at two scales, moss / lichen on the up-facing parts, darker in the
// cracks (the layers' cavity AO). Used by the boulders, the hut's stone walls and rock outcrops.

const ROCK_PARS = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray tAlb, tLNrm;
uniform float uRockTile, uMossTile, uMoss;
varying vec3 vRWPos;
varying vec3 vRWNrm;
vec3 rN; float rAO, rMoss;
vec4 triTex(sampler2DArray t, vec3 p, vec3 w, float l, float s) {
  return texture(t, vec3(p.zy * s, l)) * w.x + texture(t, vec3(p.xz * s, l)) * w.y + texture(t, vec3(p.xy * s, l)) * w.z;
}
`;

export function makeRockMaterial(layers, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? 0xffffff, roughness: 0.85, metalness: 0, vertexColors: !!opts.vertexColors });
  const uniforms = {
    tAlb: { value: layers.albedo }, tLNrm: { value: layers.normal },
    uRockTile: { value: 1 / (opts.tile ?? 2.2) }, uMossTile: { value: 1 / LAYER_TILE[LAYER.grass] }, uMoss: { value: opts.moss ?? 1 },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRWPos;\nvarying vec3 vRWNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
{
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  vRWPos = (modelMatrix * wp).xyz;
  vec3 on = objectNormal;
  #ifdef USE_INSTANCING
  on = mat3(instanceMatrix) * on;
  #endif
  vRWNrm = normalize(mat3(modelMatrix) * on);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS)
      .replace('#include <map_fragment>', `
{
  vec3 n = normalize(vRWNrm);
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec3 p = vRWPos;
  vec4 a1 = triTex(tAlb, p, w, ${LAYER.rock}.0, uRockTile);
  vec4 a2 = triTex(tAlb, p, w, ${LAYER.rock}.0, uRockTile * 0.29);
  vec4 n1 = triTex(tLNrm, p, w, ${LAYER.rock}.0, uRockTile);
  vec3 c = mix(a1.rgb, a2.rgb, 0.4);
  // moss / grass on top, broken up by the large-scale rock height
  float up = smoothstep(0.55, 0.9, n.y) * uMoss;
  float moss = up * smoothstep(0.35, 0.65, a2.a + (n.y - 0.75));
  rMoss = moss;
  vec4 mc = texture(tAlb, vec3(p.xz * uMossTile, ${LAYER.forest}.0));
  c = mix(c, mc.rgb * vec3(0.8, 1.05, 0.7), moss * 0.85);
  // detail normal: tangent-space xy of each projection added in its plane (UDN-style blend)
  vec2 tx = (texture(tLNrm, vec3(p.zy * uRockTile, ${LAYER.rock}.0)).xy * 2.0 - 1.0);
  vec2 ty = (texture(tLNrm, vec3(p.xz * uRockTile, ${LAYER.rock}.0)).xy * 2.0 - 1.0);
  vec2 tz = (texture(tLNrm, vec3(p.xy * uRockTile, ${LAYER.rock}.0)).xy * 2.0 - 1.0);
  rN = normalize(n + (vec3(0.0, tx.y, tx.x) * w.x + vec3(ty.x, 0.0, ty.y) * w.y + vec3(tz.x, tz.y, 0.0) * w.z) * 0.9);
  rAO = mix(1.0, n1.a, 0.85);
  diffuseColor.rgb *= c;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.82, 0.95, rMoss);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rN, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= rAO; reflectedLight.indirectSpecular *= rAO;');
  };
  mat.customProgramCacheKey = () => 'rock-tri-v1' + (opts.vertexColors ? '-vc' : '');
  return mat;
}
