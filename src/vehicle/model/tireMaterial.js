import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, uniformArray, texture, vec2, vec3, vec4, float, int, positionGeometry, materialColor,
  cos, sin, atan, length, floor, clamp, smoothstep, select, sign, mix, max, min,
} from 'three/tsl';
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
// live: angle 0 points straight down, + towards the front (-z). The shadow pass uses the same positionNode,
// so the shadow is the squashed tyre too.

const NF = TIRE_FAN.length, NR = TIRE_ROWS.length;
const FAN0 = TIRE_FAN[0], FANSTEP = TIRE_FAN[1] - TIRE_FAN[0];

function deformNode(U) {
  const prof = (row, fk) => {
    const k0 = int(floor(fk));
    const t = fk.sub(floor(fk));
    const at = k => select(k.greaterThanEqual(0).and(k.lessThan(NF)), U.uProf.element(clamp(k, 0, NF - 1).add(row * NF)), float(0));
    return mix(at(k0), at(k0.add(1)), t);
  };
  return Fn(() => {
    const pos = positionGeometry;
    const out = pos.toVar();
    const p = U.uToWheel.mul(vec4(pos, 1.0)).xyz;
    const cs = cos(U.uSpin), sn = sin(U.uSpin);
    // spinning wheel frame -> steering frame: the wheel group is turned by -spin about x, so rotate by -spin
    const q = vec3(p.x, cs.mul(p.y).add(sn.mul(p.z)), sn.negate().mul(p.y).add(cs.mul(p.z))).toVar();
    const r = length(q.yz);
    If(r.greaterThan(U.uRim), () => {
      const th = atan(q.z.negate(), q.y.negate());
      const fk = th.sub(FAN0).div(FANSTEP);
      // rows across the tread at x = -o, 0, +o (o = row offset x width), clamped at the outer rows
      const xr = clamp(q.x.div(U.uHalfW.mul(2 * TIRE_ROW_OFFSET)), -1.0, 1.0);
      const d = select(xr.lessThan(0.0), mix(prof(1, fk), prof(0, fk), xr.negate()), mix(prof(1, fk), prof(2, fk), xr));
      If(d.greaterThan(0.0), () => {
        // the carcass moves in by the intrusion (fading out down the sidewall towards the rim)
        const w = smoothstep(U.uRim.add(U.uR.mul(0.02)), U.uRim.add(U.uR.sub(U.uRim).mul(0.55)), r);
        const dir = q.yz.div(r);
        q.y.subAssign(dir.x.mul(d).mul(w));
        q.z.subAssign(dir.y.mul(d).mul(w));
        // sidewall bulge next to the patch (the squeezed air and carcass go sideways)
        const side = smoothstep(0.45, 0.95, q.x.abs().div(U.uHalfW));
        const wall = float(1).sub(smoothstep(U.uR.sub(U.uR.sub(U.uRim).mul(0.25)), U.uR, r));
        const bulge = d.mul(0.45).mul(side).mul(wall.mul(0.65).add(0.35)).mul(smoothstep(U.uRim, U.uRim.add(U.uR.sub(U.uRim).mul(0.3)), r));
        q.x.addAssign(sign(q.x).mul(bulge));
        // back to the spinning frame and to object space
        const pw = vec3(q.x, cs.mul(q.y).sub(sn.mul(q.z)), sn.mul(q.y).add(cs.mul(q.z)));
        out.assign(U.uFromWheel.mul(vec4(pw, 1.0)).xyz);
      });
    });
    return out;
  })();
}

// base: a material to copy (an imported tyre's own) or a texture for a plain rubber material
export function createTireMaterial(base) {
  let mat;
  if (base?.isMaterial) {
    mat = new THREE.MeshStandardNodeMaterial();
    for (const k of ['color', 'map', 'normalMap', 'roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'aoMap', 'aoMapIntensity', 'side', 'vertexColors', 'name', 'colorNode', 'metalnessNode']) if (base[k] !== undefined) mat[k] = base[k]?.isColor ? base[k].clone() : base[k];
  } else mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, map: base || null, roughness: 0.86, metalness: 0.0 });
  const U = {
    uProf: uniformArray(new Array(NR * NF).fill(0), 'float'),
    uSpin: uniform(0),
    uToWheel: uniform(new THREE.Matrix4()),
    uFromWheel: uniform(new THREE.Matrix4()),
    uR: uniform(0.42),
    uRim: uniform(0.205),
    uHalfW: uniform(0.135),
  };
  mat.userData.uniforms = U;
  // the same deformation runs in the shadow pass (positionNode), so the shadow is the squashed tyre too
  mat.positionNode = deformNode(U);
  return mat;
}

// Use it on a mesh inside a wheel's spin group: toWheel = the mesh's matrix relative to the spin group
// (axle along x, unscaled), R / rim / width in those units.
export function makeTireMesh(mesh, mat, { toWheel = null, R, rim, width }) {
  const u = mat.userData.uniforms;
  if (toWheel) { u.uToWheel.value.copy(toWheel); u.uFromWheel.value.copy(toWheel).invert(); }
  u.uR.value = R; u.uRim.value = rim; u.uHalfW.value = width / 2;
  mesh.material = mat;
  // tyres merged without uv (Defender): wrap the rubber texture round the tread from the position
  if (mat.map && !mesh.geometry.getAttribute('uv')) {
    const p = positionGeometry;
    mat.colorNode = materialColor.mul(texture(mat.map, vec2(atan(p.z, p.y).mul(1.6), p.x.mul(4.0))));
    mat.map = null;   // (the shadow pass would sample it with the missing uv)
  }
  return mesh;
}

// Fill the table from a physics wheel. scale: physics metres -> wheel units (1 / the wheel group's radial
// scale). Wheels without per-ray data (friends' trucks over the network) get the patch of their contact
// plane: intrusion R - h / cos(angle - tilt).
export function setTireContact(mat, w, R, scale, spin) {
  const u = mat.userData.uniforms, out = u.uProf.array;
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
