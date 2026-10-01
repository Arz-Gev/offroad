import * as THREE from 'three';
import { MAP_SIZE } from './world/terrain.js';

// Dust / mud particles kicked up by the tyres + persistent tyre tracks painted into a map-wide texture.

export class Dust {
  constructor(scene, max = 2400) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.heavy = new Uint8Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uLight: { value: 1 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying float vA; varying vec3 vC;
        uniform float uScale;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        uniform float uLight;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float a = vA * (1.0 - r) * (1.0 - r);
          gl_FragColor = vec4(vC * uLight, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, size, life, col, heavy) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.color[i * 3] = col[0]; this.color[i * 3 + 1] = col[1]; this.color[i * 3 + 2] = col[2];
    this.heavy[i] = heavy ? 1 : 0;
  }

  spawnFromVehicle(v, dt, rnd = Math.random) {
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (!w.contact || w.FnAvg < 300) continue;
      const s = w.surf;
      const roll = Math.abs(w.vcx);
      const slip = w.slipVel || 0;
      const intensity = s.mud ? slip * 1.2 + roll * 0.15 : s.dust * (roll * 0.35 + slip * 1.6);
      let n = intensity * dt * 9;
      while (n > 0) {
        if (n < 1 && rnd() > n) break;
        n -= 1;
        const P = w.P;
        const back = w.fc;
        const sp = (s.mud ? 0.5 : 0.25) * Math.min(slip, 12);
        if (s.mud) {
          const c = 0.3 + rnd() * 0.1;
          this.emit(P.x + (rnd() - 0.5) * 0.3, P.y + 0.12, P.z + (rnd() - 0.5) * 0.3,
            -back.x * sp * (0.5 + rnd()) + (rnd() - 0.5) * 1.5, 1.5 + rnd() * 2.5 + sp * 0.3, -back.z * sp * (0.5 + rnd()) + (rnd() - 0.5) * 1.5,
            0.09 + rnd() * 0.08, 0.9 + rnd() * 0.5, [c * 0.62, c * 0.46, c * 0.3], true);
        } else {
          const c = s.color;
          const k = 0.85 + rnd() * 0.25;
          this.emit(P.x + (rnd() - 0.5) * 0.4, P.y + 0.1, P.z + (rnd() - 0.5) * 0.4,
            -back.x * sp + (rnd() - 0.5) * 0.8 + v.vel.x * 0.25, 0.4 + rnd() * 0.9, -back.z * sp + (rnd() - 0.5) * 0.8 + v.vel.z * 0.25,
            0.5 + rnd() * 0.6, 1.6 + rnd() * 1.8, [c[0] * k, c[1] * k, c[2] * k], false);
        }
      }
    }
  }

  update(dt, light) {
    this.mat.uniforms.uLight.value = light;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      const o = i * 3;
      if (this.heavy[i]) {
        this.vel[o + 1] -= 9.81 * dt;
        this.alpha[i] = 0.95 * (1 - t * t);
      } else {
        const drag = Math.exp(-dt * 1.6);
        this.vel[o] *= drag; this.vel[o + 2] *= drag;
        this.vel[o + 1] = this.vel[o + 1] * drag + 0.15 * dt;
        this.size[i] += dt * 1.1;
        this.alpha[i] = 0.32 * Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (1 - t);
      }
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

export class Tracks {
  constructor(terrainMaterial, res = 2048) {
    this.res = res;
    this.data = new Uint8Array(res * res);
    this.tex = new THREE.DataTexture(this.data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const u = terrainMaterial.userData.uniforms;
    u.uTrack.value = this.tex;
    u.uTrackOrigin.value.set(0, 0);
    u.uTrackSize.value = MAP_SIZE;
    this.timer = 0;
    this.dirty = false;
  }

  stamp(v, dt) {
    const res = this.res, half = MAP_SIZE / 2, k = res / MAP_SIZE;
    for (const w of v.wheels) {
      if (!w.contact || w.FnAvg < 500) continue;
      const s = w.surf;
      if (s.soft < 0.3 && !s.mud && s.dust < 0.9) continue;
      const depth = (s.mud ? 2.2 : s.soft) * Math.min(1.5, w.FnAvg / 5000) * (1 + Math.min(2, (w.slipVel || 0) * 0.3));
      const add = depth * dt * 260;
      const cx = (w.P.x + half) * k, cz = (w.P.z + half) * k;
      const r = 0.75;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const px = Math.floor(cx + dx), pz = Math.floor(cz + dz);
        if (px < 0 || pz < 0 || px >= res || pz >= res) continue;
        const dd = Math.hypot(px + 0.5 - cx, pz + 0.5 - cz);
        if (dd > r + 0.5) continue;
        const i = pz * res + px;
        this.data[i] = Math.min(220, this.data[i] + add * (1 - dd / (r + 0.6)));
      }
      this.dirty = true;
    }
    this.timer -= dt;
    if (this.dirty && this.timer <= 0) { this.tex.needsUpdate = true; this.dirty = false; this.timer = 0.25; }
  }
}
