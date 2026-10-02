import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ATMOSPHERE_GLSL } from './atmosphere.js';
import { mulberry32 } from './noise.js';
import { ATMO, setVec4 } from '../render/shaderPatches.js';

// Sky: a 256x128 sky-view LUT rendered with single scattering whenever the light changes (time-of-day
// blends), then a dome that reads it and adds the sun disc, the moon, stars, the Milky Way and a moving
// cloud layer. The same dome (without the sun disc) renders into the PMREM environment map.

const LUT_W = 256, LUT_H = 128;

const LUT_FRAG = /* glsl */`
${ATMOSPHERE_GLSL}
uniform vec3 uSunDir, uMoonDir;
uniform vec3 uSunE, uMoonE, uNightBase;
varying vec2 vUv;
void main() {
  float az = vUv.x * 6.2831853;
  float t = vUv.y * 2.0 - 1.0;
  float el = sign(t) * t * t * 1.5707963;
  vec3 v = vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));
  vec3 c = vec3(0.0);
  if (dot(uSunE, uSunE) > 0.0) c += aScatter(v, uSunDir, 1.0) * uSunE;
  if (dot(uMoonE, uMoonE) > 0.0) c += aScatter(v, uMoonDir, 1.0) * uMoonE;
  // airglow / light pollution: a faint floor so the night sky is deep blue rather than black
  c += uNightBase * (0.55 + 0.45 * pow(1.0 - max(v.y, 0.0), 3.0));
  gl_FragColor = vec4(c, 1.0);
}`;

const LUT_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999;
}`;

const DOME_FRAG = /* glsl */`
uniform sampler2D tLUT, tNoise;
uniform vec3 uSunDir, uMoonDir, uSunDisc, uMoonDisc, uGround;
uniform vec3 uCloudLit, uCloudAmb;
uniform float uTime, uCover, uStars, uSunSize, uCloudAlpha, uMoonPhase;
uniform vec2 uWind;
uniform vec3 uCamPos;
varying vec3 vDir;

vec3 lut(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  float t = sign(el) * sqrt(abs(el) / 1.5707963);
  float az = atan(d.x, d.z);
  return texture2D(tLUT, vec2(fract(az / 6.2831853), t * 0.5 + 0.5)).rgb;
}
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }

float cloudDensity(vec2 p) {
  vec4 n = texture2D(tNoise, p);
  vec4 n2 = texture2D(tNoise, p * 3.1 + vec2(0.37, 0.71) + uWind * uTime * 0.6);
  float f = n.r * 0.55 + n.g * 0.25 + n2.b * 0.14 + n2.a * 0.06;
  return smoothstep(1.0 - uCover, 1.0 - uCover + 0.32, f);
}

float stars(vec3 d) {
  float s = 0.0;
  for (int k = 0; k < 2; k++) {
    float scale = k == 0 ? 160.0 : 330.0;
    vec3 p = d * scale;
    vec3 cell = floor(p);
    vec3 h = hash33(cell);
    float b = pow(hash13(cell + 7.0), k == 0 ? 18.0 : 30.0);
    vec3 c = cell + 0.2 + h * 0.6;
    float dd = length(p - c) / scale;
    float px = fwidth(dd) * 1.2 + 1e-5;
    float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h.x * 4.0) + h.y * 40.0);
    s += b * tw * smoothstep(px * 1.6, 0.0, dd) * 12.0;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = lut(d);
  float up = d.y;

  // below the horizon (seen only from high ground, mostly hidden by terrain): dark ground haze
  col = mix(col, uGround + col * 0.6, smoothstep(0.0, -0.08, up));

  // night sky: stars + Milky Way band, faded near the horizon by the atmosphere
  if (uStars > 0.001 && up > -0.02) {
    float hz = smoothstep(-0.02, 0.25, up);
    vec3 gal = normalize(vec3(0.35, 0.55, -0.76));
    float band = exp(-pow(dot(d, gal) / 0.16, 2.0));
    vec2 bp = vec2(atan(d.x, d.z), asin(d.y)) * 2.0;
    float mw = band * (0.45 + 0.55 * texture2D(tNoise, bp * 0.35).g) * (0.6 + 0.4 * texture2D(tNoise, bp * 1.3).r);
    col += vec3(0.55, 0.6, 0.8) * mw * 0.0016 * uStars * hz;
    col += vec3(0.85, 0.9, 1.0) * stars(d) * 0.012 * uStars * hz;
  }

  // sun disc (limb darkened) and the moon
  #ifndef NO_SUN
  float cs = dot(d, uSunDir);
  float r = acos(clamp(cs, -1.0, 1.0)) / uSunSize;
  if (r < 1.0) { float mu = sqrt(1.0 - r * r); col += uSunDisc * (0.4 + 0.6 * mu) * smoothstep(1.0, 0.9, r); }
  float cm = dot(d, uMoonDir);
  float rm = acos(clamp(cm, -1.0, 1.0)) / 0.0105;
  if (rm < 1.0) {
    // crude phase + maria from the noise texture
    vec3 mx = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 my = cross(mx, uMoonDir);
    vec2 q = vec2(dot(d - uMoonDir, mx), dot(d - uMoonDir, my)) / 0.0105;
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    float lit = clamp(dot(normalize(vec3(q, z)), normalize(vec3(uMoonPhase, 0.25, 0.6))) * 1.2 + 0.15, 0.0, 1.0);
    float maria = 0.75 + 0.25 * texture2D(tNoise, q * 0.18 + 0.5).r;
    col += uMoonDisc * lit * maria * smoothstep(1.0, 0.94, rm);
  }
  col += uMoonDisc * 0.0009 * exp(-max(rm - 1.0, 0.0) * 0.12);
  #endif

  // clouds: a layer at ~1.8 km, lit from the sun/moon direction, fading into the haze at the horizon
  if (up > 0.0 && uCloudAlpha > 0.001) {
    float h = 1800.0;
    vec2 p = (d.xz * (h / max(up, 0.02)) + uCamPos.xz) / 9000.0 + uWind * uTime;
    float den = cloudDensity(p);
    if (den > 0.001) {
      vec3 L = uSunDir.y > -0.05 ? uSunDir : uMoonDir;
      vec2 lo = normalize(L.xz + 1e-4) * 0.018;
      float shade = cloudDensity(p + lo) * 0.7 + cloudDensity(p + lo * 2.2) * 0.3;
      float light = exp(-shade * 2.4) * (1.0 - den * 0.35);
      float mu = dot(d, L);
      float g = 0.55;
      float phase = 0.35 + (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.12;
      vec3 cc = uCloudAmb * (0.75 + 0.25 * up) + uCloudLit * light * phase;
      float fade = smoothstep(0.0, 0.18, up);
      float a = den * fade * uCloudAlpha;
      // far clouds take on the sky colour behind them
      cc = mix(cc, col, (1.0 - fade) * 0.5);
      col = mix(col, cc, a);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function makeNoiseTexture(size = 256) {
  // tileable value-noise fbm, four independent channels (r: big shapes, g: mid, b/a: detail)
  const rnd = mulberry32(4242);
  const grid = (period) => { const v = new Float32Array(period * period); for (let i = 0; i < v.length; i++) v[i] = rnd(); return v; };
  const sample = (v, period, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = v[y0 * period + x0], b = v[y0 * period + x1], c = v[y1 * period + x0], d = v[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  const chans = [[4, 5], [8, 4], [16, 4], [32, 3]].map(([base, oct]) => {
    const layers = []; for (let o = 0; o < oct; o++) layers.push({ p: base << o, v: grid(base << o) });
    return layers;
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0, a = 1, n = 0;
      for (const L of chans[c]) { s += a * sample(L.v, L.p, x / size * L.p, y / size * L.p); n += a; a *= 0.5; }
      data[(y * size + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (s / n - 0.5) * 1.6 + 0.5)) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    this.lut = new THREE.WebGLRenderTarget(LUT_W, LUT_H, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.lut.texture.wrapS = THREE.RepeatWrapping;
    this.lutMat = new THREE.ShaderMaterial({
      vertexShader: LUT_VERT, fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uSunE: { value: new THREE.Vector3() }, uMoonE: { value: new THREE.Vector3() }, uNightBase: { value: new THREE.Vector3() } },
    });
    this.quad = new FullScreenQuad(this.lutMat);
    this.noise = makeNoiseTexture();
    this.uniforms = {
      tLUT: { value: this.lut.texture }, tNoise: { value: this.noise },
      uSunDir: this.lutMat.uniforms.uSunDir, uMoonDir: this.lutMat.uniforms.uMoonDir,
      uSunDisc: { value: new THREE.Vector3() }, uMoonDisc: { value: new THREE.Vector3() }, uGround: { value: new THREE.Vector3(0.02, 0.02, 0.018) },
      uCloudLit: { value: new THREE.Vector3(1, 1, 1) }, uCloudAmb: { value: new THREE.Vector3(0.3, 0.33, 0.4) },
      uTime: { value: 0 }, uCover: { value: 0.45 }, uStars: { value: 0 }, uSunSize: { value: 0.0125 }, uCloudAlpha: { value: 1 }, uMoonPhase: { value: 0.6 },
      uWind: { value: new THREE.Vector2(0.0011, 0.0004) }, uCamPos: { value: new THREE.Vector3() },
    };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1e6;   // after the opaque world: early-z skips everything the terrain covers
    this.dome.scale.setScalar(2500);
    // environment version: no sun disc (the sun's direct light is the directional light)
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, new THREE.ShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, defines: { NO_SUN: '' },
    }));
    this.envDome.scale.setScalar(100);
    this.envScene.add(this.envDome);
  }

  // sunE / moonE: illuminance (rgb) at the top of the atmosphere times the sky brightness scale
  updateLUT(sunDir, sunE, moonDir, moonE, nightBase) {
    const u = this.lutMat.uniforms;
    u.uSunDir.value.copy(sunDir); u.uMoonDir.value.copy(moonDir);
    u.uSunE.value.copy(sunE); u.uMoonE.value.copy(moonE); u.uNightBase.value.copy(nightBase);
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.lut);
    this.quad.render(r);
    r.setRenderTarget(prev);
  }

  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.dome.position.copy(camera.position);
    this.uniforms.uCamPos.value.copy(camera.position);
    // cloud shadows on the ground drift with the visible layer (its texture space is 9 km per unit)
    const u = this.uniforms, wt = u.uTime.value * 9000;
    setVec4(ATMO.atmoCloud, u.uWind.value.x * wt, u.uWind.value.y * wt, u.uCover.value, 0.42 * u.uCloudAlpha.value);
    const far = camera.far * 0.9;
    if (this.dome.scale.x !== far) this.dome.scale.setScalar(far);
  }
}
