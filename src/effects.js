import * as THREE from 'three/webgpu';
import { spriteCloud } from './render/sprites.js';
import { MAP_SIZE } from './world/terrain.js';

// Dust / mud particles and water splashes kicked up by the tyres + persistent tyre tracks painted into a
// map-wide texture.

export class Dust {
  constructor(scene, max = 4000) {
    this.max = max;
    this.cloud = spriteCloud(max, { near: [0.4, 2.5], shape: 'soft' });
    this.pos = this.cloud.pos;
    this.size = this.cloud.size;
    this.alpha = this.cloud.alpha;
    this.color = this.cloud.color;
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.heavy = new Uint8Array(max);
    this.next = 0;
    this.live = 0;
    this.enabled = true;   // setting 'dust' (Graphics)
    this.waterAt = null;   // (x, z) -> water surface height or -Infinity (set by main.js)
    this.points = this.cloud.mesh;
    scene.add(this.points);
  }

  // sizes are in metres now (quads in the view): nothing depends on the viewport
  setViewport() {}

  setEnabled(on) {
    this.enabled = on;
    this.points.visible = on;
    if (!on) { this.life.fill(0); this.alpha.fill(0); this.cloud.commit(0); }
  }

  emit(x, y, z, vx, vy, vz, size, life, col, heavy) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.color[i * 3] = col[0]; this.color[i * 3 + 1] = col[1]; this.color[i * 3 + 2] = col[2];
    this.heavy[i] = heavy ? 1 : 0;
    this.live = this.max;
  }

  // water: droplets thrown up and back by the tread plus a bow wave to the sides, more with speed and depth
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
        // droplets: up and back off the tread, some sideways
        const up = 1.2 + rnd() * 2.0 + sp * 0.12, out = (rnd() - 0.3) * 1.5 + sp * 0.08;
        this.emit(P.x + (rnd() - 0.5) * 0.35, wl + 0.02, P.z + (rnd() - 0.5) * 0.35,
          -back.x * sp * (0.15 + rnd() * 0.35) + side.x * out * sgn + v.vel.x * 0.5, up, -back.z * sp * (0.15 + rnd() * 0.35) + side.z * out * sgn + v.vel.z * 0.5,
          0.05 + rnd() * 0.07, 0.7 + rnd() * 0.5, col, true);
      } else {
        // bow wave / spray: fine mist that hangs a moment
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
    this.cloud.light.value = light;
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      any++;
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
    if (!any) this.live = 0;
    this.cloud.commit(any ? this.max : 0);
  }
}

export class Tracks {
  // the map-wide rut texture lives in the terrain view (terrainView.trackTex); this paints into it
  constructor(terrainView) {
    this.tex = terrainView.trackTex;
    this.res = this.tex.image.width;
    this.data = this.tex.image.data;
    const u = terrainView.uniforms;
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
