// For the Node tools: a window of a map (src/world/maps/), built as the game builds it (terrain + baked data).
//   const { world, terrain, win, spawn } = loadWindow();
// MAP= picks the map (default: the game's default, the classic one: the baselines in DEVNOTES are on it). The endless
// one: centred on the start; WX= / WZ= (world coordinates) for another place, SEED= for another world. Local
// coordinates (the window's centre is 0, 0), as in the game.
import { World } from '../src/world/worldgen.js';
import { Terrain, WINDOW_STEP } from '../src/world/terrain.js';
import { buildWindow } from '../src/world/windowWorker.js';
import { TREE_KINDS } from '../src/world/treeKinds.js';
import { MAPS } from '../src/world/maps/index.js';
import { ClassicTerrain, SPAWN } from '../src/world/maps/classic/terrain.js';
import { bakeClassic } from '../src/world/maps/classic/bake.js';

export function loadWindow(opts = {}) {
  const map = opts.map ?? process.env.MAP ?? MAPS[0].id;
  if (map === 'classic') {
    const t0 = performance.now();
    const terrain = new ClassicTerrain(7);
    const dims = TREE_KINDS.map(k => { const g = k.build(); return { kind: k.kind, crownR: g.crownR, trunkR: g.trunkR }; });
    const win = bakeClassic(terrain, dims);
    return { world: null, terrain, win, spawn: { ...SPAWN }, ms: performance.now() - t0 };
  }
  const world = new World(+(opts.seed ?? process.env.SEED ?? 7));
  const sp = world.spawn();
  const snap = v => Math.round(v / WINDOW_STEP) * WINDOW_STEP;
  const wx = opts.wx ?? (process.env.WX !== undefined ? +process.env.WX : sp.x), wz = opts.wz ?? (process.env.WZ !== undefined ? +process.env.WZ : sp.z);
  const dims = TREE_KINDS.map(k => { const g = k.build(); return { kind: k.kind, crownR: g.crownR, trunkR: g.trunkR }; });
  const t0 = performance.now();
  const { win } = buildWindow(world, dims, snap(wx), snap(wz));
  const terrain = Terrain.fromData(win);
  terrain.world = world;
  const spawn = { x: sp.x - win.ox, z: sp.z - win.oz, yaw: sp.yaw };
  return { world, terrain, win, spawn, ms: performance.now() - t0 };
}

// the longest road of the window that keeps inside it (for laps and profiles; endless maps)
export function longestRoad(terrain, margin = 40) {
  let best = null, bl = 0;
  for (const r of terrain.roads) {
    const c = r.path, n = c.xs.length;
    let k0 = 0;
    while (k0 < n && (Math.abs(c.xs[k0]) > 512 - margin || Math.abs(c.zs[k0]) > 512 - margin)) k0++;
    let k1 = k0;
    while (k1 < n && Math.abs(c.xs[k1]) <= 512 - margin && Math.abs(c.zs[k1]) <= 512 - margin) k1++;
    const len = c.cum[Math.max(k0, k1 - 1)] - c.cum[k0];
    if (len > bl) { bl = len; best = { road: r, k0, k1 }; }
  }
  return best;
}
