import { STOCK, ENGINES, ENGINE_ORDER, RANGES, TYRE_SIZES, TYRE_WIDTHS, sanitize, clone, applySetup, analyze, exportJSON, netTorque, tyreRadius, wheelMass } from './vehicle/tuning.js';
import { makeCarParams, getCar } from './vehicle/carSpecs.js';
import { storage } from './settings.js';
import { escapeHTML, fmtPressure } from './hud.js';
import './tuning.css';

// In-game tuning panel (Tab). The game keeps running: the mouse works the panel, the driving keys
// still drive. Every change goes straight into the physics (Vehicle.retune); the readouts show what it
// does to the truck (ride frequency, damping, clearance and angles, axle loads, gear speeds, 0-100).
//
// The setup, the saved setups and the panel state live in localStorage (offroad.tuning.v1).

const KEY_BASE = 'offroad.tuning.v1';
// each car keeps its own setup and saved setups (the Defender keeps the original key)
const carKey = () => getCar() === 'defender' ? KEY_BASE : KEY_BASE + '.' + getCar();
const DEG = Math.PI / 180;
const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const set = (o, path, v) => { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const pct = (v, s) => { const d = Math.round((v / s - 1) * 100); return d === 0 ? 'stock' : (d > 0 ? '+' : '') + d + ' %'; };
const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2), f0 = x => Math.round(x).toString();
const cm = x => `${Math.round(x * 100)} cm`;
const sgnCm = x => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 1000) / 10).toFixed(1)} cm`;
const kN = x => `${(x / 1000).toFixed(1)} k`;
const AXLES = [['front', 'F'], ['rear', 'R']];
const GEAR_NAMES = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

// slider rows: [path, label, range key, format, hint]
const sl = (path, label, range, fmt, hint, extra = {}) => ({ type: 'slider', path, label, range, fmt, hint, ...extra });

export class TuningPanel {
  // api: { vehicle, settings, colliderView, action(id), toast(html, kind, key), redraw() }
  constructor(api) {
    this.api = api;
    this.open = false;
    this.state = { setup: clone(STOCK), setups: {}, ui: { sections: { engine: true }, overlay: false, sel: -1 } };
    try {
      const s = JSON.parse(storage.get(carKey()) || 'null');
      if (s) {
        this.state.setup = sanitize(s.setup);
        if (s.setups && typeof s.setups === 'object') for (const [n, x] of Object.entries(s.setups).slice(0, 40)) this.state.setups[String(n).slice(0, 40)] = sanitize(x);
        if (s.ui) Object.assign(this.state.ui, s.ui);
      }
    } catch { /* corrupt: stock */ }
    this.stockP = makeCarParams();
    this.runs = [];            // dyno results this session
    this.dirty = true;
    this.liveT = 0;
    this.launch = null;        // in-game 0-100 timer
    this.lastLaunch = null;
  }

  get v() { return this.api.vehicle; }
  get setup() { return this.state.setup; }
  save() { storage.set(carKey(), JSON.stringify(this.state)); }

  // apply the current setup to the physics. colliders: rebuild the chassis boxes too.
  apply({ snap = false, colliders = true } = {}) {
    const v = this.v, s = this.setup;
    applySetup(v.P, s);
    v.pressures = [s.tyres.pressF, s.tyres.pressR];
    v.retune({ snap, colliders });
    this.api.colliderView?.rebuildBoxes();
    this.dirty = true;
    this.api.redraw?.();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const el = document.createElement('aside');
    el.className = 'tune';
    el.id = 'tuning';
    el.hidden = true;
    el.setAttribute('aria-label', 'Tuning');
    document.body.appendChild(el);
    this.el = el;
    el.innerHTML = `
      <header class="tn-head">
        <div class="tn-title"><b>Tuning</b><span class="tn-sub">changes apply while you drive · <kbd class="cap">Tab</kbd> closes</span></div>
        <button type="button" class="tn-x" data-act="close" aria-label="Close">×</button>
      </header>
      <div class="tn-bar">
        <select class="tn-setups" aria-label="Saved setups"></select>
        <button type="button" class="tn-b" data-act="saveas">Save as…</button>
        <button type="button" class="tn-b" data-act="stock" title="Everything back to the stock truck">Stock</button>
        <button type="button" class="tn-b" data-act="export">Export</button>
        <button type="button" class="tn-b" data-act="import">Import</button>
      </div>
      <div class="tn-io" hidden></div>
      <div class="tn-sum"></div>
      <div class="tn-scroll"></div>`;
    this.scroll = el.querySelector('.tn-scroll');
    this.sum = el.querySelector('.tn-sum');
    this.io = el.querySelector('.tn-io');
    this.sel = el.querySelector('.tn-setups');
    this.buildSections();
    this.renderSetups();

    el.addEventListener('input', e => this.onInput(e));
    el.addEventListener('change', e => this.onChange(e));
    el.addEventListener('click', e => this.onClick(e));
    el.addEventListener('dblclick', e => {
      const r = e.target.closest('input[type=range][data-path]');
      if (r) this.setValue(r.dataset.path, get(STOCK, r.dataset.path));
    });
    // keep the driving keys for the truck: buttons and sliders give the focus back after a mouse use
    el.addEventListener('pointerup', () => setTimeout(() => {
      const a = document.activeElement;
      if (a && el.contains(a) && !a.matches('input[type=text], textarea, select')) a.blur();
    }, 0));
    el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
  }

  // section definitions: rows + a readout function
  sections() {
    const gearbox = this.api.settings.get('gearbox'), P = this.v.P;
    const box = gearbox === 'manual' || P.manualOnly ? 'manual' : 'auto';   // a manual-only car shifts its manual box itself
    const ratios = this.setup.gearbox[box];
    // suspension rows per half of the axles: front / rear on a 4x4, "1–2" / "3–4" on an 8x8
    const nA = P.axles.length, AX = nA === 2 ? AXLES : [['front', `1–${nA / 2}`], ['rear', `${nA / 2 + 1}–${nA}`]];
    return [
      { id: 'engine', title: 'Engine', rows: [
        { type: 'engines' },
        sl('engine.torque', 'Torque', 'engine.torque', v => `×${f2(v)}`, 'Scales the whole torque curve: a tune, a turbo, a tired engine.'),
        sl('engine.revs', 'Rev limiter', 'engine.revs', v => `${f0(this.v.P.engine.limiterRpm)} rpm`, 'Where the engine cuts out. The automatic shifts just below it.'),
        { type: 'curve' },
      ] },
      { id: 'trans', title: 'Transmission', rows: [
        { type: 'gearbox' },
        ...ratios.map((r, i) => sl(`gearbox.${box}.${i}`, GEAR_NAMES[i], 'gearbox.ratio', v => f2(v), i === 0 ? 'Gear ratios: higher = more pull, lower top speed in that gear.' : '', { gear: i })),
        sl(`gearbox.${box}Rev`, 'Reverse', 'gearbox.ratio', f2, ''),
        sl('gearbox.final', 'Final drive', 'gearbox.final', f2, 'Axle ratio. 4.10 or 4.75 is the usual fix for big tyres.'),
        sl('gearbox.high', 'Transfer high', 'gearbox.high', v => v.toFixed(3), ''),
        sl('gearbox.low', 'Transfer low', 'gearbox.low', f2, 'Low range: a bigger number crawls slower and climbs harder.'),
        { type: 'gears' },
        { type: 'live' },
      ] },
      { id: 'tyres', title: 'Wheels and tyres', rows: [
        { type: 'chips', path: 'tyres.size', label: 'Tyre size', options: TYRE_SIZES.map(x => [x, x + '″']), hint: 'Taller tyres lift the whole truck and the axles, and gear it taller. Watch the arches.' },
        { type: 'chips', path: 'tyres.width', label: 'Width', options: TYRE_WIDTHS.map(x => [x, String(x)]) },
        sl('tyres.pressF', 'Pressure front', 'tyres.press', v => fmtPressure(v, this.api.settings.get('pressureUnit')), 'Lower: bigger footprint, more grip off-road, softer ride. [ ] change both.'),
        sl('tyres.pressR', 'Pressure rear', 'tyres.press', v => fmtPressure(v, this.api.settings.get('pressureUnit')), ''),
        sl('tyres.grip', 'Compound grip', 'tyres.grip', v => `×${f2(v)}`, 'Grip on every surface. Mud terrain = 1.'),
      ] },
      { id: 'susp', title: 'Suspension', rows: [
        sl('suspension.lift', 'Lift', 'suspension.lift', v => (v ? '+' : '') + cm(v), 'Longer springs: more ground clearance and room in the arches, higher centre of mass.'),
        ...['k', 'bump', 'rebound', 'arb', 'travel'].flatMap(k => AX.map(([ax, n]) => sl(`suspension.${ax}.${k}`, `${{ k: 'Spring', bump: 'Bump damping', rebound: 'Rebound damping', arb: 'Anti-roll bar', travel: 'Bump travel' }[k]} ${n}`, 'suspension.' + k,
          v => (k === 'travel' ? cm(v) : `${kN(v)}${k === 'k' ? 'N/m' : k === 'arb' ? 'N·m/rad' : 'N·s/m'}`) + ` · ${pct(v, STOCK.suspension[ax][k])}`,
          ax === 'front' ? { k: 'Stiffer: less roll and pitch, harsher on bumps, less articulation.', bump: 'Damping on the way up (compression).', rebound: 'Damping on the way down: too little and the truck keeps bouncing.', arb: 'Roll stiffness only; 0 = disconnected (max articulation).', travel: 'How far the axle can rise before the hard stop.' }[k] : ''))),
      ] },
      { id: 'brakes', title: 'Brakes', rows: [
        sl('brakes.force', 'Brake force', 'brakes.force', v => `×${f2(v)}`, ''),
        sl('brakes.bias', 'Front share', 'brakes.bias', v => `${Math.round(v * 100)} %`, 'More front: stable, the front locks first. More rear: the rear locks first and it spins (with ABS off).'),
        sl('brakes.handbrake', 'Handbrake', 'brakes.handbrake', v => `×${f2(v)}`, ''),
      ] },
      { id: 'mass', title: 'Mass', rows: [
        sl('mass.cargo', 'Cargo', 'mass.cargo', v => `${f0(v)} kg`, 'In the load bay behind the rear seats.'),
        sl('mass.roof', 'Roof load', 'mass.roof', v => `${f0(v)} kg`, 'On the rack: high up, it rolls the truck over sooner.'),
        sl('mass.comY', 'Centre of mass', 'mass.comY', v => sgnCm(v), 'Moves the body\'s centre of mass up or down.'),
      ] },
      { id: 'steer', title: 'Steering', rows: [
        sl('steering.lock', 'Max lock', 'steering.lock', v => `${f1(v)}°`, 'Road-wheel angle at full lock: a tighter turning circle.'),
        sl('steering.ratio', 'Steering ratio', 'steering.ratio', v => `${f1(v)}:1`, 'Lower = quicker steering (turns of the wheel per angle).'),
      ] },
      { id: 'body', title: 'Body and colliders', rows: [{ type: 'colliders' }] },
      { id: 'measure', title: 'Measure', rows: [{ type: 'dyno' }] },
    ];
  }

  buildSections() {
    const ui = this.state.ui;
    this.scroll.innerHTML = this.sections().map(s => `
      <section class="tn-sec${ui.sections[s.id] ? ' open' : ''}" data-sec="${s.id}">
        <header class="tn-sh"><button type="button" class="tn-st" data-act="toggle">${s.title}<span class="tn-ss"></span></button>
          ${s.id !== 'measure' ? `<button type="button" class="tn-reset" data-act="reset" title="This section back to stock">stock</button>` : ''}</header>
        <div class="tn-sb">
          <div class="tn-ro" data-ro="${s.id}"></div>
          ${s.rows.map(r => this.rowHTML(r)).join('')}
        </div>
      </section>`).join('');
    this.dirty = true;
  }

  rowHTML(r) {
    if (r.type === 'slider') {
      const [min, max, step] = RANGES[r.range];
      const stock = get(STOCK, r.path);
      const tick = stock != null ? ((stock - min) / (max - min)) * 100 : -10;
      return `<div class="tn-row" data-row="${r.path}">
        <div class="tn-l"><span>${r.label}</span><output></output></div>
        <div class="tn-rng"><input type="range" min="${min}" max="${max}" step="${step}" data-path="${r.path}" aria-label="${escapeHTML(r.label)}" title="Double-click: stock"><i style="left:${tick}%"></i></div>
        ${r.hint ? `<div class="tn-h">${r.hint}</div>` : ''}</div>`;
    }
    if (r.type === 'chips') return `<div class="tn-row" data-row="${r.path}"><div class="tn-l"><span>${r.label}</span><output></output></div>
      <div class="tn-chips">${r.options.map(([v, l]) => `<button type="button" data-chip="${r.path}" data-v="${v}">${l}</button>`).join('')}</div>${r.hint ? `<div class="tn-h">${r.hint}</div>` : ''}</div>`;
    if (r.type === 'engines') return `<div class="tn-row"><div class="tn-chips tn-eng">${ENGINE_ORDER.map(k => `<button type="button" data-engine="${k}" title="${escapeHTML(ENGINES[k].name)}">${ENGINES[k].label}</button>`).join('')}</div><div class="tn-h tn-engnote"></div></div>`;
    if (r.type === 'curve') return `<div class="tn-row"><canvas class="tn-curve" width="720" height="220"></canvas><div class="tn-h"><span class="tn-k tq">torque</span> <span class="tn-k pw">power</span> <span class="tn-k st">stock</span> · net, at the flywheel</div></div>`;
    if (r.type === 'gearbox') {
      const P = this.v.P, nm = P.manual.ratios.length;
      const auto = P.manualOnly ? `Auto-shift ${nm}` : `Automatic ${P.auto.ratios.length}`;
      return `<div class="tn-row"><div class="tn-l"><span>Gearbox</span></div><div class="tn-chips"><button type="button" data-gearbox="auto">${auto}</button><button type="button" data-gearbox="manual">Manual ${nm}</button></div></div>`;
    }
    if (r.type === 'gears') return `<div class="tn-row"><div class="tn-gears"></div></div>`;
    if (r.type === 'live') {
      // only the switches this car has (the BTR-80: no lockers, self-locking axle diffs; no 2WD)
      const d = this.v.drivetrain;
      const sw = [['range', 'Low range'], ['centreLock', 'Centre lock'], ...(d.canLock ? [['rearLock', 'Rear locker'], ['frontLock', 'Front locker']] : []), ['traction', 'Traction ctl'], ['abs', 'ABS'], ...(d.layout.rwd?.length ? [['rwd', '2WD']] : [])];
      return `<div class="tn-row"><div class="tn-l"><span>Driveline now</span></div><div class="tn-chips tn-live">
      ${sw.map(([a, l]) => `<button type="button" data-live="${a}">${l}</button>`).join('')}</div>
      <div class="tn-h">The same switches as the keys. Low range and 2WD need a stop.</div></div>`;
    }
    if (r.type === 'colliders') return `<div class="tn-row">
        <div class="tn-l"><span>Show physics</span><button type="button" class="switch" data-act="overlay" role="switch" aria-label="Show physics"><span class="knob"></span></button></div>
        <div class="tn-h">Collision boxes (red where they touch), wheel side cylinders, tyres against the arch tops, suspension travel (orange: bump stop) and the tyre contact patches (size: load, colour: slip).</div>
        <div class="tn-touch"></div>
      </div>
      <div class="tn-row"><div class="tn-l"><span>Collision boxes</span></div><div class="tn-chips tn-boxes"></div></div>
      <div class="tn-boxed"></div>`;
    if (r.type === 'dyno') return `<div class="tn-row">
        <div class="tn-h">Runs the real physics (this truck, this setup, this gearbox) on a flat dirt pad: full throttle from a standstill to 100 km/h.</div>
        <div class="tn-dynobar"><button type="button" class="tn-b primary" data-act="dyno">Measure 0–100</button><span class="tn-dynost"></span></div>
        <canvas class="tn-dyno" width="720" height="240" hidden></canvas>
        <div class="tn-runs"></div>
        <div class="tn-launch"></div>
      </div>`;
    return '';
  }

  // collider editor for the selected box
  renderBoxEditor() {
    const cols = this.setup.colliders, i = this.state.ui.sel;
    const chips = this.el.querySelector('.tn-boxes');
    chips.innerHTML = cols.map((c, k) => `<button type="button" data-box="${k}" aria-checked="${k === i}">${escapeHTML(c.name)}</button>`).join('') +
      `<button type="button" data-act="boxreset" class="tn-ghost">Reset all</button>`;
    const ed = this.el.querySelector('.tn-boxed');
    if (i < 0 || !cols[i]) { ed.innerHTML = `<div class="tn-h">Pick a box to move or resize it. The physics updates as you drag; the selected box shows amber.</div>`; return; }
    const lab = [['Centre x (right)', 0, 'box.c'], ['Centre y (up)', 1, 'box.c'], ['Centre z (back)', 2, 'box.c'], ['Width', 3, 'box.h'], ['Height', 4, 'box.h'], ['Length', 5, 'box.h'], ['Rounding', 6, 'box.r']];
    ed.innerHTML = lab.map(([l, j, rk]) => {
      const [min, max, step] = RANGES[rk];
      const full = j >= 3 && j <= 5;
      return `<div class="tn-row" data-row="box:${j}"><div class="tn-l"><span>${l}</span><output></output></div>
        <div class="tn-rng"><input type="range" min="${full ? min * 2 : min}" max="${full ? max * 2 : max}" step="${full ? step * 2 : step}" data-box-k="${j}" aria-label="${l}"></div></div>`;
    }).join('') + `<div class="tn-btns"><button type="button" class="tn-b" data-act="boxdup">Duplicate</button><button type="button" class="tn-b" data-act="boxdel">Delete</button><button type="button" class="tn-b" data-act="boxone" title="This box back to its stock size">Stock box</button></div>`;
  }

  renderSetups() {
    const names = Object.keys(this.state.setups);
    this.sel.innerHTML = `<option value="">${this.matchName() ? escapeHTML(this.matchName()) : 'Current setup'}</option>` + names.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join('');
  }
  matchName() {
    const cur = JSON.stringify(this.setup);
    if (cur === JSON.stringify(STOCK)) return 'Stock';
    for (const [n, s] of Object.entries(this.state.setups)) if (JSON.stringify(s) === cur) return n;
    return '';
  }

  // ------------------------------------------------------------------ events
  setValue(path, v) {
    if (!Number.isFinite(+v)) return;
    set(this.setup, path, +v);
    this.changed(path);
  }

  changed(path = '') {
    const colliders = path.startsWith('colliders') || path === '*';
    this.apply({ colliders });
    this.save();
    this.dirty = true;
  }

  onInput(e) {
    const t = e.target;
    if (t.dataset.path) this.setValue(t.dataset.path, t.value);
    else if (t.dataset.boxK !== undefined) {
      const i = this.state.ui.sel, j = +t.dataset.boxK, box = this.setup.colliders[i].box;
      let v = +t.value;
      if (j >= 3 && j <= 5) v /= 2;   // the slider shows the full size, the box stores half sizes
      box[j] = v;
      box[6] = Math.min(box[6], box[3] - 0.005, box[4] - 0.005, box[5] - 0.005);
      this.changed('colliders');
    }
  }

  onChange(e) {
    const t = e.target;
    if (t === this.sel && t.value) {
      this.state.setup = sanitize(this.state.setups[t.value]);
      this.apply();
      this.save();
      this.api.toast(`Setup loaded: ${escapeHTML(t.value)}`, 'good', 'tune');
      t.blur();
      this.rebuild();
    }
  }

  rebuild() { const y = this.scroll.scrollTop; this.buildSections(); this.renderSetups(); this.scroll.scrollTop = y; this.refresh(true); }

  onClick(e) {
    const t = e.target.closest('button');
    if (!t || !this.el.contains(t)) return;
    const d = t.dataset, s = this.setup;
    if (d.act === 'close') return this.toggle(false);
    if (d.act === 'toggle') {
      const sec = t.closest('[data-sec]'), id = sec.dataset.sec;
      this.state.ui.sections[id] = !this.state.ui.sections[id];
      sec.classList.toggle('open', !!this.state.ui.sections[id]);
      this.save(); this.dirty = true;
      return;
    }
    if (d.act === 'reset') {
      const id = t.closest('[data-sec]').dataset.sec;
      const keys = { engine: ['engine'], trans: ['gearbox'], tyres: ['tyres'], susp: ['suspension'], brakes: ['brakes'], mass: ['mass'], steer: ['steering'], body: ['colliders'] }[id] || [];
      for (const k of keys) s[k] = clone(STOCK[k]);
      if (id === 'body') this.state.ui.sel = -1;
      this.changed(id === 'body' ? 'colliders' : id);
      this.rebuild();
      return;
    }
    if (d.act === 'stock') { this.state.setup = clone(STOCK); this.state.ui.sel = -1; this.changed('*'); this.rebuild(); this.api.toast('Stock truck', 'good', 'tune'); return; }
    if (d.act === 'saveas') return this.showSave();
    if (d.act === 'export') return this.showExport();
    if (d.act === 'import') return this.showImport();
    if (d.act === 'iocancel') { this.io.hidden = true; return; }
    if (d.act === 'iosave') {
      const name = this.io.querySelector('input').value.trim().slice(0, 40);
      if (!name) return;
      this.state.setups[name] = clone(s);
      this.save(); this.renderSetups(); this.io.hidden = true;
      this.api.toast(`Saved: ${escapeHTML(name)}`, 'good', 'tune');
      return;
    }
    if (d.act === 'iodel') {
      const n = d.name;
      delete this.state.setups[n]; this.save(); this.renderSetups(); this.showSave();
      return;
    }
    if (d.act === 'iocopy') {
      const ta = this.io.querySelector('textarea');
      ta.select();
      navigator.clipboard?.writeText(ta.value).then(() => { t.textContent = 'Copied'; }, () => { document.execCommand?.('copy'); t.textContent = 'Copied'; });
      return;
    }
    if (d.act === 'ioimport') {
      try {
        const obj = JSON.parse(this.io.querySelector('textarea').value);
        this.state.setup = sanitize(obj);
        this.changed('*'); this.io.hidden = true; this.rebuild();
        this.api.toast('Setup imported', 'good', 'tune');
      } catch (err) { this.io.querySelector('.tn-err').textContent = 'Not valid JSON: ' + err.message; }
      return;
    }
    if (d.engine) { s.engine = { preset: d.engine, torque: 1, revs: 0 }; this.changed('engine'); this.rebuild(); return; }
    if (d.chip) { this.setValue(d.chip, +d.v); this.rebuild(); return; }
    if (d.gearbox) { this.api.settings.set('gearbox', d.gearbox, { silent: true }); this.rebuild(); return; }
    if (d.live) {
      const dt = this.v.drivetrain;
      if (d.live === 'rearLock' || d.live === 'frontLock') {
        const front = d.live === 'frontLock';
        if (front) dt.frontLock = !dt.frontLock; else dt.rearLock = !dt.rearLock;
        dt.say(`${front ? 'Front' : 'Rear'} locker ${(front ? dt.frontLock : dt.rearLock) ? 'ON' : 'off'}`);
      } else this.api.action(d.live);
      this.refreshLive();
      return;
    }
    if (d.act === 'overlay') {
      this.state.ui.overlay = !this.state.ui.overlay;
      this.api.colliderView.setEnabled(this.state.ui.overlay);
      this.save(); this.dirty = true;
      return;
    }
    if (d.box !== undefined) {
      const i = +d.box;
      this.state.ui.sel = this.state.ui.sel === i ? -1 : i;
      this.api.colliderView.selected = this.state.ui.sel;
      if (!this.state.ui.overlay && this.state.ui.sel >= 0) { this.state.ui.overlay = true; this.api.colliderView.setEnabled(true); }
      this.save(); this.renderBoxEditor(); this.dirty = true;
      return;
    }
    if (d.act === 'boxreset') { s.colliders = clone(STOCK.colliders); this.state.ui.sel = -1; this.api.colliderView.selected = -1; this.changed('colliders'); this.renderBoxEditor(); return; }
    if (d.act === 'boxdup') {
      const c = clone(s.colliders[this.state.ui.sel]); c.name = c.name.replace(/( copy)?$/, ' copy'); c.box[0] += 0.1;
      s.colliders.push(c); this.state.ui.sel = s.colliders.length - 1; this.api.colliderView.selected = this.state.ui.sel;
      this.changed('colliders'); this.renderBoxEditor(); return;
    }
    if (d.act === 'boxdel') {
      if (s.colliders.length <= 1) return;
      s.colliders.splice(this.state.ui.sel, 1); this.state.ui.sel = -1; this.api.colliderView.selected = -1;
      this.changed('colliders'); this.renderBoxEditor(); return;
    }
    if (d.act === 'boxone') {
      const c = s.colliders[this.state.ui.sel], st = STOCK.colliders.find(x => x.name === c.name);
      if (st) { c.box = [...st.box]; this.changed('colliders'); }
      return;
    }
    if (d.act === 'dyno') return this.runDyno();
  }

  showSave() {
    const names = Object.keys(this.state.setups);
    this.io.hidden = false;
    this.io.innerHTML = `<div class="tn-l"><span>Save the current setup</span></div>
      <div class="tn-inrow"><input type="text" maxlength="40" placeholder="Name, e.g. Td5 on 35s" value="${escapeHTML(this.matchName() && this.matchName() !== 'Stock' ? this.matchName() : '')}"><button type="button" class="tn-b primary" data-act="iosave">Save</button><button type="button" class="tn-b" data-act="iocancel">Cancel</button></div>
      ${names.length ? `<div class="tn-h">Saved: ${names.map(n => `<span class="tn-saved">${escapeHTML(n)} <button type="button" data-act="iodel" data-name="${escapeHTML(n)}" title="Delete">×</button></span>`).join(' ')}</div>` : ''}`;
    const inp = this.io.querySelector('input');
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.io.querySelector('[data-act=iosave]').click(); if (e.key === 'Escape') { e.stopPropagation(); this.io.hidden = true; } });
  }
  showExport() {
    this.io.hidden = false;
    this.io.innerHTML = `<div class="tn-l"><span>Export</span></div>
      <div class="tn-h">The whole setup as JSON. Send it to someone (they use Import), or paste it as <code>DEFAULT_SETUP</code> in <code>src/vehicle/tuning.js</code> to make it the truck's new stock.</div>
      <textarea readonly spellcheck="false">${escapeHTML(exportJSON(this.setup))}</textarea>
      <div class="tn-inrow"><button type="button" class="tn-b primary" data-act="iocopy">Copy</button><button type="button" class="tn-b" data-act="iocancel">Close</button></div>`;
  }
  showImport() {
    this.io.hidden = false;
    this.io.innerHTML = `<div class="tn-l"><span>Import</span></div>
      <div class="tn-h">Paste an exported setup. Missing parts stay stock, out-of-range numbers are clamped.</div>
      <textarea spellcheck="false" placeholder="{ &quot;engine&quot;: { &quot;preset&quot;: &quot;td5&quot; } }"></textarea><div class="tn-err"></div>
      <div class="tn-inrow"><button type="button" class="tn-b primary" data-act="ioimport">Apply</button><button type="button" class="tn-b" data-act="iocancel">Cancel</button></div>`;
    this.io.querySelector('textarea').focus();
  }

  toggle(force) {
    if (!this.el) this.build();
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    document.body.classList.toggle('tune-open', this.open);
    if (this.open) { this.renderSetups(); this.refresh(true); }
    else if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  // ------------------------------------------------------------------ readouts
  refresh(force = false) {
    if (!this.open || (!this.dirty && !force)) return;
    this.dirty = false;
    const v = this.v, P = v.P, s = this.setup, el = this.el;
    const gearbox = this.api.settings.get('gearbox');
    // the gearbox decides which ratio sliders exist (M switches it with the panel open)
    if (this._gb !== gearbox) { const first = this._gb === undefined; this._gb = gearbox; if (!first) { const y = this.scroll.scrollTop; this.buildSections(); this.scroll.scrollTop = y; } }
    const A = this.an = analyze(P, s, gearbox);
    if (!this.stockAn || this.stockAn.gb !== gearbox) { this.stockAn = analyze(applySetup(makeCarParams(), clone(STOCK)), STOCK, gearbox); this.stockAn.gb = gearbox; }
    const S = this.stockAn;
    // sliders, chips, outputs
    for (const r of el.querySelectorAll('input[type=range][data-path]')) {
      const val = get(s, r.dataset.path);
      if (+r.value !== val) r.value = val;
      const row = r.closest('.tn-row'), def = this.rowDef(r.dataset.path);
      row.querySelector('output').textContent = def ? def.fmt(val) : val;
      row.classList.toggle('mod', Math.abs(val - get(STOCK, r.dataset.path)) > 1e-9);
    }
    for (const b of el.querySelectorAll('[data-chip]')) b.setAttribute('aria-checked', String(get(s, b.dataset.chip)) === b.dataset.v);
    for (const b of el.querySelectorAll('[data-engine]')) b.setAttribute('aria-checked', b.dataset.engine === s.engine.preset);
    for (const b of el.querySelectorAll('[data-gearbox]')) b.setAttribute('aria-checked', b.dataset.gearbox === gearbox);
    const sz = el.querySelector('[data-row="tyres.size"] output');
    if (sz) sz.textContent = `${s.tyres.size}×${s.tyres.width}  ·  ${Math.round(tyreRadius(s.tyres.size) * 2000)} mm · ${Math.round(wheelMass(s.tyres.size, s.tyres.width))} kg`;
    const en = el.querySelector('.tn-engnote');
    if (en) en.textContent = ENGINES[s.engine.preset].note;
    // summary strip
    const t100 = A.accel.t100;
    this.sum.innerHTML = [
      ['Power', `${f0(A.engine.hp)} hp`], ['0–100', t100 ? `≈ ${f1(t100)} s` : '—'], ['Top', `${f0(A.vmax)} km/h`],
      ['Weight', `${f0(A.mass)} kg`], ['F / R', `${f0(A.front * 100)} / ${f0(100 - A.front * 100)}`], ['Approach', `${f0(A.geo.approach)}°`],
    ].map(([k, x]) => `<div><span>${k}</span><b>${x}</b></div>`).join('');
    // section summaries + readouts
    const ro = (id, html) => { const n = el.querySelector(`[data-ro="${id}"]`); if (n) n.innerHTML = html; };
    const ss = (id, txt) => { const n = el.querySelector(`[data-sec="${id}"] .tn-ss`); if (n) n.textContent = txt; };
    const kv = items => `<div class="tn-kv">${items.filter(Boolean).map(([k, x, cls = '']) => `<div class="${cls}"><span>${k}</span><b>${x}</b></div>`).join('')}</div>`;
    const vs = (a, b, d = 1, better = 1) => { const x = a - b; if (Math.abs(x) < Math.pow(10, -d) / 2) return ''; return ` <em class="${x * better > 0 ? 'up' : 'dn'}">${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}</em>`; };
    ss('engine', `${ENGINES[s.engine.preset].label} · ${f0(A.engine.hp)} hp`);
    ro('engine', kv([
      ['Peak power', `${f0(A.engine.kw)} kW · ${f0(A.engine.hp)} hp @ ${A.engine.kwAt}`],
      ['Peak torque', `${f0(A.engine.nm)} Nm @ ${A.engine.nmAt}`],
      ['0–100 estimate', t100 ? `${f1(t100)} s${vs(t100, S.accel.t100, 1, -1)}` : 'does not reach 100'],
      ['Weight / power', `${f1(A.engine.kgPerHp)} kg/hp`],
    ]));
    this.drawCurve();
    ss('trans', `${gearbox === 'manual' ? 'Manual' : 'Automatic'} · ${f2(s.gearbox.final)}`);
    ro('trans', kv([
      ['Top speed', `${f0(A.vmax)} km/h${vs(A.vmax, S.vmax, 0)}`],
      ['Crawl ratio', `${f1(A.crawl)}:1${vs(A.crawl, S.crawl, 1)}`],
    ]));
    const gt = el.querySelector('.tn-gears');
    if (gt) gt.innerHTML = `<table><tr><th></th><th>ratio</th><th>high</th><th>low</th></tr>${A.gears.map((g, i) => `<tr><td>${GEAR_NAMES[i]}</td><td>${f2(g.ratio)}</td><td>${f0(g.high)}</td><td>${f0(g.low)}</td></tr>`).join('')}</table><div class="tn-h">km/h at the rev limiter in each gear (${f0(P.engine.limiterRpm)} rpm, ${s.tyres.size}″ tyres).</div>`;
    this.refreshLive();
    const geo = A.geo, arch = geo.arch;
    const archTxt = a => a.twist >= 0.005 ? `${cm(a.bump)} · ${cm(a.twist)} twisted` : a.bump >= 0.005 ? `<span class="warn">rubs when twisted (${cm(-a.twist)})</span>` : `<span class="bad">rubs at full bump (${cm(-a.bump)})</span>`;
    ss('tyres', `${s.tyres.size}×${s.tyres.width} · ${fmtPressure(v.pressure, this.api.settings.get('pressureUnit'))}`);
    ro('tyres', kv([
      ['Axle clearance', `${cm(geo.diffClear)}${vs(geo.diffClear * 100, S.geo.diffClear * 100, 0)}`],
      ['Gearing', s.tyres.size === STOCK.tyres.size ? 'stock' : `${pct(tyreRadius(s.tyres.size), tyreRadius(STOCK.tyres.size))} taller`],
      ['Arch room F', archTxt(arch[0])], ['Arch room R', archTxt(arch[1])],
    ]));
    ss('susp', `${s.suspension.lift ? '+' + cm(s.suspension.lift) + ' lift · ' : ''}${f2(A.susp[0].f)} / ${f2(A.susp[1].f)} Hz`);
    const freq = i => `${f2(A.susp[i].f)} Hz <em class="${A.susp[i].f > S.susp[i].f + 0.005 ? 'up' : A.susp[i].f < S.susp[i].f - 0.005 ? 'dn' : ''}">${A.susp[i].f > S.susp[i].f + 0.005 ? 'stiffer' : A.susp[i].f < S.susp[i].f - 0.005 ? 'softer' : 'stock'}</em>`;
    const zeta = z => `${f2(z)} ${z < 0.25 ? '<span class="bad">bouncy</span>' : z < 0.4 ? '<span class="warn">soft</span>' : z > 0.9 ? '<span class="warn">harsh</span>' : ''}`;
    ro('susp', kv([
      ['Ride F', freq(0)], ['Ride R', freq(1)],
      ['Damping F', zeta(A.susp[0].zeta)], ['Damping R', zeta(A.susp[1].zeta)],
      ['Body clearance', `${cm(geo.bodyClear)}${vs(geo.bodyClear * 100, S.geo.bodyClear * 100, 0)}`], ['Axle clearance', cm(geo.diffClear)],
      ['Approach', `${f0(geo.approach)}°${vs(geo.approach, S.geo.approach, 0)}`], ['Departure', `${f0(geo.departure)}°${vs(geo.departure, S.geo.departure, 0)}`],
      ['Breakover', `${f0(geo.breakover)}°${vs(geo.breakover, S.geo.breakover, 0)}`], ['Centre of mass', `${cm(A.comH)} up`],
    ]) + `<div class="tn-h">Ride: bounce frequency of the body on springs + tyres (comfort ~1.0–1.5 Hz). Damping ratio ζ: 0.3–0.6 is usual, lower keeps bouncing. Angles come from the collision boxes and the static ride height.</div>`);
    ss('brakes', `${Math.round(s.brakes.bias * 100)} % front`);
    ro('brakes', kv([
      ['Brakes alone', `${f2(A.brakes.brakeG)} g`],
      ['Locks first (dirt)', A.brakes.first === 'front' ? 'front · stable' : '<span class="warn">rear · can spin</span>'],
      ['Ideal front share', `${Math.round(A.brakes.ideal * 100)} %`],
    ]));
    ss('mass', `${f0(A.mass)} kg`);
    ro('mass', kv([
      ['Total', `${f0(A.mass)} kg${vs(A.mass, S.mass, 0, -1)}`], ['Axle loads F / R', `${f0(A.front * 100)} / ${f0(100 - A.front * 100)} %`],
      ['Centre of mass', `${cm(A.comH)} above ground${vs(A.comH * 100, S.comH * 100, 0, -1)}`],
      ['Tips over at', `${f2(A.ssf)} g · ${f0(A.tiltDeg)}° side slope`],
    ]) + `<div class="tn-h">Rollover limit of a rigid truck (half track / centre of mass height). Body roll on the springs makes the real limit a few degrees lower.</div>`);
    ss('steer', `${f1(s.steering.lock)}° · ${f1(s.steering.ratio)}:1`);
    ro('steer', kv([
      ['Turning circle', `${f1(A.turnDiameter)} m${vs(A.turnDiameter, S.turnDiameter, 1, -1)}`], ['Lock to lock', `${f1(A.lockToLock)} turns`],
    ]));
    ss('body', `${s.colliders.length} boxes`);
    ro('body', kv([
      ['Approach', `${f0(geo.approach)}°`], ['Departure', `${f0(geo.departure)}°`], ['Breakover', `${f0(geo.breakover)}°`],
    ]));
    const ov = el.querySelector('[data-act=overlay]');
    if (ov) ov.setAttribute('aria-checked', !!this.state.ui.overlay);
    if (el.querySelector('.tn-boxes') && !el.querySelector('.tn-boxes').childElementCount) this.renderBoxEditor();
    const i = this.state.ui.sel, box = s.colliders[i]?.box;
    if (box) for (const r of el.querySelectorAll('input[data-box-k]')) {
      const j = +r.dataset.boxK, full = j >= 3 && j <= 5, val = full ? box[j] * 2 : box[j];
      if (Math.abs(+r.value - val) > 1e-6) r.value = val;
      r.closest('.tn-row').querySelector('output').textContent = `${Math.round(val * 1000) / 10} cm`;
    }
    ss('measure', this.runs.length && this.runs[0].t100 ? `${f2(this.runs[0].t100)} s` : '');
    // a section's "stock" button shows only once something in it differs from stock
    const SECT = { engine: ['engine'], trans: ['gearbox'], tyres: ['tyres'], susp: ['suspension'], brakes: ['brakes'], mass: ['mass'], steer: ['steering'], body: ['colliders'] };
    for (const [id, keys] of Object.entries(SECT)) {
      const n = el.querySelector(`[data-sec="${id}"]`);
      if (n) n.classList.toggle('mod', keys.some(k => JSON.stringify(s[k]) !== JSON.stringify(STOCK[k])));
    }
    const mn = this.matchName();
    if (mn !== this._shownName) { this._shownName = mn; this.renderSetups(); }
  }

  rowDef(path) {
    if (!this._defs) { this._defs = {}; }
    if (!this._defs[path]) for (const s of this.sections()) for (const r of s.rows) if (r.path) this._defs[r.path] = r;
    return this._defs[path];
  }

  // driveline switches and the collider contact list, 5 times a second while open
  refreshLive() {
    const d = this.v.drivetrain, v = this.v, el = this.el;
    const st = { range: d.range === 'low', centreLock: d.centerLock, rearLock: d.rearLock, frontLock: d.frontLock, traction: v.tc, abs: v.abs, rwd: d.rwd };
    for (const b of el.querySelectorAll('[data-live]')) b.setAttribute('aria-checked', !!st[b.dataset.live]);
    const tc = el.querySelector('.tn-touch');
    if (tc) {
      const cv = this.api.colliderView;
      if (!this.state.ui.overlay) tc.textContent = '';
      else {
        const names = [...cv.touching].map(i => this.setup.colliders[i]?.name).filter(Boolean);
        const html = names.length ? `Touching: <b class="bad">${names.map(escapeHTML).join(', ')}</b>` : 'Body clear of the ground';
        if (tc.innerHTML !== html) tc.innerHTML = html;
      }
    }
    const ln = el.querySelector('.tn-launch');
    if (ln) { const h = this.lastLaunch ? `Your last launch in the game: <b>0–100 in ${f1(this.lastLaunch.t100)} s</b> (${escapeHTML(this.lastLaunch.label)})` : 'Floor it from a standstill: the panel times your own 0–100 too.'; if (ln.innerHTML !== h) ln.innerHTML = h; }
  }

  drawCurve() {
    const cv = this.el.querySelector('.tn-curve');
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, P = this.v.P, SP = this.stockP;
    g.clearRect(0, 0, W, H);
    const maxR = Math.max(P.engine.limiterRpm, SP.engine.limiterRpm) + 300;
    const curves = p => { const t = [], w = []; for (let r = 600; r <= p.engine.limiterRpm; r += 50) { const n = netTorque(p, r); t.push([r, n]); w.push([r, n * r * Math.PI / 30 / 1000]); } return { t, w }; };
    const c = curves(P), s0 = curves(SP);
    const maxT = Math.max(...c.t.map(x => x[1]), ...s0.t.map(x => x[1])) * 1.1, maxW = Math.max(...c.w.map(x => x[1]), ...s0.w.map(x => x[1])) * 1.1;
    const pad = 34, X = r => pad + (r / maxR) * (W - pad * 2), Yt = n => H - 24 - (n / maxT) * (H - 40), Yw = n => H - 24 - (n / maxW) * (H - 40);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1; g.font = '600 18px ui-monospace, Menlo, monospace'; g.fillStyle = 'rgba(238,241,244,0.45)';
    for (let r = 1000; r < maxR; r += 1000) { g.beginPath(); g.moveTo(X(r), 10); g.lineTo(X(r), H - 24); g.stroke(); g.fillText(r / 1000 + 'k', X(r) - 10, H - 4); }
    const line = (pts, Y, col, dash) => { g.setLineDash(dash || []); g.strokeStyle = col; g.lineWidth = dash ? 2 : 3.5; g.beginPath(); pts.forEach(([r, n], i) => (i ? g.lineTo(X(r), Y(n)) : g.moveTo(X(r), Y(n)))); g.stroke(); g.setLineDash([]); };
    line(s0.t, Yt, 'rgba(255,179,71,0.45)', [8, 6]); line(s0.w, Yw, 'rgba(140,200,255,0.45)', [8, 6]);
    line(c.t, Yt, '#ffb347'); line(c.w, Yw, '#8cc8ff');
    g.fillStyle = '#ffb347'; g.fillText(`${Math.round(maxT / 1.1)} Nm`, 4, 22);
    g.fillStyle = '#8cc8ff'; const tx = `${Math.round(maxW / 1.1)} kW`; g.fillText(tx, W - g.measureText(tx).width - 4, 22);
  }

  // ------------------------------------------------------------------ 0-100 measurement
  runDyno() {
    if (this.dynoBusy) return;
    const gearbox = this.api.settings.get('gearbox');
    const st = this.el.querySelector('.tn-dynost');
    const label = `${ENGINES[this.setup.engine.preset].label} · ${this.setup.tyres.size}″ · ${gearbox === 'manual' ? 'manual' : 'auto'}`;
    const P = clone(this.v.P), opts = { gearbox, pressures: [...this.v.pressures] };
    this.dynoBusy = true;
    st.textContent = 'starting…';
    const done = res => {
      this.dynoBusy = false;
      res.label = label;
      this.runs.unshift(res); this.runs.length = Math.min(this.runs.length, 6);
      st.innerHTML = res.t100 ? `<b>0–100 in ${f2(res.t100)} s</b> · 0–60 ${f1(res.t60)} s · ${f0(res.dist)} m` : 'did not reach 100 km/h in 45 s';
      this.drawDyno();
      this.dirty = true;
    };
    const fail = msg => { this.dynoBusy = false; st.textContent = 'failed: ' + msg; };
    const progress = p => { st.textContent = `running… ${f0(p.kmh)} km/h · ${f1(p.t)} s · ${p.gear}`; };
    try {
      const w = this.worker || (this.worker = new Worker(new URL('./vehicle/dyno.worker.js', import.meta.url), { type: 'module' }));
      const id = (this.dynoId = (this.dynoId || 0) + 1);
      w.onmessage = e => { const m = e.data; if (m.id !== id) return; if (m.progress) progress(m.progress); else if (m.done) done(m.done); else if (m.error) fail(m.error); };
      w.onerror = e => { this.worker = null; fail(e.message || 'worker error'); };
      w.postMessage({ id, P, opts });
    } catch (e) { fail(String(e.message || e)); }
  }

  drawDyno() {
    const cv = this.el.querySelector('.tn-dyno');
    const list = this.el.querySelector('.tn-runs');
    if (!cv || !this.runs.length) return;
    cv.hidden = false;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const maxT = Math.max(10, ...this.runs.map(r => (r.samples.at(-1) || [0])[0])) * 1.05;
    const pad = 36, X = t => pad + (t / maxT) * (W - pad - 10), Y = k => H - 26 - (k / 110) * (H - 40);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.font = '600 18px ui-monospace, Menlo, monospace'; g.fillStyle = 'rgba(238,241,244,0.45)';
    for (const k of [50, 100]) { g.beginPath(); g.moveTo(pad, Y(k)); g.lineTo(W - 10, Y(k)); g.stroke(); g.fillText(String(k), 2, Y(k) + 6); }
    const step = maxT > 30 ? 10 : 5;
    for (let t = step; t < maxT; t += step) { g.fillText(t + 's', X(t) - 12, H - 4); }
    const cols = ['#ffb347', '#8cc8ff', '#6fdc8c', '#ff8fa3', '#c9a7ff', '#dddddd'];
    this.runs.slice().reverse().forEach((r, k, arr) => {
      const i = arr.length - 1 - k;
      g.strokeStyle = cols[i]; g.lineWidth = i === 0 ? 4 : 2; g.globalAlpha = i === 0 ? 1 : 0.7;
      g.beginPath(); r.samples.forEach(([t, kmh], j) => (j ? g.lineTo(X(t), Y(kmh)) : g.moveTo(X(t), Y(kmh)))); if (r.t100) g.lineTo(X(r.t100), Y(100)); g.stroke();
    });
    g.globalAlpha = 1;
    list.innerHTML = this.runs.map((r, i) => `<div><i style="background:${cols[i]}"></i>${escapeHTML(r.label)} <b>${r.t100 ? f2(r.t100) + ' s' : '—'}</b></div>`).join('');
  }

  // ------------------------------------------------------------------ per frame (cheap when closed)
  update(dt, vehicle, raw) {
    // the [ ] keys change the tyre pressures: keep the setup (and its save) in step
    const ps = vehicle.pressures, ts = this.setup.tyres;
    if (ps[0] !== ts.pressF || ps[1] !== ts.pressR) { ts.pressF = ps[0]; ts.pressR = ps[1]; this.save(); this.dirty = true; }
    // in-game launch timer (always on: it only reads a few numbers)
    const kmh = vehicle.speed * 3.6;
    if (Math.abs(kmh) < 0.5 && raw.throttle < 0.05) this.launch = { armed: true, t: 0 };
    else if (this.launch?.armed) {
      if (raw.brake > 0.3 || kmh < -1) this.launch = null;
      else if (raw.throttle > 0.5 || this.launch.t > 0) {
        this.launch.t += dt;
        if (kmh >= 100) {
          const gb = this.api.settings.get('gearbox');
          this.lastLaunch = { t100: this.launch.t, label: `${ENGINES[this.setup.engine.preset].label} · ${this.setup.tyres.size}″ · ${gb === 'manual' ? 'manual' : 'auto'}` };
          if (this.open) this.api.toast(`0–100 km/h in ${f1(this.launch.t)} s`, 'good', 'launch');
          this.launch = null;
        } else if (this.launch.t > 60) this.launch = null;
      }
    }
    if (!this.open) return;
    this.liveT -= dt;
    if (this.liveT <= 0) { this.liveT = 0.2; this.refreshLive(); }
    if (this.dirty) this.refresh();
  }
}
