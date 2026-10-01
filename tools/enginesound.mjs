// Offline render of the engine worklet to WAV, so the sound can be checked without a browser.
//   node tools/enginesound.mjs [out.wav] [worklet path]
// Plays a fixed script (idle, blips, lugging, cruise, overrun) and prints per-segment level stats.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SR = 48000;
const out = process.argv[2] || 'engine.wav';
const workletPath = path.resolve(process.argv[3] || 'src/audio/engine-worklet.js');

let Proc = null;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_, cls) => { Proc = cls; };
await import(pathToFileURL(workletPath).href + '?t=' + Date.now());
const p = new Proc();

// [seconds, rpm, load, throttle, label]
const SCRIPT = [
  [3.0, 720, 0.12, 0, 'idle'],
  [0.6, 2200, 0.6, 0.6, 'blip up'],
  [1.2, 720, 0.0, 0, 'blip down'],
  [2.0, 720, 0.12, 0, 'idle'],
  [3.0, 1100, 0.95, 1, 'lugging 1100 WOT'],
  [3.0, 1600, 0.35, 0.3, 'crawl 1600 part'],
  [3.0, 2600, 0.3, 0.25, 'cruise 2600'],
  [2.5, 4600, 1.0, 1, 'WOT 4600'],
  [2.5, 2200, 0.0, 0, 'overrun'],
];
const total = SCRIPT.reduce((s, r) => s + r[0], 0);
const N = Math.round(total * SR);
const buf = new Float32Array(N);
const block = 128;
const stats = [];
let i = 0;
for (const [secs, rpm, load, thr, label] of SCRIPT) {
  const n = Math.round(secs * SR), start = i;
  const params = { rpm: [rpm], load: [load], throttle: [thr], starter: [0], running: [1] };
  for (let k = 0; k < n; k += block) {
    const ch = new Float32Array(Math.min(block, n - k));
    p.process([], [[ch]], params);
    buf.set(ch, i); i += ch.length;
  }
  // stats over the last second (after the rpm glide)
  let sum = 0, peak = 0;
  const a = Math.max(start, i - SR);
  for (let j = a; j < i; j++) { sum += buf[j] * buf[j]; peak = Math.max(peak, Math.abs(buf[j])); }
  const rms = Math.sqrt(sum / (i - a));
  stats.push(`${label.padEnd(18)} rms ${(20 * Math.log10(rms + 1e-9)).toFixed(1)} dBFS  peak ${(20 * Math.log10(peak + 1e-9)).toFixed(1)}  crest ${(peak / rms).toFixed(1)}`);
}
// 16-bit WAV
const data = Buffer.alloc(44 + N * 2);
data.write('RIFF', 0); data.writeUInt32LE(36 + N * 2, 4); data.write('WAVE', 8);
data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
data.write('data', 36); data.writeUInt32LE(N * 2, 40);
for (let j = 0; j < N; j++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[j] * 32767))), 44 + j * 2);
fs.writeFileSync(out, data);
console.log(stats.join('\n'));
console.log(`wrote ${out} (${total.toFixed(1)} s)`);
