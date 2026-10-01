import * as THREE from 'three';
import { MAP_SIZE, CELL, N, SURF } from './terrain.js';
import { makeGroundTextures } from './textures.js';

// Chunked terrain mesh (same triangulation as Rapier's heightfield) with a splat + slope blended material.

const CHUNK = 100; // cells per chunk side

export function buildTerrainView(terrain) {
  const tex = makeGroundTextures();
  const NN = terrain.NN, H = terrain.heights;
  const half = MAP_SIZE / 2;

  // ---- splat texture from the surface grid (blurred)
  const raw = new Float32Array(NN * NN * 4);
  for (let ix = 0; ix < NN; ix++) for (let iz = 0; iz < NN; iz++) {
    const s = terrain.surface[ix * NN + iz];
    const o = (iz * NN + ix) * 4;
    raw[o] = s === SURF.dirt ? 1 : 0;
    raw[o + 1] = s === SURF.mud ? 1 : 0;
    raw[o + 2] = s === SURF.rock ? 1 : 0;
    raw[o + 3] = s === SURF.sand ? 1 : 0;
  }
  const blurred = new Float32Array(raw.length);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? raw : blurred, dst = pass === 0 ? blurred : raw;
    for (let iz = 0; iz < NN; iz++) for (let ix = 0; ix < NN; ix++) {
      let a = 0, b = 0, c = 0, d = 0, n = 0;
      for (let k = -R; k <= R; k++) {
        const x = pass === 0 ? Math.min(NN - 1, Math.max(0, ix + k)) : ix;
        const z = pass === 0 ? iz : Math.min(NN - 1, Math.max(0, iz + k));
        const o = (z * NN + x) * 4;
        a += src[o]; b += src[o + 1]; c += src[o + 2]; d += src[o + 3]; n++;
      }
      const o = (iz * NN + ix) * 4;
      dst[o] = a / n; dst[o + 1] = b / n; dst[o + 2] = c / n; dst[o + 3] = d / n;
    }
  }
  const splatData = new Uint8Array(NN * NN * 4);
  for (let i = 0; i < splatData.length; i++) splatData[i] = Math.round(raw[i] * 255);
  const splat = new THREE.DataTexture(splatData, NN, NN, THREE.RGBAFormat);
  splat.magFilter = THREE.LinearFilter;
  splat.minFilter = THREE.LinearFilter;
  splat.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const uniforms = {
    uSplat: { value: splat }, uGrass: { value: tex.grass }, uDirt: { value: tex.dirt }, uRock: { value: tex.rock },
    uMud: { value: tex.mud }, uMacro: { value: tex.macro }, uSize: { value: MAP_SIZE }, uWet: { value: 0 },
    uTrack: { value: null }, uTrackOrigin: { value: new THREE.Vector2() }, uTrackSize: { value: 64 },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uSplat, uGrass, uDirt, uRock, uMud, uMacro, uTrack;
uniform float uSize, uWet, uTrackSize;
uniform vec2 uTrackOrigin;
float gWet; float gRough;
vec4 triRock(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture2D(uRock, p.zy / 4.0) * w.x + texture2D(uRock, p.xz / 4.0) * w.y + texture2D(uRock, p.xy / 4.0) * w.z;
}`)
      .replace('#include <map_fragment>', `
{
  vec2 suv = (vWPos.xz + uSize * 0.5) / uSize;
  vec4 sp = texture2D(uSplat, suv);
  vec3 n = normalize(vWNormal);
  float dist = length(vWPos - cameraPosition);
  vec4 g1 = texture2D(uGrass, vWPos.xz / 3.2);
  vec4 g2 = texture2D(uGrass, vWPos.xz / 17.0);
  vec4 grass = mix(g1, g2, 0.35);
  vec4 d1 = texture2D(uDirt, vWPos.xz / 3.0);
  vec4 d2 = texture2D(uDirt, vWPos.xz / 15.0);
  vec4 dirt = mix(d1, d2, 0.3);
  vec4 mud = texture2D(uMud, vWPos.xz / 4.5);
  vec4 rock = triRock(vWPos, n);
  float macro = texture2D(uMacro, vWPos.xz / 160.0).r;
  float macro2 = texture2D(uMacro, vWPos.xz / 41.0 + 0.37).r;
  float slopeRock = smoothstep(0.80, 0.66, n.y);
  float wDirt = clamp(sp.r + smoothstep(0.62, 0.78, macro2) * 0.25 * (1.0 - sp.g), 0.0, 1.0);
  // grass thins out on slopes before it becomes rock
  wDirt = max(wDirt, smoothstep(0.90, 0.80, n.y) * 0.6);
  vec4 c = mix(grass, dirt, wDirt);
  // wheel ruts / tracks darken the ground (track map follows the truck)
  vec2 tuv = (vWPos.xz - uTrackOrigin) / uTrackSize + 0.5;
  float track = 0.0;
  if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) track = texture2D(uTrack, tuv).r;
  c.rgb *= 1.0 - track * 0.35;
  float wMud = sp.g;
  c = mix(c, mud, wMud);
  float wRock = max(sp.b, slopeRock);
  c = mix(c, rock, wRock);
  c.rgb *= 0.78 + 0.44 * macro;
    gWet = clamp(wMud * step(0.5, mud.a) + uWet + track * wMud * 0.5, 0.0, 1.0);
  gRough = mix(mix(0.96, 0.88, wDirt), 0.82, wRock);
  gRough = mix(gRough, 0.35, gWet);
  c.rgb *= 1.0 - gWet * 0.25;
  diffuseColor.rgb *= c.rgb;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;');
  };
  material.customProgramCacheKey = () => 'terrain-v1';

  // ---- shared index buffer, one geometry per chunk
  const V = CHUNK + 1;
  const idx = [];
  for (let a = 0; a < CHUNK; a++) for (let b = 0; b < CHUNK; b++) {
    // vertex (ix, iz) -> ix * V + iz ; Rapier diagonal runs from (x1,z0) to (x0,z1)
    const v00 = a * V + b, v10 = (a + 1) * V + b, v01 = a * V + b + 1, v11 = (a + 1) * V + b + 1;
    idx.push(v00, v01, v10, v10, v01, v11);
  }
  const index = new THREE.BufferAttribute(new Uint32Array(idx), 1);
  const group = new THREE.Group();
  const chunks = N / CHUNK;
  const hAt = (ix, iz) => H[Math.max(0, Math.min(N, ix)) * NN + Math.max(0, Math.min(N, iz))];
  for (let cx = 0; cx < chunks; cx++) for (let cz = 0; cz < chunks; cz++) {
    const pos = new Float32Array(V * V * 3), nor = new Float32Array(V * V * 3);
    for (let a = 0; a < V; a++) for (let b = 0; b < V; b++) {
      const ix = cx * CHUNK + a, iz = cz * CHUNK + b;
      const o = (a * V + b) * 3;
      pos[o] = -half + ix * CELL; pos[o + 1] = hAt(ix, iz); pos[o + 2] = -half + iz * CELL;
      const gx = (hAt(ix + 1, iz) - hAt(ix - 1, iz)) / (2 * CELL), gz = (hAt(ix, iz + 1) - hAt(ix, iz - 1)) / (2 * CELL);
      const l = Math.hypot(gx, 1, gz);
      nor[o] = -gx / l; nor[o + 1] = 1 / l; nor[o + 2] = -gz / l;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, material);
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  group.userData.material = material;
  return group;
}
