// Shaded relief of the generated map (surfaces, trails, water, contour lines) as a PNG, for designing
// the layout without starting the game.   node tools/mapimage.mjs out.png [pixelsPerMetre=1] [x0 z0 x1 z1]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Terrain, MAP_SIZE, SURF } from '../src/world/terrain.js';

const out = process.argv[2] || 'map.png';
const ppm = +(process.argv[3] || 1);
const half = MAP_SIZE / 2;
const [x0, z0, x1, z1] = process.argv.length >= 8 ? process.argv.slice(4, 8).map(Number) : [-half, -half, half, half];
const t = new Terrain(7);
console.log('gen ms', t.genMs.toFixed(0));
const W = Math.round((x1 - x0) * ppm), Hh = Math.round((z1 - z0) * ppm);
const img = Buffer.alloc(W * Hh * 3);
const sun = [-0.5, 0.75, -0.45];
const sl = Math.hypot(...sun);
const COL = { [SURF.grass]: [96, 128, 70], [SURF.dirt]: [150, 120, 84], [SURF.rock]: [128, 124, 118], [SURF.mud]: [86, 66, 48], [SURF.sand]: [196, 180, 140] };
for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) {
  const x = x0 + (px + 0.5) / ppm, z = z0 + (py + 0.5) / ppm;
  const h = t.surfaceHeight(x, z);
  const e = 0.6;
  const nx = t.surfaceHeight(x - e, z) - t.surfaceHeight(x + e, z), nz = t.surfaceHeight(x, z - e) - t.surfaceHeight(x, z + e), ny = 2 * e;
  const nl = Math.hypot(nx, ny, nz);
  let lit = Math.max(0, (nx * sun[0] + ny * sun[1] + nz * sun[2]) / (nl * sl));
  lit = 0.35 + 0.75 * lit;
  let c = Math.abs(x) <= half && Math.abs(z) <= half ? COL[t.surfaceId(x, z)] : [110, 120, 110];
  c = c.map(v => v * lit);
  // contours every 5 m (darker every 25 m)
  const fr = h / 5 - Math.floor(h / 5);
  if (fr < 0.06 * ppm / 1) c = c.map(v => v * (Math.round(h / 5) % 5 === 0 ? 0.55 : 0.8));
  const wl = t.waterLevelAt(x, z);
  if (wl > h) { const d = Math.min(1, (wl - h) / 1.5); c = [c[0] * (1 - d) * 0.4 + 30 * d, c[1] * (1 - d) * 0.5 + 80 * d, c[2] * 0.5 * (1 - d) + 140 * d + 40]; }
  if (t.isTrail(x, z, 1.2)) c = [230, 200, 120];
  const o = (py * W + px) * 3;
  img[o] = Math.min(255, c[0]); img[o + 1] = Math.min(255, c[1]); img[o + 2] = Math.min(255, c[2]);
}
// PNG encode
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W * 3 + 1) * Hh);
for (let y = 0; y < Hh; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(Hh, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out, W, 'x', Hh);
