// Drivetrain: engine -> clutch (manual) / torque converter (auto) -> gearbox -> 2-speed transfer case
// with lockable centre diff -> axle diffs (open, lockable or cam-type limited slip) -> 2 wheels per axle.
//
// Rotating bodies: 0 engine crank, 1 gearbox input (clutch disc / turbine), 2.. wheels, two per axle
// from the front (left, right): FL FR RL RR on a 4x4, 1L 1R 2L 2R 3L 3R 4L 4R on an 8x8.
// Couplings are velocity constraints solved with projected Gauss-Seidel each substep:
//   gear: w_in = G * (s * mean(group 0) + (1 - s) * mean(group 1)): the open centre diff's kinematics, which
//     split the torque s : 1 - s (P.drive.centreSplit, 0.5 unless the car says); open axle diffs give each
//     wheel of an axle the same torque for free
//   clutch / lockup clutch: w_e = w_in, impulse limited by clutch capacity
//   centre lock: mean(group 0) = mean(group 1). Axles in one group are coupled rigidly (link rows: BTR-80
//     axles 1 + 3 and 2 + 4, no diff between them)
//   viscous coupling (P.drive.centre 'viscous', no lock): the same row, its torque limited by the prop
//     shafts' speed difference
//   axle lockers, limited-slip rows, brakes, park pawl, friction: more rows.
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
  constructor(n) { this.j = new Float64Array(n); this.lo = -Infinity; this.hi = Infinity; this.lambda = 0; this.m = 0; }
  clear() { this.j.fill(0); return this; }
  bound(b) { this.lo = -b; this.hi = b; return this; }
}

// The drive layout (P.drive.layout, per-axle driven / group / diff):
//   'awd'      permanent all-wheel drive (default): every axle through a centre diff, `centre` 'open' (the
//              driver can lock it) or 'viscous'; drive.rwd lists the axles a 2WD switch keeps ([] = none)
//   'parttime' selectable 4WD without a centre diff (Jimny, Hilux): starts in 2WD (rear half); 4WD engages
//              the front, which then turns with the rear
//   'rwd' / 'fwd'  rear / front half of the axles only
// An axle's own `driven` overrides the layout. A car without P.drive is the plain 4x4: front axle = group 0,
// rear = group 1, open diffs, 2WD drives the rear axle.
export function driveLayout(P) {
  const n = P.axles.length, D = P.drive || {}, layout = D.layout || 'awd';
  const front = i => i < n / 2;
  const axles = P.axles.map((a, i) => ({
    driven: a.driven ?? (layout === 'fwd' ? front(i) : layout === 'rwd' ? !front(i) : true),
    group: a.group ?? (front(i) ? 0 : 1), diff: a.diff || 'open', lock: a.diffLock ?? 0.35,
  }));
  const groups = new Set(axles.filter(a => a.driven).map(a => a.group));
  const rear = P.axles.map((a, i) => i).filter(i => !front(i));
  return {
    layout, axles,
    // axles that stay driven in 2WD (empty: no 2WD switch)
    rwd: layout === 'parttime' ? rear : layout === 'awd' ? (D.rwd ?? [n - 1]) : [],
    handbrake: D.handbrake ?? [n - 1],  // axles the handbrake holds (transmission brake behind them)
    split: D.centreSplit ?? 0.5,        // group 0's share of the drive torque through the open centre diff
    // 'open' (lockable) | 'viscous' (a viscous coupling, no lock) | 'locked' (part-time: no centre diff) |
    // 'none' (one output driven: front- or rear-wheel drive)
    centre: groups.size < 2 ? 'none' : layout === 'parttime' ? 'locked' : (D.centre || 'open'),
    viscous: D.viscous ?? 0,            // viscous coupling: Nm per rpm of prop shaft slip
    lockers: D.lockers !== false,       // axle lockers on the open axle diffs
  };
}

const AUTO_SELECTOR = ['P', 'R', 'N', 'D'];

export class Drivetrain {
  constructor(P) {
    this.P = P;
    this.mode = 'auto';             // 'auto' | 'manual'
    this.clutchAssist = true;
    this.autoShift = false;         // manual-only cars (P.manualOnly) in "automatic": the gears are picked for you
    this.manualGear = 0;            // -1 R, 0 N, 1..5
    this.selector = 'D';
    this.autoGear = 1;
    this.range = 'high';
    this.centerLock = false;
    this.layout = driveLayout(P);
    this.nA = P.axles.length;
    this.nW = 2 * this.nA;
    this.nB = 2 + this.nW;
    this.locks = new Array(this.nA).fill(false);
    this.rwd = this.layout.layout === 'parttime';   // 2WD: only the axles in layout.rwd driven (high range)

    this.w = new Float64Array(this.nB);
    this.inv = new Float64Array(this.nB);
    this.w[0] = P.engine.idleRpm / RPM;
    this.running = true;
    this.stalled = false;
    this.starterTime = 0;
    this.crankTime = 0;
    this.startGrace = 0;            // s after the engine catches with no stall check
    this.cranking = false;
    this.fire = 1;                  // share of cylinders firing: ramps 0 -> 1 as the engine catches
    this.catchAt = 1;               // cranking time before the first cylinders fire (s)
    this.sinceCatch = 10;           // s since it caught (start flare of the idle speed)
    this.crankAng = 0;              // crank angle (rad), for the compression strokes while cranking
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

    this.Tcomb = 0;
    this.load = 0;
    this.engineAlpha = 0;
    this.propTorque = new Array(this.nA).fill(0);   // pinion torque of each axle (Nm)
    this.wheelDrive = new Float64Array(this.nW);
    this.axleDrive = new Float64Array(this.nA);     // drive torque into each axle diff (limited slip)
    this.clutchSlip = 0;

    const B = this.nB, row = () => new Row(B);
    this.rows = {
      gear: row(), clutch: row(), center: row(), visc: row(), park: row(), hb: row(), hold: row(), efric: row(), ifric: row(),
      hbAx: Array.from({ length: this.nA }, row),   // handbrake on several axles: one row per axle (see substep)
      lock: this.layout.axles.map(row), links: this.layout.axles.map(row),
      b: Array.from({ length: this.nW }, row), r: Array.from({ length: this.nW }, row),
    };
    this.active = [];
    this.dw = new Float64Array(this.nW);   // driven wheels' weights in the centre diff input (sum 1)
    // a car with only a manual box starts in it, shifting by itself, in 1st (the automatic's "D")
    if (P.manualOnly) { this.mode = 'manual'; this.autoShift = true; this.manualGear = 1; this.selector = 'N'; }
    this.updateInertia();
  }

  // axle lockers of a 4x4 by name (HUD, menu, multiplayer): front = first axle, rear = last
  get frontLock() { return this.locks[0]; }
  set frontLock(v) { this.locks[0] = v; }
  get rearLock() { return this.locks[this.nA - 1]; }
  set rearLock(v) { this.locks[this.nA - 1] = v; }
  // axles that take drive right now (2WD drops the others)
  isDriven(a) { const L = this.layout; return L.axles[a].driven && (!this.rwd || L.rwd.includes(a)); }
  get canLock() { return this.layout.lockers && this.layout.axles.some(a => a.driven && a.diff !== 'lsd'); }
  get canLockCentre() { return this.layout.centre === 'open'; }
  // front and rear turn together: the driver's centre lock, or a part-time box in 4WD
  get centreLocked() { return this.centerLock || (this.layout.centre === 'locked' && !this.rwd); }

  updateInertia() {
    const P = this.P;
    this.inv[0] = 1 / P.engine.inertia;
    this.inv[1] = 1 / (this.mode === 'auto' ? P.auto.turbineInertia : P.clutch.inputInertia);
    for (let i = 2; i < this.nB; i++) this.inv[i] = 1 / P.tire.inertia;
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
  wheelMean() {
    const w = this.w;
    let s = 0, n = 0;
    for (let a = 0; a < this.nA; a++) if (this.isDriven(a)) { s += w[2 + 2 * a]; s += w[3 + 2 * a]; n += 2; }
    return n ? s * (1 / n) : 0;
  }

  gearLabel() {
    if (this.mode === 'manual') return this.manualGear === 0 ? 'N' : this.manualGear < 0 ? 'R' : String(this.manualGear);
    if (this.selector === 'D') return 'D' + this.autoGear;
    return this.selector;
  }

  say(msg) { this.message = { text: msg, t: 2.2 }; }

  // ---------------------------------------------------------------- commands
  // what the gearbox setting shows: a manual-only car (BTR-80) has no automatic, so 'auto' is the manual box
  // with automatic gear selection (and the auto-clutch)
  get gearboxSetting() { return this.P.manualOnly ? (this.autoShift ? 'auto' : 'manual') : this.mode; }
  setGearbox(v) {
    if (!this.P.manualOnly) { if (this.mode !== v) this.toggleMode(); return; }
    if (this.mode !== 'manual') { this.mode = 'manual'; this.manualGear = 0; this.shift = null; this.lockup = 0; this.updateInertia(); this.w[1] = this.w[0]; }
    this.autoShift = v === 'auto';
    this.say(this.autoShift ? 'Manual 5-speed, automatic shifting' : 'Manual 5-speed' + (this.clutchAssist ? ' (auto clutch)' : ' (clutch pedal: Shift)'));
  }
  toggleMode() {
    if (this.P.manualOnly) { this.setGearbox(this.autoShift ? 'manual' : 'auto'); return; }
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
    this.manualGear = 0; this.selector = 'N'; this.autoGear = 1; this.shift = null; this.lockup = 0;
    this.updateInertia();
    this.w[1] = this.w[0];
    this.say(this.mode === 'auto' ? `Automatic (${this.P.auto.ratios.length}-speed, torque converter)` : `Manual ${this.P.manual.ratios.length}-speed` + (this.clutchAssist ? ' (auto clutch)' : ' (clutch pedal: Shift)'));
  }
  toggleClutchAssist() {
    this.clutchAssist = !this.clutchAssist;
    this.say(this.clutchAssist ? 'Auto clutch ON' : 'Auto clutch OFF: hold Shift for the clutch');
  }
  toggleRange(speed) {
    if (Math.abs(speed) > 1.5) { this.say('Stop to change transfer range'); return; }
    if (!this.P.transfer.low) { this.say('No low range on this car'); return; }
    if (this.rwd && this.range === 'high') { this.say('Select 4WD before LOW range'); return; }
    this.range = this.range === 'high' ? 'low' : 'high';
    this.say(this.range === 'low' ? 'LOW range engaged' : 'HIGH range engaged');
  }
  toggleCenterLock() {
    if (!this.canLockCentre) {
      this.say({ viscous: 'Viscous centre coupling: it locks by itself', locked: 'Part-time 4WD: no centre diff, front and rear turn together in 4WD',
        none: 'No centre diff: one axle drives' }[this.layout.centre]);
      return;
    }
    if (this.rwd) { this.say('Centre lock needs 4WD'); return; }
    this.centerLock = !this.centerLock; this.say(this.centerLock ? 'Centre diff LOCKED' : 'Centre diff open');
  }
  toggleRwd(speed) {
    if (!this.layout.rwd.length) { this.say({ awd: 'Permanent all-wheel drive', rwd: 'Rear-wheel drive', fwd: 'Front-wheel drive' }[this.layout.layout]); return; }
    if (!this.rwd && this.range === 'low') { this.say('RWD only in HIGH range'); return; }
    if (Math.abs(speed) > 8) { this.say('Slow down to change 2WD / 4WD'); return; }
    this.rwd = !this.rwd;
    if (this.rwd) this.centerLock = false;
    this.say(this.rwd ? '2WD: rear-wheel drive' : '4WD: all wheels driven');
  }
  cycleAxleLockers() {
    if (!this.canLock) { this.say(this.layout.lockers ? 'Self-locking axle diffs: no lockers to engage' : 'No axle lockers on this car'); return; }
    const n = this.nA;
    if (n === 2) {
      if (!this.rearLock) { this.rearLock = true; this.say('Rear locker ON'); }
      else if (!this.frontLock) { this.frontLock = true; this.say('Front + rear lockers ON'); }
      else { this.rearLock = false; this.frontLock = false; this.say('Axle lockers off'); }
      return;
    }
    // more axles: rear half -> all -> off
    const rear = this.locks.slice(n / 2).every(Boolean), all = this.locks.every(Boolean);
    if (!rear) { this.locks.fill(true, Math.ceil(n / 2)); this.say('Rear axle lockers ON'); }
    else if (!all) { this.locks.fill(true); this.say('All axle lockers ON'); }
    else { this.locks.fill(false); this.say('Axle lockers off'); }
  }
  startEngine() {
    const E0 = this.P.engine;
    if (this.running) { this.say('Engine is already running (O switches it off)'); return; }
    if (this.mode === 'manual' && !this.clutchAssist && this.manualGear !== 0 && this.clutchPedal < 0.6) {
      this.say('In gear: hold the clutch (Shift) or select neutral, then press I');
      return;
    }
    // cranking time before it fires: catchMin + random catchSpread (player-tuned: 0.35-0.5 s)
    this.starterTime = 3; this.crankTime = 0; this.catchAt = (E0.catchMin ?? 0.35) + (E0.catchSpread ?? 0.15) * Math.random();
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
    const target = clamp(this.manualGear + dir, -1, this.P.manual.ratios.length);
    if (target === this.manualGear) return;
    if (target === -1 && this.wheelMean() * this.P.tire.radius > 1.5) { this.say('Too fast for reverse'); this.grind = 0.35; return; }
    if (this.clutchAssist || this.autoShift) {
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
    // The starter turns the engine at ~200 rpm, unevenly (it slows on every compression stroke). After catchAt the
    // first cylinders fire, more each revolution (fire ramps over ~0.35 s); it pulls away, flares (idle governor), settles.
    if (this.starterTime > 0) {
      this.starterTime -= h;
      this.crankTime += h;
      this.cranking = true;
      if (!this.running && rpm > 120 && this.crankTime > this.catchAt) {
        this.running = true; this.stalled = false; this.fire = 0; this.idleInt = 0; this.startGrace = 1.2; this.sinceCatch = 0;
      }
      if (this.running && rpm > 600 && this.fire > 0.95) { this.starterTime = 0; this.cranking = false; }
      if (this.starterTime <= 0 && !this.running) { this.cranking = false; this.say('Engine did not start: select N/P or press the clutch'); }
    } else this.cranking = false;
    this.fire = this.running ? Math.min(1, this.fire + h / (E.fireRamp ?? 0.2)) : 0;
    this.sinceCatch += h;
    this.startGrace = Math.max(0, this.startGrace - h);
    if (this.running && rpm < E.stallRpm && !this.cranking && this.startGrace <= 0) {
      this.running = false; this.stalled = true;
      this.say('Engine stalled: press I to start');
    }
    if (rpm > E.limiterRpm) this.limiterCut = true;
    else if (rpm < E.limiterRpm - 180) this.limiterCut = false;

    // ---- transmission logic
    let throttle = ctl.throttle;
    if (this.mode === 'manual') { if (this.autoShift) this.autoShiftLogic(ctl, speed, h); throttle *= this.manualLogic(h, ctl); }
    else throttle *= this.autoLogic(h, ctl, speed);
    this.driverThrottle = ctl.throttle;

    // ---- idle governor + throttle lag
    let idleThr = 0;
    if (this.running) {
      // start flare: the idle valve opens wide, peak ~2100 rpm (player-tuned; recordings showed ~1500),
      // settling to idle over ~3 s (hold 1.1 s, then tau 0.9 s)
      const sc = this.sinceCatch, flare = (E.startFlare ?? 1000) * (sc < 1.1 ? 1 : Math.exp(-(sc - 1.1) / 0.9));
      const err = E.idleRpm + flare - rpm;
      // (no integral while the cylinders are still catching: it would wind up and overshoot the flare)
      if (rpm < E.idleRpm + flare + 500 && this.fire >= 1) this.idleInt = clamp(this.idleInt + err * h, -150, 500);
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
    const assist = this.clutchAssist || this.autoShift;
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

  // manual box, automatic gear choice (manual-only cars): the automatic's schedule on engine rpm at the wheel
  // (or ground) speed; 1 s between shifts. E / Q still shift by hand (the logic waits after that).
  autoShiftLogic(ctl, speed, h = 1 / 240) {
    const P = this.P, g = this.manualGear, top = P.manual.ratios.length;
    const acc = this._asV === undefined ? 0 : (speed - this._asV) / h;
    this._asV = speed;
    this.asAccel = (this.asAccel || 0) + (acc - (this.asAccel || 0)) * Math.min(1, h / 0.5);
    if (g < 1 || this.shift || this.sinceShift < 1.0 || this.cranking) return;
    const wm = Math.min(Math.max(0, this.wheelMean()), Math.max(0, speed) / P.tire.radius * 1.25 + 0.5);
    const rpmAt = k => wm * Math.abs(this.ratioFor('manual', k)) * RPM;
    const t = ctl.throttle, sr = P.engine.shiftRpm || 4800, idle = P.engine.idleRpm;
    const up = idle + 500 + (sr - idle - 500) * Math.pow(t, 1.2);
    const down = idle + 150 + (0.6 * sr - idle - 150) * Math.pow(t, 1.5);
    // would it still gain speed in the next gear? Resistance now = drive force - m a; the next gear pulls with
    // the engine's full torque at its rpm (else a 30° climb in 1st low upshifts at the governor and bogs down)
    let pulling = ctl.throttle < 0.8 || g >= top;
    if (!pulling) {
      const m = this._mass || (this._mass = P.axles.reduce((a, x) => a + (x.mass || 0), P.bodyMass || 0) || 1);
      const F = this.axleDrive.reduce((a, b) => a + b, 0) / P.tire.radius;
      const Fn = 0.9 * table(P.engine.torque, rpmAt(g + 1)) * Math.abs(this.ratioFor('manual', g + 1)) / P.tire.radius;
      pulling = (Fn - (F - m * this.asAccel)) / m > 0.15;
    }
    if (g < top && rpmAt(g) > up && rpmAt(g + 1) > idle + 250 && pulling) this.shift = { phase: 'out', t: 0, target: g + 1 };
    else if (g > 1 && rpmAt(g) < down && rpmAt(g - 1) < sr - 150) this.shift = { phase: 'out', t: 0, target: g - 1 };
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
      const wmWheels = Math.max(0, this.wheelMean());
      const wmGround = Math.max(0, speed) / P.tire.radius;
      const wm = Math.min(wmWheels, wmGround * 1.25 + 0.5);
      const rpmAt = g => wm * Math.abs(this.ratioFor('auto', g)) * RPM;
      const t = ctl.throttle;
      const lowR = this.range === 'low' ? 250 : 0;
      // shift points follow the engine (shiftRpm: full-throttle upshift)
      const sr = P.engine.shiftRpm || 4800;
      const up = 1650 + lowR + (sr - 1650) * Math.pow(t, 1.3);
      const down = 1050 + (0.625 * sr - 1050) * Math.pow(t, 1.6);
      const g = this.autoGear;
      if (g < P.auto.ratios.length && rpmAt(g) > up && rpmAt(g + 1) > 1150) {
        this.autoGear = g + 1; this.shift = { t: 0 }; this.sinceShift = 0;
      } else if (g > 1 && rpmAt(g) < down && rpmAt(g - 1) < sr - 100) {
        this.autoGear = g - 1; this.shift = { t: 0 }; this.sinceShift = 0;
      }
    }
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
    if (this.running && !this.limiterCut) Tc = this.thr * this.fire * table(E.torque, Math.max(rpm, 0));
    this.Tcomb = Tc;
    // compression strokes (4 per revolution) of the cylinders not firing brake the crank and give the energy back: a cranking or stopping engine turns unevenly
    this.crankAng = (this.crankAng + w[0] * h) % (4 * Math.PI);
    if (this.fire < 1) Tc -= (E.compressionTorque ?? 120) * (1 - this.fire) * Math.sin(4 * this.crankAng) * clamp(1.5 - Math.abs(rpm) / 800, 0, 1);
    if (this.cranking) Tc += E.starterTorque * clamp(1 - rpm / (E.starterRpm ?? 420), 0, 1);
    w[0] += h * Tc * inv[0];

    if (this.mode === 'auto') {
      const tc = this.converter(w[0], w[1]);
      w[0] -= h * tc.Tp * inv[0];
      w[1] += h * tc.Tt * inv[1];
      this.tcPump = tc.Tp;
    }
    const nW = this.nW, nA = this.nA, L = this.layout;
    for (let i = 0; i < nW; i++) w[2 + i] += h * tireT[i] * inv[2 + i];

    // ---- constraint rows
    const A = this.active; A.length = 0;
    const G = this.currentRatio();
    // driven wheels: the gear, park and hold rows act on the centre diff's input, which splits the torque
    // split : 1 - split between the groups (2WD: all of it to the one that is left)
    let n0 = 0, n1 = 0;
    for (let a = 0; a < nA; a++) if (this.isDriven(a)) { if (L.axles[a].group === 0) n0 += 2; else n1 += 2; }
    const s = !n1 ? 1 : !n0 ? 0 : L.split, dw = this.dw;
    for (let a = 0; a < nA; a++) dw[2 * a] = dw[2 * a + 1] = !this.isDriven(a) ? 0 : L.axles[a].group === 0 ? s / n0 : (1 - s) / n1;
    const spread = (row, v) => { row.clear(); for (let i = 0; i < nW; i++) row.j[2 + i] = v * dw[i]; return row; };
    if (G !== 0) {
      const row = spread(R.gear, -G);
      row.j[1] = 1;
      if (this.mode === 'auto' && this.shift) {
        const f = clamp(this.shift.t / P.auto.shiftTime, 0, 1);
        row.bound(P.auto.shiftCapacity * (0.3 + 0.7 * f) * h);
      } else row.bound(Infinity);
      A.push(row);
    } else R.gear.lambda = 0;

    if (this.mode === 'manual') {
      const e = clamp((0.8 - this.clutchPedal) / 0.6, 0, 1);
      const cap = P.clutch.capacity * e * e * (3 - 2 * e);
      if (cap > 0) { const r = R.clutch.clear(); r.j[0] = 1; r.j[1] = -1; A.push(r.bound(cap * h)); } else R.clutch.lambda = 0;
    } else {
      const cap = P.auto.lockupCapacity * this.lockup;
      if (cap > 0) { const r = R.clutch.clear(); r.j[0] = 1; r.j[1] = -1; A.push(r.bound(cap * h)); } else R.clutch.lambda = 0;
      if (this.selector === 'P') A.push(spread(R.park, 1).bound(Infinity));
    }
    // centre lock (the driver's, or a part-time box in 4WD): mean speed of group 0 = mean speed of group 1
    // (driven axles only). The row's impulse is the torque (at the wheels) it moves between the groups.
    const lockC = this.centreLocked;
    const across = r => { r.clear(); for (let a = 0; a < nA; a++) if (this.isDriven(a)) { const v = L.axles[a].group === 0 ? 1 / n0 : -1 / n1; r.j[2 + 2 * a] = v; r.j[3 + 2 * a] = v; } return r; };
    if (lockC) {
      if (n0 && n1) A.push(across(R.center).bound(Infinity)); else R.center.lambda = 0;
    }
    // viscous coupling: torque grows with the prop shafts' speed difference (wheel speeds x final drive)
    const visc = !lockC && L.centre === 'viscous' && n0 && n1;
    if (visc) {
      const r = across(R.visc);
      let dv = 0;
      for (let i = 0; i < nW; i++) dv += r.j[2 + i] * w[2 + i];
      const fd = P.finalDrive;
      A.push(r.bound(L.viscous * Math.abs(dv) * fd * RPM * fd * h));
    } else R.visc.lambda = 0;
    // axles on the same centre-diff output turn together (prop shafts, no diff between them)
    for (let a = 0; a < nA; a++) {
      const r = R.links[a];
      let b = -1;
      if (this.isDriven(a)) for (let c = a - 1; c >= 0; c--) if (this.isDriven(c) && L.axles[c].group === L.axles[a].group) { b = c; break; }
      if (b < 0) { r.lambda = 0; continue; }
      r.clear(); r.j[2 + 2 * b] = 0.5; r.j[3 + 2 * b] = 0.5; r.j[2 + 2 * a] = -0.5; r.j[3 + 2 * a] = -0.5;
      A.push(r.bound(Infinity));
    }
    // axle diffs: locker (driver), or a cam-type limited slip whose friction follows the drive torque
    for (let a = 0; a < nA; a++) {
      const r = R.lock[a], ax = L.axles[a];
      const lsd = ax.diff === 'lsd' && this.isDriven(a);
      if (!this.locks[a] && !lsd) { r.lambda = 0; continue; }
      r.clear(); r.j[2 + 2 * a] = 1; r.j[3 + 2 * a] = -1;
      A.push(r.bound(this.locks[a] ? Infinity : (ax.lock * Math.abs(this.axleDrive[a]) + 15) * h));
    }
    const hbA = L.handbrake, hbMulti = hbA.length > 1;
    if (hbMulti) {
      // several axles (BTR: every wheel's brake): each axle held on its own; one row on the mean of them all
      // would let axles counter-rotate through the centre diff and hold nothing. The standstill hold joins in.
      R.hb.lambda = 0;
      for (let a = 0; a < nA; a++) {
        const r = R.hbAx[a];
        if (hbT + holdT <= 0 || !hbA.includes(a)) { r.lambda = 0; continue; }
        r.clear(); r.j[2 + 2 * a] = 0.5; r.j[3 + 2 * a] = 0.5;
        A.push(r.bound((hbT + holdT) / hbA.length * h));
      }
    } else if (hbT > 0) {
      const r = R.hb.clear(), v = 1 / (2 * hbA.length);
      for (const a of hbA) { r.j[2 + 2 * a] = v; r.j[3 + 2 * a] = v; }
      A.push(r.bound(hbT * h));
    } else R.hb.lambda = 0;
    if (holdT > 0 && !hbMulti) A.push(spread(R.hold, 1).bound(holdT * h)); else R.hold.lambda = 0;
    for (let i = 0; i < nW; i++) {
      if (brakeT[i] > 0) {
        const r = R.b[i].clear(); r.j[2 + i] = 1; A.push(r.bound(brakeT[i] * h));
      } else R.b[i].lambda = 0;
      const rr = R.r[i].clear(); rr.j[2 + i] = 1; A.push(rr.bound(rrT[i] * h));
    }
    // engine friction + pumping losses (implicit Coulomb-style so a dead engine comes to rest cleanly)
    const thr = this.thr;
    let Tf = 12 + 0.0085 * Math.abs(rpm) + 1.2e-6 * rpm * rpm + (1 - thr) * (6 + 0.0105 * Math.abs(rpm));
    if (!this.running) Tf += 16;
    { const r = R.efric.clear(); r.j[0] = 1; A.push(r.bound(Tf * h)); }
    { const r = R.ifric.clear(); r.j[1] = 1; A.push(r.bound((1.5 + 0.004 * Math.abs(w[1])) * h)); }

    this.solve(A, 24);

    this.engineAlpha = (w[0] - w0Old) / h;
    const lg = G !== 0 ? R.gear.lambda : 0;
    const lc = lockC ? R.center.lambda : 0;
    const lh = hbT > 0 && !hbMulti ? R.hb.lambda : 0;
    const lo = holdT > 0 && !hbMulti ? R.hold.lambda : 0;
    const gj = R.gear.j, cj = R.center.j, hj = R.hb.j, oj = R.hold.j;
    for (let i = 0; i < nW; i++) {
      const b = 2 + i;
      let t = (G !== 0 ? gj[b] * lg : 0) + (lockC ? cj[b] * lc : 0) + (hbT > 0 ? hj[b] * lh : 0) + (holdT > 0 ? oj[b] * lo : 0);
      if (visc) t += R.visc.j[b] * R.visc.lambda;
      for (let a = 0; a < nA; a++) { const r = R.links[a]; if (r.lambda !== 0) t += r.j[b] * r.lambda; }
      if (hbMulti) for (let a = 0; a < nA; a++) { const r = R.hbAx[a]; if (r.lambda !== 0) t += r.j[b] * r.lambda; }
      this.wheelDrive[i] = t / h;
    }
    const fd = P.finalDrive;
    for (let a = 0; a < nA; a++) {
      this.axleDrive[a] = this.wheelDrive[2 * a] + this.wheelDrive[2 * a + 1];
      this.propTorque[a] = this.axleDrive[a] / fd;
    }
    this.clutchSlip = w[0] - w[1];
    const maxT = table(E.torque, Math.max(rpm, 0));
    this.load = maxT > 0 ? Tc / maxT : 0;
  }

  converter(we, wt) {
    const K0 = this.P.auto.stallK;
    const visc = 0.06 * (we - wt);   // keeps a little coupling when both sides are nearly stopped
    if (we >= wt) {
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
    const w = this.w, inv = this.inv, B = this.nB;
    for (let r = 0; r < A.length; r++) {
      const row = A[r], j = row.j;
      let k = 0;
      for (let b = 0; b < B; b++) k += j[b] * j[b] * inv[b];
      row.m = k > 0 ? 1 / k : 0;
      // warm start
      const l = clamp(row.lambda, row.lo, row.hi);
      row.lambda = l;
      if (l !== 0) for (let b = 0; b < B; b++) w[b] += j[b] * inv[b] * l;
    }
    for (let it = 0; it < iters; it++) {
      for (let r = 0; r < A.length; r++) {
        const row = A[r], j = row.j;
        let jv = 0;
        for (let b = 0; b < B; b++) jv += j[b] * w[b];
        const old = row.lambda;
        const nl = clamp(old - row.m * jv, row.lo, row.hi);
        const d = nl - old;
        if (d !== 0) {
          row.lambda = nl;
          for (let b = 0; b < B; b++) w[b] += j[b] * inv[b] * d;
        }
      }
    }
  }
}
