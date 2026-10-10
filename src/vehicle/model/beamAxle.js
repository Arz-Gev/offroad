import * as THREE from 'three/webgpu';
import { mesh, bar, mergeStatic } from './geom.js';

// Running gear of a beam (solid) axle: tube, diff and pinion, hubs and brake discs, two coil springs and two
// dampers, two radius arms / trailing links, a panhard rod, a track rod on a steered axle, a prop shaft on a
// driven one. The axle group carries the wheels and follows the physics' heave and roll; springs, dampers
// and links live in the body frame and are stretched between their ends every frame. Dimensions come from
// the axle's params; the link and rod geometry is a typical coil-sprung 4x4's (the Defender's).
// opts.transferCase: the transfer case output (body frame) the prop shafts start from.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

// helical coil spring of unit height, scaled in y at runtime
export function coilGeometry(radius, wire, turns) {
  const pts = [];
  const n = turns * 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, t, Math.sin(a) * radius));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, wire, 6, false);
}

export function beamAxle(root, mats, P, ai, wheels, opts = {}) {
  const ap = P.axles[ai], t2 = P.track / 2;
  const toMid = ap.z < 0 ? 1 : -1;               // along z towards the middle of the car
  const diffX = ai === 0 ? 0.12 : 0;             // the front diff sits off-centre (the prop runs beside the engine)
  const add = (o, parent) => { parent.add(o); return o; };

  const axle = new THREE.Group();
  axle.position.set(0, ap.droopY, ap.z);
  root.add(axle);
  add(bar([-t2 + 0.12, 0, 0], [t2 - 0.12, 0, 0], 0.05, mats.chassis, 12), axle);
  const diff = add(mesh(new THREE.SphereGeometry(0.15, 18, 12), mats.chassis, diffX, 0, 0), axle);
  diff.scale.set(1, 0.9, 0.75);
  add(mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.14, 12).rotateX(Math.PI / 2), mats.chassis, diffX, 0.0, toMid * 0.15), axle);
  for (const s of [-1, 1]) {
    const hub = add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 16), mats.chassis, s * (t2 - 0.17), 0, 0), axle);
    hub.rotation.z = Math.PI / 2;
    add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 20).rotateZ(Math.PI / 2), mats.steel, s * (t2 - 0.1), 0, 0), axle); // brake disc
    add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.16), mats.chassis), axle).position.set(s * (ap.springTrack / 2), 0.055, 0);
  }
  const suspension = [];
  for (const s of [-1, 1]) {
    const sx = s * ap.springTrack / 2;
    const topY = ap.droopY + ap.travel + 0.36;
    const coil = add(mesh(coilGeometry(0.085, 0.014, 7), mats.blackMetal), root);
    add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 16), mats.chassis, sx, topY, ap.z), root);
    const shockX = s * (ap.damperTrack ? ap.damperTrack / 2 : ap.springTrack / 2 + 0.16);
    const shockZ = ap.z + toMid * 0.12;
    const shockBody = add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 12).translate(0, -0.15, 0), mats.yellow), root);
    const shockRod = add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 8).translate(0, 0.16, 0), mats.chrome), root);
    suspension.push({ coil, sx, topY, shockBody, shockRod, shockX, shockZ, shockTop: topY + 0.02 });
  }
  // radius arms (front) / trailing links (rear) from chassis pivots to the axle
  const links = [];
  for (const s of [-1, 1]) {
    const link = add(mesh(new THREE.BoxGeometry(0.06, 0.06, 1), mats.chassis), root);
    links.push({ link, pivot: new THREE.Vector3(s * 0.4, 0.5, ap.z + toMid * 1.05), end: new THREE.Vector3(s * 0.45, -0.06, 0) });
  }
  const panhard = { mesh: add(mesh(new THREE.BoxGeometry(1, 0.04, 0.04), mats.chassis), root),
    bodyEnd: new THREE.Vector3(-0.45, 0.62, ap.z + toMid * 0.22), axleEnd: new THREE.Vector3(0.55, 0.06, toMid * 0.22) };
  for (const w of wheels) {
    w.steer.position.set(w.side * t2, 0, 0);
    w.steer.userData.isWheel = true;
    axle.add(w.steer);
  }
  let tie = null;
  if (ap.steered) {
    tie = add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 8), mats.chassis), axle);
    tie.rotation.z = Math.PI / 2;
    tie.position.set(0, -0.05, 0.16);
    tie.scale.y = 2 * t2 - 0.3;
  }
  const prop = ap.driven === false ? null : add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 10), mats.zinc), root);
  const transferCase = new THREE.Vector3(...(opts.transferCase || [0.06, 0.48, 0.3]));
  mergeStatic(axle, o => o.userData.isWheel || o === tie);

  const toBody = (local, out) => out.copy(local).applyEuler(axle.rotation).add(axle.position);
  return {
    axle, suspension, links, panhard, prop,
    update(view, v) {
      const a = v.axles[ai];
      axle.position.set(0, a.droopY + a.c, ap.z);
      axle.rotation.set(0, 0, a.phi);
      for (const s of suspension) {
        const base = toBody(_v.set(s.sx, 0.07, 0), _v);
        s.coil.position.copy(base);
        const top = _v2.set(s.sx, s.topY, ap.z);
        const len = Math.max(0.05, top.distanceTo(base));
        s.coil.scale.set(1, len, 1);
        s.coil.quaternion.setFromUnitVectors(Y, _v3.subVectors(top, base).normalize());
        const sb = toBody(_v.set(s.shockX, 0.02, s.shockZ - ap.z), _v);
        const st = _v2.set(s.shockX, s.shockTop, s.shockZ);
        const dir = _v3.subVectors(st, sb).normalize();
        s.shockRod.position.copy(sb);
        s.shockRod.quaternion.setFromUnitVectors(Y, dir);
        s.shockBody.position.copy(st);
        s.shockBody.quaternion.setFromUnitVectors(Y, dir);
      }
      for (const l of links) {
        const end = toBody(l.end, _v);
        const d = _v2.subVectors(end, l.pivot);
        l.link.position.copy(l.pivot).addScaledVector(d, 0.5);
        l.link.scale.set(1, 1, d.length());
        l.link.quaternion.setFromUnitVectors(Z, d.normalize());
      }
      const ae = toBody(panhard.axleEnd, _v);
      const d = _v2.subVectors(ae, panhard.bodyEnd);
      panhard.mesh.position.copy(panhard.bodyEnd).addScaledVector(d, 0.5);
      panhard.mesh.scale.set(d.length(), 1, 1);
      panhard.mesh.quaternion.setFromUnitVectors(X, d.normalize());
      if (tie) tie.position.x = v.steerAngle * 0.13;
      if (prop) {
        const end = toBody(_v.set(diffX, 0.0, toMid * 0.22), _v);
        const pd = _v2.subVectors(end, transferCase);
        prop.position.copy(transferCase).addScaledVector(pd, 0.5);
        prop.scale.set(1, pd.length(), 1);
        prop.quaternion.setFromUnitVectors(Y, pd.normalize());
      }
    },
  };
}
