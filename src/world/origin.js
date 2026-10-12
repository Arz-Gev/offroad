import * as THREE from 'three';

// The local frame. Everything in the scene and the physics is in local coordinates: the centre of the detailed
// window of the world (terrain.js) is (0, 0), at the absolute point ORIGIN. When the window moves, the game shifts
// everything by the difference (streamer.js), so local coordinates stay within ~1 km (32-bit floats).
// Shaders that tie a pattern to the ground (texture tiles, noise, hashed grass cells) add uPat to the local
// position: the origin modulo PAT_PERIOD, so a pattern stays put on the ground when the frame shifts (exact: the
// window moves by whole multiples of 256 m). Every such pattern's period divides PAT_PERIOD (pp() snaps a scale to
// the nearest that does), so nothing jumps when uPat wraps either. The period is kept small because the pattern
// coordinate is a 32-bit float on the GPU: at 2-3 km a 0.9 m tile still resolves to ~0.06 texel.

export const PAT_PERIOD = 2048;
// a pattern's period (m) snapped to divide PAT_PERIOD; ppf: the same as a GLSL float literal
export const pp = k => PAT_PERIOD / Math.round(PAT_PERIOD / k);
export const ppf = k => pp(k).toFixed(6);
export const ORIGIN = { x: 0, z: 0 };
export const PAT = { value: new THREE.Vector2() };
export const mod = (a, p) => ((a % p) + p) % p;

export function setOrigin(x, z) {
  ORIGIN.x = x; ORIGIN.z = z;
  PAT.value.set(mod(x, PAT_PERIOD), mod(z, PAT_PERIOD));
}

// GLSL: the uniform, for the shaders that use it
export const PAT_GLSL = 'uniform vec2 uPat;   // origin.js: the local frame\'s origin modulo PAT_PERIOD, for patterns tied to the ground\n';
