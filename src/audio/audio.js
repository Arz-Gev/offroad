// WebAudio: V8 worklet + tyre / gravel / wind noise, skid, gear grind, bump-stop knocks, transfer whine.
// Started on the first user gesture (browsers block audio before that).

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.knockCooldown = 0;
    this.lastGrind = 0;
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    this.engine = new AudioWorkletNode(ctx, 'engine-v8', { outputChannelCount: [2] });
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.9;
    // cabin vs outside filtering
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 9000;
    this.engine.connect(this.engineFilter).connect(this.engineGain).connect(master);

    // shared noise source
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true; noise.start();

    const chain = (type, f, q, g0 = 0) => {
      const f1 = ctx.createBiquadFilter(); f1.type = type; f1.frequency.value = f; f1.Q.value = q;
      const g = ctx.createGain(); g.gain.value = g0;
      noise.connect(f1).connect(g).connect(master);
      return { f: f1, g };
    };
    this.gravel = chain('bandpass', 700, 0.7);
    this.rumble = chain('lowpass', 140, 0.7);
    this.skid = chain('bandpass', 1100, 5);
    this.wind = chain('lowpass', 600, 0.5);
    this.mud = chain('bandpass', 260, 1.2);
    this.grind = chain('bandpass', 2400, 3);

    // transfer case / gear whine
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(master);
    this.whine.start();
    this.ready = true;
  }

  knock(strength) {
    if (!this.ready || this.knockCooldown > 0) return;
    this.knockCooldown = 0.12;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, 0.25 + strength), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.2);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 1;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(Math.min(0.5, strength * 0.6), t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    n.connect(nf).connect(ng).connect(this.master);
    n.start(t, Math.random()); n.stop(t + 0.08);
  }

  update(dt, v, opts) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, d = v.drivetrain;
    const p = this.engine.parameters;
    p.get('rpm').setTargetAtTime(d.rpm, t, 0.01);
    p.get('load').setTargetAtTime(Math.max(0, Math.min(1, d.load)), t, 0.03);
    p.get('throttle').setTargetAtTime(d.thr, t, 0.03);
    p.get('starter').setValueAtTime(d.cranking ? 1 : 0, t);
    p.get('running').setValueAtTime(d.running ? 1 : 0, t);
    const inside = opts.cockpit;
    this.engineFilter.frequency.setTargetAtTime(inside ? 2600 : 9000, t, 0.05);
    this.engineGain.gain.setTargetAtTime(this.muted ? 0 : (inside ? 0.75 : 0.95), t, 0.05);

    const speed = Math.abs(v.speed);
    let rough = 0, skid = 0, mud = 0, contact = 0;
    for (const w of v.wheels) {
      if (!w.contact) continue;
      contact++;
      const s = w.surf;
      const roll = Math.min(1, Math.abs(w.vcx) / 12);
      rough += roll * (0.25 + 0.75 * (s.dust + s.soft * 0.4));
      const sv = Math.min(1, (w.slipVel || 0) / 6) * Math.min(1, w.FnAvg / 4000);
      if (s.mud) mud += sv + roll * 0.4; else skid += sv * (s.soft > 0.4 ? 0.35 : 1);
    }
    const m = this.muted ? 0 : 1;
    const amb = inside ? 0.7 : 1;
    this.gravel.g.gain.setTargetAtTime(m * amb * 0.09 * rough / 4, t, 0.05);
    this.gravel.f.frequency.setTargetAtTime(500 + speed * 25, t, 0.1);
    this.rumble.g.gain.setTargetAtTime(m * 0.25 * Math.min(1, speed / 15) * (contact / 4), t, 0.05);
    this.skid.g.gain.setTargetAtTime(m * 0.06 * Math.min(1.5, skid), t, 0.03);
    this.mud.g.gain.setTargetAtTime(m * 0.25 * Math.min(1, mud), t, 0.05);
    this.wind.g.gain.setTargetAtTime(m * amb * Math.min(0.35, speed * speed * 0.00025), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + speed * 30, t, 0.2);
    // whine from the transfer gears in low range, proportional to prop speed and torque
    const prop = Math.abs(d.wheelMean() * v.P.finalDrive);
    const tq = Math.min(1, (Math.abs(d.propTorque[0]) + Math.abs(d.propTorque[1])) / 3000);
    this.whine.frequency.setTargetAtTime(Math.max(20, prop * 9 / (2 * Math.PI) * 4), t, 0.03);
    this.whineGain.gain.setTargetAtTime(m * (d.range === 'low' ? 0.025 : 0.008) * Math.min(1, prop / 40) * (0.3 + tq), t, 0.05);
    // gear grind
    if (d.grind > 0 && this.lastGrind <= 0) this.grind.g.gain.setTargetAtTime(m * 0.4, t, 0.01);
    if (d.grind <= 0 && this.lastGrind > 0) this.grind.g.gain.setTargetAtTime(0, t, 0.03);
    if (d.grind > 0) this.grind.f.frequency.setValueAtTime(1800 + Math.random() * 1600, t);
    this.lastGrind = d.grind;
    // bump stops / landing knocks
    this.knockCooldown -= dt;
    for (const ax of v.axles) {
      for (let s = 0; s < 2; s++) {
        const comp = ax.c + (s ? 1 : -1) * ax.p.springTrack / 2 * Math.sin(ax.phi);
        if ((comp > ax.p.travel - 0.025 || comp < 0.005) && Math.abs(ax.vz - ax.vMountU) > 0.6) this.knock(Math.min(1, Math.abs(ax.vz - ax.vMountU) / 3));
      }
    }
  }

  toggleMute() { this.muted = !this.muted; return this.muted; }
}
