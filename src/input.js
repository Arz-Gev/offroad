// Keyboard + gamepad input. Digital keys are ramped like real pedals so you can feather the throttle.
//
// BINDINGS is the single source of truth for every control: main.js dispatches the discrete actions,
// and the HUD hints, the welcome card and the menu's controls page are all generated from it.
// Discrete actions fire immediately from the key/pad event (onAction), not from the game loop.
// While a menu is open, uiHandler receives the keys / pad buttons instead of the game.

// standard-mapping gamepad buttons
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

// keys: labels shown to the player. codes: KeyboardEvent.code values that fire the action.
// pad: label of the gamepad control. button: pad button index that fires the action.
export const BINDINGS = [
  { id: 'throttle', group: 'Driving', label: 'Throttle', keys: ['W', '↑'], pad: 'RT' },
  { id: 'brake', group: 'Driving', label: 'Brake · automatic: hold at a stop to reverse', keys: ['S', '↓'], pad: 'LT' },
  { id: 'steer', group: 'Driving', label: 'Steer', keys: ['A', 'D'], alt: ['←', '→'], pad: 'L stick' },
  { id: 'handbrake', group: 'Driving', label: 'Handbrake', keys: ['Space'], pad: 'A' },
  { id: 'clutch', group: 'Driving', label: 'Clutch pedal (manual with auto-clutch off)', keys: ['Shift'], pad: 'LB' },

  { id: 'shiftUp', group: 'Gearbox & 4×4', label: 'Shift up · automatic: selector P → R → N → D', codes: ['KeyE'], keys: ['E'], pad: 'RB', button: PAD.RB },
  { id: 'shiftDown', group: 'Gearbox & 4×4', label: 'Shift down · automatic: selector D → N → R → P', codes: ['KeyQ'], keys: ['Q'], pad: 'X', button: PAD.X },
  { id: 'gearbox', group: 'Gearbox & 4×4', label: 'Automatic ⇄ manual gearbox', codes: ['KeyM'], keys: ['M'], pad: 'View', button: PAD.VIEW },
  { id: 'autoClutch', group: 'Gearbox & 4×4', label: 'Auto-clutch on / off (manual)', codes: ['KeyK'], keys: ['K'] },
  { id: 'range', group: 'Gearbox & 4×4', label: 'Transfer case HIGH / LOW (stop first)', codes: ['KeyT'], keys: ['T'], pad: 'D-pad ↓', button: PAD.DOWN },
  { id: 'centreLock', group: 'Gearbox & 4×4', label: 'Centre diff lock', codes: ['KeyX'], keys: ['X'], pad: 'D-pad ←', button: PAD.LEFT },
  { id: 'lockers', group: 'Gearbox & 4×4', label: 'Axle lockers: rear → front + rear → off', codes: ['KeyZ'], keys: ['Z'], pad: 'D-pad →', button: PAD.RIGHT },
  { id: 'traction', group: 'Gearbox & 4×4', label: 'Traction control on / off (brakes a spinning wheel)', codes: ['KeyY'], keys: ['Y'] },

  { id: 'engineStart', group: 'Vehicle', label: 'Start engine', codes: ['KeyI'], keys: ['I'], pad: 'L stick click', button: PAD.LS },
  { id: 'engineStop', group: 'Vehicle', label: 'Stop engine', codes: ['KeyO'], keys: ['O'] },
  { id: 'pressureDown', group: 'Vehicle', label: 'Tyre pressure down (air down for grip)', codes: ['BracketLeft'], keys: ['['] },
  { id: 'pressureUp', group: 'Vehicle', label: 'Tyre pressure up', codes: ['BracketRight'], keys: [']'] },
  { id: 'headlights', group: 'Vehicle', label: 'Headlights off / low / high', codes: ['KeyL'], keys: ['L'], pad: 'D-pad ↑', button: PAD.UP },
  { id: 'lightBar', group: 'Vehicle', label: 'Roof light bar', codes: ['KeyJ'], keys: ['J'] },
  { id: 'hazards', group: 'Vehicle', label: 'Hazard lights', codes: ['KeyG'], keys: ['G'] },
  { id: 'recover', group: 'Vehicle', label: 'Recover: put the truck back on its wheels', codes: ['KeyR'], keys: ['R'], pad: 'B', button: PAD.B },

  { id: 'camera', group: 'Camera & world', label: 'Next camera: chase, cockpit, hood, wheel, orbit', codes: ['KeyC'], keys: ['C'], pad: 'Y', button: PAD.Y },
  { id: 'look', group: 'Camera & world', label: 'Look around · zoom', keys: ['Drag mouse', 'Wheel'], pad: 'R stick' },
  { id: 'time', group: 'Camera & world', label: 'Time of day: day, dusk, night', codes: ['KeyN'], keys: ['N'] },

  { id: 'menu', group: 'Game', label: 'Menu (pauses the game)', codes: ['Escape'], keys: ['Esc'], pad: 'Menu', button: PAD.MENU },
  { id: 'locations', group: 'Game', label: 'Locations: teleport to the proving ground lanes', codes: ['KeyP'], keys: ['P'] },
  { id: 'controls', group: 'Game', label: 'Controls (this list)', codes: ['KeyH'], keys: ['H'] },
  { id: 'mute', group: 'Game', label: 'Sound on / off', codes: ['KeyV'], keys: ['V'] },
  { id: 'suspension', group: 'Game', label: 'Suspension and tyre load panel', codes: ['KeyU'], keys: ['U'] },
  { id: 'telemetry', group: 'Game', label: 'Telemetry readout', codes: ['F3', 'Backquote'], keys: ['F3', '`'] },
];

export const BINDING = Object.fromEntries(BINDINGS.map(b => [b.id, b]));
const KEY_ACTION = {};
const PAD_ACTION = {};
for (const b of BINDINGS) {
  for (const c of b.codes || []) KEY_ACTION[c] = b.id;
  if (b.button !== undefined) PAD_ACTION[b.button] = b.id;
}
// The F row stays with the browser (F5 reload, F11 fullscreen, F12 devtools), except the bound F3.
// Every other plain key is swallowed while driving: no page scroll (Space, arrows), no focus moves (Tab),
// no single-key browser features such as Firefox quick find (/ and ').
const BROWSER_KEY = /^F\d+$/;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const padClass = l => ({ A: ' pad-a', B: ' pad-b', X: ' pad-x', Y: ' pad-y' })[l] || '';

// keycap HTML for an action on the given device ('kb' | 'pad'). Falls back to the keyboard label.
export function capsHTML(id, device = 'kb', { all = false } = {}) {
  const b = BINDING[id];
  if (!b) return '';
  if (device === 'pad' && b.pad) return `<kbd class="cap pad${padClass(b.pad)}">${esc(b.pad)}</kbd>`;
  const keys = all && b.alt ? [...b.keys, ...b.alt] : b.keys;
  return keys.map(k => `<kbd class="cap">${esc(k)}</kbd>`).join('');
}
export function padCapHTML(id) {
  const b = BINDING[id];
  return b && b.pad ? `<kbd class="cap pad${padClass(b.pad)}">${esc(b.pad)}</kbd>` : '<span class="cap-none">–</span>';
}

export class Input {
  constructor(el) {
    this.keys = new Set();
    this.pressed = new Set();      // edge-triggered this frame (kept for console tests)
    this.raw = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: 0, analogSteer: false };
    this.mouse = { dx: 0, dy: 0, wheel: 0, down: false, lastMove: 0 };
    this.device = 'kb';            // last used: 'kb' | 'pad'
    this.onAction = null;          // (id, device) => void
    this.onDevice = null;          // (device) => void
    this.uiHandler = null;         // (event) => bool handled; set while a menu is open
    this.padPrev = {};
    this.padRepeat = {};

    window.addEventListener('keydown', e => {
      // let browser / OS shortcuts through untouched (Cmd+R, Ctrl+W, Cmd+L, ...).
      // On macOS no keyup arrives for keys held while Cmd is down, so drop held keys to avoid stuck pedals.
      if (e.metaKey || e.ctrlKey || e.altKey) { if (e.key === 'Meta') this.keys.clear(); return; }
      this.setDevice('kb');
      if (this.uiHandler) { if (this.uiHandler({ type: 'key', e })) e.preventDefault(); return; }
      const action = KEY_ACTION[e.code];
      if (action || !BROWSER_KEY.test(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (action && this.onAction) this.onAction(action, 'kb');
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); if (e.key === 'Meta') this.keys.clear(); });
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
  }

  setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    if (this.onDevice) this.onDevice(d);
  }

  // drop held keys and pedal ramps (menu opened, focus lost)
  reset() {
    this.keys.clear();
    this.pressed.clear();
    this._thr = this._brk = this._steer = 0;
    this.mouse.down = false;
  }

  down(...codes) { return codes.some(c => this.keys.has(c)); }
  hit(code) { return this.pressed.has(code); }

  // call once per rendered frame
  update(dt) {
    const r = this.raw;
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
      const active = Math.abs(ax) > 0.12 || Math.abs(gp.axes[1] || 0) > 0.3 || rtA > 0.05 || ltA > 0.05 || gp.buttons.some(b => b.pressed);
      if (active) this.setDevice('pad');
      const edge = i => { const p = !!gp.buttons[i]?.pressed; const e = p && !this.padPrev[i]; this.padPrev[i] = p; return e; };
      if (this.uiHandler) {
        // menu navigation: d-pad / left stick with key-repeat, A accept, B back, LB/RB tabs
        const now = performance.now();
        const dir = (name, held) => {
          const st = this.padRepeat[name] || (this.padRepeat[name] = { on: false, next: 0 });
          if (!held) { st.on = false; return; }
          if (!st.on) { st.on = true; st.next = now + 380; this.uiHandler({ type: 'pad', btn: name }); }
          else if (now >= st.next) { st.next = now + 110; this.uiHandler({ type: 'pad', btn: name }); }
        };
        const b = i => !!gp.buttons[i]?.pressed;
        dir('up', b(PAD.UP) || (gp.axes[1] || 0) < -0.6);
        dir('down', b(PAD.DOWN) || (gp.axes[1] || 0) > 0.6);
        dir('left', b(PAD.LEFT) || ax < -0.6);
        dir('right', b(PAD.RIGHT) || ax > 0.6);
        for (const i of [PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT]) this.padPrev[i] = b(i);
        if (edge(PAD.A)) this.uiHandler({ type: 'pad', btn: 'accept' });
        if (edge(PAD.B)) this.uiHandler({ type: 'pad', btn: 'back' });
        if (edge(PAD.MENU)) this.uiHandler({ type: 'pad', btn: 'menu' });
        if (edge(PAD.LB)) this.uiHandler({ type: 'pad', btn: 'prevTab' });
        if (edge(PAD.RB)) this.uiHandler({ type: 'pad', btn: 'nextTab' });
        for (const i of Object.keys(PAD_ACTION)) this.padPrev[i] = !!gp.buttons[i]?.pressed;
      } else if (this.device === 'pad') {
        const dz = v => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
        steer = Math.sign(dz(ax)) * Math.pow(Math.abs(dz(ax)), 1.4);
        thr = Math.max(thr, rtA); brk = Math.max(brk, ltA);
        r.analogSteer = true;
        if (gp.buttons[PAD.A]?.pressed) hb = 1;
        if (gp.buttons[PAD.LB]?.pressed) clutch = 1;
        for (const i in PAD_ACTION) if (edge(+i) && this.onAction) this.onAction(PAD_ACTION[i], 'pad');
        // right stick looks around
        this.mouse.dx += (gp.axes[2] || 0) * 14; this.mouse.dy += (gp.axes[3] || 0) * 10;
        if (Math.abs(gp.axes[2] || 0) > 0.2 || Math.abs(gp.axes[3] || 0) > 0.2) this.mouse.lastMove = performance.now();
      } else {
        for (const i in PAD_ACTION) this.padPrev[i] = !!gp.buttons[i]?.pressed;
      }
    }
    r.throttle = thr; r.brake = brk; r.steer = steer; r.clutch = clutch; r.handbrake = hb;
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
  }
}
