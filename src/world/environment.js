import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { Sky } from './sky.js';
import { scatter, transmittance } from './atmosphere.js';
import { ATMO, setVec4 } from '../render/shaderPatches.js';
import { CascadedSunShadow, installCascadeShadowChunks } from '../render/cascadeShadow.js';
import { Clouds, CLOUD } from './clouds.js';
import { VolumetricFog } from '../render/volumetricFog.js';

// Time of day: sun / moon light (cascaded shadows), physically based sky + clouds + stars, height fog and
// aerial perspective matched to the sky, image-based ambient light from the sky, and the post-processing
// look (exposure / eye adaptation, bloom, grade) for day / dusk / night.
//
// Light units (three.js "physically correct" lights): the sun is ~3.5 lux-equivalent at noon. Lamps are
// expected in candela with decay 2: a ~300 cd low beam gives ~1–3 units on the ground at 10–15 m, which
// the night exposure renders as a well-lit mid tone, while moonlit ground (~0.1) stays dim and blue.

// Time of day is one number, the hour (0..24, continuous). Sun and moon follow arcs (celestial-sphere model below);
// the look (sky, fog, exposure, grade) is a key-frame table by hour, monotone-cubic interpolated and wrapping midnight.
// The three old presets are key frames at QUICK_HOURS. `setHour(h, { instant })` is the single entry point: instant
// for sliders / startup, otherwise a 2.5 s sweep forward through the hours (N key).

export const QUICK_HOURS = { day: 13, dusk: 19.5, night: 23 };
export const QUICK_ORDER = ['day', 'dusk', 'night'];
const ANIM_TIME = 2.5;
const FLOW_STEP = 0.004;          // hours (~15 game seconds) between full look updates while time passes
const MOON_TINT = [0.62, 0.74, 1.0];

// The look: a summer remembered, vivid and alive, with its full range: deep shade (only a hint of lavender in
// the darkest, shadowCol), a warm strong sun, saturated colour through an ACES curve, softened by a diffusion
// glow (mist: light spills from bright areas into the dark ones beside them), a little warmth in the highlights
// (highCol), dull colours lifted a bit (vibrance), a soft warm vignette, a soft glow round the sun in the haze
// (glow), light shafts (shafts), a faint cool fill from above so shade is blue rather than olive (fill).
const DAY = {
  sunE: 4.4, moonE: 0, skyScale: 4.2, nightBase: [0, 0, 0],
  cover: 0.42, cloudAlpha: 0.95, stars: 0, fogD: 0.00055, fogFall: 0.012, haze: 0.00045, vista: 0.0005, fogMax: 1, env: 1.3, glow: 0.6, shafts: 0.06,
  exposure: 1.5, auto: 0, key: 0.3, minEx: 1.5, maxEx: 1.5, bloom: 0.08, bloomThr: 1.4, mist: 0.22, vmist: 0, vfog: 0.0006,
  sat: 1.12, contrast: 0.04, vignette: 0.35, tint: [1.0, 1.0, 1.0], lift: [0, 0, 0],
  vibrance: 0.2, shadowCol: [0.012, 0.012, 0.026], highCol: [1.0, 1.0, 0.98], vigCol: [0.62, 0.7, 0.85],
  fill: 0.13, fillCol: [0.55, 0.62, 1.0], blue: 1.0, blueL: 0.86,
};
const DUSK = {
  sunE: 5.2, moonE: 0, skyScale: 4.6, nightBase: [0.0004, 0.0006, 0.0012],
  cover: 0.5, cloudAlpha: 1.0, stars: 0.08, fogD: 0.0007, fogFall: 0.016, haze: 0.0002, vista: 0.0006, fogMax: 0.92, env: 1.0, glow: 1.2, shafts: 0.16,
  exposure: 2.3, auto: 0, key: 0.3, minEx: 2.3, maxEx: 2.3, bloom: 0.11, bloomThr: 1.15, mist: 0.45, vmist: 0.002, vfog: 0.0028,
  sat: 1.1, contrast: 0.05, vignette: 0.48, tint: [1.02, 0.94, 0.98], lift: [0, 0, 0.0004],
  vibrance: 0.18, shadowCol: [0.02, 0.012, 0.03], highCol: [1.05, 0.98, 0.92], vigCol: [0.48, 0.42, 0.58],
  fill: 0.34, fillCol: [0.5, 0.45, 1.0], blue: 0.35, blueL: 0.9,
};
const NIGHT = {
  sunE: 5.0, moonE: 0.22, skyScale: 4.2, nightBase: [0.0011, 0.0016, 0.003],
  cover: 0.32, cloudAlpha: 0.75, stars: 1, fogD: 0.0012, fogFall: 0.016, haze: 0.00015, vista: 0.0005, fogMax: 1, env: 1.15, glow: 0.3, shafts: 0,
  exposure: 3.6, auto: 1, key: 0.11, minEx: 1.8, maxEx: 5.8, bloom: 0.09, bloomThr: 1.2, mist: 0.25, vmist: 0.004, vfog: 0.0016,
  sat: 0.96, contrast: 0.05, vignette: 0.54, tint: [0.92, 0.97, 1.1], lift: [0.0, 0.0002, 0.0006],
  vibrance: 0.15, shadowCol: [0.003, 0.005, 0.012], highCol: [1.0, 1.0, 1.04], vigCol: [0.2, 0.24, 0.36],
  fill: 0.01, fillCol: [0.4, 0.5, 1.0], blue: 0.3, blueL: 0.9,
};

// Sun and moon arcs: latitude, declination (deg), hour of upper transit (south), azimuth of south in the game's
// frame (azimuth runs from +z towards +x; the old presets put the sunset at 250°, so south = 155.7°). The sun arc is the
// best fit through the presets (13:00 elev 40° az 145°, 19:30 4.5° / 250°, 23:00 -16° / 250°); a key's `pin` moves the sun
// exactly onto the preset at that hour, fading out towards the neighbouring keys. The moon arc passes exactly through
// the night preset (23:00 elev 38° az 70°).
const SOUTH = 155.7;
const SUN_ARC = { lat: 55, dec: 8, transit: 13.5, south: SOUTH };
const MOON_ARC = { lat: 55, dec: 28, transit: 27.2, south: SOUTH };
const RAD = Math.PI / 180;
function arcPos(a, hour) {
  const sl = Math.sin(a.lat * RAD), cl = Math.cos(a.lat * RAD), sd = Math.sin(a.dec * RAD), cd = Math.cos(a.dec * RAD);
  const H = (hour - a.transit) * 15 * RAD;
  const elev = Math.asin(sl * sd + cl * cd * Math.cos(H)) / RAD;
  const A = Math.atan2(Math.sin(H) * cd, Math.cos(H) * sl * cd - sd * cl) / RAD;   // from south, towards west
  return [elev, a.south + A];
}
const wrapDeg = a => ((a + 540) % 360 + 360) % 360 - 180;
const wrapHour = h => ((h % 24) + 24) % 24;

// key frames, ascending by hour (the table wraps from 23:00 round to 1:30)
const KEYS = [
  { h: 1.5, ...NIGHT, nightBase: [0.0009, 0.0013, 0.0025], cover: 0.3, fogD: 0.0013, vmist: 0.006 },                                   // deep night
  { h: 6, ...NIGHT, moonE: 0.14, nightBase: [0.0008, 0.0012, 0.0024], cover: 0.36, cloudAlpha: 0.82, stars: 0.5,           // pre-dawn
    fogD: 0.001, haze: 0.00014, exposure: 3.1, key: 0.13, sat: 0.98, vignette: 0.51,
    tint: [0.95, 0.98, 1.06], lift: [0, 0.00015, 0.0005], vigCol: [0.24, 0.26, 0.38], fill: 0.02, vmist: 0.009, vfog: 0.0035 },
  { h: 7.5, ...DUSK, fogD: 0.0008, fogMax: 0.95, tint: [1.0, 0.96, 1.0], pin: [4.5, 2 * SOUTH - 250],                    // dawn: dusk's mirror image,
    highCol: [1.05, 0.99, 0.93], fill: 0.3, vmist: 0.008, vfog: 0.0024 },                                                                           //   a little cooler and mistier
  { h: 10, ...DAY, cover: 0.46, fogD: 0.0005, haze: 0.00014, exposure: 1.55, tint: [1.0, 0.995, 0.985], glow: 0.8, fill: 0.14, shafts: 0.1, mist: 0.26, vmist: 0.0015, vfog: 0.0014 },   // morning
  { h: 13, ...DAY, pin: [40, 145] },                                                                                      // day
  { h: 18.25, ...DAY, sunE: 4.8, skyScale: 4.4, cover: 0.48, cloudAlpha: 0.98, fogD: 0.0005, fogFall: 0.0135,             // golden hour
    haze: 0.00018, vista: 0.0006, nightBase: [0.0001, 0.00015, 0.0003], exposure: 1.85, bloom: 0.1, bloomThr: 1.2, sat: 1.12, glow: 1.0, shafts: 0.2,
    vignette: 0.4, tint: [1.0, 0.97, 0.95], lift: [0, 0, 0.0002], highCol: [1.05, 0.99, 0.92], vigCol: [0.55, 0.5, 0.62], fill: 0.24, fillCol: [0.55, 0.5, 1.0], env: 1.1, mist: 0.3, vmist: 0.0005, vfog: 0.0018 },
  { h: 19.5, ...DUSK, pin: [4.5, 250] },                                                                                  // dusk
  { h: 20.5, ...NIGHT, moonE: 0.18, nightBase: [0.0007, 0.001, 0.002], cover: 0.4, cloudAlpha: 0.88, stars: 0.4,          // blue hour
    fogD: 0.0009, haze: 0.00014, fogMax: 0.96, exposure: 2.9, key: 0.13, bloomThr: 1.2, sat: 1.02,
    vignette: 0.51, tint: [0.88, 0.92, 1.14], lift: [0, 0.0001, 0.0006], vigCol: [0.22, 0.22, 0.38], fill: 0.05, fillCol: [0.45, 0.45, 1.0] },
  { h: 23, ...NIGHT, pin: [-16, 250] },                                                                                   // night
];
for (const k of KEYS) {
  const [e, a] = arcPos(SUN_ARC, k.h);
  k.sunDE = k.pin ? k.pin[0] - e : 0;
  k.sunDA = k.pin ? wrapDeg(k.pin[1] - a) : 0;
}

// monotone cubic (Fritsch–Carlson) through the keys, periodic in 24 h
// the setting `fog`: the volumetric fog's density against the keys' `vfog` (normal: a little lighter than they are)
const FOG_AMOUNT = { off: 0, light: 0.45, normal: 0.8, thick: 1.4 };

const SCALARS = ['sunE', 'moonE', 'skyScale', 'cover', 'cloudAlpha', 'stars', 'fogD', 'fogFall', 'haze', 'vista', 'fogMax', 'env',
  'exposure', 'auto', 'key', 'minEx', 'maxEx', 'bloom', 'bloomThr', 'mist', 'vmist', 'vfog', 'sat', 'contrast', 'vignette', 'vibrance', 'glow', 'fill', 'shafts', 'sunDE', 'sunDA', 'blue', 'blueL'];
const VECS = ['nightBase', 'tint', 'lift', 'shadowCol', 'highCol', 'vigCol', 'fillCol'];
const CURVE_SRC = [...SCALARS.map(k => [k, key => key[k]]), ...VECS.flatMap(k => [0, 1, 2].map(i => [k + i, key => key[k][i]]))];
const NK = KEYS.length;
const SEG = KEYS.map((k, i) => (i === NK - 1 ? KEYS[0].h + 24 : KEYS[i + 1].h) - k.h);
const CURVES = Object.fromEntries(CURVE_SRC.map(([name, get]) => {
  const y = KEYS.map(get);
  const d = y.map((v, i) => (y[(i + 1) % NK] - v) / SEG[i]);
  const m = y.map((_, i) => {
    const p = (i + NK - 1) % NK;
    if (d[p] * d[i] <= 0) return 0;
    const w1 = 2 * SEG[i] + SEG[p], w2 = SEG[i] + 2 * SEG[p];
    return (w1 + w2) / (w1 / d[p] + w2 / d[i]);
  });
  return [name, { y, m }];
}));
function keySegment(hour) {
  let i = NK - 1;
  for (let j = 0; j < NK; j++) if (KEYS[j].h <= hour) i = j;
  const h = hour < KEYS[0].h ? hour + 24 : hour;
  return [i, (h - KEYS[i].h) / SEG[i]];
}
function hermite(c, i, t) {
  const j = (i + 1) % NK, h = SEG[i], t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * c.y[i] + (t3 - 2 * t2 + t) * h * c.m[i] + (-2 * t3 + 3 * t2) * c.y[j] + (t3 - t2) * h * c.m[j];
}

const _origin = new THREE.Vector3();
const dirFrom = (elev, azim, out = new THREE.Vector3()) => out.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(azim));
const sstep = THREE.MathUtils.smoothstep;
// below the horizon the transmittance is zero (the planet blocks the ray); clamping to the horizon dip of the
// 400 m eye keeps the last dim red value there, and the sunUp / moonUp fades take it to zero
const lowDir = d => [d[0], Math.max(d[1], -0.006), d[2]];

// "night" for decisions (lamps visible, automatic headlights) switches with hysteresis on the continuous darkness
const NIGHT_ON = 0.7, NIGHT_OFF = 0.45;

export class Environment {
  constructor(renderer, scene, pipeline) {
    this.renderer = renderer;
    this.scene = scene;
    this.pipeline = pipeline;
    this.sky = new Sky(renderer);
    scene.add(this.sky.dome);
    this.clouds = new Clouds(renderer, this.sky);   // volumetric (the quality level turns them on)
    this.clouds.enabled = false;
    if (pipeline) pipeline.clouds = this.clouds;
    this.fog = new VolumetricFog(renderer, this.clouds.noise.texture);   // the quality level and the setting turn it on
    this.fogAmount = FOG_AMOUNT.normal; this.fogQ = null;
    if (pipeline) pipeline.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.envJob = null;                // the probe refresh in progress (see updateProbe)
    this.slicedProbe = true;

    // sun by day, moon by night: one cascaded-shadow light (world cascades + the car's tile, render/cascadeShadow.js)
    this.sun = new SunLight(0xffffff, 3);
    this.sun.castShadow = true;
    if (installCascadeShadowChunks()) {
      this.sun.shadow = new CascadedSunShadow();
      this.sun.shadow.attach(renderer);
      this.sun.shadow.bias = 1.0;         // texels of the cascade
      this.sun.shadow.normalBias = 1.5;   // texels of the cascade
      this.sun.shadow.radius = 0.07;      // filter width (m)
    } else {                                // three's own two cascades, bias in depth units
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.05;
      this.sun.shadow.radius = 1.6;
    }
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.far = 170;   // shadow range (m)
    this.sun.shadow.camera.near = 20;   // caster ceiling above the view slice
    scene.add(this.sun);
    this.fog.sun = this.sun;
    // a cool fill from above (the painter's trick: shade goes lavender-blue, never olive) and a faint ground
    // bounce for surfaces facing down (the sky probe covers the rest); colours carry the strengths, intensity 1
    this.hemi = new THREE.HemisphereLight(0x000000, 0x000000, 1);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xc3d3e3, 0.002);

    // the hour being shown, the hour it is heading for, and the sweep between them (N key)
    this.hour = QUICK_HOURS.day;
    this.targetHour = this.hour;
    this.anim = null;
    this.dirty = true;
    this.appliedHour = this.hour;
    this.weather = null;               // world/weather.js sets itself here: the storm s, the rainbow bow
    this.appliedWeather = { s: -1, bow: -1 };
    this.cur = Object.fromEntries(VECS.map(k => [k, [0, 0, 0]]));
    this.flowLook = Object.fromEntries(VECS.map(k => [k, [0, 0, 0]]));   // scratch for flow()
    this.darkness = 0;                 // 0 (day) .. 1 (night), continuous: for everything that fades with the light
    this.night = false;                // darkness with hysteresis: only for on / off decisions (lamps, auto headlights)
    this.onNightChange = null;         // (night) => void, when `night` flips
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.envDirty = true;
    this.envTimer = 0;
    this.shadowScale = 1;
    this.flush();
  }

  // true while the picture is still changing (a sweep, an unapplied hour set, or the light probe catching up)
  get active() { return !!this.anim || this.dirty || this.envDirty || !!this.envJob; }
  get hourText() { const m = Math.round(this.hour * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

  // The one way to change the time. instant: the picture follows at once; otherwise a 2.5 s forward sweep.
  setHour(h, { instant = false } = {}) {
    h = wrapHour(+h);
    if (!Number.isFinite(h)) return;
    this.targetHour = h;
    if (instant || h === this.hour) { this.hour = h; this.anim = null; }
    else this.anim = { from: this.hour, dist: wrapHour(h - this.hour), t: 0 };
    this.dirty = true;
  }
  // q: CLOUDS[level] (render/quality.js) or null: the flat cloud layer instead
  setCloudQuality(q) {
    const on = !!q;
    if (q) { this.clouds.scale = q.scale; this.clouds.steps = q.steps; this.clouds.reset = true; }
    if (on !== this.clouds.enabled) { this.clouds.enabled = on; this.dirty = true; }
  }

  // q: FOG[level] (render/quality.js) or null: the analytic fog only
  setFogQuality(q) {
    this.fogQ = q;
    this.fog.enabled = !!q && this.fogAmount > 0;
    if (q) { this.fog.scale = q.scale; this.fog.steps = q.steps; this.fog.reset = true; }
  }

  // the setting `fog` (FOG_AMOUNT): a multiplier on the volumetric fog's density; off skips the pass
  setFogAmount(name) {
    this.fogAmount = FOG_AMOUNT[name] ?? FOG_AMOUNT.normal;
    this.fog.enabled = !!this.fogQ && this.fogAmount > 0;
    this.fog.reset = true;
    this.dirty = true;
  }

  // apply a pending hour change right away (otherwise it happens in the next update())
  flush() { this.dirty = false; this.apply(); }

  // the look at an hour: interpolated key frames + sun / moon positions from the arcs
  evalLook(hour, c = this.cur) {
    const [i, t] = keySegment(hour);
    for (const k of SCALARS) c[k] = hermite(CURVES[k], i, t);
    for (const k of VECS) for (let j = 0; j < 3; j++) c[k][j] = hermite(CURVES[k + j], i, t);
    c.auto = Math.min(1, Math.max(0, c.auto));
    const [se, sa] = arcPos(SUN_ARC, hour);
    c.sunElev = se + c.sunDE; c.sunAzim = sa + c.sunDA;
    [c.moonElev, c.moonAzim] = arcPos(MOON_ARC, hour);
    this.weatherLook(c);
    if (this.lookOverride) for (const k in this.lookOverride) { const v = this.lookOverride[k]; if (Array.isArray(v)) for (let j = 0; j < 3; j++) c[k][j] = v[j]; else c[k] = v; }   // tools: try a look
    return c;
  }

  // the storm (weather.js, 0 fair .. 1 rain under a full deck) on top of the hour's look: cloud cover, a dimmer
  // sun, thicker haze, a greyer, softer picture the eye opens up to
  weatherLook(c) {
    const s = this.weather?.s ?? 0;
    c.storm = s;
    c.sunDim = 0.8 * s * s * (3 - 2 * s);   // under a full deck the sun is all but gone (the clouds' shadow adds patches)
    if (s <= 0) return;
    const k = s * s * (3 - 2 * s);
    c.cover = c.cover + (0.97 - c.cover) * k;
    c.cloudAlpha = c.cloudAlpha + (1 - c.cloudAlpha) * k;
    c.fogD *= 1 + 2.2 * k; c.haze *= 1 + 7 * k; c.vista *= 1 + 4 * k;   // the rain curtains hide the far hills
    c.exposure *= 1 + 0.3 * k; c.minEx *= 1 + 0.3 * k; c.maxEx *= 1 + 0.3 * k;
    c.sat += (0.96 - c.sat) * k; c.vibrance *= 1 - 0.5 * k;
    c.mist += 0.15 * k; c.vfog *= 1 + 1.5 * k; c.glow *= 1 - 0.85 * k; c.shafts *= 1 - k; c.stars *= 1 - k;
    c.fill += 0.1 * k; c.env *= 1 + 0.25 * k;
    for (let j = 0; j < 3; j++) c.highCol[j] += (1 - c.highCol[j]) * k;
  }

  apply() {
    const c = this.evalLook(this.hour);
    this.appliedHour = this.hour;
    this.appliedWeather.s = c.storm; this.appliedWeather.bow = this.weather?.bow ?? 0;
    this.darkness = 1 - sstep(c.sunElev, -10, 4.5);     // 0 from the dusk key frame's sun height up, 1 below -10°
    const night = this.night ? this.darkness > NIGHT_OFF : this.darkness > NIGHT_ON;
    const flipped = night !== this.night;
    this.night = night;
    const { sd, md, sunUp, moonUp, Ts, Tm, sunRGB, moonTint } = this.applyLight(c);

    const sky = this.sky, S = c.skyScale;
    const sunE = new THREE.Vector3(c.sunE * S, c.sunE * S, c.sunE * S);
    const moonE = new THREE.Vector3(c.moonE * S * moonTint[0] * 0.5, c.moonE * S * moonTint[1] * 0.5, c.moonE * S * moonTint[2] * 0.5);
    const nb = new THREE.Vector3(...c.nightBase);
    sky.updateLUT(this.sunDir, sunE, this.moonDir, moonE, nb);
    const su = sky.uniforms;
    su.uMoonDisc.value.set(0.9, 0.93, 1.0).multiplyScalar(c.moonE * 1.2 * sstep(c.moonElev, -1, 2));
    su.uStars.value = c.stars;
    su.uCover.value = c.cover;
    su.uCloudAlpha.value = this.clouds.enabled ? 0 : c.cloudAlpha;   // the flat layer only without volumetric clouds

    // Horizon colours for fog / aerial perspective, from the same scattering model. Twilight keeps colouring the fog
    // until the sun is ~14° down; the moon adds its own.
    const parts = [];
    const wTwi = sstep(c.sunElev, -14, -2);
    if (wTwi > 0) parts.push({ L: sd, lE: c.sunE * S, tint: [1, 1, 1], w: wTwi });
    if (c.moonE * moonUp > 1e-6) parts.push({ L: md, lE: c.moonE * S * 0.5, tint: moonTint, w: moonUp });
    const side = [0, 0, 0], away = [0, 0, 0], toward = [0, 0, 0], zen = [0, 0, 0], blue = [0, 0, 0], Lf = new THREE.Vector3();
    for (const { L, lE, tint, w } of parts) {
      const az = Math.atan2(L[0], L[2]);
      const hz = (da, el = 0.03) => { const q = az + da; return [Math.cos(el) * Math.sin(q), Math.sin(el), Math.cos(el) * Math.cos(q)]; };
      const col = da => scatter(hz(da), L, 16).map((v, i) => v * lE * tint[i] * w);
      const sd_ = col(Math.PI / 2), aw = col(Math.PI), tw = col(0), zn = scatter([0, 1, 0], L, 12);
      const bl = scatter(hz(Math.PI * 0.75, 0.2), L, 12);
      for (let i = 0; i < 3; i++) { side[i] += sd_[i]; away[i] += aw[i]; toward[i] += tw[i]; zen[i] += zn[i] * lE * tint[i] * w; blue[i] += bl[i] * lE * tint[i] * w; }
      Lf.x += L[0] * Math.max(...sd_); Lf.y += L[1] * Math.max(...sd_); Lf.z += L[2] * Math.max(...sd_);
    }
    for (let i = 0; i < 3; i++) { side[i] += c.nightBase[i] * 0.9; away[i] += c.nightBase[i] * 0.9; toward[i] += c.nightBase[i] * 0.9; zen[i] += c.nightBase[i]; }
    // toward a low sun the horizon is far brighter (Mie forward scattering): uncapped, hills in front of a dusk
    // sun became a flat orange wall in the fog
    for (let i = 0; i < 3; i++) toward[i] = Math.min(toward[i], side[i] * 2.2 + 1e-4);
    if (Lf.lengthSq() < 1e-18) Lf.copy(this.sunDir); else Lf.normalize();
    // under a storm the horizon goes grey and a little darker, and the same all round: the deck spreads the light, so
    // the haze has no bright side towards the hidden sun (the far hills there stood out pale against the overcast sky)
    if (c.storm > 0) {
      for (const v of [side, away, toward, zen]) {
        const l = 0.3 * v[0] + 0.55 * v[1] + 0.15 * v[2];
        for (let i = 0; i < 3; i++) v[i] += (l * [0.36, 0.39, 0.43][i] - v[i]) * 0.85 * c.storm;
      }
      for (const v of [away, toward]) for (let i = 0; i < 3; i++) v[i] += (side[i] - v[i]) * 0.9 * c.storm;
    }
    // fog is slightly darker than the sky right at the horizon (it is lit, but also shadowed by terrain)
    const k = 0.92;
    setVec4(ATMO.atmoSun, Lf.x, Lf.y, Lf.z, c.fogFall);
    setVec4(ATMO.atmoAway, away[0] * k, away[1] * k, away[2] * k, 0);
    setVec4(ATMO.atmoSide, side[0] * k, side[1] * k, side[2] * k, c.haze);
    setVec4(ATMO.atmoToward, toward[0] * k, toward[1] * k, toward[2] * k, c.fogMax);
    // the thin haze's blue: the sky ~11 degrees up, as bright as the horizon (only its hue is taken)
    {
      const lb = 0.2126 * blue[0] + 0.7152 * blue[1] + 0.0722 * blue[2] + 1e-9, ls = 0.2126 * side[0] + 0.7152 * side[1] + 0.0722 * side[2];
      const q = ls / lb * k * (c.blueL ?? 0.92);
      setVec4(ATMO.atmoBlue, blue[0] * q, blue[1] * q, blue[2] * q, (c.blue ?? 0) * (1 - c.storm));
    }
    // a soft glow around the sun in the haze (Mie), coloured by the light that reaches us
    const gk = c.glow * sunUp * 0.004;
    setVec4(ATMO.atmoGlow, sunRGB[0] * gk, sunRGB[1] * gk, sunRGB[2] * gk, 0.75);
    // valley mist: a shallow layer lying in the low ground (floor 6 m under the lake, falling off over ~9 m)
    setVec4(ATMO.atmoMist, Math.max(0, c.vmist), 0.11, -6, 0);
    // (the land beyond the window is the same world as the window, not a backdrop: a lighter haze than the keys')
    ATMO.atmoVista.x = c.vista * 0.45;
    // volumetric fog: the haze in the low ground, lit through the shadows; in shade it takes the horizon's colour
    const F = this.fog.params;
    F.density = c.vfog * this.fogAmount; F.falloff = 0.022; F.floor = 0;
    const sl = 0.2126 * side[0] + 0.7152 * side[1] + 0.0722 * side[2];
    F.amb.set(side[0] + (sl - side[0]) * 0.4, side[1] + (sl - side[1]) * 0.4, side[2] + (sl - side[2]) * 0.4).multiplyScalar(0.75);
    this.scene.fog.density = c.fogD;
    this.scene.fog.color.setRGB(side[0], side[1], side[2]);

    // clouds lit by the sun (moon) colour above the haze; ambient from the zenith sky
    const cloudSun = sstep(c.sunElev, -8, 1.5);
    const lit = Ts.map((v, i) => Math.pow(v, 0.6) * c.sunE * cloudSun + Math.pow(Tm[i], 0.6) * c.moonE * moonTint[i] * moonUp);
    su.uCloudLit.value.set(lit[0], lit[1], lit[2]).multiplyScalar(0.55);
    su.uCloudAmb.value.set(zen[0] * 3.2 + side[0] * 0.8, zen[1] * 3.2 + side[1] * 0.8, zen[2] * 3.2 + side[2] * 0.8);
    su.uOvercast.value = c.storm;
    su.uOvercastCol.value.set(zen[0] * 0.8 + side[0] * 0.9, zen[1] * 0.8 + side[1] * 0.9, zen[2] * 0.8 + side[2] * 0.9);
    const cwu = this.clouds.mat.uniforms;
    su.uHazeCol.value.set(side[0] * k, side[1] * k, side[2] * k);
    cwu.uOvercast.value = c.storm; cwu.uOvercastCol.value.copy(su.uOvercastCol.value); cwu.uHazeCol.value.copy(su.uHazeCol.value);
    su.uGround.value.set(side[0] * 0.25 + 0.002, side[1] * 0.25 + 0.002, side[2] * 0.25 + 0.0015);
    su.uSunSize.value = 0.0125 * (1 + (1 - sstep(c.sunElev, 0, 15)) * 0.4);

    // volumetric clouds: coverage from the key, lit by the sun (or the moon), sky light from above; their
    // shadows on the ground (through every lit material's sun shadow)
    const cu = this.clouds.mat.uniforms;
    CLOUD.map.z = c.cover;
    CLOUD.map.w = this.clouds.enabled ? (0.68 + 0.24 * c.storm) * sstep(c.sunElev, -4, 6) : 0;
    cu.uDensity.value = 1 + 0.6 * c.storm;
    cu.uHaze.value = 0.00004 * (1 + 6 * c.storm);   // under a storm the deck fades into the rain haze towards the horizon
    cu.uLightCol.value.copy(su.uCloudLit.value);
    cu.uAmbTop.value.copy(su.uCloudAmb.value);
    cu.uAmbBot.value.copy(su.uCloudAmb.value).multiplyScalar(0.42);

    const bounce = (c.sunE * sunUp * Ts[1] + c.moonE * moonUp * Tm[1]) * 0.04;
    this.hemi.groundColor.setRGB(0.36 * bounce, 0.30 * bounce, 0.22 * bounce);
    this.hemi.userData.level = bounce;   // the ambient level the lamps scale against (VehicleView.ambientLevel)
    this.hemi.color.setRGB(c.fillCol[0] * c.fill, c.fillCol[1] * c.fill, c.fillCol[2] * c.fill);

    if (this.pipeline) {
      const P = this.pipeline.params;
      P.exposure = c.exposure;
      P.auto = c.auto;
      P.autoExposure = c.auto > 0.001;       // the eye-adaptation pass only runs while it matters
      P.key = c.key; P.minExposure = c.minEx; P.maxExposure = c.maxEx;
      P.bloomStrength = c.bloom; P.bloomThreshold = c.bloomThr; P.mist = c.mist;
      P.saturation = c.sat; P.contrast = c.contrast; P.vignette = c.vignette;
      P.tint.setRGB(...c.tint); P.lift.setRGB(...c.lift);
      // the rainbow: opposite the sun, while a shower clears (weather.bow), the sun low enough to lift it
      const bow = (this.weather?.bow ?? 0) * sunUp * (1 - sstep(c.sunElev, 30, 44));
      P.bow.set(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z, bow);
      P.bowCol.set(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(0.12 * bow);
      P.shadowCol.setRGB(...c.shadowCol); P.highCol.setRGB(...c.highCol); P.vigCol.setRGB(...c.vigCol); P.vibrance = c.vibrance;
      this.pipeline.resetExposure = true;    // the picture follows the hour exactly, no adaptation lag
    }
    this.envDirty = true;
    if (flipped && this.onNightChange) this.onNightChange(night);
  }

  // The direct light at the look `c`: sun and moon directions, colour and strength, the shadow direction, the sun
  // disc, light shafts and the clouds' light. Cheap, so while time passes it runs every frame (the shadows move
  // smoothly) and the rest of the look (sky table, fog, grade, light probe) follows in small steps.
  applyLight(c) {
    dirFrom(c.sunElev, c.sunAzim, this.sunDir);
    dirFrom(c.moonElev, c.moonAzim, this.moonDir);
    const sd = this.sunDir.toArray(), md = this.moonDir.toArray();

    // Direct light: sun and moon add up, each fading with its own height, so the dusk / dawn hand-over is
    // continuous (one light; the shadow direction follows the brighter one).
    const sunUp = sstep(c.sunElev, -2, 1.5);
    const moonUp = sstep(c.moonElev, -1, 3);
    const Ts = transmittance(lowDir(sd)), Tm = transmittance(lowDir(md));
    const moonTint = MOON_TINT;
    const sunRGB = Ts.map(v => v * c.sunE);
    const moonRGB = Tm.map((v, i) => v * c.moonE * moonTint[i]);
    const rgb = sunRGB.map((v, i) => (v * sunUp + moonRGB[i] * moonUp) * (1 - c.sunDim));
    const I = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    this.sun.color.setRGB(rgb[0] / I, rgb[1] / I, rgb[2] / I);
    this.sun.intensity = I;
    this.lightDir.set(0, 0, 0)
      .addScaledVector(this.sunDir, Math.max(...sunRGB) * sunUp)
      .addScaledVector(this.moonDir, Math.max(...moonRGB) * moonUp);
    if (this.lightDir.lengthSq() < 1e-12) this.lightDir.copy(this.sunDir); else this.lightDir.normalize();
    // keep the shadow camera above the horizon (long dusk shadows stay bounded)
    if (this.lightDir.y < 0.1) { this.lightDir.y = 0.1; this.lightDir.normalize(); }
    this.sun.position.copy(this.lightDir);

    const su = this.sky.uniforms;
    su.uSunDir.value.copy(this.sunDir); su.uMoonDir.value.copy(this.moonDir);
    su.uSunDisc.value.set(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(5000 * sunUp);
    const Lc = this.sunDir.y > -0.05 ? this.sunDir : this.moonDir;
    CLOUD.sun.x = Lc.x; CLOUD.sun.y = Lc.y; CLOUD.sun.z = Lc.z;
    this.clouds.mat.uniforms.uLight.value.copy(Lc);
    // the fog's light: scattered many times over it whitens (in the sun's colour it was an orange wall at dawn)
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    this.fog.params.lightDir.copy(Lc);
    this.fog.params.lightCol.set(rgb[0] + (lum - rgb[0]) * 0.45, rgb[1] + (lum - rgb[1]) * 0.45, rgb[2] + (lum - rgb[2]) * 0.45);
    if (this.pipeline) {
      const P = this.pipeline.params;
      P.shaftDir.copy(this.sunDir);
      P.shaftCol.set(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(c.shafts * sunUp);
    }
    return { sd, md, sunUp, moonUp, Ts, Tm, sunRGB, moonTint };
  }

  // time passing (setting timeFlow): the light every frame, the whole look every FLOW_STEP hours
  flow(dh) {
    if (this.anim || !(dh > 0)) return;
    this.hour = this.targetHour = wrapHour(this.hour + dh);
    if (this.dirty || wrapHour(this.hour - this.appliedHour) >= FLOW_STEP) this.dirty = true;
    else this.applyLight(this.evalLook(this.hour, this.flowLook));
  }

  update(dt, focus, camera) {
    const an = this.anim;
    if (an) {
      an.t = Math.min(1, an.t + dt / ANIM_TIME);
      const s = an.t * an.t * (3 - 2 * an.t);
      this.hour = an.t >= 1 ? this.targetHour : wrapHour(an.from + an.dist * s);
      if (an.t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (this.dirty) this.flush();
    if (camera) this.sky.update(dt, camera);
    this.clouds.update(dt, 5.5, 3.2);   // drift with the wind (m/s)
    this.fog.update(dt, 1.2, 0.7);
    this.updateProbe(dt);
  }

  // ---- ambient light / reflection probe (PMREM of the sky dome)
  // three's fromScene() does the whole GGX prefilter in one frame (a hitch per refresh while the hour changes), so the
  // same steps run one per frame (scene to cube, then one roughness level, ~15 frames) and the probe is swapped in at
  // the end. Relies on PMREMGenerator internals (three is pinned); falls back to fromScene() without them.
  updateProbe(dt) {
    if (this.envJob) { this.probeStep(); return; }
    this.envTimer -= dt;
    if (!this.envDirty || this.envTimer > 0) return;
    if (!this.envRT || !this.probeStart()) { this.probeSync(); return; }
    this.envDirty = false;
    this.probeStep();
  }

  probeSync() {
    this.setProbe(this.pmrem.fromScene(this.sky.envScene, 0, 0.1, 1000));
    this.envDirty = false;
  }

  setProbe(rt) {
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = this.cur.env;
    this.envTimer = 0.05;
  }

  probeStart() {
    const p = this.pmrem;
    if (this.slicedProbe === false || !p._setSize || !p._allocateTargets || !p._sceneToCubeUV || !p._applyGGXFilter) return false;
    p._setSize(256);
    const rt = p._allocateTargets();
    rt.depthBuffer = true;
    this.envJob = { rt, step: 0 };
    return true;
  }

  probeStep() {
    const job = this.envJob, p = this.pmrem, r = this.renderer;
    const prevRT = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel(), autoClear = r.autoClear;
    try {
      if (job.step === 0) p._sceneToCubeUV(this.sky.envScene, 0.1, 1000, job.rt, _origin);
      else { r.autoClear = false; p._applyGGXFilter(job.rt, job.step - 1, job.step); }
    } catch (e) {
      console.warn('sliced PMREM failed, using fromScene', e);
      this.slicedProbe = false; this.envJob = null; r.autoClear = autoClear; r.setRenderTarget(prevRT, face, mip);
      job.rt.dispose(); this.probeSync();
      return;
    }
    r.autoClear = autoClear;
    r.setRenderTarget(prevRT, face, mip);
    if (++job.step >= p._lodMeshes.length) {
      const rt = job.rt;
      rt.scissorTest = false;
      rt.viewport.set(0, 0, rt.width, rt.height);
      rt.scissor.set(0, 0, rt.width, rt.height);
      this.envJob = null;
      this.setProbe(rt);
    }
  }

  // bring everything up to date right now (tests, screenshots): pending hour, running probe, a fresh probe
  settle() {
    if (this.dirty) this.flush();
    while (this.envJob) this.probeStep();
    if (this.envDirty) this.probeSync();
  }
}
