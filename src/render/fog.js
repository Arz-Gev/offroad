import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, positionWorld, cameraPosition, normalize, length, max, min, exp, abs, clamp, dot, mix, pow, select, fog } from 'three/tsl';

// Atmosphere fog for every material (scene.fogNode): exponential height fog plus aerial perspective.
// The colour depends on the view direction (horizon colour towards / across / away from the sun, plus a
// Mie glow around it), so distant hills fade into the sky behind them instead of into a flat grey.
// environment.js writes the uniforms from the same single-scattering model as the sky (setVec4).

export const ATMO = {
  // xyz: direction towards the sun (or the moon at night), w: height-fog falloff (1/m)
  atmoSun: uniform(new THREE.Vector4(0, 1, 0, 0.02)),
  // rgb: horizon colour away from the sun, w: height-fog reference height (m)
  atmoAway: uniform(new THREE.Vector4(0.5, 0.6, 0.7, 0)),
  // rgb: horizon colour at 90 deg to the sun, w: haze density (1/m), the aerial perspective
  atmoSide: uniform(new THREE.Vector4(0.5, 0.6, 0.7, 0.0003)),
  // rgb: horizon colour towards the sun, w: maximum fog opacity
  atmoToward: uniform(new THREE.Vector4(0.6, 0.6, 0.6, 1)),
  // rgb: Mie glow colour around the sun, w: anisotropy g
  atmoGlow: uniform(new THREE.Vector4(0, 0, 0, 0.7)),
  // x: fog density (1/m), y: extra ground fog (valley mist, rain), z: ground fog height (m), w: unused
  fogParams: uniform(new THREE.Vector4(0.002, 0, 20, 0)),
};

export const setVec4 = (u, x, y, z, w) => { const o = u.value; o.x = x; o.y = y; o.z = z; if (w !== undefined) o.w = w; };

// fog opacity for a camera-relative world offset d
export const atmoFogFactor = Fn(([d]) => {
  const dist = length(d);
  const b = ATMO.atmoSun.w;
  const dens0 = ATMO.fogParams.x.mul(exp(b.negate().mul(cameraPosition.y.sub(ATMO.atmoAway.w))));
  const dy = clamp(d.y.mul(b), -40.0, 40.0);
  const hf = select(abs(dy).greaterThan(1e-3), float(1).sub(exp(dy.negate())).div(dy), float(1).sub(dy.mul(0.5)));
  // valley mist: a thin layer that hugs the ground below fogParams.z (world height), seen through its depth
  const gb = float(1).div(max(ATMO.fogParams.z, 1.0));
  const gdens = ATMO.fogParams.y.mul(exp(cameraPosition.y.mul(gb).negate()));
  const gdy = clamp(d.y.mul(gb), -40.0, 40.0);
  const ghf = select(abs(gdy).greaterThan(1e-3), float(1).sub(exp(gdy.negate())).div(gdy), float(1).sub(gdy.mul(0.5)));
  const od = dist.mul(min(dens0.mul(hf), 0.2).add(ATMO.atmoSide.w).add(min(gdens.mul(ghf), 0.3)));
  return min(float(1).sub(exp(od.negate())), ATMO.atmoToward.w);
});

// fog colour for a unit view direction v
export const atmoFogColor = Fn(([v]) => {
  const hz = normalize(v.xz.add(1e-5));
  const sz = normalize(ATMO.atmoSun.xz.add(1e-5));
  const a = dot(hz, sz);
  const col = select(a.greaterThan(0.0), mix(ATMO.atmoSide.rgb, ATMO.atmoToward.rgb, a), mix(ATMO.atmoSide.rgb, ATMO.atmoAway.rgb, a.negate()));
  const g = ATMO.atmoGlow.w;
  const mu = dot(v, ATMO.atmoSun.xyz);
  const hg = float(1).sub(g.mul(g)).div(pow(max(float(1).add(g.mul(g)).sub(g.mul(2).mul(mu)), 1e-4), 1.5));
  return col.add(ATMO.atmoGlow.rgb.mul(hg).mul(0.0795775));
});

// per pixel: the colour and the factor for the camera-to-fragment offset
export function makeFogNode() {
  const d = positionWorld.sub(cameraPosition);
  const f = atmoFogFactor(d);
  const c = atmoFogColor(d.div(max(length(d), 1e-4)));
  return fog(c, f);
}

// the same for materials that blend premultiplied (water, glass): rgb * (1 - f) + fogColour * f * alpha
export function premultipliedFog(rgba) {
  const d = positionWorld.sub(cameraPosition);
  const f = atmoFogFactor(d);
  const c = atmoFogColor(d.div(max(length(d), 1e-4)));
  return vec4(rgba.rgb.mul(float(1).sub(f)).add(c.mul(f).mul(rgba.a)), rgba.a);
}
