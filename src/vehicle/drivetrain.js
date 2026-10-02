// Drivetrain: engine -> clutch (manual) / torque converter (auto) -> gearbox -> 2-speed transfer case
// with lockable centre diff -> front/rear axle diffs (lockable) -> 4 wheels.
//
// Rotating bodies: 0 engine crank, 1 gearbox input (clutch disc / turbine), 2..5 wheels FL FR RL RR.
// Couplings are velocity constraints solved with projected Gauss-Seidel each substep:
//   gear: w_in = G * mean(w_wheels)   (open diffs give equal torque split for free)
//   clutch / lockup clutch: w_e = w_in, impulse limited by clutch capacity
//   centre / axle lockers, brakes, park pawl, friction: more rows.
// Torque sources (combustion, starter, torque converter, tyres) are applied explicitly.

export const RPM = 30 / Math.PI; // rad/s -> rpm

function table(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const a = t[i - 1], b = t[i];
      return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
  }
  return t[t.length - 1][1];
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// torque converter characteristics vs speed ratio
const TC_K = [[0, 1], [0.3, 1.02], [0.5, 1.07], [0.7, 1.17], [0.8, 1.3], [0.87, 1.55], [0.92, 2.0], [0.96, 3.0], [0.985, 5.5], [1, 9]];
const TC_TR = [[0, 2.1], [0.2, 1.86], [0.4, 1.6], [0.6, 1.35], [0.8, 1.1], [0.87, 1.0], [1, 1.0]];

class Row {
  constructor() { this.j = new Float64Array(6); this.lo = -Infinity; this.hi = Infinity; this.lambda = 0; this.m = 0; }
  set(j0, j1, j2, j3, j4, j5) { const j = this.j; j[0] = j0; j[1] = j1; j[2] = j2; j[3] = j3; j[4] = j4; j[5] = j5; return this; }
  bound(b) { this.lo = -b; this.hi = b; return this; }
}

const AUTO_SELECTOR = ['P', 'R', 'N', 'D'];

export class Drivetrain {
  constructor(P) {
    this.P = P;
    this.mode = 'auto';             // 'auto' | 'manual'
    this.clutchAssist = true;       // manual: automatic clutch
    this.manualGear = 0;            // -1 R, 0 N, 1..5
    this.selector = 'D';            // auto selector
    this.autoGear = 1;
    this.range = 'high';
    this.centerLock = false;
    this.frontLock = false;
    this.rearLock = false;
    this.rwd = false;               // front prop shaft disconnected: rear-wheel drive only (high range)

    this.w = new Float64Array(6);
    this.inv = new Float64Array(6);
    this.w[0] = P.engine.idleRpm / RPM;
    this.running = true;
    this.stalled = false;
    this.starterTime = 0;
    this.crankTime = 0;
    this.startGrace = 0;            // s after the engine catches with no stall check
    this.cranking = false;
    this.thr = 0.1;                 // effective (lagged) throttle
    this.driverThrottle = 0;
    this.idleInt = 0;
    this.limiterCut = false;
    this.clutchPedal = 0;           // 0 released (engaged), 1 pressed
    this.lockup = 0;
    this.shift = null;              // { phase, t, dur, target }
    this.sinceShift = 10;
    this.grind = 0;                 // >0 while gears grind (for audio)
    this.message = null;

    // outputs
    this.Tcomb = 0;
    this.load = 0;
    this.engineAlpha = 0;
    this.propTorque = [0, 0];       // front / rear pinion torque (Nm)
    this.wheelDrive = new Float64Array(4);
    this.clutchSlip = 0;

    this.rows = {
      gear: new Row(), clutch: new Row(), center: new Row(), front: new Row(), rear: new Row(), park: new Row(),
      hb: new Row(), hold: new Row(), efric: new Row(), ifric: new Row(),
      b0: new Row(), b1: new Row(), b2: new Row(), b3: new Row(),
      r0: new Row(), r1: new Row(), r2: new Row(), r3: new Row(),
    };
    this.active = [];
    this.updateInertia();
  }

  updateInertia() {
    const P = this.P;
    this.inv[0] = 1 / P.engine.inertia;
    this.inv[1] = 1 / (this.mode === 'auto' ? P.auto.turbineInertia : P.clutch.inputInertia);
    for (let i = 2; i < 6; i++) this.inv[i] = 1 / P.tire.inertia;
  }

  get rpm() { return this.w[0] * RPM; }

  // ratio from gearbox input to the wheels (signed), 0 = neutral
  ratioFor(mode, gear) {
    const P = this.P;
    const tr = (this.range === 'low' ? P.transfer.low : P.transfer.high) * P.finalDrive;
    if (mode === 'manual') {
      if (gear === 0) return 0;
      if (gear < 0) return -P.manual.reverse * tr;
      return P.manual.ratios[gear - 1] * tr;
    }
    if (gear === 'R') return -P.auto.reverse * tr;
    if (typeof gear === 'number') return P.auto.ratios[gear - 1] * tr;
    return 0;
  }

  currentRatio() {
    if (this.mode === 'manual') return this.ratioFor('manual', this.manualGear);
    if (this.selector === 'D') return this.ratioFor('auto', this.autoGear);
    if (this.selector === 'R') return this.ratioFor('auto', 'R');
    return 0;
  }

  // mean speed of the driven wheels (= transfer case output / ratio)
  wheelMean() { const w = this.w; return this.rwd ? 0.5 * (w[4] + w[5]) : 0.25 * (w[2] + w[3] + w[4] + w[5]); }

  gearLabel() {
    if (this.mode === 'manual') return this.manualGear === 0 ? 'N' : this.manualGear < 0 ? 'R' : String(this.manualGear);
    if (this.selector === 'D') return 'D' + this.autoGear;
    return this.selector;
  }

  say(msg) { this.message = { text: msg, t: 2.2 }; }

  // ---------------------------------------------------------------- commands
  toggleMode() {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
    this.manualGear = 0; this.selector = 'N'; this.autoGear = 1; this.shift = null; this.lockup = 0;
    this.updateInertia();
    this.w[1] = this.w[0];
    this.say(this.mode === 'auto' ? 'Automatic (6-speed, torque converter)' : 'Manual 5-speed' + (this.clutchAssist ? ' (auto clutch)' : ' (clutch pedal: Shift)'));
  }
  toggleClutchAssist() {
    this.clutchAssist = !this.clutchAssist;
    this.say(this.clutchAssist ? 'Auto clutch ON' : 'Auto clutch OFF: hold Shift for the clutch');
  }
  toggleRange(speed) {
    if (Math.abs(speed) > 1.5) { this.say('Stop to change transfer range'); return; }
    if (this.rwd && this.range === 'high') { this.say('Select 4WD before LOW range'); return; }
    this.range = this.range === 'high' ? 'low' : 'high';
    this.say(this.range === 'low' ? 'LOW range engaged' : 'HIGH range engaged');
  }
  toggleCenterLock() {
    if (this.rwd) { this.say('Centre lock needs 4WD'); return; }
    this.centerLock = !this.centerLock; this.say(this.centerLock ? 'Centre diff LOCKED' : 'Centre diff open');
  }
  toggleRwd(speed) {
    if (!this.rwd && this.range === 'low') { this.say('RWD only in HIGH range'); return; }
    if (Math.abs(speed) > 8) { this.say('Slow down to change 2WD / 4WD'); return; }
    this.rwd = !this.rwd;
    if (this.rwd) this.centerLock = false;
    this.say(this.rwd ? '2WD: rear-wheel drive' : '4WD: all wheels driven');
  }
  cycleAxleLockers() {
    if (!this.rearLock) { this.rearLock = true; this.say('Rear locker ON'); }
    else if (!this.frontLock) { this.frontLock = true; this.say('Front + rear lockers ON'); }
    else { this.rearLock = false; this.frontLock = false; this.say('Axle lockers off'); }
  }
  startEngine() {
    if (this.running) { this.say('Engine is already running (O switches it off)'); return; }
    if (this.mode === 'manual' && !this.clutchAssist && this.manualGear !== 0 && this.clutchPedal < 0.6) {
      this.say('In gear: hold the clutch (Shift) or select neutral, then press I');
      return;
    }
    this.starterTime = 2.5; this.crankTime = 0;
    this.say('Starting...');
  }
  stopEngine() { this.running = false; }
  setSelector(s) {
    if (this.selector === s) return;
    this.selector = s;
    if (s === 'D') this.autoGear = 1;
  }

  requestShift(dir, ctl) {
    if (this.mode === 'auto') {
      let i = AUTO_SELECTOR.indexOf(this.selector) + dir;
      i = clamp(i, 0, AUTO_SELECTOR.length - 1);
      this.setSelector(AUTO_SELECTOR[i]);
      return;
    }
    const target = clamp(this.manualGear + dir, -1, 5);
    if (target === this.manualGear) return;
    if (target === -1 && this.wheelMean() * 0.42 > 1.5) { this.say('Too fast for reverse'); this.grind = 0.35; return; }
    if (this.clutchAssist) {
      this.shift = { phase: 'out', t: 0, target };
      return;
    }
    // no assist: needs the clutch pedal, or a rev-matched clutchless shift
    if (this.clutchPedal > 0.6 || target === 0) { this.manualGear = target; this.sinceShift = 0; return; }
    const G = this.ratioFor('manual', target);
    const wIn = G * this.wheelMean();
    if (Math.abs(wIn - this.w[0]) < 28) { this.manualGear = target; this.sinceShift = 0; return; }
    this.manualGear = 0;
    this.grind = 0.45;
    this.say('Grind! Use the clutch (Shift) or match revs');
  }

  // ---------------------------------------------------------------- per step logic
  control(h, ctl, speed) {
    const P = this.P, E = P.engine;
    if (this.message) { this.message.t -= h; if (this.message.t <= 0) this.message = null; }
    this.grind = Math.max(0, this.grind - h);
    this.sinceShift += h;
    const rpm = this.rpm;

    // ---- engine state
    // The starter spins the engine at ~300 rpm; it fires after a few compression strokes,
    // then the starter stays engaged until the engine pulls past it.
    if (this.starterTime > 0) {
      this.starterTime -= h;
      this.crankTime += h;
      this.cranking = true;
      if (!this.running && rpm > 200 && this.crankTime > 0.4) {
        this.running = true; this.stalled = false; this.idleInt = 150; this.startGrace = 1.0;
      }
      if (this.running && rpm > 550) { this.starterTime = 0; this.cranking = false; }
      if (this.starterTime <= 0 && !this.running) { this.cranking = false; this.say('Engine did not start: select N/P or press the clutch'); }
    } else this.cranking = false;
    this.startGrace = Math.max(0, this.startGrace - h);
    if (this.running && rpm < E.stallRpm && !this.cranking && this.startGrace <= 0) {
      this.running = false; this.stalled = true;
      this.say('Engine stalled: press I to start');
    }
    if (rpm > E.limiterRpm) this.limiterCut = true;
    else if (rpm < E.limiterRpm - 180) this.limiterCut = false;

    // ---- transmission logic
    let throttle = ctl.throttle;
    if (this.mode === 'manual') throttle *= this.manualLogic(h, ctl);
    else throttle *= this.autoLogic(h, ctl, speed);
    this.driverThrottle = ctl.throttle;

    // ---- idle governor + throttle lag
    let idleThr = 0;
    if (this.running) {
      const err = E.idleRpm - rpm;
      if (rpm < E.idleRpm + 500) this.idleInt = clamp(this.idleInt + err * h, -150, 500);
      else this.idleInt *= Math.exp(-h * 2);
      idleThr = clamp(0.1 + 0.0011 * err + 0.0009 * this.idleInt, 0, 0.55);
    }
    const target = this.running ? Math.max(throttle, idleThr) : 0;
    const tau = target > this.thr ? 0.065 : 0.11;
    this.thr += (target - this.thr) * Math.min(1, h / tau);
  }

  // returns throttle multiplier (for shift cuts)
  manualLogic(h, ctl) {
    let cut = 1;
    const sh = this.shift;
    const assist = this.clutchAssist;
    let pedalTarget = assist ? 0 : ctl.clutch;
    if (assist) {
      if (sh) {
        sh.t += h;
        if (sh.phase === 'out') {
          pedalTarget = 1; cut = 0;
          if (sh.t > 0.11) { this.manualGear = sh.target; sh.phase = 'in'; sh.t = 0; this.sinceShift = 0; }
        } else {
          cut = Math.min(1, sh.t / 0.25);
          pedalTarget = this.autoClutchTarget(ctl);
          // blend from fully pressed down to the target
          pedalTarget = Math.max(pedalTarget, 1 - sh.t / 0.28);
          if (sh.t > 0.3) this.shift = null;
        }
      } else {
        pedalTarget = this.autoClutchTarget(ctl);
      }
      const rate = pedalTarget > this.clutchPedal ? 10 : (sh ? 6 : 3.2);
      this.clutchPedal += clamp(pedalTarget - this.clutchPedal, -rate * h, rate * h);
    } else {
      // keyboard clutch: pressing is quick, releasing passes through the bite point smoothly
      const rate = pedalTarget > this.clutchPedal ? 9 : 1.9;
      this.clutchPedal += clamp(pedalTarget - this.clutchPedal, -rate * h, rate * h);
    }
    return cut;
  }

  autoClutchTarget(ctl) {
    if (this.manualGear === 0) return 0;
    if (this.cranking) return 1;
    if (!this.running) return 0;           // parked in gear: engine compression holds the truck
    const rpm = this.rpm;
    const lineRpm = Math.abs(this.ratioFor('manual', this.manualGear) * this.wheelMean()) * RPM;
    let e;
    if (lineRpm > 1050 && rpm > 850) e = 1;
    else if (ctl.brake > 0.1 && ctl.throttle < 0.05 && this.range === 'high') e = 0;
    else if (ctl.throttle > 0.02) e = smooth(800, 1500, rpm) * (0.35 + 0.65 * smooth(0, 0.25, ctl.throttle));
    else if (this.range === 'low') e = smooth(560, 760, rpm);   // idle crawl in low range
    else e = 0;
    if (rpm < 600) e = 0;
    return 0.8 - 0.6 * e;
  }

  autoLogic(h, ctl, speed = 0) {
    let cut = 1;
    const P = this.P;
    const sh = this.shift;
    if (sh) {
      sh.t += h;
      if (sh.t > P.auto.shiftTime) this.shift = null;
      else cut = 0.55 + 0.45 * (sh.t / P.auto.shiftTime);
    }
    if (this.selector === 'D' && !this.shift && this.sinceShift > 0.7) {
      // output speed from the wheels, but don't let wheelspin drive upshifts (use ground speed too)
      const wmWheels = Math.max(0, this.wheelMean());
      const wmGround = Math.max(0, speed) / P.tire.radius;
      const wm = Math.min(wmWheels, wmGround * 1.25 + 0.5);
      const rpmAt = g => wm * Math.abs(this.ratioFor('auto', g)) * RPM;
      const t = ctl.throttle;
      const lowR = this.range === 'low' ? 250 : 0;
      const up = 1650 + lowR + 3150 * Math.pow(t, 1.3);
      const down = 1050 + 1950 * Math.pow(t, 1.6);
      const g = this.autoGear;
      if (g < P.auto.ratios.length && rpmAt(g) > up && rpmAt(g + 1) > 1150) {
        this.autoGear = g + 1; this.shift = { t: 0 }; this.sinceShift = 0;
      } else if (g > 1 && rpmAt(g) < down && rpmAt(g - 1) < 4700) {
        this.autoGear = g - 1; this.shift = { t: 0 }; this.sinceShift = 0;
      }
    }
    // lock-up clutch
    const lineRpm = this.wheelMean() * this.currentRatio() * RPM;
    const want = this.running && this.selector === 'D' && this.autoGear >= 3 && !this.shift && lineRpm > 1250 && ctl.throttle < 0.9 ? 1 : 0;
    this.lockup += clamp(want - this.lockup, -6 * h, 1.5 * h);
    return cut;
  }

  // ---------------------------------------------------------------- substep integration
  // tireT: torque from tyre on each wheel (Nm, + = accelerates forward rotation)
  // rrT: rolling-resistance bound per wheel (Nm), brakeT: service brake torque per wheel, hbT: handbrake torque at rear axle
  // holdT: standstill hold of the transmission brake on the transfer output (all driven wheels)
  substep(h, tireT, rrT, brakeT, hbT, holdT = 0) {
    const P = this.P, E = P.engine, w = this.w, inv = this.inv, R = this.rows;
    const rpm = w[0] * RPM;
    const w0Old = w[0];

    // ---- explicit torques
    let Tc = 0;
    if (this.running && !this.limiterCut) Tc = this.thr * table(E.torque, Math.max(rpm, 0));
    if (this.cranking) Tc += E.starterTorque * clamp(1 - rpm / 600, 0, 1);
    this.Tcomb = Tc;
    w[0] += h * Tc * inv[0];

    if (this.mode === 'auto') {
      const tc = this.converter(w[0], w[1]);
      w[0] -= h * tc.Tp * inv[0];
      w[1] += h * tc.Tt * inv[1];
      this.tcPump = tc.Tp;
    }
    for (let i = 0; i < 4; i++) w[2 + i] += h * tireT[i] * inv[2 + i];

    // ---- constraint rows
    const A = this.active; A.length = 0;
    const G = this.currentRatio();
    if (G !== 0) {
      const g4 = -G / 4;
      const row = this.rwd ? R.gear.set(0, 1, 0, 0, -G / 2, -G / 2) : R.gear.set(0, 1, g4, g4, g4, g4);
      if (this.mode === 'auto' && this.shift) {
        const f = clamp(this.shift.t / P.auto.shiftTime, 0, 1);
        row.bound(P.auto.shiftCapacity * (0.3 + 0.7 * f) * h);
      } else row.bound(Infinity);
      A.push(row);
    } else R.gear.lambda = 0;

    if (this.mode === 'manual') {
      const e = clamp((0.8 - this.clutchPedal) / 0.6, 0, 1);
      const cap = P.clutch.capacity * e * e * (3 - 2 * e);
      if (cap > 0) A.push(R.clutch.set(1, -1, 0, 0, 0, 0).bound(cap * h)); else R.clutch.lambda = 0;
    } else {
      const cap = P.auto.lockupCapacity * this.lockup;
      if (cap > 0) A.push(R.clutch.set(1, -1, 0, 0, 0, 0).bound(cap * h)); else R.clutch.lambda = 0;
      if (this.selector === 'P') A.push((this.rwd ? R.park.set(0, 0, 0, 0, 0.5, 0.5) : R.park.set(0, 0, 0.25, 0.25, 0.25, 0.25)).bound(Infinity));
    }
    if (this.centerLock) A.push(R.center.set(0, 0, 0.5, 0.5, -0.5, -0.5).bound(Infinity));
    if (this.frontLock) A.push(R.front.set(0, 0, 1, -1, 0, 0).bound(Infinity));
    if (this.rearLock) A.push(R.rear.set(0, 0, 0, 0, 1, -1).bound(Infinity));
    if (hbT > 0) A.push(R.hb.set(0, 0, 0, 0, 0.5, 0.5).bound(hbT * h)); else R.hb.lambda = 0;
    if (holdT > 0) A.push((this.rwd ? R.hold.set(0, 0, 0, 0, 0.5, 0.5) : R.hold.set(0, 0, 0.25, 0.25, 0.25, 0.25)).bound(holdT * h)); else R.hold.lambda = 0;
    const bRows = [R.b0, R.b1, R.b2, R.b3], rRows = [R.r0, R.r1, R.r2, R.r3];
    for (let i = 0; i < 4; i++) {
      if (brakeT[i] > 0) {
        const r = bRows[i].set(0, 0, 0, 0, 0, 0); r.j[2 + i] = 1; A.push(r.bound(brakeT[i] * h));
      } else bRows[i].lambda = 0;
      const rr = rRows[i].set(0, 0, 0, 0, 0, 0); rr.j[2 + i] = 1; A.push(rr.bound(rrT[i] * h));
    }
    // engine friction + pumping losses (implicit Coulomb-style so a dead engine comes to rest cleanly)
    const thr = this.thr;
    let Tf = 12 + 0.0085 * Math.abs(rpm) + 1.2e-6 * rpm * rpm + (1 - thr) * (6 + 0.0105 * Math.abs(rpm));
    if (!this.running) Tf += 16;
    A.push(R.efric.set(1, 0, 0, 0, 0, 0).bound(Tf * h));
    A.push(R.ifric.set(0, 1, 0, 0, 0, 0).bound((1.5 + 0.004 * Math.abs(w[1])) * h));

    this.solve(A, 24);

    // ---- outputs
    this.engineAlpha = (w[0] - w0Old) / h;
    const lg = G !== 0 ? R.gear.lambda : 0;
    const lc = this.centerLock ? R.center.lambda : 0;
    const lh = hbT > 0 ? R.hb.lambda : 0;
    const lo = holdT > 0 ? R.hold.lambda : 0;
    const gj = R.gear.j, cj = R.center.j, hj = R.hb.j, oj = R.hold.j;
    for (let i = 0; i < 4; i++) {
      const b = 2 + i;
      this.wheelDrive[i] = ((G !== 0 ? gj[b] * lg : 0) + (this.centerLock ? cj[b] * lc : 0) + (hbT > 0 ? hj[b] * lh : 0) + (holdT > 0 ? oj[b] * lo : 0)) / h;
    }
    const fd = P.finalDrive;
    this.propTorque[0] = (this.wheelDrive[0] + this.wheelDrive[1]) / fd;
    this.propTorque[1] = (this.wheelDrive[2] + this.wheelDrive[3]) / fd;
    this.clutchSlip = w[0] - w[1];
    const maxT = table(E.torque, Math.max(rpm, 0));
    this.load = maxT > 0 ? Tc / maxT : 0;
  }

  converter(we, wt) {
    const K0 = this.P.auto.stallK;
    const visc = 0.06 * (we - wt);   // keeps a little coupling when both sides are nearly stopped
    if (we >= wt) {
      // forward flow: pump (engine) drives the turbine
      const base = Math.max(we, 0);
      const sr = base > 1e-3 ? clamp(wt / base, -1, 1) : -1;
      const K = K0 * table(TC_K, Math.max(sr, 0));
      const Tp = (base * RPM / K) ** 2 * (sr < 0 ? 1 - 0.6 * sr : 1) + visc;
      return { Tp, Tt: Tp * table(TC_TR, Math.max(sr, 0)) };
    }
    // reverse flow (overrun / engine braking): turbine drives the pump
    const base = Math.max(wt, 0);
    const sr = base > 1e-3 ? clamp(we / base, -1, 1) : -1;
    const K = K0 * 1.25 * table(TC_K, Math.max(sr, 0));
    const T = (base * RPM / K) ** 2 * (sr < 0 ? 1 - 0.6 * sr : 1) - visc;
    return { Tp: -T, Tt: -T };
  }

  solve(A, iters) {
    const w = this.w, inv = this.inv;
    for (let r = 0; r < A.length; r++) {
      const row = A[r], j = row.j;
      let k = 0;
      for (let b = 0; b < 6; b++) k += j[b] * j[b] * inv[b];
      row.m = k > 0 ? 1 / k : 0;
      // warm start
      const l = clamp(row.lambda, row.lo, row.hi);
      row.lambda = l;
      if (l !== 0) for (let b = 0; b < 6; b++) w[b] += j[b] * inv[b] * l;
    }
    for (let it = 0; it < iters; it++) {
      for (let r = 0; r < A.length; r++) {
        const row = A[r], j = row.j;
        let jv = 0;
        for (let b = 0; b < 6; b++) jv += j[b] * w[b];
        const old = row.lambda;
        const nl = clamp(old - row.m * jv, row.lo, row.hi);
        const d = nl - old;
        if (d !== 0) {
          row.lambda = nl;
          for (let b = 0; b < 6; b++) w[b] += j[b] * inv[b] * d;
        }
      }
    }
  }
}
