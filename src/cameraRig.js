import * as THREE from 'three';

export const CAM_MODES = ['chase', 'cockpit', 'hood', 'wheel', 'orbit'];
export const CAM_NAMES = { chase: 'Chase camera', cockpit: 'Cockpit (first person)', hood: 'Hood camera', wheel: 'Wheel camera (front left)', orbit: 'Free orbit' };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

export class CameraRig {
  constructor(camera, terrain) {
    this.cam = camera;
    this.terrain = terrain;
    this.mode = 'chase';
    this.camYaw = 0;
    this.orbitYaw = 0; this.orbitPitch = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this.dist = 7.6;
    this.freeYaw = 0.6; this.freePitch = 0.35; this.freeDist = 9;
    this.head = new THREE.Vector3();
    this.headVel = new THREE.Vector3();
    this.smoothPos = new THREE.Vector3();
    this.first = true;
  }

  get label() { return CAM_NAMES[this.mode]; }

  cycle() {
    return this.setMode(CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length]);
  }

  setMode(mode) {
    if (!CAM_MODES.includes(mode)) return this.mode;
    this.mode = mode;
    this.lookYaw = this.lookPitch = 0;
    this.orbitYaw = this.orbitPitch = 0;
    this.first = true;
    return this.mode;
  }

  update(dt, input, pos, quat, vehicle, model) {
    const cam = this.cam, m = input.mouse;
    const idle = performance.now() - m.lastMove > 1600 && !m.down;
    const fwd = _v.set(0, 0, -1).applyQuaternion(quat);
    const vehYaw = Math.atan2(-fwd.x, -fwd.z);
    let near = 0.1, fov = 62;

    if (this.mode === 'chase') {
      if (this.first) { this.camYaw = vehYaw; }
      const k = 1 - Math.exp(-dt * (2.2 + Math.min(Math.abs(vehicle.speed), 20) * 0.12));
      this.camYaw += angDiff(vehYaw, this.camYaw) * k;
      this.orbitYaw -= m.dx * 0.005;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + m.dy * 0.004, -0.25, 1.1);
      if (idle) { this.orbitYaw *= Math.exp(-dt * 1.8); this.orbitPitch *= Math.exp(-dt * 1.8); }
      this.dist = THREE.MathUtils.clamp(this.dist * (1 + m.wheel * 0.08), 3.5, 24);
      const target = _v2.set(0, 1.25, 0).applyQuaternion(quat).add(pos);
      const yaw = this.camYaw + this.orbitYaw, pitch = 0.27 + this.orbitPitch;
      const d = this.dist;
      const desired = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d).add(target);
      const gy = this.terrain.heightAt(desired.x, desired.z) + 0.7;
      if (desired.y < gy) desired.y = gy;
      if (this.first) this.smoothPos.copy(desired);
      // a little vertical lag so bumps read without shaking the view
      const ky = 1 - Math.exp(-dt * 7), kh = 1 - Math.exp(-dt * 18);
      this.smoothPos.x += (desired.x - this.smoothPos.x) * kh;
      this.smoothPos.z += (desired.z - this.smoothPos.z) * kh;
      this.smoothPos.y += (desired.y - this.smoothPos.y) * ky;
      cam.position.copy(this.smoothPos);
      cam.lookAt(target.x, target.y + 0.15, target.z);
    } else if (this.mode === 'cockpit' || this.mode === 'hood') {
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - m.dx * 0.0032, -2.6, 2.6);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - m.dy * 0.0028, -1.1, 1.0);
      if (idle) { this.lookYaw *= Math.exp(-dt * 1.5); this.lookPitch *= Math.exp(-dt * 1.5); }
      let eye;
      if (this.mode === 'cockpit') {
        // head inertia: the head lags behind the body accelerations, sprung by the neck
        const inv = _q.copy(quat).invert();
        const a = _v2.copy(vehicle.accel).applyQuaternion(inv);
        const target = new THREE.Vector3(-a.x * 0.0032, -a.y * 0.0022, -a.z * 0.0036);
        target.clampLength(0, 0.07);
        const kS = 160, kD = 22;
        const acc = target.sub(this.head).multiplyScalar(kS).addScaledVector(this.headVel, -kD);
        this.headVel.addScaledVector(acc, Math.min(dt, 0.033));
        this.head.addScaledVector(this.headVel, Math.min(dt, 0.033));
        eye = model.driverEye.clone().add(this.head);
        near = 0.03; fov = 62;
      } else {
        // on the bonnet, just behind the raised centre section
        eye = new THREE.Vector3(0, 1.8, -1.0);
        near = 0.08; fov = 60;
      }
      cam.position.copy(eye).applyQuaternion(quat).add(pos);
      _e.set(this.lookPitch - (this.mode === 'hood' ? 0.06 : 0.14), this.lookYaw, 0, 'YXZ');
      cam.quaternion.copy(quat).multiply(_q.setFromEuler(_e));
    } else if (this.mode === 'wheel') {
      this.orbitYaw -= m.dx * 0.004;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + m.dy * 0.003, -0.4, 0.8);
      this.dist = THREE.MathUtils.clamp(this.dist * (1 + m.wheel * 0.08), 3.5, 24);
      const hub = new THREE.Vector3(-0.78, 0.42, -1.4);
      const yaw = -0.95 + this.orbitYaw, pitch = 0.1 + this.orbitPitch, d = 1.85;
      const local = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d).add(hub);
      local.x = Math.min(local.x, -1.08);
      cam.position.copy(local).applyQuaternion(quat).add(pos);
      const look = hub.clone().add(new THREE.Vector3(0.1, 0.05, 0.25)).applyQuaternion(quat).add(pos);
      cam.up.set(0, 1, 0).applyQuaternion(quat);
      cam.lookAt(look);
      cam.up.set(0, 1, 0);
      fov = 60;
    } else {
      this.freeYaw -= m.dx * 0.005;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch + m.dy * 0.004, -0.1, 1.45);
      this.freeDist = THREE.MathUtils.clamp(this.freeDist * (1 + m.wheel * 0.08), 3, 40);
      const target = _v2.set(0, 1.0, 0).applyQuaternion(quat).add(pos);
      const d = this.freeDist;
      const p = new THREE.Vector3(Math.sin(this.freeYaw) * Math.cos(this.freePitch) * d, Math.sin(this.freePitch) * d, Math.cos(this.freeYaw) * Math.cos(this.freePitch) * d).add(target);
      const gy = this.terrain.heightAt(p.x, p.z) + 0.4;
      if (p.y < gy) p.y = gy;
      cam.position.copy(p);
      cam.lookAt(target);
    }
    if (cam.near !== near || cam.fov !== fov) { cam.near = near; cam.fov = fov; cam.updateProjectionMatrix(); }
    this.first = false;
  }
}
