import defender from './defender.js';
import gclass from './gclass.js';
import lancia from './lancia.js';
import btr80 from './btr80.js';

// The cars, in the order the menu shows them. One file per car (src/cars/README.md); adding a car is
// one import and one entry here. The first one is the default car.
export const CAR_LIST = [defender, gclass, lancia, btr80];

export const CARS = Object.fromEntries(CAR_LIST.map(c => [c.id, c]));
export const CAR_IDS = CAR_LIST.map(c => c.id);
export const DEFAULT_CAR = CAR_IDS[0];
export const isCar = id => Object.hasOwn(CARS, id);
export const carDef = id => CARS[isCar(id) ? id : DEFAULT_CAR];

// the car this page drives (Settings: Vehicle; changing it reloads the page, so it is set once at start-up)
let current = DEFAULT_CAR;
export const setCar = id => { current = isCar(id) ? id : DEFAULT_CAR; };
export const getCar = () => current;

// a broken entry fails here, at start-up and in npm run simtest, not later in a menu
for (const c of CAR_LIST) if (!c.id || !c.label || !c.physics || !c.look) throw new Error(`src/cars: ${c.id || '?'} needs id, label, physics and look`);
if (new Set(CAR_IDS).size !== CAR_IDS.length) throw new Error('src/cars: two cars share an id');
