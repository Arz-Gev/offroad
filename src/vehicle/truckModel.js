import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createTireMaterial } from './tireMaterial.js';
import { makeRubberTexture } from '../world/textures.js';

// Procedural Defender 110 style truck, modelled after the reference sheet.
// Local frame matches physics: +x right, +y up, -z forward, y = 0 ground at static ride.

const W2 = 0.895;          // half body width
const SILL = 0.66;         // body bottom
const BELT = 1.30;         // beltline
const ROOF = 1.97;
const FRONT = -2.13, REAR = 2.38, BULK = -0.80;
const ARCH_F = -1.397, ARCH_R = 1.397;

export function createMaterials() {
  const m = {
    paint: new THREE.MeshPhysicalMaterial({ color: 0xa8180f, roughness: 0.48, metalness: 0.0, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    black: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.78, metalness: 0.0 }),
    blackMetal: new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.5, metalness: 0.55 }),
    chassis: new THREE.MeshStandardMaterial({ color: 0x232325, roughness: 0.85, metalness: 0.2 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.42, metalness: 0.6 }),
    zinc: new THREE.MeshStandardMaterial({ color: 0x9a9ca0, roughness: 0.35, metalness: 0.9 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xd9b01e, roughness: 0.45, metalness: 0.2 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x1a2328, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.38, depthWrite: false, envMapIntensity: 1.6, side: THREE.DoubleSide }),
    interior: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.95 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x303236, roughness: 0.98 }),
    headliner: new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 0.95 }),
    dash: new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.7 }),
    headLens: new THREE.MeshStandardMaterial({ color: 0xd8dde0, roughness: 0.15, metalness: 0.3, emissive: 0xfff4e0, emissiveIntensity: 0 }),
    barLens: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.15, metalness: 0.3, emissive: 0xf4f8ff, emissiveIntensity: 0 }),
    workLens: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.15, metalness: 0.3, emissive: 0xffffff, emissiveIntensity: 0 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x5c0805, roughness: 0.25, emissive: 0xff1608, emissiveIntensity: 0 }),
    brake: new THREE.MeshStandardMaterial({ color: 0x5c0805, roughness: 0.25, emissive: 0xff1608, emissiveIntensity: 0 }),
    amber: new THREE.MeshStandardMaterial({ color: 0x7a4300, roughness: 0.25, emissive: 0xff8c10, emissiveIntensity: 0 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0xbfc3c6, roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 }),
    reflector: new THREE.MeshStandardMaterial({ color: 0x8a1a10, roughness: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd0d2d4, roughness: 0.12, metalness: 1.0 }),
  };
  return m;
}

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, mat);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}
const rbox = (w, h, d, r, mat, x, y, z) => mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat, x, y, z);
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
// box spanning [x0,x1] x [y0,y1] x [z0,z1]
const span = (x0, x1, y0, y1, z0, z1, mat, r = 0) => (r > 0 ? rbox : (w, h, d, _r, m, x, y, z) => box(w, h, d, m, x, y, z))(x1 - x0, y1 - y0, z1 - z0, r, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

const _up = new THREE.Vector3(0, 1, 0);
// cylinder between two points
function bar(a, b, r, mat, seg = 10) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const m = mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, B.clone().sub(A).normalize());
  return m;
}

// side profile (z, y) extruded across x
function extrudeProfile(points, depth, mat, bevel = 0.015) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  geo.translate(0, 0, -(depth - 2 * bevel) / 2);
  geo.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world x
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

function archPoints(zc, rear, front, top) {
  // squared-off Defender arch from rear base to front base (z increasing = rearward)
  return [[zc + rear, SILL], [zc + rear - 0.08, top - 0.03], [zc + rear - 0.2, top], [zc - front + 0.2, top], [zc - front + 0.08, top - 0.03], [zc - front, SILL]];
}


// Merge every static mesh under `group` into one mesh per material (keeps draw calls low).
// Objects for which skip(o) is true are left alone together with their children.
function mergeStatic(group, skip = () => false) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const remove = [];
  const visit = (o) => {
    for (const c of [...o.children]) {
      if (skip(c)) continue;
      if (c.isMesh && c.children.length === 0 && !c.isInstancedMesh) {
        const g = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld));
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        const key = c.material.uuid;
        if (!buckets.has(key)) buckets.set(key, { mat: c.material, geos: [], cast: c.castShadow });
        buckets.get(key).geos.push(g);
        remove.push(c);
      } else if (!c.isLight) visit(c);
    }
  };
  visit(group);
  for (const c of remove) c.parent.remove(c);
  for (const { mat, geos, cast } of buckets.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.castShadow = cast && mat.opacity === 1;
    m.receiveShadow = true;
    group.add(m);
  }
}

// ---------------------------------------------------------------- wheel
let _tireGeo = null, _rimGeo = null;
export function tireGeometry(R = 0.42, width = 0.27) {
  if (_tireGeo) return _tireGeo;
  const hw = width / 2;
  const prof = [[0.205, -0.112], [0.235, -0.125], [0.29, -0.133], [0.345, -0.134], [0.378, -0.128], [0.392, -0.116],
    [0.398, -0.095], [0.399, 0.0], [0.398, 0.095], [0.392, 0.116], [0.378, 0.128], [0.345, 0.134], [0.29, 0.133], [0.235, 0.125], [0.205, 0.112]];
  const carcass = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 72);
  carcass.rotateZ(-Math.PI / 2); // axis along x
  const parts = [carcass];
  const NP = 22;
  const lug = (axial, radial0, radial1, circ, ax, angle, skew = 0) => {
    const g = new THREE.BoxGeometry(axial, radial1 - radial0, circ);
    g.translate(0, (radial0 + radial1) / 2, 0);
    if (skew) g.rotateY(skew);
    g.translate(ax, 0, 0);
    g.rotateX(angle);
    return g;
  };
  for (let k = 0; k < NP; k++) {
    const a = (k / NP) * Math.PI * 2, b = a + Math.PI / NP;
    // big shoulder blocks, staggered left / right
    parts.push(lug(0.085, 0.392, R, 0.078, -0.088, a, 0.12));
    parts.push(lug(0.085, 0.392, R, 0.078, 0.088, b, -0.12));
    // sidewall lugs wrapping over the shoulder
    parts.push(lug(0.028, 0.345, 0.405, 0.06, -0.128, a));
    parts.push(lug(0.028, 0.345, 0.405, 0.06, 0.128, b));
    // centre blocks
    parts.push(lug(0.055, 0.395, R - 0.002, 0.05, -0.022, b + 0.05, 0.4));
    parts.push(lug(0.055, 0.395, R - 0.002, 0.05, 0.022, a + 0.05, -0.4));
  }
  const nonIndexed = parts.map(g => { const ng = g.index ? g.toNonIndexed() : g; ng.deleteAttribute('uv'); return ng; });
  _tireGeo = mergeGeometries(nonIndexed);
  _tireGeo.computeVertexNormals();
  _tireGeo.computeBoundingSphere();
  return _tireGeo;
}

function rimGroup(mats) {
  const g = new THREE.Group();
  // barrel
  const barrel = mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.2, 32, 1, true), mats.steel);
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);
  // dished face with lightening holes (modular steel wheel)
  const face = new THREE.Shape();
  face.absarc(0, 0, 0.198, 0, Math.PI * 2, false);
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    const h = new THREE.Path();
    h.absellipse(Math.cos(a) * 0.135, Math.sin(a) * 0.135, 0.028, 0.038, 0, Math.PI * 2, true, a);
    face.holes.push(h);
  }
  const fg = new THREE.ExtrudeGeometry(face, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 24 });
  fg.rotateY(Math.PI / 2);
  const f = mesh(fg, mats.steel, 0.045, 0, 0);
  g.add(f);
  // inner dark disc behind the holes
  const back = mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.01, 24), mats.chassis, 0.0, 0, 0);
  back.rotation.z = Math.PI / 2;
  g.add(back);
  // centre hub + nuts
  const hub = mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 20), mats.steel, 0.075, 0, 0);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  const cap = mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.03, 16), mats.blackMetal, 0.11, 0, 0);
  cap.rotation.z = Math.PI / 2;
  g.add(cap);
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * Math.PI * 2;
    const nut = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 6), mats.zinc, 0.1, Math.cos(a) * 0.062, Math.sin(a) * 0.062);
    nut.rotation.z = Math.PI / 2;
    g.add(nut);
  }
  return g;
}

// side: -1 left, +1 right (rim face points outward)
function buildWheel(mats, side, deformable) {
  const steer = new THREE.Group();
  const spin = new THREE.Group();
  steer.add(spin);
  const tireMat = deformable ? createTireMaterial(mats.rubberTex) : new THREE.MeshStandardMaterial({ color: 0x2a2a2a, map: mats.rubberTex, roughness: 0.92 });
  const tire = mesh(tireGeometry(), tireMat);
  spin.add(tire);
  const rim = rimGroup(mats);
  mergeStatic(rim);
  if (side < 0) rim.rotation.y = Math.PI;
  spin.add(rim);
  return { steer, spin, tire, tireMat, rim };
}

// helical coil spring of unit height, scaled in y at runtime
function coilGeometry(radius, wire, turns) {
  const pts = [];
  const n = turns * 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, t, Math.sin(a) * radius));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, n, wire, 6, false);
}

// ---------------------------------------------------------------- gauges
function gaugeTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0c0e';
  g.fillRect(0, 0, 1024, 512);
  const dial = (cx, cy, r, max, step, label, red) => {
    g.save();
    g.translate(cx, cy);
    g.fillStyle = '#121418';
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3a3d44'; g.lineWidth = 6; g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    for (let v = 0; v <= max + 1e-6; v += step / 2) {
      const a = a0 + (a1 - a0) * (v / max);
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      g.strokeStyle = red && v >= red ? '#e0362c' : '#e8e8e8';
      g.lineWidth = major ? 6 : 3;
      g.beginPath();
      g.moveTo(Math.cos(a) * (r - 10), Math.sin(a) * (r - 10));
      g.lineTo(Math.cos(a) * (r - (major ? 42 : 26)), Math.sin(a) * (r - (major ? 42 : 26)));
      g.stroke();
      if (major) {
        g.fillStyle = '#e8e8e8';
        g.font = 'bold 40px Helvetica, Arial';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        const lv = label === 'rpm' ? v / 1000 : v;
        g.fillText(String(lv), Math.cos(a) * (r - 78), Math.sin(a) * (r - 78));
      }
    }
    g.fillStyle = '#8a8f98';
    g.font = '28px Helvetica, Arial';
    g.textAlign = 'center';
    g.fillText(label === 'rpm' ? 'x1000 rpm' : 'km/h', 0, r * 0.45);
    g.restore();
  };
  dial(256, 256, 236, 160, 20, 'km/h');
  dial(768, 256, 236, 6000, 1000, 'rpm', 5000);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- main builder
export function buildTruck(P) {
  const mats = createMaterials();
  mats.rubberTex = makeRubberTexture();
  const root = new THREE.Group();
  root.name = 'truck';
  const body = new THREE.Group();
  root.add(body);
  const add = (o, parent = body) => { parent.add(o); return o; };

  // ---------------- lower body
  // engine bay / wings block with the front arch cut out
  const fa = archPoints(ARCH_F, 0.56, 0.56, 1.0);
  add(extrudeProfile([[FRONT, SILL + 0.06], [FRONT, 1.15], [FRONT + 0.04, 1.19], [BULK, 1.21], [BULK, SILL], ...fa, [FRONT + 0.02, SILL + 0.06]], 2 * W2, mats.paint));
  // cabin side panels (thin, so the cockpit is hollow)
  const ra = archPoints(ARCH_R, 0.57, 0.57, 1.0);
  for (const s of [-1, 1]) {
    const side = extrudeProfile([[BULK, SILL], [BULK, BELT + 0.06], [REAR, BELT + 0.06], [REAR, SILL], ...ra], 0.05, mats.paint, 0.012);
    side.position.x = s * (W2 - 0.025);
    add(side);
  }
  add(span(-0.86, 0.86, SILL, SILL + 0.05, BULK, REAR - 0.04, mats.chassis));           // floor
  add(span(-0.87, 0.87, SILL, BELT + 0.06, REAR - 0.05, REAR, mats.paint, 0.012));    // rear lower panel / tailgate
  add(span(-0.86, 0.86, SILL + 0.05, BELT, BULK - 0.03, BULK + 0.01, mats.interior));   // bulkhead
  // bonnet with raised centre
  add(span(-0.66, 0.66, 1.17, 1.245, FRONT + 0.03, BULK - 0.02, mats.paint, 0.03));
  add(span(-0.44, 0.44, 1.2, 1.265, FRONT + 0.1, BULK - 0.06, mats.paint, 0.025));
  // wing-top vents
  for (const s of [-1, 1]) {
    add(span(s * 0.70 - 0.11, s * 0.70 + 0.11, 1.205, 1.225, -1.05, -0.88, mats.black));
    add(span(s * 0.70 - 0.11, s * 0.70 + 0.11, 1.205, 1.225, -1.95, -1.83, mats.black));
  }
  // panel lines, hinges, handles
  for (const s of [-1, 1]) {
    const x = s * (W2 + 0.002);
    for (const z of [-0.77, 0.345, 1.33]) add(span(x - 0.003, x + 0.003, SILL + 0.02, BELT + 0.04, z - 0.004, z + 0.004, mats.black));
    for (const z of [0.15, 1.13]) add(rbox(0.03, 0.035, 0.13, 0.01, mats.black, s * (W2 + 0.012), 1.18, z));
    for (const y of [0.92, 1.2]) add(rbox(0.03, 0.06, 0.05, 0.008, mats.black, s * (W2 + 0.012), y, -0.74));
    add(span(x - 0.003, x + 0.003, BELT + 0.06, ROOF - 0.04, 0.345 - 0.004, 0.345 + 0.004, mats.black));
  }
  // fuel filler (right rear quarter)
  const filler = add(mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 20), mats.black, W2 + 0.01, 1.1, 1.92));
  filler.rotation.z = Math.PI / 2;

  // ---------------- fender flares
  const flare = (zc, rear, front) => {
    const inner = archPoints(zc, rear, front, 1.0);
    const outer = [[zc + rear + 0.1, SILL - 0.02], [zc + rear - 0.02, 1.07], [zc + rear - 0.16, 1.09], [zc - front + 0.16, 1.09], [zc - front + 0.02, 1.07], [zc - front - 0.1, SILL - 0.02]];
    const pts = [...outer.slice().reverse(), ...inner];
    for (const s of [-1, 1]) {
      const f = extrudeProfile(pts, 0.1, mats.black, 0.02);
      f.position.x = s * (W2 + 0.035);
      add(f);
    }
  };
  flare(ARCH_F, 0.56, 0.56);
  flare(ARCH_R, 0.57, 0.57);
  // sill / rock sliders
  for (const s of [-1, 1]) {
    add(bar([s * 0.93, 0.6, ARCH_F + 0.62], [s * 0.93, 0.6, ARCH_R - 0.62], 0.035, mats.blackMetal));
    add(span(s * 0.86, s * 0.95, 0.56, 0.585, ARCH_F + 0.7, ARCH_R - 0.7, mats.blackMetal));
    for (const z of [ARCH_F + 0.7, 0.3, ARCH_R - 0.7]) add(bar([s * 0.93, 0.6, z], [s * 0.8, 0.66, z], 0.025, mats.blackMetal));
  }

  // ---------------- greenhouse
  const greenhouse = new THREE.Group();
  body.add(greenhouse);
  const gh = o => add(o, greenhouse);
  gh(rbox(2 * W2, 0.07, REAR - BULK + 0.06, 0.03, mats.paint, 0, ROOF - 0.03, (REAR + BULK) / 2 - 0.03));
  gh(span(-0.86, 0.86, ROOF - 0.09, ROOF - 0.07, BULK, REAR - 0.04, mats.headliner));
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? W2 - 0.05 : -W2, x1 = s > 0 ? W2 : -W2 + 0.05;
    gh(span(x0, x1, BELT, BELT + 0.07, BULK, REAR, mats.paint));                 // sill under windows
    gh(span(x0, x1, ROOF - 0.12, ROOF - 0.04, BULK, REAR, mats.paint));          // above windows
    for (const [z0, z1] of [[BULK, -0.72], [0.31, 0.40], [1.29, 1.39], [2.28, REAR]]) gh(span(x0, x1, BELT, ROOF - 0.04, z0, z1, mats.paint));
    for (const [z0, z1] of [[-0.72, 0.31], [0.40, 1.29], [1.39, 2.28]]) {
      const g = span(x0 + 0.015 * s, x1 - 0.015 * s, BELT + 0.07, ROOF - 0.12, z0, z1, mats.glass);
      g.castShadow = false;
      gh(g);
    }
  }
  // rear face upper: corner windows + door window
  const rz0 = REAR - 0.05, rz1 = REAR;
  for (const [x0, x1] of [[-0.87, -0.80], [-0.58, -0.40], [0.40, 0.58], [0.80, 0.87]]) gh(span(x0, x1, BELT, ROOF - 0.04, rz0, rz1, mats.paint));
  gh(span(-0.87, 0.87, BELT, BELT + 0.07, rz0, rz1, mats.paint));
  gh(span(-0.87, 0.87, ROOF - 0.12, ROOF - 0.04, rz0, rz1, mats.paint));
  gh(span(-0.40, 0.40, BELT + 0.07, BELT + 0.12, rz0, rz1, mats.paint));
  for (const [x0, x1, y1] of [[-0.80, -0.58, ROOF - 0.12], [0.58, 0.80, ROOF - 0.12], [-0.40, 0.40, ROOF - 0.12]]) {
    const g = span(x0, x1, BELT + 0.07, y1, rz0 + 0.015, rz1 - 0.015, mats.glass); g.castShadow = false; gh(g);
  }
  // third brake light
  const cbl = gh(span(-0.14, 0.14, ROOF - 0.115, ROOF - 0.08, REAR + 0.002, REAR + 0.02, mats.brake));
  // windscreen frame (slight rake)
  const ws = new THREE.Group();
  ws.position.set(0, BELT, BULK);
  ws.rotation.x = -0.09;
  body.add(ws);
  const wsH = ROOF - 0.05 - BELT;
  for (const s of [-1, 1]) add(span(s * 0.80, s * 0.875, 0, wsH, -0.03, 0.04, mats.paint), ws);
  add(span(-0.875, 0.875, 0, 0.06, -0.03, 0.04, mats.paint), ws);
  add(span(-0.875, 0.875, wsH - 0.07, wsH, -0.03, 0.04, mats.paint), ws);
  add(span(-0.03, 0.03, 0.06, wsH - 0.07, -0.02, 0.03, mats.paint), ws);   // split screen centre bar
  const wsg = span(-0.80, 0.80, 0.06, wsH - 0.07, 0.0, 0.01, mats.glass); wsg.castShadow = false; add(wsg, ws);
  // wipers
  for (const x of [-0.45, 0.25]) { const wp = add(bar([x, 0.08, -0.03], [x + 0.36, 0.2, -0.035], 0.008, mats.black), ws); }
  // rear view mirror
  add(rbox(0.2, 0.06, 0.02, 0.01, mats.black, 0, wsH - 0.16, 0.08), ws);

  // ---------------- front end
  add(span(-0.44, 0.44, 0.74, 1.14, FRONT - 0.03, FRONT + 0.01, mats.black));
  for (let k = 0; k < 6; k++) add(span(-0.41, 0.41, 0.78 + k * 0.06, 0.8 + k * 0.06, FRONT - 0.05, FRONT - 0.02, mats.blackMetal));
  add(span(-0.38, 0.38, 0.75, 1.13, FRONT - 0.01, FRONT + 0.01, mats.chassis));
  const lights = { headL: null, headR: null };
  const headLensMeshes = [];
  for (const s of [-1, 1]) {
    add(rbox(0.31, 0.31, 0.05, 0.02, mats.black, s * 0.63, 0.94, FRONT - 0.02));
    const ring = add(mesh(new THREE.TorusGeometry(0.098, 0.014, 8, 28), mats.chrome, s * 0.63, 0.96, FRONT - 0.05));
    const lens = add(mesh(new THREE.CylinderGeometry(0.093, 0.093, 0.03, 28), mats.headLens, s * 0.63, 0.96, FRONT - 0.045));
    lens.rotation.x = Math.PI / 2;
    headLensMeshes.push(lens);
    const ind = add(mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.03, 16), mats.amber, s * 0.75, 0.83, FRONT - 0.045));
    ind.rotation.x = Math.PI / 2;
    const sideRep = add(rbox(0.012, 0.03, 0.06, 0.005, mats.amber, s * (W2 + 0.006), 1.08, -1.0));
  }
  // heavy winch bumper
  add(rbox(1.92, 0.27, 0.24, 0.03, mats.blackMetal, 0, 0.64, FRONT - 0.13));
  for (const s of [-1, 1]) add(rbox(0.22, 0.2, 0.2, 0.03, mats.blackMetal, s * 0.86, 0.68, FRONT - 0.06));
  const winch = add(mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.48, 18), mats.chassis, 0, 0.66, FRONT - 0.2));
  winch.rotation.z = Math.PI / 2;
  add(rbox(0.22, 0.07, 0.04, 0.012, mats.zinc, 0, 0.62, FRONT - 0.265));      // fairlead
  add(rbox(0.04, 0.05, 0.05, 0.01, mats.zinc, 0, 0.6, FRONT - 0.29));
  for (const s of [-1, 1]) {
    const dr = add(mesh(new THREE.TorusGeometry(0.045, 0.012, 8, 16, Math.PI * 1.4), mats.zinc, s * 0.55, 0.54, FRONT - 0.26));
    dr.rotation.set(0, Math.PI / 2, -Math.PI * 0.2);
  }
  // hoop over the winch
  add(bar([-0.42, 0.76, FRONT - 0.18], [-0.38, 0.97, FRONT - 0.2], 0.025, mats.blackMetal));
  add(bar([0.42, 0.76, FRONT - 0.18], [0.38, 0.97, FRONT - 0.2], 0.025, mats.blackMetal));
  add(bar([-0.38, 0.97, FRONT - 0.2], [0.38, 0.97, FRONT - 0.2], 0.025, mats.blackMetal));
  for (const s of [-1, 1]) add(rbox(0.1, 0.03, 0.025, 0.008, mats.amber, s * 0.82, 0.73, FRONT - 0.255));

  // ---------------- rear end
  add(rbox(1.84, 0.21, 0.13, 0.025, mats.blackMetal, 0, 0.66, REAR + 0.06));
  for (const s of [-1, 1]) {
    const dr = add(mesh(new THREE.TorusGeometry(0.045, 0.012, 8, 16, Math.PI * 1.4), mats.zinc, s * 0.5, 0.56, REAR + 0.14));
    dr.rotation.set(0, Math.PI / 2, -Math.PI * 0.2);
    add(rbox(0.12, 0.05, 0.02, 0.008, mats.tail, s * 0.72, 0.7, REAR + 0.13));
    add(rbox(0.06, 0.05, 0.02, 0.008, mats.reverse, s * 0.6, 0.7, REAR + 0.13));
  }
  add(rbox(0.32, 0.1, 0.06, 0.01, mats.blackMetal, 0, 0.64, REAR + 0.16)); // step
  const tailMeshes = [], brakeMeshes = [], revMeshes = [];
  for (const s of [-1, 1]) {
    const x = s * 0.775;
    add(rbox(0.12, 0.34, 0.03, 0.01, mats.black, x, 0.98, REAR + 0.01));
    add(rbox(0.09, 0.07, 0.03, 0.008, mats.amber, x, 1.1, REAR + 0.02));
    tailMeshes.push(add(rbox(0.09, 0.09, 0.03, 0.008, mats.tail, x, 1.0, REAR + 0.02)));
    brakeMeshes.push(add(rbox(0.09, 0.08, 0.03, 0.008, mats.brake, x, 0.895, REAR + 0.02)));
  }
  // spare wheel on the rear door
  const spare = buildWheel(mats, 1, false);
  spare.steer.position.set(0, 1.13, REAR + 0.26);
  spare.steer.rotation.y = -Math.PI / 2;
  add(spare.steer);
  add(rbox(0.3, 0.3, 0.12, 0.02, mats.blackMetal, 0, 1.13, REAR + 0.07));
  add(rbox(0.14, 0.04, 0.03, 0.01, mats.black, 0.5, 1.25, REAR + 0.02));   // handle

  // ---------------- mirrors
  for (const s of [-1, 1]) {
    add(bar([s * 0.88, 1.36, -0.7], [s * 1.0, 1.44, -0.72], 0.014, mats.black));
    add(rbox(0.05, 0.19, 0.14, 0.02, mats.black, s * 1.03, 1.47, -0.73));
    const mg = add(span(s * 1.03 - 0.02, s * 1.03 + 0.02, 1.39, 1.555, -0.67, -0.66, mats.chrome));
  }

  // ---------------- snorkel (right side, up the A pillar)
  {
    const pts = [[0.84, 1.16, -1.02], [0.93, 1.2, -0.98], [0.96, 1.32, -0.86], [0.965, 1.6, -0.82], [0.965, 1.9, -0.8], [0.96, 2.04, -0.82]].map(p => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts);
    add(mesh(new THREE.TubeGeometry(curve, 40, 0.048, 12, false), mats.black));
    add(rbox(0.13, 0.12, 0.2, 0.03, mats.black, 0.955, 2.07, -0.86));
    add(span(0.92, 0.99, 2.03, 2.11, -0.965, -0.955, mats.chassis));
    for (const y of [1.45, 1.8]) add(bar([0.965, y, -0.81], [0.88, y, -0.78], 0.012, mats.black));
  }

  // ---------------- roof rack + light bar
  const rack = new THREE.Group();
  body.add(rack);
  const rk = o => add(o, rack);
  const rx = 0.82, ry0 = ROOF + 0.07, ry1 = ROOF + 0.21, kz0 = -0.98, kz1 = 2.3;
  const rr = 0.018;
  for (const s of [-1, 1]) {
    rk(bar([s * rx, ry0, kz0], [s * rx, ry0, kz1], rr, mats.blackMetal));
    rk(bar([s * (rx - 0.02), ry1, kz0 + 0.05], [s * (rx - 0.02), ry1, kz1], rr, mats.blackMetal));
    for (let k = 0; k <= 7; k++) {
      const z = kz0 + 0.05 + (kz1 - kz0 - 0.05) * k / 7;
      rk(bar([s * rx, ry0, z], [s * (rx - 0.02), ry1, z], rr * 0.85, mats.blackMetal));
    }
    for (const z of [-0.6, 0.4, 1.4, 2.2]) {
      rk(span(s * 0.84, s * 0.88, ROOF - 0.01, ry0, z - 0.03, z + 0.03, mats.blackMetal));
    }
  }
  for (let k = 0; k <= 9; k++) {
    const z = kz0 + (kz1 - kz0) * k / 9;
    rk(bar([-rx, ry0, z], [rx, ry0, z], rr * 0.9, mats.blackMetal));
  }
  rk(bar([-(rx - 0.02), ry1, kz0 + 0.05], [rx - 0.02, ry1, kz0 + 0.05], rr, mats.blackMetal));
  rk(bar([-(rx - 0.02), ry1, kz1], [rx - 0.02, ry1, kz1], rr, mats.blackMetal));
  for (const z of [0.2, 1.2]) rk(bar([-rx, ry0 + 0.005, z], [rx, ry0 + 0.005, z], rr * 0.8, mats.blackMetal));
  // front light bar: 4 square lamps
  const barLensMeshes = [];
  rk(bar([-0.7, ry1 + 0.02, kz0 - 0.02], [0.7, ry1 + 0.02, kz0 - 0.02], 0.02, mats.blackMetal));
  for (const x of [-0.52, -0.24, 0.24, 0.52]) {
    rk(rbox(0.16, 0.13, 0.09, 0.015, mats.black, x, ry1 + 0.06, kz0 - 0.05));
    const l = rk(rbox(0.13, 0.1, 0.02, 0.01, mats.barLens, x, ry1 + 0.06, kz0 - 0.1));
    barLensMeshes.push(l);
  }
  rk(rbox(0.12, 0.06, 0.08, 0.015, mats.amber, 0, ry1 + 0.04, kz0 - 0.04));   // small beacon
  for (const s of [-1, 1]) {
    rk(rbox(0.1, 0.08, 0.07, 0.012, mats.black, s * 0.7, ry1 + 0.04, kz1 + 0.02));
    rk(rbox(0.08, 0.06, 0.02, 0.008, mats.workLens, s * 0.7, ry1 + 0.04, kz1 + 0.06));
  }

  // ---------------- chassis + underbody
  for (const s of [-1, 1]) add(span(s * 0.38 - 0.05, s * 0.38 + 0.05, 0.47, 0.62, FRONT + 0.05, REAR, mats.chassis));
  for (const z of [-1.95, -0.6, 0.6, 1.9]) add(span(-0.38, 0.38, 0.5, 0.6, z - 0.04, z + 0.04, mats.chassis));
  add(span(-0.3, 0.3, 0.42, 0.7, -0.75, 0.1, mats.chassis, 0.04));   // gearbox
  add(span(-0.18, 0.28, 0.4, 0.62, 0.1, 0.5, mats.chassis, 0.04));   // transfer case
  add(span(-0.32, 0.32, 0.55, 1.12, -1.95, -0.85, mats.chassis, 0.05)); // engine block
  add(span(0.35, 0.82, 0.5, 0.64, 1.6, 2.2, mats.chassis, 0.03));      // fuel tank
  add(bar([-0.48, 0.5, -0.8], [-0.52, 0.48, 2.42], 0.03, mats.zinc));  // exhaust

  // ---------------- interior (left hand drive)
  const DX = -0.40;
  add(span(-0.86, 0.86, 1.0, BELT + 0.04, BULK, BULK + 0.32, mats.dash, 0.03));
  add(span(-0.86, 0.86, BELT - 0.02, BELT + 0.02, BULK, BULK + 0.36, mats.dash, 0.015));
  const binn = add(span(DX - 0.22, DX + 0.22, BELT + 0.0, BELT + 0.17, BULK + 0.2, BULK + 0.34, mats.dash, 0.03));
  add(span(DX - 0.23, DX + 0.23, BELT + 0.16, BELT + 0.19, BULK + 0.2, BULK + 0.42, mats.dash, 0.012));   // hood over the gauges
  const gaugeMat = new THREE.MeshStandardMaterial({ map: gaugeTexture(), roughness: 0.5, emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0 });
  gaugeMat.emissiveMap = gaugeMat.map;
  const gauge = add(mesh(new THREE.PlaneGeometry(0.38, 0.19), gaugeMat, DX, BELT + 0.08, BULK + 0.345));
  gauge.rotation.x = -0.1;
  const needleMat = new THREE.MeshStandardMaterial({ color: 0xff5a2a, emissive: 0xff3a10, emissiveIntensity: 0.4 });
  const needleGeo = new THREE.BoxGeometry(0.004, 0.07, 0.002); needleGeo.translate(0, 0.035, 0);
  const needles = {};
  for (const [k, xo] of [['speed', -0.095], ['rpm', 0.095]]) {
    const pivot = new THREE.Group();
    pivot.position.set(xo, 0, 0.004);
    pivot.add(new THREE.Mesh(needleGeo, needleMat));
    gauge.add(pivot);
    needles[k] = pivot;
  }
  // steering wheel
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(DX, 1.2, -0.4);
  steeringWheel.rotation.x = -0.62;
  body.add(steeringWheel);
  const swRot = new THREE.Group();
  steeringWheel.add(swRot);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 10, 40), mats.dash);
  rim.castShadow = true;
  swRot.add(rim);
  for (const a of [Math.PI / 2 + 0.0, Math.PI * 7 / 6, -Math.PI / 6]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.025, 0.012), mats.dash);
    sp.position.set(Math.cos(a) * 0.09, Math.sin(a) * 0.09, -0.01);
    sp.rotation.z = a;
    swRot.add(sp);
  }
  swRot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.05, 16).rotateX(Math.PI / 2), mats.dash));
  add(bar([DX, 1.22, -0.45], [DX, 1.1, -0.68], 0.03, mats.dash));
  // console + levers
  add(span(-0.13, 0.13, SILL + 0.05, 1.02, BULK + 0.2, 0.2, mats.dash, 0.02));
  const gearLever = new THREE.Group();
  gearLever.position.set(-0.07, 1.0, -0.2);
  body.add(gearLever);
  gearLever.add(mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.22, 8).translate(0, 0.11, 0), mats.chrome));
  gearLever.add(mesh(new THREE.SphereGeometry(0.025, 12, 10), mats.dash, 0, 0.23, 0));
  const transferLever = new THREE.Group();
  transferLever.position.set(0.05, 1.0, -0.12);
  body.add(transferLever);
  transferLever.add(mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.16, 8).translate(0, 0.08, 0), mats.chrome));
  transferLever.add(mesh(new THREE.SphereGeometry(0.02, 12, 10), mats.tail, 0, 0.17, 0));
  // seats
  for (const x of [-0.42, 0.42]) {
    add(span(x - 0.25, x + 0.25, 0.86, 1.0, -0.1, 0.42, mats.seat, 0.04));
    const back = add(rbox(0.5, 0.66, 0.12, 0.05, mats.seat, x, 1.32, 0.46));
    back.rotation.x = -0.18;
    add(rbox(0.26, 0.17, 0.1, 0.04, mats.seat, x, 1.74, 0.55));
  }
  add(span(-0.82, 0.82, 0.86, 1.0, 0.9, 1.45, mats.seat, 0.04));
  const rb = add(rbox(1.64, 0.62, 0.12, 0.05, mats.seat, 0, 1.3, 1.5)); rb.rotation.x = -0.15;
  for (const s of [-1, 1]) add(span(s * 0.84 - 0.015, s * 0.84 + 0.015, 0.75, BELT, BULK + 0.05, 1.3, mats.interior));

  // ---------------- axles, suspension, wheels
  const wheels = [];
  const axles = [];
  const suspension = [];
  const t2 = P.track / 2;
  for (let ai = 0; ai < 2; ai++) {
    const ap = P.axles[ai];
    const axle = new THREE.Group();
    axle.position.set(0, ap.droopY, ap.z);
    root.add(axle);
    // housing
    add(bar([-t2 + 0.12, 0, 0], [t2 - 0.12, 0, 0], 0.05, mats.chassis, 12), axle);
    const diffX = ai === 0 ? 0.12 : 0;
    const diff = add(mesh(new THREE.SphereGeometry(0.15, 16, 12), mats.chassis, diffX, 0, 0), axle);
    diff.scale.set(1, 0.9, 0.75);
    add(mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.14, 12).rotateX(Math.PI / 2), mats.chassis, diffX, 0.0, ai === 0 ? 0.15 : -0.15), axle);
    for (const s of [-1, 1]) {
      const hub = add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 16), mats.chassis, s * (t2 - 0.17), 0, 0), axle);
      hub.rotation.z = Math.PI / 2;
      add(span(s * (ap.springTrack / 2) - 0.08, s * (ap.springTrack / 2) + 0.08, 0.04, 0.07, -0.08, 0.08, mats.chassis), axle);
    }
    axles.push(axle);
    // springs + shocks live in the body frame and get stretched each frame
    for (const s of [-1, 1]) {
      const sx = s * ap.springTrack / 2;
      const topY = ap.droopY + ap.travel + 0.36;
      const coil = add(mesh(coilGeometry(0.085, 0.014, 7), mats.blackMetal), root);
      add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 16), mats.chassis, sx, topY, ap.z), root);
      const shockX = s * (ap.springTrack / 2 + 0.16);
      const shockZ = ap.z + (ai === 0 ? 0.12 : -0.12);
      const shockBody = add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 12).translate(0, -0.15, 0), mats.yellow), root);
      const shockRod = add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 8).translate(0, 0.16, 0), mats.chrome), root);
      suspension.push({ ai, s, coil, sx, topY, shockBody, shockRod, shockX, shockZ, shockTop: topY + 0.02 });
    }
    // links: radius arms (front) / trailing links (rear) from chassis pivots to the axle
    const links = [];
    for (const s of [-1, 1]) {
      const link = add(mesh(new THREE.BoxGeometry(0.06, 0.06, 1), mats.chassis), root);
      links.push({ link, s, pivot: new THREE.Vector3(s * 0.4, 0.5, ap.z + (ai === 0 ? 1.05 : -1.05)), end: new THREE.Vector3(s * 0.45, -0.06, 0) });
    }
    axle.userData.links = links;
    // panhard / A-frame
    const pan = add(mesh(new THREE.BoxGeometry(1, 0.04, 0.04), mats.chassis), root);
    axle.userData.panhard = { mesh: pan, bodyEnd: new THREE.Vector3(-0.45, 0.62, ap.z + (ai === 0 ? 0.22 : -0.22)), axleEnd: new THREE.Vector3(0.55, 0.06, ai === 0 ? 0.22 : -0.22) };

    for (const s of [-1, 1]) {
      const w = buildWheel(mats, s, true);
      w.steer.position.set(s * t2, 0, 0);
      w.steer.userData.isWheel = true;
      axle.add(w.steer);
      w.side = s;
      w.axle = ai;
      wheels.push(w);
    }
    if (ai === 0) {
      const tie = add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 8), mats.chassis), axle);
      tie.rotation.z = Math.PI / 2;
      tie.position.set(0, -0.05, 0.16);
      tie.scale.y = 2 * t2 - 0.3;
      axle.userData.tie = tie;
    }
  }
  // prop shafts
  const props = [];
  for (let ai = 0; ai < 2; ai++) {
    const m = add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 10), mats.zinc), root);
    props.push(m);
  }

  // ---------------- merge static geometry
  const dynamic = new Set([steeringWheel, gearLever, transferLever, gauge]);
  mergeStatic(body, o => dynamic.has(o));
  for (const ax of axles) mergeStatic(ax, o => o.userData.isWheel || o === ax.userData.tie);

  // ---------------- lights
  const lightRig = {};
  const mkSpot = (color, intensity, angle, penumbra, dist, x, y, z, tx, ty, tz, shadow) => {
    const L = new THREE.SpotLight(color, 0, dist, angle, penumbra, 1.6);
    L.position.set(x, y, z);
    L.target.position.set(tx, ty, tz);
    root.add(L); root.add(L.target);
    L.userData.on = intensity;
    if (shadow) {
      L.castShadow = true;
      L.shadow.mapSize.set(1024, 1024);
      L.shadow.bias = -0.0004;
      L.shadow.normalBias = 0.03;
      L.shadow.camera.near = 0.3;
      L.shadow.camera.far = dist;
    }
    return L;
  };
  lightRig.headL = mkSpot(0xfff1dc, 260, 0.55, 0.55, 80, -0.63, 0.96, FRONT - 0.1, -0.9, 0.2, FRONT - 20, true);
  lightRig.headR = mkSpot(0xfff1dc, 260, 0.55, 0.55, 80, 0.63, 0.96, FRONT - 0.1, 0.9, 0.2, FRONT - 20, true);
  lightRig.bar = mkSpot(0xeef4ff, 700, 0.75, 0.45, 140, 0, ry1 + 0.06, kz0 - 0.15, 0, -2.0, kz0 - 40, true);
  lightRig.reverse = mkSpot(0xffffff, 60, 0.9, 0.7, 25, 0, 0.75, REAR + 0.2, 0, 0.0, REAR + 10, false);
  for (const s of [-1, 1]) {
    const tl = new THREE.PointLight(0xff2010, 0, 6, 2);
    tl.position.set(s * 0.78, 0.98, REAR + 0.15);
    root.add(tl);
    lightRig[s < 0 ? 'tailL' : 'tailR'] = tl;
  }
  const cabinLight = new THREE.PointLight(0xffd8a0, 0, 1.6, 2);
  cabinLight.position.set(DX, BELT + 0.2, BULK + 0.45);
  root.add(cabinLight);
  lightRig.dash = cabinLight;

  root.traverse(o => { if (o.isMesh) o.frustumCulled = true; });

  return {
    root, body, wheels, axles, suspension, props, mats, lights: lightRig, needles, gaugeMat,
    steeringWheel: swRot, gearLever, transferLever, spare,
    driverEye: new THREE.Vector3(DX, 1.63, 0.18),
  };
}
