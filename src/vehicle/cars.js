import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { makeDefenderParams } from './params.js';
import { staticRide } from './tuning.js';

// Drivable bodies. Every car runs the Defender's physics (engine, gearbox, solid axles, tyres and the
// tuning setup); a car only brings its own wheelbase, track and collision boxes. Imported cars swap the
// Defender's body for a downloaded shell; our wheels, axles and suspension stay and sit in its arches.
//
// Imported shells are prepared with tools/cutcar.mjs (DEVNOTES.md, "Imported cars"): wheels cut out,
// frame baked in (+x right, -z forward, hub centre at y 0, mid-wheelbase at z 0), compressed (meshopt +
// WebP). Placed in the body frame at the static hub height, so lift and bigger tyres move the wheels away
// from the arches as on the Defender.
export const CARS = {
  defender: { label: 'Defender 110' },
  gclass: {
    label: 'G-Class',
    url: 'models/gclass2021.glb',
    credit: 'Mercedes-Benz G-Class 2021 by ItsDiyor, CC BY 4.0, https://sketchfab.com/3d-models/1768618c049b49fcb0d09a86d6f67c8d',
    wheelbase: 2.907, track: 1.635,
    eye: [-0.40, 1.62, 0.10],           // left-hand drive
    hoodEye: [0, 1.68, -1.05],
    lamps: { head: [0, 0.95, -2.42], bar: [0, 2.02, -0.55], rear: [0, 0.80, 2.62] },
    // [cx, cy, cz, hx, hy, hz, rounding], body frame at static ride (ground y 0), measured off the shell
    colliders: [
      ['Cabin and rear body', [0, 1.30, 0.825, 0.90, 0.68, 1.325, 0.06]],      // sill 0.62 to roof 1.98, windscreen top to rear face 2.15
      ['Bonnet and wings', [0, 0.96, -1.325, 0.90, 0.34, 0.825, 0.06]],        // 0.62 to bonnet 1.30, bumper back to the windscreen
      ['Front bumper', [0, 0.70, -2.24, 0.80, 0.25, 0.14, 0.03]],             // 0.45-0.95, face at -2.38
      ['Rear bumper', [0, 0.585, 2.175, 0.85, 0.165, 0.125, 0.03]],           // 0.42-0.75, face 2.30
      ['Chassis rails', [0, 0.52, 0.05, 0.45, 0.10, 2.05, 0.03]],             // 0.42-0.62
      ['Spare wheel', [0, 1.19, 2.375, 0.42, 0.39, 0.175, 0.06]],             // on the rear door, to 2.55
      ['Belly', [0, 0.51, -0.625, 0.30, 0.09, 1.125, 0.04]],                  // sump, gearbox, transfer case (lowest 0.42)
    ],
  },
};

export const carId = id => (CARS[id] ? id : 'defender');

// write the car's geometry into params (after tuning.applySetup, which leaves these alone)
export function applyCar(P, id) {
  const c = CARS[carId(id)];
  if (!c.wheelbase) return P;
  P.name = c.label;
  P.car = carId(id);
  P.wheelbase = c.wheelbase;
  P.track = c.track;
  P.axles[0].z = -c.wheelbase / 2;
  P.axles[1].z = c.wheelbase / 2;
  P.colliders = c.colliders.map(x => [...x[1]]);
  P.colliderNames = c.colliders.map(x => x[0]);
  P.ownColliders = true;
  return P;
}

// swap the Defender body of a built truck model (truckModel.buildTruck) for the car's shell
export async function fitCarBody(model, id) {
  const c = CARS[carId(id)];
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
    if (m.transparent) { o.castShadow = false; m.depthWrite = false; }
  });
  // hubs at the stock static ride height (front and rear differ a little: tilt to match both)
  const [f, r] = staticRide(applyCar(makeDefenderParams(), id)).map(s => s.hubY);
  shell.position.y = (f + r) / 2;
  shell.rotation.x = Math.asin((f - r) / c.wheelbase);
  model.root.add(shell);
  model.body.visible = false;     // exterior + cockpit
  model.spare.steer.visible = false;
  model.shell = shell;
  model.driverEye = new THREE.Vector3(...c.eye);
  model.hoodEye = new THREE.Vector3(...c.hoodEye);
  for (const k of ['head', 'bar', 'rear']) {
    const L = model.lights[k], p = c.lamps[k];
    const d = L.target.position.clone().sub(L.position);
    L.position.set(...p);
    L.target.position.copy(L.position).add(d);
  }
}
