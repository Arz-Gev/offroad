import * as THREE from 'three';
import { PAT_PERIOD } from './origin.js';

// One wind for everything that grows: gusts travel over the land with the wind, and the grass, the flowers, the
// bushes and the trees (near ones and the far cards) all read the same field at their own place, so a gust can be
// seen coming across a meadow and into the wood. (Each had its own gusts before: the grass's waves ran at one speed,
// the trees rocked to another clock.)
// The field: big fronts ~90 m apart moving at ~9 m/s, broken up across the wind, with smaller ripples on them.
// Places are in the pattern frame (origin.js); every wave vector is a whole number of waves over the pattern's
// period, so nothing jumps where the pattern wraps or the frame shifts.
// A shader: declares `uniform vec4 uWind;` (dir x, dir z, strength, time) itself, adds WIND_FIELD_GLSL after it and
// windUniforms() to its uniforms, and calls windGust(place, uWind.w): ~0.25 in a lull .. ~1.2 in a gust.

const DIR = [0.8, 0.6];   // the wind's direction (the grass's uWind.xy)
const TWO_PI = Math.PI * 2;
// a wave vector of k rad/m at `turn` radians from the wind, snapped to the pattern's period
const wave = (k, turn = 0) => {
  const c = Math.cos(turn), s = Math.sin(turn), x = DIR[0] * c - DIR[1] * s, z = DIR[0] * s + DIR[1] * c, u = TWO_PI / PAT_PERIOD;
  return [Math.round(x * k / u) * u, Math.round(z * k / u) * u];
};
const K1 = wave(0.07), K2 = wave(0.19, 0.22), K3 = wave(0.021, Math.PI / 2);
const U = { uWindK: { value: new THREE.Vector4(K1[0], K1[1], K2[0], K2[1]) }, uWindK2: { value: new THREE.Vector4(K3[0], K3[1], 0, 0) } };
export const windUniforms = () => U;

export const WIND_FIELD_GLSL = /* glsl */`
uniform vec4 uWindK, uWindK2;
float windGust(vec2 q, float t) {
  float g = 0.5 + 0.5 * sin(dot(q, uWindK.xy) - t * 0.63 + 1.7 * sin(dot(q, uWindK2.xy) + t * 0.05));
  return 0.25 + 0.95 * g * g * (0.75 + 0.25 * sin(dot(q, uWindK.zw) - t * 1.52));
}
`;
