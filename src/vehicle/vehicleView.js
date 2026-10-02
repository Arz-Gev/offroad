import * as THREE from 'three';
import { shared } from './truckMaterials.js';

// Drives the procedural model from the physics state: body pose (interpolated), axle heave/roll,
// steering, wheel spin, tyre squash, springs, dampers, links, prop shafts, lights and gauges.

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
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
    this.temp = 0.2;
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
    const dialRot = f => Math.PI * 0.75 - Math.PI * 1.5 * Math.min(Math.max(f, 0), 1.03);
    m.needles.speed.rotation.z = dialRot(kmh / 160);
    const rpm = Math.max(0, dt_.rpm);
    m.needles.rpm.rotation.z = dialRot(rpm / 6000);
    if (m.needles.fuel) m.needles.fuel.rotation.z = dialRot(0.72);
    if (m.needles.temp) {
      this.temp += ((dt_.running ? 0.52 : 0.2) - this.temp) * Math.min(1, dt * 0.05);
      m.needles.temp.rotation.z = dialRot(this.temp);
    }
    // gear lever position (rough H-pattern)
    const gl = dt_.mode === 'manual' ? dt_.manualGear : ({ P: -2, R: -1, N: 0, D: 1 })[dt_.selector] ?? 0;
    const col = gl === 0 ? 0 : gl < 0 ? -1 : Math.ceil(gl / 2) - 1;
    const row = gl === 0 ? 0 : gl < 0 ? -1 : (gl % 2 === 1 ? -1 : 1);
    m.gearLever.rotation.set(row * 0.25, 0, -col * 0.18);
    m.transferLever.rotation.x = dt_.range === 'low' ? 0.35 : -0.15;

    this.updateLights(dt, env, quat);
  }

  // Ambient light level of the scene (sun/moon + sky), used to scale the lamps: the scene is not
  // photometric, so a headlamp tuned for the night would paint a visible pool on the ground at noon.
  ambientLevel() {
    const scene = this.m.root.parent;
    if (!scene) return 0.4;
    if (!this._sky) {
      this._sky = { sun: null, hemi: null };
      scene.traverse(o => {
        if (o.isDirectionalLight && !this._sky.sun) this._sky.sun = o;
        if (o.isHemisphereLight && !this._sky.hemi) this._sky.hemi = o;
      });
    }
    const { sun, hemi } = this._sky;
    let a = hemi ? hemi.intensity : 0.3;
    if (sun) {
      const dy = sun.position.y - sun.target.position.y;
      const len = sun.position.distanceTo(sun.target.position) || 1;
      a += sun.intensity * Math.max(0, dy / len);
    }
    return a;
  }

  updateLights(dt, env, quat) {
    const m = this.m, v = this.v, mt = m.mats, L = m.lights, ls = this.lights;
    const dt_ = v.drivetrain;
    const head = ls.head;
    const braking = v.ctl.brake > 0.05;
    const reversing = reversingNow(dt_);
    const tailOn = head > 0;
    // lights only exist in the scene at night or when something is switched on (no cost in the day);
    // at night they stay in the scene with zero intensity, so switching lamps never recompiles shaders
    const live = env.night || head > 0 || ls.bar;
    for (const l of [L.head, L.bar, L.rear]) l.visible = live;
    const amb = this.ambientLevel();
    const k = Math.min(1, Math.max(0.12, 0.42 / Math.max(amb, 1e-3)));

    // head: one beam between the lamps, cookie switches low / high
    const hp = L.head.userData.peak;
    L.head.map = head === 2 ? L.cookies.high : L.cookies.low;
    L.head.intensity = head === 0 ? 0 : (head === 1 ? hp.low : hp.high) * k;
    L.head.distance = head === 2 ? 260 : 150;
    L.head.shadow.autoUpdate = live && head > 0 && env.shadows !== false;
    // keep the cookie level with the truck, not with the world, when it rolls
    L.head.shadow.camera.up.set(0, 1, 0).applyQuaternion(quat);
    L.bar.shadow.camera.up.copy(L.head.shadow.camera.up);
    L.bar.intensity = ls.bar ? L.bar.userData.peak * k : 0;

    // lens glow: modest, the beams do the lighting
    mt.headLens.emissiveIntensity = head === 0 ? 0 : head === 1 ? 2.6 : 5.0;
    mt.sideLens.emissiveIntensity = tailOn ? 1.2 : 0;
    mt.barLens.emissiveIntensity = ls.bar ? 6.0 : 0;
    mt.workLens.emissiveIntensity = ls.bar && reversing ? 4.0 : 0;
    mt.tail.emissiveIntensity = tailOn ? 1.6 : 0;
    mt.brake.emissiveIntensity = braking ? 3.2 : tailOn ? 1.0 : 0;
    mt.reverse.emissiveIntensity = reversing ? 4.0 : 0;
    this.blink += dt;
    const blinkOn = ls.hazard && (this.blink % 0.8) < 0.4;
    mt.amber.emissiveIntensity = blinkOn ? 5.0 : 0;
    mt.beacon.emissiveIntensity = 0;

    // rear: tail / brake glow on the ground behind + the reversing lamps (one small spot)
    const red = (braking ? 0.5 : 0) + (tailOn ? 0.08 : 0);
    const white = reversing ? 9 : 0;
    L.rear.intensity = (red + white) * k;
    if (red + white > 0) L.rear.color.setRGB(1, 0.16, 0.06).multiplyScalar(red / (red + white)).add(_c.setRGB(1, 0.97, 0.92).multiplyScalar(white / (red + white)));

    // instrument backlight (night / lights on) and warning lamps
    const dark = env.darkness ?? (env.night ? 1 : 0);
    const back = tailOn ? 1 : dark;
    m.gaugeMat.emissiveIntensity = 0.45 + 0.4 * back;
    if (m.needleMat) m.needleMat.emissiveIntensity = 0.35 + 0.65 * back;
    if (m.warnMat) m.warnMat.emissiveIntensity = dt_.running ? 0 : 1.2;

    // reflections: scale the (deliberately dim) scene environment up for paint and glass
    shared.uEnvSpec.value = 1.0 + 0.6 * dark;
  }
}
