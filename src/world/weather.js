import * as THREE from 'three';

// Weather: fair days and passing summer showers. One number drives it, the storm `s` (0 fair .. 1 raining under
// a full cloud deck). The environment reads it (environment.js apply): thicker, darker clouds, a grey sky and
// light, more haze. Rain falls once the deck is thick (`rain`); the ground gets wet and dries again (`wet`:
// darker ground, puddles on the tracks, rings on the water); when a shower clears with the sun out a rainbow
// stands opposite the sun (`bow`).
//   fair      always fine
//   changing  fair spells of 6-12 minutes, then a shower: the clouds gather (~1 min), rain (2-3 min), it clears
//   rain      steady rain
// The rain and its splashes are GPU particles round the camera, like the life in life.js.
export const WEATHER_MODES = ['fair', 'changing', 'rain'];

const GATHER = 70, CLEAR = 55;   // seconds for the deck to build up / break up

const GROUND_GLSL = /* glsl */`
uniform highp sampler2D tHeight;
uniform vec4 uMap;      // half, cell, NN, size
float wHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float wGround(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = wHgt(i), h10 = wHgt(i + ivec2(1, 0)), h01 = wHgt(i + ivec2(0, 1)), h11 = wHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
vec2 wWrap(vec2 seed, float B) { return mod(seed * B - uCam.xz + 0.5 * B, B) - 0.5 * B + uCam.xz; }
`;

// a streak per drop: a quad along the fall, turned to the camera, at least a pixel wide (thinner it would
// shimmer: it widens and fades instead)
const RAIN_VERT = /* glsl */`
uniform float uTime, uBox, uTop, uHalfH;
uniform vec3 uCam, uCar;
uniform vec2 uWind;
${GROUND_GLSL}
attribute vec4 aSeed;
attribute vec2 aCorner;   // x across (-1, 1), y tail (0) .. head (1)
varying float vA;
varying vec2 vC;
void main() {
  const float FALL = 9.0;   // m/s
  vec3 vel = vec3(uWind.x, -FALL, uWind.y);
  float tf = fract(aSeed.w + uTime * FALL / uTop) * uTop / FALL;   // seconds since it entered the column
  vec2 xz = wWrap(aSeed.xz, uBox);
  vec3 p = vec3(xz.x, uCam.y + uTop * 0.62, xz.y) + vel * tf;
  vec3 a = normalize(vel);
  float len = 0.45 + aSeed.y * 0.35;
  vec3 c = p - a * len * (1.0 - aCorner.y);
  vec3 rel = c - uCam;
  float dist = length(rel);
  vec3 side = normalize(cross(a, rel));
  float px = dist / (projectionMatrix[1][1] * uHalfH);
  float w = max(0.005, px * 0.8);
  c += side * aCorner.x * w;
  vA = min(1.0, 0.005 / w) * smoothstep(0.5 * uBox, 0.3 * uBox, length(rel.xz)) * smoothstep(1.0, 3.5, dist);
  // not under the ground, not inside the truck
  vA *= step(wGround(p.xz), p.y) * (1.0 - step(length(p.xz - uCar.xz), 2.7) * step(p.y, uCar.y + 2.3));
  vC = aCorner;
  gl_Position = projectionMatrix * viewMatrix * vec4(c, 1.0);
  if (vA < 0.003) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const RAIN_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uAmount;
varying float vA;
varying vec2 vC;
void main() {
  float a = vA * uAmount * (1.0 - vC.x * vC.x) * smoothstep(0.0, 0.5, vC.y) * 0.3;
  gl_FragColor = vec4(uCol * a, a);
}`;

// splashes: a ring that opens on the ground, each drop at a new place every cycle
const SPLASH_VERT = /* glsl */`
uniform float uTime, uBox, uHalfH;
uniform vec3 uCam, uCar;
${GROUND_GLSL}
attribute vec4 aSeed;
varying float vA;
varying float vT;
float h1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  const float LIFE = 0.32;
  float cyc = uTime / LIFE + aSeed.w * 17.0;
  float k = floor(cyc);
  vT = cyc - k;
  vec2 xz = wWrap(fract(aSeed.xz + vec2(h1(k * 1.7 + aSeed.x * 91.0), h1(k * 2.3 + aSeed.z * 57.0))), uBox);
  vec3 p = vec3(xz.x, wGround(xz) + 0.04, xz.y);
  vec3 rel = p - uCam;
  float dist = length(rel);
  vA = smoothstep(0.5 * uBox, 0.25 * uBox, length(rel.xz)) * smoothstep(0.8, 2.0, dist) * (1.0 - step(length(p.xz - uCar.xz), 2.4));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.5, (0.03 + 0.1 * vT) * projectionMatrix[1][1] * uHalfH / max(0.3, -mv.z));
  if (vA < 0.003) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const SPLASH_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uAmount;
varying float vA;
varying float vT;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  d.y *= 2.6;                     // lying on the ground: an ellipse
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float ring = smoothstep(0.35, 0.0, abs(r - mix(0.3, 0.9, vT)));
  float a = vA * uAmount * ring * (1.0 - vT) * 0.22;
  gl_FragColor = vec4(uCol * a, a);
}`;

function seeds(n, rnd) {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

export class Weather {
  constructor({ env, terrainView, water, dust }) {
    this.env = env;
    this.dust = dust;
    this.terrainView = terrainView;
    this.water = water;
    this.mode = 'changing';
    this.s = 0;          // the storm, 0 .. 1
    this.target = 0;
    this.rain = 0;       // rain falling, 0 .. 1
    this.wet = 0;        // the ground, 0 dry .. 1 soaked
    this.recent = 0;     // memory of rain (for the rainbow)
    this.bow = 0;
    this.phase = 'fair';
    this.phaseT = 240 + Math.random() * 240;   // the first shower comes after 4-8 minutes
    this.density = 1;
    this.time = 0;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    const TU = terrainView.uniforms;
    this.shared = {
      tHeight: TU.tHeight, uMap: TU.uMap,
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uCar: { value: new THREE.Vector3(0, -1e4, 0) },
      uWind: { value: new THREE.Vector2(1.6, 0.9) }, uHalfH: { value: 500 }, uCol: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uAmount: { value: 0 },
    };
    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.group.visible = false;

    // drops: a quad each
    this.maxDrops = 12000;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(this.maxDrops, rnd), 4));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const blend = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
    this.drops = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, side: THREE.DoubleSide, ...blend,
      uniforms: { ...this.shared, uBox: { value: 36 }, uTop: { value: 22 } },
    }));
    this.drops.frustumCulled = false; this.drops.renderOrder = 3;
    this.group.add(this.drops);

    this.maxSplash = 1800;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seeds(this.maxSplash, rnd), 4));
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxSplash * 3), 3));
    sg.setDrawRange(0, 0);
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.splashes = new THREE.Points(sg, new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, ...blend,
      uniforms: { ...this.shared, uBox: { value: 22 } },
    }));
    this.splashes.frustumCulled = false; this.splashes.renderOrder = 3;
    this.group.add(this.splashes);
    env.weather = this;
  }

  setMode(m) {
    if (!WEATHER_MODES.includes(m)) return;
    this.mode = m;
    if (m === 'fair') { this.phase = 'fair'; this.phaseT = 360 + Math.random() * 360; }
    if (m === 'changing' && this.phase !== 'fair') this.phase = this.s > 0.5 ? 'rain' : 'fair';
  }
  // quality: fewer drops on the light presets
  configure(q) { this.density = q.veg === 'off' || q.veg === 'low' ? 0.5 : 1; }
  // heightPx: the render target height (splashes are sized in pixels, drops at least a pixel wide)
  setViewport(heightPx) { this.shared.uHalfH.value = heightPx / 2; }
  // jump straight to a state (tests, screenshots): s 0..1, wet 0..1, bow 0..1
  set({ s = this.s, wet = this.wet, bow = this.bow, recent } = {}) {
    this.s = this.target = s; this.wet = wet; this.recent = recent ?? bow; this.bow = bow;
    this.rain = rainOf(s);
    this.phase = s > 0.5 ? 'rain' : 'fair';
    this.frozen = true;
    this.env.dirty = true;
  }

  schedule(dt) {
    if (this.mode === 'fair') { this.target = 0; return; }
    if (this.mode === 'rain') { this.target = 1; return; }
    this.phaseT -= dt;
    if (this.phaseT > 0) return;
    if (this.phase === 'fair') { this.phase = 'gather'; this.phaseT = GATHER; this.target = 1; }
    else if (this.phase === 'gather') { this.phase = 'rain'; this.phaseT = 110 + Math.random() * 80; }
    else if (this.phase === 'rain') { this.phase = 'clear'; this.phaseT = CLEAR; this.target = 0; }
    else { this.phase = 'fair'; this.phaseT = 360 + Math.random() * 360; }
  }

  update(dt, camera, focus) {
    this.time += dt;
    if (!this.frozen) {
      this.schedule(dt);
      const rate = dt / (this.target > this.s ? GATHER : CLEAR);
      this.s = this.target > this.s ? Math.min(this.target, this.s + rate) : Math.max(this.target, this.s - rate);
      this.rain = rainOf(this.s);
      // soaked after ~40 s of rain; dries in a few minutes (slower under cloud)
      this.wet = Math.min(1, Math.max(0, this.wet + dt * (this.rain / 40 - (1 - this.rain) * (1 - 0.7 * this.s) / 200)));
      this.recent = Math.max(this.recent - dt / 200, this.rain);
      this.bow = this.recent * (1 - this.rain) ** 2 * (1 - THREE.MathUtils.smoothstep(this.s, 0.35, 0.85));
    }
    const e = this.env;
    if (Math.abs(this.s - (e.appliedWeather?.s ?? -1)) > 0.004 || Math.abs(this.bow - (e.appliedWeather?.bow ?? -1)) > 0.004) e.dirty = true;

    this.terrainView.uniforms.uWet.value = this.wet * 0.85;
    if (this.dust) this.dust.wet = this.wet;
    if (this.water?.setRain) this.water.setRain(this.rain);

    const amount = this.rain;
    this.group.visible = amount > 0.002;
    if (!this.group.visible) return;
    const u = this.shared;
    u.uTime.value = this.time;
    u.uCam.value.copy(camera.position);
    if (focus) u.uCar.value.copy(focus); else u.uCar.value.set(0, -1e4, 0);
    u.uAmount.value = Math.min(1, amount * 1.6);
    // the drops are lit by the grey sky (and a little by the sun through the gaps)
    const amb = e.sky.uniforms.uCloudAmb.value;
    const sc = e.sun.color, si = e.sun.intensity * 0.04;
    u.uCol.value.set(amb.x * 0.9 + sc.r * si, amb.y * 0.9 + sc.g * si, amb.z * 0.9 + sc.b * si);
    this.drops.geometry.instanceCount = Math.round(this.maxDrops * this.density * Math.min(1, amount * 1.3));
    this.splashes.geometry.setDrawRange(0, Math.round(this.maxSplash * this.density * amount));
  }
}

const rainOf = s => THREE.MathUtils.smoothstep(s, 0.72, 0.96);
