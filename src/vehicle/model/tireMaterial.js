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

// how dusty the tyres are (0 clean black rubber .. 1), every tyre's
export const TIRE_DUST = { value: 0.3 };

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
float tireRf = 0.0;   // where the last deformed point lies between the rim (0) and the tread (1)
vec2 tireWall = vec2(0.0);   // how much of a sidewall it is, how squeezed it is there (0 .. 1)
// deformed position in object space
vec3 tireDeform(vec3 pos) {
  vec3 p = (uToWheel * vec4(pos, 1.0)).xyz;
  float cs = cos(uSpin), sn = sin(uSpin);
  // spinning wheel frame -> steering frame: the wheel group is turned by -spin about x, so rotate by -spin
  vec3 q = vec3(p.x, cs * p.y + sn * p.z, -sn * p.y + cs * p.z);
  float r = length(q.yz);
  tireRf = clamp((r - uRim) / max(uR - uRim, 1e-4), 0.0, 1.0);
  tireWall = vec2(0.0);
  if (r <= uRim) return pos;
  float side = smoothstep(0.45, 0.95, abs(q.x) / uHalfW);
  tireWall.x = side;
  float th = atan(-q.z, -q.y);
  float fk = (th - ${FAN0.toFixed(6)}) / ${FANSTEP.toFixed(6)};
  // rows across the tread at x = -o, 0, +o (o = ${TIRE_ROW_OFFSET} x width), clamped at the outer rows
  float xr = clamp(q.x / (uHalfW * ${(2 * TIRE_ROW_OFFSET).toFixed(4)}), -1.0, 1.0);
  float d = max(xr < 0.0 ? mix(tireProf(1, fk), tireProf(0, fk), -xr) : mix(tireProf(1, fk), tireProf(2, fk), xr), 0.0);
  // the sidewall's bulge reaches a little past the ends of the patch (the carcass is stiff)
  float dB = max(d, 0.55 * max(tireProf(1, fk - 1.5), tireProf(1, fk + 1.5)));
  if (dB <= 0.0) return pos;
  // the carcass moves in by the intrusion (fading out down the sidewall towards the rim)
  float w = smoothstep(uRim + 0.02 * uR, uRim + 0.55 * (uR - uRim), r);
  vec2 dir = q.yz / r;
  q.yz -= dir * (d * w);
  // sidewall bulge next to the patch (the squeezed air and carcass go sideways): most at the middle of the
  // sidewall, none at the rim, a little at the tread's edge
  float wall = smoothstep(0.0, 0.45, tireRf) * (1.0 - 0.75 * smoothstep(0.6, 1.0, tireRf));
  q.x += sign(q.x) * dB * 0.75 * side * wall;
  tireWall.y = side * clamp(dB / (0.22 * (uR - uRim)), 0.0, 1.0);
  // back to the spinning frame and to object space
  p = vec3(q.x, cs * q.y - sn * q.z, sn * q.y + cs * q.z);
  return (uFromWheel * vec4(p, 1.0)).xyz;
}
`;

// dry dust on the rubber, most on the tread and the lower sidewall: an off-road tyre is never clean black, and in
// plain black the squashed tyre's shape could not be read from the side
const DUST = [0.19, 0.16, 0.12];

// What lets the squash be read from the side, also in the shade, where a black sidewall lit from all round has no
// shading to show a shape by:
// - the sidewall's moulded rings (RINGS: rim protector, body, shoulder), in the undeformed tyre's radius, so they
//   bend flat over the patch and swell round the bulge;
// - the bulge in the light from round it: its upper half sees the sky and the sunlit ground beside the truck, its
//   lower half, rolled under, only the ground it rests on.
const RINGS = [0.2, 0.36, 0.7];
const WALL_GLSL = /* glsl */`
float tireRing(float at, float w) {
  float aa = fwidth(vTireR) + 1e-4, d = vTireR - at;
  return (1.0 - smoothstep(w, w + aa, abs(d))) * clamp(w / aa, 0.25, 1.0);
}`;

function patch(sh, uniforms, depth = false) {
  Object.assign(sh.uniforms, uniforms);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + (depth ? '' : 'varying float vTireR;\nvarying vec2 vTireWall;\n'));
  // the depth pass has no normals: deform the position only
  if (depth) sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = tireDeform(position);');
  // The normal follows the deformation: two points a little along the surface are deformed too, and the normal is
  // the one of the plane through the three. (A tilt added along the axle did nothing for a sidewall, which faces
  // along the axle already: from the side the bulge had no shading at all and could not be seen.)
  else sh.vertexShader = sh.vertexShader
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vec3 tirePos = tireDeform(position);
vTireR = tireRf;
vTireWall = tireWall;
{
  vec3 tn = normalize(objectNormal);
  vec3 t1 = normalize(cross(tn, abs(tn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), t2 = cross(tn, t1);
  float te = 0.012 * uR * length(uFromWheel[0].xyz);
  vec3 nn = cross(tireDeform(position + t1 * te) - tirePos, tireDeform(position + t2 * te) - tirePos);
  if (dot(nn, nn) > 1e-24) objectNormal = normalize(nn);
}`)
    .replace('#include <begin_vertex>', 'vec3 transformed = tirePos;');
  if (!depth) sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vTireR;\nvarying vec2 vTireWall;\nuniform float uTireDust;\n' + WALL_GLSL)
    .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${DUST.join(', ')}), uTireDust * (0.3 + 0.7 * smoothstep(0.25, 1.0, vTireR)));
{
  float ridge = ${RINGS.map(r => `tireRing(${r.toFixed(3)}, 0.016)`).join(' + ')};
  float groove = ${RINGS.map(r => `tireRing(${(r + 0.04).toFixed(3)}, 0.013)`).join(' + ')};
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.25 + vec3(0.035, 0.032, 0.028), min(ridge, 1.0) * vTireWall.x);
  diffuseColor.rgb *= 1.0 - 0.45 * min(groove, 1.0) * vTireWall.x;
}`)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  float upper = smoothstep(0.02, 0.3, vTireR) * (1.0 - smoothstep(0.36, 0.56, vTireR));
  float under = smoothstep(0.5, 0.78, vTireR);
  float k = max(1.0 + vTireWall.y * (1.5 * upper - 0.72 * under), 0.0);
  reflectedLight.indirectDiffuse *= k; reflectedLight.indirectSpecular *= k;
  reflectedLight.directDiffuse *= 1.0 - 0.35 * vTireWall.y * under;
}`);
}

// base: a material to copy (an imported tyre's own) or a texture for a plain rubber material
export function createTireMaterial(base) {
  const mat = base?.isMaterial ? base.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff, map: base || null, roughness: 0.78, metalness: 0.0 });
  const uniforms = {
    uProf: { value: new Float32Array(NR * NF) },
    uSpin: { value: 0 },
    uToWheel: { value: new THREE.Matrix4() },
    uFromWheel: { value: new THREE.Matrix4() },
    uR: { value: 0.42 },
    uRim: { value: 0.205 },
    uHalfW: { value: 0.135 },
    uTireDust: TIRE_DUST,
  };
  mat.userData.uniforms = uniforms;
  // an imported tyre keeps its own material patch (shell.js realBlack); clone() doesn't copy it
  const own = base?.isMaterial && base.userData.realBlack ? base.onBeforeCompile : null;
  mat.onBeforeCompile = sh => { own?.(sh); patch(sh, uniforms); };
  mat.customProgramCacheKey = () => own ? 'tire-deform-v4-real-black' : 'tire-deform-v4';
  // the shadow of the squashed tyre: same deformation in the depth pass (shares the uniforms)
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = sh => patch(sh, uniforms, true);
  depth.customProgramCacheKey = () => 'tire-deform-depth-v4';
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
