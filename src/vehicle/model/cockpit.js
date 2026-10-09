import * as THREE from 'three';

// The moving parts of a cabin, driven by the physics: steering wheel, gauge needles (speed, rpm, fuel,
// temperature), gear lever (an H pattern, or the selector) and transfer lever (high / low). Every part is
// optional: a model without gauges just has none.
//
// A procedural cabin hands its parts in directly (defender/interior.js). A downloaded model names its nodes
// in the car's look.cockpit: { steeringWheel, gearLever, transferLever }; each turns about the axis that
// follows from its own geometry (pivotFromNode).

const _v = new THREE.Vector3();
const dialRot = f => Math.PI * 0.75 - Math.PI * 1.5 * Math.min(Math.max(f, 0), 1.03);

export function cockpitKit(parts) {
  let temp = 0.2;
  return {
    ...parts,
    update(view, v, dt) {
      const P = v.P, d = v.drivetrain;
      if (parts.steeringWheel) parts.steeringWheel.rotation.z = -v.steerAngle * P.steer.ratio;
      const n = parts.needles;
      if (n) {
        const kmh = Math.abs(v.speed) * 3.6;
        if (n.speed) n.speed.rotation.z = dialRot(kmh / 160);
        if (n.rpm) n.rpm.rotation.z = dialRot(Math.max(0, d.rpm) / 6000);
        if (n.fuel) n.fuel.rotation.z = dialRot(0.72);
        if (n.temp) {
          temp += ((d.running ? 0.52 : 0.2) - temp) * Math.min(1, dt * 0.05);
          n.temp.rotation.z = dialRot(temp);
        }
      }
      if (parts.gearLever) {
        const gl = d.mode === 'manual' ? d.manualGear : ({ P: -2, R: -1, N: 0, D: 1 })[d.selector] ?? 0;
        const col = gl === 0 ? 0 : gl < 0 ? -1 : Math.ceil(gl / 2) - 1;
        const row = gl === 0 ? 0 : gl < 0 ? -1 : (gl % 2 === 1 ? -1 : 1);
        parts.gearLever.rotation.set(row * 0.25, 0, -col * 0.18);
      }
      if (parts.transferLever) parts.transferLever.rotation.x = d.range === 'low' ? 0.35 : -0.15;
    },
  };
}

// A part of a downloaded model as a pivot: a group at the part's centre whose local z is the part's thin
// axis (a steering wheel's column), pointing towards `towards` (the driver's eye), with the part's meshes
// in it. `base`: pivot at the bottom of the part instead of its centre (a lever).
export function pivotFromNode(node, parent, towards, { base = false } = {}) {
  node.updateMatrixWorld(true);
  const pts = [];
  node.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 2000))) pts.push(_v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone());
  });
  const box = new THREE.Box3().setFromPoints(pts);
  const c = box.getCenter(new THREE.Vector3());
  if (base) c.y = box.min.y;
  const axis = base ? new THREE.Vector3(1, 0, 0) : thinAxis(pts, box.getCenter(new THREE.Vector3()));
  if (towards && axis.dot(_v.subVectors(towards, c)) < 0) axis.negate();
  // pivot: at the centre, local z along the axis (in `parent`'s frame, which the node's world matrices are in);
  // turn: its child, so turn.rotation.z turns the part about the axis (cockpitKit sets it)
  const pivot = new THREE.Group(), turn = new THREE.Group();
  pivot.position.copy(c);
  pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  pivot.updateMatrix();
  const inv = pivot.matrix.clone().invert();
  const meshes = [];
  node.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const m = new THREE.Mesh(o.geometry, o.material);
    m.matrixAutoUpdate = false;
    m.matrix.multiplyMatrices(inv, o.matrixWorld);
    m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow;
    turn.add(m);
  }
  node.removeFromParent();
  pivot.add(turn);
  parent.add(pivot);
  return turn;
}

// the direction of least spread of a point cloud (smallest eigenvector of its covariance)
function thinAxis(pts, c) {
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] += d[i] * d[j];
  }
  // inverse iteration on C + eps: converges to the smallest eigenvalue's vector
  const M = new THREE.Matrix3().fromArray(C).transpose();
  const tr = C[0] + C[4] + C[8];
  for (let i = 0; i < 3; i++) M.elements[4 * i] += 1e-9 * tr;
  const inv = M.clone().invert();
  const x = new THREE.Vector3(0.3, 0.5, 0.8);
  for (let k = 0; k < 40; k++) x.applyMatrix3(inv).normalize();
  return x;
}
