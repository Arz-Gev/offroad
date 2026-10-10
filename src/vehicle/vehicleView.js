import * as THREE from 'three';
import { shared } from './model/materials.js';
import { setTireContact } from './model/tireMaterial.js';

// Drives a car model (model/index.js) from the physics state: body pose (interpolated), wheels (steer, roll,
// tuned size, independent hub and camber), every part's motion (model.kits), tyre deformation (per ray,
// model/tireMaterial.js), the cabin (model.cockpit) and the lamps (model.lights, model.lenses).

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

const reversingNow = d => (d.mode === 'manual' ? d.manualGear < 0 : d.selector === 'R');

export class VehicleView {
  constructor(model, vehicle) {
    this.m = model;
    this.v = vehicle;
    this.P = vehicle.P;
    this.lights = { head: 0, aux: false, hazard: false }; // head: 0 off, 1 low, 2 high
    this.blink = 0;
  }

  update(pos, quat, dt, env) {
    const m = this.m, v = this.v, P = this.P;
    m.root.position.copy(pos);
    m.root.quaternion.copy(quat);

    // wheels: each was modelled at its own size (nativeR, nativeW); the tuning scales it to the tyre
    for (let i = 0; i < m.wheels.length; i++) {
      const w = v.wheels[i], mw = m.wheels[i];
      if (w.axle.ind) {
        mw.steer.position.set(w.side * (P.track / 2 + (w.out || 0)), w.axle.droopY + w.c, w.axle.p.z);
        _q.setFromAxisAngle(Z, -w.side * (w.camber || 0));
        mw.steer.quaternion.copy(_q).multiply(_q2.setFromAxisAngle(Y, -w.steer));
      } else mw.steer.rotation.y = -w.steer;   // a beam axle's wheels ride in its group (beamAxle.js)
      mw.spin.rotation.x = -w.spin;
      const sr = v.R / mw.nativeR, sx = P.tire.width / mw.nativeW;
      if (mw.spin.scale.y !== sr || mw.spin.scale.x !== sx) mw.spin.scale.set(sx, sr, sr);
    }
    for (const k of m.kits) k.update(this, v, dt);
    m.root.updateMatrixWorld(true);

    // tyre deformation: each ray's intrusion into the tyre (tyre v2), in the wheel's own units (the wheel
    // group scales the modelled tyre to the tuned one, so metres x nativeR / R)
    for (let i = 0; i < m.wheels.length; i++) {
      const w = v.wheels[i], mw = m.wheels[i];
      for (const mat of mw.tireMats) setTireContact(mat, w, v.R, mw.nativeR / v.R, w.spin);
    }

    if (m.cockpit) m.cockpit.update(this, v, dt);
    this.updateLights(dt, env, quat);
    m.batch?.sync();   // the parts drawn in batches follow their stand-ins (model/batched.js)
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
    const m = this.m, v = this.v, lens = m.lenses, L = m.lights, ls = this.lights;
    const dt_ = v.drivetrain;
    const head = ls.head;
    const braking = v.ctl.brake > 0.05;
    const reversing = reversingNow(dt_);
    const tailOn = head > 0;
    // lights only exist in the scene at night or when something is switched on (no cost in the day);
    // at night they stay in the scene with zero intensity, so switching lamps never recompiles shaders
    const live = env.night || head > 0 || ls.aux;
    for (const l of [L.head, ...L.aux, L.rear]) l.visible = live;
    const amb = this.ambientLevel();
    const k = Math.min(1, Math.max(0.12, 0.42 / Math.max(amb, 1e-3)));

    const hp = L.head.userData.peak;
    L.head.map = head === 2 ? L.cookies.high : L.cookies.low;
    L.head.intensity = head === 0 ? 0 : (head === 1 ? hp.low : hp.high) * k;
    L.head.distance = head === 2 ? 260 : 150;
    L.head.shadow.autoUpdate = live && head > 0 && env.shadows !== false;
    // keep the cookie level with the truck, not with the world, when it rolls
    L.head.shadow.camera.up.set(0, 1, 0).applyQuaternion(quat);
    for (const l of L.aux) {
      l.shadow.camera.up.copy(L.head.shadow.camera.up);
      l.intensity = ls.aux ? l.userData.peak * k : 0;
    }

    // lens glow by role (a model without a lens for a role skips it; roles sharing a material: the later wins)
    this.blink += dt;
    const blinkOn = ls.hazard && (this.blink % 0.8) < 0.4;
    const glow = this.glow ||= {};
    glow.head = head === 0 ? 0 : head === 1 ? 2.6 : 5.0; glow.side = tailOn ? 1.2 : 0; glow.aux = ls.aux ? 6.0 : 0;
    glow.work = ls.aux && reversing ? 4.0 : 0; glow.tail = tailOn ? 1.6 : 0; glow.brake = braking ? 3.2 : tailOn ? 1.0 : 0;
    glow.reverse = reversing ? 4.0 : 0; glow.amber = blinkOn ? 5.0 : 0; glow.beacon = 0;
    for (const role in glow) {
      const mats = lens[role];
      if (mats) for (const mat of mats) {
        mat.emissiveIntensity = glow[role];
        const o0 = mat.userData.clearOpacity;   // a clear lens: lit from inside, its glass glows
        if (o0 !== undefined) mat.opacity = o0 + (1 - o0) * Math.min(1, glow[role] / 2.6);
      }
    }

    const red = (braking ? 0.5 : 0) + (tailOn ? 0.08 : 0);
    const white = reversing ? 9 : 0;
    L.rear.intensity = (red + white) * k;
    if (red + white > 0) L.rear.color.setRGB(1, 0.16, 0.06).multiplyScalar(red / (red + white)).add(_c.setRGB(1, 0.97, 0.92).multiplyScalar(white / (red + white)));

    const dark = env.darkness ?? (env.night ? 1 : 0);
    const back = tailOn ? 1 : dark;
    const c = m.cockpit;
    if (c?.gaugeMat) c.gaugeMat.emissiveIntensity = 0.45 + 0.4 * back;
    if (c?.needleMat) c.needleMat.emissiveIntensity = 0.35 + 0.65 * back;
    if (c?.warnMat) c.warnMat.emissiveIntensity = dt_.running ? 0 : 1.2;

    // reflections: scale the (deliberately dim) scene environment up for paint and glass
    shared.uEnvSpec.value = 1.0 + 0.6 * dark;
  }
}
