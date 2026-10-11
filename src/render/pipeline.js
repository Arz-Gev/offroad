import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { FOG_APPLY_GLSL } from './volumetricFog.js';

// HDR render pipeline: scene (half-float, optional MSAA, depth texture) -> SSAO -> bloom -> eye
// adaptation (GPU log-average luminance, no read-back) -> composite -> optional FXAA. Every pass is a full-screen triangle; bloom and luminance run at half resolution and below.

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
uniform float uKey, uMin, uMax, uRate, uLevel, uReset, uBias, uExp, uAuto;
varying vec2 vUv;
void main() {
  vec2 s = textureLod(tLum, vec2(0.5), uLevel).rg;
  float avgLog = s.x / max(s.y, 1e-5);
  // uAuto 0 = the fixed exposure uExp, 1 = eye adaptation; in between they cross-fade in log space, so the
  // exposure doesn't jump when the time of day passes through the adaptive range
  float target = log2(uExp);
  if (uAuto > 0.0) target = mix(target, clamp(log2(uKey) - avgLog + uBias, log2(uMin), log2(uMax)), uAuto);
  float prev = texture2D(tPrev, vec2(0.5)).g;
  float v = uReset > 0.5 ? target : mix(prev, target, uRate);
  gl_FragColor = vec4(exp2(v), v, 0.0, 1.0);
}`;

// SSAO (SAO-style hemisphere estimate), half resolution on the resolved depth. Output: r = AO (1 = open),
// g = view depth for the bilateral blur.
const AO_FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uTexel;
uniform float uProjScale, uRadius, uIntensity, uMaxPx, uFadeFar;
varying vec2 vUv;
vec3 viewPos(vec2 uv) {
  // snap to a full-res depth texel centre and unproject that same point: the half-res pixel centres fall
  // between depth texels, and fetching one texel but unprojecting another made banded normals on flat ground
  uv = (floor(uv / uTexel) + 0.5) * uTexel;
  float d = texture2D(tDepth, uv).r;
  vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float z0v(vec3 p) { return -p.z; }
void main() {
  float d0 = texture2D(tDepth, vUv).r;
  if (d0 >= 0.999999) { gl_FragColor = vec4(1.0, 1e5, 0.0, 1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 pr = viewPos(vUv + vec2(uTexel.x, 0.0)), pl = viewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 pu = viewPos(vUv + vec2(0.0, uTexel.y)), pd = viewPos(vUv - vec2(0.0, uTexel.y));
  // central differences on smooth surfaces (stable at grazing angles); the side with the smaller step
  // only across a depth edge, so silhouettes don't smear
  bool ex = abs(pr.z + pl.z - 2.0 * P.z) > 0.02 * z0v(P);
  bool ey = abs(pu.z + pd.z - 2.0 * P.z) > 0.02 * z0v(P);
  vec3 dx = ex ? (abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl) : (pr - pl) * 0.5;
  vec3 dy = ey ? (abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd) : (pu - pd) * 0.5;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  float z = -P.z;
  float rpx = min(uRadius * uProjScale / z, uMaxPx);
  float fade = 1.0 - smoothstep(uFadeFar * 0.5, uFadeFar, z);
  if (rpx < 1.5 || fade <= 0.0) { gl_FragColor = vec4(1.0, z, 0.0, 1.0); return; }
  // a 4x4 ordered pattern rotates the spiral per pixel; the 4x4 blur averages exactly one period of it,
  // so no residual pattern is left to beat against the upsampling (it showed at some pixel densities)
  vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
  vec2 lo = mod(q, 2.0), hi = floor(q * 0.5);
  float b = 4.0 * mod(2.0 * lo.x + 3.0 * lo.y, 4.0) + mod(2.0 * hi.x + 3.0 * hi.y, 4.0);   // 4x4 Bayer index 0..15
  float ang = 6.2831853 * (b + 0.5) / 16.0;
  float jit = fract(b * 0.618034);
  float occ = 0.0, r2 = uRadius * uRadius;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float t = (float(i) + jit) / float(AO_SAMPLES);
    float a = ang + float(i) * 2.3999632;
    vec3 S = viewPos(vUv + vec2(cos(a), sin(a)) * (t * t * rpx + 1.0) * uTexel);
    vec3 v = S - P;
    float vv = dot(v, v);
    // only occluders clearly above the tangent plane count: the terrain mesh's small kinks between
    // vertices (a few cm) otherwise showed up as a grid of dark dots on flat ground
    float h = dot(v, N) - (0.04 + 0.006 * z);
    occ += max(0.0, h * inversesqrt(vv + 1e-6) - 0.15) * max(0.0, 1.0 - vv / r2);
  }
  float ao = clamp(1.0 - uIntensity * occ / float(AO_SAMPLES), 0.0, 1.0);
  gl_FragColor = vec4(mix(1.0, ao, fade), z, 0.0, 1.0);
}`;

// depth-aware 4x4 box blur: covers one period of the AO rotation pattern
const AO_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tSrc, vUv).rg;
  float sum = 0.0, wsum = 0.0;
  for (int j = -2; j <= 1; j++) for (int i = -2; i <= 1; i++) {
    vec2 s = texture2D(tSrc, vUv + uDir * vec2(float(i), float(j))).rg;
    float w = max(0.0, 1.0 - abs(s.g - c.g) / (0.04 * c.g + 0.05));
    sum += s.r * w; wsum += w;
  }
  gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : 1.0, c.g, 0.0, 1.0);
}`;

// Light shafts (screen space, quarter resolution): open sky near the sun is the source (depth: nothing drawn
// in front of the dome), smeared towards the sun in two passes; trunks, crowns, hills and the truck cut it
// into beams. Added to the scene light before the grade.
const SHAFT_MASK_FRAG = /* glsl */`
uniform sampler2D tDepth, tClouds;
uniform vec2 uSun;
uniform float uAspect, uCloudsOn;
varying vec2 vUv;
void main() {
  float sky = step(0.99999, texture2D(tDepth, vUv).r);
  if (uCloudsOn > 0.5) sky *= texture2D(tClouds, vUv).a;   // a cloud in front of the sun blocks the beams
  vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
  gl_FragColor = vec4(sky * exp(-dot(dv, dv) * 5.0), 0.0, 0.0, 1.0);
}`;
const SHAFT_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uSun;
uniform float uLen;
varying vec2 vUv;
void main() {
  vec2 step = (uSun - vUv) * uLen / 24.0;
  vec2 p = vUv;
  float sum = 0.0, w = 1.0, wsum = 0.0;
  for (int i = 0; i < 24; i++) { sum += texture2D(tSrc, p).r * w; wsum += w; w *= 0.94; p += step; }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

// clouds onto the scene: a quad at the far plane, depth-tested LEQUAL, so it lands on the sky only
// (the dome writes no depth); premultiplied: scene x transmittance + cloud light
const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }`;
// four bilinear taps half a cloud texel apart (a 3x3 tent): the temporal blend leaves a fine grain of the march's
// jitter that read as cotton-wool fuzz on the cloud edges
const CLOUD_COMP_FRAG = /* glsl */`
uniform sampler2D tClouds;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  gl_FragColor = 0.25 * (texture2D(tClouds, vUv + vec2(-o.x, -o.y)) + texture2D(tClouds, vUv + vec2(o.x, -o.y))
    + texture2D(tClouds, vUv + vec2(-o.x, o.y)) + texture2D(tClouds, vUv + vec2(o.x, o.y)));
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tScene, tBloom, tExposure, tAO, tShafts, tMist, tDepth;
uniform vec3 uShaftCol, uBowCol;
uniform vec4 uBow;        // rainbow: xyz the antisolar direction, w > 0: on
uniform mat4 uProjInv;
uniform mat3 uCamRot;
uniform float uMist, uBloom, uVignette, uSat, uContrast, uTime, uBloomOn, uAOOn, uVibrance, uTone;
uniform vec3 uTint, uLift, uShadowCol, uHighCol, uVigCol;
uniform vec2 uRes;
varying vec2 vUv;
${FOG_APPLY_GLSL}
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
// ACES (Hill's fit of the RRT + ODT): deep toe, saturated, rich contrast
vec3 acesFit(vec3 c) {
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = IN * c;
  v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  return clamp(OUT * v, 0.0, 1.0);
}
// AgX with the "punchy" look (Sobotka; Wrensch's polynomial fit): graceful highlights, strong colour
vec3 agxPunchy(vec3 c) {
  const mat3 M = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 MI = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float lo = -12.47393, hi = 4.026069;
  vec3 v = clamp(log2(max(M * c, 1e-10)), lo, hi);
  v = (v - lo) / (hi - lo);
  vec3 v2 = v * v, v4 = v2 * v2;
  v = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;
  v = pow(max(v, 0.0), vec3(1.35));
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = l + 1.4 * (v - l);
  return clamp(pow(max(MI * v, 0.0), vec3(2.2)), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// CIE 1931 colour matching, the multi-lobe fit of Wyman, Sloan & Shirley (2013); l in nm
vec3 cie(float l) {
  float t1 = (l - 442.0) * (l < 442.0 ? 0.0624 : 0.0374), t2 = (l - 599.8) * (l < 599.8 ? 0.0264 : 0.0323), t3 = (l - 501.1) * (l < 501.1 ? 0.0490 : 0.0382);
  float u1 = (l - 568.8) * (l < 568.8 ? 0.0213 : 0.0247), u2 = (l - 530.9) * (l < 530.9 ? 0.0613 : 0.0322);
  float v1 = (l - 437.0) * (l < 437.0 ? 0.0845 : 0.0278), v2 = (l - 459.0) * (l < 459.0 ? 0.0385 : 0.0725);
  return vec3(0.362 * exp(-0.5 * t1 * t1) + 1.056 * exp(-0.5 * t2 * t2) - 0.065 * exp(-0.5 * t3 * t3),
              0.821 * exp(-0.5 * u1 * u1) + 0.286 * exp(-0.5 * u2 * u2),
              1.217 * exp(-0.5 * v1 * v1) + 0.681 * exp(-0.5 * v2 * v2));
}
// the rainbow at th degrees from the antisolar point: each wavelength at its own angle (primary 40.6 violet ..
// 42.3 red; the secondary reversed, wider, fainter), smeared by the sun's disc; brighter sky inside the primary
vec3 rainbow(float th) {
  if (th > 57.0) return vec3(0.0);
  const mat3 XYZ2RGB = mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float f = (float(i) + 0.5) / 12.0, l = 400.0 + 300.0 * f;
    float a1 = (th - (40.6 + 1.75 * f)) / 0.6, a2 = (th - (53.8 - 3.2 * f)) / 0.8;
    sum += XYZ2RGB * cie(l) * (exp(-a1 * a1) + 0.42 * exp(-a2 * a2));
  }
  sum = max(sum / 12.0, 0.0);
  return sum + vec3(0.06) * smoothstep(41.0, 36.0, th);
}
void main() {
  float ex = texture2D(tExposure, vec2(0.5)).r;
  vec3 c = texture2D(tScene, vUv).rgb;
  if (uAOOn > 0.5) c *= texture2D(tAO, vUv).r;
  // volumetric fog (volumetricFog.js): the scene seen through it, plus the light it scatters towards us
  if (uFogOn > 0.5) { vec4 f = fogAt(vUv, tDepth); c = c * f.a + f.rgb; }
  c *= ex;
  if (uBloomOn > 0.5) c += texture2D(tBloom, vUv).rgb * uBloom;
  c += texture2D(tShafts, vUv).r * uShaftCol * ex;
  if (uBow.w > 0.0) {
    // on the sky and on anything more than ~150 m away (the rain curtain is out there)
    float dz = texture2D(tDepth, vUv).r;
    vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
    vec3 v = vp.xyz / vp.w;
    float far = dz >= 0.99999 ? 1.0 : smoothstep(120.0, 400.0, length(v));
    float th = degrees(acos(clamp(dot(normalize(uCamRot * v), uBow.xyz), -1.0, 1.0)));
    c += rainbow(th) * uBowCol * ex * far;
  }
  // mist (a diffusion filter): light spills softly from bright areas into the darker ones beside them
  // (sky into the crowns, sunlit grass into the shade); what is dark all around stays dark
  if (uMist > 0.0) c += uMist * max(texture2D(tMist, vUv).rgb * 0.2 - c, 0.0);
  c = max(c * uTint + uLift, 0.0);
  c = uTone < 0.5 ? neutral(c) : uTone < 1.5 ? acesFit(c) : agxPunchy(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  // gentle S-curve around mid grey in perceptual space
  vec3 s = toSRGB(c);
  s = clamp(mix(s, s * s * (3.0 - 2.0 * s), uContrast), 0.0, 1.0);
  // the dream grade (display space): shadows never go black, they settle on a soft coloured floor (lavender by
  // day); highlights warm up; vibrance lifts the dull colours more than the strong ones
  float L = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = s + uShadowCol * (1.0 - s) * (1.0 - L) * (1.0 - L);
  s = mix(s, s * uHighCol, smoothstep(0.35, 1.0, L));
  float sat = max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b));
  L = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = clamp(mix(vec3(L), s, 1.0 + uVibrance * (1.0 - sat)), 0.0, 1.0);
  // vignette towards a colour (warm by day), not black
  vec2 v = vUv - 0.5;
  s = mix(s, s * uVigCol, uVignette * dot(v, v) * 1.6);
  // triangular dither: no banding in the night sky and the fog
  vec2 p = gl_FragCoord.xy + fract(uTime) * 61.0;
  s += (hash(p) + hash(p + 17.31) - 1.0) / 255.0;
  gl_FragColor = vec4(s, 1.0);
}`;

const COPY_FRAG = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

const _sunNdc = new THREE.Vector3(), _camFwd = new THREE.Vector3();

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
      mist: 0,   // the diffusion glow (0..1), see COMPOSITE_FRAG
      exposure: 0.72, autoExposure: false, auto: 1, key: 0.18, minExposure: 0.72, maxExposure: 0.72, adaptRate: 1.5, exposureBias: 0,
      vignette: 0.25, saturation: 1.0, contrast: 0.12, tint: new THREE.Color(1, 1, 1), lift: new THREE.Color(0, 0, 0),
      shadowCol: new THREE.Color(0, 0, 0), highCol: new THREE.Color(1, 1, 1), vigCol: new THREE.Color(0, 0, 0), vibrance: 0,
      tone: 1,   // tone curve: 0 Khronos neutral, 1 ACES (the look's), 2 AgX punchy
      // light shafts: direction towards the sun, its colour x strength (0: off)
      shaftDir: new THREE.Vector3(0, 1, 0), shaftCol: new THREE.Vector3(),
      // rainbow: xyz away from the sun, w strength (0: off); its light (the sun's colour x strength)
      bow: new THREE.Vector4(0, -1, 0, 0), bowCol: new THREE.Vector3(),
    };
    this.time = 0;
    this.resetExposure = true;
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.msaa, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.hdr.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.ssao = 'off';
    this.ao = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { ...hf }));
    this.hdr.texture.name = 'hdr';
    this.ldr = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.mips = [];
    for (let i = 0; i < this.bloomLevels; i++) this.mips.push(new THREE.WebGLRenderTarget(1, 1, hf));
    // the mist's blur: five levels from quarter resolution down, summed on the way up like the bloom
    this.mistMips = [];
    for (let i = 0; i < 5; i++) this.mistMips.push(new THREE.WebGLRenderTarget(1, 1, hf));
    this.lum = new THREE.WebGLRenderTarget(128, 128, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    this.adapt = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }));
    this.adaptIdx = 0;

    this.downMat = mat(DOWN_FRAG, { tSrc: { value: null }, tExposure: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uFirst: { value: 0 }, uMaxBright: { value: 60 } });
    this.upMat = mat(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    this.lumMat = mat(LUM_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.adaptMat = mat(ADAPT_FRAG, { tLum: { value: this.lum.texture }, tPrev: { value: null }, uKey: { value: 0.18 }, uMin: { value: 1 }, uMax: { value: 1 }, uRate: { value: 0.05 }, uLevel: { value: 7 }, uReset: { value: 1 }, uBias: { value: 0 }, uExp: { value: 1 }, uAuto: { value: 0 } });
    this.compMat = mat(COMPOSITE_FRAG, {
      tScene: { value: this.hdr.texture }, tBloom: { value: this.mips[0].texture }, tExposure: { value: null }, tMist: { value: this.mistMips[0].texture }, uMist: { value: 0 },
      tDepth: { value: this.hdr.depthTexture }, uBow: { value: new THREE.Vector4() }, uBowCol: { value: new THREE.Vector3() }, uProjInv: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
      uBloom: { value: 0.05 }, uBloomOn: { value: 1 }, uVignette: { value: 0.25 }, uSat: { value: 1 }, uContrast: { value: 0.1 }, uTime: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) }, uLift: { value: new THREE.Color(0, 0, 0) }, uRes: { value: new THREE.Vector2() },
      uShadowCol: { value: new THREE.Color(0, 0, 0) }, uHighCol: { value: new THREE.Color(1, 1, 1) }, uVigCol: { value: new THREE.Color(0, 0, 0) }, uVibrance: { value: 0 }, uTone: { value: 0 },
    });
    this.aoMat = mat(AO_FRAG, {
      tDepth: { value: this.hdr.depthTexture }, uProjInv: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() },
      uProjScale: { value: 1 }, uRadius: { value: 1 }, uIntensity: { value: 1.8 }, uMaxPx: { value: 80 }, uFadeFar: { value: 160 },
    });
    this.aoMat.defines = { AO_SAMPLES: 8 };
    this.aoBlurMat = mat(AO_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.shafts = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false }));
    this.shaftMaskMat = mat(SHAFT_MASK_FRAG, { tDepth: { value: this.hdr.depthTexture }, tClouds: { value: null }, uCloudsOn: { value: 0 }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.clouds = null;   // Clouds (world/clouds.js), set by the environment
    this.fog = null;      // VolumetricFog (volumetricFog.js), set by the environment
    this.cloudCompMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_COMP_FRAG, uniforms: { tClouds: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.shaftBlurMat = mat(SHAFT_BLUR_FRAG, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uLen: { value: 1 } });
    this.blackTex = new THREE.DataTexture(new Uint8Array(4), 1, 1); this.blackTex.needsUpdate = true;
    this.compMat.uniforms.tAO = { value: this.ao[1].texture };
    this.compMat.uniforms.tShafts = { value: this.blackTex };
    this.compMat.uniforms.uShaftCol = { value: new THREE.Vector3() };
    this.compMat.uniforms.uAOOn = { value: 0 };
    Object.assign(this.compMat.uniforms, { tFog: { value: this.blackTex }, uFogSize: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.1, 6000) }, uFogOn: { value: 0 } });
    this.fxaaMat = new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false });
    this.copyMat = mat(COPY_FRAG, { tSrc: { value: null } });
    this.gpuTimer = null;
  }

  configure({ msaa, fxaa, ssao }) {
    if (ssao !== undefined && ssao !== this.ssao) {
      this.ssao = ssao;
      const n = ssao === 'high' ? 16 : 8;
      if (this.aoMat.defines.AO_SAMPLES !== n) { this.aoMat.defines.AO_SAMPLES = n; this.aoMat.needsUpdate = true; }
      this.aoMat.uniforms.uRadius.value = ssao === 'high' ? 1.4 : 1.0;
    }
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
    mw = w >> 1; mh = h >> 1;
    for (const m of this.mistMips) { mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); m.setSize(mw, mh); }
    for (const t of this.ao) t.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    for (const t of this.shafts) t.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
    this.clouds?.setSize(w, h);
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

    // ---- volumetric clouds: marched at low resolution, then laid onto the sky of the HDR scene
    const cloudsOn = !!(this.clouds && this.clouds.enabled);
    if (cloudsOn) {
      this.clouds.setSize(this.width, this.height);
      this.clouds.render(this.camera, this.hdr.depthTexture);
      this.cloudCompMat.uniforms.tClouds.value = this.clouds.texture;
      this.cloudCompMat.uniforms.uTexel.value.set(1 / this.clouds.width, 1 / this.clouds.height);
      r.autoClear = false;
      this.pass(this.cloudCompMat, this.hdr);
      r.autoClear = true;
    }
    this.shaftMaskMat.uniforms.uCloudsOn.value = cloudsOn ? 1 : 0;

    // ---- volumetric fog (low resolution), laid over the scene in the composite
    const fogOn = !!(this.fog && this.fog.active);
    if (fogOn) {
      this.fog.setSize(this.width, this.height);
      this.fog.render(this.camera, this.hdr.depthTexture);
    }
    this.shaftMaskMat.uniforms.tClouds.value = cloudsOn ? this.clouds.texture : null;

    // ---- SSAO (half resolution), multiplied into the scene colour in the composite
    const aoOn = this.ssao !== 'off';
    if (aoOn) {
      const au = this.aoMat.uniforms, cam = this.camera;
      au.uProjInv.value.copy(cam.projectionMatrixInverse);
      au.uTexel.value.set(1 / this.width, 1 / this.height);
      // pixels (full res) covered by 1 m at 1 m distance
      au.uProjScale.value = cam.projectionMatrix.elements[5] * 0.5 * this.height;
      au.uMaxPx.value = this.height * 0.08;
      this.pass(this.aoMat, this.ao[0]);
      const bm = this.aoBlurMat.uniforms;
      bm.tSrc.value = this.ao[0].texture; bm.uDir.value.set(1 / this.ao[0].width, 1 / this.ao[0].height);
      this.pass(this.aoBlurMat, this.ao[1]);
    }

    // ---- light shafts: only while the sun is on (or near) the screen
    const cu0 = this.compMat.uniforms;
    cu0.tShafts.value = this.blackTex;
    if (P.shaftCol.lengthSq() > 1e-8) {
      const cam = this.camera;
      _sunNdc.copy(P.shaftDir).multiplyScalar(1000).add(cam.position).project(cam);
      cam.getWorldDirection(_camFwd);
      const facing = THREE.MathUtils.smoothstep(_camFwd.dot(P.shaftDir), 0.0, 0.35);
      const onScreen = THREE.MathUtils.smoothstep(Math.max(Math.abs(_sunNdc.x), Math.abs(_sunNdc.y)), 1.8, 0.9);
      const k = facing * onScreen;
      if (k > 0.001) {
        const sx = _sunNdc.x * 0.5 + 0.5, sy = _sunNdc.y * 0.5 + 0.5;
        const mm = this.shaftMaskMat.uniforms;
        mm.uSun.value.set(sx, sy); mm.uAspect.value = this.width / this.height;
        this.pass(this.shaftMaskMat, this.shafts[0]);
        const bm2 = this.shaftBlurMat.uniforms;
        bm2.uSun.value.set(sx, sy);
        bm2.tSrc.value = this.shafts[0].texture; bm2.uLen.value = 0.9;
        this.pass(this.shaftBlurMat, this.shafts[1]);
        bm2.tSrc.value = this.shafts[1].texture; bm2.uLen.value = 0.25;
        this.pass(this.shaftBlurMat, this.shafts[0]);
        cu0.tShafts.value = this.shafts[0].texture;
        cu0.uShaftCol.value.copy(P.shaftCol).multiplyScalar(k);
      }
    }

    // ---- eye adaptation (or a fixed exposure written to the same 1x1 target)
    const prev = this.adapt[this.adaptIdx], next = this.adapt[1 - this.adaptIdx];
    this.adaptIdx = 1 - this.adaptIdx;
    const am = this.adaptMat.uniforms;
    if (P.autoExposure) {
      this.lumMat.uniforms.tSrc.value = this.hdr.texture;
      this.lumMat.uniforms.uTexel.value.set(1 / 128, 1 / 128);
      this.pass(this.lumMat, this.lum);
      am.uMin.value = P.minExposure; am.uMax.value = P.maxExposure; am.uKey.value = P.key; am.uBias.value = P.exposureBias;
      am.uAuto.value = P.auto;
    } else {
      am.uMin.value = am.uMax.value = P.exposure; am.uBias.value = 0;
      am.uAuto.value = 0;
    }
    am.uExp.value = P.exposure;
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
    // ---- mist: the same chain without a threshold (capped near white, so the sun spreads no more than a cloud)
    const mistOn = P.bloom && P.mist > 0;
    if (mistOn) {
      const dm = this.downMat.uniforms;
      dm.tExposure.value = exposureTex;
      dm.uThreshold.value = 0; dm.uKnee.value = 1e-3; dm.uMaxBright.value = 3;
      let src = this.hdr.texture, sw = this.width >> 1, sh = this.height >> 1;   // first taps 2 px apart: quarter res in one pass
      for (let i = 0; i < this.mistMips.length; i++) {
        dm.tSrc.value = src; dm.uTexel.value.set(1 / sw, 1 / sh); dm.uFirst.value = i === 0 ? 1 : 0;
        this.pass(this.downMat, this.mistMips[i]);
        src = this.mistMips[i].texture; sw = this.mistMips[i].width; sh = this.mistMips[i].height;
      }
      dm.uMaxBright.value = 60;
      const um = this.upMat.uniforms;
      um.uRadius.value = 1;
      r.autoClear = false;
      for (let i = this.mistMips.length - 1; i > 0; i--) {
        const s = this.mistMips[i];
        um.tSrc.value = s.texture; um.uTexel.value.set(1 / s.width, 1 / s.height);
        this.pass(this.upMat, this.mistMips[i - 1]);
      }
      r.autoClear = true;
    }

    // ---- composite (+ FXAA)
    const cu = this.compMat.uniforms;
    cu.tExposure.value = exposureTex;
    cu.uBloomOn.value = P.bloom && P.bloomStrength > 0 ? 1 : 0;
    cu.uAOOn.value = aoOn ? 1 : 0;
    cu.uFogOn.value = fogOn ? 1 : 0;
    if (fogOn) { cu.tFog.value = this.fog.texture; cu.uFogSize.value.set(this.fog.width, this.fog.height); cu.uNearFar.value.set(this.camera.near, this.camera.far); }
    cu.uBloom.value = P.bloomStrength;
    cu.uMist.value = mistOn ? P.mist : 0;
    cu.uBow.value.copy(P.bow); cu.uBowCol.value.copy(P.bowCol);
    if (P.bow.w > 0) { cu.uProjInv.value.copy(this.camera.projectionMatrixInverse); cu.uCamRot.value.setFromMatrix4(this.camera.matrixWorld); }
    cu.uVignette.value = P.vignette; cu.uSat.value = P.saturation; cu.uContrast.value = P.contrast;
    cu.uTint.value.copy(P.tint); cu.uLift.value.copy(P.lift);
    cu.uShadowCol.value.copy(P.shadowCol); cu.uHighCol.value.copy(P.highCol); cu.uVigCol.value.copy(P.vigCol); cu.uVibrance.value = P.vibrance; cu.uTone.value = P.tone;
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
    for (const t of [this.hdr, this.ldr, this.lum, ...this.mips, ...this.adapt, ...this.ao, ...this.shafts]) t.dispose();
  }
}
