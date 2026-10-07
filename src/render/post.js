import * as THREE from 'three/webgpu';
import {
  Fn, If, pass, mrt, output, uniform, texture, vec2, vec3, vec4, float, uv, screenUV, screenCoordinate, max, min, mix, clamp,
  dot, exp, exp2, log2, pow, fract, sin, smoothstep, step, select, length, normalize, sub, abs, Loop, int, textureLevel,
  ivec2, rtt, perspectiveDepthToViewZ,
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';

// HDR post pipeline (three's RenderPipeline, every pass a TSL node):
//   scene -> half-float target (optional MSAA) + depth
//   -> optional ambient occlusion (GTAO, half resolution, normals from depth)
//   -> sun shafts: the sky seen past the trees and hills, smeared towards the sun on screen (light through
//      the leaves; only while the sun is in or near the view)
//   -> bloom (mip chain, threshold after exposure)
//   -> composite: exposure, AO, bloom, shafts, grade (tint, lift, saturation), Neutral tone mapping,
//      S-curve, vignette, sRGB, dither
//   -> optional FXAA / SMAA (on the sRGB picture).
// Eye adaptation runs after the frame on the scene colour it just made (log-average luminance on the GPU,
// ping-pong 1x1 targets), so the composite of the next frame reads it: one frame of lag, invisible at
// adaptation speeds.

const neutral = Fn(([color]) => {
  const StartCompression = 0.8 - 0.04, Desaturation = 0.15;
  const c = color.toVar();
  const x = min(c.r, min(c.g, c.b));
  const offset = select(x.lessThan(0.08), x.sub(x.mul(x).mul(6.25)), float(0.04));
  c.subAssign(offset);
  const peak = max(c.r, max(c.g, c.b)).toVar();
  const out = c.toVar();
  If(peak.greaterThanEqual(StartCompression), () => {
    const d = 1 - StartCompression;
    const newPeak = float(1).sub(float(d * d).div(peak.add(d - StartCompression)));
    const cc = c.mul(newPeak.div(peak));
    const g = float(1).sub(float(1).div(float(Desaturation).mul(peak.sub(newPeak)).add(1)));
    out.assign(mix(cc, vec3(newPeak), g));
  });
  return out;
});

const toSRGB = Fn(([c0]) => {
  const c = clamp(c0, 0.0, 1.0);
  return mix(c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055), step(0.0031308, c));
});

const hash = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

export class RenderPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.msaa = 0;
    this.aa = 'off';              // 'off' | 'fxaa' | 'smaa'
    this.ssao = 'off';            // 'off' | 'low' | 'high'
    this.shafts = true;
    this.params = {
      bloom: true, bloomStrength: 0.06, bloomThreshold: 1.6, bloomKnee: 0.6, bloomRadius: 1.0,
      exposure: 0.72, autoExposure: false, auto: 1, key: 0.18, minExposure: 0.72, maxExposure: 0.72, adaptRate: 1.5, exposureBias: 0,
      vignette: 0.25, saturation: 1.0, contrast: 0.12, tint: new THREE.Color(1, 1, 1), lift: new THREE.Color(0, 0, 0),
      shafts: 0.5,
    };
    this.time = 0;
    this.resetExposure = true;
    this.width = 1; this.height = 1;

    // uniforms shared by the graph (rebuilt on configure) and the frame loop
    this.u = {
      bloom: uniform(0.05), bloomOn: uniform(1), vignette: uniform(0.25), sat: uniform(1), contrast: uniform(0.1), time: uniform(0),
      tint: uniform(new THREE.Color(1, 1, 1)), lift: uniform(new THREE.Color(0, 0, 0)), aoOn: uniform(0),
      sunUV: uniform(new THREE.Vector2(0.5, 0.5)), sunVis: uniform(0), sunCol: uniform(new THREE.Color(1, 0.9, 0.7)), shafts: uniform(0.5),
    };

    // ---- eye adaptation: 128x128 log-luminance (mipmapped) and two 1x1 exposure targets
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.lum = new THREE.RenderTarget(128, 128, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    this.adapt = [0, 1].map(() => new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }));
    this.adaptIdx = 0;
    this.expTex = texture(this.adapt[0].texture);       // what the composite reads (swapped every frame)
    this.lumSrc = texture(new THREE.Texture());          // the scene colour of the frame just rendered
    this.prevTex = texture(this.adapt[1].texture);
    this.au = { key: uniform(0.18), min: uniform(1), max: uniform(1), rate: uniform(0.05), reset: uniform(1), bias: uniform(0), exp: uniform(1), auto: uniform(0) };
    const lumMat = new THREE.NodeMaterial();
    lumMat.fragmentNode = Fn(() => {
      const t = vec2(1 / 128);
      const s = this.lumSrc;
      const c = s.sample(uv().add(t.mul(vec2(-0.25, -0.25)))).rgb.add(s.sample(uv().add(t.mul(vec2(0.25, -0.25)))).rgb)
        .add(s.sample(uv().add(t.mul(vec2(-0.25, 0.25)))).rgb).add(s.sample(uv().add(t.mul(vec2(0.25, 0.25)))).rgb);
      const l = dot(c.mul(0.25), vec3(0.2126, 0.7152, 0.0722));
      const d = uv().sub(0.5).mul(vec2(1.6, 2.0));
      const w = exp(dot(d, d).mul(-2.0)).add(0.15);
      return vec4(log2(max(l, 1e-5)).mul(w), w, 0, 1);
    })();
    this.lumQuad = new THREE.QuadMesh(lumMat);
    const A = this.au;
    const adaptMat = new THREE.NodeMaterial();
    adaptMat.fragmentNode = Fn(() => {
      const s = textureLevel(texture(this.lum.texture), vec2(0.5), 7.0).rg;
      const avgLog = s.x.div(max(s.y, 1e-5));
      // auto 0 = the fixed exposure, 1 = eye adaptation; in between they cross-fade in log space
      const target = mix(log2(A.exp), clamp(log2(A.key).sub(avgLog).add(A.bias), log2(A.min), log2(A.max)), A.auto);
      const prev = this.prevTex.sample(vec2(0.5)).g;
      const v = select(A.reset.greaterThan(0.5), target, mix(prev, target, A.rate));
      return vec4(exp2(v), v, 0, 1);
    })();
    this.adaptQuad = new THREE.QuadMesh(adaptMat);

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;   // the composite writes sRGB itself
    this.build();
  }

  // (re)build the node graph: MSAA, AO and the AA pass change its shape
  build() {
    const { scene, camera, u } = this;
    this.scenePass?.dispose?.();
    this.aoPass?.dispose?.();
    this.bloomPass?.dispose?.();
    const scenePass = this.scenePass = pass(scene, camera, { samples: this.msaa });
    const color = scenePass.getTextureNode('output');
    // With MSAA the WebGPU depth texture stays multisampled (no depth resolve): effects that sample depth
    // read a single-sample copy made by a small pass (sample 0 of each pixel).
    let depth = scenePass.getTextureNode('depth');
    if (this.msaa > 0) {
      const msDepth = depth;
      depth = rtt(vec4(msDepth.load(ivec2(screenCoordinate.xy)).x, 0, 0, 1), null, null, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    }
    this.depthNode = depth;
    this.lumSrc.value = scenePass.getTexture('output');
    const ex = this.expTex.sample(vec2(0.5)).r;

    let aoNode = float(1);
    if (this.ssao !== 'off') {
      const a = this.aoPass = ao(depth, null, camera);
      a.resolutionScale = 0.5;
      a.samples.value = this.ssao === 'high' ? 12 : 8;
      a.radius.value = this.ssao === 'high' ? 1.4 : 1.0;
      a.distanceFallOff.value = 1.0;
      a.thickness.value = 1.0;
      // GTAO's noise repeats every 5x5 pixels: a depth-aware 5x5 box blur at the AO's resolution averages
      // exactly one period (without it the AO showed as grain around the wheels and under the trees)
      const aoTex = a.getTextureNode();
      const near = float(camera.near), far = float(camera.far);
      const vz = uvv => perspectiveDepthToViewZ(depth.sample(uvv).r, near, far).negate();
      const aoBlur = rtt(Fn(() => {
        const texel = vec2(1.0).div(vec2(aoTex.size(0)));
        const z0 = vz(screenUV);
        const sum = float(0).toVar(), wsum = float(0).toVar();
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const o = screenUV.add(texel.mul(vec2(i, j)));
          const w = max(0.0, float(1).sub(abs(vz(o).sub(z0)).div(z0.mul(0.04).add(0.05))));
          sum.addAssign(aoTex.sample(o).r.mul(w)); wsum.addAssign(w);
        }
        return vec4(select(wsum.greaterThan(0.0), sum.div(wsum), float(1)), 0, 0, 1);
      })(), null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5, depthBuffer: false });
      aoNode = aoBlur.sample(screenUV).r;
      // fade it out with distance (it is a near-field effect; far terrain got blotchy)
      aoNode = mix(aoNode, float(1), smoothstep(80.0, 160.0, vz(screenUV)));
    } else this.aoPass = null;

    // sun shafts at quarter resolution: a sky mask (far depth), then the mask smeared towards the sun's
    // screen position (24 bilinear taps of the mask). Skipped while the sun is out of view.
    let shaftNode = vec3(0);
    if (this.shafts) {
      const SAMPLES = 24;
      const q = { type: THREE.HalfFloatType, resolutionScale: 0.25, depthBuffer: false };
      const mask = rtt(vec4(step(0.99995, depth.sample(screenUV).r), 0, 0, 1), null, null, q);
      const shafts = rtt(Fn(() => {
        const out = vec3(0).toVar();
        If(u.sunVis.greaterThan(0.001), () => {
          const p = screenUV.toVar();
          const dir = u.sunUV.sub(p).div(SAMPLES).mul(0.85);
          const acc = float(0).toVar();
          const wgt = float(1).toVar();
          p.addAssign(dir.mul(hash(screenCoordinate.xy.add(fract(u.time).mul(61.0)))));
          Loop(SAMPLES, () => {
            acc.addAssign(mask.sample(p).r.mul(wgt));
            wgt.mulAssign(0.93);
            p.addAssign(dir);
          });
          const r = length(screenUV.sub(u.sunUV).mul(vec2(1.7, 1.0)));
          out.assign(u.sunCol.mul(acc.div(SAMPLES * 0.45)).mul(u.sunVis).mul(u.shafts).mul(exp(r.mul(r).mul(-2.2))));
        });
        return vec4(out, 1);
      })(), null, null, q);
      shaftNode = shafts.sample(screenUV).rgb;
    }

    // bloom on the exposed picture (the threshold is in display units, as before)
    const P = this.params;
    const exposed = color.rgb.mul(ex);
    const bl = this.bloomPass = bloom(vec4(exposed, 1), 1, 0.5, P.bloomThreshold);
    this.bloomThreshold = bl.threshold;
    bl.smoothWidth.value = P.bloomKnee;

    const composite = Fn(() => {
      const c = color.rgb.mul(ex).toVar();
      c.mulAssign(mix(float(1), aoNode, u.aoOn));
      c.addAssign(bl.rgb.mul(u.bloom).mul(u.bloomOn));
      c.addAssign(shaftNode.mul(ex));
      c.assign(max(c.mul(u.tint).add(u.lift), 0.0));
      c.assign(neutral(c));
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c.assign(max(mix(vec3(l), c, u.sat), 0.0));
      const s = toSRGB(c).toVar();
      s.assign(clamp(mix(s, s.mul(s).mul(sub(3.0, s.mul(2.0))), u.contrast), 0.0, 1.0));
      const v = screenUV.sub(0.5);
      s.mulAssign(float(1).sub(u.vignette.mul(dot(v, v)).mul(1.6)));
      // triangular dither: no banding in the night sky and the fog
      const p = screenCoordinate.xy.add(fract(u.time).mul(61.0));
      s.addAssign(hash(p).add(hash(p.add(17.31))).sub(1.0).div(255.0));
      return vec4(s, 1.0);
    })();

    let out = composite;
    if (this.aa === 'fxaa') out = fxaa(composite);
    else if (this.aa === 'smaa') out = smaa(composite);
    this.pipeline.outputNode = out;
    this.pipeline.needsUpdate = true;
  }

  configure({ msaa, fxaa: fx, aa, ssao, shafts }) {
    let rebuild = false;
    if (ssao !== undefined && ssao !== this.ssao) { this.ssao = ssao; rebuild = true; }
    if (msaa !== undefined && msaa !== this.msaa) { this.msaa = msaa; rebuild = true; }
    const mode = aa ?? (fx === undefined ? this.aa : fx ? 'fxaa' : 'off');
    if (mode !== this.aa) { this.aa = mode; rebuild = true; }
    if (shafts !== undefined && shafts !== this.shafts) { this.shafts = shafts; rebuild = true; }
    if (rebuild) this.build();
  }

  setSize(w, h) { this.width = w; this.height = h; }

  // the sun on screen for the shafts (environment calls it with the light direction)
  setSun(dirWorld, color, visible) {
    const cam = this.camera, u = this.u;
    const p = _v.copy(dirWorld).multiplyScalar(1000).add(cam.position).project(cam);
    u.sunUV.value.set(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    // facing the sun: fades as it leaves the view (shafts still come in from just off screen)
    const fwd = _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const facing = THREE.MathUtils.smoothstep(fwd.dot(dirWorld), 0.15, 0.6);
    const edge = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 1.1, 1.8);
    u.sunVis.value = visible * facing * edge;
    u.sunCol.value.copy(color);
  }

  render(dt = 1 / 60) {
    const r = this.renderer, P = this.params, u = this.u;
    this.time += dt;
    u.time.value = this.time;
    u.bloom.value = P.bloomStrength * 12;   // BloomNode's chain sums 5 normalised mips: ~12x the old chain's level
    u.bloomOn.value = P.bloom && P.bloomStrength > 0 ? 1 : 0;
    this.bloomThreshold.value = P.bloomThreshold;
    u.vignette.value = P.vignette; u.sat.value = P.saturation; u.contrast.value = P.contrast;
    u.tint.value.copy(P.tint); u.lift.value.copy(P.lift);
    u.aoOn.value = this.ssao !== 'off' ? 1 : 0;
    u.shafts.value = P.shafts;
    if (this.aoPass) this.aoPass.updateBeforeType = this.ssao !== 'off' ? THREE.NodeUpdateType.FRAME : THREE.NodeUpdateType.NONE;

    this.pipeline.render();

    // ---- eye adaptation for the next frame (or the fixed exposure written to the same 1x1 target)
    const prev = this.adapt[this.adaptIdx], next = this.adapt[1 - this.adaptIdx];
    this.adaptIdx = 1 - this.adaptIdx;
    const A = this.au;
    if (P.autoExposure) {
      this.lumSrc.value = this.scenePass.getTexture('output');
      r.setRenderTarget(this.lum);
      this.lumQuad.render(r);
      A.min.value = P.minExposure; A.max.value = P.maxExposure; A.key.value = P.key; A.bias.value = P.exposureBias;
      A.auto.value = P.auto;
    } else {
      A.min.value = A.max.value = P.exposure; A.bias.value = 0;
      A.auto.value = 0;
    }
    A.exp.value = P.exposure;
    this.prevTex.value = prev.texture;
    A.rate.value = 1 - Math.exp(-dt * P.adaptRate);
    A.reset.value = this.resetExposure ? 1 : 0;
    this.resetExposure = false;
    r.setRenderTarget(next);
    this.adaptQuad.render(r);
    r.setRenderTarget(null);
    this.expTex.value = next.texture;
  }

  dispose() {
    for (const t of [this.lum, ...this.adapt]) t.dispose();
    this.pipeline.dispose();
  }
}

const _v = new THREE.Vector3(), _f = new THREE.Vector3();
