import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { mulberry32 } from './noise.js';

// Procedural textures (no external assets).
// Ground layers are baked on the GPU at startup into two texture arrays:
//   albedo (rgb) + height (a)   and   normal (xy in rg) + roughness (b) + cavity AO (a).
// Layers: 0 grass, 1 dirt track, 2 rock, 3 mud, 4 sand / gravel, 5 forest floor.
// Every recipe is built from periodic noise, so the tiles wrap seamlessly.

export const LAYER = { grass: 0, dirt: 1, rock: 2, mud: 3, sand: 4, forest: 5 };
export const LAYER_COUNT = 6;
// world size (m) covered by one tile of each layer
export const LAYER_TILE = [2.6, 3.2, 5.0, 3.4, 2.2, 2.8];

export const NOISE_GLSL = /* glsl */`
// ---- periodic noise toolkit (period in cells, integer)
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(mod(i, per)) * 2.0 - 1.0, g10 = hash22(mod(i + vec2(1, 0), per)) * 2.0 - 1.0;
  vec2 g01 = hash22(mod(i + vec2(0, 1), per)) * 2.0 - 1.0, g11 = hash22(mod(i + vec2(1, 1), per)) * 2.0 - 1.0;
  float a = dot(g00, f), b = dot(g10, f - vec2(1, 0)), c = dot(g01, f - vec2(0, 1)), d = dot(g11, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4 + 0.5;
}
float pfbm(vec2 uv, float per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * pnoise(uv * per, per); n += a; a *= 0.5; per *= 2.0;
  }
  return s / n;
}
// periodic voronoi: x = distance to nearest point, y = edge distance, z = cell hash
vec3 pvoronoi(vec2 uv, float per) {
  vec2 p = uv * per;
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; float h = 0.0; vec2 mr = vec2(0.0); vec2 mg = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = hash22(mod(i + g, per));
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; h = hash12(mod(i + g, per) + 7.7); mr = r; mg = g; }
    else if (d < d2) d2 = d;
  }
  // edge distance (second pass, Inigo Quilez)
  float md = 8.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec2 g = mg + vec2(x, y);
    vec2 o = hash22(mod(i + g, per));
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(sqrt(d1), md, h);
}
// scattered stones: returns (height, cell id) of round pebbles
vec2 pebbles(vec2 uv, float per, float size) {
  vec3 v = pvoronoi(uv, per);
  float r = size * (0.55 + 0.45 * v.z);
  float h = clamp(1.0 - v.x / r, 0.0, 1.0);
  return vec2(sqrt(h) * (0.6 + 0.4 * v.z), v.z);
}
// grass blade streaks seen from above
float blades(vec2 uv, float per, float seed) {
  vec2 p = uv * per;
  vec2 i = floor(p), f = fract(p);
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 h = hash22(mod(i + g, per) + seed);
    vec2 c = g + h - f;
    float a = h.x * 6.2831;
    vec2 dir = vec2(cos(a), sin(a));
    float along = dot(c, dir), across = dot(c, vec2(-dir.y, dir.x));
    float len = 0.45 + 0.4 * h.y;
    float w = 0.05 + 0.03 * h.y;
    float b = smoothstep(w, 0.0, abs(across)) * smoothstep(len, 0.0, abs(along));
    s = max(s, b * (0.5 + 0.5 * h.y));
  }
  return s;
}
`;

const BAKE_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const ALBEDO_FRAG = /* glsl */`
${NOISE_GLSL}
uniform int uLayer;
varying vec2 vUv;
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec2 uv = vUv;
  vec3 col; float h;
  if (uLayer == 0) {
    // grass: mixed greens, dry tips, soil showing through
    float m = pfbm(uv, 4.0, 4), m2 = pfbm(uv + 0.31, 12.0, 3);
    float b1 = blades(uv, 48.0, 1.0), b2 = blades(uv, 64.0, 5.0), b3 = blades(uv, 90.0, 9.0);
    float bl = max(b1, max(b2 * 0.9, b3 * 0.8));
    vec3 dark = srgb(vec3(0.16, 0.22, 0.08)), mid = srgb(vec3(0.30, 0.38, 0.13)), dry = srgb(vec3(0.50, 0.47, 0.25));
    vec3 g = mix(dark, mid, smoothstep(0.3, 0.7, m));
    g = mix(g, dry, smoothstep(0.55, 0.8, m2) * 0.55);
    vec3 soil = srgb(vec3(0.22, 0.17, 0.11));
    float gap = smoothstep(0.42, 0.3, m * 0.6 + m2 * 0.4) * (1.0 - bl);
    col = mix(g * (0.7 + 0.45 * bl), soil, gap * 0.55);
    col *= 0.9 + 0.2 * hash12(floor(uv * 256.0));
    h = 0.35 + 0.5 * bl + 0.15 * m - gap * 0.3;
  } else if (uLayer == 1) {
    // dirt track: compacted soil, fine gravel, a few larger stones, fine cracks
    float m = pfbm(uv, 3.0, 5), m2 = pfbm(uv + 0.5, 16.0, 3), m3 = pfbm(uv + 0.21, 40.0, 2);
    vec3 soil = mix(srgb(vec3(0.38, 0.30, 0.21)), srgb(vec3(0.52, 0.43, 0.31)), m);
    soil *= 0.88 + 0.24 * m2 + 0.1 * (m3 - 0.5);
    vec3 vf = pvoronoi(uv + 0.37, 150.0);
    float fine = smoothstep(0.34, 0.12, vf.x) * step(0.55, vf.z);
    vec3 vs = pvoronoi(uv, 12.0);
    float big = sqrt(clamp(1.0 - vs.x / (0.2 + 0.1 * vs.z), 0.0, 1.0)) * step(vs.z, 0.14);
    col = mix(soil, soil * (0.82 + 0.36 * fract(vf.z * 13.0)), fine * 0.5);
    col = mix(col, mix(srgb(vec3(0.40, 0.36, 0.31)), srgb(vec3(0.52, 0.47, 0.40)), fract(vs.z * 7.0)) * (0.7 + 0.45 * big), smoothstep(0.0, 0.3, big));
    float crack = smoothstep(0.025, 0.0, pvoronoi(uv, 5.0).y) * smoothstep(0.5, 0.7, m2);
    col *= 1.0 - crack * 0.35;
    h = 0.4 + 0.12 * m + 0.15 * fine + 0.5 * big - crack * 0.15;
  } else if (uLayer == 2) {
    // rock: layered, fractured, lichen and moss in the hollows
    float m = pfbm(uv, 2.0, 6), m2 = pfbm(uv + 0.2, 8.0, 4), m3 = pfbm(uv + 0.7, 32.0, 3);
    vec3 vor = pvoronoi(uv + vec2(m2 * 0.08), 4.0);
    float crack = smoothstep(0.022, 0.0, vor.y) * smoothstep(0.35, 0.6, pfbm(uv + 0.9, 6.0, 2));
    float strata = 0.5 + 0.5 * sin((uv.y + m * 0.22) * 6.2831 * 7.0);
    vec3 base = mix(srgb(vec3(0.38, 0.36, 0.33)), srgb(vec3(0.58, 0.55, 0.50)), m);
    base *= 0.88 + 0.2 * vor.z;
    base *= 0.92 + 0.1 * strata + 0.12 * (m3 - 0.5);
    float lichen = smoothstep(0.64, 0.74, pfbm(uv + 0.7, 10.0, 3));
    base = mix(base, srgb(vec3(0.60, 0.58, 0.38)), lichen * 0.45);
    float moss = smoothstep(0.58, 0.74, m2) * 0.45;
    base = mix(base, srgb(vec3(0.24, 0.30, 0.13)), moss);
    col = base * (1.0 - crack * 0.5);
    h = 0.5 + 0.3 * (m - 0.5) + 0.12 * vor.x + 0.12 * m3 - crack * 0.3 + 0.05 * strata;
  } else if (uLayer == 3) {
    // mud: dark wet soil with churned ridges and puddles (low height)
    float m = pfbm(uv, 3.0, 5), m2 = pfbm(uv + 0.4, 14.0, 3);
    float ridges = 0.5 + 0.5 * sin((uv.x + m * 0.3) * 6.2831 * 7.0);
    vec3 mud = mix(srgb(vec3(0.19, 0.14, 0.09)), srgb(vec3(0.33, 0.25, 0.16)), m * 0.7 + m2 * 0.3);
    h = 0.3 + 0.35 * m + 0.15 * ridges * m2;
    float wet = smoothstep(0.42, 0.3, h);
    col = mix(mud, mud * 0.55, wet);
  } else if (uLayer == 4) {
    // sand / gravel: dense small stones on pale sand
    float m = pfbm(uv, 3.0, 4);
    vec2 a = pebbles(uv, 34.0, 0.42), b = pebbles(uv + 0.5, 70.0, 0.45), c = pebbles(uv + 0.21, 14.0, 0.3);
    vec3 sand = mix(srgb(vec3(0.47, 0.42, 0.33)), srgb(vec3(0.60, 0.54, 0.44)), m);
    col = sand;
    col = mix(col, mix(srgb(vec3(0.34, 0.32, 0.30)), srgb(vec3(0.56, 0.53, 0.48)), b.y), smoothstep(0.0, 0.2, b.x) * 0.9);
    col = mix(col, mix(srgb(vec3(0.32, 0.29, 0.26)), srgb(vec3(0.52, 0.47, 0.41)), a.y), smoothstep(0.0, 0.15, a.x));
    col = mix(col, mix(srgb(vec3(0.38, 0.36, 0.34)), srgb(vec3(0.58, 0.55, 0.51)), c.y), smoothstep(0.0, 0.1, c.x));
    h = 0.25 + 0.1 * m + 0.35 * b.x + 0.45 * a.x + 0.6 * c.x;
  } else {
    // forest floor: humus, needles, twigs, moss
    float m = pfbm(uv, 3.0, 5), m2 = pfbm(uv + 0.6, 12.0, 3);
    vec3 hum = mix(srgb(vec3(0.15, 0.10, 0.06)), srgb(vec3(0.27, 0.19, 0.11)), m);
    float n1 = blades(uv, 70.0, 3.0), n2 = blades(uv, 110.0, 11.0), tw = blades(uv, 14.0, 17.0);
    vec3 needle = mix(srgb(vec3(0.42, 0.26, 0.12)), srgb(vec3(0.58, 0.40, 0.20)), hash12(floor(uv * 300.0)));
    col = mix(hum, needle, max(n1, n2 * 0.8) * 0.85);
    col = mix(col, srgb(vec3(0.30, 0.22, 0.14)), tw * 0.7);
    float moss = smoothstep(0.58, 0.72, m2);
    col = mix(col, srgb(vec3(0.20, 0.28, 0.09)), moss * 0.75);
    h = 0.3 + 0.2 * m + 0.25 * max(n1, n2) + 0.4 * tw + 0.15 * moss;
  }
  gl_FragColor = vec4(col, clamp(h, 0.0, 1.0));
}`;

const NORMAL_FRAG = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray tSrc;
uniform int uLayer;
uniform float uStrength, uRough, uWetRough;
uniform vec2 uTexel;
varying vec2 vUv;
float H(vec2 o) { return texture(tSrc, vec3(fract(vUv + o * uTexel), float(uLayer))).a; }
void main() {
  float hl = H(vec2(-1, 0)), hr = H(vec2(1, 0)), hd = H(vec2(0, -1)), hu = H(vec2(0, 1));
  float hc = H(vec2(0));
  vec3 n = normalize(vec3((hl - hr) * uStrength, (hd - hu) * uStrength, 1.0));
  // cavity: lower than the neighbourhood -> occluded
  float avg = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; avg += H(vec2(cos(a), sin(a)) * 4.0); }
  avg /= 8.0;
  float ao = clamp(1.0 - (avg - hc) * 2.2, 0.35, 1.0);
  float rough = uRough;
  if (uLayer == 3) rough = mix(uWetRough, uRough, smoothstep(0.3, 0.45, hc));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, rough, ao);
}`;

const STRENGTH = [2.2, 3.5, 5.0, 2.5, 4.0, 3.0];
const ROUGH = [0.92, 0.9, 0.82, 0.78, 0.88, 0.95];

export function bakeGroundLayers(renderer, size = 1024, anisotropy = 8) {
  const opts = { depthBuffer: false, type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping };
  const albedo = new THREE.WebGLArrayRenderTarget(size, size, LAYER_COUNT, opts);
  const normal = new THREE.WebGLArrayRenderTarget(size, size, LAYER_COUNT, opts);
  for (const t of [albedo.texture, normal.texture]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  albedo.texture.colorSpace = THREE.SRGBColorSpace; // stored as sRGB (8-bit precision in the darks), decoded on sampling
  const aMat = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: ALBEDO_FRAG, uniforms: { uLayer: { value: 0 } }, depthTest: false, depthWrite: false });
  const nMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT, fragmentShader: NORMAL_FRAG, depthTest: false, depthWrite: false,
    uniforms: { tSrc: { value: albedo.texture }, uLayer: { value: 0 }, uStrength: { value: 3 }, uRough: { value: 0.9 }, uWetRough: { value: 0.25 }, uTexel: { value: new THREE.Vector2(1 / size, 1 / size) } },
  });
  const quad = new FullScreenQuad(aMat);
  const prev = renderer.getRenderTarget();
  for (let l = 0; l < LAYER_COUNT; l++) {
    aMat.uniforms.uLayer.value = l;
    renderer.setRenderTarget(albedo, l);
    quad.render(renderer);
  }
  quad.material = nMat;
  for (let l = 0; l < LAYER_COUNT; l++) {
    nMat.uniforms.uLayer.value = l;
    nMat.uniforms.uStrength.value = STRENGTH[l] * size / 512;
    nMat.uniforms.uRough.value = ROUGH[l];
    renderer.setRenderTarget(normal, l);
    quad.render(renderer);
  }
  renderer.setRenderTarget(prev);
  aMat.dispose(); nMat.dispose(); quad.dispose();
  return { albedo: albedo.texture, normal: normal.texture, targets: [albedo, normal] };
}

// ---------------------------------------------------------------- small CPU textures

function makeValueNoise(period, seed) {
  const rnd = mulberry32(seed);
  const v = new Float32Array(period * period);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = v[y0 * period + x0], b = v[y0 * period + x1], c = v[y1 * period + x0], d = v[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

// fbm tileable over [0,1)^2
function tileFbm(octaves, basePeriod, seed) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(makeValueNoise(basePeriod << o, seed + o * 31));
  return (u, v) => {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < octaves; o++) {
      const p = basePeriod << o;
      s += a * layers[o](u * p, v * p);
      n += a; a *= 0.5;
    }
    return s / n;
  };
}

// painted straight into a DataTexture (a canvas would premultiply alpha and wreck the colour of low-alpha texels)
function canvasTex(size, paint, { srgb = true } = {}) {
  const data = new Uint8Array(size * size * 4);
  paint(data, size);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function fill(data, size, fn) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = fn(x / size, y / size, x, y);
    const i = (y * size + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a === undefined ? 255 : a;
  }
}
const cl = v => Math.max(0, Math.min(255, v));

// Black rubber with subtle noise for tyres
export function makeRubberTexture() {
  return canvasTex(256, (d, size) => {
    const n = tileFbm(4, 8, 61);
    fill(d, size, (u, v) => { const a = n(u, v); const g = 48 + a * 26; return [cl(g), cl(g), cl(g + 2), 255]; });
  });
}

// Bark: vertical furrows (u wraps around the trunk, v runs up it); alpha = height for the normal
export function makeBarkTexture(kind = 'conifer') {
  return canvasTex(256, (d, size) => {
    const n = tileFbm(5, 4, kind === 'birch' ? 91 : 71), n2 = tileFbm(3, 16, 73);
    fill(d, size, (u, v) => {
      if (kind === 'birch') {
        const a = n(u * 2, v * 0.5), b = n2(u, v * 3);
        const mark = b > 0.66 ? 1 : 0;
        const g = 205 + a * 30 - mark * 150;
        return [cl(g), cl(g - 2), cl(g - 8), cl(180 - mark * 120)];
      }
      const f = n(u * 3, v * 0.35), b = n2(u, v);
      const furrow = Math.pow(Math.abs(Math.sin((u * 9 + f * 1.4) * Math.PI)), 0.6);
      const g = 40 + furrow * 50 + b * 18;
      return [cl(g + 16), cl(g + 2), cl(g - 10), cl(furrow * 220 + b * 30)];
    });
  });
}

export { tileFbm };
