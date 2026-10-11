import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CLOUD_GLSL, cloudUniforms } from '../world/clouds.js';

// Volumetric fog: a haze lying in the low ground, lit by the sun (or the moon) through the sun's shadow map and
// the clouds' shadows, so trees, hills and the truck cast shafts of light into it and broken cloud throws long
// beams across the land. Raymarched per pixel at a fraction of the resolution (steps packed towards the camera,
// a jittered start), blended over the frames (history reprojected by the ray's end point) and laid over the
// scene in the composite with a depth-aware upsample: colour * transmittance + in-scattered light.
// It is the near and middle distance only (up to `maxDist`); the far aerial perspective stays analytic in every
// material's fog (shaderPatches.js).

const MARCH_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
precision highp sampler2DShadow;
${CLOUD_GLSL}
uniform sampler2D tDepth, tPrev;
uniform sampler3D tNoise;
uniform sampler2DShadow tShadow;
uniform mat4 uInvViewProj, uPrevViewProj, uShadowMat[2];
uniform vec4 uCascade[2];
uniform vec3 uCam, uFwd, uLightDir, uLightCol, uAmb;
uniform vec4 uDens;      // x density at the floor (1/m), y falloff with height (1/m), z floor height (m), w wisps 0..1
uniform vec4 uPhase;     // x forward lobe g, y its share, z back lobe g
uniform vec2 uWind;
uniform float uFrame, uBlend, uSteps, uMaxDist, uShadowOn, uNear, uFar;
varying vec2 vUv;
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
float density(vec3 p) {
  float d = uDens.x * exp(-max(p.y - uDens.z, 0.0) * uDens.y);
  if (uDens.w > 0.0) {
    float n = texture(tNoise, (p + vec3(uWind.x, 0.0, uWind.y)) / vec3(60.0, 30.0, 60.0)).r;
    d *= mix(1.0, n * 2.2, uDens.w);
  }
  return d;
}
float sunVis(vec3 p, float vz) {
  float v = 1.0;
  if (uShadowOn > 0.5) {
    for (int i = 1; i >= 0; i--) {
      if (vz >= uCascade[i].x && vz < uCascade[i].y) {
        vec4 c = uShadowMat[i] * vec4(p, 1.0);
        c.xyz /= c.w;
        if (c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0 && c.z < 1.0) v = texture(tShadow, vec3(c.xy, c.z - 0.0004));
        // the last cascade's far end fades to lit, so the shafts don't stop at a line
        if (i == 1 || uCascade[1].y < uCascade[1].x) v = mix(v, 1.0, smoothstep(uCascade[i].y * 0.8, uCascade[i].y, vz));
        break;
      }
    }
  }
  return v;
}
float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  float dz = texture2D(tDepth, vUv).r;
  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCam);
  // distance to the scene along the ray (the sky: as far as the fog reaches)
  float tEnd = dz >= 0.99999 ? uMaxDist : min(linZ(dz) / max(dot(dir, uFwd), 1e-3), uMaxDist);
  float mu = dot(dir, uLightDir);
  float phase = mix(hg(mu, uPhase.z), hg(mu, uPhase.x), uPhase.y);
  // a white-noise offset per pixel walking the golden ratio over the frames (the blend averages it evenly)
  float jit = fract(fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) + uFrame * 0.6180340);
  // the clouds' shadow changes over kilometres: taken at two points of the ray and interpolated
  float cs0 = cloudShadow(uCam + dir * min(tEnd, 20.0)), cs1 = cloudShadow(uCam + dir * tEnd);
  vec3 S = vec3(0.0); float T = 1.0;
  float prev = 0.0;
  for (int i = 0; i < 48; i++) {
    if (float(i) >= uSteps) break;
    // steps packed towards the camera (the shadows that matter are near)
    float f = (float(i) + jit) / uSteps, t = tEnd * f * f;
    float dt = t - prev; prev = t;
    vec3 p = uCam + dir * t;
    float sig = density(p);
    if (sig < 1e-6) continue;
    vec3 Li = uLightCol * (sunVis(p, t * dot(dir, uFwd)) * mix(cs0, cs1, f * f) * phase) + uAmb;
    float ext = exp(-sig * dt);
    S += T * Li * (1.0 - ext);   // energy-conserving step (Hillaire): the light scattered in over dt, attenuated
    T *= ext;
  }
  // the last segment up to the end, without a new shadow sample
  {
    vec3 p = uCam + dir * tEnd;
    float sig = density(p), dt = tEnd - prev;
    float ext = exp(-sig * dt);
    S += T * (uLightCol * cs1 * phase + uAmb) * (1.0 - ext);
    T *= ext;
  }
  vec4 res = vec4(S, T);
  // temporal blend with the last frames at the same point (the ray's end); a changed path length (another
  // transmittance) takes more of the new frame
  vec4 pp = uPrevViewProj * vec4(uCam + dir * tEnd, 1.0);
  vec2 puv = pp.xy / pp.w * 0.5 + 0.5;
  if (uBlend < 1.0 && pp.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
    vec4 h = texture2D(tPrev, puv);
    float a = mix(uBlend, 0.7, smoothstep(0.04, 0.2, abs(h.a - res.a)));
    res = mix(h, res, a);
  }
  gl_FragColor = res;
}`;

// the upsample, for the composite: weights the four nearest fog texels by how close the depth each one marched to
// is to this pixel's depth (no fog halo round the trees)
export const FOG_APPLY_GLSL = /* glsl */`
uniform sampler2D tFog;
uniform vec2 uFogSize, uNearFar;
uniform float uFogOn;
float fogLinZ(float d) { return uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x)); }
vec4 fogAt(vec2 uv, sampler2D depth) {
  vec2 q = uv * uFogSize - 0.5, f = fract(q), b = (floor(q) + 0.5) / uFogSize;
  float z0 = fogLinZ(texture2D(depth, uv).r);
  vec4 sum = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec2 u = b + o / uFogSize;
    float zq = fogLinZ(texture2D(depth, u).r);
    float w = (o.x > 0.0 ? f.x : 1.0 - f.x) * (o.y > 0.0 ? f.y : 1.0 - f.y) * exp(-abs(z0 - zq) / (0.05 * z0 + 0.3)) + 1e-5;
    sum += texture2D(tFog, u) * w; ws += w;
  }
  return sum / ws;
}`;

export class VolumetricFog {
  constructor(renderer, noise3D) {
    this.renderer = renderer;
    this.enabled = false;
    this.scale = 0.25;
    this.steps = 24;
    this.sun = null;          // the cascaded-shadow sun light (environment.js)
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.rts = [new THREE.WebGLRenderTarget(1, 1, opt), new THREE.WebGLRenderTarget(1, 1, opt)];
    this.idx = 0; this.frame = 0; this.reset = true;
    this.width = 1; this.height = 1;
    this.prevViewProj = new THREE.Matrix4();
    this.wind = new THREE.Vector2();
    // the medium and its light (environment.js writes them per look): density, falloff, floor, wisps
    this.params = {
      density: 0, falloff: 0.02, floor: 0, wisps: 0.5, maxDist: 320,
      g: 0.62, forward: 0.6, back: -0.2,
      lightDir: new THREE.Vector3(0, 1, 0), lightCol: new THREE.Vector3(), amb: new THREE.Vector3(),
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        ...cloudUniforms(),
        tDepth: { value: null }, tPrev: { value: null }, tNoise: { value: noise3D }, tShadow: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
        uShadowMat: { value: [new THREE.Matrix4(), new THREE.Matrix4()] }, uCascade: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        uCam: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
        uLightDir: { value: new THREE.Vector3() }, uLightCol: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
        uDens: { value: new THREE.Vector4() }, uPhase: { value: new THREE.Vector4() }, uWind: { value: new THREE.Vector2() },
        uFrame: { value: 0 }, uBlend: { value: 1 }, uSteps: { value: 24 }, uMaxDist: { value: 320 }, uShadowOn: { value: 0 },
        uNear: { value: 0.1 }, uFar: { value: 6000 },
      },
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  get texture() { return this.rts[this.idx].texture; }
  get active() { return this.enabled && this.params.density > 1e-6; }
  setSize(w, h) {
    const fw = Math.max(1, Math.round(w * this.scale)), fh = Math.max(1, Math.round(h * this.scale));
    if (fw === this.width && fh === this.height) return;
    this.width = fw; this.height = fh;
    for (const rt of this.rts) rt.setSize(fw, fh);
    this.reset = true;
  }
  update(dt, windX, windZ) { this.wind.x += windX * dt; this.wind.y += windZ * dt; }
  render(camera, depthTexture) {
    const u = this.mat.uniforms, r = this.renderer, P = this.params;
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uInvViewProj.value.copy(_vp).invert();
    u.uPrevViewProj.value.copy(this.reset ? _vp : this.prevViewProj);
    u.uCam.value.copy(camera.position);
    camera.getWorldDirection(u.uFwd.value);
    u.uNear.value = camera.near; u.uFar.value = camera.far;
    u.tDepth.value = depthTexture;
    // the sun's world cascades (render/cascadeShadow.js)
    const sh = this.sun?.shadow, shadowOn = !!(this.sun?.castShadow && sh?.map && sh._cascadeData);
    u.uShadowOn.value = shadowOn ? 1 : 0;
    u.tShadow.value = shadowOn ? sh.map.depthTexture : null;
    if (shadowOn) for (let i = 0; i < 2; i++) { u.uShadowMat.value[i].copy(sh._matrices[i]); u.uCascade.value[i].copy(sh._cascadeData[i]); }
    u.uLightDir.value.copy(P.lightDir); u.uLightCol.value.copy(P.lightCol); u.uAmb.value.copy(P.amb);
    u.uDens.value.set(P.density, P.falloff, P.floor, P.wisps);
    u.uPhase.value.set(P.g, P.forward, P.back, 0);
    u.uWind.value.copy(this.wind);
    u.uMaxDist.value = P.maxDist;
    u.uSteps.value = this.steps;
    u.uFrame.value = this.frame++ % 1024;
    u.uBlend.value = this.reset ? 1 : 0.12;
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
