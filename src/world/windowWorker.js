import { World } from './worldgen.js';
import { Terrain } from './terrain.js';
import { bakeWindow } from './windowBake.js';
import { TREE_KINDS } from './treeKinds.js';

// Builds windows of the world off the main thread: { type: 'init', seed } answers { type: 'spawn' }; { type: 'window',
// id, ox, oz } answers { type: 'window', id, win } (the window's terrain and baked data, arrays transferred). The
// World keeps its roads, regions and rock shapes cached between windows, so the next window only works out what
// is new.

let world = null, dims = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      world = new World(m.seed);
      dims = TREE_KINDS.map(k => { const g = k.build(); return { kind: k.kind, crownR: g.crownR, trunkR: g.trunkR }; });
      self.postMessage({ type: 'spawn', spawn: world.spawn() });
    } else if (m.type === 'window') {
      const { win, transfer } = buildWindow(world, dims, m.ox, m.oz);
      self.postMessage({ type: 'window', id: m.id, win }, transfer);
    } else if (m.type === 'sites') {
      // the sites (huts, quarries, lookouts, lakes) within r of a point, absolute: for the locations list
      const out = [];
      for (const r of world.regionsIn(m.x - m.r, m.z - m.r, m.x + m.r, m.z + m.r)) for (const s of r.sites) {
        if (Math.hypot(s.x - m.x, s.z - m.z) < m.r) out.push({ type: s.type, x: s.x, z: s.z, id: s.id });
      }
      self.postMessage({ type: 'sites', id: m.id, sites: out });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};

// a window as plain data (also used directly by tools in Node)
export function buildWindow(world, dims, ox, oz) {
  const t0 = performance.now();
  const t = new Terrain(world, ox, oz);
  const b = bakeWindow(t, dims);
  // trail distance 0..6 m in 8 bits (the terrain's normal bake reads it)
  const trailByte = new Uint8Array(t.trailDist.length);
  for (let i = 0; i < trailByte.length; i++) trailByte[i] = Math.round(255 * Math.min(1, t.trailDist[i] / 6));
  const win = {
    trailByte,
    ox, oz,
    heights: t.heights, surface: t.surface, trailDist: t.trailDist, far: t.far,
    water: t.water, sites: t.sites, muds: t.muds, lakes: t.lakes,
    roads: t.roads.map(r => ({ key: r.key, xs: r.path.xs, zs: r.path.zs, hs: Float64Array.from(r.hs), spur: r.spur })),
    ...b,
    times: { ...t.times, ...b.bakeTimes, total: Math.round(performance.now() - t0) },
  };
  const transfer = [trailByte.buffer, t.heights.buffer, t.surface.buffer, t.trailDist.buffer, t.far.heights.buffer, b.splat.buffer, b.groundData.buffer, b.landData.buffer,
    b.trees.buffer, b.logs.buffer, b.rocks.pos.buffer, b.rocks.nrm.buffer, b.rocks.col.buffer, b.rocks.idx.buffer,
    ...b.pyramid.mins.map(a => a.buffer), ...b.pyramid.maxs.map(a => a.buffer), ...b.pyramid.rocks.map(a => a.buffer), ...b.grassDens.map(l => l.a.buffer)];
  return { win, transfer };
}
