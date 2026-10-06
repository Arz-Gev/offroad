import * as THREE from 'three/webgpu';
import { Fn, uniform, attribute, vec2, vec3, vec4, float, uv, positionGeometry, cameraViewMatrix, cameraProjectionMatrix, varyingProperty, smoothstep, dot, exp, clamp } from 'three/tsl';

// A cloud of round, camera-facing particles (dust, mud, splashes, sparks, smoke): one instanced quad per
// particle, sized in metres. WebGPU has no point sizes above one pixel, so the old gl_PointSize sprites are
// quads now (the size already followed the perspective, so they look the same).
// The CPU fills the typed arrays (pos xyz, size, alpha, rgb) and calls commit(n).
//   opts.blending:  THREE.NormalBlending | THREE.AdditiveBlending
//   opts.near:      [a, b] view distances over which particles fade in (nothing big right at the lens)
//   opts.shape:     'soft' (1 - r)^2 | 'hot' (1 - r) | 'smoke' 0.38 (1 - r) e^-2.5r
export function spriteCloud(max, opts = {}) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', quad.getAttribute('position'));
  g.setAttribute('uv', quad.getAttribute('uv'));
  g.setIndex(quad.getIndex());
  const pos = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max), color = new Float32Array(max * 3);
  const attr = (a, n) => new THREE.InstancedBufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  const aPos = attr(pos, 3), aSize = attr(size, 1), aAlpha = attr(alpha, 1), aColor = attr(color, 3);
  g.setAttribute('iPos', aPos); g.setAttribute('iSize', aSize); g.setAttribute('iAlpha', aAlpha); g.setAttribute('iColor', aColor);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const light = uniform(1);
  const [n0, n1] = opts.near || [0.4, 2.5];
  const vFade = varyingProperty('float', 'vSpFade');
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: opts.blending ?? THREE.NormalBlending });
  mat.fog = opts.fog ?? true;
  mat.vertexNode = Fn(() => {
    const mv = cameraViewMatrix.mul(vec4(attribute('iPos', 'vec3'), 1.0)).toVar();
    vFade.assign(smoothstep(n0, n1, mv.z.negate()));
    mv.xy.addAssign(positionGeometry.xy.mul(attribute('iSize', 'float')));
    return cameraProjectionMatrix.mul(mv);
  })();
  const d = uv().sub(0.5);
  const r = dot(d, d).mul(4.0);
  const a = attribute('iAlpha', 'float').mul(vFade);
  const shape = opts.shape || 'soft';
  const k = clamp(float(1).sub(r), 0.0, 1.0);
  mat.colorNode = attribute('iColor', 'vec3').mul(opts.lit === false ? float(1) : light);
  mat.opacityNode = shape === 'hot' ? a.mul(k) : shape === 'smoke' ? a.mul(k).mul(exp(r.mul(-2.5))).mul(0.38) : a.mul(k).mul(k);
  if (shape === 'hot') { mat.colorNode = attribute('iColor', 'vec3').mul(a.mul(k)); mat.opacityNode = float(1); }
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.renderOrder = opts.renderOrder ?? 2;
  return {
    mesh, mat, pos, size, alpha, color, light, max,
    // n: how many leading entries to draw (the pools are rings, so pass max when any are alive)
    commit(n = max) {
      g.instanceCount = n;
      for (const a of [aPos, aSize, aAlpha, aColor]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    },
  };
}
