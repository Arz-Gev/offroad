import * as THREE from 'three';
import { rbox, bar, frame, mergeStatic } from './geom.js';

// Parts any car can carry, placed by its look (body frame).
//
// lightBar: a roof light bar: a black crossbar on two feet with `lamps` square lamps across `width` (lens role
// 'aux'), the aux beam just ahead. spec: { at: [x, y, z] (the lamps' centre), width, lamps, roof (y of the feet) }.
export function lightBar(mats, spec) {
  const g = new THREE.Group();
  const [x0, y, z] = spec.at, n = spec.lamps ?? 4, half = spec.width / 2;
  const add = o => { g.add(o); return o; };
  add(bar([x0 - half, y - 0.075, z + 0.03], [x0 + half, y - 0.075, z + 0.03], 0.02, mats.blackMetal, 8));
  for (const s of [-1, 1]) add(bar([x0 + s * (half - 0.06), y - 0.075, z + 0.03], [x0 + s * (half - 0.02), spec.roof, z + 0.08], 0.018, mats.blackMetal, 8));
  for (let k = 0; k < n; k++) {
    const x = x0 - half + 0.09 + (2 * half - 0.18) * (n === 1 ? 0.5 : k / (n - 1));
    add(rbox(0.18, 0.135, 0.1, 0.02, mats.black, x, y, z));
    add(rbox(0.012, 0.05, 0.04, 0.004, mats.black, x, y - 0.075, z + 0.02));
    add(frame(-0.07, -0.051, 0.07, 0.051, 0.01, 0.008, 0.014, mats.chrome)).position.set(x, y, z - 0.05);
    add(rbox(0.142, 0.104, 0.014, 0.006, mats.auxLens, x, y, z - 0.048)).castShadow = false;
  }
  mergeStatic(g);
  return { group: g, beam: [x0, y, z - 0.12], lenses: { aux: [mats.auxLens] } };
}

// searchlight: a round lamp whose model has its cover shut (the BTR-80's IR filter caps). Drawn over the lamp's
// face: a clear lens (role 'aux') in a chrome ring, the cover open on its hinge at the top of the rim. Origin is
// the face centre, facing -z; `beam` starts just ahead of the lens. spec: { r (lens radius), rim (the face's
// radius), cover (paint, default dark olive), open (rad, default 1.8), cone (beam half angle, default 0.2) }.
export function searchlight(mats, spec) {
  const g = new THREE.Group(), { r, rim } = spec;
  const disc = (rad, depth, mat, z) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, depth, 32).rotateX(Math.PI / 2), mat); m.position.z = z; return m; };
  const lens = disc(r, 0.008, mats.auxLens, -0.004);
  lens.castShadow = false;
  g.add(lens);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, 0.006, 8, 32), mats.chrome);
  ring.position.z = -0.006;
  g.add(ring);
  // the cover hangs from its hinge (top of the rim); closed it would lie on the face, open it turns back
  const hinge = new THREE.Group();
  hinge.position.set(0, rim, -0.012);
  hinge.rotation.x = -(spec.open ?? 1.8);
  const paint = new THREE.MeshStandardMaterial({ color: spec.cover ?? 0x323d28, roughness: 0.75, metalness: 0.1 });
  const filter = new THREE.MeshStandardMaterial({ color: 0x2c0a0b, roughness: 0.25, metalness: 0.1 });
  hinge.add(disc(rim, 0.014, paint, -0.007).translateY(-rim));
  hinge.add(disc(r, 0.004, filter, 0.002).translateY(-rim));
  hinge.add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 10).rotateZ(Math.PI / 2), mats.blackMetal));
  g.add(hinge);
  g.traverse(o => { if (o.isMesh && o !== lens) o.castShadow = true; });
  const beam = new THREE.Object3D();
  beam.position.z = -0.03;
  beam.userData.cone = spec.cone ?? 0.2;
  g.add(beam);
  return { group: g, beam, lenses: { aux: [mats.auxLens] } };
}
