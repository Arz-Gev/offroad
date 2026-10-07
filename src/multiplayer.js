import * as THREE from 'three';
import { buildCarModel } from './vehicle/model/index.js';
import { makeCarParams } from './vehicle/carParams.js';
import { isCar, DEFAULT_CAR } from './cars/index.js';
import { cornerKin } from './vehicle/suspension.js';
import { VehicleView } from './vehicle/vehicleView.js';
import { escapeHTML } from './hud.js';

// Drive together: friends join a room from an invite link (?room=<id>). Peer to peer (WebRTC, Trystero;
// public Nostr relays only introduce the browsers to each other), no server of our own.
//
// Every player simulates only their own truck and sends its state 20 times a second. Friends' trucks are
// drawn ~0.1 s behind from those snapshots (interpolated, extrapolated for a moment when packets are late)
// through the normal VehicleView, fed by a proxy object with the fields the view reads. No physics, no
// sound and no lamp beams for them (a spot light per truck would change the lights hash and recompile
// every shader); the lenses still glow. "Solid trucks" puts the friend's collision boxes on a kinematic
// body in our world: we bounce off it, they bounce off ours on their side.

const APP_ID = 'offroad-defender-arzgev';
const SEND_HZ = 20;
const DELAY = 0.1;          // playback delay behind the newest snapshot (s)
const EXTRAP = 0.3;         // longest extrapolation when packets are late (s)
const BUF = 40;             // snapshots kept per friend
const PUPPET_W = 2 * Math.PI * 2;                                     // solid trucks: spring to the network pose (rad/s)
const GROUP_PUPPET = (0x0004 << 16) | (0xffff & ~0x0001);             // everything but the ground heightfield (Vehicle.js GROUND_BIT)

// state packet layout (one flat array, JSON), from the car's axle count: per axle [a, b] (beam axle: heave,
// roll; independent: left and right compression) and its droop height, per wheel [steer, spin, pen], and
// for a car with a turret [yaw, pitch, shots fired]. A 4x4's layout is the one the game always sent.
function layout(nA, turret) {
  const S = { t: 0, pos: 1, quat: 4, vel: 8, ax: 11, droop: 11 + 2 * nA };
  S.R = S.droop + nA; S.steer = S.R + 1; S.speed = S.R + 2; S.rpm = S.R + 3; S.brake = S.R + 4; S.flags = S.R + 5; S.wheels = S.R + 6;
  S.turret = S.wheels + 6 * nA;
  S.N = S.turret + (turret ? 3 : 0);
  S.nA = nA;
  return S;
}
const layoutFor = P => layout(P.axles.length, !!P.turret);
const S = layout(2, false);   // only for the fields every layout shares (t, pos, quat, vel); per car: p.S, this.S

const r3 = x => Math.round(x * 1000) / 1000;
const r4 = x => Math.round(x * 10000) / 10000;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export const roomFromURL = () => {
  const r = new URLSearchParams(location.search).get('room');
  return r && /^[a-z0-9-]{3,40}$/i.test(r) ? r : null;
};
const inviteURL = id => `${location.origin}${location.pathname}?room=${id}`;
const newRoomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

// the fields VehicleView reads from a Vehicle
function makeProxy(P) {
  const axles = P.axles.map((p, i) => ({ p, i, droopY: p.droopY, c: 0, phi: 0, ind: p.type === 'independent', kin: p.type === 'independent' ? cornerKin(P, p, P.tire.radius) : null }));
  return {
    P, R: P.tire.radius, steerAngle: 0, speed: 0,
    ctl: { brake: 0 },
    drivetrain: { rpm: 800, running: true, mode: 'auto', selector: 'D', manualGear: 1, range: 'high' },
    axles,
    wheels: Array.from({ length: 2 * P.axles.length }, (_, i) => ({ axle: axles[i >> 1], side: i % 2 ? 1 : -1, steer: 0, spin: 0, contact: false, pen: -1, c: 0, out: 0, camber: 0, nLocal: new THREE.Vector3(0, 1, 0) })),
    turret: P.turret ? { yaw: 0, pitch: 0, recoil: 0, shots: 0 } : null,
  };
}

export class Multiplayer {
  // api: { RAPIER, world, scene, vehicle, view, settings, say(key, html, kind), placeNear(x, z, yaw) }
  constructor(api) {
    this.api = api;
    this.room = null;
    this.roomId = null;
    this.peers = new Map();
    this.sendAcc = 0;
    this.follow = false;      // joined from a link: go to the first friend we hear from
    this.gotoIndex = 0;
    this.tags = document.createElement('div');
    this.tags.id = 'mp-tags';
    document.body.appendChild(this.tags);
    window.addEventListener('pagehide', () => this.room?.leave());
  }

  get name() {
    let n = this.api.settings.get('name');
    if (!n) { n = `Driver ${10 + Math.floor(Math.random() * 90)}`; this.api.settings.set('name', n, { silent: true }); }
    return n;
  }
  get count() { return this.peers.size; }
  get note() {
    if (!this.room) return 'Not connected. Invite copies a link to send; whoever opens it spawns next to you.';
    const names = [...this.peers.values()].map(p => p.name).filter(Boolean);
    return `Room ${this.roomId} · ${names.length ? `with ${names.join(', ')}` : 'waiting for friends to open the link'}`;
  }

  async join(id, { follow = false } = {}) {
    if (this.room) return;
    this.roomId = id;
    this.follow = follow;
    const { joinRoom } = await import('trystero');
    const room = this.room = joinRoom({ appId: APP_ID }, id);
    this.hello = room.makeAction('hello');
    this.state = room.makeAction('st');
    room.onPeerJoin = peerId => { this.peer(peerId); this.hello.send(this.helloData(), { target: peerId }); };
    room.onPeerLeave = peerId => this.drop(peerId);
    this.hello.onMessage = (h, { peerId }) => this.onHello(peerId, h);
    this.state.onMessage = (s, { peerId }) => this.onState(peerId, s);
    this.api.changed?.();
  }

  // Invite: start a room if needed, then copy its link
  async invite() {
    if (!this.room) {
      const id = newRoomId();
      history.replaceState(null, '', `?room=${id}`);
      await this.join(id);
    }
    const url = inviteURL(this.roomId);
    try {
      await navigator.clipboard.writeText(url);
      this.api.say('mp', 'Invite link copied: send it to your friends', 'good');
    } catch {
      window.prompt('Copy this link and send it to your friends:', url);
    }
  }

  leave() {
    if (!this.room) return;
    this.room.leave();
    this.room = null;
    for (const id of [...this.peers.keys()]) this.drop(id, true);
    history.replaceState(null, '', location.pathname);
    this.api.say('mp', 'Left the room');
    this.api.changed?.();
  }

  rename() {
    const n = window.prompt('Your name (friends see it over your truck):', this.name);
    if (n == null) return;
    const clean = n.trim().slice(0, 20);
    if (!clean) return;
    this.api.settings.set('name', clean, { silent: true });
    this.hello?.send(this.helloData());
    this.api.changed?.();
  }

  // teleport next to a friend (cycles through them)
  gotoFriend() {
    const list = [...this.peers.values()].filter(p => p.snaps.length);
    if (!list.length) { this.api.say('mp', this.room ? 'No friends in the room yet' : 'Invite friends first', 'warn'); return; }
    const p = list[this.gotoIndex++ % list.length];
    this.placeBeside(p);
    this.api.say('mp', `Next to ${escapeHTML(p.name || 'your friend')}`, 'good');
  }

  placeBeside(p) {
    const s = p.snaps[p.snaps.length - 1];
    _q.set(s[S.quat], s[S.quat + 1], s[S.quat + 2], s[S.quat + 3]);
    const right = _v.set(1, 0, 0).applyQuaternion(_q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_q);
    this.api.placeNear(s[S.pos] + right.x * 4.5, s[S.pos + 2] + right.z * 4.5, Math.atan2(-fwd.x, -fwd.z));
  }

  helloData() {
    const P = this.api.vehicle.P;
    return { name: this.name, car: P.car, tw: P.tire.width, sr: P.steer.ratio, tr: P.tire.radius };
  }

  // ------------------------------------------------------------------ friends
  peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      p = { id, name: '', car: null, S: null, snaps: [], off: null, model: null, view: null, proxy: null, body: null, tag: null, building: false };
      this.peers.set(id, p);
    }
    return p;
  }

  onHello(id, h) {
    if (!h || typeof h !== 'object') return;
    const p = this.peer(id);
    const isNew = !p.name;
    p.name = String(h.name || 'Friend').slice(0, 20);
    if (p.tag) p.tag.textContent = p.name;
    if (isNew) this.api.say('mp-' + id, `${escapeHTML(p.name)} joined`, 'good');
    this.api.changed?.();
    const car = isCar(h.car) ? h.car : DEFAULT_CAR;
    p.lastHello = h;
    if (p.car !== car || !p.model) { p.car = car; p.S = layoutFor(makeCarParams(car)); p.snaps.length = 0; this.build(p, h); }
    else if (p.proxy) { p.proxy.P.tire.width = +h.tw || p.proxy.P.tire.width; p.proxy.P.steer.ratio = +h.sr || p.proxy.P.steer.ratio; }
  }

  async build(p, h) {
    if (p.building) return;
    p.building = true;
    const car = p.car;
    try {
      const P = makeCarParams(car);
      if (+h.tw) P.tire.width = +h.tw;
      if (+h.sr) P.steer.ratio = +h.sr;
      if (+h.tr) P.tire.radius = +h.tr;
      const model = await buildCarModel(car);
      // no lamp beams for friends (see the header): only the lens glow
      for (const L of [model.lights.head, ...model.lights.aux, model.lights.rear]) { L.parent?.remove(L); L.target.parent?.remove(L.target); }
      if (!this.peers.has(p.id)) return;    // left while loading
      this.removeModel(p);
      p.proxy = makeProxy(P);
      p.model = model;
      p.view = new VehicleView(model, p.proxy);
      model.root.visible = false;           // until the first snapshot
      this.api.scene.add(model.root);
      if (!p.tag) {
        p.tag = document.createElement('div');
        p.tag.className = 'mp-tag';
        this.tags.appendChild(p.tag);
      }
      p.tag.textContent = p.name;
      this.syncBody(p);
    } catch (e) { console.warn('multiplayer: could not build the friend\'s truck', e); }
    finally { p.building = false; }
    if (this.peers.has(p.id) && p.car !== car) this.build(p, p.lastHello);   // the friend switched cars meanwhile
  }

  removeModel(p) {
    if (p.model) { this.api.scene.remove(p.model.root); p.model = null; p.view = null; }
    if (p.body) { this.api.world.removeRigidBody(p.body); p.body = null; }
  }

  drop(id, quiet = false) {
    const p = this.peers.get(id);
    if (!p) return;
    this.removeModel(p);
    p.tag?.remove();
    this.peers.delete(id);
    if (!quiet && p.name) this.api.say('mp-' + id, `${escapeHTML(p.name)} left`);
    this.api.changed?.();
  }

  onState(id, s) {
    const p = this.peer(id);
    if (!p.S || !Array.isArray(s) || s.length !== p.S.N || !s.every(Number.isFinite)) return;   // layout known from the hello
    // clock offset to the sender: the smallest seen (the fastest packet), creeping up slowly for drift
    const off = performance.now() / 1000 - s[S.t];
    p.off = p.off === null || off < p.off ? off : p.off + (off - p.off) * 0.01;
    const last = p.snaps[p.snaps.length - 1];
    if (last && s[S.t] <= last[S.t]) return;
    p.snaps.push(s);
    if (p.snaps.length > BUF) p.snaps.shift();
    if (this.follow && p.snaps.length === 1) { this.follow = false; this.placeBeside(p); }
  }

  // the friend's state at local time t: interpolated between snapshots into `out` (a flat array)
  sample(p, t, out) {
    const sn = p.snaps, S = p.S, N = S?.N;
    if (!sn.length || !S) return false;
    const ts = t - p.off - DELAY;          // in the sender's clock
    let i = sn.length - 1;
    while (i > 0 && sn[i - 1][S.t] > ts) i--;
    const b = sn[i], a = i > 0 ? sn[i - 1] : null;
    if (!a || ts >= b[S.t]) {
      // newer than everything: hold, moving on along the last velocity for a moment
      for (let k = 0; k < N; k++) out[k] = b[k];
      const dt = Math.min(EXTRAP, Math.max(0, ts - b[S.t]));
      for (let k = 0; k < 3; k++) out[S.pos + k] += b[S.vel + k] * dt;
      return true;
    }
    const f = Math.min(1, Math.max(0, (ts - a[S.t]) / Math.max(1e-4, b[S.t] - a[S.t])));
    for (let k = 0; k < N; k++) out[k] = a[k] + (b[k] - a[k]) * f;
    _q.set(a[S.quat], a[S.quat + 1], a[S.quat + 2], a[S.quat + 3]);
    _q2.set(b[S.quat], b[S.quat + 1], b[S.quat + 2], b[S.quat + 3]);
    _q.slerp(_q2, f);
    out[S.quat] = _q.x; out[S.quat + 1] = _q.y; out[S.quat + 2] = _q.z; out[S.quat + 3] = _q.w;
    out[S.flags] = b[S.flags];
    if (N > S.turret) {
      // turret yaw the short way round, shots as counted
      let d = b[S.turret] - a[S.turret];
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      out[S.turret] = a[S.turret] + d * f;
      out[S.turret + 2] = b[S.turret + 2];
    }
    return true;
  }

  // ------------------------------------------------------------------ solid trucks
  // The friend's truck as a "puppet" in our world: a dynamic body with its real mass and inertia, no
  // gravity, pulled onto the network pose by a stiff critically damped spring (2 Hz). A kinematic body
  // would be an immovable wall: we stopped dead against it and the friend felt almost nothing. The
  // puppet gets shoved, we lose speed as against a real truck, and the friend's game sees our puppet
  // push into their real truck. It ignores the ground heightfield (the friend's wheels hold it up).
  syncBody(p) {
    const solid = !!this.api.settings.get('solidTrucks');
    if (!solid || !p.proxy) {
      if (p.body) { this.api.world.removeRigidBody(p.body); p.body = null; }
      return;
    }
    if (p.body) return;
    const { RAPIER, world } = this.api, P = p.proxy.P;
    const mass = P.axles.reduce((m, a) => m + a.mass, P.bodyMass);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -500, 0).setGravityScale(0).setCanSleep(false).setCcdEnabled(true)
      .setAdditionalMassProperties(mass, { x: P.com[0], y: P.com[1], z: P.com[2] },
        { x: P.bodyInertia[0], y: P.bodyInertia[1], z: P.bodyInertia[2] }, { x: 0, y: 0, z: 0, w: 1 }));
    for (const [cx, cy, cz, hx, hy, hz, r0] of P.colliders) {
      const r = Math.max(0, Math.min(r0, hx - 0.002, hy - 0.002, hz - 0.002));
      world.createCollider(RAPIER.ColliderDesc.roundCuboid(hx - r, hy - r, hz - r, r)
        .setTranslation(cx, cy, cz).setDensity(0).setFriction(0.5).setRestitution(0)
        .setCollisionGroups(GROUP_PUPPET), body);
    }
    p.body = body;
    p.mass = mass;
    p.inertia = (P.bodyInertia[0] + P.bodyInertia[1] + P.bodyInertia[2]) / 3;
    p.bodyPlaced = false;
    p.qPrev = new THREE.Quaternion();
  }
  setSolid() { for (const p of this.peers.values()) this.syncBody(p); }

  // before each physics step (h): pull the puppets towards where the friends are at that instant
  stepBodies(t, h) {
    if (!this.peers.size) return;
    const out = this._sb || (this._sb = new Float64Array(256));
    const w = PUPPET_W, kp = w * w * h, kd = 2 * w * h;
    for (const p of this.peers.values()) {
      if (!p.body || !this.sample(p, t, out)) continue;
      const b = p.body, x = b.translation(), lv = b.linvel(), av = b.angvel();
      const tq = _q.set(out[S.quat], out[S.quat + 1], out[S.quat + 2], out[S.quat + 3]).normalize();
      const ex = out[S.pos] - x.x, ey = out[S.pos + 1] - x.y, ez = out[S.pos + 2] - x.z;
      if (!p.bodyPlaced || ex * ex + ey * ey + ez * ez > 25) {
        // first frame or a teleport: snap
        b.setTranslation({ x: out[S.pos], y: out[S.pos + 1], z: out[S.pos + 2] }, true);
        b.setRotation({ x: tq.x, y: tq.y, z: tq.z, w: tq.w }, true);
        b.setLinvel({ x: out[S.vel], y: out[S.vel + 1], z: out[S.vel + 2] }, true);
        b.setAngvel({ x: 0, y: 0, z: 0 }, true);
        p.qPrev.copy(tq); p.bodyPlaced = true;
        continue;
      }
      const m = p.mass;
      b.applyImpulse({ x: m * (kp * ex + kd * (out[S.vel] - lv.x)), y: m * (kp * ey + kd * (out[S.vel + 1] - lv.y)), z: m * (kp * ez + kd * (out[S.vel + 2] - lv.z)) }, true);
      // rotation error and the target's spin rate (from the last target), as axis * angle
      const r = b.rotation();
      const e = _q2.set(r.x, r.y, r.z, r.w).invert().premultiply(tq);
      const se = e.w < 0 ? -2 : 2;
      const d = p.qPrev.invert().premultiply(tq);
      const sd = (d.w < 0 ? -2 : 2) / h, wx = sd * d.x, wy = sd * d.y, wz = sd * d.z;
      p.qPrev.copy(tq);
      const I = p.inertia;
      b.applyTorqueImpulse({
        x: I * (kp * se * e.x + kd * (wx - av.x)),
        y: I * (kp * se * e.y + kd * (wy - av.y)),
        z: I * (kp * se * e.z + kd * (wz - av.z)),
      }, true);
    }
  }

  // ------------------------------------------------------------------ per frame
  // t: the local time the physics state stands for; send ours, draw theirs
  update(dt, t, env) {
    if (!this.room) return;
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ && this.peers.size) {
      this.sendAcc = Math.min(this.sendAcc - 1 / SEND_HZ, 0.1);
      this.state.send(this.pack(t));
    }
    const out = this._uo || (this._uo = new Float64Array(256));
    for (const p of this.peers.values()) {
      if (!p.view || !this.sample(p, t, out)) continue;
      this.apply(p, out, dt, env);
    }
  }

  pack(t) {
    const v = this.api.vehicle, ls = this.api.view.lights, d = v.drivetrain;
    const S = this.S || (this.S = layoutFor(v.P)), nA = S.nA;
    const s = new Array(S.N);
    s[S.t] = r4(t);
    s[S.pos] = r3(v.pos.x); s[S.pos + 1] = r3(v.pos.y); s[S.pos + 2] = r3(v.pos.z);
    s[S.quat] = r4(v.quat.x); s[S.quat + 1] = r4(v.quat.y); s[S.quat + 2] = r4(v.quat.z); s[S.quat + 3] = r4(v.quat.w);
    s[S.vel] = r3(v.vel.x); s[S.vel + 1] = r3(v.vel.y); s[S.vel + 2] = r3(v.vel.z);
    for (let a = 0; a < nA; a++) {
      const ax = v.axles[a];
      if (ax.ind) { s[S.ax + a * 2] = r4(v.wheels[2 * a].c); s[S.ax + a * 2 + 1] = r4(v.wheels[2 * a + 1].c); }
      else { s[S.ax + a * 2] = r4(ax.c); s[S.ax + a * 2 + 1] = r4(ax.phi); }
      s[S.droop + a] = r4(ax.droopY);
    }
    s[S.R] = r4(v.R);
    s[S.steer] = r4(v.steerAngle);
    s[S.speed] = r3(v.speed);
    s[S.rpm] = Math.round(d.rpm);
    s[S.brake] = r3(v.ctl.brake);
    const rev = d.mode === 'manual' ? d.manualGear < 0 : d.selector === 'R';
    s[S.flags] = ls.head | (ls.aux ? 4 : 0) | (ls.hazard ? 8 : 0) | (d.running ? 16 : 0) | (rev ? 32 : 0) | (d.range === 'low' ? 64 : 0);
    for (let i = 0; i < 2 * nA; i++) {
      const w = v.wheels[i], k = S.wheels + i * 3;
      s[k] = r4(w.steer); s[k + 1] = r3(w.spin); s[k + 2] = r4(w.contact ? w.pen : -1);
    }
    if (S.N > S.turret) { const T = v.turret; s[S.turret] = r4(T.yaw); s[S.turret + 1] = r4(T.pitch); s[S.turret + 2] = T.shots; }
    return s;
  }

  apply(p, s, dt, env) {
    const x = p.proxy, S = p.S, f = s[S.flags];
    for (let a = 0; a < S.nA; a++) {
      const ax = x.axles[a];
      ax.droopY = s[S.droop + a];
      if (!ax.ind) { ax.c = s[S.ax + a * 2]; ax.phi = s[S.ax + a * 2 + 1]; continue; }
      // independent corners: compression of each, the kinematic curves give camber and lateral path
      for (let k = 0; k < 2; k++) {
        const w = x.wheels[2 * a + k], dc = (w.c = s[S.ax + a * 2 + k]) - ax.kin.c0;
        w.camber = ax.kin.g * dc; w.out = ax.kin.hubOut * dc;
      }
      ax.c = (x.wheels[2 * a].c + x.wheels[2 * a + 1].c) / 2;
    }
    x.R = s[S.R]; x.steerAngle = s[S.steer]; x.speed = s[S.speed]; x.ctl.brake = s[S.brake];
    const d = x.drivetrain;
    d.rpm = s[S.rpm]; d.running = !!(f & 16); d.selector = f & 32 ? 'R' : 'D'; d.range = f & 64 ? 'low' : 'high';
    for (let i = 0; i < 2 * S.nA; i++) {
      const w = x.wheels[i], k = S.wheels + i * 3;
      w.steer = s[k]; w.spin = s[k + 1]; w.pen = s[k + 2]; w.contact = s[k + 2] > -0.5;
    }
    if (x.turret && S.N > S.turret) {
      const T = x.turret, shots = s[S.turret + 2];
      T.yaw = s[S.turret]; T.pitch = s[S.turret + 1];
      if (shots > T.shots && T.shots > 0) this.api.friendShots?.(p, shots - T.shots);   // muzzle flash + tracer on our side
      T.shots = shots;
    }
    p.view.lights.head = f & 3; p.view.lights.aux = !!(f & 4); p.view.lights.hazard = !!(f & 8);
    _v.set(s[S.pos], s[S.pos + 1], s[S.pos + 2]);
    _q.set(s[S.quat], s[S.quat + 1], s[S.quat + 2], s[S.quat + 3]).normalize();
    p.model.root.visible = true;
    p.view.update(_v, _q, dt, env);
  }

  // name tags over the friends' trucks (after the camera moved)
  updateTags(camera) {
    for (const p of this.peers.values()) {
      if (!p.tag) continue;
      const r = p.model?.root;
      let show = false;
      if (r?.visible) {
        _v.set(0, 2.6, 0).applyQuaternion(r.quaternion).add(r.position);
        const dist = _v.distanceTo(camera.position);
        _v.project(camera);
        show = _v.z < 1 && dist < 600 && Math.abs(_v.x) < 1.2 && Math.abs(_v.y) < 1.2;
        if (show) {
          const X = (_v.x * 0.5 + 0.5) * window.innerWidth, Y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
          p.tag.style.transform = `translate(${X.toFixed(1)}px, ${Y.toFixed(1)}px) translate(-50%, -100%)`;
          const o = dist < 150 ? 1 : Math.max(0.35, 1 - (dist - 150) / 450);
          if (p.tagO !== o) { p.tag.style.opacity = o.toFixed(2); p.tagO = o; }
        }
      }
      if (p.tagShown !== show) { p.tag.hidden = !show; p.tagShown = show; }
    }
  }
}
