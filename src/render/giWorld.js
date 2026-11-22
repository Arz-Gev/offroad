import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { MAP_SIZE, FAR_SIZE, FAR_CELL, FAR_N } from '../world/terrain.js';
import { ORIGIN, mod } from '../world/origin.js';
import { CLOUD_GLSL, cloudUniforms } from '../world/clouds.js';
import { SKYLINE, SKYLINE_GLSL, skylineUniforms } from './skyline.js';

// The world's indirect light, traced. A grid of light probes follows the camera; every frame each probe sends rays
// through a model of the world and keeps what comes back as a low-order picture of the light arriving at it from
// every side: its mean colour (A), how much more of each colour comes from above than from below (Y: outdoors the
// sky is blue above and the ground's bounce warm below), and which side most of the light comes from (X: by
// brightness alone). The light on a surface facing n is then pi (A + 2/3 (Y n.y + A / lum(A) (X . n.xz))).
// The model the rays see:
// - the land: the window's heights at 1 m with a pyramid of maxima over it (a ray takes long steps where it is high
//   above everything and short ones near the ground), the vista's 16 m heights beyond the window;
// - the trees: their crowns as a slab of leaves per metre of ground (how dense, from what height to what height):
//   a ray loses light in them and picks up the light the leaves send back;
// - the sky: the sky dome without the sun's disc (the same scene the reflection probe is made of), as a cube map.
// Where a ray lands on the ground it takes the ground's colour times the light on it: the sun (shadowed by the land
// near and far, the clouds and the crowns above) and the indirect light the probes found there the frame before,
// so light bounces as many times as it likes, a bounce a frame.
// Probes: LEVELS nested grids of N x N columns round the camera, SPACING apart; a column is LAYERS probes at
// HEIGHTS above the ground (the grid follows the land, so no probe is wasted in the air or under it). They live in
// three half-float textures, a row of layers per level; a probe keeps its texel while the grid moves (texel = cell
// modulo N), and a texel that got a new cell this frame starts over.
// Readers (the screen pass giScreen.js): giVolume(p, height above the ground) -> A, Y, X, the open sky's share.

export const GIW = { N: 64, LEVELS: 3, SPACING: [2, 8, 32], LAYERS: 4, HEIGHTS: [0.3, 1.6, 5, 14], RAYS: 16, TURNS: [8, 16, 16] };   // TURNS: per level, the frames between a probe's updates
const HN = 1024;                                   // the land model's texels across the window (1 m)
const HALF = MAP_SIZE / 2, FN = FAR_N + 1, FAR_HALF = FAR_SIZE / 2;
const TW = GIW.N * GIW.LAYERS, TH = GIW.N * GIW.LEVELS;
const PW = (GIW.N + 2) * GIW.LAYERS, PH = (GIW.N + 2) * GIW.LEVELS;   // the published copy: tiles with a border
const RAY_SIDE = 4;                                // a probe's rays: RAY_SIDE x RAY_SIDE texels of the ray texture
// how much of the light a metre of leaves takes at density 1; what a leaf sends back of the light on it
const SIGMA = 0.32, LEAF = [0.07, 0.125, 0.04];
const CROWN = { spruce: 1, pine: 0.8, birch: 0.55, apple: 0.7, oak: 0.75, dead: 0.12 };
const f1 = v => v.toFixed(1);

const VERT = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COPY_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D tPrev0, tPrev1, tPrev2;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  o0 = texelFetch(tPrev0, px, 0); o1 = texelFetch(tPrev1, px, 0); o2 = texelFetch(tPrev2, px, 0);
}`;

// shared by the tracer and the readers: where a probe lives in the textures, the land's height
const COMMON = /* glsl */`
#define GI_N ${GIW.N}
const float GI_SP[3] = float[3](${GIW.SPACING.map(f1).join(', ')});
const float GI_H[4] = float[4](${GIW.HEIGHTS.map(v => v.toFixed(2)).join(', ')});
uniform vec4 uGICenter[3];    // xy: each level's centre cell (local frame), zw: last frame's
uniform vec2 uGIShift[3];     // the local frame's origin in cells, modulo N
uniform sampler2D tGIHeight;  // the land at 1 m, maxima in its mip levels
// the texel of the probe at a level's cell (local) and layer
ivec2 giTexel(int l, int k, ivec2 cell) {
  vec2 t = mod(vec2(cell) + uGIShift[l], float(GI_N));
  return ivec2(k * GI_N + int(t.x), l * GI_N + int(t.y));
}
float giGround(vec2 xz, float lod) {
  if (max(abs(xz.x), abs(xz.y)) < ${f1(HALF - 2)}) return textureLod(tGIHeight, xz / ${f1(MAP_SIZE)} + 0.5, lod).r;
  return textureLod(SKYLINE_TEX, vec3((xz.yx + ${f1(FAR_HALF + FAR_CELL / 2)}) / ${f1(FN * FAR_CELL)}, 0.0), 0.0).r;
}
float giLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// the light on a surface facing n, from a probe's values
vec3 giIrradiance(vec3 A, vec3 Y, vec2 X, vec3 n) {
  return 3.14159265 * max(A + 0.6666667 * (Y * n.y + A * (dot(X, n.xz) / max(giLum(A), 1e-6))), 0.1 * A);
}
// the light arriving from the direction w
vec3 giRadiance(vec3 A, vec3 Y, vec2 X, vec3 w) { return max(A + Y * w.y + A * (dot(X, w.xz) / max(giLum(A), 1e-6)), vec3(0.0)); }
`;

// GLSL for a reader: giVolume(p, h, A, Y, X) from the published probe textures: each level's layers as tiles with
// a border that repeats the tile's far side, so the GPU's own filter works across the wrap (centres: the xy of
// uGICenter)
export function giVolumeGLSL() {
  return COMMON + /* glsl */`
uniform sampler2D tGIP0, tGIP1, tGIP2;
uniform vec3 uGIFallA, uGIFallY;   // beyond the probes: the open sky over the average ground
// p: local position, h: its height above the ground. Y.a: the open sky's share
void giVolume(vec3 p, float h, out vec3 A, out vec4 Y, out vec2 X) {
  float k0 = 0.0, k1 = 0.0, kt = 0.0;
  if (h >= GI_H[3]) { k0 = 3.0; k1 = 3.0; }
  else if (h > GI_H[2]) { k0 = 2.0; k1 = 3.0; kt = (h - GI_H[2]) / (GI_H[3] - GI_H[2]); }
  else if (h > GI_H[1]) { k0 = 1.0; k1 = 2.0; kt = (h - GI_H[1]) / (GI_H[2] - GI_H[1]); }
  else if (h > GI_H[0]) { k1 = 1.0; kt = (h - GI_H[0]) / (GI_H[1] - GI_H[0]); }
  A = vec3(0.0); Y = vec4(0.0); X = vec2(0.0);
  float left = 1.0;
  for (int l = 0; l < ${GIW.LEVELS}; l++) {
    vec2 f = p.xz / GI_SP[l], r = f - uGICenter[l].xy;
    float m = max(abs(r.x + 0.5), abs(r.y + 0.5));
    if (m >= ${f1(GIW.N / 2 - 1.5)}) continue;
    // (a level fades into the next coarser one over its last cells)
    float wl = left * clamp((${f1(GIW.N / 2 - 1.5)} - m) / 5.0, 0.0, 1.0);
    vec2 t = mod(f + uGIShift[l], ${f1(GIW.N)}) + 1.5;
    vec2 u0 = (vec2(k0, float(l)) * ${f1(GIW.N + 2)} + t) / vec2(${f1(PW)}, ${f1(PH)});
    vec3 a = textureLod(tGIP0, u0, 0.0).rgb; vec4 y = textureLod(tGIP1, u0, 0.0); vec2 x = textureLod(tGIP2, u0, 0.0).xy;
    if (kt > 0.0) {
      vec2 u1 = (vec2(k1, float(l)) * ${f1(GIW.N + 2)} + t) / vec2(${f1(PW)}, ${f1(PH)});
      a = mix(a, textureLod(tGIP0, u1, 0.0).rgb, kt); y = mix(y, textureLod(tGIP1, u1, 0.0), kt); x = mix(x, textureLod(tGIP2, u1, 0.0).xy, kt);
    }
    A += a * wl; Y += y * wl; X += x * wl;
    left -= wl;
    if (left < 0.002) break;
  }
  A += uGIFallA * left; Y += vec4(uGIFallY, 1.0) * left;
}
`;
}

// the light at one point (the truck), for the CPU: A | Y | X side by side (see WorldGI.here)
const HERE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
uniform vec3 uPos;
${SKYLINE_GLSL}
${giVolumeGLSL()}
void main() {
  vec3 A; vec4 Y; vec2 X;
  giVolume(uPos, max(uPos.y - giGround(uPos.xz, 0.0), 0.0), A, Y, X);
  gl_FragColor = gl_FragCoord.x < 1.0 ? vec4(A, 1.0) : gl_FragCoord.x < 2.0 ? Y : vec4(X, 0.0, 1.0);
}`;

// the probes as the readers take them: tiles with a border (see giVolumeGLSL)
const PUBLISH_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D tPrev0, tPrev1, tPrev2;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), tile = px / ${GIW.N + 2};
  ivec2 t = ivec2(mod(vec2(px - tile * ${GIW.N + 2} - 1), ${f1(GIW.N)})) + tile * ${GIW.N};
  o0 = texelFetch(tPrev0, t, 0); o1 = texelFetch(tPrev1, t, 0); o2 = texelFetch(tPrev2, t, 0);
}`;

// A probe's ray directions: RAY_SIDE x RAY_SIDE of them spread evenly over the sphere, the whole set turned at
// random per probe and frame
const RAY_GLSL = /* glsl */`
vec3 hash3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
// a random rotation (Arvo)
mat3 rotFrom(vec3 u) {
  float a = 6.2831853 * u.x, b = 6.2831853 * u.y, s = sqrt(u.z);
  vec3 v = vec3(cos(b) * s, sin(b) * s, sqrt(1.0 - u.z));
  float ca = cos(a), sa = sin(a);
  return (2.0 * outerProduct(v, v) - mat3(1.0)) * mat3(ca, sa, 0.0, -sa, ca, 0.0, 0.0, 0.0, 1.0);
}
vec3 rayDir(ivec2 probe, int i, float frame) {
  float z = 1.0 - (2.0 * float(i) + 1.0) / ${f1(GIW.RAYS)}, r = sqrt(1.0 - z * z), ph = float(i) * 2.39996323;
  return rotFrom(hash3(vec3(vec2(probe), frame))) * vec3(r * cos(ph), z, r * sin(ph));
}`;

// One ray per texel: a probe's rays are a RAY_SIDE x RAY_SIDE block of the ray texture (rgb the light that came
// back, a the open sky's share). A probe's rays in one long shader cost a millisecond a frame however few probes
// were due, and twice the time when all were: the GPU runs many short shaders side by side, but each long one
// start to end.
const TRACE_FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
precision highp sampler2DArray;
layout(location = 0) out vec4 o0;
${CLOUD_GLSL}
${SKYLINE_GLSL}
${COMMON}
uniform sampler2D tPrev0, tPrev1, tPrev2, tCanopy, tAlbedo;
uniform samplerCube tSky;
${RAY_GLSL}
uniform vec3 uSunDir, uSunCol, uSkyE, uLeaf, uFallA, uFallY, uGroundAvg;
uniform float uFrame, uMaxH, uSkyK;
const float PI = 3.14159265, NEAR_LEAVES = 2.5;
bool inWindow(vec2 xz) { return max(abs(xz.x), abs(xz.y)) < ${f1(HALF - 2)}; }
// the crowns over a place: r density, g and b the slab's bottom and top above the ground (times the density)
vec4 canopyAt(vec2 xz, float lod) { return inWindow(xz) ? textureLod(tCanopy, xz / ${f1(MAP_SIZE)} + 0.5, lod) : vec4(0.0); }

// the light the probes found on the ground at p the frame before (the grid as it was then; the nearest column: the
// rays of a probe land all over, which averages better than a filter would)
vec3 lastLight(vec3 p, vec3 n) {
  for (int l = 0; l < ${GIW.LEVELS}; l++) {
    vec2 f = p.xz / GI_SP[l], r = f - uGICenter[l].zw;
    if (max(abs(r.x + 0.5), abs(r.y + 0.5)) >= ${f1(GIW.N / 2 - 1.5)}) continue;
    ivec2 q = giTexel(l, 0, ivec2(floor(f + 0.5)));
    return giIrradiance(texelFetch(tPrev0, q, 0).rgb, texelFetch(tPrev1, q, 0).rgb, texelFetch(tPrev2, q, 0).xy, n);
  }
  return giIrradiance(uFallA, uFallY, vec2(0.0), n);
}
// the sun over a place: the land far away (skyline.js) and the clouds
float sunOver(vec3 p) { return skylineShade(p) * cloudShadow(p); }
// the sun on the ground at p through the crowns above, towards the sun
float sunThrough(vec3 p) {
  float tau = 0.0, sy = max(uSunDir.y, 0.15);
  for (int i = 0; i < 2; i++) {
    float hr = i == 0 ? 4.0 : 12.0, dh = i == 0 ? 8.0 : 12.0;
    vec4 cn = canopyAt(p.xz + uSunDir.xz * (hr / sy), 1.0);
    if (cn.r > 0.004) tau += ${SIGMA} * cn.r * max(min(hr + 0.5 * dh, cn.b / cn.r) - max(hr - 0.5 * dh, cn.g / cn.r), 0.0) / sy;
  }
  return exp(-tau);
}
// the light leaving the ground at p towards the probe
vec3 groundLight(vec3 p) {
  vec3 alb = uGroundAvg, n;
  if (inWindow(p.xz)) {
    vec2 uv = p.xz / ${f1(MAP_SIZE)} + 0.5;
    alb = textureLod(tAlbedo, uv, 0.0).rgb; alb *= alb;
    n.xz = textureLod(tGIHeight, uv, 0.0).gb;
    n.y = sqrt(max(1.0 - dot(n.xz, n.xz), 0.0));
  } else {
    const float e = ${f1(FAR_CELL)};
    n = normalize(vec3(giGround(p.xz - vec2(e, 0.0), 0.0) - giGround(p.xz + vec2(e, 0.0), 0.0), 2.0 * e,
      giGround(p.xz - vec2(0.0, e), 0.0) - giGround(p.xz + vec2(0.0, e), 0.0)));
  }
  vec3 E = lastLight(p, n);
  float ndl = dot(n, uSunDir);
  if (ndl > 0.0 && uSunCol.r + uSunCol.g + uSunCol.b > 1e-5) {
    float v = sunOver(p + vec3(0.0, 0.5, 0.0));
    if (v > 0.003) v *= sunThrough(p);
    E += uSunCol * (ndl * v);
  }
  return alb * E * (1.0 / PI);
}
// the light arriving at o from the direction d; sky: how much of it is open sky's
vec3 trace(vec3 o, vec3 d, float h0, out float sky) {
  float t = 0.0, st = 0.25, trans = 1.0, hPrev = h0, sunK = -1.0;
  vec3 L = vec3(0.0), p = o;
  bool hit = true;   // (a ray that runs out of steps is skimming the ground)
  sky = 0.0;
  for (int i = 0; i < 40; i++) {
    float tn = t + st;
    p = o + d * tn;
    float lod = clamp(log2(st), 0.0, 8.0);
    float h = giGround(p.xz, lod);
    if (p.y < h) {
      // under the highest ground of this step's stretch: look closer, or it is the ground
      if (st <= 0.5) break;
      st *= 0.5;
      continue;
    }
    // The leaves the step passed through. Not the ones within a few metres: a probe inside a crown would be shut in
    // by it, and so would the crown's own outer leaves that take their light from it; what a crown does to itself
    // is the screen pass's to find (giScreen.js), leaf by leaf
    vec4 cn = t + 0.5 * st > NEAR_LEAVES ? canopyAt(o.xz + d.xz * (t + 0.5 * st), lod) : vec4(0.0);
    if (cn.r > 0.004) {
      float bot = cn.g / cn.r, top = cn.b / cn.r;
      float y0 = o.y + d.y * t - hPrev, y1 = p.y - h, lo = min(y0, y1), hi = max(y0, y1);
      float frac = hi - lo > 0.05 ? clamp((min(hi, top) - max(lo, bot)) / (hi - lo), 0.0, 1.0) : (lo > bot && lo < top ? 1.0 : 0.0);
      float tau = ${SIGMA} * cn.r * st * frac;
      if (tau > 0.001) {
        vec3 pm = o + d * (t + 0.5 * st);
        if (sunK < 0.0) sunK = sunOver(pm);
        // a leaf here: under what is left of the crown above it, lit by the sky and the sun through that
        float od = ${SIGMA} * cn.r * max(top - clamp(0.5 * (y0 + y1), bot, top), 0.0);
        vec3 E = uSkyE * exp(-od) + uSunCol * (0.5 * sunK * exp(-od / max(uSunDir.y, 0.2)));
        float a = 1.0 - exp(-tau);
        L += uLeaf * E * (trans * a / PI);
        trans *= 1.0 - a;
        if (trans < 0.02) { trans = 0.0; hit = false; break; }
      }
    }
    // the next step: longer, and as long as the ray is clear of the highest ground round here (the next sample
    // looks at the highest ground of that longer stretch, and comes back if the ray is under it)
    hPrev = h; t = tn; st = min(max(st * 1.25, 0.7 * (p.y - h)), 160.0);
    if ((p.y > uMaxH && d.y > 0.0) || t > 800.0) { hit = false; break; }
  }
  if (trans <= 0.0) return L;
  if (hit) {
    // between the last point above the ground and the first below it
    float a = t, b = t + st;
    for (int i = 0; i < 3; i++) { float m = 0.5 * (a + b); vec3 q = o + d * m; if (q.y < giGround(q.xz, 0.0)) b = m; else a = m; }
    p = o + d * a;
    p.y = giGround(p.xz, 0.0);
    return L + groundLight(p) * trans;
  }
  sky = trans;
  return L + textureLod(tSky, d, 1.0).rgb * (uSkyK * trans);
}
void main() {
  ivec2 rp = ivec2(gl_FragCoord.xy), px = rp / ${RAY_SIDE};
  int l = px.y / GI_N, k = px.x / GI_N;
  ivec2 t = ivec2(px.x - k * GI_N, px.y - l * GI_N);
  vec2 base = uGICenter[l].xy - ${f1(GIW.N / 2)};
  vec2 xz = (base + mod(vec2(t) - uGIShift[l] - base, float(GI_N))) * GI_SP[l];
  float g = giGround(xz, 0.0), sky;
  vec3 d = rayDir(px, (rp.x - px.x * ${RAY_SIDE}) + ${RAY_SIDE} * (rp.y - px.y * ${RAY_SIDE}), uFrame);
  o0 = vec4(min(trace(vec3(xz.x, g + GI_H[k], xz.y), d, g, sky), vec3(64.0)), sky);
}`;

// A probe's rays into its values, and those into the running mean
const MIX_FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D tPrev0, tPrev1, tPrev2, tRays;
uniform vec4 uGICenter[3];
uniform vec2 uGIShift[3];
uniform float uFrame, uMaxN;
${RAY_GLSL}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int l = px.y / ${GIW.N};
  vec2 t = vec2(px.x % ${GIW.N}, px.y % ${GIW.N});
  // the cell this texel holds now, and the one it held last frame
  vec2 base = uGICenter[l].xy - ${f1(GIW.N / 2)}, baseP = uGICenter[l].zw - ${f1(GIW.N / 2)};
  vec2 cell = base + mod(t - uGIShift[l] - base, ${f1(GIW.N)}), cellP = baseP + mod(t - uGIShift[l] - baseP, ${f1(GIW.N)});
  bool fresh = any(greaterThan(abs(cell - cellP), vec2(0.5)));
  mat3 R = rotFrom(hash3(vec3(vec2(px), uFrame)));
  vec3 A = vec3(0.0), Y = vec3(0.0); vec2 X = vec2(0.0); float V = 0.0;
  for (int i = 0; i < ${GIW.RAYS}; i++) {
    float z = 1.0 - (2.0 * float(i) + 1.0) / ${f1(GIW.RAYS)}, r = sqrt(1.0 - z * z), ph = float(i) * 2.39996323;
    vec3 d = R * vec3(r * cos(ph), z, r * sin(ph));
    vec4 Li = texelFetch(tRays, px * ${RAY_SIDE} + ivec2(i % ${RAY_SIDE}, i / ${RAY_SIDE}), 0);
    A += Li.rgb; Y += Li.rgb * d.y; X += dot(Li.rgb, vec3(0.2126, 0.7152, 0.0722)) * d.xz; V += Li.a;
  }
  A *= ${(1 / GIW.RAYS).toFixed(6)}; Y *= ${(3 / GIW.RAYS).toFixed(6)}; X *= ${(3 / GIW.RAYS).toFixed(6)}; V *= ${(1 / GIW.RAYS).toFixed(6)};
  vec4 p0 = texelFetch(tPrev0, px, 0), p1 = texelFetch(tPrev1, px, 0), p2 = texelFetch(tPrev2, px, 0);
  // a running mean over the last uMaxN updates (a new probe: this one alone)
  float n = fresh ? 0.0 : min(p0.a, uMaxN), a = 1.0 / (n + 1.0);
  o0 = vec4(mix(p0.rgb, A, a), n + 1.0);
  o1 = mix(p1, vec4(Y, V), a);
  o2 = vec4(mix(p2.xy, X, a), 0.0, 1.0);
}`;

export class WorldGI {
  constructor(renderer) {
    this.renderer = renderer;
    const rt = () => new THREE.WebGLRenderTarget(TW, TH, { count: 3, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.rt = [rt(), rt()];
    this.cur = 0;
    this.frame = 0;
    this.maxN = 12;          // how many updates a probe's light is the mean of (less: follows a change faster, noisier)
    this.hurry = 0;          // frames left of following fast (the hour was set, a new window)
    this.centers = Array.from({ length: GIW.LEVELS }, () => new THREE.Vector4());
    this.shifts = Array.from({ length: GIW.LEVELS }, () => new THREE.Vector2());
    this.abs = null;         // each level's centre cell, absolute
    this.heightTex = new THREE.DataTexture(new Float32Array(HN * HN * 4), HN, HN, THREE.RGBAFormat, THREE.FloatType);
    this.heightTex.minFilter = THREE.LinearMipmapLinearFilter; this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.generateMipmaps = false;
    this.canopyTex = new THREE.DataTexture(new Float32Array(HN * HN * 4), HN, HN, THREE.RGBAFormat, THREE.FloatType);
    this.canopyTex.minFilter = THREE.LinearMipmapLinearFilter; this.canopyTex.magFilter = THREE.LinearFilter;
    this.canopyTex.generateMipmaps = true;
    this.sky = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.skyCam = new THREE.CubeCamera(0.1, 1000, this.sky);
    this.skyOf = null;       // the reflection probe the sky cube was made with
    // shared with the readers
    this.uniforms = {
      uGICenter: { value: this.centers }, uGIShift: { value: this.shifts }, tGIHeight: { value: this.heightTex },
      tGIP0: { value: this.rt[0].textures[0] }, tGIP1: { value: this.rt[0].textures[1] }, tGIP2: { value: this.rt[0].textures[2] },
      uGIFallA: { value: new THREE.Vector3() }, uGIFallY: { value: new THREE.Vector3() },
      tSkyline: { value: SKYLINE.tex }, uSkyline: { value: SKYLINE.on },
    };
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: TRACE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        ...cloudUniforms(), ...skylineUniforms(),
        uGICenter: this.uniforms.uGICenter, uGIShift: this.uniforms.uGIShift, tGIHeight: this.uniforms.tGIHeight,
        tPrev0: { value: null }, tPrev1: { value: null }, tPrev2: { value: null }, tCanopy: { value: this.canopyTex }, tAlbedo: { value: null },
        tSky: { value: this.sky.texture },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3() }, uSkyE: { value: new THREE.Vector3() },
        uLeaf: { value: new THREE.Vector3(...LEAF) }, uFallA: this.uniforms.uGIFallA, uFallY: this.uniforms.uGIFallY, uGroundAvg: { value: new THREE.Vector3(0.13, 0.13, 0.07) },
        uFrame: { value: 0 }, uMaxN: { value: 12 }, uMaxH: { value: 200 }, uSkyK: { value: 1 },
      },
    });
    // (the far shadow is sampled per pixel here whatever the level's setting says)
    this.mat.uniforms.uSkyline = { value: { x: 1, y: 0, z: 1, w: 0 } };
    this.copyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tPrev0: this.mat.uniforms.tPrev0, tPrev1: this.mat.uniforms.tPrev1, tPrev2: this.mat.uniforms.tPrev2 },
    });
    this.rays = new THREE.WebGLRenderTarget(TW * RAY_SIDE, TH * RAY_SIDE, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.mixMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: MIX_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tPrev0: this.mat.uniforms.tPrev0, tPrev1: this.mat.uniforms.tPrev1, tPrev2: this.mat.uniforms.tPrev2, tRays: { value: this.rays.texture },
        uGICenter: this.uniforms.uGICenter, uGIShift: this.uniforms.uGIShift, uFrame: this.mat.uniforms.uFrame, uMaxN: this.mat.uniforms.uMaxN,
      },
    });
    this.pub = new THREE.WebGLRenderTarget(PW, PH, { count: 3, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.pubMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: PUBLISH_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tPrev0: { value: null }, tPrev1: { value: null }, tPrev2: { value: null } },
    });
    this.pubQuad = new FullScreenQuad(this.pubMat);
    this.uniforms.tGIP0.value = this.pub.textures[0]; this.uniforms.tGIP1.value = this.pub.textures[1]; this.uniforms.tGIP2.value = this.pub.textures[2];
    // the light at the truck, read back for what is lit on the CPU or by a uniform (dust, the cabin): A, Y (a: the
    // open sky's share), X
    this.here = { A: new THREE.Vector3(0.1, 0.1, 0.1), Y: new THREE.Vector4(0, 0, 0, 1), X: new THREE.Vector2(), ok: false };
    this.hereRT = new THREE.WebGLRenderTarget(3, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.hereMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: HERE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { ...this.uniforms, uPos: { value: new THREE.Vector3() } },
    });
    this.hereQuad = new FullScreenQuad(this.hereMat);
    this.hereBuf = new Uint16Array(12);
    this.hereBusy = false;
    this.copyQuad = new FullScreenQuad(this.copyMat);
    this.quad = new FullScreenQuad(this.mat);
    this.mixQuad = new FullScreenQuad(this.mixMat);
    this.turns = GIW.TURNS.slice();
    this.row = GIW.TURNS.map(() => 0);   // each level's next row
  }

  // a window's land and trees. trees: x, y, z, scale, yaw, kind, sub per tree (windowBake.js); kinds: per kind
  // { kind, height, crownR, crownBase }
  setWindow(terrain, trees, kinds) {
    // ---- the land: every second height (1 m) with its normal's x and z, and in the mip levels the maxima of the
    // heights over ever larger squares
    const NN = terrain.NN, H = terrain.heights, base = new Float32Array(HN * HN * 4), mx = new Float32Array(HN * HN);
    let top = -1e9;
    for (let kz = 0; kz < HN; kz++) for (let kx = 0; kx < HN; kx++) {
      const ix = 2 * kx + 1, iz = 2 * kz + 1, o = ix * NN + iz, q = (kz * HN + kx) * 4;
      base[q] = H[o];
      const nx = H[o - NN] - H[o + NN], nz = H[o - 1] - H[o + 1], il = 1 / Math.hypot(nx, 1, nz);   // (the samples either side are 1 m apart)
      base[q + 1] = nx * il; base[q + 2] = nz * il;
      const m = Math.max(H[o], H[o - 1], H[o + 1], H[o - NN], H[o + NN], H[o - NN - 1], H[o - NN + 1], H[o + NN - 1], H[o + NN + 1]);
      mx[kz * HN + kx] = m;
      if (m > top) top = m;
    }
    const mips = [{ data: base, width: HN, height: HN }];
    let src = mx, n = HN;
    while (n > 1) {
      const m = n >> 1, dst = new Float32Array(m * m), d4 = new Float32Array(m * m * 4);
      for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
        const o = 2 * j * n + 2 * i;
        d4[(j * m + i) * 4] = dst[j * m + i] = Math.max(src[o], src[o + 1], src[o + n], src[o + n + 1]);
      }
      mips.push({ data: d4, width: m, height: m });
      src = dst; n = m;
    }
    this.heightTex.image = { data: base, width: HN, height: HN };
    this.heightTex.mipmaps = mips;
    this.heightTex.needsUpdate = true;
    for (let i = 0; i < terrain.far.heights.length; i += 7) top = Math.max(top, terrain.far.heights[i]);
    this.mat.uniforms.uMaxH.value = top + 30;

    // ---- the crowns: density, bottom and top over each metre (the heights times the density: they filter right)
    const dens = new Float32Array(HN * HN), bot = new Float32Array(HN * HN).fill(1e9), tp = new Float32Array(HN * HN);
    for (let i = 0; i < trees.length; i += 7) {
      const x = trees[i] + HALF, z = trees[i + 2] + HALF, s = trees[i + 3], kd = kinds[trees[i + 5]];
      if (!kd) continue;
      const Ht = kd.height * s, cb = kd.crownBase * s, R = Math.max(1.2, kd.crownR * s), dn = CROWN[kd.kind] ?? 0.7, cone = kd.kind === 'spruce';
      const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(HN - 1, Math.ceil(x + R)), z0 = Math.max(0, Math.floor(z - R)), z1 = Math.min(HN - 1, Math.ceil(z + R));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const d = Math.hypot(cx + 0.5 - x, cz + 0.5 - z) / R;
        if (d >= 1) continue;
        let b, t;
        if (cone) { b = cb; t = cb + (Ht - cb) * (1 - d); }
        else { const c = (cb + Ht) / 2, q = (Ht - cb) / 2 * Math.sqrt(1 - d * d); b = c - q; t = c + q; }
        const o = cz * HN + cx;
        dens[o] = Math.max(dens[o], dn * Math.min(1, (1 - d) * 4));
        if (b < bot[o]) bot[o] = b;
        if (t > tp[o]) tp[o] = t;
      }
    }
    const cd = this.canopyTex.image.data;
    for (let o = 0; o < HN * HN; o++) { const d = dens[o]; cd[o * 4] = d; cd[o * 4 + 1] = d > 0 ? d * bot[o] : 0; cd[o * 4 + 2] = d * tp[o]; cd[o * 4 + 3] = 1; }
    this.canopyTex.needsUpdate = true;
    this.hurry = 12;
  }

  // start over (a jump of the camera needs nothing: every probe it brings in starts over by itself)
  reset() { this.abs = null; }

  // env: the Environment; GI: gi.js's shared values (the ground's colour map, the sky's and the sun's light).
  // Leaves its own render target set
  update(camera, env, GI) {
    const r = this.renderer, u = this.mat.uniforms;
    // the sky as the reflection probe has it (made again when that is)
    if (env.envRT && this.skyOf !== env.envRT && !env.envJob) {
      this.skyOf = env.envRT;
      this.skyCam.update(r, env.sky.envScene);
    }
    // the grids: centred a little ahead of the camera, moved two cells at a time
    const fwd = _v.set(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    const first = !this.abs;
    if (first) this.abs = GIW.SPACING.map(() => [1e7, 1e7]);
    for (let l = 0; l < GIW.LEVELS; l++) {
      const S = GIW.SPACING[l], lead = 0.22 * GIW.N * S;
      const ax = Math.round((camera.position.x + fwd.x * lead + ORIGIN.x) / (2 * S)) * 2, az = Math.round((camera.position.z + fwd.z * lead + ORIGIN.z) / (2 * S)) * 2;
      const ox = ORIGIN.x / S, oz = ORIGIN.z / S, prev = this.abs[l];
      this.centers[l].set(ax - ox, az - oz, prev[0] - ox, prev[1] - oz);
      this.shifts[l].set(mod(ox, GIW.N), mod(oz, GIW.N));
      prev[0] = ax; prev[1] = az;
    }
    // the light
    const sun = env.sun;
    u.uSunDir.value.copy(SKYLINE.dir);
    u.uSunCol.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
    u.uSkyE.value.set(GI.sky.x, GI.sky.y, GI.sky.z);
    u.uSkyK.value = env.scene.environmentIntensity ?? 1;
    u.uGroundAvg.value.set(GI.ground.x, GI.ground.y, GI.ground.z);
    u.tAlbedo.value = GI.map;
    // beyond the probes: the sky above, the average ground lit by the sun and the sky below
    const k = 1 / Math.PI;
    const sx = GI.sky.x * k, sy = GI.sky.y * k, sz = GI.sky.z * k;
    const gx = GI.ground.x * (GI.sun.x * GI.sun.w + GI.sky.x) * k, gy = GI.ground.y * (GI.sun.y * GI.sun.w + GI.sky.y) * k, gz = GI.ground.z * (GI.sun.z * GI.sun.w + GI.sky.z) * k;
    this.uniforms.uGIFallA.value.set((sx + gx) / 2, (sy + gy) / 2, (sz + gz) / 2);
    this.uniforms.uGIFallY.value.set(0.75 * (sx - gx), 0.75 * (sy - gy), 0.75 * (sz - gz));
    u.uFrame.value = this.frame++ % 1024;
    u.uMaxN.value = this.hurry > 0 ? 2 : this.maxN;

    const src = this.rt[this.cur], dst = this.rt[1 - this.cur];
    u.tPrev0.value = src.textures[0]; u.tPrev1.value = src.textures[1]; u.tPrev2.value = src.textures[2];
    // The probes that are due: a level's take turns, a band of rows a frame (the scissor keeps the rest out); the
    // rows and columns the grid's move brought in are due at once. Their rays first, into the ray texture; then
    // the grid as it was, and the due probes' new values over it.
    // (The render target is left set: the caller sets its own next.)
    const ac = r.autoClear, N = GIW.N, rects = [];
    const due = (x, y, w, h) => rects.push([x, y, w, h]);
    // texel rows or columns [a, a + n) modulo N as one or two spans
    const spans = (a, n, f) => { a = mod(a, N); if (n >= N) f(0, N); else if (a + n <= N) f(a, n); else { f(a, N - a); f(0, a + n - N); } };
    for (let l = 0; l < GIW.LEVELS; l++) {
      const c = this.centers[l], sh = this.shifts[l], y0 = l * N;
      const dx = c.x - c.z, dz = c.y - c.w;
      if (this.hurry > 0 || Math.abs(dx) >= N || Math.abs(dz) >= N) { due(0, y0, TW, N); continue; }
      const rows = Math.ceil(N / this.turns[l]);
      spans(this.row[l], rows, (a, n) => due(0, y0 + a, TW, n));
      this.row[l] = (this.row[l] + rows) % N;
      // new cells: [lo, lo + |d|) in cells -> texels (cell + shift) mod N
      if (dx) spans((dx > 0 ? c.x + N / 2 - dx : c.x - N / 2) + sh.x, Math.abs(dx), (a, n) => { for (let k = 0; k < GIW.LAYERS; k++) due(k * N + a, y0, n, N); });
      if (dz) spans((dz > 0 ? c.y + N / 2 - dz : c.y - N / 2) + sh.y, Math.abs(dz), (a, n) => due(0, y0 + a, TW, n));
    }
    if (this.hurry > 0) this.hurry--;
    r.autoClear = false;
    const rays = this.rays;
    rays.scissorTest = true;
    for (const [x, y, w, h] of rects) { rays.scissor.set(x * RAY_SIDE, y * RAY_SIDE, w * RAY_SIDE, h * RAY_SIDE); r.setRenderTarget(rays); this.quad.render(r); }
    dst.scissorTest = false;
    r.setRenderTarget(dst);
    this.copyQuad.render(r);
    dst.scissorTest = true;
    for (const [x, y, w, h] of rects) { dst.scissor.set(x, y, w, h); r.setRenderTarget(dst); this.mixQuad.render(r); }
    dst.scissorTest = false;
    r.autoClear = ac;
    this.cur = 1 - this.cur;
    // for the readers
    const pu = this.pubMat.uniforms;
    pu.tPrev0.value = dst.textures[0]; pu.tPrev1.value = dst.textures[1]; pu.tPrev2.value = dst.textures[2];
    r.setRenderTarget(this.pub);
    this.pubQuad.render(r);
  }

  // The light at a point (local), read back from the GPU without waiting for it: `here` follows a few frames later.
  // Leaves its own render target set
  readHere(p) {
    if (this.hereBusy) return;
    const r = this.renderer;
    this.hereMat.uniforms.uPos.value.copy(p);
    r.setRenderTarget(this.hereRT);
    this.hereQuad.render(r);
    this.hereBusy = true;
    r.readRenderTargetPixelsAsync(this.hereRT, 0, 0, 3, 1, this.hereBuf).then(b => {
      const f = THREE.DataUtils.fromHalfFloat, h = this.here;
      h.A.set(f(b[0]), f(b[1]), f(b[2])); h.Y.set(f(b[4]), f(b[5]), f(b[6]), f(b[7])); h.X.set(f(b[8]), f(b[9]));
      h.ok = true; this.hereBusy = false;
    }, () => { this.hereBusy = false; });
  }

  // a probe's values (debug): level, layer, local x and z
  probe(l, k, x, z) {
    const S = GIW.SPACING[l], cx = Math.round(x / S), cz = Math.round(z / S);
    const tx = mod(cx + this.shifts[l].x, GIW.N), ty = mod(cz + this.shifts[l].y, GIW.N);
    const rt = this.rt[this.cur], hf = THREE.DataUtils.fromHalfFloat, out = [];
    for (let i = 0; i < 3; i++) { const b = new Uint16Array(4); this.renderer.readRenderTargetPixels(rt, k * GIW.N + tx, l * GIW.N + ty, 1, 1, b, undefined, i); out.push(Array.from(b, hf)); }
    return { A: out[0], Y: out[1], X: out[2] };
  }
}
const _v = new THREE.Vector3();
