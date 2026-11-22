import * as THREE from 'three';
import { FAR_SIZE, FAR_CELL, FAR_N, MAP_SIZE } from '../world/terrain.js';

// The land's own shadow, however far the land that casts it: the sun going behind a mountain kilometres away. The
// shadow cascades reach a couple of hundred metres; this covers the whole vista (8 km, 16 m cells), soft.
// For the direction of the light it holds, per cell, how high above the ground the shadow stands: `lo` up to where
// none of the sun's disc shows, `hi` from where all of it does (0 and 0 on open ground). A point h metres above the
// ground is lit by (h - lo) / (hi - lo). Found by one sweep over the grid from the sun's side: a cell's shadow is the
// higher of its own ground and the shadow of the cell before it, lowered by the sun's slope over the step.
// Recomputed when the light has moved (update()): the map is one layer of the texture that holds the vista's land
// (layer 0: height, lushness, forest floor, rock kind, terrainView.js), so the terrain reads it through the sampler
// it already has (it has no texture unit to spare) and every other lit material through `tSkyline`.
// In the shader: skylineShade(world point), multiplied into the sun's light in lights_fragment_begin (installSkyline).

const FN = FAR_N + 1, HALF = FAR_SIZE / 2, CELLS = FN * FN, L1 = CELLS * 4;
const SOFT = 1.5;                // m: the narrowest edge (and the slack for a ground that is not quite the cell's)
const DISC = 0.4;                // deg: the sun's half-width (a little more than the real 0.27: softer edges)
const MIN_ELEV = 0.3;            // deg: below it the light's own fade (environment.js sunUp) does the rest
const STEP = 0.03, JUMP = 0.4;    // deg: recompute when the light has moved STEP; at once when by JUMP or more
const RAD = Math.PI / 180;

const data = new Float32Array(CELLS * 8);
const H = new Float32Array(CELLS), S0 = new Float32Array(CELLS), S1 = new Float32Array(CELLS);
const tex = new THREE.DataArrayTexture(data, FN, FN, 2);
tex.format = THREE.RGBAFormat; tex.type = THREE.FloatType;
tex.minFilter = tex.magFilter = THREE.NearestFilter;
tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
tex.generateMipmaps = false;
tex.needsUpdate = true;

// uSkyline: x 1: the map, per pixel; 0: one value for the whole view, z (the sun left at the truck): the levels
// without sun shadows, and where float textures cannot be filtered
export const SKYLINE = { tex, on: { x: 0, y: 0, z: 1, w: 0 }, dir: new THREE.Vector3(0, 1, 0), solved: false, ms: 0, land: 0, canFilter: false };
let renderer = null;

// Call before the first frame: every material's copy of the texture takes its filter from here.
export function initSkyline(r) {
  renderer = r;
  SKYLINE.canFilter = !!r.extensions.has('OES_texture_float_linear');
  if (SKYLINE.canFilter) { tex.minFilter = tex.magFilter = THREE.LinearFilter; SKYLINE.on.x = 1; }
}
let stale = false;   // the map on the GPU is older than the one here
function upload() {
  tex.addLayerUpdate(1);
  tex.needsUpdate = true;
  renderer?.initTexture(tex);
  stale = false;
}
// per pixel (the quality level asks for it, graphics.js) or one value for the view
export function setSkylinePerPixel(on) {
  SKYLINE.on.x = on && SKYLINE.canFilter ? 1 : 0;
  if (SKYLINE.on.x > 0 && stale) upload();
}

export function skylineUniforms() { return { tSkyline: { value: tex }, uSkyline: { value: SKYLINE.on } }; }

// a window's land: the vista's data (FN x FN x 4, heights first) and the heights the shadow is cast by: the vista's
// 16 m grid, and inside the window the window's own ground (terrain.heightAt)
export function setSkylineLand(terrain, farLand) {
  data.set(farLand.subarray(0, L1));
  const half = MAP_SIZE / 2 - 1;
  for (let i = 0; i < FN; i++) {
    const x = i * FAR_CELL - HALF;
    for (let j = 0; j < FN; j++) {
      const z = j * FAR_CELL - HALF, k = i * FN + j;
      H[k] = Math.abs(x) <= half && Math.abs(z) <= half ? terrain.heightAt(x, z) : farLand[k * 4];
    }
  }
  tex.addLayerUpdate(0);
  SKYLINE.solved = false; SKYLINE.land++;
  solve();
}

// the shadow's top over every cell for a light towards (dx, dz) (unit, level) at a slope of tanE
function sweep(S, dx, dz, tanE) {
  const alongX = Math.abs(dx) >= Math.abs(dz);
  const a = alongX ? dx : dz, b = alongX ? dz : dx;      // a: along the sweep, b: across
  const si = a > 0 ? 1 : -1, m = b / Math.abs(a), drop = FAR_CELL / Math.abs(a) * tanE;
  const m0 = Math.floor(m), t = m - m0;
  const iStride = alongX ? FN : 1, jStride = alongX ? 1 : FN;
  let i = si > 0 ? FN - 1 : 0;
  for (let j = 0, k = i * iStride; j < FN; j++, k += jStride) S[k] = H[k];
  for (let n = 1; n < FN; n++) {
    i -= si;
    const row = i * iStride, prev = (i + si) * iStride;
    for (let j = 0; j < FN; j++) {
      let j0 = j + m0, j1 = j0 + 1;
      if (j0 < 0) j0 = 0; else if (j0 > FN - 1) j0 = FN - 1;
      if (j1 < 0) j1 = 0; else if (j1 > FN - 1) j1 = FN - 1;
      const s = S[prev + j0 * jStride] * (1 - t) + S[prev + j1 * jStride] * t - drop, k = row + j * jStride, h = H[k];
      S[k] = s > h ? s : h;
    }
  }
}

// one solve in three parts (a sweep for each edge of the sun's disc, then the upload): ~2 ms in all (M1 Pro)
const PARTS = [
  (dx, dz, elev) => sweep(S0, dx, dz, Math.tan(Math.max(elev + DISC, MIN_ELEV + 2 * DISC) * RAD)),
  (dx, dz, elev) => sweep(S1, dx, dz, Math.tan(Math.max(elev - DISC, MIN_ELEV) * RAD)),
  () => {
    for (let k = 0, o = L1; k < CELLS; k++, o += 4) { const h = H[k]; data[o] = h; data[o + 1] = S0[k] - h; data[o + 2] = S1[k] - h; }
    // (the materials hold copies of the texture that share its source: the upload goes through this one)
    // Only while the shaders read it: 4 MB a time
    if (SKYLINE.on.x > 0) upload(); else stale = true;
    SKYLINE.solved = true;
  },
];
let part = -1;   // the part of a solve spread over frames that comes next (-1: none)
function runPart(k) {
  const d = SKYLINE.dir, lh = Math.hypot(d.x, d.z) || 1e-6;
  PARTS[k](d.x / lh, d.z / lh, Math.atan2(d.y, lh) / RAD);
}
function solve() {
  const t0 = performance.now();
  for (let k = 0; k < PARTS.length; k++) runPart(k);
  part = -1;
  SKYLINE.ms = performance.now() - t0;
}

// the light's direction (unit, towards it): recomputes the map when it has moved; true if it did. A small move (time
// going by) is spread over three frames, a jump (the hour set) is done at once
const _last = new THREE.Vector3(0, -1, 0);
export function updateSkyline(dir) {
  if (part >= 0) return false;
  const c = SKYLINE.solved ? _last.dot(dir) : -1;
  if (c > Math.cos(STEP * RAD)) return false;
  _last.copy(dir); SKYLINE.dir.copy(dir);
  if (c > Math.cos(JUMP * RAD)) part = 0; else solve();
  return true;
}
// every frame: the next part of a solve in progress
export function tickSkyline() {
  if (part < 0) return;
  runPart(part);
  if (++part >= PARTS.length) part = -1;
}

const lit = (lo, hi, h) => { const l = Math.min(1, Math.max(0, (h - lo + SOFT) / (hi - lo + SOFT))); return l * l * (3 - 2 * l); };
// the sun left at a point (local frame), 0..1: skylineShade of the shader on the CPU
export function skylineAt(x, y, z) {
  const fi = Math.min(FN - 1.001, Math.max(0, (x + HALF) / FAR_CELL)), fj = Math.min(FN - 1.001, Math.max(0, (z + HALF) / FAR_CELL));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
  const o = L1 + (i * FN + j) * 4, w00 = (1 - a) * (1 - b), w01 = (1 - a) * b, w10 = a * (1 - b), w11 = a * b;
  const at = c => data[o + c] * w00 + data[o + 4 + c] * w01 + data[o + FN * 4 + c] * w10 + data[o + FN * 4 + 4 + c] * w11;
  return lit(at(1), at(2), Math.max(y - at(0), 0));
}
// the share of the ground round a point that is in the sun (r cells each way)
export function skylineArea(x, z, r = 4) {
  const ci = Math.round((x + HALF) / FAR_CELL), cj = Math.round((z + HALF) / FAR_CELL);
  let s = 0, n = 0;
  for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
    if (i < 0 || j < 0 || i >= FN || j >= FN) continue;
    const o = L1 + (i * FN + j) * 4;
    s += lit(data[o + 1], data[o + 2], 0); n++;
  }
  return n ? s / n : 1;
}

// the land's skyline as seen from a point: out[k] = the sine of its height in the direction k / out.length of a turn
// (from +z towards +x), 0 where the land lies below the level horizon
export function skylineRound(x, y, z, out) {
  const n = out.length, hgt = (px, pz) => {
    const fi = Math.min(FN - 1.001, Math.max(0, (px + HALF) / FAR_CELL)), fj = Math.min(FN - 1.001, Math.max(0, (pz + HALF) / FAR_CELL));
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, o = i * FN + j;
    return (H[o] * (1 - a) + H[o + FN] * a) * (1 - b) + (H[o + 1] * (1 - a) + H[o + FN + 1] * a) * b;
  };
  for (let k = 0; k < n; k++) {
    const az = k / n * 2 * Math.PI, dx = Math.sin(az), dz = Math.cos(az);
    let m = 0;
    for (let d = 24; d < HALF; d *= 1.13) { const t = (hgt(x + dx * d, z + dz * d) - y) / d; if (t > m) m = t; }
    out[k] = m / Math.sqrt(1 + m * m);
  }
  return out;
}

export const SKYLINE_GLSL = /* glsl */`
#ifndef SKYLINE_TEX
uniform highp sampler2DArray tSkyline;
#define SKYLINE_TEX tSkyline
#endif
uniform vec4 uSkyline;
float giShade = 1.0;   // the sun the land leaves here (set with the sun's light; the ground's bounce follows it, gi.js)
// the sun left at a world point by the land between it and the sun (render/skyline.js)
float skylineShade( vec3 p ) {
	if ( uSkyline.x < 0.5 ) return uSkyline.z;
	vec3 s = texture( SKYLINE_TEX, vec3( ( p.zx + ${(HALF + FAR_CELL / 2).toFixed(1)} ) / ${(FN * FAR_CELL).toFixed(1)}, 1.0 ) ).rgb;
	float l = clamp( ( max( p.y - s.r, 0.0 ) - s.g + ${SOFT.toFixed(1)} ) / ( s.b - s.g + ${SOFT.toFixed(1)} ), 0.0, 1.0 );
	return l * l * ( 3.0 - 2.0 * l );
}
`;

let installed = false;
// Call once before any material compiles (after the indirect light's patch: it sets giShade).
export function installSkyline() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk, line = 'getSunLightInfo( sunLight, directLight );';
  if (!C.lights_fragment_begin.includes(line)) { console.warn('skyline: lights_fragment_begin layout changed, no far shadows'); return; }
  C.lights_fragment_begin = C.lights_fragment_begin.replace(line, `${line}
		giShade = skylineShade( cameraPosition - ( vec4( vViewPosition, 0.0 ) * viewMatrix ).xyz );
		directLight.color *= giShade;`);
  C.lights_pars_begin = SKYLINE_GLSL + C.lights_pars_begin;
  for (const k in THREE.ShaderLib) {
    const u = THREE.ShaderLib[k].uniforms;
    if (u && 'directionalLights' in u) Object.assign(u, skylineUniforms());
  }
  THREE.UniformsLib.lights = { ...THREE.UniformsLib.lights, ...skylineUniforms() };
}
