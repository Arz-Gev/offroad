import * as THREE from 'three';
import { mesh } from './geom.js';
import { coilGeometry } from './beamAxle.js';

// Running gear of an independent corner drawn by us, for a model that has no suspension parts of its own:
// double wishbones (an upper and a lower arm, a coil-over on the lower arm) or a MacPherson strut (a lower
// arm and a strut from the knuckle up to a tower), by the axle's physics `linkage` ('wishbones' default,
// 'strut'). The knuckle and its ball joints turn with the wheel (camber, steer); the arms reach from their
// pivots on the body to the ball joints; a driven corner gets a drive shaft from the body-mounted diff.
// The proportions follow the track and the tyre: a sketch of the layout, not the car's own parts.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _hub = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// a member between two points (body frame): a unit cylinder / box along y, stretched and turned
function stretch(o, a, b) {
  const d = _v2.subVectors(b, a), len = Math.max(0.01, d.length());
  o.position.copy(a).addScaledVector(d, 0.5);
  o.scale.y = len;
  o.quaternion.setFromUnitVectors(Y, d.divideScalar(len));
}

export function independentCorners(root, mats, P, wheels, ride, skip = new Set()) {
  const corners = [];
  const unitBox = (w, d, mat) => mesh(new THREE.BoxGeometry(w, 1, d), mat);
  const unitCyl = (r, mat, seg = 10) => mesh(new THREE.CylinderGeometry(r, r, 1, seg), mat);
  for (const w of wheels) {
    const ap = P.axles[w.axle];
    if (ap.type !== 'independent' || skip.has(w)) continue;
    const s = w.side, R = P.tire.radius, h0 = ride[w.axle].hubY, t2 = P.track / 2, z = ap.z;
    const strut = ap.linkage === 'strut';
    // ball joints in the knuckle frame (from the hub), inner pivots and mounts on the body (body frame)
    const lowJ = new THREE.Vector3(-s * 0.10 * R / 0.42, -0.13 * R / 0.42, 0);
    const upJ = new THREE.Vector3(-s * 0.13 * R / 0.42, (strut ? 0.30 : 0.15) * R / 0.42, 0);
    const lowPivot = new THREE.Vector3(s * Math.max(0.12, t2 - 0.10 - 0.36 * t2 / 0.78), h0 - 0.11 * R / 0.42, z);
    const upPivot = new THREE.Vector3(s * Math.max(0.12, t2 - 0.13 - 0.28 * t2 / 0.78), h0 + 0.18 * R / 0.42, z);
    const tower = new THREE.Vector3(s * (t2 - (strut ? 0.20 : 0.30) * t2 / 0.78), h0 + 0.55 * R / 0.42, z);
    const parts = { lowArm: unitBox(0.05, 0.16, mats.chassis), upArm: strut ? null : unitBox(0.04, 0.12, mats.chassis),
      coil: mesh(coilGeometry(0.06, 0.011, 6), mats.blackMetal), damper: unitCyl(0.025, mats.yellow),
      shaft: ap.driven === false ? null : unitCyl(0.022, mats.zinc) };
    for (const o of Object.values(parts)) if (o) root.add(o);
    // the knuckle rides in the wheel's steer group: a post between the ball joints and a stub to the hub
    const kn = new THREE.Group();
    const post = mesh(new THREE.BoxGeometry(0.05, 1, 0.09), mats.chassis);
    post.position.set((lowJ.x + upJ.x) / 2, (lowJ.y + upJ.y) / 2, 0); post.scale.y = upJ.y - lowJ.y + 0.04;
    const stub = mesh(new THREE.CylinderGeometry(0.05, 0.06, 1, 12).rotateZ(Math.PI / 2), mats.chassis);
    stub.position.set((lowJ.x + upJ.x) / 4, 0, 0); stub.scale.x = Math.abs(lowJ.x + upJ.x) / 2 + 0.04;
    kn.add(post, stub);
    w.steer.add(kn);
    corners.push({ w, wi: wheels.indexOf(w), s, z, strut, lowJ, upJ, lowPivot, upPivot, tower, diff: new THREE.Vector3(s * 0.16, h0, z), ...parts });
  }
  // a body-mounted diff on every driven independent axle
  for (const ai of new Set(corners.filter(c => c.shaft).map(c => c.w.axle))) {
    const d = mesh(new THREE.SphereGeometry(0.13, 16, 10), mats.chassis, 0, ride[ai].hubY, P.axles[ai].z);
    d.scale.set(1, 0.85, 0.8);
    root.add(d);
  }
  return {
    corners,
    update(view, v) {
      for (const c of corners) {
        const w = v.wheels[c.wi], ax = v.axles[c.w.axle];
        _hub.set(c.s * (v.P.track / 2 + (w.out || 0)), ax.droopY + w.c, c.z);
        const cam = -c.s * (w.camber || 0), cs = Math.cos(cam), sn = Math.sin(cam);
        const joint = (j, out) => out.set(_hub.x + cs * j.x - sn * j.y, _hub.y + sn * j.x + cs * j.y, c.z);
        joint(c.lowJ, _a);
        stretch(c.lowArm, c.lowPivot, _a);
        // spring + damper: from the lower arm (2/3 out) up to the tower (strut: from the knuckle's top)
        const base = c.strut ? joint(c.upJ, _b) : _b.copy(c.lowPivot).lerp(_a, 0.66);
        stretch(c.damper, base, c.tower);
        c.coil.position.copy(base).lerp(c.tower, c.strut ? 0.35 : 0.1);
        const dir = _v.subVectors(c.tower, c.coil.position);
        c.coil.scale.set(1, dir.length(), 1);
        c.coil.quaternion.setFromUnitVectors(Y, dir.normalize());
        if (c.upArm) stretch(c.upArm, c.upPivot, joint(c.upJ, _b));
        if (c.shaft) stretch(c.shaft, c.diff, _hub);
      }
    },
  };
}
