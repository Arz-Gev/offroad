import * as THREE from 'three';
import { MAP_SIZE } from './world/terrain.js';

// Dust / mud / water particles kicked up by the tyres, and tyre tracks painted into a map-wide texture.

// Soft dust puffs alive at once; emission thins out near it (wheelspin in place leaves a haze, not a
// wall), so clumps and splashes always find room in the buffer.
const PUFF_CAP = 450;

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
    this.alive = 0;        // particles alive at the last update
    this.puffs = 0;        // live soft particles (counted in update, plus this frame's emits)
    this.enabled = true;   // setting 'dust' (Graphics)
    this.waterAt = null;   // (x, z) -> water surface height or -Infinity (set by main.js)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      // uHalfH: half the render target height in px (setViewport). With the projection's focal length it
      // turns metres into pixels, so a puff covers the same part of the view at any resolution or fov.
      uniforms: { uHalfH: { value: 360 }, uLight: { value: 1 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying float vA; varying vec3 vC;
        uniform float uHalfH;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // fade out right in front of the camera (a big soft blob over the view otherwise)
          vA *= smoothstep(0.4, 2.5, -mv.z);
          gl_PointSize = size * projectionMatrix[1][1] * uHalfH / max(0.5, -mv.z);
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

  setViewport(heightPx) { this.mat.uniforms.uHalfH.value = heightPx / 2; }

  setEnabled(on) {
    this.enabled = on;
    this.points.visible = on;
    if (!on) { this.life.fill(0); this.alpha.fill(0); this.points.geometry.attributes.alpha.needsUpdate = true; }
  }

  emit(x, y, z, vx, vy, vz, size, life, col, heavy) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.color[i * 3] = col[0]; this.color[i * 3 + 1] = col[1]; this.color[i * 3 + 2] = col[2];
    this.heavy[i] = heavy ? 1 : 0;
    if (!heavy) this.puffs++;
  }

  // droplets off the tread plus a bow wave, more with speed and depth
  splash(v, w, depth, dt, rnd) {
    const s = w.surf, muddy = !!s.mud;
    const sp = Math.abs(w.vcx), slip = w.slipVel || 0;
    const d = Math.min(depth, 0.6);
    let n = (sp * 2.2 + slip * 1.5) * (0.4 + d * 2.2) * dt * 9;
    const P = w.P, back = w.fc, side = w.sc;
    const base = muddy ? [0.30, 0.23, 0.15] : [0.62, 0.68, 0.70];
    const wl = P.y + depth;
    while (n > 0) {
      if (n < 1 && rnd() > n) break;
      n -= 1;
      const k = 0.85 + rnd() * 0.3;
      const col = [base[0] * k, base[1] * k, base[2] * k];
      const sgn = rnd() < 0.5 ? -1 : 1;
      if (rnd() < 0.65) {
        const up = 1.2 + rnd() * 2.0 + sp * 0.12, out = (rnd() - 0.3) * 1.5 + sp * 0.08;
        this.emit(P.x + (rnd() - 0.5) * 0.35, wl + 0.02, P.z + (rnd() - 0.5) * 0.35,
          -back.x * sp * (0.15 + rnd() * 0.35) + side.x * out * sgn + v.vel.x * 0.5, up, -back.z * sp * (0.15 + rnd() * 0.35) + side.z * out * sgn + v.vel.z * 0.5,
          0.05 + rnd() * 0.07, 0.7 + rnd() * 0.5, col, true);
      } else {
        this.emit(P.x + side.x * sgn * 0.3, wl + 0.05, P.z + side.z * sgn * 0.3,
          side.x * sgn * (0.8 + sp * 0.15) + v.vel.x * 0.6, 0.5 + rnd() * 0.8, side.z * sgn * (0.8 + sp * 0.15) + v.vel.z * 0.6,
          0.25 + rnd() * 0.35 + sp * 0.02, 0.5 + rnd() * 0.5, col.map(c => Math.min(1, c * 1.25)), false);
      }
    }
  }

  spawnFromVehicle(v, dt, rnd = Math.random) {
    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      if (!w.contact || w.FnAvg < 300) continue;
      if (this.waterAt) {
        const depth = this.waterAt(w.P.x, w.P.z) - w.P.y;
        if (depth > 0.03) { this.splash(v, w, depth, dt, rnd); continue; }
      }
      const s = w.surf;
      const roll = Math.abs(w.vcx);
      const slip = Math.min(w.slipVel || 0, 12);
      // past ~3 m/s of wheelspin, more adds little (a stuck car spins at 10-15 m/s)
      const slipK = slip < 3 ? slip : 3 + (slip - 3) * 0.25;
      const room = Math.max(0, 1 - this.puffs / PUFF_CAP);
      const intensity = s.mud ? slipK * 1.2 + roll * 0.15 : s.dust * (roll * 0.3 + slipK * 1.3) * room;
      let n = intensity * dt * 9;
      let m = s.mud ? slipK * 0.6 * room * dt * 9 : 0;
      while (m > 0) {
        if (m < 1 && rnd() > m) break;
        m -= 1;
        const P = w.P, back = w.fc, k = 0.85 + rnd() * 0.3;
        this.emit(P.x + (rnd() - 0.5) * 0.4, P.y + 0.15, P.z + (rnd() - 0.5) * 0.4,
          -back.x * slipK * 0.3 + (rnd() - 0.5) * 0.6 + v.vel.x * 0.25, 0.4 + rnd() * 0.6, -back.z * slipK * 0.3 + (rnd() - 0.5) * 0.6 + v.vel.z * 0.25,
          0.25 + rnd() * 0.25, 0.8 + rnd() * 0.7, [0.40 * k, 0.29 * k, 0.18 * k], false);
      }
      while (n > 0) {
        if (n < 1 && rnd() > n) break;
        n -= 1;
        const P = w.P;
        const back = w.fc;
        const sp = (s.mud ? 0.5 : 0.25) * slip;
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
            0.35 + rnd() * 0.4, 1.3 + rnd() * 1.4, [c[0] * k, c[1] * k, c[2] * k], false);
        }
      }
    }
  }

  update(dt, light) {
    this.mat.uniforms.uLight.value = light;
    let puffs = 0, alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      alive++;
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
        this.size[i] += dt * 0.75;
        puffs++;
        this.alpha[i] = 0.28 * Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (1 - t);
      }
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    this.puffs = puffs;
    // nothing alive now or last frame: the buffers on the GPU already hold all zero alphas
    const idle = alive === 0 && this.alive === 0;
    this.alive = alive;
    if (idle) return;
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
    this.box = [res, res, -1, -1];   // texels stamped since the last upload: x0, z0, x1, z1
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
        const b = this.box;
        if (px < b[0]) b[0] = px; if (pz < b[1]) b[1] = pz; if (px > b[2]) b[2] = px; if (pz > b[3]) b[3] = pz;
      }
      this.dirty = true;
    }
    this.timer -= dt;
    if (this.dirty && this.timer <= 0) {
      // upload only the stamped rows (the whole 4 MB map took a frame's worth of upload every 0.25 s).
      // three's update ranges count RGBA components (x4) and upload one row each
      const b = this.box, res = this.res;
      this.tex.clearUpdateRanges();
      for (let z = b[1]; z <= b[3]; z++) this.tex.addUpdateRange((z * res + b[0]) * 4, (b[2] - b[0] + 1) * 4);
      this.tex.needsUpdate = true;
      this.box = [res, res, -1, -1];
      this.dirty = false; this.timer = 0.25;
    }
  }
}
