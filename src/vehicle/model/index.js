import * as THREE from 'three';
import { carDef } from '../../cars/index.js';
import { makeCarParams } from '../carParams.js';
import { staticRide } from '../tuning.js';
import { createMaterials } from './materials.js';
import { buildLightRig, modelLenses } from './lamps.js';
import { loadShell, placeShell, take } from './shell.js';
import { steelWheel, modelWheels } from './wheels.js';
import { beamAxle } from './beamAxle.js';
import { wishboneCorners } from './wishbones.js';
import { turretRig } from './turretRig.js';
import { cockpitKit, pivotFromNode } from './cockpit.js';
import { defenderBody } from './defender/index.js';
import { lightBar } from './accessories.js';

// A car's model, built from its file's look (src/cars/<id>.js) and its physics (the axle types): the same
// steps for every car, each part chosen by data.
//   body      look.body 'defender' (the procedural Defender) or look.url (a downloaded shell)
//   wheels    the shell's own (look.wheel, model/wheels.js) or our steel wheels
//   running   per axle by its physics type: a beam axle kit (beamAxle.js), or the model's own wishbones
//   gear      (look.suspension, wishbones.js)
//   lamps     beams at look.lamps (or the body's lamp places), lens glow by role (lamps.js)
//   cockpit   the cabin's moving parts: the procedural body's, or the shell's nodes (look.cockpit)
//   extras    a turret (look.turret, turretRig.js), a roof light bar (look.lightBar, accessories.js)
//   cameras   look.eye / hoodEye / chase
// The result is what VehicleView drives: { root, wheels, kits (each with update(view, v, dt)), cockpit,
// lenses, lights, driverEye, hoodEye, chaseDist, chaseTarget, turret, shell }. Body frame: +x right,
// +y up, -z forward, y 0 the ground at static ride, z 0 mid-wheelbase.

export async function buildCarModel(id) {
  const car = carDef(id), look = car.look;
  const P = makeCarParams(car.id);   // stock: the view scales the wheels and follows the lift
  const ride = staticRide(P);
  const nA = P.axles.length;
  const mats = createMaterials();
  const root = new THREE.Group();
  root.name = 'vehicle';
  const model = { id: car.id, root, wheels: [], kits: [], mats };

  // ---------------- body
  let shell = null, hubY = 0, src = null;
  if (look.body === 'defender') {
    src = defenderBody(mats);
    root.add(src.body);
    model.body = src.body;
    model.kits.push(...src.kits);
  } else {
    shell = await loadShell(look.url);
    model.shell = shell;
  }

  // ---------------- wheels (the shell's are taken out of it before it is placed: they come relative to their hubs)
  const wheels = shell ? modelWheels(shell, P, look) : P.axles.flatMap((a, ai) => [-1, 1].map(s => ({ ...steelWheel(mats, s), axle: ai })));
  model.wheels = wheels;
  if (shell) {
    hubY = placeShell(shell, P, ride, P.raise || 0);
    root.add(shell);
    shell.updateMatrixWorld(true);
  }

  // ---------------- running gear per axle
  for (let ai = 0; ai < nA; ai++) {
    const ap = P.axles[ai], ws = wheels.filter(w => w.axle === ai);
    if (ap.type === 'independent') {
      // the wheels hang on the body frame at their static hubs; VehicleView moves them with the corners
      for (const w of ws) { w.steer.position.set(w.side * P.track / 2, ride[ai].hubY, ap.z); root.add(w.steer); }
    } else model.kits.push(beamAxle(root, mats, P, ai, ws, look.runningGear));
  }
  if (look.suspension?.parts === 'wishbones' && shell) model.kits.push(wishboneCorners(root, shell, P, wheels, look.suspension, take, hubY));

  // ---------------- extras
  if (look.turret && shell) {
    const t = turretRig(root, shell, look.turret, take, hubY);
    model.turret = t.turret;
    model.kits.push(t);
  }

  // ---------------- lamps (a light bar carries the bar beam and its lenses)
  const lamps = { ...(look.lamps || src.lamps) };
  model.lenses = src ? src.lenses : modelLenses(shell, look.lamps?.lenses);
  if (look.lightBar) {
    const lb = lightBar(mats, look.lightBar);
    root.add(lb.group);
    lamps.bar = lb.beam;
    for (const [role, mats_] of Object.entries(lb.lenses)) model.lenses[role] = [...(model.lenses[role] || []), ...mats_];
  }
  model.lights = buildLightRig(root, lamps);

  // ---------------- cockpit and cameras
  model.driverEye = new THREE.Vector3(...(look.eye || src.eye.toArray()));
  model.hoodEye = look.hoodEye ? new THREE.Vector3(...look.hoodEye) : null;
  if (look.chase) { model.chaseDist = look.chase.dist; model.chaseTarget = look.chase.target; }
  let cockpit = src?.cockpit;
  if (!cockpit && look.cockpit && shell) {
    cockpit = {};
    for (const part of ['steeringWheel', 'gearLever', 'transferLever']) {
      const node = look.cockpit[part] && shell.getObjectByName(look.cockpit[part]);
      if (node) cockpit[part] = pivotFromNode(node, root, model.driverEye, { base: part !== 'steeringWheel' });   // root: still at the origin, world = body frame
    }
  }
  if (cockpit) model.cockpit = cockpitKit(cockpit);

  root.traverse(o => { if (o.isMesh) o.frustumCulled = true; });
  return model;
}
