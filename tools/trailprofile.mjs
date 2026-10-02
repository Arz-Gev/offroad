// Trail ride profile: samples each trail's centreline on the final heightfield and lists the crests that
// unload the truck below a given speed (vertical curvature h'' < -g / v^2, measured over a 4 m base,
// about the wheelbase), and short bumps (0.5-2 m wavelength) that shake it.
//   node tools/trailprofile.mjs [kmh=65] [trail index or 'all']
import { Terrain } from '../src/world/terrain.js';
const kmh = +(process.argv[2] || 65), which = process.argv[3] ?? 'all';
const t = new Terrain(7);
const g = 9.81, v = kmh / 3.6, kLim = g / (v * v);
const trails = which === 'all' ? t.trailCurves.map((_, i) => i) : [+which];
for (const ti of trails) {
  const c = t.trailCurves[ti], len = c.getLength(), ds = 0.5, n = Math.floor(len / ds);
  const pts = c.getSpacedPoints(n);
  const h = pts.map(p => (t.surfaceHeight || t.heightAt).call(t, p.x, p.z));
  const B = +(process.env.BASE || 4) * 2; // samples: 4 m base (about the wheelbase); BASE=2 for sharper features
  const crests = [];
  let rough = 0, rn = 0;
  for (let k = B; k < n - B; k++) {
    const d2 = (h[k + B] - 2 * h[k] + h[k - B]) / ((B * ds) ** 2);
    if (d2 < -kLim) crests.push({ s: k * ds, d2, x: pts[k].x, z: pts[k].z });
    // short-wave roughness: residual after a 2 m moving average
    let a = 0; for (let j = -2; j <= 2; j++) a += h[k + j]; a /= 5;
    rough += (h[k] - a) ** 2; rn++;
  }
  // merge neighbours into features
  const feats = [];
  for (const cr of crests) {
    const f = feats[feats.length - 1];
    if (f && cr.s - f.s1 < 3) { f.s1 = cr.s; if (cr.d2 < f.d2) { f.d2 = cr.d2; f.x = cr.x; f.z = cr.z; } }
    else feats.push({ s0: cr.s, s1: cr.s, d2: cr.d2, x: cr.x, z: cr.z });
  }
  console.log(`trail ${ti}: ${len.toFixed(0)} m, short-wave roughness rms ${(Math.sqrt(rough / rn) * 1000).toFixed(1)} mm, crests unloading below ${kmh} km/h: ${feats.length}`);
  for (const f of feats.sort((a, b) => a.d2 - b.d2).slice(0, 12)) {
    console.log(`   s=${f.s0.toFixed(0)}-${f.s1.toFixed(0)} m at (${f.x.toFixed(0)}, ${f.z.toFixed(0)}): h''=${f.d2.toFixed(3)} /m, unloads above ${(Math.sqrt(g / -f.d2) * 3.6).toFixed(0)} km/h`);
  }
}
