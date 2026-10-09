import { carDef, getCar } from '../cars/index.js';
import { PARAM_DEFAULTS, AXLE_DEFAULTS } from './defaults.js';
import { ENGINES } from './engines.js';
import { tireRadialStiffness, tyreRadius, tyreWidth } from './tire.js';
import { axleShares } from './suspension.js';

// A car's physics params P: its file's physics (src/cars/<id>.js) over the defaults (defaults.js), plus
// what follows from them. One path for every car.
//
// Vehicle frame: +x right, +y up, -z forward; y = 0 is the ground at static ride, z = 0 the middle of
// the wheelbase. Derived here:
// - tyre radius and width from the nominal size in inches;
// - axle z (+-wheelbase / 2 on two axles, else stated) and names (front / rear, else 1, 2, ...);
// - springTrack and damperTrack of an independent axle: the wheel track (its rates are wheel rates);
// - droopY (axle / hub height at full droop) so the static ride puts the ground at y 0 with the body
//   level, unless the axle states it; `raise` lifts the body higher (ground clearance, not travel);
// - kinC0, an independent axle's static compression: its kinematic curves are referenced to it;
// - the engine: the catalogue entry of physics.engine.preset (engines.js) with the car's overrides;
// - colliders: [name, box] -> P.colliders + P.colliderNames; colliderFrame 'hub' boxes are measured from
//   the static hub height and moved into the body frame.

const G = 9.81;
const clone = o => JSON.parse(JSON.stringify(o));
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
// deep merge of plain objects; arrays and values replace
function merge(into, from) {
  for (const k of Object.keys(from)) into[k] = isObj(from[k]) && isObj(into[k]) ? merge(into[k], from[k]) : clone(from[k]);
  return into;
}

export function makeCarParams(id = getCar()) {
  return paramsFromDef(carDef(id));
}

export function paramsFromDef(def) {
  const c = def.physics;
  const { engine, axles, tire, colliders, load, ...rest } = c;
  const P = merge(clone(PARAM_DEFAULTS), rest);
  P.car = def.id;

  // engine: the catalogue's stock curve and speeds, then the car's own starter and governor numbers
  const E = ENGINES[engine.preset];
  const { preset, choices, ...own } = engine;
  P.engine = merge(P.engine, { name: E.label, preset, fuel: E.fuel, torque: E.torque, idleRpm: E.idleRpm,
    limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm, shiftRpm: E.shiftRpm, inertia: E.inertia, ...own });
  P.engineChoices = [...choices];

  P.tire = merge(P.tire, tire);
  P.tire.radius = tyreRadius(tire.size);
  P.tire.width = tyreWidth(tire.widthIn);

  const nA = axles.length;
  P.axles = axles.map((a, i) => {
    const ax = merge(clone(AXLE_DEFAULTS), a);
    ax.name ??= nA === 2 ? ['front', 'rear'][i] : String(i + 1);
    ax.z ??= nA === 2 ? (i === 0 ? -1 : 1) * P.wheelbase / 2 : undefined;
    if (ax.z === undefined) throw new Error(`${def.id}: axle ${ax.name} needs z (more than two axles)`);
    if (ax.type === 'independent') { ax.springTrack ??= P.track; ax.damperTrack ??= P.track; }
    return ax;
  });

  const shares = axleShares(P), mt = P.axles.reduce((s, a) => s + a.mass, P.bodyMass);
  const kt = tireRadialStiffness(P.tire.pressure, P.tire.kScale ?? 1);
  const squash = P.axles.map((a, i) => mt * G * shares[i] / 2 / kt);
  P.axles.forEach((a, i) => {
    const compression = P.bodyMass * G * shares[i] / 2 / a.k - a.preload;
    a.droopY ??= P.tire.radius - squash[i] - compression - (P.raise || 0);
    if (a.type === 'independent') a.kinC0 = compression;
  });

  const hubY = P.tire.radius - squash.reduce((s, x) => s + x, 0) / nA;   // mean static hub height
  P.colliders = colliders.map(([, box]) => { const b = [...box]; if (P.colliderFrame === 'hub') b[1] += hubY; return b; });
  P.colliderNames = colliders.map(([name]) => name);
  P.load = clone(load);
  return P;
}
