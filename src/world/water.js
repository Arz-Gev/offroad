import * as THREE from 'three/webgpu';
import {
  Fn, uniform, attribute, texture, vec2, vec3, vec4, float, int, ivec2, positionWorld, cameraPosition, cameraViewMatrix,
  output, mat2, mix, clamp, smoothstep, max, min, exp, pow, dot, normalize, length, floor, abs,
} from 'three/tsl';
import { NOISE_GLSL } from './textures.js';
import { bakeLayers } from '../render/glbake.js';
import { premultipliedFog } from '../render/fog.js';

// Water: the lake, the stream (with the ford on the outer loop) and muddy pools in the mud holes.
// Visual only (the physics has no water): every surface lies over a real terrain bed the truck drives on.
// - The depth of the water column comes from the physics heightfield in the shader (same triangle split),
//   so there is no depth pre-pass: shallow water shows the bed, deep water absorbs it, the waterline is soft.
// - Lit as a smooth dielectric (MeshStandardNodeMaterial underneath): sky reflection from the environment
//   map, sun glints, tree shadows; Fresnel decides how much of the bed shows through. It blends
//   premultiplied (one, one - alpha): the reflection keeps its full strength over a see-through body.
// - Ripples: a baked tileable normal map, two layers; the stream's layers scroll down the flow, faster
//   where it is steep; foam along the shore and in fast shallow water. Rain adds rings (weather.js).

const RIPPLE_FRAG = /* glsl */`
${NOISE_GLSL}
varying vec2 vUv;
float H(vec2 uv) {
  vec2 w = vec2(pfbm(uv + 0.13, 3.0, 3), pfbm(uv + 0.71, 3.0, 3));
  return pfbm(uv + (w - 0.5) * 0.12, 5.0, 5);
}
void main() {
  float e = 1.0 / 2048.0;
  float h0 = H(vUv), hx = H(vUv + vec2(e, 0.0)), hy = H(vUv + vec2(0.0, e));
  // slope in "per tile" units, scaled down to gentle ripples (the shader scales it again)
  vec2 sl = vec2(h0 - hx, h0 - hy) / e * 0.012;
  vec3 n = normalize(vec3(sl, 1.0));
  float foam = pfbm(vUv + 0.37, 12.0, 3);
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, foam, h0);
}`;

function bakeRipples(size = 512) {
  const [data] = bakeLayers({ size, frag: RIPPLE_FRAG });
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export const waterRain = uniform(0);   // 0..1: rain rings on the surface (weather.js)

export function buildWater(terrain, terrainView, renderer) {
  const group = new THREE.Group();
  group.name = 'water';
  const ripple = bakeRipples();
  const time = uniform(0);
  const TU = terrainView.uniforms;
  const tH = texture(terrainView.heightTex), tR = texture(ripple);

  const ground = Fn(([xz]) => {
    const f = xz.add(TU.uMap.x).div(TU.uMap.y);
    const i = ivec2(floor(f)), t = f.sub(floor(f));
    const n1 = int(TU.uMap.z).sub(1);
    const hg = (a, b) => { const g = ivec2(i.x.add(a), i.y.add(b)).clamp(ivec2(0), ivec2(n1)); return tH.load(ivec2(g.y, g.x)).r; };
    const h00 = hg(0, 0), h10 = hg(1, 0), h01 = hg(0, 1), h11 = hg(1, 1);
    return t.x.add(t.y).lessThanEqual(1.0).select(
      h00.add(h10.sub(h00).mul(t.x)).add(h01.sub(h00).mul(t.y)),
      h11.add(h01.sub(h11).mul(float(1).sub(t.x))).add(h10.sub(h11).mul(float(1).sub(t.y))));
  });

  const makeMaterial = (kind, opts) => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: opts.rough ?? 0.06, metalness: 0, transparent: true, depthWrite: false });
    m.fog = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    const uniforms = {
      uEdge: uniform(new THREE.Vector4(0, 0, 0, 0)),
      uAbsorb: uniform(opts.absorb), uRipple: uniform(opts.ripple), uFoam: uniform(opts.foam), uScatter: uniform(new THREE.Color(...opts.scatter)),
    };
    const U = uniforms;
    const aFlow = attribute('aFlow', 'vec3'), aDir = attribute('aDir', 'vec2');
    const wDepth = positionWorld.y.sub(ground(positionWorld.xz)).toVar('wDepth');
    const nW = vec3(0, 1, 0).toVar('wN'), wA = float(1).toVar('wA'), wEdge = float(1).toVar('wEdge');
    m.colorNode = Fn(() => {
      const p = positionWorld;
      // ripples in the flow frame (x across, y along), then rotated into world xz
      const dist = length(p.sub(cameraPosition));
      const spd = aFlow.z;
      const fp = vec2(aFlow.y, aFlow.x);
      const r1 = tR.sample(fp.add(vec2(0.0, time.mul(spd).negate())).div(7.0).add(vec2(time.mul(0.011), time.mul(0.006))));
      const r2 = tR.sample(mat2(0.8, -0.6, 0.6, 0.8).mul(fp.add(vec2(0.0, time.mul(spd).mul(1.6).negate()))).div(2.3).sub(vec2(time.mul(0.017), time.mul(0.012).negate())));
      // rain: two rows of expanding rings (cells of 0.7 m, random phase), only near the camera
      const rc = p.xz.div(0.7), ci = floor(rc), cf = rc.sub(ci).sub(0.5);
      const hsh = Fn(([q]) => q.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract());
      const ph = time.mul(1.3).add(hsh(ci)).fract();
      const rr = length(cf.add(vec2(hsh(ci.add(3.1)), hsh(ci.add(7.7))).sub(0.5).mul(0.5)));
      const ring = smoothstep(0.06, 0.0, abs(rr.sub(ph.mul(0.45)))).mul(float(1).sub(ph)).mul(waterRain).mul(smoothstep(30.0, 8.0, dist));
      const rainSl = cf.normalize().mul(ring).mul(0.6);
      const sl = r1.xy.mul(2).sub(1).mul(0.8).add(r2.xy.mul(2).sub(1).mul(0.6)).mul(U.uRipple).mul(spd.mul(0.6).add(1.0))
        .mul(float(1).sub(smoothstep(40.0, 260.0, dist).mul(0.6))).add(rainSl);
      const across = vec2(aDir.y, aDir.x.negate());
      const slW = across.mul(sl.x).add(aDir.mul(sl.y));
      nW.assign(normalize(vec3(slW.x.negate(), 1.0, slW.y.negate())));
      // foam: along the waterline, and in fast shallow water
      const foamN = r1.b.mul(0.6).add(r2.b.mul(0.4));
      const f0 = U.uFoam.mul(smoothstep(0.1, 0.0, wDepth).mul(0.7).add(smoothstep(0.35, 0.05, wDepth).mul(smoothstep(0.6, 1.6, spd)).mul(0.8)));
      const foam = clamp(f0.mul(smoothstep(0.42, 0.62, foamN)).mul(1.6), 0.0, 1.0).mul(float(1).sub(smoothstep(30.0, 80.0, dist)));
      const d = max(wDepth, 0.0);
      const T = exp(d.mul(U.uAbsorb).negate());
      const V = normalize(cameraPosition.sub(p));
      const NoV = clamp(dot(nW, V), 0.0, 1.0);
      const Fr = pow(float(1).sub(NoV), 5.0).mul(0.98).add(0.02);
      wA.assign(mix(float(1).sub(T.mul(float(1).sub(Fr))), 1.0, foam));
      // the disc's rim: stray hollows near the shore inside it are not part of the lake
      const e = smoothstep(-0.03, 0.05, wDepth).toVar();
      const ed = length(p.xz.sub(U.uEdge.xy).mul(U.uEdge.zw));
      wEdge.assign(e.mul(U.uEdge.z.greaterThan(0.0).select(smoothstep(1.0, 0.97, ed), float(1))));
      return mix(U.uScatter.mul(float(1).sub(T)).mul(float(1).sub(Fr)), vec3(0.8), foam);
    })();
    m.normalNode = cameraViewMatrix.mul(vec4(nW, 0.0)).xyz;
    m.maskNode = wDepth.greaterThanEqual(-0.03);
    m.outputNode = premultipliedFog(vec4(output.rgb.mul(wEdge), wA.mul(wEdge)));
    m.userData.uniforms = uniforms;
    return m;
  };

  const lakeMat = makeMaterial('lake', { absorb: 1.4, ripple: 0.55, foam: 0.6, scatter: [0.05, 0.10, 0.09] });
  const streamMat = makeMaterial('stream', { absorb: 2.2, ripple: 0.8, foam: 1.0, scatter: [0.07, 0.11, 0.08] });
  const mudMat = makeMaterial('mud', { absorb: 9.0, ripple: 0.25, foam: 0.0, scatter: [0.16, 0.11, 0.065], rough: 0.12 });

  const geoFrom = (pos, flow, dir, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  };
  // elliptic disc (lake, pools): world coordinates as the flow frame, no flow
  const disc = (cx, cz, rx, rz, y, rings = 10, segs = 72) => {
    const pos = [cx, y, cz], flow = [cx, cz, 0], dir = [0, 1], idx = [];
    for (let r = 1; r <= rings; r++) for (let s = 0; s < segs; s++) {
      const a = s / segs * Math.PI * 2, f = r / rings;
      const x = cx + Math.cos(a) * rx * f, z = cz + Math.sin(a) * rz * f;
      pos.push(x, y, z); flow.push(z, x, 0); dir.push(0, 1);
    }
    flow[0] = cz; flow[1] = cx;
    const ring = (r, s) => r === 0 ? 0 : 1 + (r - 1) * segs + (s % segs);
    for (let s = 0; s < segs; s++) idx.push(0, ring(1, s + 1), ring(1, s));
    for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
      const a = ring(r, s), b = ring(r, s + 1), c = ring(r + 1, s), d = ring(r + 1, s + 1);
      idx.push(a, b, c, b, d, c);
    }
    return geoFrom(pos, flow, dir, idx);
  };

  const meshes = [];
  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true; m.castShadow = false;
    m.renderOrder = 1;
    group.add(m); meshes.push(m);
    return m;
  };
  for (const w of terrain.water) {
    if (w.type === 'lake') { add(disc(w.x, w.z, w.rx, w.rz, w.level), lakeMat); lakeMat.userData.uniforms.uEdge.value.set(w.x, w.z, 1 / w.rx, 1 / w.rz); }
    else if (w.type === 'pool') add(disc(w.x, w.z, w.rx, w.rz, w.level, 4, 40), mudMat);
    else if (w.type === 'stream') {
      // ribbon along the stream, wider than the water so the waterline comes from the bed
      const pts = w.pts, n = pts.length, lake = terrain.lake;
      const pos = [], flow = [], dir = [], idx = [];
      const ACROSS = [-1, -0.5, 0, 0.5, 1];
      let along = 0, rows = 0;
      for (let k = 0; k < n; k++) {
        const p = pts[k];
        if (lake && Math.hypot((p.x - lake.x) / lake.rx, (p.z - lake.z) / lake.rz) < 0.97) break;
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        if (k > 0) along += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
        const hw = w.width[k] + 2.5;
        const drop = k < n - 1 ? (w.level[k] - w.level[k + 1]) / Math.max(0.5, Math.hypot(pts[k + 1].x - p.x, pts[k + 1].z - p.z)) : 0;
        const spd = Math.min(2.2, 0.35 + drop * 45);
        for (const s of ACROSS) {
          const off = s * hw;
          pos.push(p.x + tz * off, w.level[k], p.z - tx * off);
          flow.push(along, off, spd);
          dir.push(tx, tz);
        }
        rows++;
      }
      const C = ACROSS.length;
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
      if (rows > 1) add(geoFrom(pos, flow, dir, idx), streamMat);
    }
  }

  let enabled = true;
  return {
    group, meshes, ripple,
    materials: { lake: lakeMat, stream: streamMat, mud: mudMat },
    configure(q) { enabled = true; group.visible = enabled; },
    update(dt) { time.value += dt; },
  };
}
