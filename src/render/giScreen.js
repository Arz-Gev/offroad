import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SKYLINE_GLSL } from './skyline.js';
import { giVolumeGLSL } from './giWorld.js';

// The indirect light per pixel. After a frame is drawn, every pixel's place in the world is known (its depth):
// - the light arriving there from the world at large comes from the probes (giWorld.js), as the same values a
//   probe has (A, Y, X);
// - what is close by is traced on the screen itself: from each pixel a few slices of the hemisphere over its surface
//   are walked through the depth buffer; where something on screen stands in a direction, the light the probes
//   said comes from there is taken out and the light that thing sends (its colour in the frame just drawn) is put
//   in. That is the dark under and beside things, and the colour one thing throws on the next. Each slice keeps a
//   mask of 32 sectors (after Therrien et al., "Screen Space Indirect Lighting with Visibility Bitmask"), so a thin
//   thing blocks only its own sectors; samples next to each other on one surface are joined, so a wall is solid.
// - the truck's floor: the ground under a truck is hidden from the screen's tracing by the truck itself, so the sky
//   its floor takes from what lies below it is worked out: the floor as a rectangle over the point (setCars).
// The result is noisy (two slices a pixel a frame, turned every frame): it is blended over the frames at the place
// each pixel was the frame before.
// The next frame's materials read it back at the place each of their pixels was a frame ago (gi.js) and light
// themselves by it with their own normal and colour.
// At a fraction of the frame's size (the level's `height`, at most half). The values sit side by side in one texture (the atlas, 3 parts across: A and the view depth |
// Y and the open sky's share | X): one sampler in every material.

const CARS = 2;
const _m = new THREE.Matrix4();

const VERT = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The frame as the tracing reads it: half size, the colour and the view depth in one texel, smaller copies in the
// mip levels for the samples far from the pixel (one small texture instead of two full-size ones read all over)
const PRE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tDepth, tScene;
uniform vec2 uNearFar, uScale;   // uScale: the frame's texels per texel of this pass
void main() {
  ivec2 q = min(ivec2(gl_FragCoord.xy * uScale), textureSize(tDepth, 0) - 1);
  float d = texelFetch(tDepth, q, 0).r;
  float z = d >= 0.999999 ? 1e5 : uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
  gl_FragColor = vec4(min(texelFetch(tScene, q, 0).rgb, vec3(4.0)), z);
}`;

const GATHER_FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D tPre;         // the frame at this pass's size: rgb colour, a view depth
uniform mat3 uCamRot;
uniform vec3 uCam;
uniform vec2 uRes, uFull, uTan, uScale;  // this pass's size; the frame's; the tangents of half the field of view; the frame's texels per texel of this pass
uniform float uProjScale, uRadius, uMaxPx, uFrame, uThick;
uniform mat4 uCarM[CARS];      // world to each truck's own frame
uniform vec4 uCarBox[CARS];    // its floor: half width, half length, height in its frame; w 1: there is one
${SKYLINE_GLSL}
${giVolumeGLSL()}
const float PI = 3.14159265, HPI = 1.57079633;
// how many bits are set (GLSL ES 3.0 has no bitCount)
uint popc(uint v) { v = v - ((v >> 1) & 0x55555555u); v = (v & 0x33333333u) + ((v >> 2) & 0x33333333u); return (((v + (v >> 4)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24; }
// acos within 1e-4 (Abramowitz and Stegun 4.4.45)
float facos(float x) { float a = abs(x), r = sqrt(1.0 - a) * (1.5707963 + a * (-0.2146018 + a * (0.0865667 - 0.0310296 * a))); return x < 0.0 ? PI - r : r; }
// The share of the light from above (on level ground) that a rectangle parallel to the ground takes, a corner of it
// straight over the point: sides a and b, h above
float overCorner(float a, float b, float h) {
  float sa = sqrt(a * a + h * h), sb = sqrt(b * b + h * h);
  return sign(a) * sign(b) * (abs(a) / sa * atan(abs(b) / sa) + abs(b) / sb * atan(abs(a) / sb)) * (0.5 / PI);
}
// the same for the trucks' floors over the world point p
float underFloor(vec3 p) {
  float F = 0.0;
  for (int i = 0; i < CARS; i++) {
    vec4 bx = uCarBox[i];
    if (bx.w < 0.5) continue;
    vec3 q = (uCarM[i] * vec4(p, 1.0)).xyz;
    float h = bx.z - q.y;
    if (h < 0.03 || max(abs(q.x) - bx.x, abs(q.z) - bx.y) > 4.0 * h + 0.5) continue;
    float x0 = -bx.x - q.x, x1 = bx.x - q.x, z0 = -bx.y - q.z, z1 = bx.y - q.z;
    F += overCorner(x1, z1, h) - overCorner(x0, z1, h) - overCorner(x1, z0, h) + overCorner(x0, z0, h);
  }
  return clamp(F, 0.0, 1.0);
}
// the view position of this pass's pixel ip (its depth is that of one texel of the frame: unprojected there)
vec2 uvAt(ivec2 ip) { return (floor((vec2(ip) + 0.5) * uScale) + 0.5) / uFull; }
vec3 posAt(ivec2 ip) {
  ip = clamp(ip, ivec2(0), ivec2(uRes) - 1);
  return vec3((uvAt(ip) * 2.0 - 1.0) * uTan, -1.0) * texelFetch(tPre, ip, 0).a;
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 uv = uvAt(ip);
  vec3 P = posAt(ip);
  float z = -P.z;
  if (z > 5500.0) { o0 = vec4(uGIFallA, 1e5); o1 = vec4(uGIFallY, 1.0); o2 = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // the surface's normal from the depth around (the side with the smaller step across an edge)
  vec2 tx = 1.0 / uRes;
  vec3 pr = posAt(ip + ivec2(1, 0)), pl = posAt(ip - ivec2(1, 0)), pu = posAt(ip + ivec2(0, 1)), pd = posAt(ip - ivec2(0, 1));
  bool ex = abs(pr.z + pl.z - 2.0 * P.z) > 0.02 * z, ey = abs(pu.z + pd.z - 2.0 * P.z) > 0.02 * z;
  vec3 dx = ex ? (abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl) : (pr - pl) * 0.5;
  vec3 dy = ey ? (abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd) : (pu - pd) * 0.5;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  vec3 V = normalize(-P);
  // ---- the light from the world at large
  vec3 Nw = uCamRot * N, Pw = uCam + uCamRot * P + Nw * 0.1;
  vec3 Aw; vec4 Yw; vec2 Xw;
  giVolume(Pw, max(Pw.y - giGround(Pw.xz, 0.0), 0.0), Aw, Yw, Xw);
  // ---- what is close by, on the screen: light taken out (R) and put in (B)
  vec3 RA = vec3(0.0), RY = vec3(0.0), BA = vec3(0.0), BY = vec3(0.0); vec2 RX = vec2(0.0), BX = vec2(0.0);
  float rpx = min(uRadius * uProjScale / z, uMaxPx);
  if (rpx > 2.5) {
    // interleaved gradient noise, moved every frame
    vec2 fc = gl_FragCoord.xy + 5.588238 * mod(uFrame, 64.0);
    float n1 = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715)))), n2 = fract(n1 * 7.0 + 0.618034 * mod(uFrame, 16.0));
    for (int s = 0; s < SLICES; s++) {
      float phi = (float(s) + n1) * (PI / float(SLICES));
      vec2 dss = vec2(cos(phi), sin(phi));
      vec3 dv = vec3(dss, 0.0);
      vec3 ortho = dv - dot(dv, V) * V, axis = normalize(cross(dv, V));
      vec3 pn = N - axis * dot(N, axis);
      // the angle of the normal from the view direction, within the slice; the sectors span a half turn round it
      float gamma = sign(dot(ortho, pn)) * facos(clamp(dot(pn, V) / max(length(pn), 1e-4), -1.0, 1.0));
      uint occ = 0u;
      for (int side = 0; side < 2; side++) {
        float sd = side == 0 ? 1.0 : -1.0;
        float tPrev = gamma + sd * HPI;      // the surface itself: its tangent
        vec3 Sprev = P; float rPrev = 0.0;
        for (int k = 0; k < STEPS; k++) {
          float t = (float(k) + n2) / float(STEPS), r = t * t * rpx + 1.5;
          vec2 suv = uv + sd * dss * r * tx;
          if (suv.x <= 0.0 || suv.y <= 0.0 || suv.x >= 1.0 || suv.y >= 1.0) break;
          // (far from the pixel: a smaller copy of the frame)
          vec4 sc = textureLod(tPre, suv, clamp(log2(r) - 3.0, 0.0, 3.0));
          vec3 S = vec3((suv * 2.0 - 1.0) * uTan, -1.0) * sc.a;
          if (sc.a > 5500.0) { Sprev = S; rPrev = r; tPrev = 1e9; continue; }
          vec3 dl = S - P;
          float dist = length(dl);
          vec3 df = dl / max(dist, 1e-4);
          float tf = sd * facos(clamp(dot(df, V), -1.0, 1.0));
          // as thick as uThick, away from the camera
          float tb = sd * facos(clamp(dot(normalize(dl - V * uThick), V), -1.0, 1.0));
          float lo = min(tf, tb), hi = max(tf, tb);
          // the same surface as the sample before (as far apart as the step between them, give or take its slope):
          // solid in between
          bool joined = tPrev < 1e8 && distance(S, Sprev) < 3.0 * (r - rPrev) * (-S.z) / uProjScale + 0.06;
          if (joined) { lo = min(lo, tPrev); hi = max(hi, tPrev); }
          Sprev = S; rPrev = r; tPrev = tf;
          float fade = clamp(2.0 - 2.0 * dist / uRadius, 0.0, 1.0);
          if (fade <= 0.0) continue;
          float u0 = clamp((lo - gamma + HPI) / PI, 0.0, 1.0), u1 = clamp((hi - gamma + HPI) / PI, 0.0, 1.0);
          uint a = uint(u0 * 32.0 + 0.5), b = uint(u1 * 32.0 + 0.5);
          if (b <= a) continue;
          uint m = (b - a >= 32u ? 0xffffffffu : ((1u << (b - a)) - 1u)) << a;
          uint nw = m & ~occ;
          if (nw == 0u) continue;
          occ |= m;
          // the new sectors: their share of the sphere (a slice is a wedge: wider away from the view direction)
          float thm = gamma - HPI + float(a + b) * (0.5 * PI / 32.0);
          float W = float(popc(nw)) * abs(sin(thm)) * (PI / 32.0) * (PI / float(SLICES)) * fade / (4.0 * PI);
          vec3 w = uCamRot * df;
          vec3 Lw = giRadiance(Aw, Yw.rgb, Xw, w), Ls = sc.rgb;
          RA += Lw * W; RY += Lw * (3.0 * W * w.y); RX += giLum(Lw) * 3.0 * W * w.xz;
          BA += Ls * W; BY += Ls * (3.0 * W * w.y); BX += giLum(Ls) * 3.0 * W * w.xz;
        }
      }
    }
  }
  // ---- under a truck's floor: the light from above it takes (as much as its share of the sphere, straight up)
  float uf = underFloor(Pw);
  if (uf > 0.002) { vec3 Lu = giRadiance(Aw, Yw.rgb, Xw, vec3(0.0, 1.0, 0.0)) * uf; RA += Lu * 0.3333333; RY += Lu; }
  // (never more taken out than was there)
  float kr = min(1.0, 0.97 * giLum(Aw) / max(giLum(RA), 1e-6));
  vec3 A = max(Aw - RA * kr, vec3(0.0)) + BA;
  o0 = vec4(A, z);
  o1 = vec4(Yw.rgb - RY * kr + BY, Yw.a * (1.0 - kr * giLum(RA) / max(giLum(Aw), 1e-6)));
  o2 = vec4(Xw - RX * kr + BX, 0.0, 1.0);
}`;

// The frame's light, smoothed over its neighbours on the same surface, then blended into the light kept so far.
// The kept light is taken where the pixel's point was the frame before; or, for what moves with the camera (the
// truck), at the same place on the screen; and held to the range of the new light round the pixel, so the dark
// beside something that has moved on does not linger. Written as the atlas's three parts
const BLEND_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tRaw0, tRaw1, tRaw2, tHist;
uniform mat4 uProjInv, uPrevVP;
uniform mat3 uCamRot;
uniform vec3 uCam;
uniform vec2 uRes;
uniform float uBlend;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 fc = gl_FragCoord.xy;
  float part = floor(fc.x / uRes.x);
  fc.x -= part * uRes.x;
  ivec2 ip = ivec2(fc), lim = ivec2(uRes) - 1;
  float z = texelFetch(tRaw0, ip, 0).a;
  if (z > 9e4) { gl_FragColor = part < 0.5 ? texelFetch(tRaw0, ip, 0) : part < 1.5 ? texelFetch(tRaw1, ip, 0) : texelFetch(tRaw2, ip, 0); return; }
  // the neighbours at this pixel's depth
  vec4 sum = vec4(0.0); float ws = 0.0, lmin = 1e9, lmax = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = clamp(ip + ivec2(i, j), ivec2(0), lim);
    vec4 a = texelFetch(tRaw0, q, 0);
    float w = max(0.0, 1.0 - abs(a.a - z) / (0.03 * z + 0.03));
    if (w <= 0.0) continue;
    float l = lum(a.rgb);
    lmin = min(lmin, l); lmax = max(lmax, l);
    sum += (part < 0.5 ? a : part < 1.5 ? texelFetch(tRaw1, q, 0) : texelFetch(tRaw2, q, 0)) * w; ws += w;
  }
  vec4 cur = sum / ws;
  if (part < 0.5) cur.a = z;
  if (uBlend < 1.0) {
    vec2 uv = fc / uRes;
    vec4 pv = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec3 ray = pv.xyz / pv.w;
    vec4 pc = uPrevVP * vec4(uCam + uCamRot * (ray * (z / -ray.z)), 1.0);
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    float hx = -1.0, hy = 0.0;
    vec4 hA;
    if (pc.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) {
      float x = clamp(puv.x, 0.5 / uRes.x, 1.0 - 0.5 / uRes.x) / 3.0;
      hA = texture2D(tHist, vec2(x, puv.y));
      // the same surface as then (its depth from that camera)
      if (abs(hA.a - pc.w) < 0.08 * pc.w + 0.05) { hx = x; hy = puv.y; }
    }
    if (hx < 0.0) {
      float x = clamp(uv.x, 0.5 / uRes.x, 1.0 - 0.5 / uRes.x) / 3.0;
      hA = texture2D(tHist, vec2(x, uv.y));
      if (abs(hA.a - z) < 0.04 * z + 0.03) { hx = x; hy = uv.y; }
    }
    if (hx >= 0.0) {
      float hl = lum(hA.rgb), k = clamp(hl, 0.7 * lmin, 1.4 * lmax) / max(hl, 1e-6);
      vec4 h = part < 0.5 ? hA : texture2D(tHist, vec2(hx + part / 3.0, hy));
      cur = part < 0.5 ? vec4(mix(h.rgb * k, cur.rgb, uBlend), z) : part < 1.5 ? vec4(mix(h.rgb * k, cur.rgb, uBlend), mix(h.a, cur.a, uBlend)) : mix(h * k, cur, uBlend);
    }
  }
  gl_FragColor = cur;
}`;

export class ScreenGI {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.width = 1; this.height = 1;      // the frame's size
    this.w = 1; this.h = 1;               // this pass's: `rows` high, at most half the frame
    this.rows = 540;
    this.slices = 2; this.steps = 4;
    this.radius = 4;                      // how far the screen's own tracing reaches (m)
    this.thick = 0.3;                     // how thick things on screen are taken to be (m): leaves and blades are thin,
                                          // and what is solid is joined up sample to sample anyway
    this.blend = 0.2;                     // the share of the new frame in the kept light
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false };
    this.pre = new THREE.WebGLRenderTarget(1, 1, { ...hf, minFilter: THREE.NearestMipmapNearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: true });
    this.preMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: PRE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDepth: { value: null }, tScene: { value: null }, uNearFar: { value: new THREE.Vector2(0.1, 6000) }, uScale: { value: new THREE.Vector2(2, 2) } },
    });
    this.preQuad = new FullScreenQuad(this.preMat);
    this.raw = new THREE.WebGLRenderTarget(1, 1, { ...hf, count: 3, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.atlases = [0, 1].map(() => new THREE.WebGLRenderTarget(3, 1, { ...hf, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    this.cur = 0;
    this.ready = false;                       // the atlas holds a frame
    this.cut = true;                          // nothing to blend with (the first frame, a jump of the camera)
    this.frame = 0;
    this.viewProj = new THREE.Matrix4();      // the camera of the frame the atlas was made from
    this.cars = [];
    this.gatherMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: GATHER_FRAG, depthTest: false, depthWrite: false,
      defines: { SLICES: this.slices, STEPS: this.steps, CARS },
      uniforms: {
        ...world.uniforms, tPre: { value: this.pre.texture }, uProjInv: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
        uCam: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2(1, 1) }, uFull: { value: new THREE.Vector2(1, 1) }, uTan: { value: new THREE.Vector2(1, 1) }, uScale: this.preMat.uniforms.uScale,
        uProjScale: { value: 1 }, uRadius: { value: 4 }, uMaxPx: { value: 100 }, uFrame: { value: 0 }, uThick: { value: 0.3 },
        uCarM: { value: Array.from({ length: CARS }, () => new THREE.Matrix4()) }, uCarBox: { value: Array.from({ length: CARS }, () => new THREE.Vector4()) },
      },
    });
    const g = this.gatherMat.uniforms;
    this.blendMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLEND_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tRaw0: { value: this.raw.textures[0] }, tRaw1: { value: this.raw.textures[1] }, tRaw2: { value: this.raw.textures[2] }, tHist: { value: null },
        uProjInv: g.uProjInv, uCamRot: g.uCamRot, uCam: g.uCam, uRes: g.uRes, uPrevVP: { value: new THREE.Matrix4() }, uBlend: { value: 1 },
      },
    });
    this.quad = new FullScreenQuad(this.gatherMat);
    this.blendQuad = new FullScreenQuad(this.blendMat);
  }

  get atlas() { return this.atlases[this.cur]; }

  // the trucks whose floors shade the ground (up to CARS): [{ root: its Object3D, c, half: its box in the root's
  // frame, clear: the floor's height above the box's bottom }]
  setCars(list) { this.cars = list; }

  // q: a GI level (render/quality.js): { height, slices, steps }
  configure(q) {
    if (q.height !== this.rows) { this.rows = q.height; const w = this.width, h = this.height; this.width = 0; this.setSize(w, h); }
    if (q.slices !== this.slices || q.steps !== this.steps) {
      this.slices = q.slices; this.steps = q.steps;
      this.gatherMat.defines.SLICES = q.slices; this.gatherMat.defines.STEPS = q.steps;
      this.gatherMat.needsUpdate = true;
    }
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.h = Math.max(1, Math.min(Math.ceil(h / 2), this.rows)); this.w = Math.max(1, Math.round(w * this.h / h));
    this.raw.setSize(this.w, this.h); this.pre.setSize(this.w, this.h);
    for (const a of this.atlases) a.setSize(3 * this.w, this.h);
    this.ready = false; this.cut = true;
  }

  // after the scene is drawn: its colour and depth. Leaves its own render target set
  render(camera, scene, depth) {
    const r = this.renderer, u = this.gatherMat.uniforms, b = this.blendMat.uniforms;
    const pu = this.preMat.uniforms;
    pu.tDepth.value = depth; pu.tScene.value = scene; pu.uNearFar.value.set(camera.near, camera.far);
    pu.uScale.value.set(this.width / this.w, this.height / this.h);
    r.setRenderTarget(this.pre);
    this.preQuad.render(r);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uTan.value.set(1 / camera.projectionMatrix.elements[0], 1 / camera.projectionMatrix.elements[5]);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    u.uCam.value.copy(camera.position);
    u.uRes.value.set(this.w, this.h);
    u.uFull.value.set(this.width, this.height);
    u.uProjScale.value = camera.projectionMatrix.elements[5] * 0.5 * this.h;   // pixels of this pass a metre covers at 1 m
    u.uRadius.value = this.radius; u.uThick.value = this.thick; u.uMaxPx.value = this.h * 0.22;
    u.uFrame.value = this.frame++ % 1024;
    for (let i = 0; i < CARS; i++) {
      const c = this.cars[i], bx = u.uCarBox.value[i];
      if (!c || !c.root.visible) { bx.w = 0; continue; }
      u.uCarM.value[i].copy(c.root.matrixWorld).invert();
      // (the box's centre is not the frame's origin: folded into the matrix)
      _m.makeTranslation(-c.c.x, 0, -c.c.z); u.uCarM.value[i].premultiply(_m);
      bx.set(c.half.x * 0.92, c.half.z * 0.94, c.c.y - c.half.y + c.clear, 1);
    }
    r.setRenderTarget(this.raw);
    this.quad.render(r);
    const hist = this.atlases[this.cur], out = this.atlases[1 - this.cur];
    b.tHist.value = hist.texture;
    b.uPrevVP.value.copy(this.viewProj);
    b.uBlend.value = this.cut || !this.ready ? 1 : this.blend;
    r.setRenderTarget(out);   // (left set, as giWorld.js update leaves its own)
    this.blendQuad.render(r);
    this.cur = 1 - this.cur;
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.ready = true; this.cut = false;
  }
}
