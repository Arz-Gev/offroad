import * as THREE from 'three';
import { mergeStatic } from '../geom.js';
import { steelWheel } from '../wheels.js';
import { buildExterior } from './body.js';
import { buildInterior } from './interior.js';

// The procedural Defender 110 station wagon (after reference.webp): exterior (body.js), cabin with gauges and
// levers (interior.js), the spare wheel on the rear door. A body source for model/index.js (look.body 'defender'):
// the body group, lamp places, the driver's eye, the cabin's moving parts, lens materials and its own moving
// extras (the spare follows the tyre size).

export function defenderBody(mats) {
  const body = new THREE.Group();
  const ext = buildExterior(mats, body);
  const cab = buildInterior(mats, body);

  // spare wheel on the rear door (a plain tyre: it carries no load)
  const spare = steelWheel(mats, 1, false);
  spare.steer.position.set(0, 1.17, 2.33 + 0.245);
  spare.steer.rotation.y = -Math.PI / 2;
  body.add(spare.steer);

  // merge static geometry (one draw per material); the moving parts stay apart
  const dynamic = new Set([...cab.dynamic, spare.steer]);
  mergeStatic(body, o => dynamic.has(o) || o.userData.keep);
  mergeStatic(spare.steer);
  mergeStatic(cab.steeringWheel);

  const L = mats;
  return {
    body,
    lamps: ext.anchors,
    eye: cab.driverEye,
    cockpit: { steeringWheel: cab.steeringWheel, gearLever: cab.gearLever, transferLever: cab.transferLever, needles: cab.needles,
      gaugeMat: cab.gaugeMat, needleMat: cab.needleMat, warnMat: cab.warnMat },
    lenses: { head: [L.headLens], side: [L.sideLens], aux: [L.auxLens], work: [L.workLens], tail: [L.tail], brake: [L.brake],
      reverse: [L.reverse], amber: [L.amber], beacon: [L.beacon] },
    kits: [{
      // the spare follows the tuned tyre size, its face stays at the door
      update(view, v) {
        const P = v.P, sp = spare.steer, wx = P.tire.width / 0.27, spS = P.tire.radius / 0.42;
        if (sp.scale.y !== spS || sp.scale.x !== wx) { sp.scale.set(wx, spS, spS); sp.position.z = 2.33 + 0.11 + 0.135 * wx; }
      },
    }],
  };
}
