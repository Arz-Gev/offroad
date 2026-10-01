import { KEYS_HELP } from './input.js';

// DOM / canvas HUD.

export class HUD {
  constructor() {
    const root = document.getElementById('hud');
    root.innerHTML = `
      <div id="msg"></div>
      <div id="camlabel"></div>
      <div id="help"><div class="title">Controls</div>${KEYS_HELP.map(([k, d]) => `<div class="row"><span class="k">${k}</span><span>${d}</span></div>`).join('')}</div>
      <div id="wheels"><canvas id="wcv" width="300" height="300"></canvas></div>
      <div id="status">
        <div class="chips">
          <span id="c-mode" class="chip on">AUTO</span>
          <span id="c-range" class="chip">HIGH</span>
          <span id="c-cdl" class="chip">CDL</span>
          <span id="c-fl" class="chip">F-LOCK</span>
          <span id="c-rl" class="chip">R-LOCK</span>
          <span id="c-abs" class="chip">ABS</span>
          <span id="c-eng" class="chip">ENGINE</span>
          <span id="c-lights" class="chip">LIGHTS</span>
        </div>
        <div class="bars">
          <div class="bar"><label>THR</label><div><i id="b-thr"></i></div></div>
          <div class="bar"><label>BRK</label><div><i id="b-brk" class="red"></i></div></div>
          <div class="bar"><label>CLU</label><div><i id="b-clu" class="blue"></i></div></div>
        </div>
        <div class="line"><span id="t-psi"></span><span id="t-surf"></span></div>
      </div>
      <div id="dial"><canvas id="dcv" width="440" height="440"></canvas></div>
      <div id="telemetry"></div>
      <div id="fps"></div>`;
    this.el = id => document.getElementById(id);
    this.dctx = this.el('dcv').getContext('2d');
    this.wctx = this.el('wcv').getContext('2d');
    this.msgT = 0; this.camT = 0;
    this.helpVisible = true;
    this.telemetry = false;
    this.fpsAcc = 0; this.fpsN = 0;
  }

  toggleHelp() { this.helpVisible = !this.helpVisible; this.el('help').style.display = this.helpVisible ? '' : 'none'; }
  toggleTelemetry() { this.telemetry = !this.telemetry; this.el('telemetry').style.display = this.telemetry ? 'block' : 'none'; }

  message(text, t = 2.2) { const m = this.el('msg'); m.textContent = text; m.style.opacity = 1; this.msgT = t; }
  camLabel(text) { const m = this.el('camlabel'); m.textContent = text; m.style.opacity = 1; this.camT = 1.6; }

  chip(id, on, text, cls) {
    const e = this.el(id);
    if (text !== undefined && e.textContent !== text) e.textContent = text;
    e.className = 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : '');
  }

  update(dt, v, view, extra) {
    const d = v.drivetrain;
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.el('msg').style.opacity = 0; }
    if (this.camT > 0) { this.camT -= dt; if (this.camT <= 0) this.el('camlabel').style.opacity = 0; }
    if (d.message && d.message !== this._lastMsg) { this.message(d.message.text); this._lastMsg = d.message; }

    this.chip('c-mode', true, d.mode === 'auto' ? 'AUTO' : d.clutchAssist ? 'MANUAL·AC' : 'MANUAL');
    this.chip('c-range', d.range === 'low', d.range === 'low' ? 'LOW' : 'HIGH', d.range === 'low' ? 'amber' : '');
    this.chip('c-cdl', d.centerLock, 'CDL', 'amber');
    this.chip('c-fl', d.frontLock, 'F-LOCK', 'amber');
    this.chip('c-rl', d.rearLock, 'R-LOCK', 'amber');
    this.chip('c-abs', v.absActive > 0, 'ABS', 'amber');
    this.chip('c-eng', !d.running, d.running ? 'ENGINE' : d.cranking ? 'CRANKING' : 'ENGINE OFF', 'red');
    const hl = view.lights.head;
    this.chip('c-lights', hl > 0 || view.lights.bar, hl === 2 ? 'HIGH BEAM' : view.lights.bar ? 'LIGHT BAR' : 'LIGHTS', 'blue');
    this.el('b-thr').style.width = (v.ctl.throttle * 100).toFixed(0) + '%';
    this.el('b-brk').style.width = (Math.max(v.ctl.brake, v.ctl.handbrake * 0.999) * 100).toFixed(0) + '%';
    const clu = d.mode === 'manual' ? Math.min(1, Math.max(0, d.clutchPedal / 0.8)) : 0;
    this.el('b-clu').style.width = (clu * 100).toFixed(0) + '%';
    this.el('t-psi').textContent = `Tyres ${v.pressure.toFixed(0)} psi`;
    const surf = v.wheels.find(w => w.contact)?.surf?.name || 'Air';
    this.el('t-surf').textContent = surf;

    this.drawDial(v);
    this.drawWheels(v);

    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.el('fps').textContent = (this.fpsN / this.fpsAcc).toFixed(0) + ' fps'; this.fpsAcc = 0; this.fpsN = 0; }
    if (this.telemetry) this.drawTelemetry(v, extra);
  }

  drawDial(v) {
    const g = this.dctx, d = v.drivetrain, E = v.P.engine;
    const W = 440, cx = 220, cy = 220, r = 190;
    g.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.72, a1 = Math.PI * 2.28, maxR = 6000;
    const ang = rpm => a0 + (a1 - a0) * Math.min(rpm, maxR) / maxR;
    g.lineCap = 'round';
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    g.strokeStyle = 'rgba(230,60,45,0.55)';
    g.beginPath(); g.arc(cx, cy, r, ang(E.redlineRpm), a1); g.stroke();
    const rpm = Math.max(0, d.rpm);
    g.strokeStyle = rpm > E.redlineRpm ? '#ff4a36' : '#f2f2f2';
    g.beginPath(); g.arc(cx, cy, r, a0, ang(rpm)); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '600 20px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 0; k <= 6; k++) {
      const a = ang(k * 1000);
      g.fillText(String(k), cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34));
    }
    g.fillStyle = '#fff';
    g.font = '700 92px ui-monospace, Menlo, monospace';
    g.fillText(Math.abs(v.speed * 3.6).toFixed(0), cx, cy - 6);
    g.font = '600 20px ui-sans-serif, system-ui';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText('km/h', cx, cy + 46);
    g.font = '800 54px ui-sans-serif, system-ui';
    g.fillStyle = d.shift ? '#ffd166' : '#ffb347';
    g.fillText(d.gearLabel(), cx, cy + 104);
    g.font = '600 18px ui-monospace, Menlo, monospace';
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillText(`${rpm.toFixed(0)} rpm`, cx, cy - 74);
  }

  drawWheels(v) {
    const g = this.wctx;
    g.clearRect(0, 0, 300, 300);
    // top view, front at top. each wheel: suspension compression bar + tyre load + slip
    const pos = [[78, 70], [222, 70], [78, 220], [222, 220]];
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(78, 70); g.lineTo(222, 70); g.moveTo(78, 220); g.lineTo(222, 220); g.moveTo(150, 70); g.lineTo(150, 220); g.stroke();
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i], ax = w.axle, p = ax.p;
      const comp = ax.c + w.side * (p.springTrack / 2) * Math.sin(ax.phi);
      const f = Math.max(0, Math.min(1, comp / p.travel));
      const [x, y] = pos[i];
      // tyre rectangle coloured by slip
      const slip = Math.min(1, w.slipNorm || 0);
      const load = Math.min(1, (w.FnAvg || 0) / 12000);
      const col = !w.contact ? 'rgba(120,120,120,0.5)' : slip > 0.95 ? '#ff5544' : slip > 0.7 ? '#ffb347' : '#7bdc7b';
      g.save();
      g.translate(x, y);
      g.rotate(w.steer);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(-14, -30, 28, 60);
      g.fillStyle = col;
      g.globalAlpha = 0.35 + 0.65 * load;
      g.fillRect(-12, -28, 24, 56);
      g.globalAlpha = 1;
      g.restore();
      // suspension travel bar next to the tyre
      const bx = x + (w.side < 0 ? -34 : 26);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(bx, y - 30, 8, 60);
      g.fillStyle = f > 0.9 || f < 0.05 ? '#ff6a4a' : '#9ad0ff';
      g.fillRect(bx, y + 30 - 60 * f, 8, 60 * f);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.font = '600 13px ui-monospace, Menlo, monospace';
      g.textAlign = 'center';
      g.fillText(`${((w.FnAvg || 0) / 9.81).toFixed(0)}kg`, x, y + (i < 2 ? -40 : 46));
      g.fillText(`${Math.max(0, w.pen * 100).toFixed(1)}cm`, x, y + (i < 2 ? -24 : 62));
    }
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '600 12px ui-sans-serif, system-ui';
    g.textAlign = 'center';
    g.fillText('load · tyre squash · travel', 150, 292);
    g.fillText(`axle twist F ${(v.axles[0].phi * 57.3).toFixed(1)}°  R ${(v.axles[1].phi * 57.3).toFixed(1)}°`, 150, 146);
  }

  drawTelemetry(v, extra) {
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
    this.el('telemetry').textContent = s;
  }
}
