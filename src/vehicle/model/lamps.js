import * as THREE from 'three';

// Vehicle lamps. Real headlamps shape their beam to light the road evenly from a few metres out to the
// cut-off: little light steeply down, most just below the horizon. Ground illuminance from a lamp at height h
// is E = I * h / r^3, so a plain cone gives a blown-out pool at the bumper and nothing further away. So every
// beam is a SpotLight with a light cookie (SpotLight.map) that encodes the intensity I(elevation, azimuth).
//
// Lights (on the vehicle root; a turret's searchlight on its gun cradle; visible only at night or when switched
// on) at the car's lamp positions (look.lamps, or its procedural body's):
//   head  - one spot between the headlamps, low/high beam cookies, the only shadow caster
//   aux   - the extra lamps (J): a roof light bar or driving lamps (a wide long-range flood) and searchlights
//           (a narrow cone, maybe riding a turret); one spot per lamp place, no shadow
//   rear  - one small dim spot for tail/brake glow and the reversing lamps
// Lens glow comes from emissive materials (lensRoles: the lamps' roles -> materials); no point lights.

// Irradiance shoulder for spot lights (only the truck has spot lights). Inverse-square makes a bank or a tree
// trunk 8-10 m ahead ~100x brighter than the road at 30-60 m (I/d^2 vs I*h/r^3); at a fixed exposure it blows out
// and blooms over the windscreen on a slope. This emulates the eye's local adaptation with a soft cap on each
// lamp's irradiance: E -> E/sqrt(1+(E/K)^2). Road irradiance from the beams is ~0.6-4.5 (scene units), so the
// far throw is barely touched.
export const LAMP_KNEE = 6.0;
function installLampShoulder() {
  const C = THREE.ShaderChunk;
  if (C.lights_fragment_begin.includes('tkLampE')) return;
  const spotRE = /(\t\tgetSpotLightInfo\( spotLight, geometryPosition, directLight \);\n)([\s\S]*?)(\t\tRE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);\n)/;
  if (!spotRE.test(C.lights_fragment_begin)) { console.warn('lamps: lights_fragment_begin layout changed, lamp shoulder disabled'); return; }
  const k = (1 / (LAMP_KNEE * LAMP_KNEE)).toFixed(6);
  const glsl = `\t\t{\n\t\t\tfloat tkLampE = max( dot( geometryNormal, directLight.direction ), 0.0 ) * max( directLight.color.r, max( directLight.color.g, directLight.color.b ) );\n\t\t\tdirectLight.color *= inversesqrt( 1.0 + tkLampE * tkLampE * ${k} );\n\t\t}\n`;
  C.lights_fragment_begin = C.lights_fragment_begin.replace(spotRE, (m, a, body, re) => `${a}${body}${glsl}${re}`);
}
installLampShoulder();

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Cookie texture covering the spot's projection (fov = 2 * angle, square). fn(elev, azim) -> intensity.
// Stored as half floats: the near-field values are 1/100 .. 1/1000 of the peak and band in 8 bits.
// The edge of the cone fades out over the last `soft` radians, so a bank or a tree beside the truck shows a
// gradient, not a line where the cone ends.
function makeCookie(fn, angle, N = 512, soft = 0.32) {
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
      const v = fn(el, az) * smooth(angle, angle - soft, off);
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
// kick-up on the right, hot zone right under the cut-off, wide soft foreground. The cut-off stays level
// but fades over a band that widens to the sides: ahead it lies on the far road (a narrow band keeps the
// throw), to the sides it lands on banks and trunks a few metres away, where a narrow band reads as a line.
function lowBeam(el, az) {
  const d = -el; // depression below the horizon
  const base = 0.009;
  const kick = az > 0.02 ? Math.min((az - 0.02) * 0.27, 0.026) : 0;
  const cut = base - kick;                            // the kick-up only raises the edge
  const band = 0.016 + 0.11 * Math.min(1, Math.abs(az) / 0.6);
  const below = smooth(cut - 0.3 * band, cut + band, d);
  const dd = Math.max(0, d - base);
  const v = 1 / (1 + Math.pow(dd / 0.026, 2.6));
  const w = 0.24 + 0.45 * Math.min(1, dd / 0.22);
  const h = 0.3 * Math.exp(-((az / 0.09) ** 2)) + 0.7 * Math.exp(-((az / w) ** 2));
  const near = 1 - smooth(0.32, 0.5, d);              // the bumper hides the steepest rays anyway
  const stray = 0.014 * Math.exp(-((el / 0.3) ** 2)) * Math.exp(-((az / 0.5) ** 2));
  return below * v * h * near + (1 - below) * stray;
}

function highBeam(el, az) {
  const hot = 1.5 * Math.exp(-(((el - 0.004) / 0.035) ** 2)) * Math.exp(-((az / 0.14) ** 2));
  const fill = 0.45 * Math.exp(-((el / 0.09) ** 2)) * Math.exp(-((az / 0.34) ** 2));
  return lowBeam(el, az) + hot + fill * smooth(-0.42, -0.2, el);
}

// Extra lamps (a roof bar's two spot + two flood, driving lamps): wide, long throw, little light straight down.
function auxBeam(el, az) {
  const h = 0.5 * Math.exp(-((az / 0.11) ** 2)) + 0.5 * Math.exp(-((az / 0.42) ** 2));
  let v;
  if (el > -0.005) v = Math.exp(-(((el + 0.005) / 0.05) ** 2));
  else v = 1 / (1 + Math.pow((-el - 0.005) / 0.05, 2.8));
  const near = 1 - smooth(0.36, 0.55, -el);
  return h * v * near;
}

export const BEAM = {
  // peak intensities (candela in scene units; not photometric: tuned against the night preset so the road stays
  // readable to ~60 m on low beam and ~150 m on high beam). The aux flood puts out a little more than the high
  // beam, spread wider.
  low: 36000,
  highGain: 0.68, // high beam peak = low peak * cookie max ratio * highGain
  aux: 55000,
  searchlight: 100000,   // a narrow cone, no cookie
};

export function buildLightRig(root, at) {
  const ANG = 0.78;
  const cookies = {
    low: makeCookie(lowBeam, ANG),
    high: makeCookie(highBeam, ANG),
    aux: makeCookie(auxBeam, ANG, 256),
  };
  const rig = { cookies };

  const spot = (color, pos, dir, angle, penumbra, dist, parent = root) => {
    const L = new THREE.SpotLight(color, 0, dist, angle, penumbra, 2);
    L.position.set(...pos);
    L.target.position.set(pos[0] + dir[0] * 10, pos[1] + dir[1] * 10, pos[2] + dir[2] * 10);
    parent.add(L); parent.add(L.target);
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
  rig.head.userData.peak = { low: BEAM.low, high: BEAM.low * BEAM.highGain * cookies.high.userData.peak / cookies.low.userData.peak };

  // aux: only a car with extra lamps has their beams (at.aux: points on the root, or Object3Ds the beam rides,
  // aimed along their -z). A searchlight (userData.cone: its half angle) is a plain narrow cone: every cookie
  // takes a texture unit in every lit material, and 16 is all most GPUs have
  rig.aux = (at.aux || []).map(p => {
    const cone = p.userData?.cone;
    const L = p.isObject3D ? spot(0xeef3ff, [0, 0, 0], [0, 0, -1], cone || ANG, cone ? 0.5 : 0.08, 300, p) : spot(0xeef3ff, p, [0, 0, -1], ANG, 0.08, 240);
    if (!cone) L.map = cookies.aux;
    L.userData.peak = cone ? BEAM.searchlight : BEAM.aux;
    return L;
  });

  // rear: tail/brake glow + reversing lamps, aimed back and down
  rig.rear = spot(0xff2a10, at.rear, [0, -0.3, 1], 0.95, 0.8, 11);
  return rig;
}

// The lens roles VehicleView drives: head, side, aux (extra lamps), work (reversing work lamps), tail, brake,
// reverse, amber (indicators / hazards), beacon; each a list of materials. A downloaded model names its lenses
// by role (look.lamps.lenses: role -> a pattern matched against the material name and the mesh name, e.g. the
// nodes tools/cutparts.mjs cut out). Every source material under a pattern gets one glowing copy, shared by the
// roles that name the same pattern (the BTR-80's red lens is tail and brake).
const LENS_COLOR = { amber: [1, 0.55, 0.1], beacon: [1, 0.55, 0.1], tail: [1, 0.1, 0.05], brake: [1, 0.1, 0.05] };
export function modelLenses(shell, lenses = {}) {
  const roles = {}, byPattern = new Map();
  for (const [role, pattern] of Object.entries(lenses)) {
    if (!byPattern.has(pattern)) {
      const re = new RegExp(pattern), copies = new Map();
      shell.traverse(o => {
        if (!o.isMesh || !(re.test(o.material.name) || re.test(o.name))) return;
        let mat = copies.get(o.material);
        if (!mat) {
          mat = o.material.clone(); mat.emissive = new THREE.Color(...(LENS_COLOR[role] || [1, 1, 1])); mat.emissiveIntensity = 0;
          // clear glass: lit from inside it shows its glow (VehicleView raises the opacity with it)
          if (mat.transparent) mat.userData.clearOpacity = mat.opacity;
          copies.set(o.material, mat);
        }
        o.material = mat;
      });
      byPattern.set(pattern, [...copies.values()]);
    }
    if (byPattern.get(pattern).length) roles[role] = byPattern.get(pattern);
  }
  return roles;
}
