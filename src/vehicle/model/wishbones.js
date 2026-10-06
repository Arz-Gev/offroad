import * as THREE from 'three/webgpu';
import { cornerName } from '../suspension.js';

// Running gear of an independent corner with double wishbones, made of the model's own parts (tools/
// prepcar.mjs `parts` cuts them out of the hull per corner): armLow_k / armUp_k (they may have two legs)
// pivot on the hull's inner shafts and reach for the ball joints; barLow_k / barUp_k (the ball joints)
// follow the knuckle; shockEyeUp_k + shockBody_k turn about the top mount on the hull, shockRod_k +
// shockEyeLo_k ride on the upper arm and telescope out of the body. A knuckle (a post between the ball
// joints and a stub axle out to the wheel) is ours, in the wheel's steer group. Everything moves in the
// corner's cross plane (x-y of the body frame), driven by the physics: compression, camber and lateral path.
//
// spec (the car's look.suspension): { parts: 'wishbones', pivotLow, pivotUp } – the arms' inner pivots
// [x, y] in the model's hub frame (y 0 at the static hub), mirrored to both sides. A part a model doesn't
// have is skipped.

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const PARTS = ['armLow', 'armUp', 'barLow', 'barUp', 'shockEyeLo', 'shockRod', 'shockBody', 'shockEyeUp'];

// Build the corners of every independent axle. take(node, group, at): move a node's meshes into group,
// placed relative to `at` (body frame). hubY: the static hub height the hub frame is measured from.
export function wishboneCorners(root, shell, P, wheels, spec, take, hubY) {
  const knuckleMat = new THREE.MeshStandardMaterial({ color: 0x1c211b, roughness: 0.7, metalness: 0.35 });
  const knuckleGeo = new THREE.BoxGeometry(0.07, 1, 0.12), stubGeo = new THREE.CylinderGeometry(0.075, 0.09, 1, 14).rotateZ(Math.PI / 2);
  const nA = P.axles.length, corners = [];
  for (const w of wheels) {
    if (P.axles[w.axle].type !== 'independent') continue;
    const k = cornerName(w.axle, w.side, nA), side = w.side, z = P.axles[w.axle].z;
    const part = name => {
      const node = shell.getObjectByName(name + '_' + k);
      if (!node) return null;
      const centre = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      take(node, grp, new THREE.Vector3());
      root.add(grp);
      grp.updateMatrixWorld(true);   // the meshes carry their place in their matrix: world matrices before measuring
      return { grp, centre, box: new THREE.Box3().setFromObject(grp) };
    };
    const p = Object.fromEntries(PARTS.map(n => [n, part(n)]));
    if (!p.armLow || !p.armUp || !p.barLow || !p.barUp) continue;   // not a wishbone corner in this model
    const hubFrame = (q, s) => new THREE.Vector3(s * q[0], q[1] + hubY, z);
    const hub0 = w.steer.position.clone();
    const cr = { k, axle: w.axle, wheel: wheels.indexOf(w), side, ...p,
      pivLow: hubFrame(spec.pivotLow, side), pivUp: hubFrame(spec.pivotUp, side), hub0,
      ballLow0: p.barLow.centre.clone(), ballUp0: p.barUp.centre.clone() };
    if (p.shockEyeLo && p.shockEyeUp && p.shockRod && p.shockBody) {
      cr.lowEye0 = p.shockEyeLo.centre.clone(); cr.topEye = p.shockEyeUp.centre.clone();
      // rod: from just above the lower eye to 1.3 cm into the shock body (static)
      cr.rod0 = { lo: p.shockRod.box.min.y, hi: p.shockRod.box.max.y, bodyLo: p.shockBody.box.min.y };
    }
    // our knuckle: a post between the ball joints and a stub axle out to the wheel, in the steer group
    // (it turns with camber and steering about the hub), sized from the static ball joints
    const kn = new THREE.Group();
    const post = new THREE.Mesh(knuckleGeo, knuckleMat), stub = new THREE.Mesh(stubGeo, knuckleMat);
    const bl = cr.ballLow0.clone().sub(hub0), bu = cr.ballUp0.clone().sub(hub0);
    post.position.set((bl.x + bu.x) / 2 + side * 0.02, (bl.y + bu.y) / 2, 0);
    post.scale.y = bu.y - bl.y + 0.06;
    const inner = (bl.x + bu.x) / 2 + side * 0.04, outer = side * 0.06;
    stub.position.set((inner + outer) / 2, 0, 0); stub.scale.x = Math.abs(outer - inner);
    for (const m of [post, stub]) { m.castShadow = true; m.receiveShadow = true; kn.add(m); }
    w.steer.add(kn);
    cr.knuckle = kn;
    corners.push(cr);
  }
  return { corners, update: (view, v) => updateCorners(corners, v) };
}

// arm: rotate about the pivot (z axis) so the outer end points at the ball joint, and stretch along the arm
// to reach it (a model's arms may hang steeply; the physics' wheel path is a design curve, not their arc)
function armMatrix(out, piv, ball0, ball) {
  const a0 = Math.atan2(ball0.y - piv.y, ball0.x - piv.x), a1 = Math.atan2(ball.y - piv.y, ball.x - piv.x);
  const k = Math.hypot(ball.x - piv.x, ball.y - piv.y) / Math.hypot(ball0.x - piv.x, ball0.y - piv.y);
  // T(piv) Rz(a1) S(k along the arm) Rz(-a0) T(-piv)
  out.makeTranslation(-piv.x, -piv.y, 0);
  out.premultiply(_m2.makeRotationZ(-a0));
  out.premultiply(_m2.makeScale(k, 1, 1));
  out.premultiply(_m2.makeRotationZ(a1));
  out.premultiply(_m2.makeTranslation(piv.x, piv.y, 0));
  return out;
}

const _bl = new THREE.Vector3(), _bu = new THREE.Vector3(), _hub = new THREE.Vector3(), _le = new THREE.Vector3(), _d = new THREE.Vector3();
const _mUp = new THREE.Matrix4();
function updateCorners(corners, v) {
  const P = v.P;
  for (const cr of corners) {
    const w = v.wheels[cr.wheel], ax = v.axles[cr.axle];
    // the hub where the physics has it (body frame), the knuckle's ball joints rigid with it (camber)
    _hub.set(cr.side * (P.track / 2 + (w.out || 0)), ax.droopY + w.c, P.axles[cr.axle].z);
    const cam = -cr.side * (w.camber || 0), cs = Math.cos(cam), sn = Math.sin(cam);
    const ball = (b0, out) => {
      const x = b0.x - cr.hub0.x, y = b0.y - cr.hub0.y;
      return out.set(_hub.x + cs * x - sn * y, _hub.y + sn * x + cs * y, b0.z);
    };
    ball(cr.ballLow0, _bl); ball(cr.ballUp0, _bu);
    armMatrix(cr.armLow.grp.matrix, cr.pivLow, cr.ballLow0, _bl);
    armMatrix(_mUp, cr.pivUp, cr.ballUp0, _bu);
    cr.armUp.grp.matrix.copy(_mUp);
    cr.barLow.grp.matrix.makeTranslation(_bl.x - cr.ballLow0.x, _bl.y - cr.ballLow0.y, 0);
    cr.barUp.grp.matrix.makeTranslation(_bu.x - cr.ballUp0.x, _bu.y - cr.ballUp0.y, 0);
    if (!cr.rod0) continue;
    // shock: the lower eye rides on the upper arm, the top eye is on the hull
    _le.copy(cr.lowEye0).applyMatrix4(_mUp);
    cr.shockEyeLo.grp.matrix.makeTranslation(_le.x - cr.lowEye0.x, _le.y - cr.lowEye0.y, 0);
    const _d0x = cr.topEye.x - cr.lowEye0.x, _d0y = cr.topEye.y - cr.lowEye0.y;
    _d.subVectors(cr.topEye, _le); const len = Math.hypot(_d.x, _d.y);
    const turn = Math.atan2(_d.y, _d.x) - Math.atan2(_d0y, _d0x);
    // body + top eye: turn about the top eye
    const T = cr.topEye;
    cr.shockBody.grp.matrix.makeTranslation(-T.x, -T.y, 0).premultiply(_m2.makeRotationZ(turn)).premultiply(_m.makeTranslation(T.x, T.y, 0));
    cr.shockEyeUp.grp.matrix.copy(cr.shockBody.grp.matrix);
    // rod: from the lower eye, turned with the shock and stretched so its top stays inside the body
    const r0 = cr.rod0, base0 = r0.lo - cr.lowEye0.y, top0 = r0.hi - cr.lowEye0.y;   // along the static axis (vertical)
    const topNow = len - (cr.topEye.y - r0.bodyLo) + (r0.hi - r0.bodyLo);            // distance eye -> rod top now
    const k = Math.max(0.2, (topNow - base0) / (top0 - base0));
    cr.shockRod.grp.matrix.makeTranslation(-cr.lowEye0.x, -cr.lowEye0.y - base0, 0)
      .premultiply(_m2.makeScale(1, k, 1))
      .premultiply(_m2.makeTranslation(0, base0, 0))
      .premultiply(_m2.makeRotationZ(turn))
      .premultiply(_m2.makeTranslation(_le.x, _le.y, 0));
  }
}
