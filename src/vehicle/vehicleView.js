import * as THREE from 'three';
import { RPM } from './drivetrain.js';

// Drives the procedural model from the physics state: body pose (interpolated), axle heave/roll,
// steering, wheel spin, tyre squash, springs, dampers, links, prop shafts, lights and gauges.

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

const reversingNow = d => (d.mode === 'manual' ? d.manualGear < 0 : d.selector === 'R');

export class VehicleView {
  constructor(model, vehicle) {
    this.m = model;
    this.v = vehicle;
    this.P = vehicle.P;
    this.propAngle = [0, 0];
    this.lights = { head: 0, bar: false, hazard: false }; // head: 0 off, 1 low, 2 high
    this.blink = 0;
  }

  axleToBody(ai, local, out) {
    const ax = this.m.axles[ai];
    return out.copy(local).applyEuler(ax.rotation).add(ax.position);
  }

  update(pos, quat, dt, env) {
    const m = this.m, v = this.v, P = this.P;
    m.root.position.copy(pos);
    m.root.quaternion.copy(quat);

    // axles
    for (let ai = 0; ai < 2; ai++) {
      const a = v.axles[ai], g = m.axles[ai];
      g.position.set(0, a.p.droopY + a.c, a.p.z);
      g.rotation.set(0, 0, a.phi);
    }
    // wheels
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i], mw = m.wheels[i];
      mw.steer.rotation.y = -w.steer;
      mw.spin.rotation.x = -w.spin;
    }
    // suspension pieces (body frame)
    for (const s of m.suspension) {
      const ap = P.axles[s.ai];
      const base = this.axleToBody(s.ai, _v.set(s.sx, 0.07, 0), _v);
      s.coil.position.copy(base);
      const top = _v2.set(s.sx, s.topY, ap.z);
      const len = Math.max(0.05, top.distanceTo(base));
      s.coil.scale.set(1, len, 1);
      s.coil.quaternion.setFromUnitVectors(Y, _v3.subVectors(top, base).normalize());
      // damper
      const sb = this.axleToBody(s.ai, _v.set(s.shockX, 0.02, s.shockZ - ap.z), _v);
      const st = _v2.set(s.shockX, s.shockTop, s.shockZ);
      const dir = _v3.subVectors(st, sb).normalize();
      s.shockRod.position.copy(sb);
      s.shockRod.quaternion.setFromUnitVectors(Y, dir);
      s.shockBody.position.copy(st);
      s.shockBody.quaternion.setFromUnitVectors(Y, dir);
    }
    for (let ai = 0; ai < 2; ai++) {
      const g = m.axles[ai];
      for (const l of g.userData.links) {
        const end = this.axleToBody(ai, l.end, _v);
        const d = _v2.subVectors(end, l.pivot);
        l.link.position.copy(l.pivot).addScaledVector(d, 0.5);
        l.link.scale.set(1, 1, d.length());
        l.link.quaternion.setFromUnitVectors(Z, d.normalize());
      }
      const ph = g.userData.panhard;
      const ae = this.axleToBody(ai, ph.axleEnd, _v);
      const d = _v2.subVectors(ae, ph.bodyEnd);
      ph.mesh.position.copy(ph.bodyEnd).addScaledVector(d, 0.5);
      ph.mesh.scale.set(d.length(), 1, 1);
      ph.mesh.quaternion.setFromUnitVectors(X, d.normalize());
      if (g.userData.tie) g.userData.tie.position.x = v.steerAngle * 0.13;
    }
    // prop shafts from the transfer case to each diff
    const tc = _v3.set(0.06, 0.48, 0.3);
    const dt_ = v.drivetrain;
    for (let ai = 0; ai < 2; ai++) {
      const end = this.axleToBody(ai, _v.set(ai === 0 ? 0.12 : 0, 0.0, ai === 0 ? 0.22 : -0.22), _v);
      const d = _v2.subVectors(end, tc);
      const pm = m.props[ai];
      pm.position.copy(tc).addScaledVector(d, 0.5);
      pm.scale.set(1, d.length(), 1);
      pm.quaternion.setFromUnitVectors(Y, d.normalize());
    }

    m.root.updateMatrixWorld(true);

    // tyre squash: contact plane into each tyre's object space
    const R = P.tire.radius;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i], mw = m.wheels[i];
      const u = mw.tireMat.userData.uniforms;
      _m.copy(mw.tire.matrixWorld).invert();
      if (w.contact && w.pen > -0.02) {
        const hub = _v.setFromMatrixPosition(mw.tire.matrixWorld);
        const n = _v2.copy(w.nLocal).applyQuaternion(quat);
        const p = hub.addScaledVector(n, -(R - w.pen));
        u.uPlaneP.value.copy(p).applyMatrix4(_m);
        u.uPlaneN.value.copy(n).transformDirection(_m);
        u.uDefl.value = Math.max(0, w.pen);
      } else {
        u.uPlaneP.value.set(0, -5, 0);
        u.uPlaneN.value.set(0, 1, 0);
        u.uDefl.value = 0;
      }
    }

    // cockpit
    m.steeringWheel.rotation.z = -v.steerAngle * P.steer.ratio;
    const kmh = Math.abs(v.speed) * 3.6;
    m.needles.speed.rotation.z = -(Math.PI * 0.75 + Math.PI * 1.5 * Math.min(kmh, 165) / 160) - Math.PI / 2;
    const rpm = Math.max(0, dt_.rpm);
    m.needles.rpm.rotation.z = -(Math.PI * 0.75 + Math.PI * 1.5 * Math.min(rpm, 6200) / 6000) - Math.PI / 2;
    // gear lever position (rough H-pattern)
    const gl = dt_.mode === 'manual' ? dt_.manualGear : ({ P: -2, R: -1, N: 0, D: 1 })[dt_.selector] ?? 0;
    const col = gl === 0 ? 0 : gl < 0 ? -1 : Math.ceil(gl / 2) - 1;
    const row = gl === 0 ? 0 : gl < 0 ? -1 : (gl % 2 === 1 ? -1 : 1);
    m.gearLever.rotation.set(row * 0.25, 0, -col * 0.18);
    m.transferLever.rotation.x = dt_.range === 'low' ? 0.35 : -0.15;

    // lights
    const mt = m.mats, L = m.lights, ls = this.lights;
    const night = env.night;
    const head = ls.head;
    L.headL.intensity = L.headR.intensity = head === 0 ? 0 : head === 1 ? L.headL.userData.on : L.headL.userData.on * 2.6;
    L.headL.angle = L.headR.angle = head === 2 ? 0.42 : 0.55;
    const tgtY = head === 2 ? 0.6 : -0.6;
    L.headL.target.position.y = L.headR.target.position.y = tgtY;
    L.headL.castShadow = L.headR.castShadow = head > 0 && env.shadows;
    mt.headLens.emissiveIntensity = head === 0 ? 0 : head === 1 ? 6 : 14;
    L.bar.intensity = ls.bar ? L.bar.userData.on : 0;
    L.bar.castShadow = ls.bar && env.shadows;
    mt.barLens.emissiveIntensity = ls.bar ? 16 : 0;
    mt.workLens.emissiveIntensity = ls.bar && reversingNow(dt_) ? 10 : 0;
    const braking = v.ctl.brake > 0.05;
    const reversing = dt_.mode === 'manual' ? dt_.manualGear < 0 : dt_.selector === 'R';
    const tailOn = head > 0;
    mt.tail.emissiveIntensity = tailOn ? 2.2 : 0;
    mt.brake.emissiveIntensity = braking ? 9 : tailOn ? 1.6 : 0;
    L.tailL.intensity = L.tailR.intensity = (braking ? 1.4 : 0) + (tailOn ? 0.5 : 0);
    mt.reverse.emissiveIntensity = reversing ? 8 : 0;
    L.reverse.intensity = reversing ? L.reverse.userData.on : 0;
    this.blink += dt;
    const blinkOn = ls.hazard && (this.blink % 0.8) < 0.4;
    mt.amber.emissiveIntensity = blinkOn ? 8 : 0;
    m.gaugeMat.emissiveIntensity = tailOn ? 0.55 : 0.0;
    L.dash.intensity = tailOn ? 0.05 : 0;
  }
}
