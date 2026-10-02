// "Measure 0-100": the real vehicle physics (same Vehicle, same params, 240 Hz) on a flat dirt test pad,
// in its own Rapier world. Runs in a worker (dyno.worker.js) so the game keeps its frame rate; the panel
// falls back to running it in slices on the main thread if workers are unavailable.
import { Vehicle } from './Vehicle.js';

const H = 1 / 240;

export function* accelRun(RAPIER, P, { gearbox = 'auto', pressures = [20, 20], target = 100, maxT = 45, stepsPerYield = 240 } = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  // 24 m x 1400 m flat strip (the truck runs towards -z)
  const n = 8, m = 280, heights = new Float32Array((n + 1) * (m + 1));
  world.createCollider(RAPIER.ColliderDesc.heightfield(n, m, heights, { x: 24, y: 1, z: 1400 }).setFriction(0.8));
  world.step();
  const v = new Vehicle(RAPIER, world, P, { position: { x: 0, y: 0.15 + (P.tire.radius - 0.42), z: 650 } });
  v.pressures = [...pressures];
  const d = v.drivetrain;
  if (gearbox === 'manual') d.toggleMode();
  // no steering: the pad is flat and the truck symmetric (a lane-keeping correction scrubbed the tyres)
  const raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0 };
  // settle on the springs, then select first / D
  for (let i = 0; i < 360; i++) { v.step(H, raw); world.step(); }
  if (gearbox === 'manual') { d.requestShift(1); for (let i = 0; i < 120; i++) { v.step(H, raw); world.step(); } }
  else d.setSelector('D');
  const z0 = v.pos.z;
  const samples = [];
  let t = 0, t60 = null, t100 = null, dist = null, i = 0;
  raw.throttle = 1;
  const shiftAt = (P.engine.shiftRpm || 4800) - 150;
  while (t < maxT) {
    if (gearbox === 'manual' && d.rpm > shiftAt && !d.shift && d.manualGear < P.manual.ratios.length) d.requestShift(1);
    v.step(H, raw); world.step();
    t += H; i++;
    const kmh = v.speed * 3.6;
    if (i % 24 === 0) samples.push([+t.toFixed(2), +kmh.toFixed(1), Math.round(d.rpm), d.gearLabel()]);
    if (t60 === null && kmh >= 60) t60 = t;
    if (kmh >= target) { t100 = t; dist = z0 - v.pos.z; break; }
    if (i % stepsPerYield === 0) yield { t, kmh, gear: d.gearLabel() };
  }
  world.free();
  return { t60, t100, dist, samples, gearbox };
}
