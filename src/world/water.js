import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { NOISE_GLSL } from './textures.js';

// Water: the lake, the stream (with the ford on the outer loop) and muddy pools in the mud holes.
// Visual only (the physics has no water): every surface lies over a real terrain bed the truck drives on.
// - The depth of the water column comes from the physics heightfield in the shader (same triangle split),
//   so there is no depth pre-pass: shallow water shows the bed, deep water absorbs it, the waterline is soft.
// - Lit as a smooth dielectric (MeshStandardMaterial underneath): sky reflection from the environment map,
//   sun glints, tree shadows; Fresnel decides how much of the bed shows through (premultiplied blending).
// - Ripples: a baked tileable normal map, two layers; the stream's layers scroll down the flow, faster
//   where it is steep; foam along the shore and in fast shallow water.

const RIPPLE_FRAG = /* glsl */`
${NOISE_GLSL}
varying vec2 vUv;
float H(vec2 uv) {
  vec2 w = vec2(pfbm(uv + 0.13, 3.0, 3), pfbm(uv + 0.71, 3.0, 3));
  return pfbm(uv + (w - 0.5) * 0.12, 5.0, 5);
}
void main() {
  float e = 1.0 / 2048.0;
  float h0 = H(vUv), hx = H(vUv + vec2(e, 0.0)), hy = H(vUv + vec2(0.0, e));
  // slope in "per tile" units, scaled down to gentle ripples (the shader scales it again)
  vec2 sl = vec2(h0 - hx, h0 - hy) / e * 0.012;
  vec3 n = normalize(vec3(sl, 1.0));
  float foam = pfbm(vUv + 0.37, 12.0, 3);
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, foam, h0);
}`;

function bakeRipples(renderer, size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
  rt.texture.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: RIPPLE_FRAG, depthTest: false, depthWrite: false });
  const q = new FullScreenQuad(mat), prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); q.render(renderer); renderer.setRenderTarget(prev);
  mat.dispose(); q.dispose();
  return rt.texture;
}

const WATER_VERT_PARS = /* glsl */`
attribute vec3 aFlow;   // along (m), across (m), flow speed (m/s)
attribute vec2 aDir;    // flow direction in world xz
varying vec3 vFlow;
varying vec2 vDir;
varying vec3 vWPos;
`;

const WATER_FRAG_PARS = /* glsl */`
uniform sampler2D tRipple;
uniform highp sampler2D tHeight;
uniform vec4 uMap;
uniform float uTime, uAbsorb, uRipple, uFoam;
uniform vec3 uScatter;
varying vec3 vFlow;
varying vec2 vDir;
varying vec3 vWPos;
float wDepth, wFoam;
float wHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float wGround(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = wHgt(i), h10 = wHgt(i + ivec2(1, 0)), h01 = wHgt(i + ivec2(0, 1)), h11 = wHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
`;

export function buildWater(terrain, terrainView, renderer) {
  const group = new THREE.Group();
  group.name = 'water';
  const ripple = bakeRipples(renderer);
  const time = { value: 0 };
  const U = terrainView.uniforms;

  const makeMaterial = (kind, opts) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: opts.rough ?? 0.06, metalness: 0, transparent: true, premultipliedAlpha: true });
    const uniforms = {
      tRipple: { value: ripple }, tHeight: U.tHeight, uMap: U.uMap, uTime: time,
      uAbsorb: { value: opts.absorb }, uRipple: { value: opts.ripple }, uFoam: { value: opts.foam }, uScatter: { value: new THREE.Color(...opts.scatter) },
    };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + WATER_VERT_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlow = aFlow; vDir = aDir;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + WATER_FRAG_PARS)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
wDepth = vWPos.y - wGround(vWPos.xz);
if (wDepth < -0.03) discard;`)
        .replace('#include <normal_fragment_begin>', `
float faceDirection = 1.0;
// ripples in the flow frame (x across, y along), then rotated into world xz
float dist = length(vWPos - cameraPosition);
float spd = vFlow.z;
vec2 fp = vec2(vFlow.y, vFlow.x);
vec4 r1 = texture2D(tRipple, (fp + vec2(0.0, -uTime * spd)) / 7.0 + vec2(uTime * 0.011, uTime * 0.006));
vec4 r2 = texture2D(tRipple, mat2(0.8, -0.6, 0.6, 0.8) * (fp + vec2(0.0, -uTime * spd * 1.6)) / 2.3 - vec2(uTime * 0.017, -uTime * 0.012));
vec2 sl = ((r1.xy * 2.0 - 1.0) * 0.8 + (r2.xy * 2.0 - 1.0) * 0.6) * uRipple * (1.0 + spd * 0.6);
sl *= 1.0 - 0.6 * smoothstep(40.0, 260.0, dist);
vec2 across = vec2(vDir.y, -vDir.x);
vec2 slW = across * sl.x + vDir * sl.y;
vec3 nW = normalize(vec3(-slW.x, 1.0, -slW.y));
vec3 normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;
// foam: along the waterline, and in fast shallow water
float foamN = r1.b * 0.6 + r2.b * 0.4;
wFoam = uFoam * (smoothstep(0.1, 0.0, wDepth) * 0.7 + smoothstep(0.35, 0.05, wDepth) * smoothstep(0.6, 1.6, spd) * 0.8);
wFoam = clamp(wFoam * smoothstep(0.42, 0.62, foamN) * 1.6, 0.0, 1.0) * (1.0 - smoothstep(30.0, 80.0, dist));`)
        .replace('#include <opaque_fragment>', `
{
  float d = max(wDepth, 0.0);
  float T = exp(-d * uAbsorb);
  float NoV = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
  float Fr = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  vec3 irr = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  vec3 spec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
  vec3 col = irr * uScatter * (1.0 - T) * (1.0 - Fr) + spec;
  float a = 1.0 - T * (1.0 - Fr);
  col = mix(col, irr * 0.8, wFoam); a = mix(a, 1.0, wFoam);
  float edge = smoothstep(-0.03, 0.05, wDepth);
  gl_FragColor = vec4(col * edge, a * edge);
}`)
        .replace('#include <premultiplied_alpha_fragment>', '')
        .replace('#include <fog_fragment>', `
#ifdef USE_FOG
{
  vec3 fogD = vFogWorldDir;
  float ff = atmoFogFactor(fogD);
  vec3 fc = atmoFogColor(fogD / max(length(fogD), 1e-4));
  gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - ff) + fc * ff * gl_FragColor.a;
}
#endif`);
    };
    m.customProgramCacheKey = () => 'water-v1';
    m.userData.uniforms = uniforms;
    return m;
  };

  const lakeMat = makeMaterial('lake', { absorb: 1.4, ripple: 0.55, foam: 0.6, scatter: [0.05, 0.10, 0.09] });
  const streamMat = makeMaterial('stream', { absorb: 2.2, ripple: 0.8, foam: 1.0, scatter: [0.07, 0.11, 0.08] });
  const mudMat = makeMaterial('mud', { absorb: 9.0, ripple: 0.25, foam: 0.0, scatter: [0.16, 0.11, 0.065], rough: 0.12 });

  const geoFrom = (pos, flow, dir, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  };
  // elliptic disc (lake, pools): world coordinates as the flow frame, no flow
  const disc = (cx, cz, rx, rz, y, rings = 10, segs = 72) => {
    const pos = [cx, y, cz], flow = [cx, cz, 0], dir = [0, 1], idx = [];
    for (let r = 1; r <= rings; r++) for (let s = 0; s < segs; s++) {
      const a = s / segs * Math.PI * 2, f = r / rings;
      const x = cx + Math.cos(a) * rx * f, z = cz + Math.sin(a) * rz * f;
      pos.push(x, y, z); flow.push(z, x, 0); dir.push(0, 1);
    }
    flow[0] = cz; flow[1] = cx;
    const ring = (r, s) => r === 0 ? 0 : 1 + (r - 1) * segs + (s % segs);
    for (let s = 0; s < segs; s++) idx.push(0, ring(1, s + 1), ring(1, s));
    for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
      const a = ring(r, s), b = ring(r, s + 1), c = ring(r + 1, s), d = ring(r + 1, s + 1);
      idx.push(a, b, c, b, d, c);
    }
    return geoFrom(pos, flow, dir, idx);
  };

  const meshes = [];
  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true; m.castShadow = false;
    m.renderOrder = 1;
    group.add(m); meshes.push(m);
    return m;
  };
  for (const w of terrain.water) {
    if (w.type === 'lake') add(disc(w.x, w.z, w.rx, w.rz, w.level), lakeMat);
    else if (w.type === 'pool') add(disc(w.x, w.z, w.rx, w.rz, w.level, 4, 40), mudMat);
    else if (w.type === 'stream') {
      // ribbon along the stream, wider than the water so the waterline comes from the bed
      const pts = w.pts, n = pts.length, lake = terrain.lake;
      const pos = [], flow = [], dir = [], idx = [];
      const ACROSS = [-1, -0.5, 0, 0.5, 1];
      let along = 0, rows = 0;
      for (let k = 0; k < n; k++) {
        const p = pts[k];
        if (lake && Math.hypot((p.x - lake.x) / lake.rx, (p.z - lake.z) / lake.rz) < 0.97) break;
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        if (k > 0) along += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
        const hw = w.width[k] + 2.5;
        const drop = k < n - 1 ? (w.level[k] - w.level[k + 1]) / Math.max(0.5, Math.hypot(pts[k + 1].x - p.x, pts[k + 1].z - p.z)) : 0;
        const spd = Math.min(2.2, 0.35 + drop * 45);
        for (const s of ACROSS) {
          const off = s * hw;
          pos.push(p.x + tz * off, w.level[k], p.z - tx * off);
          flow.push(along, off, spd);
          dir.push(tx, tz);
        }
        rows++;
      }
      const C = ACROSS.length;
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
      if (rows > 1) add(geoFrom(pos, flow, dir, idx), streamMat);
    }
  }

  let enabled = true;
  return {
    group, meshes, ripple,
    materials: { lake: lakeMat, stream: streamMat, mud: mudMat },
    configure(q) { enabled = true; group.visible = enabled; },
    update(dt) { time.value += dt; },
  };
}
