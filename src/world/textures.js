import * as THREE from 'three';
import { mulberry32 } from './noise.js';

// Tileable procedural textures painted on canvases at startup (no external assets).

function makeValueNoise(period, seed) {
  const rnd = mulberry32(seed);
  const v = new Float32Array(period * period);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = v[y0 * period + x0], b = v[y0 * period + x1], c = v[y1 * period + x0], d = v[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

// fbm tileable over [0,1)^2
function tileFbm(octaves, basePeriod, seed) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(makeValueNoise(basePeriod << o, seed + o * 31));
  return (u, v) => {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < octaves; o++) {
      const p = basePeriod << o;
      s += a * layers[o](u * p, v * p);
      n += a; a *= 0.5;
    }
    return s / n;
  };
}

// painted straight into a DataTexture (a canvas would premultiply alpha and wreck the colour of low-alpha texels)
function canvasTex(size, paint, { srgb = true } = {}) {
  const data = new Uint8Array(size * size * 4);
  paint(data, size);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function fill(data, size, fn) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = fn(x / size, y / size, x, y);
    const i = (y * size + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a === undefined ? 255 : a;
  }
}
const cl = v => Math.max(0, Math.min(255, v));

export function makeGroundTextures() {
  const S = 512;
  const grass = canvasTex(S, (d, size) => {
    const n1 = tileFbm(5, 4, 3), n2 = tileFbm(3, 32, 9), n3 = tileFbm(2, 64, 17);
    fill(d, size, (u, v) => {
      const a = n1(u, v), b = n2(u, v), c = n3(u, v);
      const dry = Math.max(0, a - 0.48) * 2.2;
      const blade = Math.pow(c, 3) * 1.4;
      let r = 62 + dry * 70 + b * 22 + blade * 30;
      let g = 84 + dry * 42 + b * 30 + blade * 40;
      let bl = 38 + dry * 18 + b * 10;
      const dirt = Math.max(0, 0.36 - a) * 3;
      r = r * (1 - dirt) + 102 * dirt; g = g * (1 - dirt) + 86 * dirt; bl = bl * (1 - dirt) + 62 * dirt;
      return [cl(r), cl(g), cl(bl), cl(120 + b * 120)];
    });
  });
  const dirt = canvasTex(S, (d, size) => {
    const n1 = tileFbm(5, 4, 5), n2 = tileFbm(3, 48, 13);
    const rnd = mulberry32(77);
    fill(d, size, (u, v) => {
      const a = n1(u, v), b = n2(u, v);
      const r = 118 + a * 50 + b * 20, g = 96 + a * 40 + b * 16, bl = 70 + a * 28 + b * 10;
      return [cl(r), cl(g), cl(bl), cl(100 + b * 155)];
    });
    // pebbles
    for (let k = 0; k < 1500; k++) {
      const x = Math.floor(rnd() * size), y = Math.floor(rnd() * size);
      const rad = 0.8 + rnd() * 2.2, shade = 0.55 + rnd() * 0.45;
      for (let yy = -4; yy <= 4; yy++) for (let xx = -4; xx <= 4; xx++) {
        const dd = Math.hypot(xx, yy);
        if (dd > rad) continue;
        const px = (x + xx + size) % size, py = (y + yy + size) % size;
        const i = (py * size + px) * 4;
        const lit = shade * (1.05 - 0.25 * (yy / rad));
        d[i] = cl(d[i] * 0.45 + 118 * lit); d[i + 1] = cl(d[i + 1] * 0.45 + 106 * lit); d[i + 2] = cl(d[i + 2] * 0.45 + 92 * lit);
        d[i + 3] = cl(200 + 50 * (1 - dd / rad));
      }
    }
  });
  const rock = canvasTex(S, (d, size) => {
    const n1 = tileFbm(6, 4, 21), n2 = tileFbm(4, 16, 25);
    fill(d, size, (u, v) => {
      const a = n1(u, v), b = n2(u, v);
      const crack = Math.pow(1 - Math.abs(b - 0.5) * 2, 8);
      const g0 = 104 + a * 70 - crack * 50;
      return [cl(g0 + 6), cl(g0 + 2), cl(g0 - 6), cl(140 + a * 100 - crack * 120)];
    });
  });
  const mud = canvasTex(S, (d, size) => {
    const n1 = tileFbm(5, 4, 41), n2 = tileFbm(3, 24, 45);
    fill(d, size, (u, v) => {
      const a = n1(u, v), b = n2(u, v);
      const wet = a > 0.52 ? 1 : 0;
      const r = 72 + a * 30 + b * 10 - wet * 18, g = 54 + a * 22 + b * 8 - wet * 14, bl = 36 + a * 14 - wet * 8;
      return [cl(r), cl(g), cl(bl), cl(wet ? 245 : 60 + b * 100)];
    });
  });
  const macro = canvasTex(256, (d, size) => {
    const n1 = tileFbm(5, 3, 51);
    fill(d, size, (u, v) => { const a = n1(u, v); return [cl(a * 255), cl(a * 255), cl(a * 255), 255]; });
  }, { srgb: false });
  return { grass, dirt, rock, mud, macro };
}

// Black rubber with subtle noise for tyres
export function makeRubberTexture() {
  return canvasTex(256, (d, size) => {
    const n = tileFbm(4, 8, 61);
    fill(d, size, (u, v) => { const a = n(u, v); const g = 48 + a * 26; return [cl(g), cl(g), cl(g + 2), 255]; });
  });
}

// Bark / needles for the trees
export function makeBarkTexture() {
  return canvasTex(128, (d, size) => {
    const n = tileFbm(4, 4, 71);
    fill(d, size, (u, v) => {
      const a = n(u * 4, v * 0.5);
      const g = 60 + a * 50;
      return [cl(g + 12), cl(g - 2), cl(g - 16), 255];
    });
  });
}
