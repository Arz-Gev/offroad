import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

// Foliage: a card atlas drawn with Canvas2D at startup (needle sprays, pine tufts, birch leaves, fern
// fronds, shrub leaves, bare twigs), and procedural tree / plant geometry that uses it.
// Geometry attributes: position, normal (card normals bent outwards from the crown, so the crown shades
// like a volume), uv (atlas), aWind (0 at the root .. 1 at the tips: how far the vertex sways).

export const ATLAS = { cols: 4, rows: 2, cell: 512 };
export const CELLS = { spruce: 0, pine: 1, birch: 2, fern: 3, bush: 4, twigs: 5, grassTuft: 6, flowers: 7 };

const cellUV = (i) => {
  const c = i % ATLAS.cols, r = Math.floor(i / ATLAS.cols);
  return { u0: c / ATLAS.cols, v0: 1 - (r + 1) / ATLAS.rows, du: 1 / ATLAS.cols, dv: 1 / ATLAS.rows };
};

// ---------------------------------------------------------------- atlas
export function makeFoliageAtlas() {
  const S = ATLAS.cell, W = S * ATLAS.cols, H = S * ATLAS.rows;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const rnd = mulberry32(31337);
  const R = (a, b) => a + (b - a) * rnd();
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const cell = (i, fn) => { g.save(); g.translate((i % ATLAS.cols) * S, Math.floor(i / ATLAS.cols) * S); g.beginPath(); g.rect(0, 0, S, S); g.clip(); fn(); g.restore(); };
  const line = (x0, y0, x1, y1, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };

  // 0: spruce spray (seen from above): twig up the middle, side twigs, dense short needles
  cell(CELLS.spruce, () => {
    const twig = (x0, y0, ang, len, w, depth) => {
      const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
      line(x0, y0, x1, y1, w, hsl(25, 35, 20));
      const n = Math.floor(len / 3.2);
      for (let k = 0; k < n; k++) {
        const t = k / n, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
        for (const sd of [-1, 1]) {
          const a = ang + sd * R(0.75, 1.15), l = R(11, 17) * (1 - t * 0.35);
          line(px, py, px + Math.cos(a) * l, py + Math.sin(a) * l, R(1.6, 2.4), hsl(R(112, 140), R(28, 42), R(14, 27)));
        }
      }
      if (depth > 0) for (let k = 1; k < 6; k++) {
        const t = k / 6.5, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
        for (const sd of [-1, 1]) twig(px, py, ang + sd * R(0.6, 0.9), len * R(0.3, 0.45) * (1 - t * 0.5), w * 0.6, depth - 1);
      }
    };
    twig(S / 2, S - 4, -Math.PI / 2, S - 30, 4, 1);
  });

  // 1: pine: a dense mass of needle bundles on short twigs
  cell(CELLS.pine, () => {
    for (let b = 0; b < 16; b++) {
      const a0 = -Math.PI / 2 + R(-1.1, 1.1), l0 = R(120, 330);
      const cx = S / 2 + Math.cos(a0) * l0, cy = S - 6 + Math.sin(a0) * l0;
      line(S / 2, S - 4, cx, cy, 4, hsl(22, 35, 24));
      for (let k = 0; k < 55; k++) {
        const a = a0 + R(-1.7, 1.7), l = R(26, 62), u = R(0.4, 1);
        const px = S / 2 + (cx - S / 2) * u, py = S - 4 + (cy - S + 4) * u;
        line(px, py, px + Math.cos(a) * l, py + Math.sin(a) * l, R(1.8, 2.8), hsl(R(92, 118), R(28, 40), R(18, 30)));
      }
    }
  });

  // 2: birch: thin twigs with small oval leaves
  const leaf = (x, y, a, l, w, col) => {
    g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = col;
    g.beginPath(); g.ellipse(l / 2, 0, l / 2, w / 2, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(30,50,20,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(l, 0); g.stroke();
    g.restore();
  };
  cell(CELLS.birch, () => {
    for (let t = 0; t < 7; t++) {
      const x0 = S / 2 + R(-20, 20), y0 = S - 4, a0 = -Math.PI / 2 + R(-0.9, 0.9), len = R(260, 460);
      const x1 = x0 + Math.cos(a0) * len, y1 = y0 + Math.sin(a0) * len;
      line(x0, y0, x1, y1, 3, hsl(20, 25, 22));
      for (let k = 0; k < 26; k++) {
        const u = R(0.15, 1), px = x0 + (x1 - x0) * u, py = y0 + (y1 - y0) * u;
        leaf(px, py, a0 + R(-1.6, 1.6), R(34, 52), R(20, 30), hsl(R(78, 98), R(35, 55), R(26, 42)));
      }
    }
  });

  // 3: fern frond: rachis with tapered pinnae
  cell(CELLS.fern, () => {
    const x0 = S / 2, y0 = S - 6, len = S - 40;
    g.save(); g.translate(x0, y0);
    line(0, 0, 0, -len, 4, hsl(95, 45, 22));
    for (let k = 3; k < 34; k++) {
      const t = k / 34, y = -len * t, pl = 150 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.3) + 8;
      for (const sd of [-1, 1]) {
        g.save(); g.translate(0, y); g.rotate(sd * (1.2 - t * 0.5)); g.fillStyle = hsl(R(95, 115), R(40, 55), R(22, 32));
        g.beginPath(); g.moveTo(0, -3); for (let s = 0; s <= 8; s++) { const u = s / 8; g.lineTo(u * pl, -3 - Math.sin(u * Math.PI) * 9 * (1 - u * 0.5) + (s % 2) * 3); }
        for (let s = 8; s >= 0; s--) { const u = s / 8; g.lineTo(u * pl, 3 + Math.sin(u * Math.PI) * 9 * (1 - u * 0.5) - (s % 2) * 3); }
        g.closePath(); g.fill(); g.restore();
      }
    }
    g.restore();
  });

  // 4: shrub leaves: dense broad leaves
  cell(CELLS.bush, () => {
    for (let k = 0; k < 260; k++) {
      const r = Math.sqrt(rnd()) * S * 0.44, a = R(0, Math.PI * 2);
      leaf(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, R(0, Math.PI * 2), R(36, 58), R(22, 34), hsl(R(85, 120), R(30, 50), R(16, 30)));
    }
  });

  // 5: bare twigs (dead trees, winter shrubs)
  cell(CELLS.twigs, () => {
    const br = (x, y, a, l, w, d) => {
      const x1 = x + Math.cos(a) * l, y1 = y + Math.sin(a) * l;
      line(x, y, x1, y1, w, hsl(25, 15, R(22, 34)));
      if (d > 0) for (let k = 0; k < 3; k++) br(x1, y1, a + R(-0.7, 0.7), l * R(0.55, 0.75), w * 0.7, d - 1);
    };
    br(S / 2, S - 4, -Math.PI / 2, 150, 7, 4);
  });

  // 6: grass tuft (side view): blades from the bottom centre
  cell(CELLS.grassTuft, () => {
    for (let k = 0; k < 60; k++) {
      const x = S / 2 + R(-90, 90), a = -Math.PI / 2 + R(-0.5, 0.5), l = R(200, 470);
      g.strokeStyle = hsl(R(70, 95), R(35, 50), R(22, 38)); g.lineWidth = R(4, 8); g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, S); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5, S + Math.sin(a) * l * 0.6, x + Math.cos(a) * l + R(-40, 40), S + Math.sin(a) * l); g.stroke();
    }
  });

  // 7: meadow flowers (side view): stems with small heads
  cell(CELLS.flowers, () => {
    for (let k = 0; k < 26; k++) {
      const x = R(40, S - 40), h = R(200, 440), top = S - h;
      line(x, S, x + R(-30, 30), top, 3, hsl(95, 40, 28));
      const col = [hsl(55, 90, 60), hsl(0, 0, 92), hsl(280, 45, 55), hsl(30, 90, 55)][k % 4];
      g.fillStyle = col;
      for (let p = 0; p < 6; p++) { const a = p / 6 * Math.PI * 2; g.beginPath(); g.ellipse(x + Math.cos(a) * 10, top + Math.sin(a) * 10, 9, 6, a, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = hsl(45, 80, 45); g.beginPath(); g.arc(x, top, 6, 0, Math.PI * 2); g.fill();
    }
  });

  // read back (straight alpha), bleed colour into transparent texels so mipmaps don't get dark fringes
  const img = g.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(img.length);
  data.set(img);
  for (let pass = 0; pass < 6; pass++) {
    const src = data.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const o = (y * W + x) * 4;
      if (src[o + 3] > 128) continue;
      let r = 0, gg = 0, b = 0, n = 0;
      for (const d of [-4, 4, -W * 4, W * 4]) { const q = o + d; if (src[q + 3] > 128 || (pass > 0 && (src[q] | src[q + 1] | src[q + 2]))) { r += src[q]; gg += src[q + 1]; b += src[q + 2]; n++; } }
      if (n) { data[o] = r / n; data[o + 1] = gg / n; data[o + 2] = b / n; }
    }
  }
  // the canvas has y down; the texture's v goes up: flip rows
  const flipped = new Uint8Array(data.length), row = W * 4;
  for (let y = 0; y < H; y++) flipped.set(data.subarray(y * row, (y + 1) * row), (H - 1 - y) * row);
  const t = new THREE.DataTexture(flipped, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- geometry helpers
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

// a card (quad) in the atlas cell, base at the origin, extending along +y, facing +z; then transformed
function card(cellIdx, w, h, matrix, windBase, windTip, crownCentre, normalBend = 0.6) {
  const c = cellUV(cellIdx);
  const g = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, c.u0 + uv.getX(i) * c.du, c.v0 + uv.getY(i) * c.dv);
  g.applyMatrix4(matrix);
  const pos = g.attributes.position, nor = g.attributes.normal;
  const wind = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    wind[i] = i < 2 ? windTip : windBase; // PlaneGeometry: vertices 0,1 are the top row
    if (crownCentre) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(crownCentre).normalize();
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const s = Math.sign(nx * _v.x + ny * _v.y + nz * _v.z) || 1;
      _v.lerp(new THREE.Vector3(nx * s, ny * s, nz * s), 1 - normalBend).normalize();
      nor.setXYZ(i, _v.x, _v.y, _v.z);
    }
  }
  g.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
  return g;
}

// tapered cylinder along a polyline (trunk / branch), bark uv: u around, v along (metres / vScale)
function tube(points, radii, sides, vScale, windAt) {
  const pos = [], nor = [], uv = [], wind = [], idx = [];
  let vAcc = 0;
  const up = new THREE.Vector3(0, 1, 0), t = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const d = (i < points.length - 1 ? points[i + 1].clone().sub(p) : p.clone().sub(points[i - 1])).normalize();
    t.copy(Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).cross(d).normalize();
    b.copy(d).cross(t).normalize();
    if (i > 0) vAcc += points[i].distanceTo(points[i - 1]) / vScale;
    for (let s = 0; s <= sides; s++) {
      const a = s / sides * Math.PI * 2;
      n.copy(t).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
      pos.push(p.x + n.x * radii[i], p.y + n.y * radii[i], p.z + n.z * radii[i]);
      nor.push(n.x, n.y, n.z);
      uv.push(s / sides, vAcc);
      wind.push(windAt(i / (points.length - 1), p));
    }
  }
  for (let i = 0; i < points.length - 1; i++) for (let s = 0; s < sides; s++) {
    const a = i * (sides + 1) + s, b2 = a + sides + 1;
    idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(wind, 1));
  g.setIndex(idx);
  return g;
}

const cardMatrix = (pos, dir, roll, tiltUp = 0) => {
  // card plane spanned by its length direction `dir` and a side vector; roll around dir
  const y = dir.clone().normalize();
  let x = new THREE.Vector3(0, 1, 0).cross(y);
  if (x.lengthSq() < 1e-4) x.set(1, 0, 0);
  x.normalize();
  let z = x.clone().cross(y).normalize();
  // roll the card around its length axis (0 = lying flat, facing up-ish)
  const xr = x.clone().multiplyScalar(Math.cos(roll)).addScaledVector(z, Math.sin(roll));
  const zr = xr.clone().cross(y).normalize();
  _m.makeBasis(xr, y, zr).setPosition(pos);
  return _m.clone();
};

// ---------------------------------------------------------------- species
// Each builder returns { trunk, crown, height, crownR, trunkR }. Sizes in metres, base at the origin.

export function buildSpruce(seed, H = 17) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const trunkPts = [], trunkR = [];
  const lean = new THREE.Vector2(R(-0.15, 0.15), R(-0.15, 0.15));
  for (let i = 0; i <= 8; i++) { const t = i / 8; trunkPts.push(new THREE.Vector3(lean.x * t * t, H * t, lean.y * t * t)); trunkR.push(0.03 + 0.24 * Math.pow(1 - t, 1.2) * (H / 17)); }
  trunkR[0] *= 1.25;
  const trunk = tube(trunkPts, trunkR, 7, 1.2, (t) => t * t);
  const cards = [];
  const crownBase = H * R(0.12, 0.2), maxR = H * 0.24;
  const centre = new THREE.Vector3(0, H * 0.45, 0);
  const branches = [];
  let whorl = 0;
  for (let h = crownBase; h < H - 0.6; h += R(0.42, 0.62)) {
    const t = (h - crownBase) / (H - crownBase);
    const len = maxR * Math.pow(1 - t, 0.85) * R(0.85, 1.1) + 0.35;
    const n = t > 0.85 ? 4 : R(5, 7) | 0;
    const a0 = R(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const a = a0 + k / n * Math.PI * 2 + R(-0.25, 0.25);
      const droop = -0.25 - 0.35 * (1 - t) + R(-0.1, 0.1);
      const dir = new THREE.Vector3(Math.cos(a), droop, Math.sin(a)).normalize();
      const base = new THREE.Vector3(lean.x * t * t, h, lean.y * t * t);
      branches.push({ base, dir, len, t });
      // two or three sprays along the branch, roughly flat, slightly cupped
      const nC = len > 1.6 ? 3 : 2;
      for (let c = 0; c < nC; c++) {
        const u = c / nC;
        const p = base.clone().addScaledVector(dir, len * u * 0.85);
        const cl = len * (1 - u * 0.55) * 0.75 + 0.35;
        const m = cardMatrix(p, dir, c % 2 === 0 ? R(-0.45, 0.45) : Math.PI / 2 + R(-0.3, 0.3));
        cards.push(card(CELLS.spruce, cl * 0.9, cl, m, 0.2 + t * 0.4 + u * 0.3, 0.45 + t * 0.4 + u * 0.4, centre, 0.5));
      }
    }
    whorl++;
  }
  // top: crossed vertical sprays
  for (let k = 0; k < 3; k++) {
    const a = k / 3 * Math.PI;
    const m = cardMatrix(new THREE.Vector3(lean.x, H - 1.6, lean.y), new THREE.Vector3(0, 1, 0), a);
    cards.push(card(CELLS.spruce, 0.9, 2.0, m, 0.8, 1.0, centre, 0.4));
  }
  // thin branch sticks under the sprays (visible from below)
  const sticks = branches.filter((b, i) => i % 2 === 0 && b.len > 1).map(b => tube([b.base, b.base.clone().addScaledVector(b.dir, b.len * 0.8)], [0.035, 0.012], 3, 1.0, (t) => 0.2 + b.t * 0.4 + t * 0.3));
  const crown = mergeGeometries(cards);
  return { trunk: mergeGeometries([trunk, ...sticks]), crown, height: H, crownR: maxR, trunkR: trunkR[0], crownBase };
}

export function buildPine(seed, H = 19) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const pts = [], rr = [];
  const bend = new THREE.Vector2(R(-0.6, 0.6), R(-0.6, 0.6));
  for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector3(bend.x * Math.sin(t * 2.2) * 0.5, H * t, bend.y * Math.sin(t * 2.6) * 0.5)); rr.push(0.035 + 0.2 * Math.pow(1 - t, 1.15) * (H / 19)); }
  const trunk = tube(pts, rr, 7, 1.3, t => t * t);
  const cards = [], sticks = [];
  const crownBase = H * R(0.5, 0.6);
  const centre = new THREE.Vector3(0, (crownBase + H) / 2, 0);
  const nb = 11;
  const clump = (p, size, t, up = 0) => {
    // a rounded clump of needle cards facing outwards
    for (let c = 0; c < 7; c++) {
      const d = new THREE.Vector3(R(-1, 1), R(-0.3, 1) + up, R(-1, 1)).normalize();
      const m = cardMatrix(p.clone().addScaledVector(d, -size * 0.45), d, R(0, Math.PI));
      cards.push(card(CELLS.pine, size, size, m, 0.55 + t * 0.3, 0.85 + t * 0.15, p, 0.35));
    }
  };
  for (let k = 0; k < nb; k++) {
    const t = k / nb;
    const h = crownBase + (H - crownBase - 1.2) * t;
    const a = k * 2.4 + R(-0.3, 0.3);
    const len = (1.4 + 2.2 * Math.sin(Math.PI * (0.25 + t * 0.7))) * R(0.8, 1.15);
    const dir = new THREE.Vector3(Math.cos(a), R(0.15, 0.5), Math.sin(a)).normalize();
    const tp = pts[Math.min(10, Math.round(h / H * 10))];
    const base = new THREE.Vector3(tp.x, h, tp.z);
    sticks.push(tube([base, base.clone().addScaledVector(dir, len)], [0.06, 0.02], 4, 1.0, (u) => 0.5 + t * 0.3 + u * 0.3));
    clump(base.clone().addScaledVector(dir, len), R(1.5, 2.0), t);
    if (len > 2.2) clump(base.clone().addScaledVector(dir, len * 0.55), R(1.2, 1.6), t);
  }
  const top = pts[10];
  clump(new THREE.Vector3(top.x, H - 0.8, top.z), 1.9, 1, 0.3);
  return { trunk: mergeGeometries([trunk, ...sticks]), crown: mergeGeometries(cards), height: H, crownR: 4.2, trunkR: rr[0], crownBase };
}

export function buildBirch(seed, H = 13) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const pts = [], rr = [];
  const bend = new THREE.Vector2(R(-0.5, 0.5), R(-0.5, 0.5));
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector3(bend.x * t * t, H * t, bend.y * t * t)); rr.push(0.03 + 0.13 * Math.pow(1 - t, 1.1)); }
  const trunk = tube(pts, rr, 6, 1.0, t => t * t);
  const cards = [], sticks = [];
  const crownBase = H * R(0.3, 0.42);
  const centre = new THREE.Vector3(bend.x * 0.5, crownBase + (H - crownBase) * 0.5, bend.y * 0.5);
  for (let k = 0; k < 16; k++) {
    const t = k / 16;
    const h = crownBase + (H - crownBase - 0.5) * t;
    const a = k * 2.4 + R(-0.4, 0.4);
    const len = (1.2 + 2.0 * Math.sin(Math.PI * (0.2 + t * 0.8))) * R(0.8, 1.2);
    const dir = new THREE.Vector3(Math.cos(a), R(0.5, 1.1), Math.sin(a)).normalize();
    const tp = pts[Math.min(8, Math.round(h / H * 8))];
    const base = new THREE.Vector3(tp.x, h, tp.z);
    sticks.push(tube([base, base.clone().addScaledVector(dir, len)], [0.04, 0.012], 3, 1.0, u => 0.5 + t * 0.3 + u * 0.3));
    for (let c = 0; c < 3; c++) {
      const p = base.clone().addScaledVector(dir, len * (0.45 + c * 0.25));
      const d2 = new THREE.Vector3(R(-1, 1), R(-0.6, 0.2), R(-1, 1)).normalize();
      const m = cardMatrix(p.clone().addScaledVector(d2, -0.6), d2, R(0, Math.PI));
      cards.push(card(CELLS.birch, 1.5, 1.5, m, 0.6 + t * 0.2, 0.95, centre, 0.4));
    }
  }
  return { trunk: mergeGeometries([trunk, ...sticks]), crown: mergeGeometries(cards), height: H, crownR: 3.2, trunkR: rr[0], crownBase };
}

export function buildDead(seed, H = 11) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const pts = [], rr = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector3(R(-0.1, 0.1) * t, H * t, R(-0.1, 0.1) * t)); rr.push(0.03 + 0.2 * Math.pow(1 - t, 1.2)); }
  const parts = [tube(pts, rr, 6, 1.2, t => t * t * 0.5)];
  const cards = [];
  for (let k = 0; k < 9; k++) {
    const h = H * R(0.3, 0.92), a = R(0, Math.PI * 2), len = R(0.8, 2.6) * (1 - h / H * 0.6);
    const dir = new THREE.Vector3(Math.cos(a), R(-0.3, 0.4), Math.sin(a)).normalize();
    const base = new THREE.Vector3(0, h, 0);
    parts.push(tube([base, base.clone().addScaledVector(dir, len)], [0.05, 0.012], 3, 1, u => 0.3 + u * 0.3));
    const m = cardMatrix(base.clone().addScaledVector(dir, len * 0.4), dir, R(0, Math.PI));
    cards.push(card(CELLS.twigs, 1.4, len * 0.9 + 0.4, m, 0.3, 0.6, null));
  }
  return { trunk: mergeGeometries(parts), crown: mergeGeometries(cards), height: H, crownR: 2, trunkR: rr[0], crownBase: H * 0.3 };
}

// undergrowth: crossed cards
export function buildPlant(kind, seed) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const cards = [];
  if (kind === 'fern') {
    const n = 7, centre = new THREE.Vector3(0, -0.3, 0);
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2 + R(-0.3, 0.3);
      const dir = new THREE.Vector3(Math.cos(a), R(0.5, 0.9), Math.sin(a)).normalize();
      cards.push(card(CELLS.fern, 0.55, R(0.8, 1.1), cardMatrix(new THREE.Vector3(0, 0, 0), dir, Math.PI / 2 + R(-0.4, 0.4)), 0.0, 0.8, centre, 0.4));
    }
  } else if (kind === 'bush') {
    const centre = new THREE.Vector3(0, 0.5, 0);
    for (let k = 0; k < 9; k++) {
      const d = new THREE.Vector3(R(-1, 1), R(0.2, 1), R(-1, 1)).normalize();
      const p = d.clone().multiplyScalar(0.35).add(new THREE.Vector3(0, R(0.1, 0.4), 0));
      cards.push(card(CELLS.bush, R(0.9, 1.3), R(0.9, 1.3), cardMatrix(p.addScaledVector(d, -0.5), d, R(0, Math.PI)), 0.1, 0.7, centre, 0.45));
    }
  } else if (kind === 'flowers' || kind === 'tuft') {
    const cellIdx = kind === 'flowers' ? CELLS.flowers : CELLS.grassTuft;
    for (let k = 0; k < 3; k++) {
      const m = cardMatrix(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), k / 3 * Math.PI + R(0, 0.5));
      cards.push(card(cellIdx, R(0.7, 1.0), R(0.5, 0.75), m, 0.0, 0.8, null));
    }
  }
  return mergeGeometries(cards);
}
