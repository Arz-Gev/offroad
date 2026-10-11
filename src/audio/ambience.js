// Ambience: birds by day, crickets, a nightingale and an owl at night, a breeze, from short CC0 recordings (public/sfx/, credits in
// README). Each kind sings on its own random timer, each call from a random direction and distance (level, a
// low-pass for the far ones, a slightly different pitch); more birds at dawn, none in the rain and a burst of
// song when a shower clears. The crickets are a seamless loop under the dusk and the night. Loaded after the
// first gesture with the rest of the audio; nothing plays until it has decoded.

// gap: seconds between calls of a kind (random in the range, divided by the dawn chorus); level: at the nearest
const KINDS = [
  { name: 'blackbird', files: ['blackbird-1', 'blackbird-2', 'blackbird-3', 'blackbird-4', 'blackbird-5'], when: 'day', gap: [5, 16], level: 0.3 },
  { name: 'chaffinch', files: ['chaffinch-1', 'chaffinch-2'], when: 'day', gap: [9, 24], level: 0.26 },
  { name: 'robin', files: ['robin'], when: 'day', gap: [18, 45], level: 0.22 },
  { name: 'skylark', files: ['skylark'], when: 'day', gap: [30, 70], level: 0.16, far: true },
  { name: 'dove', files: ['dove'], when: 'day', gap: [25, 60], level: 0.24 },
  { name: 'cuckoo', files: ['cuckoo'], when: 'day', gap: [50, 140], level: 0.2, far: true },
  { name: 'nightingale', files: ['nightingale-1', 'nightingale-2', 'nightingale-3', 'nightingale-4'], when: 'night', gap: [7, 20], level: 0.2 },
  { name: 'owl', files: ['owl-1', 'owl-2', 'owl-3'], when: 'night', gap: [30, 80], level: 0.22, far: true },
];
const rand = (a, b) => a + Math.random() * (b - a);
const sstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Ambience {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.cab = ctx.createBiquadFilter();       // inside the cab the world is muffled
    this.cab.type = 'lowpass'; this.cab.frequency.value = 20000;
    this.bus.connect(this.cab).connect(out);
    this.buffers = {};
    this.timers = KINDS.map(k => ({ kind: k, t: rand(2, k.gap[1]) }));
    this.wasRaining = false;
    this.crickets = null;
  }

  async load(base) {
    const names = new Set(['crickets', 'crickets-2', ...KINDS.flatMap(k => k.files)]);
    await Promise.all([...names].map(async n => {
      try {
        const data = await (await fetch(`${base}sfx/${n}.mp3`)).arrayBuffer();
        this.buffers[n] = await this.ctx.decodeAudioData(data);
      } catch (e) { console.warn('ambience: no', n, e); }
    }));
    if (this.buffers.crickets && this.buffers['crickets-2']) {
      // each file's end is cross-faded into its start (made with ffmpeg acrossfade); the mp3 padding at both ends is
      // skipped. Two recordings of different lengths (a dense chorus, a close regular cricket to one side): one
      // loop alone sounded metronomic
      const g = this.ctx.createGain(); g.gain.value = 0;
      g.connect(this.bus);
      for (const [name, rate, at, side, lvl] of [['crickets-2', 1, 0.06, -0.15, 1], ['crickets', 0.96, 7.3, 0.55, 0.22]]) {
        const c = this.buffers[name], src = this.ctx.createBufferSource();
        src.buffer = c; src.loop = true; src.loopStart = 0.06; src.loopEnd = c.duration - 0.06; src.playbackRate.value = rate;
        const pan = this.ctx.createStereoPanner(); pan.pan.value = side;
        const lg = this.ctx.createGain(); lg.gain.value = lvl;
        src.connect(pan).connect(lg).connect(g);
        src.start(0, at);
      }
      this.crickets = g;
    }
    // a faint breeze in the leaves, gusting slowly
    const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 3, this.ctx.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = n; src.loop = true;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
    this.breeze = this.ctx.createGain(); this.breeze.gain.value = 0;
    src.connect(hp).connect(lp).connect(this.breeze).connect(this.bus);
    src.start();
    this.breezeLp = lp;
    this.ready = true;
  }

  play(kind, far) {
    const ctx = this.ctx, buf = this.buffers[kind.files[Math.floor(Math.random() * kind.files.length)]];
    if (!buf) return;
    const d = far ? rand(0.6, 1) : rand(0.1, 0.9);   // 0 near .. 1 far
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rand(0.96, 1.04);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 16000 * (1 - 0.72 * d);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.85, 0.85);
    const g = ctx.createGain();
    g.gain.value = kind.level * (1 - 0.7 * d);
    src.connect(lp).connect(pan).connect(g).connect(this.bus);
    src.start();
  }

  // a: { dark 0..1, hour, rain 0..1, inside }
  update(dt, a) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const day = 1 - sstep(a.dark, 0.2, 0.55), night = sstep(a.dark, 0.35, 0.75), dry = 1 - sstep(a.rain, 0.05, 0.3);
    this.bus.gain.setTargetAtTime(a.inside ? 0.5 : 0.85, t, 0.2);
    this.cab.frequency.setTargetAtTime(a.inside ? 2400 : 20000, t, 0.1);
    if (this.crickets) this.crickets.gain.setTargetAtTime(0.17 * night * dry, t, 1.5);
    const gust = 0.5 + 0.5 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1.3);
    this.breeze.gain.setTargetAtTime(0.03 + 0.08 * gust * gust, t, 0.8);
    this.breezeLp.frequency.setTargetAtTime(800 + 1600 * gust, t, 0.8);
    // birds sing after rain
    const raining = a.rain > 0.3;
    if (this.wasRaining && a.rain < 0.05) {
      for (const tm of this.timers) if (tm.kind.when === 'day') tm.t = rand(0.5, 6);
      this.wasRaining = false;
    } else if (raining) this.wasRaining = true;
    // the dawn chorus (and a lively evening)
    const h = a.hour ?? 12;
    const chorus = 1 + 1.6 * sstep(h, 4.5, 6) * (1 - sstep(h, 8, 10)) + 0.5 * sstep(h, 17, 18.5) * (1 - sstep(h, 19.5, 21));
    for (const tm of this.timers) {
      const k = tm.kind, on = (k.when === 'day' ? day : night) * dry;
      tm.t -= dt * (k.when === 'day' ? chorus : 1);
      if (tm.t > 0) continue;
      tm.t = rand(k.gap[0], k.gap[1]);
      if (Math.random() < on) this.play(k, k.far);
    }
  }
}
