import { Terrain, N, CELL, MAP_SIZE } from '../src/world/terrain.js';
// Steepest slope on the trail centrelines (cells within 1.6 m of a trail), plus the worst spots.
const t = new Terrain(7);
const NN = N + 1, half = MAP_SIZE / 2;
const spots = [];
for (let ix = 1; ix < N; ix++) for (let iz = 1; iz < N; iz++) {
  const i = ix * NN + iz;
  const d = t.trailDist[i];
  if (d > 1.6) continue;
  const gx = (t.heights[i + NN] - t.heights[i - NN]) / (2 * CELL), gz = (t.heights[i + 1] - t.heights[i - 1]) / (2 * CELL);
  const s = Math.hypot(gx, gz);
  if (s > 0.3) spots.push([s, -half + ix * CELL, -half + iz * CELL]);
}
spots.sort((a, b) => b[0] - a[0]);
// one entry per 10 m neighbourhood
const worst = [];
for (const s of spots) { if (worst.every(w => Math.hypot(w[1] - s[1], w[2] - s[2]) > 10)) worst.push(s); if (worst.length >= 8) break; }
console.log('terrain gen', t.genMs.toFixed(0), 'ms');
console.log('steepest slope on trail centre', worst.length ? (Math.atan(worst[0][0]) * 57.3).toFixed(1) : '0', 'deg at', worst.length ? [worst[0][1], worst[0][2]] : '-');
for (const w of worst) console.log('  ', (Math.atan(w[0]) * 57.3).toFixed(1), 'deg at', w[1], w[2]);
