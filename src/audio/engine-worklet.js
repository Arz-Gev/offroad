// Procedural cross-plane V8 engine sound.
// Every combustion event (8 per 720 deg) kicks an exhaust pulse into the bank it belongs to.
// Firing order 1-8-4-3-6-5-7-2 with odd cylinders on the left bank gives the uneven
// per-bank pattern L R R L R L L R that makes a V8 burble. Each bank runs through its own pipe
// resonances, then both merge, get a load dependent low-pass and a soft clip.

class Biquad {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }
  bandpass(f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w), n = 1 + a;
    this.b0 = a / n; this.b1 = 0; this.b2 = -a / n; this.a1 = -2 * c / n; this.a2 = (1 - a) / n;
  }
  lowpass(f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w), n = 1 + a;
    this.b0 = (1 - c) / 2 / n; this.b1 = (1 - c) / n; this.b2 = this.b0; this.a1 = -2 * c / n; this.a2 = (1 - a) / n;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: -2000, maxValue: 9000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'starter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'running', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.sr = sampleRate;
    this.phase = 0;
    this.bank = [0, 1, 1, 0, 1, 0, 0, 1];
    this.cylGain = [1.0, 0.9, 1.08, 0.95, 1.05, 0.92, 1.06, 0.97];
    this.jit = [0, 0.006, -0.004, 0.003, -0.005, 0.004, 0.002, -0.003];
    this.env = [0, 0];
    this.rpm = 0; this.load = 0; this.thr = 0;
    this.seed = 22222;
    this.res = [[new Biquad(), new Biquad(), new Biquad()], [new Biquad(), new Biquad(), new Biquad()]];
    this.lp = new Biquad(); this.lp2 = new Biquad();
    this.intake = new Biquad();
    this.mech = new Biquad();
    this.delay = new Float32Array(256); this.dp = 0;
    this.k = 0;
    this.crackle = 0;
    this.starterPh = 0;
    this.dc = 0;
  }
  rand() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }

  updateFilters() {
    const sr = this.sr, r = Math.max(this.rpm, 50);
    // pipe resonances shift a little with exhaust gas temperature (load / rpm)
    const t = 1 + this.load * 0.08 + r / 40000;
    const f = [[92 * t, 1.4], [255 * t, 2.6], [820 * t, 2.0]];
    const g = [[104 * t, 1.5], [290 * t, 2.4], [930 * t, 2.2]];
    for (let i = 0; i < 3; i++) { this.res[0][i].bandpass(f[i][0], f[i][1], sr); this.res[1][i].bandpass(g[i][0], g[i][1], sr); }
    const cut = 600 + 2600 * this.load + r * 0.55 + 600 * this.thr;
    this.lp.lowpass(cut, 0.8, sr);
    this.lp2.lowpass(cut * 1.6, 0.7, sr);
    this.intake.bandpass(1300 + r * 0.25, 1.2, sr);
    this.mech.bandpass(2600 + r * 0.3, 2.5, sr);
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    const ch0 = out[0], ch1 = out[1] || null;
    const rpmT = params.rpm[0], loadT = params.load[0], thrT = params.throttle[0];
    const starter = params.starter[0], running = params.running[0];
    const sr = this.sr;
    for (let i = 0; i < ch0.length; i++) {
      this.rpm += (rpmT - this.rpm) * 0.0015;
      this.load += (loadT - this.load) * 0.002;
      this.thr += (thrT - this.thr) * 0.002;
      if ((this.k++ & 63) === 0) this.updateFilters();
      const rpm = Math.max(0, this.rpm);
      const prev = this.phase;
      this.phase += rpm / 120 / sr;
      if (this.phase >= 1) this.phase -= 1;
      // combustion events
      for (let c = 0; c < 8; c++) {
        let o = c / 8 + this.jit[c];
        if (o < 0) o += 1;
        const crossed = prev <= this.phase ? (prev < o && this.phase >= o) : (prev < o || this.phase >= o);
        if (!crossed) continue;
        let a;
        if (running > 0.5) {
          a = 0.22 + 0.78 * this.load;
          // overrun: weak pulses, occasional crackle on the lift
          if (this.load < 0.08 && rpm > 1800) { a = 0.13 + 0.05 * this.rand(); if (this.rand() < 0.02 * Math.min(1, (rpm - 1800) / 2000)) this.crackle = 0.7 + this.rand() * 0.6; }
          a *= this.cylGain[c] * (0.88 + 0.24 * this.rand());
        } else {
          a = starter > 0.5 ? 0.06 * this.cylGain[c] : 0.0; // compression puffs while cranking
        }
        this.env[this.bank[c]] += a;
      }
      const tau = 0.0016 + 0.9 / Math.max(rpm, 300);
      const dec = Math.exp(-1 / (tau * sr * 0.5));
      let y = 0;
      for (let b = 0; b < 2; b++) {
        const n = this.rand() * 2 - 1;
        const x = this.env[b] * (0.75 + 0.45 * n);
        this.env[b] *= dec;
        const r = this.res[b];
        let s = 1.15 * r[0].run(x) + 0.75 * r[1].run(x) + 0.35 * r[2].run(x) + 0.12 * x;
        if (b === 1) { // longer pipe on the right bank
          this.delay[this.dp] = s;
          s = this.delay[(this.dp + 256 - 55) & 255];
          this.dp = (this.dp + 1) & 255;
        }
        y += s;
      }
      if (this.crackle > 0.01) { y += this.crackle * (this.rand() * 2 - 1) * 0.6; this.crackle *= 0.985; }
      let s = this.lp.run(y) * 0.8 + this.lp2.run(y) * 0.3;
      // intake roar and valvetrain
      const nz = this.rand() * 2 - 1;
      s += this.intake.run(nz) * 0.05 * this.thr * Math.min(1, rpm / 2500) * (0.5 + this.env[0] + this.env[1]);
      s += this.mech.run(nz) * 0.012 * Math.min(1, rpm / 3000);
      // starter motor whine
      if (starter > 0.5) {
        this.starterPh += 2 * Math.PI * (180 + rpm * 0.4) / sr;
        s += 0.05 * Math.sin(this.starterPh) + 0.03 * Math.sin(this.starterPh * 2.02) + 0.015 * nz;
      }
      // dc block + soft clip
      this.dc += (s - this.dc) * 0.002;
      s = Math.tanh((s - this.dc) * 2.4) * 0.55;
      ch0[i] = s;
      if (ch1) ch1[i] = s;
    }
    return true;
  }
}

registerProcessor('engine-v8', EngineProcessor);
