import * as THREE from 'three';
import { ballisticStep, trajectory } from './vehicle/turret.js';
import { SURFACES } from './vehicle/tire.js';

// Gunnery: the turret's guns in the world. Every physics step the turret (vehicle/turret.js) drives and
// cycles its guns; each round fired becomes a point mass with drag flown at 240 Hz, and the stretch it
// covers in a step is ray cast in the Rapier world (our own hull excluded). A hit makes dust, sparks or
// splinters by surface, pushes a body that can move, and on rock or concrete a shallow hit ricochets.
// Rounds that cross a water surface splash and stop. The recoil impulse goes into our hull at the
// trunnions. Visuals: tracers (rounds with `tracer` set; every round on the BTR, burning ~3 s), muzzle flash and smoke, impact particles.
// The muzzle flash is real photographed flames (public/fx, cut out of night photos by assets-src/muzzleflash/key.py)
// on a strip that starts at the rendered muzzle and turns about the bore to face the camera, plus a front view
// seen down the barrel. Each shot picks a flame, flip, length, width and rotation at random. Two lights flash
// with it (always in the scene at intensity 0 between shots, so the lights hash never changes):
//   - a wide spot from the gas ball, aimed along the bore and down: it lights the ground ahead and around the
//     nose, trees and banks. Behind and beside the light the hull blocks the flash on the real vehicle; the
//     cone leaves that out, which a point light could only do with a cube shadow (one texture unit too many
//     for the terrain shader, which already binds 14 of the 16)
//   - a short-range point light: the barrel, the turret front and the hull roof right under the muzzle
// No shadows. By day they keep FLASH_DAY of their night strength.

const MAX_ROUNDS = 400, MAX_TRACERS = 160, MAX_FX = 1600;
const TRACER_BURN = 3.0;          // s (BZT tracer burns out at ~2 km)
const FLASH_ROWS = 3, FLASH_FRONTS = 3;   // flames in public/fx/muzzle-side.png (rows of 4) and muzzle-front.png (2x2)
// candela at full flash (KPVT; scaled by the weapon's `flash`): spot and near glow, ranges, daylight share
const FLASH_CD = 200, GLOW_CD = 3, FLASH_RANGE = 45, GLOW_RANGE = 3.5, FLASH_DAY = 0.12;
const FLASH_ANGLE = 80 * Math.PI / 180;   // cone half-angle about the bore tilted ~40 deg down
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qg = new THREE.Quaternion(), _t = new THREE.Vector3(), _t2 = new THREE.Vector3();

let flashMaps = null;
function flashTextures() {
  if (flashMaps) return flashMaps;
  const L = new THREE.TextureLoader(), base = import.meta.env.BASE_URL + 'fx/';
  const load = f => { const t = L.load(base + f); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  return (flashMaps = { side: load('muzzle-side.png'), front: load('muzzle-front.png') });
}

// one muzzle's flash: two quads placed in the vertex shader (world space, from uniforms)
//   kind 0: the flame strip, x 0..1 from the muzzle along the bore, y -1..1 across it, turned to the camera
//   kind 1: the front view, a camera-facing quad just ahead of the muzzle, seen when looking down the bore
class MuzzleFlash {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const T = flashTextures();
    this.u = {
      tSide: { value: T.side }, tFront: { value: T.front },
      uO: { value: new THREE.Vector3() }, uA: { value: new THREE.Vector3(0, 0, -1) },
      uLen: { value: 1 }, uWid: { value: 0.5 }, uFront: { value: 0.4 }, uRot: { value: 0 }, uFlip: { value: 1 },
      uRow: { value: 0 }, uCell: { value: 0 }, uI: { value: 0 }, uFrontI: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: `uniform vec3 uO, uA; uniform float uLen, uWid, uFront, uRot, uFlip;
        varying vec2 vUv; varying float vKind, vW;
        void main() {
          vec3 V = normalize(cameraPosition - uO);
          float facing = abs(dot(V, uA));
          vec3 P;
          if (position.z < 0.5) {
            vec3 side = cross(uA, V);
            side = dot(side, side) > 1e-8 ? normalize(side) : vec3(0.0, 1.0, 0.0);
            P = uO + uA * (position.x * uLen) + side * (position.y * uWid * 0.5);
            vUv = vec2(position.x, position.y * uFlip * 0.5 + 0.5);
            vW = sqrt(max(0.0, 1.0 - facing * facing));          // edge-on down the bore: the strip is a line, fade it
          } else {
            vec3 r = normalize(cross(abs(V.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), V)), up = cross(V, r);
            float c = cos(uRot), s = sin(uRot);
            vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
            float sz = uFront * (0.35 + 0.65 * facing);            // from the side only a small hot core at the muzzle
            P = uO + uA * (sz * 0.3) + (r * q.x + up * q.y) * sz;
            vUv = position.xy * 0.5 + 0.5;
            vW = 0.05 + 0.95 * facing * facing * facing;
          }
          vKind = position.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
        }`,
      fragmentShader: `uniform sampler2D tSide, tFront; uniform float uRow, uCell, uI, uFrontI; uniform vec3 uTint;
        varying vec2 vUv; varying float vKind, vW;
        void main() {
          vec3 c;
          if (vKind < 0.5) c = texture2D(tSide, vec2(vUv.x, (3.0 - uRow + vUv.y) * 0.25)).rgb;
          else {
            c = texture2D(tFront, (vUv + vec2(mod(uCell, 2.0), 1.0 - floor(uCell * 0.5))) * 0.5).rgb * uFrontI;
            // seen from the side only the hot middle of the front view is left (no jets)
            c *= 1.0 - smoothstep(0.08, 0.35, length(vUv - 0.5)) * (1.0 - vW);
          }
          // the photos clip to white in the core: keep that hot, and let the thinner parts fall off to orange
          float l = max(c.r, max(c.g, c.b));
          c = mix(vec3(1.0, 0.45, 0.12) * l, c, smoothstep(0.35, 0.95, l));
          gl_FragColor = vec4(c * uTint * (uI * vW * (0.35 + 0.9 * l * l)), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.age = 0; this.frames = 0; this.on = false; this.peak = 0; this.last = -1;
  }
  // a shot: new random flame. size = the weapon's `flash` (KPVT 0.9 -> a ~1.2 m flame)
  fire(anchor, size) {
    const u = this.u, rnd = Math.random;
    let row = Math.floor(rnd() * FLASH_ROWS);
    if (row === this.last) row = (row + 1 + Math.floor(rnd() * (FLASH_ROWS - 1))) % FLASH_ROWS;
    this.last = row;
    u.uRow.value = row; u.uCell.value = Math.floor(rnd() * FLASH_FRONTS);
    u.uFlip.value = rnd() < 0.5 ? 1 : -1; u.uRot.value = rnd() * Math.PI * 2;
    this.len = size * 1.35 * (0.7 + rnd() * 0.6);
    this.wid = size * 0.8 * (0.75 + rnd() * 0.5);
    this.front = size * 0.62 * (0.75 + rnd() * 0.5);
    this.peak = 0.8 + rnd() * 0.45;
    u.uTint.value.setRGB(1, 0.86 + rnd() * 0.14, 0.7 + rnd() * 0.3);
    this.anchor = anchor; this.size = size;
    this.age = 0; this.frames = 0; this.on = true;
  }
  // per frame: follow the rendered muzzle. The flash lives ~1 ms; a frame holds all of it, so the first frame
  // after the shot shows it at full, later frames (high refresh rates) only a fading remnant. Returns the
  // brightness (0 = off) for the light.
  update(dt, near = 1) {
    if (!this.on) return 0;
    if (this.frames > 0) this.age += dt;
    if (this.frames > 0 && this.age > 0.02) { this.on = false; this.mesh.visible = false; return 0; }
    const k = this.frames === 0 ? 1 : 0.35 * Math.exp(-this.age / 0.012);
    const grow = 1 + this.age * 8;   // the gas keeps expanding
    this.frames++;
    const u = this.u;
    this.anchor.getWorldPosition(u.uO.value);
    this.anchor.getWorldDirection(u.uA.value).negate();   // the muzzle looks down -z
    u.uLen.value = this.len * grow; u.uWid.value = this.wid * grow; u.uFront.value = this.front * grow * (0.4 + 0.6 * near);
    u.uI.value = this.peak * k; u.uFrontI.value = 0.2 + 0.8 * near;
    this.mesh.visible = true;
    return this.peak * k;
  }
}

// impact and smoke particles (their own pool: hit feedback is gameplay, not the Dust graphics option)
class Fx {
  constructor(scene, additive) {
    const n = MAX_FX;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.alpha = new Float32Array(n); this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.grav = new Float32Array(n); this.drag = new Float32Array(n); this.grow = new Float32Array(n);
    this.next = 0; this.live = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uHalfH: { value: 360 }, uLight: { value: 1 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC; uniform float uHalfH;
        void main() { vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA *= smoothstep(3.0, 12.0, -mv.z);   // nothing big right in front of the camera (the sight is 2 m from the muzzle)
          gl_PointSize = max(1.5, size * projectionMatrix[1][1] * uHalfH / max(0.3, -mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC; uniform float uLight;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          float a = vA * (1.0 - r); gl_FragColor = vec4(vC * ${additive ? '1.0' : 'uLight'}, ${additive ? 'a' : '0.38 * a * exp(-2.5 * r)'}); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, size, life, r, g, b, grav = 1, drag = 0, grow = 0) {
    const i = this.next; this.next = (this.next + 1) % MAX_FX;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3); this.col.set([r, g, b], i * 3);
    this.size[i] = size; this.life[i] = life; this.max[i] = life; this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow;
    this.live = MAX_FX;
  }
  update(dt, light) {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < MAX_FX; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      any++;
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt), j = i * 3;
      this.vel[j] *= k; this.vel[j + 1] = this.vel[j + 1] * k - 9.81 * this.grav[i] * dt; this.vel[j + 2] *= k;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const f = Math.max(0, this.life[i] / this.max[i]);
      this.alpha[i] = Math.min(1, f * 1.6);
    }
    if (!any) this.live = 0;
    this.mat.uniforms.uLight.value = light;
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = a.color.needsUpdate = true;
  }
}

export class Gunnery {
  // api: { RAPIER, world, scene, vehicle, model, terrain, surfaceAt, audio }
  constructor(api) {
    Object.assign(this, api);
    this.v = api.vehicle;
    this.T = this.v.turret;
    this.spec = this.v.P.turret;
    this.ray = new api.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.rounds = [];
    this.hits = 0;                     // tests / telemetry
    this.lastHit = null;
    // sight range marks: how far below the bore line each gun's round lands (rad)
    const D = [200, 400, 600, 800, 1000, 1200, 1500, 2000];
    this.marks = this.spec.weapons.map(w => trajectory(w, D).map(r => ({ d: r.d, a: Math.atan2(r.drop, r.d) })));
    // visuals
    const S = this.scene;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 1.3, 0.22), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false });
    this.tracers = new THREE.InstancedMesh(geo, this.tracerMat, MAX_TRACERS);
    this.tracers.frustumCulled = false; this.tracers.count = 0;
    S.add(this.tracers);
    this.flashes = this.spec.weapons.map(() => new MuzzleFlash(S));
    this.friendFlash = null;   // made on a friend's first shot
    // the flash lights: warm (~2200 K), inverse square
    const warm = new THREE.Color(1, 0.62, 0.32);
    this.light = new THREE.SpotLight(warm, 0, FLASH_RANGE, FLASH_ANGLE, 0.5, 2);
    this.glow = new THREE.PointLight(warm, 0, GLOW_RANGE, 2);
    S.add(this.light, this.light.target, this.glow);
    this.sparks = new Fx(S, true);
    this.smoke = new Fx(S, false);
    this.recoilForce = 0;
  }

  setViewport(h) { this.sparks.mat.uniforms.uHalfH.value = h / 2; this.smoke.mat.uniforms.uHalfH.value = h / 2; }


  // gun muzzle and barrel direction in the world, from a vehicle pose and the turret angles (physics rate:
  // the model's scene graph is only updated per frame)
  muzzle(pos, quat, T, weapon, outP, outDir, outTrun) {
    const M = this.model.turret, w = this.spec.weapons[weapon];
    const muz = M[w.muzzle] || M.muzzle;
    // body <- ring (yaw about y) <- trunnion (pitch about x) <- muzzle
    _qy.copy(quat).multiply(_qa.setFromAxisAngle(AY, -T.yaw));
    _qg.copy(_qy).multiply(_qa.setFromAxisAngle(AX, T.pitch));
    const trun = _t.copy(M.pitch.position).applyQuaternion(_qy).add(_t2.copy(M.yaw.position).applyQuaternion(quat)).add(pos);
    if (outTrun) outTrun.copy(trun);
    // the PKT's muzzle sits in the cradle, the KPVT's in the recoiling barrel: both are fixed in the gun frame here
    outP.copy(muz.position).applyQuaternion(_qg).add(trun);
    outDir.set(0, 0, -1).applyQuaternion(_qg);
    return outP;
  }

  // one physics step (before vehicle.step): drive and fire, then fly every round through the world
  step(h, fire) {
    const T = this.T, v = this.v;
    T.step(h, fire);
    for (const e of T.events) this.fire(e);
    this.fly(h);
  }

  fire(e) {
    const w = this.spec.weapons[e.weapon], v = this.v;
    const p = new THREE.Vector3(), dir = new THREE.Vector3(), trun = new THREE.Vector3();
    this.muzzle(v.pos, v.quat, this.T, e.weapon, p, dir, trun);
    // dispersion (the mount and the barrel), a cone of w.spread rad
    const r = w.spread * Math.sqrt(-2 * Math.log(1 - Math.random() * 0.999)) * 0.6, a = Math.random() * Math.PI * 2;
    const ax = _v.set(1, 0, 0).applyQuaternion(_q.setFromUnitVectors(Z, dir));
    const ay = _v2.set(0, 1, 0).applyQuaternion(_q);
    dir.addScaledVector(ax, r * Math.cos(a)).addScaledVector(ay, r * Math.sin(a)).normalize();
    // the round leaves with the gun's speed plus the vehicle's (at the muzzle)
    const vel = dir.clone().multiplyScalar(w.v0);
    v.pointVel(p, _v);
    vel.add(_v);
    if (this.rounds.length < MAX_ROUNDS) this.rounds.push({ p, prev: p.clone(), v: vel, w, tracer: e.tracer, age: 0, bounces: 0 });
    // recoil into the hull at the trunnions
    v.body.applyImpulseAtPoint({ x: -dir.x * w.recoil, y: -dir.y * w.recoil, z: -dir.z * w.recoil }, { x: trun.x, y: trun.y, z: trun.z }, true);
    this.recoilForce += w.recoil;
    // flash + smoke at the muzzle (drawn at the rendered muzzle in update), sound
    const M = this.model.turret;
    this.flashes[e.weapon].fire(M[w.muzzle] || M.muzzle, w.flash);
    // a wisp of powder smoke (one per KPVT round, one per three of the PKT's)
    if (e.weapon === 0 || this.T.gun.count % 3 === 0) {
      const s = 0.4 + Math.random() * 0.6;
      this.smoke.emit(p.x + dir.x * s, p.y + dir.y * s, p.z + dir.z * s, dir.x * 3 + (Math.random() - 0.5), dir.y * 3 + 0.6 + Math.random() * 0.4, dir.z * 3 + (Math.random() - 0.5),
        e.weapon === 0 ? 0.3 : 0.18, 0.7 + Math.random() * 0.6, 0.72, 0.71, 0.68, -0.04, 2.2, 0.8);
    }
    this.audio?.gunshot?.(w.id);
  }

  fly(h) {
    const R = this.rounds, world = this.world, ray = this.ray, body = this.v.body;
    for (let i = R.length - 1; i >= 0; i--) {
      const b = R[i];
      b.age += h;
      b.prev.copy(b.p);
      ballisticStep(b.p, b.v, b.w.k, h);
      const dx = b.p.x - b.prev.x, dy = b.p.y - b.prev.y, dz = b.p.z - b.prev.z;
      const len = Math.hypot(dx, dy, dz);
      if (b.age > 8 || len < 1e-6 || b.p.y < -200) { R.splice(i, 1); continue; }
      // water: a round crossing the surface splashes and stops within a metre
      const wl = this.terrain.waterLevelAt?.(b.p.x, b.p.z) ?? -Infinity;
      if (b.prev.y > wl && b.p.y <= wl) {
        const f = (b.prev.y - wl) / Math.max(1e-6, b.prev.y - b.p.y);
        this.splash(b.prev.x + dx * f, wl, b.prev.z + dz * f, b.w);
        R.splice(i, 1);
        continue;
      }
      ray.origin.x = b.prev.x; ray.origin.y = b.prev.y; ray.origin.z = b.prev.z;
      ray.dir.x = dx / len; ray.dir.y = dy / len; ray.dir.z = dz / len;
      const hit = world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, body);
      if (!hit) continue;
      const t = hit.timeOfImpact;
      const p = _v.set(b.prev.x + ray.dir.x * t, b.prev.y + ray.dir.y * t, b.prev.z + ray.dir.z * t);
      const n = _v2.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const surf = this.surfaceAt(hit.collider, p) || SURFACES.dirt;
      const speed = Math.hypot(b.v.x, b.v.y, b.v.z);
      // push a body that can move (friends' trucks, loose things): the round's momentum
      const rb = hit.collider.parent();
      if (rb && rb.isDynamic()) {
        const m = b.w.mass;
        rb.applyImpulseAtPoint({ x: b.v.x * m, y: b.v.y * m, z: b.v.z * m }, { x: p.x, y: p.y, z: p.z }, true);
      }
      this.hits++;
      this.lastHit = { x: p.x, y: p.y, z: p.z, surf: surf.name, speed, t: b.age };
      // a shallow hit on rock or concrete ricochets (a third of the speed, scattered); anything else stops it
      const cosI = -(b.v.x * n.x + b.v.y * n.y + b.v.z * n.z) / speed;   // sine of the angle to the surface
      const hard = surf === SURFACES.rock || surf === SURFACES.concrete;
      this.impact(p, n, surf, b.w, speed, hard && cosI < 0.2);
      if (hard && cosI < 0.2 && b.bounces < 2 && Math.random() < 0.7) {
        const vn = b.v.x * n.x + b.v.y * n.y + b.v.z * n.z;
        b.v.x -= 2 * vn * n.x; b.v.y -= 2 * vn * n.y; b.v.z -= 2 * vn * n.z;
        const k = 0.3 + Math.random() * 0.15;
        b.v.x = b.v.x * k + (Math.random() - 0.5) * speed * 0.05; b.v.y = b.v.y * k + Math.random() * speed * 0.04; b.v.z = b.v.z * k + (Math.random() - 0.5) * speed * 0.05;
        b.p.copy(p).addScaledVector(n, 0.02);
        b.bounces++;
        continue;
      }
      R.splice(i, 1);
    }
  }

  impact(p, n, surf, w, speed, glance) {
    const big = w.calibre > 10 ? 1 : 0.45, rnd = Math.random;
    const [r, g, b] = surf.color || [0.5, 0.45, 0.35];
    const hard = surf === SURFACES.rock || surf === SURFACES.concrete;
    const wood = surf === SURFACES.wood;
    // dust / earth thrown out along the normal (soft ground: a tall plume; hard: a small grey puff)
    const nPuff = Math.round((hard ? 4 : 9) * big);
    for (let i = 0; i < nPuff; i++) {
      const up = (hard ? 2 : 4 + rnd() * 5) * big;
      this.smoke.emit(p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05,
        n.x * up + (rnd() - 0.5) * 2.5, n.y * up + rnd() * 1.5, n.z * up + (rnd() - 0.5) * 2.5,
        (0.18 + rnd() * 0.25) * big, 0.8 + rnd() * 1.4, r * 0.95, g * 0.92, b * 0.88, 0.25, 2.2, 0.7 * big);
    }
    // clods / chips that fall back
    const nChip = Math.round((surf.soft > 0.3 || surf.mud ? 10 : 5) * big);
    for (let i = 0; i < nChip; i++) {
      const s = (3 + rnd() * 6) * big;
      this.smoke.emit(p.x, p.y, p.z, n.x * s + (rnd() - 0.5) * 4, n.y * s + rnd() * 3, n.z * s + (rnd() - 0.5) * 4,
        0.04 + rnd() * 0.05, 0.6 + rnd() * 0.5, wood ? 0.45 : r * 0.6, wood ? 0.33 : g * 0.55, wood ? 0.2 : b * 0.5, 1.0, 0.3, 0);
    }
    // sparks off steel-hard surfaces (and every glancing hit)
    if (hard || glance) {
      const ns = Math.round((glance ? 14 : 9) * big);
      for (let i = 0; i < ns; i++) {
        const s = 6 + rnd() * 14;
        this.sparks.emit(p.x, p.y, p.z, n.x * s * 0.6 + (rnd() - 0.5) * s, n.y * s * 0.6 + rnd() * s * 0.5, n.z * s * 0.6 + (rnd() - 0.5) * s,
          0.025 + rnd() * 0.02, 0.15 + rnd() * 0.35, 6, 3.2, 1.2, 1.0, 0.8, 0);
      }
    }
    this.audio?.impact?.(hard ? 'hard' : 'soft', p);
  }

  splash(x, y, z, w) {
    const big = w.calibre > 10 ? 1 : 0.5, rnd = Math.random;
    for (let i = 0; i < 14 * big; i++) {
      const s = 2 + rnd() * 6 * big;
      this.smoke.emit(x, y + 0.02, z, (rnd() - 0.5) * 1.6, s, (rnd() - 0.5) * 1.6, (0.06 + rnd() * 0.12) * big, 0.7 + rnd() * 0.6, 0.82, 0.88, 0.92, 1.0, 0.4, 0.25);
    }
    this.audio?.impact?.('water', { x, y, z });
  }

  // per frame: tracers, flashes, particles (camera: tracer width so they stay visible far away)
  update(dt, camera, light = 1, darkness = 0) {
    // tracers: the last stretch of every burning tracer round
    let n = 0;
    const cp = camera.position;
    for (const b of this.rounds) {
      if (!b.tracer || b.age > TRACER_BURN || n >= MAX_TRACERS) continue;
      const speed = b.v.length();
      // a short bright dash (what the eye keeps of a tracer), never reaching back into the muzzle
      const len = Math.min(speed * 0.009, Math.max(0, b.age * speed - 3));
      if (len < 0.5) continue;
      _v.copy(b.v).multiplyScalar(-1 / speed);                   // tail direction
      const d = cp.distanceTo(b.p);
      const wdt = Math.max(b.w.calibre > 10 ? 0.035 : 0.025, d * 0.0009);
      _q.setFromUnitVectors(Z, _v);
      _m.compose(b.p, _q, _s.set(wdt, wdt, len));
      this.tracers.setMatrixAt(n++, _m);
    }
    this.tracers.count = n;
    if (n) this.tracers.instanceMatrix.needsUpdate = true;
    // muzzle flashes at the rendered muzzles (the model's turret groups, interpolated pose), and their light
    let li = 0, lf = null;
    this.flashes.forEach(f => {
      if (!f.on) return;
      // from the gunner's sight just behind the muzzle the front view would fill the eyepiece: tone it down
      const near = Math.min(1, Math.max(0, (camera.position.distanceTo(f.u.uO.value) - 2) / 6));
      const k = f.update(dt, near) * f.size;
      if (k > li) { li = k; lf = f; }
    });
    if (this.friendFlash?.on) this.friendFlash.update(dt, 1);
    const L = this.light, G = this.glow;
    if (lf) {
      // both sit in the gas ball a third of the way along the flame; the spot looks along the bore and down
      const u = lf.u, day = FLASH_DAY + (1 - FLASH_DAY) * darkness;
      L.position.copy(u.uO.value).addScaledVector(u.uA.value, u.uLen.value * 0.3);
      G.position.copy(L.position);
      L.target.position.copy(u.uA.value).add(_v.set(0, -0.8, 0)).add(L.position);
      L.target.updateMatrixWorld();
      L.intensity = FLASH_CD * li * day;
      G.intensity = GLOW_CD * li * day;
    } else L.intensity = G.intensity = 0;
    this.sparks.update(dt, 1);
    this.smoke.update(dt, light);
  }

  // a friend's turret fired n rounds (multiplayer): flash + tracer on our side, no hits (their game owns them)
  friendShots(model, proxy, n) {
    const M = model.turret;
    if (!M) return;
    const w = this.spec?.weapons?.[0] || { v0: 1000, k: 2.6e-4, calibre: 14.5, flash: 0.9 };
    for (let i = 0; i < Math.min(n, 4); i++) {
      const p = new THREE.Vector3(), d = new THREE.Vector3();
      M.muzzle.getWorldPosition(p); M.muzzle.getWorldDirection(d).negate();
      this.rounds.push({ p, prev: p.clone(), v: d.multiplyScalar(w.v0), w: { ...w, mass: 0, recoil: 0 }, tracer: true, age: 0, bounces: 9, ghost: true });
    }
    // their flash (no light: ours is the only one, a second would change the lights hash)
    (this.friendFlash ||= new MuzzleFlash(this.scene)).fire(M.muzzle, w.flash);
    this.audio?.gunshot?.('far');
  }
}
