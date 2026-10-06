import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec3, vec4, float, positionGeometry, normalGeometry, positionViewDirection, normalView, frontFacing, output,
  floor, fract, mix, clamp, smoothstep, dot, abs, pow, length, fwidth, normalize, bumpMap, materialRoughness, materialColor,
  materialOpacity,
} from 'three/tsl';
import { premultipliedFog } from '../render/fog.js';

// Truck materials (node materials). All of them share a few uniforms driven by VehicleView:
//   uEnvSpec  - reflections at night (kept for the view's API; the environment probe lights them)
//   uDirt     - overall dirt amount (dust on the lower body, film on flat tops)
//   uCabinAO  - interior ambient occlusion (the cabin hides most of the sky)
//   uWet      - rain on the body (weather.js): darker dirt, glossy paint

export const shared = {
  uEnvSpec: uniform(1.0),
  uDirt: uniform(1.0),
  uCabinAO: uniform(1.0),
  uWet: uniform(0.0),
};

const tkHash = Fn(([p0]) => {
  const p = fract(p0.mul(0.3183099).add(0.1)).mul(17.0);
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
});
const tkNoise = Fn(([x]) => {
  const i = floor(x), f0 = fract(x);
  const f = f0.mul(f0).mul(vec3(3.0).sub(f0.mul(2.0)));
  const h = (o) => tkHash(i.add(vec3(...o)));
  return mix(mix(mix(h([0, 0, 0]), h([1, 0, 0]), f.x), mix(h([0, 1, 0]), h([1, 1, 0]), f.x), f.y),
    mix(mix(h([0, 0, 1]), h([1, 0, 1]), f.x), mix(h([0, 1, 1]), h([1, 1, 1]), f.x), f.y), f.z);
});

// opts: dirt (0..1 how much this material collects dirt), env (kept), ao (cabin occlusion), grain, glass
function patch(mat, opts) {
  const { dirt = 0, ao = false, glass = false, grain = 0, dirtTint = [0.13, 0.095, 0.065] } = opts;
  const p = positionGeometry, n = normalGeometry;
  const base = materialColor;   // (vertex colours, if any, are multiplied in by the material)
  if (dirt > 0) {
    const n1 = tkNoise(p.mul(vec3(3.1, 2.3, 3.1)));
    const n2 = tkNoise(p.mul(vec3(11.0, 4.0, 11.0)).add(7.3));
    const streak = tkNoise(vec3(p.x.mul(9.0).add(p.z.mul(9.0)), p.y.mul(0.8), p.z.mul(2.0)));
    // splash from the tyres: lower body, worst near the bottom
    const low = float(1).sub(smoothstep(0.5, n1.mul(0.16).add(0.92), p.y.add(streak.mul(0.10))));
    // fine dust film on upward-facing surfaces
    const up = smoothstep(0.6, 0.95, normalize(n).y).mul(smoothstep(0.35, 0.8, n2));
    const d = clamp(low.mul(n1.mul(n1).mul(0.6).add(0.35).add(n2.mul(0.2))).add(up.mul(0.18)), 0.0, 1.0).mul(shared.uDirt).mul(dirt).toVar('tkDirt');
    // rain washes the film darker (wet mud) and glossy
    const tint = vec3(...dirtTint).mul(n2.mul(0.4).add(0.8)).mul(float(1).sub(shared.uWet.mul(0.35)));
    mat.colorNode = vec4(mix(base.rgb, tint, d.mul(0.8)), materialOpacity);
    mat.roughnessNode = clamp(mix(materialRoughness, mix(0.93, 0.45, shared.uWet), d).add(n2.sub(0.5).mul(0.06)), 0.03, 1.0).mul(float(1).sub(shared.uWet.mul(0.35)).max(0.04));
    if (mat.isMeshPhysicalNodeMaterial) mat.clearcoatNode = float(mat.clearcoat).mul(float(1).sub(d));
  } else if (!glass) {
    mat.roughnessNode = materialRoughness.mul(float(1).sub(shared.uWet.mul(0.3)));
  }
  if (grain > 0) {
    // fine moulded grain on plastics: object-space noise bump, faded out where it would alias
    const gp = p.mul(420.0);
    const fw = length(fwidth(gp));
    const amp = float(grain * 0.002).mul(float(1).sub(smoothstep(0.15, 0.5, fw)));
    const h = tkNoise(gp).mul(0.6).add(tkNoise(gp.mul(2.3)).mul(0.4));
    mat.normalNode = bumpMap(h, amp);
  }
  if (ao) mat.aoNode = shared.uCabinAO.mul(ao);
  if (glass) {
    // The pane is a closed slab (two caps). Drawing both attenuated the view through it twice, so only
    // the cap facing the viewer is drawn. Premultiplied output: the tinted body is attenuated by alpha,
    // reflections are not. Alpha rises towards grazing angles (Fresnel).
    mat.maskNode = frontFacing;
    const NV = abs(dot(positionViewDirection, normalView));
    const Fr = pow(float(1).sub(NV), 3.0);
    const a = mix(materialOpacity, 1.0, Fr.mul(0.55)).toVar('tkA');
    mat.colorNode = vec4(base.rgb.mul(a), 1.0);
    mat.opacityNode = float(1);
    mat.fog = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.outputNode = premultipliedFog(vec4(output.rgb, a));
  }
  return mat;
}

const toNode = (Cls, o) => { const m = new Cls(); for (const k in o) { if (k === 'premultipliedAlpha') continue; if (m[k]?.isColor) m[k].set(o[k]); else m[k] = o[k]; } return m; };
const std = (o, p = {}) => patch(toNode(THREE.MeshStandardNodeMaterial, o), p);
const phys = (o, p = {}) => patch(toNode(THREE.MeshPhysicalNodeMaterial, o), p);

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
    glass: std({ color: 0x0c1418, roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true }, { env: 1.6, glass: true }),
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
