// Overview of the endless world straight from the rules (worldgen.js), no window: shaded relief, roads, lakes,
// streams and sites over a large area, for tuning the generator without starting the game.
//   node tools/worldmap.mjs out.png [metresPerPixel=8] [x0 z0 x1 z1]   (default: 12 km round the origin)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { World } from '../src/world/worldgen.js';

const out = process.argv[2] || 'world.png';
const mpp = +(process.argv[3] || 8);
const [x0, z0, x1, z1] = process.argv.length >= 8 ? process.argv.slice(4, 8).map(Number) : [-6000, -6000, 6000, 6000];
const seed = +(process.env.SEED || 7);
const w = new World(seed);
const W = Math.round((x1 - x0) / mpp), Hh = Math.round((z1 - z0) / mpp);
const img = Buffer.alloc(W * Hh * 3);
const t0 = performance.now();
const hs = new Float32Array((W + 1) * (Hh + 1));
for (let py = 0; py <= Hh; py++) for (let px = 0; px <= W; px++) hs[py * (W + 1) + px] = w.macro(x0 + px * mpp, z0 + py * mpp);
let slopeHist = new Float64Array(8), steepN = 0;
for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) {
  const h = hs[py * (W + 1) + px], hx = hs[py * (W + 1) + px + 1], hz = hs[(py + 1) * (W + 1) + px];
  const nx = (h - hx) / mpp, nz = (h - hz) / mpp, s = Math.hypot(nx, nz);
  slopeHist[Math.min(7, Math.floor(Math.atan(s) * 180 / Math.PI / 5))]++;
  const lit = 0.45 + 0.6 * Math.max(0, (nx * -0.5 + 1 * 0.75 + nz * -0.45) / Math.hypot(nx, 1, nz) / 1.0);
  let c = h > 330 ? [235, 238, 242] : s > 0.72 ? [128, 124, 118] : h > 150 ? [120, 128, 100] : [96, 128, 70];
  c = c.map(v => v * lit);
  const fr = h / 10 - Math.floor(h / 10);
  if (fr < 0.08) c = c.map(v => v * (Math.round(h / 10) % 5 === 0 ? 0.6 : 0.85));
  const o = (py * W + px) * 3;
  img[o] = Math.min(255, c[0]); img[o + 1] = Math.min(255, c[1]); img[o + 2] = Math.min(255, c[2]);
}
const put = (X, Z, c, r = 0) => {
  const px = Math.round((X - x0) / mpp), py = Math.round((Z - z0) / mpp);
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    const qx = px + a, qy = py + b;
    if (qx < 0 || qy < 0 || qx >= W || qy >= Hh) continue;
    const o = (qy * W + qx) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
  }
};
const t1 = performance.now();
const regions = w.regionsIn(x0, z0, x1, z1);
for (const r of regions) for (const l of r.lakes) {
  for (let X = l.x - l.rx; X <= l.x + l.rx; X += mpp / 2) for (let Z = l.z - l.rz; Z <= l.z + l.rz; Z += mpp / 2)
    if (Math.hypot((X - l.x) / l.rx, (Z - l.z) / l.rz) < 1) put(X, Z, [40, 90, 170]);
}
const roads = w.roadsIn(x0, z0, x1, z1);
const t2 = performance.now();
for (const e of roads) for (let k = 0; k < e.xs.length; k += 2) put(e.xs[k], e.zs[k], e.spur ? [250, 150, 60] : [235, 205, 125]);
for (const r of regions) for (const s of r.streams) for (let k = 0; k < s.xs.length; k++) put(s.xs[k], s.zs[k], [70, 140, 220]);
const SITE = { hut: [200, 40, 40], quarry: [240, 240, 240], lookout: [250, 60, 220], lake: [30, 30, 120] };
const counts = {};
for (const r of regions) for (const s of r.sites) { put(s.x, s.z, SITE[s.type], 2); counts[s.type] = (counts[s.type] || 0) + 1; }
const sp = w.spawn();
put(sp.x, sp.z, [0, 0, 0], 3);
// grades along the roads
let steep = 0, tot = 0, maxG = 0;
for (const e of roads) for (let k = 4; k < e.hs.length; k += 4) { const g = Math.abs(e.hs[k] - e.hs[k - 4]) / 2; tot++; if (g > Math.tan(16 * Math.PI / 180)) steep++; maxG = Math.max(maxG, g); }
console.log(`relief ${(t1 - t0).toFixed(0)} ms, roads ${roads.length} in ${(t2 - t1).toFixed(0)} ms; sites`, counts);
console.log('slope histogram (5 deg bins, %):', [...slopeHist].map(v => (100 * v / (W * Hh)).toFixed(1)).join(' '));
console.log(`road samples steeper than 16 deg: ${(100 * steep / tot).toFixed(2)} %, steepest ${(Math.atan(maxG) * 180 / Math.PI).toFixed(1)} deg; spawn`, sp);
// PNG encode
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W * 3 + 1) * Hh);
for (let y = 0; y < Hh; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(Hh, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out, W, 'x', Hh);
