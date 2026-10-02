import * as THREE from 'three';

// Truck materials. All of them share a few uniforms driven by VehicleView:
//   uEnvSpec  - multiplier on the specular environment reflection (scene.environmentIntensity is kept
//               low for the terrain, which leaves glass and clear coat looking dead without this)
//   uDirt     - overall dirt amount (dust on the lower body, film on flat tops)
// Shader patches are small string injections into the stock MeshStandard/MeshPhysical programs.

const NOISE = /* glsl */`
float tk_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tk_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tk_hash(i), tk_hash(i + vec3(1,0,0)), f.x), mix(tk_hash(i + vec3(0,1,0)), tk_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tk_hash(i + vec3(0,0,1)), tk_hash(i + vec3(1,0,1)), f.x), mix(tk_hash(i + vec3(0,1,1)), tk_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

export const shared = {
  uEnvSpec: { value: 1.0 },
  uDirt: { value: 1.0 },
  uCabinAO: { value: 1.0 },
};

// opts: dirt (0..1 how much this material collects dirt), env (use uEnvSpec), ao (cabin occlusion), grain
function patch(mat, opts) {
  const { dirt = 0, env = 0, ao = false, glass = false, grain = 0, dirtTint = [0.13, 0.095, 0.065] } = opts;
  const key = `tk-${dirt}-${env}-${ao}-${glass}-${grain}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uEnvSpec = shared.uEnvSpec;
    sh.uniforms.uDirt = shared.uDirt;
    sh.uniforms.uCabinAO = shared.uCabinAO;
    const needPos = dirt > 0 || grain > 0;
    if (needPos) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTkPos;\nvarying vec3 vTkNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTkPos = transformed;\nvTkNrm = objectNormal;');
    }
    let frag = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uEnvSpec;
uniform float uDirt;
uniform float uCabinAO;
${needPos ? 'varying vec3 vTkPos;\nvarying vec3 vTkNrm;' : ''}
${NOISE}`);
    if (dirt > 0) {
      frag = frag.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
float tkDirt;
{
  vec3 p = vTkPos;
  float n1 = tk_noise(p * vec3(3.1, 2.3, 3.1));
  float n2 = tk_noise(p * vec3(11.0, 4.0, 11.0) + 7.3);
  float streak = tk_noise(vec3(p.x * 9.0 + p.z * 9.0, p.y * 0.8, p.z * 2.0));
  // splash from the tyres: lower body, worst near the bottom
  float low = 1.0 - smoothstep(0.5, 0.92 + 0.16 * n1, p.y + 0.10 * streak);
  // fine dust film on upward-facing surfaces
  float up = smoothstep(0.6, 0.95, normalize(vTkNrm).y) * smoothstep(0.35, 0.8, n2);
  tkDirt = clamp(low * (0.35 + 0.6 * n1 * n1 + 0.2 * n2) + up * 0.18, 0.0, 1.0) * uDirt * ${dirt.toFixed(3)};
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${dirtTint.map(v => v.toFixed(3)).join(', ')}) * (0.8 + 0.4 * n2), tkDirt * 0.8);
  roughnessFactor = mix(roughnessFactor, 0.93, tkDirt);
  roughnessFactor = clamp(roughnessFactor + (n2 - 0.5) * 0.06, 0.03, 1.0);
}`);
      frag = frag.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= 1.0 - tkDirt;
#endif`);
    }
    if (grain > 0) {
      // fine moulded grain on plastics: object-space noise bump, faded out where it would alias
      frag = frag.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 gp = vTkPos * 420.0;
  float fw = length(fwidth(gp));
  float amp = ${(grain * 0.002).toFixed(5)} * (1.0 - smoothstep(0.15, 0.5, fw));
  if (amp > 0.0) {
    float h = tk_noise(gp) * 0.6 + tk_noise(gp * 2.3) * 0.4;
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float dhx = dFdx(h) * amp, dhy = dFdy(h) * amp;
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1) * faceDirection;
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    vec3 nn = abs(det) * normal - grad;
    float ln = length(nn);
    if (abs(det) > 1e-14 && ln > 1e-14) normal = nn / ln;
  }
}`);
    }
    // scale reflections / occlusion after the environment has been sampled
    let post = '';
    if (env) post += `radiance *= uEnvSpec * ${(+env).toFixed(3)};
#ifdef USE_CLEARCOAT
  clearcoatRadiance *= uEnvSpec * ${(+env).toFixed(3)};
#endif
`;
    if (ao) post += `irradiance *= uCabinAO * ${(+ao).toFixed(3)}; iblIrradiance *= uCabinAO * ${(+ao).toFixed(3)}; radiance *= uCabinAO * ${(+ao).toFixed(3)};\n`;
    if (post) frag = frag.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${post}`);
    if (glass) {
      // The pane is a closed slab (two caps). Drawing both attenuated the view through it twice
      // (0.26^2 = 7% transmission: opaque blue-black), so only the cap facing the viewer is drawn.
      // Premultiplied output: tinted body is attenuated by alpha, reflections are not. Alpha rises
      // towards grazing angles (Fresnel), so the glass is clearest head-on and mirror-like at a slant.
      frag = frag
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (!gl_FrontFacing) discard;')
        .replace('#include <opaque_fragment>', `float tkNV = abs(dot(normalize(vViewPosition), normal));
float tkFr = pow(1.0 - tkNV, 3.0);
float tkA = mix(diffuseColor.a, 1.0, tkFr * 0.55);
gl_FragColor = vec4( totalDiffuse * tkA + totalSpecular + totalEmissiveRadiance, tkA );`)
        .replace('#include <fog_fragment>', `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * gl_FragColor.a, fogFactor );
#endif`)
        .replace('#include <premultiplied_alpha_fragment>', '');
    }
    sh.fragmentShader = frag;
  };
  return mat;
}

const std = (o, p = {}) => patch(new THREE.MeshStandardMaterial(o), p);
const phys = (o, p = {}) => patch(new THREE.MeshPhysicalMaterial(o), p);

export function createMaterials() {
  const m = {
    // red with a clear coat; dirt on the lower panels. The base specular is kept low (specularIntensity)
    // and fairly sharp: a broad satin lobe washed the flat bonnet pink in the sun from the cockpit/hood view
    paint: phys({ color: 0x9e150e, roughness: 0.3, metalness: 0.0, specularIntensity: 0.35, clearcoat: 0.25, clearcoatRoughness: 0.12 }, { dirt: 0.75, env: 0.5 }),
    // textured black plastic (flares, grille, trims, mirrors)
    black: std({ color: 0x161719, roughness: 0.7, metalness: 0.0 }, { dirt: 0.4, env: 1.0, grain: 0.5 }),
    // black powder-coated steel (bumpers, rack, sliders)
    blackMetal: std({ color: 0x17181a, roughness: 0.58, metalness: 0.12 }, { dirt: 0.35, env: 0.8 }),
    chassis: std({ color: 0x1c1d1f, roughness: 0.8, metalness: 0.25 }, { dirt: 0.8 }),
    steel: std({ color: 0x151618, roughness: 0.45, metalness: 0.5 }, { dirt: 0.2, env: 1.2 }),
    zinc: std({ color: 0xa4a7ab, roughness: 0.3, metalness: 0.95 }, { env: 1.8 }),
    chrome: std({ color: 0xd8dadc, roughness: 0.08, metalness: 1.0 }, { env: 1.8 }),
    yellow: std({ color: 0xd9a31a, roughness: 0.45, metalness: 0.1 }, { dirt: 0.6 }),
    rubber: std({ color: 0x111112, roughness: 0.9, metalness: 0.0 }, { dirt: 0.4 }),
    seal: std({ color: 0x0c0c0d, roughness: 0.6, metalness: 0.0 }, { env: 1.0 }),
    // glass: premultiplied blending so reflections stay at full strength while the tint is see-through
    glass: std({ color: 0x0a1014, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.52, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true }, { env: 1.6, glass: true }),
    glassClear: std({ color: 0x0c1418, roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true }, { env: 1.6, glass: true }),
    glassDark: std({ color: 0x06080a, roughness: 0.05, metalness: 0.0 }, { env: 1.6 }),
    mirror: std({ color: 0x646a70, roughness: 0.02, metalness: 1.0 }, { env: 2.0 }),
    // interior (darkened ambient: the cabin hides most of the sky)
    dash: std({ color: 0x232427, roughness: 0.74, metalness: 0.0 }, { ao: 0.5, grain: 0.4 }),
    dashSoft: std({ color: 0x2c2d30, roughness: 0.88, metalness: 0.0 }, { ao: 0.5, grain: 0.25 }),
    seat: std({ color: 0x34363a, roughness: 0.95, metalness: 0.0 }, { ao: 0.5 }),
    seatTrim: std({ color: 0x1c1d1f, roughness: 0.75, metalness: 0.0 }, { ao: 0.55 }),
    headliner: std({ color: 0xa9a69f, roughness: 0.96, metalness: 0.0 }, { ao: 0.55 }),
    carpet: std({ color: 0x18181a, roughness: 1.0, metalness: 0.0 }, { ao: 0.45 }),
    cabinPaint: phys({ color: 0x9c1710, roughness: 0.4, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.2 }, { ao: 0.55 }),
    cabinMetal: std({ color: 0x8e9196, roughness: 0.35, metalness: 0.9 }, { ao: 0.6 }),
    // lamp lenses (emissive driven by VehicleView)
    headLens: std({ color: 0xc9cfd4, roughness: 0.08, metalness: 0.2, emissive: 0xfff1de, emissiveIntensity: 0 }, { env: 1.0 }),
    barLens: std({ color: 0xb8bec4, roughness: 0.08, metalness: 0.2, emissive: 0xf2f6ff, emissiveIntensity: 0 }, { env: 1.0 }),
    workLens: std({ color: 0xb8bec4, roughness: 0.1, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 }, { env: 1.0 }),
    sideLens: std({ color: 0xd6d9dc, roughness: 0.1, metalness: 0.1, emissive: 0xfff4e0, emissiveIntensity: 0 }, { env: 1.0 }),
    tail: std({ color: 0x4a0604, roughness: 0.22, emissive: 0xff1a08, emissiveIntensity: 0 }, { env: 1.0 }),
    brake: std({ color: 0x4a0604, roughness: 0.22, emissive: 0xff1a08, emissiveIntensity: 0 }, { env: 1.0 }),
    amber: std({ color: 0x8a4600, roughness: 0.22, emissive: 0xff8a10, emissiveIntensity: 0 }, { env: 1.0 }),
    reverse: std({ color: 0xb4b8bc, roughness: 0.18, emissive: 0xffffff, emissiveIntensity: 0 }, { env: 1.0 }),
    beacon: std({ color: 0x8a4600, roughness: 0.15, emissive: 0xff8a10, emissiveIntensity: 0, transparent: false }, { env: 1.0 }),
    reflector: std({ color: 0x6a0c06, roughness: 0.3 }, { env: 1.0 }),
  };
  return m;
}

// Tileable rubber texture for the tyres (no dependency on the world textures)
export function makeRubberTexture() {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const grid = 16, g = new Float32Array(grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[(yi % grid) * grid + (xi % grid)], b = g[(yi % grid) * grid + ((xi + 1) % grid)];
    const c = g[((yi + 1) % grid) * grid + (xi % grid)], d = g[((yi + 1) % grid) * grid + ((xi + 1) % grid)];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S * grid, v = y / S * grid;
    const n = vn(u, v) * 0.6 + vn((u * 2) % grid, (v * 2) % grid) * 0.4;
    const c = 40 + n * 26 + (rnd() - 0.5) * 6;
    const i = (y * S + x) * 4;
    data[i] = c; data[i + 1] = c; data[i + 2] = c + 1; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
