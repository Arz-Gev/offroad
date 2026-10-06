import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildLightRig } from './truckLights.js';
import { createTireMaterial, makeTireMesh } from './tireMaterial.js';
import { makeCarParams } from './carParams.js';
import { staticRide } from './tuning.js';

// The BTR-80 model (public/models/btr80.glb, made by tools/prepcar.mjs from Goga.Danelia's BTR 80, CC BY):
// the hull, 8 wheels on independent corners, the model's own suspension, and the turret.
//
// Wheels: tire_<k> (deforms with the contact data, tyre v2), wheel_<k> (rim) and hub_<k> (the tyre
// inflation valve on the rim face, spins) mounted on the physics hubs. Each group sits at its own measured
// hub centre in the file, so the model's wheels (5.6 cm off to one side) are re-centred.
//
// Suspension, per corner k (split off the hull by prepcar): armLow_k / armUp_k (two legs each) pivot on
// the hull's inner pivot shafts and reach for the ball joints; barLow_k / barUp_k (the arms' outer
// cross-tubes = the ball joints) follow the knuckle; shockEyeUp_k + shockBody_k turn about the top mount on
// the hull, shockRod_k + shockEyeLo_k ride on the upper arm and telescope out of the body (axles 1 and 4
// have two shocks per wheel, 2 and 3 one, as on the real BTR-80). The knuckle (vertical post between the
// ball joints and the stub axle to the wheel) is ours: the file has none. All of it moves in the corner's
// cross plane (x-y of the body frame), driven by the physics: compression, camber and lateral path.
//
// Turret: BTR_80_B (yaw about the ring), BTR_80_C (gun cradle: KPVT box, coaxial PKT, searchlight, pitch
// about the trunnions), LULA (the barrel, recoils in the cradle), BTR_80_E (case chute, moves with the gun).

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);

// hub-frame points of the model (metres, y = 0 at the mean hub height in the file, both sides mirrored):
// the hull's inner pivot shafts of the lower and upper arms (prepcar can't split them: they are the hull)
const PIVOT_LOW = [0.600, -0.006], PIVOT_UP = [0.600, 0.190];
// turret ring centre, trunnion axis, barrel tip, coaxial PKT muzzle, searchlight (hub frame)
const TURRET = [-0.018, 1.257, -1.044], TRUNNION = [-0.023, 1.761, -0.95];
const MUZZLE = [-0.023, 1.760, -3.04], PKT_MUZZLE = [0.429, 1.866, -1.32], SEARCHLIGHT = [0.20, 2.03, -0.95];

export async function buildBtr(id, c) {
  const P = makeCarParams(id);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + c.url);
  const shell = gltf.scene;
  shell.name = 'shell';
  const root = new THREE.Group();
  root.name = 'truck';
  const body = new THREE.Group();
  root.add(body);
  // the hull at the static hub height (a slight pitch if the axles' static hubs differ)
  const ride = staticRide(P);
  const nA = P.axles.length, zf = P.axles[0].z, zl = P.axles[nA - 1].z;
  const hubY = ride.reduce((s, r) => s + r.hubY, 0) / nA;
  shell.position.y = hubY;
  shell.rotation.x = Math.asin((ride[0].hubY - ride[nA - 1].hubY) / (zl - zf));
  body.add(shell);
  shell.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const m = o.material;
    if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.35); }
    if (m.transparent) { o.castShadow = false; m.depthWrite = false; }
  });
  root.updateMatrixWorld(true);
  const hubFrame = (p, side = 1) => new THREE.Vector3(side * p[0], p[1] + hubY, p[2]);   // hub frame -> body frame (level)

  // move a node's meshes into a new group, keeping where they are: the group sits at `at` (body frame)
  const take = (node, group, at) => {
    const meshes = [];
    node.updateMatrixWorld(true);
    _m.makeTranslation(-at.x, -at.y, -at.z);
    node.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const o of meshes) {
      const m = new THREE.Mesh(o.geometry, o.material);
      m.matrixAutoUpdate = false;
      m.matrix.multiplyMatrices(_m, o.matrixWorld);
      m.castShadow = true; m.receiveShadow = true; m.name = o.name;
      group.add(m);
    }
    node.removeFromParent();
    return meshes.length;
  };
  const centreOf = node => new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());

  // ---------------- wheels: steer (position, camber, steer) > spin (rolls; scaled by the view) > parts
  const s = { x: 0.27 / c.wheel.width, r: 0.42 / c.wheel.R };   // VehicleView scales spin by (width / 0.27, R / 0.42)
  const wheels = [], corners = [];
  for (let a = 0; a < nA; a++) for (const side of [-1, 1]) {
    const k = `${a + 1}${side < 0 ? 'L' : 'R'}`;
    const ap = P.axles[a];
    const steer = new THREE.Group(), spin = new THREE.Group(), g = new THREE.Group();
    steer.position.set(side * P.track / 2, ride[a].hubY, ap.z);
    steer.add(spin); spin.add(g); root.add(steer);
    g.scale.set(s.x, s.r, s.r);
    const tireNode = shell.getObjectByName('tire_' + k);
    const at = tireNode.getWorldPosition(new THREE.Vector3());   // the measured hub centre (holder node)
    let tire = null, tireMat = null;
    for (const name of ['tire_', 'wheel_', 'hub_']) {
      const node = shell.getObjectByName(name + k);
      if (!node) continue;
      const before = g.children.length;
      take(node, g, at);
      if (name === 'tire_') for (const m of g.children.slice(before)) {
        tireMat = createTireMaterial(m.material);
        makeTireMesh(m, tireMat, { toWheel: m.matrix, R: c.wheel.R, rim: 0.24, width: c.wheel.width });
        tire = m;
      }
    }
    wheels.push({ steer, spin, tire, tireMat, rim: g, side, axle: a, tireUnits: 0.42 / c.wheel.R });
    corners.push({ k, a, side });
  }

  // ---------------- suspension parts (body frame, moved each frame by matrix)
  const knuckleMat = new THREE.MeshStandardMaterial({ color: 0x1c211b, roughness: 0.7, metalness: 0.35 });
  const knuckleGeo = new THREE.BoxGeometry(0.07, 1, 0.12), stubGeo = new THREE.CylinderGeometry(0.075, 0.09, 1, 14).rotateZ(Math.PI / 2);
  for (const cr of corners) {
    const { k, side } = cr;
    const part = name => {
      const node = shell.getObjectByName(name + '_' + k);
      if (!node) return null;
      const centre = centreOf(node);
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      take(node, grp, new THREE.Vector3());
      root.add(grp);
      grp.updateMatrixWorld(true);   // the meshes carry their place in their matrix: world matrices before measuring
      return { grp, centre, box: new THREE.Box3().setFromObject(grp) };
    };
    const armLow = part('armLow'), armUp = part('armUp'), barLow = part('barLow'), barUp = part('barUp');
    const eyeLo = part('shockEyeLo'), rod = part('shockRod'), sbody = part('shockBody'), eyeUp = part('shockEyeUp');
    const z = P.axles[cr.a].z;
    const pivLow = hubFrame(PIVOT_LOW, side).setZ(z), pivUp = hubFrame(PIVOT_UP, side).setZ(z);
    const hub0 = wheels[corners.indexOf(cr)].steer.position.clone();
    Object.assign(cr, {
      armLow, armUp, barLow, barUp, eyeLo, rod, sbody, eyeUp, pivLow, pivUp, hub0,
      ballLow0: barLow.centre.clone(), ballUp0: barUp.centre.clone(),
      lowEye0: eyeLo.centre.clone(), topEye: eyeUp.centre.clone(),
    });
    // rod: from just above the lower eye to 1.3 cm into the shock body (static)
    cr.rod0 = { lo: rod.box.min.y, hi: rod.box.max.y, bodyLo: sbody.box.min.y };
    // our knuckle: a post between the ball joints and a stub axle out to the wheel, in the steer group
    // (it turns with camber and steering about the hub), sized from the static ball joints
    const w = wheels[corners.indexOf(cr)];
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
  }

  // ---------------- turret: yaw > pitch (cradle, chute) > recoil (barrel)
  const yaw = new THREE.Group(), pitch = new THREE.Group(), recoil = new THREE.Group();
  const ringAt = hubFrame(TURRET), trunAt = hubFrame(TRUNNION);
  yaw.position.copy(ringAt);
  pitch.position.copy(trunAt).sub(ringAt);
  root.add(yaw); yaw.add(pitch); pitch.add(recoil);
  const turretNode = shell.getObjectByName('BTR_80_B_Baked002');
  const cradleNode = shell.getObjectByName('BTR_80_C_Baked002');
  const barrelNode = shell.getObjectByName('LULA_Baked002');
  const chuteNode = shell.getObjectByName('BTR_80_E_Baked002');
  take(barrelNode, recoil, trunAt);
  take(chuteNode, pitch, trunAt);
  take(cradleNode, pitch, trunAt);
  take(turretNode, yaw, ringAt);
  const muzzle = new THREE.Object3D(); muzzle.position.copy(hubFrame(MUZZLE)).sub(trunAt); recoil.add(muzzle);
  const pktMuzzle = new THREE.Object3D(); pktMuzzle.position.copy(hubFrame(PKT_MUZZLE)).sub(trunAt); pitch.add(pktMuzzle);
  const lampAt = new THREE.Object3D(); lampAt.position.copy(hubFrame(SEARCHLIGHT)).sub(trunAt); pitch.add(lampAt);
  // gunner's sight (PP-61AM periscope): its head on the turret roof left of the cradle, fixed in the turret;
  // its mirror follows the gun (the camera takes the gun's pitch, cameraRig.js)
  const sight = new THREE.Object3D(); sight.position.set(-0.32, 0.77, -0.15); yaw.add(sight);

  // ---------------- lamps: our beams, the model's lenses glow
  const lights = buildLightRig(root, { head: c.lamps.head, bar: c.lamps.bar, rear: c.lamps.rear });
  const lens = re => { let mat = null; shell.traverse(o => { if (o.isMesh && re.test(o.material.name)) { if (!mat) { mat = o.material.clone(); mat.emissive = new THREE.Color(1, 1, 1); mat.emissiveIntensity = 0; } o.material = mat; } }); return mat; };
  const dummy = () => ({ emissiveIntensity: 0 });
  const head = lens(/^Headlights/), amber = lens(/Blinkers_Yellow/), red = lens(/Blinkers_Red/);
  if (amber) amber.emissive.setRGB(1, 0.55, 0.1);
  if (red) red.emissive.setRGB(1, 0.1, 0.05);
  const mats = { headLens: head || dummy(), sideLens: dummy(), barLens: dummy(), workLens: dummy(), tail: red || dummy(), brake: red || dummy(),
    reverse: dummy(), amber: amber || dummy(), beacon: dummy() };

  root.traverse(o => { if (o.isMesh) o.frustumCulled = true; });
  const model = {
    kind: 'btr', root, body, shell, wheels, mats, lights,
    driverEye: new THREE.Vector3(...c.eye), hoodEye: new THREE.Vector3(...c.hoodEye),
    chaseDist: c.chase?.dist, chaseTarget: c.chase?.target,
    turret: { yaw, pitch, recoil, muzzle, pktMuzzle, sight, lampAt },
    rig: { corners, update: (view, v) => updateRig(model, view, v) },
  };
  return model;
}

// ---------------------------------------------------------------- per frame: suspension in the corners' planes
// arm: rotate about the pivot (z axis) so the outer end points at the ball joint, and stretch along the arm
// to reach it (the model's arms hang steeply; the physics' wheel path is a design curve, not their arc)
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

const _bl = new THREE.Vector3(), _bu = new THREE.Vector3(), _hub = new THREE.Vector3(), _le = new THREE.Vector3(), _d = new THREE.Vector3(), _d0 = new THREE.Vector3();
const _mUp = new THREE.Matrix4();
function updateRig(model, view, v) {
  const P = v.P;
  // turret: yaw + = right (seen from above, clockwise), pitch + = up, recoil (m) slides the barrel back
  const T = v.turret, M = model.turret;
  if (T && M) {
    M.yaw.rotation.y = -T.yaw;
    M.pitch.rotation.x = T.pitch;
    M.recoil.position.z = T.recoil || 0;
  }
  for (let i = 0; i < model.rig.corners.length; i++) {
    const cr = model.rig.corners[i], w = v.wheels[i], ax = v.axles[cr.a];
    // the hub where the physics has it (body frame), the knuckle's ball joints rigid with it (camber)
    _hub.set(cr.side * (P.track / 2 + (w.out || 0)), ax.droopY + w.c, P.axles[cr.a].z);
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
    // shock: the lower eye rides on the upper arm, the top eye is on the hull
    _le.copy(cr.lowEye0).applyMatrix4(_mUp);
    cr.eyeLo.grp.matrix.makeTranslation(_le.x - cr.lowEye0.x, _le.y - cr.lowEye0.y, 0);
    _d0.subVectors(cr.topEye, cr.lowEye0); const len0 = Math.hypot(_d0.x, _d0.y);
    _d.subVectors(cr.topEye, _le); const len = Math.hypot(_d.x, _d.y);
    const turn = Math.atan2(_d.y, _d.x) - Math.atan2(_d0.y, _d0.x);
    // body + top eye: turn about the top eye
    const T = cr.topEye;
    cr.sbody.grp.matrix.makeTranslation(-T.x, -T.y, 0).premultiply(_m2.makeRotationZ(turn)).premultiply(_m.makeTranslation(T.x, T.y, 0));
    cr.eyeUp.grp.matrix.copy(cr.sbody.grp.matrix);
    // rod: from the lower eye, turned with the shock and stretched so its top stays inside the body
    const r0 = cr.rod0, base0 = r0.lo - cr.lowEye0.y, top0 = r0.hi - cr.lowEye0.y;   // along the static axis (vertical)
    const topNow = len - (cr.topEye.y - r0.bodyLo) + (r0.hi - r0.bodyLo);            // distance eye -> rod top now
    const k = Math.max(0.2, (topNow - base0) / (top0 - base0));
    const m = cr.rod.grp.matrix;
    m.makeTranslation(-cr.lowEye0.x, -cr.lowEye0.y - base0, 0)
      .premultiply(_m2.makeScale(1, k, 1))
      .premultiply(_m2.makeTranslation(0, base0, 0))
      .premultiply(_m2.makeRotationZ(turn))
      .premultiply(_m2.makeTranslation(_le.x, _le.y, 0));
    void len0;
  }
}
