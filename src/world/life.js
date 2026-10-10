import * as THREE from 'three';

// Life in the air, all on the GPU (fixed buffers, positions from the time and a seed per particle, wrapped
// round the camera, so nothing is uploaded per frame):
//   pollen   specks drifting on the wind, glowing when you look towards the sun (forward scattering), by day
//   seeds    a few dandelion tufts, bigger and slower, by day
//   flies    fireflies over grass and forest edges at dusk and night, each blinking on its own rhythm
//   wings    butterflies over the meadows by day: two wings flapping, a wandering path, a colour each
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
// a seed position wrapped into a box of side B round the camera (horizontal), drifting with d
vec3 lWrap(vec3 seed, float B, vec3 d) {
  vec2 xz = mod(seed.xz * B + d.xz - uCam.xz + 0.5 * B, B) - 0.5 * B + uCam.xz;
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
  float size = mix(0.05, 0.13, big);                        // m
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
  float home = 0.3 + 0.7 * smoothstep(0.1, 0.4, gd.a + gd.g * 0.8);   // most over meadows and in the forest
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
  c.xz += off;
  vec4 gd = lData(c.xz);
  float home = smoothstep(0.03, 0.2, gd.a) * (1.0 - smoothstep(0.5, 0.85, gd.g));   // meadows, not the forest
  float flapT = uTime * (9.0 + aSeed.z * 5.0) + ph;
  c.y = lGround(c.xz) + 1.35 + aSeed.y * 1.3 + sin(uTime * 1.3 + ph) * 0.3 + sin(flapT) * 0.03;   // over the tall grass
  vec3 rel = c - uCam;
  float fade = smoothstep(0.5 * uBox, 0.38 * uBox, length(rel.xz));
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

function seeds(n, rnd = Math.random) {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

export function buildLife(terrainView, env) {
  const TU = terrainView.uniforms;
  const group = new THREE.Group();
  group.name = 'life';
  const shared = {
    tHeight: TU.tHeight, tData: TU.tData, uMap: TU.uMap,
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
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false; p.renderOrder = 2;
    group.add(p);
    return p;
  };
  const pollen = points(900, POLLEN_VERT, 40, { uSeedK: { value: 0.04 } });
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
    const N = 70;
    wingGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(N), 4));
    wingGeo.instanceCount = N;
    wingGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  const wings = new THREE.Mesh(wingGeo, new THREE.ShaderMaterial({
    vertexShader: WING_VERT, fragmentShader: WING_FRAG, uniforms: { ...shared, uBox: { value: 56 } }, side: THREE.DoubleSide,
  }));
  wings.frustumCulled = false;
  group.add(wings);

  let enabled = true, time = 0;
  const col = new THREE.Color();
  return {
    group, pollen, flies, wings, uniforms: shared,
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
      flies.visible = u.uNight.value > 0.001;
    },
  };
}
