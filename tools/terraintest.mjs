// A window of the world at the start (WX= / WZ= another place): generation time, heights, surfaces, roads, water, sites.
//   node tools/terraintest.mjs
import { loadWindow } from './worldwindow.mjs';
const { terrain: t, win, spawn, ms } = loadWindow();
console.log('window', win.ox, win.oz, 'built in', ms.toFixed(0), 'ms', JSON.stringify(win.times));
let mn = 1e9, mx = -1e9; for (const h of t.heights) { mn = Math.min(mn, h); mx = Math.max(mx, h); }
console.log('h range', mn.toFixed(1), mx.toFixed(1), 'spawn', spawn.x.toFixed(1), spawn.z.toFixed(1), 'h', t.heightAt(spawn.x, spawn.z).toFixed(2), 'on a road:', t.isTrail(spawn.x, spawn.z, 1.5));
const counts = [0, 0, 0, 0, 0]; for (const s of t.surface) counts[s]++;
console.log('surface counts grass,dirt,rock,mud,sand', counts.join(','));
console.log('roads', t.roads.length, '(spurs', t.roads.filter(r => r.spur).length + ')', 'water', t.water.map(w => w.type).join(',') || '-', 'sites', t.sites.map(s => s.type).join(',') || '-');
console.log('trees', win.trees.length / 7, 'far trees', win.farTrees.length / 6, 'logs', win.logs.length / 7, 'rocks', win.rocks.hulls.length);
console.log('muds', JSON.stringify(t.muds.map(m => [m.x.toFixed(1), m.z.toFixed(1)])));
