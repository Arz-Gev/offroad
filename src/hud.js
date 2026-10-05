import { capsHTML } from './input.js';

// In-game HUD: instrument cluster (bottom right), toasts and context tips (top centre),
// key hints + menu button (top left), optional suspension panel, telemetry and fps.
//
// Cost rules: no layout reads per frame; DOM text/classes are written only when the value changes;
// bars move with transforms; the rpm dial redraws only when the rpm moves by >= 20 rpm, on top of a
// cached static layer; the suspension panel redraws at 20 Hz and telemetry at 10 Hz, only while shown.

const SPEED_UNITS = { kmh: { k: 3.6, label: 'km/h' }, mph: { k: 2.236936, label: 'mph' } };
export const fmtPressure = (psi, unit) => unit === 'bar' ? `${(psi * 0.0689476).toFixed(2)} bar` : `${psi.toFixed(0)} psi`;
export const speedUnit = u => SPEED_UNITS[u] || SPEED_UNITS.kmh;

const AUTO_STRIP = ['P', 'R', 'N', 'D'];
const MAN_STRIP = ['R', 'N', '1', '2', '3', '4', '5'];
const DIAL = 156;          // css px at scale 1
const SUSP = 216;
const MAX_RPM = 6000;
const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const ICON_SOUND = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5c1 .8 1 4.2 0 5M12.8 4c1.9 1.6 1.9 6.4 0 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FULL_EXIT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

export class HUD {
  constructor(root = document.getElementById('hud')) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-tl">
        <div class="tl-row">
          <button class="menu-btn" id="h-menubtn" tabindex="-1" type="button" aria-label="Open menu">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <span>Menu</span><span class="kc" id="h-menukey"></span>
          </button>
          <button class="menu-btn icon" id="h-full" tabindex="-1" type="button" aria-label="Fullscreen" title="Fullscreen"></button>
          <div class="hints" id="h-hints"></div>
        </div>
        <div class="sound-pill" id="h-sound" hidden></div>
        <pre class="hud-panel telemetry" id="h-tele" hidden></pre>
      </div>
      <div class="hud-top">
        <div class="toasts" id="h-toasts" aria-live="polite"></div>
        <div class="tip" id="h-tip" hidden></div>
      </div>
      <div class="hud-fps" id="h-fps" hidden></div>
      <div class="hud-panel susp" id="h-susp" hidden>
        <div class="panel-h"><span>Suspension &amp; tyres</span><span id="h-suspkey"></span></div>
        <canvas id="h-suspcv"></canvas>
        <div class="panel-f"><span>load</span><span>tyre squash</span><span class="lg-travel">travel</span><span class="lg-slip">slip</span></div>
      </div>
      <div class="cluster" id="h-cluster">
        <div class="tells" aria-live="polite">
          <span class="tt red" id="t-eng" hidden>ENGINE OFF</span>
          <span class="tt red" id="t-hb" hidden>HANDBRAKE</span>
          <span class="tt amber" id="t-abs" hidden>ABS</span>
          <span class="tt amber" id="t-tc" hidden>TC</span>
          <span class="tt blue" id="t-rwd" hidden>2WD</span>
          <span class="tt green" id="t-head" hidden>LOW BEAM</span>
          <span class="tt amber" id="t-bar" hidden>LIGHT BAR</span>
          <span class="tt amber blink" id="t-haz" hidden>HAZARDS</span>
        </div>
        <div class="cl-body">
          <div class="cl-side">
            <div class="cl-mode"><b id="h-mode">AUTO</b><span id="h-modesub"></span></div>
            <div class="strip" id="h-strip"></div>
            <div class="cl-kv"><span class="k">Range</span><span class="seg2" id="h-range"><i data-v="high">HI</i><i data-v="low">LO</i></span></div>
            <div class="cl-diffs">
              <svg id="h-diffs" viewBox="0 0 64 72" aria-hidden="true">
                <path class="shaft" d="M14 13H50M14 59H50M32 13V59"/>
                <rect class="w" x="3" y="4" width="11" height="18" rx="2.5"/>
                <rect class="w" x="50" y="4" width="11" height="18" rx="2.5"/>
                <rect class="w" x="3" y="50" width="11" height="18" rx="2.5"/>
                <rect class="w" x="50" y="50" width="11" height="18" rx="2.5"/>
                <circle class="df" cx="32" cy="13" r="5.5"/>
                <circle class="df" cx="32" cy="36" r="5.5"/>
                <circle class="df" cx="32" cy="59" r="5.5"/>
              </svg>
              <div class="diff-txt"><span class="k">Diffs</span><b id="h-difftxt">Open</b></div>
            </div>
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
          <div class="pedals" title="Throttle · brake · clutch">
            <div class="pedal"><div class="pd thr"><i id="p-thr"></i></div><b>T</b></div>
            <div class="pedal"><div class="pd brk"><i id="p-brk"></i></div><b>B</b></div>
            <div class="pedal" id="p-cluwrap"><div class="pd clu"><i id="p-clu"></i></div><b>C</b></div>
          </div>
        </div>
        <div class="cl-foot">
          <span id="h-psi"></span><span class="sep"></span><span id="h-surf"></span>
        </div>
      </div>`;
    const $ = id => root.querySelector('#' + id);
    this.$ = $;
    this.e = {
      menuBtn: $('h-menubtn'), fullBtn: $('h-full'), menuKey: $('h-menukey'), hints: $('h-hints'), sound: $('h-sound'),
      toasts: $('h-toasts'), tip: $('h-tip'), fps: $('h-fps'), tele: $('h-tele'), susp: $('h-susp'), suspKey: $('h-suspkey'),
      cluster: $('h-cluster'), mode: $('h-mode'), modeSub: $('h-modesub'), strip: $('h-strip'), range: $('h-range'),
      diffs: [...root.querySelectorAll('#h-diffs .df')], wheels: [...root.querySelectorAll('#h-diffs .w')], diffTxt: $('h-difftxt'),
      dial: $('h-dial'), spd: $('h-spd'), unit: $('h-unit'), gear: $('h-gear'), rpmBar: $('h-rpmbar'),
      thr: $('p-thr'), brk: $('p-brk'), clu: $('p-clu'), cluWrap: $('p-cluwrap'),
      psi: $('h-psi'), surf: $('h-surf'),
      tEng: $('t-eng'), tHb: $('t-hb'), tAbs: $('t-abs'), tTc: $('t-tc'), tRwd: $('t-rwd'), tHead: $('t-head'), tBar: $('t-bar'), tHaz: $('t-haz'),
    };
    this.dctx = this.e.dial.getContext('2d');
    this.sctx = $('h-suspcv').getContext('2d');
    this.c = {};                       // last written values
    this.opts = { speedUnit: 'kmh', pressureUnit: 'psi', cluster: 'auto', hudScale: 1, hints: true, suspension: false, telemetry: false, fps: false };
    this.device = 'kb';
    this.touchUI = false;              // on-screen touch controls shown (touch.js)
    this.toastList = [];
    this.tipState = { key: null, rolled: 0, stuck: 0, neutral: 0, engine: 0, clear: 0, acc: 0 };
    this.fpsAcc = 0; this.fpsN = 0; this.suspAcc = 1; this.teleAcc = 1;
    this.soundState = 'locked';
    this.onMenu = null;
    this.onFullscreen = null;
    for (const b of [this.e.menuBtn, this.e.fullBtn]) b.addEventListener('mousedown', e => e.preventDefault());   // never take keyboard focus
    this.e.menuBtn.addEventListener('click', () => this.onMenu && this.onMenu());
    this.e.fullBtn.addEventListener('click', () => this.onFullscreen && this.onFullscreen());
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
    this.c.spd = this.c.psi = undefined;        // units may have changed
    this.e.unit.textContent = speedUnit(o.speedUnit).label;
    this.resize();
  }

  resize() {
    const W = window.innerWidth || 1440, H = window.innerHeight || 900;
    // square root: the HUD shrinks slower than the window, so text stays readable in small windows
    const s = clamp(Math.sqrt(Math.min(W / 1600, H / 1000)), 0.8, 1.4) * (this.opts.hudScale || 1);
    if (s === this.scale && W === this.W && H === this.H) return;
    this.scale = s; this.W = W; this.H = H;
    this.small = H < 560 || W < 760;
    this.root.style.setProperty('--s', s.toFixed(3));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const dp = Math.max(32, Math.round(DIAL * s * dpr));
    this.e.dial.width = this.e.dial.height = dp;
    this.dialStatic = null; this.c.rpmQ = undefined;
    const sp = Math.max(32, Math.round(SUSP * s * dpr));
    const scv = this.sctx.canvas; scv.width = scv.height = sp;
    this.suspAcc = 1; if (this.suspPrev) this.suspPrev.fill(-1);
    this.c.compact = undefined;
  }

  setDevice(d, force) {
    if (d === this.device && !force) return;
    this.device = d;
    const k = id => capsHTML(id, d);
    this.e.menuKey.innerHTML = d === 'touch' ? '' : k('menu');
    this.e.hints.innerHTML = d === 'touch' ? '' : d === 'pad'
      ? `<span>${k('camera')} Camera</span><span>${k('recover')} Recover</span><span>${k('shiftUp')}${k('shiftDown')} Shift</span>`
      : `<span>${k('controls')} Controls</span><span>${k('locations')} Locations</span><span>${k('camera')} Camera</span><span>${k('tuning')} Tuning</span><span>${k('recover')} Recover</span>`;
    this.e.suspKey.innerHTML = capsHTML('suspension', 'kb');
    this.tipState.key = null;           // re-render the tip with the new prompts
    this.setSound(this.soundState, true);
  }

  // fullscreen button: hidden where pages can't go fullscreen (iPhone Safari: Add to Home Screen does it)
  // and in the installed app, which already is
  refreshFullscreen() {
    const standalone = window.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches;
    const on = !!document.fullscreenElement, b = this.e.fullBtn;
    b.hidden = !document.fullscreenEnabled || standalone;
    b.innerHTML = on ? ICON_FULL_EXIT : ICON_FULL;
    b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    b.title = on ? 'Exit fullscreen' : 'Fullscreen';
  }

  // touch controls on screen: compact cluster at the top right (ui.css body.touch-ui), no key hints
  setTouch(on) {
    this.touchUI = on;
    this.c.compact = undefined;
    this.setDevice(this.device, true);
  }

  // sound status pill: 'locked' (waiting for a gesture), 'on', 'muted', 'error'
  setSound(state, force) {
    if (state === this.soundState && !force) return;
    this.soundState = state;
    const el = this.e.sound;
    el.className = 'sound-pill ' + state;
    if (state === 'on') { el.hidden = true; return; }
    el.hidden = false;
    const touch = this.device === 'touch';
    el.innerHTML = state === 'locked' ? `${ICON_SOUND}<span>${touch ? 'Tap the screen to turn on sound' : 'Click or press a key to turn on sound'}</span>`
      : state === 'muted' ? `${ICON_MUTED}<span>Sound off</span>${touch ? '' : capsHTML('mute', 'kb')}`
        : `${ICON_MUTED}<span>Sound unavailable</span>`;
  }

  // ------------------------------------------------------------------ toasts
  // kind: '' | 'good' | 'warn'. html may contain <kbd> caps.
  // key: a toast with the same key is updated in place (repeated presses of [ or L don't stack up).
  // Newest at the bottom; at most 3 on screen.
  toast(html, { t = 2.4, kind = '', key = html } = {}) {
    const same = this.toastList.find(x => x.key === key && !x.leaving);
    if (same) {
      same.t = t;
      if (same.html !== html) { same.html = html; same.el.innerHTML = html; }
      same.el.className = 'toast' + (kind ? ' ' + kind : '');
      same.el.animate?.([{ transform: 'scale(1.04)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
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

  // The drivetrain speaks in plain text with keyboard keys baked in ("press I", "(Shift)").
  // Rewrite the known ones with key caps for the current device and give them a severity.
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
  // ctx: { cam, paused, raw, telemetry: () => string }
  update(dt, v, view, ctx = {}) {
    const d = v.drivetrain, e = this.e, c = this.c, o = this.opts;
    this.tickToasts(dt);
    if (d.message && d.message !== this._lastMsg) this.drivetrainToast(d.message.text);
    this._lastMsg = d.message;

    // cluster layout
    const compact = o.cluster === 'compact' || (o.cluster === 'auto' && (ctx.cam === 'cockpit' || this.small || this.touchUI));
    if (compact !== c.compact) { c.compact = compact; e.cluster.classList.toggle('compact', compact); c.rpmQ = undefined; }

    // gearbox mode + selector strip
    const manual = d.mode === 'manual';
    const modeKey = manual ? (d.clutchAssist ? 'mac' : 'm') : 'a';
    if (modeKey !== c.mode) {
      c.mode = modeKey; c.stripIdx = undefined;
      e.mode.textContent = manual ? 'MANUAL' : 'AUTO';
      e.modeSub.textContent = manual ? (d.clutchAssist ? 'auto-clutch' : 'clutch pedal') : '6-speed';
      e.strip.innerHTML = (manual ? MAN_STRIP : AUTO_STRIP).map(g => `<i>${g}</i>`).join('');
      e.cluWrap.classList.toggle('off', !(manual && !d.clutchAssist));
    }
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

    // transfer case + diffs
    if (d.range !== c.range) { c.range = d.range; e.range.dataset.v = d.range; }
    const locks = (d.frontLock ? 1 : 0) | (d.centerLock ? 2 : 0) | (d.rearLock ? 4 : 0);
    if (locks !== c.locks) {
      c.locks = locks;
      e.diffs[0].classList.toggle('locked', d.frontLock);
      e.diffs[1].classList.toggle('locked', d.centerLock);
      e.diffs[2].classList.toggle('locked', d.rearLock);
      const names = [d.centerLock && 'Centre', d.frontLock && 'Front', d.rearLock && 'Rear'].filter(Boolean);
      // short enough for one line; the icon shows exactly which diff is locked
      e.diffTxt.textContent = names.length === 3 ? 'All locked' : names.length === 2 ? names.join(' + ').replace('Centre', 'Ctr').replace('+ Rear', '+ rear').replace('+ Front', '+ front') : names[0] || 'Open';
      e.diffTxt.classList.toggle('locked', names.length > 0);
    }
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const st = !w.contact ? 'w air' : (w.slipNorm || 0) > 0.95 ? 'w slip' : (w.slipNorm || 0) > 0.7 ? 'w warn' : 'w';
      if (st !== c['w' + i]) { c['w' + i] = st; e.wheels[i].setAttribute('class', st); }
    }

    // speed + rpm
    const su = speedUnit(o.speedUnit);
    const spd = Math.round(Math.abs(v.speed) * su.k);
    if (spd !== c.spd) { c.spd = spd; e.spd.textContent = spd; }
    if (!compact) this.drawDial(Math.max(0, d.rpm), v.P.engine);
    else this.rpmBar(Math.max(0, d.rpm), v.P.engine);

    // pedals
    this.bar(e.thr, 'thr', v.ctl.throttle);
    this.bar(e.brk, 'brk', Math.max(v.ctl.brake, v.ctl.handbrake));
    this.bar(e.clu, 'clu', manual ? clamp(d.clutchPedal / 0.8, 0, 1) : 0);

    // footer: tyres, surface, warning lamps
    const psi = fmtPressure(v.pressure, o.pressureUnit);
    if (psi !== c.psi) { c.psi = psi; e.psi.textContent = 'Tyres ' + psi; }
    let surf = 'Airborne';
    for (const w of v.wheels) if (w.contact) { surf = w.surf?.name || 'Ground'; break; }
    if (surf !== c.surf) { c.surf = surf; e.surf.textContent = surf; }
    const eng = d.running ? '' : d.cranking ? 'CRANKING' : d.stalled ? 'STALLED' : 'ENGINE OFF';
    if (eng !== c.eng) { c.eng = eng; e.tEng.hidden = !eng; if (eng) { e.tEng.textContent = eng; e.tEng.className = 'tt ' + (d.cranking ? 'amber' : 'red'); } }
    this.lamp(e.tHb, 'hb', v.ctl.handbrake > 0.5);
    const abs = !v.abs ? 'ABS OFF' : v.absActive > 0 ? 'ABS' : '';
    if (abs !== c.abs) { c.abs = abs; e.tAbs.hidden = !abs; if (abs) e.tAbs.textContent = abs; }
    this.lamp(e.tRwd, 'rwd', d.rwd);
    const tc = !v.tc ? 'TC OFF' : v.tcActive > 0 ? 'TC' : '';
    if (tc !== c.tc) { c.tc = tc; e.tTc.hidden = !tc; if (tc) e.tTc.textContent = tc; }
    const head = view.lights.head;
    if (head !== c.head) {
      c.head = head; e.tHead.hidden = !head;
      e.tHead.textContent = head === 2 ? 'HIGH BEAM' : 'LOW BEAM';
      e.tHead.className = 'tt ' + (head === 2 ? 'blue' : 'green');
    }
    this.lamp(e.tBar, 'bar', view.lights.bar);
    this.lamp(e.tHaz, 'haz', view.lights.hazard);

    // context tips (4 Hz)
    if (ctx.paused) this.setTip(null);
    else if ((this.tipState.acc += dt) > 0.25) { this.updateTips(this.tipState.acc, v, ctx.raw || v.ctl); this.tipState.acc = 0; }

    // optional panels
    if (o.suspension && (this.suspAcc += dt) > 0.05) { this.suspAcc = 0; this.drawSuspension(v); }
    if (o.telemetry && (this.teleAcc += dt) > 0.1) { this.teleAcc = 0; e.tele.textContent = this.telemetryText(v, ctx.telemetry ? ctx.telemetry() : ''); }
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { if (o.fps) e.fps.textContent = (this.fpsN / this.fpsAcc).toFixed(0) + ' fps'; this.fpsAcc = 0; this.fpsN = 0; }
  }

  bar(el, k, val) {
    const q = Math.round(clamp(val, 0, 1) * 100);
    if (q === this.c[k]) return;
    this.c[k] = q;
    el.style.transform = `scaleY(${q / 100})`;
  }
  rpmBar(rpm, E) {
    const q = Math.round(clamp(rpm / MAX_RPM, 0, 1) * 100);
    if (q !== this.c.rpmQ) { this.c.rpmQ = q; this.e.rpmBar.style.transform = `scaleX(${q / 100})`; }
    const zone = rpm >= E.redlineRpm ? 'red' : rpm >= E.redlineRpm - 700 ? 'amber' : '';
    if (zone !== this.c.rpmZone) { this.c.rpmZone = zone; this.e.rpmBar.className = zone; }
  }
  lamp(el, k, on) { if (on !== this.c[k]) { this.c[k] = on; el.hidden = !on; } }

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
    if (rolled > 1.0) { key = 'rolled'; html = `Rolled over. Press ${k('recover')} to put the truck back on its wheels.`; }
    else if (engine > 0.6) { key = 'engine'; html = `Engine ${d.stalled ? 'stalled' : 'off'}. Press ${k('engineStart')} to start it.`; }
    else if (neutral > 1.2) { key = 'neutral'; html = d.mode === 'manual' ? `Gearbox in neutral. Press ${k('shiftUp')} for 1st, ${k('shiftDown')} for reverse.` : `Selector in ${d.selector}. Press ${k('shiftUp')} for Drive${d.selector === 'P' ? ` (reverse: ${k('shiftUp')} once)` : ''}.`; }
    else if (stuck > 3) {
      const s = [];
      if (d.range === 'high') s.push(`${k('range')} low range`);
      if (!d.centerLock) s.push(`${k('centreLock')} centre lock`);
      if (!(d.rearLock && d.frontLock)) s.push(`${k('lockers')} lockers`);
      key = 'stuck:' + s.length;
      html = `Stuck? ${s.length ? 'Try ' + s.join(', ') + ', or' : 'Pick another line, or'} ${k('recover')} to recover.`;
    }
    if (!key && ts.key) { if ((ts.clear += dt) < 0.75) return; }   // hysteresis: don't flicker
    ts.clear = 0;
    this.setTip(key, html);
  }

  // ------------------------------------------------------------------ rpm dial
  drawDial(rpm, E) {
    const q = Math.round(rpm / 20);
    if (q === this.c.rpmQ) return;
    this.c.rpmQ = q;
    const g = this.dctx, px = this.e.dial.width, k = px / DIAL;
    const cx = DIAL / 2, cy = DIAL / 2, r = DIAL / 2 - 9;
    const ang = x => A0 + (A1 - A0) * clamp(x, 0, MAX_RPM) / MAX_RPM;
    if (!this.dialStatic) {
      const s = document.createElement('canvas');
      s.width = s.height = px;
      const h = s.getContext('2d');
      h.scale(k, k);
      h.lineWidth = 7;
      h.strokeStyle = 'rgba(255,255,255,0.11)';
      h.beginPath(); h.arc(cx, cy, r, A0, A1); h.stroke();
      h.strokeStyle = 'rgba(255,90,69,0.6)';
      h.beginPath(); h.arc(cx, cy, r, ang(E.redlineRpm), A1); h.stroke();
      h.lineCap = 'round';
      for (let x = 0; x <= MAX_RPM; x += 500) {
        const a = ang(x), major = x % 1000 === 0;
        const r0 = r - (major ? 15 : 11), r1 = r - 7;
        h.strokeStyle = x >= E.redlineRpm ? 'rgba(255,110,90,0.9)' : major ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)';
        h.lineWidth = major ? 1.8 : 1.2;
        h.beginPath(); h.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); h.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); h.stroke();
        if (major) {
          h.fillStyle = x >= E.redlineRpm ? 'rgba(255,120,100,0.95)' : 'rgba(255,255,255,0.62)';
          h.font = '600 10.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
          h.textAlign = 'center'; h.textBaseline = 'middle';
          h.fillText(String(x / 1000), cx + Math.cos(a) * (r - 25), cy + Math.sin(a) * (r - 25));
        }
      }
      this.dialStatic = s;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.drawImage(this.dialStatic, 0, 0);
    g.setTransform(k, 0, 0, k, 0, 0);
    g.lineWidth = 7;
    g.lineCap = 'butt';
    g.strokeStyle = rpm >= E.redlineRpm ? '#ff5a45' : rpm >= E.redlineRpm - 700 ? '#ffb347' : '#f4f6f8';
    g.beginPath(); g.arc(cx, cy, r, A0, ang(rpm)); g.stroke();
  }

  // ------------------------------------------------------------------ suspension panel
  drawSuspension(v) {
    // quantised to what the panel can show (kg, mm, % travel, slip colour, steer, 0.1 deg twist)
    const q = this.suspKey || (this.suspKey = new Int32Array(26)), prev = this.suspPrev || (this.suspPrev = new Int32Array(26).fill(-1));
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i], ax = w.axle;
      const comp = ax.c + w.side * (ax.p.springTrack / 2) * Math.sin(ax.phi);
      const slip = w.slipNorm || 0;
      q[i * 6] = Math.round((w.FnAvg || 0) / 9.81);
      q[i * 6 + 1] = Math.round(Math.max(0, w.pen) * 1000);
      q[i * 6 + 2] = Math.round(clamp(comp / ax.p.travel, 0, 1) * 100);
      q[i * 6 + 3] = !w.contact ? 3 : slip > 0.95 ? 2 : slip > 0.7 ? 1 : 0;
      q[i * 6 + 4] = Math.round(w.steer * 100);
      q[i * 6 + 5] = Math.round(Math.min(1, (w.FnAvg || 0) / 12000) * 20);
    }
    q[24] = Math.round(v.axles[0].phi * 573); q[25] = Math.round(v.axles[1].phi * 573);
    if (q.every((x, i) => x === prev[i])) return;
    prev.set(q);
    const g = this.sctx, px = g.canvas.width, k = px / 240;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.setTransform(k, 0, 0, k, 0, 0);
    const pos = [[62, 70], [178, 70], [62, 172], [178, 172]];
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(62, 70); g.lineTo(178, 70); g.moveTo(62, 172); g.lineTo(178, 172); g.moveTo(120, 70); g.lineTo(120, 172); g.stroke();
    g.font = '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i], ax = w.axle, p = ax.p;
      const comp = ax.c + w.side * (p.springTrack / 2) * Math.sin(ax.phi);
      const f = clamp(comp / p.travel, 0, 1);
      const [x, y] = pos[i];
      const slip = Math.min(1, w.slipNorm || 0);
      const load = Math.min(1, (w.FnAvg || 0) / 12000);
      const col = !w.contact ? 'rgba(140,140,140,0.55)' : slip > 0.95 ? '#ff5a45' : slip > 0.7 ? '#ffb347' : '#6fdc8c';
      g.save();
      g.translate(x, y);
      g.rotate(w.steer);
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(-12, -22, 24, 44);
      g.fillStyle = col;
      g.globalAlpha = 0.35 + 0.65 * load;
      g.fillRect(-10, -20, 20, 40);
      g.globalAlpha = 1;
      g.restore();
      const bx = x + (w.side < 0 ? -28 : 21);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(bx, y - 22, 7, 44);
      g.fillStyle = f > 0.9 || f < 0.05 ? '#ff6a4a' : '#8cc8ff';
      g.fillRect(bx, y + 22 - 44 * f, 7, 44 * f);
      const ty = i < 2 ? y - 46 : y + 36;
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.fillText(`${((w.FnAvg || 0) / 9.81).toFixed(0)} kg`, x, ty);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillText(`${Math.max(0, w.pen * 100).toFixed(1)} cm`, x, ty + 14);
    }
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(`axle twist  F ${(v.axles[0].phi * 57.3).toFixed(1)}°  R ${(v.axles[1].phi * 57.3).toFixed(1)}°`, 120, 121);
  }

  telemetryText(v, extra) {
    const d = v.drivetrain;
    const f = (x, n = 2) => (x >= 0 ? ' ' : '') + x.toFixed(n);
    let s = '';
    s += `rpm ${d.rpm.toFixed(0)}  thr ${d.thr.toFixed(2)}  Tcomb ${d.Tcomb.toFixed(0)}Nm  load ${d.load.toFixed(2)}  clutch ${d.clutchPedal.toFixed(2)} slip ${d.clutchSlip.toFixed(1)}  lockup ${d.lockup.toFixed(2)}\n`;
    s += `ratio ${d.currentRatio().toFixed(2)}  prop F ${d.propTorque[0].toFixed(0)} R ${d.propTorque[1].toFixed(0)} Nm  speed ${(v.speed * 3.6).toFixed(1)} km/h\n`;
    s += `wheel  ω(rad/s)  Fn(N)   Fx     Fy    slip  pen(cm)  surf\n`;
    v.wheels.forEach((w, i) => {
      s += `${['FL', 'FR', 'RL', 'RR'][i]}   ${f(d.w[2 + i], 1).padStart(7)} ${w.FnAvg.toFixed(0).padStart(6)} ${w.Fx.toFixed(0).padStart(6)} ${w.Fy.toFixed(0).padStart(6)}  ${(w.slipNorm || 0).toFixed(2)}  ${(w.pen * 100).toFixed(1).padStart(5)}  ${w.surf.name}\n`;
    });
    v.axles.forEach((a, i) => { s += `axle ${i ? 'R' : 'F'} c ${a.c.toFixed(3)}  φ ${(a.phi * 57.3).toFixed(1)}°  springs ${a.S[0].toFixed(0)} / ${a.S[1].toFixed(0)} N\n`; });
    if (extra) s += extra;
    return s;
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
