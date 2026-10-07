// Offline render of an engine start (the real drivetrain physics + the engine worklet) to WAV, so the
// start can be compared with recordings (spectrogram: ffmpeg -i start.wav -lavfi showspectrumpic=... x.png).
//   node tools/startsound.mjs [out.wav] [seconds]
// 0.5 s of silence (engine off, parked in P), then I is pressed. The game sends the worklet its
// parameters once per frame (60 Hz, setTargetAtTime 10 ms); this does the same.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicle/Vehicle.js';
import { makeCarParams } from '../src/vehicle/carParams.js';
import { SURFACES } from '../src/vehicle/tire.js';

const SR = 48000, H = 1 / 240;
const out = process.argv[2] || 'start.wav', secs = +(process.argv[3] || 6);
let Proc = null;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_, cls) => { Proc = cls; };
await import(pathToFileURL(path.resolve('src/audio/engine-worklet.js')).href);
const p = new Proc();

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = H;
world.createCollider(RAPIER.ColliderDesc.heightfield(20, 20, new Float32Array(21 * 21), { x: 200, y: 1, z: 200 }));
world.step();
const v = new Vehicle(RAPIER, world, makeCarParams('defender'), { position: { x: 0, y: 0.12, z: 0 }, surfaceAt: () => SURFACES.dirt });
const d = v.drivetrain, raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0 };
d.setSelector('P');
for (let i = 0; i < 240; i++) { v.step(H, raw); world.step(); }
d.stopEngine();
for (let i = 0; i < 240 * 3; i++) { v.step(H, raw); world.step(); }

const N = Math.round(secs * SR), buf = new Float32Array(N);
const prm = { rpm: [0], load: [0], throttle: [0], starter: [0], running: [0] };
const tgt = { rpm: 0, load: 0, throttle: 0 };
let t = 0, physT = 0, frameT = 0, started = false;
const log = [];
for (let i = 0; i < N; i += 128) {
  const tb = i / SR;
  if (!started && tb >= 0.5) { d.startEngine(); started = true; }
  while (physT < tb) { v.step(H, raw); world.step(); physT += H; }
  if (tb >= frameT) { // one game frame: new targets
    frameT += 1 / 60;
    tgt.rpm = d.rpm; tgt.load = Math.max(0, Math.min(1, d.load)); tgt.throttle = d.thr;
    prm.starter[0] = d.cranking ? 1 : 0; prm.running[0] = d.running ? d.fire : 0;
    if (Math.round(tb * 60) % 6 === 0) log.push(`${tb.toFixed(2)}s ${Math.round(d.rpm)}rpm${d.cranking ? ' crank' : ''}${d.running ? ' run' : ''}`);
  }
  const k = 1 - Math.exp(-(128 / SR) / 0.01);   // setTargetAtTime(…, 0.01)
  prm.rpm[0] += (tgt.rpm - prm.rpm[0]) * k;
  prm.load[0] += (tgt.load - prm.load[0]) * (1 - Math.exp(-(128 / SR) / 0.03));
  prm.throttle[0] += (tgt.throttle - prm.throttle[0]) * (1 - Math.exp(-(128 / SR) / 0.03));
  const ch = new Float32Array(Math.min(128, N - i));
  p.process([], [[ch]], prm);
  buf.set(ch, i);
}
const data = Buffer.alloc(44 + N * 2);
data.write('RIFF', 0); data.writeUInt32LE(36 + N * 2, 4); data.write('WAVE', 8);
data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
data.write('data', 36); data.writeUInt32LE(N * 2, 40);
for (let j = 0; j < N; j++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[j] * 32767))), 44 + j * 2);
fs.writeFileSync(out, data);
console.log(log.join('  '));
console.log(`wrote ${out}`);
