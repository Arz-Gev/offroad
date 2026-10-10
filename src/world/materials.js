import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, vec3, vec4, float, int, positionWorld, normalWorldGeometry, cameraViewMatrix, pow, abs, mix, smoothstep, normalize } from 'three/tsl';
import { LAYER, LAYER_TILE } from './textures.js';

// Shared world materials built on the baked ground layers (textures.js):
// rock: triplanar rock albedo + normal at two scales, moss / lichen on the up-facing parts, darker in the
// cracks (the layers' cavity AO). Used by the boulders, the hut's stone walls and rock outcrops.
// Rain (uWet, weather.js) darkens it and makes it glossy, most on the up-facing faces.

export const rockWet = uniform(0);

export function makeRockMaterial(layers, opts = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: opts.color ?? 0xffffff, roughness: 0.85, metalness: 0, vertexColors: !!opts.vertexColors });
  const tAlb = texture(layers.albedo), tLNrm = texture(layers.normal);
  const rockTile = 1 / (opts.tile ?? 2.2), mossTile = 1 / LAYER_TILE[LAYER.grass], mossAmt = opts.moss ?? 1;
  const R = int(LAYER.rock), F = int(LAYER.forest);
  const rough = float(0.85).toVar('rRough'), ao = float(1).toVar('rAO'), nW = vec3(0, 1, 0).toVar('rN');
  const tri = (t, p, w, l, s) => t.sample(p.zy.mul(s)).depth(l).mul(w.x).add(t.sample(p.xz.mul(s)).depth(l).mul(w.y)).add(t.sample(p.xy.mul(s)).depth(l).mul(w.z));
  mat.colorNode = Fn(() => {
    const n = normalize(normalWorldGeometry);
    const wv = pow(abs(n), vec3(4.0)); const w = wv.div(wv.x.add(wv.y).add(wv.z));
    const p = positionWorld;
    const a1 = tri(tAlb, p, w, R, rockTile), a2 = tri(tAlb, p, w, R, rockTile * 0.29), n1 = tri(tLNrm, p, w, R, rockTile);
    const c = mix(a1.rgb, a2.rgb, 0.4).toVar();
    // moss / grass on top, broken up by the large-scale rock height
    const up = smoothstep(0.55, 0.9, n.y).mul(mossAmt);
    const moss = up.mul(smoothstep(0.35, 0.65, a2.a.add(n.y.sub(0.75))));
    const mc = tAlb.sample(p.xz.mul(mossTile)).depth(F);
    c.assign(mix(c, mc.rgb.mul(vec3(0.8, 1.05, 0.7)), moss.mul(0.85)));
    // detail normal: tangent-space xy of each projection added in its plane (UDN-style blend)
    const tx = tLNrm.sample(p.zy.mul(rockTile)).depth(R).xy.mul(2).sub(1);
    const ty = tLNrm.sample(p.xz.mul(rockTile)).depth(R).xy.mul(2).sub(1);
    const tz = tLNrm.sample(p.xy.mul(rockTile)).depth(R).xy.mul(2).sub(1);
    nW.assign(normalize(n.add(vec3(0.0, tx.y, tx.x).mul(w.x).add(vec3(ty.x, 0.0, ty.y).mul(w.y)).add(vec3(tz.x, tz.y, 0.0).mul(w.z)).mul(0.9))));
    ao.assign(mix(1.0, n1.a, 0.85));
    const wet = rockWet.mul(smoothstep(-0.2, 0.6, n.y).mul(0.6).add(0.4));
    rough.assign(mix(mix(0.82, 0.95, moss), 0.22, wet));
    return c.mul(float(1).sub(wet.mul(0.4)));
  })();
  mat.roughnessNode = rough;
  mat.aoNode = ao;
  mat.normalNode = cameraViewMatrix.mul(vec4(nW, 0.0)).xyz;
  return mat;
}
