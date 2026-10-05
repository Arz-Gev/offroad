import { BINDINGS, capsHTML, padCapHTML, touchCapHTML } from './input.js';
import { escapeHTML } from './hud.js';

// Pause menu (Locations / Settings / Controls) and the first-start welcome card.
// Both pause the game. Navigation: mouse, keyboard (arrows, Enter, Q/E for tabs, digits for
// locations, Esc) and gamepad (d-pad / left stick, A, B, LB/RB, Menu) via Input.uiHandler.
//
// The menu holds no game state: it reads and writes through `api`
// ({ get, set, action, locations, teleport, recover, onPause, introDone, device }) supplied by main.js.

const TABS = [
  { id: 'locations', label: 'Locations', hot: 'locations' },
  { id: 'settings', label: 'Settings' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'friends', label: 'Friends' },
  { id: 'controls', label: 'Controls', hot: 'controls' },
];

const fmtClock = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const row = (key, label, type, extra = {}) => ({ key, label, type, ...extra });
const SECTIONS = [
  { title: 'Driving', rows: [
    row('car', 'Vehicle', 'seg', { options: [['defender', 'Defender 110'], ['gclass', 'G-Class'], ['lancia', 'Lancia Delta']], note: 'Each car has its own engine, weight, gears, tyres and springs (real specs) and its own setups in the Tab panel. All use the same solid-axle physics. Switching reloads the game. Models on Sketchfab (CC BY 4.0): G-Class by ItsDiyor, Lancia Delta by TARANTULA.' }),
    row('gearbox', 'Gearbox', 'seg', { hot: 'gearbox', options: [['auto', 'Automatic'], ['manual', 'Manual']] }),
    row('autoClutch', 'Auto-clutch', 'switch', { hot: 'autoClutch', note: 'Off: hold Shift for the clutch.' }),
    row('arcadeAuto', 'Arcade automatic', 'switch', { hot: 'autoClutch', note: 'On: hold the brake at a stop to reverse. Off: select R with E / Q like a real car; W is always the gas, S the brake.' }),
    row('handbrake', 'Handbrake', 'seg', { options: [['hold', 'Hold'], ['toggle', 'Toggle'], ['auto', 'Auto']], note: 'Hold: while the key is down. Toggle: press on, press off. Auto: a short tap toggles, a long press holds.' }),
    row('steerAssist', 'Keyboard steering assist', 'seg', { options: [['strong', 'Strong'], ['light', 'Light'], ['off', 'Off']], note: 'How far a held steering key turns the wheels at speed, from the grip under the truck right now (surface, tyre pressure, grip). Strong: a little past the grip limit (1.2×). Light: well past it (1.6×), dose it by tapping. Off: full lock at any speed. Short taps always give small angles. It only picks the angle: the truck can still slide or spin.' }),
    row('pressure', 'Tyre pressure', 'stepper', { hot: ['pressureDown', 'pressureUp'], note: 'Lower pressure: bigger footprint, more grip off-road.' }),
  ] },
  { title: 'View', rows: [
    row('camera', 'Camera', 'seg', { hot: 'camera', options: [['chase', 'Chase'], ['cockpit', 'Cockpit'], ['hood', 'Hood'], ['wheel', 'Wheel'], ['orbit', 'Orbit']] }),
    row('fov', 'Field of view', 'range', { min: 45, max: 110, step: 1, scale: 1, unit: '°', note: 'Vertical angle of the camera. Wider shows more around the truck and feels faster; narrower is closer and flatter. Default 62°.' }),
    row('time', 'Time of day', 'range', { hot: 'time', min: 0, max: 1435, step: 5, scale: 60, fmt: fmtClock, note: 'The picture follows the slider at once. Day 13:00, dusk 19:30, night 23:00.' }),
    row('timeQuick', '', 'seg', { quick: true, options: [['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']] }),
  ] },
  { title: 'Sound', rows: [
    row('sound', 'Sound', 'switch', { hot: 'mute' }),
    row('volume', 'Volume', 'range', { min: 0, max: 100, step: 5, scale: 100, unit: '%' }),
  ] },
  { title: 'Vehicle', rows: [
    row('headlights', 'Headlights', 'seg', { hot: 'headlights', options: [[0, 'Off'], [1, 'Low'], [2, 'High']] }),
    row('lightBar', 'Light bar', 'switch', { hot: 'lightBar' }),
    row('hazards', 'Hazard lights', 'switch', { hot: 'hazards' }),
  ] },
  { title: 'Units', rows: [
    row('speedUnit', 'Speed', 'seg', { options: [['kmh', 'km/h'], ['mph', 'mph']] }),
    row('pressureUnit', 'Tyre pressure', 'seg', { options: [['psi', 'psi'], ['bar', 'bar']] }),
  ] },
  { title: 'HUD', rows: [
    row('cluster', 'Instrument cluster', 'seg', { options: [['auto', 'Auto'], ['full', 'Full'], ['compact', 'Compact']], note: 'Auto: compact in the cockpit view and in small windows.' }),
    row('hudScale', 'HUD size', 'range', { min: 70, max: 150, step: 5, scale: 100, unit: '%' }),
    row('hints', 'Key hints', 'switch'),
    row('suspension', 'Suspension panel', 'switch', { hot: 'suspension' }),
    row('telemetry', 'Telemetry', 'switch', { hot: 'telemetry' }),
    row('fps', 'FPS counter', 'switch'),
  ] },
  { title: 'Touch screen', rows: [
    row('touchControls', 'On-screen controls', 'seg', { options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], note: 'Auto: shown while you use the touch screen, hidden when you press a key or use a gamepad.' }),
    row('touchSteer', 'Steering', 'seg', { options: [['stick', 'Thumb'], ['tilt', 'Tilt']], note: 'Thumb: touch the lower left and slide sideways. Tilt: turn the phone or tablet like a steering wheel.' }),
  ] },
  { title: 'Game', rows: [
    row('autoPause', 'Pause when the window loses focus', 'switch'),
    row('_game', '', 'buttons', { buttons: [['resetSettings', 'Reset settings']] }),
  ] },
];

// Friends tab (multiplayer.js): the notes are filled in by refresh()
const MP_SECTIONS = [
  { title: 'Drive with friends', rows: [
    row('mpRoom', 'Room', 'buttons', { buttons: [['mpInvite', 'Invite'], ['mpGoto', 'Go to friend'], ['mpLeave', 'Leave']], note: ' ' }),
    row('mpName', 'Your name', 'buttons', { buttons: [['mpName', 'Change']], note: ' ' }),
    row('solidTrucks', 'Solid trucks', 'switch', { note: 'Off: friends\' trucks are ghosts you drive through. On: they are as heavy as real trucks, so a bump shoves both of you. Each game works out the hit on its own side, so the two views can differ a little.' }),
  ] },
];

// Graphics tab. Changing any option below the preset switches the preset to Custom.
const GFX_SECTIONS = [
  { title: 'Preset', rows: [
    row('quality', 'Quality', 'seg', { options: [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']], note: 'Auto picks a preset for your graphics chip.' }),
    row('renderScale', 'Resolution', 'range', { min: 50, max: 100, step: 5, scale: 100, unit: '%', note: 'Lower renders fewer pixels: faster, softer.' }),
    row('fullscreen', 'Fullscreen', 'switch'),
    row('gDpr', 'Pixel density cap', 'range', { min: 100, max: 200, step: 25, scale: 100, unit: '%', note: 'For high-density screens (Retina, 4K laptops, Windows scaling above 100%): how many of the screen\'s extra pixels to render. The biggest cost of all.' }),
  ] },
  { title: 'Lighting and effects', rows: [
    row('gShadows', 'Shadows', 'seg', { options: [['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']], note: 'Sun shadow sharpness and distance.' }),
    row('gSSAO', 'Ambient occlusion', 'seg', { options: [['off', 'Off'], ['low', 'Low'], ['high', 'High']], note: 'SSAO: contact shading in corners, under the truck and between rocks. About 1–2 ms.' }),
    row('gAA', 'Anti-aliasing', 'seg', { options: [['off', 'Off'], ['fxaa', 'FXAA'], ['msaa2', 'MSAA 2×'], ['msaa4', 'MSAA 4×']], note: 'MSAA is sharper, FXAA is cheaper.' }),
    row('gBloom', 'Bloom', 'switch', { note: 'Glow around lamps and the sun.' }),
  ] },
  { title: 'World detail', rows: [
    row('gViewDist', 'Terrain detail distance', 'range', { min: 60, max: 150, step: 5, scale: 100, unit: '%' }),
    row('gTerrain', 'Ground shading', 'seg', { options: [[0, 'Low'], [1, 'Medium'], [2, 'High']] }),
    row('gTreeShadows', 'Distant tree shadows', 'switch'),
  ] },
  { title: 'Grass and bushes', rows: [
    row('vegetation', 'Grass and bushes', 'switch', { note: 'Off hides all the grass and undergrowth (trees stay). The most expensive part of the world.' }),
    row('gGrass', 'Grass density', 'range', { veg: true, min: 4, max: 96, step: 1, scale: 100, dp: 2, unit: '×' }),
    row('gGrassHeight', 'Grass height', 'range', { veg: true, min: 180, max: 390, step: 5, scale: 100, dp: 2, unit: '×' }),
    row('gGrassWidth', 'Grass blade width', 'range', { veg: true, min: 80, max: 240, step: 5, scale: 100, dp: 2, unit: '×' }),
    row('gGrassDist', 'Grass distance', 'range', { veg: true, min: 119, max: 287, step: 1, scale: 1, unit: ' m' }),
    row('gGrassNear', 'Dense grass radius', 'range', { veg: true, min: 42, max: 72, step: 1, scale: 1, unit: ' m', note: 'The fine layer around you. The expensive one.' }),
    row('gGrassFarWidth', 'Far grass blade width', 'range', { veg: true, min: 130, max: 360, step: 5, scale: 100, dp: 2, unit: '×' }),
    row('gGrassFarSpacing', 'Far grass spacing', 'range', { veg: true, min: 85, max: 160, step: 5, scale: 100, dp: 2, unit: '×', note: 'Lower packs more blades into the far layer (slower).' }),
    row('gBushes', 'Bush density', 'range', { veg: true, min: 5, max: 220, step: 5, scale: 100, dp: 2, unit: '×' }),
    row('gBushHeight', 'Bush size', 'range', { veg: true, min: 110, max: 260, step: 5, scale: 100, dp: 2, unit: '×' }),
    row('gBushDist', 'Bush distance', 'range', { veg: true, min: 100, max: 225, step: 5, scale: 100, dp: 2, unit: '×' }),
  ] },
];

const hotHTML = hot => [].concat(hot || []).map(id => capsHTML(id, 'kb')).join('');

export class Menu {
  constructor(api) {
    this.api = api;
    this.root = document.getElementById('menu');
    this.introRoot = document.getElementById('intro');
    this.tab = 'locations';
    this.isOpen = false;
    this.introOpen = false;
    this.build();
  }

  get blocking() { return this.isOpen || this.introOpen; }

  // ------------------------------------------------------------------ build
  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <header class="sheet-head">
          <div class="titles"><div class="eyebrow">Offroad · Defender 110</div><h1 id="m-title">Paused</h1></div>
          <div class="head-actions">
            <button class="btn" type="button" data-act="recover">Recover <span class="kc" data-cap="recover"></span></button>
            <button class="btn primary" type="button" data-act="resume">Resume <span class="kc" data-cap="menu"></span></button>
          </div>
        </header>
        <nav class="tabs" role="tablist">
          ${TABS.map(t => `<button class="tab" type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="pane-${t.id}">${t.label}${t.hot ? `<span class="kc">${hotHTML(t.hot)}</span>` : ''}</button>`).join('')}
        </nav>
        <section class="pane" role="tabpanel" id="pane-locations" data-pane="locations"></section>
        <section class="pane" role="tabpanel" id="pane-settings" data-pane="settings" hidden></section>
        <section class="pane" role="tabpanel" id="pane-graphics" data-pane="graphics" hidden></section>
        <section class="pane" role="tabpanel" id="pane-friends" data-pane="friends" hidden></section>
        <section class="pane" role="tabpanel" id="pane-controls" data-pane="controls" hidden></section>
        <footer class="sheet-foot" id="m-foot"></footer>
      </div>`;
    this.sheet = r.querySelector('.sheet');
    this.panes = Object.fromEntries([...r.querySelectorAll('.pane')].map(p => [p.dataset.pane, p]));
    this.buildLocations();
    this.buildSettings(this.panes.settings, SECTIONS);
    this.buildSettings(this.panes.graphics, GFX_SECTIONS);
    this.buildSettings(this.panes.friends, MP_SECTIONS);
    this.buildControls();
    this.renderDevice();

    r.addEventListener('click', e => {
      const t = e.target.closest('button, [data-loc]');
      if (!t || !r.contains(t)) { if (e.target === r) this.close(); return; }
      if (t.dataset.tab) this.showTab(t.dataset.tab, true);
      else if (t.dataset.act === 'resume') this.close();
      else if (t.dataset.act === 'recover') { this.api.recover(); this.close(); }
      else if (t.dataset.loc !== undefined) { this.api.teleport(+t.dataset.loc); this.close(); }
      else if (t.dataset.seg !== undefined) this.setValue(t.closest('[data-key]').dataset.key, t.dataset.seg);
      else if (t.classList.contains('switch')) { const k = t.closest('[data-key]').dataset.key; this.setValue(k, !this.api.get(k)); }
      else if (t.dataset.action) this.runAction(t.dataset.action);
    });
    r.addEventListener('input', e => {
      const el = e.target;
      if (el.type !== 'range') return;
      const def = this.rowDef(el.closest('[data-key]').dataset.key);
      this.setValue(def.key, +el.value / def.scale);
    });
    // keyboard / pad focus ring only after keyboard or pad navigation
    r.addEventListener('pointerdown', () => this.sheet.classList.remove('kbnav'));
    this.introRoot.addEventListener('click', e => { if (e.target.closest('[data-act="start"]')) this.closeIntro(); });
  }

  buildLocations() {
    const locs = this.api.locations;
    this.panes.locations.innerHTML = `
      <p class="pane-lead">Teleport anywhere on the map. The proving ground lanes test one thing each.</p>
      <div class="loc-grid">${locs.map((l, i) => `
        <button class="loc" type="button" data-loc="${i}">
          <span class="loc-n">${i + 1}</span>
          <span class="loc-b"><span class="loc-tag">${escapeHTML(l.tag)}<span class="loc-here" hidden>You are here</span></span><span class="loc-name">${escapeHTML(l.title)}</span><span class="loc-desc">${escapeHTML(l.desc)}</span></span>
        </button>`).join('')}
      </div>`;
  }

  rowDef(key) { for (const s of [...SECTIONS, ...GFX_SECTIONS, ...MP_SECTIONS]) for (const r of s.rows) if (r.key === key) return r; return null; }

  buildSettings(pane, sections) {
    const ctl = r => {
      if (r.type === 'seg') return `<div class="seg" role="radiogroup" aria-label="${escapeHTML(r.label)}">${r.options.map(([v, l]) => `<button type="button" role="radio" data-seg="${v}">${l}</button>`).join('')}</div>`;
      if (r.type === 'switch') return `<button type="button" class="switch" role="switch" aria-label="${escapeHTML(r.label)}"><span class="knob"></span></button>`;
      if (r.type === 'range') return `<div class="range"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" aria-label="${escapeHTML(r.label)}"><output></output></div>`;
      if (r.type === 'stepper') return `<div class="stepper"><button type="button" data-action="pressureDown" aria-label="Lower">−</button><output></output><button type="button" data-action="pressureUp" aria-label="Raise">+</button></div>`;
      if (r.type === 'buttons') return `<div class="btns">${r.buttons.map(([a, l]) => `<button type="button" class="btn small" data-action="${a}">${l}</button>`).join('')}</div>`;
      return '';
    };
    pane.innerHTML = `<div class="set-cols">${sections.map(s => `
      <div class="set-sec"><h2>${s.title}</h2>${s.rows.map(r => `
        <div class="set-row${r.label ? '' : ' bare'}${r.quick ? ' quick' : ''}" data-key="${r.key}">
          ${r.label ? `<div class="set-l"><div class="set-t">${r.label}${r.hot ? `<span class="kc">${hotHTML(r.hot)}</span>` : ''}</div>${r.note ? `<div class="set-n">${r.note}</div>` : ''}</div>` : ''}
          <div class="set-c">${ctl(r)}</div>
        </div>`).join('')}</div>`).join('')}</div>`;
  }

  // third column: the gamepad, or the on-screen controls on a touch screen
  buildControls(touch = false) {
    this.ctlTouch = touch;
    const groups = [...new Set(BINDINGS.map(b => b.group))];
    const third = touch ? touchCapHTML : padCapHTML, dev = touch ? 'touch' : 'kb';
    this.panes.controls.innerHTML = `
      <div class="ctl-cols">${groups.map(g => `
        <div class="ctl-sec">
          <div class="ctl-row head"><h2>${g}</h2><span>Keyboard</span><span class="ctl-p">${touch ? 'Touch' : 'Gamepad'}</span></div>
          <div class="ctl-table">${BINDINGS.filter(b => b.group === g).map(b => `
            <div class="ctl-row"><span class="ctl-a">${escapeHTML(b.label)}</span><span class="ctl-k">${capsHTML(b.id, 'kb', { all: true })}</span><span class="ctl-p">${third(b.id)}</span></div>`).join('')}
          </div></div>`).join('')}
      </div>
      <div class="callout"><b>Getting stuck?</b> Stop, shift to low range (${capsHTML('range', dev)}), lock the centre diff (${capsHTML('centreLock', dev)}) and the axle lockers (${capsHTML('lockers', dev)}), and air the tyres down (${capsHTML('pressureDown', dev)}). ${capsHTML('recover', dev)} always puts you back on your wheels.${touch ? ' The 4×4 button next to the menu button holds the range, lock, engine, light and tyre controls.' : ''}</div>`;
  }

  // device-dependent labels: header buttons, footer hints, welcome card
  renderDevice() {
    const dev = this.api.device();
    for (const el of this.root.querySelectorAll('[data-cap]')) el.innerHTML = dev === 'touch' ? '' : capsHTML(el.dataset.cap, dev);
    if ((dev === 'touch') !== this.ctlTouch) this.buildControls(dev === 'touch');
    this.renderFoot();
    if (this.introOpen) this.renderIntro();
  }

  renderFoot() {
    const dev = this.api.device(), tab = this.tab;
    const k = (l, cls = '') => `<kbd class="cap${cls}">${l}</kbd>`;
    const n = this.api.locations.length;
    const items = dev === 'pad'
      ? [[k('D-pad', ' pad'), 'Move'], (tab === 'settings' || tab === 'graphics' || tab === 'friends') && [k('←', ' pad') + k('→', ' pad'), 'Change'], [k('A', ' pad pad-a'), tab === 'locations' ? 'Teleport' : 'Select'],
        [k('LB', ' pad') + k('RB', ' pad'), 'Tabs'], [k('B', ' pad pad-b'), 'Resume']]
      : [[k('↑') + k('↓'), tab === 'controls' ? 'Scroll' : 'Move'], (tab === 'settings' || tab === 'graphics' || tab === 'friends') && [k('←') + k('→'), 'Change'],
        tab !== 'controls' && [k('Enter'), tab === 'locations' ? 'Teleport' : 'Select'], tab === 'locations' && [k('1') + '–' + k(String(Math.min(9, n))), 'Quick pick'],
        [k('Q') + k('E'), 'Tabs'], [k('Esc'), 'Resume']];
    this.root.querySelector('#m-foot').innerHTML = items.filter(Boolean).map(([c, t]) => `<span>${c} ${t}</span>`).join('');
  }

  // ------------------------------------------------------------------ state
  refresh() {
    const api = this.api;
    const here = api.get('here');
    this.panes.locations.querySelectorAll('.loc-here').forEach((el, i) => { el.hidden = i !== here; });
    for (const rowEl of [...this.panes.settings.querySelectorAll('.set-row'), ...this.panes.graphics.querySelectorAll('.set-row'), ...this.panes.friends.querySelectorAll('.set-row')]) {
      const key = rowEl.dataset.key, def = this.rowDef(key);
      if (def.type === 'seg') {
        const cur = String(api.get(key));
        const bs = [...rowEl.querySelectorAll('[data-seg]')], any = bs.some(b => b.dataset.seg === cur);
        for (const b of bs) {
          const on = b.dataset.seg === cur;
          b.setAttribute('aria-checked', on);
          b.tabIndex = on || (!any && b === bs[0]) ? 0 : -1;       // a group with nothing selected stays reachable
        }
      } else if (def.type === 'switch') {
        rowEl.querySelector('.switch').setAttribute('aria-checked', key === 'fullscreen' ? !!document.fullscreenElement : !!api.get(key));
      } else if (def.type === 'range') {
        const v = Math.round(api.get(key) * def.scale);
        const inp = rowEl.querySelector('input');
        if (+inp.value !== v) inp.value = v;
        rowEl.querySelector('output').textContent = def.fmt ? def.fmt(v) : (def.dp != null ? (v / def.scale).toFixed(def.dp) : v) + def.unit;
      } else if (def.type === 'stepper') {
        rowEl.querySelector('output').textContent = api.get('pressureText');
      }
    }
    // graphics: say which preset Auto chose
    // pixel density only matters on screens with a device pixel ratio above 1 (re-checked: the window may move)
    // the grass and bush sliders follow the Grass and bushes switch
    const veg = !!api.get('vegetation');
    for (const r of this.panes.graphics.querySelectorAll('.set-row')) if (this.rowDef(r.dataset.key)?.veg) r.hidden = !veg;
    this.panes.graphics.querySelector('[data-key="gDpr"]').hidden = (window.devicePixelRatio || 1) <= 1.01;
    for (const [key, src] of [['mpRoom', 'mpNote'], ['mpName', 'name']]) {
      const el = this.panes.friends.querySelector(`[data-key="${key}"] .set-n`), t = api.get(src);
      if (el && el.textContent !== t) el.textContent = t;
    }
    const qn = this.panes.graphics.querySelector('[data-key="quality"] .set-n');
    const qt = api.get('qualityNote');
    if (qn && qt && qn.textContent !== qt) qn.textContent = qt;
    // one of the two switches (they share the K key) is shown per gearbox
    const manual = api.get('gearbox') === 'manual';
    this.panes.settings.querySelector('[data-key="autoClutch"]').hidden = !manual;
    this.panes.settings.querySelector('[data-key="arcadeAuto"]').hidden = manual;
  }

  setValue(key, v) {
    if (key === 'fullscreen') { this.runAction('fullscreen'); return; }
    const def = this.rowDef(key);
    if (def && def.type === 'seg' && typeof def.options[0][0] === 'number') v = +v;
    this.api.set(key, v);
    this.refresh();
  }

  runAction(a) {
    if (a === 'fullscreen') {
      // Keyboard Lock (Chromium) keeps a short Esc press for the menu; holding Esc still leaves fullscreen
      const d = document, done = () => this.isOpen && this.refresh();
      if (d.fullscreenElement) Promise.resolve(d.exitFullscreen?.()).catch(() => {}).then(done);
      else Promise.resolve(d.documentElement.requestFullscreen?.({ navigationUI: 'hide' }))
        .then(() => this.api.device() === 'touch' ? screen.orientation?.lock?.('landscape') : navigator.keyboard?.lock?.(['Escape']))
        .catch(() => {}).then(done);
    } else if (a === 'intro') { this.close(); this.openIntro(); return; }
    else if (a === 'resetSettings') this.api.set('resetSettings', true);
    else this.api.action(a);
    this.refresh();
  }

  // ------------------------------------------------------------------ open / close
  open(tab) {
    if (this.introOpen) return;
    if (!this.isOpen) {
      this.isOpen = true;
      this.root.hidden = false;
      this.api.onPause(true);
    }
    this.showTab(tab || this.tab, false);
    this.refresh();
    this.focusFirst();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.sheet.classList.remove('kbnav');
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    this.api.onPause(this.blocking);
  }

  toggle(tab) { if (this.isOpen && (!tab || tab === this.tab)) this.close(); else this.open(tab); }

  showTab(id, focus) {
    this.tab = id;
    for (const b of this.root.querySelectorAll('.tab')) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
    }
    for (const [k, p] of Object.entries(this.panes)) p.hidden = k !== id;
    this.panes[id].scrollTop = 0;
    this.renderFoot();
    if (focus) this.root.querySelector(`.tab[data-tab="${id}"]`).focus();
  }

  cycleTab(dir) {
    const i = TABS.findIndex(t => t.id === this.tab);
    this.showTab(TABS[(i + dir + TABS.length) % TABS.length].id, true);
  }

  focusables() {
    return [...this.sheet.querySelectorAll('button, input')].filter(el => el.tabIndex >= 0 && !el.closest('[hidden]'));
  }

  focusFirst() {
    // the first control of the pane, so arrow keys / d-pad start in the content
    const pane = this.panes[this.tab];
    const el = [...pane.querySelectorAll('button, input')].find(x => x.tabIndex >= 0);
    (el || this.root.querySelector('.tab[aria-selected="true"]')).focus({ preventScroll: true });
    pane.scrollTop = 0;
  }

  moveFocus(dir, wrap) {
    const list = this.focusables();
    let i = list.indexOf(document.activeElement);
    if (i < 0) { (list.find(el => this.panes[this.tab].contains(el)) || list[0])?.focus(); return; }
    const next = list[wrap ? (i + dir + list.length) % list.length : clampIdx(i + dir, list.length)];
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  }

  // left / right: change the focused control
  adjust(dir, el, synthetic) {
    if (!el || !this.sheet.contains(el)) return false;
    if (el.classList.contains('tab')) { this.cycleTab(dir); return true; }
    if (el.dataset.seg !== undefined) {
      const opts = [...el.parentElement.children];
      const n = opts[clampIdx(opts.indexOf(el) + dir, opts.length)];
      this.setValue(el.closest('[data-key]').dataset.key, n.dataset.seg);
      n.focus();
      return true;
    }
    if (el.type === 'range') {
      if (!synthetic) return false;            // native keyboard handling
      el.value = +el.value + dir * +el.step;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el.classList.contains('switch')) { const k = el.closest('[data-key]').dataset.key; if (!!this.api.get(k) !== dir > 0) this.setValue(k, dir > 0); return true; }
    if (el.dataset.loc !== undefined || el.closest('.btns, .stepper, .head-actions')) {
      const list = this.focusables(); const i = list.indexOf(el);
      const n = list[clampIdx(i + dir, list.length)];
      if (n) n.focus();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ input (Input.uiHandler)
  handle(ev) {
    if (ev.type === 'pad') { this.handlePad(ev.btn); return true; }
    const e = ev.e, code = e.code;
    if (this.introOpen) {
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || code === 'Escape') { if (!e.repeat) this.closeIntro(); return true; }
      if (code === 'KeyH') { this.closeIntro(); this.open('controls'); return true; }
      return code === 'Tab' || DRIVE_KEYS.has(code);                     // focus stays on the card
    }
    if (!this.isOpen) return false;
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Space'];
    if (nav.includes(code)) this.sheet.classList.add('kbnav');
    if (e.repeat && !nav.includes(code)) return true;
    switch (code) {
      case 'Escape': this.close(); return true;
      case 'KeyH': this.toggle('controls'); return true;
      case 'KeyP': this.toggle('locations'); return true;
      case 'KeyQ': this.cycleTab(-1); this.sheet.classList.add('kbnav'); return true;
      case 'KeyE': this.cycleTab(1); this.sheet.classList.add('kbnav'); return true;
      case 'Tab': this.moveFocus(e.shiftKey ? -1 : 1, true); return true;
      case 'ArrowDown': this.moveFocus(1); return true;
      case 'ArrowUp': this.moveFocus(-1); return true;
      case 'ArrowLeft': return this.adjust(-1, e.target);
      case 'ArrowRight': return this.adjust(1, e.target);
    }
    const dg = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (dg && this.tab === 'locations' && +dg[1] <= this.api.locations.length) { this.api.teleport(+dg[1] - 1); this.close(); return true; }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') return false;   // native button activation
    return DRIVE_KEYS.has(code);                                                  // swallow, nothing else reacts
  }

  handlePad(btn) {
    if (this.introOpen) { if (btn === 'accept' || btn === 'back' || btn === 'menu') this.closeIntro(); return; }
    if (!this.isOpen) return;
    this.sheet.classList.add('kbnav');
    const el = document.activeElement;
    if (btn === 'up') this.moveFocus(-1);
    else if (btn === 'down') this.moveFocus(1);
    else if (btn === 'left' || btn === 'right') this.adjust(btn === 'right' ? 1 : -1, el, true);
    else if (btn === 'accept') { if (el && this.sheet.contains(el)) el.click(); else this.focusFirst(); }
    else if (btn === 'back' || btn === 'menu') this.close();
    else if (btn === 'prevTab') { this.cycleTab(-1); this.focusFirst(); }
    else if (btn === 'nextTab') { this.cycleTab(1); this.focusFirst(); }
  }

  // ------------------------------------------------------------------ welcome card
  openIntro() {
    this.introOpen = true;
    this.renderIntro();
    this.introRoot.hidden = false;
    this.api.onPause(true);
    this.introRoot.querySelector('[data-act="start"]').focus({ preventScroll: true });
  }

  closeIntro() {
    if (!this.introOpen) return;
    this.introOpen = false;
    this.introRoot.hidden = true;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    this.api.introDone();
    this.api.onPause(this.blocking);
  }

  renderIntro() {
    const dev = this.api.device(), k = id => capsHTML(id, dev);
    if (dev === 'touch') { this.renderTouchIntro(); return; }
    const or = '<span class="or">/</span>';
    const kb = l => `<kbd class="cap">${l}</kbd>`;
    const rows = [
      [dev === 'pad' ? k('throttle') + k('brake') : kb('W') + kb('S') + or + kb('↑') + kb('↓'), 'Throttle and brake. Hold brake at a stop to reverse.'],
      [dev === 'pad' ? k('steer') : kb('A') + kb('D') + or + kb('←') + kb('→'), 'Steer'],
      [k('handbrake'), 'Handbrake'],
      [k('camera'), dev === 'pad' ? 'Change camera · right stick looks around' : 'Change camera · drag the mouse to look around'],
      [k('recover'), 'Recover when stuck or upside down'],
      [k('menu'), 'Menu: locations, settings, all controls'],
    ];
    const startCap = dev === 'pad' ? '<kbd class="cap pad pad-a">A</kbd>' : '<kbd class="cap">Enter</kbd>';
    this.introRoot.innerHTML = `
      <div class="card intro" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <div class="eyebrow">Offroad · Defender 110 V8</div>
        <h1 id="intro-title">Take it off the road</h1>
        <p class="lead">A solid-axle 4×4 sandbox with a proving ground. The automatic gearbox is ready; here are the essentials.</p>
        <div class="intro-keys">${rows.map(([c, t]) => `<div class="ik">${c}</div><div class="it">${t}</div>`).join('')}</div>
        <div class="callout"><b>Hard obstacle?</b> Stop, press ${k('range')} for low range, then ${k('centreLock')} and ${k('lockers')} to lock the diffs.${dev === 'pad' ? '' : ` ${k('pressureDown')} airs the tyres down.`}</div>
        <div class="intro-foot">
          <span class="fine">${dev === 'pad' ? `${k('menu')} opens the menu at any time.` : `${k('controls')} shows every control at any time.`}</span>
          <button class="btn primary big" type="button" data-act="start">Start driving ${startCap}</button>
        </div>
      </div>`;
  }

  // welcome card for phones and tablets: the on-screen controls (touch.js)
  renderTouchIntro() {
    const k = id => capsHTML(id, 'touch');
    const tilt = this.api.get('touchSteer') === 'tilt';
    const rows = [
      [k('throttle') + k('brake'), 'Right thumb. Higher up the pedal is more.'],
      [k('steer'), tilt ? 'Tilt the screen like a wheel.' : 'Left thumb: touch the lower left, slide sideways.'],
      [k('shiftUp') + k('shiftDown'), 'Gear selector: ▲ to D, ▼ to R and P.'],
      [k('handbrake'), 'Handbrake'],
      [k('camera'), 'Camera · drag the view to look, pinch to zoom'],
      [k('recover'), 'Recover when stuck or upside down'],
      [k('menu'), 'Locations, settings (tilt steering), all controls'],
    ];
    this.introRoot.innerHTML = `
      <div class="card intro" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <div class="eyebrow">Offroad · Defender 110 V8</div>
        <h1 id="intro-title">Take it off the road</h1>
        <p class="lead">A solid-axle 4×4 sandbox with a proving ground. The automatic gearbox is ready; here are the essentials.</p>
        <div class="intro-keys">${rows.map(([c, t]) => `<div class="ik">${c}</div><div class="it">${t}</div>`).join('')}</div>
        <div class="callout"><b>Hard obstacle?</b> Stop, open <kbd class="cap touch">4×4</kbd> next to the menu button and tap ${k('range')} for low range, then ${k('centreLock')} and ${k('lockers')} to lock the diffs. ${k('pressureDown')} airs the tyres down.</div>
        <div class="intro-foot">
          <span class="fine">Best in landscape and full screen.</span>
          <button class="btn primary big" type="button" data-act="start">Start driving</button>
        </div>
      </div>`;
  }
}

const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'F3', 'Backquote']);
const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));
