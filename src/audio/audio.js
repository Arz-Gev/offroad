// WebAudio: V8 worklet + tyre / gravel / wind noise, skid, gear grind, transfer whine.
// No suspension / impact sound on purpose: see DEVNOTES.md "Impact sounds" before adding one.
// Started on the first user gesture (browsers block audio before that).

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.volume = 1;              // player volume 0..1 on top of the mix level
    this.paused = false;          // game paused: master faded out, synthesis keeps running
    this.lastGrind = 0;
  }

  // start / starter sound knobs (engine-worklet.js STARTER_DEFAULTS), changed live
  setStarterTune(t) {
    this.starterTune = { ...t };
    this.engine?.port.postMessage({ starter: this.starterTune });
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    const master = ctx.createGain();
    master.gain.value = this.masterLevel();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    this.engine = new AudioWorkletNode(ctx, 'engine-v8', { outputChannelCount: [2] });
    if (this.starterTune) this.engine.port.postMessage({ starter: this.starterTune });
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
    this.grind = chain('bandpass', 1400, 4);

    // transfer case / gear whine
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(master);
    this.whine.start();
    this.ready = true;
  }

  // Gunfire (weapons.js). The KPVT: a sharp crack over a deep chest thump and the bolt's clank; the PKT: the
  // same, higher and shorter; 'far': a friend's gun, muffled. Synthesised (noise + sine).
  gunshot(kind) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.003;
    const K = { kpvt: { lp: 2600, dec: 0.16, f0: 78, f1: 34, thump: 0.95, crack: 0.7, clank: 0.18 },
      pkt: { lp: 4200, dec: 0.07, f0: 140, f1: 70, thump: 0.45, crack: 0.5, clank: 0.1 },
      far: { lp: 900, dec: 0.25, f0: 60, f1: 30, thump: 0.25, crack: 0.12, clank: 0 } }[kind] || { lp: 2600, dec: 0.12, f0: 80, f1: 40, thump: 0.6, crack: 0.5, clank: 0.1 };
    const out = this.master;
    // crack: broadband noise, fast attack, short decay, a little random colour shot to shot
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = K.lp * (0.9 + Math.random() * 0.2); lp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(K.crack, t + 0.002); ng.gain.exponentialRampToValueAtTime(0.001, t + K.dec);
    n.connect(lp).connect(ng).connect(out);
    n.start(t, Math.random() * 1.5); n.stop(t + K.dec + 0.02);
    // thump: the muzzle blast felt in the chest, falling in pitch
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(K.f0, t); o.frequency.exponentialRampToValueAtTime(K.f1, t + K.dec);
    const og = ctx.createGain(); og.gain.setValueAtTime(K.thump, t); og.gain.exponentialRampToValueAtTime(0.001, t + K.dec * 1.3);
    o.connect(og).connect(out); o.start(t); o.stop(t + K.dec * 1.4);
    // clank of the action, a hair later
    if (K.clank) {
      const c = ctx.createBufferSource(); c.buffer = this.noiseBuf;
      const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 2300; bf.Q.value = 6;
      const cg = ctx.createGain(); cg.gain.setValueAtTime(K.clank, t + 0.025); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      c.connect(bf).connect(cg).connect(out); c.start(t + 0.02, Math.random()); c.stop(t + 0.08);
    }
  }

  // a round landing at p (world): heard after the sound's travel time, fainter with distance
  impact(kind, p) {
    if (!this.ready || !this.listener || this.impactCool > 0) return;
    const L = this.listener, d = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z);
    const level = (kind === 'hard' ? 0.5 : kind === 'water' ? 0.35 : 0.4) / (1 + d / 25);
    if (level < 0.01) return;
    this.impactCool = 0.03;
    const ctx = this.ctx, t = ctx.currentTime + d / 343;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = kind === 'hard' ? 'bandpass' : 'lowpass';
    f.frequency.value = kind === 'hard' ? 1800 + Math.random() * 1200 : kind === 'water' ? 1400 : 500; f.Q.value = kind === 'hard' ? 3 : 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.0005, t + (kind === 'hard' ? 0.09 : 0.16));
    n.connect(f).connect(g).connect(this.master); n.start(t, Math.random()); n.stop(t + 0.2);
  }

  update(dt, v, opts) {
    if (!this.ready) return;
    this.impactCool = Math.max(0, (this.impactCool || 0) - dt);
    const ctx = this.ctx, t = ctx.currentTime, d = v.drivetrain;
    const p = this.engine.parameters;
    p.get('rpm').setTargetAtTime(d.rpm, t, 0.01);
    p.get('load').setTargetAtTime(Math.max(0, Math.min(1, d.load)), t, 0.03);
    p.get('throttle').setTargetAtTime(d.thr, t, 0.03);
    p.get('starter').setValueAtTime(d.cranking ? 1 : 0, t);
    p.get('running').setValueAtTime(d.running ? d.fire : 0, t);
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
    // levels were set on 4 wheels: per wheel more wheels make more noise, but not twice as much (8 wheels: x1.4)
    const nW = v.wheels.length, wk = Math.sqrt(nW / 4) / nW;
    // tyre roll and mud are broadband hiss: the player found both annoying (Oct 7), so the tyres are at a third (~10 dB down,
    // was 0.09) and the mud 8 dB down (was 0.25). The skid stays as it was (player: fine).
    this.gravel.g.gain.setTargetAtTime(m * amb * 0.03 * rough * wk, t, 0.05);
    this.gravel.f.frequency.setTargetAtTime(500 + speed * 25, t, 0.1);
    this.rumble.g.gain.setTargetAtTime(m * 0.25 * Math.min(1, speed / 15) * (contact / nW), t, 0.05);
    this.skid.g.gain.setTargetAtTime(m * 0.06 * Math.min(1.5, skid), t, 0.03);
    this.mud.g.gain.setTargetAtTime(m * 0.1 * Math.min(1, mud), t, 0.05);
    this.wind.g.gain.setTargetAtTime(m * amb * Math.min(0.35, speed * speed * 0.00025), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + speed * 30, t, 0.2);
    // whine from the transfer gears in low range, proportional to prop speed and torque
    const prop = Math.abs(d.wheelMean() * v.P.finalDrive);
    const tq = Math.min(1, d.propTorque.reduce((s, x) => s + Math.abs(x), 0) / 3000);
    this.whine.frequency.setTargetAtTime(Math.max(20, prop * 9 / (2 * Math.PI) * 4), t, 0.03);
    this.whineGain.gain.setTargetAtTime(m * (d.range === 'low' ? 0.025 : 0.008) * Math.min(1, prop / 40) * (0.3 + tq), t, 0.05);
    // gear grind (a clutchless shift that didn't match revs). Was 0.4 at 1.8-3.4 kHz with a hard attack and
    // the band jumping every frame: too loud and harsh (player). Now quieter, lower, softer edges, and the
    // band wanders instead of jumping; it still rasps (the level flutters like teeth clashing).
    if (d.grind > 0 && this.lastGrind <= 0) this.grind.g.gain.setTargetAtTime(m * 0.16, t, 0.025);
    if (d.grind <= 0 && this.lastGrind > 0) this.grind.g.gain.setTargetAtTime(0, t, 0.06);
    if (d.grind > 0) {
      this.grind.f.frequency.setTargetAtTime(1150 + Math.random() * 550, t, 0.02);
      this.grind.g.gain.setTargetAtTime(m * 0.16 * (0.6 + 0.4 * Math.random()) * Math.min(1, d.grind / 0.15), t, 0.015);
    }
    this.lastGrind = d.grind;
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }
  setMuted(m) { this.muted = !!m; this.applyMaster(); }

  // UI controls: they only scale the master gain, the mix itself is unchanged.
  // Mute also closes the master so one-shots (gunfire, impacts) are silenced too.
  masterLevel() { return this.paused || this.muted ? 0 : 0.8 * this.volume; }
  applyMaster() { if (this.master) this.master.gain.setTargetAtTime(this.masterLevel(), this.ctx.currentTime, 0.04); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyMaster(); }
  setPaused(p) { this.paused = !!p; this.applyMaster(); }
  // 'locked' until the browser lets the context run (needs a user gesture), then 'running'
  get state() { return this.ctx ? this.ctx.state : 'locked'; }
}
