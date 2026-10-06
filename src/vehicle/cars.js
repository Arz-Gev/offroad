import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { makeCarParams } from './carParams.js';
import { carDef } from '../cars/index.js';
import { staticRide } from './tuning.js';
import { buildTruck } from './truckModel.js';
import { buildBtr } from './btrModel.js';
import { createTireMaterial, makeTireMesh } from './tireMaterial.js';

// A car's model, from its file's look (src/cars/<id>.js): the Defender's own procedural body, or a
// downloaded shell on the Defender's running gear (fitCarBody), or a car with its own builder (look.build).
// Imported cars swap the Defender's body for the shell and its own wheels; our axles, springs, steering
// and lamps stay.
//
// Shells are prepared with tools/prepcar.mjs (.claude/skills/add-car/SKILL.md): frame baked in (+x right,
// -z forward, hub centre at y 0, mid-wheelbase at z 0), wheels split into wheel_<FL|FR|RL|RR> (spin) and
// hub_<corner> (calipers: steer only), compressed (meshopt + WebP). The shell sits in the body frame at
// the static hub height, so lift and bigger tyres move the wheels away from the arches as on the Defender.

const CORNERS = ['FL', 'FR', 'RL', 'RR'];   // truckModel.buildTruck wheel order: front left, front right, rear ...

// the model of a car, ready for VehicleView: the Defender, a downloaded shell on the Defender's running
// gear (fitCarBody), or a car with its own builder (BTR-80: btrModel.js)
export async function buildCarModel(id) {
  const c = carDef(id).look;
  if (c.build === 'btr') return buildBtr(id, c);
  const model = buildTruck(makeCarParams(id));   // modelled stock; the view scales the wheels and follows the lift
  await fitCarBody(model, id);
  return model;
}

// swap the Defender body and wheels of a built truck model (truckModel.buildTruck) for the car's own
export async function fitCarBody(model, id) {
  const c = carDef(id).look;
  if (!c.url) return;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + c.url);
  const shell = gltf.scene;
  shell.name = 'shell';
  shell.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    // glass: plain alpha blending (transmission would add a second scene render every frame)
    if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.35); }
    if (m.transparent) { o.castShadow = false; m.depthWrite = false; }
  });
  shell.updateMatrixWorld(true);
  // the wheels: out of the shell, onto our wheel groups (spin: rolls and steers; steer: calipers)
  const P = makeCarParams(id);
  const s = { x: 0.27 / c.wheel.width, r: 0.42 / c.wheel.R };   // VehicleView scales spin by (width / 0.27, R / 0.42)
  CORNERS.forEach((k, i) => {
    const mw = model.wheels[i];
    const hub = new THREE.Vector3((k[1] === 'L' ? -1 : 1) * P.track / 2, 0, (k[0] === 'F' ? -1 : 1) * P.wheelbase / 2);
    const toHub = new THREE.Matrix4().makeTranslation(-hub.x, -hub.y, -hub.z);
    for (const [name, parent, scaled] of [['wheel_' + k, mw.spin, true], ['hub_' + k, mw.steer, false]]) {
      const node = shell.getObjectByName(name);
      if (!node) continue;
      const g = new THREE.Group();
      if (scaled) g.scale.set(s.x, s.r, s.r);
      node.traverse(o => {
        if (!o.isMesh) return;
        const m = new THREE.Mesh(o.geometry, o.material);
        m.matrixAutoUpdate = false;
        m.matrix.multiplyMatrices(toHub, o.matrixWorld);
        m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow;
        // the tyre deforms with the contact data (tyre v2); the rim merged into the same mesh stays round:
        // nothing inside the rim radius moves
        if (scaled) {
          const mat = createTireMaterial(o.material);
          makeTireMesh(m, mat, { toWheel: m.matrix, R: c.wheel.R, rim: P.tire.rimRadius, width: c.wheel.width });
          (mw.tireMats ||= []).push(mat);
        }
        g.add(m);
      });
      node.removeFromParent();
      parent.add(g);
    }
    mw.tire.visible = false;
    mw.rim.visible = false;
    if (mw.tireMats) { mw.tireMat = mw.tireMats[0]; mw.tireUnits = 0.42 / c.wheel.R; } else mw.tireMat = null;
  });
  // hubs at the stock static ride height (front and rear differ a little: tilt to match both)
  const [f, r] = staticRide(P).map(x => x.hubY);
  shell.position.y = (f + r) / 2 + (P.raise || 0);   // a raised car: the body goes up, the wheels stay
  shell.rotation.x = Math.asin((f - r) / P.wheelbase);
  model.root.add(shell);
  model.body.visible = false;     // exterior + cockpit
  model.spare.steer.visible = false;
  model.shell = shell;
  model.driverEye = new THREE.Vector3(...c.eye);
  model.hoodEye = new THREE.Vector3(...c.hoodEye);
  if (c.chase) { model.chaseDist = c.chase.dist; model.chaseTarget = c.chase.target; }
  for (const k of ['head', 'bar', 'rear']) {
    const L = model.lights[k], p = c.lamps[k];
    const d = L.target.position.clone().sub(L.position);
    L.position.set(...p);
    L.target.position.copy(L.position).add(d);
  }
}
