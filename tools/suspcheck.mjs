// Static suspension numbers of each car at its stock params (no simulation, instant).
//   node tools/suspcheck.mjs [car ...]      (default: all cars in src/cars/)
// Per axle: static spring compression (sag) and its share of the travel, droop left, room to the bump rubber
// (5 cm before the hard stop) and to the stop, the extra load the springs take before the rubber (in g of
// the static load), the sprung heave frequency (spring only, no tyre), and for 2 axles the roll stiffness
// share of the front (springs at springTrack + bar). Targets for a new car: .claude/skills/add-car/SKILL.md.
import { makeCarParams } from '../src/vehicle/carParams.js';
import { CAR_IDS } from '../src/cars/index.js';
import { axleShares } from '../src/vehicle/suspension.js';

const G = 9.81, cm = x => (x * 100).toFixed(1);
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : CAR_IDS) {
  const P = makeCarParams(id), sh = axleShares(P);
  console.log(`${P.name}: sprung ${P.bodyMass} kg, ${P.axles.length} axles`);
  const roll = [];
  P.axles.forEach((a, i) => {
    const load = P.bodyMass * G * sh[i] / 2;   // per wheel
    const sag = load / a.k - (a.preload || 0);
    const hz = Math.sqrt(a.k / (load / G)) / (2 * Math.PI);
    const rubber = a.travel - 0.05 - sag;
    roll.push(a.k * (a.springTrack ?? P.track) ** 2 / 2 + (a.arb || 0));
    console.log(`  axle ${a.name.padEnd(5)} ${(a.type || 'beam').padEnd(11)} k ${a.k}  travel ${cm(a.travel)}  sag ${cm(sag)} (${Math.round(100 * sag / a.travel)} %)` +
      `  to rubber ${cm(rubber)}  to stop ${cm(a.travel - sag)} cm  margin ${(a.k * rubber / load).toFixed(2)} g  ${hz.toFixed(2)} Hz`);
  });
  if (P.axles.length === 2) {
    const L = P.wheelbase, front = (L / 2 - P.com[2]) / L;
    console.log(`  weight ${Math.round(100 * front)} % front, roll stiffness ${Math.round(100 * roll[0] / (roll[0] + roll[1]))} % front (springs + bars)`);
  }
}
