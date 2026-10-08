import * as THREE from 'three/webgpu';
import { Sky } from './sky.js';
import { scatter, transmittance } from './atmosphere.js';
import { ATMO, setVec4, makeFogNode } from '../render/fog.js';
import { SunShadows } from '../render/shadows.js';

// Time of day: sun / moon light (cascaded shadows), physically based sky + clouds + stars, height fog and
// aerial perspective matched to the sky, image-based ambient light from the sky, and the post-processing
// look (exposure / eye adaptation, bloom, grade) for day / dusk / night.
//
// Light units (three.js "physically correct" lights): the sun is ~3.5 lux-equivalent at noon. Lamps are
// expected in candela with decay 2: a ~300 cd low beam gives ~1–3 units on the ground at 10–15 m, which
// the night exposure renders as a well-lit mid tone, while moonlit ground (~0.1) stays dim and blue.

// ---------------------------------------------------------------------------------------------------------
// Time of day is one number: the hour, 0..24, continuous. Everything follows from it:
//  * sun and moon positions come from arcs (a simple celestial-sphere model, below), not from interpolation;
//  * the look (sky scale, fog, exposure, grade, ...) is a table of key frames by hour, interpolated with a
//    monotone cubic (no overshoot, no kinks at the keys) and wrapping through midnight;
//  * the three old presets live on as key frames at their hours and render exactly as they used to
//    (QUICK_HOURS): day 13:00, dusk 19:30, night 23:00.
// `setHour(h, { instant })` is the single entry point: instant for sliders / startup, animated (a 2.5 s sweep
// forward through the hours) for the N key. A clock that advances by itself would just call setHour(h, { instant: true }).

export const QUICK_HOURS = { day: 13, dusk: 19.5, night: 23 };
export const QUICK_ORDER = ['day', 'dusk', 'night'];
const ANIM_TIME = 2.5;

const DAY = {
  sunE: 4.0, moonE: 0, skyScale: 4.2, nightBase: [0, 0, 0],
  cover: 0.42, cloudAlpha: 0.95, stars: 0, fogD: 0.00045, fogFall: 0.012, haze: 0.00009, fogMax: 1, env: 1.0,
  exposure: 0.75, auto: 0, key: 0.16, minEx: 0.75, maxEx: 0.75, bloom: 0.045, bloomThr: 2.0,
  sat: 1.06, contrast: 0.14, vignette: 0.22, tint: [1.0, 1.0, 1.0], lift: [0, 0, 0],
};
const DUSK = {
  sunE: 5.0, moonE: 0, skyScale: 4.6, nightBase: [0.0004, 0.0006, 0.0012],
  cover: 0.5, cloudAlpha: 1.0, stars: 0.08, fogD: 0.0006, fogFall: 0.016, haze: 0.0001, fogMax: 0.92, env: 1.0,
  exposure: 1.25, auto: 0, key: 0.16, minEx: 1.25, maxEx: 1.25, bloom: 0.06, bloomThr: 1.6,
  sat: 1.08, contrast: 0.16, vignette: 0.28, tint: [1.0, 0.98, 0.95], lift: [0, 0, 0.0004],
};
const NIGHT = {
  sunE: 5.0, moonE: 0.22, skyScale: 4.2, nightBase: [0.0011, 0.0016, 0.003],
  cover: 0.32, cloudAlpha: 0.75, stars: 1, fogD: 0.0012, fogFall: 0.016, haze: 0.00012, fogMax: 1, env: 1.0,
  exposure: 2.0, auto: 1, key: 0.06, minEx: 1.0, maxEx: 3.2, bloom: 0.06, bloomThr: 1.4,
  sat: 0.86, contrast: 0.1, vignette: 0.32, tint: [0.92, 0.97, 1.1], lift: [0.0, 0.0002, 0.0006],
};

// Sun and moon arcs: latitude, declination (deg), hour of upper transit (south), azimuth of south in the
// game's frame (azimuth runs from +z towards +x; the old presets put the sunset at 250°, which makes south
// 155.7° with the sun moving in increasing azimuth). The sun's arc is the one that comes closest to the
// three presets (13:00 elev 40° az 145°, 19:30 elev 4.5° az 250°, 23:00 elev -16° az 250°); `pin` on a key
// frame then moves the sun *exactly* onto the preset position at that hour, fading out towards the
// neighbouring keys. The moon's arc passes exactly through the night preset (23:00 elev 38° az 70°).
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
  { h: 1.5, ...NIGHT, nightBase: [0.0009, 0.0013, 0.0025], cover: 0.3, fogD: 0.0013 },                                   // deep night
  { h: 6, ...NIGHT, moonE: 0.14, nightBase: [0.0008, 0.0012, 0.0024], cover: 0.36, cloudAlpha: 0.82, stars: 0.5,           // pre-dawn
    fogD: 0.001, haze: 0.00011, exposure: 1.7, key: 0.07, sat: 0.92, contrast: 0.12, vignette: 0.3,
    tint: [0.95, 0.98, 1.06], lift: [0, 0.00015, 0.0005] },
  { h: 7.5, ...DUSK, fogD: 0.00068, fogMax: 0.95, tint: [0.98, 0.985, 0.985], pin: [4.5, 2 * SOUTH - 250] },             // dawn: dusk's mirror image
  { h: 10, ...DAY, cover: 0.46, fogD: 0.00055, haze: 0.0001, exposure: 0.78, tint: [1.0, 0.995, 0.985], sat: 1.07 },     // morning
  { h: 13, ...DAY, pin: [40, 145] },                                                                                      // day
  { h: 18.25, ...DAY, sunE: 4.6, skyScale: 4.4, cover: 0.48, cloudAlpha: 0.98, fogD: 0.00052, fogFall: 0.0135,            // golden hour
    haze: 0.000095, nightBase: [0.0001, 0.00015, 0.0003], exposure: 0.95, bloom: 0.052, bloomThr: 1.8, sat: 1.09,
    contrast: 0.15, vignette: 0.25, tint: [1.0, 0.975, 0.935], lift: [0, 0, 0.0002] },
  { h: 19.5, ...DUSK, pin: [4.5, 250] },                                                                                  // dusk
  { h: 20.5, ...NIGHT, moonE: 0.18, nightBase: [0.0007, 0.001, 0.002], cover: 0.4, cloudAlpha: 0.88, stars: 0.4,          // blue hour
    fogD: 0.0009, haze: 0.00011, fogMax: 0.96, exposure: 1.6, key: 0.07, bloomThr: 1.5, sat: 0.95, contrast: 0.13,
    vignette: 0.3, tint: [0.95, 0.975, 1.05], lift: [0, 0.0001, 0.0004] },
  { h: 23, ...NIGHT, pin: [-16, 250] },                                                                                   // night
];
for (const k of KEYS) {
  const [e, a] = arcPos(SUN_ARC, k.h);
  k.sunDE = k.pin ? k.pin[0] - e : 0;
  k.sunDA = k.pin ? wrapDeg(k.pin[1] - a) : 0;
}

// monotone cubic (Fritsch–Carlson) through the keys, periodic in 24 h
const SCALARS = ['sunE', 'moonE', 'skyScale', 'cover', 'cloudAlpha', 'stars', 'fogD', 'fogFall', 'haze', 'fogMax', 'env',
  'exposure', 'auto', 'key', 'minEx', 'maxEx', 'bloom', 'bloomThr', 'sat', 'contrast', 'vignette', 'sunDE', 'sunDA'];
const VECS = ['nightBase', 'tint', 'lift'];
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
// below the horizon the transmittance is zero (the planet blocks the ray); clamping the direction to the
// horizon dip of the 400 m eye keeps the last dim red value there, and the sunUp / moonUp fades take it to zero
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
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.envJob = null;                // the probe refresh in progress (see updateProbe)
    this.slicedProbe = true;

    // sun by day, moon by night: one cascaded-shadow light (2-4 cascades, see render/shadows.js)
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.target.position.set(0, 0, 0);
    this.shadows = new SunShadows(this.sun);
    scene.add(this.sun, this.sun.target);
    // faint ground bounce for surfaces facing down (the sky probe covers the upper hemisphere)
    this.hemi = new THREE.HemisphereLight(0x000000, 0x5d4d36, 0);
    scene.add(this.hemi);
    scene.fogNode = makeFogNode();
    // weather (weather.js drives it): rain 0..1 darkens and greys the light, thickens the fog and the clouds
    this.weather = { rain: 0, mist: 0 };

    // the hour being shown, the hour it is heading for, and the sweep between them (N key)
    this.hour = QUICK_HOURS.day;
    this.targetHour = this.hour;
    this.anim = null;
    this.dirty = true;
    this.cur = { nightBase: [0, 0, 0], tint: [1, 1, 1], lift: [0, 0, 0] };
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

  // true while the picture is still changing (a sweep, an hour set that has not been applied yet, or the
  // ambient light probe catching up)
  get active() { return !!this.anim || this.dirty || this.envDirty || !!this.envJob; }
  get hourText() { const m = Math.round(this.hour * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

  // The one way to change the time. instant: the picture follows at once (sliders, startup, a future
  // clock); otherwise a 2.5 s sweep forward through the hours (hours in between are shown on the way).
  setHour(h, { instant = false } = {}) {
    h = wrapHour(+h);
    if (!Number.isFinite(h)) return;
    this.targetHour = h;
    if (instant || h === this.hour) { this.hour = h; this.anim = null; }
    else this.anim = { from: this.hour, dist: wrapHour(h - this.hour), t: 0 };
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
    return c;
  }

  apply() {
    const c = this.evalLook(this.hour);
    this.darkness = 1 - sstep(c.sunElev, -10, 4.5);     // 0 from the dusk key frame's sun height up, 1 below -10°
    const night = this.night ? this.darkness > NIGHT_OFF : this.darkness > NIGHT_ON;
    const flipped = night !== this.night;
    this.night = night;
    dirFrom(c.sunElev, c.sunAzim, this.sunDir);
    dirFrom(c.moonElev, c.moonAzim, this.moonDir);
    const sd = this.sunDir.toArray(), md = this.moonDir.toArray();

    // Direct light: the sun and the moon add up; each fades with its own height around the horizon, so the
    // hand-over at dusk and dawn is continuous (one light, the shadow direction follows the brighter one).
    const sunUp = sstep(c.sunElev, -2, 1.5);
    const moonUp = sstep(c.moonElev, -1, 3);
    const Ts = transmittance(lowDir(sd)), Tm = transmittance(lowDir(md));
    const moonTint = [0.62, 0.74, 1.0];
    const sunRGB = Ts.map(v => v * c.sunE);
    const moonRGB = Tm.map((v, i) => v * c.moonE * moonTint[i]);
    const rgb = sunRGB.map((v, i) => v * sunUp + moonRGB[i] * moonUp);
    const I = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    this.sun.color.setRGB(rgb[0] / I, rgb[1] / I, rgb[2] / I);
    this.sun.intensity = I;
    this.lightDir.set(0, 0, 0)
      .addScaledVector(this.sunDir, Math.max(...sunRGB) * sunUp)
      .addScaledVector(this.moonDir, Math.max(...moonRGB) * moonUp);
    if (this.lightDir.lengthSq() < 1e-12) this.lightDir.copy(this.sunDir); else this.lightDir.normalize();
    // keep the shadow camera above the horizon (long dusk shadows stay bounded)
    if (this.lightDir.y < 0.1) { this.lightDir.y = 0.1; this.lightDir.normalize(); }
    this.sun.position.copy(this.lightDir).multiplyScalar(400);

    // sky LUT
    const sky = this.sky, S = c.skyScale;
    const sunE = new THREE.Vector3(c.sunE * S, c.sunE * S, c.sunE * S);
    const moonE = new THREE.Vector3(c.moonE * S * moonTint[0] * 0.5, c.moonE * S * moonTint[1] * 0.5, c.moonE * S * moonTint[2] * 0.5);
    const nb = new THREE.Vector3(...c.nightBase);
    sky.updateLUT(this.sunDir, sunE, this.moonDir, moonE, nb);
    const su = sky.uniforms;
    su.uSunDisc.value.set(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(5000 * sunUp);
    su.uMoonDisc.value.set(0.9, 0.93, 1.0).multiplyScalar(c.moonE * 1.2 * sstep(c.moonElev, -1, 2));
    su.uStars.value = c.stars;
    su.uCover.value = c.cover;
    su.uCloudAlpha.value = c.cloudAlpha;

    // Horizon colours for the fog / aerial perspective, from the same scattering model. Twilight keeps
    // colouring the fog after the sun has set (until it is ~14° down); the moon adds its own.
    const parts = [];
    const wTwi = sstep(c.sunElev, -14, -2);
    if (wTwi > 0) parts.push({ L: sd, lE: c.sunE * S, tint: [1, 1, 1], w: wTwi });
    if (c.moonE * moonUp > 1e-6) parts.push({ L: md, lE: c.moonE * S * 0.5, tint: moonTint, w: moonUp });
    const side = [0, 0, 0], away = [0, 0, 0], toward = [0, 0, 0], zen = [0, 0, 0], Lf = new THREE.Vector3();
    for (const { L, lE, tint, w } of parts) {
      const az = Math.atan2(L[0], L[2]);
      const hz = (da, el = 0.03) => { const q = az + da; return [Math.cos(el) * Math.sin(q), Math.sin(el), Math.cos(el) * Math.cos(q)]; };
      const col = da => scatter(hz(da), L, 16).map((v, i) => v * lE * tint[i] * w);
      const sd_ = col(Math.PI / 2), aw = col(Math.PI), tw = col(0), zn = scatter([0, 1, 0], L, 12);
      for (let i = 0; i < 3; i++) { side[i] += sd_[i]; away[i] += aw[i]; toward[i] += tw[i]; zen[i] += zn[i] * lE * tint[i] * w; }
      Lf.x += L[0] * Math.max(...sd_); Lf.y += L[1] * Math.max(...sd_); Lf.z += L[2] * Math.max(...sd_);
    }
    for (let i = 0; i < 3; i++) { side[i] += c.nightBase[i] * 0.9; away[i] += c.nightBase[i] * 0.9; toward[i] += c.nightBase[i] * 0.9; zen[i] += c.nightBase[i]; }
    // towards a low sun the horizon is many times brighter than elsewhere (Mie forward scattering): in
    // the fog that turned every hill between the camera and a dusk sun into a flat orange wall
    for (let i = 0; i < 3; i++) toward[i] = Math.min(toward[i], side[i] * 2.2 + 1e-4);
    if (Lf.lengthSq() < 1e-18) Lf.copy(this.sunDir); else Lf.normalize();
    // fog is slightly darker than the sky right at the horizon (it is lit, but also shadowed by terrain)
    const k = 0.92;
    setVec4(ATMO.atmoSun, Lf.x, Lf.y, Lf.z, c.fogFall);
    setVec4(ATMO.atmoAway, away[0] * k, away[1] * k, away[2] * k, 0);
    setVec4(ATMO.atmoSide, side[0] * k, side[1] * k, side[2] * k, c.haze);
    setVec4(ATMO.atmoToward, toward[0] * k, toward[1] * k, toward[2] * k, c.fogMax);
    setVec4(ATMO.atmoGlow, 0, 0, 0, 0.75);
    ATMO.fogParams.value.x = c.fogD;
    this.fogColor = new THREE.Color(side[0], side[1], side[2]);

    // clouds lit by the sun (moon) colour above the haze; ambient from the zenith sky
    const cloudSun = sstep(c.sunElev, -8, 1.5);
    const lit = Ts.map((v, i) => Math.pow(v, 0.6) * c.sunE * cloudSun + Math.pow(Tm[i], 0.6) * c.moonE * moonTint[i] * moonUp);
    su.uCloudLit.value.set(lit[0], lit[1], lit[2]).multiplyScalar(0.55);
    su.uCloudAmb.value.set(zen[0] * 3.2 + side[0] * 0.8, zen[1] * 3.2 + side[1] * 0.8, zen[2] * 3.2 + side[2] * 0.8);
    su.uGround.value.set(side[0] * 0.25 + 0.002, side[1] * 0.25 + 0.002, side[2] * 0.25 + 0.0015);
    su.uSunSize.value = 0.0125 * (1 + (1 - sstep(c.sunElev, 0, 15)) * 0.4);

    // sun shafts (post.js): the sun's own colour, only while it is up
    this.shaftColor = (this.shaftColor || new THREE.Color()).setRGB(sunRGB[0], sunRGB[1], sunRGB[2]).multiplyScalar(0.3 * sunUp);
    this.shaftVis = sunUp * sstep(c.sunElev, -1, 6);

    this.hemi.groundColor.setRGB(0.36, 0.30, 0.22);
    this.hemi.intensity = (c.sunE * sunUp * Ts[1] + c.moonE * moonUp * Tm[1]) * 0.04;

    // post-processing look
    if (this.pipeline) {
      const P = this.pipeline.params;
      P.exposure = c.exposure;
      P.auto = c.auto;
      P.autoExposure = c.auto > 0.001;       // the eye-adaptation pass only runs while it matters
      P.key = c.key; P.minExposure = c.minEx; P.maxExposure = c.maxEx;
      P.bloomStrength = c.bloom; P.bloomThreshold = c.bloomThr;
      P.saturation = c.sat; P.contrast = c.contrast; P.vignette = c.vignette;
      P.tint.setRGB(...c.tint); P.lift.setRGB(...c.lift);
      this.pipeline.resetExposure = true;    // the picture follows the hour exactly, no adaptation lag
    }
    this.envDirty = true;
    if (flipped && this.onNightChange) this.onNightChange(night);
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
    if (camera) {
      this.sky.update(dt, camera);
      this.pipeline?.setSun?.(this.sunDir, this.shaftColor, this.shaftVis * (1 - 0.85 * this.weather.rain));
    }
    this.updateProbe(dt);
  }

  // ---- ambient light / reflection probe (PMREM of the sky dome)
  // three's fromScene() does the whole prefilter in one go: with the GGX filter that is about a full frame of
  // GPU time, a hitch every refresh while the hour is changing. The same steps are run one per frame instead
  // (scene to cube, then one roughness level per frame, ~15 frames), and the probe is swapped in when it is
  // complete. These are three's own PMREMGenerator internals (pinned version); without them it falls back
  // to fromScene().
  updateProbe(dt) {
    if (this.envJob) { this.probeStep(); return; }
    this.envTimer -= dt;
    if (!this.envDirty || this.envTimer > 0) return;
    if (!this.envRT || !this.probeStart()) { this.probeSync(); return; }
    this.envDirty = false;
    this.probeStep();
  }

  probeSync() {
    const rt = this.probeTarget();
    this.pmrem.fromScene(this.sky.envScene, 0, 0.1, 1000, { size: 256, renderTarget: rt });
    this.setProbe(rt);
    this.envDirty = false;
  }

  // two probe targets used in turn: the one being filtered is never the one the materials sample
  probeTarget() {
    this.probeRT = this.probeRT || [null, null];
    this.probeI = 1 - (this.probeI || 0);
    if (!this.probeRT[this.probeI]) { this.pmrem._setSize(256); this.probeRT[this.probeI] = this.pmrem._allocateTarget(true); }
    return this.probeRT[this.probeI];
  }

  // the finished probe is copied into one target the scene keeps: a different scene.environment texture
  // rebuilds every lit shader (a freeze per probe refresh while the hour sweeps)
  setProbe(rt) {
    this.envRT = rt;
    const p = this.pmrem;
    if (!this.envShown && p._allocateTarget) { p._setSize(256); this.envShown = p._allocateTarget(true); }
    if (this.envShown && this.envShown.width === rt.width && this.envShown.height === rt.height) {
      this.renderer.copyTextureToTexture(rt.texture, this.envShown.texture);
      if (this.scene.environment !== this.envShown.texture) this.scene.environment = this.envShown.texture;
    } else this.scene.environment = rt.texture;
    this.scene.environmentIntensity = this.cur.env;
    this.envTimer = 0.05;
  }

  probeStart() {
    const p = this.pmrem;
    if (this.slicedProbe === false || !p._setSize || !p._init || !p._sceneToCubeUV || !p._applyGGXFilter) return false;
    p._setSize(256);
    const rt = this.probeTarget();
    p._init(rt);
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
      this.probeSync();
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
