import * as THREE from 'three';
import { D } from './truckDims.js';

// X-ray view of the physics: chassis collision boxes, wheel side cylinders, tyre outlines against the
// arch tops, suspension travel gauges, tyre contact patches and the points where the body touches the
// ground or an obstacle (the touching box turns red). Drawn on top of everything (no depth test).
//
// Nothing exists until it is first switched on, and while off the group is invisible and update() returns
// at once, so it costs nothing in normal play.

const COL = {
  box: new THREE.Color(0.25, 0.85, 1.0),
  hit: new THREE.Color(1.0, 0.22, 0.15),
  sel: new THREE.Color(1.0, 0.72, 0.28),
  wheel: new THREE.Color(0.55, 0.6, 1.0),
  tyre: new THREE.Color(0.85, 0.9, 0.95),
  ok: new THREE.Color(0.43, 0.86, 0.55),
  stop: new THREE.Color(1.0, 0.7, 0.28),
};
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _p = new THREE.Vector3(), _cq = new THREE.Quaternion();

// Contacts of a collider after world.step(): the solver contacts are cleared by then, so this reads the
// manifold points and keeps those closer than 1 cm. cb(worldPoint) per point; returns the count.
export function touchPoints(world, c, cb) {
  let n = 0;
  world.contactPairsWith(c, other => {
    world.contactPair(c, other, (m, flipped) => {
      for (let j = 0, k = m.numContacts(); j < k; j++) {
        if (m.contactDist(j) > 0.01) continue;
        n++;
        if (cb) {
          const lp = flipped ? m.localContactPoint2(j) : m.localContactPoint1(j);
          const t = c.translation(), r = c.rotation();
          _cq.set(r.x, r.y, r.z, r.w);
          cb(_p.set(lp.x, lp.y, lp.z).applyQuaternion(_cq).add(_v.set(t.x, t.y, t.z)));
        }
      }
    });
  });
  return n;
}
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
const fillMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
const onTop = o => { o.renderOrder = 999; o.frustumCulled = false; return o; };

// unit circle in the y-z plane (a wheel seen from the side), n segments
function circle(n = 48) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    p.push(0, Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b));
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
}
// cylinder outline along x: two rims and four lines
function cylinderLines(n = 32) {
  const p = [];
  for (const x of [-1, 1]) for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    p.push(x, Math.cos(a), Math.sin(a), x, Math.cos(b), Math.sin(b));
  }
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; p.push(-1, Math.cos(a), Math.sin(a), 1, Math.cos(a), Math.sin(a)); }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
}

export class ColliderView {
  constructor(scene, model, vehicle) {
    this.scene = scene; this.m = model; this.v = vehicle;
    this.enabled = false;
    this.selected = -1;
    this.built = false;
    this.touching = new Set();      // chassis box indices touching something this frame
    this.contacts = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.built) this.build();
    if (this.built) { this.body.visible = on; this.world.visible = on; }
    if (on) this.rebuildBoxes();
  }

  build() {
    this.built = true;
    // body frame: lives under the truck root, so it follows the interpolated pose
    this.body = onTop(new THREE.Group()); this.body.name = 'collider-view';
    this.m.root.add(this.body);
    this.world = onTop(new THREE.Group()); this.world.name = 'collider-view-world';
    this.scene.add(this.world);
    this.boxGroup = new THREE.Group(); this.body.add(this.boxGroup);
    this.boxes = [];
    // wheels: side cylinder, tyre outline, travel gauge
    this.cyl = cylinderLines(); this.circ = circle();
    this.wheels = this.v.wheels.map(() => {
      const cyl = onTop(new THREE.LineSegments(this.cyl, lineMat(COL.wheel, 0.75)));
      const tyre = onTop(new THREE.LineSegments(this.circ, lineMat(COL.tyre, 0.9)));
      this.body.add(cyl, tyre);
      return { cyl, tyre };
    });
    // arch tops: a short line over each wheel at D.ARCH_TOP
    const ap = [];
    for (const z of [D.ARCH_F, D.ARCH_R]) for (const x of [-1, 1]) ap.push(x * 0.78, D.ARCH_TOP, z - 0.34, x * 0.78, D.ARCH_TOP, z + 0.34);
    this.arches = onTop(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(ap, 3)), lineMat(0xffffff, 0.6)));
    this.arches.visible = this.v.nA === 2;   // the Defender's arch line; a multi-axle truck has its own hull
    this.body.add(this.arches);
    // travel gauges, outside the body next to each wheel: droop..bump, bump stop zone, current position
    this.gauges = this.v.wheels.map(w => {
      const g = new THREE.Group();
      const rail = onTop(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]), lineMat(0xffffff, 0.45)));
      const stop = onTop(new THREE.Mesh(new THREE.PlaneGeometry(0.035, 1).translate(0, 0.5, 0), fillMat(COL.stop, 0.55)));
      const mark = onTop(new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.022), fillMat(COL.ok, 0.95)));
      g.add(rail, stop, mark);
      g.rotation.y = Math.PI / 2;
      this.body.add(g);
      return { g, rail, stop, mark, side: w.side };
    });
    // contact patches (world): a disc per wheel, size by load, colour by slip
    this.patches = this.v.wheels.map(() => {
      const d = onTop(new THREE.Mesh(new THREE.CircleGeometry(1, 24), fillMat(COL.ok, 0.7)));
      this.world.add(d);
      return d;
    });
    // body contact points (world)
    this.dots = onTop(new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 10, 8), fillMat(COL.hit, 0.95), 48));
    this.dots.count = 0;
    this.world.add(this.dots);
  }

  // chassis boxes from the vehicle's params (after an edit or a setup change)
  rebuildBoxes() {
    if (!this.built) return;
    for (const b of this.boxes) { this.boxGroup.remove(b.edges, b.fill); b.edges.geometry.dispose(); b.fill.geometry.dispose(); }
    this.boxes = this.v.P.colliders.map(([cx, cy, cz, hx, hy, hz]) => {
      const geo = new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz);
      const edges = onTop(new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat(COL.box, 0.95)));
      const fill = onTop(new THREE.Mesh(geo, fillMat(COL.box, 0.07)));
      edges.position.set(cx, cy, cz); fill.position.set(cx, cy, cz);
      this.boxGroup.add(edges, fill);
      return { edges, fill };
    });
  }

  update() {
    if (!this.enabled) return;
    const v = this.v, P = v.P, world = v.world;
    // which chassis boxes touch something, and where
    this.touching.clear();
    let n = 0;
    const cols = v.chassisColliders;
    for (let i = 0; i < cols.length; i++) {
      const k = touchPoints(world, cols[i], p => { if (n < 48) this.dots.setMatrixAt(n++, _m.makeTranslation(p.x, p.y, p.z)); });
      if (k > 0) this.touching.add(i);
    }
    this.contacts = n;
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    this.boxes.forEach((b, i) => {
      const hit = this.touching.has(i), sel = i === this.selected;
      const c = hit ? COL.hit : sel ? COL.sel : COL.box;
      b.edges.material.color.copy(c);
      b.fill.material.color.copy(c);
      b.fill.material.opacity = hit ? 0.28 : sel ? 0.2 : 0.06;
    });
    // wheels: side cylinders (body frame, same pose as Vehicle.updateGeometry), tyre outlines, gauges
    const R = v.R;
    v.wheels.forEach((w, i) => {
      const ax = w.axle, ap = ax.p, o = this.wheels[i];
      if (ax.ind) {
        // independent corner: hub, camber, steer (Vehicle.cornerGeometry)
        _v.set(w.side * (P.track / 2 + w.out), ax.droopY + w.c, ap.z);
        _q2.setFromAxisAngle(Z, -w.side * w.camber).multiply(_q.setFromAxisAngle(Y, -w.steer));
      } else {
        _q.setFromAxisAngle(Z, ax.phi);
        _v.set(w.side * P.track / 2, 0, 0).applyQuaternion(_q);
        _v.y += ax.droopY + ax.c; _v.z += ap.z;
        _q2.copy(_q).multiply(_q.setFromAxisAngle(Y, -w.steer));
      }
      o.cyl.position.copy(_v); o.cyl.quaternion.copy(_q2);
      const cr = R - 0.12 * R / 0.42;
      o.cyl.scale.set(P.tire.width * 0.42, cr, cr);
      o.tyre.position.copy(_v); o.tyre.quaternion.copy(_q2); o.tyre.scale.setScalar(R);
      // tyre top against the arch top (body frame): red when it reaches the arch
      const top = _v.y + R;
      const rub = v.nA === 2 && top > D.ARCH_TOP - 0.01;
      o.tyre.material.color.copy(rub ? COL.hit : COL.tyre);
      // side cylinder touching a rock / log / tree
      const hitW = w.sideCollider ? touchPoints(world, w.sideCollider) > 0 : false;
      o.cyl.material.color.copy(hitW ? COL.hit : COL.wheel);
      // travel gauge: spring compression at this side, 0 = full droop, travel = hard stop
      const g = this.gauges[i], s2 = ap.springTrack / 2;
      const comp = ax.ind ? w.c : ax.c + w.side * s2 * Math.sin(ax.phi);
      // beside the body ahead of / behind the wheel (4x4), or just outboard of the tyre (more axles)
      if (v.nA === 2) g.g.position.set(w.side * (D.W + 0.12), ax.droopY, ap.z + (ax.i === 0 ? -0.62 : 0.62));
      else g.g.position.set(w.side * (P.track / 2 + P.tire.width / 2 + 0.12), ax.droopY, ap.z);
      g.rail.scale.y = ap.travel;
      g.stop.position.y = ap.travel - 0.05; g.stop.scale.y = 0.05;
      g.mark.position.y = Math.max(-0.02, Math.min(ap.travel + 0.02, comp));
      g.mark.material.color.copy(comp > ap.travel - 0.05 ? (comp >= ap.travel - 0.005 ? COL.hit : COL.stop) : COL.ok);
      // contact patch
      const d = this.patches[i];
      d.visible = w.contact && w.FnAvg > 0;
      if (d.visible) {
        d.position.copy(w.P).addScaledVector(w.n, 0.01);
        d.quaternion.setFromUnitVectors(Z, w.n);
        d.scale.setScalar(0.05 + 0.12 * Math.sqrt(w.FnAvg / 5000));
        const s = Math.min(1, w.slipNorm || 0);
        d.material.color.copy(COL.ok).lerp(COL.hit, s);
      }
    });
  }

  dispose() {
    if (!this.built) return;
    this.m.root.remove(this.body); this.scene.remove(this.world);
  }
}
