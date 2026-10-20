import { WINDOW_STEP, Terrain } from './terrain.js';
import { ORIGIN } from './origin.js';

// Keeps a detailed window of the endless world round the truck.
// - The windows are built in a worker (windowWorker.js), a few seconds each; the truck can drive ~250 m from the
//   window's centre before it nears the edge, so there is time at any speed the cars reach.
// - When the truck is more than TRIGGER metres from the centre along x or z, the next window (centred on the
//   nearest multiple of WINDOW_STEP) is asked for. It reaches 250+ m ahead of the truck at 100 km/h: past trees.js
//   SUB_FADE, so the trees coming in with it are hidden (only the far share shows that far, and the far ring has it). When it arrives, its textures and meshes are made over a few frames
//   (prepare's steps, one a frame), then it is swapped in at once (apply): every system takes the new window and
//   everything in the scene and the physics shifts by the difference (origin.js), so the truck is near (0, 0)
//   again.
// - goTo (teleports, joining a friend far away): asks for the window round a point and swaps it in as soon as it
//   is there, all steps in one frame.
// hooks: { prepare(terrain, win) -> [steps], apply(terrain, win, dx, dz, prepared) }

const TRIGGER = 150;   // more than half a step, or the shift would put the truck past the trigger the other way

export class Streamer {
  constructor(seed, hooks) {
    this.hooks = hooks;
    this.worker = new Worker(new URL('./windowWorker.js', import.meta.url), { type: 'module' });
    this.calls = new Map();
    this.nextId = 1;
    this.worker.onmessage = (e) => {
      const m = e.data, key = m.type === 'spawn' ? 'spawn' : m.id, c = this.calls.get(key);
      if (!c) return;
      this.calls.delete(key);
      if (m.type === 'error') c.reject(new Error(m.message)); else c.resolve(m);
    };
    this.worker.onerror = (e) => { for (const c of this.calls.values()) c.reject(e); this.calls.clear(); };
    this.spawn = this.call({ type: 'init', seed }, 'spawn').then(m => m.spawn);
    this.inFlight = null;      // { ox, oz, gen } being built by the worker
    this.job = null;           // a window being prepared: { terrain, win, steps, k, gen }
    this.gen = 0;              // bumped by goTo: windows asked for before it are dropped
    this.windows = 0;
    this.lastTimes = null;
    this.stats = { steps: [], swap: 0 };   // ms of the last window's prepare steps and swap (main thread)
  }

  call(msg, key) {
    const id = key ?? this.nextId++;
    return new Promise((resolve, reject) => { this.calls.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }
  build(ox, oz) { return this.call({ type: 'window', ox, oz }).then(m => m.win); }
  sitesNear(x, z, r) { return this.call({ type: 'sites', x, z, r }).then(m => m.sites); }

  static snap(v) { return Math.round(v / WINDOW_STEP) * WINDOW_STEP; }

  // the first window, round an absolute point: returned as is (the game builds its systems from it)
  async first(x, z) {
    const win = await this.build(Streamer.snap(x), Streamer.snap(z));
    this.lastTimes = win.times;
    this.windows++;
    return win;
  }

  // per frame, with the truck's local position
  update(lx, lz) {
    if (this.job) { this.stepJob(); return; }
    if (this.inFlight) return;
    const tx = Math.abs(lx) > TRIGGER ? Streamer.snap(lx) : 0, tz = Math.abs(lz) > TRIGGER ? Streamer.snap(lz) : 0;
    if (!tx && !tz) return;
    const ox = ORIGIN.x + tx, oz = ORIGIN.z + tz, gen = this.gen;
    this.inFlight = { ox, oz, gen };
    this.build(ox, oz).then(win => {
      this.inFlight = null;
      if (gen !== this.gen) return;                               // a teleport came in between
      const terrain = Terrain.fromData(win);
      this.job = { terrain, win, steps: this.hooks.prepare(terrain, win), k: 0, gen, ms: [] };
    }, err => { console.warn('window', err); this.inFlight = null; });
  }

  stepJob() {
    const j = this.job;
    if (j.gen !== this.gen) { this.job = null; return; }
    if (j.k < j.steps.length) {
      const t0 = performance.now();
      j.steps[j.k++]();
      j.ms.push(Math.round((performance.now() - t0) * 10) / 10);
      return;
    }
    if (this.holdSwap) return;   // tests: stop with the next window ready (then stepJob() swaps it in)
    this.job = null;
    const t0 = performance.now();
    this.swap(j.terrain, j.win);
    this.stats = { steps: j.ms, swap: Math.round((performance.now() - t0) * 10) / 10 };
  }

  swap(terrain, win) {
    const dx = win.ox - ORIGIN.x, dz = win.oz - ORIGIN.z;
    this.hooks.apply(terrain, win, dx, dz);
    this.lastTimes = win.times;
    this.windows++;
  }

  // the window round an absolute point, swapped in as soon as it is built; resolves with the point's local position
  async goTo(x, z) {
    const gen = ++this.gen;
    this.job = null;
    const win = await this.build(Streamer.snap(x), Streamer.snap(z));
    if (gen !== this.gen) return null;
    const terrain = Terrain.fromData(win);
    for (const s of this.hooks.prepare(terrain, win)) s();
    this.swap(terrain, win);
    return { x: x - ORIGIN.x, z: z - ORIGIN.z };
  }

  get busy() { return !!(this.inFlight || this.job); }
}
