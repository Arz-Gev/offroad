import { Terrain, SPAWN, PAD } from '../src/world/terrain.js';
const t0 = performance.now();
const t = new Terrain(7);
console.log('gen ms', (performance.now() - t0).toFixed(0));
let mn = 1e9, mx = -1e9; for (const h of t.heights) { mn = Math.min(mn, h); mx = Math.max(mx, h); }
console.log('h range', mn.toFixed(1), mx.toFixed(1), 'spawn h', t.heightAt(SPAWN.x, SPAWN.z).toFixed(2), 'pad', t.padH.toFixed(2));
const counts = [0,0,0,0,0]; for (const s of t.surface) counts[s]++;
console.log('surface counts grass,dirt,rock,mud,sand', counts.join(','));
console.log('muds', JSON.stringify(t.muds.map(m => [m.x.toFixed(1), m.z.toFixed(1)])));
