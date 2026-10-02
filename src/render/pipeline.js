import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

// HDR render pipeline:
//   scene -> half-float target (optional MSAA)
//   -> bloom (13-tap downsample / tent upsample chain, soft threshold after exposure)
//   -> eye adaptation (log-average luminance on the GPU, no read-back; clamped per time of day)
//   -> composite: exposure, bloom, Neutral tone mapping, grade, vignette, sRGB, dither
//   -> optional FXAA.
// Every pass is a full-screen triangle; the whole chain costs well under a millisecond at 1/4 of
// the scene's pixel count (the bloom and luminance passes run at half resolution and below).

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra,
});

// 13-tap downsample (Jimenez, CoD: AW). First pass: soft threshold + Karis average against fireflies.
const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc, tExposure;
uniform vec2 uTexel;
uniform float uThreshold, uKnee, uFirst, uMaxBright;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 A = tap(vec2(-2.0, -2.0)), B = tap(vec2(0.0, -2.0)), C = tap(vec2(2.0, -2.0));
  vec3 D = tap(vec2(-1.0, -1.0)), E = tap(vec2(1.0, -1.0));
  vec3 F = tap(vec2(-2.0, 0.0)), G = tap(vec2(0.0, 0.0)), H = tap(vec2(2.0, 0.0));
  vec3 I = tap(vec2(-1.0, 1.0)), J = tap(vec2(1.0, 1.0));
  vec3 K = tap(vec2(-2.0, 2.0)), L = tap(vec2(0.0, 2.0)), M = tap(vec2(2.0, 2.0));
  vec3 c;
  if (uFirst > 0.5) {
    c = karis(D, E, I, J) * 0.5 + karis(A, B, F, G) * 0.125 + karis(B, C, G, H) * 0.125 + karis(F, G, K, L) * 0.125 + karis(G, H, L, M) * 0.125;
    float ex = texture2D(tExposure, vec2(0.5)).r;
    c *= ex;
    c = min(c, vec3(uMaxBright));
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
    c *= contrib;
  } else {
    c = (D + E + I + J) * 0.125 + (A + C + K + M) * 0.03125 + (B + F + H + L) * 0.0625 + G * 0.125;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

const UP_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-r.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(r.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, -r.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, r.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv - r).rgb + texture2D(tSrc, vUv + r).rgb + texture2D(tSrc, vUv + vec2(r.x, -r.y)).rgb + texture2D(tSrc, vUv + vec2(-r.x, r.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}`;

// log2 luminance, centre-weighted (the middle of the view matters most for adaptation)
const LUM_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.25, -0.25)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.25, -0.25)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-0.25, 0.25)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.25, 0.25)).rgb;
  float l = dot(c * 0.25, vec3(0.2126, 0.7152, 0.0722));
  vec2 d = (vUv - 0.5) * vec2(1.6, 2.0);
  float w = exp(-dot(d, d) * 2.0) + 0.15;
  gl_FragColor = vec4(log2(max(l, 1e-5)) * w, w, 0.0, 1.0);
}`;

// exposure = key / average luminance, clamped to the time-of-day range, adapted over time (log space)
const ADAPT_FRAG = /* glsl */`
uniform sampler2D tLum, tPrev;
uniform float uKey, uMin, uMax, uRate, uLevel, uReset, uBias;
varying vec2 vUv;
void main() {
  vec2 s = textureLod(tLum, vec2(0.5), uLevel).rg;
  float avgLog = s.x / max(s.y, 1e-5);
  float target = clamp(log2(uKey) - avgLog + uBias, log2(uMin), log2(uMax));
  float prev = texture2D(tPrev, vec2(0.5)).g;
  float v = uReset > 0.5 ? target : mix(prev, target, uRate);
  gl_FragColor = vec4(exp2(v), v, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tScene, tBloom, tExposure;
uniform float uBloom, uVignette, uSat, uContrast, uTime, uBloomOn;
uniform vec3 uTint, uLift;
uniform vec2 uRes;
varying vec2 vUv;
vec3 neutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float ex = texture2D(tExposure, vec2(0.5)).r;
  vec3 c = texture2D(tScene, vUv).rgb * ex;
  if (uBloomOn > 0.5) c += texture2D(tBloom, vUv).rgb * uBloom;
  c = max(c * uTint + uLift, 0.0);
  c = neutral(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  // gentle S-curve around mid grey in perceptual space
  vec3 s = toSRGB(c);
  s = clamp(mix(s, s * s * (3.0 - 2.0 * s), uContrast), 0.0, 1.0);
  vec2 v = vUv - 0.5;
  s *= 1.0 - uVignette * dot(v, v) * 1.6;
  // triangular dither: no banding in the night sky and the fog
  vec2 p = gl_FragCoord.xy + fract(uTime) * 61.0;
  s += (hash(p) + hash(p + 17.31) - 1.0) / 255.0;
  gl_FragColor = vec4(s, 1.0);
}`;

const COPY_FRAG = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

export class RenderPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quad = new FullScreenQuad(null);
    this.width = 1; this.height = 1;
    this.msaa = 4;
    this.fxaa = false;
    this.bloomLevels = 6;
    this.params = {
      bloom: true, bloomStrength: 0.06, bloomThreshold: 1.6, bloomKnee: 0.6, bloomRadius: 1.0,
      exposure: 0.72, autoExposure: false, key: 0.18, minExposure: 0.72, maxExposure: 0.72, adaptRate: 1.5, exposureBias: 0,
      vignette: 0.25, saturation: 1.0, contrast: 0.12, tint: new THREE.Color(1, 1, 1), lift: new THREE.Color(0, 0, 0),
    };
    this.time = 0;
    this.resetExposure = true;
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.msaa, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.hdr.texture.name = 'hdr';
    this.ldr = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.mips = [];
    for (let i = 0; i < this.bloomLevels; i++) this.mips.push(new THREE.WebGLRenderTarget(1, 1, hf));
    this.lum = new THREE.WebGLRenderTarget(128, 128, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    this.adapt = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }));
    this.adaptIdx = 0;

    this.downMat = mat(DOWN_FRAG, { tSrc: { value: null }, tExposure: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uFirst: { value: 0 }, uMaxBright: { value: 60 } });
    this.upMat = mat(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    this.lumMat = mat(LUM_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.adaptMat = mat(ADAPT_FRAG, { tLum: { value: this.lum.texture }, tPrev: { value: null }, uKey: { value: 0.18 }, uMin: { value: 1 }, uMax: { value: 1 }, uRate: { value: 0.05 }, uLevel: { value: 7 }, uReset: { value: 1 }, uBias: { value: 0 } });
    this.compMat = mat(COMPOSITE_FRAG, {
      tScene: { value: this.hdr.texture }, tBloom: { value: this.mips[0].texture }, tExposure: { value: null },
      uBloom: { value: 0.05 }, uBloomOn: { value: 1 }, uVignette: { value: 0.25 }, uSat: { value: 1 }, uContrast: { value: 0.1 }, uTime: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) }, uLift: { value: new THREE.Color(0, 0, 0) }, uRes: { value: new THREE.Vector2() },
    });
    this.fxaaMat = new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false });
    this.copyMat = mat(COPY_FRAG, { tSrc: { value: null } });
    this.gpuTimer = null;
  }

  configure({ msaa, fxaa }) {
    if (msaa !== undefined && msaa !== this.msaa) {
      this.msaa = msaa;
      this.hdr.dispose();
      this.hdr.samples = msaa;
    }
    if (fxaa !== undefined) this.fxaa = fxaa;
  }

  setSize(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    this.width = w; this.height = h;
    this.hdr.setSize(w, h);
    this.ldr.setSize(w, h);
    let mw = w, mh = h;
    for (const m of this.mips) { mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); m.setSize(mw, mh); }
    this.fxaaMat.uniforms.resolution.value.set(1 / w, 1 / h);
    this.compMat.uniforms.uRes.value.set(w, h);
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  render(dt = 1 / 60) {
    const r = this.renderer, P = this.params;
    this.time += dt;
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.hdr);
    r.render(this.scene, this.camera);

    // ---- eye adaptation (or a fixed exposure written to the same 1x1 target)
    const prev = this.adapt[this.adaptIdx], next = this.adapt[1 - this.adaptIdx];
    this.adaptIdx = 1 - this.adaptIdx;
    const am = this.adaptMat.uniforms;
    if (P.autoExposure) {
      this.lumMat.uniforms.tSrc.value = this.hdr.texture;
      this.lumMat.uniforms.uTexel.value.set(1 / 128, 1 / 128);
      this.pass(this.lumMat, this.lum);
      am.uMin.value = P.minExposure; am.uMax.value = P.maxExposure; am.uKey.value = P.key; am.uBias.value = P.exposureBias;
    } else {
      am.uMin.value = am.uMax.value = P.exposure; am.uBias.value = 0;
    }
    am.tPrev.value = prev.texture;
    am.uRate.value = 1 - Math.exp(-dt * P.adaptRate);
    am.uReset.value = this.resetExposure ? 1 : 0;
    this.resetExposure = false;
    this.pass(this.adaptMat, next);
    const exposureTex = next.texture;

    // ---- bloom
    if (P.bloom && P.bloomStrength > 0) {
      const dm = this.downMat.uniforms;
      dm.tExposure.value = exposureTex;
      dm.uThreshold.value = P.bloomThreshold; dm.uKnee.value = P.bloomKnee;
      let src = this.hdr.texture, sw = this.width, sh = this.height;
      for (let i = 0; i < this.mips.length; i++) {
        dm.tSrc.value = src; dm.uTexel.value.set(1 / sw, 1 / sh); dm.uFirst.value = i === 0 ? 1 : 0;
        this.pass(this.downMat, this.mips[i]);
        src = this.mips[i].texture; sw = this.mips[i].width; sh = this.mips[i].height;
      }
      const um = this.upMat.uniforms;
      um.uRadius.value = P.bloomRadius;
      r.autoClear = false;
      for (let i = this.mips.length - 1; i > 0; i--) {
        const s = this.mips[i];
        um.tSrc.value = s.texture; um.uTexel.value.set(1 / s.width, 1 / s.height);
        this.pass(this.upMat, this.mips[i - 1]);
      }
      r.autoClear = true;
    }

    // ---- composite (+ FXAA)
    const cu = this.compMat.uniforms;
    cu.tExposure.value = exposureTex;
    cu.uBloomOn.value = P.bloom && P.bloomStrength > 0 ? 1 : 0;
    cu.uBloom.value = P.bloomStrength;
    cu.uVignette.value = P.vignette; cu.uSat.value = P.saturation; cu.uContrast.value = P.contrast;
    cu.uTint.value.copy(P.tint); cu.uLift.value.copy(P.lift);
    cu.uTime.value = this.time;
    if (this.fxaa) {
      this.pass(this.compMat, this.ldr);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldr.texture;
      this.pass(this.fxaaMat, null);
    } else {
      this.pass(this.compMat, null);
    }
    r.autoClear = prevAutoClear;
  }

  dispose() {
    for (const t of [this.hdr, this.ldr, this.lum, ...this.mips, ...this.adapt]) t.dispose();
  }
}
