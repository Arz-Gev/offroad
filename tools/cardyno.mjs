// 0-100 and static ride for each car at its stock setup: node tools/cardyno.mjs [gclass,lancia,...]
import RAPIER from '@dimforge/rapier3d-compat';
import { CAR_SPECS, makeCarParams } from '../src/vehicle/carSpecs.js';
import { STOCK, applySetup, clone, useCar, staticRide } from '../src/vehicle/tuning.js';
import { accelRun } from '../src/vehicle/dyno.js';
await RAPIER.init();
const ids = process.argv[2] ? process.argv[2].split(',') : Object.keys(CAR_SPECS);
for (const id of ids) {
  useCar(id);
  const P = applySetup(makeCarParams(), clone(STOCK));
  const ride = staticRide(P).map(r => `hub ${r.hubY.toFixed(3)} ground ${r.groundY.toFixed(3)} c ${r.c.toFixed(3)}`).join(' | ');
  const out = [];
  for (const gb of ['auto', 'manual']) {
    const it = accelRun(RAPIER, P, { gearbox: gb, pressures: [STOCK.tyres.pressF, STOCK.tyres.pressR] }); let r; while (!(r = it.next()).done);
    out.push(`${gb} ${r.value?.t100 != null ? r.value.t100.toFixed(1) + ' s' : JSON.stringify(r.value).slice(0, 80)}`);
  }
  console.log(id.padEnd(9), P.name, '|', out.join(', '), '|', ride);
}
