// Keyboard + gamepad input. Digital keys are ramped like real pedals so you can feather the throttle.

export const KEYS_HELP = [
  ['W / ↑', 'Throttle'], ['S / ↓', 'Brake (auto: hold at a stop = reverse)'], ['A D / ← →', 'Steer'],
  ['Space', 'Handbrake'], ['Shift', 'Clutch (manual, auto-clutch off)'],
  ['E / Q', 'Gear up / down (auto: selector P R N D)'], ['M', 'Automatic ⇄ Manual'], ['K', 'Auto-clutch on/off (manual)'],
  ['T', 'Transfer case HIGH / LOW'], ['X', 'Centre diff lock'], ['Z', 'Axle lockers: rear → front+rear → off'],
  ['[ / ]', 'Tyre pressure −/+'], ['I', 'Start engine / O stop'],
  ['L', 'Headlights off / low / high'], ['J', 'Roof light bar'], ['G', 'Hazards'],
  ['N', 'Time: day / dusk / night'], ['C', 'Camera: chase / cockpit / hood / wheel / orbit'],
  ['Mouse drag', 'Look around · wheel: zoom'], ['R', 'Recover (put back on wheels)'], ['P', 'Teleport: spawn / proving ground / hill'],
  ['V', 'Sound on/off'], ['F3', 'Telemetry'], ['H', 'Hide this help'],
];

export class Input {
  constructor(el) {
    this.keys = new Set();
    this.pressed = new Set();      // edge-triggered this frame
    this.raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, analogSteer: false };
    this.mouse = { dx: 0, dy: 0, wheel: 0, down: false, lastMove: 0 };
    this.usingPad = false;
    window.addEventListener('keydown', e => {
      if (e.repeat) { if (this.isGameKey(e.code)) e.preventDefault(); return; }
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (this.isGameKey(e.code)) e.preventDefault();
      this.usingPad = false;
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousedown', e => { this.mouse.down = true; this.mouse.lastMove = performance.now(); e.preventDefault(); });
    window.addEventListener('mouseup', () => { this.mouse.down = false; });
    window.addEventListener('mousemove', e => {
      if (this.mouse.down || document.pointerLockElement) {
        this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
        this.mouse.lastMove = performance.now();
      }
    });
    el.addEventListener('wheel', e => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    this.padPrev = {};
  }

  isGameKey(code) {
    return ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F3'].includes(code);
  }

  down(...codes) { return codes.some(c => this.keys.has(c)); }
  hit(code) { return this.pressed.has(code); }

  // call once per rendered frame
  update(dt) {
    const r = this.raw;
    const k = this.keys;
    const up = this.down('KeyW', 'ArrowUp'), dn = this.down('KeyS', 'ArrowDown');
    const lt = this.down('KeyA', 'ArrowLeft'), rt = this.down('KeyD', 'ArrowRight');
    // pedal ramps (keyboard)
    const ramp = (cur, on, upRate, downRate) => on ? Math.min(1, cur + upRate * dt) : Math.max(0, cur - downRate * dt);
    let thr = ramp(this._thr || 0, up, 2.2, 5);
    let brk = ramp(this._brk || 0, dn, 3.5, 6);
    this._thr = thr; this._brk = brk;
    let steer = this._steer || 0;
    const target = (rt ? 1 : 0) - (lt ? 1 : 0);
    const rate = target === 0 ? 3.2 : (Math.sign(target) !== Math.sign(steer) && steer !== 0 ? 4.5 : 2.0);
    steer += Math.max(-rate * dt, Math.min(rate * dt, target - steer));
    this._steer = steer;
    let clutch = this.down('ShiftLeft', 'ShiftRight') ? 1 : 0;
    let hb = this.down('Space') ? 1 : 0;
    r.analogSteer = false;

    // gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find(p => p && p.connected);
    if (gp) {
      const ax = gp.axes[0] || 0;
      const rtA = gp.buttons[7]?.value || 0, ltA = gp.buttons[6]?.value || 0;
      const active = Math.abs(ax) > 0.12 || rtA > 0.05 || ltA > 0.05 || gp.buttons.some(b => b.pressed);
      if (active) this.usingPad = true;
      if (this.usingPad) {
        const dz = v => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
        steer = Math.sign(dz(ax)) * Math.pow(Math.abs(dz(ax)), 1.4);
        thr = Math.max(thr, rtA); brk = Math.max(brk, ltA);
        r.analogSteer = true;
        if (gp.buttons[0]?.pressed) hb = 1;           // A
        if (gp.buttons[4]?.pressed) clutch = 1;       // LB
        const edge = (i, code) => { const p = !!gp.buttons[i]?.pressed; if (p && !this.padPrev[i]) this.pressed.add(code); this.padPrev[i] = p; };
        edge(5, 'KeyE'); edge(2, 'KeyQ'); edge(3, 'KeyC'); edge(1, 'KeyR'); edge(12, 'KeyL'); edge(13, 'KeyT'); edge(14, 'KeyX'); edge(15, 'KeyZ'); edge(9, 'KeyH'); edge(8, 'KeyM');
        // right stick looks around
        this.mouse.dx += (gp.axes[2] || 0) * 14; this.mouse.dy += (gp.axes[3] || 0) * 10;
        if (Math.abs(gp.axes[2] || 0) > 0.2 || Math.abs(gp.axes[3] || 0) > 0.2) this.mouse.lastMove = performance.now();
      }
    }
    r.throttle = thr; r.brake = brk; r.steer = steer; r.clutch = clutch; r.handbrake = hb;
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
  }
}
