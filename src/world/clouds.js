import * as THREE from 'three';
import { ORIGIN, mod } from './origin.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Volumetric clouds: cumulus in a slab from BASE to TOP metres, raymarched at a fraction of the screen
// resolution with a jittered start and a temporal blend (the history is reprojected by ray direction: the
// clouds are kilometres away, so the camera's travel hardly moves them).
// - Where: a 2D coverage field (procedural, shared with every lit material through CLOUD_GLSL, so the cloud
//   shadows on the ground match the clouds above), drifting with the wind.
// - Shape: a height profile (flat bellies, puffy tops, taller where the coverage is thick) carved by a 3D
//   Perlin-Worley noise and eroded at the edges by finer Worley noise (a 64^3 tileable texture made on the GPU).
// - Light: Beer-Lambert to the sun in a few steps, a "powder" darkening of thin cloud facing the light, two
//   Henyey-Greenstein lobes (bright rims towards the sun), sky light from above; far clouds fade into the sky.

export const BASE = 1200, TOP = 3000;

// The coverage noise: four octaves of smooth value noise summed into one tileable texture, made once. Every
// lit pixel (cloud shadows) and every raymarch step reads it once; computed in the shader it cost 16 hashes a
// call (~0.5 ms of cloud shadows at 2592x1362 on an M1 Pro, and most of the march). A DataTexture: the clone
// each material gets of it shares the source, so one GPU texture.
const NOISE_CELLS = 64, CELL = 900;   // cells of the coarsest octave across the texture, metres a cell
const NOISE_N = 1024;                 // texels across
function makeCoverNoise(N = NOISE_N) {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sum = new Float32Array(N * N);
  const W = [0.54, 0.27, 0.13, 0.06];
  for (let o = 0; o < 4; o++) {
    const C = NOISE_CELLS << o, lat = new Float32Array(C * C);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < N; y++) {
      const fy = y / N * C, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty), y0 = iy % C, y1 = (iy + 1) % C;
      for (let x = 0; x < N; x++) {
        const fx = x / N * C, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx), x0 = ix % C, x1 = (ix + 1) % C;
        const a = lat[y0 * C + x0] + (lat[y0 * C + x1] - lat[y0 * C + x0]) * sx;
        const b = lat[y1 * C + x0] + (lat[y1 * C + x1] - lat[y1 * C + x0]) * sx;
        sum[y * N + x] += (a + (b - a) * sy) * W[o];
      }
    }
  }
  const data = new Uint16Array(N * N);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(sum[i]);
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// shared plain-object uniforms (UniformsUtils.clone keeps plain objects by reference: one write reaches every
// material): xy wind offset (m), z coverage 0..1, w cloud-shadow strength; sun: xyz towards the sun, w mid height
export const CLOUD = {
  map: { x: 0, y: 0, z: 0.45, w: 0.0 },
  sun: { x: 0, y: 1, z: 0, w: (BASE + TOP) / 2 },
  noise: makeCoverNoise(),
};

export const CLOUD_GLSL = /* glsl */`
uniform vec4 uCloudMap;
uniform vec4 uCloudSun;
float cHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
#ifdef CLOUD_DFG
#define tCloudCover tCloudDFG   // the terrain: its own copy (CLOUD_DFG_GLSL)
#else
uniform sampler2D tCloudNoise;
#define tCloudCover tCloudNoise
#endif
// cloud coverage over a world xz (m): 0 clear sky .. 1 a thick cloud
float cloudCover(vec2 xz) {
  float n = textureLod(tCloudCover, (xz + uCloudMap.xy) / ${(CELL * NOISE_CELLS).toFixed(1)}, 0.0).r;
  return smoothstep(1.0 - uCloudMap.z, 1.0 - uCloudMap.z + 0.22, n);
}
// sunlight left after the clouds above a world point (soft: the shadow of the coverage, not of every puff)
float cloudShadow(vec3 p) {
  if (uCloudMap.w <= 0.0) return 1.0;
  vec2 q = p.xz + uCloudSun.xz / max(uCloudSun.y, 0.12) * max(uCloudSun.w - p.y, 0.0);
  return 1.0 - uCloudMap.w * smoothstep(0.02, 0.5, cloudCover(q));
}
`;

export function cloudUniforms() {
  return { uCloudMap: { value: CLOUD.map }, uCloudSun: { value: CLOUD.sun }, tCloudNoise: { value: CLOUD.noise } };
}

// The terrain is at the 16-texture limit with the lamps' two cookies. It reads the coverage and three's DFG table
// (dfgLUT: the split-sum scale and bias, 16 x 16) from one texture of its own: R the coverage, G the table's scale
// and bias side by side. A variant of the terrain without the cloud lookup (to fit the cookies) lit the whole ground
// as if the clouds had gone the moment a lamp was switched on. Define CLOUD_DFG, add CLOUD_DFG_GLSL and read the DFG
// through dfgOf (lightsFragmentBeginDFG).
const DFG_X = 8, DFG_Y = 8, DFG_BIAS = 32;   // texel of the scale table's corner; the bias table this far across
let coverDFG = null;
// dfg: three's table as half floats, scale and bias interleaved, a row per dotNV, roughness across
export function cloudDFGTexture(dfg) {
  if (coverDFG) return coverDFG;
  if (dfg.length !== 512) console.warn('clouds: three\'s DFG table is not 16 x 16 any more');
  const N = NOISE_N, src = CLOUD.noise.image.data, data = new Uint16Array(N * N * 2);
  for (let i = 0; i < N * N; i++) data[i * 2] = src[i];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const o = (DFG_Y + y) * N + DFG_X + x, i = (y * 16 + x) * 2;
    data[o * 2 + 1] = dfg[i];
    data[(o + DFG_BIAS) * 2 + 1] = dfg[i + 1];
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGFormat, THREE.HalfFloatType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return coverDFG = t;
}

export const CLOUD_DFG_GLSL = /* glsl */`
uniform sampler2D tCloudDFG;
// three's DFG table, filtered as three filters its own (linear, clamped to the edge)
vec2 dfgOf(float roughness, float dotNV) {
  vec2 t = (clamp(vec2(roughness, dotNV) * 16.0 - 0.5, 0.0, 15.0) + vec2(${DFG_X + 0.5}, ${DFG_Y + 0.5})) / ${NOISE_N.toFixed(1)};
  return vec2(textureLod(tCloudDFG, t, 0.0).g, textureLod(tCloudDFG, t + vec2(${(DFG_BIAS / NOISE_N).toFixed(6)}, 0.0), 0.0).g);
}`;

// three's lights_fragment_begin with its DFG lookup through dfgOf (dfgLUT then goes unused and takes no texture unit)
export function lightsFragmentBeginDFG() {
  const c = THREE.ShaderChunk.lights_fragment_begin, from = 'texture2D( dfgLUT, vec2( material.roughness, dotNVms ) )';
  if (!c.includes(from)) console.warn('clouds: lights_fragment_begin layout changed, the terrain still binds dfgLUT (17 texture units with the lamps)');
  return c.replace(from, 'dfgOf( material.roughness, dotNVms )');
}

// ---- 3D noise, made on the GPU slice by slice: r Perlin-Worley (shape), g / b / a Worley at 3 scales (detail)
const NOISE_FRAG = /* glsl */`
precision highp float;
uniform float uZ;
varying vec2 vUv;
vec3 h33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float worley(vec3 p, float per) {
  p *= per;
  vec3 c = floor(p), f = fract(p);
  float d = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 fp = h33(mod(c + o, per) + 0.5);
    d = min(d, length(o + fp - f));
  }
  return clamp(1.0 - d, 0.0, 1.0);
}
float grad(vec3 c, vec3 f, float per) { vec3 g = h33(mod(c, per) + 7.7) * 2.0 - 1.0; return dot(normalize(g), f); }
float perlin(vec3 p, float per) {
  p *= per;
  vec3 c = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = grad(c, f, per), n100 = grad(c + vec3(1, 0, 0), f - vec3(1, 0, 0), per);
  float n010 = grad(c + vec3(0, 1, 0), f - vec3(0, 1, 0), per), n110 = grad(c + vec3(1, 1, 0), f - vec3(1, 1, 0), per);
  float n001 = grad(c + vec3(0, 0, 1), f - vec3(0, 0, 1), per), n101 = grad(c + vec3(1, 0, 1), f - vec3(1, 0, 1), per);
  float n011 = grad(c + vec3(0, 1, 1), f - vec3(0, 1, 1), per), n111 = grad(c + vec3(1, 1, 1), f - vec3(1, 1, 1), per);
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(vUv, uZ);
  float pf = perlin(p, 4.0) * 0.6 + perlin(p, 8.0) * 0.3 + perlin(p, 16.0) * 0.15;
  pf = clamp(pf * 0.8 + 0.5, 0.0, 1.0);
  float wl = worley(p, 4.0) * 0.625 + worley(p, 8.0) * 0.25 + worley(p, 16.0) * 0.125;
  float pw = clamp(wl + pf * (1.0 - wl) - 0.25, 0.0, 1.0) / 0.75;   // Perlin-Worley: billows with round tops
  float w1 = worley(p, 6.0) * 0.625 + worley(p, 12.0) * 0.25 + worley(p, 24.0) * 0.125;
  float w2 = worley(p, 12.0) * 0.625 + worley(p, 24.0) * 0.25 + worley(p, 48.0) * 0.125;
  float w3 = worley(p, 20.0) * 0.625 + worley(p, 40.0) * 0.25 + worley(p, 80.0) * 0.125;
  gl_FragColor = vec4(pw, w1, w2, w3);
}`;

function makeNoise3D(renderer, N = 64) {
  const rt = new THREE.WebGL3DRenderTarget(N, N, N, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false });
  const t = rt.texture;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  // mipmapped: the march picks the level from the distance (the fine erosion seen from kilometres away is smaller
  // than a texel of the cloud texture and aliased into a fixed grain)
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NOISE_FRAG, uniforms: { uZ: { value: 0 } }, depthTest: false, depthWrite: false,
  });
  const q = new FullScreenQuad(mat), prev = renderer.getRenderTarget();
  for (let z = 0; z < N; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / N;
    renderer.setRenderTarget(rt, z);
    q.render(renderer);
  }
  renderer.setRenderTarget(prev);
  mat.dispose(); q.dispose();
  return rt;
}

// ---- the raymarch
const MARCH_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
${CLOUD_GLSL}
uniform sampler3D tShape;
uniform sampler2D tLUT, tPrev, tDepth;
uniform mat4 uInvViewProj, uPrevViewProj;
uniform vec3 uCam, uLight, uLightCol, uAmbTop, uAmbBot, uOvercastCol, uHazeCol;
uniform float uOvercast;
uniform vec2 uWind3, uTexel;
uniform float uFrame, uDensity, uBlend, uHaze, uSteps, uSunGain, uPixAngle;
varying vec2 vUv;
const float BASE = ${BASE.toFixed(1)}, TOP = ${TOP.toFixed(1)};
vec3 lut(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  float t = sign(el) * sqrt(abs(el) / 1.5707963);
  return texture2D(tLUT, vec2(fract(atan(d.x, d.z) / 6.2831853), t * 0.5 + 0.5)).rgb;
}
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float cTop = 0.3;   // the top of the cloud at the last density() sample, 0..1 of the slab
float cLod = 0.0;   // mip level of the noise for the current step (from its distance)
// cloud density at a world point; lod 1 adds the eroding detail
float density(vec3 p, float detail) {
  float h = (p.y - BASE) / (TOP - BASE);
  if (h < 0.0 || h > 1.0) return 0.0;
  float cov = cloudCover(p.xz);
  if (cov < 0.01) return 0.0;
  // flat bellies all at one height (the plane of bases running off to the horizon is the strongest cue to their
  // size and distance), domed tops: the middle of a cloud grows tallest, and a fuller sky grows taller towers
  float top = cov * (0.3 + 0.55 * uCloudMap.z * uCloudMap.z);
  cTop = top;
  float hg = smoothstep(0.0, 0.02, h) * (1.0 - smoothstep(top * 0.45, top, h));
  vec3 q = vec3(p.x + uWind3.x, p.y, p.z + uWind3.y);
  float shape = textureLod(tShape, q / 900.0, cLod - 2.0).r;
  float d = clamp(remap(shape * hg, 1.0 - cov * 0.92, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (d <= 0.0 || detail <= 0.0) return d;
  // only the coarsest Worley octaves (cells of ~40, 20 and 10 m): finer ones alias into a fixed grain at the
  // kilometres the clouds are seen from
  float fine = textureLod(tShape, q / 240.0, cLod).g;
  // the edges (low density, the top of the cloud) are eroded the most: wisps and cauliflower billows
  fine = mix(fine, 1.0 - fine, clamp(h * 4.0, 0.0, 1.0));
  return clamp(remap(d, fine * 0.45 * detail, 1.0, 0.0, 1.0) * 1.6, 0.0, 1.0);
}
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
void main() {
  // any sky in this low-res texel's footprint? (the composite masks with the full-res depth)
  float sky = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i & 1), float(i >> 1)) - 0.5) * uTexel;
    sky = max(sky, step(0.99999, texture2D(tDepth, vUv + o).r));
  }
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 wp = uInvViewProj * ndc;
  vec3 dir = normalize(wp.xyz / wp.w - uCam);
  vec4 res = vec4(0.0, 0.0, 0.0, 1.0);
  if (sky > 0.0 && dir.y > -0.03) {
    // march only the band the tops can reach under this sky (fair-weather cumulus fill the lowest ~40 %): the
    // same steps sample the clouds far finer
    float topY = BASE + (TOP - BASE) * min(0.3 + 0.55 * uCloudMap.z * uCloudMap.z, 1.0);
    float t0 = (BASE - uCam.y) / max(dir.y, 1e-4), t1 = (topY - uCam.y) / max(dir.y, 1e-4);
    if (dir.y < 1e-4) { t0 = 0.0; t1 = 0.0; }
    // a grazing ray crosses tens of km of the slab: march its first 14 km (the haze hides the rest) with more steps
    t1 = min(t1, min(t0 + 14000.0, 42000.0));
    if (t1 > t0) {
      float n = uSteps * mix(1.0, 1.5, smoothstep(3000.0, 12000.0, t1 - t0));
      float dt = (t1 - t0) / n;
      // white noise in space, a golden-ratio walk in time: each pixel visits evenly spread offsets, which the
      // temporal blend averages far better than fresh noise (a gradient-noise pattern showed as a grid)
      float jit = fract(cHash(gl_FragCoord.xy * 0.731) + uFrame * 0.6180340);
      float t = t0 + dt * jit;
      // the fine erosion fades out with distance: sampled steps far apart it aliased into vertical streaks
      float detail = 1.0 - smoothstep(6000.0, 14000.0, t0);
      float mu = dot(dir, uLight);
      // multiple scattering, approximated by octaves (Hillaire / Wrenninge): each scatters less, reaches deeper and
      // is less forward-peaked; deep cloud is lit softly instead of going grey
      float ph0 = hg(mu, 0.72) * 0.65 + hg(mu, -0.2) * 0.35;
      float ph1 = hg(mu, 0.36) * 0.65 + hg(mu, -0.1) * 0.35;
      float ph2 = 1.0 / (4.0 * 3.14159265);
      vec3 col = vec3(0.0); float T = 1.0, dsum = 0.0, tw = 0.0;
      for (int i = 0; i < 144; i++) {
        if (float(i) >= n || T < 0.02) break;
        vec3 p = uCam + dir * t;
        // a cloud texel's footprint against a texel of the 240 m detail noise (3.75 m)
        cLod = log2(max(t * uPixAngle / 3.75, 1.0));
        float d = density(p, detail) * uDensity, top = cTop;
        if (d > 0.002) {
          // light: optical depth towards the sun in a few growing steps
          float od = 0.0, ls = 35.0;
          vec3 lp = p + uLight * ls * (jit - 0.5);   // jittered too: fixed steps banded the self-shadow
          for (int j = 0; j < 5; j++) { lp += uLight * ls; od += density(lp, j < 2 ? detail : 0.0) * uDensity * ls; ls *= 1.7; }
          float sigma = 0.026;
          float tau = od * sigma;
          float sun = exp(-tau) * ph0 + 0.5 * exp(-tau * 0.4) * ph1 + 0.25 * exp(-tau * 0.16) * ph2;
          // "powder": light that has gone only a little way in is not yet scattered back: crisp, darker creases
          float powder = 1.0 - exp(-tau * 2.0);
          // sky light comes from above: the bellies are in the shade of the cloud over them (grey-blue), the
          // domes take the full sky
          float hr = clamp((p.y - BASE) / max(top * (TOP - BASE), 60.0), 0.0, 1.0);
          vec3 S = uLightCol * sun * mix(1.0, powder, 0.5) * uSunGain + mix(uAmbBot, uAmbTop, hr) * (0.25 + 0.75 * hr * hr);
          float ext = exp(-d * sigma * dt);
          col += T * S * (1.0 - ext);
          T *= ext;
          dsum += t * (1.0 - ext); tw += 1.0 - ext;
        }
        t += dt;
      }
      // far clouds melt into the sky
      float dist = tw > 0.0 ? dsum / tw : t0;
      float fog = 1.0 - exp(-dist * uHaze);
      vec3 hz = mix(uHazeCol, uOvercastCol * (0.6 + 0.4 * max(dir.y, 0.0)), smoothstep(0.0, 0.3, dir.y));   // as the sky (sky.js)
      col = mix(col, mix(lut(dir), hz, uOvercast) * (1.0 - T), fog);
      res = vec4(col, T);
    }
  }
  // temporal blend with last frame's clouds in the same direction
  vec4 pp = uPrevViewProj * vec4(uCam + dir * 2000.0, 1.0);
  vec2 puv = pp.xy / pp.w * 0.5 + 0.5;
  if (uBlend < 1.0 && pp.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
    res = mix(texture2D(tPrev, puv), res, uBlend);
  }
  gl_FragColor = res;
}`;

export class Clouds {
  constructor(renderer, sky) {
    this.renderer = renderer;
    this.sky = sky;
    this.enabled = true;
    this.scale = 0.25;          // resolution of the cloud texture
    this.steps = 48;
    this.noise = makeNoise3D(renderer);
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.rts = [new THREE.WebGLRenderTarget(1, 1, opt), new THREE.WebGLRenderTarget(1, 1, opt)];
    this.idx = 0;
    this.frame = 0;
    this.reset = true;
    this.wind = new THREE.Vector2();
    this.prevViewProj = new THREE.Matrix4();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        ...cloudUniforms(),
        tShape: { value: this.noise.texture }, tLUT: { value: sky.lut.texture }, tPrev: { value: null }, tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
        uCam: { value: new THREE.Vector3() }, uLight: { value: new THREE.Vector3(0, 1, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) },
        uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) }, uAmbBot: { value: new THREE.Vector3(0.2, 0.2, 0.25) }, uOvercast: { value: 0 }, uOvercastCol: { value: new THREE.Vector3() }, uHazeCol: { value: new THREE.Vector3() },
        uWind3: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() },
        uFrame: { value: 0 }, uDensity: { value: 1 }, uBlend: { value: 1 }, uHaze: { value: 0.00004 }, uSteps: { value: 48 }, uSunGain: { value: 10 }, uPixAngle: { value: 0.003 },
      },
    });
    this.quad = new FullScreenQuad(this.mat);
    this.width = 1; this.height = 1;
  }
  get texture() { return this.rts[this.idx].texture; }
  setSize(w, h) {
    const cw = Math.max(1, Math.round(w * this.scale)), ch = Math.max(1, Math.round(h * this.scale));
    if (cw === this.width && ch === this.height) return;
    this.width = cw; this.height = ch;
    for (const rt of this.rts) rt.setSize(cw, ch);
    this.reset = true;
  }
  // wind drift (m/s) and coverage come from the environment each frame
  update(dt, windX, windZ) {
    this.wind.x += windX * dt; this.wind.y += windZ * dt;
    // the coverage is tied to the world, not the local frame (origin.js): the origin goes into the offset, wrapped
    // at the texture's period
    const P = CELL * NOISE_CELLS;
    CLOUD.map.x = mod(this.wind.x + ORIGIN.x, P); CLOUD.map.y = mod(this.wind.y + ORIGIN.z, P);
  }
  render(camera, depthTexture) {
    const u = this.mat.uniforms, r = this.renderer;
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uInvViewProj.value.copy(_vp).invert();
    u.uPrevViewProj.value.copy(this.reset ? _vp : this.prevViewProj);
    u.uCam.value.copy(camera.position);
    u.uWind3.value.set(mod(this.wind.x * 1.35 + ORIGIN.x, 3600), mod(this.wind.y * 1.35 + ORIGIN.z, 3600));   // the shape drifts a little faster than the coverage: the clouds churn
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uFrame.value = this.frame++ % 1024;
    u.uBlend.value = this.reset ? 1 : 0.06;
    u.uSteps.value = this.steps;
    // the angle one texel of the cloud texture spans (radians)
    u.uPixAngle.value = 2 * Math.tan(camera.fov * Math.PI / 360) / this.height;
    u.tDepth.value = depthTexture;
    u.tPrev.value = this.rts[this.idx].texture;
    this.idx = 1 - this.idx;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rts[this.idx]);
    this.quad.render(r);
    r.setRenderTarget(prev);
    this.prevViewProj.copy(_vp);
    this.reset = false;
  }
}
const _vp = new THREE.Matrix4();
