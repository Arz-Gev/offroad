import * as THREE from 'three/webgpu';

// Truck lamps. Real headlamps shape their beam so the road is evenly lit from a few metres out to the
// cut-off: very little light goes steeply down (near field), most goes just below the horizon (far
// field). Ground illuminance from a lamp at height h is E = I * h / r^3, so a plain cone always gives a
// blown-out pool at the bumper and nothing further away. Here every beam is a SpotLight with a
// light cookie (SpotLight.map) that encodes the angular intensity distribution I(elevation, azimuth).
//
// Lights (all on the truck root, only made visible at night or when something is switched on, so the
// day scene pays nothing for them):
//   head  - one spot between the headlamps, low/high beam cookies, the only shadow caster
//   bar   - roof light bar, wide long-range flood, no shadow (the source is above the eye anyway)
//   rear  - one small dim spot for tail/brake glow and the reversing lamps
// Lens glow comes from emissive materials; there are no point lights.

// The lamps' irradiance shoulder (a soft cap on very close, bright surfaces) is in render/lamps.js.
export { LAMP_KNEE } from '../render/lamps.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Cookie texture covering the spot's projection (fov = 2 * angle, square). fn(elev, azim) -> intensity.
// Stored as half floats: the near-field values are 1/100 .. 1/1000 of the peak and band in 8 bits.
function makeCookie(fn, angle, N = 512) {
  const T = Math.tan(angle);
  const vals = new Float32Array(N * N);
  let max = 0;
  for (let j = 0; j < N; j++) {
    const ty = ((j + 0.5) / N * 2 - 1) * T;
    for (let i = 0; i < N; i++) {
      const tx = ((i + 0.5) / N * 2 - 1) * T;
      const az = Math.atan(tx);
      const el = Math.atan2(ty, Math.sqrt(1 + tx * tx));
      const off = Math.acos(1 / Math.sqrt(1 + tx * tx + ty * ty));
      const v = fn(el, az) * smooth(angle, angle - 0.1, off);
      vals[j * N + i] = v;
      if (v > max) max = v;
    }
  }
  const data = new Uint16Array(N * N * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let k = 0; k < N * N; k++) {
    const c = THREE.DataUtils.toHalfFloat(vals[k] / max);
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = c;
    data[k * 4 + 3] = one;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  t.userData.peak = max;
  return t;
}

// European-style low beam (right-hand traffic): flat cut-off just below the horizon on the left, 15°
// kick-up on the right, hot zone right under the cut-off, wide soft foreground.
function lowBeam(el, az) {
  const d = -el; // depression below the horizon
  const base = 0.009;
  const kick = az > 0.02 ? Math.min((az - 0.02) * 0.27, 0.026) : 0;
  const cut = base - kick;                            // the kick-up only raises the edge
  const below = smooth(cut - 0.004, cut + 0.008, d);
  const dd = Math.max(0, d - base);
  const v = 1 / (1 + Math.pow(dd / 0.026, 2.6));
  const w = 0.24 + 0.8 * Math.min(1, dd / 0.22);
  const h = 0.3 * Math.exp(-((az / 0.09) ** 2)) + 0.7 * Math.exp(-((az / w) ** 2));
  const near = 1 - smooth(0.32, 0.5, d);              // the bumper hides the steepest rays anyway
  const stray = 0.014 * Math.exp(-((el / 0.3) ** 2)) * Math.exp(-((az / 0.5) ** 2));
  return below * v * h * near + (1 - below) * stray;
}

function highBeam(el, az) {
  const hot = 1.5 * Math.exp(-(((el - 0.004) / 0.035) ** 2)) * Math.exp(-((az / 0.14) ** 2));
  const fill = 0.45 * Math.exp(-((el / 0.09) ** 2)) * Math.exp(-((az / 0.34) ** 2));
  return lowBeam(el, az) + hot + fill * (el > -0.3 ? 1 : 0);
}

// Roof bar: four square lamps, two spot + two flood. Wide, long throw, little light straight down.
function barBeam(el, az) {
  const h = 0.5 * Math.exp(-((az / 0.11) ** 2)) + 0.5 * Math.exp(-((az / 0.52) ** 2));
  let v;
  if (el > -0.005) v = Math.exp(-(((el + 0.005) / 0.05) ** 2));
  else v = 1 / (1 + Math.pow((-el - 0.005) / 0.05, 2.8));
  const near = 1 - smooth(0.36, 0.55, -el);
  return h * v * near;
}

export const BEAM = {
  // peak intensities (candela in scene units; the scene is not photometric, these are tuned against the
  // night preset so the road stays readable to ~60 m on low beam and ~150 m on high beam)
  low: 45000,
  highGain: 1.0,  // high beam peak follows from the cookie (low peak * cookie max ratio)
  bar: 85000,
};

export function buildLightRig(root, at) {
  const ANG = 0.78;
  const cookies = {
    low: makeCookie(lowBeam, ANG),
    high: makeCookie(highBeam, ANG),
    bar: makeCookie(barBeam, ANG, 256),
  };
  const rig = { cookies };

  const spot = (color, pos, dir, angle, penumbra, dist) => {
    const L = new THREE.SpotLight(color, 0, dist, angle, penumbra, 2);
    L.position.set(...pos);
    L.target.position.set(pos[0] + dir[0] * 10, pos[1] + dir[1] * 10, pos[2] + dir[2] * 10);
    root.add(L); root.add(L.target);
    L.visible = false;
    return L;
  };
  // head: in front of the bumper hoop so no part of the truck is inside its frustum
  rig.head = spot(0xfff0da, at.head, [0, 0, -1], ANG, 0.08, 150);
  rig.head.map = cookies.low;
  rig.head.castShadow = true;
  rig.head.shadow.mapSize.set(1024, 1024);
  rig.head.shadow.bias = -0.0006;
  rig.head.shadow.normalBias = 0.025;
  rig.head.shadow.camera.near = 0.35;
  rig.head.shadow.autoUpdate = false;
  rig.head.userData.peak = { low: BEAM.low, high: BEAM.low * cookies.high.userData.peak / cookies.low.userData.peak };

  rig.bar = spot(0xeef3ff, at.bar, [0, 0, -1], ANG, 0.08, 240);
  rig.bar.map = cookies.bar;
  rig.bar.userData.peak = BEAM.bar;

  // rear: tail/brake glow + reversing lamps, aimed back and down
  rig.rear = spot(0xff2a10, at.rear, [0, -0.3, 1], 0.95, 0.8, 11);
  return rig;
}
