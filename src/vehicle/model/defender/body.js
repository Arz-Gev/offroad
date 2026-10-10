import * as THREE from 'three';
import { D } from './dims.js';
import {
  mesh, rbox, span, bar, pipe, extrudeProfile, extrudeFront, extrudePlan, extrudeShape,
  plate, frame, rrPath, polyShape, polyPath, warpGroup, tumblehome,
} from '../geom.js';

// Exterior of the Defender 110 station wagon (reference.webp).

const AH = 0.56, AT = 0.34, ATOP = D.ARCH_TOP;
// squared Defender arch, traversed from the rear base to the front base (z decreasing)
const arch = (zc, yRear, yFront, hb = AH) => [
  [zc + hb, yRear], [zc + hb - 0.035, ATOP - 0.17], [zc + AT, ATOP], [zc - AT, ATOP], [zc - hb + 0.035, ATOP - 0.17], [zc - hb, yFront],
];
const archOuter = (zc, yRear, yFront, hb = AH, g = 0.1) => [
  [zc + hb + g + 0.01, yRear - 0.02], [zc + hb + g * 0.62, ATOP - 0.13], [zc + AT + g * 0.7, ATOP + g * 1.05],
  [zc - AT - g * 0.7, ATOP + g * 1.05], [zc - hb - g * 0.62, ATOP - 0.13], [zc - hb - g - 0.01, yFront - 0.02],
];

export function buildExterior(mats, body) {
  const { W, WG, SILL, WAIST, EAVE, ROOF, FRONT, REAR, SCREEN, ARCH_F, ARCH_R } = D;
  const add = (o, p = body) => { p.add(o); return o; };
  const sides = [-1, 1];
  const out = { headLens: [], anchors: {} };

  // ------------------------------------------------------------------ lower body
  // engine bay / wings: solid block across the full width with the front arch cut out
  add(extrudeProfile([
    [FRONT, 0.80], [FRONT, 1.335], [FRONT + 0.04, 1.378], [SCREEN - 0.012, 1.383], [SCREEN - 0.012, SILL],
    ...arch(ARCH_F, SILL, 0.80), [FRONT + 0.02, 0.80],
  ], 2 * W, mats.paint, 0.022));
  // cabin + rear body sides (thin skins: the cabin is hollow)
  for (const s of sides) {
    const p = extrudeProfile([
      [SCREEN - 0.012, SILL], [SCREEN - 0.012, WAIST], [REAR - 0.012, WAIST], [REAR, WAIST - 0.012], [REAR, 0.70], [REAR - 0.03, 0.68],
      ...arch(ARCH_R, 0.68, SILL, 0.57),
    ], 0.04, mats.paint, 0.01);
    p.position.x = s * (W - 0.02);
    add(p);
  }
  // rear lower face, floor, bulkhead
  add(span(-W, W, 0.70, WAIST, REAR - 0.04, REAR, mats.paint, 0.012));
  // floor (kept clear of the rear wheel wells)
  for (const [x, z0, z1] of [[W - 0.03, SCREEN, ARCH_R - 0.6], [0.55, ARCH_R - 0.6, ARCH_R + 0.6], [W - 0.03, ARCH_R + 0.6, REAR - 0.03]]) {
    add(span(-x, x, SILL, D.FLOOR - 0.012, z0, z1, mats.chassis));
    add(span(-x + 0.01, x - 0.01, D.FLOOR - 0.012, D.FLOOR, z0, z1, mats.carpet));
  }
  add(span(-W + 0.03, W - 0.03, D.FLOOR, WAIST - 0.01, SCREEN - 0.012, SCREEN + 0.02, mats.cabinPaint));
  // waist capping: the greenhouse sits inboard of the lower body, the ledge reads as the belt line
  for (const s of sides) add(span(s * (WG - 0.01), s * (W + 0.004), WAIST - 0.004, WAIST + 0.01, SCREEN + 0.01, REAR - 0.006, mats.paint, 0.005));
  add(span(-W - 0.002, W + 0.002, WAIST - 0.004, WAIST + 0.012, REAR - 0.05, REAR + 0.006, mats.paint, 0.006));

  // inner wheel wells (black), so the arches don't look into a hollow body
  const well = (zc, hb, yRear, yFront, x0, x1) => {
    // liner just inside the opening: it hides the painted cut faces of the body around the arch
    const outer = arch(zc, yRear, yFront, hb).map(([z, y]) => [z - Math.sign(z - zc) * 0.004, y === yRear || y === yFront ? y : y - 0.004]);
    const inner = outer.map(([z, y]) => [z - Math.sign(z - zc) * 0.02, y === yRear || y === yFront ? y : y - 0.02]);
    for (const s of sides) {
      const roofP = extrudeProfile([...outer, ...inner.slice().reverse()], x1 - x0, mats.chassis, 0);
      roofP.position.x = s * (x0 + x1) / 2;
      add(roofP);
      const wall = extrudeProfile([...arch(zc, yRear, yFront, hb), [zc - hb, yFront - 0.02], [zc + hb, yRear - 0.02]], 0.012, mats.chassis, 0);
      wall.position.x = s * x0;
      add(wall);
    }
  };
  well(ARCH_F, AH, SILL, 0.80, 0.47, W + 0.002);
  well(ARCH_R, 0.57, 0.68, SILL, 0.56, W + 0.002);

  // ------------------------------------------------------------------ bonnet + wing tops
  const BON_Y = 1.383;
  add(span(-0.645, 0.645, BON_Y - 0.004, BON_Y + 0.014, FRONT + 0.035, SCREEN - 0.045, mats.paint, 0.007));
  // raised centre section: trapezoid, wider at the screen
  {
    const pts = [[-0.50, SCREEN - 0.075], [0.50, SCREEN - 0.075], [0.37, FRONT + 0.085], [-0.37, FRONT + 0.085]];
    const raised = extrudePlan(pts, 0.036, mats.paint, 0.018);
    raised.position.y = BON_Y + 0.006;
    add(raised);
  }
  for (const s of sides) add(span(s * 0.6465 - 0.003, s * 0.6465 + 0.003, BON_Y - 0.006, BON_Y + 0.008, FRONT + 0.03, SCREEN - 0.04, mats.seal));
  add(span(-0.647, 0.647, BON_Y - 0.006, BON_Y + 0.008, SCREEN - 0.046, SCREEN - 0.04, mats.seal));
  // louvred wing vents (front) and small bonnet vents (by the screen)
  const vent = (x0, x1, z0, z1, n) => {
    add(span(x0, x1, BON_Y - 0.003, BON_Y + 0.006, z0, z1, mats.black, 0.003));
    for (let k = 0; k < n; k++) {
      const z = z0 + (z1 - z0) * (k + 0.5) / n;
      add(span(x0 + 0.012, x1 - 0.012, BON_Y + 0.004, BON_Y + 0.014, z - 0.008, z + 0.008, mats.black, 0.003));
    }
  };
  for (const s of sides) {
    vent(s * 0.672, s * 0.848, -1.71, -1.32, 9);
    vent(s * 0.548, s * 0.626, -1.02, -0.90, 3);
  }

  // ------------------------------------------------------------------ front face
  const FZ = FRONT;
  // grille: black frame, dark backing, horizontal slats
  add(frame(-0.425, 0.85, 0.425, 1.185, 0.02, 0.04, 0.03, mats.black)).position.z = FZ - 0.012;
  add(span(-0.43, 0.43, 0.845, 1.19, FZ - 0.004, FZ + 0.01, mats.seal));
  for (let k = 0; k < 6; k++) add(span(-0.418, 0.418, 0.873 + k * 0.054, 0.897 + k * 0.054, FZ - 0.026, FZ - 0.004, mats.black, 0.004));
  add(span(-0.06, 0.06, 1.03, 1.06, FZ - 0.03, FZ - 0.02, mats.zinc, 0.006)); // badge
  for (const s of sides) {
    const bz = plate(-0.19, -0.175, 0.19, 0.175, 0.035, 0.03, mats.black);
    bz.position.set(s * 0.675, 1.005, FZ - 0.012);
    add(bz);
    const hx = s * 0.635, hy = 1.005;
    const ring = add(mesh(new THREE.TorusGeometry(0.094, 0.013, 10, 32), mats.chrome, hx, hy, FZ - 0.034));
    ring.castShadow = false;
    const lensGeo = new THREE.SphereGeometry(0.2, 32, 6, 0, Math.PI * 2, 0, 0.455);
    lensGeo.rotateX(-Math.PI / 2);
    lensGeo.translate(0, 0, 0.2 * Math.cos(0.455));
    const lens = add(mesh(lensGeo, mats.headLens, hx, hy, FZ - 0.03));
    lens.castShadow = false;
    out.headLens.push(lens);
    // side light (clear) above the indicator (amber), outboard of the headlamp
    for (const [y, m, r] of [[1.10, mats.sideLens, 0.026], [0.905, mats.amber, 0.03]]) {
      add(mesh(new THREE.TorusGeometry(r + 0.004, 0.005, 6, 20), mats.chrome, s * 0.795, y, FZ - 0.03)).castShadow = false;
      const l = add(mesh(new THREE.CylinderGeometry(r, r, 0.02, 20).rotateX(Math.PI / 2), m, s * 0.795, y, FZ - 0.028));
      l.castShadow = false;
    }
  }

  // ------------------------------------------------------------------ front winch bumper
  {
    const bp = extrudePlan([[-0.985, FZ + 0.05], [-0.985, FZ - 0.07], [-0.86, FZ - 0.225], [0.86, FZ - 0.225], [0.985, FZ - 0.07], [0.985, FZ + 0.05]], 0.23, mats.blackMetal, 0.016);
    bp.position.y = 0.555;
    add(bp);
    add(span(-0.30, 0.30, 0.77, 0.79, FZ - 0.20, FZ - 0.02, mats.seal));
    const drum = add(mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.46, 20).rotateZ(Math.PI / 2), mats.chassis, 0, 0.80, FZ - 0.11));
    for (const s of sides) add(mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 20).rotateZ(Math.PI / 2), mats.blackMetal, s * 0.255, 0.80, FZ - 0.11));
    drum.castShadow = true;
    add(rbox(0.26, 0.09, 0.035, 0.012, mats.zinc, 0, 0.665, FZ - 0.238));
    add(rbox(0.17, 0.022, 0.02, 0.008, mats.seal, 0, 0.665, FZ - 0.254));
    add(pipe([[-0.43, 0.785, FZ - 0.17], [-0.35, 0.91, FZ - 0.19], [0.35, 0.91, FZ - 0.19], [0.43, 0.785, FZ - 0.17]], 0.024, mats.blackMetal, 0.07, 10));
    for (const s of sides) {
      const x = s * 0.445;
      add(rbox(0.032, 0.09, 0.07, 0.008, mats.blackMetal, x, 0.56, FZ - 0.21));
      const bow = add(mesh(new THREE.TorusGeometry(0.04, 0.011, 8, 20, Math.PI * 1.32), mats.zinc, x, 0.505, FZ - 0.238));
      bow.rotation.z = Math.PI * 1.5 - Math.PI * 0.66;
      add(bar([x - 0.042, 0.535, FZ - 0.238], [x + 0.042, 0.535, FZ - 0.238], 0.009, mats.zinc, 8));
      add(mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 8).rotateZ(Math.PI / 2), mats.zinc, x + 0.05, 0.535, FZ - 0.238));
    }
    for (const s of sides) add(rbox(0.09, 0.03, 0.02, 0.008, mats.amber, s * 0.86, 0.73, FZ - 0.205)).castShadow = false;
  }

  // ------------------------------------------------------------------ flares, sliders, mud flaps
  const flare = (zc, hb, yRear, yFront, x) => {
    const inner = arch(zc, yRear, yFront, hb);
    const outer = archOuter(zc, yRear, yFront, hb);
    for (const s of sides) {
      const f = extrudeProfile([...outer, ...inner.slice().reverse()], 0.085, mats.black, 0.016);
      f.position.x = s * x;
      add(f);
      const lip = extrudeProfile([...archOuter(zc, yRear, yFront, hb, 0.035), ...inner.slice().reverse()], 0.03, mats.black, 0.008);
      lip.position.x = s * (x + 0.045);
      add(lip);
    }
  };
  flare(ARCH_F, AH, SILL, 0.80, W + 0.02);
  flare(ARCH_R, 0.57, 0.68, SILL, W + 0.02);
  for (const s of sides) {
    const x = s * 0.925, z0 = ARCH_F + 0.64, z1 = ARCH_R - 0.64;
    add(pipe([[s * 0.86, 0.545, z0 - 0.05], [x, 0.545, z0 + 0.06], [x, 0.545, z1 - 0.06], [s * 0.86, 0.545, z1 + 0.05]], 0.032, mats.blackMetal, 0.08, 10));
    add(span(s * 0.82, s * 0.94, 0.57, 0.59, z0 + 0.08, z1 - 0.08, mats.blackMetal, 0.008));
    for (let k = 0; k < 7; k++) add(span(s * 0.83, s * 0.93, 0.589, 0.594, z0 + 0.14 + k * 0.2, z0 + 0.2 + k * 0.2, mats.black)); // grip strips
    for (const z of [z0 + 0.2, 0.0, z1 - 0.2]) add(bar([x, 0.545, z], [s * 0.47, 0.56, z], 0.022, mats.blackMetal, 8));
    const mf = add(rbox(0.25, 0.34, 0.012, 0.01, mats.rubber, s * 0.79, 0.45, ARCH_R + 0.62));
    mf.castShadow = true;
  }

  // ------------------------------------------------------------------ body-side details
  const seam = (x, y0, y1, z0, z1) => add(span(x - 0.0015, x + 0.0025 * Math.sign(x), y0, y1, z0, z1, mats.seal));
  for (const s of sides) {
    const x = s * (W + 0.0005);
    seam(x, SILL + 0.03, WAIST - 0.01, -0.688, -0.682);               // front door front edge
    seam(x, SILL + 0.03, WAIST - 0.01, 0.227, 0.233);                 // B pillar
    seam(x, ATOP + 0.115, WAIST - 0.01, 0.972, 0.978);                // rear door rear edge
    seam(x, 0.692, 0.698, -0.688, 0.978);                             // door bottoms
    // hinges: front doors on the A pillar, rear doors on the B pillar
    for (const z of [-0.705, 0.245]) for (const y of [0.86, 1.22]) {
      add(rbox(0.026, 0.075, 0.06, 0.008, mats.paint, s * (W + 0.012), y, z));
      add(mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.085, 8), mats.paint, s * (W + 0.026), y, z));
    }
    for (const z of [0.115, 0.86]) {
      add(rbox(0.022, 0.04, 0.15, 0.01, mats.black, s * (W + 0.011), 1.165, z));
      add(rbox(0.012, 0.022, 0.11, 0.008, mats.seal, s * (W + 0.02), 1.158, z));
    }
    add(mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.02, 10).rotateZ(Math.PI / 2), mats.zinc, s * (W + 0.008), 1.12, 0.17));
    add(rbox(0.012, 0.026, 0.065, 0.006, mats.amber, s * (W + 0.006), 1.22, -1.62)).castShadow = false;
  }
  // fuel filler flap (right rear quarter)
  add(rbox(0.02, 0.15, 0.135, 0.02, mats.black, W + 0.008, 1.12, 2.0));
  add(mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.014, 18).rotateZ(Math.PI / 2), mats.blackMetal, W + 0.02, 1.12, 2.0));

  // ------------------------------------------------------------------ greenhouse (tumblehome)
  const gh = new THREE.Group();
  body.add(gh);
  const g = o => add(o, gh);
  const pz = D.pillarZ;
  const winY0 = 1.445, winY1 = 1.885;
  const windows = [
    [[pz(winY0) + 0.085, winY0], [0.135, winY0], [0.135, winY1], [pz(winY1) + 0.085, winY1]],
    [[0.335, winY0], [0.895, winY0], [0.895, winY1], [0.335, winY1]],
    [[1.135, winY0], [2.105, winY0], [2.105, winY1], [1.135, winY1]],
  ];
  const grow = (poly, d) => {
    // grow a convex quad (z, y) by d along each edge normal
    const n = poly.length, outP = [];
    const cz = poly.reduce((a, p) => a + p[0], 0) / n, cy = poly.reduce((a, p) => a + p[1], 0) / n;
    for (let i = 0; i < n; i++) {
      const p = poly[i], a = poly[(i - 1 + n) % n], c = poly[(i + 1) % n];
      const e1 = new THREE.Vector2(p[0] - a[0], p[1] - a[1]).normalize(), e2 = new THREE.Vector2(c[0] - p[0], c[1] - p[1]).normalize();
      let n1 = new THREE.Vector2(e1.y, -e1.x), n2 = new THREE.Vector2(e2.y, -e2.x);
      if (n1.dot(new THREE.Vector2(p[0] - cz, p[1] - cy)) < 0) { n1.negate(); n2.negate(); }
      const m = n1.clone().add(n2).normalize();
      const k = d / Math.max(0.3, m.dot(n1));
      outP.push([p[0] + m.x * k, p[1] + m.y * k]);
    }
    return outP;
  };
  for (const s of sides) {
    // side panel with the window openings
    const panel = extrudeShape(
      (() => { const sh = polyShape([[pz(WAIST), WAIST], [REAR, WAIST], [REAR, EAVE], [pz(EAVE), EAVE]], 0.0); for (const w of windows) sh.holes.push(polyPath(w, 0.035)); return sh; })(),
      0.035, mats.paint, 'zy', 0.008);
    panel.position.x = s * (WG - 0.0175);
    g(panel);
    for (const [wi, w] of windows.entries()) {
      // rubber seal + glass (front door glass lighter so the driver can see out)
      const seal = extrudeShape((() => { const sh = polyShape(grow(w, 0.022), 0.05); sh.holes.push(polyPath(w, 0.035)); return sh; })(), 0.014, mats.seal, 'zy', 0.004);
      seal.position.x = s * (WG + 0.002);
      g(seal);
      const gl = extrudeShape(polyShape(grow(w, 0.006), 0.04), 0.006, wi === 0 ? mats.glassClear : mats.glass, 'zy', 0);
      gl.position.x = s * (WG - 0.012);
      gl.castShadow = false;
      g(gl);
    }
    // slider bar in the rear door glass, split bar in the rear side window
    for (const z of [0.615, 1.62]) g(span(s * (WG - 0.016), s * (WG - 0.004), winY0, winY1, z - 0.012, z + 0.012, mats.seal));
    // door shut lines in the upper body
    const x = s * (WG + 0.0005);
    g(span(x - 0.0015, x + 0.002 * s, WAIST, EAVE - 0.015, 0.227, 0.233, mats.seal));
    g(span(x - 0.0015, x + 0.002 * s, WAIST, EAVE - 0.015, 0.972, 0.978, mats.seal));
    g(span(x - 0.0015, x + 0.002 * s, EAVE - 0.018, EAVE - 0.012, pz(EAVE) + 0.02, 0.978, mats.seal));
    g(span(s * (WG - 0.004), s * (WG + 0.018), EAVE - 0.004, EAVE + 0.014, pz(EAVE) - 0.03, REAR - 0.002, mats.paint, 0.005));
  }
  // roof: chamfered edges carry the alpine windows
  const CH = 0.085;
  {
    const sec = [[-WG, EAVE - 0.012], [WG, EAVE - 0.012], [WG, EAVE], [WG - CH, ROOF], [-(WG - CH), ROOF], [-WG, EAVE]];
    const z0 = pz(EAVE) - 0.045, z1 = REAR + 0.004;
    const roof = extrudeFront(sec, z1 - z0, mats.paint, 0.012);
    roof.position.z = (z0 + z1) / 2;
    g(roof);
    for (const x of [-0.42, 0, 0.42]) g(rbox(0.05, 0.016, z1 - z0 - 0.25, 0.007, mats.paint, x, ROOF + 0.004, (z0 + z1) / 2 + 0.06));
    const nx = (ROOF - EAVE) / Math.hypot(CH, ROOF - EAVE), ny = CH / Math.hypot(CH, ROOF - EAVE);
    for (const s of sides) {
      for (const [za, zb] of [[-0.36, 0.10], [0.36, 0.86], [1.18, 2.08]]) {
        const t0 = 0.16, t1 = 0.86;
        const p0 = [WG - CH * t0, EAVE + (ROOF - EAVE) * t0], p1 = [WG - CH * t1, EAVE + (ROOF - EAVE) * t1];
        const o = 0.004;
        const q = [[p0[0] + nx * o, p0[1] + ny * o], [p0[0] + nx * (o + 0.006), p0[1] + ny * (o + 0.006)], [p1[0] + nx * (o + 0.006), p1[1] + ny * (o + 0.006)], [p1[0] + nx * o, p1[1] + ny * o]];
        const pts = q.map(([a, b]) => [s * a, b]);
        if (s < 0) pts.reverse();
        const aw = extrudeFront(pts, zb - za, mats.glassDark, 0);
        aw.castShadow = false;
        aw.position.z = (za + zb) / 2;
        g(aw);
      }
    }
  }
  // rear face of the greenhouse: door window + corner windows
  {
    const sh = polyShape([[-WG, WAIST], [WG, WAIST], [WG, EAVE], [WG - CH, ROOF - 0.002], [-(WG - CH), ROOF - 0.002], [-WG, EAVE]], 0);
    const holes = [[-0.795, 1.43, -0.585, 1.83, 0.045], [0.585, 1.43, 0.795, 1.83, 0.045], [-0.43, 1.43, 0.43, 1.87, 0.035]];
    for (const [x0, y0, x1, y1, r] of holes) sh.holes.push(rrPath(x0, y0, x1, y1, r));
    const rf = extrudeShape(sh, 0.035, mats.paint, 'xy', 0.008);
    rf.position.z = REAR - 0.0175;
    g(rf);
    for (const [hi, [x0, y0, x1, y1, r]] of holes.entries()) {
      const sealF = frame(x0, y0, x1, y1, r, 0.02, 0.012, mats.seal);
      sealF.position.z = REAR + 0.002;
      g(sealF);
      const gl = plate(x0 - 0.006, y0 - 0.006, x1 + 0.006, y1 + 0.006, r, 0.006, mats.glass, 0);
      gl.position.z = REAR - 0.012;
      gl.castShadow = false;
      g(gl);
      void hi;
    }
    const sz = REAR + 0.0012;
    for (const s of sides) g(span(s * 0.52 - 0.003, s * 0.52 + 0.003, WAIST, 1.935, sz - 0.002, sz + 0.002, mats.seal));
    g(span(-0.523, 0.523, 1.932, 1.938, sz - 0.002, sz + 0.002, mats.seal));
    out.cbl = g(rbox(0.26, 0.032, 0.03, 0.01, mats.brake, 0, 1.955, REAR + 0.006));
  }
  // windscreen: raked frame, single pane, seal; lives in the greenhouse so it follows the tumblehome
  {
    const ws = new THREE.Group();
    ws.position.set(0, WAIST, SCREEN);
    const ang = Math.atan2(D.RAKE, EAVE - WAIST);
    ws.rotation.x = ang;
    gh.add(ws);
    const L = Math.hypot(D.RAKE, EAVE - WAIST) + 0.012;
    const hx = WG - 0.072, hy0 = 0.045, hy1 = L - 0.078;
    const sh = polyShape([[-WG, 0], [WG, 0], [WG, L], [-WG, L]], 0);
    sh.holes.push(rrPath(-hx, hy0, hx, hy1, 0.035));
    const fr = extrudeShape(sh, 0.05, mats.paint, 'xy', 0.01);
    fr.position.z = 0.0;
    add(fr, ws);
    const sealF = frame(-hx, hy0, hx, hy1, 0.035, 0.018, 0.012, mats.seal);
    sealF.position.z = -0.026;
    add(sealF, ws);
    const gl = plate(-hx - 0.006, hy0 - 0.006, hx + 0.006, hy1 + 0.006, 0.035, 0.006, mats.glassClear, 0);
    gl.position.z = -0.012;
    gl.castShadow = false;
    add(gl, ws);
    for (const s of sides) add(rbox(0.07, 0.03, 0.03, 0.008, mats.paint, s * 0.45, 0.015, -0.03), ws);
  }
  warpGroup(gh, tumblehome(WAIST, D.TUMBLE));

  {
    const t = Math.atan2(D.RAKE, EAVE - WAIST);
    const onGlass = (x, h) => [x, WAIST + 0.05 + h * Math.cos(t), SCREEN - 0.034 + (0.05 + h) * Math.sin(t)];
    for (const x0 of [-0.56, 0.02]) {
      add(bar(onGlass(x0, 0.0), onGlass(x0 + 0.46, 0.035), 0.006, mats.black, 6));
      add(bar(onGlass(x0 + 0.04, 0.02), onGlass(x0 + 0.5, 0.045), 0.0045, mats.black, 6));
      add(mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.03, 10).rotateX(Math.PI / 2 - t), mats.black, ...onGlass(x0, -0.012)));
    }
  }

  // ------------------------------------------------------------------ mirrors
  // convex glass (R 1 m, like real door mirrors): its normals spread, so the environment reflection
  // shows sky above and ground below instead of one flat grey tone
  const mirrorGlass = new THREE.PlaneGeometry(0.135, 0.205, 6, 8);
  {
    const p = mirrorGlass.attributes.position, R = 1.0, r2max = 0.0675 ** 2 + 0.1025 ** 2;
    for (let i = 0; i < p.count; i++) p.setZ(i, (r2max - p.getX(i) ** 2 - p.getY(i) ** 2) / (2 * R));
    mirrorGlass.computeVertexNormals();
  }
  for (const s of sides) {
    add(pipe([[s * (W - 0.02), WAIST + 0.02, -0.63], [s * (W + 0.1), WAIST + 0.06, -0.635], [s * (W + 0.14), 1.50, -0.62]], 0.013, mats.black, 0.05, 8));
    add(rbox(0.16, 0.235, 0.06, 0.025, mats.black, s * (W + 0.19), 1.595, -0.615));
    add(mesh(mirrorGlass, mats.mirror, s * (W + 0.19), 1.595, -0.585)).castShadow = false;
  }

  // ------------------------------------------------------------------ snorkel (right A-pillar)
  {
    const x0 = W + 0.03;
    add(rbox(0.07, 0.34, 0.25, 0.03, mats.black, x0, 1.17, -0.85));
    const tw = y => WG * D.tumble(y) + 0.06;
    const pts = [[x0, 1.30, -0.82], [x0 + 0.002, 1.40, -0.76], [tw(1.5), 1.52, pz(1.52) - 0.035], [tw(1.75), 1.75, pz(1.75) - 0.035], [tw(1.95), 1.97, pz(1.97) - 0.03]];
    add(pipe(pts, 0.046, mats.black, 0.12, 14));
    const top = pts[pts.length - 1];
    add(pipe([top, [top[0], 2.06, top[2]], [top[0], 2.08, top[2] - 0.06]], 0.046, mats.black, 0.05, 14));
    add(rbox(0.13, 0.14, 0.21, 0.035, mats.black, top[0], 2.085, top[2] - 0.08));
    add(rbox(0.105, 0.09, 0.02, 0.01, mats.seal, top[0], 2.08, top[2] - 0.188));
    for (const y of [1.6, 1.86]) add(bar([tw(y), y, pz(y) - 0.035], [WG * D.tumble(y) - 0.01, y, pz(y) + 0.01], 0.01, mats.black, 6));
  }

  // ------------------------------------------------------------------ rear end
  {
    // vertical lamp clusters: high amber indicator, then amber / tail / brake, black bezels
      for (const s of sides) {
      add(rbox(0.1, 0.1, 0.02, 0.012, mats.black, s * 0.828, 1.14, REAR + 0.008));
      add(rbox(0.075, 0.075, 0.016, 0.01, mats.amber, s * 0.828, 1.14, REAR + 0.016)).castShadow = false;
      add(rbox(0.27, 0.12, 0.022, 0.014, mats.black, s * 0.745, 0.835, REAR + 0.008));
      const cx = [0.835, 0.75, 0.665];
      const cm = [mats.amber, mats.tail, mats.brake];
      for (let k = 0; k < 3; k++) add(rbox(0.074, 0.092, 0.016, 0.008, cm[k], s * cx[k], 0.835, REAR + 0.017)).castShadow = false;
      add(rbox(0.06, 0.03, 0.01, 0.006, mats.reflector, s * 0.69, 0.98, REAR + 0.006));
    }
    // rear door: lower outline, hinges (right) and handle
    for (const s of sides) add(span(s * 0.52 - 0.003, s * 0.52 + 0.003, 0.72, WAIST, REAR - 0.001, REAR + 0.003, mats.seal));
    add(span(-0.523, 0.523, 0.717, 0.723, REAR - 0.001, REAR + 0.003, mats.seal));
    for (const y of [0.92, 1.24]) add(rbox(0.06, 0.08, 0.022, 0.008, mats.paint, 0.525, y, REAR + 0.01));
    add(rbox(0.13, 0.035, 0.022, 0.01, mats.black, -0.35, 1.12, REAR + 0.01));
    add(rbox(0.36, 0.36, 0.06, 0.02, mats.blackMetal, 0, 1.17, REAR + 0.04));
    // bumper with lamps, D-rings, receiver
    const bp = extrudePlan([[-0.955, REAR - 0.02], [-0.955, REAR + 0.11], [-0.9, REAR + 0.165], [0.9, REAR + 0.165], [0.955, REAR + 0.11], [0.955, REAR - 0.02]], 0.19, mats.blackMetal, 0.014);
    bp.position.y = 0.535;
    add(bp);
    for (const s of sides) {
      const lx = [0.86, 0.785, 0.71], lm = [mats.amber, mats.brake, mats.reverse];
      add(rbox(0.235, 0.075, 0.012, 0.008, mats.seal, s * 0.785, 0.64, REAR + 0.164));
      for (let k = 0; k < 3; k++) add(rbox(0.065, 0.06, 0.014, 0.006, lm[k], s * lx[k], 0.64, REAR + 0.168)).castShadow = false;
      const x = s * 0.47;
      add(rbox(0.032, 0.08, 0.07, 0.008, mats.blackMetal, x, 0.54, REAR + 0.15));
      const bow = add(mesh(new THREE.TorusGeometry(0.04, 0.011, 8, 20, Math.PI * 1.32), mats.zinc, x, 0.485, REAR + 0.175));
      bow.rotation.z = Math.PI * 1.5 - Math.PI * 0.66;
      add(bar([x - 0.042, 0.515, REAR + 0.175], [x + 0.042, 0.515, REAR + 0.175], 0.009, mats.zinc, 8));
    }
    add(span(-0.06, 0.06, 0.55, 0.62, REAR + 0.12, REAR + 0.24, mats.blackMetal, 0.008));
    add(span(-0.035, 0.035, 0.565, 0.605, REAR + 0.238, REAR + 0.242, mats.seal));
    add(span(-0.16, 0.16, 0.70, 0.725, REAR + 0.02, REAR + 0.15, mats.black, 0.005)); // step tread
  }

  // ------------------------------------------------------------------ expedition roof rack + light bar
  const rack = new THREE.Group();
  body.add(rack);
  const rk = o => add(o, rack);
  const RY0 = ROOF + 0.10, RY1 = ROOF + 0.30, RX = 0.79, RZ0 = -0.56, RZ1 = 2.27;
  rk(pipe([[-RX, RY0, RZ0], [RX, RY0, RZ0], [RX, RY0, RZ1], [-RX, RY0, RZ1]], 0.019, mats.blackMetal, 0.1, 8, true));
  rk(pipe([[-RX - 0.01, RY1, RZ0 + 0.1], [RX + 0.01, RY1, RZ0 + 0.1], [RX + 0.01, RY1, RZ1], [-RX - 0.01, RY1, RZ1]], 0.019, mats.blackMetal, 0.13, 8, true));
  const posts = [RZ0 + 0.1, 0.05, 0.5, 0.95, 1.4, 1.85, RZ1];
  for (const s of sides) {
    rk(bar([s * RX, RY0 + 0.1, RZ0 + 0.12], [s * RX, RY0 + 0.1, RZ1], 0.014, mats.blackMetal, 8)); // middle rail
    for (const z of posts) rk(bar([s * RX, RY0, z], [s * (RX + 0.01), RY1, z], 0.016, mats.blackMetal, 8));
    for (const z of [-0.32, 0.35, 1.0, 1.62, 2.18]) {
      const xg = WG * D.tumble(EAVE) + 0.006;
      rk(rbox(0.05, 0.03, 0.07, 0.008, mats.blackMetal, s * xg, EAVE + 0.02, z));
      rk(bar([s * xg, EAVE + 0.03, z], [s * (RX - 0.01), RY0, z], 0.014, mats.blackMetal, 8));
    }
  }
  for (let k = 0; k <= 4; k++) { const z = RZ0 + 0.06 + (RZ1 - RZ0 - 0.12) * k / 4; rk(bar([-RX, RY0, z], [RX, RY0, z], 0.016, mats.blackMetal, 8)); }
  for (const x of [-0.4, 0.4]) rk(bar([x, RY0 + 0.018, RZ0 + 0.05], [x, RY0 + 0.018, RZ1 - 0.05], 0.012, mats.blackMetal, 6));
  // light bar across the front: four square lamps and the amber beacon in the middle
  const LBZ = RZ0 - 0.04, LBY = RY0 + 0.05;
  rk(bar([-0.74, LBY - 0.035, LBZ + 0.03], [0.74, LBY - 0.035, LBZ + 0.03], 0.02, mats.blackMetal, 8));
  for (const s of sides) rk(bar([s * 0.74, LBY - 0.035, LBZ + 0.03], [s * RX, RY0, RZ0 + 0.06], 0.018, mats.blackMetal, 8));
  out.auxLens = [];
  for (const x of [-0.56, -0.28, 0.28, 0.56]) {
    rk(rbox(0.18, 0.135, 0.1, 0.02, mats.black, x, LBY + 0.04, LBZ));
    rk(rbox(0.012, 0.05, 0.04, 0.004, mats.black, x, LBY - 0.035, LBZ + 0.02));
    rk(frame(-0.07, -0.051, 0.07, 0.051, 0.01, 0.008, 0.014, mats.chrome)).position.set(x, LBY + 0.04, LBZ - 0.05);
    const lens = rk(rbox(0.142, 0.104, 0.014, 0.006, mats.auxLens, x, LBY + 0.04, LBZ - 0.048));
    lens.castShadow = false;
    out.auxLens.push(lens);
  }
  rk(rbox(0.1, 0.03, 0.08, 0.01, mats.black, 0, LBY - 0.01, LBZ + 0.02));
  const bc = rk(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.075, 18), mats.beacon, 0, LBY + 0.04, LBZ + 0.02));
  bc.castShadow = false;
  rk(mesh(new THREE.SphereGeometry(0.045, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.beacon, 0, LBY + 0.077, LBZ + 0.02)).castShadow = false;
  for (const s of sides) {
    rk(rbox(0.11, 0.08, 0.07, 0.012, mats.black, s * 0.6, RY1 + 0.03, RZ1 + 0.02));
    rk(rbox(0.09, 0.06, 0.012, 0.005, mats.workLens, s * 0.6, RY1 + 0.03, RZ1 + 0.058)).castShadow = false;
  }
  out.rack = rack;

  // ------------------------------------------------------------------ chassis + underbody
  for (const s of sides) add(span(s * 0.43 - 0.05, s * 0.43 + 0.05, 0.46, 0.62, FRONT + 0.06, REAR + 0.02, mats.chassis));
  for (const z of [-1.9, -0.6, 0.62, 1.95]) add(span(-0.43, 0.43, 0.49, 0.6, z - 0.045, z + 0.045, mats.chassis));
  add(span(-0.3, 0.3, 0.44, 0.74, -0.78, 0.08, mats.chassis, 0.05));     // gearbox
  add(span(-0.16, 0.3, 0.42, 0.64, 0.08, 0.5, mats.chassis, 0.04));      // transfer case
  add(span(-0.31, 0.31, 0.52, 1.16, -1.9, -0.8, mats.chassis, 0.06));    // engine block
  add(span(-0.22, 0.22, 0.42, 0.56, -1.75, -0.95, mats.chassis, 0.03)); // sump
  add(span(0.36, 0.8, 0.48, 0.64, 1.62, 2.2, mats.chassis, 0.03));       // fuel tank
  add(bar([-0.5, 0.48, -0.75], [-0.54, 0.46, 2.36], 0.03, mats.steel));  // exhaust
  add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.42, 14).rotateX(Math.PI / 2), mats.steel, -0.52, 0.47, 1.1));
  add(span(-0.4, 0.4, 0.8, 1.2, FRONT + 0.06, FRONT + 0.12, mats.chassis));

  out.anchors = {
    head: [0, 1.0, FRONT - 0.31],
    aux: [0, LBY + 0.04, LBZ - 0.12],
    rear: [0, 0.82, REAR + 0.3],
  };
  return out;
}
