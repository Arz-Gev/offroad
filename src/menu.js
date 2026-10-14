import { carBindings, hasControl, capsHTML, padCapHTML, touchCapHTML } from './input.js';
import { escapeHTML } from './hud.js';
import { CAR_LIST } from './cars/index.js';
import { ENGINES } from './vehicle/engines.js';
import { storage } from './settings.js';
import { icon } from './icons.js';

// The side panel (Esc): every setting, the places, multiplayer, the controls list and the tuning (Tab), in
// sections picked from an icon rail. The game keeps running behind it, like a car's own menu. Mouse and
// touch use it directly; the keyboard keeps driving (after a click the focus goes back to the game); a
// gamepad's d-pad, A, B, LB and RB move through it while the sticks and triggers keep driving.
// It holds no game state: it reads and writes through `api` (main.js).

const LAST_KEY = 'offroad.panel.v1';
const MODEL_CREDITS = CAR_LIST.filter(c => c.look.author).map(c => `${c.label} by ${c.look.author}`).join(', ');
const fmtClock = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// row builders. extra: { info, hot (binding ids for the key caps), show(api) }
const seg = (key, label, options, extra) => ({ type: 'seg', key, label, options, ...extra });
const sw = (key, label, extra) => ({ type: 'switch', key, label, ...extra });
const range = (key, label, extra) => ({ type: 'range', key, label, ...extra });
const group = title => ({ type: 'group', title });
// an option's face: text, or an icon with the text as its tooltip
const ic = (name, text) => ({ icon: name, text });

// the box as it works now: 'auto', 'manual', or 'autoshift' (a manual-only car shifting itself)
const boxIs = m => api => api.get('boxMode') === m;

export const SECTIONS = [
  { id: 'car', title: 'Car', icon: 'car', rows: [
    { type: 'cars', key: 'car', info: `Each car has its own engine, weight, gearbox, tyres and suspension, and its own setups in Tuning. Picking another car restarts the game. Models from Sketchfab (CC BY 4.0): ${MODEL_CREDITS}.` },
    sw('engine', 'Engine', { hot: ['engineStart', 'engineStop'] }),
    { type: 'stepper', key: 'pressure', label: 'Tyre pressure', hot: ['pressureDown', 'pressureUp'], info: 'Lower pressure makes a bigger footprint: more grip on loose ground and rocks, a softer ride, slower on the road. The two keys change both axles.' },
    group('Lights'),
    seg('headlights', 'Headlights', [[0, ic('beamOff', 'Off')], [1, ic('lowBeam', 'Low beam')], [2, ic('highBeam', 'High beam')]], { hot: ['headlights'], info: 'They switch on by themselves at dusk.' }),
    sw('auxLights', 'Extra lamps', { hot: ['auxLights'], info: 'This car\'s roof light bar, driving lamps or searchlights.', show: () => hasControl('auxLights') }),
    sw('hazards', 'Hazard lights', { hot: ['hazards'] }),
  ] },
  { id: 'driving', title: 'Driving', icon: 'wheel', rows: [
    group('Gearbox'),
    seg('gearbox', 'Gearbox', [['auto', 'Automatic'], ['manual', 'Manual']], { hot: ['gearbox'], info: 'Manual: shift with E and Q. A car with only a manual box (the BTR-80) shifts it for you in Automatic.' }),
    sw('arcadeAuto', 'Arcade reverse', { hot: ['autoClutch'], show: boxIs('auto'), info: 'On: hold the brake at a stop and the truck backs up, like in an arcade game. Off: select R with Q like a real automatic; W is always the gas, S the brake.' }),
    sw('autoClutch', 'Auto-clutch', { hot: ['autoClutch'], show: boxIs('manual'), info: 'Off: you work the clutch yourself with Shift. Shifting without it grinds, and stopping in gear stalls the engine.' }),
    group('4×4'),
    seg('range', 'Range', [['high', 'High'], ['low', 'Low']], { hot: ['range'], show: () => hasControl('range'), info: 'Low range gears everything down: slow crawling, steep climbs and strong engine braking. Stop the truck to change it.' }),
    seg('drive', 'Drive', [['4wd', '4WD'], ['2wd', '2WD']], { hot: ['rwd'], show: () => hasControl('rwd'), info: '2WD drives the rear wheels only: lighter on the road, much less grip off it. High range only, below 30 km/h.' }),
    sw('centreLock', 'Centre diff lock', { hot: ['centreLock'], show: () => hasControl('centreLock'), info: 'Locks the front and rear axles together, so one slipping axle can\'t take all the power. Unlock it on grippy ground: the truck scrubs in turns.' }),
    seg('lockers', 'Axle lockers', [['off', 'Off'], ['rear', 'Rear'], ['all', 'All']], { hot: ['lockers'], show: () => hasControl('lockers'), info: 'Locks both wheels of an axle together, so a lifted or spinning wheel doesn\'t stop the truck. They make it hard to turn: unlock once you\'re through.' }),
    group('Assists'),
    seg('steerAssist', 'Steering assist', [['strong', 'Strong'], ['light', 'Light'], ['off', 'Off']], { info: 'Keyboard steering. A held key at speed turns the wheels only as far as the grip under the truck allows. Strong: just past the limit. Light: well past it, dose it by tapping. Off: full lock at any speed. A gamepad or touch steers with its own speed curve.' }),
    sw('traction', 'Traction control', { hot: ['traction'], info: 'Brakes a spinning wheel so the power goes to the wheels that grip. Off: open diffs spin the lightest wheel.' }),
    sw('abs', 'ABS', { hot: ['abs'], info: 'Stops the wheels locking under hard braking, so you can still steer. Off: they lock and slide.' }),
    seg('handbrake', 'Handbrake key', [['hold', 'Hold'], ['toggle', 'Toggle'], ['auto', 'Auto']], { hot: ['handbrake'], info: 'Hold: on while the key is down. Toggle: press on, press off. Auto: a tap toggles, a long press holds.' }),
  ] },
  { id: 'tuning', title: 'Tuning', icon: 'wrench', hot: 'tuning', rows: [{ type: 'tuning' }] },
  { sep: true },
  { id: 'places', title: 'Places', icon: 'pin', hot: 'locations', rows: [{ type: 'places' }] },
  { id: 'view', title: 'View', icon: 'camera', rows: [
    seg('camera', 'Camera', [['chase', 'Chase'], ['cockpit', 'Cockpit'], ['hood', 'Hood'], ['wheel', 'Wheel'], ['orbit', 'Orbit']], { hot: ['camera'] }),
    range('fov', 'Field of view', { min: 45, max: 110, step: 1, scale: 1, unit: '°', info: 'The camera\'s vertical angle. Wider shows more and feels faster; narrower looks flatter and closer. Default 62°.' }),
    seg('dof', 'Depth of field', [['off', 'Off'], ['soft', 'Soft'], ['strong', 'Strong'], ['miniature', 'Miniature']], { info: 'Softens the distance like a camera lens. Miniature focuses on the truck and blurs everything nearer and farther: from high up with a narrow view the world looks like a toy. Not on Low and Mobile graphics.' }),
    seg('miniBlur', 'Miniature blur', [[1, 'Light'], [2, 'Medium'], [3, 'Strong'], [4, 'Extreme']], { show: api => api.get('dof') === 'miniature' }),
    range('brightness', 'Brightness', { min: 60, max: 200, step: 5, scale: 100, unit: '%', info: 'Lifts or deepens the mid-tones; black stays black and white stays white. Default 100%.' }),
  ] },
  { id: 'world', title: 'World', icon: 'world', rows: [
    range('time', 'Time of day', { hot: ['time'], min: 0, max: 1435, step: 5, scale: 60, fmt: fmtClock }),
    seg('timeQuick', '', [['day', ic('sun', 'Day')], ['dusk', ic('dusk', 'Dusk')], ['night', ic('moon', 'Night')]], { quick: true }),
    seg('timeFlow', 'Time passes', [['off', 'Off'], ['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']], { info: 'How fast the day goes by: a whole day in 48, 24 or 8 minutes. Off keeps the hour you set.' }),
    seg('weather', 'Weather', [['fair', ic('sun', 'Fair')], ['changing', ic('changing', 'Changing')], ['rain', ic('rain', 'Rain')]], { info: 'Fair, changing (fine weather with a summer shower now and then, and a rainbow when it clears), or rain.' }),
    seg('fog', 'Fog', [['off', 'Off'], ['light', 'Light'], ['normal', 'Normal'], ['thick', 'Thick']], { info: 'The haze that catches the sun: light shafts in the forest, morning mist. Not on Low and Mobile graphics.' }),
  ] },
  { sep: true },
  { id: 'graphics', title: 'Graphics', icon: 'image', rows: [
    seg('quality', 'Quality', [['auto', 'Auto'], ['mobile', 'Mobile'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']], { info: ' ', infoKey: 'qualityNote' }),
    range('renderScale', 'Resolution', { min: 50, max: 100, step: 5, scale: 100, unit: '%', info: 'Draws fewer pixels and scales the picture up: faster, softer.' }),
    range('gDpr', 'Sharpness', { min: 100, max: 200, step: 25, scale: 100, unit: '%', show: () => (window.devicePixelRatio || 1) > 1.01, info: 'Pixel density on a high-density (Retina) screen. Higher is sharper and slower.' }),
    sw('fullscreen', 'Fullscreen'),
    group('Detail'),
    seg('gShadows', 'Shadows', [['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']]),
    seg('gSSAO', 'Ambient occlusion', [['off', 'Off'], ['low', 'Low'], ['high', 'High']], { info: 'Soft contact shadows in corners, under rocks and under the truck.' }),
    seg('gAA', 'Anti-aliasing', [['off', 'Off'], ['fxaa', 'FXAA'], ['msaa2', '2×'], ['msaa4', '4×']], { info: 'Smooths jagged edges. FXAA is cheap and a little soft; MSAA 2× and 4× are cleaner and cost more.' }),
    seg('gVeg', 'Grass and bushes', [['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']]),
    seg('gTerrain', 'Ground detail', [[0, 'Low'], [1, 'Med'], [2, 'High'], [3, 'Ultra']], { info: 'How finely the ground\'s textures and lighting are drawn.' }),
    range('gViewDist', 'Terrain distance', { min: 60, max: 150, step: 5, scale: 100, unit: '%', info: 'How far the ground keeps its full shape before it gets simpler.' }),
    sw('gBloom', 'Bloom', { info: 'A glow around the sun and bright lights.' }),
    sw('gTreeShadows', 'Far tree shadows', { info: 'Distant trees cast shadows too.' }),
    sw('dust', 'Dust and splashes', { info: 'Dust, mud and water thrown up by the tyres. Not part of the presets.' }),
  ] },
  { id: 'hud', title: 'HUD', icon: 'gauge', rows: [
    seg('cluster', 'Instruments', [['auto', 'Auto'], ['full', 'Full'], ['compact', 'Compact']], { info: 'Auto: compact in the cockpit view, on touch screens and in small windows.' }),
    range('hudScale', 'HUD size', { min: 70, max: 150, step: 5, scale: 100, unit: '%' }),
    sw('hints', 'Key hints', { info: 'The key icons next to the menu button.' }),
    sw('suspension', 'Chassis panel', { hot: ['suspension'], info: 'Wheel loads, suspension travel, tyre squash and slip, axle twist, and how far the truck leans.' }),
    sw('telemetry', 'Telemetry', { hot: ['telemetry'], info: 'Raw numbers from the engine, the drivetrain and each wheel, for tuning.' }),
    sw('fps', 'Frame rate'),
  ] },
  { id: 'general', title: 'General', icon: 'sliders', rows: [
    sw('sound', 'Sound', { hot: ['mute'] }),
    range('volume', 'Volume', { min: 0, max: 100, step: 5, scale: 100, unit: '%' }),
    group('Units'),
    seg('speedUnit', 'Speed', [['kmh', 'km/h'], ['mph', 'mph']]),
    seg('pressureUnit', 'Tyre pressure', [['psi', 'psi'], ['bar', 'bar']]),
    group('Game'),
    sw('autoPause', 'Pause in the background', { info: 'The game stops when you switch to another window or tab, and goes on when you come back and click or press a key.' }),
    { type: 'buttons', key: '_reset', label: 'All settings', buttons: [['resetSettings', 'Reset']], info: 'Every setting here back to its default. Tuning setups are kept.' },
  ] },
  { sep: true },
  { id: 'friends', title: 'Friends', icon: 'people', rows: [
    { type: 'buttons', key: 'mpRoom', label: 'Room', buttons: [['mpInvite', 'Invite'], ['mpGoto', 'Go to friend'], ['mpLeave', 'Leave']], status: 'mpNote', info: 'Invite copies a link. Whoever opens it drives next to you, peer to peer, no server.' },
    { type: 'buttons', key: 'mpName', label: 'Your name', buttons: [['mpName', 'Change']], status: 'name' },
    sw('solidTrucks', 'Solid trucks', { info: 'Off: friends\' trucks are ghosts you drive through. On: they are solid and as heavy as real trucks, so a bump shoves both of you. Each game works out the hit on its own side, so the two views can differ a little.' }),
  ] },
  { id: 'controls', title: 'Controls', icon: 'keyboard', hot: 'controls', rows: [
    group('Touch screen'),
    seg('touchControls', 'On-screen controls', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], { info: 'Auto: shown while you use the touch screen, hidden when you press a key or use a gamepad.' }),
    seg('touchSteer', 'Touch steering', [['stick', 'Thumb'], ['tilt', 'Tilt']], { info: 'Thumb: touch the lower left and slide sideways. Tilt: turn the phone or tablet like a steering wheel.' }),
    { type: 'legend' },
    { type: 'bindings' },
  ] },
];
const SECS = SECTIONS.filter(s => !s.sep);
const ROWS = Object.fromEntries(SECS.flatMap(s => s.rows.filter(r => r.key).map(r => [r.key, r])));
const multi = r => r.options.length > 3;   // more than three choices: the buttons get a line of their own

// stuck tips, with only this car's controls
function stuckSteps(k) {
  const s = [];
  if (hasControl('range')) s.push(`low range ${k('range')}`);
  if (hasControl('centreLock')) s.push(`centre lock ${k('centreLock')}`);
  if (hasControl('lockers')) s.push(`lockers ${k('lockers')}`);
  s.push(`air down ${k('pressureDown')}`);
  return s.join(' · ');
}

// what each HUD icon means (Controls section)
const LEGEND = [
  ['engine', 'Engine', 'red: off or stalled'],
  ['handbrake', 'Handbrake', 'red: on'],
  ['arcade', 'Arcade reverse', 'automatic: brake at a stop reverses'],
  ['clutch', 'Auto-clutch', 'manual: off means the clutch is yours'],
  ['steerAssist', 'Steering assist', 'dots: strong / light · flashes while it limits'],
  ['traction', 'Traction control', 'flashes while it brakes a spinning wheel'],
  ['abs', 'ABS', 'flashes while it stops a wheel locking'],
  ['lowBeam', 'Headlights', 'green: low beam · blue: high beam'],
  ['aux', 'Extra lamps', ''],
  ['hazard', 'Hazard lights', ''],
  ['tyre', 'Tyre pressure', ''],
];

export class Menu {
  constructor(api) {
    this.api = api;
    this.isOpen = false;
    this.pending = {};             // the car picked, waiting for Apply
    this.sec = storage.get(LAST_KEY) || 'car';
    if (!SECS.some(s => s.id === this.sec)) this.sec = 'car';
    this.refreshT = 0;
    this.build();
  }

  // ------------------------------------------------------------------ build
  build() {
    const el = document.createElement('aside');
    el.className = 'pn';
    el.id = 'panel';
    el.hidden = true;
    el.setAttribute('aria-label', 'Menu');
    el.innerHTML = `
      <nav class="pn-rail" role="tablist" aria-orientation="vertical">${SECTIONS.map(s => s.sep ? '<i class="pn-sep"></i>'
        : `<button type="button" role="tab" class="pn-tab" data-sec="${s.id}" title="${s.title}" aria-label="${s.title}">${icon(s.icon)}</button>`).join('')}</nav>
      <div class="pn-main">
        <header class="pn-head">
          <h2><span class="pn-title"></span><span class="kc pn-hot"></span></h2>
          <div class="pn-acts">
            <button type="button" class="pn-ib" data-act="pause" title="Pause"></button>
            <button type="button" class="pn-ib" data-act="recover" title="Recover: back on the wheels">${icon('recover')}</button>
            <button type="button" class="pn-ib" data-act="close" title="Close">${icon('close')}</button>
          </div>
        </header>
        ${SECS.map(s => `<section class="pn-body${s.id === 'tuning' ? ' pn-tuning' : ''}" role="tabpanel" data-pane="${s.id}" hidden></section>`).join('')}
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.panes = Object.fromEntries([...el.querySelectorAll('[data-pane]')].map(p => [p.dataset.pane, p]));
    for (const s of SECS) if (s.id !== 'tuning') this.panes[s.id].innerHTML = s.rows.map(r => this.rowHTML(r)).join('');
    this.api.tuning.attach(this.panes.tuning);
    this.renderDevice();

    el.addEventListener('click', e => this.onClick(e));
    el.addEventListener('input', e => {
      const t = e.target;
      if (t.type !== 'range' || !t.closest('[data-key]')) return;
      const r = ROWS[t.closest('[data-key]').dataset.key];
      if (r) this.setValue(r.key, +t.value / r.scale);
    });
    // after a mouse or touch use the focus goes back to the game, so the driving keys keep working
    el.addEventListener('pointerdown', () => el.classList.remove('kbnav'));
    el.addEventListener('pointerup', () => setTimeout(() => {
      const a = document.activeElement;
      if (a && el.contains(a) && !a.matches('input[type=text], textarea, select')) a.blur();
    }, 0));
    el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
  }

  rowHTML(r) {
    const info = r.info ? `<button type="button" class="pr-i" data-info aria-label="What is this?">${icon('info')}</button>` : '';
    const caps = [].concat(r.hot || []).map(id => `<span class="kc" data-cap="${id}"></span>`).join('');
    const head = r.label ? `<div class="pr-l"><span class="pr-t">${r.label}</span>${caps}${info}</div>` : '';
    const note = r.info ? `<div class="pr-n">${r.info.trim()}</div>` : '';
    switch (r.type) {
      case 'group': return `<h3 class="pr-g">${r.title}</h3>`;
      case 'seg': {
        const opts = r.options.map(([v, o]) => {
          const face = typeof o === 'string' ? o : icon(o.icon);
          const tip = typeof o === 'string' ? '' : ` title="${o.text}" aria-label="${o.text}"`;
          return `<button type="button" role="radio" data-seg="${v}"${tip}>${face}</button>`;
        }).join('');
        const iconSeg = r.options.some(([, o]) => typeof o !== 'string');
        const cls = `pr${multi(r) ? ' wide' : ''}${r.quick ? ' quick' : ''}`;
        return `<div class="${cls}" data-key="${r.key}">${head}<div class="seg${iconSeg ? ' icons' : ''}" role="radiogroup" aria-label="${escapeHTML(r.label || r.key)}">${opts}</div>${r.status ? '<div class="pr-st"></div>' : ''}${note}</div>`;
      }
      case 'switch': return `<div class="pr" data-key="${r.key}">${head}<button type="button" class="switch" role="switch" aria-label="${escapeHTML(r.label)}"><span class="knob"></span></button>${note}</div>`;
      case 'range': return `<div class="pr rng" data-key="${r.key}"><div class="pr-l"><span class="pr-t">${r.label}</span>${caps}${info}<output></output></div><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" aria-label="${escapeHTML(r.label)}">${note}</div>`;
      case 'stepper': return `<div class="pr" data-key="${r.key}">${head}<div class="stepper"><button type="button" data-action="pressureDown" aria-label="Lower">${icon('minus')}</button><output></output><button type="button" data-action="pressureUp" aria-label="Raise">${icon('plus')}</button></div>${note}</div>`;
      case 'buttons': return `<div class="pr" data-key="${r.key}">${head}<div class="btns">${r.buttons.map(([a, l]) => `<button type="button" class="btn" data-action="${a}">${l}</button>`).join('')}</div>${r.status ? '<div class="pr-st"></div>' : ''}${note}</div>`;
      case 'cars': return `<div class="pr wide cars" data-key="car"><div class="pr-l"><span class="pr-t">Vehicle</span>${info}</div>
        <div class="car-grid" role="radiogroup" aria-label="Vehicle">${CAR_LIST.map(c => `<button type="button" role="radio" class="car-t" data-seg="${c.id}"><b>${escapeHTML(c.label)}</b><small>${escapeHTML(ENGINES[c.physics.engine.preset]?.label || '')}</small></button>`).join('')}</div>
        <button type="button" class="btn primary car-apply" data-action="carApply" hidden>Restart with this car</button>${note}</div>`;
      case 'places': return `<div class="pl-list">${this.api.locations.map((l, i) => `
        <div class="pr pl" data-place="${i}"><button type="button" class="pl-go" data-loc="${i}"><span class="pl-n">${i + 1}</span><span class="pl-b"><b>${escapeHTML(l.title)}</b><small>${escapeHTML(l.tag)}</small></span><span class="pl-here" title="You are here">${icon('here')}</span></button>
        <button type="button" class="pr-i" data-info aria-label="About this place">${icon('info')}</button><div class="pr-n">${escapeHTML(l.desc)}</div></div>`).join('')}</div>`;
      case 'legend': return `<h3 class="pr-g">HUD icons</h3><div class="legend">${LEGEND.filter(([n]) => n !== 'aux' || hasControl('auxLights')).map(([n, t, d]) => `<div><span class="lg-i">${icon(n)}</span><b>${t}</b>${d ? `<small>${d}</small>` : ''}</div>`).join('')}</div>`;
      case 'bindings': return '<div class="binds"></div>';
      default: return '';
    }
  }

  // the key list follows the device: keyboard and gamepad, or keyboard and touch
  buildBindings(touch) {
    this.ctlTouch = touch;
    const bindings = carBindings();
    const groups = [...new Set(bindings.map(b => b.group))];
    const third = touch ? touchCapHTML : padCapHTML;
    this.panes.controls.querySelector('.binds').innerHTML = `
      <div class="tip-box">${icon('recover')}<span>Stuck? ${stuckSteps(id => capsHTML(id, touch ? 'touch' : 'kb'))} · ${capsHTML('recover', touch ? 'touch' : 'kb')} puts you back on the wheels</span></div>
      ${groups.map(g => `<h3 class="pr-g">${g}<span>${touch ? 'Touch' : 'Pad'}</span></h3>
      <div class="bind-t">${bindings.filter(b => b.group === g).map(b => `<div class="bind"><span class="bind-a">${escapeHTML(b.label)}</span><span class="bind-k">${capsHTML(b.id, 'kb', { all: true })}</span><span class="bind-p">${third(b.id)}</span></div>`).join('')}</div>`).join('')}`;
  }

  renderDevice() {
    const dev = this.api.device();
    for (const el of this.el.querySelectorAll('[data-cap]')) el.innerHTML = dev === 'touch' ? '' : capsHTML(el.dataset.cap, dev === 'pad' ? 'pad' : 'kb');
    if ((dev === 'touch') !== this.ctlTouch) this.buildBindings(dev === 'touch');
    this.renderHead();
  }

  renderHead() {
    const s = SECS.find(x => x.id === this.sec), dev = this.api.device();
    this.el.querySelector('.pn-title').textContent = s.title;
    this.el.querySelector('.pn-hot').innerHTML = s.hot && dev !== 'touch' ? capsHTML(s.hot, dev === 'pad' ? 'pad' : 'kb') : '';
    this.renderPause();
  }

  renderPause() {
    const p = !!this.api.paused(), b = this.el.querySelector('[data-act="pause"]');
    if (p === this._paused) return;
    this._paused = p;
    b.innerHTML = icon(p ? 'play' : 'pause');
    b.title = p ? 'Resume' : 'Pause';
    b.classList.toggle('on', p);
  }

  // ------------------------------------------------------------------ state
  // only what changed is written; also runs 5 times a second while open (keys change the car meanwhile)
  refresh() {
    if (!this.isOpen) return;
    const api = this.api, pane = this.panes[this.sec];
    this.renderPause();
    if (this.sec === 'places') {
      const here = api.get('here');
      pane.querySelectorAll('.pl').forEach((el, i) => el.classList.toggle('here', i === here));
      return;
    }
    for (const rowEl of pane.querySelectorAll('[data-key]')) {
      const key = rowEl.dataset.key, def = ROWS[key];
      if (!def) continue;
      const hide = def.show ? !def.show(api) : false;
      if (rowEl.hidden !== hide) rowEl.hidden = hide;
      if (hide) continue;
      if (def.type === 'seg' || def.type === 'cars') {
        const cur = String(def.type === 'cars' && this.pending.car !== undefined ? this.pending.car : api.get(key));
        if (def.type === 'cars') {
          const changed = cur !== String(api.get('car'));
          rowEl.querySelector('.car-apply').hidden = !changed;
          rowEl.classList.toggle('pending', changed);
        }
        if (rowEl._v === cur) continue;
        rowEl._v = cur;
        const bs = [...rowEl.querySelectorAll('[data-seg]')], any = bs.some(b => b.dataset.seg === cur);
        for (const b of bs) {
          const on = b.dataset.seg === cur;
          b.setAttribute('aria-checked', on);
          b.tabIndex = on || (!any && b === bs[0]) ? 0 : -1;       // a group with nothing selected stays reachable
        }
      } else if (def.type === 'switch') {
        const on = String(key === 'fullscreen' ? !!document.fullscreenElement : !!api.get(key));
        if (rowEl._v !== on) { rowEl._v = on; rowEl.querySelector('.switch').setAttribute('aria-checked', on); }
      } else if (def.type === 'range') {
        const v = Math.round(api.get(key) * def.scale), inp = rowEl.querySelector('input');
        if (+inp.value !== v && document.activeElement !== inp) inp.value = v;
        const txt = def.fmt ? def.fmt(v) : v + def.unit;
        if (rowEl._v !== txt) { rowEl._v = txt; rowEl.querySelector('output').textContent = txt; }
        inp.style.setProperty('--f', ((+inp.value - def.min) / (def.max - def.min)).toFixed(3));
      } else if (def.type === 'stepper') {
        const t = api.get('pressureText');
        if (rowEl._v !== t) { rowEl._v = t; rowEl.querySelector('output').textContent = t; }
      }
      if (def.status) {
        const t = api.get(def.status) || '', n = rowEl.querySelector('.pr-st');
        if (n.textContent !== t) n.textContent = t;
      }
      if (def.infoKey && rowEl.classList.contains('open')) {
        const t = api.get(def.infoKey) || '', n = rowEl.querySelector('.pr-n');
        if (n.textContent !== t) n.textContent = t;
      }
    }
  }

  setValue(key, v) {
    if (key === 'fullscreen') { this.runAction('fullscreen'); return; }
    const def = ROWS[key];
    if (def?.type === 'seg' && typeof def.options[0][0] === 'number') v = +v;
    if (def?.type === 'cars') { this.pending.car = v; this.refresh(); return; }      // applied by its button
    this.api.set(key, v);
    this.refresh();
  }

  runAction(a) {
    if (a === 'fullscreen') {
      // Keyboard Lock (Chromium) keeps a short Esc press for the menu; holding Esc still leaves fullscreen
      const d = document, done = () => { const r = this.panes.graphics.querySelector('[data-key="fullscreen"]'); if (r) r._v = undefined; this.refresh(); };
      if (d.fullscreenElement) Promise.resolve(d.exitFullscreen?.()).catch(() => {}).then(done);
      else Promise.resolve(d.documentElement.requestFullscreen?.({ navigationUI: 'hide' }))
        .then(() => this.api.device() === 'touch' ? screen.orientation?.lock?.('landscape') : navigator.keyboard?.lock?.(['Escape']))
        .catch(() => {}).then(done);
      return;
    }
    if (a === 'carApply') { if (this.pending.car !== undefined) this.api.applyCar(this.pending.car); return; }
    if (a === 'resetSettings') { this.api.set('resetSettings', true); this.invalidate(); }
    else this.api.action(a);
    this.refresh();
  }

  invalidate() { for (const r of this.el.querySelectorAll('[data-key]')) r._v = undefined; }

  onClick(e) {
    const t = e.target.closest('button');
    if (!t || !this.el.contains(t)) return;
    const d = t.dataset;
    if (d.sec) return this.show(d.sec);
    if (d.act === 'close') return this.close();
    if (d.act === 'pause') { this.api.setPaused(!this.api.paused()); this.renderPause(); return; }
    if (d.act === 'recover') return this.api.recover();
    if (d.info !== undefined) { t.closest('.pr').classList.toggle('open'); this.refresh(); return; }
    if (d.loc !== undefined) { this.api.teleport(+d.loc); this.refresh(); return; }
    if (d.seg !== undefined) return this.setValue(t.closest('[data-key]').dataset.key, d.seg);
    if (t.classList.contains('switch')) { const k = t.closest('[data-key]').dataset.key; return this.setValue(k, k === 'fullscreen' || !this.api.get(k)); }
    if (d.action) this.runAction(d.action);
  }

  // ------------------------------------------------------------------ open / close
  get section() { return this.sec; }

  open(sec) {
    if (sec) this.show(sec, false);
    if (this.isOpen) return;
    this.isOpen = true;
    this.el.hidden = false;
    document.body.classList.add('panel-open');
    this.show(this.sec, false);
    this.api.onOpen?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    this.pending = {};
    this.el.classList.remove('kbnav');
    document.body.classList.remove('panel-open');
    this.api.tuning.setOpen(false);
    if (document.activeElement && this.el.contains(document.activeElement)) document.activeElement.blur();
    this.api.onOpen?.(false);
  }

  // a key opens its section, or closes the panel when that section is already showing
  toggle(sec) {
    if (this.isOpen && (!sec || sec === this.sec)) this.close();
    else this.open(sec);
  }

  show(id, focus) {
    if (!SECS.some(s => s.id === id)) return;
    this.sec = id;
    storage.set(LAST_KEY, id);
    for (const b of this.el.querySelectorAll('.pn-tab')) {
      const on = b.dataset.sec === id;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
    }
    for (const [k, p] of Object.entries(this.panes)) p.hidden = k !== id;
    this.panes[id].scrollTop = 0;
    this.api.tuning.setOpen(this.isOpen && id === 'tuning');
    this.invalidate();
    this.renderHead();
    this.refresh();
    if (focus) this.el.querySelector(`.pn-tab[data-sec="${id}"]`).focus();
  }

  cycle(dir) {
    const i = SECS.findIndex(s => s.id === this.sec);
    this.show(SECS[(i + dir + SECS.length) % SECS.length].id, true);
  }

  update(dt) {
    if (!this.isOpen) return;
    if ((this.refreshT -= dt) > 0) return;
    this.refreshT = 0.2;
    this.refresh();
  }

  // ------------------------------------------------------------------ gamepad (Input.uiHandler)
  focusables() {
    return [...this.el.querySelectorAll('.pn-tab[aria-selected="true"], .pn-acts button, [data-pane]:not([hidden]) button, [data-pane]:not([hidden]) input, [data-pane]:not([hidden]) select')]
      .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden]') && el.offsetParent !== null);
  }

  moveFocus(dir) {
    const list = this.focusables();
    let i = list.indexOf(document.activeElement);
    if (i < 0) { (list.find(el => this.panes[this.sec].contains(el)) || list[0])?.focus(); return; }
    const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  }

  adjust(dir, el) {
    if (!el || !this.el.contains(el)) return;
    if (el.classList.contains('pn-tab')) { this.cycle(dir); return; }
    if (el.dataset.seg !== undefined) {
      const opts = [...el.parentElement.querySelectorAll('[data-seg]')];
      const n = opts[Math.max(0, Math.min(opts.length - 1, opts.indexOf(el) + dir))];
      this.setValue(el.closest('[data-key]').dataset.key, n.dataset.seg);
      n.focus();
      return;
    }
    if (el.type === 'range') {
      el.value = +el.value + dir * +el.step;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (el.classList.contains('switch')) { const k = el.closest('[data-key]').dataset.key; if (!!this.api.get(k) !== dir > 0) this.setValue(k, dir > 0); return; }
    this.moveFocus(dir);
  }

  // ev: { type: 'key', e } | { type: 'pad', btn }. Returns true when the event was used.
  handle(ev) {
    if (!this.isOpen) return false;
    if (ev.type === 'key') {
      // number keys pick a place while Places is showing; every other key drives as usual
      const dg = /^(?:Digit|Numpad)([1-9])$/.exec(ev.e.code);
      if (dg && this.sec === 'places' && +dg[1] <= this.api.locations.length) { this.api.teleport(+dg[1] - 1); this.refresh(); return true; }
      return false;
    }
    const btn = ev.btn, el = document.activeElement;
    this.el.classList.add('kbnav');
    if (btn === 'up') this.moveFocus(-1);
    else if (btn === 'down') this.moveFocus(1);
    else if (btn === 'left' || btn === 'right') this.adjust(btn === 'right' ? 1 : -1, el);
    else if (btn === 'accept') { if (el && this.el.contains(el)) el.click(); else this.moveFocus(1); }
    else if (btn === 'back' || btn === 'menu') this.close();
    else if (btn === 'prevTab') this.cycle(-1);
    else if (btn === 'nextTab') this.cycle(1);
    return true;
  }
}
