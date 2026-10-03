import * as THREE from 'three';
import { Drivetrain } from './drivetrain.js';
import { SURFACES, tireCoefs, tireForces, tireRelax } from './tire.js';

// Physics model
// - Chassis: one Rapier rigid body (sprung + unsprung mass, gravity on the unsprung part cancelled).
// - Each beam axle: 2 DOF (heave c, roll phi) relative to the chassis, with its own mass and roll inertia,
//   integrated in substeps with absolute velocities, so wheels hop, axles articulate and axle wrap exists.
// - Tyres: fan of rays in the wheel plane (3 rows across the tread) gives contact point, normal and
//   radial deflection; the tyre is a radial spring/damper in series with the coil spring.
// - Friction: transient tyre model (tire.js) driven by the drivetrain's wheel speeds (drivetrain.js).

const V3 = THREE.Vector3;
const G = 9.81;
const FAN = [];
for (let i = -6; i <= 6; i++) FAN.push((i / 6) * (80 * Math.PI / 180));

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new V3(), _v2 = new V3(), _v3 = new V3();
const X = new V3(1, 0, 0), Y = new V3(0, 1, 0), Z = new V3(0, 0, 1);

// Rapier collision groups: high 16 bits = membership, low 16 bits = filter.
const GROUND_BIT = 0x0001, WHEEL_BIT = 0x0002;
export const GROUP_GROUND = (GROUND_BIT << 16) | 0xffff;
const GROUP_WHEEL_SIDE = (WHEEL_BIT << 16) | (0xffff & ~GROUND_BIT);

// Keyboard steering assist (Settings): a held key asks for the angle that corners at k x the current grip
// limit plus c x the front tyres' peak slip angle. 'off' = full lock at any speed.
export const STEER_ASSIST = { strong: { k: 1.2, c: 0.5 }, light: { k: 1.6, c: 0.6 } };

export class Vehicle {
  constructor(RAPIER, world, P, opts = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.P = P;
    this.surfaceAt = opts.surfaceAt || (() => SURFACES.dirt);
    this.substeps = opts.substeps || 4;
    this.pressures = [P.tire.pressure, P.tire.pressure];   // front, rear (psi)
    // geometry the physics uses right now; retune() eases it towards P (tyre radius, axle droop height)
    this.R = P.tire.radius;

    const unsprung = P.axles[0].mass + P.axles[1].mass;
    this.totalMass = P.bodyMass + unsprung;
    const pos = opts.position || { x: 0, y: 1, z: 0 };
    const rot = new THREE.Quaternion().setFromAxisAngle(Y, opts.yaw || 0);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setAdditionalMassProperties(this.totalMass, { x: P.com[0], y: P.com[1], z: P.com[2] },
        { x: P.bodyInertia[0], y: P.bodyInertia[1], z: P.bodyInertia[2] }, { x: 0, y: 0, z: 0, w: 1 })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAngularDamping(0.02);
    this.body = world.createRigidBody(desc);
    this.chassisColliders = [];
    this.setColliders(P.colliders);

    this.drivetrain = new Drivetrain(P);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    // static sag estimate so we spawn close to equilibrium
    const L = P.wheelbase;
    const frontFrac = (L / 2 - P.com[2]) / L;
    this.axles = P.axles.map((p, i) => {
      const load = P.bodyMass * G * (i === 0 ? frontFrac : 1 - frontFrac) / 2;
      return {
        p, i, droopY: p.droopY, k: p.k,
        c: Math.min(p.travel * 0.9, load / p.k - p.preload),
        vz: 0, phi: 0, Om: 0,
        A: new V3(), q: new THREE.Quaternion(), mount: new V3(), vMountU: 0, rollRateBody: 0,
        S: [0, 0], accS: [0, 0], accD: [0, 0], accArb: 0,
      };
    });

    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const ax = this.axles[i < 2 ? 0 : 1];
      this.wheels.push({
        i, axle: ax, side: i % 2 === 0 ? -1 : 1, steer: 0,
        hub: new V3(), q: new THREE.Quaternion(), spin: 0,
        spinAxis: new V3(), fwd: new V3(), up: new V3(),
        contact: false, pen: -1, penDot: 0, n: new V3(0, 1, 0), nLocal: new V3(0, 1, 0), P: new V3(),
        latOff: 0, surf: SURFACES.dirt, fc: new V3(), sc: new V3(), vcx: 0, vcy: 0, vHubPerp: new V3(),
        ux: 0, uy: 0, Fx: 0, Fy: 0, Fn: 0, Re: P.tire.radius, slipNorm: 0, slipSteady: 0,
        co: {}, accF: new V3(), FnAvg: 0, slipVel: 0, collider: null,
      });
    }

    // Side-impact cylinders for the wheels. Ground contact is handled by the ray fan; these only stop
    // rocks, logs and walls from passing through the sidewall. They must never touch the terrain
    // heightfield: they are teleported to the hub every step, so a contact there turns into a huge
    // impulse on the whole truck (that was the "pogo stick" ride). Radius sits near the rim-bottoming
    // depth for the same reason.
    // Collision groups: heightfields are put in GROUND only; the wheel cylinders filter GROUND out.
    world.forEachCollider(c => {
      if (c.shape.type === RAPIER.ShapeType.HeightField) c.setCollisionGroups(GROUP_GROUND);
    });
    this.makeWheelColliders();

    this.ctl = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0 };
    this.steerAngle = 0;
    this.steerComp = 0;      // compliance steer of the front wheels (aligning moment against the steering)
    this.revTimer = 0;
    this.gripG = 0.63; this.gripSlip = 0.16;  // grip estimate for the keyboard steering limit (dirt)
    this.steerAssist = 'strong'; // keyboard steering limit at speed: 'strong' | 'light' | 'off' (Settings)
    this.arcadeAuto = false; // automatic gearbox: pedals pick R / D by themselves (Settings: Arcade automatic)
    this.speed = 0;          // forward speed m/s
    this.tireT = new Float64Array(4);
    this.rrT = new Float64Array(4);
    this.brakeT = new Float64Array(4);
    this.absFactor = new Float64Array([1, 1, 1, 1]);
    this.abs = true;
    this.hbMode = 'hold';    // handbrake key: 'hold' (while pressed) | 'toggle' (press on / press off) | 'auto' (tap toggles, long press holds)
    this.hbLatched = false;
    this._hbPrev = 0;
    this._hbPress = 0;
    this._hbWas = false;
    this.absActive = 0;
    this.tc = true;          // electronic traction control (brakes a spinning wheel)
    this.tcActive = 0;
    this.tcT = new Float64Array(4);
    this.time = 0;

    // body state cache
    this.pos = new V3(); this.quat = new THREE.Quaternion(); this.vel = new V3(); this.angVel = new V3(); this.com = new V3();
    this.right = new V3(); this.up = new V3(); this.back = new V3(); this.fwd = new V3();
    this.accel = new V3(); this._lastVel = new V3(); // for head motion / g-meter
    this.readBody();
    this.updateGeometry();
  }

  // ------------------------------------------------------------------ colliders and tuning
  // chassis collision boxes [cx, cy, cz, hx, hy, hz, rounding] on this body (density 0: mass is set apart)
  setColliders(list) {
    const { RAPIER, world } = this;
    for (const c of this.chassisColliders) world.removeCollider(c, false);
    this.chassisColliders = list.map(([cx, cy, cz, hx, hy, hz, r]) => {
      r = Math.max(0, Math.min(r, hx - 0.002, hy - 0.002, hz - 0.002));
      const cd = RAPIER.ColliderDesc.roundCuboid(hx - r, hy - r, hz - r, r)
        .setTranslation(cx, cy, cz).setDensity(0).setFriction(0.55).setRestitution(0.05);
      return world.createCollider(cd, this.body);
    });
  }

  // Side-impact cylinders for the wheels. Ground contact is handled by the ray fan; these only stop
  // rocks, logs and walls from passing through the sidewall. They must never touch the terrain
  // heightfield: they are teleported to the hub every step, so a contact there turns into a huge
  // impulse on the whole truck (that was the "pogo stick" ride). Radius sits near the rim-bottoming
  // depth for the same reason.
  makeWheelColliders() {
    const { RAPIER, world, P } = this;
    this.wheelColR = this.R;
    this.wheelColW = P.tire.width * 0.42;
    for (const w of this.wheels) {
      if (w.sideCollider) world.removeCollider(w.sideCollider, false);
      const cd = RAPIER.ColliderDesc.cylinder(P.tire.width * 0.42, this.R - 0.12 * this.R / 0.42)
        .setDensity(0).setFriction(0.35).setRestitution(0.0)
        .setCollisionGroups(GROUP_WHEEL_SIDE);
      w.sideCollider = world.createCollider(cd, this.body);
    }
    if (this.quat) this.updateGeometry();
  }

  // Mass, centre of mass and inertia from P (cargo, roof load, wheel mass) on the live body. They blend
  // over ~0.5 s (morphGeometry): dropping 850 kg of load in one step would throw the body off its springs.
  updateMass(snap = false) {
    const P = this.P;
    this.massTarget = [P.bodyMass + P.axles[0].mass + P.axles[1].mass, ...P.com, ...P.bodyInertia];
    if (snap || !this.massNow) this.massNow = [...this.massTarget];
    this.applyMass();
  }
  applyMass() {
    const m = this.massNow;
    this.totalMass = m[0];
    this.body.setAdditionalMassProperties(m[0], { x: m[1], y: m[2], z: m[3] }, { x: m[4], y: m[5], z: m[6] }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  // Called after tuning.applySetup changed P. Everything the step reads from P is already live; this
  // applies what lives elsewhere: mass properties, colliders, drivetrain inertias. Tyre radius and axle
  // droop (lift) ease towards P in step(), unless snap (teleports, load).
  retune({ colliders = true, snap = false } = {}) {
    this.updateMass(snap);
    if (colliders) this.setColliders(this.P.colliders);
    this.drivetrain.updateInertia();
    if (snap) this.snapGeometry();
    else if (Math.abs(this.P.tire.width * 0.42 - this.wheelColW) > 1e-4) this.makeWheelColliders();
  }

  snapGeometry() {
    this.R = this.P.tire.radius;
    for (const ax of this.axles) { ax.droopY = ax.p.droopY; ax.k = ax.p.k; }
    if (this.massTarget && this.massNow.some((x, i) => x !== this.massTarget[i])) { this.massNow = [...this.massTarget]; this.applyMass(); }
    if (Math.abs(this.R - this.wheelColR) > 1e-4 || Math.abs(this.P.tire.width * 0.42 - this.wheelColW) > 1e-4) this.makeWheelColliders();
  }

  // ease the geometry towards P: the body rises / settles on its springs, no wheels teleported into the ground
  // (raising 0.15 m/s; lowering slower, 0.05 m/s, so the body follows on its springs instead of dropping)
  morphGeometry(h) {
    const up = 0.15 * h, down = 0.05 * h;
    const R = this.P.tire.radius;
    if (this.R !== R) {
      this.R += Math.max(-down, Math.min(up, R - this.R));
      if (Math.abs(this.R - this.wheelColR) > 0.004 || this.R === R) this.makeWheelColliders();
    }
    // droop: a lower droopY = axle further below the body = the body sits higher
    for (const ax of this.axles) if (ax.droopY !== ax.p.droopY) ax.droopY += Math.max(-up, Math.min(down, ax.p.droopY - ax.droopY));
    // spring rates and mass blend in over ~0.5 s (a stiffer spring on a deeply compressed axle, or a load
    // taken off at once, would launch the body)
    const b = Math.min(1, h * 5);
    for (const ax of this.axles) if (ax.k !== ax.p.k) ax.k = Math.abs(ax.p.k - ax.k) < 50 ? ax.p.k : ax.k + (ax.p.k - ax.k) * b;
    const mt = this.massTarget, mn = this.massNow;
    if (mt && mn.some((x, i) => x !== mt[i])) {
      let close = true;
      for (let i = 0; i < 7; i++) { mn[i] += (mt[i] - mn[i]) * b; if (Math.abs(mt[i] - mn[i]) > 1e-3 * (1 + Math.abs(mt[i]))) close = false; }
      if (close) for (let i = 0; i < 7; i++) mn[i] = mt[i];
      this.applyMass();
    }
  }

  // ground height in the body frame at static ride, relative to stock: bigger tyres and lift raise the body
  get rideRaise() {
    const base = 0.42;
    return (this.P.tire.radius - base) + (0.275 - this.P.axles[0].droopY);
  }

  // ------------------------------------------------------------------ driver input
  // one number for the HUD and the keys: the mean of the axles; setting it keeps the front / rear split
  get pressure() { return (this.pressures[0] + this.pressures[1]) / 2; }
  setPressure(psi, axle) {
    const t = this.P.tire, lim = p => Math.max(t.minPressure, Math.min(t.maxPressure, p));
    if (axle === 0 || axle === 1) { this.pressures[axle] = lim(psi); return; }
    const d = psi - this.pressure;
    this.pressures = this.pressures.map(p => lim(p + d));
  }

  // Handbrake modes. 'auto': a short tap toggles the handbrake on / off, a long press works like 'hold'
  // (applied while pressed, released with the key).
  handbrakeLogic(raw, h) {
    const key = raw.handbrake > 0.5, prev = this._hbPrev > 0;
    this._hbPrev = key ? 1 : 0;
    if (this.hbMode === 'hold') { this.hbLatched = false; return raw.handbrake; }
    if (this.hbMode === 'toggle') { if (key && !prev) this.hbLatched = !this.hbLatched; return this.hbLatched ? 1 : 0; }
    if (key && !prev) { this._hbPress = 0; this._hbWas = this.hbLatched; }
    if (key) { this._hbPress += h; return 1; }
    if (prev) this.hbLatched = this._hbPress < 0.3 ? !this._hbWas : false;
    return this.hbLatched ? 1 : 0;
  }

  applyInput(raw, h) {
    const dt = this.drivetrain;
    const c = this.ctl;
    let throttle = raw.throttle, brake = raw.brake;
    if (dt.mode === 'auto') {
      const v = this.speed;
      // realistic automatic: W is always the gas, S always the brake, reverse only from the R selector.
      // arcade: R swaps the pedals and holding a pedal at a standstill picks R / D by itself.
      if (this.arcadeAuto && dt.selector === 'R') { throttle = raw.brake; brake = raw.throttle; }
      if (this.arcadeAuto && Math.abs(v) < 0.8) {
        const wantR = raw.brake > 0.5 && raw.throttle < 0.05 && dt.selector !== 'R';
        const wantD = raw.throttle > 0.5 && raw.brake < 0.05 && dt.selector !== 'D';
        if (wantR || wantD) this.revTimer += h; else this.revTimer = 0;
        if (this.revTimer > 0.45) { dt.setSelector(wantR ? 'R' : 'D'); this.revTimer = 0; }
      } else this.revTimer = 0;
    }
    c.throttle = throttle;
    c.brake = brake;
    c.clutch = raw.clutch;
    c.handbrake = this.handbrakeLogic(raw, h);
    // steering: speed sensitive limit (an input filter: what the "driver" asks for; the physics is the same
    // in every mode). A held key can't be dosed like a wheel, so at speed it asks for the angle that corners
    // at k x the grip under the truck right now (surface, pressure, tyre grip), plus c x the front tyres'
    // peak slip angle. Strong stays just past the limit, light goes well past it (tap and release to dose).
    const v = Math.abs(this.speed), maxA = this.P.steer.maxAngle;
    this.updateGripEstimate(h);
    let lim = 1;
    if (raw.analogSteer) lim = 1 / (1 + Math.max(0, v - 8) / 30);
    else {
      const a = STEER_ASSIST[this.steerAssist];
      if (a) lim = Math.min(1, (Math.atan(this.P.wheelbase * a.k * this.gripG * G / Math.max(v * v, 1e-3)) + a.c * this.gripSlip) / maxA);
    }
    const target = raw.steer * maxA * lim;
    const rate = 1.35 * 17 / this.P.steer.ratio; // rad/s at the road wheel (hydraulic rack; stock 17:1)
    this.steerAngle += Math.max(-rate * h, Math.min(rate * h, target - this.steerAngle));
    c.steer = this.steerAngle;
  }

  // What the truck can corner at right now, from the tyres in contact (last step's coefficients): lateral
  // limit in g (0.80 x mean mu: load transfer and load sensitivity, measured with tools/handling.mjs) and
  // the front tyres' peak slip angle. Smoothed over ~0.3 s so a patch of grass doesn't twitch the wheel.
  updateGripEstimate(h) {
    let mu = 0, n = 0, ap = 0, nf = 0;
    for (const w of this.wheels) {
      if (!w.contact || !(w.Fn > 0) || !w.co.mu) continue;
      mu += w.co.mu; n++;
      if (w.i < 2) { ap += w.aPk || w.surf.aPeak; nf++; }
    }
    if (!n) return;
    const k = Math.min(1, h / 0.3);
    this.gripG += (0.80 * mu / n - this.gripG) * k;
    if (nf) this.gripSlip += (ap / nf - this.gripSlip) * k;
  }

  // ------------------------------------------------------------------ geometry
  readBody() {
    const b = this.body;
    const t = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel(), com = b.worldCom();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.angVel.set(av.x, av.y, av.z);
    this.com.set(com.x, com.y, com.z);
    this.right.copy(X).applyQuaternion(this.quat);
    this.up.copy(Y).applyQuaternion(this.quat);
    this.back.copy(Z).applyQuaternion(this.quat);
    this.fwd.copy(this.back).negate();
  }

  pointVel(p, out) {
    return out.subVectors(p, this.com).crossVectors(this.angVel, out).add(this.vel);
  }

  steerAngles() {
    const d = this.steerAngle + this.steerComp;
    if (Math.abs(d) < 1e-4) return [d, d];
    const L = this.P.wheelbase, T = this.P.steer.kingpinTrack;
    const Rt = L / Math.tan(Math.abs(d));
    const inner = Math.atan(L / (Rt - T / 2)), outer = Math.atan(L / (Rt + T / 2));
    const s = Math.sign(d);
    // d > 0 = right turn: right wheel is the inner one
    return s > 0 ? [outer * s, inner * s] : [inner * s, outer * s];
  }

  updateGeometry() {
    const P = this.P;
    const [sl, sr] = this.steerAngles();
    for (const ax of this.axles) {
      const p = ax.p;
      ax.A.set(0, ax.droopY + ax.c, p.z).applyQuaternion(this.quat).add(this.pos);
      _q.setFromAxisAngle(Z, ax.phi);
      ax.q.copy(this.quat).multiply(_q);
    }
    for (const w of this.wheels) {
      const ax = w.axle;
      // roll steer: the axle's links swing it about a vertical axis as the body rolls on it.
      // rollSteer > 0 = roll understeer (rear axle turns into the bend, front axle out of it)
      w.steer = (ax.p.steered ? (w.side < 0 ? sl : sr) : 0) + Math.sign(ax.p.z) * -(ax.p.rollSteer || 0) * ax.phi;
      w.hub.set(w.side * P.track / 2, 0, 0).applyQuaternion(ax.q).add(ax.A);
      _q.setFromAxisAngle(Y, -w.steer);
      w.q.copy(ax.q).multiply(_q);
      w.spinAxis.copy(X).applyQuaternion(w.q);
      w.up.copy(Y).applyQuaternion(w.q);
      w.fwd.copy(Z).applyQuaternion(w.q).negate();
      if (w.sideCollider) {
        // body-local pose of the wheel; cylinder axis (y) turned onto the spin axis (x)
        const ap = ax.p;
        _q2.setFromAxisAngle(Z, ax.phi);
        _v.set(w.side * P.track / 2, 0, 0).applyQuaternion(_q2);
        _v.y += ax.droopY + ax.c; _v.z += ap.z;
        w.sideCollider.setTranslationWrtParent({ x: _v.x, y: _v.y, z: _v.z });
        _q2.multiply(_q.setFromAxisAngle(Y, -w.steer)).multiply(_q.setFromAxisAngle(Z, -Math.PI / 2));
        w.sideCollider.setRotationWrtParent({ x: _q2.x, y: _q2.y, z: _q2.z, w: _q2.w });
      }
    }
  }

  castContact(w) {
    const T = this.P.tire;
    const R = this.R, margin = 0.06;
    const ray = this.ray;
    let maxPen = -1e9, sumW = 0, nx = 0, ny = 0, nz = 0, lat = 0, snLat = 0;
    let deep = null, deepX = 0, deepY = 0, deepZ = 0;
    for (let row = -1; row <= 1; row++) {
      const o = row * 0.34 * T.width;
      const ox = w.hub.x + w.spinAxis.x * o, oy = w.hub.y + w.spinAxis.y * o, oz = w.hub.z + w.spinAxis.z * o;
      for (let k = 0; k < FAN.length; k++) {
        const th = FAN[k];
        const cs = Math.cos(th), sn = Math.sin(th);
        const dx = -w.up.x * cs + w.fwd.x * sn, dy = -w.up.y * cs + w.fwd.y * sn, dz = -w.up.z * cs + w.fwd.z * sn;
        ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
        ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;
        const hit = this.world.castRayAndGetNormal(ray, R + margin, true, undefined, undefined, undefined, this.body);
        if (!hit) continue;
        const pen = R - hit.timeOfImpact;
        const wg = (pen + margin) * (pen + margin);
        if (pen > maxPen) {
          maxPen = pen; deep = hit.collider;
          deepX = ox + dx * hit.timeOfImpact; deepY = oy + dy * hit.timeOfImpact; deepZ = oz + dz * hit.timeOfImpact;
        }
        nx -= dx * wg; ny -= dy * wg; nz -= dz * wg;
        lat += o * wg;
        const hn = hit.normal;
        snLat += (hn.x * w.spinAxis.x + hn.y * w.spinAxis.y + hn.z * w.spinAxis.z) * wg;
        sumW += wg;
      }
    }
    if (sumW === 0) {
      w.contact = false; w.pen = -1; w.collider = null;
      return;
    }
    const n = w.n.set(nx, ny, nz).normalize();
    // add the lateral tilt of the actual surface (side slopes, slanted rock faces)
    n.addScaledVector(w.spinAxis, snLat / sumW).normalize();
    w.pen = maxPen;
    w.latOff = lat / sumW;
    w.contact = maxPen > -margin;
    w.P.copy(w.hub).addScaledVector(w.spinAxis, w.latOff).addScaledVector(n, -(R - Math.max(maxPen, 0)));
    w.collider = deep;
    _v.set(deepX, deepY, deepZ);
    w.surf = this.surfaceAt(deep, _v) || SURFACES.dirt;
  }

  // ------------------------------------------------------------------ simulation step
  step(h, raw) {
    const P = this.P, dt = this.drivetrain, T = P.tire;
    this.time += h;
    this.morphGeometry(h);
    this.readBody();
    this.accel.subVectors(this.vel, this._lastVel).divideScalar(h);
    this._lastVel.copy(this.vel);
    this.speed = this.vel.dot(this.fwd);
    if (raw) this.applyInput(raw, h);
    const c = this.ctl;
    dt.control(h, c, this.speed);

    const up = this.up;
    const gU = -G * up.y;

    for (const ax of this.axles) {
      const p = ax.p;
      ax.mount.set(0, ax.droopY + ax.c, p.z).applyQuaternion(this.quat).add(this.pos);
      this.pointVel(ax.mount, _v);
      ax.vMountU = _v.dot(up);
      ax.rollRateBody = this.angVel.dot(this.back);
      ax.accS[0] = ax.accS[1] = 0; ax.accD[0] = ax.accD[1] = 0; ax.accArb = 0;
    }
    this.updateGeometry();

    const R0 = this.R;
    for (const w of this.wheels) {
      this.castContact(w);
      tireCoefs(T, this.pressures[w.i < 2 ? 0 : 1], w.surf, w.co);
      w.Re = R0 - Math.max(0, w.pen) * 0.33;
      if (w.contact) {
        const n = w.n;
        w.fc.copy(w.fwd).addScaledVector(n, -n.dot(w.fwd)).normalize();
        w.sc.crossVectors(w.fc, n);
        this.pointVel(w.P, _v);
        w.vcx = _v.dot(w.fc);
        w.vcy = _v.dot(w.sc);
      } else { w.vcx = w.vcy = 0; }
      this.pointVel(w.hub, _v);
      w.vHubPerp.copy(_v).addScaledVector(up, -_v.dot(up));
      w.nLocal.copy(w.n).applyQuaternion(_q2.copy(this.quat).invert());
      w.accF.set(0, 0, 0);
      w.FnAvg = 0;
    }

    const S = this.substeps, hs = h / S;
    const hbT = c.handbrake * P.brakes.handbrake;
    // at a standstill the handbrake holds the whole transfer output (all driven wheels), not just the rear axle,
    // so the front can't pull through an open centre diff; fades out above ~2 m/s to keep handbrake turns
    const holdT = c.handbrake > 0.5 ? P.brakes.handbrakeHold * Math.max(0, Math.min(1, 2 - Math.abs(this.speed))) : 0;
    // brakes with a simple 4-channel ABS (releases a wheel that is about to lock, then reapplies)
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      let f = this.absFactor[i];
      const vx = Math.abs(w.vcx);
      const slip = vx > 0.5 ? (dt.w[2 + i] * w.Re - w.vcx) / vx * Math.sign(w.vcx) : 0;
      if (this.abs && c.brake > 0.05 && vx > 1.8 && w.Fn > 0 && slip < -0.16) { f = Math.max(0.05, f - 9 * h); this.absActive = 0.15; }
      else f = Math.min(1, f + 3.5 * h);
      this.absFactor[i] = f;
      this.brakeT[i] = c.brake * f * (i < 2 ? P.brakes.front : P.brakes.rear);
    }
    this.absActive = Math.max(0, this.absActive - h);
    // Traction control (like Land Rover ETC): brake a wheel that spins faster than the ground under it.
    // An open diff always splits torque evenly, so braking the spinning wheel lets the others drive.
    // Works across the axle diffs and, when a whole axle spins, across the centre diff too.
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      let T = this.tcT[i];
      if (this.tc && c.throttle > 0.05 && dt.running) {
        const surfV = dt.w[2 + i] * w.Re;
        const ref = w.contact && w.Fn > 0 ? w.vcx : this.speed;
        const excess = Math.sign(surfV) === Math.sign(ref) || Math.abs(ref) < 0.05 ? Math.abs(surfV) - Math.abs(ref) : Math.abs(surfV) + Math.abs(ref);
        const thr = 0.7 + 0.12 * Math.abs(ref);
        // full authority while crawling and climbing, fading out at speed
        const tMax = 2400 * Math.max(0.15, Math.min(1, 1 - (Math.abs(this.speed) - 8) / 12));
        if (excess > thr) { T = Math.min(tMax, T + h * 9000 * (excess - thr) + h * 600); this.tcActive = 0.3; }
        else T = Math.max(0, T - h * (excess < thr * 0.5 ? 9000 : 3000));
      } else T = Math.max(0, T - h * 8000);
      this.tcT[i] = T;
      this.brakeT[i] = Math.max(this.brakeT[i], T);
    }
    this.tcActive = Math.max(0, this.tcActive - h);
    let tpf = 0, tpr = 0, engA = 0;

    for (let k = 0; k < S; k++) {
      // a. normal loads
      for (const w of this.wheels) {
        this.hubPenDot(w);
        if (w.contact && w.pen > 0) {
          let Fn = w.co.kt * w.pen + T.damping * w.penDot;
          const rimLim = (this.R - T.rimRadius * this.R / T.radius) * 0.62;
          if (w.pen > rimLim) Fn += 2.5e6 * (w.pen - rimLim) + 3000 * Math.max(0, w.penDot);
          w.Fn = Math.max(0, Fn);
        } else w.Fn = 0;
      }
      // b. tyre forces
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        const om = dt.w[2 + i];
        if (w.Fn > 0) {
          const vsx = om * w.Re - w.vcx;
          tireForces(w, w.Fn, vsx, -w.vcy, Math.hypot(w.vcx, w.vcy), w.surf, w.co);
        } else { w.Fx = 0; w.Fy = 0; }
        this.tireT[i] = -w.Fx * w.Re;
        this.rrT[i] = (w.Fn > 0 ? w.co.crr * w.Fn * w.Re : 0) + 2.5;
      }
      // c. drivetrain
      dt.substep(hs, this.tireT, this.rrT, this.brakeT, hbT, holdT);
      tpf += dt.propTorque[0]; tpr += dt.propTorque[1]; engA += dt.engineAlpha;
      // d. tyre transient state
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        if (w.Fn > 0) {
          const vsx = dt.w[2 + i] * w.Re - w.vcx;
          tireRelax(w, hs, vsx, -w.vcy, Math.abs(w.vcx), w.surf, w.co);
          w.slipVel = Math.hypot(vsx, w.vcy);
        } else {
          const d = Math.exp(-hs * 30);
          w.ux *= d; w.uy *= d; w.slipVel = 0;
        }
      }
      // e. axle dynamics
      for (const ax of this.axles) this.axleSubstep(ax, hs, gU, ax.i === 0 ? dt.propTorque[0] : dt.propTorque[1]);
      // f. tyre deflection follows the hub
      for (const w of this.wheels) {
        this.hubPenDot(w);
        if (w.contact) w.pen += hs * w.penDot;
      }
    }

    // ---- apply averaged forces to the chassis
    const b = this.body;
    b.resetForces(true);
    b.resetTorques(true);
    const inv = 1 / S;
    for (const w of this.wheels) {
      w.accF.multiplyScalar(inv);
      w.FnAvg *= inv;
      b.addForceAtPoint(w.accF, w.hub, true);
    }
    for (const ax of this.axles) {
      const p = ax.p;
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        _v2.set(side * p.springTrack / 2, ax.droopY + ax.c, p.z).applyQuaternion(this.quat).add(this.pos);
        _v.copy(up).multiplyScalar(ax.accS[s] * inv);
        b.addForceAtPoint(_v, _v2, true);
        _v2.set(side * p.damperTrack / 2, ax.droopY + ax.c, p.z).applyQuaternion(this.quat).add(this.pos);
        _v.copy(up).multiplyScalar(ax.accD[s] * inv);
        b.addForceAtPoint(_v, _v2, true);
      }
      // unsprung weight is carried by the axle DOF along 'up'; remove it from the chassis
      _v.copy(up).multiplyScalar(p.mass * G * up.y);
      b.addForceAtPoint(_v, ax.A, true);
    }
    // anti-roll bars + drivetrain torque reactions (engine rock, axle wrap) about the roll axis
    let rollT = 0;
    for (const ax of this.axles) rollT -= ax.accArb * inv;
    rollT -= (P.engine.inertia * engA + tpf + tpr) * inv;
    _v.copy(this.back).multiplyScalar(rollT);
    b.addTorque(_v, true);
    // aero drag
    const v2 = this.vel.lengthSq();
    if (v2 > 0.01) {
      _v.copy(this.vel).multiplyScalar(-0.5 * P.aero.rho * P.aero.cdA * Math.sqrt(v2));
      b.addForce(_v, true);
    }

    for (let i = 0; i < 4; i++) this.wheels[i].spin += dt.w[2 + i] * h;
    this.steerCompliance(h);
  }

  // Steering compliance. The front tyres' side force acts behind the kingpins (caster trail + pneumatic
  // trail), and the box, drag link and track rod are not rigid, so the wheels yield a little towards
  // smaller slip angles. That is a big part of a real truck's understeer. The pneumatic trail shrinks as
  // the tyre slides (s -> 1), which is why the steering goes light at the limit.
  steerCompliance(h) {
    const S = this.P.steer;
    if (!S.stiffness) { this.steerComp = 0; return; }
    let M = 0;
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      if (w.Fn <= 0) continue;
      const tp = S.pneuTrail * Math.max(0, 1 - w.slipNorm);
      M += w.Fy * (S.casterTrail + tp);
    }
    const target = Math.max(-0.06, Math.min(0.06, -M / S.stiffness));
    this.steerComp += (target - this.steerComp) * Math.min(1, h * 60); // steering system lag (~25 Hz)
  }

  hubPenDot(w) {
    const ax = w.axle;
    const vU = ax.vz + w.side * (this.P.track / 2) * Math.cos(ax.phi) * ax.Om;
    const n = w.n, up = this.up;
    const v = w.vHubPerp;
    w.penDot = -((v.x + up.x * vU) * n.x + (v.y + up.y * vU) * n.y + (v.z + up.z * vU) * n.z);
  }

  // Coil spring + bump stop + droop limit, at the spring seat. x = compression, xd = compression rate.
  springForce(p, x, xd, k = p.k) {
    let F = Math.max(0, k * (x + p.preload));
    const bs = x - (p.travel - 0.05);
    if (bs > 0) {
      // progressive rubber bump stop with hysteresis: it gives back less than it took (no pogo off the stops)
      const el = 220000 * bs + 8e6 * bs * bs;
      F += (xd > 0 ? el : 0.55 * el) + (xd > 0 ? 6000 * xd * Math.min(1, bs / 0.02) : 0);
    }
    if (x > p.travel) F += 3e6 * (x - p.travel) + (xd > 0 ? 25000 * xd : 0);
    if (x < 0) F += 1.6e6 * x + (xd < 0 ? 12000 * xd : 0);
    return F;
  }

  // Digressive damper: linear up to the knee, then a shallower slope (blow-off).
  damperForce(p, xd) {
    const cd = xd > 0 ? p.bump : p.rebound;
    const v = Math.abs(xd), knee = p.damperKnee;
    const Fd = v < knee ? cd * v : cd * (knee + p.damperHigh * (v - knee));
    return xd > 0 ? Fd : -Fd;
  }

  axleSubstep(ax, hs, gU, propT) {
    const p = ax.p, up = this.up;
    const wl = this.wheels[ax.i * 2], wr = this.wheels[ax.i * 2 + 1];
    // tyre force components along body-up go into the axle, the rest straight into the chassis
    // roll moment on the axle: full tyre force about the axle centre (vertical loads at +-track/2 and
    // side forces acting at the contact patch, below the axle, which is located by the panhard rod)
    let FuL = 0, FuR = 0, tyreRoll = 0;
    const back = this.back;
    for (const w of [wl, wr]) {
      const Fn = w.Fn, Fx = w.Fx, Fy = w.Fy;
      _v.copy(w.n).multiplyScalar(Fn).addScaledVector(w.fc, Fx).addScaledVector(w.sc, Fy);
      _v2.subVectors(w.P, ax.A);
      _v3.crossVectors(_v2, _v);
      tyreRoll += _v3.dot(back);
      const fu = _v.dot(up);
      _v.addScaledVector(up, -fu);
      w.accF.add(_v);
      w.FnAvg += Fn;
      if (w === wl) FuL = fu; else FuR = fu;
    }
    const s2 = p.springTrack / 2, t2 = this.P.track / 2;
    const sn = Math.sin(ax.phi), cs = Math.cos(ax.phi);
    const cd = ax.vz - ax.vMountU;
    const pd = ax.Om - ax.rollRateBody;
    const SL = this.springForce(p, ax.c - s2 * sn, cd - s2 * cs * pd, ax.k);
    const SR = this.springForce(p, ax.c + s2 * sn, cd + s2 * cs * pd, ax.k);
    const d2 = p.damperTrack / 2;
    const DL = this.damperForce(p, cd - d2 * cs * pd);
    const DR = this.damperForce(p, cd + d2 * cs * pd);
    const arb = -p.arb * ax.phi;
    const heave = (FuL + FuR - SL - SR - DL - DR) / p.mass + gU;
    const roll = (tyreRoll - (SR - SL) * s2 * cs - (DR - DL) * d2 * cs + arb + propT) / p.rollInertia;
    ax.vz += hs * heave;
    ax.Om += hs * roll;
    ax.c += hs * (ax.vz - ax.vMountU);
    ax.phi += hs * (ax.Om - ax.rollRateBody);
    ax.S[0] = SL + DL; ax.S[1] = SR + DR;
    ax.accS[0] += SL; ax.accS[1] += SR;
    ax.accD[0] += DL; ax.accD[1] += DR;
    ax.accArb += arb;
  }

  // put the truck back on its wheels
  reset(position, yaw) {
    const b = this.body;
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    b.setTranslation(position, true);
    b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const ax of this.axles) { ax.vz = 0; ax.Om = 0; ax.phi = 0; }
    for (const w of this.wheels) { w.ux = w.uy = 0; }
    const d = this.drivetrain;
    for (let i = 2; i < 6; i++) d.w[i] = 0;
    // the wheels stop dead: drop the converter lock-up and let the engine ride it out (a teleport at
    // speed in a locked-up gear used to stall it)
    d.lockup = 0;
    if (d.mode === 'auto') d.w[1] = 0;
    if (d.running) d.startGrace = Math.max(d.startGrace, 0.6);
    this.snapGeometry();
    this.readBody();
    this._lastVel.set(0, 0, 0);
    this.updateGeometry();
  }

  yaw() {
    return Math.atan2(-this.fwd.x, -this.fwd.z);
  }
}
