// 0-100 km/h with the full physics on a flat pad (src/vehicle/dyno.js, the panel's Measure button),
// for every engine preset or a list, automatic and manual, next to the panel's quick estimate.
//   node tools/dyno.mjs [v8,td5,...]     TUNE='{"tyres":{"size":35}}' merges sections over each setup
import RAPIER from '@dimforge/rapier3d-compat';
import { makeDefenderParams } from '../src/vehicle/params.js';
import { STOCK, applySetup, estimateAccel, clone, ENGINE_ORDER } from '../src/vehicle/tuning.js';
import { accelRun } from '../src/vehicle/dyno.js';
await RAPIER.init();
const engines = process.argv[2] ? process.argv[2].split(',') : ENGINE_ORDER;
for (const e of engines) for (const gb of ['auto', 'manual']) {
  const s = clone(STOCK); s.engine.preset = e;
  if (process.env.TUNE) for (const [k, x] of Object.entries(JSON.parse(process.env.TUNE))) Object.assign(s[k], x);
  const P = applySetup(makeDefenderParams(), s);
  const t0 = performance.now();
  const it = accelRun(RAPIER, P, { gearbox: gb }); let r; while (!(r = it.next()).done);
  const res = r.value;
  console.log(e.padEnd(7), gb.padEnd(6), '0-60', res.t60?.toFixed(2), '0-100', res.t100?.toFixed(2), 's', res.dist?.toFixed(0), 'm  est', estimateAccel(P, gb).t100?.toFixed(2), ' ', (performance.now() - t0).toFixed(0), 'ms');
}
