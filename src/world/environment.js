import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { Sky } from './sky.js';
import { scatter, transmittance } from './atmosphere.js';
import { ATMO, setVec4 } from '../render/shaderPatches.js';

// Time of day: sun / moon light (cascaded shadows), physically based sky + clouds + stars, height fog and
// aerial perspective matched to the sky, image-based ambient light from the sky, and the post-processing
// look (exposure / eye adaptation, bloom, grade) for day / dusk / night.
//
// Light units (three.js "physically correct" lights): the sun is ~3.5 lux-equivalent at noon. Lamps are
// expected in candela with decay 2: a ~300 cd low beam gives ~1–3 units on the ground at 10–15 m, which
// the night exposure renders as a well-lit mid tone, while moonlit ground (~0.1) stays dim and blue.

const PRESETS = {
  day: {
    elev: 40, azim: 145, sunE: 4.0, moonElev: -30, moonAzim: 0, moonE: 0, skyScale: 4.2, nightBase: [0, 0, 0],
    cover: 0.42, cloudAlpha: 0.95, stars: 0, fogD: 0.00045, fogFall: 0.012, haze: 0.00009, fogMax: 1, env: 1.0,
    exposure: 0.75, auto: 0, key: 0.16, minEx: 0.75, maxEx: 0.75, bloom: 0.045, bloomThr: 2.0,
    sat: 1.06, contrast: 0.14, vignette: 0.22, tint: [1.0, 1.0, 1.0], lift: [0, 0, 0], night: false,
  },
  dusk: {
    elev: 4.5, azim: 250, sunE: 5.0, moonElev: -30, moonAzim: 70, moonE: 0, skyScale: 4.6, nightBase: [0.0004, 0.0006, 0.0012],
    cover: 0.5, cloudAlpha: 1.0, stars: 0.08, fogD: 0.0006, fogFall: 0.016, haze: 0.0001, fogMax: 0.92, env: 1.0,
    exposure: 1.25, auto: 0, key: 0.16, minEx: 1.25, maxEx: 1.25, bloom: 0.06, bloomThr: 1.6,
    sat: 1.08, contrast: 0.16, vignette: 0.28, tint: [1.0, 0.98, 0.95], lift: [0, 0, 0.0004], night: false,
  },
  night: {
    elev: -16, azim: 250, sunE: 5.0, moonElev: 38, moonAzim: 70, moonE: 0.22, skyScale: 4.2, nightBase: [0.0011, 0.0016, 0.003],
    cover: 0.32, cloudAlpha: 0.75, stars: 1, fogD: 0.0012, fogFall: 0.016, haze: 0.00012, fogMax: 1, env: 1.0,
    exposure: 2.0, auto: 1, key: 0.06, minEx: 1.0, maxEx: 3.2, bloom: 0.06, bloomThr: 1.4,
    sat: 0.86, contrast: 0.1, vignette: 0.32, tint: [0.92, 0.97, 1.1], lift: [0.0, 0.0002, 0.0006], night: true,
  },
};
export const TIME_ORDER = ['day', 'dusk', 'night'];
const SCALARS = ['elev', 'azim', 'sunE', 'moonElev', 'moonAzim', 'moonE', 'skyScale', 'cover', 'cloudAlpha', 'stars', 'fogD', 'fogFall', 'haze', 'fogMax', 'env',
  'exposure', 'auto', 'key', 'minEx', 'maxEx', 'bloom', 'bloomThr', 'sat', 'contrast', 'vignette'];
const VECS = ['nightBase', 'tint', 'lift'];

const dirFrom = (elev, azim, out = new THREE.Vector3()) => out.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(azim));

export class Environment {
  constructor(renderer, scene, pipeline) {
    this.renderer = renderer;
    this.scene = scene;
    this.pipeline = pipeline;
    this.sky = new Sky(renderer);
    scene.add(this.sky.dome);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;

    // sun by day, moon by night: one cascaded-shadow light
    this.sun = new SunLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.far = 170;   // shadow range (m); split into two cascades
    this.sun.shadow.camera.near = 20;   // caster ceiling above the view slice
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 1.6;
    scene.add(this.sun);
    // faint ground bounce for surfaces facing down (the sky probe covers the upper hemisphere)
    this.hemi = new THREE.HemisphereLight(0x000000, 0x5d4d36, 0);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xc3d3e3, 0.002);

    this.mode = 'day';
    this.cur = this.clonePreset(PRESETS.day);
    this.target = PRESETS.day;
    this.from = null;
    this.blend = 1;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.envDirty = true;
    this.envTimer = 0;
    this.shadowScale = 1;
    this.apply(1);
  }

  clonePreset(p) { const o = { ...p }; for (const k of VECS) o[k] = p[k].slice(); return o; }

  get night() { return this.target.night; }

  setMode(mode) {
    if (!PRESETS[mode]) return;
    this.mode = mode;
    this.from = this.clonePreset(this.cur);
    this.target = PRESETS[mode];
    this.blend = 0;
  }
  cycle() {
    const i = (TIME_ORDER.indexOf(this.mode) + 1) % TIME_ORDER.length;
    this.setMode(TIME_ORDER[i]);
    return this.mode;
  }

  apply(t) {
    const a = this.from || this.target, b = this.target, c = this.cur;
    for (const k of SCALARS) c[k] = a[k] + (b[k] - a[k]) * t;
    for (const k of VECS) for (let i = 0; i < 3; i++) c[k][i] = a[k][i] + (b[k][i] - a[k][i]) * t;
    c.night = b.night;
    dirFrom(c.elev, c.azim, this.sunDir);
    dirFrom(c.moonElev, c.moonAzim, this.moonDir);
    const sd = this.sunDir.toArray(), md = this.moonDir.toArray();

    // direct light: the sun while it is up, else the moon (cross-fade around the horizon)
    const Ts = transmittance(sd), Tm = transmittance(md);
    const sunUp = THREE.MathUtils.smoothstep(c.elev, -2, 1.5);
    const moonTint = [0.62, 0.74, 1.0];
    const sunRGB = Ts.map(v => v * c.sunE);
    const moonRGB = Tm.map((v, i) => v * c.moonE * moonTint[i]);
    const useSun = sunUp > 0.02 || c.moonE <= 0;
    const rgb = useSun ? sunRGB.map(v => v * Math.max(sunUp, 0.02)) : moonRGB;
    const I = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    this.sun.color.setRGB(rgb[0] / I, rgb[1] / I, rgb[2] / I);
    this.sun.intensity = I;
    this.lightDir.copy(useSun ? this.sunDir : this.moonDir);
    // keep the shadow camera above the horizon (long dusk shadows stay bounded)
    if (this.lightDir.y < 0.1) { this.lightDir.y = 0.1; this.lightDir.normalize(); }
    this.sun.position.copy(this.lightDir);

    // sky LUT
    const sky = this.sky, S = c.skyScale;
    const sunE = new THREE.Vector3(c.sunE * S, c.sunE * S, c.sunE * S);
    const moonE = new THREE.Vector3(c.moonE * S * moonTint[0] * 0.5, c.moonE * S * moonTint[1] * 0.5, c.moonE * S * moonTint[2] * 0.5);
    const nb = new THREE.Vector3(...c.nightBase);
    sky.updateLUT(this.sunDir, sunE, this.moonDir, moonE, nb);
    const su = sky.uniforms;
    su.uSunDisc.value.set(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(5000 * sunUp);
    su.uMoonDisc.value.set(0.9, 0.93, 1.0).multiplyScalar(c.moonE * 1.2 * THREE.MathUtils.smoothstep(c.moonElev, -1, 2));
    su.uStars.value = c.stars;
    su.uCover.value = c.cover;
    su.uCloudAlpha.value = c.cloudAlpha;

    // horizon colours for the fog / aerial perspective, from the same scattering model
    const L = useSun ? sd : md;
    const lE = useSun ? c.sunE * S : c.moonE * S * 0.5;
    const tintL = useSun ? [1, 1, 1] : moonTint;
    const az = Math.atan2(L[0], L[2]);
    const hz = (da, el = 0.03) => { const e = el, q = az + da; return [Math.cos(e) * Math.sin(q), Math.sin(e), Math.cos(e) * Math.cos(q)]; };
    const fogCol = (da) => scatter(hz(da), L, 16).map((v, i) => v * lE * tintL[i] + c.nightBase[i] * 0.9);
    const side = fogCol(Math.PI / 2), away = fogCol(Math.PI);
    // towards a low sun the horizon is many times brighter than elsewhere (Mie forward scattering): in
    // the fog that turned every hill between the camera and a dusk sun into a flat orange wall
    const toward = fogCol(0).map((v, i) => Math.min(v, side[i] * 2.2 + 1e-4));
    // fog is slightly darker than the sky right at the horizon (it is lit, but also shadowed by terrain)
    const k = 0.92;
    setVec4(ATMO.atmoSun, L[0], L[1], L[2], c.fogFall);
    setVec4(ATMO.atmoAway, away[0] * k, away[1] * k, away[2] * k, 0);
    setVec4(ATMO.atmoSide, side[0] * k, side[1] * k, side[2] * k, c.haze);
    setVec4(ATMO.atmoToward, toward[0] * k, toward[1] * k, toward[2] * k, c.fogMax);
    setVec4(ATMO.atmoGlow, 0, 0, 0, 0.75);
    this.scene.fog.density = c.fogD;
    this.scene.fog.color.setRGB(side[0], side[1], side[2]);

    // clouds lit by the sun (moon) colour above the haze; ambient from the zenith sky
    const zen = scatter([0, 1, 0], L, 12).map((v, i) => v * lE * tintL[i] + c.nightBase[i]);
    const lit = (useSun ? Ts.map(v => Math.pow(v, 0.6) * c.sunE * Math.max(sunUp, 0.04)) : Tm.map((v, i) => Math.pow(v, 0.6) * c.moonE * moonTint[i]));
    su.uCloudLit.value.set(lit[0], lit[1], lit[2]).multiplyScalar(0.55);
    su.uCloudAmb.value.set(zen[0] * 3.2 + side[0] * 0.8, zen[1] * 3.2 + side[1] * 0.8, zen[2] * 3.2 + side[2] * 0.8);
    su.uGround.value.set(side[0] * 0.25 + 0.002, side[1] * 0.25 + 0.002, side[2] * 0.25 + 0.0015);
    su.uSunSize.value = 0.0125 * (1 + (1 - THREE.MathUtils.smoothstep(c.elev, 0, 15)) * 0.4);

    this.hemi.groundColor.setRGB(0.36, 0.30, 0.22);
    this.hemi.intensity = (useSun ? c.sunE * Math.max(sunUp, 0.05) * Ts[1] : c.moonE * Tm[1]) * 0.04;

    // post-processing look
    if (this.pipeline) {
      const P = this.pipeline.params;
      P.exposure = c.exposure;
      P.autoExposure = c.auto > 0.5;
      P.key = c.key; P.minExposure = c.minEx; P.maxExposure = c.maxEx;
      P.bloomStrength = c.bloom; P.bloomThreshold = c.bloomThr;
      P.saturation = c.sat; P.contrast = c.contrast; P.vignette = c.vignette;
      P.tint.setRGB(...c.tint); P.lift.setRGB(...c.lift);
      if (t >= 1 || t === 0) this.pipeline.resetExposure = true;
    }
    this.envDirty = true;
  }

  update(dt, focus, camera) {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 2.5);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      this.apply(t);
    }
    if (camera) this.sky.update(dt, camera);
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      if (this.envRT) this.envRT.dispose();
      this.envRT = this.pmrem.fromScene(this.sky.envScene, 0, 0.1, 1000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = this.cur.env;
      this.envDirty = false;
      this.envTimer = 0.25;
    }
  }
}
