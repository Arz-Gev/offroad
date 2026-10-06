import * as THREE from 'three';
import { createTireMaterial, makeTireMesh } from './tireMaterial.js';
import { makeRubberTexture } from './materials.js';
import { mesh, mergeStatic, mergeGeometries } from './geom.js';
import { cornerName } from '../suspension.js';

// Wheels of a car model. Every wheel is { steer, spin, tireMats, side, axle, nativeR, nativeW }: steer
// turns with the steering (and carries camber on an independent corner), spin rolls; VehicleView scales
// spin from the size the wheel was modelled at (nativeR, nativeW) to the tuned tyre, and feeds the tyre
// materials the contact data (tyre v2: the tyre deforms, the rim doesn't).
// - steelWheel: our procedural wheel (the Defender's);
// - modelWheels: the wheels of a downloaded model (tools/prepcar.mjs splits them into nodes per corner,
//   corners FL FR RL RR on two axles, 1L 1R 2L ... on more): tire_<k> deforms, wheel_<k> spins (and
//   deforms when there is no tire_<k>: the rim inside the rim radius stays round), hub_<k> steers without
//   spinning (calipers) unless look.wheel.hubSpins (the BTR-80's valve on the rim face).

let _tireGeo = null;
export function tireGeometry(R = 0.42) {
  if (_tireGeo) return _tireGeo;
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

const _barrelMats = new WeakMap();
function barrelMat(m) {
  if (!_barrelMats.has(m)) { const c = m.clone(); c.side = THREE.DoubleSide; c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; _barrelMats.set(m, c); }
  return _barrelMats.get(m);
}

// black modular steel wheel: barrel, dished centre with round holes, hub, nuts
function rimGroup(mats) {
  const g = new THREE.Group();
  // the barrel is an open tube: seen from outside you look at its inner (back) faces, so draw both sides
  const barrel = mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.2, 36, 1, true), barrelMat(mats.steel));
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);
  const lip = mesh(new THREE.TorusGeometry(0.203, 0.009, 8, 40), mats.steel, 0.1, 0, 0);
  lip.rotation.y = Math.PI / 2;
  g.add(lip);
  const face = new THREE.Shape();
  face.absarc(0, 0, 0.2, 0, Math.PI * 2, false);   // reaches the barrel: no see-through ring around the face
  for (let k = 0; k < 8; k++) {
    const a = (k + 0.5) / 8 * Math.PI * 2;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * 0.135, Math.sin(a) * 0.135, 0.027, 0, Math.PI * 2, true);
    face.holes.push(h);
  }
  const fg = new THREE.ExtrudeGeometry(face, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 20 });
  fg.rotateY(Math.PI / 2);
  g.add(mesh(fg, mats.steel, 0.04, 0, 0));
  // pressed centre dome
  const dome = mesh(new THREE.CylinderGeometry(0.1, 0.115, 0.03, 28).rotateZ(Math.PI / 2), mats.steel, 0.06, 0, 0);
  g.add(dome);
  const back = mesh(new THREE.CylinderGeometry(0.203, 0.203, 0.01, 36), mats.chassis, 0.0, 0, 0);
  back.rotation.z = Math.PI / 2;
  g.add(back);
  const cap = mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.035, 18), mats.blackMetal, 0.085, 0, 0);
  cap.rotation.z = Math.PI / 2;
  g.add(cap);
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * Math.PI * 2;
    const nut = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.026, 6), mats.zinc, 0.08, Math.cos(a) * 0.07, Math.sin(a) * 0.07);
    nut.rotation.z = Math.PI / 2;
    g.add(nut);
  }
  return g;
}

// The procedural steel wheel on a 33x10.5 mud tyre (the Defender's): native size R 0.42, width 0.27.
// side: -1 left, +1 right (rim face points outward). deformable: the tyre follows the contact data.
export function steelWheel(mats, side, deformable = true) {
  const steer = new THREE.Group();
  const spin = new THREE.Group();
  steer.add(spin);
  mats.rubberTex ||= makeRubberTexture();
  const tireMat = deformable ? createTireMaterial(mats.rubberTex) : new THREE.MeshStandardMaterial({ color: 0xffffff, map: mats.rubberTex, roughness: 0.88 });
  const tire = mesh(tireGeometry(), tireMat);
  if (deformable) makeTireMesh(tire, tireMat, { R: 0.42, rim: 0.205, width: 0.27 });   // the tread, rim seat and width of tireGeometry
  spin.add(tire);
  const rim = rimGroup(mats);
  mergeStatic(rim);
  if (side < 0) rim.rotation.y = Math.PI;
  spin.add(rim);
  return { steer, spin, tire, tireMat, tireMats: deformable ? [tireMat] : [], rim, side, nativeR: 0.42, nativeW: 0.27 };
}

// The wheels of a downloaded shell. at(k, a, side): the hub centre of corner k in the shell's frame
// (prepcar's holder node at the measured hub, or the physics corner). The parts move out of the shell into
// the wheel groups, placed relative to the hub.
export function modelWheels(shell, P, look) {
  const W = look.wheel, nA = P.axles.length, out = [];
  const rim = W.rim ?? P.tire.rimRadius;
  shell.updateMatrixWorld(true);
  for (let a = 0; a < nA; a++) for (const side of [-1, 1]) {
    const k = cornerName(a, side, nA);
    const steer = new THREE.Group(), spin = new THREE.Group();
    steer.add(spin);
    const holder = ['tire_', 'wheel_'].map(n => shell.getObjectByName(n + k)).find(n => n && n.position.lengthSq() > 0);
    // the hub: a holder node's world position, else the physics corner at the shell's hub height (y 0)
    const hub = holder ? holder.getWorldPosition(new THREE.Vector3()) : shell.localToWorld(new THREE.Vector3(side * P.track / 2, 0, P.axles[a].z));
    const toHub = new THREE.Matrix4().makeTranslation(-hub.x, -hub.y, -hub.z);
    const tireMats = [], hasTire = !!shell.getObjectByName('tire_' + k);
    for (const prefix of ['tire_', 'wheel_', 'hub_']) {
      const node = shell.getObjectByName(prefix + k);
      if (!node) continue;
      const parent = prefix === 'hub_' && !W.hubSpins ? steer : spin;
      const deforms = prefix === 'tire_' || (prefix === 'wheel_' && !hasTire);
      const meshes = [];
      node.traverse(o => { if (o.isMesh) meshes.push(o); });
      for (const o of meshes) {
        const m = new THREE.Mesh(o.geometry, o.material);
        m.matrixAutoUpdate = false;
        m.matrix.multiplyMatrices(toHub, o.matrixWorld);
        m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow; m.name = o.name;
        if (deforms) {
          const mat = createTireMaterial(o.material);
          makeTireMesh(m, mat, { toWheel: m.matrix, R: W.R, rim, width: W.width });
          tireMats.push(mat);
        }
        parent.add(m);
      }
      node.removeFromParent();
    }
    out.push({ steer, spin, tireMats, side, axle: a, nativeR: W.R, nativeW: W.width });
  }
  return out;
}
