import * as THREE from 'three';
import { TIRE_FAN, TIRE_ROWS, TIRE_ROW_OFFSET } from '../tire.js';

// Tyre material whose vertex shader deforms the tyre by the physics contact data, ray by ray (tyre v2).
//
// The physics casts a fan of rays from the hub (tire.js TIRE_FAN angles x TIRE_ROWS rows across the tread)
// and knows how far the ground reaches into the tyre along each (radial intrusion, m). The shader gets that
// table (uProf, in the tyre's own units) and moves every vertex towards the axle by the intrusion at its angle
// and row, interpolated between rays. The whole carcass moves (lugs keep their height), the sidewalls bulge next
// to the patch, and nothing inside the rim radius moves: a rim merged into the same mesh (G-Class) stays round,
// a separate rim (BTR-80) never gets this material.
//
// Frames: object space -> wheel space (uToWheel: the mesh's matrix in the spinning wheel group, axle along x,
// centre at the origin, unscaled) -> the steering frame (undo the spin uSpin about x), where the ray angles
// live: angle 0 points straight down, + towards the front (-z). The same code runs in the shadow depth pass
// (customDepthMaterial), so the shadow is the squashed tyre too.

const NF = TIRE_FAN.length, NR = TIRE_ROWS.length;
const FAN0 = TIRE_FAN[0], FANSTEP = TIRE_FAN[1] - TIRE_FAN[0];

const GLSL_COMMON = /* glsl */`
uniform float uProf[${NR * NF}];
uniform float uSpin;
uniform mat4 uToWheel;
uniform mat4 uFromWheel;
uniform float uR;       // tread radius (wheel units)
uniform float uRim;     // nothing inside this radius moves
uniform float uHalfW;   // half tread width
float tireProf(int r, float fk) {
  int k0 = int(floor(fk));
  float t = fk - float(k0);
  float a = (k0 >= 0 && k0 < ${NF}) ? uProf[r * ${NF} + k0] : 0.0;
  float b = (k0 + 1 >= 0 && k0 + 1 < ${NF}) ? uProf[r * ${NF} + k0 + 1] : 0.0;
  return mix(a, b, t);
}
// deformed position in object space; nrm is tilted with the sidewall bulge
vec3 tireDeform(vec3 pos, inout vec3 nrm) {
  vec3 p = (uToWheel * vec4(pos, 1.0)).xyz;
  float cs = cos(uSpin), sn = sin(uSpin);
  // spinning wheel frame -> steering frame: the wheel group is turned by -spin about x, so rotate by -spin
  vec3 q = vec3(p.x, cs * p.y + sn * p.z, -sn * p.y + cs * p.z);
  float r = length(q.yz);
  if (r <= uRim) return pos;
  float th = atan(-q.z, -q.y);
  float fk = (th - ${FAN0.toFixed(6)}) / ${FANSTEP.toFixed(6)};
  // rows across the tread at x = -o, 0, +o (o = ${TIRE_ROW_OFFSET} x width), clamped at the outer rows
  float xr = clamp(q.x / (uHalfW * ${(2 * TIRE_ROW_OFFSET).toFixed(4)}), -1.0, 1.0);
  float d = xr < 0.0 ? mix(tireProf(1, fk), tireProf(0, fk), -xr) : mix(tireProf(1, fk), tireProf(2, fk), xr);
  if (d <= 0.0) return pos;
  // the carcass moves in by the intrusion (fading out down the sidewall towards the rim)
  float w = smoothstep(uRim + 0.02 * uR, uRim + 0.55 * (uR - uRim), r);
  vec2 dir = q.yz / r;
  q.yz -= dir * (d * w);
  // sidewall bulge next to the patch (the squeezed air and carcass go sideways)
  float side = smoothstep(0.45, 0.95, abs(q.x) / uHalfW);
  float wall = 1.0 - smoothstep(uR - 0.25 * (uR - uRim), uR, r);
  float bulge = d * 0.45 * side * (0.35 + 0.65 * wall) * smoothstep(uRim, uRim + 0.3 * (uR - uRim), r);
  q.x += sign(q.x) * bulge;
  nrm = normalize(nrm + (mat3(uFromWheel) * vec3(sign(q.x) * bulge * 4.0 / max(uR, 1e-3), 0.0, 0.0)));
  // back to the spinning frame and to object space
  p = vec3(q.x, cs * q.y - sn * q.z, sn * q.y + cs * q.z);
  return (uFromWheel * vec4(p, 1.0)).xyz;
}
`;

function patch(sh, uniforms, depth = false) {
  Object.assign(sh.uniforms, uniforms);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL_COMMON);
  // the depth pass has no normals: deform the position only
  if (depth) sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', 'vec3 tireN = vec3(0.0, 0.0, 1.0);\nvec3 transformed = tireDeform(position, tireN);');
  else sh.vertexShader = sh.vertexShader
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vec3 tirePos = tireDeform(position, objectNormal);`)
    .replace('#include <begin_vertex>', 'vec3 transformed = tirePos;');
}

// base: a material to copy (an imported tyre's own) or a texture for a plain rubber material
export function createTireMaterial(base) {
  const mat = base?.isMaterial ? base.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff, map: base || null, roughness: 0.86, metalness: 0.0 });
  const uniforms = {
    uProf: { value: new Float32Array(NR * NF) },
    uSpin: { value: 0 },
    uToWheel: { value: new THREE.Matrix4() },
    uFromWheel: { value: new THREE.Matrix4() },
    uR: { value: 0.42 },
    uRim: { value: 0.205 },
    uHalfW: { value: 0.135 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = sh => patch(sh, uniforms);
  mat.customProgramCacheKey = () => 'tire-deform-v2';
  // the shadow of the squashed tyre: same deformation in the depth pass (shares the uniforms)
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = sh => patch(sh, uniforms, true);
  depth.customProgramCacheKey = () => 'tire-deform-depth-v2';
  mat.userData.depth = depth;
  return mat;
}

// Use it on a mesh inside a wheel's spin group: toWheel = the mesh's matrix relative to the spin group
// (axle along x, unscaled), R / rim / width in those units.
export function makeTireMesh(mesh, mat, { toWheel = null, R, rim, width }) {
  const u = mat.userData.uniforms;
  if (toWheel) { u.uToWheel.value.copy(toWheel); u.uFromWheel.value.copy(toWheel).invert(); }
  u.uR.value = R; u.uRim.value = rim; u.uHalfW.value = width / 2;
  mesh.material = mat;
  mesh.customDepthMaterial = mat.userData.depth;
  return mesh;
}

// Fill the table from a physics wheel. scale: physics metres -> wheel units (1 / the wheel group's radial
// scale). Wheels without per-ray data (friends' trucks over the network) get the patch of their contact
// plane: intrusion R - h / cos(angle - tilt).
export function setTireContact(mat, w, R, scale, spin) {
  const u = mat.userData.uniforms, out = u.uProf.value;
  u.uSpin.value = spin;
  if (w.rayPen && w.contact) {
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, w.rayPen[i]) * scale;
    return;
  }
  if (!w.contact || !(w.pen > 0)) { out.fill(0); return; }
  // plane: distance h below the hub along the normal, tilted fore-aft by atan2(nz, ny) in the wheel frame
  const h = R - w.pen, tilt = w.nTilt || 0;
  for (let r = 0; r < NR; r++) for (let k = 0; k < NF; k++) {
    const c = Math.cos(TIRE_FAN[k] - tilt);
    out[r * NF + k] = c > 0.05 ? Math.max(0, R - h / c) * scale : 0;
  }
}
