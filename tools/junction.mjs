import { Terrain } from '../src/world/terrain.js';
const t = new Terrain(7);
let worst = 0, at = null, worstC = 0, atC = null;
const N = 800, C = 0.5;
for (let ix = 1; ix < N; ix++) for (let iz = 1; iz < N; iz++) {
  const i = ix * 801 + iz;
  const d = t.trailDist[i];
  if (d > 1.6) continue;
  const gx = (t.heights[i + 801] - t.heights[i - 801]) / (2 * C), gz = (t.heights[i + 1] - t.heights[i - 1]) / (2 * C);
  const s = Math.hypot(gx, gz);
  if (s > worst) { worst = s; at = [-200 + ix * C, -200 + iz * C]; }
}
console.log('steepest slope on trail centre', (Math.atan(worst) * 57.3).toFixed(1), 'deg at', at);
