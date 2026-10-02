// Single-scattering atmosphere (Nishita) shared by the CPU (sun colour, fog colours) and the GPU
// (the sky-view LUT in sky.js). Units: metres; radiance is relative to the light's illuminance
// at the top of the atmosphere, so `illum * scatter(...)` is in the same units as the lights.

export const ATM = {
  Re: 6360e3, Ra: 6420e3, Hr: 8000, Hm: 1200,
  betaR: [5.8e-6, 13.5e-6, 33.1e-6],
  betaM: 21e-6, mieExt: 1.11, g: 0.76,
  eyeH: 400,
};

const raySphere = (oy, dx, dy, dz, ox, oz, R) => {
  // origin (ox, oy, oz) relative to the planet centre, unit direction d
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - R * R;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
};

// optical depth (Rayleigh, Mie) from a point to the top of the atmosphere along d; null if the planet blocks it
function lightDepth(px, py, pz, dx, dy, dz, steps = 8) {
  const g = raySphere(py, dx, dy, dz, px, pz, ATM.Re);
  if (g && g[0] > 0) return null;
  const t = raySphere(py, dx, dy, dz, px, pz, ATM.Ra)[1];
  const ds = t / steps;
  let r = 0, m = 0;
  for (let i = 0; i < steps; i++) {
    const s = ds * (i + 0.5);
    const x = px + dx * s, y = py + dy * s, z = pz + dz * s;
    const h = Math.hypot(x, y, z) - ATM.Re;
    r += Math.exp(-h / ATM.Hr) * ds; m += Math.exp(-h / ATM.Hm) * ds;
  }
  return [r, m];
}

// transmittance from the eye towards direction l (the colour of the sun or moon at the ground)
export function transmittance(l) {
  const od = lightDepth(0, ATM.Re + ATM.eyeH, 0, l[0], Math.max(l[1], -0.2), l[2], 32);
  if (!od) return [0, 0, 0];
  return ATM.betaR.map(b => Math.exp(-(b * od[0] + ATM.betaM * ATM.mieExt * od[1])));
}

// in-scattered radiance along view direction v, light from direction l (both unit [x, y, z])
export function scatter(v, l, steps = 24, noMie = false) {
  const oy = ATM.Re + ATM.eyeH;
  const top = raySphere(oy, v[0], v[1], v[2], 0, 0, ATM.Ra);
  let tmax = top[1];
  const gr = raySphere(oy, v[0], v[1], v[2], 0, 0, ATM.Re);
  if (gr && gr[0] > 0) tmax = Math.min(tmax, gr[0]);
  const mu = v[0] * l[0] + v[1] * l[1] + v[2] * l[2];
  const pr = 3 / (16 * Math.PI) * (1 + mu * mu);
  const g = ATM.g;
  const pm = noMie ? 0 : 3 / (8 * Math.PI) * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  let odR = 0, odM = 0;
  const sR = [0, 0, 0], sM = [0, 0, 0];
  let tPrev = 0;
  for (let i = 0; i < steps; i++) {
    const f = (i + 1) / steps;
    const t1 = tmax * f * f;
    const ds = t1 - tPrev;
    const s = tPrev + ds * 0.5;
    tPrev = t1;
    const x = v[0] * s, y = oy + v[1] * s, z = v[2] * s;
    const h = Math.hypot(x, y, z) - ATM.Re;
    const hr = Math.exp(-h / ATM.Hr) * ds, hm = Math.exp(-h / ATM.Hm) * ds;
    odR += hr; odM += hm;
    const ld = lightDepth(x, y, z, l[0], l[1], l[2]);
    if (!ld) continue;
    for (let c = 0; c < 3; c++) {
      const tau = ATM.betaR[c] * (odR + ld[0]) + ATM.betaM * ATM.mieExt * (odM + ld[1]);
      const a = Math.exp(-tau);
      sR[c] += a * hr; sM[c] += a * hm;
    }
  }
  return [0, 1, 2].map(c => sR[c] * ATM.betaR[c] * pr + sM[c] * ATM.betaM * pm);
}

// GLSL version of scatter() for the sky-view LUT (same constants)
export const ATMOSPHERE_GLSL = /* glsl */`
const float A_Re = ${ATM.Re.toFixed(1)};
const float A_Ra = ${ATM.Ra.toFixed(1)};
const float A_Hr = ${ATM.Hr.toFixed(1)};
const float A_Hm = ${ATM.Hm.toFixed(1)};
const vec3 A_betaR = vec3(${ATM.betaR.map(b => b.toExponential(3)).join(', ')});
const float A_betaM = ${ATM.betaM.toExponential(3)};
const float A_mieExt = ${ATM.mieExt.toFixed(3)};
const float A_g = ${ATM.g.toFixed(3)};
const float A_eyeH = ${ATM.eyeH.toFixed(1)};
vec2 aRaySphere(vec3 o, vec3 d, float R) {
  float b = dot(o, d);
  float c = dot(o, o) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0, -1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}
bool aLightDepth(vec3 p, vec3 l, out vec2 od) {
  od = vec2(0.0);
  vec2 g = aRaySphere(p, l, A_Re);
  if (g.x > 0.0) return false;
  float t = aRaySphere(p, l, A_Ra).y;
  float ds = t / 8.0;
  for (int i = 0; i < 8; i++) {
    vec3 q = p + l * (ds * (float(i) + 0.5));
    float h = length(q) - A_Re;
    od += vec2(exp(-h / A_Hr), exp(-h / A_Hm)) * ds;
  }
  return true;
}
vec3 aScatter(vec3 v, vec3 l, float mieScale) {
  vec3 o = vec3(0.0, A_Re + A_eyeH, 0.0);
  float tmax = aRaySphere(o, v, A_Ra).y;
  vec2 gr = aRaySphere(o, v, A_Re);
  if (gr.x > 0.0) tmax = min(tmax, gr.x);
  float mu = dot(v, l);
  float pr = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  float g = A_g;
  float pm = 3.0 / (8.0 * 3.14159265) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec2 od = vec2(0.0);
  vec3 sR = vec3(0.0), sM = vec3(0.0);
  float tPrev = 0.0;
  const int STEPS = 24;
  for (int i = 0; i < STEPS; i++) {
    float f = float(i + 1) / float(STEPS);
    float t1 = tmax * f * f;
    float ds = t1 - tPrev;
    float s = tPrev + ds * 0.5;
    tPrev = t1;
    vec3 p = o + v * s;
    float h = length(p) - A_Re;
    float hr = exp(-h / A_Hr) * ds, hm = exp(-h / A_Hm) * ds;
    od += vec2(hr, hm);
    vec2 ld;
    if (!aLightDepth(p, l, ld)) continue;
    vec3 tau = A_betaR * (od.x + ld.x) + A_betaM * A_mieExt * (od.y + ld.y);
    vec3 a = exp(-tau);
    sR += a * hr; sM += a * hm;
  }
  return sR * A_betaR * pr + sM * A_betaM * pm * mieScale;
}
`;
