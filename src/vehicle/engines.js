// The engine catalogue: every engine a car can have, by preset id. A car names its stock engine and the
// engines its tuning panel offers (src/cars/<id>.js: physics.engine); the same engine can sit in several
// cars. Curves: gross torque (Nm) at full throttle. Real figures are net (flywheel) torque: gross() adds
// the friction the drivetrain subtracts again. shiftRpm: automatic upshift at full throttle.

// engine friction + pumping at full throttle (drivetrain.js substep, thr = 1)
export const engineFriction = rpm => 12 + 0.0085 * Math.abs(rpm) + 1.2e-6 * rpm * rpm;
// a published (net, at the flywheel) torque curve -> the gross curve the drivetrain uses
const gross = net => net.map(([r, t]) => [r, t > 0 ? Math.round(t + engineFriction(r)) : 0]);

export const ENGINES = {
  v8: {
    label: '4.6 V8', name: '4.6 V8 petrol', fuel: 'petrol', note: 'Stock. Rover V8, 225 PS. Smooth and quick.',
    torque: [[0, 0], [400, 150], [800, 300], [1200, 365], [1600, 405], [2000, 435], [2500, 455], [3000, 462],
      [3500, 458], [4000, 445], [4500, 420], [5000, 385], [5500, 330], [6000, 250], [6500, 120]],
    idleRpm: 720, limiterRpm: 5350, redlineRpm: 5000, shiftRpm: 4800, inertia: 0.22,
  },
  works: {
    label: '5.0 V8', name: 'Works V8 5.0 petrol', fuel: 'petrol', note: 'Land Rover Classic Works V8: 405 PS, 515 Nm. Revs to 6800.',
    torque: gross([[0, 0], [400, 150], [800, 330], [1200, 380], [2000, 430], [3000, 475], [4000, 505], [4500, 515],
      [5000, 510], [5500, 495], [6000, 474], [6500, 430], [7000, 300], [7500, 120]]),
    idleRpm: 650, limiterRpm: 6800, redlineRpm: 6500, shiftRpm: 6300, inertia: 0.2,
  },
  v35: {
    label: '3.5 V8', name: '3.5 V8 petrol (carburettor)', fuel: 'petrol', note: 'The 1983 110: 114 PS, 251 Nm. Slow but sweet.',
    torque: gross([[0, 0], [400, 80], [800, 170], [1200, 210], [1600, 230], [2000, 243], [2500, 251], [3000, 247],
      [3500, 232], [4000, 203], [4500, 170], [5000, 125], [5500, 70], [6000, 20]]),
    idleRpm: 700, limiterRpm: 5000, redlineRpm: 4750, shiftRpm: 4500, inertia: 0.24,
  },
  tdi300: {
    label: '300Tdi', name: '2.5 300Tdi diesel', fuel: 'diesel', note: '1994–98: 111 PS, 265 Nm at 1800. Pulls low, runs out of breath at 4000.',
    torque: gross([[0, 0], [400, 50], [800, 130], [1200, 200], [1500, 245], [1800, 265], [2400, 255], [3000, 235],
      [3500, 215], [4000, 198], [4400, 120], [4700, 40]]),
    idleRpm: 720, limiterRpm: 4400, redlineRpm: 4000, shiftRpm: 3900, inertia: 0.32,
  },
  td5: {
    label: 'Td5', name: '2.5 Td5 diesel', fuel: 'diesel', note: '1998–2007: 122 PS, 300 Nm at 1950. Pulls from low revs, takes its time to 100.',
    torque: gross([[0, 0], [400, 60], [800, 150], [1200, 215], [1500, 265], [1950, 300], [2500, 292], [3000, 270],
      [3500, 245], [4000, 215], [4200, 205], [4500, 150], [4800, 60]]),
    idleRpm: 760, limiterRpm: 4600, redlineRpm: 4300, shiftRpm: 4200, inertia: 0.3,
  },
  puma: {
    label: '2.4 TDCi', name: '2.4 TDCi Puma diesel', fuel: 'diesel', note: '2007–11: 122 PS, 360 Nm at 2000. The most torque of the diesels.',
    torque: gross([[0, 0], [400, 60], [800, 140], [1200, 230], [1500, 310], [2000, 360], [2500, 355], [3000, 315],
      [3500, 250], [4000, 170], [4300, 60]]),
    idleRpm: 780, limiterRpm: 4200, redlineRpm: 4000, shiftRpm: 3800, inertia: 0.3,
  },
  g500: {
    label: '4.0 V8 biturbo', name: 'Mercedes 4.0 V8 biturbo petrol', fuel: 'petrol', note: 'G 500 (2018+): 422 PS, 610 Nm from 2000 to 4750.',
    torque: gross([[0, 0], [400, 150], [800, 330], [1200, 450], [1600, 560], [2000, 610], [3000, 610], [4000, 610], [4750, 610],
      [5250, 565], [5750, 515], [6200, 440], [6600, 200]]),
    idleRpm: 650, limiterRpm: 6300, redlineRpm: 6000, shiftRpm: 5800, inertia: 0.2,
  },
  lancia: {
    label: '2.0 turbo', name: 'Lancia 2.0 16v turbo petrol', fuel: 'petrol', note: 'Delta Integrale Evo 2: 215 PS at 5750, 314 Nm at 2500.',
    torque: gross([[0, 0], [500, 60], [1000, 120], [1500, 180], [2000, 260], [2500, 314], [3000, 310], [3500, 300], [4000, 295],
      [4500, 288], [5000, 280], [5750, 262], [6250, 230], [6800, 150], [7200, 40]]),
    idleRpm: 900, limiterRpm: 6800, redlineRpm: 6500, shiftRpm: 6300, inertia: 0.14,
  },
  // BTR-80 (8x8, 13.6 t). Real figures from the manufacturers' published curves (net, flywheel).
  kamaz: {
    label: 'KamAZ-7403', name: 'KamAZ-7403 10.85 V8 turbodiesel', fuel: 'diesel', note: 'Stock BTR-80: 260 PS at 2600, 785 Nm at 1600–1800. All-speed governor.',
    torque: gross([[0, 0], [400, 300], [600, 560], [800, 625], [1000, 680], [1200, 730], [1400, 765], [1600, 785], [1800, 785],
      [2000, 772], [2200, 750], [2400, 726], [2600, 700], [2700, 420], [2800, 120], [2850, 0]]),
    idleRpm: 600, limiterRpm: 2900, redlineRpm: 2600, shiftRpm: 2450, inertia: 2.2,
  },
  yamz: {
    label: 'YaMZ-238M2', name: 'YaMZ-238M2 14.86 V8 diesel', fuel: 'diesel', note: 'BTR-80 with the YaMZ engine: 240 PS at 2100, 883 Nm at 1250–1450. Slower, pulls lower.',
    torque: gross([[0, 0], [400, 320], [600, 640], [800, 760], [1000, 840], [1250, 883], [1450, 883], [1700, 860], [1900, 835],
      [2100, 818], [2200, 480], [2300, 120], [2350, 0]]),
    idleRpm: 550, limiterRpm: 2400, redlineRpm: 2100, shiftRpm: 2000, inertia: 2.6,
  },
};

// the road-car family: the Defender's engines and the other 4x4s' (a car offers these unless it lists its own)
export const ROAD_ENGINES = ['v8', 'works', 'v35', 'tdi300', 'td5', 'puma', 'g500', 'lancia'];
