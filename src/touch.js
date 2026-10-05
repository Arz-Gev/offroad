import { BINDING } from './input.js';

// On-screen controls for phones and tablets.
//
//   left thumb   steering: touch anywhere in the lower left and slide sideways (the stick appears under
//                the finger), or tilt the device like a steering wheel (setting touchSteer)
//   right thumb  gas and brake pedals: analog, higher up the pedal = more; handbrake, clutch (manual
//                without auto-clutch only), shift ▲ / ▼
//   top left     next to the menu button: camera, recover, the 4×4 drawer (range, diff locks, engine,
//                lights, tyres, tuning) and fullscreen
//   the view     drag to look around, pinch to zoom (feeds Input.mouse, like the mouse and the right stick)
//
// Pedals and steering are written into Input.touch, which Input.update reads while the device is 'touch'.
// Buttons fire the same actions as the keys (api.action). Everything uses pointer events with pointer
// capture, so each finger keeps its control even when it slides off it, and several work at once.
// Cost rules as in hud.js: DOM writes only when a shown value changes.

const DRAWER = ['range', 'centreLock', 'lockers', 'rwd', 'engineStart', 'headlights', 'pressureDown', 'pressureUp', 'tuning'];
const TILT_FULL = 28 * Math.PI / 180;   // device roll for full lock
const TILT_DEAD = 1.5 * Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const label = id => BINDING[id].touch;

const ICON_CAM = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h2.6l1.2-1.8h4.4l1.2 1.8H14v7H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="8.8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_RECOVER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.4 1.8v3h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class TouchControls {
  // api: { input, canvas, hud, action(id), mode: 'auto' | 'on' | 'off', steer: 'stick' | 'tilt' }
  constructor(api) {
    this.api = api;
    this.input = api.input;
    this.mode = 'auto';
    this.steerMode = 'stick';
    this.visible = false;
    this.c = {};                  // last written values
    this.pedals = {};             // name -> { el, fill, id }
    this.stick = { id: null, x0: 0, y0: 0, v: 0 };
    this.looks = new Map();       // pointerId -> { x, y } of fingers on the view
    this.pinch = 0;
    this.tilt = { v: 0, seen: false, asked: false };
    this.build();
    this.bindView();

    // a finger on the screen makes touch the active device; keys or a pad take over again (input.js).
    // After the tap, not on touch-down: the switch re-renders the menu and welcome card, which would
    // swallow the click on the button under the finger.
    window.addEventListener('pointerup', e => { if (e.pointerType === 'touch') setTimeout(() => this.input.setDevice('touch'), 0); }, true);
    if (window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches) this.input.device = 'touch';
    document.addEventListener('fullscreenchange', () => this.refreshFullscreen());
  }

  // ------------------------------------------------------------------ build
  build() {
    const hud = this.api.hud;
    const btn = (id, cls, inner, aria) => `<button type="button" class="tc-btn ${cls}" data-act="${id}" aria-label="${aria || label(id)}">${inner}</button>`;
    const el = document.createElement('div');
    el.className = 'tc-layer';
    el.hidden = true;
    el.innerHTML = `
      <div class="tc-steer" aria-label="Steering: slide left and right">
        <div class="tc-stick"><i class="tc-track"></i><i class="tc-arrow l"></i><i class="tc-arrow r"></i><i class="tc-knob"></i></div>
      </div>
      <div class="tc-tilt" hidden><i></i><span>Tilt to steer</span></div>
      <div class="tc-right">
        <div class="tc-shift">
          ${btn('shiftDown', 'tc-gear', '▼', 'Shift down')}
          ${btn('shiftUp', 'tc-gear', '▲', 'Shift up')}
        </div>
        <div class="tc-feet">
          <div class="tc-col">
            <button type="button" class="tc-btn tc-hold tc-hb" data-hold="handbrake" aria-label="Handbrake">HB</button>
          </div>
          <div class="tc-pedal clutch" data-pedal="clutch" hidden><i></i><b>Clutch</b></div>
          <div class="tc-pedal brake" data-pedal="brake"><i></i><b>Brake</b></div>
          <div class="tc-pedal gas" data-pedal="throttle"><i></i><b>Gas</b></div>
        </div>
      </div>
      <div class="tc-rotate">Turn the phone sideways for the best view</div>`;
    hud.root.append(el);
    this.el = el;

    // camera, recover, 4×4 drawer and fullscreen go next to the HUD's menu button
    const tools = document.createElement('div');
    tools.className = 'tc-tools';
    tools.hidden = true;
    tools.innerHTML = `
      ${btn('camera', 'tc-icon', ICON_CAM, 'Next camera')}
      ${btn('recover', 'tc-icon', ICON_RECOVER, 'Recover')}
      <button type="button" class="tc-btn tc-icon tc-4x4" data-drawer aria-expanded="false" aria-label="4×4, engine and lights">4×4</button>
      ${btn('fullscreen', 'tc-icon tc-full', ICON_FULL, 'Fullscreen')}`;
    hud.$('h-menubtn').after(tools);
    const drawer = document.createElement('div');
    drawer.className = 'tc-drawer';
    drawer.hidden = true;
    drawer.innerHTML = DRAWER.map(id => btn(id, 'tc-chip', label(id), BINDING[id].label)).join('');
    hud.root.querySelector('.tl-row').after(drawer);
    this.tools = tools;
    this.drawer = drawer;
    this.drawerBtn = tools.querySelector('[data-drawer]');
    this.fullBtn = tools.querySelector('.tc-full');
    this.chips = Object.fromEntries([...drawer.children].map(b => [b.dataset.act, b]));

    this.steerEl = el.querySelector('.tc-steer');
    this.stickEl = el.querySelector('.tc-stick');
    this.knob = el.querySelector('.tc-knob');
    this.tiltEl = el.querySelector('.tc-tilt');
    this.tiltBar = this.tiltEl.querySelector('i');
    for (const p of el.querySelectorAll('[data-pedal]')) this.pedals[p.dataset.pedal] = { el: p, fill: p.querySelector('i'), id: null };
    this.hb = el.querySelector('[data-hold="handbrake"]');

    for (const root of [el, tools, drawer]) {
      root.addEventListener('pointerdown', e => this.onDown(e));
      root.addEventListener('pointermove', e => this.onMove(e));
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(t, e => this.onUp(e));
      root.addEventListener('contextmenu', e => e.preventDefault());
      root.addEventListener('click', e => e.preventDefault());
    }
    this.refreshFullscreen();
  }

  // ------------------------------------------------------------------ settings
  configure({ mode, steer }) {
    if (mode !== undefined) this.mode = mode;
    if (steer !== undefined && steer !== this.steerMode) {
      this.steerMode = steer;
      if (steer === 'tilt') this.startTilt();
    }
    this.steerEl.hidden = this.steerMode === 'tilt';
    this.tiltEl.hidden = this.steerMode !== 'tilt';
    this.release();
    this.setDevice(this.input.device);
  }

  setDevice(dev) {
    const vis = this.mode === 'on' || (this.mode === 'auto' && dev === 'touch');
    if (vis === this.visible) return;
    this.visible = vis;
    this.el.hidden = this.tools.hidden = !vis;
    if (!vis) { this.drawer.hidden = true; this.release(); }
    document.body.classList.toggle('touch-ui', vis);
    this.api.hud.setTouch(vis);
  }

  // let go of everything (menu opened, controls hidden): no stuck pedals
  release() {
    for (const p of Object.values(this.pedals)) { p.id = null; p.el.classList.remove('on'); }
    this.stick.id = null; this.stick.v = 0;
    this.stickEl?.classList.remove('on');
    this.hbId = null; this.hb?.classList.remove('on');
    this.looks.clear();
    const t = this.input.touch;
    t.throttle = t.brake = t.clutch = t.handbrake = 0;
    if (this.steerMode !== 'tilt') t.steer = 0;
    this.c.stickX = this.c.thr = this.c.brk = this.c.clu = undefined;
  }

  // ------------------------------------------------------------------ pointer handling
  onDown(e) {
    const t = e.target.closest('[data-act], [data-hold], [data-pedal], [data-drawer], .tc-steer');
    if (!t) return;
    e.preventDefault();               // no focus, no text selection, no emulated mouse events
    this.input.setDevice('touch');
    if (this.steerMode === 'tilt' && !this.tilt.seen) this.startTilt();
    if (t.dataset.drawer !== undefined) {
      this.drawer.hidden = !this.drawer.hidden;
      this.drawerBtn.setAttribute('aria-expanded', !this.drawer.hidden);
      this.drawerBtn.classList.toggle('on', !this.drawer.hidden);
      buzz();
      return;
    }
    if (t.dataset.act) {
      // buttons fire on touch-down: quicker than click, and works while other fingers are down
      t.classList.add('on');
      setTimeout(() => t.classList.remove('on'), 140);
      buzz();
      if (t.dataset.act === 'fullscreen') this.toggleFullscreen();
      else this.api.action(t.dataset.act);
      return;
    }
    try { t.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    if (t.dataset.hold === 'handbrake') {
      this.hbId = e.pointerId; t.classList.add('on'); this.input.touch.handbrake = 1; buzz();
    } else if (t.dataset.pedal) {
      const p = this.pedals[t.dataset.pedal];
      p.id = e.pointerId;
      p.rect = t.getBoundingClientRect();
      t.classList.add('on');
      this.pedal(p, t.dataset.pedal, e.clientY);
    } else {
      // steering: the stick centres under the finger
      const r = this.steerEl.getBoundingClientRect();
      Object.assign(this.stick, { id: e.pointerId, x0: e.clientX, y0: e.clientY, v: 0, r: 64 * this.scale() });
      this.stickEl.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
      this.stickEl.classList.add('on');
      this.steer(e.clientX);
    }
  }

  onMove(e) {
    if (e.pointerId === this.stick.id) this.steer(e.clientX);
    else for (const [name, p] of Object.entries(this.pedals)) if (p.id === e.pointerId) this.pedal(p, name, e.clientY);
  }

  onUp(e) {
    const t = this.input.touch;
    if (e.pointerId === this.hbId) { this.hbId = null; this.hb.classList.remove('on'); t.handbrake = 0; }
    if (e.pointerId === this.stick.id) {
      this.stick.id = null; this.stick.v = 0;
      if (this.steerMode !== 'tilt') t.steer = 0;
      this.stickEl.classList.remove('on');
      this.stickEl.style.transform = '';
      this.setKnob(0);
    }
    for (const [name, p] of Object.entries(this.pedals)) {
      if (p.id !== e.pointerId) continue;
      p.id = null; p.el.classList.remove('on');
      t[name] = 0;
      this.setFill(p, name, 0);
    }
  }

  steer(x) {
    const s = this.stick, v = clamp((x - s.x0) / s.r, -1, 1);
    s.v = v;
    if (this.steerMode !== 'tilt') this.input.touch.steer = v;
    this.setKnob(v);
  }
  setKnob(v) {
    const q = Math.round(v * 50);
    if (q === this.c.stickX) return;
    this.c.stickX = q;
    this.knob.style.transform = `translateX(${((q / 50) * (this.stick.r || 64)).toFixed(1)}px)`;
  }

  // higher up the pedal = more: the bottom quarter is 30 %, the top quarter full
  pedal(p, name, y) {
    const r = p.rect;
    const v = 0.3 + 0.7 * clamp((r.bottom - y - r.height * 0.15) / (r.height * 0.6), 0, 1);
    this.input.touch[name] = v;
    this.setFill(p, name, v);
  }
  setFill(p, name, v) {
    const q = Math.round(v * 50);
    if (q === this.c[name]) return;
    this.c[name] = q;
    p.fill.style.transform = `scaleY(${q / 50})`;
  }

  scale() { return +getComputedStyle(this.api.hud.root).getPropertyValue('--s') || 1; }

  // ------------------------------------------------------------------ the view: look around, pinch to zoom
  bindView() {
    const cv = this.api.canvas, m = this.input.mouse;
    cv.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* gone */ }
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.looks.size === 2) this.pinch = this.spread();
      m.down = true; m.lastMove = performance.now();
    });
    cv.addEventListener('pointermove', e => {
      const f = this.looks.get(e.pointerId);
      if (!f) return;
      if (this.looks.size === 1) {
        m.dx += (e.clientX - f.x) * 1.15; m.dy += (e.clientY - f.y) * 1.15;
      }
      f.x = e.clientX; f.y = e.clientY;
      if (this.looks.size === 2) {
        const d = this.spread();
        m.wheel -= (d - this.pinch) / 30;     // spread the fingers: closer
        this.pinch = d;
      }
      m.lastMove = performance.now();
    });
    const up = e => {
      if (!this.looks.delete(e.pointerId)) return;
      if (this.looks.size === 0) m.down = false;
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(t, up);
  }
  spread() {
    const [a, b] = [...this.looks.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // ------------------------------------------------------------------ tilt steering
  // The device's roll in the screen plane, from the orientation angles, whatever way the screen is turned.
  // iOS asks for permission, which needs a tap: the menu switch or the first touch on the controls.
  startTilt() {
    if (!this.tiltBound) {
      this.tiltBound = true;
      window.addEventListener('deviceorientation', e => this.onOrientation(e));
    }
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function' && !this.tilt.asked) {
      this.tilt.asked = true;
      D.requestPermission().catch(() => {}).then(r => { if (r !== 'granted') this.tilt.asked = false; });
    }
  }
  onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    this.tilt.seen = true;
    if (this.steerMode !== 'tilt') return;
    const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    // world "up" in device coordinates, then turned into screen coordinates
    const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b);
    const th = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
    const sx = ux * Math.cos(th) - uy * Math.sin(th), sy = ux * Math.sin(th) + uy * Math.cos(th);
    if (Math.hypot(sx, sy) < 0.15) return;           // lying flat: no roll to read, keep the last value
    const roll = -Math.atan2(sx, sy);                // turning the device clockwise steers right
    const a = Math.abs(roll) < TILT_DEAD ? 0 : Math.sign(roll) * (Math.abs(roll) - TILT_DEAD);
    this.tilt.v = clamp(a / TILT_FULL, -1, 1);
  }

  // ------------------------------------------------------------------ fullscreen
  toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement) { Promise.resolve(d.exitFullscreen?.()).catch(() => {}); return; }
    Promise.resolve(d.documentElement.requestFullscreen?.({ navigationUI: 'hide' }))
      .then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }
  refreshFullscreen() {
    // iPhone Safari has no fullscreen for pages (Add to Home Screen runs the game full screen instead)
    const standalone = window.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches;
    this.fullBtn.hidden = !document.fullscreenEnabled || standalone;
    this.fullBtn.classList.toggle('on', !!document.fullscreenElement);
  }

  // ------------------------------------------------------------------ per frame
  update(dt, v, view) {
    if (!this.visible) return;
    const t = this.input.touch, c = this.c;
    if (this.steerMode === 'tilt') {
      // a little smoothing: hand tremor and sensor noise
      t.steer += (this.tilt.v - t.steer) * (1 - Math.exp(-dt * 18));
      const q = Math.round(t.steer * 40);
      if (q !== c.tilt) { c.tilt = q; this.tiltBar.style.transform = `translateX(${q * 1.2}px)`; }
    }
    const d = v.drivetrain;
    // the clutch pedal only exists in the manual box with auto-clutch off
    const clutch = d.mode === 'manual' && !d.clutchAssist;
    if (clutch !== c.clutch) { c.clutch = clutch; this.pedals.clutch.el.hidden = !clutch; if (!clutch) t.clutch = 0; }
    // drawer chips light up when engaged
    if (!this.drawer.hidden) {
      const state = `${d.range}|${d.centerLock}|${d.frontLock}${d.rearLock}|${d.rwd}|${d.running || d.cranking}|${view.lights.head}`;
      if (state !== c.chips) {
        c.chips = state;
        const ch = this.chips;
        ch.range.classList.toggle('on', d.range === 'low');
        ch.centreLock.classList.toggle('on', d.centerLock);
        ch.lockers.classList.toggle('on', d.rearLock || d.frontLock);
        ch.lockers.textContent = d.frontLock && d.rearLock ? 'LOCK F+R' : d.rearLock ? 'LOCK R' : 'LOCK';
        ch.rwd.classList.toggle('on', d.rwd);
        ch.engineStart.classList.toggle('warn', !(d.running || d.cranking));
        ch.headlights.classList.toggle('on', view.lights.head > 0);
        ch.headlights.textContent = ['Lights', 'Low beam', 'High beam'][view.lights.head];
      }
    }
  }
}

function buzz() { try { navigator.vibrate?.(8); } catch { /* not allowed */ } }
