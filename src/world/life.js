import * as THREE from 'three';
import { PAT } from './origin.js';

// Life in the air, all on the GPU (fixed buffers, positions from the time and a seed per particle, wrapped
// round the camera, so nothing is uploaded per frame):
//   pollen   specks drifting on the wind, glowing when you look towards the sun (forward scattering), by day
//   seeds    a few dandelion tufts, bigger and slower, by day
//   flies    fireflies over grass and forest edges at dusk and night, each blinking on its own rhythm
//   wings    butterflies over the meadows by day: two wings flapping, a wandering path, a colour each
//   birds    small flocks wheeling over the land by day, flapping in bursts between glides
//   petals   drifting down from the nearest trees in blossom
//   leaves   fluttering down in the forest
// Nothing casts or receives shadows; the ground height comes from the physics height texture (as the grass).

const GROUND_GLSL = /* glsl */`
uniform highp sampler2D tHeight;
uniform sampler2D tData;
uniform vec4 uMap;      // half, cell, NN, size
float lHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float lGround(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = lHgt(i), h10 = lHgt(i + ivec2(1, 0)), h01 = lHgt(i + ivec2(0, 1)), h11 = lHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
// ground data at xz: g = forest floor, a = grass density
vec4 lData(vec2 xz) { return textureLod(tData, (xz + uMap.x + 0.5) / (uMap.w + 1.0), 0.0); }
// a seed position wrapped into a box of side B round the camera (horizontal), drifting with d; wrapped in the
// pattern frame (origin.js), so nothing jumps when the local frame shifts
uniform vec2 uPat;
vec3 lWrap(vec3 seed, float B, vec3 d) {
  vec2 xz = mod(seed.xz * B + d.xz - (uCam.xz + uPat) + 0.5 * B, B) - 0.5 * B + uCam.xz;
  return vec3(xz.x, seed.y, xz.y);
}
`;

const COMMON_UNIFORMS = /* glsl */`
uniform float uTime, uDay, uNight;
uniform vec3 uCam, uSunDir, uSunCol, uFill;
uniform vec2 uWind;
`;

// soft round sprite, additive
const SPRITE_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  float a = vA * (1.0 - r) * (1.0 - r);
  gl_FragColor = vec4(vCol * a, a);
}`;

const POLLEN_VERT = /* glsl */`
${COMMON_UNIFORMS}
${GROUND_GLSL}
attribute vec4 aSeed;
uniform float uHalfH, uBox, uSeedK;
varying vec3 vCol;
varying float vA;
void main() {
  float big = step(1.0 - uSeedK, aSeed.w);                 // a dandelion tuft instead of a speck
  vec3 drift = vec3(uWind.x, 0.0, uWind.y) * uTime * mix(0.9, 0.5, big);
  vec3 p = lWrap(aSeed.xyz, uBox, drift);
  float ph = aSeed.w * 6.2831853;
  p.x += sin(uTime * (0.31 + aSeed.y * 0.2) + ph) * 0.6;
  p.z += cos(uTime * (0.27 + aSeed.x * 0.2) + ph * 1.7) * 0.6;
  // height: 0.3 .. 5 m above the ground, slowly rising and sinking
  p.y = lGround(p.xz) + 0.3 + aSeed.y * 4.7 + sin(uTime * 0.21 + ph * 3.0) * 0.6;
  vec3 rel = p - uCam;
  float dist = length(rel);
  // fade at the edge of the box and right in front of the lens
  float fade = smoothstep(0.5 * uBox, 0.32 * uBox, length(rel.xz)) * smoothstep(0.5, 1.6, dist);
  // forward scattering: specks against the sun glow, others are faint dots of light
  float mu = dot(rel / max(dist, 1e-3), uSunDir);
  float g = 0.7, hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  float tw = 0.65 + 0.35 * sin(uTime * (1.7 + aSeed.x * 2.0) + ph * 9.0);
  vCol = mix(uSunCol * vec3(1.0, 0.88, 0.62) * (0.14 + 0.16 * hg) * tw, uSunCol * 0.2 + uFill * 0.8, big);   // golden specks, white tufts
  vA = fade * uDay;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(0.05, 0.09, big);                        // m
  gl_PointSize = max(1.5, size * projectionMatrix[1][1] * uHalfH / max(0.3, -mv.z));
  if (vA < 0.002) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;

const FLY_VERT = /* glsl */`
${COMMON_UNIFORMS}
${GROUND_GLSL}
attribute vec4 aSeed;
uniform float uHalfH, uBox;
varying vec3 vCol;
varying float vA;
void main() {
  vec3 p = lWrap(aSeed.xyz, uBox, vec3(0.0));
  float ph = aSeed.w * 6.2831853;
  p.x += sin(uTime * (0.23 + aSeed.y * 0.15) + ph) * 1.6 + sin(uTime * 0.9 + ph * 3.0) * 0.25;
  p.z += cos(uTime * (0.19 + aSeed.x * 0.15) + ph * 1.3) * 1.6 + cos(uTime * 1.1 + ph * 2.0) * 0.25;
  vec4 gd = lData(p.xz);
  float home = smoothstep(0.04, 0.3, gd.a + gd.g);   // over meadows and in the forest (not water, sand or rock)
  p.y = lGround(p.xz) + 0.7 + aSeed.y * 2.6 + sin(uTime * 0.7 + ph * 5.0) * 0.3;
  vec3 rel = p - uCam;
  float fade = smoothstep(0.5 * uBox, 0.36 * uBox, length(rel.xz)) * smoothstep(0.8, 2.0, length(rel));
  // each blinks on its own rhythm: a slow glow up, a short hold, a fade
  float b = sin(uTime * (0.7 + aSeed.x * 0.6) + ph * 4.0);
  float blink = smoothstep(0.05, 0.85, b);
  vCol = vec3(0.72, 1.0, 0.28) * 14.0 * blink;
  vA = fade * home * uNight;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.5, 0.12 * projectionMatrix[1][1] * uHalfH / max(0.3, -mv.z));
  if (vA * blink < 0.002) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;

// butterfly: one instance = two wings hinged on the body line (x = 0), z forward; aWing.x = side (-1 / 1),
// aWing.yz = wing uv (0..1 out from the body, 0..1 back to front)
const WING_VERT = /* glsl */`
${COMMON_UNIFORMS}
${GROUND_GLSL}
attribute vec4 aSeed;
attribute vec3 aWing;
uniform float uBox;
varying vec2 vUv;
varying vec3 vTint;
varying float vLit;
void main() {
  float ph = aSeed.w * 6.2831853;
  vec3 c = lWrap(aSeed.xyz, uBox, vec3(0.0));
  // a wandering loop: two slow circles of different sizes and speeds
  float s1 = 0.35 + aSeed.x * 0.3, s2 = 0.9 + aSeed.y * 0.5;
  vec2 off = vec2(sin(uTime * s1 + ph), cos(uTime * s1 * 0.8 + ph)) * 3.0 + vec2(sin(uTime * s2 + ph * 2.0), cos(uTime * s2 * 1.1)) * 0.7;
  vec2 vel = vec2(cos(uTime * s1 + ph) * s1, -sin(uTime * s1 * 0.8 + ph) * s1 * 0.8) * 3.0
           + vec2(cos(uTime * s2 + ph * 2.0) * s2, -sin(uTime * s2 * 1.1) * s2 * 1.1) * 0.7;
  // the habitat is judged at the loop's centre (not where it flies now), so one never pops out over a trail
  vec4 gd = lData(c.xz);
  float home = smoothstep(0.0, 0.12, gd.a) * (1.0 - smoothstep(0.55, 0.9, gd.g));   // meadows, not the forest
  c.xz += off;
  float flapT = uTime * (9.0 + aSeed.z * 5.0) + ph;
  c.y = lGround(c.xz) + 1.35 + aSeed.y * 1.3 + sin(uTime * 1.3 + ph) * 0.3 + sin(flapT) * 0.03;   // over the tall grass
  vec3 rel = c - uCam;
  float fade = smoothstep(0.5 * uBox, 0.42 * uBox, length(rel.xz));
  float scale = 0.12 * (0.8 + 0.4 * aSeed.z) * home * fade * uDay;
  // wings: up and down around the body line, a quick downstroke
  float flap = sin(flapT);
  float ang = 0.2 + 0.95 * (0.5 + 0.5 * flap * abs(flap) * 0.9 + 0.05 * flap);
  vec3 lp = vec3(aWing.x * aWing.y * cos(ang), aWing.y * sin(ang), (aWing.z - 0.45) * 1.15) * scale;
  // heading along the path
  float yaw = atan(vel.x, vel.y);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 wp = c + vec3(lp.x * cy + lp.z * sy, lp.y, -lp.x * sy + lp.z * cy);
  vUv = aWing.yz;
  // a colour each: orange, lemon, white, sky blue, rose
  float k = fract(aSeed.w * 7.31);
  vTint = k < 0.25 ? vec3(0.95, 0.42, 0.08) : k < 0.5 ? vec3(0.98, 0.86, 0.25) : k < 0.7 ? vec3(0.95, 0.94, 0.88) : k < 0.88 ? vec3(0.35, 0.62, 0.98) : vec3(0.95, 0.55, 0.7);
  vLit = 0.6 + 0.4 * abs(sin(ang));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (scale < 1e-4) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;

const WING_FRAG = /* glsl */`
${COMMON_UNIFORMS}
varying vec2 vUv;
varying vec3 vTint;
varying float vLit;
void main() {
  // the wing: a big rounded fore wing and a smaller hind wing
  vec2 u = vUv;
  float fore = length((u - vec2(0.42, 0.68)) / vec2(0.58, 0.36));
  float hind = length((u - vec2(0.3, 0.26)) / vec2(0.38, 0.28));
  float m = min(fore, hind);
  if (m > 1.0 || u.x < 0.02) discard;
  vec3 col = vTint;
  col = mix(col, vec3(0.06, 0.05, 0.05), smoothstep(0.78, 0.9, m) * 0.85);   // dark border
  float spot = length((u - vec2(0.72, 0.78)) / vec2(0.09, 0.07));
  col = mix(col, vec3(1.0), (1.0 - smoothstep(0.7, 1.0, spot)) * 0.8);       // a pale spot near the tip
  col *= 0.75 + 0.25 * u.x;
  vec3 light = uSunCol * 0.18 * vLit + uFill * 0.9 + vec3(0.04);
  gl_FragColor = vec4(col * light, 1.0);
}`;

// a bird: body, tail and two wings in its own frame (x across, z forward); aBird.w = 1 on the wings (they flap)
const BIRD_VERT = /* glsl */`
${COMMON_UNIFORMS}
attribute vec4 aSeed;
attribute vec4 aBird;
uniform float uBox;
uniform vec2 uPat;
varying float vLit;
void main() {
  float fl = floor(aSeed.w * 5.0);                                      // which flock
  vec3 fs = fract(vec3(fl * 0.371 + 0.13, fl * 0.719 + 0.57, fl * 0.241 + 0.91));
  vec2 fxz = mod(fs.xz * uBox + vec2(uWind.x, uWind.y) * uTime * 1.5 - (uCam.xz + uPat) + 0.5 * uBox, uBox) - 0.5 * uBox + uCam.xz;
  float R = 16.0 + fs.z * 34.0;
  float w = (0.16 + fs.x * 0.14) * (fs.y < 0.5 ? 1.0 : -1.0);          // turning one way or the other
  float a = uTime * w + aSeed.x * 1.6 + fl;                               // the birds spread along an arc
  vec3 off = vec3(sin(uTime * 0.37 + aSeed.y * 20.0), 0.5 * sin(uTime * 0.29 + aSeed.z * 20.0), cos(uTime * 0.41 + aSeed.y * 13.0)) * (2.5 + aSeed.z * 4.0);
  vec3 c = vec3(fxz.x + cos(a) * R, uCam.y + 26.0 + fs.y * 40.0 + sin(a * 2.0 + fl) * 4.0, fxz.y + sin(a) * R) + off;
  vec2 vel = vec2(-sin(a), cos(a)) * sign(w);
  float yaw = atan(vel.x, vel.y);
  // flapping in bursts, gliding in between (wings held a little up)
  float glide = smoothstep(0.1, 0.6, sin(uTime * 0.6 + aSeed.x * 12.0));
  float flap = mix(sin(uTime * (9.0 + aSeed.y * 4.0) + aSeed.z * 30.0) * 0.85, 0.12, glide);
  vec3 b = aBird.xyz;
  float ang = flap * aBird.w;
  vec3 lp = vec3(b.x * cos(ang), abs(b.x) * sin(ang) + b.y, b.z) * 0.42 * (0.85 + aSeed.z * 0.4);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 wp = c + vec3(lp.x * cy + lp.z * sy, lp.y, -lp.x * sy + lp.z * cy);
  float fade = smoothstep(0.5 * uBox, 0.4 * uBox, length(c.xz - uCam.xz)) * uDay;
  vLit = 0.5 + 0.5 * clamp(b.y * 3.0 + 0.5, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (fade < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const BIRD_FRAG = /* glsl */`
${COMMON_UNIFORMS}
varying float vLit;
void main() { gl_FragColor = vec4((vec3(0.035, 0.032, 0.04) + uSunCol * 0.012 + uFill * 0.15) * vLit, 1.0); }`;

// petals and leaves: small quads tumbling down; aCorner = quad corner (-1..1)
const FALL_COMMON = /* glsl */`
attribute vec4 aSeed;
attribute vec2 aCorner;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
vec3 tumble(vec3 c, float size, float t, float ph) {
  float a = t * (2.1 + ph) + ph * 6.0, b = t * (1.3 + ph * 0.7);
  vec3 ax = normalize(vec3(cos(a), sin(b) * 0.6, sin(a)));
  vec3 ay = normalize(cross(ax, vec3(sin(b), cos(b), 0.3)));
  vUv = aCorner * 0.5 + 0.5;
  return c + (ax * aCorner.x + ay * aCorner.y) * size;
}`;
const PETAL_VERT = /* glsl */`
${COMMON_UNIFORMS}
${GROUND_GLSL}
${FALL_COMMON}
uniform vec4 uTrees[8];   // nearby trees in blossom: x, crown height, z, crown radius (0: none)
void main() {
  int k = int(aSeed.w * 7.99);
  vec4 T = uTrees[k];
  float period = 9.0 + aSeed.x * 7.0;                       // s from leaving the crown to fading on the ground
  float t = fract(uTime / period + aSeed.y) * period;
  vec3 h = fract(aSeed.xyz * vec3(7.31, 3.17, 5.71)) - 0.5;
  vec3 p = vec3(T.x, T.y, T.z) + h * vec3(2.0, 0.8, 2.0) * T.w;
  p += vec3(uWind.x, 0.0, uWind.y) * t * 0.5 + vec3(sin(t * 1.3 + aSeed.z * 9.0), 0.0, cos(t * 1.1 + aSeed.x * 9.0)) * 0.6;
  p.y -= t * 0.75;
  float gy = lGround(p.xz) + 0.03;
  float landed = step(p.y, gy);
  p.y = max(p.y, gy);
  float ph = fract(aSeed.z * 13.7);
  vec3 wp = tumble(p, 0.045, landed > 0.5 ? 0.0 : t, ph);
  float pink = fract(aSeed.x * 17.3);
  vCol = pink < 0.55 ? vec3(0.95, 0.62, 0.12) : pink < 0.85 ? vec3(0.98, 0.8, 0.2) : vec3(0.85, 0.4, 0.08);   // golden leaves
  vA = step(0.001, T.w) * smoothstep(0.0, 0.6, t) * (1.0 - smoothstep(period * 0.85, period, t)) * uDay;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vA < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const LEAF_VERT = /* glsl */`
${COMMON_UNIFORMS}
${GROUND_GLSL}
${FALL_COMMON}
uniform float uBox;
void main() {
  float period = 8.0 + aSeed.x * 6.0;
  float t = fract(uTime / period + aSeed.y) * period;
  vec3 p = lWrap(aSeed.xyz, uBox, vec3(0.0));
  vec4 gd = lData(p.xz);
  // in the woods, and (fewer) carried out over the open land by the wind: Ghost of Tsushima's drifting gold leaves
  float forest = max(smoothstep(0.35, 0.7, gd.g), step(aSeed.z, 0.4) * 0.8);
  p.y = lGround(p.xz) + 4.0 + aSeed.z * 9.0 - t * 1.0;
  p.xz += vec2(sin(t * 0.9 + aSeed.w * 9.0), cos(t * 0.8 + aSeed.x * 9.0)) * 0.8 + vec2(uWind.x, uWind.y) * t * 1.1;
  float gy = lGround(p.xz) + 0.03;
  p.y = max(p.y, gy);
  vec3 wp = tumble(p, 0.05, t, fract(aSeed.w * 11.3));
  float c = fract(aSeed.w * 23.1);
  vCol = c < 0.55 ? vec3(0.88, 0.64, 0.14) : c < 0.85 ? vec3(0.8, 0.4, 0.1) : vec3(0.5, 0.62, 0.15);
  float fade = smoothstep(0.5 * uBox, 0.38 * uBox, length(p.xz - uCam.xz));
  vA = forest * fade * smoothstep(0.0, 0.8, t) * (1.0 - smoothstep(period * 0.8, period, t)) * (0.3 + 0.7 * uDay);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vA < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const FALL_FRAG = /* glsl */`
${COMMON_UNIFORMS}
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  if (dot(q * vec2(1.0, 1.6), q * vec2(1.0, 1.6)) > 1.0) discard;
  vec3 light = uSunCol * 0.2 + uFill * 0.9 + vec3(0.05);
  gl_FragColor = vec4(vCol * light, 1.0);
}`;

function seeds(n, rnd = Math.random) {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

export function buildLife(terrainView, env, trees) {
  const TU = terrainView.uniforms;
  const group = new THREE.Group();
  group.name = 'life';
  const shared = {
    tHeight: TU.tHeight, tData: TU.tData, uMap: TU.uMap, uPat: PAT,
    uTime: { value: 0 }, uDay: { value: 1 }, uNight: { value: 0 },
    uCam: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3(1, 1, 1) },
    uFill: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(0.5, 0.3) },
    uHalfH: { value: 500 },
  };
  const points = (n, vert, box, extra = {}) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds(n), 4));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: SPRITE_FRAG, uniforms: { ...shared, uBox: { value: box }, ...extra },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      // alpha: what the sprites cover, so the depth of field keeps them sharp (render/pipeline.js)
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false; p.renderOrder = 2;
    group.add(p);
    return p;
  };
  const pollen = points(900, POLLEN_VERT, 40, { uSeedK: { value: 0.02 } });
  const flies = points(420, FLY_VERT, 56);

  // butterflies: two wing quads per instance
  const wingGeo = new THREE.InstancedBufferGeometry();
  {
    const w = [], idx = [];
    for (const side of [-1, 1]) {
      const o = w.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) w.push(side, u, v);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    wingGeo.setAttribute('aWing', new THREE.Float32BufferAttribute(w, 3));
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(w.length), 3));
    wingGeo.setIndex(idx);
    const N = 150;
    wingGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(N), 4));
    wingGeo.instanceCount = N;
    wingGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  const wings = new THREE.Mesh(wingGeo, new THREE.ShaderMaterial({
    vertexShader: WING_VERT, fragmentShader: WING_FRAG, uniforms: { ...shared, uBox: { value: 64 } }, side: THREE.DoubleSide,
  }));
  wings.frustumCulled = false;
  group.add(wings);

  // birds: body, tail and two wings (x across, z forward, w = 1 where it flaps)
  const birdGeo = new THREE.InstancedBufferGeometry();
  {
    const v = [
      0, 0, 0.55, 0, -0.07, 0, -0.3, 0, 0.07, 0, -0.3, 0,          // body
      0, 0, -0.25, 0, -0.18, 0, -0.62, 0, 0.18, 0, -0.62, 0,       // tail
    ];
    for (const sd of [-1, 1]) v.push(sd * 0.05, 0, 0.18, 1, sd * 1.0, 0.02, -0.05, 1, sd * 0.05, 0, -0.22, 1,   // wing
      sd * 1.0, 0.02, -0.05, 1, sd * 0.62, 0.01, -0.28, 1, sd * 0.05, 0, -0.22, 1);
    birdGeo.setAttribute('aBird', new THREE.Float32BufferAttribute(v, 4));
    birdGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(v.length / 4 * 3), 3));
    const N = 60;
    birdGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(N), 4));
    birdGeo.instanceCount = N;
    birdGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  const birds = new THREE.Mesh(birdGeo, new THREE.ShaderMaterial({ vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG, uniforms: { ...shared, uBox: { value: 420 } }, side: THREE.DoubleSide }));
  birds.frustumCulled = false;
  group.add(birds);

  // petals and leaves: one quad each
  const quads = (n, vert, extra) => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(n), 4));
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: FALL_FRAG, uniforms: { ...shared, ...extra }, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const treeSlots = Array.from({ length: 8 }, () => new THREE.Vector4());
  const petals = quads(900, PETAL_VERT, { uTrees: { value: treeSlots } });
  const leaves = quads(900, LEAF_VERT, { uBox: { value: 40 } });
  // the trees in blossom (trees.js variants of kind 'blossom'), nearest first every half second
  let blossoms = [], treesVersion = -1;
  let slotT = 0;
  const pickTrees = (cam) => {
    if (trees && trees.version !== treesVersion) { treesVersion = trees.version; blossoms = trees.trees.filter(t => trees.variants[t.v].kind === 'blossom'); }
    const near = blossoms.map(t => [t, (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2]).filter(e => e[1] < 90 * 90).sort((a, b) => a[1] - b[1]).slice(0, 8);
    for (let i = 0; i < 8; i++) {
      const e = near[i];
      if (!e) { treeSlots[i].set(0, -1e4, 0, 0); continue; }
      const t = e[0], v = trees.variants[t.v];
      treeSlots[i].set(t.x, t.y + v.geo.height * 0.62 * t.s, t.z, v.geo.crownR * 0.8 * t.s);
    }
  };

  let enabled = true, time = 0;
  const col = new THREE.Color();
  return {
    group, pollen, flies, wings, birds, petals, leaves, uniforms: shared,
    configure(q) {
      enabled = q.life !== false;
      group.visible = enabled;
    },
    // heightPx: the render target height (point sprites are sized in pixels)
    setViewport(heightPx) { shared.uHalfH.value = heightPx / 2; },
    update(dt, camera) {
      time += dt;
      if (!enabled) return;
      const u = shared;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      u.uSunDir.value.copy(env.sunDir);
      col.copy(env.sun.color).multiplyScalar(env.sun.intensity);
      u.uSunCol.value.set(col.r, col.g, col.b);
      const f = env.hemi.color;
      u.uFill.value.set(f.r, f.g, f.b);
      const d = env.darkness;
      u.uDay.value = 1 - THREE.MathUtils.smoothstep(d, 0.15, 0.5);
      u.uNight.value = THREE.MathUtils.smoothstep(d, 0.3, 0.7);
      pollen.visible = u.uDay.value > 0.001;
      wings.visible = u.uDay.value > 0.001;
      birds.visible = u.uDay.value > 0.001;
      if ((slotT -= dt) <= 0) { slotT = 0.5; pickTrees(camera.position); }
      petals.visible = u.uDay.value > 0.001 && treeSlots[0].w > 0;
      flies.visible = u.uNight.value > 0.001;
    },
  };
}
