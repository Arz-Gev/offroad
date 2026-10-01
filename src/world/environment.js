import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

// Sky, sun/moon light, hemisphere fill, fog, stars and environment reflections, with day / dusk / night.

const PRESETS = {
  day:   { elev: 38, azim: 145, sun: 3.4, sunColor: 0xfff3e2, hemi: 0.6, sky: 0xbcd6ff, ground: 0x5d4d36, fog: 0xc3d3e3, fogD: 0.0021, exposure: 0.72, turb: 6, ray: 1.4, stars: 0, night: false },
  dusk:  { elev: 4.5, azim: 250, sun: 2.2, sunColor: 0xffb070, hemi: 0.55, sky: 0x8aa0c8, ground: 0x3a2e24, fog: 0xc89a7a, fogD: 0.0032, exposure: 0.75, turb: 9, ray: 2.6, stars: 0.15, night: false },
  night: { elev: -14, azim: 250, sun: 0.30, sunColor: 0x9db4e8, hemi: 0.14, sky: 0x26324a, ground: 0x0a0b0e, fog: 0x0a0e16, fogD: 0.0042, exposure: 1.0, turb: 2, ray: 0.6, stars: 1, night: true },
};
export const TIME_ORDER = ['day', 'dusk', 'night'];

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    this.skyScene = new THREE.Scene();
    this.skyForEnv = new Sky();
    this.skyForEnv.scale.setScalar(1000);
    this.skyScene.add(this.skyForEnv);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 260;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x5d4d36, 1);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xc3d3e3, 0.003);

    // stars
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a) * 1500; pos[i * 3 + 1] = Math.abs(u) * 1500 + 30; pos[i * 3 + 2] = r * Math.sin(a) * 1500;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    this.mode = 'day';
    this.cur = { ...PRESETS.day };
    this.target = PRESETS.day;
    this.blend = 1;
    this.sunDir = new THREE.Vector3();
    this.envDirty = true;
    this.envTimer = 0;
    this.apply(1);
  }

  get night() { return this.target.night; }

  setMode(mode) {
    this.mode = mode;
    this.from = { ...this.cur };
    this.target = PRESETS[mode];
    this.blend = 0;
  }
  cycle() {
    const i = (TIME_ORDER.indexOf(this.mode) + 1) % TIME_ORDER.length;
    this.setMode(TIME_ORDER[i]);
    return this.mode;
  }

  apply(t) {
    const a = this.from || this.target, b = this.target;
    const lerp = (x, y) => x + (y - x) * t;
    const c = this.cur;
    for (const k of ['elev', 'azim', 'sun', 'hemi', 'fogD', 'exposure', 'turb', 'ray', 'stars']) c[k] = lerp(a[k], b[k]);
    const col = (k) => new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
    const phi = THREE.MathUtils.degToRad(90 - c.elev), theta = THREE.MathUtils.degToRad(c.azim);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    for (const s of [this.sky, this.skyForEnv]) {
      const u = s.material.uniforms;
      u.sunPosition.value.copy(this.sunDir);
      u.turbidity.value = c.turb;
      u.rayleigh.value = c.ray;
      u.mieCoefficient.value = 0.005;
      u.mieDirectionalG.value = 0.8;
    }
    // at night the directional light becomes the moon, high in the opposite sky
    const night = c.elev < 0;
    this.lightDir = night ? new THREE.Vector3(-this.sunDir.x, 0.75, -this.sunDir.z).normalize() : this.sunDir.clone();
    if (!night && c.elev < 8) this.lightDir.y = Math.max(this.lightDir.y, 0.12);
    this.sun.intensity = c.sun;
    this.sun.color.copy(col('sunColor'));
    this.hemi.intensity = c.hemi;
    this.hemi.color.copy(col('sky'));
    this.hemi.groundColor.copy(col('ground'));
    this.scene.fog.color.copy(col('fog'));
    this.scene.fog.density = c.fogD;
    this.renderer.toneMappingExposure = c.exposure;
    this.starMat.opacity = c.stars;
    this.sky.material.uniforms.rayleigh.value = c.ray;
    // darken the sky dome at night (the Sky shader alone stays too bright below the horizon)
    this.sky.visible = true;
    this.envDirty = true;
  }

  update(dt, focus) {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 2.5);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      this.apply(t);
    }
    // keep the shadow frustum on the truck, snapped to texels to avoid shimmering
    const d = 120;
    const texel = 90 / 4096;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.position.set(fx + this.lightDir.x * d, focus.y + this.lightDir.y * d, fz + this.lightDir.z * d);
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.target.updateMatrixWorld();
    this.stars.position.copy(focus);
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      if (this.envRT) this.envRT.dispose();
      this.envRT = this.pmrem.fromScene(this.skyScene, 0, 1, 2000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = this.target.night ? 0.03 : this.mode === 'dusk' ? 0.12 : 0.22;
      this.envDirty = false;
      this.envTimer = 0.4;
    }
  }
}
