import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { makeCarParams, CAR_SPECS } from './carSpecs.js';
import { staticRide } from './tuning.js';

// What each drivable car looks like. Physics numbers: carSpecs.js. Imported cars swap the Defender's
// body for a downloaded shell and its own wheels; our axles, springs, steering and lamps stay.
//
// Shells are prepared with tools/prepcar.mjs (DEVNOTES.md, "Imported cars"): frame baked in (+x right,
// -z forward, hub centre at y 0, mid-wheelbase at z 0), wheels split into wheel_<FL|FR|RL|RR> (spin) and
// hub_<corner> (calipers: steer only), compressed (meshopt + WebP). The shell sits in the body frame at
// the static hub height, so lift and bigger tyres move the wheels away from the arches as on the Defender.
export const CARS = {
  defender: { label: 'Defender 110' },
  gclass: {
    label: 'G-Class',
    url: 'models/gclass2021.glb',
    credit: 'Mercedes-Benz G-Class 2021 by ItsDiyor, CC BY 4.0, https://sketchfab.com/3d-models/1768618c049b49fcb0d09a86d6f67c8d',
    wheel: { R: 0.4015, width: 0.285 },   // its own tyre (the wheel nodes scale from this to the tuned size)
    eye: [-0.40, 1.62, 0.10],           // left-hand drive
    hoodEye: [0, 1.68, -1.05],
    lamps: { head: [0, 0.95, -2.42], bar: [0, 2.02, -0.55], rear: [0, 0.80, 2.62] },
  },
  lancia: {
    label: 'Lancia Delta',
    url: 'models/lancia-delta.glb',
    credit: 'Lancia Delta HF Integrale Evo 2 by TARANTULA, CC BY 4.0, https://sketchfab.com/3d-models/85614131e0dc4613a948472aaa935fc7',
    wheel: { R: 0.2965, width: 0.241 },
    chase: { dist: 5.6, target: 0.85 },   // 0.7 m shorter and 0.6 m lower than the Defender: the camera comes closer
    eye: [-0.38, 1.10, 0.15],
    hoodEye: [0, 1.02, -1.05],
    lamps: { head: [0, 0.62, -2.08], bar: [0, 1.33, -0.30], rear: [0, 0.75, 2.0] },
  },
};

const CORNERS = ['FL', 'FR', 'RL', 'RR'];   // truckModel.buildTruck wheel order: front left, front right, rear ...

// swap the Defender body and wheels of a built truck model (truckModel.buildTruck) for the car's own
export async function fitCarBody(model, id) {
  const c = CARS[id];
  if (!c?.url) return;
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
        g.add(m);
      });
      node.removeFromParent();
      parent.add(g);
    }
    mw.tire.visible = false;
    mw.rim.visible = false;
  });
  // hubs at the stock static ride height (front and rear differ a little: tilt to match both)
  const [f, r] = staticRide(P).map(x => x.hubY);
  shell.position.y = (f + r) / 2 + (CAR_SPECS[id].raise || 0);   // a raised car: the body goes up, the wheels stay
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
