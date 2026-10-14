import { capsHTML, hasControl } from './input.js';
import { storage } from './settings.js';
import { wheelName } from './vehicle/suspension.js';
import { icon } from './icons.js';

const FULL_SEEN_KEY = 'offroad.fullscreenUsed.v1';

// In-game HUD. Cost rules: no layout reads per frame; DOM is written only when a value changes; bars
// move with transforms; the rpm dial redraws per 20 rpm over a cached static layer; the chassis panel
// redraws at 20 Hz and telemetry at 10 Hz, only while shown.
//
// The instrument cluster shows everything that changes how the truck drives. Its warning lights are always
// there: dim when idle, lit when on, struck through when switched off, flashing amber while an assist works
// (traction control, ABS, steering assist, arcade reverse). Colour only where a dashboard uses it: amber
// caution, red warning, green lamps on, blue high beam.

const SPEED_UNITS = { kmh: { k: 3.6, label: 'km/h' }, mph: { k: 2.236936, label: 'mph' } };
export const fmtPressure = (psi, unit) => unit === 'bar' ? `${(psi * 0.0689476).toFixed(2)} bar` : `${psi.toFixed(0)} psi`;
const fmtPressureNum = (psi, unit) => unit === 'bar' ? (psi * 0.0689476).toFixed(2) : psi.toFixed(0);
export const speedUnit = u => SPEED_UNITS[u] || SPEED_UNITS.kmh;

const AUTO_STRIP = ['P', 'R', 'N', 'D'];
const DIAL = 148;          // css px at scale 1
const SUSP_W = 240, SUSP_H = 284;   // chassis panel canvas, logical px
const DEG = 180 / Math.PI;
// rpm scale: the limiter rounded up to a whole thousand
const dialMax = E => Math.max(3000, Math.ceil(E.limiterRpm / 1000) * 1000);
const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const RED = '#ff4d3d', AMBER = '#ffb020';

// Drivetrain diagram in a fixed 64 x 72 box; more than two axles get smaller wheels down the same box.
function diffSvg(nA) {
  if (nA === 2) return `<path class="shaft" d="M14 13H50M14 59H50M32 13V59"/>
                <rect class="w" x="3" y="4" width="11" height="18" rx="2.5"/>
                <rect class="w" x="50" y="4" width="11" height="18" rx="2.5"/>
                <rect class="w" x="3" y="50" width="11" height="18" rx="2.5"/>
                <rect class="w" x="50" y="50" width="11" height="18" rx="2.5"/>
                <circle class="df" cx="32" cy="13" r="5.5"/>
                <circle class="df" cx="32" cy="36" r="5.5"/>
                <circle class="df" cx="32" cy="59" r="5.5"/>`;
  const y0 = 8, y1 = 64, step = (y1 - y0) / (nA - 1), h = Math.min(18, step - 3), r = Math.min(5.5, step / 2 - 2.5);
  let path = '', wheels = '', diffs = '';
  for (let a = 0; a < nA; a++) {
    const y = (y0 + a * step).toFixed(1);
    path += `M14 ${y}H50`;
    wheels += `<rect class="w" x="3" y="${(y - h / 2).toFixed(1)}" width="11" height="${h.toFixed(1)}" rx="2"/><rect class="w" x="50" y="${(y - h / 2).toFixed(1)}" width="11" height="${h.toFixed(1)}" rx="2"/>`;
    diffs += `<circle class="df" cx="32" cy="${y}" r="${r.toFixed(1)}"/>`;
  }
  // centre diff on the shaft between the middle axles, drawn to the side so it doesn't hide an axle diff
  const yc = ((y0 + y1) / 2).toFixed(1);
  path += `M32 ${y0}V${y1}M32 ${yc}H40`;
  diffs += `<circle class="df" cx="42" cy="${yc}" r="${r.toFixed(1)}"/>`;
  return `<path class="shaft" d="${path}"/>${wheels}${diffs}`;
}

export class HUD {
  constructor(root = document.getElementById('hud')) {
    this.root = root;
    const tt = (id, name, label) => `<i class="tt" id="${id}" title="${label}">${icon(name)}</i>`;
    root.innerHTML = `
      <div class="hud-tl">
        <div class="tl-row">
          <button class="hb" id="h-menubtn" tabindex="-1" type="button" aria-label="Menu">${icon('menu')}<span class="kc" id="h-menukey"></span></button>
          <button class="hb" id="h-full" tabindex="-1" type="button" aria-label="Fullscreen"></button>
          <div class="hints" id="h-hints"></div>
          <span class="hb-st" id="h-mute" hidden></span>
        </div>
        <div class="sound-pill" id="h-sound" hidden></div>
        <div class="hud-panel tele" id="h-tele" hidden></div>
      </div>
      <div class="hud-top">
        <button class="paused-b" id="h-paused" type="button" tabindex="-1" hidden>${icon('play')}<span>Paused</span></button>
        <div class="toasts" id="h-toasts" aria-live="polite"></div>
        <div class="tip" id="h-tip" hidden></div>
      </div>
      <div class="hud-fps" id="h-fps" hidden></div>
      <canvas class="sight" id="h-sight" hidden></canvas>
      <div class="gunbox" id="h-gun" hidden>
        <svg class="gb-turret" viewBox="0 0 44 60" aria-hidden="true">
          <rect class="gb-hull" x="9" y="2" width="26" height="56" rx="5"/>
          <g id="h-gunrot"><line class="gb-barrel" x1="22" y1="22" x2="22" y2="1"/><circle class="gb-tur" cx="22" cy="22" r="8"/></g>
        </svg>
        <div class="gb-main">
          <div class="gb-rows" id="h-gunrows"></div>
          <div class="gb-foot"><span id="h-gunelev">0°</span></div>
        </div>
      </div>
      <div class="hud-panel susp" id="h-susp" hidden>
        <div class="panel-h"><span>Chassis</span><span class="kc" id="h-suspkey"></span></div>
        <canvas id="h-suspcv"></canvas>
      </div>
      <div class="cluster" id="h-cluster">
        <div class="tells" aria-label="Warning lights">
          ${tt('t-eng', 'engine', 'Engine')}${tt('t-hb', 'handbrake', 'Handbrake')}${tt('t-gbx', 'arcade', 'Gearbox assist')}
          <i class="tt lvl" id="t-steer" title="Steering assist">${icon('steerAssist')}<b></b></i>${tt('t-tc', 'traction', 'Traction control')}${tt('t-abs', 'abs', 'ABS')}
          <i class="tsep"></i>
          ${tt('t-head', 'lowBeam', 'Headlights')}${tt('t-aux', 'aux', 'Extra lamps')}${tt('t-haz', 'hazard', 'Hazard lights')}
          <i class="tt mp" id="t-mp" title="Friends" hidden></i>
        </div>
        <div class="cl-body">
          <div class="cl-l">
            <div class="dt">
              <svg id="h-diffs" viewBox="0 0 64 72" aria-hidden="true">${diffSvg(2)}</svg>
              <div class="dt-m"><span class="chip" id="h-range">HI</span><span class="chip" id="h-drive">4WD</span></div>
            </div>
            <div class="kv" id="h-tyre">${icon('tyre')}<span id="h-psi"></span><small id="h-psiu"></small></div>
            <div class="kv"><span id="h-surf"></span><span class="grip" id="h-grip" title="Grip"><i></i><i></i><i></i><i></i><i></i></span></div>
          </div>
          <div class="dial" id="h-dialwrap">
            <canvas id="h-dial"></canvas>
            <div class="dial-c">
              <div class="spd" id="h-spd">0</div>
              <div class="unit" id="h-unit">km/h</div>
            </div>
            <div class="gear" id="h-gear">N</div>
            <div class="rpmbar"><i id="h-rpmbar"></i></div>
          </div>
          <div class="cl-r">
            <div class="gbx"><b id="h-mode" title="Gearbox">A</b><span class="strip" id="h-strip"></span></div>
            <div class="pedals" title="Clutch · brake · throttle">
              <div class="pd clu" id="p-cluwrap"><i id="p-clu"></i></div>
              <div class="pd brk"><i id="p-brk"></i></div>
              <div class="pd thr"><i id="p-thr"></i></div>
            </div>
          </div>
        </div>
      </div>`;
    const $ = id => root.querySelector('#' + id);
    this.$ = $;
    this.e = {
      menuBtn: $('h-menubtn'), fullBtn: $('h-full'), menuKey: $('h-menukey'), hints: $('h-hints'), sound: $('h-sound'), mute: $('h-mute'),
      paused: $('h-paused'), toasts: $('h-toasts'), tip: $('h-tip'), fps: $('h-fps'), tele: $('h-tele'), susp: $('h-susp'), suspKey: $('h-suspkey'),
      cluster: $('h-cluster'), mode: $('h-mode'), strip: $('h-strip'), range: $('h-range'), drive: $('h-drive'),
      diffs: [...root.querySelectorAll('#h-diffs .df')], wheels: [...root.querySelectorAll('#h-diffs .w')],
      dial: $('h-dial'), spd: $('h-spd'), unit: $('h-unit'), gear: $('h-gear'), rpmBar: $('h-rpmbar'),
      thr: $('p-thr'), brk: $('p-brk'), clu: $('p-clu'), cluWrap: $('p-cluwrap'),
      psi: $('h-psi'), psiU: $('h-psiu'), surf: $('h-surf'), grip: [...root.querySelectorAll('#h-grip i')], gripWrap: $('h-grip'),
      tEng: $('t-eng'), tHb: $('t-hb'), tGbx: $('t-gbx'), tSteer: $('t-steer'), tTc: $('t-tc'), tAbs: $('t-abs'),
      tHead: $('t-head'), tAux: $('t-aux'), tHaz: $('t-haz'), tMp: $('t-mp'),
    };
    this.dctx = this.e.dial.getContext('2d');
    Object.assign(this.e, { sight: $('h-sight'), gun: $('h-gun'), gunRot: $('h-gunrot'), gunRows: $('h-gunrows'), gunElev: $('h-gunelev') });
    this.sctx = $('h-suspcv').getContext('2d');
    this.c = {};                       // last written values
    this.opts = { speedUnit: 'kmh', pressureUnit: 'psi', cluster: 'auto', hudScale: 1, hints: true, suspension: false, telemetry: false, fps: false };
    this.device = 'kb';
    this.touchUI = false;
    this.toastList = [];
    this.tipState = { key: null, rolled: 0, stuck: 0, neutral: 0, engine: 0, clear: 0, acc: 0 };
    this.fpsAcc = 0; this.fpsN = 0; this.suspAcc = 1; this.teleAcc = 1;
    this.soundState = 'locked';
    this.onMenu = null;
    this.onFullscreen = null;
    this.onResume = null;
    for (const b of [this.e.menuBtn, this.e.fullBtn, this.e.paused]) b.addEventListener('mousedown', e => e.preventDefault());   // no keyboard focus
    this.e.menuBtn.addEventListener('click', () => this.onMenu && this.onMenu());
    this.e.paused.addEventListener('click', () => this.onResume && this.onResume());
    this.e.fullBtn.addEventListener('click', () => {
      if (!storage.get(FULL_SEEN_KEY)) { storage.set(FULL_SEEN_KEY, '1'); this.e.fullBtn.classList.remove('attn'); }
      if (!document.fullscreenEnabled) { this.toast('Full screen on iPhone: Share → Add to Home Screen, then start the game from there', { kind: 'warn', key: 'full', t: 5 }); return; }
      if (this.onFullscreen) this.onFullscreen();
    });
    this.e.fullBtn.classList.toggle('attn', !storage.get(FULL_SEEN_KEY));
    document.addEventListener('fullscreenchange', () => this.refreshFullscreen());
    this.refreshFullscreen();
    window.addEventListener('resize', () => this.resize());
    this.setDevice('kb', true);
    this.resize();
  }

  // ------------------------------------------------------------------ config
  configure(opts) {
    Object.assign(this.opts, opts);
    const o = this.opts;
    this.e.susp.hidden = !o.suspension;
    this.e.tele.hidden = !o.telemetry;
    this.e.fps.hidden = !o.fps;
    this.e.hints.hidden = !o.hints;
    this.suspAcc = this.teleAcc = 1;
    if (this.suspPrev) this.suspPrev.fill(-1);
    this.c.spd = this.c.psi = undefined;
    this.e.unit.textContent = speedUnit(o.speedUnit).label;
    this.resize();
  }

  resize() {
    const W = window.innerWidth || 1440, H = window.innerHeight || 900;
    // square root: shrinks slower than the window, so text stays readable
    const s = clamp(Math.sqrt(Math.min(W / 1600, H / 1000)), 0.8, 1.4) * (this.opts.hudScale || 1);
    if (s === this.scale && W === this.W && H === this.H) return;
    this.scale = s; this.W = W; this.H = H;
    this.small = H < 560 || W < 760;
    this.root.style.setProperty('--s', s.toFixed(3));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const dp = Math.max(32, Math.round(DIAL * s * dpr));
    this.e.dial.width = this.e.dial.height = dp;
    this.dialStatic = null; this.c.rpmQ = undefined;
    const scv = this.sctx.canvas;
    scv.width = Math.max(32, Math.round(SUSP_W * 0.9 * s * dpr)); scv.height = Math.round(scv.width * SUSP_H / SUSP_W);
    this.suspAcc = 1; if (this.suspPrev) this.suspPrev.fill(-1);
    this.c.compact = undefined;
  }

  setDevice(d, force) {
    if (d === this.device && !force) return;
    this.device = d;
    const k = id => capsHTML(id, d);
    const hint = (name, id, label) => `<span title="${label}">${icon(name)}${k(id)}</span>`;
    this.e.menuKey.innerHTML = d === 'touch' ? '' : k('menu');
    this.e.hints.innerHTML = d === 'touch' ? '' : d === 'pad'
      ? hint('camera', 'camera', 'Camera') + hint('recover', 'recover', 'Recover') + `<span title="Shift">${icon('autoShift')}${k('shiftUp')}${k('shiftDown')}</span>`
      : hint('keyboard', 'controls', 'Controls') + hint('pin', 'locations', 'Places') + hint('camera', 'camera', 'Camera') + hint('wrench', 'tuning', 'Tuning') + hint('recover', 'recover', 'Recover');
    this.e.suspKey.innerHTML = d === 'touch' ? '' : capsHTML('suspension', 'kb');
    this.tipState.key = null;
    this.c.steer = undefined;
    this.setSound(this.soundState, true);
  }

  // always shown (where pages can't go fullscreen, e.g. iPhone Safari, it says how instead)
  refreshFullscreen() {
    const on = !!document.fullscreenElement, b = this.e.fullBtn;
    b.innerHTML = icon(on ? 'fullscreenExit' : 'fullscreen');
    b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    b.title = on ? 'Exit fullscreen' : 'Fullscreen';
  }

  setTouch(on) {
    this.touchUI = on;
    this.c.compact = undefined;
    this.setDevice(this.device, true);
  }

  // 'locked' (waiting for a gesture), 'on', 'muted', 'error'
  setSound(state, force) {
    if (state === this.soundState && !force) return;
    this.soundState = state;
    const pill = this.e.sound, mute = this.e.mute;
    pill.hidden = state !== 'locked';
    if (state === 'locked') pill.innerHTML = `${icon('sound')}<span>${this.device === 'touch' ? 'Tap for sound' : 'Click or press a key for sound'}</span>`;
    mute.hidden = state !== 'muted' && state !== 'error';
    mute.className = 'hb-st' + (state === 'error' ? ' err' : '');
    mute.title = state === 'error' ? 'Sound unavailable' : 'Sound off';
    if (!mute.hidden) mute.innerHTML = icon('muted') + (state === 'muted' && this.device !== 'touch' ? capsHTML('mute', 'kb') : '');
  }

  setPaused(p) { this.e.paused.hidden = !p; }

  // ------------------------------------------------------------------ toasts
  // kind: '' | 'good' | 'warn'. key: a toast with the same key is updated in place. At most 3 on screen.
  toast(html, { t = 2.4, kind = '', key = html } = {}) {
    const same = this.toastList.find(x => x.key === key && !x.leaving);
    if (same) {
      same.t = t;
      if (same.html !== html) { same.html = html; same.el.innerHTML = html; }
      same.el.className = 'toast' + (kind ? ' ' + kind : '');
      same.el.animate?.([{ transform: 'scale(1.03)' }, { transform: 'none' }], { duration: 200, easing: 'ease-out' });
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = html;
    this.e.toasts.append(el);
    this.toastList.push({ el, html, key, t, leaving: false });
    const live = this.toastList.filter(x => !x.leaving);
    if (live.length > 3) this.dropToast(live[0]);
  }
  message(text, t = 2.4, kind = '', key) { this.toast(escapeHTML(text), { t, kind, key }); }

  // The drivetrain's messages bake in keyboard keys ("press I"): rewrite the known ones with the device's key caps.
  drivetrainToast(text) {
    const k = id => capsHTML(id, this.device);
    for (const [re, f, kind, key] of DT_MESSAGES) {
      const m = re.exec(text);
      if (m) { this.toast(f(k, m), { kind, key, t: kind === 'warn' ? 3.2 : 2.4 }); return; }
    }
    this.toast(escapeHTML(text));
  }
  dropToast(x) {
    if (x.leaving) return;
    x.leaving = true;
    x.el.classList.add('out');
    setTimeout(() => { x.el.remove(); this.toastList = this.toastList.filter(y => y !== x); }, 260);
  }
  tickToasts(dt) {
    for (const x of this.toastList) if (!x.leaving && (x.t -= dt) <= 0) this.dropToast(x);
  }

  setTip(key, html) {
    if (key === this.tipState.key) return;
    this.tipState.key = key;
    this.e.tip.hidden = !key;
    if (key) this.e.tip.innerHTML = html;
  }

  // ------------------------------------------------------------------ per frame
  // ctx: { cam, paused, raw, gun, mp: { n, solid } | null, telemetry: () => string }
  update(dt, v, view, ctx = {}) {
    const d = v.drivetrain, e = this.e, c = this.c, o = this.opts;
    this.tickToasts(dt);
    if (d.message && d.message !== this._lastMsg) this.drivetrainToast(d.message.text);
    this._lastMsg = d.message;

    const compact = o.cluster === 'compact' || (o.cluster === 'auto' && (ctx.cam === 'cockpit' || this.small || this.touchUI));
    if (compact !== c.compact) { c.compact = compact; e.cluster.classList.toggle('compact', compact); c.rpmQ = undefined; }

    this.updateTells(v, view, ctx);

    // gearbox: A or M, the gate, the gear
    const manual = d.mode === 'manual';
    const modeKey = manual ? (d.autoShift ? 'as' : 'm') : 'a';
    if (modeKey !== c.mode) {
      c.mode = modeKey; c.stripIdx = undefined;
      // a manual-only car (BTR-80) in "automatic": its box picks the gears itself
      e.mode.textContent = manual && !d.autoShift ? 'M' : 'A';
      e.mode.title = manual ? (d.autoShift ? `Manual ${v.P.manual.ratios.length}-speed, shifts itself` : `Manual ${v.P.manual.ratios.length}-speed`) : `Automatic ${v.P.auto.ratios.length}-speed`;
      const strip = manual ? ['R', 'N', ...v.P.manual.ratios.map((r, i) => String(i + 1))] : AUTO_STRIP;
      e.strip.innerHTML = strip.map(g => `<i>${g}</i>`).join('');
    }
    const pedal = manual && !d.clutchAssist && !d.autoShift;
    if (pedal !== c.pedal) { c.pedal = pedal; e.cluWrap.hidden = !pedal; }
    const stripIdx = manual ? d.manualGear + 1 : AUTO_STRIP.indexOf(d.selector);
    if (stripIdx !== c.stripIdx) {
      if (c.stripIdx !== undefined && e.strip.children[c.stripIdx]) e.strip.children[c.stripIdx].className = '';
      if (e.strip.children[stripIdx]) e.strip.children[stripIdx].className = 'on';
      c.stripIdx = stripIdx;
    }
    const gear = d.gearLabel();
    if (gear !== c.gear) { c.gear = gear; e.gear.textContent = gear; }
    const shifting = !!d.shift || d.grind > 0;
    if (shifting !== c.shifting) { c.shifting = shifting; e.gear.classList.toggle('shifting', shifting); }

    // 4x4: range, 2WD / 4WD, the diagram
    const low = !!v.P.transfer?.low;   // no HI / LO without low range
    if (low !== c.low) { c.low = low; e.range.hidden = !low; }
    if (d.range !== c.range) { c.range = d.range; e.range.textContent = d.range === 'low' ? 'LO' : 'HI'; e.range.classList.toggle('on', d.range === 'low'); }
    const canRwd = d.layout.rwd.length > 0;
    if (canRwd !== c.canRwd) { c.canRwd = canRwd; e.drive.hidden = !canRwd; }
    if (d.rwd !== c.rwd) { c.rwd = d.rwd; e.drive.textContent = d.rwd ? '2WD' : '4WD'; e.drive.classList.toggle('on', d.rwd); }
    this.updateDiffs(v);

    const su = speedUnit(o.speedUnit);
    const spd = Math.round(Math.abs(v.speed) * su.k);
    if (spd !== c.spd) { c.spd = spd; e.spd.textContent = spd; }
    if (!compact) this.drawDial(Math.max(0, d.rpm), v.P.engine);
    else this.rpmBar(Math.max(0, d.rpm), v.P.engine);

    this.updateGun(v, ctx.gun || null);
    this.bar(e.thr, 'thr', v.ctl.throttle);
    this.bar(e.brk, 'brk', Math.max(v.ctl.brake, v.ctl.handbrake));
    this.bar(e.clu, 'clu', manual ? clamp(d.clutchPedal / 0.8, 0, 1) : 0);

    // tyres and ground
    const pf = v.pressures[0], pr = v.pressures[1], u = o.pressureUnit;
    const psi = Math.abs(pf - pr) < 0.5 ? fmtPressureNum((pf + pr) / 2, u) : `${fmtPressureNum(pf, u)}·${fmtPressureNum(pr, u)}`;
    if (psi !== c.psi || u !== c.psiUnit) { c.psi = psi; c.psiUnit = u; e.psi.textContent = psi; e.psiU.textContent = u; }
    let surf = 'Air', contact = false;
    for (const w of v.wheels) if (w.contact) { surf = w.surf?.name || 'Ground'; contact = true; break; }
    if (surf !== c.surf) { c.surf = surf; e.surf.textContent = surf; }
    // grip: the tyres' friction on the ground under them now (Vehicle.gripG = 0.8 x mean mu), in five steps
    const mu = (v.gripG || 0) / 0.8, g = !contact ? 0 : mu >= 0.9 ? 5 : mu >= 0.75 ? 4 : mu >= 0.6 ? 3 : mu >= 0.48 ? 2 : 1;
    if (g !== c.grip) {
      c.grip = g;
      e.grip.forEach((el, i) => el.classList.toggle('on', i < g));
      e.gripWrap.classList.toggle('low', g === 1);
    }

    if (ctx.paused) this.setTip(null);
    else if ((this.tipState.acc += dt) > 0.25) { this.updateTips(this.tipState.acc, v, ctx.raw || v.ctl); this.tipState.acc = 0; }

    if (o.suspension && (this.suspAcc += dt) > 0.05) { this.suspAcc = 0; this.drawSuspension(v); }
    if (o.telemetry && (this.teleAcc += dt) > 0.1) { this.teleAcc = 0; this.updateTelemetry(v, ctx.telemetry ? ctx.telemetry() : ''); }
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { if (o.fps) e.fps.textContent = (this.fpsN / this.fpsAcc).toFixed(0) + ' fps'; this.fpsAcc = 0; this.fpsN = 0; }
  }

  // one warning light: state class '' (idle) | on | off | act | warn | alert | green | blue | haz | na
  tell(el, k, st) { if (this.c[k] !== st) { this.c[k] = st; el.className = 'tt' + (st ? ' ' + st : '') + (el.classList.contains('lvl') ? ' lvl' : ''); } }
  tellIcon(el, k, name) { if (this.c[k] !== name) { this.c[k] = name; el.querySelector('svg').outerHTML = icon(name); } }

  updateTells(v, view, ctx) {
    const d = v.drivetrain, e = this.e, c = this.c;
    this.tell(e.tEng, 'tEng', d.running ? '' : d.cranking ? 'warn' : 'alert');
    e.tEng.title = d.running ? 'Engine running' : d.cranking ? 'Engine starting' : d.stalled ? 'Engine stalled' : 'Engine off';
    this.tell(e.tHb, 'tHb', v.ctl.handbrake > 0.5 ? 'alert' : '');
    // the gearbox's assist: arcade reverse (automatic) or the auto-clutch (manual)
    if (d.mode === 'auto') {
      this.tellIcon(e.tGbx, 'gbxIcon', 'arcade');
      this.tell(e.tGbx, 'tGbx', !v.arcadeAuto ? 'off' : v.revTimer > 0 ? 'act' : 'on');
      e.tGbx.title = v.arcadeAuto ? 'Arcade reverse: brake at a stop reverses' : 'Arcade reverse off: select R';
    } else {
      this.tellIcon(e.tGbx, 'gbxIcon', 'clutch');
      this.tell(e.tGbx, 'tGbx', d.clutchAssist || d.autoShift ? 'on' : 'off');
      e.tGbx.title = d.clutchAssist || d.autoShift ? 'Auto-clutch' : 'Auto-clutch off: the clutch is yours';
    }
    // steering assist: keyboard only (a pad or touch steers with its own curve)
    const sa = v.steerAssist, analog = this.device === 'pad' || this.device === 'touch';
    this.tell(e.tSteer, 'tSteer', analog ? 'na' : sa === 'off' ? 'off' : v.steerLimited > 0 ? 'act' : 'on');
    const lvl = sa === 'strong' ? 2 : sa === 'light' ? 1 : 0;
    if (lvl !== c.steerLvl) { c.steerLvl = lvl; e.tSteer.dataset.lvl = lvl; e.tSteer.title = `Steering assist: ${sa}`; }
    this.tell(e.tTc, 'tTc', !v.tc ? 'off' : v.tcActive > 0 ? 'act' : 'on');
    this.tell(e.tAbs, 'tAbs', !v.abs ? 'off' : v.absActive > 0 ? 'act' : 'on');
    const head = view.lights.head;
    this.tellIcon(e.tHead, 'headIcon', head === 2 ? 'highBeam' : 'lowBeam');
    this.tell(e.tHead, 'tHead', head === 2 ? 'blue' : head === 1 ? 'green' : '');
    const hasAux = hasControl('auxLights');
    if (hasAux !== c.hasAux) { c.hasAux = hasAux; e.tAux.hidden = !hasAux; }
    this.tell(e.tAux, 'tAux', view.lights.aux ? 'green' : '');
    this.tell(e.tHaz, 'tHaz', view.lights.hazard ? 'haz' : '');
    // friends: only in a room; a ghost while trucks pass through each other
    const mp = ctx.mp, mpKey = mp ? `${mp.solid ? 's' : 'g'}${mp.n}` : '';
    if (mpKey !== c.mp) {
      c.mp = mpKey;
      e.tMp.hidden = !mp;
      if (mp) { e.tMp.innerHTML = icon(mp.solid ? 'people' : 'ghost') + `<b>${mp.n}</b>`; e.tMp.className = 'tt mp' + (mp.n ? ' on' : ''); e.tMp.title = `${mp.n} friend${mp.n === 1 ? '' : 's'} · ${mp.solid ? 'solid trucks' : 'ghost trucks'}`; }
    }
  }

  updateDiffs(v) {
    const d = v.drivetrain, e = this.e, c = this.c;
    const nA = v.axles.length;
    if (nA !== c.nA) {
      c.nA = nA; c.locks = undefined; c.driven = undefined;
      const svg = this.root.querySelector('#h-diffs');
      svg.innerHTML = diffSvg(nA);
      e.diffs = [...svg.querySelectorAll('.df')];
      e.wheels = [...svg.querySelectorAll('.w')];
      for (let i = 0; i < e.wheels.length; i++) c['w' + i] = undefined;
      // diff order: 2 axles = front, centre, rear; more = the axles, then the centre
      e.axleDf = a => nA === 2 ? e.diffs[a === 0 ? 0 : 2] : e.diffs[a];
      e.centreDf = e.diffs[nA === 2 ? 1 : nA];
      d.layout.axles.forEach((ax, a) => e.axleDf(a).classList.toggle('lsd', ax.diff === 'lsd'));
      e.centreDf.classList.toggle('lsd', d.layout.centre === 'viscous');
    }
    const driven = d.layout.axles.reduce((m, ax, a) => m | (d.isDriven(a) ? 1 << a : 0), 0) | (d.layout.centre === 'none' || d.rwd ? 0 : 1 << 16);
    if (driven !== c.driven) {
      c.driven = driven;
      d.layout.axles.forEach((ax, a) => e.axleDf(a).classList.toggle('off', !d.isDriven(a)));
      e.centreDf.classList.toggle('off', !(driven >> 16));
    }
    let locks = d.centreLocked ? 1 : 0;
    d.locks.forEach((l, a) => { if (l) locks |= 2 << a; });
    if (locks !== c.locks) {
      c.locks = locks;
      d.locks.forEach((l, a) => e.axleDf(a).classList.toggle('locked', l));
      e.centreDf.classList.toggle('locked', d.centreLocked);
    }
    for (let i = 0; i < e.wheels.length; i++) {
      const w = v.wheels[i];
      const st = !w.contact ? 'w air' : (w.slipNorm || 0) > 0.95 ? 'w slip' : (w.slipNorm || 0) > 0.7 ? 'w warn' : 'w';
      if (st !== c['w' + i]) { c['w' + i] = st; e.wheels[i].setAttribute('class', st); }
    }
  }

  bar(el, k, val) {
    const q = Math.round(clamp(val, 0, 1) * 100);
    if (q === this.c[k]) return;
    this.c[k] = q;
    el.style.transform = `scaleY(${q / 100})`;
  }
  rpmBar(rpm, E) {
    const q = Math.round(clamp(rpm / dialMax(E), 0, 1) * 100);
    if (q !== this.c.rpmQ) { this.c.rpmQ = q; this.e.rpmBar.style.transform = `scaleX(${q / 100})`; }
    const zone = rpm >= E.redlineRpm ? 'red' : rpm >= E.redlineRpm - 700 ? 'amber' : '';
    if (zone !== this.c.rpmZone) { this.c.rpmZone = zone; this.e.rpmBar.className = zone; }
  }

  // ------------------------------------------------------------------ tips
  updateTips(dt, v, raw) {
    const d = v.drivetrain, ts = this.tipState, k = id => capsHTML(id, this.device);
    const sp = Math.abs(v.speed);
    const thr = raw.throttle || 0;
    const inGear = d.mode === 'manual' ? d.manualGear !== 0 : (d.selector === 'D' || d.selector === 'R');
    const grow = (name, cond) => { ts[name] = cond ? ts[name] + dt : 0; return ts[name]; };
    const rolled = grow('rolled', v.up.y < 0.35);
    const engine = grow('engine', !d.running && !d.cranking);
    const neutral = grow('neutral', d.running && !inGear && thr > 0.5 && (d.mode === 'manual' || sp > 0.8));
    const stuck = grow('stuck', d.running && inGear && thr > 0.6 && sp < 0.6 && v.up.y > 0.35);
    let key = null, html = '';
    if (rolled > 1.0) { key = 'rolled'; html = `Rolled over · ${k('recover')} puts the truck back on its wheels`; }
    else if (engine > 0.6) { key = 'engine'; html = `Engine ${d.stalled ? 'stalled' : 'off'} · ${k('engineStart')} starts it`; }
    else if (neutral > 1.2) { key = 'neutral'; html = d.mode === 'manual' ? `Neutral · ${k('shiftUp')} 1st, ${k('shiftDown')} reverse` : `Selector in ${d.selector} · ${k('shiftUp')} for Drive${d.selector === 'P' ? ` (reverse: ${k('shiftUp')} once)` : ''}`; }
    else if (stuck > 3) {
      const s = [];
      if (d.rwd) s.push(`${k('rwd')} 4WD`);
      if (d.range === 'high' && d.P.transfer.low) s.push(`${k('range')} low range`);
      if (!d.centerLock && d.canLockCentre) s.push(`${k('centreLock')} centre lock`);
      if (d.canLock && !(d.rearLock && d.frontLock)) s.push(`${k('lockers')} lockers`);
      key = 'stuck:' + s.length;
      html = `Stuck? ${s.length ? s.join(' · ') + ' · or' : 'Another line, or'} ${k('recover')} recover`;
    }
    if (!key && ts.key) { if ((ts.clear += dt) < 0.75) return; }   // hysteresis: don't flicker
    ts.clear = 0;
    this.setTip(key, html);
  }

  // ------------------------------------------------------------------ rpm dial
  drawDial(rpm, E) {
    const max = dialMax(E), scale = `${max} ${E.redlineRpm}`;
    if (scale !== this.dialScale) { this.dialScale = scale; this.dialStatic = null; this.c.rpmQ = undefined; }
    const q = Math.round(rpm / 20);
    if (q === this.c.rpmQ) return;
    this.c.rpmQ = q;
    const g = this.dctx, px = this.e.dial.width, k = px / DIAL;
    const cx = DIAL / 2, cy = DIAL / 2, r = DIAL / 2 - 6;
    const ang = x => A0 + (A1 - A0) * clamp(x, 0, max) / max;
    if (!this.dialStatic) {
      const s = document.createElement('canvas');
      s.width = s.height = px;
      const h = s.getContext('2d');
      h.scale(k, k);
      h.lineWidth = 3;
      h.strokeStyle = 'rgba(255,255,255,0.12)';
      h.beginPath(); h.arc(cx, cy, r, A0, A1); h.stroke();
      h.strokeStyle = 'rgba(255,77,61,0.75)';
      h.beginPath(); h.arc(cx, cy, r, ang(E.redlineRpm), A1); h.stroke();
      h.lineCap = 'round';
      for (let x = 0; x <= max; x += 500) {
        const a = ang(x), major = x % 1000 === 0;
        const r0 = r - (major ? 10 : 7), r1 = r - 4;
        h.strokeStyle = x >= E.redlineRpm ? 'rgba(255,77,61,0.9)' : major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
        h.lineWidth = major ? 1.6 : 1.1;
        h.beginPath(); h.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); h.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); h.stroke();
        if (major) {
          h.fillStyle = x >= E.redlineRpm ? 'rgba(255,90,75,0.95)' : 'rgba(255,255,255,0.55)';
          h.font = '600 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
          h.textAlign = 'center'; h.textBaseline = 'middle';
          h.fillText(String(x / 1000), cx + Math.cos(a) * (r - 19), cy + Math.sin(a) * (r - 19));
        }
      }
      this.dialStatic = s;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.drawImage(this.dialStatic, 0, 0);
    g.setTransform(k, 0, 0, k, 0, 0);
    g.lineWidth = 4;
    g.lineCap = 'butt';
    g.strokeStyle = rpm >= E.redlineRpm ? RED : rpm >= E.redlineRpm - 700 ? AMBER : '#ffffff';
    g.beginPath(); g.arc(cx, cy, r, A0, ang(rpm)); g.stroke();
  }

  // ------------------------------------------------------------------ turret: gun panel + gunner's sight
  // g: { gunnery, sight (gunner's view), fov (deg), locked (pointer locked) } or null
  updateGun(v, g) {
    const e = this.e, c = this.c, T = v.turret;
    const show = !!(T && g);
    if (show !== c.gunShow) { c.gunShow = show; e.gun.hidden = !show; if (!show) { e.sight.hidden = true; c.sightKey = null; } }
    if (!show) return;
    const S = T.spec;
    if (c.gunRowsFor !== S) {
      c.gunRowsFor = S;
      e.gunRows.innerHTML = S.weapons.map((w, i) => `<div class="gb-row" data-w="${i}"><b>${w.short}</b><span class="gb-cal">${w.calibre}</span><span class="gb-ammo">0</span><span class="gb-res">/ 0</span><i class="gb-rl"><i></i></i></div>`).join('');
      c.gunRow = [...e.gunRows.children].map(r => ({ r, ammo: r.querySelector('.gb-ammo'), res: r.querySelector('.gb-res'), rl: r.querySelector('.gb-rl > i'), k: {} }));
    }
    T.guns.forEach((gun, i) => {
      const row = c.gunRow[i], w = S.weapons[i], k = row.k;
      const on = i === T.weapon;
      if (k.on !== on) { k.on = on; row.r.classList.toggle('on', on); }
      if (k.belt !== gun.belt) { k.belt = gun.belt; row.ammo.textContent = gun.belt; }
      if (k.res !== gun.reserve) { k.res = gun.reserve; row.res.textContent = '/ ' + gun.reserve; }
      const rl = gun.reload > 0 ? 1 - gun.reload / w.reload : -1;
      const q = Math.round(rl * 40);
      if (k.rl !== q) { k.rl = q; row.r.classList.toggle('reloading', rl >= 0); row.rl.style.transform = `scaleX(${Math.max(0, rl).toFixed(3)})`; }
    });
    const yawQ = Math.round(T.yaw * 180 / Math.PI);
    if (yawQ !== c.gunYaw) { c.gunYaw = yawQ; e.gunRot.setAttribute('transform', `rotate(${yawQ} 22 22)`); }
    const el = Math.round(T.pitch * 180 / Math.PI);
    if (el !== c.gunEl) { c.gunEl = el; e.gunElev.textContent = `${el > 0 ? '+' : ''}${el}°`; }
    e.sight.hidden = !g.sight;
    if (!g.sight) return;
    const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = `${W}x${H}@${dpr}|${g.fov.toFixed(1)}|${T.weapon}`;
    if (key !== c.sightKey) { c.sightKey = key; this.drawSight(W, H, dpr, g.fov, g.gunnery.marks[T.weapon], S.weapons[T.weapon]); }
  }

  // PP-61AM style reticle: chevron on the bore line, mil ticks for leads, range marks below (where the
  // round lands at each range, from the gun's ballistics)
  drawSight(W, H, dpr, fovDeg, marks, w) {
    const cv = this.e.sight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, tanH = Math.tan(fovDeg * Math.PI / 360);
    const px = a => Math.tan(a) / tanH * (H / 2);   // rad -> px from the centre
    const r = Math.min(W, H) * 0.47;
    g.fillStyle = 'rgba(4, 6, 8, 0.82)';
    g.beginPath(); g.rect(0, 0, W, H); g.arc(cx, cy, r, 0, Math.PI * 2, true); g.fill();
    const ring = g.createRadialGradient(cx, cy, r * 0.86, cx, cy, r);
    ring.addColorStop(0, 'rgba(0,0,0,0)'); ring.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = ring; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    const stroke = (draw, lw = 1.6) => {
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = lw + 2; g.beginPath(); draw(); g.stroke();
      g.strokeStyle = 'rgba(10,12,14,0.95)'; g.lineWidth = lw; g.beginPath(); draw(); g.stroke();
    };
    const mil = 0.001, k5 = px(5 * mil);
    // chevron tip on the bore line (boresighted at 600 m)
    stroke(() => { g.moveTo(cx - 9, cy + 9); g.lineTo(cx, cy); g.lineTo(cx + 9, cy + 9); }, 2);
    const half = r * 0.82;
    stroke(() => {
      g.moveTo(cx - half, cy); g.lineTo(cx - 3 * k5, cy); g.moveTo(cx + 3 * k5, cy); g.lineTo(cx + half, cy);
      for (let i = 1; i * k5 < half; i++) for (const sgn of [-1, 1]) { const x = cx + sgn * i * k5, t = i % 2 ? 4 : 8; if (i < 3) continue; g.moveTo(x, cy - t); g.lineTo(x, cy + t); }
    });
    g.font = '600 11px ui-sans-serif, system-ui, sans-serif'; g.textBaseline = 'middle';
    // ticks >= 4 px apart, labels >= 11 px (a flat-shooting gun packs them: then only full and half km get a number)
    let lastTick = cy + 9, lastLabel = cy + 9;
    for (const m of marks) {
      const y = cy + px(m.a);
      if (y - lastTick < 4) continue;
      const major = m.d % 500 === 0, len = major ? 12 : 7;
      stroke(() => { g.moveTo(cx - len, y); g.lineTo(cx + len, y); }, 1.4);
      lastTick = y;
      if (y - lastLabel < 11 || (!major && y - lastLabel < 16)) continue;
      g.fillStyle = 'rgba(10,12,14,0.95)'; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2.5;
      const label = String(m.d / 100);
      g.strokeText(label, cx + len + 4, y); g.fillText(label, cx + len + 4, y);
      lastLabel = y;
    }
    g.font = '700 12px ui-sans-serif, system-ui, sans-serif'; g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(230,235,240,0.85)';
    g.fillText(`${w.name} · ${Math.round(fovDeg)}° · range × 100 m`, cx - r * 0.6, cy + r * 0.82);
  }

  // ------------------------------------------------------------------ chassis panel
  // Top-down: each tyre filled by its load and outlined by its slip (amber near the limit, red sliding,
  // dashed in the air), the suspension travel beside it (red at the bump stop or full droop), load in kg
  // and tyre squash in cm. Below: axle twist, and the lean (roll, pitch) as a truck from behind and the side.
  drawSuspension(v) {
    // quantised to what the panel shows (kg, mm, % travel, slip colour, steer, load shade, twist, lean)
    const nW = v.wheels.length, nA = v.axles.length, nq = nW * 6 + nA + 2;
    if (!this.suspKey || this.suspKey.length !== nq) { this.suspKey = new Int32Array(nq); this.suspPrev = new Int32Array(nq).fill(-1); }
    const q = this.suspKey, prev = this.suspPrev;
    // beam axle: heave and roll at the spring; independent: the corner's own
    const compOf = w => w.axle.ind ? w.c : w.axle.c + w.side * (w.axle.p.springTrack / 2) * Math.sin(w.axle.phi);
    for (let i = 0; i < nW; i++) {
      const w = v.wheels[i], ax = w.axle;
      const slip = w.slipNorm || 0;
      q[i * 6] = Math.round((w.FnAvg || 0) / 9.81);
      q[i * 6 + 1] = Math.round(Math.max(0, w.pen) * 1000);
      q[i * 6 + 2] = Math.round(clamp(compOf(w) / ax.p.travel, 0, 1) * 100);
      q[i * 6 + 3] = !w.contact ? 3 : slip > 0.95 ? 2 : slip > 0.7 ? 1 : 0;
      q[i * 6 + 4] = Math.round(w.steer * 100);
      q[i * 6 + 5] = Math.round(Math.min(1, (w.FnAvg || 0) / 12000) * 20);
    }
    for (let a = 0; a < nA; a++) q[nW * 6 + a] = Math.round(v.axles[a].phi * 573);
    const roll = Math.asin(clamp(v.right.y, -1, 1)) * DEG, pitch = Math.asin(clamp(v.fwd.y, -1, 1)) * DEG;
    q[nW * 6 + nA] = Math.round(roll); q[nW * 6 + nA + 1] = Math.round(pitch);
    if (q.every((x, i) => x === prev[i])) return;
    prev.set(q);
    const g = this.sctx, cw = g.canvas.width, k = cw / SUSP_W;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, g.canvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    const FONT = '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    const ys = Array.from({ length: nA }, (_, a) => nA === 2 ? (a ? 168 : 62) : 36 + a * (164 / (nA - 1)));
    const sc = nA === 2 ? 1 : Math.min(1, (ys[1] - ys[0]) / 76);
    const pos = Array.from({ length: nW }, (_, i) => [i % 2 ? 176 : 64, ys[i >> 1]]);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.beginPath();
    for (const y of ys) { g.moveTo(64, y); g.lineTo(176, y); }
    g.moveTo(120, ys[0]); g.lineTo(120, ys[nA - 1]); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = nA === 2 ? FONT : FONT.replace('11px', '9.5px');
    for (let i = 0; i < nW; i++) {
      const w = v.wheels[i], ax = w.axle, p = ax.p;
      const f = clamp(compOf(w) / p.travel, 0, 1);
      const [x, y] = pos[i];
      const slip = w.slipNorm || 0;
      const load = Math.min(1, (w.FnAvg || 0) / 12000);
      g.save();
      g.translate(x, y);
      g.scale(sc, sc);
      g.rotate(w.steer);
      if (w.contact) {
        g.fillStyle = `rgba(255,255,255,${(0.12 + 0.7 * load).toFixed(3)})`;
        g.beginPath(); g.roundRect(-10, -20, 20, 40, 4); g.fill();
      }
      g.lineWidth = 2;
      g.setLineDash(w.contact ? [] : [3, 3]);
      g.strokeStyle = !w.contact ? 'rgba(255,255,255,0.45)' : slip > 0.95 ? RED : slip > 0.7 ? AMBER : 'rgba(255,255,255,0.55)';
      g.beginPath(); g.roundRect(-10, -20, 20, 40, 4); g.stroke();
      g.setLineDash([]);
      g.restore();
      // travel: 0 = full droop, 1 = bump stop
      const bx = x + (w.side < 0 ? -25 : 20) * sc, bh = 40 * sc;
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(bx, y - bh / 2, 5 * sc, bh);
      g.fillStyle = f > 0.9 || f < 0.05 ? RED : 'rgba(255,255,255,0.8)';
      g.fillRect(bx, y + bh / 2 - bh * f, 5 * sc, bh * f);
      const kg = ((w.FnAvg || 0) / 9.81).toFixed(0), sq = Math.max(0, w.pen * 100).toFixed(1);
      if (nA === 2) {
        const ty = i < 2 ? y - 38 : y + 34;
        g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillText(`${kg} kg`, x, ty);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillText(`${sq} cm`, x, ty + 13);
      } else {
        const tx = x + (w.side < 0 ? -48 : 48);
        g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillText(kg, tx, y - 6);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillText(sq, tx, y + 7);
      }
    }
    g.font = FONT;
    g.fillStyle = 'rgba(255,255,255,0.55)';
    if (nA === 2) {
      const tw = a => v.axles[a].ind ? '' : `${(v.axles[a].phi * DEG).toFixed(1)}°`;
      const t = [tw(0) && `F ${tw(0)}`, tw(1) && `R ${tw(1)}`].filter(Boolean).join('   ');
      if (t) g.fillText(`twist  ${t}`, 120, 115);
    } else g.fillText('kg · cm', 120, 10);
    // lean: the truck from behind (roll) and from the side (pitch); amber from 25°, red from 35°
    g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(16, 224); g.lineTo(224, 224); g.stroke();
    const lean = (cx, deg, drawBody, label) => {
      const a = Math.abs(deg), col = a >= 35 ? RED : a >= 25 ? AMBER : 'rgba(255,255,255,0.9)';
      g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx - 44, 266); g.lineTo(cx - 8, 266); g.stroke();
      g.save(); g.translate(cx - 26, 262); g.rotate(-deg / DEG);
      g.strokeStyle = col; g.lineWidth = 1.8; g.lineJoin = 'round';
      g.beginPath(); drawBody(); g.stroke();
      g.restore();
      g.textAlign = 'left';
      g.fillStyle = col; g.font = '700 15px ui-sans-serif, system-ui, sans-serif';
      g.fillText(`${Math.round(deg) || 0}°`, cx + 2, 252);
      g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = FONT;
      g.fillText(label, cx + 2, 270);
      g.textAlign = 'center';
    };
    // from behind: body, wheels; positive roll = right side up
    lean(70, roll, () => {
      g.rect(-12, -22, 24, 13); g.moveTo(-15, -9); g.lineTo(15, -9);
      g.rect(-15, -7, 5, 7); g.rect(10, -7, 5, 7);
    }, 'roll');
    // from the side, nose to the right: positive pitch = nose up
    lean(178, -pitch, () => {
      g.moveTo(-20, -6); g.lineTo(-20, -19); g.lineTo(6, -19); g.lineTo(11, -12); g.lineTo(20, -12); g.lineTo(20, -6); g.closePath();
      g.moveTo(-9.5, -3); g.arc(-12.5, -3, 3, 0, Math.PI * 2); g.moveTo(15.5, -3); g.arc(12.5, -3, 3, 0, Math.PI * 2);
    }, 'pitch');
  }

  // ------------------------------------------------------------------ telemetry
  // A fixed grid, built once per car layout: every value has a column of fixed width (ch), right-aligned, so
  // the panel never changes size as numbers change length. Cells are written only when their text changes.
  updateTelemetry(v, extra) {
    const d = v.drivetrain, nA = v.axles.length, nW = v.wheels.length;
    if (this.teleN !== nW) {
      this.teleN = nW;
      const kv = keys => keys.map(k => `<i>${k}</i><span></span>`).join('');
      const vals = n => '<span></span>'.repeat(n);
      const propW = nA * 5 + nA - 1;   // "-1234/-1234…"
      this.e.tele.innerHTML = `
        <div class="tl-g eng" style="grid-template-columns: calc(54 * var(--u)) repeat(4, auto 7ch)"><b>Engine</b>${kv(['rpm', 'thr', 'T Nm', 'load', 'clutch', 'slip', 'lockup', 'ratio'])}</div>
        <div class="tl-g drv" style="grid-template-columns: calc(54 * var(--u)) auto ${propW}ch auto 7ch auto 5ch auto 4ch"><b>Drive</b>${kv(['prop Nm', 'km/h', 'range', 'drive'])}</div>
        <div class="tl-t w"><b></b><b>ω</b><b>Fn</b><b>Fx</b><b>Fy</b><b>slip</b><b>pen</b><b>surface</b>
          ${v.wheels.map((w, i) => `<b>${wheelName(i, nA)}</b>${vals(7)}`).join('')}</div>
        <div class="tl-t ax">${v.axles.map((a, i) => `<b>${nA === 2 ? (i ? 'R' : 'F') : i + 1}</b>${a.ind ? kv(['c', 'camber', '']) : kv(['c', 'φ', 'springs N'])}`).join('')}</div>
        <div class="tl-x"></div>`;
      const g = sel => [...this.e.tele.querySelectorAll(sel + ' span')];
      this.teleCells = { eng: g('.eng'), drv: g('.drv'), w: g('.w'), ax: g('.ax'), x: this.e.tele.querySelector('.tl-x') };
    }
    const C = this.teleCells;
    const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    const f = (x, n = 2) => x.toFixed(n);
    [d.rpm.toFixed(0), f(d.thr), d.Tcomb.toFixed(0), f(d.load), f(d.clutchPedal), f(d.clutchSlip, 1), f(d.lockup), f(d.currentRatio())].forEach((t, i) => set(C.eng[i], t));
    [d.propTorque.map(t => t.toFixed(0)).join('/'), f(v.speed * 3.6, 1), d.range, d.rwd ? '2WD' : '4WD'].forEach((t, i) => set(C.drv[i], t));
    v.wheels.forEach((w, i) => {
      const r = [f(d.w[2 + i], 1), w.FnAvg.toFixed(0), w.Fx.toFixed(0), w.Fy.toFixed(0), f(w.slipNorm || 0), f(w.pen * 100, 1), w.surf.name];
      r.forEach((t, j) => set(C.w[i * 7 + j], t));
    });
    v.axles.forEach((a, i) => {
      let r;
      if (a.ind) { const wl = v.wheels[2 * i], wr = v.wheels[2 * i + 1]; r = [`${f(wl.c, 3)} / ${f(wr.c, 3)}`, `${(wl.camber * DEG).toFixed(1)}° / ${(wr.camber * DEG).toFixed(1)}°`, '']; }
      else r = [f(a.c, 3), `${(a.phi * DEG).toFixed(1)}°`, `${a.S[0].toFixed(0)} / ${a.S[1].toFixed(0)}`];
      r.forEach((t, j) => set(C.ax[i * 3 + j], t));
    });
    set(C.x, extra || '');
  }
}

// [pattern, html(k, match), kind, key]. Anything not listed is shown as plain text.
const DT_MESSAGES = [
  [/^Engine is already running/, k => `Engine is already running · ${k('engineStop')} switches it off`, '', 'engine'],
  [/^In gear: hold the clutch/, k => `In gear: hold the clutch ${k('clutch')} or select neutral, then ${k('engineStart')}`, 'warn', 'engine'],
  [/^Engine did not start/, () => 'Engine did not start: select N or P, or press the clutch', 'warn', 'engine'],
  [/^Engine stalled/, k => `Engine stalled · ${k('engineStart')} to restart`, 'warn', 'engine'],
  [/^Starting/, () => 'Starting…', '', 'engine'],
  [/^Grind!/, k => `Grind! Use the clutch ${k('clutch')} or match the revs`, 'warn', 'shift'],
  [/^Too fast for reverse/, () => 'Too fast for reverse', 'warn', 'shift'],
  [/^Stop to change transfer range/, () => 'Stop the truck to change the transfer range', 'warn', 'range'],
  [/^Auto clutch OFF/, k => `Auto-clutch off · hold ${k('clutch')} for the clutch`, '', 'gearbox'],
  [/^Auto clutch ON/, () => 'Auto-clutch on', 'good', 'gearbox'],
  [/^Manual 5-speed \(clutch pedal/, k => `Manual 5-speed · clutch pedal on ${k('clutch')}`, '', 'gearbox'],
  [/^Manual 5-speed/, () => 'Manual 5-speed · auto-clutch', '', 'gearbox'],
  [/^Automatic/, () => 'Automatic 6-speed', '', 'gearbox'],
  [/^LOW range engaged/, () => 'Low range engaged', 'good', 'range'],
  [/^HIGH range engaged/, () => 'High range engaged', '', 'range'],
  [/^Centre diff LOCKED/, () => 'Centre diff locked', 'good', 'centre'],
  [/^Centre diff open/, () => 'Centre diff open', '', 'centre'],
  [/^Rear locker ON/, () => 'Rear locker on', 'good', 'lockers'],
  [/^Front \+ rear lockers ON/, () => 'Front and rear lockers on', 'good', 'lockers'],
  [/^Axle lockers off/, () => 'Axle lockers off', '', 'lockers'],
  [/^2WD/, () => '2WD: rear-wheel drive', '', 'rwd'],
  [/^4WD/, () => '4WD: all wheels driven', 'good', 'rwd'],
  [/^Select 4WD before LOW|^RWD only in HIGH/, k => `2WD works in HIGH range only · ${k('rwd')} for 4WD first`, 'warn', 'rwd'],
  [/^Slow down to change 2WD/, () => 'Slow down below 30 km/h to change 2WD / 4WD', 'warn', 'rwd'],
  [/^Centre lock needs 4WD/, k => `Centre lock needs 4WD · ${k('rwd')}`, 'warn', 'centre'],
];

export function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
